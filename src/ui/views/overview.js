'use strict';
/*
 * Plan (route #/overview): one chart that does most of the work, the balances it starts from,
 * the dials underneath and the planned changes. Everything comes from BudgetEngine.timeline.build,
 * worked out once per render (ctx.memo).
 *   1. Chart     balance lines, money in and out each month, or chosen monthly series (Trends), on
 *                one timeline; past and ahead; Export CSV
 *   2. Balances  the known balance of each joint cash account: the bank's figure when the data has
 *                one (a different one can be entered), else an amount and date the household enters
 *   3. Dials     money in by person; money out by how adjustable it is: essentials, flexible,
 *                irregular (one-time costs spread per month), net to savings, other. Essentials and
 *                flexible open into categories and places (each can move to the other group), the
 *                irregular dial into its one-time costs. The headline adds the dials up.
 *   4. Planned changes   dated one-time or monthly changes (and templates), applied once accepted
 *   5. More      baseline window, cover-from-savings, links to the detail views
 * Text boxes and sliders commit on change through app.update (undoable). While a slider is being
 * dragged only its own box and the headline follow; the chart follows on release.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  // Dial swatches match the flows chart's columns (validated order: in from blue, out from magenta).
  const DIAL_CLS = { p1: 'series-1', p2: 'series-2', inOther: 'series-muted', essentials: 'series-5', flexible: 'series-4', irregular: 'series-6', savings: 'series-3', other: 'series-muted' };
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
  const MODES = [{ value: 'balance', label: 'Balance' }, { value: 'flows', label: 'Flows' }, { value: 'trends', label: 'Trends' }];
  const PAST = [{ value: 6, label: '6 mo' }, { value: 12, label: '12 mo' }, { value: 'all', label: 'All' }];
  const AHEAD = [{ value: 6, label: '6 mo' }, { value: 12, label: '1 yr' }, { value: 24, label: '2 yr' }, { value: 60, label: '5 yr' }];
  const BASELINES = [{ value: 3, label: 'Last 3' }, { value: 6, label: 'Last 6' }, { value: 12, label: 'Last 12' }, { value: 'all', label: 'All' }];
  const TREND_MA = [{ value: 0, label: 'Off' }, { value: 3, label: '3 mo' }, { value: 6, label: '6 mo' }];
  const SERIES_GROUPS = [['in', 'In'], ['out', 'Out'], ['savings', 'Savings'], ['net', 'Net']];
  // Trends colours: a preferred colour per series (the dial's own where there is one), then the
  // first free one, in the order the household picked them, so adding a line never recolours another.
  const TREND_CLS = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6'];
  const TREND_PREF = { 'in-p1': 'series-1', 'in-p2': 'series-2', card: 'series-1', bank: 'series-2', essentials: 'series-5', flexible: 'series-4', irregular: 'series-6', 'to-savings': 'series-3', 'from-savings': 'series-3' };
  const KIND_LABEL = { oneTime: 'One-time', monthly: 'Monthly' };
  const CHANGE_GROUP_LABEL = { income: 'Income', essentials: 'Essentials', flexible: 'Flexible', irregular: 'Irregular', savings: 'Savings' };
  const STATUS_BADGE = { applied: ['Applied', 'good'], notAccepted: ['Not accepted', 'neutral'], unset: ['Amount not set', 'warn'], outside: ['Outside horizon', 'neutral'] };
  const STEP_CENTS = 2500; // the sliders move in $25 steps; the exact box keeps cents

  /** Set by a change made on this page: the next render announces the new headline. */
  let announceNext = false;
  /** An element to focus after the next render (a control that moved or disappeared). */
  let focusNext = null;
  /** The migration note already handled this session (migrateRows runs once). */
  let migrated = null;

  // ------------------------------------------------------------------ formatting
  const isCents = v => Number.isSafeInteger(v);
  const whole = cents => fmt.money(cents, { whole: true });
  const exact = cents => fmt.money(cents);
  /** Dollars, with cents only when there are any: $2,222.02, $250. */
  const amt = cents => (isCents(cents) && cents % 100 !== 0 ? exact(cents) : whole(cents));
  const signedAmt = cents => (cents > 0 ? '+' : '') + amt(cents);
  const plural = (n, word, many) => n + ' ' + (n === 1 ? word : many || word + 's');
  /** Amount for an exact-entry box: cents kept, thousands separated, an ASCII minus. */
  function inputText(cents) {
    if (!isCents(cents)) return '';
    const abs = Math.abs(cents);
    return (cents < 0 ? '-' : '') + Math.floor(abs / 100).toLocaleString('en-US') + (abs % 100 ? '.' + String(abs % 100).padStart(2, '0') : '');
  }
  /** Typed amounts: commas and a typographic minus or dash are fine. */
  const typed = value => String(value || '').trim().replace(/[−–—]/g, '-');
  const pad = n => String(n).padStart(2, '0');
  /** The real local date, 'YYYY-MM-DD'. */
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /** "Sep 30" this year, "Sep 30, 2025" otherwise. */
  function shortDate(date) {
    const label = fmt.date(date);
    return date && date.slice(0, 4) === todayIso().slice(0, 4) ? label.replace(/, \d{4}$/, '') : label;
  }
  const choice = v => (v === 'all' ? 'all' : Number(v));
  /** A tiny "badge" carrying its own id (tests and aria-describedby can find it). */
  const badgeWithId = (id, text, tone, opts) => c.badge(text, tone, opts).replace('<span class="badge', `<span id="${esc(id)}" class="badge`);

  // ------------------------------------------------------------------ model
  function model(ctx) {
    return ctx.memo('timeline', () => E.timeline.build({
      txns: ctx.realTxns || ctx.txns, dataset: ctx.dataset, plan: ctx.state.plan, settings: ctx.state.ui.plan,
      today: todayIso(), coverageMap: ctx.coverageMap,
    }));
  }

  /** The balances the data itself knows (bank running balance or a statement), whatever was entered. */
  function dataAnchorsOf(ctx) {
    return ctx.memo('plan-data-anchors', () => {
      const out = new Map();
      try {
        const anc = E.timeline.anchors({ balances: {} }, ctx.dataset, ctx.realTxns || ctx.txns);
        for (const a of anc.accounts) if (a.anchor && a.anchor.source !== 'entered') out.set(a.id, a.anchor);
      } catch (err) { console.warn('Balances from the data could not be read:', err.message); }
      return out;
    });
  }

  /** Without any known balance there is no balance line to draw: show the flows (or trends) instead. */
  const modeOf = tl => (tl.balances.mode === 'none' && tl.settings.mode === 'balance' ? 'flows' : tl.settings.mode);
  const dialLabel = d => (d.group === 'in' && d.key !== 'inOther' ? d.label + ' → joint' : d.label);
  const signedDial = d => d.key === 'savings' || d.key === 'other' || (d.baselineCents || 0) < 0 || (d.planCents || 0) < 0;

  /** Series switched off in the chart. Never chosen (null): the account lines are off. */
  function hiddenOf(ctx, tl) {
    const raw = ctx.state.ui && ctx.state.ui.plan ? ctx.state.ui.plan.hidden : null;
    if (Array.isArray(raw)) return raw;
    return tl.balances.accounts.map(a => 'acct-' + a.id);
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
    const byKey = new Map(tl.series.map(s => [s.key, s]));
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

  // ------------------------------------------------------------------ 2. balances
  function accountsOf(tl) {
    const b = tl.balances;
    const list = b.accounts.map(a => ({ id: a.id, name: a.name, group: a.group, anchor: a.anchor }))
      .concat(b.missing.map(m => ({ id: m.id, name: m.name, group: m.type === 'savings' ? 'savings' : 'checking', anchor: null })));
    const rank = a => (a.group === 'checking' ? 0 : 1);
    return list.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(x => x[0]);
  }

  /** Amount and date boxes for one balance (the household's own figure). */
  function balanceInputs({ id, name, cents, date, datePath, account, placeholder, amountLabel }) {
    return `${amountLabel ? `<label class="plan-bal-amtlabel" for="${esc(id)}">${esc(amountLabel)}</label>` : ''}
        <span class="input-money plan-amount"><span aria-hidden="true">$</span><input id="${esc(id)}" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(inputText(cents))}" data-action="plan:balance" data-commit="1" data-account="${esc(account)}" data-name="${esc(name)}" aria-describedby="${esc(id)}-src ${esc(id)}-error"></span>
        <label class="plan-bal-asof" for="${esc(id)}-date">as of</label>
        <input class="plan-date" id="${esc(id)}-date" type="date" value="${esc(date || '')}" data-bind="${esc(datePath)}" data-type="date" data-message="${esc(name + ': balance date saved.')}" aria-describedby="${esc(id)}-date-error">
        <p class="field-error plan-bal-err" id="${esc(id)}-error" role="alert" hidden></p>
        <p class="field-error plan-bal-derr" id="${esc(id)}-date-error" role="alert" hidden></p>`;
  }

  function balanceBox(a, { cents, date, fromData }) {
    const id = 'plan-bal-' + a.id;
    const anchor = a.anchor || fromData;
    const dataWord = fromData && fromData.source === 'statement' ? 'statement' : 'bank';
    const fields = opts => balanceInputs(Object.assign({ id, name: a.name, cents, date, datePath: 'plan.balances.accountDates.' + a.id, account: a.id }, opts));
    if (fromData && cents === null) {
      // The data knows this balance: show its figure; a different one can still be entered.
      return `<div class="plan-bal is-data" id="${esc(id)}-box">
          <span class="plan-bal-name" id="${esc(id)}-name">${esc(a.name)}</span>
          <strong class="plan-bal-figure" id="${esc(id)}-figure">${esc(exact(anchor.cents))}</strong>
          <p class="plan-bal-src fine" id="${esc(id)}-src">${esc(anchor.label)}</p>
          <details class="plan-bal-edit" id="${esc(id)}-edit"><summary>Enter a different balance</summary>
            <div class="plan-bal-editbody">${fields({ placeholder: '', amountLabel: 'Balance' })}</div>
          </details>
        </div>`;
    }
    let source = '';
    if (cents !== null && anchor) {
      source = anchor.source === 'entered' ? anchor.label
        : `${anchor.label}: newer than the balance you entered, so the chart uses it`;
    }
    const useData = cents !== null && fromData
      ? c.button(`Use the ${dataWord} figure`, { action: 'plan:balance-use-data', data: { account: a.id, name: a.name }, cls: 'btn-small btn-ghost plan-bal-usedata', id: id + '-use-data', ariaLabel: `${a.name}: use the ${dataWord} figure (${exact(fromData.cents)} on ${fmt.date(fromData.date)})` })
      : '';
    return `<div class="plan-bal" id="${esc(id)}-box">
        <label class="plan-bal-name" for="${esc(id)}">${esc(a.name)}</label>
        ${fields({ placeholder: 'Not entered' })}
        <p class="plan-bal-src fine" id="${esc(id)}-src">${esc(source)}${useData}</p>
      </div>`;
  }

  function balancesCard(ctx, tl) {
    const b = tl.balances;
    const bal = ctx.state.plan.balances || {};
    const entered = bal.accounts || {}, dates = bal.accountDates || {};
    const data = dataAnchorsOf(ctx);
    const accounts = accountsOf(tl);
    let fields;
    if (accounts.length) {
      fields = accounts.map(a => {
        const cents = isCents(entered[a.id]) ? entered[a.id] : null;
        const date = dates[a.id] || (cents !== null ? bal.accountsAsOf : null) || '';
        return balanceBox(a, { cents, date, fromData: data.get(a.id) || null });
      }).join('');
    } else {
      const id = 'plan-bal-cash';
      fields = `<div class="plan-bal" id="${id}-box"><label class="plan-bal-name" for="${id}">Cash today</label>
          ${balanceInputs({ id, name: 'Cash today', cents: isCents(bal.jointCashCents) ? bal.jointCashCents : null, date: bal.asOf || '', datePath: 'plan.balances.asOf', account: '', placeholder: 'Not entered' })}
          <p class="plan-bal-src fine" id="${id}-src"></p></div>`;
    }
    let total = '';
    const anchored = b.accounts.filter(a => a.anchor);
    if (b.mode === 'accounts' && anchored.length) {
      const sum = anchored.reduce((s, a) => s + a.anchor.cents, 0);
      const ds = anchored.map(a => a.anchor.date).sort();
      const when = ds[0] === ds[ds.length - 1] ? 'as of ' + fmt.date(ds[0]) : 'balances from ' + shortDate(ds[0]) + ' to ' + fmt.date(ds[ds.length - 1]);
      total = `<p class="plan-bal-total" id="plan-bal-total">Combined <strong>${esc(exact(sum))}</strong> ${esc(when)}</p>`;
    } else if (b.mode === 'simple' && b.combined && b.combined.anchor) {
      total = `<p class="plan-bal-total" id="plan-bal-total">Cash <strong>${esc(exact(b.combined.anchor.cents))}</strong> as of ${esc(fmt.date(b.combined.anchor.date))}</p>`;
    }
    const notes = b.notes.length ? `<p class="fine plan-bal-notes" id="plan-bal-notes">${esc(b.notes.join(' '))}</p>` : '';
    return `<section class="card plan-balances" id="plan-balances" aria-labelledby="plan-balances-h">
        <h2 class="plan-h" id="plan-balances-h">Balances</h2>
        <div class="plan-bal-list">${fields}${total}</div>${notes}
      </section>`;
  }

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
    if (inKeys.concat(outKeys).some(k => !isCents(vals[k]))) {
      const text = 'Your money, all accounts: not known yet (no complete month to start from).';
      return { html: `<p class="plan-headline" id="plan-headline">${esc(text)}</p>`, text };
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
        <p class="plan-addup" id="plan-addup">${esc(words.join(' ') + ' = ' + signedAmt(combined))}</p>`,
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

  // ------------------------------------------------------------------ 4. planned changes
  /** Cost of a change to checking: spending and savings count up, income counts down. */
  const costOf = ch => (ch.group === 'income' ? 0 - ch.cents : ch.cents);

  function changesSummary(tl) {
    const ch = tl.changes;
    if (!ch.list.length) return 'Planned changes';
    const parts = ['Planned changes', `${ch.applied} of ${ch.list.length} applied`];
    if (ch.unset.length) parts.push(`${ch.unset.length} without an amount`);
    if (ch.totalOneTimeCents) parts.push('one-time ' + amt(ch.totalOneTimeCents));
    // Monthly changes: what they add a month in the first plan month they apply.
    const byId = new Map(ch.list.map(x => [x.id, x]));
    const first = tl.months.find(m => m.month >= tl.planStart && m.changesApplied.some(a => (byId.get(a.id) || {}).kind === 'monthly'));
    if (first) {
      const cents = first.changesApplied.filter(a => (byId.get(a.id) || {}).kind === 'monthly').reduce((s, a) => s + costOf(byId.get(a.id)), 0);
      if (cents) parts.push(`${cents > 0 ? '+' : ''}${amt(cents)}/mo from ${fmt.month(first.month)}`);
    }
    return parts.join(' · ');
  }

  const optionList = (list, value) => list.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('');
  /** The note a template wrote, without the sentence every estimate shares. */
  const noteOf = ch => String(ch.note || '').replace(/\s*A generic estimate: adjust it to your own quotes and plans\.\s*$/, '').trim();

  function changeRow(tl, ch) {
    const id = 'plan-ch-' + ch.id;
    const path = 'plan.changes[id=' + ch.id + ']';
    const name = ch.label;
    const [statusText, tone] = STATUS_BADGE[ch.status] || ['', 'neutral'];
    const tip = ch.status === 'applied' ? (ch.kind === 'monthly' ? `Applied in ${plural(ch.monthsApplied, 'plan month')}` : 'Applied in ' + fmt.month(ch.startMonth)) : '';
    const person = ch.group === 'income'
      ? `<label class="sr-only" for="${esc(id)}-person">${esc(name)}: whose income</label><select id="${esc(id)}-person" data-action="plan:change-field" data-field="personId" data-change="${esc(ch.id)}" data-name="${esc(name)}">${optionList([['', 'Other money in'], ...tl.people.map(p => [p.id, p.name])], ch.personId || '')}</select>`
      : '';
    const until = ch.kind === 'monthly'
      ? `<label class="plan-ch-word" for="${esc(id)}-end">until</label><input type="month" id="${esc(id)}-end" value="${esc(ch.endMonth || '')}" data-bind="${esc(path + '.endMonth')}" data-type="month" data-message="${esc(name + ': end month saved.')}" aria-describedby="${esc(id)}-end-error" title="Leave empty: no end">`
      : '';
    const unset = ch.cents === null
      ? `<p class="plan-ch-unset" id="${esc(id)}-unset">amount not set — ${ch.group === 'income' ? 'enter the monthly reduction' : 'enter the amount'}</p>`
      : '';
    const note = noteOf(ch);
    return `<li class="plan-ch-item is-${esc(ch.status)}" data-change="${esc(ch.id)}">
        <div class="plan-ch-main">
          <label class="plan-ch-accept" for="${esc(id)}-on" title="Accepted: applied to the plan once it has an amount"><input type="checkbox" class="plan-ch-on" id="${esc(id)}-on" data-action="plan:change-accept" data-change="${esc(ch.id)}" data-name="${esc(name)}"${ch.accepted ? ' checked' : ''} aria-label="${esc('Accepted: ' + name)}"></label>
          <span class="plan-ch-label"><input type="text" id="${esc(id)}-label" value="${esc(name)}" maxlength="80" autocomplete="off" data-action="plan:change-label" data-commit="1" data-change="${esc(ch.id)}" aria-label="${esc('Name of the change: ' + name)}" aria-describedby="${esc(id)}-label-error"></span>
          <span class="input-money plan-ch-amt"><span aria-hidden="true">$</span><input type="text" id="${esc(id)}-amt" inputmode="text" autocomplete="off" spellcheck="false" placeholder="Not set" value="${esc(inputText(ch.cents))}" data-action="plan:change-cents" data-commit="1" data-change="${esc(ch.id)}" data-name="${esc(name)}" aria-label="${esc(name + ': amount' + (ch.kind === 'monthly' ? ' a month' : '') + ', dollars')}" aria-describedby="${esc(id)}-amt-error${ch.cents === null ? ' ' + id + '-unset' : ''}"></span>
          <span class="plan-ch-status">${badgeWithId(id + '-status', statusText, tone, { title: tip })}</span>
          <button type="button" class="btn btn-ghost btn-small plan-ch-remove" id="${esc(id)}-remove" data-action="plan:change-remove" data-change="${esc(ch.id)}" data-name="${esc(name)}" aria-label="${esc('Remove ' + name)}">✕</button>
        </div>
        <div class="plan-ch-when">
          <label class="sr-only" for="${esc(id)}-kind">${esc(name)}: one-time or monthly</label><select id="${esc(id)}-kind" data-action="plan:change-field" data-field="kind" data-change="${esc(ch.id)}" data-name="${esc(name)}">${optionList(Object.entries(KIND_LABEL), ch.kind)}</select>
          <label class="sr-only" for="${esc(id)}-group">${esc(name)}: group</label><select id="${esc(id)}-group" data-action="plan:change-field" data-field="group" data-change="${esc(ch.id)}" data-name="${esc(name)}">${optionList(Object.entries(CHANGE_GROUP_LABEL), ch.group)}</select>
          ${person}
          <label class="plan-ch-word" for="${esc(id)}-start">${ch.kind === 'monthly' ? 'from' : 'in'}</label><input type="month" id="${esc(id)}-start" value="${esc(ch.startMonth)}" required data-bind="${esc(path + '.startMonth')}" data-type="month" data-message="${esc(name + ': start month saved.')}" aria-describedby="${esc(id)}-start-error">
          ${until}
        </div>
        ${unset}${note ? `<p class="plan-ch-note fine">${esc(note)}</p>` : ''}
        <p class="field-error" id="${esc(id)}-label-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-amt-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-start-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-end-error" role="alert" hidden></p>
      </li>`;
  }

  function changesHtml(ctx, tl) {
    const list = tl.changes.list;
    const waiting = list.filter(ch => !ch.accepted).length;
    const accepted = list.length - waiting;
    const bulk = list.length ? `<p class="plan-ch-bulk">${waiting ? c.button(`Accept all ${waiting}`, { action: 'plan:change-accept-all', id: 'plan-ch-accept-all', cls: 'btn-small' }) : ''}${accepted ? c.button('Unaccept all', { action: 'plan:change-unaccept-all', id: 'plan-ch-unaccept-all', cls: 'btn-small btn-ghost' }) : ''}</p>` : '';
    const table = list.length
      ? `<ul class="plan-ch-list" id="plan-ch-list" aria-label="Planned changes">${list.map(ch => changeRow(tl, ch)).join('')}</ul>${bulk}`
      : '<p class="fine plan-ch-empty">No planned changes yet.</p>';
    const add = `<form class="plan-ch-add" id="plan-ch-add" data-action="plan:add-change" novalidate>
        <p class="drill-h">Add a change</p>
        <div class="plan-ch-addrow">
          <label class="plan-ch-field"><span>What</span><input type="text" name="label" id="plan-ch-new-label" maxlength="80" autocomplete="off" placeholder="e.g. Car repair"></label>
          <label class="plan-ch-field"><span>Kind</span><select name="kind" id="plan-ch-new-kind">${optionList(Object.entries(KIND_LABEL), 'oneTime')}</select></label>
          <label class="plan-ch-field"><span>Group</span><select name="group" id="plan-ch-new-group">${optionList(Object.entries(CHANGE_GROUP_LABEL), 'irregular')}</select></label>
          <label class="plan-ch-field"><span>From</span><input type="month" name="start" id="plan-ch-new-start" value="${esc(tl.planStart)}"></label>
          <label class="plan-ch-field"><span>Amount</span><span class="input-money"><span aria-hidden="true">$</span><input type="text" name="amount" id="plan-ch-new-amt" inputmode="text" autocomplete="off" placeholder="Not set"></span></label>
          <button type="submit" class="btn btn-secondary btn-small" id="plan-ch-new-add">Add</button>
        </div>
        <p class="field-error" id="plan-ch-new-error" role="alert" hidden></p>
      </form>`;
    const templates = E.timeline.templates.list().filter(tp => tp.key === 'baby').map(() => `<div class="plan-ch-template" id="plan-tpl-baby-box">
        <p class="drill-h">Templates</p>
        <div class="plan-ch-addrow">
          <label class="plan-ch-field"><span>Baby: due date</span><input type="date" id="plan-tpl-baby-date" aria-describedby="plan-tpl-baby-help plan-tpl-baby-date-error"></label>
          <button type="button" class="btn btn-secondary btn-small" id="plan-tpl-baby" data-action="plan:template-baby">Add the Baby template</button>
        </div>
        <p class="field-error" id="plan-tpl-baby-date-error" role="alert" hidden></p>
        <p class="fine" id="plan-tpl-baby-help">Generic estimates timed from the due month (gear, delivery, diapers, childcare, parental leave). They are listed, not applied: review the amounts, then accept them.</p>
      </div>`).join('');
    const body = `<p class="fine">Dated changes on top of the dials: a one-time cost in one month, or a monthly change from a start month (until an end month, when set). Only accepted changes with an amount reach the plan; the chart marks them on its bottom edge. A drop in income is a negative amount. In the summary, one-time and monthly totals count money going out.</p>
      ${table}${add}${templates}`;
    return c.disclosure(esc(changesSummary(tl)), body, { id: 'plan-changes', cls: 'plan-changes' });
  }

  // ------------------------------------------------------------------ 5. more options
  function moreHtml(ctx, tl) {
    const body = `${c.segmented({ label: 'Baseline: complete months to average', name: 'plan-baseline', options: BASELINES, value: tl.baseline.setting, action: 'plan:baseline' })}
      <p class="fine" id="plan-baseline-label">${esc(tl.baseline.label)}. One-time costs go into the irregular dial, spread per month; yearly bills are spread over 12 months.</p>
      <label class="check plan-cover" for="plan-cover"><input type="checkbox" id="plan-cover" data-action="plan:cover"${tl.settings.coverFromSavings ? ' checked' : ''}><span>When checking would go below $0 in a plan month, move the shortfall from savings (only the account lines; the combined line is never changed)</span></label>
      <p class="plan-links"><a href="${esc(ctx.href('budget'))}">Pay and bills in detail → Budget</a><a href="${esc(ctx.href('review'))}">Fix a transaction → Transactions</a></p>`;
    return c.disclosure('More options', body, { id: 'plan-more', cls: 'plan-more' });
  }

  // ------------------------------------------------------------------ render
  function render(ctx) {
    const last = ctx.months.length ? ctx.months[ctx.months.length - 1] : null;
    const header = tl => c.pageHeader({
      title: 'Plan',
      subtitle: last ? `Joint accounts · your data through ${esc(fmt.date(E.months.end((tl && tl.lastComplete) || last)))}` : 'Joint accounts',
    });
    if (ctx.app.datasetError) return header() + c.notice({ tone: 'bad', title: 'Your data file could not be read', body: esc(ctx.app.datasetError) });
    if (!ctx.months.length) {
      return header() + c.card(c.empty('Load your bank exports to see your plan. Nothing leaves this device.', c.linkButton('Load data', ctx.href('data'), { variant: 'primary' })), { title: 'No data yet' });
    }
    const tl = model(ctx);
    const sample = ctx.dataset.isSynthetic ? '<p class="fine plan-sample" id="plan-sample">This is a fictional sample household. Load your own bank exports in Data &amp; privacy; they stay on this device.</p>' : '';
    return `<div class="plan-page">${header(tl)}<div class="plan" id="plan-root">
        ${chartCard(ctx, tl)}
        ${balancesCard(ctx, tl)}
        ${dialsCard(ctx, tl)}
        ${changesHtml(ctx, tl)}
        ${moreHtml(ctx, tl)}
        <p class="sr-only" id="plan-live" aria-live="polite"></p>
        ${sample}
      </div></div>`;
  }

  // ------------------------------------------------------------------ behaviour
  function showError(el, message) {
    const box = el && document.getElementById(el.id + '-error');
    if (!el) return;
    if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    if (box) { box.textContent = message || ''; box.hidden = !message; }
  }

  function afterRender(container, ctx) {
    const rootEl = container.querySelector('#plan-root');
    if (!rootEl) return;
    const tl = model(ctx);
    // Row changes saved under the earlier card and bank dials: made permanent once, with a note.
    if (tl.migration && migrated !== tl.migration.note) {
      migrated = tl.migration.note;
      const note = String(tl.migration.note || '').replace(/^ui\.plan\.rows:\s*/, '');
      setTimeout(() => {
        try {
          ctx.app.update(st => E.timeline.migrateRows(st, tl), { message: note, undoable: false });
        } catch (err) { console.warn('Earlier plan rows were not carried over:', err.message); }
      }, 0);
    }
    // A slider being dragged: its box, its spoken value and the headline follow at once.
    rootEl.addEventListener('input', ev => {
      const el = ev.target;
      if (!el.matches || !el.matches('input.dial-range')) return;
      const key = el.dataset.dial;
      const cents = Math.round(Number(el.value) * 100);
      const dial = el.closest('.dial');
      dial.dataset.cents = String(cents);
      dial.dataset.dirty = '1';
      const box = document.getElementById('plan-dial-' + key);
      if (box) { box.value = inputText(cents); showError(box, null); }
      el.setAttribute('aria-valuetext', amt(cents) + ' a month');
      const overrides = {};
      for (const x of rootEl.querySelectorAll('.dial[data-dirty]')) overrides[x.dataset.dial] = Number(x.dataset.cents);
      const sum = rootEl.querySelector('#plan-sum');
      if (sum) sum.innerHTML = sumOf(tl, valuesOf(tl, overrides)).html;
    });
    // Enter commits a typed amount (the same as leaving the box).
    rootEl.addEventListener('keydown', ev => {
      const el = ev.target;
      if (ev.key !== 'Enter' || !el.matches || !el.matches('input[data-commit]')) return;
      ev.preventDefault();
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Legend toggles are drawn by the chart itself; only the choice is saved (no re-render).
    const card = rootEl.querySelector('#plan-chart-card');
    if (card) {
      card.addEventListener('chart:hidden', ev => {
        if (card.dataset.mode === 'trends') return;
        const list = ev.detail && Array.isArray(ev.detail.hidden) ? ev.detail.hidden.slice(0, E.state.LIMITS.planHidden || 40) : [];
        try {
          ctx.app.update(st => E.state.setPath(st, 'ui.plan.hidden', list), { undoable: false, rerender: false });
        } catch (err) { console.warn('Chart series choice not saved:', err.message); }
      });
    }
    if (focusNext) {
      const target = typeof focusNext === 'function' ? focusNext(rootEl) : rootEl.querySelector(focusNext);
      focusNext = null;
      if (target) target.focus({ preventScroll: true });
    }
    if (announceNext) {
      announceNext = false;
      const live = rootEl.querySelector('#plan-live');
      const text = sumOf(tl, valuesOf(tl)).text;
      if (live) setTimeout(() => { live.textContent = text; }, 120);
    }
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
  const changeOf = (ctx, id) => model(ctx).changes.list.find(ch => ch.id === id) || null;

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
    'plan:reset': ctx => change(ctx, st => E.timeline.resetPlan(st), 'Every dial is back to its baseline.'),
    'plan:reset-dial': (ctx, el) => {
      const tl = model(ctx);
      const d = tl.dialsByKey[el.dataset.dial];
      if (!d) return;
      focusNext = '#plan-dial-' + d.key;
      change(ctx, st => E.timeline.resetDial(st, d.key, tl), `${dialLabel(d)} is back to its baseline (${amt(d.baselineCents)}).`);
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
      const raw = typed(el.value);
      if (raw === '') {
        showError(el, null);
        if (!cur || cur.cents === undefined) return;
        change(ctx, st => E.timeline.setRow(st, id, { cents: null }), `${el.dataset.name} is back to its average.`);
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
      const dial = model(ctx).dialsByKey[id.split('-')[0]];
      const row = dial && dial.drill ? dial.drill.rows.find(r => r.id === id) : null;
      if (row && row.planCents === cents) return;
      change(ctx, st => E.timeline.setRow(st, id, { cents }), `${el.dataset.name} set to ${amt(cents)} a month.`);
    },
    'plan:row-reset': (ctx, el) => change(ctx, st => E.timeline.setRow(st, el.dataset.row, { included: null, cents: null }), `${el.dataset.name} is back to its average.`),
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
    'plan:change-accept-all': ctx => {
      const list = model(ctx).changes.list.filter(ch => !ch.accepted);
      if (!list.length) return;
      const unset = list.filter(ch => ch.cents === null).length;
      change(ctx, st => E.timeline.acceptChanges(st, list.map(ch => ch.id), true),
        `Accepted ${plural(list.length, 'planned change')}${unset ? `; ${unset} still ${unset === 1 ? 'needs' : 'need'} an amount` : ''}.`);
    },
    'plan:change-unaccept-all': ctx => {
      const list = model(ctx).changes.list.filter(ch => ch.accepted);
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
      focusNext = root => root.querySelector('#plan-changes > summary');
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
    'plan:template-baby': ctx => {
      const input = document.getElementById('plan-tpl-baby-date');
      const date = input ? input.value : '';
      if (!E.dates.isDate(date)) { showError(input, 'Enter the due date first.'); if (input) input.focus(); return; }
      showError(input, null);
      const items = E.timeline.templates.baby(date);
      focusNext = '#plan-ch-accept-all';
      change(ctx, st => E.timeline.addChange(st, items), `Added ${items.length} baby items — review the amounts, then accept them.`);
    },
  };

  UI.views = UI.views || {};
  UI.views.overview = { title: 'Plan', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
