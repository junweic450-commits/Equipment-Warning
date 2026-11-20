import {readFileSync} from "node:fs";
import {startChrome, CDP, openPage} from "./cdp.mjs";

/* 页签原语的行为契约：落位、非法回退、aria/hidden 一致、键盘、窄屏不换行、切换不重新取数。
   每加一页，EXPECT 多一条；页面重组做完时四条都在。 */
const EXPECT = {
  "/": {bar:"风险概览分区",tabs:["board","analysis"]},
  "/report": {bar:"今日核查分区",tabs:["verify","samples"]},
  "/model-center": {bar:"模型训练分区",tabs:["train","data","health","history"]},
  "/devices": {bar: "设备台账分区", tabs: ["info", "worklog", "env"]},
};

const REAL = readFileSync("/tmp/pex/PORT", "utf8").trim();
const BASE = process.env.BASE || `http://127.0.0.1:${REAL}`;
const {proc, port} = await startChrome();
const reap = () => { try { proc.kill("SIGKILL"); } catch { /* 已退出 */ } };
process.on("exit", reap);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { reap(); process.exit(0); });
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = new CDP();
await cdp.connect(ver.webSocketDebuggerUrl);
const page = await openPage(cdp, port, 1440, 900);

let fails = 0;
const results = [];
function log(name, pass, detail) {
  if (!pass) fails++;
  results.push({name, pass: !!pass, detail: detail === undefined ? "" : String(detail).slice(0, 200)});
}
const goto = async url => { await page.goto(BASE + url); await page.settle(2200); };

