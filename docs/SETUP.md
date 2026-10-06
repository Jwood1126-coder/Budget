# The setup file: a guide for the household's assistant

The household does very little entry in the app. Their assistant keeps two private files up to
date, rebuilds the page, and checks the result with a plan report:

| File (all in the git-ignored `private/` folder) | What it holds |
| --- | --- |
| `private/household-profile.json` | **The setup file**: people, pay, bills, category budgets, savings goals, debts, planned changes and what-ifs, and plan settings (`planUi`). |
| `private/import.json` | The import config: accounts (including balance-only investment accounts and whose they are), the export files, and statement balances. |
| `private/rules.json` | Optional household rules for the importer (format: [ARCHITECTURE.md](ARCHITECTURE.md), "Rules format"). |

Every example below is **invented** (the fictional "Alex & Sam" household of the sample). Never
copy real names, employers, amounts or account numbers into this repository: they belong in
`private/` only. The full contract for each field is in [ARCHITECTURE.md](ARCHITECTURE.md) (§3
household profile, §5 plan, §7 saved state).

Rules that hold everywhere:

- Money is **integer cents** (`$1,325.00` is `132500`). `null` means **unknown**, never $0: an
  unknown amount is listed in the app and in the report's "To check", and is never counted.
- Months are `"YYYY-MM"`, dates `"YYYY-MM-DD"`.
- Every list item has a stable `id` (letters, digits, `-`). Setup sync follows items by id, so
  **never reuse or rename an id**: give a new item a new id.
- A value the app cannot use is not applied; the page and the report name it, and what was there
  stays.

## 1. The setup file (`private/household-profile.json`)

Start from `fixtures/sample-profile.json` (a complete fictional example) and edit it.

```json
{
  "schemaVersion": 1,
  "household": { "name": "Alex & Sam", "people": [{ "id": "p1", "name": "Alex" }, { "id": "p2", "name": "Sam" }] },
  "plan": {
    "people": [{ "id": "p1", "name": "Alex" }, { "id": "p2", "name": "Sam" }],
    "incomes": [],
    "bills": [],
    "debts": [],
    "targets": {},
    "savings": [],
    "personalSpending": [],
    "balances": {},
    "settings": { "incomeTiming": "conservative", "planningBaseline": "actual", "comparisonWindow": 3 },
    "changes": []
  },
  "planUi": {},
  "scenarios": [],
  "notes": ["Why each deliberate unknown is unknown."]
}
```

Add `isSynthetic` set to the boolean `false` at the top (next to `schemaVersion`): it marks the file as
real household data, and the privacy check then blocks it from any commit. The people are always
`p1` and `p2`.

### People

`plan.people` (or `household.people`) gives the names the app shows. Only the `name` is used.

### Incomes (`plan.incomes`)

One stream per paycheck or regular transfer **into the joint accounts**:

```json
{ "id": "p1-pay", "label": "Alex paycheck", "personId": "p1", "kind": "paycheck",
  "netPerPaycheckCents": 224000, "jointPerPaycheckCents": 188000,
  "frequency": "biweekly", "frequencyStatus": "confirmed", "anchorDate": "2026-09-25",
  "status": "confirmed", "startMonth": null, "endMonth": null, "note": "" }
```

```json
{ "id": "p2-contribution", "label": "Sam to joint", "personId": "p2", "kind": "contribution",
  "netPerPaycheckCents": null, "jointPerPaycheckCents": 132500,
  "frequency": "semimonthly", "frequencyStatus": "confirmed", "semimonthlyDays": [1, 15],
  "status": "confirmed", "startMonth": null, "endMonth": null, "note": "Transfer from Sam's personal account." }
```

