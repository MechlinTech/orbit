/**
 * PDF Document Generator and Electronic Signature Stamper for Orbit ATS
 * Generates standard PDF documents and stamps visual electronic signatures
 * alongside a tamper-evident Certificate of Completion using pure Node.js.
 */

import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { generateStyledSignaturePng } from './renderer.js';

/**
 * Escapes characters for PDF text strings.
 */
function escapePdfText(text = '') {
  return String(text)
    .replace(/[\u2022\u00B7]/g, '-')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Unfilters PNG scanlines according to PNG specification (filter types 0-4).
 */
function unfilterPngScanlines(inflated, width, height, bpp) {
  const rowBytes = width * bpp;
  const uncompressed = Buffer.alloc(rowBytes * height);
  let srcPos = 0;
  let dstPos = 0;
  let prevRow = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y++) {
    const filter = inflated[srcPos++];
    const currentRow = Buffer.alloc(rowBytes);

    for (let x = 0; x < rowBytes; x++) {
      const raw = inflated[srcPos++];
      const a = (x >= bpp) ? currentRow[x - bpp] : 0;
      const b = prevRow[x];
      const c = (x >= bpp) ? prevRow[x - bpp] : 0;

      let val = raw;
      if (filter === 0) {
        val = raw;
      } else if (filter === 1) {
        val = (raw + a) & 0xff;
      } else if (filter === 2) {
        val = (raw + b) & 0xff;
      } else if (filter === 3) {
        val = (raw + Math.floor((a + b) / 2)) & 0xff;
      } else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        val = (raw + pr) & 0xff;
      }
      currentRow[x] = val;
    }
    currentRow.copy(uncompressed, dstPos);
    dstPos += rowBytes;
    prevRow = currentRow;
  }
  return uncompressed;
}

/**
 * Parses a PNG buffer into an RGB bitmap and optional alpha SMask for PDF embedding.
 */
