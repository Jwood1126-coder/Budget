'use strict';
/*
 * Saved state for the household budget (docs/ARCHITECTURE.md §3, §4, §6, §7 and §8,
 * BudgetEngine.state).
 *
 *   defaults    a complete, valid version-5 State built from the household profile
 *   sanitize    check a saved State field by field: keep what is valid, reset or drop what is
 *               not, and say so in a note that names the path. Keys this version does not know
 *               are kept as saved (a newer copy of the app may have saved them; §7)
 *   upgrades    changes to the format inside version 5 (V5_UPGRADES), run by sanitize
 *   ui.plan     one descriptor table (PLAN_UI) for the plan screen's settings; cleanPlanUi
 *   migrate     carry a budget saved by the earlier app (saved-state versions 1-4) over to v5
 *   workbooks   export/import the JSON file a household passes between devices
 *   scenarios   pure operations returning a new State; the baseline stays "the budget as is"
 *   paths       validated form writes, e.g. setPath(s, 'plan.bills[id=mortgage].monthlyCents', 141256)
 *   storage     load/save through a Storage-like object that is passed in (never a global)
 *
 * Money rules that apply throughout:
 *   - Amounts are integer cents. null means unknown and is never turned into $0. An invalid
 *     saved amount becomes unknown (null), not a guess.
 *   - Saved state wins over the household profile; the profile only fills what was never saved.
 *   - Nothing a household saved is dropped silently: every value that cannot be kept is named in
 *     the returned notes, and a migration also keeps its notes and a raw snapshot in meta.
 *   - No clock: timestamps arrive through an optional { now } argument (epoch otherwise).
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  // ------------------------------------------------------------------ constants

  const VERSION = 5;
  const STORAGE_PREFIX = 'household-budget:v5:';
  const LEGACY_PREFIX = 'sample-household-budget-v1-';
  const LEGACY_COPY_IDS = ['local-sample', 'local-private', 'hosted'];
  const WORKBOOK_FORMAT = 'household-budget-workbook';
  const BASELINE_ID = 'baseline';
  const BASELINE_NAME = 'Current budget';
  const BASELINE_DESCRIPTION = 'Your budget as it is now, with no planned changes.';
  const EPOCH = '1970-01-01T00:00:00.000Z';
  const NO_DATA_ID = 'no-data';
  const DEFAULT_PEOPLE_NAMES = ['Partner A', 'Partner B'];
  const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
  const TXN_KINDS = ['spend', 'income', 'transfer', 'card_payment', 'debt_payment'];
  // The plan screen's vocabulary (people, dial keys, the retired card/bank dials, spending groups
  // and dials, planned-change kinds and groups, Trends series, the scalar choices and their
  // defaults) is defined once in plan-settings.js and shared with BudgetEngine.timeline.
  const PS = E.planSettings;
  const { PEOPLE, DIAL_KEYS, RETIRED_DIALS, SPEND_GROUPS, SPEND_DIALS, CHANGE_KINDS, CHANGE_GROUPS, TREND_SERIES } = PS;

  const LIMITS = Object.freeze({
    label: 80, note: 500, categoryKey: 80, id: 80, txnId: 200, datasetId: 200, route: 1000,
    scenarios: 20, events: 200, incomes: 12, bills: 60, savings: 30, debts: 30, personal: 2,
    compareIds: 3, targets: 200, references: 100, checklist: 200, dismissed: 500,
    ledgerEdits: 50000, history: 200, splits: 50, migrationNotes: 200, balanceAccounts: 30,
    planDials: 20, planRows: 500, planHidden: 40, planGroups: 300, groupKey: 120, planIrregular: 1000,
    planChanges: 100, planTrendSeries: 16,
    legacySnapshot: 200000, workbookChars: 25000000
  });

  // ------------------------------------------------------------------ small helpers

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  const clone = v => E.util.clone(v);
  const nonEmpty = v => typeof v === 'string' && v.trim() !== '';
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

  function fail(message, field) { throw new E.ValidationError(message, field); }
  /** "__proto__" cannot be stored as a plain-object key (assigning it changes the prototype). */
  function isSafeKey(k) { return typeof k === 'string' && k !== '__proto__'; }
  /** Own-property lookup, so names like "constructor" never resolve to Object.prototype members. */
  function lookup(map, key) { return has(map, key) ? map[key] : undefined; }
  function isValidId(v) { return typeof v === 'string' && v.length <= LIMITS.id && ID_RE.test(v); }
  function isIso(v) { return typeof v === 'string' && v.length <= 40 && ISO_RE.test(v) && E.dates.isDate(v.slice(0, 10)); }
  function money(c) { return c === null || c === undefined ? 'no amount' : E.money.format(c); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  /** Short, safe rendering of any saved value for a note (longer for whole dropped entries). */
  function preview(v, max = 60) {
    let s;
    try { s = JSON.stringify(v); } catch (err) { s = String(v); }
    if (s === undefined) s = String(v);
    return s.length > max ? s.slice(0, max - 3) + '...' : s;
  }

  function describe(v) {
    if (v === null || v === undefined) return 'blank (unknown)';
    if (v === '') return 'empty';
    return typeof v === 'string' ? '"' + v + '"' : preview(v);
  }

  function appendNote(note, text) {
    const joined = nonEmpty(note) ? note.trim() + ' ' + text : text;
    return joined.slice(0, LIMITS.note);
  }

  /**
   * Collects de-duplicated notes, and the paths of keys kept although this version does not know
   * them (keepUnknown). { dropUnknown: true }: leave such keys out instead, quietly — for input
   * that is not a saved budget (the household profile) and for cleanPlanUi.
   */
  function makeCtx(opts) {
    const notes = [];
    return { notes, kept: [], dropUnknown: !!(opts && opts.dropUnknown), note(message) { if (!notes.includes(message)) notes.push(message); } };
  }

  function datasetIdOf(dataset) {
    if (typeof dataset === 'string' && dataset.trim()) return dataset.trim().slice(0, LIMITS.datasetId);
    if (isObj(dataset) && nonEmpty(dataset.datasetId)) return dataset.datasetId.trim().slice(0, LIMITS.datasetId);
    return null;
  }

  function stampOf(now, fallback) {
    if (isIso(now)) return now;
    return isIso(fallback) ? fallback : EPOCH;
  }

  function safeStringify(v) {
    try { const s = JSON.stringify(v); return typeof s === 'string' ? s : null; } catch (err) { return null; }
  }

  // ------------------------------------------------------------------ ids

  function suffixed(base, taken) {
    const stem = base.slice(0, LIMITS.id - 5);
    for (let n = 2; ; n++) {
      const id = stem + '-' + n;
      if (!taken.has(id)) return id;
    }
  }

  /** Deterministic id from a seed (no randomness, no clock), unique within `taken`. */
  function freshId(prefix, seed, taken) {
    const base = prefix + '-' + E.util.hash(String(seed)).slice(0, 8);
    return taken.has(base) ? suffixed(base, taken) : base;
  }

  function uniqueIn(list, base) {
    const taken = new Set(list.map(x => x && x.id));
    return taken.has(base) ? suffixed(base, taken) : base;
  }

  /**
   * Keep a valid, unused saved id; rename duplicates to "<id>-2", "<id>-3" (deterministic); give
   * entries without a usable id a hash-based one. Adds the result to `taken`.
   */
  function assignId(rawId, taken, prefix, seed, path, ctx) {
    const id = typeof rawId === 'string' ? rawId.trim() : (Number.isInteger(rawId) ? String(rawId) : '');
    if (isValidId(id)) {
      if (!taken.has(id)) { taken.add(id); return id; }
      const renamed = suffixed(id, taken);
      ctx.note(path + ': the id "' + id + '" was used twice; this entry is now "' + renamed + '".');
      taken.add(renamed);
      return renamed;
    }
    const made = freshId(prefix, seed, taken);
    if (rawId !== undefined && rawId !== null && rawId !== '') ctx.note(path + ': the id ' + preview(rawId) + ' is not usable; this entry is now "' + made + '".');
    taken.add(made);
    return made;
  }

  // ------------------------------------------------------------------ field rules
  // One rule per field: its type, whether null (unknown) is allowed and the default used when a
  // saved value is missing or invalid. The same rules drive sanitize (lenient: reset + note) and
  // setPath / addItem / scenario events (strict: a friendly ValidationError).

  function rule(t, extra) { return Object.assign({ t, nullable: false, def: null }, extra); }

  const CENTS = rule('cents', { nullable: true });                       // >= 0, or null = unknown
  const SIGNED_CENTS = rule('cents', { nullable: true, signed: true });  // balances may be negative
  const MONTH = rule('month', { nullable: true });
  const START_MONTH = rule('month', { required: true, missing: 'Choose a start month.' });
  const DATE = rule('date', { nullable: true });
  const NOTE = rule('text', { max: LIMITS.note, def: '' });
  const OPT_TEXT = rule('text', { max: LIMITS.label, nullable: true });  // '' -> null
  const REF = rule('ref', { nullable: true });
  const ISO_TIME = rule('iso', { def: EPOCH });
  const BOOL_OR_NULL = rule('bool', { nullable: true });
  const STRICT_BOOL = rule('bool', { def: false });
  const label = (def, extra) => rule('label', Object.assign({ max: LIMITS.label, def }, extra));
  const oneOf = (values, def, extra) => rule('enum', Object.assign({ values, def }, extra));
  const bool = def => rule('bool', { def });
  const int = (min, max, def, extra) => rule('int', Object.assign({ min, max, def }, extra));
  const num = (min, max, def, extra) => rule('num', Object.assign({ min, max, def }, extra));
  const optional = r => Object.assign({}, r, { optional: true });

  const PERSON_FIELDS = [['name', label('Partner')]];

  const INCOME_FIELDS = [
    ['label', label('Income')],
    ['personId', oneOf(PEOPLE, null, { nullable: true })],
    ['kind', oneOf(['paycheck', 'contribution', 'other'], 'paycheck')],
    ['netPerPaycheckCents', CENTS],
    ['jointPerPaycheckCents', CENTS],
    ['grossPerPaycheckCents', CENTS],       // from a pay stub; detail only, never joint funding
    ['frequency', oneOf(FREQUENCIES.concat(['unknown']), 'unknown')],
    ['frequencyStatus', oneOf(['confirmed', 'observed', 'unknown'], 'unknown')],
    ['anchorDate', DATE],
    ['semimonthlyDays', rule('days', { def: [15, 31] })],
    ['monthlyDay', int(1, 31, null, { nullable: true })],
    ['assumedPerMonthIfUnknown', int(0, 5, 2)],
    ['status', oneOf(['confirmed', 'estimate', 'observed', 'unknown'], 'unknown')],
    ['startMonth', MONTH],
    ['endMonth', MONTH],
    ['note', NOTE]
  ];

  const BILL_FIELDS = [
    ['label', label('Bill')],
    ['category', OPT_TEXT],                 // null for debt payments: they are not category spending
    ['monthlyCents', CENTS],
    ['fundedFrom', oneOf(['joint', 'p1', 'p2', 'unknown'], 'unknown')],
    ['type', oneOf(['housing', 'debt', 'insurance', 'utility', 'subscription', 'other'], 'other')],
    ['debtId', REF],
    ['status', oneOf(['existing', 'planned', 'estimate'], 'existing')],
    ['startMonth', MONTH],
    ['endMonth', MONTH],
    ['note', NOTE]
  ];

  const PROMO_FIELDS = [
    ['balanceCents', CENTS],
    ['expiresMonth', MONTH],
    ['deferredInterest', BOOL_OR_NULL],
    ['note', NOTE]
  ];

  const DEBT_FIELDS = [
    ['label', label('Debt')],
    ['ownerId', oneOf(['p1', 'p2', 'joint'], 'joint')],
    ['balanceCents', CENTS],
    ['balanceAsOf', DATE],
    ['balanceStatus', oneOf(['approximate', 'statement', 'confirmed', 'unknown'], 'unknown')],
    ['aprPct', num(0, 100, null, { nullable: true })],
    ['aprRange', rule('range', { nullable: true, min: 0, max: 100 })],
    ['aprStatus', oneOf(['unknown', 'displayed', 'confirmed'], 'unknown')],
    ['paymentBillId', REF],
    ['promo', rule('object', { nullable: true, fields: PROMO_FIELDS })],
    ['loanCount', int(1, 100, null, { nullable: true })],
    ['repaymentPlan', OPT_TEXT],
    ['termStatus', oneOf(['unknown', 'confirmed'], 'unknown')],
    ['escrowIncluded', BOOL_OR_NULL],
    ['note', NOTE]
  ];

  const GOAL_FIELDS = [
    ['label', label('Savings goal')],
    ['targetCents', CENTS],
    ['targetMonth', MONTH],
    ['savedCents', CENTS],
    ['monthlyCents', CENTS],
    ['spendAtTarget', bool(false)],
    ['note', NOTE]
  ];

  const PERSONAL_FIELDS = [
    ['personId', oneOf(PEOPLE, null, { required: true, missing: 'Choose a person.' })],
    ['monthlyCents', CENTS],
    ['note', NOTE]
  ];

  // accounts: a balance the household entered per account id (for exports without a running
  // balance). accountDates: the day each of those balances is true at the end of (per account);
  // an account without its own date uses accountsAsOf. A balance is used at exactly that date.
  const BALANCE_FIELDS = [
    ['jointCashCents', SIGNED_CENTS], ['asOf', DATE], ['note', NOTE],
    ['accounts', rule('centsmap', { max: LIMITS.balanceAccounts, def: {} })], ['accountsAsOf', DATE],
    ['accountDates', rule('datemap', { max: LIMITS.balanceAccounts, def: {} })]
  ];

  const SETTINGS_FIELDS = [
    ['incomeTiming', oneOf(['conservative', 'average', 'actual'], 'conservative')],
    ['planningBaseline', oneOf(['actual', 'adjusted'], 'actual')],
    ['comparisonWindow', oneOf([3, 6, 12], 3)]
  ];

  const ASSUMPTION_FIELDS = [
    ['incomeTiming', oneOf(['actual', 'average', 'conservative'], 'conservative')],
    ['annualReturnPct', num(0, 25, 0)],
    ['costGrowthPct', num(-50, 50, 0)],
    ['incomeGrowthPct', num(-50, 50, 0)]
  ];

  const SCENARIO_FIELDS = [
    ['name', label('Scenario', { missing: 'Give the scenario a name.' })],
    ['description', NOTE],
    ['createdAt', ISO_TIME],
    ['updatedAt', ISO_TIME]
  ];

  // Planned changes on the plan screen (BudgetEngine.timeline): a dated one-time or monthly amount
  // added to one group from startMonth (monthly: through endMonth when set). cents null = the
  // amount is not known yet (listed, never applied as $0); accepted false = listed only.
  // personId only for income (null: "other money in"). scenario: the what-if it belongs to
  // (null: none), up to SCENARIO_TAG_MAX characters.
  const SCENARIO_TAG_MAX = 60;
  const CHANGE_FIELDS = [
    ['label', label('Planned change')],
    ['kind', oneOf(CHANGE_KINDS, 'monthly')],
    ['group', oneOf(CHANGE_GROUPS, 'flexible')],
    ['personId', oneOf(PEOPLE, null, { nullable: true })],
    ['startMonth', START_MONTH],
    ['endMonth', MONTH],
    ['cents', SIGNED_CENTS],
    ['accepted', bool(false)],
    ['template', REF],
    ['scenario', rule('text', { max: SCENARIO_TAG_MAX, nullable: true })],
    ['note', NOTE]
  ];

  // A recurring change may have an unknown start (e.g. childcare not arranged yet): startMonth
  // null means "timing unknown", which the forecast must report as missing, never as "now".
  const EVENT_FIELDS = {
    one_time: [
      ['label', label('One-time cost')], ['month', MONTH], ['amountCents', CENTS],
      ['direction', oneOf(['expense', 'income'], 'expense')], ['category', OPT_TEXT], ['goalId', REF], ['note', NOTE]
    ],
    recurring: [
      ['label', label('Monthly change')], ['startMonth', MONTH], ['endMonth', MONTH], ['monthlyCents', CENTS],
      ['direction', oneOf(['expense', 'income', 'income_loss'], 'expense')], ['category', OPT_TEXT], ['note', NOTE]
    ],
    income_change: [
      ['label', label('Income change')],
      ['streamId', rule('ref', { required: true, missing: 'Choose the income this changes.' })],
      ['startMonth', START_MONTH], ['endMonth', MONTH],
      // Absent = unchanged; null = unknown during the change; cents = the new amount.
      ['netPerPaycheckCents', optional(CENTS)], ['jointPerPaycheckCents', optional(CENTS)],
      ['note', NOTE]
    ],
    bill_change: [
      ['label', label('Bill change')],
      ['billId', rule('ref', { required: true, missing: 'Choose the bill this changes.' })],
      ['startMonth', START_MONTH], ['endMonth', MONTH], ['monthlyCents', CENTS], ['note', NOTE]
    ],
    target_change: [
      ['label', label('Target change')],
      ['category', label(null, { required: true, missing: 'Choose a category.' })],
      ['startMonth', START_MONTH], ['endMonth', MONTH], ['monthlyCents', CENTS], ['note', NOTE]
    ],
    goal: [
      ['label', label('Savings goal')],
      ['goal', rule('object', { required: true, fields: GOAL_FIELDS, withId: true, idPrefix: 'goal', missing: 'Describe the savings goal.' })]
    ]
  };
  const EVENT_TYPES = Object.keys(EVENT_FIELDS);

  const REFERENCE_FIELDS = [
    ['label', label('Reference')],
    ['start', rule('date', { required: true, missing: 'Choose a start date.' })],
    ['end', rule('date', { required: true, missing: 'Choose an end date.' })],
    ['spendingCents', SIGNED_CENTS],
    ['source', rule('text', { max: 200, def: '' })]
  ];

  const WHATIF_FIELDS = [['excludePendingReimbursements', bool(false)], ['excludeBusinessCandidates', bool(false)]];
  const WHATIF_DEFAULT = { excludePendingReimbursements: false, excludeBusinessCandidates: false };

  // ------------------------------------------------------------------ ui.plan: one descriptor table
  // The plan screen's saved settings (BudgetEngine.timeline): what the household set, never derived
  // data. PLAN_UI is the only description of ui.plan; everything else about it is derived from it:
  //   PLAN_UI_FIELDS   the rules sanitize checks a saved ui.plan with (through UI_FIELDS)
  //   PLAN_UI_DEFAULT  the defaults (a new budget's ui.plan; the trends row's own default included)
  //   SCHEMA ui.plan   how setPath writes inside each field (planUiChildren)
  //   cleanPlanUi      the silent cleaner BudgetEngine.timeline.settings reads ui.plan through
  // One row per field:
  //   name         the key under ui.plan
  //   rule         how a saved value is checked: `def` is its default, `max` / `keyMax` its limits;
  //                optional(...) = absent unless needed (no default)
  //   keysMessage  a map with fixed keys: what setPath says when another key is written
  //   doc          what it holds (docs/ARCHITECTURE.md §7 says the same for readers of the format)
  // Adding a field is one row here plus one line in docs/ARCHITECTURE.md §7 (see "Adding a ui.plan
  // field" there). The lists the rows use (dial keys, series, choices, defaults) are plan-settings.js.
  const PLAN_ROW_FIELDS = [['included', optional(rule('bool', {}))], ['cents', optional(rule('cents', { signed: true }))]];
  const LEGACY_DIAL_FIELDS = RETIRED_DIALS.map(k => [k, optional(rule('cents', { signed: true }))]);
  // fromCard / fromBank: the earlier card / bank amount it was carried over from (until kept or changed).
  const CARD_SPLIT_FIELDS = [['cents', rule('cents', { signed: true, required: true })], ['card', rule('cents', { signed: true, required: true })],
    ['fromCard', optional(rule('cents', { signed: true }))], ['fromBank', optional(rule('cents', { signed: true }))]];
  const TRENDS_FIELDS = [
    ['series', rule('keylist', { max: LIMITS.planTrendSeries, def: PS.TREND_DEFAULTS.series.slice(), values: TREND_SERIES })],
    ['ma', oneOf(PS.TREND_MA, PS.TREND_DEFAULTS.ma)],
    ['trend', bool(PS.TREND_DEFAULTS.trend)]
  ];
  /** An object field with a field list of its own; its default is each of its fields' default. */
  const fieldGroup = (fields, extra) => rule('object', Object.assign({ fields, def: emptyOf(fields) }, extra));

  const PLAN_UI = [
    { name: 'baselineMonths', rule: oneOf(PS.BASELINE_CHOICES, PS.DEFAULTS.baselineMonths),
      doc: 'how many recent complete months the dial baselines average (\'all\' = every one)' },
    { name: 'horizon', rule: oneOf(PS.HORIZONS, PS.DEFAULTS.horizon), doc: 'months planned ahead, from the first month without complete data' },
    { name: 'past', rule: oneOf(PS.PAST_CHOICES, PS.DEFAULTS.past), doc: 'months of history shown before the plan' },
    { name: 'mode', rule: oneOf(PS.MODES, PS.DEFAULTS.mode), doc: 'the main chart: balances, money in and out each month, or trends (chosen series as lines)' },
    { name: 'coverFromSavings', rule: bool(PS.DEFAULTS.coverFromSavings), doc: 'in projected months, move a checking shortfall from savings (per account only)' },
    { name: 'dials', rule: rule('centsmap', { max: LIMITS.planDials, def: {}, noun: 'plan amounts', keys: DIAL_KEYS }),
      keysMessage: 'Plan amounts can be set for: ' + DIAL_KEYS.join(', ') + '. Card and bank spending are worked out from essentials, flexible and irregular spending, not set directly.',
      doc: '{ [dialKey]: signed cents } set directly (DIAL_KEYS). Signed on purpose: a savings drawdown is negative and must survive every save. Card and bank spending are worked out, never set (RETIRED_DIALS)' },
    { name: 'rows', rule: rule('rowmap', { max: LIMITS.planRows, def: {}, fields: PLAN_ROW_FIELDS }),
      doc: '{ [rowId]: { included?, cents? } } changes to the essentials/flexible drill-down rows' },
    { name: 'hidden', rule: rule('keylist', { max: LIMITS.planHidden, def: null, nullable: true }),
      doc: 'chart series the household switched off; null = never chosen (the screen picks)' },
    { name: 'groups', rule: rule('enummap', { max: LIMITS.planGroups, keyMax: LIMITS.groupKey, values: SPEND_GROUPS, def: {}, noun: 'spending groups' }),
      doc: '{ [categoryName | \'merchant:\' + merchant]: \'essentials\'|\'flexible\' } the household\'s own grouping (the taxonomy\'s `essential` flag otherwise)' },
    { name: 'irregularOff', rule: rule('boolmap', { max: LIMITS.planIrregular, keyMax: LIMITS.txnId, def: {} }),
      doc: '{ [txnId]: true } one-time costs left out of the irregular allowance' },
    { name: 'trends', rule: fieldGroup(TRENDS_FIELDS), doc: 'the Trends chart: which series (TREND_SERIES), a moving average of 0/3/6 months, and a trend line' },
    { name: 'otherDial', rule: oneOf(['debt', 'withInvesting'], 'debt'),
      doc: 'what dials.other holds: \'debt\' = debt & business (investments have their own dial, dials.investing); \'withInvesting\' = an amount saved before that, still including investments, which the plan screen splits once (timeline.splitOther)' },
    { name: 'investReturnPct', rule: num(0, 25, null, { nullable: true }),
      doc: 'a yearly growth rate (%) the household entered for the investments line, compounded monthly and labelled illustrative; null = none assumed' },
    { name: 'scenariosCopied', rule: bool(true),
      doc: 'true once the Forecast scenarios\' events have been copied into plan.changes as what-ifs (absent in budgets saved before that: the copy runs once, V5_UPGRADES)' },
    { name: 'legacyDials', rule: optional(rule('object', { fields: LEGACY_DIAL_FIELDS })),
      doc: '(absent unless needed) { card?, bank? } signed cents set for the earlier card and bank dials, waiting to be carried over to essentials, flexible and irregular (timeline.migrateDials)' },
    { name: 'cardSplit', rule: optional(rule('objmap', { max: SPEND_DIALS.length, keys: SPEND_DIALS, fields: CARD_SPLIT_FIELDS, noun: 'card parts of plan amounts' })),
      keysMessage: 'A card part can be kept for: ' + SPEND_DIALS.join(', ') + '.',
      doc: '(absent unless needed) { [essentials|flexible|irregular]: { cents, card, fromCard?, fromBank? } } the card part of a direct amount, used while the dial still holds exactly `cents`; fromCard / fromBank mark it as carried over from the earlier card / bank amount until it is kept' }
  ];
  const PLAN_UI_FIELDS = PLAN_UI.map(d => [d.name, d.rule]);
  const PLAN_UI_DEFAULT = emptyOf(PLAN_UI_FIELDS);
  /** Where each earlier Home amount (ui.home, removed) goes in ui.plan.dials (card and bank then go on to ui.plan.legacyDials). */
  const HOME_TO_DIALS = { p1InCents: 'p1', p2InCents: 'p2', cardCents: 'card', bankCents: 'bank', savedCents: 'savings' };

  const UI_FIELDS = [
    ['scope', oneOf(['joint', 'household'], 'joint')],
    ['lastRoute', rule('route', { def: '#/overview' })],
    ['whatIf', rule('object', { fields: WHATIF_FIELDS, def: WHATIF_DEFAULT })],
    ['plan', rule('object', { fields: PLAN_UI_FIELDS, def: PLAN_UI_DEFAULT })],
    ['dismissed', rule('boolmap', { max: LIMITS.dismissed, def: {} })]
  ];

  const CHECKLIST_RULE = rule('boolmap', { max: LIMITS.checklist, def: {} });
  const NOTES_RULE = rule('strings', { def: [], maxItems: LIMITS.migrationNotes });

  const META_FIELDS = [
    ['createdAt', ISO_TIME],
    ['updatedAt', ISO_TIME],
    ['migratedFrom', int(0, 4, null, { nullable: true })],
    ['migrationNotes', NOTES_RULE],
    ['legacySnapshot', rule('snapshot', { nullable: true })]
  ];

  const FIELD_NAMES = {
    label: 'Name', name: 'Name', description: 'Description', note: 'Note', category: 'Category',
    monthlyCents: 'Monthly amount', amountCents: 'Amount', targetCents: 'Target', savedCents: 'Saved so far',
    netPerPaycheckCents: 'Take-home per paycheck', jointPerPaycheckCents: 'Amount reaching joint per paycheck', grossPerPaycheckCents: 'Gross pay per paycheck',
    balanceCents: 'Balance', jointCashCents: 'Joint cash', spendingCents: 'Spending',
    startMonth: 'Start month', endMonth: 'End month', month: 'Month', targetMonth: 'Target month', expiresMonth: 'Promotion end month',
    anchorDate: 'A recent payday', balanceAsOf: 'Balance date', asOf: 'Date', start: 'Start date', end: 'End date',
    streamId: 'Income', billId: 'Bill', goalId: 'Savings goal', debtId: 'Debt', paymentBillId: 'Payment bill',
    direction: 'Direction', frequency: 'Pay frequency', frequencyStatus: 'Frequency status', status: 'Status',
    fundedFrom: 'Paid from', type: 'Type', personId: 'Person', ownerId: 'Owner', kind: 'Kind',
    aprPct: 'Interest rate', aprRange: 'Interest rate range', semimonthlyDays: 'Paydays', monthlyDay: 'Payday',
    assumedPerMonthIfUnknown: 'Paychecks assumed per month', loanCount: 'Number of loans', promo: 'Promotion',
    goal: 'Savings goal', annualReturnPct: 'Annual return', costGrowthPct: 'Cost growth', incomeGrowthPct: 'Income growth',
    incomeTiming: 'Income timing', planningBaseline: 'Planning baseline', comparisonWindow: 'Comparison window',
    cents: 'Amount', accepted: 'Accepted', template: 'Template', group: 'Group',
    scope: 'View', lastRoute: 'Last page'
  };
  const fieldName = k => lookup(FIELD_NAMES, k) || k;

  function fit(s, max, strict) {
    if (s.length <= max) return { ok: true, value: s, adjusted: null };
    if (strict) return { ok: false, message: 'Use ' + max + ' characters or fewer.' };
    return { ok: true, value: s.slice(0, max), adjusted: 'shortened to ' + max + ' characters' };
  }

  /**
   * Check one value against a rule. Returns { ok, value, adjusted } or { ok: false, message }.
   * Lenient mode shortens over-long text (reported through `adjusted`); strict mode rejects it.
   */
  function check(r, value, strict) {
    const ok = (v, adjusted) => ({ ok: true, value: v, adjusted: adjusted || null });
    const bad = message => ({ ok: false, message });
    if (value === undefined || value === null) return r.nullable ? ok(null) : bad(r.missing || 'This is required.');
    switch (r.t) {
      case 'cents':
        if (typeof value !== 'number' || !Number.isInteger(value)) return bad('Amounts are stored in whole cents.');
        if (!r.signed && value < 0) return bad('Enter an amount of $0 or more.');
        if (Math.abs(value) > E.money.MAX_INPUT_CENTS) return bad('Enter an amount below $100,000,000.');
        return ok(value);
      case 'month':
        if (value === '' && r.nullable) return ok(null);
        return E.months.isMonth(value) ? ok(value) : bad('Choose a month (YYYY-MM).');
      case 'date':
        if (value === '' && r.nullable) return ok(null);
        return E.dates.isDate(value) ? ok(value) : bad('Choose a date (YYYY-MM-DD).');
      case 'iso':
        return isIso(value) ? ok(value) : bad('Not a valid timestamp.');
      case 'enum': {
        let v = value;
        // Form selects deliver numbers as text ("6"); accept them for numeric choices.
        if (typeof v === 'string' && !r.values.includes(v) && /^\s*\d+\s*$/.test(v) && r.values.includes(Number(v))) v = Number(v);
        return r.values.includes(v) ? ok(v) : bad('Choose one of: ' + r.values.join(', ') + '.');
      }
      case 'bool':
        if (value === 'true') return ok(true);
        if (value === 'false') return ok(false);
        return typeof value === 'boolean' ? ok(value) : bad('Choose yes or no.');
      case 'int':
      case 'num': {
        const v = typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value;
        const typed = r.t === 'int' ? Number.isInteger(v) : (typeof v === 'number' && Number.isFinite(v));
        if (!typed || v < r.min || v > r.max) return bad((r.t === 'int' ? 'Enter a whole number' : 'Enter a number') + ' from ' + r.min + ' to ' + r.max + '.');
        return ok(v);
      }
      case 'label': {
        if (typeof value !== 'string' || !value.trim()) return bad(r.missing || 'Enter a name.');
        return fit(value.trim(), r.max, strict);
      }
      case 'text': {
        if (typeof value !== 'string') return bad('Enter text.');
        const s = value.trim();
        if (!s && r.nullable) return ok(null);
        return fit(s, r.max, strict);
      }
      case 'ref': {
        if (value === '' && r.nullable) return ok(null);
        if (typeof value !== 'string' || !value.trim()) return bad(r.missing || 'Choose an item.');
        const s = value.trim();
        return s.length <= LIMITS.id ? ok(s) : bad('That reference is too long.');
      }
      case 'days': {
        const valid = Array.isArray(value) && value.length === 2 && value.every(d => Number.isInteger(d) && d >= 1 && d <= 31) && value[0] !== value[1];
        if (!valid) return bad('Choose two different days of the month (1 to 31; 31 means the last day).');
        return ok(value[0] < value[1] ? [value[0], value[1]] : [value[1], value[0]]);
      }
      case 'range': {
        const valid = Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= r.min && n <= r.max) && value[0] <= value[1];
        return valid ? ok([value[0], value[1]]) : bad('Enter the lowest and highest rate, from ' + r.min + ' to ' + r.max + '.');
      }
      case 'route':
        return typeof value === 'string' && value.startsWith('#/') && value.length <= LIMITS.route ? ok(value) : bad('Not a page address in this app.');
      case 'centsmap': {
        const noun = r.noun || 'balances';
        if (!isObj(value)) return bad(r.noun ? 'Expected a list of ' + noun + '.' : 'Expected a list of account balances.');
        const out = {};
        const dropped = [];
        for (const [k, v] of Object.entries(value)) {
          const key = k.trim();
          const okValue = v === null || (Number.isSafeInteger(v) && Math.abs(v) <= E.money.MAX_INPUT_CENTS);
          if (!isValidId(key) || (r.keys && !r.keys.includes(key)) || !okValue || Object.keys(out).length >= r.max) { dropped.push(k); continue; }
          out[key] = v;
        }
        if (dropped.length && strict) return bad(r.noun ? 'Every entry needs a short name and an amount in whole cents.' : 'Every balance needs an account and an amount in whole cents.');
        return ok(out, dropped.length ? 'dropped ' + noun + ' that were not valid (' + dropped.slice(0, 5).map(k => JSON.stringify(k)).join(', ') + ')' : null);
      }
      case 'datemap': {
        if (!isObj(value)) return bad('Expected a date for each account.');
        const out = {};
        const dropped = [];
        for (const [k, v] of Object.entries(value)) {
          const key = k.trim();
          if (!isValidId(key) || !(v === null || E.dates.isDate(v)) || Object.keys(out).length >= r.max) { dropped.push(k); continue; }
          out[key] = v;
        }
        if (dropped.length && strict) return bad('Every balance date needs an account and a date (YYYY-MM-DD).');
        return ok(out, dropped.length ? 'dropped balance dates that were not valid (' + dropped.slice(0, 5).map(k => JSON.stringify(k)).join(', ') + ')' : null);
      }
      case 'rowmap': {
        if (!isObj(value)) return bad('Expected a list of changes to plan rows.');
        const out = {};
        const dropped = [];
        for (const [k, v] of Object.entries(value)) {
          const key = k.trim();
          const okIncluded = isObj(v) && (v.included === undefined || typeof v.included === 'boolean');
          const okCents = isObj(v) && (v.cents === undefined || (Number.isSafeInteger(v.cents) && Math.abs(v.cents) <= E.money.MAX_INPUT_CENTS));
          const extra = isObj(v) && Object.keys(v).some(x => x !== 'included' && x !== 'cents');
          if (!isValidId(key) || !okIncluded || !okCents || extra || Object.keys(out).length >= r.max) { dropped.push(k); continue; }
          const entry = {};
          if (v.included !== undefined) entry.included = v.included;
          if (v.cents !== undefined) entry.cents = v.cents;
          out[key] = entry;
        }
        if (dropped.length && strict) return bad('Every plan row change needs a row id, and yes/no or an amount in whole cents.');
        return ok(out, dropped.length ? 'dropped plan row changes that were not valid (' + dropped.slice(0, 5).map(k => JSON.stringify(k)).join(', ') + ')' : null);
      }
      case 'keylist': {
        if (!Array.isArray(value)) return bad('Expected a list of names.');
        const list = [];
        for (const k of value) {
          if (typeof k !== 'string') continue;
          const key = k.trim();
          if (isValidId(key) && (!r.values || r.values.includes(key)) && !list.includes(key) && list.length < r.max) list.push(key);
        }
        const changed = list.length !== value.length || list.some((k, i) => k !== value[i]);
        if (changed && strict) return bad(r.values ? 'Choose up to ' + r.max + ' different series from: ' + r.values.join(', ') + '.' : 'Use up to ' + r.max + ' different short names.');
        return ok(list, changed ? 'cleaned (names that were not valid, ' + (r.values ? 'not known, ' : '') + 'repeated or over ' + r.max + ' removed)' : null);
      }
      case 'objmap': {
        // { [key]: { field: value } } with every field checked strictly; a bad entry is dropped whole.
        const noun = r.noun || 'entries';
        if (!isObj(value)) return bad('Expected a list of ' + noun + '.');
        const out = {};
        const dropped = [];
        for (const [k, v] of Object.entries(value)) {
          const key = k.trim();
          let entry = null;
          if (isValidId(key) && (!r.keys || r.keys.includes(key)) && isObj(v) && Object.keys(v).every(f => r.fields.some(([n]) => n === f)) && Object.keys(out).length < r.max) {
            entry = {};
            for (const [f, fr] of r.fields) {
              if (v[f] === undefined && fr.optional) continue;
              const res = check(fr, v[f], true);
              if (!res.ok) { entry = null; break; }
              entry[f] = res.value;
            }
          }
          if (!entry) { dropped.push(k); continue; }
          out[key] = entry;
        }
        if (dropped.length && strict) return bad('Every entry needs one of: ' + (r.keys || []).join(', ') + ', with ' + r.fields.filter(([, fr]) => !fr.optional).map(([n]) => n).join(' and ') + ' in whole cents.');
        return ok(out, dropped.length ? 'dropped ' + noun + ' that were not valid (' + dropped.slice(0, 5).map(k => JSON.stringify(k)).join(', ') + ')' : null);
      }
      case 'boolmap': {
        if (!isObj(value)) return bad('Expected a set of yes/no settings.');
        const out = {};
        const dropped = [];
        const keyMax = r.keyMax || LIMITS.label;
        for (const [k, v] of Object.entries(value)) {
          const key = k.trim();
          if (!key || key.length > keyMax || !isSafeKey(key) || typeof v !== 'boolean' || Object.keys(out).length >= r.max) { dropped.push(k); continue; }
          out[key] = v;
        }
        if (dropped.length && strict) return bad('Every entry needs a short name and a yes/no value.');
        return ok(out, dropped.length ? 'dropped entries that were not yes/no settings (' + dropped.slice(0, 5).map(k => JSON.stringify(k)).join(', ') + ')' : null);
      }
      case 'enummap': {
        const noun = r.noun || 'choices';
        if (!isObj(value)) return bad('Expected a list of ' + noun + '.');
        const out = {};
        const dropped = [];
        for (const [k, v] of Object.entries(value)) {
          const key = k.trim();
          if (!key || key.length > r.keyMax || !isSafeKey(key) || !r.values.includes(v) || Object.keys(out).length >= r.max) { dropped.push(k); continue; }
          out[key] = v;
        }
        if (dropped.length && strict) return bad('Every entry needs a name (up to ' + r.keyMax + ' characters) and one of: ' + r.values.join(', ') + '.');
        return ok(out, dropped.length ? 'dropped ' + noun + ' that were not valid (' + dropped.slice(0, 5).map(k => JSON.stringify(k)).join(', ') + ')' : null);
      }
      case 'strings': {
        if (!Array.isArray(value)) return bad('Expected a list of notes.');
        const list = value.filter(nonEmpty).map(s => s.trim().slice(0, LIMITS.note)).slice(0, r.maxItems);
        const changed = list.length !== value.length || list.some((s, i) => s !== value[i]);
        if (changed && strict) return bad('Notes must be text of up to ' + LIMITS.note + ' characters.');
        return ok(list, changed ? 'cleaned (blank or non-text notes removed, long ones shortened)' : null);
      }
      case 'snapshot': {
        if (typeof value !== 'string') return bad('Expected text.');
        if (value.length <= LIMITS.legacySnapshot) return ok(value);
        return strict ? bad('Too long.') : ok(value.slice(0, LIMITS.legacySnapshot), 'shortened to ' + LIMITS.legacySnapshot + ' characters');
      }
      default:
        return bad('Unsupported field.');
    }
  }

  function defaultFor(r, key, o) {
    return o.defaults && has(o.defaults, key) ? clone(o.defaults[key]) : clone(r.def);
  }

  /** Default values for a field list (used to build new items). */
  function emptyOf(fields) {
    const out = {};
    for (const [key, r] of fields) if (!r.optional && !r.required) out[key] = clone(r.def);
    return out;
  }

  function entryLabel(raw) {
    if (isObj(raw) && nonEmpty(raw.label)) return ' ("' + raw.label.trim().slice(0, 60) + '")';
    if (isObj(raw) && nonEmpty(raw.name)) return ' ("' + raw.name.trim().slice(0, 60) + '")';
    return '';
  }

  function requiredFailure(raw, key, message, o) {
    if (o.strict) fail(message, key);
    o.ctx.note(o.path + entryLabel(raw) + ': ' + fieldName(key).toLowerCase() + ' is missing or not valid (' + message + ') This entry was dropped; it was ' + preview(raw, 300) + '.');
    return null;
  }

  function checkObject(r, value, key, o) {
    if (value === null) return r.nullable ? { ok: true, value: null } : { ok: false, message: r.missing || 'This is required.' };
    if (!isObj(value)) return { ok: false, message: 'Expected a group of details.' };
    const sub = cleanFields(value, r.fields, { path: o.path + '.' + key, ctx: o.ctx, strict: o.strict, known: r.withId ? ['id'] : [] });
    if (sub === null) return { ok: false, message: 'Some required details are missing.' };
    if (!r.withId) return { ok: true, value: sub };
    const id = isValidId(value.id) ? value.id : freshId(r.idPrefix || 'item', o.path + '.' + key + '|' + preview(value), new Set());
    return { ok: true, value: Object.assign({ id }, sub) };
  }

  /**
   * Validate an object's fields against a rule list.
   * Lenient (sanitize): an invalid value is reset to its default with a note; an unusable
   * required field returns null so the caller drops the whole entry (also noted); a key this
   * version does not know is kept as saved, after the known fields, with a note (keepUnknown;
   * left out instead when ctx.dropUnknown). Strict (forms, scenario events): the first problem
   * throws a ValidationError; unknown keys are not copied.
   * @param {object} raw
   * @param {Array} fields [key, rule] pairs, in output order
   * @param {{path:string, ctx:object, strict?:boolean, defaults?:object, known?:string[]}} o
   */
  function cleanFields(raw, fields, o) {
    const out = {};
    for (const [key, r] of fields) {
      const value = raw[key];
      if (value === undefined) {
        if (r.optional) continue;
        if (r.required) return requiredFailure(raw, key, r.missing || 'This is required.', o);
        out[key] = defaultFor(r, key, o);
        continue;
      }
      const res = r.t === 'object' ? checkObject(r, value, key, o) : check(r, value, o.strict);
      if (res.ok) {
        out[key] = res.value;
        if (res.adjusted) o.ctx.note(o.path + '.' + key + ': ' + res.adjusted + '.');
        continue;
      }
      if (o.strict) fail(fieldName(key) + ': ' + res.message, key);
      if (r.required) return requiredFailure(raw, key, res.message, o);
      // An unreadable saved amount becomes unknown, never the profile's figure: that figure may
      // be from another date (e.g. a joint cash balance shown under the saved balance date).
      const d = r.t === 'cents' && r.nullable ? null : defaultFor(r, key, o);
      o.ctx.note(o.path + '.' + key + ': ' + preview(value) + ' is not valid (' + res.message + ') Reset to ' + describe(d) + '.');
      out[key] = d;
    }
    if (!o.strict) {
      const known = new Set(fields.map(f => f[0]).concat(['id'], o.known || []));
      for (const k of Object.keys(raw)) if (!known.has(k)) keepUnknown(out, raw, k, o.path + '.' + k, o.ctx);
    }
    return out;
  }

  /**
   * Forward compatibility (docs/ARCHITECTURE.md §7): a key this version does not know, found while
   * loading, is kept as saved, so a budget saved by a newer copy of the app loses nothing when this
   * copy opens and saves it again. It is named in a note and counted in ctx.kept (sanitize adds one
   * summary line). A key that cannot be kept on a plain object ("__proto__"), or a value that is
   * not JSON, is dropped and named instead. ctx.dropUnknown: left out, quietly.
   */
  function keepUnknown(out, raw, k, path, ctx) {
    if (ctx.dropUnknown) return;
    const text = isSafeKey(k) ? safeStringify(raw[k]) : null;
    if (text === null) { ctx.note(path + ': not part of the saved budget format; dropped (it was ' + preview(raw[k]) + ').'); return; }
    out[k] = JSON.parse(text);
    ctx.note(path + ': not part of this version’s saved budget format; kept as saved (' + preview(raw[k]) + ').');
    ctx.kept.push(path);
  }

  /** One line for the household when keepUnknown kept anything: put first, before the per-key notes. */
  function noteKeptUnknown(ctx) {
    const n = ctx.kept.length;
    if (!n) return;
    const shown = ctx.kept.slice(0, 3).join(', ') + (n > 3 ? ', ...' : '');
    ctx.notes.unshift('This budget has ' + plural(n, 'setting') + ' this version of the app does not use (' + shown + '), probably saved by a newer copy of the app; ' + (n === 1 ? 'it is' : 'they are') + ' kept as saved.');
  }

  /** End month before start month: strict mode rejects it, lenient mode clears the end month. */
  function checkOrder(item, path, o, startKey, endKey) {
    const a = item[startKey], b = item[endKey];
    if (typeof a !== 'string' || typeof b !== 'string' || b >= a) return true;
    if (o.strict) fail('The ' + fieldName(endKey).toLowerCase() + ' must be the same as or after the ' + fieldName(startKey).toLowerCase() + '.', endKey);
    o.ctx.note(path + '.' + endKey + ': ' + b + ' is before the ' + fieldName(startKey).toLowerCase() + ' ' + a + '; the end month was cleared.');
    item[endKey] = null;
    return true;
  }

  const startEndOrder = (item, path, o) => checkOrder(item, path, o, 'startMonth', 'endMonth');

  function referenceOrder(item, path, o) {
    if (item.end >= item.start) return true;
    if (o.strict) fail('The end date must be the same as or after the start date.', 'end');
    o.ctx.note(path + entryLabel(item) + ': the end date ' + item.end + ' is before the start date ' + item.start + '; this reference was dropped.');
    return false;
  }

  // ------------------------------------------------------------------ sanitizing sections

  function labelsOf(list) {
    const shown = list.slice(0, 5).map(x => (isObj(x) && (nonEmpty(x.label) || nonEmpty(x.name)) ? '"' + String(x.label || x.name).trim().slice(0, 40) + '"' : preview(x)));
    return shown.join(', ') + (list.length > 5 ? ', ...' : '');
  }

  /** Validate a list of id'd entries (incomes, bills, debts, savings, references). */
  function cleanList(raw, fields, o) {
    if (raw === undefined) return clone(o.fallback);
    if (!Array.isArray(raw)) {
      o.ctx.note(o.path + ': not a list (' + preview(raw) + '); ' + (o.fallback.length ? 'using the household profile’s entries.' : 'left empty.'));
      return clone(o.fallback);
    }
    const out = [];
    const taken = new Set();
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (out.length >= o.max) {
        o.ctx.note(o.path + ': only ' + o.max + ' entries can be kept; ' + (raw.length - i) + ' more were dropped (' + labelsOf(raw.slice(i)) + ').');
        break;
      }
      if (!isObj(item)) { o.ctx.note(o.path + '[' + i + ']: not a valid entry (' + preview(item) + '); dropped.'); continue; }
      const seed = o.path + '|' + i + '|' + (typeof item.label === 'string' ? item.label : '');
      const id = assignId(item.id, taken, o.prefix, seed, o.path + '[' + i + ']', o.ctx);
      const path = o.path + '[id=' + id + ']';
      const body = cleanFields(item, fields, { path, ctx: o.ctx, strict: false });
      if (body === null) { taken.delete(id); continue; }
      const entry = Object.assign({ id }, body);
      if (o.after && o.after(entry, path, { ctx: o.ctx, strict: false }) === false) { taken.delete(id); continue; }
      out.push(entry);
    }
    return out;
  }

  /** Validate a fixed group of fields (balances, settings, assumptions); defaults fill gaps. */
  function cleanGroup(raw, fields, base, path, ctx) {
    if (raw === undefined) return clone(base);
    if (!isObj(raw)) { ctx.note(path + ': not readable (' + preview(raw) + '); reset.'); return clone(base); }
    return cleanFields(raw, fields, { path, ctx, strict: false, defaults: base });
  }

  function cleanPeople(raw, basePeople, path, ctx) {
    const out = PEOPLE.map((id, i) => {
      const b = Array.isArray(basePeople) ? basePeople.find(p => isObj(p) && p.id === id) : null;
      return { id, name: b && nonEmpty(b.name) ? b.name.trim().slice(0, LIMITS.label) : DEFAULT_PEOPLE_NAMES[i] };
    });
    if (raw === undefined) return out;
    if (!Array.isArray(raw)) { ctx.note(path + ': not a list; kept the names ' + out.map(p => '"' + p.name + '"').join(' and ') + '.'); return out; }
    raw.forEach((p, i) => {
      if (!isObj(p) || !PEOPLE.includes(p.id)) { ctx.note(path + '[' + i + ']: only the two people p1 and p2 are supported; ' + preview(p) + ' was dropped.'); return; }
      const target = out.find(x => x.id === p.id);
      const res = check(label('Partner'), p.name, false);
      if (!res.ok) { ctx.note(path + '[id=' + p.id + '].name: ' + preview(p.name) + ' is not a usable name; kept "' + target.name + '".'); return; }
      target.name = res.value;
      if (res.adjusted) ctx.note(path + '[id=' + p.id + '].name: ' + res.adjusted + '.');
    });
    return out;
  }

  function cleanPersonal(raw, fallback, path, ctx) {
    if (raw === undefined) return clone(fallback);
    if (!Array.isArray(raw)) { ctx.note(path + ': not a list (' + preview(raw) + '); using the household profile’s entries.'); return clone(fallback); }
    const out = [];
    raw.forEach((p, i) => {
      if (!isObj(p)) { ctx.note(path + '[' + i + ']: not a valid entry (' + preview(p) + '); dropped.'); return; }
      const body = cleanFields(p, PERSONAL_FIELDS, { path: path + '[' + i + ']', ctx, strict: false });
      if (!body) return;
      if (out.some(x => x.personId === body.personId)) {
        ctx.note(path + '[' + i + ']: a second personal-spending entry for ' + body.personId + ' (' + money(body.monthlyCents) + ') was dropped.');
        return;
      }
      out.push(body);
    });
    return out;
  }

  /** Targets: { category: cents|null }. An invalid amount becomes unknown (null), never 0. */
  function cleanTargets(raw, fallback, path, ctx) {
    if (raw === undefined) return clone(fallback);
    if (!isObj(raw)) { ctx.note(path + ': not readable (' + preview(raw) + '); using the household profile’s targets.'); return clone(fallback); }
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const key = k.trim();
      if (!key || key.length > LIMITS.categoryKey || !isSafeKey(key)) {
        ctx.note(path + ': the category name ' + preview(k) + ' is not usable (1 to ' + LIMITS.categoryKey + ' characters); its target of ' + preview(v) + ' was dropped.');
        continue;
      }
      if (has(out, key)) { ctx.note(path + ': "' + key + '" appears twice; the second target (' + preview(v) + ') was dropped.'); continue; }
      if (Object.keys(out).length >= LIMITS.targets) { ctx.note(path + ': only ' + LIMITS.targets + ' targets can be kept; "' + key + '" and later ones were dropped.'); break; }
      const res = check(CENTS, v, false);
      if (res.ok) out[key] = res.value;
      else {
        out[key] = null;
        ctx.note(path + '.' + key + ': ' + preview(v) + ' is not a valid amount (' + res.message + ') The target is now blank (unknown).');
      }
    }
    return out;
  }

  function emptyPlan(people) {
    return {
      people: clone(people),
      incomes: [], bills: [], debts: [], targets: {}, savings: [], personalSpending: [],
      balances: { jointCashCents: null, asOf: null, note: '', accounts: {}, accountsAsOf: null, accountDates: {} },
      settings: { incomeTiming: 'conservative', planningBaseline: 'actual', comparisonWindow: 3 },
      changes: []
    };
  }

  const PLAN_KEYS = ['people', 'incomes', 'bills', 'debts', 'targets', 'savings', 'personalSpending', 'balances', 'settings', 'changes'];

  /**
   * A planned change's fields that only fit some kinds: an end month only on a monthly change, a
   * person only on an income change. Strict mode rejects the mismatch; lenient mode clears it.
   */
  function changeOrder(item, path, o) {
    startEndOrder(item, path, o);
    if (item.kind === 'oneTime' && item.endMonth !== null && item.endMonth !== undefined) {
      if (o.strict) fail('A one-time change happens in its start month only: it has no end month.', 'endMonth');
      o.ctx.note(path + '.endMonth: a one-time change has no end month; ' + item.endMonth + ' was cleared.');
      item.endMonth = null;
    }
    if (item.group !== 'income' && item.personId !== null && item.personId !== undefined) {
      if (o.strict) fail('Only an income change belongs to a person.', 'personId');
      o.ctx.note(path + '.personId: only an income change belongs to a person; ' + item.personId + ' was cleared.');
      item.personId = null;
    }
    return true;
  }

  function cleanPlan(raw, base, ctx, path) {
    if (raw === undefined) return clone(base);
    if (!isObj(raw)) { ctx.note(path + ': not readable (' + preview(raw) + '); using the household profile’s plan.'); return clone(base); }
    const plan = {
      people: cleanPeople(raw.people, base.people, path + '.people', ctx),
      incomes: cleanList(raw.incomes, INCOME_FIELDS, { path: path + '.incomes', ctx, max: LIMITS.incomes, prefix: 'income', fallback: base.incomes, after: startEndOrder }),
      bills: cleanList(raw.bills, BILL_FIELDS, { path: path + '.bills', ctx, max: LIMITS.bills, prefix: 'bill', fallback: base.bills, after: startEndOrder }),
      debts: cleanList(raw.debts, DEBT_FIELDS, { path: path + '.debts', ctx, max: LIMITS.debts, prefix: 'debt', fallback: base.debts }),
      targets: cleanTargets(raw.targets, base.targets, path + '.targets', ctx),
      savings: cleanList(raw.savings, GOAL_FIELDS, { path: path + '.savings', ctx, max: LIMITS.savings, prefix: 'goal', fallback: base.savings }),
      personalSpending: cleanPersonal(raw.personalSpending, base.personalSpending, path + '.personalSpending', ctx),
      balances: cleanGroup(raw.balances, BALANCE_FIELDS, base.balances, path + '.balances', ctx),
      settings: cleanGroup(raw.settings, SETTINGS_FIELDS, base.settings, path + '.settings', ctx),
      // Absent in budgets saved before planned changes existed: none yet.
      changes: cleanList(raw.changes, CHANGE_FIELDS, { path: path + '.changes', ctx, max: LIMITS.planChanges, prefix: 'change', fallback: Array.isArray(base.changes) ? base.changes : [], after: changeOrder })
    };
    for (const k of Object.keys(raw)) if (!PLAN_KEYS.includes(k)) keepUnknown(plan, raw, k, path + '.' + k, ctx);
    return plan;
  }

  /**
   * Forecast scenarios count actual paydays by default (so biweekly pay shows its two
   * three-paycheck months), independent of plan.settings.incomeTiming, which only controls the
   * Budget's "typical month" figures. Every scenario starts with the same timing, so compared
   * scenarios stay like-for-like. Return and growth rates start at 0.
   */
  function defaultAssumptions() {
    return { incomeTiming: 'actual', annualReturnPct: 0, costGrowthPct: 0, incomeGrowthPct: 0 };
  }

  /**
   * Validate one scenario event. With `o.taken` the event gets a unique id (sanitize); without
   * it a valid id is kept and a missing one is left for the caller to assign.
   */
  function cleanEvent(raw, o) {
    if (!isObj(raw)) {
      if (o.strict) fail('A change needs its details.');
      o.ctx.note(o.path + ': not a valid change (' + preview(raw) + '); dropped.');
      return null;
    }
    const fields = has(EVENT_FIELDS, raw.type) ? EVENT_FIELDS[raw.type] : null;
    if (!fields) {
      if (o.strict) fail('Choose what kind of change this is (' + EVENT_TYPES.join(', ') + ').', 'type');
      o.ctx.note(o.path + entryLabel(raw) + ': unknown kind of change ' + preview(raw.type) + '; dropped (it was ' + preview(raw, 300) + ').');
      return null;
    }
    let id = null;
    let path = o.path;
    if (o.taken) {
      id = assignId(raw.id, o.taken, 'event', o.seed + '|' + raw.type + '|' + (typeof raw.label === 'string' ? raw.label : ''), o.path, o.ctx);
      path = o.path.replace(/\[\d+\]$/, '') + '[id=' + id + ']';
    } else if (isValidId(raw.id)) {
      id = raw.id;
    }
    const body = cleanFields(raw, fields, { path, ctx: o.ctx, strict: o.strict, known: ['type'] });
    if (body === null) { if (o.taken && id) o.taken.delete(id); return null; }
    const ev = Object.assign(id ? { id } : {}, { type: raw.type }, body);
    if (has(ev, 'startMonth')) startEndOrder(ev, path, o);
    return ev;
  }

  function cleanEvents(raw, path, ctx, taken, scenarioId) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) { ctx.note(path + ': not a list of changes (' + preview(raw) + '); dropped.'); return []; }
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      if (out.length >= LIMITS.events) {
        ctx.note(path + ': only ' + LIMITS.events + ' changes can be kept in one scenario; ' + (raw.length - i) + ' more were dropped (' + labelsOf(raw.slice(i)) + ').');
        break;
      }
      const ev = cleanEvent(raw[i], { path: path + '[' + i + ']', ctx, strict: false, taken, seed: scenarioId + '|' + i });
      if (ev) out.push(ev);
    }
    return out;
  }

  function makeBaseline(plan, meta) {
    return {
      id: BASELINE_ID, name: BASELINE_NAME, description: BASELINE_DESCRIPTION,
      createdAt: meta.createdAt, updatedAt: meta.updatedAt, events: [], assumptions: defaultAssumptions(plan)
    };
  }

  /**
   * Scenarios: unique ids (events unique across all scenarios), the baseline first and empty,
   * at most LIMITS.scenarios. Changes found on the baseline are moved to a new scenario rather
   * than dropped, because the baseline must always mean "the budget as it is".
   */
  function cleanScenarios(raw, fallback, plan, meta, ctx) {
    if (raw === undefined) return clone(fallback);
    if (!Array.isArray(raw)) { ctx.note('scenarios: not a list (' + preview(raw) + '); using the starting scenarios.'); return clone(fallback); }
    const taken = new Set();
    const eventIds = new Set();
    const list = [];
    raw.forEach((s, i) => {
      if (!isObj(s)) { ctx.note('scenarios[' + i + ']: not a valid scenario (' + preview(s) + '); dropped.'); return; }
      const id = assignId(s.id, taken, 'scenario', 'scenario|' + i + '|' + (typeof s.name === 'string' ? s.name : ''), 'scenarios[' + i + ']', ctx);
      const path = 'scenarios[id=' + id + ']';
      const head = cleanFields(s, SCENARIO_FIELDS, {
        path, ctx, strict: false, known: ['events', 'assumptions'],
        defaults: { name: id === BASELINE_ID ? BASELINE_NAME : 'Scenario ' + (i + 1), createdAt: meta.createdAt, updatedAt: meta.updatedAt }
      });
      const events = cleanEvents(s.events, path + '.events', ctx, eventIds, id);
      const assumptions = cleanGroup(s.assumptions, ASSUMPTION_FIELDS, defaultAssumptions(plan), path + '.assumptions', ctx);
      list.push(Object.assign({ id }, head, { events, assumptions }));
    });

    const at = list.findIndex(s => s.id === BASELINE_ID);
    if (at === -1) {
      list.unshift(makeBaseline(plan, meta));
      if (raw.length) ctx.note('scenarios: the "' + BASELINE_NAME + '" scenario was missing and has been restored.');
    } else if (at > 0) {
      list.unshift(list.splice(at, 1)[0]);
      ctx.note('scenarios: "' + list[0].name + '" (the current budget) was moved back to the first place.');
    }

    const baseline = list[0];
    if (baseline.events.length) {
      const moved = baseline.events;
      baseline.events = [];
      if (list.length < LIMITS.scenarios) {
        const id = freshId('scenario', 'moved-from-baseline|' + moved.map(e => e.id).join(','), taken);
        taken.add(id);
        list.push({
          id, name: 'Changes moved from the current budget',
          description: 'These changes were saved on the current budget, which always stays as it is. They were moved here so nothing is lost.',
          createdAt: baseline.createdAt, updatedAt: baseline.updatedAt, events: moved, assumptions: clone(baseline.assumptions)
        });
        ctx.note('scenarios[id=baseline]: the current budget cannot hold planned changes; its ' + plural(moved.length, 'change') + ' (' + labelsOf(moved) + ') moved to the new scenario "Changes moved from the current budget".');
      } else {
        ctx.note('scenarios[id=baseline]: the current budget cannot hold planned changes, and there is no room for another scenario; ' + plural(moved.length, 'change') + ' dropped (' + labelsOf(moved) + ').');
      }
    }

    if (list.length > LIMITS.scenarios) {
      const dropped = list.splice(LIMITS.scenarios);
      ctx.note('scenarios: only ' + LIMITS.scenarios + ' scenarios can be kept; dropped ' + labelsOf(dropped) + '.');
    }
    return list;
  }

  function defaultCompareIds(scenarios) { return scenarios.slice(0, 2).map(s => s.id); }

  function cleanCompareIds(raw, scenarios, ctx) {
    const fallback = defaultCompareIds(scenarios);
    if (raw === undefined) return fallback;
    if (!Array.isArray(raw)) { ctx.note('compareIds: not a list (' + preview(raw) + '); reset.'); return fallback; }
    const ids = new Set(scenarios.map(s => s.id));
    const out = [];
    for (const id of raw) {
      if (typeof id !== 'string' || !ids.has(id)) { ctx.note('compareIds: the scenario ' + preview(id) + ' no longer exists; removed from the comparison.'); continue; }
      if (out.includes(id)) continue;
      if (out.length >= LIMITS.compareIds) { ctx.note('compareIds: at most ' + LIMITS.compareIds + ' scenarios can be compared; "' + id + '" was removed from the comparison.'); continue; }
      out.push(id);
    }
    return out.length ? out : fallback;
  }

  // ------------------------------------------------------------------ ledger edits (§4)

  const EDIT_ENUMS = {
    duplicate: ['exclude', 'keep'],
    reimbursement: ['pending', 'confirmed', 'not_reimbursed'],
    business: ['pending', 'business', 'household'],
    planningBaseline: ['exclude', 'include'],
    person: ['p1', 'p2', 'none']             // whose money a deposit is ('none' = neither partner)
  };
  const EDIT_KEYS = ['category', 'categoryReason', 'kind', 'kindReason', 'subtype', 'splits'].concat(Object.keys(EDIT_ENUMS), ['note', 'history']);

  function historyValue(v) {
    const s = safeStringify(v === undefined ? null : v);
    if (s === null) return null;
    return s.length <= 4000 ? JSON.parse(s) : '(value too large to keep)';
  }

  function cleanHistory(raw, path, ctx) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) { ctx.note(path + ': not a list; the change history was reset (it was ' + preview(raw) + ').'); return []; }
    const valid = [];
    let unreadable = 0;
    for (const h of raw) {
      if (!isObj(h) || !nonEmpty(h.field)) { unreadable++; continue; }
      valid.push({
        at: typeof h.at === 'string' && h.at.length <= 40 ? h.at : null,
        field: h.field.trim().slice(0, 40),
        from: historyValue(h.from),
        to: historyValue(h.to),
        reason: typeof h.reason === 'string' ? h.reason.trim().slice(0, LIMITS.note) : ''
      });
    }
    if (unreadable) ctx.note(path + ': ' + unreadable + ' unreadable history ' + (unreadable === 1 ? 'entry was' : 'entries were') + ' dropped.');
    if (valid.length > LIMITS.history) {
      ctx.note(path + ': only the latest ' + LIMITS.history + ' history entries are kept; ' + (valid.length - LIMITS.history) + ' older ones were dropped.');
      return valid.slice(-LIMITS.history);
    }
    return valid;
  }

  function cleanEdit(raw, path, ctx) {
    if (!isObj(raw)) { ctx.note(path + ': not a valid correction (' + preview(raw) + '); dropped.'); return null; }
    const out = {};
    const drop = (k, why) => ctx.note(path + '.' + k + ': ' + why + '; dropped (it was ' + preview(raw[k]) + ').');
    const reason = v => (typeof v === 'string' ? v.trim().slice(0, LIMITS.note) : '');

    if (raw.category !== undefined && raw.category !== null) {
      if (nonEmpty(raw.category) && raw.category.trim().length <= LIMITS.categoryKey) {
        out.category = raw.category.trim();
        out.categoryReason = reason(raw.categoryReason);
      } else drop('category', 'not a usable category name');
    }
    if (raw.kind !== undefined && raw.kind !== null) {
      if (TXN_KINDS.includes(raw.kind)) { out.kind = raw.kind; out.kindReason = reason(raw.kindReason); }
      else drop('kind', 'not a transaction kind (' + TXN_KINDS.join(', ') + ')');
    }
    if (raw.subtype !== undefined) {
      if (raw.subtype === null) out.subtype = null;
      else if (typeof raw.subtype === 'string' && raw.subtype.trim().length <= 40) out.subtype = raw.subtype.trim() || null;
      else drop('subtype', 'not a usable subtype');
    }
    if (raw.splits !== undefined && raw.splits !== null) {
      const s = raw.splits;
      const valid = Array.isArray(s) && s.length > 0 && s.length <= LIMITS.splits &&
        s.every(p => isObj(p) && nonEmpty(p.category) && p.category.trim().length <= LIMITS.categoryKey && Number.isInteger(p.cents) && Math.abs(p.cents) <= E.money.MAX_INPUT_CENTS);
      // A partial split would no longer add up to the transaction, so it is kept whole or not at all.
      if (valid) out.splits = s.map(p => ({ category: p.category.trim(), cents: p.cents }));
      else drop('splits', 'not a valid split (each part needs a category and an amount in whole cents)');
    }
    for (const [k, values] of Object.entries(EDIT_ENUMS)) {
      if (raw[k] === undefined || raw[k] === null) continue;
      if (values.includes(raw[k])) out[k] = raw[k];
      else drop(k, 'not one of ' + values.join(', '));
    }
    if (raw.note !== undefined && raw.note !== null) {
      if (typeof raw.note === 'string') {
        out.note = raw.note.trim().slice(0, LIMITS.note);
        if (raw.note.trim().length > LIMITS.note) ctx.note(path + '.note: shortened to ' + LIMITS.note + ' characters.');
      } else drop('note', 'not text');
    }
    out.history = cleanHistory(raw.history, path + '.history', ctx);
    for (const k of Object.keys(raw)) if (!EDIT_KEYS.includes(k)) drop(k, 'not part of a transaction correction');
    if (Object.keys(out).length === 1 && out.history.length === 0) return null; // nothing left to keep
    return out;
  }

  function cleanEdits(raw, ctx) {
    if (raw === undefined) return {};
    if (!isObj(raw)) { ctx.note('ledgerEdits: not readable (' + preview(raw) + '); transaction corrections could not be kept.'); return {}; }
    const out = {};
    let count = 0;
    const entries = Object.entries(raw);
    for (let i = 0; i < entries.length; i++) {
      const [txnId, edit] = entries[i];
      if (!txnId.trim() || txnId.length > LIMITS.txnId || !isSafeKey(txnId)) { ctx.note('ledgerEdits: the transaction id ' + preview(txnId) + ' is not usable; its correction was dropped.'); continue; }
      if (count >= LIMITS.ledgerEdits) { ctx.note('ledgerEdits: only ' + LIMITS.ledgerEdits + ' corrections can be kept; ' + (entries.length - i) + ' more were dropped.'); break; }
      const clean = cleanEdit(edit, 'ledgerEdits[' + txnId + ']', ctx);
      if (clean) { out[txnId] = clean; count++; }
    }
    return out;
  }

  // ------------------------------------------------------------------ defaults & sanitize

  function profilePeople(prof) {
    const lists = [isObj(prof.plan) ? prof.plan.people : null, isObj(prof.household) ? prof.household.people : null];
    return PEOPLE.map((id, i) => {
      for (const list of lists) {
        const p = Array.isArray(list) ? list.find(x => isObj(x) && x.id === id && nonEmpty(x.name)) : null;
        if (p) return { id, name: p.name.trim().slice(0, LIMITS.label) };
      }
      return { id, name: DEFAULT_PEOPLE_NAMES[i] };
    });
  }

  /**
   * A complete, valid version-5 State built from the household profile: the profile's plan, the
   * baseline scenario ("Current budget", no changes) followed by the profile's scenarios, and the
   * baseline compared with the first other scenario. Pure: pass { now } for timestamps.
   * @param {object|null} profile household profile (§3); null gives an empty plan
   * @param {object|string|null} dataset the dataset (or its id) this state belongs to
   * @param {{now?: string}} [opts]
   * @returns {object} State
   */
  function defaults(profile, dataset, opts) {
    const now = stampOf(opts && opts.now, EPOCH);
    const prof = isObj(profile) ? profile : {};
    const people = profilePeople(prof);
    const quiet = makeCtx({ dropUnknown: true }); // problems in the profile are not the household's saved data
    const plan = cleanPlan(isObj(prof.plan) ? Object.assign({}, prof.plan, { people }) : undefined, emptyPlan(people), quiet, 'profile.plan');
    const meta = { createdAt: now, updatedAt: now, migratedFrom: null, migrationNotes: [], legacySnapshot: null };
    const baseline = makeBaseline(plan, meta);
    const templates = Array.isArray(prof.scenarios) ? prof.scenarios : [];
    const scenarios = cleanScenarios([baseline].concat(templates), [baseline], plan, meta, quiet);
    return {
      version: VERSION,
      datasetId: datasetIdOf(dataset) || NO_DATA_ID,
      plan,
      scenarios,
      compareIds: defaultCompareIds(scenarios),
      ledgerEdits: {},
      references: [],
      checklist: {},
      ui: { scope: 'joint', lastRoute: '#/overview', whatIf: clone(WHATIF_DEFAULT), plan: clone(PLAN_UI_DEFAULT), dismissed: {} },
      meta
    };
  }

  const STATE_KEYS = ['version', 'datasetId', 'plan', 'scenarios', 'compareIds', 'ledgerEdits', 'references', 'checklist', 'ui', 'meta'];

  function datasetMismatchNote(saved, current) {
    return 'This budget was saved for the data set "' + saved + '" and is now used with "' + current + '". The plan, scenarios and settings apply as they are; corrections to individual transactions only take effect where the same transactions exist.';
  }

  /**
   * Field-by-field validation of a v5-shaped object against `base` (the defaults). The upgrades
   * inside version 5 (V5_UPGRADES) run first, on the raw object; their notes are added, and kept in
   * meta.migrationNotes, after the ui section's own notes.
   */
  function sanitizeState(input, base, ctx, wantDatasetId) {
    const up = upgrade(input);
    const raw = up.raw;
    let meta;
    if (raw.meta === undefined) meta = clone(base.meta);
    else if (!isObj(raw.meta)) { ctx.note('meta: not readable (' + preview(raw.meta) + '); reset.'); meta = clone(base.meta); }
    else meta = cleanFields(raw.meta, META_FIELDS, { path: 'meta', ctx, strict: false, defaults: base.meta });

    const saved = nonEmpty(raw.datasetId) ? raw.datasetId.trim().slice(0, LIMITS.datasetId) : null;
    if (raw.datasetId !== undefined && saved === null) ctx.note('datasetId: ' + preview(raw.datasetId) + ' is not usable; reset.');
    const datasetId = wantDatasetId || saved || base.datasetId;
    if (wantDatasetId && saved && saved !== wantDatasetId) ctx.note(datasetMismatchNote(saved, wantDatasetId));

    if (raw.plan === undefined) ctx.note('plan: missing; using the household profile’s plan.');
    const plan = cleanPlan(raw.plan, base.plan, ctx, 'plan');
    if (raw.scenarios === undefined) ctx.note('scenarios: missing; using the starting scenarios.');
    const scenarios = cleanScenarios(raw.scenarios, base.scenarios, plan, meta, ctx);
    const compareIds = cleanCompareIds(raw.compareIds, scenarios, ctx);
    const ledgerEdits = cleanEdits(raw.ledgerEdits, ctx);
    const references = cleanList(raw.references, REFERENCE_FIELDS, { path: 'references', ctx, max: LIMITS.references, prefix: 'ref', fallback: [], after: referenceOrder });

    let checklist = {};
    if (raw.checklist !== undefined) {
      const res = check(CHECKLIST_RULE, raw.checklist, false);
      if (res.ok) { checklist = res.value; if (res.adjusted) ctx.note('checklist: ' + res.adjusted + '.'); }
      else ctx.note('checklist: not readable (' + preview(raw.checklist) + '); reset.');
    }

    let ui;
    if (raw.ui === undefined) ui = clone(base.ui);
    else if (!isObj(raw.ui)) { ctx.note('ui: not readable (' + preview(raw.ui) + '); reset.'); ui = clone(base.ui); }
    else {
      ui = cleanFields(raw.ui, UI_FIELDS, { path: 'ui', ctx, strict: false, defaults: base.ui });
      if (isObj(ui.plan)) finishPlanUi(ui.plan);
    }
    for (const note of up.notes) {
      ctx.note(note);
      // Recorded like the other migrations, so the household can see what moved where.
      const notes = Array.isArray(meta.migrationNotes) ? meta.migrationNotes : [];
      if (!notes.includes(note)) meta.migrationNotes = notes.concat([note.slice(0, LIMITS.note)]).slice(-LIMITS.migrationNotes);
    }

    const state = { version: VERSION, datasetId, plan, scenarios, compareIds, ledgerEdits, references, checklist, ui, meta };
    for (const k of Object.keys(raw)) if (!STATE_KEYS.includes(k)) keepUnknown(state, raw, k, k, ctx);
    return state;
  }

  /**
   * The last step of checking a saved ui.plan (sanitize and cleanPlanUi): card and bank amounts
   * waiting to be carried over (legacyDials) keep only amounts, and legacyDials is removed when
   * nothing is left. Keys kept as saved (keepUnknown) stay. Changes `planUi` in place.
   */
  function finishPlanUi(planUi) {
    if (!has(planUi, 'legacyDials')) return planUi;
    const kept = {};
    const waiting = planUi.legacyDials;
    if (isObj(waiting)) {
      for (const [k, v] of Object.entries(waiting)) if (!RETIRED_DIALS.includes(k) || Number.isSafeInteger(v)) kept[k] = v;
    }
    if (Object.keys(kept).length) planUi.legacyDials = kept;
    else delete planUi.legacyDials;
    return planUi;
  }

  /**
   * ui.plan as this version reads it, for code that draws it (BudgetEngine.timeline.settings):
   * checked against PLAN_UI like sanitize does, silently. Every field this version knows is
   * present and valid (an invalid value is reset to its default or left out, as sanitize would),
   * fields it does not know are left out, legacyDials keeps only amounts, and legacyDials and
   * cardSplit stay absent unless saved. Never throws; `raw` is not changed. A saved budget is
   * checked by sanitize instead, which names every change and keeps unknown keys.
   * @param {*} raw a ui.plan, saved or not (anything else gives the defaults)
   * @returns {object}
   */
  function cleanPlanUi(raw) {
    if (!isObj(raw)) return clone(PLAN_UI_DEFAULT);
    return finishPlanUi(cleanFields(raw, PLAN_UI_FIELDS, { path: 'ui.plan', ctx: makeCtx({ dropUnknown: true }), strict: false }));
  }

  /**
   * The earlier Home settings (ui.home) become the plan screen's settings (ui.plan): each known
   * amount becomes a dial set directly, baselineMonths and horizon keep their values, and
   * ui.home is dropped. What ui.plan already holds wins, so running this twice changes nothing
   * more. Returns the new raw ui and one note saying what moved.
   */
  function migrateHome(rawUi) {
    const home = rawUi.home;
    const ui = Object.assign({}, rawUi);
    delete ui.home;
    if (!isObj(home)) return { ui, note: 'ui.home: the earlier Home settings were not readable (' + preview(home) + '); dropped.' };
    const plan = isObj(rawUi.plan) ? Object.assign({}, rawUi.plan) : {};
    const dials = isObj(plan.dials) ? Object.assign({}, plan.dials) : {};
    const moved = [];
    const kept = [];
    for (const [from, key] of Object.entries(HOME_TO_DIALS)) {
      const v = home[from];
      if (!Number.isSafeInteger(v)) continue;
      const waiting = isObj(plan.legacyDials) && Number.isSafeInteger(plan.legacyDials[key]);
      if ((has(dials, key) && dials[key] !== null) || waiting) { kept.push(key); continue; }
      dials[key] = v;
      moved.push(key + ' ' + money(v));
    }
    plan.dials = dials;
    for (const k of ['baselineMonths', 'horizon']) {
      if (plan[k] === undefined && home[k] !== undefined && home[k] !== null) { plan[k] = home[k]; moved.push(k + ' ' + preview(home[k])); }
    }
    ui.plan = plan;
    const left = [];
    if (Number.isSafeInteger(home.inCents)) left.push('all money into joint (' + money(home.inCents) + '): the plan now sets each partner’s money in separately');
    if (Number.isSafeInteger(home.outCents)) left.push('the earlier single spending amount (' + money(home.outCents) + '): spending is now planned as essentials, flexible and irregular');
    const note = 'ui.home: the Home settings moved to the plan screen (ui.plan)' + (moved.length ? ': ' + moved.join(', ') : '') + '.'
      + (kept.length ? ' The plan screen already had its own ' + kept.join(', ') + ', which were kept.' : '')
      + (left.length ? ' Not carried over: ' + left.join('; ') + '.' : '');
    return { ui, note };
  }

  /**
   * Card and bank spending were dials set directly; spending is now planned as essentials,
   * flexible and irregular, and card and bank are worked out from those. An amount set for card or
   * bank is moved to ui.plan.legacyDials (an amount saved there before is replaced: the dial is
   * newer), where the plan screen carries it over to the new dials the next time it opens
   * (BudgetEngine.timeline.migrateDials). A blank (null) one held nothing and is removed; one that
   * is not an amount is dropped and named. Returns { ui, note } or null when there is none.
   */
  function migratePlanDials(rawUi) {
    if (!isObj(rawUi) || !isObj(rawUi.plan) || !isObj(rawUi.plan.dials)) return null;
    const found = RETIRED_DIALS.filter(k => has(rawUi.plan.dials, k));
    if (!found.length) return null;
    const dials = Object.assign({}, rawUi.plan.dials);
    for (const k of found) delete dials[k];
    const legacy = isObj(rawUi.plan.legacyDials) ? Object.assign({}, rawUi.plan.legacyDials) : {};
    const kept = [], bad = [];
    for (const k of found) {
      const v = rawUi.plan.dials[k];
      if (Number.isSafeInteger(v) && Math.abs(v) <= E.money.MAX_INPUT_CENTS) { legacy[k] = v; kept.push(k + ' spending ' + money(v)); }
      else if (v !== null) bad.push(k + ' spending ' + preview(v));
    }
    const plan = Object.assign({}, rawUi.plan, { dials });
    if (Object.keys(legacy).length) plan.legacyDials = legacy;
    const ui = Object.assign({}, rawUi, { plan });
    if (!kept.length && !bad.length) return { ui, note: null };
    const note = 'ui.plan.dials: '
      + (kept.length ? kept.join(' and ') + ' set on the plan screen will be carried over to essentials, flexible and irregular spending the next time Plan opens (card and bank spending are now worked out from those).' : '')
      + (bad.length ? (kept.length ? ' ' : '') + bad.join(' and ') + ' set on the plan screen ' + (bad.length > 1 ? 'were not amounts and were' : 'was not an amount and was') + ' dropped.' : '');
    return { ui, note };
  }

  // ------------------------------------------------------------------ upgrades inside version 5
  // Changes to the saved format made after version 5 was first released. VERSION stays 5 (the
  // storage key and every saved budget depend on it), so each entry recognises the earlier shape
  // itself. sanitize runs the entries in order on the raw saved budget, before checking it
  // (upgrade), and records each note in the notes and once in meta.migrationNotes. Rules for
  // every entry (docs/ARCHITECTURE.md §7):
  //   id          a short stable name
  //   applies(raw) whether the raw saved budget still holds the earlier shape (never throws)
  //   apply(raw)  -> { raw, note }: a new raw budget (the input is not changed) and the note saying
  //               what moved where; null only when nothing the household saved changed
  //   - it must be safe to run twice: after apply, applies is false, or apply changes nothing more;
  //   - it must leave a note whenever it changes what the household saved, and that note's text
  //     must never change once released (meta.migrationNotes is matched by text).
  // Upgrades that need the data as well (a built plan) run on the plan screen instead:
  // BudgetEngine.timeline.pendingUpgrade names them.

  /**
   * The Forecast's scenarios become what-ifs on the plan: every event of a scenario other than
   * the baseline is copied once into plan.changes as a planned change tagged with the scenario's
   * name (scenario, ≤ 60 characters), not accepted, with id 'sc-' + the event's id (a change with
   * that id already there is left as it is). Types: recurring -> monthly (expense: essentials or
   * flexible by its category; income +, income_loss −), one_time -> oneTime (expense: irregular;
   * income: income), income_change -> monthly income for the stream's person with the monthly
   * difference to joint when both amounts and the pay frequency are known (else no amount),
   * bill_change and target_change -> monthly with no amount and a note saying what they set.
   * Savings-goal events and events with no (start) month are not copied, and named. The scenarios
   * stay in the budget as they are. ui.plan.scenariosCopied: true marks it done, so it runs once.
   * Returns { raw, note } (note null only when every event was copied before).
   */
  function copyScenarioChanges(raw) {
    const ui = isObj(raw.ui) ? Object.assign({}, raw.ui) : {};
    ui.plan = Object.assign({}, isObj(ui.plan) ? ui.plan : {}, { scenariosCopied: true });
    const done = { raw: Object.assign({}, raw, { ui }), note: null };
    if (!isObj(raw.plan) || !Array.isArray(raw.scenarios) || (raw.plan.changes !== undefined && !Array.isArray(raw.plan.changes))) return done;
    const existing = Array.isArray(raw.plan.changes) ? raw.plan.changes : [];
    const taken = new Set(existing.filter(isObj).map(c => c.id));
    const incomes = Array.isArray(raw.plan.incomes) ? raw.plan.incomes.filter(isObj) : [];
    const bills = Array.isArray(raw.plan.bills) ? raw.plan.bills.filter(isObj) : [];
    const isAmount = v => Number.isSafeInteger(v) && v >= 0 && v <= E.money.MAX_INPUT_CENTS;
    const groupOf = category => (typeof category === 'string' && E.categories.isEssential(category) ? 'essentials' : 'flexible');
    const added = [], skipped = [], perScenario = [];
    for (const s of raw.scenarios) {
      if (!isObj(s) || s.id === BASELINE_ID || !Array.isArray(s.events)) continue;
      const name = (nonEmpty(s.name) ? s.name.trim() : String(s.id || 'Scenario')).slice(0, SCENARIO_TAG_MAX);
      let count = 0;
      for (const ev of s.events) {
        if (!isObj(ev) || !nonEmpty(ev.id)) continue;
        let id = 'sc-' + ev.id.trim();
        if (!isValidId(id)) id = 'sc-' + E.util.hash(ev.id);
        if (taken.has(id)) continue;
        const label = (nonEmpty(ev.label) ? ev.label.trim() : 'Change').slice(0, LIMITS.label);
        const start = ev.type === 'one_time' ? ev.month : ev.startMonth;
        if (ev.type === 'goal' || !['one_time', 'recurring', 'income_change', 'bill_change', 'target_change'].includes(ev.type)) { skipped.push(label + ' (' + (ev.type === 'goal' ? 'a savings goal: add it in Budget' : 'not a dated change') + ')'); continue; }
        if (!E.months.isMonth(start)) { skipped.push(label + ' (no ' + (ev.type === 'one_time' ? 'month' : 'start month') + ' yet)'); continue; }
        if (existing.length + added.length >= LIMITS.planChanges) { skipped.push(label + ' (no room for more planned changes)'); continue; }
        const end = ev.type !== 'one_time' && E.months.isMonth(ev.endMonth) && ev.endMonth >= start ? ev.endMonth : null;
        const item = { id, label, kind: ev.type === 'one_time' ? 'oneTime' : 'monthly', group: 'flexible', personId: null, startMonth: start, endMonth: end, cents: null, accepted: false, template: null, scenario: name };
        let what = '';
        if (ev.type === 'one_time') {
          item.group = ev.direction === 'income' ? 'income' : 'irregular';
          item.cents = isAmount(ev.amountCents) ? ev.amountCents : null;
        } else if (ev.type === 'recurring') {
          const m = isAmount(ev.monthlyCents) ? ev.monthlyCents : null;
          if (ev.direction === 'income' || ev.direction === 'income_loss') { item.group = 'income'; item.cents = m === null ? null : ev.direction === 'income' ? m : 0 - m; } else { item.group = groupOf(ev.category); item.cents = m; }
        } else if (ev.type === 'income_change') {
          const st = incomes.find(i => i.id === ev.streamId) || null;
          item.group = 'income';
          item.personId = st && PEOPLE.includes(st.personId) ? st.personId : null;
          const perYear = st ? lookup(E.schedule.PER_YEAR, st.frequency) : undefined;
          if (st && perYear && has(ev, 'jointPerPaycheckCents') && isAmount(ev.jointPerPaycheckCents) && isAmount(st.jointPerPaycheckCents)) item.cents = Math.round((ev.jointPerPaycheckCents - st.jointPerPaycheckCents) * perYear / 12);
          else what = 'it changes ' + (st && nonEmpty(st.label) ? st.label.trim() : 'an income') + '; enter the monthly change to joint (negative for a drop)';
        } else if (ev.type === 'bill_change') {
          const b = bills.find(x => x.id === ev.billId) || null;
          item.group = 'essentials';
          what = 'it sets ' + (b && nonEmpty(b.label) ? b.label.trim() : 'a bill') + ' to ' + money(isAmount(ev.monthlyCents) ? ev.monthlyCents : null) + ' a month; enter the monthly difference';
        } else {
          item.group = groupOf(ev.category);
          what = 'it sets the ' + (nonEmpty(ev.category) ? ev.category.trim() : 'category') + ' target to ' + money(isAmount(ev.monthlyCents) ? ev.monthlyCents : null) + ' a month; enter the monthly difference';
        }
        item.note = ('Copied from the Forecast scenario “' + name + '”' + (what ? ': ' + what + '.' : '.') + (nonEmpty(ev.note) ? ' ' + ev.note.trim() : '')).slice(0, LIMITS.note);
        added.push(item);
        taken.add(id);
        count += 1;
      }
      if (count) perScenario.push('“' + name + '”: ' + count);
    }
    if (!added.length && !skipped.length) return done;
    const plan = Object.assign({}, raw.plan, { changes: existing.concat(added) });
    const unset = added.filter(c => c.cents === null).length;
    const note = 'plan.changes: ' + (added.length
      ? plural(added.length, 'change') + ' from your Forecast scenarios ' + (added.length === 1 ? 'was' : 'were') + ' copied to the plan’s planned changes, not accepted, each tagged with its scenario (' + perScenario.join(', ') + ')'
        + (unset ? '; ' + unset + ' ' + (unset === 1 ? 'has' : 'have') + ' no amount yet' : '') + '. The scenarios themselves are unchanged.'
      : 'nothing from your Forecast scenarios could be copied to the plan’s planned changes. The scenarios themselves are unchanged.')
      + (skipped.length ? ' Not copied: ' + skipped.join(', ') + '.' : '');
    return { raw: Object.assign({}, done.raw, { plan }), note };
  }

  const withUi = (raw, ui) => Object.assign({}, raw, { ui });
  /** A raw saved budget whose ui (and ui.plan) is absent or an object: an upgrade may add a field there. */
  const planUiOpen = raw => isObj(raw) && (raw.ui === undefined || (isObj(raw.ui) && (raw.ui.plan === undefined || isObj(raw.ui.plan))));
  const V5_UPGRADES = Object.freeze([
    Object.freeze({
      id: 'ui.home', // the earlier Home settings become the plan screen's (migrateHome)
      applies: raw => isObj(raw) && isObj(raw.ui) && has(raw.ui, 'home'),
      apply: raw => { const r = migrateHome(raw.ui); return { raw: withUi(raw, r.ui), note: r.note }; }
    }),
    Object.freeze({
      id: 'ui.plan.dials.card-bank', // card and bank amounts wait in ui.plan.legacyDials (migratePlanDials)
      applies: raw => isObj(raw) && isObj(raw.ui) && isObj(raw.ui.plan) && isObj(raw.ui.plan.dials) && RETIRED_DIALS.some(k => has(raw.ui.plan.dials, k)),
      apply: raw => { const r = migratePlanDials(raw.ui); return r ? { raw: withUi(raw, r.ui), note: r.note } : { raw, note: null }; }
    }),
    Object.freeze({
      // An amount saved for other before investments had a dial of their own still includes them:
      // marked to be split on the plan screen, which knows their baseline (timeline.splitOther,
      // which leaves the note). Budgets saved since carry otherDial already.
      id: 'ui.plan.otherDial',
      applies: raw => isObj(raw) && isObj(raw.ui) && isObj(raw.ui.plan) && !has(raw.ui.plan, 'otherDial') && isObj(raw.ui.plan.dials) && Number.isSafeInteger(raw.ui.plan.dials.other),
      apply: raw => ({
        raw: withUi(raw, Object.assign({}, raw.ui, { plan: Object.assign({}, raw.ui.plan, { otherDial: 'withInvesting' }) })),
        note: 'ui.plan.dials.other: your amount for debt, business and investments (' + money(raw.ui.plan.dials.other) + ') will be split the next time Plan opens, now that investments have a dial of their own.'
      })
    }),
    Object.freeze({
      // The Forecast scenarios' events become what-ifs on the plan, once (copyScenarioChanges).
      // Budgets saved since carry scenariosCopied (true by default), so it never runs again.
      id: 'plan.changes.scenarios',
      applies: raw => planUiOpen(raw) && !(isObj(raw.ui) && isObj(raw.ui.plan) && has(raw.ui.plan, 'scenariosCopied')) && isObj(raw.plan)
        && Array.isArray(raw.scenarios) && raw.scenarios.some(sc => isObj(sc) && sc.id !== BASELINE_ID && Array.isArray(sc.events) && sc.events.length > 0),
      apply: raw => copyScenarioChanges(raw)
    })
  ]);

  /**
   * Run every V5_UPGRADES entry that applies to `raw`, in order. Pure; safe to run twice (the
   * second run applies nothing).
   * @param {*} raw a saved budget (version-5 shape), before it is checked
   * @returns {{raw: *, notes: string[], applied: string[]}} applied: the ids that ran
   */
  function upgrade(raw) {
    let cur = raw;
    const notes = [], applied = [];
    for (const u of V5_UPGRADES) {
      if (!u.applies(cur)) continue;
      const r = u.apply(cur);
      cur = r.raw;
      applied.push(u.id);
      if (r.note) notes.push(r.note);
    }
    return { raw: cur, notes, applied };
  }

  function isWorkbook(d) { return isObj(d) && d.format === WORKBOOK_FORMAT; }

  /** The earlier app's downloaded copies and storage wrappers look like { copyId, state }. */
  function isLegacyWrapper(d) {
    if (!isObj(d) || !isObj(d.state) || has(d, 'format') || has(d, 'plan')) return false;
    return has(d, 'copyId') || Object.keys(d).length === 1;
  }

  /**
   * Validate a saved State (any version-5 shape) field by field. Valid values are kept, invalid
   * ones are reset to their default or dropped, and each change is described in `notes` with the
   * path it concerns. The upgrades inside version 5 (V5_UPGRADES) run first. Keys this version
   * does not know are kept as saved, each named, with one summary note first (keepUnknown).
   * Earlier-version shapes are passed to migrate().
   * @returns {{state: object, notes: string[]}}
   */
  function sanitize(raw, profile, dataset, opts) {
    const ctx = makeCtx();
    let data = raw;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (err) {
        ctx.note('The saved budget could not be read (it is not valid JSON); started from the household profile.');
        return { state: defaults(profile, dataset, opts), notes: ctx.notes };
      }
    }
    if (isWorkbook(data) && isObj(data.state)) data = data.state;
    if (isLegacyWrapper(data) || legacyVersionOf(data) !== null) return migrate(data, profile, dataset, opts);
    const base = defaults(profile, dataset, opts);
    if (!isObj(data)) {
      ctx.note('The saved budget was empty or not readable (' + preview(data) + '); started from the household profile.');
      return { state: base, notes: ctx.notes };
    }
    if (data.version !== VERSION) {
      if (typeof data.version === 'number' && data.version > VERSION) ctx.note('This budget was saved by a newer version of the app (version ' + data.version + '); settings this version does not know were dropped.');
      else ctx.note('version: ' + preview(data.version) + ' is not a known saved-budget version; read as version ' + VERSION + '.');
    }
    const state = sanitizeState(data, base, ctx, datasetIdOf(dataset));
    noteKeptUnknown(ctx);
    return { state, notes: ctx.notes };
  }

  // ------------------------------------------------------------------ legacy migration (v1-v4)

  // Fields that identify a budget saved by the earlier single-page app.
  const LEGACY_MARKERS = ['personAPay', 'personBPay', 'personAAllocation', 'personBContribution', 'personAFrequency',
    'personBFrequency', 'planMode', 'incomeBasis', 'targets', 'forecast', 'healthMode', 'vehicleBFunding',
    'otherIncome', 'otherExpenses', 'childcare', 'babyCosts', 'leaveReduction', 'homeFund', 'emergencyFund',
    'anniversaryFund', 'otherSavings', 'currentCash', 'cashGoal', 'adjustments', 'checks', 'tab'];

  /** Where every earlier-version field goes (documentation; migrate() follows it). */
  const LEGACY_FIELDS = Object.freeze({
    version: 'meta.migratedFrom (0 when the saved budget had no version)',
    personAPay: 'plan.incomes, p1 paycheck: netPerPaycheckCents',
    personAFrequency: 'plan.incomes, p1 paycheck: frequency (frequencyStatus confirmed when set)',
    personAAllocation: 'plan.incomes, p1 paycheck: jointPerPaycheckCents = take-home minus the personal allocation',
    personBPay: 'plan.incomes, p2 paycheck: netPerPaycheckCents',
    personBFrequency: 'plan.incomes, p2 paycheck: frequency',
    personBContribution: 'plan.incomes, p2 contribution: a monthly total (frequency monthly)',
    otherIncome: 'plan.incomes, other income (monthly)',
    otherExpenses: 'plan.targets["Other expenses (migrated)"]',
    incomeBasis: 'plan.settings.incomeTiming (regular -> conservative, average -> average)',
    planMode: 'ui.scope',
    targets: 'plan.targets and plan.bills (see LEGACY_TARGETS)',
    healthMode: 'whether Medical & pharmacy holds a combined medical + dental target',
    healthMigrationNotice: 'display flag of the earlier app (noted, not needed)',
    auditBudgetNotice: 'display flag of the earlier app (noted, not needed)',
    vehicleBFunding: 'plan.bills, p2 car payment: fundedFrom (personal -> p2)',
    emergencyFund: 'plan.savings, emergency cushion: monthlyCents',
    anniversaryFund: 'plan.savings, anniversary: monthlyCents',
    homeFund: 'plan.savings, home projects: monthlyCents',
    otherSavings: 'plan.savings, other savings: monthlyCents',
    cashGoal: 'plan.savings, emergency cushion: targetCents',
    currentCash: 'plan.balances.jointCashCents ("cash available for goals" in the earlier app)',
    childcare: 'scenario "Saved forecast (from earlier version)": recurring childcare cost',
    babyCosts: 'scenario "Saved forecast (from earlier version)": recurring baby costs',
    leaveReduction: 'scenario "Saved forecast (from earlier version)": recurring income_loss',
    forecast: 'scenario "Saved forecast (from earlier version)" (events, assumptions); debtEnds -> plan.bills endMonth',
    adjustments: 'ui.whatIf (airfare -> excludePendingReimbursements, business -> excludeBusinessCandidates)',
    checks: 'checklist',
    tab: 'ui.lastRoute'
  });

  const ENERGY_TARGET = 'Energy (gas + electric, migrated)';
  const OTHER_EXPENSES_TARGET = 'Other expenses (migrated)';
  const SAVED_FORECAST_NAME = 'Saved forecast (from earlier version)';

  /** Earlier target keys that map straight onto a v5 category target. */
  const LEGACY_TARGET_CATEGORIES = Object.freeze({
    groceries: 'Groceries', dining: 'Dining & takeout', shopping: 'Mixed retail', fuel: 'Fuel',
    vehicle: 'Auto maintenance', pets: 'Pets', home: 'Household & hardware', medical: 'Medical & pharmacy',
    dental: 'Dental', travel: 'Travel', subscriptions: 'Subscriptions', entertainment: 'Entertainment',
    municipal: 'Water & sewer', vision: 'Vision', unclassified: 'Uncategorized'
  });

  /** Every earlier target key and where it goes in version 5 (documentation). */
  const LEGACY_TARGETS = Object.freeze(Object.assign({}, LEGACY_TARGET_CATEGORIES, {
    energy: 'target "' + ENERGY_TARGET + '" (no gas/electric split is guessed)',
    mortgage: 'bill mortgage', storeCard: 'bill store-card', vehicleA: 'bill p1-car (paid from p1)',
    student: 'bill p1-student-loans (paid from p1)', vehicleB: 'bill p2-car (paid from vehicleBFunding)',
    lifeInsurance: 'bill life-insurance (planned)',
    phoneInsurance: 'bill "Phone, internet & other insurance (migrated)"',
    cardFee: 'bill "Annual card-fee reserve (migrated)"'
  }));

  const LEGACY_ROUTES = { overview: '#/overview', spending: '#/spending', plan: '#/budget', future: '#/forecast', review: '#/review' };
  const LEGACY_FUNDING = { unknown: 'unknown', personal: 'p2', joint: 'joint' };
  const LEGACY_DEBT_ENDS = ['vehicleA', 'student', 'vehicleB', 'storeCard'];

  /** 1-4 for versioned earlier budgets, 0 for unversioned ones, null for anything else. */
  function legacyVersionOf(d) {
    if (!isObj(d)) return null;
    const v = d.version;
    if (v === 1 || v === 2 || v === 3 || v === 4) return v;
    if (typeof v === 'string' && /^\s*[1-4]\s*$/.test(v)) return Number(v);
    if (v === undefined || v === null) return LEGACY_MARKERS.some(k => has(d, k)) ? 0 : null;
    return null;
  }

  function monthlyEquivalent(s) {
    const per = s.jointPerPaycheckCents !== null ? s.jointPerPaycheckCents : s.netPerPaycheckCents;
    if (per === null) return null;
    if (s.frequency === 'semimonthly') return per * 2;
    if (s.frequency === 'monthly') return per;
    return null; // weekly/biweekly months vary, so there is no exact monthly equivalent
  }

  function describeStream(s) {
    const per = s.jointPerPaycheckCents !== null ? s.jointPerPaycheckCents : s.netPerPaycheckCents;
    const when = lookup({ weekly: 'a week', biweekly: 'every two weeks', semimonthly: 'twice a month', monthly: 'a month' }, s.frequency) || 'per transfer (schedule unknown)';
    return per === null ? 'no amount' : money(per) + ' ' + when;
  }

  /**
   * Map one earlier-version budget onto `state` (a fresh defaults(profile) State), noting every
   * decision. Values the household saved win over the profile; a blank earlier value never
   * erases a known profile value (blank meant "not entered" in the earlier app).
   */
  function runMigration(raw, state, ctx) {
    const plan = state.plan;
    const handled = new Set(['version']);
    const created = new Set(); // objects added by the migration (not from the profile)
    const nameOf = id => { const p = plan.people.find(x => x.id === id); return p ? p.name : id; };

    function step(keys, fn) {
      keys.forEach(k => handled.add(k));
      try { fn(); } catch (err) {
        ctx.note('Could not carry over ' + keys.join(', ') + ' (' + ((err && err.message) || String(err)) + '); the household profile’s values were kept. The earlier values remain in the saved snapshot.');
      }
    }

    /** Earlier amounts are dollars (numbers). Returns { present, cents, invalid }. */
    function amountOf(obj, key, path) {
      if (!has(obj, key) || obj[key] === undefined) return { present: false, cents: null, invalid: false };
      const v = obj[key];
      if (v === null || v === '') return { present: true, cents: null, invalid: false };
      const numeric = (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e8) || (typeof v === 'string' && /^\s*\$?[\d,]*\.?\d+\s*$/.test(v));
      if (numeric) {
        try { return { present: true, cents: E.money.inputToCents(v), invalid: false }; } catch (err) { /* fall through */ }
      }
      ctx.note((path || key) + ': ' + preview(v) + ' is not an amount the earlier version could have saved; not carried over.');
      return { present: true, cents: null, invalid: true };
    }

    /** Apply an earlier amount over the current (profile) value, noting any difference. */
    function apply(what, legacy, current, fromProfile, set) {
      if (!legacy.present || legacy.invalid) return;
      if (legacy.cents === null) {
        if (fromProfile && current !== null && current !== undefined) ctx.note(what + ': blank in the earlier version; kept ' + money(current) + ' from the household profile.');
        else set(null);
        return;
      }
      if (fromProfile && current !== legacy.cents) ctx.note(what + ': kept ' + money(legacy.cents) + ' saved in the earlier version (the household profile has ' + money(current) + ').');
      set(legacy.cents);
    }

    function newIncome(id, fields) { return Object.assign({ id: uniqueIn(plan.incomes, id) }, emptyOf(INCOME_FIELDS), fields); }
    function newBill(id, fields) { return Object.assign({ id: uniqueIn(plan.bills, id) }, emptyOf(BILL_FIELDS), fields); }
    function newGoal(id, fields) { return Object.assign({ id: uniqueIn(plan.savings, id) }, emptyOf(GOAL_FIELDS), fields); }

    function billsText(list) { return list.map(b => '"' + b.label + '" (' + money(b.monthlyCents) + ')').join(' and '); }

    function removeBills(predicate) {
      const removed = plan.bills.filter(predicate);
      if (!removed.length) return removed;
      const ids = new Set(removed.map(b => b.id));
      plan.bills = plan.bills.filter(b => !ids.has(b.id));
      for (const d of plan.debts) if (ids.has(d.paymentBillId)) d.paymentBillId = null;
      return removed;
    }

    // ---- income
    function migratePaycheck(pid, payKey, freqKey, allocKey) {
      const pay = amountOf(raw, payKey);
      const freqPresent = has(raw, freqKey) && raw[freqKey] !== undefined;
      const freq = raw[freqKey];
      const freqKnown = FREQUENCIES.includes(freq);
      if (freqPresent && !freqKnown && freq !== '' && freq !== null) ctx.note(freqKey + ': ' + preview(freq) + ' is not a pay frequency; not carried over.');
      const alloc = allocKey ? amountOf(raw, allocKey) : { present: false };
      let stream = plan.incomes.find(s => s.personId === pid && s.kind === 'paycheck');
      const known = (pay.present && pay.cents !== null) || freqKnown || (alloc.present && alloc.cents !== null);
      if (!stream) {
        if (!known) {
          if (pay.present || freqPresent || alloc.present) ctx.note([payKey, freqKey, allocKey].filter(Boolean).join(', ') + ': blank in the earlier version; nothing to carry over.');
          return;
        }
        if (plan.incomes.length >= LIMITS.incomes) { ctx.note(payKey + ': no room for another income stream; not carried over.'); return; }
        stream = newIncome(pid + '-pay', { label: nameOf(pid) + ' paycheck', personId: pid, kind: 'paycheck', status: 'estimate', note: 'Carried over from the earlier version.' });
        plan.incomes.push(stream);
        created.add(stream);
      }
      const fromProfile = !created.has(stream);
      apply(stream.label + ' take-home per paycheck', pay, stream.netPerPaycheckCents, fromProfile, v => { stream.netPerPaycheckCents = v; });

      if (freqKnown) {
        if (fromProfile && stream.frequency !== freq) ctx.note(stream.label + ' pay frequency: kept "' + freq + '" saved in the earlier version (the household profile has "' + stream.frequency + '").');
        stream.frequency = freq;
        stream.frequencyStatus = 'confirmed';
      } else if (freqPresent) {
        if (fromProfile && stream.frequency !== 'unknown') ctx.note(stream.label + ' pay frequency: blank in the earlier version; kept "' + stream.frequency + '" from the household profile.');
        else { stream.frequency = 'unknown'; stream.frequencyStatus = 'unknown'; }
      }

      if (!allocKey || !alloc.present || alloc.invalid) return;
      // The earlier app stored the personal allocation per paycheck; v5 stores the joint portion.
      const net = stream.netPerPaycheckCents;
      if (alloc.cents === null) {
        if (fromProfile && stream.jointPerPaycheckCents !== null) ctx.note(allocKey + ': blank in the earlier version; kept the household profile’s ' + money(stream.jointPerPaycheckCents) + ' per paycheck reaching joint.');
      } else if (net === null) {
        ctx.note(allocKey + ': the personal allocation of ' + money(alloc.cents) + ' per paycheck cannot become a joint amount while take-home pay is unknown; it is kept in the note of "' + stream.label + '".');
        stream.note = appendNote(stream.note, 'Earlier version: personal allocation ' + money(alloc.cents) + ' per paycheck.');
      } else if (alloc.cents > net) {
        ctx.note(allocKey + ': the personal allocation (' + money(alloc.cents) + ') is more than take-home pay (' + money(net) + '), so the amount reaching joint was not changed. Check both on the Budget page.');
        stream.note = appendNote(stream.note, 'Earlier version: personal allocation ' + money(alloc.cents) + ' per paycheck.');
      } else {
        const joint = net - alloc.cents;
        if (fromProfile && stream.jointPerPaycheckCents !== joint) {
          ctx.note(stream.label + ' amount reaching joint: ' + money(joint) + ' per paycheck (take-home ' + money(net) + ' minus the personal allocation of ' + money(alloc.cents) + ' saved in the earlier version); the household profile has ' + money(stream.jointPerPaycheckCents) + '.');
        }
        stream.jointPerPaycheckCents = joint;
      }
    }

    function migrateContribution() {
      const legacy = amountOf(raw, 'personBContribution');
      if (!legacy.present || legacy.invalid) return;
      let s = plan.incomes.find(x => x.personId === 'p2' && x.kind === 'contribution');
      const what = s ? s.label : nameOf('p2') + ' contribution to joint';
      if (legacy.cents === null) {
        if (s) ctx.note(what + ': blank in the earlier version; kept the household profile’s ' + describeStream(s) + '.');
        else ctx.note('personBContribution: blank in the earlier version; nothing to carry over.');
        return;
      }
      if (s) {
        if (monthlyEquivalent(s) === legacy.cents) {
          ctx.note(what + ': the earlier version’s monthly total (' + money(legacy.cents) + ') matches the household profile (' + describeStream(s) + '); kept the profile’s schedule.');
          return;
        }
        ctx.note(what + ': kept ' + money(legacy.cents) + ' a month saved in the earlier version (the household profile has ' + describeStream(s) + '). The earlier version stored it as a monthly total, so it is carried over as one transfer a month; the real transfer dates are not known.');
        Object.assign(s, { jointPerPaycheckCents: legacy.cents, frequency: 'monthly', frequencyStatus: 'unknown', anchorDate: null, monthlyDay: null, status: 'estimate' });
        s.note = appendNote(s.note, 'Earlier version: ' + money(legacy.cents) + ' a month (monthly total).');
        return;
      }
      if (plan.incomes.length >= LIMITS.incomes) { ctx.note('personBContribution: no room for another income stream; not carried over.'); return; }
      s = newIncome('p2-contribution', {
        label: what, personId: 'p2', kind: 'contribution', jointPerPaycheckCents: legacy.cents,
        frequency: 'monthly', frequencyStatus: 'unknown', status: 'estimate',
        note: 'Carried over from the earlier version, where it was entered as a monthly total. The real transfer dates are not known.'
      });
      plan.incomes.push(s);
      created.add(s);
      ctx.note(what + ': ' + money(legacy.cents) + ' a month carried over from the earlier version as a monthly total (one transfer a month); the real transfer dates are not known.');
    }

    function migrateOtherIncome() {
      const legacy = amountOf(raw, 'otherIncome');
      if (!legacy.present || legacy.invalid) return;
      if (legacy.cents === null) { ctx.note('otherIncome: blank in the earlier version; nothing to carry over.'); return; }
      if (legacy.cents === 0) { ctx.note('otherIncome: $0.00 in the earlier version; no income stream needed.'); return; }
      if (plan.incomes.length >= LIMITS.incomes) { ctx.note('otherIncome: ' + money(legacy.cents) + ' a month could not be added (no room for another income stream).'); return; }
      const s = newIncome('other-income', {
        label: 'Other income (migrated)', personId: null, kind: 'other',
        netPerPaycheckCents: legacy.cents, jointPerPaycheckCents: legacy.cents,
        frequency: 'monthly', frequencyStatus: 'unknown', status: 'estimate',
        note: 'Monthly other income carried over from the earlier version, which counted it in joint money.'
      });
      plan.incomes.push(s);
      ctx.note('Other income: added ' + money(legacy.cents) + ' a month from the earlier version as "Other income (migrated)".');
    }

    function migrateIncomeBasis() {
      if (!has(raw, 'incomeBasis') || raw.incomeBasis === undefined) return;
      const timing = lookup({ regular: 'conservative', average: 'average' }, raw.incomeBasis);
      if (!timing) { ctx.note('incomeBasis: ' + preview(raw.incomeBasis) + ' is not a known income basis; kept "' + plan.settings.incomeTiming + '".'); return; }
      const before = plan.settings.incomeTiming;
      if (before === timing) return;
      ctx.note('Income timing: kept "' + timing + '" from the earlier version’s "' + raw.incomeBasis + '" income basis (the household profile has "' + before + '").');
      plan.settings.incomeTiming = timing;
      // Scenarios that inherited the plan's timing follow it.
      for (const s of state.scenarios) if (s.assumptions.incomeTiming === before) s.assumptions.incomeTiming = timing;
    }

    function migratePlanMode() {
      if (!has(raw, 'planMode') || raw.planMode === undefined) return;
      if (raw.planMode === 'joint' || raw.planMode === 'household') state.ui.scope = raw.planMode;
      else ctx.note('planMode: ' + preview(raw.planMode) + ' is not a known view; kept "' + state.ui.scope + '".');
    }

    // ---- targets and bills
    const billSpecs = {
      mortgage: { ids: ['mortgage'], match: b => b.type === 'housing', make: () => newBill('mortgage', { label: 'Mortgage', category: 'Mortgage', fundedFrom: 'joint', type: 'housing' }) },
      storeCard: { ids: ['store-card'], match: b => b.type === 'debt' && /store/i.test(b.label), make: () => newBill('store-card', { label: 'Store card payment', fundedFrom: 'joint', type: 'debt' }) },
      vehicleA: { ids: ['p1-car'], match: b => b.type === 'debt' && b.fundedFrom === 'p1' && /\b(car|vehicle|auto)\b/i.test(b.label), make: () => newBill('p1-car', { label: nameOf('p1') + ' car payment', fundedFrom: 'p1', type: 'debt' }) },
      student: { ids: ['p1-student-loans'], match: b => b.type === 'debt' && /student|education/i.test(b.label), make: () => newBill('p1-student-loans', { label: nameOf('p1') + ' student loans', fundedFrom: 'p1', type: 'debt' }) },
      vehicleB: { ids: ['p2-car'], match: b => b.type === 'debt' && b.fundedFrom !== 'p1' && /\b(car|vehicle|auto)\b/i.test(b.label), make: () => newBill('p2-car', { label: nameOf('p2') + ' car payment', fundedFrom: lookup(LEGACY_FUNDING, raw.vehicleBFunding) || 'unknown', type: 'debt' }) },
      lifeInsurance: { ids: ['life-insurance'], match: b => b.category === 'Life insurance', make: () => newBill('life-insurance', { label: 'Life insurance', category: 'Life insurance', fundedFrom: 'joint', type: 'insurance', status: 'planned' }) }
    };

    function findBill(spec) { return plan.bills.find(b => spec.ids.includes(b.id)) || plan.bills.find(spec.match) || null; }

    function migrateBill(key, legacy) {
      const spec = billSpecs[key];
      let bill = findBill(spec);
      if (legacy.cents === null) {
        if (bill && bill.monthlyCents !== null) ctx.note(bill.label + ': blank in the earlier version; kept ' + money(bill.monthlyCents) + ' a month from the household profile.');
        else if (!bill) ctx.note('targets.' + key + ': blank in the earlier version; nothing to carry over.');
        return;
      }
      if (!bill) {
        if (plan.bills.length >= LIMITS.bills) { ctx.note('targets.' + key + ': ' + money(legacy.cents) + ' a month could not be added (no room for another bill).'); return; }
        bill = spec.make();
        plan.bills.push(bill);
        created.add(bill);
        bill.monthlyCents = legacy.cents;
        ctx.note('Added the bill "' + bill.label + '" (' + money(legacy.cents) + ' a month) from the earlier version.');
        return;
      }
      if (bill.monthlyCents !== legacy.cents) ctx.note(bill.label + ': kept ' + money(legacy.cents) + ' a month saved in the earlier version (the household profile has ' + money(bill.monthlyCents) + ').');
      bill.monthlyCents = legacy.cents;
    }

    function migrateTarget(key, category, legacy) {
      if (!legacy.present || legacy.invalid) return;
      const exists = has(plan.targets, category);
      const current = exists ? plan.targets[category] : null;
      if (legacy.cents === null) {
        if (exists && current !== null) ctx.note(category + ' target: blank in the earlier version; kept ' + money(current) + ' from the household profile.');
        else if (!exists) plan.targets[category] = null; // keep the blank visible as a missing target
        return;
      }
      if (exists && current !== legacy.cents) ctx.note(category + ' target: kept ' + money(legacy.cents) + ' saved in the earlier version (the household profile has ' + money(current) + ').');
      if (!exists) ctx.note(category + ' target: added ' + money(legacy.cents) + ' from the earlier version (targets.' + key + ').');
      plan.targets[category] = legacy.cents;
    }

    function migrateTargets() {
      if (!has(raw, 'targets') || raw.targets === undefined) return;
      if (!isObj(raw.targets)) { ctx.note('targets: not readable (' + preview(raw.targets) + '); the earlier targets were not carried over.'); return; }
      const t = raw.targets;
      const done = new Set();
      // The earlier app combined medical + dental before version 3 (and when healthMode says so).
      const healthKnown = raw.healthMode === 'combined' || raw.healthMode === 'separate';
      if (has(raw, 'healthMode') && !healthKnown) ctx.note('healthMode: ' + preview(raw.healthMode) + ' is not a known setting; ignored.');
      const combined = raw.healthMode === 'combined' || (!healthKnown && typeof raw.version === 'number' && raw.version < 3 && has(t, 'medical'));

      if (has(t, 'medical')) {
        done.add('medical');
        const medical = amountOf(t, 'medical', 'targets.medical');
        migrateTarget('medical', 'Medical & pharmacy', medical);
        if (combined) {
          done.add('dental');
          const dental = has(t, 'dental') ? amountOf(t, 'dental', 'targets.dental') : null;
          const profileDental = has(plan.targets, 'Dental') ? plan.targets.Dental : null;
          plan.targets.Dental = null;
          ctx.note('Medical & pharmacy: the earlier version kept medical and dental as one combined health target' + (medical.cents !== null ? ' (' + money(medical.cents) + ')' : '') +
            '. The combined target was preserved on Medical & pharmacy, and Dental is left blank so the same money is not counted twice' +
            (profileDental !== null ? ' (the household profile’s Dental target of ' + money(profileDental) + ' is not used)' : '') +
            '. Split it on the Budget page when you know the dental part.');
          if (dental && !dental.invalid && dental.cents !== null) ctx.note('targets.dental: ' + money(dental.cents) + ' was not counted by the earlier version while health was combined; not carried over.');
        }
      }

      if (has(t, 'energy')) {
        done.add('energy');
        const energy = amountOf(t, 'energy', 'targets.energy');
        if (!energy.invalid && energy.cents === null) {
          ctx.note('targets.energy: the combined electricity + natural gas target was blank in the earlier version; nothing to carry over.');
        } else if (!energy.invalid) {
          // Do not guess a gas/electric split: keep the combined amount under its own name and
          // remove the profile's separate targets so energy is not counted twice.
          const replaced = ['Gas & heating', 'Electric'].filter(c => has(plan.targets, c));
          const replacedText = replaced.map(c => c + ' (' + money(plan.targets[c]) + ')').join(' and ');
          replaced.forEach(c => { delete plan.targets[c]; });
          // A profile may hold gas or electric as bills (e.g. budget billing): same overlap.
          const replacedBills = removeBills(b => b.category === 'Gas & heating' || b.category === 'Electric');
          plan.targets[ENERGY_TARGET] = energy.cents;
          ctx.note('Energy: the earlier version had one combined electricity + natural gas target (' + money(energy.cents) + '). It was kept as "' + ENERGY_TARGET + '" instead of guessing a split' +
            (replaced.length ? '; the household profile’s separate ' + replacedText + ' targets were removed so energy is not counted twice' : '') +
            (replacedBills.length ? '; the household profile’s ' + billsText(replacedBills) + (replacedBills.length === 1 ? ' bill was' : ' bills were') + ' removed so energy is not counted twice' : '') +
            '. Split it into Gas & heating and Electric on the Budget page when you can.');
        }
      }

      if (has(t, 'phoneInsurance')) {
        done.add('phoneInsurance');
        const v = amountOf(t, 'phoneInsurance', 'targets.phoneInsurance');
        if (!v.invalid && v.cents === null) {
          ctx.note('targets.phoneInsurance: the combined phone, internet & other insurance allowance was blank in the earlier version; nothing to carry over.');
        } else if (!v.invalid && plan.bills.length < LIMITS.bills) {
          const replaced = removeBills(b => b.category === 'Internet & phone');
          // The same allowance may also sit in the profile as a target for the category.
          const replacedTarget = has(plan.targets, 'Internet & phone') ? plan.targets['Internet & phone'] : undefined;
          if (replacedTarget !== undefined) delete plan.targets['Internet & phone'];
          const bill = newBill('phone-internet-insurance', {
            label: 'Phone, internet & other insurance (migrated)', category: 'Internet & phone', monthlyCents: v.cents,
            fundedFrom: 'joint', type: 'utility', status: 'estimate', note: 'Combined allowance carried over from the earlier version.'
          });
          plan.bills.push(bill);
          created.add(bill);
          const insurance = plan.bills.filter(b => b.type === 'insurance' && b.category !== 'Life insurance');
          ctx.note('Phone, internet & other insurance: kept the earlier version’s combined allowance (' + money(v.cents) + ' a month) as one bill' +
            (replaced.length ? '; the household profile’s ' + billsText(replaced) + (replaced.length === 1 ? ' bill was' : ' bills were') + ' removed so they are not counted twice' : '') +
            (replacedTarget !== undefined ? '; the household profile’s Internet & phone target (' + money(replacedTarget) + ') was removed for the same reason' : '') + '.' +
            (insurance.length ? ' Check whether it also covers ' + insurance.map(b => '"' + b.label + '"').join(' and ') + ', which ' + (insurance.length === 1 ? 'is' : 'are') + ' still listed separately.' : ''));
        } else if (!v.invalid) {
          ctx.note('targets.phoneInsurance: ' + money(v.cents) + ' a month could not be added (no room for another bill).');
        }
      }

      if (has(t, 'cardFee')) {
        done.add('cardFee');
        const v = amountOf(t, 'cardFee', 'targets.cardFee');
        if (!v.invalid && v.cents === null) {
          ctx.note('targets.cardFee: the annual card-fee reserve was blank in the earlier version; nothing to carry over.');
        } else if (!v.invalid && plan.bills.length < LIMITS.bills) {
          // A card-fee bill in the profile is the same fee; remove it before adding the reserve.
          const replacedBills = removeBills(b => b.category === 'Fees & interest');
          const bill = newBill('card-fee-reserve', {
            label: 'Annual card-fee reserve (migrated)', category: 'Fees & interest', monthlyCents: v.cents,
            fundedFrom: 'joint', type: 'other', status: 'estimate', note: 'Monthly reserve for an annual card fee, carried over from the earlier version.'
          });
          plan.bills.push(bill);
          created.add(bill);
          let replaced = '';
          if (has(plan.targets, 'Fees & interest')) {
            replaced = '; the household profile’s Fees & interest target (' + money(plan.targets['Fees & interest']) + ') was removed so the fee is not counted twice';
            delete plan.targets['Fees & interest'];
          }
          if (replacedBills.length) replaced += '; the household profile’s ' + billsText(replacedBills) + (replacedBills.length === 1 ? ' bill was' : ' bills were') + ' removed so the fee is not counted twice';
          ctx.note('Annual card-fee reserve: kept ' + money(v.cents) + ' a month from the earlier version as a bill' + replaced + '.');
        } else if (!v.invalid) {
          ctx.note('targets.cardFee: ' + money(v.cents) + ' a month could not be added (no room for another bill).');
        }
      }

      for (const key of Object.keys(t)) {
        if (done.has(key)) continue;
        const legacy = amountOf(t, key, 'targets.' + key);
        if (has(billSpecs, key)) { if (!legacy.invalid) migrateBill(key, legacy); continue; }
        if (has(LEGACY_TARGET_CATEGORIES, key)) { migrateTarget(key, LEGACY_TARGET_CATEGORIES[key], legacy); continue; }
        if (legacy.invalid) continue;
        const name = key.trim().slice(0, LIMITS.categoryKey);
        if (!name || !isSafeKey(name)) { ctx.note('targets: an entry with a blank name (' + preview(t[key]) + ') was not carried over.'); continue; }
        plan.targets[name] = legacy.cents;
        ctx.note('targets.' + key + ': not a category this version knows; kept as its own target "' + name + '" (' + money(legacy.cents) + '). Rename or merge it on the Budget page.');
      }
    }

    function migrateVehicleBFunding() {
      if (!has(raw, 'vehicleBFunding') || raw.vehicleBFunding === undefined) return;
      const funded = lookup(LEGACY_FUNDING, raw.vehicleBFunding);
      if (!funded) { ctx.note('vehicleBFunding: ' + preview(raw.vehicleBFunding) + ' is not a known choice; not carried over.'); return; }
      const bill = findBill(billSpecs.vehicleB);
      if (!bill) {
        if (funded !== 'unknown') ctx.note('vehicleBFunding: "' + raw.vehicleBFunding + '" was saved, but there is no ' + nameOf('p2') + ' car payment to attach it to; not carried over.');
        return;
      }
      if (bill.fundedFrom === funded) return;
      if (funded === 'unknown') {
        if (!created.has(bill)) ctx.note(bill.label + ': who pays it was "unknown" in the earlier version; kept "' + bill.fundedFrom + '" from the household profile.');
        return;
      }
      if (!created.has(bill)) ctx.note(bill.label + ': paid from "' + funded + '" as saved in the earlier version (the household profile has "' + bill.fundedFrom + '").');
      bill.fundedFrom = funded;
    }

    function migrateOtherExpenses() {
      const legacy = amountOf(raw, 'otherExpenses');
      if (!legacy.present || legacy.invalid) return;
      if (legacy.cents === null) { ctx.note('otherExpenses: the "other missing household expenses" allowance was blank in the earlier version; nothing to carry over.'); return; }
      if (legacy.cents === 0) { ctx.note('otherExpenses: $0.00 in the earlier version; no target needed.'); return; }
      plan.targets[OTHER_EXPENSES_TARGET] = legacy.cents;
      ctx.note('Other expenses: kept the earlier version’s allowance for other household expenses (' + money(legacy.cents) + ' a month) as the target "' + OTHER_EXPENSES_TARGET + '".');
    }

    // ---- savings, cash
    const goalSpecs = [
      ['emergencyFund', { ids: ['emergency'], match: /emergency|cushion/i, label: 'Emergency cushion' }],
      ['anniversaryFund', { ids: ['anniversary-trip', 'anniversary'], match: /anniversary/i, label: 'Anniversary fund' }],
      ['homeFund', { ids: ['home-projects'], match: /home/i, label: 'Home projects fund' }],
      ['otherSavings', { ids: ['other-savings'], match: null, label: 'Other savings (migrated)' }]
    ];
    const findGoal = spec => plan.savings.find(g => spec.ids.includes(g.id)) || (spec.match ? plan.savings.find(g => spec.match.test(g.label)) : null) || null;

    function goalFor(spec, why) {
      let goal = findGoal(spec);
      if (goal) return goal;
      if (plan.savings.length >= LIMITS.savings) { ctx.note(why + ': no room for another savings goal; not carried over.'); return null; }
      goal = newGoal(spec.ids[0], { label: spec.label, note: 'Created from the earlier version.' });
      plan.savings.push(goal);
      created.add(goal);
      return goal;
    }

    function migrateSavings() {
      for (const [key, spec] of goalSpecs) {
        const legacy = amountOf(raw, key);
        if (!legacy.present || legacy.invalid) continue;
        const existing = findGoal(spec);
        if (legacy.cents === null) {
          if (existing && existing.monthlyCents !== null) ctx.note(existing.label + ' monthly saving: blank in the earlier version; kept ' + money(existing.monthlyCents) + ' from the household profile.');
          else if (!existing) ctx.note(key + ': blank in the earlier version; nothing to carry over.');
          continue;
        }
        if (!existing && legacy.cents === 0) { ctx.note(key + ': $0.00 a month in the earlier version; no savings goal needed.'); continue; }
        const goal = goalFor(spec, key);
        if (!goal) continue;
        if (created.has(goal)) ctx.note('Added the savings goal "' + goal.label + '" with ' + money(legacy.cents) + ' a month from the earlier version; its target is not set.');
        else if (goal.monthlyCents !== legacy.cents) ctx.note(goal.label + ' monthly saving: kept ' + money(legacy.cents) + ' saved in the earlier version (the household profile has ' + money(goal.monthlyCents) + ').');
        goal.monthlyCents = legacy.cents;
      }
      const cashGoal = amountOf(raw, 'cashGoal');
      if (cashGoal.present && !cashGoal.invalid) {
        const spec = goalSpecs[0][1];
        const existing = findGoal(spec);
        if (cashGoal.cents === null) {
          if (existing && existing.targetCents !== null) ctx.note(existing.label + ' target: the earlier cash goal was blank; kept ' + money(existing.targetCents) + ' from the household profile.');
          else if (!existing) ctx.note('cashGoal: blank in the earlier version; nothing to carry over.');
        } else {
          const goal = goalFor(spec, 'cashGoal');
          if (goal) {
            if (!created.has(goal) && goal.targetCents !== cashGoal.cents) ctx.note(goal.label + ' target: kept the earlier version’s cash goal of ' + money(cashGoal.cents) + ' (the household profile has ' + money(goal.targetCents) + ').');
            goal.targetCents = cashGoal.cents;
          }
        }
      }
    }

    function migrateCash() {
      const cash = amountOf(raw, 'currentCash');
      if (!cash.present || cash.invalid) return;
      const current = plan.balances.jointCashCents;
      if (cash.cents === null) {
        if (current !== null) ctx.note('Joint cash: blank in the earlier version; kept ' + money(current) + ' from the household profile.');
        return;
      }
      // The earlier version never recorded when its cash figure was true, so a profile balance
      // date only stays when the amount is the same fact.
      const staleDate = cash.cents !== current ? plan.balances.asOf : null;
      plan.balances.jointCashCents = cash.cents;
      if (staleDate) plan.balances.asOf = null;
      plan.balances.note = appendNote(plan.balances.note, 'Carried over from the earlier version’s "cash available for goals".');
      ctx.note('Joint cash: set to ' + money(cash.cents) + ' from what the earlier version called "cash available for goals"' + (current !== null ? ' (the household profile has ' + money(current) + ')' : '') +
        (staleDate ? '; the profile’s balance date ' + staleDate + ' belongs to its own amount, so it was cleared' : '') +
        '. Check that it matches the joint accounts and enter the date it was true.');
    }

    // ---- forecast -> scenario
    function migrateForecast() {
      const f = raw.forecast;
      if (f !== undefined && f !== null && !isObj(f)) ctx.note('forecast: not readable (' + preview(f) + '); the earlier forecast settings were not carried over.');
      const fc = isObj(f) ? f : {};
      const seen = new Set();
      const monthOf = key => {
        seen.add(key);
        const v = fc[key];
        if (v === undefined || v === null || v === '') return null;
        if (E.months.isMonth(v)) return v;
        ctx.note('forecast.' + key + ': ' + preview(v) + ' is not a month; left blank.');
        return null;
      };
      const events = [];
      const fromEarlier = (base, start, cents) => base + (start ? '' : ' Start month not set yet.') + (cents === null ? ' Amount not entered yet.' : '');

      const childcare = amountOf(raw, 'childcare');
      const childcareStart = monthOf('childcareStart');
      if ((childcare.present && !childcare.invalid) || childcareStart) {
        events.push({ type: 'recurring', label: 'Childcare', startMonth: childcareStart, endMonth: null, monthlyCents: childcare.cents, direction: 'expense', category: 'Baby & childcare', note: fromEarlier('From the earlier version.', childcareStart, childcare.cents) });
      }
      const baby = amountOf(raw, 'babyCosts');
      const babyStart = monthOf('babyStart');
      if ((baby.present && !baby.invalid) || babyStart) {
        events.push({ type: 'recurring', label: 'Other baby costs', startMonth: babyStart, endMonth: null, monthlyCents: baby.cents, direction: 'expense', category: 'Baby & childcare', note: fromEarlier('From the earlier version.', babyStart, baby.cents) });
      }

      const leave = amountOf(raw, 'leaveReduction');
      const leaveStart = monthOf('leaveStart');
      seen.add('leaveMonths');
      let leaveMonths = 0;
      if (fc.leaveMonths !== undefined && fc.leaveMonths !== null && fc.leaveMonths !== '') {
        if (Number.isInteger(fc.leaveMonths) && fc.leaveMonths >= 0 && fc.leaveMonths <= 120) leaveMonths = fc.leaveMonths;
        else ctx.note('forecast.leaveMonths: ' + preview(fc.leaveMonths) + ' is not a number of months; treated as no leave.');
      }
      const leaveCents = leave.invalid ? null : leave.cents;
      if (leaveMonths > 0) {
        // The earlier forecast lowered income for leaveMonths months starting at leaveStart.
        const end = leaveStart ? E.months.add(leaveStart, leaveMonths - 1) : null;
        events.push({
          type: 'recurring', label: 'Parental leave: lower income', startMonth: leaveStart, endMonth: end, monthlyCents: leaveCents,
          direction: 'income_loss', category: null,
          note: 'From the earlier version: ' + plural(leaveMonths, 'month') + ' of reduced income.' + (leaveStart ? '' : ' Start month not set yet, so the end month is blank too.') + (leaveCents === null ? ' Amount not entered yet.' : '')
        });
      } else if ((leaveCents !== null && leaveCents > 0) || leaveStart) {
        ctx.note('Parental leave: ' + (leaveCents ? money(leaveCents) + ' a month of lower income' : 'a leave start of ' + leaveStart) + ' was saved with a leave length of 0 months, so the earlier forecast never applied it. Not carried over; add the leave dates to a scenario if it still applies.');
      }

      seen.add('oneoffs');
      if (fc.oneoffs !== undefined && fc.oneoffs !== null) {
        if (!Array.isArray(fc.oneoffs)) ctx.note('forecast.oneoffs: not a list (' + preview(fc.oneoffs) + '); not carried over.');
        else fc.oneoffs.forEach((o, i) => {
          if (!isObj(o)) { ctx.note('forecast.oneoffs[' + i + ']: not a valid one-off cost (' + preview(o) + '); not carried over.'); return; }
          const amount = amountOf(o, 'amount', 'forecast.oneoffs[' + i + '].amount');
          let month = null;
          if (o.month !== undefined && o.month !== null && o.month !== '') {
            if (E.months.isMonth(o.month)) month = o.month;
            else ctx.note('forecast.oneoffs[' + i + '].month: ' + preview(o.month) + ' is not a month; left blank.');
          }
          const lbl = nonEmpty(o.label) ? o.label.trim().slice(0, LIMITS.label) : 'One-off cost';
          const cents = amount.invalid ? null : amount.cents;
          events.push({
            type: 'one_time', label: lbl, month, amountCents: cents, direction: 'expense', category: null, goalId: null,
            note: 'From the earlier version.' + (month ? '' : ' Month not set yet.') + (cents === null ? ' Amount not entered yet.' : '')
          });
          for (const k of Object.keys(o)) if (!['label', 'amount', 'month'].includes(k)) ctx.note('forecast.oneoffs[' + i + '].' + k + ': not used by this version; not carried over (' + preview(o[k]) + ').');
        });
      }

      seen.add('debtEnds');
      if (fc.debtEnds !== undefined && fc.debtEnds !== null) {
        if (!isObj(fc.debtEnds)) ctx.note('forecast.debtEnds: not readable (' + preview(fc.debtEnds) + '); final payment months were not carried over.');
        else for (const [k, v] of Object.entries(fc.debtEnds)) {
          if (!LEGACY_DEBT_ENDS.includes(k)) { ctx.note('forecast.debtEnds.' + k + ': not a debt this version knows; not carried over (' + preview(v) + ').'); continue; }
          if (v === '' || v === null || v === undefined) continue;
          if (!E.months.isMonth(v)) { ctx.note('forecast.debtEnds.' + k + ': ' + preview(v) + ' is not a month; not carried over.'); continue; }
          const bill = findBill(billSpecs[k]);
          if (!bill) { ctx.note('forecast.debtEnds.' + k + ': the final payment month ' + v + ' has no matching bill; not carried over.'); continue; }
          if (bill.startMonth && v < bill.startMonth) { ctx.note(bill.label + ': the earlier final payment month ' + v + ' is before the bill starts (' + bill.startMonth + '); not carried over.'); continue; }
          if (bill.endMonth && bill.endMonth !== v) ctx.note(bill.label + ': kept the final payment month ' + v + ' from the earlier version (the household profile has ' + bill.endMonth + ').');
          else ctx.note(bill.label + ': final payment month ' + v + ' carried over from the earlier forecast; the bill stops after it.');
          bill.endMonth = v;
        }
      }

      const assumptions = defaultAssumptions(plan);
      // The earlier forecast counted pay with the budget's income basis; keep that for this scenario.
      if (plan && plan.settings && ['conservative', 'average'].includes(plan.settings.incomeTiming)) assumptions.incomeTiming = plan.settings.incomeTiming;
      for (const [key, target] of [['incomeGrowth', 'incomeGrowthPct'], ['expenseGrowth', 'costGrowthPct'], ['cashYield', 'annualReturnPct']]) {
        seen.add(key);
        const v = fc[key];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 20) assumptions[target] = v;
        else ctx.note('forecast.' + key + ': ' + preview(v) + ' is not a percentage from 0 to 20; not carried over.');
      }

      seen.add('start');
      seen.add('months');
      if ((fc.start !== undefined && fc.start !== '') || fc.months !== undefined) {
        ctx.note('The earlier forecast’s start month (' + (fc.start ? preview(fc.start) : 'not set') + ') and length (' + (fc.months !== undefined ? preview(fc.months) + ' months' : 'not set') + ') were not carried over; the Forecast page chooses its own range.');
      }
      for (const k of Object.keys(fc)) if (!seen.has(k)) ctx.note('forecast.' + k + ': not used by this version; not carried over (' + preview(fc[k]) + ').');

      const changedAssumptions = assumptions.incomeGrowthPct !== 0 || assumptions.costGrowthPct !== 0 || assumptions.annualReturnPct !== 0;
      if (!events.length && !changedAssumptions) {
        if (isObj(f)) ctx.note('The earlier forecast had no baby, leave or one-off costs and no growth assumptions, so no scenario was needed.');
        return;
      }
      if (state.scenarios.length >= LIMITS.scenarios) { ctx.note('The earlier forecast could not become a scenario: there is no room for another scenario.'); return; }
      const id = uniqueIn(state.scenarios, 'saved-forecast');
      const eventIds = new Set();
      for (const s of state.scenarios) for (const ev of s.events) eventIds.add(ev.id);
      if (events.length > LIMITS.events) {
        ctx.note('The earlier forecast had ' + events.length + ' changes; a scenario holds only ' + LIMITS.events + ' changes, so ' + plural(events.length - LIMITS.events, 'change') + ' were not carried over (' + labelsOf(events.slice(LIMITS.events)) + '). They remain in the earlier-version snapshot.');
      }
      const withIds = events.slice(0, LIMITS.events).map((ev, i) => {
        let evId = id + '-' + (i + 1);
        if (eventIds.has(evId)) evId = suffixed(evId, eventIds);
        eventIds.add(evId);
        return Object.assign({ id: evId }, ev);
      });
      state.scenarios.push({
        id, name: SAVED_FORECAST_NAME,
        description: 'Baby, leave and one-off costs and growth assumptions saved in the earlier version of this app. Blank amounts and months stay blank until you enter them.',
        createdAt: state.meta.createdAt, updatedAt: state.meta.updatedAt, events: withIds, assumptions
      });
      if (state.compareIds.length < LIMITS.compareIds && !state.compareIds.includes(id)) state.compareIds.push(id);
      const incomplete = withIds.filter(ev => (ev.type === 'one_time' ? ev.amountCents === null || ev.month === null : ev.monthlyCents === null || ev.startMonth === null)).length;
      ctx.note('Created the scenario "' + SAVED_FORECAST_NAME + '" with ' + plural(withIds.length, 'change') + ' from the earlier forecast' +
        (incomplete ? '; ' + incomplete + ' still need an amount or a month (blank amounts are reported as missing, not counted as $0)' : '') + '.');
    }

    // ---- display settings
    function migrateAdjustments() {
      if (!has(raw, 'adjustments') || raw.adjustments === undefined) return;
      if (!isObj(raw.adjustments)) { ctx.note('adjustments: not readable (' + preview(raw.adjustments) + '); not carried over.'); return; }
      const map = { airfare: 'excludePendingReimbursements', business: 'excludeBusinessCandidates' };
      for (const [k, v] of Object.entries(raw.adjustments)) {
        if (!has(map, k)) { ctx.note('adjustments.' + k + ': not used by this version; not carried over (' + preview(v) + ').'); continue; }
        if (typeof v !== 'boolean') { ctx.note('adjustments.' + k + ': ' + preview(v) + ' is not yes/no; not carried over.'); continue; }
        state.ui.whatIf[map[k]] = v;
      }
    }

    function migrateChecks() {
      if (!has(raw, 'checks') || raw.checks === undefined) return;
      if (!isObj(raw.checks)) { ctx.note('checks: not readable (' + preview(raw.checks) + '); the checklist was not carried over.'); return; }
      for (const [k, v] of Object.entries(raw.checks)) {
        const key = k.trim();
        if (!key || key.length > LIMITS.label || !isSafeKey(key) || typeof v !== 'boolean') { ctx.note('checks.' + k + ': ' + preview(v) + ' is not a checklist tick; not carried over.'); continue; }
        if (Object.keys(state.checklist).length >= LIMITS.checklist) { ctx.note('checks: only ' + LIMITS.checklist + ' checklist ticks can be kept; "' + key + '" was not carried over.'); continue; }
        state.checklist[key] = v;
      }
    }

    function migrateTab() {
      if (!has(raw, 'tab') || raw.tab === undefined) return;
      if (has(LEGACY_ROUTES, raw.tab)) state.ui.lastRoute = LEGACY_ROUTES[raw.tab];
      else ctx.note('tab: ' + preview(raw.tab) + ' is not a page this version has; the app opens on Overview.');
    }

    step(['personAPay', 'personAFrequency', 'personAAllocation'], () => migratePaycheck('p1', 'personAPay', 'personAFrequency', 'personAAllocation'));
    step(['personBPay', 'personBFrequency'], () => migratePaycheck('p2', 'personBPay', 'personBFrequency', null));
    step(['personBContribution'], migrateContribution);
    step(['otherIncome'], migrateOtherIncome);
    step(['incomeBasis'], migrateIncomeBasis);
    step(['planMode'], migratePlanMode);
    step(['targets', 'healthMode'], migrateTargets);
    step(['vehicleBFunding'], migrateVehicleBFunding);
    step(['otherExpenses'], migrateOtherExpenses);
    step(['emergencyFund', 'anniversaryFund', 'homeFund', 'otherSavings', 'cashGoal'], migrateSavings);
    step(['currentCash'], migrateCash);
    step(['forecast', 'childcare', 'babyCosts', 'leaveReduction'], migrateForecast);
    step(['adjustments'], migrateAdjustments);
    step(['checks'], migrateChecks);
    step(['tab'], migrateTab);
    step(['healthMigrationNotice', 'auditBudgetNotice'], () => {
      const flags = ['healthMigrationNotice', 'auditBudgetNotice'].filter(k => has(raw, k));
      if (flags.length) ctx.note(flags.join(' and ') + ': one-time notices of the earlier app; not needed in this version.');
    });
    for (const k of Object.keys(raw)) {
      if (!handled.has(k)) ctx.note(k + ': not used by this version; not carried over (it was ' + preview(raw[k]) + '). It is kept in the earlier-version snapshot.');
    }
  }

  function migrationFallback(profile, dataset, opts, ctx) {
    const state = defaults(profile, dataset, opts);
    state.meta.migrationNotes = ctx.notes.slice(0, LIMITS.migrationNotes).map(n => n.slice(0, LIMITS.note));
    return { state, notes: ctx.notes };
  }

  /**
   * Carry a budget saved by the earlier app (saved-state versions 1-4, or unversioned) over to
   * version 5. Accepts the saved object, its JSON text, or the { copyId, state } wrapper used by
   * downloaded copies. Every earlier field is either mapped (see LEGACY_FIELDS) or named in the
   * notes. The raw text is kept in meta.legacySnapshot (capped) and meta.migratedFrom records the
   * earlier version (0 when unversioned). Never throws: unreadable input gives the defaults and
   * a note. A version-5 state is passed to sanitize instead.
   * @returns {{state: object, notes: string[]}}
   */
  function migrate(raw, profile, dataset, opts) {
    const ctx = makeCtx();
    const text = typeof raw === 'string' ? raw : null;
    let data = raw;
    if (text !== null) {
      try { data = JSON.parse(text); } catch (err) {
        ctx.note('The budget saved by the earlier version could not be read (it is not valid JSON). Started from the household profile; the earlier data was not changed.');
        return migrationFallback(profile, dataset, opts, ctx);
      }
    }
    try {
      let wrapper = null;
      if (isLegacyWrapper(data)) {
        wrapper = data;
        data = data.state;
        ctx.note('Read the budget from a copy saved by the earlier version' + (nonEmpty(wrapper.copyId) ? ' (copy "' + wrapper.copyId.slice(0, 60) + '")' : '') + '.');
      }
      if (isObj(data) && data.version === VERSION) {
        const r = sanitize(data, profile, dataset, opts);
        return { state: r.state, notes: ctx.notes.concat(r.notes) };
      }
      const version = legacyVersionOf(data);
      if (version === null) {
        ctx.note('This does not look like a budget saved by the earlier version (' + preview(data) + '). Nothing was carried over; started from the household profile.');
        return migrationFallback(profile, dataset, opts, ctx);
      }
      const state = defaults(profile, dataset, opts);
      runMigration(data, state, ctx);

      let snapshot = text !== null ? text : safeStringify(wrapper || data);
      if (snapshot !== null && snapshot.length > LIMITS.legacySnapshot) {
        ctx.note('The earlier saved data is ' + snapshot.length + ' characters long; only the first ' + LIMITS.legacySnapshot + ' are kept as a snapshot.');
        snapshot = snapshot.slice(0, LIMITS.legacySnapshot);
      }
      state.meta.migratedFrom = version;
      state.meta.legacySnapshot = snapshot;

      // Final pass through the v5 validator guarantees a valid State; it should find nothing.
      const check2 = makeCtx();
      const clean = sanitizeState(state, defaults(profile, dataset, opts), check2, datasetIdOf(dataset));
      check2.notes.forEach(n => ctx.note('Adjusted after carrying over: ' + n));
      clean.meta.migrationNotes = ctx.notes.slice(0, LIMITS.migrationNotes).map(n => n.slice(0, LIMITS.note));
      return { state: clean, notes: ctx.notes };
    } catch (err) {
      ctx.note('Carrying over the earlier version stopped unexpectedly (' + ((err && err.message) || String(err)) + '). Started from the household profile; the earlier data was not changed.');
      return migrationFallback(profile, dataset, opts, ctx);
    }
  }

  // ------------------------------------------------------------------ workbooks

  /**
   * Serialize a State as a workbook file: JSON { format, version: 5, exportedAt, datasetId, state }.
   * @param {object} state
   * @param {{datasetId?: string, now?: string}} [opts] now = export time (ISO); defaults to meta.updatedAt
   * @returns {string}
   */
  function exportWorkbook(state, opts) {
    const o = opts || {};
    if (!isObj(state) || !isObj(state.plan)) fail('There is no budget to export.');
    const exportedAt = stampOf(o.now, isObj(state.meta) ? state.meta.updatedAt : null);
    const datasetId = nonEmpty(o.datasetId) ? o.datasetId : (nonEmpty(state.datasetId) ? state.datasetId : NO_DATA_ID);
    return JSON.stringify({ format: WORKBOOK_FORMAT, version: VERSION, exportedAt, datasetId, state }, null, 2);
  }

  /**
   * Read the saved budget embedded in a page downloaded from the earlier app:
   * <script id="budget-state" type="application/json">…</script>. Returns the JSON text (the
   * page escapes "<" as <, which JSON.parse restores) or null when there is none.
   */
  function extractEmbeddedState(html) {
    if (typeof html !== 'string') return null;
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (/\bid\s*=\s*(["']?)budget-state\1(?=[\s>\/]|$)/i.test(m[1])) return m[2].trim();
    }
    return null;
  }

  /**
   * Import a workbook or an earlier saved budget. Accepts (a) a workbook file, (b) a bare v5
   * State, (c) an earlier-version saved state, (d) the earlier { copyId, state } wrapper and (e)
   * a page downloaded from the earlier app. Throws a ValidationError with a friendly message for
   * files that cannot be read; otherwise returns the State plus notes on everything adjusted.
   * @returns {{state: object, notes: string[]}}
   */
  function importWorkbook(text, profile, dataset, opts) {
    if (typeof text !== 'string') fail('Choose a budget workbook file to import.');
    if (text.length > LIMITS.workbookChars) fail('This file is too large to be a budget workbook.');
    const trimmed = text.replace(/^﻿/, '').trim();
    if (!trimmed) fail('This file is empty.');
    let jsonText = trimmed;
    const notes = [];
    if (trimmed[0] === '<') {
      const embedded = extractEmbeddedState(trimmed);
      if (embedded === null) fail('This web page does not contain a saved budget. Choose a workbook (.json) file, or a budget page downloaded from the earlier version of this app.');
      jsonText = embedded;
      notes.push('Read the budget saved inside a page downloaded from the earlier version. Transactions stored in that page were not imported; load data files on the Data page.');
    }
    let data;
    try { data = JSON.parse(jsonText); } catch (err) {
      fail(notes.length ? 'The saved budget inside this page is damaged and could not be read.' : 'This file is not a budget workbook: it could not be read as JSON.');
    }
    if (!isObj(data)) fail('This file is not a budget workbook.');
    // A page built by the earlier app embeds { copyId, state: null } until its Download button
    // saves the budget into it; its changes lived in that browser's storage instead.
    if (has(data, 'copyId') && has(data, 'state') && data.state === null) {
      fail('This page from the earlier version has no saved budget inside: its changes were kept in the browser where it was used. Open this app in that browser to carry them over, or use the earlier page’s Download button and import the downloaded copy.');
    }

    let result;
    if (isWorkbook(data)) {
      if (typeof data.version !== 'number' || data.version > VERSION) fail('This workbook was saved by a newer version of the app. Update the app, then import it again.');
      if (!isObj(data.state)) fail('This workbook has no budget inside.');
      if (isIso(data.exportedAt)) notes.push('Workbook exported ' + data.exportedAt.slice(0, 10) + '.');
      const inner = Object.assign({}, data.state);
      if (!nonEmpty(inner.datasetId) && nonEmpty(data.datasetId)) inner.datasetId = data.datasetId;
      const current = datasetIdOf(dataset);
      const labelled = nonEmpty(data.datasetId) ? data.datasetId.trim() : null;
      if (labelled && nonEmpty(inner.datasetId) && labelled !== inner.datasetId.trim()) {
        notes.push('The workbook is labelled for data set "' + labelled + '" but its budget was saved with "' + inner.datasetId.trim() + '"; corrections are matched to transactions by id, so check them after importing.');
      } else if (labelled && current && labelled !== current) {
        notes.push('This workbook was made for data set "' + labelled + '", not the one open now ("' + current + '"). The plan and scenarios still apply; corrections only apply to transactions that are in both.');
      }
      result = sanitize(inner, profile, dataset, opts);
    } else if (data.version === VERSION && isObj(data.plan)) {
      result = sanitize(data, profile, dataset, opts);
    } else if (isLegacyWrapper(data) || legacyVersionOf(data) !== null) {
      result = migrate(jsonText, profile, dataset, opts);
    } else {
      fail('This file was not recognised as a budget workbook or as a budget saved by the earlier version.');
    }
    return { state: result.state, notes: notes.concat(result.notes) };
  }

  // ------------------------------------------------------------------ scenario operations
  // Pure: each returns a deep copy; the input State is never modified.

  function requireState(state) {
    if (!isObj(state) || !Array.isArray(state.scenarios) || !isObj(state.plan)) fail('The budget is not loaded yet.');
    return clone(state);
  }

  function findScenario(state, id) {
    const s = state.scenarios.find(x => x.id === id);
    if (!s) fail('That scenario no longer exists.', 'scenarioId');
    return s;
  }

  function scenarioName(name, state, exceptId) {
    const res = check(SCENARIO_FIELDS[0][1], name, true);
    if (!res.ok) fail(res.message, 'name');
    // Names identify scenarios in side-by-side comparisons, so each one must be different.
    const key = String(res.value).trim().toLowerCase();
    if (state && state.scenarios.some(x => x.id !== exceptId && String(x.name || '').trim().toLowerCase() === key)) {
      fail('Another scenario is already called "' + res.value + '". Choose a different name so they can be told apart.', 'name');
    }
    return res.value;
  }

  function allEventIds(state) {
    const ids = new Set();
    for (const s of state.scenarios) for (const ev of s.events || []) ids.add(ev.id);
    return ids;
  }

  function touch(state, scenario, now) {
    if (!isIso(now)) return;
    if (scenario) scenario.updatedAt = now;
    if (isObj(state.meta)) state.meta.updatedAt = now;
  }

  /**
   * Add a scenario. With { copyFrom } its changes and assumptions are deep-copied from another
   * scenario, each change getting a new id (nothing is shared). The new scenario goes last.
   * @param {object} state
   * @param {string} name
   * @param {{copyFrom?: string, id?: string, description?: string, now?: string}} [opts]
   */
  function addScenario(state, name, opts) {
    const o = opts || {};
    const next = requireState(state);
    const nm = scenarioName(name, next);
    if (next.scenarios.length >= LIMITS.scenarios) fail('You can keep up to ' + LIMITS.scenarios + ' scenarios. Delete one you no longer need first.');
    const taken = new Set(next.scenarios.map(s => s.id));
    let id;
    if (o.id !== undefined) {
      if (!isValidId(o.id) || taken.has(o.id)) fail('That scenario id is not available.', 'id');
      id = o.id;
    } else {
      id = freshId('scenario', nm + '|' + next.scenarios.length + '|' + Array.from(taken).join(','), taken);
    }
    const now = stampOf(o.now, next.meta && next.meta.updatedAt);
    let description = '';
    if (o.description !== undefined) {
      const res = check(NOTE, o.description, true);
      if (!res.ok) fail(res.message, 'description');
      description = res.value;
    }
    let events = [];
    let assumptions = defaultAssumptions(next.plan);
    if (o.copyFrom !== undefined && o.copyFrom !== null) {
      const src = findScenario(next, o.copyFrom);
      const used = allEventIds(next);
      events = src.events.map((ev, i) => {
        const copy = clone(ev);
        copy.id = freshId('event', id + '|' + ev.id + '|' + i, used);
        used.add(copy.id);
        return copy;
      });
      assumptions = clone(src.assumptions);
      if (o.description === undefined) description = src.description;
    }
    next.scenarios.push({ id, name: nm, description, createdAt: now, updatedAt: now, events, assumptions });
    touch(next, null, o.now);
    return next;
  }

  /** Rename a scenario (the baseline may be renamed too). */
  function renameScenario(state, scenarioId, name, opts) {
    const next = requireState(state);
    const s = findScenario(next, scenarioId);
    s.name = scenarioName(name, next, scenarioId);
    touch(next, s, opts && opts.now);
    return next;
  }

  /** Delete a scenario and drop it from the comparison. The baseline cannot be deleted. */
  function deleteScenario(state, scenarioId) {
    if (scenarioId === BASELINE_ID) fail('The current budget cannot be deleted: every scenario builds on it.', 'scenarioId');
    const next = requireState(state);
    findScenario(next, scenarioId);
    next.scenarios = next.scenarios.filter(s => s.id !== scenarioId);
    const compare = (Array.isArray(next.compareIds) ? next.compareIds : []).filter(id => id !== scenarioId);
    next.compareIds = compare.length ? compare : defaultCompareIds(next.scenarios);
    return next;
  }

  /**
   * Validate a scenario change (event) with the same rules sanitize uses, strictly: returns a
   * normalized copy or throws a ValidationError naming the problem. A valid id is kept.
   */
  function validateEvent(event) {
    return cleanEvent(event, { path: 'event', ctx: makeCtx(), strict: true });
  }

  /**
   * Add a change to a scenario. The baseline cannot hold changes: it is the budget as it is.
   * A missing or already-used id is replaced with a new one.
   */
  function addEvent(state, scenarioId, event, opts) {
    if (scenarioId === BASELINE_ID) fail('The current budget has no planned changes: it is your budget as it is. To change it, edit it on the Budget page; to explore a change, add it to a scenario.', 'scenarioId');
    const next = requireState(state);
    const s = findScenario(next, scenarioId);
    if (s.events.length >= LIMITS.events) fail('A scenario can hold up to ' + LIMITS.events + ' changes.');
    const ev = validateEvent(event);
    const used = allEventIds(next);
    if (!ev.id || used.has(ev.id)) {
      const id = freshId('event', scenarioId + '|' + s.events.length + '|' + ev.type + '|' + (ev.label || '') + '|' + Array.from(used).length, used);
      delete ev.id;
      s.events.push(Object.assign({ id }, ev));
    } else {
      s.events.push(ev);
    }
    touch(next, s, opts && opts.now);
    return next;
  }

  /**
   * Change one event. `patch` is merged over the event (undefined removes an optional field);
   * changing `type` starts from the patch, keeping only the id, label and note. The result is
   * validated like any new event; other scenarios are not touched.
   */
  function updateEvent(state, scenarioId, eventId, patch, opts) {
    if (!isObj(patch)) fail('Nothing to change.');
    const next = requireState(state);
    const s = findScenario(next, scenarioId);
    const at = s.events.findIndex(ev => ev.id === eventId);
    if (at === -1) fail('That change no longer exists in this scenario.', 'eventId');
    const prev = s.events[at];
    const merged = patch.type !== undefined && patch.type !== prev.type
      ? Object.assign({ label: prev.label, note: prev.note }, patch)
      : Object.assign({}, prev, patch);
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    merged.id = prev.id;
    const ev = validateEvent(merged);
    s.events[at] = Object.assign({ id: prev.id }, ev);
    touch(next, s, opts && opts.now);
    return next;
  }

  /** Remove one change from a scenario. */
  function removeEvent(state, scenarioId, eventId, opts) {
    const next = requireState(state);
    const s = findScenario(next, scenarioId);
    if (!s.events.some(ev => ev.id === eventId)) fail('That change no longer exists in this scenario.', 'eventId');
    s.events = s.events.filter(ev => ev.id !== eventId);
    touch(next, s, opts && opts.now);
    return next;
  }

  // ------------------------------------------------------------------ plan list items

  const PLAN_LISTS = {
    incomes: { fields: INCOME_FIELDS, max: LIMITS.incomes, prefix: 'income', noun: 'income streams', label: 'New income', after: startEndOrder },
    bills: { fields: BILL_FIELDS, max: LIMITS.bills, prefix: 'bill', noun: 'bills', label: 'New bill', after: startEndOrder },
    savings: { fields: GOAL_FIELDS, max: LIMITS.savings, prefix: 'goal', noun: 'savings goals', label: 'New savings goal' },
    debts: { fields: DEBT_FIELDS, max: LIMITS.debts, prefix: 'debt', noun: 'debts', label: 'New debt' },
    changes: { fields: CHANGE_FIELDS, max: LIMITS.planChanges, prefix: 'change', noun: 'planned changes', label: 'Planned change', after: changeOrder }
  };

  function listSpec(list) {
    if (!has(PLAN_LISTS, list)) fail('Items can be added to incomes, bills, savings or debts, and to planned changes (not "' + list + '").', 'list');
    return PLAN_LISTS[list];
  }

  /**
   * Add an income stream, bill, savings goal or debt. Fields are validated strictly; missing ones
   * get their defaults (amounts unknown). The new item goes last; its id is item.id when that is
   * valid and unused, otherwise a new one.
   */
  function addItem(state, list, item, opts) {
    const spec = listSpec(list);
    if (!isObj(state) || !isObj(state.plan)) fail('The budget is not loaded yet.');
    if (item !== undefined && item !== null && !isObj(item)) fail('The new item needs its details.');
    const raw = Object.assign({ label: spec.label }, item || {});
    const current = Array.isArray(state.plan[list]) ? state.plan[list] : [];
    if (current.length >= spec.max) fail('You can keep up to ' + spec.max + ' ' + spec.noun + '. Remove one you no longer need first.');
    const body = cleanFields(raw, spec.fields, { path: 'plan.' + list, ctx: makeCtx(), strict: true });
    if (spec.after) spec.after(body, 'plan.' + list, { strict: true, ctx: makeCtx() });
    const taken = new Set(current.map(x => x.id));
    let id;
    if (raw.id !== undefined) {
      if (!isValidId(raw.id)) fail('An id may use letters, numbers, dots, dashes and underscores (up to ' + LIMITS.id + ').', 'id');
      if (taken.has(raw.id)) fail('An item with that id already exists.', 'id');
      id = raw.id;
    } else {
      id = freshId(spec.prefix, list + '|' + current.length + '|' + body.label + '|' + Array.from(taken).join(','), taken);
    }
    const plan = Object.assign({}, state.plan, { [list]: current.concat([Object.assign({ id }, body)]) });
    const next = Object.assign({}, state, { plan });
    if (opts && isIso(opts.now) && isObj(state.meta)) next.meta = Object.assign({}, state.meta, { updatedAt: opts.now });
    return next;
  }

  /**
   * Change several fields of one plan list item at once (an income stream, bill, savings goal,
   * debt or planned change). `patch` is merged over the item (undefined removes a field, which
   * then gets its default); the result is validated strictly like a new item, so fields that
   * depend on each other (a change's kind and end month) can change together. The id is kept.
   */
  function updateItem(state, list, id, patch, opts) {
    const spec = listSpec(list);
    if (!isObj(state) || !isObj(state.plan)) fail('The budget is not loaded yet.');
    if (!isObj(patch)) fail('Nothing to change.');
    const current = Array.isArray(state.plan[list]) ? state.plan[list] : [];
    const at = current.findIndex(x => x && x.id === id);
    if (at === -1) fail('That item no longer exists.', 'id');
    const merged = Object.assign({}, current[at], patch);
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    delete merged.id;
    const body = cleanFields(merged, spec.fields, { path: 'plan.' + list, ctx: makeCtx(), strict: true });
    if (spec.after) spec.after(body, 'plan.' + list, { strict: true, ctx: makeCtx() });
    const items = current.slice();
    items[at] = Object.assign({ id }, body);
    const next = Object.assign({}, state, { plan: Object.assign({}, state.plan, { [list]: items }) });
    if (opts && isIso(opts.now) && isObj(state.meta)) next.meta = Object.assign({}, state.meta, { updatedAt: opts.now });
    return next;
  }

  /**
   * Remove an income stream, bill, savings goal or debt by id. References to it are cleared so
   * nothing points at a missing item: a removed bill is unlinked from its debt (and vice versa),
   * and scenario costs drawn from a removed goal are counted in full again (goalId null).
   */
  function removeItem(state, list, id, opts) {
    listSpec(list);
    if (!isObj(state) || !isObj(state.plan)) fail('The budget is not loaded yet.');
    const current = Array.isArray(state.plan[list]) ? state.plan[list] : [];
    if (!current.some(x => x && x.id === id)) fail('That item no longer exists.', 'id');
    const plan = Object.assign({}, state.plan, { [list]: current.filter(x => x.id !== id) });
    if (list === 'bills') plan.debts = (plan.debts || []).map(d => (d.paymentBillId === id ? Object.assign({}, d, { paymentBillId: null }) : d));
    if (list === 'debts') plan.bills = (plan.bills || []).map(b => (b.debtId === id ? Object.assign({}, b, { debtId: null }) : b));
    const next = Object.assign({}, state, { plan });
    if (list === 'savings' && Array.isArray(state.scenarios)) {
      next.scenarios = state.scenarios.map(s => {
        if (!s.events.some(ev => ev.goalId === id)) return s;
        return Object.assign({}, s, { events: s.events.map(ev => (ev.goalId === id ? Object.assign({}, ev, { goalId: null }) : ev)) });
      });
    }
    if (opts && isIso(opts.now) && isObj(state.meta)) next.meta = Object.assign({}, state.meta, { updatedAt: opts.now });
    return next;
  }

  // ------------------------------------------------------------------ paths (validated form writes)
  // Paths are dotted with array-by-key selectors: 'plan.incomes[id=p1-pay].netPerPaycheckCents',
  // 'plan.personalSpending[personId=p2].monthlyCents', 'plan.settings.incomeTiming', 'ui.scope'.
  // Map entries take the rest of the path as the key ('plan.targets.Gas & heating') or a quoted
  // key ('plan.targets["Misc. costs"]'); writing undefined to a map entry removes it.

  const N = {
    obj: children => ({ kind: 'obj', children }),
    item: (fields, children, after) => ({ kind: 'item', rules: new Map(fields), children: children || {}, after: after || null }),
    list: (sel, item, extra) => Object.assign({ kind: 'list', sel, item }, extra || {}),
    // keys: the only keys allowed (with keysMessage when another is written); keyMax: key length.
    map: (valueRule, max, extra) => Object.assign({ kind: 'map', rule: valueRule, max }, extra || {}),
    leaf: r => ({ kind: 'leaf', rule: r }),
    event: () => ({ kind: 'event' })
  };

  const SCHEMA = N.obj({
    plan: N.obj({
      people: N.list('id', N.item(PERSON_FIELDS)),
      incomes: N.list('id', N.item(INCOME_FIELDS, null, startEndOrder)),
      bills: N.list('id', N.item(BILL_FIELDS, null, startEndOrder)),
      debts: N.list('id', N.item(DEBT_FIELDS, { promo: N.item(PROMO_FIELDS) })),
      savings: N.list('id', N.item(GOAL_FIELDS)),
      personalSpending: N.list('personId', N.item(PERSONAL_FIELDS), {
        autoCreate: v => (PEOPLE.includes(v) ? { personId: v, monthlyCents: null, note: '' } : null)
      }),
      targets: N.map(CENTS, LIMITS.targets),
      balances: N.item(BALANCE_FIELDS, { accounts: N.map(SIGNED_CENTS, LIMITS.balanceAccounts), accountDates: N.map(DATE, LIMITS.balanceAccounts) }),
      settings: N.item(SETTINGS_FIELDS),
      changes: N.list('id', N.item(CHANGE_FIELDS, null, changeOrder))
    }),
    scenarios: N.list('id', N.item(SCENARIO_FIELDS, { assumptions: N.item(ASSUMPTION_FIELDS), events: N.list('id', N.event()) })),
    compareIds: N.leaf(rule('compareIds')),
    checklist: N.map(STRICT_BOOL, LIMITS.checklist),
    ui: N.item(UI_FIELDS, {
      whatIf: N.item(WHATIF_FIELDS),
      plan: N.item(PLAN_UI_FIELDS, planUiChildren()),
      dismissed: N.map(STRICT_BOOL, LIMITS.dismissed)
    }),
    meta: N.item([['createdAt', ISO_TIME], ['updatedAt', ISO_TIME], ['migrationNotes', NOTES_RULE]])
  });

  /**
   * How setPath writes inside each ui.plan field, derived from PLAN_UI: a map one entry at a time
   * (an entry's rule follows from the map's rule; its limits, fixed keys and keysMessage come from
   * the row), an object field one field at a time. Other fields are written whole.
   */
  function planUiChildren() {
    const entryRule = r => {
      switch (r.t) {
        case 'centsmap': return SIGNED_CENTS;
        case 'enummap': return oneOf(r.values, null);
        case 'boolmap': return STRICT_BOOL;
        case 'rowmap':
        case 'objmap': return rule('object', { fields: r.fields });
        default: return null;
      }
    };
    const children = {};
    for (const d of PLAN_UI) {
      if (d.rule.t === 'object') { children[d.name] = N.item(d.rule.fields); continue; }
      const entry = entryRule(d.rule);
      if (!entry) continue;
      const extra = {};
      if (d.rule.keys) Object.assign(extra, { keys: d.rule.keys, keysMessage: d.keysMessage });
      if (d.rule.keyMax) extra.keyMax = d.rule.keyMax;
      children[d.name] = N.map(entry, d.rule.max, extra);
    }
    return children;
  }

  function badPath(path) { fail('There is no field "' + path + '" in the saved budget.', 'path'); }

  function readKey(path, pos) {
    let i = pos;
    if (i > 0) {
      if (path[i] !== '.') badPath(path);
      i++;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    const key = path.slice(i, j);
    if (!key) badPath(path);
    return { key, end: j };
  }

  function readSelector(path, pos, selField) {
    if (path[pos] !== '[') badPath(path);
    const close = path.indexOf(']', pos);
    if (close === -1) badPath(path);
    const inner = path.slice(pos + 1, close).trim();
    const m = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(inner);
    if (m) {
      let value = m[2].trim();
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      if (m[1] !== selField) badPath(path);
      return { value, end: close + 1 };
    }
    if (/^\d+$/.test(inner)) return { index: Number(inner), end: close + 1 };
    return badPath(path);
  }

  function readMapKey(path, pos, keyMax) {
    const max = keyMax || LIMITS.categoryKey;
    let key;
    if (path[pos] === '[') {
      if (path[path.length - 1] !== ']') badPath(path);
      key = path.slice(pos + 1, -1).trim();
      if (/^(["']).*\1$/.test(key)) key = key.slice(1, -1);
    } else if (path[pos] === '.') {
      key = path.slice(pos + 1);
    } else {
      badPath(path);
    }
    key = key.trim();
    if (!isSafeKey(key)) badPath(path);
    if (!key || key.length > max) fail('Names here need 1 to ' + max + ' characters.', 'path');
    return key;
  }

  function findIndexBy(list, sel, field) {
    if (sel.index !== undefined) return sel.index < list.length ? sel.index : -1;
    return list.findIndex(x => isObj(x) && x[field] === sel.value);
  }

  function strictValue(r, value, key) {
    if (r.t === 'object') {
      const res = checkObject(r, value, key, { path: key, ctx: makeCtx(), strict: true });
      if (!res.ok) fail(res.message, key);
      return res.value;
    }
    const res = check(r, value === undefined ? null : value, true);
    if (!res.ok) fail(res.message, key);
    return res.value;
  }

  function writeCompareIds(value, env) {
    const ids = new Set((env.state.scenarios || []).map(s => s.id));
    if (!Array.isArray(value) || !value.length) fail('Choose at least one scenario to compare.', 'compareIds');
    if (value.length > LIMITS.compareIds) fail('Compare up to ' + LIMITS.compareIds + ' scenarios at a time.', 'compareIds');
    if (new Set(value).size !== value.length) fail('Each scenario can be compared only once.', 'compareIds');
    if (!value.every(id => ids.has(id))) fail('One of those scenarios no longer exists.', 'compareIds');
    return value.slice();
  }

  function writeEvent(ev, pos, value, env) {
    const { key, end } = readKey(env.path, pos);
    if (end !== env.path.length) badPath(env.path);
    const fields = EVENT_FIELDS[ev.type] || [];
    if (!fields.some(([k]) => k === key)) badPath(env.path);
    const patched = Object.assign({}, ev, { [key]: value });
    if (value === undefined) delete patched[key];
    return Object.assign({ id: ev.id }, validateEvent(patched));
  }

  /** Path-copying write: only objects on the path are copied, so the input stays unchanged. */
  function writeNode(n, current, pos, value, env) {
    const path = env.path;
    switch (n.kind) {
      case 'obj': {
        if (!isObj(current)) badPath(path);
        const { key, end } = readKey(path, pos);
        const child = has(n.children, key) ? n.children[key] : null;
        if (!child) badPath(path);
        const copy = Object.assign({}, current);
        if (child.kind === 'leaf') {
          if (end !== path.length) badPath(path);
          copy[key] = writeCompareIds(value, env);
          return copy;
        }
        if (end >= path.length) fail('Choose a single field to change ("' + path + '" is a whole section).', 'path');
        copy[key] = writeNode(child, current[key], end, value, env);
        return copy;
      }
      case 'item': {
        if (!isObj(current)) badPath(path);
        const { key, end } = readKey(path, pos);
        const copy = Object.assign({}, current);
        if (end < path.length) {
          const child = has(n.children, key) ? n.children[key] : null;
          if (!child) badPath(path);
          let sub = current[key];
          if ((sub === null || sub === undefined) && child.kind === 'item') sub = emptyOf(Array.from(child.rules.entries()));
          if ((sub === null || sub === undefined) && child.kind === 'map') sub = {};
          copy[key] = writeNode(child, sub, end, value, env);
        } else {
          const r = n.rules.get(key);
          if (!r) badPath(path);
          // An optional field (one that may be absent) is removed by writing undefined.
          if (value === undefined && r.optional) delete copy[key];
          else copy[key] = strictValue(r, value, key);
        }
        if (n.after) n.after(copy, path, { strict: true, ctx: makeCtx() });
        return copy;
      }
      case 'list': {
        if (!Array.isArray(current)) badPath(path);
        const sel = readSelector(path, pos, n.sel);
        const arr = current.slice();
        let at = findIndexBy(arr, sel, n.sel);
        if (at === -1) {
          const made = n.autoCreate && sel.value !== undefined ? n.autoCreate(sel.value) : null;
          if (!made) fail('That item could not be found; it may have been removed.', 'path');
          arr.push(made);
          at = arr.length - 1;
        }
        if (sel.end >= path.length) fail('Choose a single field to change ("' + path + '" is a whole item).', 'path');
        // The selector field identifies the entry; rewriting it (personalSpending personId) would
        // give two entries for one person, and only the first would ever be counted.
        if (n.sel !== 'id' && path.slice(sel.end) === '.' + n.sel) fail('The ' + fieldName(n.sel).toLowerCase() + ' of an existing entry cannot be changed; edit the entry for the other person instead.', n.sel);
        arr[at] = n.item.kind === 'event' ? writeEvent(arr[at], sel.end, value, env) : writeNode(n.item, arr[at], sel.end, value, env);
        return arr;
      }
      case 'map': {
        const key = readMapKey(path, pos, n.keyMax);
        const copy = Object.assign({}, isObj(current) ? current : {});
        if (value === undefined) { delete copy[key]; return copy; }
        if (n.keys && !n.keys.includes(key)) fail(n.keysMessage || 'There is no field "' + path + '" in the saved budget.', 'path');
        if (!has(copy, key) && n.max && Object.keys(copy).length >= n.max) fail('There is no room for more entries here (up to ' + n.max + ').', 'path');
        copy[key] = strictValue(n.rule, value, null);
        return copy;
      }
      default:
        return badPath(path);
    }
  }

  /**
   * Validated write for forms. Checks the value with the rule for that path (cents or null,
   * enum, month, date, text length, start/end order, whole events) and returns a NEW State;
   * the input is never modified. Throws a ValidationError with a message fit to show the user.
   * @param {object} state
   * @param {string} path e.g. 'plan.bills[id=mortgage].monthlyCents'
   * @param {*} value cents for amounts; undefined removes a map entry or an optional event field
   */
  function setPath(state, path, value) {
    if (!isObj(state)) fail('The budget is not loaded yet.');
    if (typeof path !== 'string' || !path.trim()) fail('No field was given to change.', 'path');
    return writeNode(SCHEMA, state, 0, value, { state, path: path.trim() });
  }

  /**
   * Read a value by path (same syntax as setPath). Returns a copy, or undefined when the item or
   * entry does not exist. Throws a ValidationError for a path that is not part of the format.
   */
  function getPath(state, path) {
    if (typeof path !== 'string' || !path.trim()) fail('No field was given.', 'path');
    const p = path.trim();
    let n = SCHEMA;
    let cur = state;
    let pos = 0;
    while (pos < p.length) {
      if (cur === undefined || cur === null) {
        // Still validate the rest of the path syntax loosely: an absent item reads as undefined.
        return undefined;
      }
      switch (n.kind) {
        case 'obj': {
          const { key, end } = readKey(p, pos);
          if (!has(n.children, key)) badPath(p);
          n = n.children[key];
          cur = isObj(cur) ? cur[key] : undefined;
          pos = end;
          break;
        }
        case 'item': {
          const { key, end } = readKey(p, pos);
          if (end < p.length) {
            if (!has(n.children, key)) badPath(p);
            n = n.children[key];
          } else {
            // Ids (and other selector keys) are readable but not writable through setPath.
            if (!n.rules.has(key) && !has(n.children, key) && key !== 'id') badPath(p);
            n = { kind: 'leaf' };
          }
          cur = isObj(cur) ? cur[key] : undefined;
          pos = end;
          break;
        }
        case 'list': {
          const sel = readSelector(p, pos, n.sel);
          const list = Array.isArray(cur) ? cur : [];
          const at = findIndexBy(list, sel, n.sel);
          cur = at === -1 ? undefined : list[at];
          n = n.item.kind === 'event' ? { kind: 'any' } : n.item;
          pos = sel.end;
          break;
        }
        case 'map': {
          const key = readMapKey(p, pos, n.keyMax);
          cur = isObj(cur) && has(cur, key) ? cur[key] : undefined;
          pos = p.length;
          break;
        }
        case 'any': {
          const { key, end } = readKey(p, pos);
          cur = isObj(cur) ? cur[key] : undefined;
          pos = end;
          break;
        }
        default:
          badPath(p);
      }
    }
    return cur === undefined ? undefined : clone(cur);
  }

  // ------------------------------------------------------------------ storage

  /** localStorage key for a dataset's saved budget. */
  function storageKey(datasetId) {
    if (!nonEmpty(datasetId)) fail('A data set id is needed to save the budget.', 'datasetId');
    return STORAGE_PREFIX + datasetId.trim();
  }

  /** Keys the earlier app used: 'sample-household-budget-v1-' + copyId. */
  function legacyKeys(copyIds) {
    const ids = Array.isArray(copyIds) ? copyIds : LEGACY_COPY_IDS;
    return ids.filter(nonEmpty).map(id => LEGACY_PREFIX + id);
  }

  function errorText(err) { return (err && err.message) || String(err); }

  /**
   * Load the saved budget for a dataset from a Storage-like object ({ getItem, setItem }).
   * Order: the version-5 key, then earlier-version keys (read only, never changed or deleted;
   * opts.legacyCopyIds names them, otherwise see defaultLegacyCopyIds), then the profile
   * defaults. Never throws: unreadable storage or damaged data give defaults and a note (a
   * damaged v5 entry is copied to '<key>:unreadable' first so it is not lost).
   * @returns {{state: object, notes: string[], source: 'v5'|'legacy'|'none'}}
   */
  function loadFromStorage(storage, datasetId, profile, dataset, opts) {
    const o = opts || {};
    const id = nonEmpty(datasetId) ? datasetId.trim() : (datasetIdOf(dataset) || NO_DATA_ID);
    const ds = Object.assign({}, isObj(dataset) ? dataset : {}, { datasetId: id });
    const notes = [];
    const fresh = () => defaults(profile, ds, o);
    if (!storage || typeof storage.getItem !== 'function') {
      notes.push('Browser storage is not available here, so changes will not be kept after this page closes. Export a workbook to keep them.');
      return { state: fresh(), notes, source: 'none' };
    }
    const key = storageKey(id);
    let text;
    try { text = storage.getItem(key); } catch (err) {
      notes.push('Saved changes could not be read from this browser (' + errorText(err) + '). Started from the household profile; export a workbook to keep changes.');
      return { state: fresh(), notes, source: 'none' };
    }
    if (text !== null && text !== undefined) {
      let parsed;
      let readable = true;
      try { parsed = JSON.parse(text); } catch (err) { readable = false; }
      if (readable && isObj(parsed)) {
        const r = sanitize(parsed, profile, ds, o);
        return { state: r.state, notes: notes.concat(r.notes), source: 'v5' };
      }
      const backup = key + ':unreadable';
      try {
        storage.setItem(backup, String(text));
        notes.push('The budget saved in this browser was damaged and could not be read. A copy was kept under "' + backup + '"; started from the household profile.');
      } catch (err) {
        notes.push('The budget saved in this browser was damaged and could not be read, and a backup copy could not be kept (' + errorText(err) + '). Started from the household profile.');
      }
      return { state: fresh(), notes, source: 'none' };
    }

    const synthetic = isSyntheticDataset(ds);
    const copyIds = Array.isArray(o.legacyCopyIds) ? o.legacyCopyIds : defaultLegacyCopyIds(storage, synthetic);
    const found = [];
    for (const copyId of Array.from(new Set(copyIds.filter(nonEmpty)))) {
      let t;
      try { t = storage.getItem(LEGACY_PREFIX + copyId); } catch (err) {
        notes.push('The earlier version’s saved budget (copy "' + copyId + '") could not be read (' + errorText(err) + ').');
        continue;
      }
      if (t !== null && t !== undefined && String(t).trim()) found.push({ copyId, text: String(t) });
    }
    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      let parsed;
      try { parsed = JSON.parse(f.text); } catch (err) {
        // Copied where the page offers damaged budgets for download (the earlier key stays untouched).
        let kept = false;
        try {
          const backup = key + ':unreadable';
          if (storage.getItem(backup) === null) { storage.setItem(backup, f.text); kept = true; }
        } catch (e) { /* the note still says it was skipped */ }
        notes.push('The earlier version’s saved budget (copy "' + f.copyId + '") is damaged and was skipped. It was left unchanged' +
          (kept ? ', and a copy was kept under "' + key + ':unreadable".' : '.'));
        continue;
      }
      if (!isLegacyWrapper(parsed) && legacyVersionOf(parsed) === null) {
        notes.push('Data saved under the earlier version’s key (copy "' + f.copyId + '") was not recognised and was skipped. It was left unchanged.');
        continue;
      }
      const r = migrate(f.text, profile, ds, o);
      notes.push('Carried over the budget saved by the earlier version of this app in this browser (copy "' + f.copyId + '"). The earlier saved data was left in place, unchanged.');
      const others = found.slice(i + 1).map(x => '"' + x.copyId + '"');
      if (others.length) notes.push('Other earlier-version copies were also found (' + others.join(', ') + ') but not merged; import them from the Data page if needed.');
      return { state: r.state, notes: notes.concat(r.notes), source: 'legacy' };
    }
    if (!Array.isArray(o.legacyCopyIds) && !synthetic) {
      let sampleCopy = null;
      try { sampleCopy = storage.getItem(LEGACY_PREFIX + 'local-sample'); } catch (err) { /* nothing to report */ }
      if (typeof sampleCopy === 'string' && sampleCopy.trim()) {
        notes.push('An earlier-version budget for the sample data (copy "local-sample") was found but was not carried over: it holds the invented sample household, not this one. It was left unchanged.');
      }
    }
    return { state: fresh(), notes, source: 'none' };
  }

  function isSyntheticDataset(ds) { return ds.isSynthetic === true || ds.datasetId === 'sample'; }

  /**
   * Earlier-version copies to look for when the caller names none. The sample page's copy
   * ('local-sample') holds invented figures and a private page's copy ('local-private') a
   * household's real ones, so each data set reads only its own kind: carrying either into the
   * other would put invented numbers in a real budget, or real numbers in the shareable sample.
   * A household data set also reads downloaded copies ('copy-<download time>'), newest first,
   * found by listing the storage keys when the storage allows it.
   */
  function defaultLegacyCopyIds(storage, synthetic) {
    if (synthetic) return ['local-sample', 'hosted'];
    return ['local-private', 'hosted'].concat(downloadedCopyIds(storage));
  }

  function downloadedCopyIds(storage) {
    const ids = [];
    try {
      const n = storage.length;
      if (typeof storage.key !== 'function' || !Number.isInteger(n)) return ids;
      for (let i = 0; i < n && i < 10000; i++) {
        const k = storage.key(i);
        if (typeof k === 'string' && k.startsWith(LEGACY_PREFIX + 'copy-')) ids.push(k.slice(LEGACY_PREFIX.length));
      }
    } catch (err) { /* storage that cannot list its keys is not scanned */ }
    const stamp = id => (/^copy-\d+$/.test(id) ? Number(id.slice(5)) : -1);
    return ids.sort((a, b) => stamp(b) - stamp(a) || a.localeCompare(b));
  }

  function isQuotaError(err) {
    if (!err) return false;
    return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014;
  }

  /**
   * Save the State under storageKey(state.datasetId). Never throws.
   * @returns {{ok: boolean, error: string|null, key?: string, bytes?: number}}
   */
  function saveToStorage(storage, state) {
    if (!storage || typeof storage.setItem !== 'function') return { ok: false, error: 'Browser storage is not available here. Export a workbook to keep your changes.' };
    if (!isObj(state) || state.version !== VERSION || !nonEmpty(state.datasetId)) return { ok: false, error: 'There is no valid budget to save.' };
    const text = safeStringify(state);
    if (text === null) return { ok: false, error: 'The budget could not be prepared for saving.' };
    const key = storageKey(state.datasetId);
    try {
      storage.setItem(key, text);
      return { ok: true, error: null, key, bytes: text.length };
    } catch (err) {
      const error = isQuotaError(err)
        ? 'This browser has no room left to save the budget. Export a workbook to keep your changes.'
        : 'This browser would not save the budget (' + errorText(err) + '). Export a workbook to keep your changes.';
      return { ok: false, error, key };
    }
  }

  E.state = {
    VERSION, STORAGE_PREFIX, LEGACY_PREFIX, LEGACY_COPY_IDS, WORKBOOK_FORMAT, BASELINE_ID, BASELINE_NAME,
    LIMITS, LEGACY_FIELDS, LEGACY_TARGETS, EVENT_TYPES, SAVED_FORECAST_NAME, ENERGY_TARGET, OTHER_EXPENSES_TARGET,
    storageKey, LEGACY_KEYS: legacyKeys,
    defaults, sanitize, migrate, legacyVersionOf,
    exportWorkbook, importWorkbook, extractEmbeddedState,
    addScenario, renameScenario, deleteScenario, removeScenario: deleteScenario,
    addEvent, updateEvent, removeEvent, validateEvent,
    DIAL_KEYS, RETIRED_DIALS, SPEND_GROUPS, SPEND_DIALS, CHANGE_KINDS, CHANGE_GROUPS, TREND_SERIES,
    // ui.plan's fields as PLAN_UI describes them (read-only: name, default, optional, doc), and its silent cleaner.
    PLAN_UI: Object.freeze(PLAN_UI.map(d => Object.freeze({ name: d.name, default: d.rule.optional ? undefined : clone(d.rule.def), optional: !!d.rule.optional, doc: d.doc }))),
    cleanPlanUi,
    // Upgrades inside version 5 (sanitize runs them; upgrade(raw) runs them alone).
    V5_UPGRADES, upgrade,
    getPath, setPath, addItem, updateItem, removeItem,
    loadFromStorage, saveToStorage
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
