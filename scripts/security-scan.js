// Repository-wide security scanner.
//
// Added after an obfuscated JavaScript dropper was found committed at the repo
// root and disguised as a font binary under public/fonts/. The original
// `npm run check` only walked a hardcoded list of directories and only parsed
// *.m?js files, so neither location was ever inspected.
//
// This scan is intentionally broader: it walks the whole tree, verifies that
// binaries actually match their declared extension, and flags obfuscation and
// known C2/loader behaviour.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'data', 'test-results', 'backups', 'coverage', '.next',
]);
const MAX_SOURCE_BYTES = 512 * 1024;

// A file claiming to be a font/image/archive must start with the right magic.
// These are checked by extension so a payload renamed to .otf cannot hide.
const MAGIC_BY_EXT = {
  '.otf': ['4f54544f'],                                     // OTTO
  '.ttf': ['00010000', '74727565'],                          // 0x00010000 / 'true'
  '.woff': ['774f4646'],                                    // 'wOFF'
  '.woff2': ['774f4632'],                                   // 'wOF2'
  '.eot': null,                                             // EOT has no fixed magic
  '.png': ['89504e47'],
  '.jpg': ['ffd8ff'],
  '.jpeg': ['ffd8ff'],
  '.gif': ['47494638'],
  '.webp': ['52494646'],
  '.ico': ['00000100'],
  '.pdf': ['25504446'],                                     // %PDF
  '.zip': ['504b0304', '504b0506', '504b0708'],
  '.gz': ['1f8b'],
  '.bz2': ['425a68'],
  '.xz': ['fd377a585a00'],
  '.wasm': ['0061736d'],                                     // \0asm
};

