'use strict';
// Plan (#/overview): the chart, the balances it starts from, the dials and their drill-down.

async function noHorizontalScroll(page) {
  // Compare with the configured viewport: under mobile emulation innerWidth grows with overflow.
  const width = page.viewportSize().width;
  return page.evaluate(w => document.scrollingElement.scrollWidth <= w + 1, width);
}

/** The engine's model for the current state, built the way the page builds it (real local today). */
function timeline(page) {
  return page.evaluate(() => {
    const H = window.HouseholdBudget, E = H.engine, ctx = H.context(), st = H.getState();
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const tl = E.timeline.build({ txns: ctx.realTxns, dataset: ctx.dataset, plan: st.plan, settings: st.ui.plan, today, coverageMap: ctx.coverageMap });
    const label = m => E.months.label(m);
    return {
      today, todayMonth: tl.todayMonth, todayLabel: label(tl.todayMonth), firstLabel: label(tl.firstMonth), planLabel: label(tl.planStart), plan: tl.plan,
      count: tl.baseline.count,
      dials: tl.dials.map(x => ({ key: x.key, baselineCents: x.baselineCents, planCents: x.planCents, source: x.source, budgetCents: x.budgetCents, averageCents: x.averageCents })),
      card: tl.dialsByKey.card,
      oneTime: tl.baseline.oneTime,
      balances: { mode: tl.balances.mode, runsOut: tl.balances.runsOut, combined: tl.balances.combined, accounts: tl.balances.accounts.map(a => ({ id: a.id, points: a.points })),
        assumed: tl.balances.assumed || null, illustrative: tl.balances.illustrative || null },
      months: tl.months.map(m => ({ month: m.month, label: label(m.month), status: m.status })),
    };
  });
}
const state = page => page.evaluate(() => window.HouseholdBudget.getState());
/** Whole dollars as the chart shows them: $1,234 and −$1,234. */
const whole = cents => (cents < 0 ? '−$' : '$') + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
/** Dollars with cents only when there are any, as the dials and the sum line show them. */
const amt = cents => (cents < 0 ? '−$' : '$') + (Math.abs(cents) % 100 ? (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(Math.abs(cents) / 100).toLocaleString('en-US'));
/** What an exact-entry box holds: 2,222.02 / -1,236.48 / 250. */
const boxText = cents => (cents < 0 ? '-' : '') + Math.floor(Math.abs(cents) / 100).toLocaleString('en-US') + (Math.abs(cents) % 100 ? '.' + String(Math.abs(cents) % 100).padStart(2, '0') : '');
const centsOf = text => { const m = /(−|-)?\$([\d,]+(?:\.\d\d)?)/.exec(text); return m ? (m[1] ? -1 : 1) * Math.round(Number(m[2].replace(/,/g, '')) * 100) : null; };

async function typeAmount(page, sel, text) {
  await page.fill(sel, text);
  await page.press(sel, 'Enter');
}
/** The chart's table twin: header labels and the cell texts of every row. */
async function table(page) {
  if (!(await page.$eval('#plan-chart-table', d => d.open))) await page.click('#plan-chart-table > summary');
  const heads = await page.$$eval('#plan-chart-table thead th', ths => ths.map(th => th.textContent.trim()));
  const rows = await page.$$eval('#plan-chart-table tbody tr', trs => trs.map(tr => Array.from(tr.children).map(td => td.textContent.trim())));
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

module.exports = [
  {
    name: 'the chart is in the first screen, with nothing above it',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      assert.equal((await page.textContent('#page-title')).trim(), 'Plan');
      assert.match(await page.textContent('.page-subtitle'), /^Joint accounts · your data through Sep 30, 2026$/);
      const r = await page.evaluate(() => {
        const plot = document.querySelector('#plan-chart-plot').getBoundingClientRect();
        const card = document.querySelector('#plan-chart-card');
        const above = [...document.querySelectorAll('#view .notice, #view .metric, #view .card, #view fieldset')]
          .filter(n => !card.contains(n) && (n.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING));
        const root = document.querySelector('#plan-root');
        return { top: plot.top, vh: innerHeight, above: above.length, first: root.firstElementChild.id, last: root.lastElementChild.id, text: root.textContent };
      });
      assert.ok(r.top < r.vh * 0.55, `plot starts at ${Math.round(r.top)}px of ${r.vh}px`);
      assert.equal(r.above, 0, 'nothing above the chart card');
      assert.equal(r.first, 'plan-chart-card');
      assert.equal(r.last, 'plan-sample', 'the sample-household line is last');
      assert.ok(!/safe to spend|affordable|cash available|bank balance/i.test(r.text), 'no promises about spendable cash');
      // Balance mode by default (the sample knows its balances); the account lines start switched off.
      assert.equal(await page.getAttribute('#plan-chart', 'data-mode'), 'balance');
      const chips = await page.$$eval('#plan-chart .cc-chip', bs => bs.map(b => [b.textContent.trim(), b.getAttribute('aria-pressed')]));
      assert.deepEqual(chips, [['Combined cash', 'true'], ['Joint checking', 'false'], ['Joint savings', 'false']]);
      // The account lines (off by default, one tap away) are illustrative: the caption says so once.
      assert.match(await page.textContent('#plan-chart .cc-caption'), /^Combined cash = Joint checking \+ Joint savings\. Solid: your data through Sep 2026\. Dashed: this plan from Oct 2026\. Account lines are illustrative: card spending is taken from checking in the month it happens, not when the card is paid; the combined line is not affected\.$/);
      // Dials: money in by person, money out by kind, in this order.
      assert.deepEqual(await page.$$eval('#plan-dials .dial', ds => ds.map(d => d.dataset.dial)), ['p1', 'p2', 'inOther', 'card', 'bank', 'savings', 'other']);
      assert.ok(await noHorizontalScroll(page));
      await t.shot('plan');
    },
  },
  {
    name: 'no known balance: flows with a prompt; the first balance switches to the balance line',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.evaluate(() => {
        const ds = JSON.parse(JSON.stringify(window.HouseholdBudget.getDataset()));
        for (const x of ds.transactions) delete x.balanceCents;
        localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: ds, loadedAt: new Date().toISOString(), source: 'json', file: 'no-balances.json' }));
      });
      await page.reload();
      await page.waitForSelector('#page-title');
      await page.evaluate(() => {
        const H = window.HouseholdBudget;
        const st = H.getState();
        st.plan.balances.accounts = {};
        st.plan.balances.accountDates = {};
        st.plan.balances.accountsAsOf = null;
        H.setState(st);
      });
      await page.waitForSelector('#plan-prompt');
      assert.equal(await page.getAttribute('#plan-chart', 'data-mode'), 'flows', 'flows when nothing is known');
      const top = await page.evaluate(() => document.querySelector('#plan-chart-plot').getBoundingClientRect().top / innerHeight);
      assert.ok(top < 0.55, 'the flows plot starts in the first screen too (' + Math.round(top * 100) + '%)');
      assert.equal((await page.textContent('#plan-prompt')).trim(), 'Enter today’s balances below to see where the money is heading');
      assert.ok(!(await page.$('#plan-mode-balance, input[name="plan-mode"]')), 'no balance switch without a balance');
      assert.equal(await page.inputValue('#plan-bal-joint-checking-date'), '');
      await page.click('#plan-prompt');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'plan-bal-joint-checking');

      await typeAmount(page, '#plan-bal-joint-checking', '12,345.67');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accounts['joint-checking'] === 1234567);
      await page.waitForSelector('#plan-chart[data-mode="balance"]');
      const exp = await timeline(page);
      const st = await state(page);
      assert.equal(st.ui.plan.mode, 'balance', 'the same change switched the chart to balances');
      assert.equal(st.plan.balances.accountDates['joint-checking'], exp.today, 'today’s date was written');
      assert.equal(await page.inputValue('#plan-bal-joint-checking-date'), exp.today);
      assert.equal(exp.balances.mode, 'accounts');
      // The anchor month: the engine's own points, as the table twin shows them.
      const chk = exp.balances.accounts.find(a => a.id === 'joint-checking').points.find(p => p.month === exp.todayMonth);
      const comb = exp.balances.combined.points.find(p => p.month === exp.todayMonth);
      assert.ok(chk.anchor, 'the anchor is in this month');
      assert.ok(Math.abs(chk.cents - 1234567) <= Math.abs(exp.plan.net), 'checking = the balance plus the pro-rated rest of the month');
      assert.equal(comb.cents, chk.cents, 'savings has no known balance: it is left out of the combined line');
      const tb = await table(page);
      const row = tb.rows.find(r => r[0] === exp.todayLabel);
      assert.equal(row[tb.col('Combined cash')], whole(comb.cents));
      assert.ok(row[tb.col('Joint checking')].startsWith(whole(chk.cents)));
      assert.match(await page.textContent('#plan-bal-total'), /Combined \$12,345\.67 as of/);
      // Undo takes the balance and the mode change back together.
      await page.click('#undoBtn');
      await page.waitForSelector('#plan-prompt');
      assert.equal((await state(page)).plan.balances.accounts['joint-checking'], undefined);
    },
  },
  {
    name: 'a balance dated after the export ends: the months worked across the missing days are dotted and called assumed',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      // An export without running balances: the entered balance is the only anchor for checking.
      await page.evaluate(() => {
        const ds = JSON.parse(JSON.stringify(window.HouseholdBudget.getDataset()));
        for (const x of ds.transactions) delete x.balanceCents;
        localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: ds, loadedAt: new Date().toISOString(), source: 'json', file: 'no-running-balance.json' }));
      });
      await page.reload();
      await page.waitForSelector('#plan-bal-joint-checking');

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
      // The sample checking export has a running balance dated Sep 25: September's month-end is
      // worked forward from it over covered days, so a balance dated Oct 2 only starts the plan.
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
        localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: ds, loadedAt: new Date().toISOString(), source: 'json', file: 'cards-only.json' }));
      });
      await page.reload();
      await page.waitForSelector('#plan-prompt');
      assert.deepEqual(await page.$$eval('#plan-balances .plan-bal-name', ls => ls.map(l => l.textContent.trim())), ['Cash today']);
      await typeAmount(page, '#plan-bal-cash', '5,000');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.jointCashCents === 500000);
      await page.waitForSelector('#plan-chart[data-mode="balance"]');
      const exp = await timeline(page);
      assert.equal((await state(page)).plan.balances.asOf, exp.today);
      assert.equal(exp.balances.mode, 'simple');
      assert.match(await page.textContent('#plan-chart .cc-caption'), /Illustrative cash projection from the numbers you entered\.$/);
      assert.match(await page.textContent('#plan-bal-total'), /Cash \$5,000\.00 as of/);
    },
  },
  {
    name: 'card dial: the exact box, the slider, the monthly sum and the chart agree',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const before = await table(page);
      await typeAmount(page, '#plan-dial-card', '3,456.78');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.card === 345678);
      await page.waitForFunction(() => /\$3,456\.78 cards/.test(document.querySelector('#plan-sum').textContent));
      assert.equal(await page.inputValue('#plan-dial-card'), '3,456.78');
      assert.ok(Math.abs(Number(await page.inputValue('#plan-dial-card-range')) - 3456.78) <= 12.5, 'slider follows (to its $25 step)');
      const exp = await timeline(page);
      const sumText = await page.textContent('#plan-sum');
      assert.ok(sumText.includes('= ' + (exp.plan.net > 0 ? '+' : '') + amt(exp.plan.net) + ' left in checking'), sumText);
      assert.match(await page.textContent('#plan-dial-card-base'), /set by you/);
      const after = await table(page);
      const last = exp.balances.combined.points[exp.balances.combined.points.length - 1];
      const lastRow = after.rows[after.rows.length - 1];
      assert.equal(lastRow[after.col('Combined cash')], whole(last.cents), 'last projected month follows the dial');
      assert.notEqual(lastRow[after.col('Combined cash')], before.rows[before.rows.length - 1][before.col('Combined cash')]);

      // The slider moves in $25 steps and the box agrees.
      await typeAmount(page, '#plan-dial-card', '2,300');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.card === 230000);
      await page.waitForFunction(() => document.querySelector('#plan-dial-card-range').value === '2300');
      await page.focus('#plan-dial-card-range');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.card === 232500);
      await page.waitForFunction(() => document.querySelector('#plan-dial-card').value === '2,325');
      assert.equal(await page.inputValue('#plan-dial-card-range'), '2325');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-dial-card-range', 'focus stays on the slider');

      // Above the slider's range: kept exactly, the range grows.
      const max = Number(await page.getAttribute('#plan-dial-card-range', 'max'));
      await typeAmount(page, '#plan-dial-card', String(max + 15000) + '.55');
      const big = Math.round((max + 15000.55) * 100);
      await page.waitForFunction(v => window.HouseholdBudget.getState().ui.plan.dials.card === v, big);
      await page.waitForFunction(v => document.querySelector('#plan-dial-card').value === v, boxText(big));
      assert.ok(Number(await page.getAttribute('#plan-dial-card-range', 'max')) >= big / 100, 'slider range widened');
      // A negative card amount is refused with a message; nothing changes.
      await typeAmount(page, '#plan-dial-card', '-50');
      await page.waitForSelector('#plan-dial-card-error:not([hidden])');
      assert.match(await page.textContent('#plan-dial-card-error'), /\$0 or more/);
      assert.equal((await state(page)).ui.plan.dials.card, big);
    },
  },
  {
    name: 'drill-down: unticking a place or changing a category moves the card dial; a dial set directly says so',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const exp = await timeline(page);
      const rows = exp.card.drill.rows;
      const base = exp.card.planCents;
      await page.click('#plan-drill-card > summary');
      assert.equal((await page.textContent('#plan-drill-card > summary')).trim(), `What’s in this · ${exp.card.drill.categoryCount} categories · ${amt(base)}/mo`);
      const place = rows.find(r => r.kind === 'merchant' && r.label === 'Netflix.com');
      await page.click(`#plan-drillrow-${place.parent} > summary`);
      await page.uncheck(`#plan-row-${place.id}-on`);
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ui.plan.rows[id] || {}).included === false, place.id);
      await page.waitForFunction(v => document.querySelector('#plan-dial-card').value === v, boxText(base - place.planCents));
      assert.ok((await page.textContent('#plan-drill-card > summary')).includes(amt(base - place.planCents) + '/mo'), 'summary sum matches the dial');
      assert.ok(await page.$eval(`#plan-drillrow-${place.parent}`, d => d.open), 'the category stays open');
      assert.match(await page.textContent('#plan-dial-card-base'), /from the list below/);
      await page.check(`#plan-row-${place.id}-on`);
      await page.waitForFunction(id => !window.HouseholdBudget.getState().ui.plan.rows[id], place.id);
      await page.waitForFunction(v => document.querySelector('#plan-dial-card').value === v, boxText(base));

      // Dining from its average to $200: the dial is the new sum.
      const dining = rows.find(r => r.level === 1 && r.label === 'Dining & takeout');
      await typeAmount(page, `#plan-row-${dining.id}-amt`, '200');
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ui.plan.rows[id] || {}).cents === 20000, dining.id);
      const sum = base - dining.planCents + 20000;
      await page.waitForFunction(v => document.querySelector('#plan-dial-card').value === v, boxText(sum));
      assert.match(await page.textContent(`[data-row="${dining.id}"] .drill-meta`), /edited/);

      // Dragging the dial sets it directly; the drill-down says the rows add up to something else.
      await page.$eval('#plan-dial-card-range', el => {
        el.value = String(Number(el.value) + 500);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForFunction(() => Number.isInteger(window.HouseholdBudget.getState().ui.plan.dials.card));
      await page.waitForSelector('#plan-drill-card-use');
      const note = await page.textContent('#plan-drill-card .notice');
      assert.match(note, /Dial set directly to \$[\d,.]+; the rows add up to/);
      assert.ok(note.includes('the rows add up to ' + amt(sum) + '.'), note);
      await page.click('#plan-drill-card-use');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.card === undefined);
      await page.waitForFunction(v => document.querySelector('#plan-dial-card').value === v, boxText(sum));
      assert.ok(!(await page.$('#plan-drill-card-use')), 'the notice is gone');
      assert.equal((await state(page)).ui.plan.rows[dining.id].cents, 20000, 'the rows are kept');
    },
  },
  {
    name: 'a one-time purchase can be counted in the plan, which raises the card baseline',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const exp = await timeline(page);
      const item = exp.oneTime.find(o => o.dialKey === 'card' && o.merchant === 'Bright Smile Dental');
      assert.ok(item, 'the sample has a one-time dental bill');
      await page.click('#plan-drill-card > summary');
      assert.match(await page.textContent('#plan-onetime-card'), /Left out as one-time \(\d+ · \$[\d,.]+\)/);
      assert.equal(await page.isChecked('#plan-onetime-' + item.id), false);
      const before = centsOf(await page.textContent('#plan-dial-card-base'));
      await page.check('#plan-onetime-' + item.id);
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).planningBaseline === 'include', item.id);
      await page.waitForFunction(b => !document.querySelector('#plan-dial-card-base').textContent.includes(b), amt(before));
      const after = centsOf(await page.textContent('#plan-dial-card-base'));
      assert.ok(Math.abs(after - before - Math.round(item.cents / exp.count)) <= 1, `baseline +${after - before}, expected about ${Math.round(item.cents / exp.count)}`);
      assert.equal(await page.isChecked('#plan-onetime-' + item.id), true, 'now listed as counted');
      await page.uncheck('#plan-onetime-' + item.id);
      await page.waitForFunction(id => window.HouseholdBudget.getState().ledgerEdits[id].planningBaseline === 'exclude', item.id);
      await page.waitForFunction(b => document.querySelector('#plan-dial-card-base').textContent.includes(b), amt(before));
    },
  },
  {
    name: 'switching Balance and Flows keeps the months; Ahead and Past change them',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const a = await table(page);
      await page.click('label[for^="plan-mode-flows"]');
      await page.waitForSelector('#plan-chart[data-mode="flows"]');
      const b = await table(page);
      assert.equal(b.rows[0][0], a.rows[0][0], 'same first month');
      assert.equal(b.rows[b.rows.length - 1][0], a.rows[a.rows.length - 1][0], 'same last month');
      assert.deepEqual(await page.$$eval('#plan-chart .cc-chip', bs => bs.map(x => x.dataset.ccKey)),
        ['in-p1', 'in-p2', 'in-other', 'out-card', 'out-bank', 'out-savings', 'out-other', 'net']);
      // The flows add up: total in − total out = net, every month.
      const f = b.col.bind(b);
      for (const r of b.rows.filter(x => x[f('Status')] !== 'Gap')) {
        const v = i => centsOf(r[i]);
        assert.ok(Math.abs(v(f('Total in')) - v(f('Total out')) - v(f('Net'))) <= 200, 'in − out = net in ' + r[0]);
      }
      await page.click('label[for^="plan-horizon-60"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.horizon === 60);
      await page.waitForFunction(() => document.querySelectorAll('#plan-chart-table tbody tr').length > 60);
      let c = await table(page);
      assert.equal(c.rows.filter(r => r[c.col('Status')] === 'Projected').length, 60, '60 plan months at 5 years');
      await page.click('label[for^="plan-past-all"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.past === 'all');
      const exp = await timeline(page);
      await page.waitForFunction(v => document.querySelector('#plan-chart-table tbody tr th').textContent.trim() === v, exp.firstLabel);
      c = await table(page);
      assert.equal(c.rows[0][0], 'Sep 2024', 'the first month with data');
      await page.click('label[for^="plan-mode-balance"]');
      await page.waitForSelector('#plan-chart[data-mode="balance"]');
      const d = await table(page);
      assert.equal(d.rows.length, c.rows.length);
    },
  },
  {
    name: 'reset all puts every dial back to its baseline, and Undo brings the values back',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      assert.ok(!(await page.$('#plan-reset')), 'nothing to reset yet');
      await typeAmount(page, '#plan-dial-card', '3,000');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.card === 300000);
      await typeAmount(page, '#plan-dial-savings', '−1,236.48');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.savings === -123648);
      await page.waitForFunction(() => /\+ \$1,236\.48 from savings/.test(document.querySelector('#plan-sum').textContent));
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
      assert.equal((await state(page)).ui.plan.dials.card, 300000);
      assert.equal(await page.inputValue('#plan-dial-card'), '3,000');
    },
  },
  {
    name: 'a plan that spends more than comes in goes below $0, and the chart shows it',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      assert.ok(!(await page.$('#plan-chart-card .notice-warn')), 'quiet while the plan stays above $0');
      await typeAmount(page, '#plan-dial-card', '20,000');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.card === 2000000);
      await page.waitForSelector('#plan-chart-card .notice-warn');
      const exp = await timeline(page);
      assert.ok(exp.balances.runsOut);
      assert.match(await page.textContent('#plan-chart-card .notice-warn'), /On this plan the combined cash goes below \$0 in [A-Z][a-z]+ \d{4} \(lowest −\$[\d,]+\)/);
      const tb = await table(page);
      const negatives = tb.rows.filter(r => r[tb.col('Combined cash')].startsWith('−$'));
      assert.ok(negatives.length > 0, 'negative balances are shown, not floored');
      assert.equal(tb.rows[tb.rows.length - 1][tb.col('Combined cash')], whole(exp.balances.combined.points[exp.balances.combined.points.length - 1].cents));
      assert.match(await page.textContent('#plan-sum strong'), /^−\$/);
      assert.ok(await noHorizontalScroll(page));
      await t.shot('plan-below-zero');
    },
  },
  {
    name: 'a dial, the chart mode and the series choice survive a reload',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await typeAmount(page, '#plan-dial-bank', '1,234.56');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.bank === 123456);
      // The legend toggle is saved without a re-render.
      const seq = await page.evaluate(() => document.documentElement.dataset.renderSeq);
      await page.click('#plan-chart .cc-chip[data-cc-key="acct-joint-checking"]');
      await page.waitForFunction(() => Array.isArray(window.HouseholdBudget.getState().ui.plan.hidden) && !window.HouseholdBudget.getState().ui.plan.hidden.includes('acct-joint-checking'));
      assert.equal(await page.evaluate(() => document.documentElement.dataset.renderSeq), seq, 'no re-render for a legend toggle');
      assert.deepEqual((await state(page)).ui.plan.hidden, ['acct-joint-savings']);
      await page.click('label[for^="plan-mode-flows"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.mode === 'flows');
      await page.reload();
      await page.waitForSelector('#plan-dial-bank');
      assert.equal(await page.inputValue('#plan-dial-bank'), '1,234.56');
      assert.equal(await page.getAttribute('#plan-chart', 'data-mode'), 'flows');
      assert.ok(await page.isChecked('input[name="plan-mode"][value="flows"]'));
      await page.click('label[for^="plan-mode-balance"]');
      await page.waitForSelector('#plan-chart[data-mode="balance"]');
      assert.equal(await page.getAttribute('#plan-chart .cc-chip[data-cc-key="acct-joint-checking"]', 'aria-pressed'), 'true');
      assert.equal(await page.getAttribute('#plan-chart .cc-chip[data-cc-key="acct-joint-savings"]', 'aria-pressed'), 'false');
    },
  },
  {
    name: 'money in starts from the pay saved in Budget; without it the average is marked not confirmed',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      for (const key of ['p1', 'p2']) {
        assert.match(await page.textContent(`#plan-dial-${key}-basis`), /^From Budget: .+ · Change in Budget$/);
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
      const basis = (await page.textContent('#plan-dial-p2-basis')).trim();
      assert.match(basis, /^Average of .+ deposits, \d+ months — not a confirmed setting\. Budget has no amount for: Sam paycheck\. Enter the current amount here, or save pay in Budget\.$/);
      assert.equal(await page.getAttribute('#plan-dial-p2-budget', 'href'), '#/budget?section=income');
      // Entering the amount here settles it.
      await typeAmount(page, '#plan-dial-p2', '2,700');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.p2 === 270000);
      await page.waitForFunction(() => !document.querySelector('#plan-dial-p2-unconfirmed'));
      assert.equal((await page.textContent('#plan-dial-p2-basis')).trim(), 'Set here');
    },
  },
  {
    name: 'who paid in: moving a deposit changes the flows and the deposit average, not the pay from Budget',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
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
      await page.click('label[for^="plan-mode-flows"]');
      await page.waitForSelector('#plan-chart[data-mode="flows"]');
      const flows = async () => {
        const tb = await table(page);
        const row = tb.rows.find(r => r[0] === txn.month);
        return { alex: centsOf(row[tb.col('In: Alex → joint')]), sam: centsOf(row[tb.col('In: Sam → joint')]) };
      };
      const before = await flows();

      await page.focus('#plan-dep-' + dep.id); // as a click or the keyboard would
      await page.selectOption('#plan-dep-' + dep.id, 'p2');
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).person === 'p2', dep.id);
      await page.waitForSelector('#plan-dial-p1-average');
      assert.equal(await base('p1'), budget('p1'), 'Alex’s dial still starts from the pay in Budget');
      assert.equal(await base('p2'), budget('p2'), 'and Sam’s');
      const after = await flows();
      assert.ok(Math.abs(before.alex - after.alex - txn.cents) <= 100, 'that month’s Alex column drops by the deposit');
      assert.ok(Math.abs(after.sam - before.sam - txn.cents) <= 100, 'and Sam’s rises by it');
      assert.ok(await page.$eval('#plan-deposits', d => d.open), 'the drawer stays open');
      assert.equal(await page.inputValue('#plan-dep-' + dep.id), 'p2');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-dep-' + dep.id, 'focus stays on the select');

      // The deposit average now differs from Budget: it can be used for the plan, and reset returns to Budget.
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
      assert.match(await page.textContent('#plan-dial-p1-basis'), /^From Budget: /);
    },
  },
  {
    name: 'who paid in: confirm all removes the provisional marks and the count, in one undoable step',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
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
    name: 'phone: no sideways scroll, controls at least 40px, dials stacked under the chart',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.evaluate(() => {
        for (const id of ['plan-drill-card', 'plan-more', 'plan-deposits']) document.getElementById(id).open = true;
        const kid = document.querySelector('#plan-drill-card .drill-kids');
        if (kid) kid.open = true;
      });
      assert.ok(await noHorizontalScroll(page), 'no sideways scroll with the drill-down open');
      const small = await page.$$eval('#plan-root button:not(.cc-chip), #plan-root input[type="text"], #plan-root input[type="date"], #plan-root input[type="range"], #plan-root select, #plan-root .segmented label, #plan-root summary, #plan-root .drill-name, #plan-root .plan-links a', els => els
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => ({ what: (el.id || el.textContent.trim()).slice(0, 40), h: Math.round(el.getBoundingClientRect().height) }))
        .filter(x => x.h < 40));
      assert.deepEqual(small, [], 'tap targets under 40px');
      const pos = await page.evaluate(() => {
        const box = s => document.querySelector(s).getBoundingClientRect();
        const groups = [...document.querySelectorAll('.plan-group')].map(g => g.getBoundingClientRect());
        return { chartBottom: box('#plan-chart-card').bottom, dialsTop: box('#plan-dials').top, inBottom: groups[0].bottom, outTop: groups[1].top, inLeft: groups[0].left, outLeft: groups[1].left };
      });
      assert.ok(pos.dialsTop > pos.chartBottom, 'dials below the chart');
      assert.ok(pos.outTop >= pos.inBottom - 1 && Math.abs(pos.outLeft - pos.inLeft) < 2, 'money out stacked under money in');
      await t.shot('plan-phone-open');
    },
  },
];
