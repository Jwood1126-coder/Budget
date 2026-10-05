'use strict';
// Plan (#/overview), the finished-product pieces: the tiles above the chart, Compare (a what-if as
// its own line), the markers for changes and goals, Coming up (the strip, the packs, what Budget
// adds; a pack's or a what-if's changes as one folded row), the investments line, the compact
// dials and Forecast's retirement. Synthetic sample only: it has a balance-only brokerage account
// and two what-ifs copied from its saved scenarios (8 changes, not accepted).
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
      // The month's figures as Budget shows them: the dials plus what the month adds (a bill Budget adds, accepted changes).
      planStart: tl.planStart, now, then, combinedChange: tl.summary.inCents - tl.summary.outCents, net: tl.summary.leftCents, savings: tl.summary.savingsCents,
      cashNow: at(tl.balances.combined.points, now), cashThen: at(tl.balances.combined.points, then),
      savNow: sav.reduce((s, a) => s + at(a.points, now), 0), savThen: sav.reduce((s, a) => s + at(a.points, then), 0),
      combinedLast: tl.balances.combined.points[tl.balances.combined.points.length - 1],
      combinedMembers: tl.balances.combined.members || null,
      invNow: tl.balances.investments ? at(tl.balances.investments.points, now) : null,
      invThen: tl.balances.investments ? at(tl.balances.investments.points, then) : null,
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
/** What-ifs the sample copied from its saved scenarios. */
const SAMPLE_WHAT_IFS = ['Baby arrives (May 2027)', 'Home projects'];
/** Changes saved in the budget now. */
const changeCount = page => page.evaluate(() => window.HouseholdBudget.getState().plan.changes.length);

