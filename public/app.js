const $ = s => document.querySelector(s);
const escape = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let me, csrf, permissions = [], current = 'Overview', renderVersion = 0, reqPage = 1, candidateQuery = '';
const pageState = { Requisitions: 1, Candidates: 1, Interviews: 1, Referrals: 1, Administration: 1, 'Audit log': 1 };
const getNavList = () => [
  ...(allows('analytics') ? ['Overview'] : []),
  'Requisitions',
  ...(allows('review') || allows('recruit') ? ['Candidates', 'Pipeline'] : []),
  ...(allows('review') || allows('recruit') || allows('interview') ? ['Interviews'] : []),
  ...(allows('refer') ? ['Referrals'] : []),
  ...(allows('admin') ? ['Administration', 'Settings', 'Audit log', 'Pipeline settings'] : []),
  ...(allows('admin') || allows('recruit') ? ['Integrations'] : [])
];
const parseNavFromHash = (nav) => {
  const raw = location.hash.replace(/^#\/?/, '').trim();
  if (!raw) return null;
  const [viewPart, queryPart] = raw.split('?');
  const viewName = decodeURIComponent(viewPart).trim().toLowerCase();
  const found = nav.find(n => n.toLowerCase() === viewName || n.toLowerCase().replace(/\s+/g, '-') === viewName);
  if (found && queryPart) {
    const params = new URLSearchParams(queryPart);
    const p = Number(params.get('page'));
    if (p >= 1) { pageState[found] = p; if (found === 'Requisitions') reqPage = p; }
  }
  return found || null;
};
const getSavedNav = (nav) => {
  const fromHash = parseNavFromHash(nav);
  if (fromHash) return fromHash;
  try {
    const saved = sessionStorage.getItem('orbit_current') || localStorage.getItem('orbit_current');
    if (saved) {
      const found = nav.find(n => n.toLowerCase() === saved.trim().toLowerCase() || n.toLowerCase().replace(/\s+/g, '-') === saved.trim().toLowerCase());
      if (found) return found;
    }
  } catch {}
  return nav[0] || 'Overview';
};
const syncNavState = () => {
  if (!me) return;
  try {
    sessionStorage.setItem('orbit_current', current);
    localStorage.setItem('orbit_current', current);
    sessionStorage.setItem('orbit_pages', JSON.stringify(pageState));
    localStorage.setItem('orbit_pages', JSON.stringify(pageState));
    const p = pageState[current] || 1;
    const target = p > 1 ? `#/${encodeURIComponent(current)}?page=${p}` : `#/${encodeURIComponent(current)}`;
    if (location.hash !== target) history.replaceState(null, '', target);
  } catch {}
};
const loadSavedPages = () => {
  try {
    const saved = sessionStorage.getItem('orbit_pages') || localStorage.getItem('orbit_pages');
    if (saved) {
      Object.assign(pageState, JSON.parse(saved));
      if (pageState.Requisitions) reqPage = pageState.Requisitions;
    }
  } catch {}
};
let appearance={theme:document.documentElement.dataset.theme || 'mechlin',themes:[]};
const iconPaths={Overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',Requisitions:'M8 6V4h8v2 M3 7h18v13H3z M3 12h18 M10 11v3h4v-3',Candidates:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4',Pipeline:'M4 4h4v16H4z M10 4h4v11h-4z M16 4h4v7h-4z',Interviews:'M4 5h16v16H4z M8 2v6 M16 2v6 M4 10h16 M8 14h3 M14 14h2 M8 17h3',Referrals:'M12 20V10 M7 15l5-5 5 5 M4 4h16v4H4z',Administration:'M12 3l8 4v6c0 4-4 7-8 9-4-2-8-5-8-9V7z M8 12l3 3 5-6','Audit log':'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h4','Pipeline settings':'M4 7h16 M4 17h16 M8 4v6 M16 14v6',Settings:'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',Integrations:'M8 3v5 M16 3v5 M5 8h14v4a7 7 0 0 1-14 0z M12 19v3'};
const icon=name=>`<svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name]||iconPaths.Overview}"/></svg>`;
const initials=name=>escape(String(name).split(/\s+/).filter(Boolean).slice(0,2).map(n=>n[0]).join('').toUpperCase());
const applyTheme=theme=>{document.documentElement.dataset.theme=theme;document.querySelector('meta[name="theme-color"]').content=theme==='midnight'?'#0b1322':'#111f35';};
const brand=()=>`<div class="company-logo"><img src="/mechlin-logo.webp" alt="Mechlin Technologies" width="174" height="40"></div><div class="product-brand"><span class="orbit-symbol" aria-hidden="true"></span><span>Orbit<small>Talent workspace</small></span></div>`;
const allows = p => permissions.includes(p);
const notice = message => {
  const n = $('#notice');
  if($('#modal')?.open && n.parentElement !== $('#modal')) $('#modal').appendChild(n);
  n.textContent = message;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => n.textContent = '', 7000);
};
async function api(path,method='GET',body) {
  const response=await fetch(`/api/${path}`,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf || ''},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok){if(response.status===401 && me){me=null;login();}throw new Error(data.error || 'Request failed.');}return data;
}
const badge = value => `<span class="badge ${escape(String(value).split('_')[0])}">${escape(String(value).replaceAll('_',' '))}</span>`;
const empty = message => `<div class="empty">${escape(message)}</div>`;
const button = (title,action,id='',extra='') => `<button type="button" data-action="${action}" data-id="${escape(id)}" ${extra}>${escape(title)}</button>`;
const table = (headers,rows,cls='') => rows.length?`<div class="table-wrap ${cls?cls+'-wrap':''}"><table class="${cls}"><thead><tr>${headers.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:empty('No records yet.');
const field = (label,name,type='text',value='',required=true) => `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" ${required?'required':''}><span class="field-error error" id="${name}-error" role="alert"></span></label>`;
const area = (label,name,value='',required=false) => `<label class="full">${label}<textarea name="${name}" ${required?'required':''}>${escape(value)}</textarea></label>`;
const select = (label,name,values,selected='') => `<label>${label}<select name="${name}" required>${values.map(v=>{const [id,title]=Array.isArray(v)?v:[v,v];return `<option value="${escape(id)}" ${id===selected?'selected':''}>${escape(title)}</option>`;}).join('')}</select></label>`;
const skills = v => v.split(',').map(s=>s.trim()).filter(Boolean);
const checkSkills = v => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/[*:&;|~^$%@!=<>?`"\\]/.test(s)) {
    return 'Enter skills only in the expected comma-separated format, for example: Manual Testing, Automation Testing';
  }
  const items = s.split(',').map(x => x.trim()).filter(Boolean);
  if (!items.length) {
    return 'Enter skills only in the expected comma-separated format, for example: Manual Testing, Automation Testing';
  }
  for (const item of items) {
    if (!/^[\p{L}\p{N}\s.\-/+#()']{1,100}$/u.test(item)) {
      return 'Enter skills only in the expected comma-separated format, for example: Manual Testing, Automation Testing';
    }
  }
  return '';
};
const bindValidation = (name, checkFn) => {
  const inp = $(`#edit-form [name="${name}"]`);
  if (!inp) return;
  inp.onblur = () => {
    const err = checkFn(inp.value);
    inp.setCustomValidity(err);
    const el = $(`#${name}-error`);
    if (el) el.textContent = err;
  };
  inp.oninput = () => {
    if (!checkFn(inp.value)) {
      inp.setCustomValidity('');
      const el = $(`#${name}-error`);
      if (el) el.textContent = '';
    }
  };
};
const checkPhone = v => { const s = String(v ?? '').trim(); if (!s) return ''; const d = s.replace(/\D/g, ''); return ((!/^\+?[0-9\s\-().–—]+$/.test(s) && !/^\([+]?[0-9]+\)[\s0-9\-().–—]+$/.test(s)) || d.length < 7 || d.length > 15) ? 'Enter a valid phone number.' : ''; };
const paginate = (items, page = 1, pageSize = 10) => { const total = items.length, totalPages = Math.max(1, Math.ceil(total / pageSize)), cur = Math.min(Math.max(1, page), totalPages), start = (cur - 1) * pageSize; return { paged: items.slice(start, start + pageSize), page: cur, totalPages, total, start }; };
const renderPagination = (view, page, totalPages, total, start, pageSize = 10) => {
  if (!total) return '';
  const end = Math.min(start + pageSize, total);
  let pagesHtml = '';
  if (totalPages <= 7) {
    pagesHtml = Array.from({length: totalPages}, (_, i) => i + 1).map(p => `<button type="button" class="${p === page ? 'active' : 'secondary'}" data-action="${view === 'Requisitions' ? 'req-page' : 'page'}" data-view="${escape(view)}" data-page="${p}" ${p === page ? 'aria-current="page"' : ''}>${p}</button>`).join('');
  } else {
    const pages = [], left = Math.max(1, page - 1), right = Math.min(totalPages, page + 1);
    pages.push(1);
    if (left > 2) pages.push('...');
    for (let p = Math.max(2, left); p <= Math.min(totalPages - 1, right); p++) pages.push(p);
    if (right < totalPages - 1) pages.push('...');
    if (totalPages > 1) pages.push(totalPages);
    pagesHtml = pages.map(p => p === '...' ? `<span class="pagination-ellipsis" aria-hidden="true">…</span>` : `<button type="button" class="${p === page ? 'active' : 'secondary'}" data-action="${view === 'Requisitions' ? 'req-page' : 'page'}" data-view="${escape(view)}" data-page="${p}" ${p === page ? 'aria-current="page"' : ''}>${p}</button>`).join('');
  }
  return `<div class="pagination" role="navigation" aria-label="${escape(view)} pagination"><span class="pagination-info">Showing ${start + 1}–${end} of ${total}</span><div class="pagination-controls"><button type="button" class="secondary" data-action="${view === 'Requisitions' ? 'req-page' : 'page'}" data-view="${escape(view)}" data-page="${page - 1}" data-total-pages="${totalPages}" ${page <= 1 ? 'disabled' : ''}>Previous</button><div class="pagination-pages">${pagesHtml}</div><button type="button" class="secondary" data-action="${view === 'Requisitions' ? 'req-page' : 'page'}" data-view="${escape(view)}" data-page="${page + 1}" data-total-pages="${totalPages}" ${page >= totalPages ? 'disabled' : ''}>Next</button></div></div>`;
};
const currencies = ['USD','EUR','GBP','CAD','AUD','INR','JPY','CHF','SGD','NZD','AED','HKD','SEK','NOK','DKK','BRL','MXN','ZAR'];
const checkCurrency = v => { const s = String(v ?? '').trim().toUpperCase(); return (!s || !/^[A-Z]{3}$/.test(s) || !currencies.includes(s)) ? 'Enter a supported three-letter currency code.' : ''; };
const closeModal = () => {
  const n = $('#notice');
  if(n && n.parentElement !== document.body) document.body.appendChild(n);
  $('#modal').close();
};
function modal(title,html,onSubmit) {
  $('#modal-body').innerHTML=`<h2>${escape(title)}</h2>${onSubmit?`<form id="edit-form">${html}<p class="error" id="form-error" role="alert"></p><button type="submit">Save</button></form>`:html}`;
  if(onSubmit)$('#edit-form').onsubmit=async event=>{event.preventDefault();const submit=event.target.querySelector('[type=submit]');submit.disabled=true;try{await onSubmit(Object.fromEntries(new FormData(event.target)));closeModal();notice('Saved.');await render();}catch(e){$('#form-error').textContent=e.message;}finally{submit.disabled=false;}};
  $('#modal').showModal();
  if($('#notice')?.textContent)$('#modal').appendChild($('#notice'));
}
$('#close-modal').onclick=closeModal;
$('#modal').addEventListener('close',()=>{const n=$('#notice');if(n&&n.parentElement!==document.body)document.body.appendChild(n);});
function login() {
  const status=new URLSearchParams(location.search).get('access');
  const messages={pending:'Access pending approval. Your request has been sent to the ATS administrators. Sign in again after approval.',rejected:'Your access request was rejected. Contact your ATS administrator.',disabled:'Your access has been disabled. Contact your ATS administrator.'};
  applyTheme(appearance.theme);
  $('#app').innerHTML=`<div class="login"><section class="login-brand"><div>${brand()}</div><div class="login-message"><p class="eyebrow">People. Possibility. Orbit.</p><h1>Great teams<br>start with<br><em>great connections.</em></h1><p>A shared space for every step of your next great hire.</p><div class="login-steps"><span>Discover</span><span>Connect</span><span>Hire</span></div></div><p class="login-footer">A Mechlin product · Built for our people</p></section><main class="login-form" id="main"><div class="login-card"><span class="workspace-label">MECHLIN WORKSPACE</span><h1>Welcome to Orbit</h1><p class="muted">Your team’s next chapter starts here.</p>${messages[status]?`<div class="notice-inline">${messages[status]}</div>`:''}<a class="button microsoft-signin" href="/auth/login"><span class="microsoft-mark" aria-hidden="true"></span>Sign in with Microsoft 365</a><p class="muted">Use your Mechlin work account. New team members need administrator approval.</p><div class="login-access-note">${icon('Administration')}<span>Private workspace. Approved access only.</span></div></div></main></div>`;
}
function shell() {
  const nav=getNavList();
  if(!nav.includes(current))current=nav[0];
  $('#app').innerHTML=`<div class="layout"><aside class="sidebar"><div class="sidebar-brand">${brand()}</div><nav aria-label="Main navigation"><p class="nav-label">WORKSPACE</p>${nav.map(n=>`${n==='Administration'?'<p class="nav-label admin-label">MANAGE</p>':''}<button data-nav="${n}" class="${current===n?'active':''}" ${current===n?'aria-current="page"':''}>${icon(n)}<span>${n}</span></button>`).join('')}</nav><div class="profile"><span class="avatar">${initials(me.name)}</span><div><strong>${escape(me.name)}</strong><div class="muted">${escape(me.role)}</div></div></div><div class="sidebar-caption">Mechlin Orbit · Internal workspace</div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb">Orbit <span>/</span> <strong>${escape(current)}</strong></div><div class="topbar-right"><span class="workspace-status">${icon('Administration')} Private workspace</span><button class="secondary" data-action="logout">Sign out</button><span class="avatar small" aria-label="${escape(me.name)}">${initials(me.name)}</span></div></header><main class="content" id="main" tabindex="-1"><p class="muted">Loading your workspace…</p></main><footer class="workspace-footer">Thoughtful hiring, together. <span>Orbit by Mechlin</span></footer></div></div>`;
  document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{if(current!==b.dataset.nav){reqPage=1;pageState[b.dataset.nav]=1;if(b.dataset.nav==='Candidates')candidateQuery='';}current=b.dataset.nav;render();});
}
async function render() {
  const version=++renderVersion;let html='';
  const heading=(subtitle,action='')=>`<div class="heading"><div><p class="eyebrow">${current==='Overview'?`YOUR TEAM. YOUR NEXT CHAPTER.`:allows('admin')&&['Settings','Administration','Audit log','Pipeline settings'].includes(current)?'WORKSPACE MANAGEMENT':'TALENT ACQUISITION'}</p><h1>${current}</h1><p class="muted">${subtitle}</p></div>${action}</div>`;
  try {
    const config=await api('appearance');if(version!==renderVersion||!me)return;appearance=config;applyTheme(config.theme);shell();
    if(current==='Overview') {
      const [stats,reqs]=await Promise.all([api('analytics'),api('requisitions')]);
      html=heading(`Welcome back, ${escape(me.name.split(' ')[0])}. Let’s move great people forward.`,allows('recruit')?button('+ Add candidate','new-candidate'):'')+`<div class="metrics">${[['Open requisitions',stats.openRequisitions,'Requisitions','Ready for your next hire'],['Approved headcount',stats.approvedHeadcount,'Referrals','Positions approved to fill'],['Candidates',stats.candidates,'Candidates','People in your talent pool'],['Awaiting approval',stats.pendingApprovals,'Administration','Requisitions awaiting a decision']].map(([label,count,i,note],n)=>`<div class="metric metric-${n}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(i)}</span></div><strong>${count}</strong><small>${note}</small></div>`).join('')}</div><div class="split"><section class="panel"><div class="panel-head"><div><h2>Hiring momentum</h2><p class="muted">A snapshot of your recruitment pipeline</p></div><span class="subtle-label">Current applications</span></div>${Object.entries(stats.stageCounts).map(([stage,count],n)=>`<div class="bar-row stage-${n}"><span>${escape(stage)}</span><progress value="${count}" max="${Math.max(1,...Object.values(stats.stageCounts))}" aria-label="${escape(stage)}"></progress><strong>${count}</strong></div>`).join('')}</section><section class="panel panel-attention"><div class="panel-head"><div><h2>Needs your attention</h2><p class="muted">Keep the next hire moving</p></div><span class="count-pill">${stats.pendingApprovals}</span></div><div class="attention-list" id="attention-list">${reqs.filter(r=>r.status.startsWith('pending')).map(r=>`<div class="attention-card"><div class="attention-title">${icon('Requisitions')}<strong>${escape(r.title)}</strong></div><p class="muted">${escape(r.team)} · ${r.headcount} opening(s)</p><div class="attention-bottom">${badge(r.status)}${button('View role','req-details',r.id,'class="text-button"')}</div></div>`).join('')||empty('All caught up. No pending requisitions.')}</div><p class="panel-footnote">Approvals keep hiring aligned with your team’s plans.</p></section></div><section class="panel"><div class="panel-head"><div><h2>Recent requisitions</h2><p class="muted">The roles shaping your next chapter</p></div>${button('View all roles','navigate','','class="text-button" data-view="Requisitions"')}</div>${reqTable(reqs.slice(0,5))}</section>`;
    }
    if(current==='Requisitions') {
      const reqs=await api('requisitions');
      const {paged,page,totalPages,total,start}=paginate(reqs,pageState.Requisitions||1,10);
      pageState.Requisitions=page;reqPage=page;
      const pag=renderPagination('Requisitions',page,totalPages,total,start,10);
      html=heading('Headcount, job descriptions and approval decisions.',allows('recruit')||allows('requisition')?button('+ New requisition','new-req'):'')+`<section class="panel">${reqTable(paged)}${pag}</section>`;
    }
    if(current==='Candidates') {
      const candidates=await api('candidates');
      const renderCandidateTable=(q=candidateQuery)=>{
        candidateQuery=q;
        const filtered=q?candidates.filter(c=>`${c.name} ${c.email} ${c.skills} ${c.resume_text}`.toLowerCase().includes(q)):candidates;
        const {paged,page,totalPages,total,start}=paginate(filtered,pageState.Candidates||1,10);
        pageState.Candidates=page;
        const pag=renderPagination('Candidates',page,totalPages,total,start,10);
        return `${candidateTable(paged)}${pag}`;
      };
      html=heading('Search skills, experience and candidate records.',allows('recruit')?button('+ Add candidate','new-candidate'):'')+`<section class="panel"><div class="panel-head"><h2>Candidate directory</h2><label class="search">Search<input id="candidate-search" type="search" placeholder="Candidate or skill" value="${escape(candidateQuery)}"></label></div><div id="candidate-table">${renderCandidateTable()}</div></section>`;
      queueMicrotask(()=>{
        const el=$('#candidate-search');
        if(el)el.oninput=()=>{
          pageState.Candidates=1;
          $('#candidate-table').innerHTML=renderCandidateTable(el.value.toLowerCase());
        };
      });
    }
    if(current==='Pipeline') {
      const [apps,stages]=await Promise.all([api('applications'),api('pipeline')]);html=heading('Move each application through a consistent hiring process.',allows('recruit')?button('+ Add application','new-application'):'')+`<div class="board">${stages.map((stage,index)=>`<section class="column${['Hired','Rejected'].includes(stage)?' column-terminal':''}" data-stage="${escape(stage)}"><h2>${escape(stage)} <span>${apps.filter(a=>a.stage===stage).length}</span></h2><div class="column-content">${apps.filter(a=>a.stage===stage).map(a=>`<article class="card"><h3>${escape(a.name)}</h3><p class="muted">${escape(a.title)}</p><div class="actions">${button('Skill match','match',a.id,'class="secondary"')}${allows('recruit')&&!['Hired','Rejected'].includes(stage)?button(`Move to ${stages[index+1]}`,'move',a.id,`data-stage="${escape(stages[index+1])}"`)+button('Reject','reject-app',a.id,'class="secondary"'):''}</div></article>`).join('')||'<p class="muted">No applications</p>'}</div></section>`).join('')}</div>`;
    }
    if(current==='Interviews') {
      const interviews=await api('interviews');
      const {paged,page,totalPages,total,start}=paginate(interviews,pageState.Interviews||1,10);
      pageState.Interviews=page;
      const pag=renderPagination('Interviews',page,totalPages,total,start,10);
      html=heading('Structured interviews, independent feedback.',allows('recruit')?button('+ Plan interview','new-interview'):'')+`<div class="notice-inline">Interview plans are stored here. Calendar invitations and Teams/Meet links require a calendar adapter.</div><section class="panel">${table(['Candidate / role','Interviewer','Scheduled','Status','Feedback'],paged.map(i=>`<tr><td><strong>${escape(i.name)}</strong>${escape(i.title)}</td><td>${escape(i.interviewer)}</td><td>${escape(new Date(i.scheduled_at).toLocaleString())}</td><td>${badge(i.status)}</td><td><div class="actions">${i.interviewer_id===me.id&&i.status!=='completed'?button('Submit scorecard','scorecard',i.id):''}${i.status!=='completed'&&(allows('recruit')||i.interviewer_id===me.id)?button('Edit','edit-interview',i.id,'class="secondary"'):''}${button('View feedback','feedback',i.id,'class="secondary"')}</div></td></tr>`))}${pag}</section>`;
    }
    if(current==='Referrals') {
      const refs=await api('referrals');
      const {paged,page,totalPages,total,start}=paginate(refs,pageState.Referrals||1,10);
      pageState.Referrals=page;
      const pag=renderPagination('Referrals',page,totalPages,total,start,10);
      html=heading('Recommend a colleague for an open position.',button('+ Make referral','new-referral'))+`<section class="panel"><h2>Your referrals</h2>${table(['Candidate','Email','Referred'],paged.map(r=>`<tr><td>${escape(r.name)}</td><td>${escape(r.email)}</td><td>${escape(new Date(r.at).toLocaleDateString())}</td></tr>`))}${pag}</section>`;
    }
    if(current==='Administration') {
      const users=await api('admin/users');window.currentUsers=users;
      const {paged,page,totalPages,total,start}=paginate(users,pageState.Administration||1,10);
      pageState.Administration=page;
      const pag=renderPagination('Administration',page,totalPages,total,start,10);
      html=heading('Approve access and manage your organization’s users.',button('+ Add user','new-user'))+`<div class="metrics">${[['Active',users.filter(u=>u.status==='active').length],['Pending',users.filter(u=>u.status==='pending').length],['Disabled',users.filter(u=>u.status==='disabled').length],['Rejected',users.filter(u=>u.status==='rejected').length]].map(([label,count])=>`<div class="metric"><span>${label}</span><strong>${count}</strong></div>`).join('')}</div><section class="panel">${table(['User','Role / team','Access','Last sign-in','Manage'],paged.map(u=>`<tr><td><strong>${escape(u.name)}</strong><small>${escape(u.email)}</small></td><td>${escape(u.role)}<br><small>${escape(u.team||'Organization')}</small></td><td>${badge(u.status)}</td><td>${u.last_login?escape(new Date(u.last_login).toLocaleString()):'Never'}</td><td>${button('Manage','manage-user',u.id,'class="secondary"')}</td></tr>`))}${pag}</section>`;
    }
    if(current==='Audit log') {
      const events=await api('admin/audit');
      const {paged,page,totalPages,total,start}=paginate(events,pageState['Audit log']||1,20);
      pageState['Audit log']=page;
      const pag=renderPagination('Audit log',page,totalPages,total,start,20);
      html=heading('Administrative actions, authentication and hiring changes.')+`<section class="panel"><p class="muted">Latest 200 events. Earlier entries are available through the paginated audit API.</p>${table(['Time','Event','Actor','Target'],paged.map(e=>`<tr><td>${escape(new Date(e.at).toLocaleString())}</td><td>${escape(e.event)}</td><td class="mono">${escape(e.actor)}</td><td class="mono">${escape(e.target)}</td></tr>`))}${pag}</section>`;
    }
    if(current==='Settings') {
      html=heading('Make Orbit feel like your team’s workspace.')+`<section class="panel appearance-panel"><div class="panel-head"><div><h2>Appearance</h2><p class="muted">Choose a look that helps your team do their best work.</p></div><span class="subtle-label">${icon('Administration')} Admin controlled</span></div><form id="appearance-form"><fieldset class="theme-fieldset"><legend>Workspace theme</legend><div class="theme-grid">${appearance.themes.map(t=>`<label class="theme-option"><input type="radio" name="theme" value="${t.id}" ${t.id===appearance.theme?'checked':''}><span class="theme-thumbnail theme-${t.id}"><span class="mini-sidebar"><i></i><i></i><i></i></span><span class="mini-workspace"><span class="mini-topline"></span><span class="mini-metrics"><i></i><i></i><i></i></span><span class="mini-panel"><i></i><i></i><i></i></span></span><span class="theme-check" aria-hidden="true">✓</span></span><span class="theme-name">${t.name}</span><span class="theme-description">${t.description}</span></label>`).join('')}</div></fieldset><div class="theme-scope">${icon('Candidates')}<div><strong>One look, for the whole team</strong><p>The saved theme applies to every user and the sign-in screen. Existing sessions pick it up on their next page change or refresh.</p></div></div><p id="appearance-status" role="status" aria-live="polite" class="muted">${escape(appearance.themes.find(t=>t.id===appearance.theme).name)} is your saved workspace theme.</p><div class="settings-actions"><button type="button" class="secondary" data-action="reset-theme">Reset preview</button><button type="submit" id="save-theme" disabled>Save workspace theme</button></div></form></section><section class="panel brand-panel"><div><p class="eyebrow">OUR WORKSPACE</p><h2>Orbit, by Mechlin</h2><p class="muted">A place for people, possibility and your next great hire.</p></div><div class="brand-lockup"><img src="/mechlin-logo.webp" alt="Mechlin Technologies" width="174" height="40"></div></section>`;
    }
    if(current==='Pipeline settings') {const stages=await api('pipeline');html=heading('Define the sequence your hiring teams follow.')+`<section class="panel"><p>${stages.map(badge).join(' → ')}</p>${button('Edit stages','edit-pipeline')}<p class="muted">Applied must come first. Hired and Rejected are terminal stages. A stage in use cannot be removed.</p></section>`;}
    if(current==='Integrations') {const adapters=await api('integrations');html=heading('Connect external services as later phases are enabled.')+`<section class="panel">${table(['Capability','Availability','Delivery phase'],adapters.map(a=>`<tr><td><strong>${escape(a.name)}</strong></td><td>${badge(a.status)}</td><td>Phase ${a.phase}</td></tr>`))}</section><p class="muted">No messages, calendar events or candidate records are sent to external providers by these unconfigured interfaces.</p>`;}
    if(version===renderVersion && me){$('#main').innerHTML=html;document.title=`${current} · Orbit by Mechlin`;syncNavState();}
  }catch(e){if(me)$('#main').innerHTML=`<section class="panel"><h1>Could not load this view</h1><p class="error">${escape(e.message)}</p>${button('Try again','refresh')}</section>`;}
}
function reqTable(reqs) {return table(['Position','Team','Headcount','Status','Actions'],reqs.map(r=>`<tr><td><strong>${escape(r.title)}</strong><small>${escape(r.skills.join(', '))}</small></td><td>${escape(r.team)}</td><td>${r.headcount}</td><td>${badge(r.status)}</td><td><div class="actions">${button('Details','req-details',r.id,'class="secondary"')}${['draft','open'].includes(r.status)&&(allows('recruit')||allows('requisition'))?button('Edit','edit-req',r.id,'class="secondary"'):''}${r.status==='draft'&&(allows('recruit')||allows('requisition'))?button('Submit','submit-req',r.id):''}${(r.status==='pending_manager'&&allows('approve_manager')||r.status==='pending_finance'&&allows('approve_finance'))?button('Review','approve-req',r.id):''}</div></td></tr>`),'requisitions-table');}
function candidateTable(cs){return table(['Candidate','Skills','Source','Actions'],cs.map(c=>`<tr><td><div class="person-cell"><span class="avatar">${initials(c.name)}</span><div><strong>${escape(c.name)}</strong><small>${escape(c.email)}</small></div></div></td><td><div class="skill-list">${c.skills.map(s=>`<span class="skill-chip">${escape(s)}</span>`).join('')}</div></td><td>${escape(c.source)}</td><td><div class="actions">${button('View profile','candidate-details',c.id,'class="secondary"')}${allows('recruit')?button('Edit','edit-candidate',c.id,'class="secondary"'):''}</div></td></tr>`));}
document.addEventListener('change',event=>{
  if(event.target.matches('#appearance-form input[name="theme"]')){
    const chosen=event.target.value;applyTheme(chosen);$('#save-theme').disabled=chosen===appearance.theme;
    $('#appearance-status').textContent=chosen===appearance.theme?'Your saved theme is selected.':'Preview only. Save to apply this theme to the whole workspace.';
  }
});
document.addEventListener('submit',async event=>{
  if(event.target.id!=='appearance-form')return;event.preventDefault();const form=event.target,save=$('#save-theme');save.disabled=true;
  try{const result=await api('admin/appearance','PUT',{theme:new FormData(form).get('theme')});appearance=result;applyTheme(result.theme);await render();notice('Workspace theme saved for your team.');}
  catch(error){if($('#appearance-status')){$('#appearance-status').textContent=error.message;save.disabled=false;}}
});
document.addEventListener('click',async event=>{
  const b=event.target.closest('[data-action]');if(!b)return;const a=b.dataset.action,id=b.dataset.id;
  try {
    if(a==='req-page'||a==='page'){const view=b.dataset.view||'Requisitions';const p=Number(b.dataset.page);const total=Number(b.dataset.totalPages||Infinity);if(p>=1&&p<=total&&p!==(pageState[view]||1)){pageState[view]=p;reqPage=pageState.Requisitions;await render();}return;}
    if(a==='navigate'){if(current!==b.dataset.view){reqPage=1;pageState[b.dataset.view]=1;if(b.dataset.view==='Candidates')candidateQuery='';}current=b.dataset.view;await render();return;}
    if(a==='reset-theme'){applyTheme(appearance.theme);document.querySelector(`#appearance-form input[value="${appearance.theme}"]`).checked=true;$('#save-theme').disabled=true;$('#appearance-status').textContent='Preview reset to the saved workspace theme.';return;}
    if(a==='logout'){
      await api('logout','POST',{});
      me=null;
      try{
        sessionStorage.removeItem('orbit_current');
        sessionStorage.removeItem('orbit_pages');
        localStorage.removeItem('orbit_current');
        localStorage.removeItem('orbit_pages');
        history.replaceState(null,'',location.pathname);
      }catch{}
      current='Overview';
      login();
      return;
    }
    if(a==='refresh'){await render();return;}
    if(a==='new-req'){
      modal('New requisition',`<div class="form-grid">${field('Position title','title')}${field('Team','team','text',me.team)}${field('Headcount','headcount','number','1')}${field('Currency','currency','text','USD')}${field('Minimum annual salary','salary_min','number','0')}${field('Maximum annual salary','salary_max','number','0')}${field('Required skills, comma separated','skills','text','',false)}${area('Job description','description','',true)}</div>${button('Draft description from title & skills','draft-jd','','class="secondary"')}`,v=>{
        const cErr=checkCurrency(v.currency);
        if(cErr){
          const el=$('#currency-error');if(el)el.textContent=cErr;
          const inp=$('#edit-form [name="currency"]');if(inp){inp.setCustomValidity(cErr);inp.reportValidity();}
          throw new Error(cErr);
        }
        const sErr=checkSkills(v.skills);
        if(sErr){
          const el=$('#skills-error');if(el)el.textContent=sErr;
          const inp=$('#edit-form [name="skills"]');if(inp){inp.setCustomValidity(sErr);inp.reportValidity();}
          throw new Error(sErr);
        }
        return api('requisitions','POST',{...v,currency:v.currency.trim().toUpperCase(),headcount:Number(v.headcount),salary_min:Number(v.salary_min),salary_max:Number(v.salary_max),skills:skills(v.skills)});
      });
      bindValidation('currency',checkCurrency);
      bindValidation('skills',checkSkills);
    }
    if(a==='draft-jd'){
      const form=$('#edit-form');
      const sErr=checkSkills(form.elements.skills.value);
      if(sErr){
        const el=$('#skills-error');if(el)el.textContent=sErr;
        const inp=form.elements.skills;if(inp){inp.setCustomValidity(sErr);inp.reportValidity();}
        throw new Error(sErr);
      }
      const result=await api('jd/draft','POST',{title:form.elements.title.value,skills:skills(form.elements.skills.value)});
      form.elements.description.value=result.draft;notice(result.method);
    }
    if(a==='submit-req'){await api(`requisitions/${id}/submit`,'POST',{});notice('Submitted for manager approval.');await render();}
    if(a==='approve-req')modal('Review requisition',select('Decision','decision',['approve','reject'])+area('Decision note','note'),v=>api(`requisitions/${id}/${v.decision}`,'POST',{note:v.note}));
    if(a==='req-details'){const r=(await api('requisitions')).find(r=>r.id===id)||await api(`requisitions/${id}`);modal(r.title,`<p>${badge(r.status)} · ${escape(r.team)} · ${r.headcount} opening(s)</p>${r.salary_min!==undefined?`<p>${r.salary_min}–${r.salary_max} ${escape(r.currency)}</p>`:''}<p class="score-note">${escape(r.description)}</p>${['draft','open'].includes(r.status)&&(allows('recruit')||allows('requisition'))?`<div class="actions" style="margin-top:16px">${button('Edit','edit-req',r.id)}</div>`:''}`);}
    if(a==='edit-req'){
      const reqs=await api('requisitions');
      const r=reqs.find(item=>item.id===id)||await api(`requisitions/${id}`);
      if(!r)throw new Error('Requisition not found.');
      if(!['draft','open'].includes(r.status))throw new Error(`Cannot edit requisition with status ${r.status}.`);
      modal('Edit requisition',`<div class="form-grid">${field('Position title','title','text',r.title)}${field('Team','team','text',r.team)}${field('Headcount','headcount','number',String(r.headcount))}${field('Currency','currency','text',r.currency)}${field('Minimum annual salary','salary_min','number',String(r.salary_min??0))}${field('Maximum annual salary','salary_max','number',String(r.salary_max??0))}${field('Required skills, comma separated','skills','text',(r.skills||[]).join(', '),false)}${area('Job description','description',r.description,true)}</div>${button('Draft description from title & skills','draft-jd','','class="secondary"')}`,v=>{
        const cErr=checkCurrency(v.currency);
        if(cErr){
          const el=$('#currency-error');if(el)el.textContent=cErr;
          const inp=$('#edit-form [name="currency"]');if(inp){inp.setCustomValidity(cErr);inp.reportValidity();}
          throw new Error(cErr);
        }
        const sErr=checkSkills(v.skills);
        if(sErr){
          const el=$('#skills-error');if(el)el.textContent=sErr;
          const inp=$('#edit-form [name="skills"]');if(inp){inp.setCustomValidity(sErr);inp.reportValidity();}
          throw new Error(sErr);
        }
        return api(`requisitions/${id}`,'PUT',{...v,currency:v.currency.trim().toUpperCase(),headcount:Number(v.headcount),salary_min:Number(v.salary_min),salary_max:Number(v.salary_max),skills:skills(v.skills)});
      });
      bindValidation('currency',checkCurrency);
      bindValidation('skills',checkSkills);
    }
    if(a==='new-candidate'){
      modal('Add candidate',`<div class="form-grid">${field('Full name','name')}${field('Email','email','email')}${field('Phone','phone','tel','',false)}${field('Team','team','text',me.team)}${field('Skills, comma separated','skills','text','',false)}${field('Source','source','text','Direct')}${area('Experience / Resume text','resume_text')}</div>${button('Extract email and phone','parse-resume','','class="secondary"')}`,v=>{
        const err=checkPhone(v.phone);
        if(err){
          const el=$('#phone-error');if(el)el.textContent=err;
          const inp=$('#edit-form [name="phone"]');if(inp){inp.setCustomValidity(err);inp.reportValidity();}
          throw new Error(err);
        }
        const sErr=checkSkills(v.skills);
        if(sErr){
          const el=$('#skills-error');if(el)el.textContent=sErr;
          const inp=$('#edit-form [name="skills"]');if(inp){inp.setCustomValidity(sErr);inp.reportValidity();}
          throw new Error(sErr);
        }
        return api('candidates','POST',{...v,skills:skills(v.skills),experience:v.resume_text});
      });
      bindValidation('phone',checkPhone);
      bindValidation('skills',checkSkills);
    }
    if(a==='edit-candidate'){
      const c=(await api('candidates')).find(c=>c.id===id)||await api(`candidates/${id}`);
      if(!c)throw new Error('Candidate not found.');
      modal('Edit candidate',`<div class="form-grid">${field('Full name','name','text',c.name)}${field('Email','email','email',c.email)}${field('Phone','phone','tel',c.phone||'',false)}${field('Team','team','text',c.team||me.team)}${field('Skills, comma separated','skills','text',(c.skills||[]).join(', '),false)}${field('Source','source','text',c.source||'Direct')}${area('Experience / Resume text','resume_text',c.resume_text||c.experience||'')}</div>${button('Extract email and phone','parse-resume','','class="secondary"')}`,v=>{
        const err=checkPhone(v.phone);
        if(err){
          const el=$('#phone-error');if(el)el.textContent=err;
          const inp=$('#edit-form [name="phone"]');if(inp){inp.setCustomValidity(err);inp.reportValidity();}
          throw new Error(err);
        }
        const sErr=checkSkills(v.skills);
        if(sErr){
          const el=$('#skills-error');if(el)el.textContent=sErr;
          const inp=$('#edit-form [name="skills"]');if(inp){inp.setCustomValidity(sErr);inp.reportValidity();}
          throw new Error(sErr);
        }
        return api(`candidates/${id}`,'PUT',{...v,skills:skills(v.skills),experience:v.resume_text});
      });
      bindValidation('phone',checkPhone);
      bindValidation('skills',checkSkills);
    }
    if(a==='parse-resume'){const form=$('#edit-form');const r=await api('resume/parse','POST',{text:form.elements.resume_text.value});if(r.email)form.elements.email.value=r.email;if(r.phone){form.elements.phone.value=r.phone;form.elements.phone.dispatchEvent(new Event('input'));}notice(r.warning);}
    if(a==='candidate-details'){const c=(await api('candidates')).find(c=>c.id===id)||await api(`candidates/${id}`);modal(c.name,`<p>${escape(c.email)}${c.phone?` · ${escape(c.phone)}`:''}</p><p>${escape((c.skills||[]).join(', '))}</p><h3>Experience / Resume</h3><p class="score-note">${escape(c.resume_text||c.experience||'No resume text provided.')}</p>${allows('recruit')?`<div class="actions" style="margin-top:16px">${button('Edit','edit-candidate',c.id)}</div>`:''}`);}
    if(a==='new-application'){const [cs,rs]=await Promise.all([api('candidates'),api('requisitions')]);if(!cs.length||!rs.some(r=>r.status==='open'))throw new Error('Add a candidate and approve a requisition first.');modal('Add application',select('Candidate','candidate_id',cs.map(c=>[c.id,c.name]))+select('Open requisition','requisition_id',rs.filter(r=>r.status==='open').map(r=>[r.id,r.title])),v=>api('applications','POST',v));}
    if(a==='move'||a==='reject-app'){const stage=a==='move'?b.dataset.stage:'Rejected';modal('Change application stage',`<p>Move this application to <strong>${escape(stage)}</strong>?</p>`,()=>api(`applications/${id}/stage`,'POST',{stage}));}
    if(a==='match'){const r=await api(`applications/${id}/match`);modal('Skill match explanation',`<p class="eyebrow">${escape(r.method)}</p><h1>${r.score===null?'Unscored':r.score+'%'}</h1><p>${escape(r.explanation)}</p><h3>Matched</h3><p>${escape(r.matched.join(', ')||'None')}</p><h3>Not found in skills</h3><p>${escape(r.missing.join(', ')||'None')}</p><p class="muted">This does not assess ability, potential or suitability. Never use this score as an automatic rejection rule.</p>`);}
    if(a==='new-interview'){const [apps,users]=await Promise.all([api('applications'),api('interviewers')]);const active=apps.filter(a=>!['Hired','Rejected'].includes(a.stage));if(!active.length||!users.length)throw new Error('An active application and interviewer are required.');modal('Plan interview',select('Application','application_id',active.map(a=>[a.id,`${a.name} · ${a.title}`]))+select('Interviewer','interviewer_id',users.map(u=>[u.id,u.name]))+field('Date and time (your timezone)','scheduled_at','datetime-local')+field('Competencies, comma separated','competencies','text','Role knowledge, Problem solving')+'<p class="status-note">This stores an interview plan. It does not send a calendar invitation.</p>',v=>api('interviews','POST',{...v,scheduled_at:new Date(v.scheduled_at).toISOString(),competencies:skills(v.competencies)}));}
    if(a==='edit-interview'||a==='reschedule-interview'){
      const interviews=await api('interviews');
      const i=interviews.find(item=>item.id===id)||await api(`interviews/${id}`);
      if(!i)throw new Error('Interview not found.');
      const users=allows('recruit')?await api('interviewers'):[];
      const pad=n=>String(n).padStart(2,'0');
      const toLocal=s=>{const d=new Date(s);return isNaN(d.getTime())?'':`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;};
      const comps=JSON.parse(i.competencies||'[]');
      modal('Edit interview',`<div class="form-grid"><p class="full"><strong>Candidate:</strong> ${escape(i.name)} · ${escape(i.title)}</p>${users.length?select('Interviewer','interviewer_id',users.map(u=>[u.id,u.name]),i.interviewer_id):`<p class="full"><strong>Interviewer:</strong> ${escape(i.interviewer)}</p>`}${field('Date and time (your timezone)','scheduled_at','datetime-local',toLocal(i.scheduled_at))}${allows('recruit')?field('Competencies, comma separated','competencies','text',comps.join(', '),false):''}<p class="full status-note">This updates the scheduled interview date and time. It does not send a calendar invitation.</p></div>`,v=>{
        const scheduledDate=new Date(v.scheduled_at);
        if(!Number.isFinite(scheduledDate.getTime())||scheduledDate.getTime()<Date.now()){
          throw new Error('Enter a future interview date.');
        }
        let updatedComps;
        if(v.competencies!==undefined){
          updatedComps=skills(v.competencies);
          if(!updatedComps.length)throw new Error('At least one competency is required.');
        }
        const payload={
          scheduled_at:scheduledDate.toISOString(),
          ...(v.interviewer_id?{interviewer_id:v.interviewer_id}:{}),
          ...(updatedComps?{competencies:updatedComps}:{})
        };
        return api(`interviews/${id}`,'PUT',payload);
      });
    }
    if(a==='scorecard'){const i=(await api('interviews')).find(i=>i.id===id), comps=JSON.parse(i.competencies);modal('Submit independent feedback',comps.map((c,n)=>select(`${escape(c)} (1 low – 5 high)`,`rating${n}`,['1','2','3','4','5'],'3')).join('')+select('Recommendation','recommendation',['Strong yes','Yes','No','Strong no'])+area('Job-related evidence','notes','',true)+'<p class="muted">Submitted feedback is final in this phase. Other feedback stays hidden until you submit your assigned scorecards.</p>',v=>api(`interviews/${id}/scorecards`,'POST',{ratings:Object.fromEntries(comps.map((c,n)=>[c,Number(v[`rating${n}`])])),recommendation:v.recommendation,notes:v.notes}));}
    if(a==='feedback'){const r=await api(`interviews/${id}/scorecards`);modal('Interview feedback',`${r.blinded?'<div class="notice-inline">Other reviewers’ feedback is hidden until you submit all your assigned scorecards for this application.</div>':''}${r.scorecards.map(s=>`<article class="panel"><h3>${escape(s.recommendation)}</h3><p>${escape(Object.entries(JSON.parse(s.ratings)).map(([k,v])=>`${k}: ${v}/5`).join(' · '))}</p><p class="score-note">${escape(s.notes)}</p></article>`).join('')||empty('No feedback is available to you yet.')}`);}
    if(a==='new-referral'){const rs=(await api('requisitions')).filter(r=>r.status==='open');if(!rs.length)throw new Error('No open requisitions in your team.');modal('Make a referral',field('Candidate name','name')+field('Candidate email','email','email')+select('Open position','requisition_id',rs.map(r=>[r.id,r.title]))+area('Referral note','note'),v=>api('referrals','POST',v));}
    if(a==='new-user'){const roles=(await api('me')).roles.filter(r=>r!=='Agency');modal('Add Microsoft 365 user',field('Full name','name')+field('Microsoft email','email','email')+field('Entra object ID','oid')+field('Entra tenant ID','tenant')+select('Role','role',roles,'Employee/Referral')+field('Team','team','text','',false)+'<p class="muted">This grants approved access to the exact Entra identity. It does not create a Microsoft account or an ATS password.</p>',v=>api('admin/users','POST',v));}
    if(a==='manage-user'){const u=window.currentUsers.find(u=>u.id===id);const roles=(await api('me')).roles.filter(r=>r!=='Agency');const actions=u.status==='pending'?['approve','reject']:u.status==='active'?['update','disable','force-logout']:['reactivate','update'];modal(`Manage ${u.name}`,`<p>${escape(u.email)} · ${badge(u.status)}</p><p class="mono">Entra object: ${escape(u.oid)}</p>`+select('Action','action',actions)+select('Role','role',roles,u.role)+field('Team','team','text',u.team,false)+'<p class="muted">Access changes revoke all current ATS sessions.</p>',v=>api(`admin/users/${id}/${v.action}`,'POST',v));}
    if(a==='edit-pipeline'){const stages=await api('pipeline');modal('Edit pipeline',area('Stages, one per line','stages',stages.join('\n'),true),v=>api('pipeline','PUT',{stages:v.stages.split('\n').map(s=>s.trim()).filter(Boolean)}));}
  }catch(e){notice(e.message);}
});
window.addEventListener('hashchange',()=>{
  if(!me)return;
  const nav=getNavList();
  const target=parseNavFromHash(nav);
  if(target&&target!==current){
    current=target;
    render();
  }
});
window.addEventListener('offline',()=>notice('You are offline. Changes cannot be saved.'));
window.addEventListener('online',()=>notice('Connection restored.'));
(async()=>{try{const data=await api('me');me=data.user;csrf=data.csrf;permissions=data.permissions;loadSavedPages();const nav=getNavList();current=getSavedNav(nav);await render();}catch{login();}if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});})();