for (const [path, want] of Object.entries(EXPECT)) {
  await goto(path);
  log(`${path} 页签栏存在`, await page.eval(`!!document.querySelector('.tabs[aria-label="${want.bar}"]')`),
      await page.eval(`(document.querySelector(".tabs")||{}).ariaLabel||"(无)"`));
  log(`${path} 页签 id 与顺序`, await page.eval(`(() => {
      const b=[...document.querySelectorAll(".tabs .tab-btn")];
      return JSON.stringify(b.map(x=>x.dataset.tab)) === ${JSON.stringify(JSON.stringify(want.tabs))}; })()`),
      await page.eval(`[...document.querySelectorAll(".tabs .tab-btn")].map(x=>x.dataset.tab).join(",")`));
  log(`${path} 默认落第一个页签`, await page.eval(`document.querySelector(".tab-btn").getAttribute("aria-selected")==="true"
      && !document.getElementById("tab-${want.tabs[0]}").hidden`));
  /* 「其余面板 hidden」原来只对 filter 的结果取 every()：DOM 里只要没第二个
     .tab-panel（搬家搬到一半、面板没渲染出来）它对空集返回 true，这一项就白跑。
     判据自带非空真前置：本页每个页签对应的面板都得真在 DOM 里
     （/devices 即 tab-info / tab-worklog / tab-events / tab-env 四个）。 */
  const panelIds = JSON.stringify(want.tabs.map(t => "tab-" + t));
  log(`${path} 其余面板 hidden`, await page.eval(`(() => {
      const ps = [...document.querySelectorAll(".tab-panel")], ids = ps.map(p => p.id);
      if (ps.length < 2 || !${panelIds}.every(x => ids.includes(x))) return false;
      return ps.filter(p => p.id !== "tab-${want.tabs[0]}").every(p => p.hidden); })()`),
      await page.eval(`[...document.querySelectorAll(".tab-panel")].map(p=>p.id+":"+(p.hidden?"h":"v")).join(",")`));

  await goto(`${path}#tab=${want.tabs[1]}`);
  const t1 = JSON.stringify(want.tabs[1]);
  log(`${path} hash 落位`, await page.eval(`document.getElementById("tab-${want.tabs[1]}").hidden === false
      && document.querySelector('.tab-btn[aria-selected="true"]').dataset.tab === ${t1}`),
      await page.eval(`[...document.querySelectorAll(".tab-panel")].map(p=>p.id+":"+(p.hidden?"h":"v")).join(",")`));

  /* CF-1 ①（Task 1 欠的，这一棒还）：站内 <a href="/devices#tab=events">、书签、
     前进后退走的都是「同一个文档里只改 hash」这条路，文档不重载、boot() 不再跑一遍，
     落签全靠 common.js 的 hashchange 监听。上面那条 goto(#tab=…) 测的是整页载入，
     initTabs() 里那次 activateTab 也会把签落对——监听没挂上它照样绿，测不出这一条。
     这里先整页回第一签（CF-5：不整页导航会读到上一个面板的状态），再用 location.hash
     同文档改签。 */
  await page.eval(`location.hash = "#tab=${want.tabs[0]}"; 1`);
  await page.settle(700);
  await page.eval(`location.hash = "#tab=${want.tabs[1]}"; 1`);
  await page.settle(900);
  log(`${path} 同文档改 hash（不重载）也落签`, await page.eval(`(() => {
      const on = document.getElementById("tab-${want.tabs[1]}"), off = document.getElementById("tab-${want.tabs[0]}");
      const sel = [...document.querySelectorAll(".tab-btn")].filter(b => b.getAttribute("aria-selected") === "true");
      return !!on && !on.hidden && !!off && off.hidden && sel.length === 1 && sel[0].dataset.tab === ${t1}; })()`),
      await page.eval(`[...document.querySelectorAll(".tab-panel")].map(p=>p.id+":"+(p.hidden?"h":"v")).join(",") + " sel=" + [...document.querySelectorAll(".tab-btn")].map(b=>b.dataset.tab+":"+b.getAttribute("aria-selected")).join(",")`));

  /* CF-1 ②：坏转义的 hash。人手敲 URL / 半截粘贴最常留下这两种形态：
     "#tab=%" 是残缺的百分号转义、"#tab=%E4%B8" 是被截断的 UTF-8 序列，
     两者都会让 decodeURIComponent 抛 URIError。tabFromHash 必须把它吞掉（它在
     boot() 中段，抛出等于整次 boot 断在半路：委托绑一半、15 秒轮询起不来、页面白屏），
     并且照常起第一个签。判据三半：第一个签在 + 其余 hidden + 这一趟没有新增
     [EXCEPTION]（page.logs 是 cdp.mjs 收的 Runtime.exceptionThrown）。 */
  for (const bad of ["%E4%B8", "%"]) {
    const errBase = page.logs.filter(x => x.startsWith("[EXCEPTION]")).length;
    await goto(`${path}#tab=${bad}`);
    /* 这条测的是「带着坏 hash 冷启动」——人手敲深链、收藏夹进来都走这条路，而 goto()
       只换 hash 不重载（CF-5），不补一刀的话读到的是上一个面板的落签状态。
       顺带把这条差异写在这儿备忘：同一个坏 hash 走「同文档改 hash」这条路时，
       tabFromHash() 回空串、hashchange 里的 if (id) 不 activateTab，页面**保持**当前签
       （不像未知页签名那样回退第一签）——那是 Task 1 定的既有语义（不能让任意锚点
       跳转动了页签），本 Task 不动它。 */
    await page.eval(`setTimeout(()=>location.reload(),0);1`).catch(() => {});
    await page.settle(2400);
    const excNew = page.logs.filter(x => x.startsWith("[EXCEPTION]")).length - errBase;
    /* M-4（Task 3 审查）：下面那条主判据里的 others.every(p => p.hidden) 在「面板搬到
       一半」时是空集真——除第一签外的面板都不在 DOM，every() 对空集返回 true，这半
       等于没判（主判据的 exception/first/mainTxt 三半有牙，所以以前没露出来）。
       照上面 CF-1 那条 :43-47 已用的写法（ids.includes("tab-worklog") 那种非空真前置）
       先把「除第一签外的面板真的齐」单独立一条，再给主判据也补上同样的数量前置。
       probe-uimove.mjs:62 的冷启动落签判据早就带了这个前置，这里抄它。 */
    log(`${path} 坏转义组 others 非空真（除第一签外 ${want.tabs.length - 1} 个面板齐）`, await page.eval(`(() => {
        const ps = [...document.querySelectorAll(".tab-panel")], ids = ps.map(p => p.id);
        return ${panelIds}.every(x => ids.includes(x))
          && ps.filter(p => p.id !== "tab-${want.tabs[0]}").length >= ${want.tabs.length - 1}; })()`),
        await page.eval(`[...document.querySelectorAll(".tab-panel")].map(p => p.id + ":" + (p.hidden ? "h" : "v")).join(",")`));
    log(`${path} 坏转义 #tab=${bad} 仍起第一签且不报错`, await page.eval(`(() => {
        const first = document.getElementById("tab-${want.tabs[0]}");
        const others = [...document.querySelectorAll(".tab-panel")].filter(p => p.id !== "tab-${want.tabs[0]}");
        const mainTxt = (document.querySelector("main") || {}).textContent || "";
        return !!first && !first.hidden && others.length >= ${want.tabs.length - 1}
          && others.every(p => p.hidden) && mainTxt.trim().length > 40; })()`)
        && excNew === 0,
        "新增异常 " + excNew + " 条；第一签 hidden=" + await page.eval(`(document.getElementById("tab-${want.tabs[0]}")||{}).hidden`) +
        "；实际签=" + await page.eval(`(document.querySelector('.tab-btn[aria-selected="true"]')||{}).dataset ? document.querySelector('.tab-btn[aria-selected="true"]').dataset.tab : "(无)"`));
  }

  await goto(`${path}#tab=不存在的那一页`);
  log(`${path} 非法 hash 回退第一签`, await page.eval(`!document.getElementById("tab-${want.tabs[0]}").hidden
      && [...document.querySelectorAll(".tab-panel")].length>1`));

  await goto(path);
  await page.eval(`document.querySelectorAll(".tab-btn")[0].focus()`);
  await cdp.send("Input.dispatchKeyEvent", {type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39}, page.sessionId);
  await cdp.send("Input.dispatchKeyEvent", {type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39}, page.sessionId);
  await page.settle(400);
  log(`${path} 方向键切到第二签`, await page.eval(`document.querySelectorAll(".tab-btn")[1].getAttribute("aria-selected")==="true"
      && !document.getElementById("tab-${want.tabs[1]}").hidden`));
  log(`${path} 切换后 hash 跟着走`, (await page.eval(`location.hash`)).includes(`tab=${want.tabs[1]}`),
      await page.eval(`location.hash`));

  for (const [k, at, vk] of [["End", want.tabs.length - 1, 35], ["Home", 0, 36]]) {
    await cdp.send("Input.dispatchKeyEvent", {type: "keyDown", key: k, code: k, windowsVirtualKeyCode: vk}, page.sessionId);
    await cdp.send("Input.dispatchKeyEvent", {type: "keyUp", key: k, code: k, windowsVirtualKeyCode: vk}, page.sessionId);
    await page.settle(400);
    log(`${path} ${k} 跳到第 ${at + 1} 签且焦点留下`, await page.eval(`(() => {
        const b=document.querySelectorAll(".tab-btn")[${at}];
        return b.getAttribute("aria-selected")==="true" && document.activeElement === b
          && !document.getElementById("tab-${want.tabs[at]}").hidden; })()`),
        await page.eval(`document.activeElement.textContent.trim()`));
  }
}

