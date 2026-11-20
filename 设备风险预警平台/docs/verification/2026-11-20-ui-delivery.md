# 页面重组交付记录

## 实现范围

- 风险概览：风险看板、归因与治理；旧 `/risk`、`/risk.html` 返回 302。
- 今日核查：风险设备核查、运行样本反馈，共用现有反馈 API。
- 设备台账：设备信息、维护日志、环境基准。
- 模型训练：状态与训练、训练数据、最可能故障与剩余寿命、迭代历史与发布审批。
- 四个长列表沿用已实现的客户端分页；切页签不取数，URL hash 可直接定位。
- 两种模型的审批状态机保持独立。事件/反馈跨页更新后，训练页使用「刷新数据」显式取新状态，不增加定时请求。
- 核查保存后刷新同页样本；智能助手打开时随页签更新上下文。
- 修复事件面板先于台账返回时设备列表空白的问题；同步选项时保留编辑内容。手机页头为标题和徽章留出独立空间。
- 旧页面与脚本已移入废纸篓；未提交 Git。

## 控件—接口—落库

下表列出业务控件；页签、分页、抽屉开关均只操作浏览器状态，不写库。GET `/api/state` 会按既有逻辑采集预测反馈样本，因此只读展示也可能更新 `model_feedback_samples`。

| 页面 / 页签 | 控件 | METHOD path | 写入目标 | 验证方法 |
|---|---|---|---|---|
| 概览 / 看板 | 加载、刷新 | GET /api/state；GET /api/health-models | 预测采集可能写 model_feedback_samples | 页面/接口回归、真实库前后比对 |
| 概览 / 看板、台账 | 保存/重置校准 | POST /api/calibration；POST /api/calibration/reset | calibration_log、校准配置 | 控件测试、重算结果回读 |
| 概览 / 归因 | 重新分析 | GET /api/analysis | 不直接写库（状态计算可能采集预测） | probe-reanalyze |
| 概览 / 归因 | 导出风险/治理/排期 | GET /api/export?type=devices/actions/plan | 不直接写库 | crosslink、CSV 回读 |
| 全站 | 智能问答、补充建议 | GET /api/agent/status；POST /api/agent/chat | 不写业务库 | qa-final、空回答测试 |
| 核查 / 风险设备 | 加载、保存结论 | GET /api/daily-report；POST /api/daily-report | daily_risk_reports；反馈同步 model_feedback_samples | controls-new：保存后 API 回读 |
| 核查 / 风险设备 | 打印 | 浏览器 window.print | 不写库 | 打印媒体下仅核查面板可见 |
| 核查 / 样本 | 筛选、刷新 | GET /api/model-center?status=… | 不写库 | pages、s3-ui |
| 核查 / 样本 | 保存反馈 | POST /api/model-feedback | model_feedback_samples；确认类型时关联 fault_events | s3-ui：回执、筛选、回读 |
| 台账 / 设备信息 | 新增、编辑、删除 | POST /api/device；POST /api/device/delete | equipment | controls-new、API 回读 |
| 台账 / 设备信息 | 模板、预检、确认导入 | GET /api/device/template.csv；POST /api/device/import | 预检不写；确认写 equipment、相关遥测/校准 | import、controls-new |
| 台账 / 维护日志 | 解析、确认导入 | POST /api/work-log/parse；POST /api/work-records/confirm | 解析不写；确认写 work_records | controls-new、pages |
| 台账 / 维护日志 | 检索、编辑、删除 | GET /api/work-records；POST /api/work-records/update、/delete | work_records | pages、控件与回读 |
| 训练 / 训练数据 | 切换、筛选、刷新 | GET /api/fault-events；GET /api/lifecycle | 不写库 | events、pages |
| 训练 / 训练数据 | 新增、编辑、删除 | POST /api/fault-events、/update、/delete；POST /api/lifecycle、/update、/delete | fault_events / device_lifecycle | events、s4-ui |
| 训练 / 训练数据 | 模板、预检、确认导入 | GET /api/fault-events/template.csv、/api/lifecycle/template.csv；POST 各自 /import | 预检不写；确认写对应事件表 | import、controls-new |
| 台账 / 环境基准 | 添加、保存、删除、默认温度 | POST /api/env、/api/env/delete、/api/env/default | sim_config.json，不写业务表 | controls-new、配置回读 |
| 训练 / 状态与训练 | 刷新、训练 | GET /api/model-center；POST /api/model-train | model_training_runs、候选模型文件 | 模型/API/训练控件回归 |
| 训练 / 故障与寿命 | 训练、批准、回滚 | POST /api/health-model-train、/api/health-model-publish、/api/health-model-rollback | health_model_runs、模型文件 | s4、publish-flow |
| 训练 / 历史审批 | 批准、回滚 | POST /api/model-publish、/api/model-rollback | model_training_runs、models/active_model.json | publish-flow、controls-new |

