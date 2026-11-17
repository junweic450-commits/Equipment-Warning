"""云知声 MaaS Agent 网关：OpenAI 兼容协议的服务端代理（只用月度套餐密钥）。

安全边界：
    * api_key 只在本进程内使用，绝不写进任何响应体、日志或前端代码。
    * 浏览器只能访问本机 /api/agent/*，由本模块转发到公网网关。
    * 任何上游失败（未配置 / 超时 / 非 2xx / DNS 不通）都返回结构化降级
      标记，不抛异常，让前端能明确显示"本地分析已生效，Agent 暂不可用"。

上游形态（实测 2026-11-15）：
    POST {base_url}/chat/completions
    Authorization: Bearer <api_key>
    body: {"model": "u2-flash", "messages": [...], "stream": true}
    u2 系列是推理模型，先出 reasoning_content 再出 content，所以不能给小
    max_tokens，否则正文会被截成 null。套餐密钥下 u2-flash 约 4s 出结论
    （现场够用，默认取它），裸 u2 未开通返回 404。换模型只改
    agent_config.json 里的 model 字段，不动代码。
"""

import json
import os
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG_NAME = "agent_config.json"

DEFAULTS = {
    "enabled": True,
    "base_url": "https://maas-api.unisound.com/v1",
    "api_key": "",
    "model": "u2-flash",
    "timeout": 60,
    "temperature": 0.3,
    "max_history": 12,
}

# 使用者是泵司机和检修工人，不是工程师。模型默认爱写长段落、加粗和表格，
# 现场看手机读不完，所以把篇幅、用词和格式都钉死在"一句话一条、照着做"。
SYSTEM_PROMPT = (
    "你是「煤矿排水设备故障风险预警平台」的现场助手，使用者是煤矿泵司机、"
    "检修工人和机电科值班员，不是算法工程师。\n"
    "回答规则：\n"
    "1. 先给结论，再给做法。最多 3 条，每条一句话，总共不超过 120 字。\n"
    "2. 用大白话：说「设备发烫」「环境潮湿」「检修太少」，"
    "不说「温升超限」「工况贡献占比」「模型独立贡献」。\n"
    "3. 每条都要能直接照着做，落到谁做、做什么、什么时候做，"
    "比如「今晚夜班把 2 号泵切到 1 号泵」。\n"
    "4. 风险数值、分级一律以下面给出的系统计算结果为准，不得改动或编造；"
    "结果里没有的数据直接说「当前数据不足」，不要猜。\n"
    "5. 工作维修日志只是历史记录，不等于本次故障已确认；引用时说明是日志记载，不能把推测写成故障结论。\n"
    "6. 不用 markdown 语法：不要星号、井号、表格和代码块，直接分行列条目。\n"
    "7. 涉及停机、带电作业、受限空间时，提醒按矿井机电安全规程执行。\n"
)


def load_config(base_dir):
    """读配置；文件缺失或损坏时退回默认值，保证服务能起来。"""
    cfg = dict(DEFAULTS)
    path = os.path.join(base_dir, CONFIG_NAME)
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                cfg.update({k: v for k, v in data.items() if k in DEFAULTS})
        except (OSError, json.JSONDecodeError):
            cfg["error"] = "配置文件无法解析，已使用默认值"
    cfg["config_path"] = path
    return cfg


def _endpoint(base_url):
    url = (base_url or "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("base_url 必须是 http/https 绝对地址")
    if not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("base_url 不合法")
    if parsed.path.endswith("/chat/completions"):
        return url
    return url + "/chat/completions"


# 最近一次"真实调用上游"的结果。配置就绪不等于能出答案——欠费、限流、模型
# 未开通这些只有真打一次才知道，状态灯如果只看配置就会骗现场人员。
HEALTH = {"last_ok": None, "last_error": "", "last_at": ""}
HEALTH_LOCK = threading.Lock()


def record_health(ok, error=""):
    with HEALTH_LOCK:
        HEALTH["last_ok"] = bool(ok)
        HEALTH["last_error"] = "" if ok else (error or "")[:300]
        HEALTH["last_at"] = time.strftime("%Y-%m-%d %H:%M:%S")


def health():
    with HEALTH_LOCK:
        return dict(HEALTH)


def status(cfg):
    """给前端看的健康状态，绝不回传密钥本身。"""
    key = (cfg.get("api_key") or "").strip()
    ready = bool(cfg.get("enabled")) and bool(key) and bool(cfg.get("base_url"))
    reason = ""
    if not cfg.get("enabled"):
        reason = "配置里 enabled=false，Agent 已关闭"
    elif not key:
        reason = "尚未配置 api_key（编辑 agent_config.json）"
    info = {
        "enabled": bool(cfg.get("enabled")),
        "ready": ready,
        "model": cfg.get("model"),
        "base_url": cfg.get("base_url"),
        "key_tail": ("…" + key[-4:]) if len(key) > 8 else "",
        "reason": reason,
    }
    info.update(health())
    # 从未调用过：前端显示"待首次调用"，不假装健康
    return info


def build_messages(question, history=None, context="", mode="chat"):
    """把系统数据、历史、当前问题拼成 OpenAI messages。"""
    system = SYSTEM_PROMPT
    if context:
        system += "\n\n【系统当前计算结果】\n" + context
    if mode == "advice":
        system += ("\n\n【本次任务】下面的分析结论由本地规则引擎生成，现场已经看过了。"
                   "只补充三件事，别重复已有结论：先干哪一件、要找谁配合（通风/排水/供电）、"
                   "暂时改不了的话怎么盯着。还是最多 3 条，每条一句话。")
    messages = [{"role": "system", "content": system}]
    kept = (history or [])[-int(DEFAULTS["max_history"]):]
    for item in kept:
        role = item.get("role")
        content = (item.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:4000]})
    messages.append({"role": "user", "content": (question or "").strip()[:4000]})
    return messages


