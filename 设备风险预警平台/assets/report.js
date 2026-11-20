"use strict";
App.boot({cardPage:0,rowPage:0,fullTable:false,env:false});
const Report={
  esc:App.esc,
  async load(){
    const box=document.getElementById("reportItems");
    try{const r=await App.api("/api/daily-report");
      document.getElementById("reportDate").textContent="报告日期："+r.date;
      document.getElementById("reportModel").textContent="模型版本："+(r.model_version||"基础模型");
      const list=(r.items||[]).filter(x=>x.device.risk!==null&&x.device.risk!==undefined);
      Report.rows=list; Report.date=r.date;
      App.pagerState("report").draw=Report.render;
      Report.render();
    }catch(e){
      /* M-c 定的顺序：先清分页条、再写错误文案，两处都加守卫。
         原来这两行是反的，而且 box 取值没守卫——容器缺失（Task 4 把核查分区搬走
         的途中）时会从 catch 里再抛出去，污染调用方（load() 还被跨页刷新与轮询调）。 */
      const pe=document.getElementById("reportPager"); if(pe) pe.innerHTML="";
      if(box) box.textContent="报告加载失败："+e.message;}   // 取数失败就不留上一页的分页条：点它会拿内存里的旧快照盖掉这条错误
  },
  render(){
    const box=document.getElementById("reportItems"); if(!box) return;
    const pg=App.paginate(Report.rows||[], "report");
    box.innerHTML=(pg.rows||[]).map(x=>Report.card(x, Report.date)).join("")||
      '<div class="empty">今日没有可预测的设备。请先检查数据导入和模型状态。</div>';
    const p=document.getElementById("reportPager");
    if(p) p.innerHTML=pg.pages>1?App.pagerHTML("report",pg.page,pg.pages,(Report.rows||[]).length,pg.size):"";
  },
  card(x,date){
    const d=x.device,t=d.telemetry||{},p=x.report||{},logs=x.work_logs||[];
    const risk=d.risk==null?"—":(Number(d.risk)*100).toFixed(1)+"%";
    const label={red:"报警",orange:"预警",yellow:"关注",green:"正常",gray:"无数据"}[d.level?.key]||"待核查";
    const logHTML=logs.length?logs.map(l=>`<div class="log"><b>${Report.esc(l.work_date||"")} ${Report.esc(l.equipment||"")}</b>　${Report.esc(l.content||"")}<br>结果：${Report.esc(l.result||"未填写")}　人员：${Report.esc(l.workers||"未填写")}</div>`).join(""):'<div class="hint">没有匹配到该设备或位置的维修日志。</div>';
    const id=x.sample_id;
    return `<article class="report-card" data-code="${Report.esc(d.code)}"><div class="report-head"><div><h3>${Report.esc(d.code)} · ${Report.esc(d.name)}</h3><div class="report-meta"><span>风险等级：<b>${label}</b></span><span>综合风险：<b>${risk}</b></span><span>采样时间：${Report.esc(t.sim_time||"无")}</span><span>主要问题：${Report.esc(d.main_cause||"结合现场核查")}</span></div></div><span class="pill">${p.status?({fault:"确认故障",no_issue:"已核查无故障",data_corrected:"数据已修正",pending:"待核查"}[p.status]||p.status):"待核查"}</span></div>
    <details><summary>相关维修日志（${logs.length}）</summary>${logHTML}</details>
    <div class="report-form no-print"><div><label>人工核查结论</label><select id="status-${id||d.code}"><option value="pending" ${p.status==="pending"?"selected":""}>待核实</option><option value="fault" ${p.status==="fault"?"selected":""}>确认故障</option><option value="no_issue" ${p.status==="no_issue"?"selected":""}>已检查，未发现故障</option><option value="data_corrected" ${p.status==="data_corrected"?"selected":""}>传感器数据有误，已记录修正</option></select></div>
    <div><label>故障/异常原因</label><textarea id="cause-${id||d.code}" placeholder="现场确认的原因">${Report.esc(p.cause||"")}</textarea></div><div><label>处理办法 / 检查结论</label><textarea id="action-${id||d.code}" placeholder="已处理内容、检查依据或待办事项">${Report.esc(p.action||"")}</textarea></div>
    <div><label>异常值修正记录（不覆盖原始数据）</label><div style="display:flex;gap:6px"><input id="raw-${id||d.code}" placeholder="原值" value="${Report.esc(p.raw_value||"")}"/><input id="corrected-${id||d.code}" placeholder="核实值" value="${Report.esc(p.corrected_value||"")}"/></div><label>核查人员</label><input id="reviewer-${id||d.code}" placeholder="姓名" value="${Report.esc(p.reviewer||"")}"/></div></div>
    <div class="btn-row no-print"><button class="btn small" onclick="Report.save('${Report.esc(d.code)}','${Report.esc(t.sim_time||"")}','${date}',${id||"null"})">保存核查记录</button></div>
    <div class="print-only"><p>人工核查：${Report.esc(p.status||"待核查")}　原因：${Report.esc(p.cause||"未填写")}　处置：${Report.esc(p.action||"未填写")}　核查人：${Report.esc(p.reviewer||"未填写")}</p></div></article>`;
  },
  async save(code,sim_time,date,sample_id){
    const key=sample_id||code, get=id=>document.getElementById(id+"-"+key)?.value||"";
    const body={code,sim_time,report_date:date,sample_id,status:get("status"),cause:get("cause"),action:get("action"),raw_value:get("raw"),corrected_value:get("corrected"),reviewer:get("reviewer")};
    if(!body.reviewer.trim()){alert("请填写核查人员。");return;}
    if(body.status==="fault"&&(!body.cause.trim()||!body.action.trim())){alert("确认故障时，请填写故障原因和处理办法。");return;}
    if(body.status==="no_issue"&&!body.action.trim()){alert("请填写检查结论或无故障依据。");return;}
    if(body.status==="data_corrected"&&(!body.raw_value.trim()||!body.corrected_value.trim())){alert("请填写原始值和核实值；原始遥测不会被覆盖。");return;}
    try{const r=await App.api("/api/daily-report",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});alert(r.message||"已保存");await Report.load();}catch(e){alert("保存失败："+e.message);}
  }
};window.Report=Report;Report.load();
