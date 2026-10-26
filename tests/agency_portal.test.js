/**
 * Comprehensive Test Suite for External Agency Recruiter Portal
 * Validates all five mandatory user-behavior tests:
 * 1. Agency onboarding and authorization (agency creation, recruiter access, internal ATS blocked).
 * 2. Requisition assignment and candidate submission (assigned open job, valid candidate & resume, unassigned/closed rejected).
 * 3. Duplicate and invalid submissions (repeated submits blocked, candidate confidentiality on cross-agency conflict, validation errors).
 * 4. Status tracking and confidentiality (mapped statuses, internal hiring decisions protected, internal notes hidden, published feedback).
 * 5. Cross-agency isolation and suspension (agency boundary isolation, suspension blocks access while preserving audit history).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, reqBody, candidateBody, testConfig, addSignedOffer } from './helpers.js';
import { service } from '../src/service.js';
import { can } from '../src/policy.js';
import {
  createAgency,
  getAgency,
  listAgencies,
  setAgencyStatus,
  addAgencyMember,
  assignRequisitionToAgency,
  revokeRequisitionFromAgency,
  publishAgencyFeedback,
  getAgencyDashboard,
  listAssignedRequisitions,
  getAssignedRequisition,
  submitAgencyCandidate,
  listAgencySubmissions,
  getAgencySubmission,
  mapStageToAgencyStatus
} from '../src/agency/service.js';

test('Mandatory Test 1: Agency onboarding and authorization', async () => {
  const { db, admin, recruiter } = fixture();

  // 1. Admin creates and activates an external recruitment agency
  const agency = createAgency(db, admin, {
    name: 'Apex Talent Partners',
    code: 'APEX',
    contact_name: 'Alex Taylor',
    contact_email: 'alex.taylor@apex-talent.example.com',
    contact_phone: '+1 555-0199',
    notes: 'Primary executive search partner'
  });

  assert.equal(agency.name, 'Apex Talent Partners');
  assert.equal(agency.code, 'APEX');
  assert.equal(agency.status, 'active');

  // 2. Add an agency recruiter to Apex Talent
  const member = addAgencyMember(db, admin, agency.id, {
    name: 'Jordan Miller',
    email: 'jordan@apex-talent.example.com',
    role: 'Agency Recruiter'
  });

  assert.equal(member.role, 'Agency Recruiter');
  assert.equal(member.status, 'active');

  // Retrieve user record
  const agencyUser = db.prepare('SELECT * FROM users WHERE id=?').get(member.user_id);
  assert.equal(agencyUser.role, 'Agency Recruiter');

  // 3. Agency recruiter can access the Agency Portal
  const agencyContext = service(db, agencyUser, 'GET', 'agency/me');
  assert.equal(agencyContext.agency_id, agency.id);
  assert.equal(agencyContext.agency_name, 'Apex Talent Partners');
  assert.equal(agencyContext.agency_role, 'Agency Recruiter');

  const dashboard = service(db, agencyUser, 'GET', 'agency/dashboard');
  assert.equal(dashboard.agency.name, 'Apex Talent Partners');
  assert.equal(dashboard.stats.total_submissions, 0);

  // 4. Agency recruiter CANNOT access internal ATS routes (Enforce 403 Forbidden)
  assert.equal(can(agencyUser, 'admin'), false);
  assert.equal(can(agencyUser, 'recruit'), false);
  assert.equal(can(agencyUser, 'jobs'), false);

  // Attempt to view internal candidates
  assert.throws(
    () => service(db, agencyUser, 'GET', 'candidates'),
    /Your role cannot perform this action/
  );

  // Attempt to create an internal candidate directly
  assert.throws(
    () => service(db, agencyUser, 'POST', 'candidates', candidateBody),
    /Your role cannot perform this action/
  );

  // Attempt to view internal user administration
  assert.throws(
    () => service(db, agencyUser, 'GET', 'admin/users'),
    /Your role cannot perform this action/
  );

  // Attempt to view internal requisitions list
  assert.throws(
    () => service(db, agencyUser, 'GET', 'requisitions'),
    /Your role cannot perform this action/
  );

  // Attempt to access internal audit log
  assert.throws(
    () => service(db, agencyUser, 'GET', 'admin/audit'),
    /Your role cannot perform this action/
  );

  // Attempt to manage agency settings as agency recruiter
  assert.throws(
    () => service(db, agencyUser, 'GET', 'agencies'),
    /Your role cannot perform this action/
  );
});

test('Mandatory Test 2: Requisition assignment and candidate submission', async () => {
  const { db, admin, recruiter, manager, finance } = fixture();

  // 1. Create and approve an open requisition
  const req = service(db, recruiter, 'POST', 'requisitions', {
    ...reqBody,
    title: 'Senior Cloud Engineer',
    skills: ['AWS', 'Kubernetes', 'Go']
  });
  service(db, recruiter, 'POST', `requisitions/${req.id}/submit`);
  service(db, manager, 'POST', `requisitions/${req.id}/approve`, {});
  service(db, finance, 'POST', `requisitions/${req.id}/approve`, {});

  // Create agency and recruiter
  const agency = createAgency(db, admin, {
    name: 'Summit Search Group',
    code: 'SUMMIT',
    contact_name: 'Morgan Vance',
    contact_email: 'morgan@summit.example.com'
  });
  const member = addAgencyMember(db, admin, agency.id, {
    name: 'Taylor Reed',
    email: 'taylor@summit.example.com',
    role: 'Agency Recruiter'
  });
  const agencyUser = db.prepare('SELECT * FROM users WHERE id=?').get(member.user_id);

  // 2. Unassigned requisition cannot receive submissions (throws 403)
  await assert.rejects(
    async () => service(db, agencyUser, 'POST', 'agency/submissions', {
      requisition_id: req.id,
      name: 'Samira Khan',
      email: 'samira.khan@example.com',
      skills: ['AWS', 'Go'],
      consent_confirmed: true
    }),
    /This requisition is not assigned to your agency/
  );

  // 3. Assign requisition to Summit Search Group
  const deadline = new Date(Date.now() + 86400000 * 14).toISOString();
  const assignment = assignRequisitionToAgency(db, recruiter, agency.id, {
    requisitionId: req.id,
    instructions: 'Submit candidates with at least 4 years Go experience. Verified resumes only.',
    deadline
  });
  assert.equal(assignment.status, 'active');

  // Verify agency can view assigned requisition
  const assignedJobs = service(db, agencyUser, 'GET', 'agency/requisitions');
  assert.equal(assignedJobs.length, 1);
  assert.equal(assignedJobs[0].title, 'Senior Cloud Engineer');
  assert.equal(assignedJobs[0].instructions, 'Submit candidates with at least 4 years Go experience. Verified resumes only.');

  // 4. Submit valid synthetic candidate with resume text
  const subResult = await service(db, agencyUser, 'POST', 'agency/submissions', {
    requisition_id: req.id,
    name: 'Samira Khan',
    email: 'samira.khan@example.com',
    phone: '+1 555-0144',
    skills: ['AWS', 'Go', 'Kubernetes'],
    resume_text: 'Experienced cloud infrastructure engineer with 6 years designing AWS and Kubernetes clusters in Go.',
    consent_confirmed: true,
    notes: 'Strong candidate with immediate availability.'
  });

  assert.equal(subResult.status, 'Submitted');
  assert.equal(subResult.ownership_status, 'owned_by_agency');
  assert.ok(subResult.reference.startsWith('SUB-'));

  // Verify candidate record created in Orbit with agency source attribution
  const candidate = db.prepare('SELECT * FROM candidates WHERE id=?').get(subResult.candidate_id);
  assert.equal(candidate.name, 'Samira Khan');
  assert.equal(candidate.email, 'samira.khan@example.com');
  assert.equal(candidate.source, 'Agency: Summit Search Group');
  assert.equal(candidate.team, req.team);

  // Verify application created in 'Applied' stage
  const app = db.prepare('SELECT * FROM applications WHERE id=?').get(subResult.application_id);
  assert.equal(app.stage, 'Applied');

  // 5. Test Revoked Requisition rejection
  revokeRequisitionFromAgency(db, recruiter, agency.id, req.id);
  await assert.rejects(
    async () => service(db, agencyUser, 'POST', 'agency/submissions', {
      requisition_id: req.id,
      name: 'Another Candidate',
      email: 'another@example.com',
      skills: ['AWS'],
      consent_confirmed: true
    }),
    /This requisition is not assigned to your agency/
  );

  // 6. Test Closed Requisition rejection (create new draft/closed req, assign, then submit)
  const draftReq = service(db, recruiter, 'POST', 'requisitions', {
    ...reqBody,
    title: 'Closed Draft Position'
  });
  // Force assignment for closed req check
  assert.throws(
    () => assignRequisitionToAgency(db, recruiter, agency.id, { requisitionId: draftReq.id }),
    /Only approved and open requisitions can be assigned/
  );
});

test('Mandatory Test 3: Duplicate and invalid submissions', async () => {
  const { db, admin, recruiter, manager, finance } = fixture();

  // Create open requisition
  const req = service(db, recruiter, 'POST', 'requisitions', { ...reqBody, title: 'Security Engineer', skills: ['Security', 'Python'] });
  service(db, recruiter, 'POST', `requisitions/${req.id}/submit`);
  service(db, manager, 'POST', `requisitions/${req.id}/approve`, {});
  service(db, finance, 'POST', `requisitions/${req.id}/approve`, {});

  // Create Agency 1 (Apex)
  const agency1 = createAgency(db, admin, { name: 'Apex Talent', code: 'APEX1', contact_name: 'Alex', contact_email: 'alex@apex1.com' });
  const m1 = addAgencyMember(db, admin, agency1.id, { name: 'Apex Recruiter', email: 'recruiter1@apex1.com' });
  const u1 = db.prepare('SELECT * FROM users WHERE id=?').get(m1.user_id);
  assignRequisitionToAgency(db, recruiter, agency1.id, { requisitionId: req.id });

  // Create Agency 2 (Beacon)
  const agency2 = createAgency(db, admin, { name: 'Beacon Search', code: 'BEACON2', contact_name: 'Blake', contact_email: 'blake@beacon2.com' });
  const m2 = addAgencyMember(db, admin, agency2.id, { name: 'Beacon Recruiter', email: 'recruiter2@beacon2.com' });
  const u2 = db.prepare('SELECT * FROM users WHERE id=?').get(m2.user_id);
  assignRequisitionToAgency(db, recruiter, agency2.id, { requisitionId: req.id });

  // 1. Input validation errors
  // Missing consent
  await assert.rejects(
    async () => service(db, u1, 'POST', 'agency/submissions', {
      requisition_id: req.id,
      name: 'Valid Name',
      email: 'valid@example.com',
      skills: ['Python'],
      consent_confirmed: false
    }),
    /Candidate affirmative consent to share information must be confirmed/
  );

  // Malformed email
  await assert.rejects(
    async () => service(db, u1, 'POST', 'agency/submissions', {
      requisition_id: req.id,
      name: 'Valid Name',
      email: 'not-an-email',
      skills: ['Python'],
      consent_confirmed: true
    }),
    /Enter a valid email address/
  );

  // Missing candidate name
  await assert.rejects(
    async () => service(db, u1, 'POST', 'agency/submissions', {
      requisition_id: req.id,
      name: '',
      email: 'valid@example.com',
      skills: ['Python'],
      consent_confirmed: true
    }),
    /Candidate name must be text/
  );

  // 2. Valid initial submission by Agency 1
  const sub1 = await service(db, u1, 'POST', 'agency/submissions', {
    requisition_id: req.id,
    name: 'Devon Lee',
    email: 'devon.lee@example.com',
    skills: ['Python', 'Security'],
    consent_confirmed: true
  });
  assert.equal(sub1.status, 'Submitted');

  // 3. Repeated submission by the SAME agency for the SAME requisition (Duplicate check)
  await assert.rejects(
    async () => service(db, u1, 'POST', 'agency/submissions', {
      requisition_id: req.id,
      name: 'Devon Lee',
      email: 'devon.lee@example.com',
      skills: ['Python', 'Security'],
      consent_confirmed: true
    }),
    /A candidate with this email has already been submitted by your agency for this requisition/
  );

  // 4. Duplicate submission by a DIFFERENT agency (Agency 2) for the SAME candidate and requisition
  // MUST reject without leaking Agency 1's identity!
  await assert.rejects(
    async () => service(db, u2, 'POST', 'agency/submissions', {
      requisition_id: req.id,
      name: 'Devon Lee',
      email: 'devon.lee@example.com',
      skills: ['Python', 'Security'],
      consent_confirmed: true
    }),
    (err) => {
      assert.match(err.message, /This candidate is already being actively evaluated for this position/);
      assert.equal(err.message.includes('Apex'), false);
      return true;
    }
  );

  // Verify internal audit records the duplicate conflict
  const auditConflict = db.prepare("SELECT * FROM audit WHERE event='agency.duplicate_conflict' ORDER BY id DESC LIMIT 1").get();
  assert.ok(auditConflict);
  assert.equal(auditConflict.actor, u2.id);

  // 5. Candidate already existing in Orbit for a DIFFERENT requisition can be submitted
  const otherReq = service(db, recruiter, 'POST', 'requisitions', { ...reqBody, title: 'Other Job', skills: ['Python'] });
  service(db, recruiter, 'POST', `requisitions/${otherReq.id}/submit`);
  service(db, manager, 'POST', `requisitions/${otherReq.id}/approve`, {});
  service(db, finance, 'POST', `requisitions/${otherReq.id}/approve`, {});
  assignRequisitionToAgency(db, recruiter, agency2.id, { requisitionId: otherReq.id });

  const otherSub = await service(db, u2, 'POST', 'agency/submissions', {
    requisition_id: otherReq.id,
    name: 'Devon Lee',
    email: 'devon.lee@example.com',
    skills: ['Python'],
    consent_confirmed: true
  });
  assert.equal(otherSub.status, 'Submitted');
  assert.equal(otherSub.ownership_status, 'existing_candidate');
});

test('Mandatory Test 4: Status tracking and confidentiality', async () => {
  const { db, admin, recruiter, manager, finance } = fixture();

  // Create requisition
  const req = service(db, recruiter, 'POST', 'requisitions', { ...reqBody, title: 'Staff Data Architect', skills: ['SQL', 'Data Modeling'] });
  service(db, recruiter, 'POST', `requisitions/${req.id}/submit`);
  service(db, manager, 'POST', `requisitions/${req.id}/approve`, {});
  service(db, finance, 'POST', `requisitions/${req.id}/approve`, {});

  // Agency & Recruiter setup
  const agency = createAgency(db, admin, { name: 'Pinnacle Talent', code: 'PINN', contact_name: 'Pat', contact_email: 'pat@pinn.com' });
  const m = addAgencyMember(db, admin, agency.id, { name: 'Pinnacle Agent', email: 'agent@pinn.com' });
  const agencyUser = db.prepare('SELECT * FROM users WHERE id=?').get(m.user_id);
  assignRequisitionToAgency(db, recruiter, agency.id, { requisitionId: req.id });

  // Submit candidate
  const sub = await service(db, agencyUser, 'POST', 'agency/submissions', {
    requisition_id: req.id,
    name: 'Chris Nolan',
    email: 'chris.nolan@example.com',
    skills: ['SQL', 'Data Modeling'],
    consent_confirmed: true
  });

  // 1. Initial stage mapping: Applied -> 'Submitted'
  let agencySubs = service(db, agencyUser, 'GET', 'agency/submissions');
  assert.equal(agencySubs.find(s => s.id === sub.id).status, 'Submitted');

  // 2. Internal Recruiter advances candidate: Applied -> Screening -> Interview -> Offer -> Hired
  service(db, recruiter, 'POST', `applications/${sub.application_id}/stage`, { stage: 'Screening' });
  agencySubs = service(db, agencyUser, 'GET', 'agency/submissions');
  assert.equal(agencySubs.find(s => s.id === sub.id).status, 'Under Review');

  service(db, recruiter, 'POST', `applications/${sub.application_id}/stage`, { stage: 'Interview' });
  agencySubs = service(db, agencyUser, 'GET', 'agency/submissions');
  assert.equal(agencySubs.find(s => s.id === sub.id).status, 'Interview in Progress');

  service(db, recruiter, 'POST', `applications/${sub.application_id}/stage`, { stage: 'Offer' });
  agencySubs = service(db, agencyUser, 'GET', 'agency/submissions');
  assert.equal(agencySubs.find(s => s.id === sub.id).status, 'Shortlisted');

  addSignedOffer(db, sub.application_id, { id: sub.candidate_id, name: 'Chris Nolan', email: 'chris.nolan@example.com' }, req);
  service(db, recruiter, 'POST', `applications/${sub.application_id}/stage`, { stage: 'Hired' });
  agencySubs = service(db, agencyUser, 'GET', 'agency/submissions');
  assert.equal(agencySubs.find(s => s.id === sub.id).status, 'Selected');

  // 3. Agency recruiter CANNOT modify candidate hiring decisions
  assert.throws(
    () => service(db, agencyUser, 'POST', `applications/${sub.application_id}/stage`, { stage: 'Rejected' }),
    /Your role cannot perform this action/
  );

  // 4. Confidentiality: Internal scorecards and notes are NOT exposed to agency
  const subDetail = service(db, agencyUser, 'GET', `agency/submissions/${sub.id}`);
  assert.equal(subDetail.status, 'Selected');
  assert.equal(subDetail.scorecards, undefined);
  assert.equal(subDetail.internal_notes, undefined);
  assert.equal(subDetail.fraud_review, undefined);

  // 5. Published agency feedback is visible once approved by internal recruiter
  publishAgencyFeedback(db, recruiter, sub.id, 'Candidate accepted offer. Background verification complete.');
  const subWithFeedback = service(db, agencyUser, 'GET', `agency/submissions/${sub.id}`);
  assert.equal(subWithFeedback.feedback, 'Candidate accepted offer. Background verification complete.');
});

test('Mandatory Test 5: Cross-agency isolation and suspension', async () => {
  const { db, admin, recruiter, manager, finance } = fixture();

  // Create requisition
  const req = service(db, recruiter, 'POST', 'requisitions', { ...reqBody, title: 'Lead DevOps Engineer', skills: ['DevOps', 'Terraform'] });
  service(db, recruiter, 'POST', `requisitions/${req.id}/submit`);
  service(db, manager, 'POST', `requisitions/${req.id}/approve`, {});
  service(db, finance, 'POST', `requisitions/${req.id}/approve`, {});

  // Agency A (Alpha)
  const agencyA = createAgency(db, admin, { name: 'Alpha Agency', code: 'ALPHA', contact_name: 'Alice', contact_email: 'alice@alpha.com' });
  const mA = addAgencyMember(db, admin, agencyA.id, { name: 'Alice Recruiter', email: 'alice.recruiter@alpha.com' });
  const userA = db.prepare('SELECT * FROM users WHERE id=?').get(mA.user_id);
  assignRequisitionToAgency(db, recruiter, agencyA.id, { requisitionId: req.id });

  // Agency B (Beta)
  const agencyB = createAgency(db, admin, { name: 'Beta Agency', code: 'BETA', contact_name: 'Bob', contact_email: 'bob@beta.com' });
  const mB = addAgencyMember(db, admin, agencyB.id, { name: 'Bob Recruiter', email: 'bob.recruiter@beta.com' });
  const userB = db.prepare('SELECT * FROM users WHERE id=?').get(mB.user_id);
  assignRequisitionToAgency(db, recruiter, agencyB.id, { requisitionId: req.id });

  // Agency A submits Candidate A
  const subA = await service(db, userA, 'POST', 'agency/submissions', {
    requisition_id: req.id,
    name: 'Candidate Alpha',
    email: 'cand.alpha@example.com',
    skills: ['DevOps'],
    consent_confirmed: true
  });

  // Agency B submits Candidate B
  const subB = await service(db, userB, 'POST', 'agency/submissions', {
    requisition_id: req.id,
    name: 'Candidate Beta',
    email: 'cand.beta@example.com',
    skills: ['Terraform'],
    consent_confirmed: true
  });

  // 1. Cross-Agency Isolation: Agency A queries submissions
  const subsA = service(db, userA, 'GET', 'agency/submissions');
  assert.equal(subsA.length, 1);
  assert.equal(subsA[0].candidate_email, 'cand.alpha@example.com');
  // Agency A must NEVER see Candidate B
  assert.equal(subsA.some(s => s.candidate_email === 'cand.beta@example.com'), false);

  // 2. Direct API tampering: Agency A tries to view Agency B's submission by ID
  assert.throws(
    () => service(db, userA, 'GET', `agency/submissions/${subB.id}`),
    /Submission record not found/
  );

  // 3. Suspend Agency A
  setAgencyStatus(db, admin, agencyA.id, 'suspended', 'Contract compliance review');

  // Verify Agency A is blocked immediately from all portal access and submissions
  assert.throws(
    () => service(db, userA, 'GET', 'agency/me'),
    /Agency account is currently suspended/
  );
  assert.throws(
    () => service(db, userA, 'GET', 'agency/dashboard'),
    /Agency account is currently suspended/
  );
  await assert.rejects(
    async () => service(db, userA, 'POST', 'agency/submissions', {
      requisition_id: req.id,
      name: 'Blocked Candidate',
      email: 'blocked@example.com',
      skills: ['DevOps'],
      consent_confirmed: true
    }),
    /Agency account is currently suspended/
  );

  // 4. Agency B continues working without interruption
  const bDashboard = service(db, userB, 'GET', 'agency/dashboard');
  assert.equal(bDashboard.agency.name, 'Beta Agency');
  assert.equal(bDashboard.stats.total_submissions, 1);

  // 5. Internal ATS still retains all historical candidate and audit records intact
  const internalCandidate = db.prepare('SELECT * FROM candidates WHERE email=?').get('cand.alpha@example.com');
  assert.ok(internalCandidate);
  assert.equal(internalCandidate.name, 'Candidate Alpha');

  const auditSuspended = db.prepare("SELECT * FROM audit WHERE event='agency.suspended' AND target=?").get(agencyA.id);
  assert.ok(auditSuspended);
});
