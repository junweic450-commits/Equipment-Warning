/* ==========================================================================
   page-devices.js · 设备台账页
   全站唯一的数据维护入口：完整列台账（可搜索、可按分级筛、每页 24 行可翻页）
   + 巷道基准温度。env:true 加载巷道环境配置；fullTable:true 给出额定功率 /
   投运日期 / 厂家 / 删除这些维护列。
   ========================================================================== */
"use strict";

App.boot({
  cardPage: 0,
  rowPage: 24,
  fullTable: true,
  env: true,
});
bindWorkLog();

/* ---------------------------------------------------------------- 设备维护信息：工作日志解析、待确认、维护历史检索/编辑/删除 */
let WORK_DRAFTS = [];
function workDraftHTML(r, i){
  const field = (label, key, value, type) => `<label>${label}</label><input ${type || ""} data-work-index="${i}" data-work-key="${key}" value="${App.esc(value || "")}" />`;
  return `<article class="work-draft">
    <div class="work-draft-hd"><b>待确认维护记录 ${i + 1}</b><label class="work-check"><input type="checkbox" data-work-include="${i}" checked /> 纳入维护历史</label></div>
    <div class="row2"><div>${field("工作日期", "work_date", r.work_date, 'type="date"')}</div><div>${field("工作地点", "location", r.location)}</div></div>
    <div class="row2"><div>${field("涉及设备", "equipment", r.equipment)}</div><div>${field("作业人员", "workers", r.workers)}</div></div>
    ${field("处理结果", "result", r.result)}
    <label>工作内容</label><textarea rows="3" data-work-index="${i}" data-work-key="content">${App.esc(r.content)}</textarea>
  </article>`;
}
async function parseWorkLog(){
  const text = byId("workLogText").value.trim();
  if (!text){ alert("请先粘贴工作日志，或选择 TXT 文件"); return; }
  try{
    const res = await App.api("/api/work-log/parse", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({text, work_date:byId("workLogDate").value})});
    WORK_DRAFTS = res.records || [];
    byId("workPreview").innerHTML = `<div class="tip">识别到 ${WORK_DRAFTS.length} 条维护记录。请核对并修改解析字段；确认后才会写入设备维护历史。</div>` + WORK_DRAFTS.map(workDraftHTML).join("") + `<div class="btn-row"><button class="btn" onclick="confirmWorkRecords()">确认所选维护记录</button><button class="btn ghost" onclick="clearWorkPreview()">清空预览</button></div>`;
  }catch(e){ alert(e.message); }
}
function clearWorkPreview(){ WORK_DRAFTS=[]; if(byId("workPreview")) byId("workPreview").innerHTML=""; }
async function confirmWorkRecords(){
  byId("workPreview").querySelectorAll("[data-work-index][data-work-key]").forEach(el=>{
    const i=Number(el.dataset.workIndex), key=el.dataset.workKey;
    if(WORK_DRAFTS[i]) WORK_DRAFTS[i][key]=el.value;
  });
  const records=WORK_DRAFTS.filter((r,i)=>byId("workPreview").querySelector(`[data-work-include="${i}"]`)?.checked);
  if(!records.length){alert("请至少勾选一条记录");return;}
  if(!confirm(`确认将 ${records.length} 条维护记录写入设备维护信息？重复记录只刷新上传时间，不重复新增。`))return;
  try{
    const res=await App.api("/api/work-records/confirm",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({records})});
    alert(`处理完成：新增 ${res.added} 条，重复记录刷新上传时间 ${res.refreshed} 条。`);
    clearWorkPreview(); byId("workLogText").value=""; await loadWorkRecords();
  }catch(e){alert(e.message);}
}
function workRecordHTML(r){
  return `<article class="work-saved" data-record-id="${r.id}">
    <div class="work-saved-hd"><b>${App.esc(r.work_date||"日期未填写")} · ${App.esc(r.location||"地点未识别")}</b><span>#${r.id}</span></div>
    <div class="hint">设备：${App.esc(r.equipment||"未识别")}　人员：${App.esc(r.workers||"未识别")}</div>
    <p>${App.esc(r.content)}</p>${r.result?`<div class="work-result">处理结果：${App.esc(r.result)}</div>`:""}
    <div class="work-meta">首次入账：${App.esc(r.created_at||"—")}　最后上传：${App.esc(r.upload_at||r.created_at||"—")}${Number(r.duplicate_count)>0?`　重复上传 ${r.duplicate_count} 次`:""}</div>
    <div class="btn-row"><button class="btn ghost small" type="button" onclick="editWorkRecord(${r.id})">编辑</button><button class="btn danger small" type="button" onclick="deleteWorkRecord(${r.id})">删除</button></div>
    <div class="work-edit" id="workEdit${r.id}" hidden>
      <div class="row2"><div><label>工作日期</label><input type="date" data-edit-key="work_date" value="${App.esc(r.work_date||"")}" /></div><div><label>工作地点</label><input data-edit-key="location" value="${App.esc(r.location||"")}" /></div></div>
      <div class="row2"><div><label>涉及设备</label><input data-edit-key="equipment" value="${App.esc(r.equipment||"")}" /></div><div><label>作业人员</label><input data-edit-key="workers" value="${App.esc(r.workers||"")}" /></div></div>
      <label>处理结果</label><input data-edit-key="result" value="${App.esc(r.result||"")}" />
      <label>工作内容</label><textarea rows="4" data-edit-key="content">${App.esc(r.content||"")}</textarea>
      <div class="btn-row"><button class="btn small" type="button" onclick="saveWorkRecord(${r.id})">保存修改</button><button class="btn ghost small" type="button" onclick="editWorkRecord(${r.id},false)">取消</button></div>
    </div>
  </article>`;
}
async function loadWorkRecords(params={}){
  if(!byId("workRecordList"))return;
  try{
    const qs=new URLSearchParams(params).toString();
    const res=await App.api("/api/work-records"+(qs?`?${qs}`:""));
    const rows=res.records||[];
    byId("workRecordCount").textContent=`维护历史 ${rows.length} 条`;
    byId("workRecordList").innerHTML=rows.map(workRecordHTML).join("")||`<div class="empty">没有找到维护记录。</div>`;
  }catch(e){byId("workRecordList").textContent="维护记录加载失败："+e.message;}
}
function searchWorkRecords(){
  loadWorkRecords({keyword:byId("workKeyword").value.trim(),field:byId("workField").value,value:byId("workFieldValue").value.trim()});
}
function resetWorkSearch(){
  byId("workKeyword").value="";byId("workField").value="";byId("workFieldValue").value="";loadWorkRecords();
}
function editWorkRecord(id,show=true){const el=byId("workEdit"+id);if(el)el.hidden=!show;}
async function saveWorkRecord(id){
  const box=byId("workEdit"+id), payload={id};
  box.querySelectorAll("[data-edit-key]").forEach(el=>payload[el.dataset.editKey]=el.value);
  try{await App.api("/api/work-records/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});alert("维护记录已更新");await loadWorkRecords();}
  catch(e){alert(e.message);}
}
async function deleteWorkRecord(id){
  if(!confirm(`确定删除维护记录 #${id}？删除后不可恢复。`))return;
  try{await App.api("/api/work-records/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});await loadWorkRecords();}
  catch(e){alert(e.message);}
}
function bindWorkLog(){
  const file=byId("workLogFile");
  if(file)file.addEventListener("change",async()=>{const f=file.files&&file.files[0];if(!f)return;if(!/\.txt$/i.test(f.name)){alert("当前支持 TXT 文本文件；Word 文件可复制正文后粘贴。");file.value="";return;}byId("workLogText").value=await f.text();});
  loadWorkRecords();
}
window.parseWorkLog=parseWorkLog;window.confirmWorkRecords=confirmWorkRecords;window.clearWorkPreview=clearWorkPreview;
window.searchWorkRecords=searchWorkRecords;window.resetWorkSearch=resetWorkSearch;window.editWorkRecord=editWorkRecord;
window.saveWorkRecord=saveWorkRecord;window.deleteWorkRecord=deleteWorkRecord;