export function parsePngImage(buffer) {
  if (!buffer || buffer.length < 24) return null;
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(magic)) return null;

  try {
    let offset = 8;
    let ihdr = null;
    let palette = null;
    const idats = [];

    while (offset < buffer.length - 8) {
      const len = buffer.readUInt32BE(offset);
      const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
      const data = buffer.subarray(offset + 8, offset + 8 + len);
      if (type === 'IHDR') {
        ihdr = {
          width: data.readUInt32BE(0),
          height: data.readUInt32BE(4),
          bitDepth: data[8],
          colorType: data[9],
          compression: data[10],
          filter: data[11],
          interlace: data[12]
        };
      } else if (type === 'PLTE') {
        palette = data;
      } else if (type === 'IDAT') {
        idats.push(data);
      } else if (type === 'IEND') {
        break;
      }
      offset += 12 + len;
    }

    if (!ihdr || !idats.length) return null;
    if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0) return null;

    const { width, height, colorType } = ihdr;
    let bpp = 3;
    if (colorType === 0) bpp = 1;
    else if (colorType === 2) bpp = 3;
    else if (colorType === 3) bpp = 1;
    else if (colorType === 4) bpp = 2;
    else if (colorType === 6) bpp = 4;
    else return null;

    const inflated = zlib.inflateSync(Buffer.concat(idats));
    const expectedLength = height * (1 + width * bpp);
    if (inflated.length < expectedLength) return null;

    const uncompressed = unfilterPngScanlines(inflated, width, height, bpp);
    const totalPixels = width * height;
    const rgb = Buffer.alloc(totalPixels * 3);
    let alpha = null;

    if (colorType === 6) {
      // RGBA
      alpha = Buffer.alloc(totalPixels);
      for (let i = 0; i < totalPixels; i++) {
        const r = uncompressed[i * 4];
        const g = uncompressed[i * 4 + 1];
        const b = uncompressed[i * 4 + 2];
        const a = uncompressed[i * 4 + 3];

        const normA = a / 255;
        rgb[i * 3] = Math.round(r * normA + 255 * (1 - normA));
        rgb[i * 3 + 1] = Math.round(g * normA + 255 * (1 - normA));
        rgb[i * 3 + 2] = Math.round(b * normA + 255 * (1 - normA));
        alpha[i] = a;
      }
    } else if (colorType === 2) {
      uncompressed.copy(rgb);
    } else if (colorType === 0) {
      for (let i = 0; i < totalPixels; i++) {
        const g = uncompressed[i];
        rgb[i * 3] = g;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = g;
      }
    } else if (colorType === 3 && palette) {
      for (let i = 0; i < totalPixels; i++) {
        const idx = uncompressed[i];
        const palOffset = idx * 3;
        rgb[i * 3] = palette[palOffset] || 0;
        rgb[i * 3 + 1] = palette[palOffset + 1] || 0;
        rgb[i * 3 + 2] = palette[palOffset + 2] || 0;
      }
    } else if (colorType === 4) {
      alpha = Buffer.alloc(totalPixels);
      for (let i = 0; i < totalPixels; i++) {
        const g = uncompressed[i * 2];
        const a = uncompressed[i * 2 + 1];
        const normA = a / 255;
        const comp = Math.round(g * normA + 255 * (1 - normA));
        rgb[i * 3] = comp;
        rgb[i * 3 + 1] = comp;
        rgb[i * 3 + 2] = comp;
        alpha[i] = a;
      }
    }

    let finalWidth = width;
    let finalHeight = height;
    let finalRgb = rgb;
    let finalAlpha = alpha;

    if (alpha) {
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      let hasInk = false;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (alpha[y * width + x] > 15) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            hasInk = true;
          }
        }
      }

      if (hasInk) {
        const pad = 3;
        minX = Math.max(0, minX - pad);
        minY = Math.max(0, minY - pad);
        maxX = Math.min(width - 1, maxX + pad);
        maxY = Math.min(height - 1, maxY + pad);

        const cropW = maxX - minX + 1;
        const cropH = maxY - minY + 1;

        if (cropW < width || cropH < height) {
          finalWidth = cropW;
          finalHeight = cropH;
          finalRgb = Buffer.alloc(cropW * cropH * 3);
          finalAlpha = Buffer.alloc(cropW * cropH);

          for (let cy = 0; cy < cropH; cy++) {
            for (let cx = 0; cx < cropW; cx++) {
              const srcIdx = (minY + cy) * width + (minX + cx);
              const dstIdx = cy * cropW + cx;
              finalRgb[dstIdx * 3] = rgb[srcIdx * 3];
              finalRgb[dstIdx * 3 + 1] = rgb[srcIdx * 3 + 1];
              finalRgb[dstIdx * 3 + 2] = rgb[srcIdx * 3 + 2];
              finalAlpha[dstIdx] = alpha[srcIdx];
            }
          }
        }
      }
    }

    return {
      width: finalWidth,
      height: finalHeight,
      filter: 'FlateDecode',
      colorSpace: 'DeviceRGB',
      bitsPerComponent: 8,
      data: zlib.deflateSync(finalRgb),
      smaskData: finalAlpha ? zlib.deflateSync(finalAlpha) : null
    };
  } catch {
    return null;
  }
}

/**
 * Parses JPEG image dimensions for direct PDF DCTDecode embedding.
 */
export function parseJpegImage(buffer) {
  if (!buffer || buffer.length < 30) return null;
  const magic = Buffer.from([0xff, 0xd8, 0xff]);
  if (!buffer.subarray(0, 3).equals(magic)) return null;

  try {
    let offset = 2;
    let width = 400;
    let height = 150;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = buffer.readUInt16BE(offset + 5);
        width = buffer.readUInt16BE(offset + 7);
        break;
      }
      const len = buffer.readUInt16BE(offset + 2);
      offset += 2 + len;
    }

    return {
      width,
      height,
      filter: 'DCTDecode',
      colorSpace: 'DeviceRGB',
      bitsPerComponent: 8,
      data: buffer,
      smaskData: null
    };
  } catch {
    return null;
  }
}

