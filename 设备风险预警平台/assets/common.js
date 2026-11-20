/* ==========================================================================
   common.js · 全站共用：状态、渲染、抽屉、事件委托
   三个页面都加载它，页面差异由 App.boot({page, ...}) 传入的配置决定。
   ========================================================================== */
"use strict";

const S = {
  state: null,
  editing: null,
  calibCode: null,
  // boot() 幂等闸门：合并后的页面加载两份脚本、各自都调 App.boot()
  booted: false,
  // cardPage / rowPage：这两处列表每页默认多少条（0 = 不分页，全量铺开）
  cfg: {cardPage: 0, rowPage: 0, fullTable: false, env: false},
  tblQ: "",            // 台账搜索词（编号 / 名称 / 巷道 / 类型）
  tblLevel: "",        // 台账分级筛选，空 = 全部
  pager: {cards: {page: 1, size: 12}, table: {page: 1, size: 24}, ai: {page: 1, size: 12},
          report: {page: 1, size: 10}, samples: {page: 1, size: 20},
          events: {page: 1, size: 20}, worklog: {page: 1, size: 20}},
  hooks: {onState: [], onRender: []},
  // 导入抽屉的临时状态：文件原文只在内存里，服务端预检过了才允许真写
  imp: {text: "", name: "", summary: null, canApply: false, phase: "idle"},
};

/* 「最可能故障」「剩余寿命」这两列的临时状态。
   它走单独的 /api/health-models：线上模型没发布时后端只回原因，
   风险色档照旧画满，两件事互不拖累。 */
const H = {data: null, error: "", loading: false};

/* 所有写进 innerHTML 的服务端数据都要过这里，防止台账/巷道名里带标签造成 XSS */
const ESC_MAP = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"};
function esc(v){
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, ch => ESC_MAP[ch]);
}

function fmt(v, digits, unit){
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return esc(v);
  return n.toFixed(digits) + (unit || "");
}

function byId(id){ return document.getElementById(id); }
function has(id){ return !!document.getElementById(id); }

async function api(path, options){
  const r = await fetch(path, Object.assign({cache: "no-store"}, options || {}));
  let data;
  try{ data = await r.json(); }
  catch(e){ throw new Error("服务返回无法解析（HTTP " + r.status + "）"); }
  if (!data.ok && data.error) throw new Error(data.error);
  return data;
}

/* ---------------------------------------------------------------- 跨页签同步 */
/* 台账一改，另外两个页签（风险概览 / 智能分析）要立刻跟上。只靠 15 秒轮询不够：
   浏览器会把后台页签的定时器压到几乎不跑，导完切回概览页看到的还是导入前的数字。
   BroadcastChannel 可用就用它，不可用退回 localStorage 的 storage 事件，效果一样。 */
const SYNC_KEY = "pex.ledger.changed";
let syncChannel = null;
try{
  syncChannel = (typeof BroadcastChannel === "function") ? new BroadcastChannel("pex") : null;
}catch(e){ syncChannel = null; }

function broadcastChange(){
  if (syncChannel){ try{ syncChannel.postMessage("changed"); }catch(e){ /* 广播失败不影响本页 */ } return; }
  try{ localStorage.setItem(SYNC_KEY, String(Date.now())); }catch(e){ /* 隐私模式忽略 */ }
}

function watchRemoteChange(){
  if (syncChannel){
    syncChannel.onmessage = () => { load(); };
    return;
  }
  window.addEventListener("storage", e => { if (e.key === SYNC_KEY) load(); });
}

/* 所有写接口成功后统一走这里：本页立刻重拉 + 通知其它页签 */
function changed(){
  broadcastChange();
  return load();
}

/* ---------------------------------------------------------------- 状态加载 */
async function load(){
  try{
    const r = await fetch("/api/state", {cache: "no-store"});
    if (!r.ok) throw new Error("HTTP " + r.status);
    S.state = await r.json();
    render();
    S.hooks.onState.forEach(fn => { try{ fn(S.state); }catch(e){ console.error(e); } });
    loadHealth();                       // 两列新数据异步补上，不拖慢首屏
  }catch(e){
    if (has("ts")) byId("ts").textContent = "无法连接服务：" + e.message;
  }
}

function render(){
  const s = S.state;
  if (!s) return;
  if (has("ts")) byId("ts").textContent = "更新时间 " + s.ts +
    (s.model_ready ? "" : "　|　模型未找到：" + s.model_path);

  renderStats(s);
  renderLegend();
  renderCards();
  renderTable();
  renderHealthNote();
  renderFormOptions(s);
  if (S.cfg.env) renderEnv(s);
  // 智能分析面板归 analysis.js 自己画，但它那台「一台一台看」的分页也走这里那套
  // 分页控件，所以整页重绘后要叫它一声，不然翻页点了没反应（不直接 import，避免互相依赖）
  S.hooks.onRender.forEach(fn => { try{ fn(); }catch(e){ console.error(e); } });
}

function renderStats(s){
  if (!has("stats")) return;
  const c = s.counts;
  byId("stats").innerHTML = [
    ["设备总数", c.green + c.yellow + c.orange + c.red + c.gray, "#0d5ea8"],
    ["正常", c.green, "#2f9e5f"],
    ["关注", c.yellow, "#e8b500"],
    ["预警", c.orange, "#ef8b1f"],
    ["报警", c.red, "#d63b2f"],
  ].map(([label, val, color]) =>
    `<div class="stat" style="border-top-color:${color}"><b style="color:${color}">${val}</b><span>${label}</span></div>`
  ).join("");
}

function renderLegend(){
  if (!has("legend")) return;
  byId("legend").innerHTML = [
    ["green", "正常", "<0.30"], ["yellow", "关注", "0.30-0.50"],
    ["orange", "预警", "0.50-0.70"], ["red", "报警", "≥0.70"], ["gray", "无数据", "未接入"],
  ].map(([k, n, r]) =>
    `<span class="chip"><span class="dot" style="background:var(--${k})"></span>${n} ${r}</span>`
  ).join("");
}

/* ---------------------------------------------------------- 最可能故障 / 剩余寿命 */
/* 这两列的取数口径和风险等级是同一份（服务端 _model_sample），所以三处说的是同一时刻的事。
   线上模型没发布时单元格只画「—」，具体差什么写在表格上方那一行，不在每台设备上重复刷屏。 */
const HM_LABEL = {fault_type: "「最可能故障」", rul: "「剩余寿命」"};

async function loadHealth(){
  if (!has("tableWrap") && !has("cards")) return;   // 没有这两列的页面不白跑一次推理
  if (H.loading) return;                            // 15 秒轮询撞上手动刷新时，只留一个在飞
  H.loading = true;
  try{
    const r = await fetch("/api/health-models", {cache: "no-store"});
    if (!r.ok) throw new Error("HTTP " + r.status);
    H.data = await r.json();
    H.error = "";
  }catch(e){
    H.data = null;
    H.error = e.message;
  }
  H.loading = false;
  renderHealthNote();
  if (!S.state) return;                 // 台账都没拉到，卡片和表格本来就没画，不必补这两列
  renderCards();
  renderTable();
}

function healthOf(code){
  const list = (H.data && H.data.devices) || [];
  return list.find(x => x.code === code) || null;
}

