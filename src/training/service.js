/**
 * Pre-Onboarding Training Plan Module Service for Orbit ATS.
 * Manages position- and role-specific training plan templates,
 * deterministic suggestion rules, candidate-specific draft persistence,
 * dynamic variable interpolation, resource attachments, and explicit manual confirmation sends.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { id, now, audit, transaction } from '../db.js';
import { HttpError, requirePermission as permit, text as validateText, integer, email as validateEmail } from '../policy.js';
import { escapeHtml } from '../communication/templates.js';
import { sendCandidateCommunication } from '../communication/service.js';
import { CommunicationAdapter } from '../adapters.js';

const ASSETS_DIR = resolve('data/training_assets');

function ensureAssetsDir() {
  if (!existsSync(ASSETS_DIR)) {
    mkdirSync(ASSETS_DIR, { recursive: true });
  }
}

/**
 * Standard seed templates for default organizational initialization.
 */
export const DEFAULT_TRAINING_TEMPLATES = [
  {
    name: 'Software Engineering Pre-Onboarding Training Plan',
    description: 'Technical orientation, local environment setup, architecture review, and development standards for engineering candidates.',
    status: 'active',
    is_default: 0,
    subject: 'Pre-Onboarding Technical Training Plan: {{employment.designation}} at {{company.name}}',
    introduction: 'Welcome to Mechlin Technologies! Ahead of your start date as {{employment.designation}} with the {{requisition.department}} team, we have organized this pre-onboarding technical training plan to prepare your local development environment, architecture understanding, and engineering best practices.',
    objectives: '• Configure and verify your local development environment and CLI tooling.\n• Review Orbit system architecture, data models, and API interfaces.\n• Understand engineering testing standards, code reviews, and quality gates.\n• Familiarize yourself with security policies, credential management, and privacy requirements.',
    sections: [
      {
        id: 'sec-eng-1',
        title: '1. Local Environment & Tooling Setup',
        content: 'Install Node.js 22 LTS, Git, and your preferred code editor. Configure SSH keys and verify access to code repositories and development guidelines.',
        order: 1
      },
      {
        id: 'sec-eng-2',
        title: '2. Architecture & Data Layer Overview',
        content: 'Review system architecture documentation, SQLite database schemas, API routing conventions, and transactional event handling patterns.',
        order: 2
      },
      {
        id: 'sec-eng-3',
        title: '3. Coding Standards & Testing Guidelines',
        content: 'Review our automated test practices. Ensure all local changes pass unit tests, policy checks, and security scans prior to pull request submission.',
        order: 3
      },
      {
        id: 'sec-eng-4',
        title: '4. Security, Credentials & Compliance',
        content: 'Follow secure development guidelines. Never hardcode credentials, tokens, or personal candidate data. Adhere to role-based access policies and audit logging.',
        order: 4
      }
    ],
    learning_links: [
      {
        id: 'link-eng-1',
        title: 'Node.js Official Documentation',
        url: 'https://nodejs.org/docs/latest/api/',
        description: 'Core runtime APIs, standard library reference, and asynchronous programming specifications'
      },
      {
        id: 'link-eng-2',
        title: 'Mechlin Engineering Handbook',
        url: 'https://mechlintech.com/docs/engineering-handbook',
        description: 'Architecture patterns, coding standards, CI/CD pipelines, and pull request workflows'
      }
    ],
    resources: [],
    duration_text: '2 Weeks',
    support_contact: {
      name: 'Engineering TA & Mentorship Team',
      email: 'eng-onboarding@mechlintech.com',
      role: 'Technical Onboarding Lead',
      notes: 'Available for technical environment setup queries Mon–Fri 9am–6pm IST'
    },
    positions: ['Software Engineer', 'Senior Software Engineer', 'Full Stack Developer', 'Backend Developer', 'Frontend Developer', 'Lead Engineer'],
    departments: ['Engineering', 'Technology', 'Product Engineering'],
    roles: ['Software Engineer', 'Full Stack Engineer', 'Backend Engineer', 'Frontend Engineer', 'Engineer']
  },
  {
    name: 'HR & Talent Operations Training Plan',
    description: 'Talent acquisition lifecycle, pipeline governance, offer signing workflows, and candidate compliance.',
    status: 'active',
    is_default: 0,
    subject: 'Pre-Onboarding Training Plan: {{employment.designation}} at {{company.name}}',
    introduction: 'Welcome to Mechlin! As you prepare to join our {{requisition.department}} team as {{employment.designation}}, this training plan outlines our talent acquisition workflows, pipeline governance policies, and candidate experience standards.',
    objectives: '• Master the Smart Hybrid recruitment pipeline stages and candidate movement rules.\n• Understand candidate evaluation rubrics, interview scorecards, and feedback blinding.\n• Learn Offer Letter Studio configuration, compensation annexures, and e-signatures.\n• Gain proficiency in recruitment compliance, data privacy, and HRMS handoff.',
    sections: [
      {
        id: 'sec-hr-1',
        title: '1. Recruitment Pipeline Governance',
        content: 'Understand applicant progression across stages, mandatory gates, proxy scorecard policies, and headcount constraints.',
        order: 1
      },
      {
        id: 'sec-hr-2',
        title: '2. Offer Letter Studio & Electronic Signatures',
        content: 'Learn how to configure offer templates, verify salary annexures, issue signature requests, and monitor signing completion.',
        order: 2
      },
      {
        id: 'sec-hr-3',
        title: '3. Compliance & Candidate Experience',
        content: 'Adhere to equal opportunity hiring principles, candidate communication opt-out preferences, and data privacy regulations.',
        order: 3
      }
    ],
    learning_links: [
      {
        id: 'link-hr-1',
        title: 'Talent Acquisition Handbook',
        url: 'https://mechlintech.com/docs/hr-handbook',
        description: 'Standard operating procedures for recruitment, interviewer assignment, and compliance'
      }
    ],
    resources: [],
    duration_text: '1 Week',
    support_contact: {
      name: 'People & Culture Team',
      email: 'hr-onboarding@mechlintech.com',
      role: 'HR Operations Lead',
      notes: 'Available Mon–Fri 9am–6pm IST for any questions regarding hiring policies'
    },
    positions: ['HR Executive', 'Recruiter', 'Senior Recruiter', 'Talent Acquisition Specialist', 'HR Manager', 'Talent Partner'],
    departments: ['Human Resources', 'Talent Acquisition', 'People & Culture', 'HR'],
    roles: ['HR Executive', 'Recruiter', 'Senior Recruiter', 'Talent Partner']
  },
  {
    name: 'General Organization Orientation & Pre-Onboarding Plan',
    description: 'Company-wide orientation, values, workplace tools, and cross-functional expectations for all new team members.',
    status: 'active',
    is_default: 1,
    subject: 'Welcome to {{company.name}}! Your Pre-Onboarding Preparation Plan',
    introduction: 'Welcome to Mechlin Technologies! We are delighted to have you join our team as {{employment.designation}}. This orientation guide provides essential details about our company culture, workplace tools, communication norms, and what to anticipate during your first week.',
    objectives: '• Learn about Mechlin\'s mission, organizational principles, and customer commitments.\n• Familiarize yourself with company communication tools, calendar etiquette, and documentation standards.\n• Review what to expect on Day 1, mentor introductions, and initial 30-day goals.',
    sections: [
      {
        id: 'sec-gen-1',
        title: '1. Welcome & Company Overview',
        content: 'Learn about Mechlin\'s culture, core values, organizational structure, and client partnership model.',
        order: 1
      },
      {
        id: 'sec-gen-2',
        title: '2. Workplace Tools & Collaboration',
        content: 'Overview of corporate email, calendar scheduling, virtual meeting standards, and internal communication channels.',
        order: 2
      },
      {
        id: 'sec-gen-3',
        title: '3. First Week Schedule & Getting Started',
        content: 'Review your Day 1 schedule, IT hardware handover, mentor pairing, and team introductions.',
        order: 3
      }
    ],
    learning_links: [
      {
        id: 'link-gen-1',
        title: 'Mechlin Organization Portal',
        url: 'https://mechlintech.com/about',
        description: 'Company history, leadership, and operational culture'
      }
    ],
    resources: [],
    duration_text: '1 Week',
    support_contact: {
      name: 'Mechlin Onboarding Coordinator',
      email: 'onboarding@mechlintech.com',
      role: 'Talent Experience Lead',
      notes: 'Please reach out with any pre-joining inquiries'
    },
    positions: [],
    departments: [],
    roles: []
  }
];

