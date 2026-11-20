/* ==========================================================================
   analysis.js · 智能分析控件（本地规则引擎结果的前端呈现）
   只有一种形态：data-ai="full"，落在风险概览的第二个页签。首页原来的摘要态已删掉，
   首页只保留每张卡片上的「AI 解读」按钮（走下面的单台抽屉）。
   单台解读抽屉由卡片和台账行里的「AI 解读」共用 openDevice。

   整个文件包在 IIFE 里：三个脚本同为经典 <script>，顶层 function 会挂到全局
   互相覆盖（chat.js 后加载，它的 refreshStatus 曾经把这里的同名函数顶掉，
   状态灯因此一直是空白）。对外只暴露 window.SmartAnalysis。
   ========================================================================== */
"use strict";

(function(){

const AI = {
  global: null,
  agent: {ready: false, model: "", reason: ""},
  loading: false,
  error: "",
  flash: "",
  filter: "全部",
};

const PRI_ALL = ["全部", "高", "中", "低"];

/* 后端 ai_analyze.PLAIN_ITEM 的前端镜像。cond_items 的 name 是数据口径（校准表、
   权重表都用它），界面上换成班组里说的话；两边同名项要一起改。 */
const PLAIN_ITEM = {
  "环境严酷度": "环境差", "湿度等级": "潮湿", "粉尘等级": "粉尘多", "淋水": "顶板淋水",
  "近三个月故障次数": "最近坏得多", "检修频率不足": "检修太少", "负载率超标": "超负荷",
};

function aiEsc(v){ return App.esc(v); }

/* 台账/校准值可能是 2.0 这种浮点写法，现场看着像"两点点零"，收成整数 */
function num(v){
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(2))) : String(v);
}

function pct(v, d){
  if (v === null || v === undefined) return "—";
  return (Number(v) * 100).toFixed(d === undefined ? 1 : d) + "%";
}

function levelColor(key){
  return {green: "var(--green)", yellow: "var(--yellow)", orange: "var(--orange)",
          red: "var(--red)", gray: "var(--gray)"}[key] || "var(--gray)";
}

/* ---------------------------------------------------------------- 外壳 */
/* 状态灯在渲染时就写好内容，不依赖渲染后再补一轮 refreshStatus——
   这样即使某次刷新时机错位，面板上也不会出现空白状态位。 */
function panelShell(inner){
  return `<div class="ai-panel${AI.loading ? " busy" : ""}">
    <div class="ai-hd">
      <span class="ai-tag">✦ 智能分析</span>
      <span class="hint" style="margin:0">现场看板同一套数字算出来的，不是估的</span>
      <span class="ai-round" data-ai-round>${roundHTML()}</span>
      <span class="ai-status" data-ai-status>${statusHTML()}</span>
    </div>
    ${inner}
  </div>`;
}

/* 「这一轮」必须有个可比对的锚点。重新分析跑完，如果页面上没有任何一个数字变，
   点的人就没法区分"算过了、这轮确实一样"和"按钮根本没生效"，所以把分析时间摆出来：
   它是服务端这一轮 _state() 的时间，每点一次必然变。 */
function roundHTML(){
  if (AI.loading) return `<i class="spin"></i>正在重新分析…`;
  if (AI.error) return `<i class="off"></i>本轮失败：${aiEsc(AI.error)}`;
  const ts = AI.global && AI.global.ts;
  if (!ts) return "";
  const clock = String(ts).slice(11) || String(ts);
  return `本轮数据 ${aiEsc(clock)}`;
}

function shortReason(msg){
  /* 状态位要一眼能读懂：上游原文很长（带充值链接和括号说明），
     这里挑最具行动指向的说法，完整原因仍在下面的 Agent 补充建议块里原样保留。 */
  const t = String(msg || "");
  if (/欠费|余额不足/.test(t)) return "账号欠费，充值后自动恢复";
  if (/限流|429/.test(t)) return "问得太快被限速，稍后再试";
  if (/超时/.test(t)) return "回应太慢，超时了";
  if (/无法连接|DNS|Connection/.test(t)) return "连不上 AI 服务";
  const head = t.replace(/[（(][^）)]*[）)]/g, "").replace(/https?:\S+/g, "")
                .replace(/\s+/g, " ").trim();
  return head.length > 22 ? head.slice(0, 22) + "…" : (head || "AI 服务异常");
}

