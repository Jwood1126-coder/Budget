'use strict';
/*
 * BudgetEngine.timeline — the plan screen's whole model in one call: what happened, the plan from
 * a handful of dials and dated planned changes, and where the joint balances head, month by month.
 *
 *   build(input)      everything the screen draws, worked out once per render (see build's JSDoc)
 *   anchors(plan, ds) the known balances the line starts from: per account (entered with its own
 *                     date, a balance supplied with the data, or the export's running balance),
 *                     else the one joint cash figure ("simple" mode). Forecast reads its starting
 *                     cash through this too.
 *   settings(raw)     ui.plan with every default filled in
 *   toCSV(tl, opts)   the plan as a spreadsheet: its settings, then one row per month
 *   templates         ready-made planned changes (templates.baby(dueDate)), never accepted for you
 *   setDial / setRow / resetDial / resetPlan / setGroup / setIrregular / addChange / setChange /
 *   removeChange / acceptChanges / migrateRows   validated state writes for the screen
 *
 * Months: from the first month with data (or the earliest month a balance can be worked back
 * to) through planStart + horizon − 1. planStart is the month after the last month every
 * spending account's export covers in full. Months before it are 'actual' (incomplete ones carry
 * null amounts: unknown, never $0); a month from planStart on that has some data is 'partial'
 * (what happened so far is kept apart; the plan is used for the projection); the rest are 'plan'.
 *
 * Dials: one "money in" dial per person in the plan, at the pay saved in Budget (flows.planFunding,
 * annual-average timing) or, when that is not known, the deposit average labelled as not confirmed
 * (plus "Other money in" when the baseline has deposits nobody can be matched to, or interest),
 * and "money out" dials grouped by how adjustable the spending is: essentials (categories the
 * taxonomy marks essential, or the household moved there), flexible (the rest of everyday
 * spending), irregular (every one-time cost of the baseline months, spread per month), savings
 * (signed: below $0 draws savings down) and other (debt payments, business purchases and
 * investments, only when the baseline has any). Card and bank spending are no longer dials: they
 * are worked out from the spending dials (each row knows how it was paid), because the account
 * lines take card spending from checking when it happens.
 * Each dial's baseline is the average of the chosen complete months (BudgetEngine.flows.baseline,
 * yearly bills spread). A dial set directly wins; else changes to its drill-down rows (or, for
 * irregular, the one-time costs left out); else the baseline. Amounts are never clamped: integer
 * cents, negatives allowed. In the essentials and flexible drill-downs a stable regular bill
 * (about once a month, every charge within 10% of the median) counts at its latest charge; the
 * dial's baseline is the sum of the rows as they stand by default. Nothing is left out of the plan
 * automatically: every one-time cost is in the irregular allowance, counted as regular spending
 * (the planningBaseline 'include' edit) or left out by the household (ui.plan.irregularOff).
 *
 * Planned changes (plan.changes): accepted changes with an amount add to plan months from their
 * start month (one-time: that month only; monthly: through the end month when set). A change
 * without an amount is listed and reported, never applied as $0.
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
  const MODES = ['balance', 'flows', 'trends'];
  const TREND_MA = [0, 3, 6];
  const DEFAULTS = Object.freeze({ baselineMonths: 12, horizon: 12, past: 12, mode: 'balance', coverFromSavings: true });
  const TREND_DEFAULTS = Object.freeze({ series: Object.freeze(['card']), ma: 3, trend: true });
  /** The spending groups of everyday spending, by how adjustable it is. */
  const SPEND_GROUPS = ['essentials', 'flexible'];
  /** The money-out dials, in the order the screen shows them ('other' only when it has an amount). */
  const OUT_DIALS = ['essentials', 'flexible', 'irregular', 'savings', 'other'];
  /** ui.plan.groups key that moves one place (merchant) to a group of its own choosing. */
  const MERCHANT_KEY = 'merchant:';
  const CHANGE_KINDS = ['oneTime', 'monthly'];
  const CHANGE_GROUPS = ['income', 'essentials', 'flexible', 'irregular', 'savings'];
  /** Dial keys that existed before spending was grouped by how adjustable it is (rows: '<key>-c|m|r-<hash>'). */
  const LEGACY_DIALS = ['card', 'bank'];
  /** The spending dials: each has a card and a bank part. */
  const SPEND_DIALS = ['essentials', 'flexible', 'irregular'];
  const SHORT_LABEL = { essentials: 'Essentials', flexible: 'Flexible', irregular: 'Irregular' };
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
    + 'After the last day with a known balance, each month adds that month’s net (projected): checking gets money in − spending (essentials, flexible and irregular) − debt, business and investments − net to savings; savings gets + net to savings. '
    + 'Plan months use the dials and the planned changes you accepted; earlier months use what actually happened. '
    + 'The month of the last known balance adds only part of its net: net × (days left in the month after that date ÷ days in the month), rounded to the cent. '
    + 'Balances may go below $0: nothing is floored or topped up, except that “cover from savings” moves a projected checking shortfall from savings.';
  const SIMPLE_RULE = 'Illustrative: the joint cash you entered plus each month’s money in minus money out (moves to and from savings stay inside joint cash). '
    + 'The month of that balance adds net × (days left in the month after its date ÷ days in the month), rounded to the cent; later months add the full net. Plan months use the dials and the planned changes you accepted, earlier months what actually happened.';
  const ILLUSTRATIVE = 'Account lines are illustrative: card spending is taken from checking in the month it happens, not when the card is paid; the combined line is not affected.';
  const DIAL_LABEL = { inOther: 'Other money in', essentials: 'Essentials', flexible: 'Flexible spending', irregular: 'Irregular costs', savings: 'Net to savings', other: 'Debt, business & investments' };
  const IN_KEYS = ['p1', 'p2'];
  /** Words for what one-time costs were, by category (the irregular dial's basis); others are lower-cased. */
  const IRREGULAR_WORDS = {
    'Dental': 'dental work', 'Vision': 'eye care', 'Medical & pharmacy': 'medical bills', 'Travel': 'trips',
    'Home maintenance & repairs': 'repairs', 'Auto maintenance': 'car repairs', 'Property tax & HOA': 'tax',
    'Home improvement': 'home projects', 'Gifts & donations': 'gifts', 'Auto insurance': 'insurance',
    'Home insurance': 'insurance', 'Life insurance': 'insurance', 'Other insurance': 'insurance', 'Fees & interest': 'fees',
  };
  /** The monthly series the Trends chart can draw (person series 'in-<personId>' come first). */
  const SERIES = [
    { key: 'in-other', name: 'Other money in', group: 'in' },
    { key: 'in-total', name: 'All money in', group: 'in' },
    { key: 'card', name: 'Card purchases', group: 'out' },
    { key: 'bank', name: 'Paid from the bank', group: 'out' },
    { key: 'essentials', name: 'Essentials', group: 'out' },
    { key: 'flexible', name: 'Flexible spending', group: 'out' },
    { key: 'irregular', name: 'Irregular costs', group: 'out' },
    { key: 'other-out', name: 'Debt, business & investments', group: 'out' },
    { key: 'out-total', name: 'All money out', group: 'out' },
    { key: 'to-savings', name: 'Into savings', group: 'savings' },
    { key: 'from-savings', name: 'Out of savings', group: 'savings' },
    { key: 'net', name: 'Left in checking', group: 'net' },
    { key: 'combined-change', name: 'Change in joint cash', group: 'net' },
  ];
  const SERIES_KEYS = new Set(SERIES.map(s => s.key));
  const isSeriesKey = k => typeof k === 'string' && (SERIES_KEYS.has(k) || /^in-[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(k));

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isCents = v => Number.isSafeInteger(v);
  const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
  const own = (o, k) => (has(o, k) ? o[k] : undefined);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const sumKnown = list => E.money.sumKnown(list);
  /** Whole cents, never −0 (−0 and 0 are the same amount, but not the same value to a strict comparison). */
  const roundCents = x => Math.round(x) || 0;
  const fail = (message, field) => { throw new E.ValidationError(message, field); };

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
    const groups = {};
    if (isObj(s.groups)) for (const [k, v] of Object.entries(s.groups)) if (k.trim() && SPEND_GROUPS.includes(v)) groups[k.trim()] = v;
    const irregularOff = {};
    if (isObj(s.irregularOff)) for (const [k, v] of Object.entries(s.irregularOff)) if (v === true) irregularOff[k] = true;
    const t = isObj(s.trends) ? s.trends : {};
    // Amounts set for the earlier card and bank dials, waiting to be carried over (migrateDials);
    // one still among the dials (a budget not checked by state.sanitize) is newer and wins.
    const legacyDials = {};
    if (isObj(s.legacyDials)) for (const k of LEGACY_DIALS) if (isCents(own(s.legacyDials, k))) legacyDials[k] = s.legacyDials[k];
    for (const k of LEGACY_DIALS) {
      if (isCents(own(dials, k))) legacyDials[k] = dials[k];
      delete dials[k];
    }
    const cardSplit = {};
    if (isObj(s.cardSplit)) {
      for (const k of SPEND_DIALS) {
        const v = own(s.cardSplit, k);
        if (isObj(v) && isCents(v.cents) && isCents(v.card)) cardSplit[k] = { cents: v.cents, card: v.card };
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
      groups, irregularOff, legacyDials, cardSplit,
      trends: {
        series: Array.isArray(t.series) ? Array.from(new Set(t.series.filter(isSeriesKey))) : TREND_DEFAULTS.series.slice(),
        ma: pick(t.ma, TREND_MA, TREND_DEFAULTS.ma),
        trend: typeof t.trend === 'boolean' ? t.trend : TREND_DEFAULTS.trend,
      },
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

  // ------------------------------------------------------------------ month amounts

  const IN_EMPTY = people => Object.assign(Object.fromEntries(people.map(p => [p.id, null])), { unassigned: null, other: null, total: null });
  const OUT_EMPTY = () => ({ essentials: null, flexible: null, irregular: null, card: null, bank: null, debt: null, business: null, invest: null, other: null, total: null });

  /**
   * One month's amounts from a flows.breakdown `actual` object and its spending by group
   * ({ essentials, flexible, irregular }, which add up to card + bank).
   */
  function fromActual(a, people, g) {
    const ids = new Set(people.map(p => p.id));
    const inn = {};
    let elsewhere = 0;
    for (const p of people) inn[p.id] = IN_KEYS.includes(p.id) ? a[p.id] : 0;
    for (const k of IN_KEYS) if (!ids.has(k)) elsewhere += a[k];
    inn.unassigned = a.unassigned + elsewhere;
    inn.other = a.interest;
    inn.total = a.moneyIn;
    const out = { essentials: g.essentials, flexible: g.flexible, irregular: g.irregular, card: a.cardNet, bank: a.bankNet, debt: a.debt, business: a.business, invest: a.investNet };
    out.other = out.debt + out.business + out.invest;
    out.total = out.card + out.bank + out.other;
    return { in: inn, out, savings: a.savingsNet, net: a.left, combinedChange: inn.total - out.total };
  }

  function dialKeyOf(item, people) {
    switch (item.role) {
      case 'card': case 'bank': return 'irregular';
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


  // ------------------------------------------------------------------ spending groups

  /** The group a category is planned in: the household's choice (ui.plan.groups), else the taxonomy's `essential` flag. */
  function categoryGroup(category, cfg) {
    const chosen = own(cfg.groups, category);
    if (SPEND_GROUPS.includes(chosen)) return { group: chosen, source: 'override' };
    return { group: E.categories.isEssential(category) ? 'essentials' : 'flexible', source: 'taxonomy' };
  }

  /** The group a place was moved to as a whole (ui.plan.groups['merchant:' + merchant]), or null. */
  function merchantGroup(merchant, cfg) {
    const chosen = own(cfg.groups, MERCHANT_KEY + String(merchant).trim());
    return SPEND_GROUPS.includes(chosen) ? chosen : null;
  }

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
   * One card or bank purchase (a flows spend) split over its categories, each part with the
   * group it is planned in; `moved` when the whole place was moved to a group of its own.
   */
  function sharesOf(x, cents, byId, cfg) {
    const t = byId.get(x.id);
    const parts = t ? E.ledger.partsOf(t) : [];
    const moved = merchantGroup(x.merchant, cfg);
    return allocate(cents, parts, t ? t.category : null).map(sh => ({ category: sh.category, cents: sh.cents, group: moved || categoryGroup(sh.category, cfg).group, moved: !!moved }));
  }

  /**
   * A month's card and bank spending by group: one-time costs (kindOf: id -> flows kind) are
   * irregular, everything else essentials or flexible. The three add up to card + bank.
   */
  function spendGroups(spends, kindOf, byId, cfg) {
    const g = { essentials: 0, flexible: 0, irregular: 0 };
    for (const x of spends || []) {
      if (kindOf.get(x.id) === 'oneTime') { g.irregular += x.cents; continue; }
      for (const sh of sharesOf(x, x.cents, byId, cfg)) g[sh.group] += sh.cents;
    }
    return g;
  }

  // ------------------------------------------------------------------ drill-down (essentials, flexible)

  /**
   * Categories (level 1) and, under each, the places paid regularly plus everything else (level 2),
   * for one spending group. Averages are over the baseline months with one-time costs left out
   * (they are the irregular dial) and yearly bills spread, so: dial baseline = Σ category defaults
   * and category average = Σ its rows' averages, to the cent. A place moved to a group as a whole
   * becomes a category row of its own (synthetic) holding just that place.
   * Every row says how it was paid (paidBy, cardShare) so card and bank totals can be worked out
   * from it; cardCents/bankCents split its plan amount (at its default: card and bank averages
   * exactly; otherwise planCents × cardShare, rounded).
   * Rows changed under the earlier card/bank dials ('card-…', 'bank-…') still apply to the same
   * row when it is paid only that way (returned in `legacy` for migrateRows).
   */
  function drillFor(group, base, byId, cfg) {
    const n = base.count;
    const regularAt = base.regularAt || 2;
    const empty = { kind: 'categories', group, rows: [], categoryCount: 0, baselineCents: null, rowsCents: null, baselineCardCents: null, rowsCardCents: null,
      cardShare: 0, overridden: false, stableCount: 0, yearlyCount: 0, orphanIds: Object.keys(cfg.rows).filter(id => id.startsWith(group + '-')), tinyCategoryCents: TINY_CATEGORY_CENTS, legacy: [], superseded: [] };
    if (!n) return empty;
    const cats = new Map();
    const yearly = new Set();
    for (const x of base.spends || []) {
      if (x.kind === 'oneTime') continue;
      const shares = sharesOf(x, x.planCents, byId, cfg);
      // The charge itself (before a yearly bill is spread), split the same way.
      const charges = sharesOf(x, x.cents, byId, cfg);
      shares.forEach((sh, i) => {
        if (sh.group !== group) return;
        const key = sh.moved ? MERCHANT_KEY + x.merchant : sh.category;
        if (!cats.has(key)) cats.set(key, { category: sh.moved ? x.merchant : sh.category, synthetic: sh.moved, merchants: new Map() });
        const merchants = cats.get(key).merchants;
        if (!merchants.has(x.merchant)) merchants.set(x.merchant, { merchant: x.merchant, regular: false, items: [] });
        const m = merchants.get(x.merchant);
        if (x.kind === 'regular' || x.kind === 'yearly' || x.keepRegular) m.regular = true;
        if (x.kind === 'yearly') yearly.add(x.id);
        m.items.push({ id: x.id, date: x.date, month: x.date.slice(0, 7), cents: sh.cents, charge: charges[i] ? charges[i].cents : sh.cents, route: x.role === 'card' ? 'card' : 'bank', category: sh.category });
      });
    }
    // Charges (purchases, not refunds) of a row: one per transaction, oldest first.
    const chargesOf = items => {
      const byTxn = new Map();
      for (const i of items) {
        if (!byTxn.has(i.id)) byTxn.set(i.id, { id: i.id, date: i.date, month: i.month, cents: 0, route: i.route });
        byTxn.get(i.id).cents += i.charge;
      }
      return Array.from(byTxn.values()).filter(c => c.cents > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    };
    /** latestCents, latestDate, seenMonths, ofMonths and stable for one level-2 row (route: how the latest charge was paid). */
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
      return { facts: { latestCents: regular && last ? last.cents : null, latestDate: regular && last ? last.date : null, seenMonths: perMonth.size, ofMonths: n, stable }, route: last ? last.route : null };
    };
    const stats = items => {
      let card = 0, bank = 0, cardAbs = 0, bankAbs = 0;
      for (const i of items) {
        if (i.route === 'card') { card += i.cents; cardAbs += Math.abs(i.cents); } else { bank += i.cents; bankAbs += Math.abs(i.cents); }
      }
      const cardAvg = E.money.divide(card, n), bankAvg = E.money.divide(bank, n);
      return { total: card + bank, card, bank, cardAbs, bankAbs, cardAvg, bankAvg, avg: cardAvg + bankAvg, months: new Set(items.map(i => i.month)).size, txnCount: new Set(items.map(i => i.id)).size };
    };
    const paidByOf = st => (st.cardAbs && st.bankAbs ? 'mixed' : st.cardAbs ? 'card' : 'bank');
    const shareOf = st => (st.cardAbs + st.bankAbs ? st.cardAbs / (st.cardAbs + st.bankAbs) : 0);
    const patternOf = (regular, stable, seen) => (regular && stable ? 'bill' : seen >= regularAt ? 'everyday' : 'occasional');
    // Per category: its regular places (in a moved place's own row: that place), and the rest.
    const real = Array.from(cats.values()).map(c => {
      const ms = Array.from(c.merchants.values());
      const ownRow = m => c.synthetic || m.regular;
      const regular = ms.filter(ownRow).map(m => Object.assign({ category: c.category }, m, stats(m.items)));
      const restItems = ms.filter(m => !ownRow(m)).flatMap(m => m.items);
      const rest = restItems.length ? Object.assign({ items: restItems }, stats(restItems)) : null;
      const avg = regular.reduce((s, r) => s + r.avg, 0) + (rest ? rest.avg : 0);
      return { category: c.category, synthetic: c.synthetic, regular, rest, avg, items: ms.flatMap(m => m.items) };
    });
    // Tiny categories (two or more) become one "Other" row; a category called "Other" joins it.
    const tiny = real.filter(c => !c.synthetic && (Math.abs(c.avg) < TINY_CATEGORY_CENTS || c.category === OTHER_CATEGORY));
    const grouped = tiny.length >= 2 ? tiny : [];
    const shown = real.filter(c => !grouped.includes(c)).map(c => ({ label: c.category, synthetic: c.synthetic, members: [c] }));
    shown.sort((a, b) => b.members[0].avg - a.members[0].avg || (a.label < b.label ? -1 : a.label > b.label ? 1 : (a.synthetic ? 1 : -1)));
    if (grouped.length) shown.push({ label: OTHER_CATEGORY, synthetic: false, members: grouped });

    const ov = id => (isObj(own(cfg.rows, id)) ? cfg.rows[id] : null);
    const legacy = [], superseded = [];
    // A row's change: its own id first; else the same row's change under the earlier card/bank
    // dial, when the row is paid only that way (so it holds exactly what that row held).
    const overrideFor = row => {
      const mine = ov(row.id);
      const sameRow = !row.synthetic && row.paidBy !== 'mixed' && !((row.kind === 'category' || row.kind === 'rest') && row.category === OTHER_CATEGORY);
      const lid = sameRow ? row.paidBy + row.id.slice(group.length) : null;
      const old = lid ? ov(lid) : null;
      row.legacyId = null;
      if (old && mine) superseded.push(lid);
      else if (old) { legacy.push({ from: lid, to: row.id }); row.legacyId = lid; }
      return mine || old;
    };
    const rows = [];
    const ids = new Set();
    const defaultCardOf = new Map();
    let overridden = false, stableCount = 0;
    for (const g of shown) {
      const catId = rowIdOf(group, 'c', g.synthetic ? MERCHANT_KEY + g.label : g.label);
      const kids = [];
      for (const c of g.members) {
        for (const m of c.regular) {
          const rec = recency(m.items, m.regular);
          kids.push(Object.assign({ id: rowIdOf(group, 'm', c.synthetic ? MERCHANT_KEY + c.category : c.category, m.merchant), level: 2, parent: catId, label: m.merchant, kind: 'merchant', category: g.label, sourceCategory: c.synthetic ? null : c.category,
            avgCents: m.avg, months: m.months, txnCount: m.txnCount, regular: m.regular }, rec.facts, {
            group, synthetic: c.synthetic, paidBy: paidByOf(m), cardShare: shareOf(m), pattern: patternOf(m.regular, rec.facts.stable, rec.facts.seenMonths),
            defaultCard: rec.facts.stable ? (rec.route === 'card' ? rec.facts.latestCents : 0) : m.cardAvg }));
        }
      }
      kids.sort((a, b) => b.avgCents - a.avgCents || (a.label < b.label ? -1 : 1));
      const withRest = g.members.filter(c => c.rest);
      if (withRest.length) {
        const restItems = withRest.flatMap(c => c.rest.items);
        const st = stats(restItems);
        const rec = recency(restItems, false);
        kids.push(Object.assign({ id: rowIdOf(group, 'r', g.label), level: 2, parent: catId, label: (kids.length ? 'Everything else in ' : 'Everything in ') + g.label, kind: 'rest', category: g.label, sourceCategory: null,
          avgCents: withRest.reduce((s, c) => s + c.rest.avg, 0), months: st.months, txnCount: st.txnCount, regular: false }, rec.facts, {
          group, synthetic: false, paidBy: paidByOf(st), cardShare: shareOf(st), pattern: patternOf(false, false, rec.facts.seenMonths),
          defaultCard: withRest.reduce((s, c) => s + c.rest.cardAvg, 0) }));
      }
      for (const k of kids) {
        const o = overrideFor(k);
        // Without a change: a stable bill at its latest charge, anything else at its average.
        k.defaultCents = k.stable ? k.latestCents : k.avgCents;
        k.override = o;
        k.included = !(o && o.included === false);
        k.planCents = o && isCents(o.cents) ? o.cents : k.defaultCents;
        k.cardCents = k.planCents === k.defaultCents ? k.defaultCard : roundCents(k.planCents * k.cardShare);
        k.bankCents = k.planCents - k.cardCents;
        defaultCardOf.set(k.id, k.defaultCard);
        delete k.defaultCard;
        if (o) overridden = true;
        if (k.stable) stableCount += 1;
        ids.add(k.id);
      }
      const allItems = g.members.flatMap(c => c.items);
      const st = stats(allItems);
      const seen = new Set(chargesOf(allItems).map(c => c.month)).size;
      const single = g.members.length === 1 ? g.members[0] : null;
      const row = { id: catId, level: 1, parent: null, label: g.label, kind: 'category', category: g.label, sourceCategory: null,
        members: g.synthetic ? [] : g.members.map(c => c.category), avgCents: g.members.reduce((s, c) => s + c.avg, 0), months: st.months, txnCount: st.txnCount, regular: false,
        defaultCents: kids.reduce((s, k) => s + k.defaultCents, 0),
        group, synthetic: g.synthetic, merchant: g.synthetic ? g.label : null,
        movedFrom: g.synthetic ? Array.from(new Set(allItems.map(i => i.category))).sort() : [],
        // What setGroup takes to move this row: a category name, or 'merchant:' + place (null for the grouped "Other").
        groupKey: g.synthetic ? MERCHANT_KEY + g.label : single ? single.category : null,
        groupSource: g.synthetic ? 'override' : single ? categoryGroup(single.category, cfg).source : null,
        paidBy: paidByOf(st), cardShare: shareOf(st), seenMonths: seen, ofMonths: n,
        pattern: kids.length && kids.every(k => k.pattern === 'bill') ? 'bill' : seen >= regularAt ? 'everyday' : 'occasional' };
      const o = overrideFor(row);
      if (o) overridden = true;
      ids.add(catId);
      const included = kids.filter(k => k.included);
      const defaultCard = kids.reduce((s, k) => s + defaultCardOf.get(k.id), 0);
      row.override = o;
      row.included = !(o && o.included === false);
      row.planCents = o && isCents(o.cents) ? o.cents : included.reduce((s, k) => s + k.planCents, 0);
      row.cardCents = o && isCents(o.cents)
        ? (o.cents === row.defaultCents ? defaultCard : roundCents(o.cents * row.cardShare))
        : included.reduce((s, k) => s + k.cardCents, 0);
      row.bankCents = row.planCents - row.cardCents;
      defaultCardOf.set(catId, defaultCard);
      rows.push(row, ...kids);
    }
    const categories = rows.filter(r => r.level === 1);
    const on = categories.filter(r => r.included);
    return {
      kind: 'categories', group, rows,
      categoryCount: categories.length,
      baselineCents: categories.reduce((s, r) => s + r.defaultCents, 0),
      rowsCents: on.reduce((s, r) => s + r.planCents, 0),
      baselineCardCents: categories.reduce((s, r) => s + defaultCardOf.get(r.id), 0),
      rowsCardCents: on.reduce((s, r) => s + r.cardCents, 0),
      cardShare: shareOf(stats(real.flatMap(c => c.items))),
      overridden,
      stableCount,
      yearlyCount: yearly.size,
      orphanIds: Object.keys(cfg.rows).filter(id => id.startsWith(group + '-') && !ids.has(id)),
      tinyCategoryCents: TINY_CATEGORY_CENTS,
      legacy, superseded,
    };
  }

  /**
   * The irregular dial's items: every one-time cost of the baseline months (found automatically
   * or marked by the household), in the allowance unless the household left it out
   * (ui.plan.irregularOff). baselineCents = Σ one-time costs ÷ months; rowsCents = Σ those still
   * in ÷ months. One the household counts as regular (planningBaseline 'include') is in its
   * category instead and not listed here.
   */
  function irregularFor(base, byId, cfg) {
    const n = base.count;
    const items = (base.oneTime || []).map(o => {
      const t = byId.get(o.id);
      return {
        id: o.id, label: o.merchant, date: o.date, month: o.date.slice(0, 7), cents: o.cents, monthlyCents: n ? E.money.divide(o.cents, n) : null,
        included: own(cfg.irregularOff, o.id) !== true, auto: !!o.auto, paidBy: o.role === 'card' ? 'card' : 'bank',
        category: t && typeof t.category === 'string' ? t.category : null, description: o.description, accountLabel: o.accountLabel,
      };
    });
    const sum = (list, f) => list.reduce((s, i) => s + f(i), 0);
    const on = items.filter(i => i.included);
    const card = list => sum(list.filter(i => i.paidBy === 'card'), i => i.cents);
    const cardAbs = sum(items.filter(i => i.paidBy === 'card'), i => Math.abs(i.cents)), allAbs = sum(items, i => Math.abs(i.cents));
    const totalCents = sum(items, i => i.cents);
    // What the costs were, biggest first: "dental work, trips, repairs, tax".
    const byWord = new Map();
    for (const i of items) {
      if (!i.category || i.category === E.categories.UNCATEGORIZED) continue;
      const word = IRREGULAR_WORDS[i.category] || i.category.toLowerCase();
      byWord.set(word, (byWord.get(word) || 0) + i.cents);
    }
    const examples = Array.from(byWord.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(e => e[0]);
    const known = new Set(items.map(i => i.id));
    return {
      kind: 'items', rows: items, count: items.length, includedCount: on.length, leftOutCount: items.length - on.length,
      totalCents, includedCents: sum(on, i => i.cents),
      baselineCents: n ? E.money.divide(totalCents, n) : null,
      rowsCents: n ? E.money.divide(sum(on, i => i.cents), n) : null,
      baselineCardCents: n ? E.money.divide(card(items), n) : null,
      rowsCardCents: n ? E.money.divide(card(on), n) : null,
      cardShare: allAbs ? cardAbs / allAbs : 0,
      overridden: on.length !== items.length,
      orphanIds: Object.keys(cfg.irregularOff).filter(id => !known.has(id)),
      examples,
    };
  }

  // ------------------------------------------------------------------ dials
  /** "2 × $1,234.00 to joint (semimonthly)" for one Budget income stream (annual-average timing). */
  function streamText(st) {
    const per = E.money.format(st.perPaycheckJointCents);
    const f = st.frequency;
    if (st.perYear === null) return st.count + ' × ' + per + ' to joint (pay frequency not confirmed: ' + st.count + ' a month assumed)';
    const times = f === 'semimonthly' ? '2' : f === 'monthly' ? '1' : st.perYear + '/12';
    const how = f === 'semimonthly' || f === 'monthly' ? f : f + ', ' + st.perYear + ' a year';
    return times + ' × ' + per + ' to joint (' + how + (st.assumedCadence ? ', not confirmed' : '') + ')';
  }

  /**
   * One person's joint money in from the pay saved in Budget, for the first plan month
   * (flows.planFunding with annual-average timing: biweekly 26 a year, semimonthly 24, never mixed).
   * budgetCents is null when no stream counts or any counted stream's amount is unknown.
   */
  function budgetFor(funding, pid) {
    const fp = funding && funding.people[pid] ? funding.people[pid] : null;
    // Streams that reach joint through another stream (a paycheck whose money is moved by a transfer) are left out.
    const counted = fp ? fp.streams.filter(st => !st.viaTransfers) : [];
    const unknown = counted.filter(st => !isCents(st.monthly.joint)).map(st => st.label);
    const streams = counted.filter(st => isCents(st.monthly.joint)).map(st => {
      const known = E.schedule.FREQUENCIES.includes(st.frequency);
      return {
        id: st.id, name: st.label, perPaycheckJointCents: st.perPaycheck.joint,
        perYear: known ? E.schedule.PER_YEAR[st.frequency] : null,
        cadenceLabel: known ? E.schedule.LABELS[st.frequency] : 'Pay frequency not confirmed',
        monthlyCents: st.monthly.joint,
        assumedCadence: !known || st.basis === 'assumed' || st.frequencyStatus === 'unknown',
        frequency: st.frequency, count: st.count,
      };
    });
    const budgetCents = counted.length && !unknown.length ? streams.reduce((sum, st) => sum + st.monthlyCents, 0) : null;
    return { budgetCents, budget: { streams: streams.map(({ frequency, count, ...rest }) => rest), unknown }, texts: streams.map(streamText) };
  }


  /**
   * A spending dial's plan amount split into card and bank (bank = the rest, so the two add up).
   * A direct amount splits by the dial's cardShare, or by the card part kept with it
   * (ui.plan.cardSplit, e.g. from carrying over the earlier card dial) while the dial still holds
   * exactly that amount.
   */
  function splitSpending(d, drill, split) {
    let card;
    if (d.planCents === null) card = null;
    else if (d.source === 'direct') card = split && split.cents === d.planCents ? split.card : roundCents(d.planCents * drill.cardShare);
    else card = d.source === 'rows' ? drill.rowsCardCents : drill.baselineCardCents;
    return {
      cardShare: drill.cardShare, cardCents: card, bankCents: card === null ? null : d.planCents - card,
      baselineCardCents: drill.baselineCardCents, baselineBankCents: drill.baselineCents === null || drill.baselineCardCents === null ? null : drill.baselineCents - drill.baselineCardCents,
    };
  }

  function buildDials({ base, people, cfg, byId, requested, funding }) {
    const n = base.count;
    const T = base.total.planning;
    const avg = cents => (n ? E.money.divide(cents, n) : null);
    const ids = new Set(people.map(p => p.id));
    const range = rangeText(base.start, base.end);
    const windowText = !n ? 'No complete month yet, so there is no baseline'
      : requested === 'all' ? 'Average of all ' + plural(n, 'complete month') + ', ' + range
        : 'Average of ' + range + ', ' + plural(n, 'month') + (n < requested ? ' (all there are)' : '');
    const resolve = (key, baselineCents, rowsCents, rowsSet) => {
      if (isCents(own(cfg.dials, key))) return { planCents: cfg.dials[key], source: 'direct' };
      if (rowsSet) return { planCents: rowsCents, source: 'rows' };
      return { planCents: baselineCents, source: 'baseline' };
    };
    const dials = [];
    // Money in per person: the pay saved in Budget wins; the deposit average is only a labelled stand-in.
    const averageText = n ? 'Average of ' + range + ' deposits, ' + plural(n, 'month') + ' — not a confirmed setting'
      : 'No pay saved in Budget and no complete month of deposits yet — not a confirmed setting';
    for (const p of people) {
      const averageCents = avg(IN_KEYS.includes(p.id) ? T[p.id] : 0);
      const { budgetCents, budget, texts } = budgetFor(funding, p.id);
      const baselineCents = budgetCents !== null ? budgetCents : averageCents;
      const basisKind = isCents(own(cfg.dials, p.id)) ? 'direct' : budgetCents !== null ? 'budget' : 'average';
      dials.push(Object.assign({ key: p.id, group: 'in', label: p.name, baselineCents }, resolve(p.id, baselineCents), {
        basis: basisKind === 'direct' ? 'Set here' : basisKind === 'budget' ? 'From Budget: ' + texts.join('; ') : averageText,
        hint: depositHint(base.credits, p.id), drill: null,
        budgetCents, averageCents, basisKind, needsConfirm: basisKind === 'average', budget,
      }));
    }
    const elsewhere = IN_KEYS.filter(k => !ids.has(k)).reduce((s, k) => s + T[k], 0);
    const inOtherBase = avg(T.unassigned + T.interest + elsewhere);
    const parts = { interest: avg(T.interest) };
    if ((inOtherBase !== null && inOtherBase !== 0) || isCents(own(cfg.dials, 'inOther'))) {
      dials.push(Object.assign({ key: 'inOther', group: 'in', label: DIAL_LABEL.inOther, baselineCents: inOtherBase }, resolve('inOther', inOtherBase), {
        basis: windowText + (n ? ' (deposits nobody could be matched to, and interest)' : ''), hint: null, drill: null,
      }));
    }
    const legacy = [], superseded = [];
    for (const key of SPEND_GROUPS) {
      const drill = drillFor(key, base, byId, cfg);
      legacy.push(...drill.legacy);
      superseded.push(...drill.superseded);
      delete drill.legacy;
      delete drill.superseded;
      const extra = n && drill.yearlyCount ? plural(drill.yearlyCount, 'yearly bill') + ' spread over 12 months' : '';
      const d = Object.assign({ key, group: 'out', label: DIAL_LABEL[key], baselineCents: drill.baselineCents }, resolve(key, drill.baselineCents, drill.rowsCents, drill.overridden), {
        basis: windowText + (extra ? '; ' + extra : '') + (drill.stableCount ? '; regular bills at their latest amount' : ''), hint: null, drill,
      });
      dials.push(Object.assign(d, splitSpending(d, drill, own(cfg.cardSplit, key))));
    }
    const irr = irregularFor(base, byId, cfg);
    const irrBasis = !n ? windowText
      : !irr.count ? 'No one-time costs over ' + range
        : 'One-time costs over ' + range + ' spread per month (' + plural(irr.count, 'item') + ', ' + E.money.format(irr.totalCents) + ')'
          + (irr.examples.length ? ' — ' + irr.examples.join(', ') : '') + (irr.leftOutCount ? '; ' + irr.leftOutCount + ' left out by you' : '');
    const irregular = Object.assign({ key: 'irregular', group: 'out', label: DIAL_LABEL.irregular, baselineCents: irr.baselineCents }, resolve('irregular', irr.baselineCents, irr.rowsCents, irr.overridden), {
      basis: irrBasis, hint: null, drill: irr,
    });
    dials.push(Object.assign(irregular, splitSpending(irregular, irr, own(cfg.cardSplit, 'irregular'))));
    const savingsBase = avg(T.savingsNet);
    dials.push(Object.assign({ key: 'savings', group: 'out', label: DIAL_LABEL.savings, baselineCents: savingsBase }, resolve('savings', savingsBase), {
      basis: windowText + (n ? ' (into savings minus out of savings)' : ''), hint: null, drill: null,
    }));
    const otherBase = avg(T.debt + T.business + T.investNet);
    parts.debt = avg(T.debt);
    parts.business = avg(T.business);
    if ((otherBase !== null && otherBase !== 0) || isCents(own(cfg.dials, 'other'))) {
      dials.push(Object.assign({ key: 'other', group: 'out', label: DIAL_LABEL.other, baselineCents: otherBase }, resolve('other', otherBase), {
        basis: windowText + (n ? ' (debt payments, business purchases and investments)' : ''), hint: null, drill: null,
      }));
    }
    return { dials, parts, windowText, legacy, superseded };
  }

  /**
   * One plan month from the dials (same keys as an actual month): at each dial's plan amount, or
   * with `atBaseline` at each dial's baseline (the "no changes" plan the chart can draw as a ghost).
   * out.card / out.bank are worked out from the spending dials; out.total = essentials + flexible +
   * irregular + debt + business + investments. Also: combinedChange = in − out (moves to and from
   * savings stay inside joint cash), toSavings and fromSavings (the savings dial's two sides).
   */
  function planMonth(dials, parts, people, atBaseline) {
    const dial = key => dials.find(x => x.key === key) || null;
    const v = key => { const d = dial(key); return d ? (atBaseline ? d.baselineCents : d.planCents) : 0; };
    const inn = {};
    for (const p of people) inn[p.id] = v(p.id);
    const inOther = v('inOther');
    // "Other money in" keeps the baseline's interest apart; the rest is deposits nobody was matched to.
    const interest = inOther === null ? null : (parts.interest || 0);
    inn.other = interest;
    inn.unassigned = inOther === null ? null : inOther - interest;
    inn.total = sumKnown(people.map(p => inn[p.id]).concat([inn.unassigned, inn.other]));
    const out = { essentials: v('essentials'), flexible: v('flexible'), irregular: v('irregular'), card: null, bank: null, debt: 0, business: 0, invest: 0, other: null, total: null };
    const spending = sumKnown([out.essentials, out.flexible, out.irregular]);
    out.card = sumKnown(['essentials', 'flexible', 'irregular'].map(k => { const d = dial(k); return d ? (atBaseline ? d.baselineCardCents : d.cardCents) : 0; }));
    out.bank = spending === null || out.card === null ? null : spending - out.card;
    const other = v('other');
    if (other === null) { out.debt = null; out.business = null; out.invest = null; }
    else if (other !== 0) {
      // Split like the baseline (debt, business, investments); all of it is debt when the baseline has none.
      const bd = parts.debt || 0, bb = parts.business || 0;
      const baseTotal = dial('other') ? dial('other').baselineCents || 0 : 0;
      if (!baseTotal) out.debt = other;
      else if (other === baseTotal) { out.debt = bd; out.business = bb; out.invest = other - bd - bb; }
      else {
        out.debt = Math.round(other * bd / baseTotal);
        out.business = Math.round(other * bb / baseTotal);
        out.invest = other - out.debt - out.business;
      }
    }
    out.other = sumKnown([out.debt, out.business, out.invest]);
    out.total = sumKnown([spending, out.other]);
    const savings = v('savings');
    const net = inn.total === null || out.total === null || savings === null ? null : inn.total - out.total - savings;
    const combinedChange = inn.total === null || out.total === null ? null : inn.total - out.total;
    return {
      in: inn, out, savings, net, combinedChange,
      toSavings: savings === null ? null : Math.max(0, savings), fromSavings: savings === null ? null : Math.max(0, 0 - savings),
    };
  }

  /**
   * How the amounts set for the earlier card and bank dials (settings.legacyDials) become direct
   * amounts for essentials, flexible and irregular, or null when there are none.
   * A card amount X is shared over the three dials' baseline card parts (C = their sum): each
   * card part becomes round(baselineCard × X / C), the rounding remainder on the largest baseline
   * card part, so the three add up to X exactly; when C is 0 the whole of X is Flexible's card
   * part (the others' card parts are $0). A bank amount likewise on the bank parts. A side that was
   * not set keeps its baseline parts. Each dial's amount = its card part + its bank part. A dial the
   * household already set directly is left alone (to: null, named in `skipped` and in the note).
   * With no baseline yet (no complete month), everything set goes to Flexible.
   * @returns {{ from: { card?, bank? }, to: { essentials, flexible, irregular }, parts: { [dial]: { card, bank }|null },
   *   skipped: string[], note: string }|null}
   */
  function legacyDialsPlan(dialsByKey, cfg) {
    const from = {};
    for (const k of LEGACY_DIALS) if (isCents(own(cfg.legacyDials, k))) from[k] = cfg.legacyDials[k];
    const sides = LEGACY_DIALS.filter(k => has(from, k));
    if (!sides.length) return null;
    const skipped = SPEND_DIALS.filter(k => isCents(own(cfg.dials, k)));
    const known = SPEND_DIALS.every(k => dialsByKey[k] && isCents(dialsByKey[k].baselineCardCents) && isCents(dialsByKey[k].baselineBankCents));
    const parts = {};
    const how = {};
    if (!known) {
      for (const k of SPEND_DIALS) parts[k] = null;
      parts.flexible = { card: has(from, 'card') ? from.card : 0, bank: has(from, 'bank') ? from.bank : 0 };
    } else {
      for (const k of SPEND_DIALS) parts[k] = { card: dialsByKey[k].baselineCardCents, bank: dialsByKey[k].baselineBankCents };
      for (const side of sides) {
        const base = SPEND_DIALS.map(k => parts[k][side]);
        const total = base.reduce((s, v) => s + v, 0);
        const x = from[side];
        if (total === 0) {
          SPEND_DIALS.forEach(k => { parts[k][side] = k === 'flexible' ? x : 0; });
          how[side] = 'flexible';
          continue;
        }
        const share = base.map(b => roundCents(b * x / total));
        let big = 0;
        base.forEach((b, i) => { if (Math.abs(b) > Math.abs(base[big])) big = i; });
        share[big] += x - share.reduce((s, v) => s + v, 0);
        SPEND_DIALS.forEach((k, i) => { parts[k][side] = share[i]; });
        how[side] = 'scaled';
      }
    }
    const to = {};
    for (const k of SPEND_DIALS) to[k] = parts[k] && !skipped.includes(k) ? parts[k].card + parts[k].bank : null;
    // The note: what was set, how it was carried over, and what was left alone.
    const money = E.money.format;
    const said = sides.map((s, i) => (i ? '' : 'Your earlier ') + s + ' spending setting of ' + money(from[s])).join(' and ');
    const was = sides.length > 1 ? 'were' : 'was';
    const it = sides.length > 1 ? 'them' : 'it';
    const list = keys => keys.map(k => SHORT_LABEL[k]).join(keys.length > 2 ? ', ' : ' and ').replace(/, ([^,]+)$/, ' and $1');
    const applied = SPEND_DIALS.filter(k => to[k] !== null);
    let note;
    if (!applied.length) {
      note = said + ' ' + was + ' not carried over: ' + (known ? list(skipped) + (skipped.length > 1 ? ' were' : ' was') + ' already set by you.' : 'Flexible was already set by you, and there is no baseline yet to scale ' + it + ' by.');
    } else if (!known) {
      note = said + ' ' + was + ' carried over to Flexible (there is no baseline yet to scale ' + it + ' by); adjust ' + it + ' from here.';
    } else {
      const scaled = sides.filter(s => how[s] === 'scaled');
      const flat = sides.filter(s => how[s] === 'flexible');
      const bits = [];
      if (scaled.length) {
        bits.push('by scaling the ' + (scaled.length > 1 ? 'card and bank parts' : scaled[0] + ' part') + ' of Essentials, Flexible and Irregular'
          + (skipped.length ? '' : ' (they now add up to ' + (scaled.length > 1 ? 'them' : 'it') + ')'));
      }
      if (flat.length) {
        bits.push((scaled.length ? 'putting the ' : 'by putting the ') + flat.join(' and ') + ' amount' + (flat.length > 1 ? 's' : '') + ' on Flexible (there was no '
          + flat.join(' or ') + ' spending in the baseline to scale)');
      }
      note = said + ' ' + was + ' carried over ' + bits.join(', and ') + '; adjust them individually from here.';
      if (skipped.length) note += ' ' + list(skipped) + (skipped.length > 1 ? ' were' : ' was') + ' already set by you and ' + (skipped.length > 1 ? 'were left as they are.' : 'was left as it is.');
    }
    return { from, to, parts, skipped, note };
  }

  // ------------------------------------------------------------------ planned changes

  /** plan.changes, checked (the engine never trusts its input): unusable entries are skipped. */
  function readChanges(plan) {
    const list = Array.isArray(plan.changes) ? plan.changes : [];
    return list.filter(c => isObj(c) && typeof c.id === 'string' && c.id && CHANGE_KINDS.includes(c.kind) && CHANGE_GROUPS.includes(c.group) && E.months.isMonth(c.startMonth))
      .map(c => ({
        id: c.id, label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : c.id, kind: c.kind, group: c.group,
        personId: c.group === 'income' && typeof c.personId === 'string' && c.personId ? c.personId : null,
        startMonth: c.startMonth,
        endMonth: c.kind === 'monthly' && E.months.isMonth(c.endMonth) && c.endMonth >= c.startMonth ? c.endMonth : null,
        cents: isCents(c.cents) ? c.cents : null, accepted: c.accepted === true,
        template: typeof c.template === 'string' && c.template ? c.template : null, note: typeof c.note === 'string' ? c.note : '',
      }));
  }

  const changeActiveIn = (c, m) => (c.kind === 'oneTime' ? m === c.startMonth : m >= c.startMonth && (c.endMonth === null || m <= c.endMonth));

  /**
   * Add one planned change to a plan month's amounts: income to its person (other money in when
   * no person, or a person not in the plan), spending to its group and to bank-paid spending,
   * savings to net to savings. Unknown amounts stay unknown.
   */
  function applyChange(row, c, people) {
    const add = (a, b) => (a === null ? null : a + b);
    if (c.group === 'income') {
      const key = c.personId && people.some(p => p.id === c.personId) ? c.personId : 'other';
      row.in[key] = add(row.in[key], c.cents);
      row.in.total = add(row.in.total, c.cents);
    } else if (c.group === 'savings') {
      row.savings = add(row.savings, c.cents);
    } else {
      row.out[c.group] = add(row.out[c.group], c.cents);
      row.out.bank = add(row.out.bank, c.cents);
      row.out.total = add(row.out.total, c.cents);
    }
    row.net = row.in.total === null || row.out.total === null || row.savings === null ? null : row.in.total - row.out.total - row.savings;
    row.combinedChange = row.in.total === null || row.out.total === null ? null : row.in.total - row.out.total;
  }

  /**
   * What the planned changes did: each change with its status ('unset': no amount yet, never
   * applied; 'notAccepted': listed only; 'applied'; 'outside': no plan month in its dates),
   * monthsApplied and appliedCents. Totals count money out of checking as positive (spending and
   * savings +, income −): totalOneTimeCents over the applied one-time changes, monthlyNowCents
   * over the monthly changes applied in the first plan month.
   */
  function summarizeChanges(changes, monthRows, planStart) {
    const applied = new Map();
    for (const r of monthRows) for (const a of r.changesApplied) applied.set(a.id, (applied.get(a.id) || 0) + 1);
    const list = changes.map(c => {
      const monthsApplied = applied.get(c.id) || 0;
      const status = c.cents === null ? 'unset' : !c.accepted ? 'notAccepted' : monthsApplied ? 'applied' : 'outside';
      return Object.assign({}, c, { status, monthsApplied, appliedCents: monthsApplied ? monthsApplied * c.cents : 0 });
    });
    const cost = c => (c.group === 'income' ? 0 - c.cents : c.cents);
    const first = monthRows.find(r => r.month === planStart);
    const byId = new Map(list.map(c => [c.id, c]));
    return {
      list,
      applied: list.filter(c => c.status === 'applied').length,
      unset: list.filter(c => c.cents === null).map(c => c.id),
      totalOneTimeCents: list.filter(c => c.status === 'applied' && c.kind === 'oneTime').reduce((s, c) => s + cost(c), 0),
      monthlyNowCents: first ? first.changesApplied.filter(a => byId.get(a.id).kind === 'monthly').reduce((s, a) => s + cost(byId.get(a.id)), 0) : 0,
    };
  }

  // ------------------------------------------------------------------ series (Trends)

  /**
   * Monthly series the chart can draw as lines, aligned with `months`: actual months from what
   * happened (null when the month is not complete), partial and plan months from the plan.
   */
  function seriesOf(months, people) {
    const col = f => months.map(m => { const v = f(m); return v === undefined ? null : v; });
    const list = people.map(p => ({ key: 'in-' + p.id, name: p.name, group: 'in', values: col(m => m.in[p.id]) }));
    const value = {
      'in-other': m => sumKnown([m.in.unassigned, m.in.other]),
      'in-total': m => m.in.total,
      'card': m => m.out.card,
      'bank': m => m.out.bank,
      'essentials': m => m.out.essentials,
      'flexible': m => m.out.flexible,
      'irregular': m => m.out.irregular,
      'other-out': m => m.out.other,
      'out-total': m => m.out.total,
      'to-savings': m => (m.savings === null ? null : Math.max(0, m.savings)),
      'from-savings': m => (m.savings === null ? null : Math.max(0, 0 - m.savings)),
      'net': m => m.net,
      'combined-change': m => m.combinedChange,
    };
    for (const s of SERIES) list.push({ key: s.key, name: s.name, group: s.group, values: col(value[s.key]) });
    return list;
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


  // ------------------------------------------------------------------ build

  /**
   * Everything the plan screen shows, in one call.
   * @param {{ txns: object[], dataset: object, plan: object, settings?: object, today: string,
   *   coverageMap?: object }} input
   *   txns: effective transactions (ledger.applyEdits, no what-if; planning-baseline edits are
   *   read from them); plan: state.plan (plan.changes: planned changes); settings: state.ui.plan;
   *   today: 'YYYY-MM-DD' (explicit, so results are reproducible); coverageMap:
   *   ledger.coverageMap(dataset) when already known.
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
    // Pay saved in Budget for the first plan month (ended streams out, later ones not yet in).
    let funding = null;
    try { funding = E.flows.planFunding(plan, { month: planStart, timing: 'average' }); } catch (err) { funding = null; }
    const { dials, parts, windowText, legacy, superseded } = buildDials({ base, people, cfg, byId, requested, funding });
    const planValues = planMonth(dials, parts, people, false);

    // What happened so far in partly covered months (kept apart from the month's amounts).
    const partial = dataMonths.filter(m => covOf(m) && covOf(m).status === 'partial');
    const soFar = new Map(E.flows.breakdown(txns, dataset, { months: partial, coverageMap: Object.fromEntries(partial.map(m => [m, { status: 'full' }])), plan }).map(r => [r.month, r]));
    // One-time or not, for every purchase in a month with data: the baseline window's own
    // classification (the irregular dial's items), else one over every month with data.
    const wide = rows.map(r => soFar.get(r.month) || r).filter(r => r.actual);
    const kindOf = new Map();
    if (wide.length) for (const x of E.flows.baseline(wide, { count: wide.length }).spends) kindOf.set(x.id, x.kind);
    for (const x of base.spends) kindOf.set(x.id, x.kind);
    const groupsOf = list => spendGroups(list, kindOf, byId, cfg);
    const autoOneTime = base.oneTime.filter(o => o.auto).map(o => oneOffItem(o, people, true));
    const oneOffsIn = (r, m) => {
      const manual = r.oneOffs.map(o => oneOffItem(o, people, false));
      const seen = new Set(manual.map(o => o.id));
      return manual.concat(autoOneTime.filter(o => o.month === m && !seen.has(o.id)));
    };
    const changes = readChanges(plan);

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
    for (const a of anc.accounts) if (a.source !== 'entered') earlier(a.asOf);
    if (anc.simple && anc.combined && anc.combined.asOf) earlier(anc.combined.asOf);
    if (first > planStart) first = planStart;
    let months = E.months.range(first, lastMonth);

    const rowByMonth = new Map(rows.map(r => [r.month, r]));
    const monthRows = months.map(m => {
      const c = covOf(m);
      const coverage = c ? c.status : 'none';
      const r = rowByMonth.get(m);
      const sf = soFar.get(m);
      const actualSoFar = sf && sf.actual ? Object.assign(fromActual(sf.actual, people, groupsOf(sf.spends)), {
        oneOffs: oneOffsIn(sf, m), oneOffCents: spendCentsOf(oneOffsIn(sf, m)), coveredDays: c.coveredDays, totalDays: c.totalDays,
      }) : null;
      if (m < planStart) {
        if (r && r.actual) {
          const oneOffs = oneOffsIn(r, m);
          return Object.assign({ month: m, status: 'actual', current: m === todayMonth, complete: true, coverage }, fromActual(r.actual, people, groupsOf(r.spends)),
            { oneOffs, oneOffCents: spendCentsOf(oneOffs), actualSoFar: null, changesApplied: [], baseline: null });
        }
        return { month: m, status: 'actual', current: m === todayMonth, complete: false, coverage, in: IN_EMPTY(people), out: OUT_EMPTY(), savings: null, net: null, combinedChange: null,
          oneOffs: [], oneOffCents: null, actualSoFar, changesApplied: [], baseline: null };
      }
      const row = {
        month: m, status: coverage === 'partial' ? 'partial' : 'plan', current: m === todayMonth, complete: false, coverage,
        in: Object.assign({}, planValues.in), out: Object.assign({}, planValues.out), savings: planValues.savings, net: planValues.net, combinedChange: planValues.combinedChange,
        oneOffs: [], oneOffCents: 0, actualSoFar, changesApplied: [], baseline: null,
      };
      for (const ch of changes) {
        if (!ch.accepted || ch.cents === null || !changeActiveIn(ch, m)) continue;
        applyChange(row, ch, people);
        row.changesApplied.push({ id: ch.id, label: ch.label, group: ch.group, cents: ch.cents });
      }
      return row;
    });
    const changeSummary = summarizeChanges(changes, monthRows, planStart);
    const changedBy = { dials: dials.some(d => d.source !== 'baseline'), changes: changeSummary.applied > 0 };
    const changed = changedBy.dials || changedBy.changes;
    // The plan with no changes (every dial at its baseline, no planned changes): the chart's ghost.
    const ghost = changed ? planMonth(dials, parts, people, true) : null;
    if (ghost) for (const r of monthRows) if (r.month >= planStart) r.baseline = { in: ghost.in.total, out: ghost.out.total, savings: ghost.savings, net: ghost.net, combinedChange: ghost.combinedChange };
    const rowsByMonth = new Map(monthRows.map(r => [r.month, r]));
    const balanceInput = { txns, dataset, plan, months, cfg, today, anc, mirrors };
    const balances = balancesFor(Object.assign({ rowsByMonth }, balanceInput));
    if (balances.combined) {
      balances.combined.baselinePoints = null;
      if (ghost) {
        const ghostRows = new Map(monthRows.map(r => [r.month, r.month >= planStart ? Object.assign({}, r, { in: ghost.in, out: ghost.out, savings: ghost.savings, net: ghost.net }) : r]));
        const g = balancesFor(Object.assign({ rowsByMonth: ghostRows }, balanceInput));
        balances.combined.baselinePoints = balances.combined.points.map((p, i) => (p.status === 'projected' && g.combined ? g.combined.points[i].cents : null));
      }
    }

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
      if (balances.combined) {
        balances.combined.points = balances.combined.points.slice(drop);
        if (balances.combined.baselinePoints) balances.combined.baselinePoints = balances.combined.baselinePoints.slice(drop);
      }
    }

    const pastFrom = cfg.past === 'all' ? months[0] : (E.months.add(planStart, 0 - cfg.past) < months[0] ? months[0] : E.months.add(planStart, 0 - cfg.past));
    const spendOneTime = base.oneTime.map(o => oneOffItem(o, people, o.auto));
    const seen = new Set(spendOneTime.map(o => o.id));
    const otherOneTime = base.oneOffs.filter(o => !seen.has(o.id) && o.role !== 'card' && o.role !== 'bank').map(o => oneOffItem(o, people, false));
    const oneTime = spendOneTime.concat(otherOneTime);
    const dialsByKey = Object.fromEntries(dials.map(d => [d.key, d]));
    // Settings saved under the earlier card/bank dials: row changes (which still apply, and which
    // cannot) and amounts set for the dials themselves (carried over to the spending dials).
    const legacyIds = Object.keys(cfg.rows).filter(id => LEGACY_DIALS.some(k => id.startsWith(k + '-'))).sort();
    const dialMigration = legacyDialsPlan(dialsByKey, cfg);
    let migration = null;
    if (legacyIds.length || dialMigration) {
      const moved = legacy.slice().sort((a, b) => (a.from < b.from ? -1 : 1));
      const dropped = legacyIds.filter(id => !moved.some(l => l.from === id));
      const rowsNote = !legacyIds.length ? null : ('ui.plan.rows: spending is now planned as essentials, flexible and irregular. '
        + (moved.length ? plural(moved.length, 'change') + ' to card and bank spending rows now apply to the same rows there. ' : '')
        + (dropped.length ? plural(dropped.length, 'change') + ' to card and bank spending rows could not be matched to a row in the new grouping and ' + (dropped.length === 1 ? 'was' : 'were') + ' removed.' : '')).trim();
      migration = {
        rows: moved, dropped, superseded: superseded.slice().sort(), rowsNote, dials: dialMigration,
        // What to tell the household, once: the row note (without its path) and the dial note.
        note: [rowsNote ? rowsNote.replace(/^ui\.plan\.rows: /, '') : null, dialMigration ? dialMigration.note : null].filter(Boolean).join(' '),
      };
    }

    return {
      today, todayMonth, planStart, lastComplete, firstMonth: months[0], lastMonth, horizon: cfg.horizon,
      months: monthRows,
      window: { past: cfg.past, from: pastFrom, to: lastMonth, fromIndex: months.indexOf(pastFrom) },
      people,
      dials, dialsByKey,
      groups: { in: dials.filter(d => d.group === 'in').map(d => d.key), out: OUT_DIALS.filter(k => dialsByKey[k]) },
      plan: planValues,
      changed, changedBy,
      changes: changeSummary,
      baseline: {
        setting: requested, count: base.count, months: base.months, start: base.start, end: base.end, label: windowText,
        oneTime, oneTimeCents: spendCentsOf(oneTime),
        keptIn: base.keptRegular.map(o => oneOffItem(o, people, true)),
        yearly: base.yearly.map(o => Object.assign(oneOffItem(o, people, true), { spreadCents: o.spreadCents })),
        regularAt: base.regularAt,
        plan: ghost,
      },
      balances,
      series: seriesOf(monthRows, people),
      migration,
      settings: cfg,
    };
  }

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
   * the allowance, each known balance, each planned change, cover from savings), a blank line,
   * then a "Months" block with one row per month. Amounts are plain dollars ("1234.50"; with
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
    }
    lines.push('');

    line(['Months']);
    const accounts = tl.balances.accounts || [];
    const combined = tl.balances.combined;
    line(['month', 'status'].concat(people.map(p => 'in_' + csvText(p.id)), ['in_other', 'in_total', 'essentials', 'flexible', 'irregular', 'other_out', 'out_total',
      'to_savings', 'from_savings', 'combined_change', 'net_checking', 'combined_balance', 'combined_status'], accounts.flatMap(a => [csvText(a.id) + '_balance', csvText(a.id) + '_status'])));
    tl.months.forEach((m, i) => {
      const s = m.savings;
      const cp = combined ? combined.points[i] : null;
      line([m.month, m.status].concat(people.map(p => money(m.in[p.id])), [
        money(sumKnown([m.in.unassigned, m.in.other])), money(m.in.total),
        money(m.out.essentials), money(m.out.flexible), money(m.out.irregular), money(m.out.other), money(m.out.total),
        money(s === null ? null : Math.max(0, s)), money(s === null ? null : Math.max(0, 0 - s)),
        money(m.combinedChange), money(m.net),
        money(cp ? cp.cents : null), cp && cp.status ? cp.status : '',
      ], accounts.flatMap(a => [money(a.points[i].cents), a.points[i].status || ''])));
    });
    return lines.join('\r\n') + '\r\n';
  }

  // ------------------------------------------------------------------ templates

  const ESTIMATE = 'A generic estimate: adjust it to your own quotes and plans.';
  /** Baby: generic US estimates, timed from the due month D: [label, kind, group, months from D, cents, end (months from D), note]. */
  const BABY = [
    ['Car seat', 'oneTime', 'irregular', -2, 25000],
    ['Nursery setup (paint, dresser, glider)', 'oneTime', 'irregular', -2, 90000],
    ['Starter clothes and basics', 'oneTime', 'irregular', -1, 25000],
    ['Feeding gear (bottles, pump accessories)', 'oneTime', 'irregular', -1, 20000],
    ['Baby monitor', 'oneTime', 'irregular', -1, 10000],
    ['Crib and mattress (after the bassinet)', 'oneTime', 'irregular', 4, 35000],
    ['Delivery out-of-pocket (insurance deductible/out-of-pocket max)', 'oneTime', 'irregular', 1, 350000, null, 'Check your plan’s deductible and out-of-pocket maximum. ' + ESTIMATE],
    ['Diapers and wipes', 'monthly', 'essentials', 0, 8500],
    ['Formula / feeding', 'monthly', 'essentials', 0, 12000, null, 'About $0 if breastfeeding. ' + ESTIMATE],
    ['Baby food', 'monthly', 'essentials', 6, 7500],
    ['Clothes as they grow', 'monthly', 'flexible', 0, 4500],
    ['Health copays and medicines', 'monthly', 'essentials', 0, 4000],
    ['Childcare', 'monthly', 'essentials', 3, 120000, null, 'Typical infant daycare; set to $0 for family care. ' + ESTIMATE],
    ['Parental leave: income change', 'monthly', 'income', 0, null, 2, 'Enter the monthly reduction in take-home while on leave (as a negative amount). ' + ESTIMATE],
  ];

  /**
   * The baby template: planned changes timed from the due month, all listed but not accepted
   * (accepted: false) so nothing reaches the plan until the household says so. The parental
   * leave change has no amount (null: unknown, never $0) until it is entered.
   * @param {string} dueDate 'YYYY-MM-DD'
   * @returns {object[]} items for addChange (no ids: addChange gives each one)
   */
  function babyTemplate(dueDate) {
    if (!E.dates.isDate(dueDate)) fail('Enter the due date (YYYY-MM-DD).', 'dueDate');
    const due = dueDate.slice(0, 7);
    return BABY.map(([label, kind, group, from, cents, end, note]) => ({
      label, kind, group, personId: null, startMonth: E.months.add(due, from),
      endMonth: kind === 'monthly' && Number.isInteger(end) ? E.months.add(due, end) : null,
      cents, accepted: false, template: 'baby', note: note || ESTIMATE,
    }));
  }
  const templates = {
    list: () => [{ key: 'baby', label: 'Baby', needs: ['dueDate'] }],
    baby: babyTemplate,
  };

  // ------------------------------------------------------------------ state writes for the screen

  function planUi(state) { return state && isObj(state.ui) && isObj(state.ui.plan) ? state.ui.plan : {}; }

  /**
   * Set one dial directly (cents, may be negative), or clear it with null/undefined (back to rows
   * or baseline). A card part kept for the dial's earlier amount (ui.plan.cardSplit) is removed.
   */
  function setDial(state, key, cents) {
    let next = E.state.setPath(state, 'ui.plan.dials.' + key, cents === null ? undefined : cents);
    if (has(planUi(next).cardSplit, key)) next = E.state.setPath(next, 'ui.plan.cardSplit.' + key, undefined);
    return next;
  }

  /** Append a note to meta.migrationNotes once (kept within the limit). */
  function recordNote(state, note) {
    if (!note || !isObj(state.meta)) return state;
    const notes = Array.isArray(state.meta.migrationNotes) ? state.meta.migrationNotes : [];
    if (notes.includes(note)) return state;
    return E.state.setPath(state, 'meta.migrationNotes', notes.concat([note.slice(0, 500)]).slice(-E.state.LIMITS.migrationNotes));
  }

  /**
   * Change one drill-down row: patch { included?: boolean, cents?: number|null }. null/undefined
   * clears that part; included: true is the default and is not stored. An empty change is removed.
   */
  function setRow(state, id, patch) {
    const cur = isObj(planUi(state).rows) && isObj(own(planUi(state).rows, id)) ? planUi(state).rows[id] : {};
    const next = Object.assign({}, cur);
    for (const k of ['included', 'cents']) {
      if (!isObj(patch) || !Object.prototype.hasOwnProperty.call(patch, k)) continue;
      if (patch[k] === undefined || patch[k] === null) delete next[k];
      else next[k] = patch[k];
    }
    if (next.included === true) delete next.included;
    return E.state.setPath(state, 'ui.plan.rows.' + id, Object.keys(next).length ? next : undefined);
  }

  /**
   * Put one dial back to its baseline: its direct amount and every change to its rows are removed
   * (for irregular: every one-time cost left out is back in the allowance). With the current
   * timeline `tl`, changes saved under the earlier card/bank dials that its rows use go too.
   */
  function resetDial(state, key, tl) {
    const p = planUi(state);
    let next = setDial(state, key, undefined);
    const legacy = new Set();
    const d = tl && isObj(tl.dialsByKey) ? tl.dialsByKey[key] : null;
    for (const r of d && d.drill && d.drill.kind === 'categories' ? d.drill.rows : []) if (r.legacyId) legacy.add(r.legacyId);
    for (const id of Object.keys(isObj(p.rows) ? p.rows : {})) if (id.startsWith(key + '-') || legacy.has(id)) next = E.state.setPath(next, 'ui.plan.rows.' + id, undefined);
    if (key === 'irregular') for (const id of Object.keys(isObj(p.irregularOff) ? p.irregularOff : {})) next = E.state.setPath(next, 'ui.plan.irregularOff.' + id, undefined);
    return next;
  }

  /** Every dial, row and one-time cost back to the baseline (groups, planned changes and other settings stay). */
  function resetPlan(state) {
    const p = planUi(state);
    let next = state;
    for (const k of Object.keys(isObj(p.dials) ? p.dials : {})) next = E.state.setPath(next, 'ui.plan.dials.' + k, undefined);
    for (const id of Object.keys(isObj(p.rows) ? p.rows : {})) next = E.state.setPath(next, 'ui.plan.rows.' + id, undefined);
    for (const id of Object.keys(isObj(p.irregularOff) ? p.irregularOff : {})) next = E.state.setPath(next, 'ui.plan.irregularOff.' + id, undefined);
    for (const k of Object.keys(isObj(p.cardSplit) ? p.cardSplit : {})) next = E.state.setPath(next, 'ui.plan.cardSplit.' + k, undefined);
    return next;
  }

  /**
   * Put a category (key = its name) or a place (key = 'merchant:' + place) in 'essentials' or
   * 'flexible'; null/undefined goes back to the default (the taxonomy, or the place's categories).
   * With the current timeline `tl`, changes to the category's rows follow them to the other group
   * (row ids carry the group); without it only the category and "everything else" rows do.
   */
  function setGroup(state, key, group, tl) {
    if (typeof key !== 'string' || !key.trim()) fail('Choose a category or a place to move.', 'key');
    if (group !== null && group !== undefined && !SPEND_GROUPS.includes(group)) fail('Choose essentials or flexible.', 'group');
    const k = key.trim();
    const p = planUi(state);
    const before = isObj(p.groups) ? own(p.groups, k) : undefined;
    let next = E.state.setPath(state, 'ui.plan.groups.' + k, group === null || group === undefined ? undefined : group);
    if (k.startsWith(MERCHANT_KEY)) return next;
    const fallback = E.categories.isEssential(k) ? 'essentials' : 'flexible';
    const from = SPEND_GROUPS.includes(before) ? before : fallback;
    const to = group || fallback;
    if (from === to) return next;
    const rows = isObj(p.rows) ? p.rows : {};
    const moves = [rowIdOf(from, 'c', k), rowIdOf(from, 'r', k)];
    const d = tl && isObj(tl.dialsByKey) ? tl.dialsByKey[from] : null;
    for (const r of d && d.drill ? d.drill.rows : []) if (r.kind === 'merchant' && !r.synthetic && r.sourceCategory === k) moves.push(r.id);
    for (const id of moves) {
      if (!has(rows, id)) continue;
      const target = to + id.slice(from.length);
      if (!has(rows, target)) next = E.state.setPath(next, 'ui.plan.rows.' + target, rows[id]);
      next = E.state.setPath(next, 'ui.plan.rows.' + id, undefined);
    }
    return next;
  }

  /** Leave one one-time cost out of the irregular allowance (included false), or put it back (true). */
  function setIrregular(state, id, included) {
    if (typeof id !== 'string' || !id.trim()) fail('Choose a one-time cost.', 'id');
    return E.state.setPath(state, 'ui.plan.irregularOff.' + id.trim(), included === false ? true : undefined);
  }

  /** Add one planned change, or a list of them (e.g. templates.baby(dueDate)); each gets an id. */
  function addChange(state, item) {
    const list = Array.isArray(item) ? item : [item];
    return list.reduce((st, x) => E.state.addItem(st, 'changes', x), state);
  }

  /**
   * Change a planned change: patch any of { label, kind, group, personId, startMonth, endMonth,
   * cents, accepted, template, note }. Switching to one-time clears the end month, and away from
   * income clears the person, unless the patch sets them.
   */
  function setChange(state, id, patch) {
    if (!isObj(patch)) fail('Nothing to change.');
    const list = state && isObj(state.plan) && Array.isArray(state.plan.changes) ? state.plan.changes : [];
    const cur = list.find(c => c && c.id === id);
    if (!cur) fail('That planned change no longer exists.', 'id');
    const next = Object.assign({}, patch);
    const kind = has(next, 'kind') ? next.kind : cur.kind;
    const group = has(next, 'group') ? next.group : cur.group;
    if (kind === 'oneTime' && !has(next, 'endMonth')) next.endMonth = null;
    if (group !== 'income' && !has(next, 'personId')) next.personId = null;
    return E.state.updateItem(state, 'changes', id, next);
  }

  function removeChange(state, id) { return E.state.removeItem(state, 'changes', id); }

  /** Accept (apply to the plan) or un-accept planned changes by id (one id or a list). */
  function acceptChanges(state, ids, accepted) {
    const list = Array.isArray(ids) ? ids : [ids];
    return list.reduce((st, id) => E.state.updateItem(st, 'changes', id, { accepted: accepted !== false }), state);
  }

  /**
   * Make the row changes saved under the earlier card/bank dials permanent under their new ids
   * (tl.migration from build): each one that still matches a row moves to it (unless that row has
   * its own change), the rest are removed, and meta.migrationNotes says so. No migration: the
   * state is returned as it is.
   */
  function migrateRows(state, tl) {
    const mig = tl && isObj(tl.migration) ? tl.migration : null;
    if (!mig) return state;
    const rows = isObj(planUi(state).rows) ? planUi(state).rows : {};
    let next = state, changed = false;
    for (const { from, to } of mig.rows) {
      if (!has(rows, from)) continue;
      if (!has(rows, to)) next = E.state.setPath(next, 'ui.plan.rows.' + to, rows[from]);
      next = E.state.setPath(next, 'ui.plan.rows.' + from, undefined);
      changed = true;
    }
    for (const id of mig.dropped) if (has(rows, id)) { next = E.state.setPath(next, 'ui.plan.rows.' + id, undefined); changed = true; }
    return changed ? recordNote(next, mig.rowsNote) : next;
  }

  /**
   * Carry the amounts set for the earlier card and bank dials over to essentials, flexible and
   * irregular (tl.migration.dials from build): each dial in `to` is set directly (with its card
   * part kept in ui.plan.cardSplit, so card and bank still add up to what was set), a dial set
   * directly in the meantime is left alone, ui.plan.legacyDials (and any card/bank dial still
   * saved) is removed, and the note is appended to meta.migrationNotes. Nothing waiting: the state
   * is returned as it is, so running it twice changes nothing more.
   */
  function migrateDials(state, tl) {
    const mig = tl && isObj(tl.migration) && isObj(tl.migration.dials) ? tl.migration.dials : null;
    const p = planUi(state);
    const waiting = has(p, 'legacyDials') || LEGACY_DIALS.some(k => has(p.dials, k));
    if (!mig || !waiting) return state;
    let next = state;
    for (const k of SPEND_DIALS) {
      const cents = mig.to[k];
      if (!isCents(cents) || isCents(own(planUi(next).dials, k))) continue;
      next = setDial(next, k, cents);
      next = E.state.setPath(next, 'ui.plan.cardSplit.' + k, { cents, card: mig.parts[k].card });
    }
    next = E.state.setPath(next, 'ui.plan.legacyDials', undefined);
    for (const k of LEGACY_DIALS) if (has(planUi(next).dials, k)) next = E.state.setPath(next, 'ui.plan.dials.' + k, undefined);
    return recordNote(next, mig.note);
  }

  E.timeline = {
    BASELINE_CHOICES, HORIZONS, PAST_CHOICES, MODES, DEFAULTS, TREND_MA, TREND_DEFAULTS, SPEND_GROUPS, SPEND_DIALS, LEGACY_DIALS, OUT_DIALS, MERCHANT_KEY, CHANGE_KINDS, CHANGE_GROUPS, SERIES,
    TINY_CATEGORY_CENTS, STABLE_MIN_CHARGES, STABLE_SPREAD, OTHER_CATEGORY, SIMPLE_LABEL, RULE, SIMPLE_RULE, ILLUSTRATIVE, DIAL_LABEL,
    build, anchors, settings, depositHint, prorate, toCSV, templates,
    setDial, setRow, resetDial, resetPlan, setGroup, setIrregular, addChange, setChange, removeChange, acceptChanges, migrateRows, migrateDials,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
