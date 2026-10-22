/**
 * Pure Node.js high-resolution signature renderer
 * Generates styled visual signatures (cursive, handwritten, formal, clean)
 * without external dependencies.
 */

import zlib from 'node:zlib';

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

export function encodeRgbaToPng(width, height, rgbaBuffer) {
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
    rgbaBuffer.copy(rawData, y * rowBytes + 1, y * width * 4, (y + 1) * width * 4);
  }

  const deflated = zlib.deflateSync(rawData);
  const idatChunk = makePngChunk('IDAT', deflated);
  const iendChunk = makePngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// 7x9 Vector Stroke Definitions for Basic Glyph Set (Normalized 0..1)
// Each glyph is an array of stroke polylines: [[[x0, y0], [x1, y1], ...], ...]
const GLYPHS = {
  'a': [[[0.8, 0.4], [0.3, 0.4], [0.1, 0.7], [0.4, 0.9], [0.8, 0.7], [0.8, 0.4], [0.8, 1.0]]],
  'b': [[[0.2, 0.0], [0.2, 1.0]], [[0.2, 0.5], [0.7, 0.5], [0.85, 0.75], [0.7, 1.0], [0.2, 1.0]]],
  'c': [[[0.8, 0.45], [0.4, 0.4], [0.15, 0.7], [0.4, 1.0], [0.8, 0.95]]],
  'd': [[[0.8, 0.0], [0.8, 1.0]], [[0.8, 0.5], [0.3, 0.4], [0.1, 0.7], [0.3, 1.0], [0.8, 0.95]]],
  'e': [[[0.15, 0.7], [0.85, 0.7], [0.85, 0.5], [0.4, 0.4], [0.15, 0.7], [0.4, 1.0], [0.8, 0.95]]],
  'f': [[[0.7, 0.1], [0.5, 0.0], [0.35, 0.2], [0.35, 1.2], [0.2, 1.4]], [[0.15, 0.45], [0.65, 0.45]]],
  'g': [[[0.8, 0.4], [0.3, 0.4], [0.1, 0.7], [0.4, 0.95], [0.8, 0.7], [0.8, 1.3], [0.4, 1.5], [0.1, 1.3]]],
  'h': [[[0.2, 0.0], [0.2, 1.0]], [[0.2, 0.5], [0.6, 0.4], [0.8, 0.6], [0.8, 1.0]]],
  'i': [[[0.5, 0.4], [0.5, 1.0]], [[0.5, 0.15], [0.5, 0.2]]],
  'j': [[[0.7, 0.4], [0.7, 1.3], [0.4, 1.5], [0.15, 1.35]], [[0.7, 0.15], [0.7, 0.2]]],
  'k': [[[0.2, 0.0], [0.2, 1.0]], [[0.75, 0.4], [0.2, 0.7]], [[0.35, 0.6], [0.8, 1.0]]],
  'l': [[[0.4, 0.0], [0.4, 0.9], [0.6, 1.0]]],
  'm': [[[0.15, 0.4], [0.15, 1.0]], [[0.15, 0.5], [0.45, 0.4], [0.5, 0.7], [0.5, 1.0]], [[0.5, 0.5], [0.8, 0.4], [0.85, 0.7], [0.85, 1.0]]],
  'n': [[[0.2, 0.4], [0.2, 1.0]], [[0.2, 0.5], [0.6, 0.4], [0.8, 0.6], [0.8, 1.0]]],
  'o': [[[0.5, 0.4], [0.15, 0.65], [0.5, 1.0], [0.85, 0.65], [0.5, 0.4]]],
  'p': [[[0.2, 0.4], [0.2, 1.5]], [[0.2, 0.5], [0.7, 0.4], [0.85, 0.65], [0.7, 0.95], [0.2, 0.95]]],
  'q': [[[0.8, 0.4], [0.3, 0.4], [0.1, 0.65], [0.4, 0.95], [0.8, 0.7], [0.8, 1.5], [0.95, 1.4]]],
  'r': [[[0.25, 0.4], [0.25, 1.0]], [[0.25, 0.6], [0.5, 0.4], [0.75, 0.45]]],
  's': [[[0.75, 0.45], [0.4, 0.4], [0.2, 0.6], [0.7, 0.75], [0.75, 0.9], [0.4, 1.0], [0.15, 0.9]]],
  't': [[[0.4, 0.15], [0.4, 0.9], [0.65, 1.0]], [[0.15, 0.4], [0.65, 0.4]]],
  'u': [[[0.2, 0.4], [0.2, 0.85], [0.5, 1.0], [0.8, 0.85], [0.8, 0.4]], [[0.8, 0.7], [0.8, 1.0]]],
  'v': [[[0.15, 0.4], [0.5, 1.0], [0.85, 0.4]]],
  'w': [[[0.15, 0.4], [0.35, 1.0], [0.5, 0.6], [0.65, 1.0], [0.85, 0.4]]],
  'x': [[[0.2, 0.4], [0.8, 1.0]], [[0.8, 0.4], [0.2, 1.0]]],
  'y': [[[0.2, 0.4], [0.2, 0.85], [0.5, 1.0], [0.8, 0.85], [0.8, 0.4]], [[0.8, 0.7], [0.8, 1.3], [0.4, 1.5], [0.15, 1.35]]],
  'z': [[[0.2, 0.4], [0.8, 0.4], [0.2, 1.0], [0.8, 1.0]]],
  ' ': []
};

