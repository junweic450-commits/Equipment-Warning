# 页面重组回归探针

这些探针配合本机已有 `/tmp/pex` 隔离测试环境运行，不可将 `BASE` 指向正式实例。需要 Node 22+（`node:sqlite`、原生 WebSocket）、Google Chrome 和项目 Python 虚拟环境。

先将本目录文件复制到 `/tmp/pex/`，保留该目录原有的 `srv.sh`、`run_suite.sh`、隔离数据库基线和写操作环境闸门。`srv.sh` 必须使用当前源码并排除已删除的 `risk.html` 和 `assets/page-risk.js` 的静态比对。

```bash
PATH=/opt/homebrew/bin:$PATH bash /tmp/pex/run_suite.sh \
  probe-tabs.mjs probe-uimove.mjs probe-pages.mjs probe-crosslink.mjs \
  probe-ui-delivery.mjs probe-ui-publish.sh
```

- `probe-tabs`：四页落签、键盘、非法 hash、无重复请求。
- `probe-uimove`：各面板容器与控件归属、深链冷启动。
- `probe-pages`：四个长列表的真实分页、筛选复位、刷新保页、失败态，以及模型训练页的设备筛选异步补齐。
- `probe-crosslink`：旧地址 302、四项导航、站内链接。
- `probe-ui-delivery`：11 个面板在 1440/390 宽度下的布局、截图、启动幂等、打印、助手上下文及训练数据设备选项同步。
- `probe-ui-publish.sh`：先校验沙箱服务 cwd，再用固定评估指标生成待审批候选（只为覆盖审批分支，不代表模型质量通过），随后用浏览器真实点击审批、回滚、事件文件预检和导入，并通过 API 回读。

原有 API/安全/抽屉等回归结果及控件映射见 `../../docs/verification/2026-11-20-ui-delivery.md`。本目录不包含真实台账、模型副本或密钥。
