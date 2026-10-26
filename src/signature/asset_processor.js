/**
 * Orbit ATS Offer Letter Asset and Letterhead Processor
 * Securely handles uploaded PNG, JPEG, PDF, and DOC/DOCX stationery assets,
 * parses dimensions, enforces security rules, and computes A4 layout placement.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, basename, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { HttpError } from '../policy.js';
import { parsePngImage, parseJpegImage } from './pdf.js';

export const A4_WIDTH_PT = 595;
export const A4_HEIGHT_PT = 842;
export const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 10 MB

const MAGIC_SIGNATURES = {
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  jpeg: [Buffer.from([0xff, 0xd8, 0xff])],
  jpg: [Buffer.from([0xff, 0xd8, 0xff])],
  pdf: [Buffer.from([0x25, 0x50, 0x44, 0x46])], // %PDF
  docx: [Buffer.from([0x50, 0x4b, 0x03, 0x04])], // PK..
  doc: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])] // OLE Compound File
};

/**
 * Validates file buffer magic bytes against declared format.
 */
export function validateAssetMagic(buffer, format) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 8) {
    throw new HttpError(400, 'File content is empty or unreadable.');
  }
  const cleanFmt = String(format || '').toLowerCase().replace(/^\./, '');
  const magics = MAGIC_SIGNATURES[cleanFmt];
  if (!magics) {
    throw new HttpError(400, `Unsupported letterhead format: "${cleanFmt}". Supported formats: PNG, JPG/JPEG, PDF, DOCX.`);
  }

  const match = magics.some(m => buffer.subarray(0, m.length).equals(m));
  if (!match) {
    throw new HttpError(400, `Corrupted or invalid file: declared format .${cleanFmt} does not match actual file signature.`);
  }
  return true;
}

/**
 * Extracts dimensions from a PNG buffer.
 */
export function getPngDimensions(buffer) {
  if (buffer.length < 24) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

/**
 * Extracts dimensions from a JPEG buffer.
 */
export function getJpegDimensions(buffer) {
  if (buffer.length < 30) return null;
  let offset = 2;
  while (offset < buffer.length - 8) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    const len = buffer.readUInt16BE(offset + 2);
    offset += 2 + len;
  }
  return { width: 800, height: 600 };
}

/**
 * Parses basic ZIP directory structure (pure Node.js) to extract embedded images from DOCX.
 */
export function extractDocxMediaImage(buffer) {
  if (buffer.length < 30) return null;
  try {
    let offset = 0;
    while (offset < buffer.length - 30) {
      const sig = buffer.readUInt32LE(offset);
      if (sig !== 0x04034b50) break; // Local file header signature

      const compression = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const nameLen = buffer.readUInt16LE(offset + 26);
      const extraLen = buffer.readUInt16LE(offset + 28);
      const name = buffer.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
      const dataStart = offset + 30 + nameLen + extraLen;

      if (name.startsWith('word/media/') && (name.endsWith('.png') || name.endsWith('.jpeg') || name.endsWith('.jpg'))) {
        const rawSlice = buffer.subarray(dataStart, dataStart + compressedSize);
        let imageBuf = rawSlice;
        if (compression === 8) {
          try {
            imageBuf = zlib.inflateRawSync(rawSlice);
          } catch {}
        }
        if (imageBuf && imageBuf.length > 20) {
          const isPng = imageBuf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          return {
            buffer: imageBuf,
            format: isPng ? 'png' : 'jpeg',
            filename: basename(name)
          };
        }
      }

      offset = dataStart + compressedSize;
    }
  } catch {}
  return null;
}

/**
 * Processes an uploaded letterhead asset buffer, extracts metadata, dimensions, and saves it.
 */
