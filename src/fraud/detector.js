/**
 * Orbit Fraud and Inconsistency Review Detector
 * Pure Node.js rule-based and heuristic consistency review engine.
 *
 * Emits evidence-linked review signals for authorized human assessment.
 * CRITICAL SAFEGUARD: Flags are review hypotheses for recruiters to verify,
 * NEVER automated proof of fraud or basis for automatic disqualification.
 */

import { randomUUID } from 'node:crypto';

// Technology release years for timeline consistency checking
const TECH_RELEASE_YEARS = {
  react: 2013,
  kubernetes: 2014,
  k8s: 2014,
  docker: 2013,
  typescript: 2012,
  swift: 2014,
  rust: 2015,
  flutter: 2017,
  nextjs: 2016,
  graphql: 2015,
  solidity: 2014,
  vue: 2014
};

const CURRENT_YEAR = new Date().getFullYear();

/**
 * Check for inverted or impossible date ranges in resume text.
 */
export function detectDateInconsistencies(text = '') {
  if (!text || typeof text !== 'string') return [];
  const flags = [];

  // Match "YYYY - YYYY" or "YYYY to YYYY" or "MM/YYYY - MM/YYYY"
  const dateRangeRegex = /\b(19\d\d|20\d\d)\s*(?:-|–|—|to)\s*(19\d\d|20\d\d)\b/gi;
  let match;

  while ((match = dateRangeRegex.exec(text)) !== null) {
    const startYear = parseInt(match[1], 10);
    const endYear = parseInt(match[2], 10);

    // Inverted date range (end before start)
    if (endYear < startYear) {
      flags.push({
        id: randomUUID(),
        category: 'date_inconsistency',
        severity: 'medium',
        title: 'Inverted Employment/Education Dates',
        description: `Found timeline range where end year (${endYear}) precedes start year (${startYear}).`,
        evidence: `Snippet: "${match[0]}"`,
        recommendation: 'Verify dates with candidate to determine if this is a typographical error.'
      });
    }

    // Future years claiming past employment/education
    if (startYear > CURRENT_YEAR + 1 || endYear > CURRENT_YEAR + 1) {
      flags.push({
        id: randomUUID(),
        category: 'future_date_anomaly',
        severity: 'medium',
        title: 'Future Date Listed in Timeline',
        description: `Found date range referencing future year (${Math.max(startYear, endYear)}).`,
        evidence: `Snippet: "${match[0]}"`,
        recommendation: 'Confirm whether date indicates prospective graduation or entry error.'
      });
    }
  }

  return flags;
}

/**
 * Check for unrealistic technology experience claims exceeding the age of the technology.
 */
export function detectTechTimelineMismatches(text = '', skills = []) {
  if (!text && !skills.length) return [];
  const flags = [];
  const combined = (text + ' ' + skills.join(' ')).toLowerCase();

  for (const [tech, releaseYear] of Object.entries(TECH_RELEASE_YEARS)) {
    const maxPossibleYears = CURRENT_YEAR - releaseYear + 1;
    // Match "X+ years with Tech" or "X years of Tech experience"
    const pattern = new RegExp(`(\\b\\d{1,2})\\+?\\s*(?:years?(?:\\s+of)?(?:\\s+experience)?(?:\\s+with|\\s+in)?\\s+${tech}|${tech}[^.]*?(\\b\\d{1,2})\\+?\\s*years?)`, 'i');
    const m = combined.match(pattern);

    if (m) {
      const claimedYears = parseInt(m[1] || m[2], 10);
      if (!isNaN(claimedYears) && claimedYears > maxPossibleYears) {
        flags.push({
          id: randomUUID(),
          category: 'tech_timeline_mismatch',
          severity: 'medium',
          title: `Unlikely Experience Claim for ${tech.charAt(0).toUpperCase() + tech.slice(1)}`,
          description: `Claimed ${claimedYears} years of ${tech} experience, but ${tech} was released in ${releaseYear} (maximum possible: ~${maxPossibleYears} years).`,
          evidence: `Claimed ${claimedYears} years vs release year ${releaseYear}.`,
          recommendation: 'Ask candidate to clarify total software experience vs specific technology tenure.'
        });
      }
    }
  }

  return flags;
}

/**
 * Check for adversarial prompt injection patterns in candidate text.
 */
export function detectPromptInjectionAttempts(text = '') {
  if (!text || typeof text !== 'string') return [];
  const flags = [];

  const injectionPatterns = [
    { pattern: /ignore\s+(?:all\s+)?previous\s+instructions/i, name: 'Instruction override directive' },
    { pattern: /system\s+prompt\s+override/i, name: 'System prompt override marker' },
    { pattern: /always\s+return\s+(?:a\s+)?score\s+(?:of\s+)?100/i, name: 'Score tampering directive' },
    { pattern: /mark\s+this\s+candidate\s+as\s+(?:highly\s+)?qualified/i, name: 'Qualification falsification prompt' },
    { pattern: /<\/?candidate_untrusted_input>/i, name: 'Sandbox breakout tag injection' },
    { pattern: /bypass\s+(?:ats|ai|screening|matching)\s+rules/i, name: 'Screening rule bypass prompt' }
  ];

  for (const { pattern, name } of injectionPatterns) {
    const match = text.match(pattern);
    if (match) {
      flags.push({
        id: randomUUID(),
        category: 'prompt_injection_attempt',
        severity: 'high',
        title: 'Adversarial Prompt Injection Marker Detected',
        description: `Resume text contains instructions attempting to alter automated evaluation (${name}).`,
        evidence: `Triggered phrase: "${match[0]}"`,
        recommendation: 'Human recruiter must review original document. Automated scoring guardrails prevent influence.'
      });
    }
  }

  return flags;
}

