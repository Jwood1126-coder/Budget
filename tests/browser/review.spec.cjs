'use strict';
// Review view: queues, corrections with reasons, undo, splits, duplicates, reimbursements,
// spikes, transfers, coverage, reconcile, phone layout and keyboard use.

const QUEUES = ['uncertain', 'mixed', 'duplicates', 'transfers', 'reimbursements', 'business', 'spikes', 'coverage', 'edited', 'reconcile'];
const TITLES = {
  uncertain: 'Uncertain categories', mixed: 'Mixed retail', duplicates: 'Possible duplicates', transfers: 'Transfers',
  reimbursements: 'Reimbursements', business: 'Business costs', spikes: 'Unusual spikes', coverage: 'Coverage',
  edited: 'Corrections log', reconcile: 'Reconcile',
};

/** No sideways page scroll. Also catches mobile emulation zooming out to fit wide content
 *  (then innerWidth grows past the device width and scrollWidth alone looks fine). */
const { noHorizontalScroll, state, money: fmtMoney, cents } = require('./helpers.cjs');
/** Ledger totals for one month, computed by the engine from the app's current effective rows. */
const monthSummary = (page, month) => page.evaluate(m => {
  const ctx = window.HouseholdBudget.context();
  return ctx.E.ledger.summarize(ctx.E.ledger.filter(ctx.txns, { months: [m] }));
}, month);
const queues = page => page.evaluate(() => {
  const q = window.HouseholdBudget.context().reviewQueues();
  const ids = list => list.map(t => t.id);
  return {
    uncertain: q.uncertain.map(t => ({ id: t.id, merchant: t.merchant, kind: t.kind, date: t.date })),
    mixed: ids(q.mixedRetail),
    duplicates: q.duplicates.map(d => ({ ids: d.ids, cents: d.cents, month: d.txns[1].date.slice(0, 7) })),
    unpaired: q.transfers.unpaired.filter(u => !u.expected).map(u => ({ id: u.id, cents: u.amountCents, month: u.date.slice(0, 7) })),
    reimb: q.reimbursements.map(r => ({ chargeId: r.chargeId, depositId: r.depositId, cents: r.cents, status: r.status, chargeMonth: r.charge && r.charge.date.slice(0, 7), depositMonth: r.deposit && r.deposit.date.slice(0, 7) })),
    spikes: q.spikes.map(s => ({ month: s.month, category: s.category, ids: s.ids, total: s.totalCents })),
    business: q.business.map(t => ({ id: t.id, status: t.status, cents: -t.amountCents, month: t.date.slice(0, 7) })),
    annual: q.annualSpikes.map(s => ({ month: s.month, category: s.category, ids: s.ids, total: s.totalCents })),
    expected: q.transfers.unpaired.filter(u => u.expected).map(u => u.id),
    paired: q.transfers.paired.map(p => p.ids),
  };
});
const focusedId = page => page.evaluate(() => document.activeElement && document.activeElement.id);
/** Arrive at a review link from another view, as a link in Spending would. */
async function arrive(t, hash) {
  await t.page.goto(t.url + '#/spending');
  await t.page.waitForFunction(() => location.hash === '#/spending');
  await t.page.goto(t.url + hash);
  await t.page.waitForSelector('.rv');
}
const HOSTILE = '<img src=x onerror="window.__xss=1">';
async function openQueue(t, queue, extra = '') {
  await t.open(`#/review?queue=${queue}${extra}`);
  await t.page.waitForSelector('.rv');
}
/** Money text like "$1,234.56" or "−$12.00" → integer cents. */
/** When the real Spending view is built in (not a developer stub), it shows this amount. */
async function spendingShows(t, hash, amountCents) {
  await t.page.goto(t.url + hash);
  await t.page.waitForSelector('#page-title');
  const main = await t.page.textContent('main');
  if (main.includes('Stubbed in this developer build')) return;
  t.assert.ok(main.includes(fmtMoney(amountCents)), `Spending (${hash}) shows ${fmtMoney(amountCents)}`);
}
async function toastUndo(page) {
  await page.waitForSelector('#toast:not([hidden]) button[data-action="undo"]');
  await page.click('#toast button[data-action="undo"]');
}

