'use strict';
// Budget view checks in a real browser (sample household: Alex & Sam, fictional).
//   node tools/build.cjs --sample --view budget --out dist/dev-budget/index.html
//   BUDGET_DIST=dist/dev-budget/index.html BUDGET_RESULTS=test-results/budget node tests/browser/run.cjs budget
//
// Waiting: never sleep. After a change, `settled` waits until the page shows the current plan and
// scope (the view stamps each render), and focus checks wait for the focus itself. Figures that
// depend on engine rules beyond the plan (forecast, usual averages) are worked out with the engine
// in the page and compared with what the page shows.

const SECTIONS = ['income', 'bills', 'targets', 'savings', 'debts'];
const GROCERIES = 'input[data-bind="plan.targets.Groceries"]';
const FUEL = 'input[data-bind="plan.targets.Fuel"]';
const XSS = '<img src=x onerror=alert(1)>';

const { noHorizontalScroll, state } = require('./helpers.cjs');

const text = (page, sel) => page.$eval(sel, el => el.textContent.replace(/\s+/g, ' ').trim());

/** Wait until the page shows the current plan and scope. */
function settled(page) {
  return page.waitForFunction(() => {
    const el = document.querySelector('.bud-layout');
    const ctx = window.HouseholdBudget.context();
    return !!el && el.__budPlan === ctx.state.plan && el.dataset.scope === ctx.state.ui.scope;
  });
}
const focusIs = (page, fn, arg) => page.waitForFunction(fn, arg);

/** Type into a bound field, commit it with Enter, wait for the state (when given) and the render. */
async function commit(page, selector, value, check) {
  await page.fill(selector, value);
  await page.press(selector, 'Enter');
  if (check) await page.waitForFunction(check);
  await settled(page);
}

async function openSection(t, section, opts) {
  await t.open('#/budget?section=' + section, opts);
  await t.page.waitForSelector('#bud-section-' + section);
  await settled(t.page);
}

async function setScope(t, scope) {
  await t.page.click(`label[for^="scope-${scope}"]`);
  await t.page.waitForFunction(s => window.HouseholdBudget.getState().ui.scope === s, scope);
  await settled(t.page);
}

async function select(page, selector, value, check, arg) {
  await page.selectOption(selector, value);
  if (check) await page.waitForFunction(check, arg);
  await settled(page);
}

