'use strict';
/*
 * Monthly budget model (docs/ARCHITECTURE.md §5 and §8, BudgetEngine.plan).
 *
 * Two scopes answer two different questions:
 *   joint      "What flows through the shared accounts?" Joint deposits only (the joint portion
 *              of paychecks, contributions transferred in, other joint income), variable-spending
 *              targets, bills paid from joint, and savings contributions.
 *   household  "What does the whole household earn and spend?" Full take-home pay, every bill no
 *              matter who pays it, targets, savings, and personal spending.
 *
 * Never count money twice:
 *   - A contribution is a transfer from a partner's personal account. It is joint income in joint
 *     scope but NOT extra income in household scope (that partner's pay is the income).
 *   - A personal allocation (take-home minus the joint portion) is not an expense by itself. It
 *     pays that person's personal bills (already counted as bills) and any contribution they
 *     transfer to joint; whatever is left is counted once as personal spending.
 *
 * Unknown is not zero: null amounts are left out of totals and listed in `missing`. When any
 * take-home pay is unknown the income total and the remaining amount are null; the known part
 * and a lower bound are reported separately.
 *
 * Unknown never makes the budget look better. In household scope, when someone's take-home pay
 * is known but their transfer to joint is not, their personal spending (allocation − personal
 * bills − transfers) cannot be worked out. It is not dropped or replaced by an estimate (either
 * would change the result just because a number is unknown): it is listed as missing and the
 * remaining amount is null, with `remainingUnknownReason` saying why.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const SCOPES = ['joint', 'household'];
  const TIMINGS = ['actual', 'conservative', 'average'];
  const FUNDING_PEOPLE = ['p1', 'p2'];

  const TIMING_TEXT = {
    conservative: 'Income counts a typical month: weekly 4, biweekly 2, semimonthly 2, monthly 1 paychecks. Months with an extra paycheck are not counted on.',
    average: 'Income uses the annual monthly average (weekly 52/12, biweekly 26/12 paychecks a month), spreading extra paychecks evenly over the year.',
    actual: 'Income counts the actual paydays in the month (biweekly pay gives two months a year a third paycheck).'
  };

  // ------------------------------------------------------------------ small helpers

  function fail(message, field) { throw new E.ValidationError(message, field); }
  const isCents = v => E.money.isCents(v);
  const arr = v => (Array.isArray(v) ? v : []);
  const money = c => (c === null || c === undefined ? 'not entered' : E.money.format(c));
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  function peopleOf(plan) {
    const list = arr(plan.people).filter(p => p && typeof p.id === 'string');
    const ids = new Set(list.map(p => p.id));
    // People referenced by streams or bills but missing from plan.people still get an entry.
    for (const s of arr(plan.incomes)) if (s && FUNDING_PEOPLE.includes(s.personId) && !ids.has(s.personId)) { ids.add(s.personId); list.push({ id: s.personId, name: s.personId }); }
    for (const b of arr(plan.bills)) if (b && FUNDING_PEOPLE.includes(b.fundedFrom) && !ids.has(b.fundedFrom)) { ids.add(b.fundedFrom); list.push({ id: b.fundedFrom, name: b.fundedFrom }); }
    return list;
  }

  function nameOf(plan, personId) {
    const p = arr(plan.people).find(x => x && x.id === personId);
    return (p && p.name) || personId || 'Someone';
  }

  function possessive(name) { return /s$/i.test(name) ? name + "'" : name + "'s"; }

  /** True when the item's optional startMonth..endMonth window includes `month` (always true without a month). */
  function activeIn(item, month) {
    if (!month) return true;
    if (E.months.isMonth(item.startMonth) && month < item.startMonth) return false;
    if (E.months.isMonth(item.endMonth) && month > item.endMonth) return false;
    return true;
  }

  /**
   * Paycheck count for a stream. Without a month, start/end windows are ignored and the timing
   * must be conservative or average (callers convert 'actual' first).
   */
  function countFor(stream, month, timing) {
    const S = E.schedule;
    if (month) return S.count(stream, month, timing);
    // Any month works here: conservative/average counts do not depend on the calendar.
    return S.count(Object.assign({}, stream, { startMonth: null, endMonth: null }), '2000-01', timing);
  }

  /** Money for `count` paychecks; the annual average rounds once (per × perYear / 12). */
  function centsFor(perCents, c) {
    if (perCents === null) return null;
    if (c.basis === 'average' && c.perYear) return E.money.divide(perCents * c.perYear, 12);
    return Math.round(perCents * c.count);
  }

  /**
   * A usable plan amount: integer cents of 0 or more. Anything else (blank, negative, not a whole
   * number of cents) is unknown, so it is listed as missing instead of shrinking a total.
   */
  function knownOrNull(v) { return isCents(v) && v >= 0 ? v : null; }

  function hasContributionStream(plan, personId) {
    return arr(plan.incomes).some(s => s && s.kind === 'contribution' && s.personId === personId);
  }

  /**
   * Schedule assumption for a contribution, worded in transfers rather than paychecks
   * (BudgetEngine.schedule words every stream as pay). Covers the same cases schedule.count
   * assumes: an unknown frequency, a frequency marked unknown, and actual timing without dates.
   */
  function transferAssumption(stream, c, timing) {
    if (!c.assumption) return null;
    const name = stream.label || stream.id || 'This transfer';
    if (c.basis === 'assumed') return 'Transfer schedule not confirmed: assuming ' + plural(c.count, 'transfer') + ' a month for ' + name + '.';
    const parts = [];
    if (stream.frequencyStatus === 'unknown') parts.push('Transfer schedule not confirmed: assuming ' + stream.frequency + ' transfers for ' + name + '.');
    if (timing === 'actual' && c.basis === 'typical') {
      parts.push('No transfer ' + (stream.frequency === 'monthly' ? 'day of the month' : 'date') + ' entered for ' + name + ': counting a typical month of ' +
        plural(c.count, 'transfer') + ' (' + stream.frequency + ') instead of actual transfer dates.');
    }
    return parts.length ? parts.join(' ') : c.assumption;
  }

  // ------------------------------------------------------------------ income

  /**
   * Income section plus the per-person facts the personal-allocation step needs.
   * Mutates only the passed accumulators (missing, assumptions, warnings).
   */
  function buildIncome(plan, scope, month, timing, people, acc) {
    const lines = [];
    const notCounted = [];
    // personId -> per-person facts: known take-home, joint portion, allocation and contributions
    // (unknownContributionIds: contribution streams whose amount this month is unknown).
    const newFacts = () => ({ netCents: 0, netKnown: true, jointCents: 0, allocationCents: 0, allocationKnown: true, hasPaycheck: false, contributionsCents: 0, contributionsKnown: true, hasContribution: false, unknownContributionIds: [] });
    const persons = new Map(people.map(p => [p.id, newFacts()]));
    const personFacts = id => {
      if (!persons.has(id)) persons.set(id, newFacts());
      return persons.get(id);
    };
    let incomeUnknown = false;

    for (const stream of arr(plan.incomes)) {
      if (!stream || typeof stream !== 'object') continue;
      const kind = ['paycheck', 'contribution', 'other'].includes(stream.kind) ? stream.kind : 'other';
      const label = stream.label || stream.id || 'Income';
      const c = countFor(stream, month, timing);
      const net = knownOrNull(stream.netPerPaycheckCents);
      const joint = knownOrNull(stream.jointPerPaycheckCents);
      const pid = stream.personId;
      const isPerson = FUNDING_PEOPLE.includes(pid) || persons.has(pid);
      const pname = nameOf(plan, pid);
      const assumption = kind === 'contribution' ? transferAssumption(stream, c, timing) : c.assumption;
      const base = { id: stream.id, label, personId: pid ?? null, kind, count: c.count, basis: c.basis, dates: c.dates, assumption };
      // Outside its start/end window a stream pays nothing this month: a known $0, even if its amount is unknown.
      const inactive = c.count === 0;
      const amount = per => (inactive ? 0 : centsFor(per, c));

      // Per-person bookkeeping (both scopes): take-home, joint portion, personal allocation.
      if (isPerson && kind === 'paycheck') {
        const f = personFacts(pid);
        f.hasPaycheck = true;
        const netCents = amount(net);
        // A paycheck with no joint portion entered, from someone who transfers a contribution,
        // is read as "no direct deposit to joint": their joint money is the contribution stream.
        const jointPer = joint !== null ? joint : (hasContributionStream(plan, pid) ? 0 : null);
        const jointCents = amount(jointPer);
        if (netCents === null) f.netKnown = false; else f.netCents += netCents;
        if (jointCents !== null) f.jointCents += jointCents;
        if (netCents === null || jointCents === null) f.allocationKnown = false;
        else {
          f.allocationCents += netCents - jointCents;
          if (jointCents > netCents) acc.warnings.push(label + ': the joint portion (' + money(jointCents) + ') is more than the take-home pay (' + money(netCents) + '). Check the paycheck amounts.');
        }
      }
      if (isPerson && kind === 'contribution') {
        const f = personFacts(pid);
        f.hasContribution = true;
        const cents = amount(joint !== null ? joint : net);
        if (cents === null) { f.contributionsKnown = false; f.unknownContributionIds.push(stream.id); } else f.contributionsCents += cents;
      }

      if (scope === 'joint') {
        let per;
        if (kind === 'paycheck') {
          if (joint === null && hasContributionStream(plan, pid)) {
            notCounted.push({ id: stream.id, label, personId: pid ?? null, cents: null, reason: 'No direct deposit to joint is entered; ' + possessive(pname) + ' joint money is counted through their contribution transfers.' });
            acc.assumptions.push(label + ': no joint portion entered, so ' + possessive(pname) + ' money reaching joint is counted through their contribution transfers only.');
            continue;
          }
          per = joint;
        } else if (kind === 'contribution') {
          per = joint !== null ? joint : net; // the whole transfer lands in joint
        } else {
          per = joint !== null ? joint : (!isPerson ? net : null);
        }
        const cents = amount(per);
        if (cents === null) {
          incomeUnknown = true;
          acc.missing.push({ id: stream.id, label: label + ': amount reaching the joint account is not entered', area: 'income' });
        }
        lines.push(Object.assign(base, { perPaycheckCents: per, cents }));
        continue;
      }

      // household scope
      if (kind === 'contribution') {
        notCounted.push({ id: stream.id, label, personId: pid ?? null, cents: amount(joint !== null ? joint : net), reason: 'Transfer from ' + possessive(pname) + ' personal account into joint: not extra household income (their pay is the income).' });
        continue;
      }
      const per = kind === 'paycheck' ? net : (net !== null ? net : joint);
      const cents = amount(per);
      if (cents === null) {
        incomeUnknown = true;
        acc.missing.push({ id: stream.id, label: label + ': take-home pay per paycheck is not entered', area: 'income' });
      }
      lines.push(Object.assign(base, { perPaycheckCents: per, cents }));
    }

    // Household: a person who only shows up through contributions has unknown take-home pay.
    if (scope === 'household') {
      for (const [pid, f] of persons) {
        if (f.hasContribution && !f.hasPaycheck) {
          incomeUnknown = true;
          acc.missing.push({ id: 'pay:' + pid, label: possessive(nameOf(plan, pid)) + ' take-home pay is not entered (only the transfer into joint is known)', area: 'income' });
        }
      }
    }

    const knownCents = E.money.sum(lines.map(l => l.cents));
    const totalCents = incomeUnknown ? null : knownCents;
    let lowerBoundCents = totalCents;
    if (totalCents === null) {
      lowerBoundCents = knownCents;
      if (scope === 'household') {
        // Someone whose pay is unknown earns at least what they transfer into joint
        // (assuming the transfers come from that pay). Known pay already counts toward it.
        for (const f of persons.values()) {
          const payUnknown = !f.netKnown || (f.hasContribution && !f.hasPaycheck);
          if (payUnknown && f.contributionsKnown) lowerBoundCents += Math.max(0, f.contributionsCents - f.netCents);
        }
      }
    }

    for (const l of lines) if (l.assumption && l.cents !== null && l.cents !== 0) acc.assumptions.push(l.assumption);
    return { section: { totalCents, knownCents, lowerBoundCents, lines, notCounted }, persons };
  }

  // ------------------------------------------------------------------ bills

  function buildBills(plan, scope, month, acc) {
    const lines = [];
    const excludedUnknownFunding = [];
    const excludedPersonal = [];
    const planned = [];
    for (const bill of arr(plan.bills)) {
      if (!bill || typeof bill !== 'object' || !activeIn(bill, month)) continue;
      const label = bill.label || bill.id || 'Bill';
      const cents = knownOrNull(bill.monthlyCents);
      const fundedFrom = ['joint', 'p1', 'p2'].includes(bill.fundedFrom) ? bill.fundedFrom : 'unknown';
      const isPlanned = bill.status === 'planned';
      const line = {
        id: bill.id, label, category: bill.category ?? null, type: bill.type ?? 'other', debtId: bill.debtId ?? null,
        cents, fundedFrom, status: bill.status || 'existing', planned: isPlanned,
        note: isPlanned ? 'Planned: not yet a bill' : (bill.status === 'estimate' ? 'Estimate' : '')
      };

      if (scope === 'joint' && fundedFrom === 'unknown') {
        excludedUnknownFunding.push({ id: bill.id, label, cents });
        acc.missing.push({ id: bill.id, label: label + ': who pays it is not confirmed (left out of joint totals)' + (cents === null ? '; amount also not entered' : ''), area: 'bills' });
        continue;
      }
      if (scope === 'joint' && fundedFrom !== 'joint') {
        excludedPersonal.push({ id: bill.id, label, cents, fundedFrom });
        continue;
      }
      if (cents === null) acc.missing.push({ id: bill.id, label: label + ': monthly amount not entered', area: 'bills' });
      if (isPlanned) planned.push(label);
      lines.push(line);
    }
    if (excludedPersonal.length) {
      acc.assumptions.push('Bills paid from personal accounts are not in the joint budget; they are paid from personal allocations: ' +
        excludedPersonal.map(b => b.label + ' (' + nameOf(plan, b.fundedFrom) + ')').join(', ') + '.');
    }
    if (planned.length) acc.assumptions.push('Includes planned bills that are not yet in effect: ' + planned.join(', ') + '.');
    return {
      totalCents: E.money.sum(lines.map(l => l.cents)),
      lines,
      excludedUnknownFunding,
      excludedPersonal
    };
  }

  // ------------------------------------------------------------------ targets & savings

  function buildTargets(plan, acc) {
    const lines = [];
    const targets = plan.targets && typeof plan.targets === 'object' ? plan.targets : {};
    for (const category of Object.keys(targets)) {
      const cents = knownOrNull(targets[category]);
      if (cents === null) acc.missing.push({ id: 'target:' + category, label: category + ' target not entered', area: 'targets' });
      lines.push({ category, cents });
    }
    return { targetsCents: E.money.sum(lines.map(l => l.cents)), lines };
  }

  function buildSavings(plan, month, acc) {
    const lines = [];
    for (const goal of arr(plan.savings)) {
      if (!goal || typeof goal !== 'object') continue;
      // A goal spent at its target month stops receiving contributions afterwards.
      if (month && goal.spendAtTarget && E.months.isMonth(goal.targetMonth) && month > goal.targetMonth) continue;
      const label = goal.label || goal.id || 'Savings goal';
      const cents = knownOrNull(goal.monthlyCents);
      if (cents === null) acc.missing.push({ id: goal.id, label: label + ': monthly contribution not entered', area: 'savings' });
      lines.push({ id: goal.id, label, cents, spendAtTarget: !!goal.spendAtTarget });
    }
    return { totalCents: E.money.sum(lines.map(l => l.cents)), lines };
  }

  // ------------------------------------------------------------------ personal allocations

  function buildPersonal(plan, scope, month, people, persons, acc) {
    const out = [];
    for (const person of people) {
      const pid = person.id;
      const name = nameOf(plan, pid);
      const f = persons.get(pid);
      // Personal bills: all of this person's bills active this month (in either scope).
      const own = arr(plan.bills).filter(b => b && b.fundedFrom === pid && activeIn(b, month));
      const billsCents = E.money.sum(own.map(b => knownOrNull(b.monthlyCents)));
      const unknownBills = own.filter(b => knownOrNull(b.monthlyCents) === null).map(b => b.label || b.id);
      const contributionsCents = f && f.contributionsKnown ? f.contributionsCents : null;
      // unknownBecause: 'contribution' when the personal share is known but the transfer to joint is not.
      const entry = { personId: pid, name, allocationCents: null, billsCents, contributionsCents, spendingCents: null, leftoverCents: null, shortfallCents: 0, source: 'missing', unknownBecause: null, note: '' };

      if (f && f.hasPaycheck && f.allocationKnown && contributionsCents !== null) {
        // The allocation pays personal bills and any transfer to joint first. What is left is
        // personal spending: the entered personal-spending estimate when there is one (the rest
        // then stays in that person's account and counts toward what remains), otherwise all of
        // it is assumed spent. Either way it is counted once, never also as left over.
        entry.allocationCents = f.allocationCents;
        entry.leftoverCents = f.allocationCents - billsCents - contributionsCents;
        entry.shortfallCents = Math.max(0, -entry.leftoverCents);
        const estimate = arr(plan.personalSpending).find(p => p && p.personId === pid);
        const estimateCents = estimate ? knownOrNull(estimate.monthlyCents) : null;
        if (estimateCents !== null) {
          entry.spendingCents = estimateCents;
          entry.keptCents = Math.max(0, entry.leftoverCents) - Math.min(estimateCents, Math.max(0, entry.leftoverCents));
          entry.source = 'allocation_estimate';
          entry.note = 'Personal share of pay after personal bills' + (contributionsCents ? ' and transfers to joint' : '') + ': ' + money(Math.max(0, entry.leftoverCents)) +
            '. Using the personal-spending estimate of ' + money(estimateCents) + '; ' + (entry.keptCents > 0 ? money(entry.keptCents) + ' stays in ' + possessive(name) + ' account each month.' : 'nothing is left over.');
          if (scope === 'household' && estimateCents > Math.max(0, entry.leftoverCents)) {
            acc.warnings.push(possessive(name) + ' personal-spending estimate (' + money(estimateCents) + ') is more than the personal share left after bills (' + money(Math.max(0, entry.leftoverCents)) + '); the difference must come from other personal money.');
          }
        } else {
          entry.spendingCents = Math.max(0, entry.leftoverCents);
          entry.keptCents = 0;
          entry.source = 'allocation';
          entry.note = 'Personal share of pay after personal bills' + (contributionsCents ? ' and transfers to joint' : '') + '; all of it assumed spent.';
          if (scope === 'household' && entry.spendingCents > 0) {
            acc.assumptions.push('All of ' + possessive(name) + ' personal share left after bills (' + money(entry.spendingCents) + ') is assumed spent. Enter a personal-spending estimate to see how much stays in their account, and what paying off a personal loan frees up.');
          }
        }
        if (unknownBills.length) entry.note += ' Includes the unknown amount of ' + unknownBills.join(', ') + '.';
        if (entry.shortfallCents > 0) {
          acc.warnings.push(possessive(name) + ' personal bills' + (contributionsCents ? ' and transfers to joint' : '') + ' (' + money(billsCents + contributionsCents) +
            ') are more than the personal share of pay (' + money(f.allocationCents) + ') by ' + money(entry.shortfallCents) +
            '. Check whether other personal money covers this.');
        }
      } else if (f && f.hasPaycheck && f.allocationKnown && contributionsCents === null) {
        // The personal share of pay is known but not how much of it goes to joint, so what is left
        // for personal spending is unknown. Leaving it out, or swapping in a personal-spending
        // estimate, would change the result only because a number is unknown (the estimate caps
        // a known share; it does not stand in for an unknown one), so it stays unknown and blocks
        // the remaining amount.
        entry.allocationCents = f.allocationCents;
        entry.unknownBecause = 'contribution';
        entry.note = 'Personal share of pay is known, but the transfer to joint is not, so personal spending cannot be worked out.';
        if (scope === 'household') {
          acc.missing.push({ id: 'personal:' + pid, label: possessive(name) + " personal spending can't be worked out while their transfer to joint is unknown", area: 'targets', streamIds: f.unknownContributionIds.slice() });
        }
      } else {
        const estimate = arr(plan.personalSpending).find(p => p && p.personId === pid);
        if (estimate && knownOrNull(estimate.monthlyCents) !== null) {
          entry.spendingCents = estimate.monthlyCents;
          entry.source = 'estimate';
          entry.note = 'Personal share of pay unknown; using the entered personal-spending estimate.';
        } else if (f && (f.hasPaycheck || f.hasContribution)) {
          entry.note = 'Personal share of pay and personal spending are unknown.';
          if (scope === 'household') acc.missing.push({ id: 'personal:' + pid, label: possessive(name) + ' personal spending (beyond bills) is not entered', area: 'targets' });
        } else {
          entry.source = 'none';
          entry.note = 'No income entered for ' + name + '.';
        }
      }
      out.push(entry);
    }
    return out;
  }

  // ------------------------------------------------------------------ public API

  function normalizeOptions(plan, opts) {
    if (!plan || typeof plan !== 'object') fail('A plan is required.', 'plan');
    const o = opts || {};
    const scope = o.scope === undefined || o.scope === null ? 'joint' : o.scope;
    if (!SCOPES.includes(scope)) fail('Scope must be "joint" or "household".', 'scope');
    const month = o.month === undefined || o.month === null || o.month === '' ? null : o.month;
    if (month !== null && !E.months.isMonth(month)) fail('Month must be in YYYY-MM form.', 'month');
    const settingsTiming = plan.settings && plan.settings.incomeTiming;
    const timing = o.timing || (TIMINGS.includes(settingsTiming) ? settingsTiming : 'conservative');
    if (!TIMINGS.includes(timing)) fail('Timing must be "actual", "conservative" or "average".', 'timing');
    return { scope, month, timing };
  }

  /**
   * Monthly budget summary for one scope (see PlanSummary in the contract).
   * @param {object} plan Plan
   * @param {{scope?:'joint'|'household', month?:string, timing?:'actual'|'conservative'|'average'}} [opts]
   * @returns {object} PlanSummary, plus income.lowerBoundCents / income.notCounted,
   *   bills.excludedPersonal, personalSpendingCents, warnings, complete, and
   *   remainingUnknownReason (null | 'income' | 'personal_spending') with remainingUnknownNote
   *   (a sentence, or null) saying why remainingCents is null.
   */
  function monthly(plan, opts) {
    const { scope, month, timing: requested } = normalizeOptions(plan, opts);
    const acc = { missing: [], assumptions: [], warnings: [] };
    let timing = requested;
    if (timing === 'actual' && !month) {
      timing = 'conservative';
      acc.assumptions.push('Actual paydays need a specific month, so this shows a typical month instead.');
    }
    acc.assumptions.push(timing === 'actual' && month ? 'Income counts the actual paydays in ' + E.months.label(month, { long: true }) + '.' : TIMING_TEXT[timing]);
    if (scope === 'joint') {
      acc.assumptions.push('Joint accounts only: the joint portion of paychecks, contributions transferred in, joint-paid bills, spending targets and savings.');
    } else {
      acc.assumptions.push('Whole household: full take-home pay. Transfers between your own accounts are not counted as extra income; personal allocations are counted through the bills and spending they pay for.');
    }

    const people = peopleOf(plan);
    const { section: income, persons } = buildIncome(plan, scope, month, timing, people, acc);
    const bills = buildBills(plan, scope, month, acc);
    const spending = buildTargets(plan, acc);
    const savings = buildSavings(plan, month, acc);
    const personal = buildPersonal(plan, scope, month, people, persons, acc);

    const personalSpendingCents = scope === 'household' ? E.money.sum(personal.map(p => p.spendingCents)) : 0;

    // Household scope counts bills with an unconfirmed paying account in full, and counts a known
    // personal share of pay in full as personal spending. If such a bill is really paid from that
    // share, it sits inside both totals. Say so plainly rather than hide a possible double count.
    if (scope === 'household') {
      const unconfirmed = bills.lines.filter(l => l.fundedFrom === 'unknown');
      const fromPay = personal.filter(p => p.source === 'allocation' && p.spendingCents > 0);
      if (unconfirmed.length && fromPay.length) {
        const names = fromPay.map(p => possessive(p.name));
        acc.assumptions.push(unconfirmed.map(l => l.label + ' (' + money(l.cents) + ')').join(', ') + ': which account pays ' +
          (unconfirmed.length === 1 ? 'it' : 'them') + ' is not confirmed. ' + (unconfirmed.length === 1 ? 'It is counted as a household bill' : 'They are counted as household bills') +
          ', and ' + names.join(' and ') + ' personal share' + (names.length === 1 ? ' of pay is' : 's of pay are') +
          ' counted in full as personal spending; if paid from ' + (names.length === 1 ? 'that share' : 'one of those shares') +
          ', the amount is counted twice. Confirm who pays it.');
      }
    }
    const outflowCents = spending.targetsCents + bills.totalCents + personalSpendingCents;
    // Why the remaining amount is unknown: income first, then personal spending that cannot be
    // worked out (household scope only; personal spending is not part of the joint budget).
    const blocked = scope === 'household' ? personal.filter(p => p.unknownBecause === 'contribution') : [];
    const remainingUnknownReason = income.totalCents === null ? 'income' : (blocked.length ? 'personal_spending' : null);
    const remainingCents = remainingUnknownReason ? null : income.totalCents - outflowCents - savings.totalCents;
    let remainingUnknownNote = null;
    if (remainingUnknownReason === 'income') remainingUnknownNote = 'Money left over cannot be worked out because some income is unknown.';
    else if (remainingUnknownReason === 'personal_spending') {
      remainingUnknownNote = 'Money left over cannot be worked out because ' + blocked.map(p => possessive(p.name) + " personal spending can't be worked out").join(' and ') +
        ' while ' + (blocked.length === 1 ? 'their transfer' : 'their transfers') + ' to joint ' + (blocked.length === 1 ? 'is' : 'are') + ' unknown.';
    }

    if (!plan.balances || !isCents(plan.balances.jointCashCents)) acc.missing.push({ id: 'jointCash', label: 'Joint cash balance not entered', area: 'balances' });
    for (const debt of arr(plan.debts)) {
      if (debt && !isCents(debt.balanceCents)) acc.missing.push({ id: debt.id, label: (debt.label || debt.id) + ': balance not entered', area: 'debts' });
    }

    const budgetMissing = acc.missing.filter(m => m.area !== 'balances' && m.area !== 'debts');
    if (budgetMissing.length) acc.assumptions.push(budgetMissing.length + ' missing amount' + (budgetMissing.length === 1 ? ' is' : 's are') + ' left out of the totals (not treated as $0).');

    return {
      scope,
      timing,
      requestedTiming: requested,
      month,
      income,
      spending,
      bills,
      savings,
      personal,
      personalSpendingCents,
      outflowCents,
      remainingCents,
      remainingUnknownReason,
      remainingUnknownNote,
      missing: acc.missing,
      assumptions: [...new Set(acc.assumptions)],
      warnings: [...new Set(acc.warnings)],
      complete: budgetMissing.length === 0
    };
  }

  // ------------------------------------------------------------------ whatChanged

  function byId(list) {
    const map = new Map();
    for (const item of arr(list)) if (item && item.id !== undefined) map.set(item.id, item);
    return map;
  }

  function signed(c) { return E.money.format(c, { signed: true }); }

  /** Why a summary's remaining amount is unknown, as a clause ("some income is unknown"). */
  function unknownWhy(summary) {
    if (summary.remainingUnknownReason !== 'personal_spending') return 'some income is unknown';
    return summary.missing.filter(m => /^personal:/.test(m.id) && Array.isArray(m.streamIds)).map(m => m.label).join(' and ');
  }

  function diffList(before, after, noun, fields, describe) {
    const lines = [];
    const a = byId(before), b = byId(after);
    for (const [id, item] of b) {
      if (!a.has(id)) { lines.push('Added ' + noun + ': ' + describe(item) + '.'); continue; }
      const old = a.get(id);
      for (const [field, text, fmt] of fields) {
        const x = old[field], y = item[field];
        if (JSON.stringify(x ?? null) === JSON.stringify(y ?? null)) continue;
        let line = (item.label || id) + ': ' + text + ' ' + fmt(x) + ' → ' + fmt(y);
        if (isCents(x) && isCents(y)) line += ' (' + signed(y - x) + ')';
        lines.push(line + '.');
      }
    }
    for (const [id, item] of a) if (!b.has(id)) lines.push('Removed ' + noun + ': ' + (item.label || id) + '.');
    return lines;
  }

  const fmtMoney = v => (isCents(v) ? E.money.format(v) : 'not entered');
  const fmtText = v => (v === null || v === undefined || v === '' ? 'not set' : String(v));
  const fmtMonth = v => (E.months.isMonth(v) ? E.months.label(v) : 'not set');
  const fmtDate = v => (E.dates.isDate(v) ? E.dates.label(v) : 'not set');
  const fmtDays = v => (Array.isArray(v) && v.length ? v.join(', ') : 'not set');

  /**
   * Plain-language list of what changed between two plans and the effect on money left over.
   * @param {object} planBefore
   * @param {object} planAfter
   * @param {{scope?, month?, timing?}} [opts] same options as monthly(). With a month, the annual
   *   delta sums the 12 months starting there; otherwise it is 12 × the monthly change.
   * @returns {{remainingDeltaCents:number|null, annualDeltaCents:number|null, before, after, lines:string[]}}
   */
  function whatChanged(planBefore, planAfter, opts) {
    const o = Object.assign({}, opts || {});
    const before = monthly(planBefore, o);
    const after = monthly(planAfter, o);
    const remainingDeltaCents = before.remainingCents === null || after.remainingCents === null ? null : after.remainingCents - before.remainingCents;

    let annualDeltaCents = null;
    if (o.month && remainingDeltaCents !== null) {
      annualDeltaCents = 0;
      for (let i = 0; i < 12; i++) {
        const m = E.months.add(o.month, i);
        const x = monthly(planBefore, Object.assign({}, o, { month: m })).remainingCents;
        const y = monthly(planAfter, Object.assign({}, o, { month: m })).remainingCents;
        if (x === null || y === null) { annualDeltaCents = null; break; }
        annualDeltaCents += y - x;
      }
    } else if (remainingDeltaCents !== null) {
      annualDeltaCents = remainingDeltaCents * 12;
    }

    const lines = [];
    const pb = planBefore || {}, pa = planAfter || {};
    lines.push(...diffList(pb.incomes, pa.incomes, 'income',
      [['netPerPaycheckCents', 'take-home per paycheck', fmtMoney], ['jointPerPaycheckCents', 'joint portion per paycheck', fmtMoney],
        ['frequency', 'pay frequency', fmtText], ['startMonth', 'start month', fmtMonth], ['endMonth', 'end month', fmtMonth],
        // Payday settings move paychecks between months under actual timing, so they are listed too.
        ['anchorDate', 'payday used for timing', fmtDate], ['monthlyDay', 'day of the month paid', fmtText],
        ['semimonthlyDays', 'twice-a-month paydays', fmtDays],
        ['assumedPerMonthIfUnknown', 'paychecks a month assumed while the frequency is unknown', fmtText]],
      s => (s.label || s.id) + ' (' + fmtMoney(s.kind === 'contribution' ? s.jointPerPaycheckCents : s.netPerPaycheckCents) + ' per payment, ' + fmtText(s.frequency) + ')'));
    lines.push(...diffList(pb.bills, pa.bills, 'bill',
      [['monthlyCents', 'monthly amount', fmtMoney], ['fundedFrom', 'paid from', fmtText], ['status', 'status', fmtText],
        ['startMonth', 'start month', fmtMonth], ['endMonth', 'final payment month', fmtMonth]],
      b => (b.label || b.id) + ' (' + fmtMoney(b.monthlyCents) + ' a month, paid from ' + fmtText(b.fundedFrom) + ')'));
    const ta = (pb.targets && typeof pb.targets === 'object') ? pb.targets : {};
    const tb = (pa.targets && typeof pa.targets === 'object') ? pa.targets : {};
    for (const cat of Object.keys(tb)) {
      if (!(cat in ta)) lines.push('Added target: ' + cat + ' (' + fmtMoney(tb[cat]) + ' a month).');
      else if ((ta[cat] ?? null) !== (tb[cat] ?? null)) {
        lines.push(cat + ' target: ' + fmtMoney(ta[cat]) + ' → ' + fmtMoney(tb[cat]) + (isCents(ta[cat]) && isCents(tb[cat]) ? ' (' + signed(tb[cat] - ta[cat]) + ')' : '') + '.');
      }
    }
    for (const cat of Object.keys(ta)) if (!(cat in tb)) lines.push('Removed target: ' + cat + '.');
    lines.push(...diffList(pb.savings, pa.savings, 'savings goal',
      [['monthlyCents', 'monthly contribution', fmtMoney], ['targetCents', 'target', fmtMoney], ['targetMonth', 'target month', fmtMonth], ['savedCents', 'saved so far', fmtMoney]],
      g => (g.label || g.id) + ' (' + fmtMoney(g.monthlyCents) + ' a month)'));
    // Personal-spending estimates: compare every person in either plan, so a removed estimate is listed too.
    const psA = new Map(arr(pb.personalSpending).filter(p => p && p.personId).map(p => [p.personId, p.monthlyCents]));
    const psB = new Map(arr(pa.personalSpending).filter(p => p && p.personId).map(p => [p.personId, p.monthlyCents]));
    for (const pid of new Set([...psA.keys(), ...psB.keys()])) {
      const old = psA.has(pid) ? psA.get(pid) : null;
      const now = psB.has(pid) ? psB.get(pid) : null;
      if ((old ?? null) !== (now ?? null)) lines.push(possessive(nameOf(pa, pid)) + ' personal spending: ' + fmtMoney(old) + ' → ' + fmtMoney(now) + '.');
    }
    const balA = pb.balances ? pb.balances.jointCashCents : null, balB = pa.balances ? pa.balances.jointCashCents : null;
    if ((balA ?? null) !== (balB ?? null)) lines.push('Joint cash balance: ' + fmtMoney(balA) + ' → ' + fmtMoney(balB) + '.');

    const scopeText = after.scope === 'joint' ? 'joint accounts' : 'whole household';
    if (remainingDeltaCents === null) {
      lines.push('The effect on money left each month (' + scopeText + ') cannot be calculated because ' + unknownWhy(after.remainingCents === null ? after : before) + '.');
    } else {
      lines.push('Money left each month (' + scopeText + '): ' + E.money.format(before.remainingCents) + ' → ' + E.money.format(after.remainingCents) + ' (' + signed(remainingDeltaCents) + ').');
      if (annualDeltaCents !== null) lines.push((o.month ? 'Over the 12 months from ' + E.months.label(o.month) : 'Over a year (12 × the monthly change)') + ': ' + signed(annualDeltaCents) + '.');
    }
    return { remainingDeltaCents, annualDeltaCents, before, after, lines };
  }

  E.plan = { SCOPES, TIMINGS, TIMING_TEXT, monthly, whatChanged, activeIn, nameOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
