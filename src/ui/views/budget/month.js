'use strict';
/*
 * Budget 2. This month so far: each spending group, then its categories (the Plan's drill-down
 * rows, so the planned amounts are the Plan's), planned against spent. Spent comes from the plan
 * month's own transactions when the data reaches into it (a pace marker shows how much of the
 * month the data covers: "today" is the data's last covered day, never the clock); otherwise from
 * the last complete month, labelled so. Group amounts are the timeline's (the same as the Plan
 * chart); a category's is its purchases in the month (one-time costs are the Irregular group), and
 * anything the category rows do not hold is "Everything else", so the rows add up to the group.
 * A category's planned amount is editable in place (budget:set-plan: E.timeline.setTarget, or
 * setRow when the row carries its own amount from the Plan screen).
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const B = UI._budget;
  const { isCents, whole, amt, plural, monthName, fid, inputText, OUT_GROUPS, paceOf, progressOf } = B;

  const GROUP_CLS = { essentials: 'essentials', flexible: 'flexible', irregular: 'irregular', other: 'debt' };
  const SOURCE_TAG = { bill: 'Bill', goal: 'Goal', plan: 'Change' };

  /**
   * Which month the spending is from and what was spent: { mode: 'partial'|'last'|'none', month,
   * out (the timeline's month amounts), oneOffs, coveredDays, totalDays, pace, asOf }.
   */
  function spendMonth(tl) {
    const pm = tl.months.find(m => m.month === tl.planStart) || null;
    if (pm && pm.actualSoFar && pm.actualSoFar.out) {
      const so = pm.actualSoFar;
      const covered = Number.isFinite(so.coveredDays) ? so.coveredDays : null;
      const total = Number.isFinite(so.totalDays) ? so.totalDays : E.months.daysIn(pm.month);
      return { mode: 'partial', month: pm.month, out: so.out, oneOffs: so.oneOffs || [], coveredDays: covered, totalDays: total, pace: paceOf(covered, total),
        asOf: covered ? E.dates.inMonth(pm.month, covered) : null };
    }
    const last = tl.lastComplete ? tl.months.find(m => m.month === tl.lastComplete && m.complete) : null;
    if (last) return { mode: 'last', month: last.month, out: last.out, oneOffs: last.oneOffs || [], coveredDays: null, totalDays: null, pace: null, asOf: E.months.end(last.month) };
    return { mode: 'none', month: null, out: null, oneOffs: [], coveredDays: null, totalDays: null, pace: null, asOf: null };
  }

  /**
   * Purchases in `month` on the joint accounts by drill-down key: 'c:<category>' (split purchases
   * by their parts) or 'm:<place>' for a place moved to a group as a whole. One-time costs (the
   * month's one-offs: the Irregular group) are left out; refunds count against their category.
   */
  function categorySpend(ctx, tl, month, oneOffs) {
    const out = new Map();
    if (!month) return out;
    const skip = new Set((oneOffs || []).map(o => o.id));
    const groups = (tl.settings && tl.settings.groups) || {};
    const add = (k, v) => out.set(k, (out.get(k) || 0) + v);
    for (const t of E.ledger.filter(ctx.realTxns || ctx.txns, { months: [month], scope: 'joint' })) {
      if (t.kind !== 'spend' || t.accountType === 'investment' || skip.has(t.id)) continue;
      const parts = E.ledger.partsOf(t);
      const place = String(t.merchant || t.description || '').trim();
      const moved = groups['merchant:' + place];
      if (moved === 'essentials' || moved === 'flexible') { add('m:' + place, parts.reduce((s, p) => s + p.spendCents, 0)); continue; }
      for (const p of parts) add('c:' + p.category, p.spendCents);
    }
    return out;
  }

  /** The keys a level-1 drill row holds purchases under (see categorySpend). */
  function rowKeys(r) {
    if (r.synthetic) return ['m:' + String(r.merchant || r.label).trim()];
    if (Array.isArray(r.members) && r.members.length) return r.members.map(cat => 'c:' + cat);
    return ['c:' + r.category];
  }

  function meter(p, pace, cls) {
    // Past the plan the bar holds everything spent: the plan's part, then the part beyond it in
    // the warning colour (at least a sliver, so a small overspend still shows).
    let fill = p.fillPct, over = 0;
    if (p.status === 'over') {
      over = p.ratio === null ? 100 : Math.min(100, Math.max(6, 100 * (1 - 1 / p.ratio)));
      fill = 100 - over;
    }
    const paceAt = Number.isFinite(pace) && pace < 1 ? pace * (p.status === 'over' ? fill : 100) : null;
    return `<span class="bud-meter bud-meter-${esc(cls)} is-${esc(p.status)}" aria-hidden="true"><span class="bud-meter-fill" style="width:${fill.toFixed(2)}%"></span>${over ? `<span class="bud-meter-over" style="width:${over.toFixed(2)}%"></span>` : ''}${paceAt !== null ? `<span class="bud-meter-pace" style="left:${paceAt.toFixed(2)}%"></span>` : ''}</span>`;
  }

  function statusText(p, planned, spent) {
    if (spent === null) return '';
    if (p.status === 'over') return `<span class="bud-st bud-st-over">Over by ${esc(whole(p.overCents))}</span>`;
    if (p.status === 'ahead') return `<span class="bud-st bud-st-ahead">Ahead of pace</span>`;
    if (isCents(planned) && planned > 0) return `<span class="bud-st bud-st-left">${esc(whole(p.leftCents))} left</span>`;
    return '';
  }

  /** One category (or other) row. `edit`: { id, row } for a row whose plan can be typed here. */
  function catRow({ key, label, planned, spent, pace, cls, tag = '', edit = null, kind = null, judgePace = true }) {
    // kind: 'item' (a one-time cost), 'rest' (everything else), 'planned' (added by the plan): no judgement.
    const p = kind ? { status: kind, fillPct: 0, ratio: null, overCents: 0, leftCents: null } : progressOf(spent, planned, judgePace ? pace : null);
    const planCell = edit
      ? `<span class="bud-plan-edit"><label class="sr-only" for="${esc(edit.id)}">${esc(label)}: planned a month</label><span class="input-money bud-plan-input"><span aria-hidden="true">$</span><input id="${esc(edit.id)}" type="text" inputmode="decimal" autocomplete="off" data-action="budget:set-plan" data-commit="1" data-row="${esc(edit.row.id)}" data-cat="${esc(edit.row.category)}" data-source="${esc(edit.row.source)}" data-cents="${esc(isCents(planned) ? planned : '')}" value="${esc(inputText(planned))}" placeholder="${esc(inputText(edit.row.defaultCents))}" aria-describedby="${esc(edit.id)}-error"></span></span>`
      : `<span class="bud-plan-ro num">${esc(isCents(planned) ? amt(planned) : '—')}</span>`;
    return `<li class="bud-row bud-cat is-${esc(p.status)}" data-key="${esc(key)}">
      <span class="bud-row-name"><span class="bud-row-label">${esc(label)}</span>${tag}</span>
      ${kind ? '<span class="bud-meter is-empty" aria-hidden="true"></span>' : meter(p, pace, cls)}
      <span class="bud-row-spent num">${spent === null ? '<span class="muted">—</span>' : esc(whole(spent))}</span>
      <span class="bud-row-of" aria-hidden="true">${planned === null && kind ? '' : 'of'}</span>
      ${planned === null && kind ? '<span class="bud-plan-ro"></span>' : planCell}
      <span class="bud-row-status">${kind ? '' : statusText(p, planned, spent)}</span>
      ${edit ? `<p class="field-error bud-row-error" id="${esc(edit.id)}-error" role="alert" hidden></p>` : ''}
    </li>`;
  }

  function groupBlock(ctx, tl, g, sm, spendBy) {
    const planned = tl.summary.outByGroup[g.key];
    const spent = sm.out && isCents(sm.out[g.key]) ? sm.out[g.key] : null;
    if (!isCents(planned) && spent === null) return '';
    if (!planned && !spent) return '';
    const p = progressOf(spent, planned, null); // a group holds bills paid early in the month: no "ahead of pace"
    const cls = GROUP_CLS[g.key];
    const dial = tl.dialsByKey[g.key];
    const pm = tl.months.find(m => m.month === tl.planStart);
    const applied = pm ? (pm.changesApplied || []).filter(ch => ch.group === g.key) : [];
    const rows = [];
    let overCount = 0;
    let matched = 0;
    if (dial && dial.drill && dial.drill.kind === 'categories') {
      for (const r of dial.drill.rows) {
        if (r.level !== 1 || r.included === false) continue;
        const keys = rowKeys(r);
        const rowSpent = sm.mode === 'none' ? null : keys.reduce((s, k) => s + (spendBy.get(k) || 0), 0);
        if (rowSpent !== null) matched += rowSpent;
        if (!r.planCents && !rowSpent) continue;
        const editable = !r.synthetic && r.groupKey !== null && !!r.category;
        // Only everyday spending runs ahead of the month; a bill is paid once, whenever it is due.
        const everyday = r.pattern === 'everyday';
        const rp = progressOf(rowSpent, r.planCents, everyday ? sm.pace : null);
        if (rp.status === 'over') overCount++;
        const tag = r.synthetic ? ` ${c.badge('Place', 'neutral')}` : r.groupKey === null ? ` ${c.badge('Grouped', 'neutral')}` : '';
        rows.push(catRow({ key: r.id, label: r.label, planned: r.planCents, spent: rowSpent, pace: sm.pace, judgePace: everyday, cls, tag, edit: editable ? { id: fid('target', r.category), row: r } : null }));
      }
    } else if (g.key === 'irregular' && sm.mode !== 'none') {
      // One-time costs of the month, largest first.
      const items = sm.oneOffs.filter(o => isCents(o.cents) && o.cents).sort((a, b) => b.cents - a.cents);
      for (const o of items.slice(0, 6)) rows.push(catRow({ key: 'oneoff-' + o.id, label: o.label || o.merchant || o.description || 'One-time cost', planned: null, spent: o.cents, pace: null, cls, tag: o.date ? ` <span class="bud-row-date">${esc(fmt.date(o.date).replace(/, \d{4}$/, ''))}</span>` : '', kind: 'item' }));
      matched = items.slice(0, 6).reduce((s, o) => s + o.cents, 0);
      if (items.length > 6) rows.push(`<li class="bud-row bud-more-items fine">+ ${esc(plural(items.length - 6, 'more cost'))}</li>`);
    }
    // What the plan adds to this group this month (bills, goals, planned changes): read-only here.
    for (const ch of applied) {
      rows.push(catRow({ key: 'change-' + ch.id, label: ch.label, planned: ch.cents, spent: null, pace: null, cls, tag: ` ${c.badge(SOURCE_TAG[ch.source] || 'Change', 'info')}`, kind: 'planned' }));
    }
    if (spent !== null && rows.length && dial && dial.drill && dial.drill.kind === 'categories') {
      const rest = spent - matched;
      if (Math.abs(rest) >= 100) rows.push(catRow({ key: g.key + '-rest', label: 'Everything else', planned: null, spent: rest, pace: null, cls, kind: 'rest' }));
    }
    const direct = dial && dial.source === 'direct' ? ` ${c.badge('Set as a total on Plan', 'neutral')}` : '';
    const overBadge = overCount ? ` <span class="bud-over-count">${esc(String(overCount))} over plan</span>` : '';
    const head = `<span class="bud-row-name"><span class="bud-dot bud-seg-${esc(cls)}" aria-hidden="true"></span><span class="bud-row-label">${esc(g.label)}</span>${direct}</span>
      ${meter(p, sm.pace, cls)}
      <span class="bud-row-spent num">${spent === null ? '<span class="muted">—</span>' : esc(whole(spent))}</span>
      <span class="bud-row-of" aria-hidden="true">of</span>
      <span class="bud-plan-ro num">${esc(isCents(planned) ? whole(planned) : '—')}</span>
      <span class="bud-row-status">${statusText(p, planned, spent)}${overBadge}</span>`;
    const id = 'bud-grp-' + g.key;
    if (!rows.length) return `<li class="bud-group is-${esc(p.status)}" data-group="${esc(g.key)}"><div class="bud-row bud-row-group" id="${id}">${head}</div></li>`;
    return `<li class="bud-group is-${esc(p.status)}" data-group="${esc(g.key)}"><details class="bud-group-details" id="${id}"${g.key === 'irregular' ? '' : ' open'}>
        <summary class="bud-row bud-row-group">${head}</summary>
        <ul class="bud-cats" aria-label="${esc(g.label)} by category">${rows.join('')}</ul>
      </details></li>`;
  }

  function monthCard(ctx, tl) {
    if (!tl || !tl.summary) return '';
    const sm = spendMonth(tl);
    const spendBy = categorySpend(ctx, tl, sm.month, sm.oneOffs);
    const groups = OUT_GROUPS.map(g => groupBlock(ctx, tl, g, sm, spendBy)).join('');
    const planMonth = tl.summary.month;
    const plannedTotal = OUT_GROUPS.reduce((s, g) => s + (isCents(tl.summary.outByGroup[g.key]) ? tl.summary.outByGroup[g.key] : 0), 0);
    const spentTotal = sm.out ? OUT_GROUPS.reduce((s, g) => s + (isCents(sm.out[g.key]) ? sm.out[g.key] : 0), 0) : null;
    let title, sub, badge = '';
    if (sm.mode === 'partial') {
      title = `${monthName(sm.month)} so far`;
      sub = `Day ${sm.coveredDays} of ${sm.totalDays} · ${whole(spentTotal)} spent of ${whole(plannedTotal)}`;
    } else if (sm.mode === 'last') {
      title = `${monthName(sm.month)} against the plan`;
      sub = `${monthName(planMonth)}’s data is not in yet · ${whole(spentTotal)} spent of ${whole(plannedTotal)}`;
      badge = c.badge('Last full month', 'info');
    } else {
      title = `${monthName(planMonth)} spending plan`;
      sub = `${whole(plannedTotal)} planned · no spending recorded yet`;
    }
    const key = `<p class="bud-month-key" aria-hidden="true"><span class="bud-key-item"><span class="bud-key-bar"></span>Spent</span>${sm.pace !== null ? '<span class="bud-key-item"><span class="bud-key-pace"></span>Today</span>' : ''}<span class="bud-key-item"><span class="bud-key-over"></span>Over plan</span></p>`;
    return `<section class="card bud-month" id="bud-month" aria-labelledby="bud-month-h" data-mode="${esc(sm.mode)}"${sm.month ? ` data-month="${esc(sm.month)}"` : ''}>
      <div class="card-head"><div><h2 id="bud-month-h">${esc(title)} ${badge}</h2><p class="card-sub" id="bud-month-sub">${esc(sub)}</p></div>${key}</div>
      <div class="bud-cols" aria-hidden="true"><span></span><span></span><span>Spent</span><span></span><span>Planned</span><span></span></div>
      <ul class="bud-groups">${groups}</ul>
      <p class="fine bud-month-foot">Type a new planned amount to change the plan; the chart on Plan follows. <a href="${esc(ctx.href('overview'))}">Open the chart</a></p>
    </section>`;
  }

  Object.assign(B, { monthCard, spendMonth, categorySpend });
})(typeof globalThis !== 'undefined' ? globalThis : this);
