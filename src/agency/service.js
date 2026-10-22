import { id, now, audit, transaction } from '../db.js';
import { HttpError, text, email, phone as validatePhone, validateSkills } from '../policy.js';
import { ResumeAdapter } from '../adapters.js';

/**
 * Maps Orbit internal application stage to external agency-facing status.
 * Ensures internal stages and scorecards are not exposed verbatim.
 */
export function mapStageToAgencyStatus(stage) {
  switch (stage) {
    case 'Applied': return 'Submitted';
    case 'Screening': return 'Under Review';
    case 'Interview': return 'Interview in Progress';
    case 'Offer': return 'Shortlisted';
    case 'Hired': return 'Selected';
    case 'Rejected': return 'Rejected';
    default: return stage || 'Submitted';
  }
}

/**
 * Validates that an authenticated user belongs to an active recruitment agency.
 * Enforces agency-level and recruiter-level suspension checks.
 */
export function getAgencyContextForUser(db, user) {
  if (!user || user.status !== 'active') {
    throw new HttpError(401, 'User account is not active.');
  }

  const member = db.prepare(`
    SELECT m.id as member_id, m.agency_id, m.role as agency_role, m.status as member_status,
           a.name as agency_name, a.code as agency_code, a.status as agency_status,
           a.contact_email, a.contact_name
    FROM agency_members m
    JOIN agencies a ON a.id = m.agency_id
    WHERE m.user_id = ?
  `).get(user.id);

  if (!member) {
    throw new HttpError(403, 'User is not registered with any recruitment agency.');
  }

  if (member.agency_status === 'suspended') {
    throw new HttpError(403, 'Agency account is currently suspended. Submissions and portal access are disabled.');
  }
  if (member.agency_status === 'deactivated') {
    throw new HttpError(403, 'Agency account has been deactivated.');
  }
  if (member.member_status === 'suspended') {
    throw new HttpError(403, 'Your agency recruiter membership is currently suspended.');
  }

  return member;
}

// ==========================================
// INTERNAL RECRUITER & ADMIN AGENCY MANAGEMENT
// ==========================================

