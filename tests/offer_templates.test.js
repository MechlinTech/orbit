/**
 * Test Suite: Offer Letter Customization, Letterheads, Variable Registry,
 * Multi-Page Pagination (1 to 50+ Pages), and E-Signature Integration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { openDb } from '../src/db.js';
import { service } from '../src/service.js';
import { createSignatureRequest, getSignatureRequest } from '../src/signature/service.js';
import {
  listOfferTemplates, getOfferTemplate, createOfferTemplate, updateOfferTemplate,
  duplicateOfferTemplate, setOfferTemplateStatus, uploadLetterheadAsset,
  previewOfferTemplate, compileTemplateToPdf, listOfferLetterAssets, deleteOfferLetterAsset
} from '../src/signature/template_service.js';
import {
  VARIABLE_REGISTRY, resolveOfferVariables, validateTemplateVariables,
  calculateSalaryStructure, interpolateText
} from '../src/signature/variables.js';
import { paginateDocument } from '../src/signature/paginator.js';
import { buildPdfDocument } from '../src/signature/pdf.js';

// Helper to extract uncompressed text streams from PDF buffer
function extractPdfStreams(buffer) {
  let combined = '';
  let idx = 0;
  while ((idx = buffer.indexOf('stream', idx)) !== -1) {
    const end = buffer.indexOf('endstream', idx);
    if (end === -1) break;
    const start = buffer.indexOf(0x0a, idx) + 1;
    try {
      const text = zlib.inflateSync(buffer.subarray(start, end)).toString('utf8');
      combined += text + '\n';
    } catch {
      try {
        const raw = buffer.subarray(start, end).toString('utf8');
        if (raw.includes('BT') || raw.includes('Tj')) combined += raw + '\n';
      } catch {}
    }
    idx = end + 9;
  }
  return combined;
}

// 1x1 Transparent PNG fixture
const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

// Minimal valid JPEG fixture
const VALID_JPEG_BUFFER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
  0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c,
  0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x0a, 0x00,
  0x0a, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00,
  0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xff, 0xd9
]);

test('Offer Letter Module: Variable registry resolution and conditionals', () => {
  const vars = resolveOfferVariables({
    company: { name: 'Mechlin Technologies', address: 'Tech Park, Mohali' },
    candidate: { name: 'Samantha Vance', email: 'samantha@example.com', phone: '+1 555 4321' },
    requisition: { title: 'Lead Architect', team: 'Platform', currency: 'USD' },
    offer: {
      salary: '180,000',
      currency: 'USD',
      start_date: 'December 1, 2026',
      variable_bonus: '15% annual bonus'
    }
  });

  assert.equal(vars['candidate.name'], 'Samantha Vance');
  assert.equal(vars['candidate.first_name'], 'Samantha');
  assert.equal(vars['offer.salary'], '180,000');
  assert.equal(vars['offer.annual_ctc'], 'USD 180,000');
  assert.equal(vars['employment.joining_date'], 'December 1, 2026');

  // Interpolation with conditionals
  const template = 'Dear {{candidate.first_name}}, {{#if offer.variable_bonus}}Bonus: {{offer.variable_bonus}}{{else}}No bonus{{/if}}';
  const rendered = interpolateText(template, vars);
  assert.equal(rendered, 'Dear Samantha, Bonus: 15% annual bonus');

  // Conditionals falsy branch
  const noBonusVars = { ...vars, 'offer.variable_bonus': '' };
  const renderedNoBonus = interpolateText(template, noBonusVars);
  assert.equal(renderedNoBonus, 'Dear Samantha, No bonus');

  // Pre-generation validation check
  const check = validateTemplateVariables(
    [{ text: '{{candidate.name}} {{requisition.title}} {{employment.joining_date}}' }],
    vars
  );
  assert.equal(check.valid, true);
  assert.equal(check.missing.length, 0);

  // Missing required variable detection
  const missingCheck = validateTemplateVariables(
    [{ text: '{{candidate.name}} {{employment.designation}}' }],
    { 'candidate.name': 'Samantha' } // missing employment.designation
  );
  assert.equal(missingCheck.valid, false);
  assert.ok(missingCheck.missing.some(m => m.key === 'employment.designation'));
});

test('Offer Letter Module: Salary annexure calculation matching payroll rules', () => {
  // Test INR breakdown
  const inrStructure = calculateSalaryStructure(1200000, 'INR');
  assert.ok(Array.isArray(inrStructure));
  const basic = inrStructure.find(r => r.name === 'Basic Salary');
  assert.equal(basic.annual, 600000); // 50% of CTC
  assert.equal(basic.monthly, 50000);

  const ctcRow = inrStructure.find(r => r.category === 'total');
  assert.equal(ctcRow.annual, 1200000);

  // Test USD breakdown
  const usdStructure = calculateSalaryStructure(120000, 'USD');
  const usdBasic = usdStructure.find(r => r.name === 'Basic Salary');
  assert.equal(usdBasic.annual, 60000);
  assert.equal(usdBasic.monthly, 5000);
});

test('Offer Letter Module: Letterhead asset upload validation and layout calculation', () => {
  const db = openDb(':memory:');
  const admin = { id: 'usr-admin-1', role: 'System Admin', status: 'active' };
  db.prepare("INSERT INTO users(id, email, name, role, team, status, created_at) VALUES('usr-admin-1', 'admin@example.com', 'Admin User', 'System Admin', 'Eng', 'active', datetime('now'))").run();

  // Valid PNG upload
  const pngAsset = uploadLetterheadAsset(db, admin, {
    buffer: VALID_PNG_BUFFER,
    filename: 'stationery.png'
  });
  assert.ok(pngAsset.id);
  assert.equal(pngAsset.format, 'png');

  // Valid JPEG upload
  const jpgAsset = uploadLetterheadAsset(db, admin, {
    buffer: VALID_JPEG_BUFFER,
    filename: 'header.jpg'
  });
  assert.ok(jpgAsset.id);
  assert.equal(jpgAsset.format, 'jpeg');

  // Corrupted / fake extension rejection
  assert.throws(() => {
    uploadLetterheadAsset(db, admin, {
      buffer: Buffer.from('not an image at all'),
      filename: 'fake.png'
    });
  }, /Corrupted or invalid file/);

  // Oversized file rejection
  const hugeBuffer = Buffer.alloc(11 * 1024 * 1024);
  assert.throws(() => {
    uploadLetterheadAsset(db, admin, {
      buffer: hugeBuffer,
      filename: 'huge.png'
    });
  }, /exceeds maximum allowed size/);
});

test('Offer Letter Module: Template CRUD, duplicate, versioning and archiving', () => {
  const db = openDb(':memory:');
  const admin = { id: 'usr-admin-2', role: 'System Admin', status: 'active' };
  db.prepare("INSERT INTO users(id, email, name, role, team, status, created_at) VALUES('usr-admin-2', 'admin2@example.com', 'Admin User', 'System Admin', 'Eng', 'active', datetime('now'))").run();

  // 1. Create template
  const created = createOfferTemplate(db, admin, {
    name: 'Engineering Senior Offer Template',
    description: 'Customized template for engineering leads',
    status: 'draft',
    sections: [
      { type: 'heading', level: 1, text: 'Mechlin Engineering Offer' },
      { type: 'paragraph', text: 'Welcome {{candidate.name}} to the team.' }
    ]
  });
  assert.ok(created.id);
  assert.equal(created.name, 'Engineering Senior Offer Template');
  assert.equal(created.status, 'draft');
  assert.equal(created.version, 1);

  // 2. Publish / Activate template
  const activated = setOfferTemplateStatus(db, admin, created.id, 'active', true);
  assert.equal(activated.status, 'active');
  assert.equal(activated.is_default, true);

  // 3. Update template (increments version when active)
  const updated = updateOfferTemplate(db, admin, created.id, {
    sections: [
      { type: 'heading', level: 1, text: 'Mechlin Engineering Offer v2' },
      { type: 'paragraph', text: 'Updated content for {{candidate.name}}' }
    ]
  });
  assert.equal(updated.version, 2);

  // 4. Duplicate template
  const duplicate = duplicateOfferTemplate(db, admin, created.id, {
    name: 'Product Design Template (Cloned)'
  });
  assert.equal(duplicate.name, 'Product Design Template (Cloned)');
  assert.equal(duplicate.status, 'draft');
  assert.equal(duplicate.version, 1);

  // 5. List templates
  const list = listOfferTemplates(db, admin);
  assert.ok(list.length >= 2);

  // 6. Archive template
  const archived = setOfferTemplateStatus(db, admin, duplicate.id, 'archived');
  assert.equal(archived.status, 'archived');
  const activeList = listOfferTemplates(db, admin);
  assert.ok(!activeList.some(t => t.id === duplicate.id));
});

test('Offer Letter Module: Multi-page document scalability (1, 5, 10, 20, and 50+ pages)', () => {
  const variables = {
    'company.name': 'Mechlin Technologies',
    'candidate.name': 'Jordan Lee',
    'offer.salary': '150,000',
    'offer.currency': 'USD',
    'offer.annual_ctc': 'USD 150,000',
    'employment.designation': 'Principal Cloud Architect',
    'employment.joining_date': 'December 1, 2026'
  };

  // 1. Single page document
  const onePageSections = [
    { type: 'heading', level: 1, text: 'Offer of Employment' },
    { type: 'paragraph', text: 'Short offer letter summary for Jordan Lee.' }
  ];
  const p1 = paginateDocument({ sections: onePageSections, variables });
  assert.equal(p1.length, 1);
  const pdf1 = buildPdfDocument(p1);
  assert.ok(pdf1.length > 500);

  // 2. 5-page document with forced page breaks
  const fivePageSections = [];
  for (let p = 1; p <= 5; p++) {
    fivePageSections.push({ type: 'heading', level: 1, text: `Section Chapter ${p}` });
    fivePageSections.push({ type: 'paragraph', text: `Detailed legal terms and agreement conditions for chapter ${p}.\n`.repeat(5) });
    if (p < 5) fivePageSections.push({ type: 'page_break' });
  }
  const p5 = paginateDocument({ sections: fivePageSections, variables });
  assert.equal(p5.length, 5);
  const pdf5 = buildPdfDocument(p5);
  assert.ok(pdf5.length > 2000);

  // 3. 20-page document with content overflow
  const twentyPageSections = [];
  for (let i = 1; i <= 20; i++) {
    twentyPageSections.push({ type: 'heading', level: 1, text: `Policy Schedule ${i}` });
    twentyPageSections.push({ type: 'paragraph', text: `Clause ${i}: Employment confidentiality and technical intellectual property protection terms.\n`.repeat(15) });
    twentyPageSections.push({ type: 'page_break' });
  }
  const p20 = paginateDocument({ sections: twentyPageSections, variables });
  assert.ok(p20.length >= 20);
  const pdf20 = buildPdfDocument(p20);
  assert.ok(pdf20.length > 8000);

  // 4. 50+ page massive document scalability test (fast, no clipping, linear performance)
  const startTime = Date.now();
  const fiftyPageSections = [];
  for (let i = 1; i <= 52; i++) {
    fiftyPageSections.push({ type: 'heading', level: 1, text: `Master Agreement Schedule Appendix ${i}` });
    fiftyPageSections.push({
      type: 'paragraph',
      text: `Detailed compliance, intellectual property, background screening, confidentiality and governance covenant ${i}.\n`.repeat(8)
    });
    fiftyPageSections.push({ type: 'page_break' });
  }
  const p50 = paginateDocument({ sections: fiftyPageSections, variables });
  const duration = Date.now() - startTime;
  assert.ok(p50.length >= 50, `Expected at least 50 pages, got ${p50.length}`);
  assert.ok(duration < 2000, `50-page pagination should take under 2 seconds, took ${duration}ms`);

  const pdf50 = buildPdfDocument(p50);
  assert.ok(pdf50.length > 20000);

  // Verify stream text on last page includes correct Page 52 of 52
  const textStreams = extractPdfStreams(pdf50);
  assert.ok(textStreams.includes('Page 52 of 52') || textStreams.includes('of 52'));
});

test('Offer Letter Module: End-to-end recruitment issuance with template snapshot and e-signature', async () => {
  const db = openDb(':memory:');
  const recruiter = { id: 'usr-rec-1', role: 'Recruiter', team: 'Engineering', status: 'active' };
  db.prepare("INSERT INTO users(id, email, name, role, team, status, created_at) VALUES('usr-rec-1', 'recruiter@example.com', 'Alex Recruiter', 'Recruiter', 'Engineering', 'active', datetime('now'))").run();
  db.prepare("INSERT INTO candidates(id, name, email, phone, skills, resume_text, source, team, created_by, created_at) VALUES('cand-e2e-1', 'Morgan Taylor', 'morgan.taylor@example.com', '555-9876', '[]', '', 'Direct', 'Engineering', 'usr-rec-1', datetime('now'))").run();
  db.prepare("INSERT INTO requisitions(id, title, team, headcount, salary_min, salary_max, currency, description, skills, status, created_by, created_at) VALUES('req-e2e-1', 'Lead Infrastructure Engineer', 'Engineering', 1, 140000, 160000, 'USD', 'Desc', '[]', 'open', 'usr-rec-1', datetime('now'))").run();
  db.prepare("INSERT INTO applications(id, candidate_id, requisition_id, stage, created_at) VALUES('app-e2e-1', 'cand-e2e-1', 'req-e2e-1', 'Interview', datetime('now'))").run();

  // 1. Create a specialized active template
  const customTemplate = createOfferTemplate(db, recruiter, {
    name: 'Executive Tech Lead Offer Template',
    status: 'active',
    is_default: false,
    sections: [
      { type: 'heading', level: 1, text: 'Mechlin Technologies Official Offer' },
      { type: 'paragraph', text: 'Dear {{candidate.name}},\n\nWe offer you the role of {{employment.designation}} with salary of {{offer.annual_ctc}}.' },
      { type: 'salary_annexure', title: 'COMPENSATION SCHEDULE' },
      { type: 'signature_block' }
    ]
  });

  // 2. Generate offer and create e-signature request using this template
  const sigReq = await createSignatureRequest(db, recruiter, {
    title: 'Executive Offer Letter - Morgan Taylor',
    candidateId: 'cand-e2e-1',
    applicationId: 'app-e2e-1',
    requisitionId: 'req-e2e-1',
    salary: '155,000',
    currency: 'USD',
    startDate: 'November 20, 2026',
    templateId: customTemplate.id
  });

  const reqId = sigReq.id || sigReq.request_id;
  assert.ok(reqId);

  // 3. Verify signature request record stores immutable template snapshot
  const fetched = getSignatureRequest(db, recruiter, reqId);
  assert.equal(fetched.template_id, customTemplate.id);
  assert.ok(fetched.template_snapshot);
  const snapshot = JSON.parse(fetched.template_snapshot);
  assert.equal(snapshot.name, 'Executive Tech Lead Offer Template');

  // 4. Verify generated PDF buffer preserves dynamic variables and salary
  const docRecord = db.prepare('SELECT storage_path FROM signature_documents WHERE id = ?').get(fetched.document_id);
  const docBuffer = db.storage ? db.storage.readFile(docRecord.storage_path) : (await import('node:fs')).readFileSync(docRecord.storage_path);
  const pdfText = extractPdfStreams(docBuffer);

  assert.ok(pdfText.includes('Morgan Taylor'));
  assert.ok(pdfText.includes('Lead Infrastructure Engineer') || pdfText.includes('155,000'));
  assert.ok(pdfText.includes('COMPENSATION SCHEDULE'));

  // 5. Verify editing the template afterwards does NOT alter already issued snapshot
  updateOfferTemplate(db, recruiter, customTemplate.id, {
    sections: [{ type: 'paragraph', text: 'Changed completely after issuance.' }]
  });
  const afterUpdate = getSignatureRequest(db, recruiter, reqId);
  const preservedSnapshot = JSON.parse(afterUpdate.template_snapshot);
  assert.equal(preservedSnapshot.name, 'Executive Tech Lead Offer Template');
  assert.equal(preservedSnapshot.sections[0].text, 'Mechlin Technologies Official Offer');
});

test('Offer Letter Module: HTTP service API endpoints for variables, templates, preview, and assets', async () => {
  const db = openDb(':memory:');
  const recruiter = { id: 'usr-rec-api', role: 'Recruiter', team: 'Dev', status: 'active' };
  db.prepare("INSERT INTO users(id, email, name, role, team, status, created_at) VALUES('usr-rec-api', 'rec.api@example.com', 'Alex Recruiter API', 'Recruiter', 'Dev', 'active', datetime('now'))").run();

  // 1. GET /offer-variables
  const varsRes = await service(db, recruiter, 'GET', 'offer-variables');
  assert.ok(Array.isArray(varsRes.variables));
  assert.ok(varsRes.variables.some(v => v.key === 'candidate.name'));
  assert.ok(varsRes.variables.some(v => v.key === 'offer.annual_ctc'));

  // 2. GET /offer-templates (seeds default template if empty)
  const list1 = await service(db, recruiter, 'GET', 'offer-templates');
  assert.ok(list1.length >= 1);
  const defaultTpl = list1.find(t => t.is_default);
  assert.ok(defaultTpl);

  // 3. POST /offer-templates
  const created = await service(db, recruiter, 'POST', 'offer-templates', {
    name: 'Specialized API Template',
    description: 'Testing API endpoints',
    status: 'active',
    sections: [
      { type: 'heading', level: 1, text: 'Custom Header' },
      { type: 'paragraph', text: 'Hello {{candidate.name}}' }
    ]
  });
  assert.ok(created.id);
  assert.equal(created.version, 1);

  // 4. PUT /offer-templates/:id (modifies content of active template -> version increments)
  const updated = await service(db, recruiter, 'PUT', `offer-templates/${created.id}`, {
    name: 'Specialized API Template (Updated)',
    sections: [
      { type: 'heading', level: 1, text: 'Custom Header v2' },
      { type: 'paragraph', text: 'Hello {{candidate.name}} - Welcome!' }
    ]
  });
  assert.equal(updated.name, 'Specialized API Template (Updated)');
  assert.equal(updated.version, 2);

  // 5. POST /offer-templates/:id/duplicate
  const duplicated = await service(db, recruiter, 'POST', `offer-templates/${created.id}/duplicate`, {});
  assert.equal(duplicated.name, 'Specialized API Template (Updated) (Copy)');
  assert.equal(duplicated.status, 'draft');

  // 6. POST /offer-templates/:id/status
  const statusRes = await service(db, recruiter, 'POST', `offer-templates/${created.id}/status`, { is_default: 1 });
  assert.equal(statusRes.is_default, true);

  // 7. POST /offer-templates/:id/preview
  const preview = await service(db, recruiter, 'POST', `offer-templates/${created.id}/preview`, {});
  assert.ok(preview.totalPages >= 1);
  assert.ok(preview.pdfBase64);

  // 8. POST /offer-letter-assets
  const asset = await service(db, recruiter, 'POST', 'offer-letter-assets', {
    name: 'PNG Logo Header',
    filename: 'test.png',
    fileBase64: VALID_PNG_BUFFER.toString('base64'),
    scaling: 'fit',
    pageTarget: 'first_page'
  });
  assert.ok(asset.id);
  assert.equal(asset.format, 'png');
  assert.equal(asset.name, 'PNG Logo Header');

  // 9. GET /offer-letter-assets (listing assets)
  const assetsList = await service(db, recruiter, 'GET', 'offer-letter-assets');
  assert.ok(Array.isArray(assetsList));
  assert.equal(assetsList.length, 1);
  assert.equal(assetsList[0].id, asset.id);
  assert.equal(assetsList[0].name, 'PNG Logo Header');
  assert.equal(assetsList[0].scaling_mode, 'fit');
  assert.equal(assetsList[0].page_target, 'first_page');

  // 10. GET /offer-letter-assets/:id (raw download)
  const rawAsset = await service(db, recruiter, 'GET', `offer-letter-assets/${asset.id}`);
  assert.equal(rawAsset.isRaw, true);
  assert.equal(rawAsset.contentType, 'image/png');

  // 11. DELETE /offer-letter-assets/:id
  const delRes = await service(db, recruiter, 'DELETE', `offer-letter-assets/${asset.id}`);
  assert.equal(delRes.success, true);
  const assetsAfterDelete = await service(db, recruiter, 'GET', 'offer-letter-assets');
  assert.equal(assetsAfterDelete.length, 0);
});