/* 概率给整数百分比就够了：小数点后那位在两台设备之间根本比不出先后 */
function top3HTML(top3){
  if (!top3 || !top3.length) return '<span class="hm-none">—</span>';
  return `<div class="hm-chips">` + top3.map(t =>
    `<span class="hm-chip${t.is_normal ? " hm-ok" : ""}">${esc(t.fault_type)} ${(t.probability * 100).toFixed(0)}%</span>`
  ).join("") + `</div>`;
}

/* 小时数是天与时的分水岭：现场排检修看的是「还能跑几天」，不到一天就照小时说。
   一格之内单位必须一致，不能 P50 说天、P90 说小时。 */
function rulParts(r){
  if (!r || r.p50 === null || r.p50 === undefined) return null;
  const days = Number(r.p50) >= 720;
  const f = v => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return days ? (n / 24).toFixed(n / 24 >= 10 ? 0 : 1) + " 天" : Math.round(n) + " h";
  };
  return {main: f(r.p50), band: "P10–P90 " + f(r.p10) + "–" + f(r.p90)};
}

function rulCellHTML(r){
  const p = rulParts(r);
  if (!p) return '<span class="hm-none">—</span>';
  return `<b>${p.main}</b><div class="hm-band">${p.band}</div>`;
}

function healthCells(code){
  const x = healthOf(code);
  return `<td class="hm-td">${top3HTML(x && x.top3)}</td><td class="hm-td">${rulCellHTML(x && x.rul)}</td>`;
}

function healthNoteText(){
  if (H.error) return "这两列暂时取不到数：" + H.error + "。风险分级不受影响，照常计算。";
  const n = H.data && H.data.notes;
  if (!n) return "正在算这两列…";
  const parts = [];
  Object.keys(HM_LABEL).forEach(kind => {
    const info = n[kind] || {};
    if (info.live){
      parts.push(HM_LABEL[kind] + "按线上版本 " + info.live + " 计算");
      return;
    }
    const gaps = (info.gaps || []).slice(0, 2).join("；");
    parts.push(HM_LABEL[kind] + "暂时空着：" + info.reason + (gaps ? "　→ " + gaps : ""));
  });
  const miss = [];
  const mf = H.data.missing_features || {};
  Object.keys(mf).forEach(k => (mf[k] || []).forEach(f => { if (miss.indexOf(f) < 0) miss.push(f); }));
  if (miss.length) parts.push("这几列现场还没测到：" + miss.join("、") + "，模型按缺失值处理");
  return parts.join("　|　");
}

/* 页头那句「这两列与风险各算各的」原本在首页、设备台账、训练中心各写一遍，
   口径只留这一份：页面里放 <span data-hm-note></span>，启动时把字填进去。 */
const HM_SCOPE_NOTE = "「最可能故障」和「剩余寿命」这两项来自另外两个模型，和「风险」那一列各算各的："
  + "风险说的是这一时刻该不该管，这两项说的是大概坏成什么样、还能撑多久，不要把两者凑成一个数。"
  + "没上线时先空着，页面会写清还差什么，补数据在「模型训练中心」。";

function fillHmNotes(){
  document.querySelectorAll("[data-hm-note]").forEach(el => { el.textContent = HM_SCOPE_NOTE; });
}

function renderHealthNote(){
  if (!has("hmNote")) return;
  const box = byId("hmNote");
  const txt = healthNoteText();
  box.textContent = txt;
  box.className = "hm-note" + (H.error ? " bad" : "");
}

function healthCardHTML(code){
  const x = healthOf(code);
  if (!x) return "";
  const p = rulParts(x.rul);
  if (!x.top3 && !p) return "";
  return `<div class="hm-card">${top3HTML(x.top3)}` +
    (p ? `<div class="hm-rul">剩余寿命 <b>${p.main}</b>　${p.band}</div>`
       : `<div class="hm-rul hm-none">剩余寿命 —</div>`) + `</div>`;
}

/* ---------------------------------------------------------------- 设备卡片 */
function cardHTML(d){
  const t = d.telemetry || {};
  const pct = d.risk === null ? "—" : (d.risk * 100).toFixed(2) + "%";
  const rawPct = (d.raw_risk === null || d.raw_risk === undefined) ? "—" : (d.raw_risk * 100).toFixed(2) + "%";
  const condPct = (d.cond_risk === null || d.cond_risk === undefined) ? "—" : (d.cond_risk * 100).toFixed(1) + "%";
  return `<div class="dev" style="border-left-color:${esc(d.level.color)}">
    <h3>${esc(d.name)} <span class="lvl" style="background:${esc(d.level.color)}">${esc(d.level.name)}</span></h3>
    <div class="meta">${esc(d.code)} · ${esc(d.type)} · ${esc(d.location || "未标注巷道")}</div>
    <div class="pct" style="color:${esc(d.level.color)}">${pct}</div>
    <div class="rawline">模型 <b>${rawPct}</b>　工况 <b>${condPct}</b>${d.source ? "　" + esc(d.source) + "数据" : ""}</div>
    <div class="kv">
      <div><i>设备温度</i><br>${fmt(t.dev_temp, 1, "℃")}</div>
      <div><i>环境温度</i><br>${fmt(t.env_temp, 1, "℃")}</div>
      <div><i>电流</i><br>${fmt(t.current, 1, "A")}</div>
      <div><i>湿度/粉尘</i><br>${fmt(t.humidity, 1, "级")} / ${fmt(t.dust, 1, "级")}</div>
      <div><i>累计运行</i><br>${fmt(t.run_hours, 0, "h")}</div>
      <div><i>距上次检修</i><br>${fmt(t.since_repair_hours, 0, "h")}</div>
    </div>
    ${healthCardHTML(d.code)}
    ${d.error ? `<p class="hint" style="color:#a8322a">预测失败：${esc(d.error)}</p>` : ""}
    ${t.sim_time ? `<p class="hint">最新数据：${esc(t.sim_time)}</p>` : `<p class="hint">暂无运行记录，这台只按现场情况评级</p>`}
    <button class="ai-btn" data-act="ai" data-code="${esc(d.code)}">AI 解读</button>
    <button class="calib-btn" data-act="calib" data-code="${esc(d.code)}">校准工况</button>
  </div>`;
}

/* ---------------------------------------------------------------- 分页 */
/* 台账会一直往里加设备，首页卡片和台账表格不可能一次全铺完，所以两处共用一套分页：
   每页条数可选 + 上一页/下一页 + 页码窗口（当前页居中，两端省略号）。
   页码存在 S.pager 里，15 秒轮询重绘时不会跳回第一页；数据变少（删设备、筛选变窄）
   导致页码越界时自动收到最后一页。
   维护记录/故障事件/样本/核查卡这四个长列表接同一套原语，只差每页条数档位、
   量词，和「翻页之后重画哪一个列表」（pager 项上的可选 draw）。 */
const PAGER_SIZES = [12, 24, 48, 100];
/* 一行一条的列表和一张一屏的卡片不是一套节奏：核查卡 10 起，其余 20 起。 */
const PAGER_OPTS = {cards: PAGER_SIZES, table: PAGER_SIZES, ai: PAGER_SIZES,
                    report: [10, 20, 50], samples: [20, 50, 100], events: [20, 50, 100], worklog: [20, 50, 100]};
