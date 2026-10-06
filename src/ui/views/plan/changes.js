'use strict';
/*
 * Planned changes, in two places:
 *   Edit plan (#/budget)   the list to edit them, by month: accept, name, amount, status and remove
 *                          on one line; when and how (one-time or monthly, group, whose income,
 *                          start, end) folded under its date. A group's changes (a what-if copied
 *                          from a saved scenario, the baby costs, a pack added earlier) are one
 *                          folded row (name, how many, once + a month, one box to accept or
 *                          unaccept them all) that opens into those lines. What Edit plan's pay,
 *                          bills and goals add is read-only here, edited in their own section.
 *                          "+ Custom change" adds one of the household's own.
 *                          Under the baby-cost defaults' group (E.babyDefaults): one caveat line
 *                          (what is not included yet) and any cost planned twice; childcare's
 *                          yearly fee is a line under its row.
 *   Overview (#/overview)  "Coming up": the next few, short (a group as one line), nothing to edit.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const P = UI._plan;
  const { amt, plural, inputText, badgeWithId, isCents, packOf, SCENARIO_CLS, groupKeyOf, groupIdOf, compact, whole } = P;

  const KIND_LABEL = { oneTime: 'One-time', monthly: 'Monthly' };
  const CHANGE_GROUP_LABEL = { income: 'Income', essentials: 'Essentials', flexible: 'Flexible', irregular: 'Irregular', savings: 'Savings' };
  /** Groups only the changes worked out from Budget use (read-only rows). */
  const DERIVED_GROUP_LABEL = { debt: 'Debt & business' };
  const STATUS_BADGE = { applied: ['In plan', 'good'], notAccepted: ['Not accepted', 'neutral'], unset: ['Amount not set', 'warn'], outside: ['Outside horizon', 'neutral'], overridden: ['Savings set by you', 'neutral'], overlap: ['Not counted: covered elsewhere', 'warn'] };

  // ------------------------------------------------------------------ amounts and words
  /** Cost of a change to checking: spending and savings count up, income counts down. */
  const costOf = ch => (ch.group === 'income' ? 0 - ch.cents : ch.cents);
  const whenText = ch => (ch.kind === 'monthly' ? (ch.endMonth ? fmt.month(ch.startMonth) + '–' + fmt.month(ch.endMonth) : 'from ' + fmt.month(ch.startMonth)) : fmt.month(ch.startMonth));
  const groupText = ch => CHANGE_GROUP_LABEL[ch.group] || DERIVED_GROUP_LABEL[ch.group] || ch.group;
  /** The colour of a change: its pack's, Budget's quiet one, a goal's green, else the household's own blue. */
  const clsOf = ch => (packOf(ch) ? packOf(ch).cls : ch.scenario && !ch.readOnly ? SCENARIO_CLS : ch.source === 'bill' ? 'series-muted' : ch.source === 'goal' ? 'series-3' : ch.source === 'income' ? 'series-2' : 'series-1');
  /** A group's totals in a few words: "$4.8k once + $320/mo" (spending and savings; income changes are their own story). */
  function totalsText(list) {
    const spend = list.filter(ch => ch.group !== 'income' && isCents(ch.cents));
    const once = spend.filter(ch => ch.kind === 'oneTime').reduce((s, ch) => s + ch.cents, 0);
    const monthly = spend.filter(ch => ch.kind === 'monthly').reduce((s, ch) => s + ch.cents, 0);
    return [once ? compact(once) + ' once' : '', monthly ? compact(monthly) + '/mo' : ''].filter(Boolean).join(' + ');
  }
  const optionList = (list, value) => list.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('');
  /** The note a template wrote, without the sentence every estimate shares. */
  const noteOf = ch => String(ch.note || '').replace(/\s*A generic estimate: adjust it to your own quotes and plans\.\s*$/, '').trim();


  // ------------------------------------------------------------------ the list
  /** A change worked out from pay, bills or goals (one that starts or ends): shown, edited in its own section. */
  function derivedRow(ctx, ch) {
    const id = 'plan-ch-' + ch.id;
    const [statusText, tone] = STATUS_BADGE[ch.status] || ['', 'neutral'];
    const href = ctx.href('budget', { section: ch.source === 'goal' ? 'savings' : ch.source === 'income' ? 'income' : 'bills' });
    const what = ch.source === 'goal' ? 'Goal' : ch.source === 'income' ? 'Pay' : 'Bill';
    return `<li class="plan-ch-item is-${esc(ch.status)} is-derived" data-change="${esc(ch.id)}">
        <div class="plan-ch-main">
          <span class="plan-ch-swatch key key-swatch ${esc(clsOf(ch))}" aria-hidden="true"></span>
          <span class="plan-ch-accept plan-ch-noaccept" aria-hidden="true"></span>
          <span class="plan-ch-label plan-ch-text" title="${esc(ch.note || '')}">${esc(ch.label)}</span>
          <a class="plan-ch-budget" id="${esc(id)}-budget" href="${esc(href)}" title="${esc(ch.note || '')}">${esc(what)}<span class="sr-only">: edit ${esc(ch.label)} under ${esc(what === 'Goal' ? 'savings goals' : what === 'Pay' ? 'pay and income' : 'bills')}</span> →</a>
          <span class="plan-ch-when-text">${esc(whenText(ch))}</span>
          <span class="plan-ch-amt plan-ch-figure">${esc(amt(ch.cents))}${ch.kind === 'monthly' ? '/mo' : ''}</span>
          <span class="plan-ch-status">${badgeWithId(id + '-status', statusText, tone)}</span>
          <span class="plan-ch-noremove" aria-hidden="true"></span>
        </div>
      </li>`;
  }

  function changeRow(ctx, tl, ch) {
    if (ch.readOnly) return derivedRow(ctx, ch);
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
    const pack = packOf(ch);
    return `<li class="plan-ch-item is-${esc(ch.status)}" data-change="${esc(ch.id)}">
        <div class="plan-ch-main">
          <span class="plan-ch-swatch key key-swatch ${esc(clsOf(ch))}" aria-hidden="true" title="${esc(pack ? pack.name : 'Your own change')}"></span>
          <label class="plan-ch-accept" for="${esc(id)}-on" title="In the plan once it has an amount"><input type="checkbox" class="plan-ch-on" id="${esc(id)}-on" data-action="plan:change-accept" data-change="${esc(ch.id)}" data-name="${esc(name)}"${ch.accepted ? ' checked' : ''} aria-label="${esc('Accepted: ' + name)}"></label>
          <span class="plan-ch-label"><input type="text" id="${esc(id)}-label" value="${esc(name)}" maxlength="80" autocomplete="off" data-action="plan:change-label" data-commit="1" data-change="${esc(ch.id)}" aria-label="${esc('Name of the change: ' + name)}" aria-describedby="${esc(id)}-label-error"></span>
          <details class="plan-ch-edit" id="${esc(id)}-edit"><summary title="${esc(KIND_LABEL[ch.kind] + " · " + groupText(ch) + ": change when and how it counts")}">${esc(whenText(ch))}<span class="sr-only">: change when ${esc(name)} happens</span></summary>
            <div class="plan-ch-when">
              <label class="sr-only" for="${esc(id)}-kind">${esc(name)}: one-time or monthly</label><select id="${esc(id)}-kind" data-action="plan:change-field" data-field="kind" data-change="${esc(ch.id)}" data-name="${esc(name)}">${optionList(Object.entries(KIND_LABEL), ch.kind)}</select>
              <label class="sr-only" for="${esc(id)}-group">${esc(name)}: group</label><select id="${esc(id)}-group" data-action="plan:change-field" data-field="group" data-change="${esc(ch.id)}" data-name="${esc(name)}">${optionList(Object.entries(CHANGE_GROUP_LABEL), ch.group)}</select>
              ${person}
              <label class="plan-ch-word" for="${esc(id)}-start">${ch.kind === 'monthly' ? 'from' : 'in'}</label><input type="month" id="${esc(id)}-start" value="${esc(ch.startMonth)}" required data-bind="${esc(path + '.startMonth')}" data-type="month" data-message="${esc(name + ': start month saved.')}" aria-describedby="${esc(id)}-start-error">
              ${until}
            </div>
            ${note ? `<p class="plan-ch-note fine">${esc(note)}</p>` : ''}
          </details>
          <span class="input-money plan-ch-amt"><span aria-hidden="true">$</span><input type="text" id="${esc(id)}-amt" inputmode="text" autocomplete="off" spellcheck="false" placeholder="Not set" value="${esc(inputText(ch.cents))}" data-action="plan:change-cents" data-commit="1" data-change="${esc(ch.id)}" data-name="${esc(name)}" aria-label="${esc(name + ': amount' + (ch.kind === 'monthly' ? ' a month' : '') + ', dollars')}" aria-describedby="${esc(id)}-amt-error${ch.cents === null ? ' ' + id + '-unset' : ''}"></span>
          <span class="plan-ch-status">${badgeWithId(id + '-status', statusText, tone, { title: tip })}</span>
          <button type="button" class="btn btn-ghost btn-small plan-ch-remove" id="${esc(id)}-remove" data-action="plan:change-remove" data-change="${esc(ch.id)}" data-name="${esc(name)}" aria-label="${esc('Remove ' + name)}">✕</button>
        </div>
        ${unset}
        ${ch.yearlyCents && isCents(ch.cents) && ch.cents > 0 ? `<p class="plan-ch-yearly" id="${esc(id)}-yearly">plus ${esc(amt(ch.yearlyCents))} a year (membership fee) in ${esc(fmt.month(ch.startMonth))} and every 12 months after</p>` : ''}
        <p class="field-error" id="${esc(id)}-label-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-amt-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-start-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-end-error" role="alert" hidden></p>
      </li>`;
  }

  /**
   * Under the baby-cost defaults' group (E.babyDefaults): the one caveat line (what is not included
   * yet), the month-level timing when there is no due date, and costs planned twice (held back).
   */
  function babyLines(ctx, tl, name) {
    const st = E.babyDefaults.status(ctx.state);
    if (!st.items.length || st.group !== name) return '';
    const month = st.timing === 'month' ? ` Timed from the birth month (${esc(fmt.month(st.birthMonth))}), to the month only: add the due date under Pay, bills and debts below.` : '';
    const PACK_NAME = { babyFirstYear: 'the New baby pack', childcare: 'the Childcare pack', kidCosts: 'the Kid costs pack' };
    const byId = new Map(tl.changes.list.map(ch => [ch.id, ch]));
    // Held back only in the months the covering items run: say which (a monthly default counts again after them).
    const twice = (tl.changes.overlaps || []).map(o => {
      const def = byId.get(o.id);
      const mine = o.with.length === 1 && byId.get(o.with[0]);
      const who = o.kind === 'pack' ? esc(PACK_NAME[o.template] || 'a pack') : mine ? `“${esc(mine.label)}”` : 'another accepted item';
      // Replaced by an item for the whole allowance, or lowered by what the covering items pay for (o.cents).
      const part = !o.whole && isCents(o.cents);
      if (!def || def.kind === 'oneTime') {
        return part ? `“${esc(o.label)}” counts ${esc(whole(Math.max(0, (def ? def.cents : 0) - o.cents)))}: ${who} pays ${esc(whole(o.cents))} of it.` : `“${esc(o.label)}” is not counted: ${who} covers it.`;
      }
      const from = o.from && o.from > def.startMonth ? o.from : null;
      const when = from && o.until ? ` (${fmt.month(from)} to ${fmt.month(o.until)})` : from ? ` (from ${fmt.month(from)})` : o.until ? ` (until ${fmt.month(o.until)})` : '';
      return part ? `“${esc(o.label)}” is lowered by ${esc(whole(o.cents))} a month while ${who} pays for part of it${esc(when)}.`
        : `“${esc(o.label)}” is held back while ${who} covers it${esc(when)}.`;
    }).join(' ');
    return `<p class="plan-ch-caveat fine" id="plan-baby-caveat">${esc(st.caveat)}${month}</p>${twice ? `<p class="plan-ch-caveat fine" id="plan-baby-overlap" role="note"><strong>Counted once:</strong> ${twice}</p>` : ''}`;
  }

  /**
   * A pack's items or a what-if's changes as one folded row: its colour, one box to accept or
   * unaccept them all (mixed: some accepted), the name, how many, the totals and how many are in
   * the plan; open, the lines of its changes (each with its own controls and ids).
   */
  function groupRow(ctx, tl, name, list) {
    const id = groupIdOf(name);
    const n = list.length;
    const accepted = list.filter(ch => ch.accepted).length;
    const on = list.filter(ch => ch.status === 'applied').length;
    const unset = list.filter(ch => ch.cents === null).length;
    const [text, tone] = on === n ? ['In plan', 'good'] : on ? [`${on} of ${n} in plan`, 'info'] : accepted ? ['Not in plan yet', 'neutral'] : ['Not accepted', 'neutral'];
    const totals = totalsText(list);
    const first = list.reduce((m, ch) => (ch.startMonth < m ? ch.startMonth : m), list[0].startMonth);
    const open = P.openGroup === name ? ' open' : '';
    const ids = list.map(ch => ch.id).join(' ');
    return `<li class="plan-ch-item plan-ch-group${accepted === n ? ' is-applied' : accepted ? ' is-part' : ' is-notAccepted'}" data-group="${esc(name)}">
        <label class="plan-ch-accept plan-grp-accept" for="${esc(id)}-on" title="Accept or unaccept all ${n}"><input type="checkbox" class="plan-ch-on" id="${esc(id)}-on" data-action="plan:group-accept" data-ids="${esc(ids)}" data-name="${esc(name)}"${accepted === n ? ' checked' : ''}${accepted && accepted < n ? ' data-mixed="1"' : ''} aria-label="${esc('Accepted: all of ' + name)}"></label>
        <details class="plan-grp" id="${esc(id)}"${open}>
          <summary class="plan-ch-main plan-grp-sum">
            <span class="plan-ch-swatch key key-swatch ${esc(clsOf(list[0]))}" aria-hidden="true"></span>
            <span class="plan-ch-accept plan-grp-gap" aria-hidden="true"></span>
            <span class="plan-grp-name">${esc(name)}</span>
            <span class="plan-grp-meta">${esc(plural(n, 'item'))}${totals ? ` · <span class="plan-grp-totals">${esc(totals)}</span>` : ''}</span>
            <span class="plan-ch-when-text">${esc('from ' + fmt.month(first))}</span>
            <span class="plan-ch-status">${badgeWithId(id + '-status', text, tone)}${unset ? ' ' + badgeWithId(id + '-unset', unset + ' not set', 'warn') : ''}</span>
            <span class="plan-grp-chev" aria-hidden="true"></span>
          </summary>
          <ul class="plan-ch-sublist" aria-label="${esc(name)}">${list.map(ch => changeRow(ctx, tl, ch)).join('')}</ul>
        </details>
        ${babyLines(ctx, tl, name)}
      </li>`;
  }

  /** The list: one row per change, a pack's or a what-if's changes folded into one, by first month. */
  function listHtml(ctx, tl, all) {
    const rows = [];
    const groups = new Map();
    for (const ch of all) {
      const name = groupKeyOf(ch);
      if (!name) { rows.push({ month: ch.startMonth, html: () => changeRow(ctx, tl, ch) }); continue; }
      if (!groups.has(name)) {
        const g = { name, list: [] };
        groups.set(name, g);
        rows.push({ month: ch.startMonth, group: g });
      }
      groups.get(name).list.push(ch);
    }
    return rows.map(r => {
      if (!r.group) return r.html();
      // A group of one is just its line.
      return r.group.list.length === 1 ? changeRow(ctx, tl, r.group.list[0]) : groupRow(ctx, tl, r.group.name, r.group.list);
    }).join('');
  }

  // ------------------------------------------------------------------ add a change of the household's own
  function addHtml(tl) {
    return `<details class="plan-add-item" id="plan-add-custom"><summary class="plan-add-btn"><span class="plan-add-plus" aria-hidden="true">+</span>Custom change</summary>
        <form class="plan-ch-add plan-add-form" id="plan-ch-add" data-action="plan:add-change" novalidate>
          <div class="plan-ch-addrow">
            <label class="plan-ch-field plan-ch-field-wide"><span>What</span><input type="text" name="label" id="plan-ch-new-label" maxlength="80" autocomplete="off" placeholder="e.g. Car repair"></label>
            <label class="plan-ch-field"><span>Kind</span><select name="kind" id="plan-ch-new-kind">${optionList(Object.entries(KIND_LABEL), 'oneTime')}</select></label>
            <label class="plan-ch-field"><span>Group</span><select name="group" id="plan-ch-new-group">${optionList(Object.entries(CHANGE_GROUP_LABEL), 'irregular')}</select></label>
            <label class="plan-ch-field"><span>From</span><input type="month" name="start" id="plan-ch-new-start" value="${esc(tl.planStart)}"></label>
            <label class="plan-ch-field"><span>Amount</span><span class="input-money"><span aria-hidden="true">$</span><input type="text" name="amount" id="plan-ch-new-amt" inputmode="text" autocomplete="off" placeholder="Not set"></span></label>
            <button type="submit" class="btn btn-primary btn-small" id="plan-ch-new-add">Add</button>
          </div>
          <p class="field-error" id="plan-ch-new-error" role="alert" hidden></p>
        </form>
      </details>`;
  }

  // ------------------------------------------------------------------ Edit plan: the section
  /** The household's own changes in a few words: "3 of 9 in the plan · 1 without an amount". */
  function countsText(tl) {
    const own = tl.changes.list.filter(x => !x.readOnly);
    if (!own.length) return '';
    return [`${tl.changes.applied} of ${own.length} in the plan`, tl.changes.unset.length ? `${tl.changes.unset.length} without an amount` : ''].filter(Boolean).join(' · ');
  }

  function changesHtml(ctx, tl) {
    const all = tl.changes.list.slice().sort((a, b) => (a.startMonth < b.startMonth ? -1 : a.startMonth > b.startMonth ? 1 : 0));
    const list = all.length
      ? `<ul class="plan-ch-list" id="plan-ch-list" aria-label="Planned changes">${listHtml(ctx, tl, all)}</ul>`
      : '<p class="plan-ch-empty" id="plan-ch-empty">Nothing planned yet.</p>';
    const counts = countsText(tl);
    return `<section class="card plan-coming" id="plan-changes" aria-labelledby="plan-changes-h">
        <div class="plan-card-head"><h2 class="plan-h" id="plan-changes-h" tabindex="-1">Planned changes</h2>${counts ? `<p class="plan-card-meta" id="plan-ch-counts">${esc(counts)}</p>` : ''}</div>
        ${list}
        <div class="plan-add" id="plan-add">${addHtml(tl)}</div>
      </section>`;
  }

  // ------------------------------------------------------------------ Overview: Coming up
  /** "$450", "$80/mo", "−$1.5k/mo" (income keeps its sign: a drop is negative). */
  const amountText = ch => (isCents(ch.cents) ? compact(ch.cents, { signed: ch.group === 'income' }) + (ch.kind === 'monthly' ? '/mo' : '') : 'amount not set');

  /**
   * The next few things on the plan, from the plan month on: a group's changes as one line (its
   * name, first month, totals, how many are in the plan), every other change, bill, pay or goal
   * from Edit plan as its own line, and the month each savings goal is reached. At most `limit`.
   */
  function comingItems(tl, limit = 6) {
    const from = tl.planStart;
    const items = [];
    const groups = new Map();
    for (const ch of tl.changes.list) {
      if (!E.months.isMonth(ch.startMonth) || ch.status === 'outside') continue;
      if (ch.startMonth < from && !(ch.kind === 'monthly' && (!ch.endMonth || ch.endMonth >= from))) continue;
      const name = groupKeyOf(ch);
      if (name) {
        if (!groups.has(name)) { const g = { key: 'group-' + name, name, list: [] }; groups.set(name, g); items.push(g); }
        groups.get(name).list.push(ch);
        continue;
      }
      items.push({ key: ch.id, ch });
    }
    for (const mk of Array.isArray(tl.markers) ? tl.markers : []) {
      if (mk.kind === 'goal' && E.months.isMonth(mk.month) && mk.month >= from) items.push({ key: 'goal-' + mk.month + '-' + mk.label, goal: mk });
    }
    const monthOf = x => (x.list ? x.list.reduce((m, ch) => (ch.startMonth < m ? ch.startMonth : m), x.list[0].startMonth) : x.ch ? x.ch.startMonth : x.goal.month);
    const first = x => (monthOf(x) < from ? from : monthOf(x));
    return items.map(x => Object.assign(x, { month: first(x) })).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)).slice(0, limit);
  }

  function comingHtml(ctx, tl) {
    const items = comingItems(tl);
    const row = x => {
      let label, amount, meta = '', off = false, cls;
      if (x.list) {
        const on = x.list.filter(ch => ch.status === 'applied').length;
        label = x.name;
        amount = totalsText(x.list) || plural(x.list.length, 'item');
        meta = on === x.list.length ? plural(x.list.length, 'item') : `${on} of ${x.list.length} in the plan`;
        off = on === 0;
        cls = clsOf(x.list[0]);
      } else if (x.ch) {
        const ch = x.ch;
        label = ch.label;
        amount = amountText(ch);
        meta = ch.readOnly ? { bill: 'Bill', goal: 'Goal', income: 'Pay' }[ch.source] || '' : ch.status === 'applied' ? '' : (STATUS_BADGE[ch.status] || [''])[0];
        off = ch.status !== 'applied';
        cls = clsOf(ch);
      } else {
        label = String(x.goal.label);
        amount = isCents(x.goal.cents) ? compact(x.goal.cents) : '';
        meta = 'Goal';
        cls = 'series-3';
      }
      return `<li class="ov-up${off ? ' is-off' : ''}" data-key="${esc(x.key)}">
          <span class="ov-up-month">${esc(fmt.month(x.month))}</span>
          <span class="ov-up-dot key key-swatch ${esc(cls)}" aria-hidden="true"></span>
          <span class="ov-up-label">${esc(label)}${meta ? ` <span class="ov-up-meta">${esc(meta)}</span>` : ''}</span>
          <span class="ov-up-amt num">${esc(amount)}</span>
        </li>`;
    };
    const body = items.length ? `<ol class="ov-up-list" id="plan-coming-list">${items.map(row).join('')}</ol>` : '<p class="fine" id="plan-coming-empty">Nothing planned to change in the months ahead.</p>';
    return `<section class="card ov-coming" id="plan-coming" aria-labelledby="plan-coming-h">
        <div class="plan-card-head"><h2 class="ov-h" id="plan-coming-h">Coming up</h2><a class="ov-link" id="plan-coming-edit" href="${esc(ctx.href('budget', { focus: 'plan-changes-h' }))}">Edit plan →</a></div>
        ${body}
      </section>`;
  }

  Object.assign(P, { KIND_LABEL, CHANGE_GROUP_LABEL, changesHtml, comingHtml, comingItems, costOf });
})(typeof globalThis !== 'undefined' ? globalThis : this);