const RULES = [
  // --- obfuscation -------------------------------------------------------
  [/_0x[0-9a-f]{4,}/i, 'hex-identifier obfuscation (_0x...)'],
  [/eval\s*\(\s*atob\s*\(/i, 'eval(atob(...)) unpacking'],
  [/eval\s*\(\s*Buffer\s*\.\s*from\s*\(\s*[^)]*base64/i, 'eval(Buffer.from(base64)) unpacking'],
  [/\.join\(''\)\s*;\s*(?:var|const|let)\s+\w+\s*=\s*atob\s*\(/i, 'base64 array -> atob -> eval chain'],
  [/\beval\s*\(\s*(?:_0x|atob|Buffer\.from)/i, 'eval of decoded payload'],
  // --- C2 / loader -------------------------------------------------------
  [/X-Payload-B64/i, 'custom C2 response header'],
  [/eth_getBlockByNumber|eth\.blockscout\.com|eth_getTransactionCount/i, 'on-chain C2 address resolver'],
  [/\/0x\/(?:cls|ls)\b/i, 'staged loader path'],
  // --- security-tool tampering -------------------------------------------
  [/MsMpEng\.exe/i, 'Windows Defender process reference'],
  [/CSFalconService|CSFalconContainer/i, 'CrowdStrike process reference'],
  [/SentinelAgent|SentinelOne/i, 'SentinelOne process reference'],
  [/(?:process\.kill|taskkill)\s*[^\n]*\b(?:MsMpEng|defender|csfalcon|avp|avg)\b/i,
    'security-tool kill attempt'],
  // --- reverse shell ------------------------------------------------------
  [/\/b64\b[^\n]{0,80}execSync|execSync[^\n]{0,80}\/b64\b/i, 'base64 command execution endpoint'],
  [/child_process[^\n]{0,40}execSync/i, 'execSync command execution'],
];

// This file necessarily contains every malicious signature it searches for, so
// it must never be subject to the content rules it defines. Only the binary
// magic checks (which it does not self-satisfy) and the package.json guards
// still apply to it.
const SELF = 'scripts/security-scan.js';

// Deliberate, reviewed exceptions. Keep these narrow and justified.
const ALLOWLIST = [
  {
    file: join('tests', 'ui', 'browser.mjs'),
    // Spawns headless Chrome for the UI test suite. windowsHide only suppresses
    // a console window; it is not paired with detached/stdin piping.
    reason: 'reviewed: headless Chrome spawn for UI tests',
    match: /windowsHide\s*:\s*true/i,
  },
];

const findings = [];
const allowHit = new Set();

function isAllowed(rel, label) {
  return ALLOWLIST.some((a) => a.file === rel && a.match.test(label));
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function checkMagic(rel, abs, ext, buf) {
  const expected = MAGIC_BY_EXT[ext];
  if (!expected || buf.length < 4) return;
  const magic = buf.subarray(0, 4).toString('hex');
  if (!expected.includes(magic)) {
    findings.push({
      rel,
      rule: `extension/content mismatch: .${ext.replace('.', '')} file does not begin with a valid ${ext} signature`,
      severity: 'critical',
      detail: `declared as ${ext} but starts with 0x${magic}`,
    });
  }
}

function looksLikeSource(ext) {
  return ['.js', '.mjs', '.cjs', '.json', '.ts'].includes(ext);
}

const root = process.cwd();
const files = walk(root);
let scanned = 0;

for (const abs of files) {
  const rel = relative(root, abs).split(sep).join('/');
  const ext = extname(rel).toLowerCase();
  const size = statSync(abs).size;

  // Read as a buffer so binary magic can be inspected safely.
  const buf = readFileSync(abs);

  if (MAGIC_BY_EXT[ext]) checkMagic(rel, abs, ext, buf);

  if (!looksLikeSource(ext)) continue;
  if (size > MAX_SOURCE_BYTES) {
    findings.push({
      rel,
      rule: `source file is implausibly large (${Math.round(size / 1024)} KB)`,
      severity: 'critical',
    });
    continue;
  }
  if (rel === SELF) continue;

  const text = buf.toString('utf8');
  scanned++;
  for (const [re, rule] of RULES) {
    const m = re.exec(text);
    if (!m) continue;
    if (isAllowed(rel, rule)) { allowHit.add(`${rel} :: ${rule}`); continue; }
    findings.push({
      rel,
      rule,
      severity: 'critical',
      detail: `${text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ')}`,
    });
  }
}

// Guard the exact vector that was exploited: a start script chaining a
// root-level JS file ahead of the real entrypoint.
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (/node\s+\.?\/?(api|index|main)\.js\s*&&/i.test(cmd)) {
      findings.push({
        rel: 'package.json',
        rule: `script "${name}" chains a second entrypoint before the server: ${cmd}`,
        severity: 'critical',
      });
    }
    if (/(curl|wget|Invoke-WebRequest|iwr)\s/i.test(cmd)) {
      findings.push({
        rel: 'package.json',
        rule: `script "${name}" performs a network download`,
        severity: 'critical',
      });
    }
  }
} catch (err) {
  findings.push({ rel: 'package.json', rule: `unreadable: ${err.message}`, severity: 'critical' });
}

// Report files that are tracked by git but absent locally. This is
// informational only: developers legitimately delete tracked files (editor
// config, local scratch files), and CI always checks out a fresh tree where
// every tracked path is present. It must not fail the build.
let drift = [];
try {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\n').filter(Boolean);
  const trackedSet = new Set(tracked.map((p) => p.split(sep).join('/')));
  const onDisk = new Set(files.map((f) => relative(root, f).split(sep).join('/')));
  drift = [...trackedSet].filter((t) => !SKIP_DIRS.has(t.split('/')[0]) && !onDisk.has(t));
} catch {
  // Not a git checkout (e.g. running from an exported tree) - skip this check.
}

if (drift.length) {
  console.log(`Note: ${drift.length} tracked path(s) absent from this working tree (local-only, not a failure):`);
  for (const d of drift) console.log(`  - ${d}`);
}

if (allowHit.size) {
  console.log(`Security scan: ${allowHit.size} reviewed exception(s) allowed:`);
  for (const a of allowHit) console.log(`  - ${a}`);
}

if (findings.length) {
  console.error(`\nSECURITY SCAN FAILED - ${findings.length} finding(s):\n`);
  for (const f of findings) {
    console.error(`  [${f.severity.toUpperCase()}] ${f.rel}`);
    console.error(`      ${f.rule}`);
    if (f.detail) console.error(`      …${f.detail}…`);
  }
  console.error('\nDo not commit. If a finding looks wrong, add a narrow ALLOWLIST');
  console.error('entry to scripts/security-scan.js with a justification.\n');
  process.exit(1);
}

console.log(`PASS: security scan clean (${files.length} files walked, ${scanned} source files inspected).`);