const PAGER_UNIT = {report: "台", samples: "条", events: "条", worklog: "条"};

function pageWindow(cur, pages){
  if (pages <= 7) return Array.from({length: pages}, (_, i) => i + 1);
  let a = cur - 1, b = cur + 1;
  if (cur <= 3){ a = 2; b = 4; }
  if (cur >= pages - 2){ a = pages - 3; b = pages - 1; }
  const out = [1];
  if (a > 2) out.push("…");
  for (let i = a; i <= b; i++) out.push(i);
  if (b < pages - 1) out.push("…");
  out.push(pages);
  return out;
}

function pagerHTML(key, cur, pages, total, size){
  const btn = (label, page, dis) =>
    `<button type="button" class="pg${page === cur ? " on" : ""}" data-pager="${key}" ` +
    `data-page="${page}"${page === cur ? ' aria-current="page"' : ""}${dis ? " disabled" : ""}>${label}</button>`;
  const win = pageWindow(cur, pages).map(x => x === "…"
    // 当前页只做高亮，不置灰：置灰后和"到头了"的上/下一页分不清
    ? `<span class="pg-ell">…</span>` : btn(x, x, false)).join("");
  return `<div class="pager">
    <span class="pg-info">共 ${total} ${PAGER_UNIT[key] || "台"} · 第 ${cur} / ${pages} 页</span>
    <select data-pager="${key}" data-size="1" aria-label="每页显示条数">` +
      (PAGER_OPTS[key] || PAGER_SIZES).map(n =>
        `<option value="${n}"${n === size ? " selected" : ""}>每页 ${n} ${PAGER_UNIT[key] || "台"}</option>`).join("") +
    `</select>${btn("‹ 上一页", cur - 1, cur <= 1)}${win}${btn("下一页 ›", cur + 1, cur >= pages)}</div>`;
}

/* 取某一页的数据；size<=0（智能分析页那种全量列表）就不分页 */
function paginate(list, key){
  const st = S.pager[key];
  const size = st.size || 0;
  if (!(size > 0)) return {rows: list, page: 1, pages: 1, size: 0};
  const pages = Math.max(1, Math.ceil(list.length / size));
  if (st.page > pages) st.page = pages;
  if (st.page < 1) st.page = 1;
  return {rows: list.slice((st.page - 1) * size, st.page * size),
          page: st.page, pages, size};
}

function bindPager(){
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-pager][data-page]");
    if (!b || b.disabled) return;
    const st = S.pager[b.dataset.pager];
    st.page = Number(b.dataset.page) || 1;
    /* 一页只画一个列表：看板卡片/台账表这些走整页重绘，其余列表各自登记自己的
       draw，翻页就不再顺带把无关的分区和它的取数一起重跑一遍。 */
    st.draw ? st.draw() : render();
  });
  document.addEventListener("change", e => {
    const sel = e.target.closest && e.target.closest("[data-pager][data-size]");
    if (!sel) return;
    const st = S.pager[sel.dataset.pager];
    st.size = Number(sel.value) || 0;
    st.page = 1;                       // 换了每页条数，回到第一页最不容易看串行
    st.draw ? st.draw() : render();
  });
}

function renderCards(){
  if (!has("cards")) return;
  const all = S.state.devices;
  const pg = paginate(all, "cards");
  byId("cards").innerHTML = pg.rows.map(cardHTML).join("") ||
    `<div class="empty">还没有设备，<a class="link" href="/devices">去「设备台账」录入第一台 →</a></div>`;
  if (has("cardsPager")){
    byId("cardsPager").innerHTML = pg.size
      ? pagerHTML("cards", pg.page, pg.pages, all.length, S.pager.cards.size) : "";
  }
  if (has("cardsMore")){
    const more = byId("cardsMore");
    more.innerHTML = all.length
      ? `<span class="more-label">快捷入口</span>` +
        `<a class="link" href="/risk">智能分析（归因与治理方案）</a>` +
        `<a class="link" href="/devices">设备台账（录入与维护）</a>`
      : "";
    more.hidden = !all.length;
  }
}

/* ---------------------------------------------------------------- 台账表格 */
/* 筛选控件（#devSearch / #devLevel）只存在于设备台账页，由页面 HTML 提供；
   这里只负责读取条件、过滤、渲染，控件本身不会被重绘，所以输入焦点不会丢。 */
function tableRows(){
  const q = S.tblQ.trim().toLowerCase();
  const lv = S.tblLevel;
  return S.state.devices.filter(d =>
    (!lv || d.level.name === lv) &&
    (!q || [d.code, d.name, d.type, d.location, d.status, d.maker]
      .some(v => String(v || "").toLowerCase().includes(q))));
}

function bindTableFilter(){
  const box = byId("devSearch");
  if (box && !box.dataset.bound){
    box.dataset.bound = "1";
    box.addEventListener("input", e => {
      S.tblQ = e.target.value || "";
      S.pager.table.page = 1;          // 换了条件还停在第 5 页，只会看到一片空白
      renderTable();
    });
  }
  const sel = byId("devLevel");
  if (sel && !sel.dataset.bound){
    sel.dataset.bound = "1";
    sel.addEventListener("change", e => {
      S.tblLevel = e.target.value || "";
      S.pager.table.page = 1;
      renderTable();
    });
  }
  const clear = byId("devFilterClear");
  if (clear && !clear.dataset.bound){
    clear.dataset.bound = "1";
    clear.addEventListener("click", () => {
      S.tblQ = ""; S.tblLevel = "";
      if (byId("devSearch")) byId("devSearch").value = "";
      if (byId("devLevel")) byId("devLevel").value = "";
      S.pager.table.page = 1;
      renderTable();
    });
  }
}

function renderTable(){
  if (!has("tableWrap")) return;
  const total = S.state.devices.length;
  const rows = tableRows();
  const filtered = rows.length !== total;
  const pg = paginate(rows, "table");
  const full = !!S.cfg.fullTable;
  const head = ["编号", "名称", "类型", "巷道", "额定电压", "额定电流"]
    .concat(full ? ["额定功率", "状态", "投运日期", "厂家"] : ["状态"])
    .concat(["风险", "最可能故障", "剩余寿命", "操作"]);
  byId("tableWrap").innerHTML = `<div class="table-scroll"><table>
    <tr>${head.map(h => `<th>${h}</th>`).join("")}</tr>
    ${pg.rows.map(d => `<tr>
      <td>${esc(d.code)}</td><td>${esc(d.name)}</td><td>${esc(d.type)}</td><td>${esc(d.location || "-")}</td>
      <td>${fmt(d.rated_v, 3, "kV")}</td><td>${fmt(d.rated_i, 0, "A")}</td>
      ${full ? `<td>${fmt(d.rated_p, 0, "kW")}</td><td>${esc(d.status)}</td>
               <td>${esc(d.commission_date || "-")}</td><td>${esc(d.maker || "-")}</td>` : ""}
      <td style="color:${esc(d.level.color)};font-weight:700">${esc(d.level.name)}</td>
      ${healthCells(d.code)}
      <td>
        <button class="btn ghost small" data-act="edit" data-code="${esc(d.code)}">编辑</button>
        <button class="btn small" data-act="calib" data-code="${esc(d.code)}">校准</button>
        <button class="btn ai small" data-act="ai" data-code="${esc(d.code)}">解读</button>
        ${full ? `<button class="btn danger small" data-act="del" data-code="${esc(d.code)}" data-name="${esc(d.name)}">删除</button>` : ""}
      </td>
    </tr>`).join("") || `<tr><td colspan="${head.length}"><div class="empty">没有符合条件的设备，
      ${filtered ? "换个关键词或点「清空筛选」。" : "先去「设备台账」录入设备。"}</div></td></tr>`}
  </table></div>`;
  if (has("tablePager")){
    byId("tablePager").innerHTML = pg.size
      ? pagerHTML("table", pg.page, pg.pages, rows.length, S.pager.table.size) : "";
  }
  if (has("tableCount")){
    byId("tableCount").textContent = filtered
      ? `筛出 ${rows.length} / ${total} 台` : "共 " + total + " 台";
  }
}

