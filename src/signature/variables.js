/**
 * Orbit ATS Offer Letter Variable Registry and Resolution Engine
 * Handles dynamic variable registration, extraction, formatting, conditionals,
 * payroll component calculation, and pre-generation validation.
 */

export const VARIABLE_REGISTRY = [
  // Company variables
  { key: 'company.name', label: 'Company Name', category: 'Company', example: 'Mechlin Technologies', required: true },
  { key: 'company.address', label: 'Company Address', category: 'Company', example: 'Plot No. 12, Tech Park, Phase 1, Mohali, Punjab 160055', required: false },
  { key: 'company.website', label: 'Company Website', category: 'Company', example: 'https://mechlintech.com', required: false },
  { key: 'company.email', label: 'Company Contact Email', category: 'Company', example: 'hr@mechlintech.com', required: false },
  { key: 'company.phone', label: 'Company Contact Phone', category: 'Company', example: '+91 172 500 0000', required: false },

  // Candidate variables
  { key: 'candidate.name', label: 'Candidate Full Name', category: 'Candidate', example: 'Alex Johnson', required: true },
  { key: 'candidate.first_name', label: 'Candidate First Name', category: 'Candidate', example: 'Alex', required: false },
  { key: 'candidate.last_name', label: 'Candidate Last Name', category: 'Candidate', example: 'Johnson', required: false },
  { key: 'candidate.email', label: 'Candidate Email', category: 'Candidate', example: 'alex.johnson@example.com', required: true },
  { key: 'candidate.phone', label: 'Candidate Phone', category: 'Candidate', example: '+1 (555) 019-2834', required: false },
  { key: 'candidate.address', label: 'Candidate Address', category: 'Candidate', example: '742 Evergreen Terrace, Springfield', required: false },

  // Job / Requisition variables
  { key: 'requisition.title', label: 'Job / Requisition Title', category: 'Requisition', example: 'Senior Full Stack Engineer', required: true },
  { key: 'requisition.department', label: 'Department / Team', category: 'Requisition', example: 'Product Engineering', required: false },
  { key: 'requisition.team', label: 'Team Name', category: 'Requisition', example: 'Core Platform', required: false },
  { key: 'employment.designation', label: 'Designation', category: 'Employment', example: 'Senior Software Engineer', required: true },
  { key: 'employment.manager', label: 'Reporting Manager', category: 'Employment', example: 'Engineering Director', required: false },
  { key: 'employment.location', label: 'Work Location', category: 'Employment', example: 'Mohali, India (Hybrid)', required: false },
  { key: 'employment.joining_date', label: 'Anticipated Joining Date', category: 'Employment', example: 'November 15, 2026', required: true },
  { key: 'employment.employment_type', label: 'Employment Type', category: 'Employment', example: 'Full-time Regular', required: false },
  { key: 'employment.probation_period', label: 'Probation Period', category: 'Employment', example: '3 months', required: false },
  { key: 'employment.notice_period', label: 'Notice Period', category: 'Employment', example: '30 days', required: false },

  // Compensation variables
  { key: 'offer.salary', label: 'Annual Salary / CTC (Clean)', category: 'Compensation', example: '120,000', required: true },
  { key: 'offer.currency', label: 'Currency Code', category: 'Compensation', example: 'INR', required: true },
  { key: 'offer.currency_symbol', label: 'Currency Symbol', category: 'Compensation', example: '₹', required: false },
  { key: 'offer.salary_period', label: 'Salary Period', category: 'Compensation', example: 'per annum', required: false },
  { key: 'offer.annual_ctc', label: 'Annual CTC Display', category: 'Compensation', example: 'INR 120,000', required: true },
  { key: 'offer.monthly_ctc', label: 'Monthly CTC Display', category: 'Compensation', example: 'USD 10,000', required: false },
  { key: 'offer.variable_bonus', label: 'Variable Bonus / Incentive', category: 'Compensation', example: '10% performance incentive', required: false },
  { key: 'offer.benefits', label: 'Standard Benefits Summary', category: 'Compensation', example: 'Comprehensive medical coverage, provident fund, and annual paid leave', required: false },

  // Offer / Signing variables
  { key: 'offer.date', label: 'Offer Date', category: 'Offer', example: 'October 26, 2026', required: true },
  { key: 'offer.expiry_date', label: 'Offer Expiry Date', category: 'Offer', example: 'November 2, 2026', required: true },
  { key: 'offer.reference_number', label: 'Offer Reference Number', category: 'Offer', example: 'MECH-OFF-2026-0842', required: false },
  { key: 'offer.acceptance_instructions', label: 'Acceptance Instructions', category: 'Offer', example: 'Please review and execute your electronic signature via the secure link provided.', required: false },
  { key: 'signature.signer_name', label: 'Primary Signer Name', category: 'Signatures', example: 'Alex Johnson', required: true },
  { key: 'signature.signer_role', label: 'Signer Role', category: 'Signatures', example: 'Candidate', required: false },
  { key: 'signature.authorizer_name', label: 'Company Authorizer Name', category: 'Signatures', example: 'Talent Acquisition Team', required: false },
  { key: 'signature.authorizer_title', label: 'Company Authorizer Title', category: 'Signatures', example: 'Head of People & Culture', required: false }
];

