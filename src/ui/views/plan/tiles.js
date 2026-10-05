'use strict';
/*
 * Plan (#/overview), 0. the numbers above the chart: one tile each, a big number, a short label and
 * at most one small line under it.
 *   Monthly on this plan   what all the joint accounts gain or lose a month (money in − money out,
 *                          the headline under the dials; moves to and from savings stay inside)
 *   Cash in 12 months      the combined line at the end of the 12th plan month (or the last plan
 *                          month when the plan is shorter), and how far that is from now
 *   Savings                the savings accounts now → then (only with a savings account)
 *   Investments            the investment line now → then (only with one; never cash)
 *   Lowest point           only when the combined line goes below $0: how low, and when
 * "Now" is the last month of the data (the month before the plan starts).
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const P = UI._plan;
  const { isCents, whole, amt, compact } = P;

  const signedWhole = cents => (cents > 0 ? '+' : '') + whole(cents);

  /** The months the tiles compare: now (the month before the plan) and then (12 plan months on, or the plan's end). */
  function spanOf(tl) {
    const n = Math.min(12, tl.horizon);
    return { n, now: E.months.add(tl.planStart, -1), then: E.months.add(tl.planStart, n - 1) };
  }
  /** A line's value in a month (null when unknown or not in the timeline). */
  function at(points, month) {
    const p = (points || []).find(x => x.month === month);
    return p && isCents(p.cents) ? p.cents : null;
  }
  /** Several lines added up in a month (null when any is unknown). */
  function sumAt(lines, month) {
    const vals = lines.map(l => at(l.points, month));
    return vals.length && vals.every(isCents) ? vals.reduce((s, v) => s + v, 0) : null;
  }

  function tile({ id, label, value, sub = '', tone = '', accent = '', title = '' }) {
    return `<div class="kpi${tone ? ' tone-' + tone : ''}${accent ? ' kpi-' + accent : ''}" id="${esc(id)}"${title ? ` title="${esc(title)}"` : ''}>
        <p class="kpi-label">${esc(label)}</p>
        <p class="kpi-value" id="${esc(id)}-value">${value}</p>
        <p class="kpi-sub" id="${esc(id)}-sub">${sub}</p>
      </div>`;
  }
  /** "$12.4k → $18k": now, small and muted, then the value it becomes. */
  const fromTo = (a, b) => `<span class="kpi-from">${esc(compact(a))}</span><span class="kpi-arrow" aria-hidden="true">→</span><span class="sr-only"> to </span>${esc(compact(b))}`;

  /** The monthly tile's value and line for dial values `vals` (the slider being dragged follows at once). */
  function monthParts(tl, vals) {
    const sum = P.sumOf(tl, vals);
    const cents = isCents(sum.combined) ? sum.combined : null;
    const sav = tl.dialsByKey.savings ? vals.savings : 0;
    const sub = !isCents(sav) || !sav ? '' : sav > 0 ? `${amt(sav)} a month to savings` : `${amt(0 - sav)} a month from savings`;
    return { value: cents === null ? 'Not known yet' : signedWhole(cents), sub, tone: cents !== null && cents < 0 ? 'warn' : '' };
  }

  function tilesHtml(ctx, tl) {
    const b = tl.balances;
    const { n, now, then } = spanOf(tl);
    const inN = n === 12 ? 'in 12 months' : `in ${n} months`;
    const list = [];
    const m = monthParts(tl, P.valuesOf(tl));
    list.push(tile({ id: 'plan-kpi-month', label: 'Monthly on this plan', value: esc(m.value), sub: esc(m.sub), tone: m.tone, accent: 'brand', title: 'Money in − money out, all joint accounts' }));
    const combined = b.combined ? b.combined.points : null;
    const cashThen = combined ? at(combined, then) : null;
    if (cashThen !== null) {
      const cashNow = at(combined, now);
      const delta = cashNow === null ? '' : `${esc(signedWhole(cashThen - cashNow))} from now`;
      list.push(tile({ id: 'plan-kpi-cash', label: 'Cash ' + inN, value: esc(whole(cashThen)), sub: delta, tone: cashThen < 0 ? 'bad' : '', accent: 'combined', title: 'Combined cash in the joint accounts at the end of ' + fmt.monthLong(then) }));
    }
    const savings = b.accounts.filter(a => a.group === 'savings');
    const savNow = savings.length ? sumAt(savings, now) : null, savThen = savings.length ? sumAt(savings, then) : null;
    if (savNow !== null && savThen !== null) {
      list.push(tile({ id: 'plan-kpi-savings', label: 'Savings', value: fromTo(savNow, savThen), sub: esc('now → ' + inN), accent: 'savings', title: `Savings: ${whole(savNow)} now, ${whole(savThen)} at the end of ${fmt.monthLong(then)}` }));
    }
    const inv = b.investments;
    const invNow = inv ? at(inv.points, now) : null, invThen = inv ? at(inv.points, then) : null;
    if (inv && (invNow !== null || invThen !== null)) {
      const illustrative = inv.points.some(p => p.status === 'illustrative' && p.month <= then);
      list.push(tile({ id: 'plan-kpi-invest', label: 'Investments', value: invNow !== null && invThen !== null ? fromTo(invNow, invThen) : esc(compact(invThen !== null ? invThen : invNow)), sub: illustrative ? 'illustrative growth' : 'not cash', accent: 'invest', title: 'Investments are not cash' + (invThen !== null ? `: ${whole(invThen)} at the end of ${fmt.monthLong(then)}` : '') }));
    }
    if (b.runsOut || (b.lowest && isCents(b.lowest.cents) && b.lowest.cents < 0)) {
      const sub = b.runsOut ? 'below $0 from ' + fmt.month(b.runsOut) : 'in ' + fmt.month(b.lowest.month);
      list.push(tile({ id: 'plan-kpi-low', label: 'Lowest point', value: esc(b.lowest ? whole(b.lowest.cents) : 'Below $0'), sub: esc(sub), tone: 'bad', accent: 'bad', title: 'On this plan the combined cash goes below $0' + (b.runsOut ? ' in ' + fmt.monthLong(b.runsOut) : '') }));
    }
    return `<section class="plan-kpis kpis-${list.length}" id="plan-kpis" aria-label="This plan in numbers">${list.join('')}</section>`;
  }

  /** While a slider is dragged: the monthly tile follows (nothing saved yet). */
  function updateMonthTile(rootEl, tl, vals) {
    const box = rootEl.querySelector('#plan-kpi-month');
    if (!box) return;
    const m = monthParts(tl, vals);
    box.querySelector('#plan-kpi-month-value').textContent = m.value;
    box.classList.toggle('tone-warn', m.tone === 'warn');
    box.querySelector('#plan-kpi-month-sub').textContent = m.sub;
  }

  Object.assign(P, { tilesHtml, updateMonthTile });
})(typeof globalThis !== 'undefined' ? globalThis : this);
