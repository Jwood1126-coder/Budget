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
async function noHorizontalScroll(page) {
  return page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    return document.scrollingElement.scrollWidth <= cw + 1 && window.innerWidth <= cw + 1;
  });
}
const state = page => page.evaluate(() => window.HouseholdBudget.getState());
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
  };
});
async function openQueue(t, queue, extra = '') {
  await t.open(`#/review?queue=${queue}${extra}`);
  await t.page.waitForSelector('.rv');
}
/** Money text like "$1,234.56" or "−$12.00" → integer cents. */
function cents(text) {
  const m = String(text).match(/([−-])?\$([\d,]+\.\d{2})/);
  if (!m) throw new Error('No amount in: ' + text);
  const v = Math.round(Number(m[2].replace(/,/g, '')) * 100);
  return m[1] ? -v : v;
}
const fmtMoney = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
      // Focus moved to the next item rather than being lost.
      assert.ok(await page.evaluate(() => document.querySelector('.rv').contains(document.activeElement)), 'focus stays in the view');

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
      assert.ok((await page.textContent('#rv-item-' + zelle.id)).includes('Reverted'));
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
      assert.equal(cents(await page.textContent('.rv-metrics .metric:nth-child(2) .metric-value')), bizCents, 'Business total shown');
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
      for (const h of links) assert.match(h, /^#\/budget\?section=(income|bills|targets|savings|debts)/);
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
      // Wrong queue: a note says where it is waiting.
      await page.goto(t.url + `#/review?queue=business&txn=${u.id}`);
      await page.waitForSelector('#page-title');
      assert.match(await page.textContent('.rv'), /is not waiting in Business costs/);
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
];
