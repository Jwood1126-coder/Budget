'use strict';
// Plan (#/overview), the finished-product pieces: the tiles above the chart, Compare (a what-if as
// its own line), the markers for changes and goals, Coming up (the strip, the packs, what Budget
// adds), the investments line, the compact dials and Forecast's retirement. Synthetic sample only;
// an investment account, where needed, is added to the dataset inside the test.
const { noHorizontalScroll, state, whole } = require('./helpers.cjs');

/** The engine's model for the current state (real local today), with an optional what-if to compare. */
function timeline(page, compare) {
  return page.evaluate(cmp => {
    const H = window.HouseholdBudget, E = H.engine, ctx = H.context(), st = H.getState();
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const tl = E.timeline.build({ txns: ctx.realTxns, dataset: ctx.dataset, plan: st.plan, settings: st.ui.plan, today, coverageMap: ctx.coverageMap, compare: cmp || undefined });
    const at = (pts, m) => { const p = (pts || []).find(x => x.month === m); return p ? p.cents : null; };
    const now = E.months.add(tl.planStart, -1), then = E.months.add(tl.planStart, Math.min(12, tl.horizon) - 1);
    const sav = tl.balances.accounts.filter(a => a.group === 'savings');
    return {
      planStart: tl.planStart, now, then, combinedChange: tl.plan.combinedChange, net: tl.plan.net, savings: tl.plan.savings,
      cashNow: at(tl.balances.combined.points, now), cashThen: at(tl.balances.combined.points, then),
      savNow: sav.reduce((s, a) => s + at(a.points, now), 0), savThen: sav.reduce((s, a) => s + at(a.points, then), 0),
      combinedLast: tl.balances.combined.points[tl.balances.combined.points.length - 1],
      compare: tl.compare ? { scenario: tl.compare.scenario, points: tl.compare.points } : null,
      scenarios: tl.scenarios.map(x => x.name),
      investments: tl.balances.investments ? tl.balances.investments.points.map(p => ({ month: p.month, cents: p.cents })) : null,
      goals: tl.goals.map(g => ({ id: g.id, reachMonth: g.reachMonth })),
    };
  }, compare || null);
}
const typeAmount = async (page, sel, text) => { await page.fill(sel, text); await page.press(sel, 'Enter'); };
/** Whole dollars with a sign, as the tiles show them. */
const signedWhole = cents => (cents > 0 ? '+' : '') + whole(cents);
/** The compact form the tiles use: $450, $4.1k, $32k. */
const compact = cents => { const a = Math.abs(cents) / 100; return (cents < 0 ? '−' : '') + '$' + (a >= 10000 ? Math.round(a / 1000) + 'k' : a >= 1000 ? String(Math.round(a / 100) / 10).replace(/\.0$/, '') + 'k' : String(Math.round(a))); };
/** Add the New baby pack through its little form (due date 'YYYY-MM-DD'). */
async function addBaby(page, due) {
  await page.click('#plan-add-baby > summary');
  await page.fill('#plan-pack-baby-date', due);
  const n = (await state(page)).plan.changes.length;
  await page.click('#plan-pack-baby-add');
  await page.waitForFunction(k => window.HouseholdBudget.getState().plan.changes.length === k + 9, n);
}
/** The sample with a balance-only investment account (synthetic: a statement balance, no transactions). */
async function withInvestments(page) {
  await page.evaluate(() => {
    const ds = JSON.parse(JSON.stringify(window.HouseholdBudget.getDataset()));
    ds.accounts.push({ id: 'joint-brokerage', label: 'Joint brokerage', type: 'investment', scope: 'joint', ownerId: null, paidInFull: false, coverage: [] });
    ds.balances.push({ accountId: 'joint-brokerage', date: '2026-09-30', cents: 3150000, source: 'statement' });
    localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: ds, loadedAt: new Date().toISOString(), source: 'json', file: 'with-investments.json' }));
  });
  await page.reload();
  await page.waitForSelector('#page-title');
}

