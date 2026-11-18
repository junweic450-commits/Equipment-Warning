/* ==========================================================================
   chat.js · 悬浮「问 AI」控件（云知声 Agent，服务端代理 + SSE 流式）
   密钥只在后端，浏览器只跟本机 /api/agent/chat 说话；上游不可用时明确
   显示降级原因，不伪造回答。

   同样包在 IIFE 里：这里的 byId / refreshStatus 曾经是顶层函数，会把
   common.js / analysis.js 的同名实现顶掉（经典 script 共享全局 function 域）。
   对外只暴露 window.QA。
   ========================================================================== */
"use strict";

(function(){

const QA = {
  shown: false,
  busy: false,
  code: "",
  history: [],
  node: null,
};

const QA_KEY = "qa.history.v1";

/* 悬浮球：位置（视口 left/top）单独存 localStorage，刷新和换页都停在用户放的地方 */
const FAB_KEY = "qa.fab.pos.v1";
const FAB_MARGIN = 14;
const NARROW = window.matchMedia("(max-width:640px)");

/* 会话气泡 + 星芒，配文字标签，一眼能认出是问答入口。
   纯常量标记，不拼任何动态内容。 */
const FAB_HTML = `<svg class="fi" viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
  + `<rect x="2.2" y="5.4" width="17.4" height="12.6" rx="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/>`
  + `<path d="M7.4 17.6v4.2l4.3-4.2z" fill="currentColor"/>`
  + `<path d="M10.9 8.4l.95 2.45 2.45.95-2.45.95-.95 2.45-.95-2.45-2.45-.95 2.45-.95z" fill="currentColor"/>`
  + `<path d="M20.6 1.1l.55 1.5 1.5.55-1.5.55-.55 1.5-.55-1.5-1.5-.55 1.5-.55z" fill="currentColor" opacity=".85"/>`
  + `</svg><span class="ft">智能问答</span>`;

let suppressFabClick = false;

const QUICK = [
  "今天最该处理什么？",
  "风险最高的那台为什么高？",
  "潮湿、粉尘该怎么弄？",
  "这周检修怎么排？",
];

/* ---------------------------------------------------------------- SSE 解析 */
async function stream(payload, handlers){
  const h = handlers || {};
  const body = Object.assign({history: QA.history, code: QA.code}, payload || {});
  if (h.onStart) h.onStart();
  QA.busy = true;
  let resp;
  try{
    resp = await fetch("/api/agent/chat", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
  }catch(e){
    if (h.onError) h.onError("无法连接本地服务：" + e.message);
    QA.busy = false;
    if (h.onDone) h.onDone(false);
    return;
  }
  if (!resp.ok){
    let msg = "HTTP " + resp.status;
    try{ msg = (await resp.json()).error || msg; }catch(e){ /* 保留状态码 */ }
    if (h.onError) h.onError(msg);
    QA.busy = false;
    if (h.onDone) h.onDone(false);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let pending = "", content = "", reasoning = "", clean = false;
  const feed = chunk => {
    pending += chunk;
    let cut;
    while((cut = pending.indexOf("\n\n")) >= 0){
      const block = pending.slice(0, cut);
      pending = pending.slice(cut + 2);
      block.split("\n").forEach(line => {
        if (!line.startsWith("data:")) return;
        let ev;
        try{ ev = JSON.parse(line.slice(5).trim()); }catch(e){ return; }
        if (ev.type === "content"){ content += ev.text || ""; if (h.onContent) h.onContent(ev.text || ""); }
        else if (ev.type === "reasoning"){ reasoning += ev.text || ""; if (h.onReasoning) h.onReasoning(ev.text || ""); }
        else if (ev.type === "error"){ if (h.onError) h.onError(ev.error || "AI 这次没成功"); }
        else if (ev.type === "done"){ clean = !!ev.clean; }
      });
    }
  };

  try{
    for(;;){
      const {done, value} = await reader.read();
      if (done) break;
      feed(decoder.decode(value, {stream: true}));
    }
    feed(decoder.decode());
  }catch(e){
    if (h.onError) h.onError("连接中断：" + e.message);
  }
  QA.busy = false;
  if (h.onDone) h.onDone(clean, content, reasoning);
}

/* ---------------------------------------------------------------- DOM 构建 */
function mount(){
  if (QA.node || document.getElementById("qaFab")) return;
  const fab = document.createElement("button");
  fab.className = "fab";
  fab.id = "qaFab";
  fab.type = "button";
  fab.setAttribute("draggable", "false");
  fab.title = "智能问答 · 按住可拖动位置";
  fab.setAttribute("aria-label", "打开智能问答，按住可拖动位置");
  fab.innerHTML = FAB_HTML;

  const panel = document.createElement("section");
  panel.className = "qa";
  panel.id = "qaPanel";
  panel.setAttribute("aria-label", "智能问答");
  panel.innerHTML = `
    <div class="qa-hd"><b>智能问答</b><span class="hint" style="margin:0;color:rgba(255,255,255,.85)" id="qaModel"></span>
      <button class="x" type="button" id="qaClose">关闭 ✕</button></div>
    <div class="qa-ctx" id="qaCtx"></div>
    <div class="qa-body" id="qaBody"></div>
    <div class="qa-quick" id="qaQuick"></div>
    <div class="qa-input">
      <textarea id="qaText" rows="1" placeholder="问点什么，Enter 发送 / Shift+Enter 换行"></textarea>
      <button class="btn ai" type="button" id="qaSend">发送</button>
    </div>`;
  document.body.appendChild(fab);
  document.body.appendChild(panel);
  QA.node = panel;

  const saved = savedFabPos();
  if (saved) placeFab(saved.x, saved.y);
  bindFabDrag(fab);
  fab.addEventListener("click", () => {
    if (suppressFabClick) return;   /* 拖动结束紧跟的那次 click 不算打开 */
    QA.shown ? closePanel() : openPanel();
  });
  /* 这里原来绑的是 close —— IIFE 里没有这个名字，实际取到的是 window.close()，
     浏览器不允许脚本关掉用户自己打开的标签页，所以点"关闭 ✕"看起来没反应。 */
  byId("qaClose").addEventListener("click", closePanel);
  byId("qaSend").addEventListener("click", () => send());
  byId("qaText").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); send(); }
  });
  byId("qaQuick").innerHTML = QUICK.map(q =>
    `<button type="button" data-quick="${App.esc(q)}">${App.esc(q)}</button>`).join("");
  byId("qaQuick").addEventListener("click", e => {
    const b = e.target.closest("[data-quick]");
    if (b){ byId("qaText").value = b.dataset.quick; send(); }
  });
  byId("qaCtx").addEventListener("click", e => {
    if (e.target.id === "qaClearCtx"){ QA.code = ""; renderCtx(); }
  });
  /* 视口变化（缩窗、软键盘）后把球夹回屏内、面板重贴一次 */
  const onViewChange = () => {
    reclampFab();
    if (QA.shown) placePanel();
  };
  window.addEventListener("resize", onViewChange);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", onViewChange);
  if (NARROW.addEventListener) NARROW.addEventListener("change", onViewChange);
  loadHistory();
  refreshChip();
}

