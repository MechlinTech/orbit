const $ = s => document.querySelector(s);
const escape = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let me, csrf, permissions = [], grants = [], adminTab = 'users', auditFilters = { event: '', q: '', from: '', to: '' }, current = 'Overview', renderVersion = 0, reqPage = 1, candidateQuery = '';
const pageState = { Requisitions: 1, Candidates: 1, Interviews: 1, Referrals: 1, Administration: 1, 'Audit log': 1, Agencies: 1, 'Portal Dashboard': 1, 'Assigned Roles': 1, Submissions: 1, 'Agency Team': 1, 'Offer Templates': 1, 'Training Plans': 1 };
const isAgencyMember = () => Boolean(me?.agency || ['Agency Admin','Agency Recruiter'].includes(me?.role));
const isAgencyUser = () => Boolean(isAgencyMember() || me?.role === 'Agency' || me?.user?.isAgency || me?.isAgency);
const isAgencyAdmin = () => Boolean(isAgencyUser() && (me?.role === 'Agency Admin' || me?.agency?.role === 'Agency Admin'));
const getNavList = () => {
  if (new URLSearchParams(location.search).get('agency') === '1' || (me?.role === 'Agency' && !me?.agency)) return ['Agency portal'];
  if (isAgencyMember()) {
    return ['Portal Dashboard', 'Assigned Roles', 'Submissions', ...(isAgencyAdmin() ? ['Agency Team'] : [])];
  }
  const canManageAccess = allows('users.read') || allows('roles.read') || allows('roles.create') || allows('roles.update') || allows('roles.assign') || allows('permissions.read');
  const manage = [
    ...(canManageAccess || allows('admin') ? ['Administration'] : []),
    ...(allows('settings.read') || allows('settings.update') || allows('admin') ? ['Settings'] : []),
    ...(allows('audit.read') || allows('admin') ? ['Audit log'] : []),
    ...(allows('pipeline.configure') || allows('admin') ? ['Pipeline settings'] : []),
    ...(allows('integrations.read') || allows('integrations.configure') || allows('integrations.secrets.manage') || (allows('admin') && me?.role === 'System Admin') ? ['Integrations'] : [])
  ];
  if (!grants.length) {
    return [
      ...(allows('analytics') || allows('analytics.read') ? ['Overview'] : []),
      ...(allows('jobs') || allows('jobs.read') || allows('requisitions.read') || allows('requisitions.approve_manager') || allows('requisitions.approve_finance') ? ['Requisitions'] : []),
      ...(allows('review') || allows('recruit') || allows('candidates.read') || allows('applications.read') ? ['Candidates', 'Pipeline'] : []),
      ...(allows('review') || allows('recruit') || allows('interview') || allows('interviews.read') ? ['Interviews'] : []),
      ...(allows('refer') || allows('referrals.read') ? ['Referrals'] : []),
      ...(allows('offers.templates.read') || allows('offers.read') || allows('recruit') || allows('admin') ? ['Offer Templates'] : []),
      ...(allows('training.read') || allows('training.manage') || allows('training.lifecycle') || allows('applications.evaluate') || allows('recruit') || allows('admin') ? ['Training Plans'] : []),
      ...(allows('agencies.read') || allows('admin') || allows('recruit') ? ['Agencies'] : []),
      ...manage
    ];
  }
  return [
    ...(allows('analytics.read') ? ['Overview'] : []),
    ...(allows('jobs.read') || allows('requisitions.read') || allows('requisitions.approve_manager') || allows('requisitions.approve_finance') || allows('requisitions.create') || allows('requisitions.update') ? ['Requisitions'] : []),
    ...(allows('candidates.read') ? ['Candidates'] : []),
    ...(allows('applications.read') ? ['Pipeline'] : []),
    ...(allows('interviews.read') || allows('interviews.evaluate') ? ['Interviews'] : []),
    ...(allows('referrals.read') ? ['Referrals'] : []),
    ...(allows('offers.templates.read') || allows('offers.read') ? ['Offer Templates'] : []),
    ...(allows('training.read') || allows('training.manage') || allows('training.lifecycle') ? ['Training Plans'] : []),
    ...(allows('agencies.read') ? ['Agencies'] : []),
    ...manage
  ];
};
// Every routable view is listed here so direct URL access can be checked
// against the same server-provided permission set that builds the navigation.
const knownViews = ['Overview','Requisitions','Candidates','Pipeline','Interviews','Referrals','Offer Templates','Training Plans','Agencies','Administration','Settings','Audit log','Pipeline settings','Integrations','Agency portal','Portal Dashboard','Assigned Roles','Submissions','Agency Team'];
let deniedView = '';
const resolveRouteName = raw => {
  const value = String(raw || '').replace(/^#\/?/, '').split('?')[0].trim();
  if (!value) return null;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch {}
  const key = decoded.toLowerCase();
  return knownViews.find(v => v.toLowerCase() === key || v.toLowerCase().replace(/\s+/g, '-') === key) || decoded;
};
const requestedRoute = () => resolveRouteName(location.hash);
const routeAllowed = view => Boolean(view && getNavList().includes(view));
const accessDeniedHtml = view => `<div class="heading"><div><p class="eyebrow">ACCESS CONTROL</p><h1>Access denied</h1><p class="muted">Your role does not permit this page.</p></div></div><section class="panel" role="alert" aria-live="assertive"><div class="empty"><p><strong>${escape(view || 'This page')}</strong> is not available for the <strong>${escape(me?.role || 'current')}</strong> role${me?.team?` in ${escape(me.team)}`:''}.</p><p class="muted">If you believe you need access, contact your System Administrator. Permissions are enforced on the server, not just in this interface.</p>${button(`Return to ${getNavList()[0] || 'your workspace'}`, 'navigate', '', `class="primary" data-view="${escape(getNavList()[0] || 'Overview')}"`)}</div></section>`;
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
const saveNavScroll = (navEl) => {
  if (!navEl) return;
  try {
    sessionStorage.setItem('orbit_nav_scroll_top', String(navEl.scrollTop));
    sessionStorage.setItem('orbit_nav_scroll_left', String(navEl.scrollLeft));
    localStorage.setItem('orbit_nav_scroll_top', String(navEl.scrollTop));
    localStorage.setItem('orbit_nav_scroll_left', String(navEl.scrollLeft));
  } catch {}
};
const scrollNavIntoView = (navEl, btn) => {
  if (!navEl || !btn) return;
  const navRect = navEl.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  if (!navRect.height || !btnRect.height) return;
  if (btnRect.top < navRect.top) {
    navEl.scrollTop -= (navRect.top - btnRect.top + 8);
  } else if (btnRect.bottom > navRect.bottom) {
    navEl.scrollTop += (btnRect.bottom - navRect.bottom + 8);
  }
  if (btnRect.left < navRect.left) {
    navEl.scrollLeft -= (navRect.left - btnRect.left + 8);
  } else if (btnRect.right > navRect.right) {
    navEl.scrollLeft += (btnRect.right - navRect.right + 8);
  }
};
const restoreNavScroll = (navEl) => {
  if (!navEl) return;
  let savedTop = null, savedLeft = null;
  try {
    savedTop = sessionStorage.getItem('orbit_nav_scroll_top') ?? localStorage.getItem('orbit_nav_scroll_top');
    savedLeft = sessionStorage.getItem('orbit_nav_scroll_left') ?? localStorage.getItem('orbit_nav_scroll_left');
  } catch {}
  if (savedTop !== null) navEl.scrollTop = Number(savedTop) || 0;
  if (savedLeft !== null) navEl.scrollLeft = Number(savedLeft) || 0;
  const activeBtn = navEl.querySelector('button.active');
  if (activeBtn) {
    scrollNavIntoView(navEl, activeBtn);
    saveNavScroll(navEl);
  }
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
const iconPaths={Overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',Requisitions:'M8 6V4h8v2 M3 7h18v13H3z M3 12h18 M10 11v3h4v-3',Candidates:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4',Pipeline:'M4 4h4v16H4z M10 4h4v11h-4z M16 4h4v7h-4z',Interviews:'M4 5h16v16H4z M8 2v6 M16 2v6 M4 10h16 M8 14h3 M14 14h2 M8 17h3',Referrals:'M12 20V10 M7 15l5-5 5 5 M4 4h16v4H4z','Offer Templates':'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8 M18 21H6','Training Plans':'M12 14l9-5-9-5-9 5 9 5z M12 14l6.16-3.422a12.083 12.083 0 0 1 .665 6.479A11.952 11.952 0 0 0 12 20.055a11.952 11.952 0 0 0-6.824-2.998 12.078 12.078 0 0 1 .665-6.479L12 14z M12 14v7 M7 11.5v4 M17 11.5v4',Agencies:'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75','Portal Dashboard':'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z','Assigned Roles':'M8 6V4h8v2 M3 7h18v13H3z M3 12h18 M10 11v3h4v-3',Submissions:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8','Agency Team':'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',Administration:'M12 3l8 4v6c0 4-4 7-8 9-4-2-8-5-8-9V7z M8 12l3 3 5-6','Audit log':'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h4','Pipeline settings':'M4 7h16 M4 17h16 M8 4v6 M16 14v6',Settings:'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',Integrations:'M8 3v5 M16 3v5 M5 8h14v4a7 7 0 0 1-14 0z M12 19v3','Agency portal':'M4 21v-8a8 8 0 0 1 16 0v8 M9 21v-4a3 3 0 0 1 6 0v4 M2 21h20'};
const icon=name=>`<svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name]||iconPaths.Overview}"/></svg>`;
const initials=name=>escape(String(name).split(/\s+/).filter(Boolean).slice(0,2).map(n=>n[0]).join('').toUpperCase());
const applyTheme=theme=>{document.documentElement.dataset.theme=theme;document.querySelector('meta[name="theme-color"]').content=theme==='midnight'?'#0b1322':'#111f35';};
const brand=()=>`<div class="company-logo"><img src="/mechlin-logo.webp" alt="Mechlin Technologies" width="174" height="40"></div><div class="product-brand"><span class="orbit-symbol" aria-hidden="true"></span><span>Orbit<small>Talent workspace</small></span></div>`;
// Broad legacy tokens (recruit, review, admin, and the rest) are derived from
// whichever grants a role happens to have. They must not open extra modules
// once the server has sent the real grant list.
const legacyCapabilities = new Set(['admin','recruit','requisition','approve_manager','approve_finance','review','analytics','refer','jobs','interview']);
const allows = p => (grants.length && legacyCapabilities.has(p) ? false : permissions.includes(p) || grants.includes(p));
const allowAction = (id, ...legacyFallback) => allows(id) || (!grants.length && legacyFallback.some(token => permissions.includes(token)));
const canEditRolePermissions = role => allows('roles.update') && (!role?.is_system || role?.permissions_editable === true);
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
function applyMeData(data){
  me={ ...data.user, agency: data.agency, permissionGroups: data.permissionGroups||[], permissionRegistry: data.permissionRegistry||[], roleScope: data.roleScope, roleDefinition: data.roleDefinition };
  csrf=data.csrf;
  permissions=data.permissions||[];
  grants=data.grants||[];
}
async function refreshCurrentUser(){
  applyMeData(await api('me'));
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
const normalizeTeam = val => {
  if (!val || typeof val !== 'string') return '';
  const clean = val.trim();
  if (!clean) return '';
  const lower = clean.toLowerCase();
  if (
    lower === 'qa' ||
    lower === 'quality assurance' ||
    lower === 'quality assurance team' ||
    lower === 'qa team' ||
    lower === 'qa candidate pool' ||
    lower === 'qa pool' ||
    lower === 'qa talent pool' ||
    lower === 'quality assurance candidate pool' ||
    lower === 'quality assurance pool' ||
    /^(qa|quality\s+assurance)(\s+(team|candidate\s+pool|talent\s+pool|pool))?$/i.test(clean)
  ) return 'QA';
  if (lower === 'dev' || lower === 'engineering' || lower === 'software engineering' || lower === 'development') return 'Dev';
  if (lower === 'bd' || lower === 'business development') return 'BD';
  if (lower === 'devops' || lower === 'dev ops' || lower === 'sre' || lower === 'infrastructure') return 'DevOps';
  if (lower === 'hr' || lower === 'human resources' || lower === 'people' || lower === 'people operations') return 'HR';
  if (lower === 'product' || lower === 'product management') return 'Product';
  if (lower === 'design' || lower === 'ui/ux' || lower === 'product design') return 'Design';
  if (lower === 'operations' || lower === 'ops') return 'Operations';
  if (lower === 'sales') return 'Sales';
  if (lower === 'pm' || lower === 'project manager' || lower === 'project management') return 'PM';
  if (lower === 'tl' || lower === 'tech lead' || lower === 'team lead') return 'TL';
  if (lower === 'other') return 'Other';
  const match = standardTeams.find(t => t.toLowerCase() === lower);
  return match || clean;
};
const teamSelect = (label,name,selected='',allowOrg=false) => {
  const normSelected = normalizeTeam(selected ? String(selected).split(/[,;/|]+/)[0] : '');
  const options = [];
  if (allowOrg) options.push(['', 'Organization (No specific team)']);
  for (const t of standardTeams) options.push([t, t]);
  if (normSelected && normSelected !== '' && !standardTeams.includes(normSelected) && normSelected !== 'Engineering') {
    options.push([normSelected, normSelected]);
  }
  const required = !allowOrg;
  return `<label>${formatLabel(label, required)}<select name="${name}" ${required ? 'required aria-required="true"' : ''}>${options.map(([id, title]) => {
    const isSel = normSelected ? id.toLowerCase() === normSelected.toLowerCase() : id === selected;
    return `<option value="${escape(id)}" ${isSel ? 'selected' : ''}>${escape(title)}</option>`;
  }).join('')}</select></label>`;
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
const setupInterviewFormatToggle = (initialType = 'virtual') => {
  const form = $('#edit-form');
  if (!form) return;
  const typeSelect = form.querySelector('[name="interview_type"]');
  const meetRow = form.querySelector('#row-meeting-url');
  const locRow = form.querySelector('#row-location');
  const noteEl = form.querySelector('#interview-format-note');
  if (!typeSelect) return;
  const sync = () => {
    const isPhysical = typeSelect.value === 'in_person';
    if (meetRow) meetRow.style.display = isPhysical ? 'none' : '';
    if (locRow) locRow.style.display = isPhysical ? '' : 'none';
    if (noteEl) {
      if (isPhysical) {
        noteEl.innerHTML = '<strong>Physical / In-Person interview:</strong> No virtual meeting link will be generated. Candidate arrival instructions and office venue details will be dispatched.';
      } else {
        noteEl.innerHTML = '<strong>Virtual / Online interview:</strong> Microsoft Teams meeting link synchronizes automatically (or uses your custom URL) and is emailed to the candidate.';
      }
    }
  };
  typeSelect.addEventListener('change', sync);
  sync();
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
      statusEl.innerHTML = `<span style="color:var(--success, #16a34a);"><strong>${escape(resObj.filename || file.name)}</strong> (${escape((resObj.format || 'doc').toUpperCase())}, ${Math.round((resObj.size || file.size) / 1024)} KB) extracted successfully.${escape(warningsText)}</span>`;
      notice(`Resume ${resObj.filename || file.name} parsed successfully. Review extracted text below.`, 'success');
    } catch (err) {
      statusEl.innerHTML = `<span class="error">Upload failed: ${escape(err.message)}</span>`;
      fileInput.value = '';
      notice(err.message, 'error');
    }
  });
};
const pad = n => String(n).padStart(2, '0');
const formatDateTimeIST = (val) => {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d.getTime())) return escape(val);
  return d.toLocaleString('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }) + ' IST';
};
const formatDateIST = (val) => {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d.getTime())) return escape(val);
  return d.toLocaleDateString('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
};
const toISTDateTimeInput = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const parseISTDateTime = (str) => {
  if (!str) return null;
  const s = String(str).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const hasSeconds = s.length > 16;
    return new Date(`${s}${hasSeconds ? '' : ':00'}+05:30`);
  }
  return new Date(s);
};
const getLocalDateString = (d = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const getLocalTodayMin = () => `${getLocalDateString()}T00:00`;
const isPastInterviewDate = (date) => {
  if (!date || !Number.isFinite(date.getTime())) return true;
  const todayIST = getLocalDateString(new Date());
  const dateIST = getLocalDateString(date);
  if (dateIST >= todayIST) return false;
  const localToday = new Date();
  localToday.setHours(0, 0, 0, 0);
  if (date.getTime() >= localToday.getTime()) return false;
  const todayUTC = new Date().toISOString().slice(0, 10);
  const dateUTC = date.toISOString().slice(0, 10);
  if (dateUTC >= todayUTC) return false;
  return true;
};
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
let isPointerDownOutsideModal = false;
const closeModal = () => {
  isPointerDownOutsideModal = false;
  const n = $('#notice');
  if(n && n.parentElement !== document.body) document.body.appendChild(n);
  const m = $('#modal');
  if(m){
    try{
      if(typeof m.close === 'function' && m.open) m.close();
    }catch{}
    m.removeAttribute('open');
  }
  const body = $('#modal-body');
  if(body) body.innerHTML = '';
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
$('#close-modal').onclick = closeModal;

const isEventOutsideModal = (e) => {
  const m = $('#modal');
  if (!m || !m.open) return false;
  if (e.target !== m && m.contains(e.target)) return false;
  const rect = m.getBoundingClientRect();
  const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : undefined));
  const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : undefined));
  if (clientX === undefined || clientY === undefined) return false;
  return (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  );
};

const modalEl = $('#modal');
if (modalEl) {
  const recordPointerDown = (e) => {
    isPointerDownOutsideModal = (e.target === modalEl && isEventOutsideModal(e));
  };
  modalEl.addEventListener('pointerdown', recordPointerDown, { capture: true });
  modalEl.addEventListener('mousedown', recordPointerDown, { capture: true });
  modalEl.addEventListener('touchstart', recordPointerDown, { passive: true, capture: true });

  modalEl.addEventListener('click', (e) => {
    const wasPointerDownOutside = isPointerDownOutsideModal;
    isPointerDownOutsideModal = false;
    if (wasPointerDownOutside && e.target === modalEl && isEventOutsideModal(e)) {
      closeModal();
    }
  });

  modalEl.addEventListener('close', () => {
    isPointerDownOutsideModal = false;
    const n = $('#notice');
    if (n && n.parentElement !== document.body) document.body.appendChild(n);
    if (modalEl.open) return;
    const body = $('#modal-body');
    if (body) body.innerHTML = '';
  });
}
function permissionActionBucket(id) {
  const action = String(id || '').split('.').slice(1).join('.');
  if (/^(read|read_all|assigned\.read|personal\.read|resume\.read|communications\.read|consent\.read|fraud\.read|compensation\.read|feedback\.read|templates\.read|submissions\.read)$/.test(action) || action.endsWith('.read')) return 'Read';
  if (action === 'create' || action === 'schedule' || action === 'request') return 'Create';
  if (action === 'delete' || action === 'deactivate' || action === 'cancel' || action === 'withdraw' || action === 'archive') return 'Delete';
  if (/^(update|configure|submit|evaluate|process|assign|match|upload)$/.test(action) || action.endsWith('.update') || action.endsWith('.manage') || action.endsWith('.send') || action.endsWith('.upload')) return 'Edit';
  return 'Other';
}
function rolePermissionEditor(selected, readOnly) {
  const selectedSet = new Set(selected || []);
  const groups = me?.permissionGroups || [];
  const actionOrder = { Read: 1, Create: 2, Edit: 3, Delete: 4, Other: 5 };

  const groupHtml = groups.map(group => {
    const sortedPerms = [...group.permissions].sort((a, b) => {
      const bucketA = permissionActionBucket(a.id);
      const bucketB = permissionActionBucket(b.id);
      return (actionOrder[bucketA] || 99) - (actionOrder[bucketB] || 99);
    });

    const activeInGroup = group.permissions.filter(p => selectedSet.has(p.id)).length;

    const cards = sortedPerms.map(p => {
      const action = permissionActionBucket(p.id);
      const isChecked = selectedSet.has(p.id);
      const actionLabel = action === 'Edit' ? 'Write / Edit' : action;
      return `<label class="perm-card${isChecked ? ' is-checked' : ''}">` +
        `<div class="perm-card-top">` +
          `<div class="perm-card-title-group">` +
            `<span class="perm-name">${escape(p.name)}</span>` +
            `<span class="perm-badge badge-${action.toLowerCase()}">${escape(actionLabel)}</span>` +
            `${p.sensitive ? '<span class="perm-sensitive">Sensitive</span>' : ''}` +
          `</div>` +
          `<span class="perm-switch" aria-hidden="true"><span class="perm-knob"></span></span>` +
        `</div>` +
        `<small class="perm-desc">${escape(p.description)}</small>` +
        `<input type="checkbox" role="switch" aria-checked="${isChecked ? 'true' : 'false'}" aria-label="${escape(p.name)}" data-permission value="${escape(p.id)}" ${isChecked ? 'checked' : ''} ${readOnly ? 'disabled' : ''}>` +
      `</label>`;
    }).join('');

    return `<section class="perm-module-card" data-module="${escape(group.module)}">` +
      `<div class="perm-module-header">` +
        `<div class="perm-module-title">` +
          `<h3>${escape(group.module)}</h3>` +
          `<span class="perm-module-count">${activeInGroup} of ${group.permissions.length} on</span>` +
        `</div>` +
        `${readOnly ? '' : `<div class="perm-module-actions">` +
          `<button type="button" class="btn-module-select" data-action="select-module">Select all</button>` +
          `<button type="button" class="btn-module-select" data-action="deselect-module">Deselect all</button>` +
        `</div>`}` +
      `</div>` +
      `<div class="perm-grid">${cards}</div>` +
    `</section>`;
  }).join('');

  return `<div class="full permission-editor">` +
    `<div class="permission-toolbar">` +
      `<div class="perm-toolbar-left">` +
        `<div class="perm-search-box">` +
          `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="perm-search-icon" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>` +
          `<input type="search" id="perm-search-input" placeholder="Search permissions..." aria-label="Search permissions">` +
        `</div>` +
        `<span id="role-permission-count" class="perm-total-badge">${selectedSet.size} on</span>` +
      `</div>` +
      `${readOnly ? '' : `<div class="perm-toolbar-actions">` +
        `<button type="button" class="btn-perm-action" id="permission-select-all">Turn all on</button>` +
        `<button type="button" class="btn-perm-action" id="permission-clear">Turn all off</button>` +
      `</div>`}` +
    `</div>` +
    `<input type="hidden" name="permissions" id="role-permission-values" value="${escape([...selectedSet].join(','))}"><div class="permission-groups">${groupHtml}</div><p class="muted perm-note">ON grants the permission. OFF leaves it out. Save stores the selection; Cancel discards it.</p></div>`;
}
function bindRolePermissionEditor() {
  const holder = $('#modal-body');
  if (!holder) return;
  const boxes = () => [...holder.querySelectorAll('[data-permission]')];
  const sync = () => {
    const values = boxes().filter(box => box.checked).map(box => box.value);
    const hidden = $('#role-permission-values');
    if (hidden) hidden.value = values.join(',');
    const count = $('#role-permission-count');
    if (count) count.textContent = `${values.length} on`;
    boxes().forEach(box => {
      box.setAttribute('aria-checked', box.checked ? 'true' : 'false');
      const card = box.closest('.perm-card');
      if (card) card.classList.toggle('is-checked', box.checked);
    });
    holder.querySelectorAll('.perm-module-card').forEach(m => {
      const total = m.querySelectorAll('[data-permission]').length;
      const checked = m.querySelectorAll('[data-permission]:checked').length;
      const countEl = m.querySelector('.perm-module-count');
      if (countEl) countEl.textContent = `${checked} of ${total} on`;
    });
  };
  boxes().forEach(box => box.addEventListener('change', sync));
  holder.querySelectorAll('[data-scope]').forEach(button => button.addEventListener('click', () => {
    const hidden = $('#role-scope');
    if (hidden) hidden.value = button.dataset.scope;
    holder.querySelectorAll('[data-scope]').forEach(item => {
      const on = item === button;
      item.classList.toggle('is-selected', on);
      item.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }));
  $('#permission-clear')?.addEventListener('click', () => {
    boxes().forEach(box => { if (!box.disabled) box.checked = false; });
    sync();
  });
  $('#permission-select-all')?.addEventListener('click', () => {
    boxes().forEach(box => { if (!box.disabled) box.checked = true; });
    sync();
  });
  holder.querySelectorAll('[data-action="select-module"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.perm-module-card');
      if (!card) return;
      card.querySelectorAll('[data-permission]:not(:disabled)').forEach(b => { b.checked = true; });
      sync();
    });
  });
  holder.querySelectorAll('[data-action="deselect-module"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.perm-module-card');
      if (!card) return;
      card.querySelectorAll('[data-permission]:not(:disabled)').forEach(b => { b.checked = false; });
      sync();
    });
  });
  const searchInput = holder.querySelector('#perm-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      holder.querySelectorAll('.perm-card').forEach(card => {
        const text = (card.textContent || '').toLowerCase();
        card.style.display = (!q || text.includes(q)) ? '' : 'none';
      });
      holder.querySelectorAll('.perm-module-card').forEach(m => {
        const hasVisible = [...m.querySelectorAll('.perm-card')].some(c => c.style.display !== 'none');
        m.style.display = hasVisible ? '' : 'none';
      });
    });
  }
  sync();
}
function openRoleModal(role = null, readOnly = false, duplicate = false) {
  const source = role || {};
  const editing = Boolean(source.id) && !duplicate;
  const systemRole = Boolean(source.is_system) && !duplicate;
  const permissionsEditable = !readOnly && (!editing || canEditRolePermissions(source));
  const identityLocked = readOnly || systemRole;
  const selected = duplicate && me?.role !== 'System Admin'
    ? (source.permissions || []).filter(permission => grants.includes(permission))
    : (source.permissions || []);
  const name = duplicate ? `${source.name.replace(/(\s+copy(\s+\d+)?|\s*\(\d+\))$/i, '')} copy` : (source.name || '');
  const description = source.description || '';
  const canUseOrganizationScope = me?.role === 'System Admin';
  const requestedScope = source.scope || 'team';
  const scope = requestedScope === 'organization' && !canUseOrganizationScope ? 'team' : requestedScope;
  const policyNote = systemRole
    ? (permissionsEditable
      ? 'System role names, descriptions and record scopes are protected. Permission changes are saved as a customization, apply immediately and persist across restarts.'
      : 'This system role is fully protected and cannot be edited.')
    : 'Organization roles see every team. Team roles are limited to the user\'s team. Assigned roles only see records explicitly assigned to them.';
  const scopeChoices = [
    ['organization', 'Organization', 'Every team'],
    ['team', 'Team', 'The user\'s team'],
    ['assigned', 'Assigned', 'Records assigned to the user'],
    ['none', 'None', 'No record access']
  ];
  const scopeField = `<fieldset class="full scope-field"><legend>Record scope</legend><input type="hidden" name="scope" id="role-scope" value="${escape(scope)}" ${identityLocked ? 'disabled' : ''}><div class="scope-choices" role="radiogroup" aria-label="Record scope">${scopeChoices.map(([value, label, hint]) => {
    const blocked = value === 'organization' && !canUseOrganizationScope;
    return `<button type="button" class="scope-choice${scope === value ? ' is-selected' : ''}" data-scope="${value}" ${identityLocked || blocked ? 'disabled' : ''} aria-pressed="${scope === value}"><strong>${label}</strong><small>${hint}</small></button>`;
  }).join('')}</div></fieldset><p class="full muted scope-note">${policyNote}</p>`;
  const html = `<div class="form-grid role-form"><label class="full">Role name<input name="name" value="${escape(name)}" maxlength="80" required ${identityLocked ? 'readonly' : ''}></label><label class="full">Description<textarea name="description" rows="2" maxlength="500" ${identityLocked ? 'readonly' : ''}>${escape(description)}</textarea></label>${scopeField}${rolePermissionEditor(selected, !permissionsEditable)}</div>`;
  if (!permissionsEditable) {
    modal(readOnly ? 'Role permissions' : 'Protected system role', html, null);
    bindRolePermissionEditor();
    return;
  }
  modal(systemRole ? 'Edit role permissions' : editing ? 'Edit role' : 'Create role', html, async values => {
    const permissions = String(values.permissions || '').split(',').filter(Boolean);
    if (!systemRole && !String(values.name || '').trim()) throw new Error('Role name is required.');
    if (editing) {
      const payload = systemRole
        ? { version: source.version, permissions }
        : { name: values.name, description: values.description, scope: values.scope, permissions, version: source.version };
      await api(`admin/roles/${source.id}`, 'PUT', payload);
      await refreshCurrentUser();
      adminTab = 'roles';
      return systemRole
        ? 'System role permissions updated. Changes apply immediately and persist across restarts.'
        : 'Role updated. Access changes take effect immediately.';
    }
    await api('admin/roles', 'POST', { name: values.name, description: values.description, scope: values.scope, permissions });
    adminTab = 'roles';
    return 'Role created.';
  }, { saveLabel: systemRole ? 'Save permissions' : editing ? 'Save role' : 'Create role' });
  bindRolePermissionEditor();
}
function openArchiveRoleModal(role) {
  modal(`Archive ${role.name}`, `<div class="notice-inline danger-notice"><strong>${escape(role.name)}</strong> will stop appearing in role assignment lists.</div><p>Archiving is blocked while any user is assigned. This action is recorded in the audit log.</p><label class="full">Reason<textarea name="reason" rows="2" maxlength="500" placeholder="Why this role is being retired"></textarea></label>`, async values => {
    await api(`admin/roles/${role.id}`, 'DELETE', { reason: values.reason });
    adminTab = 'roles';
    return 'Role archived.';
  }, { saveLabel: 'Archive role' });
}
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
      applyMeData(await api('me'));
      candidateQuery='';
      reqPage=1;
      Object.keys(pageState).forEach(k=>pageState[k]=1);
      try{sessionStorage.removeItem('orbit_current');sessionStorage.removeItem('orbit_pages');sessionStorage.removeItem('orbit_nav_scroll_top');sessionStorage.removeItem('orbit_nav_scroll_left');localStorage.removeItem('orbit_current');localStorage.removeItem('orbit_pages');localStorage.removeItem('orbit_nav_scroll_top');localStorage.removeItem('orbit_nav_scroll_left');}catch{}
      const nav=getNavList();
      current=nav[0]||'Overview';
      return `Switched persona to ${me.role} · ${me.team||'Organization'}.`;
    }else{
      const res=await fetch('/auth/demo-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,team})});
      const data=await res.json();
      if(!res.ok)throw new Error(data.error||'Demo login failed.');
      csrf=data.csrf;
      me=data.user;
      applyMeData(await api('me'));
      loadSavedPages();
      const nav=getNavList();
      current=getSavedNav(nav);
      cleanAccessQuery();
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
    const normCurrent = normalizeTeam(currentTeam);
    teamSelectEl.innerHTML=options.map(([val,label])=>`<option value="${escape(val)}" ${(normCurrent ? val.toLowerCase() === normCurrent.toLowerCase() : val===currentTeam)?'selected':''}>${escape(label)}</option>`).join('');
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
const cleanAccessQuery = () => {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('access')) {
      const u = new URL(location.href);
      u.searchParams.delete('access');
      history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + (u.hash || ''));
    }
  } catch {}
};
function login() {
  const status=new URLSearchParams(location.search).get('access');
  const messages={pending:'Access pending approval. Your request has been sent to the ATS administrators. Sign in again after approval.',rejected:'Your access request was rejected. Contact your ATS administrator.',disabled:'Your access has been disabled. Contact your ATS administrator.'};
  const isDemoEnabled=document.documentElement.dataset.demoLogin==='true';
  applyTheme(appearance.theme);
  $('#app').innerHTML=`<div class="login"><section class="login-brand"><div>${brand()}</div><div class="login-message"><p class="eyebrow">People. Possibility. Orbit.</p><h1>Great teams<br>start with<br><em>great connections.</em></h1><p>A shared space for every step of your next great hire.</p><div class="login-steps"><span>Discover</span><span>Connect</span><span>Hire</span></div></div><p class="login-footer">A Mechlin product · Built for our people</p></section><main class="login-form" id="main"><div class="login-card"><span class="workspace-label">MECHLIN WORKSPACE</span><h1>Welcome to Orbit</h1><p class="muted">Your team’s next chapter starts here.</p>${messages[status]?`<div class="notice-inline">${messages[status]}${status==='pending'?' <a href="/" style="color:inherit;text-decoration:underline;margin-left:8px;font-weight:600;">Check status</a>':''}</div>`:''}<a class="button microsoft-signin" href="/auth/login"><span class="microsoft-mark" aria-hidden="true"></span>Sign in with Microsoft 365</a><p class="muted">Use your Mechlin work account. New team members need administrator approval.</p>${isDemoEnabled?`<div class="demo-login-divider"><span>OR QA TESTING</span></div><button type="button" class="button secondary demo-signin-button" data-action="demo-login-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="margin-right:8px;"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4"/></svg>Demo / QA Login</button>`:''}<div class="login-access-note">${icon('Administration')}<span>Private workspace. Approved access only.</span></div></div></main></div>`;
}
function shell() {
  const nav=getNavList();
  if (!nav.length) {
    deniedView = deniedView || 'this workspace';
  } else if (!deniedView && !nav.includes(current)) {
    current = nav[0];
  }
  const isDemoEnabled=document.documentElement.dataset.demoLogin==='true';
  const showQASwitch=Boolean(me?.isDemoUser||isDemoEnabled);

  const existingLayout = document.querySelector('#app .layout');
  const existingNav = document.querySelector('.sidebar nav');
  const existingSidebar = document.querySelector('.sidebar');
  const existingButtons = existingNav ? Array.from(existingNav.querySelectorAll('[data-nav]')) : [];
  const existingKeys = existingButtons.map(b => b.dataset.nav).join(',');
  const targetKeys = nav.join(',');
  const currentUserId = String(me?.id || '');
  const prevUserId = existingSidebar?.dataset.userId || '';

  if (existingLayout && existingNav && existingKeys === targetKeys && prevUserId === currentUserId) {
    existingButtons.forEach(b => {
      const isActive = b.dataset.nav === current;
      b.classList.toggle('active', isActive);
      if (isActive) {
        b.setAttribute('aria-current', 'page');
      } else {
        b.removeAttribute('aria-current');
      }
    });
    const bc = document.querySelector('.breadcrumb strong');
    if (bc) bc.textContent = current;
    const activeBtn = existingNav.querySelector('button.active');
    if (activeBtn) {
      scrollNavIntoView(existingNav, activeBtn);
      saveNavScroll(existingNav);
    }
    return;
  }

  let prevScrollTop = existingNav ? existingNav.scrollTop : null;
  let prevScrollLeft = existingNav ? existingNav.scrollLeft : null;
  if (prevScrollTop === null) {
    try {
      const st = sessionStorage.getItem('orbit_nav_scroll_top') ?? localStorage.getItem('orbit_nav_scroll_top');
      if (st !== null) prevScrollTop = Number(st) || 0;
      const sl = sessionStorage.getItem('orbit_nav_scroll_left') ?? localStorage.getItem('orbit_nav_scroll_left');
      if (sl !== null) prevScrollLeft = Number(sl) || 0;
    } catch {}
  }

  $('#app').innerHTML=`<div class="layout"><aside class="sidebar" data-user-id="${escape(currentUserId)}"><div class="sidebar-brand">${brand()}</div><nav aria-label="Main navigation"><p class="nav-label">WORKSPACE</p>${nav.map(n=>`${n==='Administration'?'<p class="nav-label admin-label">MANAGE</p>':''}<button data-nav="${n}" class="${current===n?'active':''}" ${current===n?'aria-current="page"':''}>${icon(n)}<span>${n}</span></button>`).join('')}</nav><div class="profile"><span class="avatar">${initials(me.name)}</span><div><strong>${escape(me.name)}</strong><div class="muted">${escape(me.role)}${me.team?` · ${escape(me.team)}`:''}</div>${me.isDemoUser?'<span class="qa-badge">QA Demo User</span>':''}</div></div><div class="sidebar-caption">Mechlin Orbit · Internal workspace</div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb">Orbit <span>/</span> <strong>${escape(current)}</strong></div><div class="topbar-right">${showQASwitch?`<button type="button" class="secondary qa-switch-button" data-action="switch-demo-role" title="Switch QA Demo Persona">${icon('Administration')}<span>Switch QA Role</span></button>`:''}<span class="workspace-status">${icon('Administration')} Private workspace</span><button class="secondary" data-action="logout">Sign out</button><span class="avatar small" aria-label="${escape(me.name)}">${initials(me.name)}</span></div></header><main class="content" id="main" tabindex="-1"><p class="muted">Loading your workspace…</p></main><footer class="workspace-footer">Thoughtful hiring, together. <span>Orbit by Mechlin</span></footer></div></div>`;

  const newNav = document.querySelector('.sidebar nav');
  if (newNav) {
    if (prevScrollTop !== null) newNav.scrollTop = prevScrollTop;
    if (prevScrollLeft !== null) newNav.scrollLeft = prevScrollLeft;
    newNav.addEventListener('scroll', () => saveNavScroll(newNav), { passive: true });
    requestAnimationFrame(() => {
      const activeBtn = newNav.querySelector('button.active');
      if (activeBtn) scrollNavIntoView(newNav, activeBtn);
      saveNavScroll(newNav);
    });
  }

  document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{
    if(current!==b.dataset.nav){
      deniedView='';
      reqPage=1;
      pageState[b.dataset.nav]=1;
      if(b.dataset.nav==='Candidates')candidateQuery='';
    }
    current=b.dataset.nav;
    syncNavState();
    saveNavScroll(document.querySelector('.sidebar nav'));
    render();
  });
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
  const heading=(subtitle,action='')=>`<div class="heading"><div><p class="eyebrow">${isAgencyUser()?'EXTERNAL RECRUITER PORTAL':current==='Overview'?`YOUR TEAM. YOUR NEXT CHAPTER.`:['Settings','Administration','Audit log','Pipeline settings'].includes(current)?'WORKSPACE MANAGEMENT':'TALENT ACQUISITION'}</p><h1>${current}</h1><p class="muted">${subtitle}</p></div>${action}</div>`;
  try {
    const config=await api('appearance');if(version!==renderVersion||!me)return;appearance=config;applyTheme(config.theme);cleanAccessQuery();shell();
    if(deniedView){
      if(version===renderVersion&&me){
        $('#main').innerHTML=accessDeniedHtml(deniedView);
        document.title=`Access denied · Orbit by Mechlin`;
      }
      return;
    }
    if(current==='Overview') {
      const [stats,reqs]=await Promise.all([api('analytics'),api('requisitions')]);
      html=heading(`Welcome back, ${escape(me.name.split(' ')[0])}. Let’s move great people forward.`,allowAction('candidates.create','recruit')?button('+ Add candidate','new-candidate'):'')+`<div class="metrics">${[['Open requisitions',stats.openRequisitions,'Requisitions','Ready for your next hire'],['Approved headcount',stats.approvedHeadcount,'Referrals','Positions approved to fill'],['Candidates',stats.candidates,'Candidates','People in your talent pool'],['Awaiting approval',stats.pendingApprovals,'Administration','Requisitions awaiting a decision']].map(([label,count,i,note],n)=>`<div class="metric metric-${n}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(i)}</span></div><strong>${count}</strong><small>${note}</small></div>`).join('')}</div><div class="split"><section class="panel"><div class="panel-head"><div><h2>Hiring momentum</h2><p class="muted">A snapshot of your recruitment pipeline</p></div><span class="subtle-label">Current applications</span></div>${Object.entries(stats.stageCounts).map(([stage,count],n)=>`<div class="bar-row stage-${n}"><span>${escape(stage)}</span><progress value="${count}" max="${Math.max(1,...Object.values(stats.stageCounts))}" aria-label="${escape(stage)}"></progress><strong>${count}</strong></div>`).join('')}</section><section class="panel panel-attention"><div class="panel-head"><div><h2>Needs your attention</h2><p class="muted">Keep the next hire moving</p></div><span class="count-pill">${stats.pendingApprovals}</span></div><div class="attention-list" id="attention-list">${reqs.filter(r=>r.status.startsWith('pending')).map(r=>{
        const isSelfRestricted = r.created_by === me?.id && !allows('requisitions.override') && !allows('system.override');
        const canRev = ((r.status === 'pending_manager' && allowAction('requisitions.approve_manager','approve_manager')) || (r.status === 'pending_finance' && allowAction('requisitions.approve_finance','approve_finance'))) && !isSelfRestricted;
        return `<div class="attention-card"><div class="attention-title">${icon('Requisitions')}<strong>${escape(r.title)}</strong></div><p class="muted">${escape(r.team)} · ${r.headcount} opening(s)</p><div class="attention-bottom">${badge(r.status)}${button('View role','req-details',r.id,'class="text-button"')}${canRev ? button('Review','approve-req',r.id,'class="secondary" style="font-size:0.75rem;padding:2px 8px;"') : ''}</div></div>`;
      }).join('')||empty('All caught up. No pending requisitions.')}</div><p class="panel-footnote">Approvals keep hiring aligned with your team’s plans.</p></section></div><section class="panel"><div class="panel-head"><div><h2>Recent requisitions</h2><p class="muted">The roles shaping your next chapter</p></div>${button('View all roles','navigate','','class="text-button" data-view="Requisitions"')}</div>${reqTable(reqs.slice(0,5))}</section>`;
    }
    if(current==='Requisitions') {
      const reqs=await api('requisitions');
      const {paged,page,totalPages,total,start}=paginate(reqs,pageState.Requisitions||1,10);
      pageState.Requisitions=page;reqPage=page;
      const pag=renderPagination('Requisitions',page,totalPages,total,start,10);
      html=heading('Headcount, job descriptions and approval decisions.',allowAction('requisitions.create','requisition','recruit')?button('+ New requisition','new-req'):'')+`<section class="panel">${reqTable(paged)}${pag}</section>`;
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
      html=heading('Search skills, experience and candidate records.',allowAction('candidates.create','recruit')?button('+ Add candidate','new-candidate'):'')+`<section class="panel candidates-panel"><div class="panel-head"><h2>Candidate directory</h2><label class="search">Search<input id="candidate-search" type="search" placeholder="Search name, email or skill" value="${escape(candidateQuery)}"></label></div><div id="candidate-table">${renderCandidateTable()}</div></section>`;
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
      const isTerminalStage = s => ['Hired', 'Rejected', 'Revoked'].includes(s);
      const activeStages = stages.filter(s => !isTerminalStage(s));
      html=heading('Move each application through a consistent hiring process.',allowAction('applications.create','recruit')?button('+ Add application','new-application'):'')+
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
            (stages.includes('Revoked') ? `<span class="legend-outcome-pill revoked-pill"><span class="legend-outcome-dot"></span> Revoked</span>` : '')+
          `</div>`+
        `</div>`+
        `<div class="board" id="pipeline-board">${stages.map((stage,index)=>{
          const isTerm = isTerminalStage(stage);
          const colTerminalClass = isTerm ? ' column-terminal' : '';
          const stageColClass = stage==='Hired' ? ' column-terminal-hired' : (stage==='Rejected' ? ' column-terminal-rejected' : (stage==='Revoked' ? ' column-terminal-revoked' : ''));
          const stageApps = apps.filter(a => a.stage === stage);
          const isTraining = /pre-onboarding|training/i.test(stage);

          return `<section class="column${colTerminalClass}${stageColClass}" data-stage="${escape(stage)}">`+
            `<h2><span class="column-header-title">`+
              (isTerm ? `<span class="column-stage-type ${stage==='Hired'?'type-hired':(stage==='Revoked'?'type-revoked':'type-rejected')}">${stage==='Hired'?'Hired':(stage==='Revoked'?'Revoked':'Outcome')}</span>` : '')+
              `<span class="column-name-text">${escape(stage)}</span>`+
            `</span><span class="column-count ${stage==='Hired'?'count-hired':(stage==='Revoked'?'count-revoked':(stage==='Rejected'?'count-rejected':''))}">${stageApps.length}</span></h2>`+
            `<div class="column-content">${stageApps.map(a=>{
              const hasEval = Boolean(a.training_evaluation || a.training_rating);
              const evalRating = a.training_rating || a.training_evaluation?.rating;
              const evalDec = a.training_decision || a.training_evaluation?.decision || 'next';
              const evalChip = (isTraining && hasEval) ? `<div class="training-card-chip"><span class="badge ${evalDec==='rejected'||evalDec==='revoked'?'rejected':'completed'}" style="font-size:0.72rem;">${evalRating}/5 ${evalDec==='next'?'Passed':(evalDec==='revoked'?'Revoked':'Failed')}</span></div>` : '';

              let planChip = '';
              if (isTraining) {
                const st = a.training_plan_status;
                if (st === 'sent') {
                  planChip = `<div class="training-card-chip" style="margin-top:2px;"><span class="badge" style="background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;font-size:0.72rem;">Plan Sent</span></div>`;
                } else if (st === 'draft_saved') {
                  planChip = `<div class="training-card-chip" style="margin-top:2px;"><span class="badge" style="background:#e0e7ff;color:#3730a3;border:1px solid #c7d2fe;font-size:0.72rem;">Plan Draft Saved</span></div>`;
                } else if (st === 'failed') {
                  planChip = `<div class="training-card-chip" style="margin-top:2px;"><span class="badge" style="background:#fee2e2;color:#991b1b;border:1px solid #fecaca;font-size:0.72rem;">Plan Send Failed</span></div>`;
                } else {
                  planChip = `<div class="training-card-chip" style="margin-top:2px;"><span class="badge" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;font-size:0.72rem;">Plan Pending Review</span></div>`;
                }
              }
              let interviewChip = '';
              const isInterviewStage = !isTraining && !isTerm && !/applied|onboarding|offer/i.test(stage);
              if (isInterviewStage) {
                if (a.pending_interview) {
                  const ready = feedbackReady(a.pending_interview);
                  interviewChip = `<div class="interview-card-chip" style="margin-top:2px;"><span class="badge ${ready ? 'pending' : 'active'}" style="font-size:0.72rem;background:${ready ? '#fef3c7' : '#ecfdf5'};color:${ready ? '#92400e' : '#065f46'};border:1px solid ${ready ? '#fde68a' : '#a7f3d0'};">📅 ${ready ? 'Rating Required' : 'Interview Scheduled'} (${escape(a.pending_interview.interviewer_name)})</span></div>`;
                } else if (a.latest_scorecard) {
                  let avg = '';
                  try {
                    const r = typeof a.latest_scorecard.ratings === 'string' ? JSON.parse(a.latest_scorecard.ratings) : a.latest_scorecard.ratings;
                    const vals = Object.values(r).map(Number).filter(Boolean);
                    if (vals.length) avg = (vals.reduce((x, y) => x + y, 0) / vals.length).toFixed(1) + '/5';
                  } catch {}
                  const isNeg = ['No', 'Strong no'].includes(a.latest_scorecard.recommendation);
                  interviewChip = `<div class="interview-card-chip" style="margin-top:2px;"><span class="badge ${isNeg ? 'rejected' : 'completed'}" style="font-size:0.72rem;">★ ${avg ? avg + ' · ' : ''}${escape(a.latest_scorecard.recommendation)}</span></div>`;
                }
              }

              let trainingBoxHtml = '';
              let trainingStatusBadge = '';
              if (isTraining) {
                const isOverdue = Boolean(a.is_overdue || (a.training_end_at && new Date(a.training_end_at).getTime() < Date.now() && !['completed','offer_revoked'].includes(a.training_status)));
                const tStatus = a.offer_status === 'revoked' ? 'offer_revoked' : (a.training_status || 'not_started');

                let badgeClass = 'training-badge-not-started';
                let badgeLabel = 'Not Started';
                if (a.offer_status === 'revoked') {
                  badgeClass = 'training-badge-revoked';
                  badgeLabel = 'Offer Revoked';
                } else if (tStatus === 'completed') {
                  badgeClass = 'training-badge-completed';
                  badgeLabel = 'Training Passed';
                } else if (tStatus === 'evaluation_failed') {
                  badgeClass = 'training-badge-failed';
                  badgeLabel = 'Evaluation Failed';
                } else if (isOverdue) {
                  badgeClass = 'training-badge-overdue';
                  badgeLabel = '⚠ Overdue';
                } else if (tStatus === 'retraining') {
                  badgeClass = 'training-badge-retraining';
                  badgeLabel = 'Retraining';
                } else if (tStatus === 'extended') {
                  badgeClass = 'training-badge-extended';
                  badgeLabel = 'Extended';
                } else if (tStatus === 'in_progress') {
                  badgeClass = 'training-badge-in-progress';
                  badgeLabel = 'In Progress';
                }

                trainingStatusBadge = `<span class="training-status-badge ${badgeClass}">${badgeLabel}</span>`;

                trainingBoxHtml = `
                  <div class="training-card-box">
                    <div class="training-card-row">
                      <span class="label">Training started:</span>
                      <span class="value">${a.training_start_at ? formatDateIST(a.training_start_at) : '—'}</span>
                    </div>
                    <div class="training-card-row">
                      <span class="label">Training deadline:</span>
                      <span class="value ${isOverdue ? 'training-overdue-highlight' : ''}">${a.training_end_at ? formatDateIST(a.training_end_at) : '—'} ${isOverdue ? '⚠' : ''}</span>
                    </div>
                    <div class="training-card-row">
                      <span class="label">Attempt:</span>
                      <span class="value">#${a.training_attempt || 1}</span>
                    </div>
                    <div class="training-card-row">
                      <span class="label">Offer:</span>
                      <span class="value" style="color:${a.offer_status === 'revoked' ? 'var(--negative,#dc2626)' : 'var(--positive,#16a34a)'};">${a.offer_status === 'revoked' ? 'Revoked' : 'Active'}</span>
                    </div>
                  </div>
                `;
              }

              const curStageIdx = stages.indexOf(stage);
              const nextStage = stages[curStageIdx + 1];
              const prevStage = curStageIdx > 0 ? stages[curStageIdx - 1] : null;

              const skippableTargets = stages.slice(curStageIdx + 2).filter(target => {
                if (['Hired', 'Rejected', 'Revoked'].includes(target)) return false;
                const skipped = stages.slice(curStageIdx + 1, stages.indexOf(target));
                if (skipped.some(s => /(^|\b)(offer|hired)(\b|$)/i.test(s))) return false;
                if (stage === 'Applied' && /pre-onboarding|training/i.test(target)) return false;
                return true;
              });
              const canSkipForward = skippableTargets.length > 0;

              let actionsHtml = allowAction('applications.match','review','recruit') ? button('Skill match','match',a.id,'class="secondary"') : '';
              if (allowAction('applications.update','recruit') && !isTerm) {
                if (prevStage) {
                  actionsHtml += button(`Back to ${prevStage}`,'move',a.id,`data-stage="${escape(prevStage)}" class="secondary"`);
                }
                const canOpenTraining = allows('training.read') || allows('training.manage') || allows('training.lifecycle') || allowAction('applications.evaluate','recruit');
                const canRunTraining = allows('training.lifecycle') || (!grants.length && (allows('recruit') || allows('admin')));
                const canRateTraining = allowAction('applications.evaluate','recruit');
                const canPlanTraining = allows('training.read') || allows('training.manage') || (!grants.length && (allows('recruit') || allows('admin')));
                if (isTraining && canOpenTraining) {
                  actionsHtml += button('Training Details', 'view-training-details', a.id, 'class="secondary" title="View training history, evaluations, and deadline extensions" style="font-size:0.75rem;padding:4px 8px;"');

                  const isRevoked = a.offer_status === 'revoked';
                  const isDone = a.training_status === 'completed';
                  const isFailed = a.training_status === 'evaluation_failed';
                  const notStarted = !a.training_start_at || a.training_status === 'not_started';

                  if (!isRevoked) {
                    if (notStarted) {
                      if (canRunTraining) actionsHtml += button('Start Training', 'start-training', a.id, 'class="primary"');
                    } else if (isFailed) {
                      if (canRunTraining) {
                        actionsHtml += button('Restart Training', 'restart-training', a.id, 'class="primary" title="Start retraining attempt"');
                        actionsHtml += button('Extend Deadline', 'extend-training-deadline', a.id, 'class="secondary"');
                        actionsHtml += button('Revoke Offer', 'training-revoke-offer', a.id, 'class="secondary text-button" style="color:var(--negative);"');
                      }
                    } else if (isDone) {
                      if (nextStage) {
                        actionsHtml += button(`Move to ${nextStage}`, 'move', a.id, `data-stage="${escape(nextStage)}" class="primary"`);
                      }
                    } else {
                      // in_progress, extended, retraining, or overdue
                      if (canRateTraining) actionsHtml += button('Evaluate', 'rate-training', a.id, 'class="primary training-rate-btn"');
                      if (canRunTraining) {
                        actionsHtml += button('Extend Deadline', 'extend-training-deadline', a.id, 'class="secondary"');
                        actionsHtml += button('Revoke Offer', 'training-revoke-offer', a.id, 'class="secondary text-button" style="color:var(--negative);"');
                      }
                    }
                    if (canPlanTraining) actionsHtml += button('Training Plan', 'review-training-plan', a.id, 'class="secondary" style="font-size:0.75rem;padding:4px 8px;"');
                  }
                } else {
                  const hasPendingInv = isInterviewStage && Boolean(a.pending_interview);
                  if (hasPendingInv) {
                    const ready = feedbackReady(a.pending_interview);
                    const canSubmit = a.pending_interview.interviewer_id === me.id;
                    const canProxy = (allowAction('interviews.proxy_evaluate','admin') || allows('system.override')) && !canSubmit;
                    if (canSubmit && ready) {
                      actionsHtml += button('Submit Scorecard', 'scorecard', a.pending_interview.id, 'class="primary" style="font-size:0.75rem;padding:4px 8px;"');
                    } else if (canProxy && ready) {
                      actionsHtml += button('Proxy Scorecard', 'scorecard-proxy', a.pending_interview.id, 'class="secondary" style="font-size:0.75rem;padding:4px 8px;"');
                    } else if (!ready) {
                      actionsHtml += button('Feedback Pending', 'feedback-pending', a.pending_interview.id, 'class="secondary" style="font-size:0.75rem;padding:4px 8px;opacity:0.75;" title="Interview is scheduled. Feedback unlocks after the scheduled interview time."');
                    }
                  }
                  if (nextStage) {
                    actionsHtml += button(`Move to ${nextStage}`, 'move', a.id, `data-stage="${escape(nextStage)}"`);
                  }
                  if (canSkipForward) {
                    actionsHtml += button('Skip to...', 'skip-stage', a.id, 'class="secondary skip-stage-btn" title="Skip intermediate interview or evaluation rounds"');
                  }
                  actionsHtml += button('Reject', 'reject-app', a.id, 'class="secondary"');
                  if (stages.includes('Revoked') && (stage === 'Offer' || /hr round|onboarding/i.test(stage))) {
                    actionsHtml += button('Revoke', 'revoke-app', a.id, 'class="secondary text-button" style="color:var(--negative);font-size:0.74rem;"');
                  }
                }
              } else if (isTraining && !isTerm && (allowAction('applications.evaluate','recruit') || allows('recruit') || allows('admin'))) {
                actionsHtml += button('Rate & Next', 'rate-training', a.id, 'class="primary training-rate-btn"');
              }

              let hrmsChip = '';
              if (stage === 'Hired') {
                if (a.hrms_synced) {
                  const empText = a.hrms_employee_id ? ` (ID: ${escape(String(a.hrms_employee_id).slice(0, 8))}...)` : '';
                  hrmsChip = `<div class="hrms-card-chip" style="margin-top:4px;"><span class="badge completed" style="font-size:0.72rem;background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;" title="Employee provisioning and documents synced to HRMS${a.hrms_employee_id ? ' (' + escape(String(a.hrms_employee_id)) + ')' : ''}">✓ Synced to HRMS${empText}</span></div>`;
                } else if (a.hrms_sync_status?.error) {
                  hrmsChip = `<div class="hrms-card-chip" style="margin-top:4px;"><span class="badge rejected" style="font-size:0.72rem;" title="${escape(a.hrms_sync_status.error)}">⚠ HRMS Sync Failed</span></div>`;
                } else {
                  hrmsChip = `<div class="hrms-card-chip" style="margin-top:4px;"><span class="badge pending" style="font-size:0.72rem;background:#fef3c7;color:#92400e;border:1px solid #fde68a;" title="Handoff to HRMS pending dispatch">⏳ HRMS Sync Pending</span></div>`;
                }
                if (allowAction('applications.hrms_handoff', 'admin', 'recruit') || allows('system.override')) {
                  actionsHtml += button(a.hrms_synced ? 'Re-sync HRMS' : 'Send to HRMS', 'hrms-handoff', a.id, 'class="secondary" style="font-size:0.75rem;padding:4px 8px;"');
                }
              }

              const headerTitle = trainingStatusBadge
                ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin-bottom:2px;"><h3>${escape(a.name)}</h3>${trainingStatusBadge}</div>`
                : `<h3>${escape(a.name)}</h3>`;

              return `<article class="card">${headerTitle}<p class="muted card-role" title="${escape(a.title)}">${escape(a.title)}</p>${evalChip}${planChip}${interviewChip}${hrmsChip}${trainingBoxHtml}<div class="actions">${actionsHtml}</div></article>`;
            }).join('')||'<p class="muted column-empty">No applications</p>'}</div></section>`;
        }).join('')}</div>`+
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
            `<span class="badge" style="background:var(--positive-bg);color:var(--positive);border:1px solid var(--positive);font-weight:600;font-size:0.75rem;padding:3px 9px;">Active Integration</span>`+
          `</div>`
        : `<div class="notice-inline" style="border-left-color:var(--warning);background:var(--warning-bg);color:var(--warning);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">`+
            `<div><strong>Microsoft Teams calendar not configured:</strong> Interview plans are stored locally. Configure Microsoft 365 credentials in Integrations to sync Teams invites.</div>`+
            `${allows('integrations.configure') ? `<button type="button" class="secondary" data-action="navigate" data-view="Integrations" style="font-size:0.8rem;padding:5px 10px;">Configure Integration</button>` : ''}`+
          `</div>`;
      const rows=paged.map(i=>{
        const ready=feedbackReady(i);
        const canSubmit=i.interviewer_id===me.id&&i.status!=='completed';
        const canProxy=allows('interviews.proxy_evaluate')&&i.interviewer_id!==me.id&&i.status!=='completed';
        const showLock=(canSubmit||canProxy)&&!ready;
        const isPhysical = i.interview_type === 'in_person';
        let meetBadge = '';
        if (isPhysical) {
          meetBadge = `<br><span class="badge" style="display:inline-flex;align-items:center;gap:4px;font-size:0.75rem;margin-top:4px;background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;padding:2px 8px;border-radius:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>In-Person • ${escape(i.location || 'Office')}</span>`;
        } else if (i.meeting_url) {
          const u = String(i.meeting_url).toLowerCase();
          const isTeams = u.includes('teams.microsoft.com') || u.includes('teams.live.com');
          const isGoogle = u.includes('meet.google.com');
          const isZoom = u.includes('zoom.us') || u.includes('zoom.com');
          const isWebex = u.includes('webex.com');
          const label = isTeams ? 'Join Teams' : (isGoogle ? 'Join Meet' : (isZoom ? 'Join Zoom' : (isWebex ? 'Join Webex' : 'Join Meeting')));
          meetBadge = `<br><a href="${escape(i.meeting_url)}" target="_blank" rel="noopener noreferrer" class="teams-link" style="display:inline-flex;align-items:center;gap:4px;font-size:0.8rem;margin-top:4px;color:var(--accent,#4f46e5);font-weight:600;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>${label}</a>`;
        } else if (i.calendar_status === 'sync_failed') {
          const errHint = i.meeting_error ? ` title="${escape(i.meeting_error)}"` : '';
          meetBadge = `<br><button type="button" class="badge" style="display:inline-flex;align-items:center;gap:4px;font-size:0.73rem;margin-top:4px;background:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:2px 6px;border-radius:4px;cursor:pointer;" data-action="view-meeting-error" data-id="${escape(i.id)}"${errHint}>Teams sync failed ℹ</button>`;
        }
        if (i.invitation_status === 'failed') {
          const invHint = i.invitation_error ? ` title="${escape(i.invitation_error)}"` : '';
          meetBadge += `<span class="badge" style="display:inline-flex;align-items:center;gap:4px;font-size:0.73rem;margin-top:4px;margin-left:4px;background:#fffbeb;color:#92400e;border:1px solid #fde68a;padding:2px 6px;border-radius:4px;"${invHint}>Invite failed</span>`;
        }
        const canManageInterview = allowAction('interviews.update','recruit') || allows('system.override');
        const retryTeamsBtn = (i.status === 'planned' && !isPhysical && i.calendar_status === 'sync_failed' && canManageInterview)
          ? button('Retry Teams', 'retry-meeting', i.id, 'class="secondary text-button" style="color:var(--accent);font-size:0.74rem;"')
          : '';
        const retryInviteBtn = (i.status === 'planned' && i.invitation_status === 'failed' && canManageInterview)
          ? button('Retry Invite', 'retry-invitation', i.id, 'class="secondary text-button" style="color:var(--accent);font-size:0.74rem;"')
          : '';
        const canEdit = i.status !== 'completed' && (allowAction('interviews.update','recruit') || allows('system.override') || i.interviewer_id === me.id);
        const canCancel = i.status === 'planned' && (allowAction('interviews.cancel','recruit') || allows('system.override') || i.interviewer_id === me.id);
        const canViewFeedback = allowAction('interviews.feedback.read','interview','review','recruit') || allowAction('interviews.evaluate','interview') || allows('system.override');
        return `<tr><td><strong>${escape(i.name)}</strong>${escape(i.title)}</td><td>${escape(i.interviewer)}</td><td>${escape(formatDateTimeIST(i.scheduled_at))}${meetBadge}</td><td>${badge(i.status)}</td><td><div class="actions">${i.candidate_id ? button('Candidate', 'candidate-details', i.candidate_id, 'class="secondary"') : ''}${retryTeamsBtn}${retryInviteBtn}${canSubmit && ready ? button('Submit scorecard', 'scorecard', i.id) : ''}${canProxy && ready ? button('Proxy scorecard', 'scorecard-proxy', i.id, 'class="secondary"') : ''}${canEdit ? button('Edit', 'edit-interview', i.id, 'class="secondary"') : ''}${canCancel ? button('Cancel', 'cancel-interview', i.id, 'class="secondary"') : ''}${canViewFeedback ? button('View feedback', 'feedback', i.id, 'class="secondary"') : ''}${showLock ? `<span class="muted feedback-locked">${FEEDBACK_LOCKED_MESSAGE}</span>` : ''}</div></td></tr>`;
      });
      html=heading('Structured interviews, independent feedback.',allowAction('interviews.schedule','recruit')?button('+ Plan interview','new-interview'):'')+calNotice+`<section class="panel">${table(['Candidate / role','Interviewer','Scheduled (IST)','Status','Feedback'],rows)}${pag}</section>`;
    }
    if(current==='Referrals') {
      const refs=await api('referrals');
      const {paged,page,totalPages,total,start}=paginate(refs,pageState.Referrals||1,10);
      pageState.Referrals=page;
      const pag=renderPagination('Referrals',page,totalPages,total,start,10);
      const canProcess=allowAction('referrals.process','recruit');
      const scopeTitle=canProcess?'Employee referrals within your team scope':'Your referrals';
      const rows=paged.map(r=>{
        const position=r.requisition_title
          ? (r.can_view_requisition?button(r.requisition_title,'req-details',r.requisition_id,`class="text-button referral-position" data-readonly="true" data-referral-id="${escape(r.id)}"`):`<span title="${escape(r.requisition_title)}">${escape(r.requisition_title)}</span>`)
          : (r.requisition_restricted?'<span class="muted">Restricted</span>':'<span class="muted">Not linked</span>');
        const actions=[button('View details','referral-details',r.id,'class="secondary"')];
        if(r.can_edit)actions.push(button('Edit','edit-referral',r.id,'class="secondary"'));
        if(r.can_process)actions.push(button('Process','process-referral',r.id));
        if(r.can_withdraw)actions.push(button('Withdraw','withdraw-referral',r.id,'class="secondary"'));
        return `<tr><td><button type="button" class="text-button person-link" data-action="referral-details" data-id="${escape(r.id)}" title="${escape(r.name)}">${escape(r.name)}</button></td><td>${escape(r.email)}</td><td>${position}</td><td class="referral-status-cell">${badge(r.status)}</td><td>${escape(formatDateIST(r.at))}</td><td>${escape(r.referrer_name||'You')}</td><td><div class="actions">${actions.join('')}</div></td></tr>`;
      });
      html=heading(canProcess?`Review employee referrals for ${escape(me.team||'your organization')}.`:'Recommend a colleague for an open position.',allowAction('referrals.create','refer')?button('+ Make referral','new-referral'):'')+`<section class="panel"><h2>${scopeTitle}</h2>${table(['Candidate','Email','Job Position','Referral Status','Referred','Referrer','Actions'],rows,'referrals-table')}${pag}</section>`;
    }
    if(current==='Offer Templates') {
      const [templates, assets] = await Promise.all([
        api('offer-templates').catch(() => []),
        api('offer-letter-assets').catch(() => [])
      ]);
      const activeCount = templates.filter(t => t.status === 'active').length;
      const draftCount = templates.filter(t => t.status === 'draft').length;
      const defaultTpl = templates.find(t => t.is_default);

      const canManageTemplates=allowAction('offers.templates.manage','recruit');
      const canManageAssets=allowAction('offers.assets.manage','recruit');
      html=heading('Design company-branded templates, manage letterheads, and configure dynamic A4 offer documents.',`<div style="display:flex;gap:8px;">${canManageTemplates?button('+ New Template','new-offer-template'):''}${canManageAssets?button('Upload Letterhead','upload-letterhead','','class="secondary"'):''}</div>`)+
      `<div class="metrics">${[['Total templates',templates.length,'Offer Templates','Configured offer templates'],['Active templates',activeCount,'Requisitions','Available for candidate offers'],['Draft templates',draftCount,'Settings','In design and revision'],['Default template',defaultTpl?defaultTpl.name:'None','Candidates',defaultTpl?`v${defaultTpl.version} (Active)`:'Auto-selected for new offers']].map(([label,count,i,note],n)=>`<div class="metric metric-${n}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(i)}</span></div><strong style="font-size:1.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${count}</strong><small>${note}</small></div>`).join('')}</div>`+
      `<section class="panel"><div class="panel-head"><div><h2>Offer Letter Templates</h2><p class="muted">Reusable templates with multi-page A4 flow, dynamic variables, and salary annexures</p></div></div>${templates.length?table(['Template name','Version','Status','Letterhead','Updated','Actions'],templates.map(t=>{
        const hasBg = t.background_config?.assetId || t.background_config?.firstPageAssetId;
        const bgBadge = hasBg ? `<span class="badge" style="background:#e0f2fe;color:#0369a1;">Stationery</span>` : `<span class="muted" style="font-size:0.75rem;">Standard A4</span>`;
        const defBadge = t.is_default ? ` <span class="badge" style="background:#fef3c7;color:#92400e;margin-left:6px;">Default</span>` : '';
        return `<tr><td><strong>${escape(t.name)}</strong>${defBadge}<br><small class="muted">${escape(t.description||'No description')}</small></td><td style="text-align:center;"><span class="badge mono" style="font-size:0.75rem;">v${t.version}</span></td><td style="text-align:center;">${badge(t.status)}</td><td>${bgBadge}</td><td>${escape(formatDateIST(t.updated_at))}</td><td><div class="plan-actions-group"><button type="button" class="plan-btn-action plan-btn-secondary" data-action="preview-template" data-id="${t.id}" title="Preview template"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Preview</span></button>${canManageTemplates?`<button type="button" class="plan-btn-action plan-btn-primary" data-action="edit-template" data-id="${t.id}" title="Edit template"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><span>Edit</span></button><button type="button" class="plan-btn-icon" data-action="duplicate-template" data-id="${t.id}" title="Duplicate template" aria-label="Duplicate template"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>${!t.is_default?`<button type="button" class="plan-btn-icon" data-action="set-template-default" data-id="${t.id}" title="Set as default template" aria-label="Set as default"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>`:''}${t.status!=='archived'?`<button type="button" class="plan-btn-icon plan-btn-danger" data-action="archive-template" data-id="${t.id}" title="Archive template" aria-label="Archive template"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></button>`:`<button type="button" class="plan-btn-icon plan-btn-success" data-action="activate-template" data-id="${t.id}" title="Activate template" aria-label="Activate template"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></button>`}`:''}</div></td></tr>`;
      }), 'offer-templates-table') : empty('No offer templates created yet. Click "+ New Template" to create your first company offer letter.')}</section>`+
      `<section class="panel"><div class="panel-head"><div><h2>Company Letterhead & Background Stationery</h2><p class="muted">Upload official PNG, JPG, PDF, or DOCX stationery for multi-page branding</p></div>${canManageAssets?button('+ Upload Letterhead','upload-letterhead','','class="secondary"'):''}</div>${assets.length?table(['Asset name','Format','Dimensions','File size','Uploaded','Actions'],assets.map(a=>`<tr><td><strong>${escape(a.name||a.filename)}</strong><br><small class="muted mono">${escape(a.filename)}</small></td><td><span class="badge mono" style="font-size:0.72rem;text-transform:uppercase;">${escape(a.file_format||a.format)}</span></td><td><small class="mono">${a.width&&a.height?`${a.width} × ${a.height} px`:'A4 Document'}</small></td><td><small class="mono">${a.file_size?`${Math.round(a.file_size/1024)} KB`:'—'}</small></td><td>${escape(formatDateIST(a.created_at))}</td><td><div class="plan-actions-group"><a href="/api/offer-letter-assets/${a.id}" target="_blank" class="button secondary plan-btn-action" style="font-size:0.75rem;padding:0 8px;min-height:28px;height:28px;display:inline-flex;align-items:center;">View File</a>${canManageAssets?`<button type="button" class="plan-btn-icon plan-btn-danger" data-action="delete-letterhead-asset" data-id="${a.id}" title="Delete letterhead asset" aria-label="Delete letterhead asset"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>`:''}</div></td></tr>`)):empty('No company letterhead uploaded yet. Click "+ Upload Letterhead" to add company stationery.')}</section>`;
    }
    if(current==='Training Plans') {
      const templates = await api('training-plans/templates').catch(() => []);
      const activeCount = templates.filter(t => t.status === 'active').length;
      const draftCount = templates.filter(t => t.status === 'draft').length;
      const defaultTpl = templates.find(t => t.is_default);

      let filteredTemplates = templates;
      if (window._trainingFilterStatus && window._trainingFilterStatus !== 'all') {
        filteredTemplates = filteredTemplates.filter(t => t.status === window._trainingFilterStatus);
      }
      if (window._trainingSearchTerm) {
        const s = window._trainingSearchTerm.toLowerCase();
        filteredTemplates = filteredTemplates.filter(t =>
          (t.name || '').toLowerCase().includes(s) ||
          (t.description || '').toLowerCase().includes(s) ||
          (t.positions || []).some(p => String(p).toLowerCase().includes(s)) ||
          (t.departments || []).some(d => String(d).toLowerCase().includes(s)) ||
          (t.roles || []).some(r => String(r).toLowerCase().includes(s))
        );
      }

      const canManageTraining=allows('training.manage') || (!grants.length && (allows('recruit') || allows('admin')));
      html = heading('Configure position- and role-specific training plans, learning resources, and candidate preparation workflows.', canManageTraining?button('+ New Training Plan','new-training-template'):'')+
      `<div class="metrics">${[['Total plans',templates.length,'Training Plans','Configured training plans'],['Active plans',activeCount,'Requisitions','Available for candidate training'],['Draft plans',draftCount,'Settings','In design and revision'],['Default plan',defaultTpl?defaultTpl.name:'None','Candidates',defaultTpl?`v${defaultTpl.version} (Active)`:'Auto-selected fallback']].map(([label,count,i,note],n)=>`<div class="metric metric-${n}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(i)}</span></div><strong style="font-size:1.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${count}</strong><small>${note}</small></div>`).join('')}</div>`+
      `<section class="panel">`+
        `<div class="training-toolbar">`+
          `<div class="training-toolbar-title">`+
            `<h2>Pre-Onboarding Training Plans</h2>`+
            `<p class="muted">Position-mapped onboarding curricula, external learning resources, and candidate emails</p>`+
          `</div>`+
          `<div class="training-toolbar-actions">`+
            `<div class="training-search-wrap">`+
              `<svg class="training-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`+
              `<input type="search" id="training-search-input" value="${escape(window._trainingSearchTerm||'')}" placeholder="Search plans or positions..." aria-label="Search training plans">`+
            `</div>`+
            `<select id="training-status-filter" class="training-filter-select" aria-label="Filter plans by status">`+
              `<option value="all" ${!window._trainingFilterStatus||window._trainingFilterStatus==='all'?'selected':''}>All statuses</option>`+
              `<option value="active" ${window._trainingFilterStatus==='active'?'selected':''}>Active only</option>`+
              `<option value="draft" ${window._trainingFilterStatus==='draft'?'selected':''}>Drafts only</option>`+
              `<option value="archived" ${window._trainingFilterStatus==='archived'?'selected':''}>Archived only</option>`+
            `</select>`+
            (canManageTraining ? `<button type="button" class="training-btn-new" data-action="new-training-template">`+
              `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`+
              `<span>New Plan</span>`+
            `</button>` : '')+
          `</div>`+
        `</div>`+
        (templates.length ? (
          table(
            ['Plan name', 'Mapped Positions', 'Departments & Roles', 'Duration', 'Version', 'Status', 'Updated', 'Actions'],
            templates.map(t => {
              const defBadge = t.is_default
                ? `<span class="plan-default-badge" title="Default fallback plan for all candidates"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Default</span>`
                : '';

              const getVisibleChipCount = (items) => {
                if (!items || !items.length) return 0;
                if (items.length === 1) return 1;
                if (items.length === 2 && (items[0].length + items[1].length <= 14)) return 2;
                return 1;
              };

              const positions = Array.isArray(t.positions) ? t.positions : [];
              const maxPosVisible = getVisibleChipCount(positions);
              const posChips = positions.length
                ? `<div class="chips-cloud">` +
                    positions.slice(0, maxPosVisible).map(p => `<span class="plan-chip plan-chip-pos" title="${escape(p)}">${escape(p)}</span>`).join('') +
                    (positions.length > maxPosVisible
                      ? `<div class="plan-chip-more-container" tabindex="0" role="button" aria-label="All ${positions.length} mapped positions">` +
                          `<span class="plan-chip plan-chip-more">+${positions.length - maxPosVisible} more</span>` +
                          `<div class="plan-chips-popover" role="tooltip">` +
                            `<div class="plan-chips-popover-header"><span>All Mapped Positions (${positions.length})</span></div>` +
                            `<div class="plan-chips-popover-list">` +
                              positions.map(p => `<span class="plan-chip plan-chip-pos" title="${escape(p)}">${escape(p)}</span>`).join('') +
                            `</div>` +
                          `</div>` +
                        `</div>`
                      : '') +
                  `</div>`
                : `<span class="plan-chip-scope"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg> All / General</span>`;

              const deptRoles = [...(t.departments || []), ...(t.roles || [])];
              const maxDeptVisible = getVisibleChipCount(deptRoles);
              const deptChips = deptRoles.length
                ? `<div class="chips-cloud">` +
                    deptRoles.slice(0, maxDeptVisible).map(d => `<span class="plan-chip plan-chip-dept" title="${escape(d)}">${escape(d)}</span>`).join('') +
                    (deptRoles.length > maxDeptVisible
                      ? `<div class="plan-chip-more-container" tabindex="0" role="button" aria-label="All ${deptRoles.length} departments and roles">` +
                          `<span class="plan-chip plan-chip-more">+${deptRoles.length - maxDeptVisible} more</span>` +
                          `<div class="plan-chips-popover" role="tooltip">` +
                            `<div class="plan-chips-popover-header"><span>All Departments & Roles (${deptRoles.length})</span></div>` +
                            `<div class="plan-chips-popover-list">` +
                              deptRoles.map(d => `<span class="plan-chip plan-chip-dept" title="${escape(d)}">${escape(d)}</span>`).join('') +
                            `</div>` +
                          `</div>` +
                        `</div>`
                      : '') +
                  `</div>`
                : `<span class="plan-chip-scope muted">All Depts</span>`;

              const isMatch = filteredTemplates.some(f => f.id === t.id);
              const hideRowAttr = !isMatch ? 'style="display:none;"' : '';
              const searchBlob = `${t.name || ''} ${t.description || ''} ${(t.positions || []).join(' ')} ${(t.departments || []).join(' ')} ${(t.roles || []).join(' ')}`.toLowerCase();

              return `<tr class="training-plan-row" data-id="${t.id}" data-name="${escape(t.name||'')}" data-desc="${escape(t.description||'')}" data-positions="${escape((t.positions||[]).join(','))}" data-departments="${escape((t.departments||[]).join(','))}" data-status="${escape(t.status||'')}" data-search="${escape(searchBlob)}" ${hideRowAttr}>` +
                `<td>` +
                  `<div class="plan-name-cell">` +
                    `<div class="plan-title-row">` +
                      `<strong class="plan-title-text" title="${escape(t.name)}">${escape(t.name)}</strong>` +
                      `${defBadge}` +
                    `</div>` +
                    `<p class="plan-desc-text" title="${escape(t.description || 'No description')}">${escape(t.description || 'No description provided')}</p>` +
                  `</div>` +
                `</td>` +
                `<td>${posChips}</td>` +
                `<td>${deptChips}</td>` +
                `<td>` +
                  `<div class="plan-duration-cell">` +
                    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="duration-icon"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>` +
                    `<span>${escape(t.duration_text || 'Flexible')}</span>` +
                  `</div>` +
                `</td>` +
                `<td style="text-align:center;">` +
                  `<span class="plan-version-badge">v${t.version}</span>` +
                `</td>` +
                `<td style="text-align:center;">` +
                  `<span class="plan-status-pill status-${t.status}">` +
                    `<span class="status-dot"></span>` +
                    `<span>${escape(t.status ? (t.status.charAt(0).toUpperCase() + t.status.slice(1)) : 'Active')}</span>` +
                  `</span>` +
                `</td>` +
                `<td>` +
                  `<div class="plan-date-cell">${escape(formatDateIST(t.updated_at))}</div>` +
                `</td>` +
                `<td>` +
                  `<div class="plan-actions-group">` +
                    (canManageTraining ? `<button type="button" class="plan-btn-action plan-btn-primary" data-action="edit-training-template" data-id="${t.id}" title="Edit plan modules and syllabus">` +
                      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>` +
                      `<span>Edit</span>` +
                    `</button>` : '') +
                    `<button type="button" class="plan-btn-action plan-btn-secondary" data-action="preview-training-template" data-id="${t.id}" title="Preview syllabus & resource portal">` +
                      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>` +
                      `<span>Preview</span>` +
                    `</button>` +
                    (canManageTraining ? `<button type="button" class="plan-btn-icon" data-action="duplicate-training-template" data-id="${t.id}" title="Duplicate this training plan" aria-label="Duplicate plan">` +
                      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
                    `</button>` +
                    `${!t.is_default ? `
                      <button type="button" class="plan-btn-icon" data-action="set-training-default" data-id="${t.id}" title="Set as default fallback plan" aria-label="Set as default">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                      </button>
                    ` : ''}` +
                    `${t.status !== 'archived' ? `
                      <button type="button" class="plan-btn-icon plan-btn-danger" data-action="archive-training-template" data-id="${t.id}" title="Archive plan" aria-label="Archive plan">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                      </button>
                    ` : `
                      <button type="button" class="plan-btn-icon plan-btn-success" data-action="activate-training-template" data-id="${t.id}" title="Reactivate plan" aria-label="Reactivate plan">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                      </button>
                    `}` : '') +
                  `</div>` +
                `</td>` +
              `</tr>`;
            }),
            'training-plans-table'
          ) + `<div id="training-filter-empty" class="empty" style="display:${filteredTemplates.length===0?'block':'none'};">No training plans match your filter.</div>`
        ) : empty('No training plans created yet. Click "+ New Training Plan" to create one.')) +
      `</section>`;
    }
    if(current==='Administration') {
      const canUsers=allows('users.read'), canCreateUsers=allows('users.create');
      const canRoles=allows('roles.read'), canCreateRoles=allows('roles.create');
      let users=[], roles=[], summary=null;
      if(canUsers) users=await api('admin/users');
      if(canRoles) roles=await api('admin/roles');
      if(canUsers||canRoles){ try{summary=await api('admin/access');}catch{} }
      window.currentUsers=users; window.currentRoles=roles; window.currentAccessSummary=summary;
      if(!canUsers && adminTab==='users') adminTab='roles';
      if(!canRoles && adminTab!=='users') adminTab='users';
      if(adminTab!=='users' && adminTab!=='roles') adminTab=canRoles?'roles':'users';
      const availableTabs=[...(canUsers?[['users','Users']]:[]),...(canRoles?[['roles','Roles & permissions']]:[])];
      const tabBar=availableTabs.length>1?`<div role="tablist" aria-label="Access management" style="display:flex;gap:6px;flex-wrap:wrap;margin:0 0 18px;">${availableTabs.map(([id,label])=>`<button type="button" role="tab" aria-selected="${adminTab===id}" data-action="admin-tab" data-id="${id}" class="${adminTab===id?'':'secondary'}" style="min-height:36px;">${escape(label)}</button>`).join('')}</div>`:'';
      const metrics=[['Active roles',summary?.active_roles??roles.length,'roles'],['Custom roles',summary?.custom_roles??roles.filter(r=>!r.is_system).length,'roles'],['User assignments',summary?.assignments??users.filter(u=>u.status==='active').length,'users'],['Elevated roles',summary?.elevated_roles??roles.filter(r=>(r.permissions||[]).some(p=>me?.permissionRegistry?.find(x=>x.id===p)?.sensitive)).length,'roles'],['Unassigned users',summary?.unassigned_users??0,'users']];
      const metricsHtml=`<div class="metrics">${metrics.map(([label,count,target],n)=>`<div class="metric metric-${n}"><div class="metric-top"><span>${escape(label)}</span><span class="metric-icon">${icon(target==='roles'?'Administration':'Candidates')}</span></div><strong>${Number(count)||0}</strong><small>${target==='roles'?'Persisted role definitions':'Accounts with access'}</small></div>`).join('')}</div>`;
      let body='';
      if(adminTab==='users') {
        const pending=users.filter(u=>u.status==='pending');
        const directory=users.filter(u=>u.status!=='pending');
        const canApprove=allows('users.update'), canReject=allows('users.deactivate');
        const pendingRows=pending.map(u=>`<tr><td><strong>${escape(u.name)}</strong><small>${escape(u.email)}</small></td><td class="mono">${escape(u.oid||'')}</td><td>${escape(formatDateTimeIST(u.created_at))}</td><td><div class="actions">${canApprove?button('Approve','approve-access',u.id):''}${canReject?button('Reject','reject-access',u.id,'class="secondary"'):''}</div></td></tr>`);
        const pendingPanel=`<section class="panel" id="pending-access"><div class="panel-head"><div><h2>Pending access requests</h2><p class="muted">People who signed in with Microsoft 365 and are waiting for an administrator decision. Approving or rejecting is saved immediately and cannot be repeated.</p></div><span class="badge">${pending.length}</span></div>${pending.length?table(['Person','Entra object','Requested (IST)','Decision'],pendingRows):'<p class="muted">No pending access requests.</p>'}</section>`;
        const {paged,page,totalPages,total,start}=paginate(directory,pageState.Administration||1,10);
        pageState.Administration=page;
        const pag=renderPagination('Administration',page,totalPages,total,start,10);
        const recent=summary?.recent_changes||[];
        body=pendingPanel+`<section class="panel">${table(['User','Role / team','Access','Permissions','Last sign-in (IST)','Manage'],paged.map(u=>`<tr><td><strong>${escape(u.name)}</strong><small>${escape(u.email)}</small></td><td>${escape(u.role||'Unassigned')}<br><small>${escape(u.team||'Organization')}</small></td><td>${badge(u.status)}</td><td>${Number(u.effective_permissions)||0}</td><td>${u.last_login?escape(formatDateTimeIST(u.last_login)):'Never'}</td><td>${button('Manage','manage-user',u.id,'class="secondary"')}</td></tr>`))}${pag}</section>`+
          (recent.length?`<section class="panel role-history"><div class="panel-head"><div><h2>Recent access changes</h2><p class="muted">Role and user-access events recorded in the audit trail.</p></div>${button('Open audit log','navigate','','class="secondary" data-view="Audit log"')}</div>${table(['Time (IST)','Event','Actor','Target'],recent.slice(0,6).map(e=>`<tr><td>${escape(formatDateTimeIST(e.at))}</td><td>${escape(e.event)}</td><td class="mono">${escape(e.actor)}</td><td class="mono">${escape(e.target)}</td></tr>`))}</section>`:'');
      } else if(adminTab==='roles') {
        const rows=roles.map(role=>{
          const editable=canEditRolePermissions(role);
          const acts=[button(editable?(role.is_system?'Edit permissions':'Edit'):'View',editable?'edit-role':'view-role',role.id,'class="secondary"')];
          if(canCreateRoles) acts.push(button('Duplicate','duplicate-role',role.id,'class="secondary"'));
          if(!role.is_system && allows('roles.delete') && !role.assigned_users) acts.push(button('Archive','archive-role',role.id,'class="secondary"'));
          const type=role.is_system?`<span class="badge">System${role.permissions_customized?' &middot; customized':''}</span>`:'<span class="badge">Custom</span>';
          return `<tr data-role-name="${escape((role.name+' '+role.description).toLowerCase())}"><td><strong>${escape(role.name)}</strong><small>${escape(role.description||'No description')}</small></td><td>${type}</td><td>${escape(role.scope)}</td><td>${role.assigned_users}</td><td>${role.permission_count}</td><td>${escape(formatDateIST(role.updated_at))}</td><td><div class="actions">${acts.join('')}</div></td></tr>`;
        });
        body=`<section class="panel"><div class="panel-head"><div><h2>Roles and permissions</h2><p class="muted">System role identities and scopes are protected; their permissions can be customized. Custom roles are fully editable.</p></div><input id="role-search" type="search" placeholder="Search roles" aria-label="Search roles" style="max-width:240px;"></div>${table(['Role','Type','Scope','Users','Permissions','Updated','Actions'],rows)}</section>`;
      }
      html=heading('Manage users, roles, scopes and effective access from one controlled workspace.',`<div style="display:flex;gap:8px;flex-wrap:wrap;">${canCreateUsers?button('+ Add user','new-user'):''}${canCreateRoles?button('+ New role','new-role','','class="secondary"'):''}</div>`)+metricsHtml+tabBar+body;
    }
    if(current==='Audit log') {
      const params=new URLSearchParams();
      Object.entries(auditFilters).forEach(([key,value])=>{if(value)params.set(key,value);});
      const events=await api('admin/audit'+(params.toString()?`?${params.toString()}`:''));
      const {paged,page,totalPages,total,start}=paginate(events,pageState['Audit log']||1,20);
      pageState['Audit log']=page;
      const pag=renderPagination('Audit log',page,totalPages,total,start,20);
      const filters=`<section class="panel"><div id="audit-filter-form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:end;"><label>Event contains<input id="audit-event" name="event" value="${escape(auditFilters.event)}" placeholder="role.updated"></label><label>Search<input id="audit-q" name="q" value="${escape(auditFilters.q)}" placeholder="Actor, target, detail"></label><label>From (ISO)<input id="audit-from" name="from" value="${escape(auditFilters.from)}" placeholder="2026-01-01"></label><label>To (ISO)<input id="audit-to" name="to" value="${escape(auditFilters.to)}" placeholder="2026-12-31"></label><div style="grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;"><button type="button" data-action="audit-filter">Apply filters</button><button type="button" class="secondary" data-action="audit-clear">Clear</button></div></div></section>`;
      const rows=paged.map(e=>`<tr><td>${escape(formatDateTimeIST(e.at))}</td><td><strong>${escape(e.event)}</strong></td><td class="mono">${escape(e.actor)}</td><td class="mono">${escape(e.target)}</td><td>${Object.keys(e.detail||{}).length?`<details><summary>View detail</summary><pre class="audit-detail">${escape(JSON.stringify(e.detail,null,2))}</pre></details>`:'&mdash;'}</td></tr>`);
      html=heading('Administrative actions, authentication and hiring changes.')+filters+`<section class="panel"><p class="muted">Filtered audit results, newest first. Access changes and authorization denials are recorded here.</p>${table(['Time (IST)','Event','Actor','Target','Detail'],rows)}${pag}</section>`;
    }
    if(current==='Settings') {
      const canSaveTheme=allows('settings.update');
      html=heading('Make Orbit feel like your team’s workspace.')+`<section class="panel appearance-panel"><div class="panel-head"><div><h2>Appearance</h2><p class="muted">Choose a look that helps your team do their best work.</p></div><span class="subtle-label">${icon('Administration')} Admin controlled</span></div><form id="appearance-form"><fieldset class="theme-fieldset" ${canSaveTheme?'':'disabled'}><legend>Workspace theme</legend><div class="theme-grid">${appearance.themes.map(t=>`<label class="theme-option"><input type="radio" name="theme" value="${t.id}" ${t.id===appearance.theme?'checked':''} ${canSaveTheme?'':'disabled'}><span class="theme-thumbnail theme-${t.id}"><span class="mini-sidebar"><i></i><i></i><i></i></span><span class="mini-workspace"><span class="mini-topline"></span><span class="mini-metrics"><i></i><i></i><i></i></span><span class="mini-panel"><i></i><i></i><i></i></span></span><span class="theme-check" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span></span><span class="theme-name">${t.name}</span><span class="theme-description">${t.description}</span></label>`).join('')}</div></fieldset><div class="theme-scope">${icon('Candidates')}<div><strong>One look, for the whole team</strong><p>The saved theme applies to every user and the sign-in screen. Existing sessions pick it up on their next page change or refresh.</p></div></div><p id="appearance-status" role="status" aria-live="polite" class="muted">${escape(appearance.themes.find(t=>t.id===appearance.theme).name)} is your saved workspace theme.</p><div class="settings-actions">${canSaveTheme?`<button type="button" class="secondary" data-action="reset-theme">Reset preview</button><button type="submit" id="save-theme" disabled>Save workspace theme</button>`:'<p class="muted">You can view the workspace theme. Saving it requires settings update permission.</p>'}</div></form></section><section class="panel brand-panel"><div><p class="eyebrow">OUR WORKSPACE</p><h2>Orbit, by Mechlin</h2><p class="muted">A place for people, possibility and your next great hire.</p></div><div class="brand-lockup"><img src="/mechlin-logo.webp" alt="Mechlin Technologies" width="174" height="40"></div></section>`;
    }
    if(current==='Pipeline settings') {
      const stages=await api('pipeline');
      const isTerminal = s => ['Hired', 'Rejected', 'Revoked'].includes(s);
      const activeStages = stages.filter(s => !isTerminal(s));
      const metrics = [
        ['Active Progression', `${activeStages.length} Stages`, 'Pipeline', 'Sequential & flexible applicant advancement'],
        ['Terminal Outcomes', `${stages.filter(isTerminal).length} Outcomes`, 'Candidates', 'Hired (Success), Rejected, Revoked'],
        ['Entry Stage', escape(stages[0] || 'Applied'), 'Overview', 'Mandatory starting point'],
        ['Governance', 'Enforced', 'Administration', 'Sequential moves & headcount limits']
      ];

      html=heading('Define the sequence your hiring teams follow.')+
      `<div class="metrics">${metrics.map(([label,count,i,note],n)=>`<div class="metric metric-${n}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(i)}</span></div><strong>${count}</strong><small>${note}</small></div>`).join('')}</div>`+
      `<section class="panel pipeline-flow-panel">`+
        `<div class="panel-head">`+
          `<div><h2>Hiring Workflow Architecture</h2><p class="muted">Applicants advance through sequential active stages and conclude at terminal outcomes.</p></div>`+
          `<div class="actions">`+
            `${button('Customize stages','edit-pipeline')}`+
          `</div>`+
        `</div>`+
        `<div class="pipeline-diagram-wrapper">`+
          `<div class="pipeline-track active-track">`+
            `<div class="track-header"><span class="track-badge">In-Progress Sequential Funnel</span><span class="track-hint">Candidates progress forward through interview rounds, HR evaluation, pre-onboarding training, and onboarding</span></div>`+
            `<div class="pipeline-flow-steps">`+
              activeStages.map((s, idx) =>
                `<div class="pipeline-step-card"><div class="step-num-pill">${idx + 1}</div><div class="step-card-body"><span class="step-card-name">${escape(s)}</span><span class="step-card-sub">${idx === 0 ? 'Initial intake' : (/training/i.test(s) ? 'Rating & evaluation' : (/onboarding/i.test(s) ? 'Pre-hire onboarding' : idx === activeStages.length - 1 ? 'Final evaluation / offer' : 'Interview & evaluation'))}</span></div></div>` +
                (idx < activeStages.length - 1 ? `<div class="flow-connector" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></div>` : '')
              ).join('')+
            `</div>`+
          `</div>`+
          `<div class="pipeline-fork-bridge">`+
            `<div class="fork-label-pill"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg> Terminal Resolution Branches</div>`+
            `<div class="fork-split-arrows" aria-hidden="true"><span>↙ Successful Hire</span><span>·</span><span>Concluded / Revoked ↘</span></div>`+
          `</div>`+
          `<div class="pipeline-outcomes-container">`+
            `<div class="terminal-outcome-card outcome-hired">`+
              `<div class="outcome-header">`+
                `<div class="outcome-icon-wrap success-wrap"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg></div>`+
                `<div><span class="outcome-type success-text">Positive Terminal Outcome</span><h3 class="outcome-title">Hired</h3></div>`+
                `<span class="badge" style="background:#e3f3ed;color:#24614d;font-weight:600;margin-left:auto;">Success</span>`+
              `</div>`+
              `<p class="outcome-desc">Candidate successfully accepts offer. Approved headcount is filled and onboarding completes. Candidates do not move beyond this stage.</p>`+
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
            (stages.includes('Revoked') ? `
              <div class="terminal-outcome-card outcome-rejected" style="border-top:3px solid #b91c1c;">
                <div class="outcome-header">
                  <div class="outcome-icon-wrap rejected-wrap" style="background:#fee2e2;color:#991b1b;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg></div>
                  <div><span class="outcome-type" style="color:#991b1b;">Concluded / Rescinded Outcome</span><h3 class="outcome-title">Revoked</h3></div>
                  <span class="badge" style="background:#fee2e2;color:#991b1b;font-weight:600;margin-left:auto;">Revoked</span>
                </div>
                <p class="outcome-desc">Offer or candidacy is formally revoked following failed pre-onboarding training, verification discrepancy, or candidate reneging.</p>
                <div class="outcome-badge-meta"><span class="outcome-rule-chip">● Terminal closed state</span><span class="outcome-rule-chip">● Audit logged</span></div>
              </div>
            ` : '')+
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
      if(!allows('integrations.read') && !allows('integrations.configure') && !allows('integrations.secrets.manage')) {
        html=heading('Access Restricted')+`<div class="empty">Integration access is required to view and manage integrations.</div>`;
      } else {
        const integrations = await api('admin/integrations');
        const activeCount = integrations.filter(i => i.enabled && (i.status === 'connected' || i.status === 'configured')).length;
        const externalCount = integrations.filter(i => i.isExternal).length;
        const inHouseCount = integrations.filter(i => !i.isExternal).length;

        const metrics = [
          ['Supported Integrations', integrations.length, 'Total manageable system adapters'],
          ['Active & Ready', activeCount, 'Operational provider interfaces'],
          ['External Cloud APIs', externalCount, 'Microsoft, Resend, AI & HRMS'],
          ['In-House Engines', inHouseCount, 'Signatures, Fraud, Agency & Scanner']
        ];

        html = heading('Manage external API credentials, connection health, and enterprise adapters.') +
          `<div class="metrics int-metrics">${metrics.map(([label, count, note], n) => `<div class="metric metric-${n}"><div class="metric-top"><span>${label}</span></div><strong>${count}</strong><small>${note}</small></div>`).join('')}</div>` +
          `<section class="panel integrations-container">` +
            `<div class="panel-head" style="margin-bottom:12px;">` +
              `<div><h2>System Integrations Registry</h2><p class="muted">Manage credentials securely with AES-256-GCM encryption, run non-destructive tests, and configure fallbacks.</p></div>` +
              `<div class="actions">` +
                `<button type="button" class="secondary" data-action="refresh-integrations">Refresh Status</button>` +
              `</div>` +
            `</div>` +
            `<div class="int-header-toolbar">` +
              `<div class="int-search-wrap">` +
                `<svg class="int-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>` +
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
                let badgeClass = 'pending';
                let statusLabel = 'Setup Required';
                if (item.status === 'connected') {
                  badgeClass = 'completed';
                  statusLabel = 'Connected';
                } else if (item.status === 'configured') {
                  badgeClass = 'active';
                  statusLabel = 'Configured';
                } else if (item.status === 'disabled') {
                  badgeClass = 'disabled';
                  statusLabel = 'Deactivated';
                } else if (item.status === 'failed') {
                  badgeClass = 'rejected';
                  statusLabel = 'Needs Attention';
                }

                const archBadge = item.isExternal
                  ? `<span class="int-type-tag int-type-cloud">Cloud API</span>`
                  : `<span class="int-type-tag int-type-inhouse">In-House</span>`;

                const testInfo = item.lastTestAt
                  ? (item.lastTestStatus === 'success'
                      ? `<span class="int-diag-chip diag-ok" title="Last verified: ${escape(formatDateTimeIST(item.lastTestAt))}">Verified active</span>`
                      : `<span class="int-diag-chip diag-warn" title="${escape(item.lastError || 'Test failed')}">Connection check needed</span>`)
                  : `<span class="int-diag-chip diag-ready">Ready for test</span>`;

                const featureTags = getIntegrationFeatureTags(item);

                return `<div class="integration-card" data-integration-id="${escape(item.id)}" data-category="${escape(item.category)}" data-external="${item.isExternal ? '1' : '0'}" data-status="${escape(item.status)}">` +
                  `<div class="int-card-head">` +
                    `<div class="int-head-meta">` +
                      `<div class="int-meta-sub">` +
                        `<span class="int-category-text">${escape(item.category)}</span>` +
                        `<span class="int-dot-sep">·</span>` +
                        `${archBadge}` +
                      `</div>` +
                      `<h3 class="int-name">${escape(item.name)}</h3>` +
                    `</div>` +
                    `<span class="badge ${badgeClass}">${statusLabel}</span>` +
                  `</div>` +
                  `<p class="int-desc">${escape(item.description)}</p>` +
                  `<div class="int-feature-tags">${featureTags.map(t => `<span class="int-feature-tag">${escape(t)}</span>`).join('')}</div>` +
                  `<div class="int-health-row">${testInfo}<span class="int-enc-badge" title="AES-256-GCM encrypted">AES-256 Encrypted</span></div>` +
                  `<div class="int-card-actions">` +
                    (allows('integrations.configure')
                      ? `<button type="button" class="button" data-action="configure-integration" data-id="${escape(item.id)}">Configure</button>` +
                        `<button type="button" class="button secondary" data-action="test-integration" data-id="${escape(item.id)}" title="Run safe, non-destructive connection test">Test Connection</button>` +
                        `<button type="button" class="button secondary int-toggle-btn" data-action="toggle-integration" data-id="${escape(item.id)}" data-enabled="${item.enabled ? '0' : '1'}">${item.enabled ? 'Deactivate' : 'Activate'}</button>`
                      : `<span class="muted" style="font-size:0.8rem;">Read-only access</span>`) +
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
      html=heading('Manage external recruitment agencies and partner access.',allows('agencies.create')?button('+ Register agency','new-agency'):'')+
      `<div class="metrics">${[
        ['Registered agencies', agencies.length, 'Agencies', 'External recruitment partners'],
        ['Active agencies', agencies.filter(a=>a.status==='active').length, 'Agencies', 'Operational partner portals'],
        ['Assigned requisitions', agencies.reduce((acc,a)=>acc+Number(a.assigned_requisitions_count||0),0), 'Requisitions', 'Total open job assignments'],
        ['Agency submissions', agencies.reduce((acc,a)=>acc+Number(a.submissions_count||0),0), 'Candidates', 'Total candidates received']
      ].map(([label,count,i,note],n)=>`<div class="metric metric-${n}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(i)}</span></div><strong>${count}</strong><small>${note}</small></div>`).join('')}</div>`+
      `<section class="panel"><div class="panel-head"><div><h2>External recruitment agencies</h2><p class="muted">Authorized partners with isolated portal access.</p></div></div>`+
      `${table(['Agency / Code','Primary contact','Recruiters','Assigned jobs','Submissions','Status','Actions'],paged.map(a=>`<tr><td><strong>${escape(a.name)}</strong><br><small class="mono">${escape(a.code)}</small></td><td>${escape(a.contact_name||'—')}<br><small>${escape(a.contact_email||'')}${a.contact_phone?` · ${escape(a.contact_phone)}`:''}</small></td><td><strong>${a.active_recruiters_count||0}</strong> <small class="muted">active</small></td><td><strong>${a.assigned_requisitions_count||0}</strong></td><td><strong>${a.submissions_count||0}</strong></td><td>${badge(a.status)}</td><td><div class="actions">${button('Manage','manage-agency',a.id,'class="secondary"')}${allows('agencies.assign')?button('Assign role','agency-assign-job',a.id,'class="secondary"'):''}</div></td></tr>`))}`+
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
        `${table(['Position','Team','Deadline','Action'],assigned.slice(0,5).map(r=>`<tr><td><strong>${escape(r.title)}</strong><br><small>${escape((r.skills||[]).join(', '))}</small></td><td>${escape(r.team)}</td><td>${r.submission_deadline?escape(formatDateIST(r.submission_deadline)):'Open'}</td><td><div class="actions">${button('Add candidate','agency-submit-candidate',r.id,'class="primary"')}</div></td></tr>`))}`+
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
      `${table(['Position','Team / Location','Skills & requirements','Deadline','Sourcing instructions','Add candidate'],paged.map(r=>`<tr><td><strong>${escape(r.title)}</strong><br><small class="mono">${escape(r.team)}</small></td><td>${escape(r.team)}<br><small class="muted">Full-time</small></td><td><div class="skill-list">${(r.skills||[]).map(s=>`<span class="skill-chip">${escape(s)}</span>`).join('')}</div></td><td>${r.submission_deadline?`<span class="badge ${new Date(r.submission_deadline)<new Date()?'rejected':'pending'}">${escape(formatDateIST(r.submission_deadline))}</span>`:'<span class="badge active">Open</span>'}</td><td style="max-width:240px;"><small class="muted">${escape(r.sourcing_instructions||'Standard requirements apply.')}</small></td><td><div class="actions">${button('Add candidate','agency-submit-candidate',r.id,'class="primary"')}</div></td></tr>`))}`+
      `${pag}</section>`;
    }
    if(current==='Submissions') {
      const subs = await api('agency/submissions');
      const {paged,page,totalPages,total,start}=paginate(subs,pageState.Submissions||1,10);
      pageState.Submissions=page;
      const pag=renderPagination('Submissions',page,totalPages,total,start,10);
      html=heading('Candidate submissions and live status tracking.',button('+ Submit candidate','agency-submit-candidate'))+
      `<section class="panel"><div class="panel-head"><div><h2>Your agency submissions</h2><p class="muted">Live status synchronized directly with Orbit internal pipeline stages.</p></div></div>`+
      `${table(['Reference','Candidate','Requisition','Submitted by','Date','Status','Feedback'],paged.map(s=>`<tr><td class="mono"><strong>${escape(s.submission_ref||s.reference)}</strong></td><td><strong>${escape(s.candidate_name)}</strong><br><small>${escape(s.candidate_email)}</small></td><td>${escape(s.requisition_title)}</td><td>${escape(s.recruiter_name||'Agency')}</td><td>${escape(formatDateIST(s.created_at||s.submitted_at||Date.now()))}</td><td>${badge(s.agency_status||s.status||'Submitted')}</td><td>${(s.published_feedback||s.feedback)?button('View feedback','view-agency-feedback',s.id,'class="secondary"'):'<span class="muted" style="font-size:0.85rem;">Under evaluation</span>'}</td></tr>`))}`+
      `${pag}</section>`;
    }
    if(current==='Agency Team') {
      const members = await api('agency/members');
      const {paged,page,totalPages,total,start}=paginate(members,pageState['Agency Team']||1,10);
      pageState['Agency Team']=page;
      const pag=renderPagination('Agency Team',page,totalPages,total,start,10);
      html=heading('Manage recruiters and partner access for your agency.',isAgencyAdmin()?button('+ Add recruiter','new-agency-recruiter'):'')+
      `<section class="panel"><div class="panel-head"><div><h2>Agency recruiters & administrators</h2><p class="muted">Recruiters can view assigned jobs and submit candidates on behalf of your agency.</p></div></div>`+
      `${table(['Member','Role','Status','Joined','Actions'],paged.map(m=>`<tr><td><strong>${escape(m.name)}</strong><br><small>${escape(m.email)}</small></td><td><span class="badge ${m.role==='Agency Admin'?'completed':'clean'}">${escape(m.role)}</span></td><td>${badge(m.status)}</td><td>${escape(formatDateIST(m.created_at))}</td><td><div class="actions">${isAgencyAdmin()&&m.user_id!==me.id?button(m.status==='active'?'Suspend':'Reactivate','toggle-agency-recruiter-status',m.user_id,`data-status="${m.status==='active'?'suspended':'active'}" class="secondary"`):'<span class="muted">—</span>'}</div></td></tr>`))}`+
      `${pag}</section>`;
    }
    if(version===renderVersion && me){
      const prevBoardLeft = (current === 'Pipeline' && $('#pipeline-board')) ? $('#pipeline-board').scrollLeft : 0;
      $('#main').innerHTML=html;
      document.title=`${current} · Orbit by Mechlin`;
      syncNavState();
      const navEl = document.querySelector('.sidebar nav');
      if (navEl) {
        const activeBtn = navEl.querySelector('button.active');
        if (activeBtn) scrollNavIntoView(navEl, activeBtn);
        saveNavScroll(navEl);
      }
      if(current === 'Pipeline') syncPipelineScroll(prevBoardLeft);
      if(current === 'Integrations') bindIntegrationsFilter();
      if(current === 'Training Plans') bindTrainingPlansFilter();
    }
  }catch(e){if(me)$('#main').innerHTML=`<section class="panel"><h1>Could not load this view</h1><p class="error">${escape(e.message)}</p>${button('Try again','refresh')}</section>`;}
}
function reqTable(reqs) {return table(['Position','Team','Headcount','Status','Actions'],reqs.map(r=>{
  const canReviewManager = r.status==='pending_manager' && allowAction('requisitions.approve_manager','approve_manager');
  const canReviewFinance = r.status==='pending_finance' && allowAction('requisitions.approve_finance','approve_finance');
  return `<tr><td><strong>${escape(r.title)}</strong><small>${escape(r.skills.join(', '))}</small></td><td>${escape(r.team)}</td><td>${r.headcount}</td><td>${badge(r.status)}</td><td><div class="actions">${button('Details','req-details',r.id,'class="secondary"')}${['draft','open'].includes(r.status)&&allowAction('requisitions.update','requisition','recruit')?button('Edit','edit-req',r.id,'class="secondary"'):''}${r.status==='draft'&&allowAction('requisitions.submit','requisition','recruit')?button('Submit','submit-req',r.id):''}${(canReviewManager||canReviewFinance)?button('Review','approve-req',r.id):''}</div></td></tr>`;
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
  const canReviewManager = r.status==='pending_manager' && allowAction('requisitions.approve_manager','approve_manager');
  const canReviewFinance = r.status==='pending_finance' && allowAction('requisitions.approve_finance','approve_finance');
  const canEdit=!readOnly&&((['draft','open'].includes(r.status)||((allows('requisitions.override')||allows('system.override'))&&['pending_manager','pending_finance'].includes(r.status)))&&allowAction('requisitions.update','requisition','recruit'));
  const skillsList=Array.isArray(r.skills)?r.skills:[];
  const reviewBtn = (canReviewManager || canReviewFinance) ? button('Review requisition', 'approve-req', r.id, 'class="primary"') : '';
  return `<div class="requisition-detail"><p class="detail-meta">${badge(r.status)} · ${escape(r.team)} · ${r.headcount} opening(s)</p>${r.salary_min!==undefined?`<p class="detail-salary">${r.salary_min}–${r.salary_max} ${escape(r.currency)}</p>`:''}${requisitionDescription(r.description)}${skillsList.length?`<h3 class="detail-section-title">Required skills</h3><div class="skill-list">${skillsList.map(s=>`<span class="skill-chip">${escape(s)}</span>`).join('')}</div>`:''}${readOnly?`<p class="read-only-note" role="status">${icon('Administration')}<span>Read-only view. Editing is available from the Requisitions page for authorized users.</span></p>`:''}<div class="actions detail-actions">${reviewBtn}${canEdit?button('Edit','edit-req',r.id):''}</div></div>`;
}
function candidateStatusCell(c){
  if(!c.applications||!c.applications.length)return '<span class="muted">No applications</span>';
  return `<div class="candidate-status-list">${c.applications.map(a=>{
    const title=escape(a.title||'General Application');
    return `<div class="candidate-status-pair"><span class="candidate-status-role" title="${title}">${title}</span> <span class="status-sep" aria-hidden="true">—</span> ${badge(a.stage||'Applied')}</div>`;
  }).join('')}</div>`;
}
function candidateTable(cs){return table(['Candidate','Skills','Source','Status','Actions'],cs.map(c=>`<tr><td><div class="person-cell"><span class="avatar">${initials(c.name)}</span><div><strong title="${escape(c.name)}">${escape(c.name)}</strong><small title="${escape(c.email)}">${escape(c.email)}</small></div></div></td><td><div class="skill-list">${c.skills.map(s=>`<span class="skill-chip" title="${escape(s)}">${escape(s)}</span>`).join('')}</div></td><td><span title="${escape(c.source)}">${escape(c.source)}</span></td><td>${candidateStatusCell(c)}</td><td><div class="actions">${button('View profile','candidate-details',c.id,'class="secondary"')}${allowAction('candidates.update','recruit')?button('Edit','edit-candidate',c.id,'class="secondary"'):''}</div></td></tr>`),'candidates-table');}


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

function bindTrainingPlansFilter() {
  const input = document.getElementById('training-search-input');
  const select = document.getElementById('training-status-filter');
  const table = document.querySelector('.training-plans-table');
  const emptyNotice = document.getElementById('training-filter-empty');
  if (!table) return;

  const rows = Array.from(table.querySelectorAll('tbody tr.training-plan-row'));

  const applyFilter = () => {
    const q = (input?.value || '').trim().toLowerCase();
    const st = select?.value || 'all';
    window._trainingSearchTerm = q;
    window._trainingFilterStatus = st;

    let visibleCount = 0;
    rows.forEach(tr => {
      const searchBlob = tr.dataset.search || `${tr.dataset.name || ''} ${tr.dataset.desc || ''} ${tr.dataset.positions || ''} ${tr.dataset.departments || ''}`.toLowerCase();
      const status = tr.dataset.status || '';

      const matchesStatus = (st === 'all' || status === st);
      const matchesSearch = !q || searchBlob.includes(q);

      if (matchesStatus && matchesSearch) {
        tr.style.display = '';
        visibleCount++;
      } else {
        tr.style.display = 'none';
      }
    });

    if (emptyNotice) {
      emptyNotice.style.display = (visibleCount === 0 && rows.length > 0) ? 'block' : 'none';
    }
  };

  if (input) input.addEventListener('input', applyFilter);
  if (select) select.addEventListener('change', applyFilter);
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
        if (!allows('integrations.secrets.manage')) {
          return `
          <div class="full int-secret-group" style="background:var(--surface-alt);border:1px solid var(--line);padding:12px 14px;border-radius:8px;margin-top:4px;">
            <strong>${escape(f.label)}</strong>
            <p class="muted" style="font-size:0.8rem;margin:6px 0 0;">${f.hasSavedSecret ? 'A credential is stored securely.' : 'No credential is stored.'} You do not have permission to view, add, replace or remove integration credentials.</p>
          </div>`;
        }
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
              <span class="muted">${f.hasSavedSecret ? '<span class="int-saved-badge">Stored securely with AES-256-GCM encryption</span>' : '<span>Stored securely with AES-256-GCM authenticated encryption</span>'}</span>
              ${f.hasSavedSecret ? `<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--negative);font-size:0.75rem;"><input type="checkbox" name="remove_sec_${f.key}"> Remove credential</label>` : ''}
            </div>
          </div>
        `;
      }
      return field(f.label, `cfg_${f.key}`, f.type || 'text', f.value ?? '', f.required);
    };

    let modalBadgeClass = 'pending';
    let modalStatusLabel = 'Ready to Setup';
    if (details.status === 'connected') {
      modalBadgeClass = 'completed';
      modalStatusLabel = 'Connected';
    } else if (details.status === 'configured') {
      modalBadgeClass = 'active';
      modalStatusLabel = 'Configured';
    } else if (details.status === 'disabled') {
      modalBadgeClass = 'disabled';
      modalStatusLabel = 'Deactivated';
    } else if (details.status === 'failed') {
      modalBadgeClass = 'rejected';
      modalStatusLabel = 'Needs Attention';
    }

    const formHtml = `
      <div class="int-modal-body">
        <div class="int-modal-hero">
          <div>
            <div class="int-meta-sub" style="margin-bottom:4px;">
              <span>${escape(details.category || '')}</span>
              <span class="int-dot-sep">·</span>
              <span class="int-type-tag ${details.isExternal ? 'int-type-cloud' : 'int-type-inhouse'}">${details.isExternal ? 'Cloud API' : 'In-House'}</span>
            </div>
            <h3 class="int-hero-title">${escape(details.name)}</h3>
            <p class="int-hero-desc">${escape(details.description)}</p>
          </div>
          <span class="badge ${modalBadgeClass}">${modalStatusLabel}</span>
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
          <button type="button" class="button secondary" id="modal-inline-test-btn" data-id="${escape(details.id)}">Test Connection</button>
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
            testResult.textContent = res.message || 'Connection verified successfully.';
          } else {
            testResult.className = 'int-modal-test-msg err';
            testResult.textContent = res.message || 'Connection failed.';
          }
        } catch (err) {
          testResult.className = 'int-modal-test-msg err';
          testResult.textContent = err.message || 'Connection test failed.';
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
          <strong>Connection Verified</strong>
          <p style="margin:6px 0 0;color:var(--ink);">${escape(res.message)}</p>
        </div>
        ${res.details ? `<div style="margin-top:14px;"><strong style="font-size:0.85rem;">Diagnostic Response:</strong><pre class="mono" style="background:var(--surface-alt);border:1px solid var(--line);padding:12px;border-radius:8px;font-size:0.82rem;overflow-x:auto;margin-top:6px;">${escape(JSON.stringify(res.details, null, 2))}</pre></div>` : ''}
      `);
      notice('Connection test passed.', 'success');
    } else {
      modal('Connection Test Failed', `
        <div class="notice-inline danger-notice">
          <strong>Connection Failed</strong>
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
        <strong>Test Request Failed</strong>
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

function pdfBase64ToBlobUrl(base64) {
  if (!base64) return null;
  try {
    const binStr = atob(base64);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'application/pdf' });
    return URL.createObjectURL(blob);
  } catch (e) {
    console.error('Failed to convert base64 to Blob URL:', e);
    return null;
  }
}

function renderSectionsToA4Html(sections, vars = {}, headerText = '', footerText = '') {
  const interpolate = (txt) => {
    if (!txt) return '';
    return txt.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `{{${key}}}`);
  };

  const pages = [[]];
  for (const s of (sections || [])) {
    if (s.type === 'page_break') {
      pages.push([]);
    } else {
      pages[pages.length - 1].push(s);
    }
  }

  const annualCtcStr = vars['offer.annual_ctc'] || vars['offer.salary'] || '₹2,400,000';
  const cleanSalary = Number(String(annualCtcStr).replace(/[^0-9.]/g, '')) || 2400000;
  const currSym = vars['offer.currency_symbol'] || (vars['offer.currency'] === 'USD' ? '$' : '₹');
  const basic = Math.round(cleanSalary * 0.40);
  const hra = Math.round(cleanSalary * 0.20);
  const sa = cleanSalary - basic - hra;
  const mCtc = Math.round(cleanSalary / 12);
  const mBasic = Math.round(basic / 12);
  const mHra = Math.round(hra / 12);
  const mSa = mCtc - mBasic - mHra;

  return pages.map((pageSections, pIdx) => `
    <div class="a4-sheet-page">
      <div class="a4-sheet-header">
        <span>${escape(interpolate(headerText || 'Mechlin Technologies • Confidential Offer'))}</span>
        <span>Private & Confidential</span>
      </div>
      <div class="a4-sheet-body">
        ${pageSections.map(s => {
          if (s.type === 'heading') {
            const lvl = s.level || 2;
            const align = s.align || 'left';
            return `<div class="a4-sheet-h${lvl}" style="text-align:${align};">${escape(interpolate(s.text || ''))}</div>`;
          }
          if (s.type === 'paragraph') {
            const align = s.align || 'left';
            const size = s.fontSize || 9.5;
            const weight = s.bold ? '700' : '400';
            return `<p class="a4-sheet-p" style="text-align:${align};font-size:${size}pt;font-weight:${weight};">${escape(interpolate(s.text || ''))}</p>`;
          }
          if (s.type === 'bullet_list' || s.type === 'numbered_list') {
            const isNum = s.listType === 'numbered';
            const tag = isNum ? 'ol' : 'ul';
            const items = Array.isArray(s.items) ? s.items : (s.items || '').split('\n').filter(Boolean);
            return `<${tag} class="a4-sheet-list">${items.map(it => `<li>${escape(interpolate(it))}</li>`).join('')}</${tag}>`;
          }
          if (s.type === 'key_value') {
            const pairs = Array.isArray(s.pairs) ? s.pairs : [];
            return `
              <table class="a4-sheet-table">
                <tbody>
                  ${pairs.map(p => `<tr><td style="width:35%;font-weight:600;background:#f8fafc;">${escape(p.key)}</td><td>${escape(interpolate(p.value))}</td></tr>`).join('')}
                </tbody>
              </table>
            `;
          }
          if (s.type === 'salary_annexure') {
            return `
              <div style="margin:16px 0;">
                <div style="font-weight:700;font-size:10pt;margin-bottom:6px;color:#0f172a;">${escape(s.title || 'ANNEXURE A — REMUNERATION STRUCTURE')}</div>
                <table class="a4-sheet-table">
                  <thead>
                    <tr><th>Salary Component</th><th style="text-align:right;">Monthly</th><th style="text-align:right;">Annual</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>Basic Salary</td><td style="text-align:right;">${currSym}${mBasic.toLocaleString()}</td><td style="text-align:right;">${currSym}${basic.toLocaleString()}</td></tr>
                    <tr><td>House Rent Allowance (HRA)</td><td style="text-align:right;">${currSym}${mHra.toLocaleString()}</td><td style="text-align:right;">${currSym}${hra.toLocaleString()}</td></tr>
                    <tr><td>Special Allowance</td><td style="text-align:right;">${currSym}${mSa.toLocaleString()}</td><td style="text-align:right;">${currSym}${sa.toLocaleString()}</td></tr>
                    <tr style="font-weight:700;background:#f1f5f9;"><td>Total Cost to Company (CTC)</td><td style="text-align:right;">${currSym}${mCtc.toLocaleString()}</td><td style="text-align:right;">${currSym}${cleanSalary.toLocaleString()}</td></tr>
                  </tbody>
                </table>
              </div>
            `;
          }
          if (s.type === 'signature_block') {
            return `
              <div class="a4-sheet-signatures">
                <div class="a4-sheet-sig-box">
                  <strong>For ${escape(vars['company.name'] || 'Mechlin Technologies')}</strong><br><br>
                  <div style="height:24px;"></div>
                  <div><strong>${escape(interpolate(s.authorizerName || 'Authorized Signatory'))}</strong></div>
                  <div style="color:#64748b;">${escape(interpolate(s.authorizerTitle || 'Managing Director'))}</div>
                </div>
                <div class="a4-sheet-sig-box">
                  <strong>Candidate Acceptance</strong><br><br>
                  <div style="height:24px;"></div>
                  <div><strong>${escape(interpolate(s.signerName || vars['candidate.name'] || 'Candidate Name'))}</strong></div>
                  <div style="color:#64748b;">Accepted & Signed Electronically</div>
                </div>
              </div>
            `;
          }
          if (s.type === 'divider') {
            return `<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;">`;
          }
          return '';
        }).join('')}
      </div>
      <div class="a4-sheet-footer">
        <span>${escape(interpolate(footerText || 'Strictly Private & Confidential'))}</span>
        <span>Page ${pIdx + 1} of ${pages.length}</span>
      </div>
    </div>
  `).join('');
}

async function openOfferTemplatePreview(templateId, candId, reqId, appId, salary, currency, customSections = null) {
  try {
    const payload = {};
    if (candId) payload.candidateId = candId;
    if (reqId) payload.requisitionId = reqId;
    if (appId) payload.applicationId = appId;
    if (salary || currency) payload.offerData = { salary, currency };
    if (customSections) payload.customSections = customSections;

    const preview = await api(`offer-templates/${templateId}/preview`, 'POST', payload);
    const valid = preview.validation?.valid;
    const missing = preview.validation?.missingRequired || [];
    const blobUrl = pdfBase64ToBlobUrl(preview.pdfBase64);
    const fallbackUrl = `/api/offer-templates/${templateId}/preview.pdf?t=${Date.now()}`;
    const pdfUrl = blobUrl || fallbackUrl;
    const sectionsToRender = preview.sections || customSections || [];
    const visualHtml = renderSectionsToA4Html(sectionsToRender, preview.variables || {}, preview.headerConfig?.text, preview.footerConfig?.text);

    const previewHtml = `
      <div class="a4-preview-modal" style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--line);">
          <div>
            <strong>${escape(preview.templateName)}</strong> <span class="badge mono">v${preview.version}</span>
            <p class="muted" style="margin:2px 0 0;font-size:0.8rem;">A4 Multi-Page Layout • <strong>${preview.totalPages} page(s)</strong> • ${(preview.pdfSize / 1024).toFixed(1)} KB</p>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <div style="display:flex;gap:3px;background:var(--surface-alt);padding:3px;border-radius:6px;border:1px solid var(--line);">
              <button type="button" class="studio-view-toggle active" id="btn-pv-visual" style="font-size:0.75rem;padding:3px 9px;">Visual Document</button>
              <button type="button" class="studio-view-toggle" id="btn-pv-pdf" style="font-size:0.75rem;padding:3px 9px;">PDF File</button>
            </div>
            <a href="${pdfUrl}" target="_blank" class="button secondary" style="font-size:0.75rem;padding:4px 10px;">Open in Tab</a>
            <a href="${pdfUrl}" download="${escape(preview.templateName.replace(/\s+/g, '_'))}.pdf" class="button secondary" style="font-size:0.75rem;padding:4px 10px;">Download PDF</a>
          </div>
        </div>
        ${valid ? `
          <div class="validation-box valid" style="padding:6px 10px;font-size:0.75rem;">
            <span style="font-weight:600;">Ready for issuance:</span>
            <span>All required dynamic placeholders have been resolved for this document.</span>
          </div>
        ` : `
          <div class="validation-box" style="padding:6px 10px;font-size:0.75rem;">
            <span style="font-weight:600;">Missing Required Placeholders (${missing.length}):</span>
            <div class="validation-item-list">${missing.map(m => `<span class="validation-pill">${escape(m)}</span>`).join('')}</div>
          </div>
        `}
        <div id="pv-visual-container" class="studio-a4-sheet-container" style="max-height:65vh;overflow-y:auto;display:flex;">
          ${visualHtml}
        </div>
        <div id="pv-pdf-container" style="display:none;width:100%;height:65vh;background:var(--surface-alt);border:1px solid var(--line);border-radius:10px;overflow:hidden;">
          <iframe src="${pdfUrl}" style="width:100%;height:100%;border:none;display:block;" title="A4 Document Preview"></iframe>
        </div>
      </div>
    `;

    modal(`Document Preview — ${preview.templateName}`, previewHtml, null);

    const visualBtn = $('#btn-pv-visual');
    const pdfBtn = $('#btn-pv-pdf');
    const visualBox = $('#pv-visual-container');
    const pdfBox = $('#pv-pdf-container');

    if (visualBtn && pdfBtn && visualBox && pdfBox) {
      visualBtn.onclick = () => {
        visualBtn.classList.add('active');
        pdfBtn.classList.remove('active');
        visualBox.style.display = 'flex';
        pdfBox.style.display = 'none';
      };
      pdfBtn.onclick = () => {
        pdfBtn.classList.add('active');
        visualBtn.classList.remove('active');
        visualBox.style.display = 'none';
        pdfBox.style.display = 'block';
      };
    }
  } catch (err) {
    notice(err.message, 'error');
  }
}

async function openLetterheadUploadModal() {
  const uploadHtml = `
    <div class="form-grid">
      ${field('Asset name / Title', 'name', 'text', 'Company Letterhead 2026', true)}
      <label class="full">
        <span class="label-heading">Stationery / Letterhead File<span class="field-required">*</span></span>
        <input type="file" id="letterhead-file" accept=".png,.jpg,.jpeg,.pdf,.docx" required style="padding:8px;">
        <small class="muted" style="display:block;margin-top:4px;">Supports PNG, JPG, PDF, and DOCX (Max 10MB). Automatically scaled to A4 portrait.</small>
      </label>
      <label>
        <span class="label-heading">Scaling Mode</span>
        <select name="scaling">
          <option value="fit" selected>Fit to Page (Preserve Aspect Ratio)</option>
          <option value="stretch">Stretch to Full Page</option>
          <option value="header-only">Header Band Only (Top 120pt)</option>
          <option value="footer-only">Footer Band Only (Bottom 80pt)</option>
          <option value="original">Original Dimensions</option>
        </select>
      </label>
      <label>
        <span class="label-heading">Page Target</span>
        <select name="page_target">
          <option value="all" selected>All Pages</option>
          <option value="first_page">First Page Only</option>
          <option value="continuation">Continuation Pages Only</option>
        </select>
      </label>
      <div id="upload-status" class="full muted" style="font-size:0.8rem;"></div>
    </div>
  `;

  modal('Upload Company Letterhead / Stationery', uploadHtml, async v => {
    const fileInput = $('#letterhead-file');
    const file = fileInput?.files?.[0];
    if (!file) throw new Error('Please choose a file to upload.');
    if (file.size > 10 * 1024 * 1024) throw new Error('File exceeds maximum upload size of 10MB.');

    const statusEl = $('#upload-status');
    if (statusEl) statusEl.textContent = 'Processing and validating asset format...';

    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = reader.result;
        const b64 = String(res).split(',')[1] || String(res);
        resolve(b64);
      };
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.readAsDataURL(file);
    });

    await api('offer-letter-assets', 'POST', {
      name: v.name?.trim() || file.name,
      filename: file.name,
      fileBase64: base64,
      scaling: v.scaling || 'fit',
      pageTarget: v.page_target || 'all'
    });

    notice('Company letterhead uploaded and processed successfully!', 'success');
    return 'Letterhead saved.';
  }, { saveLabel: 'Upload & Process Letterhead' });
}

const PREBUILT_CLAUSES = [
  {
    id: 'clause_appointment',
    name: '1. Appointment & Designation',
    category: 'Core Terms',
    description: 'Executive appointment terms, department, reporting manager, and commencement.',
    sections: [
      { id: 'sec_pos_head', type: 'heading', level: 2, text: '1. Position Details & Commencement' },
      { id: 'sec_pos_body', type: 'paragraph', text: 'On behalf of {{company.name}}, we are pleased to appoint you as {{employment.designation}} within our {{requisition.department}} team, reporting to {{employment.manager}}. Your employment commences on {{employment.joining_date}}.' }
    ]
  },
  {
    id: 'clause_workplace',
    name: '2. Workplace & Hybrid Guidelines',
    category: 'Workplace',
    description: 'Primary work location and corporate hybrid/remote work schedule expectations.',
    sections: [
      { id: 'sec_loc_head', type: 'heading', level: 2, text: '2. Work Location & Hybrid Policy' },
      { id: 'sec_loc_body', type: 'paragraph', text: 'Your primary workplace is designated as {{employment.location}}, subject to company hybrid working guidelines. The company reserves the right to adjust location based on business requirements.' }
    ]
  },
  {
    id: 'clause_probation',
    name: '3. Probation & Performance Review',
    category: 'Employment Terms',
    description: 'Probationary period review, criteria, and written confirmation.',
    sections: [
      { id: 'sec_prob_head', type: 'heading', level: 2, text: '3. Probationary Period & Confirmation' },
      { id: 'sec_prob_body', type: 'paragraph', text: 'You will be on probation for a period of {{employment.probation_period}} from your joining date, during which your performance will be evaluated. Upon satisfactory review, employment will be confirmed in writing.' }
    ]
  },
  {
    id: 'clause_compensation',
    name: '4. Compensation & Salary Schedule',
    category: 'Compensation',
    description: 'Total annual Cost to Company (CTC), payment frequency, and annexure reference.',
    sections: [
      { id: 'sec_comp_head', type: 'heading', level: 2, text: '4. Compensation & Remuneration' },
      { id: 'sec_comp_body', type: 'paragraph', text: 'Your total annual Cost to Company (CTC) will be {{offer.annual_ctc}} ({{offer.salary_period}}), payable monthly in arrears in accordance with company payroll schedules. The detailed breakup is set forth in Annexure A.' }
    ]
  },
  {
    id: 'clause_joining_bonus',
    name: '5. Sign-On / Joining Bonus',
    category: 'Compensation',
    description: 'Special sign-on bonus with clawback terms if resigning within 12 months.',
    sections: [
      { id: 'sec_bonus_head', type: 'heading', level: 2, text: '5. One-Time Joining Bonus' },
      { id: 'sec_bonus_body', type: 'paragraph', text: 'You are eligible for a one-time joining bonus of ₹100,000, payable alongside your first monthly salary cycle. Should you voluntarily resign or be terminated for cause within 12 months, this bonus must be repaid in full.' }
    ]
  },
  {
    id: 'clause_benefits',
    name: '6. Health & Retiral Benefits',
    category: 'Benefits',
    description: 'Group Medical Insurance, Provident Fund, Gratuity, and paid leave.',
    sections: [
      { id: 'sec_ben_head', type: 'heading', level: 2, text: '6. Employee Benefits & Coverage' },
      { id: 'sec_ben_list', type: 'bullet_list', items: [
        'Comprehensive Group Medical Insurance covering hospitalization for self and eligible dependents',
        'Statutory contributions to Employee Provident Fund (PF) and Gratuity as mandated by law',
        'Annual entitlement to paid leave, sick leave, and statutory national and festival holidays'
      ]}
    ]
  },
  {
    id: 'clause_confidentiality',
    name: '7. Confidentiality & IP Rights',
    category: 'Legal & IP',
    description: 'Trade secrets protection and intellectual property assignment.',
    sections: [
      { id: 'sec_conf_head', type: 'heading', level: 2, text: '7. Confidentiality & Intellectual Property' },
      { id: 'sec_conf_body', type: 'paragraph', text: 'You agree to maintain strict confidentiality regarding all proprietary information, software code, algorithms, and client data of {{company.name}}. All work products and inventions created during employment belong exclusively to the company.' }
    ]
  },
  {
    id: 'clause_non_compete',
    name: '8. Non-Compete & Non-Solicitation',
    category: 'Legal & IP',
    description: '12-month post-employment covenant not to solicit clients or staff.',
    sections: [
      { id: 'sec_nc_head', type: 'heading', level: 2, text: '8. Non-Solicitation & Non-Compete' },
      { id: 'sec_nc_body', type: 'paragraph', text: 'During your employment and for a period of 12 months thereafter, you agree not to solicit or hire company employees, nor divert business from any clients of {{company.name}}.' }
    ]
  },
  {
    id: 'clause_bgv',
    name: '9. Background Check Contingencies',
    category: 'Compliance',
    description: 'Contingent upon background verification and previous employer relieving letter.',
    sections: [
      { id: 'sec_bgv_head', type: 'heading', level: 2, text: '9. Background Verification & Pre-Conditions' },
      { id: 'sec_bgv_body', type: 'paragraph', text: 'This offer is contingent upon satisfactory completion of background verification checks, verification of academic credentials, and submission of formal relieving documentation from your previous employer.' }
    ]
  },
  {
    id: 'clause_termination',
    name: '10. Termination & Notice Period',
    category: 'Employment Terms',
    description: 'Notice period during probation vs post-confirmation.',
    sections: [
      { id: 'sec_term_head', type: 'heading', level: 2, text: '10. Termination & Notice Period' },
      { id: 'sec_term_body', type: 'paragraph', text: 'During probation, either party may terminate employment with 15 days written notice. Following confirmation, the notice period shall be {{employment.notice_period}} (or salary in lieu thereof).' }
    ]
  },
  {
    id: 'clause_acceptance',
    name: '11. Offer Acceptance & Expiration',
    category: 'Execution',
    description: 'Expiration date and electronic signing instructions.',
    sections: [
      { id: 'sec_acc_head', type: 'heading', level: 2, text: '11. Offer Acceptance & Validity' },
      { id: 'sec_acc_body', type: 'paragraph', text: 'This offer remains open for acceptance until {{offer.expiry_date}}. Please execute your electronic signature below to confirm your acceptance of employment terms.' }
    ]
  },
  {
    id: 'clause_salary_annexure',
    name: '12. Compensation Annexure Table',
    category: 'Compensation',
    description: 'Dynamic multi-column HRMS payroll table matching tax & statutory guidelines.',
    sections: [
      { id: 'sec_annex_pb', type: 'page_break' },
      { id: 'sec_annex_h', type: 'heading', level: 1, text: 'ANNEXURE A — DETAILED REMUNERATION STRUCTURE' },
      { id: 'sec_annex_p', type: 'paragraph', text: 'Candidate Name: {{candidate.name}}  |  Designation: {{employment.designation}}  |  Location: {{employment.location}}\nEffective Date: {{employment.joining_date}}  |  Currency: {{offer.currency}}', fontSize: 9 },
      { id: 'sec_annex_tbl', type: 'salary_annexure', title: 'ANNUAL & MONTHLY REMUNERATION DETAILS' }
    ]
  },
  {
    id: 'clause_signatures',
    name: '13. Dual Signature & Acceptance Block',
    category: 'Execution',
    description: 'Company Authorized Signatory and Candidate Acceptance signature lines.',
    sections: [
      { id: 'sec_sig_block', type: 'signature_block', authorizerName: '{{signature.authorizer_name}}', authorizerTitle: 'Managing Director', signerName: '{{signature.signer_name}}' }
    ]
  }
];

function openClauseLibraryModal(onSelectClause) {
  const modalHtml = `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <p class="muted" style="margin:0;font-size:0.84rem;">Click "+ Insert Clause" to add pre-drafted, production-ready legal and compensation clauses into your offer letter.</p>
        <input type="text" id="clause-search-input" placeholder="Search clauses..." style="max-width:240px;font-size:0.8rem;padding:6px 10px;">
      </div>
      <div class="clause-library-modal-wrap" id="clause-library-cards">
        ${PREBUILT_CLAUSES.map((c, idx) => `
          <div class="clause-library-card" data-clause-idx="${idx}" data-category="${escape(c.category)}" data-name="${escape(c.name.toLowerCase())}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
              <span class="badge" style="font-size:0.68rem;background:var(--tint);color:var(--accent);font-weight:700;">${escape(c.category)}</span>
              <button type="button" class="button" data-clause-insert="${idx}" style="font-size:0.75rem;padding:3px 10px;min-height:26px;">+ Insert Clause</button>
            </div>
            <h4 style="margin:4px 0 0;">${escape(c.name)}</h4>
            <p>${escape(c.description)}</p>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  modal('Pre-Built Clause Library', modalHtml, null, {
    actions: `<button type="button" class="secondary" data-action="close-modal">Done</button>`
  });

  const searchInp = $('#clause-search-input');
  if (searchInp) {
    searchInp.oninput = () => {
      const q = searchInp.value.toLowerCase().trim();
      document.querySelectorAll('#clause-library-cards .clause-library-card').forEach(el => {
        const matches = !q || el.dataset.name.includes(q) || el.dataset.category.toLowerCase().includes(q);
        el.style.display = matches ? 'flex' : 'none';
      });
    };
  }

  document.querySelectorAll('[data-clause-insert]').forEach(btn => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.clauseInsert);
      const clause = PREBUILT_CLAUSES[idx];
      if (clause && onSelectClause) {
        onSelectClause(JSON.parse(JSON.stringify(clause.sections)));
        btn.textContent = 'Added';
        btn.style.background = 'var(--positive)';
        setTimeout(() => { btn.textContent = 'Insert Clause'; btn.style.background = ''; }, 1200);
        notice(`Added "${clause.name}" to template!`, 'success');
      }
    };
  });
}

async function openOfferTemplateEditor(templateId) {
  try {
    const [tpl, assets, varReg] = await Promise.all([
      templateId ? api(`offer-templates/${templateId}`) : null,
      api('offer-letter-assets').catch(() => []),
      api('offer-variables').catch(() => ({ variables: [] }))
    ]);

    const initialSections = tpl ? JSON.parse(JSON.stringify(tpl.sections)) : [
      { id: 'sec_head', type: 'heading', level: 1, text: 'OFFER OF EMPLOYMENT' },
      { id: 'sec_intro', type: 'paragraph', text: 'Dear {{candidate.name}},\n\nOn behalf of {{company.name}}, we are pleased to extend an offer of employment for the position of {{employment.designation}} within the {{requisition.department}} department.' },
      { id: 'sec_terms_head', type: 'heading', level: 2, text: '1. Employment Terms & Reporting' },
      { id: 'sec_terms_list', type: 'bullet_list', items: ['Designation: {{employment.designation}}', 'Location: {{employment.location}}', 'Commencement: {{employment.joining_date}}'] },
      { id: 'sec_comp_head', type: 'heading', level: 2, text: '2. Remuneration & Benefits' },
      { id: 'sec_comp_text', type: 'paragraph', text: 'Your total annual Cost to Company (CTC) will be {{offer.annual_ctc}} ({{offer.salary_period}}). Statutory benefits and detailed structure are outlined in Annexure A.' },
      { id: 'sec_sig', type: 'signature_block', authorizerName: '{{signature.authorizer_name}}', authorizerTitle: 'Managing Director', signerName: '{{signature.signer_name}}' },
      { id: 'sec_pb', type: 'page_break' },
      { id: 'sec_annexure_h', type: 'heading', level: 1, text: 'ANNEXURE A — COMPENSATION BREAKDOWN' },
      { id: 'sec_annexure_tbl', type: 'salary_annexure', title: 'DETAILED REMUNERATION STRUCTURE' }
    ];

    let currentSections = initialSections;
    let lastActiveField = null;
    let activeStudioTab = 'sections';

    let pageConfig = tpl?.page_config ? {
      size: 'A4', orientation: 'portrait',
      marginTop: tpl.page_config.marginTop ?? tpl.page_config.margins?.top ?? 60,
      marginBottom: tpl.page_config.marginBottom ?? tpl.page_config.margins?.bottom ?? 60,
      marginLeft: tpl.page_config.marginLeft ?? tpl.page_config.margins?.left ?? 54,
      marginRight: tpl.page_config.marginRight ?? tpl.page_config.margins?.right ?? 54,
      margins: {
        top: tpl.page_config.marginTop ?? tpl.page_config.margins?.top ?? 60,
        bottom: tpl.page_config.marginBottom ?? tpl.page_config.margins?.bottom ?? 60,
        left: tpl.page_config.marginLeft ?? tpl.page_config.margins?.left ?? 54,
        right: tpl.page_config.marginRight ?? tpl.page_config.margins?.right ?? 54
      }
    } : {
      size: 'A4', orientation: 'portrait',
      marginTop: 60, marginBottom: 60, marginLeft: 54, marginRight: 54,
      margins: { top: 60, bottom: 60, left: 54, right: 54 }
    };
    let headerConfig = tpl?.header_config || {
      enabled: true, text: '{{company.name}} • Confidential Offer of Employment', showOnFirstPage: false
    };
    let footerConfig = tpl?.footer_config || {
      enabled: true, text: 'Strictly Confidential', pageNumberFormat: 'Page {page} of {pages}'
    };
    let backgroundConfig = tpl?.background_config || {
      firstPageAssetId: '', continuationAssetId: ''
    };

    const categorizedVars = {};
    for (const v of (varReg.variables || [])) {
      if (!categorizedVars[v.category]) categorizedVars[v.category] = [];
      categorizedVars[v.category].push(v);
    }

    const assetOptions = [['', 'None (Standard White Background)']];
    for (const a of assets) {
      assetOptions.push([a.id, `${a.name} (${a.file_format.toUpperCase()})`]);
    }

    const editorHtml = `
      <div class="offer-studio">
        <div class="offer-studio-header">
          <div class="offer-studio-header-left">
            <input type="text" id="studio-tpl-name" class="offer-studio-title-input" value="${escape(tpl?.name || 'Standard Employment Agreement')}" placeholder="Template Title..." title="Click to rename template">
            <select id="studio-tpl-status" style="font-size:0.78rem;padding:4px 8px;min-height:28px;">
              <option value="active" ${tpl?.status === 'active' ? 'selected' : ''}>Active</option>
              <option value="draft" ${tpl?.status === 'draft' || !tpl ? 'selected' : ''}>Draft</option>
            </select>
            <label class="checkbox-row" style="font-size:0.78rem;margin:0;cursor:pointer;">
              <input type="checkbox" id="studio-tpl-default" value="1" ${tpl?.is_default ? 'checked' : ''}>
              <span>Default Template</span>
            </label>
          </div>
          <div class="offer-studio-header-actions">
            <button type="button" class="secondary" id="btn-studio-clause-lib" style="font-size:0.8rem;padding:6px 12px;">Clause Library</button>
            <button type="button" class="secondary" id="btn-studio-refresh-preview" style="font-size:0.8rem;padding:6px 12px;">Refresh Preview</button>
            <button type="button" id="btn-studio-save-tpl" style="font-size:0.8rem;padding:6px 16px;">${templateId ? 'Save Changes' : 'Create Template'}</button>
          </div>
        </div>

        <div class="offer-studio-layout">
          <!-- Left Editor Column -->
          <div class="offer-studio-editor">
            <div class="offer-studio-tabs">
              <button type="button" class="offer-studio-tab-btn active" data-tab="sections">Document Sections</button>
              <button type="button" class="offer-studio-tab-btn" data-tab="branding">Page Setup & Stationery</button>
              <button type="button" class="offer-studio-tab-btn" data-tab="variables">Dynamic Variables</button>
            </div>

            <!-- Tab 1: Sections & Clauses -->
            <div id="tab-pane-sections">
              <div class="studio-toolbar">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <span class="studio-toolbar-label">Add Block:</span>
                  <div class="studio-quick-add-group">
                    <button type="button" class="studio-quick-add-btn" data-add-sec="heading">Heading</button>
                    <button type="button" class="studio-quick-add-btn" data-add-sec="paragraph">Paragraph</button>
                    <button type="button" class="studio-quick-add-btn" data-add-sec="bullet_list">Bullet List</button>
                    <button type="button" class="studio-quick-add-btn" data-add-sec="key_value">Key-Value</button>
                    <button type="button" class="studio-quick-add-btn" data-add-sec="salary_annexure">Salary Table</button>
                    <button type="button" class="studio-quick-add-btn" data-add-sec="signature_block">Signatures</button>
                    <button type="button" class="studio-quick-add-btn" data-add-sec="page_break">Page Break</button>
                    <button type="button" class="studio-quick-add-btn" data-add-sec="divider">Divider</button>
                  </div>
                </div>
                <button type="button" class="secondary studio-quick-lib-btn" id="btn-studio-add-prebuilt">Insert Prebuilt Clause</button>
              </div>

              <div id="studio-sections-list"></div>
            </div>

            <!-- Tab 2: Page Setup & Stationery -->
            <div id="tab-pane-branding" style="display:none;">
              <div class="form-grid">
                <div class="full" style="display:grid;grid-template-columns:repeat(4, 1fr);gap:10px;background:var(--surface-alt);padding:12px 14px;border-radius:8px;border:1px solid var(--line);">
                  <strong class="full" style="font-size:0.82rem;grid-column:1/-1;">Page Margins (Points, A4 = 595 × 842 pt)</strong>
                  <label><span class="label-heading">Top</span><input type="number" id="cfg-margin-top" min="0" max="350" step="2" value="${pageConfig?.marginTop ?? pageConfig?.margins?.top ?? 60}"></label>
                  <label><span class="label-heading">Bottom</span><input type="number" id="cfg-margin-bottom" min="0" max="350" step="2" value="${pageConfig?.marginBottom ?? pageConfig?.margins?.bottom ?? 60}"></label>
                  <label><span class="label-heading">Left</span><input type="number" id="cfg-margin-left" min="0" max="250" step="2" value="${pageConfig?.marginLeft ?? pageConfig?.margins?.left ?? 54}"></label>
                  <label><span class="label-heading">Right</span><input type="number" id="cfg-margin-right" min="0" max="250" step="2" value="${pageConfig?.marginRight ?? pageConfig?.margins?.right ?? 54}"></label>
                </div>

                <div class="full" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;background:var(--surface-alt);padding:12px 14px;border-radius:8px;border:1px solid var(--line);">
                  <strong class="full" style="font-size:0.82rem;grid-column:1/-1;">Running Header & Footer</strong>
                  <label><span class="label-heading">Header Text</span><input type="text" id="cfg-header-text" value="${escape(headerConfig?.text || '{{company.name}} • Confidential Offer')}"></label>
                  <label><span class="label-heading">Footer Confidentiality Notice</span><input type="text" id="cfg-footer-text" value="${escape(footerConfig?.text || 'Strictly Private & Confidential')}"></label>
                  <label class="checkbox-row full"><input type="checkbox" id="cfg-header-first-page" ${headerConfig?.showOnFirstPage ? 'checked' : ''}><span>Show header on first page</span></label>
                </div>

                <div class="full" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;background:var(--surface-alt);padding:12px 14px;border-radius:8px;border:1px solid var(--line);">
                  <strong class="full" style="font-size:0.82rem;grid-column:1/-1;">Company Letterhead Stationery</strong>
                  <label><span class="label-heading">First Page Letterhead</span><select id="cfg-first-page-asset">${assetOptions.map(([id, title]) => `<option value="${id}" ${backgroundConfig?.firstPageAssetId === id ? 'selected' : ''}>${escape(title)}</option>`).join('')}</select></label>
                  <label><span class="label-heading">Continuation Pages Letterhead</span><select id="cfg-continuation-asset">${assetOptions.map(([id, title]) => `<option value="${id}" ${backgroundConfig?.continuationAssetId === id ? 'selected' : ''}>${escape(title)}</option>`).join('')}</select></label>
                  <div class="full" style="display:flex;align-items:center;justify-content:space-between;padding-top:4px;">
                    <span class="muted" style="font-size:0.76rem;">Upload new stationery directly into this template:</span>
                    <div>
                      <input type="file" id="studio-quick-upload-file" accept=".png,.jpg,.jpeg,.pdf,.docx" style="display:none;">
                      <button type="button" class="secondary" id="btn-studio-upload-asset" style="font-size:0.78rem;padding:4px 10px;">+ Upload Letterhead File</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Tab 3: Dynamic Variables & Simulator -->
            <div id="tab-pane-variables" style="display:none;">
              <div class="variable-palette">
                <div class="variable-palette-header">
                  <strong style="font-size:0.84rem;">Dynamic Variables Registry (Click to copy & insert into active field)</strong>
                  <input type="text" id="var-search-filter" placeholder="Filter variables..." style="font-size:0.75rem;padding:4px 8px;max-width:180px;">
                </div>
                <div class="variable-chip-group" id="studio-var-chips">
                  ${Object.entries(categorizedVars).map(([cat, list]) => `
                    <div class="var-category-block" style="width:100%;margin-top:6px;" data-cat="${escape(cat.toLowerCase())}">
                      <small class="muted" style="font-weight:700;text-transform:uppercase;font-size:0.68rem;">${escape(cat)}</small>
                      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;">
                        ${list.map(v => `<button type="button" class="var-pill-btn" data-var="{{${v.key}}}" title="${escape(v.description)}">{{${v.key}}}</button>`).join('')}
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>

              <div style="margin-top:14px;background:var(--surface-alt);border:1px solid var(--line);border-radius:10px;padding:12px 14px;">
                <strong style="font-size:0.82rem;display:block;margin-bottom:8px;">Live Simulator Test Data (Affects Right Preview)</strong>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                  <label><span class="label-heading">Test Candidate Name</span><input type="text" id="sim-cand-name" value="Raman Joshi"></label>
                  <label><span class="label-heading">Test Designation</span><input type="text" id="sim-designation" value="Senior Full-Stack Engineer"></label>
                  <label><span class="label-heading">Test Annual CTC</span><input type="text" id="sim-salary" value="2,400,000"></label>
                  <label><span class="label-heading">Currency</span><input type="text" id="sim-currency" value="INR"></label>
                </div>
              </div>
            </div>
          </div>

          <!-- Right Live Preview Column -->
          <div class="offer-studio-preview">
            <div class="offer-studio-preview-head">
              <div>
                <strong style="font-size:0.92rem;">Document Preview</strong>
                <p id="studio-preview-meta" class="muted" style="margin:2px 0 0;font-size:0.76rem;">Generating real-time multi-page layout...</p>
              </div>
              <div class="studio-preview-actions">
                <a id="btn-studio-open-pdf" href="#" target="_blank" class="button secondary studio-preview-btn">Open in Tab</a>
                <a id="btn-studio-download-pdf" href="#" download="offer_letter.pdf" class="button secondary studio-preview-btn">Download PDF</a>
                <button type="button" class="secondary studio-preview-btn" id="btn-studio-force-refresh">Refresh</button>
              </div>
            </div>

            <div id="studio-preview-validation" style="margin-bottom:10px;"></div>

            <div id="studio-pdf-canvas" class="offer-studio-preview-frame-wrap" style="display:flex;">
              <iframe id="studio-preview-iframe" class="offer-studio-preview-iframe" title="Real-time A4 PDF Preview"></iframe>
            </div>
          </div>
        </div>
      </div>
    `;

    modal(templateId ? `Offer Letter Studio — ${tpl.name}` : 'Offer Letter Studio — New Template', editorHtml, null, {
      actions: `<div></div>`
    });

    const syncSectionsFromDom = () => {
      const container = $('#studio-sections-list');
      if (!container) return;
      container.querySelectorAll('.studio-section-card').forEach(itemEl => {
        const i = Number(itemEl.dataset.idx);
        const s = currentSections[i];
        if (!s) return;
        if (s.type === 'heading') {
          s.level = Number(itemEl.querySelector('[data-field="level"]')?.value) || 2;
          s.align = itemEl.querySelector('[data-field="align"]')?.value || 'left';
          s.text = itemEl.querySelector('[data-field="text"]')?.value || '';
        } else if (s.type === 'paragraph') {
          s.fontSize = Number(itemEl.querySelector('[data-field="fontSize"]')?.value) || 10;
          s.bold = itemEl.querySelector('[data-field="bold"]')?.value === 'true';
          s.align = itemEl.querySelector('[data-field="align"]')?.value || 'left';
          s.text = itemEl.querySelector('[data-field="text"]')?.value || '';
        } else if (s.type === 'bullet_list' || s.type === 'numbered_list') {
          s.listType = itemEl.querySelector('[data-field="listType"]')?.value || 'bullet';
          s.items = (itemEl.querySelector('[data-field="items"]')?.value || '').split('\n').map(x => x.trim()).filter(Boolean);
        } else if (s.type === 'key_value') {
          const lines = (itemEl.querySelector('[data-field="pairs"]')?.value || '').split('\n');
          s.pairs = lines.filter(Boolean).map(line => {
            const p = line.split(':');
            return { key: p[0]?.trim() || '', value: p.slice(1).join(':')?.trim() || '' };
          });
        } else if (s.type === 'salary_annexure') {
          s.title = itemEl.querySelector('[data-field="title"]')?.value || 'DETAILED REMUNERATION STRUCTURE';
        } else if (s.type === 'signature_block') {
          s.authorizerName = itemEl.querySelector('[data-field="authorizerName"]')?.value || '';
          s.authorizerTitle = itemEl.querySelector('[data-field="authorizerTitle"]')?.value || '';
          s.signerName = itemEl.querySelector('[data-field="signerName"]')?.value || '';
        }
      });

      const mTop = Math.max(0, Number($('#cfg-margin-top')?.value) || 0);
      const mBottom = Math.max(0, Number($('#cfg-margin-bottom')?.value) || 0);
      const mLeft = Math.max(0, Number($('#cfg-margin-left')?.value) || 0);
      const mRight = Math.max(0, Number($('#cfg-margin-right')?.value) || 0);

      pageConfig = {
        ...pageConfig,
        size: 'A4', orientation: 'portrait',
        marginTop: mTop,
        marginBottom: mBottom,
        marginLeft: mLeft,
        marginRight: mRight,
        margins: {
          top: mTop,
          bottom: mBottom,
          left: mLeft,
          right: mRight
        }
      };

      headerConfig = {
        enabled: true,
        text: $('#cfg-header-text')?.value || '',
        showOnFirstPage: Boolean($('#cfg-header-first-page')?.checked)
      };

      footerConfig = {
        enabled: true,
        text: $('#cfg-footer-text')?.value || 'Strictly Private & Confidential',
        pageNumberFormat: 'Page {page} of {pages}'
      };

      backgroundConfig = {
        firstPageAssetId: $('#cfg-first-page-asset')?.value || '',
        continuationAssetId: $('#cfg-continuation-asset')?.value || ''
      };
    };

    let previewDebounce = null;
    const debouncedPreview = (delay = 120) => {
      clearTimeout(previewDebounce);
      previewDebounce = setTimeout(triggerLivePreview, delay);
    };

    let previewSequence = 0;
    const triggerLivePreview = async () => {
      const currentSeq = ++previewSequence;
      syncSectionsFromDom();
      const metaEl = $('#studio-preview-meta');
      const valEl = $('#studio-preview-validation');
      const iframe = $('#studio-preview-iframe');
      const openLink = $('#btn-studio-open-pdf');
      if (metaEl) metaEl.textContent = 'Updating live preview...';

      try {
        const simSalary = $('#sim-salary')?.value || '2,400,000';
        const simCurr = $('#sim-currency')?.value || 'INR';

        const previewData = await api(`offer-templates/${templateId || 'preview'}/preview`, 'POST', {
          customSections: currentSections,
          pageConfig,
          page_config: pageConfig,
          headerConfig,
          header_config: headerConfig,
          footerConfig,
          footer_config: footerConfig,
          backgroundConfig,
          background_config: backgroundConfig,
          offerData: {
            salary: simSalary,
            currency: simCurr,
            start_date: 'Two weeks following signature acceptance'
          },
          customVariables: {
            'candidate.name': $('#sim-cand-name')?.value || 'Raman Joshi',
            'employment.designation': $('#sim-designation')?.value || 'Senior Full-Stack Engineer'
          }
        });

        if (metaEl) {
          metaEl.textContent = `${previewData.totalPages} Page(s) • ${(previewData.pdfSize / 1024).toFixed(1)} KB • A4 Portrait`;
        }

        if (valEl) {
          const rawMissing = previewData.validation?.missing || previewData.validation?.missingRequired || [];
          const missingList = rawMissing.map(m => typeof m === 'string' ? m : (m.key || m.label || String(m))).filter(Boolean);
          if (missingList.length === 0) {
            valEl.innerHTML = `<div class="validation-box valid" style="padding:6px 10px;font-size:0.75rem;"><span style="font-weight:600;">Ready for Issuance:</span> All dynamic placeholders resolved.</div>`;
          } else {
            valEl.innerHTML = `<div class="validation-box" style="padding:6px 10px;font-size:0.75rem;"><span style="font-weight:600;">Missing Placeholders (${missingList.length}):</span> <span style="font-family:monospace;">${missingList.join(', ')}</span></div>`;
          }
        }

        if (typeof currentSeq !== 'undefined' && currentSeq !== previewSequence) return;
        if (iframe && previewData.pdfBase64) {
          if (iframe._currentBlobUrl) {
            try { URL.revokeObjectURL(iframe._currentBlobUrl); } catch {}
          }
          const blobUrl = pdfBase64ToBlobUrl(previewData.pdfBase64);
          iframe._currentBlobUrl = blobUrl;
          const targetUrl = blobUrl || `data:application/pdf;base64,${previewData.pdfBase64}`;
          iframe.src = targetUrl + '#toolbar=0&navpanes=0';
          if (openLink) openLink.href = targetUrl;
          const dlLink = $('#btn-studio-download-pdf');
          if (dlLink) dlLink.href = targetUrl;
        }
      } catch (err) {
        if (metaEl) metaEl.textContent = `Preview error: ${err.message}`;
      }
    };

    let lastActiveSectionIdx = null;

    const updateActiveCardClass = () => {
      const container = $('#studio-sections-list');
      if (!container) return;
      container.querySelectorAll('.studio-section-card').forEach(card => {
        const idx = Number(card.dataset.idx);
        if (idx === lastActiveSectionIdx) {
          card.classList.add('is-active');
        } else {
          card.classList.remove('is-active');
        }
      });
    };

    const renderSections = () => {
      const container = $('#studio-sections-list');
      if (!container) return;
      container.innerHTML = currentSections.map((s, idx) => {
        let fieldsHtml = '';
        if (s.type === 'heading') {
          fieldsHtml = `
            <div style="display:flex;flex-direction:column;gap:8px;">
              <div class="studio-formatting-bar">
                <span class="studio-format-label">Level</span>
                <div class="studio-format-group">
                  <button type="button" class="studio-format-btn ${s.level === 1 ? 'active' : ''}" data-fmt="level" data-val="1" data-idx="${idx}">H1</button>
                  <button type="button" class="studio-format-btn ${s.level === 2 || !s.level ? 'active' : ''}" data-fmt="level" data-val="2" data-idx="${idx}">H2</button>
                  <button type="button" class="studio-format-btn ${s.level === 3 ? 'active' : ''}" data-fmt="level" data-val="3" data-idx="${idx}">H3</button>
                </div>
                <input type="hidden" data-field="level" value="${s.level || 2}">
                <span class="studio-format-label" style="margin-left:8px;">Align</span>
                <div class="studio-format-group">
                  <button type="button" class="studio-format-btn ${s.align === 'left' || !s.align ? 'active' : ''}" data-fmt="align" data-val="left" data-idx="${idx}">Left</button>
                  <button type="button" class="studio-format-btn ${s.align === 'center' ? 'active' : ''}" data-fmt="align" data-val="center" data-idx="${idx}">Center</button>
                  <button type="button" class="studio-format-btn ${s.align === 'right' ? 'active' : ''}" data-fmt="align" data-val="right" data-idx="${idx}">Right</button>
                </div>
                <input type="hidden" data-field="align" value="${s.align || 'left'}">
              </div>
              <input type="text" data-field="text" data-idx="${idx}" value="${escape(s.text || '')}" placeholder="Section Heading Text..." style="font-weight:600;">
            </div>
          `;
        } else if (s.type === 'paragraph') {
          fieldsHtml = `
            <div style="display:flex;flex-direction:column;gap:8px;">
              <div class="studio-formatting-bar">
                <span class="studio-format-label">Size</span>
                <div class="studio-format-group">
                  <button type="button" class="studio-format-btn ${s.fontSize === 8.5 ? 'active' : ''}" data-fmt="fontSize" data-val="8.5" data-idx="${idx}">8.5pt</button>
                  <button type="button" class="studio-format-btn ${s.fontSize === 9 ? 'active' : ''}" data-fmt="fontSize" data-val="9" data-idx="${idx}">9pt</button>
                  <button type="button" class="studio-format-btn ${s.fontSize === 10 || !s.fontSize ? 'active' : ''}" data-fmt="fontSize" data-val="10" data-idx="${idx}">10pt</button>
                  <button type="button" class="studio-format-btn ${s.fontSize === 11 ? 'active' : ''}" data-fmt="fontSize" data-val="11" data-idx="${idx}">11pt</button>
                </div>
                <input type="hidden" data-field="fontSize" value="${s.fontSize || 10}">
                <div class="studio-format-group" style="margin-left:4px;">
                  <button type="button" class="studio-format-btn ${s.bold ? 'active' : ''}" data-fmt="bold" data-val="${s.bold ? 'false' : 'true'}" data-idx="${idx}" style="font-weight:700;">Bold</button>
                </div>
                <input type="hidden" data-field="bold" value="${s.bold ? 'true' : 'false'}">
                <span class="studio-format-label" style="margin-left:8px;">Align</span>
                <div class="studio-format-group">
                  <button type="button" class="studio-format-btn ${s.align === 'left' || !s.align ? 'active' : ''}" data-fmt="align" data-val="left" data-idx="${idx}">Left</button>
                  <button type="button" class="studio-format-btn ${s.align === 'center' ? 'active' : ''}" data-fmt="align" data-val="center" data-idx="${idx}">Center</button>
                </div>
                <input type="hidden" data-field="align" value="${s.align || 'left'}">
              </div>
              <textarea data-field="text" data-idx="${idx}" rows="4" style="font-size:0.85rem;line-height:1.45;" placeholder="Enter legal clause, terms, or paragraph with {{variables}}...">${escape(s.text || '')}</textarea>
            </div>
          `;
        } else if (s.type === 'bullet_list' || s.type === 'numbered_list') {
          fieldsHtml = `
            <div style="display:flex;flex-direction:column;gap:8px;">
              <div class="studio-formatting-bar">
                <span class="studio-format-label">Style</span>
                <div class="studio-format-group">
                  <button type="button" class="studio-format-btn ${s.listType !== 'numbered' ? 'active' : ''}" data-fmt="listType" data-val="bullet" data-idx="${idx}">Bullets</button>
                  <button type="button" class="studio-format-btn ${s.listType === 'numbered' ? 'active' : ''}" data-fmt="listType" data-val="numbered" data-idx="${idx}">Numbered</button>
                </div>
                <input type="hidden" data-field="listType" value="${s.listType || 'bullet'}">
              </div>
              <textarea data-field="items" data-idx="${idx}" rows="3" style="font-size:0.85rem;" placeholder="List items (one line per item)...">${escape((s.items || []).join('\n'))}</textarea>
            </div>
          `;
        } else if (s.type === 'key_value') {
          const pairsStr = (s.pairs || []).map(p => `${p.key} : ${p.value}`).join('\n');
          fieldsHtml = `
            <textarea data-field="pairs" data-idx="${idx}" rows="3" style="font-size:0.85rem;" placeholder="Key : Value (e.g. Work Location : {{employment.location}})...">${escape(pairsStr)}</textarea>
          `;
        } else if (s.type === 'salary_annexure') {
          fieldsHtml = `
            <input type="text" data-field="title" data-idx="${idx}" value="${escape(s.title || 'DETAILED REMUNERATION STRUCTURE')}">
            <small class="muted" style="display:block;margin-top:4px;">Generates verified payroll breakdown matching HRMS conventions (Basic, HRA, PF, Gratuity, Allowances, Gross, Deductions, CTC).</small>
          `;
        } else if (s.type === 'signature_block') {
          fieldsHtml = `
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
              <label><span class="label-heading">Authorizer Name</span><input type="text" data-field="authorizerName" data-idx="${idx}" value="${escape(s.authorizerName || '{{signature.authorizer_name}}')}"></label>
              <label><span class="label-heading">Authorizer Title</span><input type="text" data-field="authorizerTitle" data-idx="${idx}" value="${escape(s.authorizerTitle || 'Managing Director')}"></label>
              <label><span class="label-heading">Candidate Signer</span><input type="text" data-field="signerName" data-idx="${idx}" value="${escape(s.signerName || '{{signature.signer_name}}')}"></label>
            </div>
          `;
        } else if (s.type === 'page_break') {
          fieldsHtml = `<div class="muted" style="font-size:0.78rem;padding:4px 0;">Page Break: Content following this section begins on a new page.</div>`;
        } else if (s.type === 'divider') {
          fieldsHtml = `<div class="muted" style="font-size:0.78rem;padding:4px 0;">Horizontal Rule: Visual divider line.</div>`;
        }

        const badgeClass = `studio-badge-${s.type}`;
        const isActiveClass = idx === lastActiveSectionIdx ? ' is-active' : '';
        return `
          <div class="studio-section-card${isActiveClass}" data-idx="${idx}">
            <div class="studio-section-header">
              <div class="studio-sec-title-group">
                <span class="studio-section-badge ${badgeClass}">${s.type.replace('_', ' ')}</span>
                <strong class="studio-sec-num">Section #${idx + 1}</strong>
              </div>
              <div class="studio-sec-actions">
                <button type="button" class="studio-action-btn" data-sec-act="up" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''} title="Move Up">Up</button>
                <button type="button" class="studio-action-btn" data-sec-act="down" data-idx="${idx}" ${idx === currentSections.length - 1 ? 'disabled' : ''} title="Move Down">Down</button>
                <button type="button" class="studio-action-btn" data-sec-act="clone" data-idx="${idx}" title="Duplicate Section">Duplicate</button>
                <button type="button" class="studio-action-btn studio-action-delete" data-sec-act="del" data-idx="${idx}" title="Remove Section">Remove</button>
              </div>
            </div>
            ${fieldsHtml}
          </div>
        `;
      }).join('');

      container.querySelectorAll('.studio-section-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('[data-sec-act]')) return;
          lastActiveSectionIdx = Number(card.dataset.idx);
          updateActiveCardClass();
        });
      });

      container.querySelectorAll('textarea, input').forEach(el => {
        el.onfocus = () => {
          lastActiveField = el;
          const card = el.closest('.studio-section-card');
          if (card && card.dataset.idx !== undefined) {
            lastActiveSectionIdx = Number(card.dataset.idx);
            updateActiveCardClass();
          }
        };
        el.oninput = () => { syncSectionsFromDom(); debouncedPreview(120); };
        el.onchange = () => { syncSectionsFromDom(); triggerLivePreview(); };
      });

      container.querySelectorAll('[data-fmt]').forEach(btn => {
        btn.onclick = () => {
          const idx = Number(btn.dataset.idx);
          const fmt = btn.dataset.fmt;
          const val = btn.dataset.val;
          const card = btn.closest('.studio-section-card');
          const hiddenInput = card?.querySelector(`[data-field="${fmt}"]`);
          if (hiddenInput) {
            hiddenInput.value = val;
            lastActiveSectionIdx = idx;
            syncSectionsFromDom();
            renderSections();
            debouncedPreview(50);
          }
        };
      });

      container.querySelectorAll('[data-sec-act]').forEach(btn => {
        btn.onclick = () => {
          syncSectionsFromDom();
          const act = btn.dataset.secAct;
          const i = Number(btn.dataset.idx);
          if (act === 'up' && i > 0) {
            const temp = currentSections[i];
            currentSections[i] = currentSections[i - 1];
            currentSections[i - 1] = temp;
            lastActiveSectionIdx = i - 1;
          } else if (act === 'down' && i < currentSections.length - 1) {
            const temp = currentSections[i];
            currentSections[i] = currentSections[i + 1];
            currentSections[i + 1] = temp;
            lastActiveSectionIdx = i + 1;
          } else if (act === 'clone') {
            const clone = JSON.parse(JSON.stringify(currentSections[i]));
            clone.id = `sec_${Date.now()}`;
            currentSections.splice(i + 1, 0, clone);
            lastActiveSectionIdx = i + 1;
          } else if (act === 'del') {
            currentSections.splice(i, 1);
            lastActiveSectionIdx = currentSections.length ? Math.min(i, currentSections.length - 1) : null;
          }
          renderSections();
          debouncedPreview(50);
        };
      });
    };

    renderSections();
    triggerLivePreview();

    // Studio tabs wiring
    document.querySelectorAll('.offer-studio-tab-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.offer-studio-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        $('#tab-pane-sections').style.display = tab === 'sections' ? 'block' : 'none';
        $('#tab-pane-branding').style.display = tab === 'branding' ? 'block' : 'none';
        $('#tab-pane-variables').style.display = tab === 'variables' ? 'block' : 'none';
      };
    });

    // Variable insertion pills
    document.querySelectorAll('.var-pill-btn').forEach(btn => {
      btn.onclick = () => {
        const varTag = btn.dataset.var;
        if (navigator.clipboard) navigator.clipboard.writeText(varTag);
        notice(`Copied ${varTag} to clipboard!`, 'success');
        if (lastActiveField) {
          const start = lastActiveField.selectionStart ?? lastActiveField.value.length;
          const end = lastActiveField.selectionEnd ?? lastActiveField.value.length;
          const val = lastActiveField.value;
          lastActiveField.value = val.substring(0, start) + varTag + val.substring(end);
          lastActiveField.selectionStart = lastActiveField.selectionEnd = start + varTag.length;
          lastActiveField.focus();
          syncSectionsFromDom();
          debouncedPreview();
        }
      };
    });

    // Variable search filter
    const varFilterInput = $('#var-search-filter');
    if (varFilterInput) {
      varFilterInput.oninput = () => {
        const q = varFilterInput.value.toLowerCase().trim();
        document.querySelectorAll('#studio-var-chips .var-pill-btn').forEach(b => {
          const match = !q || b.textContent.toLowerCase().includes(q) || b.title.toLowerCase().includes(q);
          b.style.display = match ? 'inline-block' : 'none';
        });
      };
    }

    const getTargetInsertIndex = () => {
      if (lastActiveSectionIdx !== null && lastActiveSectionIdx >= 0 && lastActiveSectionIdx < currentSections.length) {
        return lastActiveSectionIdx + 1;
      }
      const editor = $('.offer-studio-editor');
      const cards = $('#studio-sections-list')?.querySelectorAll('.studio-section-card');
      if (editor && cards && cards.length) {
        const editorRect = editor.getBoundingClientRect();
        for (const card of cards) {
          const cardRect = card.getBoundingClientRect();
          if (cardRect.bottom > editorRect.top + 90) {
            const idx = Number(card.dataset.idx);
            if (!isNaN(idx)) return idx + 1;
          }
        }
      }
      return currentSections.length;
    };

    // Add quick section toolbar
    document.querySelectorAll('[data-add-sec]').forEach(btn => {
      btn.onclick = () => {
        syncSectionsFromDom();
        const type = btn.dataset.addSec;
        const newSec = { id: `sec_${Date.now()}`, type };
        if (type === 'heading') { newSec.level = 2; newSec.text = 'New Section Heading'; newSec.align = 'left'; }
        else if (type === 'paragraph') { newSec.text = 'Enter terms or clauses here. Placeholders like {{candidate.name}} are supported.'; newSec.fontSize = 10; newSec.align = 'left'; }
        else if (type === 'bullet_list') { newSec.items = ['Item 1', 'Item 2']; newSec.listType = 'bullet'; }
        else if (type === 'key_value') { newSec.pairs = [{ key: 'Designation', value: '{{employment.designation}}' }]; }
        else if (type === 'salary_annexure') { newSec.title = 'DETAILED COMPENSATION BREAKDOWN'; }
        else if (type === 'signature_block') {
          newSec.authorizerName = '{{signature.authorizer_name}}';
          newSec.authorizerTitle = 'Managing Director';
          newSec.signerName = '{{signature.signer_name}}';
        } else if (type === 'page_break') {
          newSec.text = '';
        } else if (type === 'divider') {
          newSec.text = '';
        }

        const insertIdx = getTargetInsertIndex();
        currentSections.splice(insertIdx, 0, newSec);
        lastActiveSectionIdx = insertIdx;
        renderSections();
        debouncedPreview(50);

        requestAnimationFrame(() => {
          const container = $('#studio-sections-list');
          const newCard = container?.querySelector(`.studio-section-card[data-idx="${insertIdx}"]`);
          if (newCard) {
            newCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            const input = newCard.querySelector('input[type=text], textarea');
            if (input) input.focus();
          }
        });
      };
    });

    // Pre-built clause library trigger
    const openLibrary = () => {
      openClauseLibraryModal(clauseSections => {
        syncSectionsFromDom();
        const insertIdx = getTargetInsertIndex();
        currentSections.splice(insertIdx, 0, ...clauseSections);
        lastActiveSectionIdx = insertIdx + clauseSections.length - 1;
        renderSections();
        debouncedPreview(50);
        requestAnimationFrame(() => {
          const container = $('#studio-sections-list');
          const firstNewCard = container?.querySelector(`.studio-section-card[data-idx="${insertIdx}"]`);
          if (firstNewCard) {
            firstNewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        });
      });
    };
    const libBtn1 = $('#btn-studio-clause-lib');
    const libBtn2 = $('#btn-studio-add-prebuilt');
    if (libBtn1) libBtn1.onclick = openLibrary;
    if (libBtn2) libBtn2.onclick = openLibrary;

    // Refresh preview buttons
    const refBtn1 = $('#btn-studio-refresh-preview');
    const refBtn2 = $('#btn-studio-force-refresh');
    if (refBtn1) refBtn1.onclick = triggerLivePreview;
    if (refBtn2) refBtn2.onclick = triggerLivePreview;

    // Wire asset select changes to live preview
    const selFirst = $('#cfg-first-page-asset');
    const selCont = $('#cfg-continuation-asset');
    if (selFirst) selFirst.onchange = triggerLivePreview;
    if (selCont) selCont.onchange = triggerLivePreview;

    // Wire all margin, header/footer, and simulator inputs for instant live preview
    const wireInstantInput = (selector, immediate = false) => {
      const el = $(selector);
      if (!el) return;
      el.addEventListener('input', () => {
        syncSectionsFromDom();
        if (immediate) triggerLivePreview();
        else debouncedPreview(120);
      });
      el.addEventListener('change', () => {
        syncSectionsFromDom();
        triggerLivePreview();
      });
    };

    wireInstantInput('#cfg-margin-top', true);
    wireInstantInput('#cfg-margin-bottom', true);
    wireInstantInput('#cfg-margin-left', true);
    wireInstantInput('#cfg-margin-right', true);
    wireInstantInput('#cfg-header-text');
    wireInstantInput('#cfg-footer-text');
    wireInstantInput('#cfg-header-first-page', true);
    wireInstantInput('#sim-cand-name');
    wireInstantInput('#sim-designation');
    wireInstantInput('#sim-salary');
    wireInstantInput('#sim-currency');

    // Quick upload letterhead directly in studio without destroying template modal
    const uploadAssetBtn = $('#btn-studio-upload-asset');
    const quickFileInput = $('#studio-quick-upload-file');
    if (uploadAssetBtn && quickFileInput) {
      uploadAssetBtn.onclick = () => quickFileInput.click();
      quickFileInput.onchange = async () => {
        const file = quickFileInput.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
          notice('File exceeds maximum upload size of 10MB.', 'error');
          quickFileInput.value = '';
          return;
        }
        uploadAssetBtn.disabled = true;
        uploadAssetBtn.textContent = 'Uploading...';
        try {
          const base64 = await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload = () => {
              const r = reader.result;
              res(String(r).split(',')[1] || String(r));
            };
            reader.onerror = () => rej(new Error('Failed to read file.'));
            reader.readAsDataURL(file);
          });
          const newAsset = await api('offer-letter-assets', 'POST', {
            name: file.name.replace(/\.[^/.]+$/, ''),
            filename: file.name,
            fileBase64: base64,
            scaling: 'fit',
            pageTarget: 'all'
          });
          const optLabel = `${newAsset.name || newAsset.filename} (${(newAsset.format || newAsset.file_format || 'IMG').toUpperCase()})`;
          if (selFirst) {
            const opt = document.createElement('option');
            opt.value = newAsset.id;
            opt.textContent = optLabel;
            selFirst.appendChild(opt);
            selFirst.value = newAsset.id;
            backgroundConfig.firstPageAssetId = newAsset.id;
          }
          if (selCont) {
            const opt = document.createElement('option');
            opt.value = newAsset.id;
            opt.textContent = optLabel;
            selCont.appendChild(opt);
          }
          notice('Letterhead uploaded and applied to first page!', 'success');
          triggerLivePreview();
        } catch (err) {
          notice(err.message, 'error');
        } finally {
          uploadAssetBtn.disabled = false;
          uploadAssetBtn.textContent = '+ Upload Letterhead File';
          quickFileInput.value = '';
        }
      };
    }

    // Save button
    const saveBtn = $('#btn-studio-save-tpl');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        syncSectionsFromDom();
        const name = String($('#studio-tpl-name')?.value || '').trim();
        if (!name) {
          notice('Template title is required.', 'error');
          $('#studio-tpl-name')?.focus();
          return;
        }
        if (!currentSections.length) {
          notice('At least one content section is required.', 'error');
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
          const body = {
            name,
            description: tpl?.description || 'Company branded offer letter with multi-page terms and salary annexure',
            status: $('#studio-tpl-status')?.value || 'draft',
            is_default: $('#studio-tpl-default')?.checked ? 1 : 0,
            page_config: pageConfig,
            header_config: headerConfig,
            footer_config: footerConfig,
            background_config: backgroundConfig,
            sections: currentSections
          };

          if (templateId) {
            await api(`offer-templates/${templateId}`, 'PUT', body);
            notice('Offer template updated successfully.', 'success');
          } else {
            await api('offer-templates', 'POST', body);
            notice('Offer template created successfully.', 'success');
          }

          const closeBtn = $('#close-modal');
          if (closeBtn) closeBtn.click();
          await render();
        } catch (err) {
          notice(err.message, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = templateId ? 'Save Version' : 'Create Template';
        }
      };
    }
  } catch (err) {
    notice(err.message, 'error');
  }
}

// ==========================================================================
// Pre-Onboarding Training Plans: Client Functions & Review Modals
// ==========================================================================

function renderTrainingPlanPreviewHtml(vars, sections = [], links = [], supportContact = {}) {
  const replaceVars = str => String(str || '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, k) => escape(vars[k] ?? ''));
  const candidateName = escape(vars['candidate.name'] || 'Alex Johnson');
  const position = escape(vars['employment.designation'] || vars['requisition.title'] || 'Software Engineer');
  const planName = replaceVars(vars['training.plan_name'] || 'Pre-Onboarding Training Plan');
  const duration = replaceVars(vars['training.duration'] || '2 Weeks');
  const subject = replaceVars(vars.subject || `Pre-Onboarding Training Plan: ${position}`);
  const intro = replaceVars(vars.introduction || 'Welcome to Mechlin! We have prepared this pre-onboarding training plan to support your preparation prior to your start date.');
  const objectives = replaceVars(vars.objectives || '');

  const sectionsHtml = (sections || []).map((s, idx) => `
    <div style="margin-bottom:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
      <h3 style="margin-top:0;margin-bottom:8px;font-size:14px;font-weight:600;color:#0f172a;">${replaceVars(s.title || `Section ${idx + 1}`)}</h3>
      <p style="margin:0;font-size:13px;color:#334155;line-height:1.5;white-space:pre-wrap;">${replaceVars(s.content || '')}</p>
    </div>
  `).join('');

  const linksHtml = (links || []).length ? `
    <div style="margin-top:20px;">
      <h4 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;margin-bottom:10px;">Recommended Learning Links & Resources</h4>
      ${(links || []).map(l => `
        <div style="margin-bottom:8px;padding:10px 12px;background:#ffffff;border:1px solid #cbd5e1;border-radius:6px;">
          <a href="${escape(l.url||'#')}" target="_blank" rel="noopener noreferrer" style="font-weight:600;color:#0284c7;text-decoration:none;font-size:13px;">${escape(l.title || l.url)} &rarr;</a>
          ${l.description ? `<p style="margin:4px 0 0;font-size:12px;color:#475569;">${escape(l.description)}</p>` : ''}
        </div>
      `).join('')}
    </div>
  ` : '';

  const supName = escape(supportContact.name || vars['support.contact_name'] || 'The Mechlin Talent Team');
  const supEmail = escape(supportContact.email || vars['support.contact_email'] || 'hr@mechlintech.com');

  return `
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;max-width:580px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
      <div style="background:#0f172a;padding:20px 24px;color:#ffffff;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <span style="font-size:18px;font-weight:700;letter-spacing:-0.5px;">Orbit</span>
          <span style="font-size:13px;color:#cbd5e1;margin-left:8px;">&middot; Pre-Onboarding Preparation</span>
        </div>
        <span style="font-size:11px;background:#334155;color:#e2e8f0;padding:2px 8px;border-radius:4px;text-transform:uppercase;">Confidential</span>
      </div>
      <div style="padding:24px;">
        <h2 style="font-size:17px;font-weight:700;color:#0f172a;margin-top:0;margin-bottom:14px;">${subject}</h2>
        <p style="font-size:14px;margin-bottom:14px;line-height:1.5;">Dear ${candidateName},</p>
        <p style="font-size:14px;margin-bottom:16px;line-height:1.5;color:#334155;">${intro}</p>
        <div style="background:#f1f5f9;border-radius:6px;padding:12px 14px;margin:16px 0;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div><small class="muted" style="display:block;font-size:11px;text-transform:uppercase;">Role / Position</small><strong style="font-size:13px;">${position}</strong></div>
          ${duration ? `<div><small class="muted" style="display:block;font-size:11px;text-transform:uppercase;">Duration</small><span class="badge" style="background:#e0e7ff;color:#3730a3;font-size:12px;font-weight:600;">${duration}</span></div>` : ''}
        </div>
        ${objectives ? `
          <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:4px;padding:12px 14px;margin:16px 0;">
            <h4 style="margin:0 0 6px 0;font-size:13px;font-weight:700;color:#1e40af;">Training Objectives & Learning Outcomes</h4>
            <div style="font-size:13px;color:#1e3a8a;line-height:1.5;white-space:pre-wrap;">${objectives}</div>
          </div>
        ` : ''}
        ${sectionsHtml}
        ${linksHtml}
        <div style="margin-top:24px;padding:12px 14px;background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0;font-size:12px;color:#475569;">
          <strong>Need Assistance?</strong> Your onboarding coordinator is <strong>${supName}</strong> (<a href="mailto:${supEmail}" style="color:#0284c7;">${supEmail}</a>).
        </div>
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:13px;color:#475569;">
          Warm regards,<br>
          <strong>The Mechlin Talent Acquisition Team</strong>
        </div>
      </div>
      <div style="background:#f1f5f9;padding:12px 24px;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0;">
        This email was sent to ${escape(vars['candidate.email'] || 'candidate@example.com')} regarding approved pre-onboarding training with Mechlin Technologies.
      </div>
    </div>
  `;
}

async function openTrainingTemplateEditor(templateId = null) {
  try {
    const tpl = templateId ? await api(`training-plans/templates/${templateId}`) : null;
    let sections = tpl ? JSON.parse(JSON.stringify(tpl.sections || [])) : [
      { id: 'sec-1', title: '1. Orientation & Workspace Setup', content: 'Install required runtime tools, configure version control credentials, and review development guides.', order: 1 },
      { id: 'sec-2', title: '2. Architecture & Codebase Guidelines', content: 'Review system design documentation, database schemas, coding standards, and test suites.', order: 2 }
    ];
    let links = tpl ? JSON.parse(JSON.stringify(tpl.learning_links || [])) : [
      { id: 'link-1', title: 'Official Documentation', url: 'https://nodejs.org/docs/latest/api/', description: 'Runtime and standard APIs' }
    ];

    const testVars = {
      'candidate.name': 'Alex Johnson',
      'candidate.first_name': 'Alex',
      'candidate.email': 'alex.johnson@example.com',
      'company.name': 'Mechlin Technologies',
      'requisition.title': 'Software Engineer',
      'employment.designation': 'Software Engineer',
      'requisition.department': 'Engineering',
      'training.duration': tpl?.duration_text || '2 Weeks',
      'support.contact_name': tpl?.support_contact?.name || 'Mechlin Talent Team',
      'support.contact_email': tpl?.support_contact?.email || 'hr@mechlintech.com'
    };

    const modalHtml = `
      <div class="training-studio">
        <div class="training-studio-header">
          <div class="training-studio-header-left">
            <input type="text" id="tpl-name" class="offer-studio-title-input" value="${escape(tpl?.name || 'New Training Plan')}" placeholder="Plan Name..." style="max-width:320px;">
            <select id="tpl-status" style="font-size:0.78rem;padding:4px 8px;min-height:28px;">
              <option value="active" ${tpl?.status === 'active' || !tpl ? 'selected' : ''}>Active</option>
              <option value="draft" ${tpl?.status === 'draft' ? 'selected' : ''}>Draft</option>
            </select>
            <label class="checkbox-row" style="font-size:0.78rem;margin:0;cursor:pointer;">
              <input type="checkbox" id="tpl-default" value="1" ${tpl?.is_default ? 'checked' : ''}>
              <span>Default Plan</span>
            </label>
          </div>
          <div class="training-studio-header-actions">
            <button type="button" id="btn-save-tpl" class="primary" style="font-size:0.8rem;padding:6px 16px;">${templateId ? 'Save Changes' : 'Create Plan'}</button>

          </div>
        </div>
        <div class="training-studio-layout">
          <!-- Left: Editor Pane -->
          <div class="training-studio-editor">
            <div>
              <label style="font-weight:600;font-size:0.82rem;">Internal Description</label>
              <input type="text" id="tpl-desc" value="${escape(tpl?.description || '')}" placeholder="Brief internal description of target audience and goals..." style="width:100%;margin-top:4px;">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div>
                <label style="font-weight:600;font-size:0.82rem;">Mapped Positions / Designations <small class="muted">(comma-separated)</small></label>
                <input type="text" id="tpl-positions" value="${escape((tpl?.positions || []).join(', '))}" placeholder="e.g. Software Engineer, Full Stack Developer" style="width:100%;margin-top:4px;">
              </div>
              <div>
                <label style="font-weight:600;font-size:0.82rem;">Mapped Departments & Roles <small class="muted">(comma-separated)</small></label>
                <input type="text" id="tpl-departments" value="${escape((tpl?.departments || []).join(', '))}" placeholder="e.g. Engineering, Product" style="width:100%;margin-top:4px;">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div>
                <label style="font-weight:600;font-size:0.82rem;">Suggested Duration</label>
                <input type="text" id="tpl-duration" value="${escape(tpl?.duration_text || '2 Weeks')}" placeholder="e.g. 2 Weeks, 10 business days" style="width:100%;margin-top:4px;">
              </div>
              <div>
                <label style="font-weight:600;font-size:0.82rem;">Support Contact Email</label>
                <input type="email" id="tpl-contact-email" value="${escape(tpl?.support_contact?.email || 'hr@mechlintech.com')}" style="width:100%;margin-top:4px;">
              </div>
            </div>
            <div>
              <label style="font-weight:600;font-size:0.82rem;">Candidate-Facing Email Subject</label>
              <input type="text" id="tpl-subject" value="${escape(tpl?.subject || 'Pre-Onboarding Training Plan: {{employment.designation}} at {{company.name}}')}" style="width:100%;margin-top:4px;">
              <div class="training-var-pills">
                <span class="muted" style="font-size:0.72rem;margin-right:4px;">Click to copy:</span>
                <span class="training-var-pill" data-var="{{candidate.name}}">{{candidate.name}}</span>
                <span class="training-var-pill" data-var="{{employment.designation}}">{{employment.designation}}</span>
                <span class="training-var-pill" data-var="{{requisition.department}}">{{requisition.department}}</span>
                <span class="training-var-pill" data-var="{{company.name}}">{{company.name}}</span>
                <span class="training-var-pill" data-var="{{training.duration}}">{{training.duration}}</span>
              </div>
            </div>
            <div>
              <label style="font-weight:600;font-size:0.82rem;">Candidate Introduction & Instructions</label>
              <textarea id="tpl-intro" rows="3" style="width:100%;margin-top:4px;font-size:0.85rem;">${escape(tpl?.introduction || 'Welcome to Mechlin! We have prepared this pre-onboarding technical training plan to support your preparation prior to your start date.')}</textarea>
            </div>
            <div>
              <label style="font-weight:600;font-size:0.82rem;">Training Objectives & Learning Outcomes</label>
              <textarea id="tpl-objectives" rows="3" style="width:100%;margin-top:4px;font-size:0.85rem;">${escape(tpl?.objectives || '• Configure and verify your development environment.\n• Review system architecture and API conventions.\n• Understand coding standards, testing practices, and security rules.')}</textarea>
            </div>
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <label style="font-weight:600;font-size:0.85rem;">Ordered Content Sections</label>
                <button type="button" class="secondary" id="btn-add-section" style="font-size:0.75rem;padding:3px 8px;">+ Add Section</button>
              </div>
              <div id="sections-container" style="display:flex;flex-direction:column;gap:10px;"></div>
            </div>
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <label style="font-weight:600;font-size:0.85rem;">External Learning Links</label>
                <button type="button" class="secondary" id="btn-add-link" style="font-size:0.75rem;padding:3px 8px;">+ Add Learning Link</button>
              </div>
              <div id="links-container" style="display:flex;flex-direction:column;gap:8px;"></div>
            </div>
          </div>
          <!-- Right: Live Preview Pane -->
          <div class="training-studio-preview">
            <div class="training-studio-preview-head">
              <span style="font-weight:600;font-size:0.85rem;color:var(--ink);">Real-Time Candidate Email Preview</span>
              <span class="muted" style="font-size:0.75rem;">Dynamic sample data interpolated</span>
            </div>
            <div class="training-studio-preview-frame-wrap" id="preview-render-box"></div>
          </div>
        </div>
      </div>
    `;

    $('#modal-body').innerHTML = modalHtml;
    $('#modal').showModal();

    const renderSections = () => {
      const container = $('#sections-container');
      if (!container) return;
      container.innerHTML = sections.map((s, idx) => `
        <div class="training-section-card" data-idx="${idx}">
          <div class="training-section-card-head">
            <span style="font-weight:600;font-size:0.8rem;color:var(--ink);">Section ${idx + 1}</span>
            <button type="button" class="secondary text-button btn-del-sec" data-idx="${idx}" style="color:var(--negative);font-size:0.75rem;">Remove</button>
          </div>
          <input type="text" class="sec-title-input" data-idx="${idx}" value="${escape(s.title || '')}" placeholder="Section Title..." style="font-weight:600;font-size:0.82rem;">
          <textarea class="sec-content-input" data-idx="${idx}" rows="2" placeholder="Section description, instructions, or curriculum steps..." style="font-size:0.8rem;">${escape(s.content || '')}</textarea>
        </div>
      `).join('') || '<p class="muted" style="font-size:0.8rem;">No content sections added yet. Click "+ Add Section".</p>';

      container.querySelectorAll('.btn-del-sec').forEach(btn => {
        btn.onclick = () => {
          const idx = Number(btn.dataset.idx);
          sections.splice(idx, 1);
          renderSections();
          updateLivePreview();
        };
      });
      container.querySelectorAll('.sec-title-input').forEach(inp => {
        inp.oninput = () => {
          sections[Number(inp.dataset.idx)].title = inp.value;
          updateLivePreview();
        };
      });
      container.querySelectorAll('.sec-content-input').forEach(inp => {
        inp.oninput = () => {
          sections[Number(inp.dataset.idx)].content = inp.value;
          updateLivePreview();
        };
      });
    };

    const renderLinks = () => {
      const container = $('#links-container');
      if (!container) return;
      container.innerHTML = links.map((l, idx) => `
        <div class="training-link-item" data-idx="${idx}">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <input type="text" class="link-title-input" data-idx="${idx}" value="${escape(l.title || '')}" placeholder="Resource Title..." style="font-weight:600;font-size:0.82rem;flex:1;margin-right:8px;">
            <button type="button" class="secondary text-button btn-del-link" data-idx="${idx}" style="color:var(--negative);font-size:0.75rem;">Remove</button>
          </div>
          <input type="url" class="link-url-input" data-idx="${idx}" value="${escape(l.url || '')}" placeholder="https://example.com/docs" style="font-size:0.8rem;">
          <input type="text" class="link-desc-input" data-idx="${idx}" value="${escape(l.description || '')}" placeholder="Optional link description..." style="font-size:0.78rem;">
        </div>
      `).join('') || '<p class="muted" style="font-size:0.8rem;">No external links added. Click "+ Add Learning Link".</p>';

      container.querySelectorAll('.btn-del-link').forEach(btn => {
        btn.onclick = () => {
          links.splice(Number(btn.dataset.idx), 1);
          renderLinks();
          updateLivePreview();
        };
      });
      container.querySelectorAll('.link-title-input').forEach(inp => {
        inp.oninput = () => { links[Number(inp.dataset.idx)].title = inp.value; updateLivePreview(); };
      });
      container.querySelectorAll('.link-url-input').forEach(inp => {
        inp.oninput = () => { links[Number(inp.dataset.idx)].url = inp.value; updateLivePreview(); };
      });
      container.querySelectorAll('.link-desc-input').forEach(inp => {
        inp.oninput = () => { links[Number(inp.dataset.idx)].description = inp.value; updateLivePreview(); };
      });
    };

    const updateLivePreview = () => {
      const box = $('#preview-render-box');
      if (!box) return;
      const currentVars = {
        ...testVars,
        'training.duration': $('#tpl-duration')?.value || '2 Weeks',
        subject: $('#tpl-subject')?.value || '',
        introduction: $('#tpl-intro')?.value || '',
        objectives: $('#tpl-objectives')?.value || ''
      };
      box.innerHTML = renderTrainingPlanPreviewHtml(currentVars, sections, links, { email: $('#tpl-contact-email')?.value });
    };

    renderSections();
    renderLinks();
    updateLivePreview();

    ['tpl-name', 'tpl-subject', 'tpl-intro', 'tpl-objectives', 'tpl-duration', 'tpl-contact-email'].forEach(id => {
      const el = $('#' + id);
      if (el) el.oninput = updateLivePreview;
    });

    $('#btn-add-section').onclick = () => {
      sections.push({ id: 'sec-' + Date.now(), title: `Section ${sections.length + 1}`, content: '', order: sections.length + 1 });
      renderSections();
      updateLivePreview();
    };
    $('#btn-add-link').onclick = () => {
      links.push({ id: 'link-' + Date.now(), title: '', url: 'https://', description: '' });
      renderLinks();
      updateLivePreview();
    };

    document.querySelectorAll('.training-var-pill').forEach(pill => {
      pill.onclick = () => {
        const v = pill.dataset.var;
        navigator.clipboard?.writeText(v);
        notice(`Copied ${v} to clipboard!`, 'success');
      };
    });

    $('#btn-save-tpl').onclick = async () => {
      const name = String($('#tpl-name')?.value || '').trim();
      const subject = String($('#tpl-subject')?.value || '').trim();
      if (!name) { notice('Plan name is required.', 'error'); return; }
      if (!subject) { notice('Candidate email subject is required.', 'error'); return; }

      const positions = String($('#tpl-positions')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
      const departments = String($('#tpl-departments')?.value || '').split(',').map(s => s.trim()).filter(Boolean);

      const payload = {
        name,
        description: $('#tpl-desc')?.value || '',
        status: $('#tpl-status')?.value || 'active',
        is_default: $('#tpl-default')?.checked ? 1 : 0,
        positions,
        departments,
        duration_text: $('#tpl-duration')?.value || '2 Weeks',
        subject,
        introduction: $('#tpl-intro')?.value || '',
        objectives: $('#tpl-objectives')?.value || '',
        sections,
        learning_links: links,
        support_contact: {
          email: $('#tpl-contact-email')?.value || 'hr@mechlintech.com'
        }
      };

      const btn = $('#btn-save-tpl');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        if (templateId) {
          await api(`training-plans/templates/${templateId}`, 'PUT', payload);
          notice('Training plan updated successfully.', 'success');
        } else {
          await api('training-plans/templates', 'POST', payload);
          notice('Training plan created successfully.', 'success');
        }
        closeModal();
        await render();
      } catch (err) {
        notice(err.message, 'error');
        btn.disabled = false;
        btn.textContent = templateId ? 'Save Changes' : 'Create Plan';
      }
    };
  } catch (err) {
    notice(err.message, 'error');
  }
}

async function openTrainingTemplatePreview(templateId) {
  try {
    const tpl = await api(`training-plans/templates/${templateId}`);
    const testVars = {
      'candidate.name': 'Alex Johnson',
      'candidate.first_name': 'Alex',
      'candidate.email': 'alex.johnson@example.com',
      'company.name': 'Mechlin Technologies',
      'requisition.title': (tpl.positions && tpl.positions[0]) || 'Software Engineer',
      'employment.designation': (tpl.positions && tpl.positions[0]) || 'Software Engineer',
      'requisition.department': (tpl.departments && tpl.departments[0]) || 'Engineering',
      'training.duration': tpl.duration_text || '2 Weeks',
      subject: tpl.subject,
      introduction: tpl.introduction,
      objectives: tpl.objectives,
      'support.contact_name': tpl.support_contact?.name || 'Mechlin Talent Team',
      'support.contact_email': tpl.support_contact?.email || 'hr@mechlintech.com'
    };

    modal(`Preview: ${escape(tpl.name)}`, `
      <div style="max-height:80vh;overflow-y:auto;padding:12px 0;">
        ${renderTrainingPlanPreviewHtml(testVars, tpl.sections, tpl.learning_links, tpl.support_contact)}
      </div>
    `, null);
  } catch (err) {
    notice(err.message, 'error');
  }
}

async function openTrainingPlanReviewModal(applicationId) {
  try {
    const data = await api(`applications/${applicationId}/training-plan`);
    const { draft, candidate, position, department, stage, suggestedTemplate, matchPriority, matchReason, isAmbiguous, ambiguousTemplates, allActiveTemplates } = data;

    let currentDraft = JSON.parse(JSON.stringify(draft));
    let selectedTplId = currentDraft.template_id || (suggestedTemplate ? suggestedTemplate.id : (allActiveTemplates[0]?.id || ''));

    const candVars = {
      'candidate.name': candidate.name,
      'candidate.first_name': candidate.name.split(/\s+/)[0],
      'candidate.email': candidate.email,
      'company.name': 'Mechlin Technologies',
      'requisition.title': position,
      'employment.designation': position,
      'requisition.department': department,
      'training.duration': currentDraft.duration_text || '2 Weeks',
      subject: currentDraft.subject,
      introduction: currentDraft.introduction,
      objectives: currentDraft.objectives,
      'support.contact_name': currentDraft.support_contact?.name || 'The Mechlin Talent Team',
      'support.contact_email': currentDraft.support_contact?.email || 'hr@mechlintech.com'
    };

    const isPositionMismatch = (tplId) => {
      const t = allActiveTemplates.find(x => x.id === tplId);
      if (!t || t.is_default) return false;
      const norm = s => String(s || '').toLowerCase().trim();
      return !(t.positions || []).some(p => norm(p) === norm(position) || norm(position).includes(norm(p)));
    };

    const modalHtml = `
      <div class="training-plan-review-modal">
        <div class="training-studio-header">
          <div class="training-studio-header-left">
            <div>
              <strong style="font-size:1rem;color:var(--ink);">Pre-Onboarding Training Plan</strong>
              <div class="muted" style="font-size:0.78rem;">${escape(candidate.name)} &middot; ${escape(position)} (${escape(department)})</div>
            </div>
          </div>
          <div class="training-studio-header-actions">
            <button type="button" id="btn-save-draft" class="secondary" style="font-size:0.8rem;padding:6px 14px;">Save Draft</button>
            <button type="button" id="btn-discard-draft" class="secondary text-button" style="font-size:0.78rem;padding:6px 10px;color:var(--negative);">Reset Edits</button>
            <button type="button" id="btn-open-send-confirm" class="primary" style="font-size:0.8rem;padding:6px 16px;">${currentDraft.status === 'sent' ? 'Resend Plan...' : 'Send Training Plan...'}</button>
          </div>
        </div>

        <!-- Notification Banner Strip -->
        <div style="padding:10px 20px;border-bottom:1px solid var(--line);background:var(--surface-alt);display:flex;flex-direction:column;gap:6px;">
          ${isAmbiguous ? `
            <div class="training-ambiguity-banner">
              <strong>Ambiguous Match Warning:</strong> Multiple active training plans match candidate criteria at priority level ${matchPriority} (${(ambiguousTemplates || []).map(t => escape(t.name)).join(', ')}). Manual template selection is required.
            </div>
          ` : (suggestedTemplate ? `
            <div style="display:flex;align-items:center;gap:8px;font-size:0.82rem;">
              <span class="training-match-chip">&bull; Suggested: ${escape(suggestedTemplate.name)}</span>
              <span class="muted">(Priority ${matchPriority}: ${escape(matchReason || '')})</span>
            </div>
          ` : `<div class="muted" style="font-size:0.82rem;">No position-specific training plan suggested. Please select an active plan below.</div>`)}
          <div id="mismatch-warning-box" class="training-warning-banner" style="${isPositionMismatch(selectedTplId) ? 'display:block;' : 'display:none;'}">
            <strong>Position Mismatch Notice:</strong> The selected plan is configured for other roles and differs from candidate's position <em>(${escape(position)})</em>. An authorized override will be applied.
          </div>
        </div>

        <div class="training-studio-layout">
          <!-- Left: Candidate-Specific Editor Pane -->
          <div class="training-studio-editor">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface-alt);padding:10px 14px;border-radius:8px;border:1px solid var(--line);">
              <div style="flex:1;">
                <label style="font-weight:600;font-size:0.8rem;display:block;">Select Training Plan Template</label>
                <select id="review-tpl-select" style="width:100%;font-size:0.82rem;padding:5px 8px;margin-top:4px;">
                  ${allActiveTemplates.map(t => `<option value="${t.id}" ${t.id === selectedTplId ? 'selected' : ''}>${escape(t.name)} ${t.is_default ? '(Default)' : ''} — ${(t.positions || []).join(', ') || 'All Roles'}</option>`).join('')}
                </select>
              </div>
              <button type="button" class="secondary" id="btn-apply-tpl-content" style="font-size:0.75rem;padding:6px 10px;margin-top:16px;" title="Reset candidate fields using selected template content">Load Template Content</button>
            </div>

            <div>
              <label style="font-weight:600;font-size:0.82rem;">Candidate Email Subject</label>
              <input type="text" id="review-subject" value="${escape(currentDraft.subject || '')}" style="width:100%;margin-top:4px;">
            </div>

            <div>
              <label style="font-weight:600;font-size:0.82rem;">Personalized Introduction</label>
              <textarea id="review-intro" rows="3" style="width:100%;margin-top:4px;font-size:0.82rem;">${escape(currentDraft.introduction || '')}</textarea>
            </div>

            <div>
              <label style="font-weight:600;font-size:0.82rem;">Training Objectives & Learning Outcomes</label>
              <textarea id="review-objectives" rows="3" style="width:100%;margin-top:4px;font-size:0.82rem;">${escape(currentDraft.objectives || '')}</textarea>
            </div>

            <div>
              <label style="font-weight:600;font-size:0.82rem;">Training Duration</label>
              <input type="text" id="review-duration" value="${escape(currentDraft.duration_text || '2 Weeks')}" style="width:100%;margin-top:4px;">
            </div>

            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <label style="font-weight:600;font-size:0.85rem;">Curriculum Sections</label>
                <button type="button" class="secondary" id="btn-review-add-sec" style="font-size:0.75rem;padding:3px 8px;">+ Add Section</button>
              </div>
              <div id="review-sections-container" style="display:flex;flex-direction:column;gap:10px;"></div>
            </div>

            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <label style="font-weight:600;font-size:0.85rem;">Learning Links & Resources</label>
                <button type="button" class="secondary" id="btn-review-add-link" style="font-size:0.75rem;padding:3px 8px;">+ Add Learning Link</button>
              </div>
              <div id="review-links-container" style="display:flex;flex-direction:column;gap:8px;"></div>
            </div>

            <div style="background:var(--surface-alt);border:1px solid var(--line);border-radius:8px;padding:12px;">
              <label style="font-weight:600;font-size:0.82rem;">Support Contact Details</label>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;">
                <input type="text" id="review-contact-name" value="${escape(currentDraft.support_contact?.name || 'Mechlin Talent Team')}" placeholder="Contact Name" style="font-size:0.8rem;">
                <input type="email" id="review-contact-email" value="${escape(currentDraft.support_contact?.email || 'hr@mechlintech.com')}" placeholder="Contact Email" style="font-size:0.8rem;">
              </div>
            </div>
          </div>

          <!-- Right: Real-time Live Candidate Email Preview -->
          <div class="training-studio-preview">
            <div class="training-studio-preview-head">
              <div>
                <span style="font-weight:600;font-size:0.85rem;color:var(--ink);">Candidate-Facing Email Preview</span>
                <div class="muted" style="font-size:0.75rem;">Delivered to: <strong>${escape(candidate.email)}</strong></div>
              </div>
              <span class="badge ${currentDraft.status === 'sent' ? 'completed' : 'active'}" style="font-size:0.75rem;">Status: ${escape(currentDraft.status || 'pending_review')}</span>
            </div>
            <div class="training-studio-preview-frame-wrap" id="review-preview-box"></div>
          </div>
        </div>
      </div>
    `;

    $('#modal-body').innerHTML = modalHtml;
    $('#modal').showModal();

    let sections = currentDraft.sections || [];
    let links = currentDraft.learning_links || [];

    const syncSectionsDom = () => {
      const container = $('#review-sections-container');
      if (!container) return;
      container.innerHTML = sections.map((s, idx) => `
        <div class="training-section-card" data-idx="${idx}">
          <div class="training-section-card-head">
            <span style="font-weight:600;font-size:0.8rem;color:var(--ink);">Section ${idx + 1}</span>
            <button type="button" class="secondary text-button btn-del-sec" data-idx="${idx}" style="color:var(--negative);font-size:0.75rem;">Remove</button>
          </div>
          <input type="text" class="sec-title-input" data-idx="${idx}" value="${escape(s.title || '')}" placeholder="Title..." style="font-weight:600;font-size:0.82rem;">
          <textarea class="sec-content-input" data-idx="${idx}" rows="2" style="font-size:0.8rem;">${escape(s.content || '')}</textarea>
        </div>
      `).join('') || '<p class="muted" style="font-size:0.8rem;">No content sections added.</p>';

      container.querySelectorAll('.btn-del-sec').forEach(btn => {
        btn.onclick = () => { sections.splice(Number(btn.dataset.idx), 1); syncSectionsDom(); updateLivePreview(); };
      });
      container.querySelectorAll('.sec-title-input').forEach(inp => {
        inp.oninput = () => { sections[Number(inp.dataset.idx)].title = inp.value; updateLivePreview(); };
      });
      container.querySelectorAll('.sec-content-input').forEach(inp => {
        inp.oninput = () => { sections[Number(inp.dataset.idx)].content = inp.value; updateLivePreview(); };
      });
    };

    const syncLinksDom = () => {
      const container = $('#review-links-container');
      if (!container) return;
      container.innerHTML = links.map((l, idx) => `
        <div class="training-link-item" data-idx="${idx}">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <input type="text" class="link-title-input" data-idx="${idx}" value="${escape(l.title || '')}" placeholder="Title..." style="font-weight:600;font-size:0.82rem;flex:1;margin-right:8px;">
            <button type="button" class="secondary text-button btn-del-link" data-idx="${idx}" style="color:var(--negative);font-size:0.75rem;">Remove</button>
          </div>
          <input type="url" class="link-url-input" data-idx="${idx}" value="${escape(l.url || '')}" placeholder="https://..." style="font-size:0.8rem;">
          <input type="text" class="link-desc-input" data-idx="${idx}" value="${escape(l.description || '')}" placeholder="Description..." style="font-size:0.78rem;">
        </div>
      `).join('') || '<p class="muted" style="font-size:0.8rem;">No external links added.</p>';

      container.querySelectorAll('.btn-del-link').forEach(btn => {
        btn.onclick = () => { links.splice(Number(btn.dataset.idx), 1); syncLinksDom(); updateLivePreview(); };
      });
      container.querySelectorAll('.link-title-input').forEach(inp => {
        inp.oninput = () => { links[Number(inp.dataset.idx)].title = inp.value; updateLivePreview(); };
      });
      container.querySelectorAll('.link-url-input').forEach(inp => {
        inp.oninput = () => { links[Number(inp.dataset.idx)].url = inp.value; updateLivePreview(); };
      });
      container.querySelectorAll('.link-desc-input').forEach(inp => {
        inp.oninput = () => { links[Number(inp.dataset.idx)].description = inp.value; updateLivePreview(); };
      });
    };

    const updateLivePreview = () => {
      const box = $('#review-preview-box');
      if (!box) return;
      const previewVars = {
        ...candVars,
        'training.duration': $('#review-duration')?.value || '2 Weeks',
        subject: $('#review-subject')?.value || '',
        introduction: $('#review-intro')?.value || '',
        objectives: $('#review-objectives')?.value || ''
      };
      box.innerHTML = renderTrainingPlanPreviewHtml(previewVars, sections, links, {
        name: $('#review-contact-name')?.value,
        email: $('#review-contact-email')?.value
      });
    };

    syncSectionsDom();
    syncLinksDom();
    updateLivePreview();

    ['review-subject', 'review-intro', 'review-objectives', 'review-duration', 'review-contact-name', 'review-contact-email'].forEach(id => {
      const el = $('#' + id);
      if (el) el.oninput = updateLivePreview;
    });

    $('#btn-review-add-sec').onclick = () => {
      sections.push({ id: 'sec-' + Date.now(), title: `Section ${sections.length + 1}`, content: '', order: sections.length + 1 });
      syncSectionsDom();
      updateLivePreview();
    };
    $('#btn-review-add-link').onclick = () => {
      links.push({ id: 'link-' + Date.now(), title: '', url: 'https://', description: '' });
      syncLinksDom();
      updateLivePreview();
    };

    const tplSelect = $('#review-plan-template-select') || $('#review-tpl-select');
    if (tplSelect) {
      tplSelect.onchange = () => {
        selectedTplId = tplSelect.value;
        const mismatchBox = $('#mismatch-warning-box');
        if (mismatchBox) mismatchBox.style.display = isPositionMismatch(selectedTplId) ? 'block' : 'none';
      };
    }

    $('#btn-apply-tpl-content').onclick = () => {
      const chosenTpl = allActiveTemplates.find(x => x.id === selectedTplId);
      if (!chosenTpl) return;
      if (!window.confirm('Replace current editor contents with template defaults? Any manual edits will be overwritten.')) return;
      $('#review-subject').value = chosenTpl.subject || '';
      $('#review-intro').value = chosenTpl.introduction || '';
      $('#review-objectives').value = chosenTpl.objectives || '';
      $('#review-duration').value = chosenTpl.duration_text || '2 Weeks';
      if (chosenTpl.support_contact?.email) $('#review-contact-email').value = chosenTpl.support_contact.email;
      sections = JSON.parse(JSON.stringify(chosenTpl.sections || []));
      links = JSON.parse(JSON.stringify(chosenTpl.learning_links || []));
      syncSectionsDom();
      syncLinksDom();
      updateLivePreview();
      notice('Loaded content from selected template.', 'success');
    };

    const buildDraftPayload = () => ({
      template_id: selectedTplId,
      subject: $('#review-subject')?.value || '',
      introduction: $('#review-intro')?.value || '',
      objectives: $('#review-objectives')?.value || '',
      duration_text: $('#review-duration')?.value || '2 Weeks',
      sections,
      learning_links: links,
      support_contact: {
        name: $('#review-contact-name')?.value || 'Mechlin Talent Team',
        email: $('#review-contact-email')?.value || 'hr@mechlintech.com'
      }
    });

    $('#btn-save-draft').onclick = async () => {
      const payload = buildDraftPayload();
      try {
        await api(`applications/${applicationId}/training-plan`, 'PUT', payload);
        notice('Training plan draft saved. (Email not sent)', 'success');
        await render();
      } catch (err) {
        notice(err.message, 'error');
      }
    };

    $('#btn-discard-draft').onclick = async () => {
      if (!window.confirm('Discard all custom edits and re-initialize from suggested template?')) return;
      try {
        await api(`applications/${applicationId}/training-plan/discard`, 'POST');
        notice('Draft reset to original suggestion.', 'success');
        openTrainingPlanReviewModal(applicationId);
      } catch (err) {
        notice(err.message, 'error');
      }
    };

    $('#btn-open-send-confirm').onclick = async () => {
      const payload = buildDraftPayload();
      if (!payload.subject.trim()) { notice('Email subject is required before sending.', 'error'); return; }
      // Auto-save draft before confirming send so changes are persisted
      await api(`applications/${applicationId}/training-plan`, 'PUT', payload).catch(() => {});
      openTrainingSendConfirmation(applicationId, {
        ...payload,
        candidate,
        position,
        templateName: allActiveTemplates.find(x => x.id === selectedTplId)?.name || 'Custom Training Plan'
      }, currentDraft.status === 'sent');
    };
  } catch (err) {
    notice(err.message, 'error');
  }
}

function openTrainingSendConfirmation(applicationId, draftData, isResend = false) {
  const modalHtml = `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px;color:#1e3a8a;font-size:0.85rem;line-height:1.5;">
        <strong style="font-size:0.95rem;color:#1e40af;display:block;margin-bottom:8px;">Deliver Pre-Onboarding Training Plan</strong>
        <div>Candidate: <strong>${escape(draftData.candidate?.name || 'Candidate')}</strong></div>
        <div>Recipient Email: <strong>${escape(draftData.candidate?.email || '')}</strong></div>
        <div>Assigned Position: <strong>${escape(draftData.position || '')}</strong></div>
        <div>Selected Plan: <strong>${escape(draftData.templateName || 'Training Plan')}</strong></div>
        <div>Email Subject: <em>${escape(draftData.subject || '')}</em></div>
      </div>

      <div style="background:#fffbeb;border:1px solid #fef3c7;border-left:4px solid #f59e0b;padding:12px;border-radius:6px;font-size:0.82rem;color:#92400e;line-height:1.5;">
        <strong>Critical Requirement:</strong> The training-plan email is only sent when you explicitly confirm below. Pipeline transitions or previous stage notifications are separate and will not be re-sent. This action is permanently audited.
      </div>

      <div class="form-actions" style="margin-top:12px;">
        <button type="button" class="secondary" id="btn-cancel-send">Cancel</button>
        <button type="button" class="primary" id="btn-confirm-send" style="padding:6px 18px;">${isResend ? 'Confirm & Resend Email' : 'Confirm & Send Email'}</button>
      </div>
    </div>
  `;

  modal(isResend ? 'Confirm Training Plan Resend' : 'Confirm Training Plan Email Delivery', modalHtml, null, { actions: false });

  $('#btn-cancel-send').onclick = () => {
    closeModal();
    openTrainingPlanReviewModal(applicationId);
  };

  $('#btn-confirm-send').onclick = async () => {
    const btn = $('#btn-confirm-send');
    btn.disabled = true;
    btn.textContent = 'Sending email...';

    try {
      const endpoint = `applications/${applicationId}/training-plan/${isResend ? 'resend' : 'send'}`;
      await api(endpoint, 'POST', { sendConfirmation: true });
      closeModal();
      notice(`Training plan successfully delivered to ${draftData.candidate?.email}!`, 'success');
      await render();
    } catch (err) {
      notice(err.message, 'error');
      btn.disabled = false;
      btn.textContent = isResend ? 'Confirm & Resend Email' : 'Confirm & Send Email';
    }
  };
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
    if(a==='close-modal'){closeModal();return;}
    if(a==='admin-tab'){adminTab=id;pageState.Administration=1;await render();return;}
    if(a==='new-role'){openRoleModal(null);return;}
    if(a==='view-role'||a==='edit-role'||a==='duplicate-role'){const role=(window.currentRoles||[]).find(r=>r.id===id);if(!role)return;openRoleModal(role,a==='view-role',a==='duplicate-role');return;}
    if(a==='archive-role'){const role=(window.currentRoles||[]).find(r=>r.id===id);if(!role)return;openArchiveRoleModal(role);return;}
    if(a==='audit-filter'){auditFilters={event:$('#audit-event')?.value.trim()||'',q:$('#audit-q')?.value.trim()||'',from:$('#audit-from')?.value.trim()||'',to:$('#audit-to')?.value.trim()||''};pageState['Audit log']=1;await render();return;}
    if(a==='audit-clear'){auditFilters={event:'',q:'',from:'',to:''};pageState['Audit log']=1;await render();return;}
    if(a==='demo-login-modal'){await openDemoModal(false);return;}
    if(a==='switch-demo-role'){await openDemoModal(true);return;}
    if(a==='req-page'||a==='page'){const view=b.dataset.view||'Requisitions';const p=Number(b.dataset.page);const total=Number(b.dataset.totalPages||Infinity);if(p>=1&&p<=total&&p!==(pageState[view]||1)){pageState[view]=p;reqPage=pageState.Requisitions;await render();}return;}
    if(a==='navigate'){deniedView='';if(current!==b.dataset.view){reqPage=1;pageState[b.dataset.view]=1;if(b.dataset.view==='Candidates')candidateQuery='';}current=b.dataset.view;syncNavState();saveNavScroll(document.querySelector('.sidebar nav'));await render();return;}
    if(a==='clear-candidate-search'){candidateQuery='';pageState.Candidates=1;await render();return;}
    if(a==='reset-theme'){applyTheme(appearance.theme);document.querySelector(`#appearance-form input[value="${appearance.theme}"]`).checked=true;$('#save-theme').disabled=true;$('#appearance-status').textContent='Preview reset to the saved workspace theme.';return;}
    if(a==='logout'){
      await api('logout','POST',{});
      me=null;
      try{
        sessionStorage.removeItem('orbit_current');
        sessionStorage.removeItem('orbit_pages');
        sessionStorage.removeItem('orbit_nav_scroll_top');
        sessionStorage.removeItem('orbit_nav_scroll_left');
        localStorage.removeItem('orbit_current');
        localStorage.removeItem('orbit_pages');
        localStorage.removeItem('orbit_nav_scroll_top');
        localStorage.removeItem('orbit_nav_scroll_left');
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
    if(a==='new-offer-template'){await openOfferTemplateEditor();return;}
    if(a==='edit-template'){await openOfferTemplateEditor(id);return;}
    if(a==='preview-template'){await openOfferTemplatePreview(id);return;}
    if(a==='duplicate-template'){
      await api(`offer-templates/${id}/duplicate`, 'POST', {});
      notice('Template duplicated successfully.', 'success');
      await render();
      return;
    }
    if(a==='set-template-default'){
      await api(`offer-templates/${id}/status`, 'POST', { is_default: 1 });
      notice('Template set as default.', 'success');
      await render();
      return;
    }
    if(a==='archive-template'){
      if(!window.confirm('Archive this offer letter template? Existing issued offers will remain unchanged.'))return;
      await api(`offer-templates/${id}/status`, 'POST', { status: 'archived' });
      notice('Template archived.', 'success');
      await render();
      return;
    }
    if(a==='activate-template'){
      await api(`offer-templates/${id}/status`, 'POST', { status: 'active' });
      notice('Template activated.', 'success');
      await render();
      return;
    }
    if(a==='toggle-chips-expand'){
      const cloud = b.closest('.chips-cloud');
      if(cloud) cloud.classList.toggle('is-expanded');
      return;
    }
    if(a==='toggle-chips-collapse'){
      const cloud = b.closest('.chips-cloud');
      if(cloud) cloud.classList.remove('is-expanded');
      return;
    }
    if(a==='new-training-template'){await openTrainingTemplateEditor();return;}
    if(a==='edit-training-template'){await openTrainingTemplateEditor(id);return;}
    if(a==='preview-training-template'){await openTrainingTemplatePreview(id);return;}
    if(a==='duplicate-training-template'){
      await api(`training-plans/templates/${id}/duplicate`, 'POST', {});
      notice('Training plan duplicated successfully.', 'success');
      await render();
      return;
    }
    if(a==='set-training-default'){
      await api(`training-plans/templates/${id}/status`, 'POST', { is_default: 1 });
      notice('Training plan set as default.', 'success');
      await render();
      return;
    }
    if(a==='archive-training-template'){
      if(!window.confirm('Archive this training plan template? Historical records will remain intact.'))return;
      await api(`training-plans/templates/${id}/archive`, 'POST', {});
      notice('Training plan archived.', 'success');
      await render();
      return;
    }
    if(a==='activate-training-template'){
      await api(`training-plans/templates/${id}/status`, 'POST', { status: 'active' });
      notice('Training plan activated.', 'success');
      await render();
      return;
    }
    if(a==='review-training-plan'){
      await openTrainingPlanReviewModal(id);
      return;
    }
    if(a==='upload-letterhead'){await openLetterheadUploadModal();return;}
    if(a==='delete-letterhead-asset'){
      if(!confirm('Are you sure you want to delete this letterhead asset? Templates using it will fall back to plain background.'))return;
      await api(`offer-letter-assets/${id}`,'DELETE');
      notice('Letterhead asset deleted.','success');
      await render();
      return;
    }
    if(a==='new-req'){
      modal('New requisition',`<div class="form-grid">${field('Position title','title')}${teamSelect('Team','team',me.team||'Dev',false)}${field('Headcount','headcount','number','1')}${field('Currency','currency','text','INR')}${field('Minimum annual salary','salary_min','number','0')}${field('Maximum annual salary','salary_max','number','0')}${field('Required skills, comma separated','skills','text','',false)}${area('Job description','description','',true)}</div>${button('Draft description from title & skills','draft-jd','','class="secondary"')}`,async v=>{
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
        const normTeam = normalizeTeam(v.team) || v.team;
        await api('requisitions','POST',{...v,team:normTeam,currency:v.currency.trim().toUpperCase(),headcount:Number(v.headcount),salary_min:Number(v.salary_min),salary_max:Number(v.salary_max),skills:skills(v.skills)});
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
      const isAdmin = allows('requisitions.override') || allows('system.override');
      const reqs = await api('requisitions');
      const r = reqs.find(item => item.id === id) || await api(`requisitions/${id}`);
      
      if(!r || !['pending_manager','pending_finance'].includes(r.status)){
        throw new Error('Requisition is not awaiting approval.');
      }
      if(r.status === 'pending_manager' && !allowAction('requisitions.approve_manager','approve_manager') && !isAdmin){
        throw new Error('Your role cannot perform this action.');
      }
      if(r.status === 'pending_finance' && !allowAction('requisitions.approve_finance','approve_finance') && !isAdmin){
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
        select('Decision', 'decision', [['approve', 'Approve requisition'], ['reject', 'Reject requisition']], 'approve') +
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
      if(!['draft','open'].includes(r.status)&&!((allows('requisitions.override')||allows('system.override'))&&['pending_manager','pending_finance'].includes(r.status)))throw new Error(`Cannot edit requisition with status ${r.status}.`);
      modal('Edit requisition',`<div class="form-grid">${field('Position title','title','text',r.title)}${teamSelect('Team','team',r.team||'Dev',false)}${field('Headcount','headcount','number',String(r.headcount))}${field('Currency','currency','text',r.currency||'INR')}${field('Minimum annual salary','salary_min','number',String(r.salary_min??0))}${field('Maximum annual salary','salary_max','number',String(r.salary_max??0))}${field('Required skills, comma separated','skills','text',(r.skills||[]).join(', '),false)}${area('Job description','description',r.description,true)}</div>${button('Draft description from title & skills','draft-jd','','class="secondary"')}`,async v=>{
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
        const normTeam = normalizeTeam(v.team) || v.team;
        const payload = {...v,team:normTeam,currency:v.currency.trim().toUpperCase(),headcount:Number(v.headcount),salary_min:Number(v.salary_min),salary_max:Number(v.salary_max),skills:skills(v.skills)};
        if(allows('requisitions.override')||allows('system.override')) payload.admin_override = true;
        await api(`requisitions/${id}`,'PUT',payload);
        return 'Requisition updated successfully.';
      },{ actions: formActions({ deleteAction: allowAction('requisitions.delete','requisition','recruit') ? 'delete-req' : '', deleteId:id }) });
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
      const defaultTeam = (me.team ? normalizeTeam(String(me.team).split(/[,;/|]+/)[0]) : '') || (me.team || 'Dev');
      modal('Add candidate',`<div class="form-grid">${uploadWidget}${field('Full name','name')}${field('Email','email','email')}${field('Phone','phone','tel','',false)}${teamSelect('Team','team',defaultTeam,false)}${select('Associated requisition','requisition_id',reqOptions,'',false)}${field('Skills, comma separated','skills','text','',false)}${field('Source','source','text','Direct')}${area('Experience / Resume text','resume_text')}</div>${button('Extract email and phone','parse-resume','','class="secondary"')}`,async v=>{
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
        const normTeam = normalizeTeam(v.team) || v.team;
        await api('candidates','POST',{...v,team:normTeam,skills:skills(v.skills),experience:v.resume_text,resume_id:v.resume_id||undefined,requisition_id:v.requisition_id||undefined});
        return v.requisition_id ? 'Candidate created and added to pipeline (Applied stage).' : 'Candidate created successfully.';
      });
      const syncReqTeam = () => {
        const rSel = $('#edit-form select[name="requisition_id"]');
        const tSel = $('#edit-form select[name="team"]');
        if (!rSel || !tSel) return;
        const rid = rSel.value;
        if (rid) {
          const open = window._cachedOpenReqs || [];
          const r = open.find(item => item.id === rid);
          if (r && r.team) {
            const nt = normalizeTeam(r.team);
            for (const opt of tSel.options) {
              if (opt.value.toLowerCase() === nt.toLowerCase() || opt.value.toLowerCase() === r.team.toLowerCase()) {
                tSel.value = opt.value;
                break;
              }
            }
          }
        }
      };
      const rSelInitial = $('#edit-form select[name="requisition_id"]');
      if (rSelInitial) rSelInitial.addEventListener('change', syncReqTeam);
      api('requisitions').then(rs => {
        if (!Array.isArray(rs)) return;
        const open = rs.filter(r => r.status === 'open');
        window._cachedOpenReqs = open;
        const sel = $('#edit-form select[name="requisition_id"]');
        if (sel) {
          const curVal = sel.value;
          sel.innerHTML = `<option value="">None (Candidate pool only)</option>` +
            open.map(r => `<option value="${escape(r.id)}" ${r.id === curVal ? 'selected' : ''}>${escape(r.title)} — ${escape(r.id)} (${escape(r.team)})</option>`).join('');
          sel.addEventListener('change', syncReqTeam);
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
        const normTeam = normalizeTeam(v.team) || v.team;
        await api(`candidates/${id}`,'PUT',{...v,team:normTeam,skills:skills(v.skills),experience:v.resume_text,resume_id:v.resume_id||undefined});
        return 'Candidate updated successfully.';
      },{ actions: formActions({ deleteAction: (!inPipeline && allowAction('candidates.delete','recruit')) ? 'delete-candidate' : '', deleteId: id }) });
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
      const c = await api(`candidates/${id}`);
      const limitedView = c.access_scope === 'assigned_interviews';
      const [commsData, fraudData, sigData] = await Promise.all([
        limitedView ? Promise.resolve({ consent: { opted_out: false }, communications: [] }) : api(`candidates/${id}/communications`).catch(() => ({ consent: { opted_out: false }, communications: [] })),
        limitedView ? Promise.resolve(null) : api(`candidates/${id}/fraud-review`).catch(() => null),
        limitedView ? Promise.resolve([]) : api(`candidates/${id}/signatures`).catch(() => [])
      ]);
      const appsHtml=(c.applications&&c.applications.length)?`<h3>Applications & Status</h3><div class="candidate-status-list" style="margin-bottom:14px;">${c.applications.map(app=>{
        const title=escape(app.title||'General Application');
        const isHired = app.stage === 'Hired';
        let hrmsInfo = '';
        if (isHired) {
          const synced = Boolean(app.hrms_synced);
          const badgeHtml = synced
            ? `<span class="badge completed" style="font-size:0.72rem;background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;margin-left:6px;" title="Synced to HRMS${app.hrms_employee_id ? ' (' + escape(String(app.hrms_employee_id)) + ')' : ''}">✓ HRMS Synced</span>`
            : (app.hrms_sync_status?.error
              ? `<span class="badge rejected" style="font-size:0.72rem;margin-left:6px;" title="${escape(app.hrms_sync_status.error)}">⚠ HRMS Failed</span>`
              : `<span class="badge pending" style="font-size:0.72rem;background:#fef3c7;color:#92400e;border:1px solid #fde68a;margin-left:6px;">⏳ HRMS Pending</span>`);
          const actionBtn = (allowAction('applications.hrms_handoff', 'admin', 'recruit') || allows('system.override'))
            ? `<button type="button" class="button secondary" data-action="hrms-handoff" data-id="${app.id}" style="font-size:0.72rem;padding:2px 8px;margin-left:6px;">${synced ? 'Re-sync HRMS' : 'Send to HRMS'}</button>`
            : '';
          hrmsInfo = `${badgeHtml}${actionBtn}`;
        }
        return `<div class="candidate-status-pair"><span class="candidate-status-role" title="${title}">${title}</span> <span class="status-sep" aria-hidden="true">—</span> ${badge(app.stage||'Applied')}${hrmsInfo}</div>`;
      }).join('')}</div>`:'';

      // Pre-Onboarding Training Evaluation block if present
      let trainingEvalHtml = '';
      const candAppsList = c.applications || [];
      const appWithEval = candAppsList.find(a => a.training_evaluation || a.training_rating);
      if (appWithEval) {
        const ev = appWithEval.training_evaluation || (await api(`applications/${appWithEval.id}/training-evaluation`).catch(() => ({ evaluation: null }))).evaluation;
        if (ev) {
          const decisionBadge = ev.decision === 'next'
            ? `<span class="badge completed" style="font-size:0.75rem;">Passed & Advanced</span>`
            : (ev.decision === 'revoked'
              ? `<span class="badge rejected" style="font-size:0.75rem;">Offer Revoked</span>`
              : `<span class="badge rejected" style="font-size:0.75rem;">Rejected</span>`);

          trainingEvalHtml = `
            <div class="training-evaluation-card">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                <h3 style="margin:0;font-size:0.95rem;">Pre-Onboarding Training Evaluation</h3>
                ${decisionBadge}
              </div>
              <div style="margin-top:6px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                <span class="badge" style="font-size:0.8rem;font-weight:600;">Rating: ${ev.rating}/5</span>
                ${ev.practical_score !== null && ev.practical_score !== undefined ? `<span class="muted">· Score: <strong>${ev.practical_score}%</strong></span>` : ''}
                ${ev.evaluator_name ? `<span class="muted">· Evaluator: ${escape(ev.evaluator_name)}</span>` : ''}
              </div>
              ${ev.notes ? `<p class="score-note" style="margin-top:8px;font-size:0.85rem;"><strong>Notes:</strong> ${escape(ev.notes)}</p>` : ''}
            </div>
          `;
        }
      }
      // Pre-Onboarding Training Plan block if candidate has an application in Pre-Onboarding Training
      let trainingPlanCardHtml = '';
      const appForTraining = candAppsList.find(a => /pre-onboarding|training/i.test(a.stage));
      if (appForTraining) {
        const st = appForTraining.training_plan_status || 'pending_review';
        let stBadge = `<span class="badge" style="background:#fef3c7;color:#92400e;font-size:0.75rem;">Pending Review</span>`;
        if (st === 'sent') {
          stBadge = `<span class="badge completed" style="font-size:0.75rem;">Plan Sent</span>`;
        } else if (st === 'draft_saved') {
          stBadge = `<span class="badge" style="background:#e0e7ff;color:#3730a3;font-size:0.75rem;">Draft Saved</span>`;
        } else if (st === 'failed') {
          stBadge = `<span class="badge rejected" style="font-size:0.75rem;">Send Failed</span>`;
        }

        trainingPlanCardHtml = `
          <div class="training-evaluation-card" style="margin:12px 0;border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--surface);">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
              <div>
                <h3 style="margin:0;font-size:0.95rem;">Pre-Onboarding Training Plan</h3>
                <div class="muted" style="font-size:0.78rem;">Role: ${escape(appForTraining.title || 'Candidate')} &middot; Stage: ${escape(appForTraining.stage)}</div>
              </div>
              ${stBadge}
            </div>
            <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
              <span class="muted" style="font-size:0.8rem;">Review curated learning materials, dynamic email content, and verify before manual confirmation.</span>
              ${allows('training.read') || allows('training.manage') || (!grants.length && (allows('recruit') || allows('admin'))) ? `<button type="button" class="button secondary" data-action="review-training-plan" data-id="${appForTraining.id}" style="font-size:0.8rem;padding:5px 12px;">${st === 'sent' ? 'View Sent Plan / Resend' : (st === 'draft_saved' ? 'Resume Training Draft' : 'Review Training Plan')}</button>` : ''}
            </div>
          </div>
        `;
      }
      const resumeHtml=!limitedView&&c.resume?`<div class="resume-info" style="margin:10px 0;padding:10px 12px;background:var(--surface-alt);border:1px solid var(--line);border-radius:8px;font-size:0.85rem;"><span class="muted">Attached resume:</span> <strong>${escape(c.resume.filename)}</strong> <span class="badge clean" style="margin-left:6px;font-size:0.75rem;">${escape(c.resume.file_format.toUpperCase())}</span> <span class="muted">(${Math.round(c.resume.file_size/1024)} KB)</span></div>`:'';
      const consent = commsData.consent || { opted_out: false };
      const commsList = commsData.communications || [];
      const consentBadge = limitedView
        ? ''
        : consent.opted_out
        ? `<span class="badge rejected" style="margin-left:8px;font-size:0.75rem;">Opted out of email</span>`
        : `<span class="badge active" style="margin-left:8px;font-size:0.75rem;">Subscribed to email</span>`;
      const commsHtml = commsList.length
        ? `<div class="comms-history" style="margin-top:14px;"><h3>Recent Communications</h3><div class="table-wrap"><table class="comms-table"><thead><tr><th scope="col">Subject</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead><tbody>${commsList.slice(0, 5).map(m=>`<tr><td><strong>${escape(m.subject)}</strong></td><td>${badge(m.status)}</td><td><small class="muted">${formatDateIST(m.created_at)}</small></td></tr>`).join('')}</tbody></table></div></div>`
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
            statusBadge = `<span class="badge completed" style="font-size:0.72rem;padding:2px 7px;">Signed & Executed</span>`;
            const signedAtStr = (s.signers && s.signers[0]?.signed_at)
              ? formatDateIST(s.signers[0].signed_at)
              : formatDateIST(s.updated_at || s.created_at);
            metaText = `Executed on ${signedAtStr} · Cryptographically verified SHA-256`;
          } else if (isPending) {
            let validityNote = '';
            if (s.expires_at) {
              const expDate = new Date(s.expires_at);
              const diffMs = expDate.getTime() - Date.now();
              const diffDays = Math.ceil(diffMs / 86400000);
              const daysText = diffDays > 0 ? `${diffDays}d remaining` : 'Expired';
              validityNote = ` · Valid until ${formatDateIST(expDate)} (${daysText})`;
            }
            if (s.status === 'viewed') {
              statusBadge = `<span class="badge viewed" style="font-size:0.72rem;padding:2px 7px;">Viewed by Signer</span>`;
              metaText = `Created ${formatDateIST(s.created_at)}${validityNote} · Awaiting execution`;
            } else {
              statusBadge = `<span class="badge pending" style="font-size:0.72rem;padding:2px 7px;">Awaiting Signature</span>`;
              metaText = `Created ${formatDateIST(s.created_at)}${validityNote}`;
            }
          } else if (isCancelled) {
            statusBadge = `<span class="badge rejected" style="font-size:0.72rem;padding:2px 7px;">Cancelled</span>`;
            metaText = `Cancelled on ${formatDateIST(s.updated_at || s.created_at)}`;
          } else if (isDeclined) {
            statusBadge = `<span class="badge rejected" style="font-size:0.72rem;padding:2px 7px;">Declined</span>`;
            metaText = `Declined by candidate`;
          } else {
            statusBadge = badge(s.status);
            metaText = `Created ${formatDateIST(s.created_at)}`;
          }

          // Document action button:
          const docAction = isDone
            ? (allowAction('signatures.download','recruit') ? `<a href="/api/signatures/${s.id}/document?version=signed" target="_blank" class="button" style="font-size:0.78rem;padding:5px 12px;">Download Signed PDF</a>` : '')
            : (allowAction('signatures.read','review','recruit') || allowAction('offers.read','review','recruit') ? `<a href="/api/signatures/${s.id}/document?version=original" target="_blank" class="button secondary" style="font-size:0.78rem;padding:5px 12px;">View Document</a>` : '');

          // Resend email invitation button:
          const sendEmailBtn = (isPending && allowAction('signatures.manage','recruit'))
            ? `<button type="button" class="button secondary" data-action="resend-sig-email" data-id="${s.id}" data-candidate-id="${c.id}" style="font-size:0.78rem;padding:5px 11px;" title="Invitation email was dispatched upon request creation. Click to resend to candidate.">Resend Email</button>`
            : '';

          // Copy sign link ONLY if pending/viewed - NEVER when completed, cancelled, or declined
          const firstSigner = (s.signers && s.signers[0]) || null;
          const copyLinkBtn = (isPending && allowAction('signatures.manage','recruit'))
            ? `<button type="button" class="button secondary" data-action="copy-sig-link" data-id="${s.id}" data-token="${escape(firstSigner?.token || '')}" style="font-size:0.78rem;padding:5px 11px;" title="Copy secure electronic signing link">Copy Link</button>`
            : '';

          // Cancel action ONLY if pending/viewed
          const cancelBtn = (isPending && allowAction('signatures.manage','recruit'))
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
      if (allows('signatures.request') || allows('offers.create') || (!grants.length && allows('recruit'))) {
        if (isRejected) {
          if (sigList.length > 0) {
            footerActionHtml = `
              <div class="sig-action-footer">
                <span class="sig-status-notice" style="color:var(--negative);font-weight:550;">${escape(signatureState.reason)} Offer agreements are unavailable</span>
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
              <span class="sig-status-notice" style="color:var(--positive);font-weight:550;">Offer agreement completed and legally executed</span>
              <button type="button" class="secondary text-button" data-action="new-signature-request" data-id="${c.id}" style="font-size:0.78rem;color:var(--muted);">+ Send Additional Document</button>
            </div>
          `;
        } else if (hasActivePending) {
          footerActionHtml = `
            <div class="sig-action-footer">
              <span class="sig-status-notice" style="color:var(--warning);font-weight:550;">Offer letter is currently awaiting candidate signature</span>
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
          ? `<span class="badge completed" style="font-size:0.74rem;">Executed</span>`
          : (hasActivePending
            ? `<span class="badge pending" style="font-size:0.74rem;">Pending Signature</span>`
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

        const resolveAction = allows('candidates.fraud.manage')
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

      const showFooterOfferBtn = (allowAction('offers.create','recruit') || allowAction('signatures.request','recruit')) && signatureState.eligible && !hasCompleted && !hasActivePending;
      const offerFooterBtn = showFooterOfferBtn ? button('Offer & E-Sign','new-signature-request',c.id,'class="secondary" style="margin-right:8px;"') : '';
      const canEmailCandidate = allowAction('candidates.communications.send','recruit');
      const canEditCandidate = allowAction('candidates.update','recruit');
      const emailAction = (showFooterOfferBtn || canEmailCandidate || canEditCandidate) ? `${offerFooterBtn}${canEmailCandidate?button('Send email','send-candidate-email',c.id,'class="primary" style="margin-right:8px;"'):''}${canEditCandidate?button('Edit','edit-candidate',c.id,'class="secondary"'):''}` : '';
      const limitedNotice = limitedView
        ? `<div class="notice-inline" role="status" style="margin-bottom:12px;"><strong>Interviewer access:</strong> You can see this candidate's contact details, skills and the applications linked to your assigned interviews. Resume files, offer data and unrelated applications are restricted.</div>`
        : '';
      modal(c.name,`${limitedNotice}<p>${escape(c.email)}${c.phone?` · ${escape(c.phone)}`:''}${consentBadge}</p><p>${escape((c.skills||[]).join(', '))}</p>${appsHtml}${limitedView?'':resumeHtml}${limitedView?'':signaturesHtml}${limitedView?'':trainingPlanCardHtml}${limitedView?'':trainingEvalHtml}${limitedView?'':`<h3>Experience / Resume</h3><p class="score-note">${escape(c.resume_text||c.experience||'No resume text provided.')}</p>`}${fraudHtml}${commsHtml}${emailAction?`<div class="actions" style="margin-top:16px">${emailAction}</div>`:''}`);
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
    async function openScorecardModal(id, isProxy = false) {
      const interviews = await api('interviews');
      const i = interviews.find(item => item.id === id) || await api(`interviews/${id}`);
      if (!i) throw new Error('Interview not found.');
      if (!feedbackReady(i)) throw new Error(FEEDBACK_LOCKED_MESSAGE);
      const comps = JSON.parse(i.competencies || '[]');
      const title = isProxy ? `Submit proxy scorecard on behalf of ${escape(i.interviewer)}` : 'Submit independent feedback';
      const headerNotice = isProxy
        ? `<div class="notice-inline"><strong>Administrative Proxy Submission:</strong> You are submitting this scorecard on behalf of the assigned interviewer (${escape(i.interviewer)}). An audit log entry will record your action and reason.</div>`
        : `<div class="notice-inline" style="margin-top:0;margin-bottom:16px;border-left-color:var(--accent);background:var(--tint,#f0fdf4);"><p style="margin:0;"><strong>Candidate:</strong> ${escape(i.name || 'Candidate')} &middot; <strong>Round:</strong> ${escape(i.title || 'Interview round')}</p></div>`;

      const compSection = `
        <div class="scorecard-competencies-section" style="margin-bottom:18px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <label style="font-weight:600;font-size:0.92rem;margin:0;">Evaluation Competencies &amp; Ratings <span style="color:var(--negative,#b91c1c);font-weight:bold;">*</span></label>
            <span class="muted" id="comp-count-badge" style="font-size:0.8rem;background:var(--surface-alt);padding:2px 8px;border-radius:12px;border:1px solid var(--line);">${comps.length} ${comps.length === 1 ? 'competency' : 'competencies'}</span>
          </div>
          <p class="muted" style="font-size:0.82rem;margin:0 0 10px 0;line-height:1.4;">Rate planned competencies below. You can also add custom competencies to evaluate additional aspects from your perspective, or remove competencies as needed.</p>
          <div id="scorecard-competencies-list" style="display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;padding-right:2px;margin-bottom:10px;"></div>
          <div class="add-comp-box" style="display:flex;gap:8px;align-items:center;background:var(--surface-alt);border:1px dashed var(--line);border-radius:8px;padding:8px 10px;">
            <input type="text" id="new-competency-input" placeholder="Add custom competency (e.g. System Design, Problem Solving, Culture Fit)..." style="flex:1;min-height:36px;padding:6px 10px;font-size:0.85rem;" maxlength="100">
            <button type="button" id="btn-add-competency" class="secondary" style="min-height:36px;padding:6px 14px;font-size:0.85rem;white-space:nowrap;font-weight:600;">+ Add Competency</button>
          </div>
          <p class="error" id="competency-error" style="font-size:0.8rem;margin:6px 0 0 0;display:none;"></p>
        </div>
      `;

      modal(title,
        headerNotice +
        compSection +
        select('Recommendation', 'recommendation', ['Strong yes', 'Yes', 'No', 'Strong no']) +
        area('Job-related evidence', 'notes', '', true) +
        (isProxy ? area('Reason for proxy submission', 'proxy_reason', '', true) : '') +
        '<p class="muted" style="font-size:0.82rem;margin-top:8px;">Submitted feedback is final in this phase. Other feedback stays hidden until you submit your assigned scorecards.</p>',
        async v => {
          if (!feedbackReady(i)) throw new Error(FEEDBACK_LOCKED_MESSAGE);
          if (isProxy && (!v.proxy_reason || !v.proxy_reason.trim())) {
            throw new Error('A reason for proxy submission is required.');
          }
          const listEl = $('#scorecard-competencies-list');
          const rows = listEl ? listEl.querySelectorAll('.scorecard-comp-row') : [];
          const ratings = {};
          for (const row of rows) {
            const compName = row.dataset.compName;
            const sel = row.querySelector('.scorecard-rating-select');
            if (compName && sel) {
              ratings[compName] = Number(sel.value);
            }
          }
          if (!Object.keys(ratings).length) {
            const errEl = $('#competency-error');
            if (errEl) { errEl.textContent = 'At least one competency rating is required.'; errEl.style.display = 'block'; }
            throw new Error('At least one competency rating is required.');
          }
          const payload = {
            ratings,
            recommendation: v.recommendation,
            notes: v.notes,
            ...(isProxy ? { proxy_reason: v.proxy_reason.trim() } : {})
          };
          await api(`interviews/${id}/scorecards`, 'POST', payload);
          return 'Scorecard submitted successfully.';
        }
      );

      const listEl = $('#scorecard-competencies-list');
      const newCompInput = $('#new-competency-input');
      const addCompBtn = $('#btn-add-competency');
      const errEl = $('#competency-error');
      const countBadge = $('#comp-count-badge');

      const updateBadge = () => {
        if (!countBadge || !listEl) return;
        const count = listEl.querySelectorAll('.scorecard-comp-row').length;
        countBadge.textContent = `${count} ${count === 1 ? 'competency' : 'competencies'}`;
        countBadge.style.color = count === 0 ? 'var(--negative, #b91c1c)' : '';
      };

      const renderCompRow = (name, isCustom = false) => {
        const row = document.createElement('div');
        row.className = 'scorecard-comp-row';
        row.dataset.compName = name;
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:var(--surface);border:1px solid var(--line);border-radius:8px;';
        row.innerHTML = `
          <div style="flex:1;min-width:0;display:flex;align-items:center;gap:8px;">
            <span style="font-weight:600;font-size:0.88rem;overflow-wrap:anywhere;color:var(--ink);">${escape(name)}</span>
            ${isCustom ? `<span class="badge" style="font-size:0.7rem;padding:2px 6px;background:var(--tint,#e0f2fe);color:var(--accent,#0369a1);border-radius:4px;">Custom</span>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            <label style="display:flex;align-items:center;gap:6px;font-size:0.83rem;margin:0;font-weight:normal;color:var(--muted);">
              <span>Score:</span>
              <select class="scorecard-rating-select" data-comp="${escape(name)}" name="rating_${escape(name)}" style="min-height:34px;padding:3px 8px;font-size:0.85rem;border-radius:6px;width:auto;" aria-label="Rating for ${escape(name)}">
                <option value="1">1 (Low)</option>
                <option value="2">2</option>
                <option value="3" selected>3</option>
                <option value="4">4</option>
                <option value="5">5 (High)</option>
              </select>
            </label>
            <button type="button" class="secondary btn-remove-comp" data-comp="${escape(name)}" title="Remove ${escape(name)}" aria-label="Remove ${escape(name)}" style="min-height:34px;padding:3px 10px;font-size:0.8rem;color:var(--negative,#b91c1c);border-color:var(--line);">
              Remove
            </button>
          </div>
        `;
        return row;
      };

      if (listEl) {
        for (const c of comps) {
          listEl.appendChild(renderCompRow(c, false));
        }
        updateBadge();
      }

      const handleAdd = () => {
        if (!newCompInput) return;
        const val = newCompInput.value.trim();
        if (!val) {
          if (errEl) { errEl.textContent = 'Please enter a competency name.'; errEl.style.display = 'block'; }
          newCompInput.focus();
          return;
        }
        if (val.length > 100) {
          if (errEl) { errEl.textContent = 'Competency name must be at most 100 characters.'; errEl.style.display = 'block'; }
          return;
        }
        const existingRows = listEl ? listEl.querySelectorAll('.scorecard-comp-row') : [];
        const exists = Array.from(existingRows).some(r => (r.dataset.compName || '').toLowerCase() === val.toLowerCase());
        if (exists) {
          if (errEl) { errEl.textContent = `Competency "${val}" is already in the list.`; errEl.style.display = 'block'; }
          return;
        }
        if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
        if (listEl) {
          listEl.appendChild(renderCompRow(val, true));
          updateBadge();
        }
        newCompInput.value = '';
        newCompInput.focus();
      };

      if (addCompBtn) addCompBtn.onclick = handleAdd;
      if (newCompInput) {
        newCompInput.onkeydown = e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleAdd();
          }
        };
      }

      if (listEl) {
        listEl.onclick = e => {
          const btn = e.target.closest('.btn-remove-comp');
          if (!btn) return;
          e.preventDefault();
          const row = btn.closest('.scorecard-comp-row');
          if (row) {
            row.remove();
            updateBadge();
            if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
          }
        };
      }
    }

    async function openRateTrainingModal(id) {
      const [apps, stages] = await Promise.all([api('applications'), api('pipeline')]);
      const app = apps.find(x => x.id === id);
      if (!app) throw new Error('Application not found.');

      const existingEval = app.training_evaluation || (await api(`applications/${id}/training-evaluation`).catch(() => ({ evaluation: null }))).evaluation;
      const defaultRating = existingEval?.rating || 5;
      const defaultScore = existingEval?.practical_score !== null && existingEval?.practical_score !== undefined ? existingEval.practical_score : '';
      const defaultNotes = existingEval?.notes || '';
      const defaultDecision = existingEval?.decision || 'next';

      const nextStageName = stages.includes('Onboarding') ? 'Onboarding' : (stages[stages.indexOf(app.stage) + 1] || 'Onboarding');

      const modalHtml = `
        <div class="form-grid">
          <div class="full" style="background:var(--surface-alt,#f8fafc);padding:12px 14px;border-radius:8px;border:1px solid var(--line,#e2e8f0);margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:gap;gap:8px;">
              <div><strong>Candidate:</strong> ${escape(app.name)} <span class="muted">(${escape(app.email)})</span></div>
              <div><strong>Requisition:</strong> ${escape(app.title)}</div>
            </div>
            <div style="margin-top:6px;font-size:0.8rem;color:var(--muted);">
              Active Attempt: <strong>#${app.training_attempt || 1}</strong> &middot; Deadline: <strong>${formatDateIST(app.training_end_at)}</strong> ${app.is_overdue ? '<span class="training-overdue-highlight">⚠ Overdue</span>' : ''}
            </div>
          </div>

          <label class="full">
            <span class="label-heading">Training Performance Rating (1–5) *</span>
            <select name="rating" id="training-rating-select" required>
              <option value="5" ${defaultRating === 5 ? 'selected' : ''}>5 — Outstanding (Exceeded all training benchmarks)</option>
              <option value="4" ${defaultRating === 4 ? 'selected' : ''}>4 — Very Good (Consistent high performance)</option>
              <option value="3" ${defaultRating === 3 ? 'selected' : ''}>3 — Competent / Meets Expectations (Cleared training)</option>
              <option value="2" ${defaultRating === 2 ? 'selected' : ''}>2 — Marginal / Needs Improvement (Failed benchmarks)</option>
              <option value="1" ${defaultRating === 1 ? 'selected' : ''}>1 — Unsatisfactory (Failed core training)</option>
            </select>
          </label>

          <label class="full">
            <span class="label-heading">Practical Assessment Score (%) <span class="field-optional">Optional</span></span>
            <input type="number" name="practical_score" min="0" max="100" step="0.5" value="${escape(defaultScore)}" placeholder="e.g. 88.5">
          </label>

          <label class="full">
            <span class="label-heading">Trainer & Evaluation Notes</span>
            <textarea name="notes" rows="3" placeholder="Summary of capstone project, attendance, technical competencies, and orientation feedback...">${escape(defaultNotes)}</textarea>
          </label>

          <fieldset class="full" style="border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:var(--surface);">
            <legend style="font-size:0.85rem;font-weight:600;padding:0 6px;">Evaluation Decision & Action *</legend>
            <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px;">
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
                <input type="radio" name="decision" value="next" ${defaultDecision === 'next' ? 'checked' : ''} style="margin-top:3px;">
                <span><strong style="color:var(--positive,#16a34a);">Pass & Advance to ${escape(nextStageName)}</strong><br><small class="muted">Candidate cleared pre-onboarding training and advances to the next recruitment stage.</small></span>
              </label>
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
                <input type="radio" name="decision" value="rejected" ${defaultDecision === 'rejected' ? 'checked' : ''} style="margin-top:3px;">
                <span><strong style="color:var(--negative,#dc2626);">Evaluation Failed (Candidate Remains in Training)</strong><br><small class="muted">Records failed outcome. Candidate stays in Pre-Onboarding Training for retraining or extension.</small></span>
              </label>
              ${stages.includes('Revoked') ? `
                <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
                  <input type="radio" name="decision" value="revoked" ${defaultDecision === 'revoked' ? 'checked' : ''} style="margin-top:3px;">
                  <span><strong style="color:var(--negative,#dc2626);">Revoke Offer & Disqualify</strong><br><small class="muted">Concludes recruitment; transitions application to terminal Revoked stage.</small></span>
                </label>
              ` : ''}
            </div>
          </fieldset>
        </div>
      `;

      modal(`Evaluate Pre-Onboarding Training — ${escape(app.name)}`, modalHtml, async v => {
        const payload = {
          rating: Number(v.rating) || 5,
          practical_score: v.practical_score ? Number(v.practical_score) : null,
          decision: v.decision || 'next',
          notes: v.notes?.trim() || '',
          status: v.decision === 'next' ? 'passed' : 'failed'
        };
        const res = await api(`applications/${id}/training-evaluation`, 'POST', payload);
        const isPass = payload.decision === 'next';
        const isRevoke = payload.decision === 'revoked';
        if (isPass) {
          notice(`Training passed (Rating: ${payload.rating}/5)! Candidate advanced to ${nextStageName}.`, 'success');
        } else if (isRevoke) {
          notice('Offer revoked during training evaluation.', 'warning');
        } else {
          notice(`Training evaluation recorded as Failed (Rating: ${payload.rating}/5). Candidate remains in Pre-Onboarding Training.`, 'info');
        }
        await render();
        return isPass ? `Evaluation saved. Candidate advanced to ${nextStageName}.` : (isRevoke ? 'Offer revoked.' : 'Evaluation failed saved. Candidate remains in Pre-Onboarding Training.');
      }, { saveLabel: 'Submit Evaluation' });
    }

    async function executeStageMove(targetAppId, stage, isBackMove = false) {
      const id = targetAppId;
      const apps = await api('applications');
      const app = apps.find(x => x.id === id);
      if(!app) throw new Error('Application not found.');

      // 1. Offer revocation check
      if (app.offer_status === 'revoked' && !['Rejected', 'Revoked'].includes(stage)) {
        notice('Cannot advance candidate: The candidate offer has been revoked.', 'error');
        return;
      }

      // 2. Training evaluation validation: cannot advance from Pre-Onboarding Training without passing rating
      if (/pre-onboarding|training/i.test(app.stage) && !isBackMove && !['Rejected', 'Revoked', app.stage].includes(stage)) {
        if (app.training_status !== 'completed') {
          notice('Cannot advance candidate: Pre-onboarding training performance rating and passing evaluation are required before moving to the next stage.', 'error');
          openRateTrainingModal(id);
          return;
        }
      }

      // 3. Interview scorecard rating validation: cannot advance with planned unrated interview
      const nonInterviewStages = ['Applied', 'Offer', 'Pre-Onboarding Training', 'Onboarding', 'Hired', 'Rejected', 'Revoked'];
      const isCurStageInterview = app.pending_interview && !nonInterviewStages.includes(app.stage) &&
        (app.pending_interview.round === app.stage || (!app.pending_interview.round && /round|interview|screening/i.test(app.stage)));

      if (!isBackMove && !['Rejected', 'Revoked', app.stage].includes(stage) && isCurStageInterview && !allows('applications.override') && !allows('system.override')) {
        const ready = feedbackReady(app.pending_interview);
        const invName = app.pending_interview.interviewer_name || 'Assigned interviewer';
        const roundName = app.pending_interview.round || app.stage;
        notice(`Cannot advance candidate: An interview with ${invName} is scheduled for ${roundName} and requires a scorecard rating first.`, 'error');
        if (ready) {
          const isProxy = (allows('interviews.proxy_evaluate') || allows('system.override')) && app.pending_interview.interviewer_id !== me.id;
          openScorecardModal(app.pending_interview.id, isProxy);
        }
        return;
      }

      // 4. Negative interview recommendation check: requires administrative override
      if (!isBackMove && !['Rejected', 'Revoked', app.stage].includes(stage) && app.latest_scorecard) {
        const isNeg = ['No', 'Strong no'].includes(app.latest_scorecard.recommendation);
        if (isNeg) {
          const isAdmin = allows('applications.override') || allows('system.override');
          if (!isAdmin) {
            notice(`Cannot advance candidate: Candidate received a negative recommendation ('${app.latest_scorecard.recommendation}') for ${app.latest_scorecard.round || 'interview'}. Advancing requires administrative override.`, 'error');
            return;
          }
          modal(`Administrative Override — Advance Candidate with Negative Rating`, `
            <div class="form-grid">
              <div class="full" style="background:var(--negative-bg,#fee2e2);color:var(--negative,#991b1b);padding:10px 14px;border-radius:6px;border:1px solid #fecaca;margin-bottom:8px;">
                <strong>Negative Evaluation Warning:</strong> The candidate received a <strong>${escape(app.latest_scorecard.recommendation)}</strong> recommendation from ${escape(app.latest_scorecard.interviewer_name || 'Interviewer')} for ${escape(app.latest_scorecard.round || 'interview')}.
              </div>
              <p class="full">Advancing candidate to <strong>${escape(stage)}</strong> requires an administrative justification for the audit trail.</p>
              ${area('Administrative Override Reason *', 'override_reason', '', true, 'placeholder="Explain why this candidate is being advanced despite the negative recommendation..."')}
            </div>
          `, async v => {
            if (!v.override_reason || !v.override_reason.trim()) throw new Error('An override reason is required.');
            await api(`applications/${id}/stage`, 'POST', {
              stage,
              admin_override: true,
              override_reason: v.override_reason.trim()
            });
            notice(`Candidate advanced to ${stage} with administrative override.`, 'success');
            return `Candidate advanced to ${stage} with administrative override.`;
          }, { saveLabel: 'Confirm Administrative Override & Advance' });
          return;
        }
      }

      const isInterviewLike = /interview/i.test(stage) || stage === 'Screening Round' || stage === 'HR Round';
      if(isInterviewLike && !isBackMove){
        const users = await api('interviewers');
        if(!users.length) throw new Error('No active interviewers found in this team. Add or activate an interviewer first.');
        const todayMin = getLocalTodayMin();


        const defaultScheduled = toISTDateTimeInput(new Date(Date.now() + 2 * 60 * 1000));
        const defaultInterviewer = users.some(u => u.id === me.id) ? me.id : (users[0]?.id || '');
        let defaultComps = 'Role knowledge, Problem solving';
        if (app.skills) {
          try {
            const s = typeof app.skills === 'string' ? JSON.parse(app.skills) : app.skills;
            if (Array.isArray(s) && s.length) defaultComps = s.slice(0, 3).join(', ');
          } catch {}
        }
        modal(`Schedule ${escape(stage)} — ${escape(app.name)}`, `
          <div class="form-grid">
            <div class="full" style="background:var(--surface-alt, #f8fafc);padding:10px 14px;border-radius:6px;border:1px solid var(--line, #e2e8f0);margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                <div><strong>Candidate:</strong> ${escape(app.name)} <span class="muted">(${escape(app.email)})</span></div>
                <div><strong>Position:</strong> ${escape(app.title)}</div>
              </div>
            </div>
            ${select('Interview Format', 'interview_type', [
              ['virtual', 'Virtual / Online (Microsoft Teams / Video Call)'],
              ['in_person', 'In-Person / Physical (Office / On-Site)']
            ], 'virtual')}
            ${select('Interviewer', 'interviewer_id', users.map(u => [u.id, `${u.name}${u.team ? ' (' + u.team + ')' : ''}`]), defaultInterviewer)}
            ${field('Date and time (IST)', 'scheduled_at', 'datetime-local', defaultScheduled, true, `min="${todayMin}"`)}
            ${select('Duration', 'duration_minutes', [['30', '30 minutes'], ['45', '45 minutes (Standard)'], ['60', '60 minutes'], ['90', '90 minutes']], '45', false)}
            <div id="row-meeting-url" class="full">
              ${field('Meeting link / Video URL (Optional)', 'meeting_url', 'url', '', false, 'placeholder="Auto-generated via Teams when connected, or paste Google Meet / Zoom link"')}
            </div>
            <div id="row-location" class="full" style="display:none;">
              ${field('Office / Physical Location', 'location', 'text', 'Mechlin Technologies — Corporate HQ, Mohali', false, 'placeholder="e.g. Mechlin Technologies Office, Sector 67, Mohali"')}
            </div>
            ${field('Competencies, comma separated', 'competencies', 'text', defaultComps, true)}
            ${area('Agenda / Notes (Optional)', 'notes', '', false)}
            <p class="full status-note" id="interview-format-note">Orbit will advance the application to <strong>${escape(stage)}</strong>, synchronize calendar event, and automatically dispatch an invitation email to <strong>${escape(app.email)}</strong>.</p>
          </div>
        `, async v => {
          const scheduledDate = parseISTDateTime(v.scheduled_at);
          if (!scheduledDate || !Number.isFinite(scheduledDate.getTime()) || isPastInterviewDate(scheduledDate)) {
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
          const isPhysical = v.interview_type === 'in_person';
          await api('interviews', 'POST', {
            application_id: id,
            interviewer_id: v.interviewer_id,
            scheduled_at: scheduledDate.toISOString(),
            duration_minutes: Number(v.duration_minutes) || 45,
            timezone: 'Asia/Kolkata',
            interview_type: isPhysical ? 'in_person' : 'virtual',
            location: isPhysical ? (v.location?.trim() || 'Mechlin Technologies — Corporate HQ, Mohali') : undefined,
            meeting_url: isPhysical ? undefined : (v.meeting_url?.trim() || undefined),
            competencies: compList,
            round: stage,
            notes: v.notes?.trim() || undefined,
            send_invitation: false
          });
          await api(`applications/${id}/stage`, 'POST', { stage, send_notification: true });
          const interviewerObj = users.find(u => u.id === v.interviewer_id);
          const interviewerName = interviewerObj ? interviewerObj.name : 'assigned interviewer';
          const formatMsg = isPhysical ? 'In-person interview scheduled (arrival details sent)' : 'Interview scheduled (meeting link sent)';
          notice(`${formatMsg} with ${interviewerName}. Moved to ${stage}!`, 'success');
          return `Interview scheduled with ${interviewerName}. Application moved to ${stage}.`;
        }, { saveLabel: 'Schedule & Send Invite' });
        const dateInp = $('#edit-form [name="scheduled_at"]');
        if (dateInp) dateInp.min = todayMin;
        bindValidation('competencies', checkSkills);
        setupInterviewFormatToggle('virtual');
        return;
      }
      if(/pre-onboarding/i.test(stage) && !isBackMove){
        const [apps, candSigs] = await Promise.all([
          api('applications'),
          api(`signatures?application_id=${id}`).catch(() => [])
        ]);
        const app = apps.find(x => x.id === id);
        if(!app) throw new Error('Application not found.');
        const sigs = Array.isArray(candSigs) && candSigs.length
          ? candSigs
          : await api(`candidates/${app.candidate_id}/signatures`).catch(() => []);
        const matchingSigs = (Array.isArray(sigs) ? sigs : []).filter(s =>
          s.application_id === id || (!s.application_id && s.candidate_id === app.candidate_id)
        );
        const latestSig = matchingSigs[0];
        if (!latestSig || latestSig.status !== 'completed') {
          let reason = 'No offer letter found for this candidate. The candidate must sign the offer letter before proceeding.';
          if (latestSig) {
            if (latestSig.status === 'pending') reason = 'Offer letter is pending signature. The candidate must sign the offer letter before proceeding.';
            else if (latestSig.status === 'declined') reason = 'Offer letter was declined. The candidate must sign the offer letter before proceeding.';
            else if (latestSig.status === 'expired') reason = 'Offer letter has expired. The candidate must sign the offer letter before proceeding.';
            else if (latestSig.status === 'cancelled') reason = 'Offer letter was cancelled. The candidate must sign the offer letter before proceeding.';
            else reason = 'Offer letter signature is incomplete. The candidate must sign the offer letter before proceeding.';
          }
          const errorMsg = `Cannot advance to Pre-Onboarding Training: The candidate must sign the offer letter before starting pre-onboarding training. ${reason}`;
          notice(errorMsg, 'error');
          return;
        }
        modal(`Commence Pre-Onboarding Training — ${escape(app.name)}`, `
          <div class="form-grid">
            <div class="full" style="background:var(--surface-alt, #f8fafc);padding:10px 14px;border-radius:6px;border:1px solid var(--line, #e2e8f0);margin-bottom:8px;">
              <div><strong>Candidate:</strong> ${escape(app.name)} <span class="muted">(${escape(app.email)})</span></div>
              <div><strong>Position:</strong> ${escape(app.title)}</div>
            </div>
            <p class="full status-note" style="color:#065f46;background:#ecfdf5;border:1px solid #a7f3d0;padding:12px;border-radius:8px;">
              <strong>Pre-Onboarding Training Workflow:</strong><br>
              Advancing to <strong>Pre-Onboarding Training</strong> enrolls the candidate into initial orientation and technical preparation.<br>
              Once moved, the <strong>Training Plan Review</strong> popup will open for your review and customization before sending.<br>
              <em>Note: The training plan email will not be sent automatically.</em>
            </p>
          </div>
        `, async () => {
          await api(`applications/${id}/stage`, 'POST', { stage, send_notification: true });
          notice(`Application moved to ${stage}. Loading training plan review...`, 'success');
          setTimeout(() => {
            openTrainingPlanReviewModal(id);
          }, 300);
          return `Application moved to ${stage}.`;
        }, { saveLabel: 'Start Pre-Onboarding Training' });
        return;
      }
      if(stage==='Offer' && !isBackMove){
        const [apps, reqs, templates] = await Promise.all([
          api('applications'),
          api('requisitions'),
          api('offer-templates?status=active').catch(() => [])
        ]);
        const app = apps.find(x => x.id === id);
        if(!app) throw new Error('Application not found.');
        const req = reqs.find(r => r.id === app.requisition_id);
        const defaultSalary = req?.salary_max
          ? Number(req.salary_max).toLocaleString()
          : (req?.salary_min ? Number(req.salary_min).toLocaleString() : '120,000');
        const defaultCurrency = req?.currency || 'INR';
        modal(`Verify Offer & Issue Agreement — ${escape(app.name)}`, `
          <div class="form-grid">
            <div class="full" style="background:var(--surface-alt, #f8fafc);padding:10px 14px;border-radius:6px;border:1px solid var(--line, #e2e8f0);margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                <div><strong>Candidate:</strong> ${escape(app.name)} <span class="muted">(${escape(app.email)})</span></div>
                <div><strong>Requisition:</strong> ${escape(req?.title || app.title)} ${req?.team ? '<span class="muted">(' + escape(req.team) + ')</span>' : ''}</div>
              </div>
            </div>
            ${templates.length ? `
              <label class="full">
                <span class="label-heading">Offer Letter Template</span>
                <select name="template_id" id="move-offer-tpl-select">
                  ${templates.map(t => `<option value="${t.id}" ${t.is_default ? 'selected' : ''}>${escape(t.name)} (v${t.version}${t.is_default ? ' — Default' : ''})</option>`).join('')}
                </select>
              </label>
              <div class="full" style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
                <button type="button" class="button secondary" id="btn-preview-move-offer" style="font-size:0.82rem;padding:6px 14px;">Preview Offer Letter (A4)</button>
                <small class="muted">Review multi-page A4 flow and salary annexure before sending.</small>
              </div>
            ` : ''}
            <div class="candidate-tailor-toggle-box full">
              <div class="candidate-tailor-head" id="btn-toggle-tailor-move">
                <strong style="color:var(--accent);font-size:0.86rem;display:flex;align-items:center;gap:6px;">Customize Clauses for this Offer</strong>
                <span id="tailor-move-chevron" style="font-size:0.75rem;color:var(--muted);font-weight:700;">[ Customize Clauses ]</span>
              </div>
              <div id="tailor-move-body" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--line);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px;">
                  <small class="muted">Add a joining bonus, modify notice period, or tailor terms specifically for this candidate.</small>
                  <div style="display:flex;gap:4px;">
                    <button type="button" class="secondary" id="btn-tailor-move-clause-lib" style="font-size:0.74rem;padding:3px 8px;">Clause Library</button>
                    <button type="button" class="secondary" id="btn-tailor-move-add-bonus" style="font-size:0.74rem;padding:3px 8px;">Add Joining Bonus</button>
                  </div>
                </div>
                <div id="tailor-move-sections-list"></div>
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
            template_id: v.template_id || undefined,
            salary: v.salary?.trim() || defaultSalary,
            currency: v.currency?.trim()?.toUpperCase() || defaultCurrency,
            start_date: v.start_date?.trim() || 'Two weeks following signature acceptance',
            expires_days: Number(v.expires_days) || 7,
            custom_sections: tailoredSections || undefined,
            signers: [{
              name: v.signer_name?.trim() || app.name,
              email: v.signer_email?.trim() || app.email,
              role: 'Candidate'
            }]
          };
          await api('signatures', 'POST', payload);
          await api(`applications/${id}/stage`, 'POST', { stage: 'Offer', send_notification: true });
          notice(`Offer letter generated and e-signature invitation sent to ${app.name}!`, 'success');
          return `Application moved to Offer. Official offer letter and e-signature invitation email sent to ${app.name}.`;
        }, { saveLabel: 'Generate Offer & Send Signature Email' });
        bindValidation('signer_email', checkEmail);
        bindValidation('currency', checkCurrency);

        let tailoredSections = null;
        const toggleBtn = $('#btn-toggle-tailor-move');
        const tailorBody = $('#tailor-move-body');
        const tailorChevron = $('#tailor-move-chevron');
        const tplSelect = $('#move-offer-tpl-select');

        const renderTailoredList = () => {
          const listEl = $('#tailor-move-sections-list');
          if (!listEl || !tailoredSections) return;
          listEl.innerHTML = tailoredSections.map((s, idx) => {
            let preview = s.text || s.title || (s.items ? s.items.join('; ') : s.type);
            return `
              <div class="studio-section-card" data-tailor-idx="${idx}" style="padding:10px;margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                  <div style="display:flex;align-items:center;gap:6px;">
                    <span class="studio-section-badge studio-badge-${s.type}" style="font-size:0.65rem;">${s.type.replace('_',' ')}</span>
                    <strong style="font-size:0.8rem;">Section #${idx+1}</strong>
                  </div>
                  <div style="display:flex;gap:3px;">
                    <button type="button" class="secondary" data-tailor-act="up" data-idx="${idx}" ${idx===0?'disabled':''} style="min-height:22px;padding:0 6px;font-size:0.7rem;">Up</button>
                    <button type="button" class="secondary" data-tailor-act="down" data-idx="${idx}" ${idx===tailoredSections.length-1?'disabled':''} style="min-height:22px;padding:0 6px;font-size:0.7rem;">Down</button>
                    <button type="button" class="secondary" data-tailor-act="del" data-idx="${idx}" style="min-height:22px;padding:0 6px;font-size:0.7rem;color:var(--negative);">Remove</button>
                  </div>
                </div>
                ${s.type === 'heading' ? `
                  <input type="text" data-tailor-field="text" data-idx="${idx}" value="${escape(s.text||'')}" style="font-size:0.8rem;padding:4px 8px;font-weight:600;">
                ` : (s.type === 'paragraph' ? `
                  <textarea data-tailor-field="text" data-idx="${idx}" rows="2" style="font-size:0.8rem;line-height:1.4;">${escape(s.text||'')}</textarea>
                ` : (s.type === 'bullet_list' ? `
                  <textarea data-tailor-field="items" data-idx="${idx}" rows="2" style="font-size:0.8rem;">${escape((s.items||[]).join('\n'))}</textarea>
                ` : `<small class="muted">${escape(preview)}</small>`))}
              </div>
            `;
          }).join('');

          listEl.querySelectorAll('input, textarea').forEach(el => {
            el.oninput = () => {
              const i = Number(el.dataset.idx);
              const field = el.dataset.tailorField;
              if (tailoredSections[i]) {
                if (field === 'items') {
                  tailoredSections[i].items = el.value.split('\n').map(x => x.trim()).filter(Boolean);
                } else {
                  tailoredSections[i][field] = el.value;
                }
              }
            };
          });

          listEl.querySelectorAll('[data-tailor-act]').forEach(btn => {
            btn.onclick = () => {
              const act = btn.dataset.tailorAct;
              const i = Number(btn.dataset.idx);
              if (act === 'up' && i > 0) {
                const tmp = tailoredSections[i];
                tailoredSections[i] = tailoredSections[i - 1];
                tailoredSections[i - 1] = tmp;
              } else if (act === 'down' && i < tailoredSections.length - 1) {
                const tmp = tailoredSections[i];
                tailoredSections[i] = tailoredSections[i + 1];
                tailoredSections[i + 1] = tmp;
              } else if (act === 'del') {
                tailoredSections.splice(i, 1);
              }
              renderTailoredList();
            };
          });
        };

        const loadTailorSections = async () => {
          const chosenTplId = tplSelect?.value || templates[0]?.id;
          if (!chosenTplId) return;
          const tplData = await api(`offer-templates/${chosenTplId}`).catch(() => null);
          tailoredSections = tplData?.sections ? JSON.parse(JSON.stringify(tplData.sections)) : [];
          renderTailoredList();
        };

        if (toggleBtn) {
          toggleBtn.onclick = async () => {
            const isHidden = tailorBody.style.display === 'none';
            tailorBody.style.display = isHidden ? 'block' : 'none';
            tailorChevron.textContent = isHidden ? '[ Collapse Customizer ]' : '[ Customize Clauses ]';
            if (isHidden && !tailoredSections) {
              await loadTailorSections();
            }
          };
        }

        if (tplSelect) {
          tplSelect.onchange = async () => {
            if (tailoredSections) {
              await loadTailorSections();
            }
          };
        }

        const addBonusBtn = $('#btn-tailor-move-add-bonus');
        if (addBonusBtn) {
          addBonusBtn.onclick = () => {
            if (!tailoredSections) tailoredSections = [];
            tailoredSections.push(
              { id: `sec_bonus_${Date.now()}`, type: 'heading', level: 2, text: 'Special Joining Bonus' },
              { id: `sec_bonus_p_${Date.now()}`, type: 'paragraph', text: 'You are eligible for a special one-time joining bonus of ₹100,000, payable with your first monthly payroll cycle. Should you voluntarily resign within 12 months, this bonus must be repaid in full.' }
            );
            renderTailoredList();
            notice('Added Joining Bonus clause!', 'success');
          };
        }

        const addLibBtn = $('#btn-tailor-move-clause-lib');
        if (addLibBtn) {
          addLibBtn.onclick = () => {
            openClauseLibraryModal(clauseSections => {
              if (!tailoredSections) tailoredSections = [];
              tailoredSections.push(...clauseSections);
              renderTailoredList();
            });
          };
        }

        const previewBtn = $('#btn-preview-move-offer');
        if (previewBtn) {
          previewBtn.onclick = () => {
            const tplId = $('#move-offer-tpl-select')?.value;
            if (!tplId) return;
            const curSalary = $('#edit-form [name="salary"]')?.value || defaultSalary;
            const curCurr = $('#edit-form [name="currency"]')?.value || defaultCurrency;
            openOfferTemplatePreview(tplId, app.candidate_id, app.requisition_id, app.id, curSalary, curCurr, tailoredSections);
          };
        }
        return;
      }
      if(stage==='Hired' && !isBackMove){
        const [apps, candSigs] = await Promise.all([
          api('applications'),
          api(`signatures?application_id=${id}`).catch(() => [])
        ]);
        const app = apps.find(x => x.id === id);
        if(!app) throw new Error('Application not found.');
        const sigs = Array.isArray(candSigs) && candSigs.length
          ? candSigs
          : await api(`candidates/${app.candidate_id}/signatures`).catch(() => []);
        const completedOffer = (Array.isArray(sigs) ? sigs : []).find(s =>
          (s.application_id === id || (!s.application_id && s.candidate_id === app.candidate_id)) &&
          s.status === 'completed'
        );
        if(!completedOffer){
          const pendingOffer = (Array.isArray(sigs) ? sigs : []).find(s =>
            (s.application_id === id || (!s.application_id && s.candidate_id === app.candidate_id)) &&
            s.status === 'pending'
          );
          const errorMsg = pendingOffer
            ? 'Offer letter is awaiting candidate signature. The candidate must sign the offer letter before proceeding.'
            : 'The candidate must sign the offer letter before proceeding.';
          notice(errorMsg, 'error');
          return;
        }
      }
      const moveNotice = stage === 'Hired'
        ? `<p>Move this application to <strong>Hired</strong>?</p><p class="muted" style="font-size:0.82rem;margin-top:6px;">A status update email will be sent to the candidate, and employee provisioning with signed offer documents will be automatically dispatched to HRMS.</p>`
        : `<p>Move this application to <strong>${escape(stage)}</strong>?</p><p class="muted" style="font-size:0.82rem;margin-top:6px;">A status update email will be automatically sent to the candidate.</p>`;
      modal('Change application stage', moveNotice, async () => {
        await api(`applications/${id}/stage`, 'POST', { stage });
        return stage === 'Rejected'
          ? 'Application rejected. Status update email sent.'
          : (stage === 'Hired'
            ? 'Candidate hired successfully! Status email sent and automated HRMS handoff dispatched.'
            : `Application moved to ${stage} successfully. Status update email sent.`);
      }, { saveLabel: stage === 'Rejected' ? 'Reject & Notify' : 'Move & Notify' });
    }

    if (a === 'hrms-handoff') {
      const origText = b.textContent;
      b.disabled = true;
      b.textContent = 'Syncing...';
      try {
        const res = await api(`applications/${id}/hrms-handoff`, 'POST');
        const empId = res.employeeId || res.providerReference || '';
        notice(`Successfully synced to HRMS!${empId ? ' (Employee ID: ' + empId + ')' : ''}`, 'success');
        if (current === 'Pipeline') {
          await render();
        } else if (current === 'Candidates') {
          await render();
        }
      } catch (err) {
        notice(`HRMS handoff failed: ${err.message}`, 'error');
      } finally {
        b.disabled = false;
        b.textContent = origText;
      }
      return;
    }

    if(a==='move'||a==='reject-app'){
      const stage=a==='move'?b.dataset.stage:'Rejected';
      const isBackMove = b && typeof b.textContent === 'string' && b.textContent.trim().startsWith('Back to');
      await executeStageMove(id, stage, isBackMove);
      return;
    }

    if(a==='skip-stage'){
      const [apps, stages] = await Promise.all([api('applications'), api('pipeline')]);
      const app = apps.find(x => x.id === id);
      if(!app) throw new Error('Application not found.');
      const curIdx = stages.indexOf(app.stage);
      if(curIdx === -1) throw new Error('Unknown current stage.');

      const candidates = stages.slice(curIdx + 2).filter(target => {
        if (['Hired', 'Rejected', 'Revoked'].includes(target)) return false;
        const intermediate = stages.slice(curIdx + 1, stages.indexOf(target));
        if (intermediate.some(s => /(^|\b)(offer|hired)(\b|$)/i.test(s))) return false;
        if (app.stage === 'Applied' && /pre-onboarding|training/i.test(target)) return false;
        return true;
      });

      if (!candidates.length) {
        notice('No additional forward stages available to skip to.', 'info');
        return;
      }

      modal(`Skip Stages — ${escape(app.name)}`, `
        <div class="form-grid">
          <div class="full" style="background:var(--surface-alt, #f8fafc);padding:10px 14px;border-radius:6px;border:1px solid var(--line, #e2e8f0);margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
              <div><strong>Candidate:</strong> ${escape(app.name)} <span class="muted">(${escape(app.email)})</span></div>
              <div><strong>Current Stage:</strong> <span class="badge active">${escape(app.stage)}</span></div>
            </div>
          </div>
          <label class="full">
            <span class="label-heading">Skip to Stage *</span>
            <select name="target_stage" id="skip-target-stage" required>
              ${candidates.map(target => {
                const intermediate = stages.slice(curIdx + 1, stages.indexOf(target));
                const skippedLabel = intermediate.length ? ` (Bypassing: ${intermediate.join(', ')})` : '';
                return `<option value="${escape(target)}">${escape(target)}${escape(skippedLabel)}</option>`;
              }).join('')}
            </select>
          </label>
          <p class="full status-note" style="color:var(--accent);background:var(--tint);padding:10px 12px;border-radius:6px;font-size:0.8rem;margin:0;">
            Fast-track candidate by skipping intermediate interview or evaluation rounds directly to the selected stage.
          </p>
        </div>
      `, async v => {
        const targetStage = v.target_stage;
        if (!targetStage) throw new Error('Please select a destination stage.');
        const isInterviewLike = /interview/i.test(targetStage) || targetStage === 'Screening Round' || targetStage === 'HR Round';
        const needsDedicatedModal = isInterviewLike || /pre-onboarding/i.test(targetStage) || targetStage === 'Offer' || targetStage === 'Hired';
        if (needsDedicatedModal) {
          setTimeout(() => {
            executeStageMove(id, targetStage, false);
          }, 50);
          return null;
        }
        await api(`applications/${id}/stage`, 'POST', { stage: targetStage });
        return `Application moved to ${targetStage} successfully. Status update email sent.`;
      }, { saveLabel: 'Skip & Proceed' });
      return;
    }
    if(a==='rate-training'){
      await openRateTrainingModal(id);
      return;
    }

    if (a === 'start-training') {
      const app = (await api('applications')).find(x => x.id === id);
      if (!app) throw new Error('Application not found.');
      const nowIso = new Date().toISOString().slice(0, 10);
      const defaultEndIso = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

      modal(`Start Pre-Onboarding Training — ${escape(app.name)}`, `
        <div class="form-grid">
          <div class="full" style="background:var(--surface-alt);padding:10px 14px;border-radius:6px;border:1px solid var(--line);margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
              <div><strong>Candidate:</strong> ${escape(app.name)} <span class="muted">(${escape(app.email)})</span></div>
              <div><strong>Requisition:</strong> ${escape(app.title)}</div>
            </div>
          </div>
          <label>
            <span class="label-heading">Training Start Date *</span>
            <input type="date" name="start_at" value="${nowIso}" required>
          </label>
          <label>
            <span class="label-heading">Mandatory Deadline (End Date) *</span>
            <input type="date" name="end_at" value="${defaultEndIso}" required>
          </label>
          <p class="full muted" style="font-size:0.8rem;margin:0;">
            Establishing the mandatory deadline enables automated tracking, overdue alerting, and auditable milestone monitoring.
          </p>
        </div>
      `, async v => {
        if (!v.start_at || !v.end_at) throw new Error('Both start date and deadline end date are required.');
        if (new Date(v.end_at).getTime() <= new Date(v.start_at).getTime()) {
          throw new Error('Mandatory deadline must be strictly after the start date.');
        }
        await api(`applications/${id}/training/start`, 'POST', {
          start_at: new Date(v.start_at).toISOString(),
          end_at: new Date(v.end_at + 'T23:59:59Z').toISOString()
        });
        notice('Pre-onboarding training started with mandatory deadline recorded.', 'success');
        await render();
        return 'Training started successfully.';
      }, { saveLabel: 'Start Training' });
      return;
    }

    if (a === 'extend-training-deadline') {
      const app = (await api('applications')).find(x => x.id === id);
      if (!app) throw new Error('Application not found.');
      const currentDeadlineStr = app.training_end_at ? formatDateIST(app.training_end_at) : 'Not established';
      const minDate = app.training_end_at
        ? new Date(new Date(app.training_end_at).getTime() + 86400000).toISOString().slice(0, 10)
        : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const defaultExtended = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

      modal(`Extend Training Deadline — ${escape(app.name)}`, `
        <div class="form-grid">
          <div class="full" style="background:var(--surface-alt);padding:10px 14px;border-radius:6px;border:1px solid var(--line);margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
              <div><strong>Current Deadline:</strong> <span style="font-weight:600;color:var(--ink);">${escape(currentDeadlineStr)}</span> ${app.is_overdue ? '<span class="badge rejected" style="margin-left:6px;font-size:0.7rem;">Overdue</span>' : ''}</div>
              <div><strong>Active Attempt:</strong> #${app.training_attempt || 1}</div>
            </div>
          </div>
          <label class="full">
            <span class="label-heading">Revised Training Deadline *</span>
            <input type="date" name="new_deadline" value="${defaultExtended}" min="${minDate}" required>
          </label>
          <label class="full">
            <span class="label-heading">Reason for Extension *</span>
            <textarea name="reason" rows="3" placeholder="Explain why an extension was requested (e.g. additional technical mentoring, medical leave, or mentor availability)..." required></textarea>
          </label>
          <p class="full muted" style="font-size:0.8rem;margin:0;">
            Extending the deadline preserves the original start date and deadline in the audit history while resetting overdue flags.
          </p>
        </div>
      `, async v => {
        if (!v.new_deadline) throw new Error('Please select a revised deadline date.');
        if (!v.reason?.trim()) throw new Error('Reason for deadline extension is mandatory.');
        const newDeadlineIso = new Date(v.new_deadline + 'T23:59:59Z').toISOString();
        if (app.training_end_at && new Date(newDeadlineIso).getTime() <= new Date(app.training_end_at).getTime()) {
          throw new Error('Revised deadline must be strictly after the current training deadline.');
        }
        await api(`applications/${id}/training/extend-deadline`, 'POST', {
          new_deadline: newDeadlineIso,
          reason: v.reason.trim()
        });
        notice('Training deadline extended successfully.', 'success');
        await render();
        return 'Deadline extended successfully.';
      }, { saveLabel: 'Extend Deadline' });
      return;
    }

    if (a === 'restart-training') {
      const app = (await api('applications')).find(x => x.id === id);
      if (!app) throw new Error('Application not found.');
      const nextAttempt = (app.training_attempt || 1) + 1;
      const nowIso = new Date().toISOString().slice(0, 10);
      const defaultEndIso = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

      modal(`Restart Training (Attempt #${nextAttempt}) — ${escape(app.name)}`, `
        <div class="form-grid">
          <div class="full" style="background:#fffbeb;padding:10px 14px;border-radius:6px;border:1px solid #fde68a;margin-bottom:8px;color:#92400e;">
            <p style="margin:0 0 4px 0;font-weight:600;font-size:0.85rem;">Retraining Confirmation</p>
            <p style="margin:0;font-size:0.8rem;">
              Restarting training will initiate <strong>Attempt #${nextAttempt}</strong> for ${escape(app.name)}. All previous evaluations and extension history will remain preserved in the candidate's permanent record.
            </p>
          </div>
          <label>
            <span class="label-heading">Retraining Start Date *</span>
            <input type="date" name="start_at" value="${nowIso}" required>
          </label>
          <label>
            <span class="label-heading">Mandatory Retraining Deadline *</span>
            <input type="date" name="end_at" value="${defaultEndIso}" required>
          </label>
          <label class="full">
            <span class="label-heading">Reason for Retraining *</span>
            <textarea name="reason" rows="3" placeholder="Provide context regarding the additional training curriculum, revised benchmarks, or mentor alignment..." required></textarea>
          </label>
        </div>
      `, async v => {
        if (!v.start_at || !v.end_at) throw new Error('Both start date and deadline are required.');
        if (!v.reason?.trim()) throw new Error('Reason for retraining is required.');
        if (new Date(v.end_at).getTime() <= new Date(v.start_at).getTime()) {
          throw new Error('Retraining deadline must be after start date.');
        }
        await api(`applications/${id}/training/restart`, 'POST', {
          start_at: new Date(v.start_at).toISOString(),
          end_at: new Date(v.end_at + 'T23:59:59Z').toISOString(),
          reason: v.reason.trim()
        });
        notice(`Retraining initiated (Attempt #${nextAttempt}). Candidate remains in Pre-Onboarding Training.`, 'success');
        await render();
        return 'Retraining started.';
      }, { saveLabel: `Initiate Attempt #${nextAttempt}` });
      return;
    }

    if (a === 'training-revoke-offer') {
      const app = (await api('applications')).find(x => x.id === id);
      if (!app) throw new Error('Application not found.');

      modal(`Revoke Candidate Offer — ${escape(app.name)}`, `
        <div class="form-grid">
          <div class="full" style="background:#fef2f2;padding:12px 14px;border-radius:8px;border:1px solid #fca5a5;margin-bottom:8px;color:#991b1b;">
            <p style="margin:0 0 6px 0;font-weight:700;font-size:0.9rem;">Revoke Formal Employment Offer</p>
            <p style="margin:0;font-size:0.82rem;line-height:1.4;">
              Are you sure you want to <strong>revoke the offer</strong> for <strong>${escape(app.name)}</strong>? This will conclude the candidate's recruitment, transition the application to the terminal <strong>Revoked</strong> stage, and archive associated agreements.
            </p>
          </div>
          <label class="full">
            <span class="label-heading">Reason for Offer Revocation *</span>
            <textarea name="reason" rows="3" placeholder="Detail the non-fulfillment of pre-onboarding conditions, failed evaluation, or deadline expiration..." required></textarea>
          </label>
          <p class="full muted" style="font-size:0.8rem;margin:0;">
            All previous training attempts, evaluations, and extension records will remain preserved for audit compliance.
          </p>
        </div>
      `, async v => {
        if (!v.reason?.trim()) throw new Error('Please provide a mandatory revocation reason.');
        await api(`applications/${id}/training/revoke-offer`, 'POST', {
          reason: v.reason.trim()
        });
        notice('Candidate offer was revoked successfully.', 'success');
        await render();
        return 'Offer revoked.';
      }, { saveLabel: 'Revoke Offer & Disqualify' });
      return;
    }

    if (a === 'view-training-details') {
      const [history, allApps] = await Promise.all([
        api(`applications/${id}/training/history`).catch(() => null),
        api('applications').catch(() => [])
      ]);
      const fallbackApp = allApps?.find?.(x => x.id === id) || {};
      const app = { ...fallbackApp, ...(history?.application || {}) };
      const evals = history?.evaluations || [];
      const exts = history?.extensions || [];
      const plan = history?.plan_draft;
      const isOverdue = Boolean(history?.is_overdue || app.is_overdue);
      const currentAttempt = history?.current_attempt || app.training_attempt || 1;

      const modalHtml = `
        <div class="training-history-container" style="display:flex;flex-direction:column;gap:14px;max-height:75vh;overflow-y:auto;padding-right:4px;">
          <!-- Header info card -->
          <div style="background:var(--surface-alt);border:1px solid var(--line);border-radius:8px;padding:12px 16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
              <div>
                <h3 style="margin:0;font-size:1.05rem;">${escape(app.name || 'Candidate')}</h3>
                <div class="muted" style="font-size:0.82rem;">${escape(app.title || '')} &middot; Current Stage: <span class="badge ${app.stage === 'Revoked' ? 'rejected' : 'active'}" style="font-size:0.75rem;">${escape(app.stage || '')}</span></div>
              </div>
              <div>
                <span class="training-status-badge ${app.offer_status === 'revoked' ? 'training-badge-revoked' : (app.training_status === 'completed' ? 'training-badge-completed' : (app.training_status === 'evaluation_failed' ? 'training-badge-failed' : (isOverdue ? 'training-badge-overdue' : (app.training_status === 'retraining' ? 'training-badge-retraining' : (app.training_status === 'extended' ? 'training-badge-extended' : (app.training_status === 'in_progress' ? 'training-badge-in-progress' : 'training-badge-not-started'))))))}">
                  ${app.offer_status === 'revoked' ? 'Offer Revoked' : (app.training_status === 'completed' ? 'Training Completed' : (app.training_status === 'evaluation_failed' ? 'Evaluation Failed' : (isOverdue ? 'Overdue' : (app.training_status === 'retraining' ? 'Retraining' : (app.training_status === 'extended' ? 'Extended' : (app.training_status === 'in_progress' ? 'In Progress' : 'Not Started'))))))}
                </span>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line);font-size:0.82rem;">
              <div><span class="muted">Start Date:</span><br><strong>${formatDateIST(app.training_start_at)}</strong></div>
              <div><span class="muted">Current Deadline:</span><br><strong style="${isOverdue ? 'color:var(--negative);' : ''}">${formatDateIST(app.training_end_at)} ${isOverdue ? '⚠' : ''}</strong></div>
              <div><span class="muted">Original Deadline:</span><br><strong>${formatDateIST(app.training_original_end_at || app.training_end_at)}</strong></div>
              <div><span class="muted">Current Attempt:</span><br><strong>Attempt #${currentAttempt}</strong></div>
              <div><span class="muted">Offer Status:</span><br><strong style="color:${app.offer_status === 'revoked' ? 'var(--negative)' : 'var(--positive)'};">${app.offer_status === 'revoked' ? 'Revoked' : 'Active'}</strong></div>
            </div>
            ${app.offer_revocation_reason ? `<div style="margin-top:10px;padding:8px 10px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;font-size:0.8rem;color:#991b1b;"><strong>Revocation Reason:</strong> ${escape(app.offer_revocation_reason)}</div>` : ''}
          </div>

          <!-- Evaluation History -->
          <div>
            <h4 style="margin:0 0 8px 0;font-size:0.92rem;display:flex;align-items:center;justify-content:space-between;">
              <span>Evaluation Records (${evals.length})</span>
              ${evals.length > 0 ? `<span class="muted" style="font-size:0.75rem;font-weight:normal;">Full chronological history across all attempts</span>` : ''}
            </h4>
            ${evals.length === 0 ? '<p class="muted" style="font-size:0.82rem;margin:0;">No evaluations submitted yet.</p>' : `
              <div style="display:flex;flex-direction:column;gap:8px;">
                ${evals.map(e => `
                  <div style="border:1px solid var(--line);border-radius:6px;padding:10px 12px;background:var(--surface);">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
                      <div>
                        <strong>Attempt #${e.attempt || 1} Evaluation</strong> &middot;
                        <span class="badge ${e.status === 'passed' ? 'completed' : 'rejected'}" style="font-size:0.72rem;margin-left:4px;">
                          ${e.status === 'passed' ? 'Passed' : (e.decision === 'revoked' ? 'Offer Revoked' : 'Failed')}
                        </span>
                      </div>
                      <span class="muted" style="font-size:0.75rem;">${formatDateTimeIST(e.created_at)}</span>
                    </div>
                    <div style="margin-top:6px;display:flex;gap:14px;font-size:0.82rem;flex-wrap:wrap;">
                      <span>Rating: <strong>${e.rating}/5</strong></span>
                      ${e.practical_score !== null && e.practical_score !== undefined ? `<span>Score: <strong>${e.practical_score}%</strong></span>` : ''}
                      <span>Evaluator: <strong>${escape(e.evaluator_name || 'System')}</strong></span>
                    </div>
                    ${e.notes ? `<p style="margin:6px 0 0 0;font-size:0.8rem;background:var(--surface-alt);padding:6px 8px;border-radius:4px;">${escape(e.notes)}</p>` : ''}
                  </div>
                `).join('')}
              </div>
            `}
          </div>

          <!-- Deadline Extension History -->
          <div>
            <h4 style="margin:0 0 8px 0;font-size:0.92rem;">Deadline Extension History (${exts.length})</h4>
            ${exts.length === 0 ? '<p class="muted" style="font-size:0.82rem;margin:0;">No deadline extensions granted.</p>' : `
              <div class="table-wrap">
                <table style="width:100%;font-size:0.8rem;">
                  <thead>
                    <tr>
                      <th scope="col">Attempt</th>
                      <th scope="col">Previous Deadline</th>
                      <th scope="col">New Deadline</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Approved By</th>
                      <th scope="col">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${exts.map(x => `
                      <tr>
                        <td>#${x.attempt}</td>
                        <td>${formatDateIST(x.previous_deadline)}</td>
                        <td><strong style="color:var(--accent);">${formatDateIST(x.new_deadline)}</strong></td>
                        <td title="${escape(x.reason)}">${escape(x.reason)}</td>
                        <td>${escape(x.extended_by_name || 'Admin')}</td>
                        <td><small class="muted">${formatDateIST(x.created_at)}</small></td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        </div>
      `;

      modal(`Pre-Onboarding Training Lifecycle — ${escape(app.name || 'Candidate')}`, modalHtml, null, { saveLabel: 'Close', cancelLabel: '' });
      return;
    }
    if(a==='revoke-app'){
      modal('Revoke Candidate Offer', `<p>Are you sure you want to <strong>revoke</strong> the offer for this candidate?</p><p class="muted" style="font-size:0.82rem;margin-top:6px;">This will transition the application to the terminal Revoked status and archive active agreements.</p>`, async () => {
        await api(`applications/${id}/stage`, 'POST', { stage: 'Revoked' });
        return 'Offer revoked successfully. Candidate application updated to Revoked.';
      }, { saveLabel: 'Revoke Offer & Close' });
      return;
    }
    if(a==='apply-preset'){
      const presetName = b.dataset.preset;
      const presetLabels = {
        smart_hybrid: 'Smart Hybrid (2 Interview Rounds + HR Round + Offer + Pre-Onboarding Training + Onboarding + Hired/Revoked)',
        smart_hybrid_3rounds: 'Smart Hybrid (3 Interview Rounds + HR Round + Offer + Pre-Onboarding Training + Onboarding + Hired/Revoked)',
        standard: 'Standard Pipeline (Applied -> Screening -> Interview -> Offer -> Hired -> Rejected)'
      };
      const label = presetLabels[presetName] || presetName;
      if (!confirm(`Switch pipeline architecture to:\n"${label}"?`)) return;
      await api('pipeline', 'PUT', { preset: presetName });
      notice(`Pipeline switched to ${label}!`, 'success');
      await render();
      return;
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
      const recalcAction = allowAction('applications.match','recruit')
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
    if(a==='new-interview'){
      const [apps,users]=await Promise.all([api('applications'),api('interviewers')]);
      const active=apps.filter(a=>!['Hired','Rejected'].includes(a.stage));
      if(!active.length||!users.length)throw new Error('An active application and interviewer are required.');
      const todayMin=getLocalTodayMin();
      const defaultScheduled=toISTDateTimeInput(new Date(Date.now() + 2 * 60 * 1000));
      modal('Plan interview',`<div class="form-grid">
        ${select('Application','application_id',active.map(a=>[a.id,`${a.name} · ${a.title}`]))}
        ${select('Interview Format','interview_type',[['virtual','Virtual / Online (Microsoft Teams / Video Call)'],['in_person','In-Person / Physical (Office / On-Site)']],'virtual')}
        ${select('Interviewer','interviewer_id',users.map(u=>[u.id,u.name]))}
        ${field('Date and time (IST)','scheduled_at','datetime-local',defaultScheduled,true,`min="${todayMin}"`)}
        ${select('Duration','duration_minutes',[['30','30 minutes'],['45','45 minutes (Standard)'],['60','60 minutes'],['90','90 minutes']],'45',false)}
        <div id="row-meeting-url" class="full">
          ${field('Meeting link / Video URL (Optional)','meeting_url','url','',false,'placeholder="Auto-generated via Teams when connected, or paste Google Meet / Zoom link"')}
        </div>
        <div id="row-location" class="full" style="display:none;">
          ${field('Office / Physical Location','location','text','Mechlin Technologies — Corporate HQ, Mohali',false,'placeholder="e.g. Mechlin Technologies Office, Sector 67, Mohali"')}
        </div>
        ${field('Competencies, comma separated','competencies','text','Role knowledge, Problem solving')}
        ${area('Agenda / Notes (Optional)','notes','',false)}
        <p class="full status-note" id="interview-format-note">This schedules the interview and creates a Microsoft Teams meeting and candidate invite when configured.</p>
      </div>`,async v=>{
        const scheduledDate=parseISTDateTime(v.scheduled_at);
        if(!scheduledDate||!Number.isFinite(scheduledDate.getTime())||isPastInterviewDate(scheduledDate)){
          throw new Error('Enter a future interview date.');
        }
        const isPhysical=v.interview_type==='in_person';
        await api('interviews','POST',{
          ...v,
          scheduled_at:scheduledDate.toISOString(),
          timezone:'Asia/Kolkata',
          competencies:skills(v.competencies),
          duration_minutes:Number(v.duration_minutes)||45,
          interview_type:isPhysical?'in_person':'virtual',
          location:isPhysical?(v.location?.trim()||'Mechlin Technologies — Corporate HQ, Mohali'):undefined,
          meeting_url:isPhysical?undefined:(v.meeting_url?.trim()||undefined),
          notes:v.notes?.trim()||undefined
        });
        return 'Interview scheduled successfully.';
      });
      const dateInp=$('#edit-form [name="scheduled_at"]');
      if(dateInp)dateInp.min=todayMin;
      setupInterviewFormatToggle('virtual');
    }
    if(a==='edit-interview'||a==='reschedule-interview'){
      const interviews=await api('interviews');
      const i=interviews.find(item=>item.id===id)||await api(`interviews/${id}`);
      if(!i)throw new Error('Interview not found.');
      const canManage=allows('interviews.schedule')||allows('interviews.update');
      const users=canManage?await api('interviewers'):[];
      const toLocal=s=>toISTDateTimeInput(s);
      const comps=JSON.parse(i.competencies||'[]');
      const interviewerOptions = users.map(u=>[u.id,u.name]);
      if(i.interviewer_id && !interviewerOptions.some(([uid])=>uid===i.interviewer_id)){
        interviewerOptions.unshift([i.interviewer_id, `${i.interviewer || 'Assigned interviewer'} (Current)`]);
      }
      const todayMin=getLocalTodayMin();
      const defaultScheduled=toISTDateTimeInput(new Date(Date.now() + 2 * 60 * 1000));
      const currentType = i.interview_type === 'in_person' ? 'in_person' : 'virtual';
      const currentLocation = i.location || 'Mechlin Technologies — Corporate HQ, Mohali';
      modal('Edit interview',`<div class="form-grid">
        <p class="full"><strong>Candidate:</strong> ${escape(i.name)} · ${escape(i.title)}</p>
        ${select('Interview Format','interview_type',[['virtual','Virtual / Online (Microsoft Teams / Video Call)'],['in_person','In-Person / Physical (Office / On-Site)']],currentType)}
        ${interviewerOptions.length?select('Interviewer','interviewer_id',interviewerOptions,i.interviewer_id):`<p class="full"><strong>Interviewer:</strong> ${escape(i.interviewer)}</p>`}
        ${field('Date and time (IST)','scheduled_at','datetime-local',toLocal(i.scheduled_at),true,`min="${todayMin}"`)}
        ${select('Duration','duration_minutes',[['30','30 minutes'],['45','45 minutes (Standard)'],['60','60 minutes'],['90','90 minutes']],String(i.duration_minutes||45),false)}
        <div id="row-meeting-url" class="full" ${currentType === 'in_person' ? 'style="display:none;"' : ''}>
          ${field('Meeting link / Video URL (Optional)','meeting_url','url',i.meeting_url||'',false,'placeholder="Auto-generated via Teams when connected, or paste Google Meet / Zoom link"')}
        </div>
        <div id="row-location" class="full" ${currentType !== 'in_person' ? 'style="display:none;"' : ''}>
          ${field('Office / Physical Location','location','text',currentLocation,false,'placeholder="e.g. Mechlin Technologies Office, Sector 67, Mohali"')}
        </div>
        ${(canManage || i.interviewer_id === me?.id)?field('Competencies, comma separated','competencies','text',comps.join(', '),true):''}
        ${area('Agenda / Update notes (Optional)','notes',i.notes||'',false)}
        <p class="full status-note" id="interview-format-note">${currentType === 'in_person' ? 'This is an in-person interview. No virtual meeting link is used.' : 'This updates the scheduled interview date and time and synchronizes with Microsoft Teams when configured.'}</p>
      </div>`,async v=>{
        const scheduledDate=parseISTDateTime(v.scheduled_at);
        if(!scheduledDate||!Number.isFinite(scheduledDate.getTime())||isPastInterviewDate(scheduledDate)){
          throw new Error('Enter a future interview date.');
        }
        let updatedComps;
        if(v.competencies!==undefined){
          const sErr=checkSkills(v.competencies);
          if(sErr)throw new Error(sErr);
          updatedComps=skills(v.competencies);
          if(!updatedComps.length)throw new Error('At least one competency is required.');
        }
        const isPhysical=v.interview_type==='in_person';
        const payload={
          scheduled_at:scheduledDate.toISOString(),
          duration_minutes:Number(v.duration_minutes)||45,
          timezone:'Asia/Kolkata',
          interview_type:isPhysical?'in_person':'virtual',
          location:isPhysical?(v.location?.trim()||'Mechlin Technologies — Corporate HQ, Mohali'):'',
          meeting_url:isPhysical?null:(v.meeting_url?.trim()||i.meeting_url||undefined),
          notes:v.notes?.trim()||undefined,
          ...(v.interviewer_id?{interviewer_id:v.interviewer_id}:{}),
          ...(updatedComps?{competencies:updatedComps}:{})
        };
        await api(`interviews/${id}`,'PUT',payload);
        return 'Interview updated successfully.';
      });
      setupInterviewFormatToggle(currentType);
      if(canManage || i.interviewer_id === me?.id){
        bindValidation('competencies',checkSkills);
      }
    }
    if(a==='retry-meeting'){
      try {
        notice('Retrying Microsoft Teams meeting synchronization...', 'info');
        const res = await api(`interviews/${id}/retry-meeting`, 'POST', {});
        if (res && res.calendar_status === 'sync_failed') {
          notice(`Microsoft Teams meeting sync failed: ${res.meeting_error || 'Access denied. Check credentials and permissions in Integrations.'}`, 'error');
        } else {
          notice('Microsoft Teams meeting synchronized successfully. Join link generated.', 'success');
        }
        await render();
      } catch (err) {
        notice(err.message || 'Failed to sync Microsoft Teams meeting.', 'error');
        await render();
      }
      return;
    }
    if(a==='retry-invitation'){
      try {
        notice('Resending interview invitation...', 'info');
        const res = await api(`interviews/${id}/retry-invitation`, 'POST', {});
        if (res && res.invitation_status === 'failed') {
          notice(`Interview invitation failed: ${res.invitation_error || 'Email delivery failed.'}`, 'error');
        } else {
          notice('Interview invitation sent successfully.', 'success');
        }
        await render();
      } catch (err) {
        notice(err.message || 'Failed to resend interview invitation.', 'error');
        await render();
      }
      return;
    }
    if(a==='view-meeting-error'){
      const interviews=await api('interviews');
      const i=interviews.find(item=>item.id===id)||await api(`interviews/${id}`);
      modal('Microsoft Teams Sync Error', `
        <div style="padding:14px;background:var(--surface);border:1px solid var(--negative);border-radius:8px;margin-bottom:12px;">
          <p style="margin:0 0 6px;font-weight:600;color:var(--negative);">Microsoft Graph synchronization error:</p>
          <div style="font-family:monospace;font-size:0.85rem;background:var(--negative-bg,#fee2e2);color:var(--negative,#991b1b);padding:8px 10px;border-radius:6px;word-break:break-word;">
            ${escape(i?.meeting_error || 'No error details logged.')}
          </div>
        </div>
        <div class="notice-inline" style="font-size:0.83rem;line-height:1.5;">
          <strong>Why this happens & how to resolve:</strong><br>
          • <strong>Access Denied:</strong> In Azure Entra ID, ensure the App Registration has <code>Calendars.ReadWrite</code> application permission and that a Global Admin has clicked <em>Grant Admin Consent</em>.<br>
          • <strong>Organizer Mailbox:</strong> The configured organizer email (<code>${escape(i?.organizer || 'hr@mechlintech.com')}</code>) must be a licensed Exchange Online mailbox in the tenant.<br>
          • <strong>Settings:</strong> Update credentials or test connection anytime in <strong>Integrations → Microsoft Calendar</strong>.
        </div>
      `);
      return;
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
    if(a==='scorecard'||a==='scorecard-proxy'){
      await openScorecardModal(id, a==='scorecard-proxy');
      return;
    }
    if(a==='feedback-pending'){
      notice('Interview is scheduled. Feedback and scorecard rating unlock after the scheduled interview time.', 'info');
      return;
    }
    if(a==='feedback'){
      const r=await api(`interviews/${id}/scorecards`);
      modal('Interview feedback',`${r.blinded?'<div class="notice-inline">Other reviewers’ feedback is hidden until you submit all your assigned scorecards for this application.</div>':''}${r.scorecards.map(s=>{
        const ratingsObj=JSON.parse(s.ratings||'{}');
        const ratingChips=Object.entries(ratingsObj).map(([k,v])=>`<span style="display:inline-flex;align-items:center;gap:6px;background:var(--surface-alt);border:1px solid var(--line);padding:3px 10px;border-radius:6px;font-size:0.83rem;margin:2px 4px 2px 0;"><strong>${escape(k)}:</strong> <span style="color:var(--accent);font-weight:600;">${escape(v)}/5</span></span>`).join('');
        return `<article class="panel"><h3>${escape(s.recommendation)}</h3>${s.proxy_for?`<p class="muted" style="margin-bottom:6px"><strong>Proxy Submission:</strong> Submitted by ${escape(s.author_name||'Administrator')} on behalf of ${escape(s.proxy_for_name||'Interviewer')}${s.proxy_reason?` &middot; Reason: ${escape(s.proxy_reason)}`:''}</p>`:(s.author_name?`<p class="muted" style="margin-bottom:6px">By: ${escape(s.author_name)}</p>`:'')}<div style="display:flex;flex-wrap:wrap;gap:4px;margin:8px 0;">${ratingChips}</div><p class="score-note">${escape(s.notes)}</p></article>`;
      }).join('')||empty('No feedback is available to you yet.')}`);
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
      modal(`Referral: ${r.name}`,`<dl class="detail-list"><dt>Candidate</dt><dd><strong>${escape(r.name)}</strong><br>${escape(r.email)}</dd><dt>Job Position</dt><dd>${position}${reqAction}</dd><dt>Referral Status</dt><dd>${badge(r.status)}${r.application_id?`<br><small>Linked application ${escape(r.application_id)}</small>`:''}</dd><dt>Referral Date</dt><dd>${escape(formatDateTimeIST(r.at))}</dd><dt>Referrer</dt><dd>${escape(r.referrer_name||'You')}${r.referrer_email?`<br><small>${escape(r.referrer_email)}</small>`:''}</dd><dt>Referral Note</dt><dd class="score-note">${escape(r.note||'No referral note provided.')}</dd></dl>${actions.length?`<div class="actions" style="margin-top:16px">${actions.join('')}</div>`:''}`);
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
    if(a==='approve-access'||a==='reject-access'){
      const u=(window.currentUsers||[]).find(row=>row.id===id);
      if(!u||u.status!=='pending'){notice('This request is no longer pending.','error');await render();return;}
      const roles=(await api('me')).roles.filter(r=>r!=='Agency'&&r!=='Agency Admin'&&r!=='Agency Recruiter');
      if(a==='reject-access'){
        modal(`Reject ${u.name}`,`<p>${escape(u.email)} will be denied access. This cannot be applied twice.</p>`,async()=>{await api(`admin/users/${id}/reject`,'POST',{});return 'Access request rejected.';},{saveLabel:'Reject request'});
        return;
      }
      modal(`Approve ${u.name}`,`<p>${escape(u.email)}</p>${select('Role','role',roles,roles.includes('Recruiter')?'Recruiter':roles[0])}${teamSelect('Team','team','',true)}<p class="muted">The person can sign in after approval. A second approval is rejected by the server.</p>`,async v=>{
        if(!v.role)throw new Error('Select a role before approving.');
        await api(`admin/users/${id}/approve`,'POST',{role:v.role,team:v.team||''});
        return 'Access request approved.';
      },{saveLabel:'Approve request'});
      return;
    }
    if(a==='manage-user'){const u=window.currentUsers.find(u=>u.id===id);if(!u||u.status==='pending')return;const roles=(await api('me')).roles.filter(r=>r!=='Agency');const actions=u.status==='active'?['update','disable','force-logout']:['reactivate','update'];modal(`Manage ${u.name}`,`<p>${escape(u.email)} · ${badge(u.status)}</p><p class="mono">Entra object: ${escape(u.oid)}</p>`+select('Action','action',actions)+select('Role','role',roles,u.role)+teamSelect('Team','team',u.team||'',true)+'<p class="muted">Access changes revoke all current ATS sessions.</p>',async v=>{await api(`admin/users/${id}/${v.action}`,'POST',v);return `User ${v.action} completed successfully.`;});}
    if(a==='edit-pipeline'){
      const [stages, presets, apps] = await Promise.all([
        api('pipeline'),
        api('pipeline/presets').catch(() => null),
        api('applications').catch(() => [])
      ]);

      const stageCounts = {};
      for (const ap of apps) {
        if (!['Hired', 'Rejected', 'Revoked'].includes(ap.stage)) {
          stageCounts[ap.stage] = (stageCounts[ap.stage] || 0) + 1;
        }
      }
      const occupiedStages = Object.entries(stageCounts);

      const occupiedHtml = occupiedStages.length > 0 ? `
        <div style="margin-top:10px;padding:10px 12px;background:var(--tint);border-radius:6px;border:1px solid var(--accent);font-size:0.8rem;line-height:1.4;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;">
            <strong style="color:var(--accent);">Active Candidates in Pipeline:</strong>
            ${occupiedStages.map(([stg, count]) => `<span class="badge" style="background:var(--surface);font-size:0.75rem;">${escape(stg)}: <strong>${count}</strong></span>`).join('')}
          </div>
          <span class="muted">These stages have active candidates. If you replace them with a new preset (like Smart Hybrid), candidates will be automatically migrated (e.g. <em>Screening → Screening Round</em>, <em>Interview → Interview Round 1</em>) so no candidate is lost.</span>
        </div>
      ` : '';

      modal('Edit pipeline',
        `<div class="edit-pipeline-notice" style="margin-bottom:14px;padding:12px;background:var(--surface-alt);border:1px solid var(--line);border-radius:8px;font-size:0.83rem;line-height:1.5;">` +
          `<span class="muted">• Must begin with <strong>Applied</strong> (initial entry).<br>` +
          `• Intermediate interview and evaluation rounds are flexible and can be skipped directly in the pipeline board for fast-tracking candidates.<br>` +
          `• Major milestones <strong>Offer</strong> and <strong>Hired</strong> (and optional <strong>Revoked</strong>) are preserved.<br>` +
          `• Supports up to <strong>30 stages</strong> for advanced multi-round recruiting workflows.</span>` +
          occupiedHtml +
        `</div>` +
        `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px;">` +
          `<span style="font-size:0.8rem;font-weight:600;color:var(--text);">Pipeline Workflow Presets:</span>` +
          `<div style="display:flex;gap:6px;flex-wrap:wrap;">` +
            `<button type="button" class="secondary" id="btn-preset-hybrid" style="font-size:0.75rem;padding:3px 8px;">Smart Hybrid (Default)</button>` +
            `<button type="button" class="secondary" id="btn-preset-hybrid3" style="font-size:0.75rem;padding:3px 8px;">Smart Hybrid (3 Rounds)</button>` +
          `</div>` +
        `</div>` +
        area('Stages, one per line','stages',stages.join('\n'),true) +
        `<div style="display:flex;justify-content:space-between;margin-top:6px;font-size:0.78rem;" class="muted">` +
          `<span id="pipeline-stages-counter">Stages configured: ${stages.length} / 30 max</span>` +
        `</div>`,
        async v=>{
          let entered=v.stages.split('\n').map(s=>s.trim()).filter(Boolean);
          if(entered[0]!=='Applied') entered.unshift('Applied');
          const hasRevoked = entered.includes('Revoked');
          entered=entered.filter(s=>!['Hired','Rejected','Revoked'].includes(s));
          if(hasRevoked){
            entered.push('Hired','Rejected','Revoked');
          } else {
            entered.push('Hired','Rejected');
          }
          if(entered.length > 30) throw new Error(`Stages must be a list with at most 30 items (currently has ${entered.length}).`);

          // Calculate automatic remappings for occupied stages
          const stageRemap = {};
          for (const [occupiedStage] of occupiedStages) {
            if (!entered.includes(occupiedStage)) {
              if (occupiedStage === 'Screening' && entered.includes('Screening Round')) {
                stageRemap['Screening'] = 'Screening Round';
              } else if (occupiedStage === 'Interview' && entered.includes('Interview Round 1')) {
                stageRemap['Interview'] = 'Interview Round 1';
              } else if (occupiedStage === 'Offer' && entered.includes('HR Round')) {
                stageRemap['Offer'] = 'HR Round';
              } else if (occupiedStage === 'Interview Round 1' && entered.includes('Interview')) {
                stageRemap['Interview Round 1'] = 'Interview';
              } else {
                const match = entered.find(s => s.toLowerCase().includes(occupiedStage.toLowerCase()) || occupiedStage.toLowerCase().includes(s.toLowerCase()));
                if (match) stageRemap[occupiedStage] = match;
              }
            }
          }

          await api('pipeline','PUT',{stages:entered, stage_remap: stageRemap});
          return 'Pipeline updated successfully.';
        }
      );

      const textarea = $('#edit-form [name="stages"]');
      const counter = $('#pipeline-stages-counter');
      const updateCounter = () => {
        if (!textarea || !counter) return;
        const count = textarea.value.split('\n').map(s => s.trim()).filter(Boolean).length;
        counter.textContent = `Stages configured: ${count} / 30 max`;
        counter.style.color = count > 30 ? 'var(--negative)' : 'var(--muted)';
      };

      if (textarea) {
        textarea.oninput = updateCounter;
      }

      const btnHybrid = $('#btn-preset-hybrid');
      if (btnHybrid) {
        btnHybrid.onclick = () => {
          if (textarea) {
            const list = presets?.smart_hybrid || [
              'Applied', 'Screening Round', 'Interview Round 1', 'Interview Round 2',
              'HR Round', 'Offer', 'Pre-Onboarding Training', 'Onboarding', 'Hired', 'Rejected', 'Revoked'
            ];
            textarea.value = list.join('\n');
            updateCounter();
          }
        };
      }
      const btnHybrid3 = $('#btn-preset-hybrid3');
      if (btnHybrid3) {
        btnHybrid3.onclick = () => {
          if (textarea) {
            const list = presets?.smart_hybrid_3rounds || [
              'Applied', 'Screening Round', 'Interview Round 1', 'Interview Round 2',
              'Interview Round 3', 'HR Round', 'Offer', 'Pre-Onboarding Training', 'Onboarding', 'Hired', 'Rejected', 'Revoked'
            ];
            textarea.value = list.join('\n');
            updateCounter();
          }
        };
      }
    }
    if(a==='new-signature-request'){
      const cand = (await api('candidates')).find(c=>c.id===id)||await api(`candidates/${id}`);
      if(!cand) throw new Error('Candidate not found.');
      const candApps = cand.applications || [];
      const eligibility = signatureEligibility(candApps);
      if (!eligibility.eligible) throw new Error(eligibility.reason);
      const [reqs, templates] = await Promise.all([
        api('requisitions'),
        api('offer-templates?status=active').catch(() => [])
      ]);
      const activeApps = eligibility.applications;
      const reqOptions = activeApps.map(app => [app.requisition_id, `${app.title} (${app.stage})`]);
      for (const r of reqs.filter(r=>r.status==='open')) {
        if (!reqOptions.some(([rid])=>rid===r.id)) reqOptions.push([r.id, `${r.title} (${r.team})`]);
      }
      if (!reqOptions.length) reqOptions.push(['', 'General Position (No active requisition)']);

      const firstReqId = reqOptions[0]?.[0];
      const initialReq = reqs.find(r => r.id === firstReqId);
      const initialCurrency = initialReq?.currency || 'INR';
      const initialSalary = initialReq?.salary_max
        ? Number(initialReq.salary_max).toLocaleString()
        : (initialReq?.salary_min ? Number(initialReq.salary_min).toLocaleString() : '120,000');

      modal(`Create Offer & E-Signature Request for ${escape(cand.name)}`, `
        <div class="form-grid">
          ${templates.length ? `
            <label class="full">
              <span class="label-heading">Offer Letter Template</span>
              <select name="template_id" id="sig-offer-tpl-select">
                ${templates.map(t => `<option value="${t.id}" ${t.is_default ? 'selected' : ''}>${escape(t.name)} (v${t.version}${t.is_default ? ' — Default' : ''})</option>`).join('')}
              </select>
            </label>
            <div class="full" style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
              <button type="button" class="button secondary" id="btn-preview-sig-offer" style="font-size:0.82rem;padding:6px 14px;">Preview Offer Letter (A4)</button>
              <small class="muted">Check A4 pagination and dynamic terms before dispatch.</small>
            </div>
          ` : ''}
          <div class="candidate-tailor-toggle-box full">
            <div class="candidate-tailor-head" id="btn-toggle-tailor-sig">
              <strong style="color:var(--accent);font-size:0.86rem;display:flex;align-items:center;gap:6px;">Customize Clauses for ${escape(cand.name)}</strong>
              <span id="tailor-sig-chevron" style="font-size:0.75rem;color:var(--muted);font-weight:700;">[ Customize Clauses ]</span>
            </div>
            <div id="tailor-sig-body" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--line);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px;">
                <small class="muted">Add a joining bonus, modify notice period, or tailor terms specifically for this candidate.</small>
                <div style="display:flex;gap:4px;">
                  <button type="button" class="secondary" id="btn-tailor-sig-clause-lib" style="font-size:0.74rem;padding:3px 8px;">Clause Library</button>
                  <button type="button" class="secondary" id="btn-tailor-sig-add-bonus" style="font-size:0.74rem;padding:3px 8px;">Add Joining Bonus</button>
                </div>
              </div>
              <div id="tailor-sig-sections-list"></div>
            </div>
          </div>
          ${field('Document title', 'title', 'text', 'Employment Offer Letter')}
          ${select('Associated position', 'requisition_id', reqOptions)}
          ${field('Signer legal name', 'signer_name', 'text', cand.name)}
          ${field('Signer email', 'signer_email', 'email', cand.email)}
          ${field('Annual base salary', 'salary', 'text', initialSalary)}
          ${field('Currency', 'currency', 'text', initialCurrency)}
          ${field('Anticipated start date', 'start_date', 'text', 'Two weeks following signature acceptance')}
          ${field('Expiration in days', 'expires_days', 'number', '7')}
          <p class="full status-note">Orbit will generate an official Offer of Employment PDF, attach cryptographic SHA-256 integrity verification, and generate a secure signing session token.</p>
        </div>
      `, async v => {
        const currErr = checkCurrency(v.currency);
        if (currErr) {
          const el = $('#currency-error'); if (el) el.textContent = currErr;
          const inp = $('#edit-form [name="currency"]'); if (inp) { inp.setCustomValidity(currErr); inp.reportValidity(); }
          throw new Error(currErr);
        }
        const matchedApp = activeApps.find(a => a.requisition_id === v.requisition_id);
        const selectedReq = reqs.find(r => r.id === v.requisition_id);
        const targetCurrency = v.currency?.trim()?.toUpperCase() || selectedReq?.currency || initialCurrency;
        const payload = {
          title: v.title?.trim() || 'Employment Offer Letter',
          candidate_id: cand.id,
          application_id: matchedApp?.id || undefined,
          requisition_id: v.requisition_id || undefined,
          template_id: v.template_id || undefined,
          salary: v.salary?.trim() || initialSalary,
          currency: targetCurrency,
          start_date: v.start_date?.trim(),
          expires_days: Number(v.expires_days) || 7,
          custom_sections: tailoredSections || undefined,
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

      bindValidation('currency', checkCurrency);

      let tailoredSections = null;
      const toggleBtn = $('#btn-toggle-tailor-sig');
      const tailorBody = $('#tailor-sig-body');
      const tailorChevron = $('#tailor-sig-chevron');
      const tplSelect = $('#sig-offer-tpl-select');

      const renderTailoredList = () => {
        const listEl = $('#tailor-sig-sections-list');
        if (!listEl || !tailoredSections) return;
        listEl.innerHTML = tailoredSections.map((s, idx) => {
          let preview = s.text || s.title || (s.items ? s.items.join('; ') : s.type);
          return `
            <div class="studio-section-card" data-tailor-idx="${idx}" style="padding:10px;margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:6px;">
                  <span class="studio-section-badge studio-badge-${s.type}" style="font-size:0.65rem;">${s.type.replace('_',' ')}</span>
                  <strong style="font-size:0.8rem;">Section #${idx+1}</strong>
                </div>
                <div style="display:flex;gap:3px;">
                  <button type="button" class="secondary" data-tailor-act="up" data-idx="${idx}" ${idx===0?'disabled':''} style="min-height:22px;padding:0 6px;font-size:0.7rem;">Up</button>
                  <button type="button" class="secondary" data-tailor-act="down" data-idx="${idx}" ${idx===tailoredSections.length-1?'disabled':''} style="min-height:22px;padding:0 6px;font-size:0.7rem;">Down</button>
                  <button type="button" class="secondary" data-tailor-act="del" data-idx="${idx}" style="min-height:22px;padding:0 6px;font-size:0.7rem;color:var(--negative);">Remove</button>
                </div>
              </div>
              ${s.type === 'heading' ? `
                <input type="text" data-tailor-field="text" data-idx="${idx}" value="${escape(s.text||'')}" style="font-size:0.8rem;padding:4px 8px;font-weight:600;">
              ` : (s.type === 'paragraph' ? `
                <textarea data-tailor-field="text" data-idx="${idx}" rows="2" style="font-size:0.8rem;line-height:1.4;">${escape(s.text||'')}</textarea>
              ` : (s.type === 'bullet_list' ? `
                <textarea data-tailor-field="items" data-idx="${idx}" rows="2" style="font-size:0.8rem;">${escape((s.items||[]).join('\n'))}</textarea>
              ` : `<small class="muted">${escape(preview)}</small>`))}
            </div>
          `;
        }).join('');

        listEl.querySelectorAll('input, textarea').forEach(el => {
          el.oninput = () => {
            const i = Number(el.dataset.idx);
            const field = el.dataset.tailorField;
            if (tailoredSections[i]) {
              if (field === 'items') {
                tailoredSections[i].items = el.value.split('\n').map(x => x.trim()).filter(Boolean);
              } else {
                tailoredSections[i][field] = el.value;
              }
            }
          };
        });

        listEl.querySelectorAll('[data-tailor-act]').forEach(btn => {
          btn.onclick = () => {
            const act = btn.dataset.tailorAct;
            const i = Number(btn.dataset.idx);
            if (act === 'up' && i > 0) {
              const tmp = tailoredSections[i];
              tailoredSections[i] = tailoredSections[i - 1];
              tailoredSections[i - 1] = tmp;
            } else if (act === 'down' && i < tailoredSections.length - 1) {
              const tmp = tailoredSections[i];
              tailoredSections[i] = tailoredSections[i + 1];
              tailoredSections[i + 1] = tmp;
            } else if (act === 'del') {
              tailoredSections.splice(i, 1);
            }
            renderTailoredList();
          };
        });
      };

      const loadTailorSections = async () => {
        const chosenTplId = tplSelect?.value || templates[0]?.id;
        if (!chosenTplId) return;
        const tplData = await api(`offer-templates/${chosenTplId}`).catch(() => null);
        tailoredSections = tplData?.sections ? JSON.parse(JSON.stringify(tplData.sections)) : [];
        renderTailoredList();
      };

      if (toggleBtn) {
        toggleBtn.onclick = async () => {
          const isHidden = tailorBody.style.display === 'none';
          tailorBody.style.display = isHidden ? 'block' : 'none';
          tailorChevron.textContent = isHidden ? '[ Collapse Customizer ]' : '[ Customize Clauses ]';
          if (isHidden && !tailoredSections) {
            await loadTailorSections();
          }
        };
      }

      if (tplSelect) {
        tplSelect.onchange = async () => {
          if (tailoredSections) {
            await loadTailorSections();
          }
        };
      }

      const addBonusBtn = $('#btn-tailor-sig-add-bonus');
      if (addBonusBtn) {
        addBonusBtn.onclick = () => {
          if (!tailoredSections) tailoredSections = [];
          tailoredSections.push(
            { id: `sec_bonus_${Date.now()}`, type: 'heading', level: 2, text: 'Special Joining Bonus' },
            { id: `sec_bonus_p_${Date.now()}`, type: 'paragraph', text: 'You are eligible for a special one-time joining bonus of ₹100,000, payable with your first monthly payroll cycle. Should you voluntarily resign within 12 months, this bonus must be repaid in full.' }
          );
          renderTailoredList();
          notice('Added Joining Bonus clause!', 'success');
        };
      }

      const addLibBtn = $('#btn-tailor-sig-clause-lib');
      if (addLibBtn) {
        addLibBtn.onclick = () => {
          openClauseLibraryModal(clauseSections => {
            if (!tailoredSections) tailoredSections = [];
            tailoredSections.push(...clauseSections);
            renderTailoredList();
          });
        };
      }

      const previewBtn = $('#btn-preview-sig-offer');
      if (previewBtn) {
        previewBtn.onclick = () => {
          const tplId = $('#sig-offer-tpl-select')?.value;
          if (!tplId) return;
          const curReqId = $('#edit-form [name="requisition_id"]')?.value;
          const matchedApp = activeApps.find(a => a.requisition_id === curReqId);
          const curSalary = $('#edit-form [name="salary"]')?.value || initialSalary;
          const curCurr = $('#edit-form [name="currency"]')?.value || initialCurrency;
          openOfferTemplatePreview(tplId, cand.id, curReqId, matchedApp?.id, curSalary, curCurr, tailoredSections);
        };
      }
      const reqSelect = $('#edit-form [name="requisition_id"]');
      if (reqSelect) {
        reqSelect.addEventListener('change', () => {
          const sel = reqs.find(r => r.id === reqSelect.value);
          if (sel) {
            const cInput = $('#edit-form [name="currency"]');
            if (cInput && sel.currency) {
              cInput.value = sel.currency;
              cInput.dispatchEvent(new Event('input'));
            }
            const sInput = $('#edit-form [name="salary"]');
            if (sInput && sel.salary_max) {
              sInput.value = Number(sel.salary_max).toLocaleString();
            }
          }
        });
      }
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
          b.textContent = 'Copied!';
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
        b.textContent = 'Resent!';
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

      const statusActionButtons = (allows('agencies.update') || allows('agencies.delete') || allows('agencies.assign')) ? `
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          ${allows('agencies.update') && ag.status!=='active'?button('Activate agency','set-agency-status',ag.id,'data-status="active" class="primary"'):''}
          ${allows('agencies.update') && ag.status==='active'?button('Suspend agency','set-agency-status',ag.id,'data-status="suspended" class="secondary"'):''}
          ${allows('agencies.delete') && ag.status!=='deactivated'?button('Deactivate agency','set-agency-status',ag.id,'data-status="deactivated" class="secondary"'):''}
          ${allows('agencies.assign')?button('Assign role','agency-assign-job',ag.id,'class="secondary"'):''}
          ${allows('agencies.update')?button('Add recruiter','agency-add-recruiter-modal',ag.id,'class="secondary"'):''}
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
          <tbody>${ass.map(j=>`<tr><td><strong>${escape(j.title)}</strong><br><small>${escape(j.team)}</small></td><td>${(j.submission_deadline||j.deadline)?escape(formatDateIST(j.submission_deadline||j.deadline)):'None'}</td><td><small class="muted">${escape(j.sourcing_instructions||j.instructions||'—')}</small></td><td>${allows('agencies.assign')?button('Revoke','revoke-agency-req',ag.id,`data-req-id="${j.requisition_id}" class="secondary text-button"`):'-'}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      ` : '<p class="muted" style="font-size:0.85rem;margin-top:6px;">No requisitions currently assigned.</p>';

      const subsList = subs.length ? `
        <div class="table-wrap" style="margin-top:8px;">
          <table class="table"><thead><tr><th scope="col">Ref</th><th scope="col">Candidate</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Feedback</th></tr></thead>
          <tbody>${subs.map(s=>`<tr><td class="mono">${escape(s.submission_ref)}</td><td><strong>${escape(s.candidate_name)}</strong></td><td>${escape(s.requisition_title)}</td><td>${badge(s.agency_status)}</td><td>${allows('agencies.feedback')?button('Publish feedback','publish-agency-feedback',s.id,'class="secondary text-button"'):(s.published_feedback?'Published':'—')}</td></tr>`).join('')}</tbody>
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
            <div class="feedback-meta">Published on ${escape(formatDateTimeIST(sub.feedback_published_at||sub.created_at))}</div>
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
  if (nav.length === 1 && nav[0] === 'Agency portal') {
    current = 'Agency portal';
    deniedView = '';
    render();
    return;
  }
  const requested=requestedRoute();
  if(!requested)return;
  if(!routeAllowed(requested)){
    deniedView=requested;
    current=requested;
    render();
    return;
  }
  deniedView='';
  if(requested!==current){
    current=requested;
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
            <strong>Link Validity:</strong> Valid until ${escape(formatDateIST(session.request.expires_at))} (${Math.max(0, Math.ceil((new Date(session.request.expires_at).getTime() - Date.now()) / 86400000))} days remaining)
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
    applyMeData(data);
    loadSavedPages();
    const nav=getNavList();
    if (nav.length === 1 && nav[0] === 'Agency portal') {
      current = 'Agency portal';
      deniedView = '';
    } else {
      const requested=requestedRoute();
      if(requested&&!nav.includes(requested)){
        current=requested;
        deniedView=requested;
      }else{
        current=getSavedNav(nav);
        deniedView='';
      }
    }
    cleanAccessQuery();
    await render();
  }catch{
    login();
  }
  if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
})();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !me) return;
  const previous = grants.join('\n');
  refreshCurrentUser().then(() => {
    const next = grants.join('\n');
    if (previous === next) return;
    const nav = getNavList();
    if (!nav.length) deniedView = deniedView || current || 'this workspace';
    else if (!nav.includes(current)) { deniedView = current; }
    else if (deniedView && nav.includes(current)) deniedView = '';
    render();
  }).catch(() => {});
});
document.addEventListener('input', event => {
  if (event.target.id !== 'role-search') return;
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll('[data-role-name]').forEach(row => {
    row.style.display = !query || row.dataset.roleName.includes(query) ? '' : 'none';
  });
});
