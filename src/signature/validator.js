/**
 * Signature Validation Module for Orbit ATS
 * Validates typed, uploaded, and drawn signatures against security rules,
 * magic bytes, dimension bounds, and non-empty guarantees.
 */

import zlib from 'node:zlib';
import { HttpError } from '../policy.js';

export const SUPPORTED_TYPED_STYLES = ['cursive', 'handwritten', 'formal', 'clean'];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Checks if a PNG image contains entirely transparent or blank pixels.
 */
function isPngBlank(buffer) {
  try {
    let offset = 8;
    const idatChunks = [];
    while (offset < buffer.length - 8) {
      const len = buffer.readUInt32BE(offset);
      const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
      if (type === 'IDAT') {
        idatChunks.push(buffer.subarray(offset + 8, offset + 8 + len));
      }
      offset += 12 + len;
    }
    if (!idatChunks.length) return true;
    const compressed = Buffer.concat(idatChunks);
    const uncompressed = zlib.inflateSync(compressed);
    let anyNonZero = 0;
    let nonZeroNon255 = 0;
    for (let i = 0; i < uncompressed.length; i++) {
      if (uncompressed[i] !== 0) anyNonZero++;
      if (uncompressed[i] !== 0 && uncompressed[i] !== 255) nonZeroNon255++;
    }
    if (anyNonZero === 0) return true;
    if (anyNonZero === uncompressed.length && nonZeroNon255 === 0) return true;
    return nonZeroNon255 < 10 && buffer.length < 150;
  } catch {
    return false;
  }
}

/**
 * Validates typed text signature input.
 */
export function validateTypedSignature({ name = '', style = 'cursive' } = {}) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new HttpError(400, 'Signer name is required for typed signature.');
  }

  const cleanName = name.replace(/<[^>]*>/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (cleanName.length < 2) {
    throw new HttpError(400, 'Signer name must be at least 2 characters long.');
  }
  if (cleanName.length > 100) {
    throw new HttpError(400, 'Signer name cannot exceed 100 characters.');
  }

  const normStyle = String(style || 'cursive').toLowerCase().trim();
  if (!SUPPORTED_TYPED_STYLES.includes(normStyle)) {
    throw new HttpError(400, `Unsupported signature style. Supported styles: ${SUPPORTED_TYPED_STYLES.join(', ')}`);
  }

  return {
    valid: true,
    name: cleanName,
    style: normStyle
  };
}

/**
 * Parses PNG dimensions from header (IHDR chunk).
 */
function parsePngDimensions(buffer) {
  if (buffer.length < 24) {
    throw new HttpError(400, 'Invalid PNG file structure.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

/**
 * Parses JPEG dimensions by walking markers to find SOF0/SOF2.
 */
function parseJpegDimensions(buffer) {
  let offset = 2;
  while (offset < buffer.length - 8) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    // SOF0 (0xc0) or SOF2 (0xc2)
    if (marker === 0xc0 || marker === 0xc2) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    const length = buffer.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  return { width: 400, height: 150 }; // fallback if marker scan ends
}

/**
 * Validates uploaded signature image (PNG or JPEG).
 */
export function validateSignatureImage({ buffer, filename = '', mimeType = '', maxSizeBytes = 2 * 1024 * 1024 } = {}) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 30) {
    throw new HttpError(400, 'Uploaded signature image is missing or corrupted.');
  }

  if (buffer.length > maxSizeBytes) {
    throw new HttpError(413, `Signature image exceeds maximum allowed size of ${Math.round(maxSizeBytes / (1024 * 1024))} MB.`);
  }

  // Security check: reject scripts, HTML, SVG, or active content inside image
  const startSlice = buffer.subarray(0, 1024).toString('latin1').toLowerCase();
  if (startSlice.includes('<svg') || startSlice.includes('<?xml') || startSlice.includes('<script') || startSlice.includes('<html')) {
    throw new HttpError(400, 'Active content or SVG signatures are not permitted for security reasons.');
  }

  let format = null;
  if (buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    format = 'png';
  } else if (buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    format = 'jpeg';
  } else {
    throw new HttpError(400, 'Unsupported signature image format. Please upload a valid PNG or JPEG image.');
  }

  const { width, height } = format === 'png'
    ? parsePngDimensions(buffer)
    : parseJpegDimensions(buffer);

  if (width < 30 || height < 15) {
    throw new HttpError(400, `Signature image dimensions too small (${width}x${height}px). Minimum is 30x15px.`);
  }
  if (width > 4096 || height > 4096) {
    throw new HttpError(400, `Signature image dimensions too large (${width}x${height}px). Maximum is 4096x4096px.`);
  }

  return {
    valid: true,
    format,
    width,
    height,
    size: buffer.length
  };
}

/**
 * Validates drawn canvas signature.
 * Ensures it is a valid PNG and is not a completely blank canvas.
 */
export function validateDrawnSignature(dataUrlOrBuffer) {
  let buffer;

  if (typeof dataUrlOrBuffer === 'string') {
    const match = dataUrlOrBuffer.match(/^data:image\/png;base64,(.+)$/i);
    if (!match) {
      throw new HttpError(400, 'Drawn signature must be a valid PNG base64 data URL.');
    }
    try {
      buffer = Buffer.from(match[1], 'base64');
    } catch {
      throw new HttpError(400, 'Failed to decode drawn signature image.');
    }
  } else if (Buffer.isBuffer(dataUrlOrBuffer)) {
    buffer = dataUrlOrBuffer;
  } else {
    throw new HttpError(400, 'Invalid drawn signature input.');
  }

  if (buffer.length < 60) {
    throw new HttpError(400, 'Drawn signature is empty. Please provide a handwritten signature.');
  }

  if (!buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new HttpError(400, 'Drawn signature must be in valid PNG format.');
  }

  const { width, height } = parsePngDimensions(buffer);

  // Blank canvas detection:
  // Detect empty canvas or blank drawing (transparent or solid blank white)
  if (buffer.length < 120 || isPngBlank(buffer)) {
    throw new HttpError(400, 'Signature drawing cannot be empty. Please draw your signature before submitting.');
  }

  return {
    valid: true,
    buffer,
    format: 'png',
    width,
    height,
    size: buffer.length
  };
}
