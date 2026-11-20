import {readFileSync} from "node:fs";
import {startChrome, CDP, openPage} from "./cdp.mjs";

/* 重组最怕两种漏：① 控件搬过去没接上处理器（点了没反应）；② 搬完老容器还在原地（两份源码）。
   控件盘点用命中测试，不用 textContent 猜。

   与 brief 骨架的三处必要偏离（都在「判据更准」这一侧，没有放宽）：
   a) 「页签就位」那条原来在 inventory() 之前 eval ——那会儿文档还停在上一轮的页面上
      （CF-5：同文档改 hash 不重载），读到的是别人的 DOM，第一条还会在 about:blank 上抛。
      改成导航之后再判，其余判据一字未动。
   b) live() 补两条：本仓的委托一律认 data-*（表格行按钮 data-act、快捷问 data-quick、
      分页 data-pager/data-size），骨架只列了后两个，会把「编辑/校准/解读/删除」整排
      真控件报成死链；另外盘点范围收到 main 内且要求真的画出矩形，
      导航条 / fab / 未展开的抽屉不属本次 IA 搬家范围，它们由 probe-controls-new 逐条点验。 */
const PORT = readFileSync("/tmp/pex/PORT", "utf8").trim();
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const {proc, port} = await startChrome();
const reap = () => { try { proc.kill("SIGKILL"); } catch {} };
process.on("exit", reap);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { reap(); process.exit(0); });
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = new CDP();
await cdp.connect(ver.webSocketDebuggerUrl);
const page = await openPage(cdp, port, 1440, 900);
let fails = 0; const results = [];
const log = (n, p, d) => { if (!p) fails++; results.push({n, p: !!p, d: String(d ?? "").slice(0, 220)}); };

/* CF-5 补刀（剥壳取证 logs/t3-strip-deeplink-RED.log 第一版逼出来的）：四个 /devices
   落点同住一个文档，page.goto 走的是 Page.navigate —— 只换 hash 不重载。上一版
   inventory 直接 goto，于是「冷启动带 hash 落签」这条量的其实是 hashchange 路径：
   把 common.js boot 里那句 activateTab(bar, tabFromHash()) 拆掉，28 条判据仍然全绿
   （深链坏掉却测不出来 = 空真）。改成与 probe-pages 同一个 goto：同文档换落点时
   强制 reload 一次，每条判据都从冷启动取数；reload 会销毁 execution context，
   所以 setTimeout 拐一层，eval 立刻返回。 */
const goto = async u => {
  const here = await page.eval(`location.pathname`).catch(() => "");
  await page.goto(BASE + u);
  const want = String(u).split("#")[0].split("?")[0];
  if (here === want) { await page.eval(`setTimeout(()=>location.reload(),0);1`).catch(() => {}); }
  await page.settle(2400);
};

const inventory = async (path, tab) => {
  await goto(path);
  /* (c) 深链落点补判（Task 3 的交付物就是 /devices#tab=events、/devices#tab=env 两个落点，
     Task 6 的训练页引导链接要指它们）：骨架只测「页签按钮在不在、点了有没有反应」，
     而「带着 hash 冷启动却没落签」这一种恰恰测不到 —— 它会在下面那一下 b.click() 之后
     被悄悄修好，四条判据照样全绿。所以在点之前先读一次落地状态，单独出一条判据。
     判据自带反向对照：本页其余签的面板必须同时判为 hidden，否则一个恒为 true 的
     表达式（比如把 hidden 写成 !== undefined）骗不过它。非空真也一起钉住：
     面板节点或按钮缺一个就直接 FAIL，不抛异常（CF-6）。 */
  let land = null;
  if (tab) land = await page.eval(`(() => {
    const want = ${JSON.stringify(tab)};
    const panel = document.getElementById("tab-" + want);
    const btns = [...document.querySelectorAll(".tabs .tab-btn")];
    const mine = btns.find(b => b.dataset.tab === want);
    const others = btns.filter(b => b.dataset.tab !== want)
                       .map(b => document.getElementById("tab-" + b.dataset.tab)).filter(Boolean);
    return {ok: !!panel && !!mine && panel.hidden === false
                 && mine.getAttribute("aria-selected") === "true"
                 && others.length > 0 && others.every(p => p.hidden === true),
            d: "hash=" + location.hash + "｜目标面板 hidden=" + (panel ? panel.hidden : "(无节点)") +
               "｜按钮 aria-selected=" + (mine ? mine.getAttribute("aria-selected") : "(无按钮)") +
               "｜其余面板 " + others.map(p => p.id + ":" + p.hidden).join(",")};
  })()`);
  if (tab) {
    // CF-6：控件可能压根不在（这一轮 RED 就是这个样），先判空、由调用方报 FAIL，不抛异常
    const clicked = await page.eval(`(() => { const b=document.querySelector('.tab-btn[data-tab="${tab}"]'); if (b) b.click(); return !!b; })()`);
    if (!clicked) return {total: 0, dead: [], containers: [], noTab: true, land};
    await page.settle(1200);
  }
  return await page.eval(`(() => {
    const inTab = el => { const p = el && el.closest(".tab-panel"); return (!p || !p.hidden)
        && !!el.closest("main") && el.getClientRects().length > 0; };
    const ctl = [...document.querySelectorAll("button,input,select,a[href],textarea")].filter(inTab);
    const live = el => {
      if (el.tagName === "A") return !!el.getAttribute("href");
      if (el.tagName === "SELECT" || el.tagName === "TEXTAREA") return true;   // 值随表单一起提交，靠 change/input 委托
      if (el.tagName === "INPUT") return ["text", "search", "number", "file", "date", "datetime-local", "checkbox"].includes(el.type);
      if (el.tagName === "BUTTON") return !!(el.onclick || el.getAttribute("onclick")) ||
        Object.keys(el.dataset).length > 0 ||          // data-pager / data-size / data-act / data-quick：本仓的委托钩子
        el.className.indexOf("tab-btn") >= 0;
      return false;
    };
    const dead = ctl.filter(el => !live(el))
      .map(el => el.tagName + "#" + (el.id || "") + "." + (el.className || "") + "[" + (el.textContent || "").trim().slice(0, 14) + "]");
    /* 容器在场 = 元素存在且不在隐藏面板里。只判 getElementById 会把「同页另一个签」
       也算在场，/devices 四签互查必然假红。 */
    const ids = ["mcSamples", "evList", "reportItems", "stats", "cards", "mcStats", "mcHealth",
                 "workRecordList", "tableWrap", "envList", "mcHistory"];
    const containers = ids.map(id => document.getElementById(id))
      .filter(el => el && inTab(el)).map(el => el.id);
    return {total: ctl.length, dead, containers};
  })()`).then(rep => ({...rep, land}));
};

