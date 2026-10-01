'use strict';
/*
 * Paycheck dates and counts (docs/ARCHITECTURE.md §8, BudgetEngine.schedule).
 *
 * Why this matters: a biweekly paycheck arrives 26 times a year, not 24. Most calendar months
 * get two checks, but two months a year get three. A budget that silently uses the annual
 * average overstates a typical month; one that silently uses "2 a month" hides the extra
 * checks. This module makes the choice explicit through three timing modes:
 *
 *   'actual'        count the real paydays that fall in the calendar month (needs a date)
 *   'conservative'  a typical month: weekly 4, biweekly 2, semimonthly 2, monthly 1
 *   'average'       annual average: weekly 52/12, biweekly 26/12, semimonthly 2, monthly 1
 *
 * Unknown frequency never becomes a silent guess: the stream's explicit
 * `assumedPerMonthIfUnknown` (default 2) is used and a plainly worded assumption is returned.
 *
 * Weekend rule: semimonthly and monthly paydays that fall on Saturday/Sunday move to the
 * previous Friday. Weekly/biweekly follow the anchor date exactly. Holidays are not modelled.
 * A payday scheduled for the 1st that rolls back to the last Friday of the previous month still
 * belongs to its scheduled month, so semimonthly pay is always exactly 2 per month and monthly
 * pay exactly 1 (the returned date is the real deposit date).
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
  const TIMINGS = ['actual', 'conservative', 'average'];

  /** Paychecks per year for each known frequency. */
  const PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
  /** Paychecks in a typical (most common) month. */
  const TYPICAL = { weekly: 4, biweekly: 2, semimonthly: 2, monthly: 1 };
  /** Most paychecks any calendar month can hold. */
  const MOST_IN_MONTH = { weekly: 5, biweekly: 3, semimonthly: 2, monthly: 1 };
  const STEP_DAYS = { weekly: 7, biweekly: 14 };

  const LABELS = {
    weekly: 'Weekly',
    biweekly: 'Every two weeks (biweekly)',
    semimonthly: 'Twice a month (semimonthly)',
    monthly: 'Monthly'
  };

  const DEFAULT_ASSUMED_PER_MONTH = 2;
  const DEFAULT_SEMIMONTHLY_DAYS = [15, 31];

  // ------------------------------------------------------------------ helpers

  function fail(message, field) { throw new E.ValidationError(message, field); }

  function requireMonth(month) {
    if (!E.months.isMonth(month)) fail('Month must be in YYYY-MM form (got ' + JSON.stringify(month) + ').', 'month');
  }

  function knownFrequency(stream) {
    const f = stream && stream.frequency;
    return FREQUENCIES.includes(f) ? f : null;
  }

  function streamName(stream) {
    return (stream && (stream.label || stream.id)) || 'This income';
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  /** Move a Saturday/Sunday date to the previous Friday. */
  function rollWeekendBack(date) {
    const wd = E.dates.weekday(date);
    if (wd === 6) return E.dates.addDays(date, -1);
    if (wd === 0) return E.dates.addDays(date, -2);
    return date;
  }

  function validDay(d) { return Number.isInteger(d) && d >= 1 && d <= 31; }

  function semimonthlyDays(stream) {
    const days = stream.semimonthlyDays;
    if (Array.isArray(days) && days.length === 2 && days.every(validDay) && days[0] !== days[1]) return [...days];
    return [...DEFAULT_SEMIMONTHLY_DAYS];
  }

  /** Day of month for monthly pay: monthlyDay, else the anchor date's day, else null. */
  function monthlyDayOf(stream) {
    if (validDay(stream.monthlyDay)) return stream.monthlyDay;
    if (E.dates.isDate(stream.anchorDate)) return Number(stream.anchorDate.slice(8, 10));
    return null;
  }

  function assumedPerMonth(stream) {
    const n = stream && stream.assumedPerMonthIfUnknown;
    return Number.isInteger(n) && n >= 0 && n <= 31 ? n : DEFAULT_ASSUMED_PER_MONTH;
  }

  /** True when `month` lies inside the stream's optional startMonth..endMonth window. */
  function activeIn(stream, month) {
    if (E.months.isMonth(stream.startMonth) && month < stream.startMonth) return false;
    if (E.months.isMonth(stream.endMonth) && month > stream.endMonth) return false;
    return true;
  }

  // ------------------------------------------------------------------ public API

  /**
   * Real paydays for the paychecks scheduled in `month`.
   * Weekly/biweekly: anchorDate ± 7k / 14k days (anchor may be in the past or future).
   * Semimonthly: the two configured days (31 = last day of month; days past month end clamp).
   * Monthly: monthlyDay clamped to the month's length.
   * Returns null when the frequency is unknown or the needed date (anchor/day) is missing.
   * @param {object} stream IncomeStream
   * @param {string} month 'YYYY-MM'
   * @returns {string[]|null}
   */
  function paydays(stream, month) {
    requireMonth(month);
    if (!stream || typeof stream !== 'object') fail('An income stream is required.', 'stream');
    const freq = knownFrequency(stream);
    if (!freq) return null;

    if (freq === 'weekly' || freq === 'biweekly') {
      if (!E.dates.isDate(stream.anchorDate)) return null;
      const step = STEP_DAYS[freq];
      const anchor = E.dates.dayNumber(stream.anchorDate);
      const first = E.dates.dayNumber(E.months.start(month));
      const last = E.dates.dayNumber(E.months.end(month));
      // First payday on or after the 1st of the month; works for anchors before or after it.
      const k = Math.ceil((first - anchor) / step);
      const out = [];
      for (let d = anchor + k * step; d <= last; d += step) out.push(E.dates.fromDayNumber(d));
      return out;
    }

    if (freq === 'semimonthly') {
      const scheduled = semimonthlyDays(stream).sort((a, b) => a - b).map(day => E.dates.inMonth(month, day));
      const unique = [...new Set(scheduled)]; // e.g. [30, 31] in February both clamp to the 28th
      return unique.map(rollWeekendBack);
    }

    // monthly
    const day = monthlyDayOf(stream);
    if (day === null) return null;
    return [rollWeekendBack(E.dates.inMonth(month, day))];
  }

  /**
   * Paychecks per month for a frequency under a planning timing.
   * @param {string} frequency 'weekly'|'biweekly'|'semimonthly'|'monthly'|'unknown'
   * @param {'conservative'|'average'} timing
   * @returns {number|null} null when the frequency is unknown
   */
  function perMonth(frequency, timing = 'conservative') {
    if (timing !== 'conservative' && timing !== 'average') fail('Timing must be "conservative" or "average".', 'timing');
    if (!FREQUENCIES.includes(frequency)) return null;
    return timing === 'conservative' ? TYPICAL[frequency] : PER_YEAR[frequency] / 12;
  }

  /**
   * How many paychecks a stream contributes to `month`.
   * @param {object} stream IncomeStream
   * @param {string} month 'YYYY-MM'
   * @param {'actual'|'conservative'|'average'} [timing='actual']
   * @returns {{count:number, basis:'actual'|'typical'|'average'|'assumed'|'none', dates:string[], assumption:string|null, perYear:number|null}}
   *   `count` may be fractional for 'average'. `perYear` is set for the 'average' basis so callers
   *   can round money exactly (perPaycheck × perYear / 12).
   */
  function count(stream, month, timing = 'actual') {
    requireMonth(month);
    if (!stream || typeof stream !== 'object') fail('An income stream is required.', 'stream');
    if (timing === undefined || timing === null) timing = 'actual';
    if (!TIMINGS.includes(timing)) fail('Timing must be "actual", "conservative" or "average".', 'timing');

    if (!activeIn(stream, month)) return { count: 0, basis: 'none', dates: [], assumption: null, perYear: null };

    const name = streamName(stream);
    const freq = knownFrequency(stream);
    if (!freq) {
      const n = assumedPerMonth(stream);
      return {
        count: n,
        basis: 'assumed',
        dates: [],
        assumption: 'Pay frequency not confirmed: assuming ' + plural(n, 'paycheck') + ' a month for ' + name + '.',
        perYear: null
      };
    }

    // A frequency that is entered but explicitly marked unknown is still a guess; say so.
    const unconfirmed = stream.frequencyStatus === 'unknown'
      ? 'Pay frequency not confirmed: assuming ' + freq + ' pay for ' + name + '.'
      : null;

    if (timing === 'average') {
      return { count: PER_YEAR[freq] / 12, basis: 'average', dates: [], assumption: unconfirmed, perYear: PER_YEAR[freq] };
    }
    if (timing === 'conservative') {
      return { count: TYPICAL[freq], basis: 'typical', dates: [], assumption: unconfirmed, perYear: null };
    }

    const dates = paydays(stream, month);
    if (dates === null) {
      // No anchor date / payday entered: fall back to a typical month and say why.
      const n = TYPICAL[freq];
      const what = freq === 'monthly' ? 'payday of the month' : 'payday date';
      const text = 'No ' + what + ' entered for ' + name + ': counting a typical month of ' +
        plural(n, 'paycheck') + ' (' + freq + ') instead of actual paydays.';
      return { count: n, basis: 'typical', dates: [], assumption: unconfirmed ? unconfirmed + ' ' + text : text, perYear: null };
    }
    return { count: dates.length, basis: 'actual', dates, assumption: unconfirmed, perYear: null };
  }

  /**
   * What one per-paycheck amount means per month under each frequency. Used to show the
   * consequences of an unconfirmed frequency (e.g. biweekly vs semimonthly differ by two
   * paychecks a year).
   * @param {number|null} perPaycheckCents
   * @returns {Array<{frequency, label, perYear, typicalChecks, typicalMonthCents, highMonthChecks,
   *   highMonthCents, averageMonthCents, annualCents, extraChecksPerYear, note}>}
   *   highMonth* describe the fullest month (5-check weekly, 3-check biweekly); null when every
   *   month is the same. All cents are null when perPaycheckCents is null.
   */
  function frequencyTable(perPaycheckCents) {
    if (perPaycheckCents !== null && perPaycheckCents !== undefined && !E.money.isCents(perPaycheckCents)) {
      fail('Per-paycheck amount must be integer cents or null.', 'perPaycheckCents');
    }
    const per = perPaycheckCents === undefined ? null : perPaycheckCents;
    const times = n => (per === null ? null : per * n);
    return FREQUENCIES.map(freq => {
      const perYear = PER_YEAR[freq];
      const typical = TYPICAL[freq];
      const most = MOST_IN_MONTH[freq];
      const extra = perYear - typical * 12;
      const hasHigh = most > typical;
      let note;
      if (freq === 'weekly') note = 'Most months have 4 paychecks; about 4 months a year have 5 (52 a year, 53 in some years).';
      else if (freq === 'biweekly') note = 'Most months have 2 paychecks; 2 months a year have 3 (26 a year, 27 in some years).';
      else if (freq === 'semimonthly') note = 'Always 2 paychecks a month (24 a year); no extra paycheck months.';
      else note = 'Always 1 paycheck a month (12 a year).';
      return {
        frequency: freq,
        label: LABELS[freq],
        perYear,
        typicalChecks: typical,
        typicalMonthCents: times(typical),
        highMonthChecks: hasHigh ? most : null,
        highMonthCents: hasHigh ? times(most) : null,
        averageMonthCents: per === null ? null : E.money.divide(per * perYear, 12),
        annualCents: times(perYear),
        extraChecksPerYear: extra,
        note
      };
    });
  }

  E.schedule = {
    FREQUENCIES,
    TIMINGS,
    PER_YEAR,
    TYPICAL,
    LABELS,
    DEFAULT_ASSUMED_PER_MONTH,
    paydays,
    count,
    perMonth,
    frequencyTable,
    activeIn
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
