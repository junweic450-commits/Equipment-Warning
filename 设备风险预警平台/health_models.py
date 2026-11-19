"""故障类型多分类与剩余寿命（RUL）训练管线。

和线上 histgb 二分类（风险概览的那个数）完全解耦：这里只吃两张标签表
（fault_events 失效事件、device_lifecycle 生命周期事件）配同一套遥测特征，
产出「最可能是哪一种故障」和「还能跑多少小时」两个候选模型。

现在现场还没有失效标签，所以这个模块的第一职责不是说谎，而是把「还差多少」
算清楚：样本不够就拒绝训练，并把缺的条数原样报出去，绝不用仿真标签凑一个
看起来能用的数字。
"""
import json
import math
import threading
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score

import dataset_builder
import equipment_db
import model_runs

_LOCK = threading.RLock()
NORMAL_CLASS = "正常"

# 振动 / 压力 / 绝缘电阻是「现场有就更好、没有也不拦」的可选项：温度+电流为主。
# 列存在且填充率达到 OPTIONAL_MIN_COVERAGE 才进特征向量，否则整列缺失反而会把
# 模型训练成「这一列全空的年代 vs 不空的年代」这种伪相关。
OPTIONAL_FEATURES = {
    "vibration_mm_s": "振动速度(mm/s)",
    "pressure_mpa": "出口压力(MPa)",
    "insulation_mohm": "绝缘电阻(MΩ)",
}
OPTIONAL_MIN_COVERAGE = 0.6

# 故障多分类门禁
FAULT_MIN_SAMPLES = 60          # 带类型的失效快照总量下限
FAULT_MIN_PER_CLASS = 5         # 每个故障类型至少几条，否则那一类纯属噪声
FAULT_MIN_CLASSES = 2           # 至少两类才有分类问题可言
FAULT_SNAPSHOT_HOURS = 24       # 失效前多久内的采样算「故障现场」
FAULT_NEG_PER_POS = 8           # 正常样本按这个倍数下采样，避免 8 类被正常淹没
FAULT_RECENT_CLEAN_DAYS = 7     # 检修后 7 天内的采样既不算故障也不算干净基线

# RUL 门禁
RUL_MIN_FAILURES = 12           # 至少这么多次「有明确失效时刻」的失效
RUL_MIN_SAMPLES = 200           # 累计可用滚动样本
RUL_MAX_HOURS = 24 * 180        # 只学半年以内的衰减段，太远等于学季节
RUL_MIN_PREDICTIVE_HOURS = 24   # 少于 24 小时的样本没有预测价值
RUL_MIN_COVERAGE = 0.6          # P10–P90 区间至少盖住这么多真值
RUL_MAX_MAE_RATIO = 0.5         # MAE / 平均真值，超过就是没学出东西
RUL_NOMINAL_COVERAGE = 0.8      # 区间的名义覆盖率：三个头各自拟合时达不到，得靠校准段补
RUL_CALIB_FRACTION = 0.2        # 训练段末尾留这么多条做保形校准（时间在后，不泄露给验证段）
RUL_MIN_CALIB = 30              # 校准条数少到这个数以下就不放大区间，免得拿几条样本瞎撑宽度


_connect = equipment_db.connect
_now = equipment_db.stamp