def _request(cfg, body):
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(_endpoint(cfg.get("base_url")), data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + (cfg.get("api_key") or "").strip())
    req.add_header("Accept", "text/event-stream" if body.get("stream") else "application/json")
    ctx = ssl.create_default_context()
    return urllib.request.urlopen(req, timeout=float(cfg.get("timeout") or 60), context=ctx)


def _upstream_error(exc):
    """把 urllib 异常翻译成给用户看的中文，绝不泄露密钥。"""
    if isinstance(exc, urllib.error.HTTPError):
        detail = ""
        try:
            raw = exc.read(2048).decode("utf-8", "replace")
            data = json.loads(raw)
            detail = (data.get("error") or {}).get("message") or data.get("errorMsg") or raw[:200]
        except Exception:
            detail = ""
        hint = {401: "密钥无效或已失效", 403: "无权限，检查账号是否开通该模型",
                404: "接口地址或模型名不对", 429: "触发限流，稍后再试",
                500: "上游服务异常", 503: "上游繁忙"}.get(exc.code, "上游返回错误")
        return "HTTP %s：%s%s" % (exc.code, hint, ("（%s）" % detail) if detail else "")
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, socket.timeout):
            return "上游请求超时"
        return "无法连接网关：%s" % reason
    if isinstance(exc, socket.timeout):
        return "上游响应超时"
    return "网关调用失败：%s" % type(exc).__name__


def chat_stream(cfg, messages):
    """生成器：逐块产出事件字典，供 SSE 透传。

    事件类型：reasoning / content / done / error。error 一定带 degraded，
    前端据此把"Agent 不可用"和本地结论区分开显示。
    """
    info = status(cfg)
    if not info["ready"]:
        yield {"type": "error", "degraded": True, "error": info["reason"] or "Agent 未配置"}
        return
    body = {"model": cfg.get("model"), "messages": messages,
            "temperature": float(cfg.get("temperature") or 0.3), "stream": True}
    try:
        resp = _request(cfg, body)
    except Exception as exc:
        err = _upstream_error(exc)
        record_health(False, err)
        yield {"type": "error", "degraded": True, "error": err}
        return

    finished = False
    streamed = False
    got_content = False
    try:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line or not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if chunk == "[DONE]":
                finished = True
                break
            try:
                data = json.loads(chunk)
            except json.JSONDecodeError:
                continue
            delta = (data.get("choices") or [{}])[0].get("delta") or {}
            if delta.get("reasoning_content"):
                streamed = True
                yield {"type": "reasoning", "text": delta["reasoning_content"]}
            if delta.get("content"):
                if not got_content:
                    record_health(True)
                got_content = True
                yield {"type": "content", "text": delta["content"]}
            if (data.get("choices") or [{}])[0].get("finish_reason"):
                finished = True
    except Exception as exc:
        err = _upstream_error(exc)
        record_health(False, err)
        yield {"type": "error", "degraded": True, "error": err}
        return
    finally:
        try:
            resp.close()
        except Exception:
            pass

    # u2 系列是推理模型，偶尔会把一轮配额全花在 reasoning_content 上、正文为空。
    # 这时不能报"成功"——现场看到的是空白框。按降级处理，状态灯和这句话一起给出。
    if not got_content:
        err = ("只有思考过程、没有给出答案" if streamed else "上游没有返回任何内容")
        record_health(False, err)
        yield {"type": "error", "degraded": True, "error": err}
    yield {"type": "done", "clean": finished and got_content}
