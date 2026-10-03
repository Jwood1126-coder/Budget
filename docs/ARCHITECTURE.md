# Architecture and module contracts

This is the engineering contract for the household budget workspace. It defines the data
formats, the saved-state schema and every module's public API. Code, tests and fixtures
must follow it; when an implementation needs to deviate, update this document in the same change.

**Privacy rule for this repository:** the GitHub repository is public. Only invented data may be
committed. Real names, amounts, balances, employers, merchants that identify a person, due dates,
locations and account numbers belong in the ignored `private/` folder. Tests and fixtures use
fictional households ("Alex" and "Sam", "Partner A"/"Partner B") and invented amounts. Run
`node tools/check-privacy.cjs` before committing (the `.githooks/pre-commit` hook runs it with
`--staged`, which scans the staged content the commit would publish). Besides the denylist it
flags the markers private outputs carry: datasets and profiles whose `isSynthetic` is false,
exported workbooks, private builds (build info `kind` private, or `profilePrivate` true) and the
import report's private comment (the patterns are in `tools/check-privacy.cjs`). `tools/import.cjs` and `tools/build.cjs` refuse private outputs inside the
repository outside `private/` (and `dist/` for builds).

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
    balances.js          balances over time, patterns, projection limits (BudgetEngine.balances)
    flows.js             spending by role and how it was paid, money into joint by person, savings in/out, the baseline the Plan screen's dials start from (BudgetEngine.flows)
    timeline.js          the plan screen: months, dials, drill-down, balances that drive the line (BudgetEngine.timeline)
    state.js             saved-state schema, migration, storage  (BudgetEngine.state)
    attention.js         "needs attention" list (Review)         (BudgetEngine.attention)
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
  balances: Balance[],          // posted balances supplied with the data (see below); [] when none.
                                //   Optional in files: absent -> [] (additive: schemaVersion stays 2)
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
  balanceCents?: integer,       // optional: the running balance the bank printed after this row
                                //   (checking/savings exports only; absent when the export has none)
  note: string                  // may hold 'Transaction date YYYY-MM-DD.' when it differs from the posted date
}

