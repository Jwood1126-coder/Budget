'use strict';
/*
 * Data review: queues of transactions that need a human decision (uncertain categories,
 * mixed-retail purchases, possible duplicates, unpaired transfers, reimbursements, business
 * charges, spending spikes, coverage gaps) and the edit-record helper that keeps an audit trail.
 *
 * Nothing here changes what counts: decisions are stored as ledger edits and applied by
 * ledger.applyEdits. Possible duplicates are only ever suggested, never removed automatically.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const EDIT_FIELDS = ['category', 'kind', 'subtype', 'splits', 'duplicate', 'reimbursement', 'business', 'planningBaseline', 'person', 'note'];
  /** Fields that change what a transaction counts as; a reason keeps the audit trail useful. */
  const REASON_REQUIRED = ['category', 'kind', 'splits'];
  const ENUMS = {
    duplicate: ['exclude', 'keep'],
    reimbursement: ['pending', 'confirmed', 'not_reimbursed'],
    business: ['pending', 'business', 'household'],
    planningBaseline: ['exclude', 'include'],
    person: ['p1', 'p2', 'none']
  };
  const DUPLICATE_DAYS = 3;
  const DUPLICATE_SIMILARITY = 0.6;
  const SPIKE_DEFAULTS = { minCents: 50000, multiple: 3, window: 6, includeAnnual: false };
  /** A spike that recurs this many months before or after (at ANNUAL_SHARE of its size) is an annual bill. */
  const ANNUAL_OFFSETS = [12, 11, 13, -12, -11, -13];
  const ANNUAL_SHARE = 0.5;

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** Options over defaults, ignoring undefined/null values (a blank setting keeps the default). */
  const withDefaults = (defaults, opts) => {
    const out = Object.assign({}, defaults);
    if (isObj(opts)) for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== null) out[k] = v;
    return out;
  };
  const nonEmpty = v => typeof v === 'string' && v.trim() !== '';
  const byDateThenId = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const flagsOf = t => (Array.isArray(t && t.flags) ? t.flags : []);

  /** The edit for a row: from ledgerEdits when given, otherwise the copy carried by applyEdits. */
  function editFor(t, edits) {
    if (isObj(edits)) return isObj(edits[t.id]) ? edits[t.id] : null;
    return isObj(t.edit) ? t.edit : null;
  }

  // ------------------------------------------------------------------ duplicates

  function tokens(text) {
    return new Set(E.util.normalizeText(text).split(' ').filter(Boolean));
  }

  /** Share of tokens two descriptions have in common, relative to the longer one (0..1). */
  function similarity(a, b) {
    const x = tokens(a), y = tokens(b);
    if (!x.size || !y.size) return 0;
    let shared = 0;
    for (const w of x) if (y.has(w)) shared += 1;
    return shared / Math.max(x.size, y.size);
  }

  /**
   * Possible duplicates: same account, same amount, at most 3 days apart and similar description
   * (token overlap >= 0.6) or the same merchant. Pairs where either row already has a duplicate
   * decision are left out. Suggestions only; nothing is excluded automatically.
   * @returns {{ids: string[], reason: string, confidence: 'high'|'medium'|'low', cents: number, daysApart: number, txns: object[]}[]}
   */
  function duplicateCandidates(txns, ledgerEdits) {
    const decided = t => {
      const e = editFor(t, ledgerEdits);
      return !!e && (e.duplicate === 'exclude' || e.duplicate === 'keep');
    };
    const groups = E.util.groupBy(txns, t => t.accountId + '|' + t.amountCents);
    const out = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const sorted = list.slice().sort(byDateThenId);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i], b = sorted[j];
          const days = E.dates.daysBetween(a.date, b.date);
          if (days > DUPLICATE_DAYS) break;
          if (a.id === b.id || decided(a) || decided(b)) continue;
          const sameText = E.util.normalizeText(a.description) === E.util.normalizeText(b.description);
          const sim = similarity(a.description, b.description);
          const sameMerchant = nonEmpty(a.merchant) && E.util.normalizeText(a.merchant) === E.util.normalizeText(b.merchant);
          if (!(sim >= DUPLICATE_SIMILARITY || sameMerchant)) continue;
          const confidence = sameText ? (days <= 1 ? 'high' : 'medium') : (sim >= 0.8 ? 'medium' : 'low');
          const apart = days === 0 ? 'on the same day' : days + (days === 1 ? ' day apart' : ' days apart');
          const how = sameText ? 'identical descriptions' : sim >= DUPLICATE_SIMILARITY ? 'similar descriptions' : 'the same merchant';
          out.push({
            ids: [a.id, b.id],
            reason: 'Same account and amount (' + E.money.format(Math.abs(a.amountCents)) + '), ' + apart + ', ' + how + '.',
            confidence,
            cents: Math.abs(a.amountCents),
            accountId: a.accountId,
            daysApart: days,
            txns: [a, b]
          });
        }
      }
    }
    // Newest first, then by both ids: a total order, so every engine lists pairs the same way.
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    return out.sort((p, q) => cmp(q.txns[0].date, p.txns[0].date) || cmp(p.ids[0], q.ids[0]) || cmp(p.ids[1], q.ids[1]));
  }

  // ------------------------------------------------------------------ reimbursements

  /**
   * Reimbursement candidates: each flagged charge with its matched deposit (via matchIds in either
   * direction) and the decision status (default 'pending'). A flagged deposit with no charge in the
   * data appears with chargeId null.
   * @returns {{chargeId: string|null, depositId: string|null, cents: number, status: string, charge: object|null, deposit: object|null}[]}
   */
  function reimbursementPairs(txns) {
    const byId = new Map(txns.map(t => [t.id, t]));
    const out = [];
    for (const p of E.ledger.reimbursementLinks(txns)) {
      const charge = p.chargeId ? byId.get(p.chargeId) : null;
      const deposit = p.depositId ? byId.get(p.depositId) : null;
      const sides = [charge, deposit].filter(Boolean);
      const decided = sides.map(t => t.reimbursementStatus).find(s => s) || null;
      const flagged = sides.some(t => flagsOf(t).includes('reimbursement_candidate'));
      if (!decided && !flagged) continue; // linked rows that nobody flagged as a reimbursement
      out.push({ chargeId: p.chargeId, depositId: p.depositId, cents: p.cents, status: decided || 'pending', charge, deposit });
    }
    return out;
  }

  // ------------------------------------------------------------------ transfers

  function coversDate(account, date) {
    return (account.coverage || []).some(r => r.start <= date && date <= r.end);
  }

  /** Is the missing side of an unpaired transfer expected to be absent? Explains why. */
  function transferExpectation(t, dataset) {
    // Once the household confirms the money was a reimbursement, there is no transfer to explain.
    if (t.reimbursementStatus === 'confirmed') {
      return { expected: true, reason: 'Confirmed as a reimbursement, so no matching transfer is expected.' };
    }
    if (t.pairId) return { expected: false, reason: 'Its paired transaction (' + t.pairId + ') is not in the data.' };
    if (t.kind === 'transfer' && t.subtype === 'contribution') {
      return { expected: true, reason: 'Contribution from a personal account that is not in the data, so no matching side is expected.' };
    }
    const others = (dataset.accounts || []).filter(a => a.id !== t.accountId);
    let candidates, what;
    if (t.kind === 'card_payment') {
      if (t.accountType === 'credit_card') {
        candidates = others.filter(a => a.type !== 'credit_card' && a.type !== 'loan');
        what = 'paying account';
      } else {
        candidates = others.filter(a => a.type === 'credit_card');
        what = 'credit card account';
      }
    } else if (t.subtype === 'savings' || t.subtype === 'investment') {
      if (t.accountType === 'savings') {
        candidates = others.filter(a => a.type !== 'savings');
        what = 'cash account';
      } else {
        candidates = others.filter(a => a.type === 'savings');
        what = t.subtype === 'investment' ? 'investment or savings account' : 'savings account';
      }
    } else {
      candidates = others;
      what = 'other household account';
    }
    if (!candidates.length) return { expected: true, reason: 'No ' + what + ' is in the data, so the other side is not expected.' };
    const covering = candidates.filter(a => coversDate(a, t.date));
    if (!covering.length) {
      return { expected: true, reason: 'The ' + what + ' export does not cover ' + E.dates.label(t.date) + ', so the other side is not expected.' };
    }
    return {
      expected: false,
      reason: 'No matching opposite ' + (t.kind === 'card_payment' ? 'payment' : 'transfer') + ' found in ' + covering.map(a => a.label).join(', ') + '.'
    };
  }

  // ------------------------------------------------------------------ spikes

  /**
   * Category-months well above their recent level: total >= minCents AND total >= multiple × the
   * average of up to `window` prior full months (at least 2 needed; a covered month without
   * activity counts as $0).
   *
   * An annual bill is not an unusual spike: when the same category has a total of at least half
   * of this month's total 12 months earlier (or 11/13, for payment dates that drift) in a fully
   * covered month, the category-month is annual. Later months count too (11–13 months after), so
   * the first payment of a yearly bill in the data is not listed either. Annual items are left out
   * unless `includeAnnual` is set, in which case they are returned with `annual: true`.
   * @returns {{month, category, totalCents, usualCents, ids, priorMonths, planningExcludedCents, annual: boolean, annualMatch: null|{month, cents}}[]} newest first
   */
  function spikes(txns, dataset, opts = {}) {
    const o = withDefaults(SPIKE_DEFAULTS, opts);
    const cache = new Map();
    const cov = m => {
      if (!cache.has(m)) cache.set(m, E.ledger.coverage(dataset, m));
      return cache.get(m);
    };
    const data = new Map();
    for (const t of txns) {
      if (t.excluded || t.kind !== 'spend') continue;
      const m = t.date.slice(0, 7);
      for (const p of E.ledger.partsOf(t)) {
        if (!data.has(m)) data.set(m, new Map());
        const cats = data.get(m);
        if (!cats.has(p.category)) cats.set(p.category, { cents: 0, planningExcludedCents: 0, ids: [] });
        const c = cats.get(p.category);
        c.cents += p.spendCents;
        if (t.planningExcluded) c.planningExcludedCents += p.spendCents;
        if (!c.ids.includes(t.id)) c.ids.push(t.id);
      }
    }
    const totalOf = (m, category) => (data.get(m) && data.get(m).get(category) ? data.get(m).get(category).cents : 0);
    /** The fully covered month 11–13 months away holding at least ANNUAL_SHARE of `cents`, or null. */
    const annualMatch = (month, category, cents) => {
      for (const k of ANNUAL_OFFSETS) {
        const m = E.months.add(month, -k);
        const other = totalOf(m, category);
        if (other > 0 && other >= cents * ANNUAL_SHARE && cov(m).status === 'full') return { month: m, cents: other };
      }
      return null;
    };
    const out = [];
    for (const [month, cats] of data) {
      const prior = E.months.range(E.months.add(month, -o.window), E.months.add(month, -1)).filter(m => cov(m).status === 'full');
      if (prior.length < 2) continue;
      for (const [category, v] of cats) {
        if (v.cents < o.minCents) continue;
        const sum = prior.reduce((s, m) => s + totalOf(m, category), 0);
        // Compare totals exactly (total × months >= multiple × sum) to avoid rounding the average.
        if (v.cents * prior.length < o.multiple * sum) continue;
        const match = annualMatch(month, category, v.cents);
        if (match && o.includeAnnual !== true) continue;
        out.push({
          month,
          category,
          totalCents: v.cents,
          usualCents: E.money.divide(sum, prior.length) || 0,
          ids: v.ids.slice(),
          priorMonths: prior,
          planningExcludedCents: v.planningExcludedCents,
          annual: match !== null,
          annualMatch: match
        });
      }
    }
    return out.sort((a, b) => (a.month > b.month ? -1 : a.month < b.month ? 1 : b.totalCents - a.totalCents));
  }

  // ------------------------------------------------------------------ queues

  /**
   * Everything the Review view lists, plus counts of items that still need a decision.
   * counts.transfers counts unpaired transfers whose other side should be in the data;
   * counts.reimbursements and counts.business count pending decisions.
   * `spikes` leaves out annual bills; they are listed separately in `annualSpikes` (marked
   * annual: true) and are not counted.
   */
  function queues(dataset, txns, ledgerEdits, opts = {}) {
    const edits = isObj(ledgerEdits) ? ledgerEdits : null;
    const editOf = t => editFor(t, edits);
    const live = txns.filter(t => t.excluded !== 'duplicate');
    const UNC = E.categories.UNCATEGORIZED, MIXED = E.categories.MIXED_RETAIL;

    const uncertain = live.filter(t => {
      const e = editOf(t);
      if (e && (e.category != null || e.splits != null || e.kind != null)) return false; // already decided
      // Rows the household decided not to count (reimbursed, business) need no category answer.
      if (t.excluded === 'reimbursed' || t.excluded === 'business') return false;
      return t.confidence === 'low' || flagsOf(t).includes('needs_category_review') || (t.kind === 'spend' && t.category === UNC);
    });

    const mixedRetail = live.filter(t => {
      if (t.kind !== 'spend' || t.excluded) return false;
      if (!(flagsOf(t).includes('mixed_retail') || t.category === MIXED || t.baseCategory === MIXED)) return false;
      const e = editOf(t);
      return !(e && e.category != null) && !t.splitApplied;
    });

    const duplicates = duplicateCandidates(txns, edits || undefined);

    const byId = new Map(txns.map(t => [t.id, t]));
    const paired = [];
    const unpaired = [];
    const seen = new Set();
    for (const t of live) {
      if (!(t.kind === 'transfer' || t.kind === 'card_payment' || flagsOf(t).includes('unpaired_transfer'))) continue;
      const other = t.pairId ? byId.get(t.pairId) : null;
      if (other) {
        const key = [t.id, other.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const [a, b] = t.amountCents <= other.amountCents ? [t, other] : [other, t]; // outflow side first
        paired.push({
          ids: [a.id, b.id],
          txns: [a, b],
          kind: t.kind,
          cents: Math.abs(a.amountCents),
          amountsMatch: a.amountCents + b.amountCents === 0,
          daysApart: Math.abs(E.dates.daysBetween(a.date, b.date))
        });
      } else {
        unpaired.push(Object.assign({}, t, transferExpectation(t, dataset)));
      }
    }

    const reimbursements = reimbursementPairs(txns);
    // Each item carries `status` (default 'pending') as well as the effective businessStatus.
    const business = live.filter(t => t.kind === 'spend' && (t.businessStatus != null || flagsOf(t).includes('business_candidate')))
      .map(t => Object.assign({}, t, { status: t.businessStatus || 'pending' }));
    // Annual bills are kept apart from spikes (not counted as items needing a decision).
    const spikeAll = spikes(txns, dataset, Object.assign({}, isObj(opts.spikes) ? opts.spikes : {}, { includeAnnual: true }));
    const spikeList = spikeAll.filter(s => !s.annual);
    const annualSpikes = spikeAll.filter(s => s.annual);

    const coverageGaps = [];
    for (const m of E.ledger.months(dataset)) {
      const c = E.ledger.coverage(dataset, m);
      if (c.status === 'full') continue;
      coverageGaps.push({
        month: m,
        status: c.status,
        coveredDays: c.coveredDays,
        totalDays: c.totalDays,
        overridden: c.overridden,
        note: c.note,
        missing: c.accounts.filter(a => a.coveredDays < a.totalDays)
          .map(a => ({ accountId: a.accountId, label: a.label, coveredDays: a.coveredDays, totalDays: a.totalDays, missingDays: a.missingDays }))
      });
    }

    const lastAt = e => {
      const h = Array.isArray(e.history) ? e.history : [];
      return h.length ? String(h[h.length - 1].at || '') : '';
    };
    const edited = txns
      .filter(t => editOf(t) !== null)
      .map(t => {
        const e = editOf(t);
        return Object.assign({}, t, { edit: E.util.clone(e), history: E.util.clone(Array.isArray(e.history) ? e.history : []) });
      })
      .sort((a, b) => (lastAt(a.edit) > lastAt(b.edit) ? -1 : lastAt(a.edit) < lastAt(b.edit) ? 1 : byDateThenId(b, a)));
    // Corrections whose transaction is no longer in the data (e.g. after a re-import) are listed,
    // not silently dropped.
    const orphanEdits = Object.keys(edits || {}).filter(id => isObj(edits[id]) && !byId.has(id)).map(id => ({ id, edit: E.util.clone(edits[id]) }));

    const counts = {
      uncertain: uncertain.length,
      mixedRetail: mixedRetail.length,
      duplicates: duplicates.length,
      transfers: unpaired.filter(u => !u.expected).length,
      transfersPaired: paired.length,
      transfersExpected: unpaired.filter(u => u.expected).length,
      reimbursements: reimbursements.filter(r => r.status === 'pending').length,
      business: business.filter(t => t.status === 'pending').length,
      spikes: spikeList.length,
      coverageGaps: coverageGaps.length,
      edited: edited.length,
      orphanEdits: orphanEdits.length
    };

    return {
      uncertain, mixedRetail, duplicates,
      transfers: { paired, unpaired },
      reimbursements, business, spikes: spikeList, annualSpikes, coverageGaps, edited, orphanEdits, counts
    };
  }

  // ------------------------------------------------------------------ edit records

  function checkValue(field, value) {
    const bad = message => new E.ValidationError(message, field);
    switch (field) {
      case 'category':
        if (!nonEmpty(value)) throw bad('Choose a category.');
        return value.trim();
      case 'kind':
        if (!E.ledger.KINDS.includes(value)) throw bad('Kind must be one of ' + E.ledger.KINDS.join(', ') + '.');
        return value;
      case 'subtype':
        if (!nonEmpty(value)) throw bad('Subtype must be text.');
        return value.trim();
      case 'splits':
        if (!Array.isArray(value) || value.length === 0) throw bad('A split needs at least one part.');
        return value.map((p, i) => {
          if (!isObj(p) || !nonEmpty(p.category)) throw bad('Split part ' + (i + 1) + ' needs a category.');
          if (!E.money.isCents(p.cents)) throw bad('Split part ' + (i + 1) + ' needs an amount in whole cents.');
          return { category: p.category.trim(), cents: p.cents };
        });
      case 'note':
        if (typeof value !== 'string') throw bad('A note must be text.');
        return value;
      default:
        if (!ENUMS[field].includes(value)) throw bad(field + ' must be one of ' + ENUMS[field].join(', ') + '.');
        return value;
    }
  }

  /**
   * Return a NEW edit with `field` set to `value` (null/undefined removes the field) and the change
   * appended to history as { at, field, from, to, reason }. Changing category, kind or splits
   * requires a non-blank reason. `at` is supplied by the caller (no clock here).
   */
  function editRecord(prevEdit, field, value, reason, at) {
    if (!EDIT_FIELDS.includes(field)) throw new E.ValidationError('Unknown edit field "' + field + '".', field);
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (REASON_REQUIRED.includes(field) && !why) {
      throw new E.ValidationError('Add a short reason for changing the ' + field + ', so the change can be understood later.', 'reason');
    }
    const prev = isObj(prevEdit) ? E.util.clone(prevEdit) : {};
    const history = Array.isArray(prev.history) ? prev.history : [];
    const removing = value === null || value === undefined;
    const next = removing ? null : checkValue(field, value);
    const from = prev[field] === undefined ? null : prev[field];

    const out = Object.assign({}, prev);
    if (removing) {
      delete out[field];
      if (field === 'category') delete out.categoryReason;
      if (field === 'kind') delete out.kindReason;
    } else {
      out[field] = next;
      if (field === 'category') out.categoryReason = why;
      if (field === 'kind') out.kindReason = why;
    }
    out.history = history.concat([{ at: at === undefined ? null : at, field, from: E.util.clone(from), to: E.util.clone(next), reason: why }]);
    return out;
  }

  E.review = { EDIT_FIELDS, REASON_REQUIRED, queues, duplicateCandidates, spikes, reimbursementPairs, editRecord, similarity };
})(typeof globalThis !== 'undefined' ? globalThis : this);
