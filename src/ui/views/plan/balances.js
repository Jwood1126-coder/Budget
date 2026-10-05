'use strict';
/*
 * Plan (#/overview), 2. the balances strip: the known balance of each joint cash account (the
 * bank's figure when the data has one, with where it comes from; a different one can be entered),
 * else an amount and a date the household enters, and the combined total.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const P = UI._plan;
  const { isCents, exact, inputText, shortDate } = P;

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

  // ------------------------------------------------------------------ 2. balances
  function accountsOf(tl) {
    const b = tl.balances;
    const list = b.accounts.map(a => ({ id: a.id, name: a.name, group: a.group, anchor: a.anchor }))
      .concat(b.missing.map(m => ({ id: m.id, name: m.name, group: m.type === 'savings' ? 'savings' : 'checking', anchor: null })));
    const rank = a => (a.group === 'checking' ? 0 : 1);
    return list.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(x => x[0]);
  }

  /** Amount and date boxes for one balance (the household's own figure). */
  function balanceInputs({ id, name, cents, date, datePath, account, placeholder, amountLabel }) {
    return `${amountLabel ? `<label class="plan-bal-amtlabel" for="${esc(id)}">${esc(amountLabel)}</label>` : ''}
        <span class="input-money plan-amount"><span aria-hidden="true">$</span><input id="${esc(id)}" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(inputText(cents))}" data-action="plan:balance" data-commit="1" data-account="${esc(account)}" data-name="${esc(name)}" aria-describedby="${esc(id)}-src ${esc(id)}-error"></span>
        <label class="plan-bal-asof" for="${esc(id)}-date">as of</label>
        <input class="plan-date" id="${esc(id)}-date" type="date" value="${esc(date || '')}" data-bind="${esc(datePath)}" data-type="date" data-message="${esc(name + ': balance date saved.')}" aria-describedby="${esc(id)}-date-error">
        <p class="field-error plan-bal-err" id="${esc(id)}-error" role="alert" hidden></p>
        <p class="field-error plan-bal-derr" id="${esc(id)}-date-error" role="alert" hidden></p>`;
  }

  function balanceBox(a, { cents, date, fromData }) {
    const id = 'plan-bal-' + a.id;
    const anchor = a.anchor || fromData;
    const dataWord = fromData && fromData.source === 'statement' ? 'statement' : 'bank';
    const fields = opts => balanceInputs(Object.assign({ id, name: a.name, cents, date, datePath: 'plan.balances.accountDates.' + a.id, account: a.id }, opts));
    if (fromData && cents === null) {
      // The data knows this balance: show its figure; a different one can still be entered.
      return `<div class="plan-bal is-data" id="${esc(id)}-box">
          <span class="plan-bal-name" id="${esc(id)}-name">${esc(a.name)}</span>
          <strong class="plan-bal-figure" id="${esc(id)}-figure">${esc(exact(anchor.cents))}</strong>
          <p class="plan-bal-src fine" id="${esc(id)}-src">${esc(anchor.label)}</p>
          <details class="plan-bal-edit" id="${esc(id)}-edit"><summary>Enter a different balance</summary>
            <div class="plan-bal-editbody">${fields({ placeholder: '', amountLabel: 'Balance' })}</div>
          </details>
        </div>`;
    }
    let source = '';
    if (cents !== null && anchor) {
      source = anchor.source === 'entered' ? anchor.label
        : `${anchor.label}: newer than the balance you entered, so the chart uses it`;
    }
    const useData = cents !== null && fromData
      ? c.button(`Use the ${dataWord} figure`, { action: 'plan:balance-use-data', data: { account: a.id, name: a.name }, cls: 'btn-small btn-ghost plan-bal-usedata', id: id + '-use-data', ariaLabel: `${a.name}: use the ${dataWord} figure (${exact(fromData.cents)} on ${fmt.date(fromData.date)})` })
      : '';
    return `<div class="plan-bal" id="${esc(id)}-box">
        <label class="plan-bal-name" for="${esc(id)}">${esc(a.name)}</label>
        ${fields({ placeholder: 'Not entered' })}
        <p class="plan-bal-src fine" id="${esc(id)}-src">${esc(source)}${useData}</p>
      </div>`;
  }

  function balancesCard(ctx, tl) {
    const b = tl.balances;
    const bal = ctx.state.plan.balances || {};
    const entered = bal.accounts || {}, dates = bal.accountDates || {};
    const data = dataAnchorsOf(ctx);
    const accounts = accountsOf(tl);
    let fields;
    if (accounts.length) {
      fields = accounts.map(a => {
        const cents = isCents(entered[a.id]) ? entered[a.id] : null;
        const date = dates[a.id] || (cents !== null ? bal.accountsAsOf : null) || '';
        return balanceBox(a, { cents, date, fromData: data.get(a.id) || null });
      }).join('');
    } else {
      const id = 'plan-bal-cash';
      fields = `<div class="plan-bal" id="${id}-box"><label class="plan-bal-name" for="${id}">Cash today</label>
          ${balanceInputs({ id, name: 'Cash today', cents: isCents(bal.jointCashCents) ? bal.jointCashCents : null, date: bal.asOf || '', datePath: 'plan.balances.asOf', account: '', placeholder: 'Not entered' })}
          <p class="plan-bal-src fine" id="${id}-src"></p></div>`;
    }
    let total = '';
    const anchored = b.accounts.filter(a => a.anchor);
    if (b.mode === 'accounts' && anchored.length) {
      const sum = anchored.reduce((s, a) => s + a.anchor.cents, 0);
      const ds = anchored.map(a => a.anchor.date).sort();
      const when = ds[0] === ds[ds.length - 1] ? 'as of ' + fmt.date(ds[0]) : 'balances from ' + shortDate(ds[0]) + ' to ' + fmt.date(ds[ds.length - 1]);
      total = `<p class="plan-bal-total" id="plan-bal-total">Combined <strong>${esc(exact(sum))}</strong> ${esc(when)}</p>`;
    } else if (b.mode === 'simple' && b.combined && b.combined.anchor) {
      total = `<p class="plan-bal-total" id="plan-bal-total">Cash <strong>${esc(exact(b.combined.anchor.cents))}</strong> as of ${esc(fmt.date(b.combined.anchor.date))}</p>`;
    }
    const notes = b.notes.length ? `<p class="fine plan-bal-notes" id="plan-bal-notes">${esc(b.notes.join(' '))}</p>` : '';
    return `<section class="card plan-balances" id="plan-balances" aria-labelledby="plan-balances-h">
        <h2 class="plan-h" id="plan-balances-h">Balances</h2>
        <div class="plan-bal-list">${fields}${total}</div>${notes}
      </section>`;
  }

  Object.assign(P, { balancesCard, dataAnchorsOf });
})(typeof globalThis !== 'undefined' ? globalThis : this);
