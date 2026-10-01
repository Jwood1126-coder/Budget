# Architecture and module contracts

This is the engineering contract for the household budget workspace. It defines the data
formats, the saved-state schema and every module's public API. Code, tests and fixtures
must follow it; when an implementation needs to deviate, update this document in the same change.

**Privacy rule for this repository:** the GitHub repository is public. Only invented data may be
committed. Real names, amounts, balances, employers, merchants that identify a person, due dates,
locations and account numbers belong in the ignored `private/` folder. Tests and fixtures use
fictional households ("Alex" and "Sam", "Partner A"/"Partner B") and invented amounts. Run
`node tools/check-privacy.cjs` before committing.

**Conventions used everywhere:** money is integer cents and `null` means *unknown*, never $0;
months are `'YYYY-MM'`, dates `'YYYY-MM-DD'`; engine functions are pure (no DOM, storage or clock;
timestamps arrive through an optional `{ now }`); invalid input throws `E.ValidationError`
(`message`, `field`) with a sentence fit to show the user. Option values passed as `undefined` or
`null` keep their defaults.

## 1. Runtime shape

- Static, dependency-free browser app assembled into one self-contained HTML file
  (`dist/index.html`) by `tools/build.cjs`. No network requests, no remote assets, no analytics.
- Vanilla JavaScript (ES2020, no modules syntax). Each source file is an IIFE that attaches to
  `globalThis.BudgetEngine` (pure logic) or `globalThis.BudgetUI` (DOM). The same engine files are
  `require`d by Node tests in the order listed in `src/manifest.json`.
- Node ≥ 18 is the only toolchain (build, import, tests: `npm test` runs
  `node --test "tests/unit/*.test.cjs"`). Browser tests use Playwright when available.

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

`tools/import.cjs` refuses to write inside `fixtures/` unless `--sample` is given, and `--sample`
refuses unless the config is `"isSynthetic": true` **and** every input file lives inside
`fixtures/`. `--period` takes a range `A..B`.

## 2. Dataset (normalized ledger), schema version 2

Produced by the importer, embedded in the build or loaded in the browser. Immutable at runtime:
user corrections live in saved state (`ledgerEdits`), never in the dataset.

```js
Dataset = {
  schemaVersion: 2,
  datasetId: string,            // stable id; storage namespace. 'sample' for the fixture
  isSynthetic: boolean,
  generatedAt: 'YYYY-MM-DD'|null,
  currency: 'USD',
  accounts: Account[],
  transactions: Txn[],          // sorted by date, then id
  coverageOverrides: { 'YYYY-MM': { status: 'full'|'partial'|'none', note: string } },  // optional
  importLog: ImportLogEntry[],  // optional
  references: Reference[],      // optional reconciliation references (e.g. legacy totals)
  notes: string[]
}

Account = {
  id: string,                   // 'joint-checking'
  label: string,                // 'Joint checking'
  type: 'checking'|'savings'|'credit_card'|'loan'|'other',   // missing -> 'other' (warning)
  scope: 'joint'|'personal',    // joint = shared household account; missing -> 'joint' (warning)
  ownerId: null|'p1'|'p2',      // personal accounts only
  paidInFull: boolean,          // credit cards paid in full monthly (purchases are the spending)
  coverage: [{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }]   // inclusive ranges fully covered by exports
}

Txn = {
  id: string,                   // 'tx-' + hash(accountId|date|amount|normalized description|occurrence)
  accountId: string,
  date: 'YYYY-MM-DD',           // POSTED date (statement ledger)
  description: string,          // raw bank text
  merchant: string,             // cleaned display name
  amountCents: integer,         // SIGNED ACCOUNT FLOW: < 0 money leaves the account (purchase, bill,
                                //   payment, transfer out, card charge); > 0 money enters (deposit,
                                //   refund, transfer in, card payment received)
  kind: 'spend'|'income'|'transfer'|'card_payment'|'debt_payment',
  subtype: string|null,         // income: 'payroll'|'interest'|'reimbursement'|'other'
                                // transfer: 'savings'|'contribution'|'internal'|'investment'
                                // debt_payment: 'loan'|'store_card'|'other'
  category: string,             // household category after import rules (not user edits). Non-spend
                                //   kinds: 'Income', 'Transfer', 'Card payment', 'Debt payment' (or the rule's)
  sourceCategory: string|null,  // ORIGINAL bank category, never modified
  categoryReason: string,       // deciding reasons first, then flag-only reasons, joined by '; '
  confidence: 'high'|'medium'|'low',
  flags: string[],              // see Flags
  pairId: string|null,          // counterpart txn id (transfer / card / debt payment pairs)
  matchIds: string[],           // related candidates (e.g. reimbursement deposit <-> charge)
  personId?: 'p1'|'p2',         // OPTIONAL: only on transfers matched by a transferHint with personId
  sourceFile: string|null,      // file BASE name (relative path only when two base names collide)
  sourceRow: integer|null,      // 1-based physical line where the CSV record starts (header = line 1)
  note: string                  // may hold 'Transaction date YYYY-MM-DD.' when it differs from the posted date
}

Reference = { id, label, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', spendingCents: integer, source: string }
ImportLogEntry = { file, accountId, profile, rows, imported, skipped, duplicatesRemoved,
                   start, end, coverageStart, coverageEnd, signConvention }   // no timestamps
```

Validation: missing account type/scope or txn category are warnings with the defaults above;
dangling `pairId`/`matchIds` are warnings; duplicate ids, bad dates, non-integer cents, unknown
kinds and unknown accounts are errors.

### Counting rules (the single source of truth: `ledger.measure`)

