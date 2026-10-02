'use strict';
/*
 * Ledger: dataset normalization (schema v2 and the legacy v1 format), user edits, the counting
 * rules (`measure` is the single source of truth for what counts as spending, income, saving…),
 * filters, groupings and month coverage.
 *
 * The dataset is immutable: user corrections live in `ledgerEdits` and are layered on by
 * `applyEdits`, which returns new "effective" transaction objects.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const KINDS = ['spend', 'income', 'transfer', 'card_payment', 'debt_payment'];
  const SUBTYPES = {
    income: ['payroll', 'interest', 'reimbursement', 'other'],
    transfer: ['savings', 'contribution', 'internal', 'investment'],
    debt_payment: ['loan', 'store_card', 'other']
  };
  const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'loan', 'other'];
  const SCOPES = ['joint', 'personal'];
  const CONFIDENCE = ['high', 'medium', 'low'];
  const COVERAGE_STATUS = ['full', 'partial', 'none'];
  const EXCLUSION_REASONS = ['duplicate', 'reimbursed', 'business', 'what_if'];
  const REIMBURSEMENT_STATUS = ['pending', 'confirmed', 'not_reimbursed'];
  const BUSINESS_STATUS = ['pending', 'business', 'household'];
  /** Account types whose exports must be present for a month's *spending* to be complete. */
  const SPENDING_ACCOUNT_TYPES = ['checking', 'credit_card', 'other'];
  const KNOWN_FLAGS = ['mixed_retail', 'needs_category_review', 'reimbursement_candidate', 'business_candidate',
    'duplicate_candidate', 'unpaired_transfer', 'pending', 'fee', 'refund'];

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const nonEmpty = v => typeof v === 'string' && v.trim() !== '';
  const byDateThenId = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  function fail(message, field) {
    return new E.ValidationError(message, field);
  }

  // ------------------------------------------------------------------ legacy (v1) conversion

  /** True when `raw` looks like the earlier (v1) normalized dataset. */
  function isLegacy(raw) {
    if (!isObj(raw) || raw.schemaVersion === 2) return false;
    return Array.isArray(raw.sources) || Array.isArray(raw.monthly) || isObj(raw.quarter);
  }

  function legacySubtype(kind, t) {
    const text = [t.incomeType, t.category, t.sourceCategory, t.merchant, t.description].filter(Boolean).join(' ').toLowerCase();
    if (kind === 'income') {
      if (/payroll/.test(text)) return 'payroll';
      if (/interest/.test(text)) return 'interest';
      if (/reimburs/.test(text)) return 'reimbursement';
      return 'other';
    }
    if (kind === 'transfer') {
      // v1 had no transfer subtype; the label is the only evidence of a savings move.
      if (/saving/.test(text)) return 'savings';
      if (/contribution/.test(text)) return 'contribution';
      return 'internal';
    }
    if (kind === 'debt_payment') {
      if (/store/.test(text)) return 'store_card';
      if (/loan/.test(text)) return 'loan';
      return 'other';
    }
    return null;
  }

  /**
   * Convert a v1 dataset into the v2 shape (not yet validated or defaulted).
   * v1 spending rows store purchases as positive cents; v2 stores signed account flow.
   */
  function convertLegacy(raw) {
    const notes = ['Converted from the earlier (v1) dataset format.'];
    if (nonEmpty(raw.coverageNote)) notes.push(raw.coverageNote);
    const sources = Array.isArray(raw.sources) ? raw.sources : [];
    const accounts = sources.filter(isObj).map(s => ({
      id: s.id,
      label: nonEmpty(s.label) ? s.label : s.id,
      type: 'other',
      scope: 'joint',
      ownerId: null,
      paidInFull: false,
      coverage: E.dates.isDate(s.start) && E.dates.isDate(s.end) ? [{ start: s.start, end: s.end }] : []
    }));
    const accountIds = new Set(accounts.map(a => a.id));

    const rows = Array.isArray(raw.transactions) ? raw.transactions : null;
    const transactions = rows === null ? raw.transactions : rows.map(t => {
      if (!isObj(t)) return t; // validation reports it
      const accountId = t.source ?? t.accountId;
      // A row whose source is missing from `sources` gets a placeholder account (no coverage dates),
      // so no transaction is dropped silently; the note tells the user why.
      if (typeof accountId === 'string' && accountId && !accountIds.has(accountId)) {
        accountIds.add(accountId);
        accounts.push({ id: accountId, label: accountId, type: 'other', scope: 'joint', ownerId: null, paidInFull: false, coverage: [] });
        notes.push('Legacy source "' + accountId + '" was not listed in sources; added without coverage dates.');
      }
      let kind = t.kind;
      let subtype = null;
      if (kind === 'investment') { kind = 'transfer'; subtype = 'investment'; }
      else if (KINDS.includes(kind)) subtype = legacySubtype(kind, t);

      let amountCents = t.amountCents;
      if (Number.isInteger(amountCents)) {
        if (kind === 'spend') {
          amountCents = 0 - amountCents; // purchases positive in v1 -> money leaving the account
        } else {
          const magnitude = Math.abs(amountCents);
          let direction = t.direction;
          if (direction !== 'inbound' && direction !== 'outbound') direction = kind === 'income' ? 'inbound' : 'outbound';
          amountCents = direction === 'outbound' ? 0 - magnitude : magnitude;
        }
      }

      const v1Flags = Array.isArray(t.flags) ? t.flags.filter(f => typeof f === 'string') : [];
      const flags = [];
      for (const f of v1Flags) {
        flags.push('legacy:' + f);
        if (KNOWN_FLAGS.includes(f)) flags.push(f);
      }
      if (t.needsCategoryReview === true) flags.push('needs_category_review');
      if (kind === 'spend' && Number.isInteger(amountCents) && amountCents > 0) flags.push('refund');

      const description = nonEmpty(t.description) ? t.description : (nonEmpty(t.merchant) ? t.merchant : '');
      const evidence = isObj(t.classificationEvidence) && nonEmpty(t.classificationEvidence.summary) ? ' ' + t.classificationEvidence.summary : '';
      return {
        id: t.id,
        accountId,
        date: t.date,
        description,
        merchant: nonEmpty(t.merchant) ? t.merchant : description,
        amountCents,
        kind,
        subtype,
        category: nonEmpty(t.category) ? t.category : E.categories.UNCATEGORIZED,
        sourceCategory: nonEmpty(t.sourceCategory) ? t.sourceCategory : null,
        categoryReason: 'Category from the earlier app.' + evidence,
        confidence: CONFIDENCE.includes(t.confidence) ? t.confidence : 'medium',
        flags,
        pairId: nonEmpty(t.pairId) ? t.pairId : null,
        matchIds: Array.isArray(t.matchingTransactionIds) ? t.matchingTransactionIds.slice()
          : Array.isArray(t.matchIds) ? t.matchIds.slice() : [],
        sourceFile: nonEmpty(t.sourceFile) ? t.sourceFile : null,
        sourceRow: Number.isInteger(t.sourceRow) ? t.sourceRow : null,
        note: typeof t.note === 'string' ? t.note : ''
      };
    });

    const coverageOverrides = {};
    for (const m of Array.isArray(raw.monthly) ? raw.monthly : []) {
      if (isObj(m) && E.months.isMonth(m.month) && m.hasMainCardCoverage === false) {
        coverageOverrides[m.month] = {
          status: 'partial',
          note: 'Earlier app: main card not covered this month' + (nonEmpty(m.coverage) ? ' (' + m.coverage + ')' : '') + '.'
        };
      }
    }

    const references = [];
    const period = raw.defaultPeriod;
    if (isObj(raw.quarter) && Number.isInteger(raw.quarter.spendingCents) && isObj(period)
      && E.dates.isDate(period.start) && E.dates.isDate(period.end)) {
      references.push({
        id: 'legacy-quarter',
        label: 'Earlier app baseline total',
        start: period.start,
        end: period.end,
        spendingCents: raw.quarter.spendingCents,
        source: 'legacy dataset'
      });
    }

    return {
      schemaVersion: 2,
      datasetId: nonEmpty(raw.datasetId) ? raw.datasetId : 'legacy-' + (raw.isSynthetic ? 'sample' : 'private'),
      isSynthetic: raw.isSynthetic === true,
      generatedAt: E.dates.isDate(raw.asOfDate) ? raw.asOfDate : (E.dates.isDate(raw.generatedAt) ? raw.generatedAt : null),
      currency: nonEmpty(raw.currency) ? raw.currency : 'USD',
      accounts,
      transactions,
      coverageOverrides,
      importLog: [],
      references,
      notes
    };
  }

  // ------------------------------------------------------------------ validation

  function validateV2(ds) {
    const errors = [];
    const warnings = [];
    if (!isObj(ds)) return { errors: ['Dataset must be an object.'], warnings };
    if (ds.schemaVersion !== 2) errors.push('Unsupported schemaVersion ' + JSON.stringify(ds.schemaVersion) + ' (expected 2 or a legacy v1 dataset).');
    if (!nonEmpty(ds.datasetId)) errors.push('datasetId is required.');
    if (ds.currency !== undefined && ds.currency !== 'USD') warnings.push('Currency "' + ds.currency + '" is not USD; amounts are shown as dollars.');
    if (ds.generatedAt !== undefined && ds.generatedAt !== null && !E.dates.isDate(ds.generatedAt)) {
      warnings.push('generatedAt "' + ds.generatedAt + '" is not a YYYY-MM-DD date; ignored.');
    }

    const accountIds = new Set();
    if (!Array.isArray(ds.accounts)) {
      errors.push('accounts must be a list.');
    } else {
      ds.accounts.forEach((a, i) => {
        if (!isObj(a)) { errors.push('Account #' + (i + 1) + ' is not an object.'); return; }
        const name = nonEmpty(a.id) ? 'Account "' + a.id + '"' : 'Account #' + (i + 1);
        if (!nonEmpty(a.id)) errors.push(name + ' needs an id.');
        else if (accountIds.has(a.id)) errors.push('Duplicate account id "' + a.id + '".');
        else accountIds.add(a.id);
        if (a.type === undefined) warnings.push(name + ' has no type; treated as "other".');
        else if (!ACCOUNT_TYPES.includes(a.type)) errors.push(name + ': type "' + a.type + '" is not one of ' + ACCOUNT_TYPES.join(', ') + '.');
        if (a.scope === undefined) warnings.push(name + ' has no scope; treated as "joint".');
        else if (!SCOPES.includes(a.scope)) errors.push(name + ': scope "' + a.scope + '" must be joint or personal.');
        if (a.ownerId !== undefined && a.ownerId !== null && a.ownerId !== 'p1' && a.ownerId !== 'p2') {
          warnings.push(name + ': ownerId "' + a.ownerId + '" is not p1/p2; ignored.');
        }
        if (a.coverage !== undefined) {
          if (!Array.isArray(a.coverage)) errors.push(name + ': coverage must be a list of {start, end} ranges.');
          else a.coverage.forEach((r, j) => {
            if (!isObj(r) || !E.dates.isDate(r.start) || !E.dates.isDate(r.end)) {
              errors.push(name + ': coverage range #' + (j + 1) + ' needs valid start and end dates (YYYY-MM-DD).');
            } else if (r.start > r.end) {
              errors.push(name + ': coverage range #' + (j + 1) + ' ends (' + r.end + ') before it starts (' + r.start + ').');
            }
          });
        }
      });
    }

    const txnIds = new Set();
    if (!Array.isArray(ds.transactions)) {
      errors.push('transactions must be a list.');
    } else {
      ds.transactions.forEach((t, i) => {
        if (!isObj(t)) { errors.push('Transaction #' + (i + 1) + ' is not an object.'); return; }
        const name = 'Transaction ' + (nonEmpty(t.id) ? '"' + t.id + '"' : '#' + (i + 1));
        if (!nonEmpty(t.id)) errors.push(name + ' needs an id.');
        else if (txnIds.has(t.id)) errors.push('Duplicate transaction id "' + t.id + '".');
        else txnIds.add(t.id);
        if (!nonEmpty(t.accountId)) errors.push(name + ' has no accountId.');
        else if (Array.isArray(ds.accounts) && !accountIds.has(t.accountId)) errors.push(name + ': unknown account "' + t.accountId + '".');
        if (!E.dates.isDate(t.date)) errors.push(name + ': date ' + JSON.stringify(t.date) + ' is not a valid YYYY-MM-DD date.');
        if (!E.money.isCents(t.amountCents)) errors.push(name + ': amountCents must be an integer number of cents (got ' + JSON.stringify(t.amountCents) + ').');
        if (!KINDS.includes(t.kind)) errors.push(name + ': kind ' + JSON.stringify(t.kind) + ' is not one of ' + KINDS.join(', ') + '.');
        if (t.description !== undefined && typeof t.description !== 'string') errors.push(name + ': description must be text.');
        if (t.description === undefined && !nonEmpty(t.merchant)) errors.push(name + ' needs a description.');
        if (!nonEmpty(t.category)) warnings.push(name + ' has no category; treated as "' + E.categories.UNCATEGORIZED + '".');
        if (t.subtype !== undefined && t.subtype !== null) {
          const allowed = SUBTYPES[t.kind];
          if (typeof t.subtype !== 'string') errors.push(name + ': subtype must be text or null.');
          else if (allowed && !allowed.includes(t.subtype)) warnings.push(name + ': subtype "' + t.subtype + '" is not a known ' + t.kind + ' subtype.');
        }
        if (t.flags !== undefined && (!Array.isArray(t.flags) || t.flags.some(f => typeof f !== 'string'))) errors.push(name + ': flags must be a list of text labels.');
        if (t.matchIds !== undefined && (!Array.isArray(t.matchIds) || t.matchIds.some(f => typeof f !== 'string'))) errors.push(name + ': matchIds must be a list of transaction ids.');
        if (t.pairId !== undefined && t.pairId !== null && !nonEmpty(t.pairId)) errors.push(name + ': pairId must be a transaction id or null.');
        if (t.confidence !== undefined && !CONFIDENCE.includes(t.confidence)) warnings.push(name + ': confidence "' + t.confidence + '" is not high/medium/low; treated as medium.');
        if (t.sourceRow !== undefined && t.sourceRow !== null && !Number.isInteger(t.sourceRow)) warnings.push(name + ': sourceRow is not a whole number; ignored.');
      });
      // Second pass: links to other rows (needs every id first).
      for (const t of ds.transactions) {
        if (!isObj(t) || !nonEmpty(t.id)) continue;
        if (nonEmpty(t.pairId)) {
          if (t.pairId === t.id) warnings.push('Transaction "' + t.id + '" is paired with itself.');
          else if (!txnIds.has(t.pairId)) warnings.push('Transaction "' + t.id + '" is paired with "' + t.pairId + '", which is not in the data.');
        }
        if (Array.isArray(t.matchIds)) {
          for (const m of t.matchIds) if (typeof m === 'string' && !txnIds.has(m)) warnings.push('Transaction "' + t.id + '" refers to "' + m + '", which is not in the data.');
        }
      }
    }

    if (ds.coverageOverrides !== undefined && ds.coverageOverrides !== null) {
      if (!isObj(ds.coverageOverrides)) errors.push('coverageOverrides must be an object keyed by YYYY-MM.');
      else for (const [m, o] of Object.entries(ds.coverageOverrides)) {
        if (!E.months.isMonth(m)) errors.push('coverageOverrides key "' + m + '" is not a YYYY-MM month.');
        else if (!isObj(o) || !COVERAGE_STATUS.includes(o.status)) errors.push('coverageOverrides["' + m + '"] needs status full, partial or none.');
      }
    }

    if (ds.references !== undefined && ds.references !== null) {
      if (!Array.isArray(ds.references)) errors.push('references must be a list.');
      else ds.references.forEach((r, i) => {
        const name = 'Reference ' + (isObj(r) && nonEmpty(r.id) ? '"' + r.id + '"' : '#' + (i + 1));
        if (!isObj(r) || !nonEmpty(r.id)) errors.push(name + ' needs an id.');
        else {
          if (!E.dates.isDate(r.start) || !E.dates.isDate(r.end)) errors.push(name + ' needs valid start and end dates.');
          if (!E.money.isCents(r.spendingCents)) errors.push(name + ': spendingCents must be integer cents.');
        }
      });
    }
    return { errors, warnings };
  }

  /**
   * Check a dataset (v2, or legacy v1 after conversion) without throwing.
   * @returns {{errors: string[], warnings: string[]}}
   */
  function validateDataset(ds) {
    if (!isObj(ds)) return { errors: ['Dataset must be an object.'], warnings: [] };
    return validateV2(isLegacy(ds) ? convertLegacy(ds) : ds);
  }

  function summarizeErrors(errors) {
    const shown = errors.slice(0, 5).join(' ');
    return errors.length > 5 ? shown + ' (and ' + (errors.length - 5) + ' more problems)' : shown;
  }

  function normalizeAccount(a) {
    const coverage = (Array.isArray(a.coverage) ? a.coverage : [])
      .map(r => ({ start: r.start, end: r.end }))
      .sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
    return Object.assign({}, a, {
      id: a.id,
      label: nonEmpty(a.label) ? a.label : a.id,
      type: a.type === undefined ? 'other' : a.type,
      scope: a.scope === undefined ? 'joint' : a.scope,
      ownerId: a.ownerId === 'p1' || a.ownerId === 'p2' ? a.ownerId : null,
      paidInFull: a.paidInFull === true,
      coverage
    });
  }

  function normalizeTxn(t) {
    const description = typeof t.description === 'string' ? t.description : (nonEmpty(t.merchant) ? t.merchant : '');
    const flags = [];
    for (const f of Array.isArray(t.flags) ? t.flags : []) if (!flags.includes(f)) flags.push(f);
    const out = Object.assign({}, t, {
      id: t.id,
      accountId: t.accountId,
      date: t.date,
      description,
      merchant: nonEmpty(t.merchant) ? t.merchant : description,
      amountCents: t.amountCents,
      kind: t.kind,
      subtype: typeof t.subtype === 'string' ? t.subtype : null,
      category: nonEmpty(t.category) ? t.category : E.categories.UNCATEGORIZED,
      sourceCategory: typeof t.sourceCategory === 'string' ? t.sourceCategory : null,
      categoryReason: typeof t.categoryReason === 'string' ? t.categoryReason : '',
      confidence: CONFIDENCE.includes(t.confidence) ? t.confidence : 'medium',
      flags,
      pairId: nonEmpty(t.pairId) ? t.pairId : null,
      matchIds: Array.isArray(t.matchIds) ? t.matchIds.slice() : [],
      sourceFile: typeof t.sourceFile === 'string' ? t.sourceFile : null,
      sourceRow: Number.isInteger(t.sourceRow) ? t.sourceRow : null,
      note: typeof t.note === 'string' ? t.note : ''
    });
    // Optional: the bank's running balance after this row (whole cents), used for balances over time.
    if (out.balanceCents !== undefined && !Number.isSafeInteger(out.balanceCents)) delete out.balanceCents;
    return out;
  }

  /**
   * Validate and normalize a dataset (schema v2 or legacy v1, object or JSON text).
   * Never mutates the input. Throws ValidationError listing the first problems found.
   * @returns {object} Dataset (schema v2) with defaults filled and transactions sorted.
   */
  function normalizeDataset(raw) {
    let input = raw;
    if (typeof input === 'string') {
      try { input = JSON.parse(input.replace(/^\uFEFF/, '')); } catch (err) { throw fail('The dataset file is not valid JSON.'); }
    }
    if (!isObj(input)) throw fail('Dataset must be an object.');
    const src = E.util.clone(isLegacy(input) ? convertLegacy(input) : input);
    const { errors } = validateV2(src);
    if (errors.length) throw fail('The dataset has problems: ' + summarizeErrors(errors));

    const overrides = {};
    for (const [m, o] of Object.entries(isObj(src.coverageOverrides) ? src.coverageOverrides : {})) {
      overrides[m] = { status: o.status, note: typeof o.note === 'string' ? o.note : '' };
    }
    return {
      schemaVersion: 2,
      datasetId: src.datasetId,
      isSynthetic: src.isSynthetic === true,
      generatedAt: E.dates.isDate(src.generatedAt) ? src.generatedAt : null,
      currency: nonEmpty(src.currency) ? src.currency : 'USD',
      accounts: src.accounts.map(normalizeAccount),
      transactions: src.transactions.map(normalizeTxn).sort(byDateThenId),
      coverageOverrides: overrides,
      importLog: Array.isArray(src.importLog) ? src.importLog : [],
      references: Array.isArray(src.references) ? src.references : [],
      notes: Array.isArray(src.notes) ? src.notes.filter(n => typeof n === 'string') : []
    };
  }

  // ------------------------------------------------------------------ reimbursement links

  const isCharge = t => t.kind === 'spend' && t.amountCents < 0;
  // A reimbursement arrives as a deposit that is not itself spending (a merchant refund is already
  // netted inside spending) and not a card payment.
  const isDeposit = t => t.amountCents > 0 && t.kind !== 'spend' && t.kind !== 'card_payment';
  const flaggedReimbursement = t => Array.isArray(t.flags) && t.flags.includes('reimbursement_candidate');

  /**
   * Pair reimbursement charges with their deposits using `matchIds` in either direction.
   * Each deposit pays back at most one charge (prefer the exact amount, then the closest later date).
   * Flagged rows without a counterpart appear alone (depositId or chargeId null).
   * @returns {{chargeId: string|null, depositId: string|null, cents: number}[]}
   */
  function reimbursementLinks(txns) {
    const byId = new Map(txns.map(t => [t.id, t]));
    const links = new Map();
    const link = (a, b) => {
      if (a === b || !byId.has(a) || !byId.has(b)) return;
      if (!links.has(a)) links.set(a, new Set());
      if (!links.has(b)) links.set(b, new Set());
      links.get(a).add(b);
      links.get(b).add(a);
    };
    for (const t of txns) for (const m of Array.isArray(t.matchIds) ? t.matchIds : []) link(t.id, m);

    const used = new Set();
    const matched = new Map(); // chargeId -> deposit
    const charges = txns.filter(t => isCharge(t) && (links.has(t.id) || flaggedReimbursement(t))).sort(byDateThenId);
    const closest = c => (x, y) => {
      const dx = E.dates.daysBetween(c.date, x.date), dy = E.dates.daysBetween(c.date, y.date);
      const lx = dx < 0 ? 1 : 0, ly = dy < 0 ? 1 : 0; // deposits on or after the charge first
      if (lx !== ly) return lx - ly;
      if (Math.abs(dx) !== Math.abs(dy)) return Math.abs(dx) - Math.abs(dy);
      return x.id < y.id ? -1 : 1;
    };
    // Two passes so an exact-amount match is never taken by an earlier, different-amount charge.
    for (const exactOnly of [true, false]) {
      for (const c of charges) {
        if (matched.has(c.id)) continue;
        const candidates = [...(links.get(c.id) || [])]
          .map(id => byId.get(id))
          .filter(d => isDeposit(d) && !used.has(d.id) && (!exactOnly || d.amountCents === 0 - c.amountCents))
          .sort(closest(c));
        if (candidates.length) {
          matched.set(c.id, candidates[0]);
          used.add(candidates[0].id);
        }
      }
    }
    const pairs = [];
    for (const c of charges) {
      const deposit = matched.get(c.id) || null;
      if (!deposit && !flaggedReimbursement(c)) continue; // linked to something that is not a deposit
      pairs.push({ chargeId: c.id, depositId: deposit ? deposit.id : null, cents: 0 - c.amountCents });
    }
    for (const d of txns) {
      if (isDeposit(d) && flaggedReimbursement(d) && !used.has(d.id)) pairs.push({ chargeId: null, depositId: d.id, cents: d.amountCents });
    }
    return pairs;
  }

  // ------------------------------------------------------------------ edits

  function hasEditFields(edit) {
    return !!edit && Object.keys(edit).some(k => k !== 'history' && edit[k] !== undefined && edit[k] !== null);
  }

  /**
   * Check user splits against a row's spending. Valid only when every part has a category and
   * integer cents and the parts add up exactly to the spending (so nothing is created or lost).
   * @returns {{ok: boolean, message: string|null}}
   */
  function checkSplits(splits, spendCents) {
    if (!Array.isArray(splits) || splits.length === 0) return { ok: false, message: 'Split ignored: it has no parts.' };
    if (splits.some(p => !isObj(p) || !nonEmpty(p.category))) return { ok: false, message: 'Split ignored: every part needs a category.' };
    if (splits.some(p => !E.money.isCents(p.cents))) return { ok: false, message: 'Split ignored: every part needs an amount in whole cents.' };
    const total = splits.reduce((s, p) => s + p.cents, 0);
    if (total !== spendCents) {
      return { ok: false, message: 'Split ignored: parts add up to ' + E.money.format(total) + ' but the transaction is ' + E.money.format(spendCents) + '.' };
    }
    return { ok: true, message: null };
  }

  function combineReimbursement(statuses) {
    if (statuses.includes('confirmed')) return 'confirmed';
    if (statuses.includes('not_reimbursed')) return 'not_reimbursed';
    return 'pending';
  }

  /**
   * Layer user edits (and optional what-if toggles) over the dataset.
   * Returns NEW effective transaction objects; the dataset and edits are not modified.
   * A confirmed (or what-if) reimbursement whose deposit and charge differ removes only the
   * amount paid back: the smaller side is excluded and the larger keeps `reimbursedCents`.
   * @param {object} dataset normalized dataset
   * @param {object} ledgerEdits { [txnId]: Edit }
   * @param {{whatIf?: {excludePendingReimbursements?: boolean, excludeBusinessCandidates?: boolean}}} [opts]
   */
  function applyEdits(dataset, ledgerEdits, { whatIf } = {}) {
    const edits = isObj(ledgerEdits) ? ledgerEdits : {};
    const wi = isObj(whatIf) ? whatIf : {};
    const editOf = id => (hasOwn(edits, id) && isObj(edits[id]) ? edits[id] : null);
    const accounts = new Map((dataset.accounts || []).map(a => [a.id, a]));
    const base = dataset.transactions || [];
    const ids = new Set(base.map(t => t.id));

    // Pass 1: effective kind, subtype, category and account context.
    const rows = base.map(t => {
      const edit = editOf(t.id);
      const account = accounts.get(t.accountId) || null;
      const warnings = [];
      let kind = t.kind;
      if (edit && edit.kind !== undefined && edit.kind !== null) {
        if (KINDS.includes(edit.kind)) kind = edit.kind;
        else warnings.push('Kind edit "' + edit.kind + '" ignored: not a known kind.');
      }
      let subtype = t.subtype === undefined ? null : t.subtype;
      if (edit && edit.subtype !== undefined && edit.subtype !== null) subtype = edit.subtype;
      else if (kind !== t.kind) subtype = null; // the imported subtype belonged to the old kind
      let category = t.category;
      if (edit && edit.category !== undefined && edit.category !== null) {
        if (nonEmpty(edit.category)) category = edit.category.trim();
        else warnings.push('Blank category edit ignored.');
      }
      const baseNote = typeof t.note === 'string' ? t.note : '';
      // Whose money a deposit is: a household rule may name the person at import ('rule'); the
      // household's own correction wins ('edit', where 'none' means neither partner).
      const basePersonId = t.personId === 'p1' || t.personId === 'p2' ? t.personId : null;
      let personId = basePersonId;
      let personBasis = basePersonId ? 'rule' : null;
      if (edit && (edit.person === 'p1' || edit.person === 'p2' || edit.person === 'none')) {
        personId = edit.person === 'none' ? null : edit.person;
        personBasis = 'edit';
      }
      return Object.assign({}, t, {
        flags: Array.isArray(t.flags) ? t.flags.slice() : [],
        matchIds: Array.isArray(t.matchIds) ? t.matchIds.slice() : [],
        baseCategory: t.category,
        baseKind: t.kind,
        baseSubtype: t.subtype === undefined ? null : t.subtype,
        category,
        kind,
        subtype,
        note: edit && nonEmpty(edit.note) ? edit.note : baseNote,
        baseNote,
        personId,
        basePersonId,
        personBasis,
        edited: hasEditFields(edit),
        edit: edit ? E.util.clone(edit) : null,
        accountType: account ? account.type : null,
        accountScope: account ? account.scope : null,
        accountLabel: account ? account.label : t.accountId,
        accountOwnerId: account ? account.ownerId || null : null,
        excluded: null,
        planningExcluded: !!edit && edit.planningBaseline === 'exclude',
        reimbursementStatus: null,
        reimbursedCents: 0, // part of this row paid back by a smaller/larger linked reimbursement
        businessStatus: null,
        pairMissing: !!t.pairId && !ids.has(t.pairId),
        splitApplied: false,
        editWarnings: warnings,
        parts: []
      });
    });

    // Pass 2: reimbursement status per charge/deposit pair. A confirmation on either side counts
    // for both, so the charge leaves spending and the deposit leaves income together.
    const editedStatus = id => {
      const e = editOf(id);
      return e && REIMBURSEMENT_STATUS.includes(e.reimbursement) ? e.reimbursement : null;
    };
    const byId = new Map(rows.map(r => [r.id, r]));
    const reimb = new Map();
    for (const p of reimbursementLinks(rows)) {
      const sides = [p.chargeId, p.depositId].filter(Boolean);
      const own = sides.map(editedStatus).filter(Boolean);
      const candidate = sides.some(id => flaggedReimbursement(byId.get(id)));
      if (!candidate && own.length === 0) continue; // linked rows nobody flagged or decided on
      const status = combineReimbursement(own);
      // When the deposit and the charge differ, only the smaller amount was paid back. The
      // smaller side leaves the totals; the larger side keeps counting its unmatched remainder
      // (`partialCents` is the part that was paid back), so no real cost or income vanishes.
      let partialId = null, coveredCents = 0;
      if (p.chargeId && p.depositId) {
        const chargeCents = 0 - byId.get(p.chargeId).amountCents;
        const depositCents = byId.get(p.depositId).amountCents;
        coveredCents = Math.min(chargeCents, depositCents);
        if (chargeCents > depositCents) partialId = p.chargeId;
        else if (depositCents > chargeCents) partialId = p.depositId;
      }
      for (const id of sides) reimb.set(id, { status, candidate, partialCents: id === partialId ? coveredCents : 0 });
    }
    for (const r of rows) {
      if (reimb.has(r.id)) continue;
      const own = editedStatus(r.id);
      if (own || flaggedReimbursement(r)) reimb.set(r.id, { status: own || 'pending', candidate: flaggedReimbursement(r), partialCents: 0 });
    }

    // Pass 3: exclusions (first reason wins) and spending parts.
    for (const r of rows) {
      const edit = editOf(r.id);
      const info = reimb.get(r.id) || null;
      if (info) r.reimbursementStatus = info.status;
      const businessEdit = edit && BUSINESS_STATUS.includes(edit.business) ? edit.business : null;
      if (r.kind === 'spend' && (r.flags.includes('business_candidate') || businessEdit)) r.businessStatus = businessEdit || 'pending';

      // 'reimbursed' (decided) or 'what_if' (assumed) when this row is paid back / pays back.
      let reimbursing = null;
      if (info && info.status === 'confirmed') reimbursing = 'reimbursed';
      else if (wi.excludePendingReimbursements && info && info.candidate && info.status === 'pending') reimbursing = 'what_if';
      const partial = reimbursing && info.partialCents > 0;

      if (edit && edit.duplicate === 'exclude') r.excluded = 'duplicate';
      else if (reimbursing === 'reimbursed' && !partial) r.excluded = 'reimbursed';
      else if (r.businessStatus === 'business') r.excluded = 'business';
      else if (reimbursing === 'what_if' && !partial) r.excluded = 'what_if';
      else if (wi.excludeBusinessCandidates && r.businessStatus === 'pending' && r.flags.includes('business_candidate')) r.excluded = 'what_if';

      if (partial && !r.excluded) {
        r.reimbursedCents = info.partialCents;
        const whole = Math.abs(r.amountCents);
        const rest = E.money.format(whole - info.partialCents);
        const assumed = reimbursing === 'what_if' ? 'What-if: assuming ' : '';
        r.editWarnings.push(r.kind === 'spend'
          ? (assumed ? assumed + E.money.format(info.partialCents) + ' of this ' + E.money.format(whole) + ' charge is paid back'
            : 'Reimbursed ' + E.money.format(info.partialCents) + ' of this ' + E.money.format(whole) + ' charge') + '; the other ' + rest + ' still counts as spending.'
          : assumed + E.money.format(info.partialCents) + ' of this ' + E.money.format(whole) + ' deposit paid back a charge; the other ' + rest
            + (r.kind === 'income' ? ' still counts as income.' : r.subtype === 'contribution' ? ' still counts as a contribution.' : ' is counted as before.'));
      }

      const hasSplits = !!edit && edit.splits !== undefined && edit.splits !== null;
      if (r.kind !== 'spend') {
        if (hasSplits) r.editWarnings.push('Split ignored: only spending can be split.');
        continue;
      }
      const spendCents = 0 - r.amountCents;
      let parts = [{ category: r.category, spendCents }];
      if (hasSplits) {
        const check = checkSplits(edit.splits, spendCents);
        if (check.ok) {
          parts = edit.splits.map(p => ({ category: p.category.trim(), spendCents: p.cents }));
          r.splitApplied = true;
        } else {
          r.editWarnings.push(check.message);
        }
      }
      if (r.reimbursedCents) parts = shrinkParts(parts, spendCents - r.reimbursedCents);
      r.parts = r.excluded ? [] : parts;
    }
    return rows;
  }

  /**
   * Scale spending parts down to a smaller total (the part of a charge not paid back),
   * proportionally and in whole cents; the rounding remainder goes to the largest part so the
   * parts always add up exactly.
   */
  function shrinkParts(parts, total) {
    const full = parts.reduce((s, p) => s + p.spendCents, 0);
    if (parts.length === 1 || full === 0) return [{ category: parts[0].category, spendCents: total }];
    const out = parts.map(p => ({ category: p.category, spendCents: Math.round((p.spendCents / full) * total) }));
    let largest = 0;
    out.forEach((p, i) => { if (Math.abs(p.spendCents) > Math.abs(out[largest].spendCents)) largest = i; });
    out[largest].spendCents += total - out.reduce((s, p) => s + p.spendCents, 0);
    return out;
  }

  // ------------------------------------------------------------------ counting

  /**
   * The counting rules for one (effective) transaction. Excluded rows count as 0 everywhere;
   * a partly reimbursed row (`reimbursedCents` > 0) counts only the part not paid back.
   * @returns {{spendCents: number, incomeCents: number, debtCents: number, savedCents: number, contributionCents: number}}
   */
  function measure(txn) {
    const out = { spendCents: 0, incomeCents: 0, debtCents: 0, savedCents: 0, contributionCents: 0 };
    if (!txn || txn.excluded) return out;
    const a = txn.amountCents;
    // A partly reimbursed charge (or a deposit that only partly paid one back) counts its rest.
    const paidBack = Number.isInteger(txn.reimbursedCents) ? txn.reimbursedCents : 0;
    switch (txn.kind) {
      case 'spend':
        out.spendCents = 0 - a - paidBack; // refunds (positive flow) reduce spending
        break;
      case 'income':
        out.incomeCents = a - paidBack;
        break;
      case 'debt_payment':
        out.debtCents = 0 - a;
        break;
      case 'transfer':
        if (txn.subtype === 'contribution') {
          // Money a partner moves in from a personal account outside the data.
          if (txn.accountScope !== 'personal') out.contributionCents = a - paidBack;
        } else if (txn.subtype === 'savings' || txn.subtype === 'investment') {
          if (txn.accountType === 'savings') {
            // Count the savings side only when the cash side is not in the data; otherwise the
            // same move would be counted twice.
            if (!txn.pairId || txn.pairMissing) out.savedCents = a;
          } else {
            out.savedCents = 0 - a; // money leaving cash for savings is positive saving
          }
        }
        break;
      default:
        break; // card payments move money between accounts; the card's purchases are the spending
    }
    return out;
  }

  /** Spending parts of a row: the effective `parts`, or one part for a plain spend row. */
  function partsOf(txn) {
    if (Array.isArray(txn.parts)) return txn.parts;
    if (txn.excluded || txn.kind !== 'spend') return [];
    return [{ category: txn.category, spendCents: 0 - txn.amountCents }];
  }

  /**
   * Totals for a list of effective transactions. Refunds are reported as a positive amount and
   * spendingCents = purchasesCents − refundsCents. Card payments count only on the paying (non-card)
   * side, as a positive number. excludedCents is the spending the excluded rows would have added,
   * plus the paid-back part of partly reimbursed charges (excludedIncomeCents the same for income).
   * count = rows that count; excludedCount = rows excluded.
   */
  function summarize(txns) {
    const s = {
      spendingCents: 0, purchasesCents: 0, refundsCents: 0, incomeCents: 0, payrollCents: 0,
      contributionsCents: 0, savedNetCents: 0, debtPaymentsCents: 0, cardPaymentsCents: 0,
      excludedCents: 0, excludedIncomeCents: 0, excludedCount: 0, count: 0
    };
    for (const t of txns) {
      if (t.excluded) {
        s.excludedCount += 1;
        if (t.kind === 'spend') s.excludedCents += 0 - t.amountCents;
        else if (t.kind === 'income') s.excludedIncomeCents += t.amountCents;
        continue;
      }
      s.count += 1;
      const m = measure(t);
      // The reimbursed part of a partly reimbursed row is reported like an excluded amount.
      if (Number.isInteger(t.reimbursedCents) && t.reimbursedCents) {
        if (t.kind === 'spend') s.excludedCents += t.reimbursedCents;
        else if (t.kind === 'income') s.excludedIncomeCents += t.reimbursedCents;
      }
      if (t.kind === 'spend') {
        s.spendingCents += m.spendCents;
        if (m.spendCents > 0) s.purchasesCents += m.spendCents;
        else if (m.spendCents < 0) s.refundsCents += 0 - m.spendCents;
      }
      s.incomeCents += m.incomeCents;
      if (t.kind === 'income' && t.subtype === 'payroll') s.payrollCents += m.incomeCents;
      s.contributionsCents += m.contributionCents;
      s.savedNetCents += m.savedCents;
      s.debtPaymentsCents += m.debtCents;
      if (t.kind === 'card_payment' && t.accountType !== 'credit_card') s.cardPaymentsCents += 0 - t.amountCents;
    }
    return s;
  }

  // ------------------------------------------------------------------ filter & group

  const AMOUNT_QUERY = /^[-−]?\s*\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$|^[-−]?\s*\$?\s*\.\d{1,2}$/;

  function amountQueryCents(q) {
    if (!AMOUNT_QUERY.test(q)) return null;
    try {
      const cents = E.money.parseAmount(q.replace('−', '-').replace(/\s+/g, ''));
      return cents === null ? null : Math.abs(cents);
    } catch (err) {
      return null;
    }
  }

  /**
   * Filter effective transactions. All given criteria must match.
   * `query` is case-insensitive text search; an amount such as "486.60" or "$486.60" also matches
   * rows whose absolute amount is exactly that. Excluded rows are dropped unless includeExcluded.
   */
  function filter(txns, opts = {}) {
    const o = opts || {};
    const months = Array.isArray(o.months) ? new Set(o.months) : null;
    const accountIds = Array.isArray(o.accountIds) ? new Set(o.accountIds) : null;
    const kinds = Array.isArray(o.kinds) ? new Set(o.kinds) : null;
    const flags = Array.isArray(o.flags) ? o.flags : null;
    const query = typeof o.query === 'string' ? o.query.trim() : '';
    const needle = query.toLowerCase();
    const queryCents = query ? amountQueryCents(query) : null;
    return txns.filter(t => {
      if (!o.includeExcluded && t.excluded) return false;
      if (o.start && t.date < o.start) return false;
      if (o.end && t.date > o.end) return false;
      if (months && !months.has(t.date.slice(0, 7))) return false;
      if (accountIds && !accountIds.has(t.accountId)) return false;
      if (o.scope === 'joint' && t.accountScope !== 'joint') return false;
      if (o.scope === 'personal' && t.accountScope !== 'personal') return false;
      if (kinds && !kinds.has(t.kind)) return false;
      if (o.category) {
        // A split purchase belongs only to its parts' categories, so filter and group('category') agree.
        const inCategory = t.splitApplied
          ? partsOf(t).some(p => p.category === o.category)
          : t.category === o.category || partsOf(t).some(p => p.category === o.category);
        if (!inCategory) return false;
      }
      if (o.merchant && t.merchant !== o.merchant) return false;
      if (flags && !flags.every(f => (t.flags || []).includes(f))) return false;
      if (needle) {
        const amountHit = queryCents !== null && Math.abs(t.amountCents) === queryCents;
        if (!amountHit) {
          const hay = [t.merchant, t.description, t.category, t.sourceCategory, t.note, t.baseNote, t.accountLabel]
            .concat(partsOf(t).map(p => p.category))
            .filter(v => typeof v === 'string')
            .join('\n')
            .toLowerCase();
          if (!hay.includes(needle)) return false;
        }
      }
      return true;
    });
  }

  /**
   * Group counted spending. Category grouping uses parts, so split rows land in each part's
   * category. `planning: true` leaves out rows marked "exclude from planning".
   * @returns {{key: string, spendCents: number, count: number, ids: string[]}[]} months chronological, others by spend desc
   */
  function group(txns, by, { planning = false } = {}) {
    if (!['month', 'category', 'merchant', 'account'].includes(by)) throw fail('Cannot group by "' + by + '".', 'by');
    const map = new Map();
    const add = (key, cents, t, extra) => {
      if (!map.has(key)) map.set(key, Object.assign({ key, spendCents: 0, count: 0, ids: [] }, extra));
      const g = map.get(key);
      g.spendCents += cents;
      if (!g.ids.includes(t.id)) { g.ids.push(t.id); g.count += 1; }
    };
    for (const t of txns) {
      if (t.excluded || t.kind !== 'spend') continue;
      if (planning && t.planningExcluded) continue;
      const parts = partsOf(t);
      if (by === 'category') {
        for (const p of parts) add(p.category, p.spendCents, t, { group: E.categories.groupOf(p.category) });
        continue;
      }
      const cents = parts.reduce((s, p) => s + p.spendCents, 0);
      if (by === 'month') add(t.date.slice(0, 7), cents, t);
      else if (by === 'merchant') add(t.merchant || t.description, cents, t);
      else add(t.accountId, cents, t, { label: t.accountLabel || t.accountId });
    }
    const out = [...map.values()];
    if (by === 'month') return out.sort((a, b) => (a.key < b.key ? -1 : 1));
    return out.sort((a, b) => b.spendCents - a.spendCents || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // ------------------------------------------------------------------ months & coverage

  /** Every month from the earliest coverage start or transaction to the latest. */
  function months(dataset) {
    let first = null, last = null;
    const see = d => {
      if (!E.dates.isDate(d)) return;
      if (first === null || d < first) first = d;
      if (last === null || d > last) last = d;
    };
    for (const a of dataset.accounts || []) for (const r of a.coverage || []) { see(r.start); see(r.end); }
    for (const t of dataset.transactions || []) see(t.date);
    return first === null ? [] : E.months.range(first.slice(0, 7), last.slice(0, 7));
  }

  function accountDays(ranges, firstDay, totalDays) {
    const days = new Array(totalDays).fill(false);
    for (const r of ranges) {
      const s = Math.max(E.dates.dayNumber(r.start), firstDay);
      const e = Math.min(E.dates.dayNumber(r.end), firstDay + totalDays - 1);
      for (let d = s; d <= e; d++) days[d - firstDay] = true;
    }
    return days;
  }

  /**
   * Coverage of one month. For purpose 'spending' (default) only checking, credit-card and other
   * accounts are expected — a missing savings or loan export does not make spending incomplete.
   * An expected account is expected for every month between the earliest coverage start and the
   * latest coverage end among expected accounts; coveredDays counts days covered by ALL of them.
   * dataset.coverageOverrides win over the computed status (coveredDays stays the computed fact).
   */
  function coverage(dataset, month, { purpose = 'spending' } = {}) {
    if (!E.months.isMonth(month)) throw fail('Month must look like YYYY-MM (got ' + JSON.stringify(month) + ').', 'month');
    const totalDays = E.months.daysIn(month);
    const firstDay = E.dates.dayNumber(E.months.start(month));
    // An expected account with no export at all covers no day: its spending is unknown, so it
    // keeps months partial instead of being silently left out (which would count it as $0).
    const relevant = (dataset.accounts || []).filter(a => purpose === 'all' || SPENDING_ACCOUNT_TYPES.includes(a.type))
      .map(a => Object.assign({}, a, { coverage: Array.isArray(a.coverage) ? a.coverage : [] }));

    let spanStart = null, spanEnd = null;
    for (const a of relevant) for (const r of a.coverage) {
      if (spanStart === null || r.start < spanStart) spanStart = r.start;
      if (spanEnd === null || r.end > spanEnd) spanEnd = r.end;
    }
    const expected = spanStart !== null && month >= spanStart.slice(0, 7) && month <= spanEnd.slice(0, 7);

    const accounts = relevant.map(a => {
      const days = accountDays(a.coverage, firstDay, totalDays);
      const covered = days.filter(Boolean).length;
      return { accountId: a.id, label: a.label, type: a.type, coveredDays: covered, totalDays, missingDays: totalDays - covered, expected, days };
    });
    let coveredDays = 0, anyDay = false;
    if (expected) {
      for (let i = 0; i < totalDays; i++) {
        if (accounts.every(a => a.days[i])) coveredDays += 1;
        if (accounts.some(a => a.days[i])) anyDay = true;
      }
    }
    for (const a of accounts) delete a.days;

    const computedStatus = !expected || !anyDay ? 'none' : coveredDays === totalDays ? 'full' : 'partial';
    let note = '';
    if (computedStatus === 'none') note = 'No account export covers ' + E.months.label(month) + '.';
    else if (computedStatus === 'partial') {
      note = 'Not every account covers the whole month: ' + accounts.filter(a => a.coveredDays < totalDays)
        .map(a => a.label + ' covers ' + a.coveredDays + ' of ' + totalDays + ' days').join('; ') + '.';
    }
    const override = isObj(dataset.coverageOverrides) ? dataset.coverageOverrides[month] : null;
    const overridden = isObj(override) && COVERAGE_STATUS.includes(override.status);
    return {
      month,
      purpose,
      status: overridden ? override.status : computedStatus,
      computedStatus,
      overridden,
      coveredDays,
      totalDays,
      accounts,
      note: overridden ? (nonEmpty(override.note) ? override.note : 'Coverage set manually to ' + override.status + '.') : note
    };
  }

  /** Coverage for every month of the dataset, keyed by month. */
  function coverageMap(dataset, opts) {
    const out = {};
    for (const m of months(dataset)) out[m] = coverage(dataset, m, opts);
    return out;
  }

  /** The latest month whose (spending) coverage is full, or null. */
  function latestCompleteMonth(dataset, opts) {
    const list = months(dataset);
    for (let i = list.length - 1; i >= 0; i--) if (coverage(dataset, list[i], opts).status === 'full') return list[i];
    return null;
  }

  E.ledger = {
    KINDS, SUBTYPES, ACCOUNT_TYPES, SCOPES, EXCLUSION_REASONS, REIMBURSEMENT_STATUS, BUSINESS_STATUS,
    SPENDING_ACCOUNT_TYPES, KNOWN_FLAGS,
    isLegacy, normalizeDataset, validateDataset, applyEdits, measure, summarize, filter, group,
    months, coverage, coverageMap, latestCompleteMonth,
    partsOf, checkSplits, reimbursementLinks
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