function statusHTML(){
  const a = AI.agent;
  if (!a.ready) {
    return `<i class="off"></i>问答没接上 · ${aiEsc(a.reason || "没配置")}`;
  }
  /* 配置齐了不代表上游能出答案：欠费 / 限流 / 模型未开通只有真调用才知道，
     所以把最近一次调用的结果也体现在状态灯上，避免"显示已接入却每次都失败"。 */
  if (a.last_ok === false) {
    return `<i class="off"></i>问答这次没成功 · ${aiEsc(shortReason(a.last_error))}`;
  }
  if (a.last_ok === null || a.last_ok === undefined) {
    return `<i class="on"></i>问答可用 · ${aiEsc(a.model)}（还没试过）`;
  }
  return `<i class="on"></i>问答已接入 · ${aiEsc(a.model)}`;
}

function refreshStatus(){
  document.querySelectorAll("[data-ai-status]").forEach(el => { el.innerHTML = statusHTML(); });
  const btn = App.byId("aiAdvBtn");
  if (btn) btn.disabled = !AI.agent.ready;
}

/* ---------------------------------------------------------------- 重新分析按钮 */
/* 按钮在 [data-ai] 之外，面板重绘不会碰它，所以它的高亮/文案由这里单独维护；
   面板里的「本轮数据 hh:mm:ss」负责证明这一轮确实重新算过。 */
let refreshBtn = null;
let flashTimer = null;

function paintRefreshBtn(){
  const el = refreshBtn || App.byId("btnReanalyze");
  if (!el) return;
  el.disabled = AI.loading;
  el.textContent = AI.loading ? "分析中…" : (AI.flash || "重新分析");
  el.classList.toggle("done", !AI.loading && !!AI.flash);
}

function flashDone(){
  const ts = AI.global && AI.global.ts;
  AI.flash = ts ? "已更新 " + String(ts).slice(11) : "已更新";
  paintRefreshBtn();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { AI.flash = ""; paintRefreshBtn(); }, 4000);
}

/* ---------------------------------------------------------------- 数字条 */
function numsHTML(g){
  const c = g.counts || {};
  return `<div class="ai-nums">
    <div class="ai-num"><b>${g.total}</b>设备台数</div>
    <div class="ai-num"><b style="color:${levelColor("red")}">${c.red || 0}</b>报警</div>
    <div class="ai-num"><b style="color:${levelColor("orange")}">${c.orange || 0}</b>预警</div>
    <div class="ai-num"><b style="color:${levelColor("yellow")}">${c.yellow || 0}</b>关注</div>
    <div class="ai-num"><b>${pct(g.mean_risk)}</b>平均风险</div>
    ${g.no_data ? `<div class="ai-num"><b style="color:var(--gray)">${g.no_data}</b>没数据</div>` : ""}
  </div>`;
}

/* ---------------------------------------------------------------- 列表项 */
function actionItem(a){
  return `<li class="ai-item" data-pri="${aiEsc(a.priority)}">
    <div class="t"><span class="pri" data-pri="${aiEsc(a.priority)}">${aiEsc(a.priority)}</span>
      <span class="kind">${aiEsc(a.kind)}</span>${aiEsc(a.title)}</div>
    ${a.detail ? `<div class="d">${aiEsc(a.detail)}</div>` : ""}
    ${a.expect ? `<div class="e">${aiEsc(a.expect)}</div>` : ""}
  </li>`;
}

/* 列表里的排期：落在哪个窗口 + 哪天到期。正常级不进排期，留空比写「无」干净 */
function planCell(p){
  if (!p || !p.window) return "—";
  const due = p.dates ? `${aiEsc(p.dates)}${p.overdue ? "（已到期）" : ""}` : "";
  return `<span class="kind">${aiEsc(p.window)}</span>${due ? ` ${due}` : ""}`;
}

