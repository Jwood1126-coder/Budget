'use strict';
// Unit tests for tools/check-privacy.cjs, run against throwaway git repositories. All data is invented.
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scan } = require('../../tools/check-privacy.cjs');

const TERM = 'zebrafinch';
let root;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const findings = opts => scan({ root, ...opts }).findings;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-check-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('.gitignore', '/private/\n');
  write('private/denylist.txt', '# invented test term\n' + TERM + '\n');
  write('README.md', 'Nothing private here.\n');
  git('add', '.');
  git('commit', '-qm', 'init');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('tools/check-privacy.cjs', () => {
  test('a clean repository passes', () => {
    assert.deepEqual(findings(), []);
    assert.deepEqual(findings({ staged: true }), []);
  });

  test('--staged scans the staged content, not the working-tree file', () => {
    write('notes.md', 'Paid ' + TERM + ' today.\n');
    git('add', 'notes.md');
    write('notes.md', 'Nothing to see.\n'); // cleaned in the working tree only: the commit would still publish the term
    const found = findings({ staged: true });
    assert.equal(found.length, 1);
    assert.match(found[0], /^notes\.md:1: contains a denylisted term/);
  });

  test('--staged passes when only the working tree holds the term', () => {
    write('notes.md', 'Nothing to see.\n');
    git('add', 'notes.md');
    write('notes.md', 'Paid ' + TERM + ' today.\n');
    assert.deepEqual(findings({ staged: true }), []);
    assert.equal(findings().length, 1, 'the full scan still sees the working-tree file');
  });

  test('paths with spaces and non-ASCII characters are scanned, not skipped', () => {
    write('docs/café notes.md', TERM + '\n');
    write('docs/plan "draft".md', TERM + '\n');
    assert.deepEqual(findings().map(f => f.split(':')[0]).sort(), ['docs/café notes.md', 'docs/plan "draft".md']);
    git('add', '.');
    assert.equal(findings({ staged: true }).length, 2);
  });

  test('private markers are caught in any file', () => {
    // Built from pieces so this test file does not itself carry the markers it checks for.
    const q = (k, v) => JSON.stringify(k) + ': ' + v;
    write('backup/thing.json', '{\n  ' + q('isSynthetic', 'false') + '\n}\n');
    write('exports/copy.json', '{' + q('format', JSON.stringify('household-budget-' + 'workbook')) + ', "version": 5}\n');
    write('site/index.html', '<script>const BUILD = {' + q('kind', '"private"') + '};</script>\n');
    write('site/empty.html', '<script>const BUILD = {"kind":"empty",' + q('profilePrivate', 'true') + '};</script>\n');
    write('notes/report.md', '<!-- household-budget: ' + 'PRIVATE import report -->\n# Import report\n');
    const found = findings();
    for (const file of ['backup/thing.json', 'exports/copy.json', 'site/index.html', 'site/empty.html', 'notes/report.md']) {
      assert.ok(found.some(f => f.startsWith(file + ': looks like')), file + ' flagged');
    }
  });

  test('downloads from the app are forbidden paths whatever their extension', () => {
    write('household-budget-pre-upgrade-backup-2026-10-01.txt', 'x\n');
    write('Downloads/household-budget-workbook-2026-10-01.json', '{}\n');
    const found = findings();
    assert.equal(found.filter(f => /forbidden path/.test(f)).length, 2);
  });

  test('a staged file that cannot be read fails the check instead of being skipped', () => {
    write('big.txt', 'a'.repeat(5_000_001));
    git('add', 'big.txt');
    const found = findings({ staged: true });
    assert.equal(found.length, 1);
    assert.match(found[0], /^big\.txt: too large to scan/);
  });

  test('a symlink is checked as the link text git stores, not the file it points to', () => {
    write('private/secret.txt', TERM + '\n');
    fs.symlinkSync('private/secret.txt', path.join(root, 'link.txt'));
    assert.deepEqual(findings(), []);
  });
});
