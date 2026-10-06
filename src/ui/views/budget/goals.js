'use strict';
/*
 * Edit plan, savings goals: one card per goal (saved so far against its target as a ring, the
 * month the plan reaches it from tl.goals, the monthly amount editable in place: a data-bind on
 * plan.savings[id].monthlyCents).
 */
(function (root) {
  const UI = root.BudgetUI;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const B = UI._budget;
  const { isCents, whole, fid, goalView } = B;
  const { centsToInput } = UI.dom;

  const RING_R = 30;
  const RING_C = 2 * Math.PI * RING_R;

  function ring(progress, tone) {
    const p = progress === null ? 0 : progress;
    const dash = (p * RING_C).toFixed(2);
    return `<svg class="bud-ring is-${esc(tone)}" viewBox="0 0 72 72" width="72" height="72" aria-hidden="true" focusable="false">
      <circle class="bud-ring-track${progress === null ? ' is-unknown' : ''}" cx="36" cy="36" r="${RING_R}"></circle>
      ${p > 0 ? `<circle class="bud-ring-fill" cx="36" cy="36" r="${RING_R}" stroke-dasharray="${dash} ${RING_C.toFixed(2)}" transform="rotate(-90 36 36)"></circle>` : ''}
      <text class="bud-ring-text" x="36" y="36" dy=".35em" text-anchor="middle">${progress === null ? '?' : Math.round(p * 100) + '%'}</text>
    </svg>`;
  }

  function goalCard(ctx, g, tl) {
    const v = goalView(g);
    const id = fid('goal-monthly', g.id);
    let reach, tone;
    if (v.reach === 'reached') { reach = 'Reached'; tone = 'good'; }
    else if (v.reach === 'month') { reach = `On track for ${fmt.month(v.month)}`; tone = g.targetMonth && v.month > g.targetMonth ? 'warn' : 'good'; }
    else if (v.reach === 'beyond') { reach = 'Not on this plan'; tone = 'warn'; }
    else { reach = 'No target set'; tone = 'neutral'; }
    const savedText = v.saved === null ? 'Saved so far not entered' : `${whole(v.saved)} saved`;
    const targetText = v.target === null ? '' : ` of ${whole(v.target)}`;
    const due = g.targetMonth ? `<span class="bud-goal-due">${g.spendAtTarget ? 'Spend' : 'By'} ${esc(fmt.month(g.targetMonth))}</span>` : '';
    const late = v.reach === 'beyond' && tl.lastMonth ? `<span class="sr-only"> (not reached by ${esc(fmt.month(tl.lastMonth))})</span>` : '';
    return `<li class="bud-goal-card is-${esc(tone)}" id="${esc(fid('goal-card', g.id))}" data-goal="${esc(g.id)}">
      <div class="bud-goal-top">
        ${ring(v.progress, tone)}
        <div class="bud-goal-text">
          <h3 class="bud-goal-name">${esc(g.label)}</h3>
          <p class="bud-goal-saved num">${esc(savedText)}<span class="bud-goal-of">${esc(targetText)}</span></p>
          <p class="bud-goal-reach tone-${esc(tone)}">${esc(reach)}${late}${due ? ' · ' + due : ''}</p>
        </div>
      </div>
      <div class="bud-goal-monthly">
        <label for="${esc(id)}">A month</label>
        <span class="input-money bud-plan-input"><span aria-hidden="true">$</span><input id="${esc(id)}" type="text" inputmode="decimal" autocomplete="off" data-bind="plan.savings[id=${esc(g.id)}].monthlyCents" data-type="money" data-message="${esc(g.label + ': monthly amount saved.')}" value="${esc(centsToInput(isCents(g.monthlyCents) ? g.monthlyCents : null))}" placeholder="Not set" aria-describedby="${esc(id)}-error"></span>
        <p class="field-error" id="${esc(id)}-error" role="alert" hidden></p>
      </div>
    </li>`;
  }

  function goalsCard(ctx, tl) {
    const goals = tl && Array.isArray(tl.goals) ? tl.goals : [];
    if (!goals.length) {
      return c.card(c.empty('No savings goals yet.', `<a class="btn btn-small btn-secondary" href="${esc(ctx.href('budget', { section: 'savings' }))}" data-action="navigate" data-view="budget" data-params="${esc(JSON.stringify({ section: 'savings' }))}" data-keep-focus="1">Add a goal</a>`), { title: 'Savings goals', id: 'bud-goals' });
    }
    const monthly = goals.reduce((s, g) => s + (isCents(g.monthlyCents) ? g.monthlyCents : 0), 0);
    return c.card(`<ul class="bud-goal-grid">${goals.map(g => goalCard(ctx, g, tl)).join('')}</ul>`,
      { title: 'Savings goals', id: 'bud-goals', subtitle: monthly ? `${esc(whole(monthly))} a month into savings goals` : '' });
  }

  Object.assign(B, { goalsCard });
})(typeof globalThis !== 'undefined' ? globalThis : this);