function renderFormOptions(s){
  if (has("f_type")) byId("f_type").innerHTML = s.types.map(t => `<option>${esc(t)}</option>`).join("");
  if (has("f_status")) byId("f_status").innerHTML = s.statuses.map(t => `<option>${esc(t)}</option>`).join("");
}

/* ---------------------------------------------------------------- 巷道环境 */
function renderEnv(s){
  if (!has("envList")) return;
  const env = s.env.env_base_by_tunnel || {};
  byId("envList").innerHTML = Object.keys(env).length
    ? Object.entries(env).map(([k, v]) => `<div class="env-row">
        <span style="min-width:120px">${esc(k)}</span>
        <input type="number" step="0.5" data-act="env-temp" data-tunnel="${esc(k)}" value="${esc(v)}" />
        <span style="color:#6b829c;font-size:12px">℃</span>
        <button class="btn ghost small" data-act="del-tunnel" data-tunnel="${esc(k)}">删除</button>
      </div>`).join("")
    : `<div class="empty">配置里还没有巷道环境，先添加一个。</div>`;
  byId("defaultEnv").value = s.env.default_env_base;
  byId("cfgHint").textContent = "配置文件：" + s.env.config_path;
}

/* ---------------------------------------------------------------- 设备表单 */
function openForm(dev){
  S.editing = dev ? dev.code : null;
  byId("formTitle").textContent = dev ? ("编辑设备 · " + dev.code) : "新增设备";
  byId("formErr").style.display = "none";
  const set = (id, v) => { if (has(id)) byId(id).value = (v === null || v === undefined) ? "" : v; };
  set("f_code", dev ? dev.code : "");
  set("f_name", dev ? dev.name : "");
  set("f_location", dev ? dev.location : "");
  set("f_rated_v", dev ? dev.rated_v : 0.66);
  set("f_rated_i", dev ? dev.rated_i : 100);
  set("f_rated_p", dev ? dev.rated_p : 75);
  set("f_commission", dev ? dev.commission_date : "");
  set("f_maker", dev ? dev.maker : "");
  set("f_remark", dev ? dev.remark : "");
  if (dev){ byId("f_type").value = dev.type; byId("f_status").value = dev.status; }
  byId("f_code").disabled = !!dev;
  byId("btnDelDevice").style.display = dev ? "inline-block" : "none";
  openDrawer("drawer");
}

function closeForm(){ closeDrawer("drawer"); }

function editDevice(code){
  const dev = S.state.devices.find(d => d.code === code);
  if (dev) openForm(dev);
}

async function delDevice(code, name){
  const msg = "确定删除设备 " + code + (name ? "（" + name + "）" : "") + " ？\n\n"
            + "该设备的运行日志、校准记录会一并删除，且不可恢复。";
  if (!confirm(msg)) return;
  try{
    await api("/api/device/delete", {method: "POST", headers: {"Content-Type": "application/json"},
                                     body: JSON.stringify({code: code})});
    closeForm();
    changed();
  }catch(e){ alert(e.message); }
}

function deleteCurrent(){
  if (!S.editing) return;
  const dev = S.state.devices.find(d => d.code === S.editing);
  delDevice(S.editing, dev ? dev.name : "");
}

async function submitForm(){
  const get = id => (has(id) ? byId(id).value : "");
  const payload = {
    code: get("f_code").trim(),
    name: get("f_name").trim(),
    type: get("f_type"),
    location: get("f_location").trim(),
    rated_v: parseFloat(get("f_rated_v")),
    rated_i: parseFloat(get("f_rated_i")),
    rated_p: parseFloat(get("f_rated_p")),
    commission_date: get("f_commission"),
    status: get("f_status"),
    maker: get("f_maker").trim(),
    remark: get("f_remark").trim(),
  };
  try{
    await api("/api/device", {method: "POST", headers: {"Content-Type": "application/json"},
                              body: JSON.stringify(payload)});
    closeForm();
    changed();
  }catch(e){
    const box = byId("formErr");
    box.style.display = "block";
    box.textContent = e.message;
  }
}

/* ---------------------------------------------------------------- 环境写入 */
async function saveEnv(tunnel, value){
  try{
    await api("/api/env", {method: "POST", headers: {"Content-Type": "application/json"},
                           body: JSON.stringify({tunnel: tunnel, temp: parseFloat(value)})});
    changed();
  }catch(e){ alert(e.message); }
}

async function addTunnel(){
  const name = byId("newTunnel").value.trim();
  const temp = byId("newTunnelTemp").value;
  if (!name){ alert("请填写巷道名称"); return; }
  await saveEnv(name, temp);
  byId("newTunnel").value = "";
}

async function delTunnel(tunnel){
  try{
    await api("/api/env/delete", {method: "POST", headers: {"Content-Type": "application/json"},
                                  body: JSON.stringify({tunnel: tunnel})});
    changed();
  }catch(e){ alert(e.message); }
}

async function saveDefaultEnv(){
  try{
    await api("/api/env/default", {method: "POST", headers: {"Content-Type": "application/json"},
                                   body: JSON.stringify({temp: parseFloat(byId("defaultEnv").value)})});
    changed();
  }catch(e){ alert(e.message); }
}

/* ---------------------------------------------------------------- 工况校准 */
function factorTable(items, total){
  if (!items || !items.length) return "";
  const rows = items.map(it => {
    const pct = Number(it.contribution * 100).toFixed(1);
    const cls = it.score >= 0.6 ? "f-pos" : (it.score <= 0.2 ? "f-neg" : "");
    return `<tr><td>${esc(it.name)}</td><td>${esc(it.note)}</td>
            <td class="${cls}">${(it.score * 100).toFixed(0)}%</td>
            <td>${pct}%</td></tr>`;
  }).join("");
  return `<table class="factor-table">
    <tr><th style="text-align:left">影响因素</th><th style="text-align:left">输入</th>
        <th style="text-align:right">得分</th><th style="text-align:right">贡献</th></tr>
    ${rows}
    <tr><td><b>工况风险合计</b></td><td></td><td></td>
        <td><b>${(total * 100).toFixed(1)}%</b></td></tr>
  </table>`;
}

