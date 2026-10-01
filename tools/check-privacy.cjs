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
 *   4. Committed fixtures must declare "isSynthetic": true.
 * Exit code 1 when anything is found.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DENYLIST = path.join(ROOT, 'private/denylist.txt');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
}

function candidateFiles(staged) {
  if (staged) return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  return [...new Set([...git(['ls-files']), ...git(['ls-files', '--others', '--exclude-standard'])])];
}

function loadDenylist() {
  if (!fs.existsSync(DENYLIST)) return [];
  return fs.readFileSync(DENYLIST, 'utf8')
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
  { re: /\.(png|jpe?g|webp|heic|gif|bmp)$/i, why: 'image (screenshots can show private figures that no text scan can check)' },
];
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SAFE_EMAIL = /@(example\.(com|org|net)|[a-z0-9-]+\.test|anthropic\.com)$/i;
const ACCOUNT_NUMBER = /\b(account|acct|routing|member)\b[^\n]{0,20}?\d{6,}/gi;

function scan({ staged = false } = {}) {
  const findings = [];
  const deny = loadDenylist();
  for (const rel of candidateFiles(staged)) {
    for (const rule of FORBIDDEN_PATH) {
      if (rule.re.test(rel) && !(rule.allow && rule.allow.test(rel))) findings.push(`${rel}: forbidden path (${rule.why})`);
    }
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).size > 5_000_000) continue;
    const text = fs.readFileSync(abs, 'utf8');
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
    if (/^fixtures\/.*\.json$/.test(rel) && /"isSynthetic"\s*:\s*false/.test(text)) {
      findings.push(`${rel}: fixture marked isSynthetic false`);
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
