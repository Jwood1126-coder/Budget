'use strict';
/*
 * Edit plan (#/budget), the dials: money in by person; money out by how adjustable it is
 * (essentials, flexible, irregular, net to savings, other). Essentials and flexible open into
 * categories and places (each can move to the other group), the irregular dial into its one-time
 * costs; "Who paid in" lists the deposits behind money in. Each dial has its Reset, and "Reset all
 * to baseline" puts every dial back. sumOf adds the dials up for the spoken announcement.
 * Every place, "everything else" row and one-time item opens into the transactions behind it, each
 * with its category to change (a ledger edit, undoable); a place's row changes every transaction
 * from that place at once.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const P = UI._plan;
  const { DIAL_CLS, isCents, whole, exact, amt, plural, inputText, shortDate, badgeWithId } = P;

  const DIAL_SUB = {
    essentials: 'The part that doesn’t move much',
    flexible: 'Where the budget can realistically move',
    irregular: 'One-time things that still happen every year, spread per month',
  };
  const SUM_NAME = { essentials: 'essentials', flexible: 'flexible', irregular: 'irregular', investing: 'investing', other: 'other' };
  const GROUP_NAME = { essentials: 'Essentials', flexible: 'Flexible spending' };
  const PATTERN = { bill: 'Bill', everyday: 'Everyday', occasional: 'Occasional' };
  const PATTERN_TIP = {
    bill: 'Charged about once a month at nearly the same amount',
    everyday: 'Seen in most months, amount varies',
    occasional: 'Seen in only some months',
  };
  const PAID = { card: 'card', bank: 'bank', mixed: 'both' };
  const PAID_TIP = { card: 'Paid by card', bank: 'Paid from the bank', mixed: 'Paid partly by card, partly from the bank' };
  const STEP_CENTS = 2500; // the sliders move in $25 steps; the exact box keeps cents

  const TXN_PAGE = 25; // a list of transactions shows this many until “Show all” is pressed
  const TXN_REASON = 'Set on the Plan page';

  const signedAmt = cents => (cents > 0 ? '+' : '') + amt(cents);
  const dialLabel = d => (d.group === 'in' && d.key !== 'inOther' ? d.label + ' → joint' : d.label);
  const signedDial = d => d.key === 'savings' || d.key === 'investing' || d.key === 'other' || (d.baselineCents || 0) < 0 || (d.planCents || 0) < 0;

  // ---- what a Reset puts back (its label and its toast): what the setup file supplied for the
  // dial or row when it did (timeline.resetDial/resetRow/resetPlan write that back), else nothing.
  const setupOf = (state, path) => E.setupSync.baseValue(state, 'ui.plan.' + path);
  const setupKeys = (state, field) => Object.keys(setupOf(state, field) || {});
  /** Where Reset puts a dial: "your setup value ($X)", "your setup file’s rows", else "its baseline ($Y)". */
  function dialResetTo(state, d) {
    const cents = setupOf(state, 'dials.' + d.key);
    if (isCents(cents)) return `your setup value (${amt(cents)})`;
    if (setupKeys(state, 'rows').some(id => id.startsWith(d.key + '-')) || (d.key === 'irregular' && setupKeys(state, 'irregularOff').length)) return `your setup file’s ${d.key === 'irregular' ? 'list' : 'rows'}`;
    return `its baseline (${amt(d.baselineCents)})`;
  }
  /** Where Reset puts a drill-down row: the setup file's change for it, else its budget (a category with one), else its average. */
  function rowResetTo(state, r) {
    const set = setupOf(state, 'rows.' + r.id);
    if (set) return isCents(set.cents) ? `your setup value (${amt(set.cents)})` : `your setup file’s setting${set.included === false ? ' (left out)' : ''}`;
    return isCents(r.budgetCents) ? `its budget (${amt(r.budgetCents)})` : 'its average';
  }
  /** Whether Reset all puts back something the setup file supplied (else every dial goes to its baseline). */
  const setupDials = state => ['dials', 'rows', 'irregularOff'].some(f => setupKeys(state, f).length > 0);

  // ------------------------------------------------------------------ 3. dials
  /** Slider range: a convenience around the baseline, widened for the value; never clamps it. */
  function rangeOf(d) {
    const base = isCents(d.baselineCents) ? d.baselineCents : 0;
    const value = isCents(d.planCents) ? d.planCents : 0;
    const big = Math.max(2 * Math.abs(base), 1000000, Math.abs(value));
    const unit = big > 2000000 ? 100000 : 50000;
    const hi = Math.ceil(big / unit) * unit;
    const lo = signedDial(d) ? 0 - hi : Math.min(0, Math.floor(Math.min(base, value) / STEP_CENTS) * STEP_CENTS);
    return { lo, hi };
  }

  function hintText(d) {
    const h = d.hint;
    if (!h || !h.count || !isCents(h.lastCents)) return '';
    return `Last deposit ${whole(h.lastCents)} on ${shortDate(h.lastDate)}` + (isCents(h.perMonthCents) && h.cadence ? `, ≈ ${whole(h.perMonthCents)}/mo (${h.cadence})` : '') + '.';
  }

  /**
   * The basis in a few words (the whole sentence is behind the dial's ⓘ): "6-month average",
   * "From Budget", "Set here", "Deposit average", "3 one-time costs, spread".
   */
  function shortBasis(tl, d) {
    const text = String(d.basis || '');
    if (d.basisKind === 'budget' || /^From Budget/.test(text)) return d.key === 'savings' ? 'From your savings goals' : d.group === 'in' ? 'From your pay' : 'From your bills and budgets';
    if (d.basisKind === 'average' && d.group === 'in') return 'Deposit average';
    if (/^Set here/.test(text)) return 'Set here';
    if (d.key === 'irregular' && d.drill && d.drill.count) return plural(d.drill.count, 'one-time cost') + ', spread';
    if (/^Average of/.test(text) && tl.baseline.count) return tl.baseline.count + '-month average';
    return text.split(/;| \(| — /)[0];
  }

  function dialHtml(ctx, tl, d) {
    const id = 'plan-dial-' + d.key;
    const label = dialLabel(d);
    const value = isCents(d.planCents) ? d.planCents : null;
    const { lo, hi } = rangeOf(d);
    const base = isCents(d.baselineCents) ? d.baselineCents : null;
    const frac = base === null ? null : Math.min(1, Math.max(0, (base - lo) / (hi - lo || 1)));
    const reset = d.source !== 'baseline' ? c.button('Reset', { action: 'plan:reset-dial', data: { dial: d.key }, cls: 'btn-small dial-reset', id: id + '-reset', ariaLabel: 'Reset ' + label + ' to ' + dialResetTo(ctx.state, d) }) : '';
    const set = d.source === 'direct' ? ' · set by you' : d.source === 'rows' ? ' · from the list below' : '';
    const hint = d.group === 'in' ? hintText(d) : '';
    const sub = DIAL_SUB[d.key] || '';
    // A person's money in: from the pay saved in Budget, else the deposit average (not confirmed).
    const person = d.group === 'in' && typeof d.basisKind === 'string';
    const budgetLink = text => `<a class="dial-budget-link" id="${esc(id)}-budget" href="${esc(ctx.href('budget', { section: 'income' }))}">${esc(text)}</a>`;
    // One short line under the dial; the whole basis is behind ⓘ.
    let basis = esc(shortBasis(tl, d));
    let why = esc(d.basis);
    // An amount carried over from the earlier card/bank dials says so until it is kept or changed.
    if (d.carriedOver) basis = esc(d.carriedOver.note) + ' ' + c.button('Keep', { action: 'plan:keep-carried', variant: 'ghost', data: { dial: d.key }, cls: 'btn-small dial-keep', id: id + '-keep', ariaLabel: 'Keep ' + label + ' at ' + amt(d.planCents) + ' and remove this note' });
    if (person && d.basisKind === 'budget') basis += ' · ' + budgetLink('Change');
    if (person && d.needsConfirm) {
      const unknown = d.budget && Array.isArray(d.budget.unknown) ? d.budget.unknown : [];
      basis += ' · ' + budgetLink('Set pay');
      why += (/[.!?]$/.test(d.basis) ? '' : '.') + (unknown.length ? ' ' + esc('Pay and income has no amount for: ' + unknown.join(', ') + '.') : '') + ' Enter the current amount here, or save it under Pay and income.';
    }
    const unconfirmed = person && d.needsConfirm ? badgeWithId(id + '-unconfirmed', 'Not confirmed', 'warn')
      // Debt payments in the history are more than the current debt bills (the plan uses the bills): one may be missing.
      : d.debtCheck && d.debtCheck.historyMore ? badgeWithId(id + '-check', 'Check debt bills', 'warn', { title: 'Your history paid ' + amt(d.debtCheck.averageCents) + ' a month toward debts; your current debt bills add up to ' + amt(d.debtCheck.billsCents) + '.' }) : '';
    // At the pay from Budget, or at the setup file's amount (where Reset puts it), the deposit
    // average is one click away: an explicit choice, kept as the household's.
    const atSetup = d.basisKind === 'direct' && setupOf(ctx.state, 'dials.' + d.key) === d.planCents;
    const average = person && isCents(d.averageCents) && ((d.basisKind === 'budget' && isCents(d.budgetCents) && d.averageCents !== d.budgetCents) || (atSetup && d.averageCents !== d.planCents))
      ? `<button type="button" class="btn btn-ghost btn-small dial-average" id="${esc(id)}-average" data-action="plan:use-average" data-dial="${esc(d.key)}" title="${esc(tl.baseline.label)}">${esc(`Use the ${tl.baseline.count}-month average (${amt(d.averageCents)})`)}</button>`
      : '';
    const info = `<details class="dial-info" id="${esc(id)}-info"><summary title="About ${esc(label)}"><span class="dial-info-i" aria-hidden="true">i</span><span class="sr-only">About ${esc(label)}</span></summary>
        <div class="dial-info-body">${sub ? `<p class="dial-sub" id="${esc(id)}-sub">${esc(sub)}</p>` : ''}<p class="dial-why" id="${esc(id)}-why">${why}</p>${hint ? `<p class="dial-hint" id="${esc(id)}-hint">${esc(hint)}</p>` : ''}</div></details>`;
    const described = [id + '-base', id + '-basis', id + '-error'].join(' ');
    return `<div class="dial" data-dial="${esc(d.key)}" data-cents="${value === null ? '' : value}">
        <div class="dial-head">
          <div class="dial-title"><label class="dial-label" for="${esc(id)}"><span class="key key-swatch ${esc(DIAL_CLS[d.key] || 'series-muted')}" aria-hidden="true"></span>${esc(label)}</label>${info}${unconfirmed}</div>
          <span class="input-money plan-amount dial-amount"><span aria-hidden="true">$</span><input id="${esc(id)}" type="text" inputmode="${signedDial(d) ? 'text' : 'decimal'}" autocomplete="off" spellcheck="false" value="${esc(inputText(value))}" placeholder="Unknown" data-action="plan:dial" data-commit="1" data-dial="${esc(d.key)}" aria-label="${esc(label)}, dollars a month" aria-describedby="${esc(described)}"></span>
        </div>
        <div class="dial-track"${frac === null ? '' : ` style="--f:${frac.toFixed(4)}"`}>
          ${frac === null ? '' : '<span class="dial-tick" aria-hidden="true"></span>'}
          <input class="dial-range" id="${esc(id)}-range" type="range" min="${lo / 100}" max="${hi / 100}" step="${STEP_CENTS / 100}" value="${(value || 0) / 100}" data-action="plan:dial-range" data-dial="${esc(d.key)}" aria-label="${esc(label)}, dollars a month" aria-valuetext="${esc(amt(value || 0))} a month" aria-describedby="${esc(id)}-base">
        </div>
        <p class="field-error" id="${esc(id)}-error" role="alert" hidden></p>
        <div class="dial-foot"><span class="dial-line"><span class="dial-base" id="${esc(id)}-base">baseline ${esc(base === null ? 'unknown' : amt(base))}${esc(set)}</span><span class="dial-basis" id="${esc(id)}-basis">${basis}</span></span><span class="dial-actions">${average}${reset}</span></div>
        ${d.drill && d.drill.kind === 'categories' ? categoriesDrill(ctx, tl, d) : ''}
        ${d.drill && d.drill.kind === 'items' ? irregularDrill(ctx, tl, d) : ''}
      </div>`;
  }

  /** "· baseline $X" when the dial is somewhere else. */
  const baselineNote = d => (isCents(d.baselineCents) && d.planCents !== d.baselineCents ? ` · baseline ${amt(d.baselineCents)}` : '');

  // ---- drill-down: essentials and flexible open into categories and places
  /** The other spending group: where a row in `group` can move. */
  const otherGroup = group => (group === 'essentials' ? 'flexible' : 'essentials');

  function moveControl(r, { key, name, moved }) {
    const id = 'plan-row-' + r.id;
    if (moved) {
      return c.button('Put back', { action: 'plan:move-group', data: { key, to: '', name }, cls: 'btn-small btn-ghost drill-move', id: id + '-back', ariaLabel: `Put ${name} back in its usual group` });
    }
    const to = otherGroup(r.group);
    return c.button('Move to ' + (to === 'essentials' ? 'Essentials' : 'Flexible'), { action: 'plan:move-group', data: { key, to, name }, cls: 'btn-small btn-ghost drill-move', id: id + '-move', ariaLabel: `Move ${name} to ${GROUP_NAME[to]}` });
  }

  function rowHtml(ctx, tl, r, { move = null, bulk = '' } = {}) {
    const id = 'plan-row-' + r.id;
    const name = r.label;
    const usual = r.stable && isCents(r.latestCents) ? `usually ${amt(r.latestCents)}` : `avg ${whole(r.avgCents)}/mo`;
    const seen = isCents(r.seenMonths) ? r.seenMonths : r.months;
    const of = isCents(r.ofMonths) ? r.ofMonths : tl.baseline.count;
    const edited = (r.override ? ' ' + c.badge('edited', 'info') + ' ' + c.button('Reset', { action: 'plan:row-reset', data: { row: r.id, name }, cls: 'btn-small btn-ghost drill-reset', id: id + '-reset', ariaLabel: 'Reset ' + name + ' to ' + rowResetTo(ctx.state, r) }) : '')
      + (r.source === 'budget' ? ' ' + c.badge('budget', 'info') : '')
      + (r.source === 'aggregate' ? ' ' + c.badge('in ' + r.aggregate, 'info', { title: 'Planned in the ' + r.aggregate + ' budget, which counts it once' }) : '');
    const pattern = PATTERN[r.pattern] ? `<span class="drill-pattern is-${esc(r.pattern)}" id="${esc(id)}-pattern" title="${esc(PATTERN_TIP[r.pattern])}">${esc(PATTERN[r.pattern])}</span>` : '';
    const paid = PAID[r.paidBy] ? `<span class="drill-paid" id="${esc(id)}-paid" title="${esc(PAID_TIP[r.paidBy])}">${esc(PAID[r.paidBy])}</span>` : '';
    const moved = move && move.moved ? badgeWithId(id + '-moved', 'moved', 'info', { title: move.from ? 'Moved from ' + move.from : 'Moved here by you' }) : '';
    const from = move && move.moved && move.from ? `<span class="drill-from">from ${esc(move.from)}</span>` : '';
    return `<div class="drill-row level-${r.level}${r.included ? '' : ' is-out'}" data-row="${esc(r.id)}">
        <label class="drill-name" for="${esc(id)}-on"><input type="checkbox" id="${esc(id)}-on" data-action="plan:row-include" data-row="${esc(r.id)}" data-name="${esc(name)}"${r.included ? ' checked' : ''}><span>${esc(name)}</span></label>
        <span class="input-money drill-amt"><span aria-hidden="true">$</span><input id="${esc(id)}-amt" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(inputText(r.planCents))}" data-action="plan:row-cents" data-commit="1" data-row="${esc(r.id)}" data-name="${esc(name)}" aria-label="${esc(name)}, dollars a month in the plan" aria-describedby="${esc(id)}-meta ${esc(id)}-error"></span>
        <p class="drill-meta" id="${esc(id)}-meta"><span>${esc(usual)} · ${esc(seen + ' of ' + of + ' mo')}</span>${pattern}${paid}${moved}${from}${edited}${move ? moveControl(r, move) : ''}${bulk}</p>
        <p class="field-error drill-error" id="${esc(id)}-error" role="alert" hidden></p>
      </div>`;
  }

  function categoriesDrill(ctx, tl, d) {
    const drill = d.drill;
    const cats = drill.rows.filter(r => r.level === 1);
    if (!cats.length) return '';
    const notice = d.source === 'direct'
      ? c.notice({ tone: 'info', title: `Dial set directly to ${amt(d.planCents)}; the rows add up to ${amt(drill.rowsCents)}.`, actions: c.button('Use the rows', { action: 'plan:use-rows', data: { dial: d.key }, cls: 'btn-small', id: 'plan-drill-' + d.key + '-use' }) })
      : '';
    const list = cats.map(cat => {
      const kids = drill.rows.filter(r => r.parent === cat.id);
      // A place moved as a whole is its own row: its one child is itself.
      const only = (kids.length === 1 && kids[0].kind === 'rest') || (cat.synthetic && kids.length <= 1);
      const places = kids.filter(k => k.kind === 'merchant').length;
      const more = kids.some(k => k.kind === 'rest');
      const label = places ? `Show ${plural(places, 'place')}${more ? ' and everything else' : ''}` : 'Show everything in it';
      const place = k => k.kind === 'merchant' && !cat.synthetic;
      const kidHtml = k => rowHtml(ctx, tl, k, { move: place(k) ? { key: E.timeline.MERCHANT_KEY + k.label, name: k.label, moved: false } : null, bulk: place(k) ? bulkCategory(ctx, k) : '' })
        + txnsDetails(ctx, tl, k.id, k.txnIds);
      const sub = kids.length && !only
        ? `<details class="drill-kids" id="plan-drillrow-${esc(cat.id)}"><summary>${esc(label)}</summary><div class="drill-kids-body">${kids.map(kidHtml).join('')}</div></details>`
        : txnsDetails(ctx, tl, cat.id, cat.txnIds); // its rows are not listed: its transactions are, here
      const moved = cat.groupSource === 'override';
      const move = cat.groupKey ? { key: cat.groupKey, name: cat.label, moved, from: cat.synthetic && Array.isArray(cat.movedFrom) ? cat.movedFrom.join(', ') : '' } : null;
      return `<li class="drill-cat">${rowHtml(ctx, tl, cat, { move })}${sub}</li>`;
    }).join('');
    const summary = `What’s in this · ${plural(cats.length, 'category', 'categories')} · ${amt(d.planCents)}/mo${baselineNote(d)}`;
    const body = `${notice}<ul class="drill-list">${list}</ul>
      <p class="fine">Untick what you would stop paying for, or type a new amount: the dial follows the rows. “Move to …” puts a category or a place in the other group; the total stays the same. “Show transactions” lists what is behind a row; a purchase in the wrong category can be moved there, one at a time or all from a place.</p>`;
    return c.disclosure(esc(summary), body, { id: 'plan-drill-' + d.key, cls: 'plan-drill' });
  }

  // ---- drill-down: the irregular dial's one-time costs
  function irregularDrill(ctx, tl, d) {
    const dr = d.drill;
    const kept = (tl.baseline.keptIn || []).filter(o => o.role === 'card' || o.role === 'bank' || o.dialKey === 'irregular');
    if (!dr.count && !kept.length) return '';
    const n = tl.baseline.count;
    const notice = d.source === 'direct'
      ? c.notice({ tone: 'info', title: `Dial set directly to ${amt(d.planCents)}; the costs in the allowance come to ${amt(dr.rowsCents)} a month.`, actions: c.button('Use the list', { action: 'plan:use-rows', data: { dial: d.key }, cls: 'btn-small', id: 'plan-drill-' + d.key + '-use' }) })
      : '';
    const items = dr.rows.map(i => {
      const id = 'plan-irr-' + i.id;
      const what = `${i.label} · ${fmt.date(i.date)} · ${exact(i.cents)}`;
      // Left out of planning in Transactions or Spending: out by default; ticking it puts it back on purpose.
      const where = i.planningExcluded ? (i.included ? 'put back in here; left out of planning in Transactions or Spending' : 'left out of planning in Transactions or Spending')
        : i.included ? 'in the allowance' : 'left out by you';
      return `<li class="drill-row irr-row${i.included ? '' : ' is-out'}" data-txn="${esc(i.id)}">
          <label class="drill-name" for="${esc(id)}-on"><input type="checkbox" id="${esc(id)}-on" data-action="plan:irregular" data-txn="${esc(i.id)}" data-name="${esc(i.label)}"${i.included ? ' checked' : ''} aria-describedby="${esc(id)}-meta"><span>${esc(what)}</span></label>
          <span class="irr-monthly" id="${esc(id)}-monthly">${esc(amt(i.monthlyCents))}/mo</span>
          <p class="drill-meta" id="${esc(id)}-meta"><span>${esc(where)}${i.category ? ' · ' + esc(i.category) : ''}</span><span class="drill-paid" title="${esc(PAID_TIP[i.paidBy] || '')}">${esc(PAID[i.paidBy] || '')}</span>${c.button('Count as regular', { action: 'plan:irregular-regular', data: { txn: i.id, name: i.label }, cls: 'btn-small btn-ghost drill-move', id: id + '-regular', ariaLabel: `Count ${i.label} on ${fmt.date(i.date)} as regular spending in ${i.category || 'its category'}` })}</p>
          ${txnsDetails(ctx, tl, i.id, i.txnIds || [i.id], { label: 'Show transaction' })}
        </li>`;
    }).join('');
    const keptHtml = kept.length ? `<div class="irr-kept" id="plan-irr-kept"><p class="drill-h">Counted as regular spending (${kept.length})</p><ul class="drill-list">${kept.map(o => {
      const id = 'plan-irr-' + o.id;
      return `<li class="drill-row irr-row"><span class="drill-name">${esc(`${o.merchant} · ${fmt.date(o.date)} · ${exact(o.cents)}`)}</span>
          <p class="drill-meta">${c.button('Count as one-time', { action: 'plan:irregular-onetime', data: { txn: o.id, name: o.merchant }, cls: 'btn-small btn-ghost drill-move', id: id + '-onetime', ariaLabel: `Count ${o.merchant} on ${fmt.date(o.date)} as a one-time cost again` })}</p></li>`;
    }).join('')}</ul></div>` : '';
    const summary = `What’s in this · ${plural(dr.count, 'item')} · ${amt(dr.includedCents)} over ${plural(n, 'month')} → ${amt(dr.rowsCents)}/mo`
      + (dr.leftOutCount ? `; ${dr.leftOutCount} left out by you` : '')
      + (d.source === 'direct' ? ` · dial ${amt(d.planCents)}/mo` : '') + baselineNote(d);
    const body = `${notice}${dr.count ? `<ul class="drill-list irr-list">${items}</ul>` : ''}${keptHtml}
      <p class="fine">Each cost is spread over the ${plural(n, 'baseline month')}. Untick one you don’t expect again; “Count as regular” moves it into its category instead. Past months always keep every cost.</p>`;
    return c.disclosure(esc(summary), body, { id: 'plan-drill-' + d.key, cls: 'plan-drill' });
  }

  // ---- the transactions behind a row, each with its category (and every one from a place at once)
  /** The decided transactions (what the timeline is built from) by id, once per render. */
  const txnMap = ctx => ctx.memo('plan-txn-map', () => new Map((ctx.realTxns || ctx.txns).map(t => [t.id, t])));
  /** A transaction's place, as the timeline names it (its merchant, else the bank's text). */
  const placeOf = t => t.merchant || t.description || 'Unknown place';
  /** A purchase split over categories: its category is set in its details, not here. */
  const isSplit = t => !!t.splitApplied || (Array.isArray(t.parts) && t.parts.length > 1);
  /**
   * Every spending transaction in the data by place: the whole data set, not only the baseline
   * months (what “All N from this place” changes). Split purchases are left out.
   */
  const placeTxns = ctx => ctx.memo('plan-place-txns', () => {
    const byPlace = new Map();
    for (const t of ctx.realTxns || ctx.txns) {
      if (t.kind !== 'spend' || isSplit(t)) continue;
      const k = placeOf(t);
      if (!byPlace.has(k)) byPlace.set(k, []);
      byPlace.get(k).push(t);
    }
    return byPlace;
  });
  /** Every row that lists transactions, by id: the essentials and flexible rows and the one-time items. */
  const rowsById = (ctx, tl) => ctx.memo('plan-rows-by-id', () => {
    const byId = new Map();
    for (const d of tl.dials) if (d.drill) for (const r of d.drill.rows) if (Array.isArray(r.txnIds)) byId.set(r.id, r);
    return byId;
  });

  /**
   * Category choices as the Transactions view offers them (the taxonomy plus every category in the
   * data, in the same order), grouped under the taxonomy's groups; `value` is added when missing.
   */
  function categoryOptionsHtml(ctx, value) {
    const names = ctx.memo('plan-categories', () => UI.shared.categoryOptions(ctx));
    const list = value && !names.includes(value) ? E.categories.sortNames(names.concat([value])) : names;
    let html = '', group = null;
    for (const n of list) {
      const g = E.categories.groupOf(n);
      if (g !== group) { html += (group === null ? '' : '</optgroup>') + `<optgroup label="${esc(g)}">`; group = g; }
      html += `<option value="${esc(n)}"${n === value ? ' selected' : ''}>${esc(n)}</option>`;
    }
    return html + (group === null ? '' : '</optgroup>');
  }

  /** One transaction: date, the bank's text, account, amount; its category (a select) and a link to its details. */
  function txnLine(ctx, t) {
    const name = placeOf(t);
    const when = fmt.date(t.date);
    const desc = t.description || name;
    const sid = 'plan-txcat-' + t.id;
    const parts = Array.isArray(t.parts) && t.parts.length ? t.parts : t.edit && Array.isArray(t.edit.splits) ? t.edit.splits : [];
    const cat = isSplit(t)
      ? `<span class="plan-tx-split" title="Split over categories: change the parts in its details">Split: ${esc(parts.map(p => p.category).join(', '))}</span>`
      : `<label class="sr-only" for="${esc(sid)}">${esc(`Category of ${desc}, ${when}`)}</label><select id="${esc(sid)}" class="plan-txcat" data-action="plan:txn-category" data-txn="${esc(t.id)}" data-name="${esc(name)}">${categoryOptionsHtml(ctx, t.category)}</select>`;
    const href = ctx.href('spending', { period: t.date.slice(0, 7), txn: t.id });
    return `<li class="plan-tx" data-txn="${esc(t.id)}">
        <span class="plan-tx-line"><span class="plan-tx-date">${esc(shortDate(t.date))}</span><span class="plan-tx-desc" title="${esc(desc)}">${esc(desc)}</span><span class="plan-tx-amt">${esc(UI.shared.amountText(t))}</span></span>
        <span class="plan-tx-meta"><span class="plan-tx-acct">${esc(t.accountLabel || t.accountId || '')}</span>${cat}<a class="plan-tx-link" href="${esc(href)}" title="Open this transaction: the bank’s category, its history, splits and notes">Details<span class="sr-only">${esc(`: ${desc}, ${when}`)}</span></a></span>
      </li>`;
  }

  /** The lines of a list: newest first, the first TXN_PAGE until “Show all” (all = true). */
  function txnsBody(ctx, rowId, ids, all) {
    const map = txnMap(ctx);
    const list = ids.map(id => map.get(id)).filter(Boolean);
    const shown = all ? list : list.slice(0, TXN_PAGE);
    const more = list.length > shown.length
      ? c.button(`Show all ${list.length}`, { action: 'plan:txns-all', variant: 'ghost', data: { row: rowId }, cls: 'btn-small plan-txns-all', id: 'plan-txns-' + rowId + '-all' })
      : '';
    return `<ul class="plan-tx-list">${shown.map(t => txnLine(ctx, t)).join('')}</ul>${more}`;
  }

  /**
   * “Show N transactions” under a row (closed at first). Its lines are drawn only while it is open:
   * a list open in the page being replaced (with “Show all” pressed or not) is drawn open again;
   * one opened later is filled when it opens (fillTxns).
   */
  function txnsDetails(ctx, tl, rowId, ids, { label } = {}) {
    if (!Array.isArray(ids) || !ids.length) return '';
    const id = 'plan-txns-' + rowId;
    const prev = typeof document !== 'undefined' ? document.getElementById(id) : null;
    const open = !!(prev && prev.open), all = !!(prev && prev.dataset.all === '1');
    const range = tl.baseline.start === tl.baseline.end ? fmt.month(tl.baseline.start) : fmt.month(tl.baseline.start) + '–' + fmt.month(tl.baseline.end);
    return `<details class="plan-txns" id="${esc(id)}" data-row="${esc(rowId)}"${all ? ' data-all="1"' : ''}${open ? ' open' : ''}>
        <summary title="${esc('In the baseline months, ' + range)}">${esc(label || `Show ${plural(ids.length, 'transaction')}`)}</summary>
        <div class="plan-txns-body">${open ? txnsBody(ctx, rowId, ids, all) : ''}</div>
      </details>`;
  }

  /** Draw a list's lines (when it opens, or all of them after “Show all”). */
  function fillTxns(ctx, details, { all = false } = {}) {
    if (!details || !details.dataset.row) return;
    if (all) details.dataset.all = '1';
    const row = rowsById(ctx, P.model(ctx)).get(details.dataset.row);
    const body = details.querySelector('.plan-txns-body');
    if (!row || !body) return;
    body.innerHTML = txnsBody(ctx, row.id, row.txnIds, details.dataset.all === '1');
  }

  /**
   * On a place's row: “All N from this place → [category]”, every transaction from it in the data
   * (preselected when they share one category).
   */
  function bulkCategory(ctx, r) {
    const list = placeTxns(ctx).get(r.label) || [];
    if (!list.length) return '';
    const n = list.length;
    const cats = new Set(list.map(t => t.category));
    const current = cats.size === 1 ? list[0].category : '';
    const id = 'plan-row-' + r.id + '-cat';
    const title = `Applies to ${n === 1 ? 'the 1 transaction' : `all ${n} transactions`} from this place in your data, in every month (not only the baseline); transactions you import later are not changed.`;
    return `<span class="plan-bulkcat"><label for="${esc(id)}">${esc(n === 1 ? '1 from this place →' : `All ${n} from this place →`)}</label><select id="${esc(id)}" class="plan-txcat" data-action="plan:merchant-category" data-merchant="${esc(r.label)}" title="${esc(title)}">${current ? '' : '<option value="" selected>Mixed categories</option>'}${categoryOptionsHtml(ctx, current)}</select></span>`;
  }

  // ---- who paid in: the baseline window's deposits and whose money each one is
  const PROVISIONAL = ['income', 'amount']; // matched by the pay in Budget or by amount, not the household's word

  /** Deposits into joint in the baseline months, newest first, with their automatic match. */
  function depositsOf(ctx, tl) {
    return ctx.memo('plan-deposits', () => {
      const txns = ctx.realTxns || ctx.txns;
      const rows = tl.baseline.months.length ? E.flows.breakdown(txns, ctx.dataset, { months: tl.baseline.months, coverageMap: ctx.coverageMap, plan: ctx.state.plan }) : [];
      const explain = E.balances.incomeAttribution(ctx.state.plan).explain;
      const byId = new Map(txns.map(t => [t.id, t]));
      return rows.flatMap(r => r.credits || [])
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1))
        .map(x => {
          const t = byId.get(x.id) || {};
          // What the match would be without the household's own choice (rules still count).
          const auto = explain(Object.assign({}, t, { personBasis: t.basePersonId ? 'rule' : null, personId: t.basePersonId || null }));
          const edited = x.basis === 'edit';
          return Object.assign({}, x, { auto, edited, provisional: PROVISIONAL.includes(x.basis), unassigned: !x.who && !edited });
        });
    });
  }

  function depositsHtml(ctx, tl) {
    const list = depositsOf(ctx, tl);
    if (!list.length) return '';
    const name = id => (tl.people.find(p => p.id === id) || {}).name || id;
    const provisional = list.filter(x => x.provisional && x.who);
    const open = list.filter(x => x.provisional || x.unassigned).length;
    const rows = list.map(x => {
      const sid = 'plan-dep-' + x.id;
      const autoLabel = x.edited ? 'Automatic match' : x.auto.who ? name(x.auto.who) + (x.auto.basis === 'rule' ? ' (rule)' : ' (suggested)') : 'Not assigned';
      const current = x.edited ? (x.who || 'none') : '';
      const opts = [['', autoLabel], ...tl.people.map(p => [p.id, p.name]), ['none', 'Neither']];
      const badge = x.provisional ? c.badge('provisional', 'neutral') : x.unassigned ? c.badge('not assigned', 'neutral') : '';
      return {
        what: `<span class="plan-dep-line"><strong>${esc(exact(x.cents))}</strong> ${esc(shortDate(x.date))}</span><small>${esc(x.description)}${x.accountLabel ? ' · ' + esc(x.accountLabel) : ''}</small>`,
        who: `<span class="plan-dep-who"><label class="sr-only" for="${esc(sid)}">Whose money is ${esc(x.description)} on ${esc(fmt.date(x.date))}</label><select id="${esc(sid)}" data-action="plan:person" data-txn="${esc(x.id)}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${badge}</span>`,
      };
    });
    const table = c.table({
      caption: 'Deposits into joint and whose money they are', cls: 'plan-dep-table',
      columns: [{ key: 'what', label: 'Deposit', html: r => r.what }, { key: 'who', label: 'Whose', html: r => r.who }],
      rows,
    });
    const range = tl.baseline.start === tl.baseline.end ? fmt.month(tl.baseline.start) : fmt.month(tl.baseline.start) + '–' + fmt.month(tl.baseline.end);
    const confirm = provisional.length ? c.button(`Confirm all ${provisional.length} provisional match${provisional.length === 1 ? '' : 'es'}`, { action: 'plan:confirm-deposits', id: 'plan-dep-confirm', cls: 'btn-small' }) : '';
    const summary = 'Who paid in' + (open ? ` · ${plural(open, 'deposit')} to confirm` : '');
    const body = `<p class="fine">Deposits into joint, ${esc(range)}. Suggested matches come from the pay you saved or the amount: the bank’s words don’t name the person. Changing one moves it between the dials above; the bank’s description is kept.</p>${confirm}${table}`;
    return c.disclosure(esc(summary), body, { id: 'plan-deposits', cls: 'plan-deposits' });
  }

  /** Dial values in effect: the plan's, with any slider being dragged (not saved yet). */
  function valuesOf(tl, overrides = {}) {
    const out = {};
    for (const d of tl.dials) out[d.key] = Object.prototype.hasOwnProperty.call(overrides, d.key) ? overrides[d.key] : d.planCents;
    return out;
  }

  /**
   * The headline: what every joint account gains or loses a month on this plan (money in − money
   * out; moves to and from savings stay inside), what is left in checking after the move to or
   * from savings, and how the dials add up. { html, text (the first line, for the live region) }.
   */
  function sumOf(tl, vals) {
    const inKeys = tl.groups.in;
    const outKeys = tl.groups.out.filter(k => k !== 'savings');
    // Dials still holding amounts carried over from the earlier card/bank dials: one quiet line.
    const carried = tl.carriedOver ? `<p class="plan-carried" id="plan-carried">${esc(tl.carriedOver.summary)}</p>` : '';
    if (inKeys.concat(outKeys).some(k => !isCents(vals[k]))) {
      const text = 'Your money, all accounts: not known yet (no complete month to start from).';
      return { html: `<p class="plan-headline" id="plan-headline">${esc(text)}</p>${carried}`, text };
    }
    // What the first plan month adds to the dials (bills and goals from Budget, accepted changes):
    // counted here too, so this figure is the one Budget shows for the month.
    const ch = tl.summary && tl.summary.changes ? tl.summary.changes : null;
    const chIn = ch && isCents(ch.inCents) ? ch.inCents : 0, chOut = ch && isCents(ch.outCents) ? ch.outCents : 0;
    const chSav = ch && isCents(ch.savingsCents) ? ch.savingsCents : 0;
    const chName = !ch || !ch.items.length ? '' : ch.items.length === 1 ? ch.items[0].label
      : ch.items.every(i => i.source === 'bill') ? 'bills' : 'planned changes this month';
    const inTotal = inKeys.reduce((s, k) => s + vals[k], 0) + chIn;
    const terms = [[1, inTotal, 'in']].concat(outKeys.map(k => [-1, vals[k], SUM_NAME[k] || k]));
    if (chOut) terms.push([-1, chOut, chName]);
    const combined = terms.reduce((s, [sign, v]) => s + sign * v, 0);
    const words = terms.map(([sign, v, name], i) => {
      const op = (sign < 0) !== (v < 0) ? '−' : '+';
      const text = amt(Math.abs(v)) + ' ' + name;
      return i === 0 ? (v < 0 ? '−' : '') + text : op + ' ' + text;
    });
    const sav = tl.dialsByKey.savings ? (isCents(vals.savings) ? vals.savings + chSav : vals.savings) : chSav;
    let checking;
    if (!isCents(sav)) checking = 'Checking: not known yet (net to savings is unknown)';
    else {
      const net = combined - sav;
      checking = 'Checking: ' + signedAmt(net) + (sav > 0 ? ` after ${amt(sav)} moved to savings` : sav < 0 ? ` after ${amt(0 - sav)} moved from savings` : ', with nothing moved to or from savings');
    }
    const head = `Your money, all accounts: ${signedAmt(combined)} a month on this plan`;
    return {
      html: `<p class="plan-headline" id="plan-headline">Your money, all accounts: <strong class="${combined < 0 ? 'tone-warn' : ''}">${esc(signedAmt(combined))}</strong> a month on this plan</p>
        <p class="plan-checking" id="plan-checking">${esc(checking)}</p>
        <p class="plan-addup" id="plan-addup">${esc(words.join(' ') + ' = ' + signedAmt(combined))}</p>${carried}`,
      text: head + '.',
      combined,
    };
  }

  function dialsCard(ctx, tl) {
    const group = keys => keys.map(k => dialHtml(ctx, tl, tl.dialsByKey[k])).join('');
    const reset = !(tl.changed && tl.changedBy.dials) ? ''
      : setupDials(ctx.state) ? c.button('Reset all', { action: 'plan:reset', id: 'plan-reset', cls: 'btn-small', ariaLabel: 'Reset all dials to your setup file’s values, or to their baseline where it has none' })
        : c.button('Reset all to baseline', { action: 'plan:reset', id: 'plan-reset', cls: 'btn-small' });
    // Amounts still carried over from the earlier card/bank dials: one quiet line until kept or reset.
    const carried = tl.carriedOver ? `<p class="plan-carried" id="plan-carried">${esc(tl.carriedOver.summary)}</p>` : '';
    return `<section class="card plan-dials" id="plan-dials" aria-labelledby="plan-dials-h">
        <div class="plan-card-head"><h2 class="plan-h" id="plan-dials-h" tabindex="-1">Money in and out, a month</h2>${reset}</div>
        ${carried}
        <div class="plan-groups">
          <div class="plan-group" role="group" aria-labelledby="plan-g-in"><h3 class="plan-h plan-h-sub" id="plan-g-in">Money in</h3>${group(tl.groups.in)}${depositsHtml(ctx, tl)}</div>
          <div class="plan-group" role="group" aria-labelledby="plan-g-out"><h3 class="plan-h plan-h-sub" id="plan-g-out">Money out</h3>${group(tl.groups.out)}</div>
        </div>
      </section>`;
  }

  Object.assign(P, { GROUP_NAME, dialLabel, signedDial, dialResetTo, rowResetTo, setupDials, depositsOf, valuesOf, sumOf, dialsCard, txnMap, placeTxns, placeOf, fillTxns, TXN_REASON });
})(typeof globalThis !== 'undefined' ? globalThis : this);
