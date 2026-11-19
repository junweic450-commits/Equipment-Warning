"""人工核实日报及可追溯处置记录。"""
from contextlib import contextmanager
from datetime import datetime

import equipment_db
import model_learning


_REPORT_DDL = """CREATE TABLE IF NOT EXISTS daily_risk_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_date TEXT NOT NULL, code TEXT NOT NULL, sim_time TEXT NOT NULL,
        status TEXT NOT NULL, cause TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '',
        raw_value TEXT NOT NULL DEFAULT '', corrected_value TEXT NOT NULL DEFAULT '',
        reviewer TEXT NOT NULL DEFAULT '', sample_id INTEGER, updated_at TEXT NOT NULL,
        UNIQUE(report_date, code, sim_time))"""


@contextmanager
def _connect():
    """连接口径用数据层那一份，日报这张表只在自己模块里补齐。"""
    with equipment_db.connect() as c:
        c.execute(_REPORT_DDL)
        yield c


def daily_snapshot(state):
    date = (state.get("ts") or datetime.now().strftime("%Y-%m-%d"))[:10]
    samples = model_learning.list_samples("all", 5000).get("samples", [])
    by_key = {(x["code"], x["sim_time"]): x for x in samples}
    with _connect() as c:
        rows = c.execute("SELECT * FROM daily_risk_reports WHERE report_date=?", (date,)).fetchall()
        saved = {r["code"]: dict(r) for r in rows}
        logs = equipment_db.search_work_records(keyword=None, limit=5000)
    items = []
    for d in state.get("devices", []):
        tel = d.get("telemetry") or {}
        key = (str(d.get("code", "")), str(tel.get("sim_time", "")))
        sample = by_key.get(key)
        code, name = str(d.get("code", "")), str(d.get("name", ""))
        related = [r for r in logs if code.lower() in str(r.get("equipment", "")).lower()
                   or name.lower() in str(r.get("equipment", "")).lower()
                   or (d.get("location") and str(d.get("location")).lower() in str(r.get("location", "")).lower())]
        items.append({"device": d, "sample_id": sample.get("id") if sample else None,
                      "report": saved.get(code), "work_logs": related[:8]})
    return {"date": date, "model_version": state.get("model_version"), "items": items}


def save_report(payload):
    payload = payload if isinstance(payload, dict) else {}
    code = str(payload.get("code") or "").strip()[:80]
    sim_time = str(payload.get("sim_time") or "").strip()[:40]
    date = str(payload.get("report_date") or datetime.now().strftime("%Y-%m-%d"))[:10]
    status = str(payload.get("status") or "pending")
    allowed = {"fault", "no_issue", "data_corrected", "pending"}
    if not code or not sim_time or status not in allowed:
        raise ValueError("设备、采样时间或核实结论无效")
    fields = {k: str(payload.get(k) or "").strip() for k in
              ("cause", "action", "raw_value", "corrected_value", "reviewer")}
    if any(len(v) > 1000 for v in fields.values()):
        raise ValueError("报告字段不能超过 1000 字")
    if not fields["reviewer"]:
        raise ValueError("请填写核查人员")
    if status == "fault" and (not fields["cause"] or not fields["action"]):
        raise ValueError("确认故障时，请填写故障原因和处理办法")
    if status == "no_issue" and not fields["action"]:
        raise ValueError("请填写检查结论或无故障依据")
    if status == "data_corrected" and (not fields["raw_value"] or not fields["corrected_value"]):
        raise ValueError("请同时填写原始值和核实值")
    sample_id = payload.get("sample_id")
    try:
        sample_id = int(sample_id) if sample_id not in (None, "") else None
    except (TypeError, ValueError):
        sample_id = None
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with _connect() as c:
        c.execute("""INSERT INTO daily_risk_reports
            (report_date,code,sim_time,status,cause,action,raw_value,corrected_value,reviewer,sample_id,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(report_date,code,sim_time) DO UPDATE SET
            status=excluded.status,cause=excluded.cause,action=excluded.action,
            raw_value=excluded.raw_value,corrected_value=excluded.corrected_value,
            reviewer=excluded.reviewer,sample_id=excluded.sample_id,updated_at=excluded.updated_at""",
            (date, code, sim_time, status, fields["cause"], fields["action"], fields["raw_value"],
             fields["corrected_value"], fields["reviewer"], sample_id, now))
    # Only human-confirmed outcomes become supervised labels. Corrected sensor values
    # are documented; the source telemetry remains unchanged and anomaly-only stays out of training.
    kind = {"fault": "fault", "no_issue": "normal", "data_corrected": "anomaly", "pending": "uncertain"}[status]
    feedback = None
    if sample_id is not None:
        feedback = model_learning.save_feedback({"id": sample_id, "feedback_kind": kind,
            "feedback_note": "；".join(x for x in (fields["cause"], fields["action"],
                ("数据修正：%s → %s" % (fields["raw_value"], fields["corrected_value"])) if status == "data_corrected" else "") if x),
            "reviewer": fields["reviewer"]})
    return {"ok": True, "feedback": feedback, "message": "报告已保存；确认故障/无故障结果已回流到人工反馈样本。"}
