'use strict';
// Data & privacy checks in a real browser. Every file fed to the page is fictional: the
// committed sample exports (fixtures/sample-raw), the sample profile and rules, and small
// invented CSVs written below.
//   node tools/build.cjs --sample --view data --out dist/dev-data/index.html
//   BUDGET_DIST=dist/dev-data/index.html BUDGET_RESULTS=test-results/data node tests/browser/run.cjs data
const fs = require('node:fs');
const path = require('node:path');
const { loadEngine } = require('../load-engine.cjs');
const { noHorizontalScroll, state, money } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..', '..');
const RAW = path.join(ROOT, 'fixtures', 'sample-raw');
const SAMPLE = [
  { name: 'checking-2024-10-to-2025-12.csv', start: '2024-10-01', end: '2025-12-31' },
  { name: 'checking-2025-11-to-2026-09.csv', start: '2025-11-01', end: '2026-09-30' },
  { name: 'card-2025-01-to-2026-09.csv', start: '2025-01-01', end: '2026-09-30' },
  { name: 'savings-2025-06-to-2026-09.csv', start: '2025-06-01', end: '2026-09-30' },
];
const csvFile = name => ({ name, mimeType: 'text/csv', buffer: fs.readFileSync(path.join(RAW, name)) });
const textFile = (name, text, mimeType = 'application/json') => ({ name, mimeType, buffer: Buffer.from(text) });
const readJSON = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const datasetId = page => page.evaluate(() => window.HouseholdBudget.getDataset().datasetId);
const text = (page, sel) => page.$eval(sel, el => el.textContent.replace(/\s+/g, ' ').trim());

/** Run `change` (which re-renders the view) and wait until the view has been replaced. */
async function waitForRender(page, change) {
  await page.evaluate(() => { document.getElementById('view').firstElementChild.dataset.stale = '1'; });
  await change();
  await page.waitForFunction(() => { const el = document.getElementById('view').firstElementChild; return !!el && !el.dataset.stale; });
}

async function setGroceries(page, cents) {
  await waitForRender(page, () => page.evaluate(v => {
    const H = window.HouseholdBudget;
    H.setState(H.engine.state.setPath(H.getState(), 'plan.targets.Groceries', v));
  }, cents));
  await page.waitForFunction(v => window.HouseholdBudget.getState().plan.targets.Groceries === v, cents);
}

/** Mark one transaction as a duplicate (not counted) through saved state; returns its id. */
async function excludeOne(page) {
  let id;
  await waitForRender(page, async () => {
    id = await page.evaluate(() => {
      const H = window.HouseholdBudget;
      const txn = H.getDataset().transactions.find(x => x.accountId === 'joint-checking' && x.kind === 'spend');
      const edit = H.engine.review.editRecord(null, 'duplicate', 'exclude', 'Test: same purchase twice', '2026-10-01T12:00:00.000Z');
      const s = H.getState();
      H.setState({ ...s, ledgerEdits: { ...s.ledgerEdits, [txn.id]: edit } });
      return txn.id;
    });
  });
  return id;
}