- `kind`: `paycheck` (pay deposited, possibly split), `contribution` (a transfer from that
  person's personal account) or `other`.
- `jointPerPaycheckCents` is what reaches joint each time; that is what the plan's money-in dial
  uses. `netPerPaycheckCents` is the whole take-home (reference; personal share = net − joint).
- `frequency`: `weekly`, `biweekly` (needs `anchorDate`, one real payday), `semimonthly`
  (`semimonthlyDays`, 31 = last day), `monthly` (`monthlyDay`) or `unknown`
  (`assumedPerMonthIfUnknown`, default 2, shown as an assumption).
- `status` / `frequencyStatus`: `confirmed`, `observed`, `estimate` or `unknown`. Anything not
  `confirmed` is listed under "To check". When no stream gives a person's joint amount, the
  plan uses the average of their deposits and marks it "not a confirmed setting".
- `startMonth` / `endMonth`: a stream that starts or ends (a new job, a leave).

### Bills (`plan.bills`)

```json
{ "id": "childcare-center", "label": "Childcare center", "category": "Baby & childcare",
  "monthlyCents": 120000, "fundedFrom": "joint", "type": "other", "debtId": null,
  "status": "planned", "startMonth": "2027-09", "endMonth": null, "note": "Quote from a (fictional) center." }
```

- `fundedFrom`: `joint`, `p1`, `p2` or `unknown`. **Only joint-paid bills touch the plan**;
  personal ones are listed, never on the joint plan.
- `type`: `housing`, `debt`, `insurance`, `utility`, `subscription` or `other`. A `debt` bill is a
  debt payment (no `category`; link it with `debtId`).
- `status`: `existing`, `planned` (not paid yet) or `estimate`.
- How the plan uses a joint bill with an amount (the report's "Bills" table says which applied):
  - **seen**: the baseline months already hold a payment in its category (any debt payment for a
    debt bill), so the dials count it. With an `endMonth`, the plan takes the amount back out
    from the month after it ("Car loan ends"). A current debt bill counts at its own amount when
    the history's average is less (a loan that started a few months ago is diluted over the
    window): Debt & business plans debt payments at the larger of the two, never both.
  - **added**: not in the history (or `status: "planned"`, or `startMonth` after the plan
    start): added from `startMonth` (or the plan start) through `endMonth`, to Essentials (debt
    bills to Debt & business).
  - left alone: no amount (`noAmount`), no category on a non-debt bill (`noCategory`: it could be
    counted twice), its category has a budget in `targets` (`inBudget`: the budget plans that
    category), already ended (`ended`), or not joint (`notJoint`).

### Category budgets (`plan.targets`)

```json
"targets": { "Groceries": 65000, "Dining & takeout": 30000, "Clothing": null }
```

A number is that category's monthly budget: the plan uses it for the category, and Edit plan
shows it on the category's row. `null` means "not set" (the plan uses the category's history). A budget
for a category with no history adds a row of its own. Category names come from the app's
category list (`src/engine/categories.js`); an imported name that stands for one of them
("Natural gas", "Groceries & meal kits") is planned like it (Essentials or Flexible). A combined
budget the app knows ("Energy (gas + electric, migrated)", from the earlier version) is counted
once for its categories: their rows plan at $0 under it. To split it, give the parts their own
budgets (each comes out of the combined one) and then remove it.

### Savings goals (`plan.savings`)

```json
[
  { "id": "cushion", "label": "Emergency cushion", "targetCents": 1500000, "targetMonth": null,
    "savedCents": 400000, "monthlyCents": 15000, "spendAtTarget": false, "note": "Kept, not spent." },
  { "id": "trip", "label": "Anniversary trip", "targetCents": 240000, "targetMonth": "2027-09",
    "savedCents": 0, "monthlyCents": 20000, "spendAtTarget": true, "note": "Spent on the trip." }
]
```

- When any goal has a `monthlyCents`, **net to savings** on the plan starts from the goals'
  monthly amounts added up (unless the household sets the savings dial in the app).
- Goals are reached in list order on the projected savings balance (goal 2 when savings reach
  goal 1's target + goal 2's target); the report gives each one's month.
- `spendAtTarget: true` with a `targetMonth`: in that month the target leaves savings and is
  spent ("Trip: spent from savings"), and from the month after, its `monthlyCents` is no longer
  saved ("Trip: monthly saving stops"). Both show among the planned changes, read-only.

### Debts (`plan.debts`) and personal spending

Debts are facts (balance, rate, promo); their payments are bills (`type: "debt"`, `debtId`).
`personalSpending` (`[{ "personId": "p1", "monthlyCents": null, "note": "" }]`) is not part of setup
sync; leave it to the household or the defaults.

### Planned changes and what-ifs (`plan.changes`)

Dated one-time or monthly changes on top of the plan:

