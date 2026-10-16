import { spawn } from 'node:child_process';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { app } from './fixture.mjs';
if(!app.listening)await once(app,'listening');
const output=resolve('test-results');mkdirSync(output,{recursive:true});
const chrome=spawn(process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--remote-debugging-port=0',`--user-data-dir=${resolve('test-results/chrome-profile')}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let stderr='';
const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Chrome did not start: '+stderr)),20000);chrome.stderr.on('data',d=>{stderr+=d;const m=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});chrome.on('error',reject);chrome.on('exit',code=>reject(new Error('Chrome exited '+code+' '+stderr)));});
const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let seq=0,session;const pending=new Map(),exceptions=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);};
const send=(method,params={},sid=session)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Browser command timed out: ${method}`));},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const waitFor=async expression=>{for(let n=0;n<100;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timeout: '+expression);};
const click=async expression=>{await evaluate(`${expression}.click()`);};
const results=[];const check=(label,condition)=>{if(!condition)throw new Error('FAIL '+label);results.push('PASS '+label);console.log(results.at(-1));};
try{
  const target=await send('Target.createTarget',{url:'about:blank'},null);session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:'http://localhost:3000/#/Overview'});await waitFor("document.querySelector('.metrics') && document.querySelectorAll('.metric').length===4");
  check('dashboard renders persisted statistics',await evaluate("document.querySelector('.metrics').innerText.includes('Approved headcount')"));
  const snap=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(resolve(output,name+'.png'),Buffer.from(r.data,'base64'));};
  await snap('desktop-overview');
  check('official Mechlin logo loads locally',await evaluate("document.querySelector('.company-logo img').complete && document.querySelector('.company-logo img').naturalWidth>0"));
  check('Orbit product branding appears in the workspace',await evaluate("document.querySelector('.product-brand').innerText.includes('Orbit')"));
  for(const view of ['Requisitions','Candidates','Pipeline','Interviews','Referrals','Administration','Settings','Audit log','Pipeline settings','Integrations']){
    await click(`document.querySelector('[data-nav="${view}"]')`);await waitFor(`document.querySelector('#main h1')?.textContent===${JSON.stringify(view)}`);
    check(view+' renders without load error',!(await evaluate("document.querySelector('#main').innerText.includes('Could not load')")));
    if(['Pipeline','Administration','Candidates','Settings'].includes(view))await snap('desktop-'+view.toLowerCase());
  }
  await click(`document.querySelector('[data-nav="Settings"]')`);await waitFor("document.querySelector('#appearance-form')!==null");
  check('admin sees three labeled theme controls',await evaluate("document.querySelectorAll('#appearance-form input[type=radio]').length===3 && [...document.querySelectorAll('#appearance-form input')].every(i=>i.closest('label'))"));
  await click(`document.querySelector('input[value="midnight"]')`);
  check('theme preview changes the current view immediately',await evaluate("document.documentElement.dataset.theme==='midnight' && !document.querySelector('#save-theme').disabled"));
  check('preview does not mutate the persisted workspace theme',await evaluate("fetch('/api/appearance').then(r=>r.json()).then(r=>r.theme==='mechlin')"));
  await click(`document.querySelector('[data-action="reset-theme"]')`);
  check('reset restores saved theme without saving',await evaluate("document.documentElement.dataset.theme==='mechlin' && document.querySelector('#save-theme').disabled"));
  for(const theme of ['midnight','ocean','mechlin']){
    await click(`document.querySelector('input[value="${theme}"]')`);await click(`document.querySelector('#save-theme')`);
    await waitFor(`document.querySelector('#save-theme')?.disabled && document.querySelector('#appearance-status')?.textContent.includes('saved workspace theme') && document.documentElement.dataset.theme==='${theme}'`);
    check(theme+' theme saves through the admin form',await evaluate(`fetch('/api/appearance').then(r=>r.json()).then(r=>r.theme==='${theme}')`));
    await evaluate("document.querySelector('#notice').textContent=''");await snap('settings-'+theme);
    await send('Page.reload');await waitFor(`(document.querySelector('#appearance-form')!==null || document.querySelector('.metrics')!==null) && document.documentElement.dataset.theme==='${theme}'`);
    check(theme+' theme persists after a full page reload',true);
    if(!(await evaluate("document.querySelector('.metrics')!==null"))){await click("document.querySelector('[data-nav=\"Overview\"]')");await waitFor("document.querySelector('.metrics')!==null");}
    await snap('overview-'+theme);
    for(const view of ['Candidates','Pipeline','Interviews','Administration']){
      await click(`document.querySelector('[data-nav="${view}"]')`);await waitFor(`document.querySelector('#main h1')?.textContent===${JSON.stringify(view)}`);
      check(`${theme}: ${view} loads with saved theme`,await evaluate(`document.documentElement.dataset.theme==='${theme}' && !document.querySelector('#main').innerText.includes('Could not load')`));
    }
    await click(`document.querySelector('[data-nav="Settings"]')`);await waitFor("document.querySelector('#appearance-form')!==null");
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    check(`${theme}: mobile theme settings stay within the viewport`,await evaluate('document.documentElement.scrollWidth<=window.innerWidth'));
    await snap('mobile-settings-'+theme);
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  }
  await click(`document.querySelector('[data-nav="Candidates"]')`);await waitFor(`document.querySelector('[data-action="new-candidate"]')!==null`);
  await click(`document.querySelector('[data-action="new-candidate"]')`);await waitFor("document.querySelector('dialog').open");
  check('candidate form fields have labels',await evaluate("[...document.querySelectorAll('#edit-form input,#edit-form textarea')].every(e=>e.closest('label'))"));
  await evaluate(`{const f=document.querySelector('#edit-form');for(const [k,v] of Object.entries({name:'Browser Test <b>Candidate</b>',email:'browser-test@example.com',phone:'',team:'Dev',skills:'SQL, JavaScript',source:'Referral',resume_text:'Experience with SQL and JavaScript.'}))f.elements[k].value=v;f.requestSubmit();}`);
  await waitFor("!document.querySelector('dialog').open && document.querySelector('#main').innerText.includes('browser-test@example.com')");
  check('candidate form saves and refreshes directory',true);
  check('candidate content is escaped against markup injection',await evaluate("document.querySelector('#candidate-table').innerHTML.includes('&lt;b&gt;Candidate&lt;/b&gt;') && !document.querySelector('#candidate-table b')"));
  await evaluate(`{const q=document.querySelector('#candidate-search');q.value='browser-test';q.dispatchEvent(new Event('input'));}`);
  check('candidate search filters rows',await evaluate("document.querySelectorAll('#candidate-table tbody tr').length===1"));
  check('Candidate directory displays Edit option for existing candidate',await evaluate("Boolean(document.querySelector('#candidate-table [data-action=\"edit-candidate\"]'))"));
  check('Candidate directory displays View profile option for existing candidate',await evaluate("Boolean(document.querySelector('#candidate-table [data-action=\"candidate-details\"]'))"));
  await click(`document.querySelector('#candidate-table [data-action="edit-candidate"]')`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent==='Edit candidate'");
  check('edit form pre-populates existing candidate details',await evaluate("document.querySelector('#edit-form [name=name]').value.includes('Candidate') && document.querySelector('#edit-form [name=email]').value==='browser-test@example.com' && document.querySelector('#edit-form [name=resume_text]').value.includes('Experience with SQL')"));
  await evaluate(`{const f=document.querySelector('#edit-form');f.elements['name'].value='Browser Test Senior Candidate';f.elements['skills'].value='SQL, JavaScript, TypeScript';f.elements['resume_text'].value='10 years experience with SQL, JavaScript and TypeScript.';f.requestSubmit();}`);
  await waitFor("!document.querySelector('dialog').open && document.querySelector('#candidate-table').innerText.includes('Browser Test Senior Candidate')");
  check('candidate edit updates candidate details and experience in directory',await evaluate("document.querySelector('#candidate-table').innerText.includes('Browser Test Senior Candidate') && document.querySelector('#candidate-table').innerText.includes('TypeScript')"));
  await click(`document.querySelector('#candidate-table [data-action="candidate-details"]')`);
  await waitFor("document.querySelector('dialog').open");
  check('candidate details modal displays updated profile and Edit option',await evaluate("document.querySelector('dialog').innerText.includes('10 years experience') && Boolean(document.querySelector('dialog [data-action=\"edit-candidate\"]'))"));
  await click(`document.querySelector('#close-modal')`);
  await click(`document.querySelector('[data-action="new-candidate"]')`);
  await evaluate(`{const f=document.querySelector('#edit-form');for(const [k,v] of Object.entries({name:'Duplicate',email:'browser-test@example.com',team:'Dev',source:'Direct',skills:''}))f.elements[k].value=v;f.requestSubmit();}`);
  await waitFor("document.querySelector('#form-error').textContent.includes('already exists')");
  check('duplicate error preserves form and user input',await evaluate("document.querySelector('dialog').open && document.querySelector('[name=name]').value==='Duplicate'"));
  await click(`document.querySelector('#close-modal')`);

  await click(`document.querySelector('[data-action="new-candidate"]')`);
  await waitFor("document.querySelector('dialog').open");
  await evaluate(`{const f=document.querySelector('#edit-form');f.elements['name'].value='QA Candidate';f.elements['email'].value='qa-candidate@example.com';f.elements['skills'].value='Manual Testing * Automation Testing';f.requestSubmit();}`);
  await waitFor("document.querySelector('#skills-error')?.textContent.includes('expected comma-separated format')");
  check('Skills field rejects unsupported separator * and displays validation message',await evaluate("document.querySelector('dialog').open && document.querySelector('#skills-error').textContent.includes('Manual Testing, Automation Testing')"));

  await evaluate(`{const f=document.querySelector('#edit-form');f.elements['skills'].value='Manual Testing : Automation Testing';f.requestSubmit();}`);
  await waitFor("document.querySelector('#skills-error')?.textContent.includes('expected comma-separated format')");
  check('Skills field rejects unsupported separator :',await evaluate("document.querySelector('dialog').open && document.querySelector('#skills-error').textContent.includes('Manual Testing, Automation Testing')"));

  await evaluate(`{const f=document.querySelector('#edit-form');f.elements['skills'].value='Manual Testing & Automation Testing';f.requestSubmit();}`);
  await waitFor("document.querySelector('#skills-error')?.textContent.includes('expected comma-separated format')");
  check('Skills field rejects unsupported separator &',await evaluate("document.querySelector('dialog').open && document.querySelector('#skills-error').textContent.includes('Manual Testing, Automation Testing')"));

  await evaluate(`{const f=document.querySelector('#edit-form');f.elements['skills'].value='Manual Testing, Automation Testing';f.elements['skills'].dispatchEvent(new Event('input'));f.requestSubmit();}`);
  await waitFor("!document.querySelector('dialog').open");
  await evaluate(`{const q=document.querySelector('#candidate-search');if(q){q.value='';q.dispatchEvent(new Event('input'));}}`);
  await waitFor("document.querySelector('#main').innerText.includes('qa-candidate@example.com')");
  check('Skills field accepts comma-separated format and renders separate skill chips',await evaluate("(()=>{const row=[...document.querySelectorAll('#candidate-table tbody tr')].find(r=>r.innerText.includes('qa-candidate@example.com'));if(!row)return false;const chips=[...row.querySelectorAll('.skill-chip')].map(c=>c.textContent.trim());return chips.includes('Manual Testing') && chips.includes('Automation Testing') && chips.length===2;})()"));

  await click(`document.querySelector('[data-nav="Overview"]')`);await waitFor("document.querySelector('.metrics')!==null");
  await evaluate("document.querySelector('#notice').textContent=''");

  check('Needs your attention container has fixed/max height and vertical scrolling style',await evaluate("(()=>{const el=document.querySelector('.attention-list');if(!el)return false;const s=window.getComputedStyle(el);return s.overflowY==='auto' && parseInt(s.maxHeight,10)<=400;})()"));

  await evaluate(`(async ()=>{
    for(let i=1;i<=4;i++){
      const r=await api('requisitions','POST',{title:'Attention Role '+i,team:'Dev',headcount:1,salary_min:90000,salary_max:120000,currency:'USD',description:'Test requisition',skills:['JavaScript']});
      await api('requisitions/'+r.id+'/submit','POST');
    }
  })()`);
  await click(`document.querySelector('[data-nav="Candidates"]')`);await waitFor("document.querySelector('#candidate-table')!==null");
  await click(`document.querySelector('[data-nav="Overview"]')`);await waitFor("document.querySelectorAll('.attention-card').length>=4");

  check('Needs your attention scrolls internally when multiple entries exceed container height',await evaluate("(()=>{const el=document.querySelector('.attention-list');return el && el.scrollHeight>el.clientHeight && el.clientHeight<=400;})()"));
  check('Overview page layout remains stable with multiple attention items',await evaluate("(()=>{const panel=document.querySelector('.panel-attention')||document.querySelector('.attention-list').closest('.panel');return panel && panel.clientHeight<=600;})()"));

  await click(`document.querySelector('[data-nav="Pipeline"]')`);await waitFor("document.querySelector('.board')!==null");

  check('Hired and Rejected pipeline columns have fixed/max height and overflow-y auto',await evaluate("(()=>{const hired=document.querySelector('.column[data-stage=\"Hired\"]');const rejected=document.querySelector('.column[data-stage=\"Rejected\"]');if(!hired||!rejected)return false;const hs=window.getComputedStyle(hired),rs=window.getComputedStyle(rejected);const hc=hired.querySelector('.column-content'),rc=rejected.querySelector('.column-content');const hcs=window.getComputedStyle(hc),rcs=window.getComputedStyle(rc);return hired.classList.contains('column-terminal') && rejected.classList.contains('column-terminal') && ((hs.overflowY==='auto'&&parseInt(hs.maxHeight,10)<=600)||(hcs.overflowY==='auto'&&parseInt(hcs.maxHeight,10)<=600)) && ((rs.overflowY==='auto'&&parseInt(rs.maxHeight,10)<=600)||(rcs.overflowY==='auto'&&parseInt(rcs.maxHeight,10)<=600));})()"));
  check('Pipeline page does not render top horizontal scroll bar', await evaluate("document.querySelector('#pipeline-top-scroll') === null"));
  check('Pipeline page renders sticky bottom horizontal scroll bar', await evaluate("document.querySelector('#pipeline-bottom-scroll') !== null"));
  check('Pipeline cards in intermediate stages display Back button to previous stage', await evaluate("Boolean(document.querySelector('.column[data-stage=\"Screening\"] [data-action=\"move\"][data-stage=\"Applied\"]'))"));
  check('Pipeline cards in Applied stage do not display Back button', await evaluate("(()=>{const btns=Array.from(document.querySelectorAll('.column[data-stage=\"Applied\"] button'));return !btns.some(b=>b.textContent.includes('Back to'));})()"));

  const screeningAppCard = await evaluate("document.querySelector('.column[data-stage=\"Screening\"] .card h3')?.textContent");
  if(screeningAppCard) {
    const prevAppliedCount = await evaluate("document.querySelectorAll('.column[data-stage=\"Applied\"] .card').length");
    await click(`document.querySelector('.column[data-stage="Screening"] [data-action="move"][data-stage="Applied"]')`);
    await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body').textContent.includes('Applied')");
    await click("document.querySelector('#edit-form button[type=submit]')");
    await waitFor(`document.querySelectorAll('.column[data-stage="Applied"] .card').length === ${prevAppliedCount + 1}`);
    check('Clicking Back button moves candidate card back to previous stage', await evaluate(`Boolean(Array.from(document.querySelectorAll('.column[data-stage="Applied"] .card h3')).find(h => h.textContent === ${JSON.stringify(screeningAppCard)}))`));
  }

  await evaluate(`(async ()=>{
    const reqs=await api('requisitions');
    const approved=reqs.find(r=>r.status==='open');
    if(!approved)return;
    for(let i=1;i<=6;i++){
      const c=await api('candidates','POST',{name:'Terminal Test Candidate '+i,email:'terminal'+i+'@example.com',team:'Dev',source:'Direct',skills:['SQL']});
      const a=await api('applications','POST',{candidate_id:c.id,requisition_id:approved.id});
      await api('applications/'+a.id+'/stage','POST',{stage:'Rejected'});
    }
  })()`);
  await click(`document.querySelector('[data-nav="Candidates"]')`);await waitFor("document.querySelector('#candidate-table')!==null");
  await click(`document.querySelector('[data-nav="Pipeline"]')`);await waitFor("document.querySelectorAll('.column[data-stage=\"Rejected\"] .card').length>=6");

  check('Rejected column scrolls internally with internal vertical scrollbar when cards exceed space',await evaluate("(()=>{const col=document.querySelector('.column[data-stage=\"Rejected\"]');const content=col.querySelector('.column-content');const target=content.scrollHeight>content.clientHeight?content:col;return target.scrollHeight>target.clientHeight && col.clientHeight<=600;})()"));
  check('Pipeline board layout remains stable with multiple candidates in terminal columns',await evaluate("(()=>{const col=document.querySelector('.column[data-stage=\"Rejected\"]');return col && col.clientHeight<=600;})()"));

  await evaluate(`(async ()=>{
    const reqs=await api('requisitions');
    const openReq=reqs.find(r=>r.status==='open');
    if(!openReq)return;
    const longTitle='Senior Staff Enterprise Distributed Systems & Infrastructure Security Architect (Global Cloud Platform & Kubernetes Microservices Lead)';
    await api('requisitions/'+openReq.id,'PUT',{title:longTitle});
    const c=await api('candidates','POST',{name:'Long Title Candidate',email:'longtitle@example.com',team:openReq.team,source:'Direct',skills:['JavaScript']});
    await api('applications','POST',{candidate_id:c.id,requisition_id:openReq.id});
  })()`);
  await click(`document.querySelector('[data-nav="Candidates"]')`);await waitFor("document.querySelector('#candidate-table')!==null");
  await click(`document.querySelector('[data-nav="Pipeline"]')`);await waitFor("document.querySelector('#pipeline-board') && document.querySelector('#pipeline-board').innerText.includes('Long Title Candidate')");

  check('Long requisition title wraps within application card without overlapping adjacent columns or disrupting layout', await evaluate(`(()=>{
    const card = Array.from(document.querySelectorAll('.card')).find(c => c.innerText.includes('Long Title Candidate'));
    if(!card) return false;
    const col = card.closest('.column');
    const nextCol = col ? col.nextElementSibling : null;
    const role = card.querySelector('.card-role') || card.querySelector('p.muted');
    if(!role) return false;
    const cardRect = card.getBoundingClientRect();
    const colRect = col.getBoundingClientRect();
    const roleRect = role.getBoundingClientRect();
    const nextColLeft = nextCol ? nextCol.getBoundingClientRect().left : Infinity;
    const wrapsWithinCard = roleRect.right <= cardRect.right + 2 && role.scrollWidth <= card.clientWidth + 2;
    const withinColumn = cardRect.right <= colRect.right + 2 && cardRect.right < nextColLeft;
    const s = window.getComputedStyle(role);
    const hasWrapping = (s.overflowWrap === 'anywhere' || s.wordBreak === 'break-word') && s.whiteSpace === 'normal';
    return wrapsWithinCard && withinColumn && hasWrapping;
  })()`));

  await click(`document.querySelector('[data-nav="Interviews"]')`);
  await waitFor("document.querySelector('table tbody tr')!==null");
  check('Interviews table displays Edit option for scheduled interviews',await evaluate("Boolean(document.querySelector('table [data-action=\"edit-interview\"]'))"));
  await click(`document.querySelector('table [data-action="edit-interview"]')`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent==='Edit interview'");
  check('Edit interview modal pre-populates scheduled date and time',await evaluate("Boolean(document.querySelector('#edit-form [name=scheduled_at]').value)"));
  await evaluate(`{
    const f=document.querySelector('#edit-form');
    f.elements['scheduled_at'].value='2030-05-20T14:30';
    f.requestSubmit();
  }`);
  await waitFor("!document.querySelector('dialog').open");
  check('Interviews table displays updated interview date and time after edit',await evaluate("document.querySelector('#main').innerText.includes('2030')"));

  await click(`document.querySelector('[data-nav="Requisitions"]')`);
  await waitFor("document.querySelector('.requisitions-table tbody tr')!==null");
  check('Requisitions table displays Edit option for existing eligible requisition',await evaluate("Boolean(document.querySelector('.requisitions-table [data-action=\"edit-req\"]'))"));
  check('Pending requisition does not display Edit option',await evaluate("(()=>{const rows=[...document.querySelectorAll('.requisitions-table tbody tr')];const pendingRow=rows.find(r=>r.innerText.includes('Engineering Manager')||r.innerText.includes('pending'));return pendingRow && !pendingRow.querySelector('[data-action=\"edit-req\"]');})()"));
  await click(`document.querySelector('.requisitions-table [data-action="edit-req"]')`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent==='Edit requisition'");
  check('Edit requisition modal pre-populates existing position, team, headcount, and description',await evaluate("Boolean(document.querySelector('#edit-form [name=title]').value && document.querySelector('#edit-form [name=team]').value && document.querySelector('#edit-form [name=headcount]').value && document.querySelector('#edit-form [name=description]').value)"));
  await evaluate(`{
    const f=document.querySelector('#edit-form');
    f.elements['title'].value='Staff Cloud Architect';
    f.elements['headcount'].value='2';
    f.elements['skills'].value='Go, Kubernetes, Cloud Architecture';
    f.elements['description'].value='Lead our core cloud architecture and distributed infrastructure.';
    f.requestSubmit();
  }`);
  await waitFor("!document.querySelector('dialog').open && document.querySelector('.requisitions-table').innerText.includes('Staff Cloud Architect')");
  check('Requisitions table displays updated position and skills after edit',await evaluate("document.querySelector('.requisitions-table').innerText.includes('Staff Cloud Architect') && document.querySelector('.requisitions-table').innerText.includes('Cloud Architecture')"));
  await click(`[...document.querySelectorAll('.requisitions-table tbody tr')].find(r=>r.innerText.includes('Staff Cloud Architect')).querySelector('[data-action="req-details"]')`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body')?.innerText.includes('Lead our core cloud architecture')");
  check('Requisition details modal displays updated details and Edit option',await evaluate("document.querySelector('dialog').innerText.includes('Lead our core cloud architecture') && Boolean(document.querySelector('dialog [data-action=\"edit-req\"]'))"));
  await click(`document.querySelector('#close-modal')`);

  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await click(`document.querySelector('[data-nav="Overview"]')`);await waitFor("document.querySelector('.metrics')!==null");
  check('mobile dashboard fits viewport',await evaluate('document.documentElement.scrollWidth<=window.innerWidth'));
  await snap('mobile-overview');
  await click(`document.querySelector('[data-nav="Pipeline"]')`);await waitFor("document.querySelector('.board')!==null");
  check('mobile pipeline uses contained horizontal scrolling',await evaluate('document.documentElement.scrollWidth<=window.innerWidth && document.querySelector(".board").scrollWidth>document.querySelector(".board").clientWidth'));
  await snap('mobile-pipeline');
  await click(`document.querySelector('[data-nav="Settings"]')`);await waitFor("document.querySelector('#appearance-form')!==null");
  await evaluate("document.querySelector('input[value=mechlin]').focus()");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  check('keyboard arrow navigation previews the next theme',await evaluate("document.activeElement.value==='midnight' && document.documentElement.dataset.theme==='midnight'"));
  await click(`document.querySelector('[data-action="reset-theme"]')`);
  check('PWA manifest uses Orbit branding',await evaluate("fetch('/manifest.webmanifest').then(r=>r.json()).then(r=>r.name==='Mechlin Orbit' && r.short_name==='Orbit')"));
  check('PWA icons and offline page are available',await evaluate("Promise.all(['/icon.svg','/icon-192.png','/icon-512.png','/offline.html'].map(url=>fetch(url).then(r=>r.ok))).then(r=>r.every(Boolean))"));
  await click(`document.querySelector('[data-action="logout"]')`);await waitFor("document.querySelector('.login-card')!==null");
  check('sign out returns to Microsoft-only login',await evaluate("document.querySelector('.login-card a').textContent.trim()==='Sign in with Microsoft 365'"));
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await snap('desktop-login');
  await send('Page.navigate',{url:'http://localhost:3000/?access=pending'});await waitFor("document.querySelector('.notice-inline')!==null");
  check('pending access notice explains approval requirement',await evaluate("document.querySelector('.notice-inline').textContent.includes('Access pending approval')"));
  check('no browser runtime exceptions',exceptions.length===0);
  writeFileSync(resolve(output,'BROWSER_RESULTS.txt'),`${results.join('\n')}\nChecks: ${results.length}; failed: 0\nBrowser: ${JSON.stringify(await send('Browser.getVersion',{},null))}\nSynthetic in-memory data; no live Entra authentication.\n`);
}catch(error){console.error('BROWSER FAILURE',error.message);try{console.error('PAGE',await evaluate('document.body.innerText'));console.error('EXCEPTIONS',JSON.stringify(exceptions));const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(output,'browser-failure.png'),Buffer.from(shot.data,'base64'));}catch{console.error('Browser diagnostics unavailable.');}throw error;}finally{await send('Browser.close',{},null).catch(()=>{});ws.close();chrome.kill();app.close();}
