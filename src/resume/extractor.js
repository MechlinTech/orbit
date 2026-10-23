/**
 * Resume Details Extractor for Orbit
 * Extracts candidate full name and skills from resume plain text.
 */

const NON_NAME_WORDS = new Set([
  'resume', 'curriculum', 'vitae', 'cv', 'profile', 'summary', 'experience',
  'education', 'skills', 'contact', 'phone', 'email', 'address', 'page',
  'developer', 'engineer', 'architect', 'manager', 'director', 'lead',
  'experienced', 'professional', 'senior', 'junior', 'principal', 'staff',
  'university', 'college', 'school', 'company', 'technologies', 'project',
  'projects', 'references', 'work', 'history', 'job', 'title', 'role',
  'objective', 'about', 'reach', 'browser', 'test', 'candidate', 'recruiter',
  'employee', 'user', 'hiring', 'applicant', 'certified', 'associate',
  'name', 'full'
]);

const TITLE_WORDS = new Set([
  'engineer', 'developer', 'architect', 'consultant', 'manager',
  'director', 'lead', 'specialist', 'analyst', 'administrator',
  'designer', 'scientist', 'technician', 'programmer', 'tester',
  'officer', 'coordinator', 'leader', 'expert'
]);

const TITLE_MODIFIERS = new Set([
  'senior', 'junior', 'principal', 'staff', 'lead', 'chief', 'associate',
  'full', 'stack', 'frontend', 'backend', 'cloud', 'devops', 'qa',
  'software', 'systems', 'data', 'product', 'project', 'executive',
  'experienced', 'certified', 'head'
]);

function cleanName(str) {
  if (!str) return '';
  return str
    .replace(/[^a-zA-Z\s'\-.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripJobTitle(str) {
  if (!str) return '';
  const words = str.split(/\s+/);
  // Strip trailing title words (up to 3 words from the end)
  while (words.length > 2) {
    const lastWord = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '');
    if (TITLE_WORDS.has(lastWord) || TITLE_MODIFIERS.has(lastWord)) {
      words.pop();
    } else {
      break;
    }
  }
  return words.join(' ');
}

function isValidName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 50) return false;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return false;

  for (const part of parts) {
    if (!/^[A-Z][a-zA-Z'\-.]*$/.test(part)) return false;
    const cleanWord = part.toLowerCase().replace(/[^a-z]/g, '');
    if (NON_NAME_WORDS.has(cleanWord)) return false;
  }

  return true;
}

/**
 * Extracts candidate name from resume text.
 */
export function extractName(text) {
  if (!text || typeof text !== 'string') return '';

  // 1. Explicit labeled name: e.g. "Name: John Doe" or "Candidate Name: Jane Smith"
  const labelMatch = text.match(/(?:^|\r?\n)\s*(?:Full\s+Name|Candidate(?:\s+Name)?|Name)\s*[:\-]\s*([^\r\n]+)/i);
  if (labelMatch) {
    const candidate = cleanName(labelMatch[1]);
    if (isValidName(candidate)) return candidate;
  }

  // 2. Scan top non-empty lines (skip headers, contact details, emails, URLs)
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const skipHeaders = /^(?:curriculum\s+vitae|resume|cv|profile|summary|professional\s+summary|contact(?:\s+information)?|about\s+me|objective|experience|education|skills|work\s+history)$/i;

  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    const line = lines[i];
    if (skipHeaders.test(line)) continue;
    if (/@|https?:\/\/|www\./i.test(line)) continue;
    if (/^\+?[\d\s().-]{7,}$/.test(line)) continue;

    // Check for explicit separators like "Jane Doe | Software Engineer" or "Jane Doe - Full Stack"
    let candidate = line.replace(/^(?:Full\s+Name|Candidate(?:\s+Name)?|Name)\s*[:\-]\s*/i, '');
    const sepParts = candidate.split(/[\t|–—]|(?:\s+-\s+)/);
    if (sepParts.length > 1 && sepParts[0].trim()) {
      candidate = sepParts[0].trim();
    }

    // Strip trailing job titles like "Principal Architect" or "Senior Engineer"
    candidate = stripJobTitle(candidate);

    const cleaned = cleanName(candidate);
    if (isValidName(cleaned)) {
      return cleaned;
    }
  }

  return '';
}

