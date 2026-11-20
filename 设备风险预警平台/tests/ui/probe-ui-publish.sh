#!/bin/bash
set -euo pipefail
cd /tmp/pex/app
"/Users/junweichen/Desktop/合同提醒系统或平台/Equipment-Warning/设备风险预警平台/.venv/bin/python" /tmp/pex/seed_ui_candidate.py
/opt/homebrew/bin/node /tmp/pex/probe-ui-publish.mjs