export const CURRENCY_SYMBOLS = {
  USD: '$',
  INR: '₹',
  EUR: '€',
  GBP: '£',
  CAD: 'CA$',
  AUD: 'AU$',
  SGD: 'SG$',
  AED: 'AED '
};

/**
 * Formats a numeric string or number into standard comma-separated currency representation.
 */
export function formatCurrencyValue(num) {
  if (num === null || num === undefined || num === '') return '0';
  const clean = String(num).replace(/[^0-9.-]/g, '');
  const parsed = Number.parseFloat(clean);
  if (!Number.isFinite(parsed)) return String(num);
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: parsed % 1 === 0 ? 0 : 2
  }).format(parsed);
}

/**
 * Resolves context values for a given candidate, requisition, and approved offer data.
 */
export function resolveOfferVariables({
  company = {},
  candidate = {},
  requisition = {},
  offer = {},
  user = {},
  customVariables = {}
} = {}) {
  const now = new Date();
  const offerDateStr = offer.date
    ? new Date(offer.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const expiryDays = Number(offer.expires_days) || 7;
  const expiryDate = offer.expiry_date
    ? new Date(offer.expiry_date)
    : new Date(now.getTime() + expiryDays * 86400000);
  const expiryDateStr = expiryDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const currency = String(offer.currency || requisition.currency || 'INR').trim().toUpperCase();
  const currencySymbol = CURRENCY_SYMBOLS[currency] || `${currency} `;

  // Ensure candidate approved salary is the source of truth
  const rawSalary = offer.salary !== undefined && offer.salary !== null && String(offer.salary).trim() !== ''
    ? String(offer.salary)
    : (requisition.salary_max ? String(requisition.salary_max) : '100,000');

  const cleanNumericSalary = rawSalary.replace(/^(?:INR|USD|EUR|GBP|CAD|AUD|₹|\$|€|£)\s*/i, '').replace(/,/g, '').trim();
  const annualAmount = Number.parseFloat(cleanNumericSalary) || 0;
  const monthlyAmount = annualAmount > 0 ? Math.round(annualAmount / 12) : 0;

  const formattedAnnual = formatCurrencyValue(annualAmount);
  const formattedMonthly = formatCurrencyValue(monthlyAmount);

  const candName = candidate.name || 'Candidate';
  const nameParts = candName.trim().split(/\s+/);
  const firstName = nameParts[0] || 'Candidate';
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

  const refNumber = offer.reference_number || `MECH-${now.getFullYear()}-${(candidate.id || '0000').slice(0, 8).toUpperCase()}`;

  const resolved = {
    // Company
    'company.name': company.name || 'Mechlin Technologies',
    'company.address': company.address || 'Plot No. 12, Tech Park, Phase 1, Mohali, Punjab 160055',
    'company.website': company.website || 'https://mechlintech.com',
    'company.email': company.email || 'hr@mechlintech.com',
    'company.phone': company.phone || '+91 172 500 0000',

    // Candidate
    'candidate.name': candName,
    'candidate.first_name': firstName,
    'candidate.last_name': lastName,
    'candidate.email': candidate.email || '',
    'candidate.phone': candidate.phone || '',
    'candidate.address': candidate.address || candidate.location || 'Current Address on Record',

    // Requisition / Employment
    'requisition.title': requisition.title || 'Open Position',
    'requisition.department': requisition.team || user.team || 'Engineering',
    'requisition.team': requisition.team || user.team || 'Engineering',
    'employment.designation': offer.designation || requisition.title || 'Specialist',
    'employment.manager': offer.manager || 'Hiring Manager / Department Lead',
    'employment.location': offer.location || 'Mohali, India (Hybrid)',
    'employment.joining_date': offer.start_date || 'Two weeks following signature acceptance',
    'employment.employment_type': offer.employment_type || 'Full-time Regular',
    'employment.probation_period': offer.probation_period || '3 months',
    'employment.notice_period': offer.notice_period || '30 days',

    // Compensation
    'offer.salary': formattedAnnual,
    'offer.currency': currency,
    'offer.currency_symbol': currencySymbol,
    'offer.salary_period': offer.salary_period || 'per annum',
    'offer.annual_ctc': `${currency} ${formattedAnnual}`,
    'offer.monthly_ctc': `${currency} ${formattedMonthly}`,
    'offer.variable_bonus': offer.variable_bonus || '',
    'offer.benefits': offer.benefits || 'Standard company health insurance, retirement benefit contributions, and paid leave as per company policy.',

    // Offer & Signing
    'offer.date': offerDateStr,
    'offer.expiry_date': expiryDateStr,
    'offer.reference_number': refNumber,
    'offer.acceptance_instructions': offer.acceptance_instructions || 'Please review this agreement and electronically execute your acceptance using the signature block below.',
    'signature.signer_name': candName,
    'signature.signer_role': 'Candidate',
    'signature.authorizer_name': offer.authorizer_name || user.name || 'Talent Acquisition Team',
    'signature.authorizer_title': offer.authorizer_title || 'Head of Talent Acquisition',

    // Custom overrides
    ...customVariables
  };

  return resolved;
}

/**
 * Calculates standard, legally compliant payroll breakdown components
 * matching verified Orbit and HRMS compensation rules.
 */
export function calculateSalaryStructure(annualCtcInput, currency = 'INR', customRows = null) {
  const clean = String(annualCtcInput || 0).replace(/[^0-9.-]/g, '');
  const ctc = Number.parseFloat(clean) || 0;
  const curr = String(currency || 'INR').trim().toUpperCase();

  if (Array.isArray(customRows) && customRows.length > 0) {
    return customRows.map(row => {
      const annual = Number(row.annual) || 0;
      const monthly = row.monthly !== undefined ? Number(row.monthly) : Math.round(annual / 12);
      return {
        name: row.name || 'Component',
        category: row.category || 'allowance',
        monthly,
        annual,
        formattedMonthly: `${curr} ${formatCurrencyValue(monthly)}`,
        formattedAnnual: `${curr} ${formatCurrencyValue(annual)}`
      };
    });
  }

  // Standard verified compensation components (Indian / Global ATS breakdown)
  const isInr = curr === 'INR';

  // 1. Basic Pay: 50% of annual CTC
  const basicAnnual = Math.round(ctc * 0.50);
  const basicMonthly = Math.round(basicAnnual / 12);

  // 2. House Rent Allowance (HRA): 50% of Basic (25% of CTC)
  const hraAnnual = Math.round(basicAnnual * 0.50);
  const hraMonthly = Math.round(hraAnnual / 12);

  // 3. Provident Fund (Employer Contribution): 12% of Basic or standard statutory
  const pfMonthlyRate = isInr ? Math.min(Math.round(basicMonthly * 0.12), 1800) : Math.round(basicMonthly * 0.10);
  const pfAnnual = pfMonthlyRate * 12;
  const pfMonthly = pfMonthlyRate;

  // 4. Gratuity (Employer Contribution): ~4.81% of Basic
  const gratuityAnnual = Math.round(basicAnnual * 0.0481);
  const gratuityMonthly = Math.round(gratuityAnnual / 12);

  // 5. Special Allowance: balance of (CTC - Basic - HRA - PF - Gratuity)
  const specialAnnual = Math.max(0, ctc - basicAnnual - hraAnnual - pfAnnual - gratuityAnnual);
  const specialMonthly = Math.round(specialAnnual / 12);

  // 6. Gross Salary (Basic + HRA + Special Allowance)
  const grossAnnual = basicAnnual + hraAnnual + specialAnnual;
  const grossMonthly = basicMonthly + hraMonthly + specialMonthly;

  // 7. Employee PF Deduction (matches employer PF)
  const empPfMonthly = pfMonthly;
  const empPfAnnual = pfAnnual;

  // 8. Professional Tax / Statutory Tax
  const ptMonthly = isInr ? 200 : 0;
  const ptAnnual = ptMonthly * 12;

  // 9. Total Deductions
  const deductionsMonthly = empPfMonthly + ptMonthly;
  const deductionsAnnual = empPfAnnual + ptAnnual;

  // 10. Net In-Hand Salary
  const netMonthly = grossMonthly - deductionsMonthly;
  const netAnnual = grossAnnual - deductionsAnnual;

  const rows = [
    { name: 'Basic Salary', category: 'earnings', monthly: basicMonthly, annual: basicAnnual },
    { name: 'House Rent Allowance (HRA)', category: 'earnings', monthly: hraMonthly, annual: hraAnnual },
    { name: 'Special Allowance', category: 'earnings', monthly: specialMonthly, annual: specialAnnual },
    { name: 'Gross Salary (A)', category: 'subtotal', monthly: grossMonthly, annual: grossAnnual },
    { name: 'Employer PF Contribution', category: 'retirals', monthly: pfMonthly, annual: pfAnnual },
    { name: 'Gratuity Contribution', category: 'retirals', monthly: gratuityMonthly, annual: gratuityAnnual },
    { name: 'Total Retiral Benefits (B)', category: 'subtotal', monthly: pfMonthly + gratuityMonthly, annual: pfAnnual + gratuityAnnual },
    { name: 'Total Cost to Company (CTC = A + B)', category: 'total', monthly: Math.round(ctc / 12), annual: ctc },
    { name: 'Employee PF Deduction', category: 'deductions', monthly: empPfMonthly, annual: empPfAnnual }
  ];

  if (ptMonthly > 0) {
    rows.push({ name: 'Professional Tax', category: 'deductions', monthly: ptMonthly, annual: ptAnnual });
  }

  rows.push({
    name: 'Total Deductions (C)',
    category: 'subtotal',
    monthly: deductionsMonthly,
    annual: deductionsAnnual
  });

  rows.push({
    name: 'Net Take-Home Pay (Estimated = A - C)',
    category: 'net',
    monthly: netMonthly,
    annual: netAnnual
  });

  return rows.map(r => ({
    ...r,
    formattedMonthly: `${curr} ${formatCurrencyValue(r.monthly)}`,
    formattedAnnual: `${curr} ${formatCurrencyValue(r.annual)}`
  }));
}

/**
 * Replaces {{variable}} tags with resolved values, handling conditionals:
 * {{#if variable}}...{{/if}}
 * {{#if variable}}...{{else}}...{{/if}}
 * {{#unless variable}}...{{/unless}}
 */
export function interpolateText(text, variables = {}) {
  if (!text) return '';
  let str = String(text);

  // 1. Process {{#if variable}}...{{else}}...{{/if}}
  str = str.replace(/\{\{#if\s+([a-zA-Z0-9_.]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g, (_, key, truthyContent, falsyContent) => {
    const val = variables[key];
    const isTruthy = Boolean(val && String(val).trim() !== '' && val !== '0');
    return isTruthy ? truthyContent : (falsyContent || '');
  });

  // 2. Process {{#unless variable}}...{{/unless}}
  str = str.replace(/\{\{#unless\s+([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g, (_, key, content) => {
    const val = variables[key];
    const isFalsy = !val || String(val).trim() === '' || val === '0';
    return isFalsy ? content : '';
  });

  // 3. Process direct {{variable}} replacement
  str = str.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      const val = variables[key];
      return val !== null && val !== undefined ? String(val) : '';
    }
    return match; // Keep unchanged if not in dictionary
  });

  return str;
}

