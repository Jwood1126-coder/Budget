'use strict';
/*
 * Usual-spend comparisons: "is this month's spending in a category higher than usual?"
 *
 * Principles (see docs/ARCHITECTURE.md §8, BudgetEngine.compare):
 *   - The baseline is the `window` calendar months immediately BEFORE the selected month; the
 *     selected month never enters its own baseline.
 *   - Only fully covered months count. A covered month with no activity in a category counts as $0;
 *     a partially covered month is left out (never zero-filled), because missing days are unknown.
 *   - A difference is flagged only when it is both at least RULE.minDiffCents and at least
 *     RULE.minPct of the usual amount, and there are at least RULE.minMonths usable months.
 *   - Seasonal categories (heating, cooling) are judged against the same month last year.
 *   - Irregular categories are not judged against an average: with at least IRREGULAR_MIN_MONTHS
 *     usable baseline months and activity in exactly one of them, a payment (an annual bill such
 *     as home insurance, an occasional purchase), a monthly average is not meaningful. Such a
 *     category is signalled 'irregular' (never 'higher'/'lower'; diffCents and pct are null) and
 *     the explanation cites the one month and amount. This applies only when the selected month
 *     is $0 or close to that single payment (within the threshold rule); a much larger month is
 *     judged against the average as usual. A baseline with no activity stays 'new'.
 *     A partial selected month is still 'partial_month'; seasonal categories keep their own rule.
 *   - Every result carries a plain-language explanation that cites the numbers used.
 *
 * Signals: 'higher' | 'lower' | 'typical' | 'new' | 'irregular' | 'no_history' | 'limited_history'
 *   | 'refund_baseline' | 'partial_month' | 'seasonal_higher' | 'seasonal_typical' | 'seasonal_lower'
 *   | 'seasonal_unknown'.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const RULE = Object.freeze({ minDiffCents: 10000, minPct: 25, minMonths: 2 });
  /** Usable baseline months needed before a category with a single active month is 'irregular'. */
  const IRREGULAR_MIN_MONTHS = 3;

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

  // ------------------------------------------------------------------ wording helpers

  /** Whole dollars for amounts of $100 or more (or round amounts), cents otherwise. */
  function money(c) {
    const whole = Math.abs(c) >= 10000 || c % 100 === 0;
    return E.money.format(c, { decimals: whole ? 0 : 2 });
  }
  function signedMoney(c) {
    const whole = Math.abs(c) >= 10000 || c % 100 === 0;
    return E.money.format(c, { decimals: whole ? 0 : 2, signed: true });
  }
  function pctText(p) {
    if (p > 0) return '+' + p + '%';
    if (p < 0) return '−' + Math.abs(p) + '%';
    return '0%';
  }
  /**
   * Percent for an explanation. Whole percent, except when rounding would show the rule's limit
   * for a difference that is actually under it ("+25% … under 25%"): then one decimal, truncated.
   */
  function pctForText(diff, base, rule) {
    const p = percent(diff, base);
    const abs = Math.abs(diff);
    if (Math.abs(p) === rule.minPct && abs * 100 < rule.minPct * base) {
      const tenths = Math.floor((abs * 1000) / base) / 10;
      return (diff < 0 ? '−' : '+') + tenths.toFixed(1) + '%';
    }
    return pctText(p);
  }
  const label = m => E.months.label(m);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const stripDot = s => String(s).replace(/\.\s*$/, '');
  const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);

  /** "Jun–Aug 2026", "Nov 2025–Jan 2026", "Aug 2026", or a list for non-contiguous months. */
  function describeMonths(list) {
    if (!list.length) return 'no months';
    if (list.length === 1) return label(list[0]);
    const contiguous = list.every((m, i) => i === 0 || E.months.between(list[i - 1], m) === 1);
    if (contiguous) {
      const a = list[0], b = list[list.length - 1];
      if (a.slice(0, 4) === b.slice(0, 4)) return label(a).slice(0, 3) + '–' + label(b);
      return label(a) + '–' + label(b);
    }
    const labels = list.map(label);
    return labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
  }

  /** Signed whole percent, rounded half away from zero. */
  function percent(diff, base) {
    const q = (diff * 100) / base;
    const r = Math.round(Math.abs(q));
    return q < 0 ? -r : r;
  }

  function div(total, n) {
    const r = E.money.divide(total, n);
    return r === null ? null : r || 0; // avoid -0
  }

  /**
   * Which accounts leave the month incomplete, e.g. "Joint card has 0 of 30 days covered".
   * Naming the account avoids implying there is no data at all when only one export is missing.
   */
  function missingAccounts(c) {
    const gaps = (c.accounts || []).filter(a => a.expected !== false && a.coveredDays < a.totalDays);
    if (!gaps.length) return c.coveredDays + ' of ' + c.totalDays + ' days covered';
    return gaps.map(a => (a.label || a.accountId) + ' has ' + a.coveredDays + ' of ' + a.totalDays + ' days covered').join('; ');
  }

  /** Why a baseline month cannot be used, as a short sentence fragment. */
  function coverageReason(c) {
    if (c.overridden) return 'Marked ' + c.status + (c.note ? ' (' + stripDot(c.note) + ')' : '');
    if (c.status === 'none') return 'No account export covers it';
    return 'Partial: ' + missingAccounts(c);
  }

  function partialText(c, month) {
    if (c.overridden) return label(month) + ' coverage is marked ' + c.status + (c.note ? ' (' + stripDot(c.note) + ')' : '') + '; not compared.';
    if (c.status === 'none') return 'No account export covers ' + label(month) + '; not compared.';
    return 'Only part of ' + label(month) + ' is covered (' + missingAccounts(c) + '); not compared.';
  }

  /**
   * Apply the threshold rule: flagged only when |diff| >= minDiffCents AND |diff| >= minPct% of base.
   * `base` must be > 0. Returns the decision and a phrase naming which condition held.
   */
  function threshold(diff, base, rule, baseWord) {
    const abs = Math.abs(diff);
    const overMin = abs >= rule.minDiffCents;
    const overPct = abs * 100 >= rule.minPct * base;
    const minText = money(rule.minDiffCents);
    const pctLimit = rule.minPct + '%';
    let phrase;
    if (overMin && overPct) {
      const strictly = abs > rule.minDiffCents && abs * 100 > rule.minPct * base;
      phrase = (strictly ? 'exceeds' : 'meets') + ' both ' + minText + ' and ' + pctLimit;
    } else if (overMin) phrase = 'is over ' + minText + ' but under ' + pctLimit + ' of ' + baseWord;
    else if (overPct) phrase = 'is over ' + pctLimit + ' but under ' + minText;
    else phrase = 'is under both ' + minText + ' and ' + pctLimit;
    return { flag: overMin && overPct, phrase };
  }

  // ------------------------------------------------------------------ data helpers

  function normalizeWindow(w) {
    if (w === undefined || w === null) return 3;
    if (!Number.isInteger(w) || w < 1 || w > 36) throw new E.ValidationError('The comparison window must be a whole number of months (3, 6 or 12).', 'window');
    return w;
  }

  function requireMonth(m) {
    if (!E.months.isMonth(m)) throw new E.ValidationError('Choose a month (YYYY-MM) to compare; got ' + JSON.stringify(m) + '.', 'month');
    return m;
  }

  function coverageCache(dataset) {
    const cache = new Map();
    return m => {
      if (!cache.has(m)) cache.set(m, E.ledger.coverage(dataset, m));
      return cache.get(m);
    };
  }

  /**
   * Counted spending per month and category (from effective parts, so splits land in their
   * categories). `adjustedCents` leaves out rows marked "exclude from planning".
   */
  function tally(txns) {
    const months = new Map();
    for (const t of txns) {
      if (t.excluded || t.kind !== 'spend') continue;
      const parts = E.ledger.partsOf(t);
      if (!parts.length) continue;
      const m = t.date.slice(0, 7);
      if (!months.has(m)) months.set(m, new Map());
      const cats = months.get(m);
      for (const p of parts) {
        if (!cats.has(p.category)) cats.set(p.category, { cents: 0, adjustedCents: 0, excludedCents: 0, count: 0, ids: [] });
        const c = cats.get(p.category);
        c.cents += p.spendCents;
        c.count += 1;
        if (!c.ids.includes(t.id)) c.ids.push(t.id);
        if (t.planningExcluded) c.excludedCents += p.spendCents;
        else c.adjustedCents += p.spendCents;
      }
    }
    return months;
  }

  function cell(data, month, category) {
    const cats = data.get(month);
    return (cats && cats.get(category)) || null;
  }

  /** Split the `window` months before `month` into usable (full) and excluded months. */
  function baselineFor(month, window, cov) {
    const trailing = E.months.range(E.months.add(month, -window), E.months.add(month, -1));
    const baselineMonths = [];
    const excludedMonths = [];
    for (const m of trailing) {
      const c = cov(m);
      if (c.status === 'full') baselineMonths.push(m);
      else excludedMonths.push({ month: m, reason: coverageReason(c) });
    }
    return { trailing, baselineMonths, excludedMonths };
  }

  // ------------------------------------------------------------------ usual()

  /** A full-coverage month 11–13 months earlier holding at least half of `cents` (and no more than double). */
  function yearlyMatch(category, month, cents, ctx) {
    for (const k of [12, 11, 13]) {
      const m = E.months.add(month, -k);
      if (ctx.cov(m).status !== 'full') continue;
      const c = cell(ctx.data, m, category);
      if (c && c.cents > 0 && c.cents >= cents * 0.5 && c.cents <= cents * 2) return { month: m, cents: c.cents };
    }
    return null;
  }

  function judgeCategory(category, ctx) {
    const { month, rule, planning, data, baselineMonths, excludedMonths, trailing, selectedCoverage, cov, seasonalList } = ctx;
    const usableCount = baselineMonths.length;
    const sel = cell(data, month, category);
    const actualCents = sel ? sel.cents : 0;
    const selectedPlanningExcluded = sel ? sel.excludedCents : 0;

    let rawSum = 0, adjustedSum = 0, monthsWithActivity = 0;
    const planningOut = [];
    const active = [];
    for (const m of baselineMonths) {
      const c = cell(data, m, category);
      if (!c) continue; // a covered month with no activity counts as $0
      rawSum += c.cents;
      adjustedSum += c.adjustedCents;
      if (c.count > 0) { monthsWithActivity += 1; active.push({ month: m, cents: c.cents }); }
      if (c.excludedCents !== 0) planningOut.push({ month: m, cents: c.excludedCents });
    }
    const averageCents = usableCount ? div(planning ? adjustedSum : rawSum, usableCount) : null;
    const rawAverageCents = usableCount ? div(rawSum, usableCount) : null;

    let seasonal = null;
    if (E.categories.isSeasonal(category, seasonalList)) {
      const lastYearMonth = E.months.add(month, -12);
      const covered = cov(lastYearMonth).status === 'full';
      const ly = cell(data, lastYearMonth, category);
      const lastYearCents = covered ? (ly ? (planning ? ly.adjustedCents : ly.cents) : 0) : null;
      seasonal = { lastYearMonth, lastYearCents, lastYearCovered: covered };
    }

    const basisText = 'average of ' + describeMonths(baselineMonths) + ', ' + plural(usableCount, 'full month')
      + (excludedMonths.length ? '; left out: ' + excludedMonths.map(e => label(e.month) + ' (' + lowerFirst(e.reason) + ')').join(', ') : '');

    let signal, yearly = null;
    let explanation;
    let diffCents = null;
    let pct = null;
    let basis = 'average';
    let basisCents = averageCents;
    let irregular = null;

    if (selectedCoverage.status !== 'full') {
      signal = 'partial_month';
      explanation = partialText(selectedCoverage, month);
    } else if (seasonal && seasonal.lastYearCovered) {
      basis = 'last_year';
      const ly = seasonal.lastYearCents;
      basisCents = ly;
      diffCents = actualCents - ly;
      const lead = category + ' costs follow the seasons, so ' + label(month) + ' is compared with '
        + label(seasonal.lastYearMonth) + ' (' + money(ly) + ') instead of the trailing average.';
      if (ly < 0) {
        signal = 'refund_baseline';
        explanation = lead + ' ' + label(seasonal.lastYearMonth) + ' was a net refund, so no percentage is shown and ' + label(month) + ' (' + money(actualCents) + ') is not flagged.';
      } else if (ly === 0) {
        signal = actualCents === 0 ? 'seasonal_typical' : 'new';
        explanation = actualCents === 0
          ? lead + ' There was no spending in either month.'
          : lead + ' There was no ' + category + ' spending in ' + label(seasonal.lastYearMonth) + ', so ' + money(actualCents) + ' in ' + label(month) + ' is new.';
      } else {
        pct = percent(diffCents, ly);
        const t = threshold(diffCents, ly, rule, 'last year');
        signal = t.flag ? (diffCents > 0 ? 'seasonal_higher' : 'seasonal_lower') : 'seasonal_typical';
        explanation = lead + ' ' + money(actualCents) + ' vs ' + money(ly) + ': ' + signedMoney(diffCents) + ' (' + pctForText(diffCents, ly, rule) + ') ' + t.phrase
          + ', so it is ' + (t.flag ? 'marked ' + (diffCents > 0 ? 'higher' : 'lower') + ' than last year' : 'typical for the season') + '.';
      }
    } else if (seasonal) {
      signal = 'seasonal_unknown';
      if (averageCents !== null) {
        diffCents = actualCents - averageCents;
        pct = averageCents > 0 ? percent(diffCents, averageCents) : null;
      }
      explanation = category + ' costs follow the seasons, but ' + label(seasonal.lastYearMonth) + ' is not fully covered, so '
        + label(month) + ' (' + money(actualCents) + ') is not judged'
        + (averageCents !== null ? ' against the trailing average (' + money(averageCents) + ', ' + basisText + ').' : '.');
    } else if (usableCount === 0) {
      signal = 'no_history';
      explanation = 'No full months in ' + describeMonths(trailing) + ' to compare with, so ' + label(month) + ' (' + money(actualCents) + ') is not judged.'
        + (excludedMonths.length ? ' Left out: ' + excludedMonths.map(e => label(e.month) + ' (' + lowerFirst(e.reason) + ')').join(', ') + '.' : '');
    } else if (usableCount < rule.minMonths) {
      signal = 'limited_history';
      diffCents = actualCents - averageCents;
      pct = averageCents > 0 ? percent(diffCents, averageCents) : null;
      explanation = label(month) + ' ' + money(actualCents) + ' vs ' + money(averageCents) + ' (' + basisText + '). Only '
        + plural(usableCount, 'full month') + ' of history; at least ' + rule.minMonths + ' are needed before anything is flagged.';
    } else if (usableCount >= IRREGULAR_MIN_MONTHS && monthsWithActivity === 1 && active[0].cents > 0
      && (actualCents <= 0 || Math.abs(actualCents - active[0].cents) < Math.max(rule.minDiffCents, active[0].cents * rule.minPct / 100))) {
      // Only when this month looks like a repeat of that single payment (or nothing was paid):
      // a $2,000 month after one $45 month is still judged against the average and flagged.
      // One payment in the whole baseline (an annual bill, an occasional purchase): the average
      // would mark every other month 'lower' and the month it is paid 'higher', so neither is said.
      signal = 'irregular';
      irregular = { month: active[0].month, cents: active[0].cents };
      explanation = 'Paid in only 1 of the last ' + plural(usableCount, 'full month') + ' (' + label(irregular.month) + ': ' + money(irregular.cents)
        + "), so a monthly average isn't meaningful. " + label(month) + ' (' + money(actualCents) + ') is not marked higher or lower.'
        + (excludedMonths.length ? ' Left out: ' + excludedMonths.map(e => label(e.month) + ' (' + lowerFirst(e.reason) + ')').join(', ') + '.' : '');
    } else if (averageCents === 0 && actualCents > 0 && (yearly = yearlyMatch(category, month, actualCents, ctx))) {
      // Nothing in the trailing months, but a similar payment about a year earlier: a yearly
      // bill (insurance, registration), not new spending. Same test as review.spikes.
      signal = 'irregular';
      irregular = yearly;
      explanation = 'A similar payment about a year earlier (' + label(yearly.month) + ': ' + money(yearly.cents) + ') suggests a yearly bill, so '
        + label(month) + ' (' + money(actualCents) + ') is not marked new or higher.';
    } else if (averageCents === 0) {
      diffCents = actualCents;
      signal = actualCents === 0 ? 'typical' : 'new';
      explanation = actualCents === 0
        ? 'No ' + category + ' spending in ' + label(month) + ' or in ' + describeMonths(baselineMonths) + '.'
        : 'No ' + category + ' spending in ' + describeMonths(baselineMonths) + ' (' + plural(usableCount, 'full month') + '), so '
          + money(actualCents) + ' in ' + label(month) + ' is new.';
    } else if (averageCents < 0) {
      signal = 'refund_baseline';
      diffCents = actualCents - averageCents;
      explanation = 'Usual ' + category + ' is a net refund of ' + money(0 - averageCents) + ' (' + basisText + '), so no percentage is shown and '
        + label(month) + ' (' + money(actualCents) + ') is not flagged.';
    } else {
      diffCents = actualCents - averageCents;
      pct = percent(diffCents, averageCents);
      const t = threshold(diffCents, averageCents, rule, 'usual');
      signal = t.flag ? (diffCents > 0 ? 'higher' : 'lower') : 'typical';
      explanation = label(month) + ' ' + money(actualCents) + ' vs usual ' + money(averageCents) + ' (' + basisText + '). '
        + signedMoney(diffCents) + ' (' + pctForText(diffCents, averageCents, rule) + ') ' + t.phrase + ', so it is '
        + (t.flag ? 'marked ' + (diffCents > 0 ? 'higher' : 'lower') + ' than usual' : 'typical') + '.';
    }

    if (planning) {
      const outTotal = planningOut.reduce((s, p) => s + p.cents, 0);
      if (outTotal !== 0) {
        explanation += ' For planning, ' + money(outTotal) + ' marked as excluded from planning (' + describeMonths(planningOut.map(p => p.month))
          + ') is left out of the usual' + (rawAverageCents !== null ? ' (' + money(rawAverageCents) + ' with it)' : '') + '.';
      }
      if (selectedPlanningExcluded !== 0) {
        explanation += ' ' + label(month) + ' includes ' + money(selectedPlanningExcluded) + ' marked as excluded from planning; it still counts in actual spending.';
      }
    }

    return {
      category,
      group: E.categories.groupOf(category),
      actualCents,
      averageCents,
      diffCents,
      pct,
      signal,
      explanation,
      seasonal,
      monthsWithActivity,
      irregular,
      basis,
      basisCents,
      planningExcludedCents: planningOut.reduce((s, p) => s + p.cents, 0),
      ids: sel ? sel.ids.slice() : []
    };
  }

  /**
   * Compare a month's spending per category with the usual (trailing average of full months).
   * @param {object[]} txns effective transactions (ledger.applyEdits)
   * @param {object} dataset normalized dataset (for coverage)
   * @param {{month: string, window?: number, category?: string, planning?: boolean, rule?: object, seasonalCategories?: string[]}} opts
   * @returns {object} ComparisonResult (contract §8) plus `basis`/`basisCents` per category and
   *   `irregular` ({month, cents} of the single active baseline month when signal is 'irregular', else null)
   */
  function usual(txns, dataset, opts = {}) {
    const month = requireMonth(opts.month);
    const window = normalizeWindow(opts.window);
    // A rule value left undefined/null keeps the default rather than silently disabling the check.
    const rule = Object.assign({}, RULE);
    if (isObj(opts.rule)) for (const [k, v] of Object.entries(opts.rule)) if (v !== undefined && v !== null) rule[k] = v;
    const planning = opts.planning === true;
    const cov = coverageCache(dataset);
    const selectedCoverage = cov(month);
    const { trailing, baselineMonths, excludedMonths } = baselineFor(month, window, cov);
    const data = tally(txns);

    let names;
    if (nonEmpty(opts.category)) {
      names = [opts.category];
    } else {
      const set = new Set();
      for (const m of [month].concat(baselineMonths)) {
        const cats = data.get(m);
        if (cats) for (const k of cats.keys()) set.add(k);
      }
      names = [...set];
    }

    const ctx = { month, rule, planning, data, baselineMonths, excludedMonths, trailing, selectedCoverage, cov, seasonalList: opts.seasonalCategories };
    const categories = names.map(c => judgeCategory(c, ctx)).sort((a, b) =>
      b.actualCents - a.actualCents
      || (b.averageCents ?? -Infinity) - (a.averageCents ?? -Infinity)
      || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));

    const usableCount = baselineMonths.length;
    let baselineSum = 0;
    for (const m of baselineMonths) for (const c of names) {
      const v = cell(data, m, c);
      if (v) baselineSum += planning ? v.adjustedCents : v.cents;
    }
    const actualCents = categories.reduce((s, c) => s + c.actualCents, 0);
    const averageCents = usableCount ? div(baselineSum, usableCount) : null;
    const diffCents = selectedCoverage.status === 'full' && averageCents !== null ? actualCents - averageCents : null;

    return {
      month,
      window,
      selectedCoverage,
      trailingMonths: trailing,
      baselineMonths,
      usableCount,
      excludedMonths,
      rule,
      planning,
      categories,
      totals: { actualCents, averageCents, diffCents }
    };
  }

  // ------------------------------------------------------------------ trend()

  /**
   * Monthly spending (all categories, or one) with each month's coverage. A month that no export
   * covers and that has no rows is unknown (null), not $0.
   */
  function trend(txns, dataset, { category, months } = {}) {
    const list = Array.isArray(months) ? months : E.ledger.months(dataset);
    const data = tally(txns);
    const cov = coverageCache(dataset);
    return list.map(m => {
      requireMonth(m);
      const c = cov(m);
      const cats = data.get(m);
      let cents = 0, rows = 0;
      if (cats) {
        for (const [name, v] of cats) {
          if (category && name !== category) continue;
          cents += v.cents;
          rows += v.count;
        }
      }
      return { month: m, spendCents: c.status === 'none' && rows === 0 ? null : cents, coverage: c };
    });
  }

  // ------------------------------------------------------------------ planningBaseline()

  /**
   * Per-category averages over the `window` calendar months ending at `endMonth` (inclusive),
   * using only full months. adjustedAvgCents leaves out rows marked "exclude from planning";
   * actualAvgCents keeps them. excludedCents is the total left out (not an average).
   * endMonth defaults to the latest complete month.
   */
  function planningBaseline(txns, dataset, opts = {}) {
    const window = normalizeWindow(opts.window);
    const endMonth = opts.endMonth === undefined || opts.endMonth === null ? E.ledger.latestCompleteMonth(dataset) : requireMonth(opts.endMonth);
    if (endMonth === null) return {};
    const cov = coverageCache(dataset);
    const used = E.months.range(E.months.add(endMonth, -(window - 1)), endMonth).filter(m => cov(m).status === 'full');
    const n = used.length;
    const data = tally(txns);
    const sums = new Map();
    for (const m of used) {
      const cats = data.get(m);
      if (!cats) continue;
      for (const [cat, v] of cats) {
        if (!sums.has(cat)) sums.set(cat, { cents: 0, adjusted: 0, excluded: 0 });
        const s = sums.get(cat);
        s.cents += v.cents;
        s.adjusted += v.adjustedCents;
        s.excluded += v.excludedCents;
      }
    }
    const out = {};
    for (const [cat, s] of sums) {
      out[cat] = { actualAvgCents: div(s.cents, n), adjustedAvgCents: div(s.adjusted, n), excludedCents: s.excluded, usableCount: n, months: used.slice() };
    }
    return out;
  }

  // ------------------------------------------------------------------ planVsActual()

  function billActiveIn(bill, month) {
    if (E.months.isMonth(bill.startMonth) && month < bill.startMonth) return false;
    if (E.months.isMonth(bill.endMonth) && month > bill.endMonth) return false;
    return true;
  }

  /**
   * Planned vs actual spending per category for one month. Rows come from plan.targets and
   * joint-funded bills with a category (merged per category so a category's actual is compared
   * once); categories with spending but no plan appear with status 'no_plan'. By default only
   * joint-account spending is compared, because targets and joint bills are joint-funded
   * (pass scope: 'all' to compare every account passed in).
   */
  function planVsActual(plan, txns, dataset, opts = {}) {
    const month = requireMonth(opts.month);
    const p = isObj(plan) ? plan : {};
    const settingsWindow = isObj(p.settings) ? p.settings.comparisonWindow : undefined;
    const window = normalizeWindow(opts.window !== undefined ? opts.window : settingsWindow);
    const scoped = opts.scope === 'all' || opts.scope === 'household' ? txns : txns.filter(t => t.accountScope !== 'personal');

    const comparison = usual(scoped, dataset, { month, window });
    const signalBy = new Map(comparison.categories.map(c => [c.category, c.signal]));
    const usable = comparison.usableCount > 0;
    const usualBy = new Map(comparison.categories.map(c => [c.category, c.averageCents]));
    const adjusted = planningBaseline(scoped, dataset, { endMonth: E.months.add(month, -1), window });
    const partial = comparison.selectedCoverage.status !== 'full';
    const monthCats = tally(scoped).get(month) || new Map();

    const planned = new Map();
    const addSource = (category, source) => {
      if (!planned.has(category)) planned.set(category, []);
      planned.get(category).push(source);
    };
    for (const [category, cents] of Object.entries(isObj(p.targets) ? p.targets : {})) {
      addSource(category, { kind: 'target', id: null, label: category, plannedCents: E.money.isCents(cents) ? cents : null });
    }
    for (const b of Array.isArray(p.bills) ? p.bills : []) {
      if (!isObj(b) || b.fundedFrom !== 'joint' || !nonEmpty(b.category)) continue;
      if (b.status === 'planned' || !billActiveIn(b, month)) continue; // not a bill in this month
      addSource(b.category, { kind: 'bill', id: b.id || null, label: nonEmpty(b.label) ? b.label : b.category, plannedCents: E.money.isCents(b.monthlyCents) ? b.monthlyCents : null });
    }

    const row = (category, sources) => {
      const actualCents = monthCats.has(category) ? monthCats.get(category).cents : 0;
      const plannedCents = sources.length ? E.money.sumKnown(sources.map(s => s.plannedCents)) : null;
      const kind = sources.some(s => s.kind === 'target') || !sources.length ? 'target' : 'bill';
      const diffToPlanCents = plannedCents === null ? null : actualCents - plannedCents;
      let status;
      if (partial) status = 'partial_month';
      else if (plannedCents === null) status = 'no_plan';
      else if (actualCents === 0 && signalBy.get(category) === 'irregular') status = 'irregular'; // e.g. a quarterly bill not due this month
      else status = diffToPlanCents > 0 ? 'over' : diffToPlanCents < 0 ? 'under' : 'on_plan';
      return {
        category,
        kind,
        label: sources.length === 1 ? sources[0].label : (kind === 'target' || !sources.length ? category : sources.map(s => s.label).join(' + ')),
        plannedCents,
        actualCents,
        usualCents: usualBy.has(category) ? usualBy.get(category) : (usable ? 0 : null),
        adjustedUsualCents: adjusted[category] ? adjusted[category].adjustedAvgCents : (usable ? 0 : null),
        diffToPlanCents,
        status,
        sources
      };
    };

    const rows = E.categories.sortNames([...planned.keys()]).map(c => row(c, planned.get(c)));
    const unplanned = [...monthCats.keys()].filter(c => !planned.has(c)).map(c => row(c, []))
      .sort((a, b) => b.actualCents - a.actualCents || (a.category < b.category ? -1 : 1));
    return rows.concat(unplanned);
  }

  E.compare = { RULE, IRREGULAR_MIN_MONTHS, usual, trend, planningBaseline, planVsActual, describeMonths };
})(typeof globalThis !== 'undefined' ? globalThis : this);