Balance = {                     // the account's balance at the END of `date`
  accountId: string,            // an account in `accounts`
  date: 'YYYY-MM-DD',
  cents: integer,               // money in the account (cash accounts); as the statement prints it
  source: 'statement'|'bank',   // statement: supplied by the household (import config `balances`,
                                //   or a balances.csv loaded in the browser); bank: the running
                                //   balance an export prints, at the account's last covered day
  note?: string                 // optional, at most 500 characters
}
Reference = { id, label, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', spendingCents: integer, source: string }
ImportLogEntry = { file, accountId, profile, rows, imported, skipped, duplicatesRemoved,
                   start, end, coverageStart, coverageEnd, signConvention }   // no timestamps
```

Validation: missing account type/scope or txn category are warnings with the defaults above;
dangling `pairId`/`matchIds` are warnings; duplicate ids, bad dates, non-integer cents, unknown
kinds and unknown accounts are errors.

### Balances supplied with the data

Posted balances travel with the data instead of being typed into the app. `dataset.balances` holds
one entry per account and date, sorted by account id then date. Precedence for the same account
and date: a `statement` beats a `bank` figure whatever the order; between equals the later one
wins. Producers:

- `tools/import.cjs`: the config's optional `balances` list, `[{ accountId, date, cents }]` or
  `"amount": "1,234.56"` instead of `cents`, optional `source` (default `statement`) and `note`;
  validated by `importer.statementBalances` (the account must exist, the date be valid, one entry
  per account and date). Plus `importer.bankBalances`: for each checking/savings/other account
  whose export has a Balance column, the end-of-day running balance of the account's last row,
  dated the account's last covered day (only when that row lies in the last coverage range and
  every row of its day prints a balance; card and loan "balances" are amounts owed and are never
  used). A statement that disagrees with the bank's figure on the same day is a report warning.
- The browser (Data & privacy): a balances file (`account,date,balance[,note]`, read by
  `importer.parseBalancesCSV`) adds `statement` entries; exports added later add `bank` entries
  at the new last covered day (`importer.mergeDataset`).

`ledger.normalizeDataset` keeps `balances` (`ledger.normalizeBalances`: entries with an unknown
account, bad date, non-integer cents or unknown source are dropped with a validation warning);
`timeline.anchors` reads them. Per-transaction `balanceCents` stays as before.

### Adding exports over time (`importer.mergeDataset`)

Newer exports are added to an existing dataset instead of replacing it:

- Files are read with the dataset's own accounts (plus any account new in this import that a file
  uses). A file name already in the data gets a ` (2)` suffix for its new rows.
- **Dedupe against the data:** a new row whose account, date, amount and normalized description
  match a row already in the data is not added; counts are a multiset, as in `dedupe` (the data
  counts as one more file), so genuine same-day repeats survive.
- **Stable ids:** existing rows keep their ids and contents, so ledger edits keyed by id keep
  applying. New rows get `'tx-' + hash(account|date|amount|normalized description|n)` with `n`
  continuing after the copies already in the data, which is exactly the id a fresh import of all
  the files gives (ids never depend on the file, its name, the row order or the rules).
- New rows are classified with the rules given; pairing and reimbursement matching run over all
  rows. An existing row changes only when it pairs with (or matches) a new row, or when its
  unpaired note no longer fits the merged coverage.
- Coverage is extended per account (new gaps are warned about); `balances` are merged with the
  precedence above; `importLog` and `notes` are appended; `generatedAt` becomes the merge date;
  `isSynthetic` is false unless the caller says otherwise (the browser never vouches for files).

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
  balances: { jointCashCents: cents|null, asOf: 'YYYY-MM-DD'|null, note,
              accounts: { [accountId]: cents|null }, accountsAsOf: 'YYYY-MM-DD'|null,     // per-account balances (exports without a running balance)
              accountDates: { [accountId]: 'YYYY-MM-DD'|null } },  // each balance's own date; absent → accountsAsOf
  settings: { incomeTiming: 'conservative'|'average'|'actual', planningBaseline: 'actual'|'adjusted', comparisonWindow: 3|6|12 },
  changes: PlannedChange[]             // dated changes on the plan screen (BudgetEngine.timeline); absent in older budgets → []
}

PlannedChange = {                      // up to 100; validated like every list item (strict through addItem/updateItem/setPath)
  id, label,
  kind: 'oneTime'|'monthly',           // one-time: startMonth only; monthly: startMonth through endMonth (null = open-ended)
  group: 'income'|'essentials'|'flexible'|'irregular'|'savings',
  personId: 'p1'|'p2'|null,            // income only (null: "other money in"); cleared on other groups
  startMonth: 'YYYY-MM',               // required
  endMonth: 'YYYY-MM'|null,            // monthly only (cleared on a one-time change); never before startMonth
  cents: signed cents|null,            // null = amount not known yet: listed and reported, never applied as $0
  accepted: boolean (false),           // false = listed only, not applied
  template: string|null,               // e.g. 'baby' for items from timeline.templates.baby
  note
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

Amounts are integer cents, 0 or more, up to $100M. Only `balances.jointCashCents`, per-account
balances, `PlannedChange.cents` (a drop in income, a refund) and `Reference.spendingCents` may be
negative (an overdrawn balance). State validation rejects other
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
  ui: { scope: 'joint'|'household', lastRoute: string, whatIf: { excludePendingReimbursements: boolean, excludeBusinessCandidates: boolean },
        plan: { baselineMonths: 3|6|12|'all' (12), horizon: 6|12|24|60 (12), past: 6|12|'all' (12),
                mode: 'balance'|'flows'|'trends' ('balance'), coverFromSavings: boolean (true),
                dials: { [dialKey]: signed cents|null },          // set directly; null/absent = not set; 0 is an amount.
                                                                  // dialKey ∈ state.DIAL_KEYS: p1, p2, inOther, essentials,
                                                                  // flexible, irregular, savings, other (others refused)
                rows: { [rowId]: { included?: boolean, cents?: signed cents } },  // essentials/flexible drill-down changes
                hidden: string[]|null,                            // chart series switched off; null = never chosen
                groups: { [categoryName | 'merchant:' + place]: 'essentials'|'flexible' },  // household's grouping ({}); keys ≤ 120 chars, up to 300
                irregularOff: { [txnId]: true },                  // one-time costs left out of the irregular allowance ({}); up to 1,000
                trends: { series: string[] (['card']; keys from state.TREND_SERIES, up to 16; unknown ones dropped),
                          ma: 0|3|6 (3), trend: boolean (true) },     // the Trends chart
                legacyDials?: { card?: signed cents, bank?: signed cents },  // absent unless waiting: amounts set for the
                                                                  // earlier card/bank dials, until Plan carries them over
                cardSplit?: { [essentials|flexible|irregular]: { cents: signed cents, card: signed cents,
                              fromCard?: signed cents, fromBank?: signed cents } } },
                                                                  // absent unless needed: the card part of a direct amount,
                                                                  // used while dials[key] === cents (set by migrateDials);
                                                                  // fromCard/fromBank mark it as carried over from the
                                                                  // earlier card/bank amount until kept (acceptCarriedOver)
                                                 // the plan screen (BudgetEngine.timeline). Replaces the earlier ui.home:
                                                 // sanitize moves p1InCents/p2InCents/cardCents/bankCents/savedCents to
                                                 // dials p1/p2/card/bank/savings and baselineMonths/horizon to their
                                                 // fields (what ui.plan already holds wins; outCents is named as not
                                                 // carried over), drops ui.home and notes it in meta.migrationNotes.
                                                 // Card and bank were dials before spending was grouped by how adjustable
                                                 // it is: a saved ui.plan.dials.card/bank moves to ui.plan.legacyDials
                                                 // (a newer one replaces one already waiting) with a note in
                                                 // meta.migrationNotes, and the plan screen carries it over to
                                                 // essentials, flexible and irregular (timeline.migrateDials). Both idempotent.
        dismissed: { [noticeId]: boolean } },
  meta: { createdAt, updatedAt, migratedFrom: null|0..4,           // 0 = unversioned earlier budget
          migrationNotes: string[], legacySnapshot: string|null }  // raw earlier data, set only by a migration
}
```

**Limits** (`state.LIMITS`): label 80 chars, note 500, category key 80, id 80, lastRoute 1000;
scenarios 20, events per scenario 200, incomes 12, bills 60, savings 30, debts 30, targets 200,
references 100, checklist 200, dismissed 500, compareIds 3, ledgerEdits 50,000, history per
correction 200 (latest kept), splits 50, migration notes 200, legacySnapshot 200,000 chars,
workbook 25,000,000 chars, per-account balances and balance dates 30, plan dials 20, plan row
changes 500, hidden series 40, plan groups 300 (keys 120 chars), one-time costs left out 1,000
(keys 200 chars), Trends series 16, planned changes 100. Fields: `assumedPerMonthIfUnknown` 0–5, `aprPct` 0–100, `loanCount`
1–100, `annualReturnPct` 0–25, cost and income growth −50 to 50.

**Storage:** `localStorage['household-budget:v5:' + datasetId]`. Storage is **per browser profile
on one device**; it is not shared between people or devices. Sharing uses workbook export/import
(a JSON file the household passes between devices). `loadFromStorage` order:

1. The v5 key. A damaged entry is copied to `'<key>:unreadable'` (the only kind of write during a
   load) and the profile defaults are used; it does not fall back to earlier keys.
2. Earlier-version keys `'sample-household-budget-v1-' + copyId`, **read only** (never written or
   deleted). `opts.legacyCopyIds` names them; by default a synthetic dataset (`isSynthetic` or id
   `'sample'`) reads `local-sample`, `hosted`, and a household dataset reads `local-private`,
   `hosted`, then downloaded copies `copy-*` found by scanning storage keys (newest first). The
   first readable copy is migrated; other copies are named in a note, not merged. A household never
   inherits the sample page's invented budget (a note says one was found and left alone). A
   damaged earlier copy is skipped, and copied to `'<v5 key>:unreadable'` unless a copy is already
   kept there.
3. `defaults(profile, dataset)`.

**In the page** (`src/ui/app.js`):

- While a `'<key>:unreadable'` copy exists, every view shows a warning and Data & privacy offers
  to download or delete it.
- **Several tabs:** each tab remembers the budget text it last read or wrote. Before saving it
  compares that with what is stored; if another tab saved since, it shows that tab's budget
  instead of writing over it (and says the change was not saved). `storage` events from other
  tabs update an open tab straight away, and clear its Undo history.
- The last page shown is kept under `'household-budget:last-route:' + datasetId`, not by
  rewriting the budget on every page change (which would make open tabs overwrite each other).
- When saving fails or storage is unavailable, every view shows a warning with the browser's
  reason, and change messages say "changed on this page only" instead of "saved".
- Undo: the last 30 undoable changes, through the toast's Undo, a persistent Undo button in the
  top bar, or Ctrl+Z / Cmd+Z outside text fields, until the page is closed.

## 8. Module APIs

All functions are pure unless noted. `txns` passed to analysis functions are *effective*
transactions from `ledger.applyEdits`.

### BudgetEngine.categories
- `DEFAULT: [{ name, group, seasonal?: boolean, essential?: boolean }]`, `GROUP_ORDER`
- `groupOf(name) -> string` ('Other' when unknown), `isSeasonal(name, extraSeasonal?) -> boolean`,
  `isEssential(name)`, `find(name)`, `names() -> string[]`, `sortNames(list)`
- `essential` marks spending that is hard to cut; the plan screen plans it as **essentials** and
  everything else as **flexible**: Mortgage, Home maintenance & repairs, Property tax & HOA, every
  utility (Gas & heating, Electric, Water & sewer, Trash & municipal, Internet & phone), Groceries,
  Fuel, Auto maintenance, every insurance, Medical & pharmacy, Dental, Vision, Baby & childcare, and
  'Debt payment' (not a spending category; debt payments themselves are the plan's `other` dial).
  Flexible: dining, shopping (Mixed retail, household, clothing, electronics), home improvement,
  parking, rideshare, pets, personal care, education, entertainment, subscriptions, hobbies, travel,
  gifts, fees, cash, uncategorized.
- `UNCATEGORIZED = 'Uncategorized'`, `MIXED_RETAIL = 'Mixed retail'`

### BudgetEngine.ledger
- `normalizeDataset(raw) -> Dataset` — v1 or v2, object or JSON text (BOM stripped); validates;
  never mutates; throws `ValidationError` naming the first problems. Always has `balances` ([] when absent).
- `normalizeBalances(list, accountIds) -> Balance[]` — section 2 "Balances supplied with the data";
  drops unusable entries, one per account and date (statement > bank; equals: the later wins); never throws.
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
| activity in exactly **1** of ≥ `IRREGULAR_MIN_MONTHS` (3) usable baseline months (an annual bill such as home insurance, an occasional purchase), and the selected month is $0 or close to that one occurrence | `irregular` | `diffCents`/`pct` null, `averageCents` still reported, `irregular: { month, cents }` names that month; never marked higher or lower, in the month it is paid or in the months it is not. A selected month far from the single occurrence falls through to the rows below. 0 active months → `new`, unless the yearly-bill check matches; ≥ 2 → the rows below |
| no activity in the window, but the same category 11–13 months earlier was a full month holding 50–200% of this month's amount (`yearlyMatch`) | `irregular` | a yearly bill paid again, not something new; `irregular` names last year's month |
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
- `planVsActual(plan, txns, dataset, { month, window?, scope? }) -> [{ category, kind: 'target'|'bill', label, plannedCents|null, actualCents, usualCents|null, adjustedUsualCents|null, diffToPlanCents|null, status: 'over'|'under'|'on_plan'|'no_plan'|'partial_month'|'irregular', sources: [{ kind, id, label, plannedCents }] }]`
  - `irregular`: nothing was spent this month and the category's comparison signal is `irregular`
    (a yearly or occasional bill that is not due); the Budget view shows "Not due this month"
    instead of "under plan".
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
- `buildDataset({ files: [{ name, text, accountId, mapping?, coverageStart?, coverageEnd? }], accounts, rules?, datasetId, isSynthetic?, generatedAt, coverageOverrides?, references?, notes?, balances?, pairDays?, reimbursementDays? }) -> { dataset, report }`
  — `generatedAt` is required (the engine never reads the clock); file names must be unique.
  Account coverage = declared ranges plus each file's coverageStart/End (or its first/last row
  date), merged; gaps between ranges are warned. `balances` = statement balances (validated by
  `statementBalances`); `dataset.balances` = `bankBalances` merged with them (section 2).
- `report = { datasetId, generatedAt, isSynthetic, transactions, start, end, files: [{ name, accountId, profile, rows, imported, skipped, skippedReasons, duplicatesRemoved, start, end, coverageStart, coverageEnd, signConvention }], accounts: [{ id, label, type, coverage, transactions }], balances, totalsByKind, spending: { purchasesCents, refundsCents, netCents }, flagCounts, months: monthlySummary, duplicatesRemoved, skippedRows, warnings: string[] }`
- `mergeDataset(base, { files?, accounts?, rules?, generatedAt, balances?, notes?, isSynthetic?, pairDays?, reimbursementDays? }) -> { dataset, report, summary }`
  — adds exports and/or statement balances to an existing dataset (section 2, "Adding exports
  over time"). `accounts`: accounts new in this import (the dataset's own are used as they are).
  At least one file or balance; `generatedAt` required.
  `summary = { transactionsBefore, transactionsAfter, added, alreadyPresent, duplicatesWithinFiles, skipped, existingChanged, coverageEndBefore, coverageEnd, accounts: [{ id, label, type, isNew, added, alreadyPresent, coverageBefore, coverageAfter }], balances: { added, replaced: [{ from, to }], ignored: [{ entry, kept }] }, renamedFiles: [{ from, to }] }`;
  `report = { datasetId, generatedAt, transactions (new rows), start, end, files: [... + alreadyPresent; duplicatesRemoved includes them], totalsByKind, spending, flagCounts, duplicatesRemoved (within the new files), alreadyPresent: [{ file, row, accountId, date, amountCents, description, keptId, keptFile, keptRow }], skippedRows, balances, warnings }` (all about the new rows).
- `statementBalances(list, accounts) -> Balance[]` — validates the config's `balances` (throws
  `ValidationError` naming the item: unknown account, bad date, missing/non-integer cents, an
  unparseable amount, cents and amount disagreeing, a bad source, two entries for one account and date).
- `bankBalances(transactions, accounts) -> Balance[]` — the `bank` entries (section 2).
- `mergeBalances(existing, incoming) -> { balances, added, replaced, ignored, unchanged }` — precedence of section 2.
- `detectBalancesHeader(header) -> { account, date, balance, note? }|null` — header names: account /
  account id / account name; date / as of / statement date / balance date / closing date; balance /
  statement balance / ending balance / closing balance; note / memo. A header with a description or
  amount column is a transaction export, never a balances file.
- `parseBalancesCSV(text, accounts, { name?, dateFormat? }) -> { balances, skipped: [{ row, reason }], rows }`
  — account by id or label (any case; a label two accounts share must be given as an id); amounts
  like "1,234.56"; a second balance for the same account and day is skipped (the first is used).
  Throws `ValidationError` with code `NOT_BALANCES` when the first line is not a balances header.
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
  falls back to conservative with an assumption). The UI always passes a month: the **plan
  reference month** is the forecast start (the month after the latest complete month), so bills
  and incomes with start/end months, and real paydays, are judged for one stated month on
  Overview, Budget and in "what this change does".
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
               leftoverCents|null, keptCents?, shortfallCents,
               source: 'allocation'|'allocation_estimate'|'estimate'|'missing'|'none',
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
  their own contribution transfers` (the transfers are subtracted because they already pay joint
  outflows). With a `personalSpending` estimate for that person, `spendingCents` = the estimate
  (`source: 'allocation_estimate'`) and `keptCents = max(0, leftover) − min(estimate, max(0, leftover))`
  stays in their account, so it counts toward what remains in household scope (paying off a
  personal loan then frees money visibly). An estimate above the leftover is used as entered,
  with a warning that the difference comes from other personal money. Without an estimate,
  `spendingCents = max(0, leftover)` (`source: 'allocation'`) and household scope adds the
  assumption that all of it is spent. Either way the leftover is counted once, never also as
  money left over. A negative leftover becomes `shortfallCents` with a warning to check whether
  other personal money covers it (warnings show in both scopes). A personal bill with an unknown
  amount sits inside the leftover (noted on the entry).
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
- `summary(debt, bill, { month, people }?) -> { lines: [{ key, label, value, status }], warnings: string[], promo|null, lowerBound }`
  — `month` is the promotion check's starting month (without it the check needs info); `people`
  (plan people) names who pays a personally funded bill ("Alex's personal account"); a payment
  bill that is still `planned` has status `planned`; a
  month-count illustration is added only when the APR is confirmed and recorded, never a date;
  escrow is asked for housing debts.

### BudgetEngine.forecast
- `project(plan, scenario|null, { startMonth, months: 1..120, scope: 'joint'|'household' = 'joint', now? }) -> Projection`
```js
Projection = {
  scenarioId, scenarioName, scope, timing, startMonth, months, endMonth, startBalanceCents|null,
  rows: [{ month, incomeCents|null, incomeKnownCents, incomeLowerBoundCents|null,
           incomeLines: [{ id, label, personId, count, cents|null, perPaycheckCents, basis, assumption }],
           spendingCents|null, spendingKnownCents, billsCents, oneTimeCents, outCents|null, outKnownCents,
           eventLines: [{ id, label, type, direction, category, cents|null, signedCents|null, goalId, fromGoalCents }],
           netCents|null, netUnknownReason: null|'income'|'personal_spending',
           contributionsCents, goalDrawsCents, unassignedCents|null,
           cumulativeCents|null, balanceCents|null, returnCents|null,
           goals: { [goalId]: cents|null }, warnings: string[] }],
  summary: { totalIncomeCents|null, totalIncomeKnownCents, totalOutCents|null, totalOutKnownCents, totalContributionsCents, totalReturnCents,
             endCumulativeCents|null, endBalanceCents|null,
             lowest: { month, cumulativeCents|null, balanceCents|null },
             lowestBalance: { month, balanceCents }|null,   // lowest known projected balance
             negativeMonths: string[],
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
  null too, so an unknown never makes a scenario look better than the baseline. In household scope
  an unknown personal spending also makes `spendingCents` and `outCents` null (`*KnownCents` keep
  the known parts, and `summary.totalOutCents` is null when any month's outflow is unknown), so a
  scenario that blanks someone's pay cannot show lower spending than the baseline.
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
  projection then reports cumulative change only). A balance dated `asOf` applies from the month
  after that date (it already includes that month's activity); earlier projected months have a
  null balance, with an assumption saying so. In household scope the balance starts from
  joint cash only (assumption: money in personal accounts is not included). `compare` adds the
  rows `lowestBalance` and `lowestBalanceMonth`.
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

### BudgetEngine.flows
Joint accounts only. Every counted row gets one role: `card` (purchases and refunds on a card or
financing account), `bank` (spending paid from checking or another cash account, the mortgage
included), `repayment` (checking → card: settles purchases already counted, never spending),
`debt`, `business` (purchases marked as business costs), `savings`, `investment`, `interest`,
`credit` (money in, attributed to p1 / p2 or not assigned) and `internal` (between own accounts).
- `breakdown(txns, dataset, { months, coverageMap, plan })` → per month (full coverage only)
  `{ actual, planning, oneOffs, credits, spends }`. Base amounts: p1, p2 (and their provisional
  parts), unassigned, interest, card/bank purchases and refunds, card repayments, debt, business,
  savings in/out, investments in/out; derived: cardNet, bankNet, consumption, funding (p1 + p2),
  moneyIn, savingsNet, investNet, left. `actual` counts every row; `planning` leaves out rows the
  household left out of the planning baseline. Agrees with `balances.monthlyFlows` to the cent.
- `baseline(rows, { count })` → the last `count` complete months: totals (actual and planning) and
  averages built from averaged base amounts, so they add up the same way. Purchases are sorted
  into one-time (left out by the household, or found: $500 or more from a place that is not regular
  in those months, none similar 11–13 months apart; "include" on the row wins), yearly (a
  similar purchase 11–13 months apart: spread as 1/12 a month), regular (same place in at least
  60% of the months, `regularAt`) and everyday. A place charging twice in one month is still not
  regular, so both big charges are one-time. One-time purchases leave the plan only; history keeps them.
  Also returns `spends` (every card/bank purchase and refund in the months with its `kind` and
  `planCents`: what it adds to `total.planning`) and `regularAt`.
- `planFunding(plan, { month, timing })` → per partner: the streams active that month with gross
  (pay stub, reference only), take-home, kept personally and joint, per paycheck and per month
  (same count as the Budget: semimonthly 2, biweekly 2 typical or 26/12 average), ended streams
  (old pay) for comparison, and `jointCents` (the partner's joint contribution).
- `scenario({ base, funding, home, people })` → one effective amount per line (the household's
  setting, else the baseline) and `remainder` = funding + other planned income − card − bank −
  debt − business − savings − investments. Planned card and bank spending are never below $0;
  savings is signed (a drawdown raises the remainder).
`balances.history` uses an entered balance at exactly its date. The days between the end of the
account's export and that date (or between the date and the start of the export) are the account's
`gap`: no transactions are assumed in them, and the account's note says so. The date is never moved.
`balances.project(..., limits)` keeps real balances at $0 or more: savings tops up checking, a
drawdown stops when savings is empty, and the rest is reported as `uncovered`.
Ledger edits gain `person: 'p1'|'p2'|'none'` (whose money a deposit is; 'none' = neither), applied
by `applyEdits` as `personId` with `personBasis` 'edit' (a rule's person has basis 'rule').
Income streams gain `grossPerPaycheckCents` (optional, reference only).

### BudgetEngine.balances
Joint cash accounts only (checking, savings, other; cards and loans are not balances to spend).
- `cashAccounts(dataset) -> [{ id, label, type, group: 'checking'|'savings', coverage }]`
- `suppliedBalances(dataset) -> [{ accountId, date, cents, source: 'statement'|'bank', note }]` —
  `dataset.balances`, checked (unusable entries skipped; absent → []).
- `history(txns, dataset, { entered?, asOf?, enteredAsOf?, months? }) -> { months, accounts: [{ id, label, group, source: 'bank'|'entered'|'change', values, note, gap, anchor, first, last }], groups: { checking, savings: { label, kind: 'balance'|'change'|'none', values } }, total: { kind, values }, latest: { month, index, checking, savings, total }|null, complete }`
  - Known balances ("anchors", `anchorsFor(account, rows, entered, asOf, supplied?)`): the export's
    running balance at the end of each day with rows (`endOfDay` picks the balance that is not the
    start of another row that day; file order breaks ties), and the balances supplied with the data
    (`dataset.balances` for that account, `suppliedBalances(dataset)`; source 'statement' or 'bank';
    a supplied figure wins over the running balance on the same day), plus one `entered[accountId]`
    balance true at the end of its date (`enteredAsOf[accountId]`, else `asOf`) when there is no bank
    figure or the entered date is after the last one. A supplied 'statement' anchor counts as a bank
    figure for the account's `source` ('bank'); `anchor.source` keeps 'statement'. A month-end value is the nearest anchor at or before it
    plus the flows in between, or the next anchor minus the flows in between; it is null unless
    every day in between is covered by the account's exports or is in its `gap`
    (`{ side: 'after'|'before', from, to, days }`, `gapFor`), where no transactions are assumed.
  - `anchor`: the latest known balance `{ date, cents, source }`; `first` / `last`: the earliest and
    latest days with a known end-of-day balance `{ date, cents }` (null without an anchor);
    `assumed`: per month, true when that value was worked across days in the `gap`.
  - No anchor: the account's line is the change since its first covered day (`source: 'change'`),
    and a group or total that includes it is a change, not a balance (`kind: 'change'`).
  - Rows excluded as duplicate copies never move a balance; every other row does.
- `incomeAttribution(plan) -> (txn) => 'p1'|'p2'|null` — whose deposit a row is: the row's
  `personId` (from rules/transfer hints); else, for a contribution, the one person with a
  contribution stream, and for a payroll deposit, the one person whose paycheck reaches joint (a
  paycheck with no joint portion from someone who also sends transfers does not); with several
  candidates the per-paycheck/per-transfer amount must match one; otherwise null ("other").
- `monthlyFlows(txns, dataset, { months?, coverageMap?, planning?, attribute? }) -> [{ month, coverage, inCents, outCents, savedCents, leftCents, businessCents, bySource? }]`
  — joint scope, full months only (else null). in = income + contributions; out = spending (after
  refunds) + debt payments + purchases marked business (they still left the account); saved = net
  to savings. `planning: true` leaves out rows excluded from the planning baseline.
  With `attribute`, `bySource: { p1, p2, other }` splits `inCents` (the parts add up exactly).
- `usual(flows, { count = 12, endMonth? }) -> { inCents, outCents, savedCents, months, count, bySource? }` — averages of the last full months (`bySource.other` absorbs rounding so the parts add up to `inCents`).
- `comfortable(flows, { count = 12 }) -> { comfortableCents, typicalLeftCents, monthsAtLeast, count, lowestCents, highestCents, months }`
  — the leftover (in − out) reached in at least three of every four months (the value at index
  ⌊n/4⌋ of the sorted leftovers), rounded down to $50, never below $0.
- `project({ startMonth, months, start: { checking, savings }, inCents, outCents, savedCents }) -> { rows: [{ month, checking, savings, total }], firstShortMonth, monthlyLeftCents }`
  — each month checking += in − out − saved, savings += saved. No interest or growth. A null
  start is treated as 0 (the caller labels the line as change).

### BudgetEngine.timeline
The plan screen's model, built once per render. Pure; `today` is passed in.
- `build({ txns, dataset, plan, settings, today, coverageMap? })` — `txns` effective (no what-if),
  `plan` = `state.plan` (with `plan.changes`), `settings` = `state.ui.plan`, `today` 'YYYY-MM-DD'. Returns
  `{ today, todayMonth, planStart, lastComplete, firstMonth, lastMonth, horizon, months, window,
  people, dials, dialsByKey, groups, plan, changed, changedBy, changes, baseline, balances, series,
  migration, carriedOver, settings }`:
  - `carriedOver`: null, or the spending dials' `carriedOver` once for the headline area, plus
    `dials` (keys) and `summary`: "Three dials carry your earlier card spending setting of $4,200.00
    — review them, then Keep or Reset." ("Two dials carry …", "One dial carries … — review it, …").
  - `planStart` = the month after the last month every spending account covers in full.
    `months` run from the first month with data (earlier when a balance is known before it) to
    `planStart + horizon − 1`: `{ month, status: 'actual'|'partial'|'plan', current, complete,
    coverage, in: { [personId], unassigned, other, total }, out: { essentials, flexible, irregular,
    card, bank, debt, business, invest, other, total }, savings, net, combinedChange, oneOffs,
    oneOffCents, actualSoFar, changesApplied, baseline }`. `out.essentials + flexible + irregular =
    card + bank`; `out.other = debt + business + invest`; `out.total = card + bank + other`;
    `combinedChange = in.total − out.total` (moves to and from savings stay inside joint cash);
    `net = combinedChange − savings` (left in checking). Actual months come from `flows.breakdown`
    (incomplete ones: amounts null, `actualSoFar` = the covered part, same shape); their spending is
    split by group with the same rules as the dials (one-time costs: the baseline window's
    classification, else one over every month with data). From `planStart` on, amounts come from
    the dials plus the accepted planned changes, and a partly covered month is `partial`.
    `changesApplied: [{ id, label, group, cents }]` (plan months; [] otherwise). `baseline`: for plan
    months when `changed`, `{ in, out, savings, net, combinedChange }` at baseline dials with no
    planned changes (totals); otherwise null.
  - `dials`: one `in` dial per person in the plan (`inOther` when the baseline has unmatched
    deposits or interest), then the `out` dials in `groups.out` order: `essentials`, `flexible`,
    `irregular`, `savings` (signed) and `other` (debt, business, investments; only when nonzero).
    Card and bank spending are not dials: they are derived (see `plan.out.card`/`bank`).
    Every dial: `{ key, group, label, baselineCents, planCents, source: 'baseline'|'direct'|'rows',
    basis, hint, drill }`. Baseline = average of the `baselineMonths` complete months
    (`flows.baseline`, yearly bills spread). `planCents`: `settings.dials[key]`, else the drill rows
    (irregular: the costs still in) when any is changed, else the baseline; never clamped. Person dials
    also carry `budgetCents` (the person's monthly joint amount from `flows.planFunding` for
    `planStart`, annual-average timing: biweekly 26 a year, semimonthly 24; ended and not-yet-started
    streams out; null when no stream counts or any counted amount is unknown), `averageCents` (the
    deposit average of the window), `basisKind: 'budget'|'average'|'direct'`, `needsConfirm` (true
    for 'average') and `budget: { streams: [{ id, name, perPaycheckJointCents, perYear, cadenceLabel,
    monthlyCents, assumedCadence }], unknown: [names] }`; their `baselineCents` is `budgetCents` when
    known, else `averageCents`, and `basis` reads "From Budget: 2 × $… to joint (semimonthly)",
    "Average of … deposits, N months — not a confirmed setting" or "Set here". `hint` (in dials):
    observed deposits `{ count, lastCents, lastDate, typicalIntervalDays, cadence, cadenceLabel, days,
    perYear, perMonthCents }` (semimonthly 24 a year, biweekly 26, matched with `schedule.paydays`).
    Spending dials (essentials, flexible, irregular) also carry `cardShare` (0..1), `cardCents` /
    `bankCents` (the plan amount split by how it was paid; a direct amount splits by `cardShare`,
    or by `settings.cardSplit[key].card` while the dial holds exactly `settings.cardSplit[key].cents`)
    and `baselineCardCents` / `baselineBankCents`. Every dial has `carriedOver`: null, or — for a
    spending dial still holding exactly an amount carried over from the earlier card/bank dials
    (its `cardSplit` entry matches and has `fromCard`/`fromBank`) — `{ from: 'card'|'bank'|'both',
    cardTotalCents|null, bankTotalCents|null, note }`, note e.g. "Carried over from your earlier
    card spending setting of $4,200.00 (card parts of Essentials, Flexible and Irregular add up to
    it)." (both: "…card spending setting of $X and bank spending setting of $Y (card and bank parts
    of … add up to them)."). The parenthesis is there only while it is true: all three spending
    dials still hold their carried-over amounts and the parts sum to what was set; otherwise the
    note ends after the amount.
  - Grouping: a category is `essentials` when `categories.isEssential` says so, else `flexible`;
    `settings.groups[category]` overrides it, and `settings.groups['merchant:' + place]` moves every
    purchase of that place (all its categories) into a synthetic category row named after the place
    in the chosen group. One-time costs are never in these groups: they are the `irregular` dial.
  - `drill` (essentials, flexible): `{ kind: 'categories', group, rows, categoryCount, baselineCents,
    rowsCents, baselineCardCents, rowsCardCents, cardShare, overridden, stableCount, yearlyCount,
    orphanIds, tinyCategoryCents }`; rows are categories (level 1, tiny ones grouped as "Other") and
    regular places plus "Everything else" (level 2) with stable ids `<group>-c|m|r-<hash>` (the hash
    of the same parts as the earlier card/bank ids). Every row has `avgCents` (the average; card and
    bank averages added), `defaultCents` (its plan amount with no change), `planCents`, `override`,
    `included`, `group`, `synthetic` (a place moved as a whole), `paidBy: 'card'|'bank'|'mixed'`,
    `cardShare` (0..1, by amount), `cardCents` / `bankCents` (its plan amount split; at the default
    exactly the card and bank averages), `pattern: 'bill'|'everyday'|'occasional'` (bill = regular
    and stable; everyday = seen in at least `baseline.regularAt` of the window months (60%, at least
    2) and not stable; occasional = the rest; a category is 'bill' when all its rows are) and
    `legacyId` (the earlier card/bank row whose change it is using, else null). Level-1 rows also
    `members`, `merchant` (synthetic rows), `movedFrom` (synthetic rows: the place's categories),
    `groupKey` (what `setGroup` takes: the category, 'merchant:' + place, or null for the grouped
    "Other"), `groupSource: 'taxonomy'|'override'|null`, `seenMonths`, `ofMonths`; level-2 rows also
    `latestCents`, `latestDate` (null on "Everything else" rows), `seenMonths`, `ofMonths`, `stable`. A
    stable regular place (3+ charges, about once a month, all within 10% of their median) defaults to
    its latest charge; others to their average. Categories add up their rows, and the dial baseline
    is Σ category `defaultCents` (the basis then ends "; regular bills at their latest amount").
  - `drill` (irregular): `{ kind: 'items', rows: [{ id (txn id), label (place), date, month, cents,
    monthlyCents, included, auto, paidBy, category, description, accountLabel }], count,
    includedCount, leftOutCount, totalCents, includedCents, baselineCents, rowsCents,
    baselineCardCents, rowsCardCents, cardShare, overridden, orphanIds, examples }` — every one-time
    cost of the window (found automatically, `auto`, or marked with the `planningBaseline: 'exclude'`
    edit). Baseline = Σ costs ÷ window months; items are in the allowance unless
    `settings.irregularOff[id]`; the `planningBaseline: 'include'` edit ("count as regular") moves an
    item into its category instead (it is then in `baseline.keptIn`, not here). Nothing is left out
    of the plan automatically. Basis: "One-time costs over Oct 2025–Sep 2026 spread per month
    (14 items, $X) — dental work, trips, repairs, tax" (+ "; N left out by you").
  - `plan`: one plan month from the dials (no planned changes): `{ in, out, savings, net,
    combinedChange, toSavings, fromSavings }` (`toSavings` = max(0, savings), `fromSavings` =
    max(0, −savings)); `out.card` / `out.bank` derived from the spending dials.
  - `changed`: any dial not at its baseline, or any planned change applied; `changedBy: { dials,
    changes }`.
  - `changes`: `{ list, applied, unset, totalOneTimeCents, monthlyNowCents }` — `list`: each valid
    `plan.changes` entry with `status: 'unset'|'notAccepted'|'applied'|'outside'`, `monthsApplied`,
    `appliedCents`; `applied`: how many applied; `unset`: ids with no amount (never applied as $0).
    Accepted changes with an amount add to plan months from `startMonth` (one-time: that month only;
    monthly: through `endMonth` when set): income to `in[personId]` (`in.other` without a person),
    spending groups to that group, `out.bank` and `out.total`, savings to `savings`. Totals count
    money out of checking as positive (spending and savings +, income −): `totalOneTimeCents` over
    the applied one-time changes, `monthlyNowCents` over the monthly ones in the first plan month.
  - `baseline`: `{ setting, count, months, start, end, label, oneTime, oneTimeCents, keptIn, yearly,
    regularAt, plan }` — one-time items with `{ id, date, month, merchant, description, accountLabel,
    role, dialKey ('irregular' for card and bank purchases), cents, auto }`; toggled with the
    `planningBaseline` ledger edit. `plan`: when `changed`, one plan month at baseline dials (same
    shape as `plan`), else null.
  - `series`: the Trends chart's lines, `[{ key, name, group: 'in'|'out'|'savings'|'net', values }]`
    aligned with `months` (actual months from what happened, null when incomplete; partial and plan
    months from the plan). Keys, in order: `in-<personId>` per person, `in-other`, `in-total`,
    `card`, `bank`, `essentials`, `flexible`, `irregular`, `other-out`, `out-total`, `to-savings`,
    `from-savings`, `net`, `combined-change` (`SERIES` lists the fixed ones).
  - `migration`: null, or `{ rows: [{ from, to }], dropped, superseded, rowsNote, dials, note }`
    when `settings.rows` still holds changes saved under the earlier card/bank dials, or
    `settings.legacyDials` holds amounts set for them. A row change applies to the same row
    (`<group>` instead of `card`/`bank` in its id) when that row is paid only that way and is not the
    grouped "Other"; `migrateRows` makes that permanent. `rowsNote`: the row note
    ('ui.plan.rows: …', recorded by `migrateRows`) or null. `note`: what to show once — the row note
    without its path, then `dials.note`.
    `dials`: null, or `{ from: { card?, bank? }, to: { essentials, flexible, irregular },
    parts: { [dial]: { card, bank }|null }, skipped: string[], note }` — how `migrateDials` carries
    the amounts over. A card amount X is shared over the three dials' `baselineCardCents` (sum C):
    card part = round(baselineCard × X / C), the rounding remainder on the largest baseline card
    part, so the parts add up to X exactly; C = 0 puts all of X on Flexible (the others' card parts
    $0). A bank amount likewise on `baselineBankCents`; both compose, and each replaces the rows on
    its own side (as the earlier dial did). A side not set keeps what the rows give it now, row
    changes included (`drill.rowsCardCents`; bank: `drill.rowsCents − drill.rowsCardCents`), so a
    card-only amount never drops a bank-side row change (and vice versa). `to[dial]` = card part +
    bank part, or null for a dial already set directly (`skipped`).
    With no baseline yet, all of it goes to Flexible (`parts` null for the others). Note, e.g.:
    "Your earlier card spending setting of $4,200.00 was carried over by scaling the card part of
    Essentials, Flexible and Irregular (they now add up to it); adjust them individually from here."
    Variants: "…card spending setting of $X and bank spending setting of $Y were carried over by
    scaling the card and bank parts of … (they now add up to them); …"; C = 0: "…was carried over
    by putting the card amount on Flexible (there was no card spending in the baseline to scale);
    adjust them individually from here."; a skipped dial drops "(they now add …)" and adds "Flexible
    was already set by you and was left as it is."; all skipped: "…was not carried over: Essentials,
    Flexible and Irregular were already set by you."; no baseline: "…was carried over to Flexible
    (there is no baseline yet to scale it by); adjust it from here."
  - `balances`: `{ mode: 'accounts'|'simple'|'none', simple, label, rule, accounts, missing,
    combined, policy, runsOut, lowest, notes, assumed, illustrative }`. Points are `{ month, cents,
    status: 'reconstructed'|'assumed'|'projected'|null, anchor, gap, note, illustrative }`: a
    month-end worked across days the account's export does not cover (its `gap`) is `assumed`
    with `note` "Assumes nothing moved between … (not in your data)."; only values connected to a
    known balance through covered days are `reconstructed`. A combined point is `assumed` when any
    member is. `assumed`: null or `{ from, to, days, accounts, gaps: [{ side, from, to, days,
    accounts }] }` (gaps shared by several accounts are merged; `days` counts the union).
    `illustrative`: a sentence when account lines have projected points (checking's projected
    points carry `illustrative: true`: card spending is taken when it happens), else null. Per anchored account: points per month
    (`reconstructed` from the transactions, then `projected`: checking + net, savings + savings;
    the month of the last known day adds net × days left ÷ days in month), `source`, and `anchor:
    { date, cents, source: 'entered'|'bank'|'statement', label }` (label: "Entered by you, Sep 30,
    2026", "From your bank data, Sep 30, 2026" or "From your statement, Sep 30, 2026"). `combined`
    sums the anchored accounts only (`missing` ones are never counted as $0), and has
    `baselinePoints`: when `changed`, the combined line from the same anchors at baseline dials with
    no planned changes (same length as `points`; null where the point is not projected), else null.
    A savings account with a known balance (entered or supplied) but no export of its own is worked
    back and forward from the savings transfers in the one covered export holding them
    (`mirroredFrom`), when it is the only savings account; otherwise a note says why it is not.
    Simple mode projects the one joint cash figure (labelled illustrative). Nothing is floored;
    `coverFromSavings` moves projected checking shortfalls from savings (`policy.moves`), per
    account only.
- `anchors(plan, dataset, txns?) -> { simple, accounts: [{ id, name, type, group, cents, asOf, source, dateAssumed, gap, anchor: { date, cents, source, label } }], combined: { cents, asOf, members, sameDate }|null, missing, enteredAsOf }`
  — the starting balances; Forecast reads its starting cash from `combined`. Per account the newest
  known balance wins: the export's running balance, a balance supplied with the data
  (`dataset.balances`, source 'statement'|'bank'; absent is fine) or the entered one, which is used
  only when no bank figure is dated the same day or later.
- `toCSV(tl, { people?, format? }) -> string` — RFC 4180, CRLF, deterministic. Block "Settings"
  (`key,value` rows: today, baseline window/setting/months used/from/to, plan start, last month,
  horizon, cover from savings, `dial.<key>.label|baseline|plan|source|card|bank`, `group.<key>`,
  `row.<id>.label|included|amount`, `one_time.<txnId>.label|date|amount|state` ('in the irregular
  allowance' | 'left out by you' | 'counted as regular spending'), `balance.<accountId>.name|date|
  amount|source` (simple mode: `balance.joint_cash.*`), `change.<id>.label|kind|group|person|start|
  end|amount|accepted|status`), a blank line, then block "Months": `month,status,in_<personId>…,
  in_other,in_total,essentials,flexible,irregular,other_out,out_total,to_savings,from_savings,
  combined_change,net_checking,combined_balance,combined_status,<accountId>_balance,
  <accountId>_status…`. Dollars as plain decimals ("-1234.50"; `format: 'cents'` for whole cents),
  unknown as empty, statuses as words; free text starting with = + - @ gets a leading '.
- `templates.list() -> [{ key: 'baby', label: 'Baby', needs: ['dueDate'] }]`,
  `templates.baby(dueDate 'YYYY-MM-DD') -> item[]` — generic US estimates timed from the due month
  D (car seat, nursery D−2; starter clothes, feeding gear, monitor D−1; delivery out-of-pocket D+1;
  crib D+4; diapers, formula, clothes, copays monthly from D; baby food from D+6; childcare from
  D+3; parental leave income change D..D+2 with no amount), all `accepted: false`,
  `template: 'baby'`, each note saying it is an estimate to adjust.
- State writes (return a new State, validated through `state.setPath` / `addItem` / `updateItem`):
  `setDial(state, key, cents|null)`, `setRow(state, rowId, { included?, cents? })`,
  `resetDial(state, key, tl?)` (irregular: also clears `irregularOff`; with `tl`, also the earlier card/bank row changes its rows use), `resetPlan(state)` (dials, rows
  and `irregularOff`; groups and planned changes stay), `setGroup(state, key, 'essentials'|
  'flexible'|null, tl?)` (key = category or 'merchant:' + place; with the current `tl` a category's
  row changes follow it to the other group), `setIrregular(state, txnId, included)`,
  `addChange(state, item | item[])`, `setChange(state, id, patch)` (switching to one-time clears
  `endMonth`, away from income clears `personId`, unless the patch sets them),
  `removeChange(state, id)`, `acceptChanges(state, id | ids, accepted = true)`,
  `migrateRows(state, tl)` (moves the earlier card/bank row changes `tl.migration` matched, removes
  the rest, and appends `tl.migration.rowsNote` to `meta.migrationNotes`; returns the same state
  when there is nothing to do), `migrateDials(state, tl)` (sets each `tl.migration.dials.to` amount
  directly with its card part in `ui.plan.cardSplit`, leaving a dial set directly in the meantime
  alone; removes `ui.plan.legacyDials` and any `ui.plan.dials.card`/`bank`; appends
  `tl.migration.dials.note` to `meta.migrationNotes`; returns the same state when nothing is
  waiting). The plan screen runs `migrateDials(migrateRows(state, tl), tl)` once, as one change,
  and shows `tl.migration.note`. `setDial` removes the dial's `cardSplit` entry; `resetPlan` clears
  `cardSplit`. `acceptCarriedOver(state, key | keys)` ("Keep") removes only the
  `fromCard`/`fromBank` marker: the amount and its card part stay, so card and bank totals do not
  move; nothing marked → the same state.
- `settings(raw)` (adds `groups`, `irregularOff`, `legacyDials` (`{ card?, bank? }`, amounts only;
  a `dials.card`/`bank` still in `raw` moves here and wins), `cardSplit` (valid entries only),
  `trends: { series, ma, trend }`; `mode` may be 'trends'), `prorate(cents, daysLeft, daysInMonth)`,
  `depositHint(credits, personId)`; constants `SPEND_GROUPS`, `SPEND_DIALS`, `LEGACY_DIALS`,
  `OUT_DIALS`, `MERCHANT_KEY`, `CHANGE_KINDS`, `CHANGE_GROUPS`, `SERIES`, `TREND_MA`,
  `TREND_DEFAULTS`, `DIAL_LABEL`.

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
  - A saved `ui.home` (the earlier Home settings) is moved to `ui.plan` (section 7) and dropped,
    with one note that is also appended to `meta.migrationNotes`.
  - A saved `ui.plan.dials.card` / `bank` (dials before spending was grouped as essentials,
    flexible and irregular) moves to `ui.plan.legacyDials` with one note, also appended to
    `meta.migrationNotes`: "ui.plan.dials: card spending $880.00 and bank spending −$15.00 set on
    the plan screen will be carried over to essentials, flexible and irregular spending the next
    time Plan opens (card and bank spending are now worked out from those)." A blank (null) one is
    removed; one that is not an amount is dropped and named. `legacyDials` keeps only amounts and is
    removed when none is left; it survives a workbook export/import until the plan screen applies
    it. A missing `plan.changes` becomes `[]` without a note.
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
  `renameScenario` (names must be unique, ignoring case and surrounding spaces, so side-by-side
  columns can be told apart; a clash throws `ValidationError` on field `name`), `deleteScenario` (alias `removeScenario`; the baseline cannot be deleted),
  `addEvent(state, scenarioId, event)` (not on the baseline), `updateEvent(state, scenarioId, eventId, patch)`
  (`undefined` in the patch removes an optional field), `removeEvent`, `validateEvent(event)`.
- Plan list items: `addItem(state, 'incomes'|'bills'|'savings'|'debts'|'changes', item, { now }?)`,
  `updateItem(state, list, id, patch, { now }?)` (several fields at once, merged and validated
  strictly like a new item; `undefined` resets a field to its default; the id is kept),
  `removeItem(state, list, id, { now }?)` — removing a bill/debt clears the link on the other side;
  removing a goal sets `goalId: null` on scenario events.
- Constants for the plan screen: `DIAL_KEYS`, `RETIRED_DIALS` (['card', 'bank']), `SPEND_GROUPS`, `SPEND_DIALS`,
  `CHANGE_KINDS`, `CHANGE_GROUPS`, `TREND_SERIES`.
- `setPath(state, path, value) -> State` (validated writes from forms, path-copying, input never
  modified), `getPath(state, path)` (returns a copy, or undefined for a missing item):
  - Lists use selectors: `plan.incomes[id=p1-pay].netPerPaycheckCents`,
    `plan.personalSpending[personId=p2].monthlyCents` (a personalSpending entry for p1/p2 is created
    on first write), `scenarios[id=…].events[id=…].monthlyCents`; a numeric index also works.
  - Map entries (`plan.targets`, `checklist`, `ui.dismissed`, `ui.plan.dials|rows|groups|irregularOff`) take the rest of the path as the key
    (`plan.targets.Gas & heating`) or a quoted key (`plan.targets["A.B"]`).
  - Writing `undefined` **removes** a map entry, an optional field (`ui.plan.legacyDials`) or an
    optional `income_change` field.
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
| `#/overview` | Plan (`views/overview.js`, one `timeline.build` per render): the cash chart first (Balance: combined cash and, switched off until chosen, each account, plus a faint baseline-plan line once a dial has moved and markers for planned changes; Flows: money in by person, other and from savings, out as essentials, flexible, irregular, savings and debt/business/investing, with a net line; Trends: any monthly series as lines with an optional trailing average and a straight-line trend; Past 6/12/all and Ahead 6/12/24/60 months; Export CSV); the balances it starts from (taken from the data — statement or bank running balance — with their source shown; an entered balance is an override); the dials (money in by person from the pay saved in Budget, money out as Essentials, Flexible spending, Irregular costs, Net to savings and Other; slider in $25 steps plus an exact box; essentials and flexible open into categories and places with pattern badges that can be unticked, given an amount or moved between the two groups; irregular lists the one-time items in the allowance); the headline (all accounts per month, then checking); the Planned changes drawer (dated one-time and monthly changes, the Baby template); More options (baseline window, cover from savings). Every change goes through `app.update` and can be undone; view settings and legend toggles are saved without a re-render |
| `#/spending?period=2026-09&cat=Groceries&merchant=…&txn=…&q=…&window=3` | month → category → merchant → transaction drilldown with breadcrumbs |
| `#/budget?section=income|bills|targets|savings|debts` | edit plan inputs; planned vs actual; consequences |
| `#/forecast?scenario=…&compare=a,b&horizon=36` | scenarios, events, projections, side-by-side |
| `#/review?queue=uncertain|duplicates|transfers|reimbursements|business|spikes|coverage|edited|reconcile` | data review & corrections |
| `#/data` | load files, export/import workbook, storage & privacy explanation, reset. `?load=csv`: bank exports and balances files, added to the data in use (default for a household's own data; `importer.mergeDataset`, summary "N new, M already present, coverage now to …" with Add / Cancel and Replace instead… behind a confirmation) or replacing it (default for the fictional sample; import report, then Use this data). The hub lists posted balances and offers the data in use as a data file (JSON) that "Choose a data file" reads back |

`period` is `YYYY-MM` or a range `YYYY-MM..YYYY-MM`. Browser Back/Forward move through drilldown levels.

UI rules that cut across views:

- **What-if switches are a Spending-view lens.** `ui.whatIf` is saved, but the UI builds two
  effective ledgers: the real one (no what-if) for Plan, Budget, Forecast, Review and Data, and
  the what-if one only for Spending, which shows a notice while a switch is on. Actual totals
  elsewhere never change because of an unconfirmed reimbursement or business flag.
- **Plan reference month:** every plan summary shown in the UI uses `month = forecastStart`, and
  the subtitle names the pay-timing basis (actual paydays, typical month or average).
- **Parental-leave template (Forecast):** chosen per person; it adds an `income_change` event for
  every paycheck and contribution stream of that person over the leave months, using the amounts
  entered; a blank amount stays unknown (listed as missing), so leave never looks free.
- Saved scenarios, edits and plan values go through `state` validation; typed month and date
  inputs commit on Enter or leaving the field, not on every keystroke.

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
