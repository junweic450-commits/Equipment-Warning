"""两套模型（二分类风险 / 故障分类+剩余寿命）共用的训练登记口径。

这里只收「同一件事只写一遍」的几行：训练冷却的秒数与提示语、metrics_json
的解码。两边的上线状态机刻意不并进来——二分类那边还牵着 active_model.json
指针文件，「库里的状态」和「指针文件」两套真相没合并之前，硬合只会把差异藏起来。
"""
import json
import time

TRAIN_INTERVAL_SECONDS = 60      # 两次训练至少间隔这么多秒：连点不许把 CPU 占满


def wait_left(last_at, interval=TRAIN_INTERVAL_SECONDS):
    """距下一轮训练还差多少秒。last_at 是上一次训练的时刻（epoch 秒），没训过返回 0。

    返回的是「还剩多少」而不是「至少 0」：调用方靠正负判断能不能训，
    负数就是早就过了冷却期，别把它抹成 0 后再去算提示里的等待秒数。
    """
    if last_at is None:
        return 0.0
    return interval - (time.time() - float(last_at))


def cooldown_error(wait):
    """冷却期内的报错，两套模型共用同一句话；60 这个数只有上面那一处。"""
    return ValueError("两次训练至少间隔 %d 秒，请在 %d 秒后再试"
                      % (TRAIN_INTERVAL_SECONDS, int(wait) + 1))


def with_metrics(rows):
    """训练历史每行都要把 metrics_json 解成 metrics，两边同一份解码。"""
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["metrics"] = json.loads(d.pop("metrics_json") or "{}")
        except Exception:
            d["metrics"] = {}
        out.append(d)
    return out