export const CANONICAL_SKILLS = [
  // Programming Languages
  { name: 'JavaScript', pattern: /\bjavascript\b/i },
  { name: 'TypeScript', pattern: /\btypescript\b/i },
  { name: 'Python', pattern: /\bpython\b/i },
  { name: 'Java', pattern: /\bjava\b(?!script)/i },
  { name: 'C++', pattern: /\bc\+\+/i },
  { name: 'C#', pattern: /\bc#/i },
  { name: 'Go', pattern: /\b(?:golang|go\s+(?:developer|engineer|programming|language))\b/i },
  { name: 'Rust', pattern: /\brust\b/i },
  { name: 'Ruby', pattern: /\bruby\b/i },
  { name: 'PHP', pattern: /\bphp\b/i },
  { name: 'Swift', pattern: /\bswift\b/i },
  { name: 'Kotlin', pattern: /\bkotlin\b/i },
  { name: 'Scala', pattern: /\bscala\b/i },
  { name: 'SQL', pattern: /\bsql\b/i },
  { name: 'HTML', pattern: /\bhtml5?\b/i },
  { name: 'CSS', pattern: /\bcss3?\b/i },
  { name: 'SASS', pattern: /\b(?:sass|scss)\b/i },
  { name: 'Bash', pattern: /\b(?:bash|shell\s+scripting)\b/i },

  // Frameworks & Libraries
  { name: 'React', pattern: /\breact(?:\.js)?\b/i },
  { name: 'React Native', pattern: /\breact\s+native\b/i },
  { name: 'Next.js', pattern: /\bnext(?:\.js)?\b/i },
  { name: 'Vue', pattern: /\bvue(?:\.js)?\b/i },
  { name: 'Angular', pattern: /\bangular(?:\.js)?\b/i },
  { name: 'Svelte', pattern: /\bsvelte\b/i },
  { name: 'TailwindCSS', pattern: /\btailwind(?:css)?\b/i },
  { name: 'Node.js', pattern: /\bnode(?:\.js)?\b/i },
  { name: 'Express', pattern: /\bexpress(?:\.js)?\b/i },
  { name: 'Django', pattern: /\bdjango\b/i },
  { name: 'FastAPI', pattern: /\bfastapi\b/i },
  { name: 'Flask', pattern: /\bflask\b/i },
  { name: 'Spring Boot', pattern: /\bspring\s+boot\b/i },
  { name: 'ASP.NET', pattern: /\basp\.net\b/i },
  { name: 'Ruby on Rails', pattern: /\b(?:ruby\s+on\s+rails|rails)\b/i },
  { name: 'GraphQL', pattern: /\bgraphql\b/i },
  { name: 'REST APIs', pattern: /\b(?:rest\s+apis?|restful(?:\s+apis?)?)\b/i },
  { name: 'Microservices', pattern: /\bmicroservices?\b/i },

  // Databases & Storage
  { name: 'PostgreSQL', pattern: /\bpostgres(?:ql)?\b/i },
  { name: 'MySQL', pattern: /\bmysql\b/i },
  { name: 'SQLite', pattern: /\bsqlite\b/i },
  { name: 'MongoDB', pattern: /\bmongodb?\b/i },
  { name: 'Redis', pattern: /\bredis\b/i },
  { name: 'Cassandra', pattern: /\bcassandra\b/i },
  { name: 'DynamoDB', pattern: /\bdynamodb\b/i },
  { name: 'Elasticsearch', pattern: /\belasticsearch\b/i },

  // Cloud & DevOps
  { name: 'AWS', pattern: /\b(?:aws|amazon\s+web\s+services)\b/i },
  { name: 'Azure', pattern: /\b(?:azure|microsoft\s+azure)\b/i },
  { name: 'GCP', pattern: /\b(?:gcp|google\s+cloud(?:\s+platform)?)\b/i },
  { name: 'Docker', pattern: /\bdocker\b/i },
  { name: 'Kubernetes', pattern: /\b(?:kubernetes|k8s)\b/i },
  { name: 'Terraform', pattern: /\bterraform\b/i },
  { name: 'CI/CD', pattern: /\bci\/cd\b/i },
  { name: 'Linux', pattern: /\blinux\b/i },
  { name: 'Git', pattern: /\bgit\b/i },
  { name: 'Cloud', pattern: /\bcloud(?:\s+(?:computing|infrastructure|architecture))?\b/i },

  // QA & Testing
  { name: 'Manual Testing', pattern: /\bmanual\s+testing\b/i },
  { name: 'Automation Testing', pattern: /\b(?:automation\s+testing|test\s+automation|automated\s+testing)\b/i },
  { name: 'Cypress', pattern: /\bcypress\b/i },
  { name: 'Playwright', pattern: /\bplaywright\b/i },
  { name: 'Selenium', pattern: /\bselenium\b/i },
  { name: 'Jest', pattern: /\bjest\b/i },
  { name: 'QA', pattern: /\b(?:qa|quality\s+assurance)\b/i },
  { name: 'Unit Testing', pattern: /\bunit\s+testing\b/i },
  { name: 'Integration Testing', pattern: /\bintegration\s+testing\b/i },
  { name: 'Performance Testing', pattern: /\bperformance\s+testing\b/i },

  // Data & AI
  { name: 'Machine Learning', pattern: /\bmachine\s+learning\b/i },
  { name: 'Deep Learning', pattern: /\bdeep\s+learning\b/i },
  { name: 'AI', pattern: /\b(?:ai|artificial\s+intelligence)\b/i },
  { name: 'PyTorch', pattern: /\bpytorch\b/i },
  { name: 'TensorFlow', pattern: /\btensorflow\b/i },
  { name: 'Pandas', pattern: /\bpandas\b/i },
  { name: 'Kafka', pattern: /\b(?:apache\s+)?kafka\b/i },
  { name: 'Spark', pattern: /\b(?:apache\s+)?spark\b/i },

  // Architecture & Methodologies
  { name: 'Distributed Systems', pattern: /\bdistributed\s+systems\b/i },
  { name: 'Agile', pattern: /\bagile\b/i },
  { name: 'Scrum', pattern: /\bscrum\b/i },
  { name: 'JIRA', pattern: /\bjira\b/i },
  { name: 'Project Management', pattern: /\bproject\s+management\b/i },
  { name: 'Product Management', pattern: /\bproduct\s+management\b/i },
  { name: 'Problem Solving', pattern: /\bproblem\s+solving\b/i },
  { name: 'Communication', pattern: /\bcommunication(?:\s+skills)?\b/i },
  { name: 'Leadership', pattern: /\bleadership\b/i },
  { name: 'Teamwork', pattern: /\bteamwork\b/i },
  { name: 'Negotiation', pattern: /\bnegotiation\b/i },
  { name: 'Sales', pattern: /\bsales\b/i }
];

const NON_SKILL_WORDS = new Set([
  'skills', 'technical', 'core', 'competencies', 'tools', 'technologies',
  'experience', 'proficiencies', 'languages', 'frameworks', 'databases',
  'libraries', 'key', 'areas', 'expertise', 'and', 'other', 'including'
]);

/**
 * Extracts relevant skills from resume text matching against known skills and standard taxonomy.
 */
export function extractSkills(text, knownSkills = []) {
  if (!text || typeof text !== 'string') return [];
  const found = new Set();
  const lowerText = text.toLowerCase();

  // 1. Scan for custom/known skills passed from database
  for (const ks of knownSkills) {
    if (!ks || typeof ks !== 'string') continue;
    const clean = ks.trim();
    if (clean.length < 2) continue;
    // Word-bounded match
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(text)) {
      found.add(clean);
    }
  }

  // 2. Scan for standard canonical skills
  for (const skill of CANONICAL_SKILLS) {
    if (skill.pattern.test(text) || skill.pattern.test(lowerText)) {
      found.add(skill.name);
    }
  }

  // 3. Scan explicit "Skills:" section if present
  const sectionMatch = text.match(/(?:^|\n)\s*(?:Technical\s+Skills|Core\s+Competencies|Key\s+Skills|Technologies|Skills\s*(?:&|and)\s*Tools|Skills)\s*[:\-]\s*([^\n]+(?:\n[^\n]+)?)/i);
  if (sectionMatch) {
    const raw = sectionMatch[1];
    const tokens = raw.split(/[,;•|\n/]+/).map(t => t.trim()).filter(Boolean);
    for (const token of tokens) {
      const cleanToken = token.replace(/^[-*•\s]+/, '').replace(/[-*•\s]+$/, '').trim();
      if (!cleanToken || cleanToken.length < 2 || cleanToken.length > 50) continue;
      // Must not contain forbidden characters per validateSkills
      if (/[*:&;|~^$%@!=<>?`"\\]/.test(cleanToken)) continue;
      if (!/^[\p{L}\p{N}\s.\-/+#()']{1,50}$/u.test(cleanToken)) continue;

      const canonical = CANONICAL_SKILLS.find(s => s.name.toLowerCase() === cleanToken.toLowerCase());
      if (canonical) {
        found.add(canonical.name);
      } else if (!NON_SKILL_WORDS.has(cleanToken.toLowerCase())) {
        found.add(cleanToken);
      }
    }
  }

  return [...found];
}

/**
 * Extracts email, phone, name, and skills from resume text.
 */
export function extractResumeDetails(text, knownSkills = []) {
  if (!text || typeof text !== 'string') {
    return { email: '', phone: '', name: '', skills: [] };
  }
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const phone = text.match(/\+?[\d][\d ()-]{8,20}\d/)?.[0] || '';
  const name = extractName(text);
  const skills = extractSkills(text, knownSkills);

  return { email, phone, name, skills };
}