/* ---------------------------------------------------------------- 悬浮球拖动 */
function fabEl(){ return document.getElementById("qaFab"); }

/* position:fixed 的包含块是不含滚动条的那块视口，window.innerWidth 却把滚动条算进去，
   直接用 innerWidth 夹取会让球压住右侧滚动条约 15px。 */
function viewW(){ return Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth); }
function viewH(){ return Math.min(window.innerHeight, document.documentElement.clientHeight || window.innerHeight); }

function clampFab(x, y){
  const el = fabEl();
  const maxX = Math.max(FAB_MARGIN, viewW() - el.offsetWidth - FAB_MARGIN);
  const maxY = Math.max(FAB_MARGIN, viewH() - el.offsetHeight - FAB_MARGIN);
  return [Math.min(Math.max(x, FAB_MARGIN), maxX), Math.min(Math.max(y, FAB_MARGIN), maxY)];
}

function placeFab(x, y){
  const el = fabEl();
  if (!el) return;
  const p = clampFab(x, y);
  el.style.left = p[0] + "px";
  el.style.top = p[1] + "px";
  el.style.right = "auto";
  el.style.bottom = "auto";
}

/* 直接读内联值，别绕 getBoundingClientRect —— :hover 的 scale 会把 rect 放大几 px */
function fabPos(el){ return [parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0]; }

/* 没拖过的球由 CSS 的 right/bottom 定位，缩窗天然不会跑出屏幕 */
function reclampFab(){
  const el = fabEl();
  if (!el || el.style.left === "") return;
  const p = fabPos(el);
  placeFab(p[0], p[1]);
}

function savedFabPos(){
  try{
    const p = JSON.parse(localStorage.getItem(FAB_KEY) || "null");
    return (p && Number.isFinite(p.x) && Number.isFinite(p.y)) ? p : null;
  }catch(e){ return null; }
}

function saveFabPos(el){
  try{ localStorage.setItem(FAB_KEY, JSON.stringify({x: fabPos(el)[0], y: fabPos(el)[1]})); }
  catch(e){ /* 隐私模式忽略 */ }
}