/** Headings in order, unique ids, every control labelled, no anchor used as a button. */
async function structure(page) {
  return page.evaluate(() => {
    const view = document.getElementById('view');
    const levels = [...view.querySelectorAll('h1, h2, h3, h4')].map(h => Number(h.tagName[1]));
    const jumps = levels.filter((l, i) => i > 0 && l > levels[i - 1] + 1);
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    const unlabelled = [...view.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(el => {
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
      return !(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) && !el.closest('label');
    }).map(el => el.id || el.name || el.outerHTML.slice(0, 60));
    const anchorsWithoutHref = view.querySelectorAll('a:not([href])').length;
    const clipped = [...view.querySelectorAll('.btn, .badge, h1, h2, h3, dt')].filter(el => el.offsetParent !== null && el.scrollWidth > el.clientWidth + 2).map(el => el.textContent.trim().slice(0, 40));
    return { first: levels[0], jumps, dupes, unlabelled, anchorsWithoutHref, clipped };
  });
}
async function assertStructure(t, where) {
  const s = await structure(t.page);
  t.assert.equal(s.first, 1, 'the page title is the first heading on ' + where);
  t.assert.deepEqual(s.jumps, [], 'heading levels never skip on ' + where);
  t.assert.deepEqual(s.dupes, [], 'element ids are unique on ' + where);
  t.assert.deepEqual(s.unlabelled, [], 'every control has a label on ' + where);
  t.assert.equal(s.anchorsWithoutHref, 0, 'no link without a destination on ' + where);
  t.assert.deepEqual(s.clipped, [], 'no clipped labels on ' + where);
  t.assert.ok(await noHorizontalScroll(t.page), 'no horizontal page scroll on ' + where);
}

/** Choose the four sample exports, give each its export period, and check them. */
async function importSample(t, { dsid = 'alex-sam-test', rules = true } = {}) {
  const { page } = t;
  await page.setInputFiles('#dp-pick-csv', SAMPLE.map(f => csvFile(f.name)));
  await page.waitForFunction(() => location.hash.startsWith('#/data?load=csv') && document.querySelectorAll('.dp-fileblock').length === 4);
  const accounts = await page.$$eval('.dp-fileblock select[id$="-acct"]', els => els.map(e => e.value));
  t.assert.deepEqual(accounts, ['joint-checking', 'joint-checking', 'joint-card', 'joint-savings'], 'accounts are pre-selected from the file names');
  const blocks = await page.$$eval('.dp-fileblock', els => els.map(e => e.id));
  for (let i = 0; i < SAMPLE.length; i++) {
    await page.fill(`#${blocks[i]}-cs`, SAMPLE[i].start);
    await page.fill(`#${blocks[i]}-ce`, SAMPLE[i].end);
  }
  await page.waitForFunction(id => document.getElementById(id + '-ce') && document.getElementById(id + '-ce').value === '2026-09-30', blocks[3]);
  if (rules) {
    await page.setInputFiles('#dp-pick-rules', textFile('sample-rules.json', fs.readFileSync(path.join(ROOT, 'fixtures/sample-rules.json'), 'utf8')));
    await page.waitForSelector('#dp-rules-remove');
  }
  await page.fill('#dp-csv-dsid', dsid);
  await page.click('#dp-csv-check-btn');
  await page.waitForFunction(() => location.hash.includes('step=report'));
  await page.waitForSelector('#dp-csv-use');
}

const NEWER_NAME = 'checking-2026-09-to-2026-10.csv';
/**
 * An invented newer checking export, newest first like the sample's: the sample's September rows
 * again (already in the data) and new October rows, with a running balance that continues the
 * sample's.
 */
function newerChecking() {
  const E = loadEngine();
  const [header, ...rows] = E.importer.parseCSV(fs.readFileSync(path.join(RAW, 'checking-2025-11-to-2026-09.csv'), 'utf8'));
  const september = rows.filter(r => /^09\/\d\d\/2026$/.test(r[0]));
  let cents = E.money.parseAmount(september[0][3]);
  const october = [['10/01/2026', 'SAMPLE MORTGAGE SERVICER PMT', -141256], ['10/02/2026', 'SAMPLE EMPLOYER PAYROLL DIR DEP', 188000],
    ['10/09/2026', 'LANTERN BAKERY', -1425], ['10/16/2026', 'SAMPLE EMPLOYER PAYROLL DIR DEP', 188000], ['10/20/2026', 'SAMPLE GAS UTILITY', -6130]]
    .map(([d, desc, amt]) => { cents += amt; return [d, desc, (amt / 100).toFixed(2), (cents / 100).toFixed(2)]; });
  const lines = [header].concat(october.reverse(), september).map(r => r.join(','));
  return { text: lines.join('\n') + '\n', added: october.length, overlap: september.length, endCents: cents };
}

/** Mark the checking row with this date and description as a duplicate (not counted); returns its id. */
async function excludeRow(page, date, description) {
  let id;
  await waitForRender(page, async () => {
    id = await page.evaluate(([d, desc]) => {
      const H = window.HouseholdBudget;
      const txn = H.getDataset().transactions.find(x => x.accountId === 'joint-checking' && x.date === d && x.description === desc);
      const edit = H.engine.review.editRecord(null, 'duplicate', 'exclude', 'Test: same purchase twice', '2026-10-01T12:00:00.000Z');
      const s = H.getState();
      H.setState({ ...s, ledgerEdits: { ...s.ledgerEdits, [txn.id]: edit } });
      return txn.id;
    }, [date, description]);
  });
  return id;
}

/** Add the newer export to the sample through the page (add mode), ending on the reloaded hub. */
async function mergeNewer(t, newer) {
  const { page } = t;
  await page.setInputFiles('#dp-pick-csv', [textFile(NEWER_NAME, newer.text, 'text/csv')]);
  await page.waitForSelector('#dp-csv-mode-add');
  await waitForRender(page, () => page.check('#dp-csv-mode-add'));
  const [block] = await page.$$eval('.dp-fileblock', els => els.map(e => e.id));
  await page.fill(`#${block}-cs`, '2026-09-01');
  await page.fill(`#${block}-ce`, '2026-10-31');
  await page.waitForFunction(id => document.getElementById(id + '-ce').value === '2026-10-31', block);
  await page.click('#dp-csv-check-btn');
  await page.waitForSelector('#dp-merge-apply');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dp-merge-apply')]);
  await page.waitForSelector('#dp-using');
}

module.exports = [
  {
    name: 'hub shows what the page is using, with accounts, coverage, import log and every section',
    viewport: 'both',
    async run(t) {
      await t.open('#/data');
      const using = await text(t.page, '#dp-using');
      t.assert.ok(using.includes('Built-in sample'), 'names the data source');
      t.assert.ok(using.includes('Fictional'), 'says the data is fictional');
      t.assert.ok(using.includes('sample'), 'shows the data set name');
      t.assert.ok(/965 transactions in 4 accounts/.test(using), 'record counts');
      t.assert.ok(using.includes('Alex & Sam (sample)'), 'profile name');
      t.assert.ok(using.includes('Saved in this browser'), 'budget storage status');
      const recordLinks = await t.page.$$eval('#dp-using table a', as => as.map(a => a.getAttribute('href')));
      t.assert.equal(recordLinks.length, 3, 'each account links to its transactions');
      // show=excluded: the list holds every row behind the count, struck through when not counted.
      for (const h of recordLinks) t.assert.match(h, /^#\/spending\?period=all&list=1&acct=joint-[a-z]+&kind=all&show=excluded$/);
      t.assert.equal(await t.page.$eval('#dp-using dd a[href^="#/spending"]', a => a.getAttribute('href')), '#/spending?period=all&list=1&kind=all&show=excluded');
      t.assert.ok((await text(t.page, '#dp-using table')).includes('Oct 1, 2024 – Sep 30, 2026'), 'coverage range per account');
      t.assert.ok(await t.page.isVisible('#dp-importlog'), 'import log is available');
      await t.page.click('#dp-importlog > summary');
      t.assert.ok((await text(t.page, '#dp-importlog')).includes('checking-2025-11-to-2026-09.csv'));
      for (const id of ['#dp-load', '#dp-save', '#dp-privacy', '#dp-reset-card']) t.assert.ok(await t.page.isVisible(id), id + ' visible');
      t.assert.equal(!!(await t.page.$('#dp-upgrade')), false, 'no upgrade notes for a fresh budget');
      t.assert.equal(!!(await t.page.$('#dp-forget')), false, 'nothing loaded, nothing to forget');
      const privacy = await text(t.page, '#dp-privacy');
      for (const phrase of ['No network requests', 'No analytics', 'repository is public', 'Needs approval', 'Paid hosting', 'Free', 'end-to-end encrypted', 'Proposal only']) {
        t.assert.ok(privacy.includes(phrase), 'privacy card mentions: ' + phrase);
      }
      const save = await text(t.page, '#dp-save');
      for (const phrase of ['in this browser only', 'Not shared', 'Clearing browser data', 'incognito', 'does not hold the transactions']) t.assert.ok(save.includes(phrase), 'save card says: ' + phrase);
      await assertStructure(t, 'the hub');
      await t.shot('data-hub');
    },
  },
  {
    name: 'CSV import de-duplicates overlapping checking exports in a report, applies only after Use, and Forget restores the sample',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await importSample(t);
      await assertStructure(t, 'the import report');
      // Nothing has changed yet.
      t.assert.equal(await datasetId(page), 'sample', 'the report does not apply anything');
      const metrics = await page.$$eval('.dp-metrics .metric', els => els.map(e => [e.querySelector('.metric-label').textContent, e.querySelector('.metric-value').textContent]));
      t.assert.deepEqual(Object.fromEntries(metrics), { 'Transactions imported': '965', 'Rows read': '988', 'Duplicates removed': '23', 'Rows skipped': '0' });
      const rows = await page.$$eval('#dp-report-files tbody tr', trs => trs.map(tr => [...tr.children].map(td => td.firstChild ? td.firstChild.textContent.trim() : '')));
      const second = rows.find(r => r[0] === 'checking-2025-11-to-2026-09.csv');
      t.assert.deepEqual(second.slice(1, 5), ['145', '122', '23', '0'], 'the second checking export loses its 23 overlapping rows');
      t.assert.ok((await text(page, '#dp-report-coverage')).includes('Oct 1, 2024 – Sep 30, 2026'), 'checking coverage spans both exports');
      await page.click('#dp-report-dupes > summary');
      t.assert.ok((await text(page, '#dp-report-dupes')).includes('Kept: checking-2024-10-to-2025-12.csv'), 'each removed row names the row that was kept');
      t.assert.ok((await text(page, '#dp-csv-use-card')).includes('Nothing is saved under “alex-sam-test” yet'), 'says which budget will be used');
      await t.shot('data-csv-report');

      // Back keeps the files; forward again keeps the report.
      await page.goBack();
      await page.waitForFunction(() => location.hash === '#/data?load=csv' && document.querySelectorAll('.dp-fileblock').length === 4);
      await page.goForward();
      await page.waitForSelector('#dp-csv-use');

      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dp-csv-use')]);
      await page.waitForSelector('#page-title');
      t.assert.equal(await datasetId(page), 'alex-sam-test', 'the imported data is in use after the reload');
      t.assert.equal(await page.evaluate(() => window.HouseholdBudget.getDataset().transactions.length), 965);
      t.assert.equal(await page.evaluate(() => window.HouseholdBudget.getDataset().isSynthetic), false);
      t.assert.equal(await text(page, '#dataBadge'), 'Private data loaded in this browser');
      t.assert.ok((await text(page, '#view')).includes('Your data is loaded.'));
      const using = await text(page, '#dp-using');
      t.assert.ok(using.includes('Files loaded in this browser') && using.includes('from 4 CSV files'), 'the hub names the loaded files');
      t.assert.ok(using.includes('this profile is the fictional sample'), 'real transactions with the sample profile are called out');
      t.assert.equal((await state(page)).datasetId, 'alex-sam-test', 'the budget is saved under the new data set name');
      await t.shot('data-loaded');

      await page.click('#dp-forget');
      await page.waitForSelector('#dialog[open]');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dialog button[value="ok"]')]);
      await page.waitForSelector('#page-title');
      t.assert.equal(await datasetId(page), 'sample', 'Forget goes back to the built-in sample');
      t.assert.ok((await text(page, '#view')).includes('were forgotten'));
      t.assert.equal(!!(await page.$('#dp-forget')), false);
    },
  },
  {
    name: 'CSV import with a new account, unrecognised columns and an unknown card sign works on a phone',
    viewport: 'phone',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      // Invented rows: a bank with unusual column names, and a card export whose charges and
      // payments are both positive (the sign cannot be worked out).
      const bank = 'When,What,Value\n2026-08-03,Corner bakery,-12.50\n2026-08-05,Example employer payroll,1500.00\n2026-08-09,Hardware store,-48.20\n';
      const card = 'Trans Date,Post Date,Description,Amount\n08/01/2026,08/02/2026,SAMPLE CAFE,4.50\n08/03/2026,08/04/2026,SAMPLE BOOKSHOP,20.00\n08/10/2026,08/10/2026,PAYMENT THANK YOU,24.50\n';
      await page.setInputFiles('#dp-pick-csv', [textFile('export-a.csv', bank, 'text/csv'), textFile('export-b.csv', card, 'text/csv')]);
      await page.waitForFunction(() => document.querySelectorAll('.dp-fileblock').length === 2);
      const [a, b] = await page.$$eval('.dp-fileblock', els => els.map(e => e.id));
      t.assert.equal(await page.$eval(`#${a}-acct`, s => s.value), '', 'no account guessed from an unhelpful file name');

      // New joint checking account for the first file.
      await page.selectOption(`#${a}-acct`, '__new__');
      // Focus moves to the new account name.
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === id + '-nlabel', a);
      await page.fill(`#${a}-nlabel`, 'Test checking');
      await page.click(`#${a}-nadd`);
      await page.waitForFunction(id => document.getElementById(id + '-acct').value === 'test-checking', a);
      t.assert.ok((await text(page, `#${a}`)).includes('column names in this file were not recognised'), 'unrecognised columns are explained');
      t.assert.ok(await page.$eval(`#${a}-cols`, d => d.open), 'column choices are open when the columns are not recognised');
      await t.shot('data-csv-columns');
      await page.selectOption(`#${a}-col-date`, 'When');
      await page.waitForFunction(id => document.getElementById(id + '-col-date').value === 'When', a);
      await page.selectOption(`#${a}-col-description`, 'What');
      await page.waitForFunction(id => document.getElementById(id + '-col-description').value === 'What', a);
      await page.selectOption(`#${a}-col-amount`, 'Value');
      await page.waitForFunction(id => document.getElementById(id).textContent.includes('3 transactions'), a);

      // New card account for the second file: the sign question appears and is answered.
      await page.selectOption(`#${b}-acct`, '__new__');
      await page.waitForSelector(`#${b}-nlabel`);
      await page.fill(`#${b}-nlabel`, 'Test card');
      await page.selectOption(`#${b}-ntype`, 'credit_card');
      await page.click(`#${b}-nadd`);
      await page.waitForSelector(`#${b}-charges[aria-invalid="true"]`);
      t.assert.ok((await text(page, `#${b}`)).includes('does not show whether card charges are positive or negative'), 'the sign problem is shown with the file, in page terms');
      await t.shot('data-csv-sign');
      await page.selectOption(`#${b}-charges`, 'positive');
      await page.waitForFunction(id => document.getElementById(id).textContent.includes('3 transactions'), b);
      await assertStructure(t, 'the CSV files page');
      await t.shot('data-csv-ready');

      await page.fill('#dp-csv-dsid', 'sample');
      await page.press('#dp-csv-dsid', 'Tab');
      t.assert.ok((await text(page, '#dp-csv-dsid-error')).includes('reserved'), 'the sample name is refused');
      await page.fill('#dp-csv-dsid', 'phone-test');
      await page.click('#dp-csv-check-btn');
      await page.waitForSelector('#dp-csv-use');
      t.assert.deepEqual(
        Object.fromEntries(await page.$$eval('.dp-metrics .metric', els => els.map(e => [e.querySelector('.metric-label').textContent, e.querySelector('.metric-value').textContent]))),
        { 'Transactions imported': '6', 'Rows read': '6', 'Duplicates removed': '0', 'Rows skipped': '0' });
      t.assert.ok((await text(page, '#dp-report-reading')).includes('Charges positive (set in mapping)'), 'the chosen sign is reported');
      await assertStructure(t, 'the phone report');
      await t.shot('data-csv-report');
    },
  },
  {
    name: 'data too large for browser storage shows a friendly error and recommends the command-line import',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await importSample(t, { rules: false, dsid: 'too-big' });
      await page.evaluate(() => {
        const orig = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (k === 'household-budget:loaded-dataset') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          return orig.call(this, k, v);
        };
      });
      await page.click('#dp-csv-use');
      await page.waitForSelector('#dp-csv-use-error');
      const msg = await text(page, '#dp-csv-use-error');
      t.assert.ok(msg.includes('too large for local storage'), 'the app’s friendly message is shown');
      t.assert.ok(msg.includes('node tools/import.cjs') && msg.includes('private copy'), 'recommends the command-line import and a private build');
      t.assert.ok((await page.evaluate(() => location.hash)).includes('step=report'), 'still on the report');
      t.assert.equal(await datasetId(page), 'sample', 'nothing changed');
      await t.shot('data-too-large');
    },
  },
  {
    name: 'a prepared data file is summarised before use; a wrong file is explained',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await page.setInputFiles('#dp-pick-dataset', textFile('household-profile.json', JSON.stringify(readJSON('fixtures/sample-profile.json'))));
      await page.waitForSelector('#dp-dataset-result');
      t.assert.ok((await text(page, '#dp-dataset-result')).includes('looks like a household profile'), 'a profile is not taken for data');
      await page.setInputFiles('#dp-dataset-pick', textFile('legacy-v1-sample.json', fs.readFileSync(path.join(ROOT, 'fixtures/legacy-v1-sample.json'), 'utf8')));
      await page.waitForSelector('#dp-dataset-use');
      const summary = await text(page, '#dp-dataset-file');
      t.assert.ok(summary.includes('legacy-sample') && summary.includes('earlier version’s format') && summary.includes('576 transactions'));
      t.assert.equal(await datasetId(page), 'sample', 'nothing applied yet');
      await assertStructure(t, 'the data file page');
      await t.shot('data-dataset');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dp-dataset-use')]);
      await page.waitForSelector('#page-title');
      t.assert.equal(await datasetId(page), 'legacy-sample');
      t.assert.ok((await text(page, '#dp-using')).includes('from “legacy-v1-sample.json”'));
    },
  },
  {
    name: 'a household profile is validated, summarised, and starts the budget when chosen',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      const prof = readJSON('fixtures/sample-profile.json');
      prof.household.name = 'Test household (fictional)';
      prof.plan.targets.Groceries = 43210;
      prof.plan.bills[0].monthlyCents = -5; // invalid: reported, treated as unknown
      await page.setInputFiles('#dp-pick-profile', textFile('test-profile.json', JSON.stringify(prof)));
      await page.waitForSelector('#dp-profile-use');
      const summary = await text(page, '#dp-profile-file');
      t.assert.ok(summary.includes('Test household (fictional)'));
      t.assert.ok(summary.includes('could not be used as written') && summary.includes('monthlyCents'), 'invalid values are listed');
      t.assert.ok(await page.isChecked('#dp-profile-start'), 'replacing the sample plan is the default');
      await assertStructure(t, 'the profile page');
      await t.shot('data-profile');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dp-profile-use')]);
      await page.waitForSelector('#page-title');
      t.assert.ok((await text(page, '#dp-using')).includes('Test household (fictional)'), 'the loaded profile is in use');
      t.assert.equal((await state(page)).plan.targets.Groceries, 43210, 'the budget started from the profile');
      t.assert.ok((await text(page, '#view')).includes('household profile is loaded'));
    },
  },
  {
    name: 'workbook export downloads JSON that re-imports and restores a changed target',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await setGroceries(page, 12345);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dp-export-wb')]);
      t.assert.match(dl.suggestedFilename(), /^household-budget-workbook-\d{4}-\d{2}-\d{2}\.json$/);
      const body = fs.readFileSync(await dl.path(), 'utf8');
      const wb = JSON.parse(body);
      t.assert.equal(wb.format, 'household-budget-workbook');
      t.assert.equal(wb.datasetId, 'sample');
      t.assert.equal(wb.state.plan.targets.Groceries, 12345);
      t.assert.ok(!/"transactions"/.test(body), 'a workbook holds no transactions');

      await setGroceries(page, 99999);
      await page.setInputFiles('#dp-pick-workbook', textFile(dl.suggestedFilename(), body));
      await page.waitForSelector('#dp-wb-apply');
      t.assert.ok((await text(page, '#dp-workbook-file')).includes('Groceries target: $999.99 → $123.45'), 'the preview says what will change');
      t.assert.equal((await state(page)).plan.targets.Groceries, 99999, 'nothing is replaced before confirming');
      await assertStructure(t, 'the workbook page');
      await t.shot('data-workbook');
      await page.click('#dp-wb-apply');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 12345);
      await page.waitForFunction(() => location.hash === '#/data');
      await page.click('#toast button[data-action="undo"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 99999);
    },
  },
  {
    name: 'an HTML copy downloaded from the earlier version migrates and shows upgrade notes',
    viewport: 'both',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      const html = '<!doctype html><html><head><title>Budget</title></head><body><p>Earlier copy</p>'
        + '<script id="budget-state" type="application/json">{"copyId":"copy-1","state":{"version":4,"personAPay":3000,"personAFrequency":"biweekly","targets":{"groceries":512}}}</script></body></html>';
      await page.setInputFiles('#dp-pick-workbook', textFile('household-budget-copy.html', html, 'text/html'));
      await page.waitForSelector('#dp-wb-apply');
      const preview = await text(page, '#dp-workbook-file');
      t.assert.ok(preview.includes('Page downloaded from the earlier version'));
      t.assert.ok(preview.includes('copy "copy-1"'), 'the migration notes are shown before replacing');
      t.assert.ok(preview.includes('Groceries target: $600.00 → $512.00'));
      await page.click('#dp-wb-apply');
      await page.waitForSelector('#dp-upgrade');
      const st = await state(page);
      t.assert.equal(st.meta.migratedFrom, 4);
      t.assert.equal(st.plan.targets.Groceries, 51200);
      t.assert.equal(st.plan.incomes.find(i => i.id === 'p1-pay').netPerPaycheckCents, 300000);
      await page.click('#dp-upgrade-notes > summary');
      const notes = await text(page, '#dp-upgrade');
      t.assert.ok(notes.includes('saved-budget version 4') && notes.includes('kept $512.00') && notes.includes('left untouched'));
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dp-backup')]);
      t.assert.match(dl.suggestedFilename(), /^household-budget-pre-upgrade-backup-\d{4}-\d{2}-\d{2}\.json$/);
      t.assert.ok(fs.readFileSync(await dl.path(), 'utf8').includes('"copyId":"copy-1"'), 'the backup holds the earlier data as found');
      await assertStructure(t, 'the hub with upgrade notes');
      await t.shot('data-upgrade');
    },
  },
  {
    name: 'corrected transactions CSV keeps the original bank category, the reason and the edit history',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      let edited;
      await waitForRender(page, async () => {
        edited = await page.evaluate(() => {
          const H = window.HouseholdBudget;
          const txn = H.getDataset().transactions.find(x => x.kind === 'spend' && x.sourceCategory && x.category !== 'Dining & takeout');
          const edit = H.engine.review.editRecord(null, 'category', 'Dining & takeout', 'Checked the receipt (test)', '2026-10-01T12:00:00.000Z');
          const s = H.getState();
          H.setState({ ...s, ledgerEdits: { ...s.ledgerEdits, [txn.id]: edit } });
          return { id: txn.id, source: txn.sourceCategory };
        });
      });
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dp-export-csv')]);
      t.assert.match(dl.suggestedFilename(), /^household-budget-transactions-\d{4}-\d{2}-\d{2}\.csv$/);
      const E = loadEngine();
      const rows = E.importer.parseCSV(fs.readFileSync(await dl.path(), 'utf8'));
      const head = rows[0];
      for (const col of ['Date', 'Account', 'Description', 'Merchant', 'Amount (money out negative)', 'Kind', 'Category', 'Original bank category', 'Category reason', 'Flags', 'Excluded', 'Edit reasons']) {
        t.assert.ok(head.includes(col), 'column ' + col);
      }
      t.assert.equal(rows.length - 1, 965, 'one line per transaction');
      const row = Object.fromEntries(head.map((h, i) => [h, rows.find(r => r[r.length - 1] === edited.id)[i]]));
      t.assert.equal(row.Category, 'Dining & takeout');
      t.assert.equal(row['Original bank category'], edited.source);
      t.assert.equal(row['Category reason'], 'Checked the receipt (test)');
      t.assert.ok(row['Edit reasons'].includes('category: Checked the receipt (test)'));
    },
  },
  {
    name: 'reset asks for confirmation, restores the profile values and can be undone',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await setGroceries(page, 12345);
      await page.click('#dp-reset');
      await page.waitForSelector('#dialog[open]');
      const body = await text(page, '#dialog');
      t.assert.ok(body.includes('Export a workbook first') && body.includes('undo'), 'the dialog explains what is lost and suggests a workbook');
      await t.shot('data-reset-dialog');
      await page.click('#dialog button[value="cancel"]');
      await page.waitForFunction(() => !document.getElementById('dialog').open);
      t.assert.equal((await state(page)).plan.targets.Groceries, 12345, 'cancel keeps the budget');
      await page.click('#dp-reset');
      await page.waitForSelector('#dialog[open]');
      await page.click('#dialog button[value="ok"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 60000);
      t.assert.ok((await text(page, '#toast')).includes('reset'));
      await page.click('#toast button[data-action="undo"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 12345);
    },
  },
  {
    name: 'keyboard: file inputs open from the keyboard and buttons work with Enter',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await page.focus('#page-title');
      let reached = false;
      for (let i = 0; i < 40 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => document.activeElement && document.activeElement.id === 'dp-pick-csv');
      }
      t.assert.ok(reached, 'Tab reaches the CSV file input');
      const outline = await page.$eval('label[for="dp-pick-csv"]', l => getComputedStyle(l).outlineStyle);
      t.assert.equal(outline, 'solid', 'its visible label shows the focus ring');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Space')]);
      t.assert.ok(chooser.isMultiple(), 'several files can be chosen at once');
      await chooser.setFiles(SAMPLE.map(f => csvFile(f.name)));
      await page.waitForFunction(() => document.querySelectorAll('.dp-fileblock').length === 4);
      await page.focus('#dp-csv-dsid');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#dp-csv-use');
      t.assert.equal(await page.$eval('#dp-csv-use', b => b.tagName), 'BUTTON');
      await page.focus('#dp-csv-use-cancel');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.hash === '#/data');
      // A plain button on the hub, from the keyboard.
      await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed += 1; }; });
      await page.focus('#dp-print');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.hash.startsWith('#/budget') && window.__printed === 1);
    },
  },

  {
    name: 'record counts link to every row behind them; rows left out of totals are counted and explained',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await excludeOne(page);
      const records = await text(page, '#dp-using');
      t.assert.ok(records.includes('965 transactions in 4 accounts'), 'the count is still every row in the data');
      t.assert.ok(records.includes('1 of them is not counted in totals'), 'the excluded row is called out next to the count');
      t.assert.ok((await text(page, '#dp-using table')).includes('299 transactions'), 'the account count includes it too');
      const hrefs = await page.$$eval('#dp-using a[href^="#/spending"]', as => as.map(a => a.getAttribute('href')));
      t.assert.ok(hrefs.length === 4 && hrefs.every(h => h.endsWith('&show=excluded')), 'every count opens a list that includes rows not counted');
    },
  },
  {
    name: 'export dates typed from the keyboard stay whole; a reversed or mistyped period is caught before checking',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await page.setInputFiles('#dp-pick-csv', SAMPLE.map(f => csvFile(f.name)));
      await page.waitForFunction(() => document.querySelectorAll('.dp-fileblock').length === 4);
      const b = await page.$eval('.dp-fileblock', e => e.id);
      // Each part of a typed date reports a change; the field must not be rebuilt in between.
      await page.focus(`#${b}-cs`);
      await page.keyboard.type('10012024');
      await page.waitForFunction(id => document.getElementById(id + '-cs').value === '2024-10-01', b);
      t.assert.equal(await page.evaluate(() => document.activeElement.id), `${b}-cs`, 'the date field keeps focus while typing');
      await page.focus(`#${b}-ce`);
      await page.keyboard.type('09302024');
      await page.waitForFunction(id => !document.getElementById(id + '-cover-error').hidden, b);
      t.assert.equal(await text(page, `#${b}-cover-error`), 'The end is before the start.');
      t.assert.equal(await page.$eval(`#${b}-ce`, el => el.getAttribute('aria-invalid')), 'true');
      t.assert.equal(await page.evaluate(() => document.activeElement.id), `${b}-ce`, 'the error appears without moving focus');
      await page.click('#dp-csv-check-btn');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'dp-csv-error');
      t.assert.ok((await text(page, '#dp-csv-error')).includes('export dates: The end is before the start.'), 'the check refuses a reversed period');
      t.assert.ok(!(await page.evaluate(() => location.hash)).includes('step=report'));
      await page.focus(`#${b}-ce`);
      await page.keyboard.type('12312025');
      await page.waitForFunction(id => document.getElementById(id + '-ce').value === '2025-12-31' && document.getElementById(id + '-cover-error').hidden, b);
      t.assert.equal(await page.$eval(`#${b}-cs`, el => el.getAttribute('aria-invalid')), null, 'fixed: no longer marked invalid');
      await page.click('#dp-csv-check-btn');
      await page.waitForSelector('#dp-csv-use');
      t.assert.ok((await text(page, '#dp-report-files')).includes('Counted as covering Oct 1, 2024 – Dec 31, 2025'), 'the typed period is used');
    },
  },
  {
    name: 'files with no readable transactions are flagged, never marked read, and cannot replace the data',
    viewport: 'both',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await page.setInputFiles('#dp-pick-csv', [
        textFile('empty-card.csv', '', 'text/csv'),
        textFile('quiet-savings.csv', 'Date,Description,Amount\n', 'text/csv'),
        textFile('day-first-checking.csv', 'Date,Description,Amount\n13/08/2026,Sample bakery,-5.00\n14/08/2026,Sample shop,-7.25\n', 'text/csv'),
      ]);
      await page.waitForFunction(() => document.querySelectorAll('.dp-fileblock').length === 3);
      const [empty, quiet, dmy] = await page.$$eval('.dp-fileblock', els => els.map(e => e.id));
      for (const id of [empty, quiet, dmy]) {
        t.assert.ok((await text(page, '#' + id)).includes('No transactions could be read'), 'flagged: ' + id);
        t.assert.equal(!!(await page.$(`#${id} .dp-fstatus .badge-good`)), false, 'no green "Read" badge for ' + id);
      }
      t.assert.ok((await text(page, '#' + empty)).includes('The file has no rows.'));
      t.assert.ok((await text(page, '#' + quiet)).includes('It has column names but no transactions.'));
      t.assert.ok((await text(page, '#' + dmy)).includes('day first'), 'day-first dates are recognised as the likely cause');
      t.assert.ok(await page.$eval(`#${dmy}-cols`, d => d.open), 'the column settings are open for it');
      await assertStructure(t, 'the files page with unreadable files');
      await t.shot('data-csv-unreadable');

      await page.click('#dp-csv-check-btn');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'dp-csv-error');
      const errors = await text(page, '#dp-csv-error');
      for (const name of ['empty-card.csv', 'quiet-savings.csv', 'day-first-checking.csv']) t.assert.ok(errors.includes(`“${name}”: no transactions could be read`), 'refused: ' + name);
      t.assert.ok(!(await page.evaluate(() => location.hash)).includes('step=report'), 'no report for files that would replace the data with nothing');

      // Fix each one: day-first order, a quiet account with its export period, and remove the empty file.
      await page.selectOption(`#${dmy}-datefmt`, 'DMY');
      await page.waitForFunction(id => /Read\s*2 transactions/.test(document.getElementById(id).textContent), dmy);
      await page.fill(`#${quiet}-cs`, '2026-08-01');
      await page.fill(`#${quiet}-ce`, '2026-08-31');
      await page.click(`#${empty}-remove`);
      await page.waitForFunction(() => document.querySelectorAll('.dp-fileblock').length === 2);
      await page.click('#dp-csv-check-btn');
      await page.waitForSelector('#dp-csv-use');
      t.assert.equal(await page.$eval('.dp-metrics .metric-value', el => el.textContent), '2');
      t.assert.ok((await text(page, '#dp-report-coverage')).includes('Aug 1, 2026 – Aug 31, 2026'), 'a quiet account counts as covered for the period entered');
    },
  },
  {
    name: 'import report: findings before the decision on phones, the decision stays beside them on desktop, removed rows readable at 360px',
    viewport: 'both',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await importSample(t, { rules: false });
      await page.$eval('#dp-report-dupes', d => { d.open = true; });
      const order = await page.evaluate(() => {
        const all = [...document.querySelectorAll('#view .card')].map(c => c.id);
        const top = id => document.getElementById(id).getBoundingClientRect().top;
        return { all, useTop: top('dp-csv-use-card'), flagsTop: top('dp-report-flags'), rowsTop: top('dp-report-rows') };
      });
      t.assert.ok(order.all.indexOf('dp-report-flags') < order.all.indexOf('dp-csv-use-card'), 'the findings come before the decision in reading order');
      t.assert.ok(order.all.indexOf('dp-csv-use-card') < order.all.indexOf('dp-report-rows'), 'the row-by-row audit comes last');
      if (t.viewport === 'desktop') {
        t.assert.equal(await page.$eval('.dp-aside', el => getComputedStyle(el).position), 'sticky', 'the decision stays in view while reading');
        t.assert.ok(order.useTop < order.flagsTop, 'beside the report, at its top');
      } else {
        t.assert.ok(order.useTop > order.flagsTop && order.useTop < order.rowsTop, 'on a phone: after the findings, before the audit');
      }
      const fits = () => page.$eval('#dp-report-dupes .table-wrap', w => w.scrollWidth <= w.clientWidth + 1);
      t.assert.ok(await fits(), 'the removed-rows table needs no sideways scrolling');
      t.assert.ok((await text(page, '#dp-report-dupes tbody tr')).includes('Kept: checking-2024-10-to-2025-12.csv'), 'each row says where it was removed and which row was kept');
      await assertStructure(t, 'the import report');
      if (t.viewport === 'phone') {
        await page.setViewportSize({ width: 360, height: 780 });
        await page.waitForFunction(() => window.innerWidth === 360);
        t.assert.ok(await fits(), 'and at 360px');
        await assertStructure(t, 'the import report at 360px');
        await t.shot('data-report-360');
      }
    },
  },
  {
    name: 'a report made stale by a change says so and leads back to the files',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await importSample(t, { rules: false });
      await page.goBack();
      await page.waitForFunction(() => document.querySelectorAll('.dp-fileblock').length === 4);
      const b = await page.$eval('.dp-fileblock', e => e.id);
      await page.selectOption(`#${b}-acct`, 'joint-savings');
      await page.waitForFunction(id => document.getElementById(id + '-acct').value === 'joint-savings', b);
      await page.goForward();
      await page.waitForSelector('#dp-report-none');
      const msg = await text(page, '#dp-report-none');
      t.assert.ok(msg.includes('Report out of date') && msg.includes('Go back to the 4 files'), 'explains why there is no report');
      t.assert.equal(!!(await page.$('#dp-csv-use')), false, 'nothing can be used from a stale report');
      await page.click('#dp-report-none a.btn');
      await page.waitForFunction(() => location.hash === '#/data?load=csv' && document.querySelectorAll('.dp-fileblock').length === 4);
    },
  },
  {
    name: 'loaded data that cannot be read is reported as not in use, and Forget recovers',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await page.evaluate(() => localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({
        dataset: { schemaVersion: 2, datasetId: 'broken-test', accounts: [], transactions: [{ id: 'x' }] },
        loadedAt: '2026-09-01T10:00:00.000Z', source: 'json', file: 'broken-test.json',
      })));
      await page.reload();
      await page.waitForSelector('#dp-using');
      const using = await text(page, '#dp-using');
      t.assert.ok(using.includes('The loaded data could not be read'), 'the error is shown');
      t.assert.ok(using.includes('Files loaded in this browser could not be read') && using.includes('Not in use'), 'the source says it is not in use');
      t.assert.ok(!using.includes('Used instead of'), 'never claims the unreadable file is in use');
      t.assert.ok((await text(page, '#dp-load')).includes('could not be read, so it is not in use'));
      t.assert.ok(await page.$eval('.dp-using-error', el => el.getBoundingClientRect().bottom < document.querySelector('.dp-facts').getBoundingClientRect().top), 'the error does not touch the facts below it');
      await page.click('#dp-forget-error');
      await page.waitForSelector('#dialog[open]');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dialog button[value="ok"]')]);
      await page.waitForSelector('#dp-using');
      t.assert.equal(await datasetId(page), 'sample', 'back to the built-in sample');
    },
  },
  {
    name: 'without browser storage the page says nothing is kept and does not load files it would lose',
    async run(t) {
      const { page } = t;
      await t.context.addInitScript(() => {
        Storage.prototype.setItem = function () { throw new DOMException('Blocked for this test', 'SecurityError'); };
      });
      await t.open('#/data');
      const save = await text(page, '#dp-save');
      t.assert.ok(save.indexOf('Changes are not being saved') < save.indexOf('Normally saved automatically'), 'the warning comes first');
      t.assert.ok(!save.includes('Every change is kept'), 'never claims changes are being kept');
      t.assert.ok((await text(page, '#dp-using')).includes('Not saved'));
      await importSample(t, { rules: false });
      await page.click('#dp-csv-use');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'dp-csv-use-error');
      t.assert.ok((await text(page, '#dp-csv-use-error')).includes('not letting the page keep anything'));
      t.assert.ok((await page.evaluate(() => location.hash)).includes('step=report'), 'still on the report');
      t.assert.equal(await datasetId(page), 'sample');
    },
  },
  {
    name: 'text from files and the saved budget is shown as text, never run',
    async run(t) {
      const { page } = t;
      const X = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
      const ran = () => page.evaluate(() => ({ ran: window.__xss || 0, imgs: document.querySelectorAll('#view img, #dialog img').length }));
      await t.open('#/data');
      await waitForRender(page, () => page.evaluate(X => {
        const H = window.HouseholdBudget;
        let st = H.getState();
        st = H.engine.state.setPath(st, 'plan.people[id=p1].name', X.slice(0, 80));
        st = H.engine.state.addScenario(st, X.slice(0, 80));
        st = { ...st, meta: { ...st.meta, migratedFrom: 3, migrationNotes: [X], legacySnapshot: JSON.stringify({ note: X }) } };
        H.setState(st);
      }, X));
      await page.click('#dp-upgrade-notes > summary');
      t.assert.ok((await text(page, '#dp-upgrade')).includes(X), 'the note is shown literally');
      t.assert.deepEqual(await ran(), { ran: 0, imgs: 0 }, 'hub');
      await page.click('#dp-reset');
      await page.waitForSelector('#dialog[open]');
      t.assert.deepEqual(await ran(), { ran: 0, imgs: 0 }, 'reset dialog');
      await page.click('#dialog button[value="cancel"]');
      await page.waitForFunction(() => !document.getElementById('dialog').open);

      const csv = 'Date,Description,Amount\n2026-08-03,"' + X.replace(/"/g, '""') + '",-12.50\n2026-08-05,Sample deposit,15.00\n';
      await page.setInputFiles('#dp-pick-csv', [textFile(X.replace(/["/]/g, '') + '.csv', csv, 'text/csv')]);
      await page.waitForSelector('.dp-fileblock');
      const b = await page.$eval('.dp-fileblock', e => e.id);
      await page.selectOption(`#${b}-acct`, '__new__');
      await page.waitForSelector(`#${b}-nlabel`);
      await page.fill(`#${b}-nlabel`, X.slice(0, 80));
      await page.click(`#${b}-nadd`);
      await page.waitForFunction(id => document.getElementById(id + '-acct').value !== '__new__', b);
      t.assert.deepEqual(await ran(), { ran: 0, imgs: 0 }, 'files page');
      await page.fill('#dp-csv-dsid', 'text-test');
      await page.click('#dp-csv-check-btn');
      await page.waitForSelector('#dp-csv-use');
      t.assert.deepEqual(await ran(), { ran: 0, imgs: 0 }, 'import report');

      const ds = readJSON('fixtures/sample-data.json');
      ds.datasetId = 'text-test-2';
      ds.accounts[0].label = X;
      ds.notes = [X];
      await page.goto(t.url + '#/data');
      await page.waitForSelector('#dp-pick-dataset');
      await page.setInputFiles('#dp-pick-dataset', textFile(X.replace(/["/]/g, '') + '.json', JSON.stringify(ds)));
      await page.waitForSelector('#dp-dataset-use');
      await page.click('#dp-dataset-notes > summary');
      t.assert.deepEqual(await ran(), { ran: 0, imgs: 0 }, 'data file page');
    },
  },
  {
    name: 'a data file, profile or rules file chosen as a workbook is explained',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      const cases = [
        ['fixtures/sample-data.json', 'data file with transactions'],
        ['fixtures/sample-profile.json', 'household profile, not a workbook'],
        ['fixtures/sample-rules.json', 'rules file'],
      ];
      for (const [rel, phrase] of cases) {
        await page.goto(t.url + '#/data');
        await page.waitForSelector('#dp-pick-workbook');
        await page.setInputFiles('#dp-pick-workbook', textFile(path.basename(rel), fs.readFileSync(path.join(ROOT, rel), 'utf8')));
        await page.waitForSelector('#dp-workbook-result');
        t.assert.ok((await text(page, '#dp-workbook-result')).includes(phrase), rel + ' is explained');
        t.assert.equal(!!(await page.$('#dp-wb-apply')), false, 'nothing to replace with');
      }
    },
  },
  {
    name: 'an earlier budget in this browser is upgraded on opening; its notes are listed once',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('sample-household-budget-v1-local-sample', JSON.stringify({ version: 4, personAPay: 3000, personAFrequency: 'biweekly', targets: { groceries: 512 } }));
      });
      await page.reload();
      await page.waitForSelector('#dp-upgrade');
      t.assert.ok((await text(page, '#toast')).includes('upgraded'));
      await page.click('#dp-upgrade-notes > summary');
      t.assert.ok((await text(page, '#dp-upgrade')).includes('kept $512.00'));
      const opening = await page.$('#dp-loadnotes') ? await page.$eval('#dp-loadnotes', d => { d.open = true; return d.textContent; }) : '';
      t.assert.ok(!opening.includes('kept $512.00'), 'upgrade notes are not repeated under the notes from opening the page');
      t.assert.ok(opening.includes('left in place'), 'the other note is still listed');
      t.assert.ok(await page.evaluate(() => localStorage.getItem('sample-household-budget-v1-local-sample') !== null), 'the earlier saved data is left untouched');
    },
  },

  {
    name: 'a household profile can be loaded while keeping the budget saved in this browser',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      await setGroceries(page, 12345);
      const prof = readJSON('fixtures/sample-profile.json');
      prof.household.name = 'Kept-budget test (fictional)';
      prof.plan.targets.Fuel = 14100;
      prof.plan.targets.Groceries = 43210;
      await page.setInputFiles('#dp-pick-profile', textFile('kept-profile.json', JSON.stringify(prof)));
      await page.waitForSelector('#dp-profile-keep');
      t.assert.ok((await text(page, '#dp-profile-decide')).includes('What you changed here stays as it is'), 'says what keeping means');
      await page.check('#dp-profile-keep');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dp-profile-use')]);
      await page.waitForSelector('#dp-using');
      t.assert.ok((await text(page, '#dp-using')).includes('Kept-budget test (fictional)'), 'the profile is in use');
      t.assert.equal((await state(page)).plan.targets.Groceries, 12345, 'the saved budget was kept');
      t.assert.equal((await state(page)).plan.targets.Fuel, 14100, 'a target never changed here follows the profile');
    },
  },
  {
    name: 'a workbook made for other data is flagged before it replaces the budget',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      const body = await page.evaluate(() => {
        const H = window.HouseholdBudget;
        return H.engine.state.exportWorkbook({ ...H.getState(), datasetId: 'other-data' }, { datasetId: 'other-data', now: '2026-09-15T12:00:00.000Z' });
      });
      await page.setInputFiles('#dp-pick-workbook', textFile('other-workbook.json', body));
      await page.waitForSelector('#dp-wb-apply');
      const preview = await text(page, '#dp-workbook-file');
      t.assert.ok(preview.includes('Made for different data') && preview.includes('“other-data”') && preview.includes('“sample”'), 'the mismatch is explained');
      t.assert.ok(preview.includes('Budget workbook, exported Sep 15, 2026'));
    },
  },
  {
    name: 'adding a newer export: summary first, only new rows added, corrections and ids kept, saved across reloads',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      const newer = newerChecking();
      // A correction on a September row that the newer export repeats.
      const edited = await excludeRow(page, '2026-09-22', 'SAMPLE WIRELESS');
      const editsBefore = Object.keys((await state(page)).ledgerEdits);
      await page.setInputFiles('#dp-pick-csv', [textFile(NEWER_NAME, newer.text, 'text/csv')]);
      await page.waitForFunction(() => document.querySelectorAll('.dp-fileblock').length === 1);
      const [block] = await page.$$eval('.dp-fileblock', els => els.map(e => e.id));
      t.assert.equal(await page.$eval(`#${block}-acct`, s => s.value), 'joint-checking', 'the account is taken from the file name');
      // The fictional sample is replaced by default; adding to it is one choice away.
      t.assert.ok(await page.isChecked('#dp-csv-mode-replace'), 'the sample is replaced by default');
      await waitForRender(page, () => page.check('#dp-csv-mode-add'));
      t.assert.ok(await page.isChecked('#dp-csv-mode-add'));
      t.assert.equal(!!(await page.$('#dp-csv-dsid')), false, 'adding keeps the data set name: no name to choose');
      t.assert.ok((await text(page, '#dp-csv-dsid-status')).includes('every transaction keeps its id'));
      await page.fill(`#${block}-cs`, '2026-09-01');
      await page.fill(`#${block}-ce`, '2026-10-31');
      await page.waitForFunction(id => document.getElementById(id + '-ce').value === '2026-10-31', block);
      await page.setInputFiles('#dp-pick-rules', textFile('sample-rules.json', fs.readFileSync(path.join(ROOT, 'fixtures/sample-rules.json'), 'utf8')));
      await page.waitForSelector('#dp-rules-remove');
      t.assert.equal(await text(page, '#dp-csv-check-btn'), 'Check what will be added');
      await page.click('#dp-csv-check-btn');
      await page.waitForSelector('#dp-merge-apply');
      await assertStructure(t, 'the summary of what will be added');

      const line = `${newer.added} new, ${newer.overlap} already present, coverage now to Oct 31, 2026, 1 balance added.`;
      t.assert.equal(await text(page, '#dp-merge-line'), line, 'one line says what will happen');
      const metrics = Object.fromEntries(await page.$$eval('.dp-metrics .metric', els => els.map(e => [e.querySelector('.metric-label').textContent, e.querySelector('.metric-value').textContent])));
      t.assert.deepEqual(metrics, { 'New transactions': String(newer.added), 'Already in your data': String(newer.overlap), 'Covered to': 'Oct 31, 2026', 'Rows skipped': '0' });
      const accounts = await text(page, '#dp-merge-accounts');
      t.assert.ok(accounts.includes('Joint checking') && accounts.includes('Oct 1, 2024 – Oct 31, 2026') && accounts.includes('Before: Oct 1, 2024 – Sep 30, 2026'), 'coverage before and after');
      t.assert.ok(!accounts.includes('Joint rewards card'), 'accounts without new files are left out of the table');
      const balances = await text(page, '#dp-merge-balances');
      t.assert.ok(balances.includes('Oct 31, 2026') && balances.includes(money(newer.endCents)) && balances.includes('running balance'), 'the export’s closing balance is added');
      await page.click('#dp-merge-present > summary');
      t.assert.equal(await page.$$eval('#dp-merge-present tbody tr', trs => trs.length), newer.overlap, 'every row already in the data is listed');
      t.assert.equal(await page.evaluate(() => window.HouseholdBudget.getDataset().transactions.length), 965, 'nothing changes before Add');
      await t.shot('data-merge-summary');

      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dp-merge-apply')]);
      await page.waitForSelector('#dp-using');
      t.assert.equal(await text(page, '#dp-merged-line'), line, 'the confirmation repeats what was added');
      const after = await page.evaluate(() => window.HouseholdBudget.getDataset());
      t.assert.equal(after.transactions.length, 965 + newer.added, 'only the new rows are added');
      t.assert.equal(after.datasetId, 'sample', 'the data set keeps its name, so the saved budget stays');
      t.assert.deepEqual(after.balances.filter(b => b.date === '2026-10-31'), [{ accountId: 'joint-checking', date: '2026-10-31', cents: newer.endCents, source: 'bank', note: after.balances.find(b => b.date === '2026-10-31').note }]);
      t.assert.ok(after.transactions.some(x => x.id === edited), 'the corrected row keeps its id');
      t.assert.deepEqual(Object.keys((await state(page)).ledgerEdits), editsBefore, 'corrections are kept');
      t.assert.equal(await page.evaluate(id => window.HouseholdBudget.context().txns.find(x => x.id === id).excluded, edited), 'duplicate', 'and still apply');
      t.assert.ok((await text(page, '#dp-using')).includes('from the built-in fictional sample plus 1 CSV file'), 'the hub says what was added to what');
      t.assert.ok((await text(page, '#dp-using table')).includes('Oct 1, 2024 – Oct 31, 2026'), 'coverage extended');

      await page.reload();
      await page.waitForSelector('#dp-using');
      t.assert.equal(await page.evaluate(() => window.HouseholdBudget.getDataset().transactions.length), 965 + newer.added, 'the added rows are kept after a reload');
      t.assert.equal(await page.evaluate(id => window.HouseholdBudget.context().txns.find(x => x.id === id).excluded, edited), 'duplicate');

      // Loading the same export again adds nothing.
      await page.setInputFiles('#dp-pick-csv', [textFile(NEWER_NAME, newer.text, 'text/csv')]);
      await page.waitForSelector('#dp-csv-mode-add:checked');
      const [again] = await page.$$eval('.dp-fileblock', els => els.map(e => e.id));
      await page.fill(`#${again}-cs`, '2026-09-01');
      await page.fill(`#${again}-ce`, '2026-10-31');
      await page.waitForFunction(id => document.getElementById(id + '-ce').value === '2026-10-31', again);
      await page.click('#dp-csv-check-btn');
      await page.waitForSelector('#dp-merge-apply');
      t.assert.equal(await text(page, '#dp-merge-line'), `0 new, ${newer.overlap + newer.added} already present, coverage now to Oct 31, 2026.`, 'household data is added to by default, and a repeat adds nothing');
    },
  },
  {
    name: 'adding to the data: the data file and a workbook round-trip the added rows, their balances and corrections',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      const newer = newerChecking();
      await mergeNewer(t, newer);
      // A correction on a row that exists only since the export was added.
      const fresh = await excludeRow(page, '2026-10-09', 'LANTERN BAKERY');
      const [wbDl] = await Promise.all([page.waitForEvent('download'), page.click('#dp-export-wb')]);
      const workbook = fs.readFileSync(await wbDl.path(), 'utf8');
      const [dataDl] = await Promise.all([page.waitForEvent('download'), page.click('#dp-export-data')]);
      t.assert.match(dataDl.suggestedFilename(), /^household-budget-data-\d{4}-\d{2}-\d{2}\.json$/);
      const dataText = fs.readFileSync(await dataDl.path(), 'utf8');
      const merged = await page.evaluate(() => window.HouseholdBudget.getDataset());
      t.assert.deepEqual(JSON.parse(dataText), merged, 'the data file is the data in use');

      // Back to the built-in sample: the correction no longer has its row.
      await page.click('#dp-forget');
      await page.waitForSelector('#dialog[open]');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dialog button[value="ok"]')]);
      await page.waitForSelector('#dp-using');
      t.assert.equal(await page.evaluate(() => window.HouseholdBudget.getDataset().transactions.length), 965);

      // The data file brings back the same rows, ids and balances, and the corrections find them.
      await page.setInputFiles('#dp-pick-dataset', textFile(dataDl.suggestedFilename(), dataText));
      await page.waitForSelector('#dp-dataset-use');
      t.assert.ok((await text(page, '#dp-dataset-file')).includes(`${965 + newer.added} transactions`));
      t.assert.ok((await text(page, '#dp-dataset-file')).includes('5 balances'), 'the data file carries its balances (the sample brokerage statements too)');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dp-dataset-use')]);
      await page.waitForSelector('#dp-using');
      const back = await page.evaluate(() => window.HouseholdBudget.getDataset());
      t.assert.deepEqual(back.transactions.map(x => x.id), merged.transactions.map(x => x.id), 'same ids');
      t.assert.deepEqual(back.balances, merged.balances, 'same balances');
      t.assert.equal(await page.evaluate(id => window.HouseholdBudget.context().txns.find(x => x.id === id).excluded, fresh), 'duplicate', 'the saved correction applies again');

      // A workbook made after the merge re-imports with every correction matching a transaction.
      await page.setInputFiles('#dp-pick-workbook', textFile(wbDl.suggestedFilename(), workbook));
      await page.waitForSelector('#dp-wb-apply');
      const edits = Object.keys(JSON.parse(workbook).state.ledgerEdits).length;
      t.assert.ok((await text(page, '#dp-workbook-file')).includes(`${edits} now → ${edits} in the file (${edits} match transactions in the data used now)`), 'every correction in the workbook matches');
    },
  },
  {
    name: 'Replace instead asks first, then uses only the chosen files',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      const newer = newerChecking();
      await page.setInputFiles('#dp-pick-csv', [textFile(NEWER_NAME, newer.text, 'text/csv')]);
      await page.waitForSelector('#dp-csv-mode-add');
      await waitForRender(page, () => page.check('#dp-csv-mode-add'));
      await page.click('#dp-csv-check-btn');
      await page.waitForSelector('#dp-merge-replace');
      await page.click('#dp-merge-replace');
      await page.waitForSelector('#dialog[open]');
      const body = await text(page, '#dialog');
      t.assert.ok(body.includes(`only the ${newer.added + newer.overlap} transactions in these files`) && body.includes('965 transactions it uses now'), 'the confirmation gives both counts');
      await page.click('#dialog button[value="cancel"]');
      await page.waitForFunction(() => !document.querySelector('#dialog[open]'));
      t.assert.equal(await page.evaluate(() => window.HouseholdBudget.getDataset().transactions.length), 965, 'Cancel changes nothing');
      t.assert.ok(await page.isVisible('#dp-merge-apply'), 'the summary stays');

      await page.click('#dp-merge-replace');
      await page.waitForSelector('#dialog[open]');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dialog button[value="ok"]')]);
      await page.waitForSelector('#dp-using');
      const ds = await page.evaluate(() => window.HouseholdBudget.getDataset());
      t.assert.equal(ds.transactions.length, newer.added + newer.overlap, 'only the chosen file');
      t.assert.equal(ds.datasetId, 'household', 'the sample’s reserved name is not reused');
      t.assert.deepEqual(ds.accounts.map(a => a.id), ['joint-checking']);
      t.assert.ok((await text(page, '#view')).includes('Your data is loaded.'));
    },
  },
  {
    name: 'a balances file adds statement balances, listed in Data & privacy',
    viewport: 'both',
    async run(t) {
      const { page } = t;
      await t.open('#/data');
      const balances = 'Account,Date,Balance,Note\nJoint checking,10/15/2026,"70,123.45",October statement\njoint-savings,2026-09-30,12000.00,\nOther bank,2026-09-30,5.00,\n';
      await page.setInputFiles('#dp-pick-csv', [textFile('balances.csv', balances, 'text/csv')]);
      await page.waitForSelector('.dp-balblock');
      t.assert.equal(await page.$$eval('.dp-fileblock', els => els.length), 0, 'not taken for a bank export');
      const block = await text(page, '.dp-balblock');
      t.assert.ok(block.includes('2 balances') && block.includes('1 row will be skipped (1 unknown account)'), 'balances read, unknown account named');
      t.assert.ok(block.includes('Joint checking: $70,123.45 at the end of Oct 15, 2026'));
      // On the sample, replacing is the default, and balances alone cannot replace the data.
      await page.click('#dp-csv-check-btn');
      await page.waitForSelector('#dp-csv-error');
      t.assert.ok((await text(page, '#dp-csv-error')).includes('A balances file needs transactions to go with it'));
      await waitForRender(page, () => page.check('#dp-csv-mode-add'));
      await page.click('#dp-csv-check-btn');
      await page.waitForSelector('#dp-merge-apply');
      t.assert.equal(await text(page, '#dp-merge-line'), '0 new, 0 already present, coverage now to Sep 30, 2026, 2 balances added.');
      t.assert.equal(!!(await page.$('#dp-merge-replace')), false, 'nothing to replace the data with');
      await page.click('#dp-merge-balskipped > summary');
      t.assert.ok((await text(page, '#dp-merge-balances')).includes('balances.csv, line 4: unknown account "Other bank"'));
      await assertStructure(t, 'the balances summary');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#dp-merge-apply')]);
      await page.waitForSelector('#dp-using');
      const ds = await page.evaluate(() => window.HouseholdBudget.getDataset());
      t.assert.equal(ds.transactions.length, 965);
      // The sample brokerage account’s own statement balances come first (sorted by account).
      const brokerage = { accountId: 'joint-brokerage', source: 'statement', note: 'Sample brokerage statement (invented)' };
      t.assert.deepEqual(ds.balances.filter(b => b.source === 'statement'), [
        Object.assign({ date: '2026-03-31', cents: 1248000 }, brokerage), Object.assign({ date: '2026-06-30', cents: 1310550 }, brokerage), Object.assign({ date: '2026-09-30', cents: 1402025 }, brokerage),
        { accountId: 'joint-checking', date: '2026-10-15', cents: 7012345, source: 'statement', note: 'October statement' },
        { accountId: 'joint-savings', date: '2026-09-30', cents: 1200000, source: 'statement' },
      ]);
      const fact = await text(page, '#dp-balances-fact');
      t.assert.ok(fact.includes('Joint checking: $70,123.45 at the end of Oct 15, 2026 (statement)') && fact.includes('Joint savings: $12,000.00'), 'the latest balance per account is shown');
      await page.click('#dp-balances > summary');
      t.assert.equal(await page.$$eval('#dp-balances tbody tr', trs => trs.length), 6, 'statement balances and the export’s own');
      await assertStructure(t, 'the hub with balances');
      await t.shot('data-balances');
    },
  },
];
