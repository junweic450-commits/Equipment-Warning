"""HGBT 人工反馈与持续重训练管理。

反馈先入池；只有已确认的正常/故障标签参与监督训练。
HGBT 不支持 partial_fit，因此采用历史数据 + 已审核反馈的批量重训练。

判断为「确认故障」的那一次点击，顺手把两个新标签也收进同一道审核闸：
是哪种故障、这条记录之后实际还能跑多久。它们换算成一条已确认失效事件写进
fault_events —— 故障分类与剩余寿命的训练侧只认事件表，不再另开一套标签库。
"""
import json
import os
import threading
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
from sklearn.model_selection import train_test_split

import ai_model
import dataset_builder
import equipment_db
import model_runs

_LOCK = threading.RLock()
FEATURES = list(dataset_builder.FEATURE_COLS)


_connect = equipment_db.connect
_now = equipment_db.stamp


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
            fault_type TEXT,
            actual_rul_hours REAL,
            event_id INTEGER,
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
        # 类型标签与实际剩余小时是后加的三列。加列不改动任何已有行，老库里已审核过的
        # 正常/故障结论原样保留，只是多的那两个标签从这次之后才开始收。
        fb_cols = {r[1] for r in c.execute("PRAGMA table_info(model_feedback_samples)").fetchall()}
        for col, ddl in (("fault_type", "TEXT"), ("actual_rul_hours", "REAL"), ("event_id", "INTEGER")):
            if col not in fb_cols:
                c.execute("ALTER TABLE model_feedback_samples ADD COLUMN %s %s" % (col, ddl))


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


ACTUAL_HOURS_MAX = 24 * 180      # 半年以外的「还能跑多久」，现场不会据此安排检修


def _parse_actual_hours(raw):
    text = str(raw if raw is not None else "").strip()
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        raise ValueError("实际剩余小时要填数字，读到的是「%s」" % text[:20])
    if not 0 <= value <= ACTUAL_HOURS_MAX:
        raise ValueError("实际剩余小时应在 0～%d 小时之间" % ACTUAL_HOURS_MAX)
    return round(value, 1)


def _fail_time(sim_time, actual_hours):
    """快照时刻 + 人工给的实际剩余小时 = 真正的失效时刻；换算不了就明说，不悄悄退化成估算。"""
    base = equipment_db.normalize_event_time(sim_time, "这条快照的采样时间")
    if not base:
        raise ValueError("这条快照没有可用的采样时间，推算不出失效时间")
    dt = datetime.strptime(base, "%Y-%m-%d %H:%M:%S")
    if actual_hours:
        dt = dt + timedelta(hours=float(actual_hours))
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _find_event(code, fail_time):
    row = equipment_db.find_event_by_time("fault_events", code, fail_time)
    return None if not row else {"id": int(row["id"]), "source": row["source"]}


def _sync_fault_event(sample, fault_type, actual_hours, note, reviewer):
    """把「确认故障」的审核结论落成一条已确认失效事件：标签只进事件表，训练只认事件表。

    同一条样本反复改判只修正它自己那一条事件（靠 event_id 认），不会每次点击堆一条新的；
    撞上一条人工录入的失效事件时绝不覆盖——人工确认过的记录只有人工操作才能变。
    """
    item = {"code": sample["code"], "fail_time": _fail_time(sample["sim_time"], actual_hours),
            "fault_type": fault_type, "action": (note or "")[:500],
            "note": "由反馈样本 #%s 确认生成" % sample["id"]}
    clean = equipment_db.clean_event_record("fault_events", item)   # 先过一遍闸，不合格就别动审核
    linked = sample.get("event_id")
    if linked and equipment_db.update_event_record("fault_events", linked, clean, reviewer=reviewer):
        return {"id": int(linked), "action": "updated", "fault_type": clean["fault_type"],
                "fail_time": clean["fail_time"]}
    found = _find_event(clean["code"], clean["fail_time"])
    if found and found["source"] != "feedback":
        return {"id": found["id"], "action": "kept_manual", "fault_type": clean["fault_type"],
                "fail_time": clean["fail_time"]}
    if found:
        equipment_db.update_event_record("fault_events", found["id"], clean, reviewer=reviewer)
        return {"id": found["id"], "action": "updated", "fault_type": clean["fault_type"],
                "fail_time": clean["fail_time"]}
    res = equipment_db.add_event_records("fault_events", [clean], source="feedback",
                                         reviewer=reviewer, status="confirmed")
    if res["added"]:
        return {"id": int(res["ids"][0]), "action": "added", "fault_type": clean["fault_type"],
                "fail_time": clean["fail_time"]}
    again = _find_event(clean["code"], clean["fail_time"])
    return {"id": (again or {}).get("id"), "action": "kept_manual",
            "fault_type": clean["fault_type"], "fail_time": clean["fail_time"]}


