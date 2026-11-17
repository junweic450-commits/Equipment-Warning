"""特征工程与数据集组装模块。

把 equipment（台账）与 run_simulation_log（时序）按 code 左连接，清洗后输出
固定特征列 + 标签。只做特征组装，不训练、不预测、不写库。

数据契约（由 equipment_db 管理，本模块只读）：
    equipment          code, name, type, location, rated_v, rated_i, rated_p, ...
    run_simulation_log id, code, sim_time, tunnel_name, env_temp, dev_temp,
                       current, run_hours, since_repair_hours, humidity, dust,
                       maintain_flag, fault_label

特征：
    静态 type, rated_v, rated_i, rated_p
    动态 env_temp, dev_temp, current, run_hours, since_repair_hours
    统计 fault_count_3m（近 90 天故障次数）, maintain_freq_3m（近 90 天检修次数/月）

特征口径说明：
    humidity、dust、fault_count_3m、maintain_freq_3m 只作为工况分
    （dashboard._condition_risk）的加权项，不再进入模型特征向量。
    这四项此前同时出现在模型和工况分里，同一个环境/维护因素会在
    risk = 1 - (1-模型分)(1-工况分) 中被计算两次；现在两条通路完全解耦。
"""
import os
import sqlite3
import warnings
from pathlib import Path

import pandas as pd
from sklearn.model_selection import train_test_split

import equipment_db

STATIC_FEATURES = ["type", "rated_v", "rated_i", "rated_p"]
DYNAMIC_FEATURES = ["env_temp", "dev_temp", "current", "run_hours", "since_repair_hours"]
# 统计特征：仍然参与清洗与留痕，但只进工况分、不进模型（见开头口径说明）
STAT_FEATURES = ["fault_count_3m", "maintain_freq_3m"]
FEATURE_COLS = STATIC_FEATURES + DYNAMIC_FEATURES
TARGET_COL = "fault_label"

# 清洗阈值
MAX_NAN_RATIO = 0.5           # 单行特征缺失比例上限
OVERLOAD_FACTOR = 2.5         # 电流超过额定值该倍数视为异常
MAX_DEV_TEMP = 200.0          # 设备温度上界（℃）
MAX_ENV_TEMP = 60.0           # 环境温度上界（℃）
MAX_RUN_HOURS = 100000.0      # 累计运行时长上界
MAX_REPAIR_HOURS = 100000.0   # 距上次检修时长上界
MAX_HUMIDITY = 3.0            # 湿度等级上界
MAX_DUST = 3.5                # 粉尘等级上界

WINDOW_DAYS = 90              # 统计窗口
WINDOW_MONTHS = 3.0           # 窗口折算月数

_REQUIRED_LOG_COLS = ["id", "code", "sim_time", "tunnel_name", "env_temp", "dev_temp",
                      "current", "run_hours", "since_repair_hours", "humidity", "dust",
                      "maintain_flag", "fault_label"]

# 台账表里组装特征必须存在的字段
_REQUIRED_EQUIP_COLS = ["code", "name", "type", "location", "rated_v", "rated_i", "rated_p",
                        "commission_date", "status", "remark", "created_at", "updated_at"]


def _read_table(table, columns, conn):
    r = [c[1] for c in conn.execute("PRAGMA table_info(%s)" % table)]
    if not r:
        raise ValueError("数据库缺少表：%s" % table)
    missing = [c for c in columns if c not in r]
    if missing:
        raise ValueError(
            f"表 {table} 缺少字段：{'、'.join(missing)}"
            f"（实际字段：{'、'.join(columns)}）"
        )
    return pd.read_sql(f"SELECT {','.join(columns)} FROM {table}", conn)


def _connect():
    path = Path(equipment_db.DB_PATH).resolve()
    if not path.exists():
        raise FileNotFoundError("数据库不存在：%s" % path)
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)


def _add_rolling_features(df):
    """按设备统计近 90 天故障次数与检修频率（次/月）。"""
    fault_map, maint_map = {}, {}
    for _, sub in df.groupby("_code", sort=False):
        times = sub["_ts"].tolist()
        fault = sub[TARGET_COL].fillna(0).astype(int).tolist()
        maintain = sub["_maint"].fillna(0).astype(int).tolist()

        # 只在故障第一次出现时计数，连续多个故障采样点算同一次故障
        starts = [times[i] for i in range(len(times))
                  if fault[i] == 1 and (i == 0 or fault[i - 1] == 0)]
        repairs = [times[i] for i in range(len(times)) if maintain[i] == 1]

        window = pd.Timedelta(days=WINDOW_DAYS)
        for idx, t in zip(sub.index, times):
            low = t - window
            fault_map[idx] = float(sum(1 for x in starts if low <= x <= t))
            cnt = sum(1 for x in repairs if low <= x <= t)
            maint_map[idx] = round(cnt / WINDOW_MONTHS, 2)

    df = df.copy()
    df["fault_count_3m"] = pd.Series(fault_map)
    df["maintain_freq_3m"] = pd.Series(maint_map)
    return df


