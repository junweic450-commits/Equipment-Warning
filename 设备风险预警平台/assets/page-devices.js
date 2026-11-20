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
// 维护历史这一份列表的行：分页只在这已经取回来的数组里切页，不再另发一次 /api
const WR = {rows: []};
// 与服务端 equipment_db.WORK_FIELDS 同一套上限：界面先挡住，省得填完提交才报错
const WORK_LIMIT = {work_date:40, location:100, equipment:200, content:5000, result:500, workers:300};
function workDraftHTML(r, i){
  const field = (label, key, value, type) => `<label>${label}</label><input maxlength="${WORK_LIMIT[key]||200}" ${type || ""} data-work-index="${i}" data-work-key="${key}" value="${App.esc(value || "")}" />`;
  return `<article class="work-draft">
    <div class="work-draft-hd"><b>待确认维护记录 ${i + 1}</b><label class="work-check"><input type="checkbox" data-work-include="${i}" checked /> 纳入维护历史</label></div>
    <div class="row2"><div>${field("工作日期", "work_date", r.work_date, 'type="date"')}</div><div>${field("工作地点", "location", r.location)}</div></div>
    <div class="row2"><div>${field("涉及设备", "equipment", r.equipment)}</div><div>${field("作业人员", "workers", r.workers)}</div></div>
    ${field("处理结果", "result", r.result)}
    <label>工作内容</label><textarea rows="3" maxlength="${WORK_LIMIT.content}" data-work-index="${i}" data-work-key="content">${App.esc(r.content)}</textarea>
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
    /* 只有真新增了行才回第 1 页：维护历史按 work_date 倒序排列，
       新入账的记录在第 1 页，人停在第 3 页就看不到自己刚确认的那批。全是重复上传
       （added=0）时行集没变，页码不动。 */
    if (Number(res.added) > 0) App.pagerState("worklog").page = 1;
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
      <div class="row2"><div><label>工作日期</label><input type="date" maxlength="${WORK_LIMIT.work_date}" data-edit-key="work_date" value="${App.esc(r.work_date||"")}" /></div><div><label>工作地点</label><input maxlength="${WORK_LIMIT.location}" data-edit-key="location" value="${App.esc(r.location||"")}" /></div></div>
      <div class="row2"><div><label>涉及设备</label><input maxlength="${WORK_LIMIT.equipment}" data-edit-key="equipment" value="${App.esc(r.equipment||"")}" /></div><div><label>作业人员</label><input maxlength="${WORK_LIMIT.workers}" data-edit-key="workers" value="${App.esc(r.workers||"")}" /></div></div>
      <label>处理结果</label><input maxlength="${WORK_LIMIT.result}" data-edit-key="result" value="${App.esc(r.result||"")}" />
      <label>工作内容</label><textarea rows="4" maxlength="${WORK_LIMIT.content}" data-edit-key="content">${App.esc(r.content||"")}</textarea>
      <div class="btn-row"><button class="btn small" type="button" onclick="saveWorkRecord(${r.id})">保存修改</button><button class="btn ghost small" type="button" onclick="editWorkRecord(${r.id},false)">取消</button></div>
    </div>
  </article>`;
}
async function loadWorkRecords(params={}){
  if(!byId("workRecordList"))return;
  try{
    const qs=new URLSearchParams(params).toString();
    const res=await App.api("/api/work-records"+(qs?`?${qs}`:""));
    WR.rows=res.records||[];
    App.pagerState("worklog").draw=renderWorkRows;
    renderWorkRows();
  }catch(e){
    // 失败时清掉旧分页，避免用内存快照覆盖错误状态。
    const p=byId("workRecordPager"); if(p) p.innerHTML="";   // 取数失败就不留上一页的分页条：点它会拿内存里的旧快照盖掉这条错误
    const box=byId("workRecordList"); if(box) box.textContent="维护记录加载失败："+e.message;}
}
function renderWorkRows(){
  const box=byId("workRecordList"); if(!box)return;
  const pg=App.paginate(WR.rows,"worklog");
  box.innerHTML=pg.rows.map(workRecordHTML).join("")||`<div class="empty">没有找到维护记录。</div>`;
  const p=byId("workRecordPager");
  if(p)p.innerHTML=pg.pages>1?App.pagerHTML("worklog",pg.page,pg.pages,WR.rows.length,pg.size):"";
  const c=byId("workRecordCount"); if(c)c.textContent=`维护历史 ${WR.rows.length} 条`;
}
function searchWorkRecords(){
  App.pagerState("worklog").page=1;   // 条件变了还停在第 3 页，看着就像搜丢了
  loadWorkRecords({keyword:byId("workKeyword").value.trim(),field:byId("workField").value,value:byId("workFieldValue").value.trim()});
}
function resetWorkSearch(){
  byId("workKeyword").value="";byId("workField").value="";byId("workFieldValue").value="";
  App.pagerState("worklog").page=1;
  loadWorkRecords();
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