/* ---------------------------------------------------------------- 完整态 */
function fullHTML(g){
  /* 「一台一台看」的设备会一直往台账里加，一次全铺完没法看，所以复用首页/台账那套
     分页控件（每页条数、上一页下一页、页码窗口都是同一份代码，翻页由 common.js
     的 bindPager 接住，再通过 onRender 回调重画这一块）。 */
  const briefs = g.briefs || [];
  const pg = App.paginate(briefs, "ai");
  const rows = pg.rows.map(d => `<tr id="dev-${aiEsc(d.code)}">
      <td>${aiEsc(d.code)}</td><td>${aiEsc(d.name)}</td><td>${aiEsc(d.location || "-")}</td>
      <td style="color:${levelColor({正常: "green", 关注: "yellow", 预警: "orange", 报警: "red"}[d.level] || "gray")};font-weight:700">${aiEsc(d.level)}</td>
      <td>${pct(d.risk, 2)}</td><td>${pct(d.cond_risk, 2)}</td>
      <td>${aiEsc(d.main_cause)}</td>
      <td>${planCell(d.plan)}</td>
      <td><button class="btn ai small" data-act="ai" data-code="${aiEsc(d.code)}">解读</button></td>
    </tr>`).join("");

  const patterns = (g.patterns || []).map(p =>
    `<li class="ai-item"><div class="t">${aiEsc(p.name)}<span class="kind">${p.count} 台</span></div>
      <div class="d">${aiEsc(p.note)}</div></li>`).join("");
  const factors = (g.common_factors || []).map(f =>
    `<li class="ai-item"><div class="t">${aiEsc(PLAIN_ITEM[f.name] || f.name)}<span class="kind">${f.count} 台都这样</span></div>
      <div class="d">现在填 ${aiEsc(f.now || f.note)}，这一项占 ${pct(f.weight, 0)}</div>
      ${f.drop ? `<div class="d">一起降一档（${aiEsc(f.changes)}），平均风险 ${
          pct(f.mean_before)} → ${pct(f.mean_after)}</div>` : ""
      }</li>`).join("");
  const envs = (g.env_issues || []).map(e =>
    `<li class="ai-item"><div class="t">${aiEsc(e.tunnel)}<span class="pri" data-pri="${aiEsc(e.level)}">${aiEsc(e.level)}</span></div>
      <div class="d">${aiEsc(e.note)}</div></li>`).join("");
  const plan = (g.plan || []).map(p =>
    `<li class="ai-item"><div class="t">${aiEsc(p.window)}<span class="kind">${p.count} 台</span>
      ${p.dates ? `<span class="due">${aiEsc(p.dates)}</span>` : ""}</div>
      <div class="d">${aiEsc(p.reason)}${
        p.overdue ? `；其中 ${p.overdue} 台按计划检修周期已经到期` : ""}</div>
      <div class="d">${aiEsc(p.codes.join("、"))}</div></li>`).join("");

  return panelShell(`
    <p class="ai-headline">${aiEsc(g.headline)}</p>
    ${numsHTML(g)}
    ${g.model_ready === false ? `<div class="warn">模型文件没找到，现在只按现场填报的情况评级。</div>` : ""}
    <div class="ai-cols">
      <div class="ai-block"><h5>一起出问题的地方</h5><ul class="ai-list">${patterns ||
        `<li class="ai-item"><div class="d">没发现哪条巷道、哪一型集中偏高。</div></li>`}</ul></div>
      <div class="ai-block"><h5>多台都有的问题</h5><ul class="ai-list">${factors ||
        `<li class="ai-item"><div class="d">没有多台共有的大问题。</div></li>`}</ul></div>
      <div class="ai-block"><h5>巷道温度</h5><ul class="ai-list">${envs ||
        `<li class="ai-item"><div class="d">巷道基准温度都在范围内。</div></li>`}</ul></div>
      <div class="ai-block"><h5>什么时候检修</h5>
        <p class="hint">期限按看板这一轮的时间算；「下次检修」那档不是拍脑袋定天数，
          是用台账里每台的计划检修频率（次/季）和距上次检修小时数倒推出来的到期日。</p>
        <ul class="ai-list">${plan ||
        `<li class="ai-item"><div class="d">暂时没有要排期的设备。</div></li>`}</ul></div>
    </div>
    <div class="ai-block" style="margin-top:14px">
      <h5>该做什么 <span class="hint" style="display:inline;margin:0">（共 ${(g.actions || []).length} 条）</span></h5>
      <div class="ai-more" style="margin-top:0">
        ${PRI_ALL.map(p => `<button class="btn ${p === AI.filter ? "" : "ghost"} small"
            data-ai-filter="${p}">${p}</button>`).join("")}
      </div>
      <ul class="ai-list" data-ai-actions style="margin-top:10px">${(g.actions || [])
        .filter(a => AI.filter === "全部" || a.priority === AI.filter).map(actionItem).join("") ||
        `<li class="ai-item"><div class="d">当前没有需要处理的事项。</div></li>`}</ul>
    </div>
    <div class="ai-block" style="margin-top:14px">
      <h5>一台一台看 <span class="hint" style="display:inline;margin:0">（${briefs.length} 台）</span></h5>
      <p class="hint">「风险」是综合值；「现场」是潮湿、粉尘、检修这些填报项算出来的那部分。
        「排期」按每台的计划检修频率倒推出到期日，和上面检修排期表同一口径。
        点「解读」看这台为什么高、怎么降；要交班留痕，用右上角「导出…」存成 CSV，数字和这一页同一套。</p>
      <div class="table-scroll" id="aiDeviceList"><table>
        <tr><th>编号</th><th>名称</th><th>巷道</th><th>分级</th><th>风险</th>
            <th>现场</th><th>主要问题</th><th>排期</th><th>操作</th></tr>
        ${rows || `<tr><td colspan="9">暂无设备</td></tr>`}
      </table></div>
      ${pg.size ? App.pagerHTML("ai", pg.page, pg.pages, briefs.length, pg.size) : ""}
    </div>
    <div class="ai-more">
      <button class="btn ai small" id="aiAdvBtn" data-ai-adv="global">让 AI 补充建议</button>
      <a class="link" href="#" data-ai-open="qa">直接问 AI →</a>
    </div>
    <div data-ai-agent></div>`);
}

