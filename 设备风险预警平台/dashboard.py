"""设备台账 + 全设备风险看板（独立网页，零第三方依赖，除建模库外）。

功能：
    1. 设备信息录入 / 修改（写 equipment 表，走 equipment_db 的接口）
    2. 全设备风险看板：模型概率 × 工况校准合成，四色分级（绿/黄/橙/红）
    3. 环境基准温度维护（sim_config.json）
    4. 单机工况校准抽屉（calibration.json，带留痕日志）
    5. 智能分析：本地规则引擎解读风险结果并给出可行方案（/api/analysis，
       主页面总览区与 /risk 详情页共用同一实现）
    6. 云知声 Agent 问答：服务端代理，密钥不出本机（/api/agent/*，SSE 流式）

页面（每页只干一件事，同一块内容不在两页重复出现）：
    /          风险概览：统计条 + 设备卡片（按风险从高到低，每页 12 台可翻页，
               每台卡片上是单台「AI 解读」入口）
    /risk      智能分析：共性归因 / 治理方案 / 检修排期 / 一台一台看 / AI 补充建议
    /devices   设备台账：完整表格（可搜索、按分级筛、每页 24 行可翻页）+ 增删改 + 巷道基准温度

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
from urllib.parse import parse_qs, urlparse

import pandas as pd

import agent_gateway
import ai_analyze
import ai_model
import dataset_builder
import equipment_db


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
        return ai_model.load_model(MODEL_PATH)
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
        "model_path": MODEL_PATH,
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
            result = ai_analyze.analyze_device(device, ANALYSIS_HOOKS)
            result["scope"] = "device"
            result["env"] = state.get("env", {})
            return result
    return None


def _agent_context(payload):
    """按请求范围取分析文本，作为 system prompt 的数据底座。"""
    code = payload.get("code")
    if code:
        analysis = _analysis(_check_code(code))
        if analysis:
            return ai_analyze.context_blob(analysis)[:MAX_CONTEXT_CHARS]
        return ""
    analysis = _analysis(None)
    return ai_analyze.context_blob(analysis)[:MAX_CONTEXT_CHARS] if analysis else ""


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
# 写入接口
# --------------------------------------------------------------------------
def _save_device(payload):
    """新增或修改台账（编号已存在即覆盖）。"""
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

    date_text = _check_date(payload.get("commission_date"))

    data = {
        "code": code,
        "name": name,
        "type": payload["type"],
        "location": _clean_text(payload.get("location"), "location"),
        "rated_v": _number("rated_v", "额定电压", 100),
        "rated_i": _number("rated_i", "额定电流", 100000),
        "rated_p": _number("rated_p", "额定功率", 100000),
        "maker": _clean_text(payload.get("maker"), "maker"),
        "commission_date": date_text,
        "status": status,
        "remark": _clean_text(payload.get("remark"), "remark"),
    }
    with _STORE_LOCK:                      # 查重与写入必须同锁，否则并发同名会撞主键
        try:
            existing = equipment_db.get_one_device(code)
            if existing:
                equipment_db.update_device(code, data)
                action = "update"
            else:
                equipment_db.add_device(data)
                action = "add"
        except sqlite3.IntegrityError:
            raise ValueError("设备编号已存在")
    _audit("DEVICE %s code=%s name=%s" % (action.upper(), code, name))
    return {"ok": True, "action": action, "code": code}


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

    def _fail(self, exc):
        """非预期异常：详情只进访问日志，不回吐给客户端（避免路径/堆栈泄露）。"""
        _audit("ERROR %s %s\n%s" % (self.command, self.path, traceback.format_exc()))
        self._send_json({"ok": False, "error": "服务内部错误"}, 500)

    def _read_json(self):
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
            return {}

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
        elif path == "/api/agent/status":
            self._send_json(agent_gateway.status(AGENT_CFG))
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
            if path == "/api/device":
                self._send_json(_save_device(payload))
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