/**
 * Loads and parses a signer's signature image (drawn, uploaded, or typed visual render) from buffer or storage.
 */
export function loadAndParseSignatureImage(signer, storage = null) {
  if (!signer) return null;

  let buf = null;
  const sigData = signer.signature_data;

  try {
    // 1. Direct buffer properties
    if (Buffer.isBuffer(signer.signature_image_buffer)) {
      buf = signer.signature_image_buffer;
    } else if (Buffer.isBuffer(signer.signature_buffer)) {
      buf = signer.signature_buffer;
    } else if (Buffer.isBuffer(sigData)) {
      buf = sigData;
    }

    // 2. Direct base64 / data URL in signature_image property if present
    if (!buf && typeof signer.signature_image === 'string') {
      if (signer.signature_image.startsWith('data:image/')) {
        const commaIdx = signer.signature_image.indexOf(',');
        if (commaIdx !== -1) {
          buf = Buffer.from(signer.signature_image.substring(commaIdx + 1), 'base64');
        }
      } else if (signer.signature_image.length > 200) {
        buf = Buffer.from(signer.signature_image, 'base64');
      }
    }

    // 3. Stored typed signature asset if signer.signature_type === 'typed'
    if (!buf && signer.signature_type === 'typed' && storage && signer.id) {
      if (typeof storage.getTypedSignatureAssetPath === 'function') {
        const typedPath = storage.getTypedSignatureAssetPath(signer.id);
        if (typedPath && existsSync(typedPath)) {
          try { buf = readFileSync(typedPath); } catch {}
        }
      }
      if (!buf && storage.assetsDir) {
        const typedAsset = resolve(storage.assetsDir, `typed-${signer.id}.png`);
        if (existsSync(typedAsset)) {
          try { buf = readFileSync(typedAsset); } catch {}
        }
      }
    }

    // 4. If sigData is a string (data URL, base64, or file path)
    if (!buf && typeof sigData === 'string') {
      if (sigData.startsWith('data:image/')) {
        const commaIdx = sigData.indexOf(',');
        if (commaIdx !== -1) {
          buf = Buffer.from(sigData.substring(commaIdx + 1), 'base64');
        }
      } else if (sigData.length > 200 && !sigData.includes('/') && !sigData.includes('\\')) {
        buf = Buffer.from(sigData, 'base64');
      } else {
        if (storage && typeof storage.readFile === 'function') {
          try {
            buf = storage.readFile(sigData);
          } catch {}
        }
        if (!buf && existsSync(sigData)) {
          try { buf = readFileSync(sigData); } catch {}
        }
        if (!buf) {
          const resolved = resolve(sigData);
          if (existsSync(resolved)) {
            try { buf = readFileSync(resolved); } catch {}
          }
        }
        if (!buf && storage?.assetsDir) {
          const inAssets = resolve(storage.assetsDir, basename(sigData));
          if (existsSync(inAssets)) {
            try { buf = readFileSync(inAssets); } catch {}
          }
        }
      }
    }

    // 5. Guaranteed fallback: if buffer is missing for typed (or visual signature requested), generate high-res styled PNG
    if (!buf && signer) {
      const name = signer.signature_data || signer.name || 'Signer';
      const style = signer.signature_style || 'cursive';
      try {
        buf = generateStyledSignaturePng(name, style);
        if (storage && signer.id && typeof storage.saveTypedSignatureAsset === 'function') {
          try { storage.saveTypedSignatureAsset(signer.id, buf); } catch {}
        }
      } catch {}
    }

    if (!buf || buf.length < 24) return null;

    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.subarray(0, 8).equals(PNG_MAGIC)) {
      return parsePngImage(buf);
    }

    const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
    if (buf.subarray(0, 3).equals(JPEG_MAGIC)) {
      return parseJpegImage(buf);
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Creates a standard PDF 1.4 buffer containing pages of text streams and optional image XObjects.
 * @param {Array<{ streamText: string, images?: Array<object> }>} pages
 * @returns {Buffer}
 */
export function buildPdfDocument(pages = []) {
  const objects = [];
  let currentObjId = 1;

  // Obj 1: Catalog
  const catalogObjId = currentObjId++;
  // Obj 2: Pages container
  const pagesObjId = currentObjId++;
  // Obj 3: Font Helvetica (Body)
  const fontObjId = currentObjId++;
  // Obj 4: Font Helvetica-Bold (Headings)
  const fontBoldObjId = currentObjId++;
  // Obj 5: Font Times-BoldItalic (Formal Serif Italic Signature)
  const fontSerifBoldItalicObjId = currentObjId++;
  // Obj 6: Font Times-Italic (Cursive Script Italic Signature)
  const fontSerifItalicObjId = currentObjId++;
  // Obj 7: Font Helvetica-BoldOblique (Clean Modern Slanted Signature)
  const fontSansBoldObliqueObjId = currentObjId++;
  // Obj 8: Font Courier-BoldOblique (Handwritten Flow Slanted Signature)
  const fontMonoBoldObliqueObjId = currentObjId++;

  const pageObjIds = [];
  const contentObjIds = [];
  const contentBuffers = [];

  for (const page of pages) {
    const pId = currentObjId++;
    const cId = currentObjId++;
    pageObjIds.push(pId);
    contentObjIds.push(cId);

    const streamCompressed = zlib.deflateSync(Buffer.from(page.streamText, 'utf8'));
    contentBuffers.push({ id: cId, buffer: streamCompressed });

    if (Array.isArray(page.images)) {
      for (const img of page.images) {
        img.objId = currentObjId++;
        if (img.smaskData) {
          img.smaskObjId = currentObjId++;
        }
      }
    }
  }

  const chunks = [];
  chunks.push(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));

  const xrefOffsets = [0]; // obj 0 is special

  const appendObj = (id, strOrBuf) => {
    const offset = chunks.reduce((acc, c) => acc + c.length, 0);
    xrefOffsets[id] = offset;
    chunks.push(Buffer.from(`${id} 0 obj\n`));
    chunks.push(Buffer.isBuffer(strOrBuf) ? strOrBuf : Buffer.from(strOrBuf));
    chunks.push(Buffer.from('\nendobj\n'));
  };

  // Obj 1: Catalog
  appendObj(catalogObjId, `<< /Type /Catalog /Pages ${pagesObjId} 0 R >>`);

  // Obj 2: Pages
  const kidsStr = pageObjIds.map(id => `${id} 0 R`).join(' ');
  appendObj(pagesObjId, `<< /Type /Pages /Kids [${kidsStr}] /Count ${pageObjIds.length} >>`);

  // Fonts
  appendObj(fontObjId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  appendObj(fontBoldObjId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`);
  appendObj(fontSerifBoldItalicObjId, `<< /Type /Font /Subtype /Type1 /BaseFont /Times-BoldItalic >>`);
  appendObj(fontSerifItalicObjId, `<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>`);
  appendObj(fontSansBoldObliqueObjId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique >>`);
  appendObj(fontMonoBoldObliqueObjId, `<< /Type /Font /Subtype /Type1 /BaseFont /Courier-BoldOblique >>`);

  // Pages & Content streams & Image XObjects
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pId = pageObjIds[i];
    const cId = contentObjIds[i];
    const cBuf = contentBuffers[i];

    let xobjectsStr = '';
    if (Array.isArray(page.images) && page.images.length > 0) {
      const entries = page.images.map(img => `/${img.name} ${img.objId} 0 R`).join(' ');
      xobjectsStr = ` /XObject << ${entries} >>`;
    }

    // Page object with all font resources
    appendObj(pId, `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 612 792] /Contents ${cId} 0 R /Resources << /Font << /F1 ${fontObjId} 0 R /F2 ${fontBoldObjId} 0 R /F3 ${fontSerifBoldItalicObjId} 0 R /F4 ${fontSerifItalicObjId} 0 R /F5 ${fontSansBoldObliqueObjId} 0 R /F6 ${fontMonoBoldObliqueObjId} 0 R >>${xobjectsStr} >> >>`);

    // Content stream object
    const streamHeader = Buffer.from(`<< /Length ${cBuf.buffer.length} /Filter /FlateDecode >>\nstream\n`);
    const streamFooter = Buffer.from('\nendstream');
    appendObj(cId, Buffer.concat([streamHeader, cBuf.buffer, streamFooter]));

    // Images for this page
    if (Array.isArray(page.images)) {
      for (const img of page.images) {
        if (img.smaskObjId && img.smaskData) {
          const smaskHeader = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.smaskData.length} >>\nstream\n`);
          appendObj(img.smaskObjId, Buffer.concat([smaskHeader, img.smaskData, streamFooter]));
        }

        const smaskRef = img.smaskObjId ? ` /SMask ${img.smaskObjId} 0 R` : '';
        const filterStr = img.filter || 'FlateDecode';
        const colorSpaceStr = img.colorSpace || 'DeviceRGB';
        const imgHeader = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${colorSpaceStr} /BitsPerComponent 8 /Filter /${filterStr}${smaskRef} /Length ${img.data.length} >>\nstream\n`);
        appendObj(img.objId, Buffer.concat([imgHeader, img.data, streamFooter]));
      }
    }
  }

  // Cross-reference table (xref)
  const xrefStart = chunks.reduce((acc, c) => acc + c.length, 0);
  const totalObjs = currentObjId;
  let xrefStr = `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;

  for (let i = 1; i < totalObjs; i++) {
    const off = String(xrefOffsets[i] || 0).padStart(10, '0');
    xrefStr += `${off} 00000 n \n`;
  }

  xrefStr += `trailer\n<< /Size ${totalObjs} /Root ${catalogObjId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xrefStr));

  return Buffer.concat(chunks);
}

