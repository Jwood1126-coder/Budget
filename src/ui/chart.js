'use strict';
/*
 * The cash chart: one plotting surface, one timeline divided at today, two labelled modes.
 *
 *   Balance mode  lines of account balances at month end (a combined line, optional per-account
 *                 lines). Actual months solid, plan months dashed, gaps dotted or broken.
 *   Flows mode    monthly money in stacked above the axis, money out stacked below it; plan months
 *                 striped. An optional net line on top.
 *   Trends mode   one line per series in dollars a month, or a month-end level such as a balance
 *                 (actual solid, plan dashed), with an optional trailing moving average and a
 *                 least-squares trend line (stats helpers below).
 *
 * Presentation-only extras: a ghost "Baseline plan" line and a "compare" what-if line in balance
 * mode, and markers (planned changes, goals reached) in a lane above the plot: a dot, a short label
 * placed so labels never overlap (two rows at most; what does not fit keeps its dot and is in the
 * readout and the table), and a faint rule down to the axis; monthly changes also get a faint band
 * on the bottom edge from the first one to the right edge.
 *
 * Both modes share the same margins and x positions, so switching modes never shifts the
 * timeline. cashChart() returns an HTML string (escaped like every component); attach(root) wires
 * hover, tap, keyboard and the legend toggles after app.js has set innerHTML. Hiding a series is
 * presentation only: scales, totals, the summary and the table never change.
 *
 * The figure carries data-chart="cash" and its tooltip model (an inert application/json block) so
 * attach() can read every month without recomputing anything. All tooltip text is set with textContent.
 */
