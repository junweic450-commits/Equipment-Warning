"""HGBT 人工反馈与持续重训练管理。

反馈先入池；只有已确认的正常/故障标签参与监督训练。
HGBT 不支持 partial_fit，因此采用历史数据 + 已审核反馈的批量重训练。
"""
import json
import os
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from contextlib import contextmanager

import pandas as pd
from sklearn.model_selection import train_test_split

import ai_model
import dataset_builder
import equipment_db

_LOCK = threading.RLock()
FEATURES = list(dataset_builder.FEATURE_COLS)


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@contextmanager
def _connect():
    os.makedirs(equipment_db.DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(equipment_db.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with _connect() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS model_feedback_samples(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL,
            sim_time TEXT NOT NULL,
            feature_json TEXT NOT NULL,
            predicted_probability REAL,
            model_version TEXT,
            feedback_label INTEGER,
            feedback_kind TEXT NOT NULL DEFAULT 'pending',
            feedback_note TEXT DEFAULT '',
            reviewer TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            reviewed_at TEXT,
            UNIQUE(code, sim_time)
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_status ON model_feedback_samples(status, feedback_label);
        CREATE TABLE IF NOT EXISTS model_training_runs(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version TEXT NOT NULL,
            status TEXT NOT NULL,
            model_path TEXT,
            dataset_size INTEGER,
            feedback_count INTEGER,
            metrics_json TEXT,
            message TEXT,
            created_at TEXT NOT NULL
        );
        """)
        # 兼容已经运行过旧版持续学习功能的数据库，自动补充审批留痕字段。
        columns = {r[1] for r in c.execute("PRAGMA table_info(model_training_runs)").fetchall()}
        if "approved_by" not in columns:
            c.execute("ALTER TABLE model_training_runs ADD COLUMN approved_by TEXT DEFAULT ''")
        if "approved_at" not in columns:
            c.execute("ALTER TABLE model_training_runs ADD COLUMN approved_at TEXT")


def active_model_path(default_path):
    pointer = Path(equipment_db.DATA_DIR).parent / "models" / "active_model.json"
    if pointer.exists():
        try:
            obj = json.loads(pointer.read_text(encoding="utf-8"))
            candidate = Path(obj.get("model_path", ""))
            if not candidate.is_absolute():
                candidate = pointer.parent.parent / candidate
            if candidate.exists():
                return str(candidate)
        except Exception:
            pass
    return default_path


def active_version():
    pointer = Path(equipment_db.DATA_DIR).parent / "models" / "active_model.json"
    try:
        return json.loads(pointer.read_text(encoding="utf-8")).get("version", "V1.0-基础模型")
    except Exception:
        return "V1.0-基础模型"


def record_prediction(code, sim_time, features, probability, model_version):
    """每个设备每个采样时间只留一份快照，便于之后人工标注。"""
    if not code or not sim_time or not isinstance(features, dict):
        return
    safe = {k: features.get(k) for k in FEATURES}
    with _connect() as c:
        c.execute("""INSERT OR IGNORE INTO model_feedback_samples
            (code,sim_time,feature_json,predicted_probability,model_version,status,created_at)
            VALUES(?,?,?,?,?,'pending',?)""",
            (str(code), str(sim_time), json.dumps(safe, ensure_ascii=False),
             float(probability) if probability is not None else None,
             str(model_version or "unknown"), _now()))


def list_samples(status="all", limit=500):
    with _connect() as c:
        if status in ("pending", "reviewed"):
            rows = c.execute("SELECT * FROM model_feedback_samples WHERE status=? ORDER BY id DESC LIMIT ?",
                             (status, int(limit))).fetchall()
        else:
            rows = c.execute("SELECT * FROM model_feedback_samples ORDER BY id DESC LIMIT ?",
                             (int(limit),)).fetchall()
        out=[]
        for r in rows:
            d=dict(r)
            try: d["features"] = json.loads(d.pop("feature_json"))
            except Exception: d["features"] = {}
            out.append(d)
        counts = {r[0]:r[1] for r in c.execute("SELECT status,COUNT(*) FROM model_feedback_samples GROUP BY status")}
        return {"samples":out,"counts":counts}


def save_feedback(payload):
    if not isinstance(payload, dict):
        raise ValueError("反馈内容格式错误")
    try: sample_id=int(payload.get("id"))
    except (TypeError,ValueError): raise ValueError("反馈样本编号无效")
    kind=str(payload.get("feedback_kind") or "").strip()
    allowed={"normal":0,"fault":1,"anomaly":None,"uncertain":None}
    if kind not in allowed:
        raise ValueError("请选择正常、确认故障、确认异常或暂不确定")
    note=str(payload.get("feedback_note") or "").strip()
    reviewer=str(payload.get("reviewer") or "").strip()
    if len(note)>1000 or len(reviewer)>80:
        raise ValueError("反馈说明或人员名称过长")
    label=allowed[kind]
    status="reviewed" if kind != "uncertain" else "pending"
    with _connect() as c:
        cur=c.execute("""UPDATE model_feedback_samples SET feedback_label=?,feedback_kind=?,
            feedback_note=?,reviewer=?,status=?,reviewed_at=? WHERE id=?""",
            (label,kind,note,reviewer,status,_now() if status=="reviewed" else None,sample_id))
        if not cur.rowcount:
            raise ValueError("反馈样本不存在")
    return {"ok":True,"status":status}


def _training_frame():
    base, feature_cols, target_col = dataset_builder.build_feature_dataset(include_metadata=True)
    base = base.copy()
    base["_code"] = base["_code"].astype(str)
    base["_sim_time"] = base["_sim_time"].astype(str)
    with _connect() as c:
        rows=c.execute("""SELECT code,sim_time,feature_json,feedback_label FROM model_feedback_samples
            WHERE status='reviewed' AND feedback_label IN (0,1)""").fetchall()
    # 反馈覆盖同一条原始遥测的旧标签；没有匹配到原始数据的快照则作为新样本追加。
    by_key={(str(r[0]),str(r[1])):int(r[3]) for r in rows}
    matched=set()
    for idx,row in base.iterrows():
        key=(row["_code"],row["_sim_time"])
        if key in by_key:
            base.at[idx,target_col]=by_key[key]
            matched.add(key)
    extra=[]
    for r in rows:
        key=(str(r[0]),str(r[1]))
        if key in matched: continue
        try: features=json.loads(r[2])
        except Exception: continue
        item={k:features.get(k) for k in feature_cols}
        item[target_col]=int(r[3])
        item["_sim_time"]=key[1]
        extra.append(item)
    if extra:
        base=pd.concat([base,pd.DataFrame(extra)],ignore_index=True)
    base=base.dropna(subset=[target_col])
    base[target_col]=base[target_col].astype(int)
    base=base[base[target_col].isin([0,1])]
    return base, len(rows), feature_cols, target_col


def train_candidate(default_model_path):
    """训练候选版本并评估；只有通过保护阈值才自动发布。"""
    with _LOCK:
        df, feedback_count, feature_cols, target_col = _training_frame()
        if len(df)<20 or df[target_col].nunique()<2:
            raise ValueError("有效训练数据不足：至少需要 20 条且同时包含正常和故障样本")
        counts=df[target_col].value_counts()
        if counts.min()<2:
            raise ValueError("正常和故障样本都至少需要 2 条，才能划分训练与测试数据")
        # 优先按时间切分：用较早数据训练、较新数据测试，降低相邻时序样本泄漏。
        ordered=df.sort_values("_sim_time") if "_sim_time" in df.columns else df
        if "_sim_time" in ordered.columns and ordered["_sim_time"].nunique() >= 5:
            cut=max(1,int(ordered["_sim_time"].nunique()*0.8))
            split_time=sorted(ordered["_sim_time"].dropna().astype(str).unique())[cut]
            train_part=ordered[ordered["_sim_time"].astype(str)<split_time]
            test_part=ordered[ordered["_sim_time"].astype(str)>=split_time]
            if train_part[target_col].nunique()==2 and test_part[target_col].nunique()==2:
                X_train,y_train=train_part[feature_cols],train_part[target_col]
                X_test,y_test=test_part[feature_cols],test_part[target_col]
            else:
                X_train,X_test,y_train,y_test=train_test_split(
                    df[feature_cols],df[target_col],test_size=0.2,random_state=42,stratify=df[target_col])
        else:
            X_train,X_test,y_train,y_test=train_test_split(
                df[feature_cols],df[target_col],test_size=0.2,random_state=42,stratify=df[target_col])
        baseline=None
        try:
            baseline=ai_model.load_model(active_model_path(default_model_path))
            baseline_metrics=ai_model.evaluate_model(baseline,X_test,y_test)
        except Exception:
            baseline_metrics=None
        candidate=ai_model.train_model(X_train,y_train,["type"],save_path="",class_weight="balanced")
        metrics=ai_model.evaluate_model(candidate,X_test,y_test)
        root=Path(equipment_db.DATA_DIR).parent
        model_dir=root/"models"; model_dir.mkdir(parents=True,exist_ok=True)
        with _connect() as c:
            previous=c.execute("SELECT COUNT(*) FROM model_training_runs").fetchone()[0]
        version="V1.%d" % (int(previous)+1)
        model_file=model_dir/(version.replace(".","_")+"_histgb.joblib")
        passed=True; reasons=[]
        if metrics["roc_auc"] is None:
            passed=False; reasons.append("测试集类别不足，无法计算 ROC-AUC")
        if baseline_metrics:
            if metrics["recall"] < baseline_metrics["recall"]-0.05:
                passed=False; reasons.append("故障召回率较当前模型下降超过 5 个百分点")
            if (baseline_metrics.get("roc_auc") is not None and metrics.get("roc_auc") is not None
                and metrics["roc_auc"] < baseline_metrics["roc_auc"]-0.02):
                passed=False; reasons.append("ROC-AUC 较当前模型下降超过 0.02")
        status="pending_approval" if passed else "candidate_rejected"
        message="评估通过，等待管理员审批发布" if passed else "；".join(reasons)
        # 评估通过后用全部已审核样本拟合候选模型，但不自动替换线上模型。
        deploy_model = candidate
        if passed:
            deploy_model = ai_model.train_model(
                df[feature_cols], df[target_col], ["type"], save_path="", class_weight="balanced")
        ai_model.joblib.dump(deploy_model,str(model_file))
        rel_path=str(model_file.relative_to(root))
        with _connect() as c:
            c.execute("INSERT INTO model_training_runs(version,status,model_path,dataset_size,feedback_count,metrics_json,message,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (version,status,rel_path,len(df),feedback_count,json.dumps(metrics,ensure_ascii=False),message,_now()))
        return {"ok":True,"version":version,"status":status,"published":False,
                "passed":passed,"message":message,"dataset_size":len(df),"feedback_count":feedback_count,
                "metrics":metrics,"baseline_metrics":baseline_metrics}


def _write_active_pointer(version, model_path):
    root = Path(equipment_db.DATA_DIR).parent
    pointer = root / "models" / "active_model.json"
    pointer.parent.mkdir(parents=True, exist_ok=True)
    target = Path(model_path)
    if not target.is_absolute():
        target = root / target
    if not target.exists():
        raise ValueError("模型文件不存在，无法发布或回滚")
    rel_path = str(target.relative_to(root)) if target.is_relative_to(root) else str(target)
    temp = pointer.with_suffix(".tmp")
    temp.write_text(json.dumps({"version": version, "model_path": rel_path,
                                "published_at": _now()}, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, pointer)


def publish_candidate(payload):
    """管理员批准一个通过自动评估的候选模型。"""
    version = str((payload or {}).get("version") or "").strip()
    approver = str((payload or {}).get("approver") or "管理员").strip()[:80]
    if not version:
        raise ValueError("缺少候选模型版本")
    with _LOCK, _connect() as c:
        row = c.execute("SELECT * FROM model_training_runs WHERE version=? ORDER BY id DESC LIMIT 1", (version,)).fetchone()
        if not row:
            raise ValueError("未找到该模型版本")
        if row["status"] != "pending_approval":
            raise ValueError("该版本不是待审批状态，不能发布")
        _write_active_pointer(version, row["model_path"])
        c.execute("UPDATE model_training_runs SET status='published', approved_by=?, approved_at=?, message=? WHERE id=?",
                  (approver or "管理员", _now(), "管理员审批通过，已正式发布", row["id"]))
    return {"ok": True, "version": version, "published": True, "message": "模型已发布，线上版本已切换"}


def rollback_model(payload):
    """管理员将线上模型回滚到指定的历史已发布版本。"""
    version = str((payload or {}).get("version") or "").strip()
    if not version:
        raise ValueError("请选择要回滚的历史版本")
    with _LOCK, _connect() as c:
        if version == "V1.0-基础模型":
            # 初始模型没有训练历史记录，作为系统内置回退版本保留。
            base_path = Path(equipment_db.DATA_DIR).parent / "histgb_model.joblib"
            if not base_path.exists():
                raise ValueError("基础模型文件不存在，无法回滚")
            _write_active_pointer(version, str(base_path))
        else:
            row = c.execute("SELECT * FROM model_training_runs WHERE version=? AND status='published' ORDER BY id DESC LIMIT 1", (version,)).fetchone()
            if not row:
                raise ValueError("只能回滚到历史上已正式发布的模型版本")
            _write_active_pointer(version, row["model_path"])
    return {"ok": True, "version": version, "message": "已回滚，当前线上模型为 " + version}


def training_history(limit=20):
    with _connect() as c:
        rows=c.execute("SELECT * FROM model_training_runs ORDER BY id DESC LIMIT ?",(int(limit),)).fetchall()
    out=[]
    for r in rows:
        d=dict(r)
        try:d["metrics"]=json.loads(d.pop("metrics_json") or "{}")
        except Exception:d["metrics"]={}
        out.append(d)
    return out


def summary():
    with _connect() as c:
        total=c.execute("SELECT COUNT(*) FROM model_feedback_samples").fetchone()[0]
        reviewed=c.execute("SELECT COUNT(*) FROM model_feedback_samples WHERE status='reviewed'").fetchone()[0]
        trainable=c.execute("SELECT COUNT(*) FROM model_feedback_samples WHERE status='reviewed' AND feedback_label IN (0,1)").fetchone()[0]
    with _connect() as c:
        pending_approvals = c.execute("SELECT COUNT(*) FROM model_training_runs WHERE status='pending_approval'").fetchone()[0]
    return {"active_version":active_version(),"total_samples":total,"reviewed_samples":reviewed,
            "trainable_samples":trainable,"pending_samples":total-reviewed,
            "pending_approvals":pending_approvals,"history":training_history()}
