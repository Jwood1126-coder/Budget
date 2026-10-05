'use strict';
/*
 * BudgetEngine.timeline: the plan screen's validated state writes, and the upgrades it applies
 * once (timeline-core.js says how the timeline files fit together).
 *
 * Adds to E._timeline: setDial, setRow, resetDial, resetPlan, setGroup, setIrregular, addChange,
 * setChange, removeChange, acceptChanges, migrateRows, migrateDials, pendingUpgrade,
 * acceptCarriedOver.
 * Uses, when called: rowIdOf (timeline-spending.js).
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const T = E._timeline;
  const { isObj, isCents, has, own, fail, late, MERCHANT_KEY, SPEND_GROUPS, SPEND_DIALS, LEGACY_DIALS } = T;
  const rowIdOf = late('rowIdOf');

  // ------------------------------------------------------------------ state writes for the screen

  function planUi(state) { return state && isObj(state.ui) && isObj(state.ui.plan) ? state.ui.plan : {}; }

  /**
   * Set one dial directly (cents, may be negative), or clear it with null/undefined (back to rows
   * or baseline). A card part kept for the dial's earlier amount (ui.plan.cardSplit) is removed.
   */
  function setDial(state, key, cents) {
    let next = E.state.setPath(state, 'ui.plan.dials.' + key, cents === null ? undefined : cents);
    if (has(planUi(next).cardSplit, key)) next = E.state.setPath(next, 'ui.plan.cardSplit.' + key, undefined);
    return next;
  }

  /** Append a note to meta.migrationNotes once (kept within the limit). */
  function recordNote(state, note) {
    if (!note || !isObj(state.meta)) return state;
    const notes = Array.isArray(state.meta.migrationNotes) ? state.meta.migrationNotes : [];
    if (notes.includes(note)) return state;
    return E.state.setPath(state, 'meta.migrationNotes', notes.concat([note.slice(0, 500)]).slice(-E.state.LIMITS.migrationNotes));
  }

  /**
   * Change one drill-down row: patch { included?: boolean, cents?: number|null }. null/undefined
   * clears that part; included: true is the default and is not stored. An empty change is removed.
   */
  function setRow(state, id, patch) {
    const cur = isObj(planUi(state).rows) && isObj(own(planUi(state).rows, id)) ? planUi(state).rows[id] : {};
    const next = Object.assign({}, cur);
    for (const k of ['included', 'cents']) {
      if (!isObj(patch) || !Object.prototype.hasOwnProperty.call(patch, k)) continue;
      if (patch[k] === undefined || patch[k] === null) delete next[k];
      else next[k] = patch[k];
    }
    if (next.included === true) delete next.included;
    return E.state.setPath(state, 'ui.plan.rows.' + id, Object.keys(next).length ? next : undefined);
  }

  /**
   * Put one dial back to its baseline: its direct amount and every change to its rows are removed
   * (for irregular: every one-time cost left out is back in the allowance). With the current
   * timeline `tl`, changes saved under the earlier card/bank dials that its rows use go too.
   */
  function resetDial(state, key, tl) {
    const p = planUi(state);
    let next = setDial(state, key, undefined);
    const legacy = new Set();
    const d = tl && isObj(tl.dialsByKey) ? tl.dialsByKey[key] : null;
    for (const r of d && d.drill && d.drill.kind === 'categories' ? d.drill.rows : []) if (r.legacyId) legacy.add(r.legacyId);
    for (const id of Object.keys(isObj(p.rows) ? p.rows : {})) if (id.startsWith(key + '-') || legacy.has(id)) next = E.state.setPath(next, 'ui.plan.rows.' + id, undefined);
    if (key === 'irregular') for (const id of Object.keys(isObj(p.irregularOff) ? p.irregularOff : {})) next = E.state.setPath(next, 'ui.plan.irregularOff.' + id, undefined);
    return next;
  }

  /** Every dial, row and one-time cost back to the baseline (groups, planned changes and other settings stay). */
  function resetPlan(state) {
    const p = planUi(state);
    let next = state;
    for (const k of Object.keys(isObj(p.dials) ? p.dials : {})) next = E.state.setPath(next, 'ui.plan.dials.' + k, undefined);
    for (const id of Object.keys(isObj(p.rows) ? p.rows : {})) next = E.state.setPath(next, 'ui.plan.rows.' + id, undefined);
    for (const id of Object.keys(isObj(p.irregularOff) ? p.irregularOff : {})) next = E.state.setPath(next, 'ui.plan.irregularOff.' + id, undefined);
    for (const k of Object.keys(isObj(p.cardSplit) ? p.cardSplit : {})) next = E.state.setPath(next, 'ui.plan.cardSplit.' + k, undefined);
    return next;
  }

  /**
   * Put a category (key = its name) or a place (key = 'merchant:' + place) in 'essentials' or
   * 'flexible'; null/undefined goes back to the default (the taxonomy, or the place's categories).
   * With the current timeline `tl`, changes to the category's rows follow them to the other group
   * (row ids carry the group); without it only the category and "everything else" rows do.
   */
  function setGroup(state, key, group, tl) {
    if (typeof key !== 'string' || !key.trim()) fail('Choose a category or a place to move.', 'key');
    if (group !== null && group !== undefined && !SPEND_GROUPS.includes(group)) fail('Choose essentials or flexible.', 'group');
    const k = key.trim();
    const p = planUi(state);
    const before = isObj(p.groups) ? own(p.groups, k) : undefined;
    let next = E.state.setPath(state, 'ui.plan.groups.' + k, group === null || group === undefined ? undefined : group);
    if (k.startsWith(MERCHANT_KEY)) return next;
    const fallback = E.categories.isEssential(k) ? 'essentials' : 'flexible';
    const from = SPEND_GROUPS.includes(before) ? before : fallback;
    const to = group || fallback;
    if (from === to) return next;
    const rows = isObj(p.rows) ? p.rows : {};
    const moves = [rowIdOf(from, 'c', k), rowIdOf(from, 'r', k)];
    const d = tl && isObj(tl.dialsByKey) ? tl.dialsByKey[from] : null;
    for (const r of d && d.drill ? d.drill.rows : []) if (r.kind === 'merchant' && !r.synthetic && r.sourceCategory === k) moves.push(r.id);
    for (const id of moves) {
      if (!has(rows, id)) continue;
      const target = to + id.slice(from.length);
      if (!has(rows, target)) next = E.state.setPath(next, 'ui.plan.rows.' + target, rows[id]);
      next = E.state.setPath(next, 'ui.plan.rows.' + id, undefined);
    }
    return next;
  }

  /** Leave one one-time cost out of the irregular allowance (included false), or put it back (true). */
  function setIrregular(state, id, included) {
    if (typeof id !== 'string' || !id.trim()) fail('Choose a one-time cost.', 'id');
    return E.state.setPath(state, 'ui.plan.irregularOff.' + id.trim(), included === false ? true : undefined);
  }

  /** Add one planned change, or a list of them (e.g. templates.baby(dueDate)); each gets an id. */
  function addChange(state, item) {
    const list = Array.isArray(item) ? item : [item];
    return list.reduce((st, x) => E.state.addItem(st, 'changes', x), state);
  }

  /**
   * Change a planned change: patch any of { label, kind, group, personId, startMonth, endMonth,
   * cents, accepted, template, note }. Switching to one-time clears the end month, and away from
   * income clears the person, unless the patch sets them.
   */
  function setChange(state, id, patch) {
    if (!isObj(patch)) fail('Nothing to change.');
    const list = state && isObj(state.plan) && Array.isArray(state.plan.changes) ? state.plan.changes : [];
    const cur = list.find(c => c && c.id === id);
    if (!cur) fail('That planned change no longer exists.', 'id');
    const next = Object.assign({}, patch);
    const kind = has(next, 'kind') ? next.kind : cur.kind;
    const group = has(next, 'group') ? next.group : cur.group;
    if (kind === 'oneTime' && !has(next, 'endMonth')) next.endMonth = null;
    if (group !== 'income' && !has(next, 'personId')) next.personId = null;
    return E.state.updateItem(state, 'changes', id, next);
  }

  function removeChange(state, id) { return E.state.removeItem(state, 'changes', id); }

  /** Accept (apply to the plan) or un-accept planned changes by id (one id or a list). */
  function acceptChanges(state, ids, accepted) {
    const list = Array.isArray(ids) ? ids : [ids];
    return list.reduce((st, id) => E.state.updateItem(st, 'changes', id, { accepted: accepted !== false }), state);
  }

  /**
   * Make the row changes saved under the earlier card/bank dials permanent under their new ids
   * (tl.migration from build): each one that still matches a row moves to it (unless that row has
   * its own change), the rest are removed, and meta.migrationNotes says so. No migration: the
   * state is returned as it is.
   */
  function migrateRows(state, tl) {
    const mig = tl && isObj(tl.migration) ? tl.migration : null;
    if (!mig) return state;
    const rows = isObj(planUi(state).rows) ? planUi(state).rows : {};
    let next = state, changed = false;
    for (const { from, to } of mig.rows) {
      if (!has(rows, from)) continue;
      if (!has(rows, to)) next = E.state.setPath(next, 'ui.plan.rows.' + to, rows[from]);
      next = E.state.setPath(next, 'ui.plan.rows.' + from, undefined);
      changed = true;
    }
    for (const id of mig.dropped) if (has(rows, id)) { next = E.state.setPath(next, 'ui.plan.rows.' + id, undefined); changed = true; }
    return changed ? recordNote(next, mig.rowsNote) : next;
  }

  /**
   * Carry the amounts set for the earlier card and bank dials over to essentials, flexible and
   * irregular (tl.migration.dials from build): each dial in `to` is set directly (with its card
   * part kept in ui.plan.cardSplit, so card and bank still add up to what was set), a dial set
   * directly in the meantime is left alone, ui.plan.legacyDials (and any card/bank dial still
   * saved) is removed, and the note is appended to meta.migrationNotes. Nothing waiting: the state
   * is returned as it is, so running it twice changes nothing more.
   */
  function migrateDials(state, tl) {
    const mig = tl && isObj(tl.migration) && isObj(tl.migration.dials) ? tl.migration.dials : null;
    const p = planUi(state);
    const waiting = has(p, 'legacyDials') || LEGACY_DIALS.some(k => has(p.dials, k));
    if (!mig || !waiting) return state;
    let next = state;
    for (const k of SPEND_DIALS) {
      const cents = mig.to[k];
      if (!isCents(cents) || isCents(own(planUi(next).dials, k))) continue;
      next = setDial(next, k, cents);
      // The card part, and what it was carried over from (shown until the household keeps or changes it).
      const entry = { cents, card: mig.parts[k].card };
      if (isCents(mig.from.card)) entry.fromCard = mig.from.card;
      if (isCents(mig.from.bank)) entry.fromBank = mig.from.bank;
      next = E.state.setPath(next, 'ui.plan.cardSplit.' + k, entry);
    }
    next = E.state.setPath(next, 'ui.plan.legacyDials', undefined);
    for (const k of LEGACY_DIALS) if (has(planUi(next).dials, k)) next = E.state.setPath(next, 'ui.plan.dials.' + k, undefined);
    return recordNote(next, mig.note);
  }

  // ------------------------------------------------------------------ upgrades the plan screen applies
  // Upgrades inside saved-state version 5 that need a built plan (row ids depend on the data), so
  // state.sanitize cannot run them (its own are BudgetEngine.state.V5_UPGRADES). Like those, each
  // is safe to run twice and leaves a note in meta.migrationNotes.
  const SCREEN_UPGRADES = { migrateRows, migrateDials };

  /**
   * What the plan screen must apply once, as one change, for the timeline `tl` it just built:
   * null when nothing is waiting, else { steps, note, apply }:
   *   steps  the upgrades, in order: 'migrateRows' (row changes saved under the earlier card/bank
   *          dials) and/or 'migrateDials' (amounts set for those dials, from ui.plan.legacyDials)
   *   note   tl.migration.note: what to tell the household, once (also the key for "already done")
   *   apply  state => the state with every step applied (migrateDials(migrateRows(state, tl), tl));
   *          safe to run twice (the second run changes nothing)
   * @param {object} tl from build
   */
  function pendingUpgrade(tl) {
    const mig = isObj(tl) && isObj(tl.migration) ? tl.migration : null;
    if (!mig) return null;
    const steps = [];
    if ((Array.isArray(mig.rows) && mig.rows.length) || (Array.isArray(mig.dropped) && mig.dropped.length)) steps.push('migrateRows');
    if (isObj(mig.dials)) steps.push('migrateDials');
    if (!steps.length) return null;
    return { steps, note: mig.note, apply: state => steps.reduce((st, step) => SCREEN_UPGRADES[step](st, tl), state) };
  }

  /**
   * Keep a carried-over amount as it is (one dial key or a list): its "carried over" marker is
   * removed, the amount and its card part stay. Nothing marked: the state is returned as it is.
   */
  function acceptCarriedOver(state, keys) {
    let next = state;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const sp = own(planUi(next).cardSplit, key);
      if (!isObj(sp) || (!has(sp, 'fromCard') && !has(sp, 'fromBank'))) continue;
      next = E.state.setPath(next, 'ui.plan.cardSplit.' + key, { cents: sp.cents, card: sp.card });
    }
    return next;
  }

  Object.assign(T, {
    setDial, setRow, resetDial, resetPlan, setGroup, setIrregular, addChange, setChange, removeChange, acceptChanges, migrateRows, migrateDials,
    pendingUpgrade, acceptCarriedOver,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