def _clean(df):
    df = df.copy()

    df["_ts"] = pd.to_datetime(df["sim_time"], errors="coerce")
    df = df.dropna(subset=["_ts"])

    # 缺失过多的行直接丢弃，避免填补出来的假样本影响模型
    nan_ratio = df[FEATURE_COLS].isna().mean(axis=1)
    df = df[nan_ratio <= MAX_NAN_RATIO]
    df = df.dropna(subset=[TARGET_COL])

    # 数值字段允许缺失，但存在时必须在物理合理范围内
    for col in ("env_temp", "dev_temp", "current", "run_hours",
                "since_repair_hours", "humidity", "dust",
                "fault_count_3m", "maintain_freq_3m"):
        df = df[df[col].isna() | (df[col] >= 0)]
    df = df[df["dev_temp"].isna() | (df["dev_temp"] <= MAX_DEV_TEMP)]
    df = df[df["env_temp"].isna() | (df["env_temp"] <= MAX_ENV_TEMP)]
    df = df[df["run_hours"].isna() | (df["run_hours"] <= MAX_RUN_HOURS)]
    df = df[df["since_repair_hours"].isna() | (df["since_repair_hours"] <= MAX_REPAIR_HOURS)]
    df = df[df["humidity"].isna() | (df["humidity"] <= MAX_HUMIDITY)]
    df = df[df["dust"].isna() | (df["dust"] <= MAX_DUST)]

    # 电流超出额定值 OVERLOAD_FACTOR 倍视为传感器异常
    limit = df["rated_i"] * OVERLOAD_FACTOR
    df = df[df["current"].isna() | (df["current"] <= limit)]

    df = df[df[TARGET_COL].isin([0, 1])]
    df[TARGET_COL] = df[TARGET_COL].astype(int)
    return df.reset_index(drop=True)


def build_feature_dataset(include_metadata=False):
    """组装特征数据集，返回 (df_all, feature_cols, target_col)。

    include_metadata=True 时额外保留 _code/_sim_time，用于将人工反馈
    精确回写到原始遥测样本，避免同一采样点重复计入训练集。
    默认 False，兼容原有调用方。
    """
    conn = _connect()
    try:
        equipment = _read_table("equipment", _REQUIRED_EQUIP_COLS, conn)
        logs = _read_table("run_simulation_log", _REQUIRED_LOG_COLS, conn)
    finally:
        conn.close()

    eq_codes = set(equipment["code"].astype(str))
    log_codes = set(logs["code"].astype(str))
    missing_logs = sorted(eq_codes - log_codes)
    missing_eq = sorted(log_codes - eq_codes)
    if missing_logs:
        warnings.warn("台账中以下设备没有任何仿真日志，不会进入数据集：%s"
                      % "、".join(missing_logs), RuntimeWarning)
    if missing_eq:
        warnings.warn("日志中以下设备在台账里不存在，相关记录将被剔除：%s"
                      % "、".join(missing_eq), RuntimeWarning)

    df = logs.merge(
        equipment[["code", "type", "rated_v", "rated_i", "rated_p"]],
        on="code", how="left",
    )
    df = df.dropna(subset=["type", "rated_v", "rated_i", "rated_p"])

    # 台账字段可能覆盖同名列，统计特征统一用下划线前缀的临时列
    df = df.rename(columns={"code": "_code", "maintain_flag": "_maint"})
    df["_ts"] = pd.to_datetime(df["sim_time"], errors="coerce")
    df = df.sort_values(["_code", "_ts"]).reset_index(drop=True)

    df = _add_rolling_features(df)
    df = _clean(df)

    columns = FEATURE_COLS + [TARGET_COL]
    if include_metadata:
        columns += ["_code", "sim_time"]
    df_all = df[columns].copy()
    if include_metadata:
        df_all = df_all.rename(columns={"sim_time": "_sim_time"})
    return df_all, list(FEATURE_COLS), TARGET_COL


def split_train_test(df, test_size=0.2, random_state=42):
    """分层划分训练/测试集。"""
    X = df[FEATURE_COLS]
    y = df[TARGET_COL]
    try:
        return train_test_split(X, y, test_size=test_size,
                                random_state=random_state, stratify=y)
    except ValueError as exc:
        print("分层划分不可用（%s），退化为随机划分" % exc)
        return train_test_split(X, y, test_size=test_size,
                                random_state=random_state, stratify=None)


def save_to_csv(df, path="dataset_out.csv"):
    folder = os.path.dirname(os.path.abspath(path))
    if folder:
        os.makedirs(folder, exist_ok=True)
    df.to_csv(path, index=False, encoding="utf-8-sig")
    return path


if __name__ == "__main__":
    df_all, feature_cols, target_col = build_feature_dataset()

    print("======================================================================")
    print("数据集形状：%d 行 × %d 列" % (df_all.shape[0], df_all.shape[1]))
    print("\n前 10 行预览：")
    print(df_all.head(10).to_string(index=False))

    print("\n特征列表（%d 个）：" % len(feature_cols))
    for i, name in enumerate(feature_cols, 1):
        print("  %2d. %s" % (i, name))

    y = df_all[target_col]
    print("\n标签分布：")
    print("  正样本（故障 y=1）：%d" % int((y == 1).sum()))
    print("  负样本（正常 y=0）：%d" % int((y == 0).sum()))
    print("  故障占比：%.2f%%" % (float((y == 1).mean() * 100) if len(y) else 0.0))

    X_train, X_test, y_train, y_test = split_train_test(df_all)
    print("\n训练/测试划分：")
    print("  训练集：%d 行（故障 %d，正常 %d）" %
          (len(X_train), int((y_train == 1).sum()), int((y_train == 0).sum())))
    print("  测试集：%d 行（故障 %d，正常 %d）" %
          (len(X_test), int((y_test == 1).sum()), int((y_test == 0).sum())))

    path = save_to_csv(df_all)
    print("\n全量数据集已保存：%s" % path)
