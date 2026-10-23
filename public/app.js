const $ = s => document.querySelector(s);
const escape = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let me, csrf, permissions = [], current = 'Overview', renderVersion = 0, reqPage = 1, candidateQuery = '';
const pageState = { Requisitions: 1, Candidates: 1, Interviews: 1, Referrals: 1, Administration: 1, 'Audit log': 1, Agencies: 1, 'Portal Dashboard': 1, 'Assigned Roles': 1, Submissions: 1, 'Agency Team': 1 };
const isAgencyMember = () => Boolean(me?.agency || ['Agency Admin','Agency Recruiter'].includes(me?.role));
const isAgencyUser = () => Boolean(isAgencyMember() || me?.role === 'Agency' || me?.user?.isAgency || me?.isAgency);
const isAgencyAdmin = () => Boolean(isAgencyUser() && (me?.role === 'Agency Admin' || me?.agency?.role === 'Agency Admin'));
const getNavList = () => {
  if (new URLSearchParams(location.search).get('agency') === '1' || (me?.role === 'Agency' && !me?.agency)) return ['Agency portal'];
  if (isAgencyMember()) {
    return ['Portal Dashboard', 'Assigned Roles', 'Submissions', ...(isAgencyAdmin() ? ['Agency Team'] : [])];
  }
  return [
    ...(allows('analytics') ? ['Overview'] : []),
    ...(allows('jobs') ? ['Requisitions'] : []),
    ...(allows('review') || allows('recruit') ? ['Candidates', 'Pipeline'] : []),
    ...(allows('review') || allows('recruit') || allows('interview') ? ['Interviews'] : []),
    ...(allows('refer') ? ['Referrals'] : []),
    ...(allows('admin') || allows('recruit') ? ['Agencies'] : []),
    ...(allows('admin') ? ['Administration', 'Settings', 'Audit log', 'Pipeline settings'] : []),
    ...(allows('admin') && me?.role === 'System Admin' ? ['Integrations'] : [])
  ];
};
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
const iconPaths={Overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',Requisitions:'M8 6V4h8v2 M3 7h18v13H3z M3 12h18 M10 11v3h4v-3',Candidates:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4',Pipeline:'M4 4h4v16H4z M10 4h4v11h-4z M16 4h4v7h-4z',Interviews:'M4 5h16v16H4z M8 2v6 M16 2v6 M4 10h16 M8 14h3 M14 14h2 M8 17h3',Referrals:'M12 20V10 M7 15l5-5 5 5 M4 4h16v4H4z',Agencies:'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75','Portal Dashboard':'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z','Assigned Roles':'M8 6V4h8v2 M3 7h18v13H3z M3 12h18 M10 11v3h4v-3',Submissions:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8','Agency Team':'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',Administration:'M12 3l8 4v6c0 4-4 7-8 9-4-2-8-5-8-9V7z M8 12l3 3 5-6','Audit log':'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h4','Pipeline settings':'M4 7h16 M4 17h16 M8 4v6 M16 14v6',Settings:'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',Integrations:'M8 3v5 M16 3v5 M5 8h14v4a7 7 0 0 1-14 0z M12 19v3','Agency portal':'M4 21v-8a8 8 0 0 1 16 0v8 M9 21v-4a3 3 0 0 1 6 0v4 M2 21h20'};
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
  let data=null;
  const contentType=response.headers.get('content-type')||'';
  if(contentType.includes('application/json')){
    data=await response.json().catch(()=>null);
  } else {
    const rawText=await response.text().catch(()=>'');
    data={error:rawText.includes('<!DOCTYPE')?`Server gateway error (HTTP ${response.status}). Please check mail provider settings.`:(rawText.slice(0,200)||`Request failed (HTTP ${response.status}).`)};
  }
  if(!response.ok){if(response.status===401 && me){me=null;login();}throw new Error(data?.error || `Request failed (HTTP ${response.status}).`);}
  return data;
}
const badge = value => `<span class="badge ${escape(String(value).split('_')[0])}">${escape(String(value).replaceAll('_',' '))}</span>`;
const empty = message => `<div class="empty">${escape(message)}</div>`;
const button = (title,action,id='',extra='') => `<button type="button" data-action="${action}" data-id="${escape(id)}" ${extra}>${escape(title)}</button>`;
const formActions = ({deleteAction='',deleteId='',saveLabel='Save'}={}) => `<div class="form-actions">${deleteAction?`<button type="button" class="btn-delete" data-action="${deleteAction}" data-id="${escape(deleteId)}">Delete</button>`:''}<button type="submit" class="btn-save">${escape(saveLabel)}</button></div>`;
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
const searchableSelect = (label,name,values,selected='',required=true,placeholder='Search options') => {
  const options = values.map(v=>{const [id,title]=Array.isArray(v)?v:[v,v];return {id:String(id),title:String(title)};});
  const selectedOption = options.find(o=>o.id===String(selected));
  return `<label class="searchable-field" data-searchable-field="${name}">${formatLabel(label, required)}
    <div class="searchable-combobox">
      <input type="search" class="select-search" data-search-select="${name}" placeholder="${escape(placeholder)}" aria-label="${escape(`Search ${label}`)}" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="${name}-options" value="${escape(selectedOption?.title||'')}">
      <button type="button" class="searchable-toggle" tabindex="-1" aria-label="${escape(`Show ${label} options`)}">▾</button>
      <div class="searchable-options" id="${name}-options" role="listbox" aria-label="${escape(label)}" hidden>
        ${options.map(o=>`<button type="button" class="searchable-option" role="option" data-value="${escape(o.id)}" data-search="${escape(o.title.toLowerCase())}" aria-selected="${o.id===String(selected)?'true':'false'}">${escape(o.title)}</button>`).join('')}
      </div>
    </div>
    <select name="${name}" class="searchable-native" ${required?'required aria-required="true"':''} tabindex="-1" aria-hidden="true">${options.map(o=>`<option value="${escape(o.id)}" data-search="${escape(o.title.toLowerCase())}" ${o.id===String(selected)?'selected':''}>${escape(o.title)}</option>`).join('')}</select>
  </label>`;
};
const bindSearchableSelect = name => {
  const fieldRoot = $(`#edit-form [data-searchable-field="${name}"]`);
  const input = fieldRoot?.querySelector(`[data-search-select="${name}"]`);
  const el = fieldRoot?.querySelector(`select[name="${name}"]`);
  const list = fieldRoot?.querySelector(`#${CSS.escape(name)}-options`);
  if(!input || !el) return;
  const options = Array.from(el.options).map(o=>({value:o.value,text:o.textContent,search:(o.dataset.search||o.textContent).toLowerCase()}));
  const optionButtons = list ? Array.from(list.querySelectorAll('.searchable-option')) : [];
  const selectedOption = el.selectedOptions[0];
  if (selectedOption && selectedOption.value) input.value = selectedOption.textContent;

  const setOpen = open => {
    if (list) list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
  };
  const selectValue = option => {
    if (!option) return;
    if (!Array.from(el.options).some(o=>o.value===option.value)) {
      el.insertAdjacentHTML('beforeend', `<option value="${escape(option.value)}" data-search="${escape(option.search)}">${escape(option.text)}</option>`);
    }
    el.value = option.value;
    input.value = option.text;
    optionButtons.forEach(b=>b.setAttribute('aria-selected', String(b.dataset.value === option.value)));
    setOpen(false);
  };
  const filter = () => {
    const query = input.value.trim().toLowerCase();
    const current = el.value;
    const matches = options.filter(o=>!query||o.search.includes(query));
    el.innerHTML = matches.length
      ? matches.map(o=>`<option value="${escape(o.value)}" data-search="${escape(o.search)}">${escape(o.text)}</option>`).join('')
      : '<option value="" disabled selected>No matching options</option>';
    if(matches.some(o=>o.value===current)) el.value = current;
    else if(matches.length) el.value = matches[0].value;
    const matchingValues = new Set(matches.map(o=>o.value));
    optionButtons.forEach(b=>{ b.hidden = !matchingValues.has(b.dataset.value); });
    setOpen(true);
  };

  input.oninput = filter;
  input.onfocus = () => setOpen(true);
  input.onkeydown = event => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const firstVisible = optionButtons.find(b=>!b.hidden);
    const match = firstVisible && options.find(o=>o.value===firstVisible.dataset.value);
    if (match) selectValue(match);
  };
  input.addEventListener('blur', () => setTimeout(()=>setOpen(false), 150));
  optionButtons.forEach(btn => {
    btn.addEventListener('mousedown', event => event.preventDefault());
    btn.addEventListener('click', () => selectValue(options.find(o=>o.value===btn.dataset.value)));
  });
  const toggle = fieldRoot.querySelector('.searchable-toggle');
  if (toggle) toggle.addEventListener('click', () => {
    const open = !list || list.hidden;
    setOpen(open);
    if (open) input.focus();
  });
};
const FEEDBACK_LOCKED_MESSAGE = 'Feedback can be submitted after the scheduled interview time.';
const SIGNATURE_BLOCKED_STAGES = Object.freeze(['Rejected','Withdrawn']);
const signatureEligibility = applications => {
  const apps = Array.isArray(applications) ? applications : [];
  const blockedApps = apps.filter(app => SIGNATURE_BLOCKED_STAGES.includes(app?.stage));
  if (apps.length > 0 && blockedApps.length === apps.length) {
    const hasRejected = blockedApps.some(app => app.stage === 'Rejected');
    return {
      eligible: false,
      applications: [],
      reason: hasRejected
        ? 'Cannot create an offer or signature request for a candidate with a rejected application.'
        : 'Cannot create an offer or signature request for a candidate with a withdrawn application.'
    };
  }
  return { eligible: true, applications: apps.filter(app => !SIGNATURE_BLOCKED_STAGES.includes(app?.stage)), reason: '' };
};
const feedbackReady = interview => {
  const scheduled = Date.parse(interview?.scheduled_at);
  return Number.isFinite(scheduled) && scheduled <= Date.now();
};
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
const bindResumeUpload = () => {
  const fileInput = $('#resume-file-input');
  const statusEl = $('#resume-upload-status');
  const idInput = $('#resume-id-input');
  const form = $('#edit-form');
  if (!fileInput || !form) return;

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    statusEl.innerHTML = `<span style="color:var(--accent);">Uploading and scanning <strong>${escape(file.name)}</strong>...</span>`;

    try {
      const formData = new FormData();
      formData.append('file', file, file.name);

      const endpoint = isAgencyUser() ? '/api/agency/resume/upload' : '/api/resume/upload';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'X-CSRF-Token': csrf || ''
        },
        body: formData
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Upload failed.');
      }

      if (idInput) idInput.value = data.resume_id || data.resume?.id || '';
      if (form.elements.resume_text && data.text) {
        form.elements.resume_text.value = data.text;
      }
      if (form.elements.name && !form.elements.name.value.trim() && data.name) {
        form.elements.name.value = data.name;
        form.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (form.elements.email && !form.elements.email.value.trim() && data.email) {
        form.elements.email.value = data.email;
        form.elements.email.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (form.elements.phone && !form.elements.phone.value.trim() && data.phone) {
        form.elements.phone.value = data.phone;
        form.elements.phone.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (form.elements.skills && !form.elements.skills.value.trim() && data.skills && data.skills.length) {
        form.elements.skills.value = Array.isArray(data.skills) ? data.skills.join(', ') : data.skills;
        form.elements.skills.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const resObj = data.resume || data;
      const warningsText = data.warnings && data.warnings.length ? ` (${data.warnings.join(', ')})` : '';
      statusEl.innerHTML = `<span style="color:var(--success, #16a34a);">✓ <strong>${escape(resObj.filename || file.name)}</strong> (${escape((resObj.format || 'doc').toUpperCase())}, ${Math.round((resObj.size || file.size) / 1024)} KB) extracted successfully.${escape(warningsText)}</span>`;
      notice(`Resume ${resObj.filename || file.name} parsed successfully. Review extracted text below.`, 'success');
    } catch (err) {
      statusEl.innerHTML = `<span class="error">Upload failed: ${escape(err.message)}</span>`;
      fileInput.value = '';
      notice(err.message, 'error');
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
function modal(title,html,onSubmit,options={}) {
  const saveButton=`<button type="submit">${escape(options.saveLabel||'Save')}</button>`;
  const actions=options.actions!==undefined?options.actions:`<div class="form-actions form-actions-end">${saveButton}</div>`;
  $('#modal-body').innerHTML=`<h2 tabindex="-1">${escape(title)}</h2>${onSubmit?`<form id="edit-form">${html}<p class="error" id="form-error" role="alert"></p>${actions}</form>`:html}`;
  if(onSubmit){
    let isSubmitting = false;
    $('#edit-form').onsubmit=async event=>{
      event.preventDefault();
      if(isSubmitting)return;
      isSubmitting = true;
      const submit=event.target.querySelector('[type=submit]');
      if(submit)submit.disabled=true;
      try{
        const msg=await onSubmit(Object.fromEntries(new FormData(event.target)));
        closeModal();
        notice(typeof msg==='string'?msg:'Saved.','success');
        await render();
      }catch(e){
        $('#form-error').textContent=e.message;
        notice(e.message,'error');
      }finally{
        isSubmitting = false;
        if(submit)submit.disabled=false;
      }
    };
  }
  $('#modal').showModal();
  const firstInput = $('#modal input:not([type=hidden]), #modal select, #modal textarea');
  if(firstInput) firstInput.focus(); else $('#modal-body h2')?.focus();
  if($('#notice')?.children.length)$('#modal').appendChild($('#notice'));
}
function deleteDialog(kind, record, impact, path, success) {
  modal(`Delete ${kind}`, `<div class="notice-inline danger-notice"><strong>${escape(record)}</strong> will be removed from active lists.</div><p>${escape(impact)}</p><p class="muted">This uses recoverable soft deletion and keeps an audit record. Linked records are never silently deleted. If this record has dependencies, deletion will be blocked and the record will remain unchanged.</p>`, async () => {
    await api(path, 'DELETE');
    return success;
  }, {
    actions: `<div class="form-actions"><button type="button" class="secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn-delete">Delete ${escape(kind)}</button></div>`
  });
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
      me={ ...meData.user, agency: meData.agency };
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
      me={ ...meData.user, agency: meData.agency };
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
  const heading=(subtitle,action='')=>`<div class="heading"><div><p class="eyebrow">${isAgencyUser()?'EXTERNAL RECRUITER PORTAL':current==='Overview'?`YOUR TEAM. YOUR NEXT CHAPTER.`:allows('admin')&&['Settings','Administration','Audit log','Pipeline settings'].includes(current)?'WORKSPACE MANAGEMENT':'TALENT ACQUISITION'}</p><h1>${current}</h1><p class="muted">${subtitle}</p></div>${action}</div>`;
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
    if(current==='Agency portal') {
      html=heading('External agency collaboration is not available in this workspace yet.')+`<section class="panel"><h2>Agency portal is not available yet</h2><p class="muted">Agency functionality has not been enabled for this workspace. Your Agency role does not have access to the internal ATS. Contact your Talent Acquisition administrator if you need help with a submission.</p></section>`;
    }
    if(current==='Candidates') {
      api('requisitions').then(rs=>{if(Array.isArray(rs))window._cachedOpenReqs=rs.filter(r=>r.status==='open');}).catch(()=>{});
      const candidates=await api('candidates');
      const renderCandidateTable=(q=candidateQuery)=>{
        candidateQuery=q;
        const query=q.trim();
        const filtered=query?candidates.filter(c=>{
          const appText=(c.applications||[]).map(a=>`${a.title} ${a.stage}`).join(' ');
          return `${c.name} ${c.email} ${c.skills} ${c.resume_text} ${appText}`.toLowerCase().includes(query);
        }):candidates;
        const {paged,page,totalPages,total,start}=paginate(filtered,pageState.Candidates||1,10);
        pageState.Candidates=page;
        if(!filtered.length){
          return query
            ? `<div class="empty"><p>No matching candidates found.</p>${button('Clear Search','clear-candidate-search','','class="secondary"')}</div>`
            : empty('No candidates added yet');
        }
        const pag=renderPagination('Candidates',page,totalPages,total,start,10);
        return `${candidateTable(paged)}${pag}`;
      };
      html=heading('Search skills, experience and candidate records.',allows('recruit')?button('+ Add candidate','new-candidate'):'')+`<section class="panel candidates-panel"><div class="panel-head"><h2>Candidate directory</h2><label class="search">Search<input id="candidate-search" type="search" placeholder="Search name, email or skill" value="${escape(candidateQuery)}"></label></div><div id="candidate-table">${renderCandidateTable()}</div></section>`;
      queueMicrotask(()=>{
        const el=$('#candidate-search');
        if(el)el.oninput=()=>{
          pageState.Candidates=1;
          $('#candidate-table').innerHTML=renderCandidateTable(el.value.trim().toLowerCase());
        };
      });
    }
    if(current==='Pipeline') {
      const [apps,stages]=await Promise.all([api('applications'),api('pipeline')]);
      const activeStages = stages.filter(s => !['Hired', 'Rejected'].includes(s));
      html=heading('Move each application through a consistent hiring process.',allows('recruit')?button('+ Add application','new-application'):'')+
      `<div class="pipeline-wrapper">`+
        `<div class="pipeline-flow-legend" aria-label="Pipeline overview">`+
          `<div class="legend-active-flow">`+
            `<span class="legend-title">Active Funnel:</span>`+
            `<div class="legend-steps">`+
              activeStages.map((s, idx) => `<span class="legend-step-pill"><span class="legend-step-num">${idx + 1}</span> ${escape(s)}</span>`).join('<span class="legend-arrow" aria-hidden="true">→</span>')+
            `</div>`+
          `</div>`+
          `<div class="legend-outcomes-flow">`+
            `<span class="legend-title">Terminal Outcomes:</span>`+
            `<span class="legend-outcome-pill hired-pill"><span class="legend-outcome-dot"></span> Hired</span>`+
            `<span class="legend-outcome-pill rejected-pill"><span class="legend-outcome-dot"></span> Rejected</span>`+
          `</div>`+
        `</div>`+
        `<div class="board" id="pipeline-board">${stages.map((stage,index)=>`<section class="column${['Hired','Rejected'].includes(stage)?' column-terminal':''}${stage==='Hired'?' column-terminal-hired':''}${stage==='Rejected'?' column-terminal-rejected':''}" data-stage="${escape(stage)}"><h2><span class="column-header-title">${['Hired','Rejected'].includes(stage)?`<span class="column-stage-type ${stage==='Hired'?'type-hired':'type-rejected'}">${stage==='Hired'?'✓ Outcome':'✕ Outcome'}</span>`:''}<span class="column-name-text">${escape(stage)}</span></span><span class="column-count ${stage==='Hired'?'count-hired':stage==='Rejected'?'count-rejected':''}">${apps.filter(a=>a.stage===stage).length}</span></h2><div class="column-content">${apps.filter(a=>a.stage===stage).map(a=>`<article class="card"><h3>${escape(a.name)}</h3><p class="muted card-role" title="${escape(a.title)}">${escape(a.title)}</p><div class="actions">${button('Skill match','match',a.id,'class="secondary"')}${allows('recruit')&&!['Hired','Rejected'].includes(stage)?(index>0?button(`Back to ${stages[index-1]}`,'move',a.id,`data-stage="${escape(stages[index-1])}" class="secondary"`):'')+button(`Move to ${stages[index+1]}`,'move',a.id,`data-stage="${escape(stages[index+1])}"`)+button('Reject','reject-app',a.id,'class="secondary"'):''}</div></article>`).join('')||'<p class="muted column-empty">No applications</p>'}</div></section>`).join('')}</div>`+
        `<div class="pipeline-scroll-bar pipeline-scroll-bottom" id="pipeline-bottom-scroll" aria-label="Horizontal scroll sticky at bottom of screen"><div class="pipeline-scroll-track"></div></div>`+
      `</div>`;
    }
    if(current==='Interviews') {
      const [interviews, calInfo] = await Promise.all([
        api('interviews'),
        api('interviews/calendar-status').catch(() => ({ configured: false }))
      ]);
      const {paged,page,totalPages,total,start}=paginate(interviews,pageState.Interviews||1,10);
      pageState.Interviews=page;
      const pag=renderPagination('Interviews',page,totalPages,total,start,10);
      const isCalActive = Boolean(calInfo?.configured || interviews.some(i => i.meeting_url || i.calendar_status === 'synced'));
      const calNotice = isCalActive
        ? `<div class="notice-inline" style="border-left-color:var(--positive);background:var(--positive-bg);color:var(--positive);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">`+
            `<div style="display:flex;align-items:center;gap:8px;">`+
              `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--positive);flex-shrink:0;"><path d="M20 6L9 17l-5-5"/></svg>`+
              `<span><strong>Microsoft Teams calendar connected:</strong> Interview plans and meeting links synchronize automatically with participant calendars.</span>`+
            `</div>`+
            `<span class="badge" style="background:var(--positive-bg);color:var(--positive);border:1px solid var(--positive);font-weight:600;font-size:0.75rem;padding:3px 9px;">✓ Active Integration</span>`+
          `</div>`
        : `<div class="notice-inline" style="border-left-color:var(--warning);background:var(--warning-bg);color:var(--warning);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">`+
            `<div><strong>Microsoft Teams calendar not configured:</strong> Interview plans are stored locally. Configure Microsoft 365 credentials in Integrations to sync Teams invites.</div>`+
            `${allows('admin') ? `<button type="button" class="secondary" data-action="navigate" data-view="Integrations" style="font-size:0.8rem;padding:5px 10px;">Configure Integration</button>` : ''}`+
          `</div>`;
      const rows=paged.map(i=>{
        const ready=feedbackReady(i);
        const canSubmit=i.interviewer_id===me.id&&i.status!=='completed';
        const canProxy=allows('admin')&&i.interviewer_id!==me.id&&i.status!=='completed';
        const showLock=(canSubmit||canProxy)&&!ready;
        return `<tr><td><strong>${escape(i.name)}</strong>${escape(i.title)}</td><td>${escape(i.interviewer)}</td><td>${escape(new Date(i.scheduled_at).toLocaleString())}${i.meeting_url?`<br><a href="${escape(i.meeting_url)}" target="_blank" rel="noopener noreferrer" class="teams-link" style="display:inline-flex;align-items:center;gap:4px;font-size:0.8rem;margin-top:4px;color:var(--accent,#4f46e5);font-weight:600;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>Join Teams</a>`:''}</td><td>${badge(i.status)}</td><td><div class="actions">${canSubmit&&ready?button('Submit scorecard','scorecard',i.id):''}${canProxy&&ready?button('Proxy scorecard','scorecard-proxy',i.id,'class="secondary"'):''}${i.status!=='completed'&&(allows('recruit')||allows('admin')||i.interviewer_id===me.id)?button('Edit','edit-interview',i.id,'class="secondary"'):''}${i.status==='planned'&&(allows('recruit')||allows('admin')||i.interviewer_id===me.id)?button('Cancel','cancel-interview',i.id,'class="secondary"'):''}${button('View feedback','feedback',i.id,'class="secondary"')}${showLock?`<span class="muted feedback-locked">${FEEDBACK_LOCKED_MESSAGE}</span>`:''}</div></td></tr>`;
      });
      html=heading('Structured interviews, independent feedback.',allows('recruit')?button('+ Plan interview','new-interview'):'')+calNotice+`<section class="panel">${table(['Candidate / role','Interviewer','Scheduled','Status','Feedback'],rows)}${pag}</section>`;
    }
    if(current==='Referrals') {
      const refs=await api('referrals');
      const {paged,page,totalPages,total,start}=paginate(refs,pageState.Referrals||1,10);
      pageState.Referrals=page;
      const pag=renderPagination('Referrals',page,totalPages,total,start,10);
      const canProcess=allows('recruit');
      const scopeTitle=canProcess?'Employee referrals within your team scope':'Your referrals';
      const rows=paged.map(r=>{
        const position=r.requisition_title
          ? (r.can_view_requisition?button(r.requisition_title,'req-details',r.requisition_id,`class="text-button referral-position" data-readonly="true" data-referral-id="${escape(r.id)}"`):`<span title="${escape(r.requisition_title)}">${escape(r.requisition_title)}</span>`)
          : (r.requisition_restricted?'<span class="muted">Restricted</span>':'<span class="muted">Not linked</span>');
        const actions=[button('View details','referral-details',r.id,'class="secondary"')];
        if(r.can_edit)actions.push(button('Edit','edit-referral',r.id,'class="secondary"'));
        if(r.can_process)actions.push(button('Process','process-referral',r.id));
        if(r.can_withdraw)actions.push(button('Withdraw','withdraw-referral',r.id,'class="secondary"'));
        return `<tr><td><button type="button" class="text-button person-link" data-action="referral-details" data-id="${escape(r.id)}" title="${escape(r.name)}">${escape(r.name)}</button></td><td>${escape(r.email)}</td><td>${position}</td><td class="referral-status-cell">${badge(r.status)}</td><td>${escape(new Date(r.at).toLocaleDateString())}</td><td>${escape(r.referrer_name||'You')}</td><td><div class="actions">${actions.join('')}</div></td></tr>`;
      });
      html=heading(canProcess?`Review employee referrals for ${escape(me.team||'your organization')}.`:'Recommend a colleague for an open position.',button('+ Make referral','new-referral'))+`<section class="panel"><h2>${scopeTitle}</h2>${table(['Candidate','Email','Job Position','Referral Status','Referred','Referrer','Actions'],rows,'referrals-table')}${pag}</section>`;
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
    if(current==='Pipeline settings') {
      const stages=await api('pipeline');
      const activeStages = stages.filter(s => !['Hired', 'Rejected'].includes(s));
      const metrics = [
        ['Active Progression', `${activeStages.length} Stages`, 'Pipeline', 'Sequential applicant advancement'],
        ['Terminal Outcomes', '2 Outcomes', 'Candidates', 'Hired (Success) & Rejected (Closed)'],
        ['Entry Stage', escape(stages[0] || 'Applied'), 'Overview', 'Mandatory starting point'],
        ['Governance', 'Enforced', 'Administration', 'Sequential moves & headcount limits']
      ];

      html=heading('Define the sequence your hiring teams follow.')+
      `<div class="metrics">${metrics.map(([label,count,i,note],n)=>`<div class="metric metric-${n}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(i)}</span></div><strong>${count}</strong><small>${note}</small></div>`).join('')}</div>`+
      `<section class="panel pipeline-flow-panel">`+
        `<div class="panel-head">`+
          `<div><h2>Hiring Workflow Architecture</h2><p class="muted">Applicants advance through sequential active stages and conclude at one of two terminal outcomes.</p></div>`+
          `<div class="actions">${button('Edit stages','edit-pipeline')}</div>`+
        `</div>`+
        `<div class="pipeline-diagram-wrapper">`+
          `<div class="pipeline-track active-track">`+
            `<div class="track-header"><span class="track-badge">In-Progress Sequential Funnel</span><span class="track-hint">Candidates progress forward one stage at a time (or step back to correct mistakes)</span></div>`+
            `<div class="pipeline-flow-steps">`+
              activeStages.map((s, idx) =>
                `<div class="pipeline-step-card"><div class="step-num-pill">${idx + 1}</div><div class="step-card-body"><span class="step-card-name">${escape(s)}</span><span class="step-card-sub">${idx === 0 ? 'Initial intake' : idx === activeStages.length - 1 ? 'Final evaluation / offer' : 'Interview & evaluation'}</span></div></div>` +
                (idx < activeStages.length - 1 ? `<div class="flow-connector" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></div>` : '')
              ).join('')+
            `</div>`+
          `</div>`+
          `<div class="pipeline-fork-bridge">`+
            `<div class="fork-label-pill"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg> Terminal Resolution Branches</div>`+
            `<div class="fork-split-arrows" aria-hidden="true"><span>↙ Successful Hire</span><span>·</span><span>Concluded ↘</span></div>`+
          `</div>`+
          `<div class="pipeline-outcomes-container">`+
            `<div class="terminal-outcome-card outcome-hired">`+
              `<div class="outcome-header">`+
                `<div class="outcome-icon-wrap success-wrap"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg></div>`+
                `<div><span class="outcome-type success-text">Positive Terminal Outcome</span><h3 class="outcome-title">Hired</h3></div>`+
                `<span class="badge" style="background:#e3f3ed;color:#24614d;font-weight:600;margin-left:auto;">Success</span>`+
              `</div>`+
              `<p class="outcome-desc">Candidate successfully accepts offer. Approved headcount is filled and onboarding begins. Candidates do not move beyond this stage.</p>`+
              `<div class="outcome-badge-meta"><span class="outcome-rule-chip">● Headcount enforced</span><span class="outcome-rule-chip">● Final victory state</span></div>`+
            `</div>`+
            `<div class="terminal-outcome-card outcome-rejected">`+
              `<div class="outcome-header">`+
                `<div class="outcome-icon-wrap rejected-wrap"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>`+
                `<div><span class="outcome-type rejected-text">Concluded / Archived Outcome</span><h3 class="outcome-title">Rejected</h3></div>`+
                `<span class="badge rejected" style="background:#fae6e8;color:#922e3b;font-weight:600;margin-left:auto;">Archived</span>`+
              `</div>`+
              `<p class="outcome-desc">Candidate is disqualified, offer declined, or application withdrawn. Can occur from any active stage in the pipeline without progressing through Hired.</p>`+
              `<div class="outcome-badge-meta"><span class="outcome-rule-chip">● Available at any stage</span><span class="outcome-rule-chip">● Closes application cycle</span></div>`+
            `</div>`+
          `</div>`+
        `</div>`+
      `</section>`+
      `<section class="panel pipeline-policy-panel">`+
        `<div class="panel-head"><div><h2>Pipeline Governance Rules</h2><p class="muted">Core system constraints to ensure hiring compliance, data integrity, and separation between active workflow and terminal states.</p></div></div>`+
        `<div class="pipeline-rules-grid">`+
          `<div class="rule-card"><div class="rule-icon">${icon('Candidates')}</div><div><strong>Entry Integrity</strong><p class="muted"><strong>Applied</strong> is the mandatory first stage for every new application entering the organization.</p></div></div>`+
          `<div class="rule-card"><div class="rule-icon">${icon('Pipeline')}</div><div><strong>Step-by-Step Progression</strong><p class="muted">Active stages advance sequentially. Recruiters can step backward to correct errors, but skipping forward requires administrative override.</p></div></div>`+
          `<div class="rule-card"><div class="rule-icon">${icon('Overview')}</div><div><strong>Terminal Isolation</strong><p class="muted"><strong>Hired</strong> and <strong>Rejected</strong> are independent terminal end states. A candidate is never rejected after being hired, and terminal records cannot be moved without administrative override.</p></div></div>`+
          `<div class="rule-card"><div class="rule-icon">${icon('Administration')}</div><div><strong>Dependency Safety</strong><p class="muted">A pipeline stage cannot be removed if there are active or historical applications currently associated with it.</p></div></div>`+
        `</div>`+
      `</section>`;
    }
    if(current==='Integrations') {
      if(me?.role !== 'System Admin') {
        html=heading('Access Restricted')+`<div class="empty">System Admin access is required to view and manage integrations.</div>`;
      } else {
        const integrations = await api('admin/integrations');
        const activeCount = integrations.filter(i => i.enabled && (i.status === 'connected' || i.status === 'configured')).length;
        const externalCount = integrations.filter(i => i.isExternal).length;
        const inHouseCount = integrations.filter(i => !i.isExternal).length;

        const metrics = [
          ['Supported Integrations', integrations.length, 'Overview', 'Total manageable system adapters'],
          ['Active & Ready', activeCount, 'Integrations', 'Operational provider interfaces'],
          ['External Cloud APIs', externalCount, 'Pipeline', 'Microsoft, Resend, AI & HRMS'],
          ['In-House Engines', inHouseCount, 'Administration', 'Signatures, Fraud, Agency & Scanner']
        ];

        html = heading('Manage external API credentials, connection health, and enterprise adapters.') +
          `<div class="metrics">${metrics.map(([label, count, i, note], n) => `<div class="metric metric-${n}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(i)}</span></div><strong>${count}</strong><small>${note}</small></div>`).join('')}</div>` +
          `<section class="panel integrations-container">` +
            `<div class="panel-head" style="margin-bottom:12px;">` +
              `<div><h2>System Integrations Registry</h2><p class="muted">Manage credentials securely with AES-256-GCM encryption, run non-destructive tests, and configure fallbacks.</p></div>` +
              `<div class="actions">` +
                `<button type="button" class="secondary" data-action="refresh-integrations">${icon('Administration')}<span>Refresh Status</span></button>` +
              `</div>` +
            `</div>` +
            `<div class="int-header-toolbar">` +
              `<div class="int-search-wrap">` +
                `<svg class="int-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>` +
                `<input type="search" id="int-search-input" placeholder="Search integrations by name or capability..." aria-label="Search integrations">` +
              `</div>` +
              `<div class="int-filter-tabs" role="tablist">` +
                `<button type="button" class="int-tab-btn active" data-filter="all">All (${integrations.length})</button>` +
                `<button type="button" class="int-tab-btn" data-filter="active">Active (${activeCount})</button>` +
                `<button type="button" class="int-tab-btn" data-filter="external">Cloud APIs (${externalCount})</button>` +
                `<button type="button" class="int-tab-btn" data-filter="inhouse">In-House (${inHouseCount})</button>` +
              `</div>` +
            `</div>` +
            `<div class="integrations-grid" id="integrations-grid">` +
              integrations.map(item => {
                let statusClass = 'ready';
                let statusLabel = 'Ready to Setup';
                if (item.status === 'connected') {
                  statusClass = 'connected';
                  statusLabel = 'Connected';
                } else if (item.status === 'configured') {
                  statusClass = 'configured';
                  statusLabel = 'Configured';
                } else if (item.status === 'disabled') {
                  statusClass = 'disabled';
                  statusLabel = 'Deactivated';
                } else if (item.status === 'failed') {
                  statusClass = 'failed';
                  statusLabel = 'Needs Attention';
                }

                const archBadge = item.isExternal
                  ? `<span class="int-type-tag int-type-cloud">Cloud API</span>`
                  : `<span class="int-type-tag int-type-inhouse">In-House</span>`;

                const testInfo = item.lastTestAt
                  ? (item.lastTestStatus === 'success'
                      ? `<span class="int-diag-chip diag-ok" title="Last verified: ${escape(new Date(item.lastTestAt).toLocaleString())}">✓ Verified active</span>`
                      : `<span class="int-diag-chip diag-warn" title="${escape(item.lastError || 'Test failed')}">⚠ Connection check needed</span>`)
                  : `<span class="int-diag-chip diag-ready">Ready for test</span>`;

                const featureTags = getIntegrationFeatureTags(item);

                return `<div class="integration-card" data-integration-id="${escape(item.id)}" data-category="${escape(item.category)}" data-external="${item.isExternal ? '1' : '0'}" data-status="${escape(item.status)}">` +
                  `<div class="int-card-head">` +
                    `<div class="int-icon-wrap">${getIntegrationIcon(item.id)}</div>` +
                    `<div class="int-head-meta">` +
                      `<div class="int-meta-sub">` +
                        `<span class="int-category-text">${escape(item.category)}</span>` +
                        `<span class="int-dot-sep">·</span>` +
                        `${archBadge}` +
                      `</div>` +
                      `<h3 class="int-name">${escape(item.name)}</h3>` +
                    `</div>` +
                    `<span class="int-status-pill int-status-${statusClass}"><span class="int-status-dot"></span>${statusLabel}</span>` +
                  `</div>` +
                  `<p class="int-desc">${escape(item.description)}</p>` +
                  `<div class="int-feature-tags">${featureTags.map(t => `<span class="int-feature-tag">${escape(t)}</span>`).join('')}</div>` +
                  `<div class="int-health-row">${testInfo}<span class="int-enc-badge" title="AES-256-GCM encrypted">🔒 AES-256 Encrypted</span></div>` +
                  `<details class="int-details-drawer">` +
                    `<summary class="int-details-summary">Capabilities & Fallback ▾</summary>` +
                    `<div class="int-drawer-content">` +
                      `<strong>Capabilities:</strong>` +
                      `<ul>${item.capabilities.map(cap => `<li>${escape(cap)}</li>`).join('')}</ul>` +
                      `<div class="int-fallback-box"><small><strong>Fallback:</strong> ${escape(item.fallbackPolicy)}</small></div>` +
                    `</div>` +
                  `</details>` +
                  `<div class="int-card-actions">` +
                    `<button type="button" class="button" data-action="configure-integration" data-id="${escape(item.id)}">Configure</button>` +
                    `<button type="button" class="button secondary" data-action="test-integration" data-id="${escape(item.id)}" title="Run safe, non-destructive connection test">Test Connection</button>` +
                    `<button type="button" class="button secondary int-toggle-btn" data-action="toggle-integration" data-id="${escape(item.id)}" data-enabled="${item.enabled ? '0' : '1'}">${item.enabled ? 'Deactivate' : 'Activate'}</button>` +
                  `</div>` +
                `</div>`;
              }).join('') +
            `</div>` +
          `</section>`;
      }
    }
    if(current==='Agencies') {
      const agencies = await api('agencies');
      const {paged,page,totalPages,total,start}=paginate(agencies,pageState.Agencies||1,10);
      pageState.Agencies=page;
      const pag=renderPagination('Agencies',page,totalPages,total,start,10);
      html=heading('Manage external recruitment agencies and partner access.',allows('admin')?button('+ Register agency','new-agency'):'')+
      `<div class="metrics">${[
        ['Registered agencies', agencies.length, 'Agencies', 'External recruitment partners'],
        ['Active agencies', agencies.filter(a=>a.status==='active').length, 'Agencies', 'Operational partner portals'],
        ['Assigned requisitions', agencies.reduce((acc,a)=>acc+Number(a.assigned_requisitions_count||0),0), 'Requisitions', 'Total open job assignments'],
        ['Agency submissions', agencies.reduce((acc,a)=>acc+Number(a.submissions_count||0),0), 'Candidates', 'Total candidates received']
      ].map(([label,count,i,note],n)=>`<div class="metric metric-${n}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(i)}</span></div><strong>${count}</strong><small>${note}</small></div>`).join('')}</div>`+
      `<section class="panel"><div class="panel-head"><div><h2>External recruitment agencies</h2><p class="muted">Authorized partners with isolated portal access.</p></div></div>`+
      `${table(['Agency / Code','Primary contact','Recruiters','Assigned jobs','Submissions','Status','Actions'],paged.map(a=>`<tr><td><strong>${escape(a.name)}</strong><br><small class="mono">${escape(a.code)}</small></td><td>${escape(a.contact_name||'—')}<br><small>${escape(a.contact_email||'')}${a.contact_phone?` · ${escape(a.contact_phone)}`:''}</small></td><td><strong>${a.active_recruiters_count||0}</strong> <small class="muted">active</small></td><td><strong>${a.assigned_requisitions_count||0}</strong></td><td><strong>${a.submissions_count||0}</strong></td><td>${badge(a.status)}</td><td><div class="actions">${button('Manage','manage-agency',a.id,'class="secondary"')}${allows('admin')?button('Assign role','agency-assign-job',a.id,'class="secondary"'):''}</div></td></tr>`))}`+
      `${pag}</section>`;
    }
    if(current==='Portal Dashboard') {
      const dash = await api('agency/dashboard');
      const assigned = dash.assignedRequisitions || [];
      const recent = dash.recentSubmissions || [];
      html=heading(`Welcome, ${escape(me.name.split(' ')[0])}. Review assigned roles and submit top talent.`,button('+ Add candidate','agency-submit-candidate'))+
      `<div class="agency-scope-banner"><div><span class="agency-scope-label">PARTNER AGENCY PORTAL</span><strong>${escape(dash.agency?.name || 'Partner Agency')}</strong> <span class="mono" style="opacity:0.85;">(${escape(dash.agency?.code || '')})</span></div><div><span class="badge badge-active">${escape((dash.agency?.status || 'active').toUpperCase())}</span></div></div>`+
      `<div class="agency-stats-grid">`+
        `<div class="agency-stat-card"><div class="agency-stat-label">Assigned open roles</div><div class="agency-stat-val">${dash.stats.assignedRequisitions||0}</div><small class="muted">Roles open for sourcing</small></div>`+
        `<div class="agency-stat-card"><div class="agency-stat-label">Total submissions</div><div class="agency-stat-val">${dash.stats.totalSubmissions||0}</div><small class="muted">Candidates submitted</small></div>`+
        `<div class="agency-stat-card"><div class="agency-stat-label">Under review</div><div class="agency-stat-val">${dash.stats.underReview||0}</div><small class="muted">Internal screening</small></div>`+
        `<div class="agency-stat-card"><div class="agency-stat-label">Interviews scheduled</div><div class="agency-stat-val">${dash.stats.interviews||0}</div><small class="muted">Active interview loops</small></div>`+
        `<div class="agency-stat-card"><div class="agency-stat-label">Selected / Hired</div><div class="agency-stat-val">${dash.stats.selected||0}</div><small class="muted">Successful placements</small></div>`+
      `</div>`+
      `<div class="split">`+
        `<section class="panel"><div class="panel-head"><div><h2>Assigned requisitions</h2><p class="muted">Active roles open for your agency</p></div>${button('View all assigned','navigate','','class="text-button" data-view="Assigned Roles"')}</div>`+
        `${table(['Position','Team','Deadline','Action'],assigned.slice(0,5).map(r=>`<tr><td><strong>${escape(r.title)}</strong><br><small>${escape((r.skills||[]).join(', '))}</small></td><td>${escape(r.team)}</td><td>${r.submission_deadline?escape(new Date(r.submission_deadline).toLocaleDateString()):'Open'}</td><td><div class="actions">${button('Add candidate','agency-submit-candidate',r.id,'class="primary"')}</div></td></tr>`))}`+
        `</section>`+
        `<section class="panel"><div class="panel-head"><div><h2>Recent submissions</h2><p class="muted">Live status & feedback from internal recruiters</p></div>${button('View all submissions','navigate','','class="text-button" data-view="Submissions"')}</div>`+
        `${table(['Candidate / Ref','Requisition','Status','Feedback'],recent.slice(0,5).map(s=>`<tr><td><strong>${escape(s.candidate_name)}</strong><br><small class="mono">${escape(s.submission_ref)}</small></td><td>${escape(s.requisition_title)}</td><td>${badge(s.agency_status)}</td><td>${s.published_feedback?button('View feedback','view-agency-feedback',s.id,'class="text-button"'):'<span class="muted" style="font-size:0.8rem;">Under evaluation</span>'}</td></tr>`))}`+
        `</section>`+
      `</div>`;
    }
    if(current==='Assigned Roles') {
      const roles = await api('agency/requisitions');
      const {paged,page,totalPages,total,start}=paginate(roles,pageState['Assigned Roles']||1,10);
      pageState['Assigned Roles']=page;
      const pag=renderPagination('Assigned Roles',page,totalPages,total,start,10);
      html=heading('Job requisitions assigned to your agency for candidate sourcing.',button('+ Add candidate','agency-submit-candidate'))+
      `<section class="panel"><div class="panel-head"><div><h2>Active assigned requisitions</h2><p class="muted">Ensure candidate representation authorization before submitting.</p></div></div>`+
      `${table(['Position','Team / Location','Skills & requirements','Deadline','Sourcing instructions','Add candidate'],paged.map(r=>`<tr><td><strong>${escape(r.title)}</strong><br><small class="mono">${escape(r.team)}</small></td><td>${escape(r.team)}<br><small class="muted">Full-time</small></td><td><div class="skill-list">${(r.skills||[]).map(s=>`<span class="skill-chip">${escape(s)}</span>`).join('')}</div></td><td>${r.submission_deadline?`<span class="badge ${new Date(r.submission_deadline)<new Date()?'rejected':'pending'}">${escape(new Date(r.submission_deadline).toLocaleDateString())}</span>`:'<span class="badge active">Open</span>'}</td><td style="max-width:240px;"><small class="muted">${escape(r.sourcing_instructions||'Standard requirements apply.')}</small></td><td><div class="actions">${button('Add candidate','agency-submit-candidate',r.id,'class="primary"')}</div></td></tr>`))}`+
      `${pag}</section>`;
    }
    if(current==='Submissions') {
      const subs = await api('agency/submissions');
      const {paged,page,totalPages,total,start}=paginate(subs,pageState.Submissions||1,10);
      pageState.Submissions=page;
      const pag=renderPagination('Submissions',page,totalPages,total,start,10);
      html=heading('Candidate submissions and live status tracking.',button('+ Submit candidate','agency-submit-candidate'))+
      `<section class="panel"><div class="panel-head"><div><h2>Your agency submissions</h2><p class="muted">Live status synchronized directly with Orbit internal pipeline stages.</p></div></div>`+
      `${table(['Reference','Candidate','Requisition','Submitted by','Date','Status','Feedback'],paged.map(s=>`<tr><td class="mono"><strong>${escape(s.submission_ref||s.reference)}</strong></td><td><strong>${escape(s.candidate_name)}</strong><br><small>${escape(s.candidate_email)}</small></td><td>${escape(s.requisition_title)}</td><td>${escape(s.recruiter_name||'Agency')}</td><td>${escape(new Date(s.created_at||s.submitted_at||Date.now()).toLocaleDateString())}</td><td>${badge(s.agency_status||s.status||'Submitted')}</td><td>${(s.published_feedback||s.feedback)?button('View feedback','view-agency-feedback',s.id,'class="secondary"'):'<span class="muted" style="font-size:0.85rem;">Under evaluation</span>'}</td></tr>`))}`+
      `${pag}</section>`;
    }
    if(current==='Agency Team') {
      const members = await api('agency/members');
      const {paged,page,totalPages,total,start}=paginate(members,pageState['Agency Team']||1,10);
      pageState['Agency Team']=page;
      const pag=renderPagination('Agency Team',page,totalPages,total,start,10);
      html=heading('Manage recruiters and partner access for your agency.',isAgencyAdmin()?button('+ Add recruiter','new-agency-recruiter'):'')+
      `<section class="panel"><div class="panel-head"><div><h2>Agency recruiters & administrators</h2><p class="muted">Recruiters can view assigned jobs and submit candidates on behalf of your agency.</p></div></div>`+
      `${table(['Member','Role','Status','Joined','Actions'],paged.map(m=>`<tr><td><strong>${escape(m.name)}</strong><br><small>${escape(m.email)}</small></td><td><span class="badge ${m.role==='Agency Admin'?'completed':'clean'}">${escape(m.role)}</span></td><td>${badge(m.status)}</td><td>${escape(new Date(m.created_at).toLocaleDateString())}</td><td><div class="actions">${isAgencyAdmin()&&m.user_id!==me.id?button(m.status==='active'?'Suspend':'Reactivate','toggle-agency-recruiter-status',m.user_id,`data-status="${m.status==='active'?'suspended':'active'}" class="secondary"`):'<span class="muted">—</span>'}</div></td></tr>`))}`+
      `${pag}</section>`;
    }
    if(version===renderVersion && me){
      const prevBoardLeft = (current === 'Pipeline' && $('#pipeline-board')) ? $('#pipeline-board').scrollLeft : 0;
      $('#main').innerHTML=html;
      document.title=`${current} · Orbit by Mechlin`;
      syncNavState();
      if(current === 'Pipeline') syncPipelineScroll(prevBoardLeft);
      if(current === 'Integrations') bindIntegrationsFilter();
    }
  }catch(e){if(me)$('#main').innerHTML=`<section class="panel"><h1>Could not load this view</h1><p class="error">${escape(e.message)}</p>${button('Try again','refresh')}</section>`;}
}
function reqTable(reqs) {return table(['Position','Team','Headcount','Status','Actions'],reqs.map(r=>{
  const canReviewManager = r.status==='pending_manager' && allows('approve_manager') && (r.created_by !== me?.id || allows('admin'));
  const canReviewFinance = r.status==='pending_finance' && allows('approve_finance') && (r.created_by !== me?.id || allows('admin'));
  return `<tr><td><strong>${escape(r.title)}</strong><small>${escape(r.skills.join(', '))}</small></td><td>${escape(r.team)}</td><td>${r.headcount}</td><td>${badge(r.status)}</td><td><div class="actions">${button('Details','req-details',r.id,'class="secondary"')}${['draft','open'].includes(r.status)&&(allows('recruit')||allows('requisition'))?button('Edit','edit-req',r.id,'class="secondary"'):''}${r.status==='draft'&&(allows('recruit')||allows('requisition'))?button('Submit','submit-req',r.id):''}${(canReviewManager||canReviewFinance)?button('Review','approve-req',r.id):''}</div></td></tr>`;
}),'requisitions-table');}
const requisitionSectionHeadings=new Set(['purpose','role overview','about the role','required skills','required skills and experience','responsibilities','key responsibilities','what success looks like','interview process','accessibility']);
const requisitionHeading=line=>{const label=line.trim().replace(/\s*:\s*$/,'');return requisitionSectionHeadings.has(label.toLowerCase())?label:null;};
function requisitionDescription(value='') {
  const lines=String(value).replace(/\r\n?/g,'\n').split('\n');
  let html='',paragraph=[],items=[];
  const flushParagraph=()=>{if(paragraph.length){html+=`<p class="detail-section-body">${paragraph.map(escape).join('<br>')}</p>`;paragraph=[];}};
  const flushList=()=>{if(items.length){html+=`<ul class="detail-section-list">${items.map(item=>`<li>${escape(item)}</li>`).join('')}</ul>`;items=[];}};
  for(const rawLine of lines){
    const line=rawLine.trim();
    if(!line){flushParagraph();flushList();continue;}
    const heading=requisitionHeading(line);
    if(heading){flushParagraph();flushList();html+=`<h3 class="detail-section-title">${escape(heading)}</h3>`;continue;}
    const bullet=line.match(/^[•*-]\s+(.+)$/);
    if(bullet){flushParagraph();items.push(bullet[1]);continue;}
    flushList();paragraph.push(line);
  }
  flushParagraph();flushList();
  return html;
}
function requisitionDetail(r,{readOnly=false}={}) {
  const canEdit=!readOnly&&((['draft','open'].includes(r.status)||(allows('admin')&&['pending_manager','pending_finance'].includes(r.status)))&&(allows('recruit')||allows('requisition')));
  const skillsList=Array.isArray(r.skills)?r.skills:[];
  return `<div class="requisition-detail"><p class="detail-meta">${badge(r.status)} · ${escape(r.team)} · ${r.headcount} opening(s)</p>${r.salary_min!==undefined?`<p class="detail-salary">${r.salary_min}–${r.salary_max} ${escape(r.currency)}</p>`:''}${requisitionDescription(r.description)}${skillsList.length?`<h3 class="detail-section-title">Required skills</h3><div class="skill-list">${skillsList.map(s=>`<span class="skill-chip">${escape(s)}</span>`).join('')}</div>`:''}${readOnly?`<p class="read-only-note" role="status">${icon('Administration')}<span>Read-only view. Editing is available from the Requisitions page for authorized users.</span></p>`:''}${canEdit?`<div class="actions detail-actions">${button('Edit','edit-req',r.id)}</div>`:''}</div>`;
}
function candidateStatusCell(c){
  if(!c.applications||!c.applications.length)return '<span class="muted">No applications</span>';
  return `<div class="candidate-status-list">${c.applications.map(a=>{
    const title=escape(a.title||'General Application');
    return `<div class="candidate-status-pair"><span class="candidate-status-role" title="${title}">${title}</span> <span class="status-sep" aria-hidden="true">—</span> ${badge(a.stage||'Applied')}</div>`;
  }).join('')}</div>`;
}
function candidateTable(cs){return table(['Candidate','Skills','Source','Status','Actions'],cs.map(c=>`<tr><td><div class="person-cell"><span class="avatar">${initials(c.name)}</span><div><strong title="${escape(c.name)}">${escape(c.name)}</strong><small title="${escape(c.email)}">${escape(c.email)}</small></div></div></td><td><div class="skill-list">${c.skills.map(s=>`<span class="skill-chip" title="${escape(s)}">${escape(s)}</span>`).join('')}</div></td><td><span title="${escape(c.source)}">${escape(c.source)}</span></td><td>${candidateStatusCell(c)}</td><td><div class="actions">${button('View profile','candidate-details',c.id,'class="secondary"')}${allows('recruit')?button('Edit','edit-candidate',c.id,'class="secondary"'):''}</div></td></tr>`),'candidates-table');}

function getIntegrationIcon(id) {
  switch (id) {
    case 'microsoft_calendar':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><polygon points="11 13 16 16 11 19 11 13" fill="currentColor" stroke="none"></polygon></svg>`;
    case 'email_communication':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`;
    case 'multi_ai':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"></path></svg>`;
    case 'resume_scanner':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M9 15l2 2 4-4"></path></svg>`;
    case 'signature':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg>`;
    case 'fraud_review':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><circle cx="12" cy="11" r="3"></circle></svg>`;
    case 'agency_portal':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>`;
    case 'hrms':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;
    default:
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
  }
}

function getIntegrationFeatureTags(item) {
  const map = {
    microsoft_calendar: ['Teams Video Links', 'Outlook Calendar', 'Auto Invites'],
    email_communication: ['Domain Delivery', 'Status Webhooks', 'Consent Opt-out'],
    multi_ai: ['Skill Gap Analysis', 'JD Assistance', 'Smart Fallback'],
    resume_scanner: ['PDF & DOCX Parser', 'Magic-Byte Check', 'Quarantine Isolation'],
    signature: ['Legally Defensible PDF', 'Vector & Image Sign', 'SHA-256 Audit Hash'],
    fraud_review: ['Timeline Anomaly', 'Duplicate Detection', 'Risk Scoring'],
    agency_portal: ['Tenant Isolation', 'Job Assignments', 'Recruiter Portal'],
    hrms: ['Hire Handoff', 'Bearer / API Key Auth', 'Employee Sync']
  };
  return map[item.id] || (item.capabilities ? item.capabilities.slice(0, 3) : []);
}

function bindIntegrationsFilter() {
  const input = document.getElementById('int-search-input');
  const tabs = document.querySelectorAll('.int-tab-btn');
  const cards = document.querySelectorAll('.integration-card');
  if (!input || !cards.length) return;

  let activeFilter = 'all';

  const applyFilter = () => {
    const q = (input.value || '').trim().toLowerCase();
    cards.forEach(card => {
      const name = (card.querySelector('.int-name')?.textContent || '').toLowerCase();
      const desc = (card.querySelector('.int-desc')?.textContent || '').toLowerCase();
      const cat = (card.dataset.category || '').toLowerCase();
      const isExt = card.dataset.external === '1';
      const isAct = card.dataset.status === 'connected' || card.dataset.status === 'configured';

      let matchesTab = true;
      if (activeFilter === 'active') matchesTab = isAct;
      else if (activeFilter === 'external') matchesTab = isExt;
      else if (activeFilter === 'inhouse') matchesTab = !isExt;

      const matchesQuery = !q || name.includes(q) || desc.includes(q) || cat.includes(q);
      card.style.display = (matchesTab && matchesQuery) ? '' : 'none';
    });
  };

  input.addEventListener('input', applyFilter);
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilter = tab.dataset.filter;
      applyFilter();
    });
  });
}

async function openIntegrationConfigModal(integrationId) {
  try {
    const details = await api(`admin/integrations/${integrationId}`);
    const fields = details.fields || [];

    const advancedKeys = new Set([
      'timeoutMs', 'maxRetries', 'retryCount', 'externalTimestampingUrl',
      'webhookSecret', 'grokApiUrl', 'geminiApiUrl', 'anthropicApiUrl', 'openaiApiUrl',
      'antivirusEndpoint', 'partnerTermsUrl', 'resourcePath', 'mediumRiskThreshold',
      'highRiskThreshold', 'ownershipProtectionDays', 'maxSubmissionsPerRole', 'maxSizeBytes'
    ]);

    const isAdvanced = f => advancedKeys.has(f.key);
    const primaryFields = fields.filter(f => !isAdvanced(f));
    const advancedFields = fields.filter(f => isAdvanced(f));

    const renderField = f => {
      if (f.type === 'select') {
        const selectOpts = (f.options || []).map(o => {
          if (Array.isArray(o)) return o;
          if (o && typeof o === 'object') return [o.value, o.label || o.value];
          return [o, o];
        });
        return select(f.label, `cfg_${f.key}`, selectOpts, f.value ?? f.default, f.required);
      }
      if (f.type === 'checkbox') {
        return `<label class="full checkbox-row" style="cursor:pointer;background:var(--surface-alt);padding:10px 14px;border:1px solid var(--line);border-radius:8px;font-weight:600;"><input type="checkbox" name="cfg_${f.key}" ${f.value ? 'checked' : ''}> <span>${escape(f.label)}</span></label>`;
      }
      if (f.secret) {
        return `
          <div class="full int-secret-group" style="background:var(--surface-alt);border:1px solid var(--line);padding:12px 14px;border-radius:8px;margin-top:4px;">
            <label style="font-weight:600;display:block;">
              ${formatLabel(f.label, f.required && !f.hasSavedSecret)}
              <div class="int-secret-input-wrap" style="position:relative;margin-top:6px;">
                <input type="password" name="sec_${f.key}" id="sec_input_${f.key}" placeholder="${f.hasSavedSecret ? '•••••••• (Secret saved — enter new value to update)' : escape(f.placeholder || 'Enter secret')}" autocomplete="new-password" style="padding-right:42px;width:100%;font-family:monospace;">
                <button type="button" class="int-pwd-toggle" data-target="sec_input_${f.key}" title="Toggle secret visibility" aria-label="Toggle secret visibility">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                </button>
              </div>
            </label>
            <div class="int-secret-meta" style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:0.75rem;">
              <span class="muted">${f.hasSavedSecret ? '<span class="int-saved-badge">✓ Stored securely with AES-256-GCM encryption</span>' : '<span>Stored securely with AES-256-GCM authenticated encryption</span>'}</span>
              ${f.hasSavedSecret ? `<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--negative);font-size:0.75rem;"><input type="checkbox" name="remove_sec_${f.key}"> Remove credential</label>` : ''}
            </div>
          </div>
        `;
      }
      return field(f.label, `cfg_${f.key}`, f.type || 'text', f.value ?? '', f.required);
    };

    const formHtml = `
      <div class="int-modal-body">
        <div class="int-modal-hero">
          <div class="int-hero-left">
            <div class="int-hero-icon">${getIntegrationIcon(details.id)}</div>
            <div>
              <h3 class="int-hero-title">${escape(details.name)}</h3>
              <p class="int-hero-desc">${escape(details.description)}</p>
            </div>
          </div>
          <span class="int-status-pill int-status-${details.status === 'connected' ? 'connected' : (details.status === 'configured' ? 'configured' : 'ready')}">
            <span class="int-status-dot"></span>${escape(details.status || 'Ready')}
          </span>
        </div>

        <div class="int-toggle-banner">
          <div class="int-toggle-info">
            <strong>Enable Integration</strong>
            <span>Turn on to activate automated synchronization and live API calls</span>
          </div>
          <label class="int-switch">
            <input type="checkbox" name="__enabled" ${details.enabled ? 'checked' : ''}>
            <span class="int-slider"></span>
          </label>
        </div>

        <div class="form-grid">
          ${primaryFields.map(renderField).join('')}
        </div>

        ${advancedFields.length ? `
          <details class="int-modal-advanced">
            <summary>Advanced Settings (Timeouts, Retries & Endpoints)</summary>
            <div class="int-modal-advanced-content form-grid">
              ${advancedFields.map(renderField).join('')}
            </div>
          </details>
        ` : ''}

        <div class="int-modal-test-bar">
          <button type="button" class="button secondary" id="modal-inline-test-btn" data-id="${escape(details.id)}">⚡ Test Connection</button>
          <div id="modal-test-result" class="int-modal-test-msg muted">Verify connectivity and credentials before saving</div>
        </div>
      </div>
    `;

    modal(`Configure ${details.name}`, formHtml, async v => {
      const config = {};
      const secrets = {};
      const removeSecrets = [];
      const enabled = Boolean(v.__enabled);

      for (const f of fields.filter(f => !f.secret)) {
        if (f.type === 'checkbox') {
          config[f.key] = Boolean(v[`cfg_${f.key}`]);
        } else if (f.type === 'number') {
          config[f.key] = v[`cfg_${f.key}`] !== undefined && v[`cfg_${f.key}`] !== '' ? Number(v[`cfg_${f.key}`]) : f.default;
        } else {
          config[f.key] = v[`cfg_${f.key}`] !== undefined ? String(v[`cfg_${f.key}`]).trim() : '';
        }
      }

      for (const f of fields.filter(f => f.secret)) {
        if (v[`remove_sec_${f.key}`]) {
          removeSecrets.push(f.key);
        } else if (v[`sec_${f.key}`] && String(v[`sec_${f.key}`]).trim()) {
          secrets[f.key] = String(v[`sec_${f.key}`]).trim();
        }
      }

      await api(`admin/integrations/${integrationId}`, 'PUT', {
        enabled,
        config,
        secrets,
        removeSecrets
      });

      return `Saved settings for "${details.name}".`;
    });

    // Bind eye show/hide buttons
    document.querySelectorAll('.int-pwd-toggle').forEach(btn => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetId = btn.dataset.target;
        const inp = document.getElementById(targetId);
        if (!inp) return;
        if (inp.type === 'password') {
          inp.type = 'text';
          btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
        } else {
          inp.type = 'password';
          btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
        }
      };
    });

    // Bind inline Test Connection button
    const testBtn = document.getElementById('modal-inline-test-btn');
    const testResult = document.getElementById('modal-test-result');
    if (testBtn && testResult) {
      testBtn.onclick = async (e) => {
        e.preventDefault();
        testBtn.disabled = true;
        const origText = testBtn.innerHTML;
        testBtn.innerHTML = 'Testing…';
        testResult.className = 'int-modal-test-msg muted';
        testResult.textContent = 'Testing connection in progress…';
        try {
          const form = document.querySelector('#edit-form');
          const testConfig = {};
          const testSecrets = {};
          if (form) {
            const fd = new FormData(form);
            for (const [k, v] of fd.entries()) {
              if (k.startsWith('cfg_')) testConfig[k.replace('cfg_', '')] = v;
              if (k.startsWith('sec_') && v && String(v).trim()) {
                testSecrets[k.replace('sec_', '')] = String(v).trim();
              }
            }
          }
          const res = await api(`admin/integrations/${integrationId}/test`, 'POST', {
            config: testConfig,
            secrets: testSecrets
          });
          if (res.ok) {
            testResult.className = 'int-modal-test-msg ok';
            testResult.textContent = `✓ ${res.message || 'Connection verified successfully!'}`;
          } else {
            testResult.className = 'int-modal-test-msg err';
            testResult.textContent = `✗ ${res.message || 'Connection failed.'}`;
          }
        } catch (err) {
          testResult.className = 'int-modal-test-msg err';
          testResult.textContent = `✗ ${err.message}`;
        } finally {
          testBtn.disabled = false;
          testBtn.innerHTML = origText;
        }
      };
    }
  } catch (err) {
    notice(err.message, 'error');
  }
}

async function runIntegrationConnectionTest(integrationId) {
  notice(`Running live connection test for ${integrationId}...`, 'info');
  try {
    const res = await api(`admin/integrations/${integrationId}/test`, 'POST', {});
    if (res.ok) {
      modal('Connection Test Succeeded', `
        <div class="notice-inline" style="border-left-color:var(--positive);background:var(--positive-bg);color:var(--positive);">
          <strong>✓ Connection Verified</strong>
          <p style="margin:6px 0 0;color:var(--ink);">${escape(res.message)}</p>
        </div>
        ${res.details ? `<div style="margin-top:14px;"><strong style="font-size:0.85rem;">Diagnostic Response:</strong><pre class="mono" style="background:var(--surface-alt);border:1px solid var(--line);padding:12px;border-radius:8px;font-size:0.82rem;overflow-x:auto;margin-top:6px;">${escape(JSON.stringify(res.details, null, 2))}</pre></div>` : ''}
      `);
      notice('Connection test passed.', 'success');
    } else {
      modal('Connection Test Failed', `
        <div class="notice-inline danger-notice">
          <strong>✗ Connection Failed</strong>
          <p style="margin:6px 0 0;">${escape(res.message)}</p>
        </div>
        <p class="muted" style="font-size:0.85rem;margin-top:12px;">Please check the integration configuration, verify that your credentials or endpoints are valid, and confirm that required external network access is available.</p>
      `);
      notice('Connection test failed. Review diagnostic summary.', 'error');
    }
    await render();
  } catch (err) {
    modal('Test Execution Error', `
      <div class="notice-inline danger-notice">
        <strong>✗ Test Request Failed</strong>
        <p style="margin:6px 0 0;">${escape(err.message)}</p>
      </div>
    `);
    notice(err.message, 'error');
  }
}

async function toggleIntegrationEnabled(integrationId, newEnabled) {
  try {
    await api(`admin/integrations/${integrationId}/toggle`, 'POST', { enabled: newEnabled });
    notice(`Integration ${newEnabled ? 'activated' : 'deactivated'} successfully.`, 'success');
    await render();
  } catch (err) {
    notice(err.message, 'error');
  }
}

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
    if(a==='clear-candidate-search'){candidateQuery='';pageState.Candidates=1;await render();return;}
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
    if(a==='refresh-integrations'){await render();return;}
    if(a==='configure-integration'){await openIntegrationConfigModal(id);return;}
    if(a==='test-integration'){await runIntegrationConnectionTest(id);return;}
    if(a==='toggle-integration'){
      const newEnabled = b.dataset.enabled === '1';
      await toggleIntegrationEnabled(id, newEnabled);
      return;
    }
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
      const title=String(form.elements.title.value||'').trim();
      if(!title){
        const el=$('#title-error');if(el)el.textContent='Enter a position title before drafting a job description.';
        form.elements.title.focus();
        throw new Error('Enter a position title before drafting a job description.');
      }
      const sErr=checkSkills(form.elements.skills.value);
      if(sErr){
        const el=$('#skills-error');if(el)el.textContent=sErr;
        const inp=form.elements.skills;if(inp){inp.setCustomValidity(sErr);inp.reportValidity();}
        throw new Error(sErr);
      }
      if(!String(form.elements.skills.value||'').trim()){
        const el=$('#skills-error');if(el)el.textContent='Add at least one required skill before drafting a job description.';
        const inp=form.elements.skills;if(inp){inp.setCustomValidity('Add at least one required skill before drafting a job description.');inp.reportValidity();inp.focus();}
        throw new Error('Add at least one required skill before drafting a job description.');
      }
      if(String(form.elements.description.value||'').trim()&&!window.confirm('Replace the current job description with a new draft? Select Cancel to keep the existing description.'))return;
      const result=await api('jd/draft','POST',{title,skills:skills(form.elements.skills.value)});
      form.elements.description.value=result.draft;
      form.elements.description.dispatchEvent(new Event('input',{bubbles:true}));
      notice(result.message||'Job description drafted. Please review before saving.','success');
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
    if(a==='req-details'){
      const readOnly=b.dataset.readonly==='true';
      const r=(readOnly&&b.dataset.referralId)?await api(`referrals/${b.dataset.referralId}/requisition`):((await api('requisitions')).find(r=>r.id===id)||await api(`requisitions/${id}`));
      modal(r.title,requisitionDetail(r,{readOnly}));
    }
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
      },{ actions: formActions({ deleteAction:'delete-req', deleteId:id }) });
      bindValidation('currency',checkCurrency);
      bindValidation('skills',checkSkills);
      bindSalaryInput('salary_min');
      bindSalaryInput('salary_max');
    }
    if(a==='delete-req'){
      const r=(await api('requisitions')).find(item=>item.id===id)||await api(`requisitions/${id}`);
      if(!r)throw new Error('Requisition not found.');
      if(!['draft','open'].includes(r.status))throw new Error(`Requisitions with status ${r.status} cannot be deleted because workflow history or approvals must be retained.`);
      deleteDialog('requisition',`${r.title} (${r.team})`,'This removes the requisition from active lists. Applications, interviews, approvals and referrals are dependencies and will block deletion rather than be removed silently.',`requisitions/${id}`,'Requisition deleted successfully.');
    }
    if(a==='new-candidate'){
      const cached = Array.isArray(window._cachedOpenReqs) ? window._cachedOpenReqs : [];
      const reqOptions = [['', 'None (Candidate pool only)'], ...cached.map(r => [r.id, `${r.title} — ${r.id} (${r.team})`])];
      const uploadWidget = `<div class="resume-upload-box full" style="border:1px dashed var(--line);border-radius:8px;padding:12px 14px;background:var(--surface-alt);margin-bottom:8px;"><label style="display:flex;flex-direction:column;gap:6px;cursor:pointer;"><span class="label-heading">Upload resume (PDF or DOCX) <span class="field-optional">Optional</span></span><input type="file" id="resume-file-input" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style="font-size:0.85rem;"><input type="hidden" name="resume_id" id="resume-id-input" value=""></label><div id="resume-upload-status" class="muted" style="margin-top:6px;font-size:0.83rem;" aria-live="polite">Upload a PDF or DOCX file to automatically extract text for review.</div></div>`;
      modal('Add candidate',`<div class="form-grid">${uploadWidget}${field('Full name','name')}${field('Email','email','email')}${field('Phone','phone','tel','',false)}${teamSelect('Team','team',me.team||'Dev',false)}${select('Associated requisition','requisition_id',reqOptions,'',false)}${field('Skills, comma separated','skills','text','',false)}${field('Source','source','text','Direct')}${area('Experience / Resume text','resume_text')}</div>${button('Extract email and phone','parse-resume','','class="secondary"')}`,async v=>{
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
        await api('candidates','POST',{...v,skills:skills(v.skills),experience:v.resume_text,resume_id:v.resume_id||undefined,requisition_id:v.requisition_id||undefined});
        return v.requisition_id ? 'Candidate created and added to pipeline (Applied stage).' : 'Candidate created successfully.';
      });
      api('requisitions').then(rs => {
        if (!Array.isArray(rs)) return;
        const open = rs.filter(r => r.status === 'open');
        window._cachedOpenReqs = open;
        const sel = $('#edit-form select[name="requisition_id"]');
        if (sel) {
          const curVal = sel.value;
          sel.innerHTML = `<option value="">None (Candidate pool only)</option>` +
            open.map(r => `<option value="${escape(r.id)}" ${r.id === curVal ? 'selected' : ''}>${escape(r.title)} — ${escape(r.id)} (${escape(r.team)})</option>`).join('');
        }
      }).catch(() => {});
      bindValidation('email',checkEmail);
      bindValidation('phone',checkPhone);
      bindValidation('skills',checkSkills);
      bindResumeUpload();
    }
    if(a==='edit-candidate'){
      let c=(await api('candidates')).find(c=>c.id===id);
      if(!c||!Array.isArray(c.applications)){
        c=await api(`candidates/${id}`);
      }
      if(!c)throw new Error('Candidate not found.');
      const inPipeline = Boolean((c.applications && c.applications.length > 0) || c.can_delete === false);
      const currentResumeNote = c.resume ? `Current attached resume: <strong>${escape(c.resume.filename)}</strong> (${escape(c.resume.file_format.toUpperCase())}, ${Math.round(c.resume.file_size/1024)} KB)` : 'Upload a PDF or DOCX file to automatically extract text for review.';
      const uploadWidget = `<div class="resume-upload-box full" style="border:1px dashed var(--line);border-radius:8px;padding:12px 14px;background:var(--surface-alt);margin-bottom:8px;"><label style="display:flex;flex-direction:column;gap:6px;cursor:pointer;"><span class="label-heading">Upload / replace resume (PDF or DOCX) <span class="field-optional">Optional</span></span><input type="file" id="resume-file-input" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style="font-size:0.85rem;"><input type="hidden" name="resume_id" id="resume-id-input" value="${c.resume?.id || ''}"></label><div id="resume-upload-status" class="muted" style="margin-top:6px;font-size:0.83rem;" aria-live="polite">${currentResumeNote}</div></div>`;
      modal('Edit candidate',`<div class="form-grid">${uploadWidget}${field('Full name','name','text',c.name)}${field('Email','email','email',c.email)}${field('Phone','phone','tel',c.phone||'',false)}${teamSelect('Team','team',c.team||me.team||'Dev',false)}${field('Skills, comma separated','skills','text',(c.skills||[]).join(', '),false)}${field('Source','source','text',c.source||'Direct')}${area('Experience / Resume text','resume_text',c.resume_text||c.experience||'')}</div>${button('Extract email and phone','parse-resume','','class="secondary"')}`,async v=>{
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
        await api(`candidates/${id}`,'PUT',{...v,skills:skills(v.skills),experience:v.resume_text,resume_id:v.resume_id||undefined});
        return 'Candidate updated successfully.';
      },{ actions: formActions({ deleteAction: inPipeline ? '' : 'delete-candidate', deleteId: id }) });
      bindValidation('email',checkEmail);
      bindValidation('phone',checkPhone);
      bindValidation('skills',checkSkills);
      bindResumeUpload();
    }
    if(a==='delete-candidate'){
      const c=(await api('candidates')).find(item=>item.id===id)||await api(`candidates/${id}`);
      if(!c)throw new Error('Candidate not found.');
      const inPipeline = Boolean((c.applications && c.applications.length > 0) || c.can_delete === false);
      if(inPipeline){
        throw new Error('Candidates in the pipeline cannot be deleted. Retain the candidate to preserve application history.');
      }
      deleteDialog('candidate',`${c.name} (${c.email})`,'This removes the candidate from active lists. Applications and interviews are dependencies and will block deletion rather than be removed silently.',`candidates/${id}`,'Candidate deleted successfully.');
    }
    if(a==='parse-resume'){
      const form=$('#edit-form');
      const r=await api('resume/parse','POST',{text:form.elements.resume_text.value});
      if(r.email){form.elements.email.value=r.email;form.elements.email.dispatchEvent(new Event('input'));}
      if(r.phone){form.elements.phone.value=r.phone;form.elements.phone.dispatchEvent(new Event('input'));}
      if(r.name && form.elements.name && !form.elements.name.value.trim()){form.elements.name.value=r.name;form.elements.name.dispatchEvent(new Event('input'));}
      if(r.skills && r.skills.length && form.elements.skills && !form.elements.skills.value.trim()){form.elements.skills.value=Array.isArray(r.skills)?r.skills.join(', '):r.skills;form.elements.skills.dispatchEvent(new Event('input'));}
      const hasExtracted=Boolean(r.email||r.phone||r.name||(r.skills&&r.skills.length));
      notice((r.email||r.phone)?'Email and phone number extracted successfully.':(r.message||'No email or phone number found in resume text.'),hasExtracted?'success':'error');
    }
    if(a==='candidate-details'){
      const [c, commsData, fraudData, sigData] = await Promise.all([
        (async () => (await api('candidates')).find(c=>c.id===id)||await api(`candidates/${id}`))(),
        api(`candidates/${id}/communications`).catch(() => ({ consent: { opted_out: false }, communications: [] })),
        api(`candidates/${id}/fraud-review`).catch(() => null),
        api(`candidates/${id}/signatures`).catch(() => [])
      ]);
      const appsHtml=(c.applications&&c.applications.length)?`<h3>Applications & Status</h3><div class="candidate-status-list" style="margin-bottom:14px;">${c.applications.map(app=>{const title=escape(app.title||'General Application');return `<div class="candidate-status-pair"><span class="candidate-status-role" title="${title}">${title}</span> <span class="status-sep" aria-hidden="true">—</span> ${badge(app.stage||'Applied')}</div>`;}).join('')}</div>`:'';
      const resumeHtml=c.resume?`<div class="resume-info" style="margin:10px 0;padding:10px 12px;background:var(--surface-alt);border:1px solid var(--line);border-radius:8px;font-size:0.85rem;"><span class="muted">Attached resume:</span> <strong>${escape(c.resume.filename)}</strong> <span class="badge clean" style="margin-left:6px;font-size:0.75rem;">${escape(c.resume.file_format.toUpperCase())}</span> <span class="muted">(${Math.round(c.resume.file_size/1024)} KB)</span></div>`:'';
      const consent = commsData.consent || { opted_out: false };
      const commsList = commsData.communications || [];
      const consentBadge = consent.opted_out
        ? `<span class="badge rejected" style="margin-left:8px;font-size:0.75rem;">Opted out of email</span>`
        : `<span class="badge active" style="margin-left:8px;font-size:0.75rem;">Subscribed to email</span>`;
      const commsHtml = commsList.length
        ? `<div class="comms-history" style="margin-top:14px;"><h3>Recent Communications</h3><div class="table-wrap"><table class="comms-table"><thead><tr><th scope="col">Subject</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead><tbody>${commsList.slice(0, 5).map(m=>`<tr><td><strong>${escape(m.subject)}</strong></td><td>${badge(m.status)}</td><td><small class="muted">${new Date(m.created_at).toLocaleDateString()}</small></td></tr>`).join('')}</tbody></table></div></div>`
        : '';

      let signaturesHtml = '';
      const sigList = Array.isArray(sigData) ? sigData : [];
      const hasCompleted = sigList.some(s => s.status === 'completed');
      const hasActivePending = sigList.some(s => s.status === 'pending' || s.status === 'viewed');
      const candApps = c.applications || [];
      const hasApps = candApps.length > 0;
      const signatureState = signatureEligibility(candApps);
      const isRejected = !signatureState.eligible;

      let agreementCardsHtml = '';
      if (sigList.length > 0) {
        agreementCardsHtml = sigList.map(s => {
          const isDone = s.status === 'completed';
          const isPending = s.status === 'pending' || s.status === 'viewed';
          const isCancelled = s.status === 'cancelled';
          const isDeclined = s.status === 'declined';

          let statusBadge = '';
          let metaText = '';

          if (isDone) {
            statusBadge = `<span class="badge completed" style="font-size:0.72rem;padding:2px 7px;">✓ Signed & Executed</span>`;
            const signedAtStr = (s.signers && s.signers[0]?.signed_at)
              ? new Date(s.signers[0].signed_at).toLocaleDateString()
              : new Date(s.updated_at || s.created_at).toLocaleDateString();
            metaText = `Executed on ${signedAtStr} · Cryptographically verified SHA-256`;
          } else if (isPending) {
            let validityNote = '';
            if (s.expires_at) {
              const expDate = new Date(s.expires_at);
              const diffMs = expDate.getTime() - Date.now();
              const diffDays = Math.ceil(diffMs / 86400000);
              const daysText = diffDays > 0 ? `${diffDays}d remaining` : 'Expired';
              validityNote = ` · Valid until ${expDate.toLocaleDateString()} (${daysText})`;
            }
            if (s.status === 'viewed') {
              statusBadge = `<span class="badge viewed" style="font-size:0.72rem;padding:2px 7px;">👁️ Viewed by Signer</span>`;
              metaText = `Created ${new Date(s.created_at).toLocaleDateString()}${validityNote} · Awaiting execution`;
            } else {
              statusBadge = `<span class="badge pending" style="font-size:0.72rem;padding:2px 7px;">⏳ Awaiting Signature</span>`;
              metaText = `Created ${new Date(s.created_at).toLocaleDateString()}${validityNote}`;
            }
          } else if (isCancelled) {
            statusBadge = `<span class="badge rejected" style="font-size:0.72rem;padding:2px 7px;">Cancelled</span>`;
            metaText = `Cancelled on ${new Date(s.updated_at || s.created_at).toLocaleDateString()}`;
          } else if (isDeclined) {
            statusBadge = `<span class="badge rejected" style="font-size:0.72rem;padding:2px 7px;">Declined</span>`;
            metaText = `Declined by candidate`;
          } else {
            statusBadge = badge(s.status);
            metaText = `Created ${new Date(s.created_at).toLocaleDateString()}`;
          }

          // Document action button:
          const docAction = isDone
            ? `<a href="/api/signatures/${s.id}/document?version=signed" target="_blank" class="button" style="font-size:0.78rem;padding:5px 12px;">Download Signed PDF</a>`
            : `<a href="/api/signatures/${s.id}/document?version=original" target="_blank" class="button secondary" style="font-size:0.78rem;padding:5px 12px;">View Document</a>`;

          // Resend email invitation button:
          const sendEmailBtn = (isPending && allows('recruit'))
            ? `<button type="button" class="button secondary" data-action="resend-sig-email" data-id="${s.id}" data-candidate-id="${c.id}" style="font-size:0.78rem;padding:5px 11px;" title="Invitation email was dispatched upon request creation. Click to resend to candidate.">✉️ Resend Email</button>`
            : '';

          // Copy sign link ONLY if pending/viewed - NEVER when completed, cancelled, or declined
          const firstSigner = (s.signers && s.signers[0]) || null;
          const copyLinkBtn = (isPending)
            ? `<button type="button" class="button secondary" data-action="copy-sig-link" data-id="${s.id}" data-token="${escape(firstSigner?.token || '')}" style="font-size:0.78rem;padding:5px 11px;" title="Copy secure electronic signing link">📋 Copy Link</button>`
            : '';

          // Cancel action ONLY if pending/viewed
          const cancelBtn = (isPending && allows('recruit'))
            ? `<button type="button" class="secondary text-button" data-action="cancel-signature-request" data-id="${s.id}" data-candidate-id="${c.id}" style="font-size:0.78rem;color:var(--negative);padding:0 6px;">Cancel</button>`
            : '';

          const itemClass = isDone ? 'completed' : (isPending ? 'pending' : (isCancelled ? 'cancelled' : 'declined'));

          return `
            <div class="sig-agreement-item ${itemClass}">
              <div class="sig-item-info">
                <div class="sig-item-title-row">
                  <span class="sig-item-title">${escape(s.title)}</span>
                  ${statusBadge}
                </div>
                <div class="sig-item-meta">${metaText}</div>
              </div>
              <div class="sig-item-actions">
                ${docAction}
                ${sendEmailBtn}
                ${copyLinkBtn}
                ${cancelBtn}
              </div>
            </div>
          `;
        }).join('');
      } else {
        if (isRejected) {
          agreementCardsHtml = `<div class="sig-empty-state">${escape(signatureState.reason)}</div>`;
        } else if (!hasApps) {
          agreementCardsHtml = `<div class="sig-empty-state">No e-signature agreements created for this candidate yet. General documents can still be sent without an application.</div>`;
        } else {
          agreementCardsHtml = `<div class="sig-empty-state">No e-signature agreements created for this candidate yet.</div>`;
        }
      }

      // Action footer guidance
      let footerActionHtml = '';
      if (allows('recruit')) {
        if (isRejected) {
          if (sigList.length > 0) {
            footerActionHtml = `
              <div class="sig-action-footer">
                <span class="sig-status-notice" style="color:var(--negative);font-weight:550;">✕ ${escape(signatureState.reason)} Offer agreements are unavailable</span>
              </div>
            `;
          }
        } else if (!hasApps) {
          if (sigList.length > 0) {
            footerActionHtml = `
              <div class="sig-action-footer">
                <span class="sig-status-notice muted" style="font-size:0.83rem;">Candidate is in the talent pool without an application. General documents can still be sent.</span>
              </div>
            `;
          }
        } else if (hasCompleted) {
          footerActionHtml = `
            <div class="sig-action-footer">
              <span class="sig-status-notice" style="color:var(--positive);font-weight:550;">✓ Offer agreement completed and legally executed</span>
              <button type="button" class="secondary text-button" data-action="new-signature-request" data-id="${c.id}" style="font-size:0.78rem;color:var(--muted);">+ Send Additional Document</button>
            </div>
          `;
        } else if (hasActivePending) {
          footerActionHtml = `
            <div class="sig-action-footer">
              <span class="sig-status-notice" style="color:var(--warning);font-weight:550;">⏳ Offer letter is currently awaiting candidate signature</span>
              <span class="muted" style="font-size:0.75rem;">To send a revised offer, cancel the pending request above first.</span>
            </div>
          `;
        } else {
          footerActionHtml = `
            <div class="sig-action-footer" style="justify-content:flex-start;">
              <button type="button" class="button secondary" data-action="new-signature-request" data-id="${c.id}" style="font-size:0.82rem;">+ Create Offer / Signature Request</button>
            </div>
          `;
        }
      }

      const totalBadge = isRejected
        ? `<span class="badge rejected" style="font-size:0.74rem;">${signatureState.reason.includes('withdrawn application') ? 'Withdrawn' : 'Rejected'}</span>`
        : (hasCompleted
          ? `<span class="badge completed" style="font-size:0.74rem;">✓ Executed</span>`
          : (hasActivePending
            ? `<span class="badge pending" style="font-size:0.74rem;">⏳ Pending Signature</span>`
            : (!hasApps
              ? `<span class="badge draft" style="font-size:0.74rem;">No Application</span>`
              : (sigList.length ? `<span class="badge rejected" style="font-size:0.74rem;">Inactive</span>` : `<span class="badge draft" style="font-size:0.74rem;">0 Agreements</span>`))));

      signaturesHtml = `
        <div class="signature-agreements-card">
          <div class="sig-card-header">
            <h3>E-Signature & Offer Agreements</h3>
            ${totalBadge}
          </div>
          <div class="sig-agreements-list">
            ${agreementCardsHtml}
          </div>
          ${footerActionHtml}
        </div>
      `;

      let fraudHtml = '';
      if (fraudData) {
        const riskBadge = fraudData.risk_level === 'high'
          ? `<span class="badge rejected">High Risk</span>`
          : fraudData.risk_level === 'medium'
            ? `<span class="badge" style="background:var(--amber-bg,#fef3c7);color:var(--amber-text,#92400e);">Medium Risk</span>`
            : `<span class="badge active">Low Risk</span>`;
        const statusBadge = fraudData.status === 'resolved' || fraudData.status === 'cleared'
          ? `<span class="badge active">${escape(fraudData.status.toUpperCase())}</span>`
          : `<span class="badge" style="background:var(--amber-bg,#fef3c7);color:var(--amber-text,#92400e);">${escape(fraudData.status.toUpperCase())}</span>`;
        const flags = fraudData.flags || [];
        const flagsList = flags.length
          ? `<div class="fraud-flags-list" style="margin-top:8px;">${flags.map(f=>`
              <div class="fraud-flag-item" style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-bottom:6px;background:var(--surface);">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                  <strong>${escape(f.title)}</strong>
                  <span class="badge ${f.severity==='high'?'rejected':'pending'}" style="font-size:0.75rem;">${escape(f.severity.toUpperCase())}</span>
                </div>
                <p style="font-size:0.85rem;margin:4px 0 2px;">${escape(f.description)}</p>
                <p class="muted" style="font-size:0.8rem;margin:2px 0;"><strong>Evidence:</strong> ${escape(f.evidence)}</p>
                <p class="muted" style="font-size:0.8rem;margin:2px 0;"><em>Recommendation:</em> ${escape(f.recommendation)}</p>
              </div>
            `).join('')}</div>`
          : `<p class="muted" style="font-size:0.85rem;margin-top:6px;">No potential inconsistencies or duplicate signals detected.</p>`;

        const reviewerNote = fraudData.resolution_notes
          ? `<p class="score-note" style="margin-top:6px;font-size:0.85rem;"><strong>Reviewer notes (${escape(fraudData.reviewer?.name || 'Reviewer')}):</strong> ${escape(fraudData.resolution_notes)}</p>`
          : '';

        const resolveAction = (allows('recruit') || allows('admin'))
          ? button(fraudData.status === 'pending' ? 'Review & resolve flags' : 'Update review decision', 'resolve-fraud', c.id, 'class="secondary" style="margin-top:8px;font-size:0.82rem;"')
          : '';

        fraudHtml = `
          <div class="fraud-review-card" style="margin:14px 0;padding:12px 14px;background:var(--surface-alt);border:1px solid var(--line);border-radius:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
              <h3 style="margin:0;font-size:0.95rem;">Fraud & Inconsistency Review</h3>
              <div style="display:inline-flex;gap:6px;">${riskBadge} ${statusBadge}</div>
            </div>
            ${flagsList}
            ${reviewerNote}
            ${resolveAction}
            <p class="muted" style="font-size:0.78rem;margin-top:8px;margin-bottom:0;">Safeguard: Signals are review indicators for human verification, not proof of fraud. Never disqualify candidates automatically based solely on risk flags.</p>
          </div>
        `;
      }

      const showFooterOfferBtn = allows('recruit') && signatureState.eligible && !hasCompleted && !hasActivePending;
      const offerFooterBtn = showFooterOfferBtn ? button('Offer & E-Sign','new-signature-request',c.id,'class="secondary" style="margin-right:8px;"') : '';
      const emailAction = allows('recruit') ? `${offerFooterBtn}${button('Send email','send-candidate-email',c.id,'class="primary" style="margin-right:8px;"')}${button('Edit','edit-candidate',c.id,'class="secondary"')}` : '';
      modal(c.name,`<p>${escape(c.email)}${c.phone?` · ${escape(c.phone)}`:''}${consentBadge}</p><p>${escape((c.skills||[]).join(', '))}</p>${appsHtml}${resumeHtml}${signaturesHtml}<h3>Experience / Resume</h3><p class="score-note">${escape(c.resume_text||c.experience||'No resume text provided.')}</p>${fraudHtml}${commsHtml}${emailAction?`<div class="actions" style="margin-top:16px">${emailAction}</div>`:''}`);
    }
    if(a==='send-candidate-email'){
      const formKey = `comm_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const [templateData, commsData] = await Promise.all([
        api(`candidates/${id}/templates`),
        api(`candidates/${id}/communications`).catch(() => ({ consent: { opted_out: false } }))
      ]);
      const c = templateData.candidate;
      const isOptedOut = Boolean(commsData.consent?.opted_out);
      const apps = templateData.applications || [];
      const appOptions = apps.map(app => [app.requisition_id, `${app.title} (${app.stage})`]);
      if (!appOptions.length) appOptions.push(['', 'General Inquiry (No active application)']);
      const tplOptions = (templateData.templates || []).map(t => [t.id, `${t.name}${t.isEssential ? ' (Operational)' : ''}`]);

      const optOutWarning = isOptedOut
        ? `<div class="notice-inline error" style="margin-bottom:12px;"><strong>Candidate is opted out:</strong> Non-essential recruitment emails will be rejected. Only operational interview and offer templates are permitted.</div>`
        : '';

      const formHtml = `
        ${optOutWarning}
        <div class="form-grid">
          <p class="full"><strong>Recipient:</strong> ${escape(c.name)} &lt;${escape(c.email)}&gt;</p>
          ${select('Email template', 'template_id', tplOptions, 'application_acknowledgement')}
          ${select('Associated job / application', 'requisition_id', appOptions, appOptions[0]?.[0] || '')}
          ${field('Custom Subject (Leave blank for default)', 'subject', 'text', '', false)}
          ${area('Additional notes or details (Optional)', 'notes', '', false)}
        </div>
      `;

      modal(`Send email to ${c.name}`, formHtml, async v => {
        const payload = {
          candidate_id: id,
          template_id: v.template_id,
          requisition_id: v.requisition_id || undefined,
          subject: v.subject?.trim() || undefined,
          notes: v.notes?.trim() || undefined,
          idempotency_key: formKey
        };
        const res = await api(`candidates/${id}/communications`, 'POST', payload);
        return `Email sent to ${c.email} (Status: ${res.status}).`;
      }, { saveLabel: 'Send Email' });
    }
    if(a==='new-application'){
      const [cs,rs]=await Promise.all([api('candidates'),api('requisitions')]);
      const openReqs=rs.filter(r=>r.status==='open');
      if(!cs.length||!openReqs.length)throw new Error('Add a candidate and approve a requisition first.');
      modal('Add application',searchableSelect('Candidate','candidate_id',cs.map(c=>[c.id,`${c.name} — ${c.email}`]),'',true,'Search by name or email')+searchableSelect('Open requisition','requisition_id',openReqs.map(r=>[r.id,`${r.title} — ${r.id} — ${r.team}`]),'',true,'Search by title, ID or team'),async v=>{
        await api('applications','POST',v);
        return 'Application created successfully.';
      });
      bindSearchableSelect('candidate_id');
      bindSearchableSelect('requisition_id');
    }
    if(a==='move'||a==='reject-app'){
      const stage=a==='move'?b.dataset.stage:'Rejected';
      const isBackMove = b && typeof b.textContent === 'string' && b.textContent.trim().startsWith('Back to');
      if(a==='move' && stage==='Interview' && !isBackMove){
        const [apps, users] = await Promise.all([api('applications'), api('interviewers')]);
        const app = apps.find(x => x.id === id);
        if(!app) throw new Error('Application not found.');
        if(!users.length) throw new Error('No active interviewers found in this team. Add or activate an interviewer first.');
        const todayMin = getLocalTodayMin();
        const tomorrow = new Date(Date.now() + 86400000);
        tomorrow.setHours(10, 0, 0, 0);
        const defaultScheduled = `${getLocalDateString(tomorrow)}T10:00`;
        const defaultInterviewer = users.some(u => u.id === me.id) ? me.id : (users[0]?.id || '');
        let defaultComps = 'Role knowledge, Problem solving';
        if (app.skills) {
          try {
            const s = typeof app.skills === 'string' ? JSON.parse(app.skills) : app.skills;
            if (Array.isArray(s) && s.length) defaultComps = s.slice(0, 3).join(', ');
          } catch {}
        }
        modal(`Schedule Interview — ${escape(app.name)}`, `
          <div class="form-grid">
            <div class="full" style="background:var(--surface-alt, #f8fafc);padding:10px 14px;border-radius:6px;border:1px solid var(--line, #e2e8f0);margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                <div><strong>Candidate:</strong> ${escape(app.name)} <span class="muted">(${escape(app.email)})</span></div>
                <div><strong>Position:</strong> ${escape(app.title)}</div>
              </div>
            </div>
            ${select('Interviewer', 'interviewer_id', users.map(u => [u.id, `${u.name}${u.team ? ' (' + u.team + ')' : ''}`]), defaultInterviewer)}
            ${field('Date and time (your timezone)', 'scheduled_at', 'datetime-local', defaultScheduled, true, `min="${todayMin}"`)}
            ${select('Duration', 'duration_minutes', [['30', '30 minutes'], ['45', '45 minutes (Standard)'], ['60', '60 minutes'], ['90', '90 minutes']], '45', false)}
            ${field('Meeting link / Video URL (Optional)', 'meeting_url', 'url', '', false, 'placeholder="Auto-generated via Teams when connected, or paste Google Meet / Zoom link"')}
            ${field('Competencies, comma separated', 'competencies', 'text', defaultComps, true)}
            ${area('Agenda / Notes (Optional)', 'notes', '', false)}
            <p class="full status-note">Orbit will advance the application to <strong>Interview</strong>, synchronize the Microsoft Teams calendar event (or use your provided meeting link), and automatically dispatch an invitation email with meeting details and schedule link to <strong>${escape(app.email)}</strong>.</p>
          </div>
        `, async v => {
          const scheduledDate = new Date(v.scheduled_at);
          if (!Number.isFinite(scheduledDate.getTime()) || scheduledDate.getTime() < Date.now()) {
            throw new Error('Enter a future interview date.');
          }
          const sErr = checkSkills(v.competencies);
          if (sErr) {
            const el = $('#competencies-error'); if (el) el.textContent = sErr;
            const inp = $('#edit-form [name="competencies"]'); if (inp) { inp.setCustomValidity(sErr); inp.reportValidity(); }
            throw new Error(sErr);
          }
          const compList = skills(v.competencies);
          if (!compList.length) throw new Error('At least one competency is required.');
          await api('interviews', 'POST', {
            application_id: id,
            interviewer_id: v.interviewer_id,
            scheduled_at: scheduledDate.toISOString(),
            duration_minutes: Number(v.duration_minutes) || 45,
            meeting_url: v.meeting_url?.trim() || undefined,
            competencies: compList,
            notes: v.notes?.trim() || undefined
          });
          await api(`applications/${id}/stage`, 'POST', { stage: 'Interview', send_notification: false });
          const interviewerObj = users.find(u => u.id === v.interviewer_id);
          const interviewerName = interviewerObj ? interviewerObj.name : 'assigned interviewer';
          notice(`Interview scheduled with ${interviewerName}. Invitation email with meeting link sent to ${app.name}!`, 'success');
          return `Interview scheduled with ${interviewerName}. Application moved to Interview and invitation email sent to ${app.name}.`;
        }, { saveLabel: 'Schedule & Send Invite' });
        const dateInp = $('#edit-form [name="scheduled_at"]');
        if (dateInp) dateInp.min = todayMin;
        bindValidation('competencies', checkSkills);
        return;
      }
      if(a==='move' && stage==='Offer' && !isBackMove){
        const [apps, reqs] = await Promise.all([api('applications'), api('requisitions')]);
        const app = apps.find(x => x.id === id);
        if(!app) throw new Error('Application not found.');
        const req = reqs.find(r => r.id === app.requisition_id);
        const defaultSalary = req?.salary_max
          ? Number(req.salary_max).toLocaleString()
          : (req?.salary_min ? Number(req.salary_min).toLocaleString() : '120,000');
        const defaultCurrency = req?.currency || 'USD';
        modal(`Verify Offer & Issue Agreement — ${escape(app.name)}`, `
          <div class="form-grid">
            <div class="full" style="background:var(--surface-alt, #f8fafc);padding:10px 14px;border-radius:6px;border:1px solid var(--line, #e2e8f0);margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                <div><strong>Candidate:</strong> ${escape(app.name)} <span class="muted">(${escape(app.email)})</span></div>
                <div><strong>Requisition:</strong> ${escape(req?.title || app.title)} ${req?.team ? '<span class="muted">(' + escape(req.team) + ')</span>' : ''}</div>
              </div>
            </div>
            ${field('Document title', 'title', 'text', 'Employment Offer Letter', true)}
            ${field('Signer legal name', 'signer_name', 'text', app.name, true)}
            ${field('Signer email address', 'signer_email', 'email', app.email, true)}
            ${field('Annual base salary', 'salary', 'text', defaultSalary, true)}
            ${field('Currency', 'currency', 'text', defaultCurrency, true)}
            ${field('Anticipated start date', 'start_date', 'text', 'Two weeks following signature acceptance', true)}
            ${field('Offer expiration (days)', 'expires_days', 'number', '7', true)}
            <p class="full status-note">Orbit will advance the application to <strong>Offer</strong>, generate an official PDF offer letter with SHA-256 cryptographic integrity verification, and automatically dispatch the e-signature invitation email with a secure signing link to <strong>${escape(app.email)}</strong>.</p>
          </div>
        `, async v => {
          const emailErr = checkEmail(v.signer_email);
          if (emailErr) {
            const el = $('#signer_email-error'); if (el) el.textContent = emailErr;
            const inp = $('#edit-form [name="signer_email"]'); if (inp) { inp.setCustomValidity(emailErr); inp.reportValidity(); }
            throw new Error(emailErr);
          }
          const currErr = checkCurrency(v.currency);
          if (currErr) {
            const el = $('#currency-error'); if (el) el.textContent = currErr;
            const inp = $('#edit-form [name="currency"]'); if (inp) { inp.setCustomValidity(currErr); inp.reportValidity(); }
            throw new Error(currErr);
          }
          const payload = {
            title: v.title?.trim() || 'Employment Offer Letter',
            candidate_id: app.candidate_id,
            application_id: app.id,
            requisition_id: app.requisition_id || undefined,
            salary: v.salary?.trim() || defaultSalary,
            currency: v.currency?.trim()?.toUpperCase() || defaultCurrency,
            start_date: v.start_date?.trim() || 'Two weeks following signature acceptance',
            expires_days: Number(v.expires_days) || 7,
            signers: [{
              name: v.signer_name?.trim() || app.name,
              email: v.signer_email?.trim() || app.email,
              role: 'Candidate'
            }]
          };
          await api('signatures', 'POST', payload);
          await api(`applications/${id}/stage`, 'POST', { stage: 'Offer', send_notification: false });
          notice(`Offer letter generated and e-signature invitation sent to ${app.name}!`, 'success');
          return `Application moved to Offer. Official offer letter and e-signature invitation email sent to ${app.name}.`;
        }, { saveLabel: 'Generate Offer & Send Signature Email' });
        bindValidation('signer_email', checkEmail);
        bindValidation('currency', checkCurrency);
        return;
      }
      modal('Change application stage',`<p>Move this application to <strong>${escape(stage)}</strong>?</p><p class="muted" style="font-size:0.82rem;margin-top:6px;">A status update email will be automatically sent to the candidate.</p>`,async ()=>{
        await api(`applications/${id}/stage`,'POST',{stage});
        return stage==='Rejected'?'Application rejected. Status update email sent.':`Application moved to ${stage} successfully. Status update email sent.`;
      },{saveLabel:stage==='Rejected'?'Reject & Notify':'Move & Notify'});
    }
    if(a==='match'){
      const r=await api(`applications/${id}/match`);
      const matchedChips = (r.matched && r.matched.length)
        ? r.matched.map(s => `<span class="skill-chip" style="background:var(--surface);border:1px solid var(--accent);">${escape(s)}</span>`).join(' ')
        : '<span class="muted">None</span>';
      const missingChips = (r.missing && r.missing.length)
        ? r.missing.map(s => `<span class="skill-chip" style="background:var(--surface-alt);border:1px dashed var(--line);">${escape(s)}</span>`).join(' ')
        : '<span class="muted">None</span>';
      const expBlock = r.breakdown?.experience_assessment
        ? `<div style="margin:8px 0;"><h4 style="margin:0 0 4px;font-size:0.85rem;">Experience Assessment</h4><p style="font-size:0.85rem;margin:0;">${escape(r.breakdown.experience_assessment)}</p></div>`
        : '';
      const evidenceBlock = (r.evidence && r.evidence.length)
        ? `<div style="margin:8px 0;"><h4 style="margin:0 0 4px;font-size:0.85rem;">Attributed Evidence</h4><ul style="font-size:0.82rem;margin:0;padding-left:18px;">${r.evidence.slice(0, 4).map(e=>`<li>${escape(typeof e==='string'?e:(e.snippet||e.requirement))}</li>`).join('')}</ul></div>`
        : '';
      const reductionsBlock = (r.reasons_for_reductions && r.reasons_for_reductions.length)
        ? `<div style="margin:8px 0;"><h4 style="margin:0 0 4px;font-size:0.85rem;">Score Deductions & Notes</h4><ul style="font-size:0.82rem;margin:0;padding-left:18px;">${r.reasons_for_reductions.map(red=>`<li>${escape(red)}</li>`).join('')}</ul></div>`
        : '';
      const recalcAction = allows('recruit')
        ? `<div style="margin-top:10px;">${button('Recalculate match','recalc-match',id,'class="secondary" style="font-size:0.82rem;"')}</div>`
        : '';
      modal('Skill match explanation',`
        <p class="eyebrow">${escape(r.method)}</p>
        <div style="display:flex;align-items:baseline;gap:10px;margin:6px 0 10px;">
          <h1 style="margin:0;font-size:2.2rem;">${r.score===null?'Unscored':r.score+'%'}</h1>
          <span class="muted">Match score</span>
        </div>
        <p>${escape(r.explanation)}</p>
        <h3 style="margin-top:10px;font-size:0.95rem;">Matched</h3>
        <p>${matchedChips}</p>
        <h3 style="margin-top:10px;font-size:0.95rem;">Not found in skills</h3>
        <p>${missingChips}</p>
        ${expBlock}
        ${evidenceBlock}
        ${reductionsBlock}
        ${recalcAction}
        <p class="muted" style="margin-top:12px;font-size:0.78rem;">This does not assess ability, potential or suitability. Never use this score as an automatic rejection rule.</p>
      `);
    }
    if(a==='recalc-match'){
      const r = await api(`applications/${id}/match`, 'POST');
      notice(`Match recomputed: ${r.score === null ? 'Unscored' : r.score + '%'} (${r.method}).`, 'success');
      const bFake = document.createElement('button');
      bFake.dataset.action = 'match';
      bFake.dataset.id = id;
      bFake.click();
    }
    if(a==='resolve-fraud'){
      const fraudData = await api(`candidates/${id}/fraud-review`);
      const statusOptions = [
        ['resolved', 'Resolved (Verified with candidate)'],
        ['cleared', 'Cleared (False alarm / Disregarded)'],
        ['reviewed', 'Reviewed (Noted for interview exploration)']
      ];
      modal('Review consistency signals', `<div class="form-grid">
        <p class="full muted">Document your human assessment and verification decision for audit compliance.</p>
        ${select('Review decision', 'status', statusOptions, fraudData.status === 'pending' ? 'resolved' : fraudData.status)}
        ${area('Reviewer notes & justification', 'resolution_notes', fraudData.resolution_notes || '', true)}
      </div>`, async v => {
        if (!v.resolution_notes || !v.resolution_notes.trim()) {
          throw new Error('Resolution notes are required.');
        }
        await api(`candidates/${id}/fraud-review`, 'POST', {
          action: 'resolve',
          status: v.status,
          resolution_notes: v.resolution_notes.trim()
        });
        return 'Review decision recorded successfully.';
      });
    }
    if(a==='new-interview'){const [apps,users]=await Promise.all([api('applications'),api('interviewers')]);const active=apps.filter(a=>!['Hired','Rejected'].includes(a.stage));if(!active.length||!users.length)throw new Error('An active application and interviewer are required.');const todayMin=getLocalTodayMin();modal('Plan interview',select('Application','application_id',active.map(a=>[a.id,`${a.name} · ${a.title}`]))+select('Interviewer','interviewer_id',users.map(u=>[u.id,u.name]))+field('Date and time (your timezone)','scheduled_at','datetime-local','',true,`min="${todayMin}"`)+select('Duration','duration_minutes',[['30','30 minutes'],['45','45 minutes (Standard)'],['60','60 minutes'],['90','90 minutes']],'45',false)+field('Meeting link / Video URL (Optional)','meeting_url','url','',false,'placeholder="Auto-generated via Teams when connected, or paste Google Meet / Zoom link"')+field('Competencies, comma separated','competencies','text','Role knowledge, Problem solving')+area('Agenda / Notes (Optional)','notes','',false)+'<p class="status-note">This schedules the interview and creates a Microsoft Teams meeting and candidate invite when configured.</p>',async v=>{const scheduledDate=new Date(v.scheduled_at);if(!Number.isFinite(scheduledDate.getTime())||scheduledDate.getTime()<Date.now()){throw new Error('Enter a future interview date.');}await api('interviews','POST',{...v,scheduled_at:scheduledDate.toISOString(),competencies:skills(v.competencies),duration_minutes:Number(v.duration_minutes)||45,meeting_url:v.meeting_url?.trim()||undefined,notes:v.notes?.trim()||undefined});return 'Interview scheduled successfully.';});const dateInp=$('#edit-form [name="scheduled_at"]');if(dateInp)dateInp.min=todayMin;}
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
      modal('Edit interview',`<div class="form-grid"><p class="full"><strong>Candidate:</strong> ${escape(i.name)} · ${escape(i.title)}</p>${interviewerOptions.length?select('Interviewer','interviewer_id',interviewerOptions,i.interviewer_id):`<p class="full"><strong>Interviewer:</strong> ${escape(i.interviewer)}</p>`}${field('Date and time (your timezone)','scheduled_at','datetime-local',toLocal(i.scheduled_at),true,`min="${todayMin}"`)}${select('Duration','duration_minutes',[['30','30 minutes'],['45','45 minutes (Standard)'],['60','60 minutes'],['90','90 minutes']],String(i.duration_minutes||45),false)}${field('Meeting link / Video URL (Optional)','meeting_url','url',i.meeting_url||'',false,'placeholder="Auto-generated via Teams when connected, or paste Google Meet / Zoom link"')}${canManage?field('Competencies, comma separated','competencies','text',comps.join(', '),true):''}${area('Agenda / Update notes (Optional)','notes',i.notes||'',false)}<p class="full status-note">This updates the scheduled interview date and time and synchronizes with Microsoft Teams when configured.</p></div>`,async v=>{
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
          duration_minutes:Number(v.duration_minutes)||45,
          meeting_url:v.meeting_url?.trim()||undefined,
          notes:v.notes?.trim()||undefined,
          ...(v.interviewer_id?{interviewer_id:v.interviewer_id}:{}),
          ...(updatedComps?{competencies:updatedComps}:{})
        };
        await api(`interviews/${id}`,'PUT',payload);
        return 'Interview updated successfully.';
      });
    }
    if(a==='cancel-interview'){
      const interviews=await api('interviews');
      const i=interviews.find(item=>item.id===id)||await api(`interviews/${id}`);
      if(!i)throw new Error('Interview not found.');
      modal('Cancel interview',`<p>Are you sure you want to cancel the interview for <strong>${escape(i.name)}</strong> (${escape(i.title)})?</p><p class="muted">This will update the interview status, cancel any associated Microsoft Teams calendar events, and notify the candidate.</p>${area('Reason for cancellation (Optional)','reason','',false)}`,async v=>{
        await api(`interviews/${id}/cancel`,'POST',{reason:v.reason?.trim()||undefined});
        return 'Interview cancelled successfully.';
      });
    }
    if(a==='scorecard'){const i=(await api('interviews')).find(i=>i.id===id);if(!i)throw new Error('Interview not found.');if(!feedbackReady(i))throw new Error(FEEDBACK_LOCKED_MESSAGE);const comps=JSON.parse(i.competencies);modal('Submit independent feedback',comps.map((c,n)=>select(`${escape(c)} (1 low – 5 high)`,`rating${n}`,['1','2','3','4','5'],'3')).join('')+select('Recommendation','recommendation',['Strong yes','Yes','No','Strong no'])+area('Job-related evidence','notes','',true)+'<p class="muted">Submitted feedback is final in this phase. Other feedback stays hidden until you submit your assigned scorecards.</p>',async v=>{if(!feedbackReady(i))throw new Error(FEEDBACK_LOCKED_MESSAGE);await api(`interviews/${id}/scorecards`,'POST',{ratings:Object.fromEntries(comps.map((c,n)=>[c,Number(v[`rating${n}`])])),recommendation:v.recommendation,notes:v.notes});return 'Scorecard submitted successfully.';});}
    if(a==='scorecard-proxy'){
      const i=(await api('interviews')).find(i=>i.id===id)||await api(`interviews/${id}`);
      if(!feedbackReady(i))throw new Error(FEEDBACK_LOCKED_MESSAGE);
      const comps=JSON.parse(i.competencies);
      modal(`Submit proxy scorecard on behalf of ${escape(i.interviewer)}`,`<div class="notice-inline"><strong>Administrative Proxy Submission:</strong> You are submitting this scorecard on behalf of the assigned interviewer (${escape(i.interviewer)}). An audit log entry will record your action and reason.</div>`+comps.map((c,n)=>select(`${escape(c)} (1 low – 5 high)`,`rating${n}`,['1','2','3','4','5'],'3')).join('')+select('Recommendation','recommendation',['Strong yes','Yes','No','Strong no'])+area('Job-related evidence','notes','',true)+area('Reason for proxy submission','proxy_reason','',true),async v=>{
        if(!v.proxy_reason||!v.proxy_reason.trim())throw new Error('A reason for proxy submission is required.');
        if(!feedbackReady(i))throw new Error(FEEDBACK_LOCKED_MESSAGE);
        return api(`interviews/${id}/scorecards`,'POST',{ratings:Object.fromEntries(comps.map((c,n)=>[c,Number(v[`rating${n}`])])),recommendation:v.recommendation,notes:v.notes,proxy_reason:v.proxy_reason});
      });
    }
    if(a==='feedback'){
      const r=await api(`interviews/${id}/scorecards`);
      modal('Interview feedback',`${r.blinded?'<div class="notice-inline">Other reviewers’ feedback is hidden until you submit all your assigned scorecards for this application.</div>':''}${r.scorecards.map(s=>`<article class="panel"><h3>${escape(s.recommendation)}</h3>${s.proxy_for?`<p class="muted" style="margin-bottom:6px"><strong>Proxy Submission:</strong> Submitted by ${escape(s.author_name||'Administrator')} on behalf of ${escape(s.proxy_for_name||'Interviewer')}${s.proxy_reason?` · Reason: ${escape(s.proxy_reason)}`:''}</p>`:(s.author_name?`<p class="muted" style="margin-bottom:6px">By: ${escape(s.author_name)}</p>`:'')}<p>${escape(Object.entries(JSON.parse(s.ratings)).map(([k,v])=>`${k}: ${v}/5`).join(' · '))}</p><p class="score-note">${escape(s.notes)}</p></article>`).join('')||empty('No feedback is available to you yet.')}`);
    }
    if(a==='new-referral'){
      const rs=(await api('requisitions')).filter(r=>r.status==='open');
      if(!rs.length)throw new Error('No open requisitions in your team.');
      modal('Make a referral',field('Candidate name','name')+field('Candidate email','email','email')+searchableSelect('Job position','requisition_id',rs.map(r=>[r.id,`${r.title} — ${r.id} — ${r.team}`]),'',true,'Search by title, ID or team')+area('Referral note','note'),async v=>{
        const eErr=checkEmail(v.email);
        if(eErr){const el=$('#email-error');if(el)el.textContent=eErr;const inp=$('#edit-form [name="email"]');if(inp){inp.setCustomValidity(eErr);inp.reportValidity();}throw new Error(eErr);}
        if(!v.requisition_id)throw new Error('Select a job position for this referral.');
        await api('referrals','POST',v);
        return 'Referral submitted successfully.';
      },{ actions: formActions() });
      bindValidation('email',checkEmail);
      bindSearchableSelect('requisition_id');
    }
    if(a==='referral-details'){
      const r=await api(`referrals/${id}`);
      const position=r.requisition_title
        ? `<strong>${escape(r.requisition_title)}</strong>${r.requisition_id?`<br><small class="mono">Requisition ${escape(r.requisition_id)}</small>`:''}`
        : (r.requisition_restricted?'<span class="muted">Restricted by team scope</span>':'<span class="muted">Not linked</span>');
      const reqAction=r.can_view_requisition?`<div class="actions detail-actions">${button('View Requisition','req-details',r.requisition_id,`class="secondary" data-readonly="true" data-referral-id="${escape(r.id)}"`)}</div>`:'';
      const actions=[];
      if(r.can_edit)actions.push(button('Edit','edit-referral',r.id,'class="secondary"'));
      if(r.can_process)actions.push(button('Process referral','process-referral',r.id));
      if(r.can_withdraw)actions.push(button('Withdraw referral','withdraw-referral',r.id,'class="secondary"'));
      modal(`Referral: ${r.name}`,`<dl class="detail-list"><dt>Candidate</dt><dd><strong>${escape(r.name)}</strong><br>${escape(r.email)}</dd><dt>Job Position</dt><dd>${position}${reqAction}</dd><dt>Referral Status</dt><dd>${badge(r.status)}${r.application_id?`<br><small>Linked application ${escape(r.application_id)}</small>`:''}</dd><dt>Referral Date</dt><dd>${escape(new Date(r.at).toLocaleString())}</dd><dt>Referrer</dt><dd>${escape(r.referrer_name||'You')}${r.referrer_email?`<br><small>${escape(r.referrer_email)}</small>`:''}</dd><dt>Referral Note</dt><dd class="score-note">${escape(r.note||'No referral note provided.')}</dd></dl>${actions.length?`<div class="actions" style="margin-top:16px">${actions.join('')}</div>`:''}`);
    }
    if(a==='edit-referral'){
      const r=await api(`referrals/${id}`);
      if(!r.can_edit)throw new Error('You cannot edit this referral at its current stage.');
      const rs=await api('requisitions');
      const options=rs.filter(x=>x.status==='open'||x.id===r.requisition_id).map(x=>[x.id,`${x.title} — ${x.id} — ${x.team}`]);
      if(r.requisition_id&&!options.some(([rid])=>rid===r.requisition_id))options.unshift([r.requisition_id,`${r.requisition_title||'Current position'} — ${r.requisition_id}`]);
      modal('Edit referral',`<div class="form-grid">${field('Candidate name','name','text',r.name)}${field('Candidate email','email','email',r.email)}${searchableSelect('Job position','requisition_id',options,r.requisition_id||'',true,'Search by title, ID or team')}${area('Referral note','note',r.note||'')}</div>`,async v=>{
        const eErr=checkEmail(v.email);
        if(eErr){const el=$('#email-error');if(el)el.textContent=eErr;const inp=$('#edit-form [name="email"]');if(inp){inp.setCustomValidity(eErr);inp.reportValidity();}throw new Error(eErr);}
        if(!v.requisition_id)throw new Error('Select a job position for this referral.');
        await api(`referrals/${id}`,'PUT',v);
        return 'Referral updated successfully.';
      },{ actions: formActions({ deleteAction:r.can_delete?'delete-referral':'', deleteId:r.id }) });
      bindValidation('email',checkEmail);
      bindSearchableSelect('requisition_id');
    }
    if(a==='process-referral'){
      const r=await api(`referrals/${id}`);
      if(!r.can_process)throw new Error('This referral cannot be processed. It may already be linked, outside your team, or the requisition is not open.');
      modal('Process referral',`<p>Process the referral for <strong>${escape(r.name)}</strong> (${escape(r.email)}) for <strong>${escape(r.requisition_title||'the linked position')}</strong>?</p><p class="muted">A candidate and application will be reused when they already exist. The original referrer and referral record are preserved.</p>`,async()=>{
        const result=await api(`referrals/${id}/process`,'POST',{});
        if(result.candidate_created||result.application_created)return `Referral processed. ${result.candidate_created?'Candidate created.':'Existing candidate reused.'} ${result.application_created?'Application created.':'Existing application reused.'}`;
        return 'Referral processed. The existing candidate and application were reused.';
      });
      const submit=$('#edit-form [type="submit"]');if(submit)submit.textContent='Process referral';
    }
    if(a==='withdraw-referral'){
      const r=await api(`referrals/${id}`);
      if(!r.can_withdraw)throw new Error(r.withdraw_block_reason||'This referral cannot be withdrawn at its current stage.');
      modal('Withdraw referral',`<p>Withdraw the referral for <strong>${escape(r.name)}</strong> for <strong>${escape(r.requisition_title||'the linked position')}</strong>?</p><div class="notice-inline">The referral record and history will be retained with a Withdrawn status. Any linked candidate or application will not be deleted or rejected automatically.</div>`,async()=>{
        await api(`referrals/${id}/withdraw`,'POST',{});
        return r.application_id?'Referral withdrawn. The linked candidate and application were left unchanged.':'Referral withdrawn. The record and history were retained.';
      });
      const submit=$('#edit-form [type="submit"]');if(submit){submit.textContent='Withdraw referral';submit.classList.add('danger');}
    }
    if(a==='delete-referral'){
      const r=await api(`referrals/${id}`);
      if(!r.can_delete)throw new Error(r.status==='Withdrawn'?'Withdrawn referrals are retained for history and cannot be deleted.':'This referral cannot be deleted because it is linked to a candidate or application, or you do not have permission.');
      deleteDialog('referral',`Referral for ${r.name}`,'This removes the referral from active lists. Linked candidates and applications would be blocked from deletion and are never removed silently.',`referrals/${id}`,'Referral deleted successfully.');
    }
    if(a==='new-user'){const roles=(await api('me')).roles.filter(r=>r!=='Agency');modal('Add Microsoft 365 user',field('Full name','name')+field('Microsoft email','email','email')+field('Entra object ID','oid')+field('Entra tenant ID','tenant')+select('Role','role',roles,'Employee/Referral')+teamSelect('Team','team','',true)+'<p class="muted">This grants approved access to the exact Entra identity. It does not create a Microsoft account or an ATS password.</p>',async v=>{await api('admin/users','POST',v);return 'User provisioned successfully.';});}
    if(a==='manage-user'){const u=window.currentUsers.find(u=>u.id===id);const roles=(await api('me')).roles.filter(r=>r!=='Agency');const actions=u.status==='pending'?['approve','reject']:u.status==='active'?['update','disable','force-logout']:['reactivate','update'];modal(`Manage ${u.name}`,`<p>${escape(u.email)} · ${badge(u.status)}</p><p class="mono">Entra object: ${escape(u.oid)}</p>`+select('Action','action',actions)+select('Role','role',roles,u.role)+teamSelect('Team','team',u.team||'',true)+'<p class="muted">Access changes revoke all current ATS sessions.</p>',async v=>{await api(`admin/users/${id}/${v.action}`,'POST',v);return `User ${v.action} completed successfully.`;});}
    if(a==='edit-pipeline'){
      const stages=await api('pipeline');
      modal('Edit pipeline',
        `<div class="edit-pipeline-notice" style="margin-bottom:14px;padding:12px;background:var(--surface-alt);border:1px solid var(--line);border-radius:8px;font-size:0.83rem;line-height:1.5;">` +
          `<strong style="color:var(--ink);">Pipeline Structure Guidelines:</strong><br>` +
          `<span class="muted">• Must begin with <strong>Applied</strong> (initial entry).<br>` +
          `• Intermediate active stages progress sequentially (e.g. Screening, Interview, Offer).<br>` +
          `• <strong>Hired</strong> and <strong>Rejected</strong> are automatically preserved as terminal outcomes.</span>` +
        `</div>` +
        area('Stages, one per line','stages',stages.join('\n'),true),
        async v=>{
          let entered=v.stages.split('\n').map(s=>s.trim()).filter(Boolean);
          if(entered[0]!=='Applied') entered.unshift('Applied');
          entered=entered.filter(s=>!['Hired','Rejected'].includes(s));
          entered.push('Hired','Rejected');
          await api('pipeline','PUT',{stages:entered});
          return 'Pipeline updated successfully.';
        }
      );
    }
    if(a==='new-signature-request'){
      const cand = (await api('candidates')).find(c=>c.id===id)||await api(`candidates/${id}`);
      if(!cand) throw new Error('Candidate not found.');
      const candApps = cand.applications || [];
      const eligibility = signatureEligibility(candApps);
      if (!eligibility.eligible) throw new Error(eligibility.reason);
      const reqs = await api('requisitions');
      const activeApps = eligibility.applications;
      const reqOptions = activeApps.map(app => [app.requisition_id, `${app.title} (${app.stage})`]);
      for (const r of reqs.filter(r=>r.status==='open')) {
        if (!reqOptions.some(([rid])=>rid===r.id)) reqOptions.push([r.id, `${r.title} (${r.team})`]);
      }
      if (!reqOptions.length) reqOptions.push(['', 'General Position (No active requisition)']);

      modal(`Create Offer & E-Signature Request for ${escape(cand.name)}`, `
        <div class="form-grid">
          ${field('Document title', 'title', 'text', 'Employment Offer Letter')}
          ${select('Associated position', 'requisition_id', reqOptions)}
          ${field('Signer legal name', 'signer_name', 'text', cand.name)}
          ${field('Signer email', 'signer_email', 'email', cand.email)}
          ${field('Annual base salary', 'salary', 'text', '120,000')}
          ${field('Currency', 'currency', 'text', 'USD')}
          ${field('Anticipated start date', 'start_date', 'text', 'Two weeks following signature acceptance')}
          ${field('Expiration in days', 'expires_days', 'number', '7')}
          <p class="full status-note">Orbit will generate an official Offer of Employment PDF, attach cryptographic SHA-256 integrity verification, and generate a secure signing session token.</p>
        </div>
      `, async v => {
        const payload = {
          title: v.title?.trim() || 'Employment Offer Letter',
          candidate_id: cand.id,
          requisition_id: v.requisition_id || undefined,
          salary: v.salary?.trim() || '120,000',
          currency: v.currency?.trim()?.toUpperCase() || 'USD',
          start_date: v.start_date?.trim(),
          expires_days: Number(v.expires_days) || 7,
          signers: [{
            name: v.signer_name?.trim() || cand.name,
            email: v.signer_email?.trim() || cand.email,
            role: 'Candidate'
          }]
        };
        await api('signatures', 'POST', payload);
        notice('Offer signature request created successfully!', 'success');
        return 'Signature request created successfully.';
      });
    }
    if(a==='cancel-signature-request'){
      if (!confirm('Are you sure you want to cancel this signature request?')) return;
      await api(`signatures/${id}/cancel`, 'POST', { reason: 'Cancelled by recruiter' });
      notice('Signature request cancelled.', 'success');
      const candId = b.dataset.candidateId;
      if (candId) {
        const trigger = document.querySelector(`[data-action="candidate-details"][data-id="${candId}"]`);
        if (trigger) {
          trigger.click();
          return;
        }
      }
      await render();
    }
    if(a==='copy-sig-link'){
      let token = b.dataset.token;
      if (!token && b.dataset.id) {
        try {
          const reqData = await api(`signatures/${b.dataset.id}`);
          token = reqData.signers?.[0]?.token;
        } catch {}
      }
      if (token) {
        const fullUrl = `${location.origin}/sign/${token}`;
        const prevText = b.textContent;
        navigator.clipboard?.writeText?.(fullUrl)?.then(()=>{
          notice('Signing link copied to clipboard!', 'success');
          b.textContent = '✓ Copied!';
          setTimeout(() => { b.textContent = prevText; }, 2000);
        })?.catch(()=>{
          prompt('Copy signing link:', fullUrl);
        });
      } else {
        notice('Signing link is being initialized. Try clicking "Send Email" to generate an active link.', 'error');
      }
    }
    if(a==='resend-sig-email'){
      if (b.disabled || b.dataset.submitting === 'true') return;
      b.disabled = true;
      b.dataset.submitting = 'true';
      const prevText = b.textContent;
      b.textContent = 'Sending…';
      try {
        const res = await api(`signatures/${id}/send-email`, 'POST', {});
        notice(res.results?.[0]?.simulated ? 'Invitation email simulated locally (signing link active).' : 'Invitation email resent successfully to candidate!', 'success');
        b.textContent = '✓ Resent!';
        setTimeout(() => { b.textContent = prevText; b.disabled = false; delete b.dataset.submitting; }, 2500);
      } catch (err) {
        notice(err.message, 'error');
        b.textContent = prevText;
        b.disabled = false;
        delete b.dataset.submitting;
      }
    }
    if(a==='new-agency'){
      modal('Register recruitment agency',`<div class="form-grid">
        ${field('Agency name','name','text','',true)}
        ${field('Agency code (2–10 uppercase chars)','code','text','',true)}
        ${field('Primary contact name','contact_name','text','',true)}
        ${field('Contact email','contact_email','email','',true)}
        ${field('Contact phone (optional)','contact_phone','tel','',false)}
        ${area('Notes / Terms (optional)','notes','',false)}
      </div><p class="muted" style="margin-top:8px;font-size:0.8rem;">An agency account will be created in active status. You can invite agency recruiters next.</p>`,async v=>{
        const code = (v.code||'').trim().toUpperCase();
        if(!code || code.length < 2 || code.length > 10){
          throw new Error('Agency code must be between 2 and 10 alphanumeric characters.');
        }
        await api('agencies','POST',{
          name: v.name.trim(),
          code,
          contact_name: v.contact_name.trim(),
          contact_email: v.contact_email.trim(),
          contact_phone: v.contact_phone?.trim()||undefined,
          notes: v.notes?.trim()||undefined
        });
        return 'Recruitment agency registered successfully.';
      });
    }
    if(a==='manage-agency'){
      const details = await api(`agencies/${id}`);
      const ag = details.agency || details;
      if(!ag || !ag.id) throw new Error('Agency details could not be loaded.');
      const mems = details.members || ag.members || [];
      const ass = details.assignments || ag.assignments || [];
      const subs = details.submissions || ag.submissions || [];

      const statusActionButtons = allows('admin') ? `
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          ${ag.status!=='active'?button('Activate agency','set-agency-status',ag.id,'data-status="active" class="primary"'):''}
          ${ag.status==='active'?button('Suspend agency','set-agency-status',ag.id,'data-status="suspended" class="secondary"'):''}
          ${ag.status!=='deactivated'?button('Deactivate agency','set-agency-status',ag.id,'data-status="deactivated" class="secondary"'):''}
          ${button('Assign role','agency-assign-job',ag.id,'class="secondary"')}
          ${button('Add recruiter','agency-add-recruiter-modal',ag.id,'class="secondary"')}
        </div>
      ` : '';

      const membersList = mems.length ? `
        <div class="table-wrap" style="margin-top:8px;">
          <table class="table"><thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th></tr></thead>
          <tbody>${mems.map(m=>`<tr><td><strong>${escape(m.name)}</strong></td><td>${escape(m.email)}</td><td><span class="badge ${m.role==='Agency Admin'?'completed':'clean'}">${escape(m.role)}</span></td><td>${badge(m.status)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      ` : '<p class="muted" style="font-size:0.85rem;margin-top:6px;">No recruiters added to this agency yet.</p>';

      const assignmentsList = ass.length ? `
        <div class="table-wrap" style="margin-top:8px;">
          <table class="table"><thead><tr><th scope="col">Requisition</th><th scope="col">Deadline</th><th scope="col">Instructions</th><th scope="col">Action</th></tr></thead>
          <tbody>${ass.map(j=>`<tr><td><strong>${escape(j.title)}</strong><br><small>${escape(j.team)}</small></td><td>${(j.submission_deadline||j.deadline)?escape(new Date(j.submission_deadline||j.deadline).toLocaleDateString()):'None'}</td><td><small class="muted">${escape(j.sourcing_instructions||j.instructions||'—')}</small></td><td>${allows('admin')?button('Revoke','revoke-agency-req',ag.id,`data-req-id="${j.requisition_id}" class="secondary text-button"`):'—'}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      ` : '<p class="muted" style="font-size:0.85rem;margin-top:6px;">No requisitions currently assigned.</p>';

      const subsList = subs.length ? `
        <div class="table-wrap" style="margin-top:8px;">
          <table class="table"><thead><tr><th scope="col">Ref</th><th scope="col">Candidate</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Feedback</th></tr></thead>
          <tbody>${subs.map(s=>`<tr><td class="mono">${escape(s.submission_ref)}</td><td><strong>${escape(s.candidate_name)}</strong></td><td>${escape(s.requisition_title)}</td><td>${badge(s.agency_status)}</td><td>${button('Publish feedback','publish-agency-feedback',s.id,'class="secondary text-button"')}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      ` : '<p class="muted" style="font-size:0.85rem;margin-top:6px;">No candidate submissions received from this agency yet.</p>';

      modal(`Agency: ${ag.name} (${ag.code})`, `
        <div style="background:var(--surface-alt);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>${escape(ag.contact_name||'Primary Contact')}</strong>
            ${badge(ag.status)}
          </div>
          <p class="muted" style="margin:4px 0 0;font-size:0.85rem;">${escape(ag.contact_email||'')} ${ag.contact_phone?`· ${escape(ag.contact_phone)}`:''}</p>
          ${ag.notes?`<p style="margin:8px 0 0;font-size:0.85rem;">${escape(ag.notes)}</p>`:''}
          ${statusActionButtons}
        </div>
        <h3>Agency Recruiters (${mems.length})</h3>
        ${membersList}
        <h3 style="margin-top:16px;">Assigned Requisitions (${ass.length})</h3>
        ${assignmentsList}
        <h3 style="margin-top:16px;">Candidate Submissions (${subs.length})</h3>
        ${subsList}
      `);
    }
    if(a==='set-agency-status'){
      const targetStatus = b.dataset.status;
      if (!confirm(`Are you sure you want to set this agency's status to "${targetStatus}"?`)) return;
      await api(`agencies/${id}/status`,'POST',{status:targetStatus,reason:`Updated by ${me.name}`});
      notice(`Agency status updated to ${targetStatus}.`,'success');
      closeModal();
      await render();
    }
    if(a==='agency-add-recruiter-modal'){
      modal('Add Recruiter to Agency',`<div class="form-grid">
        ${field('Recruiter full name','name','text','',true)}
        ${field('Recruiter email','email','email','',true)}
        ${select('Agency role','role',[['Agency Recruiter','Agency Recruiter (Submissions & assigned roles)'],['Agency Admin','Agency Admin (Can manage agency recruiters)']],'Agency Recruiter')}
      </div>`,async v=>{
        await api(`agencies/${id}/members`,'POST',{
          name: v.name.trim(),
          email: v.email.trim(),
          role: v.role
        });
        return 'Agency recruiter invited and granted portal access.';
      });
    }
    if(a==='agency-assign-job'){
      const reqs = (await api('requisitions')).filter(r=>r.status==='open');
      if(!reqs.length) throw new Error('No open requisitions available to assign.');
      const today = getLocalDateString();
      modal('Assign Requisition to Agency',`<div class="form-grid">
        ${select('Select open requisition','requisition_id',reqs.map(r=>[r.id,`${r.title} (${r.team})`]))}
        ${field('Submission deadline (optional)','deadline','date','',false,`min="${today}"`)}
        ${area('Sourcing instructions / Guidelines (optional)','instructions','',false)}
      </div><p class="muted" style="font-size:0.8rem;margin-top:6px;">This requisition will become visible in the agency recruiter portal for candidate submission.</p>`,async v=>{
        const deadline = v.deadline?.trim() || '';
        if(deadline){
          const deadlineDate = new Date(`${deadline}T23:59:59`);
          if(!Number.isFinite(deadlineDate.getTime()) || deadlineDate.getTime() < Date.now()){
            const inp = $('#edit-form [name="deadline"]');
            if(inp){ inp.setCustomValidity('Submission deadline cannot be in the past.'); inp.reportValidity(); }
            throw new Error('Submission deadline cannot be in the past.');
          }
        }
        await api(`agencies/${id}/requisitions`,'POST',{
          requisition_id: v.requisition_id,
          deadline: deadline||undefined,
          instructions: v.instructions?.trim()||undefined
        });
        return 'Requisition assigned to agency successfully.';
      });
    }
    if(a==='revoke-agency-req'){
      const reqId = b.dataset.reqId;
      if(!confirm('Revoke this requisition from the agency? Future candidate submissions will be blocked.')) return;
      await api(`agencies/${id}/requisitions/${reqId}/revoke`,'POST',{});
      notice('Requisition assignment revoked.','success');
      closeModal();
      await render();
    }
    if(a==='publish-agency-feedback'){
      modal('Publish Feedback to Agency Recruiter',`<div class="form-grid">
        <p class="full muted">Feedback published here will be visible to the external agency on their portal submissions dashboard.</p>
        ${area('Approved feedback for agency recruiter','feedback','',true)}
      </div>`,async v=>{
        if(!v.feedback||!v.feedback.trim()) throw new Error('Feedback text is required.');
        await api(`agencies/submissions/${id}/feedback`,'POST',{
          feedback: v.feedback.trim()
        });
        return 'Feedback published to agency recruiter.';
      });
    }
    if(a==='agency-submit-candidate'){
      const assigned = await api('agency/requisitions');
      if(!assigned.length) throw new Error('Your agency does not have any active open requisitions assigned.');
      const reqOptions = assigned.map(r=>[r.id,`${r.title} (${r.team})`]);
      const defaultReq = id || assigned[0].id;

      modal('Add Candidate to Orbit',`<div class="form-grid">
        ${select('Assigned Requisition','requisition_id',reqOptions,defaultReq)}
        ${field('Candidate Full Name','name','text','',true)}
        ${field('Candidate Email','email','email','',true)}
        ${field('Candidate Phone (Optional)','phone','tel','',false)}
        ${field('Key Skills (comma separated)','skills','text','',true)}
        <div class="full">
          <label>${formatLabel('Upload Resume (PDF, DOCX, TXT)', false)}
            <input type="file" id="resume-file-input" accept=".pdf,.docx,.doc,.txt" style="margin-top:6px;">
          </label>
          <div id="resume-upload-status" style="margin-top:6px;font-size:0.85rem;"></div>
          <input type="hidden" name="resume_id" id="resume-id-input">
        </div>
        <div class="full">
          ${area('Resume Qualifications / Extracted Text','resume_text','',true)}
        </div>
        <div class="full">
          ${area('Agency Sourcing Notes / Cover Summary (Optional)','notes','',false)}
        </div>
        <label class="full" style="display:flex;align-items:flex-start;gap:8px;margin-top:10px;font-size:0.85rem;cursor:pointer;background:var(--surface-alt);padding:10px 12px;border:1px solid var(--line);border-radius:6px;">
          <input type="checkbox" name="representation_confirmed" value="true" required style="margin-top:3px;">
          <span><strong>Representation & Consent Authorization:</strong> I certify that this candidate has authorized our agency to represent them for this requisition and that they have explicitly consented to having their personal information and resume shared with Mechlin Orbit.</span>
        </label>
      </div>`,async v=>{
        const emailErr = checkEmail(v.email);
        if(emailErr) throw new Error(emailErr);
        if(!v.representation_confirmed) throw new Error('Affirmative representation authorization is required to submit candidates.');
        if(!v.resume_text?.trim() && !v.resume_id) throw new Error('Resume text or resume upload is required.');

        const result = await api('agency/submissions','POST',{
          requisition_id: v.requisition_id,
          name: v.name.trim(),
          email: v.email.trim(),
          phone: v.phone?.trim()||undefined,
          skills: skills(v.skills),
          resume_text: v.resume_text.trim(),
          resume_id: v.resume_id||undefined,
          representation_confirmed: true,
          consent_confirmed: true,
          consent: true,
          notes: v.notes?.trim()||undefined
        });
        return `Candidate submitted successfully. Reference: ${result.submission?.submission_ref}`;
      });

      bindResumeUpload();
      bindValidation('email',checkEmail);
      bindValidation('phone',checkPhone);
    }
    if(a==='view-agency-feedback'){
      const sub = await api(`agency/submissions/${id}`);
      modal(`Submission Feedback: ${sub.candidate_name}`,`
        <div style="background:var(--surface-alt);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>${escape(sub.requisition_title)}</strong>
            ${badge(sub.agency_status)}
          </div>
          <p class="mono muted" style="font-size:0.8rem;margin:4px 0 0;">Reference: ${escape(sub.submission_ref)}</p>
        </div>
        <h3 style="margin-top:12px;">Published Feedback from Hiring Team</h3>
        ${sub.published_feedback?`
          <div class="agency-feedback-box">
            <p class="feedback-text">${escape(sub.published_feedback)}</p>
            <div class="feedback-meta">Published on ${escape(new Date(sub.feedback_published_at||sub.created_at).toLocaleString())}</div>
          </div>
        `:'<p class="muted">No feedback published yet. Your candidate is currently under active evaluation by the hiring team.</p>'}
      `);
    }
    if(a==='new-agency-recruiter'){
      modal('Add Recruiter to Your Agency Team',`<div class="form-grid">
        ${field('Full Name','name','text','',true)}
        ${field('Email Address','email','email','',true)}
        ${select('Role','role',[['Agency Recruiter','Agency Recruiter (Candidate submissions)'],['Agency Admin','Agency Admin (Team management)']],'Agency Recruiter')}
      </div>`,async v=>{
        const emailErr = checkEmail(v.email);
        if(emailErr) throw new Error(emailErr);
        await api('agency/members','POST',{
          name: v.name.trim(),
          email: v.email.trim(),
          role: v.role
        });
        return 'Recruiter added to your agency successfully.';
      });
      bindValidation('email',checkEmail);
    }
    if(a==='toggle-agency-recruiter-status'){
      const targetStatus = b.dataset.status;
      if(!confirm(`Are you sure you want to ${targetStatus === 'active' ? 'reactivate' : 'suspend'} this recruiter?`)) return;
      await api(`agency/members/${id}/status`,'POST',{status:targetStatus});
      notice(`Recruiter has been ${targetStatus === 'active' ? 'reactivated' : 'suspended'}.`,'success');
      await render();
    }
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
function trimCanvas(canvas, pad = 4) {
  try {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    let hasInk = false;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const alpha = data[(y * w + x) * 4 + 3];
        if (alpha > 15) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          hasInk = true;
        }
      }
    }

    if (!hasInk) return canvas;

    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad);
    maxY = Math.min(h - 1, maxY + pad);

    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    const cropped = document.createElement('canvas');
    cropped.width = cropW;
    cropped.height = cropH;
    const cCtx = cropped.getContext('2d');
    cCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
    return cropped;
  } catch {
    return canvas;
  }
}

async function renderSigningPortal(token) {
  applyTheme(appearance?.theme || 'mechlin');
  $('#app').innerHTML = `<main id="main" class="signing-portal"><p class="muted">Loading secure electronic signing session…</p></main>`;
  try {
    const res = await fetch(`/api/signatures/sign/${encodeURIComponent(token)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      $('#main').innerHTML = `
        <div class="signing-header">
          <div class="product-brand"><span class="orbit-symbol"></span><span>Orbit<small>Talent workspace</small></span></div>
        </div>
        <div class="signing-doc-info">
          <h2>Unable to Open Signing Session</h2>
          <p class="error">${escape(err.error || 'This signing session link is invalid or has expired.')}</p>
          <p class="muted">Please contact your recruitment team to request a new invitation.</p>
        </div>
      `;
      return;
    }
    const session = await res.json();
    const isCompleted = session.request.status === 'completed';

    if (isCompleted) {
      $('#main').innerHTML = `
        <div class="signing-header">
          <div class="product-brand"><span class="orbit-symbol"></span><span>Orbit<small>Talent workspace</small></span></div>
          <span class="badge completed">Completed</span>
        </div>
        <div class="signing-doc-info">
          <h2>Document Successfully Signed</h2>
          <p>Thank you, <strong>${escape(session.signer.name)}</strong>. Your electronic signature has been recorded and verified.</p>
          <p class="mono" style="margin-top:8px;">Original Digest: ${escape(session.request.original_document_hash)}</p>
          <div style="margin-top:16px;">
            <a href="/api/signatures/sign/${encodeURIComponent(token)}/document" target="_blank" class="button">Download Completed Document (PDF)</a>
          </div>
        </div>
      `;
      return;
    }

    let activeTab = 'typed';
    let selectedStyle = 'cursive';
    let uploadedBase64 = null;
    let hasDrawn = false;
    let isDrawing = false;

    const signerName = escape(session.signer.name);
    $('#main').innerHTML = `
      <div class="signing-header">
        <div class="product-brand"><span class="orbit-symbol"></span><span>Orbit<small>Secure Electronic Signing</small></span></div>
        <span class="badge pending">Awaiting Signature</span>
      </div>
      <div class="signing-doc-info">
        <h1 style="font-size:1.35rem;margin:0 0 6px;">${escape(session.request.title)}</h1>
        <p class="muted" style="margin:0 0 8px;">Recipient: <strong>${signerName}</strong> &lt;${escape(session.signer.email)}&gt; · Role: ${escape(session.signer.role)}</p>
        ${session.request.expires_at ? `
          <div style="font-size:0.82rem;color:var(--text-muted,#475569);margin-bottom:8px;">
            ⏱️ <strong>Link Validity:</strong> Valid until ${escape(new Date(session.request.expires_at).toLocaleDateString())} (${Math.max(0, Math.ceil((new Date(session.request.expires_at).getTime() - Date.now()) / 86400000))} days remaining)
          </div>
        ` : ''}
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px;">
          <a href="/api/signatures/sign/${encodeURIComponent(token)}/document" target="_blank" class="button secondary" style="font-size:0.82rem;padding:6px 12px;">
            Review Document PDF
          </a>
          <span class="mono muted" style="font-size:0.75rem;">SHA-256: ${escape(session.request.original_document_hash.slice(0, 16))}…</span>
        </div>
      </div>

      <section class="panel" style="margin-top:18px;">
        <h2 style="margin-top:0;">Create Your Signature</h2>
        <div class="sig-tabs" role="tablist">
          <button type="button" class="sig-tab active" data-sig-tab="typed">Type Signature</button>
          <button type="button" class="sig-tab" data-sig-tab="upload">Upload Image</button>
          <button type="button" class="sig-tab" data-sig-tab="drawn">Draw Signature</button>
        </div>

        <div id="sig-tab-content">
          <!-- Typed tab -->
          <div id="tab-typed-content" class="sig-tab-panel active" style="display:block;">
            <label>
              <span class="label-heading">Your Full Legal Name</span>
              <input type="text" id="typed-sig-input" value="${signerName}" maxlength="100" placeholder="Enter your full name">
            </label>
            <p class="muted" style="font-size:0.8rem;margin:6px 0 10px;">Select a signature style:</p>
            <div class="sig-style-grid">
              <div class="sig-style-card selected" data-style="cursive">
                <span class="sig-style-cursive style-label" id="preview-style-cursive">${signerName}</span>
                <div class="muted" style="font-size:0.72rem;margin-top:4px;">Cursive Script</div>
              </div>
              <div class="sig-style-card" data-style="handwritten">
                <span class="sig-style-handwritten style-label" id="preview-style-handwritten">${signerName}</span>
                <div class="muted" style="font-size:0.72rem;margin-top:4px;">Handwritten Flow</div>
              </div>
              <div class="sig-style-card" data-style="formal">
                <span class="sig-style-formal style-label" id="preview-style-formal">${signerName}</span>
                <div class="muted" style="font-size:0.72rem;margin-top:4px;">Formal Serif</div>
              </div>
              <div class="sig-style-card" data-style="clean">
                <span class="sig-style-clean style-label" id="preview-style-clean">${signerName}</span>
                <div class="muted" style="font-size:0.72rem;margin-top:4px;">Clean Modern</div>
              </div>
            </div>
          </div>

          <!-- Upload tab -->
          <div id="tab-upload-content" class="sig-tab-panel" hidden style="display:none;">
            <label class="sig-upload-box">
              <span class="label-heading">Upload Signature Image (PNG or JPEG)</span>
              <span class="muted" style="font-size:0.8rem;margin:4px 0 10px;">Transparent PNG or JPEG (Max 2 MB)</span>
              <input type="file" id="upload-sig-input" accept="image/png,image/jpeg" style="font-size:0.85rem;">
            </label>
            <div id="upload-preview-area" class="sig-upload-preview" hidden style="display:none;">
              <img id="upload-preview-img" src="" alt="Uploaded Signature Preview" style="max-height:80px;max-width:100%;object-fit:contain;border:1px solid var(--line);border-radius:6px;padding:6px;background:#fff;">
              <div style="margin-top:6px;">
                <button type="button" class="secondary text-button" id="remove-upload-btn" style="font-size:0.8rem;">Remove Image</button>
              </div>
            </div>
          </div>

          <!-- Draw tab -->
          <div id="tab-drawn-content" class="sig-tab-panel" hidden style="display:none;">
            <p class="muted" style="font-size:0.8rem;margin:0 0 8px;">Draw your signature using your mouse, touchscreen, or stylus:</p>
            <div class="sig-canvas-wrap">
              <canvas id="sig-canvas" width="480" height="140"></canvas>
            </div>
            <div style="margin-top:8px;">
              <button type="button" class="secondary" id="clear-canvas-btn" style="font-size:0.8rem;padding:6px 12px;">Clear Signature</button>
            </div>
          </div>
        </div>

        <!-- Adopted signature preview -->
        <div class="sig-preview-box">
          <span class="muted" style="font-size:0.75rem;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em;">Adopted Signature Preview</span>
          <div id="live-adopted-preview" style="font-size:1.6rem;min-height:45px;display:flex;align-items:center;justify-content:center;">
            <span class="sig-style-cursive">${signerName}</span>
          </div>
          <span class="muted" style="font-size:0.75rem;margin-top:4px;">Legally bound signer: <strong>${signerName}</strong></span>
        </div>

        <!-- Consent Checkbox -->
        <div style="margin-top:18px;border-top:1px solid var(--line);padding-top:16px;">
          <label class="checkbox-row" style="font-size:0.85rem;line-height:1.45;">
            <input type="checkbox" id="sig-consent-checkbox">
            <span>I agree to use electronic records and signatures. By checking this box and clicking "Adopt and Sign Document", I affirm my legal intent to sign and execute this agreement electronically under the U.S. Electronic Signatures in Global and National Commerce Act (ESIGN) and Uniform Electronic Transactions Act (UETA).</span>
          </label>
        </div>

        <!-- Action Buttons -->
        <div style="margin-top:20px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;">
          <button type="button" class="secondary" id="decline-sig-btn" style="color:var(--negative);">Decline to Sign</button>
          <button type="button" class="button" id="submit-sig-btn">Adopt and Sign Document</button>
        </div>
      </section>
    `;

    const canvas = $('#sig-canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#17283e';

      const getPos = e => {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return {
          x: (clientX - rect.left) * (canvas.width / rect.width),
          y: (clientY - rect.top) * (canvas.height / rect.height)
        };
      };

      const startDraw = e => {
        isDrawing = true;
        hasDrawn = true;
        const p = getPos(e);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        e.preventDefault();
      };

      const moveDraw = e => {
        if (!isDrawing) return;
        const p = getPos(e);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        e.preventDefault();
      };

      const stopDraw = () => {
        if (!isDrawing) return;
        isDrawing = false;
        ctx.closePath();
        updateAdoptedPreview();
      };

      canvas.addEventListener('mousedown', startDraw);
      canvas.addEventListener('mousemove', moveDraw);
      window.addEventListener('mouseup', stopDraw);

      canvas.addEventListener('touchstart', startDraw, { passive: false });
      canvas.addEventListener('touchmove', moveDraw, { passive: false });
      window.addEventListener('touchend', stopDraw);

      const clearBtn = $('#clear-canvas-btn');
      if (clearBtn) {
        clearBtn.onclick = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          hasDrawn = false;
          updateAdoptedPreview();
        };
      }
    }

    const updateAdoptedPreview = () => {
      const liveBox = $('#live-adopted-preview');
      if (!liveBox) return;
      const typedVal = ($('#typed-sig-input')?.value || session.signer.name).trim();

      if (activeTab === 'typed') {
        liveBox.innerHTML = `<span class="sig-style-${selectedStyle}">${escape(typedVal)}</span>`;
      } else if (activeTab === 'upload') {
        if (uploadedBase64) {
          liveBox.innerHTML = `<img src="${uploadedBase64}" alt="Adopted Signature" style="max-height:45px;max-width:200px;object-fit:contain;">`;
        } else {
          liveBox.innerHTML = `<span class="muted" style="font-size:0.85rem;">No signature image uploaded yet</span>`;
        }
      } else if (activeTab === 'drawn') {
        const c = $('#sig-canvas');
        if (c && hasDrawn) {
          liveBox.innerHTML = `<img src="${c.toDataURL('image/png')}" alt="Adopted Signature" style="max-height:45px;max-width:200px;object-fit:contain;">`;
        } else {
          liveBox.innerHTML = `<span class="muted" style="font-size:0.85rem;">Draw your signature in the box above</span>`;
        }
      }
    };

    // Tab switching handler
    const setSigTab = tab => {
      activeTab = tab;
      document.querySelectorAll('[data-sig-tab]').forEach(b => b.classList.toggle('active', b.dataset.sigTab === activeTab));
      const tabConfigs = [
        { id: '#tab-typed-content', key: 'typed' },
        { id: '#tab-upload-content', key: 'upload' },
        { id: '#tab-drawn-content', key: 'drawn' }
      ];
      for (const { id, key } of tabConfigs) {
        const panel = $(id);
        if (!panel) continue;
        const isCurrent = key === activeTab;
        panel.classList.toggle('active', isCurrent);
        if (isCurrent) {
          panel.removeAttribute('hidden');
          panel.style.display = 'block';
        } else {
          panel.setAttribute('hidden', '');
          panel.style.display = 'none';
        }
      }
      updateAdoptedPreview();
    };

    // Tab buttons
    document.querySelectorAll('[data-sig-tab]').forEach(btn => {
      btn.onclick = () => setSigTab(btn.dataset.sigTab);
    });

    // Style cards
    document.querySelectorAll('[data-style]').forEach(card => {
      card.onclick = () => {
        selectedStyle = card.dataset.style;
        document.querySelectorAll('[data-style]').forEach(c => c.classList.toggle('selected', c === card));
        updateAdoptedPreview();
      };
    });

    // Typed input
    const typedInp = $('#typed-sig-input');
    if (typedInp) {
      typedInp.oninput = () => {
        const v = typedInp.value.trim() || session.signer.name;
        document.querySelectorAll('.style-label').forEach(el => el.textContent = v);
        updateAdoptedPreview();
      };
    }

    // Upload input
    const uploadInp = $('#upload-sig-input');
    if (uploadInp) {
      uploadInp.onchange = () => {
        const file = uploadInp.files?.[0];
        if (!file) return;
        if (!['image/png', 'image/jpeg'].includes(file.type)) {
          alert('Please upload a valid PNG or JPEG image.');
          return;
        }
        if (file.size > 2 * 1024 * 1024) {
          alert('Signature image file size must be under 2 MB.');
          return;
        }
        const reader = new FileReader();
        reader.onload = e => {
          uploadedBase64 = e.target.result;
          const previewImg = $('#upload-preview-img');
          const previewArea = $('#upload-preview-area');
          if (previewImg) previewImg.src = uploadedBase64;
          if (previewArea) {
            previewArea.classList.add('visible');
            previewArea.removeAttribute('hidden');
            previewArea.style.display = 'block';
          }
          updateAdoptedPreview();
        };
        reader.readAsDataURL(file);
      };
    }

    const removeUploadBtn = $('#remove-upload-btn');
    if (removeUploadBtn) {
      removeUploadBtn.onclick = () => {
        uploadedBase64 = null;
        if (uploadInp) uploadInp.value = '';
        const previewImg = $('#upload-preview-img');
        const previewArea = $('#upload-preview-area');
        if (previewImg) previewImg.src = '';
        if (previewArea) {
          previewArea.classList.remove('visible');
          previewArea.setAttribute('hidden', '');
          previewArea.style.display = 'none';
        }
        updateAdoptedPreview();
      };
    }

    // Submit signature
    const submitBtn = $('#submit-sig-btn');
    if (submitBtn) {
      submitBtn.onclick = async () => {
        const consentBox = $('#sig-consent-checkbox');
        if (!consentBox?.checked) {
          alert('Please confirm your affirmative consent by checking the agreement checkbox before signing.');
          return;
        }

        let sigPayload = {
          signature_type: activeTab === 'upload' ? 'uploaded' : activeTab,
          consent: true
        };

        if (activeTab === 'typed') {
          const name = ($('#typed-sig-input')?.value || session.signer.name).trim();
          if (name.length < 2) {
            alert('Please enter your full legal name (at least 2 characters).');
            return;
          }
          sigPayload.signature_data = name;
          sigPayload.signature_style = selectedStyle;

          try {
            if (document.fonts?.ready) {
              await document.fonts.ready;
            }

            const scale = 2;
            let fontStr = "bold 34px Inter, 'Segoe UI', Arial, sans-serif";
            let colorStr = "#0f2b48";
            let textToRender = name;

            if (selectedStyle === 'cursive') {
              fontStr = "italic 46px 'Dancing Script', 'Segoe Script', 'Brush Script MT', cursive";
            } else if (selectedStyle === 'handwritten') {
              fontStr = "italic 42px 'Caveat', 'Segoe Print', 'Bradley Hand', cursive";
            } else if (selectedStyle === 'formal') {
              fontStr = "italic bold 38px 'Georgia', 'Times New Roman', serif";
            } else if (selectedStyle === 'clean') {
              fontStr = "bold 28px Inter, 'Segoe UI', Arial, sans-serif";
              textToRender = name.toUpperCase();
            }

            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.font = fontStr;
            const textMetrics = tempCtx.measureText(textToRender);
            const textWidth = Math.max(Math.ceil(textMetrics.width), 120);
            const canvasWidth = (textWidth + 60) * scale;
            const canvasHeight = 100 * scale;

            const offCanvas = document.createElement('canvas');
            offCanvas.width = canvasWidth;
            offCanvas.height = canvasHeight;
            const ctx = offCanvas.getContext('2d');
            ctx.scale(scale, scale);
            ctx.font = fontStr;
            ctx.fillStyle = colorStr;
            ctx.textBaseline = 'middle';
            ctx.fillText(textToRender, 20, 50);

            const trimmed = trimCanvas(offCanvas, 6);
            sigPayload.signature_image = trimmed.toDataURL('image/png');
          } catch {}
        } else if (activeTab === 'upload') {
          if (!uploadedBase64) {
            alert('Please select and upload a signature image file.');
            return;
          }
          try {
            const img = new Image();
            await new Promise((res, rej) => {
              img.onload = res;
              img.onerror = rej;
              img.src = uploadedBase64;
            });
            const off = document.createElement('canvas');
            off.width = img.naturalWidth || img.width;
            off.height = img.naturalHeight || img.height;
            const oCtx = off.getContext('2d');
            oCtx.drawImage(img, 0, 0);
            const trimmed = trimCanvas(off, 6);
            const trimmedData = trimmed.toDataURL('image/png');
            sigPayload.signature_data = trimmedData.replace(/^data:image\/[a-z]+;base64,/i, '');
          } catch {
            const base64Data = uploadedBase64.replace(/^data:image\/[a-z]+;base64,/i, '');
            sigPayload.signature_data = base64Data;
          }
        } else if (activeTab === 'drawn') {
          const c = $('#sig-canvas');
          if (!c || !hasDrawn) {
            alert('Please draw your signature before submitting.');
            return;
          }
          const trimmed = trimCanvas(c, 6);
          sigPayload.signature_data = trimmed.toDataURL('image/png');
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Executing Signature…';

        try {
          const res = await fetch(`/api/signatures/sign/${encodeURIComponent(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sigPayload)
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || 'Failed to submit electronic signature.');
          renderSigningPortal(token);
        } catch (err) {
          alert(err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Adopt and Sign Document';
        }
      };
    }

    // Decline signature
    const declineBtn = $('#decline-sig-btn');
    if (declineBtn) {
      declineBtn.onclick = async () => {
        const reason = prompt('Please enter your reason for declining this agreement (Optional):');
        if (reason === null) return;
        try {
          const res = await fetch(`/api/signatures/decline/${encodeURIComponent(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason.trim() })
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || 'Failed to decline document.');
          $('#main').innerHTML = `
            <div class="signing-header">
              <div class="product-brand"><span class="orbit-symbol"></span><span>Orbit<small>Talent workspace</small></span></div>
              <span class="badge declined">Declined</span>
            </div>
            <div class="signing-doc-info">
              <h2>Signature Request Declined</h2>
              <p>You have declined to sign <strong>${escape(session.request.title)}</strong>.</p>
              ${reason ? `<p class="muted">Reason recorded: "${escape(reason)}"</p>` : ''}
              <p class="muted">Your recruitment team has been notified.</p>
            </div>
          `;
        } catch (err) {
          alert(err.message);
        }
      };
    }
  } catch (err) {
    $('#main').innerHTML = `<p class="error">${escape(err.message)}</p>`;
  }
}

window.addEventListener('online',()=>notice('Connection restored.','success'));
(async()=>{
  const signToken = (location.pathname.startsWith('/sign/') ? location.pathname.split('/')[2] : '') ||
    new URLSearchParams(location.search).get('sign') ||
    (location.hash.startsWith('#sign=') ? location.hash.replace('#sign=', '') : '');

  if (signToken) {
    renderSigningPortal(signToken);
    return;
  }

  try{
    const data=await api('me');
    me={ ...data.user, agency: data.agency };
    csrf=data.csrf;
    permissions=data.permissions;
    loadSavedPages();
    const nav=getNavList();
    current=getSavedNav(nav);
    await render();
  }catch{
    login();
  }
  if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
})();
