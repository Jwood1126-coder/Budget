'use strict';
/*
 * BudgetEngine.timeline — the plan screen's whole model in one call: what happened, the plan from
 * a handful of dials, and where the joint balances head, month by month.
 *
 *   build(input)      everything the screen draws, worked out once per render (see build's JSDoc)
 *   anchors(plan, ds) the known balances the line starts from: per account (entered with its own
 *                     date, or the export's running balance), else the one joint cash figure
 *                     ("simple" mode). Forecast reads its starting cash through this too.
 *   settings(raw)     ui.plan with every default filled in
 *   setDial / setRow / resetDial / resetPlan   validated state writes for the screen
 *
 * Months: from the first month with data (or the earliest month a balance can be worked back
 * to) through planStart + horizon − 1. planStart is the month after the last month every
 * spending account's export covers in full. Months before it are 'actual' (incomplete ones carry
 * null amounts: unknown, never $0); a month from planStart on that has some data is 'partial'
 * (what happened so far is kept apart; the plan is used for the projection); the rest are 'plan'.
 *
 * Dials: one "money in" dial per person in the plan (plus "Other money in" when the baseline has
 * deposits nobody can be matched to, or interest), and "money out" dials card, bank, savings
 * (signed: below $0 draws savings down) and other (debt payments, business purchases and
 * investments, only when the baseline has any). Each dial's baseline is the average of the
 * chosen complete months (BudgetEngine.flows.baseline, one-time purchases left out, yearly bills
 * spread). A dial set directly wins; else changes to the card/bank drill-down rows; else the
 * baseline. Amounts are never clamped: integer cents, negatives allowed. In the card and bank
 * drill-downs a stable regular bill (about once a month, every charge within 10% of the median)
 * counts at its latest charge; the dial's baseline is the sum of the rows as they stand by default.
 *
 * Balances: each anchored account is worked back and forward with its own transactions
 * ('reconstructed'); after its last known day each month adds the month's net ('projected').
 * Nothing is floored at $0. The optional "cover from savings" policy moves a projected checking
 * shortfall from savings, per account only; the combined line is the same either way.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const BASELINE_CHOICES = [3, 6, 12, 'all'];
  const HORIZONS = [6, 12, 24, 60];
  const PAST_CHOICES = [6, 12, 'all'];
  const MODES = ['balance', 'flows'];
  const DEFAULTS = Object.freeze({ baselineMonths: 12, horizon: 12, past: 12, mode: 'balance', coverFromSavings: true });
  /** Categories averaging less than this a month (either sign) are grouped into "Other" (when 2 or more). */
  const TINY_CATEGORY_CENTS = 2000;
  /**
   * A regular place is a "stable" bill when it charged at least STABLE_MIN_CHARGES times in the
   * window, about once a month (median charges per month seen = 1), every charge within
   * STABLE_SPREAD of their median. Its plan amount is then its latest charge, not its average.
   */
  const STABLE_MIN_CHARGES = 3;
  const STABLE_SPREAD = 0.1;
  const OTHER_CATEGORY = 'Other';
  const SIMPLE_LABEL = 'Illustrative cash projection from the numbers you entered';
  const RULE = 'Month-end balances are worked back and forward from each known balance with the transactions in your exports (reconstructed). '
    + 'After the last day with a known balance, each month adds that month’s net (projected): checking gets money in − card − bank − debt, business and investments − net to savings; savings gets + net to savings. '
    + 'Plan months use the dials; earlier months use what actually happened. '
    + 'The month of the last known balance adds only part of its net: net × (days left in the month after that date ÷ days in the month), rounded to the cent. '
    + 'Balances may go below $0: nothing is floored or topped up, except that “cover from savings” moves a projected checking shortfall from savings.';
  const SIMPLE_RULE = 'Illustrative: the joint cash you entered plus each month’s money in minus money out (moves to and from savings stay inside joint cash). '
    + 'The month of that balance adds net × (days left in the month after its date ÷ days in the month), rounded to the cent; later months add the full net. Plan months use the dials, earlier months what actually happened.';
  const DIAL_LABEL = { inOther: 'Other money in', card: 'Card spending', bank: 'Bills & mortgage from the bank', savings: 'Net to savings', other: 'Debt, business & investments' };
  const IN_KEYS = ['p1', 'p2'];

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isCents = v => Number.isSafeInteger(v);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const sumKnown = list => E.money.sumKnown(list);

  // ------------------------------------------------------------------ settings

  /** ui.plan with defaults for anything missing or not valid (the engine never trusts its input). */
  function settings(raw) {
    const s = isObj(raw) ? raw : {};
    const pick = (v, list, def) => (list.includes(v) ? v : def);
    const dials = {};
    if (isObj(s.dials)) for (const [k, v] of Object.entries(s.dials)) if (isCents(v)) dials[k] = v;
    const rows = {};
    if (isObj(s.rows)) {
      for (const [k, v] of Object.entries(s.rows)) {
        if (!isObj(v)) continue;
        const o = {};
        if (typeof v.included === 'boolean') o.included = v.included;
        if (isCents(v.cents)) o.cents = v.cents;
        if (Object.keys(o).length) rows[k] = o;
      }
    }
    return {
      baselineMonths: pick(s.baselineMonths, BASELINE_CHOICES, DEFAULTS.baselineMonths),
      horizon: pick(s.horizon, HORIZONS, DEFAULTS.horizon),
      past: pick(s.past, PAST_CHOICES, DEFAULTS.past),
      mode: pick(s.mode, MODES, DEFAULTS.mode),
      coverFromSavings: typeof s.coverFromSavings === 'boolean' ? s.coverFromSavings : DEFAULTS.coverFromSavings,
      dials, rows,
      // null = the household never chose (the screen decides what to show); an array once set.
      hidden: Array.isArray(s.hidden) ? s.hidden.filter(k => typeof k === 'string') : null,
    };
  }

  function rangeText(start, end) {
    if (!start) return '';
    return start === end ? E.months.label(start) : E.months.label(start) + '–' + E.months.label(end);
  }

  // ------------------------------------------------------------------ known balances

  function lastDataDay(dataset) {
    let last = null;
    for (const a of dataset.accounts || []) for (const r of a.coverage || []) if (E.dates.isDate(r.end) && (!last || r.end > last)) last = r.end;
    for (const t of dataset.transactions || []) if (E.dates.isDate(t.date) && (!last || t.date > last)) last = t.date;
    return last;
  }

  /**
   * The known balances a projection starts from.
   * Per account: the balance entered in plan.balances.accounts, true at the end of its own date
   * (plan.balances.accountDates[id], else accountsAsOf, else the last day of that account's export,
   * flagged dateAssumed), or the export's own running balance (the newer of the two wins).
   * When no account has one, the single joint cash figure (jointCashCents / asOf) is used: "simple".
   * @param {object} plan state.plan
   * @param {object} dataset normalized dataset
   * @param {object[]} [txns] effective transactions (rows marked as duplicate copies are skipped);
   *   default: the dataset's own rows
   * @returns {{ simple: boolean, accounts: { id, name, type, group, cents, asOf, source: 'entered'|'bank', dateAssumed: boolean, gap: object|null }[],
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
    const dataEnd = lastDataDay(ds);
    const accounts = [], missing = [], enteredAsOf = {};
    for (const a of E.balances.cashAccounts(ds)) {
      const rows = pool.filter(t => t.accountId === a.id).map(t => Object.assign({}, t, { day: E.dates.dayNumber(t.date) })).sort((x, y) => x.day - y.day);
      const cents = isCents(entered[a.id]) ? entered[a.id] : null;
      let asOf = E.dates.isDate(dates[a.id]) ? dates[a.id] : (E.dates.isDate(bal.accountsAsOf) ? bal.accountsAsOf : null);
      let dateAssumed = false;
      if (cents !== null && !asOf) {
        const ends = a.coverage.map(r => r.end).filter(E.dates.isDate).sort();
        asOf = ends.length ? ends[ends.length - 1] : dataEnd;
        dateAssumed = true;
      }
      if (cents !== null && asOf) enteredAsOf[a.id] = asOf;
      const list = E.balances.anchorsFor(a, rows, cents, asOf);
      if (!list.length) {
        if (rows.length || a.coverage.length) missing.push({ id: a.id, name: a.label, type: a.type });
        continue;
      }
      const last = list[list.length - 1];
      accounts.push({
        id: a.id, name: a.label, type: a.type, group: a.group, cents: last.cents, asOf: E.dates.fromDayNumber(last.day), source: last.source,
        dateAssumed: last.source === 'entered' && dateAssumed, gap: last.gap || null,
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

  // ------------------------------------------------------------------ month amounts

  const IN_EMPTY = people => Object.assign(Object.fromEntries(people.map(p => [p.id, null])), { unassigned: null, other: null, total: null });
  const OUT_EMPTY = () => ({ card: null, bank: null, debt: null, business: null, invest: null, total: null });

  /** One month's amounts from a flows.breakdown `actual` (or planning) object. */
  function fromActual(a, people) {
    const ids = new Set(people.map(p => p.id));
    const inn = {};
    let elsewhere = 0;
    for (const p of people) inn[p.id] = IN_KEYS.includes(p.id) ? a[p.id] : 0;
    for (const k of IN_KEYS) if (!ids.has(k)) elsewhere += a[k];
    inn.unassigned = a.unassigned + elsewhere;
    inn.other = a.interest;
    inn.total = a.moneyIn;
    const out = { card: a.cardNet, bank: a.bankNet, debt: a.debt, business: a.business, invest: a.investNet };
    out.total = out.card + out.bank + out.debt + out.business + out.invest;
    return { in: inn, out, savings: a.savingsNet, net: a.left };
  }

  function dialKeyOf(item, people) {
    switch (item.role) {
      case 'card': case 'bank': return item.role;
      case 'savings': return 'savings';
      case 'debt': case 'business': case 'investment': return 'other';
      case 'credit': return item.who && people.some(p => p.id === item.who) ? item.who : 'inOther';
      case 'interest': return 'inOther';
      default: return null;
    }
  }

  function oneOffItem(x, people, auto) {
    return {
      id: x.id, date: x.date, month: x.date.slice(0, 7), merchant: x.merchant, description: x.description, accountLabel: x.accountLabel,
      role: x.role, dialKey: dialKeyOf(x, people), cents: x.cents, auto,
    };
  }
  const spendCentsOf = list => list.reduce((s, o) => s + (o.role === 'card' || o.role === 'bank' ? o.cents : 0), 0);

  // ------------------------------------------------------------------ hints: observed deposits

  function median(list) {
    const s = list.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  /**
   * The schedule (E.schedule) that explains the most deposits, for semimonthly or monthly pay:
   * { days, matched } — tries the paydays near each deposit's day of the month, with the
   * weekend rule (a Saturday or Sunday payday is paid the Friday before, even in the month before).
   */
  function scheduleFit(list, frequency) {
    const candidates = new Set();
    for (const d of list) {
      const day = Number(d.date.slice(8, 10));
      const dim = E.months.daysIn(d.date.slice(0, 7));
      for (const k of [0, 1, 2]) if (day + k <= 31) candidates.add(day + k > dim ? 31 : day + k);
      if (dim - day <= 2) candidates.add(1);
    }
    const days = Array.from(candidates).sort((a, b) => a - b);
    const span = E.months.range(list[0].date.slice(0, 7), E.months.add(list[list.length - 1].date.slice(0, 7), 1));
    const dates = new Set(list.map(d => d.date));
    const score = stream => {
      const paid = new Set();
      for (const m of span) for (const d of E.schedule.paydays(stream, m) || []) paid.add(d);
      return list.filter(d => paid.has(d.date)).length;
    };
    let best = { days: null, matched: 0 };
    if (frequency === 'monthly') {
      for (const a of days) {
        const n = score({ frequency: 'monthly', monthlyDay: a });
        if (n > best.matched) best = { days: [a], matched: n };
      }
    } else {
      for (const a of days) for (const b of days) {
        if (b - a < 10) continue;
        const n = score({ frequency: 'semimonthly', semimonthlyDays: [a, b] });
        if (n > best.matched) best = { days: [a, b], matched: n };
      }
    }
    return dates.size ? best : { days: null, matched: 0 };
  }

  /**
   * weekly / biweekly / semimonthly / monthly from deposit dates, or null when it is not clear.
   * Biweekly pay lands on the same weekday every 14 days (26 a year); semimonthly pay lands on
   * two days of the month (24 a year): they are told apart, never treated as the same.
   */
  function cadenceOf(list, gaps) {
    if (gaps.length < 2) return { cadence: null, days: null };
    const share = pred => gaps.filter(pred).length / gaps.length;
    if (share(g => g === 7) >= 0.75) return { cadence: 'weekly', days: null };
    const semi = scheduleFit(list, 'semimonthly');
    if (semi.matched >= 3 && semi.matched / list.length >= 0.8) return { cadence: 'semimonthly', days: semi.days };
    if (share(g => g === 14) >= 0.75) return { cadence: 'biweekly', days: null };
    const monthly = scheduleFit(list, 'monthly');
    if (monthly.matched >= 3 && monthly.matched / list.length >= 0.8) return { cadence: 'monthly', days: monthly.days };
    return { cadence: null, days: null };
  }

  /** What one person's deposits into joint looked like in the baseline months (a fact, not applied). */
  function depositHint(credits, pid) {
    const byDate = new Map();
    for (const c of credits) if (c.who === pid && c.cents > 0) byDate.set(c.date, (byDate.get(c.date) || 0) + c.cents);
    const list = Array.from(byDate.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, cents]) => ({ date, cents }));
    if (!list.length) return { count: 0, lastCents: null, lastDate: null, typicalIntervalDays: null, cadence: null, cadenceLabel: null, days: null, perYear: null, perMonthCents: null };
    const gaps = list.slice(1).map((d, i) => E.dates.daysBetween(list[i].date, d.date));
    const { cadence, days } = cadenceOf(list, gaps);
    const last = list[list.length - 1];
    const perYear = cadence ? E.schedule.PER_YEAR[cadence] : null;
    return {
      count: list.length, lastCents: last.cents, lastDate: last.date,
      typicalIntervalDays: gaps.length ? median(gaps) : null,
      cadence, cadenceLabel: cadence ? E.schedule.LABELS[cadence] : null, days, perYear,
      perMonthCents: perYear ? E.money.divide(last.cents * perYear, 12) : null,
    };
  }

  // ------------------------------------------------------------------ drill-down (card, bank)

  const rowIdOf = (dialKey, kind, ...parts) => dialKey + '-' + kind + '-' + E.util.hash(parts.join('\u0001'));

  /** Split `cents` over a purchase's category parts (splits), in whole cents that add up exactly. */
  function allocate(cents, parts, fallbackCategory) {
    if (!parts.length) return [{ category: fallbackCategory || E.categories.UNCATEGORIZED, cents }];
    const total = parts.reduce((s, p) => s + p.spendCents, 0);
    if (total === cents) return parts.map(p => ({ category: p.category, cents: p.spendCents }));
    if (!total) return [{ category: parts[0].category, cents }];
    let used = 0;
    return parts.map((p, i) => {
      const c = i === parts.length - 1 ? cents - used : Math.round(cents * p.spendCents / total);
      used += c;
      return { category: p.category, cents: c };
    });
  }

  /**
   * Categories (level 1) and, under each, the places paid regularly plus everything else (level 2),
   * for one dial. Averages are over the baseline months with one-time purchases left out (they are
   * listed separately) and yearly bills spread, so: dial baseline = Σ category averages and
   * category average = Σ its rows' averages, to the cent.
   */
  function drillFor(key, base, byId, cfg) {
    const n = base.count;
    const spends = (base.spends || []).filter(x => x.role === key && x.kind !== 'oneTime');
    const cats = new Map();
    for (const x of spends) {
      const t = byId.get(x.id);
      const parts = t ? E.ledger.partsOf(t) : [];
      const shares = allocate(x.planCents, parts, t ? t.category : null);
      // The charge itself (before a yearly bill is spread), split the same way.
      const charges = allocate(x.cents, parts, t ? t.category : null);
      shares.forEach((sh, i) => {
        if (!cats.has(sh.category)) cats.set(sh.category, new Map());
        const merchants = cats.get(sh.category);
        if (!merchants.has(x.merchant)) merchants.set(x.merchant, { merchant: x.merchant, regular: false, items: [] });
        const m = merchants.get(x.merchant);
        if (x.kind === 'regular' || x.kind === 'yearly' || x.keepRegular) m.regular = true;
        m.items.push({ id: x.id, date: x.date, month: x.date.slice(0, 7), cents: sh.cents, charge: charges[i] ? charges[i].cents : sh.cents });
      });
    }
    // Charges (purchases, not refunds) of a row: one per transaction, oldest first.
    const chargesOf = items => {
      const byTxn = new Map();
      for (const i of items) {
        if (!byTxn.has(i.id)) byTxn.set(i.id, { id: i.id, date: i.date, month: i.month, cents: 0 });
        byTxn.get(i.id).cents += i.charge;
      }
      return Array.from(byTxn.values()).filter(c => c.cents > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    };
    /** latestCents, latestDate, seenMonths, ofMonths and stable for one level-2 row. */
    const recency = (items, regular) => {
      const charges = chargesOf(items);
      const last = charges.length ? charges[charges.length - 1] : null;
      const perMonth = new Map();
      for (const c of charges) perMonth.set(c.month, (perMonth.get(c.month) || 0) + 1);
      let stable = false;
      if (regular && charges.length >= STABLE_MIN_CHARGES && median(Array.from(perMonth.values())) === 1) {
        const mid = median(charges.map(c => c.cents));
        stable = mid > 0 && charges.every(c => Math.abs(c.cents - mid) <= mid * STABLE_SPREAD);
      }
      return { latestCents: regular && last ? last.cents : null, latestDate: regular && last ? last.date : null, seenMonths: perMonth.size, ofMonths: n, stable };
    };
    const stats = items => ({ total: items.reduce((s, i) => s + i.cents, 0), months: new Set(items.map(i => i.month)).size, txnCount: new Set(items.map(i => i.id)).size });
    // Per real category: its regular places, and the rest.
    const real = Array.from(cats.entries()).map(([category, merchants]) => {
      const regular = Array.from(merchants.values()).filter(m => m.regular).map(m => Object.assign({ category }, m, stats(m.items)));
      const restItems = Array.from(merchants.values()).filter(m => !m.regular).flatMap(m => m.items);
      for (const r of regular) r.avg = E.money.divide(r.total, n);
      const rest = restItems.length ? Object.assign({ items: restItems }, stats(restItems)) : null;
      if (rest) rest.avg = E.money.divide(rest.total, n);
      const avg = regular.reduce((s, r) => s + r.avg, 0) + (rest ? rest.avg : 0);
      return { category, regular, rest, avg, items: Array.from(merchants.values()).flatMap(m => m.items) };
    });
    // Tiny categories (two or more) become one "Other" row; a category called "Other" joins it.
    const tiny = real.filter(c => Math.abs(c.avg) < TINY_CATEGORY_CENTS || c.category === OTHER_CATEGORY);
    const grouped = tiny.length >= 2 ? tiny : [];
    const shown = real.filter(c => !grouped.includes(c)).map(c => ({ label: c.category, members: [c] }));
    shown.sort((a, b) => b.members[0].avg - a.members[0].avg || (a.label < b.label ? -1 : 1));
    if (grouped.length) shown.push({ label: OTHER_CATEGORY, members: grouped });

    const ov = id => (isObj(cfg.rows[id]) ? cfg.rows[id] : null);
    const rows = [];
    const ids = new Set();
    let overridden = false, stableCount = 0;
    for (const g of shown) {
      const catId = rowIdOf(key, 'c', g.label);
      const kids = [];
      for (const c of g.members) {
        for (const m of c.regular) {
          kids.push(Object.assign({ id: rowIdOf(key, 'm', c.category, m.merchant), level: 2, parent: catId, label: m.merchant, kind: 'merchant', category: g.label, sourceCategory: c.category,
            avgCents: m.avg, months: m.months, txnCount: m.txnCount, regular: true }, recency(m.items, true)));
        }
      }
      kids.sort((a, b) => b.avgCents - a.avgCents || (a.label < b.label ? -1 : 1));
      const restItems = g.members.flatMap(c => (c.rest ? c.rest.items : []));
      if (restItems.length) {
        const st = stats(restItems);
        kids.push(Object.assign({ id: rowIdOf(key, 'r', g.label), level: 2, parent: catId, label: (kids.length ? 'Everything else in ' : 'Everything in ') + g.label, kind: 'rest', category: g.label, sourceCategory: null,
          avgCents: g.members.reduce((s, c) => s + (c.rest ? c.rest.avg : 0), 0), months: st.months, txnCount: st.txnCount, regular: false }, recency(restItems, false)));
      }
      for (const k of kids) {
        const o = ov(k.id);
        // Without a change: a stable bill at its latest charge, anything else at its average.
        k.defaultCents = k.stable ? k.latestCents : k.avgCents;
        k.override = o;
        k.included = !(o && o.included === false);
        k.planCents = o && isCents(o.cents) ? o.cents : k.defaultCents;
        if (o) overridden = true;
        if (k.stable) stableCount += 1;
        ids.add(k.id);
      }
      const allItems = g.members.flatMap(c => c.items);
      const st = stats(allItems);
      const o = ov(catId);
      if (o) overridden = true;
      ids.add(catId);
      const childPlan = kids.filter(k => k.included).reduce((s, k) => s + k.planCents, 0);
      rows.push({ id: catId, level: 1, parent: null, label: g.label, kind: 'category', category: g.label, sourceCategory: null,
        members: g.members.map(c => c.category), avgCents: g.members.reduce((s, c) => s + c.avg, 0), months: st.months, txnCount: st.txnCount, regular: false,
        defaultCents: kids.reduce((s, k) => s + k.defaultCents, 0),
        override: o, included: !(o && o.included === false), planCents: o && isCents(o.cents) ? o.cents : childPlan });
      rows.push(...kids);
    }
    const categories = rows.filter(r => r.level === 1);
    return {
      rows,
      categoryCount: categories.length,
      baselineCents: n ? categories.reduce((s, r) => s + r.defaultCents, 0) : null,
      rowsCents: n ? categories.filter(r => r.included).reduce((s, r) => s + r.planCents, 0) : null,
      overridden,
      stableCount,
      orphanIds: Object.keys(cfg.rows).filter(id => id.startsWith(key + '-') && !ids.has(id)),
      tinyCategoryCents: TINY_CATEGORY_CENTS,
    };
  }

  // ------------------------------------------------------------------ dials

  function buildDials({ base, people, cfg, byId, requested }) {
    const n = base.count;
    const T = base.total.planning;
    const avg = cents => (n ? E.money.divide(cents, n) : null);
    const ids = new Set(people.map(p => p.id));
    const range = rangeText(base.start, base.end);
    const windowText = !n ? 'No complete month yet, so there is no baseline'
      : requested === 'all' ? 'Average of all ' + plural(n, 'complete month') + ', ' + range
        : 'Average of ' + range + ', ' + plural(n, 'month') + (n < requested ? ' (all there are)' : '');
    const oneTimeOf = role => base.oneTime.filter(o => o.role === role).length;
    const yearlyOf = role => base.yearly.filter(o => o.role === role).length;
    const resolve = (key, baselineCents, rowsCents, rowsSet) => {
      if (isCents(cfg.dials[key])) return { planCents: cfg.dials[key], source: 'direct' };
      if (rowsSet) return { planCents: rowsCents, source: 'rows' };
      return { planCents: baselineCents, source: 'baseline' };
    };
    const dials = [];
    for (const p of people) {
      const baselineCents = avg(IN_KEYS.includes(p.id) ? T[p.id] : 0);
      dials.push(Object.assign({ key: p.id, group: 'in', label: p.name, baselineCents }, resolve(p.id, baselineCents), {
        basis: windowText, hint: depositHint(base.credits, p.id), drill: null,
      }));
    }
    const elsewhere = IN_KEYS.filter(k => !ids.has(k)).reduce((s, k) => s + T[k], 0);
    const inOtherBase = avg(T.unassigned + T.interest + elsewhere);
    const parts = { interest: avg(T.interest) };
    if ((inOtherBase !== null && inOtherBase !== 0) || isCents(cfg.dials.inOther)) {
      dials.push(Object.assign({ key: 'inOther', group: 'in', label: DIAL_LABEL.inOther, baselineCents: inOtherBase }, resolve('inOther', inOtherBase), {
        basis: windowText + (n ? ' (deposits nobody could be matched to, and interest)' : ''), hint: null, drill: null,
      }));
    }
    for (const key of ['card', 'bank']) {
      const drill = drillFor(key, base, byId, cfg);
      const extra = n ? [oneTimeOf(key) ? plural(oneTimeOf(key), 'one-time item') + ' left out' : '', yearlyOf(key) ? plural(yearlyOf(key), 'yearly bill') + ' spread over 12 months' : ''].filter(Boolean).join(', ') : '';
      dials.push(Object.assign({ key, group: 'out', label: DIAL_LABEL[key], baselineCents: drill.baselineCents }, resolve(key, drill.baselineCents, drill.rowsCents, drill.overridden), {
        basis: windowText + (extra ? '; ' + extra : '') + (drill.stableCount ? '; regular bills at their latest amount' : ''), hint: null, drill,
      }));
    }
    const savingsBase = avg(T.savingsNet);
    dials.push(Object.assign({ key: 'savings', group: 'out', label: DIAL_LABEL.savings, baselineCents: savingsBase }, resolve('savings', savingsBase), {
      basis: windowText + (n ? ' (into savings minus out of savings)' : ''), hint: null, drill: null,
    }));
    const otherBase = avg(T.debt + T.business + T.investNet);
    parts.debt = avg(T.debt);
    parts.business = avg(T.business);
    if ((otherBase !== null && otherBase !== 0) || isCents(cfg.dials.other)) {
      dials.push(Object.assign({ key: 'other', group: 'out', label: DIAL_LABEL.other, baselineCents: otherBase }, resolve('other', otherBase), {
        basis: windowText + (n ? ' (debt payments, business purchases and investments)' : ''), hint: null, drill: null,
      }));
    }
    return { dials, parts, windowText };
  }

  /** The plan month: every amount from the dials (same keys as an actual month). */
  function planMonth(dials, parts, people) {
    const v = key => { const d = dials.find(x => x.key === key); return d ? d.planCents : 0; };
    const inn = {};
    for (const p of people) inn[p.id] = v(p.id);
    const inOther = v('inOther');
    // "Other money in" keeps the baseline's interest apart; the rest is deposits nobody was matched to.
    const interest = inOther === null ? null : (parts.interest || 0);
    inn.other = interest;
    inn.unassigned = inOther === null ? null : inOther - interest;
    inn.total = sumKnown(people.map(p => inn[p.id]).concat([inn.unassigned, inn.other]));
    const other = v('other');
    const out = { card: v('card'), bank: v('bank'), debt: 0, business: 0, invest: 0 };
    if (other === null) { out.debt = null; out.business = null; out.invest = null; }
    else if (other !== 0) {
      // Split like the baseline (debt, business, investments); all of it is debt when the baseline has none.
      const bd = parts.debt || 0, bb = parts.business || 0;
      const baseTotal = dials.find(x => x.key === 'other') ? dials.find(x => x.key === 'other').baselineCents || 0 : 0;
      if (!baseTotal) out.debt = other;
      else if (other === baseTotal) { out.debt = bd; out.business = bb; out.invest = other - bd - bb; }
      else {
        out.debt = Math.round(other * bd / baseTotal);
        out.business = Math.round(other * bb / baseTotal);
        out.invest = other - out.debt - out.business;
      }
    }
    out.total = sumKnown([out.card, out.bank, out.debt, out.business, out.invest]);
    const savings = v('savings');
    const net = inn.total === null || out.total === null || savings === null ? null : inn.total - out.total - savings;
    return { in: inn, out, savings, net };
  }

  // ------------------------------------------------------------------ balances

  const prorate = (cents, daysLeft, daysInMonth) => E.money.divide(cents * daysLeft, daysInMonth);

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
   * A savings account with a known balance but no export of its own is worked back and forward
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
      if (a.group !== 'savings' || a.source !== 'entered' || !acct || acct.coverage.length || live.some(t => t.accountId === a.id)) continue;
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

  function balancesFor({ txns, dataset, plan, months, rowsByMonth, cfg, today, anc, mirrors }) {
    const notes = [];
    const deltaOf = (key, m) => { const r = rowsByMonth.get(m); return r ? r[key] : null; };
    const empty = { month: null, cents: null, status: null, anchor: false, gap: false };
    const base = {
      mode: 'none', simple: false, label: null, rule: RULE, accounts: [], missing: anc.missing.slice(), combined: null,
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
          ha = Object.assign({}, ha, { note: 'From the balance you entered for ' + E.dates.label(a.asOf) + ', ' + why + (ha.gap ? ha.note.slice(ha.note.indexOf(' Your export')) : '') });
          notes.push(a.name + ': ' + why);
        }
        const lastDay = E.dates.dayNumber(ha.last.date);
        const isPrimary = primary[a.group] === a.id;
        const deltaKey = a.group === 'savings' ? 'savings' : 'net';
        const proj = projectFrom(months, lastDay, ha.last.cents, m => (isPrimary ? deltaOf(deltaKey, m) : 0));
        const gap = ha.gap;
        const gapFrom = gap ? E.dates.dayNumber(gap.from) : null, gapTo = gap ? E.dates.dayNumber(gap.to) : null;
        const anchorMonth = ha.anchor ? ha.anchor.date.slice(0, 7) : null;
        const points = months.map((m, i) => {
          const end = E.dates.dayNumber(E.months.end(m));
          if (end <= lastDay) {
            // gap: this month-end falls in the days assumed to have no transactions.
            const v = ha.values[i];
            return { month: m, cents: v, status: v === null ? null : 'reconstructed', anchor: m === anchorMonth, gap: v !== null && gap !== null && end >= gapFrom && end <= gapTo };
          }
          const v = proj.has(i) ? proj.get(i) : null;
          return { month: m, cents: v, status: v === null ? null : 'projected', anchor: m === anchorMonth, gap: false };
        });
        return {
          id: a.id, name: a.name, type: a.type, group: a.group, primary: isPrimary, source: a.source,
          anchor: ha.anchor, dateAssumed: a.dateAssumed, gap, known: { from: ha.first.date, to: ha.last.date },
          mirroredFrom: mirror ? { id: mirror.source.id, name: mirror.source.name } : null,
          note: ha.note + (a.dateAssumed ? ' No date was entered for this balance, so it counts as of ' + E.dates.label(ha.anchor.date) + ', the last day of the export.' : '')
            + (isPrimary ? '' : ' Not the main ' + a.group + ' account: kept level after ' + E.dates.label(ha.last.date) + '.'),
          points,
        };
      });
      for (const a of accounts) {
        if (a.gap && a.note.includes('Your export')) notes.push(a.name + ': ' + a.note.slice(a.note.indexOf('Your export')));
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
        return {
          month: m, cents: ps.reduce((s, p) => s + p.cents, 0),
          status: ps.some(p => p.status === 'projected') ? 'projected' : 'reconstructed',
          anchor: ps.some(p => p.anchor), gap: ps.some(p => p.gap),
        };
      });
      Object.assign(base, {
        mode: 'accounts', accounts,
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
        return { month: m, cents: v, status: v === null ? null : 'projected', anchor: m === anchorMonth, gap: false };
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

  // ------------------------------------------------------------------ build

  /**
   * Everything the plan screen shows, in one call.
   * @param {{ txns: object[], dataset: object, plan: object, settings?: object, today: string,
   *   coverageMap?: object }} input
   *   txns: effective transactions (ledger.applyEdits, no what-if; planning-baseline edits are
   *   read from them); plan: state.plan; settings: state.ui.plan; today: 'YYYY-MM-DD' (explicit,
   *   so results are reproducible); coverageMap: ledger.coverageMap(dataset) when already known.
   * @returns {object} see docs/ARCHITECTURE.md (BudgetEngine.timeline)
   */
  function build(input) {
    if (!isObj(input) || !isObj(input.dataset)) throw new E.ValidationError('The timeline needs the data set.', 'dataset');
    if (!E.dates.isDate(input.today)) throw new E.ValidationError('The timeline needs today’s date (YYYY-MM-DD).', 'today');
    const dataset = input.dataset;
    const txns = Array.isArray(input.txns) ? input.txns : [];
    const plan = isObj(input.plan) ? input.plan : {};
    const cfg = settings(input.settings);
    const today = input.today;
    const todayMonth = today.slice(0, 7);
    const people = (Array.isArray(plan.people) ? plan.people : []).filter(p => isObj(p) && typeof p.id === 'string' && p.id)
      .map(p => ({ id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id }));

    const dataMonths = E.ledger.months(dataset);
    const cov = isObj(input.coverageMap) ? input.coverageMap : E.ledger.coverageMap(dataset);
    const covOf = m => cov[m] || null;
    let lastComplete = null;
    for (let i = dataMonths.length - 1; i >= 0; i--) if (covOf(dataMonths[i]) && covOf(dataMonths[i]).status === 'full') { lastComplete = dataMonths[i]; break; }
    const planStart = lastComplete ? E.months.add(lastComplete, 1) : (dataMonths.length ? dataMonths[0] : todayMonth);
    const lastMonth = E.months.add(planStart, cfg.horizon - 1);

    const rows = E.flows.breakdown(txns, dataset, { months: dataMonths, coverageMap: cov, plan });
    const full = rows.filter(r => r.actual).length;
    const requested = cfg.baselineMonths;
    const base = E.flows.baseline(rows, { count: requested === 'all' ? Math.max(full, 1) : requested, endMonth: lastComplete || undefined });
    const byId = new Map(txns.map(t => [t.id, t]));
    const { dials, parts, windowText } = buildDials({ base, people, cfg, byId, requested });
    const planValues = planMonth(dials, parts, people);

    // What happened so far in partly covered months (kept apart from the month's amounts).
    const partial = dataMonths.filter(m => covOf(m) && covOf(m).status === 'partial');
    const soFar = new Map(E.flows.breakdown(txns, dataset, { months: partial, coverageMap: Object.fromEntries(partial.map(m => [m, { status: 'full' }])), plan }).map(r => [r.month, r]));
    const autoOneTime = base.oneTime.filter(o => o.auto).map(o => oneOffItem(o, people, true));
    const oneOffsIn = (r, m) => {
      const manual = r.oneOffs.map(o => oneOffItem(o, people, false));
      const seen = new Set(manual.map(o => o.id));
      return manual.concat(autoOneTime.filter(o => o.month === m && !seen.has(o.id)));
    };

    // Months: from the first month with data, or earlier when a balance is known before it.
    const anc = anchors(plan, dataset, txns);
    let first = dataMonths.length ? dataMonths[0] : planStart;
    const earlier = d => { if (E.dates.isDate(d) && d.slice(0, 7) < first) first = d.slice(0, 7); };
    for (const a of E.balances.cashAccounts(dataset)) {
      const starts = a.coverage.map(r => r.start).filter(E.dates.isDate).sort();
      if (starts.length && anc.accounts.some(x => x.id === a.id)) earlier(E.dates.addDays(starts[0], -1));
    }
    const mirrors = mirrorPlan(anc, dataset, txns);
    for (const m of mirrors.byId.values()) {
      const starts = m.source.coverage.map(r => r.start).filter(E.dates.isDate).sort();
      if (starts.length) earlier(E.dates.addDays(starts[0], -1));
    }
    for (const d of Object.values(anc.enteredAsOf)) earlier(d);
    if (anc.simple && anc.combined && anc.combined.asOf) earlier(anc.combined.asOf);
    if (first > planStart) first = planStart;
    let months = E.months.range(first, lastMonth);

    const rowByMonth = new Map(rows.map(r => [r.month, r]));
    const monthRows = months.map(m => {
      const c = covOf(m);
      const coverage = c ? c.status : 'none';
      const r = rowByMonth.get(m);
      const sf = soFar.get(m);
      const actualSoFar = sf && sf.actual ? Object.assign(fromActual(sf.actual, people), {
        oneOffs: oneOffsIn(sf, m), oneOffCents: spendCentsOf(oneOffsIn(sf, m)), coveredDays: c.coveredDays, totalDays: c.totalDays,
      }) : null;
      if (m < planStart) {
        if (r && r.actual) {
          const oneOffs = oneOffsIn(r, m);
          return Object.assign({ month: m, status: 'actual', current: m === todayMonth, complete: true, coverage }, fromActual(r.actual, people), { oneOffs, oneOffCents: spendCentsOf(oneOffs), actualSoFar: null });
        }
        return { month: m, status: 'actual', current: m === todayMonth, complete: false, coverage, in: IN_EMPTY(people), out: OUT_EMPTY(), savings: null, net: null, oneOffs: [], oneOffCents: null, actualSoFar };
      }
      return {
        month: m, status: coverage === 'partial' ? 'partial' : 'plan', current: m === todayMonth, complete: false, coverage,
        in: Object.assign({}, planValues.in), out: Object.assign({}, planValues.out), savings: planValues.savings, net: planValues.net,
        oneOffs: [], oneOffCents: 0, actualSoFar,
      };
    });
    const rowsByMonth = new Map(monthRows.map(r => [r.month, r]));
    const balances = balancesFor({ txns, dataset, plan, months, rowsByMonth, cfg, today, anc, mirrors });

    // Leading months before the data with no known balance add nothing: drop them.
    const dataStart = dataMonths.length ? dataMonths[0] : planStart;
    let drop = 0;
    while (drop < months.length && months[drop] < dataStart) {
      const known = (balances.combined && balances.combined.points[drop].cents !== null) || balances.accounts.some(a => a.points[drop].cents !== null);
      if (known) break;
      drop++;
    }
    if (drop) {
      months = months.slice(drop);
      monthRows.splice(0, drop);
      for (const a of balances.accounts) a.points = a.points.slice(drop);
      if (balances.combined) balances.combined.points = balances.combined.points.slice(drop);
    }

    const pastFrom = cfg.past === 'all' ? months[0] : (E.months.add(planStart, 0 - cfg.past) < months[0] ? months[0] : E.months.add(planStart, 0 - cfg.past));
    const spendOneTime = base.oneTime.map(o => oneOffItem(o, people, o.auto));
    const seen = new Set(spendOneTime.map(o => o.id));
    const otherOneTime = base.oneOffs.filter(o => !seen.has(o.id) && o.role !== 'card' && o.role !== 'bank').map(o => oneOffItem(o, people, false));
    const oneTime = spendOneTime.concat(otherOneTime);
    const dialsByKey = Object.fromEntries(dials.map(d => [d.key, d]));

    return {
      today, todayMonth, planStart, lastComplete, firstMonth: months[0], lastMonth, horizon: cfg.horizon,
      months: monthRows,
      window: { past: cfg.past, from: pastFrom, to: lastMonth, fromIndex: months.indexOf(pastFrom) },
      people,
      dials, dialsByKey,
      groups: { in: dials.filter(d => d.group === 'in').map(d => d.key), out: dials.filter(d => d.group === 'out').map(d => d.key) },
      plan: planValues,
      changed: dials.some(d => d.source !== 'baseline'),
      baseline: {
        setting: requested, count: base.count, months: base.months, start: base.start, end: base.end, label: windowText,
        oneTime, oneTimeCents: spendCentsOf(oneTime),
        keptIn: base.keptRegular.map(o => oneOffItem(o, people, true)),
        yearly: base.yearly.map(o => Object.assign(oneOffItem(o, people, true), { spreadCents: o.spreadCents })),
      },
      balances,
      settings: cfg,
    };
  }

  // ------------------------------------------------------------------ state writes for the screen

  function planUi(state) { return state && isObj(state.ui) && isObj(state.ui.plan) ? state.ui.plan : {}; }

  /** Set one dial directly (cents, may be negative), or clear it with null/undefined (back to rows or baseline). */
  function setDial(state, key, cents) {
    return E.state.setPath(state, 'ui.plan.dials.' + key, cents === null ? undefined : cents);
  }

  /**
   * Change one drill-down row: patch { included?: boolean, cents?: number|null }. null/undefined
   * clears that part; included: true is the default and is not stored. An empty change is removed.
   */
  function setRow(state, id, patch) {
    const cur = isObj(planUi(state).rows) && isObj(planUi(state).rows[id]) ? planUi(state).rows[id] : {};
    const next = Object.assign({}, cur);
    for (const k of ['included', 'cents']) {
      if (!isObj(patch) || !Object.prototype.hasOwnProperty.call(patch, k)) continue;
      if (patch[k] === undefined || patch[k] === null) delete next[k];
      else next[k] = patch[k];
    }
    if (next.included === true) delete next.included;
    return E.state.setPath(state, 'ui.plan.rows.' + id, Object.keys(next).length ? next : undefined);
  }

  /** Put one dial back to its baseline: its direct amount and every change to its rows are removed. */
  function resetDial(state, key) {
    const p = planUi(state);
    let next = setDial(state, key, undefined);
    for (const id of Object.keys(isObj(p.rows) ? p.rows : {})) if (id.startsWith(key + '-')) next = E.state.setPath(next, 'ui.plan.rows.' + id, undefined);
    return next;
  }

  /** Every dial and row back to the baseline (other plan settings stay). */
  function resetPlan(state) {
    const p = planUi(state);
    let next = state;
    for (const k of Object.keys(isObj(p.dials) ? p.dials : {})) next = E.state.setPath(next, 'ui.plan.dials.' + k, undefined);
    for (const id of Object.keys(isObj(p.rows) ? p.rows : {})) next = E.state.setPath(next, 'ui.plan.rows.' + id, undefined);
    return next;
  }

  E.timeline = {
    BASELINE_CHOICES, HORIZONS, PAST_CHOICES, MODES, DEFAULTS, TINY_CATEGORY_CENTS, STABLE_MIN_CHARGES, STABLE_SPREAD, OTHER_CATEGORY, SIMPLE_LABEL, RULE, SIMPLE_RULE,
    build, anchors, settings, depositHint, prorate, setDial, setRow, resetDial, resetPlan,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