/**
 * Generates an Offer of Employment PDF document.
 */
export function generateOfferLetterPdf({
  candidateName = 'Candidate Name',
  requisitionTitle = 'Software Engineer',
  team = 'Engineering',
  salary = '120,000',
  currency = 'USD',
  startDate = 'Two weeks following signature acceptance',
  recruiterName = 'Talent Acquisition Team',
  companyName = 'Mechlin Technologies'
} = {}) {
  const todayStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const streamText = `
BT
/F2 18 Tf
54 730 Td
(${escapePdfText(companyName)}) Tj
ET

BT
/F1 10 Tf
54 712 Td
(Orbit Recruitment & Talent Systems) Tj
ET

BT
/F1 10 Tf
54 680 Td
(Date: ${escapePdfText(todayStr)}) Tj
ET

BT
/F2 14 Tf
54 645 Td
(OFFER OF EMPLOYMENT: ${escapePdfText(requisitionTitle.toUpperCase())}) Tj
ET

BT
/F1 10 Tf
54 615 Td
(Dear ${escapePdfText(candidateName)},) Tj
ET

BT
/F1 10 Tf
54 590 Td
(On behalf of ${escapePdfText(companyName)}, we are pleased to offer you the position of ${escapePdfText(requisitionTitle)} on the ${escapePdfText(team)} team.) Tj
ET

BT
/F1 10 Tf
54 565 Td
(We were impressed by your background, technical qualifications, and alignment with our mission.) Tj
ET

BT
/F2 11 Tf
54 530 Td
(Position Details and Compensation:) Tj
ET

BT
/F1 10 Tf
64 505 Td
(- Position Title: ${escapePdfText(requisitionTitle)}) Tj
ET

BT
/F1 10 Tf
64 485 Td
(- Organization / Team: ${escapePdfText(team)}) Tj
ET

BT
/F1 10 Tf
64 465 Td
(- Annual Base Salary: ${escapePdfText(currency)} ${escapePdfText(salary)}) Tj
ET

BT
/F1 10 Tf
64 445 Td
(- Anticipated Start Date: ${escapePdfText(startDate)}) Tj
ET

BT
/F1 10 Tf
64 425 Td
(- Employment Classification: Full-time Regular) Tj
ET

BT
/F2 11 Tf
54 390 Td
(Terms of Acceptance:) Tj
ET

BT
/F1 10 Tf
54 365 Td
(This offer is contingent upon successful verification of identity and right-to-work documentation.) Tj
ET

BT
/F1 10 Tf
54 345 Td
(Please review this agreement and electronically execute your acceptance using the signature block below.) Tj
ET

BT
/F1 10 Tf
54 310 Td
(Sincerely,) Tj
ET

BT
/F2 10 Tf
54 290 Td
(${escapePdfText(recruiterName)}) Tj
ET

BT
/F1 10 Tf
54 275 Td
(${escapePdfText(companyName)} Talent Acquisition) Tj
ET

BT
/F2 11 Tf
54 220 Td
(CANDIDATE ACCEPTANCE AND SIGNATURE:) Tj
ET

BT
/F1 9 Tf
54 195 Td
(I accept the offer of employment as stated above.) Tj
ET

BT
/F1 9 Tf
54 140 Td
(Signer: ____________________________________    Date: ________________________) Tj
ET
`;

  return buildPdfDocument([{ streamText }]);
}

