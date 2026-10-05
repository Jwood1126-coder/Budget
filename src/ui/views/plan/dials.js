'use strict';
/*
 * Plan (#/overview), 3. the dials: money in by person; money out by how adjustable it is
 * (essentials, flexible, irregular, net to savings, other). Essentials and flexible open into
 * categories and places (each can move to the other group), the irregular dial into its one-time
 * costs; "Who paid in" lists the deposits behind money in. The headline adds the dials up.
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
  const SUM_NAME = { essentials: 'essentials', flexible: 'flexible', irregular: 'irregular', other: 'other' };
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

  const signedAmt = cents => (cents > 0 ? '+' : '') + amt(cents);
  const dialLabel = d => (d.group === 'in' && d.key !== 'inOther' ? d.label + ' → joint' : d.label);
  const signedDial = d => d.key === 'savings' || d.key === 'other' || (d.baselineCents || 0) < 0 || (d.planCents || 0) < 0;

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

  function dialHtml(ctx, tl, d) {
    const id = 'plan-dial-' + d.key;
    const label = dialLabel(d);
    const value = isCents(d.planCents) ? d.planCents : null;
    const { lo, hi } = rangeOf(d);
    const base = isCents(d.baselineCents) ? d.baselineCents : null;
    const frac = base === null ? null : Math.min(1, Math.max(0, (base - lo) / (hi - lo || 1)));
    const reset = d.source !== 'baseline' ? c.button('Reset', { action: 'plan:reset-dial', data: { dial: d.key }, cls: 'btn-small dial-reset', id: id + '-reset', ariaLabel: 'Reset ' + label + ' to its baseline' }) : '';
    const set = d.source === 'direct' ? ' · set by you' : d.source === 'rows' ? ' · from the list below' : '';
    const hint = d.group === 'in' ? hintText(d) : '';
    const sub = DIAL_SUB[d.key] || '';
    // A person's money in: from the pay saved in Budget, else the deposit average (not confirmed).
    const person = d.group === 'in' && typeof d.basisKind === 'string';
    const budgetLink = text => `<a class="dial-budget-link" id="${esc(id)}-budget" href="${esc(ctx.href('budget', { section: 'income' }))}">${esc(text)}</a>`;
    let basis = esc(d.basis);
    // An amount carried over from the earlier card/bank dials says so until it is kept or changed.
    if (d.carriedOver) basis = esc(d.carriedOver.note) + ' ' + c.button('Keep', { action: 'plan:keep-carried', variant: 'ghost', data: { dial: d.key }, cls: 'btn-small dial-keep', id: id + '-keep', ariaLabel: 'Keep ' + label + ' at ' + amt(d.planCents) + ' and remove this note' });
    if (person && d.basisKind === 'budget') basis += ' · ' + budgetLink('Change in Budget');
    if (person && d.needsConfirm) {
      const unknown = d.budget && Array.isArray(d.budget.unknown) ? d.budget.unknown : [];
      basis += (/[.!?]$/.test(d.basis) ? '' : '.') + (unknown.length ? ' ' + esc('Budget has no amount for: ' + unknown.join(', ') + '.') : '') + ' Enter the current amount here, or ' + budgetLink('save pay in Budget') + '.';
    }
    const unconfirmed = person && d.needsConfirm ? badgeWithId(id + '-unconfirmed', 'Not confirmed', 'warn') : '';
    const average = person && d.basisKind === 'budget' && isCents(d.averageCents) && isCents(d.budgetCents) && d.averageCents !== d.budgetCents
      ? `<button type="button" class="btn btn-ghost btn-small dial-average" id="${esc(id)}-average" data-action="plan:use-average" data-dial="${esc(d.key)}" title="${esc(tl.baseline.label)}">${esc(`Use the ${tl.baseline.count}-month average (${amt(d.averageCents)})`)}</button>`
      : '';
    const described = [sub ? id + '-sub' : '', id + '-base', id + '-basis', id + '-error'].filter(Boolean).join(' ');
    return `<div class="dial" data-dial="${esc(d.key)}" data-cents="${value === null ? '' : value}">
        <div class="dial-head">
          <span class="dial-title"><label class="dial-label" for="${esc(id)}"><span class="key key-swatch ${esc(DIAL_CLS[d.key] || 'series-muted')}" aria-hidden="true"></span>${esc(label)}</label>${unconfirmed}</span>
          <span class="input-money plan-amount dial-amount"><span aria-hidden="true">$</span><input id="${esc(id)}" type="text" inputmode="${signedDial(d) ? 'text' : 'decimal'}" autocomplete="off" spellcheck="false" value="${esc(inputText(value))}" placeholder="Unknown" data-action="plan:dial" data-commit="1" data-dial="${esc(d.key)}" aria-label="${esc(label)}, dollars a month" aria-describedby="${esc(described)}"></span>
        </div>
        ${sub ? `<p class="dial-sub" id="${esc(id)}-sub">${esc(sub)}</p>` : ''}
        <div class="dial-track"${frac === null ? '' : ` style="--f:${frac.toFixed(4)}"`}>
          ${frac === null ? '' : '<span class="dial-tick" aria-hidden="true"></span>'}
          <input class="dial-range" id="${esc(id)}-range" type="range" min="${lo / 100}" max="${hi / 100}" step="${STEP_CENTS / 100}" value="${(value || 0) / 100}" data-action="plan:dial-range" data-dial="${esc(d.key)}" aria-label="${esc(label)}, dollars a month" aria-valuetext="${esc(amt(value || 0))} a month" aria-describedby="${esc(id)}-base">
        </div>
        <p class="field-error" id="${esc(id)}-error" role="alert" hidden></p>
        <div class="dial-foot"><span class="dial-base" id="${esc(id)}-base">baseline ${esc(base === null ? 'unknown' : amt(base))}${esc(set)}</span><span class="dial-actions">${average}${reset}</span></div>
        <p class="dial-basis" id="${esc(id)}-basis">${basis}</p>
        ${hint ? `<p class="dial-hint" id="${esc(id)}-hint">${esc(hint)}</p>` : ''}
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

  function rowHtml(tl, r, { move = null } = {}) {
    const id = 'plan-row-' + r.id;
    const name = r.label;
    const usual = r.stable && isCents(r.latestCents) ? `usually ${amt(r.latestCents)}` : `avg ${whole(r.avgCents)}/mo`;
    const seen = isCents(r.seenMonths) ? r.seenMonths : r.months;
    const of = isCents(r.ofMonths) ? r.ofMonths : tl.baseline.count;
    const edited = r.override ? ' ' + c.badge('edited', 'info') + ' ' + c.button('Reset', { action: 'plan:row-reset', data: { row: r.id, name }, cls: 'btn-small btn-ghost drill-reset', id: id + '-reset', ariaLabel: 'Reset ' + name + ' to its average' }) : '';
    const pattern = PATTERN[r.pattern] ? `<span class="drill-pattern is-${esc(r.pattern)}" id="${esc(id)}-pattern" title="${esc(PATTERN_TIP[r.pattern])}">${esc(PATTERN[r.pattern])}</span>` : '';
    const paid = PAID[r.paidBy] ? `<span class="drill-paid" id="${esc(id)}-paid" title="${esc(PAID_TIP[r.paidBy])}">${esc(PAID[r.paidBy])}</span>` : '';
    const moved = move && move.moved ? badgeWithId(id + '-moved', 'moved', 'info', { title: move.from ? 'Moved from ' + move.from : 'Moved here by you' }) : '';
    const from = move && move.moved && move.from ? `<span class="drill-from">from ${esc(move.from)}</span>` : '';
    return `<div class="drill-row level-${r.level}${r.included ? '' : ' is-out'}" data-row="${esc(r.id)}">
        <label class="drill-name" for="${esc(id)}-on"><input type="checkbox" id="${esc(id)}-on" data-action="plan:row-include" data-row="${esc(r.id)}" data-name="${esc(name)}"${r.included ? ' checked' : ''}><span>${esc(name)}</span></label>
        <span class="input-money drill-amt"><span aria-hidden="true">$</span><input id="${esc(id)}-amt" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(inputText(r.planCents))}" data-action="plan:row-cents" data-commit="1" data-row="${esc(r.id)}" data-name="${esc(name)}" aria-label="${esc(name)}, dollars a month in the plan" aria-describedby="${esc(id)}-meta ${esc(id)}-error"></span>
        <p class="drill-meta" id="${esc(id)}-meta"><span>${esc(usual)} · ${esc(seen + ' of ' + of + ' mo')}</span>${pattern}${paid}${moved}${from}${edited}${move ? moveControl(r, move) : ''}</p>
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
      const kidHtml = k => rowHtml(tl, k, { move: k.kind === 'merchant' && !cat.synthetic ? { key: E.timeline.MERCHANT_KEY + k.label, name: k.label, moved: false } : null });
      const sub = kids.length && !only
        ? `<details class="drill-kids" id="plan-drillrow-${esc(cat.id)}"><summary>${esc(label)}</summary><div class="drill-kids-body">${kids.map(kidHtml).join('')}</div></details>`
        : '';
      const moved = cat.groupSource === 'override';
      const move = cat.groupKey ? { key: cat.groupKey, name: cat.label, moved, from: cat.synthetic && Array.isArray(cat.movedFrom) ? cat.movedFrom.join(', ') : '' } : null;
      return `<li class="drill-cat">${rowHtml(tl, cat, { move })}${sub}</li>`;
    }).join('');
    const summary = `What’s in this · ${plural(cats.length, 'category', 'categories')} · ${amt(d.planCents)}/mo${baselineNote(d)}`;
    const body = `${notice}<ul class="drill-list">${list}</ul>
      <p class="fine">Untick what you would stop paying for, or type a new amount: the dial follows the rows. “Move to …” puts a category or a place in the other group; the total stays the same.</p>`;
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
      return `<li class="drill-row irr-row${i.included ? '' : ' is-out'}" data-txn="${esc(i.id)}">
          <label class="drill-name" for="${esc(id)}-on"><input type="checkbox" id="${esc(id)}-on" data-action="plan:irregular" data-txn="${esc(i.id)}" data-name="${esc(i.label)}"${i.included ? ' checked' : ''} aria-describedby="${esc(id)}-meta"><span>${esc(what)}</span></label>
          <span class="irr-monthly" id="${esc(id)}-monthly">${esc(amt(i.monthlyCents))}/mo</span>
          <p class="drill-meta" id="${esc(id)}-meta"><span>${esc(i.included ? 'in the allowance' : 'left out by you')}${i.category ? ' · ' + esc(i.category) : ''}</span><span class="drill-paid" title="${esc(PAID_TIP[i.paidBy] || '')}">${esc(PAID[i.paidBy] || '')}</span>${c.button('Count as regular', { action: 'plan:irregular-regular', data: { txn: i.id, name: i.label }, cls: 'btn-small btn-ghost drill-move', id: id + '-regular', ariaLabel: `Count ${i.label} on ${fmt.date(i.date)} as regular spending in ${i.category || 'its category'}` })}</p>
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
    const body = `<p class="fine">Deposits into joint, ${esc(range)}. Suggested matches come from the pay in Budget or the amount: the bank’s words don’t name the person. Changing one moves it between the dials above; the bank’s description is kept.</p>${confirm}${table}`;
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
    const inTotal = inKeys.reduce((s, k) => s + vals[k], 0);
    const terms = [[1, inTotal, 'in']].concat(outKeys.map(k => [-1, vals[k], SUM_NAME[k] || k]));
    const combined = terms.reduce((s, [sign, v]) => s + sign * v, 0);
    const words = terms.map(([sign, v, name], i) => {
      const op = (sign < 0) !== (v < 0) ? '−' : '+';
      const text = amt(Math.abs(v)) + ' ' + name;
      return i === 0 ? (v < 0 ? '−' : '') + text : op + ' ' + text;
    });
    const sav = tl.dialsByKey.savings ? vals.savings : 0;
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
    const reset = tl.changed && tl.changedBy.dials ? c.button('Reset all to baseline', { action: 'plan:reset', id: 'plan-reset', cls: 'btn-small' }) : '';
    return `<section class="card plan-dials" id="plan-dials" aria-label="Plan dials">
        <div class="plan-groups">
          <div class="plan-group" role="group" aria-labelledby="plan-g-in"><h2 class="plan-h" id="plan-g-in">Money in</h2>${group(tl.groups.in)}${depositsHtml(ctx, tl)}</div>
          <div class="plan-group" role="group" aria-labelledby="plan-g-out"><h2 class="plan-h" id="plan-g-out">Money out</h2>${group(tl.groups.out)}</div>
        </div>
        <div class="plan-sum-row"><div class="plan-sum" id="plan-sum">${sumOf(tl, valuesOf(tl)).html}</div>${reset}</div>
      </section>`;
  }

  Object.assign(P, { GROUP_NAME, dialLabel, signedDial, depositsOf, valuesOf, sumOf, dialsCard });
})(typeof globalThis !== 'undefined' ? globalThis : this);
