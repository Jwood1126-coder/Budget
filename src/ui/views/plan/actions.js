'use strict';
/*
 * Plan (#/overview): the plan:* actions. Text boxes and sliders commit on change through
 * app.update (undoable); view choices (mode, Past, Ahead, Trends) are saved without undo; Compare
 * is the route's ?compare= (replaced in place, never saved). An action can ask the next render to
 * focus a control and to announce the new headline (takeNext).
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const fmt = UI.fmt;
  const P = UI._plan;
  const { isCents, exact, amt, plural, inputText, todayIso, model, showError, PACKS, groupIdOf } = P;
  const { pickedOf, shownTimeline, dataAnchorsOf, GROUP_NAME, dialLabel, signedDial, dialResetTo, rowResetTo, setupDials, depositsOf, KIND_LABEL, CHANGE_GROUP_LABEL } = P;
  const { txnMap, placeTxns, placeOf, fillTxns, TXN_REASON } = P;

  /** Set by a change made on this page: the next render announces the new headline. */
  let announceNext = false;
  /** An element to focus after the next render (a control that moved or disappeared). */
  let focusNext = null;

  /**
   * Focus after a change that may move the control it came from (a transaction that changes
   * category leaves its row's list): the first of these elements still on the page, else the
   * summary of the innermost list around it still there.
   */
  function focusAfterMove(el, ids) {
    const lists = [];
    for (let d = el.closest('details'); d; d = d.parentElement ? d.parentElement.closest('details') : null) if (d.id) lists.push(d.id);
    return () => {
      for (const id of ids) { const x = id && document.getElementById(id); if (x) return x; }
      for (const id of lists) { const d = document.getElementById(id); if (d) return d.querySelector(':scope > summary'); }
      return null;
    };
  }

  /**
   * The category selects (.plan-txcat): a change made with the keys of a closed list (an arrow, a
   * letter: the browser changes the value at once) waits for Enter or for leaving the list, and
   * Escape takes it back. Each change is a correction, and its line may move away, so the next key
   * would otherwise change the next transaction. A choice made in the opened list applies at once.
   * A browser fires that change inside the keydown, so `keying` (cleared once the keydown is over)
   * tells the two apart.
   */
  function keyedCategory(rootEl) {
    const commit = (el, goingTo) => {
      delete el.dataset.pending;
      el.goingTo = goingTo; // left for this control (undefined on Enter): see leftFor
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    rootEl.addEventListener('keydown', ev => {
      const el = ev.target;
      if (!el.matches || !el.matches('select.plan-txcat')) return;
      if (el.dataset.pending && (ev.key === 'Enter' || ev.key === 'Escape')) {
        ev.preventDefault();
        if (ev.key === 'Enter') { commit(el, undefined); return; }
        const was = Array.from(el.options).find(o => o.defaultSelected);
        el.value = was ? was.value : '';
        delete el.dataset.pending;
        return;
      }
      el.dataset.keying = '1';
      setTimeout(() => { delete el.dataset.keying; }, 0);
    });
    rootEl.addEventListener('focusout', ev => {
      const el = ev.target;
      if (el.matches && el.matches('select.plan-txcat') && el.dataset.pending) commit(el, ev.relatedTarget || null);
    });
  }
  /**
   * A change applied on leaving its list for another control outside `scope` (the line or row that
   * may move): focus stays there (the render finds it again by its id). Read once.
   */
  function leftFor(el, scope) {
    const to = el.goingTo;
    delete el.goingTo;
    return !!(to && to.id && !(scope && scope.contains(to)));
  }
  /** True when this category change waits for Enter or leaving the list (see keyedCategory). */
  function waitsForKeys(el, ev) {
    if (!ev || !ev.isTrusted || !el.dataset.keying) return false;
    el.dataset.pending = '1';
    return true;
  }

  /** Typed amounts: commas and a typographic minus or dash are fine. */
  const typed = value => String(value || '').trim().replace(/[−–—]/g, '-');
  const choice = v => (v === 'all' ? 'all' : Number(v));

  /** What the next render does after a change made here, read once: { focus, announce }. */
  function takeNext() {
    const next = { focus: focusNext, announce: announceNext };
    focusNext = null;
    announceNext = false;
    return next;
  }

  /** A plan change: undoable, with a message, and the new headline announced after the render. */
  function change(ctx, fn, message) {
    announceNext = true;
    const done = ctx.app.update(fn, { message });
    if (!done) announceNext = false;
    return done;
  }
  const setView = (ctx, key, value) => {
    const cur = ctx.state.ui.plan ? ctx.state.ui.plan[key] : undefined;
    if (cur === value) return;
    ctx.app.update(st => E.state.setPath(st, 'ui.plan.' + key, value), { undoable: false });
  };
  /** Trends settings: a view choice (not undoable, no message). */
  const setTrends = (ctx, patch) => {
    const cur = model(ctx).settings.trends;
    const next = Object.assign({ series: cur.series.slice(), ma: cur.ma, trend: cur.trend }, patch);
    ctx.app.update(st => E.state.setPath(st, 'ui.plan.trends', next), { undoable: false });
  };

  function dialCommit(ctx, key, cents) {
    const d = model(ctx).dialsByKey[key];
    if (!d || cents === d.planCents) return;
    change(ctx, st => E.timeline.setDial(st, key, cents), `${dialLabel(d)} set to ${amt(cents)}.`);
  }

  /** A planned change by id (from the current model). */
  const changeOf = (ctx, id) => model(ctx).changes.list.find(ch => ch.id === id && !ch.readOnly) || null;

  /** Amount typed in a box: cents, null for blank, or undefined after showing what is wrong. */
  function centsFrom(el, field) {
    const raw = typed(el.value);
    if (raw === '') { showError(el, null); return null; }
    try {
      const cents = E.money.inputToCents(raw, { allowNegative: true, field });
      showError(el, null);
      return cents;
    } catch (err) {
      showError(el, err.message || 'Enter an amount in dollars, such as 125 or -125.50.');
      return undefined;
    }
  }

  const actions = {
    'plan:mode': (ctx, el) => setView(ctx, 'mode', ['flows', 'trends'].includes(el.dataset.value) ? el.dataset.value : 'balance'),
    'plan:past': (ctx, el) => setView(ctx, 'past', choice(el.dataset.value)),
    'plan:horizon': (ctx, el) => setView(ctx, 'horizon', choice(el.dataset.value)),
    /** Compare: a what-if drawn beside the plan. A view choice kept in the address, not saved. */
    'plan:compare': (ctx, el) => {
      const params = Object.assign({}, ctx.route.params, { compare: el.value || undefined });
      ctx.app.navigate('overview', params, { replace: true, keepFocus: true });
    },
    'plan:trend-series': (ctx, el) => {
      const tl = model(ctx);
      const picked = pickedOf(tl);
      if (el.tagName === 'SELECT') {
        const key = el.value;
        if (!key || picked.includes(key)) return;
        focusNext = '#plan-trend-add';
        setTrends(ctx, { series: picked.concat([key]).slice(0, E.state.LIMITS.planTrendSeries || 16) });
        return;
      }
      const key = el.dataset.series;
      if (!picked.includes(key) || picked.length < 2) return;
      focusNext = '#plan-trend-add';
      setTrends(ctx, { series: picked.filter(k => k !== key) });
    },
    'plan:trend-ma': (ctx, el) => setTrends(ctx, { ma: Number(el.dataset.value) || 0 }),
    'plan:trend-line': (ctx, el) => setTrends(ctx, { trend: !!el.checked }),
    'plan:export-csv': ctx => {
      const tl = model(ctx);
      const name = 'plan-' + todayIso() + '.csv';
      ctx.app.download(name, E.timeline.toCSV(shownTimeline(tl), { people: tl.people }), 'text/csv');
      ctx.app.toast(`Plan exported as ${name}: its settings, then one row per month shown.`);
    },
    'plan:baseline': (ctx, el) => {
      const v = choice(el.dataset.value);
      if (ctx.state.ui.plan && ctx.state.ui.plan.baselineMonths === v) return;
      change(ctx, st => E.state.setPath(st, 'ui.plan.baselineMonths', v), v === 'all' ? 'Baselines now average every complete month.' : `Baselines now average the last ${v} complete months.`);
    },
    'plan:cover': (ctx, el) => change(ctx, st => E.state.setPath(st, 'ui.plan.coverFromSavings', !!el.checked),
      el.checked ? 'Checking shortfalls in plan months now come from savings.' : 'Checking shortfalls in plan months are no longer moved from savings.'),
    'plan:goto-balances': () => {
      const first = document.querySelector('#plan-balances input[type="text"]');
      const card = document.getElementById('plan-balances');
      if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (first) first.focus({ preventScroll: true });
    },
    'plan:reset': ctx => change(ctx, st => E.timeline.resetPlan(st),
      setupDials(ctx.state) ? 'Every dial is back to your setup file’s values, or to its baseline where it has none.' : 'Every dial is back to its baseline.'),
    'plan:reset-dial': (ctx, el) => {
      const tl = model(ctx);
      const d = tl.dialsByKey[el.dataset.dial];
      if (!d) return;
      focusNext = '#plan-dial-' + d.key;
      change(ctx, st => E.timeline.resetDial(st, d.key, tl), `${dialLabel(d)} is back to ${dialResetTo(ctx.state, d)}.`);
    },
    'plan:keep-carried': (ctx, el) => {
      const d = model(ctx).dialsByKey[el.dataset.dial];
      if (!d || !d.carriedOver) return;
      focusNext = '#plan-dial-' + d.key;
      change(ctx, st => E.timeline.acceptCarriedOver(st, d.key), `${dialLabel(d)} kept at ${amt(d.planCents)}.`);
    },
    'plan:use-average': (ctx, el) => {
      const d = model(ctx).dialsByKey[el.dataset.dial];
      if (!d || !isCents(d.averageCents)) return;
      change(ctx, st => E.timeline.setDial(st, d.key, d.averageCents), `${d.label}: using the average of deposits.`);
    },
    'plan:use-rows': (ctx, el) => {
      const d = model(ctx).dialsByKey[el.dataset.dial];
      if (!d) return;
      focusNext = '#plan-dial-' + d.key;
      change(ctx, st => E.timeline.setDial(st, d.key, null), `${dialLabel(d)} now follows its ${d.key === 'irregular' ? 'list' : 'rows'} (${amt(d.drill ? d.drill.rowsCents : d.baselineCents)}).`);
    },
    'plan:dial': (ctx, el) => {
      const d = model(ctx).dialsByKey[el.dataset.dial];
      if (!d) return;
      const raw = typed(el.value);
      if (raw === '') {
        showError(el, null);
        if (d.source !== 'direct') { el.value = inputText(d.planCents); return; }
        change(ctx, st => E.timeline.setDial(st, d.key, null), `${dialLabel(d)} is back to ${d.drill && d.drill.overridden ? 'its list' : 'its baseline'}.`);
        return;
      }
      let cents;
      try {
        cents = E.money.inputToCents(raw, { allowNegative: signedDial(d), field: d.key });
      } catch (err) {
        showError(el, err.message || 'Enter an amount in dollars, such as 125 or 125.50.');
        return;
      }
      showError(el, null);
      dialCommit(ctx, d.key, cents);
    },
    'plan:dial-range': (ctx, el) => dialCommit(ctx, el.dataset.dial, Math.round(Number(el.value) * 100)),
    'plan:row-include': (ctx, el) => {
      const on = !!el.checked;
      change(ctx, st => E.timeline.setRow(st, el.dataset.row, { included: on }), on ? `${el.dataset.name} counted in the plan again.` : `${el.dataset.name} left out of the plan.`);
    },
    'plan:row-cents': (ctx, el) => {
      const id = el.dataset.row;
      const cur = ((ctx.state.ui.plan || {}).rows || {})[id];
      const tl = model(ctx);
      const dialOf = tl.dialsByKey[id.split('-')[0]];
      const shown = dialOf && dialOf.drill ? dialOf.drill.rows.find(r => r.id === id) : null;
      const raw = typed(el.value);
      if (raw === '') {
        showError(el, null);
        if ((!cur || cur.cents === undefined) && !(shown && shown.source === 'budget')) return;
        change(ctx, st => E.timeline.setRow(st, id, { cents: null }, tl), `${el.dataset.name} is back to its average.`);
        return;
      }
      let cents;
      try {
        cents = E.money.inputToCents(raw, { allowNegative: true, field: 'row' });
      } catch (err) {
        showError(el, err.message || 'Enter an amount in dollars, such as 125 or 125.50.');
        return;
      }
      showError(el, null);
      if (shown && shown.planCents === cents) return;
      change(ctx, st => E.timeline.setRow(st, id, { cents }, tl), `${el.dataset.name} set to ${amt(cents)} a month.`);
    },
    'plan:row-reset': (ctx, el) => {
      const tl = model(ctx);
      const id = el.dataset.row;
      const dialOf = tl.dialsByKey[id.split('-')[0]];
      const shown = dialOf && dialOf.drill ? dialOf.drill.rows.find(r => r.id === id) : null;
      // The row's change only: a category's budget stays (resetRow never touches plan.targets).
      change(ctx, st => E.timeline.resetRow(st, id, tl), `${el.dataset.name} is back to ${shown ? rowResetTo(ctx.state, shown) : 'its average'}.`);
    },
    'plan:move-group': (ctx, el) => {
      const tl = model(ctx);
      const key = el.dataset.key;
      const to = el.dataset.to || null;
      const name = el.dataset.name || key;
      if (!key) return;
      // The button moves with its row: keep focus in the list it came from.
      const drill = el.closest('.plan-drill');
      focusNext = drill && drill.id ? `#${drill.id} > summary` : null;
      change(ctx, st => E.timeline.setGroup(st, key, to, tl),
        to ? `${name} moved to ${GROUP_NAME[to]}.` : `${name} is back in its usual group.`);
    },
    'plan:irregular': (ctx, el) => {
      const on = !!el.checked;
      change(ctx, st => E.timeline.setIrregular(st, el.dataset.txn, on),
        on ? `${el.dataset.name} is back in the irregular allowance.` : `${el.dataset.name} left out of the irregular allowance. It still counts in past months.`);
    },
    'plan:irregular-regular': (ctx, el) => {
      announceNext = true;
      focusNext = '#plan-drill-irregular > summary';
      UI.shared.editLedger(ctx.app, el.dataset.txn, 'planningBaseline', 'include', 'Counted as regular spending on the Plan page',
        { message: `${el.dataset.name} now counts as regular spending in its category, not as a one-time cost.` });
    },
    'plan:irregular-onetime': (ctx, el) => {
      announceNext = true;
      focusNext = '#plan-drill-irregular > summary';
      UI.shared.editLedger(ctx.app, el.dataset.txn, 'planningBaseline', null, 'Counted as one-time again on the Plan page',
        { message: `${el.dataset.name} is a one-time cost again, in the irregular allowance.` });
    },
    // ---- the transactions behind a row, and their categories
    /** “Show all N”: the rest of the list, drawn in place (nothing saved). */
    'plan:txns-all': (ctx, el) => {
      const details = el.closest('details.plan-txns');
      if (!details) return;
      const before = details.querySelectorAll('.plan-tx').length;
      fillTxns(ctx, details, { all: true });
      const next = details.querySelectorAll('.plan-tx')[before];
      const target = next ? next.querySelector('select, a') : details.querySelector(':scope > summary');
      if (target) target.focus();
    },
    /** One transaction's category: a ledger edit (undoable); the plan rows follow it. */
    'plan:txn-category': (ctx, el, ev) => {
      if (waitsForKeys(el, ev)) return;
      const line = el.closest('.plan-tx');
      const stay = leftFor(el, line);
      const t = txnMap(ctx).get(el.dataset.txn);
      const category = el.value;
      if (!t || !category || category === t.category) return;
      const name = el.dataset.name || placeOf(t);
      // When it moves to another row, the next line in this list (or the one before) takes focus.
      const near = x => (x && x.querySelector('select.plan-txcat') ? x.querySelector('select.plan-txcat').id : null);
      if (!stay) focusNext = focusAfterMove(el, [el.id, near(line && line.nextElementSibling), near(line && line.previousElementSibling)]);
      announceNext = true;
      UI.shared.editLedger(ctx.app, t.id, 'category', category, TXN_REASON, { message: `${name}: now ${category}.` });
    },
    /** Every transaction from a place (the whole data set) to one category, in one undoable change. */
    'plan:merchant-category': (ctx, el, ev) => {
      if (waitsForKeys(el, ev)) return;
      const stay = leftFor(el, el.closest('.drill-row'));
      const name = el.dataset.merchant;
      const category = el.value;
      const list = name ? placeTxns(ctx).get(name) || [] : [];
      if (!category || !list.length) return;
      const changes = list.filter(t => !(t.edit && t.edit.category === category)).map(t => ({ txnId: t.id, field: 'category', value: category, reason: TXN_REASON }));
      if (!changes.length) return;
      // The place moves to its new category's row: open the lists around it and focus its control there.
      const back = focusAfterMove(el, []);
      if (!stay) focusNext = rootEl => {
        const moved = Array.from(rootEl.querySelectorAll('select[data-action="plan:merchant-category"]')).find(x => x.dataset.merchant === name);
        if (!moved) return back();
        for (let d = moved.closest('details'); d; d = d.parentElement ? d.parentElement.closest('details') : null) d.open = true;
        moved.scrollIntoView({ block: 'center' });
        return moved;
      };
      announceNext = true;
      UI.shared.editMany(ctx.app, changes, { message: `${name}: ${plural(list.length, 'transaction')} now ${category}.` });
    },
    'plan:person': (ctx, el) => {
      const value = el.value === '' ? null : el.value;
      const tl = model(ctx);
      const x = depositsOf(ctx, tl).find(d => d.id === el.dataset.txn);
      const who = value === null ? 'back to the automatic match' : value === 'none' ? 'neither of you' : ((tl.people.find(p => p.id === value) || {}).name || value) + '’s';
      announceNext = true;
      UI.shared.editLedger(ctx.app, el.dataset.txn, 'person', value, 'Set on the Plan page',
        { message: `Deposit${x ? ' of ' + exact(x.cents) + ' on ' + fmt.date(x.date) : ''}: ${who}. The bank’s description is kept.` });
    },
    'plan:confirm-deposits': ctx => {
      const list = depositsOf(ctx, model(ctx)).filter(x => x.provisional && x.who);
      if (!list.length) return;
      announceNext = true;
      UI.shared.editMany(ctx.app, list.map(x => ({ txnId: x.id, field: 'person', value: x.who, reason: 'Confirmed on the Plan page' })),
        { message: `${plural(list.length, 'deposit')} confirmed as suggested.` });
    },
    'plan:balance': (ctx, el) => {
      const account = el.dataset.account || '';
      const name = el.dataset.name || 'Cash';
      let cents;
      try {
        cents = E.money.inputToCents(typed(el.value), { allowNegative: true, field: 'balance' });
      } catch (err) {
        showError(el, err.message || 'Enter an amount in dollars, such as 2,500 or 2,500.75.');
        return;
      }
      showError(el, null);
      const bal = ctx.state.plan.balances || {};
      const dateEl = document.getElementById(el.id + '-date');
      const date = dateEl && E.dates.isDate(dateEl.value) ? dateEl.value : todayIso();
      const first = model(ctx).balances.mode === 'none' && cents !== null;
      const current = account ? (bal.accounts || {})[account] : bal.jointCashCents;
      if ((current ?? null) === cents) return;
      const message = cents === null ? `${name}: balance removed.` : `${name}: balance ${exact(cents)} as of ${fmt.date(date)}.`;
      change(ctx, st => {
        let next;
        if (account) {
          next = E.state.setPath(st, 'plan.balances.accounts.' + account, cents === null ? undefined : cents);
          next = E.state.setPath(next, 'plan.balances.accountDates.' + account, cents === null ? undefined : date);
        } else {
          next = E.state.setPath(st, 'plan.balances.jointCashCents', cents);
          next = E.state.setPath(next, 'plan.balances.asOf', cents === null ? null : date);
        }
        if (first && (!st.ui.plan || st.ui.plan.mode !== 'trends')) next = E.state.setPath(next, 'ui.plan.mode', 'balance');
        return next;
      }, message);
    },
    'plan:balance-use-data': (ctx, el) => {
      const account = el.dataset.account;
      const data = dataAnchorsOf(ctx).get(account);
      if (!account) return;
      focusNext = `[id="plan-bal-${account}-edit"] > summary`;
      change(ctx, st => {
        let next = E.state.setPath(st, 'plan.balances.accounts.' + account, undefined);
        next = E.state.setPath(next, 'plan.balances.accountDates.' + account, undefined);
        return next;
      }, `${el.dataset.name}: using the ${data && data.source === 'statement' ? 'statement' : 'bank'} figure again${data ? ` (${exact(data.cents)} on ${fmt.date(data.date)})` : ''}.`);
    },

    // ---- planned changes
    'plan:change-accept': (ctx, el) => {
      const on = !!el.checked;
      const ch = changeOf(ctx, el.dataset.change);
      change(ctx, st => E.timeline.acceptChanges(st, el.dataset.change, on),
        on ? `${el.dataset.name} accepted${ch && ch.cents === null ? ': it applies once it has an amount' : ''}.` : `${el.dataset.name} is listed only, not applied.`);
    },
    /** A pack's or a what-if's box: accept, or unaccept, every change in it at once. */
    'plan:group-accept': (ctx, el) => {
      const on = !!el.checked;
      const ids = String(el.dataset.ids || '').split(' ').filter(Boolean);
      const list = model(ctx).changes.list.filter(ch => !ch.readOnly && ids.includes(ch.id));
      if (!list.length) return;
      const unset = list.filter(ch => ch.cents === null).length;
      focusNext = '#' + el.id;
      change(ctx, st => E.timeline.acceptChanges(st, list.map(ch => ch.id), on),
        on ? `${el.dataset.name}: ${plural(list.length, 'change')} accepted${unset ? `; ${unset} still ${unset === 1 ? 'needs' : 'need'} an amount` : ''}.` : `${el.dataset.name}: listed only, not applied.`);
    },
    'plan:change-accept-all': ctx => {
      const list = model(ctx).changes.list.filter(ch => !ch.readOnly && !ch.accepted);
      if (!list.length) return;
      const unset = list.filter(ch => ch.cents === null).length;
      change(ctx, st => E.timeline.acceptChanges(st, list.map(ch => ch.id), true),
        `Accepted ${plural(list.length, 'planned change')}${unset ? `; ${unset} still ${unset === 1 ? 'needs' : 'need'} an amount` : ''}.`);
    },
    'plan:change-unaccept-all': ctx => {
      const list = model(ctx).changes.list.filter(ch => !ch.readOnly && ch.accepted);
      if (!list.length) return;
      focusNext = '#plan-ch-accept-all';
      change(ctx, st => E.timeline.acceptChanges(st, list.map(ch => ch.id), false), `${plural(list.length, 'planned change')} no longer applied.`);
    },
    'plan:change-label': (ctx, el) => {
      const ch = changeOf(ctx, el.dataset.change);
      const label = String(el.value || '').trim();
      if (!ch || label === ch.label) return;
      if (!label) { showError(el, 'Give the change a name.'); el.value = ch.label; return; }
      try {
        change(ctx, st => E.timeline.setChange(st, ch.id, { label }), `Renamed to “${label}”.`);
        showError(el, null);
      } catch (err) { showError(el, err.message); }
    },
    'plan:change-cents': (ctx, el) => {
      const ch = changeOf(ctx, el.dataset.change);
      if (!ch) return;
      const cents = centsFrom(el, 'cents');
      if (cents === undefined || cents === ch.cents) return;
      change(ctx, st => E.timeline.setChange(st, ch.id, { cents }),
        cents === null ? `${ch.label}: amount cleared (not applied until it has one).` : `${ch.label}: ${amt(cents)}${ch.kind === 'monthly' ? ' a month' : ''}.`);
    },
    'plan:change-field': (ctx, el) => {
      const ch = changeOf(ctx, el.dataset.change);
      const field = el.dataset.field;
      if (!ch || !['kind', 'group', 'personId'].includes(field)) return;
      const value = el.value === '' ? null : el.value;
      if ((ch[field] ?? null) === value) return;
      const words = field === 'kind' ? KIND_LABEL[value].toLowerCase()
        : field === 'group' ? CHANGE_GROUP_LABEL[value].toLowerCase()
          : value === null ? 'other money in' : ((model(ctx).people.find(p => p.id === value) || {}).name || value) + '’s income';
      change(ctx, st => E.timeline.setChange(st, ch.id, { [field]: value }), `${ch.label}: now ${words}.`);
    },
    'plan:change-remove': (ctx, el) => {
      const ch = changeOf(ctx, el.dataset.change);
      if (!ch) return;
      // The next change in the list takes focus (or the one before; else adding a change).
      const item = el.closest('.plan-ch-item');
      const near = x => (x && x.querySelector('.plan-ch-remove') ? x.querySelector('.plan-ch-remove').id : null);
      const ids = [near(item && item.nextElementSibling), near(item && item.previousElementSibling)];
      focusNext = rootEl => ids.map(id => id && document.getElementById(id)).find(Boolean) || rootEl.querySelector('#plan-add-custom > summary');
      change(ctx, st => E.timeline.removeChange(st, ch.id), `Removed “${ch.label}”.`);
    },
    'plan:add-change': (ctx, form) => {
      const err = document.getElementById('plan-ch-new-error');
      const fail = message => { if (err) { err.textContent = message; err.hidden = false; } };
      if (err) { err.textContent = ''; err.hidden = true; }
      const data = new FormData(form);
      const label = String(data.get('label') || '').trim();
      const kind = String(data.get('kind') || 'oneTime');
      const group = String(data.get('group') || 'irregular');
      const startMonth = String(data.get('start') || '');
      if (!label) return fail('Give the change a name.');
      if (!E.months.isMonth(startMonth)) return fail('Choose the month it starts (or happens).');
      let cents = null;
      const raw = typed(data.get('amount'));
      if (raw !== '') {
        try { cents = E.money.inputToCents(raw, { allowNegative: true, field: 'cents' }); } catch (e) { return fail(e.message || 'Enter an amount in dollars, such as 400 or -250.'); }
      }
      // Added by the household itself: accepted at once (a template's items wait for a decision).
      const item = { label, kind, group, personId: null, startMonth, endMonth: null, cents, accepted: true };
      try {
        focusNext = '#plan-ch-new-label';
        change(ctx, st => E.timeline.addChange(st, item),
          `Added “${label}”${cents === null ? ': enter its amount to apply it' : `, ${amt(cents)}${kind === 'monthly' ? ' a month from ' : ' in '}${fmt.month(startMonth)}`}.`);
      } catch (e) {
        focusNext = null;
        if (e && e.name === 'ValidationError') return fail(e.message);
        throw e;
      }
      return undefined;
    },
    /**
     * A pack (New baby, Childcare, Kid costs): its items are listed, never accepted for the
     * household, and tagged with the pack's name as a what-if, so Compare can draw them first.
     */
    'plan:add-pack': (ctx, form) => {
      const key = form.dataset.pack;
      const stem = form.dataset.stem;
      const pack = PACKS[key];
      const make = E.timeline.templates[key];
      if (!pack || typeof make !== 'function') return;
      const err = document.getElementById('plan-pack-' + stem + '-date-error');
      const first = form.querySelector('input');
      const fail = message => {
        if (err) { err.textContent = message; err.hidden = false; }
        if (first) { first.setAttribute('aria-invalid', 'true'); first.focus(); }
      };
      if (err) { err.textContent = ''; err.hidden = true; }
      for (const x of form.querySelectorAll('input')) x.removeAttribute('aria-invalid');
      const data = new FormData(form);
      let items;
      try {
        if (key === 'childcare') {
          const start = String(data.get('start') || '');
          if (!E.months.isMonth(start)) return fail('Choose the month childcare starts.');
          const raw = typed(data.get('amount'));
          const cents = raw === '' ? null : E.money.inputToCents(raw, { field: 'monthlyCents' });
          items = make(start, cents, { scenario: pack.name });
        } else {
          const due = String(data.get('due') || '');
          if (!E.dates.isDate(due)) return fail('Enter the due date first.');
          items = make(due, { scenario: pack.name });
        }
      } catch (e) {
        if (e && e.name === 'ValidationError') return fail(e.message);
        throw e;
      }
      const box = document.getElementById('plan-add-' + stem);
      if (box) box.open = false; // closed before the render, so it comes back closed
      // The pack's row comes up open, with its box focused (a pack of one is a plain line).
      P.openGroup = pack.name;
      focusNext = items.length > 1 ? '#' + groupIdOf(pack.name) + '-on' : '#plan-ch-accept-all';
      change(ctx, st => E.timeline.addChange(st, items),
        `${pack.name}: ${plural(items.length, 'item')} added, not in the plan yet. Check the amounts, then accept them.`);
      return undefined;
    },
  };

  Object.assign(P, { actions, takeNext, keyedCategory });
})(typeof globalThis !== 'undefined' ? globalThis : this);