def _feedback_message(kind, event, sample, fault_type):
    if kind != "fault":
        if sample.get("event_id") and kind in ("normal", "anomaly"):
            return ("反馈已保存；之前由这条样本生成的失效事件仍留在「故障事件」里，"
                    "人工确认过的记录只有人工删除才消失。")
        return "反馈已保存；符合训练条件的样本已进入训练数据池。"
    if not fault_type:
        return "已记下故障标签，但没选故障类型，所以没有生成失效事件——类型标签还差这一步。"
    if not event:
        return "反馈已保存。"
    done = {"added": "已同步生成 1 条已确认失效事件",
            "updated": "已同步修正对应的失效事件",
            "kept_manual": "同一时刻已有一条人工录入的失效事件，未覆盖（要改类型请到「故障事件」里改）"}[event["action"]]
    return "%s（%s · %s）；故障分类与剩余寿命都直接从事件表取标签。" % (
        done, event["fault_type"], event["fail_time"])


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
    fault_type=str(payload.get("fault_type") or "").strip()
    actual_hours=_parse_actual_hours(payload.get("actual_hours"))
    if kind != "fault" and (fault_type or actual_hours is not None):
        raise ValueError("只有判断为「确认设备故障」时才需要填故障类型与实际剩余小时")
    # 别名只允许停在输入那一刻：样本与事件表存同一份标准名，否则下拉框回显不出已存的值，
    # 审核人看到的就和他刚确认的不是一回事。
    fault_type = equipment_db.normalize_fault_type(fault_type)
    label=allowed[kind]
    status="reviewed" if kind != "uncertain" else "pending"
    with _LOCK, _connect() as c:
        row = c.execute("SELECT * FROM model_feedback_samples WHERE id=?", (sample_id,)).fetchone()
        if not row:
            raise ValueError("反馈样本不存在")
        sample = dict(row)
    event = None
    if kind == "fault" and fault_type:
        event = _sync_fault_event(sample, fault_type, actual_hours, note, reviewer)
    # 只把「这条样本自己生成/修正的那条事件」挂回样本上；撞见别人人工录的同刻事件时
    # 不挂链接，否则下次改判就会顺着链接改掉别人的记录。
    own_id = (event or {}).get("id") if (event or {}).get("action") in ("added", "updated") else None
    with _LOCK, _connect() as c:
        cur=c.execute("""UPDATE model_feedback_samples SET feedback_label=?,feedback_kind=?,
            feedback_note=?,reviewer=?,status=?,reviewed_at=?,fault_type=?,actual_rul_hours=?,event_id=?
            WHERE id=?""",
            (label,kind,note,reviewer,status,_now() if status=="reviewed" else None,
             fault_type or None, actual_hours,
             own_id or sample.get("event_id"), sample_id))
        if not cur.rowcount:
            raise ValueError("反馈样本不存在")
    return {"ok":True,"status":status,"event":event,
            "message":_feedback_message(kind, event, sample, fault_type)}


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


def _cooldown_seconds():
    """距上一次训练还差多少秒；间隔与提示语都在 model_runs，两套模型共用一个口径。

    每次训练都要重建数据集并全量重拟合，重复点一下就是白吃一轮 CPU、白留一份记录；
    平台上没有任何登录，所以这一层按时间闸住，而不是指望前端把按钮禁用住。
    """
    with _connect() as c:
        row = c.execute("SELECT created_at FROM model_training_runs ORDER BY id DESC LIMIT 1").fetchone()
    if not row or not row["created_at"]:
        return 0.0
    try:
        last = datetime.strptime(str(row["created_at"])[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return 0.0
    return model_runs.wait_left(last.timestamp())


def train_candidate(default_model_path):
    """训练候选版本并评估；只有通过保护阈值才自动发布。"""
    with _LOCK:
        wait = _cooldown_seconds()
        if wait > 0:
            raise model_runs.cooldown_error(wait)
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
        # 只有评估通过、真的可能被批准的候选才落盘：candidate_rejected 既不能发布
        # （publish 只认 pending_approval）也不能回滚（rollback 只认 published），
        # 文件写出来就永远没有引用方，每点一次训练白占几百 KB 磁盘。
        rel_path = ""
        if passed:
            # 用全部已审核样本重新拟合一次作为上线候选，但不自动替换线上模型。
            deploy_model = ai_model.train_model(
                df[feature_cols], df[target_col], ["type"], save_path="", class_weight="balanced")
            ai_model.joblib.dump(deploy_model, str(model_file))
            rel_path = str(model_file.relative_to(root))
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
    return model_runs.with_metrics(rows)


def summary():
    with _connect() as c:
        total=c.execute("SELECT COUNT(*) FROM model_feedback_samples").fetchone()[0]
        reviewed=c.execute("SELECT COUNT(*) FROM model_feedback_samples WHERE status='reviewed'").fetchone()[0]
        trainable=c.execute("SELECT COUNT(*) FROM model_feedback_samples WHERE status='reviewed' AND feedback_label IN (0,1)").fetchone()[0]
        labeled=c.execute("SELECT COUNT(*) FROM model_feedback_samples WHERE fault_type IS NOT NULL").fetchone()[0]
        linked=c.execute("SELECT COUNT(*) FROM model_feedback_samples WHERE event_id IS NOT NULL").fetchone()[0]
    with _connect() as c:
        pending_approvals = c.execute("SELECT COUNT(*) FROM model_training_runs WHERE status='pending_approval'").fetchone()[0]
    return {"active_version":active_version(),"total_samples":total,"reviewed_samples":reviewed,
            "trainable_samples":trainable,"pending_samples":total-reviewed,
            "labeled_types":labeled,"linked_events":linked,
            "train_interval_seconds":model_runs.TRAIN_INTERVAL_SECONDS,
            "pending_approvals":pending_approvals,"history":training_history()}
