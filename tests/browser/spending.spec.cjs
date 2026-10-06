'use strict';
// Spending view: drilldown, traceable totals, search, kinds, partial months, window, corrections.
//
// Determinism: a navigation changes location.hash before the hashchange render runs, and a state
// change re-renders on the next task. Never read the page right after either: `settled()` waits
// until the view's root says it was drawn for the current URL (data-route) and the current saved
// state (data-rev = state.meta.updatedAt).

const { noHorizontalScroll, cents } = require('./helpers.cjs');

const params = page => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || '')));
/** Wait until the Spending markup on screen was rendered for the current URL and saved state. */
async function settled(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('#view > .sp');
    if (!el || !location.hash.startsWith('#/spending')) return false;
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const key = [...new Set(q.keys())].sort().map(k => k + '=' + q.get(k)).join('&');
    return el.dataset.route === key && el.dataset.rev === String(window.HouseholdBudget.getState().meta.updatedAt || '');
  });
}
async function waitParams(page, expected) {
  await page.waitForFunction(exp => {
    const p = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
    return location.hash.startsWith('#/spending') && Object.entries(exp).every(([k, v]) => (v === null ? !(k in p) : p[k] === v));
  }, expected);
  await settled(page);
}
async function open(t, hash, opts) {
  await t.open(hash, opts);
  await settled(t.page);
}
/**
 * Run `fn(arg)` in the page to change the saved state. `fn` edits a copy from getState() and hands
 * it to window.__spReplace, which bumps updatedAt (so `settled` can tell the new render from the
 * old one) and calls HouseholdBudget.setState.
 */
async function setStateWith(page, fn, arg) {
  await page.evaluate(() => {
    window.__spReplace = st => {
      const prev = Date.parse(window.HouseholdBudget.getState().meta.updatedAt || '') || 0;
      st.meta.updatedAt = new Date(Math.max(Date.now(), prev + 1)).toISOString();
      window.HouseholdBudget.setState(st);
    };
  });
  const out = await page.evaluate(fn, arg === undefined ? null : arg);
  await settled(page);
  return out;
}
/** Visible text boxes inside each scope that overlap another (real layout collisions). */
async function overlappingText(page, scopeSel) {
  return page.evaluate(sel => {
    const out = [];
    for (const scope of document.querySelectorAll(sel)) {
      const boxes = [];
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (!n.textContent.trim()) continue;
        const el = n.parentElement;
        if (!el || el.closest('.sr-only, svg, option, datalist, select')) continue;
        // Skip what is not drawn: closed <details> content, display:none, visibility:hidden.
        if (!el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) continue;
        // ... and text clipped away inside a 1px box (visually hidden table headers on phones).
        let clipped = false;
        for (let a = el; a && a !== scope.parentElement; a = a.parentElement) {
          const r = a.getBoundingClientRect();
          if ((r.width <= 1 || r.height <= 1) && getComputedStyle(a).overflow !== 'visible') { clipped = true; break; }
        }
        if (clipped) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        for (const b of r.getClientRects()) if (b.width > 1 && b.height > 1) boxes.push({ b, text: n.textContent.trim().slice(0, 40) });
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].b, b = boxes[j].b;
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 2 && oy > 2) out.push(`"${boxes[i].text}" overlaps "${boxes[j].text}"`);
        }
      }
    }
    return out;
  }, scopeSel);
}
const LAYOUT_SCOPES = '#view .page-header, #view .sp-filters, #view .metric, #view .card, #view .notice, #view .sp-excluded-line, #view .breadcrumbs';

/** Counted amount of one listing row's amount cell, as the row itself states it. */
function countedOf(text) {
  if (/not counted|counts \$0\.00 here/.test(text)) return 0;
  const counted = text.match(/([−-]?\$[\d,]+\.\d{2}) counted/);
  return cents(counted ? counted[1] : text);
}

