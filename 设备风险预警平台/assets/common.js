/* ==========================================================================
   common.js · 全站共用：状态、渲染、抽屉、事件委托
   三个页面都加载它，页面差异由 App.boot({page, ...}) 传入的配置决定。
   ========================================================================== */
"use strict";

const S = {
  state: null,
  editing: null,
  calibCode: null,
  // cardPage / rowPage：这两处列表每页默认多少条（0 = 不分页，全量铺开）
  cfg: {cardPage: 0, rowPage: 0, fullTable: false, env: false},
  tblQ: "",            // 台账搜索词（编号 / 名称 / 巷道 / 类型）
  tblLevel: "",        // 台账分级筛选，空 = 全部
  pager: {cards: {page: 1, size: 12}, table: {page: 1, size: 24}},
  hooks: {onState: []},
};

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

/* ---------------------------------------------------------------- 状态加载 */
async function load(){
  try{
    const r = await fetch("/api/state", {cache: "no-store"});
    if (!r.ok) throw new Error("HTTP " + r.status);
    S.state = await r.json();
    render();
    S.hooks.onState.forEach(fn => { try{ fn(S.state); }catch(e){ console.error(e); } });
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
  renderFormOptions(s);
  if (S.cfg.env) renderEnv(s);
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
    ${d.error ? `<p class="hint" style="color:#a8322a">预测失败：${esc(d.error)}</p>` : ""}
    ${t.sim_time ? `<p class="hint">最新数据：${esc(t.sim_time)}</p>` : `<p class="hint">暂无运行数据，请先跑仿真</p>`}
    <button class="ai-btn" data-act="ai" data-code="${esc(d.code)}">AI 解读</button>
    <button class="calib-btn" data-act="calib" data-code="${esc(d.code)}">校准工况</button>
  </div>`;
}

/* ---------------------------------------------------------------- 分页 */
/* 台账会一直往里加设备，首页卡片和台账表格不可能一次全铺完，所以两处共用一套分页：
   每页条数可选 + 上一页/下一页 + 页码窗口（当前页居中，两端省略号）。
   页码存在 S.pager 里，15 秒轮询重绘时不会跳回第一页；数据变少（删设备、筛选变窄）
   导致页码越界时自动收到最后一页。 */
const PAGER_SIZES = [12, 24, 48, 100];

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
    <span class="pg-info">共 ${total} 台 · 第 ${cur} / ${pages} 页</span>
    <select data-pager="${key}" data-size="1" aria-label="每页显示条数">` +
      PAGER_SIZES.map(n =>
        `<option value="${n}"${n === size ? " selected" : ""}>每页 ${n} 台</option>`).join("") +
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
    S.pager[b.dataset.pager].page = Number(b.dataset.page) || 1;
    render();
  });
  document.addEventListener("change", e => {
    const sel = e.target.closest && e.target.closest("[data-pager][data-size]");
    if (!sel) return;
    const st = S.pager[sel.dataset.pager];
    st.size = Number(sel.value) || 0;
    st.page = 1;                       // 换了每页条数，回到第一页最不容易看串行
    render();
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
      ? `<a class="link" href="/risk">完整归因与治理方案 → 智能分析</a>` +
        `<a class="link" href="/devices">录入与维护 → 设备台账</a>`
      : "";
    more.style.display = all.length ? "flex" : "none";
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
    .concat(["风险", "操作"]);
  byId("tableWrap").innerHTML = `<div class="table-scroll"><table>
    <tr>${head.map(h => `<th>${h}</th>`).join("")}</tr>
    ${pg.rows.map(d => `<tr>
      <td>${esc(d.code)}</td><td>${esc(d.name)}</td><td>${esc(d.type)}</td><td>${esc(d.location || "-")}</td>
      <td>${fmt(d.rated_v, 3, "kV")}</td><td>${fmt(d.rated_i, 0, "A")}</td>
      ${full ? `<td>${fmt(d.rated_p, 0, "kW")}</td><td>${esc(d.status)}</td>
               <td>${esc(d.commission_date || "-")}</td><td>${esc(d.maker || "-")}</td>` : ""}
      <td style="color:${esc(d.level.color)};font-weight:700">${esc(d.level.name)}</td>
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
    load();
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
    type: get("f_type").value,
    location: get("f_location").trim(),
    rated_v: parseFloat(get("f_rated_v")),
    rated_i: parseFloat(get("f_rated_i")),
    rated_p: parseFloat(get("f_rated_p")),
    commission_date: get("f_commission"),
    status: get("f_status").value,
    maker: get("f_maker").trim(),
    remark: get("f_remark").trim(),
  };
  try{
    await api("/api/device", {method: "POST", headers: {"Content-Type": "application/json"},
                              body: JSON.stringify(payload)});
    closeForm();
    load();
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
    load();
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
    load();
  }catch(e){ alert(e.message); }
}

async function saveDefaultEnv(){
  try{
    await api("/api/env/default", {method: "POST", headers: {"Content-Type": "application/json"},
                                   body: JSON.stringify({temp: parseFloat(byId("defaultEnv").value)})});
    load();
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
    await load();
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
  await load();
  openCalib(S.calibCode);
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
  syncFab();
}

function closeDrawer(id){
  const el = byId(id);
  if (el) el.classList.remove("on");
  OPEN_DRAWERS.delete(id);
  if (!OPEN_DRAWERS.size) byId("mask").classList.remove("on");
  syncFab();
}

function closeAll(){
  ["drawer", "calibDrawer", "aiDrawer"].forEach(id => {
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
  <p class="hint">编号保存后不可修改；额定电压/电流必须大于 0，否则仿真会跳过该设备。</p>
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

function boot(cfg){
  S.cfg = Object.assign({}, S.cfg, cfg || {});
  // 每页条数的默认值由页面传入，用户在下拉里改过就以用户选的为准
  S.pager.cards.size = S.cfg.cardPage || 0;
  S.pager.table.size = S.cfg.rowPage || 0;
  injectChrome();
  injectNav();
  const here = location.pathname.replace(/\.html$/, "") || "/";
  document.querySelectorAll(".nav a").forEach(a => {
    const href = a.getAttribute("href").replace(/\.html$/, "");
    if (href === here || (here === "/" && href === "/")) a.setAttribute("aria-current", "page");
  });
  bindDelegates();
  bindPager();
  bindTableFilter();
  load();
  setInterval(load, 15000);
  if (window.SmartAnalysis) SmartAnalysis.mountAll();
  if (window.QA) QA.mount();
}

const App = {
  boot, load, esc, fmt, byId, has, api, factorTable, openDrawer, closeDrawer, closeAll,
  state: () => S.state,
  cfg: () => S.cfg,
  device: code => (S.state ? S.state.devices.find(d => d.code === code) : null),
  onState: fn => S.hooks.onState.push(fn),
  openCalib, openForm,
};
window.App = App;
