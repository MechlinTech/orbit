/**
 * Orbit ATS Offer Letter Template and Document Customization Service
 * Handles template lifecycle (CRUD, versioning, duplication, archiving),
 * letterhead assets, multi-page document pagination, preview generation,
 * and authoritative candidate offer issuance.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { id, now, audit, transaction } from '../db.js';
import { HttpError, requirePermission as permit, can, text as validateText } from '../policy.js';
import { SignatureStorageManager } from './storage.js';
import { VARIABLE_REGISTRY, resolveOfferVariables, validateTemplateVariables, interpolateText } from './variables.js';
import { processLetterheadAsset, calculateLetterheadPlacement, A4_WIDTH_PT, A4_HEIGHT_PT } from './asset_processor.js';
import { paginateDocument } from './paginator.js';
import { buildPdfDocument, parsePngImage, parseJpegImage } from './pdf.js';

/**
 * Standard default multi-page offer letter template structure
 * containing executive appointment terms, salary annexure, background verification,
 * and dual signature blocks.
 */
export const DEFAULT_TEMPLATE_SECTIONS = [
  {
    id: 'sec_header',
    type: 'heading',
    level: 1,
    text: '{{company.name}}',
    align: 'left'
  },
  {
    id: 'sec_sub_header',
    type: 'paragraph',
    text: '{{company.address}}\nWebsite: {{company.website}} | Email: {{company.email}}',
    fontSize: 8.5,
    marginBottom: 16
  },
  {
    id: 'sec_divider_1',
    type: 'divider'
  },
  {
    id: 'sec_ref_date',
    type: 'key_value_grid',
    rows: [
      { key: 'Date of Issuance', value: '{{offer.date}}' },
      { key: 'Offer Reference No', value: '{{offer.reference_number}}' },
      { key: 'Offer Validity Expiry', value: '{{offer.expiry_date}}' }
    ]
  },
  {
    id: 'sec_candidate_info',
    type: 'paragraph',
    text: 'To,\n{{candidate.name}}\n{{candidate.address}}\nEmail: {{candidate.email}} | Contact: {{candidate.phone}}',
    fontSize: 9.5,
    marginBottom: 14
  },
  {
    id: 'sec_title',
    type: 'heading',
    level: 1,
    text: 'OFFER OF EMPLOYMENT: {{employment.designation}}',
    align: 'left'
  },
  {
    id: 'sec_greeting',
    type: 'paragraph',
    text: 'Dear {{candidate.first_name}},\n\nOn behalf of {{company.name}}, we are pleased to extend an offer of employment for the position of {{employment.designation}} with our {{requisition.department}} team, reporting to {{employment.manager}}. We were impressed by your technical competence, professional accomplishments, and enthusiasm during our interview discussions.',
    fontSize: 9.5,
    marginBottom: 10
  },
  {
    id: 'sec_position_terms_heading',
    type: 'heading',
    level: 2,
    text: '1. Position Details & Commencement'
  },
  {
    id: 'sec_position_terms_list',
    type: 'bullet_list',
    items: [
      'Designation & Role: You will be appointed as {{employment.designation}} within the {{requisition.department}} organization.',
      'Anticipated Date of Joining: Your employment will commence on {{employment.joining_date}}.',
      'Work Location: Your primary workplace is designated as {{employment.location}}, subject to company hybrid working guidelines.',
      'Employment Classification: {{employment.employment_type}} regular appointment.',
      'Probationary Period: You will be on probation for a period of {{employment.probation_period}} from the date of joining, during which your performance will be reviewed.'
    ]
  },
  {
    id: 'sec_compensation_heading',
    type: 'heading',
    level: 2,
    text: '2. Compensation & Benefits'
  },
  {
    id: 'sec_compensation_text',
    type: 'paragraph',
    text: 'Your total annual Cost to Company (CTC) will be {{offer.annual_ctc}} ({{offer.salary_period}}), payable monthly in arrears in accordance with company payroll schedules. The detailed breakup of your compensation structure, statutory benefits, and retiral contributions is set forth in Annexure A attached hereto.',
    fontSize: 9.5,
    marginBottom: 8
  },
  {
    id: 'sec_benefits_list',
    type: 'bullet_list',
    items: [
      'Statutory & Retirement Benefits: Participation in Employee Provident Fund, Gratuity, and statutory insurances as applicable.',
      'Medical & Health Coverage: Comprehensive group hospitalization and accidental insurance coverage for self and eligible dependents.',
      'Paid Leave: Annual entitlement to paid leave, sick leave, and statutory festival holidays as defined by company human resources policy.'
    ]
  },
  {
    id: 'sec_contingencies_heading',
    type: 'heading',
    level: 2,
    text: '3. Background Verification & Employment Contingencies'
  },
  {
    id: 'sec_contingencies_text',
    type: 'paragraph',
    text: 'This offer and your continued employment are strictly contingent upon the following pre-conditions:\n\n• Satisfactory completion of comprehensive background verification checks, including verification of prior employment history, educational qualifications, professional references, and legal right-to-work documentation.\n• Submission of formal relieving documentation, service certificate, and final settlement records from your current employer prior to or on your commencement date.\n• True and accurate representation of all facts in your application; any misrepresentation or omission discovered subsequently will be grounds for immediate revocation of this offer or termination of employment without notice.',
    fontSize: 9,
    marginBottom: 10
  },
  {
    id: 'sec_confidentiality_heading',
    type: 'heading',
    level: 2,
    text: '4. Confidentiality, Intellectual Property & Code of Conduct'
  },
  {
    id: 'sec_confidentiality_text',
    type: 'paragraph',
    text: 'During your employment, you will have access to confidential proprietary information, intellectual property, customer data, and trade secrets of {{company.name}}. You agree to maintain strict confidentiality both during and after your tenure. All inventions, software developments, work products, and designs created during your employment belong solely to the company. You will be required to execute the company\'s standard Proprietary Information and Inventions Agreement upon joining.',
    fontSize: 9,
    marginBottom: 12
  },
  {
    id: 'sec_acceptance_heading',
    type: 'heading',
    level: 2,
    text: '5. Offer Acceptance & Execution'
  },
  {
    id: 'sec_acceptance_text',
    type: 'paragraph',
    text: '{{offer.acceptance_instructions}}\n\nThis offer remains valid until {{offer.expiry_date}}. Please review the terms herein and execute your electronic signature below. Upon your execution, this document constitutes a binding agreement between you and {{company.name}}.',
    fontSize: 9,
    marginBottom: 18
  },
  {
    id: 'sec_sig_block',
    type: 'signature_block',
    authorizerName: '{{signature.authorizer_name}}',
    authorizerTitle: '{{signature.authorizer_title}}',
    signerName: '{{signature.signer_name}}'
  },
  {
    id: 'sec_page_break_annexure',
    type: 'page_break'
  },
  {
    id: 'sec_annexure_heading',
    type: 'heading',
    level: 1,
    text: 'ANNEXURE A — DETAILED COMPENSATION STRUCTURE'
  },
  {
    id: 'sec_annexure_intro',
    type: 'paragraph',
    text: 'Candidate Name: {{candidate.name}}  |  Designation: {{employment.designation}}  |  Location: {{employment.location}}\nEffective Date: {{employment.joining_date}}  |  Currency: {{offer.currency}}',
    fontSize: 9,
    marginBottom: 12
  },
  {
    id: 'sec_salary_table',
    type: 'salary_annexure',
    title: 'ANNUAL & MONTHLY REMUNERATION DETAILS'
  },
  {
    id: 'sec_notes_heading',
    type: 'heading',
    level: 3,
    text: 'Important Notes regarding Compensation:'
  },
  {
    id: 'sec_notes_list',
    type: 'bullet_list',
    items: [
      'Income Tax & Statutory Deductions: All payments are subject to standard income tax deductions at source (TDS) and other statutory levies as mandated by prevailing tax laws.',
      'Performance Reviews: Salary reviews and promotional assessments are conducted annually based on individual performance and company achievements.',
      'Confidentiality: Remuneration details are strictly confidential between you and {{company.name}} and should not be disclosed to other employees or third parties.'
    ]
  }
];

