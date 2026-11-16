# 煤矿排水设备故障风险预警平台 · Equipment-Warning

一句话：把井下排水设备的台账、遥测和现场填报合成一个风险分，告诉你**今天该管哪几台、为什么高、怎么降、什么时候检修**，并能就结果追问大模型。零构建、单机能跑、局域网可访问。

代码目录：`设备风险预警平台/`（本仓库根目录下的同名文件夹，双击其中的 `启动.command` 即可运行）。

---

## 快速开始

```bash
cd 设备风险预警平台
.venv/bin/python dashboard.py                              # 启动并自动打开浏览器
.venv/bin/python dashboard.py --no-browser --port 8770      # 只起服务
.venv/bin/python dashboard.py --lan                         # 额外打印局域网地址
```

- 环境：macOS。仓库里**不含 `.venv`**，第一次跑先建一次：
  `cd 设备风险预警平台 && python3 -m venv .venv && .venv/bin/pip install pandas scikit-learn`。
  开发机实测版本：Python 3.14.7 / pandas 3.1.1 / scikit-learn 1.9.1 / numpy 2.5.4。
  没有 `.venv` 时 `启动.command` 会退回系统 `python3`，前提是它装了 pandas 和 scikit-learn。
- 端口：默认 `8770`；被占用时自动往后试 10 个，**以启动时打印的 URL 为准**。
- 停止：`Ctrl+C`。页面每 15 秒自动刷一次，台账增删改、工况校准、巷道温度改完，下一轮刷新即生效。

## 三个页面怎么分工

| 路径 | 名称 | 这一页只干什么 | 列表变长时 |
|---|---|---|---|
| `/` | 风险概览 | 统计条 + 设备卡片（按风险从高到低），每张卡片上是单台「AI 解读」「校准工况」入口 | 每页 12 台，可翻页 |
| `/risk` | 智能分析 | 共性归因、治理方案、**带日期的检修排期**、一台一台看、让 AI 补充建议 | 表格暂为全量（见待办） |
| `/devices` | 设备台账 | 完整表格（搜索 / 按分级筛 / 增删改）+ 巷道基准温度维护 | 每页 24 行，可翻页 |

分页两处共用一套控件：每页 12 / 24 / 48 / 100 可选，页码窗口在当前页两侧折叠，15 秒轮询重绘不会跳回第一页，删设备或筛选变窄导致页码越界时自动收到最后一页。首页不再重复放分析面板，`/risk` 也不再重复放台账和温度配置。

## 风险是怎么算出来的

两路独立合成，`risk = 1 − (1 − raw_risk) × (1 − cond_risk)`：

- **设备本身（raw_risk）**：`histgb_model.joblib`（HistGradientBoosting）吃 9 个物理量——类型、额定电压/电流/功率、环境温度、设备温度、电流、累计运行小时、距上次检修小时。模型文件缺失时只用工况评级，页面会红字提示。
- **现场情况（cond_risk）**：7 项加权——环境严酷度 18%、湿度 22%、粉尘 16%、淋水 6%、近三个月故障 20%、检修频率不足 12%、负载率 6%。这一路可以精确重算，所以「把粉尘降一级，风险从 44% 降到 36%」这类结论是真数字，不是估的。
- 分级：正常 / 关注 / 预警 / 报警 / 无数据，阈值集中在 `ai_analyze.py` 的 `TH` 里，便于和工艺人员一起校订。
- 检修排期日期：报警=今天起 3 天内，预警=14 天内，关注=按每台自己的「计划检修频率(次/季)」与「距上次检修小时」倒推到期日（区间取最早—最晚，已过期的另标"N 台已到期"），无遥测的不给日期。

## 数据与配置文件

| 文件 | 内容 | 本机 `.gitignore` |
|---|---|---|
| `data/equipment.db` | SQLite：`equipment`（台账）、`run_simulation_log`（遥测）、`calibration_log`（校准留痕） | 排除 |
| `sim_config.json` | 巷道基准温度、湿度/粉尘基准、仿真参数 | 未排除（现场配置，按需） |
| `calibration.json` | 单台工况校准的覆盖值 | 排除 |
| `histgb_model.joblib` | 风险预测模型 | 未排除（随代码走） |
| `agent_config.json` | 云知声 MaaS 的 Key 与模型名（当前 `u2-flash`），文件权限 600 | **排除** |

大模型只用于「AI 解读 / 智能问答 / 补充建议」，不参与任何判级；Key 只在服务端读取，接口与页面响应里都不会出现（48 项探针里有专门一条验证）。遥测目前是 `dataset_builder.py` 生成的仿真数据；接现场 PLC/IoT 时，只要按同一张表写入 `run_simulation_log` 即可，上层不用改。

## 重要：密钥和真实台账已经进了 GitHub 仓库

`项目根目录/设备风险预警平台/.gitignore` 写明了 `data/`、`agent_config.json`、`access.log`、`calibration.json` 不入库，但**这个 GitHub 仓库的副本目录里没有 `.gitignore`**，而且已推送的 `origin/main`（提交 `38632c0 Add files via upload`）中确实包含：

