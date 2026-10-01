# Architecture and module contracts

This is the engineering contract for the household budget workspace. It defines the data
formats, the saved-state schema and every module's public API. Code, tests and fixtures
must follow it; when an implementation needs to deviate, update this document in the same change.

**Privacy rule for this repository:** the GitHub repository is public. Only invented data may be
committed. Real names, amounts, balances, employers, merchants that identify a person, due dates,
locations and account numbers belong in the ignored `private/` folder. Tests and fixtures use
fictional households ("Alex" and "Sam", "Partner A"/"Partner B") and invented amounts.

## 1. Runtime shape

- Static, dependency-free browser app assembled into one self-contained HTML file
  (`dist/index.html`) by `tools/build.cjs`. No network requests, no remote assets, no analytics.
- Vanilla JavaScript (ES2020, no modules syntax). Each source file is an IIFE that attaches to
  `globalThis.BudgetEngine` (pure logic) or `globalThis.BudgetUI` (DOM). The same engine files are
  `require`d by Node tests in the order listed in `src/manifest.json`.
- Node ≥ 18 is the only toolchain (build, import, tests). Browser tests use Playwright when available.

```
src/
  manifest.json          load order for engine, ui and css files (build + tests read it)
  engine/                pure functions, no DOM / storage / clock (except state.storage*)
    core.js              money, months, dates, util            (BudgetEngine.money/.months/.dates/.util)
    categories.js        default taxonomy, groups, seasonal set (BudgetEngine.categories)
    ledger.js            dataset normalization, edits, totals    (BudgetEngine.ledger)
    compare.js           usual-spend comparisons                 (BudgetEngine.compare)
    review.js            data-review queues, spike detection     (BudgetEngine.review)
    importer.js          CSV parsing + import pipeline           (BudgetEngine.importer)
    schedule.js          paycheck dates and counts               (BudgetEngine.schedule)
    plan.js              monthly budget model                    (BudgetEngine.plan)
    debt.js              debt facts, promo check, illustrations  (BudgetEngine.debt)
    forecast.js          scenario projection + comparison        (BudgetEngine.forecast)
    state.js             saved-state schema, migration, storage  (BudgetEngine.state)
    attention.js         "needs attention" list for Overview     (BudgetEngine.attention)
  ui/
    core.js              escaping, formatting, DOM helpers       (BudgetUI.dom/.fmt)
    components.js        breadcrumbs, tables, bar lists, charts  (BudgetUI.c)
    router.js            hash routing                            (BudgetUI.router)
    views/*.js           one file per view                       (BudgetUI.views.<name>)
    app.js               bootstrap, state store, event wiring    (BudgetUI.app) — loaded last
  styles/*.css           base tokens/components + one file per view
  layout.html            document shell with placeholders
tools/
  build.cjs              assemble dist/index.html (sample or private)
  import.cjs             CLI importer: private/raw/*.csv -> private/budget-data.json + report
  build-sample.cjs       regenerate fixtures/sample-data.json from fixtures/sample-raw/*.csv
  check-privacy.cjs      scan tracked/staged files for private patterns before committing
fixtures/                synthetic sample (committed): raw CSVs, rules, profile, normalized data
private/                 (ignored) real exports, rules, household profile, builds
tests/unit/*.test.cjs    node:test suites for the engine and tools
tests/browser/*.cjs      Playwright end-to-end checks against dist/index.html
```

## 2. Dataset (normalized ledger), schema version 2

Produced by the importer, embedded in the build or loaded in the browser. Immutable at runtime:
user corrections live in saved state (`ledgerEdits`), never in the dataset.

