import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {startChrome,CDP,openPage} from './cdp.mjs';
const port=Number(process.env.PORT||readFileSync('/tmp/pex/PORT','utf8'));
const base=`http://127.0.0.1:${port}`;
const chrome=await startChrome(), cdp=new CDP();await cdp.connect(chrome.wsUrl);
const p=await openPage(cdp,port,1440,1000);
let fails=0; const check=(n,ok,d='')=>{console.log(`${ok?'PASS':'FAIL'} ${n} ${d}`);if(!ok)fails++;};
await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__bootIntervals=0;const old=setInterval;window.setInterval=function(f,n,...args){if(n===15000)window.__bootIntervals++;return old(f,n,...args);};`},p.sessionId);
const routes=['/','/#tab=analysis','/report#tab=verify','/report#tab=samples','/devices#tab=info','/devices#tab=worklog','/devices#tab=env','/model-center#tab=train','/model-center#tab=data','/model-center#tab=health','/model-center#tab=history'];
const out='/tmp/pex/ui-screens';mkdirSync(out,{recursive:true});
for(const width of [1440,390]){
 await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===390},p.sessionId);
 for(const [i,r] of routes.entries()){
  await p.goto('about:blank');await p.goto(base+r);await p.settle(1600);
  const info=await p.eval(`({intervals:window.__bootIntervals,tabs:document.querySelectorAll('.tab-panel:not([hidden])').length,overflow:document.documentElement.scrollWidth>innerWidth,dup:[...document.querySelectorAll('[id]')].map(e=>e.id).filter((x,i,a)=>a.indexOf(x)!==i)})`);
  check(`${width} ${r} 一次启动/单面板/唯一ID/无横溢出`,info.intervals===1&&info.tabs===1&&!info.overflow&&!info.dup.length,JSON.stringify(info));
  if(width===390) check(`${r} 手机页头无重叠`,await p.eval(`(()=>{const t=document.querySelector('.hero-title').getBoundingClientRect(),b=document.querySelector('.hero-badges').getBoundingClientRect(),c=document.querySelector('.corp').getBoundingClientRect();return c.bottom<=t.top&&t.bottom<=b.top;})()`));
  if(r==='/model-center#tab=data') check(`${width} 事件设备选择随台账到达`,await p.eval(`document.querySelectorAll('#ev_code option').length===App.state().devices.length&&document.querySelectorAll('#evFilterCode option').length===App.state().devices.length+1&&document.getElementById('evCounts').textContent.includes('/ 4 台设备')`));
  const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},p.sessionId);writeFileSync(`${out}/${width}-${i}.png`,Buffer.from(shot.data,'base64'));
 }
}
await p.goto(base+'/model-center#tab=data');await p.settle(1500);
check('设备选项同步保留未保存字段与当前选择',await p.eval(`(()=>{document.getElementById('ev_action').value='待保存的处置';document.getElementById('ev_code').value='PU-001';document.getElementById('evFilterCode').value='PU-001';delete document.getElementById('ev_code').dataset.codes;delete document.getElementById('evFilterCode').dataset.codes;EV.syncDevices();return document.getElementById('ev_action').value==='待保存的处置'&&document.getElementById('ev_code').value==='PU-001'&&document.getElementById('evFilterCode').value==='PU-001';})()`));
await p.goto(base+'/report#tab=samples');await p.settle(1500);
await cdp.send('Emulation.setEmulatedMedia',{media:'print'},p.sessionId);
check('样本页签打印仍只显示核查面板',await p.eval(`getComputedStyle(document.getElementById('tab-verify')).display!=='none'&&getComputedStyle(document.getElementById('tab-samples')).display==='none'`));
await cdp.send('Emulation.setEmulatedMedia',{media:''},p.sessionId);
await p.goto(base+'/');await p.settle(1200);await p.eval(`QA.open();document.querySelector('[data-tab="analysis"]').click()`);
check('已打开助手随页签刷新上下文',await p.eval(`document.getElementById('qaCtx').textContent.includes('归因与治理')`));
await p.eval(`location.hash=''`);await p.settle(200);
check('清空 hash 回到第一个面板',await p.eval(`!document.getElementById('tab-board').hidden`));
check('无未捕获 JS 异常',!p.logs.some(l=>l.startsWith('[EXCEPTION]')),p.logs.filter(l=>l.startsWith('[EXCEPTION]')).join(' | '));
await p.close();cdp.close();chrome.reap();process.exit(fails?1:0);
