import {readFileSync} from "node:fs";
import {startChrome, CDP, openPage} from "./cdp.mjs";

/* 重组最怕书签失效：① 旧地址必须 302 到新位置；② 站内 href 只能指向存在的路径
   或本页存在的页签 id。页签 id 用 DOM 校验，路径用 HTTP 校验。 */
const PORT = readFileSync("/tmp/pex/PORT", "utf8").trim();
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const TABS = {"/": ["board", "analysis"], "/report": ["verify", "samples"],
              "/devices": ["info", "worklog", "env"], "/model-center": ["train", "data", "health", "history"]};
let fails = 0; const results = [];
const log = (n, p, d) => { if (!p) fails++; results.push({n, p: !!p, d: String(d ?? "").slice(0, 200)}); };

for (const old of ["/risk", "/risk.html"]) {
  const r = await fetch(BASE + old, {redirect: "manual"});
  log(`${old} 返回 302`, r.status === 302, "实际 " + r.status);
  log(`${old} 落到 #tab=analysis`, (r.headers.get("location") || "") === "/#tab=analysis",
      "Location=" + r.headers.get("location"));
  const follow = await fetch(BASE + old, {redirect: "follow"});
  log(`${old} 跟随后是 200 概览页`, follow.status === 200 && (await follow.text()).includes("风险看板"), "status " + follow.status);
}

const {proc, port} = await startChrome();
const reap = () => { try { proc.kill("SIGKILL"); } catch {} };
process.on("exit", reap);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { reap(); process.exit(0); });
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = new CDP();
await cdp.connect(ver.webSocketDebuggerUrl);
const page = await openPage(cdp, port, 1440, 900);

for (const path of Object.keys(TABS)) {
  await page.goto(BASE + path); await page.settle(2400);
  const links = await page.eval(`[...document.querySelectorAll("main a[href], .nav a[href]")].map(a=>a.getAttribute("href"))`);
  const bad = [];
  for (const h of links) {
    if (/^https?:/.test(h) || /^mailto:/.test(h)) continue;
    if (h.startsWith("/api/")) { const r = await fetch(BASE + h); if (r.status >= 400) bad.push(h + " → " + r.status); continue; }
    const [p0, hash] = h.split("#");
    if (!p0) continue;                                   // 纯 hash，本页内
    const clean = p0.replace(/\.html$/, "");
    if (!(clean in TABS)) { const r = await fetch(BASE + p0, {redirect: "manual"}); if (r.status >= 400) bad.push(h + " → " + r.status); continue; }
    if (hash) {
      const m = /tab=([\w-]+)/.exec(hash);
      if (m && !TABS[clean].includes(m[1])) bad.push(h + " 页签不存在");
    }
  }
  log(`${path} 站内零死链`, bad.length === 0, bad.join(" | "));
  log(`${path} 导航 4 项`, await page.eval(`document.querySelectorAll(".nav a").length === 4`),
      await page.eval(`[...document.querySelectorAll(".nav a")].map(a=>a.getAttribute("href")).join(",")`));
  log(`${path} 导航不含 /risk`, await page.eval(`![...document.querySelectorAll(".nav a")].some(a=>a.getAttribute("href").indexOf("/risk")>=0)`));
}
console.log("");
for (const r of results) console.log((r.p ? "PASS " : "FAIL ") + r.n + (r.d ? "  | " + r.d : ""));
console.log("");
console.log("合计 " + results.length + " 项，失败 " + fails + " 项。");
reap();
process.exit(fails ? 1 : 0);
