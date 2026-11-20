import {readFileSync, appendFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {startChrome, CDP, openPage} from "./cdp.mjs";

/* 一次全渲染的四个列表接上分页后的契约。沙箱 RESET_DB 后没有事件数据，先灌够再验。
   HOST 记每个列表「当前住在哪个地址」：Task 2 时事件与样本还在训练中心，
   Task 3/4 搬家时同步改这张表，探针才不会拿旧的落点冒充新的红。 */
const PORT = readFileSync("/tmp/pex/PORT", "utf8").trim();
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const HOST = {events: "/model-center#tab=data", samples: "/report#tab=samples",
              worklog: "/devices#tab=worklog", report: "/report#tab=verify"};
const {proc, port} = await startChrome();
const reap = () => { try { proc.kill("SIGKILL"); } catch {} };
process.on("exit", reap);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { reap(); process.exit(0); });
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = new CDP();
await cdp.connect(ver.webSocketDebuggerUrl);
const page = await openPage(cdp, port, 1440, 900);
let fails = 0; const results = [];
/* 每条结果当场落盘，而不是等最后一次性倒：浏览器被机器拖死在半路时，
   只有「走到哪一条了」能指认元凶，攒到最后打印就等于什么都不知道。 */
const log = (n, p, d) => { if (!p) fails++;
  const line = (p ? "PASS " : "FAIL ") + n + (d ? "  | " + String(d).slice(0, 180) : "");
  results.push({n, p: !!p, d: String(d ?? "").slice(0, 180)});
  if (process.env.TRACE) console.log(line);
  return p; };
/* 同样为「卡死时看得出走到哪」服务：只在 TRACE=1 时记，正式跑法不受影响 */
const rawEval = page.eval.bind(page);
page.eval = src => { if (process.env.TRACE)
    appendFileSync("/tmp/pex/logs/_pages_trace.txt", "→ " + src.replace(/\s+/g, " ").slice(0, 90) + "\n");
  return rawEval(src); };
/* CF-5：Task 3 之后四个落点里有三个同住一个文档（/devices 的 info / worklog /
   events / env 四签），Page.navigate 只换 hash 不重载——断言会读到上一个面板的
   DOM 和上一轮的内存态（页码、每页条数、draw 登记全带着）。凡是「同文档换落点」
   一律再强制重载一次，每条 goto 都从冷启动取数。
   reload 会销毁 execution context，所以用 setTimeout 拐一层：eval 立刻返回，
   重载随后发生，两边都不抛。 */
const goto = async u => {
  const here = await page.eval(`location.pathname`).catch(() => "");
  await page.goto(BASE + u);
  const want = String(u).split("#")[0].split("?")[0];
  if (here === want) { await page.eval(`setTimeout(()=>location.reload(),0);1`).catch(() => {}); }
  await page.settle(2400);
};
const first = sel => page.eval(`(() => { const e=document.querySelector(${sel}); return e?e.textContent.trim().slice(0,40):"(无)"; })()`);

/* 造数据：灌 25 条故障事件，全部走真实接口进沙箱库。
   (code, fail_time) 是服务端去重键，所以每条的失效时刻必须互不相同，
   否则会被静默跳过，分页断言就会看着像「数据没灌够」。 */
await goto("/devices");
const seeded = await page.eval(`(async () => {
  const codes = (await (await fetch("/api/state")).json()).devices.map(d=>d.code);
  let ok = 0;
  for (let i=0;i<25;i++){
    const r = await fetch("/api/fault-events", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({code: codes[i % codes.length],
                            fail_time: "2026-0" + (1 + Math.floor(i/28)) + "-" + String(1 + (i % 28)).padStart(2,"0")
                                         + " " + String(Math.floor(i/28)).padStart(2,"0") + ":" + String(i % 60).padStart(2,"0") + ":00",
                            fault_type: "叶轮磨损", severity: "严重", action: "更换叶轮",
                            reviewer: "分页探针"})});
    if (r.ok) ok++;
  }
  return ok;
})()`);
log("沙箱灌入故障事件", seeded >= 21, "成功 " + seeded + " 条");

await goto(HOST.events);
/* 事件表没写 thead，浏览器把表头那行也塞进隐式 tbody，计数要减掉一行；
   取「首行」同理要用 nth-child(2)，否则永远拿到表头「编号」，翻页断言必假红。
   首行取「失效时间」这一列而不是第一列「编号」：沙箱只有 4 台设备，灌数据时按
   i % codes.length 轮询编号，而每页 20 行正好是 4 的倍数——第 1 页第 1 行和第 2 页
   第 1 行的编号天然相同，用编号判「换没换人」会在分页已经正确时报假红。
   (code, fail_time) 是服务端去重键，失效时间每条必不同，才是行的唯一身份。 */
const evRows = () => page.eval(`Math.max(0, document.querySelectorAll("#evList tbody tr").length - 1)`);
const evHead = () => first(`"#evList tbody tr:nth-child(2) > td:nth-child(2)"`);
const rows1 = await evRows();
log("事件列表每页 ≤20 行", rows1 > 0 && rows1 <= 20, "本页 " + rows1 + " 行");
const head1 = await evHead();
/* 两处翻页交互都先判空再动手：分页还没接线时（Task 2 Step 2 的红灯阶段），
   直接 .click() / .value= 会抛 TypeError 把整个探针打断，后面 8 条断言一条也报不出来，
   score.py 只会看到「中途抛异常」。判空后红灯变成逐条 FAIL，结论仍然真实。 */
await page.eval(`(() => { const b=[...document.querySelectorAll('[data-pager="events"][data-page]')].pop(); if (b) b.click(); return !!b; })()`);
await page.settle(900);
const head2 = await evHead();
log("翻到下一页后首行换人", head1 !== head2, head1 + " / " + head2);
log("事件分页有每页条数下拉", await page.eval(`!!document.querySelector('[data-pager="events"][data-size]')`));
log("事件单位是「条」不是「台」", (await page.eval(`(document.querySelector("#evPager .pager .pg-info")||{}).textContent||""`)).includes("条"),
    await page.eval(`(document.querySelector("#evPager .pager .pg-info")||{}).textContent||""`));
await page.eval(`(() => { const s=document.querySelector('[data-pager="events"][data-size]'); if (!s) return 0; s.value="50"; s.dispatchEvent(new Event("change",{bubbles:true})); return 1; })()`);
await page.settle(900);
const rowsAll = await evRows();
log("换每页 50 条后回到第一页且一页装完", rowsAll >= seeded, "第 2 页时改 50，现在 " + rowsAll + " 行 / 共 " + seeded + " 条");

/* ── Fix round 2 · I-1：这里原来有三条「分页控件就位」──
   它们的形状是「有分页控件 || 列表容器非空」，而右半边在冷加载时就为真——容器里
   出厂就带着「加载中…」「正在加载样本…」「正在生成今日风险清单…」占位文案，
   接线全拆掉这三条也不会红，等于没有断言。现在把它们逐条换成各自分组里的真判据
   （每页条数上限 + 分页按钮真的渲染出来 + 翻页换人 + 翻页多发 0 个请求）：
     维护记录 → ④ 组（那组本来就要 45 条数据，控件必然出现）
     待确认样本 → ② 组（41 条 fixture 数据，3 页）
     今日核查卡 → ⑤ 组（客户端把 4 条复制到 >10 条，见下面那组注释）
   留在这里空跑一次导航没有意义，所以三条连同 goto 一起删掉。 */