function openCalib(code){
  const d = S.state.devices.find(x => x.code === code);
  if (!d) return;
  S.calibCode = code;
  byId("calibTitle").textContent = "工况校准 · " + d.name;
  const c = d.calib || {};
  const put = (id, key, def) => {
    byId(id).value = (c[key] === undefined ? def : c[key]);
  };
  put("c_env_severity", "env_severity", 3);
  put("c_humidity", "humidity", 2);
  put("c_dust", "dust", 2);
  put("c_water_drip", "water_drip", 0);
  put("c_plan_maintain", "plan_maintain", 4);
  put("c_fault_count", "fault_count", 1);
  put("c_load_rate", "load_rate", 80);
  const putOv = (id, key) => {
    const v = c[key];
    byId(id).value = (v === undefined || v === null) ? "" : v;
  };
  putOv("c_ov_env_temp", "ov_env_temp");
  putOv("c_ov_dev_temp", "ov_dev_temp");
  putOv("c_ov_current", "ov_current");
  byId("calibErr").style.display = "none";
  byId("calibPreview").innerHTML =
    factorTable(d.cond_items, d.cond_risk || 0) +
    `<p class="hint">综合风险 = 1 − (1 − 模型风险) × (1 − 工况风险)，任一偏高都会抬高风险。</p>`;
  openDrawer("calibDrawer");
}

function closeCalib(){ closeDrawer("calibDrawer"); }

async function submitCalib(){
  const val = id => byId(id).value;
  const payload = {
    code: S.calibCode,
    env_severity: val("c_env_severity"),
    humidity: val("c_humidity"),
    dust: val("c_dust"),
    water_drip: val("c_water_drip"),
    plan_maintain: val("c_plan_maintain"),
    fault_count: val("c_fault_count"),
    load_rate: val("c_load_rate"),
    ov_env_temp: val("c_ov_env_temp"),
    ov_dev_temp: val("c_ov_dev_temp"),
    ov_current: val("c_ov_current"),
  };
  try{
    const res = await api("/api/calibration", {method: "POST",
      headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
    byId("calibPreview").innerHTML = factorTable(res.items, res.cond_risk || 0);
    await changed();
    openCalib(S.calibCode);
  }catch(e){
    const box = byId("calibErr");
    box.style.display = "block";
    box.textContent = e.message;
  }
}

async function resetCalib(){
  try{
    await api("/api/calibration/reset", {method: "POST",
      headers: {"Content-Type": "application/json"}, body: JSON.stringify({code: S.calibCode})});
  }catch(e){ alert(e.message); }
  await changed();
  openCalib(S.calibCode);
}

/* ---------------------------------------------------------------- 台账导入 */
/* 台账是唯一一份、导错了没法还原的资产，所以导入分两步：
   先 dry_run 预检（服务端只读不写，把「新增几台 / 覆盖几台 / 哪几行有问题 /
   几台会没有实测数据」摆出来），用户看清了再点「确认导入」真写。
   文件由浏览器读出来再 POST，服务端不落地临时文件。 */
const IMPORT_MAX_BYTES = 900000;      // 服务端请求体上限 1 MB，留点余量提前挡下来说清楚
/* .xlsx 是二进制，base64 之后体积涨 4/3，能在浏览器里读的原始大小就比 CSV 小一圈。
   真台账都在几十 KB 量级，大到超这个数的多半是整本工作簿（几十个 sheet）而不是台账那页。 */
const IMPORT_MAX_XLSX_BYTES = 700000;

function openImport(){
  if (!has("importDrawer")) return;
  S.imp = {text: "", xlsx: "", name: "", summary: null, canApply: false, phase: "idle"};
  byId("importErr").style.display = "none";
  byId("importPreview").innerHTML = "";
  byId("importFile").value = "";
  closeAll();
  openDrawer("importDrawer");
  paintImport();
}

function closeImport(){ closeDrawer("importDrawer"); }

/* 出错就回到「还没预检过」：确认导入必须重新预检才能点，避免拿着旧结果反复写库 */
function importError(msg){
  const box = byId("importErr");
  box.style.display = "block";
  box.textContent = msg;
  S.imp.summary = null;
  S.imp.canApply = false;
  S.imp.phase = "idle";
  byId("importPreview").innerHTML = "";
  paintImport();
}

/* Excel 在中文 Windows 上另存的 CSV 常常是 GBK，按 UTF-8 解出来满屏乱码，
   看到替换符就换 GB18030 重读一次，别让现场拿一份乱码文件去预检。 */
function readCsvFile(file){
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("文件读不出来，检查它是不是正被 Excel 占用"));
    const retry = () => {
      const fr = new FileReader();
      fr.onerror = fail;
      fr.onload = () => resolve(String(fr.result || ""));
      try{
        fr.readAsText(file, "gb18030");
      }catch(e){
        reject(new Error("这个浏览器读不了 GBK 编码的 CSV，请在 Excel 里另存为「CSV UTF-8」再导"));
      }
    };
    const fr = new FileReader();
    fr.onerror = fail;
    fr.onload = () => {
      const text = String(fr.result || "");
      if (text.indexOf("\ufffd") >= 0){ retry(); return; }
      resolve(text);
    };
    fr.readAsText(file, "utf-8");
  });
}

/* ArrayBuffer → base64。分块拼是因为 String.fromCharCode.apply 一次塞几十万个字节
   会直接爆栈，而现场那份带格式的表恰好就有多大。 */
function bufToBase64(buf){
  const bytes = new Uint8Array(buf);
  const CH = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CH){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function readXlsxFile(file){
  return file.arrayBuffer().then(bufToBase64).catch(() => {
    throw new Error("文件读不出来，检查它是不是正被 Excel 占用（Excel 开着同一份文件时读不到）");
  });
}

/* 扩展名不能信：现场那份「设备表.xlsx」可能是文本，也可能是 97-2003 的老 .xls，
   只是手抖改了个名字。所以读头 4 个字节判内容 —— "PK" 是 xlsx（本质是个 zip），
   D0 CF 11 E0 是老 .xls（这种 Excel 直接读会报一堆乱码，得让它知道怎么补救），
   其余都按 CSV 文本走服务端那套分隔符嗅探。 */
const XLS_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

async function pickImportFile(){
  const input = byId("importFile");
  const f = input.files && input.files[0];
  S.imp.text = "";
  S.imp.xlsx = "";
  S.imp.name = "";
  S.imp.summary = null;
  S.imp.canApply = false;
  S.imp.phase = "idle";
  if (!f){ byId("importPreview").innerHTML = ""; paintImport(); return; }
  let head;
  try{
    head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
  }catch(e){
    input.value = "";
    importError("文件读不出来，检查它是不是正被 Excel 占用");
    return;
  }
  const isXlsx = head[0] === 0x50 && head[1] === 0x4b;
  if (!isXlsx && XLS_MAGIC.every((b, i) => head[i] === b)){
    input.value = "";
    importError("这是 Excel 97-2003 的 .xls，系统读不了这么老的格式。" +
                "请在 Excel 里「文件 → 另存为」，类型选 Excel 工作簿 (.xlsx) 或 CSV UTF-8 再导。");
    return;
  }
  const cap = isXlsx ? IMPORT_MAX_XLSX_BYTES : IMPORT_MAX_BYTES;
  if (f.size > cap){
    input.value = "";
    importError("这个文件有 " + (f.size / 1048576).toFixed(1) + " MB，一次导不完。" +
                (isXlsx ? "Excel 一次只读第一个工作表，且最多 500 行；" : "") +
                "请在 Excel 里拆成几份（每份不超过 500 行）分次导。");
    return;
  }
  try{
    if (isXlsx) S.imp.xlsx = await readXlsxFile(f);
    else S.imp.text = await readCsvFile(f);
    S.imp.name = f.name;
    byId("importErr").style.display = "none";
    byId("importPreview").innerHTML =
      `<p class="hint">已读取 ${esc(f.name)}（${(f.size / 1024).toFixed(0)} KB` +
      (isXlsx ? "，Excel 原文件，只读第一个工作表" : "") +
      `），点「预检」看会改成什么样。</p>`;
  }catch(e){
    input.value = "";
    importError(e.message);
  }
  paintImport();
}

/* 一份文件只落一种形态：Excel 传 base64 由服务端 openpyxl 解，其余传文本。
   预检和确认导入必须用同一个口径拼，否则预检看的是 A 文件、写的是 B 文件。 */
function impPicked(){ return !!(S.imp.text || S.imp.xlsx); }

function impBody(dry){
  const body = {mode: byId("importMode").value, dry_run: dry};
  if (S.imp.xlsx) body.xlsx_b64 = S.imp.xlsx;
  else body.text = S.imp.text;
  return JSON.stringify(body);
}

async function checkImport(){
  if (!impPicked()){ importError("先选择要导入的文件（Excel 的 .xlsx 或 CSV）。"); return; }
  if (S.imp.phase === "checking" || S.imp.phase === "writing") return;
  S.imp.phase = "checking";
  paintImport();
  try{
    const r = await api("/api/device/import", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: impBody(true),
    });
    S.imp.summary = r;
    S.imp.canApply = (r.added + r.updated) > 0;
    S.imp.phase = "ready";
    byId("importErr").style.display = "none";
  }catch(e){
    importError(e.message);
    return;
  }
  paintImport();
}

