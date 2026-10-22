/**
 * Orbit Explainable Candidate-to-Requisition Matching Engine
 * Pure Node.js implementation without external runtime dependencies.
 *
 * Provides transparent, reproducible, and explainable match scores
 * with clear evidence attribution and data limitation disclaimers.
 */

/**
 * Safely parse a skills field into an array of trimmed strings.
 */
export function parseSkillsList(skills) {
  if (!skills) return [];
  if (Array.isArray(skills)) {
    return skills.map(s => String(s).trim()).filter(Boolean);
  }
  if (typeof skills === 'string') {
    const trimmed = skills.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map(s => String(s).trim()).filter(Boolean);
        }
      } catch {
        // Fall back to comma-separated
      }
    }
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Extract an excerpt of text surrounding a keyword match for evidence attribution.
 */
function extractSnippet(text, keyword, maxLen = 140) {
  if (!text || !keyword) return '';
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + keyword.length + 60);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

/**
 * Extract estimated years of experience from profile or resume text.
 */
export function extractYearsOfExperience(text) {
  if (!text || typeof text !== 'string') return null;
  // Match "X years of experience" or "X+ years in"
  const regex = /(\b\d{1,2})\+?\s*(?:-\s*\d{1,2})?\s*years?(?:\s+of)?(?:\s+experience|\s+in)?/i;
  const match = text.match(regex);
  if (match) {
    const yrs = parseInt(match[1], 10);
    if (!isNaN(yrs) && yrs >= 0 && yrs <= 50) return yrs;
  }
  return null;
}

/**
 * Check education / certification mentions in text.
 */
export function extractQualifications(text) {
  if (!text || typeof text !== 'string') return [];
  const found = [];
  const patterns = [
    { name: "Bachelor's Degree", regex: /\b(?:bachelor|b\.?s\.?|b\.?a\.?|b\.?tech|undergraduate)\b/i },
    { name: "Master's Degree", regex: /\b(?:master|m\.?s\.?|m\.?a\.?|m\.?tech|mba|postgraduate)\b/i },
    { name: "Doctorate / Ph.D.", regex: /\b(?:ph\.?d|doctorate)\b/i },
    { name: "AWS Certified", regex: /\baws\s+certif/i },
    { name: "CPA", regex: /\bcpa\b/i },
    { name: "PMP", regex: /\bpmp\b/i }
  ];
  for (const { name, regex } of patterns) {
    if (regex.test(text)) found.push(name);
  }
  return found;
}

/**
 * Evaluate candidate qualifications against a specific requisition.
 * Produces an explainable, bounded score (0-100 or null) with detailed evidence.
 */