def init_db():
    """候选模型的落库记录；和 model_training_runs 分开，避免把风险模型的审批流绕进来。"""
    with _connect() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS health_model_runs(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            version TEXT NOT NULL,
            status TEXT NOT NULL,
            model_path TEXT,
            dataset_size INTEGER,
            metrics_json TEXT,
            message TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(kind, version)
        );
        CREATE INDEX IF NOT EXISTS idx_health_runs_kind ON health_model_runs(kind, id DESC);
        """)
        # 审批人与审批时间是发布环节后加的：谁批准了「最可能故障」这一列上线上，
        # 出问题时得能追到人，和二进制风险模型的审批留痕一个标准。
        cols = {r[1] for r in c.execute("PRAGMA table_info(health_model_runs)").fetchall()}
        for col, ddl in (("approved_by", "TEXT"), ("approved_at", "TEXT")):
            if col not in cols:
                c.execute("ALTER TABLE health_model_runs ADD COLUMN %s %s" % (col, ddl))



def _ts(value):
    """标签表/遥测里的时间一律转 pandas Timestamp；坏值直接挡下而不是悄悄变成 NaT。"""
    ts = pd.Timestamp(str(value))
    if ts is pd.NaT:
        raise ValueError("时间无法解析：%s" % value)
    return ts


def models_dir():
    root = Path(equipment_db.DATA_DIR).parent / "models"
    root.mkdir(parents=True, exist_ok=True)
    return root


# --------------------------------------------------------------------------
# 特征：与风险概览共用 dataset_builder 的那一份口径，可选传感器列按填充率追加
# --------------------------------------------------------------------------
def _telemetry_count():
    """遥测条数只有一个问法：可选列的填充率、两个模型的就绪判断共用这一个数。"""
    with _connect() as c:
        return c.execute("SELECT COUNT(*) FROM run_simulation_log").fetchone()[0]


def _optional_columns():
    """现场有没有这几列、填了多少。列不存在就整列跳过，不报错也不假装能用。"""
    total = _telemetry_count()
    with _connect() as c:
        cols = {r[1] for r in c.execute("PRAGMA table_info(run_simulation_log)")}
        if not total:
            return cols, {}
        coverage = {}
        for name in OPTIONAL_FEATURES:
            if name in cols:
                filled = c.execute("SELECT COUNT(%s) FROM run_simulation_log" % name).fetchone()[0]
                coverage[name] = filled / float(total)
    usable = {k: v for k, v in coverage.items() if v >= OPTIONAL_MIN_COVERAGE}
    return cols, usable


def _attach_optional(df, usable):
    """把可选传感器列按 (编号, 采样时间) 拼到特征表上。"""
    if not usable:
        return df
    with _connect() as c:
        names = ",".join(usable)
        rows = c.execute("SELECT code, sim_time, %s FROM run_simulation_log" % names).fetchall()
    extra = pd.DataFrame([(r[0], r[1], *[r[i + 2] for i in range(len(usable))]) for r in rows],
                         columns=["_code", "_sim_time"] + list(usable))
    return df.merge(extra, on=["_code", "_sim_time"], how="left")


def feature_frame():
    """特征表 + 实际可用的特征列（含通过填充率门槛的可选传感器列）。"""
    df, feature_cols, target = dataset_builder.build_feature_dataset(include_metadata=True)
    df = df.copy()
    df["_code"] = df["_code"].astype(str)
    df["_sim_time"] = df["_sim_time"].astype(str)
    _cols, usable = _optional_columns()
    df = _attach_optional(df, usable)
    return df, list(feature_cols) + sorted(usable), target, usable


def _confirmed_events(table, filters=None):
    """两张事件表只从 equipment_db 那道读出口进来，本模块不再自己拼 SQL。"""
    out = []
    for d in equipment_db.all_event_records(table, status=(filters or {}).get("status")):
        try:
            d["_ts"] = _ts(d.get("fail_time") or d.get("event_time"))
        except ValueError:
            continue                      # 脏时间不参与训练，录入那一道闸已经把它挡在门外了
        out.append(d)
    return out


# --------------------------------------------------------------------------
# 故障类型多分类
# --------------------------------------------------------------------------
def build_fault_type_dataset():
    """失效快照 = 每次已确认故障前 24 小时内的最后一条采样；正常样本按倍数下采样。

    只取已确认（status='confirmed'）的事件：待确认的那些还没人复核，拿它们训练
    等于让模型去学一个连现场都不认的标签。
    """
    df, feature_cols, target, usable = feature_frame()
    events = _confirmed_events("fault_events", {"status": "confirmed"})
    readiness = fault_type_readiness(len(events), len(df))
    if not events:
        return pd.DataFrame(columns=feature_cols + ["fault_type"]), feature_cols, "fault_type", readiness

    df = df.sort_values(["_code", "_sim_time"]).reset_index(drop=True)
    by_code = {code: sub for code, sub in df.groupby("_code", sort=False)}
    pos_rows, pos_keys = [], set()
    for ev in events:
        sub = by_code.get(str(ev["code"]))
        if sub is None or sub.empty:
            continue
        before = sub[sub["_sim_time"].map(lambda s: _ts(s) <= ev["_ts"])]
        if before.empty:
            continue
        snap = before.iloc[-1]
        if (ev["_ts"] - _ts(snap["_sim_time"])).total_seconds() / 3600.0 > FAULT_SNAPSHOT_HOURS:
            continue                  # 那次失效附近根本没采样，硬贴标签就是编数据
        key = (snap["_code"], snap["_sim_time"])
        if key in pos_keys:
            continue
        pos_keys.add(key)
        row = snap.to_dict()
        row["fault_type"] = ev["fault_type"]
        pos_rows.append(row)

    # 检修/更换之后的样本处于「刚恢复」状态，既不是故障现场也不是干净基线，整段剔掉；
    # 失效前 24 小时之外、且距最近一次故障已经 ≥7 天的采样才算正常样本。
    dirty = []
    for table, col in (("fault_events", "fail_time"), ("device_lifecycle", "event_time")):
        for ev in _confirmed_events(table):
            dirty.append((str(ev["code"]), ev["_ts"]))
    neg_rows = []
    for code, sub in by_code.items():
        bounds = [t for (c, t) in dirty if c == code]
        if not bounds:
            bounds = []
        for _, row in sub.iterrows():
            if (row["_code"], row["_sim_time"]) in pos_keys:
                continue
            t = _ts(row["_sim_time"])
            if any(0 <= (t - b).total_seconds() / 86400.0 < FAULT_RECENT_CLEAN_DAYS for b in bounds):
                continue
            if int(row.get("fault_label") or 0) == 1:
                continue
            item = row.to_dict()
            item["fault_type"] = NORMAL_CLASS
            neg_rows.append(item)
    if pos_rows and len(neg_rows) > len(pos_rows) * FAULT_NEG_PER_POS:
        rng = np.random.RandomState(42)
        pick = rng.choice(len(neg_rows), size=len(pos_rows) * FAULT_NEG_PER_POS, replace=False)
        neg_rows = [neg_rows[i] for i in sorted(pick)]

    out = pd.DataFrame(pos_rows + neg_rows)
    return out, feature_cols, "fault_type", readiness


def fault_type_readiness(event_count, sample_count):
    """能不能训、还差什么，全部在这里算一次，UI 直接读。"""
    gaps = []
    if event_count < 1:
        gaps.append("还没有任何已确认的失效事件，先把现场「哪台设备、什么时候、坏成什么样」录进来")
    elif event_count < FAULT_MIN_SAMPLES:
        gaps.append("已确认失效事件 %d 条，少于 %d 条（同一条事件只贡献 1 个故障现场样本）"
                    % (event_count, FAULT_MIN_SAMPLES))
    if sample_count < 50:
        gaps.append("可用遥测只有 %d 条，至少要 50 条才能划出训练与测试" % sample_count)
    return {"can_train": not gaps, "gaps": gaps, "events": event_count,
            "samples": sample_count, "min_events": FAULT_MIN_SAMPLES,
            "min_per_class": FAULT_MIN_PER_CLASS, "snapshot_hours": FAULT_SNAPSHOT_HOURS}


def _class_gate(df, target):
    counts = df[target].value_counts()
    bad = {k: int(v) for k, v in counts.items() if k != NORMAL_CLASS and v < FAULT_MIN_PER_CLASS}
    return {"samples": int(len(df)), "classes": int((counts.index != NORMAL_CLASS).sum()),
            "counts": {k: int(v) for k, v in counts.items()}, "classes_below_min": bad}


def train_fault_type(save=True):
    """训练故障类型多分类候选模型；样本或类别不够就明确拒绝，不落盘也不写记录。"""
    with _LOCK:
        df, feature_cols, target, readiness = build_fault_type_dataset()
        if not readiness["can_train"] or df.empty:
            return {"ok": False, "trained": False, "reasons": readiness["gaps"], "readiness": readiness}
        gate = _class_gate(df, target)
        if gate["samples"] < FAULT_MIN_SAMPLES:
            return {"ok": False, "trained": False, "gate": gate, "readiness": readiness,
                    "reasons": ["故障现场样本只有 %d 条，少于 %d 条" % (gate["samples"], FAULT_MIN_SAMPLES)]}
        if gate["classes"] < FAULT_MIN_CLASSES:
            return {"ok": False, "trained": False, "gate": gate, "readiness": readiness,
                    "reasons": ["只标注出 %d 个故障类型，至少要有 %d 类才谈得上分类"
                                % (gate["classes"], FAULT_MIN_CLASSES)]}
        if gate["classes_below_min"]:
            return {"ok": False, "trained": False, "gate": gate, "readiness": readiness,
                    "reasons": ["这些类型的样本不足 %d 条：%s"
                                % (FAULT_MIN_PER_CLASS,
                                   "、".join("%s(%d)" % (k, v) for k, v in gate["classes_below_min"].items()))]}
        # 按设备分组切分：同一台设备相邻时刻几乎一样，随机切会把「同一场故障」
        # 同时放进训练集和测试集，指标虚高且上线必翻车。
        groups = df["_code"].astype(str)
        codes = sorted(groups.unique())
        if len(codes) < 2:
            return {"ok": False, "trained": False, "gate": gate, "readiness": readiness,
                    "reasons": ["标签只覆盖 1 台设备，无法留出没见过的设备做验证"]}
        test_code = codes[len(codes) // 2]        # 固定取中间那台，保证同一份数据结论可复现
        train_part, test_part = df[groups != test_code], df[groups == test_code]
        if test_part[target].nunique() < 2:
            for code in codes:
                cand_test = df[groups == code]
                if cand_test[target].nunique() >= 2:
                    test_code, train_part, test_part = code, df[groups != code], cand_test
                    break
        X_train, y_train = train_part[feature_cols], train_part[target]
        X_test, y_test = test_part[feature_cols], test_part[target]
        model = HistGradientBoostingClassifier(categorical_features=["type"],
                                               random_state=42, class_weight="balanced")
        model.fit(X_train, y_train)
        pred = model.predict(X_test)
        metrics = {
            "held_out_device": test_code,
            "train_samples": int(len(X_train)), "test_samples": int(len(X_test)),
            "accuracy": float(accuracy_score(y_test, pred)),
            "macro_f1": float(f1_score(y_test, pred, average="macro", zero_division=0)),
            "fault_recall": float(recall_score(y_test, pred, labels=[c for c in set(y_test) - {NORMAL_CLASS}],
                                               average="macro", zero_division=0)),
            "per_class": {c: float(precision_score(y_test == c, pred == c, zero_division=0))
                          for c in sorted(set(y_test))},
            "classes": sorted(set(y_test) | set(y_train)),
        }
        version = _next_version("fault_type")
        if not save:
            # 干跑只回指标，不留痕也不落盘：留痕里混进没落盘的 candidate，
            # 后面审批流会去加载一个不存在的模型文件。
            return {"ok": True, "trained": True, "dry_run": True, "kind": "fault_type",
                    "version": version, "status": "dry_run", "metrics": metrics, "gate": gate,
                    "features": feature_cols, "model_path": ""}
        path = "models/fault_type_%s.joblib" % version.replace(".", "_")
        joblib.dump({"model": model, "features": feature_cols, "classes": metrics["classes"]},
                    str(models_dir() / Path(path).name))
        _record("fault_type", version, "candidate", path, len(df), metrics,
                "留出设备 %s 宏 F1=%.3f" % (test_code, metrics["macro_f1"]))
        return {"ok": True, "trained": True, "kind": "fault_type", "version": version,
                "status": "candidate", "metrics": metrics, "gate": gate,
                "features": feature_cols, "model_path": path}


# --------------------------------------------------------------------------
# 剩余寿命 RUL
# --------------------------------------------------------------------------
def sort_quantiles(band):
    """三条分位数各自拟合，本来就允许互相越过；给人看的区间必须先排好序、再截掉负数小时。"""
    arr = np.sort(np.asarray(band, dtype=float), axis=0)
    return np.maximum(arr, 0.0)


def conformal_beta(lo, hi, y, level=RUL_NOMINAL_COVERAGE):
    """保形校准：把三个头各自拟合时普遍贴得太紧的区间，按本段实测误差一次性撑开。

    名义 80% 的 P10–P90，三个头各练各的，实测常只有五六成——摆到页面上就是「说 30 天
    内安全、结果 10 天坏了」。撑开量用相对宽度（除以本地区间宽）来算：快坏的设备区间
    本来就窄，按绝对小时数放大等于把它撑成和刚检修时一样宽，那不如不给区间。
    """
    n = len(y)
    if n < RUL_MIN_CALIB:
        return 0.0
    lo, hi, y = (np.asarray(v, dtype=float) for v in (lo, hi, y))
    w = np.maximum(hi - lo, 1.0)                       # 贴成一条线时也别除以 0
    score = np.maximum((lo - y) / w, (y - hi) / w)     # >0 就是这条没盖住
    k = min(int(math.ceil(float(level) * (n + 1))), n)
    return float(max(np.sort(score)[k - 1], 0.0))


def apply_calibration(band, cal=None):
    """按校准段撑开区间，再重排序、截负数；没留校准段（beta=0）就原样返回。"""
    beta = float((cal or {}).get("beta") or 0.0)
    if beta <= 0:
        return sort_quantiles(band)
    lo, mid, hi = band[0], band[1], band[2]
    w = np.maximum(hi - lo, 1.0)
    return sort_quantiles(np.vstack([lo - beta * w, mid, hi + beta * w]))


def rul_predict(bundle, X):
    """用落盘的 RUL 包预测 (P10, P50, P90)，三行 N 列，已保证 P10 ≤ P50 ≤ P90。"""
    models = bundle["models"] if isinstance(bundle, dict) else bundle
    feats = (bundle.get("features") if isinstance(bundle, dict) else None) or []
    if feats and hasattr(X, "columns") and list(X.columns) != list(feats):
        X = X[feats]
    band = sort_quantiles(np.vstack([models[q].predict(X) for q in (0.1, 0.5, 0.9)]))
    return apply_calibration(band, bundle.get("calibration") if isinstance(bundle, dict) else None)


def build_rul_dataset():
    """每条采样往后找第一个事件：故障失效 → 未删失标签；计划检修/更换 → 右删失。

    投运/更换复位之后计时归零，所以「距下次失效多少小时」才是损耗的量尺；
    把计划检修当成寿命终点会教出「按时保养 = 快坏了」这种荒谬结论。
    """
    df, feature_cols, target, usable = feature_frame()
    faults = {}
    for ev in _confirmed_events("fault_events", {"status": "confirmed"}):
        faults.setdefault(str(ev["code"]), []).append(ev["_ts"])
    resets = {}
    for ev in _confirmed_events("device_lifecycle"):
        if ev.get("kind") in ("计划检修", "更换复位", "投运"):
            resets.setdefault(str(ev["code"]), []).append(ev["_ts"])
    rows = []
    censored = 0
    for code, sub in df.groupby("_code", sort=False):
        f_times = sorted(faults.get(str(code), []))
        r_times = sorted(resets.get(str(code), []))
        for _, row in sub.iterrows():
            t = _ts(row["_sim_time"])
            nxt_f = next((x for x in f_times if x >= t), None)
            nxt_r = next((x for x in r_times if x >= t), None)
            if nxt_f is None:
                censored += 1
                continue                       # 后面没记录到失效：不知道该学什么，不硬编 0
            if nxt_r is not None and nxt_r < nxt_f:
                censored += 1
                continue                       # 先被计划检修打断，这段不是损耗致死
            hours = (nxt_f - t).total_seconds() / 3600.0
            if hours < RUL_MIN_PREDICTIVE_HOURS or hours > RUL_MAX_HOURS:
                continue
            item = row.to_dict()
            item["rul_hours"] = round(hours, 1)
            rows.append(item)
    out = pd.DataFrame(rows)
    events = sum(len(v) for v in faults.values())
    readiness = rul_readiness(events, len(out), censored)
    return out, feature_cols, "rul_hours", readiness, censored


def rul_readiness(failure_events, sample_count=None, censored_count=0):
    gaps = []
    if failure_events < 1:
        gaps.append("还没有已确认的失效事件，剩余寿命必须有「这台确实坏过一次」才能算真值")
    elif failure_events < RUL_MIN_FAILURES:
        gaps.append("已确认失效 %d 次，少于 %d 次（每次失效才展开出一段可标注的衰减过程）"
                    % (failure_events, RUL_MIN_FAILURES))
    if sample_count is None:
        gaps.append("还没核算过可标注的遥测样本量，训练前会先按失效事件与检修记录算一遍")
    elif sample_count < RUL_MIN_SAMPLES:
        gaps.append("可标注样本 %d 条，少于 %d 条" % (sample_count, RUL_MIN_SAMPLES))
    return {"can_train": not gaps and sample_count is not None, "gaps": gaps,
            "failure_events": failure_events, "labeled_samples": sample_count,
            "samples_unchecked": sample_count is None,
            "censored_samples": censored_count,
            "min_failure_events": RUL_MIN_FAILURES, "min_samples": RUL_MIN_SAMPLES,
            "horizon_hours": RUL_MAX_HOURS}


def train_rul(save=True):
    """三条分位数回归（P10/P50/P90）；门禁不过就拒绝，绝不给出假区间。"""
    with _LOCK:
        df, feature_cols, target, readiness, censored = build_rul_dataset()
        if not readiness["can_train"] or df.empty:
            return {"ok": False, "trained": False, "reasons": readiness["gaps"], "readiness": readiness}
        codes = sorted(df["_code"].astype(str).unique())
        if len(codes) < 2:
            return {"ok": False, "trained": False, "readiness": readiness,
                    "reasons": ["可标注样本只覆盖 1 台设备，留出验证做不了"]}
        # 同一台设备的相邻采样高度相关，按时间前后切：早段训练、晚段验证，
        # 才是真正的「提前知道还剩多少小时」。
        df = df.sort_values(["_sim_time"]).reset_index(drop=True)
        split = int(len(df) * 0.8)
        train_part, test_part = df.iloc[:split], df.iloc[split:]
        # 训练段末尾再切一段出来做保形校准：这一段既参与了「区间该放大多少」的估算，
        # 又严格早于验证段，所以验证段量出来的覆盖率不是自己给自己打的分。
        cal_cut = int(len(train_part) * (1.0 - RUL_CALIB_FRACTION))
        fit_part, cal_part = train_part.iloc[:cal_cut], train_part.iloc[cal_cut:]
        if len(test_part) < 10 or train_part[target].nunique() < 3:
            return {"ok": False, "trained": False, "readiness": readiness,
                    "reasons": ["按时间切分后验证集只有 %d 条，样本还不足以分开训练与验证" % len(test_part)]}
        models = {}
        for q in (0.1, 0.5, 0.9):
            m = HistGradientBoostingRegressor(loss="quantile", quantile=q,
                                              categorical_features=["type"], random_state=42)
            m.fit(fit_part[feature_cols], fit_part[target])
            models[q] = m
        cal_band = sort_quantiles(np.vstack([models[q].predict(cal_part[feature_cols])
                                             for q in (0.1, 0.5, 0.9)]))
        beta = conformal_beta(cal_band[0], cal_band[2], cal_part[target])
        cal = {"beta": beta, "samples": int(len(cal_part)),
               "nominal_coverage": RUL_NOMINAL_COVERAGE}
        X, y = test_part[feature_cols], test_part[target]
        raw = sort_quantiles(np.vstack([models[q].predict(X) for q in (0.1, 0.5, 0.9)]))
        band = apply_calibration(raw, cal)
        p50, lo, hi = band[1], band[0], band[2]
        metrics = {
            "train_samples": int(len(fit_part)), "test_samples": int(len(test_part)),
            "calibration_samples": cal["samples"], "devices": len(codes),
            "censored_samples": int(censored),
            "mae_hours": float(np.mean(np.abs(p50 - y))),
            "mean_true_hours": float(np.mean(y)),
            "coverage": float(np.mean((y >= lo) & (y <= hi))),
            "coverage_before_calibration": float(np.mean((y >= raw[0]) & (y <= raw[2]))),
            "calibration_beta": beta,
            "median_width_hours": float(np.median(hi - lo)),
        }
        reasons = []
        if metrics["mean_true_hours"] > 0 and \
                metrics["mae_hours"] / metrics["mean_true_hours"] > RUL_MAX_MAE_RATIO:
            reasons.append("MAE 占到平均剩余寿命的 %.0f%%，超过 %.0f%% 上限，模型没学到衰减趋势"
                           % (100 * metrics["mae_hours"] / metrics["mean_true_hours"], 100 * RUL_MAX_MAE_RATIO))
        if metrics["coverage"] < RUL_MIN_COVERAGE:
            reasons.append("P10–P90 只盖住 %.0f%% 的真值，低于 %.0f%%"
                           % (100 * metrics["coverage"], 100 * RUL_MIN_COVERAGE))
        version = _next_version("rul")
        passed = not reasons
        if not save:
            return {"ok": bool(passed), "trained": True, "dry_run": True, "kind": "rul",
                    "version": version, "status": "dry_run", "metrics": metrics,
                    "reasons": reasons, "readiness": readiness,
                    "features": feature_cols, "model_path": ""}
        path = ""
        if passed:
            name = "rul_%s.joblib" % version.replace(".", "_")
            joblib.dump({"models": models, "features": feature_cols, "calibration": cal},
                        str(models_dir() / name))
            path = "models/" + name
        _record("rul", version, "candidate" if passed else "candidate_rejected", path,
                len(df), metrics, "；".join(reasons) if reasons else
                "留出段 MAE=%.0f 小时、区间覆盖 %.0f%%" % (metrics["mae_hours"], 100 * metrics["coverage"]))
        return {"ok": bool(passed), "trained": True, "kind": "rul", "version": version,
                "status": "candidate" if passed else "candidate_rejected",
                "metrics": metrics, "reasons": reasons, "readiness": readiness,
                "features": feature_cols, "model_path": path}


def _next_version(kind):
    with _connect() as c:
        n = c.execute("SELECT COUNT(*) FROM health_model_runs WHERE kind=?", (kind,)).fetchone()[0]
    return "HT1.%d" % (n + 1) if kind == "fault_type" else "HR1.%d" % (n + 1)


def _record(kind, version, status, model_path, dataset_size, metrics, message):
    with _connect() as c:
        c.execute("""INSERT OR REPLACE INTO health_model_runs
            (kind,version,status,model_path,dataset_size,metrics_json,message,created_at)
            VALUES(?,?,?,?,?,?,?,?)""",
            (kind, version, status, model_path, int(dataset_size),
             json.dumps(metrics, ensure_ascii=False), message, _now()))


def history(kind=None, limit=20):
    with _connect() as c:
        if kind:
            rows = c.execute("SELECT * FROM health_model_runs WHERE kind=? ORDER BY id DESC LIMIT ?",
                             (kind, int(limit))).fetchall()
        else:
            rows = c.execute("SELECT * FROM health_model_runs ORDER BY id DESC LIMIT ?",
                             (int(limit),)).fetchall()
    return model_runs.with_metrics(rows)


def summary():
    """给风险概览用的就绪状态：两个模型各差多少条，一句话说清，不给假数字。"""
    init_db()
    events = equipment_db.event_counts("fault_events")
    life = equipment_db.event_counts("device_lifecycle")
    confirmed, pending = events["confirmed"], events["pending"]
    telemetry = _telemetry_count()
    present, usable = _optional_columns()
    return {
        "live": {k: (active(k) or {}).get("version") or "" for k in KINDS},
        "fault_type": {"readiness": fault_type_readiness(confirmed, telemetry),
                       "history": history("fault_type", 3)},
        "rul": {"readiness": rul_readiness(confirmed),
                "history": history("rul", 3)},
        "counts": {"confirmed_events": confirmed, "pending_events": pending,
                   "lifecycle_events": life["total"], "telemetry_rows": telemetry},
        "optional_features": [{"field": k, "label": OPTIONAL_FEATURES[k],
                               "coverage": round(v, 3)} for k, v in usable.items()],
        "optional_missing": [OPTIONAL_FEATURES[k] for k in OPTIONAL_FEATURES if k not in present],
    }


# --------------------------------------------------------------------------
# 上线发布与线上推理：风险概览那两列新数据只从这里出
# --------------------------------------------------------------------------
KINDS = ("fault_type", "rul")
KIND_LABELS = {"fault_type": "故障分类", "rul": "剩余寿命"}
STATUS_TEXT = {"candidate": "待审批", "published": "线上版本", "retired": "已下线",
               "candidate_rejected": "评估未通过", "dry_run": "干跑未落盘"}
TOP_K = 3
_CACHE = {}                       # kind → (缓存键, 已加载的包)，一次推理只反序列化一遍

# 训练时用的是哪一批特征，线上就必须给齐；缺的那几列一律按缺失值喂给 HGBT，
# 并在响应里如实报出去，不悄悄用 0 顶替（0 对振动/绝缘这类列是个真数值）。
RUL_FIELDS = ("p10", "p50", "p90")


def _check_kind(kind):
    if kind not in KINDS:
        raise ValueError("模型种类只能是 %s" % "或".join(KIND_LABELS[k] for k in KINDS))


def active(kind):
    """线上正在用的那一个版本；只认已发布状态，没发布就返回 None 而不是挑个最新的顶上。"""
    _check_kind(kind)
    init_db()
    with _connect() as c:
        row = c.execute("""SELECT * FROM health_model_runs WHERE kind=? AND status='published'
                           ORDER BY id DESC LIMIT 1""", (kind,)).fetchone()
    return None if not row else dict(row)


def _bundle_path(run):
    if not run or not run.get("model_path"):
        return None
    return models_dir() / Path(run["model_path"]).name


def active_bundle(kind):
    """线上模型的包；包不在（没发布、或记录与文件对不上）就返回 (None, run)。"""
    run = active(kind)
    path = _bundle_path(run)
    if not path:
        return None, run
    if not path.is_file():
        return None, run                # 记录说有，文件却丢了：宁可空着，也不拿旧包顶上
    key = (run["version"], path.name, path.stat().st_mtime)
    if _CACHE.get(kind, (None, None))[0] != key:
        _CACHE[kind] = (key, joblib.load(str(path)))
    return _CACHE[kind][1], run


def publish(kind, version, approver=""):
    """管理员批准上线：同一类只留一个线上版本，被替下来的转成「已下线」，随时能滚回去。"""
    _check_kind(kind)
    version = str(version or "").strip()
    if not version:
        raise ValueError("缺少模型版本号")
    with _LOCK, _connect() as c:
        runs = [dict(r) for r in c.execute(
            "SELECT * FROM health_model_runs WHERE kind=? ORDER BY id", (kind,)).fetchall()]
        target = next((r for r in runs if r["version"] == version), None)
        if not target:
            raise ValueError("没有 %s 这一版%s模型，先在「训练中心」训一轮"
                             % (version, KIND_LABELS[kind]))
        if target["status"] not in ("candidate", "retired", "published"):
            raise ValueError("%s 评估没通过，不能上线：%s" % (version, target["message"] or ""))
        path = _bundle_path(target)
        if not path or not path.is_file():
            raise ValueError("%s 的模型文件不在（%s），不能上线"
                             % (version, target["model_path"] or "没有落盘记录"))
        live = next((r for r in runs if r["status"] == "published" and r["version"] != version), None)
        c.execute("UPDATE health_model_runs SET status='retired' WHERE kind=? AND status='published'",
                  (kind,))
        c.execute("""UPDATE health_model_runs SET status='published', approved_by=?, approved_at=?
                     WHERE kind=? AND version=?""",
                  (str(approver or "")[:80], _now(), kind, version))
    _CACHE.pop(kind, None)
    return {"ok": True, "kind": kind, "version": version, "status": "published",
            "previous": (live or {}).get("version"),
            "message": "%s%s已上线（%s）%s" % (
                KIND_LABELS[kind], version, STATUS_TEXT["published"],
                "，原线上版本 %s 转为可回滚" % live["version"] if live else "")}


def rollback(kind, version, approver=""):
    """回滚就是把某个下过线的版本重新扶正，走的同一道审批，不留第二条改线上状态的路。"""
    _check_kind(kind)
    with _connect() as c:
        row = c.execute("SELECT status FROM health_model_runs WHERE kind=? AND version=?",
                        (kind, str(version or "").strip())).fetchone()
    if row and row["status"] == "published":
        raise ValueError("%s 已经在线上，不需要回滚" % str(version or "").strip())
    res = publish(kind, version, approver)
    res["rolled_back"] = True
    res["message"] = "%s%s已回滚上线，替换掉 %s" % (
        KIND_LABELS[kind], res["version"], res.get("previous") or "（此前没有线上版本）")
    return res


def readiness_quick():
    """两列各自还差多少：只按事件与遥测的条数算，不去构建数据集，表格上方那句提示随时能问。"""
    init_db()
    confirmed = equipment_db.event_counts("fault_events")["confirmed"]
    telemetry = _telemetry_count()
    return {"fault_type": fault_type_readiness(confirmed, telemetry),
            "rul": rul_readiness(confirmed)}


def column_note(kind, readiness=None):
    """这一列为什么是空的，一句话说清——是差数据、差审批，还是线上记录与文件对不上。"""
    _check_kind(kind)
    run = active(kind)
    bundle, run = active_bundle(kind)
    if bundle:
        return {"kind": kind, "live": run["version"], "reason": "", "gaps": []}
    if run:
        return {"kind": kind, "live": "",
                "reason": "线上记着 %s，但模型文件不在了；重新训一轮或在「训练中心」回滚一个版本" % run["version"],
                "gaps": []}
    hist = history(kind, 5)
    cand = [h for h in hist if h["status"] == "candidate"]
    if cand:
        return {"kind": kind, "live": "",
                "reason": "评估已通过 %s，等你在「训练中心」批准上线" % cand[0]["version"], "gaps": []}
    rej = [h for h in hist if h["status"] == "candidate_rejected"]
    gaps = (readiness or readiness_quick())[kind]["gaps"]
    reason = ("上一轮 %s 没过评估：%s" % (rej[0]["version"], rej[0]["message"])) if rej else \
        "还没训过%s模型" % KIND_LABELS[kind]
    return {"kind": kind, "live": "", "reason": reason, "gaps": gaps}


def _frame(rows, feats):
    """按训练时的列顺序取特征；台账/遥测里真没有的列留 None，让 HGBT 按缺失值处理。"""
    df = pd.DataFrame(rows)
    missing = [f for f in feats if f not in df.columns]
    for f in missing:
        df[f] = None
    return df[list(feats)], missing


def _feat_label(field):
    """缺列要说给人听的话：可选列有中文名，其余按字段名原样回出。"""
    return OPTIONAL_FEATURES.get(field, field)


def fault_top3(bundle, X):
    """每台设备最可能的 TOP_K 种故障（含「正常」这一类，概率照实给，不替人下结论）。"""
    proba = bundle["model"].predict_proba(X)
    classes = [str(c) for c in bundle["classes"]]
    out = []
    for row in proba:
        order = np.argsort(row)[::-1][:TOP_K]
        out.append([{"fault_type": classes[i], "probability": round(float(row[i]), 4),
                    "is_normal": classes[i] == NORMAL_CLASS} for i in order])
    return out


def overview(samples):
    """风险概览那两列：最可能故障 Top-3 + 剩余寿命 P10–P90。

    samples 由 dashboard 用和风险等级同一个 `_model_sample` 算出来（每台设备最新一条，
    含抽屉里的手动覆盖值），所以新列与风险色档说的是同一时刻的事，不会两处各自取数。
    """
    init_db()
    rows = [dict(s) for s in samples if s.get("code")]
    notes = {k: column_note(k) for k in KINDS}
    live = {}
    for s in rows:
        code = str(s["code"])
        live.setdefault(code, {"code": code, "sim_time": s.get("sim_time"),
                               "top3": None, "rul": None,
                               "model_version": "", "rul_model": ""})
    out = {"ok": True, "ts": _now(), "notes": notes,
           "models": {k: notes[k]["live"] for k in KINDS},
           "missing_features": {k: [] for k in KINDS}, "top_k": TOP_K,
           "normal_class": NORMAL_CLASS, "quantiles": list(RUL_FIELDS)}

    ft_bundle, ft_run = active_bundle("fault_type")
    if ft_bundle and rows:
        X, missing = _frame(rows, list(ft_bundle["features"]))
        out["missing_features"]["fault_type"] = [_feat_label(f) for f in missing]
        for s, top in zip(rows, fault_top3(ft_bundle, X)):
            item = live[str(s["code"])]
            item["top3"] = top
            item["model_version"] = (ft_run or {}).get("version") or ""
    ru_bundle, ru_run = active_bundle("rul")
    if ru_bundle and rows:
        X, missing = _frame(rows, list(ru_bundle["features"]))
        out["missing_features"]["rul"] = [_feat_label(f) for f in missing]
        band = rul_predict(ru_bundle, X)          # 已排序、已截负：P10 ≤ P50 ≤ P90
        for i, s in enumerate(rows):
            item = live[str(s["code"])]
            item["rul"] = {RUL_FIELDS[j]: round(float(band[j][i]), 1) for j in range(3)}
            item["rul_model"] = (ru_run or {}).get("version") or ""
    out["devices"] = [live[str(s["code"])] for s in rows]
    return out
