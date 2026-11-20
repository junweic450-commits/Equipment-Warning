#!/bin/bash
# 逐个探针跑一遍，每个都从"干净台账"起步，避免上一个探针写的数据骗过下一个。
# 完整输出落在 /tmp/pex/logs/，这里只报计数与结论，别用 grep 的"没输出"当成"通过"。
#   usage: ./run_suite.sh security_probe.py bug_probe_now.py ...
set -uo pipefail
cd /tmp/pex
PY="/Users/junweichen/Desktop/合同提醒系统或平台/Equipment-Warning/设备风险预警平台/.venv/bin/python"
mkdir -p logs
result=0
for probe in "$@"; do
  PORT=8791 RESET_DB=1 ./srv.sh >/tmp/pex/logs/_rebuild.log 2>&1 || { echo "!! $probe 前重建实例失败"; tail -5 /tmp/pex/logs/_rebuild.log; result=1; continue; }
  P=$(cat /tmp/pex/PORT)
  if [[ "$probe" == *.py ]]; then
    # python 探针在沙箱目录里跑：test_publish_flow.py 这类会自己校验 cwd 必须是
    # /tmp/pex/app（防止误打真实实例），而本脚本平时停在 /tmp/pex，之前直接被它的
    # 闸门拒掉、结论无效。子 shell 里 cd，不影响本脚本自身。
    ( cd /tmp/pex/app && PORT=$P "$PY" "/tmp/pex/$probe" "$P" ) > "logs/$probe.log" 2>&1; rc=$?
  elif [[ "$probe" == *.sh ]]; then
    # .sh 是「一条链子」的包装（例如先造数据再验浏览器），端口从 /tmp/pex/PORT 自己读
    PORT=$P bash "$probe" > "logs/$probe.log" 2>&1; rc=$?
  else
    PORT=$P node "$probe" > "logs/$probe.log" 2>&1; rc=$?
  fi
  # PASS/FAIL 按"整词"匹配：上一版 ^(FAIL|  FAIL) 把汇总行「FAILURES: 0」也数成
  # 一条失败，看起来就是"全绿却报 1 个 FAIL"。
  pass=$(grep -cE '^(PASS|  PASS)( |$)' "logs/$probe.log")
  fail=$(grep -cE '^(FAIL|  FAIL)( |$)' "logs/$probe.log")
  # audit.mjs 这类只打 JSON 的探针：结论以 JSON 里的 failed 为准。上一版它 exit=0
  # 又没有 PASS/FAIL 行，14 条失败被"没有输出"当成通过，真 bug 就是这么漏掉的。
  jf=$(grep -oE '"failed":[[:space:]]*[0-9]+' "logs/$probe.log" | tail -1 | tr -dc '0-9')
  jt=$(grep -oE '"total":[[:space:]]*[0-9]+' "logs/$probe.log" | tail -1 | tr -dc '0-9')
  if [ -n "$jf" ]; then fail="$jf"; [ -n "$jt" ] && pass=$((jt - fail)); fi
  printf '%-26s exit=%s PASS=%s FAIL=%s\n' "$probe" "$rc" "$pass" "$fail"
  if [ "$fail" = "0" ] && [ "$pass" = "0" ]; then
    if [ "$rc" != "0" ]; then
      echo "   !! 探针非零退出却没有任何 FAIL 行（多半是中途抛异常），最后几行："
      tail -6 "logs/$probe.log" | sed 's/^/   | /'
    else
      echo "   （这份探针不用 PASS/FAIL 词表，看结论行：）"
      tail -4 "logs/$probe.log" | sed 's/^/   | /'
    fi
  fi
  if [ "$rc" != "0" ] || [ "$fail" != "0" ]; then result=1; fi
  grep -E '^(FAIL|  FAIL)( |$)' "logs/$probe.log" | head -6 || true
done
exit "$result"
