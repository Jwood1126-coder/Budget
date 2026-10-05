'use strict';
/*
 * Plan (#/overview), 2. Coming up: what is planned across the plan's months, at a glance, then
 * the list to edit it.
 *   The strip    one line per lane across the plan horizon: a pack (New baby, Childcare, Kid costs)
 *                as one bar from its first to its last month with its one-time and monthly total
 *                (one-time items as dots on it); a change of the household's own as a dot (one-time)
 *                or a bar (monthly, to its end month or the edge); a bill Budget adds or ends; a
 *                savings goal spent or reached. Faded and dashed: listed, not in the plan yet.
 *                Labels never overlap: each item takes the first lane with room.
 *   The list     every planned change, by month: accept, name, amount, status and remove on one
 *                line; when and how (one-time or monthly, group, whose income, start, end) folded
 *                under its date. A pack's items, and the changes of a what-if copied from a saved
 *                scenario, are one folded row (name, how many, once + a month, one box to accept
 *                or unaccept them all) that opens into those lines. What Budget adds (bills,
 *                goals) is read-only, edited in Budget.
 *   Add          the packs (one tap after a date; never accepted for you, tagged as a what-if of
 *                their own so Compare can show them first) and a change of the household's own.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const P = UI._plan;
  const { amt, plural, inputText, badgeWithId, isCents, packOf, SCENARIO_CLS, groupKeyOf, groupIdOf, shortLabel, compact, PACKS } = P;

  const KIND_LABEL = { oneTime: 'One-time', monthly: 'Monthly' };
  const CHANGE_GROUP_LABEL = { income: 'Income', essentials: 'Essentials', flexible: 'Flexible', irregular: 'Irregular', savings: 'Savings' };
  /** Groups only the changes worked out from Budget use (read-only rows). */
  const DERIVED_GROUP_LABEL = { debt: 'Debt & business' };
  const STATUS_BADGE = { applied: ['In plan', 'good'], notAccepted: ['Not accepted', 'neutral'], unset: ['Amount not set', 'warn'], outside: ['Outside horizon', 'neutral'], overridden: ['Savings set by you', 'neutral'] };
  /** The packs offered, in order: the template, the id stem of their controls, what they need. */
  const ADD_PACKS = [
    { key: 'babyFirstYear', stem: 'baby', needs: 'due' },
    { key: 'childcare', stem: 'childcare', needs: 'start' },
    { key: 'kidCosts', stem: 'kids', needs: 'due' },
  ];

  // ------------------------------------------------------------------ amounts and words
  /** Cost of a change to checking: spending and savings count up, income counts down. */
  const costOf = ch => (ch.group === 'income' ? 0 - ch.cents : ch.cents);
  /** "$450", "$80/mo", "−$1.5k/mo" (income keeps its sign: a drop is negative). */
  const amountText = ch => (isCents(ch.cents) ? compact(ch.cents, { signed: ch.group === 'income' }) + (ch.kind === 'monthly' ? '/mo' : '') : 'amount?');
  const whenText = ch => (ch.kind === 'monthly' ? (ch.endMonth ? fmt.month(ch.startMonth) + '–' + fmt.month(ch.endMonth) : 'from ' + fmt.month(ch.startMonth)) : fmt.month(ch.startMonth));
  const groupText = ch => CHANGE_GROUP_LABEL[ch.group] || DERIVED_GROUP_LABEL[ch.group] || ch.group;
  /** The colour of a change: its pack's, Budget's quiet one, a goal's green, else the household's own blue. */
  const clsOf = ch => (packOf(ch) ? packOf(ch).cls : ch.scenario && !ch.readOnly ? SCENARIO_CLS : ch.source === 'bill' ? 'series-muted' : ch.source === 'goal' ? 'series-3' : 'series-1');
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

  // ------------------------------------------------------------------ the strip
  /** Drawing size, by the same rule as the chart (phones get their own, so text keeps its size). */
  function stripGeometry() {
    const w = typeof root.innerWidth === 'number' ? root.innerWidth : 1366;
    if (UI.chart.isNarrow()) return { W: 340, pad: 6, font: 6.1 };
    return { W: w < 1200 ? 720 : 940, pad: 8, font: 6.3 };
  }

  /**
   * What the strip draws, before placing: { key, label, amount, from, to (month indexes; to null =
   * a dot), dots: [index], cls, state 'on'|'off'|'part', kind 'pack'|'change'|'bill'|'goal', title }.
   */
  function stripItems(tl, months) {
    const at = m => (m < months[0] ? 0 : months.indexOf(m));
    const last = months.length - 1;
    const inRange = ch => ch.startMonth <= months[last] && (ch.kind === 'oneTime' ? ch.startMonth >= months[0] : !ch.endMonth || ch.endMonth >= months[0]);
    const endOf = ch => (ch.kind === 'oneTime' ? null : ch.endMonth && ch.endMonth < months[last] ? at(ch.endMonth) : last);
    const items = [];
    const groups = new Map();
    for (const ch of tl.changes.list) {
      if (!inRange(ch)) continue;
      const name = groupKeyOf(ch);
      if (name) {
        const key = 'group-' + name;
        if (!groups.has(key)) groups.set(key, { key, name, cls: clsOf(ch), list: [] });
        groups.get(key).list.push(ch);
        continue;
      }
      const state = ch.status === 'applied' ? 'on' : 'off';
      if (ch.readOnly) {
        const isEnd = ch.source === 'bill' && ch.cents < 0 && ch.kind === 'monthly';
        items.push({ key: ch.id, label: shortLabel(ch.label), amount: amountText(Object.assign({}, ch, { cents: isEnd ? 0 - ch.cents : ch.cents })) + (isEnd ? ' less' : ''),
          from: at(ch.startMonth), to: isEnd ? null : endOf(ch), dots: [], cls: clsOf(ch), state, kind: ch.source === 'goal' ? 'goal' : 'bill', title: ch.label });
        continue;
      }
      items.push({ key: ch.id, label: shortLabel(ch.label), amount: amountText(ch), from: at(ch.startMonth), to: endOf(ch), dots: [], cls: clsOf(ch), state, kind: 'change', title: ch.label + ' · ' + whenText(ch) });
    }
    for (const g of groups.values()) {
      const list = g.list;
      const from = Math.min(...list.map(ch => at(ch.startMonth)));
      const to = Math.max(...list.map(ch => (ch.kind === 'oneTime' ? at(ch.startMonth) : endOf(ch))));
      const amount = totalsText(list).replace(' once', '');
      const on = list.filter(ch => ch.status === 'applied').length;
      items.push({ key: g.key, label: shortLabel(g.name), amount, from, to: to > from ? to : null,
        dots: list.filter(ch => ch.kind === 'oneTime').map(ch => at(ch.startMonth)), cls: g.cls,
        state: on === list.length ? 'on' : on ? 'part' : 'off', kind: 'pack', title: g.name + ': ' + plural(list.length, 'item') + (on < list.length ? `, ${on} in the plan` : '') });
    }
    for (const goal of tl.goals || []) {
      if (!goal.reachMonth || goal.reachMonth < months[0] || goal.reachMonth > months[last]) continue;
      items.push({ key: 'goal-reach-' + goal.id, label: shortLabel(goal.label) + ' ✓', amount: compact(goal.targetCents), from: at(goal.reachMonth), to: null, dots: [], cls: 'series-3', state: 'on', kind: 'reach', title: goal.label + ' reached' });
    }
    return items.sort((a, b) => a.from - b.from || (b.to === null ? -1 : 0) - (a.to === null ? -1 : 0));
  }

  /** The strip itself (an SVG drawn to a fixed width per screen size, so its text keeps its size). */
  function stripHtml(tl) {
    const months = tl.months.map(m => m.month).filter(m => m >= tl.planStart);
    if (!months.length) return '';
    const items = stripItems(tl, months);
    if (!items.length) return '';
    const g = stripGeometry();
    const n = months.length;
    const plotW = g.W - 2 * g.pad;
    const xAt = i => g.pad + (plotW * i) / n;
    const LANE = 34;
    const lanes = [];
    const placed = items.map(it => {
      const x0 = xAt(it.from) + 2;
      const x1 = it.to === null ? x0 + 8 : xAt(it.to + 1) - 2;
      const text = it.label + (it.amount ? '  ' + it.amount : '');
      const w = text.length * g.font;
      const right = x0 - 4 + w <= g.W - g.pad;
      const tx = right ? (it.to === null ? x0 - 4 : x0) : g.W - g.pad;
      const span = [Math.min(right ? tx : tx - w, x0 - 4), Math.max(right ? tx + w : tx, x1)];
      let lane = lanes.findIndex(end => end + 10 <= span[0]);
      if (lane < 0) { lanes.push(-Infinity); lane = lanes.length - 1; }
      lanes[lane] = span[1];
      return Object.assign({}, it, { x0, x1, tx, anchor: right ? 'start' : 'end', lane });
    });
    const axisY = lanes.length * LANE + 8;
    const H = axisY + 30;
    // Month ticks: every month when there is room, else calendar steps (January always gets its year).
    const per = plotW / n;
    const step = per >= 34 ? 1 : per >= 17 ? 2 : per >= 11 ? 3 : per >= 5 ? 6 : 12;
    const ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let ticks = '';
    months.forEach((m, i) => {
      const mi = Number(m.slice(5, 7)) - 1;
      if (i !== 0 && mi % step !== 0) return;
      const x = xAt(i);
      ticks += `<line class="cu-tick" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${axisY}" y2="${axisY + 5}"/>`
        + `<text class="cu-month" x="${(x + 3).toFixed(1)}" y="${axisY + 16}">${esc(ABBR[mi])}</text>`
        + (mi === 0 || i === 0 ? `<text class="cu-year" x="${(x + 3).toFixed(1)}" y="${axisY + 28}">${esc(m.slice(0, 4))}</text>` : '');
      if (i && mi === 0) ticks += `<line class="cu-year-rule" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="0" y2="${axisY}"/>`;
    });
    const body = placed.map(it => {
      const y = it.lane * LANE + 8;
      const by = y + 20; // the bar's middle
      const cls = `cu-item is-${it.kind} is-${it.state} ${esc(it.cls)}`;
      let mark;
      if (it.to === null) {
        mark = it.kind === 'reach'
          ? `<path class="cu-mark" d="M${it.x0.toFixed(1)} ${by - 6}l6 6l-6 6l-6 -6z"/>`
          : `<circle class="cu-mark" cx="${it.x0.toFixed(1)}" cy="${by}" r="5.5"/>`;
      } else {
        mark = `<rect class="cu-bar" x="${it.x0.toFixed(1)}" y="${by - 5}" width="${Math.max(6, it.x1 - it.x0).toFixed(1)}" height="10" rx="5"/>`
          + it.dots.map(i => `<circle class="cu-dot" cx="${(xAt(i) + per / 2).toFixed(1)}" cy="${by}" r="3"/>`).join('')
          + (it.to === n - 1 && it.kind !== 'pack' ? `<path class="cu-open" d="M${(it.x1 - 1).toFixed(1)} ${by - 5}l5 5l-5 5z"/>` : '');
      }
      const label = `<text class="cu-label" x="${it.tx.toFixed(1)}" y="${y + 8}" text-anchor="${it.anchor}"><tspan class="cu-name">${esc(it.label)}</tspan>${it.amount ? `<tspan class="cu-amt" dx="6">${esc(it.amount)}</tspan>` : ''}</text>`;
      return `<g class="${cls}" data-item="${esc(it.key)}"><title>${esc(it.title + (it.amount ? ' · ' + it.amount : ''))}</title>${mark}${label}</g>`;
    }).join('');
    const today = `<line class="cu-axis" x1="${g.pad}" x2="${g.W - g.pad}" y1="${axisY}" y2="${axisY}"/>`;
    const spoken = items.map(it => `${it.title}${it.amount ? ', ' + it.amount : ''}, ${fmt.month(months[it.from])}${it.to !== null ? ' to ' + fmt.month(months[it.to]) : ''}${it.state === 'off' ? ', not in the plan yet' : ''}`).join('; ');
    return `<div class="cu-strip" id="plan-coming-strip"><svg class="cu-svg" viewBox="0 0 ${g.W} ${H}" role="img" aria-label="${esc('Coming up, ' + fmt.month(months[0]) + ' to ' + fmt.month(months[n - 1]) + ': ' + spoken + '.')}">${ticks}${today}${body}</svg></div>`;
  }

  // ------------------------------------------------------------------ the list
  /** A change worked out from Budget (a bill or a savings goal): shown, edited in Budget. */
  function derivedRow(ctx, ch) {
    const id = 'plan-ch-' + ch.id;
    const [statusText, tone] = STATUS_BADGE[ch.status] || ['', 'neutral'];
    const href = ctx.href('budget', { section: ch.source === 'goal' ? 'savings' : 'bills' });
    return `<li class="plan-ch-item is-${esc(ch.status)} is-derived" data-change="${esc(ch.id)}">
        <div class="plan-ch-main">
          <span class="plan-ch-swatch key key-swatch ${esc(clsOf(ch))}" aria-hidden="true"></span>
          <span class="plan-ch-accept plan-ch-noaccept" aria-hidden="true"></span>
          <span class="plan-ch-label plan-ch-text" title="${esc(ch.note || '')}">${esc(ch.label)}</span>
          <a class="plan-ch-budget" id="${esc(id)}-budget" href="${esc(href)}" title="${esc(ch.note || '')}">${esc(ch.source === 'goal' ? 'Goal' : 'Bill')} · Budget<span class="sr-only">: edit ${esc(ch.label)} in Budget</span> →</a>
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
        <p class="field-error" id="${esc(id)}-label-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-amt-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-start-error" role="alert" hidden></p>
        <p class="field-error" id="${esc(id)}-end-error" role="alert" hidden></p>
      </li>`;
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

  // ------------------------------------------------------------------ add: the packs and a change
  /** The due month of a New baby pack already in the plan ('YYYY-MM'), to start Childcare and Kid costs from. */
  function dueOf(tl) {
    const diapers = tl.changes.list.find(ch => ch.template === 'babyFirstYear' && ch.kind === 'monthly' && ch.group !== 'income');
    return diapers ? diapers.startMonth : null;
  }

  function addHtml(tl) {
    const due = dueOf(tl);
    const pack = p => {
      const id = 'plan-pack-' + p.stem;
      const name = PACKS[p.key].name;
      let fields;
      if (p.needs === 'due') {
        fields = `<label class="plan-ch-field"><span>Due date</span><input type="date" name="due" id="${esc(id)}-date" value="${esc(due ? due + '-15' : '')}" aria-describedby="${esc(id)}-date-error"></label>`;
      } else {
        const start = due ? E.months.add(due, 3) : tl.planStart;
        const def = (E.timeline.templates.list().find(t => t.key === 'childcare') || {}).defaultCents || 120000;
        fields = `<label class="plan-ch-field"><span>Starts</span><input type="month" name="start" id="${esc(id)}-start" value="${esc(start)}" aria-describedby="${esc(id)}-date-error"></label>
          <label class="plan-ch-field"><span>A month</span><span class="input-money"><span aria-hidden="true">$</span><input type="text" name="amount" id="${esc(id)}-amt" inputmode="decimal" autocomplete="off" value="${esc(inputText(def))}" aria-describedby="${esc(id)}-date-error"></span></label>`;
      }
      return `<details class="plan-add-item" id="plan-add-${esc(p.stem)}"><summary class="plan-add-btn"><span class="plan-add-dot key key-swatch ${esc(PACKS[p.key].cls)}" aria-hidden="true"></span>${esc(name)}</summary>
          <form class="plan-add-form" id="${esc(id)}-form" data-action="plan:add-pack" data-pack="${esc(p.key)}" data-stem="${esc(p.stem)}" novalidate>
            <div class="plan-ch-addrow">${fields}<button type="submit" class="btn btn-primary btn-small" id="${esc(id)}-add">Add</button></div>
            <p class="field-error" id="${esc(id)}-date-error" role="alert" hidden></p>
          </form>
        </details>`;
    };
    const custom = `<details class="plan-add-item" id="plan-add-custom"><summary class="plan-add-btn"><span class="plan-add-plus" aria-hidden="true">+</span>Custom</summary>
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
    return `<div class="plan-add" id="plan-add" role="group" aria-label="Add to the plan"><span class="plan-add-h" aria-hidden="true">Add</span>${ADD_PACKS.map(pack).join('')}${custom}</div>`;
  }

  // ------------------------------------------------------------------ the section
  /** The household's own changes in a few words: "3 of 9 in the plan · 1 without an amount". */
  function countsText(tl) {
    const own = tl.changes.list.filter(x => !x.readOnly);
    if (!own.length) return '';
    return [`${tl.changes.applied} of ${own.length} in the plan`, tl.changes.unset.length ? `${tl.changes.unset.length} without an amount` : ''].filter(Boolean).join(' · ');
  }

  function changesHtml(ctx, tl) {
    const all = tl.changes.list.slice().sort((a, b) => (a.startMonth < b.startMonth ? -1 : a.startMonth > b.startMonth ? 1 : 0));
    const own = all.filter(ch => !ch.readOnly);
    const waiting = own.filter(ch => !ch.accepted).length;
    const accepted = own.length - waiting;
    const bulk = own.length ? `<p class="plan-ch-bulk">${waiting ? c.button(`Accept all ${waiting}`, { action: 'plan:change-accept-all', id: 'plan-ch-accept-all', cls: 'btn-small' }) : ''}${accepted ? c.button('Unaccept all', { action: 'plan:change-unaccept-all', id: 'plan-ch-unaccept-all', cls: 'btn-small btn-ghost' }) : ''}</p>` : '';
    const list = all.length
      ? `<ul class="plan-ch-list" id="plan-ch-list" aria-label="Planned changes">${listHtml(ctx, tl, all)}</ul>`
      : '<p class="plan-ch-empty" id="plan-ch-empty">Nothing planned yet. Add a pack or a change of your own.</p>';
    const counts = countsText(tl);
    return `<section class="card plan-coming" id="plan-changes" aria-labelledby="plan-changes-h">
        <div class="plan-card-head"><h2 class="plan-h" id="plan-changes-h">Coming up</h2>${counts ? `<p class="plan-card-meta" id="plan-ch-counts">${esc(counts)}</p>` : ''}</div>
        ${stripHtml(tl)}
        ${addHtml(tl)}
        ${list}${bulk}
      </section>`;
  }

  Object.assign(P, { KIND_LABEL, CHANGE_GROUP_LABEL, changesHtml, costOf });
})(typeof globalThis !== 'undefined' ? globalThis : this);
