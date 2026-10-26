/**
 * Orbit ATS Multi-Page Document Pagination and Layout Engine
 * Converts template sections and dynamic data into genuine A4 PDF pages (595 x 842 pt).
 * Supports continuous flow, heading orphan prevention, table row continuation,
 * explicit page breaks, repeated headers/footers, and page-specific letterhead backgrounds.
 */

import { A4_WIDTH_PT, A4_HEIGHT_PT } from './asset_processor.js';
import { interpolateText, calculateSalaryStructure, formatCurrencyValue } from './variables.js';

// Average character widths in units of 1/1000 of font size for standard Helvetica
const HELVETICA_CHAR_WIDTHS = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, '\'': 222,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, 'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778,
  'H': 722, 'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778,
  'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944,
  'X': 667, 'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
  '`': 333, 'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556,
  'h': 556, 'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556,
  'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722,
  'x': 500, 'y': 500, 'z': 500, '{': 334, '|': 260, '}': 334, '~': 584
};

/**
 * Escapes characters for PDF text streams.
 */
export function escapePdf(text = '') {
  return String(text ?? '')
    .replace(/[\u2022\u00B7]/g, '-')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Estimates text width in points given a font size.
 */
export function measureTextWidth(text = '', fontSize = 10, isBold = false) {
  const str = String(text);
  let totalUnits = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const unit = HELVETICA_CHAR_WIDTHS[ch] || 556;
    totalUnits += isBold ? unit * 1.05 : unit;
  }
  return (totalUnits * fontSize) / 1000;
}

/**
 * Wraps a string into multiple lines that fit within maxWidthPt.
 */
export function wrapText(text = '', maxWidthPt = 480, fontSize = 10, isBold = false) {
  if (!text) return [];
  const paragraphs = String(text).split('\n');
  const allLines = [];

  for (const para of paragraphs) {
    if (!para.trim()) {
      allLines.push('');
      continue;
    }
    const words = para.split(/\s+/);
    let currentLine = '';

    for (const w of words) {
      const candidate = currentLine ? `${currentLine} ${w}` : w;
      const width = measureTextWidth(candidate, fontSize, isBold);
      if (width <= maxWidthPt) {
        currentLine = candidate;
      } else {
        if (currentLine) allLines.push(currentLine);
        currentLine = w;
      }
    }
    if (currentLine) allLines.push(currentLine);
  }

  return allLines;
}

/**
 * Paginates template sections into multiple A4 pages with strict boundary controls.
 */
