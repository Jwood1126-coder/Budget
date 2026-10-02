'use strict';
// Forecast view: scenarios (create, rename, delete, copy), isolation from the budget, events,
// missing amounts, parental leave, paycheck timing, horizon, comparison, settings, reload, phone.

/** Compared with the configured viewport: mobile emulation widens window.innerWidth to fit overflow. */
async function noHorizontalScroll(page) {
  const width = page.viewportSize().width;
  return page.evaluate(w => document.scrollingElement.scrollWidth <= w + 1 && window.innerWidth <= w + 1, width);
}
const state = page => page.evaluate(() => window.HouseholdBudget.getState());
const params = page => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || '')));

/** Exact cents behind a comparison cell (null when the value is unknown). */
async function cmpCents(page, key, scenarioId) {
  const v = await page.getAttribute(`#fc-compare [data-key="${key}"][data-scenario="${scenarioId}"]`, 'data-cents');
  return v === '' || v === null ? null : Number(v);
}
async function monthAttr(page, month, attr) {
  const v = await page.getAttribute(`#fc-m-${month}`, 'data-' + attr);
  return v === '' || v === null ? null : Number(v);
}

/** Create a scenario through the form; returns its id once it is selected. */
async function createScenario(page, name, copyFrom = '') {
  await page.fill('#fc-new-name', name);
  if (copyFrom) await page.selectOption('#fc-new-from', copyFrom);
  await page.click('#fc-new-submit');
  const id = await page.waitForFunction(n => {
    const s = window.HouseholdBudget.getState().scenarios.find(x => x.name === n);
    return s && location.hash.includes('scenario=' + encodeURIComponent(s.id)) && document.querySelector('#fc-editor-h')?.textContent === n ? s.id : null;
  }, name).then(h => h.jsonValue());
  return id;
}

/**
 * Move the caret to the year part of a focused month input (its position depends on the
 * browser's locale): ArrowUp changes the part that has the caret; if the year did not change,
 * the year is the next part.
 */
async function toYearPart(page, sel) {
  const before = await page.inputValue(sel);
  await page.keyboard.press('ArrowUp');
  const after = await page.inputValue(sel);
  if (after.slice(0, 4) === before.slice(0, 4)) await page.keyboard.press('ArrowRight');
}

async function eventsOf(page, id) {
  return page.evaluate(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events, id);
}