const PAGES = {
  "/": {present:["stats","cards"],absent:["mcSamples","evList","reportItems"]},
  "/#tab=analysis": {present:[],absent:["stats","cards","mcSamples"],need:['#analysis [data-ai="full"]',"#btnReanalyze"]},
  "/report#tab=verify": {present:["reportItems"],absent:["mcSamples","evList"]},
  "/report#tab=samples": {present:["mcSamples"],absent:["reportItems","evList"]},
  "/model-center#tab=train": {present:["mcStats"],absent:["mcSamples","evList"]},
  "/model-center#tab=data": {present:["evList"],absent:["mcSamples","reportItems"]},
  "/model-center#tab=health": {present:["mcHealth"],absent:["mcSamples","evList"]},
  "/model-center#tab=history": {present:["mcHistory"],absent:["mcSamples","evList"]},
  "/devices#tab=info":    {present: ["tableWrap"], absent: ["evList", "mcSamples"]},
  "/devices#tab=worklog": {present: ["workRecordList"], absent: ["mcSamples"]},
  "/devices#tab=env":     {present: ["envList"], absent: ["evList", "mcSamples"]},
};
for (const [path, want] of Object.entries(PAGES)) {
  const tab = (/tab=([\w-]+)/.exec(path) || [])[1] || "";
  const r = await inventory(path, tab);
  if (tab) {
    log(`${path} 页签就位`, r.noTab !== true,
        r.noTab ? "本页没有 data-tab=\"" + tab + "\" 的页签按钮：" + await page.eval(`[...document.querySelectorAll(".tab-btn")].map(b=>b.dataset.tab).join(",")`) : "有");
    log(`${path} 冷启动带 hash 直接落签（深链落点）`, !!(r.land && r.land.ok),
        r.land ? r.land.d : "(没读到落地状态)");
  }
  log(`${path} 控件都有响应`, r.dead.length === 0, r.dead.join(" | "));
  log(`${path} 控件盘点非空`, r.total > 0, "本面板控件 " + r.total + " 个，在场容器 " + r.containers.join(","));
  const gone = want.present.filter(id => !r.containers.includes(id));
  log(`${path} 该在这页的容器在`, gone.length === 0, "缺：" + gone.join(","));
  if(want.need) for(const sel of want.need) log(`${path} 引导位在`,await page.eval(`!!document.querySelector(${JSON.stringify(sel)})`),sel);
  const still = r.containers.filter(id => want.absent.includes(id));
  log(`${path} 搬走的容器不在本页`, still.length === 0, "残留：" + still.join(","));
}
console.log("");
for (const r of results) console.log((r.p ? "PASS " : "FAIL ") + r.n + (r.d ? "  | " + r.d : ""));
console.log("");
console.log("合计 " + results.length + " 项，失败 " + fails + " 项。");
reap();
process.exit(fails ? 1 : 0);
