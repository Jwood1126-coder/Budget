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
5. Optional: add the balances your statements show, so the app knows real balances without typing them in. In `private/import.json` add a `balances` list, one entry per account and date, each the balance at the end of that day: `{ "accountId": "joint-checking", "date": "2026-09-30", "amount": "4,250.00", "note": "September statement" }` (or `"cents": 425000`). Exports with a Balance column add the bank's running balance at their last covered day by themselves; a statement balance for the same day wins.
6. Run `node tools/import.cjs` again. It writes `private/budget-data.json` and a readable `private/import-report.md`. The report covers rows read and skipped (with reasons), duplicates removed from overlapping exports, coverage by account and month, spending per month, the balances embedded in the data, and items to review.
7. To check a total against one you already have, run `node tools/import.cjs --period 2026-07-01..2026-09-30`. It prints that period's breakdown: purchases, refunds, card payments and transfers that were excluded, debt payments, and pending reimbursement or business candidates. The app's **Review → Reconcile** does the same on screen.

The importer recognises common US export layouts: signed amount, debit/credit columns, and card exports with transaction and posted dates. It infers card sign conventions, skips pending rows, and de-duplicates overlapping files without dropping genuine same-day repeats. It never infers what was inside an Amazon, Costco or Target order from the merchant name. Bank categories are kept alongside the household categories.

### 2. Describe your household

Copy `fixtures/sample-profile.json` to `private/household-profile.json` and edit it: names, income streams, bills, debts, savings goals and starting scenarios. Leave anything you don't know as `null`. Unknown values stay visibly unknown in the app and are never treated as $0. An optional `planUi` section sets plan-screen settings too (the spending dials, how many months the baselines average, category groupings).

This profile is the household's setup file, and it can keep changing after the budget is in use. **[docs/SETUP.md](docs/SETUP.md)** describes its format with examples (people, pay, bills, category budgets, savings goals, planned changes and what-ifs, plan settings, investment accounts in the import config), how its changes merge into a saved budget, and the tune loop for the household's assistant: edit the setup file → `npm run report` → build → deploy. When you edit it and rebuild, a browser that already saved a budget picks up the changes the next time the page opens: each setting the household left alone takes the new value, and anything they changed in the app stays theirs (as do bills, goals and other items they added or removed there). The page says what it updated and what it kept, for example "Your setup file updated 5 settings (Dining & takeout target, …); kept 2 you changed here (…)." A value in the profile that is not valid is not applied, and the page names it.

### 3. Check the plan (optional)

```sh
npm run report                 # private/plan-report.md and .json: headline, dials, month by month, what-ifs, goals, investments, and what to check
node tools/plan-report.cjs --workbook private/my-workbook.json   # include the changes made in the app (Data & privacy → Export workbook)
npm run report:sample          # the same report for the fictional sample, printed
```

The report is private: it is written only to `private/` (or outside the repository).

### 4. Build your private copy

```sh
node tools/build.cjs          # uses private/ when present; prints a PRIVATE BUILD warning
```

Open `dist/index.html`. It contains your transactions and profile, so keep it on your own devices and never commit or upload it.

**Adding newer exports later:** download the new period (overlapping the old one is fine) and either add the file to `private/import.json` and re-run the import, or load it in the browser (below). Rows you already have are recognised and counted once, and every transaction keeps its id, so your corrections keep applying.

**Alternative without the command line:** open any build, go to **Data & privacy** and load CSV exports, a prepared `budget-data.json`, or a profile JSON. Nothing is uploaded; the files are read and stored in that browser only.

- Once your own data is loaded, newer CSV exports are **added** to it: you first see a summary such as "312 new, 48 already present, coverage now to Oct 31, 2026", then choose **Add to my data** or Cancel. **Replace instead…** (after a confirmation) uses only the new files. On the built-in sample, loading exports replaces it by default.
- A small `balances.csv` with the columns `account,date,balance` (account name or id, the balance at the end of that date) adds statement balances the same way.
- **Download data file (JSON)** saves the data the page uses, including everything added in the browser and its balances. Load it on another device with "Choose a data file"; a workbook from the same budget then finds every correction again. The file holds your transactions: keep it private.

