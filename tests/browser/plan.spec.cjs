'use strict';
// Overview (#/overview): the balances, the plan month's tiles, the two chart panels, a month's
// breakdown, the warning below $0 and the CSV export; then Edit plan (#/budget): the dials, their
// drill-down to places and transactions, recategorizing, Reset and who paid in. Synthetic sample
// only. Planned changes and the Forecast redirect are in plan-v4.spec.cjs; pay, bills, debts and
// goals in budget.spec.cjs.
const fs = require('node:fs');

const { noHorizontalScroll, state, whole, amt, boxText, money, centsOf } = require('./helpers.cjs');

/** The engine's model for the current state, built the way the page builds it (real local today). */
function timeline(page) {
  return page.evaluate(() => {
    const H = window.HouseholdBudget, E = H.engine, ctx = H.context(), st = H.getState();
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const tl = E.timeline.build({ txns: ctx.realTxns, dataset: ctx.dataset, plan: st.plan, settings: st.ui.plan, today, coverageMap: ctx.coverageMap });
    const label = m => E.months.label(m);
    const drill = k => (tl.dialsByKey[k] && tl.dialsByKey[k].drill) || null;
    return {
      today, todayMonth: tl.todayMonth, todayLabel: label(tl.todayMonth), firstLabel: label(tl.firstMonth), planStart: tl.planStart, planLabel: label(tl.planStart), plan: tl.plan, summary: tl.summary,
      count: tl.baseline.count, changed: tl.changed, groupsOut: tl.groups.out,
      dials: tl.dials.map(x => ({ key: x.key, label: x.label, baselineCents: x.baselineCents, planCents: x.planCents, source: x.source, budgetCents: x.budgetCents, averageCents: x.averageCents, cardCents: x.cardCents, bankCents: x.bankCents })),
      essentials: drill('essentials'), flexible: drill('flexible'), irregular: drill('irregular'),
      keptIn: tl.baseline.keptIn,
      changes: tl.changes,
      series: tl.series.map(s => s.key),
      balances: { mode: tl.balances.mode, runsOut: tl.balances.runsOut, combined: tl.balances.combined, accounts: tl.balances.accounts.map(a => ({ id: a.id, points: a.points, anchor: a.anchor })),
        assumed: tl.balances.assumed || null, illustrative: tl.balances.illustrative || null },
      months: tl.months.map(m => ({ month: m.month, label: label(m.month), status: m.status, out: m.out, in: m.in, net: m.net, combinedChange: m.combinedChange })),
    };
  });
}
/** Clears the sample's budgets (plan.targets) for these categories, so they plan from their history. */
async function withoutBudgets(t, categories) {
  await t.page.evaluate(cats => {
    const H = window.HouseholdBudget;
    const st = H.getState();
    for (const c of cats) st.plan.targets[c] = null;
    H.setState(st);
  }, categories);
  await t.settled();
}
const dialOf = (exp, key) => exp.dials.find(d => d.key === key);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function typeAmount(page, sel, text) {
  await page.fill(sel, text);
  await page.press(sel, 'Enter');
}
async function openDetails(page, id) {
  if (!(await page.$eval('#' + id, d => d.open))) await page.click(`#${id} > summary`);
}
/** A chart panel's table twin (plan-chart: balances; plan-flows: money in and out): header labels and every row's cells. */
async function table(page, fig = 'plan-chart') {
  await openDetails(page, fig + '-table');
  const heads = await page.$$eval(`#${fig}-table thead th`, ths => ths.map(th => th.textContent.trim()));
  const rows = await page.$$eval(`#${fig}-table tbody tr`, trs => trs.map(tr => Array.from(tr.children).map(td => td.textContent.trim())));
  return { heads, rows, col: name => heads.indexOf(name) };
}

/** The chart's month row in the table twin, by its label ('Sep 2026'). */
const row = (tb, label) => tb.rows.find(r => r[0] === label);
/** September's x in the chart, the series whose September point is assumed, and every line path. */
function septemberPaths(page) {
  return page.evaluate(() => {
    const fig = document.querySelector('#plan-chart');
    const model = JSON.parse(fig.querySelector('script.cc-model').textContent);
    const m = model.months.find(x => x.t === 'September 2026');
    const keys = m.rows.filter(r => /^Assumed/.test(r.s || '')).map(r => r.k);
    const paths = Array.from(fig.querySelectorAll('.cc-svg path.line')).map(p => ({
      cls: p.getAttribute('class'), key: p.closest('[data-cc-series]').dataset.ccSeries,
      xs: (p.getAttribute('d').match(/[ML][\d.]+/g) || []).map(v => Number(v.slice(1))),
    }));
    return { x: m.x, keys, paths, assumedPaths: paths.filter(p => /\bis-assumed\b/.test(p.cls)).length };
  });
}
/** An export with no running balance and no balances supplied with it: nothing known for the accounts. */
async function loadWithoutBalances(page, file) {
  await page.evaluate(name => {
    const ds = JSON.parse(JSON.stringify(window.HouseholdBudget.getDataset()));
    for (const x of ds.transactions) delete x.balanceCents;
    ds.balances = [];
    localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: ds, loadedAt: new Date().toISOString(), source: 'json', file: name }));
  }, file);
  await page.reload();
  await page.waitForSelector('#page-title');
}
/** Transactions as the page holds them (the decided data), by id: what a list line shows and its edit. */
function txnsOf(page, ids) {
  return page.evaluate(list => {
    const all = new Map(window.HouseholdBudget.context().realTxns.map(t => [t.id, t]));
    return list.map(id => {
      const t = all.get(id);
      return { id, date: t.date, description: t.description, merchant: t.merchant, accountLabel: t.accountLabel, category: t.category, amountCents: t.amountCents, kind: t.kind };
    });
  }, ids);
}
/** Every spending transaction from a place in the whole data set (what “All N from this place” changes). */
function placeTxns(page, merchant) {
  return page.evaluate(m => window.HouseholdBudget.context().realTxns
    .filter(t => t.kind === 'spend' && (t.merchant || t.description) === m && !t.splitApplied && !(t.parts && t.parts.length > 1))
    .map(t => ({ id: t.id, category: t.category, date: t.date })), merchant);
}
/** Lines of a row's transaction list: [txn id, date, description, its title, amount, account, selected category]. */
function txnLines(page, rowId) {
  return page.$$eval(`[id="plan-txns-${rowId}"] .plan-tx`, ls => ls.map(l => {
    const sel = l.querySelector('select');
    return {
      id: l.dataset.txn, date: l.querySelector('.plan-tx-date').textContent.trim(), desc: l.querySelector('.plan-tx-desc').textContent.trim(),
      title: l.querySelector('.plan-tx-desc').getAttribute('title'), amount: l.querySelector('.plan-tx-amt').textContent.trim(),
      account: l.querySelector('.plan-tx-acct').textContent.trim(), category: sel ? sel.value : null, href: l.querySelector('.plan-tx-link').getAttribute('href'),
    };
  }));
}
const toastText = page => page.textContent('#toast').then(x => x.replace(/\s+/g, ' ').trim());
/** “Sep 27” this year, “Sep 27, 2025” before (as the lists show dates). */
const shortDate = date => {
  const d = new Date(date + 'T12:00:00');
  const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return date.slice(0, 4) === String(new Date().getFullYear()) ? label.replace(/, \d{4}$/, '') : label;
};