## 历史待办的处理

| Task | 结果 |
|---|---|
| 1 页签原语 | 已存在；本轮扩到四页，补清空 hash 的回退与助手上下文同步 |
| 2 四个长列表分页 | 已存在；本轮验证新宿主页面、失败态清理与刷新保留页号 |
| 3 台账四签 | 保留已实现内容与未提交修正；验证事件脚本与训练中心解耦 |
| 4 今日核查 | 样本区完整迁入，共享脚本渲染器有容器守卫；打印只出核查内容 |
| 5 风险概览 | 归因整段迁入，导出与重新分析保留，四项导航与旧地址 302 |
| 6 模型训练 | 三签完成，提示文案仍用单一来源；CF-9 采用明确的手动刷新语义 |
| 7 回归与交付 | 全量回归、截图检查、正式实例验证的结果见下方 |

文档中的各 Task 提交步骤没有执行；改动保留为可审查的工作区差异。

## 验证结果

共 30 组隔离测试，1001 项显式断言通过，最终失败 0。无 PASS/FAIL 词表的诊断脚本同时检查了实际输出：响应式无遮挡/横向溢出，重新分析有时间与结果回显，500 响应不泄露内部异常且日志保留堆栈。

正式实例 8770 已重启（PID 27418），四个 HTML 和关键脚本均与磁盘逐字节一致。四页浏览器只读检查、两条旧地址 302 和控制台检查共 7 项通过。

真实库业务表逐表逻辑哈希与本轮操作前一致：设备 4 台、遥测 11,520 行、校准日志 51 行（基线前 42 行完整）。写类测试只落沙箱。

首轮发现并解决的问题：事件设备选项早于台账返回时未更新；手机标题/徽章重叠；核查合并后的测试容器范围与样本刷新入口；同文档切签后 hover 位移影响浮标坐标测试；导航项数改动时误改的统计/图例数量断言已恢复。对应测试已定向复跑通过，未降低业务断言。

审批 UI 分支使用沙箱内固定评估指标生成候选，证明发布/回滚流程可用，不把这个结果作为模型质量结论。真实训练及拒绝不合格候选另由原有模型测试覆盖。

[逐组结果](2026-11-20-test-results.json) · [可复用探针](../../tests/ui/README.md)。完整临时日志位于 `/tmp/pex/logs`。

| 探针 | 通过 | 失败 |
|---|---:|---:|
| t_s1_db.py | 18 | 0 |
| t_s2_models.py | 57 | 0 |
| probe-s3.py | 34 | 0 |
| probe-s4.py | 43 | 0 |
| test_publish_flow.py | 12 | 0 |
| probe-events.py | 60 | 0 |
| probe-import.py | 61 | 0 |
| probe-newapi.py | 81 | 0 |
| probe-controls-new.mjs | 78 | 0 |
| probe-s3-ui.mjs | 21 | 0 |
| probe-s4-ui.mjs | 14 | 0 |
| probe-vuln-newpages.mjs | 40 | 0 |
| probe-xss-ui.mjs | 58 | 0 |
| probe-tabs.mjs | 64 | 0 |
| probe-uimove.mjs | 67 | 0 |
| probe-pages.mjs | 67 | 0 |
| probe-crosslink.mjs | 18 | 0 |
| probe-ui-delivery.mjs | 40 | 0 |
| test_empty_answer.py | 3 | 0 |
| test_500_redaction.py | 0 | 0 |
| probe-drawer.mjs | 0 | 0 |
| probe-drawer-stack.mjs | 0 | 0 |
| probe-mobile-drawers.mjs | 7 | 0 |
| probe-fab-allpages.mjs | 23 | 0 |
| probe-qa-final.mjs | 27 | 0 |
| probe-responsive.mjs | 0 | 0 |
| probe-reanalyze.mjs | 0 | 0 |
| audit.mjs | 67 | 0 |
| live-smoke.mjs | 28 | 0 |
| probe-ui-publish.sh | 13 | 0 |

## 截图

- [桌面归因与治理](screenshots/overview-analysis.png)
- [模型训练](screenshots/model-training.png)
- [手机样本反馈](screenshots/mobile-feedback.png)
- [手机事件录入](screenshots/mobile-events.png)

