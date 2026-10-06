'use strict';
/*
 * Data review: the queues of transactions that need a human decision, and the record of every
 * decision made.
 *
 *   index           every queue with its count, one-line explanation and money at stake,
 *                   highest priority first, plus plan inputs that are still unknown
 *   uncertain       categories the import could not place (bank category always shown)
 *   mixed           mixed-retail purchases: keep, set a category, or split into exact parts
 *   duplicates      possible duplicates side by side: keep both, or stop counting the second copy
 *   transfers       unpaired transfers that need an answer; paired transfers explained
 *   reimbursements  charge + matching deposit: pending / reimbursed / not reimbursed
 *   business        possible business purchases, decided in bulk with one reason
 *   spikes          unusual category-months: leave out of (or keep in) the planning baseline
 *   coverage        month × account coverage; partial months are never treated as $0
 *   edited          corrections log: full history with reasons, and Revert
 *   reconcile       an outside total (statement, earlier budget) next to the app's spending
 *
 * Route: #/review?queue=…&txn=…&merchant=…&status=…&page=…&ref=…&start=…&end=…
 * Nothing here changes the imported data. Every decision is a ledger edit made with
 * BudgetEngine.review.editRecord (through UI.shared.editMany), carries a reason, is kept in the
 * history and can be undone from the toast.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc, domId } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const sh = () => UI.shared;

  // ------------------------------------------------------------------ queue catalogue
  const QUEUES = {
    uncertain: { tab: 'Uncertain', title: 'Uncertain categories', type: 'decision', line: 'Purchases and deposits the import could not place with confidence.' },
    mixed: { tab: 'Mixed retail', title: 'Mixed retail', type: 'decision', line: 'Stores that sell many kinds of goods. What you bought is never guessed from the store name.' },
    duplicates: { tab: 'Duplicates', title: 'Possible duplicates', type: 'decision', line: 'Same amount on the same account within 3 days. Both copies count until you decide.' },
    transfers: { tab: 'Transfers', title: 'Transfers', type: 'decision', line: 'Money that moved without a matching transaction on another of your accounts.' },
    reimbursements: { tab: 'Reimbursements', title: 'Reimbursements', type: 'decision', line: 'Charges a later deposit may have paid back. Both count until you confirm.' },
    business: { tab: 'Business', title: 'Business costs', type: 'decision', line: 'Purchases that may be business costs. Counted as household spending until you decide.' },
    spikes: { tab: 'Spikes', title: 'Unusual spikes', type: 'decision', line: 'Months where a category was far above its usual level. You choose whether plans use them.' },
    coverage: { tab: 'Coverage', title: 'Coverage', type: 'info', line: 'Months where an account export is missing days. They are left out of averages, never counted as $0.' },
    edited: { tab: 'Corrections', title: 'Corrections log', type: 'info', line: 'Every correction: what changed, when and why. Each one can be reverted.' },
    reconcile: { tab: 'Reconcile', title: 'Reconcile', type: 'tool', line: 'Compare a total from a statement or an earlier budget with what the app counts.' },
  };
  const TAB_ORDER = ['uncertain', 'mixed', 'duplicates', 'transfers', 'reimbursements', 'business', 'spikes', 'coverage', 'edited', 'reconcile'];
  /** Index order: what changes totals first, then categories, then information and tools. */
  const PRIORITY = ['duplicates', 'uncertain', 'transfers', 'reimbursements', 'business', 'spikes', 'mixed', 'coverage', 'edited', 'reconcile'];
  const ALIASES = { mixedRetail: 'mixed', 'mixed-retail': 'mixed', corrections: 'edited', log: 'edited', spike: 'spikes' };

  const PAGE_SIZE = { mixed: 25, edited: 20 };
  const MATCH_TOLERANCE = 100; // "equals the difference" means within $1
  const BOUNDARY_DAYS = 14;    // look this far past a period's end for rows bought inside it

  const REASONS = {
    category: ['Checked the receipt', 'Bank category was wrong', 'Known recurring bill', 'Merchant sells only this'],
    kind: ['Checked the bank app', 'Asked my partner', 'Matches a statement', 'Known transfer'],
    duplicate: ['Same charge listed twice', 'Two real purchases', 'Checked the card statement'],
    reimbursement: ['Employer paid it back', 'Friend paid back their share', 'Insurance paid it back', 'Not paid back'],
    business: ['Bought for work', 'Bought for the house', 'Checked the receipt'],
    planning: ['One-off, not expected again', 'Will happen again', 'Already planned separately'],
    split: ['Checked the receipt', 'Itemized order history'],
    mixed: ['Contents not known', 'Mostly everyday shopping'],
  };

  const FIELD_LABEL = {
    category: 'Category', kind: 'Kind', subtype: 'Type', splits: 'Split', duplicate: 'Duplicate',
    reimbursement: 'Reimbursement', business: 'Business', planningBaseline: 'Planning baseline', person: 'Whose money', note: 'Note',
  };
  const VALUE_LABEL = {
    duplicate: { exclude: 'Not counted (duplicate)', keep: 'Not a duplicate' },
    reimbursement: { pending: 'Pending', confirmed: 'Reimbursed (not counted)', not_reimbursed: 'Not reimbursed' },
    business: { pending: 'Pending', business: 'Business (not counted)', household: 'Household' },
    planningBaseline: { exclude: 'Left out of planning baseline', include: 'Kept in planning baseline' },
    person: { p1: 'First partner', p2: 'Second partner', none: 'Neither partner' },
  };

  /** Answers for money moving in or out without a matching account. */
  const IN_CHOICES = [
    { key: 'contribution', kind: 'transfer', subtype: 'contribution', label: "From a partner's personal account", short: 'a contribution from a personal account',
      effect: (a, m) => `Counts as ${a} coming in from a personal account (contributions). Not income; spending unchanged.` },
    { key: 'savings', kind: 'transfer', subtype: 'savings', label: 'From our savings', short: 'money moved from savings',
      effect: a => `Money back from savings: ${a} less saved. Not income; spending unchanged.` },
    { key: 'income', kind: 'income', subtype: 'other', label: 'Income', short: 'income',
      effect: (a, m) => `Counts as ${a} of income in ${m}. Spending unchanged.` },
    { key: 'refund', kind: 'spend', subtype: null, label: 'A refund', short: 'a refund', needsCategory: true,
      effect: (a, m) => `Lowers ${m} spending by ${a} in the category you choose.` },
  ];
  const OUT_CHOICES = [
    { key: 'savings', kind: 'transfer', subtype: 'savings', label: 'To our savings', short: 'money moved to savings',
      effect: a => `Counts as ${a} saved. Saving is not spending.` },
    { key: 'spend', kind: 'spend', subtype: null, label: 'Spending', short: 'spending', needsCategory: true,
      effect: (a, m) => `Adds ${a} to ${m} spending in the category you choose.` },
    { key: 'contribution', kind: 'transfer', subtype: 'contribution', label: "To a partner's personal account", short: 'money sent to a personal account',
      effect: a => `Lowers contributions coming in by ${a}. Not spending.` },
  ];

  // ------------------------------------------------------------------ small helpers
  const money = (cents, opts) => esc(fmt.money(cents, opts));
  const count = (n, one, many) => esc(fmt.count(n, one, many));
  const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);
  const monthOf = t => t.date.slice(0, 7);
  const merchantOf = t => t.merchant || t.description || 'Unknown merchant';
  const spendOf = t => E.ledger.measure(t).spendCents;
  /** What a spending row costs before any decision (excluded rows measure 0). */
  const grossSpend = t => (t.kind === 'spend' ? -t.amountCents : 0);
  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const txnHref = (ctx, t) => ctx.href('spending', { period: monthOf(t), txn: t.id });
  const qHref = (ctx, queue, extra = {}) => ctx.href('review', { queue, ...extra });
  const hid = key => 'rv-h-' + key;
  const hasActive = edit => !!edit && Object.keys(edit).some(k => k !== 'history' && edit[k] !== undefined && edit[k] !== null);
  const lowerFirst = s => String(s).charAt(0).toLowerCase() + String(s).slice(1);
  const findTxn = (ctx, id) => ctx.txns.find(t => t.id === id) || null;
  const windowOf = ctx => {
    const w = ctx.state.plan.settings && ctx.state.plan.settings.comparisonWindow;
    return Number.isInteger(w) && w >= 1 && w <= 36 ? w : 3;
  };
  function monthTotals(ctx, month) {
    return ctx.memo('rv-mt:' + month, () => E.ledger.summarize(E.ledger.filter(ctx.txns, { months: [month] })));
  }
  function byIdMap(ctx) {
    return ctx.memo('rv-byid', () => new Map(ctx.txns.map(t => [t.id, t])));
  }
  function whenText(at) {
    if (!at) return 'Time not recorded';
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return String(at);
    return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  }

  // ------------------------------------------------------------------ route params
  function readParams(ctx) {
    const raw = (ctx.route && ctx.route.params) || {};
    const notes = [];
    let queue = '';
    const rq = ALIASES[raw.queue] || raw.queue;
    if (rq) {
      if (QUEUES[rq]) queue = rq;
      else notes.push(`The queue “${raw.queue}” is not one this page knows, so the list of all queues is shown.`);
    }
    const page = /^\d+$/.test(String(raw.page || '')) ? Math.max(1, Number(raw.page)) : 0;
    let start = '', end = '';
    if (raw.start || raw.end) {
      if (E.dates.isDate(raw.start) && E.dates.isDate(raw.end)) {
        start = raw.start <= raw.end ? raw.start : raw.end;
        end = raw.start <= raw.end ? raw.end : raw.start;
      } else notes.push('The period in this link was not understood. Use two dates such as 2026-03-01 and 2026-03-31.');
    }
    return {
      queue, notes, page, start, end,
      txn: String(raw.txn || ''),
      merchant: String(raw.merchant || ''),
      status: ['pending', 'business', 'household', 'all'].includes(raw.status) ? raw.status : '',
      ref: String(raw.ref || ''),
      from: QUEUES[raw.from] ? raw.from : '',
    };
  }

  function paginate(list, page, size) {
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = Math.min(Math.max(1, page || 1), pages);
    return { items: list.slice((p - 1) * size, p * size), page: p, pages, from: list.length ? (p - 1) * size + 1 : 0, to: Math.min(list.length, p * size), total: list.length };
  }

  /** A link that changes a review param without jumping to the top: focus lands on the list. */
  function goLink(ctx, label, params, { id, cls = '', current = false, focus = 'rv-list-h', sr = '' } = {}) {
    return `<a href="${esc(ctx.href('review', params))}"${id ? ` id="${esc(id)}"` : ''} class="${esc(cls)}" data-action="review:go" data-params="${esc(JSON.stringify(params))}" data-focus="${esc(focus)}"${current ? ' aria-current="true"' : ''}>${label}${sr ? `<span class="sr-only">${esc(sr)}</span>` : ''}</a>`;
  }

  function pager(ctx, P, pg, extra, what) {
    if (pg.pages <= 1) return '';
    const link = (p, text, dir) => goLink(ctx, text, { queue: P.queue, ...extra, page: String(p) }, { id: 'rv-page-' + dir, cls: 'btn btn-small btn-secondary', sr: ` (page ${p} of ${pg.pages})` });
    return `<nav class="rv-pager" aria-label="${esc(what)} pages">
      ${pg.page > 1 ? link(pg.page - 1, '<span aria-hidden="true">‹</span> Previous', 'prev') : '<span></span>'}
      <span class="rv-pager-text">${esc(`${pg.from}–${pg.to} of ${pg.total}`)}<small>${esc(`Page ${pg.page} of ${pg.pages}`)}</small></span>
      ${pg.page < pg.pages ? link(pg.page + 1, 'Next <span aria-hidden="true">›</span>', 'next') : '<span></span>'}
    </nav>`;
  }

  // ------------------------------------------------------------------ open items per queue
  /** Unpaired transfers still needing an answer. The engine keeps a row "not expected" even after
   *  the household says what it is (only a contribution clears it), so an answered row is done. */
  const answeredTransfer = u => !!(u.edit && u.edit.kind);
  function openTransfers(q) {
    return (q.transfers.unpaired || []).filter(u => !u.expected && !answeredTransfer(u));
  }
  /** Uncertain rows that still need an answer. A row that counts nowhere (a confirmed
   *  reimbursement, a business cost) cannot change any total, so it is not asked about. The
   *  engine still lists it (reported); this filter does nothing once that changes. */
  const NOT_COUNTED = ['reimbursed', 'business'];
  function uncertainOpen(q) {
    return q.uncertain.filter(t => !NOT_COUNTED.includes(t.excluded));
  }
  function spikeState(ctx, s) {
    const map = byIdMap(ctx);
    const vals = s.ids.map(id => (map.get(id) && map.get(id).edit ? map.get(id).edit.planningBaseline || null : null));
    if (vals.length && vals.every(v => v === 'exclude')) return 'exclude';
    if (vals.length && vals.every(v => v === 'include')) return 'include';
    if (vals.some(v => v)) return 'mixed';
    return null;
  }
  function allReferences(ctx) {
    const user = (ctx.state.references || []).map(r => ({ ...r, origin: 'user' }));
    const data = (ctx.dataset.references || []).map(r => ({ ...r, origin: 'data' }));
    // References written into the household profile (e.g. a total from an earlier analysis).
    const taken = new Set([...user, ...data].map(r => r.id));
    const profile = ((ctx.profile && ctx.profile.references) || [])
      .filter(r => r && r.id && !taken.has(r.id) && E.dates.isDate(r.start) && E.dates.isDate(r.end) && Number.isInteger(r.spendingCents))
      .map(r => ({ ...r, origin: 'profile' }));
    return [...user, ...data, ...profile];
  }

  function queueInfo(ctx, q) {
    return ctx.memo('rv-info', () => {
      const unc = uncertainOpen(q);
      const uncSpend = unc.filter(t => t.kind === 'spend');
      const uncOther = unc.filter(t => t.kind !== 'spend');
      const tOpen = openTransfers(q);
      const rPending = q.reimbursements.filter(r => r.status === 'pending');
      const bPending = q.business.filter(t => t.status === 'pending');
      const sOpen = q.spikes.filter(s => !spikeState(ctx, s));
      const dupCents = sum(q.duplicates, d => Math.max(0, spendOf(d.txns[1])));
      const refs = allReferences(ctx);
      const uncParts = [];
      if (uncSpend.length) uncParts.push(`${money(sum(uncSpend, spendOf))} of spending in an uncertain category`);
      if (uncOther.length) uncParts.push(`${count(uncOther.length, 'deposit or transfer', 'deposits or transfers')} to identify`);
      return {
        uncertain: { open: unc.length, impact: uncParts.join(' · ') },
        mixed: { open: q.mixedRetail.length, impact: q.mixedRetail.length ? `${money(sum(q.mixedRetail, spendOf))} of spending with no specific category` : '' },
        duplicates: { open: q.duplicates.length, impact: q.duplicates.length ? `${money(dupCents)} would leave spending if they are copies` : '' },
        transfers: { open: tOpen.length, impact: tOpen.length ? `${money(sum(tOpen, t => Math.abs(t.amountCents)))} moved with no matching account` : q.transfers.paired.length ? `${count(q.transfers.paired.length, 'matched pair')} explained` : '' },
        reimbursements: { open: rPending.length, impact: rPending.length ? `${money(sum(rPending, r => (r.charge ? Math.max(0, spendOf(r.charge)) : 0)))} counted in spending until you confirm` : '' },
        business: { open: bPending.length, impact: bPending.length ? `${money(sum(bPending, grossSpend))} counted as household spending until you decide` : '' },
        spikes: { open: sOpen.length, impact: sOpen.length ? sOpen.slice(0, 2).map(s => `${s.category} ${fmt.month(s.month)} (${fmt.money(s.totalCents, { whole: true })})`).map(esc).join(', ') : '' },
        coverage: { open: q.coverageGaps.length, impact: !ctx.months.length ? 'No data loaded yet' : q.coverageGaps.length ? esc(E.compare.describeMonths(q.coverageGaps.map(g => g.month))) + ' left out of averages' : 'Every month is complete' },
        edited: { open: q.edited.length, impact: q.orphanEdits.length ? `${count(q.orphanEdits.length, 'correction')} for transactions not in the loaded data` : '' },
        reconcile: { open: refs.length, impact: refs.length ? `${count(refs.length, 'reference')} to compare` : 'No reference totals entered yet' },
        stakes: {
          open: q.duplicates.length + unc.length + tOpen.length + rPending.length + bPending.length + sOpen.length,
          changeCents: dupCents + sum(rPending, r => (r.charge ? Math.max(0, spendOf(r.charge)) : 0)) + sum(bPending, grossSpend),
          categoryCents: sum(uncSpend, spendOf) + sum(q.mixedRetail, spendOf),
        },
      };
    });
  }

  function countBadge(key, info, hasData = true) {
    const n = info[key].open;
    const type = QUEUES[key].type;
    // Without data nothing is known to be complete or clear.
    if (!hasData && key !== 'edited' && key !== 'reconcile') return c.badge('No data yet', 'neutral');
    if (key === 'coverage') return n ? c.badge(fmt.count(n, 'partial month'), 'info') : c.badge('All complete', 'good');
    if (key === 'edited') return c.badge(n ? fmt.count(n, 'correction') : 'None yet', 'neutral');
    if (key === 'reconcile') return c.badge(n ? fmt.count(n, 'reference') : 'Tool', 'neutral');
    if (key === 'mixed') return n ? c.badge(`${n} to sort`, 'info') : c.badge('Nothing waiting', 'good');
    if (type === 'decision') return n ? c.badge(`${n} to decide`, 'warn') : c.badge('Nothing waiting', 'good');
    return '';
  }

  // ------------------------------------------------------------------ shared markup
  function tabs(ctx, P, info) {
    const tab = (key, label, n, isOpen) => {
      const current = (P.queue || '') === key;
      const href = key ? qHref(ctx, key) : ctx.href('review');
      const badge = n ? `<span class="rv-tab-count${isOpen ? ' is-open' : ''}" aria-hidden="true">${esc(n > 999 ? '999+' : String(n))}</span><span class="sr-only"> (${esc(String(n))} ${isOpen ? 'to decide' : 'items'})</span>` : '';
      return `<li><a href="${esc(href)}" id="rv-tab-${esc(key || 'all')}"${current ? ' aria-current="page"' : ''}>${esc(label)}${badge}</a></li>`;
    };
    return `<nav class="rv-tabs" aria-label="Review queues"><ul class="section-nav">
      ${tab('', 'All queues', info.stakes.open, true)}
      ${TAB_ORDER.map(k => tab(k, QUEUES[k].tab, k === 'reconcile' ? 0 : info[k].open, QUEUES[k].type === 'decision')).join('')}
    </ul></nav>`;
  }

  /** Transaction heading: merchant (h3), date · account · bank text, amount and a Spending link. */
  function txnHead(ctx, t, { title, headingId, level = 3 } = {}) {
    const h = 'h' + level;
    return `<div class="rv-txn">
      <div class="rv-txn-main">
        <${h} class="rv-txn-title" id="${esc(headingId || hid(t.id))}" tabindex="-1">${esc(title || merchantOf(t))}</${h}>
        <p class="rv-txn-meta"><span class="nowrap">${esc(fmt.date(t.date))}</span> · ${esc(t.accountLabel || t.accountId)} · <span class="rv-desc">${esc(t.description)}</span></p>
      </div>
      <div class="rv-txn-side"><span class="rv-txn-amt">${esc(sh().amountText(t))}</span>
        <a class="rv-open" href="${esc(txnHref(ctx, t))}">Open in Spending<span class="sr-only">: ${esc(merchantOf(t))}, ${esc(fmt.date(t.date))}</span></a></div>
    </div>`;
  }

  /**
   * c.table whose rows stack on phones: every cell after the first carries its column name
   * (hidden on wider screens), so nothing needs sideways scrolling.
   */
  function stackTable(opts) {
    const columns = opts.columns.map((col, i) => (i === 0 ? col : {
      ...col,
      html: r => `<span class="rv-ml" aria-hidden="true">${esc(col.label)}</span>${col.html ? col.html(r) : esc(col.text ? col.text(r) : r[col.key])}`,
    }));
    return c.table({ ...opts, columns, cls: `${opts.cls || ''} rv-stack` });
  }

  function facts(rows) {
    return `<dl class="rv-facts">${rows.filter(Boolean).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  }
  /**
   * Status badges without warnings the household has already answered (the shared helper shows
   * import flags as they were, e.g. "Unmatched transfer" after saying where the money went).
   */
  function badgesFor(t) {
    const e = t.edit || {};
    const answered = {
      unpaired_transfer: e.kind != null,
      reimbursement_candidate: e.reimbursement != null,
      business_candidate: e.business != null,
      duplicate_candidate: e.duplicate != null,
      mixed_retail: e.category != null || !!t.splitApplied,
      needs_category_review: e.category != null || e.kind != null || e.splits != null,
    };
    return sh().badges({ ...t, flags: (t.flags || []).filter(f => !answered[f]) });
  }
  const bankCat = t => (t.sourceCategory ? esc(t.sourceCategory) : '<span class="muted">None in the bank file</span>');
  function confidenceBadge(t) {
    const m = { high: ['High confidence', 'good'], medium: ['Medium confidence', 'info'], low: ['Low confidence', 'warn'] }[t.confidence] || ['Confidence not recorded', 'neutral'];
    return c.badge(m[0], m[1]);
  }
  function categoryNow(t) {
    if (t.kind !== 'spend') return esc(sh().kindLabel(t));
    const parts = t.parts || [];
    if (parts.length > 1) return 'Split: ' + parts.map(p => `${esc(p.category)} ${money(p.spendCents)}`).join(' + ');
    return esc(t.category);
  }

  /**
   * A queue item. `highlight` marks the transaction a link opened (route param txn): it is shown
   * with a text label (not colour alone) and its heading receives focus on arrival.
   */
  function item(key, headId, inner, { cls = '', highlight = false } = {}) {
    return `<article class="rv-item ${esc(cls)}${highlight ? ' is-target' : ''}" id="rv-item-${esc(key)}" data-rv-item="${esc(key)}" data-rv-head="${esc(headId)}"${highlight ? ` data-rv-target="${esc(headId)}"` : ''} aria-labelledby="${esc(headId)}">${highlight ? '<p class="rv-target-note">The transaction you opened</p>' : ''}${inner}</article>`;
  }

  /** Table row attributes for the transaction a link opened: highlighted, labelled and focusable. */
  function targetRow(isTarget, id) {
    return isTarget ? { id, class: 'is-target', tabindex: '-1', 'data-rv-target': id } : {};
  }
  const TARGET_TAG = '<small class="rv-target-tag">The transaction you opened</small>';

  function listCard(body, { title, subtitle = '', actions = '' }) {
    return c.card(body, { title, subtitle, actions, id: 'rv-list' });
  }

  function reasonField(id, { set = 'category', label = 'Why?', value = '' } = {}) {
    const list = REASONS[set] || [];
    return `<div class="field rv-reason">
      <label for="${esc(id)}">${esc(label)} <span class="fine">(required, kept in the history)</span></label>
      <input id="${esc(id)}" name="reason" type="text" maxlength="200" autocomplete="off" value="${esc(value)}"${list.length ? ` list="${esc(id)}-list"` : ''} placeholder="${esc('e.g. ' + (list[0] || 'Checked the statement'))}" aria-required="true" aria-describedby="${esc(id)}-error">
      ${list.length ? `<datalist id="${esc(id)}-list">${list.map(r => `<option value="${esc(r)}">`).join('')}</datalist>` : ''}
      <p class="field-error" id="${esc(id)}-error" role="alert" hidden></p>
    </div>`;
  }

  function categoryOptionsHtml(ctx, value, exclude = []) {
    const names = ctx.memo('rv-cats', () => sh().categoryOptions(ctx));
    return names.filter(n => !exclude.includes(n)).map(n => `<option value="${esc(n)}"${n === value ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }

  function categorySelect(ctx, id, { value = '', exclude = [], label = 'Category', placeholder = 'Choose a category…' } = {}) {
    return `<div class="field"><label for="${esc(id)}">${esc(label)}</label>
      <select id="${esc(id)}" name="category" aria-describedby="${esc(id)}-error"><option value="">${esc(placeholder)}</option>${categoryOptionsHtml(ctx, value, exclude)}</select>
      <p class="field-error" id="${esc(id)}-error" role="alert" hidden></p></div>`;
  }

  /** Category change with a required reason and an optional "same merchant" bulk apply. */
  function categoryForm(ctx, t, { exclude = [], submit = 'Save category', label = 'New category' } = {}) {
    const base = 'rv-cf-' + t.id;
    const others = ctx.txns.filter(x => x.id !== t.id && x.kind === 'spend' && merchantOf(x) === merchantOf(t) && !x.edited);
    const same = others.length
      ? `<label class="check" for="${esc(base)}-all"><input type="checkbox" id="${esc(base)}-all" name="allSame"> Also apply to the ${others.length === 1 ? 'other uncorrected purchase' : `${others.length} other uncorrected purchases`} at ${esc(merchantOf(t))}</label>`
      : `<span class="fine">No other uncorrected purchases at ${esc(merchantOf(t))}.</span>`;
    return `<form class="rv-form rv-catform" id="${esc(base)}" data-action="review:category" data-txn="${esc(t.id)}" novalidate aria-label="${esc('Change the category of ' + merchantOf(t) + ', ' + fmt.date(t.date))}">
      <div class="rv-form-grid">
        ${categorySelect(ctx, base + '-cat', { exclude, label })}
        ${reasonField(base + '-reason', { set: 'category' })}
      </div>
      <div class="rv-same">${same}</div>
      <div class="rv-form-actions"><button type="submit" class="btn btn-primary btn-small" id="${esc(base)}-save">${esc(submit)}</button></div>
    </form>`;
  }

  /** "What is this?" for money in or out that is not plain spending. */
  function kindForm(ctx, t, prefix, { legend } = {}) {
    const base = prefix + '-' + t.id;
    const inflow = t.amountCents > 0;
    const choices = inflow ? IN_CHOICES : OUT_CHOICES;
    const edited = t.edit && t.edit.kind;
    const current = edited ? choices.find(ch => ch.kind === t.kind && (ch.subtype || null) === (ch.kind === 'spend' ? null : t.subtype || null)) : null;
    const a = fmt.money(Math.abs(t.amountCents));
    const m = fmt.monthLong(monthOf(t));
    const radios = choices.map(ch => {
      const id = base + '-k-' + ch.key;
      return `<div class="rv-choice"><input type="radio" id="${esc(id)}" name="choice" value="${esc(ch.key)}"${current === ch ? ' checked' : ''}>
        <label for="${esc(id)}"><strong>${esc(ch.label)}</strong>${current === ch ? ' <span class="fine">(your current answer)</span>' : ''}<small>${esc(ch.effect(a, m))}</small></label></div>`;
    }).join('');
    const spendChoice = choices.find(ch => ch.needsCategory);
    return `<form class="rv-form rv-kindform" id="${esc(base)}" data-action="review:kind" data-txn="${esc(t.id)}" novalidate aria-label="${esc((inflow ? 'Where this money came from: ' : 'Where this money went: ') + merchantOf(t))}">
      <fieldset class="rv-choices"><legend>${esc(legend || (inflow ? 'Where did this money come from?' : 'Where did this money go?'))}</legend>
        <div class="rv-choice-list">${radios}</div>
        <p class="field-error" id="${esc(base)}-choice-error" role="alert" hidden></p>
      </fieldset>
      <div class="rv-form-grid">
        <div class="rv-kind-cat">${categorySelect(ctx, base + '-cat', { label: `Category (only for ${lowerFirst(spendChoice.label)})`, value: t.kind === 'spend' && t.edit && t.edit.category ? t.category : '' })}</div>
        ${reasonField(base + '-reason', { set: 'kind' })}
      </div>
      <div class="rv-form-actions"><button type="submit" class="btn btn-primary btn-small" id="${esc(base)}-save">Save answer</button></div>
    </form>`;
  }

  // ------------------------------------------------------------------ split editor
  const drafts = { split: {} };

  function splitRowHtml(ctx, txnId, i, part, n) {
    const base = `rv-sp-${txnId}-${i}`;
    return `<div class="rv-split-row" data-part="${esc(i)}">
      <div class="field"><label for="${esc(base)}-cat">Part <span class="rv-part-n">${esc(n)}</span> category</label>
        <select id="${esc(base)}-cat" name="cat" aria-describedby="${esc(base)}-cat-error"><option value="">Choose…</option>${categoryOptionsHtml(ctx, part.category || '', [E.categories.MIXED_RETAIL])}</select>
        <p class="field-error" id="${esc(base)}-cat-error" role="alert" hidden></p></div>
      <div class="field"><label for="${esc(base)}-amt">Amount</label>
        <div class="input-money"><span aria-hidden="true">$</span><input id="${esc(base)}-amt" name="amt" type="text" inputmode="decimal" autocomplete="off" value="${esc(part.amount || '')}" placeholder="0.00" aria-describedby="${esc(base)}-amt-error"></div>
        <p class="field-error" id="${esc(base)}-amt-error" role="alert" hidden></p></div>
      <button type="button" class="btn btn-ghost btn-small rv-split-remove" id="${esc(base)}-remove" data-action="review:split-remove" data-txn="${esc(txnId)}">Remove<span class="sr-only"> part <span class="rv-part-n">${esc(n)}</span></span></button>
    </div>`;
  }

  function splitForm(ctx, t) {
    const base = 'rv-sp-' + t.id;
    const total = grossSpend(t);
    const saved = t.edit && Array.isArray(t.edit.splits) ? t.edit.splits.map(p => ({ category: p.category, amount: UI.dom.centsToInput(p.cents) })) : null;
    const parts = drafts.split[t.id] || saved || [{}, {}];
    return `<form class="rv-form rv-split" id="${esc(base)}" data-action="review:split" data-txn="${esc(t.id)}" data-total="${esc(total)}" data-next="${esc(parts.length)}" novalidate aria-label="${esc('Split ' + merchantOf(t) + ', ' + fmt.date(t.date))}">
      <p class="fine">Enter what was bought in each category. The parts must add up exactly to ${money(total)}; nothing is created or lost.</p>
      <div class="rv-split-rows" id="${esc(base)}-rows">${parts.map((p, i) => splitRowHtml(ctx, t.id, i, p, i + 1)).join('')}</div>
      <div class="rv-split-tools"><button type="button" class="btn btn-secondary btn-small" id="${esc(base)}-add" data-action="review:split-add" data-txn="${esc(t.id)}">Add a part</button>
        <p class="rv-split-sum" id="${esc(base)}-sum" aria-live="polite">${splitSumText(parts.map(p => p.amount || ''), total)}</p></div>
      ${reasonField(base + '-reason', { set: 'split' })}
      <div class="rv-form-actions"><button type="submit" class="btn btn-primary btn-small" id="${esc(base)}-save">Save split</button></div>
      <p class="field-error" id="${esc(base)}-error" role="alert" hidden></p>
    </form>`;
  }

  function parseAmountLoose(text, allowNegative) {
    try { return E.money.inputToCents(text, { allowNegative }); } catch { return NaN; }
  }

  function splitSumText(amounts, total) {
    let assigned = 0, bad = false;
    for (const a of amounts) {
      if (String(a).trim() === '') continue;
      const v = parseAmountLoose(a, total < 0);
      if (Number.isNaN(v)) bad = true; else assigned += v;
    }
    const left = total - assigned;
    if (bad) return `<span class="tone-bad">One amount is not a number.</span> Assigned ${money(assigned)} of ${money(total)}.`;
    if (left === 0) return `<span class="tone-good"><span aria-hidden="true">✓ </span>Parts add up exactly to ${money(total)}.</span>`;
    if (left > 0) return `Assigned ${money(assigned)} of ${money(total)}. <strong>${money(left)} left to assign.</strong>`;
    return `<span class="tone-bad">Assigned ${money(assigned)}: ${money(-left)} more than the ${money(total)} purchase.</span>`;
  }

  function readSplitRows(form) {
    return [...form.querySelectorAll('.rv-split-row')].map(r => ({
      row: r,
      category: r.querySelector('select').value,
      amount: r.querySelector('input').value,
    }));
  }
  function refreshSplit(form) {
    const rows = readSplitRows(form);
    drafts.split[form.dataset.txn] = rows.map(r => ({ category: r.category, amount: r.amount }));
    const out = form.querySelector('.rv-split-sum');
    if (out) out.innerHTML = splitSumText(rows.map(r => r.amount), Number(form.dataset.total));
    rows.forEach((r, i) => r.row.querySelectorAll('.rv-part-n').forEach(s => { s.textContent = String(i + 1); }));
  }

  // ------------------------------------------------------------------ index
  function indexBody(ctx, q, info) {
    const st = info.stakes;
    const hasData = ctx.dataset.transactions.length > 0;
    const metrics = !hasData ? '' : `<div class="metrics rv-metrics">
      ${c.metric({ label: 'Waiting for a decision', value: String(st.open), sub: st.open ? 'Across the queues below' : 'Nothing is waiting' })}
      ${c.metric({ label: 'Spending that may change', value: fmt.money(st.changeCents), sub: 'Possible duplicates, reimbursements and business costs. Counted until you decide.' })}
      ${c.metric({ label: 'Spending in an unclear category', value: fmt.money(st.categoryCents), sub: 'Counted in totals; only the category is uncertain.' })}
    </div>`;
    const decision = PRIORITY.filter(k => QUEUES[k].type === 'decision');
    const open = decision.filter(k => info[k].open > 0);
    const clear = decision.filter(k => info[k].open === 0);
    const other = PRIORITY.filter(k => QUEUES[k].type !== 'decision');
    const row = k => `<li class="rv-qrow${info[k].open && QUEUES[k].type === 'decision' ? ' is-open' : ''}">
        <div class="rv-qrow-main"><h4><a href="${esc(qHref(ctx, k))}" id="rv-q-${esc(k)}">${esc(QUEUES[k].title)}</a></h4>
          <p>${esc(QUEUES[k].line)}</p>${info[k].impact ? `<p class="rv-qrow-impact">${info[k].impact}</p>` : ''}</div>
        <div class="rv-qrow-status">${countBadge(k, info, hasData)}</div>
      </li>`;
    const group = (title, keys, id) => (keys.length ? `<h3 class="rv-qgroup" id="${esc(id)}">${esc(title)}</h3><ul class="rv-qlist" aria-labelledby="${esc(id)}">${keys.map(row).join('')}</ul>` : '');
    const list = c.card(`${group('Waiting for you', open, 'rv-g-open')}${group('Information and tools', other, 'rv-g-info')}${group(hasData ? 'Nothing waiting' : 'Filled in once data is loaded', clear, 'rv-g-clear')}`,
      { title: 'Review queues', subtitle: 'Most important first: items that change totals, then categories, then information.', id: 'rv-queues' });
    return `<div class="stack">${metrics}<div class="rv-index-grid"><div class="stack">${list}</div><div class="stack">${missingCard(ctx)}${howCard(ctx)}</div></div></div>`;
  }

  /** Budget link that focuses the missing field. Mirrors the Budget view's field ids. */
  function missingHref(ctx, m) {
    const AREA_SECTION = { income: 'income', bills: 'bills', targets: 'targets', savings: 'savings', balances: 'savings', debts: 'debts' };
    const fid = (kind, key) => domId('bud-' + kind, String(key));
    const id = String(m.id || '');
    const plan = ctx.state.plan;
    let section = AREA_SECTION[m.area] || 'targets';
    let focus = null;
    if (id.startsWith('personal:')) { section = 'income'; focus = Array.isArray(m.streamIds) && m.streamIds.length ? fid('inc-joint', m.streamIds[0]) : fid('personal', id.slice(9)); }
    else if (id.startsWith('pay:')) { section = 'income'; focus = 'bud-add-income-name'; }
    else if (id.startsWith('target:')) focus = fid('target', id.slice(7));
    else if (m.area === 'income') { const s = plan.incomes.find(x => x.id === id); if (s) focus = fid(ctx.scope === 'joint' || s.kind === 'contribution' ? 'inc-joint' : 'inc-net', s.id); }
    else if (m.area === 'bills') { const b = plan.bills.find(x => x.id === id); if (b) focus = fid(b.fundedFrom === 'unknown' && ctx.scope === 'joint' ? 'bill-from' : 'bill-amt', b.id); }
    else if (m.area === 'savings') focus = fid('goal-monthly', id);
    else if (m.area === 'balances') focus = 'bud-cash';
    else if (m.area === 'debts') focus = fid('debt-balance', id);
    return ctx.href('budget', { section, focus });
  }

  function missingCard(ctx) {
    let plan = null;
    try { plan = ctx.plan(); } catch { plan = null; }
    if (!plan) return c.card(c.notice({ tone: 'warn', title: 'The budget could not be calculated', body: 'Open Budget to check the inputs.' }), { title: 'Missing information', id: 'rv-missing' });
    const missing = plan.missing || [];
    const missingIds = new Set(missing.map(m => String(m.id)));
    let attention = [];
    try { attention = ctx.attention(); } catch { attention = []; }
    // Plan facts to confirm that are not already listed as missing.
    const confirm = attention.filter(a => a.route && a.route.startsWith('#/budget') && !(a.id === 'balance' && missingIds.has('jointCash'))
      && !['bill-fund-', 'bill-amt-'].some(p => a.id.startsWith(p) && missingIds.has(a.id.slice(p.length))));
    const AREA = { income: 'Income', bills: 'Bills', targets: 'Targets', savings: 'Savings', balances: 'Balances', debts: 'Debts' };
    const missList = missing.length ? `<ul class="rv-missing">${missing.map(m => `<li><div><strong>${esc(m.label)}</strong><small>${esc(AREA[m.area] || 'Budget')} · Not set</small></div><a class="btn btn-small btn-secondary" href="${esc(missingHref(ctx, m))}">Fix in Edit plan<span class="sr-only">: ${esc(m.label)}</span></a></li>`).join('')}</ul>`
      : c.notice({ tone: 'good', title: 'Every budget input is filled in.', body: '' });
    const confirmList = confirm.length ? c.disclosure(`Also worth confirming (${esc(confirm.length)})`, `<ul class="rv-missing">${confirm.map(a => `<li><div><strong>${esc(a.title)}</strong>${a.detail ? `<small>${esc(a.detail)}</small>` : ''}</div><a class="btn btn-small btn-secondary" href="${esc(a.route)}">${esc(a.cta || 'Open')}<span class="sr-only">: ${esc(a.title)}</span></a></li>`).join('')}</ul>`, { cls: 'rv-confirm' }).replace('<details', '<details id="rv-confirm"') : '';
    return c.card(`<p class="fine">Unknown amounts are left out of totals and shown as “Not set”, never as $0. Filling them in makes the budget and forecast complete.</p>${missList}${confirmList}`,
      { title: 'Missing information', subtitle: missing.length ? `${count(missing.length, 'budget input')} not set (${ctx.scope === 'joint' ? 'joint accounts' : 'whole household'})` : '', id: 'rv-missing' });
  }

  function howCard(ctx) {
    return c.card(`<ul class="rv-how">
      <li>Your bank data is never changed. Each decision is saved as a correction on top of it.</li>
      <li>The bank's original category stays visible next to yours.</li>
      <li>Every correction needs a short reason, and the reason is kept with the date and time.</li>
      <li>Undo appears after each change. Older corrections can be reverted from the <a href="${esc(qHref(ctx, 'edited'))}">corrections log</a>.</li>
      <li>One-off costs, such as a dental episode, stay in actual spending. You may leave them out of the planning baseline in <a href="${esc(qHref(ctx, 'spikes'))}">Unusual spikes</a>.</li>
    </ul>`, { title: 'How corrections work', id: 'rv-how' });
  }

  // ------------------------------------------------------------------ uncertain
  function queueUncertain(ctx, P, q) {
    const list = uncertainOpen(q).sort(byDateDesc);
    const skipped = q.uncertain.length - list.length;
    const skippedNote = skipped ? `<p class="fine rv-skipped">${count(skipped, 'other transaction')} the import was unsure about ${skipped === 1 ? 'is' : 'are'} not listed: you decided ${skipped === 1 ? 'it is' : 'they are'} not counted (a confirmed reimbursement or a business cost), so ${skipped === 1 ? 'its' : 'their'} category changes no total.</p>` : '';
    const intro = `<p class="rv-intro">The import was not sure about these. Choose a category (or, for money coming in, say what it is). The bank's original category is kept next to yours, and your reason goes into the <a href="${esc(qHref(ctx, 'edited'))}">corrections log</a>.</p>`;
    if (!list.length) return intro + listCard(c.empty('Nothing is waiting here. Every uncertain transaction has an answer.', c.linkButton('See the corrections log', qHref(ctx, 'edited'))) + skippedNote, { title: 'Waiting for a category' });
    const spend = list.filter(t => t.kind === 'spend');
    const other = list.filter(t => t.kind !== 'spend');
    const sub = [count(list.length, 'transaction'), spend.length ? `${money(sum(spend, spendOf))} counted in spending` : '', other.length ? `${count(other.length, 'deposit or transfer', 'deposits or transfers')} (not spending)` : ''].filter(Boolean).join(' · ');
    const items = list.map(t => {
      const flags = t.flags || [];
      const extra = flags.includes('reimbursement_candidate')
        ? `<p class="rv-aside">It has the same amount as an earlier charge, so it may be a reimbursement. <a href="${esc(qHref(ctx, 'reimbursements', { txn: t.id }))}">Check it in Reimbursements</a> first; confirming it there takes it out of both income and spending.</p>` : '';
      const body = txnHead(ctx, t) + facts([
        ['Counted now as', categoryNow(t)],
        ['Bank category (original)', bankCat(t)],
        ['Why it is here', `${esc(t.categoryReason || 'The import was not sure.')} ${confidenceBadge(t)}`],
      ]) + extra + (t.kind === 'spend' ? categoryForm(ctx, t) : kindForm(ctx, t, 'rv-uk'));
      return item(t.id, hid(t.id), body, { highlight: P.txn === t.id });
    }).join('');
    return intro + listCard(`<div class="rv-items">${items}</div>${skippedNote}`, { title: 'Waiting for a category', subtitle: sub });
  }

  // ------------------------------------------------------------------ mixed retail
  function queueMixed(ctx, P, q) {
    const all = q.mixedRetail.slice().sort(byDateDesc);
    const merchants = [...E.util.groupBy(all, merchantOf).entries()].map(([name, rows]) => ({ name, n: rows.length, cents: sum(rows, spendOf) })).sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1));
    // A link to one purchase shows it even when a store filter would hide it.
    const opened = P.txn ? all.find(t => t.id === P.txn) : null;
    const merchant = merchants.some(m => m.name === P.merchant) && !(opened && merchantOf(opened) !== P.merchant) ? P.merchant : '';
    const filtered = merchant ? all.filter(t => merchantOf(t) === merchant) : all;
    let page = P.page;
    if (!page && P.txn) {
      const i = filtered.findIndex(t => t.id === P.txn);
      if (i >= 0) page = Math.floor(i / PAGE_SIZE.mixed) + 1;
    }
    const pg = paginate(filtered, page, PAGE_SIZE.mixed);
    const intro = c.notice({ tone: 'info', title: 'What was bought is not guessed from the store name.',
      body: 'A trip to a warehouse club or an online marketplace can be groceries, household supplies, clothing or gifts. These purchases stay in “Mixed retail” until you say otherwise. Keep them as they are, set one category if you know it (for example after checking the receipt), or split one purchase into parts that add up exactly.' });
    if (!all.length) return intro + listCard(c.empty('No mixed-retail purchases are waiting.'), { title: 'Mixed-retail purchases' });
    const chips = `<ul class="rv-chips" aria-label="Filter by store">
      <li>${goLink(ctx, `All <span class="rv-chip-n">${esc(all.length)}</span>`, { queue: 'mixed' }, { current: !merchant, id: 'rv-chip-all' })}</li>
      ${merchants.map(m => `<li>${goLink(ctx, `${esc(m.name)} <span class="rv-chip-n">${esc(m.n)}</span>`, { queue: 'mixed', merchant: m.name }, { current: merchant === m.name, id: domId('rv-chip', m.name) })}</li>`).join('')}
    </ul>`;
    const label = merchant ? `all ${filtered.length} ${merchant} purchases` : `all ${filtered.length} purchases`;
    const bulk = c.disclosure(`Decide many at once`, `<div class="rv-bulk" id="rv-mx-bulk">
        <p class="fine">Keep ${esc(label)} in Mixed retail. Each one is recorded as a decision with your reason, so it leaves this list; Undo reverses all of them.</p>
        ${reasonField('rv-mx-bulk-reason', { set: 'mixed' })}
        <div class="rv-form-actions"><button type="button" class="btn btn-secondary btn-small" id="rv-mx-bulk-keep" data-action="review:decide" data-txns="${esc(filtered.map(t => t.id).join(','))}" data-field="category" data-value="${esc(E.categories.MIXED_RETAIL)}" data-reason-from="rv-mx-bulk-reason" data-focus="rv-list-h" data-message="${esc(`Kept ${filtered.length} purchase${filtered.length === 1 ? '' : 's'} as Mixed retail.`)}">Keep ${esc(label)} as Mixed retail</button></div>
      </div>`, { cls: 'rv-bulk-wrap' }).replace('<details', '<details id="rv-mx-bulk-d"');
    const items = pg.items.map(t => {
      const head = txnHead(ctx, t);
      const line = `<p class="rv-mx-line">Bank category (original): <strong>${bankCat(t)}</strong> · Counted now as <strong>${esc(t.category)}</strong></p>`;
      const who = `${merchantOf(t)}, ${fmt.date(t.date)}`;
      const keep = `<button type="button" class="btn btn-secondary btn-small" id="rv-keep-${esc(t.id)}" data-action="review:decide" data-txns="${esc(t.id)}" data-field="category" data-value="${esc(E.categories.MIXED_RETAIL)}" data-reason="Kept as Mixed retail: contents not known" data-message="${esc(merchantOf(t) + ' kept as Mixed retail.')}">Keep as Mixed retail<span class="sr-only">: ${esc(who)}</span></button>`;
      const more = `<details class="rv-more" id="rv-mx-${esc(t.id)}"><summary>Set a category or split<span class="sr-only">: ${esc(who)}</span></summary><div class="rv-more-body">
          <h4 class="rv-more-h">Set one category</h4>${categoryForm(ctx, t, { exclude: [E.categories.MIXED_RETAIL], label: 'Category' })}
          <h4 class="rv-more-h">Or split into parts</h4>${splitForm(ctx, t)}
        </div></details>`;
      return item(t.id, hid(t.id), `${head}${line}<div class="rv-mx-actions">${keep}${more}</div>`, { highlight: P.txn === t.id, cls: 'rv-mx' });
    }).join('');
    const extra = merchant ? { merchant } : {};
    const sub = `${count(filtered.length, 'purchase')} · ${money(sum(filtered, spendOf))}${merchant ? ` at ${esc(merchant)}` : ''} · newest first`;
    return `${intro}${chips}${listCard(`${bulk}<div class="rv-items">${items}</div>${pager(ctx, P, pg, extra, 'Mixed retail')}`, { title: merchant ? `${merchant} purchases` : 'Mixed-retail purchases', subtitle: sub })}`;
  }

  // ------------------------------------------------------------------ duplicates
  function sourceText(t) {
    if (!t.sourceFile) return '<span class="muted">Not recorded</span>';
    return `${esc(t.sourceFile)}${t.sourceRow ? `, line ${esc(t.sourceRow)}` : ''}`;
  }

  function queueDuplicates(ctx, P, q) {
    const intro = `<p class="rv-intro">Two rows with the same amount on the same account a few days apart may be one purchase exported twice, or two real purchases. <strong>Both copies are counted until you decide.</strong> Nothing is removed automatically.</p>`;
    const items = q.duplicates.map(d => {
      const [a, b] = d.txns;
      const key = 'dup-' + a.id;
      const headId = hid(key);
      const rowsOf = t => [
        ['Date', esc(fmt.date(t.date))],
        ['Description', esc(t.description)],
        ['Amount', esc(sh().amountText(t))],
        ['Account', esc(t.accountLabel)],
        ['From file', sourceText(t)],
        ['Category', categoryNow(t)],
      ];
      const ra = rowsOf(a), rb = rowsOf(b);
      // Values that differ between the copies are marked, so the one real difference stands out.
      const mark = (rows, other) => rows.map(([k, v], i) => [k, v !== other[i][1] ? `<span class="rv-diff">${v}</span> <span class="rv-diff-tag">differs</span>` : v]);
      const side = (t, label, rows) => `<div class="rv-side"><h4>${esc(label)}</h4>${facts(rows)}<a href="${esc(txnHref(ctx, t))}">Open in Spending<span class="sr-only">: ${esc(label)}</span></a></div>`;
      const m = monthOf(b);
      const before = monthTotals(ctx, m).spendingCents;
      const cents = spendOf(b);
      const effect = b.kind === 'spend' && !b.excluded
        ? `Not counting the second copy lowers <a href="${esc(ctx.href('spending', { period: m }))}">${esc(fmt.monthLong(m))} spending</a> by <strong>${money(cents)}</strong>, from ${money(before)} to ${money(before - cents)}.`
        : `The second copy is ${esc(lowerFirst(sh().kindLabel(b)))}, not spending, so this decision does not change spending.`;
      const reasonId = 'rv-dup-' + a.id + '-reason';
      const conf = { high: ['Very likely a duplicate', 'warn'], medium: ['Possibly a duplicate', 'warn'], low: ['Less likely a duplicate', 'info'] }[d.confidence] || ['Possible duplicate', 'warn'];
      const body = `<div class="rv-item-head"><h3 id="${esc(headId)}" tabindex="-1">${esc(merchantOf(a))}, ${money(d.cents)}</h3>${c.badge(conf[0], conf[1])}</div>
        <p class="fine">${esc(d.reason)}</p>
        <div class="rv-pair">${side(a, 'First copy', mark(ra, rb))}${side(b, 'Second copy', mark(rb, ra))}</div>
        <p class="rv-effect">${effect}</p>
        <div class="rv-decide">${reasonField(reasonId, { set: 'duplicate' })}
          <div class="rv-form-actions">
            <button type="button" class="btn btn-primary btn-small" id="rv-dup-${esc(a.id)}-exclude" data-action="review:decide" data-txns="${esc(b.id)}" data-field="duplicate" data-value="exclude" data-reason-from="${esc(reasonId)}" data-message="${esc(`Second copy of ${merchantOf(b)} ${fmt.money(d.cents)} is no longer counted.`)}">Don't count the second copy</button>
            <button type="button" class="btn btn-secondary btn-small" id="rv-dup-${esc(a.id)}-keep" data-action="review:decide" data-txns="${esc(a.id + ',' + b.id)}" data-field="duplicate" data-value="keep" data-reason-from="${esc(reasonId)}" data-message="Kept both: they are not duplicates.">Keep both (not duplicates)</button>
          </div></div>`;
      return item(key, headId, body, { highlight: P.txn === a.id || P.txn === b.id });
    }).join('');
    const list = q.duplicates.length
      ? listCard(`<div class="rv-items">${items}</div>`, { title: 'Possible duplicates', subtitle: `${count(q.duplicates.length, 'pair')} · both copies counted until you decide` })
      : listCard(c.empty('No possible duplicates are waiting.'), { title: 'Possible duplicates' });
    return intro + list + decidedDuplicates(ctx, P);
  }

  const nearCopy = (x, t) => x.id !== t.id && x.accountId === t.accountId && x.amountCents === t.amountCents && Math.abs(E.dates.daysBetween(x.date, t.date)) <= 3;

  function decidedDuplicates(ctx, P) {
    const rows = ctx.txns.filter(t => t.edit && (t.edit.duplicate === 'exclude' || t.edit.duplicate === 'keep')).sort(byDateDesc);
    if (!rows.length) return '';
    // The opened transaction, or (for the copy that was kept and has no decision itself) the copy
    // that is no longer counted.
    const opened = P.txn ? findTxn(ctx, P.txn) : null;
    const targetId = !opened ? null : rows.some(t => t.id === opened.id) ? opened.id
      : ((rows.find(t => t.edit.duplicate === 'exclude' && nearCopy(t, opened)) || {}).id || null);
    const reasonOf = t => {
      const h = (t.edit.history || []).filter(x => x.field === 'duplicate');
      return h.length ? h[h.length - 1].reason : '';
    };
    const partners = t => (t.edit.duplicate === 'keep'
      ? rows.filter(x => x.edit.duplicate === 'keep' && x.accountId === t.accountId && x.amountCents === t.amountCents && Math.abs(E.dates.daysBetween(x.date, t.date)) <= 3).map(x => x.id)
      : [t.id]);
    const table = stackTable({
      caption: 'Duplicate decisions already made',
      columns: [
        { key: 'date', label: 'Date', html: t => `<span class="nowrap">${esc(fmt.date(t.date))}</span>` },
        { key: 'm', label: 'Merchant', html: t => `<a href="${esc(txnHref(ctx, t))}">${esc(merchantOf(t))}</a><small>${esc(t.accountLabel)}</small>${t.id === targetId ? TARGET_TAG : ''}` },
        { key: 'd', label: 'Decision', html: t => `${t.edit.duplicate === 'exclude' ? c.badge('Not counted', 'neutral') : c.badge('Not a duplicate', 'good')}<small>${esc(reasonOf(t))}</small>` },
        { key: 'a', label: 'Amount', align: 'right', html: t => esc(sh().amountText(t)) },
        { key: 'x', label: 'Change', html: t => `<button type="button" class="btn btn-ghost btn-small" id="rv-dup-reopen-${esc(t.id)}" data-action="review:decide" data-txns="${esc(partners(t).join(','))}" data-field="duplicate" data-value="" data-reason="Reopened for review" data-focus="rv-list-h" data-message="Duplicate decision reopened: both copies count again.">Reopen<span class="sr-only">: ${esc(merchantOf(t))}, ${esc(fmt.date(t.date))}</span></button>` },
      ],
      rows,
      cls: 'rv-compact',
      rowAttrs: t => targetRow(t.id === targetId, 'rv-dup-row-' + t.id),
    });
    return c.card(table, { title: 'Already decided', subtitle: 'Reopen a decision to put the pair back in the list.', id: 'rv-dup-done' });
  }

  // ------------------------------------------------------------------ transfers
  function queueTransfers(ctx, P, q) {
    const unpaired = q.transfers.unpaired || [];
    const open = openTransfers(q).sort((a, b) => byDateDesc(a, b));
    // Answered: the household said what it is (a contribution answer also makes it "expected").
    const answered = unpaired.filter(answeredTransfer).sort(byDateDesc);
    const expected = unpaired.filter(u => u.expected && !answeredTransfer(u)).sort(byDateDesc);
    const intro = `<p class="rv-intro">A transfer moves money between accounts, so it is neither income nor spending. When only one side is in your data, the app needs to know where the money came from or went, so that it is not mistaken for income or spending.</p>`;
    const items = open.map(u => {
      const body = txnHead(ctx, u) + facts([
        ['Counted now as', `${esc(sh().kindLabel(u))} <span class="fine">(not income, not spending)</span>`],
        ['Why it is here', esc(u.reason)],
      ]) + kindForm(ctx, u, 'rv-tr');
      return item(u.id, hid(u.id), body, { highlight: P.txn === u.id });
    }).join('');
    const openCard = open.length
      ? listCard(`<div class="rv-items">${items}</div>`, { title: 'Needs an answer', subtitle: `${count(open.length, 'transfer')} with no matching account · ${money(sum(open, u => Math.abs(u.amountCents)))}` })
      : listCard(c.empty('Every unmatched transfer has an answer or is expected.'), { title: 'Needs an answer' });

    const answeredCard = answered.length ? c.card(stackTable({
      caption: 'Transfers you have answered',
      columns: [
        { key: 'date', label: 'Date', html: u => `<span class="nowrap">${esc(fmt.date(u.date))}</span>` },
        { key: 'm', label: 'Transaction', html: u => `<a href="${esc(txnHref(ctx, u))}">${esc(merchantOf(u))}</a><small>${esc(u.accountLabel)}</small>${u.id === P.txn ? TARGET_TAG : ''}` },
        { key: 'k', label: 'Now counted as', html: u => `${esc(sh().kindLabel(u))}<small>${esc(u.edit.kindReason || '')}</small>` },
        { key: 'a', label: 'Amount', align: 'right', html: u => esc(sh().amountText(u)) },
        { key: 'x', label: 'Change', html: u => `<button type="button" class="btn btn-ghost btn-small" id="rv-tr-undo-${esc(u.id)}" data-action="review:revert" data-txn="${esc(u.id)}" data-fields="kind,subtype,category,splits" data-message="Answer removed: it is counted as imported again." data-focus="rv-list-h">Undo answer<span class="sr-only">: ${esc(merchantOf(u))}, ${esc(fmt.date(u.date))}</span></button>` },
      ],
      rows: answered,
      cls: 'rv-compact',
      rowAttrs: u => targetRow(u.id === P.txn, 'rv-tr-row-' + u.id),
    }), { title: 'Answered', subtitle: 'They no longer need a decision. Undo an answer to go back to the imported classification.', id: 'rv-tr-done' }) : '';

    // Expected: nothing to fix (e.g. contributions from a personal account outside the data).
    const groups = [...E.util.groupBy(expected, u => u.reason).entries()].map(([reason, rows]) => ({ reason, rows, cents: sum(rows, r => Math.abs(r.amountCents)) }));
    const expectedBody = expected.length ? `${groups.map(g => `<p><strong>${count(g.rows.length, 'transfer')} · ${money(g.cents)}</strong><br><span class="muted">${esc(g.reason)}</span></p>`).join('')}
      ${c.disclosure(`List all ${expected.length}`, stackTable({
        caption: 'Transfers with no other side expected',
        columns: [
          { key: 'date', label: 'Date', html: u => `<span class="nowrap">${esc(fmt.date(u.date))}</span>` },
          { key: 'm', label: 'Transaction', html: u => `<a href="${esc(txnHref(ctx, u))}">${esc(merchantOf(u))}</a><small>${esc(u.accountLabel)}</small>${u.id === P.txn ? TARGET_TAG : ''}` },
          { key: 'k', label: 'Counted as', text: u => sh().kindLabel(u) },
          { key: 'a', label: 'Amount', align: 'right', html: u => esc(sh().amountText(u)) },
        ],
        rows: expected,
        cls: 'rv-compact',
        rowAttrs: u => targetRow(u.id === P.txn, 'rv-tr-row-' + u.id),
      }), { cls: 'rv-inner-disclosure' }).replace('<details', '<details id="rv-tr-exp-list"')}` : '';
    const expectedCard = expected.length ? c.card(expectedBody, { title: 'No other side expected', subtitle: 'Nothing to fix: the other account is not part of your data.', id: 'rv-tr-expected' }) : '';

    return intro + openCard + answeredCard + pairedCard(ctx, q, P) + expectedCard;
  }

  function pairedCard(ctx, q, P) {
    const paired = q.transfers.paired || [];
    if (!paired.length) return '';
    const card = paired.filter(p => p.kind === 'card_payment');
    const other = paired.filter(p => p.kind !== 'card_payment');
    const savings = other.filter(p => p.txns.some(t => t.subtype === 'savings' || t.subtype === 'investment'));
    const internal = other.filter(p => !savings.includes(p));
    const line = (list, label, why) => (list.length ? `<li><strong>${count(list.length, 'pair')} · ${money(sum(list, p => p.cents))}</strong> ${esc(label)}<small>${esc(why)}</small></li>` : '');
    const table = stackTable({
      caption: 'Matched transfers and card payments',
      columns: [
        { key: 'date', label: 'Date', html: p => `<span class="nowrap">${esc(fmt.date(p.txns[0].date))}</span>${p.daysApart ? `<small>${esc(p.daysApart)} day${p.daysApart === 1 ? '' : 's'} apart</small>` : ''}` },
        { key: 'm', label: 'From → to', html: p => `<a href="${esc(txnHref(ctx, p.txns[0]))}">${esc(p.txns[0].accountLabel)}</a> → <a href="${esc(txnHref(ctx, p.txns[1]))}">${esc(p.txns[1].accountLabel)}</a><small>${esc(p.kind === 'card_payment' ? 'Card payment' : sh().kindLabel(p.txns[0]))}</small>${p.ids.includes(P.txn) ? TARGET_TAG : ''}` },
        { key: 'a', label: 'Amount', align: 'right', html: p => `${money(p.cents)}${p.amountsMatch ? '' : '<small>Amounts differ</small>'}` },
      ],
      rows: paired.slice().sort((a, b) => byDateDesc(a.txns[0], b.txns[0])),
      cls: 'rv-compact',
      rowAttrs: p => targetRow(p.ids.includes(P.txn), 'rv-tr-pair-' + p.ids[0]),
    });
    const body = `<ul class="rv-paired">
        ${line(card, 'card payments', 'Paying the card bill moves money from checking to the card. The purchases on the card are the spending, so counting the payment too would count them twice.')}
        ${line(savings, 'moves to or from savings', 'Money moved to savings is saved, not spent. It shows as “Saved”, never as spending.')}
        ${line(internal, 'moves between your accounts', 'Moving money between your own accounts is neither income nor spending.')}
      </ul>
      ${c.disclosure(`Show all ${paired.length} matched pairs`, table, { cls: 'rv-inner-disclosure' }).replace('<details', '<details id="rv-tr-paired-list"')}`;
    return c.card(body, { title: 'Matched, not counted as spending', subtitle: 'Both sides were found, so these are explained. Nothing to do.', id: 'rv-tr-paired' });
  }

  // ------------------------------------------------------------------ reimbursements
  const REIMB_STATUS = {
    pending: ['Pending — counted in spending', 'warn'],
    confirmed: ['Reimbursed — not counted', 'good'],
    not_reimbursed: ['Not reimbursed — household cost', 'neutral'],
  };

  function depositCountsAs(t) {
    if (!t) return null;
    if (t.kind === 'income') return 'income';
    if (t.kind === 'transfer' && t.subtype === 'contribution') return 'contributions';
    return null;
  }

  function reimbEffects(r) {
    const ch = r.charge, dep = r.deposit;
    const chCents = ch ? -ch.amountCents : 0;
    const depCents = dep ? dep.amountCents : 0;
    const paid = ch && dep ? Math.min(chCents, depCents) : ch ? chCents : depCents;
    const depAs = depositCountsAs(dep);
    const chM = ch ? fmt.monthLong(monthOf(ch)) : '';
    const depM = dep ? fmt.monthLong(monthOf(dep)) : '';
    const pending = [ch ? `the ${fmt.money(chCents)} charge counts in ${chM} spending` : '', dep ? (depAs ? `the ${fmt.money(depCents)} deposit counts as ${depAs} in ${depM}` : `the deposit is not counted as income (it is a ${lowerFirst(sh().kindLabel(dep))})`) : ''].filter(Boolean).join(', and ');
    let confirmed;
    if (ch && dep) {
      confirmed = `Neither side counts: ${chM} spending goes down by ${fmt.money(paid)}${depAs ? ` and ${depM} ${depAs} by ${fmt.money(paid)}` : ''}.`;
      if (chCents !== depCents) confirmed += ` The amounts differ, so only ${fmt.money(paid)} is treated as paid back; the rest still counts.`;
    } else if (ch) confirmed = `The ${fmt.money(chCents)} charge leaves ${chM} spending.`;
    else confirmed = `The deposit leaves ${depM} ${depAs || 'totals'}.`;
    const notR = ch ? `The charge stays a household cost in ${chM} spending${dep ? `, and the deposit stays ${depAs ? 'counted as ' + depAs : 'as it is'}` : ''}.` : `The deposit stays ${depAs ? 'counted as ' + depAs : 'as it is'}.`;
    return { pending: pending ? pending.charAt(0).toUpperCase() + pending.slice(1) + '.' : '', confirmed, not_reimbursed: notR };
  }

  function queueReimbursements(ctx, P, q) {
    const list = q.reimbursements.slice().sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || byDateDesc(a.charge || a.deposit, b.charge || b.deposit));
    const intro = `<p class="rv-intro">A deposit with the same amount as an earlier charge may be someone paying you back. Until you confirm, <strong>both are counted</strong>: the charge as spending and the deposit as income. Confirming takes both out, so nothing is counted twice.</p>`;
    if (!list.length) return intro + listCard(c.empty('No possible reimbursements are waiting.'), { title: 'Possible reimbursements' });
    const items = list.map(r => reimbItem(ctx, r, P)).join('');
    const pending = list.filter(r => r.status === 'pending');
    return intro + listCard(`<div class="rv-items">${items}</div>`, { title: 'Possible reimbursements', subtitle: `${count(pending.length, 'waiting for a decision', 'waiting for a decision')}${list.length > pending.length ? ` · ${count(list.length - pending.length, 'decided', 'decided')}` : ''}` });
  }

  function reimbItem(ctx, r, P) {
    const ch = r.charge, dep = r.deposit;
    const key = 'rb-' + (r.chargeId || r.depositId);
    const headId = hid(key);
    const base = 'rv-rb-' + (r.chargeId || r.depositId);
    const side = (t, label, missing) => (t ? `<div class="rv-side"><h4>${esc(label)}</h4>${facts([
      ['Date', esc(fmt.date(t.date))],
      ['Description', esc(t.description)],
      ['Amount', esc(sh().amountText(t))],
      ['Account', esc(t.accountLabel)],
    ])}<a href="${esc(txnHref(ctx, t))}">Open in Spending<span class="sr-only">: ${esc(label)}</span></a></div>` : `<div class="rv-side rv-side-missing"><h4>${esc(label)}</h4><p class="muted">${esc(missing)}</p></div>`);
    const days = ch && dep ? E.dates.daysBetween(ch.date, dep.date) : null;
    const chCents = ch ? -ch.amountCents : null;
    const depCents = dep ? dep.amountCents : null;
    const matchLine = ch && dep ? `${chCents === depCents ? `Amounts match exactly (${money(chCents)}).` : `Amounts differ: charge ${money(chCents)}, deposit ${money(depCents)}.`} The deposit came ${days === 0 ? 'the same day' : days > 0 ? `${count(days, 'day')} after the charge` : `${count(-days, 'day')} before the charge`}.` : '';
    const fx = reimbEffects(r);
    const title = ch ? `${merchantOf(ch)}, ${fmt.money(chCents)}` : `Deposit of ${fmt.money(depCents)}`;
    const ids = [r.chargeId, r.depositId].filter(Boolean);
    const options = [
      { value: 'pending', label: 'Pending', note: 'Not decided yet. ' + fx.pending },
      { value: 'confirmed', label: 'Reimbursed — don’t count either side', note: fx.confirmed },
      { value: 'not_reimbursed', label: 'Not reimbursed — household cost', note: fx.not_reimbursed },
    ];
    const radios = options.map(o => {
      const id = `${base}-s-${o.value}`;
      return `<div class="rv-choice"><input type="radio" id="${esc(id)}" name="status" value="${esc(o.value)}"${r.status === o.value ? ' checked' : ''}>
        <label for="${esc(id)}"><strong>${esc(o.label)}</strong>${r.status === o.value ? ' <span class="fine">(current)</span>' : ''}<small>${esc(o.note)}</small></label></div>`;
    }).join('');
    const warnings = [ch, dep].filter(Boolean).flatMap(t => t.editWarnings || []);
    const body = `<div class="rv-item-head"><h3 id="${esc(headId)}" tabindex="-1">${esc(title)}</h3>${c.badge(REIMB_STATUS[r.status][0], REIMB_STATUS[r.status][1])}</div>
      <div class="rv-pair">${side(ch, 'Charge', 'No matching charge is in the data.')}${side(dep, 'Deposit', 'No deposit has been found for this charge yet.')}</div>
      ${matchLine ? `<p class="fine">${matchLine}</p>` : ''}
      <p class="rv-effect"><strong>Now:</strong> ${esc(r.status === 'pending' ? fx.pending : r.status === 'confirmed' ? fx.confirmed : fx.not_reimbursed)}</p>
      ${warnings.length ? `<ul class="fine-list">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <form class="rv-form" id="${esc(base)}" data-action="review:reimb" data-txns="${esc(ids.join(','))}" data-current="${esc(r.status)}" novalidate aria-label="${esc('Reimbursement decision for ' + title)}">
        <fieldset class="rv-choices"><legend>Was it paid back?</legend><div class="rv-choice-list">${radios}</div>
          <p class="field-error" id="${esc(base)}-status-error" role="alert" hidden></p></fieldset>
        ${reasonField(base + '-reason', { set: 'reimbursement' })}
        <div class="rv-form-actions"><button type="submit" class="btn btn-primary btn-small" id="${esc(base)}-save">Save decision</button></div>
      </form>`;
    return item(key, headId, body, { highlight: ids.includes(P.txn), cls: r.status === 'pending' ? '' : 'is-decided' });
  }

  // ------------------------------------------------------------------ business
  const BIZ_STATUS = { pending: ['Pending', 'warn'], business: ['Business — not counted', 'neutral'], household: ['Household', 'good'] };

  function queueBusiness(ctx, P, q) {
    const all = q.business.slice().sort(byDateDesc);
    const intro = `<p class="rv-intro">Some purchases may be business costs (for example supplies bought for work). <strong>Pending ones are counted as household spending.</strong> Marking a purchase as business takes it out of household spending; it stays in your data.</p>`;
    if (!all.length) return intro + listCard(c.empty('No possible business purchases in the data.'), { title: 'Possible business purchases' });
    const of = s => all.filter(t => t.status === s);
    const opened = P.txn ? all.find(t => t.id === P.txn) || null : null;
    const status = P.status || (opened ? opened.status : of('pending').length ? 'pending' : 'all');
    const shown = status === 'all' ? all : of(status);
    const NAME = { pending: 'Pending', business: 'Business', household: 'Household', all: 'All' };
    const SUB = { pending: 'counted as household spending until decided', business: 'not counted as household spending', household: 'counted as household spending' };
    // Each total opens the list of purchases behind it.
    const metrics = `<div class="metrics rv-metrics rv-biz-metrics">${['pending', 'business', 'household'].map(s => goLink(ctx,
      `<span class="metric-label">${esc(NAME[s])}</span><span class="metric-value">${money(sum(of(s), grossSpend))}</span><span class="metric-sub">${count(of(s).length, 'purchase')} · ${esc(SUB[s])}</span>`,
      { queue: 'business', status: s }, { id: 'rv-biz-m-' + s, cls: 'metric metric-link', current: status === s, sr: ` (show ${NAME[s].toLowerCase()} purchases)` })).join('')}</div>`;
    const filters = `<ul class="rv-chips" aria-label="Show">${['pending', 'business', 'household', 'all'].map(s => `<li>${goLink(ctx, `${esc(NAME[s])} <span class="rv-chip-n">${esc(s === 'all' ? all.length : of(s).length)}</span>`, { queue: 'business', status: s }, { current: status === s, id: 'rv-biz-f-' + s })}</li>`).join('')}</ul>`;
    const hiddenNote = opened && !shown.includes(opened)
      ? `<p class="fine rv-skipped">${esc(merchantOf(opened))}, ${esc(fmt.date(opened.date))} is ${esc(NAME[opened.status].toLowerCase())}, so it is not in this list. ${goLink(ctx, `Show ${esc(NAME[opened.status].toLowerCase())} purchases`, { queue: 'business', status: opened.status, txn: opened.id }, { id: 'rv-biz-show-opened', focus: 'rv-biz-' + opened.id })}</p>` : '';
    const rows = shown.map(t => {
      const id = 'rv-biz-' + t.id;
      const isTarget = !!opened && t.id === opened.id;
      return `<tr id="${esc(id)}-row"${isTarget ? ` class="is-target" data-rv-target="${esc(id)}"` : ''}>
        <td class="rv-sel"><input type="checkbox" id="${esc(id)}" name="rv-biz-sel" value="${esc(t.id)}" data-action="review:biz-sel" aria-labelledby="${esc(id)}-m ${esc(id)}-d ${esc(id)}-a"></td>
        <th scope="row"><label for="${esc(id)}" id="${esc(id)}-m">${esc(merchantOf(t))}</label><small><span id="${esc(id)}-d">${esc(fmt.date(t.date))}</span> · <a href="${esc(txnHref(ctx, t))}">Open<span class="sr-only"> ${esc(merchantOf(t))}, ${esc(fmt.date(t.date))} in Spending</span></a></small>${isTarget ? TARGET_TAG : ''}</th>
        <td>${esc(t.category)}<small>Bank: ${esc(t.sourceCategory || 'none')}</small></td>
        <td>${c.badge(BIZ_STATUS[t.status][0], BIZ_STATUS[t.status][1])}</td>
        <td class="num" id="${esc(id)}-a">${money(grossSpend(t))}</td>
      </tr>`;
    }).join('');
    const foot = `<tfoot><tr><td class="rv-sel"></td><th scope="row" colspan="3">${count(shown.length, 'purchase')} shown</th><td class="num">${money(sum(shown, grossSpend))}</td></tr></tfoot>`;
    const table = shown.length ? `<div class="table-wrap rv-biz-wrap" tabindex="0" role="region" aria-label="Possible business purchases">
        <table class="table rv-biz-table"><caption class="sr-only">Possible business purchases, ${esc(status === 'all' ? 'all' : status)}</caption>
        <thead><tr><th scope="col"><span class="sr-only">Select</span></th><th scope="col">Merchant</th><th scope="col">Category</th><th scope="col">Status</th><th scope="col" class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>${foot}</table></div>` : c.empty(`No ${status} purchases.`);
    const tools = `<div class="rv-biz" id="rv-biz">
      <div class="rv-biz-top"><label class="check" for="rv-biz-all"><input type="checkbox" id="rv-biz-all" data-action="review:biz-all"> Select all ${esc(shown.length)} shown</label>
        <p class="rv-biz-count" id="rv-biz-count" aria-live="polite">None selected</p></div>
      <p class="field-error" id="rv-biz-sel-error" role="alert" hidden></p>
      ${hiddenNote}${table}
      <div class="rv-biz-decide">${reasonField('rv-biz-reason', { set: 'business', label: 'Why? (one reason for all selected)' })}
        <div class="rv-form-actions">
          <button type="button" class="btn btn-primary btn-small" id="rv-biz-business" data-action="review:business" data-value="business">Business — not household spending</button>
          <button type="button" class="btn btn-secondary btn-small" id="rv-biz-household" data-action="review:business" data-value="household">Household — counts as spending</button>
          <button type="button" class="btn btn-ghost btn-small" id="rv-biz-pending" data-action="review:business" data-value="pending">Back to pending</button>
        </div></div>
    </div>`;
    return intro + metrics + listCard(filters + tools, { title: 'Possible business purchases', subtitle: 'Select one or more, give one reason, then choose.' });
  }

  // ------------------------------------------------------------------ spikes
  function queueSpikes(ctx, P, q) {
    const win = windowOf(ctx);
    const intro = `<p class="rv-intro">A category-month far above its usual level, such as a dental episode, is real spending and <strong>always stays in your actual totals</strong>. If it is not expected again, you can leave it out of the <em>planning baseline</em>: the usual amounts that budgets and targets are based on.</p>`;
    const items = q.spikes.map(s => spikeItem(ctx, s, win, P)).join('');
    const card = q.spikes.length
      ? listCard(`<div class="rv-items">${items}</div>`, { title: 'Unusual months', subtitle: `${count(q.spikes.length, 'category-month')} at least 3 times the usual level and $500 or more` })
      : listCard(c.empty('No unusual months found.'), { title: 'Unusual months' });
    return intro + card + yearlyBills(ctx, q, P);
  }

  /**
   * Yearly bills: category-months the engine recognised as a payment that recurs about a year
   * apart (review.queues().annualSpikes). Not unusual, so nothing to decide; listed so the
   * household can see why a large month is not flagged and whether the budget plans for it.
   */
  function yearlyBills(ctx, q, P) {
    const annual = q.annualSpikes || [];
    if (!annual.length) return '';
    const map = byIdMap(ctx);
    const plan = ctx.state.plan;
    const inCat = (t, category) => sum(E.ledger.partsOf(t).filter(p => p.category === category), p => p.spendCents);
    const groups = [...E.util.groupBy(annual, s => s.category).entries()].map(([category, list]) => ({
      category,
      list: list.slice().sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0)),
    }));
    const items = groups.map(g => {
      const key = 'yr-' + domId('c', g.category).slice(2);
      const headId = hid(key);
      const rows = g.list.flatMap(s => s.ids.map(id => map.get(id)).filter(Boolean)).sort(byDateDesc);
      const latest = g.list[0];
      const table = stackTable({
        caption: `${g.category} payments about a year apart`,
        columns: [
          { key: 'date', label: 'Date', html: t => `<span class="nowrap">${esc(fmt.date(t.date))}</span>` },
          { key: 'm', label: 'Merchant', html: t => `<a href="${esc(txnHref(ctx, t))}">${esc(merchantOf(t))}</a><small>${esc(t.accountLabel)}</small>${t.id === P.txn ? TARGET_TAG : ''}` },
          { key: 'mo', label: 'Month', html: t => `<a href="${esc(ctx.href('spending', { period: monthOf(t), cat: g.category }))}">${esc(fmt.month(monthOf(t)))}</a>` },
          { key: 'a', label: 'Amount', align: 'right', html: t => money(inCat(t, g.category)) },
        ],
        rows,
        cls: 'rv-compact',
      });
      const bills = (plan.bills || []).filter(b => b.category === g.category);
      const target = (plan.targets || {})[g.category];
      const billText = b => (typeof b.monthlyCents === 'number'
        ? `${esc(b.label)}: <strong>${money(b.monthlyCents)}</strong> a month (${money(b.monthlyCents * 12)} a year)${b.status === 'planned' ? ', planned' : ''}`
        : `${esc(b.label)}: amount <strong>not set</strong>`);
      const budgetLine = bills.length || typeof target === 'number'
        ? `In your budget · plan: ${[...bills.map(billText), ...(typeof target === 'number' ? [`target <strong>${money(target)}</strong> a month`] : [])].join('; ')}. <a href="${esc(ctx.href('budget', { section: bills.length ? 'bills' : 'targets' }))}">Open in Edit plan</a>`
        : `In your budget · plan: <strong>Not set</strong>. A yearly ${money(latest.totalCents)} is ${money(Math.round(latest.totalCents / 12))} a month if set aside evenly. <a href="${esc(ctx.href('budget', { section: 'bills' }))}">Add it as a bill in Edit plan</a>`;
      const ms = g.list.map(s => fmt.month(s.month));
      const months = ms.length > 1 ? ms.slice(0, -1).join(', ') + ' and ' + ms[ms.length - 1] : ms[0];
      const body = `<div class="rv-item-head"><h3 id="${esc(headId)}" tabindex="-1">${esc(g.category)}</h3>${c.badge('Yearly bill — not unusual', 'info')}</div>
        <p>Paid in ${esc(months)}${g.list.length === 1 && latest.annualMatch ? ` and ${esc(fmt.month(latest.annualMatch.month))}` : ''}: a similar amount about a year apart, so ${esc(fmt.monthLong(latest.month))} is not marked as unusual.</p>
        ${table}
        <p class="rv-target-line">${budgetLine}</p>`;
      return item(key, headId, body, { highlight: rows.some(t => t.id === P.txn) });
    }).join('');
    return c.card(`<p class="fine">A payment that comes back 11 to 13 months later at a similar size, such as a yearly insurance premium, is a regular bill rather than an unusual month. It needs no decision here. It always stays in actual spending; plan for it in Edit plan as a monthly amount set aside.</p><div class="rv-items">${items}</div>`,
      { title: 'Yearly bills (not unusual)', subtitle: `${count(groups.length, 'category', 'categories')} paid about once a year · not counted as spikes`, id: 'rv-annual' });
  }

  function spikeItem(ctx, s, win, P) {
    const key = 'spk-' + s.month + '-' + domId('c', s.category).slice(2);
    const headId = hid(key);
    const map = byIdMap(ctx);
    const rows = s.ids.map(id => map.get(id)).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : 1));
    const state = spikeState(ctx, s);
    const badge = state === 'exclude' ? c.badge('Left out of planning baseline', 'info') : state === 'include' ? c.badge('Kept in planning baseline', 'good') : state === 'mixed' ? c.badge('Partly left out of planning', 'warn') : c.badge('Not decided — kept in baseline', 'warn');
    const ids = new Set(s.ids);
    const next = E.months.add(s.month, 1);
    const affected = E.months.range(next, E.months.add(s.month, win));
    const usualWith = flag => ctx.memo(`rv-spk:${key}:${flag}:${win}`, () => {
      const txns = ctx.txns.map(t => (ids.has(t.id) ? { ...t, planningExcluded: flag } : t));
      const r = E.compare.usual(txns, ctx.dataset, { month: next, window: win, category: s.category, planning: true });
      return { avg: r.categories[0] ? r.categories[0].averageCents : null, months: r.baselineMonths };
    });
    const kept = usualWith(false), left = usualWith(true);
    const target = (ctx.state.plan.targets || {})[s.category];
    const actualMonth = sum(rows, t => sum(E.ledger.partsOf(t).filter(p => p.category === s.category), p => p.spendCents));
    const times = s.usualCents > 0 ? `about ${Math.round(s.totalCents / s.usualCents).toLocaleString('en-US')} times the usual ${money(s.usualCents)} a month` : 'with no spending in this category in the months before';
    const tile = (label, avg, current) => `<div class="rv-tile${current ? ' is-current' : ''}"><span class="rv-tile-tag">${esc(label)}${current ? ' · now' : ''}</span><span class="rv-tile-value">${avg === null ? 'Not known' : money(avg)}</span><small>a month</small></div>`;
    const table = stackTable({
      caption: `${s.category} transactions in ${fmt.monthLong(s.month)}`,
      columns: [
        { key: 'date', label: 'Date', html: t => `<span class="nowrap">${esc(fmt.date(t.date))}</span>` },
        { key: 'm', label: 'Merchant', html: t => `<a href="${esc(txnHref(ctx, t))}">${esc(merchantOf(t))}</a><small>${esc(t.accountLabel)}</small>` },
        { key: 'p', label: 'Planning', html: t => (t.planningExcluded ? c.badge('Left out', 'info') : '<span class="fine">Included</span>') },
        { key: 'a', label: 'Amount', align: 'right', html: t => money(sum(E.ledger.partsOf(t).filter(p => p.category === s.category), p => p.spendCents)) },
      ],
      rows,
      footer: { date: count(rows.length, 'transaction'), a: money(actualMonth) },
      cls: 'rv-compact',
    });
    const reasonId = 'rv-spk-' + s.month + '-' + domId('r', s.category).slice(2) + '-reason';
    const decide = `<div class="rv-decide">${reasonField(reasonId, { set: 'planning' })}
      <div class="rv-form-actions">
        <button type="button" class="btn btn-primary btn-small" id="${esc(key)}-exclude" data-action="review:decide" data-stay="1" data-txns="${esc(s.ids.join(','))}" data-field="planningBaseline" data-value="exclude" data-reason-from="${esc(reasonId)}" data-message="${esc(`${s.category} ${fmt.month(s.month)} left out of the planning baseline. Actual spending is unchanged.`)}">Leave out of planning baseline</button>
        <button type="button" class="btn btn-secondary btn-small" id="${esc(key)}-include" data-action="review:decide" data-stay="1" data-txns="${esc(s.ids.join(','))}" data-field="planningBaseline" data-value="include" data-reason-from="${esc(reasonId)}" data-message="${esc(`${s.category} ${fmt.month(s.month)} kept in the planning baseline.`)}">Keep in planning baseline</button>
      </div></div>`;
    const body = `<div class="rv-item-head"><h3 id="${esc(headId)}" tabindex="-1">${esc(s.category)}, ${esc(fmt.monthLong(s.month))}</h3>${badge}</div>
      <p><strong>${money(s.totalCents)}</strong> in ${count(rows.length, 'transaction')}, ${times} (${esc(E.compare.describeMonths(s.priorMonths))}, complete months only).</p>
      ${table}
      <div class="rv-usual" role="group" aria-labelledby="${esc(key)}-usual-h">
        <h4 id="${esc(key)}-usual-h">Usual ${esc(s.category)} for planning · history</h4>
        <p class="fine">The average of ${esc(kept.months.length ? E.compare.describeMonths(kept.months) : 'the complete months before')}, as used for ${esc(fmt.monthLong(next))}. It affects the usual amount for ${esc(E.compare.describeMonths(affected))}.</p>
        <div class="rv-tiles">${tile('If kept in', kept.avg, state !== 'exclude')}${tile('If left out', left.avg, state === 'exclude')}</div>
        <p class="rv-target-line">Your target for ${esc(s.category)} · plan: ${typeof target === 'number' ? `<strong>${money(target)}</strong> a month (set by you, not changed by this)` : `<strong>Not set</strong>. <a href="${esc(ctx.href('budget', { section: 'targets', focus: domId('bud-target', s.category) }))}">Set a target in Edit plan</a>`}</p>
      </div>
      <p class="rv-effect">Actual spending does not change either way: ${esc(fmt.monthLong(s.month))} still shows <a href="${esc(ctx.href('spending', { period: s.month, cat: s.category }))}">${money(actualMonth)} of ${esc(s.category)}</a>, and <a href="${esc(ctx.href('spending', { period: s.month }))}">the month's total</a> stays ${money(monthTotals(ctx, s.month).spendingCents)}.</p>
      ${decide}`;
    return item(key, headId, body, { highlight: s.ids.includes(P.txn) });
  }

  // ------------------------------------------------------------------ coverage
  function queueCoverage(ctx, P, q) {
    const months = ctx.months.slice().reverse();
    const accounts = ctx.dataset.accounts || [];
    if (!months.length) return listCard(c.empty('No data is loaded, so there is no coverage to show.', c.linkButton('Load data', ctx.href('data'))), { title: 'Coverage by month' });
    const spendTypes = E.ledger.SPENDING_ACCOUNT_TYPES;
    const covAll = m => ctx.memo('rv-cov-all:' + m, () => E.ledger.coverage(ctx.dataset, m, { purpose: 'all' }));
    const gaps = q.coverageGaps;
    const intro = gaps.length ? c.notice({ tone: 'warn', title: `${count(gaps.length, 'month is', 'months are')} partial: ${E.compare.describeMonths(gaps.map(g => g.month).sort())}`,
      body: `<ul class="rv-gap-list">${gaps.map(g => `<li><a href="${esc(ctx.href('spending', { period: g.month }))}">${esc(fmt.monthLong(g.month))}</a>: ${esc(g.missing.length ? g.missing.map(a => `${a.label} covers ${a.coveredDays} of ${a.totalDays} days`).join('; ') : (g.note || 'Some days are missing.'))}${g.overridden ? ' (set manually)' : ''}</li>`).join('')}</ul><p>Partial months are left out of usual averages and planning baselines. They are never treated as $0: their spending is shown as “only what is in the data”. Loading the missing exports in <a href="${esc(ctx.href('data'))}">Data &amp; privacy</a> completes them.</p>` })
      : c.notice({ tone: 'good', title: 'Every month is complete.', body: 'Every spending account covers every day of every month in the data.' });
    const cell = (m, a) => {
      const x = covAll(m).accounts.find(r => r.accountId === a.id);
      if (!x) return '<span class="muted">—</span>';
      // Gaps only matter for accounts that spending depends on.
      const tone = x.coveredDays === x.totalDays ? 'good' : !spendTypes.includes(a.type) ? 'muted' : x.coveredDays === 0 ? 'bad' : 'warn';
      const word = x.coveredDays === x.totalDays ? 'Full' : x.coveredDays === 0 ? 'None' : 'Partial';
      return `<span class="rv-cov rv-cov-${tone}">${esc(`${x.coveredDays}/${x.totalDays}`)} <small>${esc(word)}</small></span>`;
    };
    const columns = [
      { key: 'm', label: 'Month', html: m => `<a href="${esc(ctx.href('spending', { period: m }))}">${esc(fmt.month(m))}</a>` },
      ...accounts.map(a => ({ key: a.id, label: spendTypes.includes(a.type) ? a.label : `${a.label} (not needed for spending)`, align: 'right', html: m => cell(m, a) })),
      { key: 's', label: 'Spending data', html: m => {
        const cv = ctx.coverageMap[m] || E.ledger.coverage(ctx.dataset, m);
        const b = cv.status === 'full' ? c.badge('Complete', 'good') : cv.status === 'partial' ? c.badge('Partial', 'warn') : c.badge('No data', 'neutral');
        return `${b}${cv.overridden ? '<small>Set manually</small>' : ''}${cv.status !== 'full' ? '<small>Left out of averages</small>' : ''}`;
      } },
    ];
    const table = c.table({ caption: 'Days covered by each account export, per month (covered / days in month)', columns, rows: months, cls: 'rv-cov-table rv-compact', rowAttrs: m => ({ class: (ctx.coverageMap[m] || {}).status !== 'full' ? 'rv-cov-partial' : null }) });
    return `${intro}${listCard(`<p class="fine">Each cell shows the days an account's exports cover out of the days in that month. A month is complete for spending when every checking, card and other spending account covers every day. Savings and loan accounts are not needed for spending totals.</p>${table}`, { title: 'Coverage by month', subtitle: `${count(months.length, 'month')} · newest first` })}`;
  }

  // ------------------------------------------------------------------ corrections log
  function importedValue(t, field) {
    if (!t) return null;
    if (field === 'category') return t.baseCategory;
    if (field === 'kind') return sh().KIND_LABEL[t.baseKind] || t.baseKind;
    if (field === 'subtype') return t.baseSubtype ? sh().SUBTYPE_LABEL[t.baseSubtype] || t.baseSubtype : null;
    if (field === 'splits') return t.kind === 'spend' ? `not split, ${t.baseCategory}` : null;
    return null;
  }
  function valueText(field, v, side, t) {
    if (v === null || v === undefined || v === '') {
      const imp = importedValue(t, field);
      if (side === 'from') return imp ? `Imported (${imp})` : 'Imported value';
      return imp ? `Back to imported (${imp})` : 'Back to the imported value';
    }
    if (VALUE_LABEL[field] && VALUE_LABEL[field][v]) return VALUE_LABEL[field][v];
    if (field === 'kind') return sh().KIND_LABEL[v] || String(v);
    if (field === 'subtype') return sh().SUBTYPE_LABEL[v] || String(v);
    if (field === 'splits' && Array.isArray(v)) return 'Split: ' + v.map(p => `${p.category} ${fmt.money(p.cents)}`).join(' + ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function historyTable(t, history) {
    const rows = history.slice().reverse();
    return stackTable({
      caption: `History of corrections to ${merchantOf(t)}, ${fmt.date(t.date)}`,
      columns: [
        { key: 'at', label: 'When', html: h => `<span class="nowrap">${esc(whenText(h.at))}</span>` },
        { key: 'f', label: 'What changed', text: h => FIELD_LABEL[h.field] || h.field },
        { key: 'ch', label: 'From → to', html: h => `${esc(valueText(h.field, h.from, 'from', t))} <span aria-hidden="true">→</span><span class="sr-only"> to </span> <strong>${esc(valueText(h.field, h.to, 'to', t))}</strong>` },
        { key: 'r', label: 'Reason', html: h => (h.reason ? esc(h.reason) : '<span class="muted">No reason recorded</span>') },
      ],
      rows,
      cls: 'rv-compact rv-hist',
    });
  }

  function queueEdited(ctx, P, q) {
    const list = q.edited;
    let page = P.page;
    if (!page && P.txn) {
      const i = list.findIndex(t => t.id === P.txn);
      if (i >= 0) page = Math.floor(i / PAGE_SIZE.edited) + 1;
    }
    const pg = paginate(list, page, PAGE_SIZE.edited);
    const intro = `<p class="rv-intro">Every correction is kept here with its date, what changed and why. The imported data is never changed; reverting puts back the imported values and adds the revert to the history.</p>`;
    const items = pg.items.map(t => {
      const active = hasActive(t.edit);
      const head = txnHead(ctx, t);
      const f = facts([
        ['Counted now as', `${categoryNow(t)} ${badgesFor(t)}`],
        ['Bank category (original)', bankCat(t)],
        ['Imported as', esc(t.baseKind === 'spend' ? t.baseCategory : `${sh().KIND_LABEL[t.baseKind] || t.baseKind}${t.baseSubtype && sh().SUBTYPE_LABEL[t.baseSubtype] ? ' · ' + sh().SUBTYPE_LABEL[t.baseSubtype] : ''}`)],
      ]);
      const warn = (t.editWarnings || []).length ? `<ul class="fine-list">${t.editWarnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
      const revert = active
        ? `<div class="rv-form-actions"><button type="button" class="btn btn-secondary btn-small" id="rv-revert-${esc(t.id)}" data-action="review:revert" data-txn="${esc(t.id)}" data-stay="1">Revert to the imported values<span class="sr-only">: ${esc(merchantOf(t))}, ${esc(fmt.date(t.date))}</span></button></div>`
        : `<p class="fine">${c.badge('Reverted', 'neutral')} The imported values are in use again. The history is kept.</p>`;
      return item(t.id, hid(t.id), `${head}${f}${warn}${historyTable(t, t.history || [])}${revert}`, { highlight: P.txn === t.id });
    }).join('');
    const orphans = q.orphanEdits.length ? c.notice({ tone: 'warn', title: `${count(q.orphanEdits.length, 'correction refers', 'corrections refer')} to transactions not in the loaded data`,
      body: `They are kept and apply again if those transactions are loaded (for example after re-importing the same exports).<ul class="fine-list">${q.orphanEdits.slice(0, 20).map(o => {
        const h = (o.edit.history || []);
        const last = h[h.length - 1];
        return `<li>${esc(o.id)}: ${esc(Object.keys(o.edit).filter(k => k !== 'history' && o.edit[k] != null).map(k => FIELD_LABEL[k] || k).join(', ') || 'reverted')}${last && last.reason ? ` — “${esc(last.reason)}”` : ''}</li>`;
      }).join('')}</ul>` }) : '';
    if (!list.length) return intro + orphans + listCard(c.empty('No corrections yet. Decisions you make in the other queues appear here with their reasons.'), { title: 'Corrections' });
    return intro + orphans + listCard(`<div class="rv-items">${items}</div>${pager(ctx, P, pg, {}, 'Corrections')}`, { title: 'Corrections', subtitle: `${count(list.length, 'transaction')} corrected · most recent first` });
  }

  // ------------------------------------------------------------------ reconcile
  /** Spending link params for a date range: whole months when the dates line up, else the months it touches. */
  function periodParam(start, end) {
    const a = start.slice(0, 7), b = end.slice(0, 7);
    const aligned = start === E.months.start(a) && end === E.months.end(b);
    return { period: a === b ? a : a + '..' + b, aligned };
  }

  function reconcileData(ctx, start, end) {
    return ctx.memo('rv-rec:' + start + ':' + end, () => {
      const all = E.ledger.filter(ctx.txns, { start, end, includeExcluded: true });
      const s = E.ledger.summarize(all);
      const counted = all.filter(t => !t.excluded);
      const q = ctx.reviewQueues();
      const inP = t => !!t && t.date >= start && t.date <= end;
      const byAccount = E.ledger.group(counted, 'account');
      const pendingReimb = q.reimbursements.filter(r => r.status === 'pending' && r.charge && inP(r.charge) && !r.charge.excluded).map(r => r.charge);
      const pendingBiz = q.business.filter(t => t.status === 'pending' && inP(t) && !t.excluded);
      const uncertain = q.uncertain.filter(t => t.kind === 'spend' && inP(t) && !t.excluded);
      const dupes = q.duplicates.filter(d => inP(d.txns[1]) && d.txns[1].kind === 'spend' && !d.txns[1].excluded).map(d => d.txns[1]);
      // Not counted, or counted only in part (the paid-back part of a partly reimbursed charge).
      const excluded = all.filter(t => t.kind === 'spend' && (t.excluded || t.reimbursedCents));
      const txDate = t => {
        const m = /Transaction date (\d{4}-\d{2}-\d{2})/.exec(t.baseNote || t.note || '');
        return m ? m[1] : null;
      };
      const boughtBefore = counted.filter(t => t.kind === 'spend' && txDate(t) && txDate(t) < start);
      const after = E.dates.addDays(end, BOUNDARY_DAYS);
      const postedAfter = ctx.txns.filter(t => !t.excluded && t.kind === 'spend' && t.date > end && t.date <= after && txDate(t) && txDate(t) >= start && txDate(t) <= end);
      const months = E.months.range(start.slice(0, 7), end.slice(0, 7));
      const statusOf = m => (ctx.coverageMap[m] || E.ledger.coverage(ctx.dataset, m)).status;
      // Incomplete = partly covered (some days or accounts missing) or not covered at all.
      const partial = months.filter(m => statusOf(m) === 'partial');
      const missing = months.filter(m => statusOf(m) === 'none');
      const incomplete = months.filter(m => statusOf(m) !== 'full');
      // Nothing in the data for these dates: the app's spending is unknown, never $0.
      const noData = !all.length && missing.length === months.length;
      const totalDays = E.dates.daysBetween(start, end) + 1;
      return { all, s, counted, byAccount, pendingReimb, pendingBiz, uncertain, dupes, excluded, boughtBefore, postedAfter, partial, missing, incomplete, noData, months, totalDays };
    });
  }

  function queueReconcile(ctx, P) {
    const refs = allReferences(ctx);
    const notes = [];
    let selected = null;
    if (P.ref) {
      const r = refs.find(x => x.id === P.ref);
      if (r) selected = { ref: r, start: r.start, end: r.end };
      else notes.push(c.notice({ tone: 'warn', title: 'That reference is not saved here.', body: 'It may have been removed, or saved in another browser. Pick one below or add it again.' }));
    }
    if (!selected && P.start && P.end) selected = { ref: null, start: P.start, end: P.end };
    const intro = `<p class="rv-intro">Have a total from somewhere else, such as a card statement or an earlier budget? Enter it to see it next to what the app counts as spending for the same dates, with the pieces that usually explain a gap.</p>`;
    const list = referenceList(ctx, refs, selected);
    const form = referenceForm(ctx, P, selected);
    const result = selected ? reconcileResult(ctx, selected) : { head: '', rest: '' };
    const full = ctx.months.filter(m => (ctx.coverageMap[m] || {}).status === 'full').slice(-4).reverse();
    const quick = full.length ? `<p class="rv-quick"><span>Or see the app's breakdown for a month:</span> ${full.map(m => goLink(ctx, esc(fmt.month(m)), { queue: 'reconcile', start: E.months.start(m), end: E.months.end(m) }, { id: 'rv-rec-m-' + m, focus: 'rv-rec-h', cls: 'btn btn-small btn-secondary', current: !!selected && !selected.ref && selected.start === E.months.start(m) && selected.end === E.months.end(m) })).join(' ')}</p>` : '';
    const grid = `<div class="rv-rec-grid"><div class="stack">${list}${quick}</div>${form}</div>`;
    // Dates without a reference amount: the form to enter it comes right after the app's figure.
    if (selected && !selected.ref) return `${intro}${notes.join('')}<div class="stack">${result.head}${grid}${result.rest}</div>`;
    return `${intro}${notes.join('')}<div class="stack">${selected ? result.head + result.rest : ''}${grid}</div>`;
  }

  function referenceList(ctx, refs, selected) {
    if (!refs.length) return c.card(c.empty('No reference totals yet. Add one with the form.'), { title: 'Reference totals', id: 'rv-refs' });
    const rows = refs.map(r => {
      const d = reconcileData(ctx, r.start, r.end);
      const app = d.noData ? null : d.s.spendingCents;
      const diff = typeof r.spendingCents === 'number' && app !== null ? r.spendingCents - app : null;
      return { r, app, diff, d };
    });
    const table = stackTable({
      caption: 'Reference totals and the app’s spending for the same dates',
      columns: [
        { key: 'l', label: 'Name', html: x => `${goLink(ctx, esc(x.r.label), { queue: 'reconcile', ref: x.r.id }, { id: 'rv-ref-open-' + x.r.id, focus: 'rv-rec-h', current: selected && selected.ref && selected.ref.id === x.r.id })}<small>${esc(fmt.date(x.r.start))} – ${esc(fmt.date(x.r.end))} · ${esc(x.r.origin === 'user' ? 'Added by you' : (x.r.origin === 'profile' ? 'From the household profile' : 'From the data file') + (x.r.source ? ` (${x.r.source})` : ''))}</small>` },
        { key: 'ref', label: 'Reference total', align: 'right', html: x => money(x.r.spendingCents) },
        { key: 'app', label: 'App spending', align: 'right', html: x => (x.app === null ? 'Unknown<small>No data for these dates</small>' : `${money(x.app)}${x.d.incomplete.length ? '<small>Incomplete data</small>' : ''}`) },
        { key: 'd', label: 'Difference', align: 'right', html: x => (x.diff === null ? 'Unknown' : Math.abs(x.diff) < MATCH_TOLERANCE ? c.badge('Agree', 'good') : esc(fmt.diff(x.diff))) },
        { key: 'x', label: 'Remove', html: x => (x.r.origin === 'user' ? `<button type="button" class="btn btn-ghost btn-small" id="rv-ref-rm-${esc(x.r.id)}" data-action="review:ref-remove" data-ref="${esc(x.r.id)}">Remove<span class="sr-only"> ${esc(x.r.label)}</span></button>` : `<span class="fine">${x.r.origin === 'profile' ? 'Part of the profile' : 'Part of the data'}</span>`) },
      ],
      rows,
      cls: 'rv-compact rv-refs-table',
    });
    return c.card(`${table}<p class="fine">Difference = reference − app. Positive means the reference is higher.</p>`, { title: 'Reference totals', id: 'rv-refs' });
  }

  function referenceForm(ctx, P, selected) {
    const start = (selected && !selected.ref && selected.start) || '';
    const end = (selected && !selected.ref && selected.end) || '';
    const fld = (id, label, input, help = '') => `<div class="field"><label for="${esc(id)}">${esc(label)}</label>${input}${help ? `<p class="field-help" id="${esc(id)}-help">${help}</p>` : ''}<p class="field-error" id="${esc(id)}-error" role="alert" hidden></p></div>`;
    const body = `<form class="rv-form rv-refform" id="rv-ref-form" data-action="review:ref-add" novalidate>
      ${fld('rv-ref-label', 'Name', `<input id="rv-ref-label" name="label" type="text" maxlength="80" autocomplete="off" placeholder="e.g. Card statement, March" aria-describedby="rv-ref-label-error">`)}
      <div class="rv-form-grid rv-ref-dates">
        ${fld('rv-ref-start', 'From', `<input id="rv-ref-start" name="start" type="date" value="${esc(start)}" aria-describedby="rv-ref-start-error">`)}
        ${fld('rv-ref-end', 'To (inclusive)', `<input id="rv-ref-end" name="end" type="date" value="${esc(end)}" aria-describedby="rv-ref-end-error">`)}
      </div>
      ${fld('rv-ref-amount', 'Total spending in the reference', `<div class="input-money"><span aria-hidden="true">$</span><input id="rv-ref-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-describedby="rv-ref-amount-help rv-ref-amount-error"></div>`, 'As printed. Use a minus sign for a net refund.')}
      <div class="rv-form-actions"><button type="submit" class="btn btn-primary btn-small" id="rv-ref-save">Add and compare</button></div>
    </form>`;
    return c.card(body, { title: 'Add a reference total', subtitle: 'Saved in this browser with your budget.', id: 'rv-ref-add' });
  }

  function reconcileResult(ctx, sel) {
    const { start, end, ref } = sel;
    const d = reconcileData(ctx, start, end);
    const s = d.s;
    const app = d.noData ? null : s.spendingCents;
    const refCents = ref && typeof ref.spendingCents === 'number' ? ref.spendingCents : null;
    const diff = refCents === null || app === null ? null : refCents - app;
    const pp = periodParam(start, end);
    const sp = extra => ctx.href('spending', { period: pp.period, ...extra });
    const periodText = `${fmt.date(start)} – ${fmt.date(end)}`;
    const diffText = app === null ? 'Unknown' : diff === null ? 'Not compared' : Math.abs(diff) < MATCH_TOLERANCE ? 'Agree within $1' : fmt.diff(diff);
    const diffSub = app === null ? 'There is no data to compare with'
      : diff === null ? 'Add the reference total to compare'
        : (Math.abs(diff) < MATCH_TOLERANCE ? 'Nothing to explain' : diff > 0 ? 'The reference is higher than the app' : 'The reference is lower than the app')
          + (d.incomplete.length ? '. Part of it may be data that is missing' : '');
    const metrics = `<div class="metrics rv-metrics">
      ${c.metric({ label: ref ? `Reference: ${ref.label}` : 'Reference', value: refCents === null ? 'Not entered' : fmt.money(refCents), sub: esc(periodText) })}
      ${c.metric({ label: 'App spending, same dates', value: app === null ? 'Unknown' : fmt.money(app), sub: app === null ? 'No exports cover these dates' : `<a href="${esc(sp({ list: '1' }))}">${count(d.counted.filter(t => t.kind === 'spend').length, 'transaction')}</a>${d.incomplete.length ? ' · only what is in the data' : ''}` })}
      ${c.metric({ label: 'Difference (reference − app)', value: diffText, sub: diffSub, tone: diff !== null && Math.abs(diff) >= MATCH_TOLERANCE ? 'warn' : '' })}
    </div>`;
    const warns = [];
    const dataSpan = ctx.months.length ? `Your data runs from ${fmt.month(ctx.months[0])} to ${fmt.month(ctx.months[ctx.months.length - 1])}.` : 'No transactions are loaded.';
    if (d.noData) warns.push(c.notice({ tone: 'warn', title: 'Your exports do not cover these dates', body: `The app's spending for ${esc(periodText)} is unknown, not $0. ${esc(dataSpan)} Load exports for these dates in <a href="${esc(ctx.href('data'))}">Data &amp; privacy</a> to compare.` }));
    else {
      if (d.missing.length) warns.push(c.notice({ tone: 'warn', title: `${E.compare.describeMonths(d.missing)} ${d.missing.length === 1 ? 'is' : 'are'} not in your exports`, body: `The app's total leaves out ${d.missing.length === 1 ? 'that month' : 'those months'}, so it is too low by an unknown amount. ${esc(dataSpan)}` }));
      if (d.partial.length) warns.push(c.notice({ tone: 'warn', title: `${E.compare.describeMonths(d.partial)} ${d.partial.length === 1 ? 'is' : 'are'} only partly covered by your exports`, body: `The app can only count what is in the data for ${d.partial.length === 1 ? 'that month' : 'those months'}, so its total is likely too low there. <a href="${esc(qHref(ctx, 'coverage'))}">See coverage</a>.` }));
    }
    if (!pp.aligned) warns.push(c.notice({ tone: 'info', title: 'Spending links show whole months', body: `This period does not start and end on month boundaries. The totals here use exactly ${esc(periodText)}; links open the whole month${pp.period.includes('..') ? 's' : ''} in Spending.` }));

    // Breakdown rows. `list` (optional) holds the transactions behind the amount, shown on request.
    const R = (label, cents, n, counted, href, note = '', list = null, amountOf = null) => ({ label, cents, n, counted, href, note, list, amountOf });
    const groups = [
      { title: 'What the app counts', rows: [
        R('Purchases', s.purchasesCents, null, 'Yes', sp({ list: '1' })),
        R('Refunds', -s.refundsCents, null, 'Yes, lowers spending', sp({ list: '1' }), 'A statement may list refunds as payments or credits instead.'),
        R('App spending', app, null, '= purchases − refunds', sp({ list: '1' })),
      ] },
      { title: 'By account', rows: d.byAccount.map(g => R(g.label || g.key, g.spendCents, g.count, 'Yes', sp({ acct: g.key }), 'A single-account statement only matches its own line.')) },
      { title: 'Left out of app spending', rows: [
        R('Debt payments', s.debtPaymentsCents, null, 'No, shown apart', sp({ kind: 'debt' }), 'Loan and financing payments are not category spending.'),
        R('Card payments', s.cardPaymentsCents, null, 'No', sp({ kind: 'card' }), 'Paying the card moves money; the card purchases are the spending.'),
        R('Moved to savings (net)', s.savedNetCents, null, 'No', sp({ kind: 'transfer' }), 'Saving is not spending.'),
        R('Rows you excluded', s.excludedCents, d.excluded.length, 'No', sp({ show: 'excluded' }), 'Duplicates, reimbursed and business rows, and paid-back parts.', d.excluded, t => (t.excluded ? grossSpend(t) : t.reimbursedCents)),
        R('Bought in the period, posted after it', sum(d.postedAfter, spendOf), d.postedAfter.length, 'No (posted later)', d.postedAfter.length === 1 ? txnHref(ctx, d.postedAfter[0]) : sp({}), 'The app uses the posted date; a statement may use the purchase date.', d.postedAfter),
      ] },
      { title: 'Counted, but may change', rows: [
        R('Possible duplicates (second copies)', sum(d.dupes, spendOf), d.dupes.length, 'Yes, until decided', qHref(ctx, 'duplicates'), 'Decide in Data review.', d.dupes),
        R('Pending reimbursements', sum(d.pendingReimb, spendOf), d.pendingReimb.length, 'Yes, until confirmed', qHref(ctx, 'reimbursements'), 'Decide in Data review.', d.pendingReimb),
        R('Pending business purchases', sum(d.pendingBiz, spendOf), d.pendingBiz.length, 'Yes, until decided', qHref(ctx, 'business'), 'Decide in Data review.', d.pendingBiz),
        R('Uncertain categories', sum(d.uncertain, spendOf), d.uncertain.length, 'Yes (only the category is unsure)', qHref(ctx, 'uncertain'), '', d.uncertain),
        R('Posted in the period, bought before it', sum(d.boughtBefore, spendOf), d.boughtBefore.length, 'Yes (posted date)', d.boughtBefore.length === 1 ? txnHref(ctx, d.boughtBefore[0]) : sp({ list: '1' }), 'A statement by purchase date would leave these out.', d.boughtBefore),
      ] },
    ];
    const rowsHtml = groups.map((g, gi) => g.rows.length ? `<tbody><tr class="rv-rec-group"><th scope="colgroup" colspan="3" id="rv-rec-g${gi}">${esc(g.title)}</th></tr>${g.rows.map((r, ri) => `<tr class="${r.label === 'App spending' ? 'rv-rec-total' : ''}${!r.cents && !r.n ? ' rv-zero' : ''}">
        <th scope="row" headers="rv-rec-g${gi}"><a href="${esc(r.href)}">${esc(r.label)}</a>${r.n ? `<small>${count(r.n, 'row')}</small>` : ''}${r.note ? `<small>${esc(r.note)}</small>` : ''}${rowList(ctx, r, gi, ri)}</th>
        <td class="num"><span class="rv-ml" aria-hidden="true">Amount</span>${money(r.cents)}</td>
        <td><span class="rv-ml" aria-hidden="true">Counted?</span>${esc(r.counted)}</td>
      </tr>`).join('')}</tbody>` : '').join('');
    const partialRow = `<p class="fine">Months in the period: ${esc(E.compare.describeMonths(d.months))}. ${d.incomplete.length ? `<strong>Incomplete coverage: ${esc(E.compare.describeMonths(d.incomplete))}</strong> (<a href="${esc(qHref(ctx, 'coverage'))}">coverage</a>).` : 'All fully covered.'}</p>`;
    const table = `<div class="table-wrap rv-rec-wrap" tabindex="0" role="region" aria-label="Breakdown of app spending for ${esc(periodText)}">
      <table class="table rv-rec-table"><caption class="sr-only">Breakdown of app spending for ${esc(periodText)}</caption>
      <thead><tr><th scope="col">Part</th><th scope="col" class="num">Amount</th><th scope="col">Counted in app spending?</th></tr></thead>${rowsHtml}</table></div>`;
    const breakdown = c.card(table + partialRow, { title: 'Breakdown', subtitle: 'The pieces that most often explain a gap. Each opens the transactions behind it.', id: 'rv-rec-breakdown' });
    const explain = diff === null || Math.abs(diff) < MATCH_TOLERANCE ? '' : explanations(ctx, d, groups, diff, start, end);
    const head = c.card(metrics + (warns.length ? `<div class="stack-sm rv-rec-notes">${warns.join('')}</div>` : ''), { title: ref ? `Comparing “${ref.label}”` : `App spending, ${periodText}`, subtitle: ref ? esc(periodText) : 'Enter the reference total for these dates to see the difference.', id: 'rv-rec' });
    // With no data for the dates, a breakdown of zeros would only look like a known $0.
    return { head, rest: d.noData ? '' : explain + breakdown };
  }

  /** The transactions behind one breakdown amount, each opening in Spending (audit detail). */
  function rowList(ctx, r, gi, ri) {
    if (!r.list || !r.list.length) return '';
    const shown = r.list.slice().sort(byDateDesc).slice(0, 50);
    const amount = r.amountOf || spendOf;
    return `<details class="rv-rows" id="rv-rec-rows-${gi}-${ri}"><summary>Show ${r.list.length === 1 ? 'the transaction' : `the ${r.list.length} transactions`}<span class="sr-only">: ${esc(r.label)}</span></summary>
      <ul>${shown.map(t => `<li><a href="${esc(txnHref(ctx, t))}">${esc(fmt.date(t.date))} · ${esc(merchantOf(t))}</a> <span class="num">${money(amount(t))}</span></li>`).join('')}</ul>
      ${r.list.length > shown.length ? `<p class="fine">The newest ${shown.length} are listed.</p>` : ''}</details>`;
  }

  function explanations(ctx, d, groups, diff, start, end) {
    const target = Math.abs(diff);
    const close = cents => typeof cents === 'number' && cents !== 0 && Math.abs(Math.abs(cents) - target) <= MATCH_TOLERANCE;
    const out = [];
    for (const g of groups) for (const r of g.rows) {
      if (r.label === 'App spending' || r.label === 'Purchases' || !close(r.cents)) continue;
      out.push(`<li><strong>The difference (${money(target)}) is within $1 of “${esc(r.label)}” (${money(Math.abs(r.cents))}).</strong> ${esc(hintFor(r.label, diff))} <a href="${esc(r.href)}">Look at them</a></li>`);
    }
    const singles = d.all.filter(t => close(t.amountCents)).sort((a, b) => Math.abs(Math.abs(a.amountCents) - target) - Math.abs(Math.abs(b.amountCents) - target)).slice(0, 8);
    for (const t of singles) {
      out.push(`<li><strong>Within $1 of one transaction:</strong> ${esc(fmt.date(t.date))}, ${esc(merchantOf(t))}, ${esc(sh().amountText(t))} (${esc(lowerFirst(sh().kindLabel(t)))}${t.excluded ? ', not counted' : ''}). <a href="${esc(txnHref(ctx, t))}">Open it</a></li>`);
    }
    const body = out.length
      ? `<ul class="rv-explain">${out.join('')}</ul>`
      : '<p>No single part or transaction matches the difference within $1. The gap may combine several items: work through the breakdown below, starting with the parts the app leaves out.</p>';
    return c.card(`<p class="fine">Amounts within $1 of the difference. These are possibilities to check, not conclusions; nothing is changed or matched automatically.</p>${body}`,
      { title: 'Possible explanations', subtitle: `Difference ${esc(fmt.diff(diff))} (${diff > 0 ? 'the reference is higher' : 'the reference is lower'})`, id: 'rv-rec-explain' });
  }

  function hintFor(label, diff) {
    const higher = diff > 0;
    const leftOut = ['Debt payments', 'Card payments', 'Moved to savings (net)', 'Rows you excluded', 'Bought in the period, posted after it'];
    if (label === 'Refunds') return higher ? 'A reference that lists purchases only, without refunds, would be higher by this much.' : 'The direction does not fit refunds alone; check whether the reference subtracts something else.';
    if (leftOut.includes(label)) return higher ? 'The app leaves these out of spending; a reference that includes them would be higher by this much.' : 'The app already leaves these out, so they would make the reference higher, not lower. Check the dates and accounts the reference covers.';
    return higher ? 'The app counts these; the direction does not fit, since leaving them out would make the app lower. Check the dates and accounts the reference covers.' : 'The app counts these now; a reference that leaves them out would be lower by this much.';
  }

  // ------------------------------------------------------------------ where a transaction is waiting
  /**
   * The queue that lists a transaction: where it waits for a decision (in the index's priority
   * order, so a possible duplicate wins over its mixed-retail category), then where it is shown.
   */
  function whereIs(ctx, q, id) {
    const t = findTxn(ctx, id);
    if (q.duplicates.some(d => d.ids.includes(id))) return 'duplicates';
    if (uncertainOpen(q).some(x => x.id === id)) return 'uncertain';
    if (openTransfers(q).some(x => x.id === id)) return 'transfers';
    if (q.reimbursements.some(r => r.chargeId === id || r.depositId === id)) return 'reimbursements';
    if (q.business.some(x => x.id === id)) return 'business';
    if (q.spikes.some(s => s.ids.includes(id)) || (q.annualSpikes || []).some(s => s.ids.includes(id))) return 'spikes';
    if (q.mixedRetail.some(x => x.id === id)) return 'mixed';
    if (t && t.edit && t.edit.duplicate) return 'duplicates';
    if ((q.transfers.unpaired || []).some(x => x.id === id) || (q.transfers.paired || []).some(p => p.ids.includes(id))) return 'transfers';
    if (q.edited.some(x => x.id === id)) return 'edited';
    return null;
  }

  /**
   * Context for a link that names a transaction (txn param). `highlighted` says whether this
   * queue's page marks it; if not, say where it is listed instead of silently showing nothing.
   */
  function targetNotice(ctx, P, q, highlighted) {
    if (!P.txn || !P.queue || ['coverage', 'reconcile'].includes(P.queue)) return '';
    const t = findTxn(ctx, P.txn);
    if (!t) return c.notice({ tone: 'warn', title: 'That transaction is not in the loaded data.', body: `It may come from a file that is no longer loaded. Corrections to it are kept in the <a href="${esc(qHref(ctx, 'edited'))}">corrections log</a>.` });
    const label = `${merchantOf(t)}, ${fmt.date(t.date)}`;
    if (highlighted) {
      if (P.queue === 'transfers' && (q.transfers.paired || []).some(p => p.ids.includes(P.txn))) {
        return c.notice({ tone: 'info', title: `${label} is matched with its other side.`, body: 'Both sides are in your data, so it is explained and not counted as spending. It is highlighted under “Matched, not counted as spending” below.' });
      }
      const u = P.queue === 'transfers' ? (q.transfers.unpaired || []).find(x => x.id === P.txn) : null;
      if (u && u.expected && !answeredTransfer(u)) {
        return c.notice({ tone: 'info', title: `${label} needs no answer.`, body: `${esc(u.reason)} It is highlighted under “No other side expected” below.` });
      }
      if (P.queue === 'duplicates' && !q.duplicates.some(d => d.ids.includes(P.txn))) {
        return c.notice({ tone: 'info', title: `The possible duplicate of ${label} is already decided.`, body: 'The decision is highlighted under “Already decided” below. Reopen it there to decide again.' });
      }
      if (P.from && P.from !== P.queue) {
        return c.notice({ tone: 'info', title: `${label} is listed in ${QUEUES[P.queue].title}, so it opened here.`, body: `The link asked for ${esc(QUEUES[P.from].title)}, where it is not waiting.` });
      }
      return '';
    }
    const where = whereIs(ctx, q, P.txn);
    return c.notice({ tone: 'info', title: `${label} is not waiting in ${QUEUES[P.queue].title}.`,
      body: where && where !== P.queue ? `It is listed in <a href="${esc(qHref(ctx, where, { txn: t.id }))}">${esc(QUEUES[where].title)}</a>.` : `Nothing about it needs a decision here. <a href="${esc(txnHref(ctx, t))}">Open it in Spending</a>.` });
  }

  // ------------------------------------------------------------------ render
  const RENDER = {
    uncertain: queueUncertain, mixed: queueMixed, duplicates: queueDuplicates, transfers: queueTransfers,
    reimbursements: queueReimbursements, business: queueBusiness, spikes: queueSpikes, coverage: queueCoverage,
    edited: queueEdited, reconcile: queueReconcile,
  };

  function render(ctx) {
    const P = readParams(ctx);
    const q = ctx.reviewQueues();
    const info = queueInfo(ctx, q);
    const meta = P.queue ? QUEUES[P.queue] : null;
    const crumbs = meta ? c.breadcrumbs([{ label: 'Review', href: ctx.href('review') }, { label: meta.title }]) : '';
    const header = c.pageHeader({
      eyebrow: 'Data review',
      title: meta ? meta.title : 'Data review',
      subtitle: meta ? esc(meta.line) : 'Check what the import could not be sure about. Your bank data is never changed: each decision is saved as a correction with your reason, and can be undone.',
    });
    const notes = P.notes.map(n => c.notice({ tone: 'warn', title: 'Part of this link was not understood', body: esc(n) })).join('');
    const noData = !ctx.dataset.transactions.length && P.queue !== 'reconcile'
      ? c.notice({ tone: 'info', title: 'No transactions are loaded', body: 'Review queues fill in once bank exports are loaded. Budget inputs that are missing are still listed below.', actions: c.linkButton('Load data', ctx.href('data'), { variant: 'primary' }) }) : '';
    let body;
    try {
      body = P.queue ? RENDER[P.queue](ctx, P, q, info) : indexBody(ctx, q, info);
    } catch (err) {
      console.error(err);
      body = c.notice({ tone: 'bad', title: 'This queue could not be displayed.', body: esc(err.message) + ' Your saved corrections are unchanged.' });
    }
    // A link that names a transaction in the wrong queue (e.g. from a page that does not know
    // every queue) opens the queue where it is listed instead, replacing the history entry.
    const highlighted = / data-rv-target="/.test(body);
    const where = P.txn && P.queue && !highlighted && !['coverage', 'reconcile'].includes(P.queue) && !P.from ? whereIs(ctx, q, P.txn) : null;
    const redirect = where && where !== P.queue ? { queue: where, txn: P.txn, from: P.queue } : null;
    return `<div class="rv rv-q-${esc(P.queue || 'index')}"${redirect ? ` data-rv-redirect="${esc(JSON.stringify(redirect))}"` : ''}>
      ${crumbs}${header}${tabs(ctx, P, info)}
      ${notes || noData ? `<div class="stack-sm rv-notes">${notes}${noData}</div>` : ''}
      ${targetNotice(ctx, P, q, highlighted)}
      ${body}
    </div>`;
  }

  // ------------------------------------------------------------------ after render: focus, live sums
  let focusAfter = null;

  function focusEl(el) {
    if (!el) return;
    if (!el.matches('a[href], button, input, select, textarea, [tabindex]')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
    const r = el.getBoundingClientRect();
    if (r.top < 70 || r.bottom > root.innerHeight - 80) el.scrollIntoView({ block: 'center' });
  }

  function onInput(ev) {
    const el = ev.target;
    if (!el || !el.closest || !el.closest('.rv')) return;
    if (el.getAttribute('aria-invalid') === 'true') {
      el.removeAttribute('aria-invalid');
      const err = document.getElementById(el.id + '-error');
      if (err) { err.textContent = ''; err.hidden = true; }
    }
    if (el.type === 'radio') {
      const fs = el.closest('fieldset');
      const err = fs && fs.querySelector('.field-error');
      if (err) { err.textContent = ''; err.hidden = true; }
      if (fs) fs.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
    }
    const form = el.closest('form.rv-split');
    if (form) refreshSplit(form);
  }

  function afterRender(container, ctx) {
    if (!container.__rvBound) {
      container.addEventListener('input', onInput);
      container.addEventListener('change', onInput);
      container.__rvBound = true;
    }
    const moveTo = container.querySelector('[data-rv-redirect]');
    if (moveTo) {
      let params = null;
      try { params = JSON.parse(moveTo.dataset.rvRedirect); } catch { params = null; }
      // Deferred: never navigate from inside a render.
      if (params) { setTimeout(() => ctx.app.navigate('review', params, { replace: true }), 0); return; }
    }
    // Phones show the queue tabs as a scrolling strip: keep the current one in view.
    const strip = container.querySelector('.rv-tabs .section-nav');
    const cur = strip && strip.querySelector('[aria-current]');
    if (cur && strip.scrollWidth > strip.clientWidth) strip.scrollLeft += cur.getBoundingClientRect().left - strip.getBoundingClientRect().left - 16;

    if (focusAfter) {
      const id = focusAfter;
      focusAfter = null;
      // After the app restores focus by element id, so the chosen target wins.
      setTimeout(() => focusEl(document.getElementById(id) || document.getElementById('rv-list-h') || document.getElementById('page-title')), 0);
      return;
    }
    // A link that names a transaction (txn param): open its section and focus it, but only on
    // arrival (a link, Back, a reload). The app has then focused the page heading, or nothing.
    // After an action on this page focus is on a control and must stay there.
    const target = container.querySelector('[data-rv-target]');
    if (target) {
      setTimeout(() => {
        const a = document.activeElement;
        if (a && a !== document.body && a.id !== 'page-title') return;
        if (!container.contains(target)) return;
        for (let d = target.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
        focusEl(document.getElementById(target.dataset.rvTarget) || target);
      }, 0);
    }
  }

  // ------------------------------------------------------------------ actions
  function fieldError(inputId, message, errorId) {
    const input = document.getElementById(inputId);
    const err = document.getElementById(errorId || inputId + '-error');
    if (err) { err.textContent = message; err.hidden = false; }
    if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
    return false;
  }
  function clearErrors(scope) {
    if (!scope) return;
    scope.querySelectorAll('[aria-invalid="true"]').forEach(el => el.removeAttribute('aria-invalid'));
    scope.querySelectorAll('.field-error').forEach(el => { el.textContent = ''; el.hidden = true; });
  }
  /** Where focus goes after a decision: this item (stay), else the next item, else the list heading. */
  function setFocusNext(el, stay) {
    const it = el.closest('[data-rv-item]');
    if (!it) { focusAfter = el.dataset.focus || null; return; }
    if (stay) { focusAfter = it.dataset.rvHead; return; }
    const sibs = [...it.parentElement.children].filter(x => x.matches('[data-rv-item]'));
    const i = sibs.indexOf(it);
    const next = sibs[i + 1] || sibs[i - 1];
    focusAfter = next ? next.dataset.rvHead : 'rv-list-h';
  }
  const REASON_MISSING = 'Add a short reason first. It is kept in the corrections log so you both know why.';

  const actions = {
    /** Links that change a param in place (filters, pages): keep focus on the list, not the page top. */
    'review:go': (ctx, el) => {
      let params = {};
      try { params = JSON.parse(el.dataset.params || '{}'); } catch { params = {}; }
      const target = el.dataset.focus || 'rv-list-h';
      if (ctx.href('review', params) === location.hash) { focusEl(document.getElementById(target)); return; }
      focusAfter = target;
      ctx.app.navigate('review', params, { keepFocus: true });
    },

    /** Category form submit (uncertain and mixed retail). */
    'review:category': (ctx, form, ev) => {
      if (!ev || ev.type !== 'submit') return;
      clearErrors(form);
      const t = findTxn(ctx, form.dataset.txn);
      if (!t) { ctx.app.toast('That transaction is no longer in the data.'); return; }
      const base = form.id;
      const data = new FormData(form);
      const category = String(data.get('category') || '').trim();
      const reason = String(data.get('reason') || '').trim();
      if (!category) return void fieldError(base + '-cat', 'Choose a category.');
      if (!reason) return void fieldError(base + '-reason', REASON_MISSING);
      const uncertainIds = new Set(ctx.reviewQueues().uncertain.map(x => x.id));
      const others = data.get('allSame')
        ? ctx.txns.filter(x => x.id !== t.id && x.kind === 'spend' && merchantOf(x) === merchantOf(t) && !x.edited && (x.category !== category || uncertainIds.has(x.id)))
        : [];
      const targets = [t, ...others];
      setFocusNext(form, false);
      sh().editMany(ctx.app, targets.map(x => ({ txnId: x.id, field: 'category', value: category, reason })),
        { message: `${merchantOf(t)}: category set to ${category}${others.length ? ` for ${targets.length} purchases` : ''}.` });
    },

    /** Kind answer for deposits and unmatched transfers. */
    'review:kind': (ctx, form, ev) => {
      if (!ev || ev.type !== 'submit') return;
      clearErrors(form);
      const t = findTxn(ctx, form.dataset.txn);
      if (!t) { ctx.app.toast('That transaction is no longer in the data.'); return; }
      const base = form.id;
      const data = new FormData(form);
      const choices = t.amountCents > 0 ? IN_CHOICES : OUT_CHOICES;
      const ch = choices.find(x => x.key === data.get('choice'));
      if (!ch) return void fieldError(base + '-k-' + choices[0].key, 'Choose one of the answers.', base + '-choice-error');
      const category = String(data.get('category') || '').trim();
      if (ch.needsCategory && !category) return void fieldError(base + '-cat', `Choose a category for ${lowerFirst(ch.label)}.`);
      const reason = String(data.get('reason') || '').trim();
      if (!reason) return void fieldError(base + '-reason', REASON_MISSING);
      const edit = t.edit || {};
      const changes = [{ txnId: t.id, field: 'kind', value: ch.kind, reason }];
      if (ch.subtype) changes.push({ txnId: t.id, field: 'subtype', value: ch.subtype, reason });
      else if (edit.subtype !== undefined && edit.subtype !== null) changes.push({ txnId: t.id, field: 'subtype', value: null, reason });
      if (ch.needsCategory) changes.push({ txnId: t.id, field: 'category', value: category, reason });
      setFocusNext(form, false);
      sh().editMany(ctx.app, changes, { message: `${merchantOf(t)} is now counted as ${ch.short}${ch.needsCategory ? ` (${category})` : ''}.` });
    },

    /** One field on one or more transactions, reason from an input (or fixed in data-reason). */
    'review:decide': (ctx, el) => {
      const ids = (el.dataset.txns || '').split(',').filter(Boolean);
      if (!ids.length) return;
      const field = el.dataset.field;
      const value = el.dataset.value === '' || el.dataset.value === undefined ? null : el.dataset.value;
      let reason = el.dataset.reason || '';
      if (el.dataset.reasonFrom) {
        const input = document.getElementById(el.dataset.reasonFrom);
        if (input) {
          input.removeAttribute('aria-invalid');
          const err = document.getElementById(input.id + '-error');
          if (err) { err.hidden = true; err.textContent = ''; }
          reason = input.value.trim();
        }
        if (!reason) return void fieldError(el.dataset.reasonFrom, REASON_MISSING);
      }
      if (!reason) reason = 'Decided in Data review';
      if (el.dataset.focus) focusAfter = el.dataset.focus;
      else setFocusNext(el, el.dataset.stay === '1');
      sh().editMany(ctx.app, ids.map(txnId => ({ txnId, field, value, reason })), { message: el.dataset.message || 'Saved.' });
    },

    /** Reimbursement decision form: applies to both sides of the pair. */
    'review:reimb': (ctx, form, ev) => {
      if (!ev || ev.type !== 'submit') return;
      clearErrors(form);
      const base = form.id;
      const ids = (form.dataset.txns || '').split(',').filter(Boolean);
      const data = new FormData(form);
      const status = String(data.get('status') || '');
      if (!status) return void fieldError(base + '-s-pending', 'Choose one of the answers.', base + '-status-error');
      if (status === form.dataset.current) return void fieldError(base + '-s-' + status, 'That is already the decision. Choose another answer to change it.', base + '-status-error');
      const reason = String(data.get('reason') || '').trim();
      if (!reason) return void fieldError(base + '-reason', REASON_MISSING);
      const value = status === 'pending' ? null : status;
      const changes = ids.filter(id => {
        if (value !== null) return true;
        const t = findTxn(ctx, id);
        return t && t.edit && t.edit.reimbursement;
      }).map(txnId => ({ txnId, field: 'reimbursement', value, reason }));
      if (!changes.length) return;
      setFocusNext(form, true);
      const msg = { confirmed: 'Marked as reimbursed: neither the charge nor the deposit counts now.', not_reimbursed: 'Marked as not reimbursed: the charge stays a household cost.', pending: 'Back to pending: both sides count again.' }[status];
      sh().editMany(ctx.app, changes, { message: msg });
    },

    /** Split form submit: parts must add up exactly to the purchase. */
    'review:split': (ctx, form, ev) => {
      if (!ev || ev.type !== 'submit') return;
      clearErrors(form);
      const t = findTxn(ctx, form.dataset.txn);
      if (!t) { ctx.app.toast('That transaction is no longer in the data.'); return; }
      const base = form.id;
      const total = Number(form.dataset.total);
      const rows = readSplitRows(form);
      if (rows.length < 2) return void fieldError(base + '-add', 'A split needs at least two parts. To use one category, use “Set a category” instead.', base + '-error');
      const parts = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const catId = r.row.querySelector('select').id, amtId = r.row.querySelector('input').id;
        if (!r.category) return void fieldError(catId, `Choose a category for part ${i + 1}.`);
        const cents = parseAmountLoose(r.amount, total < 0);
        if (Number.isNaN(cents) || cents === null) return void fieldError(amtId, `Enter an amount for part ${i + 1}, such as 25 or 25.50.`);
        if (cents === 0) return void fieldError(amtId, `Part ${i + 1} is $0. Remove it or enter an amount.`);
        parts.push({ category: r.category, cents });
      }
      const check = E.ledger.checkSplits(parts, total);
      if (!check.ok) {
        const assigned = sum(parts, p => p.cents);
        const left = total - assigned;
        return void fieldError(rows[rows.length - 1].row.querySelector('input').id,
          `The parts add up to ${fmt.money(assigned)}, but the purchase is ${fmt.money(total)}. ${left > 0 ? fmt.money(left) + ' is not assigned yet.' : fmt.money(-left) + ' too much is assigned.'} Change the amounts so they add up exactly.`, base + '-error');
      }
      const reason = String(new FormData(form).get('reason') || '').trim();
      if (!reason) return void fieldError(base + '-reason', REASON_MISSING);
      delete drafts.split[t.id];
      setFocusNext(form, false);
      sh().editMany(ctx.app, [{ txnId: t.id, field: 'splits', value: parts, reason }],
        { message: `${merchantOf(t)} ${fmt.money(total)} split into ${parts.map(p => `${p.category} ${fmt.money(p.cents)}`).join(' + ')}.` });
    },

    'review:split-add': (ctx, el) => {
      const form = el.closest('form.rv-split');
      if (!form) return;
      const rowsEl = form.querySelector('.rv-split-rows');
      if (rowsEl.children.length >= E.state.LIMITS.splits) { fieldError(el.id, `A split can have at most ${E.state.LIMITS.splits} parts.`, form.id + '-error'); return; }
      const i = Number(form.dataset.next || rowsEl.children.length);
      form.dataset.next = String(i + 1);
      const total = Number(form.dataset.total);
      const assigned = sum(readSplitRows(form), r => { const v = parseAmountLoose(r.amount, total < 0); return Number.isNaN(v) || v === null ? 0 : v; });
      const left = total - assigned;
      rowsEl.insertAdjacentHTML('beforeend', splitRowHtml(ctx, form.dataset.txn, i, { amount: left > 0 ? UI.dom.centsToInput(left) : '' }, rowsEl.children.length + 1));
      refreshSplit(form);
      const sel = rowsEl.lastElementChild.querySelector('select');
      if (sel) sel.focus();
    },

    'review:split-remove': (ctx, el) => {
      const form = el.closest('form.rv-split');
      const row = el.closest('.rv-split-row');
      if (!form || !row) return;
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      refreshSplit(form);
      const target = next ? next.querySelector('select') : form.querySelector('[data-action="review:split-add"]');
      if (target) target.focus();
    },

    'review:biz-all': (ctx, el) => {
      const wrap = document.getElementById('rv-biz');
      if (!wrap) return;
      wrap.querySelectorAll('input[name="rv-biz-sel"]').forEach(x => { x.checked = el.checked; });
      bizCount(ctx);
    },
    'review:biz-sel': ctx => bizCount(ctx),

    /** Bulk business decision for the selected rows, one reason for all. */
    'review:business': (ctx, el) => {
      const wrap = document.getElementById('rv-biz');
      if (!wrap) return;
      clearErrors(wrap);
      const ids = [...wrap.querySelectorAll('input[name="rv-biz-sel"]:checked')].map(x => x.value);
      if (!ids.length) return void fieldError('rv-biz-all', 'Select at least one purchase first.', 'rv-biz-sel-error');
      const reasonInput = document.getElementById('rv-biz-reason');
      const reason = reasonInput ? reasonInput.value.trim() : '';
      if (!reason) return void fieldError('rv-biz-reason', REASON_MISSING);
      const target = el.dataset.value;
      const value = target === 'pending' ? null : target;
      const rows = ids.map(id => findTxn(ctx, id)).filter(Boolean);
      const changing = rows.filter(t => (t.businessStatus || 'pending') !== target && (value !== null || (t.edit && t.edit.business)));
      if (!changing.length) return void fieldError('rv-biz-all', `The selected purchases are already ${target === 'business' ? 'business' : target}.`, 'rv-biz-sel-error');
      const cents = sum(changing, grossSpend);
      const n = `${changing.length} purchase${changing.length === 1 ? '' : 's'}`;
      const msg = target === 'business' ? `${n} marked as business: ${fmt.money(cents)} no longer counted as household spending.`
        : target === 'household' ? `${n} marked as household: ${fmt.money(cents)} counted as spending.`
          : `${n} back to pending: counted as household spending until decided.`;
      focusAfter = 'rv-list-h';
      sh().editMany(ctx.app, changing.map(t => ({ txnId: t.id, field: 'business', value, reason })), { message: msg });
    },

    /** Revert every correction on one transaction (history kept). */
    'review:revert': (ctx, el) => {
      const id = el.dataset.txn;
      // review.revertChanges: real edit fields only, and a reimbursement decision on both linked
      // rows; data-fields limits it (e.g. undoing a transfer answer keeps a reimbursement decision).
      const only = el.dataset.fields ? el.dataset.fields.split(',') : null;
      const changes = E.review.revertChanges(ctx.state.ledgerEdits, ctx.txns, id, { only });
      if (!changes.length) return;
      if (el.dataset.focus) focusAfter = el.dataset.focus;
      else setFocusNext(el, el.dataset.stay === '1');
      const both = changes.some(ch => ch.txnId !== id);
      sh().editMany(ctx.app, changes, { message: el.dataset.message || (both ? 'Correction reverted on both linked rows. The history is kept.' : 'Correction reverted to the imported values. The history is kept.') });
    },

    /** Add a reconciliation reference (state.references) and open its comparison. */
    'review:ref-add': (ctx, form, ev) => {
      if (!ev || ev.type !== 'submit') return;
      clearErrors(form);
      const data = new FormData(form);
      const label = String(data.get('label') || '').trim();
      const start = String(data.get('start') || '').trim();
      const end = String(data.get('end') || '').trim();
      const amountText = String(data.get('amount') || '').trim();
      if (!label) return void fieldError('rv-ref-label', 'Give the reference a short name, such as “Card statement, March”.');
      if (label.length > E.state.LIMITS.label) return void fieldError('rv-ref-label', `Use at most ${E.state.LIMITS.label} characters.`);
      if (!E.dates.isDate(start)) return void fieldError('rv-ref-start', 'Choose the first day the reference covers.');
      if (!E.dates.isDate(end)) return void fieldError('rv-ref-end', 'Choose the last day the reference covers.');
      if (end < start) return void fieldError('rv-ref-end', 'The end date must be on or after the start date.');
      let cents;
      try { cents = E.money.inputToCents(amountText, { allowNegative: true }); } catch (err) { return void fieldError('rv-ref-amount', err.message); }
      if (cents === null) return void fieldError('rv-ref-amount', 'Enter the total from the reference, such as 2450.18.');
      const existing = ctx.state.references || [];
      if (existing.length >= E.state.LIMITS.references) return void fieldError('rv-ref-label', `Up to ${E.state.LIMITS.references} references can be kept. Remove one first.`);
      const taken = new Set(allReferences(ctx).map(r => r.id));
      let id = 'ref-' + E.util.hash(label + '|' + start + '|' + end + '|' + cents).slice(0, 8);
      for (let n = 2; taken.has(id); n++) id = id.replace(/-\d+$/, '') + '-' + n;
      const ref = { id, label, start, end, spendingCents: cents, source: 'Added in Data review' };
      const ok = ctx.app.update(st => ({ ...st, references: [...(st.references || []), ref] }), { message: `Reference “${label}” added.`, rerender: false });
      if (!ok) return;
      focusAfter = 'rv-rec-h';
      ctx.app.navigate('review', { queue: 'reconcile', ref: id }, { keepFocus: true });
    },

    'review:ref-remove': (ctx, el) => {
      const id = el.dataset.ref;
      const ref = (ctx.state.references || []).find(r => r.id === id);
      if (!ref) return;
      focusAfter = 'rv-refs-h';
      ctx.app.update(st => ({ ...st, references: (st.references || []).filter(r => r.id !== id) }), { message: `Reference “${ref.label}” removed.` });
      if (ctx.route.params.ref === id) ctx.app.navigate('review', { queue: 'reconcile' }, { keepFocus: true });
    },
  };

  function bizCount(ctx) {
    const wrap = document.getElementById('rv-biz');
    const out = document.getElementById('rv-biz-count');
    if (!wrap || !out) return;
    const boxes = [...wrap.querySelectorAll('input[name="rv-biz-sel"]')];
    const picked = boxes.filter(x => x.checked).map(x => findTxn(ctx, x.value)).filter(Boolean);
    out.textContent = picked.length ? `${picked.length} selected · ${fmt.money(sum(picked, grossSpend))}` : 'None selected';
    const all = document.getElementById('rv-biz-all');
    if (all) { all.checked = picked.length > 0 && picked.length === boxes.length; all.indeterminate = picked.length > 0 && picked.length < boxes.length; }
    if (picked.length) {
      const err = document.getElementById('rv-biz-sel-error');
      if (err) { err.hidden = true; err.textContent = ''; }
      if (all) all.removeAttribute('aria-invalid');
    }
  }

  UI.views = UI.views || {};
  UI.views.review = { title: 'Data review', render, actions, afterRender };
})(typeof globalThis !== 'undefined' ? globalThis : this);