/** Structural checks shared by every section: headings in order, unique ids, labelled controls. */
async function structure(page) {
  return page.evaluate(() => {
    const view = document.getElementById('view');
    const levels = [...view.querySelectorAll('h1, h2, h3, h4')].filter(h => h.offsetParent !== null || h.closest('details')).map(h => Number(h.tagName[1]));
    const jumps = levels.filter((l, i) => i > 0 && l > levels[i - 1] + 1);
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    const unlabelled = [...view.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(el => {
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
      return !(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) && !el.closest('label');
    }).map(el => el.id || el.name || el.outerHTML.slice(0, 60));
    const buttonsAsLinks = [...view.querySelectorAll('a:not([href])')].length;
    const spendingLinks = [...view.querySelectorAll('a[href^="#/spending"]')].map(a => a.getAttribute('href'));
    return { first: levels[0], jumps, dupes, unlabelled, buttonsAsLinks, spendingLinks };
  });
}

/** Engine figures worked out in the page, for the selected scope. */
function forecastEnd(page) {
  return page.evaluate(() => {
    const ctx = window.HouseholdBudget.context();
    const p = window.HouseholdBudget.engine.forecast.project(ctx.state.plan, ctx.state.scenarios[0], { startMonth: ctx.forecastStart, months: 12, scope: ctx.scope });
    return p.summary.endCumulativeCents;
  });
}
const signedMoney = (page, cents) => page.evaluate(c => window.HouseholdBudget.engine.money.format(c, { signed: true }), cents);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = [
  {
    name: 'every budget section renders beside the plan summary without horizontal scroll',
    viewport: 'both',
    async run(t) {
      // A fresh load of #/budget (no section) shows the default section.
      await t.open('#/budget');
      await t.page.waitForSelector('#bud-section-targets');
      t.assert.equal(await t.page.$eval('#bud-tab-targets', a => a.getAttribute('aria-current')), 'page', 'Targets is the default section');
      for (const section of SECTIONS) {
        await openSection(t, section, { clear: false });
        t.assert.equal(await t.page.$eval('#bud-tab-' + section, a => a.getAttribute('aria-current')), 'page');
        const labels = await t.page.$$eval('.bud-sum-row dt', els => els.map(e => e.textContent.trim()));
        t.assert.deepEqual(labels, ['Coming in', 'Spending targets', 'Bills', 'Debt payments', 'Savings', 'Remaining']);
        t.assert.ok(await noHorizontalScroll(t.page), 'no horizontal page scroll in ' + section);
        const s = await structure(t.page);
        t.assert.equal(s.first, 1, 'the page title is the first heading');
        t.assert.deepEqual(s.jumps, [], 'heading levels never skip in ' + section);
        t.assert.deepEqual(s.dupes, [], 'element ids are unique in ' + section);
        t.assert.deepEqual(s.unlabelled, [], 'every control has a label in ' + section);
        t.assert.equal(s.buttonsAsLinks, 0);
        // Actual and usual figures here are joint-account spending, so every link opens the joint accounts.
        t.assert.deepEqual(s.spendingLinks.filter(h => !/[?&]scope=joint(&|$)/.test(h)), [], 'every Spending link keeps the joint scope in ' + section);
        await t.shot('budget-' + section);
      }
      // Desktop keeps the summary beside the editor (sticky); phones put it first.
      const box = await t.page.evaluate(() => {
        const a = document.querySelector('.bud-summary').getBoundingClientRect();
        const m = document.querySelector('.bud-main').getBoundingClientRect();
        return { aLeft: a.left, mLeft: m.left, aTop: a.top, mTop: m.top, sticky: getComputedStyle(document.querySelector('.bud-summary')).position };
      });
      if (t.viewport === 'desktop') {
        t.assert.ok(box.aLeft > box.mLeft, 'summary sits to the right of the editor');
        t.assert.equal(box.sticky, 'sticky');
      } else {
        t.assert.ok(box.aTop < box.mTop, 'summary comes before the editor on a phone');
      }
    },
  },
  {
    name: 'tablet and small phone widths: every section fits without horizontal page scroll',
    viewport: 'both',
    async run(t) {
      // Desktop context checks a 768px tablet; the phone context checks a 360px phone.
      const width = t.viewport === 'desktop' ? 768 : 360;
      await t.page.setViewportSize({ width, height: 900 });
      await openSection(t, 'targets');
      for (const section of SECTIONS) {
        await openSection(t, section, { clear: false });
        await t.page.evaluate(() => document.querySelectorAll('#view details').forEach(d => { d.open = true; }));
        t.assert.ok(await noHorizontalScroll(t.page), `no horizontal page scroll in ${section} at ${width}px`);
        // Text never spills out of its card (wide tables scroll inside .table-wrap instead).
        const spill = await t.page.evaluate(() => [...document.querySelectorAll('#view .card')].flatMap(card => {
          const r = card.getBoundingClientRect();
          return [...card.querySelectorAll('p, dd, dt, label, h2, h3, h4, .badge, button, a')]
            .filter(el => !el.closest('.table-wrap') && !el.closest('.section-nav') && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > r.right + 1)
            .map(el => el.tagName + ': ' + el.textContent.trim().slice(0, 40));
        }));
        t.assert.deepEqual(spill, [], `nothing overflows its card in ${section} at ${width}px`);
        await t.shot(`budget-${section}-${width}`);
      }
    },
  },
  {
    name: 'editing a target updates the summary and shows what changed, with undo',
    viewport: 'both',
    async run(t) {
      await openSection(t, 'targets');
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,255');
      t.assert.equal(await text(t.page, '#bud-sum-remaining dd'), '$1,938');
      t.assert.equal(await t.page.$('#bud-change'), null, 'no change shown before any edit');
      const fcBefore = await forecastEnd(t.page);
      await commit(t.page, GROCERIES, '650', () => window.HouseholdBudget.getState().plan.targets.Groceries === 65000);
      const fcAfter = await forecastEnd(t.page);
      t.assert.equal(fcAfter - fcBefore, -60000, '12 months of a $50 higher target');
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,305');
      t.assert.equal(await text(t.page, '#bud-sum-remaining dd'), '$1,888');
      const change = await text(t.page, '#bud-change');
      t.assert.match(change, /Remaining went from \$1,937\.64 to \$1,887\.64 \(−\$50\.00 a month, −\$600\.00 a year\)/);
      const fcText = `${await signedMoney(t.page, fcBefore)} → ${await signedMoney(t.page, fcAfter)} (−$600.00)`;
      t.assert.match(change, new RegExp('12-month forecast, change in joint cash: ' + escapeRe(fcText)));
      t.assert.doesNotMatch(change, /differs from 12 ×/, 'a target change moves the forecast by exactly 12 months of it');
      t.assert.match(change, /Groceries target: \$600\.00 → \$650\.00 \(\+\$50\.00\)/);
      t.assert.match(await text(t.page, '#toast'), /Groceries target saved\. Remaining \$1,937\.64 → \$1,887\.64 a month \(−\$50\.00\)/);
      // The edited row compares the new target with last month's actual.
      t.assert.match(await t.page.$eval(GROCERIES, el => el.closest('tr').textContent), /Under by \$54\.00/);
      await t.shot('budget-what-changed');
      // Undo from the box: the box goes away and focus moves to the summary it updated.
      await t.page.click('#bud-undo');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 60000);
      await settled(t.page);
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,255');
      t.assert.equal(await t.page.$('#bud-change'), null);
      await focusIs(t.page, () => document.activeElement && document.activeElement.id === 'bud-summary-h');
    },
  },
  {
    name: 'on a short laptop screen the summary scrolls itself to show what changed',
    async run(t) {
      await t.page.setViewportSize({ width: 1366, height: 640 });
      await openSection(t, 'targets');
      await t.page.fill(GROCERIES, '610');
      const where = () => t.page.evaluate(sel => ({ y: scrollY, top: document.querySelector(sel).getBoundingClientRect().top }), GROCERIES);
      const before = await where();
      await t.page.press(GROCERIES, 'Enter');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 61000);
      await settled(t.page);
      const pos = await t.page.evaluate(() => {
        const panel = document.querySelector('.bud-summary').getBoundingClientRect();
        const box = document.getElementById('bud-change').getBoundingClientRect();
        return { panelTop: panel.top, panelBottom: panel.bottom, boxTop: box.top, boxBottom: box.bottom };
      });
      t.assert.ok(pos.boxTop >= pos.panelTop - 1 && pos.boxBottom <= pos.panelBottom + 1, 'the What changed box is inside the visible part of the summary');
      t.assert.deepEqual(await where(), before, 'the page does not move, so the edited field stays where it was');
      await focusIs(t.page, sel => document.activeElement === document.querySelector(sel), GROCERIES);
      await t.shot('budget-short-screen');
    },
  },
  {
    name: 'invalid money shows an inline error, keeps the last valid value and can be corrected',
    viewport: 'both',
    async run(t) {
      await openSection(t, 'targets');
      const errorId = await t.page.$eval(GROCERIES, el => el.id + '-error');
      await commit(t.page, GROCERIES, 'abc');
      t.assert.ok(await t.page.isVisible('#' + errorId), 'error shown');
      t.assert.match(await text(t.page, '#' + errorId), /Enter an amount in dollars/);
      t.assert.equal(await t.page.getAttribute(GROCERIES, 'aria-invalid'), 'true');
      t.assert.equal((await state(t.page)).plan.targets.Groceries, 60000, 'last valid value kept');
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,255', 'summary unchanged');
      await commit(t.page, GROCERIES, '-5');
      t.assert.match(await text(t.page, '#' + errorId), /\$0 or more/);
      t.assert.equal((await state(t.page)).plan.targets.Groceries, 60000);
      await t.shot('budget-invalid-input');
      await commit(t.page, GROCERIES, '625', () => window.HouseholdBudget.getState().plan.targets.Groceries === 62500);
      t.assert.equal(await t.page.isVisible('#' + errorId), false, 'error cleared');
      t.assert.equal(await t.page.getAttribute(GROCERIES, 'aria-invalid'), null);
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,280');
    },
  },
  {
    name: 'a blank target stays unknown (not $0) and the missing list links back to it',
    async run(t) {
      await openSection(t, 'targets');
      await commit(t.page, FUEL, '', () => window.HouseholdBudget.getState().plan.targets.Fuel === null);
      const st = await state(t.page);
      t.assert.ok('Fuel' in st.plan.targets, 'the target is kept');
      t.assert.equal(st.plan.targets.Fuel, null, 'blank is stored as unknown, not 0');
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,125');
      t.assert.match(await text(t.page, '#bud-sum-targets'), /7 not set: left out, not \$0/);
      t.assert.match(await t.page.$eval(FUEL, el => el.closest('tr').textContent), /Not set: left out of totals/);
      t.assert.equal(await t.page.getAttribute(FUEL, 'placeholder'), 'Not set');
      // Missing inputs: the Fuel entry links to the field, from any section.
      await t.page.click('#bud-missing > summary');
      const fix = t.page.locator('#bud-missing li', { hasText: 'Fuel target not entered' }).locator('a');
      t.assert.match(await fix.getAttribute('href'), /section=targets&focus=/);
      await openSection(t, 'bills', { clear: false });
      if (!(await t.page.$eval('#bud-missing', d => d.open))) await t.page.click('#bud-missing > summary');
      await t.page.locator('#bud-missing li', { hasText: 'Fuel target not entered' }).locator('a').click();
      await focusIs(t.page, () => document.activeElement && document.activeElement.dataset.bind === 'plan.targets.Fuel');
      // The same link again (same URL) still lands on the field, not the page title.
      await t.page.focus('#bud-tab-bills');
      await t.page.locator('#bud-missing li', { hasText: 'Fuel target not entered' }).locator('a').click();
      await focusIs(t.page, () => document.activeElement && document.activeElement.dataset.bind === 'plan.targets.Fuel');
    },
  },
  {
    name: 'changing an unknown pay frequency to biweekly changes income and the frequency table',
    async run(t) {
      await openSection(t, 'income');
      await select(t.page, '#bud-timing', 'average', () => window.HouseholdBudget.getState().plan.settings.incomeTiming === 'average');
      await setScope(t, 'household');
      t.assert.equal(await text(t.page, '#bud-sum-remaining dd'), 'Unknown');
      const net = 'input[data-bind="plan.incomes[id=p2-pay].netPerPaycheckCents"]';
      await commit(t.page, net, '2000', () => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === 'p2-pay').netPerPaycheckCents === 200000);
      // Remaining was unknown and is now known: say so, never a difference against an unknown.
      const first = await text(t.page, '#bud-change');
      t.assert.match(first, /Remaining is now \$[\d,]+\.\d\d a month\. Before this change it could not be worked out: some income is unknown\./);
      t.assert.match(first, /Coming in: at least \$[\d,.]+ → \$[\d,.]+ a month/);
      t.assert.doesNotMatch(first, /Remaining is (still )?unknown/);
      const card = t.page.locator('.bud-income-card').filter({ has: t.page.locator('h2', { hasText: /^Sam paycheck$/ }) });
      // Unknown frequency: 2 paychecks assumed; Alex biweekly averages 26/12.
      t.assert.equal(await text(t.page, '#bud-sum-income dd'), '$8,853');
      t.assert.match(await card.locator('.bud-counts').textContent(), /\$4,000\.00 a month.*assumed while the frequency is not known/s);
      t.assert.equal(await card.locator('tr.bud-freq-current').count(), 0, 'no frequency marked while unknown');
      t.assert.match(await card.locator('.bud-freq').textContent(), /plan assumes 2 paychecks a month/);
      await select(t.page, 'select[data-bind="plan.incomes[id=p2-pay].frequency"]', 'biweekly', () => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === 'p2-pay').frequency === 'biweekly');
      t.assert.equal(await text(t.page, '#bud-sum-income dd'), '$9,187');
      t.assert.match(await card.locator('.bud-counts').textContent(), /\$4,333\.33 a month/);
      const current = card.locator('tr.bud-freq-current');
      t.assert.equal(await current.count(), 1);
      t.assert.match(await current.textContent(), /Every two weeks.*Your setting.*\$4,000\.00.*\$6,000\.00.*\$4,333\.33.*\$52,000\.00/s);
      t.assert.match(await card.locator('.bud-freq').textContent(), /not confirmed yet/);
      t.assert.match(await text(t.page, '#bud-change'), /Sam paycheck: pay frequency unknown → biweekly/);
      await t.shot('budget-frequency');
    },
  },
  {
    name: 'whole household: a change in take-home pay leaves Remaining unchanged, and the page says why',
    viewport: 'both',
    async run(t) {
      await openSection(t, 'income');
      // Joint view: the explanation is there, folded away.
      t.assert.equal(await t.page.locator('#bud-personal details', { hasText: 'Why changing take-home pay does not change Remaining' }).count(), 1);
      await setScope(t, 'household');
      t.assert.match(await text(t.page, '#bud-pay-why'), /does not change Remaining in the whole-household view.*counted as their personal spending/);
      // Give Sam a known take-home so Remaining is known, then change Alex's take-home pay.
      await commit(t.page, 'input[data-bind="plan.incomes[id=p2-pay].netPerPaycheckCents"]', '2000', () => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === 'p2-pay').netPerPaycheckCents === 200000);
      const remaining = await text(t.page, '#bud-sum-remaining dd');
      t.assert.match(remaining, /^\$[\d,]+$/);
      await commit(t.page, 'input[data-bind="plan.incomes[id=p1-pay].netPerPaycheckCents"]', '2400', () => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === 'p1-pay').netPerPaycheckCents === 240000);
      t.assert.equal(await text(t.page, '#bud-sum-remaining dd'), remaining, 'Remaining does not move with take-home pay');
      const change = await text(t.page, '#bud-change');
      t.assert.match(change, /Remaining stays at \$[\d,.]+ a month/);
      t.assert.match(change, /Coming in \+\$320\.00 a month; going out \+\$320\.00 a month/);
      t.assert.match(change, /all of Alex's pay that does not reach joint counts as personal spending, so Alex's personal spending changed by \+\$320\.00 too and Remaining did not change/);
      t.assert.match(await text(t.page, '#toast'), /Remaining unchanged: in the whole-household view, personal spending moves with take-home pay/);
      await t.shot('budget-household-pay');
      // The amount reaching joint does move Remaining.
      await commit(t.page, 'input[data-bind="plan.incomes[id=p1-pay].jointPerPaycheckCents"]', '1900', () => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === 'p1-pay').jointPerPaycheckCents === 190000);
      t.assert.match(await text(t.page, '#bud-change'), /Remaining went from \$[\d,.]+ to \$[\d,.]+ \(\+\$40\.00 a month, \+\$480\.00 a year\)/);
      t.assert.doesNotMatch(await text(t.page, '#bud-change'), /Remaining did not change/);
    },
  },
  {
    name: 'scope toggle switches joint and household income; household says "At least" while pay is unknown',
    async run(t) {
      await openSection(t, 'income');
      t.assert.equal(await text(t.page, '#bud-sum-income dd'), '$6,410');
      const sam = t.page.locator('.bud-income-card').filter({ has: t.page.locator('h2', { hasText: /^Sam paycheck$/ }) });
      const contribution = t.page.locator('.bud-income-card').filter({ has: t.page.locator('h2', { hasText: /^Sam contribution to joint$/ }) });
      t.assert.match(await sam.locator('.bud-counts').textContent(), /Not counted in this view/);
      t.assert.match(await contribution.locator('.bud-counts').textContent(), /\$2,650\.00 a month/);
      t.assert.equal(await t.page.$('#bud-sum-personal'), null, 'no personal spending line in the joint view');
      await setScope(t, 'household');
      t.assert.equal(await text(t.page, '#bud-sum-income dd'), 'At least $7,130');
      t.assert.match(await text(t.page, '#bud-sum-income'), /Unknown: Sam paycheck/);
      t.assert.equal(await text(t.page, '#bud-sum-remaining dd'), 'Unknown');
      t.assert.match(await text(t.page, '#bud-sum-remaining'), /Money left over cannot be worked out because some income is unknown/, 'the engine note says why');
      t.assert.match(await text(t.page, '#bud-sum-next12'), /How much cash changes is unknown: some income is unknown/);
      t.assert.match(await contribution.locator('.bud-counts').textContent(), /Not counted in this view.*not extra household income/s);
      t.assert.match(await sam.locator('.bud-counts').textContent(), /Not counted:.*take-home pay.*not entered/s);
      t.assert.ok(await t.page.$('#bud-sum-personal'), 'personal spending shown in the household view');
      t.assert.match(await text(t.page, '#bud-sum-bills'), /Every bill, whoever pays/);
      await t.shot('budget-household');
      await setScope(t, 'joint');
      t.assert.equal(await text(t.page, '#bud-sum-income dd'), '$6,410');
    },
  },
  {
    name: 'fill empty targets from usual fills only blank targets, in one undoable change',
    async run(t) {
      await openSection(t, 'targets');
      t.assert.equal(await t.page.isDisabled('#bud-fill'), true, 'nothing regular to fill in the sample');
      await commit(t.page, GROCERIES, '', () => window.HouseholdBudget.getState().plan.targets.Groceries === null);
      await commit(t.page, FUEL, '', () => window.HouseholdBudget.getState().plan.targets.Fuel === null);
      const before = (await state(t.page)).plan.targets;
      const why = await text(t.page, '#bud-fill-why');
      t.assert.match(why, /Copies the usual average into 2 blank targets: Groceries \$577\.27, Fuel \$133\.94/);
      await t.page.click('#bud-fill');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 57727);
      await settled(t.page);
      const after = (await state(t.page)).plan.targets;
      t.assert.equal(after.Fuel, 13394);
      for (const [k, v] of Object.entries(before)) {
        if (k === 'Groceries' || k === 'Fuel') continue;
        t.assert.equal(after[k], v, k + ' unchanged (entered targets are never overwritten, other blanks stay blank)');
        if (v === null) t.assert.ok(why.includes(k), k + ' is named among the targets that stay blank');
      }
      t.assert.match(await text(t.page, '#toast'), /Filled 2 empty targets from usual averages: Groceries \$577\.27, Fuel \$133\.94/);
      // The button is disabled now; focus moved to the first filled target instead of being lost.
      t.assert.equal(await t.page.isDisabled('#bud-fill'), true);
      await focusIs(t.page, () => document.activeElement && document.activeElement.dataset.bind === 'plan.targets.Groceries');
      await t.page.click('#toast button[data-action="undo"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === null);
      const undone = (await state(t.page)).plan.targets;
      t.assert.deepEqual(undone, before, 'one undo restores every target');
    },
  },
  {
    name: '"Use" suggestions name their basis: one-off and seasonal categories use the 12-month average',
    async run(t) {
      await openSection(t, 'targets');
      const rows = await t.page.evaluate(() => {
        const ctx = window.HouseholdBudget.context();
        const E = window.HouseholdBudget.engine;
        const joint = ctx.txns.filter(x => x.accountScope !== 'personal');
        const u3 = E.compare.usual(joint, ctx.dataset, { month: ctx.latestComplete, window: 3 });
        const u12 = E.compare.usual(joint, ctx.dataset, { month: ctx.latestComplete, window: 12 });
        const by3 = new Map(u3.categories.map(x => [x.category, x]));
        const by12 = new Map(u12.categories.map(x => [x.category, x]));
        return [...document.querySelectorAll('button[data-action="budget:use-usual"]')].map(b => {
          const cat = b.dataset.cat;
          const s3 = by3.get(cat);
          const yearly = E.categories.isSeasonal(cat) || (!!s3 && s3.signal === 'irregular');
          return { cat, cents: Number(b.dataset.cents), label: b.textContent.replace(/\s+/g, ' ').trim(), yearly, expected: yearly ? by12.get(cat).averageCents : s3.averageCents, avg3: s3 ? s3.averageCents : null };
        });
      });
      t.assert.ok(rows.length >= 5, 'several targets offer a suggestion');
      for (const r of rows) {
        t.assert.equal(r.cents, r.expected, r.cat + ' suggests the documented average');
        if (r.yearly) t.assert.match(r.label, /12-month avg\..*\(12-month average\)/, r.cat + ' names the 12-month basis');
        else t.assert.match(r.label, /\(3-month average\)$/, r.cat + ' names the usual basis');
      }
      // A one-off month is never offered as a monthly target through the short average.
      for (const r of rows.filter(x => x.yearly && x.avg3 !== null && x.avg3 !== x.expected)) t.assert.ok(!r.label.includes(`$${(r.avg3 / 100).toFixed(2)}`), r.cat);
      const pick = rows.find(r => r.yearly) || rows[0];
      await t.page.click(`button[data-action="budget:use-usual"][data-cat="${pick.cat}"]`);
      await t.page.waitForFunction(([c, v]) => window.HouseholdBudget.getState().plan.targets[c] === v, [pick.cat, pick.cents]);
      await settled(t.page);
      t.assert.match(await text(t.page, '#toast'), new RegExp(escapeRe(pick.cat) + ' target set to \\$[\\d,.]+, the ' + (pick.yearly ? '12' : '3') + '-month average'));
      await focusIs(t.page, c => document.activeElement && document.activeElement.dataset.bind === 'plan.targets.' + c, pick.cat);
      // A blank seasonal target is filled from the 12-month average, and the fill text says so.
      const gas = await t.page.$eval('button[data-action="budget:use-usual"][data-cat="Gas & heating"]', b => b.dataset.cents).catch(() => null);
      await commit(t.page, 'input[data-bind="plan.targets.Gas & heating"]', '', () => window.HouseholdBudget.getState().plan.targets['Gas & heating'] === null);
      const cents = gas || await t.page.$eval('button[data-action="budget:use-usual"][data-cat="Gas & heating"]', b => b.dataset.cents);
      const amount = await t.page.evaluate(c => window.HouseholdBudget.engine.money.format(Number(c)), cents);
      t.assert.ok((await text(t.page, '#bud-fill-why')).includes(`Gas & heating ${amount} (12-month average)`));
    },
  },
  {
    name: 'usual window toggle changes the history column and is not an undoable plan change',
    async run(t) {
      await openSection(t, 'targets');
      t.assert.match(await text(t.page, '#bt-col-usual'), /3-month average/);
      await t.page.click('label[for^="bud-window-6"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.settings.comparisonWindow === 6);
      await settled(t.page);
      t.assert.match(await text(t.page, '#bt-col-usual'), /6-month average/);
      t.assert.equal(await t.page.$('#bud-change'), null);
      t.assert.match(await t.page.$eval(GROCERIES, el => el.closest('tr').querySelector('.bt-usual').textContent), /\$646\.12/);
    },
  },
  {
    name: 'totals trace to the transactions behind them: month total, usual range and yearly bills',
    async run(t) {
      await openSection(t, 'targets');
      const facts = await t.page.evaluate(() => {
        const ctx = window.HouseholdBudget.context();
        const E = window.HouseholdBudget.engine;
        const month = ctx.latestComplete;
        const joint = E.ledger.summarize(E.ledger.filter(ctx.txns, { months: [month], scope: 'joint' }));
        const groceries = E.ledger.summarize(E.ledger.filter(ctx.txns, { months: [month], scope: 'joint', category: 'Groceries' }));
        const u = E.compare.usual(ctx.txns.filter(x => x.accountScope !== 'personal'), ctx.dataset, { month, window: 3 });
        const yearly = ctx.reviewQueues().annualSpikes.filter(x => x.category === 'Home insurance').sort((a, b) => (a.month < b.month ? 1 : -1))[0];
        const f = c => E.money.format(c);
        return { month, total: f(joint.spendingCents), groceries: f(groceries.spendingCents), baseline: u.baselineMonths, yearly: yearly && { month: yearly.month, cents: f(yearly.totalCents) } };
      });
      // The linked month total is the joint spending the Spending page will total.
      const totalLink = t.page.locator('#bud-sum-pva a').first();
      t.assert.equal((await totalLink.textContent()).trim(), facts.total);
      t.assert.equal(await totalLink.getAttribute('href'), `#/spending?period=${facts.month}&scope=joint`);
      // Groceries actual and usual link to the same accounts and months they summarise.
      const row = t.page.locator('tr', { has: t.page.locator(GROCERIES) });
      const actual = row.locator('td.bt-actual a');
      t.assert.equal((await actual.textContent()).trim(), facts.groceries);
      t.assert.equal(await actual.getAttribute('href'), `#/spending?period=${facts.month}&cat=Groceries&scope=joint`);
      const range = facts.baseline[0] + '..' + facts.baseline[facts.baseline.length - 1];
      t.assert.equal(await row.locator('td.bt-usual a').first().getAttribute('href'), `#/spending?period=${encodeURIComponent(range)}&cat=Groceries&scope=joint`);
      // A yearly bill reads $0 most months; the bill names its yearly payment and links to it.
      await openSection(t, 'bills', { clear: false });
      t.assert.ok(facts.yearly, 'the sample has a yearly home insurance payment');
      const ins = t.page.locator('.bud-bill', { has: t.page.locator('input[data-bind="plan.bills[id=home-insurance].monthlyCents"]') }).locator('.bud-yearly');
      t.assert.match(await ins.textContent(), new RegExp('Paid once a year: ' + escapeRe(facts.yearly.cents) + ' in [A-Z][a-z]{2} \\d{4}, about \\$92\\.00 a month'));
      t.assert.equal(await ins.locator('a').getAttribute('href'), `#/spending?period=${facts.yearly.month}&cat=Home%20insurance&scope=joint`);
    },
  },
  {
    name: 'next 12 months says what the figure includes and what it leaves out',
    async run(t) {
      await openSection(t, 'targets');
      const proj = await t.page.evaluate(() => {
        const ctx = window.HouseholdBudget.context();
        const p = ctx.project(ctx.state.scenarios[0].id, { months: 12 });
        const f = c => window.HouseholdBudget.engine.money.format(c, { signed: true });
        return { end: f(p.summary.endCumulativeCents), kept: window.HouseholdBudget.engine.money.format(p.summary.totalContributionsCents), missing: p.missing.length, timing: ctx.state.scenarios[0].assumptions.incomeTiming };
      });
      const note = await text(t.page, '#bud-sum-next12');
      t.assert.ok(note.includes(`Joint cash changes by ${proj.end} if the plan is followed, including ${proj.kept} set aside for savings goals`), note);
      t.assert.match(note, new RegExp(`Leaves out ${proj.missing} missing amounts, so the real change is likely lower`));
      if (proj.timing === 'actual') t.assert.match(note, /actual paydays, month by month/);
      t.assert.doesNotMatch(note, /October 2026, actual paydays/, 'a 12-month forecast is not one month');
    },
  },
  {
    name: 'promotional financing: needs information until balance and end month are entered, then on track or short',
    viewport: 'both',
    async run(t) {
      await openSection(t, 'debts');
      const card = t.page.locator('.bud-debt-card').filter({ has: t.page.locator('h2', { hasText: /^Store card$/ }) });
      const result = card.locator('.bud-promo-result');
      t.assert.match(await result.textContent(), /Needs information/);
      t.assert.match(await result.textContent(), /Promotional balance/);
      t.assert.match(await result.textContent(), /Promotion end month/);
      t.assert.doesNotMatch(await result.textContent(), /Short|On track/, 'no judgement without the facts');
      const balance = 'input[data-bind="plan.debts[id=store-card].promo.balanceCents"]';
      const end = 'input[data-bind="plan.debts[id=store-card].promo.expiresMonth"]';
      await commit(t.page, balance, '1500', () => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'store-card').promo.balanceCents === 150000);
      t.assert.match(await result.textContent(), /Needs information/);
      t.assert.doesNotMatch(await result.textContent(), /Promotional balance/);
      await t.page.fill(end, '2027-06');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'store-card').promo.expiresMonth === '2027-06');
      await settled(t.page);
      const short = await result.textContent();
      t.assert.match(short, /Short/);
      t.assert.match(short, /\$166\.67/, 'required monthly payment');
      t.assert.match(short, /\$55\.00/, 'current payment');
      t.assert.match(short, /About \$1,005\.00/);
      await t.shot('budget-promo-short');
      await commit(t.page, balance, '400', () => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'store-card').promo.balanceCents === 40000);
      t.assert.match(await result.textContent(), /On track/);
      t.assert.match(await result.textContent(), /\$44\.45/);
    },
  },
  {
    name: 'debts use people names, ask about escrow, and illustrate only when a rate exists',
    async run(t) {
      await openSection(t, 'debts');
      const viewText = await text(t.page, '#bud-section-debts');
      t.assert.doesNotMatch(viewText, /\(p[12]\)|\bp[12]\b/, 'no raw person ids');
      t.assert.match(viewText, /Alex's personal account/);
      const card = name => t.page.locator('.bud-debt-card').filter({ has: t.page.locator('h2', { hasText: new RegExp('^' + name + '$') }) });
      // The payment badge is about the amount; who pays is in the text and may be unconfirmed.
      const samFacts = await card('Sam car loan').locator('.bud-facts').textContent();
      t.assert.match(samFacts, /paid from an account not confirmed yet.*Amount confirmed/s);
      t.assert.doesNotMatch(samFacts, /\(approximate\)/, 'the badge says approximate; the value does not repeat it');
      t.assert.match(samFacts, /Approximate/);
      t.assert.equal(await card('Mortgage').locator('select[data-bind$="escrowIncluded"]').count(), 1);
      t.assert.equal(await card('Alex car loan').locator('select[data-bind$="escrowIncluded"]').count(), 0);
      t.assert.match(await card('Mortgage').textContent(), /At least 105 more payments at 0% interest/);
      t.assert.equal(await card('Mortgage').locator('.bud-illus').count(), 0, 'no illustration without a rate');
      t.assert.equal(await card('Alex student loans').locator('.bud-illus').count(), 1, 'displayed range gives an illustration');
      await card('Alex student loans').locator('.bud-illus > summary').click();
      t.assert.match(await card('Alex student loans').locator('.bud-illus').textContent(), /not a payoff date/);
      // Entering a rate for the car loan adds a labelled illustration.
      await card('Alex car loan').locator('.bud-more > summary').click();
      await commit(t.page, 'input[data-bind="plan.debts[id=p1-car].aprPct"]', '6.5', () => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'p1-car').aprPct === 6.5);
      const illus = card('Alex car loan').locator('.bud-illus');
      t.assert.equal(await illus.count(), 1);
      await illus.locator('summary').click();
      t.assert.match(await illus.textContent(), /Illustration only, at an assumed 6\.5% APR/);
      t.assert.match(await illus.textContent(), /It is not a payoff date/);
      // Escrow answer.
      await select(t.page, 'select[data-bind="plan.debts[id=mortgage].escrowIncluded"]', 'true', () => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'mortgage').escrowIncluded === true);
      t.assert.match(await card('Mortgage').locator('.bud-escrow').textContent(), /Home insurance is also a separate bill/);
      await t.shot('budget-debts-edited');
    },
  },
  {
    name: 'add and remove a bill',
    viewport: 'both',
    async run(t) {
      await openSection(t, 'bills');
      t.assert.equal(await text(t.page, '#bud-sum-bills dd'), '$1,712');
      // Only spending categories are offered (never Transfer, Income or payments).
      const cats = await t.page.$$eval('#bud-add-bill-cat option', os => os.map(o => o.value));
      t.assert.deepEqual(cats.filter(v => ['Transfer', 'Income', 'Card payment', 'Debt payment'].includes(v)), []);
      await t.page.fill('#bud-add-bill-name', 'Gym membership');
      await t.page.fill('#bud-add-bill-amount', '45');
      await t.page.selectOption('#bud-add-bill-type', 'subscription');
      await t.page.click('#bud-add-bill button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.bills.some(b => b.label === 'Gym membership' && b.monthlyCents === 4500 && b.fundedFrom === 'joint'));
      await settled(t.page);
      t.assert.equal(await text(t.page, '#bud-sum-bills dd'), '$1,757');
      const item = t.page.locator('.bud-bill').filter({ has: t.page.locator('h4', { hasText: /^Gym membership$/ }) });
      t.assert.equal(await item.count(), 1);
      const bind = await item.locator('input[data-type="money"]').first().getAttribute('data-bind');
      await focusIs(t.page, b => document.activeElement && document.activeElement.dataset.bind === b, bind);
      await t.shot('budget-bill-added');
      // An empty name is refused inline.
      await t.page.click('#bud-add-bill button[type="submit"]');
      t.assert.ok(await t.page.isVisible('#bud-add-bill-name-error'));
      await item.locator('.bud-more > summary').click();
      await item.locator('button[data-action="budget:remove-item"]').click();
      await t.page.waitForFunction(() => !window.HouseholdBudget.getState().plan.bills.some(b => b.label === 'Gym membership'));
      await settled(t.page);
      t.assert.equal(await text(t.page, '#bud-sum-bills dd'), '$1,712');
      await focusIs(t.page, () => document.activeElement && document.activeElement.id === 'bud-add-bill-name');
    },
  },
  {
    name: 'unconfirmed bill funding is left out of the joint view and counted in the household view',
    async run(t) {
      await openSection(t, 'bills');
      t.assert.match(await text(t.page, '#bud-sum-debt'), /1 payer not confirmed/);
      t.assert.equal(await text(t.page, '#bud-sum-debt dd'), '$55');
      await select(t.page, 'select[data-bind="plan.bills[id=p2-car].fundedFrom"]', 'joint', () => window.HouseholdBudget.getState().plan.bills.find(b => b.id === 'p2-car').fundedFrom === 'joint');
      t.assert.equal(await text(t.page, '#bud-sum-debt dd'), '$427');
      t.assert.match(await text(t.page, '#bud-change'), /Remaining went from \$1,937\.64 to \$1,565\.64/);
    },
  },
  {
    name: 'savings: goal status from the projection and the joint cash balance',
    async run(t) {
      await openSection(t, 'savings');
      const goal = name => t.page.locator('.bud-goal').filter({ has: t.page.locator('h3', { hasText: new RegExp('^' + name + '$') }) });
      t.assert.match(await goal('Anniversary trip').locator('.bud-bill-head').textContent(), /On track/);
      t.assert.match(await goal('Emergency cushion').locator('.bud-bill-head').textContent(), /Starting amount unknown/);
      t.assert.match(await goal('Home projects fund').locator('.bud-bill-head').textContent(), /No target set/);
      await commit(t.page, 'input[data-bind="plan.savings[id=anniversary-trip].monthlyCents"]', '100', () => window.HouseholdBudget.getState().plan.savings.find(g => g.id === 'anniversary-trip').monthlyCents === 10000);
      t.assert.match(await goal('Anniversary trip').locator('.bud-bill-head').textContent(), /Short by \$1,200\.00/);
      // Savings set aside stays cash in the forecast, so the forecast moves differently: say why.
      t.assert.match(await text(t.page, '#bud-change'), /Money set aside for goals stays in your cash in the forecast/);
      // The sample's checking export carries a running balance, so forecasts start from the account balances
      // the Plan page shows; the single joint-cash input only appears while no account balance is known.
      t.assert.match(await t.page.textContent('#bud-cash-card'), /Forecasts start from the account balances on the Plan page: \$73,965\.80 as of Sep 30, 2026/);
      t.assert.equal(await t.page.$('#bud-cash'), null, 'no single joint-cash input when account balances are known');
    },
  },
  {
    name: 'starting cash: goal projections and missing inputs read the balance the Plan page shows',
    async run(t) {
      await openSection(t, 'savings');
      // Plan's combined anchor, Budget's projection (goal statuses) and Forecast's start, all in the page.
      const starts = () => t.page.evaluate(() => {
        const H = window.HouseholdBudget, ctx = H.context();
        const anc = H.engine.timeline.anchors(ctx.state.plan, ctx.dataset, ctx.realTxns);
        const proj = ctx.project(ctx.state.scenarios[0].id, { months: 60 });
        return {
          plan: anc.combined ? anc.combined.cents : null, asOf: anc.combined ? anc.combined.asOf : null,
          budget: proj.startBalanceCents, cashPlan: ctx.cashPlan().balances.jointCashCents,
          goals: Object.fromEntries(proj.goals.map(g => [g.id, g.status])),
          missing: ctx.plan().missing.map(m => m.id), attention: ctx.attention().map(a => a.id),
        };
      });
      const goalBadges = () => t.page.$$eval('.bud-goal', els => Object.fromEntries(els.map(e => [e.id, e.querySelector('.bud-badges').textContent.replace(/\s+/g, ' ').trim()])));
      const BADGE = { funded: /On track/, short: /Short by/, unknown_start: /Starting amount unknown/, missing_amount: /Monthly amount not set/ };
      const fidOf = id => t.page.evaluate(g => window.BudgetUI.dom.domId('bud-goal', g), id);

      // The sample: a running balance on checking, a savings balance entered on the Plan page.
      let s = await starts();
      t.assert.equal(s.plan, 7396580);
      t.assert.equal(s.budget, s.plan, 'Budget projections start from the Plan page balance');
      t.assert.equal(s.cashPlan, s.plan);
      const badges = await goalBadges();
      for (const [id, status] of Object.entries(s.goals)) if (BADGE[status]) t.assert.match(badges[await fidOf(id)], BADGE[status], id);

      // Nothing entered at all: the bank's running balance still carries a known balance.
      await t.page.evaluate(() => {
        const st = window.HouseholdBudget.getState();
        st.plan.balances = { ...st.plan.balances, jointCashCents: null, asOf: null, accounts: {}, accountDates: {} };
        window.HouseholdBudget.setState(st);
      });
      await settled(t.page);
      s = await starts();
      t.assert.equal(s.plan, 6990114, 'checking only, from the bank data');
      t.assert.equal(s.budget, s.plan);
      t.assert.equal(s.cashPlan, s.plan);
      t.assert.ok(!s.missing.includes('jointCash'), 'the plan does not list the balance as missing: ' + s.missing.join(', '));
      t.assert.ok(!s.attention.includes('balance'), 'no "Enter today’s balances" item: ' + s.attention.join(', '));
      t.assert.match(await text(t.page, '#bud-cash-card'), /Forecasts start from the account balances on the Plan page: \$69,901\.14 as of Sep 30, 2026/);
      const summary = await text(t.page, '.bud-summary');
      t.assert.doesNotMatch(summary, /Joint cash balance not entered/);
      t.assert.doesNotMatch(summary, /Enter today/);
      // Review's missing information reads the same plan and attention list.
      await t.open('#/review', { clear: false });
      await t.page.waitForSelector('#rv-missing');
      const review = await text(t.page, '#rv-missing');
      t.assert.doesNotMatch(review, /Joint cash balance not entered/);
      t.assert.doesNotMatch(review, /Enter today/);
    },
  },
  {
    name: 'not budgeted yet: add a category at its suggested amount; remove a target; add one back',
    async run(t) {
      await openSection(t, 'targets');
      // The add form offers spending categories only and does not start on one that is already a bill.
      const opts = await t.page.$$eval('#bud-add-target-cat option', os => os.map(o => ({ v: o.value, t: o.textContent, s: o.selected })));
      t.assert.deepEqual(opts.filter(o => ['Transfer', 'Income', 'Card payment', 'Debt payment'].includes(o.v)), []);
      t.assert.doesNotMatch(opts.find(o => o.s).t, /already a bill/);
      t.assert.match(opts.find(o => o.v === 'Mortgage').t, /Mortgage \(already a bill\)/);
      await t.page.click('label[for^="bud-window-6"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.settings.comparisonWindow === 6);
      await settled(t.page);
      const item = t.page.locator('.bud-unb-list li', { hasText: 'Uncategorized' });
      t.assert.match(await item.textContent(), /Usual \$13\.33 \(6-month average\)/);
      const button = item.locator('button');
      const cents = Number(await button.getAttribute('data-cents'));
      t.assert.ok(cents > 0, 'a suggested amount');
      t.assert.match(await button.textContent(), new RegExp('Add at \\$' + escapeRe((cents / 100).toFixed(2))));
      await button.click();
      await t.page.waitForFunction(c => window.HouseholdBudget.getState().plan.targets.Uncategorized === c, cents);
      await settled(t.page);
      await focusIs(t.page, () => document.activeElement && document.activeElement.dataset.bind === 'plan.targets.Uncategorized');
      t.assert.equal(await t.page.locator('.bud-unb-list li', { hasText: 'Uncategorized' }).count(), 0);
      await t.page.click('button[data-action="budget:remove-target"][data-cat="Fees & interest"]');
      await t.page.waitForFunction(() => !('Fees & interest' in window.HouseholdBudget.getState().plan.targets));
      await settled(t.page);
      await focusIs(t.page, () => document.activeElement && document.activeElement.id === 'bud-add-target-cat');
      t.assert.match(await text(t.page, '#toast'), /Removed the Fees & interest target/);
      // Add it back through the form with an amount; a bad amount is refused inline first.
      await t.page.selectOption('#bud-add-target-cat', 'Fees & interest');
      await t.page.fill('#bud-add-target-amount', 'ten');
      await t.page.click('#bud-add-target button[type="submit"]');
      t.assert.ok(await t.page.isVisible('#bud-add-target-amount-error'));
      t.assert.ok(!('Fees & interest' in (await state(t.page)).plan.targets));
      await t.page.fill('#bud-add-target-amount', '8');
      await t.page.click('#bud-add-target button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets['Fees & interest'] === 800);
    },
  },
  {
    name: 'add income, a goal and a debt; set paydays, link a payment and enter a rate range',
    async run(t) {
      await openSection(t, 'income');
      await t.page.fill('#bud-add-income-name', 'Alex side work');
      await t.page.selectOption('#bud-add-income-person', 'p1');
      await t.page.selectOption('#bud-add-income-kind', 'other');
      await t.page.click('#bud-add-income button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.incomes.some(s => s.label === 'Alex side work' && s.personId === 'p1' && s.netPerPaycheckCents === null));
      await settled(t.page);
      const id = (await state(t.page)).plan.incomes.find(s => s.label === 'Alex side work').id;
      await focusIs(t.page, b => document.activeElement && document.activeElement.dataset.bind === b, `plan.incomes[id=${id}].netPerPaycheckCents`);
      t.assert.equal(await t.page.$eval('#bud-sum-income dd', e => e.textContent), 'At least $6,410', 'unknown new income makes the total a lower bound');
      // Twice-a-month paydays
      await select(t.page, `select[data-bind="plan.incomes[id=${id}].frequency"]`, 'semimonthly', i => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === i).frequency === 'semimonthly', id);
      const days = t.page.locator(`select[data-stream="${id}"]`);
      await days.nth(0).selectOption('5');
      await t.page.waitForFunction(i => JSON.stringify(window.HouseholdBudget.getState().plan.incomes.find(s => s.id === i).semimonthlyDays) === '[5,31]', id);
      await settled(t.page);
      await t.page.locator(`select[data-stream="${id}"]`).nth(1).selectOption('5');
      await t.page.waitForSelector('.bud-days .field-error:not([hidden])');
      t.assert.equal(JSON.stringify((await state(t.page)).plan.incomes.find(s => s.id === id).semimonthlyDays), '[5,31]', 'the same day twice is refused inline');
      // Savings goal
      await openSection(t, 'savings', { clear: false });
      await t.page.fill('#bud-add-goal-name', 'Baby fund');
      await t.page.click('#bud-add-goal button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.savings.some(g => g.label === 'Baby fund' && g.spendAtTarget === false));
      await settled(t.page);
      // Debt: add, then link the store card bill and enter a displayed rate range
      await openSection(t, 'debts', { clear: false });
      await t.page.fill('#bud-add-debt-name', 'Furniture financing');
      await t.page.click('#bud-add-debt button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.debts.some(d => d.label === 'Furniture financing'));
      await settled(t.page);
      const debtId = (await state(t.page)).plan.debts.find(d => d.label === 'Furniture financing').id;
      await focusIs(t.page, b => document.activeElement && document.activeElement.dataset.bind === b, `plan.debts[id=${debtId}].balanceCents`);
      await t.page.selectOption(`select[data-action="budget:link-payment"][data-debt="${debtId}"]`, 'store-card');
      await t.page.waitForFunction(i => {
        const s = window.HouseholdBudget.getState();
        return s.plan.debts.find(d => d.id === i).paymentBillId === 'store-card' && s.plan.bills.find(b => b.id === 'store-card').debtId === i && s.plan.debts.find(d => d.id === 'store-card').paymentBillId === null;
      }, debtId);
      await settled(t.page);
      const card = t.page.locator('.bud-debt-card').filter({ has: t.page.locator('h2', { hasText: /^Furniture financing$/ }) });
      if (!(await card.locator('.bud-more').evaluate(d => d.open))) await card.locator('.bud-more > summary').click();
      await card.locator('input[data-action="budget:set-apr-range"]').nth(0).fill('5');
      await card.locator('input[data-action="budget:set-apr-range"]').nth(0).press('Tab');
      t.assert.equal((await state(t.page)).plan.debts.find(d => d.id === debtId).aprRange, null, 'half a range is not saved');
      await card.locator('input[data-action="budget:set-apr-range"]').nth(1).fill('9.5');
      await card.locator('input[data-action="budget:set-apr-range"]').nth(1).press('Tab');
      await t.page.waitForFunction(i => JSON.stringify(window.HouseholdBudget.getState().plan.debts.find(d => d.id === i).aprRange) === '[5,9.5]', debtId);
      await settled(t.page);
      t.assert.equal(await card.locator('.bud-illus').count(), 1, 'a range gives an illustration');
      t.assert.match(await card.locator('.bud-illus').textContent(), /Balance|balance/, 'it asks for the missing balance');
      // A missing debt balance links to the field inside the closed details.
      await t.page.click('#bud-missing > summary');
      await t.page.locator('#bud-missing li', { hasText: 'Furniture financing: balance not entered' }).locator('a').click();
      await focusIs(t.page, b => document.activeElement && document.activeElement.dataset.bind === b, `plan.debts[id=${debtId}].balanceCents`);
    },
  },
  {
    name: 'reload keeps edits',
    async run(t) {
      await openSection(t, 'targets');
      await commit(t.page, 'input[data-bind="plan.targets.Pets"]', '55', () => window.HouseholdBudget.getState().plan.targets.Pets === 5500);
      await openSection(t, 'bills', { clear: false });
      await select(t.page, 'select[data-bind="plan.bills[id=p2-car].fundedFrom"]', 'p2', () => window.HouseholdBudget.getState().plan.bills.find(b => b.id === 'p2-car').fundedFrom === 'p2');
      await t.page.reload();
      await t.page.waitForSelector('#bud-section-bills');
      const st = await state(t.page);
      t.assert.equal(st.plan.targets.Pets, 5500);
      t.assert.equal(st.plan.bills.find(b => b.id === 'p2-car').fundedFrom, 'p2');
      t.assert.equal(await t.page.$eval('select[data-bind="plan.bills[id=p2-car].fundedFrom"]', s => s.value), 'p2');
      t.assert.ok((await t.page.evaluate(() => location.hash)).includes('section=bills'));
    },
  },
  {
    name: 'keyboard only: tab to a target, type and press Enter',
    async run(t) {
      await openSection(t, 'targets');
      await t.page.focus('#bud-tab-targets');
      let found = false;
      for (let i = 0; i < 80 && !found; i++) {
        await t.page.keyboard.press('Tab');
        found = await t.page.evaluate(() => document.activeElement && document.activeElement.dataset.bind === 'plan.targets.Groceries');
      }
      t.assert.ok(found, 'the Groceries target is reachable with Tab');
      const id = await t.page.evaluate(() => document.activeElement.id);
      await t.page.keyboard.press(`${t.mod}+A`); // select all: Cmd+A on macOS, Ctrl+A elsewhere
      await t.page.keyboard.type('640');
      await t.page.keyboard.press('Enter');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 64000);
      await settled(t.page);
      await focusIs(t.page, i => document.activeElement && document.activeElement.id === i, id);
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,295');
      // The accessible name comes from the visible row and column headers.
      const name = await t.page.evaluate(i => document.getElementById(i).getAttribute('aria-labelledby').split(' ').map(x => document.getElementById(x).textContent.trim()).join(' '), id);
      t.assert.equal(name, 'Groceries Your target');
    },
  },
  {
    name: 'section tabs keep focus, and browser Back returns to the previous section',
    viewport: 'both',
    async run(t) {
      await t.open('#/budget');
      await t.page.waitForSelector('#bud-section-targets');
      await t.page.click('#bud-tab-bills');
      await t.page.waitForFunction(() => location.hash.includes('section=bills'));
      await t.page.waitForSelector('#bud-section-bills');
      await focusIs(t.page, () => document.activeElement && document.activeElement.id === 'bud-tab-bills');
      await t.page.click('#bud-tab-debts');
      await t.page.waitForSelector('#bud-section-debts');
      await t.page.goBack();
      await t.page.waitForSelector('#bud-section-bills');
      t.assert.equal(await t.page.$eval('#bud-tab-bills', a => a.getAttribute('aria-current')), 'page');
      t.assert.ok(await noHorizontalScroll(t.page));
      if (t.viewport === 'phone') {
        const visible = await t.page.evaluate(() => {
          const strip = document.querySelector('.bud-tabs .section-nav').getBoundingClientRect();
          const tab = document.querySelector('#bud-tab-bills').getBoundingClientRect();
          return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
        });
        t.assert.ok(visible, 'current tab is scrolled into view');
      }
    },
  },
  {
    name: 'links between sections keep keyboard focus somewhere useful, and Back returns',
    async run(t) {
      await openSection(t, 'targets');
      // A summary link: the summary stays on screen, so focus stays on the link.
      await t.page.focus('#bud-sum-bills-link');
      await t.page.keyboard.press('Enter');
      await t.page.waitForSelector('#bud-section-bills');
      await focusIs(t.page, () => document.activeElement && document.activeElement.id === 'bud-sum-bills-link');
      // A debt's payment link opens Bills with that bill's amount focused.
      await openSection(t, 'debts', { clear: false });
      const link = t.page.locator('.bud-debt-card', { has: t.page.locator('h2', { hasText: /^Mortgage$/ }) }).locator('.card-sub a');
      await link.focus();
      await t.page.keyboard.press('Enter');
      await t.page.waitForSelector('#bud-section-bills');
      await focusIs(t.page, () => document.activeElement && document.activeElement.dataset.bind === 'plan.bills[id=mortgage].monthlyCents');
      // The bill's link back to its debt focuses that debt's heading.
      const back = t.page.locator('.bud-bill', { has: t.page.locator('input[data-bind="plan.bills[id=mortgage].monthlyCents"]') });
      await back.locator('.bud-more > summary').click();
      await back.locator('.bud-more a').click();
      await t.page.waitForSelector('#bud-section-debts');
      await focusIs(t.page, () => document.activeElement && document.activeElement.tagName === 'H2' && document.activeElement.textContent === 'Mortgage');
      await t.page.goBack();
      await t.page.waitForSelector('#bud-section-bills');
    },
  },
  {
    name: 'without transaction data, history and actuals say so instead of showing $0',
    async run(t) {
      await t.open('#/budget?section=targets');
      await t.page.evaluate(() => localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: {
        schemaVersion: 2, datasetId: 'empty-test', isSynthetic: true, generatedAt: null, currency: 'USD', accounts: [], transactions: [], coverageOverrides: {}, importLog: [], references: [], notes: [],
      } })));
      await t.page.reload();
      await t.page.waitForSelector('#bud-section-targets');
      await settled(t.page);
      t.assert.match(await text(t.page, '.bud-legend'), /No complete month of transactions is loaded yet, so there is no history to show/);
      t.assert.equal(await t.page.$('#bud-fill'), null, 'nothing to fill from without history');
      t.assert.match(await t.page.$eval(GROCERIES, el => el.closest('tr').textContent), /No data.*No history/s);
      t.assert.match(await text(t.page, '.bud-summary'), /No complete month of transactions yet, so there is nothing to compare the plan with/);
      for (const section of SECTIONS) {
        await openSection(t, section, { clear: false });
        t.assert.doesNotMatch(await text(t.page, '#view'), /NaN|undefined|\bnull\b/, 'no broken values in ' + section);
      }
    },
  },
  {
    name: 'user text is shown as text, never as markup',
    async run(t) {
      await openSection(t, 'targets');
      const dialogs = [];
      t.page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
      await t.page.evaluate(x => {
        const s = window.HouseholdBudget.getState();
        s.plan.people[0].name = x;
        s.plan.incomes[0].label = x; s.plan.incomes[0].note = x;
        s.plan.bills[0].label = x; s.plan.bills[0].note = x;
        s.plan.savings[0].label = x; s.plan.savings[0].note = x;
        s.plan.debts[0].label = x; s.plan.debts[0].note = x;
        s.plan.targets[x] = 1000;
        s.plan.targets['Quote "q" & \'apos\''] = null;
        window.HouseholdBudget.setState(s);
      }, XSS);
      await t.page.waitForFunction(x => window.HouseholdBudget.getState().plan.targets[x] === 1000, XSS);
      await settled(t.page);
      for (const section of SECTIONS) {
        await openSection(t, section, { clear: false });
        await t.page.evaluate(() => document.querySelectorAll('#view details').forEach(d => { d.open = true; }));
        t.assert.equal(await t.page.$$eval('#view img', els => els.length), 0, 'no element created from user text in ' + section);
        t.assert.ok((await t.page.textContent('#view')).includes(XSS), 'the text is shown literally in ' + section);
      }
      await openSection(t, 'targets', { clear: false });
      t.assert.equal(await t.page.$$eval('input[data-bind]', (els, x) => els.filter(e => e.dataset.bind === 'plan.targets.' + x).length, XSS), 1, 'a category with markup characters is still editable');
      t.assert.equal(await t.page.$$eval('input[data-bind]', els => els.filter(e => e.dataset.bind === 'plan.targets.Quote "q" & \'apos\'').length), 1, 'quotes survive in attributes');
      t.assert.deepEqual(dialogs, []);
    },
  },
];