/* ==========================================================================
   Fix round 1 · 换了筛选条件必须回到第一页

   分页是本轮接上的，随之多出一类毛病：筛窄之后行变了、页码还停在原页。
   paginate 只把越界的页码收到「最后一页」，所以它不白屏——但它会把筛剩结果
   的尾巴摆在用户面前，看上去就是「数据怎么少了」，实际是人没看见第一批。
   语义要和 [data-size] 那条一致：条件一变，回到第 1 页，且只重画不发请求。

   下面每段都走真实路径：先落到后面的页 → 再收窄筛选 → 判据全在 DOM 上
   （行数 > 0、pg-info 读到「第 1 / 」、首行是筛剩结果里该排第一的那一条），
   外加一次按接口分别计的 /api 计数：只允许筛选本身已有的那一次取数。
   所有控件先判空再动（缺控件报 FAIL，不抛异常把整支探针打断）。
   跨页一律整页 goto，且起点是另一个 document（只差 hash 不会重载）。
   ========================================================================== */
const info = box => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(box + " .pg-info")}); return e ? e.textContent.trim() : "(没有分页条)"; })()`);
const cnt = sel => page.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const headTxt = sel => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.trim() : "(没有首行)"; })()`);
// 从分页条文案里读出总页数（观察的是 DOM，不是内存里的 pg.pages）
const lastPageNo = async box => {
  const m = /第 (\d+) \/ (\d+) 页/.exec(await info(box));
  return m ? Number(m[2]) : 0;
};
// 点指定那一页的按钮；按钮没渲染出来返回 false，由调用方报 FAIL 而不是抛错
const clickPage = (key, n) => {
  const sel = `[data-pager="${key}"][data-page="${n}"]`;
  return page.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
};
// 四个列表各自的分页条容器（搬家时和 HOST 一起改）
const PAGER_BOX = {events: "#evPager", samples: "#mcSamplesPager", worklog: "#workRecordPager", report: "#reportPager"};
// 分页按钮到底渲染出来没有：判据是 DOM 里真有 [data-pager][data-page]，
// 不是容器里有没有字（容器里的占位文案在冷加载时就有字）。
const hasPagerBtn = key => page.eval(`!!document.querySelector('[data-pager="${key}"][data-page]')`);
// 落到最后一页：先读页数再点那一个按钮；页码超出 7 格窗口时 pageWindow 也会把最后一页显式列出来
const lastPage = async key => {
  const n = await lastPageNo(PAGER_BOX[key]);
  if (!n) return false;
  return await clickPage(key, n);
};
// 下拉筛选：值不在选项里返回 -1（选项没渲染出来 == 控件没就位），控件不存在返回 0
const pick = (sel, val) => page.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return 0; s.value = ${JSON.stringify(val)}; if (s.value !== ${JSON.stringify(val)}) return -1; s.dispatchEvent(new Event("change", {bubbles: true})); return 1; })()`);
const pageSize = (key, n) => pick(`[data-pager="${key}"][data-size]`, String(n));
/* 15 秒轮询会往 /api/state 打一枪，所以这里按接口分别计数：只数这个列表自己那条。
   「筛选不多发」的口径 = 筛选本来那一次取数（1），复位本身贡献 0。 */
const armApi = () => page.eval(`(() => {
  if (!window.__apiArmed) {
    window.__apiArmed = true;
    const of = window.fetch;
    window.fetch = function (u) {
      try { const p = String(u).split("?")[0]; if (p.indexOf("/api/") === 0) window.__api[p] = (window.__api[p] || 0) + 1; } catch (e) {}
      return of.apply(this, arguments);
    };
  }
  window.__api = {}; return true;
})()`);
const apiHit = p => page.eval(`(window.__api && window.__api[${JSON.stringify(p)}]) || 0`);

/* 沙箱库补数据：/api 里没有任何一条路能造出 model_feedback_samples——它只在 /api/state
   命中「每台设备最新一条遥测」时顺手记一条，沙箱 4 台设备就封顶 4 条，而这里的判据要的是
   「筛窄之后仍然有多页」。待确认状态的故障事件同理：四条写入路径（人工/导入/反馈/修正）
   都硬写 status='confirmed'，HTTP 侧拿不到一条 pending。
   所以这两份数据直接写沙箱库那一份副本：srv.sh 每次 RESET_DB 重建，真实台账一字不动
   （收尾 realcheck 复核）。库路径可用 FIXTURE_DB 覆盖，RED 取证时指向未修版那份副本。 */
const FIXTURE_DB = process.env.FIXTURE_DB || "/tmp/pex/app/data/equipment.db";
function fixture(run) {
  let db = null;
  try {
    db = new DatabaseSync(FIXTURE_DB);
    db.exec("PRAGMA busy_timeout = 8000");
    return run(db);
  } catch (e) { return {err: String((e && e.message) || e)}; }
  finally { try { if (db) db.close(); } catch {} }
}

/* ── ① 故障事件 · #evFilterCode（按设备编号筛）──
   给同一台设备（/api/state 那台排头的）再补 24 条三月的失效事件：
   补完之后总数 49 → 每页 20 有 3 页，而这台设备自己有 31 条 → 筛窄之后仍是 2 页，
   「停在第 3 页」和「回到第 1 页」摆出来的行不一样，断言才有牙。
   三月这批的时间全部新于一月那 25 条，所以筛后第一行的失效时间可预先算出。 */
await goto("/devices");
const extra = await page.eval(`(async () => {
  const codes = (await (await fetch("/api/state")).json()).devices.map(d => d.code);
  let ok = 0;
  for (let i = 0; i < 24; i++) {
    const r = await fetch("/api/fault-events", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({code: codes[0], fail_time: "2026-03-01 " + String(i).padStart(2, "0") + ":00:00",
                            fault_type: "叶轮磨损", severity: "严重", action: "更换叶轮", reviewer: "分页探针"})});
    if (r.ok) ok++;
  }
  return {ok: ok, code: codes[0]};
})()`);
await goto(HOST.events);
log("事件筛选复位的数据铺好了（同一台设备补到 24 条）", extra.ok === 24 && !!extra.code, "补灌 " + extra.ok + " 条 / 设备 " + extra.code);
/* 验证产品在台账数据到达后自行补齐设备筛选，探针不再代填选项。 */
const codeOpt = await page.eval(`(() => {
  const s = document.querySelector("#evFilterCode");
  return s && [...s.options].some(o => o.value === ${JSON.stringify(extra.code)}) ? "have" : "missing";
})()`);
log("事件设备筛选由产品补齐，无探针代填", codeOpt === "have", codeOpt);
let p1 = await pageSize("events", 20);
await page.settle(900);
p1 = p1 && await lastPage("events");               // 落到最后一页（第 3 页）
await page.settle(900);
const wideHead = await evHead();
await armApi();
const pickCode = await pick("#evFilterCode", extra.code || "__不存在__");
await page.settle(1600);
const codeInfo = await info("#evPager");
const codeRows = await evRows();
const codeHead = await evHead();
log("事件按编号筛：先落到后面的那一页", p1 === true, "落到最后一页=" + p1 + "，该页首行 " + wideHead + "，编号下拉=" + codeOpt + "（probe-filled 表示探针替 renderCodes 补了那只选项）");
log("事件按编号筛窄后列表不空", pickCode === 1 && p1 === true && codeRows > 0, "pick=" + pickCode + " 本页 " + codeRows + " 行");
log("事件按编号筛窄后回到第 1 页", pickCode === 1 && p1 === true && /· 第 1 \//.test(codeInfo), "筛前首行 " + wideHead + " → 筛后分页条：" + codeInfo);
log("事件按编号筛窄后首行就是筛剩结果的第一条", pickCode === 1 && codeHead === "2026-03-01 23:00:00", "期望 2026-03-01 23:00:00 / 实得 " + codeHead);
log("事件筛选复位不多发 /api", pickCode === 1 && await apiHit("/api/fault-events") === 1, "这一共打了 " + await apiHit("/api/fault-events") + " 个 /api/fault-events");
// 顺着再翻一次页：翻页仍是纯客户端，一个接口都不该打
await armApi();
p1 = p1 && await lastPage("events");
await page.settle(900);
log("筛窄之后再翻页仍是客户端切页", await apiHit("/api/fault-events") === 0, "打了 " + await apiHit("/api/fault-events") + " 个 /api/fault-events");

/* ── ② 待确认样本 · #mcFilter（待确认 / 已反馈 / 全部）── */
const SAMPLES = fixture(db => {
  const codes = db.prepare("SELECT code FROM equipment ORDER BY rowid").all().map(r => r.code);
  if (!codes.length) throw new Error("沙箱库里没有设备");
  const FJ = JSON.stringify({env_temp: 21, dev_temp: 45, current: 120, humidity: 55, dust: 2, run_hours: 100, since_repair_hours: 50});
  const ins = db.prepare(`INSERT OR IGNORE INTO model_feedback_samples
    (code,sim_time,feature_json,predicted_probability,model_version,feedback_kind,feedback_note,reviewer,status,created_at,reviewed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (let k = 1; k <= 21; k++)
    ins.run(codes[k % codes.length], "2026-09-01 00:" + String(k).padStart(2, "0") + ":00", FJ, 0.42, "V1.0-基础模型", "pending", "", "", "pending", "2026-11-19 00:00:00", null);
  for (let k = 1; k <= 20; k++)
    ins.run(codes[k % codes.length], "2026-09-02 00:" + String(k).padStart(2, "0") + ":00", FJ, 0.61, "V1.0-基础模型", "normal", "已核对", "分页探针", "reviewed", "2026-11-19 00:00:00", "2026-11-19 00:00:00");
  const n = s => db.prepare("SELECT COUNT(*) c FROM model_feedback_samples WHERE status=?").get(s).c;
  const top = db.prepare("SELECT code, sim_time FROM model_feedback_samples WHERE status='pending' ORDER BY id DESC LIMIT 1").get();
  return {pending: n("pending"), all: n("pending") + n("reviewed"), head: top.code + " · " + top.sim_time};
});
log("样本筛选复位的数据铺好了（待确认 > 20 且总数 > 40）", !SAMPLES.err && SAMPLES.pending > 20 && SAMPLES.all > 40,
    SAMPLES.err ? "灌数据失败：" + SAMPLES.err : "待确认 " + SAMPLES.pending + " / 全部 " + SAMPLES.all);
