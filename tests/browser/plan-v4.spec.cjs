'use strict';
// Planned changes and the pieces around them: Edit plan's list (a group's changes as one folded
// row with one box, + Custom change, what pay, bills and goals add as read-only rows), the
// Overview's short Coming up list and its chart markers, the compact dials, one monthly figure on
// both screens, and Forecast's retirement. Synthetic sample only: it has two what-ifs copied from
// its saved scenarios (8 changes, not accepted).
const { noHorizontalScroll, state, whole } = require('./helpers.cjs');

/** The engine's model for the current state (real local today). */
function timeline(page) {
  return page.evaluate(() => {
    const H = window.HouseholdBudget, E = H.engine, ctx = H.context(), st = H.getState();
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const tl = E.timeline.build({ txns: ctx.realTxns, dataset: ctx.dataset, plan: st.plan, settings: st.ui.plan, today, coverageMap: ctx.coverageMap });
    return {
      planStart: tl.planStart, inCents: tl.summary.inCents, outCents: tl.summary.outCents,
      goals: tl.goals.map(g => ({ id: g.id, reachMonth: g.reachMonth })),
      changes: tl.changes.list.map(c => ({ id: c.id, label: c.label, scenario: c.scenario || null, status: c.status, readOnly: !!c.readOnly, startMonth: c.startMonth })),
    };
  });
}
/** Whole dollars with a sign, as the tiles show them. */
const signedWhole = cents => (cents > 0 ? '+' : '') + whole(cents);
/** What-ifs the sample copied from its saved scenarios. */
const SAMPLE_WHAT_IFS = ['Baby arrives (May 2027)', 'Home projects'];

