'use strict';
// Saving, several tabs, damaged or unavailable storage, Undo and keyboard/touch access, setup sync, in a real browser.
const fs = require('node:fs');
const path = require('node:path');

const KEY = 'household-budget:v5:sample';
// The amounts typed on Edit plan's category rows (?section=targets opens them; they write plan.targets).
const GROCERIES = 'input[data-action="plan:row-cents"][data-name="Groceries"]';
const FUEL = 'input[data-action="plan:row-cents"][data-name="Fuel"]';

const storedTarget = (page, cat) => page.evaluate(([k, c]) => JSON.parse(localStorage.getItem(k)).plan.targets[c], [KEY, cat]);
const stateTarget = (page, cat) => page.evaluate(c => window.HouseholdBudget.getState().plan.targets[c], cat);
const text = (page, sel) => page.$eval(sel, el => el.textContent.replace(/\s+/g, ' ').trim());

async function commit(page, selector, value) {
  await page.fill(selector, value);
  await page.press(selector, 'Enter');
}

/**
 * Scroll offsets are whole pixels while layout is not: when the browser brings a focused element to
 * the edge of the view, that edge can land up to about 1.5px past it, and where it lands depends on
 * font metrics (macOS and Linux differ). Hidden under a bar means more than that.
 */
const EDGE_TOLERANCE_PX = 2;

