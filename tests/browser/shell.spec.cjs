'use strict';
// Shell, navigation and Overview checks in a real browser.
const VIEWS = ['overview', 'spending', 'budget', 'forecast', 'review', 'data'];

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
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
      await t.page.evaluate(() => document.activeElement.blur());
      await t.page.keyboard.press('Tab');
      t.assert.equal(await t.page.evaluate(() => document.activeElement.className), 'skip-link');
      await t.page.keyboard.press('Enter');
      t.assert.equal(await t.page.evaluate(() => document.activeElement.id), 'main');
    },
  },
  {
    name: 'overview answers in/out/remains with traceable links and a scope switch that persists',
    viewport: 'both',
    async run(t) {
      await t.open('#/overview');
      const rows = await t.page.$$eval('.flow-row [role="rowheader"] strong', els => els.map(e => e.textContent));
      t.assert.deepEqual(rows, ['Coming in', 'Spending', 'Debt payments', 'Saved', 'What remains']);
      const href = await t.page.$eval('.flow-row:nth-child(3) .num a', a => a.getAttribute('href'));
      t.assert.match(href, /^#\/spending\?period=\d{4}-\d{2}/);
      await t.page.click('label[for^="scope-household"]');
      await t.page.waitForFunction(() => window.HouseholdBudget.getState().ui.scope === 'household');
      await t.page.reload();
      await t.page.waitForSelector('#page-title');
      t.assert.equal(await t.page.evaluate(() => window.HouseholdBudget.getState().ui.scope), 'household');
      t.assert.ok(await t.page.isChecked('input[name="scope"][value="household"]'));
      t.assert.ok((await t.page.textContent('#flows')).includes('joint accounts only'));
      await t.shot('overview-household');
    },
  },
  {
    name: 'overview attention items link to where each can be fixed',
    async run(t) {
      await t.open('#/overview');
      const links = await t.page.$$eval('#attention .attention-item a', as => as.map(a => a.getAttribute('href')));
      t.assert.ok(links.length >= 3, 'several attention items for the sample household');
      for (const h of links) t.assert.match(h, /^#\/(budget|review|forecast|spending|data)/);
    },
  },
];
