# Sample household specification (entirely fictional)

The committed sample exercises every feature without containing any real person's data.
`tools/build-sample.cjs` generates raw bank-style CSV exports from this spec with a seeded
pseudo-random generator, then runs the real importer over them to produce
`fixtures/sample-data.json`. `fixtures/sample-profile.json` describes the same household's plan.
Both must stay consistent with this document.

## People and accounts

- People: `p1` **Alex**, `p2` **Sam**. Household name: "Alex & Sam (sample)".
- Accounts (all `scope: 'joint'`):
  - `joint-checking` "Joint checking" — `type: 'checking'`
  - `joint-card` "Joint rewards card" — `type: 'credit_card'`, `paidInFull: true`
  - `joint-savings` "Joint savings" — `type: 'savings'`
  - `joint-brokerage` "Sample brokerage" — `type: 'investment'`, **balance-only**: no export, only three
    invented statement balances in the import config (`balances`): **$12,480.00** on 2026-03-31,
    **$13,105.50** on 2026-06-30, **$14,020.25** on 2026-09-30. Never counted as cash; the plan draws it
    as the investments line.
- Personal accounts are **not** in the data (their flows are modelled in the plan only).

## Export files (fixtures/sample-raw/)

| File | Account | Covers | Header format |
| --- | --- | --- | --- |
| `checking-2024-10-to-2025-12.csv` | joint-checking | 2024-10-01 – 2025-12-31 | `Date,Description,Amount,Balance` (MM/DD/YYYY, signed: debits negative) |
| `checking-2025-11-to-2026-09.csv` | joint-checking | 2025-11-01 – 2026-09-30 | same; **overlaps Nov–Dec 2025** (identical rows → de-duplicated) |
| `card-2025-01-to-2026-09.csv` | joint-card | 2025-01-01 – 2026-09-30 | `Transaction Date,Posted Date,Description,Category,Debit,Credit` (MM/DD/YYYY; Debit = charge, Credit = payment/refund) |
| `savings-2025-06-to-2026-09.csv` | joint-savings | 2025-06-01 – 2026-09-30 | `Posting Date,Description,Amount` (YYYY-MM-DD, signed) |

Consequences: Oct–Dec 2024 are **partial** months for spending (no card coverage); 2025-01 onward
are full. Savings coverage does not affect spending completeness.

## Income into the joint account

- **Alex paycheck**: biweekly Fridays, anchor payday **2024-10-04**. Net take-home **$2,240.00** per
  check; **$360.00** goes to Alex's personal account by direct-deposit split; **$1,880.00** lands in
  joint checking as `SAMPLE EMPLOYER PAYROLL DIR DEP`. (Three-paycheck months occur.)
- **Sam contribution**: `ONLINE TRANSFER FROM SAM PERSONAL CHK` **$1,325.00** on the 1st and 15th of
  each month (moved to the previous Friday when the date falls on a weekend). Sam's full take-home
  pay is **unknown**; the contribution is not full income.
- Savings interest: `INTEREST PAID` on the last day of each month on joint-savings, $1.10–$6.00.

## Joint-checking outflows

| Description | Amount | Timing | Classification |
| --- | --- | --- | --- |
| `SAMPLE MORTGAGE SERVICER PMT` | $1,412.56 | 1st | spend · Mortgage (escrow unknown) |
| `SAMPLE GAS UTILITY` | seasonal: Jan 212, Feb 188, Mar 151, Apr 96, May 57, Jun 38, Jul 34, Aug 33, Sep 41, Oct 72, Nov 128, Dec 183 (± up to $9) | ~20th | spend · Gas & heating |
| `SAMPLE ELECTRIC CO` | Jan 96, Feb 91, Mar 86, Apr 81, May 92, Jun 126, Jul 151, Aug 147, Sep 112, Oct 86, Nov 89, Dec 99 (± up to $7) | ~18th | spend · Electric |
| `SAMPLE CITY WATER SEWER` | ~$165 (± $12) | quarterly: Jan, Apr, Jul, Oct ~10th | spend · Water & sewer |
| `SAMPLE INTERNET CO` | $75.00 | 12th | spend · Internet & phone |
| `SAMPLE WIRELESS` | $92.40 | 22nd | spend · Internet & phone |
| `SAMPLE HOME INSURANCE` | $1,104.00 | once a year, 2025-03-15 and 2026-03-15 | spend · Home insurance |
| `SAMPLE STORE CARD PAYMENT` | $55.00 | 9th | debt_payment · store_card (sample rule) |
| `SAMPLE BANK CARD AUTOPAY` | the card's previous statement net charges | 25th, from 2025-02 | card_payment (paired with card-side credit) |
| `TRANSFER TO SAVINGS` | $250.00 | 2nd, from 2025-06 | transfer · savings (paired with savings-side `TRANSFER FROM CHECKING`) |
| `TRANSFER TO SAMPLE BROKERAGE` | $200.00 | 5th, Apr–Sep 2026 | transfer · investment (sample transfer hint; the brokerage side is not exported, so it stays unpaired, as expected) |
| `ZELLE PAYMENT TO J SMITH` | $80.00 | 2026-04-18 | spend · Uncategorized (purpose unknown, needs review) |

