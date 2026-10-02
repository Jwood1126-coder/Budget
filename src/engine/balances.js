'use strict';
/*
 * BudgetEngine.balances — bank balances over time and a simple pattern-based projection.
 *
 * History: the balance of each joint cash account (checking, savings) at the end of every month.
 *   - "bank": the export's running-balance column gives the balance at the end of each day that
 *     has rows; other days follow from the transactions in between.
 *   - "statement" / "bank" supplied with the data (dataset.balances: [{ accountId, date, cents,
 *     source: 'statement'|'bank', note? }]): a posted balance at the end of that day, used like a
 *     running-balance figure (and preferred to it on the same day).
 *   - "entered": one balance the household typed in (plan.balances.accounts, true at the end of
 *     its own date: plan.balances.accountDates, else accountsAsOf). It is used at exactly that
 *     date, never moved. Days between the end of the account's export and that date (or between
 *     that date and the start of the export) are a "gap": no transactions are assumed in them,
 *     and the account's note says so.
 *   - "change": neither is available, so the line shows the change since the account's first
 *     covered day (a real pattern, but not a real balance), and says so.
 *   A month-end value is null when the days between it and the nearest known balance are not
 *   all covered by that account's exports: unknown is never shown as "unchanged".
 *
 * Patterns: money in, money out and money saved per month, from the same counting rules as the
 * rest of the app (joint accounts only), for months whose coverage is full.
 *
 * Projection: each month, checking += in − out − saved and savings += saved. No interest, no
 * growth: plain arithmetic the household can check.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const CASH_TYPES = ['checking', 'savings', 'other'];
  const GROUPS = ['checking', 'savings'];
  const GROUP_LABEL = { checking: 'Checking', savings: 'Savings' };

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isCents = v => Number.isSafeInteger(v);

  /**
   * Balances supplied with the data (dataset.balances), checked: [{ accountId, date, cents,
   * source: 'statement'|'bank', note }]. Entries that are not usable are skipped; absent = [].
   */
  function suppliedBalances(dataset) {
    const list = dataset && Array.isArray(dataset.balances) ? dataset.balances : [];
    return list.filter(b => isObj(b) && typeof b.accountId === 'string' && b.accountId && E.dates.isDate(b.date) && isCents(b.cents))
      .map(b => ({ accountId: b.accountId, date: b.date, cents: b.cents, source: b.source === 'statement' ? 'statement' : 'bank', note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null }));
  }

  /** Joint cash accounts in the data (cards and loans are not balances you can spend from). */
  function cashAccounts(dataset) {
    return (dataset.accounts || []).filter(a => CASH_TYPES.includes(a.type) && (a.scope || 'joint') === 'joint')
      .map(a => ({ id: a.id, label: a.label || a.id, type: a.type, group: a.type === 'savings' ? 'savings' : 'checking', coverage: Array.isArray(a.coverage) ? a.coverage : [] }));
  }

  /** Are all days in (fromDay, toDay] covered by the account's export ranges? */
  function coveredBetween(ranges, fromDay, toDay) {
    if (toDay <= fromDay) return true;
    const spans = ranges.map(r => [E.dates.dayNumber(r.start), E.dates.dayNumber(r.end)]).sort((a, b) => a[0] - b[0]);
    let next = fromDay + 1;
    for (const [s, e] of spans) {
      if (s > next) break;
      if (e >= next) next = e + 1;
      if (next > toDay) return true;
    }
    return next > toDay;
  }

  /**
   * End-of-day balance from the running-balance rows of one day. The end balance is the one that
   * is not the starting point of another row that day (balance − amount), whatever order the
   * export lists them in; when that is ambiguous, file order decides.
   */
  function endOfDay(rows) {
    if (rows.length === 1) return rows[0].balanceCents;
    const before = new Set(rows.map(r => r.balanceCents - r.amountCents));
    const ends = rows.filter(r => !before.has(r.balanceCents));
    if (ends.length === 1) return ends[0].balanceCents;
    const pool = ends.length ? ends : rows;
    // Exports list newest first or oldest first; follow the file's own order for that day.
    const byRow = pool.filter(r => Number.isInteger(r.sourceRow)).sort((a, b) => a.sourceRow - b.sourceRow);
    if (!byRow.length) return pool[pool.length - 1].balanceCents;
    return byRow[0].newestFirst ? byRow[0].balanceCents : byRow[byRow.length - 1].balanceCents;
  }

  /**
   * The days between an entered balance and the account's export, when the balance is dated
   * after the export ends or before the day it starts: { side, from, to, days } or null.
   */
  function gapFor(account, day) {
    const ranges = Array.isArray(account.coverage) ? account.coverage : [];
    if (!ranges.length) return null;
    const first = Math.min(...ranges.map(r => E.dates.dayNumber(r.start)));
    const last = Math.max(...ranges.map(r => E.dates.dayNumber(r.end)));
    if (day > last) return { side: 'after', from: E.dates.fromDayNumber(last + 1), to: E.dates.fromDayNumber(day), days: day - last };
    if (day < first - 1) return { side: 'before', from: E.dates.fromDayNumber(day + 1), to: E.dates.fromDayNumber(first - 1), days: first - 1 - day };
    return null;
  }

  /**
   * Known balances of one account: [{ day, cents, source, gap? }] sorted by day.
   * The export's running balances come first, with the balances supplied with the data
   * (`supplied`: [{ date, cents, source: 'statement'|'bank' }], the supplied figure wins on the
   * same day). An entered balance is used at exactly its date when there is no such figure, or
   * when it is dated after the last one (a newer fact); otherwise the bank's own figure is used.
   * `rows` need a `day` (dates.dayNumber).
   */
  function anchorsFor(account, rows, entered, asOf, supplied) {
    const out = [];
    const withBalance = rows.filter(t => isCents(t.balanceCents));
    if (withBalance.length) {
      // Per export file: newest-first when its first rows are dated later than its last rows.
      const byFile = new Map();
      for (const t of withBalance) {
        const k = t.sourceFile || '';
        if (!byFile.has(k)) byFile.set(k, []);
        byFile.get(k).push(t);
      }
      const newest = new Map();
      for (const [k, list] of byFile) {
        const sorted = list.filter(t => Number.isInteger(t.sourceRow)).sort((a, b) => a.sourceRow - b.sourceRow);
        newest.set(k, sorted.length > 1 && sorted[0].date > sorted[sorted.length - 1].date);
      }
      const byDay = new Map();
      for (const t of withBalance) {
        const d = E.dates.dayNumber(t.date);
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push({ balanceCents: t.balanceCents, amountCents: t.amountCents, sourceRow: t.sourceRow, newestFirst: newest.get(t.sourceFile || '') });
      }
      for (const [day, list] of byDay) out.push({ day, cents: endOfDay(list), source: 'bank' });
    }
    for (const b of Array.isArray(supplied) ? supplied : []) {
      if (!E.dates.isDate(b.date) || !isCents(b.cents)) continue;
      const day = E.dates.dayNumber(b.date);
      const same = out.findIndex(x => x.day === day);
      const anchor = { day, cents: b.cents, source: b.source === 'statement' ? 'statement' : 'bank', supplied: true };
      if (same === -1) out.push(anchor);
      else out[same] = anchor;
    }
    if (isCents(entered) && E.dates.isDate(asOf)) {
      const day = E.dates.dayNumber(asOf);
      const lastBank = out.length ? Math.max(...out.map(a => a.day)) : null;
      if (lastBank === null || day > lastBank) out.push({ day, cents: entered, source: 'entered', gap: gapFor(account, day) });
    }
    return out.sort((a, b) => a.day - b.day);
  }

  /** Merge date ranges into sorted day blocks [{ s, e }] (touching ranges join). */
  function blocksOf(ranges) {
    const spans = ranges.map(r => ({ s: E.dates.dayNumber(r.start), e: E.dates.dayNumber(r.end) })).filter(b => b.s !== null && b.e !== null && b.e >= b.s).sort((a, b) => a.s - b.s);
    const out = [];
    for (const b of spans) {
      const last = out[out.length - 1];
      if (last && b.s <= last.e + 1) last.e = Math.max(last.e, b.e);
      else out.push({ s: b.s, e: b.e });
    }
    return out;
  }

  /** The sentence an account's note uses for a gap between its export and an entered balance. */
  function gapText(gap) {
    const span = gap.days === 1 ? 'The day ' + E.dates.label(gap.from) + ' is' : 'The ' + gap.days + ' days from ' + E.dates.label(gap.from) + ' to ' + E.dates.label(gap.to) + ' are';
    return (gap.side === 'after' ? 'Your export ends ' + E.dates.label(E.dates.addDays(gap.from, -1)) : 'Your export starts ' + E.dates.label(E.dates.addDays(gap.to, 1)))
      + ', the balance is dated ' + E.dates.label(gap.side === 'after' ? gap.to : E.dates.addDays(gap.from, -1)) + '. '
      + span + ' not in your data: no transactions are assumed in them.';
  }

  /**
   * Month-end balances per joint cash account and per group.
   * @param {object[]} txns effective transactions (ledger.applyEdits, no what-if)
   * @param {object} dataset normalized dataset
   * @param {{ entered?: object, asOf?: string|null, enteredAsOf?: object, months?: string[] }} opts
   *   entered = { [accountId]: cents|null }; enteredAsOf = { [accountId]: 'YYYY-MM-DD' } (each
   *   account's own date; asOf for accounts without one)
   * Each account also reports `anchor` (its latest known balance { date, cents, source }), `gap`
   * (days assumed empty between its export and an entered balance), `first` / `last`: the
   * earliest and latest days whose end-of-day balance is known ({ date, cents }), or null, and
   * `assumed`: per month, true when that value was worked across days in the gap.
   */
  function history(txns, dataset, opts = {}) {
    const months = opts.months || E.ledger.months(dataset);
    const entered = isObj(opts.entered) ? opts.entered : {};
    const dates = isObj(opts.enteredAsOf) ? opts.enteredAsOf : {};
    const supplied = suppliedBalances(dataset);
    const accounts = cashAccounts(dataset).map(a => {
      // Rows marked as duplicate copies were never real money; everything else moved the balance.
      const rows = txns.filter(t => t.accountId === a.id && t.excluded !== 'duplicate')
        .map(t => ({ ...t, day: E.dates.dayNumber(t.date) }))
        .sort((x, y) => x.day - y.day);
      const asOf = E.dates.isDate(dates[a.id]) ? dates[a.id] : opts.asOf;
      const anchors = anchorsFor(a, rows, entered[a.id], asOf, supplied.filter(b => b.accountId === a.id));
      // A balance supplied as a statement figure is a bank figure for everything below.
      let source = anchors.length ? (anchors[0].source === 'statement' ? 'bank' : anchors[0].source) : 'change';
      let base = anchors;
      if (!anchors.length) {
        // No known balance: measure the change from the start of the account's first covered day.
        const first = a.coverage.length ? Math.min(...a.coverage.map(r => E.dates.dayNumber(r.start))) : (rows.length ? rows[0].day : null);
        base = first === null ? [] : [{ day: first - 1, cents: 0, source: 'change' }];
      }
      // The gap next to an entered balance counts as covered, with no transactions in it.
      const enteredAnchor = anchors.find(x => x.source === 'entered') || null;
      const gap = enteredAnchor ? enteredAnchor.gap : null;
      const ranges = gap ? a.coverage.concat([{ start: gap.from, end: gap.to }]) : a.coverage;
      const flowBetween = (from, to) => { // sum of flows in (from, to]
        let s = 0;
        for (const t of rows) if (t.day > from && t.day <= to) s += t.amountCents;
        return s;
      };
      const valueAt = end => {
        if (!base.length) return null;
        let anchor = null;
        for (const x of base) { if (x.day <= end) anchor = x; else break; }
        if (anchor) {
          if (!coveredBetween(ranges, anchor.day, end)) return null;
          return anchor.cents + flowBetween(anchor.day, end);
        }
        const after = base[0];
        if (!coveredBetween(ranges, end, after.day)) return null;
        return after.cents - flowBetween(end, after.day);
      };
      const values = months.map(m => valueAt(E.dates.dayNumber(E.months.end(m))));
      // Which month-end values were worked across days in the gap (an assumption, not a fact):
      // the days between the month end and the balance it was worked from overlap the gap.
      const gapLo = gap ? E.dates.dayNumber(gap.from) : null, gapHi = gap ? E.dates.dayNumber(gap.to) : null;
      const viaGap = end => {
        if (!gap || !base.length) return false;
        let from = null;
        for (const x of base) { if (x.day <= end) from = x; else break; }
        const day = from ? from.day : base[0].day;
        const lo = Math.min(day, end) + 1, hi = Math.max(day, end);
        return Math.max(lo, gapLo) <= Math.min(hi, gapHi);
      };
      const assumed = months.map((m, i) => values[i] !== null && viaGap(E.dates.dayNumber(E.months.end(m))));
      // Days with a known end-of-day balance: each anchor and the covered stretch it touches.
      let lo = null, hi = null;
      const blocks = blocksOf(ranges);
      for (const x of base) {
        const b = blocks.find(k => x.day >= k.s - 1 && x.day <= k.e);
        const from = b ? Math.min(b.s - 1, x.day) : x.day;
        const to = b ? Math.max(b.e, x.day) : x.day;
        if (lo === null || from < lo) lo = from;
        if (hi === null || to > hi) hi = to;
      }
      const point = d => (d === null ? null : { date: E.dates.fromDayNumber(d), cents: valueAt(d) });
      const latest = anchors.length ? anchors[anchors.length - 1] : null;
      const bankAndEntered = source === 'bank' && enteredAnchor;
      const ignoredEntered = source === 'bank' && !enteredAnchor && isCents(entered[a.id]) && E.dates.isDate(asOf);
      const fromSupplied = anchors.filter(x => x.supplied);
      const fromRunning = anchors.some(x => x.source === 'bank' && !x.supplied);
      const lastSupplied = fromSupplied.length ? fromSupplied[fromSupplied.length - 1] : null;
      const suppliedText = lastSupplied ? (lastSupplied.source === 'statement' ? 'the statement balance' : 'the bank balance') + ' supplied with your data for ' + E.dates.label(E.dates.fromDayNumber(lastSupplied.day)) : '';
      const bankText = fromRunning ? 'From the running balance in the bank export' + (lastSupplied ? ' and ' + suppliedText : '') : 'From ' + suppliedText;
      const runningOnly = fromRunning && !lastSupplied;
      const lastBankText = runningOnly ? 'the export’s last running balance' : 'the last balance from your bank';
      const ownText = runningOnly ? 'the export’s own figure' : 'the bank’s own figure';
      const note = source === 'bank'
        ? bankText + (bankAndEntered ? ', and the balance you entered for ' + E.dates.label(asOf) + ' after it.' : ignoredEntered ? '. The balance you entered for ' + E.dates.label(asOf) + ' is not newer than ' + lastBankText + ', so ' + ownText + ' is used.' : '.')
        : source === 'entered' ? 'From the balance you entered for ' + E.dates.label(asOf) + ', worked back and forward with the transactions.'
        : 'No balance known: shows the change since ' + (base.length ? E.dates.label(E.dates.fromDayNumber(base[0].day + 1)) : 'the first export') + ', not the balance.';
      return {
        id: a.id, label: a.label, group: a.group, source, values,
        note: note + (gap ? ' ' + gapText(gap) : ''),
        gap: gap || null,
        anchor: latest ? { date: E.dates.fromDayNumber(latest.day), cents: latest.cents, source: latest.source } : null,
        first: anchors.length ? point(lo) : null,
        last: anchors.length ? point(hi) : null,
        assumed,
      };
    });
    const groups = {};
    for (const g of GROUPS) {
      const list = accounts.filter(a => a.group === g);
      // A group is a real balance only when every account in it has one.
      const kind = !list.length ? 'none' : list.every(a => a.source !== 'change') ? 'balance' : 'change';
      const values = months.map((m, i) => {
        if (!list.length) return null;
        const vals = list.map(a => (kind === 'balance' || a.source === 'change' ? a.values[i] : changeOf(a, i)));
        return vals.some(v => v === null) ? null : vals.reduce((s, v) => s + v, 0);
      });
      groups[g] = { label: GROUP_LABEL[g], kind, values, accounts: list.map(a => a.id) };
    }
    const present = GROUPS.filter(g => groups[g].kind !== 'none');
    const totalKind = !present.length ? 'none' : present.every(g => groups[g].kind === 'balance') ? 'balance' : 'change';
    const total = months.map((m, i) => {
      if (!present.length) return null;
      const vals = present.map(g => (totalKind === 'change' && groups[g].kind === 'balance' ? groupChange(groups[g].values, i) : groups[g].values[i]));
      return vals.some(v => v === null) ? null : vals.reduce((s, v) => s + v, 0);
    });
    let latestIndex = -1;
    for (let i = months.length - 1; i >= 0; i--) if (total[i] !== null) { latestIndex = i; break; }
    return {
      months, accounts, groups, total: { kind: totalKind, values: total },
      latest: latestIndex === -1 ? null : { month: months[latestIndex], index: latestIndex, checking: groups.checking.values[latestIndex], savings: groups.savings.values[latestIndex], total: total[latestIndex] },
      complete: totalKind === 'balance',
    };
  }

  // When a group mixes real balances with "change" lines, every line is shown as change since
  // its first known month so the sum still means something.
  function changeOf(account, i) {
    const first = account.values.find(v => v !== null);
    const v = account.values[i];
    return v === null || first === undefined ? null : v - first;
  }
  function groupChange(values, i) {
    const first = values.find(v => v !== null);
    const v = values[i];
    return v === null || first === undefined ? null : v - first;
  }

  /**
   * Who a deposit into the joint accounts comes from: returns txn → 'p1' | 'p2' | null (other).
   *   0. The household's own correction on the row (personBasis 'edit'; 'none' = neither partner).
   *   1. The person a household rule or transfer hint named on the row (personId, basis 'rule').
   *   2. A partner's transfer (contribution) with no person: the one person whose budget has a
   *      contribution stream (several: the one whose per-transfer amount matches).
   *   3. A paycheck deposit with no person: the one person whose paycheck reaches joint (a paycheck
   *      with no joint portion from someone who also sends transfers does not; several: amount match).
   *   4. Any other deposit (not interest) of exactly one person's usual deposit amount (a paycheck's
   *      joint portion or a transfer), e.g. a partner's transfer the import rules do not recognise yet.
   * Interest, refunds and anything unmatched stay "other".
   * The returned function also has `.explain(t)` → { who, basis }: basis 'edit' and 'rule' are the
   * household's own word; 'income' (2–3) and 'amount' (4) are inferred, so they are provisional.
   */
  function incomeAttribution(plan) {
    const incomes = (plan && Array.isArray(plan.incomes) ? plan.incomes : []).filter(i => i && (i.personId === 'p1' || i.personId === 'p2'));
    const contributors = incomes.filter(i => i.kind === 'contribution');
    const sendsTransfers = new Set(contributors.map(i => i.personId));
    const payers = incomes.filter(i => i.kind === 'paycheck' && !(i.jointPerPaycheckCents === null && sendsTransfers.has(i.personId)));
    const pick = (streams, cents) => {
      const people = Array.from(new Set(streams.map(i => i.personId)));
      if (people.length === 1) return people[0];
      const match = streams.filter(i => i.jointPerPaycheckCents === cents || (i.jointPerPaycheckCents === null && i.netPerPaycheckCents === cents));
      const matched = Array.from(new Set(match.map(i => i.personId)));
      return matched.length === 1 ? matched[0] : null;
    };
    const byAmount = cents => {
      const people = Array.from(new Set(incomes.filter(i => Number.isInteger(i.jointPerPaycheckCents) && i.jointPerPaycheckCents > 0 && i.jointPerPaycheckCents === cents).map(i => i.personId)));
      return people.length === 1 ? people[0] : null;
    };
    const inferred = (who, basis) => ({ who, basis: who ? basis : null });
    const explain = t => {
      if (t.personBasis === 'edit') return { who: t.personId === 'p1' || t.personId === 'p2' ? t.personId : null, basis: 'edit' };
      if (t.personId === 'p1' || t.personId === 'p2') return { who: t.personId, basis: 'rule' };
      if (t.kind === 'transfer' && t.subtype === 'contribution') return inferred(pick(contributors, t.amountCents), 'income');
      if (t.kind === 'income' && t.subtype === 'payroll') return inferred(pick(payers, t.amountCents), 'income');
      if (t.kind === 'income' && t.subtype === 'interest') return { who: null, basis: null };
      return inferred(t.amountCents > 0 ? byAmount(t.amountCents) : null, 'amount');
    };
    const attribute = t => explain(t).who;
    attribute.explain = explain;
    return attribute;
  }

  /**
   * Money in, money out and money saved per month (joint accounts, full months only).
   * in = pay and other income + transfers in from personal accounts;
   * out = spending (after refunds) + debt payments + purchases marked as business costs (they
   * still left the account); saved = net moved into savings.
   * With `planning: true`, one-offs left out of the planning baseline are left out of `out`.
   * With `attribute` (from incomeAttribution), each row also has `bySource: { p1, p2, other }`,
   * which adds up to `inCents`.
   */
  function monthlyFlows(txns, dataset, { months, coverageMap, planning = false, attribute = null } = {}) {
    const list = months || E.ledger.months(dataset);
    const cov = coverageMap || E.ledger.coverageMap(dataset);
    const byMonth = new Map(list.map(m => [m, []]));
    // Excluded rows are kept here: summarize() skips them, but business purchases still left the account.
    for (const t of E.ledger.filter(txns, { scope: 'joint', includeExcluded: true })) {
      const m = t.date.slice(0, 7);
      if (byMonth.has(m)) byMonth.get(m).push(t);
    }
    return list.map(m => {
      const status = cov[m] ? cov[m].status : 'none';
      if (status !== 'full') return { month: m, coverage: status, inCents: null, outCents: null, savedCents: null, leftCents: null, ...(attribute ? { bySource: null } : {}) };
      const rows = byMonth.get(m).filter(t => !(planning && t.planningExcluded));
      const s = E.ledger.summarize(rows);
      let business = 0;
      for (const t of rows) if (t.excluded === 'business' && t.kind === 'spend') business += 0 - t.amountCents;
      const inCents = s.incomeCents + s.contributionsCents;
      const outCents = s.spendingCents + s.debtPaymentsCents + business;
      const savedCents = s.savedNetCents;
      const out = { month: m, coverage: status, inCents, outCents, savedCents, leftCents: inCents - outCents - savedCents, businessCents: business };
      if (attribute) {
        const by = { p1: 0, p2: 0, other: 0 };
        for (const t of rows) {
          const v = E.ledger.measure(t);
          const cents = v.incomeCents + v.contributionCents;
          if (cents) by[attribute(t) || 'other'] += cents;
        }
        out.bySource = by;
      }
      return out;
    });
  }

  /** Average of the last `count` full months ending at `endMonth` (default: the latest full one). */
  function usual(flows, { count = 12, endMonth } = {}) {
    const full = flows.filter(f => f.inCents !== null && (!endMonth || f.month <= endMonth));
    const used = full.slice(-count);
    if (!used.length) return { inCents: null, outCents: null, savedCents: null, months: [], count: 0 };
    const avg = key => E.money.divide(used.reduce((s, f) => s + f[key], 0), used.length);
    const out = { inCents: avg('inCents'), outCents: avg('outCents'), savedCents: avg('savedCents'), months: used.map(f => f.month), count: used.length };
    if (used.every(f => f.bySource)) {
      const src = k => E.money.divide(used.reduce((s, f) => s + f.bySource[k], 0), used.length);
      out.bySource = { p1: src('p1'), p2: src('p2'), other: src('other') };
      // Rounded averages can differ from the total's by a cent: "other" absorbs it so the parts add up.
      out.bySource.other += out.inCents - (out.bySource.p1 + out.bySource.p2 + out.bySource.other);
    }
    return out;
  }

  /**
   * What is comfortable to set aside each month: the amount left over (in − out) in at least
   * three of every four recent full months, rounded down to $50 and never below $0. Months vary;
   * an average would be too much in a quarter or more of them.
   * @returns {{ comfortableCents: number|null, typicalLeftCents: number|null, monthsAtLeast: number,
   *             count: number, lowestCents: number|null, highestCents: number|null, months: object[] }}
   */
  function comfortable(flows, { count = 12, endMonth } = {}) {
    const used = flows.filter(f => f.inCents !== null && (!endMonth || f.month <= endMonth)).slice(-count);
    if (!used.length) return { comfortableCents: null, typicalLeftCents: null, monthsAtLeast: 0, count: 0, lowestCents: null, highestCents: null, months: [] };
    const lefts = used.map(f => f.inCents - f.outCents);
    const sorted = lefts.slice().sort((a, b) => a - b);
    const q = sorted[Math.floor(sorted.length * 0.25)];
    const comfortableCents = Math.max(0, Math.floor(q / 5000) * 5000);
    return {
      comfortableCents,
      typicalLeftCents: E.money.divide(lefts.reduce((s, v) => s + v, 0), lefts.length),
      monthsAtLeast: lefts.filter(v => v >= comfortableCents).length,
      count: used.length,
      lowestCents: sorted[0], highestCents: sorted[sorted.length - 1],
      months: used.map((f, i) => ({ month: f.month, leftCents: lefts[i] })),
    };
  }

  /**
   * Month-by-month projection from the latest balances.
   * Each month: checking += in − out − saved and savings += saved (saved < 0 is a drawdown).
   *
   * With `limits` (use them when the starting amounts are real balances), a balance never goes
   * below $0, as in real life:
   *   - a drawdown can only take what savings holds; the rest never reaches checking;
   *   - when checking would go below $0, savings tops it up;
   *   - what neither can cover is a shortfall (it would have to be borrowed or spending cut),
   *     added up in `uncovered`, never shown as a negative balance.
   * Without limits (amounts are only "change since…", balances unknown) it is plain arithmetic.
   * @param {{ startMonth: string, months: number, start: { checking: number|null, savings: number|null },
   *           inCents: number, outCents: number, savedCents: number,
   *           limits?: { checking?: boolean, savings?: boolean } }} o startMonth = first projected month
   * @returns {{ rows: { month, checking, savings, total, uncovered, fromSavings }[], firstShortMonth: string|null,
   *   firstSavingsShortMonth: string|null, savingsEmptyMonth: string|null, firstUncoveredMonth: string|null,
   *   uncoveredCents: number, coveredFromSavingsCents: number, monthlyLeftCents: number, limited: boolean }}
   *   firstShortMonth: the first month checking would go below $0 (with limits: the first month it
   *   needed savings or ran short). firstSavingsShortMonth: the first month savings would go below $0
   *   (without limits) or was emptied (with limits).
   */
  function project(o) {
    if (!E.months.isMonth(o.startMonth)) throw new E.ValidationError('A projection needs a start month.', 'startMonth');
    const n = Math.max(0, Math.min(120, Math.floor(o.months || 0)));
    for (const k of ['inCents', 'outCents', 'savedCents']) {
      if (!isCents(o[k])) throw new E.ValidationError('A projection needs whole-cent amounts for money in, out and saved.', k);
    }
    const lim = isObj(o.limits) ? o.limits : {};
    const floorChecking = lim.checking === true, floorSavings = lim.savings === true;
    const left = o.inCents - o.outCents - o.savedCents;
    let checking = isCents(o.start && o.start.checking) ? o.start.checking : 0;
    let savings = isCents(o.start && o.start.savings) ? o.start.savings : 0;
    const rows = [];
    let firstShortMonth = null, firstSavingsShortMonth = null, savingsEmptyMonth = null, firstUncoveredMonth = null;
    let uncovered = 0, fromSavings = 0;
    for (let i = 0; i < n; i++) {
      const month = E.months.add(o.startMonth, i);
      checking += left;
      savings += o.savedCents;
      if (floorSavings && savings < 0) {
        // A drawdown bigger than what is left in savings: only what is there reaches checking.
        checking += savings;
        savings = 0;
        if (savingsEmptyMonth === null) savingsEmptyMonth = month;
      }
      if (checking < 0 && firstShortMonth === null) firstShortMonth = month;
      if (floorChecking && checking < 0) {
        if (floorSavings && savings > 0) {
          const move = Math.min(savings, 0 - checking);
          savings -= move;
          checking += move;
          fromSavings += move;
          if (savings === 0 && savingsEmptyMonth === null) savingsEmptyMonth = month;
        }
        if (checking < 0) {
          uncovered += 0 - checking;
          checking = 0;
          if (firstUncoveredMonth === null) firstUncoveredMonth = month;
        }
      }
      if (savings < 0 && firstSavingsShortMonth === null) firstSavingsShortMonth = month;
      rows.push({ month, checking, savings, total: checking + savings, uncovered, fromSavings });
    }
    return {
      rows, firstShortMonth, firstSavingsShortMonth: floorSavings ? savingsEmptyMonth : firstSavingsShortMonth, savingsEmptyMonth, firstUncoveredMonth,
      uncoveredCents: uncovered, coveredFromSavingsCents: fromSavings, monthlyLeftCents: left, limited: floorChecking || floorSavings,
    };
  }

  E.balances = { CASH_TYPES, GROUPS, cashAccounts, suppliedBalances, coveredBetween, endOfDay, anchorsFor, gapFor, history, incomeAttribution, monthlyFlows, usual, comfortable, project };
})(typeof globalThis !== 'undefined' ? globalThis : this);