module.exports = [
  {
    name: 'overview: checking and savings apart with their dates, three tiles, two chart panels with their own axes, a short Coming up',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      assert.equal((await page.textContent('#page-title')).trim(), 'Overview');
      assert.match(await page.textContent('.page-subtitle'), /^Joint accounts · your data through Sep 30, 2026$/);
      const exp = await timeline(page);
      const ids = await page.$$eval('#plan-root > *', xs => xs.map(x => x.id).filter(Boolean));
      assert.deepEqual(ids, ['plan-balances', 'plan-kpis', 'plan-chart-card', 'plan-month-box', 'plan-coming', 'plan-live', 'plan-sample'], 'balances → the month → chart → (breakdown) → coming up');
      // 1. Balances: checking first, then savings, each with its own date and source; then the total.
      assert.deepEqual(await page.$$eval('.ov-bal-list .ov-bal', bs => bs.map(b => b.className.replace(/\s*ov-bal\s*/, '').trim())), ['is-checking', 'is-savings', 'is-total']);
      const chk = exp.balances.accounts.find(a => a.id === 'joint-checking').anchor;
      const sav = exp.balances.accounts.find(a => a.id === 'joint-savings').anchor;
      assert.equal((await page.textContent('#plan-bal-joint-checking-figure')).trim(), money(chk.cents));
      assert.equal((await page.textContent('#plan-bal-joint-checking-asof')).trim(), 'as of Sep 30, 2026 · from your bank data');
      assert.equal((await page.textContent('#plan-bal-joint-savings-figure')).trim(), money(sav.cents));
      assert.equal((await page.textContent('#plan-bal-joint-savings-asof')).trim(), 'as of Sep 30, 2026 · entered by you');
      assert.match((await page.textContent('#plan-bal-total')).replace(/\s+/g, ' '), new RegExp('Combined ' + money(chk.cents + sav.cents).replace(/[$.]/g, '\\$&') + ' as of Sep 30, 2026'));
      assert.ok(!/today/i.test(await page.textContent('#plan-balances')), 'an old balance is never called today');
      assert.equal(await page.$eval('#plan-bal-edit', d => d.open), false, 'the balance editors are folded');
      // 2. The plan month: income, outgoing and margin.
      const s = exp.summary;
      assert.match(await page.textContent('#plan-kpis-h'), /^October 2026 · monthly estimate on this plan$/);
      assert.equal((await page.textContent('#plan-kpi-in-value')).trim(), whole(s.inCents));
      assert.equal((await page.textContent('#plan-kpi-out-value')).trim(), whole(s.outCents));
      assert.equal((await page.textContent('#plan-kpi-margin-value')).trim(), (s.inCents - s.outCents > 0 ? '+' : '') + whole(s.inCents - s.outCents));
      assert.equal((await page.textContent('#plan-kpi-margin-sub')).trim(), `${amt(s.savingsCents)} of it to savings`);
      assert.deepEqual(await page.$$eval('#plan-kpis .kpi-label', ls => ls.map(l => l.textContent.trim())), ['Income', 'Outgoing', 'Margin'], 'no investments tile');
      // 3. Two panels on the same months, each with its own axis title.
      assert.equal(await page.getAttribute('#plan-chart', 'data-mode'), 'balance');
      assert.equal(await page.getAttribute('#plan-flows', 'data-mode'), 'trends');
      assert.equal((await page.textContent('#plan-chart .cc-axis-title')).trim(), 'Balance, $ at month end');
      assert.equal((await page.textContent('#plan-flows .cc-axis-title')).trim(), 'Monthly, $ per month');
      assert.deepEqual(await page.$$eval('#plan-chart .cc-chip', bs => bs.map(b => [b.dataset.ccKey, b.textContent.trim(), b.getAttribute('aria-pressed')])),
        [['acct-joint-checking', 'Joint checking', 'true'], ['acct-joint-savings', 'Joint savings', 'true'], ['combined', 'Combined cash', 'true']], 'checking, savings and combined; no investments line');
      assert.deepEqual(await page.$$eval('#plan-flows .cc-chip', bs => bs.map(b => b.textContent.trim())), ['Income', 'Outgoing', 'Net to savings']);
      const top = await table(page);
      const bottom = await table(page, 'plan-flows');
      assert.deepEqual(bottom.rows.map(r => r[0]), top.rows.map(r => r[0]), 'one month axis');
      const pr = row(bottom, exp.planLabel);
      assert.equal(pr[bottom.col('Income')], whole(s.inCents));
      assert.equal(pr[bottom.col('Outgoing')], whole(s.outCents));
      assert.equal(pr[bottom.col('Status')], 'Projected');
      assert.match(await page.textContent('#plan-flows .cc-caption'), /Dashed: this plan’s monthly estimate from Oct 2026\./);
      assert.match(await page.textContent('#plan-chart .cc-caption'), /^Combined cash = Joint checking \+ Joint savings\. Solid: your data through Sep 2026\. Dashed: this plan’s monthly estimate from Oct 2026\./);
      // Removed: the mode switch, Trends, Compare, the strip, the packs, Accept all, the dials and the investments.
      for (const sel of ['input[name="plan-mode"]', '#plan-compare', '#plan-trend-pick', '#plan-coming-strip', '#plan-ch-accept-all', '#plan-add-baby', '#plan-dials', '#plan-headline', '#plan-kpi-invest', '#plan-month', '[data-cc-key="balance-investments"]']) {
        assert.equal(await page.$$eval(sel, x => x.length), 0, sel + ' is gone');
      }
      // 5. Coming up: short, nothing to edit, a link to Edit plan.
      const up = await page.$$eval('#plan-coming-list > li', ls => ls.map(l => l.textContent.replace(/\s+/g, ' ').trim()));
      assert.ok(up.length >= 1 && up.length <= 6, up.join(' | '));
      assert.equal(await page.$$eval('#plan-coming input, #plan-coming select, #plan-coming button', x => x.length), 0, 'nothing to edit here');
      assert.equal(await page.getAttribute('#plan-coming-edit', 'href'), '#/budget?focus=plan-changes-h');
      assert.ok(await noHorizontalScroll(page));
      await t.shot('overview');
    },
  },
  {
    name: 'drill-down: a month chosen on the chart opens its breakdown by group and category; a tile opens the plan month; Close',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const exp = await timeline(page);
      // Click August 2026 on the balance panel.
      await page.$eval('#plan-chart-plot', el => el.scrollIntoView({ block: 'center' }));
      const point = await page.evaluate(() => {
        const fig = document.querySelector('#plan-chart');
        const model = JSON.parse(fig.querySelector('script.cc-model').textContent);
        const i = model.months.findIndex(m => m.m === '2026-08');
        const r = fig.querySelector('.cc-plot svg').getBoundingClientRect();
        return { x: r.left + model.months[i].x * (r.width / model.W), y: r.top + r.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
      await page.waitForSelector('#plan-month[data-month="2026-08"]');
      assert.match(await page.evaluate(() => location.hash), /^#\/overview\?month=2026-08$/);
      const aug = exp.months.find(m => m.month === '2026-08');
      assert.match((await page.textContent('#plan-month-h')).replace(/\s+/g, ' '), /^August 2026 Actual/);
      assert.equal((await page.textContent('#plan-month-in')).trim(), whole(aug.in.total));
      assert.equal((await page.textContent('#plan-month-out')).trim(), whole(aug.out.total));
      // Money in by person; outgoing by group, each opening into its categories (links to Spending).
      const inNames = await page.$$eval('#plan-month-inlist .ov-mline-name', xs => xs.map(x => x.textContent.trim()));
      assert.deepEqual(inNames.slice(0, 2), ['Alex', 'Sam']);
      assert.equal(await page.$eval('#plan-month-grp-essentials', d => d.open), false, 'detail only on demand');
      await page.click('#plan-month-grp-essentials > summary');
      const links = await page.$$eval('#plan-month-grp-essentials a', as => as.map(a => a.getAttribute('href')));
      assert.ok(links.length > 0 && links.every(h => /^#\/spending\?period=2026-08&cat=/.test(h)), links.join(' '));
      assert.match(await page.getAttribute('#plan-month-more', 'href'), /^#\/spending\?period=2026-08$/);
      // The breakdown is in the address: a reload shows it again.
      await page.reload();
      await page.waitForSelector('#plan-month[data-month="2026-08"]');
      // Close: gone, and so is the month in the address.
      await page.click('#plan-month-close');
      await page.waitForFunction(() => !document.querySelector('#plan-month') && location.hash === '#/overview');
      // A tile opens the plan month: the plan's categories, an estimate, with a way to Edit plan.
      await page.click('#plan-kpi-out');
      await page.waitForSelector(`#plan-month[data-month="${exp.planStart}"]`);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-month-h', 'focus moves to the breakdown');
      assert.match(await page.textContent('#plan-month-h'), /Plan · monthly estimate/);
      assert.equal((await page.textContent('#plan-month-out')).trim(), whole(exp.summary.outCents));
      await page.click('#plan-month-grp-flexible > summary');
      const flexRows = exp.flexible.rows.filter(r => r.level === 1 && r.included !== false && r.planCents);
      assert.equal(await page.$$eval('#plan-month-grp-flexible .ov-mcats > li', ls => ls.length), flexRows.length, 'one line per category of the plan');
      assert.equal(await page.getAttribute('#plan-month-more', 'href'), '#/budget?focus=plan-dials-h');
      // Keyboard: arrows read the bottom panel; Enter opens that month.
      await page.focus('#plan-flows-plot');
      await page.keyboard.press('ArrowLeft'); // the first press reads today's month
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      await page.waitForFunction(m => { const x = document.querySelector('#plan-month'); return x && x.dataset.month !== m; }, exp.planStart);
      assert.ok(await noHorizontalScroll(page));
    },
  },
  {
    name: 'phone: a tap on a month shows its readout and its breakdown together; the tiles fit three across',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.$eval('#plan-flows-plot', el => el.scrollIntoView({ block: 'center' }));
      const box = await page.$eval('#plan-flows-plot', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height / 2 }; });
      await page.touchscreen.tap(box.x, box.y);
      await page.waitForSelector('#plan-month');
      assert.ok(await page.isVisible('#plan-flows .cc-tip'), 'the readout stays open');
      const tiles = await page.$$eval('#plan-kpis .kpi', ks => ks.map(k => Math.round(k.getBoundingClientRect().top)));
      assert.equal(new Set(tiles).size, 1, 'income, outgoing and margin in one row');
      assert.ok(await noHorizontalScroll(page));
      const small = await page.$$eval('#plan-root button:not(.cc-chip), #plan-root .segmented label, #plan-root summary:not(.ov-mline), #plan-root .ov-link, #plan-root .ov-mmore a', els => els
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => ({ what: (el.id || el.textContent.trim()).slice(0, 40), h: Math.round(el.getBoundingClientRect().height) }))
        .filter(x => x.h < 36));
      assert.deepEqual(small, [], 'tap targets');
      await t.shot('overview-phone');
    },
  },
  {
    name: 'Ahead and Past change both panels; saved choices of retired controls are kept, ignored, and never written',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.evaluate(() => {
        const H = window.HouseholdBudget;
        const st = H.getState();
        st.ui.plan.mode = 'trends';
        st.ui.plan.hidden = ['combined'];
        H.setState(st);
      });
      await t.settled();
      assert.equal(await page.getAttribute('#plan-chart', 'data-mode'), 'balance', 'the saved mode is not read');
      assert.equal(await page.getAttribute('#plan-chart .cc-chip[data-cc-key="combined"]', 'aria-pressed'), 'true', 'the saved hidden series are not read');
      const n = async id => (await table(page, id)).rows.length;
      const before = await n('plan-chart');
      await page.click('label[for^="plan-horizon-24"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.horizon === 24);
      await page.waitForFunction(b => document.querySelectorAll('#plan-chart-table tbody tr').length === b + 12, before);
      assert.equal(await n('plan-flows'), before + 12, 'the money panel follows');
      const st = await state(page);
      assert.equal(st.ui.plan.mode, 'trends', 'kept as saved');
      assert.deepEqual(st.ui.plan.hidden, ['combined'], 'kept as saved');
      // A ?compare= from the retired Compare control is ignored.
      await page.goto(t.url + '#/overview?compare=New%20baby');
      await page.waitForSelector('#plan-chart');
      assert.equal(await page.$$eval('#plan-compare, [data-cc-key="compare"]', x => x.length), 0);
    },
  },
  {
    name: 'a plan that spends more than comes in goes below $0: a warning says when, the margin is red, negative balances are drawn',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      await typeAmount(page, '#plan-dial-essentials', '20,000');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.essentials === 2000000);
      await t.nav('overview');
      await page.waitForSelector('#plan-warn');
      const exp = await timeline(page);
      assert.ok(exp.balances.runsOut);
      assert.match((await page.textContent('#plan-warn')).replace(/\s+/g, ' '), /^Cash goes below \$0 in [A-Z][a-z]+ \d{4} on this plan\./);
      assert.ok(!!(await page.$('#plan-kpi-margin.tone-bad')), 'the margin tile is red');
      assert.match(await page.textContent('#plan-kpi-margin-value'), /^−\$/);
      const tb = await table(page);
      assert.ok(tb.rows.some(r => r[tb.col('Combined cash')].startsWith('−$')), 'negative balances are shown, not floored');
      assert.ok(await noHorizontalScroll(page));
      await t.shot('overview-below-zero');
    },
  },
  {
    name: 'no known balance: no balance line, the money panel still drawn; the first balance brings the line',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await loadWithoutBalances(page, 'no-balances.json');
      await page.evaluate(() => {
        const H = window.HouseholdBudget;
        const st = H.getState();
        st.plan.balances.accounts = {};
        st.plan.balances.accountDates = {};
        st.plan.balances.accountsAsOf = null;
        H.setState(st);
      });
      await page.waitForSelector('#plan-prompt');
      assert.equal(await page.$$eval('#plan-chart', x => x.length), 0, 'no balance line when nothing is known');
      assert.ok(await page.isVisible('#plan-flows'), 'money in and out is still drawn');
      assert.equal((await page.textContent('#plan-bal-edit > summary')).trim(), 'Enter your balances');
      assert.equal((await page.textContent('#plan-bal-joint-checking-figure')).trim(), 'Not known');
      assert.equal(await page.inputValue('#plan-bal-joint-checking-date'), '');
      assert.equal(await page.getAttribute('#plan-bal-joint-checking', 'placeholder'), 'Not entered', 'nothing known: “Not entered”');
      await page.click('#plan-prompt');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'plan-bal-joint-checking');

      await typeAmount(page, '#plan-bal-joint-checking', '12,345.67');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accounts['joint-checking'] === 1234567);
      await page.waitForSelector('#plan-chart[data-mode="balance"]');
      const exp = await timeline(page);
      const st = await state(page);
      assert.equal(st.plan.balances.accountDates['joint-checking'], exp.today, 'today’s date was written');
      assert.equal(await page.inputValue('#plan-bal-joint-checking-date'), exp.today);
      assert.equal(exp.balances.mode, 'accounts');
      assert.equal((await page.textContent('#plan-bal-joint-checking-asof')).trim(), 'as of ' + (await page.evaluate(d => window.HouseholdBudget.engine.dates.label(d), exp.today)) + ' · entered by you');
      // The anchor month: the engine's own points, as the table twin shows them.
      const chk = exp.balances.accounts.find(a => a.id === 'joint-checking').points.find(p => p.month === exp.todayMonth);
      const comb = exp.balances.combined.points.find(p => p.month === exp.todayMonth);
      assert.ok(chk.anchor, 'the anchor is in this month');
      assert.ok(Math.abs(chk.cents - 1234567) <= Math.abs(exp.plan.net), 'checking = the balance plus the pro-rated rest of the month');
      assert.equal(comb.cents, chk.cents, 'savings has no known balance: it is left out of the combined line');
      const tb = await table(page);
      const r = tb.rows.find(x => x[0] === exp.todayLabel);
      assert.equal(r[tb.col('Combined cash')], whole(comb.cents));
      assert.ok(r[tb.col('Joint checking')].startsWith(whole(chk.cents)));
      assert.match((await page.textContent('#plan-bal-total')).replace(/\s+/g, ' '), /Combined \$12,345\.67 as of/);
      // Undo takes the balance back.
      await page.click('#undoBtn');
      await page.waitForSelector('#plan-prompt');
      assert.equal((await state(page)).plan.balances.accounts['joint-checking'], undefined);
    },
  },
  {
    name: 'balances: the bank’s figure is shown with where it comes from; a different one can be entered and taken back',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const exp = await timeline(page);
      const anchor = exp.balances.accounts.find(a => a.id === 'joint-checking').anchor;
      assert.equal(anchor.source, 'bank', 'the sample supplies the checking balance');
      assert.equal(anchor.label, 'From your bank data, Sep 30, 2026');
      assert.equal((await page.textContent('#plan-bal-joint-checking-figure')).trim(), '$' + (anchor.cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }));
      assert.equal((await page.textContent('#plan-bal-joint-checking-asof')).trim(), 'as of Sep 30, 2026 · from your bank data');
      assert.ok(!/Not entered|Not known/.test(await page.textContent('#plan-bal-joint-checking-row')), 'never unknown when the data knows the balance');
      assert.equal(await page.$eval('#plan-bal-edit', d => d.open), false, 'the boxes to enter a different one are folded away');
      assert.ok(!(await page.isVisible('#plan-bal-joint-checking')));
      // Savings: entered in the sample, editable as before.
      assert.equal(await page.inputValue('#plan-bal-joint-savings'), boxText(exp.balances.accounts.find(a => a.id === 'joint-savings').anchor.cents));
      assert.equal((await page.textContent('#plan-bal-joint-savings-asof')).trim(), 'as of Sep 30, 2026 · entered by you');

      // A different balance, as of today: it is newer, so the chart uses it.
      await page.click('#plan-bal-edit > summary');
      assert.equal(await page.getAttribute('#plan-bal-joint-checking', 'placeholder'), boxText(anchor.cents), 'the bank’s figure is what an empty box means');
      assert.match(await page.textContent('#plan-bal-joint-checking-src'), /^Empty: the bank figure, /);
      await typeAmount(page, '#plan-bal-joint-checking', '50,000');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accounts['joint-checking'] === 5000000);
      await page.waitForSelector('#plan-bal-joint-checking-use-data');
      const after = await timeline(page);
      const a2 = after.balances.accounts.find(a => a.id === 'joint-checking').anchor;
      assert.equal(a2.source, 'entered');
      assert.equal(a2.cents, 5000000);
      assert.match(await page.textContent('#plan-bal-joint-checking-asof'), / · entered by you$/);
      assert.match(a2.label, /^Entered by you, /);
      assert.equal((await page.textContent('#plan-bal-joint-checking-use-data')).trim(), 'Use the bank figure');
      assert.equal(await page.inputValue('#plan-bal-joint-checking'), '50,000');
      // Back to the bank's figure: the entered amount and date are cleared.
      await page.click('#plan-bal-joint-checking-use-data');
      await page.waitForFunction(() => {
        const b = window.HouseholdBudget.getState().plan.balances;
        return b.accounts['joint-checking'] === undefined && b.accountDates['joint-checking'] === undefined;
      });
      await page.waitForFunction(() => /from your bank data/.test(document.querySelector('#plan-bal-joint-checking-asof').textContent));
      assert.equal((await page.textContent('#plan-bal-joint-checking-asof')).trim(), 'as of Sep 30, 2026 · from your bank data');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-bal-joint-checking', 'focus goes to the box');
      assert.equal((await timeline(page)).balances.accounts.find(a => a.id === 'joint-checking').anchor.cents, anchor.cents);
      assert.ok(await noHorizontalScroll(page));
    },
  },
  {
    name: 'a balance dated after the export ends: the months worked across the missing days are dotted and called assumed',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      // An export without running balances: the entered balance is the only anchor for checking.
      await loadWithoutBalances(page, 'no-running-balance.json');
      await page.waitForSelector('#plan-bal-edit');
      await page.click('#plan-bal-edit > summary');

      // The export ends Sep 30, 2026. A checking balance with exact cents, dated Oct 2, is worked
      // back across Oct 1–2, which no file covers: every month-end before it rests on those days.
      await typeAmount(page, '#plan-bal-joint-checking', '6,543.21');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accounts['joint-checking'] === 654321);
      await page.fill('#plan-bal-joint-checking-date', '2026-10-02');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accountDates['joint-checking'] === '2026-10-02');
      await page.waitForSelector('#plan-chart[data-mode="balance"]');
      await page.waitForFunction(() => /Dotted:/.test(document.querySelector('#plan-chart .cc-caption').textContent));

      const exp = await timeline(page);
      const as = exp.balances.assumed;
      assert.ok(as, 'the engine reports assumed days');
      assert.equal(as.from, '2026-10-01');
      assert.equal(as.to, '2026-10-02');
      const sep = exp.balances.combined.points.find(p => p.month === '2026-09');
      assert.equal(sep.status, 'assumed', 'September rests on Oct 1–2');
      assert.equal(sep.note, 'Assumes nothing moved between Oct 1 and Oct 2, 2026 (not in your data).');
      const caption = await page.textContent('#plan-chart .cc-caption');
      assert.ok(caption.includes('Dotted: worked back across Oct 1–2, 2026, which your export does not cover (assumes nothing moved). For exact history, enter the balance as of Sep 30, 2026 or export through today.'), caption);
      assert.ok(!caption.includes('Solid: your data through Sep 2026'), 'September is not called solid history');
      assert.ok(exp.balances.illustrative && caption.endsWith(exp.balances.illustrative), 'account lines are called illustrative');

      let tb = await table(page);
      assert.equal(row(tb, 'Sep 2026')[tb.col('Status')], 'Assumed');
      assert.ok(row(tb, 'Sep 2026')[tb.col('Note')].includes(sep.note), 'the engine’s note is in the table');
      const firstPlan = tb.rows.find(r => r[tb.col('Status')] === 'Projected');
      assert.ok(firstPlan, 'the plan months follow');
      assert.equal(firstPlan[0], exp.planLabel, 'the first plan row is ' + exp.planLabel);
      assert.equal(row(tb, 'Oct 2026')[tb.col('Status')], 'Projected');
      assert.match(await page.textContent('#plan-chart .cc-keys'), /Assumed \(days without data\)/);

      // Nothing solid (or dashed) touches an assumed September: every path through it is dotted.
      let svg = await septemberPaths(page);
      assert.ok(svg.keys.includes('combined') && svg.keys.includes('acct-joint-checking'), 'combined and checking are assumed in September: ' + svg.keys);
      const through = svg.paths.filter(p => svg.keys.includes(p.key) && p.xs.some(x => Math.abs(x - svg.x) < 0.05));
      assert.ok(through.length >= svg.keys.length, 'each assumed line passes through September');
      for (const p of through) assert.match(p.cls, /\bis-assumed\b/, p.key + ': ' + p.cls);

      // Dated the day the export ends, the same balance needs no assumption.
      await page.fill('#plan-bal-joint-checking-date', '2026-09-30');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accountDates['joint-checking'] === '2026-09-30');
      await page.waitForFunction(() => !/Dotted:/.test(document.querySelector('#plan-chart .cc-caption').textContent));
      tb = await table(page);
      assert.equal(row(tb, 'Sep 2026')[tb.col('Status')], 'Reconstructed');
      const after = await page.textContent('#plan-chart .cc-caption');
      assert.ok(!after.includes('Oct 1–2'), after);
      assert.ok(after.includes('Solid: your data through Sep 2026.'), after);
      assert.equal((await timeline(page)).balances.assumed, null);
      svg = await septemberPaths(page);
      assert.equal(svg.assumedPaths, 0, 'no dotted assumed path is left');
      assert.ok(!/Assumed \(days without data\)/.test(await page.textContent('#plan-chart .cc-keys')));
    },
  },
  {
    name: 'a later balance on top of the export’s own running balance: history stays connected, nothing is assumed',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      // The sample checking export has a running balance: September's month-end is worked
      // forward from it over covered days, so a balance dated Oct 2 only starts the plan.
      await page.click('#plan-bal-edit > summary');
      await typeAmount(page, '#plan-bal-joint-checking', '6,543.21');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accounts['joint-checking'] === 654321);
      await page.fill('#plan-bal-joint-checking-date', '2026-10-02');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accountDates['joint-checking'] === '2026-10-02');
      const exp = await timeline(page);
      assert.equal(exp.balances.assumed, null);
      assert.equal(exp.balances.combined.points.find(p => p.month === '2026-09').status, 'reconstructed');
      const tb = await table(page);
      assert.equal(row(tb, 'Sep 2026')[tb.col('Status')], 'Reconstructed');
      assert.ok(!(await page.textContent('#plan-chart .cc-caption')).includes('Dotted:'));
      assert.equal((await septemberPaths(page)).assumedPaths, 0);
    },
  },
  {
    name: 'no cash account in the data: one cash figure drives an illustrative line',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.evaluate(() => {
        const ds = JSON.parse(JSON.stringify(window.HouseholdBudget.getDataset()));
        ds.accounts = ds.accounts.filter(a => a.type !== 'savings' && a.type !== 'checking');
        const ids = new Set(ds.accounts.map(a => a.id));
        ds.transactions = ds.transactions.filter(x => ids.has(x.accountId)).map(x => ({ ...x, pairId: ids.has((ds.transactions.find(y => y.id === x.pairId) || {}).accountId) ? x.pairId : null }));
        ds.balances = (ds.balances || []).filter(b => ids.has(b.accountId));
        localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: ds, loadedAt: new Date().toISOString(), source: 'json', file: 'cards-only.json' }));
      });
      await page.reload();
      await page.waitForSelector('#plan-prompt');
      assert.deepEqual(await page.$$eval('#plan-balances .plan-bal-name', ls => ls.map(l => l.textContent.trim())), ['Cash']);
      await typeAmount(page, '#plan-bal-cash', '5,000');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.jointCashCents === 500000);
      await page.waitForSelector('#plan-chart[data-mode="balance"]');
      const exp = await timeline(page);
      assert.equal((await state(page)).plan.balances.asOf, exp.today);
      assert.equal(exp.balances.mode, 'simple');
      assert.match(await page.textContent('#plan-chart .cc-caption'), /Illustrative cash projection from the numbers you entered\.$/);
      assert.match((await page.textContent('#plan-bal-total')).replace(/\s+/g, ' '), /^Cash \$5,000\.00 as of .+ · entered by you$/);
    },
  },
  {
    name: 'Export CSV: the settings, then one row per month shown, in plain dollars',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      await typeAmount(page, '#plan-dial-flexible', '1,100.50');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.flexible === 110050);
      await t.nav('overview');
      await page.waitForSelector('#plan-export-csv');
      const exp = await timeline(page);
      const shown = (await table(page)).rows.map(r => r[0]);
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#plan-export-csv')]);
      assert.equal(download.suggestedFilename(), `plan-${exp.today}.csv`);
      const text = fs.readFileSync(await download.path(), 'utf8');
      assert.ok(text.includes('\r\n'), 'CRLF line ends');
      const lines = text.split('\r\n');
      assert.equal(lines[0], 'Settings');
      assert.equal(lines[1], 'key,value');
      assert.ok(lines.includes('plan_start,' + exp.planStart));
      assert.ok(lines.includes('dial.flexible.plan,1100.50'));
      assert.ok(lines.includes('dial.flexible.source,direct'));
      assert.ok(lines.includes('balance.joint-checking.source,bank'));
      const at = lines.indexOf('Months');
      assert.ok(at > 2 && lines[at - 1] === '', 'a blank line, then the months');
      const head = lines[at + 1].split(',');
      assert.deepEqual(head.slice(0, 17), ['month', 'status', 'in_p1', 'in_p2', 'in_other', 'in_total', 'essentials', 'flexible', 'irregular', 'other_out', 'out_total', 'to_savings', 'from_savings', 'combined_change', 'net_checking', 'combined_balance', 'combined_status']);
      // Net to investments comes last, then the investments line (the sample’s balance-only brokerage account).
      assert.deepEqual(head.slice(17), ['joint-checking_balance', 'joint-checking_status', 'joint-savings_balance', 'joint-savings_status', 'investing', 'investments_balance', 'investments_status']);
      assert.ok(lines.includes('investment.joint-brokerage.owner,joint'));
      assert.ok(lines.includes('investment.joint-brokerage.source,statement'));
      const body = lines.slice(at + 2).filter(Boolean);
      assert.equal(body.length, shown.length, 'one row per month shown');
      const monthsLabel = await page.evaluate(list => list.map(m => window.HouseholdBudget.engine.months.label(m)), body.map(l => l.split(',')[0]));
      assert.deepEqual(monthsLabel, shown);
      for (const l of body) {
        for (const cell of l.split(',').slice(2)) assert.match(cell, /^(-?\d+\.\d{2}|[a-z]*)$/, 'plain dollars or a status word: ' + l);
      }
      const plan = body.find(l => l.startsWith(exp.planStart + ',')).split(',');
      assert.equal(plan[1], 'plan');
      assert.equal(plan[head.indexOf('flexible')], '1100.50');
      const pm = exp.months.find(x => x.month === exp.planStart);
      assert.equal(plan[head.indexOf('combined_change')], (pm.combinedChange / 100).toFixed(2));
      assert.equal(plan[head.indexOf('net_checking')], (pm.net / 100).toFixed(2));
    },
  },
  {
    name: 'essentials, flexible and irregular add up to card plus bank spending in every plan month',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const exp = await timeline(page);
      const v = k => dialOf(exp, k).planCents;
      const m = exp.months.find(x => x.month === exp.planStart);
      // The month's spending groups: the dials plus what Budget adds (the sample's planned life insurance, $40 a month).
      const spend = m.out.essentials + m.out.flexible + m.out.irregular;
      const fromBudget = exp.changes.list.filter(ch => ch.source === 'bill' && ch.status === 'applied' && ch.startMonth <= exp.planStart).reduce((s, ch) => s + ch.cents, 0);
      assert.equal(spend, v('essentials') + v('flexible') + v('irregular') + fromBudget, 'the three spending dials and the bills from Budget');
      assert.equal(m.out.card + m.out.bank, spend, 'the engine: card + bank = the three spending groups');
      for (const k of ['essentials', 'flexible', 'irregular']) assert.equal(dialOf(exp, k).cardCents + dialOf(exp, k).bankCents, v(k), k + ' splits into card and bank');
      // The Overview's breakdown of the plan month shows the same groups.
      await page.goto(t.url + '#/overview?month=' + exp.planStart);
      await page.waitForSelector('#plan-month');
      const group = key => page.$eval(`#plan-month-grp-${key} > summary .ov-mline-amt`, x => x.textContent.trim());
      assert.equal(await group('essentials'), whole(m.out.essentials));
      assert.equal(await group('flexible'), whole(m.out.flexible));
      assert.equal(await group('irregular'), whole(m.out.irregular));
    },
  },
  {
    name: 'essentials dial: the exact box, the slider and the plan agree; Reset puts it back',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      await typeAmount(page, '#plan-dial-essentials', '3,456.78');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.essentials === 345678);
      assert.equal(await page.inputValue('#plan-dial-essentials'), '3,456.78');
      assert.ok(Math.abs(Number(await page.inputValue('#plan-dial-essentials-range')) - 3456.78) <= 12.5, 'slider follows (to its $25 step)');
      assert.match(await page.textContent('#plan-dial-essentials-base'), /set by you/);
      assert.equal(await page.$$eval('#plan-headline, #plan-addup', x => x.length), 0, 'no second headline under the dials');
      const exp = await timeline(page);
      assert.equal(exp.summary.outByGroup.essentials, 345678 + exp.changes.list.filter(ch => ch.status === 'applied' && ch.group === 'essentials' && ch.startMonth <= exp.planStart && (!ch.endMonth || ch.endMonth >= exp.planStart)).reduce((s, ch) => s + ch.cents, 0), 'the plan month follows the dial');

      // The slider moves in $25 steps and the box agrees.
      await typeAmount(page, '#plan-dial-essentials', '2,300');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.essentials === 230000);
      await page.waitForFunction(() => document.querySelector('#plan-dial-essentials-range').value === '2300');
      await page.focus('#plan-dial-essentials-range');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.essentials === 232500);
      await page.waitForFunction(() => document.querySelector('#plan-dial-essentials').value === '2,325');
      assert.equal(await page.inputValue('#plan-dial-essentials-range'), '2325');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-dial-essentials-range', 'focus stays on the slider');

      // Above the slider's range: kept exactly, the range grows.
      const max = Number(await page.getAttribute('#plan-dial-essentials-range', 'max'));
      await typeAmount(page, '#plan-dial-essentials', String(max + 15000) + '.55');
      const big = Math.round((max + 15000.55) * 100);
      await page.waitForFunction(v => window.HouseholdBudget.getState().ui.plan.dials.essentials === v, big);
      await page.waitForFunction(v => document.querySelector('#plan-dial-essentials').value === v, boxText(big));
      assert.ok(Number(await page.getAttribute('#plan-dial-essentials-range', 'max')) >= big / 100, 'slider range widened');
      // A negative spending amount is refused with a message; nothing changes.
      await typeAmount(page, '#plan-dial-essentials', '-50');
      await page.waitForSelector('#plan-dial-essentials-error:not([hidden])');
      assert.match(await page.textContent('#plan-dial-essentials-error'), /\$0 or more/);
      assert.equal((await state(page)).ui.plan.dials.essentials, big);
      // Back to the baseline: the baseline line goes away.
      await page.click('#plan-dial-essentials-reset');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.essentials === undefined);
      await page.waitForFunction(() => !document.querySelector('#plan-dial-essentials-reset'));
    },
  },
  {
    name: 'drill-down: a place or a category moves the flexible dial; the summary shows the dial and its baseline',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const exp = await timeline(page);
      const d = dialOf(exp, 'flexible');
      const rows = exp.flexible.rows;
      const base = d.planCents;
      const summary = () => page.textContent('#plan-drill-flexible > summary').then(x => x.trim());
      await page.click('#plan-drill-flexible > summary');
      assert.equal(await summary(), `What’s in this · ${exp.flexible.categoryCount} categories · ${amt(base)}/mo`, 'at baseline: no “baseline” beside it');
      // Every category says how it behaves and how it is paid.
      for (const cat of rows.filter(r => r.level === 1)) {
        assert.equal((await page.textContent(`#plan-row-${cat.id}-pattern`)).trim(), { bill: 'Bill', everyday: 'Everyday', occasional: 'Occasional' }[cat.pattern]);
        assert.equal((await page.textContent(`#plan-row-${cat.id}-paid`)).trim(), { card: 'card', bank: 'bank', mixed: 'both' }[cat.paidBy]);
        assert.equal(!!(await page.$(`#plan-row-${cat.id}-move`)), !!cat.groupKey, cat.label + ': a move button when it can move');
      }
      const place = rows.find(r => r.kind === 'merchant' && r.pattern === 'bill');
      assert.ok(place, 'the sample has a regular bill among flexible spending');
      await page.click(`#plan-drillrow-${place.parent} > summary`);
      await page.uncheck(`#plan-row-${place.id}-on`);
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ui.plan.rows[id] || {}).included === false, place.id);
      await page.waitForFunction(v => document.querySelector('#plan-dial-flexible').value === v, boxText(base - place.planCents));
      assert.equal(await summary(), `What’s in this · ${exp.flexible.categoryCount} categories · ${amt(base - place.planCents)}/mo · baseline ${amt(d.baselineCents)}`, 'the current value, with the baseline beside it');
      assert.ok(await page.$eval(`#plan-drillrow-${place.parent}`, x => x.open), 'the category stays open');
      assert.match(await page.textContent('#plan-dial-flexible-base'), /from the list below/);
      await page.check(`#plan-row-${place.id}-on`);
      await page.waitForFunction(id => !window.HouseholdBudget.getState().ui.plan.rows[id], place.id);
      await page.waitForFunction(v => document.querySelector('#plan-dial-flexible').value === v, boxText(base));

      // A category to $200: its budget (plan.targets, shared with Budget); the dial is the new sum, and its baseline too.
      const cat = rows.filter(r => r.level === 1 && r.groupKey).sort((a, b) => b.planCents - a.planCents)[1];
      await typeAmount(page, `#plan-row-${cat.id}-amt`, '200');
      await page.waitForFunction(k => window.HouseholdBudget.getState().plan.targets[k] === 20000, cat.groupKey);
      assert.equal((await state(page)).ui.plan.rows[cat.id], undefined, 'not a row change');
      const sum = base - cat.planCents + 20000;
      await page.waitForFunction(v => document.querySelector('#plan-dial-flexible').value === v, boxText(sum));
      assert.match(await page.textContent(`[data-row="${cat.id}"] .drill-meta`), /budget/);

      // Dragging the dial sets it directly: the summary shows that value (not the rows) and the baseline.
      await page.$eval('#plan-dial-flexible-range', el => {
        el.value = String(Number(el.value) + 500);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForFunction(() => Number.isInteger(window.HouseholdBudget.getState().ui.plan.dials.flexible));
      await page.waitForSelector('#plan-drill-flexible-use');
      const direct = (await state(page)).ui.plan.dials.flexible;
      assert.equal(await page.inputValue('#plan-dial-flexible'), boxText(direct));
      assert.equal(await summary(), `What’s in this · ${exp.flexible.categoryCount} categories · ${amt(direct)}/mo · baseline ${amt(sum)}`);
      const note = await page.textContent('#plan-drill-flexible .notice');
      assert.ok(note.includes(`Dial set directly to ${amt(direct)}; the rows add up to ${amt(sum)}.`), note);
      await page.click('#plan-drill-flexible-use');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.flexible === undefined);
      await page.waitForFunction(v => document.querySelector('#plan-dial-flexible').value === v, boxText(sum));
      assert.ok(!(await page.$('#plan-drill-flexible-use')), 'the notice is gone');
      assert.equal((await state(page)).plan.targets[cat.groupKey], 20000, 'the budget is kept');
    },
  },
  {
    name: 'drill-down: a category row’s Reset brings it back in at its budget, which stays; a place’s goes back to its average',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const exp = await timeline(page);
      const cat = exp.essentials.rows.find(r => r.level === 1 && r.groupKey === 'Groceries');
      assert.ok(cat && cat.budgetCents !== null && cat.source === 'budget', 'the sample budgets Groceries');
      await page.click('#plan-drill-essentials > summary');
      await page.uncheck(`#plan-row-${cat.id}-on`);
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ui.plan.rows[id] || {}).included === false, cat.id);
      await page.waitForSelector(`#plan-row-${cat.id}-reset`);
      assert.equal(await page.getAttribute(`#plan-row-${cat.id}-reset`, 'aria-label'), `Reset Groceries to its budget (${amt(cat.budgetCents)})`);
      await page.click(`#plan-row-${cat.id}-reset`);
      await page.waitForFunction(id => !window.HouseholdBudget.getState().ui.plan.rows[id], cat.id);
      assert.equal((await state(page)).plan.targets.Groceries, cat.budgetCents, 'the budget stays');
      assert.match(await toastText(page), new RegExp(`^Groceries is back to its budget \\(\\${amt(cat.budgetCents)}\\)\\.`));
      await page.waitForFunction(id => document.getElementById(`plan-row-${id}-on`).checked, cat.id);
      assert.equal(await page.inputValue(`#plan-row-${cat.id}-amt`), boxText(cat.planCents), 'back at its budget');
      assert.equal(await page.inputValue('#plan-dial-essentials'), boxText(dialOf(exp, 'essentials').planCents));
      // A place has no budget of its own: its Reset says it goes back to its average.
      const place = exp.essentials.rows.find(r => r.kind === 'merchant' && r.parent === cat.id);
      await page.click(`#plan-drillrow-${cat.id} > summary`);
      await page.uncheck(`#plan-row-${place.id}-on`);
      await page.waitForSelector(`#plan-row-${place.id}-reset`);
      assert.equal(await page.getAttribute(`#plan-row-${place.id}-reset`, 'aria-label'), `Reset ${place.label} to its average`);
      await page.click(`#plan-row-${place.id}-reset`);
      await page.waitForFunction(id => !window.HouseholdBudget.getState().ui.plan.rows[id], place.id);
      assert.equal((await state(page)).plan.targets.Groceries, cat.budgetCents);
    },
  },
  {
    name: 'a place moves from flexible to essentials (and back); the total stays the same',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const exp = await timeline(page);
      const ess = dialOf(exp, 'essentials').planCents, flex = dialOf(exp, 'flexible').planCents;
      // The biggest regular place inside a flexible category (a warehouse club in the sample's mixed retail).
      const parents = new Set(exp.flexible.rows.filter(r => r.level === 1 && !r.synthetic).map(r => r.id));
      const place = exp.flexible.rows.filter(r => r.kind === 'merchant' && parents.has(r.parent)).sort((a, b) => b.planCents - a.planCents)[0];
      const parent = exp.flexible.rows.find(r => r.id === place.parent);
      await page.click('#plan-drill-flexible > summary');
      await page.click(`#plan-drillrow-${place.parent} > summary`);
      assert.equal((await page.textContent(`#plan-row-${place.id}-move`)).trim(), 'Move to Essentials');
      await page.click(`#plan-row-${place.id}-move`);
      await page.waitForFunction(k => window.HouseholdBudget.getState().ui.plan.groups[k] === 'essentials', 'merchant:' + place.label);
      const after = await timeline(page);
      const ess2 = dialOf(after, 'essentials').planCents, flex2 = dialOf(after, 'flexible').planCents;
      assert.ok(near(ess2 - ess, place.planCents, 2), `essentials +${ess2 - ess}, the place is ${place.planCents}`);
      assert.ok(near(flex - flex2, place.planCents, 2), `flexible −${flex - flex2}`);
      assert.ok(near(ess2 + flex2, ess + flex, 2), 'the total stays the same');
      assert.equal(await page.inputValue('#plan-dial-essentials'), boxText(ess2));
      assert.equal(await page.inputValue('#plan-dial-flexible'), boxText(flex2));
      assert.equal(after.flexible.rows.find(r => r.id === parent.id).planCents, parent.planCents - place.planCents, 'the rest of its category stays flexible');
      // In essentials it is a row of its own, marked as moved, with a way back.
      const moved = after.essentials.rows.find(r => r.level === 1 && r.synthetic && r.label === place.label);
      assert.ok(moved, 'a row of its own in essentials');
      await page.click('#plan-drill-essentials > summary');
      assert.equal((await page.textContent(`#plan-row-${moved.id}-moved`)).trim().replace(/^i/, ''), 'moved');
      assert.match(await page.textContent(`[data-row="${moved.id}"] .drill-meta`), new RegExp('from ' + parent.label));
      assert.equal((await page.textContent(`#plan-row-${moved.id}-back`)).trim(), 'Put back');
      assert.ok(!(await page.$(`#plan-row-${moved.id}-move`)), 'a moved row offers “Put back”, not another move');
      await page.click(`#plan-row-${moved.id}-back`);
      await page.waitForFunction(k => window.HouseholdBudget.getState().ui.plan.groups[k] === undefined, 'merchant:' + place.label);
      await page.waitForFunction(v => document.querySelector('#plan-dial-essentials').value === v, boxText(ess));
      assert.equal(await page.inputValue('#plan-dial-flexible'), boxText(flex));
      // A whole category moves too, and Undo brings it back.
      const cat = exp.flexible.rows.find(r => r.level === 1 && r.groupKey && !r.synthetic);
      await page.click(`#plan-row-${cat.id}-move`);
      await page.waitForFunction(k => window.HouseholdBudget.getState().ui.plan.groups[k] === 'essentials', cat.groupKey);
      const moved2 = (await timeline(page)).essentials.rows.find(r => r.level === 1 && r.label === cat.label);
      assert.equal(moved2.groupSource, 'override');
      await page.waitForSelector(`#plan-row-${moved2.id}-moved`);
      await page.click('#undoBtn');
      await page.waitForFunction(k => window.HouseholdBudget.getState().ui.plan.groups[k] === undefined, cat.groupKey);
    },
  },
  {
    name: 'irregular costs: leaving one out lowers the dial by its monthly share; “Count as regular” moves it into its category',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const exp = await timeline(page);
      const irr = exp.irregular;
      assert.ok(irr.count >= 1, 'the sample has one-time costs');
      const item = irr.rows.slice().sort((a, b) => b.cents - a.cents)[0];
      const n = exp.count;
      const d = dialOf(exp, 'irregular');
      const summary = () => page.textContent('#plan-drill-irregular > summary').then(x => x.trim());
      await page.click('#plan-drill-irregular > summary');
      assert.equal(await summary(), `What’s in this · ${irr.count} item${irr.count === 1 ? '' : 's'} · ${amt(irr.includedCents)} over ${n} months → ${amt(irr.rowsCents)}/mo`);
      assert.equal((await page.textContent(`#plan-irr-${item.id}-monthly`)).trim(), amt(item.monthlyCents) + '/mo');
      assert.ok((await page.textContent(`label[for="plan-irr-${item.id}-on"]`)).includes(item.label));
      assert.equal(await page.isChecked(`#plan-irr-${item.id}-on`), true, 'in the allowance');
      // Left out: the dial drops by the cost ÷ the months.
      await page.uncheck(`#plan-irr-${item.id}-on`);
      await page.waitForFunction(id => window.HouseholdBudget.getState().ui.plan.irregularOff[id] === true, item.id);
      const out = await timeline(page);
      const d2 = dialOf(out, 'irregular');
      assert.ok(near(d.planCents - d2.planCents, item.monthlyCents, 1), `irregular −${d.planCents - d2.planCents}, expected ${item.monthlyCents}`);
      await page.waitForFunction(v => document.querySelector('#plan-dial-irregular').value === v, boxText(d2.planCents));
      assert.match(await summary(), /; 1 left out by you · baseline /);
      assert.match(await page.textContent('#plan-dial-irregular-base'), /from the list below/);
      await page.check(`#plan-irr-${item.id}-on`);
      await page.waitForFunction(id => !window.HouseholdBudget.getState().ui.plan.irregularOff[id], item.id);
      await page.waitForFunction(v => document.querySelector('#plan-dial-irregular').value === v, boxText(d.planCents));

      // Count as regular: gone from this list, and its category in essentials or flexible grows.
      const groupOf = tl => ['essentials', 'flexible'].find(g => tl[g].rows.some(r => r.level === 1 && r.label === item.category));
      const g = groupOf(exp);
      assert.ok(g, item.category + ' is a category of essentials or flexible spending');
      const catBefore = exp[g].rows.find(r => r.level === 1 && r.label === item.category).planCents;
      await page.click(`#plan-irr-${item.id}-regular`);
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).planningBaseline === 'include', item.id);
      await page.waitForFunction(id => !document.getElementById(`plan-irr-${id}-on`), item.id);
      const reg = await timeline(page);
      assert.equal(reg.irregular.count, irr.count - 1);
      assert.ok(near(dialOf(reg, 'irregular').planCents, d.planCents - item.monthlyCents, 1), 'the irregular dial loses it');
      const catAfter = reg[g].rows.find(r => r.level === 1 && r.label === item.category).planCents;
      assert.ok(catAfter > catBefore, `${item.category} grows (${catBefore} → ${catAfter})`);
      assert.ok(near(dialOf(reg, g).planCents - dialOf(exp, g).planCents, catAfter - catBefore, 1), 'its dial grows by as much');
      assert.ok(reg.keptIn.some(o => o.id === item.id), 'listed as counted as regular');
      assert.ok(await page.$eval('#plan-drill-irregular', x => x.open), 'the list stays open');
      // And back to one-time.
      await page.click(`#plan-irr-${item.id}-onetime`);
      await page.waitForFunction(id => !(window.HouseholdBudget.getState().ledgerEdits[id] || {}).planningBaseline, item.id);
      await page.waitForSelector(`#plan-irr-${item.id}-on`);
      assert.equal((await timeline(page)).irregular.count, irr.count);
    },
  },
  {
    name: 'irregular costs: one left out of planning in Transactions or Spending is unticked with a note; ticking it puts it back on purpose',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const exp = await timeline(page);
      const item = exp.irregular.rows.slice().sort((a, b) => b.cents - a.cents)[0];
      const d = dialOf(exp, 'irregular');
      const meta = () => page.textContent(`#plan-irr-${item.id}-meta`).then(x => x.trim());
      const irregularOff = () => page.evaluate(() => window.HouseholdBudget.getState().ui.plan.irregularOff);
      // "Leave out of planning" (the ledger edit the Spending and Transactions buttons write).
      await page.evaluate(id => {
        const H = window.HouseholdBudget, st = H.getState();
        st.ledgerEdits[id] = H.engine.review.editRecord(st.ledgerEdits[id], 'planningBaseline', 'exclude', 'Not expected again', new Date().toISOString());
        H.setState(st);
      }, item.id);
      await t.settled();
      const out = await timeline(page);
      const d2 = dialOf(out, 'irregular');
      assert.ok(near(d.planCents - d2.planCents, item.monthlyCents, 1), `irregular −${d.planCents - d2.planCents}, expected ${item.monthlyCents}`);
      assert.equal(d2.source, 'baseline', 'the Plan itself is not changed');
      assert.deepEqual(await irregularOff(), {}, 'nothing written to the Plan’s choices');
      await page.waitForFunction(v => document.querySelector('#plan-dial-irregular').value === v, boxText(d2.planCents));
      await page.click('#plan-drill-irregular > summary');
      assert.equal(await page.isChecked(`#plan-irr-${item.id}-on`), false, 'unticked by default');
      assert.match(await meta(), /^left out of planning in Transactions or Spending/);
      // Ticked: in the allowance on purpose (stored as false); the ledger edit stays.
      await page.check(`#plan-irr-${item.id}-on`);
      await page.waitForFunction(id => window.HouseholdBudget.getState().ui.plan.irregularOff[id] === false, item.id);
      await page.waitForFunction(v => document.querySelector('#plan-dial-irregular').value === v, boxText(d.planCents));
      assert.equal(await page.evaluate(id => window.HouseholdBudget.getState().ledgerEdits[id].planningBaseline, item.id), 'exclude');
      assert.match(await meta(), /^put back in here; left out of planning in Transactions or Spending/);
      // Unticked again: back to its default, nothing kept.
      await page.uncheck(`#plan-irr-${item.id}-on`);
      await page.waitForFunction(id => !Object.prototype.hasOwnProperty.call(window.HouseholdBudget.getState().ui.plan.irregularOff, id), item.id);
      await page.waitForFunction(v => document.querySelector('#plan-dial-irregular').value === v, boxText(d2.planCents));
      assert.match(await meta(), /^left out of planning in Transactions or Spending/);
    },
  },
  {
    name: 'a place’s transactions: hidden until asked for, newest first with the bank’s text, account and amount, each with its category; “Show all” draws the rest',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const exp = await timeline(page);
      const kroger = exp.essentials.rows.find(r => r.kind === 'merchant' && r.label === 'Kroger');
      assert.ok(kroger && kroger.txnIds.length > 25, 'the sample’s grocer has more than a page of purchases');
      assert.equal(kroger.txnIds.length, kroger.txnCount);
      const list = `[id="plan-txns-${kroger.id}"]`;
      // Calm: nothing new is visible until the row's own list is opened, and nothing is drawn before.
      assert.equal(await page.isVisible(list), false);
      await page.click('#plan-drill-essentials > summary');
      await page.click(`#plan-drillrow-${kroger.parent} > summary`);
      assert.equal(await page.isVisible(list), true);
      assert.equal((await page.textContent(`${list} > summary`)).trim(), `Show ${kroger.txnIds.length} transactions`);
      assert.equal(await page.$$eval(`${list} .plan-tx`, x => x.length), 0, 'no lines drawn while closed');
      await page.click(`${list} > summary`);
      await page.waitForSelector(`${list} .plan-tx`);
      const lines = await txnLines(page, kroger.id);
      assert.equal(lines.length, 25, 'the first 25');
      assert.deepEqual(lines.map(l => l.id), kroger.txnIds.slice(0, 25), 'newest first');
      const txns = await txnsOf(page, kroger.txnIds);
      for (let i = 1; i < txns.length; i++) assert.ok(txns[i - 1].date >= txns[i].date, 'dates go back in time');
      lines.forEach((l, i) => {
        const x = txns[i];
        assert.equal(l.date, shortDate(x.date));
        assert.equal(l.desc, x.description, 'the bank’s own text');
        assert.equal(l.title, x.description, 'in full in the title');
        assert.equal(l.amount, money(-x.amountCents));
        assert.equal(l.account, x.accountLabel);
        assert.equal(l.category, x.category, 'the select shows its category');
        assert.equal(l.href, `#/spending?period=${x.date.slice(0, 7)}&txn=${x.id}`, 'Details opens the transaction');
      });
      // The choices are the Transactions view's, grouped as the taxonomy groups them.
      const first = `#plan-txcat-${lines[0].id}`;
      const groups = await page.$$eval(`${first} optgroup`, gs => gs.map(g => g.label));
      assert.deepEqual(groups.slice(0, 4), ['Housing', 'Utilities', 'Food', 'Shopping']);
      assert.deepEqual(await page.$$eval(`${first} optgroup[label="Food"] option`, os => os.map(o => o.value)), ['Groceries', 'Dining & takeout']);
      assert.equal(await page.getAttribute(first, 'data-action'), 'plan:txn-category');
      assert.match(await page.textContent(`label[for="plan-txcat-${lines[0].id}"]`), new RegExp('^Category of ' + txns[0].description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ', '));
      // Show all: the rest drawn in place, focus on the first new line.
      assert.equal((await page.textContent(`#plan-txns-${kroger.id}-all`)).trim(), `Show all ${kroger.txnIds.length}`);
      await page.click(`#plan-txns-${kroger.id}-all`);
      await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel + ' .plan-tx').length === n, [list, kroger.txnIds.length]);
      assert.deepEqual((await txnLines(page, kroger.id)).map(l => l.id), kroger.txnIds);
      assert.ok(!(await page.$(`#plan-txns-${kroger.id}-all`)), 'no “Show all” once everything is shown');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-txcat-' + kroger.txnIds[25]);
      // Nothing was saved for any of this.
      assert.deepEqual((await state(page)).ledgerEdits, {});
      // A category whose only row is “Everything in …” lists its transactions under the category itself.
      const solo = exp.essentials.rows.find(r => r.level === 1 && exp.essentials.rows.filter(k => k.parent === r.id).every(k => k.kind === 'rest'));
      assert.ok(solo, 'the sample has a category with no regular place');
      assert.equal((await page.textContent(`[id="plan-txns-${solo.id}"] > summary`)).trim(), `Show ${solo.txnIds.length} transaction${solo.txnIds.length === 1 ? '' : 's'}`);
    },
  },
  {
    name: 'one transaction to another category: a ledger edit with a message; its row drops by its share, the new category’s row rises; Undo puts it back',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      // A category with a budget plans at its budget; these follow their history.
      await withoutBudgets(t, ['Groceries', 'Household & hardware']);
      const exp = await timeline(page);
      const kroger = exp.essentials.rows.find(r => r.kind === 'merchant' && r.label === 'Kroger');
      const [txn] = await txnsOf(page, kroger.txnIds.slice(0, 1));
      const share = -txn.amountCents / exp.count;
      const hh = exp.flexible.rows.find(r => r.level === 1 && r.label === 'Household & hardware');
      const ess = dialOf(exp, 'essentials').planCents, flex = dialOf(exp, 'flexible').planCents;
      await page.click('#plan-drill-essentials > summary');
      await page.click(`#plan-drillrow-${kroger.parent} > summary`);
      await page.click(`[id="plan-txns-${kroger.id}"] > summary`);
      await page.waitForSelector(`#plan-txcat-${txn.id}`);
      await page.focus(`#plan-txcat-${txn.id}`); // as a click or the keyboard would
      await page.selectOption(`#plan-txcat-${txn.id}`, 'Household & hardware');
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).category === 'Household & hardware', txn.id);
      const edit = (await state(page)).ledgerEdits[txn.id];
      assert.equal(edit.categoryReason, 'Set on the Plan page');
      assert.deepEqual(edit.history.map(h => [h.field, h.to, h.reason]), [['category', 'Household & hardware', 'Set on the Plan page']]);
      assert.match(await toastText(page), /^Kroger: now Household & hardware\./);
      const after = await timeline(page);
      const kroger2 = after.essentials.rows.find(r => r.id === kroger.id);
      assert.ok(near(kroger.planCents - kroger2.planCents, share, 1), `Kroger −${kroger.planCents - kroger2.planCents}, its share ${share}`);
      assert.ok(!kroger2.txnIds.includes(txn.id), 'no longer behind the Kroger row');
      await page.waitForFunction(([id, v]) => document.getElementById(id).value === v, [`plan-row-${kroger.id}-amt`, boxText(kroger2.planCents)]);
      const hh2 = after.flexible.rows.find(r => r.level === 1 && r.label === 'Household & hardware');
      assert.ok(near(hh2.planCents - hh.planCents, share, 1), `Household & hardware +${hh2.planCents - hh.planCents}`);
      assert.ok(hh2.txnIds.includes(txn.id), 'now behind Household & hardware');
      assert.ok(after.flexible.rows.some(r => r.parent === hh2.id && r.label === 'Kroger' && r.txnIds.includes(txn.id)), 'as a Kroger row there');
      assert.ok(near(ess - dialOf(after, 'essentials').planCents, share, 1) && near(dialOf(after, 'flexible').planCents - flex, share, 1), 'the dials follow');
      // The list stays open without it; focus moves to the next line.
      assert.ok(await page.$eval(`[id="plan-txns-${kroger.id}"]`, d => d.open), 'the list stays open');
      assert.ok(!(await page.$(`#plan-txcat-${txn.id}`)), 'the line left this list');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-txcat-' + kroger.txnIds[1]);
      // Undo from the toast: back where it was, with no edit left.
      await page.click('#toast button[data-action="undo"]');
      await page.waitForFunction(id => !window.HouseholdBudget.getState().ledgerEdits[id], txn.id);
      await page.waitForSelector(`#plan-txcat-${txn.id}`);
      assert.equal(await page.inputValue(`#plan-txcat-${txn.id}`), 'Groceries');
      assert.equal(await page.inputValue(`#plan-row-${kroger.id}-amt`), boxText(kroger.planCents));
      assert.equal(dialOf(await timeline(page), 'essentials').planCents, ess);
    },
  },
  {
    name: 'keyboard: arrow keys on a closed category list wait for Enter or leaving it; Escape takes the change back',
    async run(t) {
      const { page, assert } = t;
      // On macOS an arrow key opens the list instead of changing it: nothing waits there.
      if (t.isMac) return;
      await t.open('#/budget');
      const exp = await timeline(page);
      const kroger = exp.essentials.rows.find(r => r.kind === 'merchant' && r.label === 'Kroger');
      const [a, b] = kroger.txnIds;
      await page.click('#plan-drill-essentials > summary');
      await page.click(`#plan-drillrow-${kroger.parent} > summary`);
      await page.click(`[id="plan-txns-${kroger.id}"] > summary`);
      await page.waitForSelector(`#plan-txcat-${a}`);
      const options = await page.$$eval(`#plan-txcat-${a} option`, os => os.map(o => o.value));
      const after = options[options.indexOf('Groceries') + 1];
      const before = options[options.indexOf('Groceries') - 1];
      await page.focus(`#plan-txcat-${a}`);
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.inputValue(`#plan-txcat-${a}`), after, 'the list shows the next category');
      await t.settled();
      assert.deepEqual((await state(page)).ledgerEdits, {}, 'nothing saved on an arrow key');
      await page.keyboard.press('Escape');
      assert.equal(await page.inputValue(`#plan-txcat-${a}`), 'Groceries', 'Escape takes it back');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForFunction(([id, c]) => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).category === c, [a, after]);
      assert.match(await toastText(page), new RegExp(`^Kroger: now ${after}\\.`));
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'plan-txcat-' + id, b);
      // Leaving the list applies it too; the line (and the Details link tabbed to) moves away, so the next line takes focus.
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.inputValue(`#plan-txcat-${b}`), before);
      await page.keyboard.press('Tab');
      await page.waitForFunction(([id, c]) => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).category === c, [b, before]);
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === 'plan-txcat-' + id, kroger.txnIds[2]);
      assert.equal(Object.keys((await state(page)).ledgerEdits).length, 2, 'one edit per transaction changed');
      // Leaving for a control elsewhere keeps focus there.
      const c = kroger.txnIds[2];
      await page.keyboard.press('ArrowDown');
      await page.focus(`#plan-row-${kroger.id}-amt`);
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).category, c);
      await t.settled();
      assert.equal(await page.evaluate(() => document.activeElement.id), `plan-row-${kroger.id}-amt`);
    },
  },
  {
    name: 'every transaction from a place to one category: one undoable change over the whole data; the place moves to that category, the dials follow; kept after a reload',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      // A category with a budget plans at its budget; these follow their history.
      await withoutBudgets(t, ['Groceries', 'Household & hardware', 'Mixed retail']);
      const exp = await timeline(page);
      const ess = dialOf(exp, 'essentials').planCents, flex = dialOf(exp, 'flexible').planCents;
      // Same group (both flexible): the total does not move.
      const target = exp.flexible.rows.find(r => r.kind === 'merchant' && r.label === 'Target');
      const all = await placeTxns(page, 'Target');
      assert.ok(all.length > target.txnIds.length, `the whole data (${all.length}), not only the baseline months (${target.txnIds.length})`);
      assert.deepEqual([...new Set(all.map(x => x.category))], ['Mixed retail']);
      await page.click('#plan-drill-flexible > summary');
      await page.click(`#plan-drillrow-${target.parent} > summary`);
      const bulk = `#plan-row-${target.id}-cat`;
      assert.equal((await page.textContent(`label[for="plan-row-${target.id}-cat"]`)).trim(), `All ${all.length} from this place →`);
      assert.equal(await page.inputValue(bulk), 'Mixed retail', 'preselected: they share one category');
      assert.equal(await page.getAttribute(bulk, 'title'), `Applies to all ${all.length} transactions from this place in your data, in every month (not only the baseline); transactions you import later are not changed.`);
      assert.ok(await page.$eval(`#plan-row-${target.id}-move`, (b, sel) => b.parentElement.contains(document.querySelector(sel)), bulk), 'next to Move to …');
      // No bulk choice on an “Everything else” row: it holds many places.
      const rest = exp.flexible.rows.find(r => r.kind === 'rest' && r.parent && exp.flexible.rows.some(k => k.parent === r.parent && k.kind === 'merchant'));
      assert.ok(rest && !(await page.$(`#plan-row-${rest.id}-cat`)), 'no bulk select on ' + (rest && rest.label));
      await page.focus(bulk);
      await page.selectOption(bulk, 'Household & hardware');
      await page.waitForFunction(ids => ids.every(id => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).category === 'Household & hardware'), all.map(x => x.id));
      assert.match(await toastText(page), new RegExp(`^Target: ${all.length} transactions now Household & hardware\\.`));
      const after = await timeline(page);
      assert.equal(dialOf(after, 'flexible').planCents, flex, 'flexible unchanged: both categories are flexible');
      assert.equal(dialOf(after, 'essentials').planCents, ess);
      const moved = after.flexible.rows.find(r => r.kind === 'merchant' && r.label === 'Target');
      const hh = after.flexible.rows.find(r => r.id === moved.parent);
      assert.equal(hh.label, 'Household & hardware', 'Target is under its new category');
      assert.equal(moved.planCents, target.planCents);
      assert.ok(!after.flexible.rows.some(r => r.label === 'Mixed retail' && after.flexible.rows.some(k => k.parent === r.id && k.label === 'Target')));
      // The page follows it there: its new category is open and its control has focus.
      await page.waitForFunction(id => document.activeElement && document.activeElement.id === id, `plan-row-${moved.id}-cat`);
      assert.ok(await page.$eval(`#plan-drillrow-${hh.id}`, d => d.open), 'its new category is open');
      assert.equal(await page.inputValue(`#plan-row-${moved.id}-cat`), 'Household & hardware');
      // One Undo takes back every one of them.
      await page.click('#undoBtn');
      await page.waitForFunction(ids => ids.every(id => !window.HouseholdBudget.getState().ledgerEdits[id]), all.map(x => x.id));
      assert.equal((await timeline(page)).flexible.rows.find(r => r.label === 'Target').parent, target.parent);

      // Another group: Costco to Groceries moves its amount from flexible to essentials.
      const costco = exp.flexible.rows.find(r => r.kind === 'merchant' && r.label === 'Costco');
      const costcoAll = await placeTxns(page, 'Costco');
      await page.waitForSelector(`#plan-row-${costco.id}-cat`, { state: 'attached' });
      if (!(await page.isVisible(`#plan-row-${costco.id}-cat`))) await page.click(`#plan-drillrow-${costco.parent} > summary`);
      await page.selectOption(`#plan-row-${costco.id}-cat`, 'Groceries');
      await page.waitForFunction(ids => ids.every(id => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).category === 'Groceries'), costcoAll.map(x => x.id));
      const shifted = await timeline(page);
      assert.equal(flex - dialOf(shifted, 'flexible').planCents, costco.planCents, 'flexible loses Costco');
      assert.equal(dialOf(shifted, 'essentials').planCents - ess, costco.planCents, 'essentials gains it');
      const inGroceries = shifted.essentials.rows.find(r => r.kind === 'merchant' && r.label === 'Costco');
      assert.equal(shifted.essentials.rows.find(r => r.id === inGroceries.parent).label, 'Groceries');
      assert.ok(await page.$eval('#plan-drill-essentials', d => d.open), 'the essentials list opens to show it');
      await page.waitForFunction(v => document.querySelector('#plan-dial-essentials').value === v, boxText(ess + costco.planCents));
      // Kept after a reload.
      await page.reload();
      await page.waitForSelector('#plan-dials');
      const reloaded = await timeline(page);
      assert.equal(reloaded.essentials.rows.find(r => r.id === inGroceries.id).planCents, costco.planCents);
      assert.equal(await page.inputValue('#plan-dial-essentials'), boxText(ess + costco.planCents));
      assert.equal((await state(page)).ledgerEdits[costcoAll[0].id].category, 'Groceries');
    },
  },
  {
    name: 'an irregular cost: “Show transaction” lists it with its category, which can be changed; it stays a one-time cost',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const exp = await timeline(page);
      const item = exp.irregular.rows[0];
      assert.deepEqual(item.txnIds, [item.id]);
      await page.click('#plan-drill-irregular > summary');
      const list = `[id="plan-txns-${item.id}"]`;
      assert.equal((await page.textContent(`${list} > summary`)).trim(), 'Show transaction');
      assert.ok(!!(await page.$(`#plan-irr-${item.id}-regular`)), '“Count as regular” stays');
      await page.click(`${list} > summary`);
      await page.waitForSelector(`#plan-txcat-${item.id}`);
      const [line] = await txnLines(page, item.id);
      const [txn] = await txnsOf(page, [item.id]);
      assert.deepEqual([line.desc, line.amount, line.account, line.category], [txn.description, money(-txn.amountCents), txn.accountLabel, item.category]);
      const to = item.category === 'Medical & pharmacy' ? 'Dental' : 'Medical & pharmacy';
      await page.selectOption(`#plan-txcat-${item.id}`, to);
      await page.waitForFunction(([id, c]) => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).category === c, [item.id, to]);
      assert.match(await toastText(page), new RegExp(`^${item.label}: now ${to}\\.`));
      await page.waitForFunction(([id, c]) => document.getElementById(`plan-irr-${id}-meta`).textContent.includes(c), [item.id, to]);
      const after = await timeline(page);
      assert.equal(after.irregular.count, exp.irregular.count, 'still a one-time cost');
      assert.equal(after.irregular.rows.find(r => r.id === item.id).category, to);
      assert.equal(dialOf(after, 'irregular').planCents, dialOf(exp, 'irregular').planCents, 'the irregular dial is unchanged');
      assert.equal(await page.inputValue(`#plan-txcat-${item.id}`), to);
      assert.equal(await page.evaluate(() => document.activeElement.id), `plan-txcat-${item.id}`, 'focus stays on the select');
    },
  },
  {
    name: 'phone: a row’s transactions fit without sideways scroll, every control in them at least 40px',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const exp = await timeline(page);
      const amazon = exp.flexible.rows.find(r => r.kind === 'merchant' && r.label === 'Amazon');
      const item = exp.irregular.rows[0];
      await page.evaluate(([parent]) => {
        for (const id of ['plan-drill-flexible', 'plan-drill-irregular', 'plan-drillrow-' + parent]) document.getElementById(id).open = true;
      }, [amazon.parent]);
      await page.click(`[id="plan-txns-${amazon.id}"] > summary`);
      await page.click(`[id="plan-txns-${item.id}"] > summary`);
      await page.waitForSelector(`#plan-txcat-${item.id}`);
      await page.click(`#plan-txns-${amazon.id}-all`);
      await page.waitForFunction(([id, n]) => document.querySelectorAll(`[id="plan-txns-${id}"] .plan-tx`).length === n, [amazon.id, amazon.txnIds.length]);
      assert.ok(await noHorizontalScroll(page), 'no sideways scroll with the lists open');
      const small = await page.$$eval('.plan-txns > summary, .plan-txns select, .plan-txns a, .plan-txns button, .plan-bulkcat select', els => els
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => ({ what: (el.id || el.textContent.trim()).slice(0, 40), h: Math.round(el.getBoundingClientRect().height) }))
        .filter(x => x.h < 40));
      assert.deepEqual(small, [], 'tap targets under 40px');
      // Long bank text is cut short on the line (the whole of it is in the title), never wrapped wide.
      const desc = await page.$eval(`[id="plan-txns-${amazon.id}"] .plan-tx-desc`, el => ({ w: el.getBoundingClientRect().right, vw: innerWidth, overflow: getComputedStyle(el).textOverflow }));
      assert.ok(desc.w <= desc.vw, 'inside the screen');
      assert.equal(desc.overflow, 'ellipsis');
      await t.shot('plan-phone-transactions');
    },
  },
  {
    name: 'reset all puts every dial back to its baseline, and Undo brings the values back',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      assert.ok(!(await page.$('#plan-reset')), 'nothing to reset yet');
      await typeAmount(page, '#plan-dial-flexible', '3,000');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.flexible === 300000);
      await typeAmount(page, '#plan-dial-savings', '−1,236.48');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.savings === -123648);
      await page.waitForFunction(() => document.querySelector('#plan-dial-savings').value === '-1,236.48');
      await page.click('#plan-reset');
      await page.waitForFunction(() => Object.keys(window.HouseholdBudget.getState().ui.plan.dials).length === 0);
      await page.waitForFunction(() => !document.querySelector('#plan-reset'));
      const exp = await timeline(page);
      for (const d of exp.dials) {
        assert.equal(d.source, 'baseline');
        assert.equal(await page.inputValue('#plan-dial-' + d.key), boxText(d.baselineCents), d.key + ' shows its baseline');
      }
      await page.click('#undoBtn');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.savings === -123648);
      await page.waitForFunction(() => document.querySelector('#plan-dial-savings').value === '-1,236.48');
      assert.equal((await state(page)).ui.plan.dials.flexible, 300000);
      assert.equal(await page.inputValue('#plan-dial-flexible'), '3,000');
    },
  },
  {
    name: 'a dial and the months ahead survive a reload',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      await typeAmount(page, '#plan-dial-flexible', '1,234.56');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.flexible === 123456);
      await t.nav('overview');
      await page.waitForSelector('#plan-chart');
      await page.click('label[for^="plan-horizon-60"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.horizon === 60);
      await page.reload();
      await page.waitForSelector('#plan-chart');
      assert.ok(await page.isChecked('input[name="plan-horizon"][value="60"]'));
      await t.nav('budget');
      await page.waitForSelector('#plan-dial-flexible');
      assert.equal(await page.inputValue('#plan-dial-flexible'), '1,234.56');
    },
  },
  {
    name: 'a row change saved under the earlier card dial is carried over to the same row, once, with a note',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const exp = await timeline(page);
      const place = exp.flexible.rows.find(r => r.kind === 'merchant' && r.paidBy === 'card' && r.pattern === 'bill');
      const legacy = 'card' + place.id.slice('flexible'.length);
      await page.evaluate(id => {
        const H = window.HouseholdBudget;
        const st = H.getState();
        st.ui.plan.rows = { [id]: { included: false } };
        H.setState(st);
      }, legacy);
      await page.waitForFunction(([from, to]) => {
        const rows = window.HouseholdBudget.getState().ui.plan.rows;
        return !rows[from] && rows[to] && rows[to].included === false;
      }, [legacy, place.id]);
      assert.match(await page.textContent('#toast'), /^spending is now planned as essentials, flexible and irregular\. 1 change to card and bank spending rows now apply to the same rows there\./);
      assert.ok((await state(page)).meta.migrationNotes.some(n => /now apply to the same rows/.test(n)), 'noted in the budget');
      await page.waitForFunction(v => document.querySelector('#plan-dial-flexible').value === v, boxText(dialOf(exp, 'flexible').planCents - place.planCents));
    },
  },
  {
    name: 'card spending set under the earlier card dial is carried over to the three spending dials, once, with a note',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const spend = ['essentials', 'flexible', 'irregular'];
      const before = await timeline(page);
      assert.ok(spend.every(k => dialOf(before, k).source === 'baseline'));
      const bankBase = spend.reduce((s, k) => s + dialOf(before, k).bankCents, 0);
      await page.evaluate(() => {
        const H = window.HouseholdBudget;
        const st = H.getState();
        st.ui.plan.dials = Object.assign({}, st.ui.plan.dials, { card: 420000 });
        H.setState(st);
      });
      await page.waitForFunction(keys => {
        const p = window.HouseholdBudget.getState().ui.plan;
        return p.dials.card === undefined && !p.legacyDials && keys.every(k => Number.isInteger(p.dials[k]));
      }, spend);
      const note = 'Your earlier card spending setting of $4,200.00 was carried over by scaling the card part of Essentials, Flexible and Irregular (they now add up to it); adjust them individually from here.';
      assert.equal((await page.textContent('#toast')).trim(), note);
      assert.ok((await state(page)).meta.migrationNotes.includes(note), 'noted in the budget');
      const exp = await timeline(page);
      assert.equal(exp.changed, true);
      for (const k of spend) {
        assert.equal(dialOf(exp, k).source, 'direct', k);
        assert.match((await page.textContent(`#plan-dial-${k}-base`)).trim(), / · set by you$/, k + ' shows it was set');
        await page.waitForFunction(([id, v]) => document.getElementById(id).value === v, [`plan-dial-${k}`, boxText(dialOf(exp, k).planCents)]);
      }
      assert.equal(spend.reduce((s, k) => s + dialOf(exp, k).cardCents, 0), 420000, 'the card parts add up to the amount set');
      assert.equal(spend.reduce((s, k) => s + dialOf(exp, k).planCents, 0), 420000 + bankBase, 'the bank parts stay at their baseline');
      assert.equal(exp.plan.out.card, 420000);
      // Explained on each dial and once under the headline, until kept or changed.
      const basisNote = 'Carried over from your earlier card spending setting of $4,200.00 (card parts of Essentials, Flexible and Irregular add up to it).';
      const summary = 'Three dials carry your earlier card spending setting of $4,200.00 — review them, then Keep or Reset.';
      const basisOf = k => page.textContent(`#plan-dial-${k}-basis`).then(x => x.replace(/\s+/g, ' ').trim());
      for (const k of spend) assert.equal(await basisOf(k), basisNote + ' Keep', k);
      assert.equal((await page.textContent('#plan-carried')).trim(), summary);
      // Once: nothing is left to carry over, and the explanation is still there after a reload.
      await page.reload();
      await page.waitForSelector('#plan-root');
      const again = await timeline(page);
      assert.deepEqual(spend.map(k => dialOf(again, k).planCents), spend.map(k => dialOf(exp, k).planCents));
      assert.equal((await state(page)).meta.migrationNotes.filter(n => n === note).length, 1);
      for (const k of spend) assert.equal(await basisOf(k), basisNote + ' Keep', k + ' after a reload');
      assert.equal((await page.textContent('#plan-carried')).trim(), summary);
      // Keep: the note goes, the amount stays.
      await page.click('#plan-dial-flexible-keep');
      await page.waitForFunction(() => !('fromCard' in (window.HouseholdBudget.getState().ui.plan.cardSplit.flexible || {})));
      await page.waitForFunction(() => !document.getElementById('plan-dial-flexible-keep'));
      assert.doesNotMatch(await basisOf('flexible'), /Carried over/);
      assert.equal((await state(page)).ui.plan.dials.flexible, dialOf(exp, 'flexible').planCents);
      assert.match((await page.textContent('#toast')).trim(), /^Flexible spending kept at \$/);
      assert.equal((await page.textContent('#plan-carried')).trim(), summary.replace('Three dials carry', 'Two dials carry'));
      // Reset: back to the baseline, no note.
      await page.click('#plan-dial-essentials-reset');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.essentials === undefined);
      const reset = await timeline(page);
      assert.deepEqual([dialOf(reset, 'essentials').source, dialOf(reset, 'essentials').planCents], ['baseline', dialOf(before, 'essentials').planCents]);
      await page.waitForFunction(v => document.querySelector('#plan-dial-essentials').value === v, boxText(dialOf(before, 'essentials').planCents));
      assert.doesNotMatch(await basisOf('essentials'), /Carried over/);
      assert.equal((await page.textContent('#plan-carried')).trim(), 'One dial carries your earlier card spending setting of $4,200.00 — review it, then Keep or Reset.');
      assert.equal(await basisOf('irregular'), 'Carried over from your earlier card spending setting of $4,200.00. Keep', 'the total is no longer claimed once a dial moved');
    },
  },
  {
    name: 'money in starts from the pay saved in Edit plan; without it the average is marked not confirmed',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      for (const key of ['p1', 'p2']) {
        assert.equal((await page.textContent(`#plan-dial-${key}-basis`)).trim(), 'From your pay · Change', 'one short line');
        assert.match(await page.textContent(`#plan-dial-${key}-why`), /^From Budget: .+/, 'the whole basis behind ⓘ');
        assert.equal(await page.getAttribute(`#plan-dial-${key}-budget`, 'href'), '#/budget?section=income');
        assert.ok(!(await page.$(`#plan-dial-${key}-unconfirmed`)), 'no "Not confirmed" badge with pay in Budget');
      }
      assert.ok(!(await page.$('#plan-dial-inOther-unconfirmed')));
      // Sam's contribution stream removed: only a paycheck with no amount is left in Budget.
      await page.evaluate(() => {
        const H = window.HouseholdBudget;
        const st = H.getState();
        st.plan.incomes = st.plan.incomes.filter(i => i.id !== 'p2-contribution');
        H.setState(st);
      });
      await page.waitForSelector('#plan-dial-p2-unconfirmed');
      assert.equal((await page.textContent('#plan-dial-p2-unconfirmed')).trim().replace(/^!/, ''), 'Not confirmed');
      assert.ok(!(await page.$('#plan-dial-p1-unconfirmed')), 'Alex still has pay in Budget');
      assert.equal((await page.textContent('#plan-dial-p2-basis')).trim(), 'Deposit average · Set pay');
      const basis = (await page.textContent('#plan-dial-p2-why')).trim();
      assert.match(basis, /^Average of .+ deposits, \d+ months — not a confirmed setting\. Pay and income has no amount for: Sam paycheck\. Enter the current amount here, or save it under Pay and income\.$/);
      assert.equal(await page.getAttribute('#plan-dial-p2-budget', 'href'), '#/budget?section=income');
      // Entering the amount here settles it.
      await typeAmount(page, '#plan-dial-p2', '2,700');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.p2 === 270000);
      await page.waitForFunction(() => !document.querySelector('#plan-dial-p2-unconfirmed'));
      assert.equal((await page.textContent('#plan-dial-p2-basis')).trim(), 'Set here');
    },
  },
  {
    name: 'who paid in: moving a deposit changes that month’s money in and the deposit average, not the pay saved',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      assert.equal(await page.$eval('#plan-deposits', d => d.open), false, 'a closed drawer');
      assert.ok(await page.evaluate(() => document.querySelector('#plan-g-in').parentElement.contains(document.querySelector('#plan-deposits'))), 'under the money-in dials');
      // On the sample the average of deposits equals the pay in Budget: no average button yet.
      assert.ok(!(await page.$('#plan-dial-p1-average')) && !(await page.$('#plan-dial-p2-average')));
      await page.click('#plan-deposits > summary');
      const dep = (await page.$$eval('#plan-deposits select', ss => ss.map(x => ({ id: x.dataset.txn, label: x.options[x.selectedIndex].textContent }))))
        .find(x => x.label === 'Alex (suggested)');
      assert.ok(dep, 'a deposit matched to Alex by the pay in Budget');
      const txn = await page.evaluate(id => {
        const H = window.HouseholdBudget, x = H.getDataset().transactions.find(y => y.id === id);
        return { cents: x.amountCents, month: H.engine.months.label(x.date.slice(0, 7)) };
      }, dep.id);
      const exp0 = await timeline(page);
      const budget = key => exp0.dials.find(d => d.key === key).budgetCents;
      const base = async key => centsOf(await page.textContent('#plan-dial-' + key + '-base'));
      const monthOf = label => exp0.months.find(x => x.label === label);
      const flows = async () => {
        const m = (await timeline(page)).months.find(x => x.month === monthOf(txn.month).month);
        return { alex: m.in.p1, sam: m.in.p2 };
      };
      const before = await flows();

      await page.focus('#plan-dep-' + dep.id); // as a click or the keyboard would
      await page.selectOption('#plan-dep-' + dep.id, 'p2');
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).person === 'p2', dep.id);
      await page.waitForSelector('#plan-dial-p1-average');
      assert.equal(await base('p1'), budget('p1'), 'Alex’s dial still starts from the pay saved');
      assert.equal(await base('p2'), budget('p2'), 'and Sam’s');
      const after = await flows();
      assert.ok(Math.abs(before.alex - after.alex - txn.cents) <= 100, 'that month’s Alex column drops by the deposit');
      assert.ok(Math.abs(after.sam - before.sam - txn.cents) <= 100, 'and Sam’s rises by it');
      assert.ok(await page.$eval('#plan-deposits', d => d.open), 'the drawer stays open');
      assert.equal(await page.inputValue('#plan-dep-' + dep.id), 'p2');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-dep-' + dep.id, 'focus stays on the select');

      // The deposit average now differs from the pay saved: it can be used for the plan, and Reset returns to the pay.
      const exp1 = await timeline(page);
      const avg = exp1.dials.find(d => d.key === 'p1').averageCents;
      assert.ok(Math.abs(budget('p1') - avg - Math.round(txn.cents / exp1.count)) <= 1, 'Alex’s average lost the deposit’s monthly share');
      assert.equal((await page.textContent('#plan-dial-p1-average')).trim(), `Use the ${exp1.count}-month average (${amt(avg)})`);
      await page.click('#plan-dial-p1-average');
      await page.waitForFunction(v => window.HouseholdBudget.getState().ui.plan.dials.p1 === v, avg);
      await page.waitForFunction(v => document.querySelector('#plan-dial-p1').value === v, boxText(avg));
      assert.equal((await page.textContent('#plan-dial-p1-basis')).trim(), 'Set here');
      assert.ok(!(await page.$('#plan-dial-p1-average')), 'no average button once set here');
      await page.click('#plan-dial-p1-reset');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.p1 === undefined);
      await page.waitForFunction(v => document.querySelector('#plan-dial-p1').value === v, boxText(budget('p1')));
      assert.match(await page.textContent('#plan-dial-p1-basis'), /^From your pay/);
    },
  },
  {
    name: 'who paid in: confirm all removes the provisional marks and the count, in one undoable step',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      const summary = () => page.textContent('#plan-deposits > summary').then(x => x.trim());
      const badges = text => page.$$eval('#plan-deposits .badge', (bs, w) => bs.filter(b => b.textContent.trim() === w).length, text);
      const m = /^Who paid in · (\d+) deposits? to confirm$/.exec(await summary());
      assert.ok(m, 'the summary counts what is left to confirm');
      await page.click('#plan-deposits > summary');
      const prov = await badges('provisional'), none = await badges('not assigned');
      assert.ok(prov > 0, 'the sample has provisional matches');
      assert.equal(Number(m[1]), prov + none);
      assert.equal((await page.textContent('#plan-dep-confirm')).trim(), `Confirm all ${prov} provisional matches`);
      const p1 = await page.textContent('#plan-dial-p1-base');
      await page.click('#plan-dep-confirm');
      await page.waitForFunction(() => !document.querySelector('#plan-dep-confirm'));
      assert.equal(await badges('provisional'), 0);
      assert.equal(await summary(), none ? `Who paid in · ${none} deposit${none === 1 ? '' : 's'} to confirm` : 'Who paid in');
      assert.equal(await page.textContent('#plan-dial-p1-base'), p1, 'confirming moves no money');
      if (none) {
        const id = await page.$eval('#plan-deposits tbody tr .badge', b => b.closest('tr').querySelector('select').id);
        await page.selectOption('#' + id, 'none');
        await page.waitForFunction(() => document.querySelector('#plan-deposits > summary').textContent.trim() === 'Who paid in');
        await page.click('#undoBtn');
        await page.waitForFunction(() => /to confirm/.test(document.querySelector('#plan-deposits > summary').textContent));
      }
      await page.click('#undoBtn');
      await page.waitForSelector('#plan-dep-confirm');
      assert.equal(await badges('provisional'), prov, 'one Undo brings every provisional match back');
    },
  },
  {
    name: 'phone: Edit plan with everything open has no sideways scroll, controls at least 40px, money out under money in',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      await page.waitForSelector('#plan-dials');
      await page.evaluate(() => {
        for (const d of document.querySelectorAll('.plan-grp')) d.open = true;
        for (const id of ['plan-drill-essentials', 'plan-drill-flexible', 'plan-drill-irregular', 'plan-more', 'plan-deposits', 'plan-add-custom']) document.getElementById(id).open = true;
        for (const d of document.querySelectorAll('.plan-ch-edit')) d.open = true;
        for (const kid of document.querySelectorAll('#plan-drill-flexible .drill-kids')) kid.open = true;
      });
      assert.ok(await noHorizontalScroll(page), 'no sideways scroll with everything open');
      const small = await page.$$eval('#plan-root button:not(.cc-chip), #plan-root input[type="text"], #plan-root input[type="date"], #plan-root input[type="month"], #plan-root input[type="range"], #plan-root select, #plan-root .segmented label, #plan-root summary, #plan-root .drill-name, #plan-root .plan-ch-accept', els => els
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => ({ what: (el.id || el.textContent.trim()).slice(0, 40), h: Math.round(el.getBoundingClientRect().height) }))
        .filter(x => x.h < 40));
      assert.deepEqual(small, [], 'tap targets under 40px');
      const pos = await page.evaluate(() => {
        const groups = [...document.querySelectorAll('.plan-group')].map(g => g.getBoundingClientRect());
        return { inBottom: groups[0].bottom, outTop: groups[1].top, inLeft: groups[0].left, outLeft: groups[1].left };
      });
      assert.ok(pos.outTop >= pos.inBottom - 1 && Math.abs(pos.outLeft - pos.inLeft) < 2, 'money out stacked under money in');
      await t.shot('edit-plan-phone-open');
    },
  },
];