async function runImport(){
  if (!S.imp.canApply || S.imp.phase === "writing") return;
  S.imp.phase = "writing";
  paintImport();
  try{
    const r = await api("/api/device/import", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: impBody(false),
    });
    S.imp.summary = r;
    S.imp.canApply = false;          // 一份文件只让导一次，要再导得重新预检
    S.imp.phase = "done";
    S.imp.text = "";
    S.imp.xlsx = "";
    byId("importFile").value = "";
    // 本页立刻重画，另外两个页签（风险概览 / 智能分析）同时收到广播
    await changed();
  }catch(e){
    /* 服务端逐条写入，失败时前面的行已经落库，所以这里也要刷新一遍状态，
       否则看板还停在导入前，看着像「导入失败 = 什么都没改」。 */
    S.imp.phase = "idle";
    importError("导入中断：" + e.message +
                "　已经写进去的部分不会回滚，风险概览已按当前台账刷新，请核对后重新预检。");
    await changed();
  }
  paintImport();
}

/* 按钮可用性和预检结果都只从 S.imp 这一份状态推导，不在各处手改 textContent。 */
function paintImport(){
  const check = byId("btnImportCheck"), go = byId("btnImportGo");
  if (!check || !go) return;
  const p = S.imp.phase;
  const busy = p === "checking" || p === "writing";
  check.disabled = busy || !impPicked();
  check.textContent = p === "checking" ? "预检中…" : "预检";
  go.disabled = p !== "ready" || !S.imp.canApply;
  go.textContent = p === "writing" ? "导入中…" : (p === "done" ? "已导入" : "确认导入");
  if (S.imp.summary) byId("importPreview").innerHTML = importSummaryHTML(S.imp.summary, p === "done");
}

function importSummaryHTML(r, done){
  const o = r.overview || null;
  const badColor = r.failed ? "var(--red)" : "#6b829c";
  const errs = (r.errors || []).map(e =>
    `<li class="ai-item"><div class="t">第 ${esc(e.line)} 行 · ${esc(e.code)}</div>
       <div class="d">${esc(e.reason)}</div></li>`).join("");
  return `<div class="ai-panel" style="margin:12px 0 0">
    <div class="ai-hd"><span class="ai-tag">${done ? "导入完成" : "预检结果"}</span>
      <span class="hint" style="margin:0">${esc(S.imp.name || "")}
        分隔符 ${esc(r.delimiter)}　识别 ${r.total} 行</span></div>
    <div class="ai-nums">
      <div class="ai-num"><b>${r.added}</b>新增台</div>
      <div class="ai-num"><b>${r.updated}</b>覆盖台</div>
      <div class="ai-num"><b>${r.skipped}</b>跳过台</div>
      <div class="ai-num"><b style="color:${badColor}">${r.failed}</b>行有问题</div>
      <div class="ai-num"><b style="color:#8a97a8">${r.no_data}</b>没有实测</div>
    </div>
    ${!done && !S.imp.canApply && !r.failed
      ? `<p class="hint">这份文件里没有要新增或覆盖的设备（都是已存在且选了「跳过」），
          不用导入。</p>` : ""}
    ${r.unknown && r.unknown.length
      ? `<p class="hint">这几列系统不认识，已忽略：${esc(r.unknown.join("、"))}</p>` : ""}
    ${errs ? `<div class="ai-block"><h5 style="margin:8px 0 6px">有问题的行${r.errors_hidden ? "（列了 " + r.errors.length + " 条，另有 " + r.errors_hidden + " 条没显示）" : ""}</h5>
        <ul class="ai-list">${errs}</ul></div>` : ""}
    ${r.no_data ? `<p class="hint">其中 ${r.no_data} 台还没有运行记录，导进来先按「无数据」灰点显示；
        接入采集数据或补上历史记录后，分级会自动出来。风险数值不会因为这些设备没有数据而失真。</p>` : ""}
    ${o ? `<p class="hint">风险概览已同步：现在共 ${o.total} 台 ——
        报警 ${o.counts.red || 0}、预警 ${o.counts.orange || 0}、关注 ${o.counts.yellow || 0}、
        正常 ${o.counts.green || 0}、无数据 ${o.counts.gray || 0}。
        平均风险 ${o.mean_risk === null || o.mean_risk === undefined ? "—" : (o.mean_risk * 100).toFixed(1) + "%"}。</p>` : ""}
    ${!done && r.failed ? `<p class="hint">有问题的行这次不会写入，其余行照常导入。
        要一行都不丢，请先在 Excel 里按上面的行号改完再导。</p>` : ""}
  </div>`;
}

/* ---------------------------------------------------------------- 抽屉管理 */
/* 三个抽屉共用一套遮罩；谁开着，关闭时就按原样收回，避免互相抢层级。 */
let OPEN_DRAWERS = new Set();

/* 抽屉打开时把右下角的问答悬浮球让位，否则它会压在抽屉内容上 */
function syncFab(){
  document.body.classList.toggle("drawer-open", OPEN_DRAWERS.size > 0);
}

function openDrawer(id){
  byId("mask").classList.add("on");
  byId(id).classList.add("on");
  OPEN_DRAWERS.add(id);
  restackDrawers();
  syncFab();
}