/**
 * Check for keyword stuffing or unnatural keyword repetition.
 */
export function detectKeywordStuffing(text = '', skills = []) {
  if (!text || typeof text !== 'string') return [];
  const flags = [];
  const words = text.toLowerCase().split(/\s+/);

  for (const skill of skills) {
    const sLower = skill.toLowerCase();
    if (sLower.length < 3) continue;
    const occurrences = words.filter(w => w === sLower || w.includes(sLower)).length;

    if (occurrences >= 15 && text.length < 3000) {
      flags.push({
        id: randomUUID(),
        category: 'keyword_stuffing',
        severity: 'low',
        title: `Excessive Skill Repetition: "${skill}"`,
        description: `Skill "${skill}" occurs ${occurrences} times in a relatively short profile text.`,
        evidence: `Count: ${occurrences} occurrences.`,
        recommendation: 'Inspect document to verify if repeated terms represent hidden or copied text.'
      });
    }
  }

  return flags;
}

/**
 * Check for duplicate candidate profiles across the database.
 */
export function detectDuplicateProfiles(db, candidate) {
  if (!db || !candidate) return [];
  const flags = [];

  try {
    // 1. Phone number match
    if (candidate.phone && candidate.phone.trim()) {
      const cleanPhone = candidate.phone.replace(/\D/g, '');
      if (cleanPhone.length >= 7) {
        const matches = db.prepare(`
          SELECT id, name, email, team FROM candidates
          WHERE id != ? AND replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
        `).all(candidate.id, `%${cleanPhone}%`);

        if (matches.length > 0) {
          flags.push({
            id: randomUUID(),
            category: 'duplicate_phone',
            severity: 'medium',
            title: 'Shared Phone Number with Another Candidate',
            description: `Phone number matches ${matches.length} other candidate profile(s) (${matches.map(m => m.name).join(', ')}).`,
            evidence: `Matches candidate ID(s): ${matches.map(m => m.id).join(', ')}`,
            recommendation: 'Verify candidate identity and check whether an existing profile can be consolidated.'
          });
        }
      }
    }

    // 2. Email alias / plus-addressing match
    if (candidate.email && candidate.email.includes('+')) {
      const baseEmail = candidate.email.replace(/\+[^@]+@/, '@');
      const matches = db.prepare(`
        SELECT id, name, email FROM candidates
        WHERE id != ? AND email = ? COLLATE NOCASE
      `).all(candidate.id, baseEmail);

      if (matches.length > 0) {
        flags.push({
          id: randomUUID(),
          category: 'email_alias_duplicate',
          severity: 'low',
          title: 'Email Alias of Existing Candidate Profile',
          description: `Email uses plus-addressing corresponding to base address ${baseEmail}.`,
          evidence: `Original profile: ${matches[0].name} (${matches[0].email})`,
          recommendation: 'Review whether candidate created multiple submissions with email tags.'
        });
      }
    }

    // 3. Identical name in same team
    if (candidate.name && candidate.team) {
      const nameMatches = db.prepare(`
        SELECT id, name, email, team FROM candidates
        WHERE id != ? AND name = ? COLLATE NOCASE AND team = ?
      `).all(candidate.id, candidate.name, candidate.team);

      if (nameMatches.length > 0) {
        flags.push({
          id: randomUUID(),
          category: 'name_team_match',
          severity: 'low',
          title: 'Identical Name in Same Team',
          description: `Another profile with the exact name "${candidate.name}" exists in team "${candidate.team}".`,
          evidence: `Matches candidate ${nameMatches[0].name} (${nameMatches[0].email})`,
          recommendation: 'Check if this candidate has reapplied under a different email address.'
        });
      }
    }
  } catch {
    // Database errors or table missing
  }

  return flags;
}

/**
 * Run all consistency and fraud review checks for a candidate.
 */
export function analyzeFraudRisk(candidate, options = {}) {
  const text = String(candidate?.resume_text || candidate?.experience || '');
  const skills = Array.isArray(candidate?.skills) ? candidate.skills : [];
  const db = options.db || null;

  const flags = [
    ...detectDateInconsistencies(text),
    ...detectTechTimelineMismatches(text, skills),
    ...detectPromptInjectionAttempts(text),
    ...detectKeywordStuffing(text, skills),
    ...(db ? detectDuplicateProfiles(db, candidate) : [])
  ];

  // Determine overall risk level
  const hasHigh = flags.some(f => f.severity === 'high');
  const hasMedium = flags.some(f => f.severity === 'medium');

  let riskLevel = 'low';
  if (hasHigh) {
    riskLevel = 'high';
  } else if (hasMedium) {
    riskLevel = 'medium';
  }

  return {
    candidate_id: candidate?.id,
    risk_level: riskLevel,
    flags,
    flag_count: flags.length,
    analyzed_at: new Date().toISOString(),
    safeguards: [
      'Flags are indicators for human recruiter verification, NOT proof of fraud.',
      'Candidates must not be disqualified or rejected based solely on review flags.',
      'All flagged items require authorized human evaluation and explanation.'
    ]
  };
}