/* Task 3 之后样本与事件不同页：这一段先整页落到样本的宿主 /model-center（CF-5），
   上面那次 goto(HOST.events) 已经把人留在台账页，那里没有 #mcFilter / #mcSamples。 */
await goto(HOST.samples);
const pickAll = await pick("#mcFilter", "all");
await page.settle(1600);
let p2 = await pageSize("samples", 20);
await page.settle(900);
/* ②-1 样本分页行为本体（I-1）：每页 ≤20 条 / 分页按钮真的渲染出来 / 翻到第 2 页
   首条换人 / 翻页多发 0 个 /api/model-center。四条全观察 DOM，没有任何一条靠
   容器里的占位文案充数，接线拆掉就红。 */
const smBtn1 = await hasPagerBtn("samples");
const smPages1 = await lastPageNo("#mcSamplesPager");
const smRows1 = await cnt("#mcSamples article");
const smInfo1 = await info("#mcSamplesPager");
const smHead1 = await headTxt("#mcSamples article .sample-hd b");
await armApi();
const smClick2 = await clickPage("samples", 2);
await page.settle(700);
const smHead2 = await headTxt("#mcSamples article .sample-hd b");
const smRows2 = await cnt("#mcSamples article");
const smApiPage = await apiHit("/api/model-center");
log("样本每页 ≤20 条", smRows1 > 0 && smRows1 <= 20, "本页 " + smRows1 + " 条 / 分页条：" + smInfo1);
log("样本分页按钮真实渲染出来（旧的 || 兜底已删）", smBtn1 === true && smPages1 > 1, "按钮=" + smBtn1 + " 总页数=" + smPages1);
log("样本翻到第 2 页首条换人且仍 ≤20 条", smClick2 === true && smHead1 !== smHead2 && smRows2 > 0 && smRows2 <= 20, smHead1 + " / " + smHead2);
log("样本翻页多发 0 个 /api/model-center", smApiPage === 0, "打了 " + smApiPage + " 个");
p2 = p2 && await lastPage("samples");              // 全部 45 条 → 落到最后一页
await page.settle(900);
await armApi();
const pickPend = await pick("#mcFilter", "pending");
await page.settle(1600);
const smInfo = await info("#mcSamplesPager");
const smRows = await cnt("#mcSamples article");
const smHead = await headTxt("#mcSamples article .sample-hd b");
log("样本收到「待确认」后列表不空", pickAll === 1 && pickPend === 1 && p2 === true && smRows > 0, "pick all=" + pickAll + " pending=" + pickPend + " 落到最后一页=" + p2 + " 本页 " + smRows + " 条");
log("样本收到「待确认」后回到第 1 页", pickAll === 1 && pickPend === 1 && p2 === true && /· 第 1 \//.test(smInfo), "分页条：" + smInfo);
log("样本收到「待确认」后首条就是那一批的第一条", pickPend === 1 && smHead === SAMPLES.head, "期望 " + SAMPLES.head + " / 实得 " + smHead);
log("样本筛选复位不多发 /api", pickPend === 1 && await apiHit("/api/model-center") === 1, "打了 " + await apiHit("/api/model-center") + " 个 /api/model-center");

/* ── ③ 故障事件 · #evFilterStatus（只看已确认 / 只看待确认）──
   这份控件与上面那个走的是同一个入口（onchange="EV.refresh()"），单独再压一遍，
   因为它是本轮被点名的第二个筛选控件。待确认那 24 条在二月，筛后第一行可预先算出。 */
const PEND = fixture(db => {
  const code = db.prepare("SELECT code FROM equipment ORDER BY rowid LIMIT 1").get().code;
  const ins = db.prepare(`INSERT OR IGNORE INTO fault_events
    (code,fail_time,fault_type,severity,action,note,source,reviewer,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (let k = 1; k <= 24; k++)
    ins.run(code, "2026-02-01 08:" + String(k).padStart(2, "0") + ":00", "叶轮磨损", "严重", "更换叶轮", "筛选复位探针（待确认）", "manual", "分页探针", "pending", "2026-11-19 00:00:00");
  const top = db.prepare("SELECT fail_time FROM fault_events WHERE status='pending' ORDER BY fail_time DESC, id DESC LIMIT 1").get();
  return {n: db.prepare("SELECT COUNT(*) c FROM fault_events WHERE status='pending'").get().c, head: top.fail_time};
});
await goto(HOST.events);                           // ② 在 /model-center 验完样本，③ 回台账页的事件签
await pick("#evFilterCode", "");                   // 编号筛回全部：现在 73 条 → 4 页
await page.settle(1600);
let p3 = await lastPage("events");                 // 落到第 4 页
await page.settle(900);
await armApi();
const pickStatus = await pick("#evFilterStatus", "pending");
await page.settle(1600);
const stInfo = await info("#evPager");
const stRows = await evRows();
const stHead = await evHead();
log("状态筛选复位的数据铺好了（待确认 > 20 条）", !PEND.err && PEND.n > 20, PEND.err ? "灌数据失败：" + PEND.err : "待确认 " + PEND.n + " 条");
log("事件按状态筛：先落到后面的那一页", p3 === true, "落到最后一页=" + p3);
log("事件收到「只看待确认」后列表不空", pickStatus === 1 && p3 === true && stRows > 0, "pick=" + pickStatus + " 本页 " + stRows + " 行");
log("事件收到「只看待确认」后回到第 1 页", pickStatus === 1 && p3 === true && /· 第 1 \//.test(stInfo), "分页条：" + stInfo);
log("事件收到「只看待确认」后首行就是那一批的第一条", pickStatus === 1 && stHead === PEND.head, "期望 " + PEND.head + " / 实得 " + stHead);
log("事件状态筛选复位不多发 /api", pickStatus === 1 && await apiHit("/api/fault-events") === 1, "打了 " + await apiHit("/api/fault-events") + " 个 /api/fault-events");

/* ── ③b 换每页条数 → 回到第一页（I-3 的有牙判据，复审给的那个形状）──
   原来四个列表的「改条数回第一页」全是空判：那四条都把条数改到一页装得完，改完之后
   pages=1，paginate 的越界收敛（common.js 的 if (st.page > pages) st.page = pages）
   会把停在第 2 页的页码自动夹回 1，「回没回第一页」和「一页装完了」分不开——把
   common.js 里那句 st.page = 1 整行删掉，四条照样绿。
   这一组把它做成有牙的：73 条停在第 4 页 → 改每页 50（仍然 ceil(73/50)=2 页，不止一页）
   → 分页条必须逐字读作「共 73 条 · 第 1 / 2 页」，首行必须是全表第一条。
   没有那句复位的话页码留在 4、被收敛夹到 2，两半判据同时红。
   页数与期望文案都由 DOM 上读到的实际条数推导（同 M-a 的口径），fixture 变了不假红。 */
await pick("#evFilterStatus", "");                 // 状态筛回全部：现在 73 条
await page.settle(1600);
const i3Size20 = await pageSize("events", 20);     // 先把档位钉回 20（③ 之后仍是 20，这里显式确认）
await page.settle(900);
const i3OnLast = await lastPage("events");         // 落到最后一页
await page.settle(900);
const i3InfoBefore = await info("#evPager");
const i3Total = Number((/共 (\d+) 条/.exec(i3InfoBefore) || [])[1] || 0);
const i3PagesBefore = Number((/第 (\d+) \/ \d+ 页/.exec(i3InfoBefore) || [])[1] || 0);
const i3PagesAfter = Math.ceil(i3Total / 50);
const i3Size50 = await pageSize("events", 50);
await page.settle(900);
const i3Info = await info("#evPager");
const i3Head = await evHead();
// 期望首行 = 服务端那条 ORDER BY fail_time DESC, id DESC 的第一条，从沙箱库直接读，不写死
const i3Top = fixture(db => db.prepare(
  "SELECT fail_time FROM fault_events ORDER BY fail_time DESC, id DESC LIMIT 1").get().fail_time);
log("I-3 的前置：每页 20 时停在第 " + i3PagesBefore + " 页，改成每页 50 之后仍有 " + i3PagesAfter + " 页",
    i3Size20 === 1 && i3OnLast === true && i3Total > 50 && i3PagesAfter > 1 && i3PagesBefore > 1,
    "分页条「" + i3InfoBefore + "」→ 每页 50 应为 " + i3PagesAfter + " 页（共 " + i3Total + " 条）" +
    (i3PagesAfter > 1 ? "" : "：一页就装完了，这条判据会失效"));
log("事件换每页 50 条（仍 " + i3PagesAfter + " 页）后分页条逐字读作「共 " + i3Total + " 条 · 第 1 / " + i3PagesAfter + " 页」",
    i3Size50 === 1 && i3Info === "共 " + i3Total + " 条 · 第 1 / " + i3PagesAfter + " 页",
    "期望「共 " + i3Total + " 条 · 第 1 / " + i3PagesAfter + " 页」/ 实得「" + i3Info + "」");
log("事件换每页 50 条后首行就是全表第一条（不是被越界收敛夹到最后一页的那一撮）",
    i3Size50 === 1 && i3Head === i3Top, "期望 " + i3Top + " / 实得 " + i3Head);

/* ── ④ 维护记录 · 关键词搜索（#workKeyword + 搜索/重置按钮）──
   这一处的复位 Task 2 当场就写对了（searchWorkRecords / resetWorkSearch 各一行），
   这段断言天生是绿的，它的作用是闩住：Task 3 把事件分区也搬进 /devices 之后，
   谁把那两行碰掉了要立刻红。RED 取证见报告（把这两行删掉的未修版副本上它是红的）。 */
const WR = await page.eval(`(async () => {
  const mk = (word, day) => ({work_date: "2026-05-" + String(day).padStart(2, "0"), location: "西翼三班",
    equipment: "1#馈电开关", content: "巡检并" + word + "（分页复位探针 " + day + "）", result: "已完成", workers: "分页探针"});
  const runs = [
    Array.from({length: 24}, (_, i) => mk("更换叶轮磨损部件", i + 1)),
    Array.from({length: 21}, (_, i) => ({...mk("给输送机润滑加油", i + 1), work_date: "2026-04-" + String(i + 1).padStart(2, "0")})),
  ];
  let added = 0;
  for (const records of runs) {
    const j = await (await fetch("/api/work-records/confirm", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({records})})).json();
    if (j.ok) added += j.added;
  }
  return added;
})()`);
await goto(HOST.worklog);                          // 上一段停在 /model-center，这次 goto 是整页载入
log("维护记录搜索复位的数据铺好了（45 条，叶轮 24 / 润滑 21）", WR === 45, "新增 " + WR + " 条");
let p4 = await pageSize("worklog", 20);
await page.settle(900);
/* ④-1 维护记录分页行为本体（I-1）：同一套四条判据，替掉原来那句
   「有控件 || 有 .empty」。维护记录此刻有 45 条，20 条一页必有分页按钮，
   接线一拆就红。 */
const wlBtn1 = await hasPagerBtn("worklog");
const wlPages1 = await lastPageNo("#workRecordPager");
const wlRows1 = await cnt("#workRecordList article.work-saved");
const wlInfo1 = await info("#workRecordPager");
const wlHead1 = await headTxt("#workRecordList article.work-saved .work-saved-hd b");
await armApi();
const wlClick2 = await clickPage("worklog", 2);
await page.settle(700);
const wlHead2 = await headTxt("#workRecordList article.work-saved .work-saved-hd b");
const wlRows2 = await cnt("#workRecordList article.work-saved");
const wlApiPage = await apiHit("/api/work-records");
log("维护记录每页 ≤20 条", wlRows1 > 0 && wlRows1 <= 20, "本页 " + wlRows1 + " 条 / 分页条：" + wlInfo1);
log("维护记录分页按钮真实渲染出来（旧的 || 兜底已删）", wlBtn1 === true && wlPages1 > 1, "按钮=" + wlBtn1 + " 总页数=" + wlPages1);
log("维护记录翻到第 2 页首条换人且仍 ≤20 条", wlClick2 === true && wlHead1 !== wlHead2 && wlRows2 > 0 && wlRows2 <= 20, wlHead1 + " / " + wlHead2);
log("维护记录翻页多发 0 个 /api/work-records", wlApiPage === 0, "打了 " + wlApiPage + " 个");
p4 = p4 && await lastPage("worklog");              // 45 条 → 落到最后一页
await page.settle(900);
await armApi();
const searched = await page.eval(`(() => {
  const i = document.querySelector("#workKeyword");
  const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "搜索");
  if (!i || !b) return 0;
  i.value = "叶轮"; b.click(); return 1;
})()`);
await page.settle(1600);
const wlInfo = await info("#workRecordPager");
const wlRows = await cnt("#workRecordList article.work-saved");
const wlHead = await headTxt("#workRecordList article.work-saved .work-saved-hd b");
log("维护记录搜：先落到后面的那一页", p4 === true, "落到最后一页=" + p4);
log("维护记录搜窄后列表不空", searched === 1 && p4 === true && wlRows > 0, "搜索点击=" + searched + " 本页 " + wlRows + " 条");
log("维护记录搜窄后回到第 1 页", searched === 1 && p4 === true && /· 第 1 \//.test(wlInfo), "分页条：" + wlInfo);
log("维护记录搜窄后首条就是那一批的第一条", searched === 1 && wlHead === "2026-05-24 · 西翼三班", "期望 2026-05-24 · 西翼三班 / 实得 " + wlHead);
log("维护记录搜索复位不多发 /api", searched === 1 && await apiHit("/api/work-records") === 1, "打了 " + await apiHit("/api/work-records") + " 个 /api/work-records");

/* ── ⑤ 今日核查卡：分页行为本体（I-1 的主案发现场）──
   这一组原来只断言「卡片之外没有别的下拉」，那是在断言「这条需求不存在」；而沙箱
   只有 4 台设备，/api/daily-report 一次回不到 11 条，#reportPager 里永远不会出现
   .pager，把 report.js 里的分页接线整段删掉，standing suite 依旧全绿——正是本 Task
   要防的失败模式。
   >10 条在客户端数组上复制出来：这里的分页本就是纯前端在这页已经取回的 Report.rows
   上切页，复制行不绕过后端、不多发请求、不写库（realcheck 收尾复核），是这套机制的
   真实用法而不是 mock 特性。判据：每页 ≤10 张、分页条逐字读作「共 N 台 · 第 1 / 2 页」、
   翻到第 2 页首张卡换人且仍 ≤10 张、翻页多发 0 个 /api/daily-report、
   换每页 20 张后回第 1 页且一页装完。控件一律先判空再动，缺就报 FAIL 不抛异常。 */
await goto(HOST.report);
const repGrow = await page.eval(`(() => {
  if (!window.Report || !Array.isArray(Report.rows) || !Report.rows.length)
    return {ok:0, n:0, why:"Report.rows 空：load() 里那两行分页接线没跑（核查卡根本没渲染）"};
  /* 重绘只许走产品自己登记的那条线：load() 里若不写 App.pagerState("report").draw = Report.render，
     这里就拿不到 draw。探针绝不代劳去调 Report.render()——那样 RED 取证（把接线那两行剥掉）
     会假绿，等于又造了一条「怎么改都绿」的断言。 */
  const st = App.pagerState("report");
  if (!st || typeof st.draw !== "function")
    return {ok:0, n:Report.rows.length, why:"st.draw 没登记：report.js 里的分页接线被拆掉了"};
  const base = Report.rows.slice();
  const out = base.slice();
  for (let k = 2; out.length <= 10; k++)
    for (const x of base) {
      const c = JSON.parse(JSON.stringify(x));
      c.device = Object.assign({}, c.device, {code: String(x.device.code) + "副本" + k});
      c.sample_id = null;                      // 卡片表单元素的 id 用 code 兜底，副本必须换个名才不会整页重 id
      out.push(c);
      if (out.length > 10) break;
    }
  Report.rows = out;
  st.draw();
  return {ok:1, n:out.length, base:base.length, why:"客户端把 " + base.length + " 条复制到 " + out.length + " 条（未发请求、未写库；重绘走产品登记的 st.draw）"};
})()`);
const repRows1 = await cnt("#reportItems .report-card");
const repBtn1 = await hasPagerBtn("report");
const repPages1 = await lastPageNo("#reportPager");
const repInfo1 = await info("#reportPager");
const repHead1 = await headTxt("#reportItems .report-card .report-head h3");
await armApi();
const repClick2 = await clickPage("report", 2);
await page.settle(700);
const repHead2 = await headTxt("#reportItems .report-card .report-head h3");
const repRows2 = await cnt("#reportItems .report-card");
const repApiPage = await apiHit("/api/daily-report");
log("核查卡在客户端扩到 >10 条（分页接线的真实证据）", repGrow.ok === 1 && repGrow.n > 10, repGrow.why);
log("核查卡每页 ≤10 张", repRows1 > 0 && repRows1 <= 10, "本页 " + repRows1 + " 张 / 共 " + repGrow.n + " 条");
/* M-a：页数与整句文案都由实际读到的条数推导，不再写死「2 页 / 共 11 台」。
   上面那段复制循环在 base.length > 10 时一条都不复制（沙箱 4 台 → 11 条；
   将来 fixture 加到 >10 台、或 /api/daily-report 回到 21 条，写死的判据会因为
   「接线其实是对的」而假红）。repPages = ceil(n / 该档位的每页数)。 */
const repPages = Math.ceil(repGrow.n / 10);
log("核查卡分页按钮真实渲染出来（旧的 || 兜底已删）", repBtn1 === true && repPages1 === repPages, "按钮=" + repBtn1 + " 总页数=" + repPages1 + "（按 " + repGrow.n + " 条 / 每页 10 推导应为 " + repPages + "）分页条：" + repInfo1);
log("核查卡分页条逐字读作「共 " + repGrow.n + " 台 · 第 1 / " + repPages + " 页」（量词是台）",
    repInfo1 === "共 " + repGrow.n + " 台 · 第 1 / " + repPages + " 页", "期望「共 " + repGrow.n + " 台 · 第 1 / " + repPages + " 页」/ 实得「" + repInfo1 + "」");
log("核查卡翻到第 2 页首张卡换人且仍 ≤10 张",
    repClick2 === true && repHead1 !== repHead2 && repRows2 > 0 && repRows2 <= 10, repHead1 + " / " + repHead2);
log("核查卡翻页多发 0 个 /api/daily-report", repApiPage === 0, "打了 " + repApiPage + " 个");
/* ⑤-2 顺带把原来那句「确实没有筛选控件」留着，但放到分页条已渲染之后判：
   这时卡片之外唯一还在的下拉就是分页条那只每页条数，outside 仍为 0 才说明
   核查卡这一屏除了分页没有任何改行集合的控件（所以它没有「换条件回第一页」要做）。 */
const repCtl = await page.eval(`(() => {
  const loose = [...document.querySelectorAll("#tab-verify select, #tab-verify input")].filter(el => !el.closest(".report-card"));
  return {n: loose.length, outside: loose.filter(el => !el.closest(".pager")).length,
          names: loose.map(el => el.id || el.tagName).join("/")};
})()`);
log("核查卡确实没有筛选控件（卡片与分页条之外的下拉数 = 0，此刻分页条在场）",
    repCtl.outside === 0 && repCtl.n - repCtl.outside === 1,
    "卡片外的下拉：" + repCtl.names + "（分页条内 " + (repCtl.n - repCtl.outside) + " 只）");
const repSize20 = await pageSize("report", 20);
await page.settle(700);
const repRows20 = await cnt("#reportItems .report-card");
const repInfo20 = await info("#reportPager");
log("核查卡换每页 20 张后回到第 1 页且一页装完",
    repSize20 === 1 && repRows20 === repGrow.n, "第 2 页时改 20，本页 " + repRows20 + " 张 / 共 " + repGrow.n + " 条，分页条：" + repInfo20);


/* ── ⑥ 非筛选的刷新/保存路径必须留在当前页（I-2 的另一半）──
   复位只属于「筛选变更点」：EV.onFilter / MC.onFilter（以及换表的 setTable、
   台账搜索与重置）。Fix round 1 把这两行写在 refresh() 入口，而 refresh 的入口远不止
   筛选——「刷新」按钮、保存/删除/导入后的重取、mount()、还有事件脚本里那三处跨页
   MC.refresh()——结果改一条事件顺手把样本列表也归零，正在读第 4 页的人保存完再也
   找不到自己刚改的那一行（report.js 的 Report.save() 恰恰是刻意留在当前页的）。
   这一组把新语义钉住：先让两个列表都停在第 2 页，再走三条非筛选路径，页号与首行身份
   都不许动；同时用按接口计的那一次取数证明这条路径确实跑过（不是「什么都没发生」冒充绿灯）。
   RED 取证见 task-2-report.md「fix round 3（控制器派发）· 剥壳取证台账」B-1
   （日志 /tmp/pex/logs/strip-i2-refresh-reset.log）：把复位搬回 refresh() 入口，
   ⑥a/⑥b/⑥c 立刻红。 */
/* Task 3 搬家把事件分区挪到 /devices#tab=events，样本留在 /model-center：
   这两个列表从此不在同一个文档里，原来那份「两个列表都停在第 2 页」的共用前置
   拆成两段——事件这段就地做，样本那段（⑥c 的前置）跟着 goto(HOST.samples) 走。
   判据本身一条没减。 */
await goto(HOST.events);
const evSize6 = await pageSize("events", 20);
await page.settle(900);
const evPages6 = await lastPageNo("#evPager");
const onEv2 = evSize6 === 1 && evPages6 > 1 && await clickPage("events", 2);
await page.settle(700);
const evBase = await evHead();
const evInfoBase = await info("#evPager");
log("⑥ 的前置：事件停在第 2 页", onEv2 === true, "事件「" + evInfoBase + "」首行 " + evBase);

// ⑥a 「刷新」按钮（events.js 里 EV.refresh() 的入口之一，不是筛选变更）
await armApi();
const refBtn = await page.eval(`(() => {
  const b = [...document.querySelectorAll("#evHead button")].find(x => x.textContent.trim() === "刷新");
  if (!b) return 0; b.click(); return 1;
})()`);
await page.settle(1800);
const evInfoRef = await info("#evPager");
const evHeadRef = await evHead();
const refApi = await apiHit("/api/fault-events");
log("事件点「刷新」后仍停在第 2 页（复位不属于刷新入口）",
    refBtn === 1 && onEv2 === true && /· 第 2 \//.test(evInfoRef) && evHeadRef === evBase,
    "刷新前「" + evInfoBase + "」→ 刷新后「" + evInfoRef + "」，首行 " + evBase + " → " + evHeadRef);
log("事件「刷新」只打本来那一次取数，复位不额外加请求", refBtn === 1 && refApi === 1,
    "打了 " + refApi + " 个 /api/fault-events");

// ⑥b 真实保存路径：改「第 2 页首行」那一条的程度再保存（EV.save → refresh + 跨页 MC.refresh）
const editBtn = await page.eval(`(() => {
  const tr = document.querySelector("#evList tbody tr:nth-child(2)");
  if (!tr) return 0;
  const b = [...tr.querySelectorAll("button")].find(x => x.textContent.trim() === "改");
  if (!b) return 0; b.click(); return 1;
})()`);
const formFill = await page.eval(`(() => {
  const time = document.getElementById("ev_time"), sev = document.getElementById("ev_severity"),
        rev = document.getElementById("ev_reviewer"),
        cell = document.querySelector("#evList tbody tr:nth-child(2) > td:nth-child(2)");
  if (!time || !sev || !rev || !cell) return {ok:0, why:"表单或那一行没找到"};
  const t = cell.textContent.trim();
  // 表格里是「2026-01-25 00:24:00」，datetime-local 只认「2026-01-25T00:24」：
  // setEditing 直接把带空格的串塞进去会被浏览器判非法、清空时间字段，保存必被字段闸挡下。
  if (!/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}/.test(t)) return {ok:0, why:"失效时间读不出来：" + t};
  time.value = t.replace(" ", "T").slice(0, 16);
  if (!time.value) return {ok:0, why:"datetime-local 拒收：" + t};
  const cur = sev.value;
  const alt = [...sev.options].map(o => o.value).filter(v => v && v !== cur)[0] || "";
  if (!alt) return {ok:0, why:"严重程度没有可换的选项（当前 " + cur + "）"};
  sev.value = alt; rev.value = "分页探针";
  return {ok:1, alt:alt, from:cur, time:time.value};
})()`);
await armApi();
const saveBtn = await page.eval(`(() => {
  const b = [...document.querySelectorAll("#evForm button")].find(x => x.textContent.trim() === "保存这条");
  if (!b) return 0; b.click(); return 1;
})()`);
await page.settle(2400);
const saveErr = await page.eval(`(() => { const e = document.getElementById("evErr");
  return e && e.style.display !== "none" ? e.textContent.trim() : ""; })()`);
const evInfoSave = await info("#evPager");
const evHeadSave = await evHead();
const sevCell = await headTxt("#evList tbody tr:nth-child(2) > td:nth-child(4)");
const evGetAfterSave = await apiHit("/api/fault-events");
/* Task 3 之前这一处还数着「事件保存顺手跨页刷一次训练中心」（mcCrossAfterSave === 1）。
   搬家之后这条判据换成反向钉闩：/devices 不加载 model-center.js，事件脚本里那句跨页
   刷新会抛 ReferenceError、被 save() 自己的 catch 接成「没写进去：ModelCenter is not
   defined」——写已经写成功了却报失败，是这次搬家带出的真 bug，三处一起删。
   删完之后这一页对 /api/model-center 的请求数必须恒为 0；配合上一条 !saveErr 与
   sevCell 换值，既钉住「真的写进去了、没误报」，也钉住「别把跨页调用加回来」。 */
const mcCrossAfterSave = await apiHit("/api/model-center");
log("事件「改一条并保存」真的写进去了（第 2 页那一行的程度变成新值）",
    editBtn === 1 && formFill.ok === 1 && saveBtn === 1 && !saveErr && sevCell === formFill.alt,
    "改=" + editBtn + " 表单=" + JSON.stringify(formFill) + " 保存=" + saveBtn + " 页面报错「" + saveErr + "」那一行的程度现在是：" + sevCell);
log("事件保存后仍停在第 2 页且首行没换（留在原地才找得到刚改的那条）",
    evGetAfterSave === 1 && /· 第 2 \//.test(evInfoSave) && evHeadSave === evBase,
    "保存前「" + evInfoBase + "」→ 保存后「" + evInfoSave + "」，首行 " + evBase + " → " + evHeadSave + "，重取的 GET 打了 " + evGetAfterSave + " 次");
log("事件保存不再跨页刷训练中心（跨页调用已删，写成功后不得误报「没写进去」）",
    onEv2 === true && evGetAfterSave === 1 && mcCrossAfterSave === 0 && !saveErr,
    "台账页上打了 " + mcCrossAfterSave + " 次 /api/model-center（应为 0）；事件重取 " + evGetAfterSave +
    " 次；页面报错「" + saveErr + "」");

/* ⑥c 训练中心自己的「刷新数据」按钮（MC.refresh() 的入口，不是筛选变更）。
   样本列表留在 /model-center，事件搬走之后这两个列表不同页，前置得在这儿重做一遍：
   整页导航过去（CF-5）、换每页 20 条、点到第 2 页，再按「刷新数据」。 */
await goto(HOST.samples);
const smSize6 = await pageSize("samples", 20);
await page.settle(900);
const smPages6 = await lastPageNo("#mcSamplesPager");
const onSm2 = smSize6 === 1 && smPages6 > 1 && await clickPage("samples", 2);
await page.settle(700);
const smBase = await headTxt("#mcSamples article .sample-hd b");
const smInfoBase = await info("#mcSamplesPager");
log("⑥c 的前置：样本停在第 2 页（样本没跟着搬家，仍在 /model-center）",
    onSm2 === true, "样本「" + smInfoBase + "」首条 " + smBase);
await armApi();
const mcRefBtn = await page.eval(`(() => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "刷新数据");
  if (!b) return 0; b.click(); return 1;
})()`);
await page.settle(1800);
const smInfoRef = await info("#mcSamplesPager");
const smHeadRef = await headTxt("#mcSamples article .sample-hd b");
const mcRefApi = await apiHit("/api/model-center");
log("样本点「刷新数据」后仍停在第 2 页", mcRefBtn === 1 && mcRefApi === 1 && /· 第 2 \//.test(smInfoRef) && smHeadRef === smBase,
    "刷新后「" + smInfoRef + "」首条 " + smHeadRef + "（GET 打了 " + mcRefApi + " 次）");

/* ==========================================================================
   ⑦ 取数失败态（M-1 的执行证据）· ⑧ draw 登记落在取数路径（CF-7 的判据）
   —— round 2 的复审说得很直接：四处 catch 的清理「一次执行验证都没有」，
   而 CF-7 那条硬约束在 53 项里没有任何一项能指认「登记位置」。

   ⑦ 的做法是真的让请求失败：把 window.fetch 换掉一次，对目标接口回一个
   status=500、body={ok:false,error:…} 的响应（self-restoring，只坏一次，
   15 秒轮询那条 /api/state 不受影响），然后走产品自己的取数函数。App.api 见到
   !ok && error 就抛，产品的 catch 分支这才被真的走一遍。判据是两半，缺一半不算：
     a) 列表容器里出现错误文案；
     b) [data-pager][data-page] 按钮数为 0。
   只判 a) 不够——错误写进去了、分页条还留着，人点一下就用内存里的旧 rows 把这条
   错误刷没了，那正是要关的路。b) 单独也判不出「有没有清」以外的东西，两半合起来
   才是「失败态不可翻页」。剥壳取证见报告 B-3（logs/strip-m1-failstate.log）。

   ⑧ 的做法是抹掉再取数：App.pagerState(key).draw = null 之后调一次产品自己的
   取数，成功分支必须把它重新登记回来。登记只写在 mount() 里的实现（round 2 的事件表）
   在这条上必红，因为 mount 一辈子只在本页首屏跑一次。Task 3 把 #evPager 整段搬去
   /devices，搬迁时 <script>EV.mount();</script> 漏加或被挪序，draw 就是空的 →
   common.js 的翻页监听退回全局 render() → 页码写进了 S.pager 却没人重画 #evList，
   表现是「点了没反应」，而且一行错误都不抛。剥壳取证见报告 B-2（logs/strip-cf7-draw.log）。
   ========================================================================== */
const failOnce = path => page.eval(`(() => {
  const prev = window.fetch;
  let done = false;
  window.fetch = function (u, o) {
    try {
      if (!done && String(u).split("?")[0] === ${JSON.stringify(path)}) {
        done = true; window.fetch = prev;                 // 只坏这一次，之后立刻还原
        return Promise.resolve(new Response(
          JSON.stringify({ok: false, error: "探针注入的 500：服务暂时不可用"}),
          {status: 500, headers: {"Content-Type": "application/json"}}));
      }
    } catch (e) {}
    return prev.apply(this, arguments);
  };
  return 1;
})()`);
const pagerBtnCount = key => cnt(`[data-pager="${key}"][data-page]`);

/* ⑧ 的通用判据：抹掉 draw → 走产品自己的取数 → 必须重新变成函数。
   探针不代劳登记（代劳就等于把判据写死成自己），取数完成后把原值兜回去，
   免得这一段自己把后面的断言弄脏。 */
const regCheck = (key, call) => page.eval(`(async () => {
  const st = App.pagerState(${JSON.stringify(key)});
  if (!st) return {ok: 0, why: "S.pager 里没有 " + ${JSON.stringify(key)} + " 这一项"};
  if (typeof st.draw !== "function") return {ok: 0, why: "取数前 draw 本来就不是函数（首屏就没登记上）"};
  const keep = st.draw; st.draw = null;
  let err = "";
  try { await (${call}); } catch (e) { err = String((e && e.message) || e); }
  const back = typeof st.draw;
  if (back !== "function") st.draw = keep;                 // 红也要把状态兜回去
  return {ok: back === "function" ? 1 : 0, err, before: "function", after: back};
})()`);

/* —— 事件：失败态 + 登记位置 ——
   Task 3 之后事件住在 /devices#tab=events、样本留在 /model-center，两个列表不再同页，
   ⑦/⑧ 各按各的落点整页导航（CF-5：同文档换 hash 不重载，会读到上一个面板的 DOM）。
   导航过来是冷启动，分页状态全 reset，所以失败态要的那「失败前按钮 >0」得自己铺：
   换每页 20 条 → 点第 2 页，onEv7 一并写进判据，铺不出来就是 FAIL 而不是空跑。 */
await goto(HOST.events);
const evSize7 = await pageSize("events", 20);
await page.settle(900);
const evPages7 = await lastPageNo("#evPager");
const onEv7 = evSize7 === 1 && evPages7 > 1 && await clickPage("events", 2);
await page.settle(700);
const evBtnBefore = await pagerBtnCount("events");
const evRowsMem = await page.eval(`(EV.rows || []).length`);
await failOnce("/api/fault-events");
await page.eval(`EV.refresh()`);
await page.settle(2200);
const evErrTxt = await page.eval(`(() => { const e = document.getElementById("evList"); return e ? e.textContent.trim() : "(容器不在)"; })()`);
const evBtnAfter = await pagerBtnCount("events");
log("事件取数失败：容器里是错误文案、分页条按钮清成 0（内存里那 " + evRowsMem + " 条旧行刷不掉它）",
    onEv7 === true && evBtnBefore > 0 && !evErrTxt.startsWith("(容器不在)") && /加载失败/.test(evErrTxt) && evBtnAfter === 0,
    "停第 2 页=" + onEv7 + "；失败前按钮 " + evBtnBefore + " 个 → 失败后 " + evBtnAfter + " 个；容器「" + evErrTxt.slice(0, 70) + "」");
const regEv = await regCheck("events", "EV.refresh()");
await page.settle(1500);
log("事件的 draw 登记在取数路径上（抹掉后 EV.refresh() 会重新登记；Task 3 搬 #evPager 后 mount 缺席也不哑）",
    regEv.ok === 1 && !regEv.err, JSON.stringify(regEv));

// —— 样本（同一个 catch 形状，容器 #mcSamples / 分页条 #mcSamplesPager；样本这次没搬家）——
await goto(HOST.samples);
const smSize7 = await pageSize("samples", 20);
await page.settle(900);
const smPages7 = await lastPageNo("#mcSamplesPager");
const onSm7 = smSize7 === 1 && smPages7 > 1 && await clickPage("samples", 2);
await page.settle(700);
const smBtnBefore = await pagerBtnCount("samples");
await failOnce("/api/model-center");
await page.eval(`MC.refresh()`);
await page.settle(2200);
const smErrTxt = await page.eval(`(() => { const e = document.getElementById("mcSamples"); return e ? e.textContent.trim() : "(容器不在)"; })()`);
const smBtnAfter = await pagerBtnCount("samples");
log("样本取数失败：容器里是错误文案、分页条按钮清成 0",
    onSm7 === true && smBtnBefore > 0 && /加载失败/.test(smErrTxt) && smBtnAfter === 0,
    "停第 2 页=" + onSm7 + "；失败前按钮 " + smBtnBefore + " 个 → 失败后 " + smBtnAfter + " 个；容器「" + smErrTxt.slice(0, 70) + "」");
const regSm = await regCheck("samples", "MC.refresh()");
await page.settle(1500);
log("样本的 draw 登记在取数路径上（抹掉后 MC.refresh() 会重新登记）",
    regSm.ok === 1 && !regSm.err, JSON.stringify(regSm));

// —— 核查卡：失败态 + 登记位置（先 goto 让 Report.rows 回到真实的那几条）——
await goto(HOST.report);
const repGrow2 = await page.eval(`(() => {
  const st = App.pagerState("report");
  const base = (Report.rows || []).slice();
  if (!base.length || !st || typeof st.draw !== "function")
    return {ok: 0, n: base.length, why: "rows 或 draw 不在，复制不了（rows " + base.length + " 条 / draw " + (st ? typeof st.draw : "无项") + "）"};
  const out = base.slice();
  for (let k = 2; out.length <= 10; k++)
    for (const x of base) {
      const c = JSON.parse(JSON.stringify(x));
      c.device = Object.assign({}, c.device, {code: String(x.device.code) + "副本坏" + k});
      c.sample_id = null;
      out.push(c);
      if (out.length > 10) break;
    }
  Report.rows = out; st.draw();
  return {ok: 1, n: out.length};
})()`);
await page.settle(700);
const repBtnBefore = await pagerBtnCount("report");
const repOn2 = await clickPage("report", 2);
await page.settle(700);
await failOnce("/api/daily-report");
await page.eval(`Report.load()`);
await page.settle(2200);
const repErrTxt = await page.eval(`(() => { const e = document.getElementById("reportItems"); return e ? e.textContent.trim() : "(容器不在)"; })()`);
const repBtnAfter = await pagerBtnCount("report");
log("核查卡取数失败：容器里是错误文案、分页条按钮清成 0（停在第 2 页也点不动）",
    repGrow2.ok === 1 && repBtnBefore > 0 && repOn2 === true && /报告加载失败/.test(repErrTxt) && repBtnAfter === 0,
    "复制成 " + repGrow2.n + " 条 / 失败前按钮 " + repBtnBefore + " 个（停在第 2 页=" + repOn2 + "）→ 失败后 " + repBtnAfter + " 个；容器「" + repErrTxt.slice(0, 70) + "」");
const regRep = await regCheck("report", "Report.load()");
await page.settle(1500);
log("核查卡的 draw 登记在取数路径上（抹掉后 Report.load() 会重新登记）",
    regRep.ok === 1 && !regRep.err, JSON.stringify(regRep));

// —— 维护记录：登记位置（#workRecordPager 的容器在 /devices 的维护记录页签里）——
await goto(HOST.worklog);
const regWl = await regCheck("worklog", "typeof loadWorkRecords === 'function' ? loadWorkRecords() : Promise.resolve()");
await page.settle(1500);
log("维护记录的 draw 登记在取数路径上（抹掉后 loadWorkRecords() 会重新登记）",
    regWl.ok === 1 && !regWl.err, JSON.stringify(regWl));

/* —— 维护记录：失败态（CF-8 的执行证据，⑦ 组第四条）——
   前面三条（事件 / 样本 / 核查卡）都验过「容器里是错误文案 + 分页条按钮清成 0」，
   唯独这条漏了，于是 page-devices.js 的 catch 停在旧形状（容器取值无守卫、清理行
   排在写文案之后）也能全绿。判据与前两条逐字同形：作用域按 data-pager 的 key 限定
   （不按容器 id，Task 3/4 之后 #workRecordPager 可能与别的分页条同屏），
   失败前先断言按钮数 >0，否则「本来就没分页条」会冒充「清理成功」。
   这一段放在 ⑧ 之后：catch 不动 draw 登记，取数恢复由下一条 goto 兜。 */
const wlBtnBefore = await pagerBtnCount("worklog");
const wlRowsMem = await page.eval(`(WR.rows || []).length`);
await failOnce("/api/work-records");
await page.eval(`loadWorkRecords()`);
await page.settle(2200);
const wlErrTxt = await page.eval(`(() => { const e = document.getElementById("workRecordList"); return e ? e.textContent.trim() : "(容器不在)"; })()`);
const wlBtnAfter = await pagerBtnCount("worklog");
log("维护记录取数失败：容器里是错误文案、分页条按钮清成 0（内存里那 " + wlRowsMem + " 条旧行刷不掉它）",
    wlBtnBefore > 0 && !wlErrTxt.startsWith("(容器不在)") && /维护记录加载失败/.test(wlErrTxt) && wlBtnAfter === 0,
    "失败前按钮 " + wlBtnBefore + " 个 → 失败后 " + wlBtnAfter + " 个；容器「" + wlErrTxt.slice(0, 70) + "」");

/* CF-8 的守卫那半，上面那条判据测不到：老写法是
     catch(e){ byId("workRecordList").textContent = …; const p=byId("workRecordPager"); if(p) p.innerHTML=""; }
   容器在、只是顺序反了的时候它两半都能过——它只在**容器没在**的时候才炸。而「容器没在」
   正是搬家途中的常态（Task 4/5 会把维护记录整段挪走；这里用「请求在飞的当口把节点摘掉」
   把这个形状原地复现出来：先同步发起取数，再摘节点，让异常落在 catch 里面）。
   旧写法此时会从 catch 里再抛一个 TypeError，async 函数抛出 = 一条未捕获异常，
   并把调用方（loadWorkRecords 还被搜索/重置/保存/删除五处 await 调）一起打断。 */
const exBase = page.logs.filter(x => x.startsWith("[EXCEPTION]")).length;
await failOnce("/api/work-records");
const wlRemoved = await page.eval(`(() => {
  const p = loadWorkRecords();                       // 先同步发起，取数还在飞
  const el = document.getElementById("workRecordList");
  if (el) el.remove();                                // 再摘掉容器：搬家途中的形状
  return !!el;
})()`);
await page.settle(1800);
const wlNewEx = page.logs.filter(x => x.startsWith("[EXCEPTION]")).length - exBase;
log("维护记录容器在取数在飞时被摘掉：catch 不再抛出未捕获异常（CF-8 的守卫）",
    wlRemoved === true && wlNewEx === 0,
    "摘掉节点=" + wlRemoved + "；新增未捕获异常 " + wlNewEx + " 条：" +
    page.logs.filter(x => x.startsWith("[EXCEPTION]")).slice(-1)[0]);

console.log("");
for (const r of results) console.log((r.p ? "PASS " : "FAIL ") + r.n + (r.d ? "  | " + r.d : ""));
console.log("");
console.log("合计 " + results.length + " 项，失败 " + fails + " 项。");
reap();
process.exit(fails ? 1 : 0);