module.exports = [
  {
    name: 'spending drilldown month → category → merchant → transaction reconciles and Back walks up level by level',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending');
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
      await settled(page);
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
      await open(t, '#/spending?period=2026-09');
      const monthTotal = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      await page.click('.sp-metrics .metric:first-child .metric-sub a');
      await waitParams(page, { period: '2026-09', list: '1' });
      assert.equal(cents(await page.textContent('#sp-txns tfoot td:last-child')), monthTotal, 'all-transactions footer equals month total');
      // Category "N transactions" link → list with the same total as the category row.
      await open(t, '#/spending?period=2026-09');
      const row = page.locator('.sp-cmp tbody tr', { has: page.locator('th a:text-is("Dining & takeout")') });
      const catTotal = cents(await row.locator('.sp-c-act').textContent());
      await row.locator('th small a').click();
      await waitParams(page, { cat: 'Dining & takeout', list: '1' });
      assert.equal(cents(await page.textContent('#sp-txns tfoot td:last-child')), catTotal);
      // The All-months footer total links to one total for every month, and it is the same figure.
      await open(t, '#/spending');
      const allTotal = cents(await page.textContent('.sp-months-table tfoot td:nth-child(2)'));
      await page.click('.sp-months-table tfoot td:nth-child(2) a');
      await waitParams(page, { period: 'all' });
      assert.equal(cents(await page.textContent('.sp-metrics .metric:first-child .metric-value')), allTotal);
    },
  },
  {
    name: 'spending search by amount finds the exact transaction and offers other kinds',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=2026-07');
      await page.fill('#sp-q', '486.60');
      await page.click('#sp-search-go');
      await waitParams(page, { q: '486.60' });
      assert.match(await page.textContent('#page-title'), /486\.60/);
      const merchants = await page.$$eval('#sp-results tbody td:nth-child(2)', els => els.map(e => e.textContent));
      assert.ok(merchants.some(m => m.includes('Sample Airlines')), 'airline charge found');
      assert.equal(cents(await page.textContent('#sp-results tfoot td:last-child')), 48660);
      assert.match(await page.textContent('#sp-search-summary'), /^1 match in July 2026 · \$486\.60 counted spending\.$/);
      // Searching all months also offers the matching deposit (income).
      await page.click('a:text-is("Search all months")');
      await waitParams(page, { q: '486.60', period: 'all' });
      assert.ok((await page.textContent('.sp-tips')).includes('other kinds'));
      await page.click('a:text-is("Show every kind")');
      await waitParams(page, { q: '486.60', period: 'all', kind: 'all' });
      assert.ok((await page.textContent('#sp-sec-income')).includes('Mobile Deposit'), 'deposit listed under every kind');
      assert.equal(cents(await page.textContent('#sp-sec-spend tfoot td:last-child')), 48660);
      assert.ok(await noHorizontalScroll(page));
      await t.shot('spending-search');
    },
  },
  {
    name: 'spending kind=income lists income with totals and explains why it is not spending',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=2026-09&kind=income');
      assert.match(await page.textContent('#page-title'), /^Income/);
      const pay = await page.textContent('#sp-sec-pay');
      assert.ok(pay.includes('never counted as spending'));
      const rows = await page.$$eval('#sp-sec-pay tbody td:last-child', tds => tds.map(td => td.textContent));
      assert.ok(rows.length >= 2, 'paychecks listed');
      const footer = cents(await page.textContent('#sp-sec-pay tfoot td:last-child'));
      assert.equal(footer, rows.reduce((s, x) => s + cents(x), 0), 'income footer adds up');
      assert.equal(await page.$eval('#sp-kind', s => s.value), 'income');
      // The "Coming in" figure is the sum of the sections listed under it.
      const comingIn = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      const sections = await page.$$eval('.sp-txnlist tfoot td:last-child', tds => tds.map(td => td.textContent));
      assert.equal(sections.reduce((s, x) => s + cents(x), 0), comingIn, 'pay + other income + contributions = coming in');
      assert.ok(await noHorizontalScroll(page));
      await t.shot('spending-income');
    },
  },
  {
    name: 'spending listings say what each row counts, so the rows add up to every section total',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=2026-08&kind=all');
      assert.match(await page.textContent('.page-header .eyebrow'), /^Every kind/, 'not labelled "Not spending" when spending is included');
      const sections = await page.$$eval('.sp-txnlist', cards => cards.map(card => ({
        id: card.id,
        cells: [...card.querySelectorAll('tbody td:last-child')].map(td => td.textContent),
        footer: card.querySelector('tfoot td:last-child').textContent,
      })));
      assert.ok(sections.length >= 5, 'spending, income, saved, contributions, debt and card sections');
      for (const s of sections) {
        assert.equal(s.cells.reduce((sum, x) => sum + countedOf(x), 0), cents(s.footer), `rows of ${s.id} add up to its footer`);
      }
      // Both sides of a savings transfer and of a card payment are listed; only one side counts.
      const saved = page.locator('#sp-sec-saved tbody tr', { hasText: 'Joint savings' });
      assert.match(await saved.textContent(), /Not counted here/);
      assert.match(await saved.textContent(), /counted on the account it left/);
      const card = page.locator('#sp-sec-card tbody tr', { hasText: 'Joint rewards card' });
      assert.match(await card.textContent(), /Not counted here/);
      assert.ok(await noHorizontalScroll(page));
      await t.shot('spending-every-kind');
    },
  },
  {
    name: 'spending labels partial months and never flags them',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=2024-11');
      const notice = await page.textContent('.notice-warn');
      assert.match(notice, /November 2024 is a partial month/);
      assert.match(await page.textContent('.page-subtitle'), /^Partial month\./);
      const signals = await page.$$eval('.sp-cmp tbody .sp-c-sig .badge', bs => bs.map(b => b.textContent.trim()));
      assert.ok(signals.length > 0);
      assert.ok(signals.every(s => s === 'Partial month'), 'nothing flagged in a partial month');
      await t.shot('spending-partial');
      // All-months table marks Oct–Dec 2024 as partial.
      await open(t, '#/spending');
      const partialRows = await page.$$eval('.sp-months-table tbody tr', trs => trs.filter(tr => tr.textContent.includes('Partial')).map(tr => tr.querySelector('th').textContent.trim()));
      assert.deepEqual(partialRows.sort(), ['December 2024', 'November 2024', 'October 2024']);
      const notCompared = await page.$$eval('.sp-months-table tbody tr', trs => trs.filter(tr => tr.textContent.includes('Partial')).map(tr => tr.querySelector('td:nth-child(3)').textContent));
      assert.ok(notCompared.every(x => x.includes('Not compared')), 'partial months are not compared with usual');
    },
  },
  {
    name: 'spending window toggle changes the usable month count and keeps focus (mouse and keyboard)',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=2026-09');
      assert.match(await page.textContent('#sp-usable'), /^3 full months$/);
      await page.click('label[for^="sp-window-6"]');
      await waitParams(page, { window: '6' });
      assert.match(await page.textContent('#sp-usable'), /^6 full months$/);
      await page.click('label[for^="sp-window-12"]');
      await waitParams(page, { window: '12' });
      assert.match(await page.textContent('#sp-usable'), /^12 full months$/);
      assert.match(await page.evaluate(() => document.activeElement.id), /^sp-window-12/);
      // Keyboard: arrow keys move the radio group; the page follows and focus stays on the group.
      await page.keyboard.press('ArrowLeft');
      await waitParams(page, { window: '6' });
      assert.match(await page.evaluate(() => document.activeElement.id), /^sp-window-6/);
      assert.match(await page.textContent('#sp-usable'), /^6 full months$/);
      // Browser Back undoes the toggle.
      await page.goBack();
      await waitParams(page, { window: '12' });
      // A month with partial months in its window says which were left out.
      await open(t, '#/spending?period=2025-03&window=6');
      const line = await page.textContent('#sp-baseline');
      assert.match(line, /2 full months/);
      assert.match(line, /partial coverage/);
    },
  },
  {
    name: 'spending category page shows the plan (targets and bills) apart from usual, and seasonal comparisons name their month',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      // A category planned as a bill shows the bill, not "Not set".
      await open(t, '#/spending?period=2026-09&cat=Mortgage');
      const plan = await page.textContent('#sp-plan-tile');
      assert.match(plan, /Your plan · budget/);
      assert.match(plan, /\$1,412\.56/);
      assert.match(plan, /Mortgage bill/);
      assert.doesNotMatch(plan, /Not set/);
      // History is labelled as history, the target as the plan.
      assert.match(await page.textContent('.sp-tile-usual'), /Usual · history/);
      // A category with neither says so and how to fix it.
      await open(t, '#/spending?period=2026-09&cat=Dental');
      assert.match(await page.textContent('#sp-plan-tile'), /Not set.*Set a target in Edit plan/s);
      // A seasonal category is compared with the same month last year, and says so.
      await open(t, '#/spending?period=2026-09&cat=Gas%20%26%20heating');
      const basis = await page.textContent('#sp-cat-basis');
      assert.match(basis, /Compared with September 2025, the same month last year/);
      assert.doesNotMatch(basis, /^Usual uses/);
      assert.match(await page.textContent('.sp-tile-usual'), /Sep 2025, same month last year/);
      // The trend reaches back to that month (13 months).
      assert.equal(await page.$$eval('#sp-cat-trend .chart-table tbody tr', trs => trs.length), 13);
      assert.match(await page.textContent('#sp-cat-trend-h'), /last 13 months/);
      assert.ok(await noHorizontalScroll(page));
      await t.shot('spending-seasonal');
    },
  },
  {
    name: 'spending category correction with a reason updates the transaction and can be undone',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=2026-09&cat=Groceries');
      await page.click('.sp-merchants tbody tr:first-child th a');
      await page.waitForFunction(() => /[?&]merchant=/.test(location.hash));
      await settled(page);
      await page.click('#sp-txns tbody tr:first-child a');
      await page.waitForFunction(() => /[?&]txn=/.test(location.hash));
      await settled(page);
      const id = (await params(page)).txn;
      // Clicking inside the form must not save or complain before submit.
      await page.click(`#sp-cat-${id}-reason`);
      t.assert.ok(await page.isHidden('#toast'), 'no toast from clicking inside the form');
      await page.selectOption(`#sp-cat-${id}-sel`, 'Household & hardware');
      await page.fill(`#sp-cat-${id}-reason`, 'Checked the receipt');
      await page.click('#sp-txn-actions button[type="submit"]');
      await page.waitForFunction(i => window.HouseholdBudget.getState().ledgerEdits[i]?.category === 'Household & hardware', id);
      await settled(page);
      assert.ok((await page.textContent('#sp-history')).includes('Checked the receipt'));
      assert.ok([`sp-cat-${id}-sel`, `sp-cat-${id}-save`].includes(await page.evaluate(() => document.activeElement.id)), 'focus stays on the category form (select or the Save button just used)');
      const edit = await page.evaluate(i => window.HouseholdBudget.getState().ledgerEdits[i], id);
      assert.equal(edit.history.length, 1, 'saved once, not twice');
      assert.ok((await page.textContent('#sp-details')).includes('Household & hardware'));
      assert.ok((await page.textContent('#sp-details')).includes('Changed by you'));
      assert.ok((await page.textContent('#sp-details')).includes('Original bank category'), 'bank category still shown after a correction');
      await t.shot('spending-corrected');
      await page.click('#toast button[data-action="undo"]');
      await page.waitForFunction(i => !window.HouseholdBudget.getState().ledgerEdits[i], id);
      await settled(page);
      assert.ok(!(await page.textContent('#sp-details')).includes('Changed by you'));
      assert.ok((await page.textContent('#sp-history')).includes('No corrections yet'));
    },
  },
  {
    name: 'spending planning-baseline exclusion keeps actuals, is explained on the month, and can be reverted',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=2026-09&cat=Groceries&merchant=Kroger');
      await page.click('#sp-txns tbody tr:first-child a');
      await page.waitForFunction(() => /[?&]txn=/.test(location.hash));
      await settled(page);
      const id = (await params(page)).txn;
      // A reason is required.
      await page.click('#sp-plan-btn');
      await page.waitForSelector('#toast:not([hidden])');
      assert.match(await page.textContent('#toast'), /reason/i);
      assert.equal(await page.evaluate(i => window.HouseholdBudget.getState().ledgerEdits[i], id), undefined);
      await page.fill('#sp-plan-reason', 'One-off party shopping');
      await page.click('#sp-plan-btn');
      await page.waitForFunction(i => window.HouseholdBudget.getState().ledgerEdits[i]?.planningBaseline === 'exclude', id);
      await settled(page);
      assert.ok((await page.textContent('#sp-details')).includes('Left out of planning baselines'));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'sp-plan-btn', 'focus stays on the button just used');
      // The month still counts it (actuals unchanged) and says so.
      await open(t, '#/spending?period=2026-09', { clear: false });
      assert.ok((await page.textContent('#view .notice-info')).includes('Planning baseline'));
      assert.equal(cents(await page.textContent('.sp-metrics .metric:first-child .metric-value')), 392708, 'actual spending unchanged');
      // Revert from the transaction page; focus lands on the category control.
      await open(t, '#/spending?txn=' + id, { clear: false });
      await page.click('#sp-revert');
      await page.waitForFunction(i => !window.HouseholdBudget.getState().ledgerEdits[i]?.planningBaseline, id);
      await settled(page);
      await page.waitForFunction(i => document.activeElement && document.activeElement.id === `sp-cat-${i}-sel`, id);
      const hist = await page.evaluate(i => window.HouseholdBudget.getState().ledgerEdits[i].history.length, id);
      assert.equal(hist, 2, 'history kept after revert');
    },
  },
  {
    name: 'spending split purchases count only their part in each category, and totals still reconcile',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=2026-09');
      const id = await setStateWith(page, () => {
        const H = window.HouseholdBudget, st = H.getState();
        const row = H.context().txns.find(x => x.category === 'Mixed retail' && x.date.startsWith('2026-09') && x.merchant === 'Costco');
        const spend = -row.amountCents;
        st.ledgerEdits[row.id] = H.engine.review.editRecord(null, 'splits', [{ category: 'Groceries', cents: spend - 2500 }, { category: 'Household & hardware', cents: 2500 }], 'Checked the receipt', null);
        window.__spReplace(st);
        return row.id;
      });
      assert.ok(await page.evaluate(() => window.HouseholdBudget.context().txns.some(x => x.splitApplied)));
      // Month table still reconciles.
      const monthTotal = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      assert.equal(cents(await page.textContent('.sp-cmp tfoot .sp-c-act')), monthTotal);
      // Groceries now lists Costco with only the Groceries part.
      await open(t, '#/spending?period=2026-09&cat=Groceries', { clear: false });
      const costco = page.locator('.sp-merchants tbody tr', { has: page.locator('th a:text-is("Costco")') });
      const part = cents(await costco.locator('.sp-merchant-total').textContent());
      const groceriesTotal = cents(await page.textContent('.sp-merchants tfoot td:nth-child(2)'));
      await costco.locator('th a').click();
      await waitParams(page, { cat: 'Groceries', merchant: 'Costco' });
      assert.equal(cents(await page.textContent('#sp-txns tfoot td:last-child')), part, 'merchant footer equals the category part');
      assert.ok((await page.textContent('#sp-txns')).includes('(split)'), 'split rows show the full amount underneath');
      // The list of every Groceries transaction adds up to the Groceries total.
      await open(t, '#/spending?period=2026-09&cat=Groceries&list=1', { clear: false });
      assert.equal(cents(await page.textContent('#sp-txns tfoot td:last-child')), groceriesTotal);
      // The split row no longer appears under Mixed retail.
      await open(t, '#/spending?period=2026-09&cat=Mixed%20retail&list=1', { clear: false });
      assert.equal(!!(await page.$(`#sp-txns a[href*="${id}"]`)), false, 'split row left Mixed retail');
    },
  },
  {
    name: 'spending with an account filter shows months that account has no export for as Unknown, never $0',
    async run(t) {
      const { page, assert } = t;
      // The sample card's exports start in January 2025.
      await open(t, '#/spending?acct=joint-card');
      const oct = page.locator('.sp-months-table tbody tr', { has: page.locator('th a:text-is("October 2024")') });
      assert.match(await oct.locator('td:nth-child(2)').textContent(), /^Unknown/);
      assert.match(await page.textContent('#view .notice-warn'), /Oct–Dec 2024: spending unknown for Joint rewards card/);
      assert.match(await page.textContent('.sp-months-table tfoot td:nth-child(2)'), /3 months unknown/);
      await open(t, '#/spending?acct=joint-card&period=2024-10');
      assert.equal(await page.textContent('.sp-metrics .metric:first-child .metric-value'), 'Unknown');
      assert.equal(!!(await page.$('.sp-cmp')), false, 'no category table of zeros');
      await open(t, '#/spending?acct=joint-card&period=2024-10&cat=Groceries');
      assert.equal(!!(await page.$('#sp-cat-compare')), false, 'no $0 "typical" comparison for an unknown month');
      assert.match(await page.textContent('.sp-notes'), /Oct 2024: spending unknown for Joint rewards card/);
      // A range averages over the months with data only, and says so.
      await open(t, '#/spending?acct=joint-card&period=2024-10..2025-03');
      const total = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      const perMonth = cents(await page.textContent('.sp-metrics .metric:nth-child(2) .metric-value'));
      assert.equal(perMonth, Math.round(total / 3), 'per month = total ÷ 3 months with data, not ÷ 6');
      assert.match(await page.textContent('.sp-metrics .metric:nth-child(2)'), /Average of 3 complete months/);
      // Without the filter the same month is a partial month with its known amount.
      await open(t, '#/spending?period=2024-10');
      assert.notEqual(await page.textContent('.sp-metrics .metric:first-child .metric-value'), 'Unknown');
      // The sample has no personal accounts: personal spending is unknown, and so is its usual.
      await open(t, '#/spending?scope=personal&period=2026-09');
      assert.equal(await page.textContent('.sp-metrics .metric:first-child .metric-value'), 'Unknown');
      assert.equal(await page.textContent('.sp-metrics .metric:nth-child(2) .metric-value'), 'Not known');
      assert.match(await page.textContent('.sp-notes'), /No personal accounts in the loaded data/);
    },
  },
  {
    name: 'spending explains links it cannot read and still shows something useful',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=2026-13&kind=nonsense&txn=');
      assert.equal(await page.textContent('#page-title'), 'Spending by month');
      const notes = await page.textContent('.sp-notes');
      assert.match(notes, /was not understood/);
      assert.match(notes, /nonsense/);
      await open(t, '#/spending?txn=tx-does-not-exist');
      assert.equal(await page.textContent('#page-title'), 'Transaction not found');
    },
  },
  {
    name: 'spending shows user-entered text as text, never as markup',
    async run(t) {
      const { page, assert } = t;
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
      const evil = '<img src=x onerror=alert(1)>';
      await open(t, '#/spending?period=2026-09');
      const id = await setStateWith(page, bad => {
        const H = window.HouseholdBudget, st = H.getState();
        const row = H.context().txns.find(x => x.kind === 'spend' && x.date.startsWith('2026-09') && x.merchant === 'Kroger');
        let e = H.engine.review.editRecord(null, 'category', bad, bad + ' reason', null);
        e = H.engine.review.editRecord(e, 'note', bad + ' note', 'note ' + bad, null);
        st.ledgerEdits[row.id] = e;
        st.plan.targets[bad] = 1000;
        window.__spReplace(st);
        return row.id;
      }, evil);
      const check = async where => {
        assert.equal(await page.$$eval('#view img', imgs => imgs.length), 0, 'no injected image on ' + where);
        assert.ok((await page.textContent('#view')).includes(evil), 'the text is shown literally on ' + where);
      };
      await check('the month');
      await page.click(`.sp-cmp tbody th > a:text-is("${evil}")`);
      await waitParams(page, { cat: evil });
      assert.equal(await page.textContent('#page-title'), evil);
      await check('the category');
      await open(t, '#/spending?period=2026-09&q=' + encodeURIComponent(evil), { clear: false });
      await check('search');
      await open(t, '#/spending?txn=' + id, { clear: false });
      await check('the transaction');
      assert.ok((await page.textContent('#sp-history')).includes(evil + ' reason'));
      await open(t, '#/spending?period=2026-09&cat=' + encodeURIComponent(evil) + '&merchant=' + encodeURIComponent(evil), { clear: false });
      await check('an unknown merchant');
      assert.deepEqual(dialogs, [], 'no script ran');
    },
  },
  {
    name: 'spending filters, excluded rows and what-if switches are reflected in the URL and totals',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=2026-07');
      const before = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      await page.check('#sp-wi-reimb');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.whatIf.excludePendingReimbursements === true);
      await settled(page);
      assert.match(await page.textContent('.sp-notes'), /What-if is on/);
      const after = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      assert.equal(before - after, 48660, 'what-if leaves out the pending airline charge');
      assert.ok((await page.textContent('#sp-whatif-h')).includes('history only'));
      assert.match(await page.textContent('.sp-whatif'), /Your data and saved corrections never change/);
      // Not-counted toggle shows the left-out row struck through.
      await page.click('#sp-show-excluded');
      await waitParams(page, { show: 'excluded' });
      assert.ok((await page.textContent('#sp-not-counted')).includes('Sample Airlines'));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'sp-show-excluded');
      assert.equal(await page.$$eval('#sp-not-counted tbody tr.is-excluded', trs => trs.length), 1, 'shown struck through');
      await page.uncheck('#sp-wi-reimb');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.whatIf.excludePendingReimbursements === false);
      await settled(page);
      assert.equal(cents(await page.textContent('.sp-metrics .metric:first-child .metric-value')), before, 'switching back restores the total');
      // Account filter (a person choosing from the select focuses it first; selectOption does not).
      await page.focus('#sp-acct');
      await page.selectOption('#sp-acct', 'joint-checking');
      await waitParams(page, { acct: 'joint-checking' });
      const checkingOnly = cents(await page.textContent('.sp-metrics .metric:first-child .metric-value'));
      assert.ok(checkingOnly < before, 'account filter narrows the total');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'sp-acct', 'focus stays on the filter');
      await page.click('#sp-clear');
      await waitParams(page, { period: '2026-07', acct: null, show: null });
      assert.equal(cents(await page.textContent('.sp-metrics .metric:first-child .metric-value')), before);
      // Bank categories
      await page.click('label[for^="sp-basis-bank"]');
      await waitParams(page, { basis: 'bank' });
      assert.ok((await page.textContent('.sp-cmp')).includes('No bank category'));
      assert.equal(cents(await page.textContent('.sp-cmp tfoot .sp-c-act')), before, 'bank categories regroup the same total');
      // Range with reconcile link
      await page.selectOption('#sp-period', { label: 'Last 3 months' });
      await waitParams(page, { period: '2026-07..2026-09' });
      assert.match(await page.getAttribute('#sp-reconcile', 'href'), /^#\/review\?queue=reconcile&start=2026-07-01&end=2026-09-30$/);
      assert.match(await page.textContent('#sp-range-cats'), /Per month/);
      await t.shot('spending-range');
      // Back walks the filter changes in reverse.
      await page.goBack();
      await waitParams(page, { period: '2026-07', basis: 'bank' });
    },
  },
  {
    name: 'spending not-counted toggle on search results keeps focus both ways',
    async run(t) {
      const { page, assert } = t;
      await open(t, '#/spending?period=all&q=486.60&kind=all');
      await setStateWith(page, () => {
        const H = window.HouseholdBudget, st = H.getState();
        st.ledgerEdits['tx-1pldxbxvxt'] = H.engine.review.editRecord(null, 'reimbursement', 'confirmed', 'Paid back by the airline', null);
        window.__spReplace(st);
      });
      assert.match(await page.textContent('.sp-tips'), /not counted/);
      await page.click('#sp-show-excluded');
      await waitParams(page, { show: 'excluded' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'sp-show-excluded');
      assert.match(await page.textContent('#sp-show-excluded'), /Hide them/);
      assert.ok((await page.$$eval('#view tr.is-excluded', trs => trs.length)) >= 1, 'not-counted rows struck through');
      await page.click('#sp-show-excluded');
      await waitParams(page, { show: null });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'sp-show-excluded');
      assert.match(await page.textContent('#sp-show-excluded'), /Show them/);
    },
  },
  {
    name: 'spending wraps long unbroken names instead of widening the page on a phone',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      await page.setViewportSize({ width: 360, height: 800 });
      await open(t, '#/spending?period=2026-09');
      const long = 'Renovation' + 'X'.repeat(70); // the longest category name a correction allows
      const id = await setStateWith(page, name => {
        const H = window.HouseholdBudget, st = H.getState();
        const row = H.context().txns.find(x => x.kind === 'spend' && x.date.startsWith('2026-09') && x.merchant === 'Kroger');
        st.ledgerEdits[row.id] = H.engine.review.editRecord(null, 'category', name, 'Because ' + 'Y'.repeat(150), null);
        window.__spReplace(st);
        return row.id;
      }, long);
      for (const h of ['#/spending?period=2026-09', `#/spending?period=2026-09&cat=${long}`, `#/spending?period=2026-09&cat=${long}&merchant=Kroger`, '#/spending?txn=' + id, '#/spending?period=2026-07..2026-09']) {
        await open(t, h, { clear: false });
        assert.ok(await noHorizontalScroll(page), 'no horizontal page scroll on ' + h.slice(0, 50));
      }
    },
  },
  {
    name: 'spending phone layout keeps every level readable without page scroll or overlapping text',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      const levels = [
        '#/spending', '#/spending?period=2026-09', '#/spending?period=2024-11', '#/spending?period=2026-09&cat=Gas%20%26%20heating',
        '#/spending?period=2026-01..2026-09', '#/spending?kind=all&period=2026-08', '#/spending?period=2026-09&cat=Groceries&merchant=Kroger',
        '#/spending?period=all&q=486.60&kind=all', '#/spending?txn=tx-1pldxbxvxt',
      ];
      for (const width of [390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        for (const h of levels) {
          await open(t, h);
          assert.ok(await noHorizontalScroll(page), `no horizontal page scroll on ${h} at ${width}px`);
          assert.deepEqual(await overlappingText(page, LAYOUT_SCOPES), [], `no overlapping text on ${h} at ${width}px`);
          // Each legend key stays on the line of its label.
          const split = await page.$$eval('.sp-legend-item', items => items.filter(it => {
            const k = it.querySelector('.key').getBoundingClientRect();
            const r = it.getBoundingClientRect();
            return k.top < r.top - 1 || k.bottom > r.bottom + 1;
          }).length);
          assert.equal(split, 0, 'legend keys stay with their labels on ' + h);
          // Charts fit their card: every month and the table link are in view.
          const charts = await page.$$eval('#view .chart', figs => figs.map(f => {
            const svg = f.querySelector('svg').getBoundingClientRect(), card = f.closest('.card').getBoundingClientRect();
            return svg.left >= card.left - 1 && svg.right <= card.right + 1;
          }));
          assert.ok(charts.every(Boolean), 'charts fit inside their card on ' + h);
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await open(t, '#/spending?period=2026-09');
      // Rows are stacked: amount and category on one line, inside the viewport.
      const box = await page.$eval('.sp-cmp tbody tr:first-child .sp-c-act', el => { const r = el.getBoundingClientRect(); return { right: r.right, vw: window.innerWidth }; });
      assert.ok(box.right <= box.vw, 'amount visible without scrolling the table');
      await page.click('.sp-cmp tbody tr:first-child .sp-why summary');
      await t.shot('spending-month-why');
      await open(t, '#/spending');
      await t.shot('spending-months-phone');
      await open(t, '#/spending?period=2026-09&cat=Gas%20%26%20heating');
      await t.shot('spending-seasonal');
      await open(t, '#/spending?period=2026-01..2026-09');
      await t.shot('spending-range');
      // On the transaction page the correction tools are far below the header: a button jumps there.
      await open(t, '#/spending?txn=tx-1pldxbxvxt');
      await page.click('#sp-jump-actions');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'sp-txn-actions-h');
      // Measured once scrolling has stopped (same position for three frames), against the top bar's
      // real height; 2px allows for whole-pixel scrolling of a fractional layout (fonts differ by platform).
      await page.evaluate(() => new Promise(resolve => {
        let last = scrollY, same = 0;
        const tick = () => { if (scrollY === last) same += 1; else { same = 0; last = scrollY; } if (same >= 3) resolve(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      }));
      const inView = await page.$eval('#sp-txn-actions-h', h => {
        const r = h.getBoundingClientRect(), bar = document.querySelector('.topbar').getBoundingClientRect();
        return r.top >= bar.bottom - 2 && r.bottom <= window.innerHeight + 2;
      });
      assert.ok(inView, 'the correction tools are scrolled into view, below the sticky top bar');
      assert.equal(await page.evaluate(() => location.hash), '#/spending?txn=tx-1pldxbxvxt', 'the jump does not change the route');
      await open(t, '#/spending?period=2026-09&cat=Groceries&merchant=Kroger');
      const amt = await page.$eval('#sp-txns tbody tr:first-child td:last-child', el => { const r = el.getBoundingClientRect(); return { right: r.right, vw: window.innerWidth }; });
      assert.ok(amt.right <= amt.vw, 'transaction amount visible on a phone');
      await t.shot('spending-merchant-stacked');
    },
  },
];