```json
[
  { "id": "roof", "label": "Roof repair", "kind": "oneTime", "group": "irregular",
    "startMonth": "2027-04", "cents": 650000, "accepted": true, "note": "Two (fictional) quotes." },
  { "id": "gym-ends", "label": "Gym membership ends", "kind": "monthly", "group": "flexible",
    "startMonth": "2026-12", "endMonth": null, "cents": -4500, "accepted": true },
  { "id": "move-rent", "label": "Rent after the move", "kind": "monthly", "group": "essentials",
    "startMonth": "2027-06", "endMonth": null, "cents": 210000, "accepted": false, "scenario": "Move to the coast" },
  { "id": "move-pay", "label": "Sam: new job", "kind": "monthly", "group": "income", "personId": "p2",
    "startMonth": "2027-06", "cents": 30000, "accepted": false, "scenario": "Move to the coast" }
]
```

- `kind`: `oneTime` (`startMonth` only) or `monthly` (`startMonth` through `endMonth`; `null` =
  open-ended).
- `group`: `income` (with `personId` p1/p2, or none for "other money in"), `essentials`,
  `flexible`, `irregular` or `savings`. Amounts are signed: a drop in income or a saving is negative.
- `cents: null` = amount not known yet: listed and reported, never applied.
- `accepted: true` applies it to the plan; `false` lists it only.
- **What-ifs**: give related changes the same `scenario` name (≤ 60 characters) and leave them
  `accepted: false`. Edit plan lists them as one folded row with one box to accept them all, and the report's
  "What-ifs" table shows where combined cash would be in 12 months with them. **Write what-ifs
  this way, directly as `plan.changes` with a scenario name**, not as `scenarios` (the earlier
  Forecast format): profile `scenarios` are copied into `plan.changes` only when a budget is
  created (and once for a budget saved before), so later edits to them never reach a saved
  budget, while `plan.changes` stay in sync. Never list the same change in both.
- **Packs** (generic placeholder estimates, to adjust): new baby (first year), childcare, kid
  costs from age 1. Generate the items with the app's own templates and paste them in, each with
  an id of your own:

  ```sh
  node -e "const E=require('./tests/load-engine.cjs').loadEngine(); \
    const items=E.timeline.templates.babyFirstYear('2027-05-15',{scenario:'New baby'}) \
      .concat(E.timeline.templates.childcare('2027-09',110000,{scenario:'New baby'})); \
    console.log(JSON.stringify(items.map((c,i)=>Object.assign({id:'baby-'+(i+1)},c)),null,2))"
  ```

  (`kidCosts('2027-05-15')` gives the costs from age 1.) Items keep their `template` tag; edit
  amounts, then set `accepted` when the household decides.

### The baby's due date (`plan.settings.babyDueDate`)

Optional: `"settings": { …, "babyDueDate": "2027-05-14" }` (`YYYY-MM-DD`; leave it out or `null`
when not known). It times the baby-cost defaults the app adds by itself (ARCHITECTURE.md §8,
`BudgetEngine.babyDefaults`), as editable estimates in one baby group (the what-if copied from a baby
scenario when there is one, else "New baby"):

- setup $2,000 once, in the month before the birth month;
- supplies $450 a month from the birth month (feeding, diapers and wipes, clothing, care, toys, a
  contingency);
- childcare $1,800 a month from the month 6 weeks after the due date (a planning allowance, not a
  booking or a confirmed rate), plus a $150 yearly membership fee in the first care month and every
  12 months after.

Medical costs, insurance premium changes and parental-leave pay stay unknown (never $0). Without a
date, a copied baby what-if's birth month gives a month-level estimate (childcare two months
after it); with neither, nothing is added until the date is known. The household can set the date
in Budget's setup details (Baby); a date saved there wins over the setup file's (the merge rule
below). A new date moves only the estimates whose start month nobody changed. Amounts, dates and
inclusion the household changes are kept, and a default they remove is not added again. Do not also
accept the New baby, Childcare or Kid costs pack for the same costs: the plan counts them once (the
defaults are held back in the months the pack runs) and the Plan says so. Childcare at $0 has no
yearly fee either.

### Balances in the plan (`plan.balances`)

