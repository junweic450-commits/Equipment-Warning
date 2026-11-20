"""设备台账数据层。

只封装 SQLite 读写：add_device / get_all_devices / get_one_device /
update_device / delete_device / export_csv。
不含任何 input、菜单和 print，函数返回 dict 或 list。
"""
import csv
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "equipment.db")

# 设备类型与运行状态的可选项
TYPES = ["移动变电站", "水泵开关", "馈电开关", "照明综保", "排水泵", "真空起动器", "其他"]
STATUS = ["在用", "备用", "检修", "停用"]

# 故障类型的 8 个口径（2026-11-19 用户选定，以水泵主要失效模式为准）。
# 这张表同时是：录入下拉、导入归一目标、多分类模型的类别集合，改这里等于改标签体系，
# 已入库的旧值不会自动迁移，所以只能增不能悄悄改名。
FAULT_TYPES = ["汽蚀", "叶轮磨损", "轴承损伤", "电机过热", "绝缘下降",
               "密封泄漏", "断流堵塞", "电气开关故障"]
FAULT_SEVERITY = ["轻微", "中等", "严重"]
# 生命周期事件用来把「计划停机」从失效标签里摘出去：按计划更换不是故障失效，
# 混进 RUL 标签会把剩余寿命整体压低。
LIFECYCLE_KINDS = ["投运", "计划检修", "故障停机", "更换复位"]

# 现场表里的写法不一，先归一到上面 8 类。只收同义写法，不收"症状"：
# 「振动大」可能是汽蚀、不平衡或基础松动，归到任何一类都是替用户下结论。
FAULT_TYPE_ALIASES = {
    "汽蚀损坏": "汽蚀", "气蚀": "汽蚀", "空化": "汽蚀", "空蚀": "汽蚀",
    "叶轮腐蚀": "叶轮磨损", "叶轮损坏": "叶轮磨损", "叶片磨损": "叶轮磨损",
    "轴承磨损": "轴承损伤", "轴承损坏": "轴承损伤",
    "电机温度高": "电机过热", "电机超温": "电机过热", "绕组过热": "电机过热",
    "绝缘老化": "绝缘下降", "绝缘降低": "绝缘下降", "绝缘电阻低": "绝缘下降",
    "机封泄漏": "密封泄漏", "密封漏水": "密封泄漏", "机械密封损坏": "密封泄漏",
    "堵塞": "断流堵塞", "断流": "断流堵塞", "不出水": "断流堵塞", "管路堵塞": "断流堵塞",
    "开关故障": "电气开关故障", "启动器故障": "电气开关故障",
    "真空起动器故障": "电气开关故障", "馈电开关故障": "电气开关故障",
}
LIFECYCLE_KIND_ALIASES = {
    "检修": "计划检修", "计划性检修": "计划检修", "定期检修": "计划检修",
    "故障": "故障停机", "非计划停机": "故障停机",
    "更换": "更换复位", "换新": "更换复位", "投运日期": "投运",
}

# (字段名, 界面标签, 是否必填)
FIELDS = [
    ("code", "设备编号", True),
    ("name", "设备名称", True),
    ("type", "设备类型", True),
    ("location", "安装位置", False),
    ("rated_v", "额定电压(kV)", False),
    ("rated_i", "额定电流(A)", False),
    ("rated_p", "额定功率(kW)", False),
    ("maker", "生产厂家", False),
    ("commission_date", "投运日期(YYYY-MM-DD)", False),
    ("status", "运行状态", True),
    ("remark", "备注", False),
]
FIELD_LABELS = {k: label for k, label, _ in FIELDS}