export const DEFAULT_PAGE_CONFIG = {
  width: A4_WIDTH_PT,
  height: A4_HEIGHT_PT,
  marginTop: 60,
  marginBottom: 60,
  marginLeft: 54,
  marginRight: 54,
  defaultFontSize: 10,
  fontFamily: 'Helvetica'
};

export const DEFAULT_HEADER_CONFIG = {
  enabled: true,
  showOnFirstPage: false,
  text: '{{company.name}} · Offer of Employment — {{candidate.name}}'
};

export const DEFAULT_FOOTER_CONFIG = {
  enabled: true,
  text: '{{company.name}} — Strictly Private & Confidential',
  pageNumberFormat: 'Page {page} of {pages}'
};

export const DEFAULT_BACKGROUND_CONFIG = {
  assetId: null,
  firstPageAssetId: null,
  continuationAssetId: null,
  scaling: 'fit',
  position: 'full-page'
};

/**
 * Automatically seeds the database with the default executive offer letter template
 * if the offer_letter_templates table is empty.
 */
export function seedDefaultTemplatesIfEmpty(db) {
  try {
    const existing = db.prepare('SELECT COUNT(*) as count FROM offer_letter_templates').get();
    if (existing && existing.count > 0) return;

    const userRow = db.prepare("SELECT id FROM users WHERE role='System Admin' LIMIT 1").get()
      || db.prepare("SELECT id FROM users LIMIT 1").get();
    if (!userRow) return;
    const creatorId = userRow.id;
    const templateId = id();
    const nowStr = now();

    db.prepare(`
      INSERT INTO offer_letter_templates(
        id, name, description, status, version, is_default,
        page_config, header_config, footer_config, background_config, sections,
        created_by, created_at, updated_at
      )
      VALUES(?, ?, ?, 'active', 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      templateId,
      'Standard Executive Offer Letter & Terms',
      'Production-ready multi-page employment agreement with salary annexure, background verification contingencies, and electronic signature blocks.',
      JSON.stringify(DEFAULT_PAGE_CONFIG),
      JSON.stringify(DEFAULT_HEADER_CONFIG),
      JSON.stringify(DEFAULT_FOOTER_CONFIG),
      JSON.stringify(DEFAULT_BACKGROUND_CONFIG),
      JSON.stringify(DEFAULT_TEMPLATE_SECTIONS),
      creatorId,
      nowStr,
      nowStr
    );
  } catch {}
}

/**
 * Lists offer letter templates with filtering.
 */
export function listOfferTemplates(db, user, { status = null } = {}) {
  permit(user, 'offers.templates.read', 'offers.read');
  let sql = `
    SELECT t.id, t.name, t.description, t.status, t.version, t.is_default,
           t.created_by, t.created_at, t.updated_at,
           u.name as creator_name
    FROM offer_letter_templates t
    LEFT JOIN users u ON u.id = t.created_by
  `;
  const params = [];
  if (status) {
    sql += ' WHERE t.status = ?';
    params.push(status);
  } else {
    sql += " WHERE t.status != 'archived'";
  }
  sql += ' ORDER BY t.is_default DESC, t.updated_at DESC';

  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    version: r.version,
    is_default: Boolean(r.is_default),
    created_by: r.created_by,
    creator_name: r.creator_name || 'System',
    created_at: r.created_at,
    updated_at: r.updated_at
  }));
}

/**
 * Retrieves a single template by ID with full parsed configurations and sections.
 */
export function getOfferTemplate(db, user, templateId) {
  permit(user, 'offers.templates.read', 'offers.read');
  const t = db.prepare(`
    SELECT t.*, u.name as creator_name
    FROM offer_letter_templates t
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.id = ?
  `).get(templateId);

  if (!t) throw new HttpError(404, 'Offer letter template not found.');

  return {
    id: t.id,
    name: t.name,
    description: t.description,
    status: t.status,
    version: t.version,
    is_default: Boolean(t.is_default),
    page_config: JSON.parse(t.page_config || '{}'),
    header_config: JSON.parse(t.header_config || '{}'),
    footer_config: JSON.parse(t.footer_config || '{}'),
    background_config: JSON.parse(t.background_config || '{}'),
    sections: JSON.parse(t.sections || '[]'),
    created_by: t.created_by,
    creator_name: t.creator_name || 'System',
    created_at: t.created_at,
    updated_at: t.updated_at
  };
}

/**
 * Creates a new offer letter template.
 */
export function createOfferTemplate(db, user, data = {}) {
  permit(user, 'offers.templates.manage', 'offers.assets.manage');

  const name = validateText(data.name || 'Untitled Template', 'Template name', 150);
  const description = validateText(data.description || '', 'Description', 1000, true);
  const status = ['draft', 'active', 'archived'].includes(data.status) ? data.status : 'draft';
  const isDefault = Boolean(data.is_default);

  const pageConfig = { ...DEFAULT_PAGE_CONFIG, ...(data.page_config || {}) };
  const headerConfig = { ...DEFAULT_HEADER_CONFIG, ...(data.header_config || {}) };
  const footerConfig = { ...DEFAULT_FOOTER_CONFIG, ...(data.footer_config || {}) };
  const backgroundConfig = { ...DEFAULT_BACKGROUND_CONFIG, ...(data.background_config || {}) };
  const sections = Array.isArray(data.sections) && data.sections.length > 0 ? data.sections : DEFAULT_TEMPLATE_SECTIONS;

  const templateId = id();
  const nowStr = now();

  return transaction(db, () => {
    if (isDefault) {
      db.prepare('UPDATE offer_letter_templates SET is_default = 0').run();
    }

    db.prepare(`
      INSERT INTO offer_letter_templates(
        id, name, description, status, version, is_default,
        page_config, header_config, footer_config, background_config, sections,
        created_by, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      templateId,
      name,
      description,
      status,
      isDefault ? 1 : 0,
      JSON.stringify(pageConfig),
      JSON.stringify(headerConfig),
      JSON.stringify(footerConfig),
      JSON.stringify(backgroundConfig),
      JSON.stringify(sections),
      user.id,
      nowStr,
      nowStr
    );

    audit(db, user.id, 'offer_template.created', templateId, { name, status, is_default: isDefault });

    return getOfferTemplate(db, user, templateId);
  });
}