Prefer statement balances in the import config (section 2). `plan.balances.accounts`
(`{ "joint-savings": 406466 }`, with `accountsAsOf` or per-account `accountDates`) is for an account
whose export has no balance; `jointCashCents`/`asOf` only when no account balance is known.

### Plan settings (`planUi`)

Optional; each field is one of the plan's own settings (ARCHITECTURE.md §7, `ui.plan`):

```json
"planUi": {
  "baselineMonths": 6,
  "coverFromSavings": true,
  "investReturnPct": null,
  "dials": { "flexible": 120000 },
  "groups": { "Pets": "essentials", "merchant:Harbor Grocer": "essentials" },
  "irregularOff": { "tx-0a1b2c3d": true },
  "rows": {}
}
```

- `baselineMonths`: 3, 6, 12 or `"all"` complete months averaged for the dial baselines.
- `coverFromSavings`: move a projected checking shortfall from savings (account lines only).
- `investReturnPct`: a yearly growth rate (0–25) for the investments line, compounded monthly and
  labelled illustrative. `null` (default) assumes none. Set it only when the household gives one.
- `dials`: amounts set directly (signed cents) for `p1`, `p2`, `inOther`, `essentials`,
  `flexible`, `irregular`, `savings`, `investing`, `other`. Prefer category budgets and goals:
  a dial set here overrides what they give (a savings dial set here also replaces the goals'
  monthly amounts).
- `groups`: move a category, or every purchase of one place (`"merchant:<place>"`), to
  `essentials` or `flexible`.
- `irregularOff`: one-time costs (by transaction id) left out of the irregular allowance (`true`).
  A purchase the household left out of planning in Transactions or Spending is out of the
  allowance already; `false` puts it back in on purpose.
- `rows`: changes to single drill-down rows (`{ "included": false }` or `{ "cents": 2500 }`). Row
  ids are in the Plan's Export CSV (`row.<id>.label`); for whole categories use `targets` instead.

## 2. The import config (`private/import.json`)

`node tools/import.cjs` writes `private/import.example.json` on its first run. Accounts and
balances:

```json
{
  "datasetId": "household",
  "accounts": [
    { "id": "joint-checking", "label": "Joint checking", "type": "checking", "scope": "joint", "ownerId": null, "paidInFull": false },
    { "id": "joint-card", "label": "Joint card", "type": "credit_card", "scope": "joint", "ownerId": null, "paidInFull": true },
    { "id": "joint-savings", "label": "Joint savings", "type": "savings", "scope": "joint", "ownerId": null, "paidInFull": false },
    { "id": "joint-brokerage", "label": "Brokerage", "type": "investment", "scope": "joint", "ownerId": null, "paidInFull": false },
    { "id": "alex-retirement", "label": "Retirement", "type": "investment", "scope": "personal", "ownerId": "p1", "paidInFull": false }
  ],
  "files": [
    { "path": "private/raw/checking.csv", "accountId": "joint-checking", "coverageStart": "2025-10-01", "coverageEnd": "2026-09-30" }
  ],
  "balances": [
    { "accountId": "joint-savings", "date": "2026-09-30", "amount": "4,064.66", "note": "September statement" },
    { "accountId": "joint-brokerage", "date": "2026-06-30", "amount": "13,105.50" },
    { "accountId": "joint-brokerage", "date": "2026-09-30", "amount": "14,020.25" },
    { "accountId": "alex-retirement", "date": "2026-09-30", "cents": 3150000 }
  ],
  "rules": "private/rules.json"
}
```

- Keep `isSynthetic` (the boolean `false`) as the example file has it.
- `type`: `checking`, `savings`, `credit_card`, `loan`, `investment` or `other`; `scope`: `joint`
  or `personal`, with `ownerId` (`p1`/`p2`) for a personal account.
- **Balance-only investment account**: an `investment` account with no files; its statement
  balances in `balances` are all the data knows of it. **Every investment account is on the
  plan's investments line**, joint or personal, labelled with whose it is ("Brokerage (joint)",
  "Retirement (Alex)"); investments are **never counted as cash**. After the last known balance
  the joint account adds each month's investing (the Investing dial: joint transfers into
  investments); personal accounts stay level unless `planUi.investReturnPct` is set.
- Joint transfers into a balance-only account are not exported on its side: add a transfer hint
  in `private/rules.json` so they count as investing, e.g.
  `{ "match": "TRANSFER TO BROKERAGE", "sign": "out", "subtype": "investment" }`.
