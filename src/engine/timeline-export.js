'use strict';
/*
 * BudgetEngine.timeline: the plan as a spreadsheet (timeline-core.js says how the timeline files
 * fit together).
 *
 * Adds to E._timeline: toCSV.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const T = E._timeline;
  const { isObj, isCents, sumKnown, fail, settings, SPEND_GROUPS, DIAL_LABEL } = T;

  // ------------------------------------------------------------------ CSV export

  /** Cents as plain dollars for a spreadsheet: -1234.5 dollars is "-1234.50" (no $, no commas). */
  function dollars(cents) {
    const a = Math.abs(cents);
    return (cents < 0 ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
  }
  /** One CSV field (RFC 4180): quoted when it holds a comma, a quote or a line break; quotes doubled. */
  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** Free text from the data (labels, names): a leading = + - @ would start a spreadsheet formula, so it gets a ' first. */
  const csvText = v => (v === null || v === undefined ? '' : /^[=+\-@\t\r]/.test(String(v)) ? "'" + String(v) : String(v));

  /**
   * The plan as CSV text (RFC 4180, CRLF line ends): a "Settings" block of key,value rows (the
   * baseline window, horizon, each dial, each row change, each one-time cost and whether it is in
   * the allowance, each known balance and investment balance, each planned change (those worked
   * out from Budget too), each savings goal's reach month, cover from savings, the investment
   * growth rate), a blank line, then a "Months" block with one row per month (net to investments,
   * and the investments line when there is one, come last). Amounts are plain dollars ("1234.50"; with
   * format 'cents', whole cents); unknown amounts are empty; statuses are words. Same input,
   * same text.
   * @param {object} tl build()'s result
   * @param {{ people?: { id, name }[], format?: 'dollars'|'cents' }} [opts] people: the money-in
   *   columns (default tl.people)
   * @returns {string}
   */
  function toCSV(tl, opts) {
    if (!isObj(tl) || !Array.isArray(tl.months)) fail('Build the plan first: there is nothing to export.', 'timeline');
    const o = isObj(opts) ? opts : {};
    const people = (Array.isArray(o.people) ? o.people : tl.people || []).map(p => (typeof p === 'string' ? { id: p, name: p } : p)).filter(p => isObj(p) && typeof p.id === 'string' && p.id);
    const money = c => (!isCents(c) ? '' : o.format === 'cents' ? String(c) : dollars(c));
    const lines = [];
    const line = cells => lines.push(cells.map(csvCell).join(','));
    const kv = (k, v) => line([k, v]);
    const yesNo = b => (b ? 'yes' : 'no');
    const cfg = tl.settings || settings({});

    line(['Settings']);
    line(['key', 'value']);
    kv('today', tl.today);
    kv('baseline_window', tl.baseline.label);
    kv('baseline_months_setting', String(tl.baseline.setting));
    kv('baseline_months_used', String(tl.baseline.count));
    kv('baseline_from', tl.baseline.start || '');
    kv('baseline_to', tl.baseline.end || '');
    kv('plan_start', tl.planStart);
    kv('last_month', tl.lastMonth);
    kv('horizon_months', String(tl.horizon));
    kv('cover_from_savings', yesNo(cfg.coverFromSavings));
    kv('invest_return_pct', typeof cfg.investReturnPct === 'number' ? String(cfg.investReturnPct) : '');
    for (const d of tl.dials) {
      const k = 'dial.' + d.key;
      kv(k + '.label', csvText(d.label));
      kv(k + '.baseline', money(d.baselineCents));
      kv(k + '.plan', money(d.planCents));
      kv(k + '.source', d.source);
      if (isCents(d.cardCents)) { kv(k + '.card', money(d.cardCents)); kv(k + '.bank', money(d.bankCents)); }
    }
    for (const [key, group] of Object.entries(cfg.groups || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1))) kv('group.' + key, group);
    const drillRows = new Map();
    for (const k of SPEND_GROUPS) {
      const d = tl.dialsByKey[k];
      for (const r of d && d.drill ? d.drill.rows : []) { drillRows.set(r.id, r); if (r.legacyId) drillRows.set(r.legacyId, r); }
    }
    for (const id of Object.keys(cfg.rows || {}).sort()) {
      const r = drillRows.get(id) || null;
      const ch = cfg.rows[id];
      kv('row.' + id + '.label', r ? csvText(DIAL_LABEL[r.group] + ': ' + (r.level === 2 ? r.category + ' / ' : '') + r.label) : 'not matched to a row');
      if (typeof ch.included === 'boolean') kv('row.' + id + '.included', yesNo(ch.included));
      if (isCents(ch.cents)) kv('row.' + id + '.amount', money(ch.cents));
    }
    const irr = tl.dialsByKey.irregular ? tl.dialsByKey.irregular.drill : null;
    for (const i of irr ? irr.rows : []) {
      const k = 'one_time.' + i.id;
      kv(k + '.label', csvText(i.label));
      kv(k + '.date', i.date);
      kv(k + '.amount', money(i.cents));
      kv(k + '.state', i.included ? 'in the irregular allowance' : 'left out by you');
    }
    for (const i of tl.baseline.keptIn || []) {
      const k = 'one_time.' + i.id;
      kv(k + '.label', csvText(i.merchant));
      kv(k + '.date', i.date);
      kv(k + '.amount', money(i.cents));
      kv(k + '.state', 'counted as regular spending');
    }
    for (const a of tl.balances.accounts || []) {
      const k = 'balance.' + a.id;
      kv(k + '.name', csvText(a.name));
      kv(k + '.date', a.anchor ? a.anchor.date : '');
      kv(k + '.amount', money(a.anchor ? a.anchor.cents : null));
      kv(k + '.source', a.anchor ? a.anchor.source : '');
    }
    const inv = tl.balances.investments || null;
    for (const a of inv ? inv.accounts : []) {
      const k = 'investment.' + a.id;
      kv(k + '.name', csvText(a.name));
      kv(k + '.owner', a.owner === 'joint' ? 'joint' : csvText(a.ownerName || 'personal'));
      kv(k + '.date', a.anchor ? a.anchor.date : '');
      kv(k + '.amount', money(a.anchor ? a.anchor.cents : null));
      kv(k + '.source', a.anchor ? a.anchor.source : '');
    }
    if (tl.balances.combined && tl.balances.combined.simple && tl.balances.combined.anchor) {
      kv('balance.joint_cash.date', tl.balances.combined.anchor.date);
      kv('balance.joint_cash.amount', money(tl.balances.combined.anchor.cents));
      kv('balance.joint_cash.source', 'entered');
    }
    for (const c of tl.changes ? tl.changes.list : []) {
      const k = 'change.' + c.id;
      kv(k + '.label', csvText(c.label));
      kv(k + '.kind', c.kind === 'oneTime' ? 'one-time' : 'monthly');
      kv(k + '.group', c.group);
      if (c.group === 'income') kv(k + '.person', c.personId || 'other');
      kv(k + '.start', c.startMonth);
      if (c.kind === 'monthly') kv(k + '.end', c.endMonth || '');
      kv(k + '.amount', money(c.cents));
      kv(k + '.accepted', yesNo(c.accepted));
      kv(k + '.status', c.status);
      kv(k + '.source', c.source || 'plan');
      if (c.scenario) kv(k + '.scenario', csvText(c.scenario));
    }
    for (const g of tl.goals || []) {
      const k = 'goal.' + g.id;
      kv(k + '.label', csvText(g.label));
      kv(k + '.target', money(g.targetCents));
      kv(k + '.reach', g.reachMonth || '');
    }
    lines.push('');

    line(['Months']);
    const accounts = tl.balances.accounts || [];
    const combined = tl.balances.combined;
    line(['month', 'status'].concat(people.map(p => 'in_' + csvText(p.id)), ['in_other', 'in_total', 'essentials', 'flexible', 'irregular', 'other_out', 'out_total',
      'to_savings', 'from_savings', 'combined_change', 'net_checking', 'combined_balance', 'combined_status'], accounts.flatMap(a => [csvText(a.id) + '_balance', csvText(a.id) + '_status']),
      ['investing'], inv ? ['investments_balance', 'investments_status'] : []));
    tl.months.forEach((m, i) => {
      const s = m.savings;
      const cp = combined ? combined.points[i] : null;
      line([m.month, m.status].concat(people.map(p => money(m.in[p.id])), [
        money(sumKnown([m.in.unassigned, m.in.other])), money(m.in.total),
        money(m.out.essentials), money(m.out.flexible), money(m.out.irregular), money(m.out.other), money(m.out.total),
        money(s === null ? null : Math.max(0, s)), money(s === null ? null : Math.max(0, 0 - s)),
        money(m.combinedChange), money(m.net),
        money(cp ? cp.cents : null), cp && cp.status ? cp.status : '',
      ], accounts.flatMap(a => [money(a.points[i].cents), a.points[i].status || '']),
      [money(m.out.invest)], inv ? [money(inv.points[i].cents), inv.points[i].status || ''] : []));
    });
    return lines.join('\r\n') + '\r\n';
  }

  Object.assign(T, { toCSV });
})(typeof globalThis !== 'undefined' ? globalThis : this);
