'use strict';
/*
 * Budget 1. "<Month> plan": where each dollar of the plan month goes (tl.summary, the numbers the
 * Plan screen's tiles use). Two bars of the same length: money in (each person, other money in, and
 * money drawn from savings or investments) over money out (spending groups, savings, investing,
 * left over). The headline is what the cash accounts move by in the month (in − out, the Plan's
 * combined line). The legend under the bars is the text version: every segment with its amount.
 */
(function (root) {
  const UI = root.BudgetUI;
  const { esc } = UI.dom;
  const B = UI._budget;
  const { whole, signedWhole, dollarFlow, monthName } = B;

  /** Segments narrower than this share of the bar carry no text (the legend names them). */
  const pctText = share => (share >= 0.995 ? '100%' : share < 0.01 ? '<1%' : Math.round(share * 100) + '%');

  function bar(list, side) {
    return `<div class="bud-flow-bar" data-side="${side}">${list.map(x => `<span class="bud-seg bud-seg-${esc(x.cls)}${x.draw ? ' is-draw' : ''}${x.warn ? ' is-warn' : ''}" style="flex-grow:${(x.share * 1000).toFixed(2)}" data-key="${esc(x.key)}" title="${esc(x.label + ': ' + whole(x.cents))}">
        <span class="bud-seg-text"><span class="bud-seg-label">${esc(x.label)}</span><span class="bud-seg-amt">${esc(whole(x.cents))}</span></span>
      </span>`).join('')}</div>`;
  }

  function legend(list, id, title) {
    return `<div class="bud-legend-col" aria-labelledby="${id}-h">
      <h3 id="${id}-h" class="bud-legend-h">${esc(title)}</h3>
      <ul class="bud-legend" id="${id}">${list.map(x => `<li class="bud-legend-item${x.warn ? ' is-warn' : ''}" data-key="${esc(x.key)}">
          <span class="bud-swatch bud-seg-${esc(x.cls)}${x.draw ? ' is-draw' : ''}${x.warn ? ' is-warn' : ''}" aria-hidden="true"></span>
          <span class="bud-legend-label">${esc(x.label)}</span>
          <span class="bud-legend-amt num">${esc(whole(x.cents))}</span>
          <span class="bud-legend-pct num" aria-hidden="true">${esc(pctText(x.share))}</span>
        </li>`).join('')}</ul>
    </div>`;
  }

  function heroCard(ctx, tl) {
    const flow = tl ? dollarFlow(tl.summary, tl.people) : null;
    if (!flow) return '';
    const net = flow.netCents;
    const tone = net < 0 ? 'bad' : 'good';
    const chips = [];
    if (flow.toSavingsCents) chips.push(`<span class="bud-chip bud-chip-savings"><b>${esc(whole(flow.toSavingsCents))}</b> to savings</span>`);
    if (flow.investingCents > 0) chips.push(`<span class="bud-chip bud-chip-invest"><b>${esc(whole(flow.investingCents))}</b> to investments</span>`);
    if (flow.fromSavingsCents) chips.push(`<span class="bud-chip bud-chip-draw"><b>${esc(whole(flow.fromSavingsCents))}</b> from savings</span>`);
    chips.push(flow.leftCents >= 0
      ? `<span class="bud-chip bud-chip-left"><b>${esc(whole(flow.leftCents))}</b> left in checking</span>`
      : `<span class="bud-chip bud-chip-short"><b>${esc(whole(-flow.leftCents))}</b> short in checking</span>`);
    const inTotal = flow.inSide.filter(x => x.key !== 'short').reduce((s, x) => s + x.cents, 0);
    const outTotal = flow.outSide.filter(x => x.key !== 'left').reduce((s, x) => s + x.cents, 0);
    const caption = `${monthName(flow.month)} plan, joint accounts. Money in ${whole(inTotal)}: ${flow.inSide.map(x => `${x.label} ${whole(x.cents)}`).join(', ')}. Money out ${whole(outTotal)}: ${flow.outSide.map(x => `${x.label} ${whole(x.cents)}`).join(', ')}. Cash accounts ${net < 0 ? 'go down' : 'go up'} by ${whole(Math.abs(net))} a month.`;
    return `<section class="card bud-hero" id="bud-hero" aria-labelledby="bud-hero-h">
      <div class="bud-hero-head">
        <div class="bud-hero-title">
          <h2 id="bud-hero-h">Where each dollar goes</h2>
          <p class="bud-hero-sub">A month on your plan · joint accounts</p>
        </div>
        <div class="bud-hero-net tone-${tone}" id="bud-net">
          <span class="bud-hero-net-value num">${esc(signedWhole(net))}</span>
          <span class="bud-hero-net-label">a month on this plan</span>
        </div>
      </div>
      <figure class="bud-flow" id="bud-flow">
        <div class="bud-flow-row" aria-hidden="true"><span class="bud-flow-tag">In<b class="num">${esc(whole(inTotal))}</b></span>${bar(flow.inSide, 'in')}</div>
        <div class="bud-flow-row" aria-hidden="true"><span class="bud-flow-tag">Out<b class="num">${esc(whole(outTotal))}</b></span>${bar(flow.outSide, 'out')}</div>
        <figcaption class="sr-only">${esc(caption)}</figcaption>
      </figure>
      <div class="bud-hero-chips">${chips.join('')}</div>
      <div class="bud-legends">${legend(flow.inSide, 'bud-legend-in', 'Money in')}${legend(flow.outSide, 'bud-legend-out', 'Where it goes')}</div>
    </section>`;
  }

  Object.assign(B, { heroCard });
})(typeof globalThis !== 'undefined' ? globalThis : this);
