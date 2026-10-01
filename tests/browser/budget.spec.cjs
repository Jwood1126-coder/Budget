'use strict';
// Budget view checks in a real browser (sample household: Alex & Sam, fictional).
//   BUDGET_DIST=dist/dev-budget/index.html BUDGET_RESULTS=test-results/budget node tests/browser/run.cjs budget

const SECTIONS = ['income', 'bills', 'targets', 'savings', 'debts'];
const GROCERIES = 'input[data-bind="plan.targets.Groceries"]';
const FUEL = 'input[data-bind="plan.targets.Fuel"]';

const state = page => page.evaluate(() => window.HouseholdBudget.getState());
const text = (page, sel) => page.$eval(sel, el => el.textContent.replace(/\s+/g, ' ').trim());
const noHorizontalScroll = page => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

/** Type into a bound field and commit it with Enter, then wait for the state to hold `expect`. */
async function commit(page, selector, value, check) {
  await page.fill(selector, value);
  await page.press(selector, 'Enter');
  if (check) await page.waitForFunction(check);
  await page.waitForTimeout(30); // let the scheduled re-render finish
}

async function setScope(t, scope) {
  await t.page.click(`label[for^="scope-${scope}"]`);
  await t.page.waitForFunction(s => window.HouseholdBudget.getState().ui.scope === s, scope);
  await t.page.waitForTimeout(30);
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
    return { first: levels[0], jumps, dupes, unlabelled, buttonsAsLinks };
  });
}