SCHEMA = """
CREATE TABLE IF NOT EXISTS equipment(
    code            TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,
    location        TEXT,
    rated_v         REAL,
    rated_i         REAL,
    rated_p         REAL,
    maker           TEXT,
    commission_date TEXT,
    status          TEXT NOT NULL,
    remark          TEXT,
    created_at      TEXT,
    updated_at      TEXT
);
CREATE TABLE IF NOT EXISTS work_records(
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    work_date       TEXT,
    location        TEXT,
    equipment       TEXT,
    content         TEXT NOT NULL,
    result          TEXT,
    workers         TEXT,
    source_text     TEXT,
    created_at      TEXT NOT NULL,
    upload_at       TEXT,
    updated_at      TEXT,
    duplicate_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_work_records_date ON work_records(work_date);
CREATE INDEX IF NOT EXISTS idx_work_records_location ON work_records(location);
CREATE TABLE IF NOT EXISTS fault_events(
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL,
    fail_time       TEXT NOT NULL,
    fault_type      TEXT NOT NULL,
    severity        TEXT,
    action          TEXT,
    restore_time    TEXT,
    note            TEXT,
    source          TEXT NOT NULL DEFAULT 'manual',
    confidence      REAL,
    reviewer        TEXT,
    status          TEXT NOT NULL DEFAULT 'confirmed',
    created_at      TEXT NOT NULL,
    updated_at      TEXT,
    UNIQUE(code, fail_time)
);
CREATE INDEX IF NOT EXISTS idx_fault_events_code ON fault_events(code, fail_time);
CREATE INDEX IF NOT EXISTS idx_fault_events_status ON fault_events(status, fault_type);
CREATE TABLE IF NOT EXISTS device_lifecycle(
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL,
    event_time      TEXT NOT NULL,
    kind            TEXT NOT NULL,
    note            TEXT,
    source          TEXT NOT NULL DEFAULT 'manual',
    created_at      TEXT NOT NULL,
    UNIQUE(code, event_time, kind)
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_code ON device_lifecycle(code, event_time);
"""

_CSV_HEADER = ["设备编号", "设备名称", "设备类型", "安装位置", "额定电压(kV)", "额定电流(A)",
               "额定功率(kW)", "生产厂家", "投运日期", "运行状态", "备注", "创建时间", "最后修改"]


# 全站唯一的轻量连接入口：训练侧、报表侧、数据侧都从这里走。
@contextmanager
def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=30000")
    try:
        yield c
        c.commit()
    finally:
        c.close()


# 数据侧入口：在轻量连接之上补齐 WAL、表结构与历史版本的兼容列。
@contextmanager
def _conn():
    with connect() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
        # 兼容此前版本已经创建的维护记录表：仅补充新字段，不改设备资产表。
        cols = {r[1] for r in c.execute("PRAGMA table_info(work_records)").fetchall()}
        for name, definition in (("upload_at", "TEXT"), ("updated_at", "TEXT"),
                                 ("duplicate_count", "INTEGER NOT NULL DEFAULT 0")):
            if name not in cols:
                c.execute(f"ALTER TABLE work_records ADD COLUMN {name} {definition}")
        c.execute("UPDATE work_records SET upload_at=COALESCE(upload_at, created_at)")
        c.execute("UPDATE work_records SET updated_at=COALESCE(updated_at, created_at)")
        yield c


def stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


_TABLE_COLUMNS = None


def _table_columns():
    """equipment 表里真实存在的列名（取自表结构，不另抄一份，改了 schema 也不会漂开）。"""
    global _TABLE_COLUMNS
    if _TABLE_COLUMNS is None:
        with _conn() as c:
            _TABLE_COLUMNS = frozenset(r[1] for r in c.execute("PRAGMA table_info(equipment)"))
    return _TABLE_COLUMNS


def _clean(data):
    """空字符串统一转 None，数字字段转 float。

    键名一律对着表结构核一遍：add_device / update_device 是把键名拼进 SQL 的
    （f"INSERT INTO equipment({cols})"），值虽然都走了参数绑定，键名却没有第二道闸。
    现在传进来的键都是代码里写死的，但这道题不该靠每个调用方记住，数据层自己拒掉。
    """
    allowed = _table_columns()
    out = {}
    for k, v in data.items():
        if k not in allowed:
            raise ValueError("台账里没有「%s」这一列，可用的是：%s"
                             % (k, "、".join(sorted(allowed))))
        if isinstance(v, str):
            v = v.strip()
            if v == "":
                v = None
        if v is not None and k in ("rated_v", "rated_i", "rated_p"):
            v = float(v)
        out[k] = v
    return out