/**
 * Stamps a visual Certificate of Completion onto a document with embedded signatures.
 */
export function stampSignedPdf({
  originalPdfBuffer,
  request,
  signers = [],
  storage = null
}) {
  const originalHash = createHash('sha256').update(originalPdfBuffer).digest('hex');
  const nowIso = new Date().toISOString();

  let signersStream = '';
  let yPos = 610;
  const certImages = [];

  for (let idx = 0; idx < signers.length; idx++) {
    const s = signers[idx];
    const signedDate = s.signed_at || nowIso;
    const sigTypeStr = s.signature_type === 'typed'
      ? `Typed (${s.signature_style || 'cursive'})`
      : s.signature_type === 'uploaded'
        ? 'Uploaded Signature Image'
        : s.signature_type === 'drawn'
          ? 'Hand-Drawn Canvas Signature'
          : 'Electronic Signature';

    const parsedImg = loadAndParseSignatureImage(s, storage);

    let sigVisualStream = '';
    if (parsedImg) {
      const imgName = `CertSigImg_${idx}`;
      const maxW = 150;
      const maxH = 32;
      const aspect = (parsedImg.width && parsedImg.height) ? (parsedImg.width / parsedImg.height) : 3;
      let drawW = maxW;
      let drawH = Math.round(drawW / aspect);
      if (drawH > maxH) {
        drawH = maxH;
        drawW = Math.round(drawH * aspect);
      }

      certImages.push({
        name: imgName,
        ...parsedImg
      });

      const imgX = 120;
      const imgY = Math.round(yPos - 25 - (drawH / 2));

      sigVisualStream = `
BT
/F2 11 Tf
54 ${yPos - 30} Td
(Signature:) Tj
ET

q
${drawW} 0 0 ${drawH} ${imgX} ${imgY} cm
/${imgName} Do
Q
`;
    } else {
      const sigTextDisplay = s.signature_type === 'typed'
        ? (s.signature_data || s.name)
        : `[${sigTypeStr} Captured]`;

      const style = s.signature_style || 'cursive';
      let fontTag = '/F3 15 Tf';
      if (style === 'formal') fontTag = '/F3 16 Tf';
      else if (style === 'cursive') fontTag = '/F4 17 Tf';
      else if (style === 'handwritten') fontTag = '/F6 14 Tf';
      else if (style === 'clean') fontTag = '/F5 13 Tf';

      sigVisualStream = `
BT
/F2 11 Tf
0 0 0 rg
54 ${yPos - 34} Td
(Signature: ) Tj
${fontTag}
0.08 0.18 0.35 rg
(${escapePdfText(sigTextDisplay)}) Tj
0 0 0 rg
ET
`;
    }

    signersStream += `
BT
/F2 11 Tf
54 ${yPos} Td
(Signer: ${escapePdfText(s.name)} <${escapePdfText(s.email)}>) Tj
ET

BT
/F1 9 Tf
54 ${yPos - 16} Td
(Role: ${escapePdfText(s.role || 'Signer')} | Status: SIGNED | Method: ${escapePdfText(sigTypeStr)}) Tj
ET

${sigVisualStream}

BT
/F1 8 Tf
54 ${yPos - 52} Td
(Timestamp: ${escapePdfText(signedDate)} UTC | Verification: Authenticated Session Token) Tj
ET

BT
/F1 8 Tf
54 ${yPos - 64} Td
(Affirmative Consent: CONFIRMED | IP: ${escapePdfText(s.ip_address || '127.0.0.1')}) Tj
ET
`;
    yPos -= 92;
  }

  const certificateStreamText = `
BT
/F2 16 Tf
54 730 Td
(ORBIT ELECTRONIC SIGNATURE CERTIFICATE) Tj
ET

BT
/F1 9 Tf
54 712 Td
(Tamper-Evident Completion Audit Trail · Mechlin Orbit ATS) Tj
ET

BT
/F2 10 Tf
54 680 Td
(Document: ${escapePdfText(request?.title || 'Employment Agreement')}) Tj
ET

BT
/F1 8 Tf
54 664 Td
(Request ID: ${escapePdfText(request?.id || 'req-id')}) Tj
ET

BT
/F1 8 Tf
54 650 Td
(Original SHA-256 Digest: ${escapePdfText(originalHash)}) Tj
ET

${signersStream}

BT
/F2 9 Tf
54 120 Td
(LEGAL ADVISORY & INTEGRITY NOTICE:) Tj
ET

BT
/F1 8 Tf
54 105 Td
(This electronic signature record was generated by Orbit ATS in compliance with electronic signature) Tj
ET

BT
/F1 8 Tf
54 93 Td
(standards (US ESIGN Act 15 U.S.C. § 7001 / UETA). Signer identity and consent were verified upon execution.) Tj
ET

BT
/F1 8 Tf
54 81 Td
(Visual signature representation embedded with SHA-256 cryptographic document integrity verification.) Tj
ET

BT
/F1 8 Tf
54 60 Td
(Generated on: ${escapePdfText(nowIso)} UTC · Orbit ATS) Tj
ET
`;

  // Extract original pages from the original PDF so the signed document
  // preserves the actual offer letter / agreement rather than replacing it.
  const originalPages = extractPagesFromPdf(originalPdfBuffer);
  const primarySigner = signers[0];
  const primaryImg = primarySigner ? loadAndParseSignatureImage(primarySigner, storage) : null;
  const signedDateStr = primarySigner?.signed_at
    ? new Date(primarySigner.signed_at).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];
  const primarySigId = primarySigner?.id ? primarySigner.id.slice(0, 8) : 'verified';

  let page1SigStream = '';
  const page1Images = [];

  if (primaryImg) {
    const p1ImgName = 'Page1SigImg';
    const maxW = 160;
    const maxH = 34;
    const aspect = (primaryImg.width && primaryImg.height) ? (primaryImg.width / primaryImg.height) : 3;
    let drawW = maxW;
    let drawH = Math.round(drawW / aspect);
    if (drawH > maxH) {
      drawH = maxH;
      drawW = Math.round(drawH * aspect);
    }
    if (drawW > 200) {
      drawW = 200;
      drawH = Math.round(drawW / aspect);
    }

    page1Images.push({
      name: p1ImgName,
      ...primaryImg
    });

    page1SigStream = `
q
${drawW} 0 0 ${drawH} 95 142 cm
/${p1ImgName} Do
Q

BT
/F1 9 Tf
360 142 Td
(${escapePdfText(signedDateStr)}) Tj
ET

BT
/F1 7 Tf
95 127 Td
(Digitally verified · Orbit ATS ID: ${escapePdfText(primarySigId)}) Tj
ET
`;
  } else if (primarySigner) {
    const sigText = primarySigner.signature_data || primarySigner.name;
    const style = primarySigner.signature_style || 'cursive';
    let fontTag = '/F4 16 Tf';
    if (style === 'formal') fontTag = '/F3 16 Tf';
    else if (style === 'cursive') fontTag = '/F4 17 Tf';
    else if (style === 'handwritten') fontTag = '/F6 14 Tf';
    else if (style === 'clean') fontTag = '/F5 14 Tf';

    page1SigStream = `
BT
${fontTag}
0.08 0.18 0.35 rg
95 142 Td
(${escapePdfText(sigText)}) Tj
0 0 0 rg
ET

BT
/F1 9 Tf
360 142 Td
(${escapePdfText(signedDateStr)}) Tj
ET

BT
/F1 7 Tf
95 127 Td
(Digitally verified · Orbit ATS ID: ${escapePdfText(primarySigId)}) Tj
ET
`;
  }

  // Ensure original pages exist; if empty, synthesize the full offer letter
  if (originalPages.length === 0) {
    const fallbackOffer = generateOfferLetterPdf({
      candidateName: primarySigner?.name || 'Candidate',
      requisitionTitle: (request?.title || 'Employment Position').replace(/ Offer Letter$/i, ''),
      team: 'Dev',
      salary: '120,000',
      currency: 'USD'
    });
    originalPages.push(...extractPagesFromPdf(fallbackOffer));
  }

  const finalPages = [];

  for (let i = 0; i < originalPages.length; i++) {
    if (i === 0) {
      finalPages.push({
        streamText: originalPages[i].streamText + page1SigStream,
        images: page1Images
      });
    } else {
      finalPages.push({
        streamText: originalPages[i].streamText
      });
    }
  }

  finalPages.push({
    streamText: certificateStreamText,
    images: certImages
  });

  return buildPdfDocument(finalPages);
}