// Add uppercase letters
for (const [k, strokes] of Object.entries(GLYPHS)) {
  const upper = k.toUpperCase();
  if (k === ' ') {
    GLYPHS[upper] = [];
    continue;
  }
  // Scale strokes so uppercase letters start higher (0.0 to 1.0)
  GLYPHS[upper] = strokes.map(stroke => stroke.map(([x, y]) => {
    const newY = y <= 0.4 ? y * 0.5 : (y - 0.4) * 0.9 + 0.2;
    return [x, Math.max(0, Math.min(1.5, newY))];
  }));
}

/**
 * Draws an anti-aliased line into RGBA buffer.
 */
function drawLine(rgba, w, h, x0, y0, x1, y1, color = [15, 43, 72, 255], thickness = 2.5) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return;

  const steps = Math.ceil(dist * 2);
  const rad = thickness / 2;

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;

    const minPx = Math.max(0, Math.floor(cx - rad - 1));
    const maxPx = Math.min(w - 1, Math.ceil(cx + rad + 1));
    const minPy = Math.max(0, Math.floor(cy - rad - 1));
    const maxPy = Math.min(h - 1, Math.ceil(cy + rad + 1));

    for (let py = minPy; py <= maxPy; py++) {
      for (let px = minPx; px <= maxPx; px++) {
        const d = Math.hypot(px - cx, py - cy);
        if (d <= rad + 0.75) {
          const alphaFactor = Math.max(0, Math.min(1, 1 - (d - rad + 0.75) / 1.5));
          const idx = (py * w + px) * 4;
          const a = Math.round(color[3] * alphaFactor);
          if (a > rgba[idx + 3]) {
            rgba[idx] = color[0];
            rgba[idx + 1] = color[1];
            rgba[idx + 2] = color[2];
            rgba[idx + 3] = a;
          }
        }
      }
    }
  }
}

/**
 * Renders styled signature to a PNG Buffer.
 * Supports cursive, handwritten, formal, clean.
 */