/** Resolve once the page has stopped scrolling: the same scroll position for three frames in a row. */
function scrollSettled(page) {
  return page.evaluate(() => new Promise(resolve => {
    let last = scrollY, same = 0;
    const tick = () => {
      if (scrollY === last) same += 1; else { same = 0; last = scrollY; }
      if (same >= 3) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

/**
 * Step a focused <select> to its next option the way the keyboard does. On Windows and Linux
 * ArrowDown changes a closed select's value at once; on macOS it opens the option list instead and
 * nothing changes until an option is picked, so there the next option is picked directly: the same
 * input and change events, one option at a time.
 */
async function stepSelect(t, selector) {
  if (!t.isMac) return t.page.keyboard.press('ArrowDown');
  const next = await t.page.$eval(selector, s => {
    const options = [...s.options];
    const i = options.findIndex((o, k) => k > s.selectedIndex && !o.disabled);
    return i >= 0 ? options[i].value : null;
  });
  t.assert.ok(next !== null, 'the select has a next option');
  await t.page.selectOption(selector, next);
}

/** A second page in the same browser profile: same storage, its own errors collected into t.errors. */
async function secondTab(t, hash) {
  const page = await t.context.newPage();
  page.on('pageerror', e => t.errors.push('tab 2 pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') t.errors.push('tab 2 console: ' + m.text()); });
  await page.goto(t.url + hash);
  await page.waitForSelector('#page-title');
  return page;
}

module.exports = [
  {
    name: 'a second tab shows changes saved in another tab and never writes over them',
    async run(t) {
      const { page: a, assert } = t;
      await t.open('#/budget?section=targets');
      const b = await secondTab(t, '#/spending');
      await commit(a, GROCERIES, '812');
      await a.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 81200);
      assert.equal(await storedTarget(a, 'Groceries'), 81200);
      // The other tab follows straight away (storage event) and says why its numbers changed.
      await b.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 81200);
      assert.match(await text(b, '#toast'), /changed in another tab/);
      // Moving around in the other tab does not bring its old copy back.
      await b.click('.mainnav a[data-nav="overview"]');
      await b.waitForFunction(() => location.hash.startsWith('#/overview'));
      await t.nav('spending', b);
      await b.waitForFunction(() => location.hash.startsWith('#/spending'));
      assert.equal(await storedTarget(a, 'Groceries'), 81200, 'navigating in tab 2 keeps tab 1’s change');
      await a.reload();
      await a.waitForSelector(GROCERIES);
      assert.match(await a.inputValue(GROCERIES), /^812(\.00)?$/);

      // A save the tab did not hear about (written behind its back) is not overwritten either:
      // the change is made to that newer budget.
      await b.goto(t.url + '#/budget?section=targets');
      await b.waitForSelector(FUEL);
      await b.evaluate(k => {
        const st = JSON.parse(localStorage.getItem(k));
        st.plan.targets.Groceries = 70000;
        localStorage.setItem(k, JSON.stringify(st)); // same-tab writes fire no storage event here
      }, KEY);
      await commit(b, FUEL, '99');
      await b.waitForFunction(() => /also changed in another tab/.test(document.getElementById('toast').textContent));
      assert.equal(await storedTarget(b, 'Groceries'), 70000, 'the newer save is kept');
      assert.equal(await storedTarget(b, 'Fuel'), 9900, 'and this tab’s change is added to it');
      assert.equal(await stateTarget(b, 'Groceries'), 70000, 'the tab now shows the newer budget');
      // Undo takes back only this tab's change.
      await b.click('#undoBtn');
      await b.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Fuel !== 9900);
      assert.equal(await storedTarget(b, 'Groceries'), 70000, 'undo keeps the other tab’s change');
      await b.close();
    },
  },
  {
    name: 'the last page is remembered without rewriting the saved budget',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const before = await page.evaluate(k => localStorage.getItem(k), KEY);
      await page.click('.mainnav a[data-nav="review"]');
      await page.waitForFunction(() => location.hash.startsWith('#/review'));
      assert.equal(await page.evaluate(k => localStorage.getItem(k), KEY), before, 'changing page does not rewrite the budget');
      // The page is noted once its render is done: wait for it before opening the page again.
      await t.settled();
      await page.goto(t.url);
      await page.waitForSelector('#page-title');
      assert.ok((await page.evaluate(() => location.hash)).startsWith('#/review'), 'opening the page again returns to the last page');
    },
  },
  {
    name: 'a toast shown inside a dialog does not break later dialogs, toasts or updates',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/data');
      await page.click('#dp-reset');
      await page.waitForSelector('#dialog[open] #dp-reset-backup');
      const download = page.waitForEvent('download');
      await page.click('#dp-reset-backup');
      await download;
      await page.waitForFunction(() => { const el = document.getElementById('toast'); return el && !el.hidden && el.closest('dialog'); });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('dialog').open);
      // A second dialog replaces the dialog's content: the toast must survive it.
      await page.click('#dp-reset');
      await page.waitForSelector('#dialog[open]');
      await page.click('#dialog button[value="cancel"]');
      await page.waitForFunction(() => !document.getElementById('dialog').open);
      assert.ok(await page.evaluate(() => document.getElementById('toast') && document.getElementById('toast').parentNode === document.body), 'the toast is back in the page');
      await page.goto(t.url + '#/budget?section=targets');
      await page.waitForSelector(GROCERIES);
      await commit(page, GROCERIES, '640');
      await page.waitForFunction(() => /Groceries/.test(document.getElementById('toast').textContent) && !document.getElementById('toast').hidden);
      assert.equal(await stateTarget(page, 'Groceries'), 64000);
      assert.equal(await page.getAttribute(GROCERIES, 'aria-invalid'), null, 'the field does not claim it could not be saved');
    },
  },
  {
    name: 'Undo stays available after the toast: top-bar button and Ctrl+Z; the toast waits while focused',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget?section=targets');
      const original = await stateTarget(page, 'Groceries');
      assert.ok(await page.isHidden('#undoBtn'), 'nothing to undo yet');
      await commit(page, GROCERIES, '777');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 77700);
      await page.waitForSelector('#undoBtn:not([hidden])');
      assert.match(await page.getAttribute('#undoBtn', 'aria-label'), /^Undo: Groceries/);
      await page.click('#undoBtn');
      await page.waitForFunction(o => window.HouseholdBudget.getState().plan.targets.Groceries === o, original);
      assert.equal(await storedTarget(page, 'Groceries'), original, 'the undo is saved');
      // Ctrl+Z (Cmd+Z on macOS) outside text fields.
      await commit(page, GROCERIES, '778');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 77800);
      await page.focus('#page-title');
      await page.keyboard.press(`${t.mod}+z`);
      await page.waitForFunction(o => window.HouseholdBudget.getState().plan.targets.Groceries === o, original);
      // Inside a text field the same chord stays the browser's own text undo.
      await commit(page, GROCERIES, '779');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 77900);
      await page.focus(GROCERIES);
      await page.keyboard.press(`${t.mod}+z`);
      assert.equal(await stateTarget(page, 'Groceries'), 77900, 'not undone from inside a field');
      // A focused toast does not time out under the keyboard user.
      await page.focus('#toast button[data-action="undo"]');
      await page.waitForTimeout(6600);
      assert.ok(await page.isVisible('#toast'), 'still shown while focused');
      await page.focus('#page-title');
      await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 8000 });
    },
  },
  {
    name: 'blocked storage is announced on every view and change messages never say saved',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.context.addInitScript(() => {
        Storage.prototype.setItem = function () { throw new DOMException('Blocked for this test', 'SecurityError'); };
      });
      await t.open('#/overview');
      for (const view of ['overview', 'spending', 'review']) {
        await page.goto(t.url + '#/' + view);
        await page.waitForSelector('#page-title');
        assert.ok(await page.isVisible('#appAlerts'), 'warning visible on ' + view);
        assert.match(await text(page, '#appAlerts'), /not being saved/);
      }
      await page.goto(t.url + '#/budget?section=targets');
      await page.waitForSelector(GROCERIES);
      await commit(page, GROCERIES, '650');
      await page.waitForFunction(() => !document.getElementById('toast').hidden && /Groceries/.test(document.getElementById('toast').textContent));
      const msg = await text(page, '#toast');
      assert.match(msg, /Not saved in this browser/);
      assert.ok(!/(^|[^t] )saved/i.test(msg.replace(/Not saved/g, '')), 'never says saved: ' + msg);
    },
  },
  {
    name: 'a save that fails part-way through (storage full) shows the reason on every view',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      await t.context.addInitScript(() => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (window.__full && String(k).startsWith('household-budget:v5:')) throw new DOMException('Quota', 'QuotaExceededError');
          return set.call(this, k, v);
        };
      });
      await t.open('#/budget?section=targets');
      assert.ok(await page.isHidden('#appAlerts'));
      await page.evaluate(() => { window.__full = true; });
      await commit(page, GROCERIES, '655');
      await page.waitForSelector('#appAlerts:not([hidden])');
      assert.match(await text(page, '#appAlerts'), /no room left/);
      assert.match(await text(page, '#toast'), /Not saved in this browser/);
      await page.click('.mainnav a[data-nav="overview"]');
      await page.waitForFunction(() => location.hash.startsWith('#/overview'));
      assert.ok(await page.isVisible('#appAlerts'), 'still shown on the next view, on a phone');
    },
  },
  {
    name: 'a damaged saved budget is announced, kept, and can be downloaded or deleted',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await page.evaluate(k => localStorage.setItem(k, '{"version":5,"plan":{"targets":{"Groceries":12345'), KEY);
      await page.reload();
      await page.waitForSelector('#appAlerts:not([hidden])');
      assert.match(await text(page, '#appAlerts'), /could not be read/);
      assert.match(await text(page, '#toast'), /could not be read/);
      await page.reload(); // still there after another reload: the copy is still kept
      await page.waitForSelector('#appAlerts:not([hidden])');
      await page.goto(t.url + '#/data');
      await page.waitForSelector('#dp-unreadable-download');
      const download = page.waitForEvent('download');
      await page.click('#dp-unreadable-download');
      const file = await download;
      assert.match(file.suggestedFilename(), /^household-budget-unreadable-copy-\d{4}-\d\d-\d\d\.txt$/);
      await page.click('#dp-unreadable-forget');
      await page.waitForSelector('#dialog[open]');
      await page.click('#dialog button[value="ok"]');
      await page.waitForFunction(() => !document.getElementById('dp-unreadable-download'));
      assert.ok(await page.isHidden('#appAlerts'), 'the warning goes with the copy');
      assert.equal(await page.evaluate(k => localStorage.getItem(k + ':unreadable'), KEY), null);
    },
  },
  {
    name: 'a saved budget picks up a changed value from a rebuilt page’s setup file and keeps the household’s own',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/budget?section=targets');
      await commit(page, GROCERIES, '650');
      await page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Groceries === 65000);
      assert.ok(await page.evaluate(k => !!JSON.parse(localStorage.getItem(k)).meta.setup.hash, KEY), 'the saved budget records the setup it has');
      // The same page rebuilt with a tuned setup file (the embedded household profile): new Fuel and
      // Groceries targets. Groceries was changed here, so it stays; Fuel was not, so it follows.
      const dist = decodeURIComponent(t.url.replace(/^file:\/\//, ''));
      const html = fs.readFileSync(dist, 'utf8');
      const open = html.indexOf('<script id="budget-profile"');
      const close = html.indexOf('</script>', open);
      assert.ok(open > 0 && close > open, 'the build embeds a profile');
      const profileText = html.slice(open, close);
      assert.ok(profileText.includes('"Fuel":13000') && profileText.includes('"Groceries":60000'));
      const rebuilt = path.join(path.dirname(dist), 'setup-sync-rebuilt.html');
      fs.writeFileSync(rebuilt, html.slice(0, open) + profileText.replace('"Fuel":13000', '"Fuel":14500').replace('"Groceries":60000', '"Groceries":62000') + html.slice(close));
      try {
        await page.goto('file://' + rebuilt + '#/budget?section=targets');
        await page.waitForSelector('#page-title');
        await page.waitForFunction(() => window.HouseholdBudget.getState().plan.targets.Fuel === 14500);
        assert.equal(await stateTarget(page, 'Groceries'), 65000, 'the household’s own target is kept');
        assert.equal(await storedTarget(page, 'Fuel'), 14500, 'and saved');
        assert.match(await text(page, '#toast'), /Your setup file updated 1 setting \(Fuel target\); kept 1 you changed here \(Groceries target\)\./);
        assert.equal(await page.inputValue(FUEL), '145');
        // Opening it again: nothing more to do, so nothing more is said.
        await page.reload();
        await page.waitForSelector('#page-title');
        assert.doesNotMatch(await page.evaluate(() => document.getElementById('toast')?.textContent || ''), /setup file/);
        assert.equal(await stateTarget(page, 'Fuel'), 14500);
      } finally {
        fs.rmSync(rebuilt, { force: true });
      }
    },
  },
  {
    name: 'a setup file with only some account balances changes those accounts only, and saves it; an empty one changes nothing',
    async run(t) {
      const { page, assert } = t;
      const dist = decodeURIComponent(t.url.replace(/^file:\/\//, ''));
      const html = fs.readFileSync(dist, 'utf8');
      const open = html.indexOf('>', html.indexOf('<script id="budget-profile"')) + 1;
      const close = html.indexOf('</script>', open);
      const base = JSON.parse(html.slice(open, close));
      // The same page rebuilt with a setup file whose account balances are `balances` (invented figures).
      const page_ = (name, balances) => {
        const prof = JSON.parse(JSON.stringify(base));
        prof.plan.balances = Object.assign({}, prof.plan.balances, balances);
        const file = path.join(path.dirname(dist), name);
        fs.writeFileSync(file, html.slice(0, open) + JSON.stringify(prof).replace(/</g, '\\u003c') + html.slice(close));
        return file;
      };
      const both = page_('setup-balances-both.html', { accounts: { 'joint-checking': 7012300, 'joint-savings': 455000 }, accountDates: { 'joint-checking': '2026-09-30', 'joint-savings': '2026-09-30' } });
      const one = page_('setup-balances-one.html', { accounts: { 'joint-checking': 7055500 }, accountDates: { 'joint-checking': '2026-10-02' } });
      const none = page_('setup-balances-none.html', { accounts: {}, accountDates: {} });
      const saved = () => page.evaluate(k => JSON.parse(localStorage.getItem(k)).plan.balances, KEY);
      const visit = async file => { await page.goto('file://' + file + '#/overview'); await page.waitForSelector('#page-title'); await t.settled(); };
      try {
        await visit(both);
        await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accounts['joint-checking'] === 7012300);
        // A file with checking only: checking follows; savings keeps its balance and date.
        await visit(one);
        await page.waitForFunction(() => window.HouseholdBudget.getState().plan.balances.accounts['joint-checking'] === 7055500);
        const expect = { accounts: { 'joint-checking': 7055500, 'joint-savings': 455000 }, accountDates: { 'joint-checking': '2026-10-02', 'joint-savings': '2026-09-30' } };
        let b = await saved();
        assert.deepEqual([b.accounts, b.accountDates], [expect.accounts, expect.accountDates], 'saved with savings kept');
        await page.reload();
        await page.waitForSelector('#page-title');
        b = await saved();
        assert.deepEqual([b.accounts, b.accountDates], [expect.accounts, expect.accountDates], 'and still after a reload');
        // Empty maps in the file: nothing changes.
        await visit(none);
        b = await saved();
        assert.deepEqual([b.accounts, b.accountDates], [expect.accounts, expect.accountDates], 'an empty map erases nothing');
        await page.reload();
        await page.waitForSelector('#page-title');
        b = await page.evaluate(() => window.HouseholdBudget.getState().plan.balances);
        assert.deepEqual([b.accounts, b.accountDates], [expect.accounts, expect.accountDates]);
      } finally {
        for (const f of [both, one, none]) fs.rmSync(f, { force: true });
      }
    },
  },
  {
    name: 'Reset on the Plan puts back the setup file’s dial value, so a rebuilt page’s changed value still reaches it',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      const dist = decodeURIComponent(t.url.replace(/^file:\/\//, ''));
      const html = fs.readFileSync(dist, 'utf8');
      const open = html.indexOf('>', html.indexOf('<script id="budget-profile"')) + 1;
      const close = html.indexOf('</script>', open);
      const base = JSON.parse(html.slice(open, close));
      // The same page rebuilt with a setup file that sets the flexible dial (invented amounts).
      const page_ = (name, flexible) => {
        const prof = JSON.parse(JSON.stringify(base));
        prof.planUi = Object.assign({}, prof.planUi, { dials: { flexible } });
        const file = path.join(path.dirname(dist), name);
        fs.writeFileSync(file, html.slice(0, open) + JSON.stringify(prof).replace(/</g, '\\u003c') + html.slice(close));
        return file;
      };
      const first = page_('setup-reset-first.html', 123400);
      const later = page_('setup-reset-later.html', 131500);
      const visit = async file => { await page.goto('file://' + file + '#/budget'); await page.waitForSelector('#page-title'); await t.settled(); };
      const stored = () => page.evaluate(k => JSON.parse(localStorage.getItem(k)).ui.plan.dials.flexible, KEY);
      try {
        await visit(first);
        await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.flexible === 123400);
        // The household moves the dial, then presses Reset: back to the setup value, not removed.
        await commit(page, '#plan-dial-flexible', '1,500');
        await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.flexible === 150000);
        assert.equal(await page.getAttribute('#plan-dial-flexible-reset', 'aria-label'), 'Reset Flexible spending to your setup value ($1,234)');
        await page.click('#plan-dial-flexible-reset');
        await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.flexible === 123400);
        assert.match(await text(page, '#toast'), /^Flexible spending is back to your setup value \(\$1,234\)\./);
        assert.equal(await stored(), 123400, 'saved as the setup value');
        // The page rebuilt with a changed value: it reaches the budget, as if never touched.
        await visit(later);
        await page.waitForFunction(() => window.HouseholdBudget.getState().ui.plan.dials.flexible === 131500);
        assert.match(await text(page, '#toast'), /Your setup file updated 1 setting \(Flexible on the plan\)\./);
        assert.doesNotMatch(await text(page, '#toast'), /kept/);
        assert.equal(await page.inputValue('#plan-dial-flexible'), '1,315');
        assert.equal(await stored(), 131500, 'and saved');
      } finally {
        for (const f of [first, later]) fs.rmSync(f, { force: true });
      }
    },
  },
  {
    name: 'damaged files loaded in the browser get the could-not-read notice and a Forget option',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/data');
      await page.evaluate(() => localStorage.setItem('household-budget:loaded-dataset', '{"dataset": {"transactions": ['));
      await page.reload();
      await page.waitForSelector('#dp-forget-error');
      assert.match(await text(page, '#dp-using'), /could not be read/);
    },
  },
  {
    name: 'on a phone Data & privacy is marked as the current page',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/data');
      assert.equal(await page.getAttribute('.topbar-data', 'aria-current'), 'page');
      await page.click('.mainnav a[data-nav="overview"]');
      await page.waitForSelector('.mainnav a[data-nav="overview"][aria-current="page"]');
      assert.equal(await page.getAttribute('.topbar-data', 'aria-current'), null);
    },
  },
  {
    name: 'keyboard focus is never hidden under the top bar or the phone tab bar',
    viewport: 'both',
    async run(t) {
      const { page, assert } = t;
      for (const route of ['#/overview', '#/budget', '#/spending']) {
        await t.open(route);
        await page.focus('#page-title');
        const hidden = [];
        for (let i = 0; i < 40; i++) {
          await page.keyboard.press('Tab');
          // Measure once the scroll the focus move caused has finished, not mid-way through it.
          await scrollSettled(page);
          const r = await page.evaluate(tol => {
            const el = document.activeElement;
            // The skip link is drawn above the top bar on purpose.
            if (!el || el === document.body || el.closest('.topbar, .mainnav, #toast') || el.classList.contains('skip-link')) return null;
            const box = el.getBoundingClientRect();
            const top = document.querySelector('.topbar').getBoundingClientRect().bottom;
            const nav = document.querySelector('.mainnav');
            const navTop = getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().top : innerHeight;
            // A region taller than the space between the bars (a long table) only needs its top edge in view.
            const fits = box.height <= navTop - top;
            const covered = fits ? box.top < top - tol || box.bottom > navTop + tol : box.top < top - tol || box.top >= navTop;
            return { id: el.id || el.textContent.trim().slice(0, 30), covered, top: box.top, bottom: box.bottom, bar: top, navTop };
          }, EDGE_TOLERANCE_PX);
          if (r && r.covered) hidden.push(`${r.id} (${Math.round(r.top)}–${Math.round(r.bottom)}px; bars end at ${Math.round(r.bar)}px and start at ${Math.round(r.navTop)}px)`);
        }
        assert.deepEqual(hidden, [], route + ': focused controls under a bar');
      }
    },
  },
  {
    name: 'arrowing through a Spending filter adds one Back step, not one per option',
    async run(t) {
      const { page, assert } = t;
      await t.open('#/overview');
      await t.nav('spending');
      await page.waitForSelector('select[data-param="period"]');
      const start = await page.evaluate(() => location.hash);
      await page.focus('select[data-param="period"]');
      for (let i = 0; i < 3; i++) {
        const before = await page.evaluate(() => [location.hash, Number(document.documentElement.dataset.renderSeq)]);
        await stepSelect(t, 'select[data-param="period"]');
        // Wait for the re-render and for focus to be back on the new select before the next key.
        await page.waitForFunction(([h, n]) => location.hash !== h && Number(document.documentElement.dataset.renderSeq) > n
          && document.activeElement && document.activeElement.matches('select[data-param="period"]'), before);
      }
      await page.goBack();
      await page.waitForFunction(s => location.hash === s, start);
      await page.goBack();
      await page.waitForFunction(() => location.hash.startsWith('#/overview'));
      assert.ok(true);
    },
  },
  {
    name: 'primary and destructive phone controls are at least 40px tall',
    viewport: 'phone',
    async run(t) {
      const { page, assert } = t;
      const small = [];
      for (const route of ['#/budget?section=bills', '#/review?queue=uncertain', '#/overview']) {
        await t.open(route);
        small.push(...await page.$$eval('#view .btn, #view .segmented label, #view .bud-plan-input input, #view input[type="range"], #view .plan-amount input', els => els
          .filter(el => el.getBoundingClientRect().width > 0)
          .map(el => ({ text: el.textContent.trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height) }))
          .filter(x => x.h < 40)).then(xs => xs.map(x => route + ' ' + x.text + ' ' + x.h + 'px')));
      }
      assert.deepEqual(small, []);
    },
  },
];
