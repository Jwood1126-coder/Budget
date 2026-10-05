'use strict';
/*
 * Plan (#/overview), 1. the chart card: one chart in three modes on one timeline (Balance: the
 * combined cash and each account at month end; Flows: money in and out each month; Trends: the
 * monthly series and month-end balances picked, with an average and a trend line, the y-axis
 * saying which kind it shows), Past and Ahead, Export CSV. Shared helpers come from
 * BudgetUI._plan (plan/common.js).
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const P = UI._plan;
  const { DIAL_CLS, whole, exact } = P;

  const MODES = [{ value: 'balance', label: 'Balance' }, { value: 'flows', label: 'Flows' }, { value: 'trends', label: 'Trends' }];
  const PAST = [{ value: 6, label: '6 mo' }, { value: 12, label: '12 mo' }, { value: 'all', label: 'All' }];
  const AHEAD = [{ value: 6, label: '6 mo' }, { value: 12, label: '1 yr' }, { value: 24, label: '2 yr' }, { value: 60, label: '5 yr' }];
  const TREND_MA = [{ value: 0, label: 'Off' }, { value: 3, label: '3 mo' }, { value: 6, label: '6 mo' }];
  const SERIES_GROUPS = [['in', 'In'], ['out', 'Out'], ['savings', 'Savings'], ['net', 'Net'], ['balances', 'Balances']];
  // Trends colours: a preferred colour per series (the dial's own where there is one), then the
  // first free one, in the order the household picked them, so adding a line never recolours another.
  const TREND_CLS = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6'];
  const TREND_PREF = { 'in-p1': 'series-1', 'in-p2': 'series-2', card: 'series-1', bank: 'series-2', essentials: 'series-5', flexible: 'series-4', irregular: 'series-6', 'to-savings': 'series-3', 'from-savings': 'series-3' };

  /** Without any known balance there is no balance line to draw: show the flows (or trends) instead. */
  const modeOf = tl => (tl.balances.mode === 'none' && tl.settings.mode === 'balance' ? 'flows' : tl.settings.mode);

  /**
   * Series switched off in the chart. Never chosen (null): the checking account lines are off, the
   * savings ones show with the combined line. Once a legend chip is pressed the whole choice is saved.
   */
  function hiddenOf(ctx, tl) {
    const raw = ctx.state.ui && ctx.state.ui.plan ? ctx.state.ui.plan.hidden : null;
    if (Array.isArray(raw)) return raw;
    return tl.balances.accounts.filter(a => a.group === 'checking').map(a => 'acct-' + a.id);
  }

  /** The months the chart shows (the Past window to the end of the plan). */
  const fromOf = tl => Math.max(0, tl.window.fromIndex);

  /** The Trends series picked, in the order they were picked (unknown keys dropped; never empty). */
  function pickedOf(tl) {
    const known = new Set(tl.series.map(s => s.key));
    const list = (tl.settings.trends && Array.isArray(tl.settings.trends.series) ? tl.settings.trends.series : []).filter(k => known.has(k));
    if (list.length) return list;
    return known.has('card') ? ['card'] : tl.series.slice(0, 1).map(s => s.key);
  }

  /** A balance series (a month-end level, not a monthly amount). An engine without `kind` has amounts only. */
  const isBalanceSeries = s => s.kind === 'balance' || s.group === 'balances';
  /** What the picked Trends lines measure: 'flows' (monthly amounts), 'balances' (month-end levels) or 'mixed'. */
  function trendUnits(tl) {
    const on = new Set(pickedOf(tl));
    const picked = tl.series.filter(s => on.has(s.key));
    const balances = picked.filter(isBalanceSeries).length;
    return !balances ? 'flows' : balances === picked.length ? 'balances' : 'mixed';
  }
  /** The Trends y-axis title for what the picked lines measure. */
  const TREND_AXIS = { flows: 'Monthly, $ per month', balances: '$ at month end', mixed: '$ — monthly amounts and month-end balances' };

  /** Colour per picked series: its preferred colour unless taken, else the first free one. */
  function trendColours(picked) {
    const used = new Set();
    const out = {};
    for (const key of picked) {
      let cls = TREND_PREF[key];
      if (!cls || used.has(cls)) cls = TREND_CLS.find(x => !used.has(x)) || 'series-muted';
      used.add(cls);
      out[key] = cls;
    }
    return out;
  }

  // ------------------------------------------------------------------ 1. the chart
  function chartSpec(ctx, tl) {
    const from = fromOf(tl);
    const rows = tl.months.slice(from);
    const months = rows.map(m => m.month);
    const mode = modeOf(tl);
    const TITLE = { balance: 'Joint cash at the end of each month', flows: 'Money in and out of joint each month', trends: 'Monthly amounts over time' };
    const spec = {
      id: 'plan-chart', mode, months, todayMonth: tl.todayMonth, planStart: tl.planStart,
      hidden: mode === 'trends' ? [] : hiddenOf(ctx, tl),
      title: TITLE[mode], titleHidden: UI.chart.isNarrow(), tableCaption: TITLE[mode],
      // Accepted planned changes, marked on the bottom edge in every mode (from the plan start when earlier).
      markers: tl.changes.list.filter(ch => ch.status === 'applied')
        .map(ch => ({ month: ch.startMonth < tl.planStart ? tl.planStart : ch.startMonth, label: ch.label, cents: ch.cents, kind: ch.kind })),
    };
    if (mode === 'balance') {
      const b = tl.balances;
      const points = (list, account) => list.slice(from).map(p => ({
        month: p.month, cents: p.cents,
        // 'assumed': the value rests on days no export covers (drawn dotted, never solid). An engine
        // without that status only flags a month-end that falls inside those days (gap).
        status: p.status === 'assumed' ? 'assumed' : p.gap && p.cents !== null ? 'gap' : p.status,
        illustrative: p.illustrative === true,
        note: [p.note ? String(p.note) : '', account && p.anchor && account.anchor ? 'Known balance ' + exact(account.anchor.cents) + ' on ' + fmt.date(account.anchor.date) + '.' : ''].filter(Boolean).join(' '),
      }));
      spec.lines = [];
      if (b.combined) spec.lines.push({ key: 'combined', name: 'Combined cash', role: 'combined', points: points(b.combined.points) });
      for (const a of b.accounts) spec.lines.push({ key: 'acct-' + a.id, name: a.name, role: 'account', points: points(a.points, a) });
      // The plan at baseline (no dial moved, no planned change): a faint line to compare with.
      const ghost = tl.changed && b.combined && Array.isArray(b.combined.baselinePoints) ? b.combined.baselinePoints : null;
      if (ghost) spec.lines.push({ key: 'ghost', name: 'Baseline plan', role: 'ghost', points: ghost.slice(from).map((cents, i) => ({ month: months[i], cents, status: cents === null ? null : 'projected' })) });
    } else if (mode === 'flows') {
      const known = (...vals) => (vals.some(v => v === null || v === undefined) ? null : vals.reduce((s, v) => s + v, 0));
      const cin = tl.people.map(p => ({ key: 'in-' + p.id, name: p.name + ' → joint', cls: DIAL_CLS[p.id] || 'series-muted', values: rows.map(m => m.in[p.id]) }));
      const otherIn = rows.map(m => known(m.in.unassigned, m.in.other));
      if (tl.dialsByKey.inOther || otherIn.some(v => v)) cin.push({ key: 'in-other', name: 'Other money in', cls: 'series-muted', values: otherIn });
      const fromSavings = rows.map(m => (m.savings === null ? null : Math.max(0, 0 - m.savings)));
      if (fromSavings.some(v => v > 0)) cin.push({ key: 'in-savings', name: 'From savings', cls: 'series-3', values: fromSavings });
      const cout = [['essentials', 'Essentials'], ['flexible', 'Flexible'], ['irregular', 'Irregular']].map(([k, name]) => ({ key: 'out-' + k, name, cls: DIAL_CLS[k], values: rows.map(m => m.out[k]) }));
      const toSavings = rows.map(m => (m.savings === null ? null : Math.max(0, m.savings)));
      if (toSavings.some(v => v > 0) || tl.dialsByKey.savings) cout.push({ key: 'out-savings', name: 'To savings', cls: 'series-3', values: toSavings });
      // Debt, business and investments: with the dial, and whenever a month shown had any (so the columns add up).
      const otherOut = rows.map(m => known(m.out.debt, m.out.business, m.out.invest));
      if (tl.dialsByKey.other || otherOut.some(v => v)) cout.push({ key: 'out-other', name: 'Debt, business, investing', cls: 'series-muted', values: otherOut });
      spec.columns = {
        in: cin, out: cout,
        notes: rows.map(m => {
          if (m.status === 'actual' && !m.complete) return 'Not every account’s export covers this month.';
          if (m.status === 'actual' && m.oneOffs.length) return 'Includes one-time: ' + m.oneOffs.map(o => o.merchant + ' ' + whole(o.cents)).join(', ') + '.';
          return '';
        }),
      };
      spec.net = { key: 'net', name: 'Net', values: rows.map(m => m.net) };
    } else {
      const picked = pickedOf(tl);
      const cls = trendColours(picked);
      const on = new Set(picked);
      spec.trends = {
        series: tl.series.filter(s => on.has(s.key)).map(s => ({ key: s.key, name: s.name, cls: cls[s.key], values: s.values.slice(from) })),
        ma: tl.settings.trends.ma, trend: tl.settings.trends.trend,
      };
      spec.axisTitle = TREND_AXIS[trendUnits(tl)];
    }
    return spec;
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

  function captionOf(tl, mode, spec) {
    if (mode === 'trends') {
      const t = tl.settings.trends;
      return ['Monthly amounts from your data; dashed = this plan.',
        trendUnits(tl) === 'mixed' ? 'Balance lines are month-end levels, not monthly amounts.' : '',
        t.ma ? `Average = trailing ${t.ma} months.` : '',
        t.trend ? 'Trend = straight-line fit of the actual months.' : ''].filter(Boolean).join(' ');
    }
    const b = tl.balances;
    const parts = [];
    const lines = spec && Array.isArray(spec.lines) ? spec.lines : [];
    const assumed = mode === 'balance' ? assumedOf(tl) : null;
    if (mode === 'balance' && b.mode === 'accounts' && b.accounts.length) parts.push('Combined cash = ' + b.accounts.map(a => a.name).join(' + ') + '.');
    if (tl.lastComplete) {
      // Months worked across assumed days are dotted: "solid" stops before them.
      let solidTo = tl.lastComplete;
      const main = lines.find(l => l.role === 'combined') || lines[0];
      if (assumed && main) {
        const solid = main.points.filter(p => p.month <= tl.lastComplete && p.cents !== null && p.status !== 'assumed' && p.status !== 'gap' && p.status !== 'projected');
        const tail = main.points.filter(p => p.month <= tl.lastComplete && p.cents !== null).pop();
        if (tail && tail.status === 'assumed') solidTo = solid.length ? solid[solid.length - 1].month : null;
      }
      if (solidTo) parts.push('Solid: your data through ' + fmt.month(solidTo) + '.');
    }
    parts.push((mode === 'balance' ? 'Dashed' : 'Striped') + ': this plan from ' + fmt.month(tl.planStart) + '.');
    if (lines.some(l => l.role === 'ghost')) parts.push('Faint dashed: the plan at baseline, before your changes.');
    if (assumed) parts.push(assumedLine(assumed));
    if (mode === 'balance' && b.illustrative && lines.some(l => l.role === 'account')) parts.push(String(b.illustrative));
    if (mode === 'balance' && b.mode === 'simple' && b.label) parts.push(b.label + '.');
    return parts.join(' ');
  }

  /** Trends: the lines picked (each removable), a list to add one, the average and the trend line. */
  function trendPicker(tl) {
    const picked = pickedOf(tl);
    const cls = trendColours(picked);
    const on = new Set(picked);
    const chips = tl.series.filter(s => on.has(s.key)).map(s => {
      const key = `<span class="key key-line ${esc(cls[s.key])}" aria-hidden="true"></span>`;
      if (picked.length === 1) return `<span class="plan-trend-chip is-only" id="plan-trend-${esc(s.key)}" title="At least one line stays in the chart">${key}${esc(s.name)}</span>`;
      return `<button type="button" class="plan-trend-chip" id="plan-trend-${esc(s.key)}" data-action="plan:trend-series" data-series="${esc(s.key)}" aria-label="${esc('Remove ' + s.name + ' from the chart')}">${key}${esc(s.name)}<span class="plan-trend-x" aria-hidden="true">✕</span></button>`;
    }).join('');
    const groups = SERIES_GROUPS.map(([g, label]) => {
      const list = tl.series.filter(s => s.group === g && !on.has(s.key));
      return list.length ? `<optgroup label="${esc(label)}">${list.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    const add = groups
      ? `<span class="plan-trend-add"><label class="sr-only" for="plan-trend-add">Add a line to the chart</label><select id="plan-trend-add" data-action="plan:trend-series"><option value="">Add a line…</option>${groups}</select></span>`
      : '';
    const t = tl.settings.trends;
    return `<div class="plan-trend-pick" id="plan-trend-pick" role="group" aria-label="Lines in the chart">
        <span class="plan-trend-chips">${chips}${add}</span>
        <span class="plan-trend-opts">
          ${c.segmented({ label: 'Average', name: 'plan-trend-ma', options: TREND_MA, value: t.ma, action: 'plan:trend-ma' })}
          <label class="check plan-trend-line" for="plan-trend-line"><input type="checkbox" id="plan-trend-line" data-action="plan:trend-line"${t.trend ? ' checked' : ''}><span>Trend line</span></label>
        </span>
      </div>`;
  }

  function chartCard(ctx, tl) {
    const mode = modeOf(tl);
    const none = tl.balances.mode === 'none';
    const options = none ? MODES.filter(m => m.value !== 'balance') : MODES;
    const prompt = none ? `<a class="plan-prompt" id="plan-prompt" href="#plan-balances" data-action="plan:goto-balances">Enter today’s balances below to see where the money is heading</a>` : '';
    const controls = `${prompt}${c.segmented({ label: 'Show', name: 'plan-mode', options, value: mode, action: 'plan:mode', hideLabel: true })}${mode === 'trends' ? trendPicker(tl) : ''}`;
    const spec = chartSpec(ctx, tl);
    const chart = UI.chart.cashChart(Object.assign(spec, { caption: captionOf(tl, mode, spec), controls }));
    const ranges = `<div class="plan-ranges">
        ${c.segmented({ label: 'Past', name: 'plan-past', options: PAST, value: tl.settings.past, action: 'plan:past' })}
        ${c.segmented({ label: 'Ahead', name: 'plan-horizon', options: AHEAD, value: tl.settings.horizon, action: 'plan:horizon' })}
        ${c.button('Export CSV', { action: 'plan:export-csv', id: 'plan-export-csv', cls: 'btn-small plan-export' })}
      </div>`;
    const b = tl.balances;
    const low = b.runsOut
      ? c.notice({ tone: 'warn', title: `On this plan the combined cash goes below $0 in ${fmt.monthLong(b.runsOut)}${b.lowest ? ` (lowest ${whole(b.lowest.cents)})` : ''}.` })
      : '';
    return `<section class="card plan-chart-card" id="plan-chart-card" data-mode="${esc(mode)}" aria-label="Plan chart">${chart}${ranges}${low}</section>`;
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

  Object.assign(P, { chartCard, pickedOf, shownTimeline });
})(typeof globalThis !== 'undefined' ? globalThis : this);
