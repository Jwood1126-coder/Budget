'use strict';
/*
 * Application bootstrap and store.
 *
 * Data flow:  embedded/loaded dataset + profile  ->  saved state (localStorage, per browser)
 *             -> derived context (effective transactions, coverage, plan, projections)
 *             -> view.render(ctx) returns HTML  ->  delegated events call actions / bindings
 *             -> app.update(fn) produces a new state -> save -> re-render.
 *
 * Views live in BudgetUI.views[name] = { title, render(ctx), actions?, afterRender?(root, ctx) }.
 * Form controls declare data-bind="<state path>" data-type="money|int|number|month|text|select|bool";
 * buttons declare data-action="<name>" with data-* arguments.
 */
(function (root) {
  const E = root.BudgetEngine;
  const UI = root.BudgetUI;
  const { $, $$, esc } = UI.dom;
  const fmt = UI.fmt;
  const views = UI.views || (UI.views = {});

  const LOADED_DATASET_KEY = 'household-budget:loaded-dataset';
  const LOADED_PROFILE_KEY = 'household-budget:loaded-profile';

  const app = {
    build: null, profile: null, dataset: null, state: null,
    loadNotes: [], datasetError: null, dataSource: 'embedded',
    storage: null, storageOk: true, saveError: null, savedText: undefined, otherTabFiles: false,
    undoStack: [], undoFocus: [], undoLabels: [], derived: null, renderTimer: null, loadedMeta: null, profileMeta: null,
  };
  const OTHER_TAB = 'This budget was changed in another tab or window, so that version is shown now.';

  // ------------------------------------------------------------------ storage
  function safeStorage() {
    try {
      const s = root.localStorage;
      const probe = '__household_budget_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch {
      return null;
    }
  }

  function readEmbedded(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
  }

  function emptyDataset() {
    return { schemaVersion: 2, datasetId: 'no-data', isSynthetic: false, generatedAt: null, currency: 'USD', accounts: [], transactions: [], coverageOverrides: {}, importLog: [], references: [], notes: [] };
  }

  function loadData() {
    app.build = readEmbedded('budget-build') || { kind: 'unknown' };
    let rawData = readEmbedded('budget-data');
    let profile = readEmbedded('budget-profile');
    let unreadableData = null;
    if (app.storage) {
      try {
        const loaded = app.storage.getItem(LOADED_DATASET_KEY);
        if (loaded) {
          app.dataSource = 'browser';
          let parsed = null;
          try { parsed = JSON.parse(loaded); } catch (err) { unreadableData = err.message; }
          if (parsed && typeof parsed === 'object') {
            rawData = parsed.dataset;
            app.loadedMeta = Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'dataset'));
          } else if (!unreadableData) unreadableData = 'it is not a data file';
        }
      } catch (err) {
        app.loadNotes.push('Could not read files loaded earlier in this browser: ' + err.message);
      }
      try {
        const loadedProfile = app.storage.getItem(LOADED_PROFILE_KEY);
        if (loadedProfile) {
          const parsed = JSON.parse(loadedProfile);
          profile = parsed.profile;
          app.profileSource = 'browser';
          app.profileMeta = Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'profile'));
        }
      } catch (err) {
        app.loadNotes.push('Could not read files loaded earlier in this browser: ' + err.message);
      }
    }
    app.profile = profile;
    if (unreadableData) {
      // Same notice and Forget option as a stored file that fails validation (Data & privacy).
      app.datasetError = 'The files loaded earlier in this browser are damaged and could not be read (' + unreadableData + ').';
      app.dataset = emptyDataset();
      return;
    }
    try {
      app.dataset = rawData ? E.ledger.normalizeDataset(rawData) : emptyDataset();
    } catch (err) {
      app.datasetError = err.message;
      app.dataset = emptyDataset();
    }
  }

  function loadState() {
    // The engine picks the earlier version's storage keys by dataset type (sample vs household),
    // so a private budget never inherits the sample page's invented figures or vice versa.
    const result = E.state.loadFromStorage(app.storage || memoryStorage(), app.dataset.datasetId, app.profile, app.dataset);
    app.state = result.state;
    app.loadNotes.push(...(result.notes || []));
    app.stateSource = result.source;
    app.savedText = readSaved();
  }

  function savedKey() { return E.state.storageKey(app.state.datasetId); }
  function lastRouteKey() { return 'household-budget:last-route:' + app.state.datasetId; }
  function unreadableKey() { return savedKey() + ':unreadable'; }
  /** The budget text currently stored for this data set (null if none or unreadable storage). */
  function readSaved() {
    if (!app.storage) return null;
    try { return app.storage.getItem(savedKey()); } catch { return null; }
  }
  function readUnreadableCopy() {
    if (!app.storage) return null;
    try { return app.storage.getItem(unreadableKey()); } catch { return null; }
  }
  function forgetUnreadableCopy() {
    try { if (app.storage) app.storage.removeItem(unreadableKey()); } catch { /* nothing to remove */ }
    updateAlerts();
  }

  function storedState() {
    return E.state.loadFromStorage(app.storage, app.dataset.datasetId, app.profile, app.dataset).state;
  }
  function clearUndo() { app.undoStack = []; app.undoFocus = []; app.undoLabels = []; }
  /**
   * Take the budget another tab saved. Every tab keeps the text it last read or wrote; when the
   * stored text is different, another tab saved since, and writing this tab's copy would silently
   * throw those changes away.
   */
  function adoptStored(message) {
    app.state = storedState();
    app.savedText = readSaved();
    clearUndo(); // undoing would bring back values from before the other tab's save
    derive();
    toast(message || OTHER_TAB);
    scheduleRender();
    updateUndoButton();
  }

  function memoryStorage() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } };
  }

  /**
   * Save the budget. Returns { ok, error, conflict }. When another tab saved since this one last
   * read or wrote, nothing is written: with `onConflict: 'return'` the caller decides, otherwise
   * the other tab's budget is shown instead.
   */
  function save({ conflictMessage, onConflict = 'adopt', force = false } = {}) {
    if (app.storage && app.savedText !== undefined && !force) {
      const current = readSaved();
      if (current !== null && current !== app.savedText) {
        if (onConflict !== 'return') adoptStored(conflictMessage);
        return { ok: false, conflict: true, error: null };
      }
    }
    const res = E.state.saveToStorage(app.storage || memoryStorage(), app.state);
    app.storageOk = !!(app.storage && res.ok);
    app.saveError = app.storageOk ? null : app.storage ? res.error : 'This browser is not letting the page store data (a private window, or storage turned off).';
    if (app.storageOk) app.savedText = readSaved();
    const el = $('#saveStatus');
    if (el) {
      el.textContent = app.storageOk ? 'Saved in this browser' : 'Not saved — export a workbook to keep changes';
      el.classList.toggle('is-error', !app.storageOk);
    }
    updateAlerts();
    return { ok: app.storageOk, conflict: false, error: app.saveError };
  }

  /** Warnings shown above every view (and at every width) while they apply. */
  function updateAlerts() {
    const host = $('#appAlerts');
    if (!host || !app.state) return;
    const onData = UI.router.current().view === 'data';
    const dataLink = onData ? '' : `<a class="btn btn-secondary btn-small" href="#/data">Go to Data &amp; privacy</a>`;
    const parts = [];
    if (!app.storageOk) {
      parts.push(UI.c.notice({ tone: 'bad', title: 'Changes are not being saved in this browser',
        body: esc(app.saveError || 'Browser storage is not available.') + ' Changes stay on this page until it is closed. To keep them, export a workbook from Data &amp; privacy.',
        actions: dataLink }));
    }
    if (readUnreadableCopy() !== null) {
      parts.push(UI.c.notice({ tone: 'warn', title: 'A budget saved in this browser could not be read',
        body: 'It was damaged, so the starting values from the household profile are in use. The damaged copy is kept: you can download it or delete it in Data &amp; privacy.',
        actions: dataLink }));
    }
    if (app.otherTabFiles) {
      parts.push(UI.c.notice({ tone: 'info', title: 'Data files were changed in another tab',
        body: 'Files were loaded or forgotten in another tab or window. Reload this page to use the same data.',
        actions: '<button type="button" class="btn btn-secondary btn-small" data-action="reload-page">Reload this page</button>' }));
    }
    const html = parts.join('');
    if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; }
    host.hidden = !html;
  }

  // ------------------------------------------------------------------ derived context
  function derive() {
    const ds = app.dataset, st = app.state;
    // What-if switches only change the Spending view, where their banner and switches are shown;
    // every other view (and the review queues) uses the real, decided data.
    const txns = E.ledger.applyEdits(ds, st.ledgerEdits);
    const wi = st.ui.whatIf || {};
    const txnsWhatIf = (wi.excludePendingReimbursements || wi.excludeBusinessCandidates) ? E.ledger.applyEdits(ds, st.ledgerEdits, { whatIf: wi }) : null;
    // Undecided duplicate candidates carry a flag so every list can show "Possible duplicate"
    // and link to the duplicates queue (the import never removes them by itself).
    try {
      const dupIds = new Set(E.review.duplicateCandidates(txns, st.ledgerEdits).flatMap(d => d.ids));
      for (const list of [txns, txnsWhatIf]) {
        if (!list) continue;
        for (const t of list) if (dupIds.has(t.id) && !(t.flags || []).includes('duplicate_candidate')) t.flags = [...(t.flags || []), 'duplicate_candidate'];
      }
    } catch (err) { console.error(err); }
    const months = E.ledger.months(ds);
    const coverageMap = E.ledger.coverageMap(ds);
    const latestComplete = E.ledger.latestCompleteMonth(ds);
    app.derived = { txns, txnsWhatIf, months, coverageMap, latestComplete, memo: new Map() };
  }

  function todayMonth() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function makeContext(route) {
    const d = app.derived, st = app.state;
    const people = Object.fromEntries((st.plan.people || []).map(p => [p.id, p.name]));
    const memo = (key, fn) => {
      if (!d.memo.has(key)) d.memo.set(key, fn());
      return d.memo.get(key);
    };
    const lastDataMonth = d.months.length ? d.months[d.months.length - 1] : null;
    const forecastStart = lastDataMonth ? E.months.add(lastDataMonth, 1) : todayMonth();
    const ctx = {
      E, UI, app, route,
      build: app.build, profile: app.profile, dataset: app.dataset, state: st,
      txns: route.view === 'spending' && d.txnsWhatIf ? d.txnsWhatIf : d.txns,
      realTxns: d.txns,
      months: d.months, coverageMap: d.coverageMap, latestComplete: d.latestComplete,
      scope: st.ui.scope,
      people,
      person: id => people[id] || (id === 'joint' ? 'Joint' : id === 'unknown' ? 'Not confirmed' : id || ''),
      href: UI.router.href,
      forecastStart,
      memo,
      /** Plan summary for the current (or given) scope. */
      plan: (opts = {}) => memo('plan:' + JSON.stringify(opts), () => {
        const timing = opts.timing || st.plan.settings.incomeTiming;
        // The plan describes a reference month (the first forecast month): incomes and bills that
        // have ended or not started are left out, and actual paydays are counted for that month.
        const month = opts.month || forecastStart;
        return E.plan.monthly(st.plan, { scope: opts.scope || st.ui.scope, timing, month });
      }),
      /** Projection for a scenario id over the given horizon. */
      project: (scenarioId, opts = {}) => memo('proj:' + scenarioId + JSON.stringify(opts), () => {
        const scenario = st.scenarios.find(s => s.id === scenarioId) || st.scenarios[0];
        return E.forecast.project(st.plan, scenario, { startMonth: opts.startMonth || forecastStart, months: opts.months || 24, scope: opts.scope || st.ui.scope });
      }),
      attention: () => memo('attention', () => (E.attention ? E.attention.list({ dataset: app.dataset, txns: d.txns, state: st, ctx }) : [])),
      reviewQueues: () => memo('queues', () => E.review.queues(app.dataset, d.txns, st.ledgerEdits)),
    };
    return ctx;
  }

  // ------------------------------------------------------------------ rendering
  let lastView = null;
  let keepFocusOnNextRender = false;
  const DATE_INPUTS = 'input[type="month"][data-bind], input[type="date"][data-bind]';
  const NON_TYPING_KEYS = ['Tab', 'Shift', 'Escape', 'Enter', 'Control', 'Alt', 'Meta'];
  let pendingFocusId = null;
  let renderSeq = 0;

  function render({ focusHeading = false, fromHash = false } = {}) {
    const route = UI.router.current();
    const view = views[route.view] || views.overview;
    const ctx = makeContext(route);
    const container = $('#view');

    // Preserve focus, caret and open disclosures across re-renders.
    const active = document.activeElement;
    const activeId = active && active.id && container.contains(active) ? active.id : null;
    const caret = activeId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const openDetails = new Set($$('details[id]', container).filter(d => d.open).map(d => d.id));
    const closedDetails = new Set($$('details[id]', container).filter(d => !d.open).map(d => d.id));

    let html;
    try {
      html = view.render(ctx);
    } catch (err) {
      console.error(err);
      html = UI.c.pageHeader({ title: 'Something went wrong' }) + UI.c.notice({ tone: 'bad', title: 'This view could not be displayed.', body: esc(err.message) + '<br>Your saved data is unchanged. Try another view, or reset this view from Data &amp; privacy.' });
    }
    container.innerHTML = html;

    for (const d of $$('details[id]', container)) {
      if (openDetails.has(d.id)) d.open = true;
      else if (closedDetails.has(d.id)) d.open = false;
    }
    // Navigation state
    for (const a of $$('[data-nav]')) {
      if (a.dataset.nav === route.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    document.title = (view.title || 'Budget') + ' · ' + (app.state.plan.people?.length ? householdName() : 'Household budget');
    updateChrome(ctx);

    // Move focus to the new heading when the view changes (not on first load, so the skip link
    // stays the first Tab stop).
    const viewChanged = lastView !== null && lastView !== route.view;
    lastView = route.view;
    const keep = fromHash && keepFocusOnNextRender;
    if ((focusHeading || viewChanged) && !keep) {
      const h = $('#page-title', container);
      root.scrollTo(0, 0);
      if (h) h.focus({ preventScroll: true });
    } else if (activeId) {
      const el = document.getElementById(activeId);
      if (el) {
        el.focus({ preventScroll: true });
        if (caret && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(caret[0], caret[1]); } catch { /* not a text input */ } }
      }
    }
    if (pendingFocusId) {
      const target = document.getElementById(pendingFocusId) || $('#page-title', container);
      if (target) target.focus({ preventScroll: false });
      pendingFocusId = null;
    }
    // Views run after the generic focus restore, so they can deliberately move focus.
    if (view.afterRender) {
      try { view.afterRender(container, ctx); } catch (err) { console.error(err); }
    }
    if (fromHash) keepFocusOnNextRender = false;
    renderSeq += 1;
    document.documentElement.dataset.renderSeq = String(renderSeq); // lets tests wait for a real render
    if (app.state.ui.lastRoute !== location.hash && location.hash.startsWith('#/') && location.hash.length <= E.state.LIMITS.route) {
      // Remembered under its own key: rewriting the whole budget on every page change would make
      // each open tab write over the others. The next real save carries it in the budget too.
      app.state = { ...app.state, ui: { ...app.state.ui, lastRoute: location.hash } };
      try { if (app.storage) app.storage.setItem(lastRouteKey(), location.hash); } catch { /* not essential */ }
    }
  }

  function scheduleRender(opts) {
    clearTimeout(app.renderTimer);
    // setTimeout (not a microtask) so a Tab keypress finishes moving focus before we re-render.
    app.renderTimer = setTimeout(() => render(opts), 0);
  }

  function householdName() {
    return app.profile?.household?.name || (app.state.plan.people || []).map(p => p.name).join(' & ') || 'Household budget';
  }

  function updateChrome(ctx) {
    $('#householdName').textContent = householdName();
    const badge = app.dataset.isSynthetic ? 'Sample data — fictional household'
      : app.dataset.transactions.length ? (app.dataSource === 'browser' ? 'Private data loaded in this browser' : 'Private build — keep on your devices')
        : app.build.profilePrivate ? 'Household profile built in — keep this file on your devices' : 'No transactions loaded yet';
    $('#dataBadge').textContent = badge;
    const months = ctx.months;
    $('#footerData').textContent = months.length
      ? `Data: ${fmt.month(months[0])} – ${fmt.month(months[months.length - 1])} · ${ctx.dataset.accounts.length} accounts · ${ctx.dataset.transactions.length.toLocaleString('en-US')} records`
      : 'No transaction data loaded';
    $('#navNote').textContent = app.storageOk ? 'Changes save in this browser only. Use Data & privacy to share them.' : 'Browser storage is unavailable: export a workbook to keep changes.';
    let count = 0;
    try {
      const c = ctx.reviewQueues().counts || {};
      // Items that need a household decision; paired transfers and yearly bills are not counted.
      count = (c.uncertain || 0) + (c.duplicates || 0) + (c.transfers || 0) + (c.reimbursements || 0) + (c.business || 0) + (c.spikes || 0);
    } catch { count = 0; }
    const rc = $('#reviewCount');
    rc.hidden = !count;
    rc.textContent = count > 99 ? '99+' : String(count);
    rc.setAttribute('aria-label', count + ' items to review');
    updateUndoButton();
    updateAlerts();
  }

  function updateUndoButton() {
    const btn = $('#undoBtn');
    if (!btn) return;
    const label = app.undoLabels[app.undoLabels.length - 1];
    btn.hidden = !app.undoStack.length;
    const what = label ? label.split(/(?<=\.)\s/)[0] : 'the last change';
    btn.setAttribute('aria-label', 'Undo: ' + what);
    btn.title = 'Undo: ' + what + ' (Ctrl+Z)';
  }

  /** The toast wording when nothing could be stored: a change message must never claim it was saved. */
  function unsavedMessage(message) {
    return message.replace(/\bsaved\b/g, 'changed on this page only') + ' Not saved in this browser: see the warning at the top of the page.';
  }

  // ------------------------------------------------------------------ store
  /**
   * Apply a pure state transformation. fn(state) must return a new state (use E.state helpers).
   * Throws ValidationError back to the caller so forms can show the message.
   */
  function update(fn, { message, undoable = true, rerender = true, rederive } = {}) {
    const prev = app.state;
    const next = fn(prev);
    if (!next || next === prev) return false;
    next.meta = { ...next.meta, updatedAt: new Date().toISOString() };
    const active = document.activeElement;
    if (undoable) pushUndo(prev, message, active);
    app.state = next;
    if (rederive !== false && (prev.ledgerEdits !== next.ledgerEdits || prev.ui.whatIf !== next.ui.whatIf || rederive)) derive();
    else app.derived.memo = new Map();
    let res = save({ onConflict: 'return' });
    let note = '';
    if (res.conflict) {
      // Another tab saved since this tab last read the budget. Make this change to that newer
      // budget instead of writing this tab's older copy over it.
      const theirs = storedState();
      let rebased = null;
      try { rebased = fn(theirs); } catch { rebased = null; }
      clearUndo();
      if (!rebased || rebased === theirs) {
        app.state = theirs;
        app.savedText = readSaved();
        derive();
        scheduleRender();
        toast(OTHER_TAB + (rebased === theirs ? ' It already includes this change.' : ' Your last change could not be applied to it: make it again if you still want it.'));
        updateUndoButton();
        return true;
      }
      rebased.meta = { ...rebased.meta, updatedAt: new Date().toISOString() };
      if (undoable) pushUndo(theirs, message, active);
      app.state = rebased;
      derive();
      res = save({ force: true });
      note = 'This budget was also changed in another tab or window; your change was made to that newer version. ';
    }
    if (rerender) scheduleRender();
    if (message || note) toast(note + (message ? (res.ok ? message : unsavedMessage(message)) : ''), { undo: undoable });
    updateUndoButton();
    return true;
  }

  function pushUndo(prev, message, active) {
    app.undoStack.push(prev);
    app.undoFocus.push(active && active.id ? active.id : null);
    app.undoLabels.push(message || '');
    if (app.undoStack.length > 30) { app.undoStack.shift(); app.undoFocus.shift(); app.undoLabels.shift(); }
  }

  function undo() {
    const prev = app.undoStack.pop();
    const focusId = app.undoFocus.pop();
    app.undoLabels.pop();
    if (!prev) return;
    app.state = prev;
    derive();
    const res = save({ conflictMessage: OTHER_TAB + ' Nothing was undone.' });
    if (res.conflict) return;
    // The Undo button used may disappear, so return focus to where the change was made.
    pendingFocusId = focusId || 'page-title';
    scheduleRender();
    toast(res.ok ? 'Change undone.' : unsavedMessage('Change undone.'));
    updateUndoButton();
  }

  function replaceState(newState, message) {
    let prev = app.state;
    app.state = newState;
    derive();
    // Reset and import replace the whole budget on purpose, so a newer save from another tab is
    // replaced too; Undo then brings back that newer version, not this tab's older copy.
    let res = save({ onConflict: 'return' });
    if (res.conflict) { prev = storedState(); clearUndo(); res = save({ force: true }); }
    pushUndo(prev, message, null);
    scheduleRender({ focusHeading: true });
    if (message) toast(res.ok ? message : unsavedMessage(message), { undo: true });
    updateUndoButton();
  }

  // ------------------------------------------------------------------ feedback
  function toastEl() {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast'; el.className = 'toast'; el.hidden = true;
      el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    return el;
  }
  /** The toast lives in <body>, or in the open dialog while one is open (the modal's top layer would hide it otherwise). */
  function parkToast() {
    const el = document.getElementById('toast');
    if (el && el.parentNode !== document.body) document.body.appendChild(el);
  }

  function toast(message, { undo: canUndo = false, timeout = 6000 } = {}) {
    const el = toastEl();
    const dlg = $('#dialog');
    const host = dlg && dlg.open ? dlg : document.body;
    if (el.parentNode !== host) host.appendChild(el);
    el.innerHTML = `<span>${esc(message)}</span>${canUndo ? '<button type="button" data-action="undo">Undo</button>' : ''}`;
    el.hidden = false;
    toast.timeout = timeout;
    armToastTimer();
  }
  function armToastTimer() {
    clearTimeout(toast.timer);
    toast.timer = setTimeout(hideToast, toast.timeout || 6000);
  }
  function hideToast() {
    const el = document.getElementById('toast');
    if (!el) return;
    // Never disappear while someone is pointing at it or has moved focus into it.
    if (el.matches(':hover') || el.contains(document.activeElement)) { armToastTimer(); return; }
    el.hidden = true;
  }

  /** Modal confirmation. Resolves true/false. */
  function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    const dlg = $('#dialog');
    parkToast(); // replacing the dialog's content must not delete the toast
    dlg.innerHTML = `<form method="dialog" class="dialog-inner"><h2 id="dialogTitle">${esc(title)}</h2><div>${body}</div><div class="dialog-actions"><button class="btn btn-secondary" value="cancel">${esc(cancelLabel)}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok">${esc(confirmLabel)}</button></div></form>`;
    return new Promise(resolve => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
  }

  // ------------------------------------------------------------------ forms
  function parseBound(el) {
    const type = el.dataset.type || 'text';
    const raw = el.type === 'checkbox' ? el.checked : el.value;
    switch (type) {
      case 'money': return E.money.inputToCents(raw, { allowNegative: el.dataset.allowNegative === '1' });
      case 'int': {
        if (String(raw).trim() === '') return null;
        const n = Number(raw);
        if (!Number.isInteger(n)) throw new E.ValidationError('Enter a whole number.');
        return n;
      }
      case 'number': {
        if (String(raw).trim() === '') return null;
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new E.ValidationError('Enter a number.');
        return n;
      }
      case 'month':
        if (!raw) return null;
        if (!E.months.isMonth(raw)) throw new E.ValidationError('Choose a month (YYYY-MM).');
        if (!plausibleYear(raw)) throw new E.ValidationError('Check the year: ' + raw.slice(0, 4) + ' does not look right.');
        return raw;
      case 'date':
        if (!raw) return null;
        if (!E.dates.isDate(raw)) throw new E.ValidationError('Choose a date.');
        if (!plausibleYear(raw)) throw new E.ValidationError('Check the year: ' + raw.slice(0, 4) + ' does not look right.');
        return raw;
      case 'bool': return !!raw;
      case 'select': return raw === '__null__' ? null : raw;
      default: return String(raw).trim();
    }
  }

  function plausibleYear(value) {
    const y = Number(String(value).slice(0, 4));
    return y >= 1990 && y <= 2200;
  }

  function setFieldError(el, message) {
    const err = document.getElementById(el.id + '-error');
    if (message) {
      el.setAttribute('aria-invalid', 'true');
      if (err) { err.textContent = message; err.hidden = false; }
    } else {
      el.removeAttribute('aria-invalid');
      if (err) { err.textContent = ''; err.hidden = true; }
    }
  }

  function commitBinding(el) {
    let value;
    try {
      value = parseBound(el);
      const path = el.dataset.bind;
      const current = E.state.getPath(app.state, path);
      if (JSON.stringify(current) === JSON.stringify(value)) { setFieldError(el, null); return; }
      update(st => E.state.setPath(st, path, value), { message: el.dataset.message || 'Change saved.' });
      setFieldError(el, null);
    } catch (err) {
      if (err && err.name === 'ValidationError') setFieldError(el, err.message);
      else { console.error(err); setFieldError(el, 'This value could not be saved.'); }
    }
  }

  // ------------------------------------------------------------------ events
  function findAction(name) {
    const route = UI.router.current();
    const view = views[route.view];
    return (view && view.actions && view.actions[name]) || (UI.sharedActions && UI.sharedActions[name]) || globalActions[name] || null;
  }

  async function runAction(el, ev) {
    const name = el.dataset.action;
    const fn = findAction(name);
    if (!fn) { console.warn('No handler for action', name); return; }
    try {
      await fn(makeContext(UI.router.current()), el, ev);
    } catch (err) {
      if (err && err.name === 'ValidationError') toast(err.message);
      else { console.error(err); toast('That did not work: ' + (err.message || err)); }
    }
  }

  const globalActions = {
    undo: () => undo(),
    'reload-page': () => root.location.reload(),
    'set-scope': (ctx, el) => update(st => E.state.setPath(st, 'ui.scope', el.dataset.value || el.value), { undoable: false }),
    navigate: (ctx, el) => navigate(el.dataset.view, JSON.parse(el.dataset.params || '{}'), { keepFocus: el.dataset.keepFocus === '1' }),
    'dismiss-notice': (ctx, el) => update(st => ({ ...st, ui: { ...st.ui, dismissed: { ...st.ui.dismissed, [el.dataset.notice]: true } } }), { undoable: false }),
  };

  function navigate(view, params = {}, { replace = false, keepFocus = false } = {}) {
    if (UI.router.href(view, params) === location.hash) {
      // Same URL: no hashchange will fire, so re-render directly and leave no stale flag behind.
      scheduleRender({ focusHeading: !keepFocus });
      return;
    }
    keepFocusOnNextRender = keepFocus;
    UI.router.go(view, params, { replace });
  }

  function installEvents() {
    document.addEventListener('click', ev => {
      // In-page anchors (the skip link) must not touch the hash, which holds the route.
      const skip = ev.target.closest('a[href="#main"]');
      if (skip) {
        ev.preventDefault();
        const main = document.getElementById('main');
        main.focus();
        main.scrollIntoView({ block: 'start' });
        return;
      }
      // Re-selecting the current destination returns to the top of that view (no hashchange fires).
      const nav = ev.target.closest('a[href^="#/"]');
      if (nav && !ev.defaultPrevented && !nav.dataset.action && nav.getAttribute('href') === location.hash) {
        ev.preventDefault();
        render({ focusHeading: true });
        return;
      }
      const el = ev.target.closest('[data-action]');
      // Inputs/selects act on change; forms act only on submit (never on clicks inside them).
      if (!el || ['INPUT', 'SELECT', 'TEXTAREA', 'FORM'].includes(el.tagName)) return;
      if (el.tagName === 'A') ev.preventDefault();
      runAction(el, ev);
    });
    document.addEventListener('change', ev => {
      const el = ev.target;
      if (el.matches('[data-bind]')) {
        // Chrome fires change for every typed part of a month/date ("0002-05" while typing 2028).
        // Typed values wait for Enter or leaving the field; a value picked from the calendar
        // (no keystrokes) applies at once.
        // A view may dispatch its own (untrusted) change once typing is finished: that one applies.
        if (el.matches(DATE_INPUTS) && el.dataset.typed && ev.isTrusted) return;
        delete el.dataset.typed;
        commitBinding(el);
      }
      else if (el.matches('input[data-action], select[data-action]')) runAction(el, ev);
    });
    document.addEventListener('input', ev => {
      const el = ev.target;
      if (el.matches('[data-bind]') && el.getAttribute('aria-invalid') === 'true') {
        try { parseBound(el); setFieldError(el, null); } catch { /* keep showing the error until valid */ }
      }
    });
    document.addEventListener('keydown', ev => {
      // Ctrl+Z / Cmd+Z undoes the last change, except in text fields, where the browser's own text undo applies.
      const tg = ev.target;
      const textField = tg.closest && (tg.closest('textarea, select, [contenteditable]') || (tg.matches('input') && !/^(radio|checkbox|button|submit|reset|range|color|file)$/.test(tg.type)));
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && (ev.key === 'z' || ev.key === 'Z')
        && !textField && !($('#dialog') || {}).open && app.undoStack.length) {
        ev.preventDefault();
        undo();
        return;
      }
      if (ev.target.matches && ev.target.matches(DATE_INPUTS) && !NON_TYPING_KEYS.includes(ev.key)) ev.target.dataset.typed = '1';
      if (ev.key === 'Enter' && ev.target.matches('input[data-bind]')) {
        ev.preventDefault();
        delete ev.target.dataset.typed;
        commitBinding(ev.target);
      }
      if (ev.target.matches('svg[data-chart="line"]')) chartKey(ev);
    });
    document.addEventListener('focusout', ev => {
      const el = ev.target;
      if (el.matches && el.matches(DATE_INPUTS) && el.dataset.typed) {
        delete el.dataset.typed;
        commitBinding(el);
      }
    });
    document.addEventListener('submit', ev => {
      const form = ev.target;
      if (form.dataset.action) { ev.preventDefault(); runAction(form, ev); }
    });
    // Another tab saved this budget: show that version instead of later writing over it.
    root.addEventListener('storage', ev => {
      if (!app.storage || ev.storageArea !== app.storage) return;
      if (ev.key === savedKey()) {
        if (ev.newValue !== null && ev.newValue !== app.savedText) adoptStored();
      } else if (ev.key === LOADED_DATASET_KEY || ev.key === LOADED_PROFILE_KEY || ev.key === null) {
        app.otherTabFiles = true;
        updateAlerts();
      } else if (ev.key === unreadableKey()) updateAlerts();
    });
    const dlg = $('#dialog');
    if (dlg) dlg.addEventListener('close', parkToast);
    root.addEventListener('hashchange', () => {
      if (location.hash && !location.hash.startsWith('#/')) return; // not a route
      render({ focusHeading: !keepFocusOnNextRender, fromHash: true });
    });
    installTooltips();
    // No re-render on resize: it would discard half-typed form input (e.g. when a phone rotates).
    // Charts pick their phone or desktop drawing size on the next normal render.
  }

  // ------------------------------------------------------------------ chart tooltips
  function showTooltip(title, rows, x, y) {
    const tip = $('#tooltip');
    tip.replaceChildren();
    const t = document.createElement('div');
    t.className = 'tooltip-title';
    t.textContent = title;
    tip.appendChild(t);
    for (const [label, value, series] of rows) {
      const row = document.createElement('div');
      row.className = 'tooltip-row';
      const name = document.createElement('span');
      if (series) {
        const key = document.createElement('span');
        key.className = 'key key-line series-' + series;
        name.appendChild(key);
      }
      name.appendChild(document.createTextNode(label));
      const v = document.createElement('strong');
      v.textContent = value;
      row.append(name, v);
      tip.appendChild(row);
    }
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.min(Math.max(8, x + 14), root.innerWidth - w - 8);
    const top = y - h - 12 < 8 ? y + 16 : y - h - 12;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hideTooltip() { $('#tooltip').hidden = true; }

  function linePoint(svg, index) {
    const points = JSON.parse(svg.dataset.points);
    const i = Math.max(0, Math.min(points.length - 1, index));
    const p = points[i];
    const cross = svg.querySelector('.crosshair');
    cross.setAttribute('x1', p.x); cross.setAttribute('x2', p.x); cross.setAttribute('visibility', 'visible');
    svg.dataset.index = String(i);
    return p;
  }

  function installTooltips() {
    document.addEventListener('pointermove', ev => {
      const svg = ev.target.closest && ev.target.closest('svg[data-chart="line"]');
      if (svg) {
        const pt = svg.createSVGPoint();
        pt.x = ev.clientX; pt.y = ev.clientY;
        const local = pt.matrixTransform(svg.getScreenCTM().inverse());
        const points = JSON.parse(svg.dataset.points);
        let best = 0;
        points.forEach((p, i) => { if (Math.abs(p.x - local.x) < Math.abs(points[best].x - local.x)) best = i; });
        const p = linePoint(svg, best);
        showTooltip(p.title, p.rows, ev.clientX, ev.clientY);
        return;
      }
      const mark = ev.target.closest && ev.target.closest('[data-tip-title]');
      if (mark) {
        let rows = [];
        try { rows = JSON.parse(mark.dataset.tipRows || '[]'); } catch { rows = []; }
        showTooltip(mark.dataset.tipTitle, rows, ev.clientX, ev.clientY);
        return;
      }
      hideTooltip();
    });
    document.addEventListener('pointerleave', hideTooltip);
    document.addEventListener('scroll', hideTooltip, { passive: true });
    document.addEventListener('focusout', ev => {
      if (ev.target.matches && ev.target.matches('svg[data-chart]')) {
        hideTooltip();
        const c = ev.target.querySelector('.crosshair');
        if (c) c.setAttribute('visibility', 'hidden');
      }
    });
  }

  function chartKey(ev) {
    const svg = ev.target;
    const points = JSON.parse(svg.dataset.points);
    let i = svg.dataset.index === undefined ? -1 : Number(svg.dataset.index);
    if (ev.key === 'ArrowRight') i = Math.min(points.length - 1, i + 1);
    else if (ev.key === 'ArrowLeft') i = Math.max(0, i < 0 ? 0 : i - 1);
    else if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = points.length - 1;
    else return;
    ev.preventDefault();
    const p = linePoint(svg, i);
    const box = svg.getBoundingClientRect();
    const ctm = svg.getScreenCTM();
    showTooltip(p.title, p.rows, ctm ? ctm.a * p.x + ctm.e : box.left, box.top + 20);
    $('#chartLive').textContent = p.title + ': ' + p.rows.map(r => r[0] + ' ' + r[1]).join(', ');
  }

  // ------------------------------------------------------------------ files (used by the Data view)
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error || new Error('Could not read ' + file.name));
      r.readAsText(file);
    });
  }

  function download(filename, text, type = 'application/json') {
    const blob = new Blob([text], { type: type + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /** Persist a dataset loaded in the browser and reload the app around it. */
  function useLoadedDataset(dataset, meta = {}) {
    const normalized = E.ledger.normalizeDataset(dataset);
    if (!app.storage) throw new E.ValidationError('This browser is not letting the page store data (private window or storage turned off), so loaded files would be lost on reload. Use the command-line import and a private build instead.');
    {
      try {
        app.storage.setItem(LOADED_DATASET_KEY, JSON.stringify({ dataset: normalized, loadedAt: new Date().toISOString(), ...meta }));
      } catch (err) {
        throw new E.ValidationError('This browser could not store the data (' + err.message + '). It is too large for local storage; use the command-line import and a private build instead.');
      }
    }
    root.location.reload();
  }

  function useLoadedProfile(profile, meta = {}) {
    if (!app.storage) throw new E.ValidationError('This browser is not letting the page store data (private window or storage turned off), so the profile would be lost on reload. Put it in private/household-profile.json and rebuild instead.');
    try {
      app.storage.setItem(LOADED_PROFILE_KEY, JSON.stringify({ profile, loadedAt: new Date().toISOString(), ...meta }));
    } catch (err) {
      throw new E.ValidationError('This browser could not store the profile (' + err.message + ').');
    }
    root.location.reload();
  }

  function forgetLoadedFiles() {
    if (app.storage) { app.storage.removeItem(LOADED_DATASET_KEY); app.storage.removeItem(LOADED_PROFILE_KEY); }
    root.location.reload();
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    app.storage = safeStorage();
    app.storageOk = !!app.storage;
    loadData();
    loadState();
    derive();
    installEvents();
    if (!location.hash) {
      let last = app.state.ui.lastRoute;
      try { last = (app.storage && app.storage.getItem(lastRouteKey())) || last; } catch { /* use the saved budget's */ }
      history.replaceState(null, '', last && last.startsWith('#/') && last.length <= E.state.LIMITS.route ? last : '#/overview');
    }
    save();
    render({ focusHeading: false });
    if (app.loadNotes.length && app.stateSource === 'legacy') {
      toast('Your earlier saved budget was upgraded. Details are in Data & privacy.', { timeout: 9000 });
    } else if (readUnreadableCopy() !== null && app.loadNotes.some(n => /damaged/.test(n))) {
      toast('The budget saved in this browser could not be read. See the warning at the top of the page.', { timeout: 9000 });
    }
  }

  Object.assign(app, { update, undo, replaceState, readUnreadableCopy, forgetUnreadableCopy, unreadableKey, render: scheduleRender, renderNow: render, navigate, toast, confirm: confirmDialog, readFile, download, useLoadedDataset, useLoadedProfile, forgetLoadedFiles, derive, save, keys: { LOADED_DATASET_KEY, LOADED_PROFILE_KEY } });
  UI.app = app;

  // Test and debugging handle. Read-only snapshots; changes go through the UI or setState.
  root.HouseholdBudget = {
    engine: E,
    getState: () => E.util.clone(app.state),
    getDataset: () => app.dataset,
    context: () => makeContext(UI.router.current()),
    setState: next => replaceState(next),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
