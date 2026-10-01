'use strict';
/*
 * Shared primitives for the budget engine: integer-cent money, calendar months,
 * ISO dates and small utilities. Every engine module attaches itself to
 * globalThis.BudgetEngine so the same files run in the browser bundle and in
 * Node tests (require the files in src/manifest.json order).
 *
 * Conventions used throughout the engine:
 *   - Money is always an integer number of cents. `null` means "unknown", never zero.
 *   - Months are 'YYYY-MM' strings; dates are 'YYYY-MM-DD' strings (calendar dates, no time zone).
 *   - Pure functions only: nothing here touches the DOM, storage or the clock unless named so.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  class ValidationError extends Error {
    constructor(message, field) {
      super(message);
      this.name = 'ValidationError';
      this.field = field || null;
    }
  }

  // ---------------------------------------------------------------- money
  const MAX_INPUT_CENTS = 10_000_000_000; // $100 million: generous bound for any household input

  /** Round a finite dollar amount to integer cents without binary-float drift (1.005 -> 101). */
  function dollarsToCents(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new ValidationError('Amount must be a finite number.');
    const sign = n < 0 ? -1 : 1;
    const text = Math.abs(n).toFixed(6); // exact enough for any value we accept
    const [whole, frac = ''] = text.split('.');
    const cents = Number(whole) * 100 + Number((frac + '000').slice(0, 2));
    const roundUp = Number((frac + '000')[2]) >= 5;
    return sign * (cents + (roundUp ? 1 : 0)) || 0;
  }

  /**
   * Parse a bank-export amount string into signed integer cents.
   * Accepts "1,234.56", "$1,234.56", "-12.30", "(12.30)", "12.30-", "+5", " 7 ".
   * Returns null for blank input. Throws ValidationError for anything else.
   */
  function parseAmount(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return dollarsToCents(value);
    let s = String(value).trim();
    if (s === '') return null;
    let negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
    if (/-$/.test(s)) { negative = !negative; s = s.slice(0, -1).trim(); }
    if (/^[-+]/.test(s)) { if (s[0] === '-') negative = !negative; s = s.slice(1).trim(); }
    s = s.replace(/^\$/, '').replace(/,/g, '').trim();
    if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) throw new ValidationError('Not an amount: ' + String(value));
    const cents = dollarsToCents(Number(s));
    return negative ? -cents : cents;
  }

  /**
   * Convert an editable planning input (dollars, number or string) to cents.
   * Blank -> null (unknown). Negative, non-numeric or absurd values throw.
   */
  function inputToCents(value, { allowNegative = false, max = MAX_INPUT_CENTS, field } = {}) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
    let cents;
    try {
      cents = typeof value === 'number' ? dollarsToCents(value) : parseAmount(value);
    } catch (err) {
      throw new ValidationError('Enter an amount in dollars, such as 125 or 125.50.', field);
    }
    if (cents === null) return null;
    if (!allowNegative && cents < 0) throw new ValidationError('Enter an amount of $0 or more.', field);
    if (Math.abs(cents) > max) throw new ValidationError('Enter an amount below $' + (max / 100).toLocaleString('en-US') + '.', field);
    return cents;
  }

  function isCents(v) { return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER; }

  /** Format integer cents as US dollars. null -> fallback (default '—'). */
  function formatMoney(cents, { decimals = 2, signed = false, fallback = '—' } = {}) {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return fallback;
    const abs = Math.abs(cents) / 100;
    const body = abs.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    if (cents < 0) return '−' + body; // true minus sign for readability
    if (signed && cents > 0) return '+' + body;
    return body;
  }

  /** Divide cents and round half away from zero to an integer cent. */
  function divideCents(total, divisor) {
    if (total === null || divisor === null || !divisor) return null;
    const q = total / divisor;
    return q < 0 ? -Math.round(-q) : Math.round(q);
  }

  function sumCents(values) {
    let total = 0;
    for (const v of values) if (v !== null && v !== undefined) total += v;
    return total;
  }

  /** Sum that becomes null if any value is null (unknown contaminates the total). */
  function sumKnown(values) {
    let total = 0;
    for (const v of values) { if (v === null || v === undefined) return null; total += v; }
    return total;
  }

  // ---------------------------------------------------------------- months & dates
  const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
  const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function isMonth(m) { return typeof m === 'string' && MONTH_RE.test(m); }
  function monthIndex(m) {
    if (!isMonth(m)) return null;
    return Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
  }
  function monthFromIndex(i) {
    if (!Number.isInteger(i)) return null;
    const y = Math.floor(i / 12), mo = i - y * 12 + 1;
    return String(y).padStart(4, '0') + '-' + String(mo).padStart(2, '0');
  }
  function addMonths(m, n) { const i = monthIndex(m); return i === null ? null : monthFromIndex(i + n); }
  function monthsBetween(a, b) { const i = monthIndex(a), j = monthIndex(b); return i === null || j === null ? null : j - i; }
  /** Inclusive list of months from start to end. Empty when end < start. */
  function monthRange(start, end) {
    const i = monthIndex(start), j = monthIndex(end);
    if (i === null || j === null) return [];
    const out = [];
    for (let k = i; k <= j; k++) out.push(monthFromIndex(k));
    return out;
  }
  function daysInMonth(m) {
    const i = monthIndex(m);
    if (i === null) return null;
    const y = Math.floor(i / 12), mo = i % 12;
    return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  }
  function monthLabel(m, { long = false } = {}) {
    const i = monthIndex(m);
    if (i === null) return String(m ?? '');
    return (long ? MONTH_LONG : MONTH_NAMES)[i % 12] + ' ' + Math.floor(i / 12);
  }
  function monthOf(date) { return isDate(date) ? date.slice(0, 7) : null; }
  function monthStart(m) { return isMonth(m) ? m + '-01' : null; }
  function monthEnd(m) { return isMonth(m) ? m + '-' + String(daysInMonth(m)).padStart(2, '0') : null; }
  function calendarMonthNumber(m) { const i = monthIndex(m); return i === null ? null : (i % 12) + 1; }

  function isDate(d) {
    if (typeof d !== 'string' || !DATE_RE.test(d)) return false;
    return Number(d.slice(8, 10)) <= daysInMonth(d.slice(0, 7));
  }
  /** Days since 1970-01-01 for a calendar date (UTC arithmetic, no time zone drift). */
  function dayNumber(d) {
    if (!isDate(d)) return null;
    return Math.round(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86400000);
  }
  function fromDayNumber(n) {
    if (!Number.isInteger(n)) return null;
    return new Date(n * 86400000).toISOString().slice(0, 10);
  }
  function addDays(d, n) { const x = dayNumber(d); return x === null ? null : fromDayNumber(x + n); }
  function daysBetween(a, b) { const x = dayNumber(a), y = dayNumber(b); return x === null || y === null ? null : y - x; }
  /** 0 = Sunday ... 6 = Saturday */
  function weekday(d) { const n = dayNumber(d); return n === null ? null : ((n % 7) + 7 + 4) % 7; }
  function dateLabel(d) {
    if (!isDate(d)) return String(d ?? '');
    return MONTH_NAMES[Number(d.slice(5, 7)) - 1] + ' ' + Number(d.slice(8, 10)) + ', ' + d.slice(0, 4);
  }
  /** Clamp a day-of-month to the month's length (e.g. 31 in February -> 28/29). */
  function dateInMonth(m, day) {
    const dim = daysInMonth(m);
    if (dim === null) return null;
    return m + '-' + String(Math.min(Math.max(1, day), dim)).padStart(2, '0');
  }

  // ---------------------------------------------------------------- utilities
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  /** Deterministic 53-bit string hash (cyrb53) rendered as base-36. Used for stable ids. */
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  let uidCounter = 0;
  /** Non-deterministic id for user-created objects (scenarios, events, goals). */
  function uid(prefix = 'id') {
    uidCounter += 1;
    const rand = Math.floor(Math.random() * 1e9).toString(36);
    return prefix + '-' + Date.now().toString(36) + '-' + uidCounter.toString(36) + rand;
  }

  function groupBy(items, keyFn) {
    const map = new Map();
    for (const item of items) {
      const k = keyFn(item);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(item);
    }
    return map;
  }

  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function normalizeText(s) {
    return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  E.ValidationError = ValidationError;
  E.money = { MAX_INPUT_CENTS, dollarsToCents, parseAmount, inputToCents, isCents, format: formatMoney, divide: divideCents, sum: sumCents, sumKnown };
  E.months = { isMonth, index: monthIndex, fromIndex: monthFromIndex, add: addMonths, between: monthsBetween, range: monthRange, daysIn: daysInMonth, label: monthLabel, of: monthOf, start: monthStart, end: monthEnd, calendarNumber: calendarMonthNumber };
  E.dates = { isDate, dayNumber, fromDayNumber, addDays, daysBetween, weekday, label: dateLabel, inMonth: dateInMonth };
  E.util = { clone, hash, uid, groupBy, isPlainObject, normalizeText };
})(typeof globalThis !== 'undefined' ? globalThis : this);