export function processLetterheadAsset(buffer, rawFilename, options = {}) {
  if (buffer.length > MAX_ASSET_BYTES) {
    throw new HttpError(413, `Uploaded letterhead exceeds maximum allowed size of ${Math.round(MAX_ASSET_BYTES / 1048576)} MB.`);
  }

  const safeFilename = basename(rawFilename || 'letterhead.png').replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext = extname(safeFilename).toLowerCase().replace(/^\./, '') || 'png';

  validateAssetMagic(buffer, ext);

  let finalBuffer = buffer;
  let finalFormat = ext === 'jpg' ? 'jpeg' : ext;
  let width = A4_WIDTH_PT;
  let height = A4_HEIGHT_PT;
  let mimeType = 'application/octet-stream';

  if (ext === 'png') {
    mimeType = 'image/png';
    const dims = getPngDimensions(buffer);
    if (dims) { width = dims.width; height = dims.height; }
  } else if (ext === 'jpeg' || ext === 'jpg') {
    mimeType = 'image/jpeg';
    const dims = getJpegDimensions(buffer);
    if (dims) { width = dims.width; height = dims.height; }
  } else if (ext === 'pdf') {
    mimeType = 'application/pdf';
    width = A4_WIDTH_PT;
    height = A4_HEIGHT_PT;
  } else if (ext === 'docx') {
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const embeddedImg = extractDocxMediaImage(buffer);
    if (embeddedImg) {
      finalBuffer = embeddedImg.buffer;
      finalFormat = embeddedImg.format;
      mimeType = finalFormat === 'png' ? 'image/png' : 'image/jpeg';
      const dims = finalFormat === 'png' ? getPngDimensions(finalBuffer) : getJpegDimensions(finalBuffer);
      if (dims) { width = dims.width; height = dims.height; }
    }
  } else if (ext === 'doc') {
    mimeType = 'application/msword';
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');

  return {
    buffer: finalBuffer,
    originalBuffer: buffer,
    filename: safeFilename,
    format: finalFormat,
    mimeType,
    width,
    height,
    size: buffer.length,
    sha256
  };
}

/**
 * Computes exact PDF drawing coordinates (x, y, w, h) for a letterhead asset on an A4 sheet.
 * Coordinate system: origin (0,0) is bottom-left. A4 is 595 x 842 pt.
 */
export function calculateLetterheadPlacement({
  assetWidth = 595,
  assetHeight = 842,
  pageWidth = A4_WIDTH_PT,
  pageHeight = A4_HEIGHT_PT,
  scaling = 'fit', // 'fit' | 'stretch' | 'original' | 'header-only' | 'footer-only'
  position = 'full-page', // 'full-page' | 'top' | 'bottom' | 'center'
  margins = { top: 0, bottom: 0, left: 0, right: 0 },
  customScale = 1.0
} = {}) {
  const contentWidth = pageWidth - (margins.left || 0) - (margins.right || 0);
  const contentHeight = pageHeight - (margins.top || 0) - (margins.bottom || 0);
  const aspect = (assetWidth && assetHeight) ? (assetWidth / assetHeight) : (pageWidth / pageHeight);

  let drawW = pageWidth;
  let drawH = pageHeight;
  let drawX = 0;
  let drawY = 0;

  if (scaling === 'stretch') {
    drawW = pageWidth;
    drawH = pageHeight;
    drawX = 0;
    drawY = 0;
  } else if (scaling === 'header-only') {
    // Header letterhead strip at the very top of the page
    drawW = pageWidth;
    drawH = Math.round(drawW / aspect);
    if (drawH > 180) {
      drawH = 180;
      drawW = Math.round(drawH * aspect);
    }
    drawX = Math.round((pageWidth - drawW) / 2);
    drawY = pageHeight - drawH;
  } else if (scaling === 'footer-only') {
    // Footer stationery strip at the bottom of the page
    drawW = pageWidth;
    drawH = Math.round(drawW / aspect);
    if (drawH > 120) {
      drawH = 120;
      drawW = Math.round(drawH * aspect);
    }
    drawX = Math.round((pageWidth - drawW) / 2);
    drawY = 0;
  } else if (scaling === 'original') {
    drawW = Math.round(assetWidth * customScale);
    drawH = Math.round(assetHeight * customScale);
    if (position === 'top') {
      drawX = Math.round((pageWidth - drawW) / 2);
      drawY = pageHeight - drawH - (margins.top || 0);
    } else if (position === 'bottom') {
      drawX = Math.round((pageWidth - drawW) / 2);
      drawY = margins.bottom || 0;
    } else {
      drawX = Math.round((pageWidth - drawW) / 2);
      drawY = Math.round((pageHeight - drawH) / 2);
    }
  } else {
    // Default 'fit' (aspect fit preserving full image without distortion)
    drawW = pageWidth;
    drawH = Math.round(drawW / aspect);
    if (drawH > pageHeight) {
      drawH = pageHeight;
      drawW = Math.round(drawH * aspect);
    }
    drawX = Math.round((pageWidth - drawW) / 2);
    drawY = Math.round((pageHeight - drawH) / 2);
  }

  return {
    x: drawX,
    y: drawY,
    width: drawW,
    height: drawH,
    pageWidth,
    pageHeight
  };
}
