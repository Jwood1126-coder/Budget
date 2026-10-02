#!/usr/bin/env node
'use strict';
/*
 * Refuse to let private household data reach this (public) repository.
 *
 *   node tools/check-privacy.cjs           check every tracked + untracked-but-not-ignored file
 *   node tools/check-privacy.cjs --staged  check only files staged for the next commit (pre-commit hook)
 *
 * Checks:
 *   1. Forbidden paths: private/, dist/, data/budget-data.json, bank exports outside fixtures/sample-raw/,
 *      and images (screenshots can show private figures that a text scan cannot check).
 *   2. Terms listed in private/denylist.txt (one per line, case-insensitive, '#' comments).
 *      Put names, employers, exact amounts, street/town names and account fragments there.
 *      The denylist itself is private and never committed.
 *   3. Generic leaks: email addresses (other than example/test domains) and long digit runs next
 *      to words like "account", "acct" or "routing".
 *   4. Markers that private outputs carry ("isSynthetic": false, exported workbooks, private builds,
 *      import reports), in any file. Committed fixtures must declare "isSynthetic": true.
 * With --staged, the staged (index) content is scanned: that is what the commit will publish.
 * Paths are read with -z so unusual file names are scanned too; an unreadable path fails the check.
 * Exit code 1 when anything is found.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

// Paths are read NUL-separated and unquoted so names with spaces or non-ASCII characters are
// scanned like any other (git would otherwise print them quoted and escaped).
function gitPaths(ROOT, args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args, '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\0').filter(Boolean);
}

function candidateFiles(ROOT, staged) {
  if (staged) return gitPaths(ROOT, ['diff', '--cached', '--name-only', '--diff-filter=ACMRT']);
  return [...new Set([...gitPaths(ROOT, ['ls-files']), ...gitPaths(ROOT, ['ls-files', '--others', '--exclude-standard'])])];
}

const MAX_SCAN_BYTES = 5_000_000;

/**
 * The content that would be published. With --staged that is the version in the index (what the
 * commit will contain), never the working-tree file, which may differ. Returns
 * { text } or { problem } — a path that cannot be read fails the check instead of being skipped.
 */
function readCandidate(ROOT, rel, staged) {
  const abs = path.join(ROOT, rel);
  const fromIndex = () => {
    try {
      const size = Number(execFileSync('git', ['cat-file', '-s', ':' + rel], { cwd: ROOT, encoding: 'utf8' }).trim());
      if (!(size <= MAX_SCAN_BYTES)) return { problem: `too large to scan (${size} bytes); keep large files out of the repository` };
      return { text: execFileSync('git', ['cat-file', 'blob', ':' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_SCAN_BYTES + 1024 }) };
    } catch { return null; }
  };
  if (staged) return fromIndex() || { problem: 'could not read the staged version' };
  let st = null;
  try { st = fs.lstatSync(abs); } catch { /* deleted in the working tree: scan the indexed copy */ }
  if (!st) return fromIndex() || { problem: 'listed by git but could not be read' };
  if (st.isSymbolicLink()) return { text: fs.readlinkSync(abs) }; // git stores the link target, not the file it points to
  if (!st.isFile()) return { problem: 'not a regular file' };
  if (st.size > MAX_SCAN_BYTES) return { problem: `too large to scan (${st.size} bytes); keep large files out of the repository` };
  return { text: fs.readFileSync(abs, 'utf8') };
}

function loadDenylist(ROOT) {
  const file = path.join(ROOT, 'private/denylist.txt');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(term => term.toLowerCase());
}

const FORBIDDEN_PATH = [
  { re: /^private\//, why: 'private/ holds real household data' },
  { re: /^dist\//, why: 'builds may embed private data' },
  { re: /^data\/budget-data\.json$/, why: 'legacy private dataset' },
  { re: /\.(csv|ofx|qfx|qbo|xlsx?|pdf)$/i, why: 'bank/statement export', allow: /^fixtures\/sample-raw\// },
  { re: /(^|\/)\.env/, why: 'environment/credential file' },
  { re: /(^|\/)household-budget-(workbook|transactions|pre-upgrade-backup|unreadable-copy)[^/]*$/i, why: 'a download from the app (contains household data)' },
  { re: /\.(png|jpe?g|webp|heic|gif|bmp)$/i, why: 'image (screenshots can show private figures that no text scan can check)' },
];
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SAFE_EMAIL = /@(example\.(com|org|net)|[a-z0-9-]+\.test|anthropic\.com)$/i;
const ACCOUNT_NUMBER = /\b(account|acct|routing|member)\b[^\n]{0,20}?\d{6,}/gi;
// Markers the app and tools write into private outputs, wherever such a file ends up in the tree.
const PRIVATE_MARKERS = [
  { re: /"isSynthetic"\s*:\s*false/, why: 'marked "isSynthetic": false (real household data)' },
  { re: /"format"\s*:\s*"household-budget-workbook"/, why: 'an exported workbook (saved budget and edits)' },
  { re: /"kind"\s*:\s*"private"/, why: 'a private build of the app' },
  { re: /"profilePrivate"\s*:\s*true/, why: 'a build that embeds a private household profile' },
  { re: /<!-- household-budget: PRIVATE import report/, why: 'a private import report' },
];
// The files that define these markers (they hold the marker text as code, not data).
const MARKER_DEFINITIONS = new Set(['tools/check-privacy.cjs', 'tools/import.cjs']);

function scan({ staged = false, root = REPO_ROOT } = {}) {
  const ROOT = root;
  const findings = [];
  const deny = loadDenylist(ROOT);
  for (const rel of candidateFiles(ROOT, staged)) {
    for (const rule of FORBIDDEN_PATH) {
      if (rule.re.test(rel) && !(rule.allow && rule.allow.test(rel))) findings.push(`${rel}: forbidden path (${rule.why})`);
    }
    const read = readCandidate(ROOT, rel, staged);
    if (read.problem) { findings.push(`${rel}: ${read.problem}`); continue; }
    const text = read.text;
    const lower = text.toLowerCase();
    for (const term of deny) {
      const at = lower.indexOf(term);
      if (at !== -1) {
        const line = lower.slice(0, at).split('\n').length;
        findings.push(`${rel}:${line}: contains a denylisted term (see private/denylist.txt)`);
      }
    }
    for (const m of text.matchAll(EMAIL)) {
      if (!SAFE_EMAIL.test(m[0])) findings.push(`${rel}: email address ${m[0].replace(/^(.).*@/, '$1***@')}`);
    }
    for (const m of text.matchAll(ACCOUNT_NUMBER)) {
      findings.push(`${rel}: possible account number near "${m[0].slice(0, 12)}…"`);
    }
    if (!MARKER_DEFINITIONS.has(rel)) {
      for (const marker of PRIVATE_MARKERS) if (marker.re.test(text)) findings.push(`${rel}: looks like ${marker.why}`);
    }
  }
  return { findings, denylistTerms: deny.length };
}

if (require.main === module) {
  const staged = process.argv.includes('--staged');
  const { findings, denylistTerms } = scan({ staged });
  if (!denylistTerms) {
    console.warn('Note: private/denylist.txt not found or empty — only generic checks ran. Add your names, employers and exact amounts there.');
  }
  if (findings.length) {
    console.error('Privacy check FAILED:\n  ' + findings.join('\n  '));
    console.error('\nRemove these from the commit (git restore --staged <file>) or move private data into private/.');
    process.exit(1);
  }
  console.log(`Privacy check passed (${staged ? 'staged files' : 'all tracked and unignored files'}; ${denylistTerms} denylisted terms).`);
}

module.exports = { scan };