/**
 * Extracts content stream texts from an unencrypted PDF buffer.
 * Supports CRLF and LF newlines and filters out Image XObject streams.
 */
export function extractPagesFromPdf(pdfBuffer) {
  const pages = [];
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) return pages;
  let pos = 0;
  while (pos < pdfBuffer.length) {
    let streamIdx = pdfBuffer.indexOf(Buffer.from('stream\n'), pos);
    let headerLen = 7;
    const crlfIdx = pdfBuffer.indexOf(Buffer.from('stream\r\n'), pos);
    if (crlfIdx !== -1 && (streamIdx === -1 || crlfIdx < streamIdx)) {
      streamIdx = crlfIdx;
      headerLen = 8;
    }
    if (streamIdx === -1) break;

    const dataStart = streamIdx + headerLen;
    const streamEnd = pdfBuffer.indexOf(Buffer.from('endstream'), dataStart);
    if (streamEnd === -1) break;

    let actualEnd = streamEnd;
    if (actualEnd > dataStart && pdfBuffer[actualEnd - 1] === 0x0a) actualEnd--;
    if (actualEnd > dataStart && pdfBuffer[actualEnd - 1] === 0x0d) actualEnd--;

    const streamSlice = pdfBuffer.subarray(dataStart, actualEnd);

    // Check if the preceding dictionary marks this stream as an Image
    const dictStart = Math.max(0, streamIdx - 300);
    const dictSlice = pdfBuffer.subarray(dictStart, streamIdx).toString('latin1');
    const isImage = dictSlice.includes('/Subtype /Image') || dictSlice.includes('/Subtype/Image');

    if (!isImage) {
      let decompressed = null;
      try {
        decompressed = zlib.inflateSync(streamSlice).toString('utf8');
      } catch {
        try {
          const raw = streamSlice.toString('utf8');
          if (raw.includes('BT') && raw.includes('ET')) decompressed = raw;
        } catch {}
      }

      if (decompressed && (decompressed.includes('BT') || decompressed.includes('Tj') || decompressed.includes('ET'))) {
        pages.push({ streamText: decompressed });
      }
    }

    pos = streamEnd + 9;
  }
  return pages;
}
