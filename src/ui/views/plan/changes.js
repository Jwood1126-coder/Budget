'use strict';
/*
 * Plan (#/overview), 4. planned changes: dated one-time or monthly changes on top of the dials,
 * applied once accepted and given an amount, an "Add a change" form and the Baby template.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const P = UI._plan;
  const { amt, plural, inputText, badgeWithId } = P;

  const KIND_LABEL = { oneTime: 'One-time', monthly: 'Monthly' };
  const CHANGE_GROUP_LABEL = { income: 'Income', essentials: 'Essentials', flexible: 'Flexible', irregular: 'Irregular', savings: 'Savings' };
  /** Groups only the changes worked out from Budget use (read-only rows). */
  const DERIVED_GROUP_LABEL = { debt: 'Debt & business' };
  const STATUS_BADGE = { applied: ['Applied', 'good'], notAccepted: ['Not accepted', 'neutral'], unset: ['Amount not set', 'warn'], outside: ['Outside horizon', 'neutral'] };

  // ------------------------------------------------------------------ 4. planned changes
  /** Cost of a change to checking: spending and savings count up, income counts down. */
  const costOf = ch => (ch.group === 'income' ? 0 - ch.cents : ch.cents);

  /** The household's own changes (plan.changes): the summary counts these; what Budget adds is listed apart. */
  function changesSummary(tl) {
    const ch = tl.changes;
    const own = ch.list.filter(x => !x.readOnly);
    if (!own.length) return 'Planned changes';
    const parts = ['Planned changes', `${ch.applied} of ${own.length} applied`];
    if (ch.unset.length) parts.push(`${ch.unset.length} without an amount`);
    if (ch.totalOneTimeCents) parts.push('one-time ' + amt(ch.totalOneTimeCents));
    // Monthly changes: what they add a month in the first plan month they apply.
    const byId = new Map(own.map(x => [x.id, x]));
    const first = tl.months.find(m => m.month >= tl.planStart && m.changesApplied.some(a => (byId.get(a.id) || {}).kind === 'monthly'));
    if (first) {
      const cents = first.changesApplied.filter(a => (byId.get(a.id) || {}).kind === 'monthly').reduce((s, a) => s + costOf(byId.get(a.id)), 0);
      if (cents) parts.push(`${cents > 0 ? '+' : ''}${amt(cents)}/mo from ${fmt.month(first.month)}`);
    }
    return parts.join(' · ');
  }

  const optionList = (list, value) => list.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('');
  /** The note a template wrote, without the sentence every estimate shares. */
  const noteOf = ch => String(ch.note || '').replace(/\s*A generic estimate: adjust it to your own quotes and plans\.\s*$/, '').trim();

  /** A change worked out from Budget (a bill or a savings goal): shown, edited in Budget. */
  function derivedRow(ch) {
    const id = 'plan-ch-' + ch.id;
    const [statusText, tone] = STATUS_BADGE[ch.status] || ['', 'neutral'];
    const when = ch.kind === 'monthly' ? 'from ' + fmt.month(ch.startMonth) + (ch.endMonth ? ' until ' + fmt.month(ch.endMonth) : '') : 'in ' + fmt.month(ch.startMonth);
    const group = CHANGE_GROUP_LABEL[ch.group] || DERIVED_GROUP_LABEL[ch.group] || ch.group;
    return `<li class="plan-ch-item is-${esc(ch.status)} is-derived" data-change="${esc(ch.id)}">
        <div class="plan-ch-main">
          <span class="plan-ch-label">${esc(ch.label)}</span>
          <span class="plan-ch-amt">${esc(amt(ch.cents))}${ch.kind === 'monthly' ? '/mo' : ''}</span>
          <span class="plan-ch-status">${badgeWithId(id + '-status', statusText, tone)} ${c.badge(ch.source === 'goal' ? 'savings goal' : 'bill', 'info')}</span>
        </div>
        <p class="plan-ch-when fine">${esc(KIND_LABEL[ch.kind] + ' · ' + group + ' · ' + when)}</p>
        ${ch.note ? `<p class="plan-ch-note fine">${esc(ch.note)}</p>` : ''}
      </li>`;
  }

  function changeRow(tl, ch) {
    if (ch.readOnly) return derivedRow(ch);
    const id = 'plan-ch-' + ch.id;
    const path = 'plan.changes[id=' + ch.id + ']';
    const name = ch.label;
    const [statusText, tone] = STATUS_BADGE[ch.status] || ['', 'neutral'];
    const tip = ch.status === 'applied' ? (ch.kind === 'monthly' ? `Applied in ${plural(ch.monthsApplied, 'plan month')}` : 'Applied in ' + fmt.month(ch.startMonth)) : '';
    const person = ch.group === 'income'
      ? `<label class="sr-only" for="${esc(id)}-person">${esc(name)}: whose income</label><select id="${esc(id)}-person" data-action="plan:change-field" data-field="personId" data-change="${esc(ch.id)}" data-name="${esc(name)}">${optionList([['', 'Other money in'], ...tl.people.map(p => [p.id, p.name])], ch.personId || '')}</select>`
      : '';
    const until = ch.kind === 'monthly'
      ? `<label class="plan-ch-word" for="${esc(id)}-end">until</label><input type="month" id="${esc(id)}-end" value="${esc(ch.endMonth || '')}" data-bind="${esc(path + '.endMonth')}" data-type="month" data-message="${esc(name + ': end month saved.')}" aria-describedby="${esc(id)}-end-error" title="Leave empty: no end">`
      : '';
    const unset = ch.cents === null
      ? `<p class="plan-ch-unset" id="${esc(id)}-unset">amount not set — ${ch.group === 'income' ? 'enter the monthly reduction' : 'enter the amount'}</p>`
      : '';
    const note = noteOf(ch);
    return `<li class="plan-ch-item is-${esc(ch.status)}" data-change="${esc(ch.id)}">
        <div class="plan-ch-main">
          <label class="plan-ch-accept" for="${esc(id)}-on" title="Accepted: applied to the plan once it has an amount"><input type="checkbox" class="plan-ch-on" id="${esc(id)}-on" data-action="plan:change-accept" data-change="${esc(ch.id)}" data-name="${esc(name)}"${ch.accepted ? ' checked' : ''} aria-label="${esc('Accepted: ' + name)}"></label>
          <span class="plan-ch-label"><input type="text" id="${esc(id)}-label" value="${esc(name)}" maxlength="80" autocomplete="off" data-action="plan:change-label" data-commit="1" data-change="${esc(ch.id)}" aria-label="${esc('Name of the change: ' + name)}" aria-describedby="${esc(id)}-label-error"></span>
          <span class="input-money plan-ch-amt"><span aria-hidden="true">$</span><input type="text" id="${esc(id)}-amt" inputmode="text" autocomplete="off" spellcheck="false" placeholder="Not set" value="${esc(inputText(ch.cents))}" data-action="plan:change-cents" data-commit="1" data-change="${esc(ch.id)}" data-name="${esc(name)}" aria-label="${esc(name + ': amount' + (ch.kind === 'monthly' ? ' a month' : '') + ', dollars')}" aria-describedby="${esc(id)}-amt-error${ch.cents === null ? ' ' + id + '-unset' : ''}"></span>
          <span class="plan-ch-status">${badgeWithId(id + '-status', statusText, tone, { title: tip })}</span>
          <button type="button" class="btn btn-ghost btn-small plan-ch-remove" id="${esc(id)}-remove" data-action="plan:change-remove" data-change="${esc(ch.id)}" data-name="${esc(name)}" aria-label="${esc('Remove ' + name)}">✕</button>
        </div>
        <div class="plan-ch-when">
          <label class="sr-only" for="${esc(id)}-kind">${esc(name)}: one-time or monthly</label><select id="${esc(id)}-kind" data-action="plan:change-field" data-field="kind" data-change="${esc(ch.id)}" data-name="${esc(name)}">${optionList(Object.entries(KIND_LABEL), ch.kind)}</select>
          <label class="sr-only" for="${esc(id)}-group">${esc(name)}: group</label><select id="${esc(id)}-group" data-action="plan:change-field" data-field="group" data-change="${esc(ch.id)}" data-name="${esc(name)}">${optionList(Object.entries(CHANGE_GROUP_LABEL), ch.group)}</select>
          ${person}
          <label class="plan-ch-word" for="${esc(id)}-start">${ch.kind === 'monthly' ? 'from' : 'in'}</label><input type="month" id="${esc(id)}-start" value="${esc(ch.startMonth)}" required data-bind="${esc(path + '.startMonth')}" data-type="month" data-message="${esc(name + ': start month saved.')}" aria-describedby="${esc(id)}-start-error">
          ${until}
        </div>
        ${unset}${note ? `<p class="plan-ch-note fine">${esc(note)}</p>` : ''}
        <p class="field-error" id="${esc(id)}-label-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-amt-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-start-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-end-error" role="alert" hidden></p>
      </li>`;
  }

  function changesHtml(ctx, tl) {
    const list = tl.changes.list.filter(ch => !ch.readOnly);
    const fromBudget = tl.changes.list.filter(ch => ch.readOnly);
    const waiting = list.filter(ch => !ch.accepted).length;
    const accepted = list.length - waiting;
    const bulk = list.length ? `<p class="plan-ch-bulk">${waiting ? c.button(`Accept all ${waiting}`, { action: 'plan:change-accept-all', id: 'plan-ch-accept-all', cls: 'btn-small' }) : ''}${accepted ? c.button('Unaccept all', { action: 'plan:change-unaccept-all', id: 'plan-ch-unaccept-all', cls: 'btn-small btn-ghost' }) : ''}</p>` : '';
    const table = (list.length
      ? `<ul class="plan-ch-list" id="plan-ch-list" aria-label="Planned changes">${list.map(ch => changeRow(tl, ch)).join('')}</ul>${bulk}`
      : '<p class="fine plan-ch-empty">No planned changes yet.</p>')
      + (fromBudget.length ? `<p class="drill-h">From Budget (bills and savings goals; change them in Budget)</p><ul class="plan-ch-list" id="plan-ch-budget" aria-label="Changes from Budget">${fromBudget.map(ch => changeRow(tl, ch)).join('')}</ul>` : '');
    const add = `<form class="plan-ch-add" id="plan-ch-add" data-action="plan:add-change" novalidate>
        <p class="drill-h">Add a change</p>
        <div class="plan-ch-addrow">
          <label class="plan-ch-field"><span>What</span><input type="text" name="label" id="plan-ch-new-label" maxlength="80" autocomplete="off" placeholder="e.g. Car repair"></label>
          <label class="plan-ch-field"><span>Kind</span><select name="kind" id="plan-ch-new-kind">${optionList(Object.entries(KIND_LABEL), 'oneTime')}</select></label>
          <label class="plan-ch-field"><span>Group</span><select name="group" id="plan-ch-new-group">${optionList(Object.entries(CHANGE_GROUP_LABEL), 'irregular')}</select></label>
          <label class="plan-ch-field"><span>From</span><input type="month" name="start" id="plan-ch-new-start" value="${esc(tl.planStart)}"></label>
          <label class="plan-ch-field"><span>Amount</span><span class="input-money"><span aria-hidden="true">$</span><input type="text" name="amount" id="plan-ch-new-amt" inputmode="text" autocomplete="off" placeholder="Not set"></span></label>
          <button type="submit" class="btn btn-secondary btn-small" id="plan-ch-new-add">Add</button>
        </div>
        <p class="field-error" id="plan-ch-new-error" role="alert" hidden></p>
      </form>`;
    const templates = [E.timeline.templates.baby].filter(Boolean).map(() => `<div class="plan-ch-template" id="plan-tpl-baby-box">
        <p class="drill-h">Templates</p>
        <div class="plan-ch-addrow">
          <label class="plan-ch-field"><span>Baby: due date</span><input type="date" id="plan-tpl-baby-date" aria-describedby="plan-tpl-baby-help plan-tpl-baby-date-error"></label>
          <button type="button" class="btn btn-secondary btn-small" id="plan-tpl-baby" data-action="plan:template-baby">Add the Baby template</button>
        </div>
        <p class="field-error" id="plan-tpl-baby-date-error" role="alert" hidden></p>
        <p class="fine" id="plan-tpl-baby-help">Generic estimates timed from the due month (gear, delivery, diapers, childcare, parental leave). They are listed, not applied: review the amounts, then accept them.</p>
      </div>`).join('');
    const body = `<p class="fine">Dated changes on top of the dials: a one-time cost in one month, or a monthly change from a start month (until an end month, when set). Only accepted changes with an amount reach the plan; the chart marks them on its bottom edge. A drop in income is a negative amount. In the summary, one-time and monthly totals count money going out.</p>
      ${table}${add}${templates}`;
    return c.disclosure(esc(changesSummary(tl)), body, { id: 'plan-changes', cls: 'plan-changes' });
  }

  Object.assign(P, { KIND_LABEL, CHANGE_GROUP_LABEL, changesHtml });
})(typeof globalThis !== 'undefined' ? globalThis : this);