def init_db():
    """建表（幂等）。"""
    with _conn():
        pass


def add_device(data):
    """新增设备，返回设备编号；编号重复抛 ValueError。"""
    data = _clean(data)
    code = data.get("code")
    if not code:
        raise ValueError("设备编号不能为空")
    with _conn() as c:
        if c.execute("SELECT 1 FROM equipment WHERE code=?", (code,)).fetchone():
            raise ValueError("设备编号已存在")
        row = dict(data)
        row.setdefault("created_at", stamp())
        row["updated_at"] = row["created_at"]
        cols = ",".join(row.keys())
        marks = ",".join(f":{k}" for k in row.keys())
        c.execute(f"INSERT INTO equipment({cols}) VALUES({marks})", row)
    return code


def get_all_devices(keyword=None):
    """查询设备列表，keyword 匹配编号/名称/位置；返回 [dict]。"""
    sql = "SELECT * FROM equipment"
    args = []
    if keyword:
        sql += " WHERE code LIKE ? OR name LIKE ? OR location LIKE ?"
        args = ["%%%s%%" % keyword] * 3
    sql += " ORDER BY code"
    with _conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def get_one_device(code):
    """按编号查单台设备；不存在返回 None。"""
    with _conn() as c:
        r = c.execute("SELECT * FROM equipment WHERE code=?", (code,)).fetchone()
    return dict(r) if r else None


def update_device(code, data):
    """更新设备（不允许改编号），返回是否更新成功。"""
    data = _clean(data)
    data.pop("code", None)
    if not data:
        return False
    data["updated_at"] = stamp()
    sets = ",".join(f"{k}=:{k}" for k in data)
    with _conn() as c:
        cur = c.execute("UPDATE equipment SET %s WHERE code=:code" % sets,
                        dict(data, code=code))
    return cur.rowcount > 0


def delete_device(code):
    """删除设备，返回是否删除成功。"""
    with _conn() as c:
        cur = c.execute("DELETE FROM equipment WHERE code=?", (code,))
    return cur.rowcount > 0


def _norm_work_value(value):
    """重复判断时统一空白与常见标点，不做模糊匹配。"""
    import re
    value = str(value or "").strip().lower()
    return re.sub(r"[\s，,。；;、:：()（）\[\]【】]", "", value)


# 维护记录各字段的长度上限（字段名, 界面标签, 上限）。日志正文给到 5000 字，
# 其余按界面实际用量留出余量；上限集中在下面这一道闸里，入库和改写共用。
WORK_FIELDS = [
    ("work_date", "工作日期", 40),
    ("location", "工作地点", 100),
    ("equipment", "涉及设备", 200),
    ("content", "工作内容", 5000),
    ("result", "处理结果", 500),
    ("workers", "作业人员", 300),
    ("source_text", "原始日志", 5000),
]
MAX_WORK_RECORDS = 500


def clean_work_record(item):
    """维护记录唯一的长度与格式闸。

    和台账的 _clean 同一个道理：这条闸不该靠每个调用方自己记得卡一遍。
    之前只有「确认入库」那条路径限了长度，「编辑已有记录」直接绕过它，
    一条几万字甚至几 MB 的正文就能写进库里。
    """
    item = item if isinstance(item, dict) else {}
    out = {}
    for key, label, limit in WORK_FIELDS:
        value = str(item.get(key) or "").strip()
        if len(value) > limit:
            raise ValueError("%s不能超过 %d 个字符" % (label, limit))
        out[key] = value
    if not out["content"]:
        raise ValueError("工作内容不能为空")
    if out["work_date"]:
        try:
            datetime.strptime(out["work_date"], "%Y-%m-%d")
        except ValueError:
            raise ValueError("工作日期格式应为 YYYY-MM-DD")
    return out