```js
Dataset = {
  schemaVersion: 2,
  datasetId: string,            // stable id; storage namespace. 'sample' for the fixture
  isSynthetic: boolean,
  generatedAt: 'YYYY-MM-DD',
  currency: 'USD',
  accounts: Account[],
  transactions: Txn[],          // sorted by date, then id
  coverageOverrides: { 'YYYY-MM': { status: 'full'|'partial'|'none', note: string } },  // optional
  importLog: ImportLogEntry[],  // optional, see importer
  references: Reference[],      // optional reconciliation references (e.g. legacy totals)
  notes: string[]
}

Account = {
  id: string,                   // 'joint-checking'
  label: string,                // 'Joint checking'
  type: 'checking'|'savings'|'credit_card'|'loan'|'other',
  scope: 'joint'|'personal',    // joint = shared household account
  ownerId: null|'p1'|'p2',      // personal accounts only
  paidInFull: boolean,          // credit cards paid in full monthly (purchases are the spending)
  coverage: [{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }]   // inclusive ranges fully covered by exports
}

Txn = {
  id: string,                   // stable: hash(accountId|date|amount|description|occurrence)
  accountId: string,
  date: 'YYYY-MM-DD',           // posted date (statement ledger)
  description: string,          // raw bank text
  merchant: string,             // cleaned display name
  amountCents: integer,         // SIGNED ACCOUNT FLOW: < 0 money leaves the account (purchase, bill,
                                //   payment, transfer out, card charge); > 0 money enters (deposit,
                                //   refund, transfer in, card payment received)
  kind: 'spend'|'income'|'transfer'|'card_payment'|'debt_payment',
  subtype: string|null,         // income: 'payroll'|'interest'|'reimbursement'|'other'
                                // transfer: 'savings'|'contribution'|'internal'|'investment'
                                // debt_payment: 'loan'|'store_card'|'other'
  category: string,             // household category after import rules (not user edits)
  sourceCategory: string|null,  // ORIGINAL bank category, never modified
  categoryReason: string,       // why this category: 'Bank category "Groceries"', 'Rule: …'
  confidence: 'high'|'medium'|'low',
  flags: string[],              // see Flags
  pairId: string|null,          // counterpart txn id (transfer / card payment pairs)
  matchIds: string[],           // related candidates (e.g. reimbursement deposit <-> charge)
  sourceFile: string|null,
  sourceRow: integer|null,
  note: string
}

Reference = { id, label, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', spendingCents: integer, source: string }
```

### Counting rules (the single source of truth: `ledger.measure`)

