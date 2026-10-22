import zlib from 'node:zlib';
import { HttpError } from '../policy.js';

const MAX_DECOMPRESSED_ENTRY_BYTES = 10 * 1024 * 1024; // 10 MB per entry
const MAX_TOTAL_DECOMPRESSED_BYTES = 30 * 1024 * 1024; // 30 MB total
const MAX_COMPRESSION_RATIO = 100;
const MAX_ZIP_ENTRIES = 500;
const MAX_EXTRACTED_CHARS = 100000;

export const SUPPORTED_FORMATS = {
  pdf: {
    extension: '.pdf',
    mimeTypes: ['application/pdf', 'application/x-pdf'],
    magic: [Buffer.from([0x25, 0x50, 0x44, 0x46])] // %PDF
  },
  docx: {
    extension: '.docx',
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream'
    ],
    magic: [Buffer.from([0x50, 0x4b, 0x03, 0x04])] // PK\x03\x04
  }
};

/**
 * Validates uploaded file size, extension, MIME type and magic bytes.
 */
export function validateUpload({ buffer, filename = '', mimeType = '', maxSizeBytes = 5 * 1024 * 1024 }) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'Uploaded file is empty.');
  }

  if (buffer.length > maxSizeBytes) {
    const mb = Math.round(maxSizeBytes / (1024 * 1024));
    throw new HttpError(413, `File exceeds the maximum upload size of ${mb} MB.`);
  }

  // Validate filename and extension
  const safeFilename = filename.replace(/[/\\?%*:|"<>]/g, '_').trim();
  const lowerName = safeFilename.toLowerCase();
  let format = null;

  if (lowerName.endsWith('.pdf')) {
    format = 'pdf';
  } else if (lowerName.endsWith('.docx')) {
    format = 'docx';
  } else if (lowerName.endsWith('.docm')) {
    throw new HttpError(400, 'Documents containing macros (.docm) are not permitted.');
  } else if (lowerName.endsWith('.doc')) {
    throw new HttpError(400, 'Legacy .doc format is not supported. Please upload a .docx or .pdf resume.');
  } else {
    throw new HttpError(400, 'Unsupported file format. Please upload a PDF (.pdf) or Word document (.docx).');
  }

  // Validate magic bytes
  const expectedMagics = SUPPORTED_FORMATS[format].magic;
  const matchesMagic = expectedMagics.some(m => buffer.subarray(0, m.length).equals(m));

  if (!matchesMagic) {
    throw new HttpError(400, `File content does not match the declared ${format.toUpperCase()} format.`);
  }

  // Basic check for declared MIME type if provided
  if (mimeType && mimeType !== 'application/octet-stream') {
    const allowed = SUPPORTED_FORMATS[format].mimeTypes;
    const normMime = mimeType.toLowerCase().split(';')[0].trim();
    if (!allowed.includes(normMime) && normMime !== 'application/octet-stream') {
      // Disallowed MIME
      throw new HttpError(400, `Declared MIME type (${mimeType}) is not compatible with ${format.toUpperCase()}.`);
    }
  }

  return {
    valid: true,
    format,
    filename: safeFilename || `resume.${format}`,
    size: buffer.length
  };
}

/**
 * Parse DOCX file and extract paragraph and table text.
 */
export function parseDocx(buffer) {
  if (!buffer || buffer.length < 30) {
    throw new HttpError(400, 'Invalid or corrupted DOCX document.');
  }

  const entries = readZipEntries(buffer);
  
  // Security check: reject macros or suspicious executable payloads
  for (const name of entries.keys()) {
    const lower = name.toLowerCase();
    if (lower.includes('vbaproject.bin') || lower.endsWith('.vbs') || lower.endsWith('.exe')) {
      throw new HttpError(400, 'Documents containing macros or executable content are not permitted.');
    }
  }

  const docXmlBuffer = entries.get('word/document.xml');
  if (!docXmlBuffer) {
    throw new HttpError(400, 'Invalid DOCX structure: missing word/document.xml.');
  }

  const xmlText = docXmlBuffer.toString('utf8');
  const extracted = extractTextFromDocxXml(xmlText);

  if (extracted.length > MAX_EXTRACTED_CHARS) {
    throw new HttpError(400, 'Extracted document text exceeds maximum character limit.');
  }

  const warnings = [];
  if (!extracted.trim()) {
    warnings.push('Document contains no readable text.');
  }

  return {
    text: extracted.trim(),
    format: 'docx',
    warnings,
    charCount: extracted.length
  };
}

/**
 * Reads entries from a ZIP buffer with zip-bomb safeguards.
 */
function readZipEntries(buffer) {
  const entries = new Map();
  let totalDecompressed = 0;
  let entryCount = 0;

  // Find End of Central Directory Record (EOCD) from the end
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;

  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new HttpError(400, 'Invalid or corrupted DOCX archive (missing EOCD).');
  }

  const centralDirCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (centralDirOffset + centralDirSize > buffer.length) {
    throw new HttpError(400, 'Corrupted DOCX central directory.');
  }

  let cdPtr = centralDirOffset;
  const centralHeaderSig = 0x02014b50;

  for (let idx = 0; idx < centralDirCount; idx++) {
    if (cdPtr + 46 > buffer.length || buffer.readUInt32LE(cdPtr) !== centralHeaderSig) {
      break;
    }

    entryCount++;
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new HttpError(400, 'DOCX archive contains too many files (zip bomb protection).');
    }

    const flag = buffer.readUInt16LE(cdPtr + 8);
    const method = buffer.readUInt16LE(cdPtr + 10);
    const compSize = buffer.readUInt32LE(cdPtr + 20);
    const uncompSize = buffer.readUInt32LE(cdPtr + 24);
    const nameLen = buffer.readUInt16LE(cdPtr + 28);
    const extraLen = buffer.readUInt16LE(cdPtr + 30);
    const commentLen = buffer.readUInt16LE(cdPtr + 32);
    const localHeaderOffset = buffer.readUInt32LE(cdPtr + 42);

    if (flag & 0x01) {
      throw new HttpError(400, 'Password-protected DOCX documents are not supported.');
    }

    const nameStart = cdPtr + 46;
    const entryName = buffer.subarray(nameStart, nameStart + nameLen).toString('utf8');

    // Path traversal check
    if (entryName.includes('..') || entryName.startsWith('/') || entryName.startsWith('\\')) {
      throw new HttpError(400, 'DOCX contains unsafe file paths (path traversal protection).');
    }

    // Zip bomb compression ratio check
    if (uncompSize > MAX_DECOMPRESSED_ENTRY_BYTES) {
      throw new HttpError(400, 'DOCX entry exceeds maximum uncompressed size (zip bomb protection).');
    }
    if (compSize > 0 && (uncompSize / compSize) > MAX_COMPRESSION_RATIO && uncompSize > 10240) {
      throw new HttpError(400, 'DOCX has abnormal compression ratio (zip bomb protection).');
    }

    totalDecompressed += uncompSize;
    if (totalDecompressed > MAX_TOTAL_DECOMPRESSED_BYTES) {
      throw new HttpError(400, 'Total DOCX decompressed size exceeds limits (zip bomb protection).');
    }

    // Read local header to locate data
    if (localHeaderOffset + 30 > buffer.length) {
      throw new HttpError(400, 'Corrupted DOCX local file header offset.');
    }
    const localSig = buffer.readUInt32LE(localHeaderOffset);
    if (localSig !== 0x04034b50) {
      throw new HttpError(400, 'Invalid DOCX local header signature.');
    }
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;

    if (dataStart + compSize > buffer.length) {
      throw new HttpError(400, 'Corrupted DOCX entry data length.');
    }

    const rawData = buffer.subarray(dataStart, dataStart + compSize);
    let decompressed;

    if (method === 0) {
      decompressed = rawData;
    } else if (method === 8) {
      try {
        decompressed = zlib.inflateRawSync(rawData);
      } catch {
        throw new HttpError(400, `Failed to decompress DOCX entry ${entryName}.`);
      }
    } else {
      throw new HttpError(400, `Unsupported compression method (${method}) in DOCX.`);
    }

    entries.set(entryName, decompressed);
    cdPtr += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Extracts paragraphs and tables from WordprocessingML XML.
 */
function extractTextFromDocxXml(xml) {
  // Unescape XML entities helper
  const unescapeXml = s => s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  const lines = [];

  // Parse paragraphs and tables sequentially
  const blockRegex = /<w:(p|tbl)[\s>]([\s\S]*?)<\/w:\1>/g;
  let match;

  while ((match = blockRegex.exec(xml)) !== null) {
    const type = match[1];
    const content = match[2];

    if (type === 'p') {
      const pText = extractParagraphText(content, unescapeXml);
      if (pText) lines.push(pText);
    } else if (type === 'tbl') {
      const tableLines = extractTableText(content, unescapeXml);
      if (tableLines.length) lines.push(...tableLines);
    }
  }

  // Fallback if no <w:p> matched block regex
  if (lines.length === 0) {
    const rawTMatches = [];
    const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let tMatch;
    while ((tMatch = tRegex.exec(xml)) !== null) {
      rawTMatches.push(unescapeXml(tMatch[1]));
    }
    return rawTMatches.join(' ').replace(/[ \t]+/g, ' ');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function extractParagraphText(pXml, unescapeXml) {
  let text = '';
  // Match text nodes, line breaks, tabs
  const tokenRegex = /<w:(t|br|cr|tab)[^>]*>([\s\S]*?)<\/w:\1>|<w:(br|cr|tab)\s*\/>/g;
  let token;

  while ((token = tokenRegex.exec(pXml)) !== null) {
    const tag = token[1] || token[3];
    if (tag === 't') {
      text += unescapeXml(token[2]);
    } else if (tag === 'tab') {
      text += '\t';
    } else if (tag === 'br' || tag === 'cr') {
      text += '\n';
    }
  }

  return text.trim();
}

function extractTableText(tblXml, unescapeXml) {
  const rows = [];
  const trRegex = /<w:tr[\s>]([\s\S]*?)<\/w:tr>/g;
  let trMatch;

  while ((trMatch = trRegex.exec(tblXml)) !== null) {
    const cells = [];
    const tcRegex = /<w:tc[\s>]([\s\S]*?)<\/w:tc>/g;
    let tcMatch;

    while ((tcMatch = tcRegex.exec(trMatch[1])) !== null) {
      const cellContent = tcMatch[1];
      const pTexts = [];
      const pRegex = /<w:p[\s>]([\s\S]*?)<\/w:p>/g;
      let pMatch;
      while ((pMatch = pRegex.exec(cellContent)) !== null) {
        const pt = extractParagraphText(pMatch[1], unescapeXml);
        if (pt) pTexts.push(pt);
      }
      cells.push(pTexts.join(' '));
    }

    if (cells.length) {
      rows.push(cells.join('\t'));
    }
  }

  return rows;
}

/**
 * Parse PDF file and extract readable text.
 * Detects empty or image-only PDFs and warns that OCR is unsupported.
 */
export function parsePdf(buffer) {
  if (!buffer || buffer.length < 30) {
    throw new HttpError(400, 'Invalid or corrupted PDF document.');
  }

  const rawPdf = buffer.toString('binary');
  const header = rawPdf.slice(0, 1024);

  if (!header.includes('%PDF-')) {
    throw new HttpError(400, 'Invalid PDF: missing %PDF header.');
  }

  const hasObject = /\d+\s+\d+\s+obj/i.test(rawPdf);
  const hasStructure = hasObject || /xref|trailer|startxref/i.test(rawPdf);
  if (!hasStructure) {
    throw new HttpError(400, 'Corrupted or unreadable PDF document.');
  }

  // Decompress streams and collect text blocks
  const streamBlocks = extractPdfStreams(buffer);
  const textPieces = [];
  let hasImage = rawPdf.includes('/Subtype /Image') || rawPdf.includes('/Subtype/Image') || rawPdf.includes('/Image');
  let hasPages = rawPdf.includes('/Type /Page') || rawPdf.includes('/Type/Page') || rawPdf.includes('/Page');

  for (const streamContent of streamBlocks) {
    const str = streamContent.toString('latin1');
    const textInStream = extractTextFromPdfContentStream(str);
    if (textInStream) {
      textPieces.push(textInStream);
    }
    if (str.includes('/Image') || str.includes('Do\n') || str.includes('Do\r')) {
      hasImage = true;
    }
  }

  let extracted = textPieces.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // If stream extraction produced nothing, inspect uncompressed text in raw PDF (BT ... ET)
  if (!extracted) {
    const uncompressedText = extractTextFromPdfContentStream(rawPdf);
    if (uncompressedText) {
      extracted = uncompressedText.trim();
    }
  }

  if (extracted.length > MAX_EXTRACTED_CHARS) {
    throw new HttpError(400, 'Extracted document text exceeds maximum character limit.');
  }

  const warnings = [];
  let ocrRequired = false;

  if (!extracted) {
    if (hasImage || hasPages) {
      ocrRequired = true;
      warnings.push('PDF contains no extractable text. Scanned or image-only documents require OCR, which is not supported in this phase.');
    } else {
      warnings.push('PDF contains no readable text.');
    }
  }

  return {
    text: extracted,
    format: 'pdf',
    ocrRequired,
    warnings,
    charCount: extracted.length
  };
}

/**
 * Extracts and decompresses streams from PDF.
 */
function extractPdfStreams(buffer) {
  const streams = [];
  let totalDecompressed = 0;

  const raw = buffer.toString('binary');
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match;

  while ((match = streamRegex.exec(raw)) !== null) {
    const streamStartInMatch = match[0].indexOf('\n') !== -1 ? match[0].indexOf('\n') + 1 : match[0].indexOf('\r') + 1;
    const streamStart = match.index + streamStartInMatch;
    const streamEnd = match.index + match[0].lastIndexOf('endstream');
    const streamSlice = buffer.subarray(streamStart, streamEnd);

    // Look backward from match.index for stream dictionary to check for /Filter /FlateDecode
    const dictSlice = raw.slice(Math.max(0, match.index - 500), match.index);
    const isFlate = /Filter\s*(\/\s*FlateDecode|\[\s*\/FlateDecode\s*\])/i.test(dictSlice);

    if (isFlate) {
      try {
        const decompressed = zlib.inflateSync(streamSlice);
        totalDecompressed += decompressed.length;
        if (totalDecompressed > MAX_TOTAL_DECOMPRESSED_BYTES) {
          throw new HttpError(400, 'PDF decompressed stream size exceeds limits.');
        }
        streams.push(decompressed);
      } catch {
        // Try raw inflate without zlib header
        try {
          const decompressed = zlib.inflateRawSync(streamSlice);
          totalDecompressed += decompressed.length;
          streams.push(decompressed);
        } catch {
          // If inflation fails, treat as raw binary or skip
        }
      }
    } else {
      streams.push(streamSlice);
    }
  }

  return streams;
}

/**
 * Parses operators from a decompressed PDF content stream.
 */
function extractTextFromPdfContentStream(streamStr) {
  const textLines = [];
  const btRegex = /BT([\s\S]*?)ET/g;
  let btMatch;

  while ((btMatch = btRegex.exec(streamStr)) !== null) {
    const btContent = btMatch[1];
    const blockText = parsePdfBtBlock(btContent);
    if (blockText) {
      textLines.push(blockText);
    }
  }

  return textLines.join('\n');
}

/**
 * Parses Tj, TJ, ', " operators inside a BT ... ET block.
 */
function parsePdfBtBlock(block) {
  const parts = [];
  let currentLine = '';

  // Match:
  // 1. (text) Tj
  // 2. [(array)] TJ
  // 3. (text) '
  // 4. strings and operators
  const opRegex = /(\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>|\[[\s\S]*?\])\s*(Tj|TJ|'|")|(T\*|Td|TD)/g;
  let opMatch;

  while ((opMatch = opRegex.exec(block)) !== null) {
    if (opMatch[3]) {
      // Newline / move operator
      if (currentLine.trim()) {
        parts.push(currentLine.trim());
        currentLine = '';
      }
      continue;
    }

    const operand = opMatch[1];
    const op = opMatch[2];

    if (op === 'Tj' || op === "'" || op === '"') {
      const decoded = decodePdfString(operand);
      if (op === "'" || op === '"') {
        if (currentLine.trim()) parts.push(currentLine.trim());
        currentLine = decoded;
      } else {
        currentLine += decoded;
      }
    } else if (op === 'TJ') {
      const decoded = decodePdfTjArray(operand);
      currentLine += decoded;
    }
  }

  if (currentLine.trim()) {
    parts.push(currentLine.trim());
  }

  return parts.join('\n');
}

/**
 * Decodes a PDF literal string ( ... ) or hex string < ... >
 */
function decodePdfString(str) {
  if (!str) return '';
  str = str.trim();

  if (str.startsWith('(') && str.endsWith(')')) {
    const inner = str.slice(1, -1);
    const unescaped = inner
      .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\b/g, '\b')
      .replace(/\\f/g, '\f')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');

    // Check UTF-16BE BOM
    if (unescaped.length >= 2 && unescaped.charCodeAt(0) === 0xFE && unescaped.charCodeAt(1) === 0xFF) {
      let utf16 = '';
      for (let i = 2; i < unescaped.length; i += 2) {
        const code = (unescaped.charCodeAt(i) << 8) | (unescaped.charCodeAt(i + 1) || 0);
        utf16 += String.fromCharCode(code);
      }
      return utf16;
    }
    return unescaped;
  }

  if (str.startsWith('<') && str.endsWith('>')) {
    const hex = str.slice(1, -1).replace(/\s+/g, '');
    const padded = hex.length % 2 === 1 ? hex + '0' : hex;
    const buf = Buffer.from(padded, 'hex');

    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
      return buf.subarray(2).swap16().toString('utf16le');
    }
    return buf.toString('latin1');
  }

  return '';
}

/**
 * Decodes [(Hello) -10 (World)] TJ array operand.
 */
function decodePdfTjArray(arrayStr) {
  let result = '';
  const itemRegex = /(\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>|[-+]?[0-9.]+)/g;
  let itemMatch;

  while ((itemMatch = itemRegex.exec(arrayStr)) !== null) {
    const item = itemMatch[1];
    if (item.startsWith('(') || item.startsWith('<')) {
      result += decodePdfString(item);
    } else {
      const num = parseFloat(item);
      // Large negative numbers in TJ represent word spaces
      if (!isNaN(num) && num < -120) {
        result += ' ';
      }
    }
  }

  return result;
}
