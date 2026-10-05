'use strict';
/*
 * BudgetEngine.timeline: known balances and the balance lines (timeline-core.js says how the
 * timeline files fit together).
 *
 * Adds to E._timeline: anchors, prorate, mirrorPlan, balancesFor, and the texts SIMPLE_LABEL,
 * RULE, SIMPLE_RULE and ILLUSTRATIVE.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const T = E._timeline;
  const { isObj, isCents, own } = T;

  const SIMPLE_LABEL = 'Illustrative cash projection from the numbers you entered';
  const RULE = 'Month-end balances are worked back and forward from each known balance with the transactions in your exports (reconstructed). '
    + 'After the last day with a known balance, each month adds that month’s net (projected): checking gets money in − spending (essentials, flexible and irregular) − debt, business and investments − net to savings; savings gets + net to savings. '
    + 'Plan months use the dials and the planned changes you accepted; earlier months use what actually happened. '
    + 'The month of the last known balance adds only part of its net: net × (days left in the month after that date ÷ days in the month), rounded to the cent. '
    + 'Balances may go below $0: nothing is floored or topped up, except that “cover from savings” moves a projected checking shortfall from savings.';
  const SIMPLE_RULE = 'Illustrative: the joint cash you entered plus each month’s money in minus money out (moves to and from savings stay inside joint cash). '
    + 'The month of that balance adds net × (days left in the month after its date ÷ days in the month), rounded to the cent; later months add the full net. Plan months use the dials and the planned changes you accepted, earlier months what actually happened.';
  const ILLUSTRATIVE = 'Account lines are illustrative: card spending is taken from checking in the month it happens, not when the card is paid; the combined line is not affected.';

  // ------------------------------------------------------------------ known balances

  function lastDataDay(dataset) {
    let last = null;
    for (const a of dataset.accounts || []) for (const r of a.coverage || []) if (E.dates.isDate(r.end) && (!last || r.end > last)) last = r.end;
    for (const t of dataset.transactions || []) if (E.dates.isDate(t.date) && (!last || t.date > last)) last = t.date;
    return last;
  }

  /** 'From your bank data, Sep 30, 2026' — where a known balance comes from, for the screen. */
  function anchorLabel(source, date) {
    const d = E.dates.label(date);
    if (source === 'entered') return 'Entered by you, ' + d;
    if (source === 'statement') return 'From your statement, ' + d;
    return 'From your bank data, ' + d;
  }

  /**
   * The known balances a projection starts from.
   * Per account: the balance entered in plan.balances.accounts, true at the end of its own date
   * (plan.balances.accountDates[id], else accountsAsOf, else the last day of that account's export,
   * flagged dateAssumed); the balances supplied with the data (dataset.balances, source
   * 'statement' or 'bank'); or the export's own running balance. A bank figure is used unless an
   * entered balance is dated later (the newer fact wins).
   * When no account has one, the single joint cash figure (jointCashCents / asOf) is used: "simple".
   * @param {object} plan state.plan
   * @param {object} dataset normalized dataset (dataset.balances optional)
   * @param {object[]} [txns] effective transactions (rows marked as duplicate copies are skipped);
   *   default: the dataset's own rows
   * @returns {{ simple: boolean, accounts: { id, name, type, group, cents, asOf, source: 'entered'|'bank'|'statement',
   *   dateAssumed: boolean, gap: object|null, anchor: { date, cents, source, label } }[],
   *   combined: { cents, asOf: string|null, members: string[], sameDate: boolean }|null,
   *   missing: { id, name, type }[], enteredAsOf: { [id]: string } }}
   *   combined: the sum of the anchored accounts (asOf = the latest of their dates; sameDate says
   *   whether they agree), or the joint cash figure in simple mode, or null when nothing is known.
   *   missing: joint cash accounts with data but no known balance (never counted as $0).
   */
  function anchors(plan, dataset, txns) {
    const bal = plan && isObj(plan.balances) ? plan.balances : {};
    const entered = isObj(bal.accounts) ? bal.accounts : {};
    const dates = isObj(bal.accountDates) ? bal.accountDates : {};
    const ds = isObj(dataset) ? dataset : { accounts: [], transactions: [] };
    const pool = Array.isArray(txns) ? txns.filter(t => t.excluded !== 'duplicate') : (ds.transactions || []);
    const supplied = E.balances.suppliedBalances(ds);
    const dataEnd = lastDataDay(ds);
    const accounts = [], missing = [], enteredAsOf = {};
    for (const a of E.balances.cashAccounts(ds)) {
      const rows = pool.filter(t => t.accountId === a.id).map(t => Object.assign({}, t, { day: E.dates.dayNumber(t.date) })).sort((x, y) => x.day - y.day);
      const cents = isCents(own(entered, a.id)) ? entered[a.id] : null;
      let asOf = E.dates.isDate(own(dates, a.id)) ? dates[a.id] : (E.dates.isDate(bal.accountsAsOf) ? bal.accountsAsOf : null);
      let dateAssumed = false;
      if (cents !== null && !asOf) {
        const ends = a.coverage.map(r => r.end).filter(E.dates.isDate).sort();
        asOf = ends.length ? ends[ends.length - 1] : dataEnd;
        dateAssumed = true;
      }
      if (cents !== null && asOf) enteredAsOf[a.id] = asOf;
      const list = E.balances.anchorsFor(a, rows, cents, asOf, supplied.filter(b => b.accountId === a.id));
      if (!list.length) {
        if (rows.length || a.coverage.length) missing.push({ id: a.id, name: a.label, type: a.type });
        continue;
      }
      const last = list[list.length - 1];
      const lastDate = E.dates.fromDayNumber(last.day);
      accounts.push({
        id: a.id, name: a.label, type: a.type, group: a.group, cents: last.cents, asOf: lastDate, source: last.source,
        dateAssumed: last.source === 'entered' && dateAssumed, gap: last.gap || null,
        anchor: { date: lastDate, cents: last.cents, source: last.source, label: anchorLabel(last.source, lastDate) },
      });
    }
    let combined = null;
    if (accounts.length) {
      const asOfs = accounts.map(a => a.asOf).sort();
      combined = { cents: accounts.reduce((s, a) => s + a.cents, 0), asOf: asOfs[asOfs.length - 1], members: accounts.map(a => a.id), sameDate: asOfs[0] === asOfs[asOfs.length - 1] };
    } else if (isCents(bal.jointCashCents)) {
      combined = { cents: bal.jointCashCents, asOf: E.dates.isDate(bal.asOf) ? bal.asOf : null, members: [], sameDate: true };
    }
    return { simple: !accounts.length, accounts, combined, missing, enteredAsOf };
  }

  // ------------------------------------------------------------------ balances

  const prorate = (cents, daysLeft, daysInMonth) => E.money.divide(cents * daysLeft, daysInMonth);

  /** 'Assumes nothing moved between Oct 1 and Oct 2, 2026 (not in your data).' for a gap. */
  function assumedNote(gap) {
    const a = gap.from, b = gap.to;
    const span = a === b ? 'on ' + E.dates.label(a)
      : 'between ' + (a.slice(0, 4) === b.slice(0, 4) ? E.dates.label(a).replace(/, \d{4}$/, '') : E.dates.label(a)) + ' and ' + E.dates.label(b);
    return 'Assumes nothing moved ' + span + ' (not in your data).';
  }

  /** The gaps behind assumed points: { from, to, days, accounts, gaps: [{ side, from, to, days, accounts }] } or null. */
  function assumedSummary(accounts) {
    const gaps = [];
    for (const a of accounts) {
      if (!a.gap || !a.points.some(p => p.status === 'assumed')) continue;
      const same = gaps.find(g => g.from === a.gap.from && g.to === a.gap.to);
      if (same) same.accounts.push(a.name);
      else gaps.push({ side: a.gap.side, from: a.gap.from, to: a.gap.to, days: a.gap.days, accounts: [a.name] });
    }
    if (!gaps.length) return null;
    // Days in the union of the gaps (overlapping gaps count once).
    const spans = gaps.map(g => [E.dates.dayNumber(g.from), E.dates.dayNumber(g.to)]).sort((x, y) => x[0] - y[0]);
    let days = 0, cur = null;
    for (const [lo, hi] of spans) {
      if (cur && lo <= cur[1] + 1) cur[1] = Math.max(cur[1], hi);
      else { if (cur) days += cur[1] - cur[0] + 1; cur = [lo, hi]; }
    }
    days += cur[1] - cur[0] + 1;
    const froms = gaps.map(g => g.from).sort(), tos = gaps.map(g => g.to).sort();
    return { from: froms[0], to: tos[tos.length - 1], days, accounts: Array.from(new Set(gaps.flatMap(g => g.accounts))), gaps };
  }

  /**
   * Walk forward from a known balance: { [monthIndex]: cents|null } for months whose end is after
   * `fromDay`, adding delta(month) (pro-rated in the month that holds fromDay).
   */
  function projectFrom(months, fromDay, cents, delta) {
    const out = new Map();
    let running = cents;
    months.forEach((m, i) => {
      const end = E.dates.dayNumber(E.months.end(m));
      if (end <= fromDay) return;
      if (running !== null) {
        const d = delta(m);
        const start = E.dates.dayNumber(E.months.start(m));
        if (d === null) running = null;
        else if (fromDay >= start) running += prorate(d, end - fromDay, E.months.daysIn(m));
        else running += d;
      }
      out.set(i, running);
    });
    return out;
  }

  /**
   * A savings account with a known balance (entered, or supplied with the data) but no export of its own is worked back and forward
   * from the savings transfers in the one covered cash account that holds them: money sent to
   * savings from checking adds to it, money brought back takes from it. Only when it is the only
   * savings account (otherwise the transfers cannot be told apart) and exactly one export holds
   * such transfers. Returns { byId: Map(accountId -> { source: { id, name, coverage }, rows }), notes }.
   */
  function mirrorPlan(anc, dataset, txns) {
    const out = { byId: new Map(), notes: [] };
    const cash = E.balances.cashAccounts(dataset);
    const live = txns.filter(t => t.excluded !== 'duplicate');
    for (const a of anc.accounts) {
      const acct = cash.find(c => c.id === a.id);
      if (a.group !== 'savings' || !acct || acct.coverage.length || live.some(t => t.accountId === a.id)) continue;
      const group = cash.filter(c => c.group === 'savings');
      if (group.length !== 1) {
        out.notes.push(a.name + ' has no export of its own, and there is more than one savings account (' + group.map(c => c.label).join(', ') + '): the savings transfers in your exports cannot be told apart between them, so it is not worked back from them.');
        continue;
      }
      const sources = cash.filter(c => c.group !== 'savings' && c.coverage.length)
        .map(c => ({ c, rows: live.filter(t => t.accountId === c.id && E.flows.roleOf(t) === 'savings') }))
        .filter(x => x.rows.length);
      if (!sources.length) continue;
      if (sources.length > 1) {
        out.notes.push(a.name + ' has no export of its own, and transfers to savings appear in more than one export (' + sources.map(x => x.c.label).join(', ') + '): it is not worked back from them.');
        continue;
      }
      const src = sources[0];
      out.byId.set(a.id, {
        source: { id: src.c.id, name: src.c.label, coverage: src.c.coverage },
        rows: src.rows.map(t => ({ id: 'mirror-' + t.id, accountId: a.id, date: t.date, amountCents: 0 - t.amountCents, kind: 'transfer', subtype: 'savings', excluded: null })),
      });
    }
    return out;
  }

  /**
   * The balance lines: per anchored account and combined (accounts mode), or the one joint cash
   * figure moved by each month's money in and out (simple mode). `rowsByMonth` gives each month's
   * amounts (in.total, out.total, savings, net).
   */
  function balancesFor({ txns, dataset, plan, months, rowsByMonth, cfg, today, anc, mirrors }) {
    const notes = [];
    const deltaOf = (key, m) => { const r = rowsByMonth.get(m); return r ? r[key] : null; };
    const empty = { month: null, cents: null, status: null, anchor: false, gap: false, note: null, illustrative: false };
    const base = {
      mode: 'none', simple: false, label: null, rule: RULE, accounts: [], missing: anc.missing.slice(), combined: null,
      assumed: null, illustrative: null,
      policy: { coverFromSavings: cfg.coverFromSavings, applies: false, moves: [], totalCents: 0, savingsEmptyMonth: null },
      runsOut: null, lowest: null, notes,
    };
    // In simple mode every account lacks its own balance: the joint cash figure stands for them.
    if (!anc.simple) for (const m of anc.missing) notes.push(m.name + ' has no known balance: it is left out of the combined line, not counted as $0.');

    if (!anc.simple) {
      const bal = plan && isObj(plan.balances) ? plan.balances : {};
      const h = E.balances.history(txns, dataset, { entered: isObj(bal.accounts) ? bal.accounts : {}, enteredAsOf: anc.enteredAsOf, months });
      const counts = new Map();
      for (const t of txns) counts.set(t.accountId, (counts.get(t.accountId) || 0) + 1);
      const rowCount = id => counts.get(id) || 0;
      const primary = {};
      for (const g of ['checking', 'savings']) {
        const list = anc.accounts.filter(a => a.group === g).sort((a, b) => rowCount(b.id) - rowCount(a.id) || (a.id < b.id ? -1 : 1));
        primary[g] = list.length ? list[0].id : null;
      }
      for (const n of mirrors.notes) notes.push(n);
      const accounts = anc.accounts.map(a => {
        const mirror = mirrors.byId.get(a.id) || null;
        let ha = h.accounts.find(x => x.id === a.id);
        if (mirror) {
          // Worked back and forward through the transfers mirrored from the other export, over its coverage.
          const synth = { accounts: [{ id: a.id, label: a.name, type: 'savings', scope: 'joint', coverage: mirror.source.coverage }], transactions: [] };
          ha = E.balances.history(mirror.rows, synth, { entered: { [a.id]: a.cents }, enteredAsOf: { [a.id]: a.asOf }, months }).accounts[0];
          const why = 'worked back from the transfers in ' + mirror.source.name + '’s export; interest and anything moved from elsewhere are not in it.';
          const from = a.source === 'entered' ? 'the balance you entered' : a.source === 'statement' ? 'the statement balance supplied with your data' : 'the bank balance supplied with your data';
          ha = Object.assign({}, ha, { note: 'From ' + from + ' for ' + E.dates.label(a.asOf) + ', ' + why + (ha.gap ? ha.note.slice(ha.note.indexOf(' Your export')) : '') });
          notes.push(a.name + ': ' + why);
        }
        const lastDay = E.dates.dayNumber(ha.last.date);
        const isPrimary = primary[a.group] === a.id;
        const deltaKey = a.group === 'savings' ? 'savings' : 'net';
        const proj = projectFrom(months, lastDay, ha.last.cents, m => (isPrimary ? deltaOf(deltaKey, m) : 0));
        const gap = ha.gap;
        const gapFrom = gap ? E.dates.dayNumber(gap.from) : null, gapTo = gap ? E.dates.dayNumber(gap.to) : null;
        const anchorMonth = ha.anchor ? ha.anchor.date.slice(0, 7) : null;
        const note = gap ? assumedNote(gap) : null;
        const points = months.map((m, i) => {
          const end = E.dates.dayNumber(E.months.end(m));
          if (end <= lastDay) {
            // A value worked across days the export does not cover is an assumption ('assumed'),
            // not history; gap: this month-end itself falls in those days.
            const v = ha.values[i];
            const assumed = v !== null && !!(ha.assumed && ha.assumed[i]);
            return { month: m, cents: v, status: v === null ? null : assumed ? 'assumed' : 'reconstructed', anchor: m === anchorMonth,
              gap: v !== null && gap !== null && end >= gapFrom && end <= gapTo, note: assumed ? note : null, illustrative: false };
          }
          const v = proj.has(i) ? proj.get(i) : null;
          // Checking lines take card spending when it happens, not when the card is paid.
          return { month: m, cents: v, status: v === null ? null : 'projected', anchor: m === anchorMonth, gap: false, note: null, illustrative: v !== null && a.group === 'checking' };
        });
        return {
          id: a.id, name: a.name, type: a.type, group: a.group, primary: isPrimary, source: a.source,
          // The mirrored history counts the balance as entered; it keeps the source it came from.
          anchor: ha.anchor ? Object.assign({}, ha.anchor, mirror ? { source: a.source } : {}, { label: anchorLabel(mirror ? a.source : ha.anchor.source, ha.anchor.date) }) : null,
          dateAssumed: a.dateAssumed, gap, known: { from: ha.first.date, to: ha.last.date },
          mirroredFrom: mirror ? { id: mirror.source.id, name: mirror.source.name } : null,
          note: ha.note + (a.dateAssumed ? ' No date was entered for this balance, so it counts as of ' + E.dates.label(ha.anchor.date) + ', the last day of the export.' : '')
            + (isPrimary ? '' : ' Not the main ' + a.group + ' account: kept level after ' + E.dates.label(ha.last.date) + '.'),
          points,
        };
      });
      for (const a of accounts) {
        if (a.gap && a.note.includes('Your export')) {
          notes.push(a.name + ': ' + a.note.slice(a.note.indexOf('Your export'))
            + (a.points.some(p => p.status === 'assumed') ? ' Month-end balances worked out across those days are shown as assumed.' : ''));
        }
        if (a.dateAssumed) notes.push(a.name + ': no date was entered for its balance, so it counts as of ' + E.dates.label(a.anchor.date) + '.');
        if (a.anchor && a.anchor.date > today) notes.push(a.name + ': the balance is dated ' + E.dates.label(a.anchor.date) + ', after today.');
      }
      // Policy: a projected checking shortfall is covered from savings (per account only).
      const chk = accounts.find(a => a.id === primary.checking), sav = accounts.find(a => a.id === primary.savings);
      const policy = base.policy;
      if (cfg.coverFromSavings && chk && sav) {
        policy.applies = true;
        let moved = 0;
        months.forEach((m, i) => {
          const c = chk.points[i], s = sav.points[i];
          if (c.status !== 'projected' || s.status !== 'projected' || c.cents === null || s.cents === null) return;
          c.cents += moved;
          s.cents -= moved;
          if (c.cents < 0 && s.cents > 0) {
            const mv = Math.min(s.cents, 0 - c.cents);
            c.cents += mv;
            s.cents -= mv;
            moved += mv;
            policy.moves.push({ month: m, cents: mv });
            if (s.cents === 0 && policy.savingsEmptyMonth === null) policy.savingsEmptyMonth = m;
          }
        });
        policy.totalCents = moved;
      }
      const combinedPoints = months.map((m, i) => {
        const ps = accounts.map(a => a.points[i]);
        if (ps.some(p => p.cents === null)) return Object.assign({}, empty, { month: m });
        const assumed = ps.filter(p => p.status === 'assumed');
        return {
          month: m, cents: ps.reduce((s, p) => s + p.cents, 0),
          status: assumed.length ? 'assumed' : ps.some(p => p.status === 'projected') ? 'projected' : 'reconstructed',
          anchor: ps.some(p => p.anchor), gap: ps.some(p => p.gap),
          note: assumed.length ? Array.from(new Set(assumed.map(p => p.note))).join(' ') : null, illustrative: false,
        };
      });
      Object.assign(base, {
        mode: 'accounts', accounts,
        assumed: assumedSummary(accounts),
        illustrative: accounts.some(a => a.points.some(p => p.status === 'projected')) ? ILLUSTRATIVE : null,
        combined: { label: 'Joint cash: ' + accounts.map(a => a.name).join(' + '), simple: false, members: accounts.map(a => a.id), points: combinedPoints },
      });
    } else if (anc.combined) {
      const asOf = anc.combined.asOf || today;
      if (!anc.combined.asOf) notes.push('No date was entered for the joint cash balance, so it counts as of today (' + E.dates.label(today) + ').');
      const day = E.dates.dayNumber(asOf);
      const proj = projectFrom(months, day, anc.combined.cents, m => {
        const r = rowsByMonth.get(m);
        return r && r.in.total !== null && r.out.total !== null ? r.in.total - r.out.total : null;
      });
      const anchorMonth = asOf.slice(0, 7);
      const points = months.map((m, i) => {
        const v = proj.has(i) ? proj.get(i) : null;
        return { month: m, cents: v, status: v === null ? null : 'projected', anchor: m === anchorMonth, gap: false, note: null, illustrative: false };
      });
      notes.push(SIMPLE_LABEL + ': the joint cash balance you entered, moved by each month’s money in and out. ' + (E.balances.cashAccounts(dataset).length ? 'Enter each account’s balance for a line worked out from your transactions.' : 'Load a checking or savings export for a line worked out from your transactions.'));
      Object.assign(base, {
        mode: 'simple', simple: true, label: SIMPLE_LABEL, rule: SIMPLE_RULE,
        combined: { label: SIMPLE_LABEL, simple: true, members: [], anchor: { date: asOf, cents: anc.combined.cents, dateAssumed: !anc.combined.asOf }, points },
      });
    } else {
      notes.push('No balance is known yet: enter a balance for each account (or one joint cash figure) to see where the balances head.');
    }
    if (base.combined) {
      const projected = base.combined.points.filter(p => p.status === 'projected' && p.cents !== null);
      const short = projected.find(p => p.cents < 0);
      base.runsOut = short ? short.month : null;
      if (projected.length) {
        const low = projected.reduce((a, p) => (p.cents < a.cents ? p : a));
        base.lowest = { month: low.month, cents: low.cents };
      }
    }
    return base;
  }

  Object.assign(T, { anchors, prorate, mirrorPlan, balancesFor, SIMPLE_LABEL, RULE, SIMPLE_RULE, ILLUSTRATIVE });
})(typeof globalThis !== 'undefined' ? globalThis : this);
