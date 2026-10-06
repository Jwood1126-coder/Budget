'use strict';
/*
 * Overview (#/overview): one month's breakdown, shown on demand under the chart (a month chosen on
 * either panel, or one of the plan month's tiles; the route's ?month=YYYY-MM keeps it on a reload).
 *   The month's income, outgoing and margin, and what moved to or from savings.
 *   Money in by person. Outgoing by group (Essentials, Flexible, Irregular, Debt & business,
 *   Investing), each opening into its categories:
 *     actual months   what was spent in each category (the joint accounts' purchases; one-time
 *                     costs under Irregular), each category linking to Spending for its places
 *                     and transactions
 *     plan months     the plan's category amounts (Edit plan's rows) and the planned changes that
 *                     month; the plan month itself adds what has been spent so far
 * Changing an amount happens in Edit plan (linked).
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const P = UI._plan;
  const { isCents, whole, plural } = P;

  const GROUPS = [['essentials', 'Essentials'], ['flexible', 'Flexible'], ['irregular', 'Irregular'], ['other', 'Debt & business'], ['invest', 'Investing']];
  const SPEND_GROUPS = ['essentials', 'flexible'];
  const signedWhole = cents => (cents > 0 ? '+' : '') + whole(cents);
  const money = v => (isCents(v) ? whole(v) : 'Not known');

  /**
   * Purchases in `month` on the joint accounts by key: 'c:<category>' (split purchases by their
   * parts) or 'm:<place>' for a place moved to a group as a whole. One-time costs (`skip`, the
   * month's one-offs: Irregular) are left out; refunds count against their category.
   */
  function categorySpend(ctx, tl, month, skipIds) {
    const out = new Map();
    const skip = new Set(skipIds || []);
    const groups = (tl.settings && tl.settings.groups) || {};
    const add = (k, v) => out.set(k, (out.get(k) || 0) + v);
    for (const t of E.ledger.filter(ctx.realTxns || ctx.txns, { months: [month], scope: 'joint' })) {
      if (t.kind !== 'spend' || t.accountType === 'investment' || skip.has(t.id)) continue;
      const parts = E.ledger.partsOf(t);
      const place = String(t.merchant || t.description || '').trim();
      const moved = groups['merchant:' + place];
      if (moved === 'essentials' || moved === 'flexible') { add('m:' + place, parts.reduce((s, p) => s + p.spendCents, 0)); continue; }
      for (const p of parts) add('c:' + p.category, p.spendCents);
    }
    return out;
  }

  /**
   * The keys a level-1 drill row holds purchases under (see categorySpend). An aggregate budget's
   * row (the migrated energy one) also holds its members' purchases (`covers`: they plan at $0).
   */
  function rowKeys(r) {
    if (r.synthetic) return ['m:' + String(r.merchant || r.label).trim()];
    if (Array.isArray(r.covers) && r.covers.length) return [r.category].concat(r.covers).map(cat => 'c:' + cat);
    if (Array.isArray(r.members) && r.members.length) return r.members.map(cat => 'c:' + cat);
    return ['c:' + r.category];
  }

  /** The plan's category rows of a spending group: { label, category, keys, planCents }. */
  function planRows(tl, key) {
    const d = tl.dialsByKey[key];
    if (!d || !d.drill || d.drill.kind !== 'categories') return [];
    return d.drill.rows.filter(r => r.level === 1 && r.included !== false)
      .map(r => ({ label: r.label, category: r.synthetic ? null : r.category, keys: rowKeys(r), planCents: r.planCents }))
      // Aggregate rows first, so their members' purchases are counted once, against them.
      .sort((a, b) => b.keys.length - a.keys.length);
  }

  /** One line: a name, an optional link, the amount and, so far, "of $X". */
  function line({ label, cents, of = null, href = '', title = '', cls = '' }) {
    const name = href ? `<a href="${esc(href)}" title="${esc(title)}">${esc(label)}</a>` : esc(label);
    return `<li class="ov-mline${cls ? ' ' + cls : ''}"><span class="ov-mline-name">${name}</span> <span class="ov-mline-amt num">${esc(money(cents))}${of !== null ? `<span class="ov-mline-of"> of ${esc(whole(of))}</span>` : ''}</span></li>`;
  }

  /** Categories in a spending group: actual spending (with Spending links), or the plan's rows (with so far). */
  function groupBody(ctx, tl, m, key, mode, spend) {
    const rows = [];
    const spendingHref = cat => ctx.href('spending', { period: m.month, cat });
    if (mode === 'actual') {
      if (key === 'irregular') {
        for (const o of (m.oneOffs || []).filter(x => isCents(x.cents) && x.cents).sort((a, b) => b.cents - a.cents)) {
          rows.push(line({ label: (o.label || o.merchant || 'One-time cost') + (o.date ? ' · ' + fmt.date(o.date).replace(/, \d{4}$/, '') : ''), cents: o.cents }));
        }
        return rows;
      }
      // The plan's rows say which categories belong to the group; what they hold is this month's spending.
      for (const r of planRows(tl, key)) {
        const cents = r.keys.reduce((s, k) => s + (spend.get(k) || 0), 0);
        r.keys.forEach(k => spend.delete(k));
        if (cents) rows.push({ cents, html: line({ label: r.label, cents, href: r.category ? spendingHref(r.category) : '', title: 'Places and transactions in Spending' }) });
      }
      return rows.sort((a, b) => b.cents - a.cents).map(x => x.html);
    }
    // A plan month: the plan's amounts, and what was spent so far in the plan month itself.
    if (SPEND_GROUPS.includes(key)) {
      const list = planRows(tl, key).filter(r => isCents(r.planCents) && r.planCents);
      for (const r of list.sort((a, b) => b.planCents - a.planCents)) {
        const so = spend ? r.keys.reduce((s, k) => s + (spend.get(k) || 0), 0) : null;
        rows.push(so === null ? line({ label: r.label, cents: r.planCents }) : line({ label: r.label, cents: so, of: r.planCents, cls: so > r.planCents ? 'is-over' : '' }));
      }
    } else if (key === 'irregular' && tl.dialsByKey.irregular && isCents(tl.dialsByKey.irregular.planCents) && tl.dialsByKey.irregular.planCents) {
      rows.push(line({ label: 'One-time costs, spread per month', cents: tl.dialsByKey.irregular.planCents }));
    }
    for (const ch of (m.changesApplied || []).filter(x => (x.group === key || (key === 'other' && x.group === 'debt')) && isCents(x.cents))) {
      rows.push(line({ label: ch.label, cents: ch.cents, cls: 'is-change' }));
    }
    return rows;
  }

  function monthHtml(ctx, tl, month) {
    const m = month && tl.months.find(x => x.month === month);
    if (!m) return '';
    const so = m.month === tl.planStart && m.actualSoFar ? m.actualSoFar : null;
    const mode = m.status === 'actual' ? 'actual' : 'plan';
    const name = fmt.monthLong(m.month);
    let badge;
    if (mode === 'actual') badge = m.complete ? c.badge('Actual', 'neutral') : c.badge('Not every account covers this month', 'warn');
    else badge = c.badge('Plan · monthly estimate', 'info');
    const inC = m.in && isCents(m.in.total) ? m.in.total : null;
    const outC = m.out && isCents(m.out.total) ? m.out.total : null;
    const margin = inC !== null && outC !== null ? inC - outC : null;
    const sav = isCents(m.savings) ? m.savings : null;
    const savLine = sav === null || !sav ? '' : sav > 0 ? `${whole(sav)} moved to savings` : `${whole(0 - sav)} taken from savings`;
    const figs = `<div class="ov-mfigs">
        <p class="ov-mfig"><span>Income</span><strong class="num" id="plan-month-in">${esc(money(inC))}</strong></p>
        <p class="ov-mfig"><span>Outgoing</span><strong class="num" id="plan-month-out">${esc(money(outC))}</strong></p>
        <p class="ov-mfig${margin !== null && margin < 0 ? ' tone-bad' : ''}"><span>Margin</span><strong class="num" id="plan-month-margin">${esc(margin === null ? 'Not known' : signedWhole(margin))}</strong></p>
      </div>${savLine ? `<p class="ov-msav fine" id="plan-month-savings">${esc(savLine)}</p>` : ''}`;
    // Money in by person, and other money in.
    const people = tl.people.map(p => line({ label: p.name, cents: m.in ? m.in[p.id] : null }));
    const other = m.in ? [m.in.unassigned, m.in.other].filter(isCents).reduce((s, v) => s + v, 0) : 0;
    if (other) people.push(line({ label: 'Other money in', cents: other }));
    // Spending by category: this month's (actual), or so far in the plan month.
    const spend = mode === 'actual' ? categorySpend(ctx, tl, m.month, (m.oneOffs || []).map(o => o.id))
      : so ? categorySpend(ctx, tl, m.month, (so.oneOffs || []).map(o => o.id)) : null;
    const groups = GROUPS.map(([key, label]) => {
      const cents = m.out ? m.out[key] : null;
      const body = groupBody(ctx, tl, m, key, mode, spend);
      if (!isCents(cents) || (!cents && !body.length)) return '';
      const soFar = so && so.out && isCents(so.out[key]) ? `<span class="ov-mline-of">${esc(whole(so.out[key]))} so far · </span>` : '';
      const head = `<span class="ov-mline-name">${esc(label)}</span> <span class="ov-mline-amt num">${soFar}${esc(whole(cents))}</span>`;
      if (!body.length) return `<li class="ov-mgroup"><div class="ov-mline ov-mgroup-head">${head}</div></li>`;
      return `<li class="ov-mgroup"><details class="ov-mgroup-details" id="plan-month-grp-${esc(key)}"><summary class="ov-mline ov-mgroup-head">${head}</summary><ul class="ov-mlist ov-mcats">${body.join('')}</ul></details></li>`;
    }).join('');
    const rest = mode === 'actual' && spend ? [...spend.values()].reduce((s, v) => s + v, 0) : 0;
    const restLine = Math.abs(rest) >= 100 ? `<p class="fine ov-mrest">${esc(whole(rest))} of spending is in categories the plan does not list.</p>` : '';
    const link = mode === 'actual'
      ? `<a href="${esc(ctx.href('spending', { period: m.month }))}" id="plan-month-more">Places and transactions in Spending →</a>`
      : `<a href="${esc(ctx.href('budget', { focus: 'plan-dials-h' }))}" id="plan-month-more">Change these amounts in Edit plan →</a>`;
    const soLine = so && Number.isFinite(so.coveredDays) ? `<p class="fine ov-mso" id="plan-month-sofar">${esc(`So far: your data covers ${plural(so.coveredDays, 'day')} of ${so.totalDays}.`)}</p>` : '';
    return `<section class="card ov-month" id="plan-month" data-month="${esc(m.month)}" aria-labelledby="plan-month-h">
        <div class="ov-month-head">
          <h2 class="ov-h" id="plan-month-h" tabindex="-1">${esc(name)} ${badge}</h2>
          <button type="button" class="btn btn-ghost btn-small ov-month-close" id="plan-month-close" data-action="plan:month" data-month="" aria-label="${esc('Close the breakdown of ' + name)}">✕</button>
        </div>
        ${figs}${soLine}
        <div class="ov-mcols">
          <div class="ov-mcol"><h3 class="ov-mh">Money in</h3><ul class="ov-mlist" id="plan-month-inlist">${people.join('')}</ul></div>
          <div class="ov-mcol"><h3 class="ov-mh">Outgoing</h3><ul class="ov-mlist" id="plan-month-outlist">${groups}</ul>${restLine}</div>
        </div>
        <p class="ov-mmore">${link}</p>
      </section>`;
  }

  /**
   * Show (or, with no month, close) a month's breakdown in place: the chart is not redrawn, so a
   * readout open on a phone stays. The address keeps the month (?month=) for a reload.
   */
  function showMonth(ctx, month, { focus = false, scroll = false } = {}) {
    const box = document.getElementById('plan-month-box');
    if (!box) return;
    const tl = P.model(ctx);
    const valid = month && tl.months.some(x => x.month === month) ? month : '';
    box.innerHTML = valid ? monthHtml(ctx, tl, valid) : '';
    try {
      const params = Object.assign({}, ctx.route.params, { month: valid || undefined });
      root.history.replaceState(null, '', ctx.href('overview', params));
      ctx.route.params = params;
    } catch { /* the breakdown still shows */ }
    if (valid && (focus || scroll)) {
      const h = document.getElementById('plan-month-h');
      if (h && focus) h.focus({ preventScroll: true });
      if (h) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (!valid && focus) {
      const plot = document.querySelector('#plan-chart-plot, #plan-flows-plot');
      if (plot) plot.focus({ preventScroll: true });
    }
  }

  Object.assign(P, { monthHtml, showMonth });
})(typeof globalThis !== 'undefined' ? globalThis : this);