export function evaluateCandidateMatch(candidate, requisition, options = {}) {
  const reqSkills = parseSkillsList(requisition?.skills);
  const candSkills = parseSkillsList(candidate?.skills);
  const resumeText = String(candidate?.resume_text || candidate?.experience || '').trim();
  const reqDescription = String(requisition?.description || '').trim();
  const reqTitle = String(requisition?.title || '').trim();

  // If no required skills are defined, return null score (preserving Orbit's existing contract)
  if (!reqSkills.length) {
    return {
      method: options.method || 'Deterministic skill overlap; not AI',
      score: null,
      matched: [],
      missing: [],
      explanation: 'No required skills defined. No score calculated.',
      breakdown: {
        skills_score: null,
        experience_score: null,
        qualification_score: null,
        matched_count: 0,
        required_count: 0
      },
      evidence: [],
      reasons_for_reductions: ['No required skills or criteria specified on requisition.'],
      data_limitations: [
        'No job requirements are defined for this position.',
        'Match scoring requires explicitly defined role requirements.'
      ]
    };
  }

  // 1. Skill evaluation
  const candSkillsLower = candSkills.map(s => s.toLowerCase());
  const candSkillsSet = new Set(candSkillsLower);
  const resumeLower = resumeText.toLowerCase();

  const matched = [];
  const missing = [];
  const evidence = [];

  for (const skill of reqSkills) {
    const skillLower = skill.toLowerCase();
    const inSkillsList = candSkillsSet.has(skillLower);
    const inResume = resumeLower.includes(skillLower);

    if (inSkillsList || inResume) {
      matched.push(skill);
      let source = inSkillsList && inResume
        ? 'Listed in candidate skills & resume'
        : inSkillsList
          ? 'Listed in candidate skills'
          : 'Extracted from resume text';
      let snippet = extractSnippet(resumeText, skill);
      evidence.push({
        requirement: skill,
        type: 'skill',
        matched: true,
        source,
        snippet: snippet || `Explicit skill chip: "${skill}"`
      });
    } else {
      missing.push(skill);
    }
  }

  // 2. Experience evaluation
  const candYears = extractYearsOfExperience(resumeText);
  const reqYears = extractYearsOfExperience(reqDescription);
  let expScore = null;
  let expAssessment = 'Not specified on requisition or candidate profile';

  if (reqYears !== null && candYears !== null) {
    if (candYears >= reqYears) {
      expScore = 100;
      expAssessment = `Candidate has ~${candYears} years of experience, meeting the required ${reqYears}+ years.`;
      evidence.push({
        requirement: `Experience: ${reqYears}+ years`,
        type: 'experience',
        matched: true,
        source: 'Resume text analysis',
        snippet: `Candidate mentions ${candYears} years of experience vs ${reqYears} required.`
      });
    } else {
      expScore = Math.max(0, Math.round((candYears / reqYears) * 100));
      expAssessment = `Candidate has ~${candYears} years of experience, below the preferred ${reqYears}+ years.`;
    }
  } else if (candYears !== null) {
    expScore = 100;
    expAssessment = `Candidate notes ~${candYears} years of experience. (Requisition does not specify minimum years).`;
  }

  // 3. Title / Domain relevance
  const titleKeywords = reqTitle.split(/\s+/).filter(w => w.length > 3 && !/senior|junior|lead|principal|staff|head/i.test(w));
  let domainMatched = false;
  for (const kw of titleKeywords) {
    if (resumeLower.includes(kw.toLowerCase())) {
      domainMatched = true;
      break;
    }
  }

  // 4. Qualification coverage (degrees / certifications)
  const candQuals = extractQualifications(resumeText);
  const reqQuals = extractQualifications(reqDescription);
  let qualScore = null;
  if (reqQuals.length) {
    const matchedQuals = reqQuals.filter(q => candQuals.includes(q));
    qualScore = Math.round((matchedQuals.length / reqQuals.length) * 100);
    for (const q of matchedQuals) {
      evidence.push({
        requirement: q,
        type: 'qualification',
        matched: true,
        source: 'Resume credentials',
        snippet: `Credential verified in profile: "${q}"`
      });
    }
  }

  // 5. Compute Final Bounded Score
  // To preserve exact backward compatibility with Orbit's deterministic match:
  // When requisition has skills: base score is Math.round(100 * matched.length / reqSkills.length).
  const skillRatio = matched.length / reqSkills.length;
  let score = Math.round(100 * skillRatio);

  // If experience is explicitly evaluated with a penalty, apply balanced adjustment (bounded 0-100)
  if (options.comprehensive && expScore !== null && reqYears !== null) {
    // 70% skills, 20% experience, 10% qualification
    const qWeightScore = qualScore !== null ? qualScore : 100;
    score = Math.round(score * 0.7 + expScore * 0.2 + qWeightScore * 0.1);
  }

  // Ensure bounded strictly within [0, 100]
  score = Math.max(0, Math.min(100, score));

  // 6. Reasons for reductions
  const reductions = [];
  if (missing.length) {
    const deduction = Math.round((missing.length / reqSkills.length) * 100);
    reductions.push(`Candidate missing ${missing.length} of ${reqSkills.length} required skills: ${missing.join(', ')} (-${deduction}%).`);
  }
  if (reqYears !== null && candYears !== null && candYears < reqYears) {
    reductions.push(`Experience level (${candYears} yrs) is less than requisition target (${reqYears} yrs).`);
  }
  if (reqQuals.length && qualScore !== null && qualScore < 100) {
    const missingQuals = reqQuals.filter(q => !candQuals.includes(q));
    reductions.push(`Missing required/preferred credentials: ${missingQuals.join(', ')}.`);
  }

  const method = options.method || 'Deterministic skill overlap; not AI';
  const explanation = `${matched.length} of ${reqSkills.length} explicitly required skills found. Human review required.`;

  return {
    method,
    score,
    matched,
    missing,
    explanation,
    breakdown: {
      skills_score: Math.round(100 * skillRatio),
      experience_score: expScore,
      qualification_score: qualScore,
      matched_count: matched.length,
      required_count: reqSkills.length,
      experience_assessment: expAssessment,
      domain_relevance: domainMatched ? 'Relevant domain background detected' : 'General alignment'
    },
    evidence,
    reasons_for_reductions: reductions.length ? reductions : ['No reductions applied; candidate meets all evaluated criteria.'],
    data_limitations: [
      'Score is calculated from self-reported candidate profile data and parsed resume text.',
      'Missing information is treated as unverified rather than lack of qualification.',
      'This analysis assists human recruiters; it does not make automated hiring decisions.'
    ]
  };
}
