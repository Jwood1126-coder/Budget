#!/usr/bin/env node
'use strict';
/*
 * Real-browser checks (Chromium via Playwright) against dist/index.html built from the
 * synthetic sample. Each tests/browser/*.spec.cjs exports an array of
 *   { name, viewport?: 'desktop'|'phone'|'both', run: async (t) => {} }
 * where t = { page, open(hash), assert, viewport, shot(name), errors }.
 * Every test fails on any uncaught page error or console error.
 *
 *   node tests/browser/run.cjs [filter]       run (optionally only tests whose name includes filter)
 *   BUDGET_DIST=dist/dev-x/index.html BUDGET_RESULTS=test-results/x node tests/browser/run.cjs x
 * Screenshots go to test-results/ (ignored by git).
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch { /* fall through */ }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  } catch {
    console.error('Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium');
    process.exit(2);
  }
}

const ROOT = path.join(__dirname, '..', '..');
const DIST = process.env.BUDGET_DIST ? path.resolve(process.env.BUDGET_DIST) : path.join(ROOT, 'dist', 'index.html');
const OUT_DIR = process.env.BUDGET_RESULTS ? path.resolve(process.env.BUDGET_RESULTS) : null;
const OUT = OUT_DIR || path.join(ROOT, 'test-results');
const VIEWPORTS = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844, isMobile: true, hasTouch: true } };

async function main() {
  if (!fs.existsSync(DIST)) { console.error('Build first: node tools/build.cjs --sample'); process.exit(2); }
  const html = fs.readFileSync(DIST, 'utf8');
  if (!/"kind":"sample"/.test(html)) { console.error('Browser tests must run against the sample build (node tools/build.cjs --sample).'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const filter = process.argv[2] || '';
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  let specs = fs.readdirSync(__dirname).filter(f => f.endsWith('.spec.cjs')).sort();
  // 'run.cjs budget' runs budget.spec.cjs only (not every test whose name mentions budget).
  const fileMatch = filter && specs.find(f => f === filter + '.spec.cjs' || f === filter);
  if (fileMatch) specs = [fileMatch];
  const nameFilter = fileMatch ? '' : filter;
  let passed = 0, failed = 0;
  const failures = [];
  for (const file of specs) {
    const tests = require(path.join(__dirname, file));
    for (const test of tests) {
      if (nameFilter && !test.name.includes(nameFilter) && !file.includes(nameFilter)) continue;
      const vps = test.viewport === 'both' ? ['desktop', 'phone'] : [test.viewport || 'desktop'];
      for (const vp of vps) {
        const label = `${file.replace('.spec.cjs', '')} › ${test.name} [${vp}]`;
        const context = await browser.newContext({ viewport: { width: VIEWPORTS[vp].width, height: VIEWPORTS[vp].height }, isMobile: !!VIEWPORTS[vp].isMobile, hasTouch: !!VIEWPORTS[vp].hasTouch, acceptDownloads: true });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push('pageerror: ' + e.message));
        page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
        const url = 'file://' + DIST;
        const t = {
          page, assert, viewport: vp, errors, context,
          async open(hash = '#/overview', { clear = true } = {}) {
            await page.goto(url + hash);
            if (clear) { await page.evaluate(() => localStorage.clear()); await page.goto(url + hash); await page.reload(); }
            await page.waitForSelector('#page-title');
          },
          async shot(name) { await page.screenshot({ path: path.join(OUT, `${name}-${vp}.png`), fullPage: true }); },
          url,
        };
        try {
          await test.run(t);
          if (errors.length) throw new Error('Browser errors:\n  ' + errors.join('\n  '));
          passed++;
          console.log('PASS ' + label);
        } catch (err) {
          failed++;
          failures.push(label);
          console.log('FAIL ' + label + '\n  ' + String(err && err.stack || err).split('\n').slice(0, 6).join('\n  '));
          try { await page.screenshot({ path: path.join(OUT, 'FAIL-' + label.replace(/[^a-z0-9]+/gi, '-') + '.png'), fullPage: true }); } catch { /* ignore */ }
        }
        await context.close();
      }
    }
  }
  await browser.close();
  console.log(`\n${passed} browser checks passed, ${failed} failed (Chromium ${browser.version ? '' : ''}via Playwright).`);
  if (failures.length) { console.log('Failed:\n  ' + failures.join('\n  ')); process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
