'use strict';
// Shell, navigation and Home checks in a real browser.
const VIEWS = ['overview', 'spending', 'budget', 'forecast', 'review', 'data'];

async function noHorizontalScroll(page) {
  // Compare with the configured viewport: under mobile emulation innerWidth grows with overflow.
  const width = page.viewportSize().width;
  return page.evaluate(w => document.scrollingElement.scrollWidth <= w + 1, width);
}

module.exports = [
  {
    name: 'every view renders, is reachable from navigation and sets aria-current',
    viewport: 'both',
    async run(t) {
      await t.open('#/overview');
      for (const view of VIEWS) {
        const link = t.viewport === 'phone' && view === 'data' ? '.topbar-data' : `.mainnav a[data-nav="${view}"]`;
        await t.page.click(link);
        await t.page.waitForFunction(v => location.hash.startsWith('#/' + v), view);
        await t.page.waitForSelector('#page-title');
        const current = await t.page.$eval(`.mainnav a[data-nav="${view}"]`, a => a.getAttribute('aria-current'));
        t.assert.equal(current, 'page', view + ' should be current');
        const focused = await t.page.evaluate(() => document.activeElement && document.activeElement.id);
        t.assert.equal(focused, 'page-title', 'heading receives focus after navigating to ' + view);
        t.assert.ok(await noHorizontalScroll(t.page), 'no horizontal page scroll on ' + view);
        await t.shot('view-' + view);
      }
    },
  },
  {
    name: 'phone layout shows all five primary destinations in the bottom bar',
    viewport: 'phone',
    async run(t) {
      await t.open('#/overview');
      const boxes = await t.page.$$eval('.mainnav li:not(.nav-secondary) a', as => as.map(a => { const r = a.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, visible: r.width > 0 && r.height > 0 }; }));
      t.assert.equal(boxes.length, 5);
      const vw = await t.page.evaluate(() => window.innerWidth), vh = await t.page.evaluate(() => window.innerHeight);
      for (const b of boxes) {
        t.assert.ok(b.visible, 'tab visible');
        t.assert.ok(b.x >= 0 && b.right <= vw + 1, 'tab inside viewport horizontally');
        t.assert.ok(b.bottom <= vh + 1 && b.y > vh - 120, 'tab bar pinned to the bottom');
      }
      t.assert.ok(await t.page.isVisible('.topbar-data'), 'Data & privacy reachable from the top bar');
    },
  },
  {
    name: 'browser back and forward move between views; reload keeps the route',
    async run(t) {
      await t.open('#/overview');
      await t.page.click('.mainnav a[data-nav="budget"]');
      await t.page.waitForFunction(() => location.hash.startsWith('#/budget'));
      await t.page.click('.mainnav a[data-nav="forecast"]');
      await t.page.waitForFunction(() => location.hash.startsWith('#/forecast'));
      await t.page.goBack();
      await t.page.waitForFunction(() => location.hash.startsWith('#/budget'));
      t.assert.equal(await t.page.$eval('.mainnav a[data-nav="budget"]', a => a.getAttribute('aria-current')), 'page');
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
    name: 'home answers the four questions, and its numbers add up',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      assert.equal((await page.textContent('#page-title')).trim(), 'Where you stand');
      const tiles = await page.$$eval('.home-answers .metric', ms => ms.map(m => ({ label: m.querySelector('.metric-label').textContent.trim(), value: m.querySelector('.metric-value').textContent.trim() })));
      assert.deepEqual(tiles.map(x => x.label), ['Comfortable to save in October', 'You have now', 'On your current track, in 2 years']);
      // Recompute from the engine: balances now, the usual month, and 24 months of it.
      const exp = await page.evaluate(() => {
        const H = window.HouseholdBudget, B = H.engine.balances, ctx = H.context(), st = H.getState();
        const h = B.history(ctx.realTxns, ctx.dataset, { entered: st.plan.balances.accounts, asOf: st.plan.balances.accountsAsOf, months: ctx.months });
        const flows = B.monthlyFlows(ctx.realTxns, ctx.dataset, { months: ctx.months, coverageMap: ctx.coverageMap, planning: true });
        const u = B.usual(flows, { count: 12 }), comfy = B.comfortable(flows, { count: 12 });
        return { now: h.latest.total, in2y: h.latest.total + 24 * (u.inCents - u.outCents), comfy: comfy.comfortableCents, u };
      });
      const dollars = v => Math.round(v / 100).toLocaleString('en-US');
      assert.equal(tiles[1].value, '$' + dollars(exp.now));
      assert.equal(tiles[2].value, '$' + dollars(exp.in2y), 'on track = now + 24 usual months of (in − out); saving only moves money');
      assert.equal(tiles[0].value, '$' + dollars(exp.comfy));
      // A usual month splits into spending, comfortable saving and a cushion that add up to what comes in.
      const legend = await page.$$eval('.home-split-legend strong', ss => ss.map(s => Number(s.textContent.replace(/[$,]/g, ''))));
      assert.equal(legend.reduce((a, b) => a + b, 0), Math.round(exp.u.inCents / 100), 'parts add up to money in (to the dollar)');
      assert.ok(await page.isVisible('#home-chart svg'), 'balance chart drawn');
      assert.ok((await page.textContent('#home-chart .chart-legend')).includes('Dashed: projected'));
      assert.ok(await page.isHidden('.flow-table'), 'no plan tables on Home');
      await t.shot('home');
    },
  },
  {
    name: 'home what-if: sliders redraw at once, typed amounts and buttons are remembered',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const home = () => page.evaluate(() => window.HouseholdBudget.getState().ui.home);
      const result = () => page.textContent('#home-result');
      const before = await result();
      // Dragging (input events only) redraws the chart and the result without saving anything yet.
      await page.$eval('#home-out', el => { el.value = String(Number(el.value) + 500); el.dispatchEvent(new Event('input', { bubbles: true })); });
      assert.notEqual(await result(), before, 'result updated while dragging');
      assert.match(await result(), /compared with your current track/);
      assert.ok((await page.textContent('#home-chart .chart-legend')).includes('Total if nothing changes'));
      assert.equal((await home()).outCents, null, 'nothing saved until the slider is let go');
      // Keyboard: each arrow press is a change that is kept.
      await page.focus('#home-saved');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.savedCents === 27500);
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'home-saved');
      // A typed amount, with a comma, applies on Enter.
      await page.fill('#home-out-amount', '12,000');
      await page.press('#home-out-amount', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.outCents === 1200000);
      await page.waitForSelector('.home-result-warn');
      assert.match(await page.textContent('.home-result-warn'), /Checking would run out in/);
      // Remembered after a reload.
      await page.reload();
      await page.waitForSelector('#home-out-amount');
      assert.equal(await page.inputValue('#home-out-amount'), '12,000');
      assert.equal(await page.$eval('#home-out', el => Number(el.value)), 12000, 'the slider range grows to fit a typed amount');
      // "Try saving" sets the comfortable amount; "Back to usual" clears every change.
      await page.click('#home-try');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.savedCents > 25000);
      await page.click('#home-reset');
      await page.waitForFunction(() => { const h = window.HouseholdBudget.getState().ui.home; return h.inCents === null && h.p1InCents === null && h.p2InCents === null && h.outCents === null && h.savedCents === null; });
      await page.waitForSelector('#home-reset[disabled]');
      // Look further ahead.
      await page.click('label[for^="home-horizon-60"]');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.horizon === 60);
      await page.waitForFunction(() => /in 5 years/.test(document.querySelector('.home-answers').textContent));
      assert.match(await page.textContent('#home-result'), /In 5 years/);
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
        H.setState(st);
      });
      await page.waitForSelector('#home-balances');
      assert.match(await page.textContent('#home-balances'), /Joint savings export has no running balance/);
      assert.match(await page.textContent('.home-answers'), /Change since your data starts/);
      await page.fill('#home-bal-joint-savings', '4,065.00');
      await page.press('#home-bal-joint-savings', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accounts['joint-savings'] === 406500);
      await page.waitForSelector('.home-entered');
      assert.match(await page.textContent('.home-answers'), /You have now/);
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
      await page.waitForSelector('.home-answers');
      const text = await page.textContent('.home-answers');
      assert.match(text, /You have now/);
      assert.match(text, /moved to savings \$/);
      assert.ok(!/Unknown/.test(text), 'no "Unknown" savings figure');
      assert.ok((await page.textContent('#home-chart .chart-legend')).includes('Moved to savings from now'));
    },
  },
  {
    name: 'home breaks money in down by person, and a partner’s income can be changed on its own',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const tiles = await page.$$eval('#home-income-card .metric', ms => ms.map(m => [m.querySelector('.metric-label').textContent.trim(), Number(m.querySelector('.metric-value').textContent.replace(/[$,]/g, ''))]));
      assert.deepEqual(tiles.map(x => x[0]), ['Alex', 'Sam', 'Other']);
      const usualIn = await page.evaluate(() => {
        const H = window.HouseholdBudget, B = H.engine.balances, ctx = H.context();
        const flows = B.monthlyFlows(ctx.realTxns, ctx.dataset, { months: ctx.months, coverageMap: ctx.coverageMap, planning: true });
        return B.usual(flows, { count: 12 }).inCents;
      });
      assert.ok(Math.abs(tiles.reduce((s, x) => s + x[1], 0) - usualIn / 100) <= 1, 'the parts add up to money in (to the dollar)');
      assert.ok(await page.isVisible('#home-income svg'), 'month-by-month chart by person');
      assert.match(await page.textContent('label[for="home-in-p1"]'), /Alex’s income/);
      assert.match(await page.textContent('label[for="home-in-p2"]'), /Sam’s income/);
      // Sam brings in nothing for a while (leave): the 2-year total drops by exactly 24 × Sam's usual.
      const sam = tiles[1][1];
      await page.fill('#home-in-p2-amount', '0');
      await page.press('#home-in-p2-amount', 'Enter');
      await page.waitForFunction(() => window.HouseholdBudget.getState().ui.home.p2InCents === 0);
      await page.waitForFunction(() => /compared with your current track/.test(document.getElementById('home-result').textContent));
      const diff = await page.$eval('#home-result .home-diff', el => el.textContent);
      assert.match(diff, /^−/, 'less money');
      assert.equal(Number(diff.replace(/[^\d]/g, '')), 24 * sam, 'the drop is 24 months of Sam’s usual income: ' + diff);
      assert.ok(await noHorizontalScroll(page), 'no sideways scroll');
    },
  },
];
