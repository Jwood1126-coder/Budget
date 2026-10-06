'use strict';
/*
 * Overview (#/overview): where the money is. Checking and savings separately (checking first,
 * even when the combined total looks fine), each with the date its balance is from and where it
 * comes from ("as of Sep 30, 2026 · from your statement": an older figure is never called today),
 * then the combined total. The balance editors are folded under it: a figure the household enters
 * overrides the data's own (the bank's running balance or a statement) until "Use the bank
 * figure"; without any known balance the editors start open.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const P = UI._plan;
  const { isCents, exact, inputText, shortDate } = P;

  const SOURCE = { statement: 'from your statement', bank: 'from your bank data', entered: 'entered by you' };
  const KIND = { checking: 'Checking', savings: 'Savings' };

  /** The balances the data itself knows (bank running balance or a statement), whatever was entered. */
  function dataAnchorsOf(ctx) {
    return ctx.memo('plan-data-anchors', () => {
      const out = new Map();
      try {
        const anc = E.timeline.anchors({ balances: {} }, ctx.dataset, ctx.realTxns || ctx.txns);
        for (const a of anc.accounts) if (a.anchor && a.anchor.source !== 'entered') out.set(a.id, a.anchor);
      } catch (err) { console.warn('Balances from the data could not be read:', err.message); }
      return out;
    });
  }

  /** Every joint cash account, checking first: { id, name, group, anchor (null when unknown) }. */
  function accountsOf(tl) {
    const b = tl.balances;
    const list = b.accounts.map(a => ({ id: a.id, name: a.name, group: a.group, anchor: a.anchor }))
      .concat(b.missing.map(m => ({ id: m.id, name: m.name, group: m.type === 'savings' ? 'savings' : 'checking', anchor: null })));
    const rank = a => (a.group === 'checking' ? 0 : 1);
    return list.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(x => x[0]);
  }

  /** "as of Sep 30, 2026 · from your statement" */
  const asOfText = anchor => 'as of ' + fmt.date(anchor.date) + ' · ' + (SOURCE[anchor.source] || String(anchor.label || ''));

  /** One account's figure: its kind, name, balance and where the balance comes from. */
  function figureRow(a) {
    const id = 'plan-bal-' + a.id;
    const known = a.anchor && isCents(a.anchor.cents);
    return `<div class="ov-bal is-${esc(a.group)}${known ? '' : ' is-unknown'}" id="${esc(id)}-row">
        <span class="ov-bal-kind">${esc(KIND[a.group] || 'Cash')}</span>
        <span class="ov-bal-name" id="${esc(id)}-name">${esc(a.name)}</span>
        <strong class="ov-bal-figure num${known && a.anchor.cents < 0 ? ' tone-bad' : ''}" id="${esc(id)}-figure">${esc(known ? exact(a.anchor.cents) : 'Not known')}</strong>
        <span class="ov-bal-asof" id="${esc(id)}-asof">${esc(known ? asOfText(a.anchor) : 'Enter its balance below')}</span>
      </div>`;
  }

  /** Amount and date boxes for one balance (the household's own figure). */
  function balanceInputs({ id, name, cents, date, datePath, account, placeholder }) {
    return `<span class="input-money plan-amount"><span aria-hidden="true">$</span><input id="${esc(id)}" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(inputText(cents))}" data-action="plan:balance" data-commit="1" data-account="${esc(account)}" data-name="${esc(name)}" aria-describedby="${esc(id)}-src ${esc(id)}-error"></span>
        <label class="plan-bal-asof" for="${esc(id)}-date">as of</label>
        <input class="plan-date" id="${esc(id)}-date" type="date" value="${esc(date || '')}" data-bind="${esc(datePath)}" data-type="date" data-message="${esc(name + ': balance date saved.')}" aria-describedby="${esc(id)}-date-error">
        <p class="field-error plan-bal-err" id="${esc(id)}-error" role="alert" hidden></p>
        <p class="field-error plan-bal-derr" id="${esc(id)}-date-error" role="alert" hidden></p>`;
  }

  /** The editor for one account: its own figure overrides the data's; "Use the bank figure" takes it back. */
  function editorBox(a, { cents, date, fromData }) {
    const id = 'plan-bal-' + a.id;
    const dataWord = fromData && fromData.source === 'statement' ? 'statement' : 'bank';
    let source = '';
    if (cents === null && fromData) source = `Empty: the ${dataWord} figure, ${exact(fromData.cents)} on ${shortDate(fromData.date)}`;
    else if (cents !== null && a.anchor && a.anchor.source !== 'entered') source = `The ${dataWord} figure is newer, so the chart uses it`;
    const useData = cents !== null && fromData
      ? c.button(`Use the ${dataWord} figure`, { action: 'plan:balance-use-data', data: { account: a.id, name: a.name }, cls: 'btn-small btn-ghost plan-bal-usedata', id: id + '-use-data', ariaLabel: `${a.name}: use the ${dataWord} figure (${exact(fromData.cents)} on ${fmt.date(fromData.date)})` })
      : '';
    return `<div class="plan-bal" id="${esc(id)}-box">
        <label class="plan-bal-name" for="${esc(id)}">${esc(a.name)}</label>
        ${balanceInputs({ id, name: a.name, cents, date, datePath: 'plan.balances.accountDates.' + a.id, account: a.id, placeholder: fromData ? inputText(fromData.cents) : 'Not entered' })}
        <p class="plan-bal-src fine" id="${esc(id)}-src">${esc(source)}${useData}</p>
      </div>`;
  }

  /** The combined total and the date (or dates) it is from, or ''. */
  function totalHtml(tl) {
    const b = tl.balances;
    const anchored = b.accounts.filter(a => a.anchor && isCents(a.anchor.cents));
    if (b.mode === 'accounts' && anchored.length) {
      const sum = anchored.reduce((s, a) => s + a.anchor.cents, 0);
      const ds = anchored.map(a => a.anchor.date).sort();
      const when = ds[0] === ds[ds.length - 1] ? 'as of ' + fmt.date(ds[0]) : 'balances from ' + shortDate(ds[0]) + ' to ' + fmt.date(ds[ds.length - 1]);
      const part = anchored.length < accountsOf(tl).length ? ' (the accounts with a known balance)' : '';
      return `<div class="ov-bal is-total" id="plan-bal-total"><span class="ov-bal-kind">Combined</span> <strong class="ov-bal-figure num${sum < 0 ? ' tone-bad' : ''}">${esc(exact(sum))}</strong> <span class="ov-bal-asof">${esc(when + part)}</span></div>`;
    }
    if (b.mode === 'simple' && b.combined && b.combined.anchor) {
      return `<div class="ov-bal is-total" id="plan-bal-total"><span class="ov-bal-kind">Cash</span> <strong class="ov-bal-figure num">${esc(exact(b.combined.anchor.cents))}</strong> <span class="ov-bal-asof">${esc('as of ' + fmt.date(b.combined.anchor.date) + ' · entered by you')}</span></div>`;
    }
    return '';
  }

  function balancesCard(ctx, tl) {
    const b = tl.balances;
    const bal = ctx.state.plan.balances || {};
    const entered = bal.accounts || {}, dates = bal.accountDates || {};
    const data = dataAnchorsOf(ctx);
    const accounts = accountsOf(tl);
    let figures, editors;
    if (accounts.length) {
      figures = accounts.map(figureRow).join('');
      editors = accounts.map(a => {
        const cents = isCents(entered[a.id]) ? entered[a.id] : null;
        const date = dates[a.id] || (cents !== null ? bal.accountsAsOf : null) || '';
        return editorBox(a, { cents, date, fromData: data.get(a.id) || null });
      }).join('');
    } else {
      // No cash account in the data: one figure the household enters drives the line.
      const id = 'plan-bal-cash';
      figures = '';
      editors = `<div class="plan-bal" id="${id}-box"><label class="plan-bal-name" for="${id}">Cash</label>
          ${balanceInputs({ id, name: 'Cash', cents: isCents(bal.jointCashCents) ? bal.jointCashCents : null, date: bal.asOf || '', datePath: 'plan.balances.asOf', account: '', placeholder: 'Not entered' })}
          <p class="plan-bal-src fine" id="${id}-src"></p></div>`;
    }
    const none = b.mode === 'none';
    const notes = b.notes.length ? `<p class="fine plan-bal-notes" id="plan-bal-notes">${esc(b.notes.join(' '))}</p>` : '';
    return `<section class="card ov-balances" id="plan-balances" aria-labelledby="plan-balances-h">
        <h2 class="ov-h" id="plan-balances-h">Balances</h2>
        <div class="ov-bal-list">${figures}${totalHtml(tl)}</div>
        <details class="ov-bal-edit" id="plan-bal-edit"${none ? ' open' : ''}><summary>${none ? 'Enter your balances' : 'Change a balance'}</summary>
          <div class="plan-bal-list">${editors}</div>${notes}
        </details>
      </section>`;
  }

  Object.assign(P, { balancesCard, dataAnchorsOf, accountsOf });
})(typeof globalThis !== 'undefined' ? globalThis : this);
