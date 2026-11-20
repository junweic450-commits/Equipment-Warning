/* ==========================================================================
   events.js · 故障事件与设备生命周期的录入与导入
   这两张表是「最可能故障」和「剩余寿命」唯一的真值来源：训练中心标的类型标签
   会自动生成事件，而历史纸面记录只能从这里补进来。所有字段与导入走服务端
   同一道闸（equipment_db.clean_event_record），前端只做回填与提示，不另判一遍。
   ========================================================================== */
"use strict";

const EV = {
  table: "fault_events",
  opts: {fault_type: [], severity: [], kind: []},
  rows: [],
  counts: {},
  limits: {},          // 训练门禁的条数口径由服务端递过来，这里不自己写死
  editingId: 0,          // 0 = 新增；非 0 = 改这一条
  preview: null,         // 导入预检的结果，确认后才允许真写
  fileName: "",

  apiBase(){ return this.table === "fault_events" ? "/api/fault-events" : "/api/lifecycle"; },

  devices(){
    const s = App.state();
    return (s && s.devices || []).map(d => d.code);
  },

  setTable(t){
    this.table = t === "lifecycle" ? "device_lifecycle" : "fault_events";
    this.editingId = 0; this.preview = null; this.fileName = "";
    App.pagerState("events").page = 1;   // 换表就是换了一批行，停在第 3 页看着像少了几条
                                         // （refresh 入口不再复位，这一行是「换表」唯一的复位点）
    this.renderForm();
    this.refresh();
  },

  renderForm(){
    const box = App.byId("evForm");
    if (!box) return;
    box.innerHTML = this.formHTML();
    this.syncForm();
  },

  /* 首屏那一刻台账列表和故障类型枚举都还没到手：那会儿「设备编号」只能做成自由输入、
     「故障类型」下拉是空的，录进去必被服务端挡下。用结构判断这份表单到不到位，
     不靠记号——记号会在切表时自己失效。 */
  formFilled(){
    const codes = this.devices();
    const haveOpts = this.table === "fault_events" ? this.opts.fault_type.length : this.opts.kind.length;
    const sel = App.byId("ev_code"), typ = App.byId("ev_type");
    if (!sel || !typ) return false;
    if (codes.length && sel.tagName !== "SELECT") return false;
    if (haveOpts && !typ.options.length) return false;
    return true;
  },

  /* 数据到手后补渲染一次；人已经动手填了就不打扰，免得把填了一半的内容冲掉。 */
  syncForm(){
    const box = App.byId("evForm");
    if (!box || this.formFilled()) return;
    if ([...box.querySelectorAll("input")].some(e => String(e.value || "").trim())) return;
    box.innerHTML = this.formHTML();
  },

  setEditing(id){
    this.editingId = Number(id) || 0;
    const r = this.rows.find(x => String(x.id) === String(id));
    if (!r) return;
    const set = (k, v) => { const e = App.byId("ev_" + k); if (e) e.value = v || ""; };
    set("code", r.code);
    set("time", (this.table === "fault_events" ? r.fail_time : r.event_time) || "");
    set("type", this.table === "fault_events" ? r.fault_type : r.kind);
    if (this.table === "fault_events"){
      set("severity", r.severity); set("action", r.action);
      set("restore", r.restore_time);
    }
    set("note", r.note);
    App.byId("evFormTitle").textContent = "改这条 · #" + r.id + "（" + r.code + "）";
    /* Task 3 搬家改的滚动目标：原来那句写作 App.byId("tableWrap") && …，条件表达的是
       「台账表与表单同屏」——那是事件分区还住在 /model-center 时的旧世界。搬到
       /devices 之后 #tableWrap 与表单同页但分处两个面板（它藏在「设备信息」签里、
       被 hidden），这个判断恒为真，什么也拦不住，只是把「同屏」这个已经不存在的前提
       留在代码里误导读者；反过来哪一页只挂 EV 不挂台账表，滚动就会被静默跳过。
       所以条件删掉，滚到表单自己这里就是要点题的行为。 */
    App.byId("evForm").scrollIntoView({block: "nearest"});
  },

  /* 筛选变更点：#evFilterCode / #evFilterStatus 的 onchange 只走这里。
     换了条件就是换了一批行，页码必须跟着回第一页——paginate 只把越界的页码收到
     最后一页，人停在第 3 页看到的是筛剩那一撮的尾巴。写法照 common.js 的
     bindTableFilter()（复位就写在筛选控件自己的处理里）。
     为什么不放 refresh() 入口：refresh 的入口不止筛选——「刷新」按钮、保存/删除/
     导入之后的重取、mount() 都调它，那些场景人只是想看同一页的新数据，踢回第 1 页
     反而找不到刚改的那一行（与 Report.save() 留在当前页同一语义）。 */
  onFilter(){
    App.pagerState("events").page = 1;
    return this.refresh();
  },

  async refresh(){
    const box = App.byId("evList");
    if (!box) return;
    const code = (App.byId("evFilterCode") || {}).value || "";
    const status = (App.byId("evFilterStatus") || {}).value || "";
    let url = this.apiBase() + "?";
    if (code) url += "code=" + encodeURIComponent(code) + "&";
    if (status && this.table === "fault_events") url += "status=" + encodeURIComponent(status);
    try{
      const r = await App.api(url);
      this.rows = r.events || [];
      this.counts = r.counts || {};
      this.limits = r.limits || this.limits || {};
      this.opts = Object.assign(this.opts, r.options || {});
      /* CF-7：draw 登记必须站在取数路径上（原来只在 mount() 里写一次）。
         #evPager 是静态容器，Task 3 已把它整段搬进 /devices#tab=events；搬家时那行
         <script>EV.mount();</script> 一旦漏加或换了顺序，st.draw 就是空的，
         common.js 的翻页监听会退回全局 render()——页码写进了 S.pager 却没人重画
         #evList，表现是「点了没反应」，而且一条错误都不抛，最难查。登记跟着取数
         走就没有这个死角：任何一次取数成功都会把它补上。写法照 report.js:12 /
         model-center.js:62 / page-devices.js:79。 */
      App.pagerState("events").draw = () => EV.renderList();
      this.renderChips();
      this.renderList();
      this.renderCodes();
      this.syncForm();
    }catch(e){ box.innerHTML = `<div class="empty">加载失败：${App.esc(e.message)}</div>`;
      const pe = App.byId("evPager"); if (pe) pe.innerHTML = ""; }   // 取数失败就不留上一页的分页条：点了会用内存里的旧快照盖掉这条错误
  },

  renderCodes(){
    const sel = App.byId("evFilterCode");
    if (!sel || sel.dataset.filled) return;
    sel.dataset.filled = "1";
    const list = this.devices();
    sel.innerHTML = `<option value="">全部设备</option>` +
      list.map(c => `<option value="${App.esc(c)}">${App.esc(c)}</option>`).join("");
  },

  renderChips(){
    const box = App.byId("evCounts");
    if (!box) return;
    const by = this.counts.by_type || {};
    const c = this.devices().length;
    box.innerHTML = `<span class="pill">共 ${this.counts.total || 0} 条</span>` +
      `<span class="pill">覆盖 ${this.counts.devices || 0} / ${c} 台设备</span>` +
      (this.table === "fault_events" ? `<span class="pill">待确认 ${this.counts.pending || 0} 条</span>` : "") +
      Object.entries(by).map(([k, v]) => `<span class="pill">${App.esc(k)} ${v}</span>`).join("");
  },

  renderList(){
    const box = App.byId("evList");
    if (!box) return;
    if (!this.rows.length){
      const min = this.limits.fault_min_events, rul = this.limits.rul_min_failures;
      box.innerHTML = `<div class="empty">这张表还是空的。${
        this.table === "fault_events"
          ? (min && rul
              ? `「最可能故障」要 ${min} 条以上、「剩余寿命」要 ${rul} 次以上已确认失效事件才训得动——先把现场的失效记录录进来。`
              : "已确认失效事件不够多，「最可能故障」和「剩余寿命」都训不动——先把现场的失效记录录进来。")
          : "投运、计划检修、更换复位这些记录用来把非故障的停机从剩余寿命标签里摘出去。"
      }</div>`;
      const p0 = App.byId("evPager"); if (p0) p0.innerHTML = "";
      return;
    }
    const pg = App.paginate(this.rows, "events");
    const fault = this.table === "fault_events";
    box.innerHTML = `<div class="table-scroll"><table class="mc-table"><tr>` +
      (fault ? `<th>编号</th><th>失效时间</th><th>故障类型</th><th>程度</th><th>处理措施</th><th>恢复时间</th>`
             : `<th>编号</th><th>事件时间</th><th>事件类型</th><th>备注</th>`) +
      `<th>来源</th><th>状态</th><th>操作</th></tr>` +
      pg.rows.map(r => `<tr>
        <td>${App.esc(r.code)}</td>
        <td>${App.esc(fault ? r.fail_time : r.event_time)}</td>
        <td>${App.esc(fault ? r.fault_type : r.kind)}</td>
        ${fault ? `<td>${App.esc(r.severity || "—")}</td><td>${App.esc(r.action || "—")}</td><td>${App.esc(r.restore_time || "—")}</td>`
                : `<td>${App.esc(r.note || "—")}</td>`}
        <td>${App.esc(this.sourceText(r))}</td>
        <td>${App.esc(r.status === "confirmed" ? "已确认" : (r.status === "pending" ? "待确认" : r.status || "—"))}</td>
        <td><button class="btn ghost small" onclick="EV.setEditing(${r.id})">改</button>
            <button class="btn danger small" onclick="EV.del(${r.id})">删</button></td>
      </tr>`).join("") + `</table></div>`;
    const p = App.byId("evPager");
    if (p) p.innerHTML = pg.pages > 1
      ? App.pagerHTML("events", pg.page, pg.pages, this.rows.length, pg.size) : "";
  },

  sourceText(r){
    if (r.source === "feedback") return "反馈闭环";
    if (r.source === "import") return "批量导入";
    return "人工录入";
  },

  formHTML(){
    const fault = this.table === "fault_events";
    const codes = this.devices();
    const codeSel = codes.length
      ? `<select id="ev_code">${codes.map(c => `<option value="${App.esc(c)}">${App.esc(c)}</option>`).join("")}</select>`
      : `<input id="ev_code" placeholder="台账里还没有设备，先去设备台账录入" />`;
    const typeSel = fault
      ? `<select id="ev_type">${(this.opts.fault_type || []).map(t => `<option value="${App.esc(t)}">${App.esc(t)}</option>`).join("")}</select>`
      : `<select id="ev_type">${(this.opts.kind || []).map(t => `<option value="${App.esc(t)}">${App.esc(t)}</option>`).join("")}</select>`;
    return `<div class="row2">
        <div><label>设备编号</label>${codeSel}</div>
        <div><label>${fault ? "失效时间" : "事件时间"}（建议填到时刻）</label><input id="ev_time" type="datetime-local" /></div>
      </div>
      <div class="row2">
        <div><label>${fault ? "故障类型" : "事件类型"}</label>${typeSel}</div>
        ${fault ? `<div><label>严重程度（可留空）</label><select id="ev_severity"><option value="">未填</option>${
            (this.opts.severity || []).map(s => `<option value="${App.esc(s)}">${App.esc(s)}</option>`).join("")}</select></div>`
                : `<div><label>备注</label><input id="ev_note" maxlength="500" placeholder="换了什么、为什么换" /></div>`}
      </div>
      ${fault ? `<div class="row2">
        <div><label>处理措施</label><input id="ev_action" maxlength="500" placeholder="例如：更换机械密封" /></div>
        <div><label>恢复时间（可留空）</label><input id="ev_restore" type="datetime-local" /></div>
      </div>
      <div><label>备注</label><input id="ev_note" maxlength="500" placeholder="拆检看到了什么" /></div>` : ""}
      <div class="row2">
        <div><label>录入人</label><input id="ev_reviewer" maxlength="80" placeholder="谁确认的这条" /></div>
        <div class="btn-row" style="align-self:end">
          <button class="btn small" onclick="EV.save()">保存这条</button>
          <button class="btn ghost small" onclick="EV.resetForm()">清空</button>
        </div>
      </div>
      <div id="evErr" class="warn" style="display:none"></div>`;
  },

  resetForm(){
    this.editingId = 0;
    App.byId("evFormTitle").textContent = "录一条新的";
    ["code", "time", "type", "severity", "action", "restore", "note", "reviewer"]
      .forEach(k => { const e = App.byId("ev_" + k); if (e && e.tagName !== "SELECT") e.value = ""; });
    this.showErr("");
  },

  showErr(msg){
    const box = App.byId("evErr");
    if (!box) return;
    box.style.display = msg ? "block" : "none";
    box.textContent = msg;
  },

  collect(){
    const get = k => { const e = App.byId("ev_" + k); return e ? e.value.trim() : ""; };
    const fault = this.table === "fault_events";
    const body = {
      code: get("code"),
      reviewer: get("reviewer"),
      note: get("note"),
    };
    if (fault){
      body.fail_time = get("time");
      body.fault_type = get("type");
      body.severity = get("severity");
      body.action = get("action");
      body.restore_time = get("restore");
    }else{
      body.event_time = get("time");
      body.kind = get("type");
    }
    return body;
  },

  async save(){
    const body = this.collect();
    const isNew = !this.editingId;          // resetForm() 会把 editingId 清零，判定必须提前取
    try{
      const url = this.editingId ? this.apiBase() + "/update" : this.apiBase();
      if (this.editingId) body.id = this.editingId;
      await App.api(url, {method: "POST", headers: {"Content-Type": "application/json"},
                          body: JSON.stringify(body)});
      this.showErr("");
      this.resetForm();
      /* 控制器裁定（M-b）：复位只补在「行集被这次动作改了」的现场。新增会插进一行，
         而 /api/fault-events 按失效时间倒序（equipment_db.py 的 ORDER BY），新行必然
         落在第 1 页——人停在第 3 页就永远看不见自己刚录的那条，所以新增分支回第 1 页。
         编辑已有记录行集没变，不复位，保存完留在原地；refresh() 入口仍然永远不复位
         （那条语义由 ⑥a/⑥b/⑥c 三条反向钉闩着）。 */
      if (isNew) App.pagerState("events").page = 1;
      await this.refresh();
      /* Task 3 删掉了这里那句「await 训练中心刷新」（save / del / runImport 三处一起删）：
         它调的是 model-center.js 的 ModelCenter 全局，事件分区搬来 /devices 之后这一页
         根本不加载那个脚本，语句会抛 ReferenceError，被本函数这个 catch 接住、
         在**已经写成功**之后报「没写进去：ModelCenter is not defined」。
         也不留 if (window.ModelCenter) 的假兼容：跨页实时刷新在搬家后没有消费者——
         训练中心自己的 15 秒轮询（common.js watchRemoteChange）会取到新条数。
         自查口径：本文件里对 ModelCenter 的调用为 0（grep -c "MC[.]" 应为 0）。 */
    }catch(e){ this.showErr("没写进去：" + e.message); }
  },

  async del(id){
    if (!confirm("删除这条记录？已确认的失效事件删掉后，训练标签也少一条。")) return;
    try{
      await App.api(this.apiBase() + "/delete", {method: "POST",
        headers: {"Content-Type": "application/json"}, body: JSON.stringify({id})});
      if (this.editingId === id) this.resetForm();
      await this.refresh();
      // Task 3：删掉了「await 训练中心刷新」那一句，理由见 save() 里那段注释
    }catch(e){ alert(e.message); }
  },

  /* ------------------------------------------------------------ 批量导入 */
  onFile(input){
    const f = input.files && input.files[0];
    this.fileName = f ? f.name : "";
    this.preview = null;
    if (!f) return;
    if (/\.(xlsx|xlsm)$/i.test(f.name)){
      const rd = new FileReader();
      rd.onload = () => {
        const bytes = new Uint8Array(rd.result);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        this.b64 = btoa(bin);
        this.renderPreview(null);
      };
      rd.readAsArrayBuffer(f);
    }else{
      const rd = new FileReader();
      rd.onload = () => { this.text = String(rd.result || ""); this.b64 = ""; this.renderPreview(null); };
      rd.readAsText(f, "utf-8");
    }
  },

  importPayload(dry){
    const p = {dry_run: dry, reviewer: (App.byId("ev_reviewer") || {}).value || ""};
    if (this.b64) p.xlsx_b64 = this.b64; else p.text = this.text;
    return p;
  },

  async runImport(dry){
    if (!this.b64 && !(this.text || "").trim()){
      alert("先选择 CSV 或 Excel 文件。模板可以点上方「下载模板」。"); return;
    }
    const btn = App.byId(dry ? "evPre" : "evApply");
    if (btn) btn.disabled = true;
    try{
      const r = await App.api(this.apiBase() + "/import", {method: "POST",
        headers: {"Content-Type": "application/json"}, body: JSON.stringify(this.importPayload(dry))});
      this.preview = r;
      this.renderPreview(r);
      if (!dry && !r.dry_run){
        await this.refresh();
        // Task 3：删掉了「await 训练中心刷新」那一句，理由见 save() 里那段注释
      }
    }catch(e){
      this.renderPreview({error: e.message});
    }finally{
      if (btn){ btn.disabled = false; }
      const apply = App.byId("evApply");
      if (apply) apply.disabled = !this.canApply();
    }
  },

  /* 「确认导入」只在手里确实有一份还没落库、且真能写进东西的预检结果时才可点，
     免得预检没跑或全是坏行时也能按下去，写 0 条还装作成功。 */
  canApply(){
    const p = this.preview;
    return !!(p && p.ok && p.dry_run && p.added > 0);
  },

  renderPreview(r){
    const box = App.byId("evPreview");
    if (!box) return;
    const apply = App.byId("evApply");
    if (!r){
      box.innerHTML = `<div class="hint">选了文件先「预检」：预检只会告诉你能进几条、哪几行有问题，一条都不写库。</div>`;
      if (apply) apply.disabled = true;
      return;
    }
    if (r.error){
      box.innerHTML = `<div class="warn">预检没通过：${App.esc(r.error)}</div>`;
      if (apply) apply.disabled = true;
      return;
    }
    const errs = (r.errors || []).map(e =>
      `<tr><td>${e.line}</td><td>${App.esc(e.code)}</td><td>${App.esc(e.reason)}</td></tr>`).join("");
    if (apply) apply.disabled = !this.canApply();
    box.innerHTML = `<div class="sample">
      <b>${r.dry_run ? "预检结果（还没写库）" : "已导入"}</b>
      <div class="sample-values"><span>读到 ${r.total} 行</span><span>${r.dry_run ? "可写入" : "已写入"} ${r.added} 条</span>
        <span>重复跳过 ${r.skipped} 条</span><span>有问题 ${r.failed} 行</span><span>来源 ${App.esc(r.source || "")}</span></div>
      ${r.errors_hidden ? `<div class="hint">另有 ${r.errors_hidden} 行问题没列出。</div>` : ""}
      ${errs ? `<div class="table-scroll"><table class="mc-table"><tr><th>行号</th><th>编号</th><th>原因</th></tr>${errs}</table></div>`
             : `<div class="hint good">每一行都过了字段闸。</div>`}
      ${(r.unknown || []).length ? `<div class="hint">这些表头不认识，已忽略：${App.esc(r.unknown.join("、"))}</div>` : ""}
      ${r.dry_run ? `<div class="btn-row" style="margin-top:10px"><button class="btn" id="evGo" onclick="EV.runImport(false)">确认写入 ${r.added} 条</button></div>` : ""}
    </div>`;
    const go = App.byId("evGo");
    if (go) go.textContent = "确认写入 " + r.added + " 条";
  },

  headHTML(){
    const fault = this.table === "fault_events";
    return `<select id="evTable" onchange="EV.setTable(this.value)">
        <option value="fault_events"${fault ? " selected" : ""}>故障事件（失效记录）</option>
        <option value="lifecycle"${fault ? "" : " selected"}>设备生命周期（投运 / 检修 / 更换）</option>
      </select>
      <select id="evFilterCode" onchange="EV.onFilter()"></select>
      ${fault ? `<select id="evFilterStatus" onchange="EV.onFilter()">
          <option value="">全部状态</option><option value="confirmed">只看已确认</option>
          <option value="pending">只看待确认</option></select>` : ""}
      <button class="btn ghost small" onclick="EV.refresh()">刷新</button>
      <a class="btn ghost small" href="${fault ? "/api/fault-events/template.csv" : "/api/lifecycle/template.csv"}" download>下载模板</a>
      <input type="file" id="evFile" accept=".csv,.txt,.xlsx,.xlsm" onchange="EV.onFile(this)" />
      <button class="btn ghost small" id="evPre" onclick="EV.runImport(true)">预检</button>
      <button class="btn small" id="evApply" onclick="EV.runImport(false)" disabled>确认导入</button>`;
  },

  mount(){
    const box = App.byId("evHead");
    if (box) box.innerHTML = this.headHTML();
    /* 这里原来有一行 App.pagerState("events").draw = () => EV.renderList()：
       它和取数路径上的那次登记是同一件事，留两处就是两套机制，Task 3 搬家时
       很容易只改到这一处。登记单点收在 refresh() 的成功分支（见 CF-7 注释）。 */
    this.renderForm();
    this.refresh();
  },
};

window.EV = EV;