- `设备风险预警平台/agent_config.json` —— 里面有非空的 `api_key`；
- `设备风险预警平台/data/equipment.db` 及 `-shm` / `-wal` —— 真实台账与遥测；
- `设备风险预警平台/access.log`、`calibration.json`、`__pycache__/*.pyc`。

也就是说，云知声 Key 和现场台账已经躺在 GitHub 服务器端的历史提交里。**目前这个仓库是私有的**（匿名访问 `api.github.com/repos/junweic450-commits/Equipment-Warning` 返回 404，带凭据的 `git ls-remote` 能读到 `refs/heads/main`），所以还没到全网泄露；但只要改成 public、加协作者、或者被第三方 App 授权读取，Key 和数据就立刻暴露。处理顺序（涉及改历史和强推，需要你先确认再做）：

1. **轮换 Key**（最先做，和仓库怎么处理无关）：云知声控制台生成新 Key，旧 Key 作废；新 Key 只写本机 `agent_config.json`，权限 600。旧 Key 还曾经在本机对话里明文出现过，两个理由叠在一起。
2. **补 `.gitignore`**：把这份文件从开发主目录拷到仓库根目录（内容一样，排除 `data/`、`agent_config.json`、`access.log`、`calibration.json`、`__pycache__/`），然后 `git rm --cached` 停止跟踪这些路径——注意用 `--cached`，只脱管不删本地文件，真实台账必须留在本机。
3. **清历史**：第 2 步只让最新版干净，密钥仍在 `38632c0` 里，需要 `git filter-repo`（或 BFG）重写历史后再强推；不想碰历史的话，替代做法是新建一个只含源码的干净仓库，旧仓库直接删掉。
4. **确认可见性**：现在是 private，就别再改 public；如果有第三方 OAuth 授权过这个仓库，一并撤销。

## 接口一览

`GET /api/state`、`GET /api/analysis?code=编码`（不带 code 为全局）、`GET /api/agent/status`；
`POST /api/device`、`/api/device/delete`、`/api/env`、`/api/env/delete`、`/api/env/default`、`/api/calibration`、`/api/calibration/reset`、`/api/agent/chat`（SSE 流式）。
入参统一校验：编号字符集与长度、名称长度与控制字符、电压电流必须 > 0、日期须是合法日历日、巷道温度范围，非法一律 400 且不影响后续请求。

## 当前进度（截至 2026-11-16）

已交付：三页职责重划分与去重；首页卡片 / 台账表格分页；「什么时候检修」带具体日期并同步喂给大模型；单台 AI 解读抽屉与问答抽屉（关闭按钮已修）；只保留套餐 Key 一条通道、旧协议代码删除；返回键与其 sessionStorage 栈移除；Host 白名单、静态路由越权拦截、SSE 空正文降级等一批安全加固。

验证方式与结果：

| 项目 | 方法 | 结果 |
|---|---|---|
| 旧接口未回归 | 35 条路由快照与基线逐字段比对 | 仅 1 处预期差异（首页 HTML 变短） |
| AI 链路 | 48 项探针（含真实调用、SSE、密钥不外泄） | 48/48 通过 |
| 安全 | 29 项写类与协议探针 | 29/29 通过 |
| 功能 | 17 项边界/并发探针 | 17/17 通过 |
| 排期日期 | 12 项单测（跨月跨年、逾期、缺填报兜底） | 12/12 通过 |
| 空正文降级 | 3 项单测 | 3/3 通过 |
| 页面 | 390 / 768 / 1280 三档宽度实测翻页、筛选、溢出、控制台 | 无横向溢出、无报错，返回键元素为 0 |

## 已知边界与待办

- 服务监听 `0.0.0.0` 且免登录，是按"局域网要用"的要求保留的；**不要直接暴露到公网**，需要时前置反代加认证。
- 单机 SQLite，没有多用户与权限体系；台账并发写入做了文件锁与串行化，但不做跨机器同步。
- 待办（按优先级）：**密钥与台账脱管**（见上面「重要」一节，4 步）＞ `/risk` 的「一台一台看」接同一套分页 ＞ 单台「AI 解读」里的检修建议直接显示到期日 ＞ `LP-001` 粉尘填报值 2 还是 3 待现场确认 ＞ `equipment_db.py` 里 f-string 拼列名处加白名单校验。

## 目录结构

```
Equipment-Warning/
├── README.md
└── 设备风险预警平台/
    ├── dashboard.py          入口：静态页 + API + 风险合成（stdlib http.server，无框架）
    ├── ai_analyze.py         本地规则分析引擎：归因、方案、排期、大模型上下文
    ├── ai_model.py           模型训练与加载（HistGradientBoosting）
    ├── dataset_builder.py    仿真数据生成（离线，不在请求路径里）
    ├── equipment_db.py       台账 SQLite 读写
    ├── agent_gateway.py      云知声 MaaS 通道（SSE 转发与降级）
    ├── index.html risk.html devices.html
    ├── assets/               common.js（状态+分页+抽屉） analysis.js chat.js app.css page-*.js
    ├── sim_config.json calibration.json histgb_model.joblib 启动.command
    └── data/equipment.db     运行数据（开发机的 .gitignore 里排除，本仓库却被推送了——见上面的泄露说明）
```
