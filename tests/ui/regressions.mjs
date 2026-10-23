// Focused UI regression checks for agency navigation, scorecard timing, dropdown labels,
// duplicate-name selection and candidate search empty states.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { app, f } from './fixture.mjs';
if (!app.listening) await once(app, 'listening');
const port = Number(process.env.TEST_PORT || 3005);
const base = `http://localhost:${port}`;
const chrome = spawn(process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--remote-debugging-port=0', `--user-data-dir=${process.env.TEMP || '.'}/orbit-regression-chrome-${process.pid}`, 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Chrome did not start: ' + stderr)), 20000);
  chrome.stderr.on('data', d => {
    stderr += d;
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  chrome.on('error', reject);
  chrome.on('exit', code => reject(new Error(`Chrome exited ${code} ${stderr}`)));
});
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0, session;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
};
const send = (method, params = {}, sid = session) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10000);
  pending.set(id, { resolve, reject, timer });
  ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const waitFor = async expression => {
  for (let n = 0; n < 120; n++) {
    try {
      if (await evaluate(expression)) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timeout: ' + expression);
};
const click = async expression => evaluate(`${expression}.click()`);
const results = [];
const check = (label, condition) => {
  if (!condition) throw new Error('FAIL ' + label);
  results.push('PASS ' + label);
  console.log(results.at(-1));
};
const startView = async view => {
  await click(`document.querySelector('[data-nav="${view}"]')`);
  // The nav click starts an async render; await one directly so checks don't read the previous DOM.
  await evaluate(`(async () => { await render(); return true; })()`);
  await waitFor(`document.querySelector('#main h1')?.textContent === ${JSON.stringify(view)}`);
};
try {
  const target = await send('Target.createTarget', { url: 'about:blank' }, null);
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/#/Overview` });
  await waitFor("document.querySelector('.metrics') !== null");

  // Early interview completion: the UI must not offer submission before the scheduled time.
  await startView('Interviews');
  await waitFor("document.querySelector('table tbody tr') !== null");
  check('early feedback is not offered in the interviews table',
    await evaluate("!document.querySelector('#main [data-action=\"scorecard\"]') && !document.querySelector('#main [data-action=\"scorecard-proxy\"]')"));
  check('early feedback message is displayed to reviewers',
    await evaluate("document.querySelector('#main').innerText.includes('Feedback can be submitted after the scheduled interview time.')"));

  // Prepare duplicate-name candidates and inspect Add Application labels/values.
  await evaluate(`(async () => {
    const seed = [
      { name: 'Duplicate Name', email: 'duplicate.one@example.com' },
      { name: 'Duplicate Name', email: 'duplicate.two@example.com' }
    ];
    for (const item of seed) {
      await api('candidates', 'POST', { ...item, team: 'Dev', source: 'Direct', skills: ['SQL'] });
    }
    await render();
  })()`);
  await startView('Pipeline');
  await click(`document.querySelector('[data-action="new-application"]')`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent === 'Add application'");
  const addLabels = await evaluate(`(() => {
    const opts = [...document.querySelectorAll('#edit-form select[name="candidate_id"] option')];
    return opts.filter(o => o.textContent.startsWith('Duplicate Name —')).map(o => ({ text: o.textContent, value: o.value }));
  })()`);
  check('Add Application shows duplicate names with distinguishing emails',
    addLabels.length === 2 &&
    addLabels.some(o => o.text === 'Duplicate Name — duplicate.one@example.com') &&
    addLabels.some(o => o.text === 'Duplicate Name — duplicate.two@example.com'));
  check('Add Application submits the unique candidate ID',
    addLabels.every(o => o.value && !o.value.includes('@')));
  check('candidate search filters by email and keeps the ID value', await evaluate(`(() => {
    const input = document.querySelector('#edit-form [data-search-select="candidate_id"]');
    input.value = 'duplicate.two@example.com';
    input.dispatchEvent(new Event('input'));
    const opts = [...document.querySelectorAll('#edit-form select[name="candidate_id"] option')];
    const candidate = opts.find(o => o.textContent === 'Duplicate Name — duplicate.two@example.com');
    return opts.length === 1 && Boolean(candidate?.value) && !candidate.value.includes('@');
  })()`));
  check('candidate search filters by name', await evaluate(`(() => {
    const input = document.querySelector('#edit-form [data-search-select="candidate_id"]');
    input.value = 'Duplicate Name';
    input.dispatchEvent(new Event('input'));
    return document.querySelectorAll('#edit-form select[name="candidate_id"] option').length >= 2;
  })()`));
  check('Add Application requisitions show title, ID and team and retain open-only scope', await evaluate(`(async () => {
    const open = (await api('requisitions')).filter(r => r.status === 'open');
    const opts = [...document.querySelectorAll('#edit-form select[name="requisition_id"] option')];
    return opts.length === open.length && opts.every(option => {
      const req = open.find(r => r.id === option.value);
      return req && option.textContent === req.title + ' — ' + req.id + ' — ' + req.team;
    });
  })()`));
  await click(`document.querySelector('#close-modal')`);

  // Referral requisition dropdown uses the same unambiguous label and values.
  await startView('Referrals');
  await click(`document.querySelector('[data-action="new-referral"]')`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent === 'Make a referral'");
  check('Make Referral requisitions show title, ID and team and retain open-only scope', await evaluate(`(async () => {
    const open = (await api('requisitions')).filter(r => r.status === 'open');
    const opts = [...document.querySelectorAll('#edit-form select[name="requisition_id"] option')];
    return opts.length === open.length && opts.every(option => {
      const req = open.find(r => r.id === option.value);
      return req && option.textContent === req.title + ' — ' + req.id + ' — ' + req.team;
    });
  })()`));
  check('requisition search filters by ID', await evaluate(`(() => {
    const select = document.querySelector('#edit-form select[name="requisition_id"]');
    const first = select.options[0];
    const elements = { id: first.value, text: first.textContent };
    elements.id = first.value;
    const input = document.querySelector('#edit-form [data-search-select="requisition_id"]');
    input.value = elements.id;
    input.dispatchEvent(new Event('input'));
    return document.querySelectorAll('#edit-form select[name="requisition_id"] option').length >= 1;
  })()`));
  await click(`document.querySelector('#close-modal')`);

  // Referral position, status, details, processing, withdrawal and deletion.
  const referralSeed = await evaluate(`(async () => {
    const req = (await api('requisitions')).find(r => r.status === 'open');
    const ref = await api('referrals', 'POST', { requisition_id: req.id, name: 'UI Referral Candidate', email: 'ui.referral@example.com', note: 'UI referral note for review.' });
    await render();
    return { reqId: req.id, refId: ref.id, title: req.title };
  })()`);
  await startView('Referrals');
  await waitFor(`(() => {
    const headers = [...document.querySelectorAll('.referrals-table thead th')].map(th => th.textContent.trim());
    return headers.includes('Job Position') && headers.includes('Referral Status');
  })()`);
  check('Referral table shows Job Position and Referral Status headers', await evaluate(`(() => {
    const headers = [...document.querySelectorAll('.referrals-table thead th')].map(th => th.textContent.trim());
    return headers.includes('Job Position') && headers.includes('Referral Status') && headers.includes('Referrer') && headers.includes('Actions');
  })()`));
  check('Referral row shows linked position, Submitted status and permitted actions', await evaluate(`(() => {
    const row = [...document.querySelectorAll('.referrals-table tbody tr')].find(r => r.innerText.includes('UI Referral Candidate'));
    return Boolean(row) && row.innerText.includes(${JSON.stringify(referralSeed.title)}) && row.innerText.includes('Submitted') &&
      Boolean(row.querySelector('[data-action="referral-details"]')) && Boolean(row.querySelector('[data-action="edit-referral"]')) &&
      Boolean(row.querySelector('[data-action="process-referral"]')) && Boolean(row.querySelector('[data-action="withdraw-referral"]'));
  })()`));
  await click(`(() => { const row = [...document.querySelectorAll('.referrals-table tbody tr')].find(r => r.innerText.includes('UI Referral Candidate')); return row.querySelector('[data-action="referral-details"]'); })()`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent === 'Referral: UI Referral Candidate'");
  check('Referral details show the selected candidate, position, requisition reference, date, referrer, note and status', await evaluate(`(() => {
    const text = document.querySelector('dialog').innerText;
    return text.includes('UI Referral Candidate') && text.includes('ui.referral@example.com') && text.includes(${JSON.stringify(referralSeed.title)}) &&
      text.includes(${JSON.stringify(referralSeed.reqId)}) && text.includes('Referral Date') && text.includes('Referrer') &&
      text.includes('UI referral note for review.') && text.includes('Submitted');
  })()`));
  await click(`document.querySelector('#modal-body [data-action="req-details"][data-readonly="true"]')`);
  await waitFor("document.querySelector('dialog').open && Boolean(document.querySelector('.requisition-detail'))");
  check('Requisition opened from a referral is read-only and offers no Edit action', await evaluate(`(() => {
    const body = document.querySelector('#modal-body');
    return body.querySelector('.read-only-note')?.innerText.includes('Read-only view') &&
      !body.querySelector('[data-action="edit-req"]') && body.innerText.includes(${JSON.stringify(referralSeed.title)});
  })()`));
  await click(`document.querySelector('#close-modal')`);
  await click(`(() => { const row = [...document.querySelectorAll('.referrals-table tbody tr')].find(r => r.innerText.includes('UI Referral Candidate')); return row.querySelector('[data-action="edit-referral"]'); })()`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent === 'Edit referral'");
  check('Referral edit pre-populates saved values and shows Delete', await evaluate(`(() => {
    const form = document.querySelector('#edit-form');
    return form.elements.name.value === 'UI Referral Candidate' && form.elements.email.value === 'ui.referral@example.com' &&
      form.elements.requisition_id.value === ${JSON.stringify(referralSeed.reqId)} && form.elements.note.value === 'UI referral note for review.' &&
      Boolean(document.querySelector('[data-action="delete-referral"]'));
  })()`));
  check('Form actions show labelled red Delete and green Save buttons at equal height', await evaluate(`(() => {
    const del = document.querySelector('#edit-form .btn-delete');
    const save = document.querySelector('#edit-form .btn-save');
    if (!del || !save) return false;
    const deleteStyle = getComputedStyle(del), saveStyle = getComputedStyle(save);
    return del.textContent.trim() === 'Delete' && save.textContent.trim() === 'Save' &&
      deleteStyle.backgroundColor === 'rgb(166, 27, 43)' && saveStyle.backgroundColor === 'rgb(22, 101, 52)' &&
      del.getBoundingClientRect().height === save.getBoundingClientRect().height &&
      del.getBoundingClientRect().height >= 44;
  })()`));
  await send('DOM.enable');
  await send('CSS.enable');
  const domRoot = (await send('DOM.getDocument', { depth: 0 })).root;
  const deleteNodeId = (await send('DOM.querySelector', { nodeId: domRoot.nodeId, selector: '#edit-form .btn-delete' })).nodeId;
  const saveNodeId = (await send('DOM.querySelector', { nodeId: domRoot.nodeId, selector: '#edit-form .btn-save' })).nodeId;
  await send('CSS.forcePseudoState', { nodeId: deleteNodeId, forcedPseudoClasses: ['hover'] });
  await new Promise(resolve => setTimeout(resolve, 250));
  check('Delete button hover uses a lighter red', await evaluate("getComputedStyle(document.querySelector('#edit-form .btn-delete')).backgroundColor === 'rgb(198, 47, 67)'"));
  await send('CSS.forcePseudoState', { nodeId: saveNodeId, forcedPseudoClasses: ['hover'] });
  await new Promise(resolve => setTimeout(resolve, 250));
  check('Save button hover uses a lighter green', await evaluate("getComputedStyle(document.querySelector('#edit-form .btn-save')).backgroundColor === 'rgb(31, 122, 69)'"));
  await send('CSS.forcePseudoState', { nodeId: deleteNodeId, forcedPseudoClasses: [] });
  await send('CSS.forcePseudoState', { nodeId: saveNodeId, forcedPseudoClasses: [] });
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await new Promise(resolve => setTimeout(resolve, 60));
  check('Form actions stay aligned and inside the viewport on mobile', await evaluate(`(() => {
    const del = document.querySelector('#edit-form .btn-delete').getBoundingClientRect();
    const save = document.querySelector('#edit-form .btn-save').getBoundingClientRect();
    return Math.abs(del.top - save.top) < 1 && Math.abs(del.height - save.height) < 1 &&
      del.height >= 44 && del.left >= 0 && save.right <= window.innerWidth;
  })()`));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await new Promise(resolve => setTimeout(resolve, 60));
  await click(`document.querySelector('#close-modal')`);
  await click(`(() => { const row = [...document.querySelectorAll('.referrals-table tbody tr')].find(r => r.innerText.includes('UI Referral Candidate')); return row.querySelector('[data-action="process-referral"]'); })()`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent === 'Process referral'");
  await click(`document.querySelector('#edit-form [type="submit"]')`);
  await waitFor("!document.querySelector('dialog').open && (() => { const row = [...document.querySelectorAll('.referrals-table tbody tr')].find(r => r.innerText.includes('UI Referral Candidate')); return Boolean(row) && row.innerText.includes('Applied'); })()");
  check('Processed referral shows the linked application workflow status without redundant copy', await evaluate(`(() => {
    const row = [...document.querySelectorAll('.referrals-table tbody tr')].find(r => r.innerText.includes('UI Referral Candidate'));
    return Boolean(row) && row.innerText.includes('Applied') && !row.innerText.includes('Application linked') && !row.querySelector('[data-action="process-referral"]');
  })()`));
  const candidatesBefore = await evaluate("(async () => (await api('candidates')).length)()");
  await click(`(() => { const row = [...document.querySelectorAll('.referrals-table tbody tr')].find(r => r.innerText.includes('UI Referral Candidate')); return row.querySelector('[data-action="withdraw-referral"]'); })()`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent === 'Withdraw referral'");
  check('Withdrawal confirmation explains candidate/application records are retained', await evaluate("document.querySelector('dialog').innerText.includes('will not be deleted or rejected automatically')"));
  await click(`document.querySelector('#edit-form [type="submit"]')`);
  await waitFor("!document.querySelector('dialog').open && document.querySelector('.referrals-table')?.innerText.includes('Withdrawn')");
  check('Withdrawn referral keeps its linked candidate and cannot be deleted', await evaluate(`(() => {
    const row = [...document.querySelectorAll('.referrals-table tbody tr')].find(r => r.innerText.includes('UI Referral Candidate'));
    return Boolean(row) && row.innerText.includes('Withdrawn') && !row.querySelector('[data-action="edit-referral"]') && !row.querySelector('[data-action="withdraw-referral"]');
  })()`));
  check('Withdrawal did not remove the linked candidate', (await evaluate("(async () => (await api('candidates')).length)()")) === candidatesBefore);

  const deleteSeed = await evaluate(`(async () => {
    const req = (await api('requisitions')).find(r => r.status === 'open');
    const ref = await api('referrals', 'POST', { requisition_id: req.id, name: 'UI Delete Referral', email: 'ui.delete.referral@example.com', note: 'Delete me.' });
    await render();
    return ref.id;
  })()`);
  await startView('Referrals');
  await waitFor(`(() => {
    const row = [...document.querySelectorAll('.referrals-table tbody tr')].find(r => r.innerText.includes('UI Delete Referral'));
    return Boolean(row?.querySelector('[data-action="edit-referral"]'));
  })()`);
  await click(`(() => { const row = [...document.querySelectorAll('.referrals-table tbody tr')].find(r => r.innerText.includes('UI Delete Referral')); return row.querySelector('[data-action="edit-referral"]'); })()`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent === 'Edit referral'");
  await click(`document.querySelector('[data-action="delete-referral"]')`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent === 'Delete referral'");
  check('Delete confirmation identifies the referral and explains the impact', await evaluate("document.querySelector('dialog').innerText.includes('UI Delete Referral') && document.querySelector('dialog').innerText.includes('recoverable soft deletion') && document.querySelector('dialog').innerText.includes('never silently deleted')"));
  await click(`document.querySelector('#edit-form [type="submit"]')`);
  await waitFor("!document.querySelector('dialog').open && !document.querySelector('.referrals-table')?.innerText.includes('UI Delete Referral')");
  check('Deleting a referral refreshes the referral list', true);

  // Description drafting in both Create and Edit Requisition forms.
  await startView('Requisitions');
  await click(`document.querySelector('[data-action="new-req"]')`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent === 'New requisition'");
  await evaluate(`(() => {
    const form = document.querySelector('#edit-form');
    form.elements.title.value = 'Orbit Draft Role';
    form.elements.skills.value = 'SQL, JavaScript';
    document.querySelector('[data-action="draft-jd"]').click();
  })()`);
  await waitFor("document.querySelector('#edit-form [name=description]').value.includes('Orbit Draft Role')");
  check('Create Requisition drafts a description from title and skills', await evaluate("document.querySelector('#edit-form [name=description]').value.includes('SQL') && document.querySelector('#edit-form [name=description]').value.includes('JavaScript')"));
  check('Draft success message tells the user to review before saving', await evaluate("document.querySelector('#notice')?.innerText.includes('Job description drafted. Please review before saving.')"));
  check('Draft response no longer says not generative AI', await evaluate("!document.querySelector('#main').innerText.includes('not generative AI') && !document.querySelector('#notice')?.innerText.includes('not generative AI')"));
  await click(`document.querySelector('#close-modal')`);

  await click(`document.querySelector('.requisitions-table [data-action="edit-req"]')`);
  await waitFor("document.querySelector('dialog').open && document.querySelector('#modal-body h2')?.textContent === 'Edit requisition'");
  await evaluate(`(() => {
    window._confirmCalls = 0;
    window.confirm = () => { window._confirmCalls++; return true; };
    document.querySelector('[data-action="draft-jd"]').click();
  })()`);
  await waitFor("document.querySelector('#edit-form [name=description]').value.includes('Role overview')");
  check('Edit Requisition asks before replacing a non-empty description and applies the draft', await evaluate("window._confirmCalls === 1 && document.querySelector('#edit-form [name=description]').value.includes('Required skills and experience')"));
  const descriptionBeforeCancel = await evaluate("document.querySelector('#edit-form [name=description]').value");
  await evaluate(`(() => {
    window.confirm = () => { window._confirmCalls++; return false; };
    document.querySelector('[data-action="draft-jd"]').click();
  })()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  check('Cancelling the replacement prompt keeps the existing description', (await evaluate("document.querySelector('#edit-form [name=description]').value")) === descriptionBeforeCancel);
  await click(`document.querySelector('#close-modal')`);

  // Requisition description hierarchy in the details popup.
  const structuredSeed = await evaluate(`(async () => {
    const r = await api('requisitions', 'POST', {
      title: 'Structured Detail Role', team: 'Dev', headcount: 1, currency: 'USD', salary_min: 80000, salary_max: 100000,
      skills: ['SQL', 'JavaScript'],
      description: [
        'Purpose', 'Build reliable systems for the team.', '',
        'Required Skills', 'SQL, JavaScript and clear communication.', '',
        'Responsibilities', '• Design dependable services.', '• Review code and mentor peers.', '',
        'Interview Process', 'Structured interview with consistent criteria.', '',
        'Accessibility', 'Contact the recruiter to request an accommodation.'
      ].join('\\n')
    });
    await render();
    return r.id;
  })()`);
  await startView('Requisitions');
  await click(`(() => {
    const row = [...document.querySelectorAll('.requisitions-table tbody tr')].find(r => r.innerText.includes('Structured Detail Role'));
    return row.querySelector('[data-action="req-details"]');
  })()`);
  await waitFor("document.querySelector('dialog').open && Boolean(document.querySelector('.requisition-detail'))");
  check('Requisition details render description sections as bold headings with lighter body text', await evaluate(`(() => {
    const detail = document.querySelector('.requisition-detail');
    const titles = [...detail.querySelectorAll('.detail-section-title')].map(h => h.textContent.trim());
    const heading = detail.querySelector('.detail-section-title');
    const body = detail.querySelector('.detail-section-body');
    if (!heading || !body) return false;
    const headingStyle = getComputedStyle(heading), bodyStyle = getComputedStyle(body);
    return ['Purpose', 'Required Skills', 'Responsibilities', 'Interview Process', 'Accessibility'].every(title => titles.includes(title)) &&
      Number(headingStyle.fontWeight) >= 700 && Number(bodyStyle.fontWeight) <= 400 &&
      headingStyle.color !== bodyStyle.color && detail.querySelectorAll('.detail-section-list li').length === 2;
  })()`));
  check('Requisition description hierarchy keeps readable contrast in the midnight theme', await evaluate(`(() => {
    const original = document.documentElement.dataset.theme;
    applyTheme('midnight');
    const detail = document.querySelector('.requisition-detail');
    const heading = getComputedStyle(detail.querySelector('.detail-section-title'));
    const body = getComputedStyle(detail.querySelector('.detail-section-body'));
    const result = Number(heading.fontWeight) >= 700 && heading.color === 'rgb(229, 237, 249)' && body.color === 'rgb(161, 178, 201)';
    applyTheme(original);
    return result;
  })()`));
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await new Promise(resolve => setTimeout(resolve, 60));
  check('Requisition detail section content stays within the mobile viewport', await evaluate(`(() => {
    const detail = document.querySelector('.requisition-detail');
    return document.documentElement.scrollWidth <= window.innerWidth &&
      [...detail.querySelectorAll('.detail-section-title, .detail-section-body, .detail-section-list')].every(el => el.getBoundingClientRect().right <= window.innerWidth);
  })()`));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await new Promise(resolve => setTimeout(resolve, 60));
  await click(`document.querySelector('#close-modal')`);
  await evaluate(`(async () => { await api('requisitions/${structuredSeed}', 'DELETE'); await render(); })()`);

  await startView('Candidates');
  await waitFor("document.querySelector('#candidate-search') !== null");
  check('unmatched search shows the specific empty state', await evaluate(`(() => {
    const input = document.querySelector('#candidate-search');
    input.value = 'definitely-no-such-candidate-xyz';
    input.dispatchEvent(new Event('input'));
    return document.querySelector('#candidate-table').innerText.includes('No matching candidates found.') &&
      !document.querySelector('#candidate-table').innerText.includes('No candidates added yet');
  })()`));
  check('unmatched search offers Clear Search', await evaluate("Boolean(document.querySelector('#candidate-table [data-action=\"clear-candidate-search\"]'))"));
  await click(`document.querySelector('#candidate-table [data-action="clear-candidate-search"]')`);
  await waitFor("document.querySelectorAll('#candidate-table tbody tr').length > 0");
  check('Clear Search restores the candidate directory', true);

  // Empty directory without an active search.
  f.db.exec('DELETE FROM stage_events; DELETE FROM scorecards; DELETE FROM interviews; DELETE FROM referrals; DELETE FROM applications; DELETE FROM candidates;');
  await evaluate('render()');
  await waitFor("document.querySelector('#candidate-table')?.innerText.includes('No candidates added yet')");
  check('empty directory with no active search shows No candidates added yet',
    await evaluate("!document.querySelector('#candidate-table').innerText.includes('No matching candidates found.')"));

  // Agency role navigation/landing and direct API denial.
  const login = await evaluate(`fetch('/auth/demo-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'Agency', team: 'QA' })
  }).then(async r => ({ ok: r.ok, data: await r.json() }))`);
  check('Agency demo login succeeds', login.ok);
  await send('Page.navigate', { url: `${base}/?agency=1#/Overview` });
  await waitFor("document.querySelector('#main h1')?.textContent === 'Agency portal'");
  check('Agency lands on the Agency portal instead of Requisitions',
    await evaluate("!document.querySelector('[data-nav=\"Requisitions\"]') && Boolean(document.querySelector('[data-nav=\"Agency portal\"]'))"));
  check('Agency sees the not-available-yet page',
    await evaluate("document.querySelector('#main').innerText.includes('Agency portal is not available yet')"));
  check('Agency is denied internal ATS APIs',
    await evaluate("Promise.all([fetch('/api/requisitions'), fetch('/api/candidates')]).then(([a, b]) => a.status === 403 && b.status === 403)"));

  console.log(`\n${results.length} focused UI regression checks passed.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { await new Promise(resolve => app.close(resolve)); } catch {}
  try { f.db.close(); } catch {}
}
process.exit(process.exitCode || 0);