/* 四个抽屉在 CSS 里同为 z-index:51，分层只能按 DOM 注入顺序定 —— aiDrawer 是
   analysis.js 最后注入的，于是从「解读」里点「改现场填报」，新开的校准抽屉整个压在
   解读抽屉底下：按钮点不到，看着就像控件失效。Set 的插入序就是打开序
   （重开会 delete+add 移到末尾），按它重排成"后开的在上"。
   最高只到 51+4，仍低于 QA 面板和悬浮球的 60，不会把问答压住。 */
function restackDrawers(){
  let z = 51;
  OPEN_DRAWERS.forEach(id => {
    const el = byId(id);
    if (el) el.style.zIndex = String(++z);
  });
}

function closeDrawer(id){
  const el = byId(id);
  if (el) el.classList.remove("on");
  OPEN_DRAWERS.delete(id);
  if (!OPEN_DRAWERS.size) byId("mask").classList.remove("on");
  syncFab();
}

function closeAll(){
  ["drawer", "calibDrawer", "aiDrawer", "importDrawer"].forEach(id => {
    const el = byId(id);
    if (el) el.classList.remove("on");
  });
  byId("mask").classList.remove("on");
  OPEN_DRAWERS = new Set();
  syncFab();
}

/* ---------------------------------------------------------------- 事件委托 */
/* 卡片、表格、巷道列表由服务端数据渲染，不拼 onclick 字符串，
   改成 data-act / data-code / data-tunnel，从根上断掉属性注入路径。 */
function bindDelegates(){
  const bind = (id, evt, map) => {
    const box = id === document ? document : byId(id);
    if (!box) return;
    box.addEventListener(evt, e => {
      const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
      if (!el || !box.contains(el)) return;
      const fn = map[el.dataset.act];
      if (fn) fn(el);
    });
  };
  const act = {
    calib: el => openCalib(el.dataset.code),
    edit: el => editDevice(el.dataset.code),
    del: el => delDevice(el.dataset.code, el.dataset.name || ""),
    ai: el => window.SmartAnalysis && SmartAnalysis.openDevice(el.dataset.code),
  };
  /* 卡片、表格是静态容器，但「逐台归因」表和 AI 抽屉里的按钮由智能分析异步渲染，
     boot 时还不存在，绑到具体节点上会漏掉它们，所以统一委托到 document。 */
  bind(document, "click", act);
  bind("envList", "click", {"del-tunnel": el => delTunnel(el.dataset.tunnel)});
  bind("envList", "change", {"env-temp": el => saveEnv(el.dataset.tunnel, el.value)});
  document.addEventListener("keydown", e => {
    if (e.key === "Escape"){
      if (window.QA && QA.isOpen()){ QA.close(); return; }
      closeAll();
    }
  });
}

/* ---------------------------------------------------------------- 启动入口 */
/* 遮罩 + 三个抽屉在三个页面里完全一样，改由 JS 注入一次，避免同一份标记
   在 index/risk/devices 里各抄一遍、日后改一处漏两处。 */
const CHROME_HTML = `
<div class="mask" id="mask"></div>
<aside class="drawer" id="calibDrawer">
  <h2 id="calibTitle">工况校准</h2>
  <p class="hint">这些是现场量化输入，用于把模型原始概率校准成现场风险。
    只调整风险系数，不重新训练模型。</p>
  <div id="calibErr" class="warn" style="display:none"></div>
  <label>环境严酷度（1 良好 ~ 5 恶劣）</label>
  <input id="c_env_severity" type="number" min="1" max="5" step="1" value="3" />
  <div class="row2">
    <div><label>湿度等级（1/2/3）</label><input id="c_humidity" type="number" min="1" max="3" step="1" value="2" /></div>
    <div><label>粉尘等级（1/2/3）</label><input id="c_dust" type="number" min="1" max="3" step="1" value="2" /></div>
  </div>
  <label>是否淋水</label>
  <select id="c_water_drip"><option value="0">否</option><option value="1">是</option></select>
  <div class="row2">
    <div><label>近三个月检修次数</label><input id="c_plan_maintain" type="number" min="0" max="24" step="1" value="3" /></div>
    <div><label>近三个月故障次数</label><input id="c_fault_count" type="number" min="0" max="50" step="1" value="1" /></div>
  </div>
  <label>实际负载率（%）</label>
  <input id="c_load_rate" type="number" min="0" max="150" step="1" value="80" />
  <label>手动实测工况（留空则使用最新实测值）</label>
  <div class="row2">
    <div><label>环境温度 ℃</label><input id="c_ov_env_temp" type="number" step="0.5" placeholder="留空=实测" /></div>
    <div><label>设备温度 ℃</label><input id="c_ov_dev_temp" type="number" step="0.5" placeholder="留空=实测" /></div>
  </div>
  <div class="row2">
    <div><label>运行电流 A</label><input id="c_ov_current" type="number" step="1" placeholder="留空=实测" /></div>
  </div>
  <div id="calibPreview"></div>
  <div class="btn-row">
    <button class="btn" onclick="submitCalib()">保存校准</button>
    <button class="btn ghost" onclick="resetCalib()">恢复默认</button>
    <button class="btn ghost" onclick="closeCalib()">关闭</button>
  </div>
</aside>
<aside class="drawer" id="drawer">
  <h2 id="formTitle">新增设备</h2>
  <p class="hint">编号保存后不可修改；额定电压/电流必须大于 0，填 0 会带着 0 去算风险。</p>
  <div id="formErr" class="warn" style="display:none"></div>
  <label>设备编号 *</label><input id="f_code" placeholder="如 PU-002" />
  <label>设备名称 *</label><input id="f_name" placeholder="如 2#排水泵" />
  <label>设备类型 *</label><select id="f_type"></select>
  <label>安装位置（巷道）</label><input id="f_location" placeholder="如 水泵房" />
  <div class="row2">
    <div><label>额定电压 kV</label><input id="f_rated_v" type="number" step="0.01" value="0.66" /></div>
    <div><label>额定电流 A</label><input id="f_rated_i" type="number" step="1" value="100" /></div>
  </div>
  <div class="row2">
    <div><label>额定功率 kW</label><input id="f_rated_p" type="number" step="1" value="75" /></div>
    <div><label>投运日期</label><input id="f_commission" type="date" /></div>
  </div>
  <div class="row2">
    <div><label>运行状态</label><select id="f_status"></select></div>
    <div><label>生产厂家</label><input id="f_maker" /></div>
  </div>
  <label>备注</label><textarea id="f_remark" rows="3"></textarea>
  <div class="btn-row">
    <button class="btn" onclick="submitForm()">保存</button>
    <button class="btn ghost" onclick="closeForm()">取消</button>
    <button class="btn danger" id="btnDelDevice" style="display:none" onclick="deleteCurrent()">删除设备</button>
  </div>
</aside>
<aside class="drawer" id="importDrawer">
  <h2>导入台账</h2>
  <p class="hint">直接选 Excel 存的 .xlsx 原文件就行，也可以选 CSV（逗号 / 分号 / Tab / 竖线
    分隔，GBK 编码的也认）。表头认中文也认英文，设备编号 / 设备名称 / 设备类型 三列必须有，
    一次最多 500 行；.xlsx 有多张工作表时只读第一张。
    先点「预检」看会改成什么样，确认没问题再点「确认导入」。</p>
  <div id="importErr" class="warn" style="display:none"></div>
  <label>选择 Excel / CSV 文件 *</label>
  <input id="importFile" type="file"
         accept=".xlsx,.csv,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
         onchange="pickImportFile()" />
  <label>编号已在台账里时</label>
  <select id="importMode">
    <option value="upsert">覆盖台账里这台同编号设备</option>
    <option value="skip">跳过，保留台账里已有的信息</option>
  </select>
  <div id="importPreview"></div>
  <div class="btn-row">
    <button class="btn ghost" id="btnImportCheck" type="button" onclick="checkImport()" disabled>预检</button>
    <button class="btn" id="btnImportGo" type="button" onclick="runImport()" disabled>确认导入</button>
    <a class="btn ghost" href="/api/device/template.csv" download>下载模板</a>
    <button class="btn ghost" type="button" onclick="closeImport()">关闭</button>
  </div>
</aside>
<aside class="drawer" id="aiDrawer" data-ai-scope="1"></aside>`;

