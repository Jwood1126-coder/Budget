# Source-informed engineering handoff

## What is preserved

This export preserves the five-view static application, dependency-free assembly, CSS layout, event-driven local state, pure calculation engine, and self-contained HTML download. It replaces all personal source records, names, narrative evidence, debt inventory, planning defaults, private links, and production-specific assertions with generic explanations and invented examples.

The interface structure is intentionally carried forward. This handoff does not claim to fix the budget workflow's navigation or information-density issues.

## File map and execution flow

| File | Responsibility |
| --- | --- |
| `layout.html` | Static semantic shell, five sections, filters, form controls, dialogs, embedded-data/script placeholders |
| `style.css` | Existing responsive layout, cards, drilldowns, tables, forms, and print styling |
| `math.js` | Pure functions exposed as `globalThis.HouseholdBudgetMath`; integer-cent amounts, planning, projections, filtered totals, merchant grouping, monthly comparison, health-target migration |
| `app.js` | Parses embedded JSON, defines generic target defaults, merges scenario state, renders sections, binds events, persists local edits, downloads self-contained HTML |
| `assemble.py` | Combines shell, CSS, calculation engine, application, selected input JSON, and empty initial state into `dist/index.html` |
| `build_sample.py` | Deterministically creates `data/sample-data.json` without reading any real dataset |
| `validate.py` | Checks assembled sample, HTML target IDs, links, fixture coverage, and integer-cent reconciliation |
| `test-math.cjs` | 48 calculation and comparison checks using invented values |
| `test-runtime.cjs` | Minimal DOM simulation plus 12 initialization, state, navigation, validation, migration, and reset checks |

Assembly chooses `data/budget-data.json` only when present and `--sample` is absent. JSON is embedded in inert script tags with `<` escaped to prevent script-tag termination. JavaScript and CSS are inlined. The app reads the embedded data, merges embedded state followed by browser local storage, renders, and registers listeners. The frontend API is `window.HouseholdBudget` with `data`, `definitions`, `getState()`, `calculate()`, `project()`, and `setPlanInputs()`.

## Five views and core functions

- **Overview:** `overview()` derives baseline averages, category bars, monthly totals, prior-year comparison, and a synthetic irregular-expense example
- **Spending:** `period()`, `spending()`, `renderComparison()`, and `renderDrill()` coordinate period/category/source-label/search/review filters, optional scenario offsets, pagination, and category → merchant → transaction drilldown
- **Build your plan:** `defs`, `defaults`, `renderBudgetInputs()`, `syncInputs()`, and `plan()` implement full-household or joint-only planning and explicit missing-input warnings
- **Future & savings:** `renderForecastInputs()`, `forecast()`, and `installForecastEvents()` implement horizons, timing, one-offs, debt-end dates, growth/yield assumptions, projected cash, and monthly detail
- **Review & next steps:** `review()` renders checklist, coverage, exclusions, unresolved merchants, recurring candidates; `renderDebtInventory()` provides an explicitly fictitious reference inventory

Periods are derived from `defaultPeriod`, `quarter.months`, and the sorted `monthly` array. Forecast defaults begin one month after the latest included month. Childcare, other family-cost, and leave start months are blank until supplied.

## Data contract

The fixture keeps the normalized schema's main sections: `schemaVersion`, `currency`, `asOfDate`, `defaultPeriod`, `sources`, `transactions`, `monthly`, `quarter`, `income`, `knownCommitments`, `recurring`, `uncertainties`, `recommendations`, `reconciliation`, `methodology`, and `categoryAudit`. `isSynthetic: true` explicitly marks the fixture. Income keys and all code/state identifiers use `personA` and `personB`.

The application directly consumes `transactions`, `sources`, `monthly`, `quarter`, `defaultPeriod`, and `recurring`. Other fields document fixture provenance and demonstrate the broader normalized structure; they are not an automatic balance importer or detailed account audit.

Important transaction fields:

- `id`, posted `date`, `merchant`, `source`, `kind`, `amountCents`, `category`, and preserved `sourceCategory`
- `flags`, including review, candidate reimbursement/work cost, and synthetic nonroutine-expense examples
- `classificationEvidence` with summary, basis and confidence; separate category/item/scope review booleans
- `direction` and `incomeType` for non-spending rows

`amountCents` is an integer. Expense purchases are positive; refunds are negative. Other cash-flow rows are separate types and do not automatically enter expense totals. Both sides of a transfer may exist: a simple transfer-row sum is not net household outflow.