module.exports = [
  {
    name: 'Forecast is retired: no nav entry; #/forecast opens the Overview; a scenario or compare link is dropped',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      await page.waitForFunction(() => location.hash === '#/overview');
      assert.equal((await page.textContent('#page-title')).trim(), 'Overview');
      assert.equal(await page.$$eval('[data-nav="forecast"], a[href^="#/forecast"]', x => x.length), 0, 'no link to Forecast anywhere');
      const scenarios = (await state(page)).scenarios.map(s => s.id);
      await page.goto(t.url + '#/forecast?scenario=baby-arrives');
      await page.waitForFunction(() => location.hash === '#/overview');
      assert.equal(await page.$$eval('#plan-compare', x => x.length), 0, 'no Compare');
      assert.deepEqual((await state(page)).scenarios.map(s => s.id), scenarios, 'saved scenarios untouched');
      assert.ok(await noHorizontalScroll(page));
    },
  },
  {
    name: 'Edit plan: a group’s changes are one folded row; one box accepts them all; open, each change keeps its own controls; + Custom change',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      assert.equal((await page.textContent('#plan-changes-h')).trim(), 'Planned changes');
      const groups = () => page.$$eval('#plan-ch-list > li.plan-ch-group', ls => ls.map(l => l.dataset.group));
      for (const n of SAMPLE_WHAT_IFS) assert.ok((await groups()).includes(n), n + ' is one row');
      // No packs to add, no Accept all: only a change of the household's own.
      assert.equal(await page.$$eval('#plan-add-baby, #plan-add-childcare, #plan-add-kids, #plan-ch-accept-all, #plan-ch-unaccept-all, #plan-coming-strip', x => x.length), 0);
      assert.deepEqual(await page.$$eval('#plan-add > details > summary', ss => ss.map(x => x.textContent.replace('+', '').trim())), ['Custom change']);
      const home = '#plan-ch-list > li.plan-ch-group[data-group="Home projects"]';
      assert.match((await page.textContent(home + ' .plan-grp-meta')).trim(), /^3 items$/);
      assert.equal(await page.isVisible('#plan-ch-sc-attic-insulation-amt'), false, 'folded until opened');
      // The baby group: one box accepts every change in it; the plan follows.
      const baby = '#plan-ch-list > li.plan-ch-group[data-group="Baby arrives (May 2027)"]';
      const ids = (await timeline(page)).changes.filter(c => c.scenario === 'Baby arrives (May 2027)').map(c => c.id);
      assert.ok(ids.length > 1);
      await page.check(baby + ' .plan-grp-accept input');
      await page.waitForFunction(list => window.HouseholdBudget.getState().plan.changes.filter(c => list.includes(c.id)).every(c => c.accepted), ids);
      // Each change inside keeps its own controls and ids.
      await page.click(baby + ' details > summary');
      const one = ids[0];
      await page.uncheck(`#plan-ch-${one}-on`);
      await page.waitForFunction(i => !window.HouseholdBudget.getState().plan.changes.find(c => c.id === i).accepted, one);
      await page.waitForFunction(s => document.querySelector(s + ' .plan-grp-accept input').indeterminate === true, baby);
      await page.fill(`#plan-ch-${one}-amt`, '321');
      await page.press(`#plan-ch-${one}-amt`, 'Enter');
      await page.waitForFunction(i => window.HouseholdBudget.getState().plan.changes.find(c => c.id === i).cents === 32100, one);
      await page.click(baby + ' .plan-grp-accept input');
      await page.waitForFunction(list => window.HouseholdBudget.getState().plan.changes.filter(c => list.includes(c.id)).every(c => c.accepted), ids);
      // What pay, bills and goals add stays a single read-only row.
      assert.equal(await page.$$eval('#plan-ch-list > li[data-change="bill-life-insurance"]', x => x.length), 1);
      assert.equal(await page.$$eval('#plan-ch-list > li[data-change="bill-life-insurance"] input', x => x.length), 0);
      // + Custom change: added, accepted, and listed on the Overview's Coming up.
      await page.click('#plan-add-custom > summary');
      await page.fill('#plan-ch-new-label', 'Roof repair');
      await page.fill('#plan-ch-new-start', '2026-11');
      await page.fill('#plan-ch-new-amt', '2,000');
      await page.click('#plan-ch-new-add');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.changes.some(c => c.label === 'Roof repair' && c.accepted));
      const roof = (await state(page)).plan.changes.find(c => c.label === 'Roof repair');
      await page.waitForSelector(`#plan-ch-list > li[data-change="${roof.id}"]`);
      // Removed again: the next row's remove button takes focus.
      await page.click(`#plan-ch-${roof.id}-remove`);
      await page.waitForFunction(i => !window.HouseholdBudget.getState().plan.changes.some(c => c.id === i), roof.id);
      assert.ok(await noHorizontalScroll(page));
      await t.shot('edit-plan-changes');
    },
  },
  {
    name: 'Overview: Coming up lists a group as one line with its totals; the chart marks accepted changes and goals',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const lines = () => page.$$eval('#plan-coming-list > li', ls => ls.map(l => ({ key: l.dataset.key, text: l.textContent.replace(/\s+/g, ' ').trim(), off: l.classList.contains('is-off') })));
      const before = await lines();
      const baby = before.find(l => l.key === 'group-Baby arrives (May 2027)');
      assert.ok(baby, 'the baby group is one line: ' + before.map(l => l.text).join(' | '));
      // The baby-cost defaults (setup, supplies, childcare) are in the plan from the month before the due date.
      assert.match(baby.text, /^Apr 2027 Baby arrives \(May 2027\) \d+ of \d+ in the plan/);
      assert.ok(before.some(l => l.key === 'bill-life-insurance' && /Bill/.test(l.text)), 'a bill from Edit plan, labelled');
      // A goal reached within the plan: a line here and a diamond on the chart.
      await page.evaluate(() => {
        const H = window.HouseholdBudget;
        const st = H.getState();
        st.plan.savings.find(g => g.id === 'emergency').targetCents = 600000;
        for (const c of st.plan.changes) if (c.scenario === 'Baby arrives (May 2027)') c.accepted = true;
        H.setState(st);
      });
      await t.settled();
      const exp = await timeline(page);
      const reach = exp.goals.find(g => g.id === 'emergency').reachMonth;
      assert.ok(reach, 'reached within the plan');
      await page.waitForSelector(`#plan-chart .cc-ann.is-goal[data-cc-change="${reach}"]`);
      const model = await page.evaluate(() => JSON.parse(document.querySelector('#plan-chart script.cc-model').textContent));
      assert.ok(model.months.some(m => (m.pc || []).includes('Goal reached: Emergency cushion ($6,000)')));
      // Accepted, the group is marked on the chart under its own name.
      assert.ok(model.months.some(m => (m.pc || []).some(x => /^Planned: /.test(x))), 'planned changes are in the readout');
      const after = await lines();
      assert.ok(after.length <= 6, 'a short list');
      assert.equal(await page.$$eval('#plan-coming input, #plan-coming button', x => x.length), 0, 'nothing to edit on the Overview');
    },
  },
  {
    name: 'dials: one short line under each; ⓘ opens what the dial is and its whole basis; no "assistant-only" labels',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
      assert.equal((await page.textContent('#plan-dial-essentials-basis')).trim(), '12-month average');
      assert.ok(!(await page.isVisible('#plan-dial-essentials-why')));
      await page.click('#plan-dial-essentials-info > summary');
      assert.ok(await page.isVisible('#plan-dial-essentials-sub'));
      assert.equal((await page.textContent('#plan-dial-essentials-sub')).trim(), 'The part that doesn’t move much');
      assert.match(await page.textContent('#plan-dial-essentials-why'), /^Average of /);
      const line = await page.$eval('.dial[data-dial="essentials"] .dial-foot', el => el.getBoundingClientRect().height);
      assert.ok(line <= 44, 'one line under the slider');
      assert.ok(!/assistant/i.test(await page.textContent('#view')), 'no control is labelled for an assistant');
      assert.ok(await noHorizontalScroll(page));
    },
  },
  {
    name: 'one monthly figure: the Overview’s margin is income − outgoing of the plan month, bills from Edit plan included',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const exp = await timeline(page);
      assert.equal((await page.textContent('#plan-kpi-margin-value')).trim(), signedWhole(exp.inCents - exp.outCents));
      // The life insurance bill ($40 a month) is part of outgoing in the plan month.
      await page.click('#plan-kpi-out');
      await page.waitForSelector('#plan-month');
      await page.click('#plan-month-grp-essentials > summary').catch(() => {});
      const text = await page.textContent('#plan-month-outlist');
      assert.match(text, /Life insurance/);
      assert.equal((await page.textContent('#plan-month-out')).trim(), whole(exp.outCents));
    },
  },
  {
    name: 'pay with an end date changes money in from the month after, listed read-only with a link to Pay and income',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget');
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
      assert.match((await link.textContent()).trim(), /^Pay/);
      assert.match(await link.getAttribute('href'), /^#\/budget\?section=income/);
      await link.click();
      await page.waitForFunction(() => document.getElementById('bud-area-income').open);
    },
  },
];
