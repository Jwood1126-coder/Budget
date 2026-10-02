'use strict';
// Shell, navigation and Home checks in a real browser.
const VIEWS = ['overview', 'spending', 'budget', 'forecast', 'review', 'data'];

async function noHorizontalScroll(page) {
  // Compare with the configured viewport: under mobile emulation innerWidth grows with overflow.
  const width = page.viewportSize().width;
  return page.evaluate(w => document.scrollingElement.scrollWidth <= w + 1, width);
}

/** Home's plan from the engine, for comparing with what the page shows. */
function scenario(page) {
  return page.evaluate(() => {
    const H = window.HouseholdBudget, E = H.engine, ctx = H.context(), st = H.getState();
    const rows = E.flows.breakdown(ctx.realTxns, ctx.dataset, { months: ctx.months, coverageMap: ctx.coverageMap, plan: st.plan });
    const base = E.flows.baseline(rows, { count: st.ui.home.baselineMonths });
    const funding = E.flows.planFunding(st.plan, { month: ctx.forecastStart, timing: st.plan.settings.incomeTiming });
    return E.flows.scenario({ base, funding, home: st.ui.home, people: ['p1', 'p2'] });
  });
}
/** Whole dollars as Home shows them: $1,234, −$1,234 (with signed: +$1,234). */
function money(cents, signed = false) {
  const d = Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
  return (cents < 0 ? '−$' : signed && cents > 0 ? '+$' : '$') + d;
}

