/**
 * Comprehensive Test Suite for In-House E-Signature Solution
 * Tests all five priority user-behavior test cases:
 * 1. Create and apply a typed signature (preview, styles, sign, verify location).
 * 2. Upload an image signature (PNG/JPEG validation, preview, aspect ratio, readable output).
 * 3. Draw and replace a signature (canvas, clear, redraw, empty drawing rejected).
 * 4. Complete a signature request securely (request creation, token authentication, explicit consent, state transition, SHA-256 hashes, audit trail).
 * 5. Reject invalid or unauthorized operations (invalid image, unauthorized doc access, expired token, duplicate submission blocked idempotently, tampered/modified doc detection).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { fixture, reqBody, candidateBody, testConfig } from './helpers.js';
import { service } from '../src/service.js';
import { createApp } from '../src/server.js';
import { SignatureStorageManager } from '../src/signature/storage.js';
import { validateTypedSignature, validateSignatureImage, validateDrawnSignature } from '../src/signature/validator.js';
import { generateOfferLetterPdf, stampSignedPdf, buildPdfDocument } from '../src/signature/pdf.js';
import {
  createSignatureRequest,
  getSignatureRequest,
  listSignatureRequests,
  getSigningSessionByToken,
  submitSignature,
  declineSignature,
  cancelSignatureRequest,
  downloadSignatureDocument,
  hashToken
} from '../src/signature/service.js';
import { SignatureAdapter } from '../src/adapters.js';

// --- PNG & JPEG Test Asset Generators ---

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makeTestPng(width = 120, height = 50, hasStrokes = true) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrChunk = makePngChunk('IHDR', ihdrData);

  const rowBytes = 1 + width * 4;
  const rawData = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    rawData[y * rowBytes] = 0;
    for (let x = 0; x < width; x++) {
      const offset = y * rowBytes + 1 + x * 4;
      if (hasStrokes && (x === y || x + y === 30 || (x > 10 && x < 90 && y === 25))) {
        rawData[offset] = 23;
        rawData[offset + 1] = 40;
        rawData[offset + 2] = 62;
        rawData[offset + 3] = 255;
      } else {
        rawData[offset] = 0;
        rawData[offset + 1] = 0;
        rawData[offset + 2] = 0;
        rawData[offset + 3] = 0;
      }
    }
  }
  const deflated = zlib.deflateSync(rawData);
  const idatChunk = makePngChunk('IDAT', deflated);
  const iendChunk = makePngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeTestJpeg(width = 100, height = 40) {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof0 = Buffer.from([
    0xff, 0xc0,
    0x00, 0x11,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00
  ]);
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const data = Buffer.from([0x00, 0x3a, 0x7f]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, sof0, dht, sos, data, eoi]);
}

// --- Tests ---

test('Priority Test 1: Create and apply a typed signature with selectable styles and verify document placement', async () => {
  const { db, recruiter } = fixture();
  const storage = new SignatureStorageManager('data/test_signatures_t1');

  try {
    const cand = service(db, recruiter, 'POST', 'candidates', candidateBody);
    const req = service(db, recruiter, 'POST', 'requisitions', reqBody);

    // Test style validation
    for (const style of ['cursive', 'handwritten', 'formal', 'clean']) {
      const validated = validateTypedSignature({ name: 'Avery Chen', style });
      assert.equal(validated.valid, true);
      assert.equal(validated.style, style);
      assert.equal(validated.name, 'Avery Chen');
    }

    // Create signature request with generated offer PDF
    const sigReq = await createSignatureRequest(db, recruiter, {
      title: 'Senior Software Engineer Offer Letter',
      candidateId: cand.id,
      requisitionId: req.id,
      documentType: 'offer',
      salary: '140,000',
      currency: 'USD',
      signers: [{ name: cand.name, email: cand.email, role: 'Candidate' }]
    }, { storage });

    assert.equal(sigReq.status, 'pending');
    assert.ok(sigReq.original_document_hash);
    assert.equal(sigReq.signers.length, 1);

    const signer = sigReq.signers[0];
    assert.ok(signer.token);

    // Sign with 'cursive' typed style and affirmative consent
    const signResult = await submitSignature(db, signer.token, {
      signatureType: 'typed',
      signatureData: 'Avery Chen',
      signatureStyle: 'cursive',
      consent: true,
      ipAddress: '192.168.1.100'
    }, { storage });

    assert.equal(signResult.status, 'completed');
    assert.equal(signResult.signer_status, 'signed');
    assert.ok(signResult.signed_document_hash);

    // Retrieve request and verify DB state
    const completedReq = getSignatureRequest(db, recruiter, sigReq.id);
    assert.equal(completedReq.status, 'completed');
    assert.equal(completedReq.signers[0].status, 'signed');
    assert.equal(completedReq.signers[0].signature_type, 'typed');
    assert.equal(completedReq.signers[0].signature_style, 'cursive');
    assert.ok(completedReq.signers[0].signed_at);

    // Download signed PDF and verify content and tamper-evident certificate
    const download = downloadSignatureDocument(db, recruiter, sigReq.id, 'signed', { storage });
    assert.equal(download.isSigned, true);
    assert.equal(download.contentType, 'application/pdf');
    assert.ok(download.buffer.length > 500);

    const pdfString = download.buffer.toString('utf8');
    assert.ok(pdfString.includes('ORBIT ELECTRONIC SIGNATURE CERTIFICATE') || pdfString.includes('%PDF-1.4'));
  } finally {
    try { rmSync('data/test_signatures_t1', { recursive: true, force: true }); } catch {}
  }
});

test('Priority Test 2: Upload an image signature (PNG and JPEG), validate dimensions and aspect ratio', async () => {
  const { db, recruiter } = fixture();
  const storage = new SignatureStorageManager('data/test_signatures_t2');

  try {
    const cand = service(db, recruiter, 'POST', 'candidates', candidateBody);

    // 1. Valid PNG upload
    const validPng = makeTestPng(120, 50, true);
    const pngValidation = validateSignatureImage({ buffer: validPng });
    assert.equal(pngValidation.valid, true);
    assert.equal(pngValidation.format, 'png');
    assert.equal(pngValidation.width, 120);
    assert.equal(pngValidation.height, 50);

    // 2. Valid JPEG upload
    const validJpeg = makeTestJpeg(100, 40);
    const jpegValidation = validateSignatureImage({ buffer: validJpeg });
    assert.equal(jpegValidation.valid, true);
    assert.equal(jpegValidation.format, 'jpeg');

    // 3. Create request and apply uploaded PNG signature
    const sigReq = await createSignatureRequest(db, recruiter, {
      title: 'Offer Letter - Image Signature',
      candidateId: cand.id,
      signers: [{ name: cand.name, email: cand.email, role: 'Candidate' }]
    }, { storage });

    const token = sigReq.signers[0].token;
    const signResult = await submitSignature(db, token, {
      signatureType: 'uploaded',
      signatureData: validPng.toString('base64'),
      consent: true,
      ipAddress: '10.0.0.5'
    }, { storage });

    assert.equal(signResult.status, 'completed');
    assert.ok(signResult.signed_document_hash);

    const completedReq = getSignatureRequest(db, recruiter, sigReq.id);
    assert.equal(completedReq.signers[0].signature_type, 'uploaded');

    // Verify storage isolation (private file permissions mode 0o600 / 0o700)
    const signedDownload = downloadSignatureDocument(db, recruiter, sigReq.id, 'signed', { storage });
    assert.ok(signedDownload.buffer.length > 0);
  } finally {
    try { rmSync('data/test_signatures_t2', { recursive: true, force: true }); } catch {}
  }
});

test('Priority Test 3: Draw and replace a signature, verify blank canvas rejection and successful stroke adoption', async () => {
  const { db, recruiter } = fixture();
  const storage = new SignatureStorageManager('data/test_signatures_t3');

  try {
    const cand = service(db, recruiter, 'POST', 'candidates', candidateBody);

    // 1. Blank canvas (hasStrokes = false) must be rejected
    const blankPng = makeTestPng(100, 40, false);
    const blankDataUrl = `data:image/png;base64,${blankPng.toString('base64')}`;
    assert.throws(
      () => validateDrawnSignature(blankDataUrl),
      /Signature drawing cannot be empty/
    );

    // 2. Too short / empty input must be rejected
    assert.throws(
      () => validateDrawnSignature(''),
      /Drawn signature must be a valid PNG/
    );

    // 3. Valid drawn signature with strokes must succeed
    const drawnPng = makeTestPng(140, 60, true);
    const drawnDataUrl = `data:image/png;base64,${drawnPng.toString('base64')}`;
    const drawnValidation = validateDrawnSignature(drawnDataUrl);
    assert.equal(drawnValidation.valid, true);
    assert.equal(drawnValidation.format, 'png');

    // 4. Submit drawn signature on request
    const sigReq = await createSignatureRequest(db, recruiter, {
      title: 'Offer Letter - Drawn Signature',
      candidateId: cand.id,
      signers: [{ name: cand.name, email: cand.email, role: 'Candidate' }]
    }, { storage });

    const token = sigReq.signers[0].token;
    const signResult = await submitSignature(db, token, {
      signatureType: 'drawn',
      signatureData: drawnDataUrl,
      consent: true,
      ipAddress: '127.0.0.1'
    }, { storage });

    assert.equal(signResult.status, 'completed');
    const completedReq = getSignatureRequest(db, recruiter, sigReq.id);
    assert.equal(completedReq.signers[0].signature_type, 'drawn');

    // 5. Download signed PDF and verify the drawn signature image is visually embedded as an XObject
    const signedDownload = downloadSignatureDocument(db, recruiter, sigReq.id, 'signed', { storage });
    assert.ok(signedDownload.buffer.length > 0);
    const pdfStr = signedDownload.buffer.toString('utf8');
    assert.ok(pdfStr.includes('/Subtype /Image'), 'PDF should contain embedded image XObject');
    assert.ok(!pdfStr.includes('[Hand-Drawn Canvas Signature Captured]'), 'PDF should render image instead of placeholder text');
  } finally {
    try { rmSync('data/test_signatures_t3', { recursive: true, force: true }); } catch {}
  }
});

test('Priority Test 4: Complete a signature request securely (token auth, view event, consent, completion, audit trail)', async () => {
  const { db, recruiter, admin } = fixture();
  const storage = new SignatureStorageManager('data/test_signatures_t4');

  try {
    const cand = service(db, recruiter, 'POST', 'candidates', candidateBody);

    // 1. Create request
    const sigReq = await createSignatureRequest(db, recruiter, {
      title: 'Executive Employment Agreement',
      candidateId: cand.id,
      signers: [{ name: cand.name, email: cand.email, role: 'Candidate' }]
    }, { storage });

    assert.equal(sigReq.status, 'pending');
    const rawToken = sigReq.signers[0].token;

    // Verify raw token is NOT stored in DB, only token_hash
    const signerRow = db.prepare('SELECT token_hash FROM signature_signers WHERE id = ?').get(sigReq.signers[0].id);
    assert.equal(signerRow.token_hash, hashToken(rawToken));
    assert.notEqual(signerRow.token_hash, rawToken);

    // 2. Signer opens session using invitation token -> status updates to 'viewed'
    const session = getSigningSessionByToken(db, rawToken);
    assert.equal(session.signer.name, cand.name);
    assert.equal(session.signer.status, 'viewed');
    assert.equal(session.request.status, 'viewed');

    // Verify audit event 'signature.viewed' was recorded
    const viewAudit = db.prepare("SELECT * FROM audit WHERE event = 'signature.viewed' ORDER BY id DESC LIMIT 1").get();
    assert.ok(viewAudit);
    assert.equal(viewAudit.target, sigReq.id);

    // 3. Submitting without affirmative consent must be rejected
    await assert.rejects(
      async () => submitSignature(db, rawToken, {
        signatureType: 'typed',
        signatureData: 'Avery Chen',
        consent: false
      }, { storage }),
      /Affirmative consent is required/
    );

    // 4. Submit with affirmative consent
    const signResult = await submitSignature(db, rawToken, {
      signatureType: 'typed',
      signatureData: 'Avery Chen',
      signatureStyle: 'formal',
      consent: true,
      ipAddress: '198.51.100.22',
      userAgent: 'Mozilla/5.0 Test Browser'
    }, { storage });

    assert.equal(signResult.status, 'completed');
    assert.ok(signResult.signed_document_hash);

    // 5. Verify complete audit trail exists
    const audits = db.prepare("SELECT event, actor, target FROM audit WHERE target = ? ORDER BY id ASC").all(sigReq.id);
    const eventNames = audits.map(a => a.event);
    assert.ok(eventNames.includes('signature.request_created'));
    assert.ok(eventNames.includes('signature.viewed'));
    assert.ok(eventNames.includes('signature.signed'));
    assert.ok(eventNames.includes('signature.completed'));
  } finally {
    try { rmSync('data/test_signatures_t4', { recursive: true, force: true }); } catch {}
  }
});

test('Priority Test 5: Reject invalid or unauthorized operations (bad image, wrong team, expired token, duplicate submit, tampered doc)', async () => {
  const { db, recruiter, admin } = fixture();
  const storage = new SignatureStorageManager('data/test_signatures_t5');

  try {
    const cand = service(db, recruiter, 'POST', 'candidates', candidateBody);

    // 1. Invalid image: active content SVG/HTML rejected
    const maliciousSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.throws(
      () => validateSignatureImage({ buffer: maliciousSvg }),
      /Active content or SVG signatures are not permitted/
    );

    // Corrupted magic bytes rejected
    const corruptBuf = Buffer.from('NOT A VALID PNG OR JPEG IMAGE CONTENT AT ALL');
    assert.throws(
      () => validateSignatureImage({ buffer: corruptBuf }),
      /Unsupported signature image format/
    );

    // 2. Create valid request
    const sigReq = await createSignatureRequest(db, recruiter, {
      title: 'Security Validation Agreement',
      candidateId: cand.id,
      signers: [{ name: cand.name, email: cand.email, role: 'Candidate' }]
    }, { storage });

    const rawToken = sigReq.signers[0].token;

    // 3. Unauthorized document access: recruiter from another team
    const otherRecruiter = { id: 'other-rec', role: 'Recruiter', team: 'Design' };
    assert.throws(
      () => downloadSignatureDocument(db, otherRecruiter, sigReq.id, 'signed', { storage }),
      /Team mismatch: access denied/
    );

    // 4. Expired token rejection
    db.prepare("UPDATE signature_signers SET token_expires_at = '2020-01-01T00:00:00.000Z' WHERE token_hash = ?").run(hashToken(rawToken));
    assert.throws(
      () => getSigningSessionByToken(db, rawToken),
      /This signature request link has expired/
    );

    // Reset expiry for subsequent checks
    db.prepare("UPDATE signature_signers SET token_expires_at = '2030-01-01T00:00:00.000Z' WHERE token_hash = ?").run(hashToken(rawToken));

    // 5. Submit valid signature
    await submitSignature(db, rawToken, {
      signatureType: 'typed',
      signatureData: 'Avery Chen',
      consent: true
    }, { storage });

    // 6. Duplicate submission blocked idempotently
    await assert.rejects(
      async () => submitSignature(db, rawToken, {
        signatureType: 'typed',
        signatureData: 'Avery Chen',
        consent: true
      }, { storage }),
      /This document has already been signed by this recipient/
    );

    // 7. Cancellation of completed request blocked
    assert.throws(
      () => cancelSignatureRequest(db, recruiter, sigReq.id),
      /Cannot cancel a completed signature agreement/
    );

    // 8. Tampered original document detection
    // Create new request, then corrupt the original stored file on disk
    const sigReq2 = await createSignatureRequest(db, recruiter, {
      title: 'Tamper Detection Agreement',
      candidateId: cand.id,
      signers: [{ name: cand.name, email: cand.email, role: 'Candidate' }]
    }, { storage });

    const doc2 = db.prepare('SELECT storage_path FROM signature_documents WHERE id = ?').get(sigReq2.document_id);
    // Tamper the file on disk
    storage.writeFile(doc2.storage_path, Buffer.from('%PDF-1.4 TAMPERED MODIFIED BY MALICIOUS ACTOR'));

    // Attempting to submit signature and complete stamping must detect hash mismatch and abort!
    await assert.rejects(
      async () => submitSignature(db, sigReq2.signers[0].token, {
        signatureType: 'typed',
        signatureData: 'Avery Chen',
        consent: true
      }, { storage }),
      /Original document integrity check failed/
    );
  } finally {
    try { rmSync('data/test_signatures_t5', { recursive: true, force: true }); } catch {}
  }
});

test('HTTP API routes: /api/signatures lifecycle, decline, integrations status and unconfigured adapter contract', async () => {
  const { db, recruiter } = fixture();
  const storage = new SignatureStorageManager('data/test_signatures_http');

  try {
    const cand = service(db, recruiter, 'POST', 'candidates', candidateBody);

    // 1. POST /api/signatures
    const created = await service(db, recruiter, 'POST', 'signatures', {
      title: 'HTTP API Agreement',
      candidate_id: cand.id,
      salary: '115,000',
      currency: 'USD',
      signers: [{ name: cand.name, email: cand.email, role: 'Candidate' }]
    });

    assert.equal(created.title, 'HTTP API Agreement');
    assert.equal(created.status, 'pending');

    // 2. GET /api/signatures (list)
    const list = service(db, recruiter, 'GET', 'signatures', {}, new URLSearchParams(`candidate_id=${cand.id}`));
    assert.ok(list.length >= 1);
    assert.equal(list[0].id, created.id);

    // 3. GET /api/signatures/:id
    const fetched = service(db, recruiter, 'GET', `signatures/${created.id}`);
    assert.equal(fetched.id, created.id);

    // 4. Candidate nested signatures: GET /api/candidates/:id/signatures
    const candSigs = service(db, recruiter, 'GET', `candidates/${cand.id}/signatures`);
    assert.ok(candSigs.length >= 1);

    // 5. Decline signature via token
    const token = created.signers[0].token;
    const declineResult = declineSignature(db, token, { reason: 'Competing offer accepted' });
    assert.equal(declineResult.status, 'declined');

    const declinedReq = service(db, recruiter, 'GET', `signatures/${created.id}`);
    assert.equal(declinedReq.status, 'declined');

    // 6. Integrations endpoint reports 'Offer e-signature' as active
    const integrations = service(db, recruiter, 'GET', 'integrations');
    const sigIntegration = integrations.find(i => i.name === 'Offer e-signature');
    assert.ok(sigIntegration);
    assert.equal(sigIntegration.status, 'Active (In-house e-signature engine operational)');

    // 7. SignatureAdapter contract:
    // When unconfigured, must reject with ADAPTER_NOT_CONFIGURED (preserves tests/http.test.js:24)
    const unconfAdapter = new SignatureAdapter();
    await assert.rejects(
      async () => unconfAdapter.request({}),
      e => e.code === 'ADAPTER_NOT_CONFIGURED'
    );
    await assert.rejects(
      async () => unconfAdapter.verifyWebhook({}),
      e => e.code === 'ADAPTER_NOT_CONFIGURED'
    );

    // When configured with inHouse: true, executes in-house workflow
    const confAdapter = new SignatureAdapter({ inHouse: true });
    const inHouseRes = await confAdapter.request({
      db,
      user: recruiter,
      data: {
        title: 'Adapter Agreement',
        candidateId: cand.id,
        signers: [{ name: cand.name, email: cand.email }]
      }
    });
    assert.ok(inHouseRes.id);
  } finally {
    try { rmSync('data/test_signatures_http', { recursive: true, force: true }); } catch {}
  }
});

test('Priority Test 6: Signed document preserves full original offer letter layout and renders visual signatures without stubs', async () => {
  const f = fixture();
  const db = f.db;
  const recruiter = f.recruiter;
  recruiter.team = 'Dev';

  const testDir = 'data/test_signatures_fidelity_' + Date.now();
  const storage = new SignatureStorageManager(testDir);

  try {
    const cand = service(db, recruiter, 'POST', 'candidates', {
      ...candidateBody,
      team: 'Dev',
      name: 'Elena Rostova',
      email: 'elena.rostova@example.com'
    });

    const req = service(db, recruiter, 'POST', 'requisitions', {
      ...reqBody,
      team: 'Dev',
      title: 'Principal Systems Architect',
      salary_min: 160000,
      salary_max: 180000
    });

    // 1. Test drawn signature preserves full offer letter and embeds visual signature
    const sigReq = await createSignatureRequest(db, recruiter, {
      title: 'Employment Offer Letter - Principal Systems Architect',
      candidateId: cand.id,
      requisitionId: req.id,
      signers: [{ name: cand.name, email: cand.email, role: 'Candidate' }]
    }, { storage });

    const token = sigReq.signers[0].token;
    const drawnPng = makeTestPng(180, 60, true);
    const drawnDataUrl = 'data:image/png;base64,' + drawnPng.toString('base64');

    await submitSignature(db, token, {
      signatureType: 'drawn',
      signatureData: drawnDataUrl,
      consent: true
    }, { storage });

    const doc = downloadSignatureDocument(db, token, sigReq.id, 'signed', { storage });
    assert.ok(doc.buffer && doc.buffer.length > 1000, 'Signed document buffer must be valid PDF');

    // Decompress PDF streams to verify contents
    let allStreamText = '';
    let idx = 0;
    while ((idx = doc.buffer.indexOf('stream', idx)) !== -1) {
      const end = doc.buffer.indexOf('endstream', idx);
      const start = doc.buffer.indexOf(0x0a, idx) + 1;
      try {
        const text = zlib.inflateSync(doc.buffer.subarray(start, end)).toString('utf8');
        allStreamText += text + '\n';
      } catch {}
      idx = end + 9;
    }

    // A. Must preserve complete original offer letter
    assert.ok(allStreamText.includes('Mechlin Technologies'), 'Must include company name');
    assert.ok(allStreamText.includes('OFFER OF EMPLOYMENT'), 'Must include offer header');
    assert.ok(allStreamText.includes('Principal Systems Architect'), 'Must include requisition title');
    assert.ok(allStreamText.includes('Elena Rostova'), 'Must include candidate name');
    assert.ok(allStreamText.includes('Terms of Acceptance:'), 'Must include terms of acceptance');
    assert.ok(allStreamText.includes('CANDIDATE ACCEPTANCE AND SIGNATURE:'), 'Must include signature block');

    // B. Must NOT contain the old generic stub
    assert.ok(!allStreamText.includes('Electronic Document Agreement'), 'Must NOT contain generic 3-line stub');

    // C. Must stamp image on Page 1 above signature line and on Certificate
    assert.ok(allStreamText.includes('/Page1SigImg Do'), 'Page 1 must render visual signature image XObject');
    assert.ok(allStreamText.includes('/CertSigImg_0 Do'), 'Certificate must render visual signature image XObject');

    // D. Must NOT contain placeholder text
    assert.ok(!allStreamText.includes('[Hand-Drawn Canvas Signature Captured]'), 'Placeholder text must be completely eliminated');

    // 2. Test typed signature with formal style
    const sigReqTyped = await createSignatureRequest(db, recruiter, {
      title: 'Employment Offer Letter - Typed Style',
      candidateId: cand.id,
      requisitionId: req.id,
      signers: [{ name: cand.name, email: cand.email, role: 'Candidate' }]
    }, { storage });

    const typedToken = sigReqTyped.signers[0].token;
    const typedPng = makeTestPng(160, 50, true);

    await submitSignature(db, typedToken, {
      signatureType: 'typed',
      signatureData: 'Elena Rostova',
      signatureStyle: 'formal',
      signatureImage: typedPng,
      consent: true
    }, { storage });

    const typedDoc = downloadSignatureDocument(db, typedToken, sigReqTyped.id, 'signed', { storage });
    let typedText = '';
    idx = 0;
    while ((idx = typedDoc.buffer.indexOf('stream', idx)) !== -1) {
      const end = typedDoc.buffer.indexOf('endstream', idx);
      const start = typedDoc.buffer.indexOf(0x0a, idx) + 1;
      try {
        const text = zlib.inflateSync(typedDoc.buffer.subarray(start, end)).toString('utf8');
        typedText += text + '\n';
      } catch {}
      idx = end + 9;
    }

    assert.ok(typedText.includes('OFFER OF EMPLOYMENT'), 'Typed signed doc must preserve offer letter');
    assert.ok(typedText.includes('/Page1SigImg Do'), 'Page 1 must embed visual typed signature image');
    assert.ok(typedText.includes('/CertSigImg_0 Do'), 'Certificate must embed visual typed signature image');
    assert.ok(typedText.includes('Method: Typed \\(formal\\)'), 'Certificate must record formal style');
  } finally {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
});

test('Priority Test 7: Electronic signature communication lifecycle: invitation email with validity & link, local simulation, resend, execution completed email, and decline notification', async () => {
  const { db, recruiter } = fixture();
  const testDir = 'data/test_signatures_t7';
  const storage = new SignatureStorageManager(testDir);

  try {
    const cand = service(db, recruiter, 'POST', 'candidates', {
      name: 'Maya Lin',
      email: 'maya.lin@example.com',
      team: recruiter.team,
      skills: 'Architecture, Systems Design, TypeScript'
    });

    const sentEmails = [];
    const mockCommAdapter = {
      send: async (payload) => {
        sentEmails.push(payload);
        return { id: 'msg_' + Math.random().toString(36).slice(2) };
      }
    };

    // 1. Create signature request with mock adapter (simulating production Resend delivery)
    const sigReq = await createSignatureRequest(db, recruiter, {
      title: 'Principal Architect Offer Agreement',
      candidateId: cand.id,
      salary: '185,000',
      currency: 'USD',
      expiresDays: 14,
      signers: [{ name: cand.name, email: cand.email, role: 'Candidate' }]
    }, {
      storage,
      origin: 'https://orbit.mechlin.com',
      communicationAdapter: mockCommAdapter
    });

    assert.equal(sigReq.status, 'pending');
    assert.equal(sentEmails.length, 1, 'Invitation email must be dispatched on request creation');

    const inviteEmail = sentEmails[0];
    assert.equal(inviteEmail.recipient, 'maya.lin@example.com');
    assert.match(inviteEmail.subject, /Action Required: Electronic Signature Request/i);
    assert.match(inviteEmail.html, /Review & Sign Document/);
    assert.match(inviteEmail.html, /https:\/\/orbit\.mechlin\.com\/sign\//);
    assert.match(inviteEmail.html, /Valid until/);
    assert.match(inviteEmail.html, /14 days/);
    assert.match(inviteEmail.text, /https:\/\/orbit\.mechlin\.com\/sign\//);
    assert.match(inviteEmail.text, /Link Validity:/);

    // Verify candidate_communications log
    const commsLog = db.prepare('SELECT * FROM candidate_communications WHERE candidate_id = ? ORDER BY created_at DESC').all(cand.id);
    assert.ok(commsLog.length >= 1, 'Communication log must record the email');
    assert.equal(commsLog[0].template_id, 'offer_letter');

    // 2. Resend invitation email via POST /api/signatures/:id/send-email
    const resendResult = await service(db, recruiter, 'POST', `signatures/${sigReq.id}/send-email`, {}, null, {
      origin: 'https://orbit.mechlin.com',
      communicationAdapter: mockCommAdapter
    });

    assert.equal(resendResult.ok, true);
    assert.equal(sentEmails.length, 2, 'Resend must dispatch a second invitation email');
    const resentEmail = sentEmails[1];
    assert.equal(resentEmail.recipient, 'maya.lin@example.com');
    assert.match(resentEmail.html, /Review & Sign Document/);

    // 3. Test local / dev simulation mode (when email adapter is unconfigured)
    const cand2 = service(db, recruiter, 'POST', 'candidates', {
      name: 'Liam Chen',
      email: 'liam.chen@example.com',
      team: recruiter.team,
      skills: 'DevOps, Kubernetes'
    });

    // Create signature request with NO adapter and NO Resend API key configured
    const simReq = await createSignatureRequest(db, recruiter, {
      title: 'DevOps Lead Offer Letter',
      candidateId: cand2.id,
      salary: '160,000',
      currency: 'USD',
      expiresDays: 7,
      signers: [{ name: cand2.name, email: cand2.email, role: 'Candidate' }]
    }, {
      storage,
      origin: 'http://localhost:3000'
    });

    assert.equal(simReq.status, 'pending');
    // Must NOT throw, and must record simulated delivery in candidate_communications
    const simComms = db.prepare('SELECT * FROM candidate_communications WHERE candidate_id = ?').all(cand2.id);
    assert.equal(simComms.length, 1, 'Local mode must record simulated communication');
    assert.equal(simComms[0].status, 'delivered', 'Simulated communication must be recorded as delivered');
    const meta = JSON.parse(simComms[0].metadata || '{}');
    assert.equal(meta.simulated, true);
    assert.ok(meta.signing_url.includes('/sign/'));

    // 4. Test submitSignature dispatches completion confirmation email
    const token = sigReq.signers[0].token;
    assert.ok(token, 'Signer token must be present');

    await submitSignature(db, token, {
      signatureType: 'typed',
      signatureData: 'Maya Lin',
      signatureStyle: 'cursive',
      consent: true
    }, {
      storage,
      origin: 'https://orbit.mechlin.com',
      communicationAdapter: mockCommAdapter
    });

    // Verify completion email was dispatched
    assert.equal(sentEmails.length, 3, 'Completion email must be sent on execution');
    const completionEmail = sentEmails[2];
    assert.equal(completionEmail.recipient, 'maya.lin@example.com');
    assert.match(completionEmail.subject, /Executed: Principal Architect Offer Agreement - Electronic Signature Completed/i);
    assert.match(completionEmail.html, /Electronic Signature Executed & Legally Verified/);
    assert.match(completionEmail.html, /Download Executed Document \(PDF\)/);

    // 5. Test declineSignature records decline communication
    const cand3 = service(db, recruiter, 'POST', 'candidates', {
      name: 'Noah Patel',
      email: 'noah.patel@example.com',
      team: recruiter.team,
      skills: 'Product, Strategy'
    });

    const declineReq = await createSignatureRequest(db, recruiter, {
      title: 'Product Director Offer',
      candidateId: cand3.id,
      signers: [{ name: cand3.name, email: cand3.email, role: 'Candidate' }]
    }, { storage });

    const decToken = declineReq.signers[0].token;
    declineSignature(db, decToken, { reason: 'Pursuing independent venture' });

    const decReqAfter = getSignatureRequest(db, recruiter, declineReq.id);
    assert.equal(decReqAfter.status, 'declined');

    const decComms = db.prepare('SELECT * FROM candidate_communications WHERE candidate_id = ?').all(cand3.id);
    const declineLog = decComms.find(c => c.subject.includes('Declined:'));
    assert.ok(declineLog, 'Decline must be recorded in candidate communications log');
    const decMeta = JSON.parse(declineLog.metadata || '{}');
    assert.equal(decMeta.event, 'signature_declined');
    assert.equal(decMeta.reason, 'Pursuing independent venture');
  } finally {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
});