| kind | counted as | amount used |
| --- | --- | --- |
| `spend` | **Spending** (consumption, including housing payment, bills, fees). Refunds are `spend` rows with positive flow and reduce spending. | `spendCents = -amountCents` |
| `income` | **Income** (payroll, interest, other). Never includes transfers. | `amountCents` |
| `transfer` | Not income, not spending. `savings` transfers are shown as **Saved**; `contribution` (from a partner's personal account outside the data) is shown as **Contributions in**. | flow |
| `card_payment` | Excluded: paying a card bill moves money; the card's purchases are the spending. | — |
| `debt_payment` | **Debt payments** outflow (loans/financing whose original purchase is not in the data). Not category spending. | `-amountCents` |

Effective counting also respects user edits (section 4): excluded duplicates disappear from all
totals; `reimbursement: 'confirmed'` removes the charge from household spending and the matching
deposit from income; `business: 'business'` removes a charge from household spending (listed as
business); `planningBaseline: 'exclude'` affects only planning baselines, never actuals.

### Flags

`mixed_retail` (merchant sells many kinds of goods; contents not inferred), `needs_category_review`,
`reimbursement_candidate`, `business_candidate`, `duplicate_candidate`, `unpaired_transfer`,
`pending`, `fee`, `refund`, `legacy:<original flag>` (preserved from v1 data).

### Coverage

A month's coverage is derived from account coverage ranges: an account is *expected* for every
month between the dataset's earliest coverage start and latest coverage end. A month is `full` when
every expected account covers every day of it, `partial` when some days are missing, `none` when no
account covers it. `coverageOverrides` win. Only `full` months enter usual-spend baselines.

### Legacy (v1) datasets

`ledger.normalizeDataset` accepts the earlier normalized schema (top-level `sources`, `monthly`,
`quarter`, `transactions` with positive spending `amountCents`). Conversion: `spend` rows flip sign
(`amountCents_v2 = -amountCents_v1`); other kinds use `direction` (`outbound` → negative);
`investment` kind → `transfer`/`investment`; `sources` → accounts (`type:'other'`, `scope:'joint'`);
`monthly[].hasMainCardCoverage === false` → `coverageOverrides[month] = {status:'partial'}`;
`needsCategoryReview` → `needs_category_review` flag; every v1 flag is kept as `legacy:<flag>` and
known ones are also mapped (`reimbursement_candidate`, `business_candidate`, `mixed_retail`);
`quarter.spendingCents` over `defaultPeriod` → a `Reference` so the legacy total can be reconciled.

## 3. Household profile

Supplies the starting plan. The repository has `fixtures/sample-profile.json` (invented). A real
household keeps `private/household-profile.json`. Saved state always wins over profile defaults.

```js
Profile = {
  schemaVersion: 1,
  isSynthetic: boolean,
  household: { name: string, people: [{ id: 'p1', name: string }, { id: 'p2', name: string }] },
  plan: Plan,                         // section 5
  scenarios: Scenario[],              // optional starting scenarios (templates with blanks)
  references: Reference[],            // optional reconciliation references
  rulesNote: string                   // optional
}
```

## 4. Ledger edits (user corrections; part of saved state)

```js
ledgerEdits = { [txnId]: Edit }
Edit = {
  category?: string, categoryReason?: string,     // reason required when category is set
  kind?: Txn.kind, subtype?: string|null, kindReason?: string,
  splits?: [{ category: string, cents: integer }], // spending split; cents sum must equal spendCents
  duplicate?: 'exclude'|'keep',
  reimbursement?: 'pending'|'confirmed'|'not_reimbursed',
  business?: 'pending'|'business'|'household',
  planningBaseline?: 'exclude'|'include',
  note?: string,
  history: [{ at: ISO-8601, field: string, from: any, to: any, reason: string }]
}
```

## 5. Plan (monthly budget model)

```js
Plan = {
  people: [{ id: 'p1', name }, { id: 'p2', name }],
  incomes: IncomeStream[],
  bills: Bill[],                       // fixed recurring outflows incl. debt payments & insurance
  debts: Debt[],                       // facts about balances/terms (payments live in bills)
  targets: { [category]: cents|null }, // variable-spending targets per month (joint-funded)
  savings: SavingsGoal[],
  personalSpending: [{ personId, monthlyCents: cents|null, note }],  // spending funded personally, beyond bills
  balances: { jointCashCents: cents|null, asOf: 'YYYY-MM-DD'|null, note },
  settings: { incomeTiming: 'conservative'|'average'|'actual', planningBaseline: 'actual'|'adjusted', comparisonWindow: 3|6|12 }
}

IncomeStream = {
  id, label, personId,
  kind: 'paycheck'|'contribution'|'other',   // contribution = transfer from that person's personal account
  netPerPaycheckCents: cents|null,           // full take-home per occurrence (paycheck kind); null = unknown
  jointPerPaycheckCents: cents|null,         // portion reaching the joint account per occurrence
  frequency: 'weekly'|'biweekly'|'semimonthly'|'monthly'|'unknown',
  frequencyStatus: 'confirmed'|'observed'|'unknown',
  anchorDate: 'YYYY-MM-DD'|null,             // one real payday (weekly/biweekly timing)
  semimonthlyDays: [d1, d2],                 // default [15, 31]; 31 means last day of month
  monthlyDay: 1..31,
  assumedPerMonthIfUnknown: integer,         // explicit, labelled assumption used only while frequency is unknown (default 2)
  status: 'confirmed'|'estimate'|'observed'|'unknown',
  startMonth: 'YYYY-MM'|null, endMonth: 'YYYY-MM'|null,
  note
}
// Personal allocation for a paycheck = netPerPaycheck − jointPerPaycheck (when both known).

Bill = {
  id, label, category, monthlyCents: cents|null,
  fundedFrom: 'joint'|'p1'|'p2'|'unknown',
  type: 'housing'|'debt'|'insurance'|'utility'|'subscription'|'other',
  debtId: string|null,
  status: 'existing'|'planned'|'estimate',  // planned = not yet a bill (e.g. a policy being considered)
  startMonth: 'YYYY-MM'|null, endMonth: 'YYYY-MM'|null,   // endMonth = confirmed final payment month
  note
}

Debt = {
  id, label, ownerId: 'p1'|'p2'|'joint',
  balanceCents: cents|null, balanceAsOf: 'YYYY-MM-DD'|null, balanceStatus: 'approximate'|'statement'|'confirmed'|'unknown',
  aprPct: number|null, aprRange: [min, max]|null, aprStatus: 'unknown'|'displayed'|'confirmed',
  paymentBillId: string|null,
  promo: null | { balanceCents: cents|null, expiresMonth: 'YYYY-MM'|null, deferredInterest: boolean|null, note },
  loanCount: integer|null, repaymentPlan: string|null, termStatus: 'unknown'|'confirmed',
  escrowIncluded: boolean|null,              // housing payment includes taxes/insurance?
  note
}

SavingsGoal = {
  id, label, targetCents: cents|null, targetMonth: 'YYYY-MM'|null,
  savedCents: cents|null,                    // currently earmarked; null = unknown
  monthlyCents: cents|null,                  // planned monthly contribution
  spendAtTarget: boolean,                    // true: the goal is spent in targetMonth (trip); false: kept (cushion)
  note
}
```

## 6. Scenarios

A scenario is the current plan plus a list of dated changes. Every scenario inherits later plan
edits; editing one scenario never changes another or any historical actual. The baseline scenario
(`id: 'baseline'`) has no events and cannot be deleted.

```js
Scenario = {
  id, name, description, createdAt, updatedAt,
  events: Event[],
  assumptions: { incomeTiming: 'actual'|'average'|'conservative', annualReturnPct: 0, costGrowthPct: 0, incomeGrowthPct: 0 }
}
Event =
 | { id, type: 'one_time', label, month: 'YYYY-MM'|null, amountCents: cents|null, direction: 'expense'|'income', category, goalId: string|null, note }
 | { id, type: 'recurring', label, startMonth, endMonth|null, monthlyCents: cents|null, direction: 'expense'|'income'|'income_loss', category, note }
 | { id, type: 'income_change', label, streamId, startMonth, endMonth|null, netPerPaycheckCents: cents|null|undefined, jointPerPaycheckCents: cents|null|undefined, note }
 | { id, type: 'bill_change', label, billId, startMonth, endMonth|null, monthlyCents: cents|null, note }   // 0 = bill stops
 | { id, type: 'target_change', label, category, startMonth, endMonth|null, monthlyCents: cents|null, note }
 | { id, type: 'goal', label, goal: SavingsGoal }
```
An event amount of `null` is a **missing cost**: never treated as $0 silently; reported in
`result.missing` and shown prominently.

## 7. Saved state, schema version 5

```js
State = {
  version: 5,
  datasetId: string,
  plan: Plan,
  scenarios: Scenario[],                 // scenarios[0] is the baseline
  compareIds: string[],                  // scenarios shown side by side in Forecast (max 3)
  ledgerEdits: { [txnId]: Edit },
  references: Reference[],               // user-entered reconciliation references
  checklist: { [id]: boolean },
  ui: { scope: 'joint'|'household', lastRoute: string, whatIf: { excludePendingReimbursements: boolean, excludeBusinessCandidates: boolean }, dismissed: { [noticeId]: boolean } },
  meta: { createdAt, updatedAt, migratedFrom: null|integer, migrationNotes: string[] }
}
```
Storage: `localStorage['household-budget:v5:' + datasetId]`. Legacy keys read once for migration:
`'sample-household-budget-v1-' + copyId` (copyIds `local-sample`, `local-private`, `hosted`, `copy-*`).
Storage is **per browser profile on one device**; it is not shared between people or devices.
Sharing uses workbook export/import (a JSON file the household passes between devices).

## 8. Module APIs

All functions are pure unless noted. `txns` passed to analysis functions are *effective*
transactions from `ledger.applyEdits`.

### BudgetEngine.categories
- `DEFAULT: [{ name, group, seasonal?: boolean, essential?: boolean }]`
- `groupOf(name) -> string`, `isSeasonal(name, extraSeasonal?) -> boolean`, `names() -> string[]`
- `UNCATEGORIZED = 'Uncategorized'`, `MIXED_RETAIL = 'Mixed retail'`

### BudgetEngine.ledger
- `normalizeDataset(raw) -> Dataset` — accepts v1 or v2; validates; throws `ValidationError` with a readable message.
- `validateDataset(ds) -> { errors: string[], warnings: string[] }`
- `applyEdits(dataset, ledgerEdits, { whatIf } = {}) -> EffectiveTxn[]` where
  `EffectiveTxn = Txn & { baseCategory, edited: boolean, excluded: null|'duplicate'|'reimbursed'|'business'|'what_if', planningExcluded: boolean, parts: [{ category, spendCents }] }`.
  `parts` holds one entry (or the user's splits) for counted spending; empty for excluded/non-spend rows.
- `measure(txn) -> { spendCents, incomeCents, debtCents, savedCents, contributionCents }` (0 when not applicable; respects `excluded`).
- `filter(txns, { start, end, months, accountIds, scope, kinds, category, merchant, query, flags, includeExcluded }) -> EffectiveTxn[]`
  (`category` matches any part; `query` matches merchant, description, category, source category, note, or an amount like "486.60").
- `summarize(txns) -> { spendingCents, purchasesCents, refundsCents, incomeCents, payrollCents, contributionsCents, savedNetCents, debtPaymentsCents, cardPaymentsCents, excludedCents, count }`
- `group(txns, by: 'month'|'category'|'merchant'|'account', { planning } = {}) -> [{ key, spendCents, count, ids }]` sorted by spend desc (months chronological). Category grouping uses parts. `planning: true` omits planning-excluded rows.
- `months(dataset) -> 'YYYY-MM'[]` (all months from earliest coverage/transaction to latest)
- `coverage(dataset, month) -> { status, coveredDays, totalDays, accounts: [{ accountId, label, coveredDays, totalDays }] , note }`
- `coverageMap(dataset) -> { [month]: coverage }`
- `latestCompleteMonth(dataset) -> 'YYYY-MM'|null`

### BudgetEngine.compare
- `RULE = { minDiffCents: 10000, minPct: 25, minMonths: 2 }`
- `usual(txns, dataset, { month, window: 3|6|12, category?, planning?: boolean, rule? }) -> ComparisonResult`
```js
ComparisonResult = {
  month, window, selectedCoverage: coverage,
  baselineMonths: 'YYYY-MM'[], usableCount, excludedMonths: [{ month, reason }],
  rule, planning: boolean,
  categories: [{
    category, group, actualCents, averageCents|null, diffCents|null, pct|null,
    signal: 'higher'|'lower'|'typical'|'new'|'no_history'|'limited_history'|'refund_baseline'|'partial_month'|'seasonal_higher'|'seasonal_typical'|'seasonal_lower'|'seasonal_unknown',
    explanation: string,              // plain-language reason, cites the rule and months used
    seasonal: null | { lastYearMonth, lastYearCents|null, lastYearCovered: boolean },
    monthsWithActivity: integer
  }],
  totals: { actualCents, averageCents|null, diffCents|null }
}
```
Rules: the selected month never enters its own baseline; only `full` months count; a covered month
with no activity counts as $0; `averageCents` is null with no usable month; `pct` is null when the
average is ≤ 0; "higher/lower" requires |diff| ≥ max(minDiffCents, minPct% of average) and
usableCount ≥ minMonths; a partial selected month is labelled `partial_month` and never flagged;
seasonal categories are judged against the same month last year when that month is covered
(same threshold rule), otherwise `seasonal_unknown` with an explanation.
- `trend(txns, dataset, { category?, months: 'YYYY-MM'[] }) -> [{ month, spendCents, coverage }]`
- `planningBaseline(txns, dataset, { endMonth, window }) -> { [category]: { actualAvgCents, adjustedAvgCents, excludedCents, usableCount, months } }`
  (uses the last `window` full months up to and including `endMonth`)
- `planVsActual(plan, txns, dataset, { month, window }) -> [{ category, kind: 'target'|'bill', label, plannedCents|null, actualCents, usualCents|null, adjustedUsualCents|null, diffToPlanCents|null, status: 'over'|'under'|'on_plan'|'no_plan'|'partial_month' }]`
  (targets by category plus joint-funded bills matched to their category; unplanned categories with spending appear with `no_plan`)

### BudgetEngine.review
- `queues(dataset, txns, ledgerEdits) -> { uncertain, mixedRetail, duplicates, transfers: { paired, unpaired }, reimbursements, business, spikes, coverageGaps, edited, counts }`
- `duplicateCandidates(txns) -> [{ ids: [a, b], reason, confidence }]` (same account, same amount, ≤ 3 days apart, similar description; never auto-excluded)
- `spikes(txns, dataset, { minCents: 50000, multiple: 3, window: 6 }) -> [{ month, category, totalCents, usualCents, ids }]`
- `reimbursementPairs(txns) -> [{ chargeId, depositId|null, cents, status }]`
- `editRecord(prevEdit, field, value, reason, at) -> Edit` — appends history; requires a reason for `category`, `kind`, `splits`.

### BudgetEngine.importer
- `parseCSV(text) -> string[][]` (RFC 4180 quotes, CRLF/LF, BOM, blank lines skipped)
- `PROFILES` — header-based mappings: signed amount; debit/credit columns; card exports where charges are positive.
- `detectMapping(header: string[]) -> Mapping|null`
- `Mapping = { date, postDate?, description, amount? , debit?, credit?, category?, type?, balance?, chargesPositive?: boolean, dateFormat: 'MDY'|'YMD'|'DMY' }` (column names)
- `parseDate(text, format) -> 'YYYY-MM-DD'|null`
- `normalizeFile({ name, text, account, mapping? }) -> { txns: Txn[], skipped: [{ row, reason }], mapping, start, end }`
- `classify(txns, rules, accounts) -> Txn[]` — kind/subtype/category/flags/merchant from rules; keeps `sourceCategory`.
- `dedupe(txns) -> { kept, removed }` — multiset de-duplication across overlapping files (identical account/date/amount/description; keeps the maximum count seen in any single file).
- `pairTransfers(txns, accounts, { days: 5 }) -> Txn[]` — sets `pairId` for opposite flows between household accounts; unmatched internal-looking transfers get `unpaired_transfer`.
- `markReimbursementCandidates(txns, { days: 120 }) -> Txn[]` — non-payroll deposit equal to an earlier charge.
- `buildDataset({ files: [{ name, text, accountId, mapping?, coverageStart?, coverageEnd? }], accounts, rules, datasetId, isSynthetic, generatedAt }) -> { dataset, report }`
- `report = { files: [{ name, accountId, rows, imported, skipped, duplicatesRemoved, start, end }], accounts: [{ id, coverage }], totalsByKind, warnings: string[] }`
- `DEFAULT_RULES` — generic patterns only (card payments, payroll, savings transfers, interest, mixed-retail chains, dental/medical providers, airlines). Household-specific rules belong in `private/rules.json`.

Rules format:
```js
Rules = {
  categoryMap: { [bankCategory]: householdCategory },
  merchantRules: [{ match: 'regex', field: 'description'|'merchant'|'sourceCategory', accountType?: string, sign?: 'in'|'out',
                    category?, kind?, subtype?, merchant?, flags?: string[], confidence?, reason: string }],
  transferHints: [{ match: 'regex', subtype: 'savings'|'contribution'|'internal', personId?: 'p1'|'p2' }]
}
```
Rules apply in order: user rules first, then defaults; first match wins per field.

### BudgetEngine.schedule
- `paydays(stream, month) -> 'YYYY-MM-DD'[]|null` (null when frequency unknown or anchor missing for weekly/biweekly)
- `count(stream, month) -> { count: integer, basis: 'actual'|'assumed'|'none', dates }`
- `perMonth(frequency, timing: 'conservative'|'average') -> number|null` (weekly 4 | 52/12; biweekly 2 | 26/12; semimonthly 2; monthly 1)
- `frequencyTable(perPaycheckCents) -> [{ frequency, label, typicalMonthCents, averageMonthCents, extraChecksPerYear, note }]`
Weekend rule: semimonthly and monthly paydays that fall on Saturday/Sunday move to the previous Friday.
Weekly/biweekly follow the anchor exactly. Holidays are not modelled.

### BudgetEngine.plan
- `monthly(plan, { scope: 'joint'|'household', month?: 'YYYY-MM', timing? }) -> PlanSummary`
```js
PlanSummary = {
  scope, timing, month,
  income: { totalCents|null, knownCents, lines: [{ id, label, personId, cents|null, perPaycheckCents, count, basis, assumption|null }] },
  spending: { targetsCents, lines: [{ category, cents|null }] },
  bills: { totalCents, lines: [{ id, label, cents|null, fundedFrom, status }], excludedUnknownFunding: [{ id, label, cents }] },
  savings: { totalCents, lines: [{ id, label, cents|null }] },
  personal: [{ personId, allocationCents|null, billsCents, spendingCents|null, leftoverCents|null }],
  outflowCents,                       // spending + bills (+ personal in household scope)
  remainingCents|null,                // income − outflow − savings; null if income unknown
  missing: [{ id, label, area: 'income'|'bills'|'targets'|'savings'|'balances'|'debts' }],
  assumptions: string[]
}
```
Joint scope counts joint deposits (paycheck joint portions + contributions + other joint income),
targets, joint-funded bills and savings contributions. Bills with `fundedFrom: 'unknown'` are listed
in `excludedUnknownFunding` and in `missing`, never silently added or dropped. Household scope counts
full take-home of paychecks (contributions are internal and not added), all bills, targets, savings
and personal spending; each person's personal allocation (net − joint) funds their personal bills
first and any leftover is counted once as personal spending. Unknown take-home → `totalCents: null`
with `knownCents` as the known part.
- `whatChanged(planBefore, planAfter, opts) -> { remainingDeltaCents|null, annualDeltaCents|null, lines: string[] }`

### BudgetEngine.debt
- `paymentsLowerBound(balanceCents, paymentCents) -> { months: integer|null, note }` — ceil(balance / payment); a floor that holds only with 0% interest and a constant payment.
- `amortize({ balanceCents, aprPct, paymentCents, maxMonths: 600 }) -> { months|null, interestCents|null, neverPaysOff: boolean, note }` — **illustrative only**; caller must label the assumed rate.
- `illustrativeRange({ balanceCents, paymentCents, aprMin, aprMax }) -> { fastest, slowest, note }`
- `promoCheck({ promoBalanceCents, expiresMonth, paymentCents, fromMonth }) -> { status: 'needs_info'|'on_track'|'short', monthsLeft, requiredMonthlyCents, projectedRemainingCents, missing: string[] }`
- `summary(debt, bill) -> { lines: [{ label, value, status }], warnings: string[] }`

### BudgetEngine.forecast
- `project(plan, scenario, { startMonth, months, scope }) -> Projection`
```js
Projection = {
  scenarioId, scope, startMonth, months,
  rows: [{ month, incomeCents|null, incomeLines: [{ id, label, count, cents|null, basis }],
           spendingCents, billsCents, oneTimeCents, eventLines: [{ id, label, cents|null }],
           netCents|null, contributionsCents, unassignedCents|null,
           cumulativeCents|null, balanceCents|null, returnCents|null,
           goals: { [goalId]: cents|null }, warnings: string[] }],
  summary: { totalIncomeCents|null, totalOutCents, endCumulativeCents|null, endBalanceCents|null,
             lowest: { month, cumulativeCents|null, balanceCents|null }, negativeMonths: string[],
             firstNegativeBalanceMonth|null, contributionShortfallMonths: string[] },
  goals: [{ id, label, targetCents|null, targetMonth|null, projectedCents|null, status: 'funded'|'short'|'no_target'|'unknown_start'|'missing_amount', shortfallCents|null, reachedMonth|null }],
  missing: [{ label, source: 'plan'|'event', id }],
  assumptions: string[],
  complete: boolean
}
```
Rules: income timing per scenario assumption (`actual` counts real paydays per month, which shows
three-paycheck months for biweekly pay). Savings contributions earmark cash and are not subtracted
twice; a goal with `spendAtTarget` spends its target amount in `targetMonth` (once); a one-time event
with `goalId` draws that goal down instead of being counted twice. `balanceCents` is null unless
`plan.balances.jointCashCents` is known — the projection then reports cumulative change only. Return
is 0 unless `annualReturnPct > 0`, applies only to a positive known balance, and is labelled
hypothetical. Bills stop after `endMonth`. Unknown amounts produce `missing` entries and are excluded
from totals. Growth rates default to 0.
- `compare(plan, scenarios, opts) -> { columns: [{ scenarioId, name, projection }], rows: [{ label, values: [] }] }`

### BudgetEngine.state
- `VERSION = 5`, `storageKey(datasetId)`
- `defaults(profile, dataset) -> State`
- `sanitize(raw, profile, dataset) -> { state, notes }` — keeps every valid field, drops invalid ones with a note.
- `migrate(raw, profile, dataset) -> { state, notes }` — v1–v4 legacy shapes (`personAPay`, `targets.groceries`, `forecast.oneoffs`, …) → v5. No saved value is silently discarded: unmapped values are listed in notes.
- `exportWorkbook(state, { datasetId }) -> string` (JSON `{ format: 'household-budget-workbook', version: 5, exportedAt, state }`)
- `importWorkbook(text, profile, dataset) -> { state, notes }` — workbook JSON, raw legacy state JSON, or a legacy downloaded HTML copy (reads `<script id="budget-state">`).
- Scenario operations (pure, return new State): `addScenario(state, name, { copyFrom })`, `renameScenario`, `deleteScenario`, `addEvent(state, scenarioId, event)`, `updateEvent`, `removeEvent`.
- `setPath(state, path, value) -> State` (validated writes from forms), `getPath(state, path)`.
- `loadFromStorage(storage, datasetId, profile, dataset) -> { state, notes, source: 'v5'|'legacy'|'none' }`, `saveToStorage(storage, state) -> { ok, error }` (take a Storage-like object; never touch globals).

### BudgetEngine.attention
- `list({ dataset, txns, state, projection }) -> [{ id, severity: 'action'|'decision'|'info', title, detail, route }]`

## 9. UI routes

| Route | View |
| --- | --- |
| `#/overview` | What came in, went out, remains; joint vs household; decisions needing attention |
| `#/spending?period=2026-09&cat=Groceries&merchant=…&txn=…&q=…&window=3` | month → category → merchant → transaction drilldown with breadcrumbs |
| `#/budget?section=income|bills|targets|savings|debts` | edit plan inputs; planned vs actual; consequences |
| `#/forecast?scenario=…&compare=a,b&horizon=36` | scenarios, events, projections, side-by-side |
| `#/review?queue=uncertain|duplicates|transfers|reimbursements|business|spikes|coverage|edited|reconcile` | data review & corrections |
| `#/data` | load files, export/import workbook, storage & privacy explanation, reset |

`period` is `YYYY-MM` or a range `YYYY-MM..YYYY-MM`. Browser Back/Forward move through drilldown levels.
