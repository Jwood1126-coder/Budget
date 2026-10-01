'use strict';
/*
 * Overview: what is coming in, what is going out, what remains — planned (typical month)
 * next to actual (latest complete month) — plus the decisions that need attention.
 * Joint-account scope uses the imported shared accounts; whole-household scope adds full pay
 * and personally paid bills from the budget, and says plainly what is unknown.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  const SCOPE_OPTIONS = [{ value: 'joint', label: 'Joint accounts' }, { value: 'household', label: 'Whole household' }];
  const TIMING_TEXT = {
    conservative: 'a typical month (2 biweekly paychecks, never the occasional third)',
    average: 'the annual monthly average (includes extra paychecks spread over the year)',
    actual: 'actual paydays in the coming month',
  };

  /** Actual flows for one month across joint accounts, each traceable to a Spending link. */
  function actualMonth(ctx, month) {
    const L = E.ledger;
    const rows = L.filter(ctx.txns, { months: [month], scope: 'joint' });
    const s = L.summarize(rows);
    const income = s.incomeCents + s.contributionsCents;
    const remains = income - s.spendingCents - s.debtPaymentsCents - s.savedNetCents;
    return { s, income, remains, coverage: ctx.coverageMap[month] };
  }

  /** Split the plan into the same buckets the actuals use. */
  function planBuckets(summary, planBills) {
    const typeOf = new Map((planBills || []).map(b => [b.id, b.type]));
    let debt = 0, otherBills = 0;
    for (const line of summary.bills.lines || []) {
      if (line.cents === null || line.cents === undefined) continue;
      if ((line.type || typeOf.get(line.id)) === 'debt') debt += line.cents; else otherBills += line.cents;
    }
    const personal = (summary.personal || []).reduce((a, p) => a + (summary.scope === 'household' ? (p.spendingCents || 0) : 0), 0);
    return {
      income: summary.income.totalCents,
      incomeLowerBound: summary.income.lowerBoundCents ?? null,
      spending: summary.spending.targetsCents + otherBills + personal,
      debt,
      saved: summary.savings.totalCents,
      remains: summary.remainingCents,
    };
  }

  /**
   * Usual spending in categories the plan has no number for. Without this, a budget with blank
   * targets would show a "remaining" figure that is far too high.
   */
  function unbudgeted(ctx, month) {
    if (!month) return { total: 0, list: [] };
    const win = ctx.state.plan.settings.comparisonWindow || 3;
    const cmp = ctx.memo('overview-cmp:' + month + win, () => E.compare.usual(ctx.txns, ctx.dataset, { month, window: win }));
    const targets = ctx.state.plan.targets || {};
    const billCats = new Set((ctx.state.plan.bills || []).filter(b => b.category && b.monthlyCents !== null && (ctx.scope === 'household' || b.fundedFrom === 'joint')).map(b => b.category));
    const list = cmp.categories.filter(x => (x.averageCents || 0) > 0 && !billCats.has(x.category) && !(typeof targets[x.category] === 'number'));
    return { total: list.reduce((a, x) => a + x.averageCents, 0), list };
  }

  function flowTable(ctx, plan, actual, month) {
    const p = planBuckets(plan, ctx.state.plan.bills);
    const href = params => ctx.href('spending', { period: month, ...params });
    const actualCell = (cents, params, note) => {
      if (!actual) return '<span class="muted">No complete month yet</span>';
      return `<a href="${esc(href(params))}">${esc(fmt.money(cents, { whole: true }))}</a>${note ? `<small>${note}</small>` : ''}`;
    };
    const planIncome = p.income !== null ? esc(fmt.money(p.income, { whole: true }))
      : p.incomeLowerBound !== null ? `At least ${esc(fmt.money(p.incomeLowerBound, { whole: true }))}<small>Some take-home pay is unknown</small>`
        : '<span class="tone-bad">Unknown</span><small>Enter pay details in Budget</small>';
    const gap = unbudgeted(ctx, month);
    const gapNote = gap.total > 0 ? `<small class="tone-warn">Before about ${esc(fmt.money(gap.total, { whole: true }))} of usual spending with no target</small>` : '';
    const remainsPlan = p.remains === null ? '<span class="tone-bad">Unknown</span><small>Needs complete income</small>'
      : `<strong class="${p.remains < 0 ? 'tone-bad' : ''}">${esc(fmt.money(p.remains, { whole: true }))}</strong>${gapNote}`;
    const remainsActual = actual ? `<strong class="${actual.remains < 0 ? 'tone-bad' : ''}">${esc(fmt.money(actual.remains, { whole: true }))}</strong>` : '—';
    const rows = [
      { label: 'Coming in', sub: ctx.scope === 'joint' ? 'Pay deposited to joint + contributions' : 'Full take-home pay', plan: planIncome, actual: actualCell(actual?.income, { kind: 'income' }, actual ? `${fmt.money(actual.s.payrollCents, { whole: true })} pay · ${fmt.money(actual.s.contributionsCents, { whole: true })} contributions` : '') },
      { label: 'Spending', sub: 'Bills, groceries, everything consumed', plan: esc(fmt.money(p.spending, { whole: true })) + (gap.total > 0 ? `<small><a href="${esc(ctx.href('budget', { section: 'targets' }))}">${gap.list.length} usual categor${gap.list.length === 1 ? 'y has' : 'ies have'} no target</a></small>` : ''), actual: actualCell(actual?.s.spendingCents, {}, actual && actual.s.refundsCents ? `after ${fmt.money(actual.s.refundsCents, { whole: true })} refunds` : '') },
      { label: 'Debt payments', sub: 'Loans and financing (not card bills paid in full)', plan: esc(fmt.money(p.debt, { whole: true })), actual: actualCell(actual?.s.debtPaymentsCents, { kind: 'debt' }) },
      { label: 'Saved', sub: 'Moved to savings — not spending', plan: esc(fmt.money(p.saved, { whole: true })), actual: actualCell(actual?.s.savedNetCents, { kind: 'transfer' }) },
      { label: 'What remains', sub: 'In − spending − debt − saved', plan: remainsPlan, actual: remainsActual, total: true },
    ];
    const actualHead = actual ? `Actual · ${fmt.month(month)}` : 'Actual';
    return `<div class="flow-table" role="table" aria-label="Plan compared with actual">
      <div class="flow-row flow-head" role="row"><span role="columnheader"></span><span role="columnheader">Plan · typical month</span><span role="columnheader">${esc(actualHead)}${ctx.scope === 'household' ? '<small>joint accounts only</small>' : ''}</span></div>
      ${rows.map(r => `<div class="flow-row${r.total ? ' flow-total' : ''}" role="row"><span role="rowheader"><strong>${esc(r.label)}</strong><small>${esc(r.sub)}</small></span><span role="cell" class="num">${r.plan}</span><span role="cell" class="num">${r.actual}</span></div>`).join('')}
    </div>`;
  }

  function scopeExplainer(ctx, plan) {
    if (ctx.scope === 'joint') {
      return `<p class="fine">Joint accounts are the shared checking, card and savings accounts in your imported data. Pay that goes straight to a personal account, and bills paid from personal accounts, are outside this view. ${plan.bills.excludedUnknownFunding?.length ? `<strong>Not counted here until you confirm who pays:</strong> ${plan.bills.excludedUnknownFunding.map(b => esc(b.label) + ' (' + esc(fmt.money(b.cents)) + ')').join(', ')}.` : ''}</p>`;
    }
    return `<p class="fine">Whole household adds each person's full take-home pay and the bills paid from personal accounts, using your Budget inputs. Transfers between your own accounts are never counted as extra income. Imported actuals still cover only the joint accounts.</p>`;
  }

  function attentionCard(ctx) {
    const items = ctx.attention();
    if (!items.length) return c.card(c.notice({ tone: 'good', title: 'Nothing urgent.', body: 'Inputs are filled in and the data has no open review items.' }), { title: 'Needs your attention' });
    const tone = { action: 'bad', decision: 'warn', info: 'info' };
    const label = { action: 'Action', decision: 'Decision', info: 'Note' };
    const top = items.slice(0, 7);
    const list = `<ul class="attention-list">${top.map(it => `<li class="attention-item">
        <div>${c.badge(label[it.severity] || 'Note', tone[it.severity] || 'info')} <strong>${esc(it.title)}</strong>${it.detail ? `<p>${esc(it.detail)}</p>` : ''}</div>
        ${it.route ? `<a class="btn btn-small btn-secondary" href="${esc(it.route)}">${esc(it.cta || 'Open')}<span class="sr-only">: ${esc(it.title)}</span></a>` : ''}
      </li>`).join('')}</ul>`;
    const more = items.length > top.length ? c.disclosure(`${items.length - top.length} more`, `<ul class="attention-list">${items.slice(top.length).map(it => `<li class="attention-item"><div><strong>${esc(it.title)}</strong>${it.detail ? `<p>${esc(it.detail)}</p>` : ''}</div>${it.route ? `<a class="btn btn-small btn-secondary" href="${esc(it.route)}">Open</a>` : ''}</li>`).join('')}</ul>`, { cls: 'attention-more' }) : '';
    return c.card(list + more, { title: 'Needs your attention', subtitle: 'Decisions and missing facts that change the numbers, most important first.', id: 'attention' });
  }

  function categoriesCard(ctx, month) {
    if (!month) return c.card(c.empty('Load transaction data to see where money went.', c.linkButton('Load data', ctx.href('data'))), { title: 'Where the money went' });
    const win = ctx.state.plan.settings.comparisonWindow || 3;
    const cmp = ctx.memo('overview-cmp:' + month + win, () => E.compare.usual(ctx.txns, ctx.dataset, { month, window: win }));
    const items = cmp.categories.filter(x => x.actualCents !== 0).slice(0, 8).map(x => {
      const flag = ['higher', 'seasonal_higher'].includes(x.signal) ? c.badge(fmt.diff(x.diffCents, { whole: true }), 'warn', { title: x.explanation })
        : ['lower', 'seasonal_lower'].includes(x.signal) ? c.badge(fmt.diff(x.diffCents, { whole: true }), 'info', { title: x.explanation }) : '';
      return {
        label: x.category,
        value: x.actualCents,
        reference: x.averageCents,
        href: ctx.href('spending', { period: month, cat: x.category }),
        sub: x.averageCents === null ? 'No usual amount yet' : `Usual ${fmt.money(x.averageCents, { whole: true })}`,
        badge: flag,
      };
    });
    const flagged = cmp.categories.filter(x => ['higher', 'seasonal_higher'].includes(x.signal));
    const body = `${c.barList({ items, label: 'Spending by category, ' + fmt.month(month), referenceName: `Usual (${cmp.usableCount}-month average)` })}
      <p class="fine">Usual = average of ${cmp.usableCount} full month${cmp.usableCount === 1 ? '' : 's'} before ${esc(fmt.month(month))}${cmp.baselineMonths.length ? ` (${esc(fmt.month(cmp.baselineMonths[0]))} – ${esc(fmt.month(cmp.baselineMonths[cmp.baselineMonths.length - 1]))})` : ''}. A category is marked only when it differs by at least $100 <em>and</em> 25%. ${flagged.length ? `${flagged.length} marked higher than usual.` : ''}</p>`;
    return c.card(body, { title: 'Where the money went', subtitle: `${fmt.monthLong(month)} · top categories`, actions: c.linkButton('All categories', ctx.href('spending', { period: month }), { variant: 'ghost' }), id: 'where' });
  }

  function forecastCard(ctx) {
    const scenario = ctx.state.scenarios[0];
    let proj;
    try { proj = ctx.project(scenario.id, { months: 12 }); } catch (err) { return c.card(c.notice({ tone: 'warn', title: 'Forecast unavailable', body: esc(err.message) }), { title: 'Next 12 months' }); }
    const s = proj.summary;
    const cum = s.endCumulativeCents;
    const extra = proj.rows.filter(r => (r.incomeLines || []).some(l => l.basis === 'actual' && l.count >= 3));
    const goals = proj.goals || [];
    const short = goals.filter(g => g.status === 'short');
    const metrics = `<div class="metrics">
      ${c.metric({ label: 'Change in joint cash over 12 months', value: cum === null ? 'Unknown' : fmt.money(cum, { whole: true, signed: true }), tone: cum !== null && cum < 0 ? 'bad' : '', sub: cum === null ? 'Needs complete income inputs' : 'If the budget is followed exactly', href: ctx.href('forecast') })}
      ${c.metric({ label: 'Months with more going out than coming in', value: String(s.negativeMonths.length), tone: s.negativeMonths.length ? 'warn' : '', sub: s.negativeMonths.length ? s.negativeMonths.slice(0, 3).map(fmt.month).join(', ') + (s.negativeMonths.length > 3 ? '…' : '') : 'None in the next year', href: ctx.href('forecast') })}
      ${c.metric({ label: 'Savings goals on track', value: goals.length ? `${goals.filter(g => g.status === 'funded').length} of ${goals.length}` : '—', tone: short.length ? 'warn' : '', sub: short.length ? 'Short: ' + short.map(g => g.label).join(', ') : goals.length ? 'Within this horizon' : 'Add goals in Budget', href: ctx.href('budget', { section: 'savings' }) })}
    </div>`;
    const notes = [];
    if (extra.length) notes.push(`Months with a third paycheck: ${extra.map(r => fmt.month(r.month)).join(', ')}. The typical-month plan does not count on them.`);
    if (proj.missing.length) notes.push(`${proj.missing.length} input${proj.missing.length === 1 ? ' is' : 's are'} missing and left out of these totals (not treated as $0 spending).`);
    const others = ctx.state.scenarios.slice(1);
    const compare = others.length ? `<p class="fine">Compare with ${others.slice(0, 3).map(sc => `<a href="${esc(ctx.href('forecast', { scenario: sc.id }))}">${esc(sc.name)}</a>`).join(', ')} in Forecast.</p>` : '';
    return c.card(metrics + (notes.length ? `<ul class="fine-list">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '') + compare, { title: 'Next 12 months', subtitle: `Current budget, ${ctx.scope === 'joint' ? 'joint accounts' : 'whole household'} · starting ${fmt.month(ctx.forecastStart)}`, id: 'next12' });
  }

  function dataStatus(ctx) {
    if (!ctx.months.length) {
      return c.notice({ tone: 'info', title: 'No transactions loaded', body: 'The budget and forecast work without them. To see actual spending, import your bank exports (Data & privacy explains how; nothing leaves this device).', actions: c.linkButton('Load data', ctx.href('data'), { variant: 'primary' }) });
    }
    const partial = ctx.months.filter(m => ctx.coverageMap[m]?.status !== 'full');
    return `<p class="fine data-status">Data covers ${esc(fmt.month(ctx.months[0]))} – ${esc(fmt.month(ctx.months[ctx.months.length - 1]))}. Latest complete month: <strong>${esc(ctx.latestComplete ? fmt.month(ctx.latestComplete) : 'none yet')}</strong>.${partial.length ? ` ${partial.length} month${partial.length === 1 ? ' has' : 's have'} incomplete coverage and ${partial.length === 1 ? 'is' : 'are'} left out of averages (<a href="${esc(ctx.href('review', { queue: 'coverage' }))}">see which</a>).` : ''}</p>`;
  }

  function render(ctx) {
    const month = ctx.latestComplete;
    let plan;
    try { plan = ctx.plan({ timing: ctx.state.plan.settings.incomeTiming }); } catch (err) { plan = null; }
    const actual = month ? actualMonth(ctx, month) : null;
    const header = c.pageHeader({
      eyebrow: 'Overview',
      title: 'Where things stand',
      subtitle: month ? `Your plan for a typical month next to what actually happened in ${esc(fmt.monthLong(month))}, the latest month with complete data.` : 'Your plan for a typical month. Load transactions to compare it with what actually happened.',
      actions: c.segmented({ label: 'Show', name: 'scope', options: SCOPE_OPTIONS, value: ctx.scope, action: 'set-scope' }),
    });
    const flow = plan
      ? c.card(flowTable(ctx, plan, actual, month) + scopeExplainer(ctx, plan) + `<p class="fine">Plan income uses ${esc(TIMING_TEXT[plan.timing] || plan.timing)}. ${plan.income.lines.some(l => l.assumption) ? '<strong>Assumption:</strong> ' + plan.income.lines.filter(l => l.assumption).map(l => esc(l.assumption)).join(' ') : ''} Actual figures exclude card bills paid in full and transfers between your own accounts; click any amount to see the transactions behind it.</p>`,
        { title: 'Coming in, going out, what remains', id: 'flows', actions: c.linkButton('Edit budget', ctx.href('budget'), { variant: 'ghost' }) })
      : c.card(c.notice({ tone: 'warn', title: 'The budget could not be calculated', body: 'Open Budget to check the inputs.' }), { title: 'Coming in, going out, what remains' });
    return `${header}
      ${ctx.dataset.isSynthetic ? c.notice({ tone: 'info', title: 'You are looking at a fictional sample household.', body: 'Every name, merchant and amount is invented. Load your own exports in Data &amp; privacy; they stay on this device.' }) : ''}
      ${ctx.app.datasetError ? c.notice({ tone: 'bad', title: 'Your data file could not be read', body: esc(ctx.app.datasetError) }) : ''}
      <div class="stack">
        ${dataStatus(ctx)}
        <div class="overview-grid">
          <div class="stack">${flow}${categoriesCard(ctx, month)}</div>
          <div class="stack">${attentionCard(ctx)}${forecastCard(ctx)}</div>
        </div>
      </div>`;
  }

  UI.views = UI.views || {};
  UI.views.overview = { title: 'Overview', render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