module.exports = [
  {
    name: 'tiles: monthly on this plan is the all-accounts change (never checking’s), cash in 12 months and savings from the engine; two by two on a phone',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const exp = await timeline(page);
      const labels = await page.$$eval('#plan-kpis .kpi-label', ls => ls.map(l => l.textContent.trim()));
      assert.deepEqual(labels, ['Monthly on this plan', 'Cash in 12 months', 'Savings'], 'no investments tile and no warning tile in the sample');
      // Monthly: money in − money out for all accounts (the headline), not checking after savings.
      assert.equal((await page.textContent('#plan-kpi-month-value')).trim(), signedWhole(exp.combinedChange));
      assert.notEqual(exp.combinedChange, exp.net, 'the sample moves money to savings, so the two differ');
      assert.equal((await page.textContent('#plan-kpi-month-sub')).trim(), `$${(exp.savings / 100).toLocaleString('en-US')} a month to savings`);
      assert.equal((await page.textContent('#plan-kpi-cash-value')).trim(), whole(exp.cashThen));
      assert.equal((await page.textContent('#plan-kpi-cash-sub')).trim(), signedWhole(exp.cashThen - exp.cashNow) + ' from now');
      assert.equal((await page.textContent('#plan-kpi-savings-value')).replace(/\s+/g, ' ').trim(), `${compact(exp.savNow)}→ to ${compact(exp.savThen)}`);
      assert.ok(!(await page.$('#plan-kpi-low')), 'no warning while the plan stays above $0');
      // A savings draw-down: the tile says it comes from savings; the number stays the all-accounts change.
      await typeAmount(page, '#plan-dial-savings', '−300');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.savings === -30000);
      await page.waitForFunction(() => document.querySelector('#plan-kpi-month-sub').textContent.trim() === '$300 a month from savings');
      const exp2 = await timeline(page);
      assert.equal((await page.textContent('#plan-kpi-month-value')).trim(), signedWhole(exp2.combinedChange));
      // A dragged slider moves the tile before anything is saved.
      const before = await page.textContent('#plan-kpi-month-value');
      await page.$eval('#plan-dial-flexible-range', el => { el.value = String(Number(el.value) + 500); el.dispatchEvent(new Event('input', { bubbles: true })); });
      assert.notEqual(await page.textContent('#plan-kpi-month-value'), before);
      if (t.viewport === 'phone') {
        const boxes = await page.$$eval('#plan-kpis .kpi', ks => ks.map(k => { const r = k.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; }));
        assert.equal(boxes[0].y, boxes[1].y, 'two tiles on the first row');
        assert.ok(boxes[1].x > boxes[0].x);
        assert.ok(boxes[2].y > boxes[0].y && boxes[2].w > boxes[0].w * 1.8, 'an odd last tile takes the whole row');
      }
      assert.ok(await noHorizontalScroll(page));
      await t.shot('plan-tiles');
    },
  },
  {
    name: 'Compare: a pack added is a what-if; chosen, it is its own line with a chip and how far it ends from the plan; kept in the address, never saved',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      assert.ok(!(await page.$('#plan-compare')), 'no Compare while the plan has no what-ifs');
      await addBaby(page, '2027-02-10');
      await page.waitForSelector('#plan-compare');
      assert.deepEqual(await page.$$eval('#plan-compare option', os => os.map(o => o.value)), ['', 'New baby']);
      assert.ok(!(await page.$('#plan-chart g[data-cc-series="compare"]')));
      await page.focus('#plan-compare');
      await page.selectOption('#plan-compare', 'New baby');
      await page.waitForFunction(() => location.hash === '#/overview?compare=New%20baby');
      await page.waitForSelector('#plan-chart g.cc-compare[data-cc-series="compare"] path.cc-compare-line');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'plan-compare', 'focus stays on the control');
      assert.equal((await page.textContent('#plan-chart .cc-chip[data-cc-key="compare"]')).trim(), 'New baby');
      const exp = await timeline(page, 'New baby');
      const pts = exp.compare.points;
      const lastIdx = pts.map((p, i) => (p.cents !== null ? i : -1)).filter(i => i >= 0).pop();
      const d = pts[lastIdx].cents - exp.combinedLast.cents;
      assert.ok(d < 0, 'the baby costs more than nothing');
      const label = new Date(pts[lastIdx].month + '-15T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      assert.equal((await page.textContent('#plan-compare-diff')).replace(/\s+/g, ' ').trim(), `${whole(d)} by ${label}`);
      assert.match(await page.textContent('#plan-compare-unset'), /^1 amount not set$/, 'the leave item has no amount yet');
      // The readout and the table carry it too.
      assert.ok((await page.$$eval('#plan-chart-table thead th', ths => ths.map(th => th.textContent.trim()))).includes('New baby'));
      // A view choice: in the address (kept on reload), never in the saved budget.
      assert.ok(!JSON.stringify((await state(page)).ui).includes('New baby'));
      await page.reload();
      await page.waitForSelector('#plan-chart g[data-cc-series="compare"]');
      assert.equal(await page.inputValue('#plan-compare'), 'New baby');
      await page.selectOption('#plan-compare', '');
      await page.waitForFunction(() => location.hash === '#/overview');
      await page.waitForFunction(() => !document.querySelector('#plan-chart g[data-cc-series="compare"]'));
      assert.ok(!(await page.$('#plan-compare-diff')));
      // Only in Balance mode.
      await page.selectOption('#plan-compare', 'New baby');
      await page.waitForSelector('#plan-compare-diff');
      await page.click('label[for^="plan-mode-flows"]');
      await page.waitForSelector('#plan-chart[data-mode="flows"]');
      assert.ok(!(await page.$('#plan-compare')));
      await t.shot('plan-compare');
    },
  },
  {
    name: 'Forecast is retired: no nav entry; #/forecast opens the Plan, a scenario link opens its what-if in Compare',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      await page.waitForFunction(() => location.hash === '#/overview');
      assert.equal((await page.textContent('#page-title')).trim(), 'Plan');
      assert.equal(await page.$$eval('[data-nav="forecast"], a[href^="#/forecast"]', x => x.length), 0, 'no link to Forecast anywhere');
      // A budget whose Forecast scenario was copied in as a what-if (the scenarios themselves stay saved).
      const name = await page.evaluate(() => {
        const H = window.HouseholdBudget, E = H.engine;
        let st = H.getState();
        const sc = st.scenarios.find(s => s.id === 'baby-arrives');
        st = E.timeline.addChange(st, { label: 'Birth and hospital costs', kind: 'oneTime', group: 'irregular', startMonth: '2027-05', cents: 250000, accepted: false, scenario: sc.name });
        H.setState(st);
        return sc.name;
      });
      const scenarios = (await state(page)).scenarios.map(s => s.id);
      await page.goto(t.url + '#/forecast?scenario=baby-arrives');
      await page.waitForFunction(n => location.hash === '#/overview?compare=' + encodeURIComponent(n), name);
      await page.waitForSelector('#plan-compare-diff');
      assert.equal(await page.inputValue('#plan-compare'), name);
      assert.deepEqual((await state(page)).scenarios.map(s => s.id), scenarios, 'saved scenarios untouched');
      // The baseline scenario is no what-if: plain Plan.
      await page.goto(t.url + '#/forecast?scenario=baseline&horizon=36');
      await page.waitForFunction(() => location.hash === '#/overview');
      assert.ok(await noHorizontalScroll(page));
    },
  },
  {
    name: 'Coming up: the strip and the list; Childcare ($1,200 by default) and Kid costs packs; what Budget adds is read-only with a link; saved Baby template changes still work',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      // What Budget adds: a bill not in the history and a goal spent from savings, read-only.
      const bill = '#plan-ch-bill-life-insurance';
      assert.ok(await page.$(bill + '-status'));
      assert.ok(!(await page.$(bill + '-amt')) && !(await page.$(bill + '-on')), 'nothing to edit here');
      assert.equal(await page.getAttribute(bill + '-budget', 'href'), '#/budget?section=bills');
      assert.equal(await page.getAttribute('#plan-ch-goal-anniversary-trip-budget', 'href'), '#/budget?section=savings');
      assert.deepEqual(await page.$$eval('#plan-coming-strip .cu-item', gs => gs.map(g => g.dataset.item)), ['bill-life-insurance', 'goal-anniversary-trip']);
      // Childcare: start month and amount, $1,200 a month unless changed.
      await page.click('#plan-add-childcare > summary');
      assert.equal(await page.inputValue('#plan-pack-childcare-amt'), '1,200');
      await page.fill('#plan-pack-childcare-start', '2027-06');
      await page.click('#plan-pack-childcare-add');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.changes.length === 1);
      const cc = (await state(page)).plan.changes[0];
      assert.deepEqual([cc.label, cc.kind, cc.group, cc.startMonth, cc.endMonth, cc.cents, cc.accepted, cc.template, cc.scenario], ['Childcare', 'monthly', 'essentials', '2027-06', null, 120000, false, 'childcare', 'Childcare']);
      await page.waitForSelector('#plan-coming-strip .cu-item.is-pack.is-off');
      // Kid costs: from age 1, timed from the due date.
      await page.click('#plan-add-kids > summary');
      await page.fill('#plan-pack-kids-date', '2027-02-10');
      await page.click('#plan-pack-kids-add');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.changes.length === 6);
      const kids = (await state(page)).plan.changes.filter(c => c.template === 'kidCosts');
      assert.ok(kids.length === 5 && kids.every(c => c.startMonth === '2028-02' && c.scenario === 'Kid costs' && !c.accepted));
      // A change saved from the earlier Baby template: an ordinary change, listed, editable, on the strip as "Baby".
      const id = await page.evaluate(() => {
        const H = window.HouseholdBudget, E = H.engine;
        let st = H.getState();
        st = E.timeline.addChange(st, { label: 'Car seat', kind: 'oneTime', group: 'irregular', startMonth: '2027-01', cents: 25000, accepted: true, template: 'baby', note: 'A generic estimate: adjust it to your own quotes and plans.' });
        H.setState(st);
        return st.plan.changes.find(c => c.template === 'baby').id;
      });
      await page.waitForSelector(`#plan-ch-${id}-amt`);
      assert.match(await page.textContent(`#plan-ch-${id}-status`), /In plan/);
      assert.ok(await page.$('#plan-coming-strip .cu-item[data-item^="pack-baby-"]'));
      await typeAmount(page, `#plan-ch-${id}-amt`, '300');
      await page.waitForFunction(i => window.HouseholdBudget.getState().plan.changes.find(c => c.id === i).cents === 30000, id);
      assert.equal((await state(page)).plan.changes.find(c => c.id === id).template, 'baby', 'kept as saved');
      // The strip's labels never overlap.
      const overlaps = await page.$$eval('#plan-coming-strip .cu-label', ls => {
        const rs = ls.map(l => l.getBoundingClientRect());
        let n = 0;
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (rs[i].left < rs[j].right - 1 && rs[j].left < rs[i].right - 1 && rs[i].top < rs[j].bottom - 1 && rs[j].top < rs[i].bottom - 1) n++;
        return n;
      });
      assert.equal(overlaps, 0, 'labels on the strip overlap');
      assert.ok(await noHorizontalScroll(page));
      await t.shot('plan-coming-up');
    },
  },
  {
    name: 'investments: a balance-only investment account has its own line, chip and tile, never in combined cash',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const before = await timeline(page);
      await withInvestments(page);
      await page.waitForSelector('#plan-chart .cc-chip[data-cc-key="balance-investments"]');
      assert.equal((await page.textContent('#plan-chart .cc-chip[data-cc-key="balance-investments"]')).trim(), 'Investments');
      assert.equal(await page.getAttribute('#plan-chart .cc-chip[data-cc-key="balance-investments"]', 'aria-pressed'), 'true', 'shown by default');
      assert.ok(await page.$('#plan-chart g.series-4[data-cc-series="balance-investments"] path.line'), 'its own colour');
      const exp = await timeline(page);
      assert.equal(exp.cashThen, before.cashThen, 'combined cash is the same without and with investments');
      assert.equal((await page.textContent('#plan-kpi-invest .kpi-label')).trim(), 'Investments');
      assert.equal((await page.textContent('#plan-kpi-invest-sub')).trim(), 'not cash');
      assert.match((await page.textContent('#plan-kpi-invest-value')).replace(/\s+/g, ' '), /\$32k/);
      assert.ok(await page.$('#plan-dial-investing'), 'and a dial for what goes into them');
      assert.ok(await noHorizontalScroll(page));
    },
  },
  {
    name: 'goals: a savings goal reached in the plan is a diamond on the chart and on the strip',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.evaluate(() => {
        const H = window.HouseholdBudget;
        const st = H.getState();
        st.plan.savings.find(g => g.id === 'emergency').targetCents = 600000;
        H.setState(st);
      });
      const exp = await timeline(page);
      const reach = exp.goals.find(g => g.id === 'emergency').reachMonth;
      assert.ok(reach, 'reached within the plan');
      await page.waitForSelector(`#plan-chart .cc-ann.is-goal[data-cc-change="${reach}"]`);
      assert.ok(await page.$('#plan-coming-strip .cu-item.is-reach[data-item="goal-reach-emergency"]'));
      const model = await page.evaluate(() => JSON.parse(document.querySelector('#plan-chart script.cc-model').textContent));
      assert.ok(model.months.some(m => (m.pc || []).includes('Goal reached: Emergency cushion ($6,000)')));
    },
  },
  {
    name: 'dials: one short line under each; ⓘ opens what the dial is and its whole basis',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      assert.equal((await page.textContent('#plan-dial-essentials-basis')).trim(), '12-month average');
      assert.ok(!(await page.isVisible('#plan-dial-essentials-why')));
      await page.click('#plan-dial-essentials-info > summary');
      assert.ok(await page.isVisible('#plan-dial-essentials-sub'));
      assert.equal((await page.textContent('#plan-dial-essentials-sub')).trim(), 'The part that doesn’t move much');
      assert.match(await page.textContent('#plan-dial-essentials-why'), /^Average of /);
      const line = await page.$eval('.dial[data-dial="essentials"] .dial-foot', el => el.getBoundingClientRect().height);
      assert.ok(line <= 44, 'one line under the slider');
      assert.ok(await noHorizontalScroll(page));
    },
  },
];