/**
 * Validates a template against resolved values and reports any missing required variables
 * or unresolved placeholders.
 */
export function validateTemplateVariables(templateSections = [], resolvedVariables = {}) {
  const contentStr = JSON.stringify(templateSections);
  const foundVariables = new Set();
  const regex = /\{\{([a-zA-Z0-9_.]+)\}\}/g;
  let match;
  while ((match = regex.exec(contentStr)) !== null) {
    if (!match[1].startsWith('#') && !match[1].startsWith('/') && match[1] !== 'else') {
      foundVariables.add(match[1]);
    }
  }

  const missing = [];
  const warnings = [];

  for (const vKey of foundVariables) {
    const registryEntry = VARIABLE_REGISTRY.find(r => r.key === vKey);
    const val = resolvedVariables[vKey];
    const isEmpty = val === undefined || val === null || String(val).trim() === '';

    if (isEmpty) {
      if (registryEntry?.required) {
        missing.push({
          key: vKey,
          label: registryEntry?.label || vKey,
          category: registryEntry?.category || 'General',
          required: true
        });
      } else {
        warnings.push({
          key: vKey,
          label: registryEntry?.label || vKey,
          category: registryEntry?.category || 'General',
          required: false
        });
      }
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
    totalVariablesCount: foundVariables.size
  };
}
