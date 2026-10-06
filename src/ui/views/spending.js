'use strict';
/*
 * Spending: where the money went, as a drilldown that always reconciles.
 *
 *   All months → month → category → merchant → transaction, plus period ranges, an
 *   "all transactions" list, search, and the rows that are not spending (income, transfers,
 *   debt and card payments).
 *
 * Every level is its own URL (#/spending?period=…&cat=…&merchant=…&txn=…), so browser Back walks
 * up one level at a time. Every total links to exactly the rows that add up to it, and those rows
 * are counted with the same rule as the total (spending parts from ledger.applyEdits), so a
 * merchant's footer equals that merchant's line on the category page to the cent.
 *
 * Route params (all optional): period ('YYYY-MM' | 'YYYY-MM..YYYY-MM' | 'all'), cat, merchant,
 * list ('1' = every transaction behind a total), q, txn, acct, kind (spend | income | transfer |
 * debt | card | all), window (months in the usual-spend baseline), basis ('bank' = the bank's
 * original categories), show ('excluded' = include rows that are not counted, struck through).
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc, domId } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const sh = () => UI.shared;

  const PARAM_ORDER = ['period', 'cat', 'merchant', 'list', 'q', 'txn', 'acct', 'scope', 'kind', 'window', 'basis', 'show'];
  const WINDOWS = [3, 6, 12];
  const NO_BANK = 'No bank category';

  const KIND_OPTIONS = [
    // `short` fits the Show select on a phone; `label` is used in headings and breadcrumbs.
    { value: 'spend', label: 'Spending', short: 'Spending', test: t => t.kind === 'spend' },
    // Money coming in, as the Plan page counts it: income plus partners' contributions from personal accounts.
    { value: 'income', label: 'Income & contributions', short: 'Coming in', test: t => t.kind === 'income' || (t.kind === 'transfer' && t.subtype === 'contribution') },
    { value: 'transfer', label: 'Transfers & savings', short: 'Transfers', test: t => t.kind === 'transfer' },
    { value: 'debt', label: 'Debt payments', short: 'Debts', test: t => t.kind === 'debt_payment' },
    { value: 'card', label: 'Card payments', short: 'Card bills', test: t => t.kind === 'card_payment' },
    { value: 'all', label: 'Everything', short: 'Everything', test: () => true },
  ];
  const KIND_BY = Object.fromEntries(KIND_OPTIONS.map(k => [k.value, k]));
  const KIND_PARAM = { spend: 'spend', income: 'income', transfer: 'transfer', debt_payment: 'debt', card_payment: 'card' };

  const SIGNALS = {
    higher: ['Higher than usual', 'warn'],
    lower: ['Lower than usual', 'info'],
    typical: ['Typical', 'neutral'],
    new: ['New', 'info'],
    irregular: ['Irregular', 'neutral'],
    no_history: ['No history', 'neutral'],
    limited_history: ['Limited history', 'neutral'],
    refund_baseline: ['Refunds in history', 'neutral'],
    partial_month: ['Partial month', 'neutral'],
    seasonal_higher: ['Higher than last year', 'warn'],
    seasonal_lower: ['Lower than last year', 'info'],
    seasonal_typical: ['Typical for the season', 'neutral'],
    seasonal_unknown: ['Seasonal, no last year', 'neutral'],
  };

  const EXCLUDED_TEXT = {
    duplicate: 'marked as a duplicate of another row',
    reimbursed: 'confirmed as paid back (reimbursed)',
    business: 'marked as a business cost',
    what_if: 'left out by a what-if switch (history only)',
  };
  const EXCLUDED_SHORT = { duplicate: 'duplicate', reimbursed: 'reimbursed', business: 'business', what_if: 'what-if' };

  const FLAG_TEXT = {
    mixed_retail: 'This store sells many kinds of goods, so what was bought cannot be told from the bank text. The category is a best guess; split it in Data review if you know.',
    needs_category_review: 'The import was not sure about this one. Check the category and correct it if needed.',
    reimbursement_candidate: 'Has the same amount as another transaction, so it may be a charge that was paid back (or the pay-back itself). Confirm it in Data review.',
    business_candidate: 'May be a business cost. Decide in Data review; business costs are left out of household spending.',
    duplicate_candidate: 'May be a duplicate of another row. Decide in Data review.',
    unpaired_transfer: 'No matching transaction was found on another of your accounts. Check where the money came from or went.',
    pending: 'Was still pending when the file was exported.',
    fee: 'A bank or card fee.',
    refund: 'Money returned by the merchant; it reduces spending.',
  };

  const CONFIDENCE_TEXT = {
    high: ['High', 'good', 'Matched a specific rule.'],
    medium: ['Medium', 'info', 'Matched a broad rule; worth a glance.'],
    low: ['Low', 'warn', 'A best guess; please check it.'],
  };

  const FIELD_LABEL = {
    category: 'Category', kind: 'Kind', subtype: 'Subtype', splits: 'Split', duplicate: 'Duplicate',
    reimbursement: 'Reimbursement', business: 'Business', planningBaseline: 'Planning baseline', person: 'Whose money', note: 'Note',
  };

  // ------------------------------------------------------------------ small helpers
  const money = (cents, opts) => esc(fmt.money(cents, opts));
  const sum = (rows, fn) => rows.reduce((s, t) => s + fn(t), 0);
  const count = (n, one, many) => esc(fmt.count(n, one, many));
  const lowerFirst = s => String(s).charAt(0).toLowerCase() + String(s).slice(1);
  const merchantOf = t => t.merchant || t.description || 'Unknown merchant';
  const bankCategory = t => (typeof t.sourceCategory === 'string' && t.sourceCategory.trim()) || NO_BANK;
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1);
  const describeMonths = list => E.compare.describeMonths(list);
  /** Inline column label shown only where a table is stacked on a phone (the header row is hidden there). */
  /** Share of a total as a whole percent; a small but non-zero share reads "<1%", never "0%". */
  const sharePct = (part, total) => (total > 0 ? esc(part > 0 && part * 200 < total ? '<1%' : fmt.pct((part * 100) / total, { signed: false })) : '—');
  const ML = text => `<span class="sp-ml" aria-hidden="true">${esc(text)}</span>`;
  const humanize = s => String(s || 'Unknown').replace(/_/g, ' ').replace(/^./, ch => ch.toUpperCase());

  /** Counted spending of a row, limited to one category's parts when `cat` is given. */
  function spendOf(t, cat) {
    if (t.excluded || t.kind !== 'spend') return 0;
    const parts = E.ledger.partsOf(t);
    return parts.reduce((s, p) => s + (!cat || p.category === cat ? p.spendCents : 0), 0);
  }
  /** A row belongs to a category through its spending parts (split rows land in each part). */
  function inCat(t, cat) {
    const parts = E.ledger.partsOf(t);
    return parts.length ? parts.some(p => p.category === cat) : t.category === cat;
  }

  function signalBadge(signal) {
    const s = SIGNALS[signal] || [humanize(signal), 'neutral'];
    return c.badge(s[0], s[1]);
  }

  /** Chart legend; each key stays on the same line as its label when the legend wraps. */
  function chartLegend(items) {
    return `<p class="legend-line">${items.filter(Boolean).map(([key, label]) => `<span class="sp-legend-item"><span class="key sp-key-${esc(key)}" aria-hidden="true"></span>${esc(label)}</span>`).join(' ')}</p>`;
  }
  /**
   * Column charts fit their card at every width, so every month, the axis and "Show as a table"
   * stay in view; the stylesheet enlarges the axis text on phones to keep it readable.
   */
  function chartBlock(chartHtml) {
    return `<div class="sp-chart">${chartHtml}</div>`;
  }

  function coverageOf(ctx, month) {
    return ctx.coverageMap[month] || E.ledger.coverage(ctx.dataset, month);
  }
  function coverageBadge(cov) {
    if (!cov || cov.status === 'none') return c.badge('No data', 'neutral');
    if (cov.status === 'full') return c.badge('Complete', 'good');
    return c.badge('Partial', 'warn');
  }

  // ------------------------------------------------------------------ route params
  function readParams(ctx) {
    const raw = (ctx.route && ctx.route.params) || {};
    const notes = [];
    const setting = ctx.state.plan.settings && ctx.state.plan.settings.comparisonWindow;
    const defaultWindow = Number.isInteger(setting) && setting >= 1 && setting <= 36 ? setting : 3;

    let period = '';
    const rp = String(raw.period || '').trim();
    if (rp === 'all') period = 'all';
    else if (rp) {
      const [a, b, extra] = rp.split('..');
      if (E.months.isMonth(a) && b === undefined) period = a;
      else if (E.months.isMonth(a) && E.months.isMonth(b) && extra === undefined) period = a === b ? a : (a < b ? a + '..' + b : b + '..' + a);
      else notes.push(`The period “${rp}” was not understood, so all months are shown.`);
    }
    let acct = '';
    if (raw.acct) {
      if (ctx.dataset.accounts.some(a => a.id === raw.acct)) acct = raw.acct;
      else notes.push(`The account “${raw.acct}” is not in the loaded data, so every account is shown.`);
    }
    let kind = 'spend';
    if (raw.kind) {
      if (KIND_BY[raw.kind]) kind = raw.kind;
      else notes.push(`“${raw.kind}” is not a kind of transaction this page knows, so spending is shown.`);
    }
    let window = defaultWindow;
    if (raw.window) {
      const w = Number(raw.window);
      if (Number.isInteger(w) && w >= 1 && w <= 36) window = w;
      else notes.push(`The comparison window “${raw.window}” was not understood; using ${defaultWindow} months.`);
    }
    let scope = '';
    if (raw.scope) {
      if (raw.scope === 'joint' || raw.scope === 'personal') scope = raw.scope;
      else notes.push(`“${raw.scope}” is not an account group this page knows, so every account is shown.`);
    }
    return {
      period, acct, scope, kind, window, defaultWindow, notes,
      cat: raw.cat || '',
      merchant: raw.merchant || '',
      list: raw.list === '1' ? '1' : '',
      q: String(raw.q || '').trim().slice(0, 200),
      txn: raw.txn || '',
      basis: raw.basis === 'bank' ? 'bank' : 'category',
      show: raw.show === 'excluded' ? 'excluded' : '',
    };
  }

  function resolvePeriod(ctx, P) {
    const all = ctx.months;
    if (!P.period) return { type: 'none', months: all, start: all[0], end: all[all.length - 1], label: 'All months', short: 'All months' };
    if (P.period === 'all') return { type: 'range', all: true, months: all, start: all[0], end: all[all.length - 1], label: 'all months', short: 'All months' };
    const [a, b] = P.period.split('..');
    if (!b) return { type: 'month', month: a, months: [a], start: a, end: a, label: fmt.monthLong(a), short: fmt.month(a) };
    return { type: 'range', months: E.months.range(a, b), start: a, end: b, label: fmt.period(P.period), short: fmt.period(P.period) };
  }

  /** Links that keep the current filters. `at` resets the drilldown level first. */
  function makeLinks(ctx, P) {
    const cur = { period: P.period, cat: P.cat, merchant: P.merchant, list: P.list, q: P.q, txn: P.txn, acct: P.acct, scope: P.scope, kind: P.kind, window: P.window, basis: P.basis, show: P.show };
    const params = over => {
      const m = { ...cur, ...over };
      const out = {};
      for (const k of PARAM_ORDER) {
        const v = m[k];
        if (v === undefined || v === null || v === '') continue;
        if (k === 'kind' && v === 'spend') continue;
        if (k === 'basis' && v === 'category') continue;
        if (k === 'window' && Number(v) === P.defaultWindow) continue;
        out[k] = String(v);
      }
      return out;
    };
    const level = over => params({ cat: '', merchant: '', list: '', q: '', txn: '', ...over });
    return {
      params,
      level,
      href: over => ctx.href('spending', params(over)),
      at: over => ctx.href('spending', level(over)),
    };
  }

  function levelOf(P, per) {
    if (P.txn) return 'txn';
    if (P.q) return 'search';
    if (P.kind !== 'spend') return 'kind';
    if (P.merchant) return 'merchant';
    if (P.list) return 'list';
    if (P.cat) return 'category';
    if (per.type === 'none') return 'months';
    return per.type === 'month' ? 'month' : 'range';
  }

  // ------------------------------------------------------------------ rows in scope
  function bankRows(ctx) {
    return ctx.memo('sp-bank', () => ctx.txns.map(t => {
      if (t.kind !== 'spend') return t;
      const name = bankCategory(t);
      const total = t.parts.reduce((s, p) => s + p.spendCents, 0);
      return { ...t, category: name, parts: t.parts.length ? [{ category: name, spendCents: total }] : [] };
    }));
  }
  /** Effective rows after the basis and account filters (period, kind and level come later). */
  function scoped(ctx, P) {
    return ctx.memo('sp-scope:' + P.basis + ':' + P.acct + ':' + P.scope, () => {
      let rows = P.basis === 'bank' ? bankRows(ctx) : ctx.txns;
      if (P.acct) rows = rows.filter(t => t.accountId === P.acct);
      if (P.scope) rows = rows.filter(t => t.accountScope === P.scope);
      return rows;
    });
  }
  /** Account ids the account filter keeps, or null when every account is shown. */
  function filterAccountIds(ctx, P) {
    if (!P.acct && !P.scope) return null;
    return new Set(ctx.dataset.accounts.filter(a => (P.acct ? a.id === P.acct : (a.scope || 'joint') === P.scope)).map(a => a.id));
  }
  function filterName(ctx, P) {
    if (P.acct) { const a = ctx.dataset.accounts.find(x => x.id === P.acct); return a ? a.label : P.acct; }
    return P.scope === 'personal' ? 'the personal accounts' : 'the joint accounts';
  }
  /**
   * With an account filter on, a month for which none of the kept accounts has any export (and
   * no rows) has unknown spending: it must read "Unknown", never $0.
   */
  function unknownForFilter(ctx, P, month) {
    const ids = filterAccountIds(ctx, P);
    if (!ids || !month) return false;
    if (!ids.size) return true; // e.g. "Personal accounts" when none is in the loaded data
    return ctx.memo(`sp-unknown:${P.acct}:${P.scope}:${P.basis}:${month}`, () => {
      const cov = E.ledger.coverage(ctx.dataset, month, { purpose: 'all' });
      const accts = cov.accounts.filter(a => ids.has(a.accountId));
      if (!accts.length || accts.some(a => a.coveredDays > 0)) return false;
      return !scoped(ctx, P).some(t => t.kind === 'spend' && t.date.slice(0, 7) === month);
    });
  }
  function unknownNotice(ctx, P, months, what = 'spending') {
    if (!months.length) return '';
    const name = filterName(ctx, P);
    if (!filterAccountIds(ctx, P).size) {
      return c.notice({ tone: 'warn', title: `No ${P.scope === 'personal' ? 'personal' : 'joint'} accounts in the loaded data`, body: `None of the imported accounts is a ${P.scope === 'personal' ? 'personal' : 'joint'} account, so what happened in them is unknown, not $0. Choose “All accounts”, or <a href="${esc(ctx.href('data'))}">load those exports</a>.` });
    }
    return c.notice({
      tone: 'warn',
      title: `${describeMonths(months)}: ${what} unknown for ${name}`,
      body: `No export from ${esc(name)} covers ${months.length === 1 ? 'this month' : 'these months'}, so ${what === 'spending' ? 'what was spent' : 'what came in or went out'} there is unknown, not $0. ${months.length === 1 ? 'It shows' : 'They show'} as “Unknown” and ${months.length === 1 ? 'is' : 'are'} left out of totals and averages here. Choose “All accounts” or <a href="${esc(ctx.href('data'))}">load that export</a> to fill ${months.length === 1 ? 'it' : 'them'} in.`,
    });
  }

  function byId(ctx) {
    return ctx.memo('sp-byid', () => new Map(ctx.txns.map(t => [t.id, t])));
  }
  function inMonths(rows, months) {
    const set = new Set(months);
    return rows.filter(t => set.has(t.date.slice(0, 7)));
  }
  /** Spending rows for a period and optional category/merchant: counted ones, or (excluded) the not-counted ones. */
  function spendRows(ctx, P, per, { cat = P.cat, merchant = P.merchant, excluded = false } = {}) {
    let rows = inMonths(scoped(ctx, P), per.months).filter(t => t.kind === 'spend');
    if (cat) rows = rows.filter(t => inCat(t, cat));
    if (merchant) rows = rows.filter(t => merchantOf(t) === merchant);
    return excluded ? rows.filter(t => t.excluded) : rows.filter(t => !t.excluded);
  }

  function comparison(ctx, P, month) {
    return ctx.memo(`sp-cmp:${P.basis}:${P.acct}:${P.scope}:${month}:${P.window}`, () => E.compare.usual(scoped(ctx, P), ctx.dataset, { month, window: P.window }));
  }

  function categoryTotals(rows) {
    const map = new Map();
    for (const t of rows) {
      for (const p of E.ledger.partsOf(t)) {
        if (!map.has(p.category)) map.set(p.category, { key: p.category, cents: 0, ids: new Set() });
        const g = map.get(p.category);
        g.cents += p.spendCents;
        g.ids.add(t.id);
      }
    }
    return [...map.values()].map(g => ({ key: g.key, cents: g.cents, count: g.ids.size }))
      .sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
  }
  function merchantTotals(rows, cat) {
    const map = new Map();
    for (const t of rows) {
      const k = merchantOf(t);
      if (!map.has(k)) map.set(k, { key: k, cents: 0, count: 0 });
      const g = map.get(k);
      g.cents += spendOf(t, cat);
      g.count += 1;
    }
    return [...map.values()].sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
  }

  // ------------------------------------------------------------------ period presets
  function presets(ctx) {
    const m = ctx.months;
    if (!m.length) return [];
    const first = m[0], last = m[m.length - 1], lc = ctx.latestComplete;
    const clamp = x => (x < first ? first : x);
    const range = (a, b) => (a === b ? a : a + '..' + b);
    const out = [];
    if (lc) {
      out.push({ value: lc, label: `Latest complete month (${fmt.month(lc)})`, chip: 'Latest complete month' });
      out.push({ value: range(clamp(E.months.add(lc, -2)), lc), label: 'Last 3 months', chip: 'Last 3 months' });
    }
    const year = last.slice(0, 4);
    out.push({ value: range(clamp(year + '-01'), last), label: `This year so far (${year})`, chip: `${year} so far` });
    if (lc) out.push({ value: range(clamp(E.months.add(lc, -11)), lc), label: 'Last 12 months', chip: 'Last 12 months' });
    out.push({ value: 'all', label: 'All months, one total', chip: 'All months' });
    return out;
  }

  // ------------------------------------------------------------------ filters bar
  function filtersBar(ctx, P, L) {
    const pre = presets(ctx);
    let found = false;
    const opt = (value, label) => {
      const sel = !found && value === P.period;
      if (sel) found = true;
      return `<option value="${esc(value)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
    };
    const monthOpts = [...ctx.months].reverse().map(m => opt(m, fmt.month(m) + (coverageOf(ctx, m).status !== 'full' ? ' (partial)' : ''))).join('');
    const quick = pre.map(p => opt(p.value, p.label)).join('');
    const allOpt = opt('', 'Month by month');
    const custom = P.period && !found ? `<option value="${esc(P.period)}" selected>${esc(fmt.period(P.period === 'all' ? '' : P.period))}</option>` : '';
    const period = `<div class="sp-f sp-f-period"><label for="sp-period">Period</label>
      <select id="sp-period" name="period" data-action="spending:filter" data-param="period">${allOpt}${custom}<optgroup label="Quick picks">${quick}</optgroup><optgroup label="Single months">${monthOpts}</optgroup></select></div>`;
    const acct = `<div class="sp-f sp-f-acct"><label for="sp-acct">Account</label>
      <select id="sp-acct" name="acct" data-action="spending:filter" data-param="acct"><option value=""${!P.acct && !P.scope ? ' selected' : ''}>All accounts</option>
        <optgroup label="Groups"><option value="scope:joint"${P.scope === 'joint' && !P.acct ? ' selected' : ''}>Joint accounts</option><option value="scope:personal"${P.scope === 'personal' && !P.acct ? ' selected' : ''}>Personal accounts</option></optgroup>
        <optgroup label="Accounts">${ctx.dataset.accounts.map(a => `<option value="${esc(a.id)}"${a.id === P.acct ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}</optgroup></select></div>`;
    const kind = `<div class="sp-f"><label for="sp-kind">Show</label>
      <select id="sp-kind" name="kind" data-action="spending:filter" data-param="kind">${KIND_OPTIONS.map(k => `<option value="${esc(k.value)}"${k.value === P.kind ? ' selected' : ''}>${esc(k.short)}</option>`).join('')}</select></div>`;
    const search = `<div class="sp-f sp-f-search"><label for="sp-q">Search</label>
      <div class="sp-search-row"><input id="sp-q" name="q" type="search" value="${esc(P.q)}" maxlength="200" placeholder="Merchant or 486.60" autocomplete="off"><button class="btn btn-secondary" type="submit" id="sp-search-go">Search</button></div></div>`;
    const basis = !['spend', 'all'].includes(P.kind) ? '' : `<div class="sp-f sp-f-basis">${c.segmented({ label: 'Categories', name: 'sp-basis', options: [{ value: 'category', label: 'Yours' }, { value: 'bank', label: "Bank's" }], value: P.basis, action: 'spending:basis' })}</div>`;
    const active = P.acct || P.scope || P.q || P.kind !== 'spend' || P.basis !== 'category' || P.show || P.window !== P.defaultWindow;
    const clear = active ? `<div class="sp-f sp-f-clear"><a class="btn btn-ghost btn-small" id="sp-clear" href="${esc(L.href({ acct: '', scope: '', q: '', kind: 'spend', basis: 'category', show: '', window: P.defaultWindow, ...(P.basis === 'bank' ? { cat: '', merchant: '' } : {}), ...(P.q ? { cat: '', merchant: '' } : {}) }))}">Clear filters</a></div>` : '';
    return `<form class="sp-filters" data-action="spending:search" role="search" aria-label="Filter spending">${period}${acct}${kind}${search}${basis}${clear}</form>`;
  }

  // ------------------------------------------------------------------ shared level pieces
  function notCountedLine(ctx, P, per, { cat = P.cat, merchant = P.merchant } = {}) {
    const ex = spendRows(ctx, P, per, { cat, merchant, excluded: true });
    const partly = spendRows(ctx, P, per, { cat, merchant }).filter(t => t.reimbursedCents > 0);
    if (!ex.length && !partly.length) return '';
    const cents = sum(ex, t => -t.amountCents) + sum(partly, t => t.reimbursedCents);
    const reasons = {};
    for (const t of ex) reasons[t.excluded] = (reasons[t.excluded] || 0) + 1;
    const why = Object.entries(reasons).map(([r, n]) => `${n} ${EXCLUDED_SHORT[r] || r}`).join(', ');
    const lead = ex.length ? `${count(ex.length, 'row')} not counted (${money(cents)})` : `${money(cents)} not counted`;
    const partlyText = partly.length ? `${ex.length ? '; ' : ': '}${count(partly.length, 'charge')} partly paid back` : '';
    return `<div class="sp-excluded-line"><p>${lead}${ex.length ? ': ' + esc(why) : ''}${partlyText}. These rows stay in your data but are not part of the totals.</p>
      ${excludedToggle(P)}</div>`;
  }

  /** One toggle for not-counted rows; it keeps its id (and focus) whichever way it is switched. */
  function excludedToggle(P) {
    return `<button type="button" class="btn btn-small btn-secondary" id="sp-show-excluded" data-action="spending:toggle-excluded">${P.show ? 'Hide them' : 'Show them'}<span class="sr-only"> (rows not counted)</span></button>`;
  }

  /** Card listing the not-counted rows (month, range and category levels when show=excluded). */
  function notCountedCard(ctx, P, per, L, { cat = P.cat } = {}) {
    if (!P.show) return '';
    const ex = spendRows(ctx, P, per, { cat, excluded: true });
    const partly = spendRows(ctx, P, per, { cat }).filter(t => t.reimbursedCents > 0);
    const rows = [...ex, ...partly].sort(byDate);
    const body = txnRows(ctx, L, rows, {
      caption: 'Rows not counted in ' + per.label,
      amount: t => (t.excluded ? -t.amountCents : t.reimbursedCents),
      footerLabel: 'not counted',
      emptyText: 'Every row in this selection is counted.',
      cat,
    });
    return c.card(`<p class="fine">Duplicates, confirmed reimbursements and business costs are kept in your data but left out of spending. Change a decision in <a href="${esc(ctx.href('review', { queue: 'edited' }))}">Data review</a>.</p>${body}`,
      { title: 'Not counted', subtitle: 'Shown struck through; the amounts below are what is left out.', id: 'sp-not-counted', cls: 'sp-txnlist' });
  }

  /** Banner shown on every level while a what-if switch changes the history being shown. */
  function whatIfBanner(ctx) {
    const wi = ctx.state.ui.whatIf || {};
    const on = [];
    if (wi.excludePendingReimbursements) on.push('charges that may be paid back');
    if (wi.excludeBusinessCandidates) on.push('possible business costs');
    if (!on.length) return '';
    return c.notice({ tone: 'warn', title: 'What-if is on', body: `Totals here leave out ${esc(on.join(' and '))}. This only changes what is shown; your data is unchanged. Switch it off in the What-if box on a month or period.` });
  }

  function whatIfEffects(ctx, P, per) {
    return ctx.memo('sp-wi:' + P.acct + ':' + P.scope + ':' + per.months.join(','), () => {
      const cur = ctx.state.ui.whatIf || {};
      const scope = rows => inMonths(rows.filter(t => (!P.acct || t.accountId === P.acct) && (!P.scope || t.accountScope === P.scope)), per.months);
      const out = {};
      for (const key of ['excludePendingReimbursements', 'excludeBusinessCandidates']) {
        const off = E.ledger.applyEdits(ctx.dataset, ctx.state.ledgerEdits, { whatIf: { ...cur, [key]: false } });
        const on = E.ledger.applyEdits(ctx.dataset, ctx.state.ledgerEdits, { whatIf: { ...cur, [key]: true } });
        const changed = scope(on.filter((t, i) => t.excluded !== off[i].excluded || t.reimbursedCents !== off[i].reimbursedCents));
        const sOff = E.ledger.summarize(scope(off)), sOn = E.ledger.summarize(scope(on));
        out[key] = {
          rows: changed.length,
          spendCents: sOff.spendingCents - sOn.spendingCents,
          incomeCents: (sOff.incomeCents + sOff.contributionsCents) - (sOn.incomeCents + sOn.contributionsCents),
        };
      }
      return out;
    });
  }

  function whatIfBox(ctx, P, per) {
    const wi = ctx.state.ui.whatIf || {};
    const fx = whatIfEffects(ctx, P, per);
    const effect = (e, key) => {
      if (!e.rows) return `No rows in ${esc(per.label)} are affected.`;
      const parts = [];
      if (e.spendCents) parts.push(`spending ${money(Math.abs(e.spendCents))} ${e.spendCents > 0 ? 'lower' : 'higher'}`);
      if (e.incomeCents) parts.push(`money in ${money(Math.abs(e.incomeCents))} ${e.incomeCents > 0 ? 'lower' : 'higher'}`);
      return `In ${esc(per.label)}: ${count(e.rows, 'row')}${parts.length ? ' — ' + parts.join(', ') : ''}${wi[key] ? ' (applied now)' : ' when switched on'}.`;
    };
    const sw = (key, id, label, help) => `<div class="sp-switch">
      <label class="check" for="${id}"><input type="checkbox" id="${id}" data-bind="ui.whatIf.${key}" data-type="bool"${wi[key] ? ' checked' : ''}> <span><strong>${esc(label)}</strong><small>${esc(help)}</small></span></label>
      <p class="sp-switch-effect">${effect(fx[key], key)}</p></div>`;
    return `<section class="card sp-whatif" aria-labelledby="sp-whatif-h">
      <div class="card-head"><div><h2 id="sp-whatif-h">What-if (history only)</h2><p class="card-sub">Try leaving out rows that are still undecided. Your data and saved corrections never change; switch back any time.</p></div></div>
      ${sw('excludePendingReimbursements', 'sp-wi-reimb', 'Leave out charges that may be paid back', 'Pending reimbursement matches: the charge and the deposit that may repay it.')}
      ${sw('excludeBusinessCandidates', 'sp-wi-business', 'Leave out possible business costs', 'Rows flagged as possible business purchases that are not decided yet.')}
    </section>`;
  }

  function planningNote(ctx, P, per, rows, cmp) {
    const marked = rows.filter(t => t.planningExcluded);
    const baselineCents = cmp ? cmp.categories.reduce((s, x) => s + (x.planningExcludedCents || 0), 0) : 0;
    if (!marked.length && !baselineCents) return '';
    const L = makeLinks(ctx, P);
    const list = marked.length ? `<ul class="sp-mini-list">${marked.map(t => `<li><a href="${esc(L.at({ period: P.period, txn: t.id }))}">${esc(fmt.date(t.date))} · ${esc(merchantOf(t))}</a> <span class="num">${money(spendOf(t, P.cat))}</span></li>`).join('')}</ul>` : '';
    const body = (marked.length ? `${count(marked.length, 'transaction')} in ${esc(per.label)} (${money(sum(marked, t => spendOf(t, P.cat)))}) ${marked.length === 1 ? 'is' : 'are'} marked “leave out of planning”. ` : '')
      + (baselineCents ? `In the comparison months, ${money(baselineCents)} is marked the same way. ` : '')
      + 'Actual spending here is unchanged and still includes them; only the budget\'s planning baselines leave them out.' + list;
    return c.notice({ tone: 'info', title: 'Planning baseline', body });
  }

  // ------------------------------------------------------------------ transaction tables
  /** Amount cell for one row; `cat` limits a split row to that category's part. */
  function amountCell(t, cat) {
    if (t.kind !== 'spend') return `<span>${esc(sh().amountText(t))}</span>`;
    if (t.excluded) return `<span>${money(-t.amountCents)}</span><small>not counted</small>`;
    const counted = spendOf(t, cat);
    const whole = -t.amountCents;
    let note = '';
    if (cat && counted !== whole - (t.reimbursedCents || 0)) note = `<small>part of ${money(whole)} (split)</small>`;
    else if (t.reimbursedCents) note = `<small>${money(t.reimbursedCents)} of ${money(whole)} paid back</small>`;
    return counted < 0 ? `<span class="tone-good">${money(counted)} refund</span>${note}` : `<span>${money(counted)}</span>${note}`;
  }

  /**
   * Transaction table used where UI.shared.txnTable cannot reconcile (split rows inside one
   * category, non-spending kinds, not-counted rows): same columns, but the amount and footer use
   * `amount(t)` so the footer equals the total the table explains.
   */
  function txnRows(ctx, L, rows, { caption, cat = '', amount, footerLabel = 'counted spending', emptyText = 'No transactions match.', hrefFor, kindColumn = false, zeroReason } = {}) {
    const ids = byId(ctx);
    const amt = amount || (t => spendOf(t, cat));
    const link = hrefFor || (t => L.href({ txn: t.id }));
    const items = rows.map(t => ({ t, o: ids.get(t.id) || t }));
    // A non-spending row that adds nothing to this table's total (the second side of a transfer
    // or card payment, a move between accounts) says so, so the rows visibly add up to the footer.
    const notCountedHere = r => r.o.kind !== 'spend' && !r.o.excluded && amt(r.t) === 0;
    const statusHtml = r => {
      const b = sh().badges(r.o, { compact: true });
      if (notCountedHere(r)) return c.badge('Not counted here', 'neutral') + (zeroReason ? `<small>${esc(zeroReason(r.o))}</small>` : '') + (b ? ' ' + b : '');
      return b || '<span class="fine">Counted</span>';
    };
    const amountHtml = r => {
      if (r.o.kind === 'spend') return amountCell(r.t, cat);
      const shown = `<span>${esc(sh().amountText(r.o))}</span>`;
      if (r.o.excluded) return shown + '<small>not counted</small>';
      const counted = amt(r.t);
      if (counted === 0) return shown + '<small>counts $0.00 here</small>';
      if (Math.abs(counted) !== Math.abs(r.o.amountCents)) return shown + `<small>${money(counted)} counted</small>`;
      return shown;
    };
    const columns = [
      { key: 'date', label: 'Date', html: r => `<span class="nowrap">${esc(fmt.date(r.o.date))}</span>` },
      { key: 'merchant', label: 'Merchant', html: r => `<a href="${esc(link(r.t))}">${esc(merchantOf(r.o))}</a><small>${esc(r.o.description)} · ${esc(r.o.accountLabel || r.o.accountId)}</small>` },
      kindColumn
        ? { key: 'kind', label: 'Kind', html: r => `${esc(sh().kindLabel(r.o))}<small>${esc(r.o.category)}</small>` }
        : { key: 'category', label: 'Category', html: r => `${esc(r.o.parts && r.o.parts.length > 1 ? 'Split: ' + r.o.parts.map(p => p.category).join(', ') : r.o.category)}<small>Bank: ${esc(r.o.sourceCategory || 'none')}</small>` },
      { key: 'status', label: 'Status', html: statusHtml },
      { key: 'amount', label: 'Amount', align: 'right', html: amountHtml },
    ];
    const total = sum(rows, amt);
    const footer = { date: `${rows.length} row${rows.length === 1 ? '' : 's'}`, amount: `${money(total)}<small>${esc(footerLabel)}</small>` };
    return c.table({ caption, columns, rows: items, footer, emptyText, rowAttrs: r => ({ class: r.o.excluded ? 'is-excluded' : null }) });
  }

  function kindParamOf(t) { return KIND_PARAM[t.kind] || 'all'; }

  // ------------------------------------------------------------------ level: all months
  function levelMonths(ctx, P, per, L) {
    const crumbs = [];
    const header = { eyebrow: 'Spending', title: 'Spending by month', subtitle: ctx.latestComplete ? `${esc(fmt.monthLong(ctx.latestComplete))} is the latest month with complete data. Pick a month to see its categories, merchants and every transaction behind each total.` : 'Pick a month to see its categories, merchants and every transaction behind each total.' };
    if (!ctx.months.length) {
      return { crumbs, header, body: c.empty('No transactions are loaded yet. Import your bank exports to see where money went; nothing leaves this device.', c.linkButton('Load data', ctx.href('data'), { variant: 'primary' })) };
    }
    const scope = scoped(ctx, P);
    const unknownMonths = ctx.months.filter(m => unknownForFilter(ctx, P, m));
    const trend = ctx.memo('sp-trend:' + P.basis + ':' + P.acct + ':' + P.scope, () => E.compare.trend(scope, ctx.dataset, { months: ctx.months }))
      .map(r => (unknownMonths.includes(r.month) ? { ...r, spendCents: null, unknownForFilter: true } : r));
    const counted = scope.filter(t => t.kind === 'spend' && !t.excluded);
    const counts = {};
    for (const t of counted) { const m = t.date.slice(0, 7); counts[m] = (counts[m] || 0) + 1; }
    const partials = trend.filter(r => r.coverage.status !== 'full').map(r => r.month);

    const chips = `<ul class="sp-chips" aria-label="Quick periods">${presets(ctx).map(p => `<li><a href="${esc(L.at({ period: p.value }))}">${esc(p.chip)}</a></li>`).join('')}</ul>`;

    const chart = c.columnChart({
      title: 'Spending per month',
      items: trend.map(r => ({
        label: r.month, value: r.spendCents, href: L.at({ period: r.month }),
        muted: r.coverage.status !== 'full',
        note: r.unknownForFilter ? `Unknown: no export from ${filterName(ctx, P)}` : r.coverage.status === 'full' ? '' : r.coverage.status === 'partial' ? 'Partial month: only what is in the data' : 'No data for this month',
      })),
      highlight: ctx.latestComplete,
    });
    const legend = chartLegend([['full', 'Complete month'], ctx.latestComplete && ['sel', 'Latest complete month'], partials.length && ['partial', 'Partial month (only what is in the data)']]);

    const rows = [...trend].reverse().map(r => {
      const cmp = comparison(ctx, P, r.month);
      return { ...r, cmp, n: counts[r.month] || 0 };
    });
    const vsUsual = r => {
      if (r.unknownForFilter) return '<span class="muted">Not compared</span><small>unknown for this account</small>';
      if (r.coverage.status !== 'full') return '<span class="muted">Not compared</span><small>partial month</small>';
      if (r.cmp.baselineMonths.some(m => unknownForFilter(ctx, P, m))) return '<span class="muted">Not known</span><small>no export for this account before</small>';
      if (r.cmp.totals.averageCents === null) return '<span class="muted">No usual yet</span><small>no full months before</small>';
      const d = r.cmp.totals.diffCents, avg = r.cmp.totals.averageCents;
      const n = r.cmp.usableCount;
      return `${esc(fmt.diff(d))}<small>vs ${money(avg)}${avg > 0 ? ' · ' + esc(fmt.pct((d * 100) / avg)) : ''}</small><small>${n}-month avg${n < 2 ? ' (limited)' : ''}</small>`;
    };
    const total = sum(trend, r => r.spendCents || 0);
    const totalCount = sum(rows, r => r.n);
    const table = c.table({
      caption: 'Spending per month with coverage',
      columns: [
        { key: 'month', label: 'Month', html: r => `<a class="nowrap" href="${esc(L.at({ period: r.month }))}">${esc(fmt.monthLong(r.month))}</a>` },
        { key: 'spend', label: 'Spending', align: 'right', html: r => (r.spendCents === null ? `<span class="muted">Unknown</span><small>${r.unknownForFilter ? 'no export for this account' : 'no data'}</small>` : money(r.spendCents)) },
        { key: 'usual', label: 'vs usual', align: 'right', html: vsUsual },
        { key: 'coverage', label: 'Coverage', html: r => coverageBadge(r.coverage) + (r.coverage.status !== 'full' && r.coverage.note ? `<small>${esc(r.coverage.note)}</small>` : '') },
        { key: 'n', label: 'Records', align: 'right', html: r => (r.n ? `<a href="${esc(L.at({ period: r.month, list: '1' }))}">${count(r.n, 'transaction')}</a>` : '<span class="muted">None</span>') },
      ],
      rows,
      footer: {
        month: `All months<small>${count(rows.length, 'month')}</small>`,
        spend: `<a href="${esc(L.at({ period: 'all' }))}">${money(total)}</a>${unknownMonths.length ? `<small>${count(unknownMonths.length, 'month')} unknown</small>` : ''}`,
        usual: '',
        coverage: partials.length ? `<small>${count(partials.length, 'partial month')}</small>` : '',
        n: `<a href="${esc(L.at({ period: 'all', list: '1' }))}">${count(totalCount, 'transaction')}</a>`,
      },
      cls: 'sp-months-table',
    });
    const partialNote = partials.length ? c.notice({ tone: 'warn', title: `${describeMonths(partials)} ${partials.length === 1 ? 'is a partial month' : 'are partial months'}`, body: `Not every account's export covers ${partials.length === 1 ? 'it' : 'them'}, so the amounts are only what is in the data and the real totals were probably higher. Partial months are never used to work out what is usual. <a href="${esc(ctx.href('review', { queue: 'coverage' }))}">See coverage details</a>.` }) : '';

    const body = `<div class="stack">
      ${chips}
      ${unknownNotice(ctx, P, unknownMonths)}
      ${partialNote}
      ${c.card(chartBlock(chart) + legend, { title: 'Spending per month', subtitle: 'Select a column or a month to open it. Partial months are greyed out.', id: 'sp-chart' })}
      ${c.card(table + `<p class="fine sp-after-table">“vs usual” compares each complete month with the average of the complete months among the ${P.window} before it; each row says how many months that average uses. It is history, not a target.</p>`, { title: 'Months', id: 'sp-months', cls: 'sp-months-wrap', actions: windowControl(P) })}
    </div>`;
    return { crumbs, header, body };
  }

  // ------------------------------------------------------------------ level: one month
  function usualCell(x, cmp) {
    if (x.basis === 'last_year' && x.seasonal) {
      return `${money(x.basisCents)}<small>${esc(fmt.month(x.seasonal.lastYearMonth))}, last year</small>`;
    }
    if (x.averageCents === null) return '<span class="muted">Not known</span><small>no full months before</small>';
    if (x.signal === 'irregular' && x.irregular) return `<span class="muted">${money(x.averageCents)}</span><small>only ${esc(fmt.month(x.irregular.month))}: ${money(x.irregular.cents)}</small>`;
    return `${money(x.averageCents)}<small>${cmp.usableCount}-month average</small>`;
  }
  function diffCell(x, partial) {
    if (partial) return '<span class="muted">—</span><small>not compared</small>';
    if (x.diffCents === null || x.diffCents === undefined) return '<span class="muted">—</span><small>not compared</small>';
    return `${esc(fmt.diff(x.diffCents))}<small>${x.pct === null || x.pct === undefined ? 'no %' : esc(pctText(x.pct))}</small>`;
  }

  function baselineText(cmp) {
    const left = cmp.excludedMonths || [];
    const groups = { partial: [], none: [], other: [] };
    for (const e of left) {
      const r = String(e.reason || '').toLowerCase();
      if (r.includes('no account export')) groups.none.push(e.month);
      else if (r.includes('days covered') || r.includes('partial')) groups.partial.push(e.month);
      else groups.other.push(e);
    }
    const leftText = [
      groups.partial.length ? `${describeMonths(groups.partial)} (partial coverage)` : '',
      groups.none.length ? `${describeMonths(groups.none)} (no data)` : '',
      ...groups.other.map(e => `${fmt.month(e.month)} (${lowerFirst(e.reason)})`),
    ].filter(Boolean).join('; ');
    if (!cmp.usableCount) {
      return `There is no usual amount yet: none of ${esc(describeMonths(cmp.trailingMonths))} is a complete month.${leftText ? ' Left out: ' + esc(leftText) + '.' : ''}`;
    }
    return `Usual = average of ${esc(describeMonths(cmp.baselineMonths))}, <strong id="sp-usable">${count(cmp.usableCount, 'full month')}</strong>.${leftText ? ' Left out: ' + esc(leftText) + '.' : ''} History, not a target.`;
  }

  function windowControl(P) {
    const opts = WINDOWS.includes(P.window) ? WINDOWS : [...WINDOWS, P.window].sort((a, b) => a - b);
    return c.segmented({ label: 'Usual = average of the last', name: 'sp-window', options: opts.map(w => ({ value: w, label: w + ' months' })), value: P.window, action: 'spending:window' });
  }

  function comparisonTable(ctx, P, L, cmp, month, total, nRows) {
    const partial = cmp.selectedCoverage.status !== 'full';
    const rows = cmp.categories.filter(x => x.actualCents !== 0 || x.ids.length || (x.averageCents || 0) !== 0 || (x.basisCents || 0) !== 0);
    if (!rows.length) return c.empty(`No spending in ${esc(fmt.monthLong(month))} or in the months before it.`);
    const body = rows.map(x => {
      const n = x.ids.length;
      const why = domId('sp-why', x.category);
      return `<tr class="${n ? '' : 'sp-zero'}">
        <th scope="row" class="sp-c-cat"><a href="${esc(L.at({ period: month, cat: x.category }))}">${esc(x.category)}</a><small>${n ? `<a href="${esc(L.at({ period: month, cat: x.category, list: '1' }))}">${count(n, 'transaction')}</a>` : 'None this month'}</small></th>
        <td class="num sp-c-act">${money(x.actualCents)}</td>
        <td class="num sp-c-usual"><span class="sp-ml" aria-hidden="true">Usual</span>${usualCell(x, cmp)}</td>
        <td class="num sp-c-diff"><span class="sp-ml" aria-hidden="true">Difference</span>${diffCell(x, partial)}</td>
        <td class="sp-c-sig">${signalBadge(x.signal)}<details class="sp-why" id="${esc(why)}"><summary>Why<span class="sr-only"> is ${esc(x.category)} marked this way</span></summary><p>${esc(x.explanation)}</p></details></td>
      </tr>`;
    }).join('');
    const tot = cmp.totals;
    const reconciles = tot.actualCents === total;
    const foot = `<tr>
      <th scope="row" class="sp-c-cat">Total<small><a href="${esc(L.at({ period: month, list: '1' }))}">${count(nRows, 'transaction')}</a></small></th>
      <td class="num sp-c-act">${money(tot.actualCents)}</td>
      <td class="num sp-c-usual"><span class="sp-ml" aria-hidden="true">Usual</span>${tot.averageCents === null ? '<span class="muted">Not known</span>' : money(tot.averageCents)}<small>${tot.averageCents === null ? 'no full months' : 'average'}</small></td>
      <td class="num sp-c-diff"><span class="sp-ml" aria-hidden="true">Difference</span>${tot.diffCents === null ? '<span class="muted">—</span>' : esc(fmt.diff(tot.diffCents))}</td>
      <td class="sp-c-sig">${reconciles ? c.badge('Matches the month total', 'good') : c.badge('Does not match the month total', 'bad')}</td>
    </tr>`;
    return `<div class="table-wrap sp-cmp-wrap" tabindex="0" role="region" aria-label="${esc('Spending by category, ' + fmt.monthLong(month))}">
      <table class="table sp-cmp"><caption class="sr-only">${esc(`Spending by category in ${fmt.monthLong(month)}, compared with the usual amount`)}</caption>
      <thead><tr><th scope="col">Category</th><th scope="col" class="num">This month</th><th scope="col" class="num">Usual</th><th scope="col" class="num">Difference</th><th scope="col">Signal</th></tr></thead>
      <tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>`;
  }

  function levelMonth(ctx, P, per, L) {
    const month = per.month;
    const cov = coverageOf(ctx, month);
    const partial = cov.status !== 'full';
    const cmp = comparison(ctx, P, month);
    const rows = spendRows(ctx, P, per);
    const total = sum(rows, t => spendOf(t));
    const s = E.ledger.summarize(rows);
    const listHref = L.at({ period: month, list: '1' });
    // A month that no export covers at all is unknown, not a $0 partial month.
    const noData = cov.status === 'none' && !rows.length;
    const unknown = unknownForFilter(ctx, P, month) || noData;
    const prev = E.months.add(month, -1), next = E.months.add(month, 1);
    const navBtn = (m, dir) => `<a class="btn btn-small btn-secondary" href="${esc(L.at({ period: m }))}" id="sp-${dir}">${dir === 'prev' ? '<span aria-hidden="true">‹</span> ' : ''}${esc(fmt.month(m))}<span class="sr-only">${dir === 'prev' ? ' (previous month)' : ' (next month)'}</span>${dir === 'next' ? ' <span aria-hidden="true">›</span>' : ''}</a>`;
    const actions = `<nav class="sp-monthnav" aria-label="Other months">${ctx.months.includes(prev) ? navBtn(prev, 'prev') : ''}${ctx.months.includes(next) ? navBtn(next, 'next') : ''}</nav>`;
    const header = {
      eyebrow: 'Spending',
      title: `${fmt.monthLong(month)} spending`,
      subtitle: unknown
        ? `<strong class="tone-warn">Spending unknown.</strong> ${noData ? 'No account export covers this month.' : `No export from ${esc(filterName(ctx, P))} covers this month.`}`
        : `${partial ? '<strong class="tone-warn">Partial month.</strong> ' : ''}<strong>${money(total)}</strong> counted spending in <a href="${esc(listHref)}">${count(rows.length, 'transaction')}</a>${s.refundsCents ? `, after ${money(s.refundsCents)} of refunds` : ''}.`,
      actions,
    };
    const crumbs = [{ label: 'All months', href: L.at({ period: '' }) }, { label: fmt.month(month) }];

    const partialNotice = partial && !unknown ? c.notice({
      tone: 'warn',
      title: cov.status === 'none' ? `No data covers ${fmt.monthLong(month)}` : `${fmt.monthLong(month)} is a partial month`,
      body: `${esc(cov.note || '')} The amounts are only what is in the data, so the real total was probably higher. Nothing is compared with usual or marked higher or lower for this month.`,
    }) : '';
    // With an account filter, baseline months the filtered accounts have no export for would
    // count as $0: the usual amount is then not known for this filter.
    const baseUnknown = unknown ? [] : cmp.baselineMonths.filter(m => unknownForFilter(ctx, P, m));
    const usualKnown = !unknown && !baseUnknown.length;
    const usualTot = usualKnown ? cmp.totals.averageCents : null;
    const usualWhy = unknown ? `This month is unknown for ${esc(filterName(ctx, P))}` : `${esc(describeMonths(baseUnknown))}: no export from ${esc(filterName(ctx, P))}`;
    const metrics = `<div class="metrics sp-metrics">
      ${unknown
    ? c.metric({ label: `Spent in ${fmt.month(month)}`, value: 'Unknown', sub: `No export from ${esc(filterName(ctx, P))} for this month`, status: c.badge('No data', 'neutral') })
    : c.metric({ label: `Spent in ${fmt.month(month)}`, value: fmt.money(total), sub: `<a href="${esc(listHref)}">${count(rows.length, 'transaction')}</a>${s.refundsCents ? ` · after ${money(s.refundsCents)} refunds` : ''}`, status: partial ? c.badge('Partial month', 'warn') : '' })}
      ${!usualKnown
    ? c.metric({ label: 'Usual', value: 'Not known', sub: usualWhy })
    : c.metric({ label: cmp.usableCount ? `Usual · ${cmp.usableCount}-month average` : 'Usual', value: usualTot === null ? 'Not known yet' : fmt.money(usualTot), sub: usualTot === null ? 'No complete months before this one. Loading earlier exports would give one.' : `History (${esc(describeMonths(cmp.baselineMonths))}), not a target` })}
      ${c.metric({ label: 'Difference from usual', value: partial || !usualKnown ? 'Not compared' : cmp.totals.diffCents === null ? '—' : fmt.diff(cmp.totals.diffCents), sub: partial ? 'Partial month' : !usualKnown ? 'Needs a known usual amount' : cmp.totals.diffCents === null || !usualTot ? 'Needs a usual amount' : esc(fmt.pct((cmp.totals.diffCents * 100) / usualTot)) + ' vs usual', tone: '' })}
    </div>`;
    const flagged = cmp.categories.filter(x => ['higher', 'seasonal_higher'].includes(x.signal));
    const table = unknown
      ? c.empty(`No export from ${esc(filterName(ctx, P))} covers ${esc(fmt.monthLong(month))}, so its spending by category is unknown.`, c.linkButton('Show all accounts', L.href({ acct: '', scope: '' }), { variant: 'secondary' }))
      : comparisonTable(ctx, P, L, cmp, month, total, rows.length);
    const cardBody = `<p class="fine sp-basis-line" id="sp-baseline">${baselineText(cmp)}</p>
      ${baseUnknown.length ? c.notice({ tone: 'warn', title: 'Usual amounts are not reliable for this account', body: `${esc(filterName(ctx, P))} has no export for ${esc(describeMonths(baseUnknown))}, so those months count as $0 in the usual amounts below. Treat higher/lower marks with care, or choose “All accounts”.` }) : ''}
      ${table}
      <p class="fine sp-after-table">A category is marked higher or lower only when it differs from usual by at least ${money(cmp.rule.minDiffCents, { whole: true })} <em>and</em> ${esc(cmp.rule.minPct)}%, with at least ${esc(cmp.rule.minMonths)} complete months of history. Heating and electricity are compared with the same month last year. ${flagged.length && !partial ? `${count(flagged.length, 'category is', 'categories are')} marked higher this month.` : ''} Select “Why” for the reasoning behind each row.</p>`;
    const reconcile = `<p class="fine">Checking against a statement? <a href="${esc(ctx.href('review', { queue: 'reconcile', start: E.months.start(month), end: E.months.end(month) }))}">Reconcile this total</a>.</p>`;
    const body = `<div class="stack">
      ${partialNotice}
      ${metrics}
      ${c.card(cardBody, { title: 'By category', subtitle: partial ? 'Partial month: amounts shown, nothing compared.' : 'This month next to what is usual for you.', actions: windowControl(P), id: 'sp-bycat' })}
      ${planningNote(ctx, P, per, rows, cmp)}
      ${notCountedLine(ctx, P, per)}
      ${notCountedCard(ctx, P, per, L)}
      ${whatIfBox(ctx, P, per)}
      ${reconcile}
    </div>`;
    return { crumbs, header, body };
  }

  // ------------------------------------------------------------------ level: range of months
  function levelRange(ctx, P, per, L) {
    const rows = spendRows(ctx, P, per);
    const total = sum(rows, t => spendOf(t));
    const cats = categoryTotals(rows);
    // Months whose spending is unknown for the account filter are left out of the average.
    const unknownMonths = per.months.filter(m => unknownForFilter(ctx, P, m));
    const partials = per.months.filter(m => coverageOf(ctx, m).status !== 'full' && !unknownMonths.includes(m));
    const pv = P.period;
    const header = {
      eyebrow: 'Spending',
      title: per.all ? 'Spending, all months' : `Spending, ${per.label}`,
      subtitle: `<strong>${money(total)}</strong> counted spending in <a href="${esc(L.at({ period: pv, list: '1' }))}">${count(rows.length, 'transaction')}</a> over ${count(per.months.length, 'month')}.`,
    };
    const crumbs = [{ label: 'All months', href: L.at({ period: '' }) }, { label: per.all ? 'All months, one total' : per.short }];
    // Per-month averages use complete months only (as 'usual' does): a partial or uncovered month
    // would otherwise count as a low-spending month. Totals still include every month.
    const fullMonths = per.months.filter(m => !unknownMonths.includes(m) && coverageOf(ctx, m).status === 'full');
    const fullSet = new Set(fullMonths);
    const fullRows = rows.filter(t => fullSet.has(t.date.slice(0, 7)));
    const fullBy = new Map(categoryTotals(fullRows).map(r => [r.key, r.cents]));
    const fullTotal = sum(fullRows, t => spendOf(t));
    const perMonthOf = (key) => (fullMonths.length ? E.money.divide(key === null ? fullTotal : (fullBy.get(key) || 0), fullMonths.length) : null);
    const table = c.table({
      caption: `Spending by category, ${per.label}`,
      columns: [
        { key: 'cat', label: 'Category', html: r => `<a href="${esc(L.at({ period: pv, cat: r.key }))}">${esc(r.key)}</a><small><a href="${esc(L.at({ period: pv, cat: r.key, list: '1' }))}">${count(r.count, 'transaction')}</a></small>` },
        { key: 'total', label: 'Total', align: 'right', html: r => money(r.cents) },
        { key: 'per', label: 'Per month', align: 'right', html: r => ML('Per month') + money(perMonthOf(r.key)) },
        { key: 'share', label: 'Share', align: 'right', html: r => ML('Share') + sharePct(r.cents, total) },
      ],
      rows: cats,
      footer: {
        cat: `Total<small><a href="${esc(L.at({ period: pv, list: '1' }))}">${count(rows.length, 'transaction')}</a></small>`,
        total: money(total),
        per: ML('Per month') + money(perMonthOf(null)),
        share: total > 0 ? ML('Share') + '100%' : '',
      },
      emptyText: `No counted spending in ${per.label}.`,
      cls: 'sp-stack'
    });
    const notes = `<p class="fine sp-after-table">Per month = average of the ${count(fullMonths.length, 'complete month')}${fullMonths.length ? '' : ' (none in this period, so it is unknown)'}.${partials.length ? ` ${esc(describeMonths(partials))} ${partials.length === 1 ? 'is' : 'are'} partial: included in the totals but left out of the per-month average.` : ''}${unknownMonths.length ? ` ${esc(describeMonths(unknownMonths))} ${unknownMonths.length === 1 ? 'is' : 'are'} unknown for ${esc(filterName(ctx, P))}.` : ''} Periods are not compared with usual: pick a single month to compare it with the months before it.</p>`;
    let chart = '';
    if (per.months.length > 1) {
      const trend = E.compare.trend(scoped(ctx, P), ctx.dataset, { months: per.months });
      chart = c.card(chartBlock(c.columnChart({
        title: 'Spending per month',
        items: trend.map(r => (unknownMonths.includes(r.month)
          ? { label: r.month, value: null, note: `Unknown: no export from ${filterName(ctx, P)}` }
          : { label: r.month, value: r.spendCents, href: L.at({ period: r.month }), muted: r.coverage.status !== 'full', note: r.coverage.status === 'full' ? '' : 'Partial month: only what is in the data' })),
      })) + chartLegend([['full', 'Complete month'], partials.length && ['partial', 'Partial month (only what is in the data)']]), { title: 'Month by month', id: 'sp-range-chart' });
    }
    const reconcile = per.start ? `<p class="fine">Checking against a statement or an earlier total? <a id="sp-reconcile" href="${esc(ctx.href('review', { queue: 'reconcile', start: E.months.start(per.start), end: E.months.end(per.end) }))}">Reconcile this total</a> (${esc(fmt.date(E.months.start(per.start)))} – ${esc(fmt.date(E.months.end(per.end)))}).</p>` : '';
    const metrics = `<div class="metrics sp-metrics">
      ${c.metric({ label: 'Total spending', value: fmt.money(total), sub: `<a href="${esc(L.at({ period: pv, list: '1' }))}">${count(rows.length, 'transaction')}</a>` })}
      ${c.metric({ label: 'Per month', value: fmt.money(perMonthOf(null)), sub: fullMonths.length ? `Average of ${count(fullMonths.length, 'complete month')}` : 'No complete month in this period' })}
      ${c.metric({ label: 'Months', value: String(per.months.length), sub: [partials.length ? count(partials.length, 'partial month') : '', unknownMonths.length ? count(unknownMonths.length, 'unknown month') : ''].filter(Boolean).join(' · ') || 'All complete', status: partials.length || unknownMonths.length ? c.badge(unknownMonths.length ? 'Includes unknown months' : 'Includes partial months', 'warn') : '' })}
    </div>`;
    const body = `<div class="stack">
      ${unknownNotice(ctx, P, unknownMonths)}
      ${metrics}
      ${c.card(table + notes, { title: 'By category', subtitle: `${esc(per.all ? 'All months' : per.label)} · totals and the monthly average`, id: 'sp-range-cats', cls: 'sp-stack-wrap' })}
      ${chart}
      ${planningNote(ctx, P, per, rows, null)}
      ${notCountedLine(ctx, P, per)}
      ${notCountedCard(ctx, P, per, L)}
      ${whatIfBox(ctx, P, per)}
      ${reconcile}
    </div>`;
    return { crumbs, header, body };
  }

  // ------------------------------------------------------------------ level: category
  function periodCrumbs(P, per, L) {
    const out = [{ label: 'All months', href: L.at({ period: '' }) }];
    if (P.period) out.push({ label: per.all ? 'All months, one total' : per.short, href: L.at({ period: P.period }) });
    return out;
  }
  function catLabel(P, cat) { return P.basis === 'bank' ? `${cat} (bank)` : cat; }

  const validCents = v => Number.isInteger(v) && v >= 0;
  /**
   * What the budget plans for a category in a month: its target plus any bill filed under it
   * (a mortgage or phone bill is planned as a bill, not a target). Bills still being considered
   * ("planned") and bills outside their start/end months are left out, as in planVsActual.
   * An entered-but-unknown amount makes the plan Unknown, never a smaller number.
   */
  function planFor(ctx, cat, month) {
    const plan = ctx.state.plan || {};
    const sources = [];
    const targets = plan.targets || {};
    if (Object.prototype.hasOwnProperty.call(targets, cat) && targets[cat] !== null && targets[cat] !== undefined) {
      sources.push({ kind: 'target', label: 'Target', cents: validCents(targets[cat]) ? targets[cat] : null });
    }
    for (const b of plan.bills || []) {
      if (!b || b.category !== cat || b.status === 'planned' || !E.plan.activeIn(b, month)) continue;
      const who = b.fundedFrom === 'joint' ? '' : b.fundedFrom === 'unknown' ? ' (payer not confirmed)' : ` (paid by ${ctx.person(b.fundedFrom)})`;
      sources.push({ kind: 'bill', label: `${b.label} bill${who}`, cents: validCents(b.monthlyCents) ? b.monthlyCents : null });
    }
    const known = sources.every(s => s.cents !== null);
    return { sources, cents: sources.length && known ? sources.reduce((s, x) => s + x.cents, 0) : null, known };
  }

  function planTile(ctx, cat, month) {
    const p = planFor(ctx, cat, month);
    const bills = p.sources.some(s => s.kind === 'bill');
    const section = bills ? 'bills' : 'targets';
    const link = text => `<a href="${esc(ctx.href('budget', { section }))}">${esc(text)}</a>`;
    if (!p.sources.length) {
      return `<div class="sp-tile sp-tile-target" id="sp-plan-tile"><span class="sp-tile-tag">Your target · plan</span>
        <span class="sp-tile-value">Not set</span><small><a href="${esc(ctx.href('budget', { section: 'targets' }))}">Set a target in Edit plan</a></small></div>`;
    }
    const parts = p.sources.map(s => `${s.label} ${s.cents === null ? 'unknown' : fmt.money(s.cents)}`).join(' + ');
    return `<div class="sp-tile sp-tile-target" id="sp-plan-tile"><span class="sp-tile-tag">${bills ? 'Your plan · budget' : 'Your target · plan'}</span>
      <span class="sp-tile-value">${p.cents === null ? 'Unknown' : money(p.cents)}</span>
      <small>${p.cents === null ? `${esc(parts)}. ${link('Enter the amount in Edit plan')}` : bills ? `a month: ${esc(parts)}. ${link('Change in Edit plan')}` : `a month, from your budget. ${link('Change in Edit plan')}`}</small></div>`;
  }

  /**
   * Percentage for display. Just under the flag threshold it shows one truncated decimal (24.9%)
   * so a typical row never reads as meeting the 25% rule.
   */
  function pctText(p) {
    const limit = (E.compare.RULE && E.compare.RULE.minPct) || 25;
    const a = Math.abs(p);
    if (a < limit && Math.round(a) >= limit) return (p > 0 ? '+' : '−') + (Math.floor(a * 10) / 10).toFixed(1) + '%';
    return fmt.pct(p);
  }

  function compareTiles(ctx, P, L, x, month, cat) {
    // A category with no spending in the selected month or its baseline is absent from the
    // month's comparison; ask for it directly so complete $0 months read as $0, not 'unknown'.
    if (!x && cat) {
      try { x = E.compare.usual(scoped(ctx, P), ctx.dataset, { month, window: P.window, category: cat }).categories.find(c => c.category === cat) || null; } catch { x = null; }
    }
    const targetTile = P.basis === 'bank' ? '' : planTile(ctx, cat, month);
    const usualValue = x ? (x.basis === 'last_year' && x.seasonal ? x.basisCents : x.averageCents) : null;
    const usualSub = !x ? 'No history for this category'
      : x.basis === 'last_year' && x.seasonal ? `${esc(fmt.month(x.seasonal.lastYearMonth))}, same month last year`
        : x.averageCents === null ? 'No complete months before'
          : x.signal === 'irregular' && x.irregular ? `average; only ${esc(fmt.month(x.irregular.month))} had any (${money(x.irregular.cents)})`
            : 'average of complete months before';
    return `<div class="sp-tiles">
      <div class="sp-tile"><span class="sp-tile-tag">${esc(fmt.month(month))}</span><span class="sp-tile-value">${money(x ? x.actualCents : 0)}</span><small>${x ? signalBadge(x.signal) : 'No spending'}</small></div>
      <div class="sp-tile sp-tile-usual"><span class="sp-tile-tag">Usual · history</span><span class="sp-tile-value">${usualValue === null || usualValue === undefined ? 'Not known' : money(usualValue)}</span><small>${usualSub}</small></div>
      ${targetTile}
    </div>${x ? `<p class="sp-explain">${esc(x.explanation)}</p>` : ''}`;
  }

  function levelCategory(ctx, P, per, L) {
    const cat = P.cat;
    const rows = spendRows(ctx, P, per, { merchant: '' });
    const total = sum(rows, t => spendOf(t, cat));
    const merchants = merchantTotals(rows, cat);
    const pv = P.period;
    const periodTotal = per.type === 'month' ? sum(spendRows(ctx, P, per, { cat: '', merchant: '' }), t => spendOf(t)) : null;
    const crumbs = [...periodCrumbs(P, per, L), { label: catLabel(P, cat) }];
    const listHref = L.at({ period: pv, cat, list: '1' });
    const header = {
      eyebrow: `Spending · ${per.type === 'none' ? 'All months' : per.short}${P.basis === 'bank' ? ' · bank category' : ''}`,
      title: cat,
      subtitle: `<strong>${money(total)}</strong> in <a href="${esc(listHref)}">${count(rows.length, 'transaction')}</a>${periodTotal ? ` · ${sharePct(total, periodTotal)} of ${esc(per.label)} spending` : ''}${per.type !== 'month' && per.months.length > 1 ? (() => {
        // Average over complete months only; partial or uncovered months are not low months.
        const full = per.months.filter(m => coverageOf(ctx, m).status === 'full' && !unknownForFilter(ctx, P, m));
        if (!full.length) return ' · per-month average unknown (no complete month)';
        const fullSet = new Set(full);
        const fullCents = sum(rows.filter(t => fullSet.has(t.date.slice(0, 7))), t => spendOf(t));
        const left = per.months.length - full.length;
        return ` · ${money(E.money.divide(fullCents, full.length))} per month over ${count(full.length, 'complete month')}${left ? ` (${count(left, 'partial or unknown month')} left out)` : ''}`;
      })() : ''}.`,
    };

    const table = c.table({
      caption: `Merchants in ${cat}, ${per.label}`,
      columns: [
        { key: 'm', label: 'Merchant', html: r => `<a href="${esc(L.at({ period: pv, cat, merchant: r.key }))}">${esc(r.key)}</a>` },
        { key: 'total', label: 'Total', align: 'right', html: r => `<span class="sp-merchant-total">${money(r.cents)}</span>` },
        { key: 'n', label: 'Records', align: 'right', html: r => ML('Records') + esc(String(r.count)) },
        { key: 'share', label: 'Share of category', align: 'right', html: r => ML('Share') + (total > 0 ? `<span class="sp-share"><span class="sp-share-bar" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, (r.cents * 100) / total)).toFixed(1)}%"></span></span>${sharePct(r.cents, total)}</span>` : '—') },
      ],
      rows: merchants,
      footer: { m: `Total<small><a href="${esc(listHref)}">${count(rows.length, 'transaction')}</a></small>`, total: money(total), n: ML('Records') + esc(String(rows.length)), share: total > 0 ? ML('Share') + '100%' : '' },
      emptyText: `No counted ${cat} spending in ${per.label}.`,
      cls: 'sp-merchants sp-stack',
    });

    let compareCard = '';
    let cmpForNote = null;
    // No comparison for a month the account filter has no data for (the page notice says why).
    if (per.type === 'month' && !unknownForFilter(ctx, P, per.month)) {
      const cmp = comparison(ctx, P, per.month);
      cmpForNote = { categories: cmp.categories.filter(r => r.category === cat) };
      const x = cmp.categories.find(r => r.category === cat) || null;
      const avgText = cmp.usableCount
        ? `${describeMonths(cmp.baselineMonths)} (${fmt.count(cmp.usableCount, 'complete month')})`
        : `${describeMonths(cmp.trailingMonths)} (none complete)`;
      const usedNote = x && x.basis === 'last_year' && x.seasonal
        ? `Compared with ${esc(fmt.monthLong(x.seasonal.lastYearMonth))}, the same month last year. For reference, the average of ${esc(avgText)} was ${x.averageCents === null ? 'not known' : money(x.averageCents)}.`
        : `Usual uses ${esc(avgText)}.`;
      compareCard = c.card(compareTiles(ctx, P, L, x, per.month, cat) + `<p class="fine" id="sp-cat-basis">${usedNote}</p>`,
        { title: 'Compared with usual', id: 'sp-cat-compare', actions: windowControl(P) });
    }

    // Trend: the 12 months up to the selected month (or the period's end). A seasonal category
    // compared with last year gets a 13th month so the month it is compared with is in view.
    const end = per.type === 'month' ? per.month : per.end || ctx.months[ctx.months.length - 1];
    let trendCard = '';
    if (end) {
      const seasonal = P.basis !== 'bank' && E.categories.isSeasonal(cat);
      const first = ctx.months[0];
      let start = E.months.add(end, seasonal && per.type === 'month' ? -12 : -11);
      if (first && start < first) start = first;
      const months = E.months.range(start, end);
      const trend = E.compare.trend(scoped(ctx, P), ctx.dataset, { category: cat, months });
      const partialMs = trend.filter(r => r.coverage.status !== 'full').map(r => r.month);
      trendCard = c.card(chartBlock(c.columnChart({
        title: `${cat} per month`,
        items: trend.map(r => (unknownForFilter(ctx, P, r.month)
          ? { label: r.month, value: null, note: `Unknown: no export from ${filterName(ctx, P)}` }
          : { label: r.month, value: r.spendCents, href: L.at({ period: r.month, cat }), muted: r.coverage.status !== 'full', note: r.coverage.status === 'full' ? '' : 'Partial month: only what is in the data' })),
        highlight: per.type === 'month' ? per.month : undefined,
      })) + chartLegend([['full', 'Complete month'], per.type === 'month' && ['sel', 'Selected month'], partialMs.length && ['partial', 'Partial month']])
        + (seasonal ? `<p class="fine">${esc(cat)} follows the seasons, so a month is compared with the same month last year instead of the recent average.</p>` : ''),
      { title: `${cat}, last ${months.length} months`, subtitle: partialMs.length ? `${esc(describeMonths(partialMs))}: partial coverage, amounts are only what is in the data.` : 'Every month shown is complete.', id: 'sp-cat-trend' });
    }

    const body = `<div class="stack">
      ${compareCard}
      ${c.card(table, { title: 'Merchants', subtitle: 'Select a merchant to see each transaction.', id: 'sp-merchants', cls: 'sp-stack-wrap' })}
      ${trendCard}
      ${planningNote(ctx, P, per, rows, cmpForNote)}
      ${notCountedLine(ctx, P, per, { merchant: '' })}
      ${notCountedCard(ctx, P, per, L)}
    </div>`;
    return { crumbs, header, body };
  }

  // ------------------------------------------------------------------ level: merchant and list
  function levelMerchant(ctx, P, per, L) {
    const cat = P.cat, merchant = P.merchant, pv = P.period;
    const rows = spendRows(ctx, P, per);
    const shownRows = (P.show ? [...rows, ...spendRows(ctx, P, per, { excluded: true })] : rows).sort(byDate);
    const total = sum(rows, t => spendOf(t, cat));
    const crumbs = [...periodCrumbs(P, per, L)];
    if (cat) crumbs.push({ label: catLabel(P, cat), href: L.at({ period: pv, cat }) });
    crumbs.push({ label: merchant });
    const header = {
      eyebrow: `Spending · ${per.type === 'none' ? 'All months' : per.short}${cat ? ' · ' + catLabel(P, cat) : ''}`,
      title: merchant,
      subtitle: `<strong>${money(total)}</strong> counted${cat ? ` in ${esc(cat)}` : ''} from ${count(rows.length, 'transaction')} · ${esc(per.label)}.`,
    };
    const split = cat && rows.some(t => E.ledger.partsOf(t).length > 1);
    const ids = byId(ctx);
    const hrefFor = t => L.href({ txn: t.id });
    // Same rows, same counting rule as the category page: the footer equals the merchant's line there.
    const table = split
      ? txnRows(ctx, L, shownRows, { caption: `${merchant} transactions`, cat, hrefFor })
      : sh().txnTable(ctx, shownRows.map(t => ids.get(t.id) || t), { caption: `${merchant} transactions${cat ? ' in ' + cat : ''}, ${per.label}`, hrefFor });
    const body = `<div class="stack">
      ${split ? c.notice({ tone: 'info', title: 'Some purchases are split', body: `Only the ${esc(cat)} part of a split purchase counts here; the full amount is shown underneath.` }) : ''}
      ${c.card(table, { title: 'Transactions', subtitle: 'Select a transaction to see where it came from and to correct it.', id: 'sp-txns', cls: 'sp-txnlist' })}
      ${notCountedLine(ctx, P, per)}
    </div>`;
    return { crumbs, header, body };
  }

  function levelList(ctx, P, per, L) {
    const cat = P.cat, pv = P.period;
    const rows = spendRows(ctx, P, per, { merchant: '' });
    const shownRows = (P.show ? [...rows, ...spendRows(ctx, P, per, { merchant: '', excluded: true })] : rows).sort(byDate);
    const total = sum(rows, t => spendOf(t, cat));
    const crumbs = [...periodCrumbs(P, per, L)];
    if (cat) crumbs.push({ label: catLabel(P, cat), href: L.at({ period: pv, cat }) });
    crumbs.push({ label: 'All transactions' });
    const header = {
      eyebrow: `Spending · ${per.type === 'none' ? 'All months' : per.short}`,
      title: cat ? `Every ${cat} transaction` : 'Every spending transaction',
      subtitle: `${count(rows.length, 'transaction')} adding up to <strong>${money(total)}</strong> · ${esc(per.label)}.`,
    };
    const table = txnRows(ctx, L, shownRows, { caption: header.title + ', ' + per.label, cat, hrefFor: t => L.href({ txn: t.id }) });
    const body = `<div class="stack">
      ${c.card(table, { title: 'Transactions', subtitle: 'Oldest first, as on a statement. The footer is the total these rows explain.', id: 'sp-txns', cls: 'sp-txnlist' })}
      ${notCountedLine(ctx, P, per, { merchant: '' })}
    </div>`;
    return { crumbs, header, body };
  }

  // ------------------------------------------------------------------ level: search and other kinds
  const SECTIONS = [
    { id: 'spend', title: 'Spending', test: t => t.kind === 'spend', measure: t => spendOf(t), label: 'counted as spending',
      why: 'Purchases, bills and fees. Refunds reduce the total.' },
    { id: 'pay', title: 'Pay', test: t => t.kind === 'income' && t.subtype === 'payroll', measure: t => E.ledger.measure(t).incomeCents, label: 'counted as income',
      why: 'Paychecks deposited into these accounts. Income is never counted as spending.' },
    { id: 'income', title: 'Other income', test: t => t.kind === 'income' && t.subtype !== 'payroll', measure: t => E.ledger.measure(t).incomeCents, label: 'counted as income',
      why: 'Interest, reimbursements and other deposits. A deposit that pays back a charge leaves income once you confirm the match in Data review.' },
    { id: 'saved', title: 'Saved', test: t => t.kind === 'transfer' && (t.subtype === 'savings' || t.subtype === 'investment'), measure: t => E.ledger.measure(t).savedCents, label: 'counted as saved',
      why: 'Money moved into savings. Saving is not spending. A transfer shows on both accounts but is counted once, on the side money leaves.',
      zero: t => (t.accountType === 'savings' ? 'Arrival side; counted on the account it left' : 'Counted on the other side') },
    { id: 'contribution', title: 'Contributions in', test: t => t.kind === 'transfer' && t.subtype === 'contribution', measure: t => E.ledger.measure(t).contributionCents, label: 'counted as money coming in',
      why: 'Money a partner moved in from a personal account outside this data. It is counted as coming in, but not as income a second time.',
      zero: () => 'On a personal account, so not money coming in to the household' },
    { id: 'internal', title: 'Between your accounts', test: t => t.kind === 'transfer' && !['savings', 'investment', 'contribution'].includes(t.subtype), measure: () => 0, label: 'not counted',
      why: 'Money moving between your own accounts. It is not income, spending or saving, so it is not counted.',
      zero: () => 'Moves money between your own accounts' },
    { id: 'debt', title: 'Debt payments', test: t => t.kind === 'debt_payment', measure: t => E.ledger.measure(t).debtCents, label: 'counted as debt payments',
      why: 'Loan and financing payments whose original purchase is not in the data. They are shown apart from category spending.' },
    { id: 'card', title: 'Card payments', test: t => t.kind === 'card_payment', measure: t => (t.excluded || t.accountType === 'credit_card' ? 0 : -t.amountCents), label: 'paid toward cards, not spending',
      why: "Paying a card bill only moves money: the card's purchases are already counted as spending. Each payment shows on the bank and on the card; the total counts the bank side once.",
      zero: t => (t.accountType === 'credit_card' ? 'Card side; the bank side is counted' : 'Counted on the other side') },
  ];

  function sectionsFor(rows) {
    return SECTIONS.map(s => ({ ...s, rows: rows.filter(s.test) })).filter(s => s.rows.length);
  }

  function listingCards(ctx, P, L, rows, per) {
    const sections = sectionsFor(rows);
    if (!sections.length) return c.empty(P.q ? `Nothing matches “${esc(P.q)}” in ${esc(per.label)}.` : `No ${esc(KIND_BY[P.kind].label.toLowerCase())} in ${esc(per.label)}.`);
    return sections.map(s => {
      const counted = s.rows.filter(t => !t.excluded);
      const total = sum(counted, s.measure);
      const table = txnRows(ctx, L, s.rows, {
        caption: `${s.title}, ${per.label}`,
        amount: t => (t.excluded ? 0 : s.measure(t)),
        footerLabel: s.label,
        kindColumn: s.id !== 'spend',
        hrefFor: t => L.href({ txn: t.id }),
        zeroReason: s.zero,
      });
      return c.card(`<p class="fine">${esc(s.why)}</p>${table}`, { title: s.title, subtitle: `${money(total)} ${esc(s.label)} · ${count(counted.length, 'row')}`, id: 'sp-sec-' + s.id, cls: 'sp-txnlist' });
    }).join('');
  }

  function levelSearch(ctx, P, per, L) {
    const k = KIND_BY[P.kind];
    const inPeriod = inMonths(scoped(ctx, P), per.months);
    const all = E.ledger.filter(inPeriod, { query: P.q, includeExcluded: true });
    const matched = all.filter(k.test);
    const shown = (P.show ? matched : matched.filter(t => !t.excluded)).slice().sort((a, b) => -byDate(a, b));
    const hidden = matched.filter(t => t.excluded).length;
    const others = all.length - matched.length;
    const spendCounted = sum(matched, t => spendOf(t));
    const crumbs = [...periodCrumbs(P, per, L), { label: `Search “${P.q}”` }];
    const header = {
      eyebrow: `Search · ${per.type === 'none' ? 'All months' : per.short}${P.kind !== 'spend' ? ' · ' + k.label : ''}`,
      title: `Results for “${P.q}”`,
      subtitle: `<span id="sp-search-summary" role="status">${count(shown.length, 'match', 'matches')} in ${esc(per.label)}${P.kind === 'spend' ? ` · <strong>${money(spendCounted)}</strong> counted spending` : ''}.</span> <a href="${esc(L.href({ q: '' }))}">Clear search</a>`,
    };
    const tips = [];
    if (others > 0) tips.push(`${count(others, 'more match', 'more matches')} in other kinds (income, transfers or payments). <a href="${esc(L.href({ kind: 'all' }))}">Show every kind</a>.`);
    if (hidden > 0) tips.push(`${count(hidden, 'matching row is', 'matching rows are')} not counted (duplicates, reimbursed or business)${P.show ? '; they are shown struck through' : ''}. ${excludedToggle(P)}`);
    if (P.period && !per.all) tips.push(`Searching ${esc(per.label)} only. <a href="${esc(L.href({ period: 'all' }))}">Search all months</a>.`);
    const tipHtml = tips.length ? `<ul class="sp-tips">${tips.map(x => `<li>${x}</li>`).join('')}</ul>` : '';
    const unknownMonths = per.months.filter(m => unknownForFilter(ctx, P, m));
    const hint = /^\$?\d/.test(P.q) ? '' : '<p class="fine">Search matches merchant, bank description, category, bank category, note or account. Type an amount such as 486.60 to find that exact amount.</p>';
    const results = P.kind === 'spend'
      ? c.card(txnRows(ctx, L, shown, { caption: `Spending matching ${P.q}`, hrefFor: t => L.href({ txn: t.id }), emptyText: `No spending matches “${P.q}” in ${per.label}.` }), { title: 'Matching spending', id: 'sp-results', cls: 'sp-txnlist' })
      : listingCards(ctx, P, L, shown, per);
    return { crumbs, header, body: `<div class="stack">${unknownNotice(ctx, P, unknownMonths, P.kind === 'spend' ? 'spending' : 'activity')}${tipHtml}${hint}${results}</div>` };
  }

  function levelKind(ctx, P, per, L) {
    const k = KIND_BY[P.kind];
    let rows = inMonths(scoped(ctx, P), per.months);
    rows = rows.filter(k.test);
    const shown = (P.show ? rows : rows.filter(t => !t.excluded)).sort(byDate);
    const hidden = rows.filter(t => t.excluded).length;
    const s = E.ledger.summarize(rows);
    const unknownMonths = per.months.filter(m => unknownForFilter(ctx, P, m));
    const allUnknown = unknownMonths.length > 0 && unknownMonths.length === per.months.length;
    const crumbs = [...periodCrumbs(P, per, L), { label: k.label }];
    const header = {
      eyebrow: `${P.kind === 'all' ? 'Every kind' : 'Not spending'} · ${per.type === 'none' ? 'All months' : per.short}`,
      title: `${k.label}${per.type === 'none' ? '' : ', ' + (per.type === 'month' ? per.label : per.short)}`,
      subtitle: P.kind === 'all' ? 'Every row of every kind, grouped by how it is counted.' : 'These rows are listed so every figure can be traced. Why each kind is or is not counted as spending is explained with it.',
    };
    const metricsList = [];
    if (['income', 'all'].includes(P.kind)) metricsList.push(c.metric({ label: 'Coming in', value: fmt.money(s.incomeCents + s.contributionsCents), sub: `${money(s.incomeCents)} income (${money(s.payrollCents)} pay) + ${money(s.contributionsCents)} contributions` }));
    if (['transfer', 'all'].includes(P.kind)) metricsList.push(c.metric({ label: 'Saved (net)', value: fmt.money(s.savedNetCents), sub: 'Moved into savings' }));
    if (P.kind === 'transfer') metricsList.push(c.metric({ label: 'Contributions in', value: fmt.money(s.contributionsCents), sub: 'From personal accounts' }));
    if (['debt', 'all'].includes(P.kind)) metricsList.push(c.metric({ label: 'Debt payments', value: fmt.money(s.debtPaymentsCents), sub: 'Not category spending' }));
    if (['card', 'all'].includes(P.kind)) metricsList.push(c.metric({ label: 'Paid toward cards', value: fmt.money(s.cardPaymentsCents), sub: 'Moves money; not spending' }));
    if (P.kind === 'all') metricsList.unshift(c.metric({ label: 'Spending', value: fmt.money(s.spendingCents), sub: `<a href="${esc(L.at({ period: P.period, kind: 'spend' }))}">By category</a>` }));
    const hiddenLine = hidden ? `<div class="sp-excluded-line"><p>${count(hidden, 'row')} not counted (confirmed reimbursements, duplicates or business)${P.show ? '; shown struck through above' : ''}.</p>${excludedToggle(P)}</div>` : '';
    const body = `<div class="stack">
      ${unknownNotice(ctx, P, unknownMonths, P.kind === 'all' ? 'activity' : 'money moved')}
      ${allUnknown ? '' : `<div class="metrics sp-metrics">${metricsList.join('')}</div>`}
      ${allUnknown && !shown.length ? '' : listingCards(ctx, P, L, shown, per)}
      ${hiddenLine}
    </div>`;
    return { crumbs, header, body };
  }

  // ------------------------------------------------------------------ level: transaction
  function flowSentence(t) {
    const acct = t.accountLabel || t.accountId;
    if (t.kind === 'spend') return t.amountCents < 0 ? `Paid from ${acct}.` : `Refunded to ${acct}; it reduces spending.`;
    if (t.kind === 'income') return `Deposited into ${acct}.`;
    if (t.kind === 'card_payment') return t.accountType === 'credit_card' ? `Payment received by ${acct}.` : `Paid from ${acct} to a card.`;
    if (t.kind === 'debt_payment') return `Paid from ${acct} toward a loan or financing.`;
    return t.amountCents > 0 ? `Moved into ${acct}.` : `Moved out of ${acct}.`;
  }

  function countedSentence(t) {
    if (t.excluded) return `Not counted: ${EXCLUDED_TEXT[t.excluded] || 'left out'}.`;
    const m = E.ledger.measure(t);
    switch (t.kind) {
      case 'spend':
        if (m.spendCents < 0) return `Reduces spending by ${money(-m.spendCents)} (a refund).`;
        return `Counts as ${money(m.spendCents)} of spending${t.reimbursedCents ? `; ${money(t.reimbursedCents)} of it was paid back and is not counted` : ''}${t.parts.length > 1 ? `, split across ${count(t.parts.length, 'category', 'categories')}` : ''}.`;
      case 'income': return `Counts as ${money(m.incomeCents)} of income${t.reimbursedCents ? ` (${money(t.reimbursedCents)} paid back a charge and is not counted)` : ''}. Not spending.`;
      case 'debt_payment': return `Counts as a ${money(m.debtCents)} debt payment, shown apart from category spending.`;
      case 'card_payment': return 'Not counted as spending: paying a card bill moves money, and the purchases on the card are the spending.';
      case 'transfer':
        if (t.subtype === 'contribution') return m.contributionCents ? `Counts as ${money(m.contributionCents)} coming in from a personal account. Not income, not spending.` : 'Not counted (a contribution on a personal account).';
        if (t.subtype === 'savings' || t.subtype === 'investment') return m.savedCents ? `Counts as ${money(m.savedCents)} saved. Saving is not spending.` : 'Not counted again: the other side of this transfer is already counted as saved.';
        return 'Not counted: money moving between your own accounts.';
      default: return 'Not counted.';
    }
  }

  function histValue(field, v, person = id => id) {
    if (v === null || v === undefined || v === '') return 'imported value';
    if (field === 'splits' && Array.isArray(v)) return 'split: ' + v.map(p => `${p.category} ${fmt.money(p.cents)}`).join(', ');
    if (field === 'planningBaseline') return v === 'exclude' ? 'left out of planning' : 'included in planning';
    if (field === 'person') return v === 'none' ? 'neither partner' : person(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function histWhen(at) {
    if (!at) return 'Time not recorded';
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return String(at);
    return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function reviewQueue(t) {
    const f = t.flags || [];
    if (t.excluded === 'duplicate' || f.includes('duplicate_candidate')) return 'duplicates';
    if (t.reimbursementStatus || f.includes('reimbursement_candidate')) return 'reimbursements';
    if (t.businessStatus || f.includes('business_candidate')) return 'business';
    if (t.kind === 'transfer' || t.kind === 'card_payment' || f.includes('unpaired_transfer')) return 'transfers';
    if (t.edited) return 'edited';
    return 'uncertain';
  }

  function txnCrumbs(ctx, P, L, t) {
    const period = P.period || t.date.slice(0, 7);
    const per = resolvePeriod(ctx, { ...P, period });
    const out = [{ label: 'All months', href: L.at({ period: '' }) }, { label: per.all ? 'All months, one total' : per.short, href: L.at({ period }) }];
    if (P.q) out.push({ label: `Search “${P.q}”`, href: L.at({ period: P.period, q: P.q }) });
    else if (P.kind !== 'spend') out.push({ label: KIND_BY[P.kind].label, href: L.at({ period }) });
    else if (t.kind === 'spend') {
      const parts = E.ledger.partsOf(t);
      const cat = P.cat || (P.basis === 'bank' ? bankCategory(t) : (parts[0] && parts[0].category) || t.category);
      out.push({ label: catLabel(P, cat), href: L.at({ period, cat }) });
      if (P.list) out.push({ label: 'All transactions', href: L.at({ period, cat: P.cat, list: '1' }) });
      else out.push({ label: P.merchant || merchantOf(t), href: L.at({ period, cat, merchant: P.merchant || merchantOf(t) }) });
    } else {
      const kp = kindParamOf(t);
      out.push({ label: KIND_BY[kp].label, href: L.at({ period, kind: kp }) });
    }
    out.push({ label: `${fmt.date(t.date)} · ${merchantOf(t)}` });
    return out;
  }

  function linkedTxn(ctx, L, id) {
    const o = byId(ctx).get(id);
    if (!o) return `<li><span class="muted">${esc(id)}</span> — not in the loaded data</li>`;
    const href = L.at({ period: o.date.slice(0, 7), txn: o.id, kind: kindParamOf(o) });
    return `<li><a href="${esc(href)}">${esc(fmt.date(o.date))} · ${esc(merchantOf(o))}</a> <span class="sp-linked-meta">${esc(sh().amountText(o))} · ${esc(o.accountLabel || o.accountId)} · ${esc(sh().kindLabel(o))}</span></li>`;
  }

  function levelTxn(ctx, P, per, L) {
    const t = byId(ctx).get(P.txn);
    if (!t) {
      return {
        crumbs: [{ label: 'All months', href: L.at({ period: '' }) }, { label: 'Transaction not found' }],
        header: { eyebrow: 'Transaction', title: 'Transaction not found' },
        body: c.notice({ tone: 'warn', title: 'This transaction is not in the loaded data.', body: 'It may come from a file that is no longer loaded. Any correction you made to it is kept and listed in Data review.', actions: c.linkButton('Back to spending', L.at({ period: P.period }), { variant: 'secondary' }) + c.linkButton('Open Data review', ctx.href('review', { queue: 'edited' }), { variant: 'ghost' }) }),
      };
    }
    const edit = t.edit || null;
    const conf = CONFIDENCE_TEXT[t.confidence] || [humanize(t.confidence), 'neutral', ''];
    const parts = E.ledger.partsOf(t);
    const txDate = /Transaction date (\d{4}-\d{2}-\d{2})/.exec(t.baseNote || '');
    const flags = (t.flags || []).map(f => {
      const legacy = f.startsWith('legacy:');
      const text = legacy ? `Carried over from the earlier version of this app (${f.slice(7)}).` : FLAG_TEXT[f] || 'No further explanation.';
      return `<li><strong>${esc(legacy ? 'Earlier flag' : humanize(f))}</strong> — ${esc(text)}</li>`;
    });
    const catWhy = [];
    if (edit && edit.category) catWhy.push(`<strong>Changed by you:</strong> ${esc(edit.categoryReason || 'no reason recorded')}. Imported as ${esc(t.baseCategory)}.`);
    if (t.categoryReason) catWhy.push(`${edit && edit.category ? 'Import reason: ' : ''}${esc(t.categoryReason)}`);
    const status = [];
    if (t.excluded) status.push(`Not counted: ${esc(EXCLUDED_TEXT[t.excluded] || t.excluded)}.`);
    if (t.planningExcluded) status.push('Left out of planning baselines (actual spending unchanged).');
    if (t.reimbursementStatus) status.push(`Reimbursement: ${esc({ pending: 'possible match, not decided yet', confirmed: 'confirmed as paid back', not_reimbursed: 'confirmed as not paid back' }[t.reimbursementStatus] || t.reimbursementStatus)}.`);
    if (t.businessStatus) status.push(`Business: ${esc({ pending: 'possible business cost, not decided yet', business: 'business cost (not counted)', household: 'household cost (counted)' }[t.businessStatus] || t.businessStatus)}.`);

    const facts = [
      ['Amount', `<strong class="sp-amount">${esc(sh().amountText(t))}</strong><small>${esc(flowSentence(t))}</small>`],
      ['Counted as', countedSentence(t)],
      ['Posted date', `${esc(fmt.date(t.date))}${txDate ? `<small>Transaction date ${esc(fmt.date(txDate[1]))}</small>` : ''}`],
      ['Bank description', `<code class="sp-raw">${esc(t.description)}</code>`],
      ['Merchant', esc(merchantOf(t))],
      ['Account', `${esc(t.accountLabel || t.accountId)}<small>${esc(humanize(t.accountType || 'unknown'))} · ${esc(t.accountScope === 'personal' ? 'personal' : 'joint')}</small>`],
      ['Kind', `${esc(sh().kindLabel(t))}${t.kind !== t.baseKind ? `<small>Imported as ${esc(sh().KIND_LABEL[t.baseKind] || t.baseKind)}</small>` : ''}`],
      ['Category', `${esc(parts.length > 1 ? 'Split: ' + parts.map(p => `${p.category} ${fmt.money(p.spendCents)}`).join(', ') : t.category)}`],
      ['Why this category', catWhy.length ? catWhy.map(x => `<span class="sp-block">${x}</span>`).join('') : '<span class="muted">No reason recorded</span>'],
      ['Original bank category', t.sourceCategory ? esc(t.sourceCategory) : '<span class="muted">None — this export has no category column</span>'],
      ['Confidence', `${c.badge(conf[0], conf[1])} <span class="fine">${esc(conf[2])}</span>`],
      ['Flags', flags.length ? `<ul class="sp-flag-list">${flags.join('')}</ul>` : '<span class="muted">None</span>'],
    ];
    if (status.length) facts.push(['Status', status.map(x => `<span class="sp-block">${x}</span>`).join('')]);
    const note = String(t.note || '').replace(/Transaction date \d{4}-\d{2}-\d{2}\.\s*/, '').trim();
    if (note) facts.push(['Note', esc(note)]);
    if (t.editWarnings && t.editWarnings.length) facts.push(['Correction notes', t.editWarnings.map(w => `<span class="sp-block">${esc(w)}</span>`).join('')]);
    facts.push(['Source', t.sourceFile ? `${esc(t.sourceFile)}${t.sourceRow ? `, line ${esc(String(t.sourceRow))}` : ''}` : '<span class="muted">Unknown</span>']);
    facts.push(['Record id', `<code class="sp-raw">${esc(t.id)}</code>`]);
    const factsHtml = `<dl class="sp-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

    // Linked rows: the counterpart of a transfer or card payment and reimbursement matches.
    const linked = [];
    if (t.pairId) linked.push(`<h3>Other side of this ${t.kind === 'card_payment' ? 'card payment' : 'transfer'}</h3><ul class="sp-linked">${t.pairMissing ? `<li><span class="muted">${esc(t.pairId)}</span> — not in the loaded data, so this row is counted on its own.</li>` : linkedTxn(ctx, L, t.pairId)}</ul>`);
    if (t.matchIds && t.matchIds.length) linked.push(`<h3>Possible reimbursement match${t.matchIds.length === 1 ? '' : 'es'}</h3><ul class="sp-linked">${t.matchIds.map(id => linkedTxn(ctx, L, id)).join('')}</ul>`);
    const linkedCard = linked.length ? c.card(linked.join(''), { title: 'Linked transactions', id: 'sp-linked' }) : '';

    // Actions
    const isSpend = t.kind === 'spend';
    const catAction = isSpend
      ? `<h3>Change category</h3>${sh().categoryForm(ctx, t, { idPrefix: 'sp-cat' })}`
      : `<h3>Category</h3><p class="fine">Categories apply to spending. This row is ${esc(sh().kindLabel(t).toLowerCase())}; to change what kind of row it is, use Data review.</p>`;
    const planReasonId = 'sp-plan-reason';
    const planAction = !isSpend ? '' : `<h3>Planning baseline</h3>
      <p class="fine">${t.planningExcluded ? 'This purchase is left out of the averages your budget plans from. It still counts as actual spending.' : 'Leave one-off costs (a repair, a trip) out of the averages your budget plans from. Actual spending stays the same.'}</p>
      <div class="sp-plan-row"><div class="field"><label for="${planReasonId}">Reason <span class="fine">(required)</span></label><input id="${planReasonId}" maxlength="200" placeholder="${t.planningExcluded ? 'e.g. It recurs after all' : 'e.g. One-off roof repair'}" autocomplete="off"></div>
      <button type="button" class="btn btn-secondary" id="sp-plan-btn" data-action="ledger:set" data-txn="${esc(t.id)}" data-field="planningBaseline" data-value="${t.planningExcluded ? '' : 'exclude'}" data-reason-from="${planReasonId}" data-message="${t.planningExcluded ? 'Included in planning baselines again.' : 'Left out of planning baselines. Actual spending is unchanged.'}">${t.planningExcluded ? 'Include in planning again' : 'Leave out of planning'}</button></div>`;
    const reviewAction = `<h3>Decide in Data review</h3><p class="fine">Duplicates, reimbursements, business costs, transfers and splits are decided there.</p>${c.linkButton('Open in Data review', ctx.href('review', { queue: reviewQueue(t), txn: t.id }), { variant: 'secondary' })}`;
    const revertAction = t.edited ? `<h3>Undo your corrections</h3><p class="fine">Go back to the imported values. The history below is kept.</p><button type="button" class="btn btn-danger" id="sp-revert" data-action="ledger:revert" data-txn="${esc(t.id)}">Revert to imported values</button>` : '';
    const actionsCard = c.card(`<div class="sp-actions">${[catAction, planAction, reviewAction, revertAction].filter(Boolean).map(x => `<div class="sp-action">${x}</div>`).join('')}</div>`, { title: 'Correct or decide', id: 'sp-txn-actions' });

    const history = edit && Array.isArray(edit.history) ? edit.history.slice().reverse() : [];
    const historyCard = c.card(history.length ? c.table({
      caption: 'Correction history, newest first',
      columns: [
        { key: 'at', label: 'When', html: h => `<span class="nowrap">${esc(histWhen(h.at))}</span>` },
        { key: 'field', label: 'What changed', html: h => esc(FIELD_LABEL[h.field] || humanize(h.field)) },
        { key: 'change', label: 'From → to', html: h => `${esc(histValue(h.field, h.from, ctx.person))} <span aria-hidden="true">→</span><span class="sr-only"> to </span> <strong>${esc(histValue(h.field, h.to, ctx.person))}</strong>` },
        { key: 'reason', label: 'Reason', html: h => (h.reason ? esc(h.reason) : '<span class="muted">None given</span>') },
      ],
      rows: history,
      cls: 'sp-history',
    }) : `<p class="muted">No corrections yet. Changes you make are listed here with the reason, so you can both see why a number changed.</p>`, { title: 'Correction history', id: 'sp-history', cls: 'sp-history-card' });

    const header = {
      eyebrow: 'Transaction',
      title: merchantOf(t),
      subtitle: `${esc(fmt.date(t.date))} · ${esc(t.accountLabel || t.accountId)} · <strong>${esc(sh().amountText(t))}</strong> ${sh().badges(t)}`
        // Where the details and actions stack (phones, tablets) the actions are far down the page.
        + `<button type="button" class="btn btn-small btn-secondary sp-jump" id="sp-jump-actions" data-action="spending:jump" data-target="sp-txn-actions-h">${isSpend ? 'Change category or decide' : 'Correct or decide'} <span aria-hidden="true">↓</span></button>`,
    };
    const body = `<div class="stack">
      <div class="sp-txn-grid">
        <div class="stack">${c.card(factsHtml, { title: 'Details', id: 'sp-details' })}</div>
        <div class="stack">${actionsCard}</div>
      </div>
      ${linkedCard}
      ${historyCard}
    </div>`;
    return { crumbs: txnCrumbs(ctx, P, L, t), header, body };
  }

  // ------------------------------------------------------------------ render
  const LEVELS = {
    months: levelMonths, month: levelMonth, range: levelRange, category: levelCategory,
    merchant: levelMerchant, list: levelList, search: levelSearch, kind: levelKind, txn: levelTxn,
  };

  function render(ctx) {
    const P = readParams(ctx);
    const L = makeLinks(ctx, P);
    const per = resolvePeriod(ctx, P);
    const level = levelOf(P, per);
    const out = LEVELS[level](ctx, P, per, L);
    const notes = [];
    for (const n of P.notes) notes.push(c.notice({ tone: 'warn', title: 'Part of this link was not understood', body: esc(n) }));
    if (P.basis === 'bank' && level !== 'txn') notes.push(c.notice({ tone: 'info', title: "Showing the bank's original categories", body: 'Your household rules and category corrections are not applied to category names here. Amounts, exclusions and splits still are. Rows without a bank category (most checking rows) are grouped as “No bank category”.' }));
    if (P.scope && !P.acct && level !== 'txn') {
      notes.push(c.notice({ tone: 'info', title: P.scope === 'joint' ? 'Joint accounts only' : 'Personal accounts only', body: P.scope === 'joint' ? 'Shared household accounts only, as on the Overview. Pay and bills that go through personal accounts are not here.' : 'Personal accounts only. Whether a month is complete still depends on every spending account.' }));
    }
    if (P.acct && level !== 'txn') {
      const a = ctx.dataset.accounts.find(x => x.id === P.acct);
      notes.push(c.notice({ tone: 'info', title: `Only ${a ? a.label : P.acct}`, body: 'Totals and usual amounts use this account alone. Whether a month is complete still depends on every spending account.' }));
    }
    if (per.type === 'month' && ['category', 'merchant', 'list'].includes(level) && unknownForFilter(ctx, P, per.month)) {
      notes.push(unknownNotice(ctx, P, [per.month]));
    } else if (level === 'month' && unknownForFilter(ctx, P, per.month)) {
      notes.push(unknownNotice(ctx, P, [per.month]));
    }
    const banner = whatIfBanner(ctx);
    // data-route / data-rev say which URL and which saved state this markup was drawn for, so
    // tests (and anyone debugging) can wait for the page to catch up with a navigation or a change.
    return `<div class="sp sp-level-${esc(level)}" data-route="${esc(routeKey(ctx.route && ctx.route.params))}" data-rev="${esc((ctx.state.meta && ctx.state.meta.updatedAt) || '')}">
      ${c.breadcrumbs(out.crumbs)}
      ${c.pageHeader(out.header)}
      ${filtersBar(ctx, P, L)}
      ${banner || notes.length ? `<div class="stack-sm sp-notes">${banner}${notes.join('')}</div>` : ''}
      ${out.body}
    </div>`;
  }

  /** Route params as one canonical string (sorted keys), independent of their order in the URL. */
  function routeKey(params) {
    const p = params || {};
    return Object.keys(p).sort().map(k => k + '=' + p[k]).join('&');
  }

  // ------------------------------------------------------------------ actions
  /** Element to focus after the next render (an action's own control may disappear or lack an id). */
  let focusAfter = null;
  function afterRender(rootEl) {
    if (!focusAfter) return;
    const el = document.getElementById(focusAfter);
    focusAfter = null;
    if (el && rootEl.contains(el)) el.focus({ preventScroll: true });
  }

  function go(ctx, over, { replace = false } = {}) {
    const P = readParams(ctx);
    ctx.app.navigate('spending', makeLinks(ctx, P).params(over), { keepFocus: true, replace });
  }

  // The history entry the last filter change made. Arrowing through a closed select changes it
  // once per option: those steps replace that entry, so one Back returns to before the filter.
  let lastFilterStep = null;

  const actions = {
    /** Period, account and kind selects. */
    'spending:filter': (ctx, el) => {
      const param = el.dataset.param;
      const value = el.value;
      const replace = !!lastFilterStep && lastFilterStep.param === param && lastFilterStep.hash === location.hash;
      if (param === 'period') go(ctx, { period: value, txn: '' }, { replace });
      else if (param === 'acct') go(ctx, value.startsWith('scope:') ? { acct: '', scope: value.slice(6), txn: '' } : { acct: value, scope: '', txn: '' }, { replace });
      else if (param === 'kind') go(ctx, { kind: value, cat: '', merchant: '', list: '', txn: '' }, { replace });
      lastFilterStep = { param, hash: location.hash };
    },
    /** Search form (submit only: clicks inside the form also reach form-level actions). */
    'spending:search': (ctx, form, ev) => {
      if (!ev || ev.type !== 'submit') return;
      const q = String(new FormData(form).get('q') || '').trim();
      go(ctx, { q, cat: '', merchant: '', list: '', txn: '' });
    },
    'spending:window': (ctx, el) => go(ctx, { window: el.dataset.value || el.value }),
    'spending:basis': (ctx, el) => go(ctx, { basis: el.dataset.value || el.value, cat: '', merchant: '' }),
    /** Move to a section further down the page (in-page #anchors would change the route). */
    'spending:jump': (ctx, el) => {
      const target = document.getElementById(el.dataset.target);
      if (!target) return;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.scrollIntoView({ block: 'start' });
      target.focus({ preventScroll: true });
    },
    'spending:toggle-excluded': ctx => {
      const P = readParams(ctx);
      go(ctx, { show: P.show ? '' : 'excluded' });
    },
    /**
     * The shared category form, run on submit only. A click anywhere inside a form that carries
     * data-action also reaches the action (app click delegation), which would save twice or
     * complain about a missing reason while the person is still typing.
     */
    'ledger:set-category': (ctx, form, ev) => {
      if (!ev || ev.type !== 'submit') return undefined;
      const select = form.querySelector('select');
      focusAfter = select && select.id ? select.id : null;
      return UI.sharedActions['ledger:set-category'](ctx, form, ev);
    },
    /** Shared revert; afterwards focus moves to the category control (the revert button disappears). */
    'ledger:revert': (ctx, el, ev) => {
      focusAfter = `sp-cat-${el.dataset.txn}-sel`;
      return UI.sharedActions['ledger:revert'](ctx, el, ev);
    },
  };

  UI.views = UI.views || {};
  UI.views.spending = { title: 'Spending', render, actions, afterRender };
})(typeof globalThis !== 'undefined' ? globalThis : this);