/* ---------------------------------------------------------------- 单台抽屉 */
function drawerHTML(a){
  const sp = a.split || {};
  const sig = (a.signals || []).map(s => `<tr>
      <td><span class="pri" data-pri="${aiEsc(s.level)}">${aiEsc(s.level)}</span> ${aiEsc(s.label)}</td>
      <td>${s.value === null || s.value === undefined ? "—" : num(s.value) + aiEsc(s.unit)}</td>
      <td>${aiEsc(s.note)}<span class="kind">${aiEsc(s.source)}</span></td></tr>`).join("");
  const what = (a.whatif || []).map(w => `<li class="ai-item">
      <div class="t">${aiEsc(w.title)}</div>
      <div class="d">${aiEsc(w.show || `${w.from} → ${w.to}`)}；${aiEsc(w.basis)}</div>
      <div class="e">${aiEsc(w.expect)}</div></li>`).join("");
  const acts = (a.actions || []).map(actionItem).join("");

  return `<h2>AI 解读 · ${aiEsc(a.name)}</h2>
    <p class="hint">${aiEsc(a.code)} · ${aiEsc(a.type)} · ${aiEsc(a.location || "未标注巷道")}
       · 数据来自 ${aiEsc(a.source)}</p>
    <p class="ai-headline">${aiEsc(a.headline)}</p>
    <p class="hint">${aiEsc(a.attribution)}</p>
    <div class="split-row">
      <div style="width:${(sp.model || 0) * 100}%;background:#1e88e5" title="设备本身></div>
      <div style="width:${(sp.condition || 0) * 100}%;background:#ef8b1f" title="工况独立贡献"></div>
      <div style="width:${(sp.overlap || 0) * 100}%;background:#4a6fc4" title="两路叠加"></div>
    </div>
    <div class="split-legend">
      <span>设备本身 <b>${pct(sp.model, 2)}</b></span>
      <span>现场情况 <b>${pct(sp.condition, 2)}</b></span>
      <span>两边叠加 <b>${pct(sp.overlap, 2)}</b></span>
    </div>
    <h4>哪几项超标</h4>
    ${sig ? `<table class="sig-table">${sig}</table>` : `<p class="hint">都在正常范围。</p>`}
    ${a.caveats && a.caveats.length ? `<h4>说明</h4>${a.caveats.map(c => `<p class="hint">· ${aiEsc(c)}</p>`).join("")}` : ""}
    ${what ? `<h4>改了能降多少</h4><ul class="ai-list">${what}</ul>` : ""}
    <h4>该做什么</h4>
    <ul class="ai-list">${acts || `<li class="ai-item"><div class="d">按正常巡检走就行。</div></li>`}</ul>
    <div class="btn-row">
      <button class="btn ai" data-ai-adv="${aiEsc(a.code)}">让 AI 补充建议</button>
      <button class="btn ghost" data-ai-ask="${aiEsc(a.code)}">再问一句</button>
      <button class="btn ghost" data-ai-close="1">关闭</button>
    </div>
    <div data-ai-agent></div>`;
}

