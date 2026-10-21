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
const notice = (() => {
  const TOAST_DURATION = 2000;
  let activeToast = null;
  let lastToastKey = '';
  let lastToastTime = 0;

  const getContainer = () => {
    let n = document.getElementById('notice');
    if (!n) {
      n = document.createElement('div');
      n.id = 'notice';
      n.className = 'orbit-toast-container';
      n.setAttribute('role', 'region');
      n.setAttribute('aria-label', 'Notifications');
      document.body.appendChild(n);
    }
    const modalEl = document.getElementById('modal');
    if (modalEl?.open && n.parentElement !== modalEl) {
      modalEl.appendChild(n);
    } else if (!modalEl?.open && n.parentElement !== document.body && n.parentElement !== null) {
      document.body.appendChild(n);
    }
    return n;
  };

  const removeToast = (toastObj, animate = true) => {
    if (!toastObj) return;
    if (toastObj.timer) {
      clearTimeout(toastObj.timer);
      toastObj.timer = null;
    }
    const el = toastObj.element;
    if (activeToast === toastObj) {
      activeToast = null;
    }
    if (!el || !el.parentElement) return;

    if (!animate) {
      el.parentElement.removeChild(el);
      return;
    }

    if (toastObj.isDismissing) return;
    toastObj.isDismissing = true;
    el.classList.add('orbit-toast-exit');
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      el.removeEventListener('animationend', cleanup);
      if (el.parentElement) el.parentElement.removeChild(el);
    };
    el.addEventListener('animationend', cleanup);
    setTimeout(cleanup, 220);
  };

  const notify = (message, explicitType) => {
    if (!message) return;
    if (message instanceof Error) {
      message = message.message;
      explicitType = 'error';
    }
    const msgStr = String(message).trim();
    if (!msgStr) return;

    let type = explicitType;
    if (!type || (type !== 'success' && type !== 'error')) {
      const lower = msgStr.toLowerCase();
      const isError = [
        'error', 'failed', 'failure', 'fail', 'not found', 'invalid',
        'offline', 'denied', 'cannot', 'forbidden', 'rejected',
        'unauthorized', 'already exists', 'required', 'enter a'
      ].some(k => lower.includes(k));
      type = isError ? 'error' : 'success';
    }

    const now = Date.now();
    const key = `${type}:${msgStr}`;
    if (key === lastToastKey && (now - lastToastTime) < 500 && activeToast && !activeToast.isDismissing) {
      if (activeToast.timer) clearTimeout(activeToast.timer);
      activeToast.timer = setTimeout(() => removeToast(activeToast, true), TOAST_DURATION);
      return;
    }
    lastToastKey = key;
    lastToastTime = now;

    const container = getContainer();

    if (activeToast) {
      removeToast(activeToast, false);
    }
    container.textContent = '';

    const toastEl = document.createElement('div');
    toastEl.className = `orbit-toast orbit-toast-${type}`;
    toastEl.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toastEl.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

    const iconSpan = document.createElement('span');
    iconSpan.className = 'orbit-toast-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = type === 'success'
      ? '<svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>'
      : '<svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

    const msgSpan = document.createElement('span');
    msgSpan.className = 'orbit-toast-message';
    msgSpan.textContent = msgStr;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'orbit-toast-close';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.setAttribute('title', 'Dismiss');
    closeBtn.innerHTML = '<svg class="ui-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

    toastEl.appendChild(iconSpan);
    toastEl.appendChild(msgSpan);
    toastEl.appendChild(closeBtn);

    const toastObj = {
      key,
      element: toastEl,
      isDismissing: false,
      timer: null
    };

    closeBtn.onclick = (e) => {
      e.stopPropagation();
      removeToast(toastObj, true);
    };

    toastEl.addEventListener('mouseenter', () => {
      if (toastObj.timer) {
        clearTimeout(toastObj.timer);
        toastObj.timer = null;
      }
    });

    toastEl.addEventListener('mouseleave', () => {
      if (!toastObj.isDismissing && !toastObj.timer) {
        toastObj.timer = setTimeout(() => removeToast(toastObj, true), TOAST_DURATION);
      }
    });

    toastObj.timer = setTimeout(() => {
      removeToast(toastObj, true);
    }, TOAST_DURATION);

    container.appendChild(toastEl);
    activeToast = toastObj;
  };

  notify.clear = () => {
    if (activeToast) {
      removeToast(activeToast, false);
    }
  };

  return notify;
})();
async function api(path,method='GET',body) {
  const response=await fetch(`/api/${path}`,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf || ''},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok){if(response.status===401 && me){me=null;login();}throw new Error(data.error || 'Request failed.');}return data;
}
const badge = value => `<span class="badge ${escape(String(value).split('_')[0])}">${escape(String(value).replaceAll('_',' '))}</span>`;
const empty = message => `<div class="empty">${escape(message)}</div>`;
const button = (title,action,id='',extra='') => `<button type="button" data-action="${action}" data-id="${escape(id)}" ${extra}>${escape(title)}</button>`;
const table = (headers,rows,cls='') => rows.length?`<div class="table-wrap ${cls?cls+'-wrap':''}"><table class="${cls}"><thead><tr>${headers.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:empty('No records yet.');
const formatLabel = (label, required) => {
  if (typeof label !== 'string') return label;
  if (label.includes('field-required') || label.includes('field-optional')) return label;
  const clean = label.replace(/\s*\((?:optional|required)\)\s*$/i, '').replace(/\s*\*+\s*$/, '').trim();
  const indicator = required
    ? '<span class="field-required" title="Required" aria-hidden="true">*</span>'
    : '<span class="field-optional">Optional</span>';
  return `<span class="label-heading">${clean} ${indicator}</span>`;
};
const field = (label,name,type='text',value='',required=true,extra='') => `<label>${formatLabel(label, required)}<input name="${name}" type="${type}" value="${escape(value)}" ${required?'required aria-required="true"':''} ${extra}><span class="field-error error" id="${name}-error" role="alert"></span></label>`;
const area = (label,name,value='',required=false) => `<label class="full">${formatLabel(label, required)}<textarea name="${name}" ${required?'required aria-required="true"':''}>${escape(value)}</textarea></label>`;
const select = (label,name,values,selected='',required=true) => `<label>${formatLabel(label, required)}<select name="${name}" ${required?'required aria-required="true"':''}>${values.map(v=>{const [id,title]=Array.isArray(v)?v:[v,v];return `<option value="${escape(id)}" ${id===selected?'selected':''}>${escape(title)}</option>`;}).join('')}</select></label>`;
const standardTeams = ['Dev','QA','BD','DevOps','HR','Product','Design','Operations','Sales','Other','PM','TL'];
const teamSelect = (label,name,selected='',allowOrg=false) => {
  const options = [];
  if (allowOrg) options.push(['', 'Organization (No specific team)']);
  for (const t of standardTeams) options.push([t, t]);
  if (selected && selected !== '' && !standardTeams.includes(selected) && selected !== 'Engineering') {
    options.push([selected, selected]);
  }
  const required = !allowOrg;
  return `<label>${formatLabel(label, required)}<select name="${name}" ${required ? 'required aria-required="true"' : ''}>${options.map(([id, title]) => `<option value="${escape(id)}" ${id === selected ? 'selected' : ''}>${escape(title)}</option>`).join('')}</select></label>`;
};
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
const bindSalaryInput = (name) => {
  const inp = $(`#edit-form [name="${name}"]`);
  if (!inp) return;
  inp.addEventListener('keydown', e => {
    if (e.key.length === 1 && !/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
    }
  });
  inp.addEventListener('beforeinput', e => {
    if (e.data && /[^0-9]/.test(e.data)) {
      e.preventDefault();
    }
  });
  const handleInsert = (e, text) => {
    e.preventDefault();
    const clean = String(text || '').replace(/[^0-9]/g, '');
    if (document.activeElement === inp) {
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, clean);
      } catch {}
      if (inserted) return;
    }
    inp.value = clean;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  };
  inp.addEventListener('paste', e => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    handleInsert(e, text);
  });
  inp.addEventListener('drop', e => {
    const text = e.dataTransfer?.getData('text') || '';
    handleInsert(e, text);
  });
  inp.addEventListener('input', () => {
    if (/[^0-9]/.test(inp.value)) {
      inp.value = inp.value.replace(/[^0-9]/g, '');
    }
  });
};
const pad = n => String(n).padStart(2, '0');
const getLocalDateString = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const getLocalTodayMin = () => `${getLocalDateString()}T00:00`;
const checkEmail = v => { const s = String(v ?? '').trim(); return (!s || s.length > 254 || !/^[^\s@.]+(?:\.[^\s@.]+)*@[^\s@]+\.[^\s@]+$/.test(s)) ? 'Enter a valid email address.' : ''; };
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
  $('#modal-body').innerHTML=`<h2 tabindex="-1">${escape(title)}</h2>${onSubmit?`<form id="edit-form">${html}<p class="error" id="form-error" role="alert"></p><button type="submit">Save</button></form>`:html}`;
  if(onSubmit)$('#edit-form').onsubmit=async event=>{event.preventDefault();const submit=event.target.querySelector('[type=submit]');submit.disabled=true;try{const msg=await onSubmit(Object.fromEntries(new FormData(event.target)));closeModal();notice(typeof msg==='string'?msg:'Saved.','success');await render();}catch(e){$('#form-error').textContent=e.message;notice(e.message,'error');}finally{submit.disabled=false;}};
  $('#modal').showModal();
  const firstInput = $('#modal input:not([type=hidden]), #modal select, #modal textarea');
  if(firstInput) firstInput.focus(); else $('#modal-body h2')?.focus();
  if($('#notice')?.children.length)$('#modal').appendChild($('#notice'));
}
$('#close-modal').onclick=closeModal;
$('#modal').addEventListener('click',e=>{const r=$('#modal').getBoundingClientRect();if(e.clientY<r.top||e.clientY>r.bottom||e.clientX<r.left||e.clientX>r.right)closeModal();});
$('#modal').addEventListener('close',()=>{const n=$('#notice');if(n&&n.parentElement!==document.body)document.body.appendChild(n);});
async function openDemoModal(isSwitch=false){
  let demoMeta=window._demoMeta;
  if(!demoMeta){
    try{
      const res=await fetch('/auth/demo');
      demoMeta=await res.json();
      window._demoMeta=demoMeta;
    }catch{throw new Error('Demo login service is unavailable.');}
  }
  if(!demoMeta.demoLogin)throw new Error('Demo login is not enabled in this environment.');
  const roleList=demoMeta.roles||[];
  const teamList=demoMeta.teams||standardTeams;
  const currentRole=(isSwitch&&me?.role)||roleList[0]?.role||'Recruiter';
  const currentTeam=(isSwitch&&me?.team)||'Dev';
  const title=isSwitch?'Switch QA Demo Persona':'Demo / QA Sign In';
  const submitText=isSwitch?'Switch Persona':'Sign in as Demo User';
  const modalHtml=`<div class="form-grid"><div class="full demo-role-desc-box" id="demo-role-desc" style="background:var(--surface-alt);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:0.85rem;color:var(--ink);line-height:1.5;"></div>${select('Select Demo Role','role',roleList.map(r=>[r.role,`${r.role} — ${r.title}`]),currentRole)}<label class="full" id="demo-team-label">${formatLabel('Select Team', true)}<select name="team" id="demo-team-select"></select></label><p class="full muted" style="font-size:0.8rem;margin-top:4px;">${isSwitch?'Switching establishes a new verified demo session with permissions and team scope for the selected identity.':'Predefined QA identity with sample data. No Microsoft 365 credentials required.'}</p></div>`;
  modal(title,modalHtml,async vals=>{
    const role=vals.role, team=vals.team||'';
    if(isSwitch){
      const res=await fetch('/api/demo/switch',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf||''},body:JSON.stringify({role,team})});
      const data=await res.json();
      if(!res.ok)throw new Error(data.error||'Failed to switch demo persona.');
      csrf=data.csrf;
      me=data.user;
      const meData=await api('me');
      me=meData.user;
      permissions=meData.permissions;
      csrf=meData.csrf;
      candidateQuery='';
      reqPage=1;
      Object.keys(pageState).forEach(k=>pageState[k]=1);
      try{sessionStorage.removeItem('orbit_current');sessionStorage.removeItem('orbit_pages');localStorage.removeItem('orbit_current');localStorage.removeItem('orbit_pages');}catch{}
      const nav=getNavList();
      current=nav[0]||'Overview';
      return `Switched persona to ${me.role} · ${me.team||'Organization'}.`;
    }else{
      const res=await fetch('/auth/demo-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,team})});
      const data=await res.json();
      if(!res.ok)throw new Error(data.error||'Demo login failed.');
      csrf=data.csrf;
      me=data.user;
      const meData=await api('me');
      me=meData.user;
      permissions=meData.permissions;
      csrf=meData.csrf;
      loadSavedPages();
      const nav=getNavList();
      current=getSavedNav(nav);
      return `Signed in as ${me.name}.`;
    }
  });
  const submitBtn=$('#edit-form button[type="submit"]');
  if(submitBtn)submitBtn.textContent=submitText;
  const roleSelect=$('#edit-form [name="role"]');
  const teamSelectEl=$('#demo-team-select');
  const descEl=$('#demo-role-desc');
  const updateRoleState=()=>{
    const selectedRole=roleSelect.value;
    const roleInfo=roleList.find(r=>r.role===selectedRole);
    if(descEl)descEl.innerHTML=`<strong>${escape(roleInfo?.title||selectedRole)}:</strong> ${escape(roleInfo?.description||'')}`;
    const isOrgRole=['System Admin','TA Director'].includes(selectedRole);
    const options=[];
    if(isOrgRole)options.push(['','Organization (Org-wide access)']);
    for(const t of teamList)options.push([t,t]);
    teamSelectEl.innerHTML=options.map(([val,label])=>`<option value="${escape(val)}" ${val===currentTeam?'selected':''}>${escape(label)}</option>`).join('');
    const isRequired = !isOrgRole;
    if (isRequired) {
      teamSelectEl.setAttribute('required', '');
      teamSelectEl.setAttribute('aria-required', 'true');
    } else {
      teamSelectEl.removeAttribute('required');
      teamSelectEl.removeAttribute('aria-required');
    }
    const teamHeading = $('#demo-team-label .label-heading');
    if (teamHeading) {
      teamHeading.outerHTML = formatLabel('Select Team', isRequired);
    }
  };
  if(roleSelect&&teamSelectEl){roleSelect.onchange=updateRoleState;updateRoleState();}
}
function login() {
  const status=new URLSearchParams(location.search).get('access');
  const messages={pending:'Access pending approval. Your request has been sent to the ATS administrators. Sign in again after approval.',rejected:'Your access request was rejected. Contact your ATS administrator.',disabled:'Your access has been disabled. Contact your ATS administrator.'};
  const isDemoEnabled=document.documentElement.dataset.demoLogin==='true';
  applyTheme(appearance.theme);
  $('#app').innerHTML=`<div class="login"><section class="login-brand"><div>${brand()}</div><div class="login-message"><p class="eyebrow">People. Possibility. Orbit.</p><h1>Great teams<br>start with<br><em>great connections.</em></h1><p>A shared space for every step of your next great hire.</p><div class="login-steps"><span>Discover</span><span>Connect</span><span>Hire</span></div></div><p class="login-footer">A Mechlin product · Built for our people</p></section><main class="login-form" id="main"><div class="login-card"><span class="workspace-label">MECHLIN WORKSPACE</span><h1>Welcome to Orbit</h1><p class="muted">Your team’s next chapter starts here.</p>${messages[status]?`<div class="notice-inline">${messages[status]}</div>`:''}<a class="button microsoft-signin" href="/auth/login"><span class="microsoft-mark" aria-hidden="true"></span>Sign in with Microsoft 365</a><p class="muted">Use your Mechlin work account. New team members need administrator approval.</p>${isDemoEnabled?`<div class="demo-login-divider"><span>OR QA TESTING</span></div><button type="button" class="button secondary demo-signin-button" data-action="demo-login-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="margin-right:8px;"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4"/></svg>Demo / QA Login</button>`:''}<div class="login-access-note">${icon('Administration')}<span>Private workspace. Approved access only.</span></div></div></main></div>`;
}
function shell() {
  const nav=getNavList();
  if(!nav.includes(current))current=nav[0];
  const isDemoEnabled=document.documentElement.dataset.demoLogin==='true';
  const showQASwitch=Boolean(me?.isDemoUser||isDemoEnabled);
  $('#app').innerHTML=`<div class="layout"><aside class="sidebar"><div class="sidebar-brand">${brand()}</div><nav aria-label="Main navigation"><p class="nav-label">WORKSPACE</p>${nav.map(n=>`${n==='Administration'?'<p class="nav-label admin-label">MANAGE</p>':''}<button data-nav="${n}" class="${current===n?'active':''}" ${current===n?'aria-current="page"':''}>${icon(n)}<span>${n}</span></button>`).join('')}</nav><div class="profile"><span class="avatar">${initials(me.name)}</span><div><strong>${escape(me.name)}</strong><div class="muted">${escape(me.role)}${me.team?` · ${escape(me.team)}`:''}</div>${me.isDemoUser?'<span class="qa-badge">QA Demo User</span>':''}</div></div><div class="sidebar-caption">Mechlin Orbit · Internal workspace</div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb">Orbit <span>/</span> <strong>${escape(current)}</strong></div><div class="topbar-right">${showQASwitch?`<button type="button" class="secondary qa-switch-button" data-action="switch-demo-role" title="Switch QA Demo Persona">${icon('Administration')}<span>Switch QA Role</span></button>`:''}<span class="workspace-status">${icon('Administration')} Private workspace</span><button class="secondary" data-action="logout">Sign out</button><span class="avatar small" aria-label="${escape(me.name)}">${initials(me.name)}</span></div></header><main class="content" id="main" tabindex="-1"><p class="muted">Loading your workspace…</p></main><footer class="workspace-footer">Thoughtful hiring, together. <span>Orbit by Mechlin</span></footer></div></div>`;
  document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{if(current!==b.dataset.nav){reqPage=1;pageState[b.dataset.nav]=1;if(b.dataset.nav==='Candidates')candidateQuery='';}current=b.dataset.nav;render();});
}
function syncPipelineScroll(initialLeft = 0) {
  const board = $('#pipeline-board') || document.querySelector('.board');
  if (!board) return;
  const bottomScroll = $('#pipeline-bottom-scroll');
  if (initialLeft > 0) board.scrollLeft = initialLeft;
  const update = () => {
    const sw = board.scrollWidth, cw = board.clientWidth, scrollable = sw > cw + 1;
    const track = bottomScroll ? bottomScroll.querySelector('.pipeline-scroll-track') : null;
    if (track) track.style.width = sw + 'px';
    if (bottomScroll) {
      bottomScroll.style.display = scrollable ? 'block' : 'none';
      bottomScroll.scrollLeft = board.scrollLeft;
    }
  };
  update();
  requestAnimationFrame(update);
  setTimeout(update, 60);
  let lock = false;
  const sync = (src, target) => {
    if (lock) return;
    lock = true;
    try {
      if (target) target.scrollLeft = src.scrollLeft;
    } finally {
      lock = false;
    }
  };
  board.onscroll = () => sync(board, bottomScroll);
  if (bottomScroll) bottomScroll.onscroll = () => sync(bottomScroll, board);
}
window.addEventListener('resize', () => { if (current === 'Pipeline') syncPipelineScroll(); }, { passive: true });

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
        const filtered=q?candidates.filter(c=>{
          const appText=(c.applications||[]).map(a=>`${a.title} ${a.stage}`).join(' ');
          return `${c.name} ${c.email} ${c.skills} ${c.resume_text} ${appText}`.toLowerCase().includes(q);
        }):candidates;
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
      const [apps,stages]=await Promise.all([api('applications'),api('pipeline')]);
      html=heading('Move each application through a consistent hiring process.',allows('recruit')?button('+ Add application','new-application'):'')+
      `<div class="pipeline-wrapper">`+
        `<div class="board" id="pipeline-board">${stages.map((stage,index)=>`<section class="column${['Hired','Rejected'].includes(stage)?' column-terminal':''}" data-stage="${escape(stage)}"><h2>${escape(stage)} <span>${apps.filter(a=>a.stage===stage).length}</span></h2><div class="column-content">${apps.filter(a=>a.stage===stage).map(a=>`<article class="card"><h3>${escape(a.name)}</h3><p class="muted card-role" title="${escape(a.title)}">${escape(a.title)}</p><div class="actions">${button('Skill match','match',a.id,'class="secondary"')}${allows('recruit')&&!['Hired','Rejected'].includes(stage)?(index>0?button(`Back to ${stages[index-1]}`,'move',a.id,`data-stage="${escape(stages[index-1])}" class="secondary"`):'')+button(`Move to ${stages[index+1]}`,'move',a.id,`data-stage="${escape(stages[index+1])}"`)+button('Reject','reject-app',a.id,'class="secondary"'):''}</div></article>`).join('')||'<p class="muted column-empty">No applications</p>'}</div></section>`).join('')}</div>`+
        `<div class="pipeline-scroll-bar pipeline-scroll-bottom" id="pipeline-bottom-scroll" aria-label="Horizontal scroll sticky at bottom of screen"><div class="pipeline-scroll-track"></div></div>`+
      `</div>`;
    }
    if(current==='Interviews') {
      const interviews=await api('interviews');
      const {paged,page,totalPages,total,start}=paginate(interviews,pageState.Interviews||1,10);
      pageState.Interviews=page;
      const pag=renderPagination('Interviews',page,totalPages,total,start,10);
      html=heading('Structured interviews, independent feedback.',allows('recruit')?button('+ Plan interview','new-interview'):'')+`<div class="notice-inline">Interview plans are stored here. Calendar invitations and Teams/Meet links require a calendar adapter.</div><section class="panel">${table(['Candidate / role','Interviewer','Scheduled','Status','Feedback'],paged.map(i=>`<tr><td><strong>${escape(i.name)}</strong>${escape(i.title)}</td><td>${escape(i.interviewer)}</td><td>${escape(new Date(i.scheduled_at).toLocaleString())}</td><td>${badge(i.status)}</td><td><div class="actions">${i.interviewer_id===me.id&&i.status!=='completed'?button('Submit scorecard','scorecard',i.id):''}${allows('admin')&&i.interviewer_id!==me.id&&i.status!=='completed'?button('Proxy scorecard','scorecard-proxy',i.id,'class="secondary"'):''}${i.status!=='completed'&&(allows('recruit')||allows('admin')||i.interviewer_id===me.id)?button('Edit','edit-interview',i.id,'class="secondary"'):''}${button('View feedback','feedback',i.id,'class="secondary"')}</div></td></tr>`))}${pag}</section>`;
    }
    if(current==='Referrals') {
      const refs=await api('referrals');
      const {paged,page,totalPages,total,start}=paginate(refs,pageState.Referrals||1,10);
      pageState.Referrals=page;
      const pag=renderPagination('Referrals',page,totalPages,total,start,10);
      html=heading(allows('admin')?'Organization employee referrals.':'Recommend a colleague for an open position.',button('+ Make referral','new-referral'))+`<section class="panel"><h2>${allows('admin')?'All referrals':'Your referrals'}</h2>${table(allows('admin')?['Candidate','Email','Referred','Referrer']:['Candidate','Email','Referred'],paged.map(r=>`<tr><td>${escape(r.name)}</td><td>${escape(r.email)}</td><td>${escape(new Date(r.at).toLocaleDateString())}</td>${allows('admin')?`<td>${escape(r.referrer_name||'You')}</td>`:''}</tr>`))}${pag}</section>`;
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
    if(version===renderVersion && me){
      const prevBoardLeft = (current === 'Pipeline' && $('#pipeline-board')) ? $('#pipeline-board').scrollLeft : 0;
      $('#main').innerHTML=html;
      document.title=`${current} · Orbit by Mechlin`;
      syncNavState();
      if(current === 'Pipeline') syncPipelineScroll(prevBoardLeft);
    }
  }catch(e){if(me)$('#main').innerHTML=`<section class="panel"><h1>Could not load this view</h1><p class="error">${escape(e.message)}</p>${button('Try again','refresh')}</section>`;}
}
function reqTable(reqs) {return table(['Position','Team','Headcount','Status','Actions'],reqs.map(r=>{
  const canReviewManager = r.status==='pending_manager' && allows('approve_manager') && (r.created_by !== me?.id || allows('admin'));
  const canReviewFinance = r.status==='pending_finance' && allows('approve_finance') && (r.created_by !== me?.id || allows('admin'));
  return `<tr><td><strong>${escape(r.title)}</strong><small>${escape(r.skills.join(', '))}</small></td><td>${escape(r.team)}</td><td>${r.headcount}</td><td>${badge(r.status)}</td><td><div class="actions">${button('Details','req-details',r.id,'class="secondary"')}${['draft','open'].includes(r.status)&&(allows('recruit')||allows('requisition'))?button('Edit','edit-req',r.id,'class="secondary"'):''}${r.status==='draft'&&(allows('recruit')||allows('requisition'))?button('Submit','submit-req',r.id):''}${(canReviewManager||canReviewFinance)?button('Review','approve-req',r.id):''}</div></td></tr>`;
}),'requisitions-table');}
function candidateStatusCell(c){
  if(!c.applications||!c.applications.length)return '<span class="muted">No applications</span>';
  return `<div class="candidate-status-list">${c.applications.map(a=>{
    const title=escape(a.title||'General Application');
    return `<div class="candidate-status-pair"><span class="candidate-status-role" title="${title}">${title}</span> <span class="status-sep" aria-hidden="true">—</span> ${badge(a.stage||'Applied')}</div>`;
  }).join('')}</div>`;
}
function candidateTable(cs){return table(['Candidate','Skills','Source','Status','Actions'],cs.map(c=>`<tr><td><div class="person-cell"><span class="avatar">${initials(c.name)}</span><div><strong title="${escape(c.name)}">${escape(c.name)}</strong><small title="${escape(c.email)}">${escape(c.email)}</small></div></div></td><td><div class="skill-list">${c.skills.map(s=>`<span class="skill-chip" title="${escape(s)}">${escape(s)}</span>`).join('')}</div></td><td><span title="${escape(c.source)}">${escape(c.source)}</span></td><td>${candidateStatusCell(c)}</td><td><div class="actions">${button('View profile','candidate-details',c.id,'class="secondary"')}${allows('recruit')?button('Edit','edit-candidate',c.id,'class="secondary"'):''}</div></td></tr>`),'candidates-table');}
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
    if(a==='demo-login-modal'){await openDemoModal(false);return;}
    if(a==='switch-demo-role'){await openDemoModal(true);return;}
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
      modal('New requisition',`<div class="form-grid">${field('Position title','title')}${teamSelect('Team','team',me.team||'Dev',false)}${field('Headcount','headcount','number','1')}${field('Currency','currency','text','USD')}${field('Minimum annual salary','salary_min','number','0')}${field('Maximum annual salary','salary_max','number','0')}${field('Required skills, comma separated','skills','text','',false)}${area('Job description','description','',true)}</div>${button('Draft description from title & skills','draft-jd','','class="secondary"')}`,async v=>{
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
        await api('requisitions','POST',{...v,currency:v.currency.trim().toUpperCase(),headcount:Number(v.headcount),salary_min:Number(v.salary_min),salary_max:Number(v.salary_max),skills:skills(v.skills)});
        return 'Requisition created successfully.';
      });
      bindValidation('currency',checkCurrency);
      bindValidation('skills',checkSkills);
      bindSalaryInput('salary_min');
      bindSalaryInput('salary_max');
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
      form.elements.description.value=result.draft;notice(result.method||'Job description draft generated successfully.','success');
    }
    if(a==='submit-req'){await api(`requisitions/${id}/submit`,'POST',{});notice('Submitted for manager approval.','success');await render();}
    if(a==='approve-req'){
      const isAdmin = allows('admin');
      const reqs = await api('requisitions');
      const r = reqs.find(item => item.id === id) || await api(`requisitions/${id}`);
      if(r && r.created_by === me?.id && !isAdmin){
        throw new Error('Requester and each approver must be different people.');
      }
      if(!r || !['pending_manager','pending_finance'].includes(r.status)){
        throw new Error('Requisition is not awaiting approval.');
      }
      if(r.status === 'pending_manager' && !allows('approve_manager') && !isAdmin){
        throw new Error('Your role cannot perform this action.');
      }
      if(r.status === 'pending_finance' && !allows('approve_finance') && !isAdmin){
        throw new Error('Your role cannot perform this action.');
      }
      const summaryCard = r ? `
        <div style="background:var(--surface-alt);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:16px;">
          <div style="font-weight:600;font-size:1.05rem;color:var(--ink);">${escape(r.title)}</div>
          <div style="display:flex;gap:12px;margin-top:6px;font-size:0.82rem;color:var(--muted);align-items:center;flex-wrap:wrap;">
            <span>Team: <strong>${escape(r.team)}</strong></span>
            <span>·</span>
            <span>Headcount: <strong>${r.headcount}</strong></span>
            <span>·</span>
            <span>Stage: ${badge(r.status)}</span>
          </div>
        </div>` : '';

      const adminNotice = isAdmin ? `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;background:var(--tint);border:1px solid #7cdbef40;border-radius:8px;color:var(--accent);font-size:0.83rem;margin-bottom:16px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:1px;"><path d="M12 3l8 4v6c0 4-4 7-8 9-4-2-8-5-8-9V7z"/><path d="M9 12l2 2 4-4"/></svg>
          <div><strong>System Admin:</strong> Direct override authority is active. You can approve or reject this requisition directly.</div>
        </div>` : '';

      modal('Review requisition',
        summaryCard +
        adminNotice +
        select('Decision', 'decision', [['approve', '✓ Approve requisition'], ['reject', '✕ Reject requisition']], 'approve') +
        area('Decision note', 'note', ''),
        async v => {
          const payload = { note: v.note };
          if (isAdmin) {
            payload.admin_override = true;
            payload.emergency_override = true;
            payload.override_reason = v.note || 'System Admin direct approval override';
          }
          await api(`requisitions/${id}/${v.decision}`, 'POST', payload);
          return v.decision === 'approve' ? 'Requisition approved successfully.' : 'Requisition rejected.';
        }
      );
    }
    if(a==='req-details'){const r=(await api('requisitions')).find(r=>r.id===id)||await api(`requisitions/${id}`);modal(r.title,`<p>${badge(r.status)} · ${escape(r.team)} · ${r.headcount} opening(s)</p>${r.salary_min!==undefined?`<p>${r.salary_min}–${r.salary_max} ${escape(r.currency)}</p>`:''}<p class="score-note">${escape(r.description)}</p>${((['draft','open'].includes(r.status)||(allows('admin')&&['pending_manager','pending_finance'].includes(r.status)))&&(allows('recruit')||allows('requisition')))?`<div class="actions" style="margin-top:16px">${button('Edit','edit-req',r.id)}</div>`:''}`);}
    if(a==='edit-req'){
      const reqs=await api('requisitions');
      const r=reqs.find(item=>item.id===id)||await api(`requisitions/${id}`);
      if(!r)throw new Error('Requisition not found.');
      if(!['draft','open'].includes(r.status)&&!(allows('admin')&&['pending_manager','pending_finance'].includes(r.status)))throw new Error(`Cannot edit requisition with status ${r.status}.`);
      modal('Edit requisition',`<div class="form-grid">${field('Position title','title','text',r.title)}${teamSelect('Team','team',r.team||'Dev',false)}${field('Headcount','headcount','number',String(r.headcount))}${field('Currency','currency','text',r.currency)}${field('Minimum annual salary','salary_min','number',String(r.salary_min??0))}${field('Maximum annual salary','salary_max','number',String(r.salary_max??0))}${field('Required skills, comma separated','skills','text',(r.skills||[]).join(', '),false)}${area('Job description','description',r.description,true)}</div>${button('Draft description from title & skills','draft-jd','','class="secondary"')}`,async v=>{
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
        const payload = {...v,currency:v.currency.trim().toUpperCase(),headcount:Number(v.headcount),salary_min:Number(v.salary_min),salary_max:Number(v.salary_max),skills:skills(v.skills)};
        if(allows('admin')) payload.admin_override = true;
        await api(`requisitions/${id}`,'PUT',payload);
        return 'Requisition updated successfully.';
      });
      bindValidation('currency',checkCurrency);
      bindValidation('skills',checkSkills);
      bindSalaryInput('salary_min');
      bindSalaryInput('salary_max');
    }
    if(a==='new-candidate'){
      modal('Add candidate',`<div class="form-grid">${field('Full name','name')}${field('Email','email','email')}${field('Phone','phone','tel','',false)}${teamSelect('Team','team',me.team||'Dev',false)}${field('Skills, comma separated','skills','text','',false)}${field('Source','source','text','Direct')}${area('Experience / Resume text','resume_text')}</div>${button('Extract email and phone','parse-resume','','class="secondary"')}`,async v=>{
        const eErr=checkEmail(v.email);
        if(eErr){
          const el=$('#email-error');if(el)el.textContent=eErr;
          const inp=$('#edit-form [name="email"]');if(inp){inp.setCustomValidity(eErr);inp.reportValidity();}
          throw new Error(eErr);
        }
        const err=checkPhone(v.phone);
        if(err){
          const el=$('#phone-error');if(el)el.textContent=err;
          throw new Error(err);
        }
        const sErr=checkSkills(v.skills);
        if(sErr){
          const el=$('#skills-error');if(el)el.textContent=sErr;
          const inp=$('#edit-form [name="skills"]');if(inp){inp.setCustomValidity(sErr);inp.reportValidity();}
          throw new Error(sErr);
        }
        await api('candidates','POST',{...v,skills:skills(v.skills),experience:v.resume_text});
        return 'Candidate created successfully.';
      });
      bindValidation('email',checkEmail);
      bindValidation('phone',checkPhone);
      bindValidation('skills',checkSkills);
    }
    if(a==='edit-candidate'){
      const c=(await api('candidates')).find(c=>c.id===id)||await api(`candidates/${id}`);
      if(!c)throw new Error('Candidate not found.');
      modal('Edit candidate',`<div class="form-grid">${field('Full name','name','text',c.name)}${field('Email','email','email',c.email)}${field('Phone','phone','tel',c.phone||'',false)}${teamSelect('Team','team',c.team||me.team||'Dev',false)}${field('Skills, comma separated','skills','text',(c.skills||[]).join(', '),false)}${field('Source','source','text',c.source||'Direct')}${area('Experience / Resume text','resume_text',c.resume_text||c.experience||'')}</div>${button('Extract email and phone','parse-resume','','class="secondary"')}`,async v=>{
        const eErr=checkEmail(v.email);
        if(eErr){
          const el=$('#email-error');if(el)el.textContent=eErr;
          const inp=$('#edit-form [name="email"]');if(inp){inp.setCustomValidity(eErr);inp.reportValidity();}
          throw new Error(eErr);
        }
        const err=checkPhone(v.phone);
        if(err){
          const el=$('#phone-error');if(el)el.textContent=err;
          throw new Error(err);
        }
        const sErr=checkSkills(v.skills);
        if(sErr){
          const el=$('#skills-error');if(el)el.textContent=sErr;
          const inp=$('#edit-form [name="skills"]');if(inp){inp.setCustomValidity(sErr);inp.reportValidity();}
          throw new Error(sErr);
        }
        await api(`candidates/${id}`,'PUT',{...v,skills:skills(v.skills),experience:v.resume_text});
        return 'Candidate updated successfully.';
      });
      bindValidation('email',checkEmail);
      bindValidation('phone',checkPhone);
      bindValidation('skills',checkSkills);
    }
    if(a==='parse-resume'){
      const form=$('#edit-form');
      const r=await api('resume/parse','POST',{text:form.elements.resume_text.value});
      if(r.email){form.elements.email.value=r.email;form.elements.email.dispatchEvent(new Event('input'));}
      if(r.phone){form.elements.phone.value=r.phone;form.elements.phone.dispatchEvent(new Event('input'));}
      const hasExtracted=Boolean(r.email||r.phone);
      notice(hasExtracted?'Email and phone number extracted successfully.':(r.message||'No email or phone number found in resume text.'),hasExtracted?'success':'error');
    }
    if(a==='candidate-details'){const c=(await api('candidates')).find(c=>c.id===id)||await api(`candidates/${id}`);const appsHtml=(c.applications&&c.applications.length)?`<h3>Applications & Status</h3><div class="candidate-status-list" style="margin-bottom:14px;">${c.applications.map(app=>{const title=escape(app.title||'General Application');return `<div class="candidate-status-pair"><span class="candidate-status-role" title="${title}">${title}</span> <span class="status-sep" aria-hidden="true">—</span> ${badge(app.stage||'Applied')}</div>`;}).join('')}</div>`:'';modal(c.name,`<p>${escape(c.email)}${c.phone?` · ${escape(c.phone)}`:''}</p><p>${escape((c.skills||[]).join(', '))}</p>${appsHtml}<h3>Experience / Resume</h3><p class="score-note">${escape(c.resume_text||c.experience||'No resume text provided.')}</p>${allows('recruit')?`<div class="actions" style="margin-top:16px">${button('Edit','edit-candidate',c.id)}</div>`:''}`);}
    if(a==='new-application'){const [cs,rs]=await Promise.all([api('candidates'),api('requisitions')]);if(!cs.length||!rs.some(r=>r.status==='open'))throw new Error('Add a candidate and approve a requisition first.');modal('Add application',select('Candidate','candidate_id',cs.map(c=>[c.id,c.name]))+select('Open requisition','requisition_id',rs.filter(r=>r.status==='open').map(r=>[r.id,r.title])),async v=>{await api('applications','POST',v);return 'Application created successfully.';});}
    if(a==='move'||a==='reject-app'){const stage=a==='move'?b.dataset.stage:'Rejected';modal('Change application stage',`<p>Move this application to <strong>${escape(stage)}</strong>?</p>`,async ()=>{await api(`applications/${id}/stage`,'POST',{stage});return stage==='Rejected'?'Application rejected.':`Application moved to ${stage} successfully.`;});}
    if(a==='match'){const r=await api(`applications/${id}/match`);modal('Skill match explanation',`<p class="eyebrow">${escape(r.method)}</p><h1>${r.score===null?'Unscored':r.score+'%'}</h1><p>${escape(r.explanation)}</p><h3>Matched</h3><p>${escape(r.matched.join(', ')||'None')}</p><h3>Not found in skills</h3><p>${escape(r.missing.join(', ')||'None')}</p><p class="muted">This does not assess ability, potential or suitability. Never use this score as an automatic rejection rule.</p>`);}
    if(a==='new-interview'){const [apps,users]=await Promise.all([api('applications'),api('interviewers')]);const active=apps.filter(a=>!['Hired','Rejected'].includes(a.stage));if(!active.length||!users.length)throw new Error('An active application and interviewer are required.');const todayMin=getLocalTodayMin();modal('Plan interview',select('Application','application_id',active.map(a=>[a.id,`${a.name} · ${a.title}`]))+select('Interviewer','interviewer_id',users.map(u=>[u.id,u.name]))+field('Date and time (your timezone)','scheduled_at','datetime-local','',true,`min="${todayMin}"`)+field('Competencies, comma separated','competencies','text','Role knowledge, Problem solving')+'<p class="status-note">This stores an interview plan. It does not send a calendar invitation.</p>',async v=>{const scheduledDate=new Date(v.scheduled_at);if(!Number.isFinite(scheduledDate.getTime())||scheduledDate.getTime()<Date.now()){throw new Error('Enter a future interview date.');}await api('interviews','POST',{...v,scheduled_at:scheduledDate.toISOString(),competencies:skills(v.competencies)});return 'Interview scheduled successfully.';});const dateInp=$('#edit-form [name="scheduled_at"]');if(dateInp)dateInp.min=todayMin;}
    if(a==='edit-interview'||a==='reschedule-interview'){
      const interviews=await api('interviews');
      const i=interviews.find(item=>item.id===id)||await api(`interviews/${id}`);
      if(!i)throw new Error('Interview not found.');
      const canManage=allows('recruit')||allows('admin');
      const users=canManage?await api('interviewers'):[];
      const toLocal=s=>{const d=new Date(s);return isNaN(d.getTime())?'':`${getLocalDateString(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;};
      const comps=JSON.parse(i.competencies||'[]');
      const interviewerOptions = users.map(u=>[u.id,u.name]);
      if(i.interviewer_id && !interviewerOptions.some(([uid])=>uid===i.interviewer_id)){
        interviewerOptions.unshift([i.interviewer_id, `${i.interviewer || 'Assigned interviewer'} (Current)`]);
      }
      const todayMin=getLocalTodayMin();
      modal('Edit interview',`<div class="form-grid"><p class="full"><strong>Candidate:</strong> ${escape(i.name)} · ${escape(i.title)}</p>${interviewerOptions.length?select('Interviewer','interviewer_id',interviewerOptions,i.interviewer_id):`<p class="full"><strong>Interviewer:</strong> ${escape(i.interviewer)}</p>`}${field('Date and time (your timezone)','scheduled_at','datetime-local',toLocal(i.scheduled_at),true,`min="${todayMin}"`)}${canManage?field('Competencies, comma separated','competencies','text',comps.join(', '),true):''}<p class="full status-note">This updates the scheduled interview date and time. It does not send a calendar invitation.</p></div>`,async v=>{
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
        await api(`interviews/${id}`,'PUT',payload);
        return 'Interview updated successfully.';
      });
    }
    if(a==='scorecard'){const i=(await api('interviews')).find(i=>i.id===id), comps=JSON.parse(i.competencies);modal('Submit independent feedback',comps.map((c,n)=>select(`${escape(c)} (1 low – 5 high)`,`rating${n}`,['1','2','3','4','5'],'3')).join('')+select('Recommendation','recommendation',['Strong yes','Yes','No','Strong no'])+area('Job-related evidence','notes','',true)+'<p class="muted">Submitted feedback is final in this phase. Other feedback stays hidden until you submit your assigned scorecards.</p>',async v=>{await api(`interviews/${id}/scorecards`,'POST',{ratings:Object.fromEntries(comps.map((c,n)=>[c,Number(v[`rating${n}`])])),recommendation:v.recommendation,notes:v.notes});return 'Scorecard submitted successfully.';});}
    if(a==='scorecard-proxy'){
      const i=(await api('interviews')).find(i=>i.id===id)||await api(`interviews/${id}`);
      const comps=JSON.parse(i.competencies);
      modal(`Submit proxy scorecard on behalf of ${escape(i.interviewer)}`,`<div class="notice-inline"><strong>Administrative Proxy Submission:</strong> You are submitting this scorecard on behalf of the assigned interviewer (${escape(i.interviewer)}). An audit log entry will record your action and reason.</div>`+comps.map((c,n)=>select(`${escape(c)} (1 low – 5 high)`,`rating${n}`,['1','2','3','4','5'],'3')).join('')+select('Recommendation','recommendation',['Strong yes','Yes','No','Strong no'])+area('Job-related evidence','notes','',true)+area('Reason for proxy submission','proxy_reason','',true),async v=>{
        if(!v.proxy_reason||!v.proxy_reason.trim())throw new Error('A reason for proxy submission is required.');
        await api(`interviews/${id}/scorecards`,'POST',{ratings:Object.fromEntries(comps.map((c,n)=>[c,Number(v[`rating${n}`])])),recommendation:v.recommendation,notes:v.notes,proxy_reason:v.proxy_reason});
        return 'Proxy scorecard submitted successfully.';
      });
    }
    if(a==='feedback'){
      const r=await api(`interviews/${id}/scorecards`);
      modal('Interview feedback',`${r.blinded?'<div class="notice-inline">Other reviewers’ feedback is hidden until you submit all your assigned scorecards for this application.</div>':''}${r.scorecards.map(s=>`<article class="panel"><h3>${escape(s.recommendation)}</h3>${s.proxy_for?`<p class="muted" style="margin-bottom:6px"><strong>Proxy Submission:</strong> Submitted by ${escape(s.author_name||'Administrator')} on behalf of ${escape(s.proxy_for_name||'Interviewer')}${s.proxy_reason?` · Reason: ${escape(s.proxy_reason)}`:''}</p>`:(s.author_name?`<p class="muted" style="margin-bottom:6px">By: ${escape(s.author_name)}</p>`:'')}<p>${escape(Object.entries(JSON.parse(s.ratings)).map(([k,v])=>`${k}: ${v}/5`).join(' · '))}</p><p class="score-note">${escape(s.notes)}</p></article>`).join('')||empty('No feedback is available to you yet.')}`);
    }
    if(a==='new-referral'){const rs=(await api('requisitions')).filter(r=>r.status==='open');if(!rs.length)throw new Error('No open requisitions in your team.');modal('Make a referral',field('Candidate name','name')+field('Candidate email','email','email')+select('Open position','requisition_id',rs.map(r=>[r.id,r.title]))+area('Referral note','note'),async v=>{await api('referrals','POST',v);return 'Referral submitted successfully.';});}
    if(a==='new-user'){const roles=(await api('me')).roles.filter(r=>r!=='Agency');modal('Add Microsoft 365 user',field('Full name','name')+field('Microsoft email','email','email')+field('Entra object ID','oid')+field('Entra tenant ID','tenant')+select('Role','role',roles,'Employee/Referral')+teamSelect('Team','team','',true)+'<p class="muted">This grants approved access to the exact Entra identity. It does not create a Microsoft account or an ATS password.</p>',async v=>{await api('admin/users','POST',v);return 'User provisioned successfully.';});}
    if(a==='manage-user'){const u=window.currentUsers.find(u=>u.id===id);const roles=(await api('me')).roles.filter(r=>r!=='Agency');const actions=u.status==='pending'?['approve','reject']:u.status==='active'?['update','disable','force-logout']:['reactivate','update'];modal(`Manage ${u.name}`,`<p>${escape(u.email)} · ${badge(u.status)}</p><p class="mono">Entra object: ${escape(u.oid)}</p>`+select('Action','action',actions)+select('Role','role',roles,u.role)+teamSelect('Team','team',u.team||'',true)+'<p class="muted">Access changes revoke all current ATS sessions.</p>',async v=>{await api(`admin/users/${id}/${v.action}`,'POST',v);return `User ${v.action} completed successfully.`;});}
    if(a==='edit-pipeline'){const stages=await api('pipeline');modal('Edit pipeline',area('Stages, one per line','stages',stages.join('\n'),true),async v=>{await api('pipeline','PUT',{stages:v.stages.split('\n').map(s=>s.trim()).filter(Boolean)});return 'Pipeline updated successfully.';});}
  }catch(e){notice(e.message,'error');}
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
window.addEventListener('offline',()=>notice('You are offline. Changes cannot be saved.','error'));
window.addEventListener('online',()=>notice('Connection restored.','success'));
(async()=>{try{const data=await api('me');me=data.user;csrf=data.csrf;permissions=data.permissions;loadSavedPages();const nav=getNavList();current=getSavedNav(nav);await render();}catch{login();}if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});})();