module.exports = [
  {
    name: 'a new named scenario with a one-time home repair changes only that scenario, by exactly the repair',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      assert.equal(await page.textContent('#page-title'), 'Plan ahead with scenarios');
      assert.ok((await page.textContent('.fc-rule')).includes('never change what actually happened or your budget'));
      const baseEnd = await cmpCents(page, 'endCumulative', 'baseline');
      assert.ok(Number.isInteger(baseEnd), 'baseline end change is known for the sample in joint scope');
      const planBefore = JSON.stringify((await state(page)).plan);

      const id = await createScenario(page, 'New roof test');
      assert.ok((await state(page)).compareIds.includes(id), 'a new scenario joins the comparison when there is room');
      assert.equal(await cmpCents(page, 'endCumulative', id), baseEnd, 'a blank scenario equals the current budget');

      await page.click('#fc-tpl-repair-windows');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events.length === 1, id);
      // Focus moves to the first blank field of the new change (its amount).
      await page.waitForFunction(() => (document.activeElement?.dataset.bind || '').endsWith('.amountCents'));
      const item = page.locator('.fc-ev-list > li').last();
      assert.ok((await item.textContent()).includes('Amount missing'), 'blank amount is flagged on the change');
      await item.locator('input[data-bind$=".amountCents"]').fill('4000');
      await item.locator('input[data-bind$=".amountCents"]').press('Enter');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events[0].amountCents === 400000, id);
      await page.locator('.fc-ev-list > li').last().locator('input[data-bind$=".month"]').fill('2027-06');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events[0].month === '2027-06', id);
      await page.waitForFunction(([sid, v]) => document.querySelector(`#fc-compare [data-key="endCumulative"][data-scenario="${sid}"]`)?.dataset.cents === String(v), [id, baseEnd - 400000]);

      assert.equal(await cmpCents(page, 'endCumulative', id), baseEnd - 400000, 'scenario end change is lower by exactly the repair');
      assert.equal(await cmpCents(page, 'endCumulative', 'baseline'), baseEnd, 'the current budget is unchanged');
      const st = await state(page);
      assert.equal(st.scenarios[0].events.length, 0, 'baseline holds no changes');
      assert.equal(JSON.stringify(st.plan), planBefore, 'the budget itself is unchanged');
      assert.equal(st.scenarios.find(s => s.id === 'baby-arrives').events.length, 4, 'other scenarios untouched');
      // The month of the repair shows it, flagged where cash goes down.
      const net = await monthAttr(page, '2027-06', 'net-cents');
      const prev = await monthAttr(page, '2027-05', 'net-cents');
      assert.equal(prev - net, 400000, 'the repair lands in June 2027 only');
      assert.ok(await noHorizontalScroll(page), 'no horizontal page scroll');
      await t.shot('fc-scenario-repair');
    },
  },
  {
    name: 'a change with a blank amount is listed as missing, linked to its field and not counted',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      const id = await createScenario(page, 'Insulation quote pending');
      const before = await cmpCents(page, 'endCumulative', id);
      await page.click('#fc-tpl-repair-insulation');
      await page.waitForSelector('#fc-missing-events');
      assert.ok((await page.textContent('#fc-missing-events')).includes('Attic insulation: month not set'), 'undated change is missing');
      await page.locator('.fc-ev-list > li').last().locator('input[data-bind$=".month"]').fill('2027-02');
      await page.waitForFunction(() => document.querySelector('#fc-missing-events')?.textContent.includes('Attic insulation: amount not entered'));
      assert.equal(await cmpCents(page, 'endCumulative', id), before, 'a missing amount is not counted as $0 or anything else');
      assert.ok(await page.isVisible('#fc-m-2027-02 .fc-flag-missing'), 'the month shows a missing-amount badge');
      assert.equal(await cmpCents(page, 'missing', id), null);
      const missingCount = Number(await page.textContent(`#fc-compare [data-key="missing"][data-scenario="${id}"]`));
      const baseMissing = Number(await page.textContent('#fc-compare [data-key="missing"][data-scenario="baseline"]'));
      assert.equal(missingCount, baseMissing + 1, 'comparison counts the missing cost');
      // "Enter it" moves focus to the amount field of that change.
      await page.locator('#fc-missing-events li', { hasText: 'Attic insulation' }).locator('button').click();
      await page.waitForFunction(() => (document.activeElement?.dataset.bind || '').endsWith('.amountCents'));
      await t.shot('fc-missing');
    },
  },
  {
    name: 'parental leave lowers income only in its months, and its form validates inline',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      const id = await createScenario(page, 'Leave test');
      await page.click('#fc-tpl-leave');
      await page.waitForSelector('#fc-tpl-stream');
      await page.waitForFunction(() => document.activeElement?.id === 'fc-tpl-stream');
      await page.selectOption('#fc-tpl-stream', 'p1-pay');
      await page.click('#fc-tpl-submit');
      await page.waitForSelector('#fc-tpl-start-error:not([hidden])');
      assert.equal(await page.textContent('#fc-tpl-start-error'), 'Choose a month.');
      assert.equal((await eventsOf(page, id)).length, 0, 'nothing added while the form is invalid');
      await page.fill('#fc-tpl-start', '2027-02');
      await page.fill('#fc-tpl-end', '2027-04');
      await page.fill('#fc-tpl-joint', '500');
      await page.fill('#fc-tpl-net', '600');
      await page.click('#fc-tpl-submit');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events.length === 1, id);
      const ev = (await eventsOf(page, id))[0];
      assert.equal(ev.type, 'income_change');
      assert.equal(ev.streamId, 'p1-pay');
      assert.equal(ev.jointPerPaycheckCents, 50000);
      assert.equal(ev.netPerPaycheckCents, 60000);
      await page.waitForFunction(() => document.querySelector('#fc-m-2027-02')?.dataset.incomeCents !== document.querySelector('#fc-m-2027-01')?.dataset.incomeCents);
      // Forecasts count actual paydays: each of Alex's paychecks in a leave month brings $500 to
      // joint instead of $1,880. Compare every month with the same scenario without the change.
      const expected = await page.evaluate(sid => {
        const st = window.HouseholdBudget.getState();
        const E = window.HouseholdBudget.engine;
        const sc = st.scenarios.find(s => s.id === sid);
        const ctx = window.HouseholdBudget.context();
        const without = E.forecast.project(st.plan, { ...sc, events: [] }, { startMonth: ctx.forecastStart, months: 24, scope: 'joint' });
        const alex = st.plan.incomes.find(i => i.id === 'p1-pay');
        return without.rows.map(r => ({ month: r.month, income: r.incomeCents, checks: E.schedule.count(alex, r.month, 'actual').count }));
      }, id);
      let leaveMonths = 0;
      for (const row of expected) {
        const shown = await monthAttr(page, row.month, 'income-cents');
        const onLeave = row.month >= '2027-02' && row.month <= '2027-04';
        if (onLeave) leaveMonths++;
        assert.equal(shown, onLeave ? row.income - row.checks * (188000 - 50000) : row.income, `income in ${row.month}`);
      }
      assert.equal(leaveMonths, 3, 'three months of leave inside the forecast');
      assert.ok(expected.some(r => r.month >= '2027-02' && r.month <= '2027-04' && r.checks === 3), 'a three-paycheck month falls inside the leave');
      const jan = await monthAttr(page, '2027-01', 'income-cents');
      // Unknown leave pay: blank the joint amount and those months become unknown, not $0.
      const joint = page.locator(`input[data-bind="scenarios[id=${id}].events[id=${ev.id}].jointPerPaycheckCents"]`);
      await joint.fill('');
      await joint.press('Enter');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events[0].jointPerPaycheckCents === null, id);
      await page.waitForFunction(() => document.querySelector('#fc-m-2027-02')?.dataset.incomeCents === '');
      assert.equal(await monthAttr(page, '2027-01', 'income-cents'), jan);
      assert.ok((await page.textContent('#fc-m-2027-02 summary')).includes('Unknown'));
      assert.equal((await page.textContent('#fc-m-2027-02 .fc-flag-unknown')).trim(), '!Income unknown', 'the badge says what is unknown');
      await page.click('#fc-m-2027-02 > summary');
      assert.ok((await page.textContent('#fc-m-2027-02 .fc-month-body')).includes('some income this month is not entered: Alex paycheck'), 'names the income');
      // After the leave, each month's net is known again but the running total stays unknown.
      assert.ok((await page.textContent('#fc-m-2027-06 .fc-c-cum')).includes('since Feb 2027'));
      assert.equal(await cmpCents(page, 'endCumulative', id), null, 'end change is unknown while leave pay is unknown');
      const cmpText = await page.textContent('#fc-compare');
      assert.ok(cmpText.includes('Unknown from Feb 2027'));
      assert.ok(cmpText.includes('Missing: Alex parental leave'), 'names the missing input: ' + cmpText.slice(0, 400));
      // The lowest point and the count of months with cash going down describe known months only.
      const cellText = key => page.$eval(`#fc-compare [data-key="${key}"][data-scenario="${id}"]`, el => el.closest('td').textContent);
      assert.ok((await cellText('lowest')).includes('Known months only'));
      assert.ok((await cellText('negativeMonths')).includes('Known months only'));
      const baseLowest = await page.$eval('#fc-compare [data-key="lowest"][data-scenario="baseline"]', el => el.closest('td').textContent);
      assert.ok(!baseLowest.includes('Known months only'), 'the current budget is known in every month');
      assert.ok((await page.textContent('#fc-editor .fc-result')).includes('known months only'), 'the result strip says so too');
      await t.shot('fc-leave');
    },
  },
  {
    name: 'actual paydays show the biweekly third paycheck; a typical month does not',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      const id = await createScenario(page, 'Timing test');
      // Forecasts count actual paydays by default, so Alex's biweekly pay shows its third paycheck.
      assert.equal((await state(page)).scenarios.find(s => s.id === id).assumptions.incomeTiming, 'actual');
      await page.waitForSelector('#fc-m-2026-10 .fc-flag-extra');
      assert.ok((await page.textContent('#fc-m-2026-10 .fc-flag-extra')).includes('3 paychecks'));
      assert.ok((await page.$$eval('.fc-month .fc-flag-extra', els => els.length)) >= 2, 'two or more three-paycheck months in 24 months');
      assert.ok((await page.textContent('#fc-m-2026-10 .fc-c-pay')).includes('Alex 3'), 'paychecks counted per stream');
      await page.click('#fc-m-2026-10 > summary');
      const detail = await page.textContent('#fc-m-2026-10 .fc-month-body');
      assert.ok(detail.includes('3 paydays (Oct 2, 16 and 30)'), 'real paydays are listed: ' + detail.slice(0, 200));
      const octIn = await monthAttr(page, '2026-10', 'income-cents');
      const novIn = await monthAttr(page, '2026-11', 'income-cents');
      assert.equal(octIn - novIn, 188000, 'the third paycheck adds one joint deposit');
      await page.click('#fc-settings > summary');
      assert.ok((await page.textContent('#fc-settings')).includes('Twice-monthly pay'), 'explains biweekly vs twice-monthly');
      // Typical month: never the third paycheck, so every month has the same pay.
      await page.selectOption('#fc-timing', 'conservative');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).assumptions.incomeTiming === 'conservative', id);
      await page.waitForFunction(() => !document.querySelector('.fc-month .fc-flag-extra'));
      assert.equal(await monthAttr(page, '2026-10', 'income-cents'), novIn, 'typical month: October like any other month');
      // The comparison warns that the scenarios are now calculated differently, and can align them.
      assert.ok(await page.isVisible('#fc-align'));
      await t.shot('fc-timing');
      await page.click('#fc-align');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).assumptions.incomeTiming === 'actual', id);
      await page.waitForFunction(() => !document.querySelector('#fc-align'));
      await page.waitForSelector('#fc-m-2026-10 .fc-flag-extra');
    },
  },
  {
    name: 'the horizon control changes the number of months and is part of the URL',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      assert.equal(await page.$$eval('.fc-month', els => els.length), 24);
      await page.click('label[for^="fc-horizon-12"]');
      await page.waitForFunction(() => document.querySelectorAll('.fc-month').length === 12);
      assert.equal((await params(page)).horizon, '12');
      assert.equal(await page.$$eval('#fc-chart .chart-table tbody tr', els => els.length), 12, 'chart table follows the horizon');
      await page.click('label[for^="fc-horizon-60"]');
      await page.waitForFunction(() => document.querySelectorAll('.fc-month').length === 60);
      await page.click('label[for^="fc-horizon-36"]');
      await page.waitForFunction(() => document.querySelectorAll('.fc-month').length === 36);
      await page.goBack();
      await page.waitForFunction(() => document.querySelectorAll('.fc-month').length === 60);
      // The start month moves the window and can be reset.
      await page.fill('#fc-start', '2027-01');
      await page.waitForFunction(() => location.hash.includes('start=2027-01'));
      await page.waitForSelector('#fc-m-2027-01');
      assert.equal(await page.$$eval('#fc-m-2026-12', els => els.length), 0);
      await page.click('#fc-start-reset');
      await page.waitForFunction(() => !location.hash.includes('start='));
    },
  },
  {
    name: 'comparing two scenarios draws two lines and two columns; ticking a third adds one; at most three',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      assert.deepEqual((await state(page)).compareIds, ['baseline', 'baby-arrives']);
      assert.equal(await page.$$eval('#fc-chart path.line', els => els.length), 2);
      assert.equal(await page.$$eval('#fc-compare .fc-cmp-table thead th', els => els.length), 3, 'measure column + 2 scenarios');
      const legend = await page.$$eval('#fc-chart .chart-legend li', els => els.map(e => e.textContent.trim()));
      assert.deepEqual(legend, ['Current budget', 'Baby arrives (May 2027)']);
      await page.check('input[data-action="fc:compare"][data-id="home-projects-scenario"]');
      await page.waitForFunction(() => document.querySelectorAll('#fc-chart path.line').length === 3);
      assert.equal(await page.$$eval('#fc-compare .fc-cmp-table thead th', els => els.length), 4);
      assert.deepEqual((await state(page)).compareIds, ['baseline', 'baby-arrives', 'home-projects-scenario']);
      // A fourth scenario cannot be ticked while three are compared.
      const id = await createScenario(page, 'Fourth');
      assert.ok(!(await state(page)).compareIds.includes(id), 'no room: not added to the comparison');
      assert.ok(await page.isDisabled(`input[data-action="fc:compare"][data-id="${id}"]`));
      await page.uncheck('input[data-action="fc:compare"][data-id="baby-arrives"]');
      await page.waitForFunction(() => document.querySelectorAll('#fc-chart path.line').length === 2);
      assert.ok(await page.isEnabled(`input[data-action="fc:compare"][data-id="${id}"]`));
      // Differences are against the first column.
      assert.ok((await page.textContent('#fc-compare')).includes('compare each scenario with Current budget'));
      await t.shot('fc-compare');
    },
  },
  {
    name: 'rename inline and delete with a confirmation dialog (cancel keeps it, undo restores it)',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      const id = await createScenario(page, 'Rename me');
      await page.click(`button[data-action="fc:rename-open"][data-id="${id}"]`);
      await page.waitForFunction(() => document.activeElement?.id === 'fc-rename-name');
      await page.fill('#fc-rename-name', '');
      await page.click('#fc-rename-save');
      await page.waitForSelector('#fc-rename-name-error:not([hidden])');
      await page.fill('#fc-rename-name', 'Renamed scenario');
      await page.click('#fc-rename-save');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).name === 'Renamed scenario', id);
      await page.waitForFunction(sid => document.querySelector(`[data-scenario-id="${sid}"] .fc-sc-name`)?.textContent === 'Renamed scenario', id);
      assert.equal(await page.textContent('#fc-editor-h'), 'Renamed scenario');
      assert.equal(await page.$$eval('#fc-rename-name', els => els.length), 0, 'the inline form closes');
      const renameBtn = await page.evaluate(sid => window.BudgetUI.dom.domId('fc-ren', sid), id);
      await page.waitForFunction(b => document.activeElement?.id === b, renameBtn);

      // The current budget has no delete button.
      assert.equal(await page.$$eval('button[data-action="fc:delete"][data-id="baseline"]', els => els.length), 0);
      await page.click(`button[data-action="fc:delete"][data-id="${id}"]`);
      await page.waitForSelector('#dialog[open]');
      assert.ok((await page.textContent('#dialogTitle')).includes('Renamed scenario'));
      await page.click('#dialog button[value="cancel"]');
      await page.waitForFunction(() => !document.querySelector('#dialog').open);
      assert.ok((await state(page)).scenarios.some(s => s.id === id), 'cancel keeps it');
      const delBtn = await page.evaluate(sid => window.BudgetUI.dom.domId('fc-del', sid), id);
      await page.waitForFunction(b => document.activeElement?.id === b, delBtn);
      await page.click(`button[data-action="fc:delete"][data-id="${id}"]`);
      await page.waitForSelector('#dialog[open]');
      await page.click('#dialog button[value="ok"]');
      await page.waitForFunction(sid => !window.HouseholdBudget.getState().scenarios.some(s => s.id === sid), id);
      await page.waitForFunction(sid => !document.querySelector(`[data-scenario-id="${sid}"]`), id);
      await page.waitForFunction(() => document.activeElement?.id === 'fc-scenarios-h', 'focus lands on the scenario list');
      const st = await state(page);
      assert.ok(!st.compareIds.includes(id), 'removed from the comparison');
      assert.ok(!(await page.evaluate(() => location.hash)).includes(id), 'no longer selected');
      await page.click('#toast button');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.some(s => s.id === sid), id);
    },
  },
  {
    name: 'settings: return is 0 and labelled hypothetical, invalid rates are explained inline; scenarios survive a reload',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      const id = await createScenario(page, 'Keep me');
      await page.click('#fc-settings > summary');
      assert.equal(await page.inputValue('#fc-return'), '0');
      assert.ok((await page.textContent('label[for="fc-return"]')).includes('hypothetical'));
      assert.equal((await state(page)).scenarios.find(s => s.id === id).assumptions.annualReturnPct, 0);
      assert.ok((await page.textContent('#fc-settings > summary')).includes('no return (0%)'));
      await page.fill('#fc-return', '30');
      await page.press('#fc-return', 'Tab');
      await page.waitForSelector('#fc-return-error:not([hidden])');
      assert.equal((await state(page)).scenarios.find(s => s.id === id).assumptions.annualReturnPct, 0, 'invalid rate not saved');
      await page.fill('#fc-return', '3');
      await page.press('#fc-return', 'Tab');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).assumptions.annualReturnPct === 3, id);
      await page.waitForFunction(() => document.querySelector('#fc-settings > summary').textContent.includes('hypothetical return 3%'));
      await page.click('#fc-tpl-trip');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events.length === 1, id);

      await page.reload();
      await page.waitForSelector('#fc-editor-h');
      const st = await state(page);
      const s = st.scenarios.find(x => x.id === id);
      assert.ok(s, 'scenario kept after reload');
      assert.equal(s.name, 'Keep me');
      assert.equal(s.events[0].label, 'Trip');
      assert.equal(s.assumptions.annualReturnPct, 3);
      assert.equal(await page.textContent('#fc-editor-h'), 'Keep me');
    },
  },
  {
    name: 'chart has a table alternative and keyboard readout; household scope explains unknown income',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      assert.ok(await page.$('#fc-chart details.chart-table table caption'), 'table alternative with a caption');
      assert.equal(await page.getAttribute('#fc-chart svg', 'role'), 'img');
      assert.ok((await page.getAttribute('#fc-chart svg', 'aria-label')).includes('arrow keys'));
      assert.ok((await page.textContent('#fc-chart figcaption')).includes('running change in joint cash'));
      await page.focus('#fc-chart svg');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('#chartLive').textContent.length > 0);
      // Whole household: Sam's take-home pay is unknown in the sample.
      await page.click('label[for^="scope-household"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.scope === 'household');
      await page.waitForFunction(() => document.querySelector('#fc-compare [data-key="totalIncome"][data-scenario="baseline"]')?.dataset.cents === '');
      const text = await page.textContent('#fc-compare');
      assert.ok(text.includes('Unknown in every month: some income is not entered.'), 'says why');
      const fix = await page.getAttribute('#fc-compare .fc-unknown-list a', 'href');
      assert.match(fix, /^#\/budget\?section=income/, 'links to where it is fixed');
      assert.ok((await page.textContent('#fc-missing')).includes('take-home pay per paycheck is not entered'));
      // No month is known, so counts are unknown too, never "0 months".
      const negCell = await page.$eval('#fc-compare [data-key="negativeMonths"][data-scenario="baseline"]', el => el.closest('td').textContent);
      assert.ok(negCell.includes('Unknown') && negCell.includes('No month is known yet'), negCell);
      const negMetric = await page.$$eval('#fc-editor .fc-result .metric', els => els.map(e => e.textContent.replace(/\s+/g, ' ')).find(x => x.includes('Months with more going out')));
      assert.ok(negMetric.includes('Unknown'), negMetric);
      assert.ok(await page.isVisible('#fc-m-2026-10 .fc-flag-unknown'), 'each unknown month carries a text badge');
    },
  },
  {
    name: 'the current budget cannot hold changes and points to Budget',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      await page.click('a.fc-sc-name[href*="scenario=baseline"]');
      await page.waitForFunction(() => document.querySelector('#fc-editor-h')?.textContent === 'Current budget');
      const editor = await page.textContent('#fc-editor');
      assert.ok(editor.includes('It cannot hold planned changes'));
      assert.equal(await page.$$eval('#fc-editor [data-action="fc:template"]', els => els.length), 0, 'no add-a-change menu');
      assert.ok(await page.$('#fc-editor a[href="#/budget"]'), 'links to the budget');
      // Starting a scenario from it selects the new scenario.
      await page.click('#fc-base-dup');
      await page.waitForFunction(() => document.querySelector('#fc-editor-h')?.textContent === 'New scenario');
      assert.equal((await state(page)).scenarios.length, 4);
    },
  },
  {
    name: 'copying a scenario gives independent changes; description saves; deep links focus a field',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast?scenario=baby-arrives');
      await page.click('button[data-action="fc:duplicate"][data-id="baby-arrives"]');
      const id = await page.waitForFunction(() => {
        const s = window.HouseholdBudget.getState().scenarios.find(x => x.name === 'Baby arrives (May 2027) (copy)');
        return s && document.querySelector('#fc-editor-h')?.textContent === s.name ? s.id : null;
      }).then(h => h.jsonValue());
      const st = await state(page);
      const copy = st.scenarios.find(s => s.id === id);
      const orig = st.scenarios.find(s => s.id === 'baby-arrives');
      assert.equal(copy.events.length, 4);
      assert.ok(copy.events.every(e => !orig.events.some(o => o.id === e.id)), 'copied changes get their own ids');
      // Edit the copy's supplies amount; the original keeps its own.
      const supplies = copy.events.find(e => e.label === 'Baby supplies');
      await page.click(`#${await page.evaluate(eid => window.BudgetUI.dom.domId('fc-ev', eid), supplies.id)} > summary`);
      const input = page.locator(`input[data-bind="scenarios[id=${id}].events[id=${supplies.id}].monthlyCents"]`);
      await input.fill('300');
      await input.press('Enter');
      await page.waitForFunction(([sid, eid]) => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events.find(e => e.id === eid).monthlyCents === 30000, [id, supplies.id]);
      assert.equal((await state(page)).scenarios.find(s => s.id === 'baby-arrives').events.find(e => e.label === 'Baby supplies').monthlyCents, 25000, 'the original is unchanged');
      // Description is saved through its bound field.
      await page.fill('#fc-desc', 'A copy to try a bigger supplies budget');
      await page.press('#fc-desc', 'Tab');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).description === 'A copy to try a bigger supplies budget', id);
      // A link carrying ?focus= lands on that field.
      const childcare = copy.events.find(e => e.label === 'Childcare');
      const fid = await page.evaluate(eid => window.BudgetUI.dom.domId('fc-ev-monthlyCents', eid), childcare.id);
      await page.evaluate(([sid, f]) => { location.hash = '#/forecast?scenario=' + sid + '&focus=' + f; }, [id, fid]);
      await page.waitForFunction(f => document.activeElement?.id === f, fid);
    },
  },
  {
    name: 'goal, paid-off debt and target-change templates: scenario-only goal, a bill that stops, target next to usual history',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      const id = await createScenario(page, 'Templates test');
      const baseOut = await cmpCents(page, 'totalOut', id);
      // New savings goal (scenario only).
      await page.click('#fc-tpl-goal');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events.length === 1, id);
      const goalEv = (await eventsOf(page, id))[0];
      await page.waitForFunction(() => (document.activeElement?.id || '').startsWith('fc-ev-goal-targetCents'));
      await page.keyboard.type('1200');
      await page.keyboard.press('Tab');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events[0].goal.targetCents === 120000, id);
      const monthly = await page.evaluate(eid => window.BudgetUI.dom.domId('fc-ev-goal-monthlyCents', eid), goalEv.id);
      await page.fill('#' + monthly, '100');
      await page.press('#' + monthly, 'Tab');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events[0].goal.monthlyCents === 10000, id);
      const saved = await page.evaluate(eid => window.BudgetUI.dom.domId('fc-ev-goal-savedCents', eid), goalEv.id);
      await page.fill('#' + saved, '0');
      await page.press('#' + saved, 'Tab');
      await page.waitForFunction(() => document.querySelector('#fc-goals')?.textContent.includes('New savings goal'));
      const goalItem = page.locator('#fc-goals .fc-goal', { hasText: 'New savings goal' });
      assert.ok((await goalItem.textContent()).includes('This scenario only'));
      assert.ok((await goalItem.textContent()).includes('Funded'), '$100 a month for 24 months reaches $1,200');
      assert.equal((await state(page)).plan.savings.length, 3, 'the budget keeps its own goals');

      // Debt paid off: the store card payment stops from a month.
      await page.click('#fc-tpl-debt-off');
      await page.waitForSelector('#fc-tpl-bill');
      await page.selectOption('#fc-tpl-bill', 'store-card');
      await page.fill('#fc-tpl-start', '2027-01');
      await page.click('#fc-tpl-submit');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events.length === 2, id);
      const bill = (await eventsOf(page, id))[1];
      assert.deepEqual([bill.type, bill.billId, bill.monthlyCents, bill.startMonth], ['bill_change', 'store-card', 0, '2027-01']);
      await page.waitForFunction(([sid, v]) => Number(document.querySelector(`#fc-compare [data-key="totalOut"][data-scenario="${sid}"]`)?.dataset.cents) === v, [id, baseOut - 21 * 5500]);

      // Target change: shows your target and the usual (history) apart.
      await page.click('#fc-tpl-target');
      await page.waitForSelector('#fc-tpl-cat');
      await page.selectOption('#fc-tpl-cat', 'Groceries');
      await page.fill('#fc-tpl-start', '2027-05');
      await page.fill('#fc-tpl-amount', '700');
      await page.click('#fc-tpl-submit');
      await page.waitForFunction(sid => window.HouseholdBudget.getState().scenarios.find(s => s.id === sid).events.length === 3, id);
      const item = page.locator('.fc-ev-list > li').last();
      await item.locator('summary').click();
      const text = await item.textContent();
      assert.ok(text.includes('Your target'), 'labelled as your target');
      assert.ok(text.includes('Usual (history, not a target)'), 'history kept apart from the target');
      assert.match(await item.locator('.fc-usual-note a').getAttribute('href'), /^#\/spending\?period=\d{4}-\d{2}\.\.\d{4}-\d{2}&cat=Groceries$/);
      await t.shot('fc-templates');
    },
  },
  {
    name: 'typed months apply on Enter or when leaving the field, never one keystroke at a time',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast?scenario=baby-arrives');
      const birth = 'input[data-bind="scenarios[id=baby-arrives].events[id=birth-costs].month"]';
      const birthMonth = () => page.evaluate(() => window.HouseholdBudget.getState().scenarios.find(s => s.id === 'baby-arrives').events.find(e => e.id === 'birth-costs').month);
      await page.focus(birth);
      await toYearPart(page, birth);
      assert.equal(await birthMonth(), '2027-05', 'nothing is saved while the month is being typed');
      await page.keyboard.type('2028');
      assert.equal(await birthMonth(), '2027-05', 'still nothing saved half way through the year');
      assert.match(await page.inputValue(birth), /^2028-\d\d$/, 'the field keeps every digit typed');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /^2028-\d\d$/.test(window.HouseholdBudget.getState().scenarios.find(s => s.id === 'baby-arrives').events.find(e => e.id === 'birth-costs').month));
      await page.waitForFunction(b => document.activeElement === document.querySelector(b), birth);
      // Leaving the field also applies what was typed.
      await toYearPart(page, birth);
      await page.keyboard.type('2029');
      await page.focus('#fc-desc');
      await page.waitForFunction(() => /^2029-\d\d$/.test(window.HouseholdBudget.getState().scenarios.find(s => s.id === 'baby-arrives').events.find(e => e.id === 'birth-costs').month));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'fc-desc', 'focus goes where the person moved it');

      // The starting month: the forecast does not jump around while it is typed.
      await page.focus('#fc-start');
      await toYearPart(page, '#fc-start');
      await page.keyboard.type('2027');
      assert.ok(!(await page.evaluate(() => location.hash)).includes('start='), 'not applied mid-typing');
      const typed = await page.inputValue('#fc-start');
      await page.keyboard.press('Enter');
      await page.waitForFunction(v => location.hash.includes('start=' + v), typed);
      await page.waitForFunction(() => document.activeElement?.id === 'fc-start');
      await page.waitForSelector(`#fc-m-${typed}`);
      // A year that cannot be right is explained instead of applied.
      await toYearPart(page, '#fc-start');
      await page.keyboard.type('3');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#fc-start-error:not([hidden])');
      assert.match(await page.textContent('#fc-start-error'), /Check the year/);
      assert.ok((await page.evaluate(() => location.hash)).includes('start=' + typed), 'the forecast stays where it was');
    },
  },
  {
    name: 'names, labels and notes entered by the household render as text, never as markup',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast?scenario=baby-arrives');
      const X = '<img src=x onerror="window.__fcXss=1">';
      await page.evaluate(X => {
        const st = window.HouseholdBudget.getState();
        const s = st.scenarios.find(x => x.id === 'baby-arrives');
        s.name = X + ' scenario';
        s.description = X;
        for (const ev of s.events) { ev.label = X + ' ' + ev.id; ev.note = X; }
        st.plan.savings[0].label = X + ' goal';
        st.plan.incomes[0].label = X + ' pay';
        st.plan.bills[0].label = X + ' bill';
        st.plan.targets[X + ' category'] = null;
        window.HouseholdBudget.setState(st);
      }, X);
      await page.waitForFunction(() => document.querySelector('#fc-editor-h')?.textContent.startsWith('<img'));
      await page.evaluate(() => { for (const d of document.querySelectorAll('#view details')) d.open = true; });
      await page.click('button[data-action="fc:rename-open"][data-id="baby-arrives"]');
      await page.waitForSelector('#fc-rename-name');
      assert.equal(await page.inputValue('#fc-rename-name'), X + ' scenario', 'the rename field holds the name as typed');
      await page.click('#fc-tpl-leave');
      await page.waitForSelector('#fc-tpl-stream');
      assert.ok((await page.textContent('#fc-missing')).includes(X), 'missing items show the label as text');
      assert.ok((await page.textContent('#fc-goals')).includes(X + ' goal'));
      await page.click('button[data-action="fc:delete"][data-id="baby-arrives"]');
      await page.waitForSelector('#dialog[open]');
      assert.ok((await page.textContent('#dialogTitle')).includes(X));
      assert.equal(await page.$$eval('#view img, #dialog img', els => els.length), 0, 'no element was created from the text');
      await page.click('#dialog button[value="cancel"]');
      await page.waitForFunction(() => !document.querySelector('#dialog').open);
      assert.equal(await page.evaluate(() => window.__fcXss), undefined, 'no script ran');
    },
  },
  {
    name: 'with a dated joint cash balance, balances start the month after that date and the lowest balance is shown',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast?scenario=baseline');
      await page.evaluate(() => {
        const st = window.HouseholdBudget.getState();
        st.plan.balances = { ...st.plan.balances, jointCashCents: 500000, asOf: '2026-10-31' };
        window.HouseholdBudget.setState(st);
      });
      await page.waitForSelector('#fc-m-2026-11[data-balance-cents]');
      assert.equal(await page.textContent('#fc-compare-h'), 'Compare scenarios');
      assert.ok((await page.textContent('#fc-chart figcaption')).includes('projected joint cash'), 'the chart says it shows balances');
      // October is already inside the entered balance: no balance yet, said in words.
      assert.equal(await monthAttr(page, '2026-10', 'balance-cents'), null);
      assert.ok((await page.textContent('#fc-m-2026-10 .fc-c-bal')).includes('From Nov 2026'));
      assert.ok((await page.textContent('#fc-months')).includes('Balances start in Nov 2026'));
      const nov = await monthAttr(page, '2026-11', 'balance-cents');
      assert.equal(nov, 500000 + await monthAttr(page, '2026-11', 'net-cents'), 'November = entered balance + November net');
      const end = await cmpCents(page, 'endBalance', 'baseline');
      const cum = await cmpCents(page, 'endCumulative', 'baseline');
      assert.equal(end, 500000 + cum - await monthAttr(page, '2026-10', 'net-cents'), 'end balance leaves out October, already in the balance');
      const balances = await page.$$eval('.fc-month[data-balance-cents]', els => els.map(e => e.dataset.balanceCents).filter(v => v !== '').map(Number));
      assert.equal(balances.length, 23, 'every month after October has a balance');
      assert.equal(await cmpCents(page, 'lowest', 'baseline'), Math.min(...balances), 'lowest balance is the lowest month shown');
      await t.shot('fc-balance');
    },
  },
  {
    name: 'selecting a scenario is a step that Back undoes, and focus stays on the chosen link',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      assert.equal(await page.textContent('#fc-editor-h'), 'Baby arrives (May 2027)');
      await page.click('a.fc-sc-name[href*="scenario=home-projects-scenario"]');
      await page.waitForFunction(() => document.querySelector('#fc-editor-h')?.textContent === 'Home projects');
      const linkId = await page.evaluate(() => window.BudgetUI.dom.domId('fc-sel', 'home-projects-scenario'));
      await page.waitForFunction(id => document.activeElement?.id === id, linkId);
      assert.equal(await page.getAttribute('#' + linkId, 'aria-current'), 'true');
      await page.goBack();
      await page.waitForFunction(() => document.querySelector('#fc-editor-h')?.textContent === 'Baby arrives (May 2027)');
      await page.goForward();
      await page.waitForFunction(() => document.querySelector('#fc-editor-h')?.textContent === 'Home projects');
      // Removing a change moves focus to the list heading; Undo brings the change back.
      const before = (await eventsOf(page, 'home-projects-scenario')).length;
      await page.evaluate(() => { for (const d of document.querySelectorAll('.fc-ev-details')) d.open = true; });
      await page.click('.fc-ev-list > li:first-child button[data-action="fc:remove-event"]');
      await page.waitForFunction(n => window.HouseholdBudget.getState().scenarios.find(s => s.id === 'home-projects-scenario').events.length === n - 1, before);
      await page.waitForFunction(() => document.activeElement?.id === 'fc-events-h');
      await page.click('#toast button');
      await page.waitForFunction(n => window.HouseholdBudget.getState().scenarios.find(s => s.id === 'home-projects-scenario').events.length === n, before);
    },
  },
  {
    name: 'phone layout: no horizontal page scroll; months become cards; forms fit',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/forecast');
      assert.ok(await noHorizontalScroll(page), 'no horizontal scroll at first load');
      assert.ok(await page.isVisible('#fc-m-2026-10 .fc-phone'), 'phone shows the condensed Out column');
      assert.ok(await page.isHidden('.fc-row-head'), 'desktop header row hidden on phones');
      await page.click('#fc-m-2027-09 > summary');
      await page.click('#fc-tpl-leave');
      await page.waitForSelector('#fc-tpl-stream');
      assert.ok(await noHorizontalScroll(page), 'no horizontal scroll with a month and a form open');
      await page.click('#fc-settings > summary');
      assert.ok(await noHorizontalScroll(page), 'no horizontal scroll with settings open');
      const boxes = await page.$$eval('#fc-scenarios button, #fc-scenarios a, #fc-scenarios input', els => els.map(e => e.getBoundingClientRect().right));
      const vw = await page.evaluate(() => window.innerWidth);
      assert.ok(boxes.every(r => r <= vw + 1), 'scenario controls stay on screen');
      // The chart draws for the phone width: its whole drawing fits inside the card, no sideways scroll.
      const chart = await page.$eval('#fc-chart svg', el => { const r = el.getBoundingClientRect(); const p = el.closest('.card').getBoundingClientRect(); return { right: r.right, cardRight: p.right, scroll: el.parentElement.scrollWidth - el.parentElement.clientWidth }; });
      assert.ok(chart.right <= chart.cardRight && chart.scroll <= 1, 'chart fits the card: ' + JSON.stringify(chart));
      await t.shot('fc-phone');
      // The narrowest common phone width.
      await page.setViewportSize({ width: 360, height: 780 });
      await page.reload();
      await page.waitForSelector('#fc-editor-h');
      await page.click('#fc-m-2027-05 > summary');
      await page.evaluate(() => { for (const d of document.querySelectorAll('.fc-ev-details')) d.open = true; });
      assert.ok(await noHorizontalScroll(page), 'no horizontal scroll at 360px');
      await t.shot('fc-phone-360');
      // Names typed as one very long word wrap instead of widening the page.
      const long = 'Kitchenbathroomroofwindowsandinsulationrenovationbeforethebabyarrivesnextyear';
      await page.evaluate(long => {
        const st = window.HouseholdBudget.getState();
        const s = st.scenarios.find(x => x.id === 'baby-arrives');
        s.name = long;
        s.events[0].label = long;
        st.plan.savings[0].label = long;
        window.HouseholdBudget.setState(st);
      }, long);
      await page.waitForFunction(l => document.querySelector('#fc-editor-h')?.textContent === l, long);
      await page.evaluate(() => { for (const d of document.querySelectorAll('#view details')) d.open = true; });
      assert.ok(await noHorizontalScroll(page), 'no horizontal scroll with long names and everything open');
    },
  },
];