module.exports = [
  {
    name: 'every view renders, is reachable from navigation and sets aria-current',
    viewport: 'both',
    async run(t) {
      await t.open('#/overview');
      for (const view of VIEWS) {
        if (t.viewport === 'phone' && view === 'data') await t.page.click('.topbar-data'); else await t.nav(view);
        await t.page.waitForFunction(v => location.hash.startsWith('#/' + v), view);
        await t.page.waitForSelector('#page-title');
        const current = await t.page.$$eval(`.mainnav a[data-nav="${view}"]`, as => as.map(a => a.getAttribute('aria-current')));
        t.assert.ok(current.length >= 1 && current.every(c => c === 'page'), view + ' should be current in every navigation copy');
        const focused = await t.page.evaluate(() => document.activeElement && document.activeElement.id);
        t.assert.equal(focused, 'page-title', 'heading receives focus after navigating to ' + view);
        t.assert.ok(await noHorizontalScroll(t.page), 'no horizontal page scroll on ' + view);
        await t.shot('view-' + view);
      }
    },
  },
  {
    name: 'phone tab bar: Plan, Transactions, More and Data; More opens the other three views',
    viewport: 'phone',
    async run(t) {
      await t.open('#/overview');
      const tabs = await t.page.$$eval('.mainnav > ul > li:not(.nav-secondary) > a, .mainnav > ul > li > details > summary', els => els.map(a => { const r = a.getBoundingClientRect(); return { label: a.querySelector('.nav-label').textContent.trim().replace(/\d+$/, ''), x: r.x, right: r.right, y: r.y, bottom: r.bottom, visible: r.width > 0 && r.height > 0 }; }));
      t.assert.deepEqual(tabs.map(b => b.label), ['Plan', 'Transactions', 'More', 'Data & privacy']);
      const vw = await t.page.evaluate(() => window.innerWidth), vh = await t.page.evaluate(() => window.innerHeight);
      for (const b of tabs) {
        t.assert.ok(b.visible, 'tab visible');
        t.assert.ok(b.x >= 0 && b.right <= vw + 1, 'tab inside viewport horizontally');
        t.assert.ok(b.bottom <= vh + 1 && b.y > vh - 120, 'tab bar pinned to the bottom');
      }
      t.assert.ok(!(await t.page.isVisible('.nav-desktop-only')), 'the desktop-only group is hidden on phones');
      await t.page.click('.nav-more-menu > summary');
      const more = await t.page.$$eval('.nav-more-list a', as => as.map(a => ({ view: a.dataset.nav, visible: a.getBoundingClientRect().height > 0, right: a.getBoundingClientRect().right })));
      t.assert.deepEqual(more.map(m => m.view), ['spending', 'budget', 'forecast']);
      t.assert.ok(more.every(m => m.visible && m.right <= vw + 1), 'More menu items visible and inside the viewport');
      await t.shot('nav-more');
      await t.page.click('.nav-more-list a[data-nav="budget"]');
      await t.page.waitForFunction(() => location.hash.startsWith('#/budget'));
      await t.page.waitForFunction(() => !document.querySelector('.nav-more-menu').open, null, { timeout: 3000 }).catch(() => {});
      t.assert.ok(await t.page.isVisible('.topbar-data'), 'Data & privacy reachable from the top bar');
    },
  },
  {
    name: 'browser back and forward move between views; reload keeps the route',
    async run(t) {
      await t.open('#/overview');
      await t.nav('budget');
      await t.page.waitForFunction(() => location.hash.startsWith('#/budget'));
      await t.nav('forecast');
      await t.page.waitForFunction(() => location.hash.startsWith('#/forecast'));
      await t.page.goBack();
      await t.page.waitForFunction(() => location.hash.startsWith('#/budget'));
      t.assert.equal(await t.page.$eval('.nav-desktop-only a[data-nav="budget"]', a => a.getAttribute('aria-current')), 'page');
      await t.page.goForward();
      await t.page.waitForFunction(() => location.hash.startsWith('#/forecast'));
      await t.page.reload();
      await t.page.waitForSelector('#page-title');
      t.assert.ok((await t.page.evaluate(() => location.hash)).startsWith('#/forecast'));
    },
  },
  {
    name: 'skip link and keyboard reach the main content',
    async run(t) {
      await t.open('#/overview');
      // The skip link must be the first tabbable element in document order.
      const first = await t.page.evaluate(() => {
        const sel = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
        const el = [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null || e.classList.contains('skip-link'));
        return el && el.className;
      });
      t.assert.equal(first, 'skip-link');
      await t.page.focus('.skip-link');
      t.assert.ok(await t.page.isVisible('.skip-link'), 'skip link becomes visible on focus');
      await t.page.keyboard.press('Enter');
      await t.page.waitForFunction(() => document.activeElement && document.activeElement.id === 'main');
      // Tab from main reaches interactive content inside the page, not the navigation.
      await t.page.keyboard.press('Tab');
      t.assert.ok(await t.page.evaluate(() => document.querySelector('#main').contains(document.activeElement)));
    },
  },
  {
    name: 'home shows four amounts with where each comes from, and they add up to the plan remainder',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      assert.equal((await page.textContent('#page-title')).trim(), 'Your joint plan');
      const exp = await scenario(page);
      const tile = id => page.$eval('#home-tile-' + id, el => ({ label: el.querySelector('.metric-label').textContent.trim(), value: el.querySelector('.metric-value').textContent.trim(), sub: el.querySelector('.metric-sub').textContent }));
      const [funding, card, bank, savings] = [await tile('funding'), await tile('card'), await tile('bank'), await tile('savings')];
      assert.equal(funding.value, money(exp.lines.funding.value));
      assert.equal(card.value, money(exp.lines.card.value));
      assert.equal(bank.value, money(exp.lines.bank.value));
      assert.equal(savings.value, money(exp.lines.savings.value, true));
      // Every amount says where it comes from.
      assert.match(funding.sub, /Alex \$[\d,]+ · Sam \$[\d,]+/);
      assert.match(funding.sub, /Current plan: pay in Budget, joint part only/);
      assert.match(card.sub, /Average of Oct 2025–Sep 2026, 1 one-time expense left out \(Bright Smile Dental \$860\)/);
      assert.match(bank.sub, /Average of Oct 2025–Sep 2026/);
      // Joint funding is the plan's joint contributions, not take-home pay.
      assert.equal(exp.lines.funding.value, exp.persons.reduce((s, p) => s + p.value, 0));
      // The remainder is exactly funding − cards − bank − debt − business − savings − investments.
      const L = exp.lines;
      assert.equal(exp.remainder, L.funding.value + L.otherIn.value - L.card.value - L.bank.value - L.debt.value - L.business.value - L.savings.value - L.invest.value);
      assert.equal((await page.textContent('#home-remainder .home-remainder-value strong')).trim(), money(exp.remainder, true));
      assert.match(await page.textContent('#home-remainder'), /not cash in the bank, and not a safe-to-spend amount/);
      // The main chart shows who paid in, month by month, and the plan after it.
      const legend = await page.textContent('#home-chart .chart-legend');
      for (const name of ['Alex → joint', 'Sam → joint', 'Spending (cards + bank)', 'Net to savings', 'Dashed: projected']) assert.ok(legend.includes(name), name);
      assert.match(await page.textContent('#home-chart figcaption'), /actual into joint: Alex \$[\d,]+ · Sam \$[\d,]+ · together/);
      assert.ok(await noHorizontalScroll(page), 'no sideways scroll');
      await t.shot('home');
    },
  },
  {
    name: 'home card spending: slider and exact amount stay in sync, redraw at once and leave bank-paid bills alone',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const home = () => page.evaluate(() => window.HouseholdBudget.getState().ui.home);
      const value = id => page.$eval('#home-tile-' + id + ' .metric-value', el => el.textContent.trim());
      const exp = await scenario(page);
      const bankBefore = await value('bank');
      const tableBefore = await page.$eval('#home-chart table', el => el.textContent);
      // Dragging (input events only) redraws tiles, remainder and chart, without saving yet.
      await page.$eval('#home-card', el => { el.value = String(Number(el.value) + 500); el.dispatchEvent(new Event('input', { bubbles: true })); });
      const dragged = Math.round(Number(await page.$eval('#home-card', el => el.value)) * 100);
      assert.equal(await page.inputValue('#home-card-amount'), (dragged / 100).toLocaleString('en-US'), 'exact box follows the slider');
      assert.equal(await value('card'), money(dragged));
      assert.equal(await value('bank'), bankBefore, 'bank-paid bills do not move with card spending');
      assert.equal((await page.textContent('#home-remainder strong')).trim(), money(exp.remainder - (dragged - exp.lines.card.value), true));
      assert.notEqual(await page.$eval('#home-chart table', el => el.textContent), tableBefore, 'chart redrawn');
      assert.ok((await page.textContent('#home-chart table')).includes(money(dragged + exp.lines.bank.value)), 'spending line uses the new card amount');
      assert.equal((await home()).cardCents, null, 'nothing saved until the slider is let go');
      await page.$eval('#home-card', el => el.dispatchEvent(new Event('change', { bubbles: true })));
      await page.waitForFunction(c => window.HouseholdBudget.getState().ui.home.cardCents === c, dragged);
      // An exact amount keeps its cents (the slider's $25 steps never round it).
      await page.fill('#home-card-amount', '2,345.67');
      await page.press('#home-card-amount', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.cardCents === 234567);
      await page.waitForFunction(() => document.querySelector('#home-tile-card .metric-value').textContent.trim() === '$2,346');
      assert.equal(await value('bank'), bankBefore);
      assert.match(await page.textContent('#home-tile-card'), /Your setting · baseline/);
      // Planned card spending can't go below $0: the message says so and nothing changes.
      await page.fill('#home-card-amount', '-50');
      await page.press('#home-card-amount', 'Enter');
      await page.waitForSelector('#home-card-error:not([hidden])');
      assert.match(await page.textContent('#home-card-error'), /\$0 or more/);
      assert.equal((await home()).cardCents, 234567);
      // Kept after a reload, still to the cent; a slider elsewhere does not touch it.
      await page.reload();
      await page.waitForSelector('#home-card-amount');
      assert.equal(await page.inputValue('#home-card-amount'), '2,345.67');
      await page.focus('#home-saved');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.savedCents !== null);
      assert.equal((await home()).cardCents, 234567, 'an unrelated change keeps the exact card amount');
      // "Use baseline" resets only this amount, and says what it goes back to.
      await page.click('#home-card-reset');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.cardCents === null);
      assert.notEqual((await home()).savedCents, null, 'the other change stays');
      assert.ok(await noHorizontalScroll(page), 'no sideways scroll');
    },
  },
  {
    name: 'home net savings: a drawdown with cents survives reloads and other edits; $0 is kept as $0; reset is scoped',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const home = () => page.evaluate(() => window.HouseholdBudget.getState().ui.home);
      const before = await scenario(page);
      await page.fill('#home-saved-amount', '-1,236.48');
      await page.press('#home-saved-amount', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.savedCents === -123648);
      await page.waitForFunction(() => document.querySelector('#home-tile-savings .metric-label').textContent === 'Drawn from savings');
      assert.equal((await page.textContent('#home-tile-savings .metric-value')).trim(), '−$1,236');
      assert.match(await page.textContent('#home-tile-savings'), /Drawing savings down: it does not prove the cash is there/);
      const after = await scenario(page);
      assert.equal(after.remainder - before.remainder, before.lines.savings.value + 123648, 'a drawdown raises the remainder by exactly that much');
      assert.match(await page.textContent('#home-remainder'), /\+ \$1,236 drawn from savings/);
      // The slider reaches below $0 and shows the drawdown.
      assert.ok(Number(await page.$eval('#home-saved', el => el.min)) < -1236, 'slider range covers the drawdown');
      // An unrelated change (card slider) keeps the drawdown to the cent.
      await page.focus('#home-card');
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.cardCents !== null);
      assert.equal((await home()).savedCents, -123648);
      await page.reload();
      await page.waitForSelector('#home-saved-amount');
      assert.equal(await page.inputValue('#home-saved-amount'), '-1,236.48');
      assert.equal((await home()).savedCents, -123648, 'kept after a reload');
      // Zero is an amount, not "use the baseline".
      await page.fill('#home-saved-amount', '0');
      await page.press('#home-saved-amount', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.savedCents === 0);
      await page.waitForFunction(() => document.querySelector('#home-saved-amount').value === '0');
      await page.reload();
      await page.waitForSelector('#home-saved-amount');
      assert.equal(await page.inputValue('#home-saved-amount'), '0');
      assert.equal((await page.textContent('#home-tile-savings .metric-value')).trim(), '$0');
      // Reset says what it restores, keeps other settings, and can be undone.
      await page.click('label[for^="home-horizon-60"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.horizon === 60);
      assert.match(await page.textContent('#home-reset-help'), /back to its baseline: each partner’s pay in Budget and the averages of Oct 2025–Sep 2026/);
      const edits = await page.evaluate(() => JSON.stringify(window.HouseholdBudget.getState().ledgerEdits));
      await page.click('#home-reset');
      await page.waitForFunction(() => { const h = window.HouseholdBudget.getState().ui.home; return ['inCents', 'p1InCents', 'p2InCents', 'cardCents', 'bankCents', 'savedCents'].every(k => h[k] === null); });
      assert.equal((await home()).horizon, 60, 'reset leaves the look-ahead alone');
      assert.equal(await page.evaluate(() => JSON.stringify(window.HouseholdBudget.getState().ledgerEdits)), edits, 'reset never touches transactions');
      assert.match(await page.textContent('#toast'), /back to their baselines/);
      await page.waitForSelector('#home-reset[disabled]');
      await page.click('#toast [data-action="undo"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.savedCents === 0);
    },
  },
  {
    name: 'home: each partner’s money into joint can be changed and the graphs follow; history keeps actual amounts',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const exp = await scenario(page);
      const sam = exp.persons.find(p => p.id === 'p2'), alex = exp.persons.find(p => p.id === 'p1');
      // The by-person card: actual months (stacked, provisional striped, unassigned beside) and the plan.
      const legend = await page.textContent('#home-funding-chart .chart-legend');
      for (const name of ['Alex', 'Sam', 'Not assigned', 'Striped: provisional']) assert.ok(legend.includes(name), name);
      assert.match(await page.textContent('#home-plan-funding'), new RegExp('Alex \\' + money(alex.value) + ' a month'));
      assert.match(await page.textContent('#home-plan-funding'), /Take-home pay\$2,240\.00 per paycheck · \$4,480\.00 a month/);
      assert.match(await page.textContent('#home-plan-funding'), /Kept personally\$360\.00 per paycheck · \$720\.00 a month/);
      assert.match(await page.textContent('#home-plan-funding'), /To joint\$1,880\.00 per paycheck · \$3,760\.00 a month/);
      const historyBefore = await page.$eval('#home-funding-chart table', el => el.textContent);
      // Sam pays nothing into joint for a while: funding and remainder drop by exactly Sam's plan amount.
      await page.fill('#home-in-p2-amount', '0');
      await page.press('#home-in-p2-amount', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.p2InCents === 0);
      await page.waitForFunction(() => /Sam \$0 a month/.test(document.querySelector('#home-plan-funding').textContent));
      const now = await scenario(page);
      assert.equal(now.lines.funding.value, exp.lines.funding.value - sam.value);
      assert.equal(now.remainder, exp.remainder - sam.value);
      assert.equal((await page.textContent('#home-tile-funding .metric-value')).trim(), money(alex.value));
      assert.match(await page.textContent('#home-plan-funding'), /Sam \$0 a month/);
      assert.equal(await page.$eval('#home-funding-chart table', el => el.textContent), historyBefore, 'past months keep their actual amounts');
      // The main chart's plan line for Sam is now $0.
      const lastRow = await page.$$eval('#home-chart tbody tr', trs => Array.from(trs[trs.length - 1].children).map(c => c.textContent.trim()));
      assert.equal(lastRow[2], '$0');
      // Alex puts more in: the part kept personally shrinks by the same amount.
      await page.fill('#home-in-p1-amount', '4,000');
      await page.press('#home-in-p1-amount', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.p1InCents === 400000);
      await page.waitForFunction(() => /\$480 stays/.test(document.querySelector('#home-in-p1-kept').textContent));
      assert.match(await page.textContent('#home-in-p1-kept'), /Of \$4,480 take-home a month, \$480 stays in Alex’s own account/);
      // One person at a time: the chart and its totals show only that person.
      await page.click('label[for^="home-who-p1"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.fundingWho === 'p1');
      await page.waitForFunction(() => document.querySelectorAll('#home-funding-chart thead th').length === 2);
      const heads = await page.$$eval('#home-funding-chart thead th', ths => ths.map(th => th.textContent.trim()));
      assert.deepEqual(heads, ['Month', 'Alex']);
      const cells = await page.$$eval('#home-funding-chart tbody tr', trs => trs.map(tr => tr.children[1].textContent.trim()));
      const sum = cells.filter(c => c !== '—').reduce((s, c) => s + Number(c.replace(/\(.*\)/, '').replace(/[$,\s]/g, '')), 0);
      const foot = Number((await page.textContent('#home-funding-chart tfoot td')).replace(/[$,]/g, ''));
      assert.equal(sum, foot, 'table total = sum of the months');
      assert.match(await page.textContent('#home-funding-chart figcaption'), new RegExp('Alex \\$' + foot.toLocaleString('en-US') + ' '));
      assert.ok(await noHorizontalScroll(page), 'no sideways scroll');
    },
  },
  {
    name: 'home: whose money a deposit is can be corrected, and unassigned money stays unassigned',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.click('#home-deposits > summary');
      const first = await page.$eval('#home-deposits select', el => ({ id: el.dataset.txn, options: Array.from(el.options).map(o => o.textContent) }));
      assert.match(first.options[0], /^Automatic: (Alex|Sam) \((provisional|household rule)\)|^Automatic: not assigned/);
      const txn = await page.evaluate(id => window.HouseholdBudget.context().realTxns.find(x => x.id === id), first.id);
      const month = txn.date.slice(0, 7);
      const before = await page.evaluate(m => { const H = window.HouseholdBudget, ctx = H.context(); return H.engine.flows.breakdown(ctx.realTxns, ctx.dataset, { months: [m], coverageMap: ctx.coverageMap, plan: H.getState().plan })[0].actual; }, month);
      await page.selectOption('#home-person-' + first.id, 'none');
      await page.waitForFunction(id => (window.HouseholdBudget.getState().ledgerEdits[id] || {}).person === 'none', first.id);
      const after = await page.evaluate(m => { const H = window.HouseholdBudget, ctx = H.context(); return H.engine.flows.breakdown(ctx.realTxns, ctx.dataset, { months: [m], coverageMap: ctx.coverageMap, plan: H.getState().plan })[0].actual; }, month);
      assert.equal(after.unassigned - before.unassigned, txn.amountCents, 'moved to not assigned');
      assert.equal(after.p1 + after.p2, before.p1 + before.p2 - txn.amountCents);
      assert.equal(after.moneyIn, before.moneyIn, 'money in itself is unchanged');
      const kept = await page.evaluate(id => window.HouseholdBudget.context().realTxns.find(x => x.id === id).description, first.id);
      assert.equal(kept, txn.description, 'the original description is kept');
      // Confirm the rest as shown: they stop being provisional.
      await page.click('#home-confirm-provisional');
      await page.waitForFunction(() => !document.querySelector('#home-confirm-provisional'));
      const provisional = await page.evaluate(() => { const H = window.HouseholdBudget, ctx = H.context(); const rows = H.engine.flows.breakdown(ctx.realTxns, ctx.dataset, { months: ctx.months, coverageMap: ctx.coverageMap, plan: H.getState().plan }); return H.engine.flows.baseline(rows, { count: 12 }).avg.actual.p1Provisional; });
      assert.equal(provisional, 0);
    },
  },
  {
    name: 'home: a one-time expense counts as spending but not in the plan, and can be counted as regular',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.click('#home-baseline > summary');
      const item = page.locator('#home-onetime li', { hasText: 'Bright Smile Dental' });
      assert.match(await item.textContent(), /\$860\.00 on Joint rewards card found automatically/);
      // Actual August still includes it; the plan's card baseline does not.
      const facts = await page.evaluate(() => {
        const H = window.HouseholdBudget, ctx = H.context();
        const rows = H.engine.flows.breakdown(ctx.realTxns, ctx.dataset, { months: ctx.months, coverageMap: ctx.coverageMap, plan: H.getState().plan });
        const b = H.engine.flows.baseline(rows, { count: 12 });
        return { aug: rows.find(r => r.month === '2026-08').actual.cardNet, total: b.total.actual.cardNet, planTotal: b.total.planning.cardNet, base: b.avg.planning.cardNet };
      });
      assert.equal(facts.total - facts.planTotal, 86000, 'left out of the plan only');
      assert.equal((await page.textContent('#home-tile-card .metric-value')).trim(), money(facts.base));
      // Counting it as regular puts it back into the plan (and the tile).
      await item.locator('button', { hasText: 'Count as regular' }).click();
      await page.waitForFunction(() => Object.values(window.HouseholdBudget.getState().ledgerEdits).some(e => e.planningBaseline === 'include'));
      await page.waitForFunction(v => document.querySelector('#home-tile-card .metric-value').textContent.trim() === v, money(facts.base + Math.round(86000 / 12)));
      await page.click('#home-baseline > summary').catch(() => {});
      await page.evaluate(() => { document.querySelector('#home-baseline').open = true; });
      const kept = page.locator('#home-baseline li', { hasText: 'Bright Smile Dental' });
      await kept.locator('button', { hasText: 'Treat as one-time' }).click();
      await page.waitForFunction(v => document.querySelector('#home-tile-card .metric-value').textContent.trim() === v, money(facts.base));
    },
  },
  {
    name: 'home projections never show a negative balance: savings covers checking, then a shortfall is shown',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.click('label[for^="home-view-balances"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.chartView === 'balances');
      await page.fill('#home-card-amount', '12,000');
      await page.press('#home-card-amount', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.cardCents === 1200000);
      await page.waitForSelector('#home-result .home-result-warn.tone-bad');
      assert.match(await page.textContent('#home-result'), /checking and savings can’t cover the plan: \$[\d,]+ short by/);
      assert.match(await page.textContent('#home-result'), /Balances are shown at \$0, never below/);
      assert.ok((await page.textContent('#home-chart .chart-legend')).includes('Short, not covered (so far)'));
      const rows = await page.$$eval('#home-chart tbody tr', trs => trs.filter(tr => /projected/.test(tr.firstElementChild.textContent)).map(tr => Array.from(tr.children).slice(1, 4).map(td => td.textContent.trim())));
      assert.ok(rows.length >= 24);
      for (const r of rows) for (const v of r) assert.ok(!v.startsWith('−'), 'no negative projected balance: ' + r.join(' '));
      assert.ok(await noHorizontalScroll(page), 'no sideways scroll');
    },
  },
  {
    name: 'home asks for a balance when an export has none, and uses it',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.evaluate(() => {
        const H = window.HouseholdBudget;
        const st = H.getState();
        st.plan.balances.accounts = {};
        st.ui.home.chartView = 'balances';
        H.setState(st);
      });
      await page.waitForSelector('#home-balances');
      assert.match(await page.textContent('#home-balances'), /Joint savings export has no running balance/);
      assert.match(await page.textContent('#home-chart .chart-legend'), /Savings \(change\)/);
      // Unknown balances are not projected: a projected change could go below $0.
      assert.ok(!(await page.textContent('#home-chart .chart-legend')).includes('Dashed: projected'));
      assert.match(await page.textContent('#home-result'), /Where the balances lead: not known yet/);
      assert.match(await page.textContent('#home-result'), /Each month this plan changes checking by [+−]?\$[\d,]+ and savings by [+−]?\$[\d,]+/);
      await page.fill('#home-bal-joint-savings', '4,065.00');
      await page.press('#home-bal-joint-savings', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accounts['joint-savings'] === 406500);
      await page.waitForSelector('.home-entered');
      assert.ok(!(await page.textContent('#home-chart .chart-legend')).includes('(change)'));
      assert.ok((await page.textContent('#home-chart .chart-legend')).includes('Dashed: projected'), 'projected once balances are known');
      assert.match(await page.textContent('#home-result'), /In 2 years on this plan: \$[\d,]+ in the joint accounts/);
      assert.match(await page.textContent('#home-now'), /Now \(end of September 2026\): checking \$[\d,]+ · savings \$4,065/);
      // Today's balance, typed a couple of days after the data ends, is used as of the end of the data.
      await page.click('#home-entered > summary');
      await page.fill('#home-bal-asof', '2026-10-02');
      await page.press('#home-bal-asof', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accountsAsOf === '2026-10-02');
      await page.waitForFunction(() => /Your export ends Sep 30, 2026, so it is used as the balance then/.test(document.querySelector('#home-entered').textContent));
      assert.match(await page.textContent('#home-now'), /savings \$4,065/);
      assert.ok((await page.textContent('#home-chart .chart-legend')).includes('Dashed: projected'));
      assert.ok(await noHorizontalScroll(page), 'no sideways scroll');
    },
  },
  {
    name: 'home works when the data has no savings account',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.evaluate(() => {
        const ds = JSON.parse(JSON.stringify(window.HouseholdBudget.getDataset()));
        ds.accounts = ds.accounts.filter(a => a.type !== 'savings');
        const ids = new Set(ds.accounts.map(a => a.id));
        ds.transactions = ds.transactions.filter(x => ids.has(x.accountId)).map(x => ({ ...x, pairId: ids.has((ds.transactions.find(y => y.id === x.pairId) || {}).accountId) ? x.pairId : null }));
        localStorage.setItem('household-budget:loaded-dataset', JSON.stringify({ dataset: ds, loadedAt: new Date().toISOString(), source: 'json', file: 'no-savings.json' }));
      });
      await page.reload();
      await page.waitForSelector('#home-tile-savings');
      assert.ok(!/Unknown/.test(await page.textContent('#home-plan')), 'no "Unknown" figure');
      await page.click('label[for^="home-view-balances"]');
      await page.waitForFunction(() => /Moved to savings from now/.test(document.querySelector('#home-chart .chart-legend').textContent));
    },
  },
];
