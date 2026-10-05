'use strict';
// Helpers shared by the browser specs (tests/browser/*.spec.cjs). Not a spec itself: run.cjs only
// loads files ending in .spec.cjs.

/**
 * True when the page does not scroll sideways. Compared with the configured viewport width, not
 * window.innerWidth or clientWidth: under mobile emulation those grow to fit the overflow, so they
 * are checked against it too.
 */
const noHorizontalScroll = page => page.evaluate(
  w => document.scrollingElement.scrollWidth <= w + 1 && window.innerWidth <= w + 1,
  page.viewportSize().width);

/** A copy of the app's saved state as the page holds it now. */
const state = page => page.evaluate(() => window.HouseholdBudget.getState());

// ------------------------------------------------------------------ money as the page shows it
/** Whole dollars as the chart shows them: $1,234 and −$1,234. */
const whole = cents => (cents < 0 ? '−$' : '$') + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
/** Dollars with cents only when there are any, as the Plan dials and the headline show them. */
const amt = cents => (cents < 0 ? '−$' : '$') + (Math.abs(cents) % 100 ? (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(Math.abs(cents) / 100).toLocaleString('en-US'));
/** The same with a + on a positive amount. */
const signedAmt = cents => (cents > 0 ? '+' : '') + amt(cents);
/** What an exact-entry box holds: 2,222.02 / -1,236.48 / 250. */
const boxText = cents => (cents < 0 ? '-' : '') + Math.floor(Math.abs(cents) / 100).toLocaleString('en-US') + (Math.abs(cents) % 100 ? '.' + String(Math.abs(cents) % 100).padStart(2, '0') : '');
/** Dollars and cents with no sign handling, for amounts the page shows as positive: $1,234.50. */
const money = cents => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The first amount in a text ("$1,234", "−$12.50", "-$3") as cents, or null when there is none. */
const centsOf = text => { const m = /(−|-)?\$([\d,]+(?:\.\d\d)?)/.exec(text); return m ? (m[1] ? -1 : 1) * Math.round(Number(m[2].replace(/,/g, '')) * 100) : null; };
/** The first dollars-and-cents amount in a text ("$1,234.56", "−$12.00") as cents; throws when there is none. */
function cents(text) {
  const m = String(text).match(/([−-])?\$([\d,]+\.\d{2})/);
  if (!m) throw new Error('No amount in: ' + text);
  const v = Math.round(Number(m[2].replace(/,/g, '')) * 100);
  return m[1] ? -v : v;
}

module.exports = { noHorizontalScroll, state, whole, amt, signedAmt, boxText, money, centsOf, cents };
