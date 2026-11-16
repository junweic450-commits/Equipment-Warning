"""模型训练与推理模块。

职责：HistGradientBoostingClassifier 的训练、保存、加载、概率预测、
特征重要性提取与测试集评估。特征工程全部由 dataset_builder 提供，
本模块不读数据库、不做清洗、不绘图、不调参。

依赖：dataset_builder、sklearn、joblib、pandas、numpy
"""
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import precision_score, recall_score, roc_auc_score

import dataset_builder

CATEGORICAL_FEATURES = ["type"]
RANDOM_STATE = 42
MODEL_PATH = "histgb_model.joblib"


def train_model(X_train, y_train, categorical_feature_names=None,
                save_path="histgb_model.joblib", random_state=42, class_weight=None):
    """训练 HistGradientBoostingClassifier。

    参数
    ----------
    X_train : DataFrame
        训练特征，列必须来自 dataset_builder.FEATURE_COLS。
    y_train : Series
        训练标签，0/1。
    categorical_feature_names : list
        需要按类别处理的特征名，通常是 ["type"]。
    save_path : str
        模型保存路径；传空字符串则不落盘。
    random_state : int
        随机种子，保证复现。
    class_weight : str 或 dict
        类别权重，故障样本偏少时用 "balanced"。

    返回
    -------
    训练好的模型对象。
    """
    model = HistGradientBoostingClassifier(
        categorical_features=list(categorical_feature_names),
        random_state=random_state,
        class_weight=class_weight,
    )
    model.fit(X_train, y_train)
    joblib.dump(model, save_path)
    return model


def load_model(model_path="histgb_model.joblib"):
    """加载已保存的模型。

    参数
    ----------
    model_path : str
        joblib 文件路径。

    找不到文件时直接抛出异常，由调用方决定如何降级。
    """
    return joblib.load(model_path)


def predict_risk(model, input_df: pd.DataFrame):
    """对单行样本输出故障概率。

    参数
    ----------
    model : 已训练模型
    input_df : DataFrame
        只允许一行，列名和顺序必须与训练特征一致。

    返回
    -------
    float，故障类别（标签 1）对应的概率。
    """
    expected = getattr(model, "feature_names_in_", None)
    if expected is not None and list(input_df.columns) != list(expected):
        raise ValueError(
            f"输入列与训练特征不一致：期望 {list(expected)}，实际 {list(input_df.columns)}"
        )
    if len(input_df) != 1:
        raise ValueError("input_df 必须是单行 DataFrame，实际 %d 行" % len(input_df))
    proba = model.predict_proba(input_df)[0]
    classes = list(model.classes_)
    index = classes.index(1) if 1 in classes else len(classes) - 1
    return float(proba[index])


def get_feature_importance(model, feature_names: list):
    """从树节点累加分裂增益，得到归一化后的特征重要性。

    HistGradientBoosting 没有 feature_importances_，这里遍历
    model._predictors 每棵树的 nodes 结构化数组，把非叶节点的 gain
    按 feature_idx 累加，最后除以总增益。

    返回 {特征名: 重要性}，合计约等于 1。
    """
    predictors = getattr(model, "_predictors", None)
    if not predictors:
        raise RuntimeError("模型没有可用的树结构，无法计算特征重要性")

    gains = np.zeros(len(feature_names), dtype=float)
    for stage in predictors:
        for tree in stage:
            nodes = tree.nodes
            mask = nodes["is_leaf"] == 0
            if not np.any(mask):
                continue
            idx = nodes["feature_idx"][mask].astype(int)
            np.add.at(gains, idx, nodes["gain"][mask])

    total = float(gains.sum())
    if total > 0:
        gains = gains / total
    return {name: float(value) for name, value in zip(feature_names, gains)}


def _evaluate(model, X_test, y_test):
    """打印测试集指标：ROC-AUC / Recall / Precision / 样本构成。"""
    y_pred = model.predict(X_test)
    try:
        y_prob = model.predict_proba(X_test)[:, list(model.classes_).index(1)]
    except (AttributeError, ValueError):
        y_prob = None

    print("\n---------- 测试集评估 ----------")
    if y_prob is not None and len(set(y_test)) > 1:
        print("ROC-AUC   ：%.4f" % roc_auc_score(y_test, y_prob))
    else:
        print("ROC-AUC   ：无法计算（测试集只有一个类别）")
    print("Recall    ：%.4f   （故障召回率）" %
          recall_score(y_test, y_pred, zero_division=0))
    print("Precision ：%.4f   （精确率）" %
          precision_score(y_test, y_pred, zero_division=0))
    print("测试集样本：%d（故障 %d，正常 %d）" %
          (len(y_test), int((y_test == 1).sum()), int((y_test == 0).sum())))
    print("--------------------------------")


if __name__ == "__main__":
    df_all, feature_cols, target_col = dataset_builder.build_feature_dataset()
    print("数据集：%d 行 × %d 列" % (df_all.shape[0], df_all.shape[1]))
    print("特征（%d 个）：%s" % (len(feature_cols), feature_cols))
    print("标签：%s" % target_col)

    X_train, X_test, y_train, y_test = dataset_builder.split_train_test(
        df_all, test_size=0.2, random_state=RANDOM_STATE
    )

    categorical_feature_names = ["type"]

    model = train_model(
        X_train, y_train, categorical_feature_names,
        save_path=MODEL_PATH, random_state=RANDOM_STATE,
        class_weight="balanced",
    )
    print("\n模型已训练并保存：%s" % MODEL_PATH)

    _evaluate(model, X_test, y_test)

    importance = get_feature_importance(model, feature_cols)
    print("\n---------- 特征重要性 ----------")
    for name, value in sorted(importance.items(), key=lambda kv: kv[1], reverse=True):
        print("  %-20s %.4f" % (name, value))

    sample = X_test.iloc[[0]].copy()
    risk = predict_risk(model, sample)
    print("\n---------- 单条工况预测 ----------")
    print(sample.to_string(index=False))
    print("故障风险概率：%.4f" % risk)
