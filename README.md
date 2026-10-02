# Household budget workspace

A local-first budgeting workspace for a two-person household. It shows where money went, what you can afford, and how today's decisions play out over the coming months and years.
It is a single self-contained HTML file. It runs in your browser with no server, no bank connection, no tracking and no network requests (a Content Security Policy blocks them).

> **This repository is public.** Only the fictional sample household ("Alex & Sam") belongs here. Your exports, household profile, rules and private builds live in the git-ignored `private/` folder. A privacy check blocks commits that contain them (see [Keeping private data private](#keeping-private-data-private)).

## Quick start with the fictional sample

Requires Node.js 18 or newer and a current browser. There is nothing to install.

```sh
node tools/build.cjs --sample
# then open dist/index.html in your browser (double-click it, or drag it into a window)
```

## Using your own data

### 1. Import your bank and card exports (command line, recommended)

1. Download CSV exports for each account: joint checking, savings, credit cards, and personal accounts if you want them. Cover whole months, and note the date range you requested; that range is the file's *coverage*.
2. Put the files in `private/raw/`.
3. Run `node tools/import.cjs`. The first run writes `private/import.example.json`. Copy it to `private/import.json` and fill in one entry per account and one per file, including `coverageStart`/`coverageEnd`.
4. Optional: add household rules in `private/rules.json`, such as your utilities, employer, store-card payments or a partner's transfer wording. The format is in `fixtures/sample-rules.json` and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ("Rules format").
5. Run `node tools/import.cjs` again. It writes `private/budget-data.json` and a readable `private/import-report.md`. The report covers rows read and skipped (with reasons), duplicates removed from overlapping exports, coverage by account and month, spending per month, and items to review.
6. To check a total against one you already have, run `node tools/import.cjs --period 2026-07-01..2026-09-30`. It prints that period's breakdown: purchases, refunds, card payments and transfers that were excluded, debt payments, and pending reimbursement or business candidates. The app's **Review → Reconcile** does the same on screen.

The importer recognises common US export layouts: signed amount, debit/credit columns, and card exports with transaction and posted dates. It infers card sign conventions, skips pending rows, and de-duplicates overlapping files without dropping genuine same-day repeats. It never infers what was inside an Amazon, Costco or Target order from the merchant name. Bank categories are kept alongside the household categories.

### 2. Describe your household

Copy `fixtures/sample-profile.json` to `private/household-profile.json` and edit it: names, income streams, bills, debts, savings goals and starting scenarios. Leave anything you don't know as `null`. Unknown values stay visibly unknown in the app and are never treated as $0.

### 3. Build your private copy

```sh
node tools/build.cjs          # uses private/ when present; prints a PRIVATE BUILD warning
```

Open `dist/index.html`. It contains your transactions and profile, so keep it on your own devices and never commit or upload it.

**Alternative without the command line:** open any build, go to **Data & privacy** and load CSV exports, a prepared `budget-data.json`, or a profile JSON. Nothing is uploaded; the files are read and stored in that browser only.

### Upgrading from the first version

- A `data/budget-data.json` in the earlier format still works. The build uses it when `private/budget-data.json` does not exist, and it is converted on load.
- A budget saved in the browser by the earlier version is migrated automatically the first time you open the new private build in the same browser. Every saved value is either carried over or listed in **Data & privacy → Upgrade notes**. The earlier entry is left untouched, and you can download a pre-upgrade backup.
- HTML copies downloaded from the earlier version can be imported in **Data & privacy → Import a workbook**.

## Finding your way around

Start on **Home**: it answers the everyday questions without any setup beyond your bank exports. The other views are there when you want detail; nothing in them needs regular attention. The sidebar on computers and the bottom tab bar on phones hold five views. **Data & privacy** sits in the top bar on phones. Every view and every drilldown level has its own address, so the browser's Back and Forward buttons, bookmarks and reloads all work.

| View | What it answers |
| --- | --- |
| **Home** | Four plain answers from your own recent months (joint accounts): **what is comfortable to save and spend this month**, **what you have now**, **where you end up if you keep this up**, and **what if** you change how much each of you brings in, what you spend or what you move to savings (sliders redraw the projection as you move them). **Money coming in, by person** shows what each partner puts into the joint accounts in a usual month and month by month. A line chart shows your checking, savings and total balance month by month, solid for the past and dashed for the projection, plus your in/out/saving pattern month by month. |
| **Spending** | Drill down month → category → merchant → transaction, with breadcrumbs, search (including by amount) and filters. Each category shows this month, its usual monthly average over the previous 3, 6 or 12 *full* months (never including the month itself), and the dollar and percentage difference with a plain-language explanation. Every total links to the transactions that make it up. |
| **Budget** | Income (including the effect of an unconfirmed pay frequency), bills and debt payments, spending targets next to your usual history, savings goals and debts. A summary shows planned against actual and what each change does to what remains. |
| **Forecast** | Named scenarios built from dated changes, compared side by side over 1–5 years: home repairs, a trip, baby costs, childcare, parental leave, savings goals, a debt paid off. A month-by-month table counts actual paydays (biweekly pay has two three-paycheck months a year), and shows the negative months, unfunded goals and missing costs. Scenarios never change your history or your budget. |
| **Review** | Uncertain categories, mixed-retailer purchases (with optional splits), possible duplicates, unmatched transfers, reimbursement and business candidates, unusual spikes, account coverage, a corrections log, and reconciliation against a reference total. Every correction needs a reason, keeps the bank's original category, and can be undone or reverted. |
| **Data & privacy** | Load files, export or import a workbook, export corrected transactions, upgrade notes, reset, and an explanation of where your data is stored. |

## How the numbers work

- **Counted once.** Spending is purchases and bills net of refunds. Paying a credit card in full, moving money between your own accounts and saving are never spending. A partner's transfer into joint is joint income, but in the whole-household view it is not extra income on top of their pay. Debt payments for purchases that are not in your data, such as a store-card financing payment, are shown separately.
- **Home's numbers are your own pattern.** "Usual" is the average of your last 12 complete months (one-offs you left out of planning are left out). "Comfortable to save" is what was left over (money in − spending) in at least 9 of those 12 months, rounded down to $50, so an expensive month is covered. Balances come from the running-balance column in your bank export; for an export without one, enter one balance from a statement and the history is worked out from the transactions. Money in is split by person using your import rules (a transfer hint that names the partner) and your Budget incomes (whose paycheck is deposited to joint, who sends transfers); when that cannot tell, the amount is matched to each person's usual deposit, and anything still unmatched (interest, refunds) is shown as "other". The projection is plain arithmetic: each month checking changes by money in − spending − saving, and savings grows by what you move there. No interest, no growth, no guesses.
- **Unknown is not zero.** Blank amounts are listed as missing and left out of totals, never treated as $0. When income is unknown, "what remains" says so instead of showing a number.
- **Usual spending is history, not a target.** Averages use only months with full coverage from every spending account. Partial months are excluded rather than counted as $0. A month with no activity in a category counts as $0, and a zero or refund-heavy baseline gives no percentage. A category is marked higher or lower only when it differs by at least $100 *and* 25%. Heating and cooling are compared with the same month last year. Once-a-year bills are labelled irregular instead of being flagged every month.
- **Unusual one-offs stay in actual spending.** Review lets you leave a spike, such as a dental episode, out of the *planning baseline* used to suggest targets. Actual totals never change.
- **Personal money is counted once.** Each person's personal share of a paycheck (take-home minus what reaches joint) first pays their personal bills and any transfer to joint. In the whole-household view the rest is personal spending: your personal-spending estimate if you enter one (anything above it stays in that person's account and counts toward what remains), otherwise all of it is assumed spent and the page says so.
- **Reimbursement and business candidates are counted until you decide.** Confirming a reimbursement removes the charge and the matching deposit together. A partial repayment removes only the repaid part. The Spending view's what-if switches preview leaving pending candidates out, in Spending only; other views always show actual totals.
- **Pay timing.** The Budget shows a typical month (two biweekly checks) or the annual average. The forecast counts actual paydays when a pay date is known. An unconfirmed frequency is shown as a labelled assumption, with what each possible frequency would mean.
- **Debts.** Balances, rates and terms are shown as entered, with their status (approximate, as displayed, confirmed). No payoff date is calculated. "At least N payments" is a 0%-interest floor. Rate-based illustrations appear only when you enter a rate, and are labelled illustrative. A promotional-financing check needs the promotional balance and end month before it says anything about the payment.
- **Forecasts start from your budget.** The cash balance is only used if you enter one, and it applies from the month after its date. Investment return is 0% unless you set a hypothetical rate.

The full rules, data formats and engine APIs are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Saving and sharing

- Changes save automatically **in this browser on this device** (its local storage). They are not shared between partners or devices, private windows may not keep them, and clearing browser data erases them.
- **Undo:** the last 30 changes can be undone until the page is closed, with the **Undo** button in the top bar or Ctrl+Z (Cmd+Z on a Mac) outside text fields.
- **Several tabs:** a tab picks up changes saved in another tab of the same browser straight away, and never writes its older copy over them. If storage fails or is blocked, or a saved budget turns out damaged, every view says so; Data & privacy lets you download or delete the damaged copy.
- **Opened as a file, the storage is not private to this page.** Chrome and Edge give every HTML file opened from your computer (`file://…`) the same local storage, so any other downloaded page you open in that browser could read what this page keeps there: always your saved budget, and transactions too if you loaded CSV files in the browser. Prefer the command-line import and a private build (the transactions stay inside the HTML file, not in browser storage), use **Forget** for files you loaded in the browser, and only open HTML files you trust in the browser you use for this.
- To share or back up, use **Data & privacy → Export workbook**. The JSON file holds the plan, scenarios, corrections and references, but not transactions. Import it on the other device. Keep it private.
- Truly shared household storage would need a small hosted service with logins and backups, or an end-to-end encrypted file in a cloud folder you already use. Both involve a hosting or cost decision, so neither is set up. The Data & privacy view lists the trade-offs.

## Keeping private data private

- `private/`, `dist/`, `data/budget-data.json`, bank exports (`*.csv`, `*.ofx`, `*.qfx`, `*.pdf`, …) and workbook exports are git-ignored.
- `node tools/check-privacy.cjs` scans tracked and unignored files for forbidden paths, email addresses, account-number patterns, the markers private outputs carry (real datasets and profiles, workbook exports, private builds, import reports) and the terms in your own `private/denylist.txt` (names, employers, exact amounts). Enable it as a pre-commit hook once per clone: `git config core.hooksPath .githooks`. The hook checks the staged content, which is what the commit would publish.
- `tools/import.cjs` and `tools/build.cjs` refuse to write private outputs inside the repository anywhere except the ignored `private/` (and `dist/` for builds). An `--empty` build that embeds `private/household-profile.json` counts as private.
- Private builds and downloads contain financial data: don't email, upload or publish them.

## Tests

```sh
npm test                                    # unit tests for the engine, importer and tools (node:test)
node tools/build.cjs --sample && node tests/browser/run.cjs   # real-browser checks (needs Playwright)
node tools/check-privacy.cjs                # privacy scan
```

The browser checks run in Chromium through Playwright at 1366px and 390px widths, against the sample build. If Playwright is missing: `npm install --no-save playwright && npx playwright install chromium`.

## Project layout

```
src/engine/     pure calculation modules (ledger, comparisons, review queues, importer, pay schedules, plan, debts, forecast, saved state)
src/ui/         hash router, components, shared helpers, one file per view, app bootstrap
src/styles/     design tokens (light and dark) and per-view styles
tools/          build, import, sample generator, privacy check
fixtures/       the fictional sample: raw CSV exports, rules, profile and the imported dataset
tests/          unit tests (tests/unit) and Playwright browser checks (tests/browser)
docs/           architecture, data formats and module contracts
private/        your data (git-ignored)
```

## Limitations

- No live bank connection and no balance syncing. Balances come only from what you type in.
- No tax, retirement or investment modelling, and no interest accrual beyond labelled illustrations.
- Holidays are not modelled when counting paydays.
- A closed account keeps later months marked partial until its coverage is edited.
- Saved changes live in one browser; sharing is manual through workbook files.
