/* Minimal Chrome DevTools Protocol driver (Node >=21 native WebSocket).
   Boots headless Chrome once, drives many checks in a single page session. */
import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function startChrome({port = 0, headless = true} = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), "pex-cdp-"));
  const args = [
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + userDataDir,
    "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-gpu",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
  ];
  if (headless) args.unshift("--headless=new");
  const proc = spawn(CHROME, args, {stdio: ["ignore", "ignore", "pipe"]});
  let target = null;
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250));
    // port 0 时 Chrome 自己挑空闲端口，写进 DevToolsActivePort。
    // 之前固定 9333：上一轮崩溃漏下来的实例一直占着它，新脚本就连到了那个死浏览器，
    // 每条 eval 都超时，看起来像前端坏了。
    let real = port;
    if (!real) {
      try {
        real = Number(readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8")
          .split("\n")[0].trim());
      } catch { continue; }
      if (!real) continue;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${real}/json/version`);
      target = await res.json();
      port = real;
      break;
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error("Chrome did not start");
  // 探针被 SIGTERM/Ctrl-C/上层取消掐掉时 process.on("exit") 不跑，浏览器就留在这儿。
  // 攒够几十个，机器开始打晃，之后每条 eval 都等满 45 秒才报超时——看着像前端坏了，
  // 其实是这台机上跑着几十个没人收的页签。
  const reap = () => { try { proc.kill("SIGKILL"); } catch { /* 已经走了 */ } };
  process.on("exit", reap);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { reap(); process.exit(0); });
  }
  return {proc, wsUrl: target.webSocketDebuggerUrl, port, userDataDir, reap};
}

export class CDP {
  constructor() {
    this.id = 0; this.pending = new Map(); this.listeners = [];
    // 监听器里抛出的错记在这儿，超时诊断时一起倒出来，免得「谁把收包打断了」查不到
    this.broken = [];
    // 每个在途请求登记 method + 起始时间；超时那一刻把"还有谁没回来"倒出来，
    // 才能分辨是页签卡死（页签的定时器仍在跑，说明不是）还是某条命令被吞了。
    this.inflight = new Map(); this.doneLog = [];
  }

  connect(url) {
    this.url = url;
    return new Promise((resolve, reject) => this._open(resolve, reject));
  }

  _open(resolve, reject) {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => resolve(this);
    ws.onerror = e => reject(new Error("ws error: " + (e.message || e.type)));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve: res, reject: rej, method, t0} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        this.inflight.delete(msg.id);
        this.doneLog.push(method + " +" + (Date.now() - t0) + "ms");
        if (this.doneLog.length > 60) this.doneLog.shift();
        if (msg.error) rej(new Error(msg.error.message + " " + JSON.stringify(msg.error.data || {})));
        else res(msg.result);
      } else if (msg.method) {
        // 事件里的监听器一旦抛错，undici 会把这条 ws 的读取循环悄悄停掉：
        // 之后所有命令都干等 45 秒，看着像「页面卡死」。这里兜住，绝不让它打断收包。
        for (const fn of this.listeners) {
          try { fn(msg); } catch (err) { this.broken.push(fn.name + ": " + err.message); }
        }
      }
    };
  }

  /* 判别用：另开一条到同一个浏览器的连接。原来那条失声时，新连接仍能立刻回话，
     就能把「浏览器/页面真的卡死」和「我这条 socket 不再收包」分开。 */
  async openSideChannel() {
    const side = new CDP();
    await side.connect(this.url);
    return side;
  }

  /* 换一条全新的 socket，把 pending/inflight/listeners 原样带过去。 */
  async reconnect() {
    try { this.ws.close(); } catch { /* 已经断了 */ }
    await new Promise((resolve, reject) => this._open(resolve, reject));
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = {id, method, params};
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      this.pending.set(id, {resolve, reject, method, t0});
      this.inflight.set(id, {method, t0, sessionId});
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.inflight.delete(id);
        const now = Date.now();
        const others = [...this.inflight.values()]
          .map(x => "      #" + x.method + " 已等 " + ((now - x.t0) / 1000).toFixed(1) + "s")
          .join("\n");
        const recent = this.doneLog.slice(-6).join(", ");
        console.error("[" + method + " 超时 id=" + id + "]\n" +
          "    同批仍未返回的请求：\n" + (others || "      (无，只有这一条在途)") +
          "\n    最近成功返回的：" + recent +
          "\n    在途总数=" + this.inflight.size +
          (this.broken.length ? "\n    监听器抛过的错：" + this.broken.slice(-4).join(" / ") : ""));
        reject(new Error(method + " timed out"));
      }, 45000);
    });
  }

  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/* One page session with its own target; console + pageerror are captured. */
export async function openPage(cdp, port, width = 1440, height = 900) {
  // 用 CDP 建目标，不用 HTTP 的 /json/new：后者在 headless=new 下偶尔返回空对象，
  // 拿到的 id  attach 不上就一直干等到超时（第二个页签挂住就是这么来的）。
  const {targetId} = await cdp.send("Target.createTarget", {url: "about:blank"});
  let sessionId = null;
  for (let i = 0; i < 4 && !sessionId; i++) {
    try {
      sessionId = (await cdp.send("Target.attachToTarget",
        {targetId, flatten: true})).sessionId;
    } catch (e) {
      await new Promise(r => setTimeout(r, 500));
      if (i === 3) throw e;
    }
  }
  const logs = [];
  cdp.on(function pageEvents(msg) {
    if (!msg.sessionId || msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.consoleAPICalled") {
      logs.push("[" + msg.params.type + "] " + (msg.params.args || [])
        .map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      logs.push("[EXCEPTION] " + (d.exception && (d.exception.description || d.exception.value) || d.text));
    } else if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      if (e.level === "error" || e.level === "warning") logs.push("[" + e.source + ":" + e.level + "] " + e.text);
    } else if (msg.method === "Page.javascriptDialogOpening") {
      const p = msg.params;
      logs.push("[DIALOG:" + p.type + "] " + p.message);
      // headless 里没人应答的原生弹窗会把这个页签的 JS 一直卡住：之后每条 eval
      // 都要等满 45 秒才报 "Runtime.evaluate timed out"，看着像前端坏了。
      // 这里记下文案并自动应答；confirm 一律答否，避免默认走进删除分支。
      cdp.send("Page.handleJavaScriptDialog",
        {accept: p.type !== "confirm"}, sessionId).catch(() => {});
    }
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride",
    {width, height, deviceScaleFactor: 1, mobile: false}, sessionId);
  return {
    // 用 getter：换连接后 sessionId 会变，直接快照出去的旧 id 会让探针把命令发到
    // 一个已经不存在的 session 上（别的探针用 page.sessionId 发 Raw 命令，必须跟着换）
    get sessionId() { return sessionId; },
    targetId, logs,
    goto: url => cdp.send("Page.navigate", {url}, sessionId),
    eval: async expression => {
      let r;
      try {
        r = await cdp.send("Runtime.evaluate",
          {expression, returnByValue: true, awaitPromise: true}, sessionId);
      } catch (e) {
        // 卡住的页签不会自己交代原因，这里把它最后听到的东西倒出来再看一次
        if (!/timed out/.test(e.message)) throw e;
        console.error("[eval 超时] " + String(expression).slice(0, 70) + "\n  最近日志：" +
                      (logs.slice(-8).join("\n            ") || "(空)"));
        // 判别手段：另开一条到同一个浏览器的连接，问同一个页签要 1+1。
        // 为什么不能用自己这条连接上的新 session：这条 socket 一旦失声，
        // 它连 Target.attachToTarget 都不会回，用它判别等于自己查自己，
        // 只会把「我没收到包」误判成「页面主线程卡死」（本报告里踩过的坑）。
        // 回话 = 页面 JS 正常，坏的是我这条连接；不回话 = 页面真卡死，才去查前端。
        let alive = false, side = null;
        try {
          side = await cdp.openSideChannel();
          const s2 = (await side.send("Target.attachToTarget", {targetId, flatten: true})).sessionId;
          const v = await side.send("Runtime.evaluate",
            {expression: "1+1", returnByValue: true}, s2);
          alive = !!(v && v.result && v.result.value === 2);
        } catch (e2) {
          console.error("  旁路连接也不回话（" + e2.message + "）⇒ 页面主线程真的卡死");
        } finally { if (side) side.close(); }
        if (!alive) throw new Error("页面主线程卡死：旁路连接问 1+1 也不回话");
        console.error("  旁路连接问 1+1 回来了 ⇒ 页面正常，是我这条 socket 不再收包，换连接重试");
        await cdp.reconnect();
        sessionId = null;
        for (let i = 0; i < 4 && !sessionId; i++) {
          try {
            sessionId = (await cdp.send("Target.attachToTarget",
              {targetId, flatten: true})).sessionId;
          } catch (e2) {
            await new Promise(res => setTimeout(res, 500));
            if (i === 3) throw e2;
          }
        }
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Log.enable", {}, sessionId);
        r = await cdp.send("Runtime.evaluate",
          {expression, returnByValue: true, awaitPromise: true}, sessionId);
      }
      if (r.exceptionDetails) {
        throw new Error("eval threw: " + (r.exceptionDetails.exception
          ? (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value)
          : r.exceptionDetails.text));
      }
      return r.result.value;
    },
    settle: async ms => { await new Promise(r => setTimeout(r, ms)); },
    close: () => cdp.send("Target.closeTarget", {targetId}).catch(() => {}),
  };
}
