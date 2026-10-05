'use strict';
// Shell and navigation checks in a real browser (the Plan screen has its own spec: plan.spec.cjs).
const VIEWS = ['overview', 'spending', 'budget', 'review', 'data'];

const { noHorizontalScroll } = require('./helpers.cjs');

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
        // aria-current is set by the render that follows the route change; wait for it rather than racing it.
        await t.page.waitForFunction(v => { const as = [...document.querySelectorAll(`.mainnav a[data-nav="${v}"]`)]; return as.length >= 1 && as.every(a => a.getAttribute('aria-current') === 'page'); }, view);
        await t.settled();
        const focused = await t.page.evaluate(() => document.activeElement && document.activeElement.id);
        t.assert.equal(focused, 'page-title', 'heading receives focus after navigating to ' + view);
        t.assert.ok(await noHorizontalScroll(t.page), 'no horizontal page scroll on ' + view);
        await t.shot('view-' + view);
      }
    },
  },
  {
    name: 'phone tab bar: Plan, Budget, Transactions and More; More opens Spending and Data & privacy',
    viewport: 'phone',
    async run(t) {
      await t.open('#/overview');
      const tabs = await t.page.$$eval('.mainnav > ul > li:not(.nav-secondary):not(.nav-phone-hide) > a, .mainnav > ul > li > details > summary', els => els.map(a => { const r = a.getBoundingClientRect(); return { label: a.querySelector('.nav-label').textContent.trim().replace(/\d+$/, ''), x: r.x, right: r.right, y: r.y, bottom: r.bottom, visible: r.width > 0 && r.height > 0 }; }));
      t.assert.deepEqual(tabs.map(b => b.label), ['Plan', 'Budget', 'Transactions', 'More']);
      const vw = await t.page.evaluate(() => window.innerWidth), vh = await t.page.evaluate(() => window.innerHeight);
      for (const b of tabs) {
        t.assert.ok(b.visible, 'tab visible');
        t.assert.ok(b.x >= 0 && b.right <= vw + 1, 'tab inside viewport horizontally');
        t.assert.ok(b.bottom <= vh + 1 && b.y > vh - 120, 'tab bar pinned to the bottom');
      }
      t.assert.ok(!(await t.page.isVisible('.nav-desktop-only')), 'the desktop-only group is hidden on phones');
      await t.page.click('.nav-more-menu > summary');
      const more = await t.page.$$eval('.nav-more-list a', as => as.map(a => ({ view: a.dataset.nav, visible: a.getBoundingClientRect().height > 0, right: a.getBoundingClientRect().right })));
      t.assert.deepEqual(more.map(m => m.view), ['spending', 'data'], 'Forecast is retired: its what-ifs are the Plan chart’s Compare');
      t.assert.ok(more.every(m => m.visible && m.right <= vw + 1), 'More menu items visible and inside the viewport');
      await t.shot('nav-more');
      await t.page.click('.nav-more-list a[data-nav="spending"]');
      await t.page.waitForFunction(() => location.hash.startsWith('#/spending'));
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
      await t.nav('spending');
      await t.page.waitForFunction(() => location.hash.startsWith('#/spending'));
      await t.page.goBack();
      await t.page.waitForFunction(() => location.hash.startsWith('#/budget'));
      t.assert.equal(await t.page.$eval('.mainnav > ul > li > a[data-nav="budget"]', a => a.getAttribute('aria-current')), 'page');
      await t.page.goForward();
      await t.page.waitForFunction(() => location.hash.startsWith('#/spending'));
      await t.page.reload();
      await t.page.waitForSelector('#page-title');
      t.assert.ok((await t.page.evaluate(() => location.hash)).startsWith('#/spending'));
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
];