function bindFabDrag(el){
  /* move/up 绑在 window 上而不是球上：球一旦跟着指针走，指针就会跑到球外面，
     绑在球上就再也收不到 pointermove，拖动只走一小步就断了。
     dragstart 也拦掉：按住不放划过页面上的 <a> 或图片时，浏览器会抢去发起
     原生拖拽，紧跟着就是一个 pointercancel，自定义拖动当场断在半路。 */
  el.addEventListener("pointerdown", e => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const r = el.getBoundingClientRect();
    /* 已经拖过的球直接读内联值，省得 :hover 的缩放把起点带偏、每次拖动再累积几 px */
    const p = el.style.left !== "" ? fabPos(el) : [r.left, r.top];
    const st = {id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: p[0], oy: p[1], moved: false};
    const noDrag = ev => ev.preventDefault();
    const move = ev => {
      if (ev.pointerId !== st.id) return;
      const dx = ev.clientX - st.sx, dy = ev.clientY - st.sy;
      if (!st.moved && Math.abs(dx) + Math.abs(dy) < 5) return;   /* 手抖不算拖动 */
      if (!st.moved){ st.moved = true; el.classList.add("dragging"); }
      placeFab(st.ox + dx, st.oy + dy);
      if (QA.shown) placePanel();
    };
    const stop = ev => {
      if (ev.pointerId !== st.id) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("dragstart", noDrag, true);
      el.classList.remove("dragging");
      if (st.moved){
        saveFabPos(el);
        suppressFabClick = true;
        setTimeout(() => { suppressFabClick = false; }, 0);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("dragstart", noDrag, true);
  });
}

/* 面板贴球展开：球在右半边就右对齐、在左半边就左对齐；上方放不下就往下开，
   两边都放不下时把面板压到放得下的那一侧的高度，保证不把球盖住。 */
function placePanel(){
  const panel = byId("qaPanel"), fab = fabEl();
  if (!panel || !fab) return;
  const vh = viewH();
  const kb = Math.max(0, vh - (window.visualViewport ? window.visualViewport.height : vh));
  if (NARROW.matches){
    /* 窄屏走整幅底部抽屉样式，只把软键盘挡掉的那截补回来 */
    panel.style.left = panel.style.top = panel.style.right = panel.style.height = "";
    panel.style.bottom = kb ? kb + "px" : "";
    return;
  }
  const vw = viewW(), m = 12, gap = 12;
  const r = fab.getBoundingClientRect();
  const w = panel.offsetWidth || Math.min(392, vw - 24);
  const maxH = Math.min(560, vh * .7);
  let h = maxH, y;
  const roomAbove = r.top - gap - m;
  const roomBelow = vh - kb - r.bottom - gap - m;
  if (roomAbove >= h) y = r.top - h - gap;
  else if (roomBelow >= h) y = r.bottom + gap;
  else if (roomAbove >= roomBelow){ y = m; h = Math.max(240, roomAbove); }
  else { y = r.bottom + gap; h = Math.max(240, roomBelow); }
  let x = (r.left + r.width / 2) > vw / 2 ? r.right - w : r.left;
  x = Math.min(Math.max(x, m), Math.max(m, vw - w - m));
  y = Math.min(Math.max(y, m), Math.max(m, vh - kb - h - m));
  panel.style.left = x + "px";
  panel.style.top = y + "px";
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  panel.style.height = h + "px";   /* 显式写高，省得 70vh 和去掉滚动条的高度对不上 */
}

function byId(id){ return document.getElementById(id); }

function openPanel(){
  mount();
  QA.shown = true;
  byId("qaPanel").classList.add("on");
  byId("qaFab").classList.add("on");
  placePanel();
  renderCtx();
  setTimeout(() => byId("qaText").focus(), 60);
}

function closePanel(){
  QA.shown = false;
  if (byId("qaPanel")) byId("qaPanel").classList.remove("on");
  if (byId("qaFab")) byId("qaFab").classList.remove("on");
}

function isOpen(){ return !!QA.shown; }

function openWithDevice(code){
  QA.code = code || "";
  openPanel();
  const d = App.device(code);
  if (d) pushMsg("u", "关于 " + d.name + "（" + code + "）我想继续确认处置方案。");
}

/* ---------------------------------------------------------------- 会话渲染 */
/* 上下文那行小字：五个页面都有问答入口了，这里的名字必须和顶部导航一致
   （/risk 已改名「智能分析」），对不上的路径别再冒充「设备台账」。 */
const PAGE_LABEL = {"/": "风险概览", "/risk": "智能分析", "/devices": "设备台账",
  "/report": "今日报告", "/model-center": "模型训练中心"};

function pageLabel(){
  const here = location.pathname.replace(/\.html$/, "") || "/";
  return PAGE_LABEL[here] || "本页";
}

function renderCtx(){
  const box = byId("qaCtx");
  if (!box) return;
  const d = QA.code ? App.device(QA.code) : null;
  box.innerHTML = `<span>上下文：${App.esc(pageLabel())}</span>` +
    (d ? `<span>· 设备 ${App.esc(d.name)}（${App.esc(d.code)}）</span>
          <button type="button" id="qaClearCtx">取消</button>` : "");
}

function pushMsg(role, text, extra){
  const body = byId("qaBody");
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "u" : "a");
  div.textContent = text;
  if (extra) div.dataset.live = extra;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
}