### Upgrading from the first version

- A `data/budget-data.json` in the earlier format still works. The build uses it when `private/budget-data.json` does not exist, and it is converted on load.
- A budget saved in the browser by the earlier version is migrated automatically the first time you open the new private build in the same browser. Every saved value is either carried over or listed in **Data & privacy → Upgrade notes**. The earlier entry is left untouched, and you can download a pre-upgrade backup.
- HTML copies downloaded from the earlier version can be imported in **Data & privacy → Import a workbook**.

## Finding your way around

Start on the **Overview**: where you are and where you are heading, on one page, without any setup beyond your bank exports. Changing the plan happens in one place, **Edit plan**. The other views are there when you want detail; nothing in them needs regular attention. The sidebar on computers and the bottom tab bar on phones list **Overview**, **Edit plan** and **Transactions**, then Spending and Data & privacy (under More on phones, where **Data & privacy** is also in the top bar). Every view and every drilldown level has its own address, so the browser's Back and Forward buttons, bookmarks and reloads all work.

| View | What it answers |
| --- | --- |
| **Overview** | **Balances** first: your checking and your savings, each on its own with the date its balance is from and where it comes from ("as of Sep 30, 2026 · from your statement"; an older balance is never called today), then the combined total. A different balance can be entered under **Change a balance** (and taken back to the bank's figure). Then the month on the plan in three numbers: **income**, **outgoing** (spending, bills, debt and investing; moving money to savings is not outgoing) and the **margin** between them, with how much of it goes to savings — a monthly estimate. Then one chart in two panels on the same months: the **balances** at the end of each month (checking, savings and the combined cash) and, under it, **money in and out each month** (income, outgoing and the net moved to savings). Solid is what happened; dashed is the plan's monthly estimate. Markers above the balances name the changes in the plan and the month each savings goal is reached; if the plan takes your cash below $0, a warning says when (and a checking account going below $0 is called out even when the total stays above it). Look back 6 months, 12 months or everything and ahead 6 months to 5 years; **Show as a table** under each panel; **Export CSV** saves the plan's settings and one row per month shown. **Select a month** (click or tap it, or use the arrow keys and Enter) — or one of the three numbers — to see that month's breakdown: money in by person and outgoing by group, each group opening into its categories (what was spent, for past months, with a link to its places and transactions in Spending; what the plan sets, for plan months, and what has been spent so far this month). Last, **Coming up**: the next few planned changes, bills, pay changes and goals, short; you change them in Edit plan. |
| **Spending** | Drill down month → category → merchant → transaction, with breadcrumbs, search (including by amount) and filters. Each category shows this month, its usual monthly average over the previous 3, 6 or 12 *full* months (never including the month itself), and the dollar and percentage difference with a plain-language explanation. Every total links to the transactions that make it up. |
| **Edit plan** | The one place to change the plan. **Money in and out, a month**: money into joint per partner, and money out by how adjustable it is: **essentials** (the part that doesn't move much), **flexible spending** (where the budget can realistically move), **irregular costs** (one-time things that still happen every year, spread per month), net to savings, investing (when you invest) and debt & business. Each has a slider, an exact amount, one short line with its baseline and basis, and **Reset**; **Reset all to baseline** puts every one back. The ⓘ beside each says what it is and where its baseline comes from. Essentials and flexible open into their categories and regular places, each marked as a bill, everyday or occasional and as paid by card or from the bank: untick a streaming service, change dining from its average to $200 (that is the category's amount in the plan), or move a category or a single place to the other group. Irregular costs open into the one-time costs behind them: untick one you don't expect again, or count it as regular spending in its category. Any place, "everything else" in a category or one-time cost opens into the transactions behind it (date, the bank's own text, account and amount, newest first), each with its category right there to change and a link to its details; a place's row can put every transaction from that place in another category at once. These are the same corrections as in Transactions: your bank data is not changed, and each one can be undone. **Who paid in** lists the deposits behind money in. **Planned changes**: each change with its amount, month and whether it is in the plan (the baby costs and other groups fold into one row with one box to accept them all), what your bills, pay and goals add, and **+ Custom change**. **Savings goals**: each goal's progress, the month the plan reaches it and its monthly amount. **Pay, bills and debts**, folded by area. **Settings**: how many months the baselines average and whether a checking shortfall is covered from savings. Every change can be undone. **Baby costs** are baked in as editable estimates (setup once the month before the birth, supplies each month, childcare from about six weeks after, with its yearly fee), timed from the due date in the setup details; medical costs, insurance changes and parental-leave income are listed as not included yet, never as $0. |
| **Review** | Uncertain categories, mixed-retailer purchases (with optional splits), possible duplicates, unmatched transfers, reimbursement and business candidates, unusual spikes, account coverage, a corrections log, and reconciliation against a reference total. Every correction needs a reason, keeps the bank's original category, and can be undone or reverted. |
| **Data & privacy** | Load files, export or import a workbook, export corrected transactions, upgrade notes, reset, and an explanation of where your data is stored. |

