'use strict';
/*
 * UI primitives shared by every view: HTML escaping, number/date formatting and tiny DOM
 * helpers. Views render HTML strings (always escaped through `esc`) and the app wires events
 * by delegation, so there is no framework and no per-element listener bookkeeping.
 */
(function (root) {
  const UI = root.BudgetUI || (root.BudgetUI = {});
  const E = root.BudgetEngine;

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  /** Escape any value for safe inclusion in HTML text or a quoted attribute. */
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
  }

  /** Build an attribute string from an object; false/null/undefined values are omitted. */
  function attrs(obj) {
    return Object.entries(obj || {})
      .filter(([, v]) => v !== false && v !== null && v !== undefined)
      .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
      .join('');
  }

  const $ = (sel, scope) => (scope || document).querySelector(sel);
  const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));

  // ------------------------------------------------------------------ formatting
  const fmt = {
    /** $1,234.56 ; null -> fallback. `whole: true` drops cents for large summary figures. */
    money(cents, { whole = false, signed = false, fallback = 'Unknown' } = {}) {
      return E.money.format(cents, { decimals: whole ? 0 : 2, signed, fallback });
    },
    /** Signed difference such as +$120 or −$35, for "vs usual" columns. */
    diff(cents, { whole = false, fallback = '—' } = {}) {
      if (cents === null || cents === undefined) return fallback;
      if (cents === 0) return E.money.format(0, { decimals: whole ? 0 : 2 });
      return E.money.format(cents, { decimals: whole ? 0 : 2, signed: true });
    },
    pct(p, { fallback = '—', signed = true } = {}) {
      if (p === null || p === undefined || !Number.isFinite(p)) return fallback;
      const r = Math.round(p);
      return (signed && r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r) + '%';
    },
    month: m => E.months.label(m),
    monthLong: m => E.months.label(m, { long: true }),
    /** 'YYYY-MM' or 'YYYY-MM..YYYY-MM' to a readable period. */
    period(p) {
      if (!p) return 'All months';
      const [a, b] = String(p).split('..');
      if (!b || a === b) return E.months.label(a, { long: true });
      return E.months.label(a) + ' – ' + E.months.label(b);
    },
    date: d => E.dates.label(d),
    count(n, singular, plural) {
      return n.toLocaleString('en-US') + ' ' + (n === 1 ? singular : plural || singular + 's');
    },
    number: n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US')),
  };

  /** Convert cents to the dollar string shown inside an <input> (no symbols, no commas). */
  function centsToInput(cents) {
    if (cents === null || cents === undefined) return '';
    const neg = cents < 0;
    const abs = Math.abs(cents);
    const s = Math.floor(abs / 100) + (abs % 100 ? '.' + String(abs % 100).padStart(2, '0') : '');
    return (neg ? '-' : '') + s;
  }

  /** Stable DOM id from arbitrary text (paths, category names). */
  function domId(prefix, text) {
    return prefix + '-' + String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + E.util.hash(String(text)).slice(0, 4);
  }

  UI.dom = { esc, attrs, $, $$, centsToInput, domId };
  UI.fmt = fmt;
})(typeof globalThis !== 'undefined' ? globalThis : this);