(function (root) {
  const UI = root.BudgetUI || (root.BudgetUI = {});
  const { esc } = UI.dom;
  const fmt = UI.fmt;

  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // 'assumed': worked back or forward across days no export covers (nothing assumed to move then).
  const STATUS = { recorded: 'Recorded', reconstructed: 'Reconstructed', assumed: 'Assumed', projected: 'Projected', gap: 'Gap' };
  const ACCOUNT_CLS = ['series-2', 'series-3', 'series-4', 'series-5'];
  // Validated order (adjacent pairs, light and dark): in stacks up from blue, out stacks down from
  // magenta, so the two series that meet at the axis stay distinct under colour-vision deficiency.
  const IN_CLS = ['series-1', 'series-2', 'series-4'];
  const OUT_CLS = ['series-5', 'series-4', 'series-3', 'series-6'];
  // Trends lines follow the categorical order.
  const TREND_CLS = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6'];
  const GHOST_CLS = 'series-ghost';
  const COMPARE_CLS = 'series-compare';
  /** Lines drawn for comparison only: never the summary's line, its low point or a series colour. */
  const isAside = role => role === 'ghost' || role === 'compare';
  const known = v => typeof v === 'number' && Number.isFinite(v);
  const f1 = v => (Math.round(v * 10) / 10).toFixed(1);
  const isOther = s => String(s.key).toLowerCase() === 'other' || /^other\b/i.test(String(s.name || ''));

  /** Same rule as components.js: phones get their own drawing so text keeps a readable size. */
  function isNarrow() { return typeof root.innerWidth === 'number' && root.innerWidth < 640; }

  /** Drawing size. The viewBox is fixed per tier so text never stretches (no preserveAspectRatio=none). */
  function geometry() {
    const w = typeof root.innerWidth === 'number' ? root.innerWidth : 1366;
    if (isNarrow()) return { tier: 'narrow', W: 360, H: 300, padL: 50, padR: 46, padT: 24, padB: 38 };
    if (w < 1200) return { tier: 'medium', W: 720, H: 320, padL: 54, padR: 54, padT: 24, padB: 38 };
    return { tier: 'wide', W: 960, H: 360, padL: 58, padR: 58, padT: 24, padB: 38 };
  }

  /** Every month when there are few; otherwise calendar-aligned steps so January is always labelled. */
  function labelStep(n, tier) {
    if (tier === 'narrow') return n <= 7 ? 1 : n <= 13 ? 2 : n <= 24 ? 3 : n <= 48 ? 6 : 12;
    if (n <= 13) return 1;
    if (tier === 'medium') return n <= 36 ? 3 : n <= 72 ? 6 : 12;
    return n <= 39 ? 3 : n <= 78 ? 6 : 12;
  }

  const textWidth = s => String(s).length * 6.4; // 11px semibold, generous

  /** Rect with only its outer end rounded (the data end), square at the baseline side. */
  function colPath(x, yTop, yBot, w, roundTop, roundBot) {
    const h = Math.max(1, yBot - yTop);
    const r = Math.max(0, Math.min(3, w / 2, h / 2));
    const rt = roundTop ? r : 0, rb = roundBot ? r : 0;
    return `M${f1(x)} ${f1(yTop + rt)}` +
      (rt ? `q0 ${f1(-rt)} ${f1(rt)} ${f1(-rt)}h${f1(w - 2 * rt)}q${f1(rt)} 0 ${f1(rt)} ${f1(rt)}` : `h${f1(w)}`) +
      `v${f1(h - rt - rb)}` +
      (rb ? `q0 ${f1(rb)} ${f1(-rb)} ${f1(rb)}h${f1(-(w - 2 * rb))}q${f1(-rb)} 0 ${f1(-rb)} ${f1(-rb)}` : `h${f1(-w)}`) +
      'z';
  }

  // ------------------------------------------------------------------ stats (trends mode)
  /**
   * Trailing mean over the last n positions (i-n+1 .. i), skipping nulls. null where fewer than n
   * positions exist yet (i < n-1), where the window holds no known value, or when n < 1.
   * Integer cents in, unrounded numbers out.
   */
  function movingAverage(values, n) {
    const list = Array.isArray(values) ? values : [];
    const w = Math.floor(Number(n));
    return list.map((_, i) => {
      if (!(w >= 1) || i < w - 1) return null;
      let sum = 0, count = 0;
      for (let k = i - w + 1; k <= i; k++) if (known(list[k])) { sum += list[k]; count++; }
      return count ? sum / count : null;
    });
  }

  /**
   * Ordinary least squares of value on position (0, 1, 2 ...) over the known values only.
   * fit[i] = intercept + slope * i at every position, so it extends past the data. With fewer
   * than two known values: { slope: null, intercept: null, fit: all null }.
   */
  function linearTrend(values) {
    const list = Array.isArray(values) ? values : [];
    const pts = [];
    list.forEach((v, i) => { if (known(v)) pts.push([i, v]); });
    if (pts.length < 2) return { slope: null, intercept: null, fit: list.map(() => null) };
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let sxx = 0, sxy = 0;
    for (const [x, v] of pts) { sxx += (x - mx) * (x - mx); sxy += (x - mx) * (v - my); }
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    return { slope, intercept, fit: list.map((_, i) => intercept + slope * i) };
  }

  /** Runs of index pairs over adjacent known values (a null breaks the line), joined by kind. */
  function runsOf(vals, kindOf) {
    const runs = [];
    let cur = null, prev = -1;
    vals.forEach((v, i) => {
      if (!known(v)) { prev = -1; cur = null; return; }
      if (prev >= 0) {
        const kind = kindOf(prev, i);
        if (cur && cur.kind === kind) cur.idx.push(i);
        else { cur = { kind, idx: [prev, i] }; runs.push(cur); }
      }
      prev = i;
    });
    return runs;
  }

  // ------------------------------------------------------------------ data preparation
  function prepareLines(lines, months, isPlan) {
    const used = new Set((lines || []).filter(l => l && !isAside(l.role)).map(l => l.cls).filter(Boolean));
    const free = ACCOUNT_CLS.filter(c => !used.has(c));
    let combinedSeen = false;
    return (lines || []).map((l, li) => {
      const byMonth = new Map((l.points || []).map(p => [p && p.month, p]));
      const pts = months.map(m => {
        const p = byMonth.get(m);
        if (!p) return { cents: null, status: null, note: '', illustrative: false };
        const status = STATUS[p.status] ? p.status : (isPlan(m) ? 'projected' : 'recorded');
        return { cents: known(p.cents) ? Math.round(p.cents) : null, status, note: p.note ? String(p.note) : '', illustrative: p.illustrative === true };
      });
      // 'ghost': the baseline plan, drawn muted behind everything; 'compare': a what-if, drawn
      // dash-dot in its own colour. Neither takes a series colour.
      const role = l.role === 'combined' ? 'combined' : isAside(l.role) ? l.role : 'account';
      let cls = role === 'ghost' ? GHOST_CLS : role === 'compare' ? l.cls || COMPARE_CLS : l.cls;
      if (!cls) {
        if (role === 'combined' && !combinedSeen && !used.has('series-1')) cls = 'series-1';
        else cls = free.shift() || 'series-muted';
      }
      if (role === 'combined') combinedSeen = true;
      const name = String(l.name ?? '') || (role === 'ghost' ? 'Baseline plan' : role === 'compare' ? 'What-if' : '');
      return { key: String(l.key ?? 'line-' + li), name, role, cls, pts };
    });
  }

  function prepareColumns(list, group, n) {
    const used = new Set((list || []).map(s => s.cls).filter(Boolean));
    const free = (group === 'in' ? IN_CLS : OUT_CLS).filter(c => !used.has(c));
    return (list || []).map((s, si) => ({
      key: String(s.key ?? group + '-' + si),
      name: String(s.name ?? ''),
      group,
      cls: s.cls || (isOther(s) ? 'series-muted' : free.shift() || 'series-muted'),
      values: Array.from({ length: n }, (_, i) => (s.values && known(s.values[i]) ? Math.round(s.values[i]) : null)),
    }));
  }

  function prepareTrendSeries(list, n) {
    const used = new Set((list || []).map(s => s && s.cls).filter(Boolean));
    const free = TREND_CLS.filter(c => !used.has(c));
    return (list || []).filter(Boolean).map((s, si) => ({
      key: String(s.key ?? 'trend-' + si),
      name: String(s.name ?? ''),
      cls: s.cls || (isOther(s) ? 'series-muted' : free.shift() || 'series-muted'),
      unit: s.unit === 'atMonthEnd' ? 'atMonthEnd' : 'perMonth',
      values: Array.from({ length: n }, (_, i) => (s.values && known(s.values[i]) ? Math.round(s.values[i]) : null)),
    }));
  }

  const MARKER_KINDS = ['oneTime', 'monthly', 'goal'];
  /**
   * Markers inside the months shown, grouped by month index: Map(i -> [{ label, title, cents, kind, pack }]).
   * label: the short text drawn; title: the full name the readout and the table use.
   */
  function prepareMarkers(list, months) {
    const at = new Map(months.map((m, i) => [m, i]));
    const byIndex = new Map();
    for (const mk of Array.isArray(list) ? list : []) {
      if (!mk || !at.has(String(mk.month))) continue;
      const i = at.get(String(mk.month));
      if (!byIndex.has(i)) byIndex.set(i, []);
      const label = String(mk.label ?? '');
      byIndex.get(i).push({
        label, title: String(mk.title ?? '') || label, cents: known(mk.cents) ? Math.round(mk.cents) : null,
        kind: MARKER_KINDS.includes(mk.kind) ? mk.kind : 'oneTime', pack: mk.pack ? String(mk.pack) : '',
      });
    }
    return new Map([...byIndex].sort((a, b) => a[0] - b[0]));
  }

  const LANE_ROW = 15;
  const laneWidth = s => String(s).length * 5.9; // 10.5px semibold
  /**
   * The marker lane above the plot: one label per month with markers (its first name, a pack's
   * name for a pack's items, and "+N" for the other names; a pack is named at its first month
   * only), placed left to right in the first row with room
   * (right of its dot, or left of it near the right edge); a label too long for any row is cut to
   * 12 characters, then left out (its dot stays: in a row where it touches no label, else on the
   * plot's top edge; row null). { items: [{ i, x, text, anchor, row, kind }], h } where h is the
   * lane's height (0 without markers).
   */
  function layoutLane(mks, xc, W, rowsMax) {
    const ends = Array.from({ length: rowsMax }, () => -Infinity);
    const items = [];
    const named = new Set(); // a pack is named once, at its first month
    for (const [i, list] of mks) {
      const kind = list.every(mk => mk.kind === 'goal') ? 'goal' : list.some(mk => mk.kind === 'oneTime') ? 'oneTime' : list.find(mk => mk.kind !== 'goal').kind;
      const names = [...new Set(list.map(mk => mk.pack || mk.label))];
      const fresh = names.filter(nm => !named.has(nm));
      const x = xc(i);
      if (!fresh.length) {
        const row = ends.findIndex(e => e + 3 <= x - 5);
        if (row >= 0) ends[row] = Math.max(ends[row], x + 5);
        items.push({ i, x, text: '', anchor: 'start', row: row >= 0 ? row : null, kind });
        continue;
      }
      const base = fresh[0];
      const more = names.length > 1 ? ' +' + (names.length - 1) : '';
      const fit = text => {
        const w = laneWidth(text);
        const right = x + 7 + w <= W - 2;
        const span = right ? [x - 5, x + 7 + w] : [x - 7 - w, x + 5];
        if (span[0] < 0) return null;
        const row = ends.findIndex(e => e + 6 <= span[0]);
        return row < 0 ? null : { row, span, anchor: right ? 'start' : 'end' };
      };
      let text = base + more;
      let at = fit(text);
      if (!at && base.length > 13) { text = base.slice(0, 12).trimEnd() + '…' + more; at = fit(text); }
      if (at) {
        ends[at.row] = at.span[1];
        for (const nm of list.map(mk => mk.pack).filter(Boolean)) named.add(nm);
        items.push({ i, x, text, anchor: at.anchor, row: at.row, kind });
        continue;
      }
      // No room for a label: the dot alone, in a row where it touches no label, else on the plot's top edge.
      const row = ends.findIndex(e => e + 3 <= x - 5);
      if (row >= 0) ends[row] = Math.max(ends[row], x + 5);
      items.push({ i, x, text: '', anchor: 'start', row: row >= 0 ? row : null, kind });
    }
    const used = items.reduce((m, it) => Math.max(m, it.row === null ? 1 : it.row + 1), 0);
    return { items, h: items.length ? used * LANE_ROW + 4 : 0 };
  }

  const sumKnown = vals => (vals.some(known) ? vals.reduce((a, v) => a + (known(v) ? v : 0), 0) : null);

  // ------------------------------------------------------------------ renderer
  /**
   * cashChart(spec) -> HTML string:
   *   id, title, mode 'balance'|'flows'|'trends', months ['YYYY-MM'], todayMonth, planStart,
   *   lines [{ key, name, role 'combined'|'account'|'ghost'|'compare', cls?, points: [{ month, cents|null, status, note? }] }]
   *     (role 'ghost': the baseline plan, muted and dashed behind the other lines; name defaults to
   *     'Baseline plan'; role 'compare': a what-if, dash-dot in its own colour (series-compare) with
   *     its end value; neither is the summary's line or has its low point; null points draw nothing),
   *   columns { in: [{ key, name, cls?, values }], out: [...] (positive = money leaving), status?: [], notes?: [] },
   *   net { key, name, values } | null,
   *   trends { series: [{ key, name, cls?, unit?: 'perMonth'|'atMonthEnd', values: [cents|null per month] }], ma: 0|3|6, trend: bool }
   *     (unit 'atMonthEnd': a month-end level such as a balance; the summary says where it ended
   *     instead of what it averaged; anything else is a monthly amount),
   *   markers [{ month, label, title?, cents?, kind 'oneTime'|'monthly'|'goal', pack? }] (presentation
   *     only, any mode; label: the short text drawn; title: the full name for the readout and table;
   *     pack: a shared name used as the label when every marker in a month has it),
   *   hidden [keys], format, caption, tableCaption, axisTitle (the y-axis title, when not the mode's own),
   *   controls (trusted HTML placed on the title row, e.g. the mode switch), titleHidden,
   *   captionFold (when set, the caption is folded away under a summary with this text),
   *   selectable (true: a click, a tap or Enter on a month dispatches `chart:select` on the figure,
   *     detail { id, index, month, via: 'mouse'|'touch'|'key' }, so the page can show that month's breakdown).
   */
  function cashChart(spec = {}) {
    const {
      id, title = '', mode: modeIn = 'balance', months: monthsIn = [], todayMonth = null, planStart = null,
      lines = [], columns: columnsIn, net = null, hidden = [], format: formatIn, caption = '', tableCaption,
      controls = '', titleHidden = false, trends: trendsIn = null, markers: markersIn = [], axisTitle: axisTitleIn = '',
      captionFold = '', selectable = false,
    } = spec || {};
    const columns = columnsIn || {};
    const mode = modeIn === 'flows' ? 'flows' : modeIn === 'trends' ? 'trends' : 'balance';
    const months = (monthsIn || []).map(String);
    const n = months.length;
    const figId = String(id || UI.dom.domId('cash', title || 'chart'));
    const format = typeof formatIn === 'function' ? formatIn : v => fmt.money(v, { whole: true });
    const money = v => (known(v) ? format(v) : 'No data');
    const signed = v => (known(v) && v > 0 ? '+' : '') + money(v);
    const hiddenSet = new Set((hidden || []).map(String));
    const isPlan = m => !!planStart && m >= planStart;
    const axisTitle = axisTitleIn ? String(axisTitleIn) : mode === 'balance' ? 'Balance, $ at month end' : mode === 'trends' ? 'Monthly, $ per month' : 'Flows, $ per month';
    // Title and controls share the top row, so the legend below has the full width in both modes.
    const head = (keysHtml, chipsHtml) => `<div class="cc-top${titleHidden ? ' is-title-hidden' : ''}">
        <p class="cc-title${titleHidden ? ' sr-only' : ''}" id="${esc(figId)}-title">${esc(title)}</p>
        ${controls ? `<div class="cc-controls">${controls}</div>` : ''}
      </div>
      ${chipsHtml ? `<div class="cc-legend" role="group" aria-label="${esc('Series in ' + (title || 'the chart') + ': press to show or hide')}">${chipsHtml}</div>` : ''}
      ${keysHtml}`;
    const emptyFigure = msg => `<figure class="chart cash-chart is-empty" id="${esc(figId)}" data-mode="${mode}" aria-labelledby="${esc(figId)}-title">${head('', '')}${UI.c.empty(esc(msg))}</figure>`;
    if (!n) return emptyFigure('No months to show yet.');

    const g = geometry();
    const plotW = g.W - g.padL - g.padR;
    const band = plotW / n;
    const xc = i => g.padL + band * (i + 0.5);
    // Markers: their lane sits above the plot, so the plot moves down by its height.
    const mks = prepareMarkers(markersIn, months);
    const lane = layoutLane(mks, xc, g.W, 2);
    g.padT += lane.h;
    g.H += lane.h;
    const plotH = g.H - g.padT - g.padB;
    const plot0 = g.padT, plot1 = g.H - g.padB;

    // ---- series and the value domain (hidden series included: hiding never rescales)
    let ls = [], real = [], ghosts = [], compares = [], cin = [], cout = [], netVals = null, monthStatus = [], inTot = [], outTot = [];
    let ts = [], maN = 0;
    let lo = 0, hi = 0, anyKnown = false, negReal = false;
    let primary = null, low = null;
    const widen = v => { if (known(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
    if (mode === 'balance') {
      ls = prepareLines(lines, months, isPlan);
      real = ls.filter(s => !isAside(s.role));
      ghosts = ls.filter(s => s.role === 'ghost');
      compares = ls.filter(s => s.role === 'compare');
      // The baseline (ghost) and a what-if widen the scale to their own values only: the zero line's
      // emphasis, the low point and the summary all follow the real lines.
      for (const s of ls) for (const p of s.pts) if (known(p.cents)) { anyKnown = true; widen(p.cents); if (!isAside(s.role) && p.cents < 0) negReal = true; }
      primary = ls.find(s => s.role === 'combined') || real[0] || null;
      if (primary) {
        primary.pts.forEach((p, i) => { if (known(p.cents) && (!low || p.cents < low.cents)) low = { i, cents: p.cents }; });
        if (low && low.cents >= 0) low = null;
      }
      // Room under the lowest point for its label.
      if (low) lo = Math.min(lo, low.cents - (hi - low.cents) * 0.1);
      monthStatus = months.map((m, i) => {
        const p = primary && primary.pts[i];
        return p && p.status ? p.status : (isPlan(m) ? 'projected' : null);
      });
    } else if (mode === 'trends') {
      const tr = trendsIn || {};
      const w = Math.floor(Number(tr.ma));
      maN = w >= 2 ? w : 0;
      ts = prepareTrendSeries(tr.series, n);
      monthStatus = months.map(m => (isPlan(m) ? 'projected' : 'recorded'));
      let actualEnd = -1;
      monthStatus.forEach((st, i) => { if (st !== 'projected') actualEnd = i; });
      for (const s of ts) {
        // The average and the trend use actual months only; plan values never enter them.
        const actual = s.values.map((v, i) => (monthStatus[i] === 'projected' ? null : v));
        s.ma = maN ? movingAverage(actual, maN).map((v, i) => (monthStatus[i] === 'projected' ? null : v)) : null;
        s.tr = null;
        if (tr.trend === true) {
          const fit = linearTrend(actual);
          // Drawn from the first actual value to the last actual month, then dotted to the end.
          if (fit.slope !== null) s.tr = { slope: fit.slope, intercept: fit.intercept, fit: fit.fit, from: actual.findIndex(known), to: actualEnd };
        }
        for (const v of s.values) if (known(v)) { anyKnown = true; widen(v); }
        if (s.ma) s.ma.forEach(widen);
        if (s.tr) [s.tr.from, s.tr.to, n - 1].forEach(i => widen(s.tr.fit[i]));
      }
    } else {
      cin = prepareColumns(columns.in, 'in', n);
      cout = prepareColumns(columns.out, 'out', n);
      inTot = months.map((m, i) => sumKnown(cin.map(s => s.values[i])));
      outTot = months.map((m, i) => sumKnown(cout.map(s => s.values[i])));
      netVals = net ? months.map((m, i) => (net.values && known(net.values[i]) ? Math.round(net.values[i]) : null)) : null;
      monthStatus = months.map((m, i) => {
        const given = Array.isArray(columns.status) ? columns.status[i] : null;
        if (STATUS[given]) return given;
        if (isPlan(m)) return 'projected';
        return inTot[i] === null && outTot[i] === null ? 'gap' : 'recorded';
      });
      months.forEach((m, i) => {
        let up = 0, down = 0;
        for (const s of cin) if (known(s.values[i])) { anyKnown = true; if (s.values[i] >= 0) up += s.values[i]; else down += s.values[i]; }
        for (const s of cout) if (known(s.values[i])) { anyKnown = true; if (s.values[i] >= 0) down -= s.values[i]; else up -= s.values[i]; }
        lo = Math.min(lo, down); hi = Math.max(hi, up);
        if (netVals && known(netVals[i])) { anyKnown = true; lo = Math.min(lo, netVals[i]); hi = Math.max(hi, netVals[i]); }
      });
    }
    if (!anyKnown) return emptyFigure('Not enough known values to draw this chart yet.');

    const t = UI.c.ticks(Math.floor(lo), Math.ceil(hi), 5);
    const ymin = t[0], ymax = t[t.length - 1];
    const y = v => plot0 + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;
    const anyNeg = mode === 'balance' ? negReal : lo < 0;
    const short = v => UI.c.compactMoney(v);
    // Tick labels keep the decimals the step needs ($12.5k, never a rounded $13k).
    const tickStep = t.length > 1 ? Math.abs(t[1] - t[0]) : 100;
    const tickLabel = v => {
      const d = v / 100, a = Math.abs(d), sd = tickStep / 100;
      const unit = a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'k'] : [1, ''];
      let dec = 0;
      while (dec < 2 && Math.abs(Math.round((sd / unit[0]) * 10 ** dec) - (sd / unit[0]) * 10 ** dec) > 1e-6) dec++;
      const body = (a / unit[0]).toFixed(dec).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
      return (d < 0 ? '−$' : '$') + body + unit[1];
    };

    // ---- background: plan band, grid, zero line, month labels
    const planIdx = planStart ? months.findIndex(m => m >= planStart) : -1;
    const markerText = mk => (mk.kind === 'goal' ? 'Goal reached: ' + mk.title + (mk.cents !== null ? ' (' + money(mk.cents) + ')' : '')
      : mk.title + (mk.cents !== null ? ' ' + signed(mk.cents) : '') + (mk.kind === 'monthly' ? ' (monthly)' : ' (one-time)'));
    // Slope of a trend in whole dollars a month: '+$42/mo'.
    const slopeText = v => signed(Math.round(v / 100) * 100 || 0) + '/mo';
    const planX = planIdx >= 0 ? g.padL + band * planIdx : null;
    const todayIdx = todayMonth ? months.indexOf(String(todayMonth)) : -1;
    const todayX = todayIdx >= 0 ? xc(todayIdx) : null;

    const bandSvg = planX !== null ? `<rect class="cc-plan-band" x="${f1(planX)}" y="${plot0}" width="${f1(g.W - g.padR - planX)}" height="${plotH}"/>` : '';
    const grid = t.map(v => `<line class="grid${v === 0 ? ' zero cc-zero' + (anyNeg ? ' is-emph' : '') : ''}" x1="${g.padL}" x2="${g.W - g.padR}" y1="${f1(y(v))}" y2="${f1(y(v))}"/>` +
      `<text class="axis cc-ylab" x="${g.padL - 8}" y="${f1(y(v) + 4)}" text-anchor="end">${esc(tickLabel(v))}</text>`).join('');
    // The zero line is drawn again over the marks so it stays visible between in and out.
    const zeroOver = anyNeg ? `<line class="cc-zero-over" x1="${g.padL}" x2="${g.W - g.padR}" y1="${f1(y(0))}" y2="${f1(y(0))}"/>` : '';

    const step = labelStep(n, g.tier);
    let firstShown = true;
    const xlabels = months.map((m, i) => {
      const mi = Number(m.slice(5, 7)) - 1;
      if (!(mi >= 0 && mi < 12) || (step > 1 && mi % step !== 0)) return '';
      const withYear = mi === 0 || firstShown;
      firstShown = false;
      return `<text class="axis cc-xlab" x="${f1(xc(i))}" y="${plot1 + 15}" text-anchor="middle">${esc(MONTH_ABBR[mi])}</text>` +
        (withYear ? `<text class="axis cc-year" x="${f1(xc(i))}" y="${plot1 + 29}" text-anchor="middle">${esc(m.slice(0, 4))}</text>` : '');
    }).join('');

    // Today marker and Plan label share the strip above the plot; they never overlap.
    let markers = '';
    let todaySpan = null;
    if (todayX !== null) {
      const w = textWidth('Today');
      const leftSide = (planX !== null && planX > todayX) || todayX + 6 + w > g.W;
      const lx = leftSide && todayX - 6 - w >= 0 ? todayX - 6 : todayX + 6;
      const anchor = lx < todayX ? 'end' : 'start';
      todaySpan = anchor === 'end' ? [lx - w, lx] : [lx, lx + w];
      markers += `<line class="cc-today" x1="${f1(todayX)}" x2="${f1(todayX)}" y1="${plot0 - 14}" y2="${plot1}"/>` +
        `<text class="cc-marker-label cc-today-label" x="${f1(lx)}" y="${plot0 - 8}" text-anchor="${anchor}">Today</text>`;
    }
    if (planX !== null) {
      const w = textWidth('Plan');
      let px = planX + 6;
      if (todaySpan && px < todaySpan[1] + 8 && px + w > todaySpan[0] - 8) px = todaySpan[1] + 10;
      if (todayX !== null && px < todayX + 4 && px + w > todayX - 4) px = todayX + 6;
      if (px + w <= g.W) markers += `<text class="cc-marker-label cc-plan-label" x="${f1(px)}" y="${plot0 - 8}" text-anchor="start">Plan</text>`;
    }

    // ---- marks
    const groupOpen = (s, extra = '') => `<g class="cc-series ${esc(s.cls)}${extra}${hiddenSet.has(s.key) ? ' is-hidden' : ''}" data-cc-series="${esc(s.key)}">`;
    let marks = '', hoverDots = '', defs = '';
    const dots = {};
    const pathD = (idx, val) => idx.map((i, k) => (k ? 'L' : 'M') + f1(xc(i)) + ' ' + f1(y(val(i)))).join(' ');
    // End labels: nudged apart when lines end close together.
    const endLabels = ends => {
      ends.sort((a, b) => a.ly - b.ly);
      for (let k = 1; k < ends.length; k++) if (ends[k].ly - ends[k - 1].ly < 13) ends[k].ly = ends[k - 1].ly + 13;
      return new Map(ends.map(e => [e.s, `<circle class="end-dot ${esc(e.s.cls)}" cx="${f1(xc(e.i))}" cy="${f1(y(e.v))}" r="4"/><text class="end-label cc-end-label" x="${f1(xc(e.i) + 8)}" y="${f1(e.ly + 4)}">${esc(short(e.v))}</text>`]));
    };
    const hoverDot = s => `<circle class="cc-dot end-dot ${esc(s.cls)}${hiddenSet.has(s.key) ? ' is-hidden' : ''}" data-cc-series="${esc(s.key)}" r="4.5" cx="0" cy="0" visibility="hidden"/>`;
    if (mode === 'balance') {
      const ends = [];
      const body = ls.map(s => {
        if (s.role === 'ghost') {
          // Thin, muted and dashed; no dots, no end label, and nothing where the baseline has no value.
          return { s, html: runsOf(s.pts.map(p => p.cents), () => 'ghost').map(r => `<path class="line cc-ghost-line ${esc(s.cls)}" d="${pathD(r.idx, i => s.pts[i].cents)}"/>`).join('') };
        }
        if (s.role === 'compare') {
          // A what-if: dash-dot in its own colour, with its end value and a hover dot.
          const html = runsOf(s.pts.map(p => p.cents), () => 'compare').map(r => `<path class="line cc-compare-line ${esc(s.cls)}" d="${pathD(r.idx, i => s.pts[i].cents)}"/>`).join('');
          const lastIdx = s.pts.map((p, i) => (known(p.cents) ? i : -1)).filter(i => i >= 0).pop();
          if (lastIdx !== undefined) ends.push({ s, i: lastIdx, v: s.pts[lastIdx].cents, ly: y(s.pts[lastIdx].cents) });
          dots[s.key] = s.pts.map(p => (known(p.cents) ? Math.round(y(p.cents) * 10) / 10 : null));
          hoverDots += hoverDot(s);
          return { s, html };
        }
        const segs = [];
        let prev = -1;
        s.pts.forEach((p, i) => {
          if (!known(p.cents)) return;
          if (prev >= 0) {
            const a = s.pts[prev];
            let kind;
            // A segment takes the weaker status of its two ends, so nothing solid ever touches a gap or
            // an assumed point (assumed -> reconstructed and assumed -> projected stay dotted).
            const between = s.pts.slice(prev + 1, i);
            if (i - prev > 1) kind = between.some(q => q.status === 'gap') ? 'gap' : between.some(q => q.status === 'assumed') ? 'assumed' : null; // bridge only a marked gap
            else if (a.status === 'gap' || p.status === 'gap') kind = 'gap';
            else if (a.status === 'assumed' || p.status === 'assumed') kind = 'assumed';
            else if (a.status === 'projected' || p.status === 'projected') kind = 'projected';
            else kind = 'actual';
            if (kind) segs.push({ kind, from: prev, to: i });
          }
          prev = i;
        });
        // Join touching segments of the same kind into one path.
        const runs = [];
        for (const sg of segs) {
          const last = runs[runs.length - 1];
          if (last && last.kind === sg.kind && last.to === sg.from) { last.idx.push(sg.to); last.to = sg.to; }
          else runs.push({ kind: sg.kind, to: sg.to, idx: [sg.from, sg.to] });
        }
        const KIND_CLS = { projected: ' is-projected', gap: ' is-gap', assumed: ' is-assumed' };
        const paths = runs.map(r => `<path class="line ${esc(s.cls)}${KIND_CLS[r.kind] || ''}" d="${r.idx.map((i, k) => (k ? 'L' : 'M') + f1(xc(i)) + ' ' + f1(y(s.pts[i].cents))).join(' ')}"/>`).join('');
        const touched = new Set(segs.flatMap(sg => [sg.from, sg.to]));
        const lonely = s.pts.map((p, i) => (known(p.cents) && !touched.has(i) ? `<circle class="cc-lone end-dot ${esc(s.cls)}" cx="${f1(xc(i))}" cy="${f1(y(p.cents))}" r="3.5"/>` : '')).join('');
        const lastIdx = s.pts.map((p, i) => (known(p.cents) ? i : -1)).filter(i => i >= 0).pop();
        if (lastIdx !== undefined) ends.push({ s, i: lastIdx, v: s.pts[lastIdx].cents, ly: y(s.pts[lastIdx].cents) });
        let lowMark = '';
        if (s === primary && low && low.i !== lastIdx) {
          const lx = Math.min(Math.max(xc(low.i), g.padL + 30), g.W - g.padR - 30);
          lowMark = `<circle class="end-dot ${esc(s.cls)}" cx="${f1(xc(low.i))}" cy="${f1(y(low.cents))}" r="4"/>` +
            `<text class="cc-low-label" x="${f1(lx)}" y="${f1(y(low.cents) + 17)}" text-anchor="middle">${esc('Low ' + short(low.cents))}</text>`;
        }
        dots[s.key] = s.pts.map(p => (known(p.cents) ? Math.round(y(p.cents) * 10) / 10 : null));
        hoverDots += hoverDot(s);
        return { s, html: paths + lonely + lowMark };
      });
      const endHtml = endLabels(ends);
      // The baseline is drawn first (behind everything), a what-if over the accounts and the combined line last, on top.
      const rank = s => (s.role === 'ghost' ? 0 : s === primary ? 3 : s.role === 'compare' ? 2 : 1);
      const order = body.slice().sort((a, b) => rank(a.s) - rank(b.s));
      const extra = s => (s.role === 'ghost' ? ' cc-ghost' : s.role === 'compare' ? ' cc-compare' : ' cc-line-series');
      marks = order.map(b => groupOpen(b.s, extra(b.s)) + b.html + (endHtml.get(b.s) || '') + '</g>').join('');
    } else if (mode === 'trends') {
      const ends = [];
      const kindOf = (a, b) => (monthStatus[a] === 'projected' || monthStatus[b] === 'projected' ? 'projected' : 'actual');
      const body = ts.map(s => {
        const cls = esc(s.cls);
        let html = '';
        // Under the series line: its moving average (thick, translucent), then its trend (thin).
        if (s.ma) html += runsOf(s.ma, () => 'ma').map(r => `<path class="line cc-ma-line ${cls}" d="${pathD(r.idx, i => s.ma[i])}"/>`).join('');
        if (s.tr) {
          const { fit, from, to } = s.tr;
          if (to > from) html += `<path class="line cc-trend-line ${cls}" d="${pathD([from, to], i => fit[i])}"/>`;
          if (n - 1 > to) html += `<path class="line cc-trend-line is-extended ${cls}" d="${pathD([to, n - 1], i => fit[i])}"/>`;
        }
        html += runsOf(s.values, kindOf).map(r => `<path class="line ${cls}${r.kind === 'projected' ? ' is-projected' : ''}" d="${pathD(r.idx, i => s.values[i])}"/>`).join('');
        html += s.values.map((v, i) => (known(v) && !known(s.values[i - 1]) && !known(s.values[i + 1]) ? `<circle class="cc-lone end-dot ${cls}" cx="${f1(xc(i))}" cy="${f1(y(v))}" r="3.5"/>` : '')).join('');
        const lastIdx = s.values.map((v, i) => (known(v) ? i : -1)).filter(i => i >= 0).pop();
        if (lastIdx !== undefined) ends.push({ s, i: lastIdx, v: s.values[lastIdx], ly: y(s.values[lastIdx]) });
        dots[s.key] = s.values.map(v => (known(v) ? Math.round(y(v) * 10) / 10 : null));
        hoverDots += hoverDot(s);
        return { s, html };
      });
      const endHtml = endLabels(ends);
      marks = body.map(b => groupOpen(b.s, ' cc-trend-series') + b.html + (endHtml.get(b.s) || '') + '</g>').join('');
    } else {
      const pid = figId + '-hatch';
      defs = `<defs><pattern id="${esc(pid)}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect class="cc-hatch" width="2.5" height="6"/></pattern></defs>`;
      const bw = Math.max(3, Math.min(24, band * 0.62));
      const all = [...cin, ...cout];
      const segsBy = new Map(all.map(s => [s, []]));
      months.forEach((m, i) => {
        let up = 0, down = 0;
        const placed = [];
        for (const s of all) {
          const v = s.values[i];
          if (!known(v) || v === 0) continue;
          const c = s.group === 'in' ? v : -v;
          const from = c >= 0 ? up : down, to = from + c;
          if (c >= 0) up = to; else down = to;
          placed.push({ s, from, to, upward: c >= 0 });
        }
        const lastUp = placed.filter(p => p.upward).pop(), lastDown = placed.filter(p => !p.upward).pop();
        for (const p of placed) {
          // 1px trimmed at each end: a 2px surface gap between touching segments.
          const yA = Math.min(y(p.from), y(p.to)) + 1, yB = Math.max(y(p.from), y(p.to)) - 1;
          const d = colPath(xc(i) - bw / 2, yA, Math.max(yA + 1, yB), bw, p === lastUp, p === lastDown);
          segsBy.get(p.s).push(`<path class="seg ${esc(p.s.cls)}" d="${d}"/>` + (monthStatus[i] === 'projected' ? `<path class="cc-seg-hatch" d="${d}" fill="url(#${esc(pid)})"/>` : ''));
        }
      });
      marks = all.map(s => groupOpen(s, ' cc-col-series') + segsBy.get(s).join('') + '</g>').join('');
      if (net && netVals) {
        const key = String(net.key ?? 'net');
        const runs = [];
        let cur = null;
        netVals.forEach((v, i) => {
          if (!known(v)) { cur = null; return; }
          const kind = monthStatus[i] === 'projected' ? 'projected' : 'actual';
          if (cur && cur.kind === kind) cur.idx.push(i);
          else if (cur) { cur = { kind, idx: [cur.idx[cur.idx.length - 1], i] }; runs.push(cur); }
          else { cur = { kind, idx: [i] }; runs.push(cur); }
        });
        const dOf = r => r.idx.map((i, k) => (k ? 'L' : 'M') + f1(xc(i)) + ' ' + f1(y(netVals[i]))).join(' ');
        const lone = runs.filter(r => r.idx.length === 1).map(r => `<circle class="cc-net-dot" cx="${f1(xc(r.idx[0]))}" cy="${f1(y(netVals[r.idx[0]]))}" r="3"/>`).join('');
        marks += `<g class="cc-series series-net cc-net${hiddenSet.has(key) ? ' is-hidden' : ''}" data-cc-series="${esc(key)}">` +
          runs.filter(r => r.idx.length > 1).map(r => `<path class="cc-net-halo" d="${dOf(r)}"/>`).join('') +
          runs.filter(r => r.idx.length > 1).map(r => `<path class="line cc-net-line${r.kind === 'projected' ? ' is-projected' : ''}" d="${dOf(r)}"/>`).join('') + lone + '</g>';
        dots[key] = netVals.map(v => (known(v) ? Math.round(y(v) * 10) / 10 : null));
        hoverDots += `<circle class="cc-dot cc-net-dot${hiddenSet.has(key) ? ' is-hidden' : ''}" data-cc-series="${esc(key)}" r="4" cx="0" cy="0" visibility="hidden"/>`;
      }
    }

    // ---- markers (presentation only): a dot and a short label in the lane above the plot, a faint
    // rule down to the axis; monthly changes also get one faint band on the bottom edge from the
    // first one to the right edge. Several in one month share one dot (the label says how many).
    let changeSvg = '';
    if (mks.size) {
      const firstMonthly = [...mks].find(([, list]) => list.some(mk => mk.kind === 'monthly'));
      if (firstMonthly) {
        const bx = xc(firstMonthly[0]);
        changeSvg += `<rect class="cc-change-band" x="${f1(bx)}" y="${f1(plot1 - 5)}" width="${f1(g.W - g.padR - bx)}" height="5"/>`;
      }
      for (const it of lane.items) {
        const list = mks.get(it.i);
        const ly = 4 + (it.row === null ? 0 : it.row) * LANE_ROW + 10; // the label's baseline
        const gy = it.row === null ? plot0 : ly - 4; // the dot's centre (on the plot's top edge when its lane is full)
        const x = it.x;
        const glyph = it.kind === 'goal'
          ? `<path class="cc-ann-glyph" d="M${f1(x)} ${f1(gy - 5)}L${f1(x + 5)} ${f1(gy)}L${f1(x)} ${f1(gy + 5)}L${f1(x - 5)} ${f1(gy)}z"/>`
          : it.kind === 'monthly'
            ? `<rect class="cc-ann-glyph" x="${f1(x - 4)}" y="${f1(gy - 4)}" width="8" height="8" rx="2"/>`
            : `<circle class="cc-ann-glyph" cx="${f1(x)}" cy="${f1(gy)}" r="4"/>`;
        const rule = `<line class="cc-ann-rule" x1="${f1(x)}" x2="${f1(x)}" y1="${f1(gy + 5)}" y2="${f1(plot1)}"/>`;
        const text = it.text ? `<text class="cc-ann-label" x="${f1(it.anchor === 'start' ? x + 7 : x - 7)}" y="${f1(ly)}" text-anchor="${it.anchor}">${esc(it.text)}</text>` : '';
        const isChange = list.some(mk => mk.kind !== 'goal');
        const cls = 'cc-ann ' + (isChange ? 'cc-change ' : '') + 'is-' + it.kind;
        changeSvg += `<g class="${cls}" data-cc-change="${esc(months[it.i])}">${rule}${glyph}${text}</g>`;
      }
    }

    const svg = `<svg class="cc-svg" viewBox="0 0 ${g.W} ${g.H}" aria-hidden="true" focusable="false">${defs}
      ${bandSvg}${grid}
      <rect class="cc-hover-band" x="0" y="${plot0}" width="${f1(band)}" height="${plotH}" visibility="hidden"/>
      ${marks}${zeroOver}${changeSvg}${xlabels}${markers}
      <g class="cc-hover" visibility="hidden"><line class="crosshair cc-crosshair" x1="0" x2="0" y1="${plot0}" y2="${plot1}"/>${hoverDots}</g>
    </svg>`;

    // ---- tooltip model, table and summary (all series, hidden or not)
    const statusText = s => (s ? STATUS[s] : '');
    const groups = {};
    const modelMonths = months.map((m, i) => {
      const rows = [];
      const notes = [];
      const plan = monthStatus[i] === 'projected' || isPlan(m);
      if (mode === 'balance') {
        for (const s of ls) {
          if (isAside(s.role)) { groups[s.key] = s.role; continue; }
          groups[s.key] = 'line';
          const p = s.pts[i];
          rows.push({ k: s.key, n: s.name, v: p.status === 'gap' && !known(p.cents) ? 'No data' : money(p.cents), c: 'key-line ' + s.cls, s: statusText(p.status) + (p.illustrative ? ' (illustrative)' : ''), note: p.note });
          // The baseline plan and the what-if sit right under the combined row, in plan months only.
          if (s === primary && plan) {
            for (const gs of ghosts) if (known(gs.pts[i].cents)) rows.push({ k: gs.key, g: 'ghost', n: gs.name, v: money(gs.pts[i].cents), c: 'key-line ' + gs.cls });
            for (const cs of compares) if (known(cs.pts[i].cents)) rows.push({ k: cs.key, g: 'compare', n: cs.name, v: money(cs.pts[i].cents), c: 'key-line ' + cs.cls });
          }
        }
      } else if (mode === 'trends') {
        for (const s of ts) {
          groups[s.key] = 'line';
          // The slope belongs to the series, so it rides on the series row; the fit is its own row.
          rows.push({ k: s.key, n: s.name, v: money(s.values[i]), c: 'key-line ' + s.cls, s: s.tr ? 'trend ' + slopeText(s.tr.slope) : '' });
          if (s.ma && known(s.ma[i])) rows.push({ k: s.key, g: 'ma', n: 'MA ' + maN, v: money(Math.round(s.ma[i])), c: 'key-line cc-key-ma ' + s.cls });
          if (s.tr && i >= s.tr.from) rows.push({ k: s.key, g: 'trend', n: 'Trend', v: money(Math.round(s.tr.fit[i])), c: 'key-line cc-key-trend ' + s.cls });
        }
      } else {
        const add = (list, label, total) => {
          if (!list.length) return;
          rows.push({ g: 'head', n: label });
          for (const s of list) { groups[s.key] = s.group; rows.push({ k: s.key, n: s.name, v: money(s.values[i]), c: 'key-line ' + s.cls }); }
          rows.push({ g: list[0].group + '-total', n: 'Total ' + list[0].group, v: money(total) });
        };
        add(cin, 'Money in', inTot[i]);
        add(cout, 'Money out', outTot[i]);
        const nv = netVals ? netVals[i] : (inTot[i] === null && outTot[i] === null ? null : (inTot[i] || 0) - (outTot[i] || 0));
        if (net) groups[String(net.key ?? 'net')] = 'net';
        rows.push({ g: 'net', k: net ? String(net.key ?? 'net') : '', keep: true, n: net && net.name ? String(net.name) : 'Net', v: signed(nv), c: net ? 'key-line series-net' : '' });
        const note = Array.isArray(columns.notes) ? columns.notes[i] : null;
        if (note) notes.push(String(note));
      }
      const planned = (mks.get(i) || []).map(mk => (mk.kind === 'goal' ? '' : 'Planned: ') + markerText(mk));
      return {
        x: Math.round(xc(i) * 10) / 10,
        m,
        t: fmt.monthLong(m),
        p: plan ? 'Plan' : monthStatus[i] === 'assumed' ? 'Assumed' : 'Actual',
        s: mode === 'flows' ? statusText(monthStatus[i]) : '',
        rows,
        note: notes.join(' '),
        pc: planned.length ? planned : undefined,
      };
    });

    const model = { mode, W: g.W, H: g.H, padL: g.padL, padR: g.padR, padT: g.padT, padB: g.padB, band: Math.round(band * 100) / 100, title: String(title), months: modelMonths, dots, groups, todayIndex: todayIdx };

    // Summary sentence for screen readers (and the aria-label).
    let summary = '';
    if (mode === 'balance' && primary) {
      const idx = primary.pts.map((p, i) => (known(p.cents) ? i : -1)).filter(i => i >= 0);
      if (idx.length) {
        const a = idx[0], b = idx[idx.length - 1];
        const proj = i => (primary.pts[i].status === 'projected' ? ' projected' : primary.pts[i].status === 'assumed' ? ' (assumed)' : '');
        let lowest = a;
        for (const i of idx) if (primary.pts[i].cents < primary.pts[lowest].cents) lowest = i;
        summary = `${primary.name} from ${money(primary.pts[a].cents)} in ${fmt.month(months[a])} to ${money(primary.pts[b].cents)}${proj(b)} in ${fmt.month(months[b])}; lowest ${money(primary.pts[lowest].cents)}${proj(lowest)} in ${fmt.month(months[lowest])}.`;
        const gaps = primary.pts.filter(p => p.status === 'gap').length;
        if (gaps) summary += ` ${gaps} month${gaps === 1 ? '' : 's'} with a gap in the data.`;
        const assumed = primary.pts.filter(p => p.status === 'assumed').length;
        if (assumed) summary += ` ${assumed} month${assumed === 1 ? ' is' : 's are'} assumed: worked out across days your data does not cover (dotted).`;
        for (const cs of compares) {
          const last = cs.pts.map((p, i) => (known(p.cents) ? i : -1)).filter(i => i >= 0).pop();
          if (last !== undefined) summary += ` ${cs.name}, for comparison: ${money(cs.pts[last].cents)} in ${fmt.month(months[last])}.`;
        }
      }
    } else if (mode === 'flows') {
      const avg = (vals, pick) => {
        const k = vals.filter((v, i) => pick(i) && known(v));
        return k.length ? Math.round(k.reduce((x, v) => x + v, 0) / k.length) : null;
      };
      const actual = i => monthStatus[i] !== 'projected';
      const plan = i => monthStatus[i] === 'projected';
      const parts = [];
      const ai = avg(inTot, actual), ao = avg(outTot, actual);
      if (ai !== null || ao !== null) parts.push(`In actual months, money in averaged ${money(ai)} and money out ${money(ao)} a month`);
      const pi = avg(inTot, plan), po = avg(outTot, plan);
      if (pi !== null || po !== null) parts.push(`the plan has ${money(pi)} in and ${money(po)} out a month`);
      summary = parts.length ? parts.join('; ') + '.' : '';
    } else if (mode === 'trends') {
      const parts = ts.map(s => {
        const trend = s.tr ? ' (trend ' + slopeText(s.tr.slope) + ')' : '';
        const at = s.values.map((v, i) => (known(v) && monthStatus[i] !== 'projected' ? i : -1)).filter(i => i >= 0);
        if (!at.length) return '';
        // A month-end level (a balance) is read where it ended; a monthly amount by its average.
        if (s.unit === 'atMonthEnd') {
          const last = at[at.length - 1];
          return `${s.name} ended at ${money(s.values[last])} in ${fmt.month(months[last])}${trend}`;
        }
        const avg = Math.round(at.reduce((a, i) => a + s.values[i], 0) / at.length);
        return `${s.name} averaged ${money(avg)} a month${trend}`;
      }).filter(Boolean);
      summary = parts.length ? 'In actual months, ' + parts.join('; ') + '.' : '';
    }
    const markerCount = [...mks.values()].reduce((a, list) => a + list.filter(mk => mk.kind !== 'goal').length, 0);
    const goalCount = [...mks.values()].reduce((a, list) => a + list.filter(mk => mk.kind === 'goal').length, 0);
    if (markerCount) summary += ` ${markerCount} planned change${markerCount === 1 ? ' is' : 's are'} marked on the timeline.`;
    if (goalCount) summary += ` ${goalCount} savings goal${goalCount === 1 ? ' is' : 's are'} reached in these months.`;
    const range = `${fmt.month(months[0])} to ${fmt.month(months[n - 1])}`;
    const ariaLabel = `${title ? title + '. ' : ''}${axisTitle}, ${range}.${planX !== null ? ' Months from ' + fmt.month(months[planIdx]) + ' are the plan.' : ''} ${summary} Use the left and right arrow keys to read each month${selectable ? ', Enter to open its breakdown' : ''}. A table follows.`;

    // ---- legend: toggle chips per series + static keys for the line/fill treatments
    const chip = (key, name, swatch, tip = '') => `<button type="button" class="cc-chip" id="${esc(UI.dom.domId(figId + '-chip', key))}" data-cc-key="${esc(key)}" aria-pressed="${hiddenSet.has(key) ? 'false' : 'true'}"${tip ? ` title="${esc(tip)}"` : ''}><span class="key ${swatch}" aria-hidden="true"></span><span class="cc-chip-name">${esc(name)}</span></button>`;
    const planKeys = '<span class="cc-key-item"><span class="key key-line cc-key-solid" aria-hidden="true"></span>Actual</span><span class="cc-key-item"><span class="key key-line key-dashed" aria-hidden="true"></span>Plan (projected)</span>';
    let chips = '', keys = [];
    if (mode === 'balance') {
      // The baseline's and the what-if's chips come after the real lines.
      chips = [...real, ...ghosts, ...compares].map(s => chip(s.key, s.name, 'key-line ' + esc(s.cls))).join('');
      const has = st => real.some(s => s.pts.some(p => p.status === st));
      if (has('projected')) keys.push(planKeys);
      if (has('assumed')) keys.push('<span class="cc-key-item"><span class="key key-line cc-key-dotted" aria-hidden="true"></span>Assumed (days without data)</span>');
      if (has('gap')) keys.push('<span class="cc-key-item"><span class="key key-line cc-key-dotted" aria-hidden="true"></span>Gap in the data</span>');
    } else if (mode === 'trends') {
      chips = ts.map(s => chip(s.key, s.name, 'key-line ' + esc(s.cls), s.tr ? 'Trend ' + slopeText(s.tr.slope) : '')).join('');
      if (monthStatus.some(st => st === 'projected')) keys.push(planKeys);
      if (maN) keys.push(`<span class="cc-key-item" title="${esc('Moving average of the last ' + maN + ' actual months')}"><span class="key key-line cc-key-ma cc-key-ink" aria-hidden="true"></span>MA ${maN}</span>`);
      if (ts.some(s => s.tr)) keys.push('<span class="cc-key-item" title="Straight-line fit to the actual months, dotted across the plan"><span class="key key-line cc-key-trend cc-key-ink" aria-hidden="true"></span>Trend</span>');
    } else {
      // Each group's label is glued to its first chip so a wrapped legend never strands "Out" at a line end.
      const group = (label, list) => (list.length ? `<span class="cc-chip-group"><span class="cc-chip-lead"><span class="cc-chip-label">${label}</span>${list[0]}</span>${list.slice(1).join('')}</span>` : '');
      chips = group('In', cin.map(s => chip(s.key, s.name, 'key-swatch ' + esc(s.cls)))) +
        group('Out', cout.map(s => chip(s.key, s.name, 'key-swatch ' + esc(s.cls)))) +
        (net && netVals ? `<span class="cc-chip-group"><span class="cc-chip-lead">${chip(String(net.key ?? 'net'), String(net.name ?? 'Net'), 'key-line series-net')}</span></span>` : '');
      if (monthStatus.some(s => s === 'projected')) keys.push('<span class="cc-key-item"><span class="key key-swatch cc-key-solid-swatch" aria-hidden="true"></span>Actual</span><span class="cc-key-item"><span class="key key-swatch is-hatched" aria-hidden="true"></span>Plan (striped)</span>');
    }
    const kinds = new Set([...mks.values()].flat().map(mk => mk.kind));
    if (kinds.has('oneTime')) keys.push('<span class="cc-key-item cc-key-marker"><span class="key cc-key-once" aria-hidden="true"></span>One-time</span>');
    if (kinds.has('monthly')) keys.push('<span class="cc-key-item cc-key-marker"><span class="key cc-key-monthly" aria-hidden="true"></span>Monthly from</span>');
    if (kinds.has('goal')) keys.push('<span class="cc-key-item cc-key-marker"><span class="key cc-key-goal" aria-hidden="true"></span>Goal reached</span>');
    const keysHtml = `<div class="cc-axisrow"><p class="cc-axis-title">${esc(axisTitle)}</p>${keys.length ? `<p class="cc-keys">${keys.join('')}</p>` : ''}</div>`;

    // ---- table twin
    const statusOfRow = i => statusText(monthStatus[i]) || '—';
    let columnsT, rowsT;
    if (mode === 'balance') {
      const anyNote = real.some(s => s.pts.some(p => p.note));
      const cols = [...real, ...ghosts, ...compares];
      columnsT = [{ key: 'm', label: 'Month' }, { key: 'st', label: 'Status' }, ...cols.map((s, si) => ({ key: 's' + si, label: s.name, align: 'right' })), ...(anyNote ? [{ key: 'note', label: 'Note' }] : [])];
      rowsT = months.map((m, i) => {
        const r = { m: fmt.month(m), st: statusOfRow(i), note: [...new Set(real.map(s => s.pts[i].note).filter(Boolean))].join('; ') };
        cols.forEach((s, si) => {
          const p = s.pts[i];
          if (isAside(s.role)) { r['s' + si] = known(p.cents) ? money(p.cents) : '—'; return; }
          const v = p.status === 'gap' && !known(p.cents) ? 'No data' : money(p.cents);
          const tags = [];
          if (p.status && p.status !== monthStatus[i]) tags.push(STATUS[p.status].toLowerCase());
          if (p.illustrative) tags.push('illustrative');
          r['s' + si] = v + (tags.length ? ' (' + tags.join(', ') + ')' : '');
        });
        return r;
      });
    } else if (mode === 'trends') {
      columnsT = [{ key: 'm', label: 'Month' }, { key: 'st', label: 'Status' }];
      ts.forEach((s, si) => {
        columnsT.push({ key: 'v' + si, label: s.name, align: 'right' });
        if (s.ma) columnsT.push({ key: 'a' + si, label: s.name + ' MA ' + maN, align: 'right' });
        if (s.tr) columnsT.push({ key: 't' + si, label: s.name + ' trend (' + slopeText(s.tr.slope) + ')', align: 'right' });
      });
      rowsT = months.map((m, i) => {
        const r = { m: fmt.month(m), st: statusOfRow(i) };
        ts.forEach((s, si) => {
          r['v' + si] = money(s.values[i]);
          if (s.ma) r['a' + si] = known(s.ma[i]) ? money(Math.round(s.ma[i])) : '—';
          if (s.tr) r['t' + si] = i >= s.tr.from ? money(Math.round(s.tr.fit[i])) : '—';
        });
        return r;
      });
    } else {
      const anyNote = Array.isArray(columns.notes) && columns.notes.some(Boolean);
      columnsT = [{ key: 'm', label: 'Month' }, { key: 'st', label: 'Status' },
        ...cin.map((s, si) => ({ key: 'i' + si, label: 'In: ' + s.name, align: 'right' })), { key: 'ti', label: 'Total in', align: 'right' },
        ...cout.map((s, si) => ({ key: 'o' + si, label: 'Out: ' + s.name, align: 'right' })), { key: 'to', label: 'Total out', align: 'right' },
        { key: 'net', label: net && net.name ? String(net.name) : 'Net', align: 'right' }, ...(anyNote ? [{ key: 'note', label: 'Note' }] : [])];
      rowsT = months.map((m, i) => {
        const r = { m: fmt.month(m), st: statusOfRow(i), ti: money(inTot[i]), to: money(outTot[i]), note: anyNote ? String(columns.notes[i] || '') : '' };
        cin.forEach((s, si) => { r['i' + si] = money(s.values[i]); });
        cout.forEach((s, si) => { r['o' + si] = money(s.values[i]); });
        const row = modelMonths[i].rows.find(x => x.g === 'net');
        r.net = row ? row.v : '';
        return r;
      });
    }
    if (mks.size) {
      columnsT.push({ key: 'pc', label: 'Planned changes' });
      rowsT.forEach((r, i) => { r.pc = (mks.get(i) || []).map(markerText).join('; '); });
    }
    const tableHtml = UI.c.table({ caption: tableCaption || (title ? title + ', by month' : 'By month'), columns: columnsT, rows: rowsT, cls: 'cc-table' });
    const tableTwin = `<details class="chart-table cc-table-twin" id="${esc(figId)}-table"><summary>Show as a table</summary>${tableHtml}</details>`;

    // The model rides in an inert JSON block (never executed; '<' escaped so it cannot close the tag).
    const modelJson = JSON.stringify(model, (k, v) => (v === '' && k !== 'v' ? undefined : v))
      .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `<figure class="chart cash-chart${selectable ? ' is-selectable' : ''}" id="${esc(figId)}" data-chart="cash" data-mode="${mode}"${selectable ? ' data-cc-select="1"' : ''} data-hidden="${esc(JSON.stringify([...hiddenSet]))}" aria-labelledby="${esc(figId)}-title">
      <script type="application/json" class="cc-model">${modelJson}</script>
      ${head(keysHtml, chips)}
      <div class="cc-plot" id="${esc(figId)}-plot" tabindex="0" role="img" aria-label="${esc(ariaLabel.replace(/\s+/g, ' ').trim())}">
        ${svg}
        <div class="cc-tip" hidden></div>
      </div>
      <p class="sr-only" aria-live="polite" data-cc-live></p>
      ${caption && captionFold
    ? `<div class="cc-foot"><details class="cc-about" id="${esc(figId)}-about"><summary>${esc(captionFold)}</summary><p class="cc-caption">${esc(caption)}</p></details>${tableTwin}</div>`
    : `${caption ? `<p class="cc-caption">${esc(caption)}</p>` : ''}${tableTwin}`}
    </figure>`;
  }

  // ------------------------------------------------------------------ behaviour
  const wired = typeof WeakSet === 'function' ? new WeakSet() : null;
  const openTips = new Set();
  let globalDoc = null;

  function installGlobal(doc) {
    if (!doc || globalDoc === doc) return;
    globalDoc = doc;
    // A tap or click anywhere else closes an open readout; so does Escape.
    doc.addEventListener('pointerdown', ev => {
      for (const ctl of [...openTips]) if (!ctl.fig.contains(ev.target)) ctl.hide();
    }, true);
    doc.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') for (const ctl of [...openTips]) ctl.hide();
    });
  }

  /** Wire every cash chart inside rootEl. Safe to call after every render (already-wired figures are skipped). */
  function attach(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;
    installGlobal(rootEl.ownerDocument || root.document);
    const figs = Array.from(rootEl.querySelectorAll('[data-chart="cash"]'));
    if (rootEl.matches && rootEl.matches('[data-chart="cash"]')) figs.unshift(rootEl);
    figs.forEach(wire);
  }

  function wire(fig) {
    if (wired) { if (wired.has(fig)) return; wired.add(fig); } else if (fig.dataset.ccWired) return;
    fig.dataset.ccWired = '1';
    let model;
    try { model = JSON.parse(fig.querySelector('script.cc-model').textContent); } catch { return; }
    const doc = fig.ownerDocument;
    const plot = fig.querySelector('.cc-plot');
    const svg = plot && plot.querySelector('svg');
    const tip = fig.querySelector('.cc-tip');
    const live = fig.querySelector('[data-cc-live]');
    if (!plot || !svg || !tip || !model || !model.months || !model.months.length) return;
    let hidden;
    try { hidden = new Set(JSON.parse(fig.getAttribute('data-hidden') || '[]')); } catch { hidden = new Set(); }
    const n = model.months.length;
    const state = { index: -1, via: null, y: null };
    const hover = svg.querySelector('.cc-hover');
    const cross = svg.querySelector('.cc-crosshair');
    const hoverBand = svg.querySelector('.cc-hover-band');

    const ctl = { fig, hide };

    function indexAt(clientX) {
      const r = svg.getBoundingClientRect();
      if (!r.width) return -1;
      const lx = (clientX - r.left) * (model.W / r.width);
      return Math.max(0, Math.min(n - 1, Math.floor((lx - model.padL) / model.band)));
    }

    function el(tag, cls, text) {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined && text !== null && text !== '') e.textContent = text;
      return e;
    }

    function fill(i) {
      const m = model.months[i];
      tip.replaceChildren();
      const titleRow = el('div', 'cc-tip-title');
      titleRow.appendChild(el('span', '', m.t));
      titleRow.appendChild(el('span', 'cc-tip-phase is-' + m.p.toLowerCase(), m.p + (m.s && m.s !== 'Projected' ? ' · ' + m.s.toLowerCase() : '')));
      tip.appendChild(titleRow);
      const hiddenIn = g => m.rows.some(r => r.k && hidden.has(r.k) && model.groups[r.k] === g);
      const spoken = [];
      const noted = new Set(); // the same note on several lines is shown once
      for (const r of m.rows) {
        if (r.k && hidden.has(r.k) && !r.keep) continue;
        if (r.g === 'head') { tip.appendChild(el('div', 'cc-tip-head', r.n)); continue; }
        const row = el('div', 'cc-tip-row' + (r.g ? ' is-' + r.g : ''));
        const name = el('span', 'cc-tip-name');
        if (r.c) name.appendChild(el('span', 'key ' + r.c));
        let label = r.n;
        if ((r.g === 'in-total' && hiddenIn('in')) || (r.g === 'out-total' && hiddenIn('out'))) label += ' (incl. hidden)';
        name.appendChild(doc.createTextNode(label));
        row.appendChild(name);
        row.appendChild(el('strong', 'cc-tip-value', r.v));
        if (r.s) row.appendChild(el('span', 'cc-tip-status is-' + r.s.split(' ')[0].toLowerCase(), r.s));
        tip.appendChild(row);
        if (r.note && !noted.has(r.note)) { noted.add(r.note); tip.appendChild(el('div', 'cc-tip-note', r.note)); }
        spoken.push(label + ' ' + r.v + (r.s ? ' ' + r.s.toLowerCase() : ''));
      }
      for (const text of m.pc || []) { tip.appendChild(el('div', 'cc-tip-planned', text)); spoken.push(text); }
      if (m.note) tip.appendChild(el('div', 'cc-tip-note', m.note));
      return `${m.t}, ${m.p.toLowerCase()}${m.s && m.s !== 'Projected' ? ' (' + m.s.toLowerCase() + ')' : ''}: ${spoken.join(', ')}${m.note ? '. ' + m.note : ''}`;
    }

    function place() {
      const i = state.index;
      if (i < 0) return;
      const pr = plot.getBoundingClientRect(), sr = svg.getBoundingClientRect();
      const scale = sr.width / model.W;
      const x = sr.left - pr.left + model.months[i].x * scale;
      tip.style.left = '0px'; // measure at its natural width, not squeezed by the last position
      const w = tip.offsetWidth, h = tip.offsetHeight;
      const gap = Math.max(10, (model.band * scale) / 2 + 6);
      let left = x + gap;
      if (left + w > pr.width) left = x - gap - w;
      if (left < 0) left = Math.max(0, Math.min(pr.width - w, x + gap));
      const plotTop = sr.top - pr.top + model.padT * scale;
      const plotBottom = sr.top - pr.top + (model.H - model.padB) * scale;
      let top = plotTop;
      if (state.via === 'mouse' && state.y !== null) top = Math.max(0, Math.min(state.y - pr.top - h / 2, plotBottom - h));
      else if (model.mode !== 'flows') {
        // Touch and keyboard: keep the readout in the half of the plot away from the points it describes.
        const ys = Object.keys(model.dots).filter(k => !hidden.has(k)).map(k => model.dots[k][i]).filter(v => v !== null && v !== undefined);
        const mid = model.padT + (model.H - model.padT - model.padB) / 2;
        if (ys.length && Math.max(...ys) < mid && plotBottom - h > plotTop) top = plotBottom - h;
      }
      tip.style.left = Math.round(left) + 'px';
      tip.style.top = Math.round(Math.max(0, top)) + 'px';
    }

    function show(i, via, clientY) {
      if (i < 0 || i >= n) return;
      const changed = i !== state.index || tip.hidden;
      state.index = i; state.via = via; state.y = clientY ?? null;
      const m = model.months[i];
      hover.setAttribute('visibility', 'visible');
      cross.setAttribute('x1', m.x); cross.setAttribute('x2', m.x);
      if (model.mode === 'flows') {
        hoverBand.setAttribute('x', String(Math.round((m.x - model.band / 2) * 10) / 10));
        hoverBand.setAttribute('width', String(model.band));
        hoverBand.setAttribute('visibility', 'visible');
      }
      for (const d of svg.querySelectorAll('.cc-dot')) {
        const ys = model.dots[d.getAttribute('data-cc-series')];
        const yv = ys ? ys[i] : null;
        if (yv === null || yv === undefined) { d.setAttribute('visibility', 'hidden'); continue; }
        d.setAttribute('cx', m.x); d.setAttribute('cy', yv); d.setAttribute('visibility', 'visible');
      }
      if (changed) {
        const text = fill(i);
        tip.hidden = false;
        if (via === 'key' && live) live.textContent = text;
      }
      place();
      fig.classList.add('is-reading');
      openTips.add(ctl);
    }

    function hide() {
      tip.hidden = true;
      hover.setAttribute('visibility', 'hidden');
      hoverBand.setAttribute('visibility', 'hidden');
      for (const d of svg.querySelectorAll('.cc-dot')) d.setAttribute('visibility', 'hidden');
      state.index = -1; state.via = null;
      fig.classList.remove('is-reading');
      openTips.delete(ctl);
    }

    /** A month chosen (click, tap or Enter) on a selectable chart: the page shows its breakdown. */
    const selectable = fig.getAttribute('data-cc-select') === '1';
    function select(i, via) {
      if (!selectable || i < 0 || i >= n) return;
      fig.dispatchEvent(new CustomEvent('chart:select', { bubbles: true, detail: { id: fig.id, index: i, month: model.months[i].m, via } }));
    }

    plot.addEventListener('pointermove', ev => {
      if (ev.pointerType === 'mouse' || (state.via === 'touch' && ev.pressure > 0)) show(indexAt(ev.clientX), ev.pointerType === 'mouse' ? 'mouse' : 'touch', ev.clientY);
    });
    plot.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse' && state.via === 'mouse') hide(); });
    plot.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'mouse') return;
      const i = indexAt(ev.clientX);
      if (!tip.hidden && state.index === i) hide(); // tap again to close
      else { show(i, 'touch', ev.clientY); select(i, 'touch'); }
    });
    plot.addEventListener('click', ev => {
      if (ev.pointerType && ev.pointerType !== 'mouse') return;
      if (ev.detail === 0) return; // not a mouse click (Enter is handled with the keys below)
      select(indexAt(ev.clientX), 'mouse');
    });
    plot.addEventListener('keydown', ev => {
      let i = state.index;
      const start = i < 0 ? (model.todayIndex >= 0 ? model.todayIndex : n - 1) : i;
      if (ev.key === 'ArrowRight') i = i < 0 ? start : Math.min(n - 1, i + 1);
      else if (ev.key === 'ArrowLeft') i = i < 0 ? start : Math.max(0, i - 1);
      else if (ev.key === 'Home') i = 0;
      else if (ev.key === 'End') i = n - 1;
      else if (ev.key === 'Escape') { if (!tip.hidden) { ev.preventDefault(); hide(); } return; }
      else if ((ev.key === 'Enter' || ev.key === ' ') && selectable && state.index >= 0) { ev.preventDefault(); select(state.index, 'key'); return; }
      else return;
      ev.preventDefault();
      show(i, 'key');
    });
    plot.addEventListener('blur', () => { if (state.via === 'key') hide(); });

    fig.addEventListener('click', ev => {
      const btn = ev.target.closest && ev.target.closest('.cc-chip');
      if (!btn || !fig.contains(btn)) return;
      const key = btn.getAttribute('data-cc-key');
      const nowHidden = !hidden.has(key);
      if (nowHidden) hidden.add(key); else hidden.delete(key);
      btn.setAttribute('aria-pressed', nowHidden ? 'false' : 'true');
      for (const node of fig.querySelectorAll('[data-cc-series]')) {
        if (node.getAttribute('data-cc-series') === key) node.classList.toggle('is-hidden', nowHidden);
      }
      const list = [...hidden];
      fig.setAttribute('data-hidden', JSON.stringify(list));
      if (!tip.hidden && state.index >= 0) { const i = state.index; tip.hidden = true; show(i, state.via, state.y); }
      fig.dispatchEvent(new CustomEvent('chart:hidden', { bubbles: true, detail: { id: fig.id, hidden: list } }));
    });
  }

  UI.chart = { cashChart, attach, isNarrow, stats: { movingAverage, linearTrend } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