/* ---------------------------------------------------------------- 渲染入口 */
/* 看板每 15 秒轮询一次并重绘整块面板，Agent 补充建议是异步写进槽位的，
   不记住上一份输出就会出现"看到一半突然消失"。用 WeakMap 按盒子存，
   重绘后原样放回；正在生成的那份重绘后重新找槽位续写，不会丢字。 */
const AGENT_OUT = new WeakMap();
let streamingBox = null;

function agentSlot(box){ return box ? box.querySelector("[data-ai-agent]") : null; }

function setAgentOut(box, html){
  AGENT_OUT.set(box, html);
  if (streamingBox === box){
    const slot = agentSlot(box);
    if (slot) slot.innerHTML = html;
  }
}

function renderPanels(){
  const g = AI.global;
  document.querySelectorAll("[data-ai]").forEach(box => {
    if (!g){
      box.innerHTML = AI.loading
        ? panelShell(`<div class="ai-skel">正在分析风险结果…</div>`)
        : panelShell(`<div class="ai-err">分析失败：${aiEsc(AI.error || "接口没有返回内容")}
            <br>台账和看板数字不受影响，点右上角「重新分析」可再算一轮。</div>`);
      return;
    }
    box.innerHTML = fullHTML(g);
    const kept = AGENT_OUT.get(box);
    if (kept){
      const slot = agentSlot(box);
      if (slot) slot.innerHTML = kept;
    }
  });
  refreshStatus();
}

/* 面板重绘出任何问题都不能把 AI.loading 留在 true：一旦卡住，
   下面的入口守卫会让之后每一次点击、以及每 15 秒的自动刷新都静默返回，
   表现就是「重新分析」按了彻底没反应，只能刷新整页才能救回来。 */
function repaint(){
  try{ renderPanels(); }
  catch(e){
    console.error("智能分析面板渲染失败", e);
    AI.error = "这一轮结果没能画出来（数据格式异常），已保留上一轮内容";
  }
  try{ paintRefreshBtn(); }catch(e){ console.error(e); }
}

async function loadGlobal(btn){
  if (btn) refreshBtn = btn;
  const manual = !!btn;
  if (AI.loading) return AI.global;
  AI.loading = true;
  AI.flash = "";
  repaint();                          // 点下去立刻进「分析中」，不用等接口回来
  try{
    const res = await App.api("/api/analysis");
    AI.global = res.result;
    AI.error = "";
  }catch(e){
    AI.global = null;
    AI.error = e.message || "分析失败";
  }finally{
    AI.loading = false;
    repaint();
    if (manual && !AI.error) flashDone();
  }
  return AI.global;
}

/* 状态灯的唯一取数口：问答那边已经拿到一份时直接递过来（applyAgentStatus），
   没有就自己取一次。以前是 chat 取一遍、这里再取一遍，一次刷新打两次接口。 */
function applyAgentStatus(s){
  AI.agent = s || {ready: false, reason: "状态接口不可用"};
  refreshStatus();
}