module.exports = [
  {
    name: 'tiles: monthly on this plan is the all-accounts change (never checking’s), cash in 12 months and savings from the engine; two by two on a phone',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const exp = await timeline(page);
      const labels = await page.$$eval('#plan-kpis .kpi-label', ls => ls.map(l => l.textContent.trim()));
      assert.deepEqual(labels, ['Monthly on this plan', 'Cash in 12 months', 'Savings', 'Investments'], 'no warning tile while the sample stays above $0');
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
        assert.ok(boxes[2].y > boxes[0].y && boxes[2].x === boxes[0].x && boxes[3].y === boxes[2].y, 'two by two');
        // The plot still starts in the first screen.
        const top = await page.evaluate(() => document.querySelector('#plan-chart-plot').getBoundingClientRect().top / innerHeight);
        assert.ok(top < 0.66, 'plot starts at ' + Math.round(top * 100) + '% of the screen');
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
      assert.deepEqual(await page.$$eval('#plan-compare option', os => os.map(o => o.value)), [''].concat(SAMPLE_WHAT_IFS), 'the sample’s what-ifs');
      await addBaby(page, '2027-02-10');
      await page.waitForFunction(() => [...document.querySelectorAll('#plan-compare option')].some(o => o.value === 'New baby'));
      assert.deepEqual(await page.$$eval('#plan-compare option', os => os.map(o => o.value)), [''].concat(SAMPLE_WHAT_IFS, ['New baby']));
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
      assert.equal(await page.$$eval('#plan-compare', x => x.length), 0);
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
      assert.ok(!!(await page.$(bill + '-status')));
      assert.ok(!(await page.$(bill + '-amt')) && !(await page.$(bill + '-on')), 'nothing to edit here');
      assert.equal(await page.getAttribute(bill + '-budget', 'href'), '#/budget?section=bills');
      assert.equal(await page.getAttribute('#plan-ch-goal-anniversary-trip-budget', 'href'), '#/budget?section=savings');
      const items = await page.$$eval('#plan-coming-strip .cu-item', gs => gs.map(g => g.dataset.item));
      for (const key of ['bill-life-insurance', 'goal-anniversary-trip', ...SAMPLE_WHAT_IFS.map(n => 'group-' + n)]) assert.ok(items.includes(key), key + ' on the strip');
      const n0 = await changeCount(page);
      // Childcare: start month and amount, $1,200 a month unless changed.
      await page.click('#plan-add-childcare > summary');
      assert.equal(await page.inputValue('#plan-pack-childcare-amt'), '1,200');
      await page.fill('#plan-pack-childcare-start', '2027-06');
      await page.click('#plan-pack-childcare-add');
      await page.waitForFunction(n => window.HouseholdBudget.getState().plan.changes.length === n + 1, n0);
      const cc = (await state(page)).plan.changes.find(c => c.template === 'childcare');
      assert.deepEqual([cc.label, cc.kind, cc.group, cc.startMonth, cc.endMonth, cc.cents, cc.accepted, cc.template, cc.scenario], ['Childcare', 'monthly', 'essentials', '2027-06', null, 120000, false, 'childcare', 'Childcare']);
      await page.waitForSelector('#plan-coming-strip .cu-item.is-pack.is-off');
      // Kid costs: from age 1, timed from the due date.
      await page.click('#plan-add-kids > summary');
      await page.fill('#plan-pack-kids-date', '2027-02-10');
      await page.click('#plan-pack-kids-add');
      await page.waitForFunction(n => window.HouseholdBudget.getState().plan.changes.length === n + 6, n0);
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
      assert.ok(!!(await page.$('#plan-coming-strip .cu-item[data-item="group-Baby"]')));
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
    name: 'investments: the sample’s balance-only brokerage account has its own line, chip and tile, never in combined cash',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const exp = await timeline(page);
      assert.ok(exp.combinedMembers && !exp.combinedMembers.includes('joint-brokerage'), 'not part of combined cash');
      await page.waitForSelector('#plan-chart .cc-chip[data-cc-key="balance-investments"]');
      assert.equal((await page.textContent('#plan-chart .cc-chip[data-cc-key="balance-investments"]')).trim(), 'Investments');
      assert.equal(await page.getAttribute('#plan-chart .cc-chip[data-cc-key="balance-investments"]', 'aria-pressed'), 'true', 'shown by default');
      assert.equal(await page.$$eval('#plan-chart g.series-4[data-cc-series="balance-investments"] path.line', x => x.length) > 0, true, 'its own colour');
      assert.equal((await page.textContent('#plan-kpi-invest .kpi-label')).trim(), 'Investments');
      assert.equal((await page.textContent('#plan-kpi-invest-sub')).trim(), 'not cash');
      assert.equal((await page.textContent('#plan-kpi-invest-value')).replace(/\s+/g, ' ').trim(), `${compact(exp.invNow)}→ to ${compact(exp.invThen)}`);
      assert.equal(await page.$$eval('#plan-dial-investing', x => x.length), 1, 'and a dial for what goes into them');
      // Without an investment account: no line, no tile.
      await page.evaluate(() => {
        const ds = JSON.parse(JSON.stringify(window.HouseholdBudget.getDataset()));
        const inv = new Set(ds.accounts.filter(a => a.type === 'investment').map(a => a.id));
        ds.accounts = ds.accounts.filter(a => !inv.has(a.id));
        ds.balances = ds.balances.filter(b => !inv.has(b.accountId));
        ds.transactions = ds.transactions.filter(x => !inv.has(x.accountId));
        localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: ds, loadedAt: new Date().toISOString(), source: 'json', file: 'no-investments.json' }));
      });
      await page.reload();
      await page.waitForSelector('#plan-kpis');
      assert.equal(await page.$$eval('#plan-kpi-invest, #plan-chart .cc-chip[data-cc-key="balance-investments"]', x => x.length), 0);
      assert.ok(await noHorizontalScroll(page));
    },
  },
  {
    name: 'Coming up: a pack’s items and a what-if’s changes are one folded row; one box accepts them all; open, each change keeps its own controls',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const groups = () => page.$$eval('#plan-ch-list > li.plan-ch-group', ls => ls.map(l => l.dataset.group));
      for (const n of SAMPLE_WHAT_IFS) assert.ok((await groups()).includes(n), n + ' is one row');
      // The sample's copied what-ifs are folded: their lines are not shown until opened.
      const home = '#plan-ch-list > li.plan-ch-group[data-group="Home projects"]';
      assert.match((await page.textContent(home + ' .plan-grp-meta')).trim(), /^3 items$/);
      assert.equal(await page.isVisible('#plan-ch-sc-attic-insulation-amt'), false);
      // A pack added: one row, open, its box focused; the totals in a few words.
      await addBaby(page, '2027-02-10');
      const baby = '#plan-ch-list > li.plan-ch-group[data-group="New baby"]';
      await page.waitForSelector(baby);
      assert.equal(await page.$eval(baby + ' details', d => d.open), true, 'opens once, to check the amounts');
      assert.match(await page.evaluate(() => document.activeElement.id), /^plan-grp-new-baby-.+-on$/);
      assert.match((await page.textContent(baby + ' .plan-grp-meta')).replace(/\s+/g, ' ').trim(), /^9 items · \$[\d.]+k once \+ \$\d+\/mo$/);
      assert.match((await page.textContent(baby + ' .plan-ch-status')).replace(/\s+/g, ' '), /Not accepted.*1 not set/);
      assert.equal(await page.$$eval(baby + ' .plan-ch-sublist > li', x => x.length), 9);
      // One box accepts the whole pack; the plan follows.
      await page.check(baby + ' .plan-grp-accept input');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.changes.filter(c => c.scenario === 'New baby').every(c => c.accepted));
      await page.waitForFunction(s => /8 of 9 in plan/.test(document.querySelector(s + ' .plan-ch-status').textContent), baby);
      // Each change inside keeps its own controls and ids.
      const one = (await state(page)).plan.changes.find(c => c.scenario === 'New baby' && c.kind === 'oneTime');
      await page.uncheck(`#plan-ch-${one.id}-on`);
      await page.waitForFunction(i => !window.HouseholdBudget.getState().plan.changes.find(c => c.id === i).accepted, one.id);
      await page.waitForFunction(s => document.querySelector(s + ' .plan-grp-accept input').indeterminate === true, baby);
      await page.fill(`#plan-ch-${one.id}-amt`, '321');
      await page.press(`#plan-ch-${one.id}-amt`, 'Enter');
      await page.waitForFunction(i => window.HouseholdBudget.getState().plan.changes.find(c => c.id === i).cents === 32100, one.id);
      // Mixed, then pressed: all accepted; pressed again: none.
      await page.click(baby + ' .plan-grp-accept input');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.changes.filter(c => c.scenario === 'New baby').every(c => c.accepted));
      await page.click(baby + ' .plan-grp-accept input');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.changes.filter(c => c.scenario === 'New baby').every(c => !c.accepted));
      // Custom changes and what Budget adds stay single rows.
      assert.equal(await page.$$eval('#plan-ch-list > li[data-change="bill-life-insurance"]', x => x.length), 1);
      await page.click('#plan-add-custom > summary');
      await page.fill('#plan-ch-new-label', 'Roof repair');
      await page.fill('#plan-ch-new-amt', '2,000');
      await page.click('#plan-ch-new-add');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.changes.some(c => c.label === 'Roof repair'));
      const roof = (await state(page)).plan.changes.find(c => c.label === 'Roof repair');
      await page.waitForSelector(`#plan-ch-list > li[data-change="${roof.id}"]`);
      assert.ok(await noHorizontalScroll(page));
      await t.shot('plan-groups');
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
      assert.ok(!!(await page.$('#plan-coming-strip .cu-item.is-reach[data-item="goal-reach-emergency"]')));
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
  {
    name: 'one monthly figure: Plan’s tile and headline equal Budget’s, bills Budget adds included',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const tile = (await page.textContent('#plan-kpi-month-value')).trim();
      const exp = await timeline(page);
      assert.equal(tile, signedWhole(exp.combinedChange));
      const addup = (await page.textContent('#plan-addup')).trim();
      assert.match(addup, /− \$40 Life insurance/, 'the bill Budget adds is in the add-up: ' + addup);
      await t.nav('budget');
      await page.waitForSelector('#bud-net');
      assert.equal((await page.textContent('#bud-net .bud-hero-net-value')).trim(), tile);
    },
  },
  {
    name: 'pay with an end date in Budget changes money in from the month after, listed read-only with a link to Budget',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.evaluate(() => {
        const H = window.HouseholdBudget, s = H.getState();
        s.plan.incomes.find(i => i.id === 'p2-contribution').endMonth = '2027-01';
        H.setState(s);
      });
      await t.settled();
      const months = await page.evaluate(() => {
        const H = window.HouseholdBudget, E = H.engine, ctx = H.context(), st = H.getState();
        const tl = E.timeline.build({ txns: ctx.realTxns, dataset: ctx.dataset, plan: st.plan, settings: st.ui.plan, today: '2026-10-05', coverageMap: ctx.coverageMap });
        const at = m => tl.months.find(x => x.month === m);
        return { jan: at('2027-01').in.p2, feb: at('2027-02').in.p2, change: tl.changes.list.find(c => c.source === 'income') };
      });
      assert.equal(months.jan - months.feb, 265000, 'Sam’s transfers to joint stop after January');
      assert.deepEqual([months.change.id, months.change.startMonth, months.change.cents, months.change.status], ['pay-p2-2027-02', '2027-02', -265000, 'applied']);
      const link = page.locator('#plan-ch-pay-p2-2027-02-budget');
      assert.match((await link.textContent()).trim(), /^Pay · Budget/);
      assert.match(await link.getAttribute('href'), /^#\/budget\?section=income/);
    },
  },
];
