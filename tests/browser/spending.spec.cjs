'use strict';
// Spending view: drilldown, traceable totals, search, kinds, partial months, window, corrections.

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
}
const hash = page => page.evaluate(() => location.hash);
const params = page => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || '')));
/** Money text like "$1,234.56" or "−$12.00" → integer cents. */
function cents(text) {
  const m = String(text).match(/([−-])?\$([\d,]+\.\d{2})/);
  if (!m) throw new Error('No amount in: ' + text);
  const v = Math.round(Number(m[2].replace(/,/g, '')) * 100);
  return m[1] ? -v : v;
}
async function waitParams(page, expected) {
  await page.waitForFunction(exp => {
    const p = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
    return location.hash.startsWith('#/spending') && Object.entries(exp).every(([k, v]) => (v === null ? !(k in p) : p[k] === v));
  }, expected);
  await page.waitForSelector('#page-title');
}

module.exports = [
  {
    name: 'spending drilldown month → category → merchant → transaction reconciles and Back walks up level by level',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending');
      assert.equal(await page.textContent('#page-title'), 'Spending by month');
      assert.ok(await noHorizontalScroll(page), 'no horizontal scroll on All months');
      await t.shot('spending-months');

      // All months → September 2026
      await page.click('.sp-months-table a[href="#/spending?period=2026-09"]');
      await waitParams(page, { period: '2026-09' });
      assert.equal(await page.textContent('#page-title'), 'September 2026 spending');
      const crumbs = await page.$$eval('.breadcrumbs li', lis => lis.map(li => li.textContent.trim()));
      assert.deepEqual(crumbs, ['All months', 'Sep 2026']);
      // Footer total of the category table reconciles with the month total.
      const monthTotal = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      const footTotal = cents(await page.textContent('.sp-cmp tfoot .sp-c-act'));
      assert.equal(footTotal, monthTotal, 'category footer equals month total');
      const catSum = (await page.$$eval('.sp-cmp tbody .sp-c-act', tds => tds.map(td => td.textContent))).reduce((s, x) => s + cents(x), 0);
      assert.equal(catSum, monthTotal, 'category rows add up to the month total');
      assert.ok(await noHorizontalScroll(page), 'no horizontal scroll on month');
      await t.shot('spending-month');

      // Month → Groceries
      await page.click('.sp-cmp tbody th a:text-is("Groceries")');
      await waitParams(page, { period: '2026-09', cat: 'Groceries' });
      assert.equal(await page.textContent('#page-title'), 'Groceries');
      const merchantRow = page.locator('.sp-merchants tbody tr').first();
      const merchantName = (await merchantRow.locator('th a').textContent()).trim();
      const merchantOnCategory = cents(await merchantRow.locator('.sp-merchant-total').textContent());
      assert.ok(await noHorizontalScroll(page), 'no horizontal scroll on category');
      await t.shot('spending-category');

      // Category → merchant
      await merchantRow.locator('th a').click();
      await waitParams(page, { period: '2026-09', cat: 'Groceries', merchant: merchantName });
      assert.equal(await page.textContent('#page-title'), merchantName);
      const footer = cents(await page.textContent('#sp-txns tfoot td:last-child'));
      assert.equal(footer, merchantOnCategory, 'merchant footer total equals the amount on the category page');
      const rowSum = (await page.$$eval('#sp-txns tbody td:last-child', tds => tds.map(td => td.textContent))).reduce((s, x) => s + cents(x), 0);
      assert.equal(rowSum, footer, 'rows add up to the footer');
      assert.deepEqual(await page.$$eval('.breadcrumbs li', lis => lis.map(li => li.textContent.trim())), ['All months', 'Sep 2026', 'Groceries', merchantName]);
      await t.shot('spending-merchant');

      // Merchant → transaction
      await page.click('#sp-txns tbody tr:first-child a');
      await page.waitForFunction(() => /[?&]txn=/.test(location.hash));
      await page.waitForSelector('#sp-details');
      const facts = await page.textContent('#sp-details');
      assert.ok(facts.includes('Original bank category'), 'bank category always shown');
      assert.ok(facts.includes('Groceries'), 'category shown');
      const tcrumbs = await page.$$eval('.breadcrumbs li', lis => lis.map(li => li.textContent.trim()));
      assert.deepEqual(tcrumbs.slice(0, 4), ['All months', 'Sep 2026', 'Groceries', merchantName], 'full path kept');
      assert.ok(await noHorizontalScroll(page), 'no horizontal scroll on transaction');
      await t.shot('spending-transaction');

      // Back, level by level
      await page.goBack();
      await waitParams(page, { merchant: merchantName, txn: null });
      assert.equal(await page.textContent('#page-title'), merchantName);
      await page.goBack();
      await waitParams(page, { cat: 'Groceries', merchant: null });
      assert.equal(await page.textContent('#page-title'), 'Groceries');
      await page.goBack();
      await waitParams(page, { period: '2026-09', cat: null });
      assert.equal(await page.textContent('#page-title'), 'September 2026 spending');
      await page.goBack();
      await waitParams(page, { period: null });
      assert.equal(await page.textContent('#page-title'), 'Spending by month');
    },
  },
  {
    name: 'spending totals link to exactly the rows behind them',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending?period=2026-09');
      const monthTotal = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      await page.click('.sp-metrics .metric:first-child .metric-sub a');
      await waitParams(page, { period: '2026-09', list: '1' });
      assert.equal(cents(await page.textContent('#sp-txns tfoot td:last-child')), monthTotal, 'all-transactions footer equals month total');
      // Category "N transactions" link → list with the same total as the category row.
      await t.open('#/spending?period=2026-09');
      const row = page.locator('.sp-cmp tbody tr', { has: page.locator('th a:text-is("Dining & takeout")') });
      const catTotal = cents(await row.locator('.sp-c-act').textContent());
      await row.locator('th small a').click();
      await waitParams(page, { cat: 'Dining & takeout', list: '1' });
      assert.equal(cents(await page.textContent('#sp-txns tfoot td:last-child')), catTotal);
    },
  },
  {
    name: 'spending search by amount finds the exact transaction and offers other kinds',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending?period=2026-07');
      await page.fill('#sp-q', '486.60');
      await page.click('#sp-search-go');
      await waitParams(page, { q: '486.60' });
      assert.match(await page.textContent('#page-title'), /486\.60/);
      const merchants = await page.$$eval('#sp-results tbody th, #sp-results tbody td:nth-child(2)', els => els.map(e => e.textContent));
      assert.ok(merchants.some(m => m.includes('Sample Airlines')), 'airline charge found');
      assert.equal(cents(await page.textContent('#sp-results tfoot td:last-child')), 48660);
      // Searching all months also offers the matching deposit (income).
      await page.click('a:text-is("Search all months")');
      await waitParams(page, { q: '486.60', period: 'all' });
      assert.ok((await page.textContent('.sp-tips')).includes('other kinds'));
      await page.click('a:text-is("Show every kind")');
      await waitParams(page, { q: '486.60', kind: 'all' });
      const body = await page.textContent('#view');
      assert.ok(body.includes('Mobile Deposit'), 'deposit listed under every kind');
      assert.ok(await noHorizontalScroll(page));
      await t.shot('spending-search');
    },
  },
  {
    name: 'spending kind=income lists income with totals and explains why it is not spending',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending?period=2026-09&kind=income');
      assert.match(await page.textContent('#page-title'), /^Income/);
      const pay = await page.textContent('#sp-sec-pay');
      assert.ok(pay.includes('never counted as spending'));
      const rows = await page.$$eval('#sp-sec-pay tbody td:last-child', tds => tds.map(td => td.textContent));
      assert.ok(rows.length >= 2, 'paychecks listed');
      const footer = cents(await page.textContent('#sp-sec-pay tfoot td:last-child'));
      assert.equal(footer, rows.reduce((s, x) => s + cents(x), 0), 'income footer adds up');
      assert.equal(await page.$eval('#sp-kind', s => s.value), 'income');
      assert.ok(await noHorizontalScroll(page));
      await t.shot('spending-income');
    },
  },
  {
    name: 'spending reconciles with every Overview figure it is linked from',
    async run(t) {
      const { page, assert } = t;
      const whole = c => Math.round(c / 100);
      for (const [row, metric] of [[1, 'Coming in'], [2, null], [3, 'Debt payments'], [4, 'Saved (net)']]) {
        await t.open('#/overview');
        const link = page.locator(`.flow-row:nth-child(${row + 1}) [role="cell"]:last-child a`);
        const shown = cents((await link.textContent()).replace(/(\$[\d,]+)$/, '$1.00'));
        await link.click();
        await page.waitForFunction(() => location.hash.startsWith('#/spending'));
        await page.waitForSelector('.sp-metrics');
        const tile = metric ? page.locator('.sp-metrics .metric', { has: page.locator(`.metric-label:text-is("${metric}")`) }) : page.locator('.sp-metrics .metric').first();
        const value = cents(await tile.locator('.metric-value').textContent());
        assert.equal(whole(value), whole(shown), `Overview row ${row} (${metric || 'Spending'}) matches the Spending page`);
      }
    },
  },
  {
    name: 'spending labels partial months and never flags them',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending?period=2024-11');
      const notice = await page.textContent('.notice-warn');
      assert.match(notice, /November 2024 is a partial month/);
      const signals = await page.$$eval('.sp-cmp tbody .sp-c-sig .badge', bs => bs.map(b => b.textContent.trim()));
      assert.ok(signals.length > 0);
      assert.ok(signals.every(s => s === 'Partial month'), 'nothing flagged in a partial month');
      await t.shot('spending-partial');
      // All-months table marks Oct–Dec 2024 as partial.
      await t.open('#/spending');
      const partialRows = await page.$$eval('.sp-months-table tbody tr', trs => trs.filter(tr => tr.textContent.includes('Partial')).map(tr => tr.querySelector('th').textContent.trim()));
      assert.deepEqual(partialRows.sort(), ['December 2024', 'November 2024', 'October 2024']);
    },
  },
  {
    name: 'spending window toggle changes the usable month count and keeps focus',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending?period=2026-09');
      assert.match(await page.textContent('#sp-usable'), /^3 full months$/);
      await page.click('label[for^="sp-window-6"]');
      await waitParams(page, { window: '6' });
      assert.match(await page.textContent('#sp-usable'), /^6 full months$/);
      await page.click('label[for^="sp-window-12"]');
      await waitParams(page, { window: '12' });
      assert.match(await page.textContent('#sp-usable'), /^12 full months$/);
      assert.match(await page.evaluate(() => document.activeElement.id), /^sp-window-12/);
      // A month with partial months in its window says which were left out.
      await t.open('#/spending?period=2025-03&window=6');
      const line = await page.textContent('#sp-baseline');
      assert.match(line, /2 full months/);
      assert.match(line, /partial coverage/);
    },
  },
  {
    name: 'spending category correction with a reason updates the transaction and can be undone',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending?period=2026-09&cat=Groceries');
      await page.click('.sp-merchants tbody tr:first-child th a');
      await page.waitForSelector('#sp-txns');
      await page.click('#sp-txns tbody tr:first-child a');
      await page.waitForSelector('#sp-details');
      const id = (await params(page)).txn;
      // Clicking inside the form must not save or complain before submit.
      await page.click(`#sp-cat-${id}-reason`);
      t.assert.ok(await page.isHidden('#toast'), 'no toast from clicking inside the form');
      await page.selectOption(`#sp-cat-${id}-sel`, 'Household & hardware');
      await page.fill(`#sp-cat-${id}-reason`, 'Checked the receipt');
      await page.click('#sp-txn-actions button[type="submit"]');
      await page.waitForFunction(i => window.HouseholdBudget.getState().ledgerEdits[i]?.category === 'Household & hardware', id);
      await page.waitForFunction(() => document.querySelector('#sp-history')?.textContent.includes('Checked the receipt'));
      assert.equal(await page.evaluate(() => document.activeElement.id), `sp-cat-${id}-sel`, 'focus stays on the category control');
      const edit = await page.evaluate(i => window.HouseholdBudget.getState().ledgerEdits[i], id);
      assert.equal(edit.history.length, 1, 'saved once, not twice');
      assert.ok((await page.textContent('#sp-details')).includes('Household & hardware'));
      assert.ok((await page.textContent('#sp-details')).includes('Changed by you'));
      await t.shot('spending-corrected');
      await page.click('#toast button[data-action="undo"]');
      await page.waitForFunction(i => !window.HouseholdBudget.getState().ledgerEdits[i], id);
      await page.waitForFunction(() => !document.querySelector('#sp-details').textContent.includes('Changed by you'));
      assert.ok((await page.textContent('#sp-history')).includes('No corrections yet'));
    },
  },
  {
    name: 'spending planning-baseline exclusion keeps actuals, is explained on the month, and can be reverted',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending?period=2026-09&cat=Groceries&merchant=Kroger');
      await page.click('#sp-txns tbody tr:first-child a');
      await page.waitForSelector('#sp-details');
      const id = (await params(page)).txn;
      // A reason is required.
      await page.click('#sp-plan-btn');
      await page.waitForSelector('#toast:not([hidden])');
      assert.match(await page.textContent('#toast'), /reason/i);
      assert.equal(await page.evaluate(i => window.HouseholdBudget.getState().ledgerEdits[i], id), undefined);
      await page.fill('#sp-plan-reason', 'One-off party shopping');
      await page.click('#sp-plan-btn');
      await page.waitForFunction(i => window.HouseholdBudget.getState().ledgerEdits[i]?.planningBaseline === 'exclude', id);
      await page.waitForFunction(() => document.querySelector('#sp-details').textContent.includes('Left out of planning baselines'));
      // The month still counts it (actuals unchanged) and says so.
      await t.open('#/spending?period=2026-09', { clear: false });
      assert.ok((await page.textContent('#view')).includes('Planning baseline'));
      assert.equal(cents(await page.textContent('.sp-metrics .metric:first-child .metric-value')), 392708, 'actual spending unchanged');
      // Revert from the transaction page; focus lands on the category control.
      await t.open('#/spending?txn=' + id, { clear: false });
      await page.click('#sp-revert');
      await page.waitForFunction(i => !window.HouseholdBudget.getState().ledgerEdits[i]?.planningBaseline, id);
      await page.waitForFunction(i => document.activeElement && document.activeElement.id === `sp-cat-${i}-sel`, id);
      const hist = await page.evaluate(i => window.HouseholdBudget.getState().ledgerEdits[i].history.length, id);
      assert.equal(hist, 2, 'history kept after revert');
    },
  },
  {
    name: 'spending split purchases count only their part in each category, and totals still reconcile',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending?period=2026-09');
      const id = await page.evaluate(() => {
        const H = window.HouseholdBudget;
        const row = H.context().txns.find(x => x.category === 'Mixed retail' && x.date.startsWith('2026-09') && x.merchant === 'Costco');
        const spend = -row.amountCents;
        const st = H.getState();
        st.ledgerEdits[row.id] = H.engine.review.editRecord(null, 'splits', [{ category: 'Groceries', cents: spend - 2500 }, { category: 'Household & hardware', cents: 2500 }], 'Checked the receipt', null);
        H.setState(st);
        return row.id;
      });
      await page.waitForFunction(() => window.HouseholdBudget.context().txns.some(x => x.splitApplied));
      // Month table still reconciles.
      const monthTotal = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      assert.equal(cents(await page.textContent('.sp-cmp tfoot .sp-c-act')), monthTotal);
      // Groceries now lists Costco with only the Groceries part.
      await t.open('#/spending?period=2026-09&cat=Groceries', { clear: false });
      const costco = page.locator('.sp-merchants tbody tr', { has: page.locator('th a:text-is("Costco")') });
      const part = cents(await costco.locator('.sp-merchant-total').textContent());
      const groceriesTotal = cents(await page.textContent('.sp-merchants tfoot td:nth-child(2)'));
      await costco.locator('th a').click();
      await waitParams(page, { cat: 'Groceries', merchant: 'Costco' });
      assert.equal(cents(await page.textContent('#sp-txns tfoot td:last-child')), part, 'merchant footer equals the category part');
      assert.ok((await page.textContent('#sp-txns')).includes('(split)'), 'split rows show the full amount underneath');
      // The list of every Groceries transaction adds up to the Groceries total.
      await t.open('#/spending?period=2026-09&cat=Groceries&list=1', { clear: false });
      assert.equal(cents(await page.textContent('#sp-txns tfoot td:last-child')), groceriesTotal);
      // The split row no longer appears under Mixed retail.
      await t.open('#/spending?period=2026-09&cat=Mixed%20retail&list=1', { clear: false });
      assert.equal(await page.$(`#sp-txns a[href*="${id}"]`), null, 'split row left Mixed retail');
    },
  },
  {
    name: 'spending explains links it cannot read and still shows something useful',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending?period=2026-13&kind=nonsense&txn=');
      assert.equal(await page.textContent('#page-title'), 'Spending by month');
      const notes = await page.textContent('.sp-notes');
      assert.match(notes, /was not understood/);
      assert.match(notes, /nonsense/);
      await t.open('#/spending?txn=tx-does-not-exist');
      assert.equal(await page.textContent('#page-title'), 'Transaction not found');
    },
  },
  {
    name: 'spending filters, excluded rows and what-if switches are reflected in the URL and totals',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/spending?period=2026-07');
      const before = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      await page.check('#sp-wi-reimb');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.whatIf.excludePendingReimbursements === true);
      await page.waitForSelector('.notice-warn');
      const after = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      assert.equal(before - after, 48660, 'what-if leaves out the pending airline charge');
      assert.ok((await page.textContent('#sp-whatif-h')).includes('history only'));
      // Not-counted toggle shows the left-out row struck through.
      await page.click('#sp-show-excluded');
      await waitParams(page, { show: 'excluded' });
      assert.ok((await page.textContent('#sp-not-counted')).includes('Sample Airlines'));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'sp-show-excluded');
      await page.uncheck('#sp-wi-reimb');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.whatIf.excludePendingReimbursements === false);
      // Account filter
      await page.selectOption('#sp-acct', 'joint-checking');
      await waitParams(page, { acct: 'joint-checking' });
      const checkingOnly = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      assert.ok(checkingOnly < before, 'account filter narrows the total');
      await page.click('#sp-clear');
      await waitParams(page, { period: '2026-07', acct: null, show: null });
      // Bank categories
      await page.click('label[for^="sp-basis-bank"]');
      await waitParams(page, { basis: 'bank' });
      assert.ok((await page.textContent('.sp-cmp')).includes('No bank category'));
      // Range with reconcile link
      await page.selectOption('#sp-period', { label: 'Last 3 months' });
      await waitParams(page, { period: '2026-07..2026-09' });
      assert.match(await page.getAttribute('#sp-reconcile', 'href'), /^#\/review\?queue=reconcile&start=2026-07-01&end=2026-09-30$/);
      await t.shot('spending-range');
    },
  },
  {
    name: 'spending phone layout keeps the comparison readable without page scroll',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      for (const h of ['#/spending?period=2026-09', '#/spending?period=2026-09&cat=Gas%20%26%20heating', '#/spending?period=2026-01..2026-09', '#/spending?kind=all&period=2026-08']) {
        await t.open(h);
        assert.ok(await noHorizontalScroll(page), 'no horizontal page scroll on ' + h);
      }
      await t.open('#/spending?period=2026-09');
      // Rows are stacked: amount and category on one line, inside the viewport.
      const box = await page.$eval('.sp-cmp tbody tr:first-child .sp-c-act', el => { const r = el.getBoundingClientRect(); return { right: r.right, vw: window.innerWidth }; });
      assert.ok(box.right <= box.vw, 'amount visible without scrolling the table');
      await page.click('.sp-cmp tbody tr:first-child .sp-why summary');
      await t.shot('spending-month-why');
      await t.open('#/spending?period=2026-09&cat=Gas%20%26%20heating');
      await t.shot('spending-seasonal');
      await t.open('#/spending?period=2026-01..2026-09');
      await t.shot('spending-range');
      await t.open('#/spending?period=2026-09&cat=Groceries&merchant=Kroger');
      const amt = await page.$eval('#sp-txns tbody tr:first-child td:last-child', el => { const r = el.getBoundingClientRect(); return { right: r.right, vw: window.innerWidth }; });
      assert.ok(amt.right <= amt.vw, 'transaction amount visible on a phone');
      await t.shot('spending-merchant-stacked');
    },
  },
];