function injectChrome(){
  if (has("mask")) return;
  const holder = document.createElement("div");
  holder.innerHTML = CHROME_HTML;
  while (holder.firstChild) document.body.appendChild(holder.firstChild);
  byId("mask").addEventListener("click", closeAll);
}

/* ---------- 顶部导航 ----------
   三个页签在三个页面里一字不差地抄了三份，改名字要改三处，于是收到这里注入：
   页面 HTML 里没写 .nav 就自动生成，写了就用页面自己的（万一要临时加页签）。
   每一项都带一句话说明"这页干什么"，鼠标悬停能看，现场人员不容易点错。 */
const NAV_ITEMS = [
  {href: "/", label: "风险概览", title: "今天哪几台最该管，为什么"},
  {href: "/risk", label: "智能分析", title: "全设备归因、治理方案、一台一台看"},
  {href: "/devices", label: "设备台账", title: "录入维护设备信息、巷道环境温度"},
  {href: "/report", label: "今日报告", title: "核实风险设备、记录故障原因和处理办法"},
  {href: "/model-center", label: "模型训练中心", title: "人工反馈、训练数据和 HGBT 模型迭代"},
];

function injectNav(){
  if (document.querySelector(".nav")) return;
  const nav = document.createElement("nav");
  nav.className = "nav";
  nav.innerHTML = NAV_ITEMS.map(n =>
    `<a href="${n.href}" title="${esc(n.title)}">${esc(n.label)}</a>`).join("");
  const main = document.querySelector("main");
  document.body.insertBefore(nav, main || document.body.firstChild);
}

/* ---------- 页内页签 ----------
   页签状态放在 URL hash（/#tab=events）：书签、前进后退、别的页面深链都落在同一处。
   切换只动 aria-selected 与面板 hidden，不发请求 —— 取数仍归 boot() 的 15 秒轮询。
   每页一组；hash 缺失或写了本页没有的页签，一律落第一个，不白屏。 */
function tabFromHash(){
  // 手打的坏百分号（#tab=%E4%B8）会让 decodeURIComponent 抛 URIError；这里必须吞掉：
  // tabFromHash 在 boot() 中段的 initTabs() 里被调，抛出会把整次 boot 断掉（委托绑一半、轮询起不来）。
  let hash = "";
  try { hash = decodeURIComponent(location.hash.slice(1)); } catch (e) { return ""; }
  const m = /(?:^|[&?])tab=([^&]+)/.exec(hash);
  return m ? m[1] : "";
}

function activateTab(bar, id, push){
  const btns = [...bar.querySelectorAll(".tab-btn")];
  if (!btns.length) return "";
  const hit = btns.find(b => b.dataset.tab === id) || btns[0];
  btns.forEach(b => b.setAttribute("aria-selected", String(b === hit)));
  hit.tabIndex = 0;
  btns.filter(b => b !== hit).forEach(b => { b.tabIndex = -1; });
  const panels = bar.parentElement ? [...bar.parentElement.querySelectorAll(":scope > .tab-panel")] : [];
  panels.forEach(p => { p.hidden = p.id !== hit.getAttribute("aria-controls"); });
  if (push && location.hash !== "#tab=" + hit.dataset.tab) {
    // replaceState 不压历史栈：后退键应该退到上一页，而不是退回上一个页签
    history.replaceState(null, "", "#tab=" + hit.dataset.tab);
  }
  return hit.dataset.tab;
}

function tabBars(){ return [...document.querySelectorAll(".tabs")]; }

function initTabs(){
  tabBars().forEach(bar => {
    bar.addEventListener("click", e => {
      const b = e.target.closest(".tab-btn");
      if (b && bar.contains(b)) activateTab(bar, b.dataset.tab, true);
    });
    bar.addEventListener("keydown", e => {
      const btns = [...bar.querySelectorAll(".tab-btn")];
      const at = btns.indexOf(document.activeElement);
      if (at < 0) return;
      let to = -1;
      if (e.key === "ArrowRight") to = (at + 1) % btns.length;
      else if (e.key === "ArrowLeft") to = (at - 1 + btns.length) % btns.length;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = btns.length - 1;
      if (to < 0) return;
      e.preventDefault();
      btns[to].focus();
      activateTab(bar, btns[to].dataset.tab, true);
    });
    activateTab(bar, tabFromHash(), false);
  });
  window.addEventListener("hashchange", () => {
    const id = tabFromHash();
    if (id) tabBars().forEach(bar => activateTab(bar, id, false));
  });
}

function boot(cfg){
  S.cfg = Object.assign({}, S.cfg, cfg || {});
  // 合并后的页面会加载两份脚本、各自都调 boot；不挡住就绑两套事件委托、起两个 15 秒轮询。
  if (S.booted) return;
  S.booted = true;
  // 每页条数的默认值由页面传入，用户在下拉里改过就以用户选的为准
  S.pager.cards.size = S.cfg.cardPage || 0;
  S.pager.table.size = S.cfg.rowPage || 0;
  injectChrome();
  injectNav();
  initTabs();
  fillHmNotes();
  const here = location.pathname.replace(/\.html$/, "") || "/";
  document.querySelectorAll(".nav a").forEach(a => {
    const href = a.getAttribute("href").replace(/\.html$/, "");
    if (href === here || (here === "/" && href === "/")) a.setAttribute("aria-current", "page");
  });
  bindDelegates();
  bindPager();
  bindTableFilter();
  watchRemoteChange();
  load();
  setInterval(load, 15000);
  // 切走标签页时浏览器会把 15 秒定时器压到几乎不跑，回到页面往往看到的是旧快照。
  // 补一次「切回来立刻拉新数据」，现场演示切屏回来数字就是当前这一轮的。
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  if (window.SmartAnalysis) SmartAnalysis.mountAll();
  if (window.QA) QA.mount();
}

const App = {
  boot, load, esc, fmt, byId, has, api, factorTable, openDrawer, closeDrawer, closeAll,
  paginate, pagerHTML,
  pagerState: key => S.pager[key],
  state: () => S.state,
  cfg: () => S.cfg,
  device: code => (S.state ? S.state.devices.find(d => d.code === code) : null),
  onState: fn => S.hooks.onState.push(fn),
  onRender: fn => S.hooks.onRender.push(fn),
  openCalib, openForm,
};
window.App = App;
