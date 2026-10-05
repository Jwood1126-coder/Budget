'use strict';
// Synthetic fixture builders shared by the engine unit tests: transaction rows, datasets, a plan
// with income streams, and the month-by-month flows cross-check. Every household, merchant, date
// and amount built here is invented. Each test file keeps thin local wrappers (its own id prefix,
// accounts and defaults) around these.
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();

/**
 * A row factory. Each call returns a function
 *   row(accountId, date, amountCents, fields = {})
 * that builds { id, accountId, date, description, amountCents, kind: 'spend', category: 'Groceries' }
 * with `fields` merged over it. Ids are `prefix` + a counter padded to `pad` digits, unique per
 * factory. `description` is a string or a function of the counter.
 */
function rowMaker({ prefix, pad = 5, description = 'SAMPLE ROW' }) {
  let seq = 0;
  return function row(accountId, date, amountCents, fields = {}) {
    seq += 1;
    return Object.assign({
      id: prefix + String(seq).padStart(pad, '0'),
      accountId,
      date,
      description: typeof description === 'function' ? description(seq) : description,
      amountCents,
      kind: 'spend',
      category: 'Groceries',
    }, fields);
  };
}

/** Links two rows of one transfer (money out, money in) through pairId; returns [out, inn]. */
function pair(out, inn) {
  out.pairId = inn.id;
  inn.pairId = out.id;
  return [out, inn];
}

/** A raw schema-2 dataset of invented data (`extra` merged over it). */
function rawDataset({ datasetId, accounts, transactions = [], ...extra }) {
  return Object.assign({ schemaVersion: 2, datasetId, isSynthetic: true, accounts, transactions }, extra);
}

/** The same, normalized by ledger.normalizeDataset. */
const dataset = opts => E.ledger.normalizeDataset(rawDataset(opts));

/**
 * Joint checking ('chk'), savings ('sav') and card ('card') accounts. `coverage` applies to all
 * three unless `chk`, `sav` or `card` give one of them its own; `cardExtra` is merged into the card.
 */
function jointAccounts({ coverage, chk = coverage, sav = coverage, card = coverage, cardExtra = {} } = {}) {
  return [
    { id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', coverage: chk },
    { id: 'sav', label: 'Joint savings', type: 'savings', scope: 'joint', coverage: sav },
    Object.assign({ id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', coverage: card }, cardExtra),
  ];
}

/** A paycheck income stream: semimonthly on the 15th and the last day, confirmed (fields override). */
const paycheck = (fields = {}) => Object.assign({
  kind: 'paycheck', personId: 'p1', frequency: 'semimonthly', frequencyStatus: 'confirmed', semimonthlyDays: [15, 31],
  status: 'confirmed', startMonth: null, endMonth: null,
}, fields);

/** A partner's transfer into joint: schedule not known yet (2 a month assumed), observed (fields override). */
const contribution = (fields = {}) => Object.assign({
  kind: 'contribution', personId: 'p2', netPerPaycheckCents: null, frequency: 'unknown', frequencyStatus: 'unknown',
  assumedPerMonthIfUnknown: 2, status: 'observed', startMonth: null, endMonth: null,
}, fields);

/** state.plan for two invented partners with empty lists (`extra` merged over it). */
const plan = (extra = {}) => Object.assign({
  people: [{ id: 'p1', name: 'Alex' }, { id: 'p2', name: 'Sam' }],
  incomes: [], bills: [], targets: [], goals: [], debts: [], personalSpending: [],
  settings: { incomeTiming: 'conservative' },
}, extra);

/**
 * Money in, out and saved per month for the joint accounts, worked out with ledger.summarize and
 * ledger.measure (the app's counting rules), independently of flows' roles: a cross-check for
 * flows.breakdown, which must agree to the cent. Full months only (other months are null).
 *   in = income + contributions; out = spending (after refunds) + debt payments + purchases marked
 *   business (they still left the account); saved = net to savings and investments.
 * `planning: true` leaves out rows excluded from the planning baseline; with `attribute`
 * (balances.incomeAttribution), `bySource: { p1, p2, other }` splits `inCents`.
 */
function monthlyFlows(txns, ds, { months, coverageMap, planning = false, attribute = null } = {}) {
  const list = months || E.ledger.months(ds);
  const cov = coverageMap || E.ledger.coverageMap(ds);
  const byMonth = new Map(list.map(m => [m, []]));
  // Excluded rows are kept here: summarize() skips them, but business purchases still left the account.
  for (const t of E.ledger.filter(txns, { scope: 'joint', includeExcluded: true })) {
    const m = t.date.slice(0, 7);
    if (byMonth.has(m)) byMonth.get(m).push(t);
  }
  return list.map(m => {
    const status = cov[m] ? cov[m].status : 'none';
    if (status !== 'full') return { month: m, coverage: status, inCents: null, outCents: null, savedCents: null, leftCents: null, ...(attribute ? { bySource: null } : {}) };
    const rows = byMonth.get(m).filter(t => !(planning && t.planningExcluded));
    const s = E.ledger.summarize(rows);
    let business = 0;
    for (const t of rows) if (t.excluded === 'business' && t.kind === 'spend') business += 0 - t.amountCents;
    const inCents = s.incomeCents + s.contributionsCents;
    const outCents = s.spendingCents + s.debtPaymentsCents + business;
    const savedCents = s.savedNetCents;
    const out = { month: m, coverage: status, inCents, outCents, savedCents, leftCents: inCents - outCents - savedCents, businessCents: business };
    if (attribute) {
      const by = { p1: 0, p2: 0, other: 0 };
      for (const t of rows) {
        const v = E.ledger.measure(t);
        const cents = v.incomeCents + v.contributionCents;
        if (cents) by[attribute(t) || 'other'] += cents;
      }
      out.bySource = by;
    }
    return out;
  });
}

/** Freezes an object graph, so a test fails if the code under test mutates its input. */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

module.exports = { E, rowMaker, pair, rawDataset, dataset, jointAccounts, paycheck, contribution, plan, monthlyFlows, deepFreeze };
