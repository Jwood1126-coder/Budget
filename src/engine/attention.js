'use strict';
/*
 * "Needs attention" list for the Overview. Each item names one decision or missing fact that
 * changes the numbers, explains why in plain language and links to where it can be fixed.
 * Severity: 'action' (data to correct), 'decision' (a household choice or fact to confirm),
 * 'info' (worth knowing; nothing is wrong).
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const ORDER = { action: 0, decision: 1, info: 2 };
  /** How often each known frequency happens, in words. */
  const FREQ_TEXT = { weekly: 'every week', biweekly: 'every two weeks', semimonthly: 'twice a month', monthly: 'once a month' };
  /** How many reimbursement and spike items are listed one by one before the rest are summarised. */
  const MAX_REIMBURSEMENTS = 3;
  const MAX_SPIKES = 2;

  function money(c) { return E.money.format(c, { decimals: c !== null && Math.abs(c) >= 100000 ? 0 : 2 }); }
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const isKnownFrequency = f => Object.prototype.hasOwnProperty.call(FREQ_TEXT, f);
  /** Occurrences a month assumed while a stream's frequency is unknown (same rule as BudgetEngine.schedule). */
  function assumedPerMonth(s) {
    const n = s.assumedPerMonthIfUnknown;
    return Number.isInteger(n) && n >= 0 && n <= 31 ? n : (E.schedule && E.schedule.DEFAULT_ASSUMED_PER_MONTH) || 2;
  }
  /** What the budget assumes for a stream whose schedule is not confirmed ("2 transfers a month", "biweekly pay (every two weeks)"). */
  function scheduleAssumption(s, noun) {
    if (isKnownFrequency(s.frequency)) return s.frequency + ' ' + (noun === 'paycheck' ? 'pay' : noun + 's') + ' (' + FREQ_TEXT[s.frequency] + ')';
    return plural(assumedPerMonth(s), noun) + ' a month';
  }

  function planItems(state) {
    const items = [];
    const plan = state.plan;
    const name = id => (plan.people || []).find(p => p.id === id)?.name || (id === 'joint' ? 'Joint' : 'Someone');

    for (const s of plan.incomes || []) {
      const who = name(s.personId);
      const unconfirmed = !isKnownFrequency(s.frequency) || s.frequencyStatus === 'unknown';
      if (s.kind === 'paycheck' && unconfirmed) {
        items.push({ id: 'freq-' + s.id, severity: 'decision', title: `Confirm ${who}'s pay frequency`, detail: 'Every two weeks means two months a year with a third paycheck; twice a month never does. Until confirmed, the budget assumes ' + scheduleAssumption(s, 'paycheck') + '.', route: '#/budget?section=income', cta: 'Set frequency' });
      }
      if (s.kind === 'paycheck' && s.netPerPaycheckCents === null) {
        items.push({ id: 'net-' + s.id, severity: state.ui?.scope === 'household' ? 'decision' : 'info', title: `${who}'s full take-home pay is unknown`, detail: 'The joint-account budget works without it, but whole-household income and leftover money stay incomplete.', route: '#/budget?section=income', cta: 'Add pay' });
      }
      if (s.kind === 'contribution') {
        // A contribution's amount is its joint portion (the whole transfer lands in joint).
        const per = E.money.isCents(s.jointPerPaycheckCents) ? s.jointPerPaycheckCents : (E.money.isCents(s.netPerPaycheckCents) ? s.netPerPaycheckCents : null);
        if (unconfirmed) {
          // The budget counts an assumed number of transfers until the schedule is set: a decision.
          const seen = s.frequencyStatus === 'observed' || s.status === 'observed';
          const lead = seen ? `${per === null ? 'Transfers' : money(per) + ' transfers'} were seen in the data, but the schedule is not confirmed.` : 'The transfer schedule is not confirmed.';
          items.push({ id: 'contrib-' + s.id, severity: 'decision', title: `Confirm ${who}'s transfer schedule`, detail: `${lead} Until it is, the budget assumes ${scheduleAssumption(s, 'transfer')}.`, route: '#/budget?section=income', cta: 'Set schedule' });
        } else if (s.frequencyStatus === 'observed') {
          items.push({ id: 'contrib-' + s.id, severity: 'info', title: `${who}'s contribution schedule is inferred from the data`, detail: `${per === null ? 'Transfers' : money(per) + ' transfers'} were observed ${FREQ_TEXT[s.frequency]}. Confirm it is the planned amount and timing.`, route: '#/budget?section=income', cta: 'Review' });
        }
      }
    }
    for (const b of plan.bills || []) {
      if (b.monthlyCents === null) items.push({ id: 'bill-amt-' + b.id, severity: 'action', title: `Enter an amount for ${b.label}`, detail: 'Blank amounts are left out of totals, so the budget looks better than it is.', route: '#/budget?section=bills', cta: 'Enter amount' });
      if (b.fundedFrom === 'unknown') items.push({ id: 'bill-fund-' + b.id, severity: 'decision', title: `Who pays ${b.label}?`, detail: `${b.monthlyCents === null ? 'It is' : money(b.monthlyCents) + '/month is'} left out of the joint-account budget until you choose the paying account (it is included in the whole-household view).`, route: '#/budget?section=bills', cta: 'Choose account' });
      if (b.status === 'planned' && b.monthlyCents !== null) items.push({ id: 'bill-planned-' + b.id, severity: 'info', title: `${b.label} is planned, not an existing bill`, detail: `${money(b.monthlyCents)}/month is a placeholder in the budget. Replace it with a real quote when you have one.`, route: '#/budget?section=bills', cta: 'Edit' });
    }
    for (const d of plan.debts || []) {
      if (d.promo && (d.promo.balanceCents === null || !d.promo.expiresMonth)) {
        const bill = (plan.bills || []).find(b => b.id === d.paymentBillId);
        items.push({ id: 'promo-' + d.id, severity: 'decision', title: `Verify the promotional financing on ${d.label}`, detail: `Enter the promotional balance and expiry month to check whether ${bill && bill.monthlyCents !== null ? 'the ' + money(bill.monthlyCents) + ' payment' : 'the payment'} clears it in time. No judgement is made until then.`, route: '#/budget?section=debts', cta: 'Add terms' });
      }
      if (d.termStatus === 'unknown' && d.repaymentPlan === null && (d.loanCount || 0) > 1) {
        items.push({ id: 'terms-' + d.id, severity: 'info', title: `${d.label}: repayment plan and remaining term unknown`, detail: 'No payoff date is estimated without them. Look them up on the loan servicer’s site when convenient.', route: '#/budget?section=debts', cta: 'View' });
      }
      if (d.escrowIncluded === null && (plan.bills || []).some(b => b.id === d.paymentBillId && b.type === 'housing')) {
        items.push({ id: 'escrow-' + d.id, severity: 'info', title: `Does the ${d.label} payment include taxes and insurance?`, detail: 'If it does not, property tax and home insurance need their own budget lines.', route: '#/budget?section=debts', cta: 'Answer' });
      }
    }
    if (plan.balances && plan.balances.jointCashCents === null) {
      items.push({ id: 'balance', severity: 'decision', title: 'Enter today’s joint cash balance', detail: 'Bank exports do not include balances. Until you add it, forecasts show the change in cash, not how much you will have.', route: '#/budget?section=savings', cta: 'Add balance' });
    }
    for (const g of plan.savings || []) {
      if (g.monthlyCents === null || (g.targetCents === null && g.spendAtTarget)) {
        items.push({ id: 'goal-' + g.id, severity: 'info', title: `${g.label}: ${g.monthlyCents === null ? 'monthly contribution' : 'target amount'} not set`, detail: 'Goals without amounts cannot be checked for funding.', route: '#/budget?section=savings', cta: 'Set goal' });
      }
    }
    return items;
  }

  function dataItems(dataset, txns, state) {
    const items = [];
    if (!dataset || !dataset.transactions || !dataset.transactions.length) return items;
    const q = E.review.queues(dataset, txns, state.ledgerEdits || {});
    const total = list => list.reduce((a, t) => a + Math.abs(t.amountCents || 0), 0);
    if (q.duplicates.length) items.push({ id: 'dupes', severity: 'action', title: `${q.duplicates.length} possible duplicate${q.duplicates.length === 1 ? '' : 's'} to check`, detail: 'Both copies are counted until you decide.', route: '#/review?queue=duplicates', cta: 'Review' });
    if (q.uncertain.length) {
      // Only spending rows are "counted in spending"; a deposit or transfer under review is not.
      const spend = q.uncertain.filter(t => t.kind === 'spend');
      const other = q.uncertain.filter(t => t.kind !== 'spend');
      const parts = [];
      if (spend.length) parts.push(`${money(total(spend))} is counted in spending but sits in an uncertain category.`);
      if (other.length) {
        parts.push(`${spend.length ? plural(other.length, 'other transaction') : plural(other.length, 'transaction')} (${money(total(other))}) ${other.length === 1 ? 'is' : 'are'} not spending; check that ${other.length === 1 ? 'it is' : 'they are'} counted as the right kind (income, transfer or reimbursement).`);
      }
      items.push({ id: 'uncertain', severity: 'action', title: `${q.uncertain.length} transaction${q.uncertain.length === 1 ? '' : 's'} need a category`, detail: parts.join(' '), route: '#/review?queue=uncertain', cta: 'Categorize' });
    }
    const unpaired = (q.transfers.unpaired || []).filter(t => !t.expected);
    if (unpaired.length) items.push({ id: 'transfers', severity: 'action', title: `${unpaired.length} transfer${unpaired.length === 1 ? '' : 's'} without a matching account`, detail: 'Say where the money came from or went so it is not mistaken for income or spending.', route: '#/review?queue=transfers', cta: 'Review' });
    const pendingR = (q.reimbursements || []).filter(r => r.status === 'pending');
    for (const r of pendingR.slice(0, MAX_REIMBURSEMENTS)) {
      const charge = r.charge || (r.chargeId ? txns.find(t => t.id === r.chargeId) : null);
      // A flagged deposit with no charge in the data has no chargeId: name it by the deposit.
      const title = charge
        ? `Is ${charge.merchant || charge.description || 'a charge'} (${money(r.cents)}) being reimbursed?`
        : `Is the ${money(r.cents)} deposit a reimbursement?`;
      const detail = charge
        ? (r.depositId ? 'A later deposit matches the amount exactly. It stays in spending until you confirm.' : 'Marked as a possible reimbursement. It stays in spending until you confirm.')
        : 'Marked as a possible reimbursement, but no matching charge is in the data. It is counted as income until you decide.';
      items.push({ id: 'reimb-' + (r.chargeId || r.depositId), severity: 'decision', title, detail, route: '#/review?queue=reimbursements', cta: 'Decide' });
    }
    if (pendingR.length > MAX_REIMBURSEMENTS) {
      const n = pendingR.length - MAX_REIMBURSEMENTS;
      items.push({ id: 'reimb-more', severity: 'decision', title: `${n} more possible reimbursement${n === 1 ? '' : 's'}`, detail: 'They stay in spending (and any matching deposit in income) until you decide.', route: '#/review?queue=reimbursements', cta: 'Review' });
    }
    const pendingB = (q.business || []).filter(b => (b.status || 'pending') === 'pending');
    if (pendingB.length) items.push({ id: 'business', severity: 'decision', title: `${pendingB.length} possible business purchase${pendingB.length === 1 ? '' : 's'}`, detail: `${money(pendingB.reduce((a, t) => a + Math.abs(t.amountCents), 0))} is counted as household spending until you mark which are business costs.`, route: '#/review?queue=business', cta: 'Review' });
    // Spikes already decided for planning are skipped before choosing which to list, so a decided
    // spike never hides an undecided one. Annual bills are not spikes (review.queues leaves them out).
    const openSpikes = (q.spikes || []).filter(s => !(s.ids || []).some(id => state.ledgerEdits?.[id]?.planningBaseline));
    for (const s of openSpikes.slice(0, MAX_SPIKES)) {
      items.push({ id: 'spike-' + s.month + s.category, severity: 'decision', title: `Unusual ${s.category} spending in ${E.months.label(s.month)}: ${money(s.totalCents)}`, detail: 'It stays in actual spending. Decide whether to leave it out of the planning baseline used for future targets.', route: '#/review?queue=spikes', cta: 'Decide' });
    }
    if (openSpikes.length > MAX_SPIKES) {
      const n = openSpikes.length - MAX_SPIKES;
      items.push({ id: 'spikes-more', severity: 'info', title: `${n} more month${n === 1 ? '' : 's'} with unusual spending`, detail: 'Older category-months well above their usual level. Each stays in actual spending until you decide about planning.', route: '#/review?queue=spikes', cta: 'Review' });
    }
    const gaps = q.coverageGaps || [];
    if (gaps.length) items.push({ id: 'coverage', severity: 'info', title: `${gaps.length} month${gaps.length === 1 ? '' : 's'} with incomplete account coverage`, detail: 'They are excluded from “usual” averages rather than treated as low-spending months.', route: '#/review?queue=coverage', cta: 'See months' });
    return items;
  }

  function forecastItems(state, ctx) {
    const items = [];
    if (!ctx || !ctx.project) return items;
    let proj;
    try { proj = ctx.project(state.scenarios[0].id, { months: 12 }); } catch { return items; }
    if (proj.summary.negativeMonths.length) {
      items.push({ id: 'negative', severity: 'decision', title: `More goes out than comes in during ${proj.summary.negativeMonths.length} of the next 12 months`, detail: 'See which months and why in Forecast. Savings or a lower target may cover them.', route: '#/forecast', cta: 'Open forecast' });
    }
    if (proj.summary.contributionShortfallMonths.length) {
      items.push({ id: 'contrib-short', severity: 'decision', title: 'Planned savings exceed what is left over in some months', detail: `${proj.summary.contributionShortfallMonths.length} month${proj.summary.contributionShortfallMonths.length === 1 ? '' : 's'} cannot fully fund the savings plan from that month's income.`, route: '#/forecast', cta: 'Open forecast' });
    }
    for (const g of proj.goals || []) {
      if (g.status === 'short') items.push({ id: 'goal-short-' + g.id, severity: 'decision', title: `${g.label} is projected to be short by ${money(g.shortfallCents)}`, detail: g.targetMonth ? `Target ${E.months.label(g.targetMonth)}.` : '', route: '#/budget?section=savings', cta: 'Adjust' });
    }
    for (const sc of state.scenarios.slice(1)) {
      let p;
      try { p = ctx.project(sc.id, { months: 36 }); } catch { continue; }
      // Event amounts not entered include income changes (e.g. pay during leave), not only costs.
      const missing = p.missing.filter(m => m.source === 'event');
      if (missing.length) items.push({ id: 'scn-missing-' + sc.id, severity: 'info', title: `“${sc.name}” has ${missing.length} amount${missing.length === 1 ? '' : 's'} not entered`, detail: missing.slice(0, 3).map(m => m.label).join('; ') + (missing.length > 3 ? '…' : ''), route: '#/forecast?scenario=' + encodeURIComponent(sc.id), cta: 'Fill in' });
    }
    return items;
  }

  function list({ dataset, txns, state, ctx } = {}) {
    const items = [];
    const safe = (fn) => { try { items.push(...fn()); } catch (err) { items.push({ id: 'err-' + items.length, severity: 'info', title: 'Part of this list could not be calculated', detail: String(err && err.message || err), route: null }); } };
    safe(() => dataItems(dataset, txns || [], state));
    safe(() => planItems(state));
    safe(() => forecastItems(state, ctx));
    const dismissed = state.ui?.dismissed || {};
    return items.filter(i => !dismissed['attention:' + i.id]).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  }

  E.attention = { list };
})(typeof globalThis !== 'undefined' ? globalThis : this);
