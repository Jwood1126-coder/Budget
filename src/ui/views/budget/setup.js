'use strict';
/*
 * Budget 5. Setup details, folded away by default (one disclosure per area): pay and income, bills,
 * debts and the savings goals list. These are the editors the household's assistant keeps up to
 * date (the household mostly looks). Every edit is a data-bind (validated by
 * BudgetEngine.state.setPath) or one app.update from a budget:* action, so each change is undoable
 * from the toast. Blank stays unknown (null), never $0.
 * Income is counted as the Plan counts it: joint accounts, the annual average month
 * (E.plan.monthly with timing 'average' for the plan month, the figures flows.planFunding gives the
 * Plan's dials). Bills say what the plan does with them (tl.bills).
 * Route params: section=income|bills|debts|savings opens that area; focus=<field id> focuses a field.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;
  const B = UI._budget;
  const { money, whole, plural, possessive, listText, known, fid, moneyField, selectField, inputField, setError, focusAfterRender } = B;

  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const boolValue = v => (v === true ? 'true' : v === false ? 'false' : '__null__');
  const AREAS = ['income', 'bills', 'debts', 'savings'];
  const AREA_OF = { income: 'income', bills: 'bills', savings: 'savings', balances: 'savings', debts: 'debts' };

  const FREQ_OPTIONS = [
    { value: 'unknown', label: 'Not known yet' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'biweekly', label: 'Every two weeks (biweekly)' },
    { value: 'semimonthly', label: 'Twice a month (semimonthly)' },
    { value: 'monthly', label: 'Monthly' },
  ];
  const FREQ_STATUS_OPTIONS = [
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'observed', label: 'Seen in bank data' },
    { value: 'unknown', label: 'Not confirmed' },
  ];
  const INCOME_STATUS_OPTIONS = [
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'observed', label: 'Seen in bank data' },
    { value: 'estimate', label: 'Estimate' },
    { value: 'unknown', label: 'Unknown' },
  ];
  const KIND_OPTIONS = [
    { value: 'paycheck', label: 'Paycheck' },
    { value: 'contribution', label: 'Transfer from a personal account into joint' },
    { value: 'other', label: 'Other income' },
  ];
  const KIND_LABEL = { paycheck: 'Paycheck', contribution: 'Transfer into joint', other: 'Other income' };
  const BILL_TYPE_OPTIONS = [
    { value: 'housing', label: 'Housing' }, { value: 'utility', label: 'Utility' }, { value: 'insurance', label: 'Insurance' },
    { value: 'subscription', label: 'Subscription' }, { value: 'debt', label: 'Debt payment' }, { value: 'other', label: 'Other' },
  ];
  const BILL_TYPE_LABEL = Object.fromEntries(BILL_TYPE_OPTIONS.map(o => [o.value, o.label]));
  const BILL_STATUS_OPTIONS = [
    { value: 'existing', label: 'Existing bill' },
    { value: 'estimate', label: 'Estimate (amount not exact)' },
    { value: 'planned', label: 'Planned: not yet a bill' },
  ];
  const BALANCE_STATUS_OPTIONS = [
    { value: 'approximate', label: 'Approximate' }, { value: 'statement', label: 'From a statement' },
    { value: 'confirmed', label: 'Confirmed' }, { value: 'unknown', label: 'Unknown' },
  ];
  const APR_STATUS_OPTIONS = [
    { value: 'unknown', label: 'Not known' },
    { value: 'displayed', label: 'As displayed by the lender (not confirmed)' },
    { value: 'confirmed', label: 'Confirmed from the loan terms' },
  ];
  const TERM_STATUS_OPTIONS = [{ value: 'unknown', label: 'Not confirmed' }, { value: 'confirmed', label: 'Confirmed' }];
  const YES_NO_OPTIONS = [{ value: '__null__', label: 'Not sure yet' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];

  /** Link to an area of the setup details (opened, its field focused), keeping keyboard focus where it was. */
  function sectionLink(ctx, section, inner, { id, cls = '', params = {} } = {}) {
    const p = { section, ...params };
    // A link to the URL already shown stays a plain link: navigating to the same hash fires no
    // hashchange, so a keep-focus request would linger until some later navigation.
    const here = ctx.route.params;
    const same = Object.keys(p).length === Object.keys(here).length && Object.entries(p).every(([k, v]) => String(here[k]) === String(v));
    const nav = same ? '' : ` data-action="navigate" data-view="budget" data-params="${esc(JSON.stringify(p))}" data-keep-focus="1"`;
    return `<a${id ? ` id="${esc(id)}"` : ''} class="${esc(cls)}" href="${esc(ctx.href('budget', p))}"${nav}>${inner}</a>`;
  }

  function peopleOptions(ctx, { none = false } = {}) {
    const list = (ctx.state.plan.people || []).map(p => ({ value: p.id, label: p.name }));
    return none ? [{ value: '__null__', label: 'No one person' }, ...list] : list;
  }
  function fundingOptions(ctx) {
    return [
      { value: 'joint', label: 'Joint' },
      ...(ctx.state.plan.people || []).map(p => ({ value: p.id, label: p.name + ' (personal)' })),
      { value: 'unknown', label: 'Not confirmed' },
    ];
  }
  function fundingText(ctx, from) {
    if (from === 'joint') return 'joint';
    if (from === 'p1' || from === 'p2') return possessive(ctx.person(from)) + ' personal account';
    return 'an account not confirmed yet';
  }

  /**
   * Categories a target or bill can use: the taxonomy, categories of spending rows, targets and
   * bills. Leaves out names only used on transfers, income and payments ("Transfer", "Income"…),
   * which are never spending.
   */
  function spendCategories(ctx) {
    return ctx.memo('bud-spend-cats', () => {
      const set = new Set(E.categories.names());
      for (const t of ctx.txns) {
        if (t.kind !== 'spend') continue;
        if (t.category) set.add(t.category);
        for (const part of t.parts || []) if (part.category) set.add(part.category);
      }
      for (const k of Object.keys(ctx.state.plan.targets || {})) set.add(k);
      for (const b of ctx.state.plan.bills || []) if (b.category) set.add(b.category);
      return E.categories.sortNames([...set]);
    });
  }

  // ------------------------------------------------------------------ what each area still needs
  function sectionCounts(ctx, plan) {
    const counts = { income: 0, bills: 0, savings: 0, debts: 0 };
    for (const m of plan.missing) {
      const id = String(m.id || '');
      // Category targets are planned on the page itself (a blank one uses its history).
      if (id.startsWith('target:') || id.startsWith('personal:')) continue;
      const s = id.startsWith('pay:') ? 'income' : AREA_OF[m.area];
      if (s && s !== 'debts' && m.area !== 'balances') counts[s]++;
    }
    const bills = ctx.state.plan.bills;
    for (const d of ctx.state.plan.debts) {
      const bill = bills.find(b => b.id === d.paymentBillId);
      const housing = bill && (bill.type === 'housing' || bill.category === 'Mortgage');
      if (!E.money.isCents(d.balanceCents)) counts.debts++;
      else if (d.promo && (d.promo.balanceCents === null || !d.promo.expiresMonth)) counts.debts++;
      else if (housing && d.escrowIncluded !== true && d.escrowIncluded !== false) counts.debts++;
    }
    const text = { income: 'to fill', bills: 'to fill', savings: 'to fill', debts: 'to check' };
    return Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n ? n + ' ' + text[k] : '']));
  }

  // ------------------------------------------------------------------ income
  function countText(ctx, line) {
    const per = money(line.perPaycheckCents);
    const unit = line.kind === 'contribution' ? 'transfer' : 'paycheck';
    switch (line.basis) {
      case 'typical': return `${plural(line.count, unit)} × ${per}, a typical month`;
      case 'average': return `${per} × ${E.schedule.PER_YEAR[ctx.state.plan.incomes.find(s => s.id === line.id)?.frequency] || '?'} a year ÷ 12, the annual average`;
      case 'actual': return `${plural(line.count, unit)} × ${per} in ${fmt.monthLong(ctx.forecastStart)}${line.dates && line.dates.length ? ' (' + line.dates.map(fmt.date).join(', ') + ')' : ''}`;
      case 'assumed': return `${plural(line.count, unit)} × ${per}, assumed while the frequency is not known`;
      case 'none': return 'not active in this month';
      default: return '';
    }
  }

  function frequencyTable(ctx, s, amount, amountText) {
    if (!known(amount)) {
      return `<p class="fine">Enter ${s.kind === 'contribution' ? 'the transfer amount' : 'an amount'} to see what each frequency would mean in a month and over a year.</p>`;
    }
    const unit = s.kind === 'contribution' ? 'transfers' : 'paychecks';
    const rows = E.schedule.frequencyTable(amount);
    const current = s.frequency;
    const SHORT = { weekly: ['Weekly', 'weekly'], biweekly: ['Every two weeks', 'biweekly'], semimonthly: ['Twice a month', 'semimonthly'], monthly: ['Monthly', 'monthly'] };
    const table = c.table({
      caption: `What each frequency would mean for ${amountText}`,
      cls: 'bud-freq-table',
      columns: [
        { key: 'label', label: 'Frequency', html: r => `${esc(SHORT[r.frequency][0])}<small>${r.frequency !== 'weekly' && r.frequency !== 'monthly' ? esc(SHORT[r.frequency][1]) + ': ' : ''}${esc(r.perYear)} a year, ${r.extraChecksPerYear ? `<strong>${esc(r.extraChecksPerYear)} extra</strong>` : 'no extra'} ${esc(unit)}</small>${r.frequency === current ? c.badge('Your setting', s.frequencyStatus === 'confirmed' ? 'good' : 'info') : ''}` },
        { key: 'typ', label: 'Typical month', align: 'right', html: r => `${esc(money(r.typicalMonthCents))}<small>${esc(plural(r.typicalChecks, unit.slice(0, -1)))}</small>` },
        { key: 'high', label: 'Fullest month', align: 'right', html: r => (r.highMonthChecks ? `${esc(money(r.highMonthCents))}<small>${esc(r.highMonthChecks)} ${esc(unit)}</small>` : '<span class="muted">Same as typical</span>') },
        { key: 'avg', label: 'Average month', align: 'right', html: r => `${esc(money(r.averageMonthCents))}<small>annual ÷ 12</small>` },
        { key: 'year', label: 'A year', align: 'right', html: r => esc(money(r.annualCents)) },
      ],
      rows,
      rowAttrs: r => ({ class: r.frequency === current ? 'bud-freq-current' : null }),
    });
    const lead = current === 'unknown' || !E.schedule.FREQUENCIES.includes(current)
      ? `The frequency is not known yet, so the plan assumes ${plural(s.assumedPerMonthIfUnknown ?? 2, unit.slice(0, -1))} a month.`
      : s.frequencyStatus !== 'confirmed' ? `${E.schedule.LABELS[current]} is not confirmed yet.` : `${E.schedule.LABELS[current]} is confirmed.`;
    return `<p class="fine">${esc(lead)} A typical month and the fullest month count whole ${esc(unit)}. Extra ${esc(unit)} are the ones beyond ${s.kind === 'contribution' ? 'the usual number' : 'a typical month'} each year; the average month spreads them over the year.</p>${table}`;
  }

  function incomeCard(ctx, s, plan) {
    const isContribution = s.kind === 'contribution';
    const person = s.personId ? ctx.person(s.personId) : 'Household';
    const pathOf = f => `plan.incomes[id=${s.id}].${f}`;
    const msg = what => `${s.label}: ${what} saved.`;
    const net = E.money.isCents(s.netPerPaycheckCents) ? s.netPerPaycheckCents : null;
    const joint = E.money.isCents(s.jointPerPaycheckCents) ? s.jointPerPaycheckCents : null;
    const hasContribution = (ctx.state.plan.incomes || []).some(x => x.kind === 'contribution' && x.personId === s.personId && x.personId);

    // Amount fields
    const amountFields = isContribution
      ? moneyField({ id: fid('inc-joint', s.id), label: 'Amount per transfer into joint', path: pathOf('jointPerPaycheckCents'), cents: joint, message: msg('amount per transfer'), placeholder: 'Unknown',
        help: 'Blank means unknown, not $0.' })
      : moneyField({ id: fid('inc-gross', s.id), label: 'Gross pay per paycheck (optional)', path: pathOf('grossPerPaycheckCents'), cents: E.money.isCents(s.grossPerPaycheckCents) ? s.grossPerPaycheckCents : null, message: msg('gross pay'), placeholder: 'Not entered',
        help: 'From a pay stub, for reference only: the plan uses what reaches joint.' })
        + moneyField({ id: fid('inc-net', s.id), label: 'Take-home per paycheck', path: pathOf('netPerPaycheckCents'), cents: net, message: msg('take-home pay'), placeholder: 'Unknown',
        help: 'Full net pay, before any of it is split off. Blank means unknown.' })
        + moneyField({ id: fid('inc-joint', s.id), label: 'Amount reaching joint per paycheck', path: pathOf('jointPerPaycheckCents'), cents: joint, message: msg('amount reaching joint'), placeholder: 'Unknown',
          help: hasContribution ? `Blank is read as no direct deposit to joint: ${esc(possessive(person))} joint money comes through the transfer below.` : 'The part deposited straight into a joint account.' });

    // Personal allocation (paychecks only)
    let allocation = '';
    if (!isContribution && s.personId) {
      if (net !== null && joint !== null) {
        allocation = net >= joint
          ? `<p class="bud-alloc"><strong>${esc(money(net - joint))}</strong> per paycheck goes to ${esc(possessive(person))} personal account (take-home minus the amount reaching joint).</p>`
          : `<p class="bud-alloc tone-bad">The amount reaching joint is more than the take-home pay. Check both amounts.</p>`;
      } else if (net !== null && joint === null && hasContribution) {
        allocation = `<p class="bud-alloc">All ${esc(money(net))} per paycheck goes to ${esc(possessive(person))} personal account; ${esc(person)} moves money into joint by transfer.</p>`;
      } else {
        allocation = `<p class="bud-alloc muted">Personal allocation: unknown until both amounts are entered.</p>`;
      }
    }

    // Schedule
    const freq = s.frequency || 'unknown';
    const scheduleFields = [
      selectField({ id: fid('inc-freq', s.id), label: isContribution ? 'How often' : 'Pay frequency', path: pathOf('frequency'), value: freq, options: FREQ_OPTIONS, message: msg('frequency') }),
      selectField({ id: fid('inc-freq-status', s.id), label: 'Frequency is', path: pathOf('frequencyStatus'), value: s.frequencyStatus || 'unknown', options: FREQ_STATUS_OPTIONS, message: msg('frequency status') }),
    ];
    if (freq === 'weekly' || freq === 'biweekly') {
      scheduleFields.push(inputField({ id: fid('inc-anchor', s.id), label: isContribution ? 'One recent transfer date' : 'One recent payday', path: pathOf('anchorDate'), value: s.anchorDate || '', type: 'date', dataType: 'date', message: msg('payday'),
        help: 'Places paydays on the calendar, so months with an extra one are known.' }));
    } else if (freq === 'semimonthly') {
      const days = Array.isArray(s.semimonthlyDays) && s.semimonthlyDays.length === 2 ? s.semimonthlyDays : [15, 31];
      const dayOptions = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: i + 1 === 31 ? 'Last day' : String(i + 1) }));
      const a = fid('inc-day1', s.id), bId = fid('inc-day2', s.id);
      scheduleFields.push(`<fieldset class="bud-days field"><legend>${isContribution ? 'Transfer days' : 'Paydays'} each month</legend><div class="bud-days-row">
        ${['First', 'Second'].map((word, i) => { const id = i ? bId : a; return `<label class="sr-only" for="${esc(id)}">${word} day</label><select id="${esc(id)}" data-action="budget:set-days" data-stream="${esc(s.id)}" data-first="${esc(a)}" data-second="${esc(bId)}" aria-describedby="${esc(id)}-error">${dayOptions.map(o => `<option value="${o.value}"${o.value === days[i] ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`; }).join('<span aria-hidden="true">and</span>')}
        </div><p class="field-help">A weekend date moves to the Friday before.</p><p class="field-error" id="${esc(a)}-error" role="alert" hidden></p><p class="field-error" id="${esc(bId)}-error" role="alert" hidden></p></fieldset>`);
    } else if (freq === 'monthly') {
      scheduleFields.push(inputField({ id: fid('inc-mday', s.id), label: 'Day of the month', path: pathOf('monthlyDay'), value: s.monthlyDay ?? '', type: 'number', dataType: 'int', min: 1, max: 31, inputmode: 'numeric', message: msg('day of the month'), help: '31 means the last day.' }));
    } else {
      scheduleFields.push(selectField({ id: fid('inc-assumed', s.id), label: `${isContribution ? 'Transfers' : 'Paychecks'} a month to assume for now`, path: pathOf('assumedPerMonthIfUnknown'), value: s.assumedPerMonthIfUnknown ?? 2,
        options: [0, 1, 2, 3, 4, 5].map(n => ({ value: n, label: String(n) })), message: msg('assumed count'), help: 'Used only until the frequency is known, and listed as an assumption.' }));
    }

    // How this stream counts on the plan (joint accounts, the annual average month, as the Plan's dials)
    const line = plan.income.lines.find(l => l.id === s.id);
    const nc = plan.income.notCounted.find(n => n.id === s.id);
    let counts;
    if (nc) counts = `<p class="bud-counts"><strong>Not counted on the plan.</strong> ${esc(nc.reason)}</p>`;
    else if (line && line.cents === null) counts = '<p class="bud-counts tone-warn"><strong>Not counted:</strong> the amount reaching joint is not entered. It is left out of the plan, not counted as $0.</p>';
    else if (line) counts = `<p class="bud-counts"><strong>${esc(money(line.cents))} a month</strong> on the plan: ${esc(countText(ctx, line))}.${line.assumption ? ` <span class="tone-warn">${esc(line.assumption)}</span>` : ''}</p>`;
    else counts = '';

    // Frequency table: the amount that reaches joint (falls back to take-home pay)
    let tableAmount, tableText;
    if (isContribution) { tableAmount = joint ?? net; tableText = `${money(tableAmount)} per transfer into joint`; }
    else { tableAmount = joint ?? net; tableText = joint !== null ? `${money(joint)} per paycheck reaching joint` : `${money(net)} take-home per paycheck`; }
    const unconfirmed = freq === 'unknown' || s.frequencyStatus !== 'confirmed';
    const freqBlock = `<details class="disclosure bud-freq" id="${esc(fid('inc-freq-table', s.id))}"${unconfirmed ? ' open' : ''}>
      <summary>What each ${esc(isContribution ? 'transfer' : 'pay')} frequency would mean${known(tableAmount) ? ` for ${esc(tableText)}` : ''}</summary>
      <div class="disclosure-body">${frequencyTable(ctx, s, tableAmount, tableText)}</div></details>`;

    const more = c.disclosure('More about this income: name, person, start and end', `<div class="form-grid">
        ${inputField({ id: fid('inc-label', s.id), label: 'Name', path: pathOf('label'), value: s.label, maxlength: 80, message: 'Income name saved.' })}
        ${selectField({ id: fid('inc-person', s.id), label: 'Person', path: pathOf('personId'), value: s.personId ?? '__null__', options: peopleOptions(ctx, { none: true }), message: msg('person') })}
        ${selectField({ id: fid('inc-kind', s.id), label: 'Kind', path: pathOf('kind'), value: s.kind, options: KIND_OPTIONS, message: msg('kind') })}
        ${selectField({ id: fid('inc-status', s.id), label: 'How sure are these amounts?', path: pathOf('status'), value: s.status || 'unknown', options: INCOME_STATUS_OPTIONS, message: msg('status') })}
        ${inputField({ id: fid('inc-start', s.id), label: 'First month', path: pathOf('startMonth'), value: s.startMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: msg('first month'), help: 'Leave blank if it is already coming in.' })}
        ${inputField({ id: fid('inc-end', s.id), label: 'Last month', path: pathOf('endMonth'), value: s.endMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: msg('last month'), help: 'Leave blank if there is no end date.' })}
      </div>
      ${inputField({ id: fid('inc-note', s.id), label: 'Note', path: pathOf('note'), value: s.note || '', maxlength: 500, message: msg('note') })}
      <div class="bud-remove-row">${c.button('Remove this income', { action: 'budget:remove-item', variant: 'danger', cls: 'btn-small', data: { list: 'incomes', id: s.id, label: s.label, focus: 'bud-add-income-name' } })}</div>`,
    { cls: 'bud-more' });

    const contributionNote = isContribution
      ? `<p class="bud-contrib-note">${c.badge('Transfer', 'info')} Money moved from ${esc(possessive(person))} personal account into joint: money in on the plan.</p>`
      : '';

    return c.card(`${contributionNote}
      <div class="bud-grid-2">${amountFields}</div>
      ${allocation}
      <div class="bud-grid-3 bud-sched">${scheduleFields.join('')}</div>
      ${counts}
      ${freqBlock}
      ${more}`, {
      title: s.label, id: fid('inc-card', s.id), cls: 'bud-income-card', headingLevel: 3,
      subtitle: `${esc(person)} · ${esc(KIND_LABEL[s.kind] || s.kind)} ${c.certainty(s.status || 'unknown')}${s.note ? `<span class="bud-note">${esc(s.note)}</span>` : ''}`,
    });
  }

  function addIncomeCard(ctx) {
    return c.card(`<form class="bud-add-form" data-action="budget:add-income" aria-label="Add an income">
        <div class="field"><label for="bud-add-income-name">Name</label><input id="bud-add-income-name" name="label" maxlength="80" placeholder="e.g. Sam paycheck" aria-describedby="bud-add-income-name-error"><p class="field-error" id="bud-add-income-name-error" role="alert" hidden></p></div>
        <div class="field"><label for="bud-add-income-person">Person</label><select id="bud-add-income-person" name="personId">${peopleOptions(ctx, { none: true }).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="bud-add-income-kind">Kind</label><select id="bud-add-income-kind" name="kind">${KIND_OPTIONS.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div>
        <div class="bud-add-actions"><button class="btn btn-secondary" type="submit">Add income</button></div>
      </form><p class="fine">New income starts with unknown amounts and frequency; fill them in on its card.</p>`, { title: 'Add income', id: 'bud-add-income', headingLevel: 3 });
  }

  /** Each person's own money: the pay that does not reach joint, what it pays first, what is left. */
  function personalCard(ctx, plan) {
    const entries = plan.personal || [];
    if (!entries.length) return '';
    const body = entries.map(p => {
      const rows = [
        ['Personal share of pay', p.allocationCents === null ? 'Unknown' : money(p.allocationCents) + ' a month'],
        ['Bills paid personally', money(p.billsCents)],
        ['Transfers into joint', p.contributionsCents === null ? 'Unknown' : money(p.contributionsCents)],
        ['Left for personal spending', p.spendingCents === null ? 'Unknown' : money(p.spendingCents)],
      ];
      return `<div class="bud-person">
        <h4>${esc(p.name)}</h4>
        <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        ${p.shortfallCents > 0 ? c.notice({ tone: 'warn', body: esc(`Personal bills and transfers are ${money(p.shortfallCents)} more than the personal share of pay. Check whether other personal money covers this.`) }) : ''}
      </div>`;
    }).join('');
    return c.card(`<div class="bud-people">${body}</div>`, { title: 'Personal accounts', id: 'bud-personal', headingLevel: 3,
      subtitle: 'Pay that does not reach joint pays personal bills and transfers into joint first. It is not part of the joint plan.' });
  }

  function incomeArea(ctx, plan) {
    const streams = (ctx.state.plan.incomes || []).map(s => incomeCard(ctx, s, plan)).join('');
    return `<div class="stack">${streams || c.empty('No income entered yet.')}${personalCard(ctx, plan)}${addIncomeCard(ctx)}</div>`;
  }

  // ------------------------------------------------------------------ bills
  function billStatusBadge(b) {
    if (b.status === 'planned') return c.badge('Planned: not yet a bill', 'info');
    if (b.status === 'estimate') return c.badge('Estimate', 'warn');
    return c.badge('Existing bill', 'neutral');
  }

  /** The latest yearly payment of a category seen in the data (review.queues annualSpikes), or null. */
  function yearlyPayment(ctx, category, upTo) {
    let q;
    try { q = ctx.reviewQueues(); } catch (err) { return null; }
    const list = ((q && q.annualSpikes) || []).filter(x => x.category === category && (!upTo || x.month <= upTo));
    return list.length ? list.reduce((a, x) => (x.month > a.month ? x : a)) : null;
  }

  /**
   * Link to the transactions behind an actual amount. Bills compared here are joint-funded, so the
   * link opens the joint accounts and its total matches.
   */
  const spendHref = (ctx, params) => ctx.href('spending', { ...params, scope: 'joint' });

  /** Joint spending in a category in one month (split purchases by their parts; refunds count against it). */
  function categoryActual(ctx, month, category) {
    let cents = 0;
    for (const t of E.ledger.filter(ctx.realTxns || ctx.txns, { months: [month], scope: 'joint', category })) {
      if (t.kind !== 'spend') continue;
      for (const p of E.ledger.partsOf(t)) if (p.category === category) cents += p.spendCents;
    }
    return cents;
  }

  function billActual(ctx, b, month) {
    if (b.status === 'planned') return '<span class="muted">Not a bill yet, so there is nothing to compare.</span>';
    if (b.fundedFrom === 'p1' || b.fundedFrom === 'p2') {
      const imported = (ctx.dataset.accounts || []).some(a => a.scope === 'personal' && a.ownerId === b.fundedFrom);
      return `<span class="muted">Paid from ${esc(possessive(ctx.person(b.fundedFrom)))} personal account${imported ? '. Only joint accounts are compared here.' : ', which is not in the imported data.'}</span>`;
    }
    if (!month) return '<span class="muted">No complete month of data yet.</span>';
    if (b.fundedFrom === 'unknown') return '<span class="muted">Who pays is not confirmed, so it is not compared with the joint accounts yet.</span>';
    if (!b.category) {
      // Debt payments are not category spending: show the month's joint debt payments, labelled as a total.
      const s = E.ledger.summarize(E.ledger.filter(ctx.realTxns || ctx.txns, { months: [month], scope: 'joint' }));
      return `<span class="bud-k">All joint debt payments, ${esc(fmt.month(month))}</span> <a href="${esc(spendHref(ctx, { period: month, kind: 'debt' }))}">${esc(money(s.debtPaymentsCents))}</a>`;
    }
    const actual = categoryActual(ctx, month, b.category);
    const shared = (ctx.state.plan.bills || []).filter(x => x.category === b.category && x.fundedFrom === 'joint').length > 1;
    // A yearly bill reads $0 in most months: name the yearly payment so $0 is not misread.
    const yearly = yearlyPayment(ctx, b.category, month);
    const yearlyNote = yearly ? `<small class="bud-yearly">Paid once a year: <a href="${esc(spendHref(ctx, { period: yearly.month, cat: b.category }))}">${esc(money(yearly.totalCents))}</a> in ${esc(fmt.month(yearly.month))}, about ${esc(money(Math.round(yearly.totalCents / 12)))} a month.</small>` : '';
    return `<span class="bud-k">${esc(fmt.month(month))} actual${shared ? `, all of ${esc(b.category)}` : ''}</span> <a href="${esc(spendHref(ctx, { period: month, cat: b.category }))}">${esc(money(actual))}</a>${yearlyNote}`;
  }

  /** What the plan does with a bill (tl.bills), as a badge; '' when there is nothing to say. */
  function planBadge(tl, b) {
    const x = tl && Array.isArray(tl.bills) ? tl.bills.find(y => y.id === b.id) : null;
    if (!x) return '';
    const ch = x.changeId && tl.changes ? tl.changes.list.find(y => y.id === x.changeId) : null;
    switch (x.status) {
      case 'seen': return c.badge('In your spending', 'good');
      case 'added': return c.badge(ch && ch.startMonth ? `Added to the plan from ${fmt.month(ch.startMonth)}` : 'Added to the plan', 'info');
      case 'ends': return c.badge(ch && ch.startMonth ? `Leaves the plan from ${fmt.month(ch.startMonth)}` : 'Ends', 'info');
      case 'ended': return c.badge('Ended', 'neutral');
      case 'noAmount': return c.badge('Amount needed for the plan', 'warn');
      case 'noCategory': return c.badge('Needs a category for the plan', 'warn');
      case 'inBudget': return c.badge('Planned through its category', 'neutral');
      default: return '';
    }
  }

  function billItem(ctx, b, month, tl) {
    const pathOf = f => `plan.bills[id=${b.id}].${f}`;
    const msg = what => `${b.label}: ${what} saved.`;
    const cats = spendCategories(ctx);
    const catOptions = [{ value: '__null__', label: 'None (not compared with spending; for debt payments)' }, ...cats.map(n => ({ value: n, label: n }))];
    const debt = b.debtId ? ctx.state.plan.debts.find(d => d.id === b.debtId) : null;
    const meta = [BILL_TYPE_LABEL[b.type] || 'Other', b.category || null, b.endMonth ? 'Final payment ' + fmt.month(b.endMonth) : null].filter(Boolean).join(' · ');
    return `<li class="bud-bill" id="${esc(fid('bill', b.id))}">
      <div class="bud-bill-head"><h4 class="bud-item-title">${esc(b.label)}</h4><span class="bud-badges">${billStatusBadge(b)} ${planBadge(tl, b)}</span></div>
      <p class="bud-meta">${esc(meta)}${b.note ? ` · <span>${esc(b.note)}</span>` : ''}</p>
      <div class="bud-bill-grid">
        ${moneyField({ id: fid('bill-amt', b.id), label: 'Monthly amount', path: pathOf('monthlyCents'), cents: b.monthlyCents, message: msg('amount'), placeholder: 'Not entered' })}
        ${selectField({ id: fid('bill-from', b.id), label: 'Paid from', path: pathOf('fundedFrom'), value: b.fundedFrom, options: fundingOptions(ctx), message: msg('paying account') })}
        <div class="bud-bill-actual">${billActual(ctx, b, month)}</div>
      </div>
      <details class="disclosure bud-more" id="${esc(fid('bill-more', b.id))}"><summary>Details: name, category, status, final payment</summary><div class="disclosure-body">
        <div class="form-grid">
          ${inputField({ id: fid('bill-label', b.id), label: 'Name', path: pathOf('label'), value: b.label, maxlength: 80, message: 'Bill name saved.' })}
          ${selectField({ id: fid('bill-cat', b.id), label: 'Category', path: pathOf('category'), value: b.category ?? '__null__', options: catOptions, message: msg('category'), help: 'Links the bill to spending in that category.' })}
          ${selectField({ id: fid('bill-type', b.id), label: 'Type', path: pathOf('type'), value: b.type || 'other', options: BILL_TYPE_OPTIONS, message: msg('type') })}
          ${selectField({ id: fid('bill-status', b.id), label: 'Status', path: pathOf('status'), value: b.status || 'existing', options: BILL_STATUS_OPTIONS, message: msg('status'), help: 'Planned means not yet a bill (for example a policy being considered).' })}
          ${inputField({ id: fid('bill-start', b.id), label: 'First payment month', path: pathOf('startMonth'), value: b.startMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: msg('first month'), help: 'Leave blank if already paying.' })}
          ${inputField({ id: fid('bill-end', b.id), label: 'Final payment month', path: pathOf('endMonth'), value: b.endMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: msg('final payment month'), help: 'Leave blank if unknown.' })}
        </div>
        ${inputField({ id: fid('bill-note', b.id), label: 'Note', path: pathOf('note'), value: b.note || '', maxlength: 500, message: msg('note') })}
        ${debt ? `<p class="fine">Pays the debt ${sectionLink(ctx, 'debts', esc(debt.label), { params: { focus: fid('debt-card', debt.id) + '-h' } })}.</p>` : ''}
        <div class="bud-remove-row">${c.button('Remove this bill', { action: 'budget:remove-item', variant: 'danger', cls: 'btn-small', data: { list: 'bills', id: b.id, label: b.label, focus: 'bud-add-bill-name' } })}</div>
      </div></details>
    </li>`;
  }

  function billsArea(ctx, tl) {
    const bills = ctx.state.plan.bills || [];
    const people = ctx.state.plan.people || [];
    const month = tl ? tl.lastComplete : ctx.latestComplete;
    const groups = [
      { key: 'joint', title: 'Paid from joint', note: 'On the joint plan.' },
      ...people.map(p => ({ key: p.id, title: `Paid from ${possessive(p.name)} personal account`, note: `Paid from ${possessive(p.name)} own share of pay, outside the joint plan.` })),
      { key: 'unknown', title: 'Paying account not confirmed', note: 'Left out of the joint plan until you choose who pays.' },
    ];
    const total = list => E.money.sum(list.map(b => b.monthlyCents));
    const groupHtml = groups.map(g => {
      const list = bills.filter(b => (g.key === 'unknown' ? !['joint', ...people.map(p => p.id)].includes(b.fundedFrom) : b.fundedFrom === g.key));
      if (!list.length) return '';
      const unknownAmounts = list.filter(b => b.monthlyCents === null).length;
      return `<section class="bud-bill-group" aria-labelledby="${esc(fid('bill-group', g.key))}">
        <div class="bud-group-head"><h3 id="${esc(fid('bill-group', g.key))}">${esc(g.title)}</h3><span class="num bud-group-total">${esc(money(total(list)))} a month${unknownAmounts ? ` <span class="tone-warn">+ ${esc(plural(unknownAmounts, 'unknown amount'))}</span>` : ''}</span></div>
        <p class="fine">${esc(g.note)}</p>
        <ul class="bud-bill-list">${list.map(b => billItem(ctx, b, month, tl)).join('')}</ul>
      </section>`;
    }).join('');
    const cats = spendCategories(ctx);
    const addForm = `<form class="bud-add-form" data-action="budget:add-bill" aria-label="Add a bill">
        <div class="field"><label for="bud-add-bill-name">Name</label><input id="bud-add-bill-name" name="label" maxlength="80" placeholder="e.g. Car insurance" aria-describedby="bud-add-bill-name-error"><p class="field-error" id="bud-add-bill-name-error" role="alert" hidden></p></div>
        <div class="field"><label for="bud-add-bill-amount">Monthly amount</label><div class="input-money"><span aria-hidden="true">$</span><input id="bud-add-bill-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="Not entered" aria-describedby="bud-add-bill-amount-error"></div><p class="field-error" id="bud-add-bill-amount-error" role="alert" hidden></p></div>
        <div class="field"><label for="bud-add-bill-from">Paid from</label><select id="bud-add-bill-from" name="fundedFrom">${fundingOptions(ctx).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="bud-add-bill-type">Type</label><select id="bud-add-bill-type" name="type">${BILL_TYPE_OPTIONS.map(o => `<option value="${esc(o.value)}"${o.value === 'other' ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="bud-add-bill-cat">Category</label><select id="bud-add-bill-cat" name="category"><option value="__null__">None (for debt payments)</option>${cats.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></div>
        <div class="bud-add-actions"><button class="btn btn-secondary" type="submit">Add bill</button></div>
      </form>`;
    const intro = `<p class="fine">Fixed monthly costs, including loan and card payments. A blank amount is left out, never counted as $0.${month ? ` Actual amounts are from ${esc(fmt.monthLong(month))}, joint accounts.` : ''}</p>`;
    return `<div class="stack">
      <div id="bud-bills">${intro}${groupHtml || c.empty('No bills entered yet.')}</div>
      ${c.card(addForm, { title: 'Add a bill', id: 'bud-add-bill', headingLevel: 3 })}
    </div>`;
  }

  // ------------------------------------------------------------------ savings goals (the list)
  /** One goal's editor. `monthly`: show the monthly amount here too (only when there are no goal cards above). */
  function goalItem(ctx, g, view, monthly) {
    const pathOf = f => `plan.savings[id=${g.id}].${f}`;
    const msg = what => `${g.label}: ${what} saved.`;
    const status = !view ? c.badge('Not projected', 'neutral')
      : view.reach === 'reached' ? c.badge('Reached', 'good')
        : view.reach === 'month' ? c.badge(`On track for ${fmt.month(view.month)}`, 'good')
          : view.reach === 'beyond' ? c.badge('Not on this plan', 'warn') : c.badge('No target set', 'neutral');
    return `<li class="bud-goal" id="${esc(fid('goal', g.id))}">
      <div class="bud-bill-head"><h3 class="bud-item-title">${esc(g.label)}</h3><span class="bud-badges">${status} ${c.badge(g.spendAtTarget ? 'Spend at target' : 'Keep', 'neutral')}</span></div>
      ${g.note ? `<p class="bud-meta">${esc(g.note)}</p>` : ''}
      <div class="bud-goal-fields">
        ${moneyField({ id: fid('goal-target', g.id), label: 'Target amount', path: pathOf('targetCents'), cents: g.targetCents, message: msg('target'), placeholder: 'Not set' })}
        ${inputField({ id: fid('goal-month', g.id), label: 'Target month', path: pathOf('targetMonth'), value: g.targetMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: msg('target month'), help: 'Leave blank for no date.' })}
        ${moneyField({ id: fid('goal-saved', g.id), label: 'Saved so far', path: pathOf('savedCents'), cents: g.savedCents, message: msg('saved so far'), placeholder: 'Unknown', help: 'Blank means unknown, not $0.' })}
        ${monthly ? moneyField({ id: fid('goal-monthly', g.id), label: 'Monthly contribution', path: pathOf('monthlyCents'), cents: g.monthlyCents, message: msg('monthly amount'), placeholder: 'Not set' }) : ''}
        ${selectField({ id: fid('goal-spend', g.id), label: 'At the target', path: pathOf('spendAtTarget'), value: g.spendAtTarget ? 'true' : 'false', message: msg('spend or keep'),
          options: [{ value: 'true', label: 'Spend it (trip)' }, { value: 'false', label: 'Keep it (cushion)' }] })}
      </div>
      <details class="disclosure bud-more" id="${esc(fid('goal-more', g.id))}"><summary>Name, note and remove</summary><div class="disclosure-body">
        <div class="form-grid">${inputField({ id: fid('goal-label', g.id), label: 'Name', path: pathOf('label'), value: g.label, maxlength: 80, message: 'Goal name saved.' })}
        ${inputField({ id: fid('goal-note', g.id), label: 'Note', path: pathOf('note'), value: g.note || '', maxlength: 500, message: msg('note') })}</div>
        <div class="bud-remove-row">${c.button('Remove this goal', { action: 'budget:remove-item', variant: 'danger', cls: 'btn-small', data: { list: 'savings', id: g.id, label: g.label, focus: 'bud-add-goal-name' } })}</div>
      </div></details>
    </li>`;
  }

  function savingsArea(ctx, tl) {
    const st = ctx.state;
    const bal = st.plan.balances || {};
    // The same starting cash as the Overview: ctx.anchors() is what the timeline starts from.
    const anchored = ctx.anchors();
    const cash = anchored.accounts.length
      ? `<p class="fine" id="bud-cash-card">The plan starts from the account balances on the Overview: <strong>${esc(money(anchored.combined.cents))}</strong> as of ${esc(fmt.date(anchored.combined.asOf))}. <a href="${esc(ctx.href('overview'))}">Change them on the Overview</a>.</p>`
      : c.card(`<p class="fine">Bank exports do not include balances. Until you enter one, the plan shows how much joint cash goes up or down, not how much you will have.</p>
      <div class="bud-grid-2">
        ${moneyField({ id: 'bud-cash', label: 'Joint cash today', path: 'plan.balances.jointCashCents', cents: bal.jointCashCents ?? null, allowNegative: true, placeholder: 'Not entered', message: 'Joint cash balance saved.',
          help: 'Checking plus joint savings. A negative amount means overdrawn.' })}
        ${inputField({ id: 'bud-cash-asof', label: 'As of', path: 'plan.balances.asOf', value: bal.asOf || '', type: 'date', dataType: 'date', message: 'Balance date saved.', help: 'The date the balance was true.' })}
      </div>`, { title: 'Joint cash balance', id: 'bud-cash-card', headingLevel: 3 });
    const views = new Map((tl && Array.isArray(tl.goals) ? tl.goals : []).map(g => [g.id, B.goalView(g)]));
    const goals = st.plan.savings || [];
    const list = goals.length ? `<ul class="bud-goal-list">${goals.map(g => goalItem(ctx, g, views.get(g.id), !tl)).join('')}</ul>` : c.empty('No savings goals yet.');
    const addForm = `<form class="bud-add-form" data-action="budget:add-goal" aria-label="Add a savings goal">
        <div class="field"><label for="bud-add-goal-name">Name</label><input id="bud-add-goal-name" name="label" maxlength="80" placeholder="e.g. Baby fund" aria-describedby="bud-add-goal-name-error"><p class="field-error" id="bud-add-goal-name-error" role="alert" hidden></p></div>
        <div class="field"><label for="bud-add-goal-spend">At the target</label><select id="bud-add-goal-spend" name="spendAtTarget"><option value="false">Keep it (cushion)</option><option value="true">Spend it (trip)</option></select></div>
        <div class="bud-add-actions"><button class="btn btn-secondary" type="submit">Add goal</button></div>
      </form>`;
    return `<div class="stack">
      <div id="bud-goal-setup"><p class="fine"><strong>Spend at target</strong>: used in the target month, like a trip. <strong>Keep</strong>: stays saved, like a cushion.${tl ? ' Monthly amounts are on the goal cards above.' : ''}</p>${list}</div>
      ${cash}
      ${c.card(addForm, { title: 'Add a savings goal', id: 'bud-add-goal', headingLevel: 3 })}
    </div>`;
  }

  // ------------------------------------------------------------------ debts
  const FACT_BADGE = {
    confirmed: ['Confirmed', 'good'], statement: ['From statement', 'good'], approximate: ['Approximate', 'warn'],
    unknown: ['Unknown', 'bad'], displayed: ['As displayed', 'info'], estimate: ['Estimate', 'warn'], illustrative: ['Illustrative', 'warn'],
  };

  function promoBlock(ctx, d, bill) {
    const pathOf = f => `plan.debts[id=${d.id}].promo.${f}`;
    if (!d.promo) return '';
    const p = d.promo;
    const payment = bill && E.money.isCents(bill.monthlyCents) && bill.monthlyCents >= 0 ? bill.monthlyCents : null;
    let check;
    try {
      check = E.debt.promoCheck({ promoBalanceCents: E.money.isCents(p.balanceCents) ? p.balanceCents : null, expiresMonth: p.expiresMonth, paymentCents: payment, fromMonth: ctx.forecastStart, deferredInterest: p.deferredInterest });
    } catch (err) { check = null; }
    let result = '';
    if (check) {
      const notes = check.notes.slice();
      if (check.status === 'needs_info') {
        result = `<div class="bud-promo-result" id="${esc(fid('promo-result', d.id))}">${c.badge('Needs information', 'info')}
          <p>To check whether ${payment === null ? 'the payment' : esc(money(payment)) + ' a month'} clears the promotion in time, enter:</p>
          <ul>${check.missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
          <p class="fine">No judgement is made until then.</p>${notes.slice(1).map(n => `<p class="fine">${esc(n)}</p>`).join('')}</div>`;
      } else {
        const ok = check.status === 'on_track';
        result = `<div class="bud-promo-result" id="${esc(fid('promo-result', d.id))}">${c.badge(ok ? 'On track' : 'Short', ok ? 'good' : 'warn')}
          <dl class="kv"><dt>Needed each month to clear it by ${esc(fmt.month(p.expiresMonth))}</dt><dd>${esc(money(check.requiredMonthlyCents))}</dd>
          <dt>Current payment</dt><dd>${esc(money(payment))}</dd>
          <dt>Months from ${esc(fmt.month(ctx.forecastStart))}</dt><dd>${esc(check.monthsLeft)}</dd>
          ${ok ? '' : `<dt>Left on the promotion at the end</dt><dd class="tone-warn">About ${esc(money(check.projectedRemainingCents))}</dd>`}</dl>
          ${notes.map(n => `<p class="fine">${esc(n)}</p>`).join('')}</div>`;
      }
    }
    return `<div class="bud-promo"><h4>Promotional financing</h4>
      <div class="bud-grid-3">
        ${moneyField({ id: fid('promo-balance', d.id), label: 'Promotional balance', path: pathOf('balanceCents'), cents: p.balanceCents, placeholder: 'Unknown', message: `${d.label}: promotional balance saved.`, help: 'Only the part on the promotion; it may differ from the whole balance.' })}
        ${inputField({ id: fid('promo-end', d.id), label: 'Promotion ends', path: pathOf('expiresMonth'), value: p.expiresMonth || '', type: 'month', dataType: 'month', placeholder: 'YYYY-MM', message: `${d.label}: promotion end saved.`, help: 'The last month of the promotion.' })}
        ${selectField({ id: fid('promo-deferred', d.id), label: 'Deferred interest?', path: pathOf('deferredInterest'), value: boolValue(p.deferredInterest), options: YES_NO_OPTIONS, message: `${d.label}: deferred interest saved.`, help: 'Interest charged back to the purchase date if a balance remains.' })}
      </div>
      ${result}
      ${p.note ? `<p class="fine">${esc(p.note)}</p>` : ''}
      <button type="button" class="btn btn-ghost btn-small" id="${esc(fid('promo-remove', d.id))}" data-action="budget:remove-promo" data-debt="${esc(d.id)}">Remove promotional financing</button>
    </div>`;
  }

  function escrowBlock(ctx, d) {
    const insuranceBills = (ctx.state.plan.bills || []).filter(b => b.category === 'Home insurance' || /home insurance/i.test(b.label));
    const taxPlanned = (ctx.state.plan.bills || []).some(b => b.category === 'Property tax & HOA') || 'Property tax & HOA' in (ctx.state.plan.targets || {});
    let note;
    if (d.escrowIncluded === true) {
      note = insuranceBills.length
        ? `<p class="tone-warn">${esc(listText(insuranceBills.map(b => b.label)))} ${insuranceBills.length === 1 ? 'is' : 'are'} also a separate bill. If escrow already pays it, it is counted twice; remove the bill or confirm it is separate.</p>`
        : '<p class="fine">Property tax and home insurance are paid through the mortgage, so they need no separate budget lines.</p>';
    } else if (d.escrowIncluded === false) {
      note = `<p class="fine">Property tax and home insurance need their own budget lines.${taxPlanned ? '' : ' No property tax bill or target is set yet.'}</p>`;
    } else {
      note = '<p class="fine">Until this is known, property tax and home insurance may be budgeted twice or missed.</p>';
    }
    return `<div class="bud-escrow">
      ${selectField({ id: fid('debt-escrow', d.id), label: 'Does the payment include property tax and home insurance (escrow)?', path: `plan.debts[id=${d.id}].escrowIncluded`, value: boolValue(d.escrowIncluded), options: YES_NO_OPTIONS, message: `${d.label}: escrow answer saved.` })}
      ${note}</div>`;
  }

  function illustration(d, bill) {
    const rate = isNum(d.aprPct) ? d.aprPct : null;
    const range = Array.isArray(d.aprRange) && d.aprRange.length === 2 && d.aprRange.every(isNum) ? d.aprRange : null;
    if (rate === null && !range) return '';
    const balance = E.money.isCents(d.balanceCents) ? d.balanceCents : null;
    const payment = bill && E.money.isCents(bill.monthlyCents) ? bill.monthlyCents : null;
    let body;
    try {
      if (rate !== null) {
        const r = E.debt.amortize({ balanceCents: balance, aprPct: rate, paymentCents: payment });
        body = `<p>${esc(r.note)}</p>${r.months !== null ? `<dl class="kv"><dt>Months, if nothing changes</dt><dd>About ${esc(r.months)}</dd><dt>Interest over that time</dt><dd>About ${esc(money(r.interestCents))}</dd></dl>` : ''}`;
      } else {
        const r = E.debt.illustrativeRange({ balanceCents: balance, paymentCents: payment, aprMin: range[0], aprMax: range[1] });
        body = `<p>${esc(r.note)}</p>`;
      }
    } catch (err) { body = `<p>${esc(err.message)}</p>`; }
    const status = d.aprStatus === 'confirmed' ? 'confirmed' : 'as displayed, not confirmed';
    return `<details class="disclosure bud-illus" id="${esc(fid('debt-illus', d.id))}"><summary>Illustrative only: what the ${rate !== null ? 'rate' : 'rate range'} would mean</summary><div class="disclosure-body">
      ${body}
      <p class="fine">Assumes ${rate !== null ? `the ${esc(rate)}% rate (${esc(status)})` : `the ${esc(range[0])}%–${esc(range[1])}% range (${esc(status)}) applied to the whole balance as one loan`}, the same payment every month, interest added monthly and no new charges or fees. It is not a payoff date: the real terms may differ.</p>
    </div></details>`;
  }

  function debtCard(ctx, d) {
    const bills = ctx.state.plan.bills || [];
    const bill = d.paymentBillId ? bills.find(b => b.id === d.paymentBillId) || null : null;
    const pathOf = f => `plan.debts[id=${d.id}].${f}`;
    const msg = what => `${d.label}: ${what} saved.`;
    let sum = null;
    try { sum = E.debt.summary(d, bill, { month: ctx.forecastStart, people: ctx.people }); } catch (err) { sum = null; }
    const housing = !!(bill && (bill.type === 'housing' || bill.category === 'Mortgage')) || /mortgage|home loan/i.test(d.label || '');

    const facts = (sum ? sum.lines : []).filter(l => !['promo', 'escrow', 'paymentsLeft'].includes(l.key)).map(l => {
      let value = l.value;
      let b = FACT_BADGE[l.status];
      if (l.key === 'payment' && bill && E.money.isCents(bill.monthlyCents)) {
        value = `${money(bill.monthlyCents)} a month, paid from ${fundingText(ctx, bill.fundedFrom)}`;
        // The status is about the amount; who pays is said in the text (and may be unconfirmed).
        if (b) b = [l.status === 'confirmed' ? 'Amount confirmed' : 'Amount: ' + b[0].toLowerCase(), b[1]];
      }
      // The badge already says how sure the figure is; drop the same words in brackets.
      if (b) value = String(value).replace(/\s*\((approximate|statement balance|confirmed)\)$/i, '');
      return `<dt>${esc(l.label)}</dt><dd>${esc(value)}${b ? ` ${c.badge(b[0], b[1])}` : ''}</dd>`;
    }).join('');
    const lb = sum ? sum.lowerBound : null;
    const floor = lb && lb.months !== null
      ? `<p class="bud-floor"><strong>At least ${esc(plural(lb.months, 'more payment'))} at 0% interest.</strong> A floor, not a payoff date: any interest makes it longer.</p>`
      : lb ? `<p class="fine">${esc(lb.note)}</p>` : '';
    const warnings = sum ? sum.warnings.filter(w => !/^Promotion:|^Escrow unknown/.test(w)) : [];

    const billOptions = [{ value: '__null__', label: 'No payment linked' }, ...bills.map(b => ({ value: b.id, label: `${b.label} (${b.monthlyCents === null ? 'amount not entered' : money(b.monthlyCents)})` }))];
    const rangeMin = fid('debt-apr-min', d.id), rangeMax = fid('debt-apr-max', d.id);
    const range = Array.isArray(d.aprRange) ? d.aprRange : [null, null];
    const details = `<details class="disclosure bud-more" id="${esc(fid('debt-more', d.id))}"><summary>Update balance, rate and terms</summary><div class="disclosure-body">
      <div class="form-grid">
        ${moneyField({ id: fid('debt-balance', d.id), label: 'Balance', path: pathOf('balanceCents'), cents: d.balanceCents, placeholder: 'Unknown', message: msg('balance') })}
        ${selectField({ id: fid('debt-balance-status', d.id), label: 'Balance is', path: pathOf('balanceStatus'), value: d.balanceStatus || 'unknown', options: BALANCE_STATUS_OPTIONS, message: msg('balance status') })}
        ${inputField({ id: fid('debt-asof', d.id), label: 'Balance as of', path: pathOf('balanceAsOf'), value: d.balanceAsOf || '', type: 'date', dataType: 'date', message: msg('balance date') })}
        ${selectField({ id: fid('debt-bill', d.id), label: 'Monthly payment', value: d.paymentBillId ?? '__null__', options: billOptions, action: 'budget:link-payment', data: { debt: d.id }, help: 'The bill that pays this debt. Amounts are edited in Bills.' })}
        ${selectField({ id: fid('debt-apr-status', d.id), label: 'Interest rate is', path: pathOf('aprStatus'), value: d.aprStatus || 'unknown', options: APR_STATUS_OPTIONS, message: msg('rate status') })}
        ${inputField({ id: fid('debt-apr', d.id), label: 'Interest rate (APR %)', path: pathOf('aprPct'), value: isNum(d.aprPct) ? d.aprPct : '', type: 'text', dataType: 'number', inputmode: 'decimal', placeholder: 'Unknown', message: msg('rate'), help: 'One rate. Leave blank if unknown.' })}
        <fieldset class="field bud-range"><legend>Or a range shown by the lender (%)</legend><div class="bud-days-row">
          <label class="sr-only" for="${esc(rangeMin)}">Lowest rate</label><input id="${esc(rangeMin)}" type="text" inputmode="decimal" placeholder="Lowest" value="${esc(range[0] ?? '')}" data-action="budget:set-apr-range" data-debt="${esc(d.id)}" data-min="${esc(rangeMin)}" data-max="${esc(rangeMax)}" aria-describedby="${esc(rangeMin)}-error">
          <span aria-hidden="true">to</span>
          <label class="sr-only" for="${esc(rangeMax)}">Highest rate</label><input id="${esc(rangeMax)}" type="text" inputmode="decimal" placeholder="Highest" value="${esc(range[1] ?? '')}" data-action="budget:set-apr-range" data-debt="${esc(d.id)}" data-min="${esc(rangeMin)}" data-max="${esc(rangeMax)}" aria-describedby="${esc(rangeMax)}-error">
        </div><p class="field-help">For several loans with different rates.</p><p class="field-error" id="${esc(rangeMin)}-error" role="alert" hidden></p><p class="field-error" id="${esc(rangeMax)}-error" role="alert" hidden></p></fieldset>
        ${inputField({ id: fid('debt-loans', d.id), label: 'Number of loans', path: pathOf('loanCount'), value: d.loanCount ?? '', type: 'number', dataType: 'int', min: 1, max: 100, inputmode: 'numeric', message: msg('number of loans') })}
        ${inputField({ id: fid('debt-plan', d.id), label: 'Repayment plan', path: pathOf('repaymentPlan'), value: d.repaymentPlan || '', maxlength: 80, placeholder: 'Unknown', message: msg('repayment plan'), help: 'As named by the lender.' })}
        ${selectField({ id: fid('debt-terms', d.id), label: 'Remaining term and schedule', path: pathOf('termStatus'), value: d.termStatus || 'unknown', options: TERM_STATUS_OPTIONS, message: msg('terms status') })}
        ${selectField({ id: fid('debt-owner', d.id), label: 'Whose debt', path: pathOf('ownerId'), value: d.ownerId || 'joint', options: [{ value: 'joint', label: 'Joint' }, ...peopleOptions(ctx)], message: msg('owner') })}
        ${inputField({ id: fid('debt-label', d.id), label: 'Name', path: pathOf('label'), value: d.label, maxlength: 80, message: 'Debt name saved.' })}
      </div>
      ${inputField({ id: fid('debt-note', d.id), label: 'Note', path: pathOf('note'), value: d.note || '', maxlength: 500, message: msg('note') })}
      ${d.promo ? '' : `<div class="bud-promo-add"><p class="fine">Is part of this balance on a promotional plan, such as 0% until a date? Add it to check the payment against the end date.</p>
        <button type="button" class="btn btn-secondary btn-small" id="${esc(fid('promo-add', d.id))}" data-action="budget:add-promo" data-debt="${esc(d.id)}">Add promotional financing</button></div>`}
      <div class="bud-remove-row">${c.button('Remove this debt', { action: 'budget:remove-item', variant: 'danger', cls: 'btn-small', data: { list: 'debts', id: d.id, label: d.label, focus: 'bud-add-debt-name' } })}</div>
    </div></details>`;

    const owner = d.ownerId === 'joint' || !d.ownerId ? 'Joint' : ctx.person(d.ownerId);
    const body = `${d.note ? `<p class="bud-meta">${esc(d.note)}</p>` : ''}
      <dl class="bud-facts">${facts}</dl>
      ${floor}
      ${warnings.length ? `<div class="bud-tocheck"><h4>Still to confirm</h4><ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      ${housing ? escrowBlock(ctx, d) : ''}
      ${promoBlock(ctx, d, bill)}
      ${illustration(d, bill)}
      ${details}`;
    return c.card(body, { title: d.label, id: fid('debt-card', d.id), cls: 'bud-debt-card', headingLevel: 3, subtitle: `${esc(owner)}${bill ? ` · paid by the bill ${sectionLink(ctx, 'bills', esc(bill.label), { params: { focus: fid('bill-amt', bill.id) } })}` : ' · no payment linked'}` });
  }

  function debtsArea(ctx) {
    const debts = ctx.state.plan.debts || [];
    const addForm = `<form class="bud-add-form" data-action="budget:add-debt" aria-label="Add a debt">
        <div class="field"><label for="bud-add-debt-name">Name</label><input id="bud-add-debt-name" name="label" maxlength="80" placeholder="e.g. Furniture financing" aria-describedby="bud-add-debt-name-error"><p class="field-error" id="bud-add-debt-name-error" role="alert" hidden></p></div>
        <div class="field"><label for="bud-add-debt-owner">Whose debt</label><select id="bud-add-debt-owner" name="ownerId"><option value="joint">Joint</option>${peopleOptions(ctx).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div>
        <div class="bud-add-actions"><button class="btn btn-secondary" type="submit">Add debt</button></div>
      </form><p class="fine">Add the monthly payment as a bill of type Debt payment, then link it on the debt.</p>`;
    const intro = '<p class="fine">Facts, not forecasts: payments are planned in Bills; here is what is known about each balance. No payoff date is estimated without confirmed terms; anything worked out from an entered rate is marked illustrative.</p>';
    return `<div class="stack">${intro}${debts.map(d => debtCard(ctx, d)).join('') || c.empty('No debts recorded.')}${c.card(addForm, { title: 'Add a debt', id: 'bud-add-debt', headingLevel: 3 })}</div>`;
  }

  // ------------------------------------------------------------------ the setup details card
  const AREA_TITLE = { income: 'Pay & income', bills: 'Bills', debts: 'Debts', savings: 'Savings goals' };

  /** A one-line summary of an area for its disclosure: count and monthly total. */
  function areaLine(ctx, key, plan) {
    const p = ctx.state.plan;
    if (key === 'income') {
      const n = (p.incomes || []).length;
      return n ? `${plural(n, 'source')} · ${whole(plan.income.totalCents ?? plan.income.lowerBoundCents ?? 0)} a month to joint` : 'None yet';
    }
    if (key === 'bills') {
      const joint = (p.bills || []).filter(b => b.fundedFrom === 'joint');
      return (p.bills || []).length ? `${plural((p.bills || []).length, 'bill')} · ${whole(E.money.sum(joint.map(b => b.monthlyCents)))} a month from joint` : 'None yet';
    }
    if (key === 'debts') {
      const n = (p.debts || []).length;
      const known = (p.debts || []).filter(d => E.money.isCents(d.balanceCents));
      return n ? `${plural(n, 'debt')}${known.length ? ` · ${whole(E.money.sum(known.map(d => d.balanceCents)))} owed${known.length < n ? ' (known)' : ''}` : ''}` : 'None recorded';
    }
    const goals = p.savings || [];
    return goals.length ? `${plural(goals.length, 'goal')} · ${whole(E.money.sum(goals.map(g => g.monthlyCents)))} a month` : 'None yet';
  }

  function setupDetails(ctx, tl) {
    const month = tl ? tl.planStart : ctx.forecastStart;
    let plan;
    try { plan = ctx.plan({ scope: 'joint', timing: 'average', month }); } catch (err) {
      return c.card(c.notice({ tone: 'bad', title: 'The setup could not be read.', body: esc(err.message) }), { title: 'Setup details', id: 'bud-setup' });
    }
    const counts = sectionCounts(ctx, plan);
    const bodies = { income: () => incomeArea(ctx, plan), bills: () => billsArea(ctx, tl), debts: () => debtsArea(ctx), savings: () => savingsArea(ctx, tl) };
    const open = AREAS.includes(ctx.route.params.section) ? ctx.route.params.section : null;
    const areas = AREAS.map(key => `<details class="bud-area" id="bud-area-${key}"${open === key ? ' open' : ''}>
        <summary class="bud-area-summary"><span class="bud-area-title">${esc(AREA_TITLE[key])}</span> <span class="bud-area-line">${esc(areaLine(ctx, key, plan))}</span>${counts[key] ? ` <span class="bud-area-count">${esc(counts[key])}</span>` : ''}</summary>
        <div class="bud-area-body" id="bud-section-${key}">${bodies[key]()}</div>
      </details>`).join('');
    return `<section class="card bud-setup" id="bud-setup" aria-labelledby="bud-setup-h">
      <div class="card-head"><div><h2 id="bud-setup-h">Pay, bills and debts</h2><p class="card-sub">What the plan is built from.</p></div></div>
      <div class="bud-areas">${areas}</div>
    </section>`;
  }


  // ------------------------------------------------------------------ actions
  function readAmount(form, name, errorId) {
    const raw = String(new FormData(form).get(name) || '');
    try {
      const cents = E.money.inputToCents(raw);
      setError(errorId, null);
      return { ok: true, cents };
    } catch (err) {
      setError(errorId, err.message);
      return { ok: false };
    }
  }
  function readLabel(form, id) {
    const v = String(new FormData(form).get('label') || '').trim();
    if (!v) { setError(id, 'Enter a name.'); document.getElementById(id)?.focus(); return null; }
    setError(id, null);
    return v;
  }
  const lastId = (state, list) => { const items = state.plan[list] || []; return items.length ? items[items.length - 1].id : null; };
  // Forms act on submit only (app.js already ignores clicks inside a form; this keeps it true if a
  // form action is ever run another way).
  const onSubmit = fn => (ctx, form, ev) => (ev && ev.type === 'submit' ? fn(ctx, form, ev) : undefined);


  const actions = {
    'budget:remove-item': (ctx, el) => {
      const { list, id, label, focus } = el.dataset;
      ctx.app.update(st => E.state.removeItem(st, list, id), { message: `Removed “${label}”.` });
      if (focus) focusAfterRender(focus);
    },

    'budget:add-income': onSubmit((ctx, form) => {
      const label = readLabel(form, 'bud-add-income-name');
      if (!label) return;
      const data = new FormData(form);
      const personId = data.get('personId') === '__null__' ? null : String(data.get('personId'));
      const kind = String(data.get('kind') || 'paycheck');
      ctx.app.update(st => E.state.addItem(st, 'incomes', { label, personId, kind, frequency: 'unknown', frequencyStatus: 'unknown', status: 'unknown' }), { message: `Added “${label}”. Its amounts start as unknown.` });
      const id = lastId(ctx.app.state, 'incomes');
      if (id) focusAfterRender(fid(kind === 'contribution' ? 'inc-joint' : 'inc-net', id));
    }),

    'budget:add-bill': onSubmit((ctx, form) => {
      const label = readLabel(form, 'bud-add-bill-name');
      if (!label) return;
      const amt = readAmount(form, 'amount', 'bud-add-bill-amount');
      if (!amt.ok) { document.getElementById('bud-add-bill-amount')?.focus(); return; }
      const data = new FormData(form);
      const category = data.get('category') === '__null__' ? null : String(data.get('category'));
      ctx.app.update(st => E.state.addItem(st, 'bills', { label, monthlyCents: amt.cents, fundedFrom: String(data.get('fundedFrom') || 'unknown'), type: String(data.get('type') || 'other'), category, status: 'existing' }),
        { message: `Added the bill “${label}”${amt.cents === null ? ' (amount not entered)' : ' at ' + money(amt.cents) + ' a month'}.` });
      const id = lastId(ctx.app.state, 'bills');
      if (id) focusAfterRender(fid('bill-amt', id));
    }),

    'budget:add-goal': onSubmit((ctx, form) => {
      const label = readLabel(form, 'bud-add-goal-name');
      if (!label) return;
      const spendAtTarget = new FormData(form).get('spendAtTarget') === 'true';
      ctx.app.update(st => E.state.addItem(st, 'savings', { label, spendAtTarget }), { message: `Added the goal “${label}”.` });
      const id = lastId(ctx.app.state, 'savings');
      if (id) focusAfterRender(fid('goal-target', id));
    }),

    'budget:add-debt': onSubmit((ctx, form) => {
      const label = readLabel(form, 'bud-add-debt-name');
      if (!label) return;
      const ownerId = String(new FormData(form).get('ownerId') || 'joint');
      ctx.app.update(st => E.state.addItem(st, 'debts', { label, ownerId, balanceStatus: 'unknown', aprStatus: 'unknown', termStatus: 'unknown' }), { message: `Added the debt “${label}”.` });
      const id = lastId(ctx.app.state, 'debts');
      if (id) setTimeout(() => { const d = document.getElementById(fid('debt-more', id)); if (d) d.open = true; focusAfterRender(fid('debt-balance', id)); }, 0);
    }),

    'budget:set-days': (ctx, el) => {
      const a = document.getElementById(el.dataset.first), b = document.getElementById(el.dataset.second);
      const days = [Number(a.value), Number(b.value)];
      if (days[0] === days[1]) { setError(el.id, 'Choose two different days.'); return; }
      setError(el.dataset.first, null); setError(el.dataset.second, null);
      ctx.app.update(st => E.state.setPath(st, `plan.incomes[id=${el.dataset.stream}].semimonthlyDays`, days), { message: 'Paydays saved.' });
    },

    'budget:link-payment': (ctx, el) => {
      const debtId = el.dataset.debt;
      const billId = el.value === '__null__' ? null : el.value;
      ctx.app.update(st => {
        let s = E.state.setPath(st, `plan.debts[id=${debtId}].paymentBillId`, billId);
        // Keep both sides linked one-to-one: the chosen bill points at this debt only.
        for (const b of s.plan.bills) if (b.debtId === debtId && b.id !== billId) s = E.state.setPath(s, `plan.bills[id=${b.id}].debtId`, null);
        for (const d of s.plan.debts) if (d.id !== debtId && billId && d.paymentBillId === billId) s = E.state.setPath(s, `plan.debts[id=${d.id}].paymentBillId`, null);
        if (billId) s = E.state.setPath(s, `plan.bills[id=${billId}].debtId`, debtId);
        return s;
      }, { message: billId ? 'Payment linked.' : 'Payment unlinked.' });
    },

    'budget:set-apr-range': (ctx, el) => {
      const minEl = document.getElementById(el.dataset.min), maxEl = document.getElementById(el.dataset.max);
      const parse = input => {
        const raw = input.value.trim().replace(/%$/, '');
        if (raw === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 && n <= 100 ? n : NaN;
      };
      const lo = parse(minEl), hi = parse(maxEl);
      setError(minEl.id, null); setError(maxEl.id, null);
      if (Number.isNaN(lo)) { setError(minEl.id, 'Enter a rate from 0 to 100.'); return; }
      if (Number.isNaN(hi)) { setError(maxEl.id, 'Enter a rate from 0 to 100.'); return; }
      if ((lo === null) !== (hi === null)) {
        // Wait for the other half; a range needs both ends.
        if (el === minEl && hi === null) return;
        if (el === maxEl && lo === null) { setError(minEl.id, 'Enter the lowest rate too, or clear both.'); return; }
        setError(hi === null ? maxEl.id : minEl.id, 'Enter both ends of the range, or clear both.');
        return;
      }
      const value = lo === null ? null : [Math.min(lo, hi), Math.max(lo, hi)];
      ctx.app.update(st => E.state.setPath(st, `plan.debts[id=${el.dataset.debt}].aprRange`, value), { message: value ? 'Rate range saved.' : 'Rate range cleared.' });
    },

    'budget:add-promo': (ctx, el) => {
      const id = el.dataset.debt;
      ctx.app.update(st => E.state.setPath(st, `plan.debts[id=${id}].promo.balanceCents`, null), { message: 'Promotional financing added. Enter its balance and end month.' });
      focusAfterRender(fid('promo-balance', id));
    },

    'budget:remove-promo': (ctx, el) => {
      const id = el.dataset.debt;
      ctx.app.update(st => E.state.setPath(st, `plan.debts[id=${id}].promo`, null), { message: 'Promotional financing removed.' });
      setTimeout(() => { const d = document.getElementById(fid('debt-more', id)); if (d) d.open = true; focusAfterRender(fid('promo-add', id)); }, 0);
    },
  };

  Object.assign(B, { AREAS, AREA_OF, setupDetails, setupActions: actions, sectionLink });
})(typeof globalThis !== 'undefined' ? globalThis : this);