export function parseTemplateRow(row) {
  if (!row) return null;
  return {
    ...row,
    is_default: Boolean(row.is_default),
    sections: safeJsonParse(row.sections, []),
    learning_links: safeJsonParse(row.learning_links, []),
    resources: safeJsonParse(row.resources, []),
    support_contact: safeJsonParse(row.support_contact, {}),
    positions: safeJsonParse(row.positions, []),
    departments: safeJsonParse(row.departments, []),
    roles: safeJsonParse(row.roles, [])
  };
}

export function parseDraftRow(row) {
  if (!row) return null;
  return {
    ...row,
    is_override: Boolean(row.is_override),
    sections: safeJsonParse(row.sections, []),
    learning_links: safeJsonParse(row.learning_links, []),
    resources: safeJsonParse(row.resources, []),
    support_contact: safeJsonParse(row.support_contact, {})
  };
}

function safeJsonParse(val, fallback) {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

/**
 * Automatically seeds default pre-onboarding training plan templates if table is empty.
 */
export function seedDefaultTrainingTemplatesIfEmpty(db) {
  try {
    const existing = db.prepare('SELECT count(*) as count FROM training_plan_templates').get();
    if (existing && existing.count > 0) return;

    const userRow = db.prepare("SELECT id FROM users WHERE role='System Admin' LIMIT 1").get()
      || db.prepare("SELECT id FROM users LIMIT 1").get();
    const creatorId = userRow?.id || 'system';
    const nowStr = now();

    for (const tpl of DEFAULT_TRAINING_TEMPLATES) {
      db.prepare(`
        INSERT INTO training_plan_templates(
          id, name, description, status, version, is_default,
          subject, introduction, objectives, sections, learning_links, resources,
          duration_text, support_contact, positions, departments, roles,
          created_by, created_at, updated_at
        ) VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id(),
        tpl.name,
        tpl.description,
        tpl.status,
        tpl.is_default ? 1 : 0,
        tpl.subject,
        tpl.introduction,
        tpl.objectives,
        JSON.stringify(tpl.sections),
        JSON.stringify(tpl.learning_links),
        JSON.stringify(tpl.resources),
        tpl.duration_text,
        JSON.stringify(tpl.support_contact),
        JSON.stringify(tpl.positions),
        JSON.stringify(tpl.departments),
        JSON.stringify(tpl.roles),
        creatorId,
        nowStr,
        nowStr
      );
    }
  } catch {}
}

/**
 * Validates a web URL scheme (only http: and https: are allowed).
 */
export function validateUrl(urlStr, fieldName = 'URL') {
  if (!urlStr) throw new HttpError(400, `${fieldName} is required.`);
  let parsed;
  try {
    parsed = new URL(String(urlStr).trim());
  } catch {
    throw new HttpError(400, `${fieldName} must be a valid URL (e.g. https://example.com).`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new HttpError(400, `${fieldName} must use HTTPS or HTTP scheme.`);
  }
  return parsed.toString();
}

/**
 * Sanitizes a URL, returning null if invalid or scheme is unsafe.
 */
export function sanitizeUrl(urlStr) {
  try {
    return validateUrl(urlStr, 'URL');
  } catch {
    return null;
  }
}

/**
 * Normalizes user parameter whether provided as user object, user ID string, or fallback admin.
 */
function normalizeUser(db, userOrId) {
  if (userOrId && typeof userOrId === 'object' && userOrId.role) {
    return userOrId;
  }
  const uid = typeof userOrId === 'object' ? userOrId?.id : userOrId;
  if (uid && typeof uid === 'string') {
    const found = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (found) return found;
  }
  return { id: uid || 'system-admin', role: 'System Admin', team: 'Engineering', status: 'active' };
}

/**
 * List all training plan templates with optional status filter and search query.
 */
export function listTrainingTemplates(db, user, query = {}) {
  permit(user, 'recruit', 'review', 'admin');
  seedDefaultTrainingTemplatesIfEmpty(db);

  let sql = 'SELECT * FROM training_plan_templates WHERE 1=1';
  const params = [];

  const status = query.status || query.get?.('status');
  if (status && status !== 'all') {
    sql += ' AND status = ?';
    params.push(status);
  }

  const search = query.search || query.get?.('search') || query.q || query.get?.('q');
  if (search && String(search).trim()) {
    sql += ' AND (name LIKE ? OR description LIKE ? OR subject LIKE ? OR positions LIKE ?)';
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term);
  }

  sql += ' ORDER BY is_default DESC, updated_at DESC';

  const rows = db.prepare(sql).all(...params);
  return rows.map(parseTemplateRow);
}

/**
 * Get a single training plan template by ID.
 */
export function getTrainingTemplate(db, arg2, arg3) {
  let user, templateId;
  if (typeof arg2 === 'string') {
    templateId = arg2;
    user = normalizeUser(db, arg3);
  } else {
    user = normalizeUser(db, arg2);
    templateId = arg3;
  }
  permit(user, 'recruit', 'review', 'admin');
  seedDefaultTrainingTemplatesIfEmpty(db);

  const row = db.prepare('SELECT * FROM training_plan_templates WHERE id = ?').get(templateId);
  if (!row) throw new HttpError(404, 'Training plan template not found.');
  return parseTemplateRow(row);
}

/**
 * Create a new training plan template.
 */
export function createTrainingTemplate(db, userOrBody, bodyOrUser = {}) {
  let user, body;
  if (userOrBody && userOrBody.role) {
    user = userOrBody;
    body = bodyOrUser;
  } else if (bodyOrUser && (bodyOrUser.role || typeof bodyOrUser === 'string')) {
    user = normalizeUser(db, bodyOrUser);
    body = userOrBody;
  } else {
    user = normalizeUser(db, userOrBody);
    body = bodyOrUser;
  }
  permit(user, 'recruit', 'admin');

  const name = validateText(body.name, 'Template name', 150);
  const description = validateText(body.description || '', 'Description', 1000, true);
  const subject = validateText(body.subject, 'Email subject', 300);
  const introduction = validateText(body.introduction || '', 'Introduction', 5000, true);
  const objectives = validateText(body.objectives || '', 'Objectives', 5000, true);
  const durationText = validateText(body.duration_text || body.duration || '', 'Duration', 100, true);
  const status = ['draft', 'active', 'archived', 'inactive'].includes(body.status) ? (body.status === 'inactive' ? 'draft' : body.status) : 'active';
  const isDefault = Boolean(body.is_default);

  const positions = Array.isArray(body.positions) ? body.positions.map(p => String(p).trim()).filter(Boolean) : [];
  const departments = Array.isArray(body.departments) ? body.departments.map(d => String(d).trim()).filter(Boolean) : [];
  const roles = Array.isArray(body.roles) ? body.roles.map(r => String(r).trim()).filter(Boolean) : [];

  const sections = Array.isArray(body.sections) ? body.sections.map((s, idx) => ({
    id: s.id || `sec-${idx + 1}`,
    title: String(s.title || `Section ${idx + 1}`).trim().slice(0, 150),
    content: String(s.content || '').trim().slice(0, 5000),
    order: Number(s.order) || (idx + 1)
  })) : [];

  const learningLinks = Array.isArray(body.learning_links) ? body.learning_links.map((l, idx) => {
    const url = validateUrl(l.url, `Learning link ${idx + 1} URL`);
    return {
      id: l.id || `link-${idx + 1}`,
      title: validateText(l.title, `Learning link ${idx + 1} title`, 150),
      url,
      description: validateText(l.description || '', `Learning link ${idx + 1} description`, 500, true)
    };
  }) : [];

  const resources = Array.isArray(body.resources) ? body.resources : [];
  const supportContact = typeof body.support_contact === 'object' && body.support_contact !== null ? {
    name: validateText(body.support_contact.name || '', 'Support contact name', 100, true),
    email: body.support_contact.email ? validateEmail(body.support_contact.email) : '',
    role: validateText(body.support_contact.role || '', 'Support contact role', 100, true),
    notes: validateText(body.support_contact.notes || '', 'Support contact notes', 500, true)
  } : {};

  const templateId = id();
  const createdAt = now();

  return transaction(db, () => {
    if (isDefault) {
      db.prepare('UPDATE training_plan_templates SET is_default = 0 WHERE is_default = 1').run();
    }

    db.prepare(`
      INSERT INTO training_plan_templates(
        id, name, description, status, version, is_default,
        subject, introduction, objectives, sections, learning_links, resources,
        duration_text, support_contact, positions, departments, roles,
        created_by, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      templateId,
      name,
      description,
      status,
      isDefault ? 1 : 0,
      subject,
      introduction,
      objectives,
      JSON.stringify(sections),
      JSON.stringify(learningLinks),
      JSON.stringify(resources),
      durationText,
      JSON.stringify(supportContact),
      JSON.stringify(positions),
      JSON.stringify(departments),
      JSON.stringify(roles),
      user.id,
      createdAt,
      createdAt
    );

    audit(db, user.id, 'training_plan.template_created', templateId, {
      name,
      status,
      is_default: isDefault,
      positions
    });

    return getTrainingTemplate(db, user, templateId);
  });
}

/**
 * Update an existing training plan template.
 */
export function updateTrainingTemplate(db, arg2, arg3, arg4 = {}) {
  let user, templateId, body;
  if (typeof arg2 === 'string') {
    templateId = arg2;
    body = arg3 || {};
    user = normalizeUser(db, arg4);
  } else {
    user = normalizeUser(db, arg2);
    templateId = arg3;
    body = arg4 || {};
  }
  permit(user, 'recruit', 'admin');

  const existing = db.prepare('SELECT * FROM training_plan_templates WHERE id = ?').get(templateId);
  if (!existing) throw new HttpError(404, 'Training plan template not found.');

  const name = body.name !== undefined ? validateText(body.name, 'Template name', 150) : existing.name;
  const description = body.description !== undefined ? validateText(body.description || '', 'Description', 1000, true) : existing.description;
  const subject = body.subject !== undefined ? validateText(body.subject, 'Email subject', 300) : existing.subject;
  const introduction = body.introduction !== undefined ? validateText(body.introduction || '', 'Introduction', 5000, true) : existing.introduction;
  const objectives = body.objectives !== undefined ? validateText(body.objectives || '', 'Objectives', 5000, true) : existing.objectives;
  const durationText = body.duration_text !== undefined ? validateText(body.duration_text || '', 'Duration', 100, true) : (body.duration !== undefined ? validateText(body.duration || '', 'Duration', 100, true) : existing.duration_text);
  const status = body.status !== undefined && ['draft', 'active', 'archived'].includes(body.status) ? body.status : existing.status;
  const isDefault = body.is_default !== undefined ? Boolean(body.is_default) : Boolean(existing.is_default);

  const positions = body.positions !== undefined && Array.isArray(body.positions)
    ? body.positions.map(p => String(p).trim()).filter(Boolean)
    : safeJsonParse(existing.positions, []);

  const departments = body.departments !== undefined && Array.isArray(body.departments)
    ? body.departments.map(d => String(d).trim()).filter(Boolean)
    : safeJsonParse(existing.departments, []);

  const roles = body.roles !== undefined && Array.isArray(body.roles)
    ? body.roles.map(r => String(r).trim()).filter(Boolean)
    : safeJsonParse(existing.roles, []);

  const sections = body.sections !== undefined && Array.isArray(body.sections)
    ? body.sections.map((s, idx) => ({
      id: s.id || `sec-${idx + 1}`,
      title: String(s.title || `Section ${idx + 1}`).trim().slice(0, 150),
      content: String(s.content || '').trim().slice(0, 5000),
      order: Number(s.order) || (idx + 1)
    }))
    : safeJsonParse(existing.sections, []);

  const learningLinks = body.learning_links !== undefined && Array.isArray(body.learning_links)
    ? body.learning_links.map((l, idx) => {
      const url = validateUrl(l.url, `Learning link ${idx + 1} URL`);
      return {
        id: l.id || `link-${idx + 1}`,
        title: validateText(l.title, `Learning link ${idx + 1} title`, 150),
        url,
        description: validateText(l.description || '', `Learning link ${idx + 1} description`, 500, true)
      };
    })
    : safeJsonParse(existing.learning_links, []);

  const resources = body.resources !== undefined && Array.isArray(body.resources)
    ? body.resources
    : safeJsonParse(existing.resources, []);

  const supportContact = body.support_contact !== undefined && typeof body.support_contact === 'object' && body.support_contact !== null
    ? {
      name: validateText(body.support_contact.name || '', 'Support contact name', 100, true),
      email: body.support_contact.email ? validateEmail(body.support_contact.email) : '',
      role: validateText(body.support_contact.role || '', 'Support contact role', 100, true),
      notes: validateText(body.support_contact.notes || '', 'Support contact notes', 500, true)
    }
    : safeJsonParse(existing.support_contact, {});

  // Increment version on meaningful content edit
  const nextVersion = existing.version + 1;
  const updatedAt = now();

  return transaction(db, () => {
    if (isDefault && !existing.is_default) {
      db.prepare('UPDATE training_plan_templates SET is_default = 0 WHERE is_default = 1').run();
    }

    db.prepare(`
      UPDATE training_plan_templates SET
        name = ?, description = ?, status = ?, version = ?, is_default = ?,
        subject = ?, introduction = ?, objectives = ?, sections = ?, learning_links = ?,
        resources = ?, duration_text = ?, support_contact = ?, positions = ?, departments = ?, roles = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      name,
      description,
      status,
      nextVersion,
      isDefault ? 1 : 0,
      subject,
      introduction,
      objectives,
      JSON.stringify(sections),
      JSON.stringify(learningLinks),
      JSON.stringify(resources),
      durationText,
      JSON.stringify(supportContact),
      JSON.stringify(positions),
      JSON.stringify(departments),
      JSON.stringify(roles),
      updatedAt,
      templateId
    );

    audit(db, user.id, 'training_plan.template_updated', templateId, {
      name,
      version: nextVersion,
      status,
      is_default: isDefault
    });

    return getTrainingTemplate(db, user, templateId);
  });
}

/**
 * Duplicate an existing training plan template.
 */
export function duplicateTrainingTemplate(db, arg2, arg3, arg4 = {}) {
  let user, templateId, body;
  if (typeof arg2 === 'string') {
    templateId = arg2;
    user = normalizeUser(db, arg3);
    body = arg4 || {};
  } else {
    user = normalizeUser(db, arg2);
    templateId = arg3;
    body = arg4 || {};
  }
  permit(user, 'recruit', 'admin');

  const source = getTrainingTemplate(db, user, templateId);
  const newName = body.name ? validateText(body.name, 'Template name', 150) : `Copy of ${source.name}`;

  return createTrainingTemplate(db, user, {
    ...source,
    name: newName,
    is_default: false,
    status: 'draft'
  });
}

/**
 * Update template status (active, draft, archived) or default flag.
 */
export function setTrainingTemplateStatus(db, arg2, arg3, arg4, arg5) {
  let user, templateId, status, isDefault;
  if (typeof arg2 === 'string') {
    templateId = arg2;
    if (typeof arg3 === 'object' && arg3 !== null) {
      status = arg3.status;
      isDefault = arg3.is_default !== undefined ? arg3.is_default : arg3.isDefault;
      user = normalizeUser(db, arg4);
    } else {
      status = arg3;
      isDefault = arg4;
      user = normalizeUser(db, arg5);
    }
  } else {
    user = normalizeUser(db, arg2);
    templateId = arg3;
    if (typeof arg4 === 'object' && arg4 !== null) {
      status = arg4.status;
      isDefault = arg4.is_default !== undefined ? arg4.is_default : arg4.isDefault;
    } else {
      status = arg4;
      isDefault = arg5;
    }
  }
  permit(user, 'recruit', 'admin');

  const existing = db.prepare('SELECT * FROM training_plan_templates WHERE id = ?').get(templateId);
  if (!existing) throw new HttpError(404, 'Training plan template not found.');

  const updates = [];
  const params = [];

  if (status && ['draft', 'active', 'archived', 'inactive'].includes(status)) {
    const dbStatus = status === 'inactive' ? 'draft' : status;
    updates.push('status = ?');
    params.push(dbStatus);
  }

  if (isDefault !== undefined) {
    const defVal = Boolean(isDefault);
    if (defVal) {
      db.prepare('UPDATE training_plan_templates SET is_default = 0 WHERE is_default = 1').run();
    }
    updates.push('is_default = ?');
    params.push(defVal ? 1 : 0);
  }

  if (updates.length === 0) return parseTemplateRow(existing);

  updates.push('updated_at = ?');
  params.push(now());
  params.push(templateId);

  db.prepare(`UPDATE training_plan_templates SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  audit(db, user.id, 'training_plan.template_status_changed', templateId, {
    status,
    is_default: isDefault
  });

  return getTrainingTemplate(db, user, templateId);
}

/**
 * Archive an obsolete training plan template without deleting historical records.
 */
export function archiveTrainingTemplate(db, arg2, arg3) {
  if (typeof arg2 === 'string') {
    return setTrainingTemplateStatus(db, arg2, { status: 'archived', is_default: false }, arg3);
  }
  return setTrainingTemplateStatus(db, arg2, arg3, { status: 'archived', is_default: false });
}

/**
 * Retrieves authoritative candidate, application, and requisition details for template matching.
 */
export function getAuthoritativeCandidateContext(db, applicationId, candidateId = null) {
  let app = null;
  if (applicationId) {
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  }
  const candId = candidateId || app?.candidate_id;
  if (!candId) throw new HttpError(404, 'Candidate not found.');
  const cand = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candId);
  if (!cand) throw new HttpError(404, 'Candidate not found.');

  let req = null;
  if (app?.requisition_id) {
    req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(app.requisition_id);
  }

  const position = req?.title || cand.skills?.split(',')[0]?.trim() || 'Team Member';
  const department = req?.team || cand.team || 'General';
  const role = cand.role || req?.title || position;

  return {
    application: app,
    candidate: cand,
    requisition: req,
    position,
    department,
    role
  };
}

/**
 * Suggests the best training-plan template for a candidate based on deterministic priority:
 * 1. Exact position/designation match AND exact role match.
 * 2. Exact position/designation match.
 * 3. Department match AND role match.
 * 4. Department match.
 * 5. Configured default template.
 *
 * If multiple templates match at the highest priority, marks as ambiguous so user resolves.
 */
export function suggestTrainingPlan(db, query = {}) {
  seedDefaultTrainingTemplatesIfEmpty(db);
  const { applicationId, candidateId, position: posParam, department: deptParam, role: roleParam } = query || {};
  let position = posParam || '';
  let department = deptParam || '';
  let role = roleParam || '';
  let candidate = { id: candidateId || null, name: 'Candidate', email: '' };
  let application = null;
  let requisition = null;

  if (applicationId || candidateId) {
    try {
      const ctx = getAuthoritativeCandidateContext(db, applicationId, candidateId);
      position = position || ctx.position;
      department = department || ctx.department;
      role = role || ctx.role;
      candidate = ctx.candidate || candidate;
      application = ctx.application;
      requisition = ctx.requisition;
    } catch {
      // Continue with provided position/department/role
    }
  }

  const activeTemplates = db.prepare("SELECT * FROM training_plan_templates WHERE status = 'active' ORDER BY is_default ASC, created_at DESC").all().map(parseTemplateRow);

  const norm = str => String(str || '').toLowerCase().trim();
  const candPos = norm(position);
  const candDept = norm(department);
  const candRole = norm(role);

  const matchesList = (list, val) => {
    if (!Array.isArray(list) || !val) return false;
    return list.some(item => {
      const n = norm(item);
      return n === val || val.includes(n) || n.includes(val);
    });
  };

  const scored = [];
  for (const tpl of activeTemplates) {
    const hasPos = matchesList(tpl.positions, candPos);
    const hasRole = matchesList(tpl.roles, candRole);
    const hasDept = matchesList(tpl.departments, candDept);

    if (hasPos && hasRole) {
      scored.push({ template: tpl, priority: 1, reason: `Exact position and role match (${position} / ${role})` });
    } else if (hasPos) {
      scored.push({ template: tpl, priority: 2, reason: `Exact position match (${position})` });
    } else if (hasDept && hasRole) {
      scored.push({ template: tpl, priority: 3, reason: `Department and role match (${department} / ${role})` });
    } else if (hasDept) {
      scored.push({ template: tpl, priority: 4, reason: `Department match (${department})` });
    } else if (tpl.is_default) {
      scored.push({ template: tpl, priority: 5, reason: 'Configured default organizational training plan' });
    }
  }

  if (scored.length === 0) {
    return {
      candidate: { id: candidate.id, name: candidate.name, email: candidate.email },
      position,
      department,
      role,
      suggestedTemplate: null,
      matchPriority: null,
      isAmbiguous: false,
      reason: 'No applicable active training plan found. Please select an active template manually.',
      allActiveTemplates: activeTemplates
    };
  }

  const minPriority = Math.min(...scored.map(s => s.priority));
  const topMatches = scored.filter(s => s.priority === minPriority);

  if (topMatches.length > 1) {
    return {
      candidate: { id: candidate.id, name: candidate.name, email: candidate.email },
      position,
      department,
      role,
      suggestedTemplate: null,
      matchPriority: minPriority,
      isAmbiguous: true,
      ambiguousTemplates: topMatches.map(m => m.template),
      warning: `Multiple training plans (${topMatches.map(m => m.template.name).join(', ')}) match at priority level ${minPriority}. Manual template selection required to resolve ambiguity.`,
      allActiveTemplates: activeTemplates
    };
  }

  const best = topMatches[0];
  return {
    candidate: { id: candidate.id, name: candidate.name, email: candidate.email },
    position,
    department,
    role,
    suggestedTemplate: best.template,
    matchPriority: best.priority,
    matchReason: best.reason,
    isAmbiguous: false,
    allActiveTemplates: activeTemplates
  };
}

export const matchTrainingTemplate = suggestTrainingPlan;

/**
 * Replaces dynamic variables such as {{candidate.name}} in text strings.
 */
export function resolveTrainingVariables(str, vars = {}) {
  if (!str) return '';
  return String(str).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key] ?? '';
    }
    return match;
  });
}

/**
 * Builds candidate dynamic template variables dictionary.
 */
export function buildTemplateVariables(candidate, requisition = {}, extra = {}) {
  const firstName = (candidate.name || '').trim().split(/\s+/)[0] || candidate.name || 'Candidate';
  return {
    'candidate.name': candidate.name || '',
    'candidate.first_name': firstName,
    'candidate.email': candidate.email || '',
    'candidate.phone': candidate.phone || '',
    'company.name': 'Mechlin Technologies',
    'company.website': 'https://mechlintech.com',
    'requisition.title': requisition.title || extra.position || '',
    'employment.designation': requisition.title || extra.position || '',
    'requisition.department': requisition.team || candidate.team || extra.department || 'General',
    'requisition.team': requisition.team || candidate.team || '',
    'training.plan_name': extra.plan_name || '',
    'training.duration': extra.duration_text || extra.duration || '',
    'support.contact_name': extra.support_contact?.name || 'Mechlin Talent Team',
    'support.contact_email': extra.support_contact?.email || 'hr@mechlintech.com',
    ...extra.customVariables
  };
}

/**
 * Retrieves existing training plan draft for an application, or initializes a new draft in pending_review.
 */
export function getOrCreateTrainingDraft(db, arg2, arg3) {
  let user, applicationId;
  if (typeof arg2 === 'string') {
    applicationId = arg2;
    user = normalizeUser(db, arg3);
  } else {
    user = normalizeUser(db, arg2);
    applicationId = arg3;
  }
  permit(user, 'recruit', 'review', 'admin');
  seedDefaultTrainingTemplatesIfEmpty(db);

  const ctx = getAuthoritativeCandidateContext(db, applicationId);
  const { application, candidate, requisition, position, department, role } = ctx;

  const existingRow = db.prepare('SELECT * FROM training_plan_drafts WHERE application_id = ?').get(applicationId);
  const suggestion = suggestTrainingPlan(db, { applicationId });

  if (existingRow) {
    const draft = parseDraftRow(existingRow);
    let selectedTemplate = null;
    if (draft.template_id) {
      const tplRow = db.prepare('SELECT * FROM training_plan_templates WHERE id = ?').get(draft.template_id);
      if (tplRow) selectedTemplate = parseTemplateRow(tplRow);
    }
    return {
      ...draft,
      draft,
      candidate: { id: candidate.id, name: candidate.name, email: candidate.email },
      position,
      department,
      role,
      stage: application.stage,
      suggestedTemplate: suggestion.suggestedTemplate,
      matchPriority: suggestion.matchPriority,
      matchReason: suggestion.matchReason,
      isAmbiguous: suggestion.isAmbiguous,
      ambiguousTemplates: suggestion.ambiguousTemplates || [],
      selectedTemplate,
      allActiveTemplates: suggestion.allActiveTemplates || []
    };
  }

  // No draft exists yet: initialize a new draft in pending_review
  const suggestedTpl = suggestion.suggestedTemplate;
  const tplVars = buildTemplateVariables(candidate, requisition, {
    position,
    department,
    plan_name: suggestedTpl?.name || 'Pre-Onboarding Training Plan',
    duration_text: suggestedTpl?.duration_text || '',
    support_contact: suggestedTpl?.support_contact
  });

  const draftId = id();
  const createdAt = now();
  const subject = suggestedTpl ? resolveTrainingVariables(suggestedTpl.subject, tplVars) : `Pre-Onboarding Training Plan: ${position}`;
  const introduction = suggestedTpl ? resolveTrainingVariables(suggestedTpl.introduction, tplVars) : `Welcome to Mechlin! We have prepared this pre-onboarding training plan to support your preparation prior to your start date.`;
  const objectives = suggestedTpl ? resolveTrainingVariables(suggestedTpl.objectives, tplVars) : '';
  const sections = suggestedTpl?.sections || [];
  const learningLinks = suggestedTpl?.learning_links || [];
  const resources = suggestedTpl?.resources || [];
  const durationText = suggestedTpl?.duration_text || '';
  const supportContact = suggestedTpl?.support_contact || {};

  db.prepare(`
    INSERT INTO training_plan_drafts(
      id, application_id, candidate_id, template_id, template_version,
      suggested_template_id, match_priority, is_override, status,
      subject, introduction, objectives, sections, learning_links, resources,
      duration_text, support_contact, rendered_html, rendered_text,
      sent_at, sent_by, error_message, idempotency_key, resend_count,
      created_by, updated_by, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 0, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, ?, ?)
  `).run(
    draftId,
    applicationId,
    candidate.id,
    suggestedTpl?.id || null,
    suggestedTpl?.version || 1,
    suggestedTpl?.id || null,
    suggestion.matchPriority || null,
    subject,
    introduction,
    objectives,
    JSON.stringify(sections),
    JSON.stringify(learningLinks),
    JSON.stringify(resources),
    durationText,
    JSON.stringify(supportContact),
    user.id,
    user.id,
    createdAt,
    createdAt
  );

  audit(db, user.id, 'training_plan.draft_created', draftId, {
    application_id: applicationId,
    candidate_id: candidate.id,
    template_id: suggestedTpl?.id || null
  });

  const createdRow = db.prepare('SELECT * FROM training_plan_drafts WHERE id = ?').get(draftId);
  const parsedCreated = parseDraftRow(createdRow);
  return {
    ...parsedCreated,
    draft: parsedCreated,
    candidate: { id: candidate.id, name: candidate.name, email: candidate.email },
    position,
    department,
    role,
    stage: application.stage,
    suggestedTemplate: suggestion.suggestedTemplate,
    matchPriority: suggestion.matchPriority,
    matchReason: suggestion.matchReason,
    isAmbiguous: suggestion.isAmbiguous,
    ambiguousTemplates: suggestion.ambiguousTemplates || [],
    selectedTemplate: suggestedTpl,
    allActiveTemplates: suggestion.allActiveTemplates || []
  };
}

/**
 * Save candidate-specific draft edits without modifying the reusable template.
 */
export function saveTrainingDraft(db, arg2, arg3, arg4 = {}) {
  let user, applicationId, body;
  if (typeof arg2 === 'string') {
    applicationId = arg2;
    body = arg3 || {};
    user = normalizeUser(db, arg4);
  } else {
    user = normalizeUser(db, arg2);
    applicationId = arg3;
    body = arg4 || {};
  }
  permit(user, 'recruit', 'admin');

  const existingRow = db.prepare('SELECT * FROM training_plan_drafts WHERE application_id = ?').get(applicationId);
  if (!existingRow) {
    getOrCreateTrainingDraft(db, user, applicationId);
  }
  const draft = parseDraftRow(db.prepare('SELECT * FROM training_plan_drafts WHERE application_id = ?').get(applicationId));

  const ctx = getAuthoritativeCandidateContext(db, applicationId);
  const { position, department, role } = ctx;

  const subject = body.subject !== undefined ? validateText(body.subject, 'Subject', 300) : draft.subject;
  const introduction = body.introduction !== undefined ? validateText(body.introduction || '', 'Introduction', 5000, true) : draft.introduction;
  const objectives = body.objectives !== undefined ? validateText(body.objectives || '', 'Objectives', 5000, true) : draft.objectives;
  const durationText = body.duration_text !== undefined ? validateText(body.duration_text || '', 'Duration', 100, true) : (body.duration !== undefined ? validateText(body.duration || '', 'Duration', 100, true) : draft.duration_text);

  let templateId = draft.template_id;
  let isOverride = draft.is_override;

  if (body.template_id !== undefined && body.template_id !== draft.template_id) {
    templateId = body.template_id;
    if (templateId) {
      const selectedTpl = db.prepare('SELECT * FROM training_plan_templates WHERE id = ?').get(templateId);
      if (selectedTpl) {
        const parsedTpl = parseTemplateRow(selectedTpl);
        const norm = s => String(s || '').toLowerCase().trim();
        const matchesPos = parsedTpl.positions.some(p => norm(p) === norm(position) || norm(position).includes(norm(p)));
        isOverride = !matchesPos && !parsedTpl.is_default;
      }
    }
  }

  const sections = body.sections !== undefined && Array.isArray(body.sections)
    ? body.sections.map((s, idx) => ({
      id: s.id || `sec-${idx + 1}`,
      title: String(s.title || `Section ${idx + 1}`).trim().slice(0, 150),
      content: String(s.content || '').trim().slice(0, 5000),
      order: Number(s.order) || (idx + 1)
    }))
    : draft.sections;

  const learningLinks = body.learning_links !== undefined && Array.isArray(body.learning_links)
    ? body.learning_links.map((l, idx) => {
      const url = validateUrl(l.url, `Learning link ${idx + 1} URL`);
      return {
        id: l.id || `link-${idx + 1}`,
        title: validateText(l.title, `Learning link ${idx + 1} title`, 150),
        url,
        description: validateText(l.description || '', `Learning link ${idx + 1} description`, 500, true)
      };
    })
    : draft.learning_links;

  const resources = body.resources !== undefined && Array.isArray(body.resources)
    ? body.resources
    : draft.resources;

  const supportContact = body.support_contact !== undefined && typeof body.support_contact === 'object' && body.support_contact !== null
    ? {
      name: validateText(body.support_contact.name || '', 'Support contact name', 100, true),
      email: body.support_contact.email ? validateEmail(body.support_contact.email) : '',
      role: validateText(body.support_contact.role || '', 'Support contact role', 100, true),
      notes: validateText(body.support_contact.notes || '', 'Support contact notes', 500, true)
    }
    : draft.support_contact;

  const nextStatus = draft.status === 'sent' ? 'sent' : 'draft_saved';
  const updatedAt = now();

  db.prepare(`
    UPDATE training_plan_drafts SET
      template_id = ?, is_override = ?, status = ?,
      subject = ?, introduction = ?, objectives = ?, sections = ?, learning_links = ?, resources = ?,
      duration_text = ?, support_contact = ?, updated_by = ?, updated_at = ?
    WHERE id = ?
  `).run(
    templateId,
    isOverride ? 1 : 0,
    nextStatus,
    subject,
    introduction,
    objectives,
    JSON.stringify(sections),
    JSON.stringify(learningLinks),
    JSON.stringify(resources),
    durationText,
    JSON.stringify(supportContact),
    user.id,
    updatedAt,
    draft.id
  );

  audit(db, user.id, 'training_plan.draft_saved', draft.id, {
    application_id: applicationId,
    template_id: templateId,
    is_override: isOverride
  });

  const savedDraft = parseDraftRow(db.prepare('SELECT * FROM training_plan_drafts WHERE id = ?').get(draft.id));
  return {
    ...savedDraft,
    draft: savedDraft
  };
}

/**
 * Discards customized draft edits and resets draft from original suggested or selected template.
 */
export function discardTrainingDraft(db, user, applicationId) {
  permit(user, 'recruit', 'admin');

  const draftRow = db.prepare('SELECT * FROM training_plan_drafts WHERE application_id = ?').get(applicationId);
  if (!draftRow) throw new HttpError(404, 'Training plan draft not found.');

  db.prepare('DELETE FROM training_plan_drafts WHERE application_id = ?').run(applicationId);
  audit(db, user.id, 'training_plan.draft_discarded', draftRow.id, { application_id: applicationId });

  return getOrCreateTrainingDraft(db, user, applicationId);
}

/**
 * Renders complete HTML and plain text email from draft data and candidate context.
 */
export function renderTrainingPlanEmail(draftData, candidateContext) {
  const { candidate, requisition, position } = candidateContext;
  const candidateName = candidate.name || 'Candidate';
  const vars = buildTemplateVariables(candidate, requisition, {
    position,
    plan_name: draftData.subject || 'Pre-Onboarding Training Plan',
    duration_text: draftData.duration_text,
    support_contact: draftData.support_contact
  });

  const renderedSubject = resolveTrainingVariables(draftData.subject, vars);
  const renderedIntro = resolveTrainingVariables(draftData.introduction, vars);
  const renderedObjectives = resolveTrainingVariables(draftData.objectives, vars);

  const sections = Array.isArray(draftData.sections) ? draftData.sections.map(s => ({
    ...s,
    title: resolveTrainingVariables(s.title, vars),
    content: resolveTrainingVariables(s.content, vars)
  })) : [];

  const learningLinks = Array.isArray(draftData.learning_links) ? draftData.learning_links : [];
  const resources = Array.isArray(draftData.resources) ? draftData.resources : [];
  const supportContact = draftData.support_contact || {};

  const sectionsHtml = sections.map((s, idx) => `
    <div style="margin-bottom: 20px; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px;">
      <h3 style="margin-top: 0; margin-bottom: 10px; font-size: 15px; font-weight: 600; color: #0f172a;">${escapeHtml(s.title || `Section ${idx + 1}`)}</h3>
      <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(s.content || '')}</p>
    </div>
  `).join('');

  let linksHtml = '';
  if (learningLinks.length > 0) {
    linksHtml = `
      <div style="margin-top: 24px;">
        <h3 style="font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 12px;">Recommended Learning Resources & External Links</h3>
        ${learningLinks.map(l => `
          <div style="margin-bottom: 10px; padding: 12px 14px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px;">
            <a href="${escapeHtml(l.url)}" style="font-weight: 600; color: #0284c7; text-decoration: none; font-size: 14px;">${escapeHtml(l.title || l.url)} &rarr;</a>
            ${l.description ? `<p style="margin: 4px 0 0 0; font-size: 13px; color: #475569;">${escapeHtml(l.description)}</p>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  let resourcesHtml = '';
  if (resources.length > 0) {
    resourcesHtml = `
      <div style="margin-top: 24px;">
        <h3 style="font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 12px;">Downloadable Materials & Attachments</h3>
        ${resources.map(r => `
          <div style="margin-bottom: 10px; padding: 12px 14px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; display: flex; align-items: center; justify-content: space-between;">
            <div>
              <strong style="font-size: 14px; color: #0f172a;">${escapeHtml(r.title || r.filename || 'Document')}</strong>
              ${r.filename ? `<div style="font-size: 12px; color: #64748b;">${escapeHtml(r.filename)}</div>` : ''}
            </div>
            ${r.url ? `<a href="${escapeHtml(r.url)}" style="font-weight: 600; color: #0284c7; font-size: 13px; text-decoration: none; background: #ffffff; border: 1px solid #cbd5e1; padding: 4px 10px; border-radius: 4px;">Download</a>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  const supportName = supportContact.name || 'Mechlin Talent Acquisition Team';
  const supportEmail = supportContact.email || 'hr@mechlintech.com';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(renderedSubject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; line-height: 1.6;">
  <div style="max-width: 600px; margin: 32px auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0f172a" style="border-collapse: collapse; background-color: #0f172a;">
      <tr>
        <td bgcolor="#0f172a" style="background-color: #0f172a; padding: 24px 32px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <span style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">Orbit</span>
          <span style="font-size: 14px; color: #cbd5e1; margin-left: 8px;">&middot; Pre-Onboarding Preparation</span>
        </td>
      </tr>
    </table>
    <div style="padding: 32px;">
      <h1 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 16px;">${escapeHtml(renderedSubject)}</h1>
      <p style="font-size: 15px; margin-bottom: 16px;">Dear ${escapeHtml(candidateName)},</p>
      <p style="font-size: 15px; margin-bottom: 16px; line-height: 1.6;">${escapeHtml(renderedIntro)}</p>
      
      <div style="background-color: #f1f5f9; border-radius: 8px; padding: 16px; margin: 20px 0;">
        <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Target Role & Position:</strong> ${escapeHtml(position)}</p>
        ${draftData.duration_text ? `<p style="margin: 0; font-size: 14px;"><strong>Suggested Training Duration:</strong> <span style="background-color: #e0e7ff; color: #3730a3; padding: 2px 8px; border-radius: 4px; font-weight: 600;">${escapeHtml(draftData.duration_text)}</span></p>` : ''}
      </div>

      ${renderedObjectives ? `
        <div style="background-color: #eff6ff; border-left: 4px solid #3b82f6; border-radius: 4px; padding: 16px; margin: 20px 0;">
          <h4 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 700; color: #1e40af;">Training Objectives & Learning Outcomes</h4>
          <div style="font-size: 14px; color: #1e3a8a; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(renderedObjectives)}</div>
        </div>
      ` : ''}

      ${sectionsHtml}
      ${linksHtml}
      ${resourcesHtml}

      <div style="margin-top: 28px; padding: 16px; background-color: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
        <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: 600; color: #0f172a;">Need Assistance or Have Questions?</p>
        <p style="margin: 0; font-size: 13px; color: #475569;">
          Your onboarding coordinator is <strong>${escapeHtml(supportName)}</strong>.<br>
          Reach out anytime at <a href="mailto:${escapeHtml(supportEmail)}" style="color: #0284c7; text-decoration: underline;">${escapeHtml(supportEmail)}</a>.
          ${supportContact.notes ? `<br><span style="color: #64748b; font-size: 12px;">${escapeHtml(supportContact.notes)}</span>` : ''}
        </p>
      </div>

      <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 14px; color: #475569;">
        Warm regards,<br>
        <strong>The Mechlin Talent Acquisition Team</strong>
      </div>
    </div>
    <div style="background-color: #f1f5f9; padding: 16px 32px; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0 0 6px 0;">This pre-onboarding training communication was sent to ${escapeHtml(candidate.email || candidateName)} regarding your recruitment with Mechlin Technologies.</p>
      <p style="margin: 0;">This is an authorized operational preparation plan for your approved candidacy.</p>
    </div>
  </div>
</body>
</html>`;

  const text = `Pre-Onboarding Training Plan: ${renderedSubject}\n\nDear ${candidateName},\n\n${renderedIntro}\n\nPosition: ${position}${draftData.duration_text ? `\nDuration: ${draftData.duration_text}` : ''}\n\n${renderedObjectives ? `Objectives:\n${renderedObjectives}\n\n` : ''}${sections.map((s, i) => `${i + 1}. ${s.title}\n${s.content}\n`).join('\n')}${learningLinks.length > 0 ? `\nLearning Resources:\n${learningLinks.map(l => `• ${l.title}: ${l.url}`).join('\n')}\n` : ''}\nSupport Contact: ${supportName} (${supportEmail})\n\nWarm regards,\nThe Mechlin Talent Acquisition Team`;

  return { subject: renderedSubject, html, text, variables: vars };
}

/**
 * Preview candidate-specific email with dynamic values resolved.
 */
export function previewTrainingEmail(db, arg2, arg3, arg4 = null) {
  let user, applicationId, customDraftData;
  if (typeof arg2 === 'string') {
    applicationId = arg2;
    customDraftData = arg3;
    user = normalizeUser(db, arg4);
  } else {
    user = normalizeUser(db, arg2);
    applicationId = arg3;
    customDraftData = arg4;
  }
  permit(user, 'recruit', 'review', 'admin');

  const ctx = getAuthoritativeCandidateContext(db, applicationId);
  let draft = customDraftData;
  if (!draft) {
    const row = db.prepare('SELECT * FROM training_plan_drafts WHERE application_id = ?').get(applicationId);
    if (row) draft = parseDraftRow(row);
    else {
      const init = getOrCreateTrainingDraft(db, user, applicationId);
      draft = init.draft;
    }
  }

  return renderTrainingPlanEmail(draft, ctx);
}

/**
 * Explicit manual send operation.
 * CRITICAL REQUIREMENT: This must NEVER be invoked automatically on stage change,
 * preview, refresh, or template selection. Only explicit user confirmation triggers this.
 */
export async function sendTrainingPlan(db, arg2, arg3, arg4 = {}, adapters = {}) {
  let user, applicationId, options;
  if (typeof arg2 === 'string') {
    applicationId = arg2;
    options = arg3 || {};
    user = normalizeUser(db, arg4);
  } else {
    user = normalizeUser(db, arg2);
    applicationId = arg3;
    options = arg4 || {};
  }
  permit(user, 'recruit', 'admin');

  if (!options.sendConfirmation && options.confirm !== true) {
    throw new HttpError(400, 'Explicit user send confirmation is required to deliver the training plan email.');
  }

  const ctx = getAuthoritativeCandidateContext(db, applicationId);
  const { application, candidate, requisition, position } = ctx;

  if (!candidate.email) {
    throw new HttpError(400, 'Candidate does not have a valid email address.');
  }

  // Load existing draft or create one
  let draftRow = db.prepare('SELECT * FROM training_plan_drafts WHERE application_id = ?').get(applicationId);
  if (!draftRow) {
    const init = getOrCreateTrainingDraft(db, user, applicationId);
    draftRow = db.prepare('SELECT * FROM training_plan_drafts WHERE id = ?').get(init.draft.id);
  }
  const draft = parseDraftRow(draftRow);

  // Template validity check: draft/inactive/archived templates cannot be sent
  const tplIdToCheck = options.templateId || draft.template_id;
  if (tplIdToCheck) {
    const tplRow = db.prepare('SELECT * FROM training_plan_templates WHERE id = ?').get(tplIdToCheck);
    if (tplRow && tplRow.status !== 'active') {
      throw new HttpError(400, `Selected training plan template "${tplRow.name}" is ${tplRow.status}. Templates must be active to be sent.`);
    }
  }

  // Prevent accidental duplicate sends unless explicit resend is confirmed
  const isResend = Boolean(options.resend);
  if (draft.status === 'sent' && !isResend) {
    throw new HttpError(409, 'Training plan has already been sent to this candidate. Confirm explicit resend to deliver an updated plan.');
  }

  // Verify candidate eligibility: application must be in an active training or post-training stage
  const validStages = ['Pre-Onboarding Training', 'Onboarding', 'Hired'];
  if (!validStages.includes(application.stage) && !options.overrideStageCheck) {
    throw new HttpError(409, `Candidate is currently in "${application.stage}" stage. Training plans can only be dispatched for candidates in Pre-Onboarding Training stage.`);
  }

  // Apply any custom subject or introduction overrides provided in send options
  if (options.subject && typeof options.subject === 'string' && options.subject.trim()) {
    draft.subject = options.subject.trim();
  }
  if (options.introduction && typeof options.introduction === 'string') {
    draft.introduction = options.introduction.trim();
  }

  // Validate content
  if (!draft.subject || !draft.subject.trim()) {
    throw new HttpError(400, 'Email subject cannot be empty.');
  }

  const rendered = renderTrainingPlanEmail(draft, ctx);
  const idempotencyKey = options.idempotencyKey || `training_plan_send_${applicationId}_${draft.resend_count || 0}_${Date.now()}`;

  // Execute delivery via communication adapter
  let commAdapter = adapters.communicationAdapter;
  if (!commAdapter) {
    const defaultAdapter = new CommunicationAdapter({ db, fromEnv: true, transport: adapters.transport });
    if (defaultAdapter.configured || adapters.transport) {
      commAdapter = defaultAdapter;
    } else {
      commAdapter = {
        configured: true,
        send: async () => ({
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          status: 'accepted'
        })
      };
    }
  }

  try {
    const sendResult = await sendCandidateCommunication(db, user, {
      candidate_id: candidate.id,
      requisition_id: requisition?.id || undefined,
      template_id: 'pre_onboarding_training',
      recipient_email: candidate.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      variables: rendered.variables,
      idempotency_key: idempotencyKey
    }, commAdapter);

    const sentAt = now();
    const resendCount = isResend ? (draft.resend_count || 0) + 1 : (draft.resend_count || 0);

    db.prepare(`
      UPDATE training_plan_drafts SET
        status = 'sent',
        sent_at = ?,
        sent_by = ?,
        rendered_html = ?,
        rendered_text = ?,
        error_message = NULL,
        idempotency_key = ?,
        resend_count = ?,
        updated_by = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      sentAt,
      user.id,
      rendered.html,
      rendered.text,
      idempotencyKey,
      resendCount,
      user.id,
      sentAt,
      draft.id
    );

    audit(db, user.id, isResend ? 'training_plan.email_resent' : 'training_plan.email_sent', draft.id, {
      application_id: applicationId,
      candidate_id: candidate.id,
      recipient: candidate.email,
      subject: rendered.subject,
      template_id: draft.template_id,
      resend_count: resendCount
    });

    return {
      success: true,
      status: 'sent',
      sent_at: sentAt,
      recipient: candidate.email,
      subject: rendered.subject,
      communication_id: sendResult?.id || null,
      resend_count: resendCount
    };
  } catch (err) {
    const errMsg = String(err.message || 'Email delivery failed');
    const updatedAt = now();

    db.prepare(`
      UPDATE training_plan_drafts SET
        status = 'failed',
        error_message = ?,
        updated_by = ?,
        updated_at = ?
      WHERE id = ?
    `).run(errMsg, user.id, updatedAt, draft.id);

    audit(db, user.id, 'training_plan.email_failed', draft.id, {
      application_id: applicationId,
      candidate_id: candidate.id,
      recipient: candidate.email,
      reason: errMsg
    });

    throw new HttpError(err.status || 502, `Failed to send training plan email: ${errMsg}`);
  }
}

/**
 * Resend operation with explicit user confirmation.
 */
export async function resendTrainingPlan(db, arg2, arg3, arg4 = {}, adapters = {}) {
  let user, applicationId, options;
  if (typeof arg2 === 'string') {
    applicationId = arg2;
    options = arg3 || {};
    user = normalizeUser(db, arg4);
  } else {
    user = normalizeUser(db, arg2);
    applicationId = arg3;
    options = arg4 || {};
  }
  return sendTrainingPlan(db, user, applicationId, { ...options, resend: true, sendConfirmation: true }, adapters);
}

/**
 * Upload a document or image learning resource.
 */
export function uploadTrainingAsset(db, user, { buffer, filename, mimeType, title, resourceType = 'document' }) {
  permit(user, 'recruit', 'admin');

  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'Asset file buffer is required.');
  }
  if (buffer.length > 10485760) {
    throw new HttpError(413, 'Asset file size exceeds 10 MB limit.');
  }

  const safeName = basename(filename || 'resource').replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext = extname(safeName).toLowerCase();
  const allowedExts = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.pdf', '.docx', '.txt', '.md'];

  if (!allowedExts.includes(ext)) {
    throw new HttpError(400, `Unsupported file format "${ext}". Allowed: ${allowedExts.join(', ')}.`);
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const assetId = id();
  ensureAssetsDir();

  const storagePath = join(ASSETS_DIR, `${assetId}-${safeName}`);
  writeFileSync(storagePath, buffer);

  const cleanTitle = validateText(title || safeName, 'Asset title', 150);
  const cleanType = ['image', 'document'].includes(resourceType) ? resourceType : (['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext) ? 'image' : 'document');
  const createdAt = now();

  db.prepare(`
    INSERT INTO training_plan_assets(
      id, title, filename, file_format, file_size, mime_type, storage_path, sha256_hash, resource_type, created_by, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    assetId,
    cleanTitle,
    safeName,
    ext.replace('.', ''),
    buffer.length,
    mimeType || 'application/octet-stream',
    storagePath,
    sha256,
    cleanType,
    user.id,
    createdAt
  );

  audit(db, user.id, 'training_plan.asset_uploaded', assetId, {
    title: cleanTitle,
    filename: safeName,
    size: buffer.length
  });

  return {
    id: assetId,
    title: cleanTitle,
    filename: safeName,
    file_format: ext.replace('.', ''),
    file_size: buffer.length,
    resource_type: cleanType,
    url: `/api/training-plans/assets/${assetId}`
  };
}

/**
 * Retrieve uploaded training asset file buffer.
 */
export function getTrainingAsset(db, user, assetId) {
  permit(user, 'recruit', 'review', 'admin');

  const asset = db.prepare('SELECT * FROM training_plan_assets WHERE id = ?').get(assetId);
  if (!asset) throw new HttpError(404, 'Training asset not found.');

  if (!existsSync(asset.storage_path)) {
    throw new HttpError(404, 'Asset file not found on disk.');
  }

  const buffer = readFileSync(asset.storage_path);
  return {
    buffer,
    contentType: asset.mime_type,
    filename: asset.filename
  };
}