async function loadAgentStatus(){
  try{
    applyAgentStatus(await App.api("/api/agent/status"));
  }catch(e){
    applyAgentStatus(null);
  }
}

/* ---------------------------------------------------------------- Agent 补充 */
async function askAdvice(box, code){
  if (!agentSlot(box)) return;
  streamingBox = box;
  let buf = "", failed = "", done = false;
  const paint = () => {
    let body = "";
    if (buf) body = aiEsc(buf) + (done && !failed ? "" : `<span class="cursor"></span>`);
    if (!buf && !done && !failed) body = `<span class="cursor"></span>`;
    if (failed) body += `${body ? "<br>" : ""}<span class="ai-err">${aiEsc(failed)}</span>`;
    if (done && !failed && !buf) body = `<span class="ai-err">AI 这次没给内容。</span>`;
    const label = failed ? `<i class="off"></i>没成功`
      : (done ? `<i class="on"></i>写好了` : `<i class="on"></i>正在写…`);
    setAgentOut(box, `<div class="ai-panel" style="margin:12px 0 0">
      <div class="ai-hd"><span class="ai-tag">✦ AI 补充建议</span>
        <span class="ai-status">${label}</span></div>
      <div class="${done && !failed && buf ? "ai-answer" : "ai-skel"}">${body}</div></div>`);
  };
  paint();
  await QA.stream({mode: "advice", question: "", code: code}, {
    onContent: t => { buf += t; paint(); },
    onError: m => { failed = m; paint(); },
    onDone: () => {
      done = true; paint(); streamingBox = null;
      /* 欠费 / 限流只有真调过才知道，调完立刻刷新状态灯 */
      loadAgentStatus();
    },
  });
}

/* ---------------------------------------------------------------- 事件绑定 */
function bindPanelEvents(){
  document.addEventListener("click", e => {
    if (!e.target.closest) return;
    const adv = e.target.closest("[data-ai-adv]");
    if (adv){
      const code = adv.dataset.aiAdv === "global" ? "" : adv.dataset.aiAdv;
      askAdvice(adv.closest("[data-ai]") || adv.closest("[data-ai-scope]") || document.body, code);
      return;
    }
    const flt = e.target.closest("[data-ai-filter]");
    if (flt){ AI.filter = flt.dataset.aiFilter; repaint(); return; }
    const ask = e.target.closest("[data-ai-ask]");
    if (ask){ App.closeAll(); QA.openWithDevice(ask.dataset.aiAsk); return; }
    const openqa = e.target.closest("[data-ai-open]");
    if (openqa){ e.preventDefault(); QA.open(); return; }
    const close = e.target.closest("[data-ai-close]");
    if (close){ App.closeDrawer("aiDrawer"); return; }
  });
}

/* ---------------------------------------------------------------- 对外接口 */
window.SmartAnalysis = {
  mountAll(){
    bindPanelEvents();
    if (!document.querySelectorAll("[data-ai]").length) return;
    /* 分页控件的点击由 common.js 的 bindPager 统一接住、统一调 render()，
       这里挂个渲染回调，让整页重绘时把「一台一台看」的新一页画出来。 */
    App.onRender(() => { renderPanels(); });
    loadAgentStatus();
    loadGlobal();
    App.onState(() => { loadGlobal(); });
  },
  async openDevice(code){
    const drawer = App.byId("aiDrawer");
    if (!drawer) return;
    drawer.innerHTML = `<h2>AI 解读</h2><div class="ai-skel">正在分析 ${aiEsc(code)} …</div>`;
    App.openDrawer("aiDrawer");
    try{
      const res = await App.api("/api/analysis?code=" + encodeURIComponent(code));
      drawer.innerHTML = drawerHTML(res.result);
    }catch(e){
      drawer.innerHTML = `<h2>AI 解读</h2><div class="ai-err">解读失败：${aiEsc(e.message)}</div>`;
    }
  },
  /* 状态灯的对外入口只有一个：谁拿到了 status 载荷谁递进来，不再各取一遍。 */
  applyAgentStatus,
  refresh: loadGlobal,
};

})();
