"use strict";
App.boot({cardPage:0,rowPage:0,fullTable:false,env:false});
const MC={
  async refresh(){
    const status=document.getElementById("mcFilter")?.value||"pending";
    try{
      const r=await App.api("/api/model-center?status="+encodeURIComponent(status));
      const s=r.summary||{}, counts=r.data?.counts||{};
      document.getElementById("mcTime").textContent="更新时间 "+new Date().toLocaleTimeString();
      document.getElementById("mcStats").innerHTML=[
        ["当前线上版本",s.active_version||"基础模型"],["已采集样本",s.total_samples||0],
        ["已审核样本",s.reviewed_samples||0],["可训练反馈",s.trainable_samples||0],
        ["待确认样本",s.pending_samples||0],["待审批模型",s.pending_approvals||0]
      ].map(x=>`<div class="mc-stat"><b>${App.esc(x[1])}</b><span>${App.esc(x[0])}</span></div>`).join("");
      document.getElementById("mcSamples").innerHTML=(r.data.samples||[]).map(MC.sampleHTML).join("")||'<div class="empty">当前筛选下没有样本。首页或设备页面加载到最新遥测后，系统会自动保存可反馈样本。</div>';
      const history=[...(s.history||[])];
      if(s.active_version!=="V1.0-基础模型") history.push({version:"V1.0-基础模型",status:"published",dataset_size:"—",feedback_count:"—",metrics:{},message:"系统初始基础模型（可作为回退版本）"});
      document.getElementById("mcHistory").innerHTML=history.map(h=>{
        const m=h.metrics||{}, active=h.version===s.active_version;
        const statusText={published:"已发布",pending_approval:"待管理员审批",candidate_rejected:"评估未通过"}[h.status]||h.status;
        const statusClass=h.status==="published"?"good":(h.status==="candidate_rejected"?"bad":"");
        let action="";
        if(h.status==="pending_approval") action=`<button class="btn small" onclick="ModelCenter.publish('${App.esc(h.version)}')">审批并发布</button>`;
        else if(h.status==="published"&&!active) action=`<button class="btn ghost small" onclick="ModelCenter.rollback('${App.esc(h.version)}')">回滚到此版本</button>`;
        return `<div class="sample"><div class="sample-hd"><b>${App.esc(h.version)}</b><span class="pill ${statusClass}">${statusText}${active?" · 当前线上":""}</span></div><div class="sample-values"><span>数据量：${h.dataset_size||0}</span><span>反馈：${h.feedback_count||0}</span><span>Recall：${m.recall==null?"—":(m.recall*100).toFixed(1)+"%"}</span><span>Precision：${m.precision==null?"—":(m.precision*100).toFixed(1)+"%"}</span><span>F1：${m.f1==null?"—":m.f1.toFixed(3)}</span><span>AUC：${m.roc_auc==null?"—":m.roc_auc.toFixed(3)}</span></div><div class="hint">${App.esc(h.created_at||"")} · ${App.esc(h.message||"")}${h.approved_by?" · 审批人："+App.esc(h.approved_by):""}${h.approved_at?" · 审批时间："+App.esc(h.approved_at):""}</div>${action?`<div class="btn-row" style="margin-top:10px">${action}</div>`:""}</div>`;
      }).join("")||'<div class="empty">暂无训练记录。</div>';
    }catch(e){document.getElementById("mcSamples").textContent="加载失败："+e.message;}
  },
  sampleHTML(x){
    const f=x.features||{};const label=x.feedback_kind==="normal"?"正常":x.feedback_kind==="fault"?"确认故障":x.feedback_kind==="anomaly"?"确认异常":"待确认";
    return `<article class="sample"><div class="sample-hd"><b>${App.esc(x.code)} · ${App.esc(x.sim_time)}</b><span class="pill">${App.esc(label)}</span></div><div class="hint">样本 #${x.id}　预测故障概率：${x.predicted_probability==null?"—":(x.predicted_probability*100).toFixed(1)+"%"}　模型：${App.esc(x.model_version||"—")}</div><div class="sample-values"><span>环境温度：${f.env_temp??"—"} ℃</span><span>设备温度：${f.dev_temp??"—"} ℃</span><span>电流：${f.current??"—"} A</span><span>运行时长：${f.run_hours??"—"} h</span><span>距检修：${f.since_repair_hours??"—"} h</span></div><label>工作人员判断</label><select id="mcKind${x.id}"><option value="normal" ${x.feedback_kind==="normal"?"selected":""}>正常运行 / 误报（训练标签 0）</option><option value="fault" ${x.feedback_kind==="fault"?"selected":""}>确认设备故障（训练标签 1）</option><option value="anomaly" ${x.feedback_kind==="anomaly"?"selected":""}>确认异常但未确认故障（暂不训练）</option><option value="uncertain" ${x.feedback_kind==="uncertain"?"selected":""}>暂不确定</option></select><div class="row2"><div><label>确认人员</label><input id="mcReviewer${x.id}" maxlength="80" value="${App.esc(x.reviewer||"")}" placeholder="填写工作人员姓名"/></div><div><label>反馈说明</label><input id="mcNote${x.id}" maxlength="1000" value="${App.esc(x.feedback_note||"")}" placeholder="例如：现场检查后确认轴承故障"/></div></div><div class="btn-row"><button class="btn small" onclick="ModelCenter.save(${x.id})">保存反馈</button></div></article>`;
  },
  async save(id){
    const feedback_kind=document.getElementById("mcKind"+id).value;
    const feedback_note=document.getElementById("mcNote"+id).value;
    const reviewer=document.getElementById("mcReviewer"+id).value;
    try{await App.api("/api/model-feedback",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,feedback_kind,feedback_note,reviewer})});alert("反馈已保存；符合训练条件的样本已进入训练数据池。注意：尚未触发模型训练。");await MC.refresh();}catch(e){alert(e.message);}
  },
  async train(){
    if(!confirm("将使用原始数据和所有已审核反馈重新训练 HGBT。评估通过后生成待审批候选模型，由管理员确认发布。两次训练至少间隔 60 秒。是否继续？"))return;
    const btn=document.getElementById("mcTrain");btn.disabled=true;btn.textContent="训练中，请稍候…";
    document.getElementById("mcTrainResult").textContent="正在构建数据集、训练并评估候选模型…";
    try{const r=await App.api("/api/model-train",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});const m=r.metrics||{};document.getElementById("mcTrainResult").innerHTML=`<div class="sample"><b>${App.esc(r.version)}：${r.passed?"评估通过，等待管理员审批":"评估未通过"}</b><p>${App.esc(r.message)}</p><div class="sample-values"><span>数据量：${r.dataset_size}</span><span>反馈样本：${r.feedback_count}</span><span>故障召回率：${m.recall==null?"—":(m.recall*100).toFixed(1)+"%"}</span><span>精确率：${m.precision==null?"—":(m.precision*100).toFixed(1)+"%"}</span><span>F1：${m.f1==null?"—":m.f1.toFixed(3)}</span><span>AUC：${m.roc_auc==null?"—":m.roc_auc.toFixed(3)}</span></div></div>`;await MC.refresh();}catch(e){document.getElementById("mcTrainResult").textContent="训练失败："+e.message;}finally{btn.disabled=false;btn.textContent="使用已审核数据训练新模型";}
  },
  async publish(version){
    if(!confirm(`确认以管理员身份批准并发布 ${version}？发布后平台将使用该模型进行预测。`))return;
    try{const r=await App.api("/api/model-publish",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({version,approver:"管理员"})});alert(r.message||"发布成功");await MC.refresh();}catch(e){alert("发布失败："+e.message);}
  },
  async rollback(version){
    if(!confirm(`确认将线上模型回滚到 ${version}？`))return;
    try{const r=await App.api("/api/model-rollback",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({version})});alert(r.message||"回滚成功");await MC.refresh();}catch(e){alert("回滚失败："+e.message);}
  }
};
window.ModelCenter=MC;MC.refresh();