def add_work_records(records):
    """确认后写入维护历史。完全重复的记录不新增，只刷新上传时间。"""
    if not isinstance(records, list):
        raise ValueError("维护记录格式错误")
    if len(records) > MAX_WORK_RECORDS:
        raise ValueError("单次最多写入 %d 条维护记录" % MAX_WORK_RECORDS)
    ids, added, refreshed = [], 0, 0
    now = stamp()
    keys = ("work_date", "location", "equipment", "content", "result", "workers")
    with _conn() as c:
        for item in records:
            values = clean_work_record(item)
            content = values["content"]
            # 先按日期检索候选，再在 Python 中做标准化精确比较，避免相似内容误判。
            candidates = c.execute(
                "SELECT * FROM work_records WHERE COALESCE(work_date,'')=?",
                (values["work_date"],)).fetchall()
            duplicate = None
            source_text = values["source_text"] or content
            for row in candidates:
                same_fields = all(_norm_work_value(row[k]) == _norm_work_value(values[k]) for k in keys)
                # 即使用户后来编辑过展示字段，重复上传原始日志时仍可用原文识别，且绝不覆盖人工修改。
                same_source = _norm_work_value(row["source_text"]) == _norm_work_value(source_text)
                if same_fields or (source_text and same_source):
                    duplicate = row
                    break
            if duplicate:
                c.execute("UPDATE work_records SET upload_at=?, duplicate_count=COALESCE(duplicate_count,0)+1 WHERE id=?",
                          (now, duplicate["id"]))
                ids.append(duplicate["id"]); refreshed += 1
                continue
            cur = c.execute(
                """INSERT INTO work_records
                   (work_date, location, equipment, content, result, workers, source_text, created_at, upload_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (values["work_date"] or None, values["location"] or None,
                 values["equipment"] or None, content, values["result"] or None,
                 values["workers"] or None, source_text, now, now, now))
            ids.append(cur.lastrowid); added += 1
    return {"ids": ids, "added": added, "refreshed": refreshed}


def search_work_records(keyword=None, field=None, value=None, limit=1000):
    """支持全字段关键词检索及指定字段检索。"""
    fields = {"work_date":"work_date", "location":"location", "equipment":"equipment",
              "content":"content", "result":"result", "workers":"workers"}
    clauses, args = [], []
    if keyword:
        like = f"%{keyword.strip()}%"
        clauses.append("(" + " OR ".join(f"COALESCE({k},'') LIKE ?" for k in fields.values()) + ")")
        args.extend([like] * len(fields))
    if value and field in fields:
        clauses.append(f"COALESCE({fields[field]},'') LIKE ?")
        args.append(f"%{value.strip()}%")
    sql = "SELECT * FROM work_records" + (" WHERE " + " AND ".join(clauses) if clauses else "")
    sql += " ORDER BY COALESCE(work_date,'') DESC, id DESC LIMIT ?"
    args.append(max(1, min(int(limit), 5000)))
    with _conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def update_work_record(record_id, data):
    """人工编辑已有维护记录。原始日志 source_text 不接受改写，它只用于重复识别。"""
    values = clean_work_record(data)
    values.pop("source_text", None)
    values["updated_at"] = stamp()
    sets = ",".join(f"{k}=?" for k in values)
    with _conn() as c:
        cur = c.execute(f"UPDATE work_records SET {sets} WHERE id=?",
                         list(values.values()) + [int(record_id)])
    return cur.rowcount > 0


def delete_work_record(record_id):
    with _conn() as c:
        cur = c.execute("DELETE FROM work_records WHERE id=?", (int(record_id),))
    return cur.rowcount > 0


# --------------------------------------------------------------------------
# 故障事件 / 设备生命周期
# 两张表刻意共用同一套字段闸：录入、批量导入、编辑走的是同一个 clean_event_record，
# 口径只有一份（和台账 _clean、维护记录 clean_work_record 是一个思路）。
# --------------------------------------------------------------------------
_EVENT_TIME_FMT = "%Y-%m-%d %H:%M:%S"
_EVENT_TIME_LOOSE = re.compile(
    r"^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?"
    r"(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$")

EVENT_TABLES = {
    "fault_events": {
        "label": "故障事件",
        "fields": [("code", "设备编号", True, 40),
                   ("fail_time", "失效时间", True, 40),
                   ("fault_type", "故障类型", True, 40),
                   ("severity", "严重程度", False, 20),
                   ("action", "处理措施", False, 500),
                   ("restore_time", "恢复时间", False, 40),
                   ("note", "备注", False, 500)],
        "time_fields": ("fail_time", "restore_time"),
        "enums": {"fault_type": (FAULT_TYPES, FAULT_TYPE_ALIASES),
                  "severity": (FAULT_SEVERITY, {})},
        "dup_keys": ("code", "fail_time"),
    },
    "device_lifecycle": {
        "label": "生命周期事件",
        "fields": [("code", "设备编号", True, 40),
                   ("event_time", "事件时间", True, 40),
                   ("kind", "事件类型", True, 40),
                   ("note", "备注", False, 500)],
        "time_fields": ("event_time",),
        "enums": {"kind": (LIFECYCLE_KINDS, LIFECYCLE_KIND_ALIASES)},
        "dup_keys": ("code", "event_time", "kind"),
    },
}


def _event_spec(table):
    spec = EVENT_TABLES.get(table)
    if spec is None:
        raise ValueError("未知的事件表：%s" % table)
    return spec


def _norm_event_time(raw, label):
    """把 Excel 常见的写法收回成 YYYY-MM-DD HH:MM:SS；只给日期时按当天 00:00:00 记。

    RUL 标签是按小时算的，日期精度会带进最多 24 小时的误差，所以模板里明确建议填到时刻，
    但不强制——现场很多台账本来就只记到日，卡死等于让整份表导不进来。
    """
    value = str(raw or "").strip()
    if not value:
        return None
    m = _EVENT_TIME_LOOSE.match(value)
    if not m:
        raise ValueError("%s格式应为 2026-08-01 或 2026-08-01 08:30，读到的是「%s」"
                         % (label, value[:40]))
    y, mo, d, hh, mm, ss = m.groups()
    try:
        dt = datetime(int(y), int(mo), int(d), int(hh or 0), int(mm or 0), int(ss or 0))
    except ValueError as exc:
        raise ValueError("%s不是一个真实存在的时刻：%s" % (label, value[:40])) from exc
    return dt.strftime(_EVENT_TIME_FMT)


def normalize_event_time(raw, label):
    """时刻解析的唯一入口：反馈闭环换算失效时刻也走这里，不再另写一份 strptime。"""
    return _norm_event_time(raw, label)


def normalize_enum(raw, allowed, aliases, label):
    """枚举归一的唯一口径：先换别名再判可选项，别名的写法只允许停在输入那一刻。"""
    value = str(raw or "").strip()
    if not value:
        return ""
    value = (aliases or {}).get(value, value)
    if value not in allowed:
        raise ValueError("%s「%s」不在可选项里，可选：%s"
                         % (label, value[:40], "、".join(allowed)))
    return value


def normalize_fault_type(raw):
    """反馈样本上的类型标签与事件表共用这份归一：库里只留标准名，下拉框才显示得出已存的值。"""
    return normalize_enum(raw, FAULT_TYPES, FAULT_TYPE_ALIASES, "故障类型")


def clean_event_record(table, item):
    """故障事件 / 生命周期事件的唯一一道字段闸：长度、必填、时间格式、枚举、先后关系。"""
    spec = _event_spec(table)
    item = item if isinstance(item, dict) else {}
    out = {}
    for key, label, required, limit in spec["fields"]:
        value = str(item.get(key) or "").strip()
        if len(value) > limit:
            raise ValueError("%s不能超过 %d 个字符" % (label, limit))
        if key in spec["time_fields"]:
            value = _norm_event_time(value, label) or ""
        allowed, aliases = spec["enums"].get(key, (None, None))
        if allowed is not None:
            value = normalize_enum(value, allowed, aliases, label)
        if required and not value:
            raise ValueError("%s不能为空" % label)
        out[key] = value or None
    if table == "fault_events" and out.get("fail_time") and out.get("restore_time"):
        if out["restore_time"] < out["fail_time"]:
            raise ValueError("恢复时间不能早于失效时间")
    return out


def add_event_records(table, records, source="manual", reviewer="", status=None,
                      confidence=None):
    """批量写入事件；(编号, 时间[, 类型]) 已存在时跳过不覆盖。

    已确认过的记录不跟着重复导入悄悄改写——和 work_records 同一个原则：
    人工确认过一次的东西，只有人工操作才能变。
    """
    spec = _event_spec(table)
    if not isinstance(records, list):
        raise ValueError("%s格式错误：应为记录列表" % spec["label"])
    if len(records) > MAX_WORK_RECORDS:
        raise ValueError("单次最多写入 %d 条%s" % (MAX_WORK_RECORDS, spec["label"]))
    if status is None:
        status = "confirmed"
    if status not in ("confirmed", "pending"):
        raise ValueError("状态只能是已确认或待确认")
    now = stamp()
    ids, added, skipped = [], 0, []
    with _conn() as c:
        known = {r[0] for r in c.execute("SELECT code FROM equipment")}
        cols = {r[1] for r in c.execute("PRAGMA table_info(%s)" % table)}
        for position, item in enumerate(records):
            values = clean_event_record(table, item)
            code = values["code"]
            if code not in known:
                raise ValueError("设备编号「%s」不在台账里，请先把它加进台账再录事件" % code)
            keys = {k: values[k] for k in spec["dup_keys"]}
            where = " AND ".join("%s=:%s" % (k, k) for k in keys)
            if c.execute("SELECT id FROM %s WHERE %s" % (table, where), keys).fetchone():
                skipped.append({"line": position + 1, "code": code,
                                "reason": "同一设备同一时间的这条%s已经存在，未覆盖" % spec["label"]})
                continue
            row = dict(values, source=source, created_at=now)
            if table == "fault_events":
                row.update(reviewer=(reviewer or "")[:80] or None,
                           status=status, confidence=confidence, updated_at=now)
            unknown = [k for k in row if k not in cols]
            if unknown:
                raise ValueError("%s里没有这些列：%s" % (spec["label"], "、".join(unknown)))
            names = ",".join(row.keys())
            marks = ",".join(":%s" % k for k in row)
            cur = c.execute("INSERT INTO %s(%s) VALUES(%s)" % (table, names, marks), row)
            ids.append(cur.lastrowid)
            added += 1
    return {"ids": ids, "added": added, "skipped": skipped}


def search_event_records(table, code=None, status=None, limit=500):
    """按设备/状态取最近的事件，时间倒序。"""
    spec = _event_spec(table)
    time_col = spec["time_fields"][0]
    clauses, args = [], []
    if code:
        clauses.append("code = ?")
        args.append(str(code).strip())
    if status and table == "fault_events":
        clauses.append("status = ?")
        args.append(str(status).strip())
    sql = "SELECT * FROM %s" % table
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY %s DESC, id DESC LIMIT ?" % time_col
    args.append(max(1, min(int(limit), 5000)))
    with _conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def all_event_records(table, status=None):
    """训练侧的全量读出口：不分页、不截断，按录入顺序返回。

    与 search_event_records 的分工——那边是给界面翻的（时间倒序 + 条数上限），
    这边是给模型数的：少读一条就可能把「还差几条」算错，所以刻意没有 LIMIT。
    表名走 EVENT_TABLES 白名单，调用方传错表名直接报错。
    """
    spec = _event_spec(table)
    clauses, args = [], []
    if status:
        if table != "fault_events":
            raise ValueError("%s没有审核状态，不能按状态筛" % spec["label"])
        clauses.append("status = ?")
        args.append(str(status).strip())
    sql = "SELECT * FROM %s" % table
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY id"
    with _conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def find_event_by_time(table, code, moment):
    """按 (编号, 时间) 取最近录入的一条，反馈闭环靠它认出「同一时刻已有谁」。"""
    time_col = _event_spec(table)["time_fields"][0]
    with _conn() as c:
        row = c.execute("SELECT * FROM %s WHERE code=? AND %s=? ORDER BY id DESC LIMIT 1"
                        % (table, time_col), (str(code).strip(), str(moment))).fetchone()
    return dict(row) if row else None


def update_event_record(table, record_id, item, reviewer=""):
    """人工修正一条已入库事件（只走同一套字段闸）。"""
    spec = _event_spec(table)
    values = clean_event_record(table, item)
    if table == "fault_events":
        values["status"] = "confirmed"
        values["updated_at"] = stamp()
        if reviewer:
            values["reviewer"] = reviewer[:80]
    sets = ",".join("%s=?" % k for k in values)
    with _conn() as c:
        cur = c.execute("UPDATE %s SET %s WHERE id=?" % (table, sets),
                        list(values.values()) + [int(record_id)])
        return cur.rowcount > 0


def delete_event_record(table, record_id):
    _event_spec(table)
    with _conn() as c:
        cur = c.execute("DELETE FROM %s WHERE id=?" % table, (int(record_id),))
    return cur.rowcount > 0


def event_counts(table):
    """样本量统计：模型能不能训、还差多少条，都从这几个数判。"""
    spec = _event_spec(table)
    with _conn() as c:
        total = c.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]
        by_type = []
        if table == "fault_events":
            by_type = [[r[0], r[1]] for r in c.execute(
                "SELECT fault_type, COUNT(*) FROM fault_events GROUP BY fault_type")]
            pending = c.execute(
                "SELECT COUNT(*) FROM fault_events WHERE status='pending'").fetchone()[0]
            confirmed = c.execute(
                "SELECT COUNT(*) FROM fault_events WHERE status='confirmed'").fetchone()[0]
        else:
            by_type = [[r[0], r[1]] for r in c.execute(
                "SELECT kind, COUNT(*) FROM device_lifecycle GROUP BY kind")]
            pending = 0
            # 生命周期事件没有复核状态，进了库就是既成事实，与 pending=0 是同一个口径
            confirmed = total
        codes = c.execute("SELECT COUNT(DISTINCT code) FROM %s" % table).fetchone()[0]
    return {"table": table, "label": spec["label"], "total": total, "devices": codes,
            "pending": pending, "confirmed": confirmed, "by_type": dict(by_type)}


def csv_cell(value):
    """Excel/WPS 会把以 = + - @ 开头的单元格当公式执行（CWE-1236），导出前加一个前导
       单引号按纯文本存。只对文本生效：数字原样写，否则 -6.0 会变成文本，Excel 里
       没法参与计算。台账导出与看板的风险清单共用这一份。
    """
    if value is None:
        return ""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@"):
        return "'" + value
    return value


def export_csv(path=None):
    """导出全部设备为 CSV（UTF-8 BOM，Excel 可直接打开），返回文件路径。"""
    rows = get_all_devices()
    if not path:
        name = "equipment_%s.csv" % datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(DATA_DIR, name)
    else:
        d = os.path.dirname(os.path.abspath(path))
        if d:
            os.makedirs(d, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(_CSV_HEADER)
        for r in rows:
            w.writerow([csv_cell(v) for v in (
                r["code"], r["name"], r["type"], r["location"],
                r["rated_v"], r["rated_i"], r["rated_p"],
                r["maker"], r["commission_date"],
                r["status"], r["remark"], r["created_at"], r["updated_at"],
            )])
    return path