function attachReasoning(node, text){
  if (!text) return;
  const d = document.createElement("details");
  d.innerHTML = `<summary>查看推理过程（${text.length} 字）</summary>` +
    `<div style="white-space:pre-wrap;margin-top:6px">${App.esc(text)}</div>`;
  node.insertBefore(d, node.firstChild);
}

function send(){
  const input = byId("qaText");
  const q = (input.value || "").trim();
  if (!q || QA.busy) return;
  input.value = "";
  pushMsg("user", q);
  QA.history.push({role: "user", content: q});
  const node = pushMsg("assistant", "", "1");
  node.innerHTML = `<span class="cursor"></span>`;
  let live = "", liveReason = "";

  stream({question: q}, {
    onReasoning: t => {
      liveReason += t;
      node.innerHTML = `<span class="hint" style="margin:0">思考中…</span><span class="cursor"></span>`;
    },
    onContent: t => {
      live += t;
      node.innerHTML = App.esc(live) + `<span class="cursor"></span>`;
      byId("qaBody").scrollTop = byId("qaBody").scrollHeight;
    },
    onError: m => {
      node.classList.add("err");
      node.innerHTML = `<b>AI 问答暂时不能用</b>\n${App.esc(m)}\n` +
        `上面的风险数值与可行方案由本地规则引擎计算，不受影响。`;
    },
    onDone: (clean, content, reasoning) => {
      const text = content || live;
      node.removeAttribute("data-live");
      if (text){
        node.textContent = text;
        attachReasoning(node, reasoning || liveReason);
        QA.history.push({role: "assistant", content: text});
      }else if (!node.classList.contains("err")){
        node.classList.add("err");
        node.textContent = "AI 没给内容，可能是回应太慢或额度用完。";
      }
      saveHistory();
      byId("qaBody").scrollTop = byId("qaBody").scrollHeight;
      refreshChip();
    },
  });
}

/* ---------------------------------------------------------------- 本地历史 */
function saveHistory(){
  try{ sessionStorage.setItem(QA_KEY, JSON.stringify(QA.history.slice(-20))); }catch(e){ /* 隐私模式忽略 */ }
}

function loadHistory(){
  try{
    const raw = sessionStorage.getItem(QA_KEY);
    QA.history = raw ? JSON.parse(raw) : [];
    if (QA.history.length){
      QA.history.forEach(m => pushMsg(m.role, m.content));
      const tip = document.createElement("div");
      tip.className = "hint";
      tip.style.textAlign = "center";
      tip.textContent = "以上为本次会话的历史，";
      const btn = document.createElement("button");
      btn.className = "link";
      btn.type = "button";
      btn.textContent = "清空重新开始";
      btn.addEventListener("click", clearHistory);
      tip.appendChild(btn);
      byId("qaBody").appendChild(tip);
    }
  }catch(e){ QA.history = []; }
}

function clearHistory(){
  QA.history = [];
  try{ sessionStorage.removeItem(QA_KEY); }catch(e){ /* ignore */ }
  byId("qaBody").innerHTML = "";
  greet();
}

function greet(){
  pushMsg("assistant", "我可以帮你解读风险结果、解释某个指标为什么高、给出检修处置顺序。"
    + "风险数值来自本地计算，我的回答只做补充。");
}

/* 头部那行小字 + 智能分析面板的状态灯一起刷新：欠费 / 限流只有真调过才知道 */
async function refreshChip(){
  try{
    const r = await fetch("/api/agent/status", {cache: "no-store"});
    const s = await r.json();
    const el = byId("qaModel");
    if (el){
      el.textContent = !s.ready ? "· 未就绪"
        : (s.last_ok === false ? "· " + s.model + "（最近调用失败）" : "· " + s.model);
    }
    if (!s.ready){
      pushMsg("assistant", "问答 Agent 当前不可用：" + (s.reason || "未配置")
        + "。本地智能分析（风险解读与可行方案）不受影响。");
    }
  }catch(e){ /* 状态接口不可用时保持静默 */ }
  if (window.SmartAnalysis && SmartAnalysis.refreshAgentStatus) SmartAnalysis.refreshAgentStatus();
}

window.QA = Object.assign(QA, {
  mount(){ mount(); if (!QA.history.length) greet(); },
  open: openPanel, close: closePanel, isOpen, openWithDevice, stream,
});

})();
