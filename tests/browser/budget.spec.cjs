'use strict';
// Edit plan (#/budget) checks in a real browser (sample household: Alex & Sam, fictional): the one
// place for the plan's inputs. The dials' drill-down has its own checks in plan.spec.cjs.
//   node tools/build.cjs --sample --out dist/test/index.html && node tests/browser/run.cjs budget
//
// Waiting: never sleep. After a change, `settled` waits until the page shows the current plan (the
// view stamps each render) and the app is idle. Figures are worked out with the engine in the page
// (BudgetEngine.timeline.build, the build the Overview shares) and compared with what the page shows.

const XSS = '<img src=x onerror=alert(1)>';
const AREAS = ['income', 'bills', 'debts', 'savings'];

const { noHorizontalScroll, state, whole, centsOf } = require('./helpers.cjs');

const text = (page, sel) => page.$eval(sel, el => el.textContent.replace(/\s+/g, ' ').trim());
/** The amount box on a category's row in the money-out lists (open with ?section=targets). */
const planBox = cat => `input[data-action="plan:row-cents"][data-name="${cat}"]`;

/** Wait until the page shows the current plan and nothing is left to render. */
async function settled(t, page = t.page) {
  await page.waitForFunction(() => {
    const el = document.getElementById('bud-root');
    return !!el && el.__budPlan === window.HouseholdBudget.context().state.plan;
  });
  await t.settled(page);
}
const focusIs = (page, fn, arg) => page.waitForFunction(fn, arg);

/** Type into a box, commit it with Enter, wait for the state (when given) and the render. */
async function commit(t, selector, value, check, arg) {
  await t.page.fill(selector, value);
  await t.page.press(selector, 'Enter');
  if (check) await t.page.waitForFunction(check, arg);
  await settled(t);
}

async function openBudget(t, hash = '#/budget', opts) {
  await t.open(hash, opts);
  await t.page.waitForSelector('#bud-root');
  await settled(t);
}

/** Open one area of the setup details (keeping what the test has changed so far). */
async function openArea(t, area) {
  await openBudget(t, '#/budget?section=' + area, { clear: false });
  await t.page.waitForFunction(a => document.getElementById('bud-area-' + a).open, area);
}

async function select(t, selector, value, check, arg) {
  await t.page.selectOption(selector, value);
  if (check) await t.page.waitForFunction(check, arg);
  await settled(t);
}

/** The Plan screen's model as the page has it, and a fresh build from the saved state (independent of the view). */
function models(page) {
  return page.evaluate(() => {
    const H = window.HouseholdBudget, E = H.engine, ctx = H.context();
    const tl = window.BudgetUI._budget.model(ctx);
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const fresh = E.timeline.build({ txns: ctx.realTxns, dataset: ctx.dataset, plan: ctx.state.plan, settings: ctx.state.ui.plan, today: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), coverageMap: ctx.coverageMap });
    const pick = x => ({ summary: x.summary, planStart: x.planStart, lastComplete: x.lastComplete, goals: x.goals, months: x.months.map(m => ({ month: m.month, out: m.out, actualSoFar: m.actualSoFar && { out: m.actualSoFar.out, coveredDays: m.actualSoFar.coveredDays, totalDays: m.actualSoFar.totalDays } })),
      dials: Object.fromEntries(x.dials.map(dl => [dl.key, { planCents: dl.planCents, baselineCents: dl.baselineCents, rows: dl.drill && dl.drill.kind === 'categories' ? dl.drill.rows.filter(r => r.level === 1).map(r => ({ id: r.id, label: r.label, planCents: r.planCents, source: r.source })) : null }])) });
    return { view: pick(tl), fresh: pick(fresh) };
  });
}

/** Replace the dataset with a changed copy of the sample (loaded in the browser), then reload. */
async function withDataset(t, change) {
  await t.page.evaluate(src => {
    const ds = JSON.parse(JSON.stringify(window.HouseholdBudget.getDataset()));
    new Function('ds', src)(ds);
    localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: ds }));
  }, `(${change.toString()})(ds)`);
  await t.page.reload();
  await t.page.waitForSelector('#bud-root');
  await settled(t);
}