await goto("/devices");
const before = await page.eval(`performance.getEntriesByType("resource").filter(e=>e.name.indexOf("/api/")>0).length`);
await page.eval(`document.querySelectorAll(".tabs .tab-btn")[1].click()`);   // 不写死 data-tab：Task 3/5/6 会给各页加签
await page.settle(1200);
const after = await page.eval(`performance.getEntriesByType("resource").filter(e=>e.name.indexOf("/api/")>0).length`);
log("点击切换多发 0 个 /api 请求", after === before, `切换前 ${before} → 切换后 ${after}`);

await cdp.send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: true}, page.sessionId);
await page.settle(600);
log("窄屏 390px 页签栏单行", await page.eval(`(() => {
    const t=[...document.querySelectorAll(".tabs .tab-btn")].map(b=>Math.round(b.getBoundingClientRect().top));
    return new Set(t).size === 1; })()`), await page.eval(`(() => {
    return [...document.querySelectorAll(".tabs .tab-btn")].map(b=>Math.round(b.getBoundingClientRect().top)).join(","); })()`));
log("窄屏页签按钮高度 ≥44px", await page.eval(`[...document.querySelectorAll(".tabs .tab-btn")].every(b=>b.getBoundingClientRect().height>=44)`),
    await page.eval(`Math.min(...[...document.querySelectorAll(".tabs .tab-btn")].map(b=>b.getBoundingClientRect().height)).toFixed(1)`));
log("窄屏页签栏横向可滚且页面不横滚", await page.eval(`(() => { const t=document.querySelector(".tabs");
    return getComputedStyle(t).overflowX==="auto" && document.documentElement.scrollWidth<=window.innerWidth+1; })()`),
    await page.eval(`(() => { const t=document.querySelector(".tabs");
    return getComputedStyle(t).overflowX+" sw="+t.scrollWidth+" cw="+t.clientWidth; })()`));

console.log("");
for (const r of results) console.log((r.pass ? "PASS " : "FAIL ") + r.name + (r.detail ? "  | " + r.detail : ""));
console.log("");
console.log("合计 " + results.length + " 项，失败 " + fails + " 项。");
reap();
process.exit(fails ? 1 : 0);
