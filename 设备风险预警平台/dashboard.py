"""设备台账 + 全设备风险看板（独立网页，零第三方依赖，除建模库外）。

功能：
    1. 设备信息录入 / 修改（写 equipment 表，走 equipment_db 的接口）
    2. 全设备风险看板：模型概率 × 工况校准合成，四色分级（绿/黄/橙/红）
    3. 环境基准温度维护（sim_config.json）
    4. 单机工况校准抽屉（calibration.json，带留痕日志）
    5. 智能分析：本地规则引擎解读风险结果并给出可行方案（/api/analysis，
       主页面总览区与 /risk 详情页共用同一实现）
    6. 云知声 Agent 问答：服务端代理，密钥不出本机（/api/agent/*，SSE 流式）
    7. 报表导出：设备风险清单 / 治理措施 / 检修排期一键导出 CSV（/api/export），
       数字取自与看板同一次分析结果，可直接拿去交班和归档

页面（每页只干一件事，同一块内容不在两页重复出现）：
    /          风险概览：统计条 + 设备卡片（按风险从高到低，每页 12 台可翻页，
               每台卡片上是单台「AI 解读」入口）
    /risk      智能分析：共性归因 / 治理方案 / 检修排期 / 一台一台看（可翻页）/
               一键导出 CSV / AI 补充建议
    /devices   设备台账：完整表格（可搜索、按分级筛、每页 24 行可翻页）+ 增删改 + 巷道基准温度
    /model-center 模型训练中心：运行样本反馈、审核、HGBT 重训练与版本记录

启动：
    python dashboard.py                # 默认 8770 端口，自动打开浏览器
    python dashboard.py --port 8899    # 指定端口
    python dashboard.py --lan          # 额外打印局域网地址
    python dashboard.py --no-browser   # 不自动打开浏览器

风险口径（两条独立的路，最后相乘合成）：
    * 模型分 raw_risk  —— HistGradientBoosting 只看 9 个物理量：
      type / rated_v / rated_i / rated_p / env_temp / dev_temp /
      current / run_hours / since_repair_hours
    * 工况分 cond_risk —— 7 项加权（环境严酷度、湿度、粉尘、淋水、
      近三个月故障次数、检修频率不足、负载率超标）
    * 综合分 risk = 1 - (1 - raw_risk) × (1 - cond_risk)

  注：湿度、粉尘、故障次数、检修频率只参与工况分，不再同时喂给模型，
  避免同一因素在合成公式里被计算两次（详见 dataset_builder 的说明）。
"""

import argparse
import base64
import csv
import io
import ipaddress
import json
import math
import os
import re
import shutil
import socket
import sqlite3
import sys
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import pandas as pd

import agent_gateway
import ai_analyze
import ai_model
import dataset_builder
import equipment_db
import model_learning