module.exports = [
  {
    name: 'every budget section renders beside the plan summary without horizontal scroll',
    viewport: 'both',
    async run(t) {
      await t.open('#/budget');
      t.assert.equal(await t.page.$eval('#bud-tab-targets', a => a.getAttribute('aria-current')), 'page', 'Targets is the default section');
      for (const section of SECTIONS) {
        await t.open('#/budget?section=' + section, { clear: false });
        await t.page.waitForSelector('#bud-section-' + section);
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
    name: 'editing a target updates the summary and shows what changed, with undo',
    viewport: 'both',
    async run(t) {
      await t.open('#/budget?section=targets');
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,255');
      t.assert.equal(await text(t.page, '#bud-sum-remaining dd'), '$1,938');
      t.assert.equal(await t.page.$('#bud-change'), null, 'no change shown before any edit');
      await commit(t.page, GROCERIES, '650', () => window.HouseholdBudget.getState().plan.targets.Groceries === 65000);
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,305');
      t.assert.equal(await text(t.page, '#bud-sum-remaining dd'), '$1,888');
      const change = await text(t.page, '#bud-change');
      t.assert.match(change, /Remaining went from \$1,937\.64 to \$1,887\.64 \(−\$50\.00 a month, −\$600\.00 a year\)/);
      t.assert.match(change, /12-month forecast.*\+\$26,251\.68 → \+\$25,651\.68 \(−\$600\.00\)/);
      t.assert.match(change, /Groceries target: \$600\.00 → \$650\.00 \(\+\$50\.00\)/);
      t.assert.match(await text(t.page, '#toast'), /Groceries target saved\. Remaining \$1,937\.64 → \$1,887\.64 a month \(−\$50\.00\)/);
      // The edited row compares the new target with last month's actual.
      t.assert.match(await t.page.$eval(GROCERIES, el => el.closest('tr').textContent), /Under by \$54\.00/);
      await t.shot('budget-what-changed');
      await t.page.click('#bud-undo');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 60000);
      await t.page.waitForTimeout(30);
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,255');
      t.assert.equal(await t.page.$('#bud-change'), null);
    },
  },
  {
    name: 'invalid money shows an inline error, keeps the last valid value and can be corrected',
    viewport: 'both',
    async run(t) {
      await t.open('#/budget?section=targets');
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
      await t.open('#/budget?section=targets');
      await commit(t.page, FUEL, '', () => window.HouseholdBudget.getState().plan.targets.Fuel === null);
      const st = await state(t.page);
      t.assert.ok('Fuel' in st.plan.targets, 'the target is kept');
      t.assert.equal(st.plan.targets.Fuel, null, 'blank is stored as unknown, not 0');
      t.assert.equal(await text(t.page, '#bud-sum-targets dd'), '$2,125');
      t.assert.match(await text(t.page, '#bud-sum-targets'), /7 not set: left out, not \$0/);
      t.assert.match(await t.page.$eval(FUEL, el => el.closest('tr').textContent), /Not set: left out of totals/);
      t.assert.equal(await t.page.getAttribute(FUEL, 'placeholder'), 'Not set');
      // Missing inputs: the Fuel entry links to the field.
      await t.page.click('#bud-missing > summary');
      const fix = t.page.locator('#bud-missing li', { hasText: 'Fuel target not entered' }).locator('a');
      t.assert.match(await fix.getAttribute('href'), /section=targets&focus=/);
      await t.open('#/budget?section=bills', { clear: false });
      await t.page.click('#bud-missing > summary').catch(() => {});
      if (!(await t.page.$eval('#bud-missing', d => d.open))) await t.page.click('#bud-missing > summary');
      await t.page.locator('#bud-missing li', { hasText: 'Fuel target not entered' }).locator('a').click();
      await t.page.waitForFunction(() => document.activeElement && document.activeElement.dataset.bind === 'plan.targets.Fuel');
    },
  },
  {
    name: 'changing an unknown pay frequency to biweekly changes income and the frequency table',
    async run(t) {
      await t.open('#/budget?section=income');
      await t.page.selectOption('#bud-timing', 'average');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.settings.incomeTiming === 'average');
      await setScope(t, 'household');
      const net = 'input[data-bind="plan.incomes[id=p2-pay].netPerPaycheckCents"]';
      await commit(t.page, net, '2000', () => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === 'p2-pay').netPerPaycheckCents === 200000);
      const card = t.page.locator('.bud-income-card').filter({ has: t.page.locator('h2', { hasText: /^Sam paycheck$/ }) });
      // Unknown frequency: 2 paychecks assumed; Alex biweekly averages 26/12.
      t.assert.equal(await text(t.page, '#bud-sum-income dd'), '$8,853');
      t.assert.match(await card.locator('.bud-counts').textContent(), /\$4,000\.00 a month.*assumed while the frequency is not known/s);
      t.assert.equal(await card.locator('tr.bud-freq-current').count(), 0, 'no frequency marked while unknown');
      t.assert.match(await card.locator('.bud-freq').textContent(), /plan assumes 2 paychecks a month/);
      await t.page.selectOption('select[data-bind="plan.incomes[id=p2-pay].frequency"]', 'biweekly');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === 'p2-pay').frequency === 'biweekly');
      await t.page.waitForTimeout(30);
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
    name: 'scope toggle switches joint and household income; household says "At least" while pay is unknown',
    async run(t) {
      await t.open('#/budget?section=income');
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
      await t.open('#/budget?section=targets');
      t.assert.equal(await t.page.isDisabled('#bud-fill'), true, 'nothing regular to fill in the sample');
      await commit(t.page, GROCERIES, '', () => window.HouseholdBudget.getState().plan.targets.Groceries === null);
      await commit(t.page, FUEL, '', () => window.HouseholdBudget.getState().plan.targets.Fuel === null);
      const before = (await state(t.page)).plan.targets;
      t.assert.match(await text(t.page, '#bud-fill-why'), /Groceries \$577\.27, Fuel \$133\.94/);
      t.assert.match(await text(t.page, '#bud-fill-why'), /Dental and Travel \(one unusual month/);
      await t.page.click('#bud-fill');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 57727);
      await t.page.waitForTimeout(30);
      const after = (await state(t.page)).plan.targets;
      t.assert.equal(after.Fuel, 13394);
      for (const [k, v] of Object.entries(before)) {
        if (k === 'Groceries' || k === 'Fuel') continue;
        t.assert.equal(after[k], v, k + ' unchanged (entered targets are never overwritten, other blanks stay blank)');
      }
      t.assert.equal(after.Dental, null);
      t.assert.match(await text(t.page, '#toast'), /Filled 2 empty targets from usual averages: Groceries \$577\.27, Fuel \$133\.94/);
      await t.page.click('#toast button[data-action="undo"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === null);
      const undone = (await state(t.page)).plan.targets;
      t.assert.deepEqual(undone, before, 'one undo restores every target');
    },
  },
  {
    name: 'usual window toggle changes the history column and is not an undoable plan change',
    async run(t) {
      await t.open('#/budget?section=targets');
      t.assert.match(await text(t.page, '#bt-col-usual'), /3-month average/);
      await t.page.click('label[for^="bud-window-6"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.settings.comparisonWindow === 6);
      await t.page.waitForTimeout(30);
      t.assert.match(await text(t.page, '#bt-col-usual'), /6-month average/);
      t.assert.equal(await t.page.$('#bud-change'), null);
      t.assert.match(await t.page.$eval(GROCERIES, el => el.closest('tr').querySelector('.bt-usual').textContent), /\$646\.12/);
    },
  },
  {
    name: 'promotional financing: needs information until balance and end month are entered, then on track or short',
    viewport: 'both',
    async run(t) {
      await t.open('#/budget?section=debts');
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
      await t.page.waitForTimeout(30);
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
      await t.open('#/budget?section=debts');
      const viewText = await text(t.page, '#bud-section-debts');
      t.assert.doesNotMatch(viewText, /\(p[12]\)|\bp[12]\b/, 'no raw person ids');
      t.assert.match(viewText, /Alex's personal account/);
      const card = name => t.page.locator('.bud-debt-card').filter({ has: t.page.locator('h2', { hasText: new RegExp('^' + name + '$') }) });
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
      await t.page.selectOption('select[data-bind="plan.debts[id=mortgage].escrowIncluded"]', 'true');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'mortgage').escrowIncluded === true);
      await t.page.waitForTimeout(30);
      t.assert.match(await card('Mortgage').locator('.bud-escrow').textContent(), /Home insurance is also a separate bill/);
      await t.shot('budget-debts-edited');
    },
  },
  {
    name: 'add and remove a bill',
    viewport: 'both',
    async run(t) {
      await t.open('#/budget?section=bills');
      t.assert.equal(await text(t.page, '#bud-sum-bills dd'), '$1,712');
      await t.page.fill('#bud-add-bill-name', 'Gym membership');
      await t.page.fill('#bud-add-bill-amount', '45');
      await t.page.selectOption('#bud-add-bill-type', 'subscription');
      await t.page.click('#bud-add-bill button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.bills.some(b => b.label === 'Gym membership' && b.monthlyCents === 4500 && b.fundedFrom === 'joint'));
      await t.page.waitForTimeout(30);
      t.assert.equal(await text(t.page, '#bud-sum-bills dd'), '$1,757');
      const item = t.page.locator('.bud-bill').filter({ has: t.page.locator('h4', { hasText: /^Gym membership$/ }) });
      t.assert.equal(await item.count(), 1);
      t.assert.equal(await t.page.evaluate(() => document.activeElement && document.activeElement.dataset.bind), (await item.locator('input[data-type="money"]').first().getAttribute('data-bind')), 'focus moves to the new bill amount');
      await t.shot('budget-bill-added');
      // An empty name is refused inline.
      await t.page.click('#bud-add-bill button[type="submit"]');
      t.assert.ok(await t.page.isVisible('#bud-add-bill-name-error'));
      await item.locator('.bud-more > summary').click();
      await item.locator('button[data-action="budget:remove-item"]').click();
      await t.page.waitForFunction(() => !window.HouseholdBudget.getState().plan.bills.some(b => b.label === 'Gym membership'));
      await t.page.waitForTimeout(30);
      t.assert.equal(await text(t.page, '#bud-sum-bills dd'), '$1,712');
      t.assert.equal(await t.page.evaluate(() => document.activeElement.id), 'bud-add-bill-name', 'focus moves somewhere sensible after removing');
    },
  },
  {
    name: 'unconfirmed bill funding is left out of the joint view and counted in the household view',
    async run(t) {
      await t.open('#/budget?section=bills');
      t.assert.match(await text(t.page, '#bud-sum-debt'), /1 payer not confirmed/);
      t.assert.equal(await text(t.page, '#bud-sum-debt dd'), '$55');
      await t.page.selectOption('select[data-bind="plan.bills[id=p2-car].fundedFrom"]', 'joint');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.bills.find(b => b.id === 'p2-car').fundedFrom === 'joint');
      await t.page.waitForTimeout(30);
      t.assert.equal(await text(t.page, '#bud-sum-debt dd'), '$427');
      t.assert.match(await text(t.page, '#bud-change'), /Remaining went from \$1,937\.64 to \$1,565\.64/);
    },
  },
  {
    name: 'savings: goal status from the projection and the joint cash balance',
    async run(t) {
      await t.open('#/budget?section=savings');
      const goal = name => t.page.locator('.bud-goal').filter({ has: t.page.locator('h3', { hasText: new RegExp('^' + name + '$') }) });
      t.assert.match(await goal('Anniversary trip').locator('.bud-bill-head').textContent(), /On track/);
      t.assert.match(await goal('Emergency cushion').locator('.bud-bill-head').textContent(), /Starting amount unknown/);
      t.assert.match(await goal('Home projects fund').locator('.bud-bill-head').textContent(), /No target set/);
      await commit(t.page, 'input[data-bind="plan.savings[id=anniversary-trip].monthlyCents"]', '100', () => window.HouseholdBudget.getState().plan.savings.find(g => g.id === 'anniversary-trip').monthlyCents === 10000);
      t.assert.match(await goal('Anniversary trip').locator('.bud-bill-head').textContent(), /Short by \$1,200\.00/);
      t.assert.match(await t.page.textContent('#bud-cash-card'), /Not entered: forecasts show the change in cash only/);
      await commit(t.page, '#bud-cash', '-120.50', () => window.HouseholdBudget.getState().plan.balances.jointCashCents === -12050);
      t.assert.match(await t.page.textContent('#bud-cash-card'), /Forecasts start from −\$120\.50/);
    },
  },
  {
    name: 'not budgeted yet: add a category at its usual amount; remove a target',
    async run(t) {
      await t.open('#/budget?section=targets');
      await t.page.click('label[for^="bud-window-6"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.settings.comparisonWindow === 6);
      await t.page.waitForTimeout(30);
      const item = t.page.locator('.bud-unb-list li', { hasText: 'Uncategorized' });
      t.assert.match(await item.textContent(), /Usual \$13\.33 \(6-month average\)/);
      await item.locator('button').click();
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Uncategorized === 1333);
      await t.page.waitForTimeout(30);
      t.assert.equal(await t.page.evaluate(() => document.activeElement.dataset.bind), 'plan.targets.Uncategorized', 'focus moves to the new target');
      t.assert.equal(await t.page.locator('.bud-unb-list li', { hasText: 'Uncategorized' }).count(), 0);
      await t.page.click('button[data-action="budget:remove-target"][data-cat="Fees & interest"]');
      await t.page.waitForFunction(() => !('Fees & interest' in window.HouseholdBudget.getState().plan.targets));
      await t.page.waitForTimeout(30);
      t.assert.equal(await t.page.evaluate(() => document.activeElement.id), 'bud-add-target-cat');
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
      await t.open('#/budget?section=income');
      await t.page.fill('#bud-add-income-name', 'Alex side work');
      await t.page.selectOption('#bud-add-income-person', 'p1');
      await t.page.selectOption('#bud-add-income-kind', 'other');
      await t.page.click('#bud-add-income button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.incomes.some(s => s.label === 'Alex side work' && s.personId === 'p1' && s.netPerPaycheckCents === null));
      await t.page.waitForTimeout(30);
      const id = (await state(t.page)).plan.incomes.find(s => s.label === 'Alex side work').id;
      t.assert.equal(await t.page.evaluate(() => document.activeElement.dataset.bind), `plan.incomes[id=${id}].netPerPaycheckCents`);
      t.assert.equal(await t.page.$eval('#bud-sum-income dd', e => e.textContent), 'At least $6,410', 'unknown new income makes the total a lower bound');
      // Twice-a-month paydays
      await t.page.selectOption(`select[data-bind="plan.incomes[id=${id}].frequency"]`, 'semimonthly');
      await t.page.waitForSelector(`select[data-stream="${id}"]`);
      const days = t.page.locator(`select[data-stream="${id}"]`);
      await days.nth(0).selectOption('5');
      await t.page.waitForFunction(i => JSON.stringify(window.HouseholdBudget.getState().plan.incomes.find(s => s.id === i).semimonthlyDays) === '[5,31]', id);
      await t.page.waitForTimeout(30);
      await t.page.locator(`select[data-stream="${id}"]`).nth(1).selectOption('5');
      await t.page.waitForTimeout(30);
      t.assert.ok(await t.page.locator('.bud-days .field-error:not([hidden])').count() >= 1, 'the same day twice is refused inline');
      // Savings goal
      await t.open('#/budget?section=savings', { clear: false });
      await t.page.fill('#bud-add-goal-name', 'Baby fund');
      await t.page.click('#bud-add-goal button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.savings.some(g => g.label === 'Baby fund' && g.spendAtTarget === false));
      // Debt: add, then link the store card bill and enter a displayed rate range
      await t.open('#/budget?section=debts', { clear: false });
      await t.page.fill('#bud-add-debt-name', 'Furniture financing');
      await t.page.click('#bud-add-debt button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.debts.some(d => d.label === 'Furniture financing'));
      await t.page.waitForTimeout(50);
      const debtId = (await state(t.page)).plan.debts.find(d => d.label === 'Furniture financing').id;
      t.assert.equal(await t.page.evaluate(() => document.activeElement.dataset.bind), `plan.debts[id=${debtId}].balanceCents`, 'focus moves to the new debt balance');
      await t.page.selectOption(`select[data-action="budget:link-payment"][data-debt="${debtId}"]`, 'store-card');
      await t.page.waitForFunction(i => {
        const s = window.HouseholdBudget.getState();
        return s.plan.debts.find(d => d.id === i).paymentBillId === 'store-card' && s.plan.bills.find(b => b.id === 'store-card').debtId === i && s.plan.debts.find(d => d.id === 'store-card').paymentBillId === null;
      }, debtId);
      await t.page.waitForTimeout(30);
      const card = t.page.locator('.bud-debt-card').filter({ has: t.page.locator('h2', { hasText: /^Furniture financing$/ }) });
      if (!(await card.locator('.bud-more').evaluate(d => d.open))) await card.locator('.bud-more > summary').click();
      await card.locator('input[data-action="budget:set-apr-range"]').nth(0).fill('5');
      await card.locator('input[data-action="budget:set-apr-range"]').nth(0).press('Tab');
      t.assert.equal((await state(t.page)).plan.debts.find(d => d.id === debtId).aprRange, null, 'half a range is not saved');
      await card.locator('input[data-action="budget:set-apr-range"]').nth(1).fill('9.5');
      await card.locator('input[data-action="budget:set-apr-range"]').nth(1).press('Tab');
      await t.page.waitForFunction(i => JSON.stringify(window.HouseholdBudget.getState().plan.debts.find(d => d.id === i).aprRange) === '[5,9.5]', debtId);
      await t.page.waitForTimeout(30);
      t.assert.equal(await card.locator('.bud-illus').count(), 1, 'a range gives an illustration');
      t.assert.match(await card.locator('.bud-illus').textContent(), /Balance|balance/, 'it asks for the missing balance');
      // A missing debt balance links to the field inside the closed details.
      await t.page.click('#bud-missing > summary');
      await t.page.locator('#bud-missing li', { hasText: 'Furniture financing: balance not entered' }).locator('a').click();
      await t.page.waitForFunction(i => document.activeElement && document.activeElement.dataset.bind === `plan.debts[id=${i}].balanceCents`, debtId);
    },
  },
  {
    name: 'reload keeps edits',
    async run(t) {
      await t.open('#/budget?section=targets');
      await commit(t.page, 'input[data-bind="plan.targets.Pets"]', '55', () => window.HouseholdBudget.getState().plan.targets.Pets === 5500);
      await t.open('#/budget?section=bills', { clear: false });
      await t.page.selectOption('select[data-bind="plan.bills[id=p2-car].fundedFrom"]', 'p2');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.bills.find(b => b.id === 'p2-car').fundedFrom === 'p2');
      await t.page.waitForTimeout(50);
      await t.page.reload();
      await t.page.waitForSelector('#page-title');
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
      await t.open('#/budget?section=targets');
      await t.page.focus('#bud-tab-targets');
      let found = false;
      for (let i = 0; i < 80 && !found; i++) {
        await t.page.keyboard.press('Tab');
        found = await t.page.evaluate(() => document.activeElement && document.activeElement.dataset.bind === 'plan.targets.Groceries');
      }
      t.assert.ok(found, 'the Groceries target is reachable with Tab');
      const id = await t.page.evaluate(() => document.activeElement.id);
      await t.page.keyboard.press('Control+A');
      await t.page.keyboard.type('640');
      await t.page.keyboard.press('Enter');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 64000);
      await t.page.waitForTimeout(30);
      t.assert.equal(await t.page.evaluate(() => document.activeElement.id), id, 'focus stays on the field after the re-render');
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
      await t.page.click('#bud-tab-bills');
      await t.page.waitForFunction(() => location.hash.includes('section=bills'));
      await t.page.waitForSelector('#bud-section-bills');
      t.assert.equal(await t.page.evaluate(() => document.activeElement.id), 'bud-tab-bills');
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
];
