"use strict";
App.boot({cardPage:0,rowPage:0,fullTable:false,env:false});
const MC={
  options:{},
  health:null,
  summary:{},
  /* 两套模型的名字在文案里各出现三次，收在这一处；列名（首页那一格）与模型名不同，分开存。 */
  KIND_COL:{fault_type:"最可能故障",rul:"剩余寿命"},
  KIND_MODEL:{fault_type:"故障分类",rul:"剩余寿命"},
  kindLabel(kind){return MC.KIND_MODEL[kind]||kind;},
  pillClass(status){return status==="published"?"good":(status==="candidate_rejected"?"bad":"");},
  spans(cells){return cells.map(x=>`<span>${x[0]}：${x[1]}</span>`).join("");},
  /* 冷却秒数只跟接口走：后端改成别的数，这里的提示不会还写着 60 秒。 */
  intervalText(){
    const n=MC.summary&&MC.summary.train_interval_seconds;
    return n?`两次训练至少间隔 ${n} 秒。`:"两轮训练之间有时间闸，连点会被挡下。";
  },
  /* 「确认 → POST → 弹提示 → 刷新」四处共用这一个驱动，各自只给接口和文案。 */
  async act(o){
    if(!confirm(o.confirm))return;
    try{
      const r=await App.api(o.url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o.body||{})});
      alert(r.message||o.fallback);
      await MC.refresh();
    }catch(e){alert(o.failText+e.message);}
  },
  /* 训练同款：禁用按钮 → 占位文案 → 渲染结果 → 刷新 → 恢复按钮。 */
  async runTrain(o){
    const btn=document.getElementById(o.btnId), box=document.getElementById(o.boxId);
    if(!confirm(o.confirm))return;
    btn.disabled=true;btn.textContent="训练中，请稍候…";box.textContent=o.busy;
    try{
      const r=await App.api(o.url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o.body||{})});
      box.innerHTML=o.render(r);
      await MC.refresh();
    }catch(e){box.innerHTML=`<div class="warn">训练失败：${App.esc(e.message)}</div>`;}
    finally{btn.disabled=false;btn.textContent=o.label;}
  },
  /* 筛选变更点：#mcFilter 的 onchange 只走这里（写法照 common.js bindTableFilter，
     复位挂在条件变化那一刻）。不放 refresh() 入口：它还被本页的「刷新数据」、
     训练/审批写完后的重取、以及事件脚本的跨页调用触达，那些不是换了一批行，
     把人从第 4 页踢回第 1 页就再也找不到自己正在看的那条样本。 */
  onFilter(){
    App.pagerState("samples").page=1;
    return MC.refresh();
  },
  async refresh(){
    const status=document.getElementById("mcFilter")?.value||"pending";
    try{
      const r=await App.api("/api/model-center?status="+encodeURIComponent(status));
      const s=r.summary||{}, counts=r.data?.counts||{};
      MC.options=r.options||{};
      MC.summary=s;
      document.getElementById("mcTime").textContent="更新时间 "+new Date().toLocaleTimeString();
      document.getElementById("mcStats").innerHTML=[
        ["当前线上版本",s.active_version||"基础模型"],["已采集样本",s.total_samples||0],
        ["已审核样本",s.reviewed_samples||0],["可训练反馈",s.trainable_samples||0],
        ["待确认样本",s.pending_samples||0],["已标注故障类型",s.labeled_types||0],
        ["已生成失效事件",s.linked_events||0],["待审批模型",s.pending_approvals||0]
      ].map(x=>`<div class="mc-stat"><b>${App.esc(x[1])}</b><span>${App.esc(x[0])}</span></div>`).join("");
      MC.samples=(r.data.samples)||[];
      App.pagerState("samples").draw=MC.renderSamples;
      MC.renderSamples();
      const history=[...(s.history||[])];
      if(s.active_version!=="V1.0-基础模型") history.push({version:"V1.0-基础模型",status:"published",dataset_size:"—",feedback_count:"—",metrics:{},message:"系统初始基础模型（可作为回退版本）"});
      document.getElementById("mcHistory").innerHTML=history.map(h=>{
        const m=h.metrics||{}, active=h.version===s.active_version;
        const statusText={published:"已发布",pending_approval:"待管理员审批",candidate_rejected:"评估未通过"}[h.status]||h.status;
        const statusClass=MC.pillClass(h.status);
        let action="";
        if(h.status==="pending_approval") action=`<button class="btn small" onclick="ModelCenter.publish('${App.esc(h.version)}')">审批并发布</button>`;
        else if(h.status==="published"&&!active) action=`<button class="btn ghost small" onclick="ModelCenter.rollback('${App.esc(h.version)}')">回滚到此版本</button>`;
        return `<div class="sample"><div class="sample-hd"><b>${App.esc(h.version)}</b><span class="pill ${statusClass}">${statusText}${active?" · 当前线上":""}</span></div><div class="sample-values">`+
          MC.spans([["数据量",h.dataset_size||0],["反馈",h.feedback_count||0],
            ["Recall",m.recall==null?"—":(m.recall*100).toFixed(1)+"%"],["Precision",m.precision==null?"—":(m.precision*100).toFixed(1)+"%"],
            ["F1",m.f1==null?"—":m.f1.toFixed(3)],["AUC",m.roc_auc==null?"—":m.roc_auc.toFixed(3)]])+
          `</div><div class="hint">${App.esc(h.created_at||"")} · ${App.esc(h.message||"")}${h.approved_by?" · 审批人："+App.esc(h.approved_by):""}${h.approved_at?" · 审批时间："+App.esc(h.approved_at):""}</div>${action?`<div class="btn-row" style="margin-top:10px">${action}</div>`:""}</div>`;
      }).join("")||'<div class="empty">暂无训练记录。</div>';
      MC.health=r.health||null;
      const hc=document.getElementById("mcHealth");
      if(hc) hc.innerHTML=MC.healthHTML(MC.health);
    }catch(e){
      /* M-c 定的顺序：先清分页条、再写错误文案，两处都加守卫。原来 mcSamples 的
         getElementById(...).textContent= 没守卫，容器缺失时（Task 4 搬家途中）这条
         异常会从 catch 里再抛出去——而 events.js 有三处 await MC.refresh() 落在自己的
         try 里，会被它 :258 的 catch 误报成「没写进去：…」，看着像事件没存上。 */
      const pe=document.getElementById("mcSamplesPager"); if(pe) pe.innerHTML="";
      const sBox=document.getElementById("mcSamples"); if(sBox) sBox.textContent="加载失败："+e.message;}
  },
  /* ---------------- 分类 / 剩余寿命模型：风险概览那两列的来源 ---------------- */
  covText(m){
    if(m.coverage==null) return "—";
    const now=(m.coverage*100).toFixed(1)+"%";
    return m.coverage_before_calibration==null?now
      :`${now}（三个头自己贴出来只有 ${(m.coverage_before_calibration*100).toFixed(1)}%，已按校准段撑开）`;
  },
  healthHTML(h){
    if(!h) return '<div class="empty">没有拿到模型就绪状态，请点「刷新数据」。</div>';
    const c=h.counts||{};
    const opt=(h.optional_features||[]).map(o=>`${o.label} 填充率 ${(o.coverage*100).toFixed(0)}%`).join("　");
    const miss=(h.optional_missing||[]).length?`<div class="hint">这几列台账/遥测里还没有：${App.esc((h.optional_missing||[]).join("、"))}，有就更好、没有也不拦。</div>`:"";
    return Object.entries(MC.KIND_COL).map(([kind,col])=>{
      const box=h[kind]||{}, r=box.readiness||{}, live=(h.live||{})[kind]||"";
      const hist=box.history||[];
      const gaps=(r.gaps||[]).map(g=>`<li>${App.esc(g)}</li>`).join("");
      const rows=hist.map(x=>{
        const m=x.metrics||{}, on=x.version===live;
        const txt={candidate:"待审批",published:"线上版本",retired:"已下线",candidate_rejected:"评估未通过",dry_run:"干跑未落盘"}[x.status]||x.status;
        const cls=MC.pillClass(x.status);
        let act="";
        if(x.status==="candidate") act=`<button class="btn small" onclick="ModelCenter.hPublish('${kind}','${App.esc(x.version)}')">批准上线</button>`;
        else if(x.status==="retired") act=`<button class="btn ghost small" onclick="ModelCenter.hRollback('${kind}','${App.esc(x.version)}')">回滚到此版本</button>`;
        return `<div class="sample-values"><span>${App.esc(x.version)}</span><span class="pill ${cls}">${txt}${on?" · 当前线上":""}</span><span>样本 ${x.dataset_size||0}</span>`+
          (kind==="fault_type"?`<span>宏 F1：${m.macro_f1==null?"—":m.macro_f1.toFixed(3)}</span><span>故障召回：${m.fault_recall==null?"—":(m.fault_recall*100).toFixed(1)+"%"}</span><span>留出设备：${App.esc(m.held_out_device||"—")}</span>`
                              :`<span>MAE：${m.mae_hours==null?"—":Math.round(m.mae_hours)+" h"}</span><span>区间覆盖：${MC.covText(m)}</span><span>区间宽：${m.median_width_hours==null?"—":Math.round(m.median_width_hours)+" h"}</span>`)+
          `<span>${App.esc(x.created_at||"")}</span>${act}</div>${x.message?`<div class="hint">${App.esc(x.message)}</div>`:""}`;
      }).join("");
      return `<article class="sample"><div class="sample-hd"><b>${col}模型</b><span class="pill ${live?"good":""}">${live?"线上 "+App.esc(live):"未上线"}</span></div>
<div class="hint">这一列就是首页和设备台账里的「${col}」，不会拿别的数字凑。</div>
<div class="sample-values"><span>已确认失效事件：${c.confirmed_events||0}</span><span>待确认事件：${c.pending_events||0}</span><span>生命周期记录：${c.lifecycle_events||0}</span><span>可用遥测：${c.telemetry_rows||0}</span></div>
${r.can_train?'<div class="hint good">数据够了，可以训一轮。</div>'
             :`<div class="hint">还差：<ul style="margin:4px 0 0 18px">${gaps}</ul></div>`}
${rows?'<div class="sub-title" style="margin-top:10px">训练与审批记录</div>'+rows:'<div class="hint">还没训过这一类模型。</div>'}
<div class="btn-row" style="margin-top:10px"><button class="btn" id="hcTrain${kind}" onclick="ModelCenter.hTrain('${kind}')">训练${col}模型</button></div>
<div id="hcResult${kind}"></div></article>`;
    }).join("")+miss+(opt?`<div class="hint">可选传感器：${App.esc(opt)}</div>`:"");
  },
  hTrainResult(kind,r){
    if(!r.ok||!r.trained){
      const why=(r.reasons||r.gaps||(r.readiness&&r.readiness.gaps)||[]).join("；")||r.gate&&r.gate.reason||"本轮没有通过";
      return `<div class="warn">没训出候选模型：${App.esc(why)}</div>`;
    }
    const m=r.metrics||{};
    const shown=kind==="fault_type"
      ? [["宏 F1",m.macro_f1==null?"—":m.macro_f1.toFixed(3)],["准确率",m.accuracy==null?"—":(m.accuracy*100).toFixed(1)+"%"],
         ["故障召回",m.fault_recall==null?"—":(m.fault_recall*100).toFixed(1)+"%"],["留出设备",m.held_out_device||"—"]]
      : [["MAE",m.mae_hours==null?"—":Math.round(m.mae_hours)+" h"],["区间覆盖",MC.covText(m)],
         ["区间宽",m.median_width_hours==null?"—":Math.round(m.median_width_hours)+" h"],["删失样本",m.censored_samples==null?"—":m.censored_samples]];
    return `<div class="hint good">${App.esc(r.version)} 已训完，状态：${App.esc(r.status==="candidate"?"待审批":(r.status||"待审批"))}。`+
      shown.map(x=>`${x[0]}=${App.esc(String(x[1]))}`).join("　")+
      `　点上方「批准上线」才会换掉线上版本。</div>`;
  },
  hTrain(kind){
    return MC.runTrain({btnId:"hcTrain"+kind, boxId:"hcResult"+kind, url:"/api/health-model-train",
      body:{kind}, busy:"正在构建数据集、训练并评估…", label:"训练"+MC.KIND_COL[kind]+"模型",
      confirm:"将按当前已确认失效事件与遥测训练"+MC.kindLabel(kind)+"模型。评估通过后只生成待审批版本，"+MC.intervalText()+"是否继续？",
      render:r=>MC.hTrainResult(kind,r)});
  },
  hPublish(kind,version){
    return MC.act({url:"/api/health-model-publish", body:{kind,version,approver:"管理员"},
      confirm:"确认以管理员身份把"+MC.kindLabel(kind)+"模型 "+version+" 批准上线？上线后首页与设备台账的那一列立即改用这一版。",
      fallback:"已上线", failText:"上线失败："});
  },
  hRollback(kind,version){
    return MC.act({url:"/api/health-model-rollback", body:{kind,version,approver:"管理员"},
      confirm:"确认把"+MC.kindLabel(kind)+"模型回滚到 "+version+"？",
      fallback:"已回滚", failText:"回滚失败："});
  },
  renderSamples(){
    const box=document.getElementById("mcSamples"); if(!box) return;
    const pg=App.paginate(MC.samples||[], "samples");
    box.innerHTML=pg.rows.map(MC.sampleHTML).join("")||
      '<div class="empty">当前筛选下没有样本。首页或设备页面加载到最新遥测后，系统会自动保存可反馈样本。</div>';
    const p=document.getElementById("mcSamplesPager");
    if(p) p.innerHTML=pg.pages>1?App.pagerHTML("samples",pg.page,pg.pages,(MC.samples||[]).length,pg.size):"";
  },
  sampleHTML(x){
    const f=x.features||{};const label=x.feedback_kind==="normal"?"正常":x.feedback_kind==="fault"?"确认故障":x.feedback_kind==="anomaly"?"确认异常":"待确认";
    return `<article class="sample"><div class="sample-hd"><b>${App.esc(x.code)} · ${App.esc(x.sim_time)}</b><span class="pill">${App.esc(label)}</span></div><div class="hint">样本 #${x.id}　预测故障概率：${x.predicted_probability==null?"—":(x.predicted_probability*100).toFixed(1)+"%"}　模型：${App.esc(x.model_version||"—")}</div><div class="sample-values"><span>环境温度：${f.env_temp??"—"} ℃</span><span>设备温度：${f.dev_temp??"—"} ℃</span><span>电流：${f.current??"—"} A</span><span>运行时长：${f.run_hours??"—"} h</span><span>距检修：${f.since_repair_hours??"—"} h</span></div><label>工作人员判断</label><select id="mcKind${x.id}" onchange="MC.toggle(${x.id})"><option value="normal" ${x.feedback_kind==="normal"?"selected":""}>正常运行 / 误报（训练标签 0）</option><option value="fault" ${x.feedback_kind==="fault"?"selected":""}>确认设备故障（训练标签 1）</option><option value="anomaly" ${x.feedback_kind==="anomaly"?"selected":""}>确认异常但未确认故障（暂不训练）</option><option value="uncertain" ${x.feedback_kind==="uncertain"?"selected":""}>暂不确定</option></select>${MC.labelHTML(x)}<div class="row2"><div><label>确认人员</label><input id="mcReviewer${x.id}" maxlength="80" value="${App.esc(x.reviewer||"")}" placeholder="填写工作人员姓名"/></div><div><label>反馈说明</label><input id="mcNote${x.id}" maxlength="1000" value="${App.esc(x.feedback_note||"")}" placeholder="例如：现场检查后确认轴承故障"/></div></div><div class="btn-row"><button class="btn small" onclick="ModelCenter.save(${x.id})">保存反馈</button></div></article>`;
  },
  labelHTML(x){
    const ft=(MC.options&&MC.options.fault_type)||[];
    const on=x.feedback_kind==="fault";
    return `<div class="mc-labels" id="mcLabels${x.id}"${on?"":' style="display:none"'}>
<div class="row2"><div><label>故障类型（供「最可能故障」学习）</label><select id="mcType${x.id}"><option value="">暂未确认具体类型</option>${ft.map(t=>`<option value="${App.esc(t)}"${x.fault_type===t?" selected":""}>${App.esc(t)}</option>`).join("")}</select></div><div><label>这条记录之后实际还能跑（小时）</label><input id="mcHours${x.id}" type="number" min="0" max="4320" step="1" value="${x.actual_rul_hours==null?"":App.esc(x.actual_rul_hours)}" placeholder="留空＝这条快照就是失效时刻"/></div></div>
<div class="hint">填了故障类型才会同步成一条已确认失效事件；「实际还能跑多少小时」是剩余寿命唯一的真值来源，事后凭印象填不如不填。</div></div>`;
  },
  toggle(id){
    const box=document.getElementById("mcLabels"+id);
    if(box) box.style.display=document.getElementById("mcKind"+id).value==="fault"?"":"none";
  },
  async save(id){
    const feedback_kind=document.getElementById("mcKind"+id).value;
    const feedback_note=document.getElementById("mcNote"+id).value;
    const reviewer=document.getElementById("mcReviewer"+id).value;
    const body={id,feedback_kind,feedback_note,reviewer};
    if(feedback_kind==="fault"){
      const t=document.getElementById("mcType"+id)?.value||"";
      const h=document.getElementById("mcHours"+id)?.value||"";
      if(t)body.fault_type=t;
      if(h!=="")body.actual_hours=h;
    }
    try{const r=await App.api("/api/model-feedback",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});alert((r.message||"反馈已保存。")+"\n注意：本次只记录标签，尚未触发模型训练。");
    // 待确认筛选下，刚保存的样本会当场从列表里消失，看着就像「我这条判断没保住」。把它领到「已反馈」那一栏，让人看见自己填的东西。
    const flt=document.getElementById("mcFilter");
    // 筛选值在这里被程序化改掉，复位就跟着这个变更点走（refresh 入口不复位）
    if(r.status==="reviewed"&&flt&&flt.value==="pending"){flt.value="reviewed";App.pagerState("samples").page=1;}
    await MC.refresh();}catch(e){alert(e.message);}
  },
  train(){
    return MC.runTrain({btnId:"mcTrain", boxId:"mcTrainResult", url:"/api/model-train",
      busy:"正在构建数据集、训练并评估候选模型…", label:"使用已审核数据训练新模型",
      confirm:"将使用原始数据和所有已审核反馈重新训练 HGBT。评估通过后生成待审批候选模型，由管理员确认发布。"+MC.intervalText()+"是否继续？",
      render:r=>{
        const m=r.metrics||{};
        return `<div class="sample"><b>${App.esc(r.version)}：${r.passed?"评估通过，等待管理员审批":"评估未通过"}</b><p>${App.esc(r.message)}</p><div class="sample-values">`+
          MC.spans([["数据量",r.dataset_size],["反馈样本",r.feedback_count],
            ["故障召回率",m.recall==null?"—":(m.recall*100).toFixed(1)+"%"],["精确率",m.precision==null?"—":(m.precision*100).toFixed(1)+"%"],
            ["F1",m.f1==null?"—":m.f1.toFixed(3)],["AUC",m.roc_auc==null?"—":m.roc_auc.toFixed(3)]])+
          `</div></div>`;
      }});
  },
  publish(version){
    return MC.act({url:"/api/model-publish", body:{version,approver:"管理员"},
      confirm:`确认以管理员身份批准并发布 ${version}？发布后平台将使用该模型进行预测。`,
      fallback:"发布成功", failText:"发布失败："});
  },
  rollback(version){
    return MC.act({url:"/api/model-rollback", body:{version},
      confirm:`确认将线上模型回滚到 ${version}？`,
      fallback:"回滚成功", failText:"回滚失败："});
  }
};
window.ModelCenter=MC;MC.refresh();
