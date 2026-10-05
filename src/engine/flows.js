'use strict';
/*
 * BudgetEngine.flows — where the joint money goes, by role and by how it was paid, to the cent.
 *
 * Every counted row of a joint account gets one role:
 *   card        purchases (and refunds) on a credit card or store-financing account
 *   bank        purchases, bills and the mortgage paid straight from checking (or another cash account)
 *   repayment   checking → card payments: they settle what the card already counted, so they are
 *               reported but never counted as spending a second time
 *   debt        loan and store-card payments recorded as debt payments
 *   business    purchases marked as business costs (they still left a joint account)
 *   savings     transfers to and from cash savings (gross in, gross out, net)
 *   investment  transfers to and from investments (kept apart from cash savings); rows on an
 *               investment account itself are not joint cash and are left out
 *   interest    interest paid by the bank
 *   credit      money in: a partner's pay or transfer (p1 / p2), or unassigned when nobody can say whose
 *   internal    moves between the household's own accounts (not money in or out)
 *
 * So:  net card spending  = card purchases − card refunds
 *      consumption        = net card spending + net bank-paid spending
 *      joint funding      = p1 + p2 (unassigned credits and interest are shown apart)
 *      left over          = money in − consumption − debt − business − net savings − net investments
 *
 * History is never changed: one-time expenses still count in the actual months; only the
 * baseline the plan starts from leaves them out. In the baseline months every purchase is one of:
 *   one-time   left out by the household, or found automatically: a purchase of $500 or more from
 *              a place that is not regular (not seen in most of those months), with no yearly
 *              repeat; a place that charged twice in one month still counts as not regular
 *              (the household can say "count it as regular", which wins)
 *   yearly     the same place charged a similar amount about a year earlier or later: kept, but
 *              spread as 1/12 a month (a 3-month baseline would otherwise count it as 1/3 a month)
 *   regular    the same place in most of the baseline months (bills, subscriptions, the mortgage)
 *   everyday   everything else (groceries, fuel, eating out…), refunds included
 *
 * The plan side: joint funding per partner from the Budget's current income streams (the joint
 * portion, never gross or full take-home pay), which the Plan screen's money-in dials start from.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  /** Amounts added up per month; everything else is worked out from these. */
  const BASE_KEYS = ['p1', 'p2', 'p1Provisional', 'p2Provisional', 'unassigned', 'interest',
    'cardPurchases', 'cardRefunds', 'bankPurchases', 'bankRefunds', 'cardRepayments', 'debt', 'business',
    'savingsIn', 'savingsOut', 'investIn', 'investOut'];
  const ROLES = ['card', 'bank', 'repayment', 'debt', 'business', 'savings', 'investment', 'interest', 'credit', 'internal'];
  /** One-time purchases: at least this big, from a place that is not regular (REGULAR_SHARE). */
  const ONE_OFF_MIN_CENTS = 50000;
  /** "Similar" for the yearly check: another purchase from the same place of at least this share of it. */
  const ONE_OFF_REPEAT_SHARE = 0.5;
  /** A similar purchase this many months before or after makes it a yearly bill, not a one-time cost. */
  const YEARLY_GAPS = [11, 12, 13];
  /** "Regular": the same place in at least this share of the baseline months (and at least 2). */
  const REGULAR_SHARE = 0.6;

  const isCents = v => Number.isSafeInteger(v);
  const cardLike = t => t.accountType === 'credit_card' || t.accountType === 'loan';

  /** The role of one effective transaction (see the header). */
  function roleOf(t) {
    switch (t.kind) {
      case 'spend': return t.excluded === 'business' ? 'business' : cardLike(t) ? 'card' : 'bank';
      case 'card_payment': return cardLike(t) ? 'internal' : 'repayment';
      case 'debt_payment': return 'debt';
      case 'income': return t.subtype === 'interest' ? 'interest' : 'credit';
      case 'transfer':
        if (t.subtype === 'savings') return 'savings';
        if (t.subtype === 'investment') return 'investment';
        if (t.subtype === 'contribution') return 'credit';
        return 'internal';
      default: return 'internal';
    }
  }

  function zero() {
    const o = {};
    for (const k of BASE_KEYS) o[k] = 0;
    return o;
  }

  /** Totals worked out from the base amounts, so every view adds up the same way. */
  function derive(c) {
    const o = Object.assign({}, c);
    o.cardNet = c.cardPurchases - c.cardRefunds;
    o.bankNet = c.bankPurchases - c.bankRefunds;
    o.consumption = o.cardNet + o.bankNet;
    o.funding = c.p1 + c.p2;
    o.moneyIn = o.funding + c.unassigned + c.interest;
    o.savingsNet = c.savingsIn - c.savingsOut;
    o.investNet = c.investIn - c.investOut;
    o.left = o.moneyIn - o.consumption - c.debt - c.business - o.savingsNet - o.investNet;
    return o;
  }

  /**
   * Add one row to the month's amounts. Returns the row's role and the amount it moved, signed
   * the way the role reads (outflows positive for spending, debt and savings; inflows positive for credits).
   */
  function add(c, t, explain) {
    const role = roleOf(t);
    const m = E.ledger.measure(t);
    let cents = 0;
    let who = null, basis = null;
    switch (role) {
      case 'card':
      case 'bank': {
        cents = m.spendCents; // purchases positive, refunds negative; excluded rows count 0
        if (cents > 0) c[role + 'Purchases'] += cents;
        else if (cents < 0) c[role + 'Refunds'] += 0 - cents;
        break;
      }
      case 'business':
        cents = 0 - t.amountCents;
        c.business += cents;
        break;
      case 'repayment':
        if (t.excluded) break;
        cents = 0 - t.amountCents;
        c.cardRepayments += cents;
        break;
      case 'debt':
        cents = m.debtCents;
        c.debt += cents;
        break;
      case 'savings':
      case 'investment': {
        cents = m.savedCents; // positive = into savings / investments
        const k = role === 'savings' ? 'savings' : 'invest';
        if (cents > 0) c[k + 'In'] += cents;
        else if (cents < 0) c[k + 'Out'] += 0 - cents;
        break;
      }
      case 'interest':
        cents = m.incomeCents;
        c.interest += cents;
        break;
      case 'credit': {
        cents = m.incomeCents + m.contributionCents;
        if (!cents) break;
        const x = explain ? explain(t) : { who: null, basis: null };
        who = x.who; basis = x.basis;
        if (who === 'p1' || who === 'p2') {
          c[who] += cents;
          if (basis === 'income' || basis === 'amount') c[who + 'Provisional'] += cents;
        } else c.unassigned += cents;
        break;
      }
      default:
        break;
    }
    return { role, cents, who, basis };
  }

  /**
   * Month-by-month amounts for the joint accounts.
   * @param {object[]} txns effective transactions (ledger.applyEdits, no what-if)
   * @param {object} dataset normalized dataset
   * @param {{ months?: string[], coverageMap?: object, plan?: object }} opts plan: for whose money a deposit is
   * @returns {{ month, coverage, actual: object|null, planning: object|null, oneOffs: object[], credits: object[], spends: object[] }[]}
   *   actual: every counted row; planning: without rows left out of the planning baseline.
   *   Both are null when the month is not fully covered by every spending account's export.
   *   oneOffs: rows left out of the planning baseline; credits: money-in rows with whose money
   *   they are; spends: every card and bank-paid purchase and refund (for one-time, yearly and
   *   regular spending in the baseline).
   */
  function breakdown(txns, dataset, { months, coverageMap, plan } = {}) {
    const list = months || E.ledger.months(dataset);
    const cov = coverageMap || E.ledger.coverageMap(dataset);
    const explain = E.balances.incomeAttribution(plan || {}).explain;
    const byMonth = new Map(list.map(m => [m, []]));
    for (const t of E.ledger.filter(txns, { scope: 'joint', includeExcluded: true })) {
      // Money inside an investment account (its own buys, sells, dividends) is not joint cash; a
      // transfer to it is counted once, on the cash side (role investment).
      if (t.accountType === 'investment') continue;
      const m = t.date.slice(0, 7);
      if (byMonth.has(m)) byMonth.get(m).push(t);
    }
    return list.map(month => {
      const status = cov[month] ? cov[month].status : 'none';
      if (status !== 'full') return { month, coverage: status, actual: null, planning: null, oneOffs: [], credits: [], spends: [] };
      const actual = zero(), planning = zero();
      const oneOffs = [], credits = [], spends = [];
      for (const t of byMonth.get(month)) {
        const r = add(actual, t, explain);
        if (!t.planningExcluded) add(planning, t, explain);
        const info = { id: t.id, date: t.date, description: t.description, merchant: t.merchant || t.description, accountLabel: t.accountLabel || t.accountId, role: r.role, cents: r.cents };
        if (t.planningExcluded && r.cents) oneOffs.push(info);
        if (r.role === 'credit' && r.cents) credits.push(Object.assign(info, { who: r.who, basis: r.basis, kind: t.kind, subtype: t.subtype }));
        if ((r.role === 'card' || r.role === 'bank') && r.cents) spends.push(Object.assign({}, info, { planningExcluded: !!t.planningExcluded, keepRegular: !!(t.edit && t.edit.planningBaseline === 'include') }));
      }
      return { month, coverage: status, actual: derive(actual), planning: derive(planning), oneOffs, credits, spends };
    });
  }

  /**
   * The baseline: the last `count` complete months ending at `endMonth` (default: the latest one).
   * total.actual is what happened (sums, to the cent). total.planning is what the plan starts from:
   * one-time purchases left out and yearly bills spread as 1/12 a month (see the header).
   * avg.* are monthly averages of the base amounts with the totals worked out from them, so the
   * averages add up the same way.
   * @returns {{ months: string[], count: number, start: string|null, end: string|null,
   *   total: { actual, planning }, avg: { actual, planning }, oneTime: object[], yearly: object[],
   *   keptRegular: object[], kinds: { card: object, bank: object }, oneOffs: object[], credits: object[],
   *   spends: object[], regularAt: number }}
   *   oneTime: { …row, auto } (auto = found automatically, not chosen); yearly: { …row, spreadCents }
   *   (what stays in the baseline months); keptRegular: big purchases the household said to count
   *   as regular; kinds.<role>: totals of { regular, yearly, everyday, oneTime } over the months.
   *   spends: every card and bank-paid purchase and refund in the months with its `kind` and
   *   `planCents` (what it adds to total.planning: 0 for one-time, the spread for yearly, else
   *   its cents), so a drill-down adds up to the planning totals to the cent.
   *   regularAt: the number of months a place must appear in to count as regular.
   */
  function baseline(rows, { count = 12, endMonth } = {}) {
    const used = rows.filter(r => r.actual && (!endMonth || r.month <= endMonth)).slice(-count);
    const n = used.length;
    const sum = key => {
      const o = zero();
      for (const r of used) for (const k of BASE_KEYS) o[k] += r[key][k];
      return o;
    };
    const avgOf = o => {
      const a = {};
      for (const k of BASE_KEYS) a[k] = n ? E.money.divide(o[k], n) : null;
      return n ? derive(a) : null;
    };
    const totalActual = sum('actual'), totalPlanning = sum('planning');

    // Every purchase in these months: one-time, yearly, regular or everyday.
    const spends = used.flatMap(r => r.spends || []);
    const purchases = spends.filter(x => x.cents > 0);
    const everywhere = rows.flatMap(r => r.spends || []).filter(x => x.cents > 0);
    const similar = (x, o) => o.id !== x.id && o.merchant === x.merchant && o.cents >= x.cents * ONE_OFF_REPEAT_SHARE;
    const gap = (a, b) => Math.abs(E.months.between(a.slice(0, 7), b.slice(0, 7)));
    const monthsOf = new Map();
    for (const x of purchases) {
      if (!monthsOf.has(x.merchant)) monthsOf.set(x.merchant, new Set());
      monthsOf.get(x.merchant).add(x.date.slice(0, 7));
    }
    const regularAt = Math.max(2, Math.ceil(n * REGULAR_SHARE));
    const kinds = { card: { regular: 0, yearly: 0, everyday: 0, oneTime: 0 }, bank: { regular: 0, yearly: 0, everyday: 0, oneTime: 0 } };
    const oneTime = [], yearly = [], keptRegular = [], classified = [];
    for (const x of spends) {
      let kind, planCents = x.cents;
      if (x.planningExcluded) {
        kind = 'oneTime';
        planCents = 0;
        oneTime.push(Object.assign({}, x, { auto: false }));
      } else if (x.cents >= ONE_OFF_MIN_CENTS && monthsOf.get(x.merchant).size < regularAt) {
        if (everywhere.some(o => similar(x, o) && YEARLY_GAPS.includes(gap(x.date, o.date)))) {
          kind = 'yearly';
          const spreadCents = Math.round(x.cents * Math.min(n, 12) / 12);
          totalPlanning[x.role + 'Purchases'] -= x.cents - spreadCents;
          planCents = spreadCents;
          yearly.push(Object.assign({}, x, { spreadCents }));
        } else if (x.keepRegular) {
          kind = 'everyday';
          keptRegular.push(x);
        } else {
          kind = 'oneTime';
          planCents = 0;
          totalPlanning[x.role + 'Purchases'] -= x.cents;
          oneTime.push(Object.assign({}, x, { auto: true }));
        }
      } else if (x.cents > 0 && monthsOf.get(x.merchant).size >= regularAt) kind = 'regular';
      else kind = 'everyday';
      kinds[x.role][kind] += x.cents;
      classified.push(Object.assign({}, x, { kind, planCents }));
    }
    const byAmount = (a, b) => b.cents - a.cents || (a.date < b.date ? -1 : 1);
    return {
      months: used.map(r => r.month), count: n,
      start: n ? used[0].month : null, end: n ? used[n - 1].month : null,
      total: { actual: derive(totalActual), planning: derive(totalPlanning) },
      avg: { actual: avgOf(totalActual), planning: avgOf(totalPlanning) },
      oneTime: oneTime.sort(byAmount), yearly: yearly.sort(byAmount), keptRegular: keptRegular.sort(byAmount), kinds,
      oneOffs: used.flatMap(r => r.oneOffs),
      credits: used.flatMap(r => r.credits),
      spends: classified, regularAt,
    };
  }

  /** Money for `count` paychecks: the annual average rounds once (per × perYear / 12). */
  function amountFor(per, c) {
    if (!isCents(per)) return null;
    if (c.basis === 'average' && c.perYear) return E.money.divide(per * c.perYear, 12);
    return Math.round(per * c.count);
  }

  /**
   * Each partner's joint funding in the current plan (the Budget's income streams in `month`).
   * Per stream: gross (from a pay stub, when entered), take-home, the part kept personally and the
   * joint contribution, per paycheck and per month. Only the joint contribution is household
   * funding: gross and full take-home are detail.
   * @param {object} plan state.plan
   * @param {{ month: string, timing?: string }} opts timing: 'conservative' (default) or 'average';
   *   'actual' becomes 'conservative' because a recurring plan is not one calendar month.
   * @returns {{ month, timing, people: { [pid]: { id, name, jointCents: number|null, streams: object[], ended: object[] } }, otherCents: number, otherLines: object[] }}
   */
  function planFunding(plan, { month, timing } = {}) {
    if (!E.months.isMonth(month)) throw new E.ValidationError('Plan funding needs a month.', 'month');
    const t = timing === 'average' ? 'average' : 'conservative';
    const pm = E.plan.monthly(plan, { scope: 'joint', month, timing: t });
    const people = {};
    for (const p of (plan && Array.isArray(plan.people) ? plan.people : [])) {
      if (!p || (p.id !== 'p1' && p.id !== 'p2')) continue;
      const streams = [], ended = [];
      for (const s of (Array.isArray(plan.incomes) ? plan.incomes : [])) {
        if (!s || s.personId !== p.id) continue;
        const c = E.schedule.count(s, month, t);
        const line = pm.income.lines.find(l => l.id === s.id) || null;
        const notCounted = pm.income.notCounted.find(l => l.id === s.id) || null;
        const isPay = s.kind === 'paycheck';
        const per = {
          gross: isPay && isCents(s.grossPerPaycheckCents) ? s.grossPerPaycheckCents : null,
          net: isPay && isCents(s.netPerPaycheckCents) ? s.netPerPaycheckCents : null,
          joint: line ? line.perPaycheckCents : (notCounted ? 0 : null),
        };
        if (!isCents(per.joint)) per.joint = null;
        per.kept = isPay && per.net !== null && per.joint !== null ? per.net - per.joint : null;
        const info = {
          id: s.id, label: s.label, kind: s.kind, status: s.status, frequency: s.frequency, frequencyStatus: s.frequencyStatus,
          startMonth: s.startMonth || null, endMonth: s.endMonth || null,
          count: c.count, basis: c.basis, assumption: line ? line.assumption : c.assumption,
          perPaycheck: per,
          monthly: {
            gross: amountFor(per.gross, c), net: amountFor(per.net, c), kept: amountFor(per.kept, c),
            joint: line ? line.cents : (notCounted ? 0 : null),
          },
          viaTransfers: !!notCounted,
        };
        if (s.endMonth && s.endMonth < month) {
          // Ended (old pay): a month of it at its own rate, as if it still ran, for comparison only.
          const old = E.schedule.count(Object.assign({}, s, { startMonth: null, endMonth: null }), month, t);
          info.count = old.count;
          info.basis = old.basis;
          info.monthly = {
            gross: amountFor(per.gross, old), net: amountFor(per.net, old), kept: amountFor(per.kept, old),
            joint: notCounted ? 0 : amountFor(per.joint, old),
          };
          ended.push(info);
        } else if (c.count > 0) {
          streams.push(info);
        }
      }
      const active = streams.filter(s => !s.viaTransfers);
      const jointCents = !active.length ? null : active.some(s => s.monthly.joint === null) ? null : active.reduce((sum, s) => sum + s.monthly.joint, 0);
      people[p.id] = { id: p.id, name: p.name || p.id, jointCents, streams, ended };
    }
    const otherLines = pm.income.lines.filter(l => l.personId !== 'p1' && l.personId !== 'p2' && isCents(l.cents) && l.cents !== 0);
    return { month, timing: t, people, otherCents: otherLines.reduce((s, l) => s + l.cents, 0), otherLines };
  }

  E.flows = { BASE_KEYS, ROLES, ONE_OFF_MIN_CENTS, ONE_OFF_REPEAT_SHARE, YEARLY_GAPS, REGULAR_SHARE, roleOf, derive, breakdown, baseline, planFunding };
})(typeof globalThis !== 'undefined' ? globalThis : this);