export function generateStyledSignaturePng(name = 'Signer', style = 'cursive') {
  const cleanName = String(name || 'Signer').trim();
  const text = style === 'clean' ? cleanName.toUpperCase() : cleanName;

  const glyphW = style === 'clean' ? 18 : style === 'formal' ? 22 : 24;
  const glyphH = style === 'clean' ? 28 : style === 'formal' ? 36 : 40;
  const letterSpacing = style === 'clean' ? 6 : 2;
  const slant = style === 'cursive' ? 0.28 : style === 'handwritten' ? 0.18 : style === 'formal' ? 0.22 : 0;
  const thickness = style === 'clean' ? 3.0 : style === 'formal' ? 2.8 : 2.4;

  const totalW = Math.ceil(text.length * (glyphW + letterSpacing) + 60);
  const totalH = Math.ceil(glyphH * 1.8 + 30);

  const rgba = Buffer.alloc(totalW * totalH * 4);
  const inkColor = [15, 43, 72, 255]; // Deep navy ink #0f2b48

  let curX = 20;
  const baseline = Math.round(totalH * 0.55);

  let prevLastPoint = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const glyph = GLYPHS[char] || GLYPHS[char.toLowerCase()] || GLYPHS['a'];

    if (glyph && glyph.length) {
      for (let sIdx = 0; sIdx < glyph.length; sIdx++) {
        const stroke = glyph[sIdx];
        if (!stroke.length) continue;

        // In cursive, draw a connector from previous letter to this stroke start
        if (style === 'cursive' && prevLastPoint && sIdx === 0 && char !== ' ') {
          const startX = curX + stroke[0][0] * glyphW;
          const startY = baseline - glyphH + stroke[0][1] * glyphH;
          const sx = startX + (baseline - startY) * slant;
          const sy = startY;
          drawLine(rgba, totalW, totalH, prevLastPoint[0], prevLastPoint[1], sx, sy, inkColor, thickness * 0.7);
        }

        for (let pIdx = 0; pIdx < stroke.length - 1; pIdx++) {
          const pt0 = stroke[pIdx];
          const pt1 = stroke[pIdx + 1];

          let y0 = baseline - glyphH + pt0[1] * glyphH;
          let x0 = curX + pt0[0] * glyphW + (baseline - y0) * slant;

          let y1 = baseline - glyphH + pt1[1] * glyphH;
          let x1 = curX + pt1[0] * glyphW + (baseline - y1) * slant;

          // Add slight natural pen jitter for handwritten
          if (style === 'handwritten') {
            const jitter = ((i * 3 + pIdx) % 3 - 1) * 0.8;
            y0 += jitter;
            y1 += jitter;
          }

          drawLine(rgba, totalW, totalH, x0, y0, x1, y1, inkColor, thickness);

          if (pIdx === stroke.length - 2) {
            prevLastPoint = [x1, y1];
          }
        }
      }
    } else {
      prevLastPoint = null;
    }

    curX += glyphW + letterSpacing;
  }

  // Draw cursive flourish underline loop
  if (style === 'cursive') {
    const startFlourishX = 15;
    const endFlourishX = curX + 10;
    const flourishY = baseline + 8;
    drawLine(rgba, totalW, totalH, startFlourishX, flourishY + 2, endFlourishX - 20, flourishY - 1, inkColor, 1.8);
    drawLine(rgba, totalW, totalH, endFlourishX - 20, flourishY - 1, endFlourishX, flourishY + 5, inkColor, 1.4);
  }

  // Trim transparent bounding box
  let minX = totalW, minY = totalH, maxX = 0, maxY = 0;
  let found = false;
  for (let y = 0; y < totalH; y++) {
    for (let x = 0; x < totalW; x++) {
      const idx = (y * totalW + x) * 4;
      if (rgba[idx + 3] > 15) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found) {
    minX = 0; minY = 0; maxX = totalW - 1; maxY = totalH - 1;
  }

  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(totalW - 1, maxX + pad);
  maxY = Math.min(totalH - 1, maxY + pad);

  const trimW = maxX - minX + 1;
  const trimH = maxY - minY + 1;
  const trimmedRgba = Buffer.alloc(trimW * trimH * 4);

  for (let y = 0; y < trimH; y++) {
    for (let x = 0; x < trimW; x++) {
      const srcIdx = ((minY + y) * totalW + (minX + x)) * 4;
      const dstIdx = (y * trimW + x) * 4;
      rgba.copy(trimmedRgba, dstIdx, srcIdx, srcIdx + 4);
    }
  }

  return encodeRgbaToPng(trimW, trimH, trimmedRgba);
}
