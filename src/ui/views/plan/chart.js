'use strict';
/*
 * Overview (#/overview): the chart card. Two panels stacked on the same months, because a balance
 * (where the money is at a month's end) and money in and out (a flow over a month) are different
 * measures, each with its own axis title:
 *   Balances       each joint cash account's month-end balance (checking, savings) and the
 *                  combined cash; markers above it for accepted planned changes, what Edit plan
 *                  adds after the plan starts, and the month each savings goal is reached
 *   Money in/out   income and outgoing each month, and the net moved to savings (negative: taken
 *                  from savings)
 * Both are UI.chart.cashChart (balance and trends modes): actual months solid, plan months dashed
 * (the plan's monthly estimate). A click, tap or Enter on a month opens its breakdown
 * (chart:select, plan/month.js). Past and Ahead set the months; Export CSV; when the plan goes
 * below $0 a warning says when. Saved choices of the retired Balance/Flows/Trends switch, the
 * Trends lines and hidden legend series stay in ui.plan and are not read here.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const P = UI._plan;
  const { whole, exact, isCents, packOf, shortLabel } = P;

  const PAST = [{ value: 6, label: '6 mo' }, { value: 12, label: '12 mo' }, { value: 'all', label: 'All' }];
  const AHEAD = [{ value: 6, label: '6 mo' }, { value: 12, label: '1 yr' }, { value: 24, label: '2 yr' }, { value: 60, label: '5 yr' }];
  /** Line colours: checking, savings, combined (validated categorical order). */
  const LINE_CLS = { checking: 'series-2', savings: 'series-3', combined: 'series-1' };
  const FLOW_CLS = { in: 'series-1', out: 'series-5', savings: 'series-3' };

  /** The months the chart shows (the Past window to the end of the plan). */
  const fromOf = tl => Math.max(0, tl.window.fromIndex);

  /** A balance line's points for the chart. */
  function pointsOf(list, from, account) {
    return list.slice(from).map(p => ({
      month: p.month, cents: p.cents,
      // 'assumed': the value rests on days no export covers (drawn dotted, never solid). An engine
      // without that status only flags a month-end that falls inside those days (gap).
      status: p.status === 'assumed' ? 'assumed' : p.gap && p.cents !== null ? 'gap' : p.status,
      illustrative: p.illustrative === true,
      note: [p.note ? String(p.note) : '', account && p.anchor && account.anchor ? 'Known balance ' + exact(account.anchor.cents) + ' on ' + fmt.date(account.anchor.date) + '.' : ''].filter(Boolean).join(' '),
    }));
  }

  /** Top panel: each cash account (checking first) and the combined line. */
  function balanceSpec(tl, months, from) {
    const b = tl.balances;
    const lines = [];
    const accounts = b.accounts.slice().sort((x, y) => (x.group === 'checking' ? 0 : 1) - (y.group === 'checking' ? 0 : 1));
    const used = { checking: 0, savings: 0 };
    for (const a of accounts) {
      const group = a.group === 'savings' ? 'savings' : 'checking';
      // A second account of the same kind takes the next free colour.
      const cls = used[group]++ ? undefined : LINE_CLS[group];
      lines.push({ key: 'acct-' + a.id, name: a.name, role: 'account', cls, points: pointsOf(a.points, from, a) });
    }
    if (b.combined) lines.push({ key: 'combined', name: b.mode === 'simple' ? 'Cash' : 'Combined cash', role: 'combined', cls: LINE_CLS.combined, points: pointsOf(b.combined.points, from) });
    return {
      id: 'plan-chart', mode: 'balance', months, todayMonth: tl.todayMonth, planStart: tl.planStart, lines,
      title: 'Balances at the end of each month', tableCaption: 'Balances at the end of each month',
      axisTitle: 'Balance, $ at month end', markers: markersOf(tl), selectable: true,
    };
  }

  /** Bottom panel: income, outgoing and the net moved to savings, each a monthly amount. */
  function flowSpec(tl, months, from) {
    const series = new Map((tl.series || []).map(s => [s.key, s]));
    const vals = key => (series.get(key) ? series.get(key).values.slice(from) : months.map(() => null));
    const to = vals('to-savings'), back = vals('from-savings');
    const net = to.map((v, i) => (isCents(v) && isCents(back[i]) ? v - back[i] : null));
    const list = [
      { key: 'flow-in', name: 'Income', cls: FLOW_CLS.in, unit: 'perMonth', values: vals('in-total') },
      { key: 'flow-out', name: 'Outgoing', cls: FLOW_CLS.out, unit: 'perMonth', values: vals('out-total') },
    ];
    if (net.some(v => isCents(v) && v !== 0)) list.push({ key: 'flow-savings', name: 'Net to savings', cls: FLOW_CLS.savings, unit: 'perMonth', values: net });
    return {
      id: 'plan-flows', mode: 'trends', months, todayMonth: tl.todayMonth, planStart: tl.planStart,
      title: 'Money in and out each month', tableCaption: 'Money in and out each month',
      axisTitle: 'Monthly, $ per month', trends: { series: list, ma: 0, trend: false }, selectable: true,
    };
  }

  /**
   * What the chart marks above the plot: the accepted planned changes with an amount (from the
   * plan start when earlier), what Edit plan adds once the plan is under way (bills that start or
   * end later, goals spent), and the month each savings goal is reached.
   */
  function markersOf(tl) {
    const list = tl.changes.list
      .filter(ch => ch.status === 'applied' && (!ch.readOnly || ch.startMonth > tl.planStart))
      .map(ch => {
        const pack = packOf(ch);
        const group = ch.readOnly ? '' : ch.scenario || (pack ? pack.name : '');
        return { month: ch.startMonth < tl.planStart ? tl.planStart : ch.startMonth, label: shortLabel(ch.label), title: ch.label, cents: ch.cents, kind: ch.kind, pack: group };
      });
    for (const mk of Array.isArray(tl.markers) ? tl.markers : []) {
      if (mk.kind === 'goal') list.push({ month: mk.month, label: shortLabel(String(mk.label).replace(/ reached$/, '')) + ' ✓', title: String(mk.label).replace(/ reached$/, ''), cents: mk.cents, kind: 'goal' });
    }
    return list;
  }

  /** 'Oct 1–2, 2026', 'Sep 29 – Oct 2, 2026', 'Dec 30, 2025 – Jan 2, 2026', or one day. */
  function dayRange(from, to) {
    if (!to || from === to) return fmt.date(from);
    const a = fmt.date(from), b = fmt.date(to);
    if (from.slice(0, 7) === to.slice(0, 7)) return a.replace(/, \d{4}$/, '') + '–' + Number(to.slice(8, 10)) + ', ' + to.slice(0, 4);
    if (from.slice(0, 4) === to.slice(0, 4)) return a.replace(/, \d{4}$/, '') + ' – ' + b;
    return a + ' – ' + b;
  }

  /** The days the balance line is worked across without data (engine: balances.assumed), or null. */
  function assumedOf(tl) {
    const a = tl.balances && tl.balances.assumed;
    const ok = g => g && E.dates.isDate(g.from) && (!g.to || E.dates.isDate(g.to));
    if (!ok(a)) return null;
    const gaps = Array.isArray(a.gaps) ? a.gaps.filter(ok) : [];
    const list = gaps.length ? gaps : [a];
    return { from: a.from, to: a.to || a.from, side: list.length === 1 ? list[0].side || a.side : null, gaps: list };
  }

  /** Dotted caption line: which days are assumed, and how to make the history exact. */
  function assumedLine(as) {
    const spans = as.gaps.map(g => dayRange(g.from, g.to || g.from));
    const across = spans.length > 2 ? spans.slice(0, -1).join(', ') + ' and ' + spans[spans.length - 1] : spans.join(' and ');
    const before = as.gaps.length === 1 && as.side === 'before';
    let fix;
    if (as.gaps.length > 1) fix = 'For exact history, enter each balance as of the last day its export covers, or export through today.';
    else if (before) fix = 'For exact history, enter the balance as of ' + fmt.date(as.to) + ' or export from ' + fmt.date(as.from) + '.';
    else fix = 'For exact history, enter the balance as of ' + fmt.date(E.dates.addDays(as.from, -1)) + ' or export through today.';
    return 'Dotted: worked ' + (before ? 'forward' : 'back') + ' across ' + across + ', which your export does not cover (assumes nothing moved). ' + fix;
  }

  /** The months drawn solid (the data) and dashed (the plan's estimate), for both captions. */
  function solidDashed(tl, lines) {
    const parts = [];
    if (tl.lastComplete) {
      // Months worked across assumed days are dotted: "solid" stops before them.
      let solidTo = tl.lastComplete;
      const main = lines ? lines.find(l => l.role === 'combined') || lines[0] : null;
      if (main && assumedOf(tl)) {
        const solid = main.points.filter(p => p.month <= tl.lastComplete && p.cents !== null && p.status !== 'assumed' && p.status !== 'gap' && p.status !== 'projected');
        const tail = main.points.filter(p => p.month <= tl.lastComplete && p.cents !== null).pop();
        if (tail && tail.status === 'assumed') solidTo = solid.length ? solid[solid.length - 1].month : null;
      }
      if (solidTo) parts.push('Solid: your data through ' + fmt.month(solidTo) + '.');
    }
    parts.push('Dashed: this plan’s monthly estimate from ' + fmt.month(tl.planStart) + '.');
    return parts;
  }

  function balanceCaption(tl, spec) {
    const b = tl.balances;
    const parts = [];
    if (b.mode === 'accounts' && b.accounts.length) parts.push('Combined cash = ' + b.accounts.map(a => a.name).join(' + ') + '.');
    parts.push(...solidDashed(tl, spec.lines));
    const assumed = assumedOf(tl);
    if (assumed) parts.push(assumedLine(assumed));
    if (b.illustrative && spec.lines.some(l => l.role === 'account')) parts.push(String(b.illustrative));
    if (b.mode === 'simple' && b.label) parts.push(b.label + '.');
    return parts.join(' ');
  }

  function flowCaption(tl) {
    return ['Income: everything paid into the joint accounts. Outgoing: spending, bills and debt; money moved to savings is not outgoing.',
      'Net to savings: moved to savings in the month, less what came back from it.'].concat(solidDashed(tl, null)).join(' ');
  }

  /** "Below $0" warnings: the combined cash on this plan, else a checking account (kept apart even when the total is fine). */
  function warningHtml(tl) {
    const b = tl.balances;
    if (b.runsOut || (b.lowest && isCents(b.lowest.cents) && b.lowest.cents < 0)) {
      const when = b.runsOut ? fmt.monthLong(b.runsOut) : fmt.monthLong(b.lowest.month);
      const low = b.lowest && isCents(b.lowest.cents) ? ` Lowest: ${whole(b.lowest.cents)} in ${fmt.month(b.lowest.month)}.` : '';
      return `<div class="ov-warn is-bad" id="plan-warn" role="note"><strong>Cash goes below $0 in ${esc(when)} on this plan.</strong>${esc(low)}</div>`;
    }
    for (const a of b.accounts.filter(x => x.group === 'checking')) {
      const low = a.points.filter(p => p.month >= tl.planStart && isCents(p.cents) && p.cents < 0);
      if (low.length) {
        return `<div class="ov-warn is-warn" id="plan-warn" role="note"><strong>${esc(a.name)} goes below $0 in ${esc(fmt.monthLong(low[0].month))} on this plan,</strong> ${esc('even though combined cash stays above it. Move money from savings, or turn on “cover from savings” in Edit plan.')}</div>`;
      }
    }
    return '';
  }

  function chartCard(ctx, tl) {
    const from = fromOf(tl);
    const months = tl.months.slice(from).map(m => m.month);
    const none = tl.balances.mode === 'none';
    let top;
    if (none) {
      top = `<div class="ov-nobal" id="plan-nobal">${c.empty('No balance is known yet, so there is no balance line.', `<button type="button" class="btn btn-secondary btn-small" id="plan-prompt" data-action="plan:goto-balances">Enter your balances</button>`)}</div>`;
    } else {
      const spec = balanceSpec(tl, months, from);
      top = UI.chart.cashChart(Object.assign(spec, { caption: balanceCaption(tl, spec), captionFold: 'About this chart' }));
    }
    const bottom = UI.chart.cashChart(Object.assign(flowSpec(tl, months, from), { caption: flowCaption(tl), captionFold: 'About this chart' }));
    const ranges = `<div class="plan-ranges">
        ${c.segmented({ label: 'Past', name: 'plan-past', options: PAST, value: tl.settings.past, action: 'plan:past' })}
        ${c.segmented({ label: 'Ahead', name: 'plan-horizon', options: AHEAD, value: tl.settings.horizon, action: 'plan:horizon' })}
        ${c.button('Export CSV', { action: 'plan:export-csv', id: 'plan-export-csv', cls: 'btn-small btn-ghost plan-export' })}
      </div>`;
    return `<section class="card plan-chart-card" id="plan-chart-card" aria-labelledby="plan-chart-h">
        <div class="ov-chart-head"><h2 class="ov-h" id="plan-chart-h">Where you’re heading</h2><p class="ov-hint fine" id="plan-chart-hint">Select a month to see its breakdown.</p></div>
        ${warningHtml(tl)}
        <div class="ov-panel ov-panel-balance">${top}</div>
        <div class="ov-panel ov-panel-flows">${bottom}</div>
        ${ranges}
      </section>`;
  }

  /** The timeline cut to the months the chart shows (for the CSV: one row per month shown). */
  function shownTimeline(tl) {
    const from = fromOf(tl);
    if (!from) return tl;
    const b = tl.balances;
    const cut = list => (Array.isArray(list) ? list.slice(from) : list);
    return Object.assign({}, tl, {
      months: tl.months.slice(from),
      balances: Object.assign({}, b, {
        combined: b.combined ? Object.assign({}, b.combined, { points: cut(b.combined.points), baselinePoints: cut(b.combined.baselinePoints) }) : b.combined,
        accounts: b.accounts.map(a => Object.assign({}, a, { points: cut(a.points) })),
      }),
    });
  }

  Object.assign(P, { chartCard, shownTimeline });
})(typeof globalThis !== 'undefined' ? globalThis : this);