# --------------------------------------------------------------------------
# 路径：exe 运行时资源在 _MEIPASS，可写数据始终放在 exe / 脚本同级目录
# --------------------------------------------------------------------------
def _app_dir():
    """可写数据根目录：打包后是 exe 所在目录，源码运行是脚本所在目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _res_dir():
    """只读资源目录：onefile exe 解压在 _MEIPASS，源码运行同 _app_dir。"""
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", _app_dir())
    return _app_dir()


BASE_DIR = _app_dir()
RES_DIR = _res_dir()


def _ensure(rel_path):
    """首次运行时把打包进 exe 的资源释放到同级目录，已存在则不覆盖。"""
    target = os.path.join(BASE_DIR, rel_path)
    if os.path.exists(target):
        return target
    source = os.path.join(RES_DIR, rel_path)
    if os.path.exists(source) and os.path.abspath(source) != os.path.abspath(target):
        folder = os.path.dirname(target)
        if folder:
            os.makedirs(folder, exist_ok=True)
        shutil.copy2(source, target)
    return target


MODEL_PATH = _ensure("histgb_model.joblib")
CONFIG_PATH = _ensure("sim_config.json")
CALIB_PATH = os.path.join(BASE_DIR, "calibration.json")
_ensure(os.path.join("data", "equipment.db"))

# 台账库路径跟着程序走，避免和历史版本混用
equipment_db.DATA_DIR = os.path.join(BASE_DIR, "data")
equipment_db.DB_PATH = os.path.join(equipment_db.DATA_DIR, "equipment.db")
os.makedirs(equipment_db.DATA_DIR, exist_ok=True)
model_learning.init_db()


# --------------------------------------------------------------------------
# 工况校准：默认值、标签、权重、取值范围
# --------------------------------------------------------------------------
CALIB_DEFAULT = {
    "env_severity": 3,
    "humidity": 2,
    "dust": 2,
    "water_drip": 0,
    "plan_maintain": 2,
    "fault_count": 1,
    "load_rate": 80,
    # 三项手动覆盖：留空表示直接用实测遥测值
    "ov_env_temp": None,
    "ov_dev_temp": None,
    "ov_current": None,
}

CALIB_LABELS = {
    "env_severity": ("环境严酷度", "1 良好 ~ 5 恶劣"),
    "humidity": ("湿度等级", "1 干燥 / 2 一般 / 3 高湿"),
    "dust": ("粉尘等级", "1 低 / 2 中 / 3 高"),
    "water_drip": ("是否淋水", "0 否 / 1 是"),
    "plan_maintain": ("计划检修频率", "次/年"),
    "fault_count": ("近一年故障次数", "次"),
    "load_rate": ("实际负载率", "%"),
    "ov_env_temp": ("环境温度", "℃"),
    "ov_dev_temp": ("设备温度", "℃"),
    "ov_current": ("运行电流", "A"),
}

# (上界, 名称, key, 颜色)：prob < 上界 即命中该档
LEVELS = [
    (0.3, "正常", "green", "#2f9e5f"),
    (0.5, "关注", "yellow", "#e8b500"),
    (0.7, "预警", "orange", "#ef8b1f"),
    (1.01, "报警", "red", "#d63b2f"),
]

DEVICE_TYPES = ["照明综保", "水泵开关", "排水泵", "馈电开关", "移动变电站", "真空起动器", "其他"]
DEVICE_STATUS = ["在用", "备用", "检修", "停用"]


# --------------------------------------------------------------------------
# 安全加固：请求体上限、输入白名单、原子写、审计日志、Host 校验
# --------------------------------------------------------------------------
MAX_BODY_BYTES = 1_000_000        # 单次 POST 请求体上限 1 MB，防内存耗尽
CONN_TIMEOUT = 20                 # 单连接读写超时（秒），防慢连接（Slowloris）占死线程
LOG_MAX_BYTES = 5 * 1024 * 1024   # access.log 超过 5 MB 滚动一次
LOG_PATH = os.path.join(BASE_DIR, "access.log")

CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,31}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FIELD_LIMIT = {"code": 32, "name": 60, "location": 60, "maker": 60,
               "remark": 200, "tunnel": 40, "commission_date": 10}
FIELD_LABEL = {"code": "设备编号", "name": "设备名称", "location": "安装位置",
               "maker": "生产厂家", "remark": "备注", "tunnel": "巷道名称",
               "commission_date": "投运日期"}

_IO_LOCK = threading.Lock()
_LOG_LOCK = threading.Lock()
# 台账/配置/校准都是"读-改-写"三步，跨三步必须串行，否则并发时会丢写或撞主键。
# 用 RLock 是因为函数之间会嵌套调用（如 _delete_device 里再走 _save_calib）。
_STORE_LOCK = threading.RLock()

# 所有响应统一带上的安全头（CSP 里的 'unsafe-inline' 是单文件前端的历史包袱，
# 真正的 XSS 防线在 index.html 的 esc() 转义，这里只做纵深防御）
SECURITY_HEADERS = [
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "SAMEORIGIN"),
    ("Referrer-Policy", "same-origin"),
    ("Content-Security-Policy",
     "default-src 'self'; script-src 'self' 'unsafe-inline'; "
     "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
     "object-src 'none'; base-uri 'none'; frame-ancestors 'self'"),
]


def _clean_text(value, field):
    """字符串字段统一清洗：去首尾空白、限长、剔除控制字符。"""
    text = "" if value is None else str(value)
    text = text.strip()
    limit = FIELD_LIMIT[field]
    if len(text) > limit:
        raise ValueError("%s最长 %d 个字符" % (FIELD_LABEL[field], limit))
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in text):
        raise ValueError("%s不能包含控制字符" % FIELD_LABEL[field])
    return text


def _check_code(value):
    """设备编号格式白名单：字母数字开头，只允许 . _ -，杜绝注入载体。"""
    code = _clean_text(value, "code")
    if code and not CODE_RE.match(code):
        raise ValueError("设备编号只能由字母、数字、下划线、点、短横线组成，且以字母或数字开头")
    return code


def _check_date(value):
    """投运日期：先过正则再真历校验，2024-13-45 / 2024-02-30 这类要挡掉。"""
    text = _clean_text(value, "commission_date")
    if not text:
        return ""
    if not DATE_RE.match(text):
        raise ValueError("投运日期格式应为 YYYY-MM-DD")
    try:
        datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        raise ValueError("投运日期不是有效日历日期：%s" % text)
    return text


def _audit(message):
    """审计日志：访问留痕 + 写操作留痕；磁盘异常绝不影响主流程。"""
    try:
        with _LOG_LOCK:
            if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
                os.replace(LOG_PATH, LOG_PATH + ".1")
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))
    except OSError:
        return None


def _atomic_write_json(path, payload):
    """临时文件 + os.replace：并发保存不会把配置写成半截 JSON。"""
    tmp = "%s.%d.tmp" % (path, threading.get_ident())
    try:
        with _IO_LOCK:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _allowed_host_names():
    out = {"localhost"}
    try:
        hn = socket.gethostname().lower().rstrip(".")
        out.update({hn, hn.split(".")[0], hn + ".local"})
    except OSError:
        pass
    return out


def _host_ok(host_header):
    """挡 DNS 重绑定：Host 只接受 IP 字面量与本机主机名，不认外来域名。"""
    host = (host_header or "").strip().lower()
    if not host:
        return False
    if host.startswith("["):                       # IPv6 字面量，如 [::1]:8770
        host = host[1:].partition("]")[0]
        family = socket.AF_INET6
    else:
        if host.count(":") == 1:                   # 去掉端口
            host = host.split(":", 1)[0]
        family = socket.AF_INET
    if not host:
        return False
    try:
        ipaddress.ip_address(host)                 # IP 字面量一律放行（含局域网 IP）
        return True
    except ValueError:
        return host in _allowed_host_names()


DEFAULT_PORTS = {"http": "80", "https": "443"}


def _origin_key(value):
    """URL / Origin / Host → (host, port)，默认端口归一化；认不出来返回 None。"""
    text = (value or "").strip().lower()
    if "://" in text:
        scheme, text = text.split("://", 1)
        if scheme not in DEFAULT_PORTS:
            return None
        default = DEFAULT_PORTS[scheme]
    else:
        default, text = "http", text                 # Host 头没有协议，按本平台实际部署当 http
    text = text.split("/", 1)[0].split("?", 1)[0]
    if text.startswith("["):                         # IPv6 字面量 [::1]:8770
        host, _, tail = text[1:].partition("]")
        port = tail.partition(":")[2]
    elif text.count(":") == 1:
        host, port = text.split(":", 1)
    else:
        host, port = text, ""
    if not host:
        return None
    return host, (port or default)


def _origin_ok(origin, host_header):
    """写请求的来源校验（防跨站伪造）。

    本平台按约定绑 0.0.0.0 且不登录，局域网里任何一台机器都能直接打到这些写接口；
    同事开着看板的浏览器一旦访问了恶意网页，脚本就能用
        fetch("http://192.168.x.x:8770/api/device/delete",
              {method: "POST", body: '{"code":"PS-001"}',
               headers: {"Content-Type": "text/plain"}})
    把台账删掉 —— text/plain 属于「简单请求」，浏览器不会先发预检，挡不住。
    能挡住的只有 Origin：浏览器发任何非 GET 请求都必定带上它，所以口径是
    「带了就必须与 Host 同源；没带的是 curl / 命令行 / 测试脚本，放行」。
    """
    if not origin:
        return True
    want, got = _origin_key(host_header), _origin_key(origin)
    return want is not None and want == got



def _load_config():
    """读环境基准配置，文件缺失或损坏时返回空字典。"""
    if not os.path.exists(CONFIG_PATH):
        return {}
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save_config(cfg):
    if not isinstance(cfg, dict):
        raise ValueError("环境配置结构非法")
    _atomic_write_json(CONFIG_PATH, cfg)


def _load_calib():
    """读全量校准表 {设备编号: {字段: 值}}。"""
    if not os.path.exists(CALIB_PATH):
        return {}
    try:
        with open(CALIB_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save_calib(data):
    if not isinstance(data, dict):
        raise ValueError("校准数据结构非法")
    _atomic_write_json(CALIB_PATH, data)


def _calib_of(code, store=None):
    """取单台设备的校准参数，缺省项用默认值补齐。

    store 可传入已在锁内改好的字典，避免回读还没落盘的文件读到旧值。
    """
    merged = dict(CALIB_DEFAULT)
    stored = (store if store is not None else _load_calib()).get(code)
    if isinstance(stored, dict):
        merged.update(stored)
    return merged


def _clamp(value, low, high):
    return max(low, min(high, value))


def _condition_risk(cal):
    """工况风险：7 项加权求和，返回 (总分, 明细)。"""
    items = []

    def add(name, score, weight, note):
        score = _clamp(float(score), 0.0, 1.0)
        items.append({"name": name, "score": round(score, 3), "weight": weight,
                      "contribution": round(score * weight, 4), "note": note})

    add("环境严酷度", (int(cal["env_severity"]) - 1) / 4.0, 0.18,
        "%d/5" % int(cal["env_severity"]))
    add("湿度等级", (int(cal["humidity"]) - 1) / 2.0, 0.22,
        "%d/3" % int(cal["humidity"]))
    add("粉尘等级", (float(cal["dust"]) - 1) / 2.0, 0.16,
        "%d/3" % int(cal["dust"]))
    add("淋水", 1.0 if int(cal["water_drip"]) else 0.0, 0.06,
        "有" if int(cal["water_drip"]) else "无")
    add("近三个月故障次数", min(float(cal["fault_count"]) / 5.0, 1.0), 0.2,
        "%d 次" % int(cal["fault_count"]))
    per_month = float(cal["plan_maintain"]) / 3.0
    add("检修频率不足", 1.0 - min(per_month, 1.0), 0.12,
        "%.1f 次/月" % per_month)
    add("负载率超标", max((float(cal["load_rate"]) - 80.0) / 70.0, 0.0), 0.06,
        "%d%%" % int(cal["load_rate"]))

    total = sum(item["contribution"] for item in items)
    return round(_clamp(total, 0.0, 1.0), 4), items


def _combine(p_model, p_cond):
    """两路风险独立合成：任意一路为 0 时不抬高另一路。"""
    return _clamp(1.0 - (1.0 - p_model) * (1.0 - p_cond), 0.0, 1.0)


# --------------------------------------------------------------------------
# 数据读取与预测
# --------------------------------------------------------------------------
def _latest_telemetry():
    """取每台设备最新一条遥测，返回 {设备编号: 行字典}。"""
    path = equipment_db.DB_PATH
    if not os.path.exists(path):
        return {}
    uri = Path(path).resolve().as_uri() + "?mode=ro"   # 只读连接，页面刷新不影响写入
    result = {}
    try:
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        codes = [r[0] for r in conn.execute("SELECT DISTINCT code FROM run_simulation_log")]
        for code in codes:
            row = conn.execute(
                "SELECT * FROM run_simulation_log WHERE code=? ORDER BY sim_time DESC LIMIT 1",
                (code,)).fetchone()
            if row:
                result[code] = dict(row)
        conn.close()
    except sqlite3.Error:
        return {}
    return result


def _load_model():
    """模型缺失或版本不兼容时返回 None，看板自动退化为纯工况模式。"""
    if not os.path.exists(MODEL_PATH):
        return None
    try:
        return ai_model.load_model(model_learning.active_model_path(MODEL_PATH))
    except Exception:
        return None


def _level(prob):
    for bound, name, key, color in LEVELS:
        if prob < bound:
            return {"name": name, "key": key, "color": color}
    return {"name": "报警", "key": "red", "color": "#d63b2f"}


def _predict_all():
    """全设备预测：台账 × 最新遥测 × 工况校准 → 综合风险。返回 (列表, 模型可用)。"""
    devices = equipment_db.get_all_devices()
    latest = _latest_telemetry()
    model = _load_model()
    feature_cols = list(dataset_builder.FEATURE_COLS)

    out = []
    for dev in devices:
        item = {
            "code": dev["code"], "name": dev["name"], "type": dev["type"],
            "location": dev["location"] or "", "status": dev["status"],
            "rated_v": dev["rated_v"], "rated_i": dev["rated_i"], "rated_p": dev["rated_p"],
            "maker": dev["maker"] or "", "commission_date": dev["commission_date"] or "",
            "remark": dev["remark"] or "",
            "risk": None, "level": {"name": "无数据", "key": "gray", "color": "#8a97a8"},
            "telemetry": None, "error": None,
        }
        row = latest.get(dev["code"])
        if row:
            item["telemetry"] = {
                "sim_time": row.get("sim_time"), "env_temp": row.get("env_temp"),
                "dev_temp": row.get("dev_temp"), "current": row.get("current"),
                "humidity": row.get("humidity"), "dust": row.get("dust"),
                "run_hours": row.get("run_hours"),
                "since_repair_hours": row.get("since_repair_hours"),
                "fault_label": row.get("fault_label"),
            }

        cal = _calib_of(dev["code"])
        cond_risk, cond_items = _condition_risk(cal)
        item["calib"] = cal
        item["cond_risk"] = cond_risk
        item["cond_items"] = cond_items

        if row is None:                       # 没有遥测就没有物理量可推
            out.append(item)
            continue
        if model is None:                     # 没有模型就只按工况评级
            item["risk"] = cond_risk
            item["level"] = _level(cond_risk)
            out.append(item)
            continue

        def pick(field, ov_key):
            """优先用抽屉里手填的覆盖值，没填就用实测遥测。"""
            value = cal.get(ov_key)
            if value not in (None, ""):
                return float(value)
            return row.get(field)

        # 只送 9 个物理量给模型；湿度/粉尘等工况项已经在 cond_risk 里计过一次
        sample = {
            "type": dev["type"],
            "rated_v": dev["rated_v"], "rated_i": dev["rated_i"], "rated_p": dev["rated_p"],
            "env_temp": pick("env_temp", "ov_env_temp"),
            "dev_temp": pick("dev_temp", "ov_dev_temp"),
            "current": pick("current", "ov_current"),
            "run_hours": row.get("run_hours"),
            "since_repair_hours": row.get("since_repair_hours"),
        }
        manual = any(cal.get(k) not in (None, "")
                     for k in ("ov_env_temp", "ov_dev_temp", "ov_current"))
        item["source"] = "手动" if manual else "实测"
        try:
            input_df = pd.DataFrame([sample], columns=feature_cols)
            raw = float(ai_model.predict_risk(model, input_df))
            combined = _combine(raw, cond_risk)
            item["raw_risk"] = round(raw, 4)
            item["risk"] = round(combined, 4)
            try:
                model_learning.record_prediction(
                    dev["code"], row.get("sim_time"), sample, raw, model_learning.active_version())
            except Exception as snapshot_exc:
                _audit("MODEL SNAPSHOT ERROR code=%s error=%s" % (dev["code"], snapshot_exc))
            item["level"] = _level(combined)
        except Exception as exc:              # 单台异常不影响整张看板
            item["error"] = str(exc)[:120]
        out.append(item)

    out.sort(key=lambda x: (x["risk"] is None, -(x["risk"] or 0)))
    return out, model is not None


def _env_state():
    cfg = _load_config()
    return {
        "env_base_by_tunnel": cfg.get("env_base_by_tunnel", {}),
        "default_env_base": cfg.get("default_env_base", 23.0),
        "config_path": CONFIG_PATH,
        "config_exists": os.path.exists(CONFIG_PATH),
    }


def _state():
    """给前端的一次性快照：设备列表 + 分级统计 + 环境 + 元信息。"""
    devices, model_ready = _predict_all()
    counts = {"green": 0, "yellow": 0, "orange": 0, "red": 0, "gray": 0}
    for d in devices:
        counts[d["level"]["key"]] = counts.get(d["level"]["key"], 0) + 1
    return {
        "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
        "devices": devices,
        "counts": counts,
        "model_ready": model_ready,
        "model_path": model_learning.active_model_path(MODEL_PATH),
        "model_version": model_learning.active_version(),
        "env": _env_state(),
        "calib_path": CALIB_PATH,
        "types": DEVICE_TYPES,
        "statuses": DEVICE_STATUS,
    }


# --------------------------------------------------------------------------
# 智能分析与云知声 Agent 问答（全部只读，不改任何风险数值）
# --------------------------------------------------------------------------
AGENT_CFG = agent_gateway.load_config(BASE_DIR)
# 把工况分/合成函数交给分析引擎做"改了会降多少"的闭环重算，避免两处各写一套口径
ANALYSIS_HOOKS = {"condition_risk": _condition_risk, "combine": _combine}
AGENT_STREAM_TIMEOUT = 120      # 仅此路由放宽，其余仍是 CONN_TIMEOUT=20
MAX_QUESTION_CHARS = 2000
MAX_CONTEXT_CHARS = 6000
# 校验前先按这个上限截断，避免客户端塞几千条历史把 CPU 耗在逐条检查上；
# 真正进上下文的条数仍由 agent_config.json 的 max_history 决定。
MAX_HISTORY_ITEMS = 40


def _analysis(code=None):
    """code 为空 → 全局态势；否则 → 单台解读。找不到设备返回 None。"""
    state = _state()
    if not code:
        return ai_analyze.analyze_global(state, ANALYSIS_HOOKS)
    for device in state["devices"]:
        if device["code"] == code:
            result = ai_analyze.analyze_device(device, ANALYSIS_HOOKS, state=state)
            result["scope"] = "device"
            result["env"] = state.get("env", {})
            return result
    return None


# --------------------------------------------------------------------------
# 报表导出（/api/export）：CSV 数字直接取 analyze_global 的同一份结果，
# 导出的和看板上看到的必然一致，不用人再抄一遍。
# --------------------------------------------------------------------------
EXPORT_KINDS = {"devices": "设备风险清单", "actions": "治理措施清单", "plan": "检修排期表"}


def _csv_pct(value):
    return "" if value is None else "%.2f%%" % (float(value) * 100)


def _csv_cell(value):
    """Excel/WPS 会把以 = + - @ 开头的单元格当公式执行。台账里的名称、备注是人工填的，
       导出前给这几个开头的字段加一个前导单引号，按纯文本存，公式打不开。"""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text


def _export_rows(kind, g):
    ts = g.get("ts") or "—"
    if kind == "devices":
        head = ["设备编号", "名称", "型号", "巷道", "分级", "综合风险", "设备本身",
                "现场情况", "处理窗口", "检修到期", "主要问题", "分析时间"]
        body = [[b["code"], b["name"], b["type"], b["location"], b["level"],
                 _csv_pct(b["risk"]), _csv_pct(b["raw_risk"]), _csv_pct(b["cond_risk"]),
                 (b.get("plan") or {}).get("window", ""),
                 (b.get("plan") or {}).get("dates", ""), b["main_cause"], ts]
                for b in g["briefs"]]
    elif kind == "actions":
        head = ["优先级", "类别", "事项", "现状", "预期效果", "分析时间"]
        body = [[a["priority"], a["kind"], a["title"], a["detail"], a["expect"], ts]
                for a in g["actions"]]
    else:
        head = ["处理窗口", "台数", "设备编号", "依据", "期限", "其中已到期", "分析时间"]
        body = [[p["window"], p["count"], "、".join(p["codes"]), p["reason"],
                 p["dates"], p["overdue"], ts] for p in g["plan"]]
    return [head] + [[_csv_cell(cell) for cell in row] for row in body]


def _export_filenames(kind, ts):
    """一份 ASCII 兜底名 + 一份 UTF-8 中文名，老浏览器和新浏览器都能存对。"""
    digits = re.sub(r"\D", "", ts or "") or datetime.now().strftime("%Y%m%d%H%M%S")
    return "risk_%s_%s.csv" % (kind, digits), "%s_%s.csv" % (EXPORT_KINDS[kind], digits)


def _agent_context(payload):
    """按请求范围取分析文本，作为 system prompt 的数据底座。"""
    code = payload.get("code")
    if code:
        analysis = _analysis(_check_code(code))
        if analysis:
            base = ai_analyze.context_blob(analysis)
            device = next((d for d in _state().get("devices", []) if d.get("code") == code), {})
            terms = [str(code), str(device.get("name") or ""), str(device.get("location") or "")]
            logs = []
            for term in filter(None, terms):
                logs = equipment_db.search_work_records(keyword=term, limit=8)
                if logs:
                    break
            if logs:
                lines = ["【匹配到的工作维修日志（记录原文，不代表已确认原因）】"]
                lines.extend("%s | %s | %s | 结果：%s" % (
                    x.get("work_date") or "日期未知", x.get("equipment") or "设备未标注",
                    x.get("content") or "", x.get("result") or "未填写") for x in logs)
                base += "\n" + "\n".join(lines)
            return base[:MAX_CONTEXT_CHARS]
        return ""
    analysis = _analysis(None)
    if not analysis:
        return ""
    base = ai_analyze.context_blob(analysis)
    logs = equipment_db.search_work_records(limit=12)
    if logs:
        lines = ["【最近工作维修日志（记录原文，不代表已确认原因）】"]
        lines.extend("%s | %s | %s | 结果：%s" % (
            x.get("work_date") or "日期未知", x.get("equipment") or "设备未标注",
            x.get("content") or "", x.get("result") or "未填写") for x in logs)
        base += "\n" + "\n".join(lines)
    return base[:MAX_CONTEXT_CHARS]


def _clean_question(value):
    """问答输入清洗：允许换行和制表符（多行提问是正常的），其余控制字符拒绝。"""
    if value is not None and not isinstance(value, str):
        raise ValueError("问题必须是字符串")
    text = "" if value is None else value
    text = text.replace("\r\n", "\n").strip()
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in text):
        raise ValueError("问题不能包含控制字符")
    if len(text) > MAX_QUESTION_CHARS:
        raise ValueError("问题过长，单次最多 %d 字" % MAX_QUESTION_CHARS)
    return text


def _clean_history(value):
    """历史只接受 {role: user/assistant, content: 字符串}，单条限长。

    不做限长的话，客户端可以塞一条几万字的历史把上游上下文打满，
    既烧 token 也让回答失真，所以这里按和问题同等的口径卡住。
    """
    if value in (None, []):
        return []
    if not isinstance(value, list):
        raise ValueError("history 必须是数组")
    out = []
    for item in value[-MAX_HISTORY_ITEMS:]:
        if not isinstance(item, dict):
            raise ValueError("history 每一项必须是对象")
        role, content = item.get("role"), item.get("content")
        if role not in ("user", "assistant"):
            raise ValueError("history.role 仅支持 user / assistant")
        if not isinstance(content, str):
            raise ValueError("history.content 必须是字符串")
        content = content.strip()
        if len(content) > MAX_QUESTION_CHARS:
            raise ValueError("history 单条最长 %d 字" % MAX_QUESTION_CHARS)
        if content:
            out.append({"role": role, "content": content})
    return out


def _agent_messages(payload):
    question = _clean_question(payload.get("question"))
    history = _clean_history(payload.get("history"))
    mode = payload.get("mode") or "chat"
    if not isinstance(mode, str) or mode not in ("chat", "advice"):
        raise ValueError("mode 仅支持 chat / advice")
    if not question and mode != "advice":
        raise ValueError("问题不能为空")
    messages = agent_gateway.build_messages(
        question, history, _agent_context(payload), mode)
    return question, messages


# --------------------------------------------------------------------------
# 工作日志解析与确认入账（扩展原设备台账，不改变设备资产表结构）
# --------------------------------------------------------------------------
_WORK_SPLIT_RE = re.compile(r"(?m)(?=^\s*\d+\s*[、.．)）])")
_WORK_PLACE_RE = re.compile(r"(?:[一二三四五六七八九十]+盘区(?:泄水巷|回风巷|辅运巷|泵房)|\d{3,4}(?:回风|辅运|库房)|九联巷|水泵房|库房)")
_WORK_EQUIP_RE = re.compile(r"(?:\d+\s*#?\s*水泵|[一二三四五六七八九十]+号水泵|水泵|开关|馈电|接线盒|移变|电缆|逆止阀|排水管)")


def _parse_work_log(payload):
    if not isinstance(payload, dict):
        raise ValueError("请求体结构非法")
    raw = str(payload.get("text") or "").strip()
    if not raw:
        raise ValueError("请先粘贴或上传工作日志内容")
    if len(raw) > 900000:
        raise ValueError("工作日志内容过长")
    chunks = [x.strip() for x in _WORK_SPLIT_RE.split(raw) if x.strip()]
    # 有编号时忽略“西翼排水工作量:”这类标题前缀，避免生成空标题记录。
    numbered = [x for x in chunks if re.match(r"^\s*\d+\s*[、.．)）]", x)]
    if numbered:
        chunks = numbered
    elif not chunks:
        chunks = [raw]
    if len(chunks) > equipment_db.MAX_WORK_RECORDS:
        # 解析、确认、入库三处共用同一个条数闸。一次解析出上千条时，浏览器要渲染
        # 上千张可编辑表单，页签会先卡死，人也不可能逐条核对，所以在这里就让人分批粘贴。
        raise ValueError("识别到 %d 条，超过单次 %d 条上限，请分批粘贴"
                         % (len(chunks), equipment_db.MAX_WORK_RECORDS))
    out = []
    for chunk in chunks:
        # 去掉条目前的序号
        content = re.sub(r"^\s*\d+\s*[、.．)）]\s*", "", chunk).strip()
        if not content:
            continue
        people = re.findall(r"[（(]([^（）()]{2,80})[）)]", content)
        workers = "、".join(re.split(r"[，,、\s]+", people[-1].strip())) if people else ""
        clean_content = re.sub(r"[（(][^（）()]{2,80}[）)]", "", content).strip()
        places = _WORK_PLACE_RE.findall(clean_content)
        equipment = list(dict.fromkeys(_WORK_EQUIP_RE.findall(clean_content)))
        result_terms = [x for x in ("运行正常", "调试正常", "一切正常", "送电正常", "排水正常") if x in clean_content]
        out.append({
            "work_date": str(payload.get("work_date") or "").strip(),
            "location": "、".join(dict.fromkeys(places[:5])),
            "equipment": "、".join(equipment[:8]),
            "content": clean_content,
            "result": "；".join(result_terms),
            "workers": workers,
            "source_text": content,
        })
    if not out:
        raise ValueError("没有识别到有效工作事项，请检查日志格式")
    return {"ok": True, "records": out, "count": len(out)}


def _confirm_work_records(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        raise ValueError("待确认记录格式错误")
    if len(payload["records"]) > equipment_db.MAX_WORK_RECORDS:
        raise ValueError("单次最多确认 %d 条维护记录，请分批入库" % equipment_db.MAX_WORK_RECORDS)
    records = []
    for i, item in enumerate(payload["records"], 1):
        if not isinstance(item, dict):
            continue
        if not str(item.get("content") or "").strip():
            continue          # 界面上留空的草稿直接跳过，和原行为一致
        try:
            records.append(equipment_db.clean_work_record(item))
        except ValueError as exc:
            raise ValueError("第 %d 条维护记录：%s" % (i, exc))
    if not records:
        raise ValueError("请至少选择一条有效记录")
    with _STORE_LOCK:
        result = equipment_db.add_work_records(records)
    _audit("WORK_RECORDS CONFIRM added=%d refreshed=%d" % (result["added"], result["refreshed"]))
    return {"ok": True, **result, "count": result["added"] + result["refreshed"]}


def _work_record_id(payload):
    """记录编号：非数字要回 400，不能让 int() 的 TypeError 变成 500。"""
    try:
        return int(str(payload.get("id")).strip())
    except (TypeError, ValueError):
        raise ValueError("维护记录编号无效")


def _update_work_record(payload):
    if not isinstance(payload, dict):
        raise ValueError("维护记录格式错误")
    record_id = _work_record_id(payload)
    with _STORE_LOCK:
        ok = equipment_db.update_work_record(record_id, payload)
    if not ok:
        raise ValueError("维护记录不存在或已被删除")
    _audit("WORK_RECORD UPDATE id=%s" % record_id)
    return {"ok": True}


def _delete_work_record(payload):
    if not isinstance(payload, dict):
        raise ValueError("维护记录格式错误")
    record_id = _work_record_id(payload)
    with _STORE_LOCK:
        ok = equipment_db.delete_work_record(record_id)
    if not ok:
        raise ValueError("维护记录不存在或已被删除")
    _audit("WORK_RECORD DELETE id=%s" % record_id)
    return {"ok": True}


# --------------------------------------------------------------------------
# 写入接口
# --------------------------------------------------------------------------
def _device_form(payload):
    """台账校验与归一，单台保存和批量导入共用同一套规则。

    导入绝不能有自己的一套校验，否则 CSV 里可以填进表单挡得住的东西（比如
    额定电流 0、投运日期 2024-13-45、类型不在下拉选项里），进去之后看板就会
    按脏数据算风险。返回可直接写库的 dict。
    """
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")
    code = _clean_text(payload.get("code"), "code")
    name = _clean_text(payload.get("name"), "name")
    if not code or not name:
        raise ValueError("设备编号和名称不能为空")
    if not CODE_RE.match(code):
        raise ValueError("设备编号只能由字母、数字、下划线、点、短横线组成，且以字母或数字开头")
    if not payload.get("type"):
        raise ValueError("请选择设备类型")
    if payload["type"] not in DEVICE_TYPES:
        raise ValueError("设备类型不在可选范围内")
    status = payload.get("status") or "在用"
    if status not in DEVICE_STATUS:
        raise ValueError("运行状态不在可选范围内")

    def _number(field, label, maximum):
        raw = payload.get(field)
        if raw in (None, ""):
            return raw
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise ValueError("%s必须是数字" % label)
        if not math.isfinite(value) or value <= 0:
            raise ValueError("%s必须大于 0" % label)
        if value > maximum:
            raise ValueError("%s不能超过 %g" % (label, maximum))
        return value

    return {
        "code": code,
        "name": name,
        "type": payload["type"],
        "location": _clean_text(payload.get("location"), "location"),
        "rated_v": _number("rated_v", "额定电压", 100),
        "rated_i": _number("rated_i", "额定电流", 100000),
        "rated_p": _number("rated_p", "额定功率", 100000),
        "maker": _clean_text(payload.get("maker"), "maker"),
        "commission_date": _check_date(payload.get("commission_date")),
        "status": status,
        "remark": _clean_text(payload.get("remark"), "remark"),
    }


def _write_device(data):
    """按编号存在与否决定新增还是覆盖；查重与写入必须同锁。"""
    with _STORE_LOCK:
        try:
            existing = equipment_db.get_one_device(data["code"])
            if existing:
                equipment_db.update_device(data["code"], data)
                action = "update"
            else:
                equipment_db.add_device(data)
                action = "add"
        except sqlite3.IntegrityError:
            raise ValueError("设备编号已存在")
    return action


def _save_device(payload):
    """新增或修改台账（编号已存在即覆盖）。"""
    data = _device_form(payload)
    action = _write_device(data)
    _audit("DEVICE %s code=%s name=%s" % (action.upper(), data["code"], data["name"]))
    return {"ok": True, "action": action, "code": data["code"]}


# --------------------------------------------------------------------------
# 台账批量导入（CSV / Excel）
# --------------------------------------------------------------------------
IMPORT_MAX_ROWS = 500
IMPORT_ERROR_SHOWN = 40    # 失败明细最多回这些条，再多前端也铺不开，只报总数
IMPORT_MAX_CELL = 400      # 单个单元格超过这个长度基本是整段说明挤进一列，别写进台账
# .xlsx 解压后可以比文件本身大几百倍（实测 14 KB 的 zip 摊开 11 MB），所以格子总量
# 也要有个数：500 行 × 200 列的预算，正常台账只有十几列，怎么都碰不到。
IMPORT_MAX_XLSX_CELLS = 100_000


def _row_cap_error(count):
    """行数超上限的说法只留一处：CSV 与 Excel 报出来的必须一模一样。

    Excel 那条路是边读边判，报出来的数是「读到第几行发现超了」而不是文件总行数，
    20 万行的表会显示成 501，所以两边统一说「至少」，谁都不撒谎。
    """
    return ValueError("一次最多导 %d 行，这份至少 %d 行，请在 Excel 里拆成几份分次导"
                      % (IMPORT_MAX_ROWS, count))

# 模板 / 界面展示的表头（和「导出台账」用的是同一套字，导出去改完能原样导回来）
IMPORT_HEADER = {
    "code": "设备编号", "name": "设备名称", "type": "设备类型", "location": "安装位置",
    "rated_v": "额定电压(kV)", "rated_i": "额定电流(A)", "rated_p": "额定功率(kW)",
    "maker": "生产厂家", "commission_date": "投运日期", "status": "运行状态", "remark": "备注",
}
# 各矿自己攒的表头写法不一，靠这张表认；键一律是 _norm_header 归一之后的形式。
IMPORT_ALIASES = {
    "设备编号": "code", "编号": "code", "设备号": "code", "资产编号": "code",
    "设备名称": "name", "名称": "name", "设备名": "name", "资产名称": "name",
    "设备类型": "type", "类型": "type", "设备类别": "type", "类别": "type",
    "安装位置": "location", "位置": "location", "巷道": "location", "安装地点": "location",
    "额定电压": "rated_v", "额定电压kv": "rated_v", "电压": "rated_v",
    "额定电流": "rated_i", "额定电流a": "rated_i", "电流": "rated_i",
    "额定功率": "rated_p", "额定功率kw": "rated_p", "功率": "rated_p",
    "生产厂家": "maker", "厂家": "maker", "制造商": "maker", "生产商": "maker",
    "投运日期": "commission_date", "投运时间": "commission_date",
    "启用日期": "commission_date", "上线日期": "commission_date",
    "运行状态": "status", "状态": "status",
    "备注": "remark", "说明": "remark",
    "code": "code", "name": "name", "type": "type", "location": "location",
    "ratedv": "rated_v", "ratedi": "rated_i", "ratedp": "rated_p",
    "maker": "maker", "commissiondate": "commission_date", "status": "status",
    "remark": "remark",
}


def _norm_header(raw):
    """表头归一：去 BOM、去括号里的单位、去掉所有空白和常见分隔符、转小写。

    「额定电压(kV)」「额定电压 KV」「rated_V」必须落到同一个键上，否则现场任何一处
    表头写法不同，整列数据就静默丢了。
    """
    s = str(raw or "").replace("\ufeff", "").strip().lower()
    s = re.sub(r"[（(][^（）()]*[）)]", "", s)
    s = re.sub(r"[\s_\-/·、,，.。:：]+", "", s)
    return s


_DATE_LOOSE = re.compile(r"^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$")


def _import_value(field, raw):
    """按字段做最小限度的清洗，把 Excel 常见的写法收回成接口认的形式。"""
    v = str(raw or "").strip()
    if field == "commission_date":
        v = re.split(r"[ T]", v, maxsplit=1)[0]        # 2024-05-06 00:00:00 → 2024-05-06
        m = _DATE_LOOSE.match(v)              # 2024/5/6、2024年5月6日 → 2024-05-06
        if m:
            v = "%04d-%02d-%02d" % tuple(int(g) for g in m.groups())
        return v
    if field == "rated_p":
        v = re.sub(r"(?i)\s*kw\s*$", "", v)   # 「400kW」也是常见写法
    return v


def _read_device_csv(text, force_delim=None):
    """CSV 文本 → ([(表格行号, {字段名: 原文})], 分隔符, 表头里没认出的列).

    分隔符按表头行里出现次数最多的候选定，不用 csv.Sniffer：Sniffer 只看首行，
    表头里恰好只有一个逗号时会从正文挑分号当分隔符，整份解析结果跟着错位。
    force_delim 是给 Excel 那条路用的（_read_device_xlsx 把单元格摊成 Tab 文本再
    从这里进来），分隔符已经定死，嗅探和引号闭合这两道保险就不必再判一遍。
    """
    if text.startswith("\ufeff"):
        text = text[1:]
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()                    # 只去掉末尾换行产生的空串，中间空行留着按行号报
    if not any(ln.strip() for ln in lines):
        raise ValueError("文件里没有内容")
    head_idx = next(i for i, ln in enumerate(lines) if ln.strip())
    delim = force_delim
    if delim is None:
        head = lines[head_idx]
        delim = max((",", ";", "\t", "|"), key=head.count)
        if head.count(delim) == 0:
            raise ValueError("没认出分隔符：第一行得是表头，各列用逗号 / 分号 / Tab 分开")
        if not (head.count('"') % 2 == 0 and sum(ln.count('"') % 2 for ln in lines[head_idx:]) % 2 == 0):
            raise ValueError("有单元格的双引号没闭合，后面的行会被并到一起，请在 Excel 里检查后再导")

    rows = list(csv.reader(lines[head_idx:], delimiter=delim))
    fields, unknown = {}, []
    for i, cell in enumerate(rows[0]):
        text = str(cell or "").strip()
        key = IMPORT_ALIASES.get(_norm_header(cell))
        if key is None:
            if text and text not in unknown:
                unknown.append(text)
        elif key in fields.values():
            if text and text not in unknown:      # 同名列重复出现，后一列不覆盖前一列
                unknown.append(text + "（重复列）")
        else:
            fields[i] = key
    missing = [IMPORT_HEADER[k] for k in ("code", "name", "type") if k not in fields.values()]
    if missing:
        raise ValueError("表头里缺 %s 这几列。点「下载模板」照格式填，或把这些列改成上面的名字。"
                         % "、".join(missing))

    records = []
    for i, cells in enumerate(rows[1:], start=head_idx + 2):
        rec = {}
        for j, field in fields.items():
            if j >= len(cells):
                continue
            v = _import_value(field, cells[j])
            if len(v) > IMPORT_MAX_CELL:
                raise ValueError("第 %d 行的「%s」有 %d 个字，多半是整段说明挤进了一列；"
                                 "这种行请在 Excel 里分列后再导" % (i, IMPORT_HEADER[field], len(v)))
            rec[field] = v
        if any(rec.values()):                    # 空行、只有空格的行直接跳过不计数
            records.append((i, rec))
    return records, delim, unknown


def _read_device_xlsx(data):
    """Excel 2007+ 的 .xlsx 原文件 → 与 _read_device_csv 完全相同的三元组。

    这里只把单元格摊成 Tab 分隔文本，表头别名、必填列、超长单元格、行号这套校验
    全部走 _read_device_csv 那一份代码：同一张表存成 .xlsx 和存成 .csv 导进来必须
    得到一模一样的预检结果，两套解析逻辑各自演化迟早漂开。
    日期单元格 openpyxl 给的就是 datetime，str() 之后正好被 _import_value 按空格
    截成 YYYY-MM-DD，不必自己按 1900/1904 纪元换算 Excel 的序列号。
    """
    try:
        from openpyxl import load_workbook
    except ImportError:
        raise ValueError("服务器上没有 openpyxl，导不了 .xlsx：执行 .venv/bin/pip install openpyxl，"
                         "或在 Excel 里「另存为 CSV」再导")
    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:
        # 坏 zip / 设了打开密码 / 97-2003 的 .xls，openpyxl 抛的类型不一，统一收成一句照着做就能过的话
        raise ValueError("这个 Excel 文件打不开：%s。如果是 97-2003 的 .xls 或在 Excel 里设过打开密码，"
                         "请另存为 .xlsx（去掉密码）或 CSV 再导" % exc)
    try:
        buf = io.StringIO()
        writer = csv.writer(buf, delimiter="\t", lineterminator="\n")
        sheet, sheets = wb.worksheets[0], len(wb.sheetnames)
        # 一行一格、空行也写出去，文本的第 i 行就是 Excel 的第 i+1 行，
        # 报错报出来的行号才和班组自己那份表对得上。
        # 上限必须在读的过程中生效：read_only 是流式的，边读边判只看得到前几百行，
        # 摊平之后才判等于先把几十 MB 内存吃掉、把线程占住几秒，再告诉人家「太多了」。
        rows = cells = 0
        header_done = False
        for row in sheet.iter_rows(values_only=True):
            cells += len(row)
            if cells > IMPORT_MAX_XLSX_CELLS:
                raise ValueError("这份 Excel 摊开有 %d 个格子，超过导入上限 %d 个（台账通常只有十几列）。"
                                 "请确认导的是台账本身，不是带格式的大空表；"
                                 "若表里确实有这么多列，请删掉无关列另存一份再导"
                                 % (cells, IMPORT_MAX_XLSX_CELLS))
            filled = any(v is not None and str(v) != "" for v in row)
            if filled and not header_done:
                header_done = True            # 第一处有内容的行是表头，不算数据行
            elif filled:
                rows += 1
                if rows > IMPORT_MAX_ROWS:
                    raise _row_cap_error(rows)
            writer.writerow(["" if v is None else str(v) for v in row])
        title = sheet.title
    finally:
        wb.close()                                 # read_only 的 workbook 底下是个没关的 zip
    records, _, unknown = _read_device_csv(buf.getvalue(), "\t")
    # 只读第一张是明说的规矩（多张表的口径一旦各读一张，台账就分不清哪份是准的），
    # 但读的是哪张、这份一共几张得写在结果上：改了第三张表却导不进来的时候，
    # 班组靠这句提示才知道要把它挪到第一张。
    label = "Excel 工作表「%s」" % title
    if sheets > 1:
        label += "（这份共 %d 张表，只读第一张）" % sheets
    return records, label, unknown


def _write_import_batch(staged):
    """逐条落库；某条被数据库挡下时停下并说明已写入几条，不假装整批都成功。"""
    written, errors = [], []
    for action, data, line_no in staged:
        try:
            written.append((_write_device(data), data["code"], line_no))
        except (ValueError, sqlite3.Error) as exc:
            done = len(written)
            errors.append({"line": line_no, "code": data["code"] or "—",
                           "reason": "%s（前面 %d 条已写入，本条及之后没写）" % (exc, done)})
            break
    return written, errors


def _overview_counts():
    """导完顺带把风险概览的数字算好，前端不用再发一次 /api/state。

    复用 _predict_all()，和看板、智能分析完全同一套口径，避免导入自己另算一遍
    得出另一组数字。
    """
    devices, model_ready = _predict_all()
    counts = {"green": 0, "yellow": 0, "orange": 0, "red": 0, "gray": 0}
    for d in devices:
        key = d["level"]["key"]
        counts[key] = counts.get(key, 0) + 1
    scored = [d["risk"] for d in devices if d["risk"] is not None]
    return {
        "total": len(devices),
        "counts": counts,
        "model_ready": model_ready,
        "no_data": counts["gray"],
        "mean_risk": round(sum(scored) / len(scored), 4) if scored else None,
    }


def _import_devices(payload):
    """台账批量导入（CSV 文本 / .xlsx 原文件）。dry_run=True 只做预检不落库。

    预检这一步不能省：台账是唯一一份、导错了没法还原的资产，所以先把「新增几台 /
    覆盖几台 / 跳过几台 / 多少台会没有数据」摆出来，用户确认后才真写。
    """
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")
    mode = payload.get("mode") or "upsert"
    if mode not in ("upsert", "skip"):
        raise ValueError("编号冲突只能选「覆盖」或「跳过」")
    dry = bool(payload.get("dry_run"))

    b64 = payload.get("xlsx_b64")
    if b64 is not None:
        try:
            raw = base64.b64decode(b64, validate=True)
        except Exception:
            # 前端拼 base64 拼坏了（或请求体被中途截断）时，别把 binascii 的原文甩给班组
            raise ValueError("Excel 文件没读全，请重新选择文件后再导一次")
        records, delim, unknown = _read_device_xlsx(raw)
    else:
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("请先选择要导入的 CSV 文件")
        records, delim, unknown = _read_device_csv(text)
    if not records:
        raise ValueError("表头以下没有可导入的数据行")
    if len(records) > IMPORT_MAX_ROWS:
        raise _row_cap_error(len(records))

    known = {d["code"] for d in equipment_db.get_all_devices()}
    tele = set(_latest_telemetry())
    seen = {}
    staged, errors = [], []
    planned = {"add": 0, "update": 0}
    skipped = 0

    for line_no, rec in records:
        code = rec.get("code") or ""
        try:
            data = _device_form(rec)
        except ValueError as exc:
            errors.append({"line": line_no, "code": code or "—", "reason": str(exc)})
            continue
        if data["code"] in seen:
            errors.append({"line": line_no, "code": data["code"],
                           "reason": "这份文件里编号重复（第 %d 行已经出现过）" % seen[data["code"]]})
            continue
        seen[data["code"]] = line_no
        if data["code"] in known:
            if mode == "skip":
                skipped += 1
                continue
            action = "update"
        else:
            action = "add"
        staged.append((action, data, line_no))
        planned[action] += 1

    no_data = sum(1 for _, d, _ in staged if d["code"] not in tele)
    written, write_errors = ([], [])
    if not dry:
        written, write_errors = _write_import_batch(staged)
        counts_fix = {"add": 0, "update": 0}
        for act, _, _ in written:
            counts_fix[act] += 1
        planned = counts_fix
        _audit("IMPORT mode=%s added=%d updated=%d skipped=%d failed=%d total=%d"
               % (mode, planned["add"], planned["update"], skipped,
                  len(errors) + len(write_errors), len(records)))
    errors = errors + write_errors

    result = {
        "ok": True,
        "dry_run": dry,
        "mode": mode,
        "total": len(records),
        "added": planned["add"],
        "updated": planned["update"],
        "skipped": skipped,
        "failed": len(errors),
        "errors": errors[:IMPORT_ERROR_SHOWN],
        "errors_hidden": max(0, len(errors) - IMPORT_ERROR_SHOWN),
        "unknown": unknown[:20],
        "delimiter": {"\t": "Tab", "|": "竖线"}.get(delim, delim),
        "no_data": no_data,
        "max_rows": IMPORT_MAX_ROWS,
    }
    if not dry:
        result["overview"] = _overview_counts()
    return result


def _import_template_rows():
    """导入模板：表头 + 两行示例，示例里的类型/状态都取自系统当前可选项。"""
    def pick(name):
        return name if name in DEVICE_TYPES else DEVICE_TYPES[0]

    rows = [[IMPORT_HEADER[k] for k in IMPORT_HEADER]]
    rows.append(["PS-901", "示例·中央泵房1号排水泵", pick("排水泵"), "中央泵房",
                 "6", "400", "200", "示例电气股份有限公司", "2024-05-06",
                 DEVICE_STATUS[0], "示例行，导入前请删掉或改成真实设备"])
    rows.append(["FD-902", "示例·三采区配电点馈电开关", pick("馈电开关"), "三采区配电点",
                 "1.2", "300", "", "", "", DEVICE_STATUS[0], ""])
    return rows


def _delete_device(payload):
    """删台账，同时清掉它的遥测和校准。"""
    if not isinstance(payload, dict):
        raise ValueError("请求体结构非法")
    code = _check_code(payload.get("code"))
    if not code:
        raise ValueError("缺少设备编号")
    with _STORE_LOCK:
        if not equipment_db.get_one_device(code):
            raise ValueError("设备不存在：%s" % code)
        equipment_db.delete_device(code)
        try:
            conn = sqlite3.connect(equipment_db.DB_PATH)
            conn.execute("DELETE FROM run_simulation_log WHERE code=?", (code,))
            conn.commit()
            conn.close()
        except sqlite3.Error:
            pass
        calib = _load_calib()
        if code in calib:
            calib.pop(code)
            _save_calib(calib)
    _audit("DEVICE DELETE code=%s" % code)
    return {"ok": True, "code": code}


def _mutate_config(mutator):
    """在锁内完成"读-改-写"整段，避免并发保存互相覆盖。mutator 的返回值透传。"""
    with _STORE_LOCK:
        cfg = _load_config()
        result = mutator(cfg)
        _save_config(cfg)
        return result


def _mutate_calib(mutator):
    """校准文件的锁内"读-改-写"。"""
    with _STORE_LOCK:
        data = _load_calib()
        result = mutator(data)
        _save_calib(data)
        return result


def _save_env(payload):
    """设置某条巷道的环境基准温度。"""
    if not isinstance(payload, dict):
        raise ValueError("请求体结构非法")
    tunnel = _clean_text(payload.get("tunnel"), "tunnel")
    if not tunnel:
        raise ValueError("巷道名称不能为空")
    try:
        temp = float(payload.get("temp"))
    except (TypeError, ValueError):
        raise ValueError("温度必须是数字")
    if not math.isfinite(temp):
        raise ValueError("温度必须是数字")
    if not (-10 <= temp <= 60):
        raise ValueError("温度应在 -10 ~ 60 ℃ 之间")

    def put(cfg):
        cfg.setdefault("env_base_by_tunnel", {})[tunnel] = temp

    _mutate_config(put)
    _audit("ENV SET tunnel=%s temp=%.1f" % (tunnel, temp))
    return {"ok": True, "tunnel": tunnel, "temp": temp}


def _delete_env(payload):
    if not isinstance(payload, dict):
        raise ValueError("请求体结构非法")
    tunnel = _clean_text(payload.get("tunnel"), "tunnel")

    def drop(cfg):
        env = cfg.get("env_base_by_tunnel", {})
        if tunnel in env:
            env.pop(tunnel)
            return True
        return False

    if _mutate_config(drop):
        _audit("ENV DELETE tunnel=%s" % tunnel)
    return {"ok": True}


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------
def _read_static(rel_name):
    """前端页面与静态资源：脚本同目录优先，exe 运行时回落到解包目录。"""
    for base in (BASE_DIR, RES_DIR):
        path = os.path.join(base, rel_name)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return f.read()
    return None


# URL → (文件, Content-Type)。逐条枚举而不是拼接路径，从根上排除目录穿越。
PAGES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/risk": ("risk.html", "text/html; charset=utf-8"),
    "/risk.html": ("risk.html", "text/html; charset=utf-8"),
    "/devices": ("devices.html", "text/html; charset=utf-8"),
    "/devices.html": ("devices.html", "text/html; charset=utf-8"),
    "/model-center": ("model-center.html", "text/html; charset=utf-8"),
    "/model-center.html": ("model-center.html", "text/html; charset=utf-8"),
    "/report": ("report.html", "text/html; charset=utf-8"),
    "/report.html": ("report.html", "text/html; charset=utf-8"),
    "/assets/report.js": ("assets/report.js", "application/javascript; charset=utf-8"),
    "/assets/model-center.js": ("assets/model-center.js", "application/javascript; charset=utf-8"),
    "/assets/app.css": ("assets/app.css", "text/css; charset=utf-8"),
    "/assets/common.js": ("assets/common.js", "application/javascript; charset=utf-8"),
    "/assets/analysis.js": ("assets/analysis.js", "application/javascript; charset=utf-8"),
    "/assets/chat.js": ("assets/chat.js", "application/javascript; charset=utf-8"),
    "/assets/page-main.js": ("assets/page-main.js", "application/javascript; charset=utf-8"),
    "/assets/page-risk.js": ("assets/page-risk.js", "application/javascript; charset=utf-8"),
    "/assets/page-devices.js": ("assets/page-devices.js", "application/javascript; charset=utf-8"),
}

# 页面和脚本都在启动时读进内存，行为与原来的 INDEX_HTML 一致
STATIC_CACHE = {}
for _route, (_file, _ctype) in PAGES.items():
    STATIC_CACHE[_file] = _read_static(_file)


def _page_html(route):
    rel, _ctype = PAGES[route]
    text = STATIC_CACHE.get(rel)
    if text is None:
        return "<!DOCTYPE html><meta charset='utf-8'><title>缺少 %s</title>" % rel
    return text


class Handler(BaseHTTPRequestHandler):
    server_version = "DeviceDashboard/1.0"
    timeout = CONN_TIMEOUT          # 读写超时，慢连接不会长期占住线程

    def log_message(self, fmt, *args):
        """默认只打到 stderr，这里落盘成访问日志。"""
        _audit("ACCESS %s %s" % (self.address_string(), fmt % args))

    def end_headers(self):
        """所有响应统一补齐安全响应头。"""
        for key, value in SECURITY_HEADERS:
            self.send_header(key, value)
        super().end_headers()

    def _host_denied(self):
        if _host_ok(self.headers.get("Host")):
            return False
        _audit("DENY-HOST %s host=%s" % (self.address_string(), self.headers.get("Host")))
        self._send_json({"ok": False, "error": "Host 头不被允许"}, 403)
        return True

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_csv(self, rows, ascii_name, utf8_name):
        """带 BOM 的 UTF-8 CSV：Excel 直接双击打开中文不乱码，也不用走导入向导。"""
        buf = io.StringIO()
        csv.writer(buf, lineterminator="\r\n").writerows(rows)
        data = ("\ufeff" + buf.getvalue()).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition",
                         'attachment; filename="%s"; filename*=UTF-8\'\'%s'
                         % (ascii_name, quote(utf8_name)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _fail(self, exc):
        """非预期异常：详情只进访问日志，不回吐给客户端（避免路径/堆栈泄露）。"""
        _audit("ERROR %s %s\n%s" % (self.command, self.path, traceback.format_exc()))
        self._send_json({"ok": False, "error": "服务内部错误"}, 500)

    def _read_json(self):
        if self.headers.get("Transfer-Encoding"):
            # 只按 Content-Length 读体，chunked 的请求体读不到；不切断连接的话，
            # 剩下的分块字节会被当成下一条请求行 —— 那是请求走私的入口。
            self.close_connection = True
            raise ValueError("不支持分块传输（chunked）的请求体，请带 Content-Length")
        raw = (self.headers.get("Content-Length") or "0").strip()
        try:
            length = int(raw)
        except ValueError:
            raise ValueError("Content-Length 非法")
        if length < 0:
            raise ValueError("Content-Length 非法")
        if length > MAX_BODY_BYTES:
            raise ValueError("请求体过大，单次上限 1 MB")
        if not length:
            return {}
        try:
            data = self.rfile.read(length)
        except (socket.timeout, OSError):
            raise ValueError("请求体读取超时或不完整")
        if len(data) < length:
            raise ValueError("请求体读取超时或不完整")
        try:
            return json.loads(data.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            # 以前这里悄悄当成空请求体（{}）交给业务层，表单式 POST 于是变成
            # 「字段缺失」的 500 堆栈；协议层的问题就该在协议层回 400。
            raise ValueError("请求体不是合法的 JSON 对象")

    def _send_file(self, rel_name, content_type, cache="max-age=86400"):
        path = os.path.join(RES_DIR, rel_name)
        if not os.path.exists(path):
            path = os.path.join(BASE_DIR, rel_name)
        if not os.path.exists(path):
            self.send_error(404)
            return
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(data)

    def _send_html(self, route):
        data = _page_html(route).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self._host_denied():
            return
        parsed = urlparse(self.path)
        path = parsed.path
        if path in PAGES and PAGES[path][1].startswith("text/html"):
            self._send_html(path)
        elif path in PAGES:
            self._send_static(PAGES[path][0], PAGES[path][1])
        elif path == "/header.jpg":
            self._send_file("header.jpg", "image/jpeg")
        elif path == "/logo.png":
            self._send_file("logo.png", "image/png")
        elif path == "/favicon.ico":
            # 页面已声明 <link rel="icon" href="/logo.png">，但浏览器仍会兜底请求
            # /favicon.ico；直接复用 logo，免得 access.log 里一直留 404。
            self._send_file("logo.png", "image/png")
        elif path == "/api/state":
            try:
                self._send_json(_state())
            except Exception as exc:
                self._fail(exc)
        elif path == "/api/analysis":
            try:
                code = parse_qs(parsed.query).get("code", [""])[0]
                result = _analysis(_check_code(code) or None)
                if result is None:
                    self._send_json({"ok": False, "error": "设备不存在"}, 404)
                else:
                    self._send_json({"ok": True, "result": result})
            except ValueError as exc:
                self._send_json({"ok": False, "error": str(exc)}, 400)
            except Exception as exc:
                self._fail(exc)
        elif path == "/api/export":
            try:
                kind = parse_qs(parsed.query).get("type", [""])[0]
                if kind not in EXPORT_KINDS:
                    self._send_json({"ok": False, "error": "未知的导出类型"}, 400)
                else:
                    state = _state()
                    rows = _export_rows(kind, ai_analyze.analyze_global(state, ANALYSIS_HOOKS))
                    ascii_name, utf8_name = _export_filenames(kind, state.get("ts"))
                    self._send_csv(rows, ascii_name, utf8_name)
            except Exception as exc:
                self._fail(exc)
        elif path == "/api/device/template.csv":
            try:
                self._send_csv(_import_template_rows(),
                               "equipment_import_template.csv", "设备台账导入模板.csv")
            except Exception as exc:
                self._fail(exc)
        elif path == "/api/agent/status":
            self._send_json(agent_gateway.status(AGENT_CFG))
        elif path == "/api/model-center":
            try:
                # 进入训练中心时也刷新一次预测快照，确保最新遥测可供工作人员反馈。
                _predict_all()
                status = parse_qs(parsed.query).get("status", ["all"])[0]
                self._send_json({"ok": True, "summary": model_learning.summary(),
                                 "data": model_learning.list_samples(status=status, limit=500)})
            except Exception as exc:
                self._fail(exc)
        elif path == "/api/daily-report":
            try:
                import report_workflow
                state = _state()
                self._send_json({"ok": True, **report_workflow.daily_snapshot(state)})
            except Exception as exc:
                self._fail(exc)
        elif path == "/api/work-records":
            try:
                q = parse_qs(parsed.query)
                self._send_json({"ok": True, "records": equipment_db.search_work_records(
                    keyword=q.get("keyword", [""])[0], field=q.get("field", [""])[0],
                    value=q.get("value", [""])[0], limit=5000)})
            except Exception as exc:
                self._fail(exc)
        else:
            self.send_error(404)

    def _send_static(self, rel_name, content_type):
        """页面拆出去的 css/js：启动时已读进内存，路径来自 PAGES 白名单。"""
        text = STATIC_CACHE.get(rel_name)
        if text is None:
            self.send_error(404)
            return
        data = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _agent_sse(self, payload):
        """SSE 透传：只往浏览器发增量文本，密钥和上游响应原文都不出服务端。"""
        # 类属性 timeout 在 setup() 阶段已经写到 socket 上，这里必须直接改 socket，
        # 否则长回答会在 20 秒被自己掐断；只对这条连接生效，其余路由仍保持 20 秒。
        self.connection.settimeout(AGENT_STREAM_TIMEOUT)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def emit(event):
            chunk = "data: %s\n\n" % json.dumps(event, ensure_ascii=False)
            self.wfile.write(chunk.encode("utf-8"))
            self.wfile.flush()

        try:
            for event in agent_gateway.chat_stream(AGENT_CFG, payload):
                emit(event)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            _audit("AGENT STREAM 客户端断开 %s" % self.address_string())
        except Exception:
            _audit("AGENT STREAM ERROR\n%s" % traceback.format_exc())
            try:
                emit({"type": "error", "degraded": True, "error": "服务内部错误"})
            except OSError:
                pass

    def do_POST(self):
        if self._host_denied():
            return
        if not _origin_ok(self.headers.get("Origin"), self.headers.get("Host")):
            _audit("CSRF-BLOCK %s origin=%r" % (self.path, self.headers.get("Origin")))
            self._send_json({"ok": False, "error": "跨站请求已拒绝：请在本平台页面里操作"}, 403)
            return
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
            if path == "/api/agent/chat":
                question, messages = _agent_messages(payload)
                _audit("AGENT %s code=%s len=%d" % (
                    (payload.get("mode") or "chat").upper(),
                    payload.get("code") or "-", len(question)))
                self._agent_sse(messages)
                return
            if path == "/api/model-feedback":
                self._send_json(model_learning.save_feedback(payload))
            elif path == "/api/daily-report":
                import report_workflow
                self._send_json(report_workflow.save_report(payload))
            elif path == "/api/model-train":
                self._send_json(model_learning.train_candidate(MODEL_PATH))
            elif path == "/api/model-publish":
                self._send_json(model_learning.publish_candidate(payload))
            elif path == "/api/model-rollback":
                self._send_json(model_learning.rollback_model(payload))
            elif path == "/api/work-log/parse":
                self._send_json(_parse_work_log(payload))
            elif path == "/api/work-records/confirm":
                self._send_json(_confirm_work_records(payload))
            elif path == "/api/work-records/update":
                self._send_json(_update_work_record(payload))
            elif path == "/api/work-records/delete":
                self._send_json(_delete_work_record(payload))
            elif path == "/api/device":
                self._send_json(_save_device(payload))
            elif path == "/api/device/import":
                self._send_json(_import_devices(payload))
            elif path == "/api/device/delete":
                self._send_json(_delete_device(payload))
            elif path == "/api/env":
                self._send_json(_save_env(payload))
            elif path == "/api/env/delete":
                self._send_json(_delete_env(payload))
            elif path == "/api/env/default":
                self._send_json(_save_default_env(payload))
            elif path == "/api/calibration":
                self._send_json(_save_calibration(payload))
            elif path == "/api/calibration/reset":
                self._send_json(_reset_calibration(payload))
            else:
                self.send_error(404)
        except ValueError as exc:
            self._send_json({"ok": False, "error": str(exc)}, 400)
        except Exception as exc:
            self._fail(exc)


def _save_default_env(payload):
    """全局默认环境基准温度（巷道没单独配置时用它）。"""
    if not isinstance(payload, dict):
        raise ValueError("请求体结构非法")
    try:
        temp = float(payload.get("temp"))
    except (TypeError, ValueError):
        raise ValueError("温度必须是数字")
    if not math.isfinite(temp):
        raise ValueError("温度必须是数字")
    if not (-10 <= temp <= 60):
        raise ValueError("温度应在 -10 ~ 60 ℃ 之间")

    def put(cfg):
        cfg["default_env_base"] = temp

    _mutate_config(put)
    _audit("ENV DEFAULT temp=%.1f" % temp)
    return {"ok": True, "temp": temp}


CALIB_RANGE = {
    "env_severity": (1, 5),
    "humidity": (1, 3),
    "dust": (1, 3),
    "water_drip": (0, 1),
    "plan_maintain": (0, 24),
    "fault_count": (0, 50),
    "load_rate": (0, 150),
}

OVERRIDE_RANGE = {
    "ov_env_temp": (-10, 60),
    "ov_dev_temp": (0, 200),
    "ov_current": (0, 1000),
}


def _log_calibration(code, values, cond_risk):
    """把每次校准追加到 calibration_log，失败不影响主流程。"""
    try:
        conn = sqlite3.connect(equipment_db.DB_PATH)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS calibration_log(id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "code TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL, cond_risk REAL)")
        conn.execute(
            "INSERT INTO calibration_log(code, ts, payload, cond_risk) VALUES(?,?,?,?)",
            (code, time.strftime("%Y-%m-%d %H:%M:%S"),
             json.dumps(values, ensure_ascii=False), cond_risk))
        conn.commit()
        conn.close()
    except sqlite3.Error:
        return None


def _save_calibration(payload):
    """保存抽屉里的工况校准：逐项校验类型与量程，返回合成后的工况分明细。"""
    if not isinstance(payload, dict):
        raise ValueError("请求体结构非法")
    code = _check_code(payload.get("code"))
    if not code:
        raise ValueError("缺少设备编号")
    if not equipment_db.get_one_device(code):
        raise ValueError("设备不存在：%s" % code)

    values = {}
    for key, (low, high) in CALIB_RANGE.items():
        if key not in payload or payload[key] in (None, ""):
            continue
        try:
            number = float(payload[key])
        except (TypeError, ValueError):
            raise ValueError("%s 必须是数字" % key)
        if not (low <= number <= high):
            raise ValueError(f"{key} 应在 {low} ~ {high} 之间")
        values[key] = int(number) if key != "load_rate" else number

    for key, (low, high) in OVERRIDE_RANGE.items():
        if key not in payload:
            continue
        raw = payload[key]
        if raw in (None, ""):
            values[key] = None               # 显式清空 = 回到实测
            continue
        try:
            number = float(raw)
        except (TypeError, ValueError):
            raise ValueError("%s 必须是数字" % key)
        if not (low <= number <= high):
            raise ValueError(f"{key} 应在 {low} ~ {high} 之间")
        values[key] = number

    def apply(data):
        data.setdefault(code, {}).update(values)
        return _condition_risk(_calib_of(code, data))   # 用锁内改好的字典，不回落盘前的旧值

    cond_risk, items = _mutate_calib(apply)
    _log_calibration(code, values, cond_risk)
    return {"ok": True, "code": code, "cond_risk": cond_risk, "items": items}


def _reset_calibration(payload):
    """单台恢复默认工况（删掉 calibration.json 里这台设备的记录）。"""
    if not isinstance(payload, dict):
        raise ValueError("请求体结构非法")
    code = _check_code(payload.get("code"))

    def drop(data):
        data.pop(code, None)
        return _condition_risk(_calib_of(code, data))

    cond_risk, _ = _mutate_calib(drop)
    if code:
        _audit("CALIB RESET code=%s" % code)
    return {"ok": True, "code": code, "cond_risk": cond_risk}


class _Server(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True


def lan_ip():
    """探测本机局域网 IP（不真正发包，失败退回 127.0.0.1）。"""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def serve(port=8770):
    """端口被占用时自动向后试 10 个，返回 (server, 实际端口)。"""
    last_err = None
    for p in range(port, port + 10):
        try:
            return _Server(("0.0.0.0", p), Handler), p
        except OSError as exc:
            last_err = exc
    raise last_err


def main():
    ap = argparse.ArgumentParser(description="设备台账与风险看板")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--lan", action="store_true", help="启动后打印局域网地址，方便其他设备访问")
    args = ap.parse_args()

    equipment_db.init_db()
    server, port = serve(args.port)
    url = f"http://127.0.0.1:{port}/"
    print("=" * 56)
    print("  煤矿排水设备故障风险预警平台")
    print("  URL:", url)
    if args.lan:
        print("  局域网: http://%s:%d/  （其他设备用这个地址）" % (lan_ip(), port))
    else:
        print("  其他设备访问请加 --lan 参数")
    print("  按 Ctrl+C 停止")
    print("=" * 56, flush=True)
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
