'use strict';
/*
 * BudgetEngine.timeline: observed deposits (hints), the dials, one plan month from them, and the
 * carry-over of the amounts set for the earlier card and bank dials (timeline-core.js says how
 * the timeline files fit together).
 *
 * Adds to E._timeline: depositHint, buildDials, planMonth, legacyDialsPlan.
 * Uses, when called: drillFor and irregularFor (timeline-spending.js).
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const T = E._timeline;
  const { isCents, has, own, plural, sumKnown, roundCents, median, late, IN_KEYS, LEGACY_DIALS, SPEND_GROUPS, SPEND_DIALS, DIAL_LABEL } = T;
  const drillFor = late('drillFor'), irregularFor = late('irregularFor');

  const SHORT_LABEL = { essentials: 'Essentials', flexible: 'Flexible', irregular: 'Irregular' };

  function rangeText(start, end) {
    if (!start) return '';
    return start === end ? E.months.label(start) : E.months.label(start) + '–' + E.months.label(end);
  }

  // ------------------------------------------------------------------ hints: observed deposits

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

  /**
   * The dials. `targets` (plan.targets) are the category budgets the essentials and flexible rows
   * use; `goals` (plan.savings) give the savings dial its baseline when any has a monthly amount;
   * `investments`: whether the data has an investment account (the investing dial is shown then
   * even with no transfers to it yet). While ui.plan.otherDial is 'withInvesting' (an amount saved
   * for `other` before investments had their own dial), that amount is read as debt & business
   * plus investments at their baseline (other = amount − the investing baseline) until the plan
   * screen makes the split permanent (timeline.splitOther). `seenDebtCents` (billChanges): the
   * current debt-payment bills the baseline months hold; the debt part of the other dial's
   * baseline is the average of debt payments, or that total when it is more (the bills are in
   * the history, so they replace a diluted average instead of adding to it).
   */
  function buildDials({ base, people, cfg, byId, requested, funding, targets, goals, investments, seenDebtCents }) {
    const n = base.count;
    const T = base.total.planning;
    const avg = cents => (n ? E.money.divide(cents, n) : null);
    const ids = new Set(people.map(p => p.id));
    const range = rangeText(base.start, base.end);
    const windowText = !n ? 'No complete month yet, so there is no baseline'
      : requested === 'all' ? 'Average of all ' + plural(n, 'complete month') + ', ' + range
        : 'Average of ' + range + ', ' + plural(n, 'month') + (n < requested ? ' (all there are)' : '');
    // The amounts set directly; an earlier `other` amount still holding investments reads as its debt & business part.
    const setDials = Object.assign({}, cfg.dials);
    const investBase = avg(T.investNet);
    const splitWaiting = cfg.otherDial === 'withInvesting' && isCents(own(setDials, 'other'));
    if (splitWaiting) setDials.other = setDials.other - (investBase || 0);
    const resolve = (key, baselineCents, rowsCents, rowsSet) => {
      if (isCents(own(setDials, key))) return { planCents: setDials[key], source: 'direct' };
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
    const legacy = [], superseded = [], regrouped = [];
    for (const key of SPEND_GROUPS) {
      const drill = drillFor(key, base, byId, cfg, targets);
      legacy.push(...drill.legacy);
      superseded.push(...drill.superseded);
      regrouped.push(...drill.regrouped);
      delete drill.legacy;
      delete drill.superseded;
      delete drill.regrouped;
      const extra = n && drill.yearlyCount ? plural(drill.yearlyCount, 'yearly bill') + ' spread over 12 months' : '';
      const d = Object.assign({ key, group: 'out', label: DIAL_LABEL[key], baselineCents: drill.baselineCents }, resolve(key, drill.baselineCents, drill.rowsCents, drill.overridden), {
        basis: windowText + (extra ? '; ' + extra : '') + (drill.stableCount ? '; regular bills at their latest amount' : '')
          + (drill.budgetCount ? '; ' + plural(drill.budgetCount, 'category budget') + ' from Budget' : ''), hint: null, drill,
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
    // Net to savings: the savings goals' monthly amounts saved in Budget, when any has one; else the average.
    const averageSavings = avg(T.savingsNet);
    const funded = (Array.isArray(goals) ? goals : []).filter(g => g && isCents(g.monthlyCents) && g.monthlyCents >= 0);
    const goalsCents = funded.length ? funded.reduce((sum, g) => sum + g.monthlyCents, 0) : null;
    const savingsBase = goalsCents !== null ? goalsCents : averageSavings;
    const savingsKind = isCents(own(setDials, 'savings')) ? 'direct' : goalsCents !== null ? 'budget' : 'average';
    dials.push(Object.assign({ key: 'savings', group: 'out', label: DIAL_LABEL.savings, baselineCents: savingsBase }, resolve('savings', savingsBase), {
      basis: goalsCents !== null ? 'From Budget: ' + plural(funded.length, 'savings goal') + ' (' + E.money.format(goalsCents) + ' a month)'
        : windowText + (n ? ' (into savings minus out of savings)' : ''),
      hint: null, drill: null, budgetCents: goalsCents, averageCents: averageSavings, basisKind: savingsKind,
    }));
    // Net to investments: transfers to investment accounts minus money brought back (never joint cash).
    if ((investBase !== null && investBase !== 0) || isCents(own(setDials, 'investing')) || investments || splitWaiting) {
      dials.push(Object.assign({ key: 'investing', group: 'out', label: DIAL_LABEL.investing, baselineCents: investBase }, resolve('investing', investBase), {
        basis: windowText + (n ? ' (into investments minus money brought back)' : ''), hint: null, drill: null,
      }));
    }
    // Debt payments: their average, or the current debt bills the history holds when those are more.
    const debtAvg = avg(T.debt);
    const debtBills = isCents(seenDebtCents) && debtAvg !== null && seenDebtCents > debtAvg ? seenDebtCents : null;
    parts.debt = debtBills !== null ? debtBills : debtAvg;
    parts.business = avg(T.business);
    const otherBase = debtBills !== null ? debtBills + parts.business : avg(T.debt + T.business);
    if ((otherBase !== null && otherBase !== 0) || isCents(own(setDials, 'other'))) {
      dials.push(Object.assign({ key: 'other', group: 'out', label: DIAL_LABEL.other, baselineCents: otherBase }, resolve('other', otherBase), {
        basis: windowText + (n ? ' (debt payments and business purchases)' : '')
          + (debtBills !== null ? '; debt payments at your current debt bills from Budget (' + E.money.format(debtBills) + ' a month, not the average of ' + E.money.format(debtAvg) + ')' : ''),
        hint: null, drill: null,
        split: splitWaiting ? { fromCents: cfg.dials.other, investingCents: investBase || 0, otherCents: setDials.other } : null,
      }));
    }
    const carriedOver = carriedOverOf(dials, cfg);
    return { dials, parts, windowText, legacy, superseded, regrouped, carriedOver };
  }

  /**
   * Spending dials that still hold exactly the amount carried over from the earlier card/bank
   * dials (their ui.plan.cardSplit entry matches the dial and still has fromCard/fromBank) get
   * `carriedOver: { from: 'card'|'bank'|'both', cardTotalCents, bankTotalCents, note }`; every
   * other dial gets null. The note says the parts add up to what was set only when that is still
   * true (all three dials hold their carried-over amounts and the parts sum to it).
   * Returns the same for the screen's headline area, plus { dials, summary }, or null.
   */
  function carriedOverOf(dials, cfg) {
    for (const d of dials) d.carriedOver = null;
    const spend = SPEND_DIALS.map(k => dials.find(d => d.key === k)).filter(Boolean);
    const holds = d => {
      const sp = own(cfg.cardSplit, d.key);
      return sp && d.source === 'direct' && sp.cents === d.planCents ? sp : null;
    };
    const marked = spend.filter(d => holds(d) && (isCents(holds(d).fromCard) || isCents(holds(d).fromBank)));
    if (!marked.length) return null;
    const first = holds(marked[0]);
    const cardTotalCents = isCents(first.fromCard) ? first.fromCard : null;
    const bankTotalCents = isCents(first.fromBank) ? first.fromBank : null;
    const from = cardTotalCents !== null && bankTotalCents !== null ? 'both' : cardTotalCents !== null ? 'card' : 'bank';
    const all = spend.length === SPEND_DIALS.length && spend.every(d => holds(d));
    const addsUp = all && (cardTotalCents === null || spend.reduce((s, d) => s + holds(d).card, 0) === cardTotalCents)
      && (bankTotalCents === null || spend.reduce((s, d) => s + holds(d).cents - holds(d).card, 0) === bankTotalCents);
    const money = E.money.format;
    const what = from === 'both' ? 'card spending setting of ' + money(cardTotalCents) + ' and bank spending setting of ' + money(bankTotalCents)
      : from + ' spending setting of ' + money(from === 'card' ? cardTotalCents : bankTotalCents);
    const note = 'Carried over from your earlier ' + what
      + (addsUp ? ' (' + (from === 'both' ? 'card and bank parts' : from + ' parts') + ' of Essentials, Flexible and Irregular add up to ' + (from === 'both' ? 'them' : 'it') + ').' : '.');
    const info = { from, cardTotalCents, bankTotalCents, note };
    for (const d of marked) d.carriedOver = Object.assign({}, info);
    const n = marked.length;
    return Object.assign({}, info, {
      dials: marked.map(d => d.key),
      summary: ['One dial carries', 'Two dials carry', 'Three dials carry'][n - 1] + ' your earlier ' + what + ' — review ' + (n > 1 ? 'them' : 'it') + ', then Keep or Reset.',
    });
  }

  /**
   * One plan month from the dials (same keys as an actual month): at each dial's plan amount, or
   * with `atBaseline` at each dial's baseline (the "no changes" plan the chart can draw as a ghost).
   * out.card / out.bank are worked out from the spending dials; out.other = debt + business (the
   * other dial), out.invest = the investing dial; out.total = essentials + flexible + irregular +
   * other + invest. Also: combinedChange = in − out (moves to and from
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
    if (other === null) { out.debt = null; out.business = null; }
    else if (other !== 0) {
      // Split like the baseline (debt, business); all of it is debt when the baseline has none.
      const bd = parts.debt || 0;
      const baseTotal = dial('other') ? dial('other').baselineCents || 0 : 0;
      if (!baseTotal) out.debt = other;
      else if (other === baseTotal) { out.debt = bd; out.business = other - bd; }
      else {
        out.debt = Math.round(other * bd / baseTotal);
        out.business = other - out.debt;
      }
    }
    out.invest = v('investing');
    out.other = sumKnown([out.debt, out.business]);
    out.total = sumKnown([spending, out.other, out.invest]);
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
   * part (the others' card parts are $0). A bank amount likewise on the bank parts. Each amount
   * replaces the rows on its own side, as the earlier dial did. A side that was not set keeps what
   * the rows give it now (drill rowsCardCents, and rowsCents − rowsCardCents for the bank side),
   * so the household's row changes on that side still count. Each dial's amount = its card part +
   * its bank part. A dial the household already set directly is left alone (to: null, named in
   * `skipped` and in the note). With no baseline yet (no complete month), everything set goes to
   * Flexible.
   * @returns {{ from: { card?, bank? }, to: { essentials, flexible, irregular }, parts: { [dial]: { card, bank }|null },
   *   skipped: string[], note: string }|null}
   */
  function legacyDialsPlan(dialsByKey, cfg) {
    const from = {};
    for (const k of LEGACY_DIALS) if (isCents(own(cfg.legacyDials, k))) from[k] = cfg.legacyDials[k];
    const sides = LEGACY_DIALS.filter(k => has(from, k));
    if (!sides.length) return null;
    const skipped = SPEND_DIALS.filter(k => isCents(own(cfg.dials, k)));
    const known = SPEND_DIALS.every(k => {
      const d = dialsByKey[k];
      return d && isCents(d.baselineCardCents) && isCents(d.baselineBankCents) && d.drill && isCents(d.drill.rowsCents) && isCents(d.drill.rowsCardCents);
    });
    const parts = {};
    const how = {};
    if (!known) {
      for (const k of SPEND_DIALS) parts[k] = null;
      parts.flexible = { card: has(from, 'card') ? from.card : 0, bank: has(from, 'bank') ? from.bank : 0 };
    } else {
      // What the rows give each side now (row changes included), until an amount replaces that side.
      for (const k of SPEND_DIALS) {
        const drill = dialsByKey[k].drill;
        parts[k] = { card: drill.rowsCardCents, bank: drill.rowsCents - drill.rowsCardCents };
      }
      for (const side of sides) {
        // Shared out in proportion to the baseline, like the earlier dial's own baseline.
        const base = SPEND_DIALS.map(k => (side === 'card' ? dialsByKey[k].baselineCardCents : dialsByKey[k].baselineBankCents));
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

  Object.assign(T, { depositHint, buildDials, planMonth, legacyDialsPlan, budgetFor });
})(typeof globalThis !== 'undefined' ? globalThis : this);
