'use strict';
/*
 * Baby-cost defaults (docs/ARCHITECTURE.md, BudgetEngine.babyDefaults): the household asked for
 * the baby's costs to be planned for them, as editable estimates, without entering them by hand.
 *
 * Three planned changes in ONE baby group (the canonical group), each labelled an estimate:
 *   setup      $2,000 once, in the month before the birth month
 *   supplies   $450 a month from the birth month (feeding, diapers and wipes, clothing, care, toys,
 *              a contingency: the split is in its note only)
 *   childcare  $1,800 a month from 6 weeks after the birth (an early, full-package planning
 *              allowance, not a booking or a confirmed rate), plus a $150 yearly membership fee in
 *              the first care month and every 12 months after (yearlyCents on the same change; only
 *              while the monthly amount is above $0: an explicit $0 means no care, so no fee)
 * Medical costs, insurance-premium changes and parental-leave pay stay unknown: one caveat line
 * (CAVEAT), never $0. Leave lowers income (not a cost); a savings reserve is a transfer.
 *
 * Timing: plan.settings.babyDueDate ('YYYY-MM-DD') gives day precision: setup in the month before
 * the birth month, supplies from the birth month, childcare from the month holding the date + 42
 * days. Without it, a copied baby what-if group's birth month (its earliest monthly item) gives a
 * month-level estimate, flagged precision 'month': childcare two months after the birth month.
 * With neither, the timing is unknown: nothing is written; status() lists the defaults as "date
 * needed", and the date is asked for in Budget's setup details only.
 *
 * One canonical path: the group is the copied what-if group (ids 'sc-…', copied from a saved
 * scenario, its name or labels about a baby or birth) when there is one, else a new group 'New
 * baby'. In a copied group an untouched placeholder of a default's kind (no amount; start month
 * still the one the copy gave it, or the group's birth month) is filled and timed instead of
 * adding a row; a default with no placeholder is added (ids baby-default-<role>); a role the
 * household already covers (an accepted item of that kind with an amount, in the group or, about a
 * child, anywhere in the plan: their own 'Daycare' row with no what-if) gets nothing. The
 * defaults are accepted (the household's instruction covers these only). Each change made or
 * filled carries `derived` (what was written), so "untouched" is provable: when the timing moves,
 * only start months still equal to derived.startMonth move with it. meta.babyDefaults.done names
 * the defaults already made, so one the household removed is not made again. Explicit zeros,
 * dates the household set, alternatives left unaccepted and inclusion choices are never changed.
 * Counting a cost twice is prevented when the plan is built (guard): an accepted New baby,
 * Childcare or Kid costs pack, or the household's own accepted item of the same kind (in the group
 * or elsewhere), holds the default back in the months it runs (a monthly default resumes when the
 * covering items end) and is reported in tl.changes.overlaps.
 *
 * Pure and idempotent (a second run changes nothing); no clock ({ now } is passed in).
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isCents = v => Number.isSafeInteger(v);
  const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

  const ROLES = ['setup', 'supplies', 'childcare'];
  const GROUP_NAME = 'New baby';
  const ID_PREFIX = 'baby-default-';
  const ESTIMATE = 'A planning estimate, not a quote: change it to your own figures.';
  /** Weeks from the birth to the first childcare month (day precision), and months at month level. */
  const CARE_AFTER_DAYS = 42;
  const CARE_AFTER_MONTHS = 2;
  const CAVEAT = 'Not included yet: medical costs, insurance premium changes and parental-leave pay are unknown, not $0.';

  /** The defaults, one per role. from: months from the birth month (childcare: see careMonth). */
  const DEFAULTS = Object.freeze({
    setup: Object.freeze({ role: 'setup', id: ID_PREFIX + 'setup', label: 'Baby setup (estimate)', kind: 'oneTime', group: 'irregular', cents: 200000, from: -1,
      note: 'Car seat, stroller, crib and the first basics, once, in the month before the birth. ' + ESTIMATE }),
    supplies: Object.freeze({ role: 'supplies', id: ID_PREFIX + 'supplies', label: 'Baby supplies (estimate)', kind: 'monthly', group: 'essentials', cents: 45000, from: 0,
      note: 'A month from the birth: feeding $200, diapers and wipes $100, clothing $50, care $35, toys $25 and a $40 contingency. ' + ESTIMATE }),
    childcare: Object.freeze({ role: 'childcare', id: ID_PREFIX + 'childcare', label: 'Childcare (estimate)', kind: 'monthly', group: 'essentials', cents: 180000, yearlyCents: 15000, from: null,
      note: 'An early, full-package planning allowance from 6 weeks after the birth: not a booking, a confirmed return-to-work date or a confirmed rate. Lower it for part-time care. ' + ESTIMATE }),
  });
  /** The words that say which default a group's item is (its label). */
  const ROLE_WORDS = [
    ['childcare', /child\s*-?\s*care|day\s*-?\s*care|nanny|preschool/i],
    ['supplies', /suppl|diaper|wipes|formula/i],
    ['setup', /set\s*-?\s*up|gear|crib|stroller|car seat/i],
  ];
  const BABY_RE = /\b(baby|babies|birth|newborn)\b/i;
  /** Outside the baby group, a supplies or setup label must be about a child too ("Office supplies" is not). */
  const CHILD_RE = /\b(baby|babies|newborn|infant|toddler|kids?|child|children|nursery)\b|diaper|wipes|formula|crib|stroller|car seat/i;
  /** The packs (templates) that cover a default's costs too, in the months their items run. */
  const PACK_ROLES = Object.freeze({ babyFirstYear: ['setup', 'supplies'], childcare: ['childcare'], kidCosts: ['supplies'] });

  /** Which default a change is about, from its label ('setup'|'supplies'|'childcare'|null). Spending only. */
  function roleOf(c) {
    if (!isObj(c) || c.group === 'income' || c.group === 'savings') return null;
    const label = typeof c.label === 'string' ? c.label : '';
    const hit = ROLE_WORDS.find(([, re]) => re.test(label));
    return hit ? hit[0] : null;
  }
  const derivedRole = c => (isObj(c) && isObj(c.derived) && ROLES.includes(c.derived.role) ? c.derived.role : null);
  /**
   * One of the household's own items is about `role` (roleOf), in the defaults' group `name` or,
   * about a child, anywhere: childcare words are; supplies and setup words need a child word too.
   */
  const ownOf = (c, role, name) => roleOf(c) === role && (c.scenario === name || role === 'childcare' || CHILD_RE.test(String(c.label || '')));
  const isCopied = c => isObj(c) && typeof c.id === 'string' && c.id.startsWith('sc-');
  const monthsOf = d => d.slice(0, 7);
  const monthText = m => E.months.label(m);

  // ------------------------------------------------------------------ reading the budget

  /**
   * The canonical baby group's name: the group already holding a default, else a copied what-if
   * group (ids 'sc-…') whose name or one of whose labels is about a baby or a birth, else null.
   */
  function groupName(changes) {
    const made = changes.find(c => derivedRole(c) && nonEmpty(c.scenario));
    if (made) return made.scenario;
    const names = [];
    for (const c of changes) if (isCopied(c) && nonEmpty(c.scenario) && !names.includes(c.scenario)) names.push(c.scenario);
    return names.find(n => BABY_RE.test(n)) || names.find(n => changes.some(c => isCopied(c) && c.scenario === n && BABY_RE.test(String(c.label || '')))) || null;
  }

  /**
   * The birth month a copied group implies: its earliest monthly item's start month (items the
   * defaults filled left out: their start is the defaults' own; when only those are left, the
   * filled supplies item, which starts in the birth month by construction).
   */
  function groupBirthMonth(changes, name) {
    if (!name) return null;
    const own = changes.filter(c => isCopied(c) && c.scenario === name && c.kind === 'monthly' && E.months.isMonth(c.startMonth));
    const free = own.filter(c => !derivedRole(c));
    const pick = list => list.reduce((m, c) => (m === null || c.startMonth < m ? c.startMonth : m), null);
    if (free.length) return pick(free.filter(c => c.group !== 'income')) || pick(free);
    const supplies = changes.find(c => derivedRole(c) === 'supplies' && c.scenario === name && E.months.isMonth(c.startMonth));
    return supplies ? supplies.startMonth : null;
  }

  /**
   * The timing: { precision: 'day'|'month'|null, birthMonth, dueDate, months: { setup, supplies,
   * childcare } } (months null when unknown).
   */
  function timingOf(state, changes, name) {
    const settings = isObj(state.plan.settings) ? state.plan.settings : {};
    const due = E.dates.isDate(settings.babyDueDate) ? settings.babyDueDate : null;
    if (due) {
      const birth = monthsOf(due);
      return { precision: 'day', dueDate: due, birthMonth: birth, months: { setup: E.months.add(birth, -1), supplies: birth, childcare: monthsOf(E.dates.addDays(due, CARE_AFTER_DAYS)) } };
    }
    const birth = groupBirthMonth(changes, name);
    if (birth) return { precision: 'month', dueDate: null, birthMonth: birth, months: { setup: E.months.add(birth, -1), supplies: birth, childcare: E.months.add(birth, CARE_AFTER_MONTHS) } };
    return { precision: null, dueDate: null, birthMonth: null, months: null };
  }

  /** The saved scenario event a copied change was copied from (null when gone). */
  function copiedEvent(state, c) {
    for (const s of Array.isArray(state.scenarios) ? state.scenarios : []) {
      if (!isObj(s) || !Array.isArray(s.events)) continue;
      const ev = s.events.find(x => isObj(x) && 'sc-' + String(x.id || '').trim() === c.id);
      if (ev) return ev;
    }
    return null;
  }
  /** The start month the copy gave a copied change: its scenario event's (null when gone). */
  function copiedStart(state, c) {
    const ev = copiedEvent(state, c);
    const m = !ev ? null : ev.type === 'one_time' ? ev.month : ev.startMonth;
    return E.months.isMonth(m) ? m : null;
  }

  /** An untouched placeholder for `role` in the group: no amount, its kind, its start still as copied (or the birth month). */
  function placeholderFor(state, changes, name, role, birth) {
    const def = DEFAULTS[role];
    return changes.find(c => isCopied(c) && c.scenario === name && !derivedRole(c) && !c.template && roleOf(c) === role && c.kind === def.kind
      && c.cents === null && (c.startMonth === copiedStart(state, c) || c.startMonth === birth)) || null;
  }

  /**
   * The household covers `role` already, so its default is never made: an accepted item about it in
   * the defaults' group `name`, of the default's kind, with an amount of $0 or more (an explicit $0
   * is their choice), a monthly one running at the default's start month `month`. Items elsewhere in the plan (their own 'Daycare'
   * row) do not stop the default from being made: guard holds it back in the months they run, so
   * it still counts before and after them.
   */
  const covered = (changes, name, role, month) => changes.some(c => !c.template && !derivedRole(c) && c.scenario === name && roleOf(c) === role
    && c.kind === DEFAULTS[role].kind && c.accepted === true && isCents(c.cents) && c.cents >= 0
    && (c.kind !== 'monthly' || (!(E.months.isMonth(c.startMonth) && c.startMonth > month) && !(E.months.isMonth(c.endMonth) && c.endMonth < month))));

  // ------------------------------------------------------------------ ensure

  function derivedOf(def, month, precision) {
    return Object.assign({ role: def.role, startMonth: month, cents: def.cents }, def.yearlyCents ? { yearlyCents: def.yearlyCents } : {}, { precision });
  }

  /** The end month still fits after a new start month (a monthly change's end is on or after its start). */
  const endFits = (c, month) => !(c.kind === 'monthly' && E.months.isMonth(c.endMonth) && c.endMonth < month);

  /**
   * Make sure the baby-cost defaults are in the plan (the rules at the top of this file). Pure:
   * `state` is not changed; a new state is returned when anything changed.
   * @param {object} state a checked State (after setup sync)
   * @param {{now?: string}} [opts] now: ISO time recorded as meta.updatedAt when something changed
   * @returns {{state: object, notes: string[], changed: boolean, status: object}}
   */
  function ensure(state, opts) {
    if (!isObj(state) || !isObj(state.plan)) return { state, notes: [], changed: false, status: status(state) };
    const changes = (Array.isArray(state.plan.changes) ? state.plan.changes : []).filter(isObj).map(c => Object.assign({}, c));
    const name0 = groupName(changes);
    const t = timingOf(state, changes, name0);
    if (!t.months) return { state, notes: [], changed: false, status: status(state) };
    const name = name0 || GROUP_NAME;
    const meta = isObj(state.meta) ? state.meta : {};
    const done = new Set(isObj(meta.babyDefaults) && Array.isArray(meta.babyDefaults.done) ? meta.babyDefaults.done.filter(r => ROLES.includes(r)) : []);
    for (const c of changes) if (derivedRole(c)) done.add(derivedRole(c));
    const before = new Set(done);
    const birth = name0 ? groupBirthMonth(changes, name0) : null;
    const max = E.state && E.state.LIMITS ? E.state.LIMITS.planChanges : Infinity;
    const noteMax = E.state && E.state.LIMITS ? E.state.LIMITS.note : 500;
    const labelMax = E.state && E.state.LIMITS ? E.state.LIMITS.label : 80;
    const added = [], filled = [], moved = [], full = [];
    let touched = false;

    for (const role of ROLES) {
      const def = DEFAULTS[role];
      const month = t.months[role];
      if (done.has(role)) {
        // Made before: follow the timing only where the start month is still the one written.
        for (const c of changes) {
          if (derivedRole(c) !== role || c.derived.startMonth !== c.startMonth) continue;
          if (c.startMonth !== month && endFits(c, month)) {
            moved.push(c.label);
            c.startMonth = month;
            c.derived = Object.assign({}, c.derived, { startMonth: month, precision: t.precision });
            touched = true;
          } else if (c.startMonth === month && c.derived.precision !== t.precision) {
            c.derived = Object.assign({}, c.derived, { precision: t.precision });
            touched = true;
          }
        }
        continue;
      }
      if (covered(changes, name, role, month)) { done.add(role); continue; }
      const ph = name0 ? placeholderFor(state, changes, name0, role, birth) : null;
      if (ph && endFits(ph, month)) {
        done.add(role);
        const old = nonEmpty(ph.note) ? ph.note.trim() : '';
        // A name still as copied says it is an estimate now (a name the household gave stays).
        const ev = copiedEvent(state, ph);
        if (ev && nonEmpty(ev.label) && String(ph.label || '').trim() === ev.label.trim() && !/estimate/i.test(ph.label)) ph.label = (ph.label.trim() + ' (estimate)').slice(0, labelMax);
        Object.assign(ph, { startMonth: month, cents: def.cents, accepted: true, note: (def.note + (old ? ' Earlier note: ' + old : '')).slice(0, noteMax) },
          def.yearlyCents ? { yearlyCents: def.yearlyCents } : {}, { derived: derivedOf(def, month, t.precision) });
        filled.push(ph.label);
        touched = true;
        continue;
      }
      if (changes.some(c => c.id === def.id)) { done.add(role); continue; } // an item with that id is already there (the household's)
      if (changes.length >= max) { full.push(def.label); continue; }
      done.add(role);
      const item = { id: def.id, label: def.label, kind: def.kind, group: def.group, personId: null, startMonth: month, endMonth: null, cents: def.cents,
        accepted: true, template: null, scenario: name, note: def.note };
      if (def.yearlyCents) item.yearlyCents = def.yearlyCents;
      item.derived = derivedOf(def, month, t.precision);
      changes.push(item);
      added.push(def);
      touched = true;
    }

    const doneChanged = done.size !== before.size;
    const fullNote = full.length ? ['Baby costs: there is no room for more planned changes, so ' + full.join(', ') + ' could not be added; remove a change you no longer need.'] : [];
    if (!touched && !doneChanged) return { state, notes: fullNote, changed: false, status: status(state) };
    const next = Object.assign({}, state, { plan: Object.assign({}, state.plan, { changes: touched ? changes : state.plan.changes }) });
    next.meta = Object.assign({}, meta, { babyDefaults: { done: ROLES.filter(r => done.has(r)) } });
    const now = isObj(opts) && typeof opts.now === 'string' ? opts.now : null;
    if (touched && now) next.meta.updatedAt = now;

    const notes = [];
    const when = t.precision === 'month' ? ' (timed from the birth month of “' + name + '”, ' + monthText(t.birthMonth) + ': an estimate until you enter the due date in Budget’s setup details)' : '';
    if (added.length || filled.length) {
      const parts = added.map(d => d.label).concat(filled);
      notes.push('Baby costs: planning estimates are now in the plan under “' + name + '” (' + parts.join(', ') + ')' + when + '. They are estimates, not quotes: change them on the Plan.');
    }
    notes.push(...fullNote);
    if (moved.length) notes.push('Baby costs: ' + moved.join(', ') + ' moved to follow ' + (t.precision === 'day' ? 'the due date (' + t.dueDate + ')' : 'the birth month (' + monthText(t.birthMonth) + ')') + '; start months you set yourself were kept.');
    return { state: next, notes, changed: touched, status: status(next) };
  }

  /**
   * What the Plan shows about the defaults: { group, timing: 'day'|'month'|'unknown', dueDate,
   * birthMonth, caveat, items: [{ role, id, label, kind, cents, yearlyCents, startMonth, dateNeeded }] }.
   * items: the changes the defaults made (by role), or, while the timing is unknown and none were
   * made, the defaults as they would be ("date needed", startMonth null, not applied).
   */
  function status(state) {
    const plan = isObj(state) && isObj(state.plan) ? state.plan : {};
    const changes = (Array.isArray(plan.changes) ? plan.changes : []).filter(isObj);
    const name0 = groupName(changes);
    const t = isObj(state) && isObj(state.plan) ? timingOf(state, changes, name0) : { precision: null, dueDate: null, birthMonth: null, months: null };
    const made = changes.filter(derivedRole).sort((a, b) => ROLES.indexOf(derivedRole(a)) - ROLES.indexOf(derivedRole(b)));
    const items = made.length
      ? made.map(c => ({ role: derivedRole(c), id: c.id, label: c.label, kind: c.kind, cents: isCents(c.cents) ? c.cents : null, yearlyCents: isCents(c.yearlyCents) ? c.yearlyCents : null, startMonth: c.startMonth, dateNeeded: false }))
      : t.months ? [] : ROLES.map(r => { const d = DEFAULTS[r]; return { role: r, id: d.id, label: d.label, kind: d.kind, cents: d.cents, yearlyCents: d.yearlyCents || null, startMonth: null, dateNeeded: true }; });
    return { group: made.length ? made[0].scenario : name0 || GROUP_NAME, timing: t.precision || 'unknown', dueDate: t.dueDate, birthMonth: t.birthMonth, caveat: CAVEAT, items };
  }

  /** Run ensure when plan.settings.babyDueDate differs between `prev` and `next` (a write that changed it). */
  function follow(prev, next, opts) {
    const due = s => (isObj(s) && isObj(s.plan) && isObj(s.plan.settings) && E.dates.isDate(s.plan.settings.babyDueDate) ? s.plan.settings.babyDueDate : null);
    if (!isObj(next) || due(prev) === due(next)) return next;
    return ensure(next, opts).state;
  }

  // ------------------------------------------------------------------ counting once (timeline.build)

  /** The months an item runs, [from, until] (until null: open-ended; a one-time item: its month). */
  const spanOf = c => [c.startMonth, c.kind === 'oneTime' ? c.startMonth : c.endMonth || null];
  /** The months two spans share, or null. */
  function shared(a, b) {
    const from = a[0] > b[0] ? a[0] : b[0];
    const until = a[1] === null ? b[1] : b[1] === null ? a[1] : a[1] < b[1] ? a[1] : b[1];
    return until === null || from <= until ? [from, until] : null;
  }
  const spends = c => c.group !== 'income' && c.group !== 'savings';

  /**
   * What keeps a cost from counting twice, for the plan (BudgetEngine.timeline.build): `changes`
   * as timeline readChanges gives them (babyRole: the default a change is; yearlyCents). A default
   * is covered by an accepted item with a cost (more than $0; $0 in its group), of the same kind (one-time or monthly):
   *   - a New baby pack (babyFirstYear) item covers setup (its one-time items) and supplies (its
   *     monthly ones, the first year), a Kid costs pack item supplies (from age 1), a Childcare pack
   *     item childcare;
   *   - the household's own item of the same kind (roleOf; in the defaults' group, or about a child
   *     anywhere in the plan, whatever its what-if: e.g. their own 'Daycare' row);
   *   - an unaccepted item of the same kind in the group is an alternative: never added on top of
   *     the default (not in a what-if comparison either).
   * A one-time default is held back when covered; a monthly one only in the months a covering item
   * runs (it counts again once they end), its yearly amount with it.
   * @returns {{ held: Set<string>, heldIn: function(string, string): boolean, alternatives: Set<string>, overlaps: object[] }}
   *   held: the defaults held back in some month; heldIn(id, month): held back in that month;
   *   overlaps: { kind: 'pack'|'alternative', role, id (the default held back), label, with: ids,
   *   template?, from, until (the months held back; until null: as long as both run) }
   */
  function guard(changes) {
    const held = new Set(), alternatives = new Set(), overlaps = [], spans = new Map();
    const list = Array.isArray(changes) ? changes : [];
    for (const d of list) {
      const role = d.babyRole;
      if (!ROLES.includes(role)) continue;
      const own = list.filter(c => c.id !== d.id && !c.template && !c.babyRole && ownOf(c, role, d.scenario));
      for (const c of own) if (!c.accepted && c.scenario === d.scenario) alternatives.add(c.id);
      if (!d.accepted || d.cents === null) continue;
      // A cost covers it (an explicit $0 too, in the group); a credit (a subsidy or reimbursement,
      // below $0) does not replace the cost.
      const covers = c => c.accepted && isCents(c.cents) && (c.cents > 0 || (c.cents === 0 && c.scenario === d.scenario)) && c.kind === d.kind && spends(c);
      const sources = [{ kind: 'alternative', items: own.filter(covers) }];
      for (const [template, roles] of Object.entries(PACK_ROLES)) if (roles.includes(role)) sources.push({ kind: 'pack', template, items: list.filter(c => c.template === template && covers(c)) });
      const whole = spanOf(d);
      for (const src of sources) {
        // A one-time cost covered is covered whatever the month; a monthly one in the months both run.
        const hits = src.items.map(c => [c, d.kind === 'oneTime' ? whole : shared(whole, spanOf(c))]).filter(([, sp]) => sp);
        if (!hits.length) continue;
        held.add(d.id);
        spans.set(d.id, (spans.get(d.id) || []).concat(hits.map(([, sp]) => sp)));
        const from = hits.reduce((m, [, sp]) => (sp[0] < m ? sp[0] : m), hits[0][1][0]);
        const until = hits.some(([, sp]) => sp[1] === null) ? null : hits.reduce((m, [, sp]) => (sp[1] > m ? sp[1] : m), hits[0][1][1]);
        overlaps.push(Object.assign({ kind: src.kind, role, id: d.id, label: d.label, with: hits.map(([c]) => c.id) }, src.template ? { template: src.template } : {}, { from, until }));
      }
    }
    const heldIn = (id, m) => (spans.get(id) || []).some(([from, until]) => m >= from && (until === null || m <= until));
    return { held, heldIn, alternatives, overlaps };
  }

  E.babyDefaults = { ROLES, GROUP_NAME, CAVEAT, DEFAULTS, PACK_ROLES, CARE_AFTER_DAYS, CARE_AFTER_MONTHS, ensure, status, follow, guard, roleOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
