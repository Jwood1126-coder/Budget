'use strict';
/*
 * Scenario projection and side-by-side comparison (docs/ARCHITECTURE.md §6 and §8,
 * BudgetEngine.forecast).
 *
 * Each month is computed by applying the scenario's dated events to a fresh copy of the plan
 * and running BudgetEngine.plan.monthly on it, so the forecast follows exactly the same scope
 * and counting rules as the Budget view. On top of that the forecast adds:
 *
 *   - events: one-time and recurring amounts, income/bill/target changes, scenario-only goals;
 *   - savings goals, tracked month by month. Contributions EARMARK cash inside your own
 *     accounts, so they are never subtracted from cash. Cash leaves only when money is spent:
 *     a spend-at-target goal spends its target once in its target month, and a one-time event
 *     linked to a goal (goalId) draws that goal down (the outflow is still counted once);
 *   - cumulative change in cash and, only when the joint cash balance is known, a balance;
 *   - an optional hypothetical return (only a positive rate, only on a positive known balance)
 *     and optional growth rates (default 0).
 *
 * Unknown is not zero: unknown amounts are listed in `missing` and left out of totals; when
 * income is unknown, net and cumulative values are null.
 * project() never mutates its inputs.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const MAX_MONTHS = 120;
  const SCOPES = ['joint', 'household'];
  const TIMINGS = ['actual', 'conservative', 'average'];
  const EVENT_TYPES = ['one_time', 'recurring', 'income_change', 'bill_change', 'target_change', 'goal'];
  /** Bill types whose amount can drift with prices. Loan and housing payments are fixed by contract. */
  const GROWING_BILL_TYPES = ['utility', 'insurance', 'subscription', 'other'];
  /** Plan-summary missing areas that are budget amounts (balances/debts are handled separately). */
  const BUDGET_AREAS = ['income', 'bills', 'targets'];

  function fail(message, field) { throw new E.ValidationError(message, field); }
  const arr = v => (Array.isArray(v) ? v : []);
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isCents = v => E.money.isCents(v);
  const isMonth = v => E.months.isMonth(v);
  const money = c => E.money.format(c);
  const label = m => E.months.label(m);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  /** Amount input for events/goals: valid non-negative cents, otherwise null (unknown/invalid). */
  function amountOf(v) { return isCents(v) && v >= 0 ? v : null; }

  /** Rate assumption: absent -> 0; otherwise a finite number above -100. */
  function rateOf(v, field) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= -100 || v > 100) fail(field + ' must be a percentage between -100 and 100.', field);
    return v;
  }

  /** Inclusive month window test; endMonth null = open-ended. */
  function inWindow(month, start, end) {
    if (!isMonth(start) || month < start) return false;
    return !isMonth(end) || month <= end;
  }

  /** Annual growth applied in steps every 12 months from the projection start. */
  function growthFactor(pct, index) {
    if (!pct) return 1;
    return Math.pow(1 + pct / 100, Math.floor(index / 12));
  }

  function grow(cents, factor) {
    return factor !== 1 && isCents(cents) ? Math.round(cents * factor) : cents;
  }

  // ------------------------------------------------------------------ input checks

  function normalizeOptions(plan, scenario, opts) {
    if (!isObj(plan)) fail('A plan is required.', 'plan');
    if (scenario !== null && scenario !== undefined && !isObj(scenario)) fail('Scenario must be an object.', 'scenario');
    const o = opts || {};
    if (!isMonth(o.startMonth)) fail('startMonth must be a month in YYYY-MM form.', 'startMonth');
    if (!Number.isInteger(o.months) || o.months < 1 || o.months > MAX_MONTHS) fail('months must be a whole number from 1 to ' + MAX_MONTHS + '.', 'months');
    const scope = o.scope === undefined || o.scope === null ? 'joint' : o.scope;
    if (!SCOPES.includes(scope)) fail('scope must be "joint" or "household".', 'scope');
    if (o.now !== undefined && o.now !== null && !isMonth(o.now)) fail('now must be a month in YYYY-MM form.', 'now');

    const sc = scenario || { id: 'baseline', name: 'Current plan', events: [], assumptions: {} };
    const a = isObj(sc.assumptions) ? sc.assumptions : {};
    const planTiming = plan.settings && TIMINGS.includes(plan.settings.incomeTiming) ? plan.settings.incomeTiming : 'conservative';
    const timing = a.incomeTiming === undefined || a.incomeTiming === null ? planTiming : a.incomeTiming;
    if (!TIMINGS.includes(timing)) fail('incomeTiming must be "actual", "average" or "conservative".', 'incomeTiming');
    const returnPct = rateOf(a.annualReturnPct, 'annualReturnPct');
    return {
      sc,
      scope,
      startMonth: o.startMonth,
      months: o.months,
      contributionStart: o.now && o.now > o.startMonth ? o.now : o.startMonth,
      timing,
      returnPct: returnPct > 0 ? returnPct : 0, // only a positive return applies
      costGrowth: rateOf(a.costGrowthPct, 'costGrowthPct'),
      incomeGrowth: rateOf(a.incomeGrowthPct, 'incomeGrowthPct')
    };
  }

  /**
   * Sort the scenario's events into usable ones and ignored ones (with a reason). Date problems
   * are recorded as missing inputs because the event cannot be placed in time.
   */
  function prepareEvents(plan, sc, missing, notes) {
    const streams = new Set(arr(plan.incomes).map(s => s && s.id));
    const bills = new Set(arr(plan.bills).map(b => b && b.id));
    const ok = [];
    for (const ev of arr(sc.events)) {
      if (!isObj(ev)) continue;
      const name = ev.label || ev.id || 'An event';
      if (!EVENT_TYPES.includes(ev.type)) { notes.push('Event "' + name + '" has an unknown type and was ignored.'); continue; }
      if (ev.type === 'goal') {
        if (!isObj(ev.goal)) { notes.push('Goal event "' + name + '" has no goal details and was ignored.'); continue; }
        ok.push(ev);
        continue;
      }
      if (ev.type === 'one_time') {
        if (!isMonth(ev.month)) { missing.add({ label: name + ': month not set (left out)', source: 'event', id: ev.id }); continue; }
        ok.push(ev);
        continue;
      }
      if (!isMonth(ev.startMonth)) { missing.add({ label: name + ': start month not set (left out)', source: 'event', id: ev.id }); continue; }
      if (ev.endMonth !== null && ev.endMonth !== undefined && !isMonth(ev.endMonth)) { notes.push('Event "' + name + '" has an invalid end month and was ignored.'); continue; }
      if (isMonth(ev.endMonth) && ev.endMonth < ev.startMonth) { notes.push('Event "' + name + '" ends before it starts and has no effect.'); continue; }
      if (ev.type === 'income_change' && !streams.has(ev.streamId)) { notes.push('Income change "' + name + '" refers to an income that is not in the plan and was ignored.'); continue; }
      if (ev.type === 'bill_change' && !bills.has(ev.billId)) { notes.push('Bill change "' + name + '" refers to a bill that is not in the plan and was ignored.'); continue; }
      if (ev.type === 'target_change' && (typeof ev.category !== 'string' || !ev.category)) { notes.push('Target change "' + name + '" has no category and was ignored.'); continue; }
      ok.push(ev);
    }
    return ok;
  }

  /** Missing-item collector that keeps one entry per (source, id, label). */
  function missingSet() {
    const list = [];
    const seen = new Set();
    return {
      list,
      add(item) {
        const key = item.source + '|' + item.id + '|' + item.label;
        if (seen.has(key)) return;
        seen.add(key);
        list.push(item);
      }
    };
  }

  // ------------------------------------------------------------------ effective plan for a month

  /**
   * A shallow copy of the plan with this month's income/bill/target changes and growth applied.
   * Returns which plan values an event turned into "unknown", so missing items can be credited
   * to the event that caused them.
   */
  function effectivePlan(plan, events, month, index, cfg) {
    const incomeF = growthFactor(cfg.incomeGrowth, index);
    const costF = growthFactor(cfg.costGrowth, index);
    const nulledBy = new Map(); // plan id (stream/bill/'target:<cat>') -> event

    const active = type => events.filter(ev => ev.type === type && inWindow(month, ev.startMonth, ev.endMonth));
    const incomeChanges = active('income_change');
    const billChanges = active('bill_change');
    const targetChanges = active('target_change');

    const incomes = arr(plan.incomes).map(s => {
      if (!isObj(s)) return s;
      let out = s;
      // Growth applies to pay; fixed contribution transfers are left as entered.
      if (incomeF !== 1 && s.kind === 'paycheck') {
        out = Object.assign({}, s, { netPerPaycheckCents: grow(s.netPerPaycheckCents, incomeF), jointPerPaycheckCents: grow(s.jointPerPaycheckCents, incomeF) });
      }
      for (const ev of incomeChanges) {
        if (ev.streamId !== s.id) continue;
        out = Object.assign({}, out);
        for (const field of ['netPerPaycheckCents', 'jointPerPaycheckCents']) {
          if (ev[field] === undefined) continue; // undefined = unchanged
          const v = ev[field] === null ? null : amountOf(ev[field]);
          out[field] = v;
          if (v === null && isCents(s[field])) nulledBy.set(s.id, ev);
        }
      }
      return out;
    });

    const bills = arr(plan.bills).map(b => {
      if (!isObj(b)) return b;
      let out = b;
      if (costF !== 1 && GROWING_BILL_TYPES.includes(b.type)) out = Object.assign({}, b, { monthlyCents: grow(b.monthlyCents, costF) });
      for (const ev of billChanges) {
        if (ev.billId !== b.id) continue;
        // The plan bill keeps its own start/end months, so a change never extends a bill past
        // its confirmed final payment. 0 stops the bill; null makes it unknown.
        const v = amountOf(ev.monthlyCents);
        out = Object.assign({}, out, { monthlyCents: v });
        if (v === null) nulledBy.set(b.id, ev);
      }
      return out;
    });

    const targets = {};
    const planTargets = isObj(plan.targets) ? plan.targets : {};
    for (const cat of Object.keys(planTargets)) targets[cat] = grow(planTargets[cat], costF);
    for (const ev of targetChanges) {
      const v = amountOf(ev.monthlyCents);
      targets[ev.category] = v;
      if (v === null) nulledBy.set('target:' + ev.category, ev);
    }

    const personalSpending = arr(plan.personalSpending).map(p => (isObj(p) && costF !== 1 ? Object.assign({}, p, { monthlyCents: grow(p.monthlyCents, costF) }) : p));

    // Goals are handled by the forecast itself, so the plan summary gets none.
    return { plan: Object.assign({}, plan, { incomes, bills, targets, personalSpending, savings: [] }), nulledBy };
  }

  // ------------------------------------------------------------------ goals

  function buildGoals(plan, events, cfg) {
    const byId = new Map();
    for (const g of arr(plan.savings)) if (isObj(g) && g.id !== undefined) byId.set(g.id, { goal: g, source: 'plan', sourceId: g.id });
    for (const ev of events) {
      if (ev.type !== 'goal') continue;
      const id = ev.goal.id !== undefined && ev.goal.id !== null ? ev.goal.id : ev.id;
      // A scenario goal with the same id replaces the plan goal in this scenario only.
      byId.set(id, { goal: Object.assign({}, ev.goal, { id }), source: 'event', sourceId: ev.id });
    }
    // One-time expenses paid from a goal (goalId). For a spend-at-target goal they are parts of
    // the goal's planned spending (its target): whatever they do not cover is still spent in the
    // target month, so the goal's cost leaves cash exactly once and never silently shrinks.
    const linkedEvents = events.filter(ev => ev.type === 'one_time' && ev.direction !== 'income' && ev.goalId);
    return [...byId.values()].map(({ goal, source, sourceId }) => {
      const start = amountOf(goal.savedCents);
      const target = amountOf(goal.targetCents);
      const mine = linkedEvents.filter(ev => ev.goalId === goal.id);
      const known = list => E.money.sum(list.map(ev => amountOf(ev.amountCents)));
      // Linked spending dated before the forecast already happened: it counts as paid.
      const paidBefore = known(mine.filter(ev => ev.month < cfg.startMonth));
      const g = {
        goal,
        id: goal.id,
        name: goal.label || goal.id || 'Savings goal',
        source,
        sourceId,
        target,
        monthly: amountOf(goal.monthlyCents),
        targetMonth: isMonth(goal.targetMonth) ? goal.targetMonth : null,
        spendAtTarget: !!goal.spendAtTarget,
        linked: mine.length > 0,
        linkedTotalCents: known(mine), // known linked amounts, any month
        linkedPaidCents: goal.spendAtTarget ? paidBefore : 0, // linked amounts paid so far
        startKnown: start !== null,
        startCents: start === null ? 0 : start, // unknown start is projected from $0 (status unknown_start)
        balance: start === null ? 0 : start,
        done: false,
        spentMonth: null,
        reachedMonth: null,
        atTargetCents: null,
        judgedMonth: null,
        contributedCents: 0,
        drawnCents: 0
      };
      // Linked spending before the forecast already paid the whole target: nothing left to do.
      if (g.spendAtTarget && target !== null && g.linkedPaidCents >= target) {
        g.done = true;
        g.atTargetCents = g.balance + g.linkedPaidCents;
      }
      return g;
    });
  }

  /**
   * Amount a goal should hold now. For a spend-at-target goal, linked spending already paid
   * reduces what is still needed, so contributions do not earmark money twice.
   */
  function goalNeed(g) {
    if (g.target === null) return Infinity;
    return Math.max(0, g.target - (g.spendAtTarget ? g.linkedPaidCents : 0));
  }

  /** Contribution for one goal in `month` (mutates only the forecast's own goal state). */
  function contribute(g, month, cfg, missing) {
    if (g.done || month < cfg.contributionStart) return 0;
    if (g.spendAtTarget && g.targetMonth && month > g.targetMonth) return 0;
    const room = Math.max(0, goalNeed(g) - g.balance);
    if (room === 0) return 0; // a known target is reached: stop contributing
    if (g.monthly === null) {
      missing.add({ label: g.name + ': monthly contribution not entered', source: g.source, id: g.sourceId });
      return 0;
    }
    const c = Math.min(g.monthly, room);
    g.balance += c;
    g.contributedCents += c;
    return c;
  }

  function goalSummary(g, cfg, lastMonth) {
    const out = {
      id: g.id, label: g.name, targetCents: g.target, targetMonth: g.targetMonth, spendAtTarget: g.spendAtTarget,
      projectedCents: null, atLeastCents: null, status: 'no_target', shortfallCents: null, reachedMonth: g.reachedMonth,
      spentMonth: g.spentMonth, contributedCents: g.contributedCents, drawnCents: g.drawnCents, startKnown: g.startKnown, note: ''
    };
    // Where is the goal judged? At its target month when it has one (or when linked spending paid
    // for it), else at the end of the horizon. Linked spending already paid counts toward the
    // target, because it was part of the goal's planned spending.
    const paid = g.spendAtTarget ? g.linkedPaidCents : 0;
    const paidNote = paid > 0 ? ' Includes ' + money(paid) + ' already paid by linked one-time events.' : '';
    let value, where;
    if (g.atTargetCents !== null) {
      value = g.atTargetCents;
      where = g.judgedMonth && g.judgedMonth !== g.targetMonth
        ? 'Judged in ' + label(g.judgedMonth) + ', when linked spending paid for it.'
        : g.judgedMonth ? 'Judged in ' + label(g.targetMonth) + (g.spendAtTarget ? ', before it is spent.' : '.')
          : 'Linked spending before the forecast already paid for it.';
    } else if (g.targetMonth && g.targetMonth < cfg.startMonth) {
      value = g.startCents;
      where = 'Target month ' + label(g.targetMonth) + ' is before the forecast starts; judged on the amount saved now.';
    } else if (g.targetMonth && g.targetMonth <= lastMonth) {
      value = g.balance + paid;
      where = 'Judged in ' + label(g.targetMonth) + (g.spendAtTarget ? ', before it is spent.' : '.');
    } else if (g.targetMonth) {
      // Beyond the horizon: extend the planned contributions to the target month.
      const more = g.monthly === null || g.done ? 0 : g.monthly * E.months.between(lastMonth, g.targetMonth);
      const have = g.balance + paid;
      value = g.target === null ? have + more : Math.min(g.target, have + more);
      if (g.target !== null && have >= g.target) value = have;
      where = 'Target month ' + label(g.targetMonth) + ' is after the forecast horizon; planned contributions are extended to it.';
    } else {
      value = g.balance + paid;
      where = 'Judged at the end of the forecast (' + label(lastMonth) + ').';
    }
    where += paidNote;
    out.atLeastCents = value;
    out.projectedCents = g.startKnown ? value : null;

    if (g.target === null) {
      out.status = 'no_target';
      out.note = 'No target amount entered. ' + where;
      return out;
    }
    if (value >= g.target) {
      out.status = 'funded';
      out.shortfallCents = 0;
      out.note = (g.startKnown ? '' : 'Already-saved amount unknown, but contributions alone reach the target. ') + where;
      return out;
    }
    if (g.monthly === null && !g.done) {
      out.status = 'missing_amount';
      out.note = 'Monthly contribution not entered. ' + where;
      return out;
    }
    if (!g.startKnown) {
      out.status = 'unknown_start';
      out.note = 'Amount already saved is unknown; contributions add ' + money(value) + ', at most ' + money(g.target - value) + ' short. ' + where;
      return out;
    }
    out.status = 'short';
    out.shortfallCents = g.target - value;
    out.note = 'About ' + money(out.shortfallCents) + ' short. ' + where;
    return out;
  }

  // ------------------------------------------------------------------ projection

  /**
   * Month-by-month projection of a scenario.
   * @param {object} plan Plan
   * @param {object|null} scenario Scenario (null = the plan with no events)
   * @param {{startMonth:string, months:number, scope?:'joint'|'household', now?:string}} opts
   *   `now` (optional 'YYYY-MM'): goal contributions start at max(startMonth, now).
   * @returns {object} Projection (see the contract), with extra row fields incomeKnownCents,
   *   outCents, goalDrawsCents and summary fields totalIncomeKnownCents, totalContributionsCents, unknownNetMonths.
   */
  function project(plan, scenario, opts) {
    const cfg = normalizeOptions(plan, scenario, opts);
    const P = E.plan; // loaded before this module; referenced lazily
    const sc = cfg.sc;
    const missing = missingSet();
    const notes = [];
    const events = prepareEvents(plan, sc, missing, notes);
    const goals = buildGoals(plan, events, cfg);
    const goalById = new Map(goals.map(g => [g.id, g]));
    const monthsList = E.months.range(cfg.startMonth, E.months.add(cfg.startMonth, cfg.months - 1));
    const lastMonth = monthsList[monthsList.length - 1];

    const startBalance = plan.balances && isCents(plan.balances.jointCashCents) ? plan.balances.jointCashCents : null;
    const streamAssumptions = new Set();
    const scopeNotes = new Set();
    const rows = [];
    let prevCumulative = 0;
    let prevBalance = startBalance;

    monthsList.forEach((month, index) => {
      const warnings = [];
      const { plan: eff, nulledBy } = effectivePlan(plan, events, month, index, cfg);
      const s = P.monthly(eff, { scope: cfg.scope, month, timing: cfg.timing });

      for (const m of s.missing) {
        if (!BUDGET_AREAS.includes(m.area)) continue;
        const ev = nulledBy.get(m.id);
        if (ev) missing.add({ label: (ev.label || ev.id) + ': ' + m.label, source: 'event', id: ev.id });
        else missing.add({ label: m.label, source: 'plan', id: m.id });
      }
      for (const l of s.income.lines) if (l.assumption && l.cents) streamAssumptions.add(l.assumption);
      for (const n of s.income.notCounted) if (cfg.scope === 'joint') scopeNotes.add(n.label + ': ' + n.reason.charAt(0).toLowerCase() + n.reason.slice(1));
      if (s.bills.excludedPersonal.length) scopeNotes.add('Bills paid from personal accounts are left out of the joint forecast: ' + s.bills.excludedPersonal.map(b => b.label).join(', ') + '.');
      const planned = s.bills.lines.filter(b => b.planned).map(b => b.label);
      if (planned.length) scopeNotes.add('Includes planned bills that are not yet in effect: ' + planned.join(', ') + '.');
      warnings.push(...s.warnings);

      // --- events active this month
      const eventLines = [];
      let eventIncome = 0, incomeLoss = 0, recurringSpend = 0, oneTimeSpend = 0, goalDraws = 0;
      for (const ev of events) {
        const name = ev.label || ev.id || 'Event';
        if (ev.type === 'recurring' && inWindow(month, ev.startMonth, ev.endMonth)) {
          const cents = amountOf(ev.monthlyCents);
          const direction = ['income', 'income_loss'].includes(ev.direction) ? ev.direction : 'expense';
          if (cents === null) missing.add({ label: name + ': monthly amount not entered', source: 'event', id: ev.id });
          else if (direction === 'income') eventIncome += cents;
          else if (direction === 'income_loss') incomeLoss += cents;
          else recurringSpend += cents;
          eventLines.push({ id: ev.id, label: name, type: 'recurring', direction, category: ev.category ?? null, cents, signedCents: cents === null ? null : (direction === 'income' ? cents : -cents), goalId: null, fromGoalCents: 0 });
        }
      }
      // Goal contributions happen before any spending in the month.
      let contributions = 0;
      for (const g of goals) contributions += contribute(g, month, cfg, missing);
      for (const g of goals) {
        if (g.target !== null && g.reachedMonth === null && !g.done && g.balance >= goalNeed(g)) g.reachedMonth = month;
        // Judge the goal at its target month (before any spending), unless it was already spent.
        // Linked spending already paid was part of the goal's target, so it counts toward it.
        if (g.targetMonth === month && g.atTargetCents === null && !g.done) {
          g.atTargetCents = g.balance + (g.spendAtTarget ? g.linkedPaidCents : 0);
          g.judgedMonth = month;
        }
      }

      for (const ev of events) {
        if (ev.type !== 'one_time' || ev.month !== month) continue;
        const name = ev.label || ev.id || 'Event';
        const cents = amountOf(ev.amountCents);
        const direction = ev.direction === 'income' ? 'income' : 'expense';
        let fromGoal = 0;
        if (cents === null) {
          missing.add({ label: name + ': amount not entered', source: 'event', id: ev.id });
        } else if (direction === 'income') {
          eventIncome += cents;
        } else {
          oneTimeSpend += cents; // counted once, whether or not a goal pays for it
          if (ev.goalId) {
            const g = goalById.get(ev.goalId);
            if (!g) warnings.push(name + ': linked savings goal not found; counted as a regular expense.');
            else {
              fromGoal = Math.min(cents, Math.max(0, g.balance));
              if (g.spendAtTarget && !g.done) {
                // Part of the goal's planned spending. Once linked spending covers the whole known
                // target, the goal is spent (judged now, before this draw) and stops contributing.
                if (g.target !== null && g.linkedPaidCents + cents >= g.target) {
                  if (g.atTargetCents === null) { g.atTargetCents = g.balance + g.linkedPaidCents; g.judgedMonth = month; }
                  g.done = true;
                  g.spentMonth = month;
                }
                g.linkedPaidCents += cents;
              } else if (g.spendAtTarget) {
                g.spentMonth = month; // paid after the target month (e.g. the trip moved later)
              }
              g.balance -= fromGoal;
              g.drawnCents += fromGoal;
              goalDraws += fromGoal;
              if (fromGoal < cents) warnings.push(name + ': ' + money(cents - fromGoal) + ' more than the ' + g.name + ' goal holds' + (g.startKnown ? '' : ' (from contributions in this forecast; the amount already saved is unknown)') + '; the rest comes from other cash.');
            }
          }
        }
        eventLines.push({ id: ev.id, label: name, type: 'one_time', direction, category: ev.category ?? null, cents, signedCents: cents === null ? null : (direction === 'income' ? cents : -cents), goalId: ev.goalId || null, fromGoalCents: fromGoal });
      }

      // Spend-at-target goals: the target amount leaves cash once, in the target month. One-time
      // events linked to the goal are parts of that spending, so only the part of the target
      // they do not cover is spent here (nothing when they cover all of it, in any month).
      for (const g of goals) {
        if (!g.spendAtTarget || g.targetMonth !== month || g.done) continue;
        g.done = true;
        if (g.target === null) {
          if (g.linked) {
            // Linked events are counted as entered, but without a target the rest of the goal's
            // cost is unknown: report it instead of treating it as $0.
            missing.add({ label: g.name + ': target amount not entered (only its linked one-time events are counted)', source: g.source, id: g.sourceId });
            continue;
          }
          g.spentMonth = month;
          missing.add({ label: g.name + ': target amount not entered (its spending in ' + label(month) + ' is left out)', source: g.source, id: g.sourceId });
          eventLines.push({ id: 'goal:' + g.id, label: 'Spend ' + g.name, type: 'goal_spend', direction: 'expense', category: null, cents: null, signedCents: null, goalId: g.id, fromGoalCents: 0 });
          continue;
        }
        const rest = Math.max(0, g.target - g.linkedTotalCents);
        if (rest === 0) continue; // linked events pay the whole target (any later ones draw then)
        g.spentMonth = month;
        const fromGoal = Math.min(rest, Math.max(0, g.balance));
        oneTimeSpend += rest;
        g.balance -= fromGoal;
        g.drawnCents += fromGoal;
        goalDraws += fromGoal;
        if (fromGoal < rest) {
          warnings.push(g.name + ': ' + (g.startKnown ? '' : 'may be ') + money(rest - fromGoal) + ' short when spent in ' + label(month) + '; the difference comes from other cash.');
        }
        const what = g.linkedTotalCents > 0 ? 'Spend ' + g.name + ' (the part not paid by linked events)' : 'Spend ' + g.name;
        eventLines.push({ id: 'goal:' + g.id, label: what, type: 'goal_spend', direction: 'expense', category: null, cents: rest, signedCents: -rest, goalId: g.id, fromGoalCents: fromGoal });
      }

      // --- totals for the month
      const planIncome = s.income.totalCents;
      const incomeCents = planIncome === null ? null : planIncome + eventIncome - incomeLoss;
      const incomeKnownCents = s.income.knownCents + eventIncome - incomeLoss;
      const spendingCents = s.spending.targetsCents + s.personalSpendingCents + recurringSpend;
      const billsCents = s.bills.totalCents;
      const oneTimeCents = oneTimeSpend;
      const outCents = spendingCents + billsCents + oneTimeCents;
      const netCents = incomeCents === null ? null : incomeCents - outCents;
      // Cash not set aside this month: contributions earmark cash; money drawn from goals was
      // set aside earlier, so it does not reduce what is unassigned now.
      const unassignedCents = netCents === null ? null : netCents - contributions + goalDraws;

      let returnCents = 0;
      if (cfg.returnPct > 0) {
        returnCents = prevBalance === null ? null : (prevBalance > 0 ? E.money.divide(prevBalance * cfg.returnPct, 1200) : 0);
      }
      const cumulativeCents = prevCumulative === null || netCents === null ? null : prevCumulative + netCents + (returnCents || 0);
      const balanceCents = startBalance === null || cumulativeCents === null ? null : startBalance + cumulativeCents;
      prevCumulative = cumulativeCents;
      prevBalance = balanceCents;

      const goalBalances = {};
      for (const g of goals) goalBalances[g.id] = g.startKnown ? g.balance : null;

      rows.push({
        month,
        incomeCents,
        incomeKnownCents,
        incomeLowerBoundCents: s.income.lowerBoundCents === null ? null : s.income.lowerBoundCents + eventIncome - incomeLoss,
        incomeLines: s.income.lines.map(l => ({ id: l.id, label: l.label, personId: l.personId, count: l.count, cents: l.cents, perPaycheckCents: l.perPaycheckCents, basis: l.basis, assumption: l.assumption })),
        spendingCents,
        billsCents,
        oneTimeCents,
        outCents,
        eventLines,
        netCents,
        contributionsCents: contributions,
        goalDrawsCents: goalDraws,
        unassignedCents,
        cumulativeCents,
        balanceCents,
        returnCents,
        goals: goalBalances,
        warnings: [...new Set(warnings)]
      });
    });

    const goalResults = goals.map(g => goalSummary(g, cfg, lastMonth));
    const summary = summarize(rows);
    const missingList = missing.list;
    const assumptions = buildAssumptions(plan, cfg, events, goals, startBalance, missingList, streamAssumptions, scopeNotes, notes, monthsList);
    return {
      scenarioId: sc.id ?? null,
      scenarioName: sc.name ?? null,
      scope: cfg.scope,
      timing: cfg.timing,
      startMonth: cfg.startMonth,
      months: cfg.months,
      endMonth: lastMonth,
      startBalanceCents: startBalance,
      rows,
      summary,
      goals: goalResults,
      missing: missingList,
      assumptions,
      complete: missingList.length === 0 && rows.every(r => r.incomeCents !== null)
    };
  }

  function summarize(rows) {
    const known = rows.filter(r => r.cumulativeCents !== null);
    let lowest = { month: null, cumulativeCents: null, balanceCents: null };
    for (const r of known) {
      if (lowest.month === null || r.cumulativeCents < lowest.cumulativeCents) lowest = { month: r.month, cumulativeCents: r.cumulativeCents, balanceCents: r.balanceCents };
    }
    const last = rows[rows.length - 1];
    const firstNeg = rows.find(r => r.balanceCents !== null && r.balanceCents < 0);
    return {
      totalIncomeCents: E.money.sumKnown(rows.map(r => r.incomeCents)),
      totalIncomeKnownCents: E.money.sum(rows.map(r => r.incomeKnownCents)),
      totalOutCents: E.money.sum(rows.map(r => r.outCents)),
      totalContributionsCents: E.money.sum(rows.map(r => r.contributionsCents)),
      totalReturnCents: E.money.sum(rows.map(r => r.returnCents)),
      endCumulativeCents: last.cumulativeCents,
      endBalanceCents: last.balanceCents,
      lowest,
      negativeMonths: rows.filter(r => r.netCents !== null && r.netCents < 0).map(r => r.month),
      firstNegativeBalanceMonth: firstNeg ? firstNeg.month : null,
      contributionShortfallMonths: rows.filter(r => r.unassignedCents !== null && r.unassignedCents < 0).map(r => r.month),
      unknownNetMonths: rows.filter(r => r.netCents === null).map(r => r.month)
    };
  }

  function buildAssumptions(plan, cfg, events, goals, startBalance, missingList, streamAssumptions, scopeNotes, notes, monthsList) {
    const out = [];
    out.push(cfg.timing === 'actual'
      ? 'Income counts the actual paydays in each month (biweekly pay gives two months a year a third paycheck).'
      : E.plan.TIMING_TEXT[cfg.timing]);
    out.push(...streamAssumptions);
    out.push(cfg.scope === 'joint'
      ? 'Joint accounts only: deposits into joint (the joint portion of paychecks and contributions transferred in), joint-paid bills and spending targets.'
      : 'Whole household: full take-home pay; transfers between your own accounts are not counted as extra income; each person\'s personal share of pay is counted through the bills and spending it pays for.');
    out.push(...scopeNotes);

    out.push('Bills continue at their current amounts every month unless a final payment month is set.');
    const ending = arr(plan.bills).filter(b => isObj(b) && isMonth(b.endMonth) && b.endMonth >= cfg.startMonth && b.endMonth < monthsList[monthsList.length - 1]);
    if (ending.length) out.push('Bills that end during the forecast: ' + ending.map(b => (b.label || b.id) + ' (final payment ' + label(b.endMonth) + ')').join(', ') + '.');

    if (!cfg.costGrowth && !cfg.incomeGrowth) out.push('No cost or income growth is assumed (0% a year).');
    else {
      out.push('Costs grow ' + cfg.costGrowth + '% a year (spending targets, personal spending and non-loan bills; applied every 12 months from the start).');
      out.push('Pay grows ' + cfg.incomeGrowth + '% a year (applied every 12 months from the start; contribution transfers stay as entered).');
      out.push('Amounts entered on scenario events are used as entered, without growth.');
    }

    if (cfg.returnPct > 0) {
      out.push(startBalance === null
        ? 'A hypothetical ' + cfg.returnPct + '% annual return is set, but no return is applied because the starting cash balance is unknown.'
        : 'Hypothetical ' + cfg.returnPct + '% annual return on a positive known cash balance, applied monthly. This is an illustration, not a promise.');
    } else {
      out.push('No interest or investment return is assumed (0%).');
    }

    if (startBalance === null) {
      out.push('Joint cash balance not entered: the forecast shows the change in cash only, not a balance.');
    } else {
      const asOf = plan.balances && E.dates.isDate(plan.balances.asOf) ? ' as of ' + E.dates.label(plan.balances.asOf) : '';
      out.push('Starting joint cash balance: ' + money(startBalance) + asOf + '.');
      if (cfg.scope === 'household') out.push('The balance starts from joint cash only; money already in personal accounts is not included.');
    }

    if (goals.length) {
      out.push('Savings contributions set money aside within your own accounts; they are not subtracted from cash a second time. A goal spent at its target month counts as spending once.');
      if (cfg.contributionStart > cfg.startMonth) out.push('Goal contributions start in ' + label(cfg.contributionStart) + '.');
      for (const g of goals) {
        if (!g.startKnown) out.push(g.name + ': amount already saved is unknown; contributions are projected from $0.');
        if (g.linked && g.spendAtTarget) {
          if (g.target === null) out.push(g.name + ': no target amount, so only its linked one-time events are counted as its spending.');
          else if (g.linkedTotalCents >= g.target) out.push(g.name + ': paid for by a linked one-time event, so the goal is not spent a second time.');
          else {
            out.push(g.name + ': linked one-time events pay ' + money(g.linkedTotalCents) + ' of the ' + money(g.target) + ' target; the remaining ' +
              money(g.target - g.linkedTotalCents) + ' is spent in ' + (g.targetMonth ? label(g.targetMonth) : 'its target month') + '.');
          }
        }
        if (g.source === 'event') out.push(g.name + ': goal added in this scenario only.');
      }
    }
    for (const ev of events) {
      if (ev.type !== 'one_time' || ev.direction === 'income' || !ev.goalId) continue;
      const g = goals.find(x => x.id === ev.goalId);
      if (g && !g.spendAtTarget) out.push((ev.label || ev.id) + ' draws on the ' + g.name + ' goal: the cost is counted once as spending and the goal balance goes down by what it holds.');
    }
    out.push(...notes);
    if (missingList.length) out.push(plural(missingList.length, 'missing amount') + ' ' + (missingList.length === 1 ? 'is' : 'are') + ' left out of the totals (not treated as $0).');
    return [...new Set(out)];
  }

  // ------------------------------------------------------------------ comparison

  /**
   * Project several scenarios over the same horizon and line up the key results.
   * @param {object} plan
   * @param {object[]} scenarios
   * @param {{startMonth, months, scope?, now?}} opts
   * @returns {{columns:Array<{scenarioId,name,projection}>, rows:Array<{key,label,kind,values:any[],deltas:Array<number|null>}>}}
   *   `deltas` compare each money value with the first column (null when either is unknown).
   */
  function compare(plan, scenarios, opts) {
    if (!Array.isArray(scenarios) || scenarios.length === 0) fail('At least one scenario is required.', 'scenarios');
    const columns = scenarios.map(sc => {
      const projection = project(plan, sc, opts);
      return { scenarioId: sc && sc.id !== undefined ? sc.id : null, name: (sc && (sc.name || sc.id)) || 'Scenario', projection };
    });
    const end = columns[0].projection.endMonth;
    const pick = fn => columns.map(c => fn(c.projection));
    const rows = [
      { key: 'totalIncome', label: 'Money coming in', kind: 'money', values: pick(p => p.summary.totalIncomeCents) },
      { key: 'totalOut', label: 'Money going out', kind: 'money', values: pick(p => p.summary.totalOutCents) },
      { key: 'savedForGoals', label: 'Set aside for savings goals', kind: 'money', values: pick(p => p.summary.totalContributionsCents) },
      { key: 'endCumulative', label: 'Change in cash by ' + label(end), kind: 'money', values: pick(p => p.summary.endCumulativeCents) },
      { key: 'endBalance', label: 'Cash at the end of ' + label(end), kind: 'money', values: pick(p => p.summary.endBalanceCents) },
      { key: 'lowest', label: 'Lowest point (change in cash)', kind: 'money', values: pick(p => p.summary.lowest.cumulativeCents) },
      { key: 'lowestMonth', label: 'Month of the lowest point', kind: 'month', values: pick(p => p.summary.lowest.month) },
      { key: 'negativeMonths', label: 'Months with more going out than coming in', kind: 'count', values: pick(p => p.summary.negativeMonths.length) },
      { key: 'firstNegativeBalance', label: 'First month cash falls below $0', kind: 'month', values: pick(p => p.summary.firstNegativeBalanceMonth) },
      { key: 'contributionShortfall', label: 'Months savings contributions are not covered', kind: 'count', values: pick(p => p.summary.contributionShortfallMonths.length) },
      { key: 'goalsFunded', label: 'Savings goals funded', kind: 'text', values: pick(p => (p.goals.length ? p.goals.filter(g => g.status === 'funded').length + ' of ' + p.goals.length : '—')) },
      { key: 'missing', label: 'Missing amounts (left out of totals)', kind: 'count', values: pick(p => p.missing.length) }
    ];
    for (const row of rows) {
      row.deltas = row.values.map((v, i) => {
        if (row.kind !== 'money' || i === 0) return null;
        const base = row.values[0];
        return base === null || v === null ? null : v - base;
      });
    }
    return { columns, rows };
  }

  E.forecast = { MAX_MONTHS, EVENT_TYPES, project, compare };
})(typeof globalThis !== 'undefined' ? globalThis : this);
