'use strict';
/*
 * Overview (#/overview): the plan month in three tiles (tl.summary, the figures Edit plan works
 * from), each a button that opens that month's breakdown below the chart (plan/month.js):
 *   Income     money in to the joint accounts (each person, other money in)
 *   Outgoing   money out of them: spending, bills, debt (moves to savings stay inside)
 *   Margin     income − outgoing: what the joint accounts gain or lose in the month; its small line
 *              says how much of it moves to savings (or comes from savings)
 * An amount that is not known says so: never shown as $0.
 */
(function (root) {
  const UI = root.BudgetUI;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const P = UI._plan;
  const { isCents, whole, amt } = P;

  const signedWhole = cents => (cents > 0 ? '+' : '') + whole(cents);

  function tile({ id, label, value, sub = '', tone = '', accent = '', month, part, title }) {
    return `<button type="button" class="kpi kpi-btn${tone ? ' tone-' + tone : ''}${accent ? ' kpi-' + accent : ''}" id="${esc(id)}" data-action="plan:month" data-month="${esc(month)}" data-part="${esc(part)}" aria-label="${esc(title)}">
        <span class="kpi-label">${esc(label)}</span>
        <span class="kpi-value" id="${esc(id)}-value">${esc(value)}</span>
        <span class="kpi-sub" id="${esc(id)}-sub">${esc(sub)}</span>
      </button>`;
  }

  /** The three tiles' figures for a summary: { inCents, outCents, margin, savingsLine }. */
  function figuresOf(s) {
    const inCents = s && isCents(s.inCents) ? s.inCents : null;
    const outCents = s && isCents(s.outCents) ? s.outCents : null;
    const margin = inCents !== null && outCents !== null ? inCents - outCents : null;
    const sav = s && isCents(s.savingsCents) ? s.savingsCents : null;
    const savingsLine = sav === null ? '' : sav > 0 ? `${amt(sav)} of it to savings` : sav < 0 ? `${amt(0 - sav)} from savings` : 'nothing moved to savings';
    return { inCents, outCents, margin, savingsLine };
  }

  function tilesHtml(ctx, tl) {
    const s = tl.summary;
    if (!s) return '';
    const f = figuresOf(s);
    const month = s.month;
    const name = fmt.monthLong(month);
    const unknown = 'Not known yet';
    const list = [
      tile({ id: 'plan-kpi-in', label: 'Income', value: f.inCents === null ? unknown : whole(f.inCents), sub: 'a month', accent: 'in', month, part: 'in', title: `Income in ${name}: ${f.inCents === null ? 'not known yet' : whole(f.inCents)}. Open the breakdown` }),
      tile({ id: 'plan-kpi-out', label: 'Outgoing', value: f.outCents === null ? unknown : whole(f.outCents), sub: 'a month', accent: 'out', month, part: 'out', title: `Outgoing in ${name}: ${f.outCents === null ? 'not known yet' : whole(f.outCents)}. Open the breakdown` }),
      tile({ id: 'plan-kpi-margin', label: 'Margin', value: f.margin === null ? unknown : signedWhole(f.margin), sub: f.savingsLine, tone: f.margin !== null && f.margin < 0 ? 'bad' : '', accent: 'margin', month, part: 'margin', title: `Margin in ${name}, income minus outgoing: ${f.margin === null ? 'not known yet' : signedWhole(f.margin)}${f.savingsLine ? ', ' + f.savingsLine : ''}. Open the breakdown` }),
    ];
    return `<section class="ov-month-tiles" id="plan-kpis" aria-labelledby="plan-kpis-h">
        <h2 class="ov-h" id="plan-kpis-h">${esc(name)} <span class="ov-h-sub">· monthly estimate on this plan</span></h2>
        <div class="plan-kpis kpis-3">${list.join('')}</div>
      </section>`;
  }

  Object.assign(P, { tilesHtml, figuresOf });
})(typeof globalThis !== 'undefined' ? globalThis : this);