export function paginateDocument({
  sections = [],
  variables = {},
  pageConfig = {},
  headerConfig = {},
  footerConfig = {},
  backgroundConfig = {},
  assets = {} // map of asset_id -> parsed image object
} = {}) {
  const pageWidth = Number(pageConfig.width) || A4_WIDTH_PT;
  const pageHeight = Number(pageConfig.height) || A4_HEIGHT_PT;

  const margins = {
    top: Number(pageConfig.marginTop) || 54,
    bottom: Number(pageConfig.marginBottom) || 54,
    left: Number(pageConfig.marginLeft) || 54,
    right: Number(pageConfig.marginRight) || 54
  };

  const printableWidth = pageWidth - margins.left - margins.right;
  const printableTop = pageHeight - margins.top;
  const printableBottom = margins.bottom;

  // Pages array accumulating rendered page items
  const pages = [];

  let currentPageIndex = 0;
  let currentY = printableTop;
  let currentOps = [];
  let currentImages = [];

  const startNewPage = () => {
    pages.push({
      pageNumber: currentPageIndex + 1,
      ops: currentOps,
      images: currentImages
    });
    currentPageIndex++;
    currentY = printableTop;
    currentOps = [];
    currentImages = [];
  };

  // Helper to ensure enough space on page, otherwise break
  const ensureSpace = (neededHeight, keepWithNext = false) => {
    if (currentY - neededHeight < printableBottom) {
      startNewPage();
    }
  };

  // Process all template sections in order
  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const section = sections[sIdx];
    if (!section || section.hidden) continue;

    const type = section.type || 'paragraph';

    // 1. Explicit forced page break
    if (type === 'page_break') {
      if (currentOps.length > 0) {
        startNewPage();
      }
      continue;
    }

    // 2. Headings (H1, H2, H3) with orphan prevention
    if (type === 'heading') {
      const rawText = interpolateText(section.text || section.title || '', variables);
      if (!rawText.trim()) continue;

      const level = Number(section.level) || 1;
      const fontSize = level === 1 ? 14 : (level === 2 ? 12 : 11);
      const isBold = true;
      const fontTag = '/F2';
      const lineHeight = fontSize + 4;
      const marginTop = level === 1 ? 16 : 12;
      const marginBottom = 8;
      const neededHeight = marginTop + lineHeight + marginBottom + (lineHeight * 2); // Keep with at least 2 following lines

      ensureSpace(neededHeight, true);

      currentY -= marginTop;
      const wrapped = wrapText(rawText, printableWidth, fontSize, isBold);
      for (const line of wrapped) {
        let alignX = margins.left;
        if (section.align === 'center') {
          const w = measureTextWidth(line, fontSize, isBold);
          alignX = margins.left + Math.max(0, (printableWidth - w) / 2);
        } else if (section.align === 'right') {
          const w = measureTextWidth(line, fontSize, isBold);
          alignX = margins.left + Math.max(0, printableWidth - w);
        }

        currentOps.push(`
BT
${fontTag} ${fontSize} Tf
${alignX} ${currentY} Td
0 0 0 rg
(${escapePdf(line)}) Tj
ET`);
        currentY -= lineHeight;
      }
      currentY -= marginBottom;
      continue;
    }

    // 3. Regular Paragraphs with line-by-line pagination
    if (type === 'paragraph') {
      const rawText = interpolateText(section.text || section.content || '', variables);
      if (!rawText.trim()) continue;

      const fontSize = Number(section.fontSize) || 10;
      const isBold = Boolean(section.bold);
      const fontTag = isBold ? '/F2' : '/F1';
      const lineHeight = Number(section.lineHeight) || (fontSize + 4);
      const marginBottom = Number(section.marginBottom) || 10;

      const lines = wrapText(rawText, printableWidth, fontSize, isBold);

      for (let l = 0; l < lines.length; l++) {
        const line = lines[l];
        ensureSpace(lineHeight);

        if (!line) {
          currentY -= Math.round(lineHeight / 2);
          continue;
        }

        let alignX = margins.left;
        if (section.align === 'center') {
          const w = measureTextWidth(line, fontSize, isBold);
          alignX = margins.left + Math.max(0, (printableWidth - w) / 2);
        } else if (section.align === 'right') {
          const w = measureTextWidth(line, fontSize, isBold);
          alignX = margins.left + Math.max(0, printableWidth - w);
        }

        currentOps.push(`
BT
${fontTag} ${fontSize} Tf
${alignX} ${currentY} Td
0.1 0.1 0.1 rg
(${escapePdf(line)}) Tj
ET`);
        currentY -= lineHeight;
      }
      currentY -= marginBottom;
      continue;
    }

    // 4. Bullet & Numbered Lists
    if (type === 'bullet_list' || type === 'list') {
      const items = Array.isArray(section.items) ? section.items : [];
      const fontSize = Number(section.fontSize) || 10;
      const fontTag = '/F1';
      const lineHeight = fontSize + 4;
      const isNumbered = section.listType === 'numbered';
      const indent = 20;
      const textWidth = printableWidth - indent;

      for (let i = 0; i < items.length; i++) {
        const rawItem = interpolateText(items[i], variables);
        if (!rawItem.trim()) continue;

        const bulletChar = isNumbered ? `${i + 1}.` : '-';
        const wrappedLines = wrapText(rawItem, textWidth, fontSize, false);

        ensureSpace(lineHeight * wrappedLines.length + 4);

        for (let l = 0; l < wrappedLines.length; l++) {
          const line = wrappedLines[l];
          ensureSpace(lineHeight);

          if (l === 0) {
            currentOps.push(`
BT
/F2 ${fontSize} Tf
${margins.left} ${currentY} Td
(${escapePdf(bulletChar)}) Tj
ET`);
          }

          currentOps.push(`
BT
${fontTag} ${fontSize} Tf
${margins.left + indent} ${currentY} Td
0.1 0.1 0.1 rg
(${escapePdf(line)}) Tj
ET`);
          currentY -= lineHeight;
        }
        currentY -= 4; // space between list items
      }
      currentY -= 8;
      continue;
    }

    // 5. Key-Value Grid (Details, Dates, Designation, Location)
    if (type === 'key_value_grid' || type === 'details') {
      const rows = Array.isArray(section.rows) ? section.rows : [];
      const fontSize = 10;
      const lineHeight = 16;
      const keyWidth = 160;
      const valWidth = printableWidth - keyWidth;

      for (const row of rows) {
        const rawKey = interpolateText(row.key || row.label || '', variables);
        const rawVal = interpolateText(row.value || '', variables);
        if (!rawKey && !rawVal) continue;

        const wrappedVal = wrapText(rawVal, valWidth, fontSize, false);
        const rowHeight = Math.max(1, wrappedVal.length) * lineHeight;

        ensureSpace(rowHeight + 4);

        // Key on left (Bold)
        currentOps.push(`
BT
/F2 ${fontSize} Tf
${margins.left} ${currentY} Td
0.15 0.15 0.15 rg
(${escapePdf(rawKey)}:) Tj
ET`);

        // Value on right
        let valY = currentY;
        for (const line of wrappedVal) {
          currentOps.push(`
BT
/F1 ${fontSize} Tf
${margins.left + keyWidth} ${valY} Td
0.1 0.1 0.1 rg
(${escapePdf(line)}) Tj
ET`);
          valY -= lineHeight;
        }

        currentY -= rowHeight + 4;
      }
      currentY -= 10;
      continue;
    }

    // 6. Horizontal Divider
    if (type === 'divider') {
      ensureSpace(16);
      currentY -= 8;
      currentOps.push(`
0.8 0.8 0.8 RG
0.5 w
${margins.left} ${currentY} m
${margins.left + printableWidth} ${currentY} l
S`);
      currentY -= 12;
      continue;
    }

    // 7. Salary Annexure Table (Dynamic Compensation Breakdown)
    if (type === 'salary_annexure' || type === 'compensation_table') {
      const ctcRaw = variables['offer.salary'] || variables['offer.annual_ctc'] || '100,000';
      const currency = variables['offer.currency'] || 'INR';
      const customRows = Array.isArray(section.customRows) ? section.customRows : null;
      const salaryRows = calculateSalaryStructure(ctcRaw, currency, customRows);

      const tableTitle = interpolateText(section.title || 'ANNEXURE A — COMPENSATION BREAKDOWN', variables);
      const col1W = Math.round(printableWidth * 0.52);
      const col2W = Math.round(printableWidth * 0.24);
      const col3W = printableWidth - col1W - col2W;

      const headerHeight = 22;
      const rowHeight = 18;

      // Ensure space for at least title + table header + 3 rows
      ensureSpace(tableTitle ? 80 : 60);

      if (tableTitle) {
        currentOps.push(`
BT
/F2 11 Tf
${margins.left} ${currentY} Td
0.08 0.18 0.35 rg
(${escapePdf(tableTitle)}) Tj
ET`);
        currentY -= 20;
      }

      // Draw table header function
      const drawTableHeader = () => {
        // Background rectangle
        currentOps.push(`
0.93 0.95 0.98 rg
${margins.left} ${currentY - 14} ${printableWidth} ${headerHeight} re
f`);
        // Border outline
        currentOps.push(`
0.75 0.80 0.88 RG
0.75 w
${margins.left} ${currentY - 14} ${printableWidth} ${headerHeight} re
S`);
        // Column labels
        currentOps.push(`
BT
/F2 9 Tf
0.1 0.2 0.4 rg
${margins.left + 8} ${currentY - 2} Td
(Salary Component) Tj
ET

BT
/F2 9 Tf
0.1 0.2 0.4 rg
${margins.left + col1W + 8} ${currentY - 2} Td
(Monthly (${escapePdf(currency)})) Tj
ET

BT
/F2 9 Tf
0.1 0.2 0.4 rg
${margins.left + col1W + col2W + 8} ${currentY - 2} Td
(Annual (${escapePdf(currency)})) Tj
ET`);
        currentY -= headerHeight;
      };

      drawTableHeader();

      // Draw rows one by one, seamlessly paginating across page boundaries
      for (let r = 0; r < salaryRows.length; r++) {
        const item = salaryRows[r];
        if (currentY - rowHeight < printableBottom + 20) {
          startNewPage();
          drawTableHeader();
        }

        const isTotal = item.category === 'total';
        const isSubtotal = item.category === 'subtotal';
        const isNet = item.category === 'net';

        // Row background styling
        if (isTotal || isNet) {
          currentOps.push(`
0.90 0.94 1.0 rg
${margins.left} ${currentY - 12} ${printableWidth} ${rowHeight} re
f`);
        } else if (isSubtotal) {
          currentOps.push(`
0.96 0.97 0.99 rg
${margins.left} ${currentY - 12} ${printableWidth} ${rowHeight} re
f`);
        } else if (r % 2 === 1) {
          currentOps.push(`
0.985 0.985 0.99 rg
${margins.left} ${currentY - 12} ${printableWidth} ${rowHeight} re
f`);
        }

        // Row bottom border
        currentOps.push(`
0.88 0.90 0.93 RG
0.5 w
${margins.left} ${currentY - 12} m
${margins.left + printableWidth} ${currentY - 12} l
S`);

        const fontTag = (isTotal || isSubtotal || isNet) ? '/F2' : '/F1';
        const fontSize = 8.5;
        const colColor = isTotal ? '0.05 0.15 0.35 rg' : (isNet ? '0.1 0.3 0.15 rg' : '0.15 0.15 0.15 rg');

        currentOps.push(`
BT
${fontTag} ${fontSize} Tf
${colColor}
${margins.left + 8} ${currentY} Td
(${escapePdf(item.name)}) Tj
ET

BT
${fontTag} ${fontSize} Tf
${colColor}
${margins.left + col1W + 8} ${currentY} Td
(${escapePdf(item.formattedMonthly)}) Tj
ET

BT
${fontTag} ${fontSize} Tf
${colColor}
${margins.left + col1W + col2W + 8} ${currentY} Td
(${escapePdf(item.formattedAnnual)}) Tj
ET`);
        currentY -= rowHeight;
      }
      currentY -= 14;
      continue;
    }

    // 8. Signature Block (Company Authorizer & Candidate Acceptance)
    if (type === 'signature_block') {
      const blockHeight = 110;
      ensureSpace(blockHeight);

      const colW = Math.round(printableWidth * 0.48);
      const col2Left = margins.left + printableWidth - colW;

      const authorizerName = interpolateText(section.authorizerName || variables['signature.authorizer_name'] || 'Talent Acquisition Team', variables);
      const authorizerTitle = interpolateText(section.authorizerTitle || variables['signature.authorizer_title'] || 'Authorized Signatory', variables);
      const signerName = interpolateText(section.signerName || variables['signature.signer_name'] || 'Candidate', variables);

      currentOps.push(`
BT
/F2 10 Tf
0.1 0.1 0.1 rg
${margins.left} ${currentY} Td
(For ${escapePdf(variables['company.name'] || 'Mechlin Technologies')}:) Tj
ET

BT
/F2 10 Tf
0.1 0.1 0.1 rg
${col2Left} ${currentY} Td
(Accepted and Agreed:) Tj
ET`);

      currentY -= 45;

      // Signature line rules
      currentOps.push(`
0.5 0.5 0.5 RG
0.75 w
${margins.left} ${currentY} m
${margins.left + colW} ${currentY} l
S

${col2Left} ${currentY} m
${col2Left + colW} ${currentY} l
S`);

      currentY -= 14;

      currentOps.push(`
BT
/F2 9 Tf
0.15 0.15 0.15 rg
${margins.left} ${currentY} Td
(${escapePdf(authorizerName)}) Tj
ET

BT
/F2 9 Tf
0.15 0.15 0.15 rg
${col2Left} ${currentY} Td
(${escapePdf(signerName)}) Tj
ET`);

      currentY -= 12;

      currentOps.push(`
BT
/F1 8 Tf
0.4 0.4 0.4 rg
${margins.left} ${currentY} Td
(${escapePdf(authorizerTitle)}) Tj
ET

BT
/F1 8 Tf
0.4 0.4 0.4 rg
${col2Left} ${currentY} Td
(Signature / Date) Tj
ET`);

      currentY -= 20;
      continue;
    }
  }

  // Push last page if ops exist
  if (currentOps.length > 0 || pages.length === 0) {
    pages.push({
      pageNumber: currentPageIndex + 1,
      ops: currentOps,
      images: currentImages
    });
  }

  const totalPages = pages.length;

  // Final pass: Compile each page with letterhead background, repeated headers, footers, and page numbers
  const compiledPages = [];

  for (let i = 0; i < pages.length; i++) {
    const pageObj = pages[i];
    const pageNum = i + 1;
    const isFirstPage = pageNum === 1;
    const isFinalPage = pageNum === totalPages;

    let backgroundStream = '';
    const pageImages = [...pageObj.images];

    // Background asset placement
    const bgAssetId = isFirstPage
      ? (backgroundConfig.firstPageAssetId || backgroundConfig.assetId)
      : (backgroundConfig.continuationAssetId || backgroundConfig.assetId);

    const bgParsed = bgAssetId ? assets[bgAssetId] : null;

    if (bgParsed) {
      const imgName = `BgImg_P${pageNum}`;
      pageImages.push({
        name: imgName,
        ...bgParsed
      });

      const drawW = bgParsed.placement?.width || pageWidth;
      const drawH = bgParsed.placement?.height || pageHeight;
      const drawX = bgParsed.placement?.x || 0;
      const drawY = bgParsed.placement?.y || 0;

      backgroundStream = `
q
${drawW} 0 0 ${drawH} ${drawX} ${drawY} cm
/${imgName} Do
Q
`;
    }

    // Header stream
    let headerStream = '';
    const showHeader = isFirstPage ? Boolean(headerConfig.showOnFirstPage) : (headerConfig.enabled !== false);
    if (showHeader && headerConfig.text) {
      const headerText = interpolateText(headerConfig.text, variables);
      headerStream = `
BT
/F1 8 Tf
0.5 0.5 0.5 rg
${margins.left} ${pageHeight - 32} Td
(${escapePdf(headerText)}) Tj
ET

0.85 0.85 0.85 RG
0.5 w
${margins.left} ${pageHeight - 38} m
${margins.left + printableWidth} ${pageHeight - 38} l
S
`;
    }

    // Footer stream with Page X of Y
    let footerStream = '';
    const showFooter = footerConfig.enabled !== false;
    if (showFooter) {
      const footerText = interpolateText(footerConfig.text || `${variables['company.name'] || 'Mechlin Technologies'} - Strictly Private & Confidential`, variables);
      const pageFormat = footerConfig.pageNumberFormat || 'Page {page} of {pages}';
      const pageNumberStr = pageFormat
        .replace('{page}', String(pageNum))
        .replace('{pages}', String(totalPages));

      const pageNumW = measureTextWidth(pageNumberStr, 8, false);

      footerStream = `
0.85 0.85 0.85 RG
0.5 w
${margins.left} 38 m
${margins.left + printableWidth} 38 l
S

BT
/F1 8 Tf
0.5 0.5 0.5 rg
${margins.left} 26 Td
(${escapePdf(footerText)}) Tj
ET

BT
/F1 8 Tf
0.5 0.5 0.5 rg
${margins.left + printableWidth - pageNumW} 26 Td
(${escapePdf(pageNumberStr)}) Tj
ET
`;
    }

    // Combine streams: background -> header -> content ops -> footer
    const streamText = `
${backgroundStream}
${headerStream}
${pageObj.ops.join('\n')}
${footerStream}
`;

    compiledPages.push({
      pageNumber: pageNum,
      totalPages,
      streamText,
      images: pageImages
    });
  }

  return compiledPages;
}