module.exports = [
  {
    name: 'every review queue renders without horizontal scroll, with tabs and breadcrumbs',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/review');
      assert.equal(await page.textContent('#page-title'), 'Data review');
      // Index: highest priority first (duplicates change totals), every queue listed once.
      const order = await page.$$eval('.rv-qrow h4 a', as => as.map(a => a.id.replace('rv-q-', '')));
      assert.equal(order[0], 'duplicates', 'duplicates first');
      assert.deepEqual([...order].sort(), [...QUEUES].sort(), 'every queue on the index');
      assert.ok(await noHorizontalScroll(page), 'index: no horizontal scroll');
      await t.shot('review-index');
      for (const q of QUEUES) {
        // On phones the tab strip scrolls sideways; the link is still reachable.
        await page.$eval(`#rv-tab-${q}`, a => a.scrollIntoView({ inline: 'center', block: 'nearest' }));
        await page.click(`#rv-tab-${q}`);
        await page.waitForFunction(x => location.hash === '#/review?queue=' + x, q);
        await page.waitForFunction(title => document.getElementById('page-title')?.textContent.trim() === title, TITLES[q]);
        assert.deepEqual(await page.$$eval('.breadcrumbs li', lis => lis.map(li => li.textContent.trim())), ['Review', TITLES[q]]);
        assert.equal(await page.$eval(`#rv-tab-${q}`, a => a.getAttribute('aria-current')), 'page');
        assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'page-title', 'heading focused after switching queue');
        assert.ok(await noHorizontalScroll(page), q + ': no horizontal scroll');
        // Headings never skip a level (h1 page title, h2 cards, h3 items, h4 within).
        const jumps = await page.$$eval('main h1, main h2, main h3, main h4, main h5, main h6', hs => {
          const out = [];
          let prev = 0;
          for (const h of hs) { const lv = Number(h.tagName[1]); if (prev && lv > prev + 1) out.push(h.tagName + ' ' + h.textContent.trim().slice(0, 40)); prev = lv; }
          return out;
        });
        assert.deepEqual(jumps, [], q + ': heading levels in order');
        await t.shot('review-' + q);
      }
      // Browser Back returns to the previous queue.
      await page.goBack();
      await page.waitForFunction(() => location.hash === '#/review?queue=edited');
    },
  },
  {
    name: 'uncertain category change needs a reason, leaves the queue, is logged with the bank category, and Undo restores it',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'uncertain');
      const zelle = (await queues(page)).uncertain.find(x => x.kind === 'spend');
      assert.ok(zelle, 'the sample has an uncertain purchase');
      const base = '#rv-cf-' + zelle.id;
      await page.selectOption(base + '-cat', 'Gifts & donations');
      // Reason left empty: an inline error, nothing saved.
      await page.click(base + '-save');
      await page.waitForSelector(base + '-reason-error:not([hidden])');
      assert.match(await page.textContent(base + '-reason-error'), /reason/i);
      assert.equal(await page.$eval(base + '-reason', el => el.getAttribute('aria-invalid')), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.id), base.slice(1) + '-reason', 'focus moves to the reason');
      assert.deepEqual((await state(page)).ledgerEdits, {}, 'nothing saved without a reason');
      await t.shot('review-uncertain-error');

      await page.fill(base + '-reason', 'Birthday gift for a friend');
      await page.click(base + '-save');
      await page.waitForFunction(id => window.HouseholdBudget.getState().ledgerEdits[id]?.category === 'Gifts & donations', zelle.id);
      await page.waitForSelector('#rv-item-' + zelle.id, { state: 'detached' });
      const edit = (await state(page)).ledgerEdits[zelle.id];
      assert.equal(edit.categoryReason, 'Birthday gift for a friend');
      assert.equal(edit.history.length, 1);
      assert.ok(!(await queues(page)).uncertain.some(x => x.id === zelle.id), 'left the uncertain queue');
      // Focus moved to the next item rather than being lost (it moves after the re-render).
      await page.waitForFunction(() => document.querySelector('.rv') && document.querySelector('.rv').contains(document.activeElement));

      // Undo puts it back.
      await toastUndo(page);
      await page.waitForSelector('#rv-item-' + zelle.id);
      assert.deepEqual((await state(page)).ledgerEdits, {}, 'undo removed the correction');

      // Save again, then read the corrections log.
      await page.selectOption(base + '-cat', 'Gifts & donations');
      await page.fill(base + '-reason', 'Birthday gift for a friend');
      await page.press(base + '-reason', 'Enter');
      await page.waitForFunction(id => !!window.HouseholdBudget.getState().ledgerEdits[id], zelle.id);
      await page.click('#rv-tab-edited');
      await page.waitForSelector('#rv-item-' + zelle.id);
      const log = await page.textContent('#rv-item-' + zelle.id);
      assert.ok(log.includes('Birthday gift for a friend'), 'reason in the log');
      assert.ok(log.includes('Gifts & donations'), 'new category in the log');
      assert.ok(log.includes('Bank category (original)'), 'original bank category shown');
      assert.ok(log.includes('Uncategorized'), 'imported category shown');
      await t.shot('review-edited-after');

      // Revert from the log keeps the history.
      await page.click('#rv-revert-' + zelle.id);
      await page.waitForFunction(id => !window.HouseholdBudget.getState().ledgerEdits[id].category, zelle.id);
      const after = (await state(page)).ledgerEdits[zelle.id];
      assert.equal(after.history.length, 2, 'revert added to the history');
      await page.waitForFunction(id => (document.getElementById('rv-item-' + id)?.textContent || '').includes('Reverted'), zelle.id);
      assert.ok((await queues(page)).uncertain.some(x => x.id === zelle.id), 'back in the uncertain queue');
    },
  },
  {
    name: 'mixed retail: a category set with a reason keeps the bank category visible in the log',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'mixed');
      const id = await page.$eval('.rv-items .rv-item', el => el.dataset.rvItem);
      await page.click(`#rv-mx-${id} > summary`);
      await page.selectOption(`#rv-cf-${id}-cat`, 'Groceries');
      await page.fill(`#rv-cf-${id}-reason`, 'Checked the receipt');
      await page.click(`#rv-cf-${id}-save`);
      await page.waitForFunction(x => window.HouseholdBudget.getState().ledgerEdits[x]?.category === 'Groceries', id);
      await page.waitForSelector('#rv-item-' + id, { state: 'detached' });
      await page.goto(t.url + '#/review?queue=edited');
      await page.waitForSelector('#rv-item-' + id);
      const text = await page.textContent('#rv-item-' + id);
      assert.ok(text.includes('Shopping'), 'bank category Shopping still shown');
      assert.ok(text.includes('Checked the receipt'));
      assert.ok(text.includes('Mixed retail'), 'from value shown');
    },
  },
  {
    name: 'split: a mismatched sum is rejected, an exact sum is saved and category totals follow the parts',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'mixed');
      const id = await page.$eval('.rv-items .rv-item', el => el.dataset.rvItem);
      const form = `#rv-sp-${id}`;
      await page.click(`#rv-mx-${id} > summary`);
      const total = Number(await page.$eval(form, f => f.dataset.total));
      const month = await page.evaluate(x => window.HouseholdBudget.context().txns.find(r => r.id === x).date.slice(0, 7), id);
      const groupBefore = await page.evaluate(m => {
        const ctx = window.HouseholdBudget.context();
        return Object.fromEntries(ctx.E.ledger.group(ctx.E.ledger.filter(ctx.txns, { months: [m] }), 'category').map(g => [g.key, g.spendCents]));
      }, month);
      const part1 = total - 2500;
      await page.selectOption(`#rv-sp-${id}-0-cat`, 'Groceries');
      await page.fill(`#rv-sp-${id}-0-amt`, (part1 / 100).toFixed(2));
      await page.selectOption(`#rv-sp-${id}-1-cat`, 'Clothing');
      await page.fill(`#rv-sp-${id}-1-amt`, '20.00'); // $5.00 short
      assert.match(await page.textContent(`${form}-sum`), /\$5\.00 left to assign/);
      await page.fill(`${form}-reason`, 'Checked the receipt');
      await page.click(`${form}-save`);
      await page.waitForSelector(`${form}-error:not([hidden])`);
      assert.match(await page.textContent(`${form}-error`), /add up/);
      assert.equal((await state(page)).ledgerEdits[id], undefined, 'mismatched split not saved');
      await t.shot('review-split-error');

      await page.fill(`#rv-sp-${id}-1-amt`, '25.00');
      assert.match(await page.textContent(`${form}-sum`), /add up exactly/);
      await page.click(`${form}-save`);
      await page.waitForFunction(x => Array.isArray(window.HouseholdBudget.getState().ledgerEdits[x]?.splits), id);
      const edit = (await state(page)).ledgerEdits[id];
      assert.deepEqual(edit.splits, [{ category: 'Groceries', cents: part1 }, { category: 'Clothing', cents: 2500 }]);
      const groupAfter = await page.evaluate(m => {
        const ctx = window.HouseholdBudget.context();
        return Object.fromEntries(ctx.E.ledger.group(ctx.E.ledger.filter(ctx.txns, { months: [m] }), 'category').map(g => [g.key, g.spendCents]));
      }, month);
      assert.equal(groupAfter.Groceries, (groupBefore.Groceries || 0) + part1, 'Groceries grew by part 1');
      assert.equal(groupAfter.Clothing, (groupBefore.Clothing || 0) + 2500, 'Clothing grew by part 2');
      assert.equal((groupAfter['Mixed retail'] || 0), (groupBefore['Mixed retail'] || 0) - total, 'Mixed retail lost the whole purchase');
      const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
      assert.equal(sum(groupAfter), sum(groupBefore), 'the month total is unchanged');

      // The Spending view (when built in) shows the new Groceries total for the month.
      await spendingShows(t, `#/spending?period=${month}&cat=Groceries`, groupAfter.Groceries);
    },
  },
  {
    name: 'duplicates: not counting the second copy lowers that month by exactly its amount; reopen restores',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'duplicates');
      const [pair] = (await queues(page)).duplicates;
      assert.ok(pair, 'the sample has a duplicate candidate');
      const before = (await monthSummary(page, pair.month)).spendingCents;
      const btn = `#rv-dup-${pair.ids[0]}-exclude`;
      const reason = `#rv-dup-${pair.ids[0]}-reason`;
      // Effect is stated before deciding.
      assert.ok((await page.textContent('.rv-effect')).includes(fmtMoney(pair.cents)));
      await page.click(btn);
      await page.waitForSelector(reason + '-error:not([hidden])');
      assert.deepEqual((await state(page)).ledgerEdits, {}, 'no reason, no change');
      await page.fill(reason, 'Same charge listed twice');
      await page.click(btn);
      await page.waitForFunction(x => window.HouseholdBudget.getState().ledgerEdits[x]?.duplicate === 'exclude', pair.ids[1]);
      const after = (await monthSummary(page, pair.month)).spendingCents;
      assert.equal(before - after, pair.cents, 'month spending dropped by exactly the duplicate amount');
      await spendingShows(t, `#/spending?period=${pair.month}`, after);
      await page.goto(t.url + '#/review?queue=duplicates');
      await page.waitForSelector('.rv');
      await page.waitForSelector('#rv-dup-done');
      await t.shot('review-duplicates-decided');
      await page.click('#rv-dup-reopen-' + pair.ids[1]);
      await page.waitForFunction(x => !window.HouseholdBudget.getState().ledgerEdits[x].duplicate, pair.ids[1]);
      assert.equal((await monthSummary(page, pair.month)).spendingCents, before, 'reopening counts it again');
      await page.waitForSelector(btn);
    },
  },
  {
    name: 'reimbursement: confirming removes both the charge and the deposit, and going back to pending restores them',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'reimbursements');
      const [r] = (await queues(page)).reimb;
      assert.ok(r && r.chargeId && r.depositId, 'the sample has a matched reimbursement');
      const sBefore = await monthSummary(page, r.chargeMonth);
      const iBefore = await monthSummary(page, r.depositMonth);
      const base = '#rv-rb-' + r.chargeId;
      await page.check(`${base}-s-confirmed`);
      await page.click(`${base}-save`);
      await page.waitForSelector(`${base}-reason-error:not([hidden])`);
      await page.fill(`${base}-reason`, 'Employer paid it back');
      await page.click(`${base}-save`);
      await page.waitForFunction(id => window.HouseholdBudget.context().txns.find(x => x.id === id).excluded === 'reimbursed', r.chargeId);
      const ex = await page.evaluate(ids => ids.map(id => window.HouseholdBudget.context().txns.find(x => x.id === id).excluded), [r.chargeId, r.depositId]);
      assert.deepEqual(ex, ['reimbursed', 'reimbursed'], 'both sides excluded');
      assert.equal(sBefore.spendingCents - (await monthSummary(page, r.chargeMonth)).spendingCents, r.cents, 'charge left spending');
      assert.equal(iBefore.incomeCents - (await monthSummary(page, r.depositMonth)).incomeCents, r.cents, 'deposit left income');
      await page.waitForSelector(`${base}-s-confirmed:checked`);
      assert.ok((await page.textContent('#rv-item-rb-' + r.chargeId)).includes('Reimbursed — not counted'));
      await t.shot('review-reimbursement-confirmed');

      await page.check(`${base}-s-pending`);
      await page.fill(`${base}-reason`, 'Not sure yet');
      await page.click(`${base}-save`);
      await page.waitForFunction(id => !window.HouseholdBudget.context().txns.find(x => x.id === id).excluded, r.chargeId);
      assert.equal((await monthSummary(page, r.chargeMonth)).spendingCents, sBefore.spendingCents);
      assert.equal((await monthSummary(page, r.depositMonth)).incomeCents, iBefore.incomeCents);
    },
  },
  {
    name: 'spike: leaving it out of the planning baseline keeps the month total but changes the usual average',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'spikes');
      const spike = (await queues(page)).spikes.find(s => s.category === 'Dental');
      assert.ok(spike, 'the sample dental episode is listed');
      const usual = () => page.evaluate(s => {
        const ctx = window.HouseholdBudget.context();
        const next = ctx.E.months.add(s.month, 1);
        const r = ctx.E.compare.usual(ctx.txns, ctx.dataset, { month: next, window: ctx.state.plan.settings.comparisonWindow || 3, category: s.category, planning: true });
        return r.categories[0].averageCents;
      }, spike);
      const totalBefore = (await monthSummary(page, spike.month)).spendingCents;
      const usualBefore = await usual();
      assert.ok(usualBefore > 0, 'the usual dental amount includes the episode');
      const key = await page.$eval('.rv-items .rv-item', el => el.dataset.rvItem);
      await page.fill(`#rv-spk-${key.slice(4)}-reason`, 'One-off, not expected again');
      await page.click(`#${key}-exclude`);
      await page.waitForFunction(ids => ids.every(id => window.HouseholdBudget.getState().ledgerEdits[id]?.planningBaseline === 'exclude'), spike.ids);
      assert.equal((await monthSummary(page, spike.month)).spendingCents, totalBefore, 'actual month total unchanged');
      await spendingShows(t, `#/spending?period=${spike.month}`, totalBefore);
      await page.goto(t.url + '#/review?queue=spikes');
      await page.waitForSelector('.rv-items');
      const usualAfter = await usual();
      assert.ok(usualAfter < usualBefore, 'usual average for planning went down');
      await page.waitForSelector(`#rv-item-${key} .rv-tile.is-current`);
      const current = await page.textContent(`#rv-item-${key} .rv-tile.is-current`);
      assert.match(current, /If left out/);
      assert.equal(cents(current), usualAfter, 'the tile shows the new usual amount');
      assert.ok((await page.textContent(`#rv-item-${key}`)).includes('Left out of planning baseline'));
      await t.shot('review-spike-excluded');
    },
  },
  {
    name: 'transfer: an unmatched deposit marked as a contribution leaves spending unchanged and is answered',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'transfers');
      const [u] = (await queues(page)).unpaired;
      assert.ok(u, 'the sample has an unmatched transfer');
      const before = await monthSummary(page, u.month);
      const base = '#rv-tr-' + u.id;
      // No answer chosen: an error on the choices.
      await page.fill(`${base}-reason`, 'Sam moved money from a personal account');
      await page.click(`${base}-save`);
      await page.waitForSelector(`${base}-choice-error:not([hidden])`);
      await page.check(`${base}-k-contribution`);
      await page.click(`${base}-save`);
      await page.waitForFunction(id => window.HouseholdBudget.getState().ledgerEdits[id]?.subtype === 'contribution', u.id);
      const edit = (await state(page)).ledgerEdits[u.id];
      assert.equal(edit.kind, 'transfer');
      assert.equal(edit.kindReason, 'Sam moved money from a personal account');
      const after = await monthSummary(page, u.month);
      assert.equal(after.spendingCents, before.spendingCents, 'spending unchanged');
      assert.equal(after.contributionsCents - before.contributionsCents, u.cents, 'counted as a contribution');
      await page.waitForSelector('#rv-item-' + u.id, { state: 'detached' });
      assert.ok((await page.textContent('#rv-tr-done')).includes('Contribution'), 'listed as answered');
      assert.ok((await page.textContent('#rv-list')).includes('Every unmatched transfer has an answer'));
      // Matched pairs are explained, not hidden.
      assert.match(await page.textContent('#rv-tr-paired'), /card payments/);
    },
  },
  {
    name: 'business: bulk decision with one reason updates the totals',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'business');
      const list = (await queues(page)).business.filter(b => b.status === 'pending');
      const ids = await page.$$eval('input[name="rv-biz-sel"]', els => els.slice(0, 2).map(e => e.value));
      for (const id of ids) await page.check('#rv-biz-' + id);
      assert.match(await page.textContent('#rv-biz-count'), /^2 selected/);
      await page.click('#rv-biz-business');
      await page.waitForSelector('#rv-biz-reason-error:not([hidden])');
      await page.fill('#rv-biz-reason', 'Bought for work');
      await page.click('#rv-biz-business');
      await page.waitForFunction(x => x.every(id => window.HouseholdBudget.getState().ledgerEdits[id]?.business === 'business'), ids);
      const q = (await queues(page)).business;
      assert.equal(q.filter(b => b.status === 'pending').length, list.length - 2);
      const bizCents = q.filter(b => b.status === 'business').reduce((a, b) => a + b.cents, 0);
      const pendingCents = q.filter(b => b.status === 'pending').reduce((a, b) => a + b.cents, 0);
      // The view re-renders after the state change: wait for the new figure, then compare exactly.
      await page.waitForFunction(() => !/^\$0\.00$/.test(document.querySelector('#rv-biz-m-business .metric-value')?.textContent || '$0.00'));
      assert.equal(cents(await page.textContent('#rv-biz-m-business .metric-value')), bizCents, 'Business total shown');
      // Each total matches the footer of the list behind it, and opens that list.
      assert.equal(cents(await page.textContent('#rv-biz-m-pending .metric-value')), pendingCents);
      assert.equal(cents(await page.textContent('.rv-biz-table tfoot .num')), pendingCents, 'pending list footer = pending total');
      await page.click('#rv-biz-m-business');
      await page.waitForFunction(() => location.hash === '#/review?queue=business&status=business');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'rv-list-h');
      assert.deepEqual((await page.$$eval('input[name="rv-biz-sel"]', els => els.map(e => e.value))).sort(), [...ids].sort());
      assert.equal(cents(await page.textContent('.rv-biz-table tfoot .num')), bizCents, 'business list footer = business total');
      await page.goBack();
      await page.waitForFunction(() => location.hash === '#/review?queue=business');
    },
  },
  {
    name: 'coverage lists the partial months Oct–Dec 2024 and says they are not treated as $0',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'coverage');
      const partial = await page.$$eval('.rv-cov-table tbody tr.rv-cov-partial th', ths => ths.map(th => th.textContent.trim()));
      assert.deepEqual(partial, ['Dec 2024', 'Nov 2024', 'Oct 2024']);
      const notice = await page.textContent('.rv > .notice');
      assert.match(notice, /Oct–Dec 2024/);
      assert.match(notice, /never treated as \$0/);
      assert.ok(await noHorizontalScroll(page));
    },
  },
  {
    name: 'reconcile: adding a reference shows the difference, a breakdown and possible explanations',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'reconcile');
      const app = await page.evaluate(() => {
        const ctx = window.HouseholdBudget.context();
        return ctx.E.ledger.summarize(ctx.E.ledger.filter(ctx.txns, { start: '2026-03-01', end: '2026-03-31', includeExcluded: true }));
      });
      // An end date before the start is refused.
      await page.fill('#rv-ref-label', 'Card statement, March');
      await page.fill('#rv-ref-start', '2026-03-31');
      await page.fill('#rv-ref-end', '2026-03-01');
      await page.fill('#rv-ref-amount', '100');
      await page.click('#rv-ref-save');
      await page.waitForSelector('#rv-ref-end-error:not([hidden])');
      assert.equal((await state(page)).references.length, 0);
      // A reference that includes the debt payments: higher by exactly that amount.
      const refCents = app.spendingCents + app.debtPaymentsCents;
      await page.fill('#rv-ref-start', '2026-03-01');
      await page.fill('#rv-ref-end', '2026-03-31');
      await page.fill('#rv-ref-amount', (refCents / 100).toFixed(2));
      await page.click('#rv-ref-save');
      await page.waitForFunction(() => /[?&]ref=/.test(location.hash));
      await page.waitForSelector('#rv-rec');
      const refs = (await state(page)).references;
      assert.equal(refs.length, 1);
      assert.equal(refs[0].spendingCents, refCents);
      const metrics = await page.$$eval('#rv-rec .metric-value', els => els.map(e => e.textContent));
      assert.equal(cents(metrics[1]), app.spendingCents, 'app spending shown');
      assert.equal(cents(metrics[2]), app.debtPaymentsCents, 'difference = reference − app');
      const breakdown = await page.textContent('#rv-rec-breakdown');
      for (const part of ['Purchases', 'Refunds', 'Debt payments', 'Card payments', 'Moved to savings', 'Pending business purchases', 'Possible duplicates']) {
        assert.ok(breakdown.includes(part), 'breakdown lists ' + part);
      }
      const links = await page.$$eval('#rv-rec-breakdown tbody th a', as => as.map(a => a.getAttribute('href')));
      assert.ok(links.some(h => h.startsWith('#/spending?period=2026-03')), 'components link to Spending');
      const explain = await page.textContent('#rv-rec-explain');
      assert.match(explain, /Debt payments/);
      assert.match(explain, /possibilities to check/);
      assert.ok(await noHorizontalScroll(page), 'no horizontal scroll with the breakdown');
      await t.shot('review-reconcile-result');
      // Removing the reference is undoable.
      await page.click('#rv-ref-rm-' + refs[0].id);
      await page.waitForFunction(() => window.HouseholdBudget.getState().references.length === 0);
      await toastUndo(page);
      await page.waitForFunction(() => window.HouseholdBudget.getState().references.length === 1);
    },
  },
  {
    name: 'index lists missing budget information with links to Budget',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/review');
      const links = await page.$$eval('#rv-missing .rv-missing a', as => as.map(a => a.getAttribute('href')));
      assert.ok(links.length >= 3, 'several missing inputs in the sample');
      // Setup areas by section; a what-if's missing amounts open Edit plan's planned changes.
      for (const h of links) assert.match(h, /^#\/budget\?(section=(income|bills|targets|savings|debts)|focus=plan-changes-h$)/);
      assert.match(await page.textContent('#rv-missing'), /Not set/);
    },
  },
  {
    name: 'a link from Spending with txn highlights that transaction in its queue',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/review');
      const [u] = (await queues(page)).uncertain;
      await page.goto(t.url + `#/review?queue=uncertain&txn=${u.id}`);
      await page.waitForSelector('.rv-item.is-target');
      assert.equal(await page.$eval('.rv-item.is-target', el => el.dataset.rvItem), u.id);
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'rv-h-' + id, u.id);
      // Wrong queue: it opens where it is waiting, and says so.
      await page.goto(t.url + `#/review?queue=business&txn=${u.id}`);
      await page.waitForFunction(id => location.hash === `#/review?queue=uncertain&txn=${id}&from=business`, u.id);
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'rv-h-' + id, u.id);
      assert.match(await page.textContent('.rv > .notice'), /so it opened here/);
      // A possible duplicate that is also a mixed-retail purchase opens with its pair: deciding
      // the duplicate changes totals, so it comes first.
      const [pair] = (await queues(page)).duplicates;
      await page.goto(t.url + `#/review?queue=uncertain&txn=${pair.ids[1]}`);
      await page.waitForFunction(id => location.hash === `#/review?queue=duplicates&txn=${id}&from=uncertain`, pair.ids[1]);
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'rv-h-dup-' + id, pair.ids[0]);
      // A transaction that needs nothing: a note, and a way back to it in Spending.
      const plain = await page.evaluate(() => {
        const ctx = window.HouseholdBudget.context();
        return ctx.txns.find(x => x.kind === 'spend' && x.category === 'Groceries' && !x.flags.length && !x.edited).id;
      });
      await page.goto(t.url + `#/review?queue=uncertain&txn=${plain}`);
      await page.waitForFunction(() => /needs a decision here/.test(document.querySelector('.rv > .notice')?.textContent || ''));
      assert.equal(await page.evaluate(() => location.hash.includes('from=')), false, 'no redirect when it waits nowhere');
      assert.match(await page.$eval('.rv > .notice a', a => a.getAttribute('href')), new RegExp('^#/spending\\?period=\\d{4}-\\d{2}&txn=' + plain));
    },
  },
  {
    name: 'keyboard only: correct a category with Tab, typing and Enter',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'uncertain');
      const zelle = (await queues(page)).uncertain.find(x => x.kind === 'spend');
      const sel = `rv-cf-${zelle.id}-cat`;
      await page.focus('#page-title');
      let found = false;
      for (let i = 0; i < 60 && !found; i++) {
        await page.keyboard.press('Tab');
        found = await page.evaluate(id => document.activeElement && document.activeElement.id === id, sel);
      }
      assert.ok(found, 'the category select is reachable with Tab');
      await page.keyboard.type('Gifts');
      assert.equal(await page.$eval('#' + sel, s => s.value), 'Gifts & donations', 'typing picks the category');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), `rv-cf-${zelle.id}-reason`);
      await page.keyboard.type('Gift for a friend');
      await page.keyboard.press('Enter');
      await page.waitForFunction(id => window.HouseholdBudget.getState().ledgerEdits[id]?.category === 'Gifts & donations', zelle.id);
      await page.waitForSelector('#rv-item-' + zelle.id, { state: 'detached' });
      // Focus lands on the remaining item's heading, ready for the next decision.
      await page.waitForFunction(() => document.activeElement && /^rv-h-/.test(document.activeElement.id));
    },
  },
  {
    name: 'phone: items, forms and the queue strip fit the screen',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      for (const q of ['uncertain', 'reimbursements', 'transfers', 'spikes']) {
        await openQueue(t, q);
        const vw = await page.evaluate(() => document.documentElement.clientWidth);
        const wide = await page.$$eval('.rv-item, .rv-form, .rv-decide, .card', (els, w) => els.filter(e => e.getBoundingClientRect().right > w + 1).length, vw);
        assert.equal(wide, 0, q + ': nothing wider than the screen');
        const strip = await page.$eval('.rv-tabs .section-nav', el => ({ scroll: el.scrollWidth > el.clientWidth, ox: getComputedStyle(el).overflowX }));
        assert.ok(strip.scroll && strip.ox === 'auto', 'queue tabs scroll sideways inside their strip');
        // The current tab is scrolled into view.
        const box = await page.$eval('.rv-tabs [aria-current]', a => { const r = a.getBoundingClientRect(); return { l: r.left, r: r.right }; });
        assert.ok(box.l >= 0 && box.r <= vw + 1, q + ': current tab visible');
        assert.ok(await noHorizontalScroll(page));
      }
      // A decision on a phone.
      await openQueue(t, 'mixed');
      const id = await page.$eval('.rv-items .rv-item', el => el.dataset.rvItem);
      await page.click(`#rv-mx-${id} > summary`);
      assert.ok(await noHorizontalScroll(page), 'open split form fits');
      await t.shot('review-mixed-open');
    },
  },
  {
    name: 'yearly bills are listed apart from spikes with the budget line, and a link to one payment focuses it',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'spikes');
      const q = await queues(page);
      const insurance = q.annual.filter(a => a.category === 'Home insurance');
      assert.equal(insurance.length, 2, 'the sample has a yearly home insurance bill in two years');
      assert.ok(!q.spikes.some(s => s.category === 'Home insurance'), 'not a spike');
      assert.equal(await page.textContent('#rv-annual-h'), 'Yearly bills (not unusual)');
      const card = await page.textContent('#rv-annual');
      assert.match(card, /not unusual/);
      assert.match(card, /needs no decision/);
      assert.equal((card.match(/\$1,104\.00/g) || []).length >= 2, true, 'both yearly payments listed');
      assert.match(card, /Home insurance: \$92\.00 a month \(\$1,104\.00 a year\)/, 'the budget line for it');
      assert.ok(!card.includes('Dental'), 'the real spike is not in the yearly list');
      // The Spikes tab counts only the real spike.
      assert.match(await page.textContent('#rv-tab-spikes'), /Spikes\s*1/);
      // Every payment opens in Spending.
      const links = await page.$$eval('#rv-annual a[href^="#/spending?"]', as => as.map(a => a.getAttribute('href')));
      for (const a of insurance) assert.ok(links.some(h => h.includes('txn=' + a.ids[0])), 'payment ' + a.month + ' links to Spending');
      assert.ok(await noHorizontalScroll(page));
      await t.shot('review-yearly-bills');

      await arrive(t, `#/review?queue=spikes&txn=${insurance[0].ids[0]}`);
      await page.waitForFunction(() => /^rv-h-yr-/.test(document.activeElement && document.activeElement.id));
      const item = await page.$eval('#rv-annual .rv-item.is-target', el => el.textContent);
      assert.match(item, /The transaction you opened/);
      assert.equal(await page.$$eval('.rv > .notice', ns => ns.length), 0, 'no "not waiting here" note');
    },
  },
  {
    name: 'links that name a transaction open its list, highlight it with text and focus it in every queue',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/review');
      const q0 = await queues(page);
      const dup = q0.duplicates[0];
      const biz = q0.business[1].id;
      // Decide a duplicate and a business purchase, so they sit in the "decided" lists.
      await page.evaluate(([second, b]) => {
        const H = window.HouseholdBudget, E = H.engine, st = H.getState(), at = '2026-09-30T10:00:00Z';
        st.ledgerEdits[second] = E.review.editRecord(null, 'duplicate', 'exclude', 'Same charge listed twice', at);
        st.ledgerEdits[b] = E.review.editRecord(null, 'business', 'business', 'Bought for work', at);
        H.setState(st);
      }, [dup.ids[1], biz]);

      // Business: the filter that holds it is chosen, its checkbox is focused.
      await arrive(t, `#/review?queue=business&txn=${biz}`);
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'rv-biz-' + id, biz);
      assert.equal(await page.$eval('#rv-biz-f-business', a => a.getAttribute('aria-current')), 'true');
      assert.match(await page.textContent(`#rv-biz-${biz}-row`), /The transaction you opened/);

      // A contribution needs no answer: its collapsed list opens and the row is focused.
      const exp = q0.expected[1];
      await arrive(t, `#/review?queue=transfers&txn=${exp}`);
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'rv-tr-row-' + id, exp);
      assert.ok(await page.$eval('#rv-tr-exp-list', d => d.open), 'list opened');
      assert.match(await page.textContent('.rv > .notice'), /needs no answer/);

      // A matched card payment: explained, highlighted in the matched list.
      const pair = q0.paired[2];
      await arrive(t, `#/review?queue=transfers&txn=${pair[1]}`);
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'rv-tr-pair-' + id, pair[0]);
      assert.ok(await page.$eval('#rv-tr-paired-list', d => d.open));

      // The copy that was kept: the decision on its pair is highlighted.
      await arrive(t, `#/review?queue=duplicates&txn=${dup.ids[0]}`);
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'rv-dup-row-' + id, dup.ids[1]);
      assert.match(await page.textContent('.rv > .notice'), /already decided/);

      // A link to the wrong queue (Spending's links send mixed-retail rows to Uncertain) opens
      // the queue where it waits, on the page that holds it, replacing the history entry.
      const mixed = q0.mixed[30];
      await arrive(t, `#/review?queue=uncertain&txn=${mixed}`);
      await page.waitForFunction(id => location.hash === `#/review?queue=mixed&txn=${id}&from=uncertain`, mixed);
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'rv-h-' + id, mixed);
      assert.match(await page.textContent('#rv-item-' + mixed), /The transaction you opened/);
      assert.match(await page.textContent('.rv > .notice'), /listed in Mixed retail, so it opened here/);
      assert.match(await page.textContent('.rv-pager-text'), /Page ([2-9]|\d\d) of/, "not among the newest 25, so the page holding it opened");
      // After an action on the page, focus is not pulled back to the opened item.
      await page.focus('#rv-keep-' + mixed);
      await page.evaluate(() => { document.querySelector('.rv').dataset.old = '1'; window.BudgetUI.app.render(); });
      await page.waitForFunction(() => document.querySelector('.rv') && !document.querySelector('.rv').dataset.old);
      // Let the view's deferred focus step run (timers queued earlier fire first).
      await page.evaluate(() => new Promise(r => setTimeout(r, 0)));
      assert.equal(await focusedId(page), 'rv-keep-' + mixed);
      // The wrong-queue address was replaced, so Back returns to Spending.
      await page.goBack();
      await page.waitForFunction(() => location.hash === '#/spending');
    },
  },
  {
    name: 'reconcile from a Spending link uses its dates; dates without data are Unknown, never $0',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await arrive(t, '#/review?queue=reconcile&start=2026-03-01&end=2026-03-31');
      await page.waitForSelector('#rv-rec');
      const app = await page.evaluate(() => {
        const ctx = window.HouseholdBudget.context();
        return ctx.E.ledger.summarize(ctx.E.ledger.filter(ctx.txns, { start: '2026-03-01', end: '2026-03-31' }));
      });
      const metrics = await page.$$eval('#rv-rec .metric-value', els => els.map(e => e.textContent));
      assert.equal(metrics[0], 'Not entered');
      assert.equal(cents(metrics[1]), app.spendingCents);
      assert.equal(await page.$eval('#rv-ref-start', i => i.value), '2026-03-01', 'form takes the dates');
      assert.equal(await page.$eval('#rv-ref-end', i => i.value), '2026-03-31');
      // Each part with rows lists them, and they add up to the part's amount.
      const parts = await page.$$eval('#rv-rec-breakdown tbody tr', trs => trs.filter(tr => tr.querySelector('.rv-rows')).map(tr => {
        const money = s => { const m = String(s).match(/([−-])?\$([\d,]+\.\d{2})/); const v = Math.round(Number(m[2].replace(/,/g, '')) * 100); return m[1] ? -v : v; };
        return { total: money(tr.querySelector('td.num').textContent), rows: [...tr.querySelectorAll('.rv-rows li .num')].map(n => money(n.textContent)), links: [...tr.querySelectorAll('.rv-rows li a')].map(a => a.getAttribute('href')) };
      }));
      assert.ok(parts.length >= 2, 'several parts list their transactions');
      for (const p of parts) {
        assert.equal(p.rows.reduce((a, b) => a + b, 0), p.total, 'listed rows add up to the part');
        for (const h of p.links) assert.match(h, /^#\/spending\?period=\d{4}-\d{2}&txn=/);
      }
      assert.ok(await noHorizontalScroll(page));

      // Dates outside the data: unknown, no zero breakdown.
      await page.goto(t.url + '#/review?queue=reconcile&start=2023-01-01&end=2023-01-31');
      await page.waitForFunction(() => /2023/.test(document.querySelector('#rv-rec-h')?.textContent || ''));
      const none = await page.$$eval('#rv-rec .metric-value', els => els.map(e => e.textContent));
      assert.deepEqual(none.slice(1), ['Unknown', 'Unknown']);
      assert.ok(!(await page.textContent('#rv-rec')).includes('$0.00'), 'no $0 shown for unknown spending');
      assert.match(await page.textContent('#rv-rec'), /unknown, not \$0/);
      assert.equal(!!(await page.$('#rv-rec-breakdown')), false);
      await t.shot('review-reconcile-nodata');

      // Partly covered dates: the missing and partial months are named.
      await page.goto(t.url + '#/review?queue=reconcile&start=2024-09-01&end=2024-12-31');
      await page.waitForFunction(() => /2024/.test(document.querySelector('#rv-rec-h')?.textContent || ''));
      const notes = await page.textContent('#rv-rec');
      assert.match(notes, /Sep 2024 is not in your exports/);
      assert.match(notes, /Oct–Dec 2024 are only partly covered/);
      assert.match(notes, /only what is in the data/);
    },
  },
  {
    name: 'decided rows stop asking: a confirmed reimbursement leaves Uncertain, an answered transfer loses its warning',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'reimbursements');
      const [r] = (await queues(page)).reimb;
      const base = '#rv-rb-' + r.chargeId;
      await page.check(`${base}-s-confirmed`);
      await page.fill(`${base}-reason`, 'Employer paid it back');
      await page.press(`${base}-reason`, 'Enter');
      await page.waitForFunction(id => window.HouseholdBudget.getState().ledgerEdits[id]?.reimbursement === 'confirmed', r.depositId);
      // Focus stays on the decided item's heading.
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'rv-h-rb-' + id, r.chargeId);
      await page.click('#rv-tab-uncertain');
      await page.waitForFunction(() => location.hash === '#/review?queue=uncertain');
      await page.waitForSelector('#rv-list');
      assert.equal(!!(await page.$('#rv-item-' + r.depositId)), false, 'the deposit no longer asks where it came from');
      assert.match(await page.textContent('#rv-tab-uncertain'), /Uncertain\s*1/);

      await page.click('#rv-tab-transfers');
      await page.waitForFunction(() => location.hash === '#/review?queue=transfers');
      const [u] = (await queues(page)).unpaired;
      await page.check(`#rv-tr-${u.id}-k-savings`);
      await page.fill(`#rv-tr-${u.id}-reason`, 'Moved from our savings');
      await page.click(`#rv-tr-${u.id}-save`);
      await page.waitForFunction(id => window.HouseholdBudget.getState().ledgerEdits[id]?.subtype === 'savings', u.id);
      await page.goto(t.url + '#/review?queue=edited&txn=' + u.id);
      await page.waitForSelector('#rv-item-' + u.id);
      const text = await page.textContent('#rv-item-' + u.id);
      assert.match(text, /Savings transfer/);
      assert.ok(!text.includes('Unmatched transfer'), 'answered: no stale warning badge');
      // Undoing the answer from Transfers keeps unrelated decisions and logs the change.
      await page.goto(t.url + '#/review?queue=transfers');
      await page.click('#rv-tr-undo-' + u.id);
      await page.waitForFunction(id => !window.HouseholdBudget.getState().ledgerEdits[id].kind, u.id);
      assert.equal((await state(page)).ledgerEdits[u.id].history.length, 4, 'answer and undo both in the history');
      await page.waitForSelector('#rv-item-' + u.id);
    },
  },
  {
    name: 'saved text is shown as text, never as markup',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      page.on('dialog', d => { t.errors.push('dialog: ' + d.message()); d.dismiss(); });
      await t.open('#/review');
      const q = await queues(page);
      await page.evaluate(([X, unc, unpaired, mixed]) => {
        const H = window.HouseholdBudget, E = H.engine, st = H.getState(), at = '2026-09-30T10:00:00Z';
        const ed = (id, f, v) => { st.ledgerEdits[id] = E.review.editRecord(st.ledgerEdits[id], f, v, X, at); };
        ed(unc, 'category', X);
        ed(unpaired, 'kind', 'spend'); ed(unpaired, 'category', X);
        ed(mixed, 'note', X);
        st.ledgerEdits['tx-missing-' + X] = E.review.editRecord(null, 'category', X, X, at);
        st.references = [{ id: 'ref-x', label: X, start: '2026-03-01', end: '2026-03-31', spendingCents: 12345, source: X }];
        st.plan.bills[0].label = X;
        st.plan.targets[X] = null;
        H.setState(st);
      }, [HOSTILE, q.uncertain[0].id, q.unpaired[0].id, q.mixed[0]]);
      for (const hash of ['#/review', '#/review?queue=edited', '#/review?queue=transfers', '#/review?queue=reconcile&ref=ref-x', `#/review?queue=uncertain&txn=${encodeURIComponent(HOSTILE)}`, `#/review?queue=${encodeURIComponent(HOSTILE)}`]) {
        await page.goto(t.url + hash);
        await page.waitForSelector('.rv');
        assert.equal(await page.$$eval('#view img', els => els.length), 0, hash + ': no injected element');
        assert.ok((await page.textContent('#view')).includes('<img src=x'), hash + ': shown as text');
      }
      assert.equal(await page.evaluate(() => window.__xss || 0), 0);
    },
  },
  {
    name: 'with no transactions loaded the index claims nothing is complete or clear',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/review');
      await page.evaluate(() => localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: { schemaVersion: 2, datasetId: 'empty-test', isSynthetic: true, generatedAt: null, currency: 'USD', accounts: [], transactions: [], coverageOverrides: {}, importLog: [], references: [], notes: [] } })));
      await page.reload();
      await page.waitForSelector('.rv');
      const text = await page.textContent('.rv');
      assert.match(text, /No transactions are loaded/);
      assert.ok(!text.includes('Every month is complete'), 'coverage is not called complete');
      assert.ok(!text.includes('Nothing waiting'), 'queues are not called clear');
      assert.match(text, /No data yet/);
      assert.equal(!!(await page.$('.rv-metrics')), false, 'no $0 headline figures');
      assert.ok(text.includes('Missing information'), 'budget inputs still listed');
    },
  },
  {
    name: 'store filters and pages are links: Back walks back through them',
    async run(t) {
      const { page, assert } = t;
      await openQueue(t, 'mixed');
      const chip = await page.$$eval('.rv-chips a', as => as[1].id);
      await page.click('#' + chip);
      await page.waitForFunction(() => /merchant=/.test(location.hash));
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'rv-list-h');
      const hashA = await page.evaluate(() => location.hash);
      await page.click('#rv-chip-all');
      await page.waitForFunction(() => location.hash === '#/review?queue=mixed');
      await page.click('#rv-page-next');
      await page.waitForFunction(() => location.hash === '#/review?queue=mixed&page=2');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'rv-list-h');
      assert.match(await page.textContent('.rv-pager-text'), /Page 2 of/);
      await page.goBack();
      await page.waitForFunction(() => location.hash === '#/review?queue=mixed');
      await page.goBack();
      await page.waitForFunction(h => location.hash === h, hashA);
      await page.waitForFunction(() => document.querySelector('.rv-chips a[aria-current]')?.id !== 'rv-chip-all');
    },
  },
  {
    name: 'every control and link has a name, ids are unique and tables have captions in every queue',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/review');
      const q = await queues(page);
      await page.evaluate(([second, unpaired]) => {
        const H = window.HouseholdBudget, E = H.engine, st = H.getState(), at = '2026-09-30T10:00:00Z';
        st.ledgerEdits[second] = E.review.editRecord(null, 'duplicate', 'exclude', 'Same charge listed twice', at);
        st.ledgerEdits[unpaired] = E.review.editRecord(null, 'kind', 'transfer', 'Known transfer', at);
        st.references = [{ id: 'ref-a', label: 'Card statement', start: '2026-03-01', end: '2026-03-31', spendingCents: 500000, source: 'Added in Data review' }];
        H.setState(st);
      }, [q.duplicates[0].ids[1], q.unpaired[0].id]);
      for (const queue of ['', ...QUEUES.filter(x => x !== 'reconcile'), 'reconcile&ref=ref-a']) {
        await page.goto(t.url + '#/review' + (queue ? '?queue=' + queue : ''));
        await page.waitForSelector('.rv');
        const r = await page.evaluate(() => {
          document.querySelectorAll('#view details').forEach(d => { d.open = true; });
          const name = el => {
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
            if (el.getAttribute('aria-labelledby')) return el.getAttribute('aria-labelledby').split(' ').map(i => document.getElementById(i)?.textContent || '').join(' ').trim();
            const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lab) return lab.textContent.trim();
            return (el.closest('label')?.textContent || el.textContent || '').trim();
          };
          const unnamed = [...document.querySelectorAll('#view input, #view select, #view button, #view a, #view summary')].filter(el => !name(el)).map(el => el.tagName + '#' + el.id);
          const seen = {};
          for (const el of document.querySelectorAll('#view [id]')) seen[el.id] = (seen[el.id] || 0) + 1;
          return { unnamed, dupIds: Object.keys(seen).filter(k => seen[k] > 1), noCaption: [...document.querySelectorAll('#view table')].filter(tb => !tb.querySelector('caption')).length };
        });
        assert.deepEqual(r, { unnamed: [], dupIds: [], noCaption: 0 }, (queue || 'index') + ': names, ids and captions');
      }
    },
  },
  {
    name: 'reconcile: a reference from the household profile is listed and its gap is explained as a possibility',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/review?queue=reconcile&ref=spreadsheet-q3');
      await page.waitForSelector('#rv-rec-h');
      const text = await page.textContent('#view');
      assert.match(text, /From the household profile/);
      assert.match(text, /Difference \+\$165\.00/);
      assert.match(text, /within \$1 of .Debt payments/);
      assert.match(text, /possibilities to check, not conclusions/);
    },
  },
];