/** The sample's data reaches into October: every export covers Oct 1–12, with a few purchases. */
function partialOctober(ds) {
  for (const a of ds.accounts) if (a.coverage && a.coverage.length) a.coverage[a.coverage.length - 1].end = '2026-10-12';
  const add = (acc, date, cents, cat, merchant) => ds.transactions.push({ id: 'tx-oct-' + ds.transactions.length, accountId: acc, date, description: merchant.toUpperCase(), merchant, amountCents: cents, kind: 'spend', subtype: null, category: cat, sourceCategory: null, categoryReason: 'test', confidence: 'high', flags: [], pairId: null, matchIds: [], sourceFile: 'test.csv', sourceRow: 1, note: '' });
  add('joint-checking', '2026-10-01', -141256, 'Mortgage', 'Sample Mortgage Servicer');
  add('joint-card', '2026-10-03', -21450, 'Groceries', 'Kroger');
  add('joint-card', '2026-10-09', -19870, 'Groceries', 'Kroger');
  add('joint-card', '2026-10-05', -18800, 'Dining & takeout', 'Pine Cafe');
  add('joint-card', '2026-10-10', -14200, 'Dining & takeout', 'Pine Cafe');
  add('joint-card', '2026-10-11', -9100, 'Pets', 'Kibble Barn');
}

