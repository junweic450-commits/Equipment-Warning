"""发布 / 回滚状态机专项：必须有一个「评估通过」的候选，才能真的走到这两条最高权限路由。

train_candidate 的保护阈值是按召回率比对的，现场数据不一定能让候选通过，
所以这里在隔离副本里把 evaluate_model 的结果固定成一份好指标，让流程真的走完：
训练 → 待审批 → 管理员发布 → 指针切换 → 回滚。只动 /tmp/pex/app（cwd 闸门先过）。
"""
import json
import os
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request

SRC = "/Users/junweichen/Desktop/合同提醒系统或平台/Equipment-Warning/设备风险预警平台"
APP = "/tmp/pex/app"
DB = os.path.join(APP, "data", "equipment.db")
PORT = open("/tmp/pex/PORT").read().strip()
B = "http://127.0.0.1:%s" % PORT
RESULTS = []

# ---- 闸门：当前进程必须在沙箱里，且端口上的服务也是沙箱 -------------------------
if os.path.realpath(os.getcwd()) != os.path.realpath(APP):
    sys.exit("✗ 请在 %s 下运行本脚本（当前 %s）" % (APP, os.getcwd()))
pid = subprocess.run(["lsof", "-nP", "-tiTCP:%s" % PORT, "-sTCP:LISTEN"],
                     capture_output=True, text=True).stdout.split()
cwd = subprocess.run(["lsof", "-a", "-p", pid[0], "-d", "cwd", "-Fn"],
                     capture_output=True, text=True).stdout
svc_cwd = next((l[1:] for l in cwd.splitlines() if l.startswith("n")), "")
if svc_cwd != os.path.realpath(APP):
    sys.exit("✗ 端口 %s 的服务 cwd=%s，不是沙箱 —— 禁止写测试" % (PORT, svc_cwd))
print("闸门 OK：沙箱 %s，服务与脚本都在里面（端口 %s）" % (APP, PORT))


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("%s %-52s %s" % ("PASS" if ok else "FAIL", name[:52], detail[:90]))


def call(method, path, body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(B + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.getcode(), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


sys.path.insert(0, APP)
os.chdir(APP)
import ai_model              # noqa: E402
import model_learning        # noqa: E402

# 清掉历史训练记录：既让版本号从零开始，也让训练冷却不拦住这一步
with sqlite3.connect(DB) as c:
    c.execute("DELETE FROM model_training_runs")

GOOD = {"accuracy": 0.95, "precision": 0.9, "recall": 0.9, "f1": 0.9, "roc_auc": 0.95}
ai_model.evaluate_model = lambda model, x, y: dict(GOOD)   # 固定指标，稳定走进 passed 分支
before = set(os.listdir(os.path.join(APP, "models"))) if os.path.isdir(os.path.join(APP, "models")) else set()
try:
    res = model_learning.train_candidate(os.path.join(APP, "histgb_model.joblib"))
except ValueError as exc:
    sys.exit("训练通道本身跑不起来：%s" % exc)
after = set(os.listdir(os.path.join(APP, "models")))
version = res["version"]
check("评估通过后进入待审批而不是直接上线", res["passed"] and res["status"] == "pending_approval"
      and res["published"] is False, json.dumps({k: res[k] for k in ("version", "status")}, ensure_ascii=False))
new_files = after - before
check("通过的候选恰好落一个模型文件", len(new_files) == 1, str(sorted(new_files)))
created = [os.path.join(APP, "models", f) for f in sorted(new_files)]

pointer = os.path.join(APP, "models", "active_model.json")
pointer_before = open(pointer).read() if os.path.exists(pointer) else None


open("/tmp/pex/ui-candidate.json","w").write(json.dumps({"version":version}))