Other checking inflows: `ONLINE TRANSFER FROM CHK 4821` **$500.00** on 2026-05-11 (an **unpaired**
inbound transfer that needs review), and `MOBILE DEPOSIT` **$486.60** on 2026-08-21 (matches an airline
charge → reimbursement candidate).

## Joint-card activity (purchases are the spending; card is paid in full)

| Merchant text | Bank category | Pattern |
| --- | --- | --- |
| `KROGER #0412`, `ALDI 77`  | Groceries | ~weekly, $85–$190 |
| `AMAZON MKTPL*` + 6 chars | Shopping | 3–5 a month, $14–$120; 1 refund (credit) every ~3 months |
| `COSTCO WHSE #0123` | Shopping | 2 a month, $140–$260 |
| `COSTCO GAS #0123` | Gas | 1 a month, $38–$55 |
| `TARGET 00012345` | Shopping | 1–2 a month, $35–$110 |
| `SHELL OIL 57441` | Gas | 2 a month, $32–$52 |
| `CHIPOTLE 1834`, `PANERA BREAD #602`, `SAMPLE PIZZA CO` | Food & Drink | 6–10 a month, $11–$68 |
| `NETFLIX.COM` | Entertainment | $15.49 monthly |
| `SPOTIFY USA` | Entertainment | $11.99 monthly |
| `CHEWY.COM` | Shopping | ~$48 monthly |
| `THE HOME DEPOT #3812`, `LOWES #01944` | Home | 1–2 a month, $22–$185 (sample rule flags `business_candidate`) |
| `CVS/PHARMACY #4410` | Health & Wellness | every ~2 months, $9–$42 |
| `BRIGHT SMILE DENTAL` | Health & Wellness | routine $45 in Feb and Aug |
| `SAMPLE AIRLINES` | Travel | $486.60 on 2026-07-08 (later matched by the mobile deposit) |
| `ANNUAL MEMBERSHIP FEE` | Fees & Adjustments | $95.00 every January |
| `AUTOMATIC PAYMENT - THANK YOU` | (blank) | Credit equal to the checking autopay, same day |

December has extra gift spending (`AMAZON MKTPL*`, `TARGET`), roughly +$350.

**Unusual dental episode (August 2026):** `BRIGHT SMILE DENTAL` $860.00 (2026-08-04),
`SAMPLE ENDODONTICS` $715.40 (2026-08-11), `SAMPLE ENDODONTICS` $412.30 (2026-08-25). Total $1,987.70.
It stays in actual spending; the user may exclude it from the planning baseline.

**Near-duplicate:** `TARGET 00012345` $64.18 posted 2026-03-14 and again 2026-03-15 (a duplicate
candidate for review; never removed automatically).

## Joint savings

- `TRANSFER FROM CHECKING` $250.00 on the 2nd (from 2025-06), paired with checking.
- `INTEREST PAID` monthly.
- Starting balances are **not** in the exports.

## Plan facts (for fixtures/sample-profile.json)

- Alex paycheck stream: `netPerPaycheckCents 224000`, `jointPerPaycheckCents 188000`, biweekly,
  `frequencyStatus 'confirmed'`, anchor `2024-10-04`.
- Sam paycheck stream: net **unknown** (`null`), joint `null`, frequency `unknown`.
- Sam contribution stream: `kind 'contribution'`, `jointPerPaycheckCents 132500`, frequency
  `semimonthly` with `frequencyStatus 'observed'` (two transfers a month observed), days [1, 15].
- Bills: Mortgage $1,412.56 joint (escrow unknown); Internet $75 + wireless $92.40 joint; Home
  insurance $92.00/month equivalent (annual $1,104) joint; Store card $55 joint (debt);
  Alex car $245 funded `p1`; Alex student loans $289.50 funded `p1`; Sam car $372 funded
  `unknown`; Life insurance $40 `planned` (illustrative only).
- Debts: Mortgage ~$148,000 approximate, APR unknown, escrow unknown; Alex car ~$5,900;
  Alex student loans $14,212.80 across 6 loans, displayed APRs 3.73%–6.28%, repayment plan
  unknown; Sam car ~$24,800; Store card statement balance $1,980.35 for the whole card, promo
  balance/expiry unverified, payment is minimum + $25 (currently $55).
- Goals: Emergency cushion (target $15,000, saved unknown, $150/mo, keep); Anniversary trip
  ($2,400 by 2027-09, saved $0, $200/mo, spend at target); Home projects fund (target unknown,
  $100/mo, keep).
- Baby due **2027-05** (sample). Childcare start and cost unknown. Parental-leave pay unknown.
- Home projects being considered: attic insulation, window replacement, electrical panel —
  quotes not yet received (amounts blank).
- Joint cash balance unknown.