- `balances`: the balance at the **end** of `date`, as `cents` or `amount` (`"1,234.56"`). One
  per account and date; a statement balance beats the bank's running balance on the same day.

## 3. How setup sync merges

A budget the household has already saved in their browser picks up the setup file's later
changes the next time the page opens (and when a workbook is imported). For each setting:

| The household's saved value… | Result |
| --- | --- |
| is what the setup file said last time (they left it alone) | **the setup file's new value is taken** |
| differs from what the setup file said last time (they changed it in the app) | **theirs is kept** |
| an item new in the setup file | added |
| an item they added in the app, or removed there | left as they have it |
| anything the setup file leaves out (a whole section, an item, a field, a target) or gives as `null` | **left as saved**: the setup file never erases |

**The setup file adds and changes; it never erases.** A setup file that is missing a section, an
item or a field, or says `null` (unknown) where it used to have a value, changes nothing saved
there, so a partial or half-finished file is safe to deploy. An item or target dropped from the
file stays in the budget and the page names it once ("2 entries are no longer in your setup file
and were kept here…"); only the household removes it, in the app. If the file has it again later,
its new values flow as usual.

- Managed: `plan.incomes`, `bills`, `debts`, `savings`, `changes` (by id, field by field),
  `plan.people` (names), `plan.targets` (per category), `plan.settings` and `plan.balances` (per
  field; `balances.accounts` and `balances.accountDates` per account, so a file with one
  account's balance changes that account only), and from `planUi`: `dials`, `rows`, `groups`, `irregularOff` (per key),
  `baselineMonths`, `coverFromSavings`, `investReturnPct`. Not managed: `personalSpending`,
  `scenarios`, references, transaction corrections and other screen settings.
- The first time a saved budget meets the setup file, nothing it holds changes (every difference
  counts as the household's); later edits flow from there. `planUi` values reach a setting that
  is still at its default.
- The page says what happened once: "Your setup file updated 5 settings (Dining & takeout target,
  …); kept 2 you changed here (…)." The plan report's "Setup sync" section shows the same notes
  (with a workbook).
- Running it again changes nothing; an invalid value is skipped and named, and the next corrected
  file is tried again.

So to change something the household already changed in the app, ask them (or change it in the
app); editing the setup file will not override their choice.

**Reset on the Plan screen goes back to the setup file, and keeps it linked.** A dial's Reset,
"Reset all" and an edited row's Reset put a `planUi` value the setup file supplied (a dial, a row
change, a one-time cost left out) back to the setup file's value ("Flexible spending is back to
your setup value ($1,234)."), so the next setup file's value for it flows again as if the household
had never changed it. Only what the setup file does not supply goes back to the baseline or the
history, as before. A row's Reset never changes a category budget (`plan.targets`): the row comes
back in at its budget. To move a dial off the setup value on purpose the household types an amount,
clears the box (back to the baseline) or, on a person's dial, picks "Use the N-month average";
those count as theirs and are kept.

## 4. The tune loop

1. **Edit** `private/household-profile.json` (and `private/import.json` / new exports, then
   `node tools/import.cjs`).
2. **Report**: `npm run report` (`node tools/plan-report.cjs`). It writes `private/plan-report.md`
   and `private/plan-report.json`. To include the household's own changes in the app, ask them
   for a workbook (Data & privacy → Export workbook), save it in `private/`, and run
   `node tools/plan-report.cjs --workbook private/<file>.json`. `--months 24` shows more months.
   Read the headline and work through **To check**: unknown amounts, unconfirmed income, balances
   not known or gaps assumed, thin history, changes without an amount, bills left alone and why,
   and a plan that draws savings down while all accounts lose money.
3. **Build**: `npm run build` (`node tools/build.cjs`) writes the private `dist/index.html`.
4. **Deploy**: give the household the new `dist/index.html` the way you agreed (never a public
   place). When they open it, setup sync brings the changes into their saved budget and tells
   them what changed.

`npm run report:sample` prints the same report for the fictional sample, a safe way to see the
format. The report refuses to write a private report anywhere in this repository except
`private/`; it carries a private marker the privacy check (`npm run check:privacy`) blocks from
commits.
