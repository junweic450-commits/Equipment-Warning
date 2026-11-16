"""设备台账数据层。

只封装 SQLite 读写：add_device / get_all_devices / get_one_device /
update_device / delete_device / export_csv。
不含任何 input、菜单和 print，函数返回 dict 或 list。
"""
import csv
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "equipment.db")

# 设备类型与运行状态的可选项
TYPES = ["移动变电站", "水泵开关", "馈电开关", "照明综保", "排水泵", "真空起动器", "其他"]
STATUS = ["在用", "备用", "检修", "停用"]

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
"""

_CSV_HEADER = ["设备编号", "设备名称", "设备类型", "安装位置", "额定电压(kV)", "额定电流(A)",
               "额定功率(kW)", "生产厂家", "投运日期", "运行状态", "备注", "创建时间", "最后修改"]


# 统一连接入口：自动建目录、开启 WAL、建表，退出时提交并关闭
@contextmanager
def _conn():
    os.makedirs(DATA_DIR, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute(SCHEMA)
    try:
        yield c
        c.commit()
    finally:
        c.close()


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _clean(data):
    """空字符串统一转 None，数字字段转 float。"""
    out = {}
    for k, v in data.items():
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
        row.setdefault("created_at", _now())
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
    data["updated_at"] = _now()
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
            w.writerow([
                r["code"], r["name"], r["type"], r["location"] or "",
                r["rated_v"] if r["rated_v"] is not None else "",
                r["rated_i"] if r["rated_i"] is not None else "",
                r["rated_p"] if r["rated_p"] is not None else "",
                r["maker"] or "", r["commission_date"] or "",
                r["status"], r["remark"] or "",
                r["created_at"] or "", r["updated_at"] or "",
            ])
    return path
