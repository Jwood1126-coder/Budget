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
import report's and plan report's private markers (the patterns are in `tools/check-privacy.cjs`). `tools/import.cjs`, `tools/build.cjs` and `tools/plan-report.cjs` refuse private outputs inside the
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
  `node --test "tests/unit/*.test.cjs"`). Browser tests use Playwright when available
  (`npm run test:browser`, see "Tests" below). `npm run lint` runs ESLint with two rules
  (`no-undef`, `no-unused-vars`) through `npx`; nothing is added to `package.json`.

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
    balances.js          balances over time, whose money a deposit is (BudgetEngine.balances)
    flows.js             spending by role and how it was paid, money into joint by person, savings in/out, the baseline the Plan screen's dials start from (BudgetEngine.flows)
    plan-settings.js     the plan screen's vocabulary, shared by timeline and state (BudgetEngine.planSettings)
    timeline-*.js        BudgetEngine.timeline by section, loaded before timeline.js (BudgetEngine._timeline,
                         private to them): core (helpers, constants, settings; loaded first), balances,
                         spending (groups, drill-down, irregular items), dials (deposit hints, carry-over),
                         changes (planned changes, templates), export (toCSV), writes (state writes, upgrades)
    timeline.js          the plan screen: build, the Trends series, the public API (BudgetEngine.timeline)
    state.js             saved-state schema, migration, storage  (BudgetEngine.state)
    setup-sync.js        the profile's later changes reach a saved budget (BudgetEngine.setupSync)
    baby-defaults.js     the baby-cost defaults: setup, supplies, childcare, timed from the due date (BudgetEngine.babyDefaults)
    attention.js         "needs attention" list (Review)         (BudgetEngine.attention)
  ui/
    core.js              escaping, formatting, DOM helpers       (BudgetUI.dom/.fmt): fmt.amount (cents
                         only when non-zero), dom.centsToInputText (an exact-entry box: 2,222.02)
    components.js        breadcrumbs, tables, form fields, line and column charts (BudgetUI.c)
    chart.js             the Overview's cash chart: drawing, hover, keyboard, legend, month selection (BudgetUI.chart)
    router.js            hash routing                            (BudgetUI.router)
    shared.js            transaction labels, table, category and correction forms several views share (BudgetUI.shared)
    views/*.js           one file per view                       (BudgetUI.views.<name>)
    views/plan/*.js      the plan parts the Overview (views/overview.js) and Edit plan (views/budget.js)
                         share, loaded before both: common (the model, formatting, groups and short
                         labels), tiles (the plan month's income, outgoing, margin), chart (the two
                         panels), balances, month (a month's breakdown), dials (Edit plan's dials and
                         drill-downs), changes (Edit plan's list; the Overview's Coming up), actions
                         (the plan:* table and wire(), the behaviour both screens share)
                         (BudgetUI._plan, private to those two views). A developer build (`--view x`)
                         stubs only files directly in views/, so these are always bundled whole
    views/budget/*.js    Edit plan's own parts (views/budget.js), loaded before it: common (the same
                         ctx.memo('timeline') build, formatting, form fields, the pure helpers
                         tests/unit/budget-view.test.cjs covers), goals (savings goal cards), setup
                         (pay, bills, debts and the goals list, and their budget:* actions)
                         (BudgetUI._budget, private to Edit plan)
    app.js               bootstrap, state store, event wiring    (BudgetUI.app) — loaded last
  styles/*.css           base tokens/components + one file per view
  layout.html            document shell with placeholders
tools/
  build.cjs              assemble dist/index.html (sample or private)
  import.cjs             CLI importer: private/raw/*.csv -> private/budget-data.json + report
  build-sample.cjs       regenerate fixtures/sample-data.json from fixtures/sample-raw/*.csv
  check-privacy.cjs      scan tracked/staged files for private patterns before committing
  plan-report.cjs        the plan as the household's assistant reads it: private/plan-report.md + .json
                         (docs/SETUP.md; --sample prints the sample's)
fixtures/                synthetic sample (committed): raw CSVs, rules, profile, normalized data
private/                 (ignored) real exports, rules, household profile, builds
tests/unit/*.test.cjs    node:test suites for the engine and tools
tests/helpers/ledger.cjs shared synthetic fixture builders for the unit tests
tests/browser/*.spec.cjs Playwright end-to-end checks against the sample build in dist/test/index.html
tests/browser/run.cjs    the browser test runner; helpers.cjs: helpers the specs share
eslint.config.js         `npm run lint`: no-undef and no-unused-vars only (ESLint 9 through npx)
docs/SETUP.md            the setup file (household profile) for the household's assistant, and the tune loop
```

`tools/plan-report.cjs` (`npm run report`, `npm run report:sample`): loads the engine in Node, the
dataset and profile (`private/` by default; `--sample` the fixtures; `--data`/`--profile` other
files), optionally a workbook the household exported (`--workbook`, through
`setupSync.importWorkbook`, so their in-browser edits count; without one the budget is
`state.defaults` + `setupSync.apply`; then `babyDefaults.ensure`, as the page does), builds `timeline.build` (horizon at least 12 months, more
for `--months N`) and one `build({ compare })` per what-if, and writes `private/plan-report.md` and
`.json` (`buildReport` → JSON, `toMarkdown`): headline, this month's plan (`tl.summary`), To
check, dials, month by month (money; balances with status), planned changes (derived ones too, with
status), baby costs (`babyDefaults.status` with `tl.changes.overlaps`), what-ifs with their compare result, goals, investments, bills, setup-sync notes. A private
report carries a private-report comment (Markdown) and a true `privateReport` field (JSON), both
flagged by the privacy check (`tools/check-privacy.cjs` holds the patterns), and is refused anywhere in the
repository but `private/` (`checkReportOut`, symlinks resolved); `--sample` prints to stdout unless `--out` is given.

`tools/import.cjs` refuses to write inside `fixtures/` unless `--sample` is given, and `--sample`
refuses unless the config is `"isSynthetic": true` **and** every input file lives inside
`fixtures/`. `--period` takes a range `A..B`.

### Tests

- **Unit** (`npm test`): node:test suites in `tests/unit`, invented data only. Shared builders are
  in `tests/helpers/ledger.cjs`: `rowMaker({ prefix, pad?, description? })` returns
  `row(accountId, date, amountCents, fields)` (a grocery purchase unless `fields` say otherwise; ids
  unique per factory), `pair(out, inn)` links a transfer's two rows, `rawDataset` / `dataset({
  datasetId, accounts, transactions, ...extra })` (schema 2, `isSynthetic: true`; `dataset`
  normalizes), `jointAccounts({ coverage, chk?, sav?, card?, cardExtra? })`, `plan(extra)`,
  `paycheck(fields)`, `contribution(fields)`, `deepFreeze(o)`, and `monthlyFlows(txns, dataset,
  opts)`: joint money in, out and saved per full month from `ledger.summarize`, the independent
  figures `flows.breakdown` must agree with to the cent. Test files keep thin local wrappers (their
  id prefix, accounts and defaults).
- **Browser** (`npm run test:browser`): builds the sample to `dist/test/index.html` (never
  `dist/index.html`, which may be a private build; `node tools/build.cjs --sample` alone still
  writes `dist/index.html`) and runs `tests/browser/run.cjs`, which runs every `*.spec.cjs` in
  Chromium at 1366px and/or 390px. `BUDGET_DIST` points it at another sample build and
  `BUDGET_RESULTS` moves the screenshots; an argument runs one spec file (or the tests whose name
  contains it). Each test gets `t`: `t.open(hash, { clear = true })` loads the page from empty
  storage (a new page's first load in a new context already does, so it loads once);
  `t.nav(view)`; and `t.settled(page?)`, which resolves once no render is scheduled
  (`BudgetUI.app.renderPending`, kept by the render scheduler) and `<html data-render-seq>` (one more
  per render) has not changed for two animation frames — the generic wait after an action when there
  is no specific marker to wait for; specs never sleep. `tests/browser/helpers.cjs` holds what the
  specs share: `noHorizontalScroll(page)`, `state(page)` and the money formats the page uses
  (`whole`, `amt`, `signedAmt`, `boxText`, `money`) with their parsers (`centsOf`, `cents`).
- **Lint** (`npm run lint`) and the **privacy scan** (`npm run check:privacy`) run over the same
  tree; both must pass before committing.

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
  type: 'checking'|'savings'|'credit_card'|'loan'|'investment'|'other',   // missing -> 'other' (warning).
                                //   investment: never joint cash (not in balances.cashAccounts, not a
                                //   spending account); may be balance-only (no files, statement balances)
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
  per account and date). An account listed in `accounts` with no files is balance-only: its
  statement balances are all the data knows of it (the way to add an investment account, type
  `investment`, whose transactions are not exported). Plus `importer.bankBalances`: for each checking/savings/other account
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
| `transfer` `savings`/`investment` | **Saved.** On a non-savings account (the cash side) `savedCents = -amountCents`. On an account typed `savings` or `investment` it counts only when `pairId` is null **or** its pair is not in the dataset (`pairMissing`), so a paired move counts once and a dangling pair is not lost. | see left |
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
| transfer | `investment` account (either side) | both sides labelled `investment` (not when either side is `contribution`) |
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

Supplies the starting plan, and is the household's **setup file**: their assistant keeps tuning it
and rebuilds the page. The repository has `fixtures/sample-profile.json` (invented). A real
household keeps `private/household-profile.json`. A new budget starts from it (`state.defaults`);
its later changes reach a budget that was already saved through **setup sync** (below), so a value
changed in the profile arrives unless the household changed that value in the app.

```js
Profile = {
  schemaVersion: 1,
  isSynthetic: boolean,
  household: { name: string, people: [{ id: 'p1', name: string }, { id: 'p2', name: string }] },
  plan: Plan,                         // section 5
  planUi: { ... },                    // optional: plan-screen settings (fields of ui.plan, §7) the setup
                                      // file manages: dials, rows, groups, irregularOff, baselineMonths,
                                      // coverFromSavings, investReturnPct (when this version has it).
                                      // Checked with the ui.plan rules (state.cleanPlanUi); not applied by
                                      // `defaults`, only by setup sync
  scenarios: Scenario[],              // optional starting scenarios (templates with blanks)
  references: Reference[],            // optional; NOT copied into State.references (user-entered only)
  rulesNote: string,                  // optional
  notes: string[]                     // optional: explains each deliberate unknown (targets have no note field)
}
```

People names come from `plan.people`, then `household.people`, then "Partner A"/"Partner B".
The sample keeps Sam's paycheck with `jointPerPaycheckCents: null` plus a separate contribution
stream; that is the shape the joint-scope rule in section 8 (`plan`) expects.

**Setup sync** (`BudgetEngine.setupSync`, `engine/setup-sync.js`). The page runs it on every load
(after `state.loadFromStorage`, including a new budget and another tab's save) and on workbook
import (after `state.importWorkbook`), so always after the saved budget was checked and upgraded
(`sanitize`, `V5_UPGRADES`). It is a three-way merge of the saved value (S), the profile's value
applied last time (B, `meta.setup.base`) and the profile now (P), and it only runs when the hash of
the profile's setup-managed values differs from `meta.setup.hash` (so an unchanged profile costs
nothing and says nothing).

- Setup-managed (the table `MANAGED` at the top of `setup-sync.js`, `setupSync.MANAGED`):
  `plan.incomes`, `plan.bills`, `plan.debts`, `plan.savings`, `plan.changes`, `plan.people` (lists,
  by id, field by field; people: the name), `plan.targets` (by key), `plan.settings` and
  `plan.balances` (field by field; its `accounts` and `accountDates` are rows of their own, by
  account, so a file with one account's balance changes that account only), and from `profile.planUi` the `ui.plan` fields `dials`, `rows`,
  `groups`, `irregularOff` (by key), `baselineMonths`, `coverFromSavings`, `investReturnPct`
  (whole). A `ui.plan` row is used only when this version's `ui.plan` has the field. Not managed:
  `personalSpending`, scenarios, references, ledger corrections and every other setting.
- Per unit (an item's field, a map entry, a field, a value): **S = B → P** (the household left it
  alone); **S ≠ B → S** (changed here, kept). An item or entry new in P is added (lists: at the
  end, checked like a new budget's, never `accepted`); one the household added (not in B) or
  removed (in B, not in S) stays as it is.
- **Never erases.** A part of the plan the profile leaves out entirely is not merged at all (S
  stays, B keeps what it had; on a first run B stays empty there). Elsewhere, where the profile is
  silent (an item, entry or field it does not have) or says `null` where B has a value, P takes
  B's value (`keepKnown`), so the merge leaves S alone and a later profile that has it again still
  flows. Items and entries the profile dropped that S still holds are named in a note
  (`report.gone`); only the household removes them. Deep equality over JSON values, so fields added
  to the format later need no change: B is read through the same checks first, so a field B does
  not have yet counts as its default.
- **First run** (no `meta.setup`, or an unreadable base): B := P for the plan, so nothing saved
  changes and every value that differs from the profile counts as the household's. `ui.plan` never
  came from the profile (`defaults` does not apply `planUi`), so its B is the `ui.plan` defaults:
  a setting still at its default takes `planUi`'s value; one the household changed is kept.
- **Strict:** a profile value the normal checks would change (`state.defaults`' cleaning for the
  plan, `state.cleanPlanUi` for `planUi`) is not used: S stays and B keeps its earlier value there,
  so a corrected file flows later. A list item without an id of its own is not followed (one B
  holds is then not removed). The merged result goes through the same checks; a list item that does
  not pass (fields depend on each other: start and end month) goes back to exactly what was saved,
  an entry or value that does not pass stays as saved; all named in a note.
- **Reset on the Plan screen** (`timeline.resetDial`, `resetRow`, `resetPlan`) puts a `ui.plan`
  dial, row change or one-time cost left out back to B's value when the setup file supplied it
  (`setupSync.baseValue`), never removing it: removing a key B has would read as "removed by the
  household" (S ≠ B) and keep the setup file's later values out. Keys B does not have are removed
  as before (back to the baseline or history). Only an explicit choice moves a setup value off:
  typing an amount, clearing the box (`setDial(key, null)`) or "Use the N-month average" on a
  person's dial (offered at the setup value too); those are the household's and are kept.
- Deterministic and idempotent: running it again changes nothing (same hash: the same state back;
  even with the hash forgotten, the merge finds nothing to change). Fields kept as saved from a newer
  copy (forward compatibility, §7) are never compared or dropped.
- Notes, shown once with the other notes from opening the page (Data & privacy, and a toast):
  "Your setup file updated 5 settings (Dining & takeout target, …); kept 2 you changed here (…).",
  "Your setup file changed 1 setting you changed here; kept yours (…).", on a first run with
  differences "Your setup file is now linked to this budget; 3 settings here differ from it and were
  kept (…).", and "Your setup file has 1 value this version could not use (…); kept what was here."
  Not recorded in `meta.migrationNotes`.

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
  person?: 'p1'|'p2'|'none',                       // whose money a deposit is; 'none' = neither partner
  note?: string,                                   // replaces the imported note on the effective row
  history: [{ at: ISO-8601|null, field: string, from: any, to: any, reason: string }]
}
```

Edits are created with `review.editRecord`. Up to 50,000 corrections are kept, each with its
latest 200 history entries and up to 50 split parts. Corrections whose transaction is no longer
in the data are kept and listed (`review.queues().orphanEdits`).

`person` is applied by `ledger.applyEdits` as the effective row's `personId` (null for 'none') with
`personBasis: 'edit'`; it wins over a person named by an import rule or transfer hint (`personId`
on the imported row, `personBasis: 'rule'`; the imported value stays in `basePersonId`).

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
  settings: { incomeTiming: 'conservative'|'average'|'actual', planningBaseline: 'actual'|'adjusted', comparisonWindow: 3|6|12,
              babyDueDate?: 'YYYY-MM-DD'|null },  // optional (absent in budgets saved before it; absent/null = not known): the
                                                  // baby's due date, which times the baby-cost defaults (BudgetEngine.babyDefaults).
                                                  // Setup-managed like every plan.settings field: the setup file can supply it;
                                                  // a date saved in the app wins (the merge rule, §3)
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
  template: string|null,               // the pack it came from: 'babyFirstYear', 'childcare', 'kidCosts' (timeline.templates);
                                       //   'baby' on changes saved from the earlier Baby template (kept as saved; the
                                       //   template itself is gone: they are ordinary changes)
  scenario: string|null,               // the what-if it belongs to (≤ 60 chars; null: none). Applied like any change once
                                       //   accepted; build({ compare: name }) draws the plan with all of them (tl.compare)
  note,
  yearlyCents?: cents|null,            // optional (absent unless set): a yearly amount on a monthly change, added in its
                                       //   first active month and every 12th month after (childcare's membership fee)
  derived?: { role: 'setup'|'supplies'|'childcare', startMonth, cents, yearlyCents?, precision: 'day'|'month' } | null
                                       // optional: what the baby-cost defaults wrote on this change (BudgetEngine.babyDefaults),
                                       //   so a value still equal to it is provably untouched (only those are re-timed)
}

IncomeStream = {
  id, label, personId: 'p1'|'p2'|null,
  kind: 'paycheck'|'contribution'|'other',   // contribution = transfer from that person's personal account
  grossPerPaycheckCents?: cents|null,        // optional, from a pay stub: reference only, never joint funding
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
                mode: 'balance'|'flows'|'trends' ('balance'),     // the retired chart switch: kept as saved, no longer read or written
                coverFromSavings: boolean (true),
                dials: { [dialKey]: signed cents|null },          // set directly; null/absent = not set; 0 is an amount.
                                                                  // dialKey ∈ state.DIAL_KEYS: p1, p2, inOther, essentials,
                                                                  // flexible, irregular, savings, investing, other (others refused)
                rows: { [rowId]: { included?: boolean, cents?: signed cents } },  // essentials/flexible drill-down changes
                hidden: string[]|null,                            // chart series switched off; null = never chosen (kept, no longer read)
                groups: { [categoryName | 'merchant:' + place]: 'essentials'|'flexible' },  // household's grouping ({}); keys ≤ 120 chars, up to 300
                irregularOff: { [txnId]: boolean },               // the Plan's choice per one-time cost ({}); up to 1,000. true = left out of
                                                                  // the irregular allowance; false = put back in on purpose (one left out of
                                                                  // planning by its planningBaseline 'exclude' edit is out by default)
                trends: { series: string[] (['card']; keys from state.TREND_SERIES, up to 16; unknown ones dropped),
                          ma: 0|3|6 (3), trend: boolean (true) },     // the retired Trends chart: kept as saved, no longer read
                otherDial: 'debt'|'withInvesting' ('debt'),      // what dials.other holds: 'debt' = debt & business (investments
                                                                  // have dials.investing); 'withInvesting' = an amount saved before
                                                                  // that, still including investments, split once on the plan
                                                                  // screen (timeline.splitOther; set by the ui.plan.otherDial upgrade)
                investReturnPct: number 0..25|null (null),       // yearly growth (%) the household entered for the investments
                                                                  // line, compounded monthly, labelled illustrative; null = none
                scenariosCopied: boolean (true),                 // the Forecast scenarios' events were copied into plan.changes
                                                                  // (absent in budgets saved before: the plan.changes.scenarios
                                                                  // upgrade copies them once and sets it)
                groupsRead: 'exact'|'resolved' ('resolved'),     // how category names were grouped when dials.essentials /
                                                                  // flexible were set: 'exact' = before imported names were read
                                                                  // as the category they stand for (only exact taxonomy names were
                                                                  // essential; set by the ui.plan.groupsRead upgrade), carried over
                                                                  // once on the plan screen (timeline.regroupDials)
                legacyDials?: { card?: signed cents, bank?: signed cents },  // absent unless waiting: amounts set for the
                                                                  // earlier card/bank dials, until Plan carries them over
                cardSplit?: { [essentials|flexible|irregular]: { cents: signed cents, card: signed cents,
                              fromCard?: signed cents, fromBank?: signed cents } },
                                                                  // absent unless needed: the card part of a direct amount,
                                                                  // used while dials[key] === cents (set by migrateDials);
                                                                  // fromCard/fromBank mark it as carried over from the
                                                                  // earlier card/bank amount until kept (acceptCarriedOver)
                dialShift?: { [essentials|flexible]: { cents: signed cents, categories: string[] (up to 20) } } },
                                                                  // absent unless needed: what categories moved between the two
                                                                  // groups add to (+) or take off (−) an amount set directly, so
                                                                  // the plan's total stays as set; applied only while dials[key] is
                                                                  // set (plan amount = dials[key] + cents, never below $0), the
                                                                  // saved amount never changes. Written by timeline.setGroup and
                                                                  // timeline.regroupDials; setDial/resetDial/resetPlan remove it
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
          migrationNotes: string[], legacySnapshot: string|null,   // raw earlier data, set only by a migration
          babyDefaults?: { done: ('setup'|'supplies'|'childcare')[] },  // absent until the baby-cost defaults first run:
                                                                   // the defaults already made, so one the household
                                                                   // removed is not made again (BudgetEngine.babyDefaults)
          setup?: { hash: string, appliedAt: ISO-8601,             // setup sync's bookkeeping (§3); absent until it
                    base: object|null } }                          // first runs. base: the profile's setup-managed
                                                                   // values last applied, shaped like the state
                                                                   // ({ plan: { incomes, …, targets, settings, balances,
                                                                   // people }, ui: { plan: { dials, …, baselineMonths } } });
                                                                   // a group of JSON values kept as they are, up to
                                                                   // 25,000,000 chars (not valid: null, noted; the next
                                                                   // sync then runs as a first run). An older copy keeps
                                                                   // meta.setup as saved (forward compatibility, below)
}
```

**`ui.plan` has one description:** the table `PLAN_UI` in `state.js` (readable as `state.PLAN_UI`),
one row per field: its rule (type, default, limits; `optional(…)` = absent until needed), for a map
with fixed keys the message `setPath` gives for another key, and what it holds. Derived from it:
the defaults of a new budget, the rules `sanitize` checks a saved `ui.plan` with, how `setPath`
writes inside each field (a map one entry at a time, an object field one field at a time, anything
else whole), and `state.cleanPlanUi(raw)`, which `timeline.settings` reads `ui.plan` through. The
lists the rows use (dial keys, the retired card/bank dials, spending groups and dials, planned-change
kinds and groups, Trends series, the scalar choices and their defaults) are defined once in
`engine/plan-settings.js` (`BudgetEngine.planSettings`, loaded before `timeline.js` and `state.js`)
and are the same objects in `state` and `timeline`.

**Adding a `ui.plan` field:** add one row to `PLAN_UI` (name, rule with its default and limits,
`doc`) and one line for the field in the `plan: { … }` block above (a test checks that every row is
named there). Nothing else changes: defaults, `sanitize`, `setPath`/`getPath`, `cleanPlanUi` and
`timeline.settings` follow from the row. Choices the timeline needs by name go in
`plan-settings.js` and the row uses them. A field that only adds information needs no upgrade: an
older copy of the app keeps it as saved (forward compatibility, below). A field that replaces an
earlier one also needs an entry in `V5_UPGRADES`.

**Upgrades inside version 5** (`state.V5_UPGRADES`; `sanitize` runs them through
`state.upgrade(raw)` on the raw saved budget before checking it). `VERSION` stays 5, so each entry
recognises the earlier shape itself: `{ id, applies(raw), apply(raw) → { raw, note } }` (a new raw
budget; the input is not changed). **Every entry must be safe to run twice** (after `apply`,
`applies` is false, or `apply` changes nothing more) **and must leave a note** whenever it changes
what the household saved. `sanitize` shows the note and records it once in `meta.migrationNotes`,
matched by its text, so a released note's text never changes. Entries, in order: `ui.home` (the
earlier Home settings move to `ui.plan`, `migrateHome`), `ui.plan.dials.card-bank` (card and bank
dials wait in `ui.plan.legacyDials`, `migratePlanDials`), `ui.plan.otherDial` (a `dials.other`
amount saved before investments had their own dial is marked `otherDial: 'withInvesting'`, with a
note that it will be split; budgets saved since carry `otherDial`) and `plan.changes.scenarios` (once,
when `ui.plan.scenariosCopied` is absent and a scenario other than the baseline has events: each
event is copied into `plan.changes` as a what-if, `copyScenarioChanges`: id `'sc-' + eventId` (an
id already there is left alone), `scenario` = the scenario's name (≤ 60 chars), `accepted: false`, a
note "Copied from the Forecast scenario “…”" plus the event's note; recurring → monthly (expense:
essentials or flexible by its category; income +; income_loss −), one_time → oneTime (expense:
irregular; income: income), income_change → monthly income for the stream's person with the monthly
difference to joint ((new − old joint per paycheck) × paychecks a year ÷ 12) when both amounts and
the frequency are known, else no amount, bill_change and target_change → monthly with no amount
and a note saying what they set; savings-goal events and events with no (start) month are not
copied and are named in the note; up to the planned-change limit. The scenarios stay as they are.
`scenariosCopied` is true by default, so the upgrade never runs on a new budget: `state.defaults` makes
the same copy itself when it creates one, so new and saved budgets hold the same what-ifs) and
`ui.plan.groupsRead` (when `ui.plan.groupsRead` is absent and `dials.essentials` or `dials.flexible`
holds an amount: the amount was set while only exact taxonomy names were essential, so an imported
'Natural gas' or the energy aggregate was planned as flexible; marked `groupsRead: 'exact'`, with a
note that, for an amount set for only one of the two, the plan adds or takes off what moved once
the next time Plan opens (`ui.plan.dialShift`; the amount itself stays as saved); a budget
with neither amount set is never marked, and `groupsRead` is 'resolved' by default, so a new budget
never is). Upgrades that need the data run on the plan screen instead, under the same rules:
`timeline.pendingUpgrade(tl)` names them (`migrateRows`, `regroupDials`, `migrateDials`,
`splitOther`).

**Forward compatibility.** A budget saved by a newer copy of the app may hold fields this copy does
not know, and the page saves the budget as soon as it opens. So when loading (`sanitize`,
`loadFromStorage`, `importWorkbook`), a key this version does not know is **kept as saved** (after
the known fields) wherever the object has a field list: the top level, `plan`, its incomes, bills,
debts (and `promo`), savings goals, personal spending and planned changes, `plan.balances`,
`plan.settings`, scenarios with their events and assumptions, `references`, `meta`, `ui`,
`ui.whatIf`, `ui.plan`, `ui.plan.trends` and `ui.plan.legacyDials` (`plan.people` entries are
rebuilt from their ids and keep only `name`, as before). Each one gets the note "`<path>`: not
part of this version’s saved budget format; kept as saved (`<value>`)." and one summary note comes
first: "This budget has N settings this version of the app does not use (…), probably saved by a
newer copy of the app; they are kept as saved." Such keys survive the save on opening, edits made through `setPath` and the plan
screen's writes, reloading and a workbook export/import. Not kept: a `__proto__` key (dropped and
named, "…not part of the saved budget format; dropped"); map entries (`ui.plan.rows`, `cardSplit`,
`dials`, …), where an entry with a part this version does not know is still dropped as not valid;
ledger corrections' fields; and an item rewritten whole by `updateItem`/`updateEvent`, which copies
only the fields it knows. Writes stay strict: `setPath` refuses a field this version does not know.
The household profile is not a saved budget: `defaults` leaves its unknown keys out (and so does
setup sync).

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

- After `loadFromStorage` (on opening, and when another tab's save is taken over) and after a
  workbook import (`views/data.js`), setup sync (§3) brings the profile's later changes into the
  budget; its notes go with the other notes from opening the page (Data & privacy) and the first
  one is shown once as a toast.

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
  `isEssential(name)`, `find(name)` (the taxonomy entry of exactly that name, or null), `names() ->
  string[]`, `sortNames(list)`
- `resolve(name) -> string|null` — the taxonomy category a label stands for: the name itself; else
  the category or alias (`ALIASES`) with the same words (case, spacing, punctuation and '&'/'and'
  ignored: 'groceries', 'GAS AND HEATING'); else the first keyword family whose phrase appears in
  the label as whole words ('Electric bill' → Electric, 'Car insurance' → Auto insurance, 'Child
  care' → Baby & childcare; families cover only necessities named without doubt, so a bare 'Gas'
  — fuel or heating? — and 'Restaurants' stay null). Null for an aggregate and for an unknown
  label. `ALIASES` are the earlier version's category names (the same mapping as its budget keys,
  `state.LEGACY_TARGETS`): Natural gas → Gas & heating, Electricity → Electric, Municipal payments →
  Water & sewer, Groceries & meal kits → Groceries, Dining & drinks → Dining & takeout, Shopping &
  mixed retail → Mixed retail, Home & hardware → Household & hardware, Fuel & charging → Fuel,
  Vehicle care & registration → Auto maintenance, Travel & parking → Travel, Apps & subscriptions →
  Subscriptions, Uncategorized / review → Uncategorized. Labels are never renamed: transactions and
  budgets keep the names they have; only these lookups follow the category a name resolves to.
- `AGGREGATES`: budget names that stand for several taxonomy categories together, `membersOf(name)
  -> string[]|null`: "Energy (gas + electric, migrated)" (`state.ENERGY_TARGET`, the earlier
  version's combined target) → Gas & heating + Electric. An aggregate is essential when all of its
  members are, seasonal when any is, and in their group when they share one; the plan counts its
  budget once for all of its members (timeline `drill`, category budgets).
- `groupOf`, `isSeasonal` and `isEssential` look up the category a name resolves to (an aggregate:
  its members), so an imported 'Natural gas' is a seasonal Utilities essential like Gas & heating.
  `isEssentialByName(name)` is the reading before imported names were resolved (a taxonomy category
  of exactly that name, or 'Debt payment'; anything else flexible): used only to carry over amounts
  set under it (timeline `migration.regroupDials`).
- `essential` marks spending that is hard to cut; the plan screen plans it as **essentials** and
  everything else as **flexible**: Mortgage, Home maintenance & repairs, Property tax & HOA, every
  utility (Gas & heating, Electric, Water & sewer, Trash & municipal, Internet & phone), Groceries,
  Fuel, Auto maintenance, every insurance, Medical & pharmacy, Dental, Vision, Baby & childcare, and
  'Debt payment' (not a spending category; debt payments themselves are the plan's `other` dial);
  also every label that resolves to one of them (`resolve`), and an aggregate of them.
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
    exists (for an `investment` transfer from cash: an investment account; to cash from one: a
    checking, savings or other account), none covers the date, or every one has no export (a
    balance-only account: "…has no export of its own (only its balances are in the data)…"); not expected when its `pairId` points outside the data or a
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
- `revertChanges(edits, txns, txnId, { only? }) -> [{ txnId, field, value: null, reason }]` — the
  changes that take one transaction back to its imported values (each applied with `editRecord`,
  so the history is kept): one per field of `EDIT_FIELDS` the edit holds (`categoryReason` and
  `kindReason` are not fields: they go with `category`/`kind`), limited to `only` when given. A
  `reimbursement` decision is cleared on the matched charge or deposit too (`txns`: effective
  transactions with `matchIds`). `[]` when there is nothing to revert. Both revert buttons use
  it, as one undoable update: Transactions' "Revert to the imported values" / "Undo answer"
  (`review:revert`, with `data-fields` as `only`) and Spending's "Revert to imported values"
  (`ledger:revert`, `#sp-revert`).
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
- `monthly(plan, { scope: 'joint'|'household' = 'joint', month?: 'YYYY-MM', timing?, balanceKnown?: boolean }) -> PlanSummary`
  (timing defaults to `plan.settings.incomeTiming`, then conservative; `actual` without a month
  falls back to conservative with an assumption). `balanceKnown` says whether a starting cash
  balance is known as `timeline.anchors` decides it (the plan alone cannot see balances that come
  with the data); when false, `missing` lists `{ id: 'jointCash', label: 'Joint cash balance not
  entered', area: 'balances' }`. Without it only the balances entered in the plan count. The UI
  passes it (`ctx.plan`). The UI always passes a month: the **plan
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
  projection then reports cumulative change only). The UI never projects the saved plan as it is:
  every projection (Budget, Forecast, the attention list) goes through `ctx.cashPlan()`, whose
  `jointCashCents`/`asOf` are `timeline.anchors(...).combined` (see BudgetEngine.timeline), so it
  starts from the same cash the Plan page shows. A balance dated `asOf` applies from the month
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
Joint accounts only (rows on an account typed `investment` are not joint cash and are left out; a
transfer to one counts on the cash side). Every counted row gets one role: `card` (purchases and refunds on a card or
financing account), `bank` (spending paid from checking or another cash account, the mortgage
included), `repayment` (checking → card: settles purchases already counted, never spending),
`debt`, `business` (purchases marked as business costs), `savings`, `investment`, `interest`,
`credit` (money in, attributed to p1 / p2 or not assigned) and `internal` (between own accounts).
- `breakdown(txns, dataset, { months, coverageMap, plan })` → per month (full coverage only)
  `{ actual, planning, oneOffs, credits, spends }`. Base amounts: p1, p2 (and their provisional
  parts), unassigned, interest, card/bank purchases and refunds, card repayments, debt, business,
  savings in/out, investments in/out; derived: cardNet, bankNet, consumption, funding (p1 + p2),
  moneyIn, savingsNet, investNet, left. `actual` counts every row; `planning` leaves out rows the
  household left out of the planning baseline. Agrees to the cent with the joint month totals
  worked out from `ledger.summarize` (cross-checked in tests/unit/flows.test.cjs).
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
    (`{ side: 'after'|'before', from, to, days }`, `gapFor`), where no transactions are assumed
    (the account's `note` says so). An entered balance is used at exactly its date, never moved.
  - `anchor`: the latest known balance `{ date, cents, source }`; `first` / `last`: the earliest and
    latest days with a known end-of-day balance `{ date, cents }` (null without an anchor);
    `assumed`: per month, true when that value was worked across days in the `gap`.
  - No anchor: the account's line is the change since its first covered day (`source: 'change'`),
    and a group or total that includes it is a change, not a balance (`kind: 'change'`).
  - Rows excluded as duplicate copies never move a balance; every other row does.
- `incomeAttribution(plan) -> (txn) => 'p1'|'p2'|null` — whose deposit a row is: the row's
  `personId` (the household's own correction, §4, else a rule or transfer hint); else, for a contribution, the one person with a
  contribution stream, and for a payroll deposit, the one person whose paycheck reaches joint (a
  paycheck with no joint portion from someone who also sends transfers does not); with several
  candidates the per-paycheck/per-transfer amount must match one; otherwise null ("other").

### BudgetEngine.timeline
The plan screen's model, built once per render. Pure; `today` is passed in. One module in eight
files, split by section and loaded in this order (`src/manifest.json`):

| File | Holds |
| --- | --- |
| `engine/timeline-core.js` | the shared helpers (`isObj`, `isCents`, `has`, `own`, `plural`, `sumKnown`, `roundCents`, `fail`, `median`, `late`), the constants (the `planSettings` lists, `BALANCE_SERIES`, `BALANCE_SERIES_PREFIX`, `LEGACY_DIALS`, `IN_KEYS`, `MERCHANT_KEY`, `DIAL_LABEL`) and `settings`; creates `BudgetEngine._timeline` |
| `engine/timeline-balances.js` | known balances (`anchors`), mirrored savings (`mirrorPlan`), the balance lines with their assumed and illustrative points (`balancesFor`), the investments line (`investmentsFor`), `prorate`; `RULE`, `SIMPLE_RULE`, `SIMPLE_LABEL`, `ILLUSTRATIVE`, `INVEST_RULE` |
| `engine/timeline-spending.js` | spending by group (`spendGroups`, row ids: `rowIdOf`), the essentials and flexible drill-down with its pattern badges (`drillFor`), the categories planned in another group than by exact name (`regroupedByName`), the irregular items (`irregularFor`); `TINY_CATEGORY_CENTS`, `STABLE_MIN_CHARGES`, `STABLE_SPREAD`, `OTHER_CATEGORY` |
| `engine/timeline-dials.js` | observed deposits (`depositHint`), the dials and `carriedOver` (`buildDials`), one plan month (`planMonth`), the carry-over of the earlier card/bank dials (`legacyDialsPlan`) and of an Essentials or Flexible amount set before imported names were resolved (`regroupDialsPlan`) |
| `engine/timeline-changes.js` | planned changes (`readChanges`, `changeActiveIn`, `applyChange`, `summarizeChanges`), the changes worked out from Budget (`billChanges`, `goalChanges`, `incomeChanges`) and `templates` (the packs) |
| `engine/timeline-export.js` | `toCSV` |
| `engine/timeline-writes.js` | the state writes (below), `migrateRows`, `migrateDials`, `splitOther`, `regroupDials`, `pendingUpgrade`, `acceptCarriedOver` |
| `engine/timeline.js` | `build`, the Trends series catalogue, and `BudgetEngine.timeline`, assembled from the parts |

`BudgetEngine._timeline` is private to these files; the public API is `BudgetEngine.timeline`
(below). Each part adds to it what the others use, and calls another part's function only when it
runs, through `late(name)`: `timeline-core.js` loads first, `timeline.js` last (it refuses to load,
naming what is missing, when a public name has not been added), the parts in between in any order.
- `build({ txns, dataset, plan, settings, today, coverageMap?, compare? })` — `txns` effective (no
  what-if), `plan` = `state.plan` (with `plan.changes`, and from Budget its `targets`, `bills` and
  `savings`), `settings` = `state.ui.plan`, `today` 'YYYY-MM-DD', `compare` a scenario name. Returns
  `{ today, todayMonth, planStart, lastComplete, firstMonth, lastMonth, horizon, months, window,
  people, dials, dialsByKey, groups, plan, changed, changedBy, changes, bills, goals, markers,
  scenarios, compare, summary, baseline, balances, series, migration, carriedOver, settings }`:
  - **Budget reaches the plan** (the integrated plan): category budgets (`plan.targets`) are what
    the essentials and flexible rows plan at (see `drill`); joint bills the history does not hold
    are added and ones that end are taken out, and savings goals spent at their target leave
    savings, as read-only changes worked out from Budget (see `changes`, `bills`); the savings
    goals' monthly amounts are the savings dial's baseline (see `dials`). All of these are the
    plan as it stands: they are in the ghost too, and do not make it `changed`.
  - `bills`: what happened to each bill, `[{ id, label, status, changeId }]`. A bill is **seen**
    when the baseline months already hold it (so the dials count it): a debt-payment bill (`type`
    'debt') when there is any debt payment in them; any other bill with a category when any card
    or bank purchase in them (one-time, yearly, regular or everyday; not a refund) has a part in
    that category. A bill with `status` 'planned', or a `startMonth` after `planStart`, is never
    seen. Statuses: `seen` (nothing to do), `ends` (seen, with an `endMonth` on or after the
    baseline's first month: change `'bill-<id>-ends'`, −amount a month from the month after it, or
    `planStart` when later; a debt bill: see `seenDebtCents`), `added` (not seen: change `'bill-<id>'`, +amount a month from its
    `startMonth` or `planStart` when later, through its `endMonth`; group `essentials`, or `debt`
    for a debt payment: `out.debt`, `out.other`, `out.total`), `ended` (not seen, ended before
    `planStart`), `notJoint` (`fundedFrom` p1/p2/unknown: never on the joint plan), `noAmount`
    (null or $0), `noCategory` (not a debt payment and no category: it cannot be matched to the
    history, so it is never added — that could count it twice), `inBudget` (its category has a
    budget, which already plans that category). **Current debt bills are the debt payments**:
    the debt bills seen and running in the baseline months (`seen` with no `endMonth`, or `ends`;
    `billChanges` → `seenDebtCents`, their monthly amounts added up) are in the history, but
    the window's average misstates them: a debt that started recently is diluted (three $80
    payments in twelve months average $20), and a payment lowered or refinanced keeps its older,
    higher amount there. When there is one (`seenDebtCents` not null; a debt bill at an explicit $0,
    paid off or paused, is seen at $0 and counts), their total is the debt part of the `other`
    dial's baseline (`parts.debt`), lower or higher than the average of debt payments — instead of
    the average, never on top of it — and an `ends` change takes out exactly what it counted. The
    history cannot be split by bill (a debt bill has no category, payee or account), so none of a
    different average is kept. Whenever the average differs from the bills, the dial's `debtCheck`
    (`{ billsCents, averageCents, historyMore }`, else null) discloses it (the dial is then shown
    even at $0) and the basis adds "; debt payments at your current debt bills from Budget ($80.00
    a month, not the average of $170.00). The history’s debt payments cannot be matched to these
    bills one by one, so the plan uses the bills" and, when the history paid more (`historyMore`,
    also a "Check debt bills" badge on Edit plan), "; the history paid more: if a debt payment is
    missing from your bills, add it in Edit plan, or set this amount here". A dial set directly
    still wins.
  - `goals`: `plan.savings` with `{ id, label, targetCents, savedCents, monthlyCents, targetMonth,
    spendAtTarget, cumulativeCents, reachMonth, already }`. The projected savings balance (the
    savings accounts' lines added up) reaches goal k in the first month, from the last complete
    month on, at or above the targets of goals 1..k added up (list order, cumulative; goals with no
    target add nothing and have no month); no savings line: no months. `already`: reached in the
    first month looked at. `markers`: `[{ kind: 'goal', id, month, label: '<label> reached', cents }]`.
  - `scenarios`: `[{ name, count, accepted }]`, the what-ifs in `plan.changes` (`scenario`), by
    name. `compare`: null, or for `input.compare` naming one: `{ scenario, changeIds, addedIds
    (its changes not accepted yet, with an amount: the ones added), unset, points: [{ month, cents,
    status }] (the combined line with them applied; null except in projected months), runsOut,
    lowest, months: [{ month, in, out, savings, net, combinedChange }] (plan months) }`.
  - `summary`: "this month's plan", the first plan month with everything in it (dials, accepted
    changes, what Budget adds): `{ month, inCents, inByPerson: { [personId], other }, outByGroup:
    { essentials, flexible, irregular, other }, outCents, savingsCents, investingCents, leftCents }`
    (`leftCents` = in − out − savings, out including investing); null without a plan month.
  - `carriedOver`: null, or the spending dials' `carriedOver` once for the headline area, plus
    `dials` (keys) and `summary`: "Three dials carry your earlier card spending setting of $4,200.00
    — review them, then Keep or Reset." ("Two dials carry …", "One dial carries … — review it, …").
  - `planStart` = the month after the last month every spending account covers in full.
    `months` run from the first month with data (earlier when a balance is known before it) to
    `planStart + horizon − 1`: `{ month, status: 'actual'|'partial'|'plan', current, complete,
    coverage, in: { [personId], unassigned, other, total }, out: { essentials, flexible, irregular,
    card, bank, debt, business, invest, other, total }, savings, net, combinedChange, oneOffs,
    oneOffCents, actualSoFar, changesApplied, baseline }`. `out.essentials + flexible + irregular =
    card + bank`; `out.other = debt + business` (debt & business); `out.invest` = net to
    investments; `out.total = card + bank + other + invest`;
    `combinedChange = in.total − out.total` (moves to and from savings stay inside joint cash);
    `net = combinedChange − savings` (left in checking). Actual months come from `flows.breakdown`
    (incomplete ones: amounts null, `actualSoFar` = the covered part, same shape); their spending is
    split by group with the same rules as the dials (one-time costs: the baseline window's
    classification, else one over every month with data). From `planStart` on, amounts come from
    the dials plus the accepted planned changes, and a partly covered month is `partial`.
    `changesApplied: [{ id, label, group, cents, source }]` (plan months; [] otherwise; the changes
    worked out from Budget too). `baseline`: for plan months when `changed`, `{ in, out, savings,
    net, combinedChange }` at baseline dials with no planned changes (totals; the changes worked out
    from Budget applied); otherwise null.
  - `dials`: one `in` dial per person in the plan (`inOther` when the baseline has unmatched
    deposits or interest), then the `out` dials in `groups.out` order: `essentials`, `flexible`,
    `irregular`, `savings` (signed), `investing` (signed: net transfers to investment accounts;
    shown when its baseline is nonzero, it is set, the data has an investment account, or an
    earlier `other` amount waits to be split) and `other` ("Debt & business": debt payments and
    business purchases; only when nonzero or set). The savings dial's baseline is the savings
    goals' monthly amounts added up when any goal has one (`budgetCents`; basis "From Budget: 3
    savings goals ($450.00 a month)"), else the average (`averageCents`); it also has `basisKind:
    'budget'|'average'|'direct'`. While `settings.otherDial` is 'withInvesting', a `dials.other`
    amount X reads as other = X − the investing baseline (source 'direct') with investing at its
    baseline, and the other dial has `split: { fromCents, investingCents, otherCents }` (else null).
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
  - Grouping: a category is `essentials` when `categories.isEssential` says so for the category its
    name resolves to (`categories.resolve`: an imported 'Groceries & meal kits' is Groceries), else
    `flexible`; `settings.groups[category]` overrides it, and `settings.groups['merchant:' + place]` moves every
    purchase of that place (all its categories) into a synthetic category row named after the place
    in the chosen group. One-time costs are never in these groups: they are the `irregular` dial.
    **Regrouping with a dial set directly**: an amount set directly for Essentials or Flexible stays
    exactly as saved; what categories moved between the two groups since add to it or take off it
    (`settings.dialShift[key]: { cents, categories }`), applied only while the dial is set directly:
    `planCents` = the amount set + `cents` (never below $0; an amount already below $0 is not
    lowered), and the dial gets `shift: { cents, categories, setCents }` (else null) and its basis
    ends "Set here: $300.00, less $200.00 for Groceries & meal kits, now planned in Flexible" ("…,
    plus $50.00 for Dining & drinks, now planned here"). `setGroup` writes it when exactly one of the
    two is set directly; an amount set before names were resolved (when only exact taxonomy names
    were essential; `settings.groupsRead` 'exact') is carried over once the same way
    (`migration.regroupDials`, `regroupDials`).
  - **Category budgets** (`plan.targets`): a level-1 row of one category plans at its change in
    `ui.plan.rows` when that has an amount (`source: 'set'`), else at its budget when that is a
    number (`source: 'budget'`), else at what its rows give (`source: 'history'`); `budgetCents` is
    the budget or null (level-2 rows: null, `source` 'set'|'history'). A budget is for the whole
    category: a place moved to a group as a whole takes its share of the category's history out of
    it (`budgetMovedCents`, never below $0), and changes to the rows under it (a place left out, a
    place's amount) move it by exactly what they change, so the drill-down still works. A budget for
    a category with no history in its group (`settings.groups`, else the taxonomy) is a row of its
    own: `history: false`, `defaultCents` 0, no level-2 rows, no transactions. The dial's
    `baselineCents` counts each category at its budget (less what moved out) when it has one, else
    its `defaultCents`; the basis adds "; N category budgets from Budget". A budget of null is "not
    set". The grouped "Other" and places moved as a whole plan from `ui.plan.rows` only.
  - **Aggregate budgets** (`categories.AGGREGATES`, e.g. the migrated "Energy (gas + electric,
    migrated)"): one budget for several taxonomy categories, counted once. Its row plans at its
    budget (a row of its own, `history: false`, when nothing is categorized under its name; in the
    group its members are planned in). A category with no budget of its own whose name resolves to
    a member (`categories.resolve`: 'Natural gas', 'Gas & heating', 'Electricity', 'Electric') and
    that is planned in the aggregate's group keeps its row, history and level-2 rows but plans at
    $0 (`source: 'aggregate'`, `aggregate`: the budget's name; null on every other row; its
    baseline $0) and is never grouped into "Other"; the aggregate is paid like those members
    (`paidBy`, `cardShare`) and names them in `covers` (sorted; [] on every other level-1 row). Changes move the aggregate by exactly what they change: a change to a
    member's level-2 rows by its difference; a member left out, or given an amount of its own in
    `ui.plan.rows` (planned at it, `source: 'set'`), by minus the member's `defaultCents`. Members
    planned elsewhere take their share out of the aggregate like a place moved as a whole
    (`budgetMovedCents`, never below $0): a member with a budget of its own (on the plan screen a
    member's amount is written as its budget: splitting "Natural gas" off at $110 leaves $40 of a
    $150 energy budget) takes that budget; a member the household moved to the other group
    (`settings.groups`) its history there, where it plans from its history. So a $150 energy budget
    with $100 of gas and $50 of electricity history plans $150, not $300; the saved budget and
    history are untouched.
  - **Rows that change group by name**: when a category's group comes from the taxonomy and its
    rows have no change of their own, a change saved under the other group's id for the same row
    (`<other group>` instead of `<group>` in its id: made while an imported name such as 'Natural
    gas' was not recognised and so planned as flexible) still applies (`legacyId` names it) and is
    in `migration.rows`, which `migrateRows` makes permanent.
  - `drill` (essentials, flexible): `{ kind: 'categories', group, rows, categoryCount, baselineCents,
    rowsCents, baselineCardCents, rowsCardCents, cardShare, overridden, stableCount, yearlyCount,
    orphanIds, tinyCategoryCents, budgetCount }`; rows are categories (level 1, tiny ones grouped as
    "Other", never one with a budget) and
    regular places plus "Everything else" (level 2) with stable ids `<group>-c|m|r-<hash>` (the hash
    of the same parts as the earlier card/bank ids). Every row has `avgCents` (the average; card and
    bank averages added), `defaultCents` (its plan amount from its history), `planCents`, `override`,
    `budgetCents` and `source` (below),
    `included`, `group`, `synthetic` (a place moved as a whole), `paidBy: 'card'|'bank'|'mixed'`,
    `cardShare` (0..1, by amount), `cardCents` / `bankCents` (its plan amount split; at the default
    exactly the card and bank averages), `pattern: 'bill'|'everyday'|'occasional'` (bill = regular
    and stable; everyday = seen in at least `baseline.regularAt` of the window months (60%, at least
    2) and not stable; occasional = the rest; a category is 'bill' when all its rows are),
    `legacyId` (the earlier card/bank row whose change it is using, else null), `txnCount` and
    `txnIds`: the transactions behind the row in the baseline months, newest first (date, then id
    descending), one id per transaction however many split parts it has there (`txnIds.length ===
    txnCount`); a category's are the union of its rows', which share them out (no transaction in
    two rows of one category; a purchase counted as regular with the `planningBaseline: 'include'`
    edit is in its category's ids). Level-1 rows also
    `members`, `merchant` (synthetic rows), `movedFrom` (synthetic rows: the place's categories),
    `groupKey` (what `setGroup` takes: the category, 'merchant:' + place, or null for the grouped
    "Other"), `groupSource: 'taxonomy'|'override'|null`, `seenMonths`, `ofMonths`; level-2 rows also
    `latestCents`, `latestDate` (null on "Everything else" rows), `seenMonths`, `ofMonths`, `stable`. A
    stable regular place (3+ charges, about once a month, all within 10% of their median) defaults to
    its latest charge; others to their average. Categories add up their rows, and the dial baseline
    is Σ category `defaultCents` (the basis then ends "; regular bills at their latest amount").
  - `drill` (irregular): `{ kind: 'items', rows: [{ id (txn id), txnIds ([id]), label (place), date, month, cents,
    monthlyCents, included, planningExcluded, auto, paidBy, category, description, accountLabel }], count,
    includedCount, leftOutCount, totalCents, includedCents, baselineCents, rowsCents,
    baselineCardCents, rowsCardCents, cardShare, overridden, orphanIds, examples }` — every one-time
    cost of the window (found automatically, `auto`, or marked with the `planningBaseline: 'exclude'`
    edit, "Leave out of planning" in Transactions or Spending: `planningExcluded`). By default one
    found automatically is in the allowance and one left out of planning is not (the button means
    what it says: its cost is not spread into the plan). `settings.irregularOff[id]` is the Plan's
    own choice and wins either way: `true` leaves one out, `false` puts a left-out one back in on
    purpose (the ledger edit stays; the Plan shows it ticked with "put back in here; left out of
    planning in Transactions or Spending", and unticked by default with "left out of planning in
    Transactions or Spending"). Baseline = Σ costs in by default ÷ window months; `rowsCents` = Σ
    those in now; `overridden` (dial source 'rows') when any differs from its default, so a cost
    left out in Transactions or Spending lowers the baseline and does not mark the plan changed.
    Clearing the edit ("Include in planning again") restores the default. Actual months always
    count every cost. The `planningBaseline: 'include'` edit ("count as regular") moves an item
    into its category instead (it is then in `baseline.keptIn`, not here). Nothing is left out of
    the plan automatically. Basis: "One-time costs over Oct 2025–Sep 2026 spread per month
    (14 items, $X) — dental work, trips, repairs, tax" (+ "; N left out by you").
  - `plan`: one plan month from the dials (no planned changes): `{ in, out, savings, net,
    combinedChange, toSavings, fromSavings }` (`toSavings` = max(0, savings), `fromSavings` =
    max(0, −savings)); `out.card` / `out.bank` derived from the spending dials.
  - `changed`: any dial not at its baseline, or any planned change applied; `changedBy: { dials,
    changes }`.
  - `changes`: `{ list, applied, derived, unset, totalOneTimeCents, monthlyNowCents, overlaps }` — `list`: each
    valid `plan.changes` entry (`source: 'plan'`, `readOnly: false`, `scenario`, `yearlyCents` (null
    unless set: added in the first active month and every 12th after, so a month's applied amount is
    `cents + yearlyCents` then; `appliedCents` sums the months' amounts), `babyRole` and `precision`
    (the baby-cost default it is, from `derived`; else null)), then the changes
    worked out from Budget (`source: 'bill'` with `billId`, or `'goal'` with `goalId`; `readOnly:
    true`, `accepted: true`: edited in Budget, never by `setChange`/`acceptChanges`), each with
    `status: 'unset'|'notAccepted'|'applied'|'overridden'|'overlap'|'outside'`, `monthsApplied`, `appliedCents`
    ('overlap': a baby-cost default held back in every plan month because an accepted New baby /
    Childcare / Kid costs pack, or the household's own accepted item of the same kind (in its group,
    or about a child anywhere), covers the same cost: `babyDefaults.guard`; a monthly default is held
    back only in the months a covering item runs and counts again after; each one in `overlaps` as
    `{ kind: 'pack'|'alternative', role, id, label, with: ids, template?, from, until }`, so the
    screen warns; nothing is removed. An unaccepted item of the same kind there is an alternative:
    never added on top of the default, not in `tl.compare` either);
    `applied`: how many of the household's own applied; `derived`: how many are worked out from
    Budget; `unset`: ids with no amount (never applied as $0). A savings goal spent at its target
    (`spendAtTarget`, `targetCents`, `targetMonth`): change `'goal-<id>'`, one-time, irregular, with
    `fromSavings: true`: in that month the amount is spent (`out.irregular`, `out.bank`,
    `out.total`) and leaves savings (`savings` − amount), so checking is unchanged. The same goal with
    a `monthlyCents` above $0 also stops being saved for: change `'goal-<id>-stops'` (label
    "<label>: monthly saving stops"), monthly, group `savings`, −`monthlyCents` from the month after
    `targetMonth` (or `planStart` when later), open-ended, with `dial: 'savings'` — it belongs to the
    savings dial's baseline (the goals' monthly amounts), so while net to savings is set directly it is
    not applied (status `'overridden'`); the plan at baseline (the ghost) always has it. (A goal spent
    at its target with no `targetCents` gets only the stop.)
    Pay in Budget that starts or ends inside the plan (`incomeChanges`, `source: 'income'`,
    group `income`, `personId`): a person's money-in dial is their Budget pay in the first plan
    month; in each later plan month their money in follows their Budget pay in that month
    (`flows.planFunding`, annual-average timing; a stream whose `startMonth` comes later joins, one
    past its `endMonth` leaves, a month with none of their streams is $0). Consecutive months with
    the same difference from the dial make one change `'pay-<person>-<month>'` (the last one
    open-ended); a stream running without an amount is listed on its own as
    `'pay-<person>-<stream id>'` with no amount (never $0). The dial stands on its Budget pay for
    the first plan month; when none of the person's Budget pay runs then (it starts later, or ended
    before the plan): under a dial set directly that is $0 (later pay adds on top); on the
    deposit-average fallback their known Budget pay replaces the average in the months it runs
    (other months keep the average). A person with no pay in Budget keeps the average throughout.
    Accepted changes with an amount add to plan months from `startMonth` (one-time: that month only;
    monthly: through `endMonth` when set): income to `in[personId]` (`in.other` without a person),
    spending groups to that group, `out.bank` and `out.total`, savings to `savings`. Totals count
    money out of checking as positive (spending and savings +, income −), over the household's own
    changes: `totalOneTimeCents` over the applied one-time changes, `monthlyNowCents` over the
    monthly ones in the first plan month.
  - `baseline`: `{ setting, count, months, start, end, label, oneTime, oneTimeCents, keptIn, yearly,
    regularAt, plan }` — one-time items with `{ id, date, month, merchant, description, accountLabel,
    role, dialKey ('irregular' for card and bank purchases), cents, auto }`; toggled with the
    `planningBaseline` ledger edit. `plan`: when `changed`, one plan month at baseline dials (same
    shape as `plan`), else null.
  - `series`: the Trends chart's lines, `[{ key, name, group: 'in'|'out'|'savings'|'net'|'balances',
    kind: 'flow'|'balance', unit: 'perMonth'|'atMonthEnd', values }]`, `values` aligned with
    `months`. First the monthly amounts (`kind: 'flow'`, `unit: 'perMonth'`: actual months from
    what happened, null when incomplete; partial and plan months from the plan). Keys, in order:
    `in-<personId>` per person, `in-other`, `in-total`, `card`, `bank`, `essentials`, `flexible`,
    `irregular`, `other-out` ("Debt & business"), `investing` ("Into investments": `out.invest`),
    `out-total`, `to-savings`, `from-savings`, `net`, `combined-change`
    (`SERIES` lists the fixed ones). Then the balances (`group: 'balances'`, `kind: 'balance'`,
    `unit: 'atMonthEnd'`): each balance line's month-end cents, the same as its points' `cents`
    (null where not known; projected months included, which the chart dashes from `planStart` like
    every line): `balance-combined` ("Combined cash", `balances.combined`, either mode),
    `balance-<accountId>` ("<account name> balance") per account in `balances.accounts`, and
    `balance-savings-total` ("Savings total") when two or more savings accounts have a line (null in
    a month where any of them is unknown), and `balance-investments` ("Investments",
    `balances.investments.points`) when the data has an investment account. No balance line, no
    balance series; an account whose id
    would give one of the fixed keys has no series of its own. Every key can be saved in
    `ui.plan.trends.series`: `planSettings.BALANCE_SERIES` lists the fixed balance keys, and
    `TREND_SERIES.includes` also accepts `balance-` + any account id (`planSettings.isBalanceSeries`).
  - `migration`: null, or `{ rows: [{ from, to }], dropped, superseded, rowsNote, dials, other, regroupDials, note }`
    when `settings.rows` still holds changes saved under the earlier card/bank dials or under the
    other group for a category now planned by its name (see `drill`; after the card/bank ones in
    `rows`, never `dropped`; the row note then adds "N changes to spending rows moved with their
    categories to the other group: an imported category name is now read as the category it stands
    for."),
    `settings.legacyDials` holds amounts set for them, `settings.groupsRead` is 'exact', or a `dials.other` amount waits to be split
    (`other`: `{ fromCents, investingCents, otherCents, investingSet, note }`, note "ui.plan.dials.other:
    your amount for debt, business and investments ($600.00) was split now that investments have a
    dial of their own: Investing is set to $200.00, its average; Debt & business is set to
    $400.00." — or null when the investing baseline is $0; `migration.note` adds it without its path). A row change applies to the same row
    (`<group>` instead of `card`/`bank` in its id) when that row is paid only that way and is not the
    grouped "Other"; `migrateRows` makes that permanent. `rowsNote`: the row note
    ('ui.plan.rows: …', recorded by `migrateRows`) or null. `note`: what to show once — the row note
    without its path, then `dials.note`, `other.note` and `regroupDials.note` (both without their path).
    `regroupDials`: null unless `settings.groupsRead` is 'exact' (an Essentials or Flexible amount
    set before imported category names were read as the category they stand for), else `{ moved:
    [{ category, from, to }], set: 'essentials'|'flexible'|null, cents: d|null, shift: { dial,
    setCents, cents, categories, plannedCents }|null, note|null }` — how `regroupDials` carries it
    over once, as a regrouping adjustment (`settings.dialShift`; the amount set never changes).
    `moved`: the categories of the baseline's everyday spending (split parts included) and the
    category budgets with an amount whose group now (taxonomy, `categories.isEssential`) differs from
    the group by exact name (`categories.isEssentialByName`); a category the household grouped in
    `settings.groups` is never moved. `set`: the one spending group set directly (null when both or
    neither are: their total is right, only the mark changes). d (`cents`) is what moved from
    Flexible to Essentials, measured on the group not set directly at what it plans (rows, else
    baseline) now and with `settings.groups` holding each moved category's earlier group: Essentials
    now − then, or Flexible then − now (negative: the other way). `shift.cents`: Flexible alone −d
    (Essentials now holds d too, so it was counted twice); Essentials alone +d (Flexible no longer
    holds it, so it was left out); d = 0 → null. `setCents`: the saved amount it is for;
    `plannedCents`: the dial's plan amount with it (never below $0). Until the upgrade runs the plan
    uses the dials as saved. Note, e.g. "ui.plan.dialShift.flexible: Flexible is planned at $180.00:
    the $300.00 you set, less $120.00 for “Natural gas”, now read as Gas & heating and planned in
    Essentials, so it is not counted twice." (Essentials: "…, plus $120.00 for …, so it is not left
    out."; several: "“Natural gas” (Gas & heating) and “Electricity” (Electric), now read as the
    categories they stand for and planned in Essentials, so they are …"; an aggregate is read as
    its members, "Gas & heating + Electric").
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
    combined, policy, runsOut, lowest, notes, assumed, illustrative, investments }`.
    `investments` (`investmentsFor`): null without an investment account, else `{ accounts:
    [{ id, name, owner, ownerName, label, primary, anchor, known, note, points }], points, missing,
    returnPct, illustrative, rule, notes }` — never part of `combined` or `accounts`. Every account the
    data types `investment` is on it, joint or personal: `owner` 'joint' (scope joint), else the
    account's `ownerId` ('p1'|'p2', null when the data does not say), `ownerName` the person's name,
    `label` "<name> (joint)" / "<name> (Alex)" / "<name> (personal)" (`missing` entries carry the
    same three, and the notes use the label). The investing dial still counts only joint cash
    flows; the main account that takes them is the joint one with the latest known balance (only
    when the data has no joint investment account, the latest known personal one). Known balances as for cash accounts
    (supplied with the data or entered, worked across the account's own transactions where its
    export covers the days; a balance-only account is known on its balance dates), then after the
    last known day each month adds `out.invest` to the main account (the latest known balance;
    others stay level; pro-rated in the month of that day). With `settings.investReturnPct` (set by
    the household; default null: no growth) each projected month also grows by that rate a year,
    compounded monthly ((1 + r)^(1/12) − 1, rounded to the cent), and those points are
    `'illustrative'` instead of `'projected'`; `illustrative` then reads "Illustrative: grows 6% a
    year, compounded monthly, at the rate you entered. Not a forecast of returns." `points`: the
    accounts added up (null where any is unknown). Rows on an investment account are not joint
    money (`flows.breakdown` leaves them out); a transfer to it counts once, on the cash side. Points are `{ month, cents,
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
  — the starting balances. Per account the newest known balance wins: the export's running
  balance, a balance supplied with the data (`dataset.balances`, source 'statement'|'bank'; absent
  is fine) or the entered one, which is used only when no bank figure is dated the same day or
  later; with no account balance, the single joint cash figure (`jointCashCents`/`asOf`).
  **This is the one accessor for starting cash.** `timeline.build` (the Plan page) calls it, and
  the app's view context (`makeContext` in `ui/app.js`) calls it once per derive for everything
  else: `ctx.anchors()` is its result for the saved plan and the decided transactions;
  `ctx.cashPlan()` is the plan with `balances.jointCashCents`/`asOf` replaced by `combined`
  (null/null when nothing is known), which `ctx.project` (Budget's 12-month change, the attention list) starts
  from; and "is a balance known" (`combined` not null) is passed to
  `plan.monthly` (`balanceKnown`, via `ctx.plan`) and `attention.list` (`balanceKnown`, via
  `ctx.attention`). A balance that comes only with the data therefore counts as known everywhere:
  "Joint cash balance not entered" and "Enter today's balances" appear only when no balance is
  known at all. Budget's joint cash card reads `ctx.anchors()` too, and offers the single joint cash
  input only while no account has a balance.
- `toCSV(tl, { people?, format? }) -> string` — RFC 4180, CRLF, deterministic. Block "Settings"
  (`key,value` rows: today, baseline window/setting/months used/from/to, plan start, last month,
  horizon, cover from savings, `invest_return_pct`, `dial.<key>.label|baseline|plan|source|card|bank`, `group.<key>`,
  `row.<id>.label|included|amount`, `one_time.<txnId>.label|date|amount|state` ('in the irregular
  allowance' | 'left out by you' | 'counted as regular spending'), `balance.<accountId>.name|date|
  amount|source` (simple mode: `balance.joint_cash.*`), `investment.<accountId>.name|owner|date|amount|
  source`, `change.<id>.label|kind|group|person|start|end|amount|accepted|status|source|scenario`
  (the changes worked out from Budget too), `goal.<id>.label|target|reach`), a blank line, then
  block "Months": `month,status,in_<personId>…,
  in_other,in_total,essentials,flexible,irregular,other_out,out_total,to_savings,from_savings,
  combined_change,net_checking,combined_balance,combined_status,<accountId>_balance,
  <accountId>_status…,investing[,investments_balance,investments_status]` (net to investments last,
  so the earlier columns keep their places; the investments line when there is one). Dollars as plain decimals ("-1234.50"; `format: 'cents'` for whole cents),
  unknown as empty, statuses as words; free text starting with = + - @ gets a leading '.
- `templates.list() -> [{ key: 'babyFirstYear', label, needs: ['dueDate'] }, { key: 'childcare',
  label, needs: ['startMonth', 'monthlyCents'], defaultCents: 120000 }, { key: 'kidCosts', label,
  needs: ['dueDate'] }]` — the packs: generic placeholder estimates in the style of US national
  averages (not the household's data, not quotes), every item an ordinary planned change with
  `accepted: false`, `personId: null`, its pack's `template`, a note saying it is a generic estimate
  to adjust, and `scenario` when `opts.scenario` is given (shortened to 60 characters).
  `templates.babyFirstYear(dueDate, opts?)` (due month D: car seat and stroller, nursery D−2;
  starter clothes and feeding gear D−1; birth out-of-pocket D+1; diapers, formula, health, clothes
  monthly D..D+11; parental leave income change D..D+2 with no amount),
  `templates.childcare(startMonth, monthlyCents = 120000, opts?)` (one monthly change, open-ended),
  `templates.kidCosts(dueDate, opts?)` (from D+12: food, health, clothes, activities open-ended;
  diapers through D+35). The earlier `templates.baby` is gone (the screen offers the three packs);
  changes saved from it (`template: 'baby'`) are ordinary changes and stay exactly as saved.
- State writes (return a new State, validated through `state.setPath` / `addItem` / `updateItem`):
  `setDial(state, key, cents|null)` (setting `other` while `otherDial` is 'withInvesting' makes it
  'debt'; setting essentials or flexible while `groupsRead` is 'exact' makes it 'resolved': the new
  amount is chosen as the groups are read now; it removes the dial's `cardSplit` and `dialShift`
  entries, so `resetDial` and "Use the rows" do too), `setRow(state, rowId, { included?, cents? }, tl?)` (on a level-1 row of one category —
  not the grouped "Other", not a place moved as a whole; found in `tl`, else from the row id against
  the budget's keys and the taxonomy — an amount of 0 or more is the category's budget:
  `plan.targets[category]` is set and the row's `cents` in `ui.plan.rows` removed, its `included`
  kept; null clears the budget to null when it was there; a negative amount stays in
  `ui.plan.rows`), `setTarget(state, category, cents|null)` (what Budget writes),
  `resetDial(state, key, tl?)` (the dial and its rows; irregular: also `irregularOff`, so each one-time cost is back to its default, in the allowance unless left out of planning; with `tl`,
  also the earlier card/bank row changes its rows use), `resetRow(state, rowId, tl?)` (the row's
  change in `ui.plan.rows`; with `tl`, also its earlier card/bank change; never `plan.targets`, so
  a category row goes back to its budget when one is set, else its history: the Plan's row Reset),
  `resetPlan(state)` (dials, rows and `irregularOff`, and `cardSplit` and `dialShift` cleared; groups, budgets and
  planned changes stay). A reset puts each key it covers back to what the setup file supplied for
  it when it was last applied (`setupSync.baseValue`, section 3: the dial's amount, a row's change,
  a one-time cost left out), and removes the keys it did not supply (back to the rows, baseline or
  history); a key the setup file supplied is never removed by a reset, so its later values still
  flow (S = B). `setGroup(state, key, 'essentials'|
  'flexible'|null, tl?)` (key = category or 'merchant:' + place; with the current `tl` a category's
  row changes follow it to the other group, and when exactly one of essentials and flexible is set
  directly the category's plan amount in the group it leaves — its level-1 row in `tl`; $0 when
  left out, grouped into "Other" or without `tl` — goes into `ui.plan.dialShift`: taken off the
  dial set directly when it is the one left, added to it when it is the one joined; the category
  joins the adjustment's `categories`, or leaves them when it moves back; an adjustment back at $0
  with no category is removed, and `dialShift` with its last entry. The plan month's total stays the same and `ui.plan.dials` is
  untouched. A place moved as a whole gets no adjustment), `setIrregular(state, txnId, included)` (keeps only a choice that differs from the default: `true` to leave out one in by default, `false` to put back one left out of planning by its `planningBaseline: 'exclude'` ledger edit; the edit is never touched),
  `addChange(state, item | item[])`, `setChange(state, id, patch)` (switching to one-time clears
  `endMonth`, away from income clears `personId`, unless the patch sets them),
  `removeChange(state, id)`, `acceptChanges(state, id | ids, accepted = true)`, `splitOther(state,
  tl)` (`tl.migration.other`: investing set directly to its baseline unless set in the meantime,
  other to the saved amount minus it, `otherDial` 'debt', the note appended to
  `meta.migrationNotes`; with no investments in the baseline only `otherDial` changes, no note;
  `otherDial` 'withInvesting' with no other amount: just 'debt'; safe to run twice),
  `regroupDials(state, tl)` (`tl.migration.regroupDials`: while `groupsRead` is 'exact' and the dial
  set directly still holds exactly `shift.setCents` (changed since: left as it is), `shift.cents` is
  added to `ui.plan.dialShift[shift.dial]` with the moved categories, and the note is appended to
  `meta.migrationNotes`; `ui.plan.dials` never changes (a `cardSplit` entry stays as saved, applying
  only while the plan amount equals it); `groupsRead` becomes 'resolved'; nothing to carry over:
  only `groupsRead`, no note; not marked, or a timeline built without the mark: the same state; safe
  to run twice),
  `migrateRows(state, tl)` (moves the earlier card/bank row changes, and the ones saved under the
  other group for a category now planned by its name, that `tl.migration` matched, removes
  the rest, and appends `tl.migration.rowsNote` to `meta.migrationNotes`; returns the same state
  when there is nothing to do), `migrateDials(state, tl)` (sets each `tl.migration.dials.to` amount
  directly with its card part in `ui.plan.cardSplit`, leaving a dial set directly in the meantime
  alone; removes `ui.plan.legacyDials` and any `ui.plan.dials.card`/`bank`; appends
  `tl.migration.dials.note` to `meta.migrationNotes`; returns the same state when nothing is
  waiting). The plan screen runs `migrateDials(migrateRows(state, tl), tl)` once, as one change,
  and shows `tl.migration.note`; `pendingUpgrade(tl)` names that: null when nothing is waiting,
  else `{ steps, note, apply }` — `steps` ⊆ `['migrateRows', 'regroupDials', 'migrateDials', 'splitOther']` in that order (`regroupDials` before `migrateDials`, whose amounts follow the groups as read now), `note`
  = `tl.migration.note`, `apply(state)` runs the steps (safe to run twice; section 7, upgrades). `setDial` removes the dial's `cardSplit` and `dialShift` entries; `resetPlan` clears
  `cardSplit` and `dialShift`. `acceptCarriedOver(state, key | keys)` ("Keep") removes only the
  `fromCard`/`fromBank` marker: the amount and its card part stay, so card and bank totals do not
  move; nothing marked → the same state.
- `settings(raw)` — `ui.plan` as the screen reads it: `state.cleanPlanUi(raw)` (the one validator,
  from `PLAN_UI`, section 7: every field present with its default, anything not valid reset or left
  out as `sanitize` would, silently; keys this version does not know left out) plus the screen's one
  quirk: a `dials.card`/`bank` amount still in `raw` (a budget `sanitize` has not moved yet) goes to
  `legacyDials` (`{ card?, bank? }`, amounts only) and wins over one waiting there. `legacyDials` and
  `cardSplit` are always present (`{}` when empty). `prorate(cents, daysLeft, daysInMonth)`,
  `depositHint(credits, personId)`; constants `OUT_DIALS`, `MERCHANT_KEY`, `DIAL_LABEL` and, from
  `BudgetEngine.planSettings` (the same objects `state` uses): `BASELINE_CHOICES`, `HORIZONS`,
  `PAST_CHOICES`, `MODES`, `DEFAULTS`, `TREND_MA`, `TREND_DEFAULTS`, `SPEND_GROUPS`, `SPEND_DIALS`,
  `LEGACY_DIALS` (= `RETIRED_DIALS`), `CHANGE_KINDS`, `CHANGE_GROUPS`, `SERIES`.

### BudgetEngine.state
- `VERSION = 5`, `storageKey(datasetId)`, `LEGACY_KEYS(copyIds?)`, constants `STORAGE_PREFIX`,
  `LEGACY_PREFIX`, `LEGACY_COPY_IDS`, `WORKBOOK_FORMAT`, `BASELINE_ID`, `BASELINE_NAME`, `LIMITS`,
  `LEGACY_FIELDS` and `LEGACY_TARGETS` (where every earlier field goes), `EVENT_TYPES`,
  `SAVED_FORECAST_NAME`, `ENERGY_TARGET`, `OTHER_EXPENSES_TARGET`.
- `defaults(profile, dataset, { now }?) -> State` — the profile's plan, the baseline followed by
  the profile's scenarios, `compareIds` = baseline + first other scenario; `references` start empty.
  The scenarios' events are also copied into `plan.changes` as not-accepted what-ifs, exactly as
  the `plan.changes.scenarios` upgrade copies them for a saved budget (ids `'sc-' + eventId`, an id
  the profile's own `plan.changes` already has is left alone; no note). `sanitize` checks a saved
  budget against the same defaults without that copy, so a saved budget never gains them as a
  fallback. Setup sync manages only the profile's own `plan.changes` (its `defaults` call has no
  scenarios), so the copies are the budget's own items there: never updated or removed by it.
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
    it. A missing `plan.changes` becomes `[]` without a note. Both moves are `V5_UPGRADES` entries.
  - A key this version does not know is kept as saved, with a note and one summary note
    (section 7, forward compatibility).
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
    Every removal is noted with the removed amounts. The plan then counts the energy target once
    for the gas and electricity history too (`categories.AGGREGATES`; timeline `drill`).
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
  `CHANGE_KINDS`, `CHANGE_GROUPS`, `TREND_SERIES` (frozen; `BudgetEngine.planSettings`'s lists).
- `ui.plan` (section 7): `PLAN_UI` (read-only rows `{ name, default, optional, doc }`) and
  `cleanPlanUi(raw) -> object` (silent: defaults filled in, invalid values reset or left out as
  `sanitize` would, unknown keys left out, `legacyDials` amounts only; never throws).
- Upgrades inside version 5 (section 7): `V5_UPGRADES` (`[{ id, applies, apply }]`, frozen) and
  `upgrade(raw) -> { raw, notes, applied }` (runs the entries that apply, in order; pure).
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
  These return the budget before setup sync; the page (and any tool loading a budget for the
  household) runs `setupSync.apply` next, or calls `setupSync.loadFromStorage` / `importWorkbook`.

### BudgetEngine.setupSync
Setup sync, section 3. Loaded after `state.js`; uses `state.defaults`, `state.cleanPlanUi` and
`state.PLAN_UI` when called. Pure; no clock.
- `apply(state, profile, { now }?) -> { state, notes, changed, report }` — the three-way merge.
  The input is not changed. Without a profile, or when the hash of the profile's setup-managed
  values equals `meta.setup.hash`: `{ state }` (the same object), no notes, `changed: false`,
  `report: null`. Otherwise `meta.setup` is written (`appliedAt` = `now`, else the earlier one, else
  `meta.updatedAt`), `meta.updatedAt` = `now` when a saved value changed (`changed`), and
  `report = { first, updated: string[], kept: string[], invalid: string[] }` holds the labels
  behind the notes ("Rent amount", "Dining & takeout target", "Water (new)", "Streaming (removed)",
  "Cushion (removed here)").
- `loadFromStorage(storage, datasetId, profile, dataset, opts?)` and `importWorkbook(text, profile,
  dataset, opts?)` — the `state` functions followed by `apply` (same `opts`); results add
  `setupNotes` (also appended to `notes`) and `setup` (the report).
- `baseValue(state, path) -> value | undefined` — what the setup file supplied at `path` when it
  was last applied (B in `meta.setup.base`, read through the same checks as the merge reads it; a
  copy): `path` is a managed path or one key under it (`'ui.plan.dials.flexible'`,
  `'plan.targets.Groceries'`; a list: an item id). undefined without `meta.setup`, for a part the
  setup file left out or a key it did not supply. What the Plan screen's resets write back.
- `MANAGED` — the setup-managed paths `[{ path, kind: 'list'|'map'|'fields'|'value' }]`, from the one
  table in `setup-sync.js`; `SYNC_VERSION` (part of the hash: raised when the merge changes);
  `equal(a, b)` — the deep equality over JSON values it uses.

### BudgetEngine.babyDefaults
The baby-cost defaults (`engine/baby-defaults.js`, loaded after `setup-sync.js`): the household
asked for the baby's costs to be planned for them as editable estimates. Pure; no clock. The page
runs `ensure` after setup sync on every load, workbook import and reset (`ui/app.js`,
`ui/views/data.js`), and `follow` on every write (`app.update`), so a new `babyDueDate` re-times
them; `tools/plan-report.cjs` runs it too.
- `DEFAULTS` (one per role, ids `'baby-default-<role>'`, labelled "(estimate)", each with a note):
  setup $2,000 once (`irregular`) in the month before the birth month; supplies $450 a month
  (`essentials`, open-ended) from the birth month (the note splits it: feeding 200, diapers and wipes
  100, clothing 50, care 35, toys 25, contingency 40); childcare $1,800 a month (`essentials`) from 6
  weeks after the birth — an early, full-package planning allowance, not a booking, a confirmed
  return-to-work date or a confirmed rate — with `yearlyCents` $150 (a membership fee in the first
  care month and every 12 months after, on the same change). `CAVEAT`: medical costs, insurance
  premium changes and parental-leave pay are not included (unknown, never $0; leave lowers income, a
  savings reserve is a transfer). Changing the defaults' amounts is a decision for the household's
  assistant (design authority).
- Timing: `plan.settings.babyDueDate` (precision `'day'`): setup in the month before the birth
  month, supplies from the birth month, childcare from the month holding the date + 42 days
  (`CARE_AFTER_DAYS`). Without it, a copied baby what-if group's birth month (its earliest monthly
  `sc-` item not filled by the defaults) gives a month-level estimate (precision `'month'`, never a
  made-up day): childcare `CARE_AFTER_MONTHS` (2) after the birth month. With neither: unknown —
  nothing is written, `status` lists the defaults with `dateNeeded`, and only Budget's setup details
  ask for the date.
- `ensure(state, { now }?) -> { state, notes, changed, status }` — one canonical group: the group
  already holding a default, else a copied what-if group (ids `'sc-…'`) whose name or a label is
  about a baby or a birth, else a new group `'New baby'` (`GROUP_NAME`). Per role not yet in
  `meta.babyDefaults.done`: covered when the group holds an accepted item about it of the default's
  kind with an amount of $0 or more (a monthly one running at the default's start month; the
  household's own choice, an explicit $0 included: nothing added). An item elsewhere in the plan
  (e.g. the household's own 'Daycare' with no what-if) does not stop the default from being made:
  `guard` holds it back in the months that item runs (a credit below $0 never covers a cost);
  else an untouched placeholder
  of that kind (`roleOf` its label; no amount; start month still the one its scenario event gave it,
  or the group's birth month) is filled (amount, timing, accepted, `derived`; a name still as copied
  gains "(estimate)"; its note is kept after the default's); else the default row is added to the
  group, accepted (the household's instruction covers these defaults only; packs and other what-ifs
  keep their approval). Roles already made are re-timed only where `startMonth` still equals
  `derived.startMonth`; dates, amounts, explicit zeros, inclusion choices and unaccepted
  alternatives the household set are never changed, and nothing is removed. Idempotent: a second
  run returns the same object; a removed default is not made again (`meta.babyDefaults.done`).
- `status(state) -> { group, timing: 'day'|'month'|'unknown', dueDate, birthMonth, caveat, items }` —
  for the Plan and Budget screens and the report.
- `follow(prev, next, opts?)` — `ensure(next)` when `babyDueDate` differs between them, else `next`.
- `guard(changes)` — for `timeline.build` (counting once, above): `{ held, heldIn(id, month), alternatives, overlaps }`.
- `roleOf(change)` — which default a spending change is about, from its label (childcare, supplies,
  setup words), or null; `ROLES`, `PACK_ROLES` (`babyFirstYear`: setup and supplies; `childcare`;
  `kidCosts`: supplies).

### BudgetEngine.attention
- `list({ dataset, txns, state, ctx, balanceKnown? }) -> [{ id, severity: 'action'|'decision'|'info', title, detail, route, cta? }]`
  — data items (from `review.queues`), plan items and forecast items (`ctx.project(scenarioId, { months })`
  supplies projections; they open the Overview: `#/overview`, a scenario's missing amounts Edit plan's planned changes `#/budget?focus=plan-changes-h`); sorted action → decision → info; items whose `'attention:' + id` is in
  `state.ui.dismissed` are hidden; a part that fails becomes one `info` item instead of breaking the list.
  The "Enter today's balances" item (id `balance`, route `#/overview`) is listed only when no starting
  balance is known: `balanceKnown` as the caller passes it (the app: from `ctx.cashPlan()`), else
  `timeline.anchors(state.plan, dataset, txns).combined`.

## 9. UI routes

| Route | View |
| --- | --- |
| `#/overview?month=YYYY-MM` | Overview (`views/overview.js` composing `views/plan/*.js`, one `timeline.build` per render; a `?compare=` left by the retired Compare control is ignored). Top to bottom: (1) balances (`#plan-balances`, `plan/balances.js`): each joint cash account, checking first then savings (`.ov-bal.is-checking|is-savings`, `#plan-bal-<id>-figure`, `#plan-bal-<id>-asof` "as of <date> · from your statement|from your bank data|entered by you"; an unknown one says "Not known", never $0; never "today"), then the combined total (`#plan-bal-total`, the date or date range of its balances); the editors are folded under `<details id="plan-bal-edit">` (open when no balance is known): per account `#plan-bal-<id>` amount and `-date` (an entered figure overrides the data's; empty means the data's figure, shown as the placeholder; `plan:balance`, `#plan-bal-<id>-use-data` `plan:balance-use-data`), or one Cash figure (`#plan-bal-cash`) without a cash account; (2) the plan month (`#plan-kpis`, `plan/tiles.js`, heading "<Month YYYY> · monthly estimate on this plan"): Income (`#plan-kpi-in`, `tl.summary.inCents`), Outgoing (`#plan-kpi-out`, `outCents`: spending, bills, debt and investing; savings moves are not outgoing) and Margin (`#plan-kpi-margin`, in − out, red below 0; its line says how much moves to or from savings); each tile is a button (`plan:month`) that opens that month's breakdown; three across on phones too; (3) the chart card (`#plan-chart-card`, `plan/chart.js`): the below-$0 warning (`#plan-warn`: the combined line's `runsOut`/`lowest`, else the first plan month a checking account goes below $0), then two `chart.cashChart` panels on the same months, each with its own axis title, legend chips (presentation only; `ui.plan.hidden` is not read or written), caption folded under "About this chart" and "Show as a table": `#plan-chart` (balance mode, "Balance, $ at month end": each cash account, checking first (`series-2`, savings `series-3`), and `combined` (`series-1`); markers for accepted planned changes (a group's by its name), what Edit plan adds after the plan starts and goals reached; no investments line, no baseline or compare line) and `#plan-flows` (trends mode with `ma: 0, trend: false`, "Monthly, $ per month": `flow-in` Income (`in-total`), `flow-out` Outgoing (`out-total`) and `flow-savings` Net to savings (`to-savings` − `from-savings`, shown when any month has one)); actual months solid, plan months dashed ("this plan's monthly estimate"); both are `selectable`: a click, a tap or Enter on a month dispatches `chart:select`, which draws that month's breakdown in place (the chart is not redrawn, so a phone's readout stays) and keeps it in the address (`history.replaceState`, `?month=`); Past 6/12/all and Ahead 6/12/24/60 months (`ui.plan.past`, `ui.plan.horizon`), Export CSV; without any known balance the balance panel is an empty state with `#plan-prompt` (`plan:goto-balances`, opens the editors); `ui.plan.mode` and `ui.plan.trends` stay saved and are not read; (4) `#plan-month-box`: a month's breakdown (`plan/month.js`, `#plan-month[data-month]`, only on demand): Income, Outgoing, Margin and what moved to or from savings; money in by person (`#plan-month-inlist`); outgoing by group (`#plan-month-outlist`: Essentials, Flexible, Irregular, Debt & business, Investing), each a closed `<details id="plan-month-grp-<group>">` with its categories: for an actual month what was spent (the plan's category rows say which group a category is in; one-time costs under Irregular), each category linking to `#/spending?period=<month>&cat=<category>` for its places and transactions; for a plan month the plan's category amounts and that month's applied changes, and in the plan month itself what was spent so far ("$X of $Y", over in the warning colour; `#plan-month-sofar` how many days the data covers); `#plan-month-more` links to Spending (actual) or Edit plan's dials (`#/budget?focus=plan-dials-h`); `#plan-month-close` (`plan:month` with no month) closes it; (5) Coming up (`#plan-coming`, `plan/changes.js` `comingHtml`): at most six lines from the plan month on, nothing to edit — a group's changes (`_plan.groupKeyOf`: a what-if's name or a pack's) as one line with its totals and how many are in the plan, every other change, bill, pay change or goal from Edit plan as its own line, and goals reached; `#plan-coming-edit` links to Edit plan's planned changes |
| `#/spending?period=2026-09&cat=Groceries&merchant=…&txn=…&q=…&window=3` | month → category → merchant → transaction drilldown with breadcrumbs |
| `#/budget?section=income|bills|debts|savings|targets&focus=<id>` | Edit plan (`views/budget.js` composing `views/plan/*.js` and `views/budget/*.js`; the same `ctx.memo('timeline')` build as the Overview; every `plan:*` action and the `budget:*` setup actions), the one place for the plan's inputs, in this order: (1) `#plan-dials` "Money in and out, a month" (`plan/dials.js`): money in by person (from the pay saved under Pay and income, else the deposit average marked not confirmed) and Who paid in (`#plan-deposits`), money out as Essentials, Flexible spending, Irregular costs, Net to savings, Investing and Debt & business; slider in $25 steps plus an exact box, one short line (baseline, the basis in a few words), the whole basis behind ⓘ (`#plan-dial-<key>-info`), Reset per dial (`#plan-dial-<key>-reset`) and "Reset all to baseline" (`#plan-reset`) in the card's head; essentials and flexible open into categories and places (`#plan-drill-<key>`: pattern badges, untick, an amount — a category's amount is its `plan.targets` budget —, Move to the other group, and every row's transactions `#plan-txns-<rowId>` with a category select `#plan-txcat-<txnId>` (`plan:txn-category`, keys of a closed list wait for Enter), "All N from this place → [category]" `#plan-row-<rowId>-cat` (`plan:merchant-category`)); irregular lists the one-time items (untick, "Count as regular"); no headline under the dials (the monthly figure is the Overview's); (2) `#plan-changes` "Planned changes" (`plan/changes.js`): the list `#plan-ch-list` by start month (accept, name, amount, status, remove; when and how folded under the date); a group's changes (two or more) are one folded row `li.plan-ch-group[data-group=<name>]` with one box `#plan-grp-<slug>-on` (`plan:group-accept`, indeterminate while some are accepted); what pay, bills and goals add is read-only with a link to its own section (`#plan-ch-<id>-budget`); "+ Custom change" (`#plan-add-custom`, the `#plan-ch-new-*` form, `plan:add-change`); no packs and no Accept all / Unaccept all; (3) savings goals (`#bud-goals`, `budget/goals.js`): one card per goal (saved/target ring, the plan's reach month from `tl.goals` or "Not on this plan", the monthly amount bound to `plan.savings[id].monthlyCents`); (4) "Pay, bills and debts" (`#bud-setup`, `budget/setup.js`): one disclosure per area (`#bud-area-income|bills|debts|savings`; `section=` opens it, `focus=` focuses a field inside) — pay and income, personal accounts, bills (with what the plan does with each, `tl.bills`), debts, the savings goals list and the joint cash balance while no account balance is known; (5) Settings (`#plan-more`): baseline months (`plan:baseline`) and cover a checking shortfall from savings (`plan:cover`). `section=targets` opens the essentials and flexible category lists; `focus=bud-target-<category>` (the id the Transactions and Spending views link to) focuses that category's row amount. Every edit is undoable; the toast adds the month's new figure Each Reset (a dial's `#plan-dial-<key>-reset`, an edited row's `#plan-row-<rowId>-reset`, `#plan-reset`: "Reset all to baseline", or "Reset all" when the setup file supplied a dial, row or one-time cost) says in its label and toast what it goes back to: "your setup value ($X)", "its baseline ($Y)", a category row's "its budget ($Z)" (its budget stays: `timeline.resetRow`) or "its average"; a person's dial at its setup value also offers "Use the N-month average". |
| `#/forecast…` | retired: rewritten in place to `#/overview` (router `REDIRECTS`, app `redirected`); its `?scenario=` / `?compare=` are dropped. `state.scenarios` and `ui.compareIds` stay saved as they are; `BudgetEngine.forecast` stays for Edit plan and the attention list |
| `#/review?queue=uncertain|duplicates|transfers|reimbursements|business|spikes|coverage|edited|reconcile` | data review & corrections |
| `#/data` | load files, export/import workbook, storage & privacy explanation, reset. `?load=csv`: bank exports and balances files, added to the data in use (default for a household's own data; `importer.mergeDataset`, summary "N new, M already present, coverage now to …" with Add / Cancel and Replace instead… behind a confirmation) or replacing it (default for the fictional sample; import report, then Use this data). The hub lists posted balances and offers the data in use as a data file (JSON) that "Choose a data file" reads back |

`period` is `YYYY-MM` or a range `YYYY-MM..YYYY-MM`. Browser Back/Forward move through drilldown levels.

UI rules that cut across views:

- **What-if switches are a Spending-view lens.** `ui.whatIf` is saved, but the UI builds two
  effective ledgers: the real one (no what-if) for Plan, Budget, Review and Data, and
  the what-if one only for Spending, which shows a notice while a switch is on. Actual totals
  elsewhere never change because of an unconfirmed reimbursement or business flag.
- **Navigation:** Overview, Edit plan (route `budget`), Transactions (route `review`), then Spending and Data & privacy (under More on phones; Data & privacy is also the top bar's link), in the same order on every screen size; no nav hints and no footer.
- **Plan reference month:** the Overview's tiles and Edit plan show the timeline's first plan month (`tl.summary`):
  the dials plus what that month adds (`tl.summary.changes`: `inCents`, `outCents`,
  `savingsCents` and the `items` behind them: accepted changes, and the bills, goals and pay
  saved in Edit plan). The Overview's tiles and breakdown count `changes` too, so both screens show one figure;
  pay is counted at the annual average there (`flows.planFunding`). Other plan summaries (Edit plan's
  setup details, debts) use `month = forecastStart` and name their pay-timing basis.
- **Parental leave (the New baby pack):** one monthly income change with no amount until one is
  entered (listed as "amount not set", never applied as $0), so leave never looks free.
- Saved scenarios, edits and plan values go through `state` validation; typed month and date
  inputs commit on Enter or leaving the field, not on every keystroke.

## 10. Known limitations

Deliberate gaps in the current engine; each needs a contract decision before it changes.

- **Closed or replaced accounts:** every spending account is expected from the earliest to the
  latest coverage of any spending account, so after a card is closed every later month stays
  `partial`. There is no account end date or "closed" flag; use `coverageOverrides` meanwhile.
- **Coverage has no scope:** gaps in a personal account (or a declared personal account with no
  export) make joint-view months partial too.
- **Investment accounts must be typed `investment`** (or `savings`): a paired savings/investment
  transfer between two accounts typed `checking`/`other` nets to $0 saved. Only joint investment
  accounts have a line on the plan (personal ones, e.g. a retirement account, are not shown). In the joint view, money
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