/** Structural checks: headings in order, unique ids, labelled controls. */
function structure(page) {
  return page.evaluate(() => {
    const view = document.getElementById('view');
    const levels = [...view.querySelectorAll('h1, h2, h3, h4')].map(h => Number(h.tagName[1]));
    const jumps = levels.filter((l, i) => i > 0 && l > levels[i - 1] + 1);
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    const unlabelled = [...view.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(el => {
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
      return !(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) && !el.closest('label');
    }).map(el => el.id || el.name || el.outerHTML.slice(0, 60));
    return { first: levels[0], jumps, dupes, unlabelled, linksWithoutHref: view.querySelectorAll('a:not([href])').length };
  });
}

module.exports = [
  {
    name: 'Edit plan: the one place for inputs, in order: money in and out, planned changes, savings goals, pay, bills and debts, settings',
    viewport: 'both',
    async run(t) {
      await openBudget(t);
      const { view, fresh } = await models(t.page);
      t.assert.deepEqual(view.summary, fresh.summary, 'the view reads the same build as a fresh one');
      t.assert.equal(await text(t.page, '#page-title'), 'Edit plan');
      t.assert.equal(await text(t.page, '.page-subtitle'), 'Joint accounts · amounts a month, from October 2026');
      const ids = await t.page.$$eval('#plan-root > *', xs => xs.map(x => x.id).filter(Boolean));
      t.assert.deepEqual(ids, ['plan-dials', 'plan-changes', 'bud-goals', 'bud-setup', 'plan-more', 'plan-live']);
      // The dials, in this order, each with its value as the plan has it.
      t.assert.deepEqual(await t.page.$$eval('#plan-dials .dial', ds => ds.map(d => d.dataset.dial)), ['p1', 'p2', 'inOther', 'essentials', 'flexible', 'irregular', 'savings', 'investing', 'other']);
      for (const [key, d] of Object.entries(view.dials)) t.assert.equal(await t.page.inputValue('#plan-dial-' + key), d.planCents === null ? '' : await t.page.evaluate(c => window.BudgetUI.dom.centsToInputText(c), d.planCents), key);
      // Not a second dashboard: no hero, no Coming up card, no investments card, no headline, no month card.
      for (const gone of ['#bud-hero', '#bud-coming', '#bud-invest', '#bud-month', '#plan-headline', '#plan-chart', '#bud-to-chart', '.bud-tt', 'input[name="scope"]']) t.assert.equal(await t.page.$$eval(gone, x => x.length), 0, gone);
      for (const a of AREAS) t.assert.equal(await t.page.$eval('#bud-area-' + a, d => d.open), false, a + ' starts folded');
      t.assert.equal(await t.page.$eval('#plan-more', d => d.open), false, 'settings folded');
      t.assert.ok(!/assistant/i.test(await text(t.page, '#view')), 'no control is labelled for an assistant');
      t.assert.ok(await noHorizontalScroll(t.page), 'no horizontal page scroll');
      const st = await structure(t.page);
      t.assert.equal(st.first, 1);
      t.assert.deepEqual(st.jumps, [], 'heading levels never skip');
      t.assert.deepEqual(st.dupes, [], 'element ids are unique');
      t.assert.deepEqual(st.unlabelled, [], 'every control has a label');
      t.assert.equal(st.linksWithoutHref, 0);
      await t.shot('edit-plan');
    },
  },
  {
    name: 'tablet and small phone widths: everything fits, every area open',
    viewport: 'both',
    async run(t) {
      const width = t.viewport === 'desktop' ? 768 : 360;
      await t.page.setViewportSize({ width, height: 900 });
      await openBudget(t);
      await t.page.evaluate(() => document.querySelectorAll('#view details').forEach(d => { d.open = true; }));
      t.assert.ok(await noHorizontalScroll(t.page), `no horizontal page scroll at ${width}px`);
      const spill = await t.page.evaluate(() => [...document.querySelectorAll('#view .card')].flatMap(card => {
        const r = card.getBoundingClientRect();
        return [...card.querySelectorAll('p, dd, dt, label, h2, h3, h4, .badge, button, a, input, .bud-row-label')]
          .filter(el => !el.closest('.table-wrap') && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > r.right + 1)
          .map(el => el.tagName + ': ' + el.textContent.trim().slice(0, 40));
      }));
      t.assert.deepEqual(spill, [], `nothing overflows its card at ${width}px`);
      await t.shot(`budget-${width}`);
    },
  },
  {
    name: 'a category amount typed on its row is the category budget: the dial and the Overview follow, with undo',
    viewport: 'both',
    async run(t) {
      await openBudget(t, '#/budget?section=targets');
      t.assert.ok(await t.page.$eval('#plan-drill-essentials', d => d.open) && await t.page.$eval('#plan-drill-flexible', d => d.open), 'section=targets opens the category lists');
      const before = (await models(t.page)).view;
      const row = Object.values(before.dials).flatMap(d => d.rows || []).find(r => r.label === 'Pets');
      t.assert.ok(row, 'Pets is a category row');
      await commit(t, planBox('Pets'), '75', () => window.HouseholdBudget.getState().plan.targets.Pets === 7500);
      const after = (await models(t.page)).view;
      const key = Object.keys(after.dials).find(k => (after.dials[k].rows || []).some(r => r.label === 'Pets'));
      t.assert.equal(after.dials[key].planCents - before.dials[key].planCents, 7500 - row.planCents, 'the dial is the new sum of its rows');
      t.assert.match(await text(t.page, '#toast'), /^Pets set to \$75 a month\./);
      await t.page.click('#undoBtn');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Pets !== 7500);
      await settled(t);
      t.assert.equal(await t.page.inputValue(planBox('Pets')), await t.page.evaluate(c => window.BudgetUI.dom.centsToInputText(c), row.planCents), 'undone');
      // A link from Transactions or Spending focuses the category's row.
      const focus = await t.page.evaluate(() => window.BudgetUI.dom.domId('bud-target', 'Groceries'));
      await t.page.goto(t.url + '#/budget?section=targets&focus=' + focus);
      await focusIs(t.page, () => document.activeElement && document.activeElement.dataset.name === 'Groceries');
    },
  },
  {
    name: 'the plan month’s own spending so far: the Overview’s breakdown of the plan month shows spent of planned',
    viewport: 'both',
    async run(t) {
      await openBudget(t);
      await withDataset(t, partialOctober);
      const { view } = await models(t.page);
      const oct = view.months.find(m => m.month === '2026-10');
      t.assert.ok(oct.actualSoFar, 'October is partly covered');
      await t.page.goto(t.url + '#/overview?month=2026-10');
      await t.page.waitForSelector('#plan-month');
      t.assert.equal(await text(t.page, '#plan-month-sofar'), 'So far: your data covers 12 days of 31.');
      t.assert.match(await text(t.page, '#plan-month-grp-flexible > summary'), new RegExp('\\' + whole(oct.actualSoFar.out.flexible) + ' so far'));
      await t.page.click('#plan-month-grp-flexible > summary');
      // Pets: $91 of a $50 plan, marked over.
      const pets = t.page.locator('#plan-month-grp-flexible .ov-mline, #plan-month-grp-essentials .ov-mline', { hasText: 'Pets' });
      await t.page.click('#plan-month-grp-essentials > summary');
      t.assert.match((await pets.first().textContent()).replace(/\s+/g, ' '), /Pets \$91 of \$50/);
      t.assert.match(await pets.first().getAttribute('class'), /is-over/);
      t.assert.ok(await noHorizontalScroll(t.page));
      await t.shot('overview-so-far');
    },
  },
  {
    name: 'goals: progress, the month the plan reaches them, and a monthly amount typed in place',
    viewport: 'both',
    async run(t) {
      await openBudget(t);
      const card = id => t.page.locator(`.bud-goal-card[data-goal="${id}"]`);
      t.assert.equal(await t.page.locator('.bud-goal-card[data-goal]').count(), 3);
      t.assert.match(await card('anniversary-trip').textContent(), /\$0 saved of \$2,400.*Not on this plan.*Spend Sep 2027/s);
      t.assert.match(await card('emergency').locator('.bud-ring-text').textContent(), /\?/, 'saved so far unknown: no percentage');
      t.assert.match(await card('home-projects').textContent(), /No target set/);
      // A smaller cushion that is half saved: the plan reaches it.
      await t.page.evaluate(() => {
        const H = window.HouseholdBudget, E = H.engine;
        let st = E.state.setPath(H.getState(), 'plan.savings[id=emergency].targetCents', 500000);
        st = E.state.setPath(st, 'plan.savings[id=emergency].savedCents', 250000);
        H.setState(st);
      });
      await settled(t);
      const goal = (await models(t.page)).view.goals.find(g => g.id === 'emergency');
      t.assert.ok(goal.reachMonth, 'the plan reaches it');
      const label = await t.page.evaluate(m => window.BudgetUI.fmt.month(m), goal.reachMonth);
      t.assert.match(await card('emergency').locator('.bud-goal-reach').textContent(), new RegExp('On track for ' + label));
      t.assert.equal((await card('emergency').locator('.bud-ring-text').textContent()).trim(), '50%');
      // The monthly amount: a bound field (validated like every saved value), the savings in the plan follow.
      const box = 'input[data-bind="plan.savings[id=emergency].monthlyCents"]';
      t.assert.equal(await t.page.$eval(box, el => el.id), await t.page.evaluate(() => window.BudgetUI.dom.domId('bud-goal-monthly', 'emergency')));
      await commit(t, box, '175', () => window.HouseholdBudget.getState().plan.savings.find(g => g.id === 'emergency').monthlyCents === 17500);
      const s = (await models(t.page)).view.summary;
      t.assert.equal(s.savingsCents, 47500, 'Σ goal monthly amounts is the savings plan');
      t.assert.equal(await t.page.inputValue('#plan-dial-savings'), '475', 'net to savings follows');
      t.assert.match(await text(t.page, '#toast'), /Emergency cushion: monthly amount saved\./);
      await t.shot('budget-goals');
    },
  },
  {
    name: 'setup areas open from links and show what they still need',
    async run(t) {
      await openBudget(t);
      t.assert.match(await text(t.page, '#bud-area-bills > summary'), /^Bills 9 bills · \$1,767 a month from joint 1 to fill$/);
      t.assert.match(await text(t.page, '#bud-area-debts > summary'), /2 to check$/);
      // A link from another view: the area opens and the field is focused.
      const bill = await t.page.evaluate(() => window.BudgetUI.dom.domId('bud-bill-amt', 'mortgage'));
      await openBudget(t, `#/budget?section=bills&focus=${bill}`, { clear: false });
      await focusIs(t.page, i => document.activeElement && document.activeElement.id === i, bill);
      t.assert.equal(await t.page.$eval('#bud-area-bills', d => d.open), true);
      // Review's "Set a target in Edit plan" link lands on the category's amount in the lists.
      const target = await t.page.evaluate(() => window.BudgetUI.dom.domId('bud-target', 'Groceries'));
      await openBudget(t, `#/budget?section=targets&focus=${target}`, { clear: false });
      await focusIs(t.page, () => document.activeElement && document.activeElement.dataset.action === 'plan:row-cents' && document.activeElement.dataset.name === 'Groceries');
      // A debt's payment link opens the bill's amount, keeping focus somewhere useful.
      await openArea(t, 'debts');
      const link = t.page.locator('.bud-debt-card', { has: t.page.locator('h3', { hasText: /^Mortgage$/ }) }).locator('.card-sub a');
      await link.focus();
      await t.page.keyboard.press('Enter');
      await focusIs(t.page, () => document.activeElement && document.activeElement.dataset.bind === 'plan.bills[id=mortgage].monthlyCents');
      t.assert.equal(await t.page.$eval('#bud-area-bills', d => d.open), true);
      await t.page.goBack();
      await t.page.waitForFunction(() => location.hash === '#/budget?section=debts');
    },
  },
  {
    name: 'pay: a frequency change updates its table; income is counted as the Plan counts it',
    async run(t) {
      await openArea(t, 'income');
      const card = name => t.page.locator('.bud-income-card').filter({ has: t.page.locator('h3', { hasText: new RegExp('^' + name + '$') }) });
      // Alex's pay reaching joint: the annual average month, the Plan dial's own figure.
      const dial = await t.page.evaluate(() => window.BudgetUI._budget.model(window.HouseholdBudget.context()).dialsByKey.p1.budgetCents);
      const alexCounts = await card('Alex paycheck').locator('.bud-counts').textContent();
      t.assert.match(alexCounts, /a month on the plan: .* the annual average/);
      t.assert.equal(centsOf(alexCounts), dial);
      t.assert.match(await card('Sam paycheck').locator('.bud-counts').textContent(), /Not counted on the plan/);
      const net = 'input[data-bind="plan.incomes[id=p2-pay].netPerPaycheckCents"]';
      await commit(t, net, '2000', () => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === 'p2-pay').netPerPaycheckCents === 200000);
      t.assert.equal(await card('Sam paycheck').locator('tr.bud-freq-current').count(), 0, 'no frequency marked while unknown');
      t.assert.match(await card('Sam paycheck').locator('.bud-freq').textContent(), /plan assumes 2 paychecks a month/);
      await select(t, 'select[data-bind="plan.incomes[id=p2-pay].frequency"]', 'biweekly', () => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === 'p2-pay').frequency === 'biweekly');
      const current = card('Sam paycheck').locator('tr.bud-freq-current');
      t.assert.equal(await current.count(), 1);
      t.assert.match(await current.textContent(), /Every two weeks.*Your setting.*\$4,000\.00.*\$6,000\.00.*\$4,333\.33.*\$52,000\.00/s);
      t.assert.match(await card('Sam paycheck').locator('.bud-freq').textContent(), /not confirmed yet/);
      t.assert.equal(await t.page.$eval('#bud-area-income', d => d.open), true, 'the area stays open after the change');
      await t.shot('budget-income');
    },
  },
  {
    name: 'promotional financing: needs information until balance and end month are entered, then on track or short',
    viewport: 'both',
    async run(t) {
      await openArea(t, 'debts');
      const card = t.page.locator('.bud-debt-card').filter({ has: t.page.locator('h3', { hasText: /^Store card$/ }) });
      const result = card.locator('.bud-promo-result');
      t.assert.match(await result.textContent(), /Needs information/);
      t.assert.doesNotMatch(await result.textContent(), /Short|On track/, 'no judgement without the facts');
      const balance = 'input[data-bind="plan.debts[id=store-card].promo.balanceCents"]';
      const end = 'input[data-bind="plan.debts[id=store-card].promo.expiresMonth"]';
      await commit(t, balance, '1500', () => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'store-card').promo.balanceCents === 150000);
      await t.page.fill(end, '2027-06');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'store-card').promo.expiresMonth === '2027-06');
      await settled(t);
      const short = await result.textContent();
      t.assert.match(short, /Short/);
      t.assert.match(short, /\$166\.67/, 'required monthly payment');
      t.assert.match(short, /About \$1,005\.00/);
      await commit(t, balance, '400', () => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'store-card').promo.balanceCents === 40000);
      t.assert.match(await result.textContent(), /On track/);
      t.assert.ok(await noHorizontalScroll(t.page));
    },
  },
  {
    name: 'debts use people names, ask about escrow, and illustrate only when a rate exists',
    async run(t) {
      await openArea(t, 'debts');
      const viewText = await text(t.page, '#bud-section-debts');
      t.assert.doesNotMatch(viewText, /\(p[12]\)|\bp[12]\b/, 'no raw person ids');
      t.assert.match(viewText, /Alex's personal account/);
      const card = name => t.page.locator('.bud-debt-card').filter({ has: t.page.locator('h3', { hasText: new RegExp('^' + name + '$') }) });
      t.assert.equal(await card('Mortgage').locator('select[data-bind$="escrowIncluded"]').count(), 1);
      t.assert.equal(await card('Alex car loan').locator('select[data-bind$="escrowIncluded"]').count(), 0);
      t.assert.match(await card('Mortgage').textContent(), /At least 105 more payments at 0% interest/);
      t.assert.equal(await card('Mortgage').locator('.bud-illus').count(), 0, 'no illustration without a rate');
      await card('Alex car loan').locator('.bud-more > summary').click();
      await commit(t, 'input[data-bind="plan.debts[id=p1-car].aprPct"]', '6.5', () => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'p1-car').aprPct === 6.5);
      const illus = card('Alex car loan').locator('.bud-illus');
      t.assert.equal(await illus.count(), 1);
      await illus.locator('summary').click();
      t.assert.match(await illus.textContent(), /Illustration only, at an assumed 6\.5% APR/);
      await select(t, 'select[data-bind="plan.debts[id=mortgage].escrowIncluded"]', 'true', () => window.HouseholdBudget.getState().plan.debts.find(d => d.id === 'mortgage').escrowIncluded === true);
      t.assert.match(await card('Mortgage').locator('.bud-escrow').textContent(), /Home insurance is also a separate bill/);
    },
  },
  {
    name: 'bills: add and remove one; each says what the plan does with it',
    viewport: 'both',
    async run(t) {
      await openArea(t, 'bills');
      const item = label => t.page.locator('.bud-bill').filter({ has: t.page.locator('h4', { hasText: new RegExp('^' + label.replace(/[()]/g, '\\$&') + '$') }) });
      t.assert.match(await item('Life insurance (being considered)').locator('.bud-badges').textContent(), /Added to the plan from Oct 2026/);
      t.assert.match(await item('Mortgage').locator('.bud-badges').textContent(), /In your spending/);
      const cats = await t.page.$$eval('#bud-add-bill-cat option', os => os.map(o => o.value));
      t.assert.deepEqual(cats.filter(v => ['Transfer', 'Income', 'Card payment', 'Debt payment'].includes(v)), []);
      await t.page.fill('#bud-add-bill-name', 'Gym membership');
      await t.page.fill('#bud-add-bill-amount', '45');
      await t.page.selectOption('#bud-add-bill-type', 'subscription');
      await t.page.click('#bud-add-bill button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.bills.some(b => b.label === 'Gym membership' && b.monthlyCents === 4500 && b.fundedFrom === 'joint'));
      await settled(t);
      t.assert.match(await text(t.page, '#bud-area-bills > summary'), /10 bills · \$1,812 a month from joint/);
      const bind = await item('Gym membership').locator('input[data-type="money"]').first().getAttribute('data-bind');
      await focusIs(t.page, b => document.activeElement && document.activeElement.dataset.bind === b, bind);
      // An empty name is refused inline.
      await t.page.click('#bud-add-bill button[type="submit"]');
      t.assert.ok(await t.page.isVisible('#bud-add-bill-name-error'));
      await item('Gym membership').locator('.bud-more > summary').click();
      await item('Gym membership').locator('button[data-action="budget:remove-item"]').click();
      await t.page.waitForFunction(() => !window.HouseholdBudget.getState().plan.bills.some(b => b.label === 'Gym membership'));
      await settled(t);
      await focusIs(t.page, () => document.activeElement && document.activeElement.id === 'bud-add-bill-name');
      // Choosing who pays an unconfirmed bill puts it on the joint plan.
      await select(t, 'select[data-bind="plan.bills[id=p2-car].fundedFrom"]', 'joint', () => window.HouseholdBudget.getState().plan.bills.find(b => b.id === 'p2-car').fundedFrom === 'joint');
      t.assert.match(await item('Sam car payment').locator('.bud-badges').textContent(), /In your spending|Added to the plan/);
    },
  },
  {
    name: 'add income, a goal and a debt; set paydays, link a payment and enter a rate range',
    async run(t) {
      await openArea(t, 'income');
      await t.page.fill('#bud-add-income-name', 'Alex side work');
      await t.page.selectOption('#bud-add-income-person', 'p1');
      await t.page.selectOption('#bud-add-income-kind', 'other');
      await t.page.click('#bud-add-income button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.incomes.some(s => s.label === 'Alex side work' && s.personId === 'p1' && s.netPerPaycheckCents === null));
      await settled(t);
      const id = (await state(t.page)).plan.incomes.find(s => s.label === 'Alex side work').id;
      await focusIs(t.page, b => document.activeElement && document.activeElement.dataset.bind === b, `plan.incomes[id=${id}].netPerPaycheckCents`);
      await select(t, `select[data-bind="plan.incomes[id=${id}].frequency"]`, 'semimonthly', i => window.HouseholdBudget.getState().plan.incomes.find(s => s.id === i).frequency === 'semimonthly', id);
      await t.page.locator(`select[data-stream="${id}"]`).nth(0).selectOption('5');
      await t.page.waitForFunction(i => JSON.stringify(window.HouseholdBudget.getState().plan.incomes.find(s => s.id === i).semimonthlyDays) === '[5,31]', id);
      await settled(t);
      await t.page.locator(`select[data-stream="${id}"]`).nth(1).selectOption('5');
      await t.page.waitForSelector('.bud-days .field-error:not([hidden])');
      t.assert.equal(JSON.stringify((await state(t.page)).plan.incomes.find(s => s.id === id).semimonthlyDays), '[5,31]', 'the same day twice is refused inline');
      // Savings goal: added, and a card of its own above.
      await openArea(t, 'savings');
      await t.page.fill('#bud-add-goal-name', 'Baby fund');
      await t.page.click('#bud-add-goal button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.savings.some(g => g.label === 'Baby fund' && g.spendAtTarget === false));
      await settled(t);
      t.assert.equal(await t.page.locator('.bud-goal-card', { hasText: 'Baby fund' }).count(), 1);
      // Debt: add, then link the store card bill and enter a displayed rate range.
      await openArea(t, 'debts');
      await t.page.fill('#bud-add-debt-name', 'Furniture financing');
      await t.page.click('#bud-add-debt button[type="submit"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.debts.some(d => d.label === 'Furniture financing'));
      await settled(t);
      const debtId = (await state(t.page)).plan.debts.find(d => d.label === 'Furniture financing').id;
      await focusIs(t.page, b => document.activeElement && document.activeElement.dataset.bind === b, `plan.debts[id=${debtId}].balanceCents`);
      await t.page.selectOption(`select[data-action="budget:link-payment"][data-debt="${debtId}"]`, 'store-card');
      await t.page.waitForFunction(i => {
        const s = window.HouseholdBudget.getState();
        return s.plan.debts.find(d => d.id === i).paymentBillId === 'store-card' && s.plan.bills.find(b => b.id === 'store-card').debtId === i && s.plan.debts.find(d => d.id === 'store-card').paymentBillId === null;
      }, debtId);
      await settled(t);
      const card = t.page.locator('.bud-debt-card').filter({ has: t.page.locator('h3', { hasText: /^Furniture financing$/ }) });
      if (!(await card.locator('.bud-more').evaluate(d => d.open))) await card.locator('.bud-more > summary').click();
      await card.locator('input[data-action="budget:set-apr-range"]').nth(0).fill('5');
      await card.locator('input[data-action="budget:set-apr-range"]').nth(0).press('Tab');
      t.assert.equal((await state(t.page)).plan.debts.find(d => d.id === debtId).aprRange, null, 'half a range is not saved');
      await card.locator('input[data-action="budget:set-apr-range"]').nth(1).fill('9.5');
      await card.locator('input[data-action="budget:set-apr-range"]').nth(1).press('Tab');
      await t.page.waitForFunction(i => JSON.stringify(window.HouseholdBudget.getState().plan.debts.find(d => d.id === i).aprRange) === '[5,9.5]', debtId);
      await settled(t);
      t.assert.equal(await card.locator('.bud-illus').count(), 1, 'a range gives an illustration');
    },
  },
  {
    name: 'reload keeps edits',
    async run(t) {
      await openBudget(t, '#/budget?section=targets');
      await commit(t, planBox('Pets'), '55', () => window.HouseholdBudget.getState().plan.targets.Pets === 5500);
      await openArea(t, 'bills');
      await select(t, 'select[data-bind="plan.bills[id=p2-car].fundedFrom"]', 'p2', () => window.HouseholdBudget.getState().plan.bills.find(b => b.id === 'p2-car').fundedFrom === 'p2');
      await t.page.reload();
      await t.page.waitForSelector('#bud-root');
      await settled(t);
      const st = await state(t.page);
      t.assert.equal(st.plan.targets.Pets, 5500);
      t.assert.equal(st.plan.bills.find(b => b.id === 'p2-car').fundedFrom, 'p2');
      await openBudget(t, '#/budget?section=targets', { clear: false });
      t.assert.equal(await t.page.inputValue(planBox('Pets')), '55');
      await openArea(t, 'bills');
      t.assert.equal(await t.page.$eval('#bud-area-bills', d => d.open), true, 'the area named in the address opens again');
    },
  },
  {
    name: 'keyboard only: tab to a category amount, type and press Enter',
    async run(t) {
      await openBudget(t, '#/budget?section=targets');
      await t.page.focus('#plan-dial-flexible');
      let found = false;
      for (let i = 0; i < 120 && !found; i++) {
        await t.page.keyboard.press('Tab');
        found = await t.page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'plan:row-cents' && document.activeElement.dataset.name === 'Groceries');
      }
      t.assert.ok(found, 'the Groceries planned amount is reachable with Tab');
      const id = await t.page.evaluate(() => document.activeElement.id);
      t.assert.equal(await t.page.getAttribute('#' + id, 'aria-label'), 'Groceries, dollars a month in the plan');
      await t.page.keyboard.press(`${t.mod}+A`);
      await t.page.keyboard.type('640');
      await t.page.keyboard.press('Enter');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 64000);
      await settled(t);
      await focusIs(t.page, i => document.activeElement && document.activeElement.id === i, id);
    },
  },
  {
    name: 'without transaction data: the setup still works, and nothing shows $0 for what is unknown',
    async run(t) {
      await openBudget(t);
      await t.page.evaluate(() => localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: {
        schemaVersion: 2, datasetId: 'empty-test', isSynthetic: true, generatedAt: null, currency: 'USD', accounts: [], transactions: [], coverageOverrides: {}, importLog: [], references: [], notes: [],
      } })));
      await t.page.reload();
      await t.page.waitForSelector('#bud-root');
      await settled(t);
      t.assert.ok(await t.page.$('#bud-empty'));
      t.assert.equal(await t.page.$$eval('#plan-dials', x => x.length), 0, 'no dials without a plan');
      await t.page.evaluate(() => document.querySelectorAll('#view details').forEach(d => { d.open = true; }));
      t.assert.doesNotMatch(await text(t.page, '#view'), /NaN|undefined|\bnull\b/, 'no broken values');
      // Goals keep their monthly amount in the setup list while there are no goal cards.
      t.assert.equal(await t.page.locator('input[data-bind="plan.savings[id=emergency].monthlyCents"]').count(), 1);
    },
  },
  {
    name: 'user text is shown as text, never as markup',
    async run(t) {
      await openBudget(t);
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
        window.HouseholdBudget.setState(s);
      }, XSS);
      await t.page.waitForFunction(x => window.HouseholdBudget.getState().plan.targets[x] === 1000, XSS);
      await settled(t);
      await t.page.evaluate(() => document.querySelectorAll('#view details').forEach(d => { d.open = true; }));
      t.assert.equal(await t.page.$$eval('#view img', els => els.length), 0, 'no element created from user text');
      t.assert.ok((await t.page.textContent('#view')).includes(XSS), 'the text is shown literally');
      t.assert.deepEqual(dialogs, []);
    },
  },
  {
    name: 'baby due date: the setup details time the baby-cost estimates; the Plan shows one caveat line and childcare’s yearly fee',
    async run(t) {
      const { page, assert } = t;
      await openBudget(t, '#/budget?section=baby');
      await page.waitForFunction(() => document.getElementById('bud-area-baby').open);
      // The sample's invented due date (14 May 2027): setup in April, supplies from May, childcare from June (+ 42 days).
      assert.equal(await page.inputValue('#bud-baby-due'), '2027-05-14');
      assert.match(await text(page, '#bud-baby-line'), /Due May 14, 2027/);
      const care0 = (await state(page)).plan.changes.find(c => c.id === 'sc-childcare');
      assert.deepEqual([care0.startMonth, care0.cents, care0.yearlyCents, care0.accepted], ['2027-06', 180000, 15000, true]);
      // A later date moves the estimates whose start months were not changed by hand.
      await page.fill('#bud-baby-due', '2027-06-25');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.settings.babyDueDate === '2027-06-25');
      await settled(t);
      const after = (await state(page)).plan.changes;
      assert.deepEqual(['baby-default-setup', 'baby-default-supplies', 'sc-childcare'].map(id => after.find(c => c.id === id).startMonth), ['2027-05', '2027-06', '2027-08']);
      await t.nav('overview');
      await page.waitForSelector('#plan-baby-caveat');
      await t.settled();
      assert.match(await text(page, '#plan-baby-caveat'), /medical costs, insurance premium changes and parental-leave pay are unknown, not \$0/);
      assert.match(await text(page, '#plan-ch-sc-childcare-yearly'), /plus \$150(\.00)? a year \(membership fee\) in Aug 2027 and every 12 months after/);
      assert.equal(await page.$$eval('#plan-baby-overlap', x => x.length), 0, 'nothing planned twice');
      // Undo puts the date and the start months back.
      await page.click('#undoBtn');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.settings.babyDueDate === '2027-05-14');
      assert.equal((await state(page)).plan.changes.find(c => c.id === 'sc-childcare').startMonth, '2027-06');
    },
  },
];