## How the numbers work

- **Counted once.** Spending is purchases and bills net of refunds. Paying a credit card in full, moving money between your own accounts and saving are never spending. A partner's transfer into joint is joint income, but in the whole-household view it is not extra income on top of their pay. Debt payments for purchases that are not in your data, such as a store-card financing payment, are shown separately.
- **The plan is one sum.** Each month on the plan, your money in all joint accounts changes by money into joint (each partner, plus other money) − essentials − flexible spending − irregular costs − investing − debt and business; moves to and from savings stay inside your accounts. What is left in checking is that, minus net to savings. Money into joint starts from the pay saved in Edit plan (or, without it, what each partner actually paid in, marked not confirmed). Essentials, flexible and irregular together are exactly your card purchases plus the spending paid straight from checking (mortgage included): paying the card from checking settles those purchases, so it is not counted a second time. A category counts as essential when the category list says so (groceries, housing, utilities, insurance…); you can move any category, or one place, to the other group. Transfers between your own accounts are not money in or spending; savings, investments and debt payments each have their own dial. Each dial starts from a baseline you can see: the average of your last 3, 6 or 12 complete months (or all of them), with yearly bills spread over 12 months and regular bills whose amount barely changes at their latest amount. One-time costs (a purchase of $500 or more with no similar one from the same place and none about a year apart, or one you marked yourself) are not dropped: they make up the irregular dial, their total over the baseline months spread per month. Leaving one out there, or counting it as regular spending, changes only the plan; every actual month keeps it. A negative net to savings is a drawdown: it adds to what is left in checking. Planned changes you accept are added in their months on top of the dials. Nothing on the page is a safe-to-spend amount.
- **Balances come from your transactions, then the plan.** Each account's month-end balance is worked back and forward from a known balance (the bank's running balance or a statement balance in your data, or an amount and date you enter; a balance you enter is used when it is dated later than the bank's); after the last known day, each plan month adds that month's net. Nothing is floored at $0: a plan that spends more than comes in goes below $0 on the chart, and the page names the month. With “cover from savings” on, a projected checking shortfall is moved from savings in the account lines; the combined line is the same either way. An account without a known balance is left out of the combined line, never counted as $0. Without any known balance the chart shows money in and out each month and asks for today's balances; an amount typed without a date counts as of today.
- **Whose money is each deposit.** Deposits into joint are matched to a partner by your import rules, by the pay saved in Edit plan (whose paycheck is deposited, who sends transfers) or by amount. Anything nobody can place stays in **other money in**, never added to anyone's pay. The original bank description is always kept.
- **Unknown is not zero.** Blank amounts are listed as missing and left out of totals, never treated as $0. When income is unknown, "what remains" says so instead of showing a number.
- **Usual spending is history, not a target.** Averages use only months with full coverage from every spending account. Partial months are excluded rather than counted as $0. A month with no activity in a category counts as $0, and a zero or refund-heavy baseline gives no percentage. A category is marked higher or lower only when it differs by at least $100 *and* 25%. Heating and cooling are compared with the same month last year. Once-a-year bills are labelled irregular instead of being flagged every month.
- **Unusual one-offs stay in actual spending.** Review lets you leave a spike, such as a dental episode, out of the *planning baseline* used to suggest targets. Actual totals never change.
- **Personal money is counted once.** Each person's personal share of a paycheck (take-home minus what reaches joint) first pays their personal bills and any transfer to joint. In the whole-household view the rest is personal spending: your personal-spending estimate if you enter one (anything above it stays in that person's account and counts toward what remains), otherwise all of it is assumed spent and the page says so.
- **Reimbursement and business candidates are counted until you decide.** Confirming a reimbursement removes the charge and the matching deposit together. A partial repayment removes only the repaid part. The Spending view's what-if switches preview leaving pending candidates out, in Spending only; other views always show actual totals.
- **Pay timing.** Edit plan shows a typical month (two biweekly checks) or the annual average. The forecast counts actual paydays when a pay date is known. An unconfirmed frequency is shown as a labelled assumption, with what each possible frequency would mean.
- **Debts.** Balances, rates and terms are shown as entered, with their status (approximate, as displayed, confirmed). No payoff date is calculated. "At least N payments" is a 0%-interest floor. Rate-based illustrations appear only when you enter a rate, and are labelled illustrative. A promotional-financing check needs the promotional balance and end month before it says anything about the payment.
- **Forecasts start from your budget.** The cash balance is only used if you enter one, and it applies from the month after its date. Investment return is 0% unless you set a hypothetical rate (then labelled illustrative).

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
npm run test:browser                        # real-browser checks (needs Playwright)
npm run lint                                # ESLint: undefined names and unused variables (eslint.config.js)
node tools/check-privacy.cjs                # privacy scan
```

The browser checks run in Chromium through Playwright at 1366px and 390px widths, against the sample build. `npm run test:browser` builds the sample to `dist/test/index.html` and tests that file, so it never overwrites the copy you open at `dist/index.html`; `node tests/browser/run.cjs budget` runs one spec file (or the tests whose name contains the text), and `BUDGET_DIST=path/to/index.html` tests another sample build. If Playwright is missing: `npm install --no-save playwright && npx playwright install chromium`.

`npm run lint` fetches ESLint 9 through `npx` on first use (nothing is added to `package.json`); it checks only for undefined names and unused variables.

## Project layout

```
src/engine/     pure calculation modules (ledger, comparisons, review queues, importer, pay schedules, plan, debts, forecast, saved state)
src/ui/         hash router, components, shared helpers, one file per view, app bootstrap
src/styles/     design tokens (light and dark) and per-view styles
tools/          build, import, plan report, sample generator, privacy check
fixtures/       the fictional sample: raw CSV exports, rules, profile and the imported dataset
tests/          unit tests (tests/unit) and Playwright browser checks (tests/browser)
docs/           architecture, data formats and module contracts; SETUP.md: the setup file and the tune loop
private/        your data (git-ignored)
```

## Limitations

- No live bank connection and no balance syncing. Balances come only from what you type in.
- No tax, retirement or investment modelling, and no interest accrual beyond labelled illustrations.
- Holidays are not modelled when counting paydays.
- A closed account keeps later months marked partial until its coverage is edited.
- Saved changes live in one browser; sharing is manual through workbook files.
