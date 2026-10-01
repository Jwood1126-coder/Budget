'use strict';
/*
 * Helpers shared by several views: transaction tables and badges, category options, and the
 * ledger-correction actions (category changes, duplicate/reimbursement/business decisions,
 * planning-baseline exclusions). Every correction records a reason and keeps history; the
 * imported data is never modified.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  const KIND_LABEL = {
    spend: 'Spending', income: 'Income', transfer: 'Transfer', card_payment: 'Card payment', debt_payment: 'Debt payment',
  };
  const SUBTYPE_LABEL = {
    payroll: 'Pay', interest: 'Interest', reimbursement: 'Reimbursement', other: 'Other',
    savings: 'Savings transfer', contribution: 'Contribution', internal: 'Between accounts', investment: 'Investment',
    loan: 'Loan', store_card: 'Store card',
  };
  const EXCLUDED_LABEL = {
    duplicate: 'Duplicate — not counted', reimbursed: 'Reimbursed — not counted', business: 'Business — not counted', what_if: 'Left out (what-if)',
  };
  const FLAG_BADGE = {
    needs_category_review: ['Needs category', 'warn'],
    mixed_retail: ['Mixed retailer', 'info'],
    reimbursement_candidate: ['Possible reimbursement', 'warn'],
    business_candidate: ['Possible business', 'warn'],
    duplicate_candidate: ['Possible duplicate', 'warn'],
    unpaired_transfer: ['Unmatched transfer', 'warn'],
    refund: ['Refund', 'neutral'],
    fee: ['Fee', 'neutral'],
  };

  function kindLabel(t) {
    const k = KIND_LABEL[t.kind] || t.kind;
    const s = t.subtype && SUBTYPE_LABEL[t.subtype];
    return s ? `${k} · ${s}` : k;
  }

  /** Text amount from the household's point of view. Spending shows as positive cost, refunds negative. */
  function amountText(t) {
    if (t.kind === 'spend') {
      const spend = -t.amountCents;
      return spend < 0 ? fmt.money(spend) + ' refund' : fmt.money(spend);
    }
    if (t.kind === 'debt_payment') return fmt.money(-t.amountCents);
    return (t.amountCents > 0 ? 'In ' : 'Out ') + fmt.money(Math.abs(t.amountCents));
  }

  function badges(t, { compact = false } = {}) {
    const out = [];
    if (t.excluded) out.push(c.badge(EXCLUDED_LABEL[t.excluded] || 'Not counted', 'neutral'));
    if (t.planningExcluded) out.push(c.badge('Left out of planning baseline', 'info'));
    if (t.edited) out.push(c.badge('Corrected', 'good'));
    for (const f of t.flags || []) {
      if (!FLAG_BADGE[f]) continue;
      if (f === 'needs_category_review' && t.edited) continue;
      out.push(c.badge(FLAG_BADGE[f][0], FLAG_BADGE[f][1]));
    }
    return compact ? out.slice(0, 2).join(' ') : out.join(' ');
  }

  /** Sorted list of category names: taxonomy, plus any used in data, targets or edits. */
  function categoryOptions(ctx) {
    const set = new Set(E.categories.names());
    for (const t of ctx.txns) { if (t.category) set.add(t.category); for (const p of t.parts || []) set.add(p.category); }
    for (const k of Object.keys(ctx.state.plan.targets || {})) set.add(k);
    return E.categories.sortNames([...set]);
  }

  function categorySelectHtml(ctx, { id, value, name = 'category', label = 'Category' }) {
    return `<label for="${esc(id)}">${esc(label)}</label><select id="${esc(id)}" name="${esc(name)}">${categoryOptions(ctx).map(n => `<option value="${esc(n)}"${n === value ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  }

  const QUICK_REASONS = ['Checked the receipt', 'Known recurring bill', 'Bank category was wrong', 'Merchant sells this only'];

  /** Inline form to change a transaction's category with a required reason. */
  function categoryForm(ctx, t, { idPrefix = 'cat' } = {}) {
    const base = idPrefix + '-' + t.id;
    return `<form class="inline-form" data-action="ledger:set-category" data-txn="${esc(t.id)}" aria-label="Change category for ${esc(t.merchant)}">
      <div class="field">${categorySelectHtml(ctx, { id: base + '-sel', value: t.category })}</div>
      <div class="field"><label for="${esc(base)}-reason">Why? <span class="fine">(required, kept in the history)</span></label>
        <input id="${esc(base)}-reason" name="reason" list="${esc(base)}-reasons" maxlength="200" placeholder="e.g. Checked the receipt" required>
        <datalist id="${esc(base)}-reasons">${QUICK_REASONS.map(r => `<option value="${esc(r)}">`).join('')}</datalist></div>
      <div class="inline-form-actions"><button class="btn btn-primary btn-small" type="submit">Save category</button>
        <label class="check"><input type="checkbox" name="allSame"> Also apply to other uncorrected ${esc(t.merchant)} purchases</label></div>
    </form>`;
  }

  /**
   * Standard transaction table. rows: effective txns. hrefFor(t) links each row (detail view).
   * The footer sums counted spending so the table reconciles with the total it explains.
   */
  function txnTable(ctx, rows, { caption = 'Transactions', hrefFor, showAccount = true, showKind = false, footer = true, emptyText = 'No transactions match.' } = {}) {
    const counted = rows.reduce((a, t) => a + E.ledger.measure(t).spendCents, 0);
    const columns = [
      { key: 'date', label: 'Date', html: t => `<span class="nowrap">${esc(fmt.date(t.date))}</span>` },
      { key: 'merchant', label: 'Merchant', html: t => `${hrefFor ? `<a href="${esc(hrefFor(t))}">${esc(t.merchant)}</a>` : esc(t.merchant)}<small>${esc(t.description)}${showAccount ? ' · ' + esc(t.accountLabel || t.accountId) : ''}</small>` },
      { key: 'category', label: 'Category', html: t => `${esc(t.parts && t.parts.length > 1 ? 'Split: ' + t.parts.map(p => p.category).join(', ') : t.category)}<small>Bank: ${esc(t.sourceCategory || 'none')}${showKind ? ' · ' + esc(kindLabel(t)) : ''}</small>` },
      { key: 'status', label: 'Status', html: t => badges(t, { compact: true }) || '<span class="fine">Counted</span>' },
      { key: 'amount', label: 'Amount', align: 'right', html: t => `<span class="${t.kind === 'spend' && t.amountCents > 0 ? 'tone-good' : ''}">${esc(amountText(t))}</span>` },
    ];
    const foot = footer ? { date: `${rows.length} row${rows.length === 1 ? '' : 's'}`, amount: esc(fmt.money(counted)) + '<small>counted spending</small>' } : null;
    return c.table({ caption, columns, rows, footer: foot, emptyText, rowAttrs: t => ({ class: t.excluded ? 'is-excluded' : null }) });
  }

  // ------------------------------------------------------------------ ledger edits
  function editLedger(app, txnId, field, value, reason, { message } = {}) {
    return app.update(st => {
      const prev = st.ledgerEdits[txnId];
      const next = E.review.editRecord(prev, field, value, reason, new Date().toISOString());
      return { ...st, ledgerEdits: { ...st.ledgerEdits, [txnId]: next } };
    }, { message });
  }

  function editMany(app, changes, { message } = {}) {
    // changes: [{ txnId, field, value, reason }] applied as ONE undoable update
    return app.update(st => {
      const edits = { ...st.ledgerEdits };
      const at = new Date().toISOString();
      for (const ch of changes) edits[ch.txnId] = E.review.editRecord(edits[ch.txnId], ch.field, ch.value, ch.reason, at);
      return { ...st, ledgerEdits: edits };
    }, { message });
  }

  const actions = {
    /** Form submit: change category (optionally for every uncorrected row of the same merchant). */
    'ledger:set-category': (ctx, form) => {
      const data = new FormData(form);
      const category = String(data.get('category') || '').trim();
      const reason = String(data.get('reason') || '').trim();
      if (!reason) throw new E.ValidationError('Add a short reason so you both know why it changed.');
      const txn = ctx.txns.find(t => t.id === form.dataset.txn);
      if (!txn) throw new E.ValidationError('That transaction is no longer in the data.');
      const targets = data.get('allSame')
        ? ctx.txns.filter(t => t.merchant === txn.merchant && t.kind === 'spend' && (t.id === txn.id || !t.edited))
        : [txn];
      editMany(ctx.app, targets.filter(t => t.category !== category || t.id === txn.id).map(t => ({ txnId: t.id, field: 'category', value: category, reason })),
        { message: `Category set to ${category} for ${targets.length} transaction${targets.length === 1 ? '' : 's'}.` });
    },
    /**
     * Button: set one edit field. data-txn, data-field, data-value ('' = clear), data-reason (or
     * data-reason-from = id of an input holding the reason). Multiple txns: data-txns="a,b".
     */
    'ledger:set': (ctx, el) => {
      const ids = (el.dataset.txns || el.dataset.txn || '').split(',').filter(Boolean);
      const field = el.dataset.field;
      let value = el.dataset.value;
      if (value === '' || value === undefined) value = null;
      let reason = el.dataset.reason || '';
      if (el.dataset.reasonFrom) {
        const input = document.getElementById(el.dataset.reasonFrom);
        reason = (input && input.value.trim()) || reason;
      }
      if (!reason) throw new E.ValidationError('Add a short reason first.');
      editMany(ctx.app, ids.map(txnId => ({ txnId, field, value, reason })), { message: el.dataset.message || 'Saved.' });
    },
    /** Clear every correction on a transaction (history is kept). */
    'ledger:revert': (ctx, el) => {
      const id = el.dataset.txn;
      const edit = ctx.state.ledgerEdits[id];
      if (!edit) return;
      const fields = Object.keys(edit).filter(k => k !== 'history' && edit[k] !== undefined);
      editMany(ctx.app, fields.map(f => ({ txnId: id, field: f, value: null, reason: 'Reverted to the imported value' })), { message: 'Correction reverted.' });
    },
  };

  UI.shared = { kindLabel, amountText, badges, categoryOptions, categorySelectHtml, categoryForm, txnTable, editLedger, editMany, KIND_LABEL, SUBTYPE_LABEL, EXCLUDED_LABEL };
  UI.sharedActions = actions;
})(typeof globalThis !== 'undefined' ? globalThis : this);