| kind | counted as | amount used |
| --- | --- | --- |
| `spend` | **Spending** (consumption, including housing payment, bills, fees). Refunds are `spend` rows with positive flow and reduce spending. | `spendCents = -amountCents - reimbursedCents` |
| `income` | **Income** (payroll, interest, other). Never includes transfers. | `amountCents - reimbursedCents` |
| `transfer` `savings`/`investment` | **Saved.** On a non-savings account (the cash side) `savedCents = -amountCents`. On an account typed `savings` it counts only when `pairId` is null **or** its pair is not in the dataset (`pairMissing`), so a paired move counts once and a dangling pair is not lost. | see left |
| `transfer` `contribution` | **Contributions in** (from a partner's personal account outside the data), on any non-personal account, as the signed amount: money sent back out reduces it. | `amountCents - reimbursedCents` |
| `transfer` `internal` | Not income, not spending, not saving. | — |
| `card_payment` | Excluded: paying a card bill moves money; the card's purchases are the spending. `summarize` reports it once, on the paying (non-card) side. | — |
| `debt_payment` | **Debt payments** outflow (loans/financing whose original purchase is not in the data). Not category spending. | `-amountCents` |

Excluded rows count 0 everywhere. `reimbursedCents` is 0 except on partly reimbursed rows (below).

### Pairing done by the importer (`importer.pairTransfers`)

Opposite flows of equal size on two different household accounts within `pairDays` (default 5)
are paired greedily: explicit transfer/card-payment wording first, then debt-rule matches, then
unexplained deposits; closest date next; deterministic id tie-break.

| outflow (cash side) | inflow side | result |
| --- | --- | --- |
| transfer / card payment / debt payment | `credit_card` account | both sides become `card_payment` (a debt payment to a card whose purchases are in the data would double count) |
| transfer / debt payment | `loan` account | cash side `debt_payment`/`loan`; loan side a neutral `transfer`/`internal`, so the payment counts once |
| transfer | any account, unexplained income `other` (still `needs_category_review`) | income upgraded to `transfer`/`internal`; income classified by a user rule is never upgraded |
| transfer | `savings` account, or either side subtype `savings` | both sides labelled `savings` (not when either side is `contribution`/`investment`) |

Unpaired rows get `unpaired_transfer` and a note: every unpaired `card_payment` (the cash-side
note says the card's purchases may be missing from spending) and every unpaired `transfer` except
`contribution`/`investment`. `buildDataset` adds a report warning totalling unpaired card payments.

### Effective counting (user edits, section 4, via `ledger.applyEdits`)

- One exclusion reason per row, first that applies: `duplicate` (edit `duplicate: 'exclude'`) →
  `reimbursed` (confirmed) → `business` (`business: 'business'`) → `what_if` (pending reimbursement
  candidates, when `whatIf.excludePendingReimbursements`) → `what_if` (pending `business_candidate`
  rows, when `whatIf.excludeBusinessCandidates`).
- `planningBaseline: 'exclude'` sets `planningExcluded`; it affects only planning baselines, never actuals.
- A kind edit without a subtype resets the subtype to null; a blank category edit and an unknown
  kind edit are ignored with an `editWarnings` entry; splits apply only to `spend` rows and only
  when every part has a category and integer cents adding up exactly to the row's spending.

**Reimbursement linking** (`ledger.reimbursementLinks`, shared with `review`): charges (`spend`,
negative) and deposits (positive, not `spend`, not `card_payment`) are linked through `matchIds`
in either direction. Each deposit pays back at most one charge: exact-amount matches are taken
first across all charges, then the closest deposit on or after the charge. Linked rows nobody
flagged (`reimbursement_candidate`) and nobody decided are not candidates. A decision on either
side applies to both (`confirmed` wins over `not_reimbursed` over `pending`). A `confirmed` status
on a row with no link excludes only that row. A flagged deposit with no charge appears with
`chargeId: null`.

**Partial reimbursements:** when a confirmed (or what-if) pair's amounts differ, only the smaller
amount was paid back. The smaller side is excluded; the larger side stays counted with
`reimbursedCents` = the smaller amount, so only its remainder counts (spending parts are scaled
down proportionally in whole cents) and an `editWarnings` line explains it. `summarize` adds the
paid-back part to `excludedCents` / `excludedIncomeCents`. UI badges must check `reimbursedCents`
as well as `excluded`.

### Flags

`mixed_retail` (merchant sells many kinds of goods; contents not inferred), `needs_category_review`,
`reimbursement_candidate`, `business_candidate`, `duplicate_candidate` (not set by the importer;
`review.duplicateCandidates` finds near-duplicates), `unpaired_transfer`, `pending`, `fee`,
`refund`, `legacy:<original flag>` (preserved from v1 data).

### Coverage

`ledger.coverage(dataset, month, { purpose })`. For `purpose: 'spending'` (default) only
`checking`, `credit_card` and `other` accounts are expected: a missing savings or loan export does
not make spending incomplete (`purpose: 'all'` expects every account).

- An expected account is expected for every month between the earliest coverage start and the
  latest coverage end **among the expected accounts**, including an account with **no coverage
  ranges at all**: its spending is unknown, so it keeps those months `partial` instead of being
  counted as $0 (matches `importer.monthlySummary`).
- `full` when every expected account covers every day; `partial` when some days are missing;
  `none` outside the span or when no account covers any day.
- `coverageOverrides` win for `status`; `coveredDays` stays the computed fact and `note` becomes
  the override's note.
- Only `full` months enter usual-spend baselines, planning baselines and spike baselines.

### Legacy (v1) datasets

`ledger.normalizeDataset` accepts the earlier normalized schema (top-level `sources`, `monthly`,
`quarter`, `transactions` with positive spending `amountCents`). Conversion:

- `spend` rows flip sign (`amountCents_v2 = -amountCents_v1`); other kinds use `direction`
  (`outbound` → negative; missing → inbound for income, outbound otherwise); positive v1 spend rows
  also get the `refund` flag.
- `investment` kind → `transfer`/`investment`. Other subtypes are inferred from the row's labels:
  transfer `savings` if the text mentions saving, `contribution`, else `internal`; income
  `payroll`/`interest`/`reimbursement`/`other`; debt `store_card`/`loan`/`other`.
- `sources` → accounts (`type:'other'`, `scope:'joint'`, coverage from `start`/`end`). A row whose
  source is not listed gets a placeholder account (no coverage) and a dataset note instead of failing.
- `monthly[].hasMainCardCoverage === false` → `coverageOverrides[month] = {status:'partial'}`;
  `true` creates no override (coverage is computed from the source dates).
- `needsCategoryReview` → `needs_category_review`; every v1 flag is kept as `legacy:<flag>` and
  known flags are also kept as themselves; `matchingTransactionIds` → `matchIds`.
- `quarter.spendingCents` over `defaultPeriod` → Reference `legacy-quarter`; `asOfDate` →
  `generatedAt`; missing `datasetId` → `'legacy-sample'` / `'legacy-private'`.
- v1 pairs are not mapped to `pairId`, and a row with a kind outside the five known ones fails
  the whole dataset with a readable error (see Known limitations).

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
  references: Reference[],            // optional; NOT copied into State.references (user-entered only)
  rulesNote: string,                  // optional
  notes: string[]                     // optional: explains each deliberate unknown (targets have no note field)
}
```

People names come from `plan.people`, then `household.people`, then "Partner A"/"Partner B".
The sample keeps Sam's paycheck with `jointPerPaycheckCents: null` plus a separate contribution
stream; that is the shape the joint-scope rule in section 8 (`plan`) expects.

## 4. Ledger edits (user corrections; part of saved state)

```js
ledgerEdits = { [txnId]: Edit }
Edit = {
  category?: string, categoryReason?: string,     // reason required when category is set or cleared
  kind?: Txn.kind, subtype?: string|null, kindReason?: string,
  splits?: [{ category: string, cents: integer }], // spending split; cents sum must equal spendCents
  duplicate?: 'exclude'|'keep',
  reimbursement?: 'pending'|'confirmed'|'not_reimbursed',
  business?: 'pending'|'business'|'household',
  planningBaseline?: 'exclude'|'include',
  note?: string,                                   // replaces the imported note on the effective row
  history: [{ at: ISO-8601|null, field: string, from: any, to: any, reason: string }]
}
```

Edits are created with `review.editRecord`. Up to 50,000 corrections are kept, each with its
latest 200 history entries and up to 50 split parts. Corrections whose transaction is no longer
in the data are kept and listed (`review.queues().orphanEdits`).

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
  id, label, personId: 'p1'|'p2'|null,
  kind: 'paycheck'|'contribution'|'other',   // contribution = transfer from that person's personal account
  netPerPaycheckCents: cents|null,           // full take-home per occurrence (paycheck kind); null = unknown
  jointPerPaycheckCents: cents|null,         // portion reaching the joint account per occurrence
  frequency: 'weekly'|'biweekly'|'semimonthly'|'monthly'|'unknown',
  frequencyStatus: 'confirmed'|'observed'|'unknown',
  anchorDate: 'YYYY-MM-DD'|null,             // one real payday (weekly/biweekly timing; monthly fallback day)
  semimonthlyDays: [d1, d2],                 // default [15, 31]; 31 means last day of month
  monthlyDay: 1..31|null,
  assumedPerMonthIfUnknown: 0..5,            // explicit, labelled assumption used only while frequency is unknown (default 2)
  status: 'confirmed'|'estimate'|'observed'|'unknown',
  startMonth: 'YYYY-MM'|null, endMonth: 'YYYY-MM'|null,
  note
}
// Personal allocation for a paycheck = netPerPaycheck − jointPerPaycheck (when both known).

Bill = {
  id, label,
  category: string|null,                    // null for debt payments: they are not category spending
  monthlyCents: cents|null,
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
  aprPct: 0..100|null, aprRange: [min, max]|null, aprStatus: 'unknown'|'displayed'|'confirmed',
  paymentBillId: string|null,
  promo: null | { balanceCents: cents|null, expiresMonth: 'YYYY-MM'|null, deferredInterest: boolean|null, note },
  loanCount: 1..100|null, repaymentPlan: string|null, termStatus: 'unknown'|'confirmed',
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

Amounts are integer cents, 0 or more, up to $100M. Only `balances.jointCashCents` and
`Reference.spendingCents` may be negative (an overdrawn balance). State validation rejects other
negative amounts; `plan` and `forecast` treat a negative or non-integer amount as **not entered**
(listed in `missing`), never as a smaller total.

## 6. Scenarios

A scenario is the current plan plus a list of dated changes. Every scenario inherits later plan
edits; editing one scenario never changes another or any historical actual. The baseline scenario
(`id: 'baseline'`, "Current budget") has no events and cannot be deleted.

```js
Scenario = {
  id, name, description, createdAt, updatedAt,
  events: Event[],
  assumptions: { incomeTiming: 'actual'|'average'|'conservative', annualReturnPct: 0..25, costGrowthPct: -50..50, incomeGrowthPct: -50..50 }
}
Event =
 | { id, type: 'one_time', label, month: 'YYYY-MM'|null, amountCents: cents|null, direction: 'expense'|'income', category: string|null, goalId: string|null, note }
 | { id, type: 'recurring', label, startMonth: 'YYYY-MM'|null, endMonth|null, monthlyCents: cents|null, direction: 'expense'|'income'|'income_loss', category: string|null, note }
 | { id, type: 'income_change', label, streamId, startMonth, endMonth|null, netPerPaycheckCents?: cents|null, jointPerPaycheckCents?: cents|null, note }
 | { id, type: 'bill_change', label, billId, startMonth, endMonth|null, monthlyCents: cents|null, note }   // 0 = bill stops
 | { id, type: 'target_change', label, category, startMonth, endMonth|null, monthlyCents: cents|null, note }
 | { id, type: 'goal', label, goal: SavingsGoal }
```

- An event amount of `null` is a **missing cost**: never treated as $0 silently; reported in
  `result.missing` and shown prominently.
- A recurring event's `startMonth` may be null (start unknown, e.g. childcare not arranged yet);
  the forecast lists it as missing ("start month not set (left out)"), never as "now". Other dated
  event types require `startMonth`; an end month before the start is rejected.
- `income_change` fields: absent = unchanged, `null` = unknown during the change, cents = new amount.
- A `goal` event whose goal id matches a plan goal replaces that goal in this scenario only.
- Event ids are unique across all scenarios.

## 7. Saved state, schema version 5

```js
State = {
  version: 5,
  datasetId: string,                     // 'no-data' when there is no dataset
  plan: Plan,
  scenarios: Scenario[],                 // scenarios[0] is the baseline
  compareIds: string[],                  // scenarios shown side by side in Forecast (1..3, never empty)
  ledgerEdits: { [txnId]: Edit },
  references: Reference[],               // user-entered reconciliation references
  checklist: { [id]: boolean },
  ui: { scope: 'joint'|'household', lastRoute: string, whatIf: { excludePendingReimbursements: boolean, excludeBusinessCandidates: boolean }, dismissed: { [noticeId]: boolean } },
  meta: { createdAt, updatedAt, migratedFrom: null|0..4,           // 0 = unversioned earlier budget
          migrationNotes: string[], legacySnapshot: string|null }  // raw earlier data, set only by a migration
}
```

**Limits** (`state.LIMITS`): label 80 chars, note 500, category key 80, id 80, lastRoute 1000;
scenarios 20, events per scenario 200, incomes 12, bills 60, savings 30, debts 30, targets 200,
references 100, checklist 200, dismissed 500, compareIds 3, ledgerEdits 50,000, history per
correction 200 (latest kept), splits 50, migration notes 200, legacySnapshot 200,000 chars,
workbook 25,000,000 chars. Fields: `assumedPerMonthIfUnknown` 0–5, `aprPct` 0–100, `loanCount`
1–100, `annualReturnPct` 0–25, cost and income growth −50 to 50.

**Storage:** `localStorage['household-budget:v5:' + datasetId]`. Storage is **per browser profile
on one device**; it is not shared between people or devices. Sharing uses workbook export/import
(a JSON file the household passes between devices). `loadFromStorage` order:

1. The v5 key. A damaged entry is copied to `'<key>:unreadable'` (the only write during a load)
   and the profile defaults are used; it does not fall back to earlier keys.
2. Earlier-version keys `'sample-household-budget-v1-' + copyId`, **read only** (never written or
   deleted). `opts.legacyCopyIds` names them; by default a synthetic dataset (`isSynthetic` or id
   `'sample'`) reads `local-sample`, `hosted`, and a household dataset reads `local-private`,
   `hosted`, then downloaded copies `copy-*` found by scanning storage keys (newest first). The
   first readable copy is migrated; other copies are named in a note, not merged. A household never
   inherits the sample page's invented budget (a note says one was found and left alone).
3. `defaults(profile, dataset)`.

## 8. Module APIs

All functions are pure unless noted. `txns` passed to analysis functions are *effective*
transactions from `ledger.applyEdits`.

### BudgetEngine.categories
- `DEFAULT: [{ name, group, seasonal?: boolean, essential?: boolean }]`, `GROUP_ORDER`
- `groupOf(name) -> string` ('Other' when unknown), `isSeasonal(name, extraSeasonal?) -> boolean`,
  `isEssential(name)`, `find(name)`, `names() -> string[]`, `sortNames(list)`
- `UNCATEGORIZED = 'Uncategorized'`, `MIXED_RETAIL = 'Mixed retail'`

### BudgetEngine.ledger
- `normalizeDataset(raw) -> Dataset` — v1 or v2, object or JSON text (BOM stripped); validates;
  never mutates; throws `ValidationError` naming the first problems.
- `validateDataset(ds) -> { errors: string[], warnings: string[] }`
- `applyEdits(dataset, ledgerEdits, { whatIf } = {}) -> EffectiveTxn[]` (new objects) where
```js
EffectiveTxn = Txn & {
  baseCategory, baseKind, baseSubtype, baseNote,      // imported values; `note` is the edit note when set
  edit: Edit|null,                                    // a clone
  edited: boolean,
  accountType, accountScope, accountLabel, accountOwnerId,
  excluded: null|'duplicate'|'reimbursed'|'business'|'what_if',
  planningExcluded: boolean,
  reimbursementStatus: null|'pending'|'confirmed'|'not_reimbursed',
  reimbursedCents: integer,                           // paid-back part of a partly reimbursed row (else 0)
  businessStatus: null|'pending'|'business'|'household',  // spend rows flagged or decided only
  pairMissing: boolean,                               // pairId set but the pair is not in the dataset
  splitApplied: boolean,
  editWarnings: string[],
  parts: [{ category, spendCents }]                   // one entry (or the user's splits) for counted spending; [] when excluded / non-spend
}
```
- `measure(txn) -> { spendCents, incomeCents, debtCents, savedCents, contributionCents }` (section 2).
- `filter(txns, { start, end, months, accountIds, scope: 'joint'|'personal', kinds, category, merchant, query, flags, includeExcluded }) -> EffectiveTxn[]`
  (`category` matches any part; `flags` must all be present; `query` matches merchant, description,
  category, parts, source category, note, imported note, account label, or an amount like "486.60").
- `summarize(txns) -> { spendingCents, purchasesCents, refundsCents, incomeCents, payrollCents, contributionsCents, savedNetCents, debtPaymentsCents, cardPaymentsCents, excludedCents, excludedIncomeCents, excludedCount, count }`
  — `refundsCents` is positive and `spendingCents = purchasesCents − refundsCents`; `count` = rows
  that count; `excludedCents` = spending excluded rows would have added plus paid-back parts.
- `group(txns, by: 'month'|'category'|'merchant'|'account', { planning } = {}) -> [{ key, spendCents, count, ids, group?, label? }]`
  sorted by spend desc (months chronological). Category grouping uses parts. `planning: true` omits planning-excluded rows.
- `months(dataset) -> 'YYYY-MM'[]` (all months from earliest coverage/transaction to latest)
- `coverage(dataset, month, { purpose: 'spending'|'all' } = {}) -> { month, purpose, status, computedStatus, overridden, coveredDays, totalDays, accounts: [{ accountId, label, type, coveredDays, totalDays, missingDays, expected }], note }`
- `coverageMap(dataset, opts?) -> { [month]: coverage }`, `latestCompleteMonth(dataset, opts?) -> 'YYYY-MM'|null`
- Also exported: `isLegacy`, `partsOf(txn)`, `checkSplits(splits, spendCents) -> { ok, message }`,
  `reimbursementLinks(txns) -> [{ chargeId|null, depositId|null, cents }]`, and the constants
  `KINDS`, `SUBTYPES`, `ACCOUNT_TYPES`, `SCOPES`, `EXCLUSION_REASONS`, `REIMBURSEMENT_STATUS`,
  `BUSINESS_STATUS`, `SPENDING_ACCOUNT_TYPES`, `KNOWN_FLAGS`.

### BudgetEngine.compare
- `RULE = { minDiffCents: 10000, minPct: 25, minMonths: 2 }`, `IRREGULAR_MIN_MONTHS = 3`
- `usual(txns, dataset, { month, window = 3, category?, planning?: boolean, rule?, seasonalCategories? }) -> ComparisonResult`
  (`window` is a whole number 1–36; the UI offers 3, 6, 12; `rule` entries left undefined/null keep the default)
```js
ComparisonResult = {
  month, window, selectedCoverage: coverage,
  trailingMonths: 'YYYY-MM'[],        // the `window` calendar months before `month`
  baselineMonths: 'YYYY-MM'[], usableCount, excludedMonths: [{ month, reason }],
  rule, planning: boolean,
  categories: [{
    category, group, actualCents, averageCents|null, diffCents|null, pct|null,
    signal: 'higher'|'lower'|'typical'|'new'|'irregular'|'no_history'|'limited_history'|'refund_baseline'|'partial_month'
          |'seasonal_higher'|'seasonal_typical'|'seasonal_lower'|'seasonal_unknown',
    explanation: string,              // plain-language reason, cites the rule and months used
    seasonal: null | { lastYearMonth, lastYearCents|null, lastYearCovered: boolean },
    monthsWithActivity: integer,
    basis: 'average'|'last_year',     // what diffCents/pct are measured against
    basisCents: cents|null,           // the trailing average or last year's amount
    planningExcludedCents: cents,     // baseline spending marked "exclude from planning"
    irregular: { month, cents }|null, // signal 'irregular' only: the one baseline month with activity
    ids: string[]                     // selected-month transaction ids
  }],
  totals: { actualCents, averageCents|null, diffCents|null }   // diffCents null unless the month is full
}
```
Rules, in the order they are applied per category:

| condition | signal | notes |
| --- | --- | --- |
| selected month not `full` | `partial_month` | `diffCents`/`pct` null; `averageCents` still reported; never flagged |
| seasonal, last-year month `full` | `seasonal_higher` / `seasonal_lower` / `seasonal_typical` | basis `last_year`; same threshold rule; **does not need `minMonths`** of trailing history; last year $0 → `new` ($0 actual → `seasonal_typical`); last year negative → `refund_baseline` |
| seasonal, last-year month not covered | `seasonal_unknown` | diff vs trailing average reported, not judged |
| no usable baseline month | `no_history` | |
| `usableCount < minMonths` | `limited_history` | diff reported, not flagged |
| activity in exactly **1** of ≥ `IRREGULAR_MIN_MONTHS` (3) usable baseline months (an annual bill such as home insurance, an occasional purchase) | `irregular` | `diffCents`/`pct` null, `averageCents` still reported, `irregular: { month, cents }` names that month; never marked higher or lower, in the month it is paid or in the months it is not. 0 active months → `new`; ≥ 2 → the rows below |
| average is $0 | `new` (or `typical` when actual is also $0) | a refund-only month with a $0 baseline is also `new` |
| average < 0 | `refund_baseline` | no percentage |
| otherwise | `higher` / `lower` / `typical` | flagged only when \|diff\| ≥ minDiffCents **and** ≥ minPct% of the basis |

The selected month never enters its own baseline; only `full` months count; a covered month with
no activity counts as $0; `pct` is null when the basis is ≤ 0. Explanations show a whole percent,
except that a difference just under the limit is shown truncated to one decimal (`+24.9%`), never
rounded up to the limit.
- `trend(txns, dataset, { category?, months? }) -> [{ month, spendCents|null, coverage }]` —
  `months` defaults to `ledger.months(dataset)`; `spendCents` is null only when coverage is `none`
  **and** the month has no rows; partial months return the known partial amount (the UI must show
  the coverage so it is not read as the month's total).
- `planningBaseline(txns, dataset, { endMonth, window }) -> { [category]: { actualAvgCents, adjustedAvgCents, excludedCents, usableCount, months } }`
  — uses the `window` **calendar** months ending at `endMonth` inclusive and keeps only the full
  ones (the same months `usual()` uses for the following month); it does not search further back.
  `adjustedAvgCents` leaves out planning-excluded rows; `excludedCents` is a total, not an average.
  `endMonth` defaults to `ledger.latestCompleteMonth`; returns `{}` when there is none.
- `planVsActual(plan, txns, dataset, { month, window?, scope? }) -> [{ category, kind: 'target'|'bill', label, plannedCents|null, actualCents, usualCents|null, adjustedUsualCents|null, diffToPlanCents|null, status: 'over'|'under'|'on_plan'|'no_plan'|'partial_month', sources: [{ kind, id, label, plannedCents }] }]`
  - Sources: `plan.targets` plus **joint-funded** bills that have a category, are not `planned`
    and are active that month (start/end months). Bills with a null category (debt payments) are skipped.
  - Targets and bills sharing a category are **merged into one row**: `kind` is `'target'` if any
    target is involved, `label` joins bill labels with " + ", `plannedCents` is `sumKnown` (null if
    any source amount is unknown → status `no_plan`, `diffToPlanCents` null).
  - Categories with spending but no plan follow, as `kind: 'target'`, `sources: []`, `no_plan`.
  - Scope: by default only **joint-account** spending is compared (targets and joint bills are
    joint-funded); `scope: 'all'` (or `'household'`) includes personal accounts.
  - In a partial month every row is `partial_month`, but `diffToPlanCents` is still computed.
  - `window` defaults to `plan.settings.comparisonWindow`, then 3. `usualCents` comes from
    `usual()`, `adjustedUsualCents` from `planningBaseline(endMonth = month − 1)`; both are 0 for a
    category without spending when there are usable months, null when there are none.
- `describeMonths(list) -> string` ("Jun–Aug 2026", "Nov 2025–Jan 2026", or a list).

### BudgetEngine.review
- `queues(dataset, txns, ledgerEdits?, { spikes? } = {}) -> { uncertain, mixedRetail, duplicates, transfers: { paired, unpaired }, reimbursements, business, spikes, annualSpikes, coverageGaps, edited, orphanEdits, counts }`
  - When `ledgerEdits` is omitted, the edits carried on effective rows are used.
  - `uncertain`: low confidence, `needs_category_review`, or Uncategorized spend, unless a
    category/kind/split was decided. `mixedRetail`: mixed-retail spend without a category or split.
  - `transfers.paired`: `{ ids, txns, kind, cents, amountsMatch, daysApart }`, outflow first.
    `transfers.unpaired`: rows plus `expected` and `reason`. Expected (nothing to fix) when the row
    is a confirmed reimbursement, a `contribution`, or when no counterpart account of the right type
    exists or none covers the date; not expected when its `pairId` points outside the data or a
    covering account has no match.
  - `business` items carry `status` (default `'pending'`).
  - `spikes` leaves out annual bills; they are listed in `annualSpikes` (`annual: true`) and not counted.
  - `coverageGaps`: every non-full month with the accounts missing days.
  - `edited`: rows with an edit, newest history first. `orphanEdits: [{ id, edit }]`: edits whose
    transaction is not in the data.
  - `counts = { uncertain, mixedRetail, duplicates, transfers (unpaired, not expected), transfersPaired, transfersExpected, reimbursements (pending), business (pending), spikes, coverageGaps, edited, orphanEdits }`.
- `duplicateCandidates(txns, ledgerEdits?) -> [{ ids: [a, b], reason, confidence, cents, accountId, daysApart, txns }]`
  — same account, same amount, ≤ 3 days apart, and description similarity ≥ 0.6 (shared tokens ÷
  the larger token count) or the same merchant; pairs where either row has a duplicate decision are
  left out; never auto-excluded. Confidence: `high` identical text ≤ 1 day apart; `medium`
  identical text or similarity ≥ 0.8; `low` otherwise. Sorted newest first, then by both ids.
- `spikes(txns, dataset, { minCents: 50000, multiple: 3, window: 6, includeAnnual: false }) -> [{ month, category, totalCents, usualCents, ids, priorMonths, planningExcludedCents, annual, annualMatch }]`
  — a category-month is a spike when total ≥ `minCents` and total ≥ `multiple` × the average of
  the `window` calendar months before it, full months only (at least 2 needed; a covered month
  without activity counts as $0). Newest first.
  - **Annual bills are not spikes:** when the same category has a total of at least half of this
    month's total 12 months away (or 11/13, for drifting payment dates), **before or after**, in a
    fully covered month, the category-month is annual (`annual: true`, `annualMatch: { month, cents }`),
    so neither the first nor a later payment of a yearly bill is listed. Annual items are left out
    unless `includeAnnual: true`; others have `annual: false`, `annualMatch: null`.
- `reimbursementPairs(txns) -> [{ chargeId|null, depositId|null, cents, status, charge, deposit }]`
  (links from `ledger.reimbursementLinks`; only flagged or decided pairs; `chargeId` null for a
  flagged deposit with no linked charge).
- `editRecord(prevEdit, field, value, reason, at) -> Edit` — returns a new edit; `value`
  null/undefined removes the field; history gets `{ at: at ?? null, field, from, to, reason }`.
  A non-blank reason is required for `category`, `kind` and `splits` **even when clearing them**;
  it is stored as `categoryReason`/`kindReason`. Unknown fields or invalid values throw. Whether
  splits add up is checked later by `applyEdits` (which knows the amount).
- Also exported: `similarity(a, b)`, `EDIT_FIELDS`, `REASON_REQUIRED`.

### BudgetEngine.importer
- `parseCSV(text) -> string[][]`; `parseCSVRecords(text) -> [{ fields, line }]` (RFC 4180 quotes,
  CRLF/LF, BOM, blank lines skipped; `line` = physical line where the record starts).
- `PROFILES` (header-based, most specific first): `card_debit_credit`, `card_signed_amount`,
  `debit_credit`, `signed_amount`; `COLUMN_SYNONYMS` lists accepted header names.
- `detectMapping(header) -> Mapping|null`. The header row is searched in the first 30 rows.
  `Mapping = { profile?, date, postDate?, description, amount?, debit?, credit?, category?, type?, balance?, status?, chargesPositive?: boolean, dateFormat: 'MDY'|'YMD'|'DMY', hasHeader? }`
  (column names, or indexes for header-less files). When a plain "Date" sits next to a posted-date
  column, the posted date is `Txn.date` (the plain one is the transaction date).
- `parseDate(text, format) -> 'YYYY-MM-DD'|null` — year-first dates are accepted in every format;
  trailing times are ignored; invalid dates give null.
- `normalizeFile({ name, text, account, mapping? }) -> { txns, skipped: [{ row, reason }], mapping, start, end, rows, headerRow, signConvention, warnings }`
  - Txns carry provisional ids `'row-<hash(file|row)>'` and `kind`/`category` null until `classify`.
  - Skipped reasons: `pending` (status column), `missing date`, `invalid date`, `missing amount`,
    `invalid amount`, `zero amount`, `amount too large` (above `money.MAX_INPUT_CENTS` or not a
    safe integer).
  - Debit/Credit columns use absolute values (debit = out, credit = in), whatever sign is printed.
  - `credit_card` **and** `loan` accounts with one Amount column use `mapping.chargesPositive`, or
    infer it from purchases vs payment-worded rows; when both have the same majority sign or the
    evidence ties, throws `ValidationError` with code `SIGN_UNKNOWN`. A non-boolean
    `chargesPositive` throws.
  - A checking/other export whose amounts are all positive takes direction from a debit/credit
    Type column (with a warning), or warns that it may be unsigned.
- `classify(txns, rules, accounts) -> Txn[]`. Precedence: user `merchantRules`, then
  `transferHints` (compiled as rules: they beat defaults but not an explicit user rule), then
  `DEFAULT_RULES`, then the bank `categoryMap` (user entries override defaults), then fallbacks.
  First match wins per field and flags are unioned, but a later rule implying a different kind,
  category or subtype than one already decided is ignored entirely (so the generic Amazon rule
  cannot add `mixed_retail` to an Amazon Prime fee). Fallbacks: a credit on a loan with no rule →
  `transfer`/`internal`, low confidence, `needs_category_review`; outflows and card/loan rows →
  `spend` (credits flagged `refund`); other deposits → income `other`, low, `needs_category_review`
  (never payroll without a payroll pattern); Uncategorized spend → low + `needs_category_review`.
- `DEFAULT_RULES` — generic patterns only (household-specific rules belong in `private/rules.json`),
  ordered specific → broad. Highlights: payment received on a card → `card_payment`; payment
  received on a loan → neutral `transfer`; strong card-payment wording on a cash account (CARD
  PAYMENT, CRD PMT, CREDIT CRD, CARD AUTOPAY, PAYMENT TO … CARD) → `card_payment` high; payroll,
  interest; person-to-person payments (Zelle, Venmo, PayPal…) flagged for review; savings and
  internal transfers; fees and interest charges; mortgage (spend `Mortgage`); loan servicers →
  `debt_payment`/`loan`; cash withdrawals; specific merchants before mixed-retail chains; a bare
  AUTOPAY/EPAY on a cash account → `card_payment` medium, placed after every named biller.
- `dedupe(txns) -> { kept, removed: [{ file, row, accountId, date, amountCents, description, keptFile, keptRow }] }`
  — multiset de-duplication across overlapping files (identical account/date/amount/normalized
  description; keeps the maximum count seen in any single file, all from one file).
- `assignIds(txns)` — final `tx-` ids (stable when overlapping exports are re-imported).
- `pairTransfers(txns, accounts, { days: 5 }) -> Txn[]` — see "Pairing done by the importer".
- `markReimbursementCandidates(txns, { days: 120, minCents: 2500, accounts }) -> Txn[]` — a deposit
  ≥ `minCents` that is income `other` or an unpaired `internal` transfer, not on a card/loan
  account, matched one-to-one to the closest earlier `spend` charge of the same amount within
  `days` (ties by id). Charges already refunded on their own account (same amount and merchant,
  refund on or after the charge) are matched to the refund first and not offered. Both rows get
  `reimbursement_candidate`, `matchIds` and a note; nothing is excluded.
- `buildDataset({ files: [{ name, text, accountId, mapping?, coverageStart?, coverageEnd? }], accounts, rules?, datasetId, isSynthetic?, generatedAt, coverageOverrides?, references?, notes?, pairDays?, reimbursementDays? }) -> { dataset, report }`
  — `generatedAt` is required (the engine never reads the clock); file names must be unique.
  Account coverage = declared ranges plus each file's coverageStart/End (or its first/last row
  date), merged; gaps between ranges are warned.
- `report = { datasetId, generatedAt, isSynthetic, transactions, start, end, files: [{ name, accountId, profile, rows, imported, skipped, skippedReasons, duplicatesRemoved, start, end, coverageStart, coverageEnd, signConvention }], accounts: [{ id, label, type, coverage, transactions }], totalsByKind, spending: { purchasesCents, refundsCents, netCents }, flagCounts, months: monthlySummary, duplicatesRemoved, skippedRows, warnings: string[] }`
- Also exported: `cleanMerchant`, `inferCardSign`, `prepareRules`, `mergeRanges`,
  `monthlySummary(dataset)` (per-month covered days per account, `spendingCoverage` ignoring
  savings/loan accounts like `ledger.coverage`, raw totals), `periodBreakdown(dataset, start, end)`
  (raw breakdown of a period for reconciling against an external total).

Rules format:
```js
Rules = {
  categoryMap: { [bankCategory]: householdCategory },
  merchantRules: [{ match: 'regex', field: 'description'|'merchant'|'sourceCategory', accountType?: string|string[], sign?: 'in'|'out',
                    category?, kind?, subtype?, merchant?, flags?: string[], confidence?, reason: string }],
  transferHints: [{ match: 'regex', subtype: 'savings'|'contribution'|'internal'|'investment', personId?: 'p1'|'p2', accountType?, sign?, reason? }]
}
```
Rule reasons are used verbatim; defaults are written as `'Rule: …'`.

### BudgetEngine.schedule
- `paydays(stream, month) -> 'YYYY-MM-DD'[]|null` — real deposit dates of the paychecks scheduled
  in `month`; null when the frequency is unknown or the needed date is missing. Monthly pay uses
  `monthlyDay`, else the anchor date's day. Semimonthly days that clamp to the same date count once.
- `count(stream, month, timing = 'actual') -> { count, basis: 'actual'|'typical'|'average'|'assumed'|'none', dates, assumption|null, perYear|null }`
  - `'none'`: outside the stream's start/end months (count 0). `'assumed'`: unknown frequency,
    `assumedPerMonthIfUnknown` with a plain assumption. `'typical'`: conservative timing, or actual
    timing without an anchor/payday (with an assumption). `'average'`: fractional count with
    `perYear` so callers round money once (per × perYear ÷ 12).
  - A frequency set but `frequencyStatus: 'unknown'` adds an assumption.
  - Under actual timing, a weekly/biweekly stream whose anchor falls in its `startMonth` does not
    count paydays before the anchor.
- `perMonth(frequency, timing: 'conservative'|'average') -> number|null` (weekly 4 | 52/12; biweekly 2 | 26/12; semimonthly 2; monthly 1)
- `frequencyTable(perPaycheckCents) -> [{ frequency, label, perYear, typicalChecks, typicalMonthCents, highMonthChecks, highMonthCents, averageMonthCents, annualCents, extraChecksPerYear, note }]`
  (`highMonth*` describe a 5-check weekly or 3-check biweekly month, null where every month is the
  same; money fields null for a null amount).
- Also exported: `activeIn(stream, month)`, `FREQUENCIES`, `TIMINGS`, `PER_YEAR`, `TYPICAL`, `LABELS`.

Weekend rule: semimonthly and monthly paydays on Saturday/Sunday move to the previous Friday, even
into the previous month (e.g. the 1st → the last Friday before it); the paycheck still counts for
its **scheduled** month, so semimonthly is always 2 a month and monthly always 1. Weekly/biweekly
follow the anchor exactly. Holidays are not modelled.

### BudgetEngine.plan
- `monthly(plan, { scope: 'joint'|'household' = 'joint', month?: 'YYYY-MM', timing? }) -> PlanSummary`
  (timing defaults to `plan.settings.incomeTiming`, then conservative; `actual` without a month
  falls back to conservative with an assumption)
```js
PlanSummary = {
  scope, timing, requestedTiming, month,
  income: { totalCents|null, knownCents, lowerBoundCents|null,
            lines: [{ id, label, personId, kind, cents|null, perPaycheckCents, count, basis, dates, assumption|null }],
            notCounted: [{ id, label, personId, cents|null, reason }] },
  spending: { targetsCents, lines: [{ category, cents|null }] },
  bills: { totalCents, lines: [{ id, label, category, type, debtId, cents|null, fundedFrom, status, planned, note }],
           excludedUnknownFunding: [{ id, label, cents }], excludedPersonal: [{ id, label, cents, fundedFrom }] },
  savings: { totalCents, lines: [{ id, label, cents|null, spendAtTarget }] },
  personal: [{ personId, name, allocationCents|null, billsCents, contributionsCents|null, spendingCents|null,
               leftoverCents|null, shortfallCents, source: 'allocation'|'estimate'|'missing'|'none',
               unknownBecause: null|'contribution', note }],
  personalSpendingCents,              // household scope only (0 in joint scope)
  outflowCents,                       // targets + bills (+ personal spending in household scope)
  remainingCents|null,                // income − outflow − savings; null when remainingUnknownReason is set
  remainingUnknownReason: null|'income'|'personal_spending',
  remainingUnknownNote: string|null,  // plain sentence saying why remainingCents is null
  missing: [{ id, label, area: 'income'|'bills'|'targets'|'savings'|'balances'|'debts', streamIds? }],
  assumptions: string[], warnings: string[],
  complete: boolean                   // no missing item outside 'balances'/'debts'
}
```
- **Joint scope** counts joint deposits, targets, joint-funded bills and savings contributions.
  Per stream: paycheck → its joint portion; contribution → joint amount (or net); other → joint
  amount (or net when it has no person). A paycheck with `jointPerPaycheckCents: null` from a person
  who also has a contribution stream is read as **"no direct deposit to joint"**: it goes to
  `income.notCounted` with an assumption, and that person's joint money is the contribution (the
  sample's Sam case). Without a contribution stream, a null joint portion makes joint income
  unknown. Bills with `fundedFrom: 'unknown'` are listed in `excludedUnknownFunding` and `missing`;
  personally funded bills in `excludedPersonal` with an assumption; never silently added or dropped.
- **Household scope** counts full take-home pay (contributions are internal: listed in
  `notCounted`), all bills, targets, savings and personal spending. A person with a contribution
  stream but no paycheck has unknown pay (missing id `'pay:<personId>'`).
- **Personal spending** (per person, both scopes; added to outflow only in household scope):
  `allocation = Σ(net − joint)` over their paychecks; `leftover = allocation − personal bills −
  their own contribution transfers`; `spendingCents = max(0, leftover)` (the transfers are
  subtracted because they already pay joint outflows). A negative leftover becomes
  `shortfallCents` with a warning to check whether other personal money covers it (warnings show
  in both scopes). A known allocation is counted in full, so a personal bill with an unknown amount
  sits inside personal spending, and a separate `personalSpending` estimate is not added on top
  (assumption).
- **Unknown contribution (household scope):** when a person's take-home and joint portion are
  known but their transfer to joint is unknown (e.g. an `income_change` that blanks it), their
  personal spending cannot be worked out. It is neither dropped nor replaced by the estimate
  (either would change the result only because a number is unknown): the entry gets
  `unknownBecause: 'contribution'`, a missing item `'personal:<personId>'` (area `'targets'`,
  `streamIds` = the unknown contribution streams) is added, and `remainingCents` is null with
  `remainingUnknownReason: 'personal_spending'`. In joint scope the entry carries the same note
  but nothing is missing (personal spending is not part of the joint budget).
- When the allocation itself is unknown (or the person has no paycheck), the `personalSpending`
  estimate is used (`source: 'estimate'`), else the person is listed missing
  (`'personal:<personId>'`, household scope).
- Contribution streams word their schedule assumptions as transfers, not paychecks.
- **Lower bound:** when income is unknown, `lowerBoundCents` = known income, plus in household
  scope, for each person whose pay is unknown, max(0, their known contributions − their known
  take-home).
- Other rules: a stream outside its start/end months is a known $0 that month, even if its amount
  is unknown; negative or non-integer amounts are treated as not entered; `planned` bills are
  included with an assumption; a spend-at-target goal stops contributing after its target month;
  household scope warns (assumption) when a bill with unconfirmed funding may also sit inside a
  person's personal spending; `balances` (joint cash unknown) and `debts` (balance unknown) missing
  areas do not affect `complete`.
- `whatChanged(planBefore, planAfter, opts) -> { remainingDeltaCents|null, annualDeltaCents|null, before, after, lines: string[] }`
  — `opts` as `monthly`; with `opts.month` the annual delta sums the 12 months starting there,
  otherwise 12 × the monthly delta. Lines cover incomes (including payday settings that move pay
  between months), bills, targets, goals, personal-spending estimates (added and removed) and
  joint cash; when the delta is unknown the last line says why (unknown income, or personal
  spending blocked by an unknown transfer).
- Also exported: `SCOPES`, `TIMINGS`, `TIMING_TEXT`, `activeIn`, `nameOf`.

### BudgetEngine.debt
Never invents a rate or term; never produces a payoff date. Negative payments and negative or
non-numeric rates throw `ValidationError`; null inputs give "not available" results.
- `paymentsLowerBound(balanceCents, paymentCents) -> { months|null, isLowerBound: true, note }` —
  ceil(balance ÷ payment); a floor that holds only with 0% interest and a constant payment. $0
  payment → months null.
- `amortize({ balanceCents, aprPct, paymentCents, maxMonths: 600 }) -> { months|null, interestCents|null, totalPaidCents|null, finalPaymentCents|null, neverPaysOff, exceedsMaxMonths, illustrative: true, aprPct, missing: string[], note }`
  — **illustrative only**; interest is APR/12 on the balance each month, rounded to the cent; a
  null rate, balance or payment returns no estimate with `missing[]`.
- `illustrativeRange({ balanceCents, paymentCents, aprMin, aprMax, maxMonths? }) -> { fastest, slowest, illustrative: true, missing, note }`
- `promoCheck({ promoBalanceCents, expiresMonth, paymentCents, fromMonth, deferredInterest? }) -> { status: 'needs_info'|'on_track'|'short', monthsLeft, requiredMonthlyCents, projectedRemainingCents, shortByCents, missing: string[], notes: string[] }`
  — months counted from `fromMonth` through `expiresMonth` inclusive; an end month before
  `fromMonth`, or a missing balance, end month, payment or start month gives `needs_info`;
  deferred interest absent/null is treated as unknown and its note is included.
- `summary(debt, bill, { month }?) -> { lines: [{ key, label, value, status }], warnings: string[], promo|null, lowerBound }`
  — `month` is the promotion check's starting month (without it the check needs info); a
  month-count illustration is added only when the APR is confirmed and recorded, never a date;
  escrow is asked for housing debts.

### BudgetEngine.forecast
- `project(plan, scenario|null, { startMonth, months: 1..120, scope: 'joint'|'household' = 'joint', now? }) -> Projection`
```js
Projection = {
  scenarioId, scenarioName, scope, timing, startMonth, months, endMonth, startBalanceCents|null,
  rows: [{ month, incomeCents|null, incomeKnownCents, incomeLowerBoundCents|null,
           incomeLines: [{ id, label, personId, count, cents|null, perPaycheckCents, basis, assumption }],
           spendingCents, billsCents, oneTimeCents, outCents,
           eventLines: [{ id, label, type, direction, category, cents|null, signedCents|null, goalId, fromGoalCents }],
           netCents|null, netUnknownReason: null|'income'|'personal_spending',
           contributionsCents, goalDrawsCents, unassignedCents|null,
           cumulativeCents|null, balanceCents|null, returnCents|null,
           goals: { [goalId]: cents|null }, warnings: string[] }],
  summary: { totalIncomeCents|null, totalIncomeKnownCents, totalOutCents, totalContributionsCents, totalReturnCents,
             endCumulativeCents|null, endBalanceCents|null,
             lowest: { month, cumulativeCents|null, balanceCents|null }, negativeMonths: string[],
             firstNegativeBalanceMonth|null, contributionShortfallMonths: string[], unknownNetMonths: string[] },
  goals: [{ id, label, targetCents|null, targetMonth|null, spendAtTarget, projectedCents|null, atLeastCents,
            status: 'funded'|'short'|'no_target'|'unknown_start'|'missing_amount', shortfallCents|null,
            reachedMonth|null, spentMonth|null, contributedCents, drawnCents, startKnown, note }],
  missing: [{ label, source: 'plan'|'event', id }],
  assumptions: string[],
  complete: boolean                    // no missing items and every month's income and net known
}
```
- Each month applies the active events to a copy of the plan and runs `plan.monthly` on it (plan
  savings are removed: goals are tracked by the forecast), so scope and counting match the Budget
  view. Timing: scenario `incomeTiming`, else `plan.settings.incomeTiming`, else conservative
  (`actual` counts real paydays, which shows three-paycheck months for biweekly pay).
- Row arithmetic: `spendingCents` = targets + personal spending + recurring expense events;
  `oneTimeCents` = one-time expenses + goal spending; `outCents` = spending + bills + one-time;
  `incomeCents` = plan income + income events − `income_loss` events (null when plan income is
  unknown); `netCents = incomeCents − outCents`, or null with `netUnknownReason` `'income'`, or
  `'personal_spending'` when (household scope) the month's plan summary cannot work out someone's
  personal spending because their transfer to joint is unknown. Cumulative and balance are then
  null too, so an unknown never makes a scenario look better than the baseline.
- **`unassignedCents = net − contributions + goalDraws`**: contributions earmark cash; money drawn
  from goals was set aside in earlier months, so it is added back (otherwise every goal-spend
  month would wrongly appear in `contributionShortfallMonths`). `negativeMonths` still uses
  `net < 0`, so those months show cash going down.
- **Goals:** contributions are never subtracted from cash a second time; they start at
  max(`startMonth`, `now`), stop once a known target is reached, and stop after the target month
  for a spend-at-target goal. A goal is judged at its target month before any spending (or at the
  end of the horizon; a target month beyond the horizon is judged by extending planned
  contributions to it). With `savedCents` unknown, contributions are projected from $0:
  `rows[].goals[id]` and `projectedCents` are null, `atLeastCents` is reported, and status is
  `funded` if contributions alone reach the target, else `unknown_start`. Duplicate goal ids keep
  the last one.
- **Goal/event linking rule:** one-time **expense** events with `goalId` on a spend-at-target goal
  are parts of that goal's target. Each linked event's cost is counted once as spending and drawn
  from the goal up to what it holds (the rest comes from other cash, with a warning). Linked
  events dated before the forecast start count as already paid. In the target month only the
  uncovered rest, max(0, target − linked amounts), is spent, so the total spent is
  max(target, linked amounts). Once linked spending covers the whole target, the goal is judged
  and done at that event. A linked event with a null amount is reported missing while the goal's
  known target is still spent; a null target with linked events is reported missing. A one-time
  event linked to a **keep** goal (`spendAtTarget: false`) draws it down by up to the amount it
  holds; contributions then refill it. A link to a goal that does not exist is counted as a regular
  expense with a warning.
- **Growth:** rates step once every 12 months from the start. Cost growth applies to targets,
  personal-spending estimates and bills of type utility/insurance/subscription/other (not debt or
  housing payments, which are fixed by contract). Income growth applies to paycheck streams only,
  not contribution transfers. Event amounts are used as entered. Default 0.
- **Return:** only a positive `annualReturnPct` applies, computed monthly (rate ÷ 1200) on the
  previous month's **positive known** balance and added to both cumulative and balance (so
  balance = start + cumulative). Positive rate with an unknown balance → `returnCents` null, nothing
  applied. Labelled hypothetical.
- **Balance:** `balanceCents` is null unless `plan.balances.jointCashCents` is known (the
  projection then reports cumulative change only). In household scope the balance starts from
  joint cash only (assumption: money in personal accounts is not included).
- **Validation:** only `startMonth`, `months`, `scope`, `now`, plan/scenario shape, `incomeTiming`
  and rates outside (−100, 100] throw. Negative or non-integer event, plan and goal amounts are
  treated as missing. Events with no date are missing; events of an unknown type, with an invalid
  end month, ending before they start, or pointing at a stream or bill not in the plan are ignored
  with an assumption note. Bills stop after `endMonth`; a `bill_change` never extends a bill past
  its own start/end months (0 stops it, null makes it unknown).
- Missing items from `plan.monthly` (areas income, bills, targets) are credited to the event that
  blanked the value when there is one (for blocked personal spending, the event that blanked one of
  its `streamIds`).
- `compare(plan, scenarios, opts) -> { columns: [{ scenarioId, name, projection }], rows: [{ key, label, kind: 'money'|'count'|'month'|'text', values: [], deltas: [] }] }`
  — `deltas` compare money rows with the first column (null when either is unknown).
- Also exported: `MAX_MONTHS = 120`, `EVENT_TYPES`.

### BudgetEngine.state
- `VERSION = 5`, `storageKey(datasetId)`, `LEGACY_KEYS(copyIds?)`, constants `STORAGE_PREFIX`,
  `LEGACY_PREFIX`, `LEGACY_COPY_IDS`, `WORKBOOK_FORMAT`, `BASELINE_ID`, `BASELINE_NAME`, `LIMITS`,
  `LEGACY_FIELDS` and `LEGACY_TARGETS` (where every earlier field goes), `EVENT_TYPES`,
  `SAVED_FORECAST_NAME`, `ENERGY_TARGET`, `OTHER_EXPENSES_TARGET`.
- `defaults(profile, dataset, { now }?) -> State` — the profile's plan, the baseline followed by
  the profile's scenarios, `compareIds` = baseline + first other scenario; `references` start empty.
- `sanitize(raw, profile, dataset, opts?) -> { state, notes }` — keeps every valid field and resets
  or drops invalid ones with a note naming the path. Also accepts JSON text, unwraps a workbook
  envelope, and passes earlier-version shapes and `{ copyId, state }` wrappers to `migrate`.
  - An invalid saved amount becomes **null (unknown)**, never the profile's value.
  - An end month before the start month is cleared with a note (`setPath` and the event validators
    reject it instead); a reference ending before it starts is dropped.
  - Duplicate ids are renamed `<id>-2`, …; event ids are made unique across all scenarios.
  - Events found on the baseline are moved into a new scenario "Changes moved from the current
    budget" (dropped with a note only when there is no room).
  - `compareIds` is never empty: it falls back to `['baseline', first other scenario]`.
  - A dataset id differing from the saved one is noted; edits apply where the transactions exist.
- `migrate(raw, profile, dataset, opts?) -> { state, notes }` — saved-state versions 1–4 or
  unversioned earlier budgets (object, JSON text or `{ copyId, state }` wrapper) → v5. Never
  throws; a v5 state goes to `sanitize`. `meta.migratedFrom` records the version (0 = unversioned),
  `meta.legacySnapshot` keeps the raw text (capped), `meta.migrationNotes` the notes. Rules:
  - **Saved values win, blanks do not:** a blank earlier value (null or '') never overwrites a known
    profile value and never creates goals, bills or targets; each case is noted.
  - `personBContribution` equal to the profile stream's monthly amount (semimonthly × 2 or monthly)
    keeps the profile's detailed schedule ("matches" note); otherwise the stream becomes
    `frequency: 'monthly'`, `jointPerPaycheckCents` = the monthly total, `frequencyStatus:
    'unknown'`, `status: 'estimate'`.
  - The earlier per-paycheck personal allocation becomes `jointPerPaycheckCents = net − allocation`
    (kept in the note when take-home is unknown or smaller).
  - **No double counting:** a known `energy` target becomes "Energy (gas + electric, migrated)" and
    removes the profile's Gas & heating / Electric targets **and bills**; a known `phoneInsurance`
    becomes one bill replacing "Internet & phone" bills **and target** (with a note that insurance
    bills may overlap); a known `cardFee` becomes a bill replacing the "Fees & interest" target
    **and bills**; a combined medical target (before v3 or per `healthMode`) sets Dental to null.
    Every removal is noted with the removed amounts.
  - Profile bills keep their own `fundedFrom`/`status`; only bills the migration creates get p1/p1/
    planned for vehicleA, student and lifeInsurance. `vehicleBFunding`: personal → p2, joint →
    joint, `'unknown'` never overwrites a known profile value.
  - Target keys `vision`/`unclassified` → Vision/Uncategorized; `otherExpenses` → "Other expenses
    (migrated)"; `otherIncome` → an `other` monthly stream with `personId` null; unknown keys keep
    their own target; zero values create nothing (noted).
  - `currentCash` ("cash available for goals") → `jointCashCents`; the profile's `asOf` is kept only
    when the amount is the same.
  - The earlier forecast becomes "Saved forecast (from earlier version)" only when it has events or
    non-zero growth assumptions (added to `compareIds` when there is room); childcare, baby costs and
    leave saved without a start month become recurring events with `startMonth: null`; a leave
    reduction with 0 leave months is not carried over (noted); changes beyond the 200-event limit
    are named in a note; `debtEnds` → bill `endMonth`.
  - Every unmapped earlier field is named in the notes and kept in the snapshot.
- `exportWorkbook(state, { datasetId, now }?) -> string` (JSON `{ format: 'household-budget-workbook', version: 5, exportedAt, datasetId, state }`)
- `importWorkbook(text, profile, dataset, opts?) -> { state, notes }` — workbook JSON, bare v5
  State, earlier saved state or wrapper, or an earlier downloaded HTML page (reads
  `<script id="budget-state">`, via `extractEmbeddedState(html)`). Friendly errors for unreadable,
  newer-version, empty, oversized files and for an earlier page with `{ copyId, state: null }`
  (its budget lived in that browser's storage).
- Scenario operations (pure, return a new State; optional `{ now }` updates `updatedAt`):
  `addScenario(state, name, { copyFrom, id, description, now })` (copied events get new ids),
  `renameScenario`, `deleteScenario` (alias `removeScenario`; the baseline cannot be deleted),
  `addEvent(state, scenarioId, event)` (not on the baseline), `updateEvent(state, scenarioId, eventId, patch)`
  (`undefined` in the patch removes an optional field), `removeEvent`, `validateEvent(event)`.
- Plan list items: `addItem(state, 'incomes'|'bills'|'savings'|'debts', item, { now }?)`,
  `removeItem(state, list, id, { now }?)` — removing a bill/debt clears the link on the other side;
  removing a goal sets `goalId: null` on scenario events.
- `setPath(state, path, value) -> State` (validated writes from forms, path-copying, input never
  modified), `getPath(state, path)` (returns a copy, or undefined for a missing item):
  - Lists use selectors: `plan.incomes[id=p1-pay].netPerPaycheckCents`,
    `plan.personalSpending[personId=p2].monthlyCents` (a personalSpending entry for p1/p2 is created
    on first write), `scenarios[id=…].events[id=…].monthlyCents`; a numeric index also works.
  - Map entries (`plan.targets`, `checklist`, `ui.dismissed`) take the rest of the path as the key
    (`plan.targets.Gas & heating`) or a quoted key (`plan.targets["A.B"]`).
  - Writing `undefined` **removes** a map entry or an optional `income_change` field.
  - Ids cannot be written, and a list's selector field cannot be rewritten
    (`…[personId=p1].personId` is refused). Whole sections and whole items cannot be set: use
    `addItem`, `removeItem` or `updateEvent`. `compareIds` takes 1–3 existing, distinct ids.
- `loadFromStorage(storage, datasetId, profile, dataset, { legacyCopyIds, now }?) -> { state, notes, source: 'v5'|'legacy'|'none' }`,
  `saveToStorage(storage, state) -> { ok, error, key?, bytes? }` (take a Storage-like object; never
  touch globals; never throw; quota errors get a plain message). See section 7 for the key order.

### BudgetEngine.attention
- `list({ dataset, txns, state, ctx }) -> [{ id, severity: 'action'|'decision'|'info', title, detail, route, cta? }]`
  — data items (from `review.queues`), plan items and forecast items (`ctx.project(scenarioId, { months })`
  supplies projections); sorted action → decision → info; items whose `'attention:' + id` is in
  `state.ui.dismissed` are hidden; a part that fails becomes one `info` item instead of breaking the list.

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

## 10. Known limitations

Deliberate gaps in the current engine; each needs a contract decision before it changes.

- **Closed or replaced accounts:** every spending account is expected from the earliest to the
  latest coverage of any spending account, so after a card is closed every later month stays
  `partial`. There is no account end date or "closed" flag; use `coverageOverrides` meanwhile.
- **Coverage has no scope:** gaps in a personal account (or a declared personal account with no
  export) make joint-view months partial too.
- **Investment accounts must be typed `savings`:** a paired savings/investment transfer between two
  non-savings accounts (e.g. a brokerage typed `other`) nets to $0 saved. In the joint view, money
  moved from a personal account that is in the data into joint savings shows no saving
  (`measure` has no scope).
- **Pay schedules:** holidays are not modelled. Years with a 53rd weekly or 27th biweekly payday
  come out right only under `actual` timing (`average` uses 52 and 26). A payday on the 1st that
  rolls back into the previous month counts in its scheduled month, so plan vs bank data can differ
  for those two months. `average` timing rounds each month, so 12 months can differ from the
  annual pay by a few cents.
- **Loan interest is counted twice** when the loan account is imported: the loan-side INTEREST
  CHARGE is spend (Fees & interest) and the checking-side payment that includes it is a debt
  payment. Principal and interest are not split. A mortgage paid from checking is spend
  `Mortgage`; if the mortgage account is also imported, its payment-received row stays a neutral
  transfer flagged as unpaired.
- **Importer wording:** a checking row worded "DEBIT CARD PAYMENT <merchant>" matches the strong
  CARD PAYMENT rule and becomes a high-confidence `card_payment` left out of spending (it is
  flagged `unpaired_transfer`); add a user rule if a bank uses this wording. Payroll patterns also
  match direct-deposit tax refunds; the person-to-person rule catches PayPal merchant purchases
  (flagged for review); negative card rows such as PAYMENT RETURNED or BALANCE TRANSFER fall to
  Uncategorized spend (flagged). The unsigned-checking heuristic applies only when every amount is
  positive.
- **planVsActual** matches joint bills to category spending only; a debt bill given a category
  would show `under` by the full payment, because `debt_payment` rows are not category spending.
- **Annual bills:** the `irregular` comparison signal covers a charge seen once in the baseline
  and spikes skip charges that recur 11–13 months apart; a bill paid twice a year still uses the
  average and can read `lower` in the months between, and a yearly bill's first payment is listed
  as a spike until a year-apart payment is in the data. Budget such bills through the plan.
- **Household scope:** the whole personal allocation is counted as spent, so paying off a
  personally funded debt frees money that is counted as more personal spending and shows no
  benefit. The "no direct deposit to joint" reading ignores the contribution stream's start/end
  months. Personal shortfall warnings also appear in joint scope.
- **Review:** two equal transfers or card payments within 3 days, each paired to its own
  counterpart, are still suggested as duplicates (kept on purpose). A refund-only month against a
  $0 baseline is labelled `new`. Conflicting reimbursement decisions on the two sides of a pair
  resolve to `confirmed`.
- **Legacy v1 datasets:** sources are typed `other` and v1 pairs (card repayments,
  checking-to-savings) are not mapped to `pairId`, so if both sides are present card payments and
  Saved net toward zero; a kind outside the five known ones fails the whole dataset. The legacy
  fixture's last month is partial because its source coverage ends before month end.
- **Migration judgement calls:** an explicit earlier $0 for energy, phoneInsurance or cardFee
  replaces known profile items (noted with both amounts); a known phoneInsurance cannot tell whether
  "other insurance" already includes a home-insurance bill (noted); a leave with 0 months must be
  re-entered. `sanitize` resets an invalid event direction to `expense` (flipping an income event)
  and an invalid income kind to `paycheck`, each with a note. Removing an income or bill leaves
  scenario changes pointing at it; the forecast ignores them with a note.
- `debt.summary` shows the payer as a person id, and without `opts.month` the promotion check
  needs a starting month.