export function listAgencies(db, user, query = new URLSearchParams()) {
  const search = (query.get('q') || '').trim().toLowerCase();
  const statusFilter = (query.get('status') || '').trim();

  let sql = `
    SELECT a.*,
      (SELECT count(*) FROM agency_members m WHERE m.agency_id=a.id AND m.status='active') as active_recruiters,
      (SELECT count(*) FROM agency_requisitions ar WHERE ar.agency_id=a.id AND ar.status='active') as active_requisitions,
      (SELECT count(*) FROM agency_submissions s WHERE s.agency_id=a.id) as total_submissions
    FROM agencies a
    ORDER BY a.created_at DESC
  `;
  const rows = db.prepare(sql).all();

  return rows.filter(a => {
    if (statusFilter && a.status !== statusFilter) return false;
    if (search && !`${a.name} ${a.code} ${a.contact_name} ${a.contact_email}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

export function getAgency(db, user, agencyId) {
  const agency = db.prepare('SELECT * FROM agencies WHERE id=?').get(agencyId);
  if (!agency) throw new HttpError(404, 'Agency not found.');

  const members = db.prepare(`
    SELECT m.*, u.name, u.email, u.last_login
    FROM agency_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.agency_id = ?
    ORDER BY m.created_at ASC
  `).all(agencyId);

  const assignments = db.prepare(`
    SELECT ar.*, r.title, r.team, r.status as requisition_status
    FROM agency_requisitions ar
    JOIN requisitions r ON r.id = ar.requisition_id
    WHERE ar.agency_id = ?
    ORDER BY ar.created_at DESC
  `).all(agencyId);

  const submissions = db.prepare(`
    SELECT s.*, c.name as candidate_name, c.email as candidate_email,
           r.title as requisition_title, a.stage as internal_stage
    FROM agency_submissions s
    JOIN candidates c ON c.id = s.candidate_id
    JOIN requisitions r ON r.id = s.requisition_id
    JOIN applications a ON a.id = s.application_id
    WHERE s.agency_id = ?
    ORDER BY s.created_at DESC
  `).all(agencyId);

  return {
    ...agency,
    members,
    assignments,
    submissions: submissions.map(s => ({
      ...s,
      agency_status: mapStageToAgencyStatus(s.internal_stage)
    }))
  };
}

export function createAgency(db, user, data) {
  const name = text(data.name, 'Agency name', 200);
  const codeRaw = (data.code || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)).toUpperCase();
  const code = text(codeRaw, 'Agency code', 20);
  const contactName = text(data.contact_name, 'Contact name', 200);
  const contactEmail = email(data.contact_email);
  const contactPhone = validatePhone(data.contact_phone ?? '', true);
  const notes = text(data.notes ?? '', 'Notes', 2000, true);

  const existing = db.prepare('SELECT id FROM agencies WHERE name=? OR code=?').get(name, code);
  if (existing) throw new HttpError(409, 'An agency with this name or code already exists.');

  const aid = id();
  const nowStr = now();

  return transaction(db, () => {
    db.prepare(`
      INSERT INTO agencies(id, name, code, contact_name, contact_email, contact_phone, status, notes, created_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(aid, name, code, contactName, contactEmail, contactPhone, 'active', notes, user.id, nowStr, nowStr);

    audit(db, user.id, 'agency.created', aid, { name, code, contactEmail });
    return getAgency(db, user, aid);
  });
}

export function updateAgency(db, user, agencyId, data) {
  const agency = db.prepare('SELECT * FROM agencies WHERE id=?').get(agencyId);
  if (!agency) throw new HttpError(404, 'Agency not found.');

  const name = text(data.name || agency.name, 'Agency name', 200);
  const contactName = text(data.contact_name || agency.contact_name, 'Contact name', 200);
  const contactEmail = email(data.contact_email || agency.contact_email);
  const contactPhone = validatePhone(data.contact_phone !== undefined ? data.contact_phone : agency.contact_phone, true);
  const notes = text(data.notes !== undefined ? data.notes : agency.notes, 'Notes', 2000, true);

  const nowStr = now();
  db.prepare(`
    UPDATE agencies SET name=?, contact_name=?, contact_email=?, contact_phone=?, notes=?, updated_at=?
    WHERE id=?
  `).run(name, contactName, contactEmail, contactPhone, notes, nowStr, agencyId);

  audit(db, user.id, 'agency.updated', agencyId, { name, contactEmail });
  return getAgency(db, user, agencyId);
}

export function setAgencyStatus(db, user, agencyId, status, reason = '') {
  const agency = db.prepare('SELECT * FROM agencies WHERE id=?').get(agencyId);
  if (!agency) throw new HttpError(404, 'Agency not found.');

  const allowedStatuses = ['active', 'suspended', 'deactivated'];
  if (!allowedStatuses.includes(status)) {
    throw new HttpError(400, 'Invalid agency status. Supported: active, suspended, deactivated.');
  }

  const nowStr = now();
  db.prepare('UPDATE agencies SET status=?, updated_at=? WHERE id=?').run(status, nowStr, agencyId);

  audit(db, user.id, `agency.${status}`, agencyId, {
    previousStatus: agency.status,
    newStatus: status,
    reason: reason ? String(reason).trim() : undefined
  });

  return { id: agencyId, status, updated_at: nowStr };
}

export function addAgencyMember(db, user, agencyId, data) {
  const agency = db.prepare('SELECT * FROM agencies WHERE id=?').get(agencyId);
  if (!agency) throw new HttpError(404, 'Agency not found.');

  const memberName = text(data.name, 'Full name', 200);
  const memberEmail = email(data.email);
  const role = data.role === 'Agency Admin' ? 'Agency Admin' : 'Agency Recruiter';

  let u = db.prepare('SELECT * FROM users WHERE email=?').get(memberEmail);
  const nowStr = now();

  return transaction(db, () => {
    if (!u) {
      const uid = id();
      db.prepare(`
        INSERT INTO users(id, email, name, role, team, status, created_at)
        VALUES(?,?,?,?,?, 'active', ?)
      `).run(uid, memberEmail, memberName, role, agency.name, nowStr);
      u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    } else {
      db.prepare(`UPDATE users SET role=?, team=?, status='active' WHERE id=?`).run(role, agency.name, u.id);
    }

    const existingMember = db.prepare('SELECT id FROM agency_members WHERE user_id=?').get(u.id);
    if (existingMember) {
      throw new HttpError(409, 'This user is already a member of an agency.');
    }

    const mid = id();
    db.prepare(`
      INSERT INTO agency_members(id, agency_id, user_id, role, status, created_at, updated_at)
      VALUES(?,?,?,?, 'active', ?, ?)
    `).run(mid, agencyId, u.id, role, nowStr, nowStr);

    audit(db, user.id, 'agency.member_added', agencyId, {
      user_id: u.id,
      email: memberEmail,
      role
    });

    return db.prepare('SELECT m.*, u.name, u.email FROM agency_members m JOIN users u ON u.id=m.user_id WHERE m.id=?').get(mid);
  });
}

export function assignRequisitionToAgency(db, user, agencyId, { requisitionId, instructions = '', deadline = null }) {
  const agency = db.prepare('SELECT * FROM agencies WHERE id=?').get(agencyId);
  if (!agency) throw new HttpError(404, 'Agency not found.');
  if (agency.status !== 'active') throw new HttpError(400, 'Cannot assign requisitions to a suspended or inactive agency.');

  const req = db.prepare('SELECT * FROM requisitions WHERE id=?').get(requisitionId);
  if (!req) throw new HttpError(404, 'Requisition not found.');
  if (req.status !== 'open') throw new HttpError(400, 'Only approved and open requisitions can be assigned to agencies.');

  const nowStr = now();
  const cleanInstructions = instructions ? text(instructions, 'Instructions', 2000, true) : '';

  let deadlineIso = null;
  if (deadline) {
    const d = new Date(deadline);
    if (isNaN(d.getTime())) throw new HttpError(400, 'Enter a valid submission deadline.');
    deadlineIso = d.toISOString();
  }

  const existing = db.prepare('SELECT id, status FROM agency_requisitions WHERE agency_id=? AND requisition_id=?').get(agencyId, requisitionId);

  return transaction(db, () => {
    let aid;
    if (existing) {
      aid = existing.id;
      db.prepare(`
        UPDATE agency_requisitions SET status='active', instructions=?, deadline=?, assigned_by=?, updated_at=?
        WHERE id=?
      `).run(cleanInstructions, deadlineIso, user.id, nowStr, aid);
    } else {
      aid = id();
      db.prepare(`
        INSERT INTO agency_requisitions(id, agency_id, requisition_id, assigned_by, status, instructions, deadline, created_at, updated_at)
        VALUES(?,?,?,?, 'active', ?, ?, ?, ?)
      `).run(aid, agencyId, requisitionId, user.id, cleanInstructions, deadlineIso, nowStr, nowStr);
    }

    audit(db, user.id, 'agency.requisition_assigned', agencyId, {
      requisition_id: requisitionId,
      requisition_title: req.title,
      deadline: deadlineIso
    });

    return db.prepare(`
      SELECT ar.*, r.title, r.team, r.status as requisition_status
      FROM agency_requisitions ar
      JOIN requisitions r ON r.id = ar.requisition_id
      WHERE ar.id = ?
    `).get(aid);
  });
}

export function revokeRequisitionFromAgency(db, user, agencyId, requisitionId) {
  const assignment = db.prepare('SELECT id FROM agency_requisitions WHERE agency_id=? AND requisition_id=?').get(agencyId, requisitionId);
  if (!assignment) throw new HttpError(404, 'Assignment not found.');

  const nowStr = now();
  db.prepare(`UPDATE agency_requisitions SET status='revoked', updated_at=? WHERE id=?`).run(nowStr, assignment.id);

  audit(db, user.id, 'agency.requisition_revoked', agencyId, { requisition_id: requisitionId });
  return { ok: true, status: 'revoked' };
}

export function publishAgencyFeedback(db, user, submissionId, feedbackText) {
  const sub = db.prepare('SELECT * FROM agency_submissions WHERE id=?').get(submissionId);
  if (!sub) throw new HttpError(404, 'Submission not found.');

  const cleanFeedback = text(feedbackText, 'Agency feedback', 3000);
  const nowStr = now();

  db.prepare(`
    UPDATE agency_submissions SET agency_feedback=?, feedback_published_at=?, feedback_published_by=?, updated_at=?
    WHERE id=?
  `).run(cleanFeedback, nowStr, user.id, nowStr, submissionId);

  audit(db, user.id, 'agency.feedback_published', submissionId, {
    agency_id: sub.agency_id,
    candidate_id: sub.candidate_id
  });

  return { ok: true, submission_id: submissionId, agency_feedback: cleanFeedback, published_at: nowStr };
}

// ==========================================
// AGENCY RECRUITER PORTAL OPERATIONS
// ==========================================

export function getAgencyDashboard(db, user) {
  const member = getAgencyContextForUser(db, user);
  const agencyId = member.agency_id;

  const assignedReqs = db.prepare(`
    SELECT count(*) n FROM agency_requisitions ar
    JOIN requisitions r ON r.id = ar.requisition_id
    WHERE ar.agency_id = ? AND ar.status = 'active' AND r.status = 'open'
  `).get(agencyId).n;

  const submissions = db.prepare(`
    SELECT s.id, a.stage FROM agency_submissions s
    JOIN applications a ON a.id = s.application_id
    WHERE s.agency_id = ?
  `).all(agencyId);

  const stats = {
    assigned_requisitions: assignedReqs,
    total_submissions: submissions.length,
    under_review: submissions.filter(s => ['Applied', 'Screening'].includes(s.stage)).length,
    interviewing: submissions.filter(s => s.stage === 'Interview').length,
    shortlisted: submissions.filter(s => s.stage === 'Offer').length,
    selected: submissions.filter(s => s.stage === 'Hired').length,
    rejected: submissions.filter(s => s.stage === 'Rejected').length
  };

  const recentSubmissions = db.prepare(`
    SELECT s.id, s.created_at, s.agency_feedback, s.feedback_published_at,
           c.name as candidate_name, c.email as candidate_email,
           r.title as requisition_title, a.stage as internal_stage
    FROM agency_submissions s
    JOIN candidates c ON c.id = s.candidate_id
    JOIN requisitions r ON r.id = s.requisition_id
    JOIN applications a ON a.id = s.application_id
    WHERE s.agency_id = ?
    ORDER BY s.created_at DESC
    LIMIT 6
  `).all(agencyId).map(s => ({
    id: s.id,
    reference: `SUB-${s.id.slice(0, 8).toUpperCase()}`,
    candidate_name: s.candidate_name,
    candidate_email: s.candidate_email,
    requisition_title: s.requisition_title,
    status: mapStageToAgencyStatus(s.internal_stage),
    submitted_at: s.created_at,
    feedback: s.agency_feedback || null
  }));

  return {
    agency: {
      id: member.agency_id,
      name: member.agency_name,
      code: member.agency_code,
      role: member.agency_role,
      status: member.agency_status || 'active'
    },
    stats: {
      assignedRequisitions: assignedReqs,
      assigned_requisitions: assignedReqs,
      totalSubmissions: submissions.length,
      total_submissions: submissions.length,
      underReview: submissions.filter(s => ['Applied', 'Screening'].includes(s.stage)).length,
      under_review: submissions.filter(s => ['Applied', 'Screening'].includes(s.stage)).length,
      interviews: submissions.filter(s => s.stage === 'Interview').length,
      interviewing: submissions.filter(s => s.stage === 'Interview').length,
      shortlisted: submissions.filter(s => s.stage === 'Offer').length,
      selected: submissions.filter(s => s.stage === 'Hired').length,
      rejected: submissions.filter(s => s.stage === 'Rejected').length
    },
    recentSubmissions: recentSubmissions.map(s => ({
      ...s,
      submission_ref: s.reference,
      agency_status: s.status,
      published_feedback: s.feedback
    })),
    assignedRequisitions: listAssignedRequisitions(db, user).slice(0, 5)
  };
}

export function listAssignedRequisitions(db, user, query = new URLSearchParams()) {
  const member = getAgencyContextForUser(db, user);
  const search = (query.get('q') || '').trim().toLowerCase();

  const rows = db.prepare(`
    SELECT ar.id as assignment_id, ar.instructions, ar.deadline, ar.created_at as assigned_at,
           r.id, r.title, r.team, r.description, r.skills, r.currency, r.salary_min, r.salary_max
    FROM agency_requisitions ar
    JOIN requisitions r ON r.id = ar.requisition_id
    WHERE ar.agency_id = ? AND ar.status = 'active' AND r.status = 'open'
    ORDER BY ar.created_at DESC
  `).all(member.agency_id);

  return rows
    .filter(r => {
      if (search && !`${r.title} ${r.team} ${r.description} ${r.skills}`.toLowerCase().includes(search)) return false;
      return true;
    })
    .map(r => ({
      id: r.id,
      assignment_id: r.assignment_id,
      title: r.title,
      team: r.team,
      description: r.description,
      skills: JSON.parse(r.skills || '[]'),
      currency: r.currency,
      instructions: r.instructions || '',
      deadline: r.deadline || null,
      assigned_at: r.assigned_at
    }));
}

export function getAssignedRequisition(db, user, reqId) {
  const member = getAgencyContextForUser(db, user);

  const row = db.prepare(`
    SELECT ar.id as assignment_id, ar.instructions, ar.deadline, ar.created_at as assigned_at,
           r.id, r.title, r.team, r.description, r.skills, r.currency, r.status
    FROM agency_requisitions ar
    JOIN requisitions r ON r.id = ar.requisition_id
    WHERE ar.agency_id = ? AND ar.requisition_id = ? AND ar.status = 'active'
  `).get(member.agency_id, reqId);

  if (!row || row.status !== 'open') {
    throw new HttpError(404, 'Assigned open requisition not found.');
  }

  return {
    id: row.id,
    assignment_id: row.assignment_id,
    title: row.title,
    team: row.team,
    description: row.description,
    skills: JSON.parse(row.skills || '[]'),
    currency: row.currency,
    instructions: row.instructions || '',
    deadline: row.deadline || null,
    assigned_at: row.assigned_at
  };
}

export async function submitAgencyCandidate(db, user, data, { resumeAdapter } = {}) {
  const member = getAgencyContextForUser(db, user);
  const reqId = text(data.requisition_id, 'Requisition ID', 100);

  // 1. Verify Requisition is actively assigned to this agency and open
  const assignment = db.prepare(`
    SELECT * FROM agency_requisitions WHERE agency_id=? AND requisition_id=? AND status='active'
  `).get(member.agency_id, reqId);

  if (!assignment) {
    throw new HttpError(403, 'This requisition is not assigned to your agency.');
  }

  const req = db.prepare('SELECT * FROM requisitions WHERE id=?').get(reqId);
  if (!req || req.status !== 'open') {
    throw new HttpError(400, 'Submissions are only accepted for open requisitions.');
  }

  if (assignment.deadline && new Date(assignment.deadline).getTime() < Date.now()) {
    throw new HttpError(400, 'The submission deadline for this requisition has passed.');
  }

  // 2. Validate Candidate Details
  const name = text(data.name, 'Candidate name', 200);
  const candEmail = email(data.email);
  const phone = validatePhone(data.phone ?? '', true);
  const skills = validateSkills(data.skills);
  const consent = Boolean(data.consent_confirmed ?? data.consent ?? data.representation_confirmed);
  if (!consent) {
    throw new HttpError(400, 'Candidate affirmative consent to share information must be confirmed.');
  }

  let resumeText = (data.resume_text || data.experience || '').trim();
  let resumeStorageId = null;
  let resumeFilename = null;
  let resumeId = data.resume_id ? String(data.resume_id) : null;

  // 3. Handle Resume File if provided
  if (data.buffer && Buffer.isBuffer(data.buffer)) {
    const adapter = resumeAdapter || new ResumeAdapter({ enabled: true });
    try {
      const parsed = await adapter.processUpload({
        buffer: data.buffer,
        filename: data.filename || `${name.replace(/\s+/g, '_')}_resume`,
        mimeType: data.mimeType || ''
      });
      resumeStorageId = parsed.storageId;
      resumeFilename = parsed.filename;
      if (!resumeText) resumeText = parsed.text;
    } catch (err) {
      throw new HttpError(400, `Resume validation failed: ${err.message}`);
    }
  } else if (resumeId) {
    const resRow = db.prepare('SELECT * FROM candidate_resumes WHERE id=?').get(resumeId);
    if (resRow) {
      resumeStorageId = resRow.storage_id;
      resumeFilename = resRow.filename;
    }
  }

  // 4. Duplicate & Conflict Detection
  const existingCand = db.prepare('SELECT * FROM candidates WHERE email=?').get(candEmail);
  if (existingCand) {
    const existingApp = db.prepare('SELECT * FROM applications WHERE candidate_id=? AND requisition_id=?').get(existingCand.id, req.id);
    if (existingApp) {
      const sameAgencySub = db.prepare('SELECT * FROM agency_submissions WHERE candidate_id=? AND requisition_id=? AND agency_id=?').get(existingCand.id, req.id, member.agency_id);
      if (sameAgencySub) {
        throw new HttpError(409, 'A candidate with this email has already been submitted by your agency for this requisition.');
      }
      // STRICT PRIVACY: Do not disclose the other agency's identity
      audit(db, user.id, 'agency.duplicate_conflict', req.id, {
        candidate_id: existingCand.id,
        email: candEmail,
        submitting_agency: member.agency_id
      });
      throw new HttpError(409, 'This candidate is already being actively evaluated for this position.');
    }
  }

  // 5. Atomic Transaction with Concurrency & Data Integrity Protection
  return transaction(db, () => {
    const nowStr = now();
    let candId;
    let ownershipStatus = existingCand ? 'existing_candidate' : 'owned_by_agency';

    if (existingCand) {
      candId = existingCand.id;
    } else {
      // New candidate
      candId = id();
      db.prepare(`
        INSERT INTO candidates(id, name, email, phone, skills, resume_text, source, team, created_by, created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(
        candId,
        name,
        candEmail,
        phone,
        JSON.stringify(skills),
        resumeText,
        `Agency: ${member.agency_name}`,
        req.team,
        user.id,
        nowStr
      );
    }

    // Create Application in 'Applied' stage
    const appId = id();
    db.prepare(`
      INSERT INTO applications(id, candidate_id, requisition_id, stage, created_at)
      VALUES(?,?,?,?,?)
    `).run(appId, candId, req.id, 'Applied', nowStr);

    // Attach resume record if we have storage ID
    if (resumeStorageId && !resumeId) {
      resumeId = id();
      db.prepare(`
        INSERT INTO candidate_resumes(id, candidate_id, storage_id, filename, file_format, file_size, mime_type, scan_status, extraction_status, uploaded_by, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,'clean','success',?,?,?)
      `).run(
        resumeId,
        candId,
        resumeStorageId,
        resumeFilename || 'resume.pdf',
        (resumeFilename && resumeFilename.endsWith('.docx')) ? 'docx' : 'pdf',
        data.buffer ? data.buffer.length : 1024,
        'application/pdf',
        user.id,
        nowStr,
        nowStr
      );
    } else if (resumeId) {
      db.prepare(`UPDATE candidate_resumes SET candidate_id=?, updated_at=? WHERE id=?`).run(candId, nowStr, resumeId);
    }

    // Create Agency Submission Record
    const subId = id();
    const notes = text(data.notes ?? '', 'Notes', 2000, true);
    db.prepare(`
      INSERT INTO agency_submissions(id, agency_id, requisition_id, candidate_id, application_id, submitted_by, resume_storage_id, resume_filename, notes, consent_confirmed, status, ownership_status, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,1,'Submitted',?,?,?)
    `).run(
      subId,
      member.agency_id,
      req.id,
      candId,
      appId,
      user.id,
      resumeStorageId,
      resumeFilename,
      notes,
      ownershipStatus,
      nowStr,
      nowStr
    );

    audit(db, user.id, 'agency.candidate_submitted', subId, {
      agency_id: member.agency_id,
      requisition_id: req.id,
      candidate_id: candId,
      application_id: appId,
      ownership_status: ownershipStatus
    });

    const resultObj = {
      id: subId,
      reference: `SUB-${subId.slice(0, 8).toUpperCase()}`,
      submission_ref: `SUB-${subId.slice(0, 8).toUpperCase()}`,
      candidate_id: candId,
      application_id: appId,
      requisition_id: req.id,
      status: 'Submitted',
      agency_status: 'Submitted',
      ownership_status: ownershipStatus,
      created_at: nowStr,
      submitted_at: nowStr
    };

    return {
      ok: true,
      submission: resultObj,
      ...resultObj
    };
  });
}

export function listAgencySubmissions(db, user, query = new URLSearchParams()) {
  const member = getAgencyContextForUser(db, user);
  const search = (query.get('q') || '').trim().toLowerCase();

  const rows = db.prepare(`
    SELECT s.id, s.created_at, s.notes, s.resume_filename, s.agency_feedback, s.feedback_published_at,
           c.id as candidate_id, c.name as candidate_name, c.email as candidate_email, c.phone as candidate_phone, c.skills as candidate_skills,
           r.id as requisition_id, r.title as requisition_title, r.team as requisition_team,
           a.id as application_id, a.stage as internal_stage
    FROM agency_submissions s
    JOIN candidates c ON c.id = s.candidate_id
    JOIN requisitions r ON r.id = s.requisition_id
    JOIN applications a ON a.id = s.application_id
    WHERE s.agency_id = ?
    ORDER BY s.created_at DESC
  `).all(member.agency_id);

  return rows
    .filter(s => {
      if (search && !`${s.candidate_name} ${s.candidate_email} ${s.requisition_title}`.toLowerCase().includes(search)) return false;
      return true;
    })
    .map(s => {
      const ref = `SUB-${s.id.slice(0, 8).toUpperCase()}`;
      const mappedStatus = mapStageToAgencyStatus(s.internal_stage);
      const fb = s.feedback_published_at ? s.agency_feedback : null;
      return {
        id: s.id,
        reference: ref,
        submission_ref: ref,
        candidate_id: s.candidate_id,
        candidate_name: s.candidate_name,
        candidate_email: s.candidate_email,
        candidate_phone: s.candidate_phone,
        skills: JSON.parse(s.candidate_skills || '[]'),
        requisition_id: s.requisition_id,
        requisition_title: s.requisition_title,
        requisition_team: s.requisition_team,
        status: mappedStatus,
        agency_status: mappedStatus,
        feedback: fb,
        published_feedback: fb,
        has_feedback: Boolean(fb),
        submitted_at: s.created_at,
        created_at: s.created_at
      };
    });
}

export function getAgencySubmission(db, user, submissionId) {
  const member = getAgencyContextForUser(db, user);

  const s = db.prepare(`
    SELECT s.id, s.agency_id, s.created_at, s.notes, s.resume_filename, s.agency_feedback, s.feedback_published_at,
           c.id as candidate_id, c.name as candidate_name, c.email as candidate_email, c.phone as candidate_phone, c.skills as candidate_skills,
           r.id as requisition_id, r.title as requisition_title, r.team as requisition_team,
           a.id as application_id, a.stage as internal_stage
    FROM agency_submissions s
    JOIN candidates c ON c.id = s.candidate_id
    JOIN requisitions r ON r.id = s.requisition_id
    JOIN applications a ON a.id = s.application_id
    WHERE s.id = ?
  `).get(submissionId);

  if (!s || s.agency_id !== member.agency_id) {
    throw new HttpError(404, 'Submission record not found.');
  }

  return {
    id: s.id,
    reference: `SUB-${s.id.slice(0, 8).toUpperCase()}`,
    candidate_id: s.candidate_id,
    candidate_name: s.candidate_name,
    candidate_email: s.candidate_email,
    candidate_phone: s.candidate_phone,
    skills: JSON.parse(s.candidate_skills || '[]'),
    requisition_id: s.requisition_id,
    requisition_title: s.requisition_title,
    requisition_team: s.requisition_team,
    status: mapStageToAgencyStatus(s.internal_stage),
    notes: s.notes,
    feedback: s.feedback_published_at ? s.agency_feedback : null,
    submitted_at: s.created_at
  };
}

export function listAgencyMembers(db, user) {
  const member = getAgencyContextForUser(db, user);
  if (member.agency_role !== 'Agency Admin') {
    throw new HttpError(403, 'Only agency administrators can manage agency recruiters.');
  }

  return db.prepare(`
    SELECT m.id, m.role, m.status, m.created_at, u.id as user_id, u.name, u.email, u.last_login
    FROM agency_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.agency_id = ?
    ORDER BY m.created_at ASC
  `).all(member.agency_id);
}

export function addAgencyRecruiter(db, user, data) {
  const member = getAgencyContextForUser(db, user);
  if (member.agency_role !== 'Agency Admin') {
    throw new HttpError(403, 'Only agency administrators can add recruiters.');
  }

  return addAgencyMember(db, user, member.agency_id, {
    name: data.name,
    email: data.email,
    role: data.role || 'Agency Recruiter'
  });
}

export function updateAgencyRecruiterStatus(db, user, memberId, status) {
  const adminMember = getAgencyContextForUser(db, user);
  if (adminMember.agency_role !== 'Agency Admin') {
    throw new HttpError(403, 'Only agency administrators can update recruiter status.');
  }

  const target = db.prepare('SELECT * FROM agency_members WHERE id=? AND agency_id=?').get(memberId, adminMember.agency_id);
  if (!target) throw new HttpError(404, 'Recruiter member not found.');

  const allowed = ['active', 'suspended'];
  if (!allowed.includes(status)) throw new HttpError(400, 'Invalid member status.');

  const nowStr = now();
  db.prepare('UPDATE agency_members SET status=?, updated_at=? WHERE id=?').run(status, nowStr, memberId);
  db.prepare("UPDATE users SET status=? WHERE id=?").run(status === 'active' ? 'active' : 'disabled', target.user_id);

  audit(db, user.id, `agency.member_${status}`, memberId, { agency_id: adminMember.agency_id });
  return { ok: true, status };
}