`monthly` must be chronological. Each month declares `hasMainCardCoverage`; only fully covered prior months enter the usual-spend baseline. `quarter.months`, the baseline date range, category summaries, and monthly totals must agree with the transactions. The invented fixture has 576 records over 24 months, including refunds, partial-coverage examples, category revisions, unresolved categories, reimbursement/work candidates, and non-spending cash flows. Its baseline totals are derived by the generator rather than copied from any source household.

## Calculation rules worth protecting

1. **Units and blanks:** `cents()` converts editable dollar inputs to integer cents. Null/blank stays unknown. Invalid, negative, non-finite, or over-limit planning amounts are rejected; transaction refunds can still be negative
2. **Income basis:** regular-month multipliers use four weekly/two biweekly checks; annual-average mode uses 52/12 or 26/12. Unknown Person A cadence may use a clearly flagged two-check illustration in joint mode only
3. **Household vs joint:** household mode includes full pay, personal debts and leftover personal allocation once. Joint mode uses Person A pay after allocation plus Person B's contribution, excluding personally funded debts. Person B vehicle funding is explicit
4. **Spending:** purchases and direct bills count once; refunds reduce totals. Card repayments, internal transfers and investment funding are excluded from purchase spending
5. **Review adjustments:** candidate reimbursement and work-cost toggles affect the historical view only. They do not rewrite source rows or edit forecast targets
6. **Health migration:** a legacy combined health target is preserved until explicitly split. Splitting preserves total cents; a historical irregular cost is not automatically forecast again
7. **Forecast:** monthly cash starts from available cash, adds income, subtracts expenses/family costs/one-offs, then adds hypothetical interest on nonnegative opening cash. Savings allocations earmark that cash and are not subtracted twice
8. **Timing:** debt payments are freed only after the entered final month; leave reductions expire after entered duration; one-offs occur exactly once in their entered month. Unknown inputs produce incomplete status rather than invented timing
9. **Growth:** income and variable living costs compound fractionally across months. Housing/debt payments and personal allowance stay fixed; cash yield is hypothetical and pre-tax
10. **Comparisons:** selected month never enters its own baseline. Covered zero-spend months count as zeros; missing coverage is excluded. Zero/negative baselines do not produce misleading percentages. A usual-spend variance must exceed both $100 and 25% of a positive baseline; utilities receive a seasonal label

## State and validation

`mergeState()` and `mergeForecast()` constrain known fields and preserve user edits. `version: 4` scenarios include forecast state; migration tests cover earlier same-schema health-target state. This public export deliberately does not import any previous private browser namespace or personally named field keys.

Invalid input leaves the last valid calculation visible, marks the form, and blocks download/print until corrected. The export itself starts with no custom scenario. Download clones the rendered page and embeds the current scenario; downloaded HTML is therefore sensitive if the user has supplied private values.

## Known UX weaknesses and suggested next pass

- **Budget creation is hard to find.** The navigation says “Build your plan,” but overview/audit content dominates the first impression. A focused next iteration should prioritize a clear create/edit budget path and stepwise income → commitments → flexible spending → savings flow
- **Too much audit detail.** Source categories, evidence, review flags, record drilldowns and reconciliation information compete with everyday budgeting. Keep traceability accessible while using progressive disclosure
- **Navigation and comparison are unintuitive.** Monthly comparison has its own month/window controls alongside the main period filters; chart clicks can change several controls. Improve active-context labels and a predictable return/reset path
- **Long one-page structure.** Five views share one document and long nested sections. Mobile and keyboard workflows need real-browser testing before claiming usability improvements

Potential redesign should keep actual spending, historical comparison, editable forward targets, and scenario-only adjustments visibly distinct. Do not change the financial invariants while simplifying presentation.

## Other limitations and verification boundaries

- Pure JavaScript calculations use integer cents within JavaScript Number limits; inputs are bounded, but this is not a decimal/accounting ledger library
- No tax calculation, amortization, APR accrual, investment/retirement model, reliable debt payoff estimate, or bank reconciliation engine is provided
- The source has generic fixed categories; a new household's category taxonomy may require changes to `defs`. Unknown extra categories do not automatically become complete budget targets
- Starting available cash excludes already committed bills only if the user supplies it that way
- The recurring list and debt inventory are reference information; only editable targets enter plan arithmetic. Sample debt balances must never be mistaken for imported private balances
- Earliest coverage flags are intentionally incomplete fixture examples; the sample is designed for software testing, not realistic bank statements
- No hosted-access/privacy guarantee is supplied by this code. `noindex` does not enforce secrecy
- Tested: syntax, sample assembly, structural/data checks, 48 math tests, 12 simulated DOM/runtime checks
- Not tested in this handoff: actual browser rendering, screenshots, browser download/printing behavior, full keyboard/screen-reader audit, mobile layout, cross-browser storage, or external browser model-context integrations
