'use strict';
/*
 * Budget 3. Goals: one card per savings goal (saved so far against its target as a ring, the month
 * the plan reaches it from tl.goals, the monthly amount editable in place: a data-bind on
 * plan.savings[id].monthlyCents) and, when the data has an investment account, the investments
 * card (balance, the month's investing, a sparkline of the line the Plan draws).
 * Budget 4. Coming up: the next planned changes (the household's and the ones worked out from bills
 * and goals) with their month and amount, and a link to the chart.
 */
(function (root) {
  const UI = root.BudgetUI;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const B = UI._budget;
  const { isCents, whole, signedWhole, amt, fid, goalView, sparkPath, upcoming } = B;
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

  function investCard(ctx, tl) {
    const inv = tl.balances && tl.balances.investments;
    if (!inv) return '';
    const points = inv.points || [];
    const known = points.filter(p => isCents(p.cents) && p.status !== 'projected' && p.status !== 'illustrative');
    const now = known.length ? known[known.length - 1] : null;
    const main = (inv.accounts || []).find(a => a.primary) || (inv.accounts || [])[0] || null;
    const anchor = main && main.anchor ? main.anchor : null;
    const monthly = tl.summary && isCents(tl.summary.investingCents) ? tl.summary.investingCents : null;
    const values = points.map(p => (isCents(p.cents) ? p.cents : null));
    const firstPlan = points.findIndex(p => p.month >= tl.planStart);
    // From a year before the plan starts to the end of the plan.
    const from = Math.max(0, (firstPlan < 0 ? points.length : firstPlan) - 12);
    const spark = sparkPath(values.slice(from), 220, 48, firstPlan < 0 ? null : firstPlan - from);
    const end = points.length && isCents(points[points.length - 1].cents) ? points[points.length - 1] : null;
    const balance = anchor && isCents(anchor.cents) ? anchor.cents : now ? now.cents : null;
    const asOf = anchor && anchor.date ? fmt.date(anchor.date) : now ? fmt.month(now.month) : null;
    return `<li class="bud-goal-card bud-invest-card" id="bud-invest">
      <div class="bud-invest-head">
        <h3 class="bud-goal-name">Investments</h3>
        ${inv.illustrative ? c.badge('Illustrative growth', 'warn') : ''}
      </div>
      <p class="bud-invest-balance num">${balance === null ? 'Balance not known' : esc(whole(balance))}</p>
      <p class="bud-goal-saved">${asOf ? `Balance on ${esc(asOf)}` : 'No balance in your data yet'}</p>
      ${spark ? `<svg class="bud-spark" viewBox="0 0 220 48" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="bud-spark-line" d="${spark.d}"></path>${spark.dProjected ? `<path class="bud-spark-line is-projected" d="${spark.dProjected}"></path>` : ''}${spark.dots.map(p => `<circle class="bud-spark-dot is-past" cx="${p.x}" cy="${p.y}" r="2"></circle>`).join('')}<circle class="bud-spark-dot" cx="${spark.last.x}" cy="${spark.last.y}" r="2.5"></circle></svg>` : ''}
      <p class="bud-invest-monthly">${monthly === null ? '' : monthly >= 0 ? `<b class="num">${esc(signedWhole(monthly))}</b> a month on this plan` : `<b class="num">${esc(whole(-monthly))}</b> a month taken out`}${end && end.month !== (now && now.month) ? ` · <span class="num">${esc(whole(end.cents))}</span> by ${esc(fmt.month(end.month))}` : ''}</p>
      <p class="fine">Not cash: never counted in your cash on the chart.</p>
    </li>`;
  }

  function goalsCard(ctx, tl) {
    const goals = tl && Array.isArray(tl.goals) ? tl.goals : [];
    const invest = tl ? investCard(ctx, tl) : '';
    if (!goals.length && !invest) {
      return c.card(c.empty('No savings goals yet.', `<a class="btn btn-small btn-secondary" href="${esc(ctx.href('budget', { section: 'savings' }))}" data-action="navigate" data-view="budget" data-params="${esc(JSON.stringify({ section: 'savings' }))}" data-keep-focus="1">Add a goal</a>`), { title: 'Goals', id: 'bud-goals' });
    }
    const monthly = goals.reduce((s, g) => s + (isCents(g.monthlyCents) ? g.monthlyCents : 0), 0);
    return c.card(`<ul class="bud-goal-grid">${goals.map(g => goalCard(ctx, g, tl)).join('')}${invest}</ul>`,
      { title: 'Goals', id: 'bud-goals', subtitle: monthly ? `${esc(whole(monthly))} a month into savings goals` : '' });
  }

  const GROUP_LABEL = { income: 'Money in', essentials: 'Essentials', flexible: 'Flexible', irregular: 'Irregular', savings: 'Savings', debt: 'Debt & business', investing: 'Investing', other: 'Debt & business' };

  function comingUpCard(ctx, tl) {
    if (!tl) return '';
    const items = upcoming(tl.changes && tl.changes.list, tl.markers, tl.planStart, 6);
    const list = items.map(x => {
      const income = x.group === 'income';
      let value = '';
      if (x.kind === 'goal') value = x.cents === null ? '' : whole(x.cents);
      else if (x.cents === null) value = 'Amount not set';
      else {
        // Income changes are signed (more or less coming in); spending and savings show what goes
        // out, with a minus only for a cut.
        const sign = income ? (x.cents >= 0 ? '+' : '−') : x.cents < 0 ? '−' : '';
        value = `${sign}${amt(Math.abs(x.cents))}${x.kind === 'monthly' ? ' a month' : ''}`;
      }
      const tone = x.kind === 'goal' ? 'goal' : x.cents === null ? 'unset' : (income ? x.cents >= 0 : x.cents < 0) ? 'in' : 'out';
      const tags = [];
      if (x.source === 'bill') tags.push(c.badge('Bill', 'neutral'));
      if (x.source === 'income') tags.push(c.badge('Pay', 'neutral'));
      if (x.source === 'goal' && x.kind !== 'goal') tags.push(c.badge('Goal', 'neutral'));
      if (x.status === 'notAccepted') tags.push(c.badge('Idea', 'info'));
      if (x.scenario) tags.push(c.badge(x.scenario, 'neutral'));
      return `<li class="bud-up-item is-${esc(tone)}" data-id="${esc(x.id)}">
        <span class="bud-up-month"><span class="bud-up-mon">${esc(fmt.month(x.month).slice(0, 3))}</span> <span class="bud-up-year">${esc(x.month.slice(0, 4))}</span></span>
        <span class="bud-up-body"><span class="bud-up-label">${esc(x.label)}</span> <span class="bud-up-meta">${esc(GROUP_LABEL[x.group] || '')}${x.kind === 'monthly' && x.endMonth ? ` · until ${esc(fmt.month(x.endMonth))}` : x.kind === 'oneTime' ? ' · once' : ''}${tags.length ? ' ' + tags.join(' ') : ''}</span></span>
        <span class="bud-up-amt num">${esc(value)}</span>
      </li>`;
    }).join('');
    const body = items.length ? `<ol class="bud-up-list">${list}</ol>` : `<p class="fine bud-up-empty">Nothing planned to change in the months ahead.</p>`;
    return c.card(body, { title: 'Coming up', id: 'bud-coming', actions: `<a class="btn btn-small btn-ghost" id="bud-coming-chart" href="${esc(ctx.href('overview'))}">See on the chart →</a>` });
  }

  Object.assign(B, { goalsCard, comingUpCard, investCard });
})(typeof globalThis !== 'undefined' ? globalThis : this);
