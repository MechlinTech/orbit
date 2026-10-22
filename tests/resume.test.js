import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { service } from '../src/service.js';
import { ResumeAdapter } from '../src/adapters.js';
import { ResumeStorageManager } from '../src/resume/storage.js';
import { SCAN_STATUS, AntivirusScanner } from '../src/resume/scanner.js';
import { validateUpload, parsePdf, parseDocx } from '../src/resume/parser.js';
import { fixture, testConfig, user } from './helpers.js';

function createZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const contentBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const flag = file.flag || 0;
    const method = file.method !== undefined ? file.method : 8;
    const compressed = method === 8 ? zlib.deflateRawSync(contentBuf) : contentBuf;

    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flag, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(file.uncompressedSize !== undefined ? file.uncompressedSize : contentBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, compressed);

    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flag, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(0, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(file.uncompressedSize !== undefined ? file.uncompressedSize : contentBuf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    nameBuf.copy(ch, 46);

    centralHeaders.push(ch);
    offset += lh.length + compressed.length;
  }

  const cdTotalSize = centralHeaders.reduce((acc, h) => acc + h.length, 0);
  const cdOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdTotalSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

function createTestPdf(textContent = 'Alex Rivera Senior Engineer\nEmail: alex@example.com\nPhone: +1 555-432-1098') {
  const streamContent = `BT\n/F1 12 Tf\n72 712 Td\n(${textContent.replace(/[()\\]/g, '\\$&')}) Tj\nET`;
  const streamBuf = zlib.deflateSync(Buffer.from(streamContent));
  const pdfHeader = '%PDF-1.4\n';
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  const obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n';
  const obj4Header = `4 0 obj\n<< /Length ${streamBuf.length} /Filter /FlateDecode >>\nstream\n`;
  const obj4Footer = '\nendstream\nendobj\n';
  const obj5 = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  return Buffer.concat([
    Buffer.from(pdfHeader + obj1 + obj2 + obj3 + obj4Header),
    streamBuf,
    Buffer.from(obj4Footer + obj5 + 'xref\n0 6\n0000000000 65535 f \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n500\n%%EOF\n')
  ]);
}

function createImageOnlyPdf() {
  const pdfHeader = '%PDF-1.4\n';
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  const obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n';
  const streamContent = 'q 100 0 0 100 0 0 cm /Im1 Do Q';
  const streamBuf = zlib.deflateSync(Buffer.from(streamContent));
  const obj4Header = `4 0 obj\n<< /Length ${streamBuf.length} /Filter /FlateDecode >>\nstream\n`;
  const obj4Footer = '\nendstream\nendobj\n';
  const obj5 = '5 0 obj\n<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>\nendobj\n';
  return Buffer.concat([
    Buffer.from(pdfHeader + obj1 + obj2 + obj3 + obj4Header),
    streamBuf,
    Buffer.from(obj4Footer + obj5 + 'xref\n0 6\n0000000000 65535 f \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n500\n%%EOF\n')
  ]);
}

function createTestDocx({
  paragraphs = ['Taylor Brooks Staff Engineer', 'Contact: taylor@example.com or +1 555-777-8888'],
  tableRows = [['Skill', 'Level'], ['Python', 'Expert'], ['Node.js', 'Advanced']]
} = {}) {
  const pXml = paragraphs.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  const tXml = tableRows.length ? `<w:tbl>${tableRows.map(r => `<w:tr>${r.map(c => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : '';
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${pXml}${tXml}</w:body></w:document>`;
  return createZip([
    { name: '[Content_Types].xml', content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>' },
    { name: 'word/document.xml', content: docXml }
  ]);
}

test('PDF parser: extracts readable text and character count', () => {
  const pdf = createTestPdf('Avery Chen Principal Architect\n10 years experience in distributed systems');
  const res = parsePdf(pdf);
  assert.equal(res.format, 'pdf');
  assert.ok(res.text.includes('Avery Chen Principal Architect'));
  assert.ok(res.text.includes('10 years experience'));
  assert.equal(res.ocrRequired, false);
  assert.equal(res.warnings.length, 0);
});

test('PDF parser: detects image-only PDF and reports OCR is unsupported', () => {
  const imagePdf = createImageOnlyPdf();
  const res = parsePdf(imagePdf);
  assert.equal(res.format, 'pdf');
  assert.equal(res.ocrRequired, true);
  assert.equal(res.text, '');
  assert.ok(res.warnings[0].includes('OCR, which is not supported in this phase'));
});

test('DOCX parser: extracts paragraphs and table content', () => {
  const docx = createTestDocx({
    paragraphs: ['Morgan Vance Lead QA Engineer', 'Experience with Playwright and Node.js'],
    tableRows: [['Role', 'Company'], ['Senior SDET', 'TechCorp']]
  });
  const res = parseDocx(docx);
  assert.equal(res.format, 'docx');
  assert.ok(res.text.includes('Morgan Vance Lead QA Engineer'));
  assert.ok(res.text.includes('Experience with Playwright and Node.js'));
  assert.ok(res.text.includes('Senior SDET\tTechCorp'));
});

test('Validation: rejects empty files, oversized files, invalid extension and magic bytes', () => {
  assert.throws(() => validateUpload({ buffer: Buffer.alloc(0), filename: 'resume.pdf' }), e => e.status === 400 && e.message.includes('empty'));
  assert.throws(() => validateUpload({ buffer: Buffer.alloc(20), filename: 'resume.exe' }), e => e.status === 400 && e.message.includes('Unsupported file format'));
  assert.throws(() => validateUpload({ buffer: Buffer.alloc(20), filename: 'resume.doc' }), e => e.status === 400 && e.message.includes('Legacy .doc'));
  assert.throws(() => validateUpload({ buffer: Buffer.alloc(20), filename: 'resume.docm' }), e => e.status === 400 && e.message.includes('macros'));
  assert.throws(() => validateUpload({ buffer: Buffer.alloc(2000), filename: 'resume.pdf', maxSizeBytes: 1000 }), e => e.status === 413);

  // Mismatched magic: PDF extension with non-PDF bytes
  assert.throws(() => validateUpload({ buffer: Buffer.from('NOT A PDF FILE BUFFER CONTENT HERE'), filename: 'resume.pdf' }), e => e.status === 400 && e.message.includes('does not match'));

  // Valid PDF magic
  const valid = validateUpload({ buffer: createTestPdf('Test'), filename: 'My Resume (1).pdf', mimeType: 'application/pdf' });
  assert.equal(valid.valid, true);
  assert.equal(valid.format, 'pdf');
  assert.equal(valid.filename, 'My Resume (1).pdf');
});

test('DOCX security: rejects macro-enabled documents, password protection, and zip bombs', () => {
  // 1. Password protected DOCX
  const pwDocx = createZip([
    { name: '[Content_Types].xml', content: '<xml/>', flag: 1 },
    { name: 'word/document.xml', content: '<xml/>', flag: 1 }
  ]);
  assert.throws(() => parseDocx(pwDocx), e => e.status === 400 && e.message.includes('Password-protected'));

  // 2. Macro document (vbaProject.bin)
  const macroDocx = createZip([
    { name: '[Content_Types].xml', content: '<xml/>' },
    { name: 'word/document.xml', content: '<w:document/>' },
    { name: 'word/vbaProject.bin', content: 'fake vba code' }
  ]);
  assert.throws(() => parseDocx(macroDocx), e => e.status === 400 && e.message.includes('macros'));

  // 3. Path traversal in entry name
  const traversalDocx = createZip([
    { name: '../../etc/passwd', content: 'root:x' },
    { name: 'word/document.xml', content: '<w:document/>' }
  ]);
  assert.throws(() => parseDocx(traversalDocx), e => e.status === 400 && e.message.includes('path traversal'));

  // 4. Excessive uncompressed size claim (zip bomb)
  const bombDocx = createZip([
    { name: 'word/document.xml', content: Buffer.alloc(100), uncompressedSize: 20 * 1024 * 1024 }
  ]);
  assert.throws(() => parseDocx(bombDocx), e => e.status === 400 && e.message.includes('zip bomb'));
});

test('Antivirus: detects infected files, handles scanner unavailable when required, and cleans quarantine', async () => {
  const tmpFolder = mkdtempSync(join(tmpdir(), 'orbit-resume-av-'));
  try {
    const storage = new ResumeStorageManager({ baseDir: tmpFolder });

    // Mock scanner that detects infected file
    class InfectedScanner extends AntivirusScanner {
      async scan() {
        return { status: SCAN_STATUS.INFECTED, virusName: 'Eicar-Test-Signature', message: 'Malware detected: Eicar-Test-Signature' };
      }
    }

    const adapterInfected = new ResumeAdapter({
      enabled: true,
      storage,
      scanner: new InfectedScanner(),
      antivirusRequired: true
    });

    const pdf = createTestPdf('Test candidate');
    await assert.rejects(
      adapterInfected.processUpload({ buffer: pdf, filename: 'infected.pdf' }),
      e => e.status === 400 && e.message.includes('Malware detected')
    );

    // Verify quarantined file was purged
    const quarantineFiles = existsSync(storage.quarantineDir);
    assert.ok(quarantineFiles);

    // Mock scanner that is unavailable
    class OfflineScanner extends AntivirusScanner {
      async scan() {
        return { status: SCAN_STATUS.SCANNER_UNAVAILABLE, message: 'ClamAV daemon offline' };
      }
    }

    const adapterOffline = new ResumeAdapter({
      enabled: true,
      storage,
      scanner: new OfflineScanner(),
      antivirusRequired: true
    });

    await assert.rejects(
      adapterOffline.processUpload({ buffer: pdf, filename: 'offline.pdf' }),
      e => e.status === 503 && e.message.includes('Antivirus scanner is required')
    );
  } finally {
    rmSync(tmpFolder, { recursive: true, force: true });
  }
});

test('Full workflow: upload resume, extract contact info, attach to new candidate, and verify audit log', async () => {
  const tmpFolder = mkdtempSync(join(tmpdir(), 'orbit-resume-wf-'));
  try {
    const f = fixture();
    const c = testConfig();
    c.maxResumeSizeBytes = 5 * 1024 * 1024;
    c.antivirusRequired = false;

    // Use custom storage in tmpFolder
    const pdf = createTestPdf('Casey Jordan Staff Engineer\nEmail: casey.jordan@example.com\nPhone: +1 555-234-5678\nSkills: Distributed Systems, Go, SQLite');

    // 1. Unauthorized user cannot upload
    const employee = user(f.db, 'Employee/Referral');
    assert.throws(
      () => service(f.db, employee, 'POST', 'resume/upload', { buffer: pdf, filename: 'casey.pdf' }, new URLSearchParams(), c),
      e => e.status === 403
    );

    // 2. Recruiter uploads PDF
    const uploadRes = await service(f.db, f.recruiter, 'POST', 'resume/upload', {
      buffer: pdf,
      filename: 'casey_resume.pdf',
      mimeType: 'application/pdf'
    }, new URLSearchParams(), c);

    assert.ok(uploadRes.resume_id);
    assert.equal(uploadRes.filename, 'casey_resume.pdf');
    assert.equal(uploadRes.format, 'pdf');
    assert.equal(uploadRes.email, 'casey.jordan@example.com');
    assert.equal(uploadRes.phone, '+1 555-234-5678');
    assert.ok(uploadRes.text.includes('Casey Jordan'));

    // 3. Create candidate referencing resume_id
    const candRes = service(f.db, f.recruiter, 'POST', 'candidates', {
      name: 'Casey Jordan',
      email: uploadRes.email,
      phone: uploadRes.phone,
      team: 'Engineering',
      skills: ['Go', 'SQLite'],
      resume_text: uploadRes.text,
      source: 'Direct',
      resume_id: uploadRes.resume_id
    }, new URLSearchParams(), c);

    assert.ok(candRes.id);
    assert.equal(candRes.name, 'Casey Jordan');
    assert.ok(candRes.resume);
    assert.equal(candRes.resume.filename, 'casey_resume.pdf');
    assert.equal(candRes.resume.file_format, 'pdf');

    // 4. Fetch candidate details and verify attached resume metadata
    const fetched = service(f.db, f.recruiter, 'GET', `candidates/${candRes.id}`, {}, new URLSearchParams(), c);
    assert.equal(fetched.resume.id, uploadRes.resume_id);
    assert.equal(fetched.resume.filename, 'casey_resume.pdf');

    // 5. Verify audit logs
    const uploadAudit = f.db.prepare("SELECT * FROM audit WHERE event='resume.uploaded'").get();
    assert.ok(uploadAudit);
    assert.equal(uploadAudit.actor, f.recruiter.id);
    assert.equal(uploadAudit.target, uploadRes.resume_id);

    const attachAudit = f.db.prepare("SELECT * FROM audit WHERE event='candidate.resume_attached'").get();
    assert.ok(attachAudit);
    assert.equal(attachAudit.target, candRes.id);

    // 6. Candidate update and resume replacement with DOCX
    const docx = createTestDocx({
      paragraphs: ['Casey Jordan Principal Architect', 'Email: casey.jordan@example.com Phone: +1 555-234-5678', 'Updated experience with Cloud & Kubernetes'],
      tableRows: [['Architecture', 'Cloud']]
    });

    const uploadDocx = await service(f.db, f.recruiter, 'POST', 'resume/upload', {
      buffer: docx,
      filename: 'casey_updated.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }, new URLSearchParams(), c);

    const updated = service(f.db, f.recruiter, 'PUT', `candidates/${candRes.id}`, {
      resume_text: uploadDocx.text,
      resume_id: uploadDocx.resume_id
    }, new URLSearchParams(), c);

    assert.equal(updated.resume.filename, 'casey_updated.docx');
    assert.equal(updated.resume.file_format, 'docx');

    const updateAudit = f.db.prepare("SELECT * FROM audit WHERE event='candidate.resume_updated'").get();
    assert.ok(updateAudit);
    assert.equal(updateAudit.target, candRes.id);

    f.db.close();
  } finally {
    rmSync(tmpFolder, { recursive: true, force: true });
  }
});

test('Failed uploads preserve existing candidate data and prevent duplicates', async () => {
  const f = fixture();
  const c = testConfig();

  // Create initial candidate
  const cand = service(f.db, f.recruiter, 'POST', 'candidates', {
    name: 'Existing Candidate',
    email: 'existing@example.com',
    phone: '+1 555-111-2222',
    team: 'Engineering',
    skills: ['JavaScript'],
    resume_text: 'Original safe resume text.',
    source: 'Referral'
  }, new URLSearchParams(), c);

  assert.equal(cand.resume_text, 'Original safe resume text.');

  // Attempt upload of invalid/corrupted file
  await assert.rejects(
    service(f.db, f.recruiter, 'POST', 'resume/upload', {
      buffer: Buffer.from('corrupted non-pdf content'),
      filename: 'corrupted.pdf'
    }, new URLSearchParams(), c),
    e => e.status === 400
  );

  // Candidate data remains completely unaffected
  const refreshed = service(f.db, f.recruiter, 'GET', `candidates/${cand.id}`, {}, new URLSearchParams(), c);
  assert.equal(refreshed.resume_text, 'Original safe resume text.');
  assert.equal(refreshed.name, 'Existing Candidate');

  // Verify rejection audit
  const rejectAudit = f.db.prepare("SELECT * FROM audit WHERE event='resume.upload_rejected'").get();
  assert.ok(rejectAudit);

  // Existing plain-text extraction still works
  const plainParsed = service(f.db, f.recruiter, 'POST', 'resume/parse', {
    text: 'Reach me at plain@example.com or +1 555-999-0000'
  }, new URLSearchParams(), c);
  assert.equal(plainParsed.email, 'plain@example.com');
  assert.equal(plainParsed.phone, '+1 555-999-0000');

  f.db.close();
});
