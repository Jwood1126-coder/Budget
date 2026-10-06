'use strict';
/*
 * BudgetEngine.timeline: the plan screen's validated state writes, and the upgrades it applies
 * once (timeline-core.js says how the timeline files fit together).
 *
 * Adds to E._timeline: setDial, setRow, setTarget, resetDial, resetRow, resetPlan, setGroup,
 * setIrregular, addChange, setChange, removeChange, acceptChanges, migrateRows, migrateDials,
 * splitOther, regroupDials, pendingUpgrade, acceptCarriedOver.
 * Uses, when called: rowIdOf (timeline-spending.js), BudgetEngine.setupSync.baseValue (the resets).
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const T = E._timeline;
  const { isObj, isCents, has, own, fail, late, MERCHANT_KEY, SPEND_GROUPS, SPEND_DIALS, LEGACY_DIALS, OTHER_CATEGORY } = T;
  const rowIdOf = late('rowIdOf');

  // ------------------------------------------------------------------ state writes for the screen

  function planUi(state) { return state && isObj(state.ui) && isObj(state.ui.plan) ? state.ui.plan : {}; }

  /**
   * Set one dial directly (cents, may be negative), or clear it with null/undefined (back to rows
   * or baseline). A card part kept for the dial's earlier amount (ui.plan.cardSplit) and what
   * categories moved between the groups added to or took off it (ui.plan.dialShift) are removed:
   * the new amount is chosen as the groups are now. Setting `other` while an earlier amount still
   * waits to be split (ui.plan.otherDial 'withInvesting') makes the new amount debt & business only
   * (otherDial 'debt'). Setting essentials or flexible while an amount set before imported names
   * were resolved waits to be carried over (ui.plan.groupsRead 'exact') ends that wait (groupsRead
   * 'resolved'): with it set as the groups are read now, there is nothing left to carry over.
   */
  function setDial(state, key, cents) {
    let next = E.state.setPath(state, 'ui.plan.dials.' + key, cents === null ? undefined : cents);
    if (has(planUi(next).cardSplit, key)) next = E.state.setPath(next, 'ui.plan.cardSplit.' + key, undefined);
    next = dropShift(next, key);
    const amount = cents !== null && cents !== undefined;
    if (key === 'other' && planUi(next).otherDial === 'withInvesting' && amount) next = E.state.setPath(next, 'ui.plan.otherDial', 'debt');
    if (SPEND_GROUPS.includes(key) && planUi(next).groupsRead === 'exact' && amount) next = E.state.setPath(next, 'ui.plan.groupsRead', 'resolved');
    return next;
  }

  /** ui.plan.dialShift without `key`'s entry, and without the field once no entry is left. */
  function dropShift(state, key) {
    const cur = planUi(state).dialShift;
    if (!has(cur, key)) return state;
    const rest = Object.keys(cur).filter(k => k !== key);
    return E.state.setPath(state, 'ui.plan.dialShift' + (rest.length ? '.' + key : ''), undefined);
  }

  /** Append a note to meta.migrationNotes once (kept within the limit). */
  function recordNote(state, note) {
    if (!note || !isObj(state.meta)) return state;
    const notes = Array.isArray(state.meta.migrationNotes) ? state.meta.migrationNotes : [];
    if (notes.includes(note)) return state;
    return E.state.setPath(state, 'meta.migrationNotes', notes.concat([note.slice(0, 500)]).slice(-E.state.LIMITS.migrationNotes));
  }

  /**
   * The category a drill-down row id stands for when it is a level-1 row of one real category
   * (not the grouped "Other", not a place moved as a whole), else null. With the current timeline
   * `tl` the row is looked up; without it the id is matched against the categories the budget and
   * the taxonomy know (row ids are '<group>-c-' + a hash of the category).
   */
  function categoryOfRow(state, id, tl) {
    if (typeof id !== 'string') return null;
    if (tl && isObj(tl.dialsByKey)) {
      for (const g of SPEND_GROUPS) {
        const d = tl.dialsByKey[g];
        const r = d && d.drill && Array.isArray(d.drill.rows) ? d.drill.rows.find(x => x.id === id) : null;
        if (r) return r.level === 1 && !r.synthetic && typeof r.groupKey === 'string' && !r.groupKey.startsWith(MERCHANT_KEY) && r.groupKey !== OTHER_CATEGORY ? r.groupKey : null;
      }
    }
    const targets = state && isObj(state.plan) && isObj(state.plan.targets) ? Object.keys(state.plan.targets) : [];
    for (const cat of targets.concat(E.categories.names())) {
      if (cat === OTHER_CATEGORY) continue;
      for (const g of SPEND_GROUPS) if (rowIdOf(g, 'c', cat) === id) return cat;
    }
    return null;
  }

  /**
   * Change one drill-down row: patch { included?: boolean, cents?: number|null }. null/undefined
   * clears that part; included: true is the default and is not stored. An empty change is removed.
   * On a level-1 row of one category (categoryOfRow; pass the current timeline `tl` to look it up)
   * an amount is the category's budget: `cents` (0 or more) is written to plan.targets[category]
   * and the row's own amount in ui.plan.rows is removed (its included flag stays there); clearing
   * it (null) clears the budget too (plan.targets[category] becomes null, "not set", when it was
   * there). A negative amount, the grouped "Other", places and places moved as a whole keep using
   * ui.plan.rows.
   */
  function setRow(state, id, patch, tl) {
    const cur = isObj(planUi(state).rows) && isObj(own(planUi(state).rows, id)) ? planUi(state).rows[id] : {};
    const next = Object.assign({}, cur);
    let target;
    const category = isObj(patch) && has(patch, 'cents') ? categoryOfRow(state, id, tl) : null;
    for (const k of ['included', 'cents']) {
      if (!isObj(patch) || !Object.prototype.hasOwnProperty.call(patch, k)) continue;
      if (k === 'cents' && category !== null && (patch.cents === undefined || patch.cents === null || (isCents(patch.cents) && patch.cents >= 0))) {
        delete next.cents;
        target = patch.cents === undefined ? null : patch.cents;
        continue;
      }
      if (patch[k] === undefined || patch[k] === null) delete next[k];
      else next[k] = patch[k];
    }
    if (next.included === true) delete next.included;
    let out = state;
    if (target !== undefined) {
      const targets = state && isObj(state.plan) && isObj(state.plan.targets) ? state.plan.targets : {};
      if (target !== null || has(targets, category)) out = setTarget(out, category, target);
    }
    if (Object.keys(next).length || has(planUi(out).rows, id)) out = E.state.setPath(out, 'ui.plan.rows.' + id, Object.keys(next).length ? next : undefined);
    return out;
  }

  /**
   * Set a category's monthly budget (plan.targets[category]): cents (0 or more), or null for "not
   * set" (the plan then uses the category's history). What the Budget screen and the plan's
   * category rows write. Validated through state.setPath.
   */
  function setTarget(state, category, cents) {
    if (typeof category !== 'string' || !category.trim()) fail('Choose a category.', 'category');
    return E.state.setPath(state, 'plan.targets.' + category.trim(), cents === undefined ? null : cents);
  }

  // A reset puts each ui.plan key it covers back to what the setup file supplied for it when it was
  // last applied (B, BudgetEngine.setupSync.baseValue) and removes the keys it did not supply.
  // Removing a key the setup file supplied would read to setup sync as "removed by the household"
  // and keep its later values out; B's value back keeps the saved value equal to B, so they flow.

  /** The setup file's entries for ui.plan.<field> (dials, rows, irregularOff), {} when it supplied none. */
  function setupPart(state, field) {
    const v = E.setupSync ? E.setupSync.baseValue(state, 'ui.plan.' + field) : undefined;
    return isObj(v) ? v : {};
  }

  /** The keys of ui.plan.<field> a reset covers: the saved ones and the setup file's (`base`), those `pick` keeps. */
  function resetKeys(state, field, base, pick = () => true) {
    const saved = isObj(planUi(state)[field]) ? Object.keys(planUi(state)[field]) : [];
    return Array.from(new Set(saved.concat(Object.keys(base)))).filter(pick);
  }

  /** ui.plan.<field>.<key> back to the setup file's entry `base[key]`, or removed when it has none. */
  function resetKey(state, field, key, base) {
    if (!has(base, key) && !has(planUi(state)[field], key)) return state;
    return E.state.setPath(state, 'ui.plan.' + field + '.' + key, has(base, key) ? base[key] : undefined);
  }

  /**
   * Put one dial back: to the setup file's amount for it when it supplied one, else to its rows or
   * baseline; every change to its rows goes back the same way (the setup file's change for that
   * row, else none; for irregular: the one-time costs left out too, each back to its default — in the
   * allowance unless left out of planning in Transactions or Spending). With the current timeline
   * `tl`, changes saved under the earlier card/bank dials that its rows use go too.
   */
  function resetDial(state, key, tl) {
    const dials = setupPart(state, 'dials'), rows = setupPart(state, 'rows');
    let next = setDial(state, key, has(dials, key) ? dials[key] : undefined);
    const legacy = new Set();
    const d = tl && isObj(tl.dialsByKey) ? tl.dialsByKey[key] : null;
    for (const r of d && d.drill && d.drill.kind === 'categories' ? d.drill.rows : []) if (r.legacyId) legacy.add(r.legacyId);
    for (const id of resetKeys(state, 'rows', rows, id => id.startsWith(key + '-') || legacy.has(id))) next = resetKey(next, 'rows', id, rows);
    if (key === 'irregular') {
      const off = setupPart(state, 'irregularOff');
      for (const id of resetKeys(state, 'irregularOff', off)) next = resetKey(next, 'irregularOff', id, off);
    }
    return next;
  }

  /**
   * Put one drill-down row back: its change in ui.plan.rows goes back to the setup file's change
   * for it when it supplied one, else is removed; with the current timeline `tl`, the same row's
   * change saved under the earlier card/bank dial too (as resetDial). The category's budget
   * (plan.targets) is never touched: a category row goes back to its budget when one is set, else
   * to its history.
   */
  function resetRow(state, id, tl) {
    const rows = setupPart(state, 'rows');
    const next = resetKey(state, 'rows', id, rows);
    // Row ids start with their dial's key.
    const d = tl && isObj(tl.dialsByKey) ? tl.dialsByKey[String(id).split('-')[0]] : null;
    const r = d && d.drill && Array.isArray(d.drill.rows) ? d.drill.rows.find(x => x.id === id) : null;
    return r && r.legacyId ? resetKey(next, 'rows', r.legacyId, rows) : next;
  }

  /**
   * Every dial, row and one-time cost back as resetDial puts one back (the setup file's values,
   * else the baseline); the kept card parts and the regrouping adjustments (ui.plan.dialShift) go.
   * Groups, planned changes, budgets and other settings stay.
   */
  function resetPlan(state) {
    const p = planUi(state);
    const dials = setupPart(state, 'dials');
    let next = state;
    for (const k of resetKeys(state, 'dials', dials)) next = setDial(next, k, has(dials, k) ? dials[k] : undefined);
    for (const field of ['rows', 'irregularOff']) {
      const base = setupPart(state, field);
      for (const id of resetKeys(state, field, base)) next = resetKey(next, field, id, base);
    }
    for (const k of Object.keys(isObj(p.cardSplit) ? p.cardSplit : {})) next = E.state.setPath(next, 'ui.plan.cardSplit.' + k, undefined);
    if (has(planUi(next), 'dialShift')) next = E.state.setPath(next, 'ui.plan.dialShift', undefined);
    return next;
  }

  /**
   * Add `cents` to the regrouping adjustment of a spending dial set directly (ui.plan.dialShift[key])
   * for `category`'s move: the category joins its list, or leaves it when it moves back; an
   * adjustment that comes to $0 with no category left is removed (and the field with the last one).
   */
  function addShift(state, key, cents, category) {
    const cur = own(planUi(state).dialShift, key);
    const total = (isObj(cur) && isCents(cur.cents) ? cur.cents : 0) + cents;
    const names = isObj(cur) && Array.isArray(cur.categories) ? cur.categories.slice() : [];
    const at = names.indexOf(category);
    if (at >= 0) names.splice(at, 1); else names.push(category);
    if (total === 0 && !names.length) return dropShift(state, key);
    return E.state.setPath(state, 'ui.plan.dialShift.' + key, { cents: total, categories: names.slice(-20) });
  }

  const GROUP_LABEL = { essentials: 'Essentials', flexible: 'Flexible' };
  /**
   * Why moving `key` to `group` (null: back to its default) is not allowed now, or null. With
   * exactly one of the two spending dials set directly (any amount, $0 included), the regrouping
   * adjustment keeps the total only for a category with a row of its own (setGroup); these moves
   * would change the total, so they wait until both dials or neither are set directly: a place
   * moved as a whole, a category grouped into "Other" (too small for a row of its own), a category
   * planned through a combined budget (an aggregate's member, or the aggregate itself), a category
   * taken out of the dial set directly when that amount ($0 included) is less than the category's
   * (the plan amount stops at $0), and any category move without the current timeline `tl` to
   * measure it. Saved state is never touched.
   */
  function moveBlocked(state, key, group, tl) {
    if (typeof key !== 'string' || !key.trim()) return null;
    const k = key.trim();
    const p = planUi(state);
    const direct = SPEND_GROUPS.filter(g => isCents(own(p.dials, g)));
    if (direct.length !== 1) return null;
    const set = GROUP_LABEL[direct[0]], other = GROUP_LABEL[SPEND_GROUPS.find(g => g !== direct[0])];
    const why = what => what + ' can’t be moved while ' + set + ' is set to an amount here and ' + other + ' is not: the plan’s total would change. '
      + 'Reset ' + set + ', or set ' + other + ' too, then move it.';
    if (k.startsWith(MERCHANT_KEY)) return why('A whole place');
    const before = isObj(p.groups) ? own(p.groups, k) : undefined;
    const fallback = E.categories.isEssential(k) ? 'essentials' : 'flexible';
    const from = SPEND_GROUPS.includes(before) ? before : fallback;
    if (from === (group || fallback)) return null;
    if (E.categories.membersOf(k)) return why('A combined budget');
    const drill = tl && isObj(tl.dialsByKey) && tl.dialsByKey[from] ? tl.dialsByKey[from].drill : null;
    if (!drill || !Array.isArray(drill.rows)) return why('This category');
    const rows = drill.rows.filter(r => r.level === 1);
    const row = rows.find(r => !r.synthetic && r.groupKey === k);
    if (row) {
      if (row.aggregate || row.source === 'aggregate' || (Array.isArray(row.covers) && row.covers.length)) return why('A category planned through a combined budget');
      // Out of the dial set directly: its amount (with any adjustment) must still hold the category's, or $0 would cut it short.
      const moving = row.included && isCents(row.planCents) ? row.planCents : 0;
      const shift = isObj(p.dialShift) && isObj(own(p.dialShift, from)) && isCents(p.dialShift[from].cents) ? p.dialShift[from].cents : 0;
      if (direct[0] === from && moving > 0 && own(p.dials, from) + shift - moving < 0) {
        return row.label + ' can’t be moved out of ' + set + ': ' + set + ' is set to ' + E.money.format(Math.max(0, own(p.dials, from) + shift))
          + ' here, less than its ' + E.money.format(moving) + ' a month, so the plan’s total would change. Raise or reset ' + set + ', then move it.';
      }
      return null;
    }
    // No row of its own: grouped into "Other" (its amount is in that row), or not in the plan at all (nothing moves).
    return rows.some(r => Array.isArray(r.members) && r.members.length > 1 && r.members.includes(k)) ? why('A category grouped into “Other”') : null;
  }

  /**
   * Put a category (key = its name) or a place (key = 'merchant:' + place) in 'essentials' or
   * 'flexible'; null/undefined goes back to the default (the taxonomy, or the place's categories).
   * With the current timeline `tl`, changes to the category's rows follow them to the other group
   * (row ids carry the group); without it only the category and "everything else" rows do.
   * The plan's total stays the same: when exactly one of the two spending dials is set directly,
   * the category's plan amount in the group it leaves (its row in `tl`; $0 when left out, grouped
   * into "Other" or not in `tl`) is taken off that dial when it is the one set directly, or added
   * to the receiving one, as a regrouping adjustment (ui.plan.dialShift); the amount set stays as
   * saved, and moving it back takes the adjustment back. A move the adjustment cannot keep the
   * total for (moveBlocked) is refused with its reason; nothing is saved.
   */
  function setGroup(state, key, group, tl) {
    if (typeof key !== 'string' || !key.trim()) fail('Choose a category or a place to move.', 'key');
    if (group !== null && group !== undefined && !SPEND_GROUPS.includes(group)) fail('Choose essentials or flexible.', 'group');
    const k = key.trim();
    const blocked = moveBlocked(state, k, group, tl);
    if (blocked) fail(blocked, 'key');
    const p = planUi(state);
    const before = isObj(p.groups) ? own(p.groups, k) : undefined;
    let next = E.state.setPath(state, 'ui.plan.groups.' + k, group === null || group === undefined ? undefined : group);
    if (k.startsWith(MERCHANT_KEY)) return next;
    const fallback = E.categories.isEssential(k) ? 'essentials' : 'flexible';
    const from = SPEND_GROUPS.includes(before) ? before : fallback;
    const to = group || fallback;
    if (from === to) return next;
    const direct = SPEND_GROUPS.filter(g => isCents(own(p.dials, g)));
    const fromDrill = tl && isObj(tl.dialsByKey) && tl.dialsByKey[from] ? tl.dialsByKey[from].drill : null;
    const row = direct.length === 1 && fromDrill && Array.isArray(fromDrill.rows)
      ? fromDrill.rows.find(r => r.level === 1 && !r.synthetic && r.groupKey === k) : null;
    const moving = row && row.included && isCents(row.planCents) ? row.planCents : 0;
    if (moving !== 0) next = addShift(next, direct[0], direct[0] === from ? 0 - moving : moving, k);
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

  /**
   * Leave one one-time cost out of the irregular allowance (included false), or put it in (true).
   * Only a choice that differs from the cost's default is kept: one the household left out of
   * planning (its planningBaseline 'exclude' ledger edit) is out by default, so putting it in
   * stores false; any other is in by default, so leaving it out stores true. The edit stays.
   */
  function setIrregular(state, id, included) {
    if (typeof id !== 'string' || !id.trim()) fail('Choose a one-time cost.', 'id');
    const key = id.trim();
    const edit = isObj(state.ledgerEdits) ? own(state.ledgerEdits, key) : undefined;
    const outByDefault = isObj(edit) && edit.planningBaseline === 'exclude';
    const value = outByDefault ? (included === false ? undefined : false) : (included === false ? true : undefined);
    return E.state.setPath(state, 'ui.plan.irregularOff.' + key, value);
  }

  /** Add one planned change, or a list of them (e.g. templates.babyFirstYear(dueDate)); each gets an id. */
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

  /**
   * Split an amount saved for `other` before investments had a dial of their own (ui.plan.otherDial
   * 'withInvesting'; tl.migration.other from build): investing is set directly to its baseline
   * (unless it was set directly in the meantime), other to the saved amount minus that baseline,
   * otherDial becomes 'debt', and the note is appended to meta.migrationNotes. With no
   * investments in the baseline only otherDial changes (the amount was all debt & business; no
   * note). Nothing waiting: the state is returned as it is (safe to run twice).
   */
  function splitOther(state, tl) {
    const mig = tl && isObj(tl.migration) && isObj(tl.migration.other) ? tl.migration.other : null;
    const p = planUi(state);
    if (p.otherDial !== 'withInvesting') return state;
    // Nothing is saved for other any more: an amount set from now on is debt & business only.
    if (!isCents(own(p.dials, 'other'))) return E.state.setPath(state, 'ui.plan.otherDial', 'debt');
    // A timeline built for another state: nothing to do with it.
    if (!mig || p.dials.other !== mig.fromCents) return state;
    let next = state;
    // No investments in the baseline: the amount was all debt & business; only the mark changes.
    if (mig.investingCents !== 0 && !isCents(own(p.dials, 'investing'))) next = E.state.setPath(next, 'ui.plan.dials.investing', mig.investingCents);
    if (mig.otherCents !== p.dials.other) next = E.state.setPath(next, 'ui.plan.dials.other', mig.otherCents);
    next = E.state.setPath(next, 'ui.plan.otherDial', 'debt');
    return mig.note ? recordNote(next, mig.note) : next;
  }

  /**
   * Carry over an Essentials or Flexible amount set before imported category names were read as
   * the category they stand for (ui.plan.groupsRead 'exact'; tl.migration.regroupDials from build):
   * while the dial set directly still holds exactly the amount the timeline was built with
   * (`shift.setCents`; changed since: left alone), what moved is added to its regrouping adjustment
   * (ui.plan.dialShift[dial]: cents, and the moved categories) and the note is appended to
   * meta.migrationNotes; the amount set itself never changes. groupsRead becomes 'resolved'.
   * Nothing to carry over (no category moved, both or neither dial set directly): only groupsRead
   * changes, no note. Not marked, or a timeline built without the mark: the state is returned as it
   * is (safe to run twice).
   */
  function regroupDials(state, tl) {
    const p = planUi(state);
    const mig = tl && isObj(tl.migration) && isObj(tl.migration.regroupDials) ? tl.migration.regroupDials : null;
    if (p.groupsRead !== 'exact' || !mig) return state;
    let next = E.state.setPath(state, 'ui.plan.groupsRead', 'resolved');
    const sh = isObj(mig.shift) ? mig.shift : null;
    if (!sh || own(p.dials, sh.dial) !== sh.setCents) return next;
    const cur = own(p.dialShift, sh.dial);
    const names = (isObj(cur) && Array.isArray(cur.categories) ? cur.categories : []).concat(sh.categories.filter(c => !(isObj(cur) && Array.isArray(cur.categories) && cur.categories.includes(c))));
    next = E.state.setPath(next, 'ui.plan.dialShift.' + sh.dial, { cents: (isObj(cur) && isCents(cur.cents) ? cur.cents : 0) + sh.cents, categories: names.slice(-20) });
    return mig.note ? recordNote(next, mig.note) : next;
  }

  // ------------------------------------------------------------------ upgrades the plan screen applies
  // Upgrades inside saved-state version 5 that need a built plan (row ids depend on the data), so
  // state.sanitize cannot run them (its own are BudgetEngine.state.V5_UPGRADES). Like those, each
  // is safe to run twice and leaves a note in meta.migrationNotes.
  const SCREEN_UPGRADES = { migrateRows, regroupDials, migrateDials, splitOther };

  /**
   * What the plan screen must apply once, as one change, for the timeline `tl` it just built:
   * null when nothing is waiting, else { steps, note, apply }:
   *   steps  the upgrades, in order: 'migrateRows' (row changes saved under the earlier card/bank
   *          dials), 'regroupDials' (an Essentials or Flexible amount set before imported category
   *          names were resolved, ui.plan.groupsRead 'exact'), 'migrateDials' (amounts set for the
   *          earlier card/bank dials, from ui.plan.legacyDials) and 'splitOther' (an amount saved
   *          for other before investments had their own dial)
   *   note   tl.migration.note: what to tell the household, once (also the key for "already done")
   *   apply  state => the state with every step applied (in order, each given `tl`);
   *          safe to run twice (the second run changes nothing)
   * @param {object} tl from build
   */
  function pendingUpgrade(tl) {
    const mig = isObj(tl) && isObj(tl.migration) ? tl.migration : null;
    if (!mig) return null;
    const steps = [];
    if ((Array.isArray(mig.rows) && mig.rows.length) || (Array.isArray(mig.dropped) && mig.dropped.length)) steps.push('migrateRows');
    // Before migrateDials: an amount it carries over from the earlier card/bank dials follows the
    // groups as read now, and setting it would end the wait (setDial) before the household's own
    // earlier amount was carried over.
    if (isObj(mig.regroupDials)) steps.push('regroupDials');
    if (isObj(mig.dials)) steps.push('migrateDials');
    if (isObj(mig.other)) steps.push('splitOther');
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
    setDial, setRow, setTarget, resetDial, resetRow, resetPlan, setGroup, moveBlocked, setIrregular, addChange, setChange, removeChange, acceptChanges, migrateRows, migrateDials,
    splitOther, regroupDials, pendingUpgrade, acceptCarriedOver,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
