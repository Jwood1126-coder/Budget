'use strict';
/*
 * Debt facts, promotional-financing checks and clearly labelled illustrations
 * (docs/ARCHITECTURE.md §5 Debt and §8 BudgetEngine.debt).
 *
 * Ground rules:
 *   - Never invent a rate or a term. A payoff DATE is never produced from an unknown rate.
 *   - paymentsLowerBound is a floor: it holds only at 0% interest with a constant payment.
 *   - amortize / illustrativeRange need an explicit rate supplied by the caller and are
 *     labelled "illustrative"; if the payment does not cover a month's interest the balance
 *     never pays off (months: null, neverPaysOff: true).
 *   - promoCheck never calls a payment inadequate without the promotional balance and end month.
 *     Deferred-interest risk is mentioned when it applies or is unknown, never asserted.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  function fail(message, field) { throw new E.ValidationError(message, field); }
  const isCents = v => E.money.isCents(v);
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const money = c => E.money.format(c);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const pct = p => (Math.round(p * 100) / 100).toFixed(2).replace(/\.?0+$/, '') + '%';

  /** Optional cents input: null/undefined -> null; anything else must be integer cents. */
  function optCents(v, field) {
    if (v === null || v === undefined) return null;
    if (!isCents(v)) fail(field + ' must be integer cents or null.', field);
    return v;
  }

  /** Optional payment input: null/undefined -> null; must be integer cents of 0 or more. */
  function optPayment(v, field) {
    const c = optCents(v, field);
    if (c !== null && c < 0) fail(field + ' must be $0 or more.', field);
    return c;
  }

  /** Optional rate input: null/undefined -> null; must be a finite number >= 0. */
  function optRate(v, field) {
    if (v === null || v === undefined) return null;
    if (!isNum(v) || v < 0) fail(field + ' must be a percentage of 0 or more.', field);
    return v;
  }

  // ------------------------------------------------------------------ lower bound

  /**
   * Minimum number of payments to clear a balance: ceil(balance / payment).
   * A floor that holds only with 0% interest and a constant payment; any interest makes it longer.
   * @param {number|null} balanceCents
   * @param {number|null} paymentCents
   * @returns {{months:number|null, isLowerBound:true, note:string}}
   */
  function paymentsLowerBound(balanceCents, paymentCents) {
    const balance = optCents(balanceCents, 'balanceCents');
    const payment = optPayment(paymentCents, 'paymentCents');
    if (balance === null) return { months: null, isLowerBound: true, note: 'Balance not entered, so the number of payments left cannot be estimated.' };
    if (balance <= 0) return { months: 0, isLowerBound: true, note: 'No balance remaining.' };
    if (payment === null) return { months: null, isLowerBound: true, note: 'Monthly payment not entered, so the number of payments left cannot be estimated.' };
    if (payment === 0) return { months: null, isLowerBound: true, note: 'A $0.00 payment never pays the balance down, so no number of payments can be estimated.' };
    const months = Math.floor((balance + payment - 1) / payment); // integer ceil
    return {
      months,
      isLowerBound: true,
      note: 'At least ' + plural(months, 'more payment') + ' of ' + money(payment) + '. This is a floor: it assumes 0% interest and the same payment every month. ' +
        'With any interest it takes longer, and no payoff date is estimated without the confirmed rate and terms.'
    };
  }

  // ------------------------------------------------------------------ amortization (illustrative)

  /**
   * Month-by-month payoff ILLUSTRATION at a caller-supplied APR. Interest accrues monthly at
   * APR/12 on the outstanding balance, rounded to the cent; the last payment is just what is owed.
   * @param {{balanceCents:number|null, aprPct:number|null, paymentCents:number|null, maxMonths?:number}} input
   * @returns {{months:number|null, interestCents:number|null, totalPaidCents:number|null, finalPaymentCents:number|null,
   *   neverPaysOff:boolean, exceedsMaxMonths:boolean, illustrative:true, aprPct:number|null, missing:string[], note:string}}
   */
  function amortize(input) {
    const o = input || {};
    const balance = optCents(o.balanceCents, 'balanceCents');
    const payment = optPayment(o.paymentCents, 'paymentCents');
    const apr = optRate(o.aprPct, 'aprPct');
    const maxMonths = o.maxMonths === undefined || o.maxMonths === null ? 600 : o.maxMonths;
    if (!Number.isInteger(maxMonths) || maxMonths < 1 || maxMonths > 1200) fail('maxMonths must be a whole number from 1 to 1200.', 'maxMonths');

    const result = { months: null, interestCents: null, totalPaidCents: null, finalPaymentCents: null, neverPaysOff: false, exceedsMaxMonths: false, illustrative: true, aprPct: apr, missing: [], note: '' };
    if (balance === null) result.missing.push('balance');
    if (apr === null) result.missing.push('interest rate (an illustration needs an explicit rate)');
    if (payment === null) result.missing.push('monthly payment');
    if (result.missing.length) {
      result.note = 'Illustration not available: ' + result.missing.join(', ') + ' not entered. No payoff estimate is made without them.';
      return result;
    }
    const label = 'Illustration only, at an assumed ' + pct(apr) + ' APR with a fixed ' + money(payment) + ' payment and no new charges or fees.';
    if (balance <= 0) {
      Object.assign(result, { months: 0, interestCents: 0, totalPaidCents: 0, finalPaymentCents: 0, note: label + ' No balance remaining.' });
      return result;
    }

    const interestOn = b => E.money.divide(b * apr, 1200); // monthly interest, rounded to the cent
    const firstInterest = interestOn(balance);
    if (payment <= firstInterest) {
      result.neverPaysOff = true;
      result.note = label + ' The payment does not cover the monthly interest (' + money(firstInterest) + '), so the balance would never be paid off.';
      return result;
    }

    let b = balance, interest = 0, paid = 0;
    for (let m = 1; m <= maxMonths; m++) {
      const i = interestOn(b);
      interest += i;
      const owed = b + i;
      if (owed <= payment) {
        paid += owed;
        Object.assign(result, { months: m, interestCents: interest, totalPaidCents: paid, finalPaymentCents: owed });
        result.note = label + ' About ' + plural(m, 'month') + ' and ' + money(interest) + ' of interest. Not a payoff date: the real rate and terms may differ.';
        return result;
      }
      b = owed - payment;
      paid += payment;
    }
    result.exceedsMaxMonths = true;
    result.note = label + ' Not paid off within ' + plural(maxMonths, 'month') + '.';
    return result;
  }

  /**
   * Payoff illustration at the low and high end of a rate range (e.g. displayed APRs across
   * several loans). Fastest uses the lower rate, slowest the higher one.
   * @param {{balanceCents, paymentCents, aprMin, aprMax, maxMonths?}} input
   * @returns {{fastest:object, slowest:object, illustrative:true, missing:string[], note:string}}
   */
  function illustrativeRange(input) {
    const o = input || {};
    let lo = optRate(o.aprMin, 'aprMin');
    let hi = optRate(o.aprMax, 'aprMax');
    if (lo !== null && hi !== null && lo > hi) { const t = lo; lo = hi; hi = t; }
    const fastest = amortize({ balanceCents: o.balanceCents, paymentCents: o.paymentCents, aprPct: lo, maxMonths: o.maxMonths });
    const slowest = amortize({ balanceCents: o.balanceCents, paymentCents: o.paymentCents, aprPct: hi, maxMonths: o.maxMonths });
    const missing = [...new Set([...fastest.missing, ...slowest.missing])];
    let note;
    if (missing.length) {
      note = 'Illustration not available: ' + missing.join(', ') + ' not entered.';
    } else {
      const span = r => (r.neverPaysOff ? 'never (payment below the interest)' : r.months === null ? 'more than ' + plural(o.maxMonths || 600, 'month') : 'about ' + plural(r.months, 'month'));
      note = 'Illustration only: at ' + pct(lo) + ' APR payoff takes ' + span(fastest) + '; at ' + pct(hi) + ' APR, ' + span(slowest) +
        '. Treats the balance as one loan at a single rate; the real mix of rates, plans and terms is not confirmed, so this is not a payoff date.';
    }
    return { fastest, slowest, illustrative: true, missing, note };
  }

  // ------------------------------------------------------------------ promotional financing

  /**
   * Is the payment enough to clear a promotional balance before the promotion ends?
   * Months are counted from `fromMonth` through `expiresMonth` inclusive.
   * @param {{promoBalanceCents:number|null, expiresMonth:string|null, paymentCents:number|null, fromMonth:string, deferredInterest?:boolean|null}} input
   * @returns {{status:'needs_info'|'on_track'|'short', monthsLeft:number|null, requiredMonthlyCents:number|null,
   *   projectedRemainingCents:number|null, shortByCents:number|null, missing:string[], notes:string[]}}
   */
  function promoCheck(input) {
    const o = input || {};
    const balance = optCents(o.promoBalanceCents, 'promoBalanceCents');
    const payment = optPayment(o.paymentCents, 'paymentCents');
    const expires = E.months.isMonth(o.expiresMonth) ? o.expiresMonth : null;
    const from = E.months.isMonth(o.fromMonth) ? o.fromMonth : null;
    const deferred = o.deferredInterest === true || o.deferredInterest === false ? o.deferredInterest : null;

    const missing = [];
    const notes = [];
    if (balance === null) missing.push('Promotional balance (the amount under the promotion, which may differ from the whole card balance)');
    if (expires === null) missing.push('Promotion end month');
    if (payment === null) missing.push('Monthly payment');
    if (from === null) missing.push('Starting month for the check');

    let monthsLeft = expires && from ? E.months.between(from, expires) + 1 : null;
    if (monthsLeft !== null && monthsLeft <= 0) {
      missing.push('A current promotion end month (the entered end month ' + E.months.label(expires) + ' is before ' + E.months.label(from) + ')');
      monthsLeft = 0;
    }

    if (deferred !== false) {
      notes.push(deferred === true
        ? 'This promotion is marked as deferred interest: if any promotional balance is left after ' + (expires ? E.months.label(expires) : 'the end month') + ', interest from the original purchase date may be charged. Check the statement for the exact terms.'
        : 'Whether this promotion defers interest is not confirmed. Some promotions charge interest back to the purchase date if any balance remains at the end; check the card terms.');
    }

    const requiredMonthlyCents = balance !== null && monthsLeft ? Math.floor((Math.max(0, balance) + monthsLeft - 1) / monthsLeft) : (balance !== null && balance <= 0 ? 0 : null);
    const base = { monthsLeft, requiredMonthlyCents, projectedRemainingCents: null, shortByCents: null, missing, notes };

    if (missing.length) {
      notes.unshift('Not enough confirmed facts to judge whether the payment clears the promotion in time.');
      return Object.assign({ status: 'needs_info' }, base);
    }
    if (balance <= 0) {
      return Object.assign({ status: 'on_track' }, base, { requiredMonthlyCents: 0, projectedRemainingCents: 0, shortByCents: 0 });
    }
    const paidByEnd = payment * monthsLeft;
    const projectedRemainingCents = Math.max(0, balance - paidByEnd);
    const status = paidByEnd < balance ? 'short' : 'on_track';
    notes.push('Assumes each payment reduces the promotional balance; if the card also carries other balances, check how the issuer applies payments.');
    if (status === 'short') {
      notes.unshift('At ' + money(payment) + ' a month, about ' + money(projectedRemainingCents) + ' of the promotional balance would remain after ' + E.months.label(expires) +
        '. Clearing it needs about ' + money(requiredMonthlyCents) + ' a month for ' + plural(monthsLeft, 'month') + '.');
    } else {
      notes.unshift('At ' + money(payment) + ' a month the promotional balance is cleared by ' + E.months.label(expires) + ' (' + money(requiredMonthlyCents) + ' a month needed).');
    }
    return Object.assign({ status }, base, { projectedRemainingCents, shortByCents: projectedRemainingCents });
  }

  // ------------------------------------------------------------------ summary

  function isHousing(debt, bill) {
    if (bill && (bill.type === 'housing' || bill.category === 'Mortgage')) return true;
    if (debt.type === 'housing') return true;
    return /mortgage|home loan/i.test(String(debt.label || ''));
  }

  /**
   * Labelled facts about one debt and its payment, plus warnings for every missing fact.
   * @param {object} debt Debt
   * @param {object|null} bill the payment Bill (debt.paymentBillId), if any
   * @param {{month?:string}} [opts] month used as the starting month of a promotion check
   * @returns {{lines:Array<{key:string,label:string,value:string,status:string}>, warnings:string[], promo:object|null, lowerBound:object}}
   */
  function summary(debt, bill, opts) {
    if (!debt || typeof debt !== 'object') fail('A debt is required.', 'debt');
    const month = opts && E.months.isMonth(opts.month) ? opts.month : null;
    const lines = [];
    const warnings = [];
    const add = (key, label, value, status) => lines.push({ key, label, value, status });

    // Balance
    const balance = isCents(debt.balanceCents) ? debt.balanceCents : null;
    const balStatus = ['approximate', 'statement', 'confirmed'].includes(debt.balanceStatus) ? debt.balanceStatus : (balance === null ? 'unknown' : 'approximate');
    if (balance === null) {
      add('balance', 'Balance', 'Unknown', 'unknown');
      warnings.push('Balance not entered.');
    } else {
      const asOf = E.dates.isDate(debt.balanceAsOf) ? ', as of ' + E.dates.label(debt.balanceAsOf) : '';
      const word = balStatus === 'statement' ? 'statement balance' : balStatus;
      add('balance', 'Balance', money(balance) + ' (' + word + asOf + ')', balStatus);
      if (!asOf) warnings.push('Date of the balance not entered.');
    }

    // Payment
    // A negative amount is not a usable payment: show it as not entered rather than judge it.
    const payment = bill && isCents(bill.monthlyCents) && bill.monthlyCents >= 0 ? bill.monthlyCents : null;
    if (!bill) {
      add('payment', 'Monthly payment', 'No payment bill linked', 'unknown');
      warnings.push('No monthly payment is linked to this debt.');
    } else if (payment === null) {
      add('payment', 'Monthly payment', 'Not entered', 'unknown');
      warnings.push('Monthly payment amount not entered.');
    } else {
      const who = bill.fundedFrom === 'joint' ? 'joint' : bill.fundedFrom === 'p1' || bill.fundedFrom === 'p2' ? 'a personal account (' + bill.fundedFrom + ')' : null;
      add('payment', 'Monthly payment', money(payment) + ' a month' + (who ? ', paid from ' + who : ', paying account not confirmed'), bill.status === 'estimate' ? 'estimate' : bill.status === 'planned' ? 'planned' : 'confirmed');
      if (!who) warnings.push('Which account pays this is not confirmed.');
    }
    if (bill && E.months.isMonth(bill.endMonth)) add('finalPayment', 'Final payment', E.months.label(bill.endMonth), 'confirmed');

    // Interest rate
    const aprStatus = ['displayed', 'confirmed'].includes(debt.aprStatus) ? debt.aprStatus : 'unknown';
    const range = Array.isArray(debt.aprRange) && debt.aprRange.length === 2 && debt.aprRange.every(isNum) ? [Math.min(...debt.aprRange), Math.max(...debt.aprRange)] : null;
    if (isNum(debt.aprPct)) {
      add('apr', 'Interest rate (APR)', pct(debt.aprPct) + (aprStatus === 'confirmed' ? ' (confirmed)' : ' (as displayed, not confirmed)'), aprStatus === 'confirmed' ? 'confirmed' : 'displayed');
    } else if (range) {
      add('apr', 'Interest rate (APR)', pct(range[0]) + '–' + pct(range[1]) + (aprStatus === 'confirmed' ? ' (confirmed range)' : ' (displayed range, not confirmed)'), aprStatus === 'confirmed' ? 'confirmed' : 'displayed');
    } else {
      add('apr', 'Interest rate (APR)', 'Not confirmed', 'unknown');
    }
    if (aprStatus !== 'confirmed') warnings.push('Interest rate not confirmed: no payoff date is estimated.');
    else if (!isNum(debt.aprPct) && !range) warnings.push('Interest rate not entered (marked confirmed, but no rate is recorded): no payoff date is estimated.');

    // Loans and terms
    if (Number.isInteger(debt.loanCount) && debt.loanCount > 1) add('loans', 'Loans', plural(debt.loanCount, 'loan'), 'confirmed');
    if (debt.repaymentPlan) add('plan', 'Repayment plan', String(debt.repaymentPlan), 'confirmed');
    else if (Number.isInteger(debt.loanCount) && debt.loanCount > 1) { add('plan', 'Repayment plan', 'Unknown', 'unknown'); warnings.push('Repayment plan not confirmed.'); }
    if (debt.termStatus !== 'confirmed') warnings.push('Loan terms (remaining term, payment schedule) not confirmed.');

    // Floor on payments left (0% interest)
    const lowerBound = paymentsLowerBound(balance, payment);
    if (lowerBound.months !== null) add('paymentsLeft', 'Payments left (floor)', 'At least ' + plural(lowerBound.months, 'payment') + ' (assumes 0% interest)', 'info');

    // An illustration only when the rate is confirmed; still never a date.
    if (aprStatus === 'confirmed' && isNum(debt.aprPct) && balance !== null && payment !== null) {
      const ill = amortize({ balanceCents: balance, paymentCents: payment, aprPct: debt.aprPct });
      const text = ill.neverPaysOff ? 'Payment does not cover the interest' : ill.months === null ? 'Not paid off within 50 years' : 'About ' + plural(ill.months, 'month') + ' at ' + pct(debt.aprPct) + ' if nothing changes';
      add('illustration', 'Payoff illustration', text, 'illustrative');
    }

    // Escrow (housing)
    if (isHousing(debt, bill)) {
      if (debt.escrowIncluded === true) add('escrow', 'Taxes and insurance', 'Included in the payment (escrow)', 'confirmed');
      else if (debt.escrowIncluded === false) add('escrow', 'Taxes and insurance', 'Not included: budget property tax and home insurance separately', 'confirmed');
      else {
        add('escrow', 'Taxes and insurance', 'Unknown whether the payment includes property tax and insurance (escrow)', 'unknown');
        warnings.push('Escrow unknown: check whether the housing payment includes property tax and home insurance, so they are not budgeted twice or missed.');
      }
    }

    // Promotional financing
    let promo = null;
    if (debt.promo && typeof debt.promo === 'object') {
      promo = promoCheck({
        promoBalanceCents: isCents(debt.promo.balanceCents) ? debt.promo.balanceCents : null,
        expiresMonth: debt.promo.expiresMonth,
        paymentCents: payment,
        fromMonth: month,
        deferredInterest: debt.promo.deferredInterest
      });
      const value = promo.status === 'needs_info'
        ? 'Needs information: ' + promo.missing.map(m => m.split(' (')[0].toLowerCase()).join(', ')
        : promo.status === 'short'
          ? 'Short: about ' + money(promo.requiredMonthlyCents) + ' a month needed through ' + E.months.label(debt.promo.expiresMonth)
          : 'On track to clear by ' + E.months.label(debt.promo.expiresMonth);
      add('promo', 'Promotion', value, promo.status);
      for (const m of promo.missing) warnings.push('Promotion: ' + m + ' not confirmed.');
      if (debt.promo.deferredInterest === null || debt.promo.deferredInterest === undefined) warnings.push('Promotion: whether interest is deferred is not confirmed.');
    }

    return { lines, warnings: [...new Set(warnings)], promo, lowerBound };
  }

  E.debt = { paymentsLowerBound, amortize, illustrativeRange, promoCheck, summary };
})(typeof globalThis !== 'undefined' ? globalThis : this);