/**
 * Updates an existing offer letter template.
 */
export function updateOfferTemplate(db, user, templateId, data = {}) {
  permit(user, 'offers.templates.manage', 'offers.assets.manage');
  const existing = getOfferTemplate(db, user, templateId);

  const name = data.name !== undefined ? validateText(data.name, 'Template name', 150) : existing.name;
  const description = data.description !== undefined ? validateText(data.description, 'Description', 1000, true) : existing.description;
  const status = ['draft', 'active', 'archived'].includes(data.status) ? data.status : existing.status;
  const isDefault = data.is_default !== undefined ? Boolean(data.is_default) : existing.is_default;

  const pageConfig = data.page_config !== undefined ? { ...existing.page_config, ...data.page_config } : existing.page_config;
  const headerConfig = data.header_config !== undefined ? { ...existing.header_config, ...data.header_config } : existing.header_config;
  const footerConfig = data.footer_config !== undefined ? { ...existing.footer_config, ...data.footer_config } : existing.footer_config;
  const backgroundConfig = data.background_config !== undefined ? { ...existing.background_config, ...data.background_config } : existing.background_config;
  const sections = data.sections !== undefined ? data.sections : existing.sections;

  // Increment version if template is active and content changed
  const contentChanged = JSON.stringify(sections) !== JSON.stringify(existing.sections)
    || JSON.stringify(pageConfig) !== JSON.stringify(existing.page_config)
    || JSON.stringify(backgroundConfig) !== JSON.stringify(existing.background_config);

  const newVersion = (existing.status === 'active' && contentChanged) ? (existing.version + 1) : existing.version;
  const nowStr = now();

  return transaction(db, () => {
    if (isDefault && !existing.is_default) {
      db.prepare('UPDATE offer_letter_templates SET is_default = 0').run();
    }

    db.prepare(`
      UPDATE offer_letter_templates
      SET name = ?, description = ?, status = ?, version = ?, is_default = ?,
          page_config = ?, header_config = ?, footer_config = ?, background_config = ?, sections = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      name,
      description,
      status,
      newVersion,
      isDefault ? 1 : 0,
      JSON.stringify(pageConfig),
      JSON.stringify(headerConfig),
      JSON.stringify(footerConfig),
      JSON.stringify(backgroundConfig),
      JSON.stringify(sections),
      nowStr,
      templateId
    );

    audit(db, user.id, 'offer_template.updated', templateId, {
      name,
      status,
      version: newVersion,
      content_changed: contentChanged
    });

    return getOfferTemplate(db, user, templateId);
  });
}

/**
 * Duplicates a template into a new Draft template.
 */
export function duplicateOfferTemplate(db, user, templateId, options = {}) {
  permit(user, 'offers.templates.manage', 'offers.assets.manage');
  const source = getOfferTemplate(db, user, templateId);

  const newName = options.name || `${source.name} (Copy)`;
  return createOfferTemplate(db, user, {
    name: newName,
    description: source.description,
    status: 'draft',
    is_default: false,
    page_config: source.page_config,
    header_config: source.header_config,
    footer_config: source.footer_config,
    background_config: source.background_config,
    sections: source.sections
  });
}

/**
 * Changes status of a template (e.g. publish active, archive, set default).
 */
export function setOfferTemplateStatus(db, user, templateId, status, isDefault = null) {
  permit(user, 'offers.templates.manage', 'offers.assets.manage');
  const existing = getOfferTemplate(db, user, templateId);
  const nowStr = now();

  const targetStatus = (status !== undefined && status !== null) ? status : existing.status;
  if (!['draft', 'active', 'archived'].includes(targetStatus)) {
    throw new HttpError(400, 'Invalid template status. Allowed values: draft, active, archived.');
  }

  return transaction(db, () => {
    if (isDefault) {
      db.prepare('UPDATE offer_letter_templates SET is_default = 0').run();
    }

    db.prepare(`
      UPDATE offer_letter_templates
      SET status = ?, is_default = COALESCE(?, is_default), updated_at = ?
      WHERE id = ?
    `).run(targetStatus, isDefault !== null && isDefault !== undefined ? (isDefault ? 1 : 0) : null, nowStr, templateId);

    audit(db, user.id, 'offer_template.status_changed', templateId, { status, is_default: isDefault });

    return getOfferTemplate(db, user, templateId);
  });
}

/**
 * Uploads and stores a company letterhead asset.
 */
export function uploadLetterheadAsset(db, user, { buffer, filename, format = null, name = null, scaling = null, pageTarget = null } = {}, storage = null) {
  permit(user, 'offers.templates.manage', 'offers.assets.manage');
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new HttpError(400, 'Missing or invalid file buffer for letterhead upload.');
  }

  const processed = processLetterheadAsset(buffer, filename);
  const storageMgr = storage || new SignatureStorageManager();
  storageMgr.ensureDirectories();

  const assetId = `lh-${id()}`;
  const diskFilename = `${assetId}.${processed.format}`;
  const diskPath = join(storageMgr.assetsDir, diskFilename);

  writeFileSync(diskPath, processed.buffer, { mode: 0o600 });
  const nowStr = now();
  const displayName = (name && String(name).trim()) || processed.filename;
  const scalingMode = scaling || 'fit';
  const targetPages = pageTarget || 'all';

  db.prepare(`
    INSERT INTO offer_letter_assets(
      id, name, filename, file_format, file_size, mime_type, storage_path,
      sha256_hash, width, height, scaling_mode, page_target, created_by, created_at
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    assetId,
    displayName,
    processed.filename,
    processed.format,
    processed.size,
    processed.mimeType,
    diskPath,
    processed.sha256,
    processed.width,
    processed.height,
    scalingMode,
    targetPages,
    user.id,
    nowStr
  );

  audit(db, user.id, 'offer_asset.uploaded', assetId, {
    name: displayName,
    filename: processed.filename,
    format: processed.format,
    width: processed.width,
    height: processed.height
  });

  return {
    id: assetId,
    name: displayName,
    filename: processed.filename,
    format: processed.format,
    file_format: processed.format,
    mimeType: processed.mimeType,
    width: processed.width,
    height: processed.height,
    size: processed.size,
    file_size: processed.size,
    scaling_mode: scalingMode,
    page_target: targetPages,
    created_at: nowStr
  };
}

/**
 * Lists all uploaded company letterhead assets.
 */
export function listOfferLetterAssets(db, user) {
  permit(user, 'offers.templates.read', 'offers.read');
  const rows = db.prepare('SELECT * FROM offer_letter_assets ORDER BY created_at DESC').all();
  return rows.map(r => ({
    id: r.id,
    name: r.name || r.filename,
    filename: r.filename,
    file_format: r.file_format,
    format: r.file_format,
    file_size: r.file_size,
    size: r.file_size,
    mime_type: r.mime_type,
    width: r.width,
    height: r.height,
    scaling_mode: r.scaling_mode || 'fit',
    page_target: r.page_target || 'all',
    created_at: r.created_at,
    created_by: r.created_by
  }));
}

/**
 * Deletes a letterhead asset and its physical file on disk.
 */
export function deleteOfferLetterAsset(db, user, assetId) {
  permit(user, 'offers.templates.manage', 'offers.assets.manage');
  const record = db.prepare('SELECT * FROM offer_letter_assets WHERE id = ?').get(assetId);
  if (!record) throw new HttpError(404, 'Letterhead asset not found.');

  if (existsSync(record.storage_path)) {
    try {
      unlinkSync(record.storage_path);
    } catch {}
  }

  db.prepare('DELETE FROM offer_letter_assets WHERE id = ?').run(assetId);

  audit(db, user.id, 'offer_asset.deleted', assetId, {
    filename: record.filename
  });

  return { success: true, id: assetId };
}

/**
 * Retrieves a letterhead asset buffer from disk.
 */
export function getLetterheadAssetBuffer(db, user, assetId) {
  permit(user, 'offers.templates.read', 'offers.read');
  const record = db.prepare('SELECT * FROM offer_letter_assets WHERE id = ?').get(assetId);
  if (!record) throw new HttpError(404, 'Letterhead asset not found.');

  if (!existsSync(record.storage_path)) {
    throw new HttpError(404, 'Letterhead asset file missing from storage.');
  }

  const buf = readFileSync(record.storage_path);
  return {
    record,
    buffer: buf,
    mimeType: record.mime_type,
    filename: record.filename
  };
}

/**
 * Loads and parses an asset into a PDF-embeddable Image XObject.
 */
export function loadParsedAssetForPdf(db, assetId) {
  if (!assetId) return null;
  try {
    const record = db.prepare('SELECT * FROM offer_letter_assets WHERE id = ?').get(assetId);
    if (!record || !existsSync(record.storage_path)) return null;

    const buf = readFileSync(record.storage_path);
    let parsed = null;

    if (record.file_format === 'png') {
      parsed = parsePngImage(buf);
    } else if (record.file_format === 'jpeg' || record.file_format === 'jpg') {
      parsed = parseJpegImage(buf);
    }

    if (parsed) {
      const placement = calculateLetterheadPlacement({
        assetWidth: parsed.width,
        assetHeight: parsed.height,
        pageWidth: A4_WIDTH_PT,
        pageHeight: A4_HEIGHT_PT,
        scaling: 'fit',
        position: 'full-page'
      });
      return { ...parsed, placement };
    }
  } catch {}
  return null;
}

/**
 * Compiles a template into an A4 PDF document buffer using real candidate and offer data.
 */
export function compileTemplateToPdf(db, template, {
  candidateId = null,
  applicationId = null,
  requisitionId = null,
  offerData = {},
  user = {},
  customVariables = {},
  customSections = null
} = {}) {
  let candidate = null;
  let req = null;
  let company = { name: 'Mechlin Technologies' };

  if (candidateId) {
    candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
  }
  if (applicationId && !candidate) {
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
    if (app) {
      candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(app.candidate_id);
      if (!requisitionId) requisitionId = app.requisition_id;
    }
  }
  if (requisitionId) {
    req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisitionId);
  }

  // Authoritative approved offer data resolution
  const resolvedVariables = resolveOfferVariables({
    company,
    candidate: candidate || {},
    requisition: req || {},
    offer: offerData || {},
    user: user || {},
    customVariables
  });

  const sectionsToUse = (Array.isArray(customSections) && customSections.length > 0)
    ? customSections
    : (template.sections || []);

  // Pre-generation validation check
  const validation = validateTemplateVariables(sectionsToUse, resolvedVariables);

  // Load any configured letterhead assets
  const assetsMap = {};
  const bgConfig = template.background_config || {};
  for (const aId of [bgConfig.assetId, bgConfig.firstPageAssetId, bgConfig.continuationAssetId]) {
    if (aId && !assetsMap[aId]) {
      const parsed = loadParsedAssetForPdf(db, aId);
      if (parsed) assetsMap[aId] = parsed;
    }
  }

  // Run the multi-page pagination engine
  const paginatedPages = paginateDocument({
    sections: sectionsToUse,
    variables: resolvedVariables,
    pageConfig: template.page_config,
    headerConfig: template.header_config,
    footerConfig: template.footer_config,
    backgroundConfig: template.background_config,
    assets: assetsMap
  });

  // Build the binary PDF
  const pdfBuffer = buildPdfDocument(paginatedPages);

  return {
    pdfBuffer,
    totalPages: paginatedPages.length,
    validation,
    variables: resolvedVariables,
    templateSnapshot: {
      templateId: template.id,
      name: template.name,
      version: template.version,
      sections: sectionsToUse,
      pageConfig: template.page_config,
      headerConfig: template.header_config,
      footerConfig: template.footer_config,
      backgroundConfig: template.background_config,
      compiledAt: now()
    }
  };
}

/**
 * Generates an interactive preview data structure for browser display.
 */
export function previewOfferTemplate(db, user, templateId, {
  candidateId = null,
  applicationId = null,
  requisitionId = null,
  offerData = {},
  customVariables = {},
  customSections = null,
  pageConfig = null,
  headerConfig = null,
  footerConfig = null,
  backgroundConfig = null
} = {}) {
  permit(user, 'offers.templates.read', 'offers.read');
  let template = null;
  if (!templateId || templateId === 'preview' || templateId === 'draft') {
    template = {
      id: templateId || 'preview',
      name: 'Document Preview',
      version: 1,
      sections: customSections || DEFAULT_TEMPLATE_SECTIONS,
      page_config: pageConfig || DEFAULT_PAGE_CONFIG,
      header_config: headerConfig || DEFAULT_HEADER_CONFIG,
      footer_config: footerConfig || DEFAULT_FOOTER_CONFIG,
      background_config: backgroundConfig || DEFAULT_BACKGROUND_CONFIG
    };
  } else {
    template = getOfferTemplate(db, user, templateId);
    if (customSections) template.sections = customSections;
    if (pageConfig) template.page_config = pageConfig;
    if (headerConfig) template.header_config = headerConfig;
    if (footerConfig) template.footer_config = footerConfig;
    if (backgroundConfig) template.background_config = backgroundConfig;
  }

  const result = compileTemplateToPdf(db, template, {
    candidateId,
    applicationId,
    requisitionId,
    offerData,
    user,
    customVariables,
    customSections
  });

  return {
    templateId: template.id,
    templateName: template.name,
    version: template.version,
    totalPages: result.totalPages,
    validation: result.validation,
    variables: result.variables,
    sections: template.sections,
    headerConfig: template.header_config,
    footerConfig: template.footer_config,
    pdfBase64: result.pdfBuffer.toString('base64'),
    pdfSize: result.pdfBuffer.length
  };
}
