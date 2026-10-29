/**
 * Test Suite: Pre-Onboarding Training Plan Module
 * 
 * Covers Prompt Section 17 Scenarios:
 * A. Template Management (CRUD, Duplicate, Preview, Activate, Archive, Drafts)
 * B. Position and Role Matching (Priority 1-5, Ambiguity Detection, Fallback, Warnings)
 * C. Review Popup & Manual Confirmation (No auto-send, Draft Persistence, Idempotency, Resend)
 * D. Email Independence (Separate from stage_update, Independent retries)
 * E. Content, Dynamic Variables, Security, and RBAC
 * F. Existing Workflow Compatibility (Offer signing, Evaluations, Pipeline transitions)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { service } from '../src/service.js';
import { fixture, user, reqBody, candidateBody, addSignedOffer } from './helpers.js';
import {
  listTrainingTemplates,
  getTrainingTemplate,
  createTrainingTemplate,
  updateTrainingTemplate,
  duplicateTrainingTemplate,
  setTrainingTemplateStatus,
  archiveTrainingTemplate,
  matchTrainingTemplate,
  getOrCreateTrainingDraft,
  saveTrainingDraft,
  previewTrainingEmail,
  sendTrainingPlan,
  resendTrainingPlan,
  seedDefaultTrainingTemplatesIfEmpty,
  sanitizeUrl
} from '../src/training/service.js';

const call = (f, u, m, p, b) => service(f.db, u, m, p, b, null, { communicationAdapter: f.commAdapter });

function setupTrainingFixture() {
  const f = fixture();
  f.sentEmails = [];
  f.commAdapter = {
    configured: true,
    send: async (payload) => {
      f.sentEmails.push(payload);
      return { id: 'msg_' + Math.random().toString(36).slice(2), status: 'accepted' };
    }
  };
  // Set pipeline with Pre-Onboarding Training
  call(f, f.admin, 'PUT', 'pipeline', { preset: 'smart_hybrid' });

  // Create requisition for Senior Software Engineer in Engineering
  f.req = call(f, f.recruiter, 'POST', 'requisitions', {
    ...reqBody,
    title: 'Senior Software Engineer',
    team: 'Engineering'
  });
  call(f, f.recruiter, 'POST', `requisitions/${f.req.id}/submit`);
  call(f, f.manager, 'POST', `requisitions/${f.req.id}/approve`, {});
  call(f, f.finance, 'POST', `requisitions/${f.req.id}/approve`, {});

  // Create candidate and application
  f.candidate = call(f, f.recruiter, 'POST', 'candidates', {
    ...candidateBody,
    name: 'Jordan Miller',
    email: 'jordan.miller@example.com'
  });
  f.app = call(f, f.recruiter, 'POST', 'applications', {
    candidate_id: f.candidate.id,
    requisition_id: f.req.id
  });

  return f;
}

// --------------------------------------------------------------------------
// SUITE A: Template Management
// --------------------------------------------------------------------------

test('A1. Template Management: Create, edit, duplicate, preview, activate, deactivate, and archive', () => {
  const f = setupTrainingFixture();

  // Create template
  const created = createTrainingTemplate(f.db, {
    name: 'DevOps & Cloud Engineer Plan',
    description: 'Onboarding track for infrastructure engineers',
    positions: ['DevOps Engineer', 'Site Reliability Engineer'],
    departments: ['Engineering'],
    roles: ['Individual Contributor'],
    duration_text: '3 Weeks',
    subject: 'Welcome {{candidate.first_name}} - Your Cloud Infrastructure Training Plan',
    introduction: 'Welcome aboard! Here is your tailored roadmap.',
    objectives: 'Master internal Kubernetes clusters and CI/CD pipelines.',
    sections: [
      { id: 'sec-1', title: 'Week 1: Architecture Overview', content: 'Study our microservices topology.' }
    ],
    learning_links: [
      { id: 'link-1', title: 'Internal Wiki', url: 'https://wiki.mechlintech.internal/cloud', category: 'Documentation' }
    ],
    support_contact: { name: 'Cloud TA Team', email: 'cloud-leads@mechlintech.com' },
    status: 'draft',
    is_default: 0
  }, f.admin.id);

  assert.ok(created.id);
  assert.equal(created.name, 'DevOps & Cloud Engineer Plan');
  assert.equal(created.status, 'draft');
  assert.equal(created.version, 1);

  // Edit template
  const updated = updateTrainingTemplate(f.db, created.id, {
    name: 'DevOps & SRE Core Plan',
    duration_text: '4 Weeks',
    sections: [
      { id: 'sec-1', title: 'Week 1: Architecture Overview', content: 'Study our microservices topology.' },
      { id: 'sec-2', title: 'Week 2: Terraform & K8s', content: 'Deploy your first staging service.' }
    ]
  }, f.admin.id);

  assert.equal(updated.name, 'DevOps & SRE Core Plan');
  assert.equal(updated.duration_text, '4 Weeks');
  assert.equal(updated.version, 2);
  assert.equal(updated.sections.length, 2);

  // Duplicate template
  const duplicate = duplicateTrainingTemplate(f.db, created.id, f.admin.id);
  assert.ok(duplicate.id);
  assert.notEqual(duplicate.id, created.id);
  assert.match(duplicate.name, /^Copy of/);
  assert.equal(duplicate.status, 'draft');
  assert.equal(duplicate.sections.length, 2);

  // Subsequent duplicates should not accumulate "Copy of Copy of"
  const duplicate2 = duplicateTrainingTemplate(f.db, created.id, f.admin.id);
  assert.equal(duplicate2.name, `Copy of ${updated.name} (2)`);

  // Duplicating an already duplicated plan should also increment counter rather than prepending "Copy of"
  const duplicateOfCopy = duplicateTrainingTemplate(f.db, duplicate.id, f.admin.id);
  assert.equal(duplicateOfCopy.name, `Copy of ${updated.name} (3)`);

  // Duplicating a legacy template with accumulated "Copy of Copy of" cleans up the name
  const legacyPlan = createTrainingTemplate(f.db, {
    name: 'Copy of Copy of Copy of Legacy Track',
    subject: 'Legacy Track Subject',
    positions: ['All / General'],
    departments: ['All Depts'],
    status: 'draft'
  }, f.admin.id);
  const cleanDuplicate = duplicateTrainingTemplate(f.db, legacyPlan.id, f.admin.id);
  assert.equal(cleanDuplicate.name, 'Copy of Legacy Track');

  // Activate template
  const activated = setTrainingTemplateStatus(f.db, created.id, { status: 'active' }, f.admin.id);
  assert.equal(activated.status, 'active');

  // Deactivate template
  const deactivated = setTrainingTemplateStatus(f.db, created.id, { status: 'inactive' }, f.admin.id);
  assert.ok(['draft', 'inactive'].includes(deactivated.status));

  // Reactivate and then archive
  setTrainingTemplateStatus(f.db, created.id, { status: 'active' }, f.admin.id);
  const archived = archiveTrainingTemplate(f.db, created.id, f.admin.id);
  assert.equal(archived.status, 'archived');

  // Historical record still retrievable
  const fetched = getTrainingTemplate(f.db, created.id);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.status, 'archived');

  f.db.close();
});

test('A2. Template Management: Validation rejects missing fields and unsafe URL schemes', () => {
  const f = setupTrainingFixture();

  // Missing name
  assert.throws(() => {
    createTrainingTemplate(f.db, { subject: 'Some Subject' }, f.admin.id);
  }, /Template name must be text/);

  // Missing subject
  assert.throws(() => {
    createTrainingTemplate(f.db, { name: 'Valid Name', subject: '' }, f.admin.id);
  }, /Email subject must be text/);

  // Unsafe links
  assert.throws(() => {
    createTrainingTemplate(f.db, {
      name: 'Malicious Link Template',
      subject: 'Subject',
      learning_links: [{ title: 'XSS Link', url: 'javascript:alert(1)' }]
    }, f.admin.id);
  }, /must use HTTPS or HTTP scheme/);

  // Sanitize URL utility checks
  assert.equal(sanitizeUrl('https://example.com/learn'), 'https://example.com/learn');
  assert.equal(sanitizeUrl('http://insecure.internal'), 'http://insecure.internal/');
  assert.equal(sanitizeUrl('javascript:malicious()'), null);
  assert.equal(sanitizeUrl('data:text/html;base64,...'), null);
  assert.equal(sanitizeUrl('file:///etc/passwd'), null);

  f.db.close();
});

test('A3. Template Management: Inactive, draft, and archived templates cannot be sent', async () => {
  const f = setupTrainingFixture();

  // Advance candidate to Pre-Onboarding Training
  // Steps: Applied -> Screening Round -> Interview Round 1 -> Interview Round 2 -> HR Round -> Pre-Onboarding Training
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 2' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'HR Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Offer' });
  addSignedOffer(f.db, f.app.id, f.candidate, f.req);
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Pre-Onboarding Training' });

  // Create an inactive template
  const inactiveTpl = createTrainingTemplate(f.db, {
    name: 'Inactive Plan',
    subject: 'Subject',
    status: 'inactive'
  }, f.admin.id);

  // Attempting to send using inactive template should be rejected
  await assert.rejects(async () => {
    await sendTrainingPlan(f.db, f.app.id, {
      templateId: inactiveTpl.id,
      sendConfirmation: true
    }, f.recruiter);
  }, /must be active/);

  // Archived template
  const archivedTpl = createTrainingTemplate(f.db, {
    name: 'Archived Plan',
    subject: 'Subject',
    status: 'archived'
  }, f.admin.id);

  await assert.rejects(async () => {
    await sendTrainingPlan(f.db, f.app.id, {
      templateId: archivedTpl.id,
      sendConfirmation: true
    }, f.recruiter);
  }, /must be active/);

  f.db.close();
});

test('A4. Template Management: Editing a reusable template does not mutate existing candidate drafts', () => {
  const f = setupTrainingFixture();

  // Create base template
  const baseTpl = createTrainingTemplate(f.db, {
    name: 'Base Engineering Plan',
    subject: 'Original Subject {{candidate.name}}',
    introduction: 'Original Introduction',
    positions: ['Staff Infrastructure Architect'],
    departments: ['Engineering'],
    status: 'active'
  }, f.admin.id);

  // Customize candidate draft using base template
  saveTrainingDraft(f.db, f.app.id, {
    template_id: baseTpl.id,
    subject: 'Jordan Miller Special Custom Subject',
    introduction: 'Custom personalized introduction for Jordan Miller.'
  }, f.recruiter.id);

  // Now update the reusable template
  updateTrainingTemplate(f.db, baseTpl.id, {
    subject: 'Global Company-Wide Subject Update',
    introduction: 'Global Company-Wide Introduction Update'
  }, f.admin.id);

  // Verify candidate draft was NOT modified
  const candidateDraft = getOrCreateTrainingDraft(f.db, f.app.id, f.recruiter.id);
  assert.equal(candidateDraft.template_id, baseTpl.id);
  assert.equal(candidateDraft.subject, 'Jordan Miller Special Custom Subject');
  assert.equal(candidateDraft.introduction, 'Custom personalized introduction for Jordan Miller.');

  f.db.close();
});

// --------------------------------------------------------------------------
// SUITE B: Position & Role Specific Matching and Suggestions
// --------------------------------------------------------------------------

test('B1. Matching: Software Engineer and HR Executive candidates receive appropriate suggestions', () => {
  const f = setupTrainingFixture();
  // Clear seeded templates to test isolated position matches
  f.db.prepare('DELETE FROM training_plan_templates').run();

  // Template 1: Software Engineer
  const seTpl = createTrainingTemplate(f.db, {
    name: 'Software Engineering Training Plan',
    subject: 'Welcome to Engineering {{candidate.first_name}}',
    positions: ['Software Engineer', 'Senior Software Engineer'],
    departments: ['Engineering'],
    roles: ['Developer'],
    status: 'active'
  }, f.admin.id);

  // Template 2: HR Executive
  const hrTpl = createTrainingTemplate(f.db, {
    name: 'HR & People Operations Plan',
    subject: 'Welcome to People Ops {{candidate.first_name}}',
    positions: ['HR Executive', 'Talent Partner'],
    departments: ['Human Resources'],
    roles: ['HR'],
    status: 'active'
  }, f.admin.id);

  // Match for SE
  const seMatch = matchTrainingTemplate(f.db, {
    position: 'Senior Software Engineer',
    department: 'Engineering',
    role: 'Developer'
  });
  assert.equal(seMatch.suggestedTemplate.id, seTpl.id);
  assert.equal(seMatch.matchPriority, 1);

  // Match for HR
  const hrMatch = matchTrainingTemplate(f.db, {
    position: 'HR Executive',
    department: 'Human Resources',
    role: 'HR'
  });
  assert.equal(hrMatch.suggestedTemplate.id, hrTpl.id);
  assert.equal(hrMatch.matchPriority, 1);

  f.db.close();
});

test('B2. Matching: Deterministic Priority 1 > Priority 2 > Priority 3 > Priority 4 > Priority 5 (Default)', () => {
  const f = setupTrainingFixture();
  // Clear seeded templates to test priority tiers in isolation
  f.db.prepare('DELETE FROM training_plan_templates').run();

  // Priority 5: Configured Default
  const defTpl = createTrainingTemplate(f.db, {
    name: 'General Company Orientation Plan',
    subject: 'Welcome to Mechlin Technologies',
    is_default: 1,
    status: 'active'
  }, f.admin.id);

  // Priority 4: Department Only Match
  const deptTpl = createTrainingTemplate(f.db, {
    name: 'Engineering Department General Track',
    subject: 'Engineering Overview',
    departments: ['Engineering'],
    status: 'active'
  }, f.admin.id);

  // Priority 2: Position Match
  const posTpl = createTrainingTemplate(f.db, {
    name: 'Backend Position Track',
    subject: 'Backend Track',
    positions: ['Senior Software Engineer'],
    status: 'active'
  }, f.admin.id);

  // Priority 1: Exact Position AND Role Match
  const exactTpl = createTrainingTemplate(f.db, {
    name: 'Lead Architect Track',
    subject: 'Lead Architect Track',
    positions: ['Lead Software Architect'],
    roles: ['Tech Lead'],
    status: 'active'
  }, f.admin.id);

  // Case 1: Has Position + Role -> Priority 1
  const m1 = matchTrainingTemplate(f.db, {
    position: 'Lead Software Architect',
    department: 'Engineering',
    role: 'Tech Lead'
  });
  assert.equal(m1.suggestedTemplate.id, exactTpl.id);
  assert.equal(m1.matchPriority, 1);

  // Case 2: Has Position only (different role) -> Priority 2 over Priority 4 and 5
  const m2 = matchTrainingTemplate(f.db, {
    position: 'Senior Software Engineer',
    department: 'Engineering',
    role: 'Individual Contributor'
  });
  assert.equal(m2.suggestedTemplate.id, posTpl.id);
  assert.equal(m2.matchPriority, 2);

  // Case 3: Different Position in Engineering -> Priority 4 (Department) over Priority 5
  const m3 = matchTrainingTemplate(f.db, {
    position: 'QA Automation Engineer',
    department: 'Engineering',
    role: 'Tester'
  });
  assert.equal(m3.suggestedTemplate.id, deptTpl.id);
  assert.equal(m3.matchPriority, 4);

  // Case 4: Finance Department with no specific template -> Priority 5 (Default)
  const m4 = matchTrainingTemplate(f.db, {
    position: 'Financial Analyst',
    department: 'Finance',
    role: 'Analyst'
  });
  assert.equal(m4.suggestedTemplate.id, defTpl.id);
  assert.equal(m4.matchPriority, 5);

  f.db.close();
});

test('B3. Matching: Ambiguous highest-priority matches flag warning and require manual selection', () => {
  const f = setupTrainingFixture();

  // Create two conflicting templates for the exact same position
  const tplA = createTrainingTemplate(f.db, {
    name: 'Frontend React Track',
    subject: 'React Training',
    positions: ['Frontend Developer'],
    status: 'active'
  }, f.admin.id);

  const tplB = createTrainingTemplate(f.db, {
    name: 'Frontend Vue & Angular Track',
    subject: 'Vue & Angular Training',
    positions: ['Frontend Developer'],
    status: 'active'
  }, f.admin.id);

  const match = matchTrainingTemplate(f.db, {
    position: 'Frontend Developer',
    department: 'Engineering'
  });

  // Ambiguity detected
  assert.equal(match.isAmbiguous, true);
  assert.ok(match.ambiguousTemplates.length >= 2);
  const ids = match.ambiguousTemplates.map(t => t.id);
  assert.ok(ids.includes(tplA.id));
  assert.ok(ids.includes(tplB.id));

  f.db.close();
});

// --------------------------------------------------------------------------
// SUITE C: Review Popup, Drafts & Explicit Manual Confirmation
// --------------------------------------------------------------------------

test('C1. Popup & Stage Transition: Pipeline stage move does NOT automatically send training email', async () => {
  const f = setupTrainingFixture();

  // Advance candidate to Pre-Onboarding Training
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 2' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'HR Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Offer' });
  addSignedOffer(f.db, f.app.id, f.candidate, f.req);

  // Transition to Pre-Onboarding Training
  const transition = await call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, {
    stage: 'Pre-Onboarding Training',
    send_notification: true
  });
  assert.equal(transition.stage, 'Pre-Onboarding Training');

  // Check communication table: only stage_update was sent, NOT pre_onboarding_training
  const comms = f.db.prepare('SELECT * FROM candidate_communications WHERE candidate_id = ?').all(f.candidate.id);
  const stageUpdates = comms.filter(c => c.template_id === 'stage_update');
  const trainingEmails = comms.filter(c => c.template_id === 'pre_onboarding_training');

  assert.equal(stageUpdates.length, 6, 'Stage notifications were sent for each pipeline advance');
  assert.equal(trainingEmails.length, 0, 'Training email was NOT sent automatically');

  // Check draft status
  const draft = getOrCreateTrainingDraft(f.db, f.app.id, f.recruiter.id);
  assert.equal(draft.status, 'pending_review');

  f.db.close();
});

test('C2. Popup & Actions: Previewing, editing, and closing popup do NOT send email', () => {
  const f = setupTrainingFixture();

  // Seed default template
  seedDefaultTrainingTemplatesIfEmpty(f.db);

  // 1. Fetch draft (simulates opening review popup)
  const popupData = call(f, f.recruiter, 'GET', `applications/${f.app.id}/training-plan`);
  assert.ok(popupData.draft);
  assert.equal(popupData.draft.status, 'pending_review');

  // Verify 0 communications sent
  let commCount = f.db.prepare('SELECT COUNT(*) as cnt FROM candidate_communications').get().cnt;
  assert.equal(commCount, 0);

  // 2. Preview email
  const preview = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-plan/preview`, {
    subject: 'Custom Preview Subject',
    introduction: 'Custom Preview Intro'
  });
  assert.ok(preview.html);
  assert.match(preview.subject, /Custom Preview Subject/);

  // Verify still 0 communications sent
  commCount = f.db.prepare('SELECT COUNT(*) as cnt FROM candidate_communications').get().cnt;
  assert.equal(commCount, 0);

  // 3. Save draft
  const saved = call(f, f.recruiter, 'PUT', `applications/${f.app.id}/training-plan`, {
    subject: 'Saved Draft Subject',
    introduction: 'Saved Draft Intro'
  });
  assert.equal(saved.draft.status, 'draft_saved');
  assert.equal(saved.draft.subject, 'Saved Draft Subject');

  // Verify still 0 communications sent
  commCount = f.db.prepare('SELECT COUNT(*) as cnt FROM candidate_communications').get().cnt;
  assert.equal(commCount, 0);

  f.db.close();
});

test('C3. Manual Confirmation: Requires explicit sendConfirmation: true and prevents duplicate sends', async () => {
  const f = setupTrainingFixture();
  seedDefaultTrainingTemplatesIfEmpty(f.db);

  // Advance to Pre-Onboarding Training
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 2' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'HR Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Offer' });
  addSignedOffer(f.db, f.app.id, f.candidate, f.req);
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Pre-Onboarding Training' });

  // 1. Calling send without sendConfirmation: true fails
  await assert.rejects(async () => {
    await call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-plan/send`, {
      sendConfirmation: false
    });
  }, /Explicit.*send confirmation/i);

  // 2. Explicit confirmation succeeds
  const sendResult = await call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-plan/send`, {
    sendConfirmation: true,
    subject: 'Official Training Plan for Jordan Miller'
  });

  assert.equal(sendResult.status, 'sent');
  assert.ok(sendResult.sent_at);
  assert.ok(sendResult.communication_id);

  // Verify email sent in communications table
  const sentComm = f.db.prepare('SELECT * FROM candidate_communications WHERE id = ?').get(sendResult.communication_id);
  assert.equal(sentComm.template_id, 'pre_onboarding_training');
  assert.equal(sentComm.subject, 'Official Training Plan for Jordan Miller');

  // 3. Repeated send attempts without resend are rejected (idempotency check)
  await assert.rejects(async () => {
    await call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-plan/send`, {
      sendConfirmation: true
    });
  }, (err) => err.message.includes('already been sent'));

  // 4. Explicit resend works with audited increment
  const resendResult = await call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-plan/resend`, {
    sendConfirmation: true,
    subject: 'Revised Training Plan for Jordan Miller'
  });

  assert.equal(resendResult.status, 'sent');
  assert.equal(resendResult.resend_count, 1);

  const commCount = f.db.prepare('SELECT COUNT(*) as cnt FROM candidate_communications WHERE candidate_id = ? AND template_id = ?').get(f.candidate.id, 'pre_onboarding_training').cnt;
  assert.equal(commCount, 2, 'Two distinct emails sent with full audit trail');

  f.db.close();
});

// --------------------------------------------------------------------------
// SUITE D: Email Independence & Failure Retries
// --------------------------------------------------------------------------

test('D1. Email Independence: Stage change email and training email operate independently', async () => {
  const f = setupTrainingFixture();
  seedDefaultTrainingTemplatesIfEmpty(f.db);

  // Move candidate with stage notification
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round', send_notification: true });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1', send_notification: true });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 2', send_notification: true });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'HR Round', send_notification: true });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Offer', send_notification: true });
  addSignedOffer(f.db, f.app.id, f.candidate, f.req);
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Pre-Onboarding Training', send_notification: true });

  const stageNotifsBefore = f.db.prepare("SELECT COUNT(*) as cnt FROM candidate_communications WHERE template_id = 'stage_update'").get().cnt;
  assert.equal(stageNotifsBefore, 6);

  // Send training plan
  await call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-plan/send`, { sendConfirmation: true });

  // Stage notifications count remains strictly unchanged
  const stageNotifsAfter = f.db.prepare("SELECT COUNT(*) as cnt FROM candidate_communications WHERE template_id = 'stage_update'").get().cnt;
  assert.equal(stageNotifsAfter, stageNotifsBefore);

  f.db.close();
});

test('D2. Email Retries: Failed training email can be retried independently without duplicate notifications', async () => {
  const f = setupTrainingFixture();
  seedDefaultTrainingTemplatesIfEmpty(f.db);

  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 2' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'HR Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Offer' });
  addSignedOffer(f.db, f.app.id, f.candidate, f.req);
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Pre-Onboarding Training' });

  // Initialize draft and then simulate a failed draft state
  getOrCreateTrainingDraft(f.db, f.recruiter, f.app.id);
  f.db.prepare("UPDATE training_plan_drafts SET status = 'failed', error_message = 'Simulated SMTP timeout' WHERE application_id = ?").run(f.app.id);

  const draftBefore = getOrCreateTrainingDraft(f.db, f.app.id, f.recruiter.id);
  assert.equal(draftBefore.status, 'failed');
  assert.equal(draftBefore.error_message, 'Simulated SMTP timeout');

  // Retry send
  const retried = await call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-plan/send`, {
    sendConfirmation: true,
    subject: 'Retried Training Plan'
  });

  assert.equal(retried.status, 'sent');

  const draftAfter = getOrCreateTrainingDraft(f.db, f.app.id, f.recruiter.id);
  assert.equal(draftAfter.status, 'sent');
  assert.equal(draftAfter.error_message, null);

  f.db.close();
});

// --------------------------------------------------------------------------
// SUITE E: Content, Dynamic Variables, Security, and RBAC
// --------------------------------------------------------------------------

test('E1. Dynamic Variables: Resolves candidate, requisition, company variables and escapes HTML', () => {
  const f = setupTrainingFixture();

  // Create candidate with XSS characters in name
  const xssCand = call(f, f.recruiter, 'POST', 'candidates', {
    ...candidateBody,
    name: '<script>alert("xss")</script> Taylor',
    email: 'taylor.xss@example.com'
  });
  const xssApp = call(f, f.recruiter, 'POST', 'applications', {
    candidate_id: xssCand.id,
    requisition_id: f.req.id
  });

  const preview = previewTrainingEmail(f.db, f.recruiter, xssApp.id, {
    subject: 'Welcome {{candidate.first_name}} to {{company.name}}',
    introduction: 'Hello {{candidate.name}}, your position is {{requisition.title}} in {{requisition.department}}.',
    sections: [
      { id: 'sec-1', title: 'Week 1', content: 'Duration is {{training.duration}}.' }
    ]
  });

  assert.ok(preview.html);
  // Escapes script tag
  assert.ok(!preview.html.includes('<script>alert("xss")</script>'));
  assert.ok(preview.html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;') || preview.html.includes('&lt;script&gt;'));
  assert.ok(preview.html.includes('Senior Software Engineer'));
  assert.ok(preview.html.includes('Engineering'));
  assert.ok(preview.html.includes('Mechlin Technologies'));

  f.db.close();
});

test('E2. Security & RBAC: Non-authorized roles cannot manage templates or send training emails', async () => {
  const f = setupTrainingFixture();
  seedDefaultTrainingTemplatesIfEmpty(f.db);

  // Interviewer attempts to create a template
  assert.throws(() => {
    call(f, f.interviewer, 'POST', 'training-plans/templates', {
      name: 'Unauthorized Template',
      subject: 'Subject'
    });
  }, /cannot perform this action|forbidden/i);

  // Interviewer attempts to send training email
  await assert.rejects(async () => {
    await call(f, f.interviewer, 'POST', `applications/${f.app.id}/training-plan/send`, {
      sendConfirmation: true
    });
  }, /cannot perform this action|forbidden/i);

  // Interviewer attempts to update draft
  assert.throws(() => {
    call(f, f.interviewer, 'PUT', `applications/${f.app.id}/training-plan`, {
      subject: 'Hacked Subject'
    });
  }, /cannot perform this action|forbidden/i);

  f.db.close();
});

// --------------------------------------------------------------------------
// SUITE F: Compatibility & Regression
// --------------------------------------------------------------------------

test('F1. Workflow Regression: Training evaluations and progression to Hired operate seamlessly', async () => {
  const f = setupTrainingFixture();
  seedDefaultTrainingTemplatesIfEmpty(f.db);

  // Complete pipeline to Pre-Onboarding Training
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 2' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'HR Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Offer' });
  addSignedOffer(f.db, f.app.id, f.candidate, f.req);
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Pre-Onboarding Training' });

  // Send training plan
  await call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-plan/send`, { sendConfirmation: true });

  // Record Pre-Onboarding Training Evaluation (Existing feature)
  const evalResult = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 5,
    practical_score: 95,
    decision: 'next',
    notes: 'Exceeded all pre-onboarding milestones.'
  });

  assert.equal(evalResult.evaluation.rating, 5);
  assert.equal(evalResult.evaluation.decision, 'next');

  // Verify application progressed to Onboarding
  const appAfterEval = f.db.prepare('SELECT * FROM applications WHERE id = ?').get(f.app.id);
  assert.equal(appAfterEval.stage, 'Onboarding');

  // Move Onboarding -> Hired
  const hired = await call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Hired' });
  assert.equal(hired.stage, 'Hired');

  // Both training plan draft and training evaluation remain intact
  const finalDraft = getOrCreateTrainingDraft(f.db, f.app.id, f.recruiter.id);
  assert.equal(finalDraft.status, 'sent');

  const finalEval = call(f, f.recruiter, 'GET', `applications/${f.app.id}/training-evaluation`);
  assert.equal(finalEval.evaluation.rating, 5);

  f.db.close();
});
