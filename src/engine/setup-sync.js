'use strict';
/*
 * Setup sync (docs/ARCHITECTURE.md §3 and §7, BudgetEngine.setupSync): the values the household's
 * setup file (the household profile) manages reach a budget that was already saved.
 *
 * A three-way merge between what is saved (S), the profile's values applied last time (B, kept in
 * state.meta.setup.base) and the profile now (P). It runs on every load and workbook import, after
 * the saved budget was checked and upgraded (E.state.sanitize and its V5_UPGRADES), whenever the
 * profile's content hash differs from meta.setup.hash:
 *   - per unit (a list item's field, a map entry, a field of a group, a single value):
 *     S equal to B: the household left it alone here, so the profile's value is taken;
 *     S different from B: the household changed it here, so S is kept;
 *   - a list item (by id) or map entry new in the profile is added; items the household added
 *     (not in B) and items it removed (in B, not in S) stay as they are;
 *   - the setup file never erases: a part of the plan it leaves out is not merged at all; an item,
 *     entry or field it no longer has, or now has as unknown (null) where B had a value, keeps the
 *     saved value (P takes B's value there, so a later file that has it again still flows); items
 *     and entries it dropped are named in a note, and only the household removes them, in the app;
 *   - first run on a budget without meta.setup: B := P, so nothing saved changes (values that
 *     differ from the profile are the household's) and later profile changes flow from there;
 *   - strict: a profile value the normal checks would change is not applied, and a merged item,
 *     entry or value that does not pass them (E.state.defaults' cleaning for the plan,
 *     E.state.cleanPlanUi for ui.plan) is put back as saved; both are named in a note.
 * Equality is deep equality over JSON values, and lists merge by id field by field, maps key by
 * key, so fields added to the format later need no change here. Deterministic and idempotent (a
 * second run changes nothing). Pure: no clock ({ now } is passed in), the input is not changed.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  // ------------------------------------------------------------------ setup-managed paths
  // The parts of the budget the setup file manages, one row each:
  //   path   where it lives in the saved budget; the profile holds it at the same path, except
  //          ui.plan.<field>, which the profile holds as planUi.<field>
  //   kind   'list'   items by id, merged field by field
  //          'map'    entries by key, each entry merged whole
  //          'fields' a group of fields, merged field by field (the same rule as 'map')
  //          'value'  one value, merged whole
  //   label  how the notes name one unit (key: item id, entry key or field; item: the list item)
  //   nested  ('fields' only) keys left to rows of their own further down (merged there, kept here)
  //   quietGone  entries the file leaves out are kept without a note (a file names only some of them)
  // A ui.plan row is used only when this version's ui.plan has that field (E.state.PLAN_UI).
  const MANAGED = [
    { path: 'plan.incomes', kind: 'list' },
    { path: 'plan.bills', kind: 'list' },
    { path: 'plan.debts', kind: 'list' },
    { path: 'plan.savings', kind: 'list' },
    { path: 'plan.changes', kind: 'list' },
    { path: 'plan.people', kind: 'list', label: (k, item) => (isObj(item) && item.name ? item.name + '’s name' : 'a name') },
    { path: 'plan.targets', kind: 'map', label: k => k + ' target' },
    { path: 'plan.settings', kind: 'fields' },
    // The account balances and their dates are maps of their own (per account), so a setup file
    // with one account's balance changes that account only; the group row leaves them to them.
    { path: 'plan.balances', kind: 'fields', nested: ['accounts', 'accountDates'] },
    { path: 'plan.balances.accounts', kind: 'map', label: k => k + ' balance', quietGone: true },
    { path: 'plan.balances.accountDates', kind: 'map', label: k => k + ' balance date', quietGone: true },
    { path: 'ui.plan.dials', kind: 'map', label: (k, _, names) => (names[k] ? names[k] + '’s money in' : words(k)) + ' on the plan' },
    { path: 'ui.plan.rows', kind: 'map', label: () => 'a spending row on the plan' },
    { path: 'ui.plan.groups', kind: 'map', label: k => String(k).replace(/^merchant:/, '') + ' grouping' },
    { path: 'ui.plan.irregularOff', kind: 'map', label: () => 'a one-time cost left out' },
    { path: 'ui.plan.baselineMonths', kind: 'value', label: () => 'months averaged' },
    { path: 'ui.plan.coverFromSavings', kind: 'value', label: () => 'cover from savings' },
    { path: 'ui.plan.investReturnPct', kind: 'value', label: () => 'investment return' }
  ];

  /** Part of the hash: bump it when the merge itself changes, so every budget is merged once more. */
  const SYNC_VERSION = 2;
  const EPOCH = '1970-01-01T00:00:00.000Z';

  /** Words for fields in the notes (any other field: its name split into words). */
  const FIELD_WORDS = {
    label: 'name', monthlyCents: 'amount', cents: 'amount', amountCents: 'amount', targetCents: 'target',
    savedCents: 'saved so far', netPerPaycheckCents: 'take-home pay', jointPerPaycheckCents: 'amount to joint',
    grossPerPaycheckCents: 'gross pay', balanceCents: 'balance', jointCashCents: 'joint cash balance',
    accounts: 'account balances', accountDates: 'account balance dates', aprPct: 'interest rate'
  };

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function words(k) {
    if (has(FIELD_WORDS, k)) return FIELD_WORDS[k];
    return String(k).replace(/Cents$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  }

  /** Deep equality over JSON values; a key holding undefined counts as absent. */
  function eq(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => eq(x, b[i]));
    if (isObj(a)) {
      if (!isObj(b)) return false;
      const ka = Object.keys(a).filter(k => a[k] !== undefined);
      const kb = Object.keys(b).filter(k => b[k] !== undefined);
      return ka.length === kb.length && ka.every(k => has(b, k) && eq(a[k], b[k]));
    }
    return false;
  }

  /** The value as written survives the checks: every part of `raw` is in `cleaned`, unchanged (defaults may add parts). */
  function survivesAsWritten(raw, cleaned) {
    if (Array.isArray(raw)) return Array.isArray(cleaned) && raw.length === cleaned.length && raw.every((x, i) => survivesAsWritten(x, cleaned[i]));
    if (isObj(raw)) return isObj(cleaned) && Object.keys(raw).every(k => raw[k] === undefined || (has(cleaned, k) && survivesAsWritten(raw[k], cleaned[k])));
    return raw === cleaned;
  }

  /** JSON with object keys sorted, so the same content always gives the same hash. */
  function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    return v === undefined ? 'null' : JSON.stringify(v);
  }

  // Row paths are fixed names without special characters, so plain dotted access is enough here.
  function get(obj, path) {
    let cur = obj;
    for (const part of path.split('.')) {
      if (!isObj(cur)) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  function set(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (const part of parts.slice(0, -1)) {
      if (!isObj(cur[part])) cur[part] = {};
      cur = cur[part];
    }
    cur[parts[parts.length - 1]] = value;
  }

  const uiField = row => (row.path.startsWith('ui.plan.') ? row.path.slice('ui.plan.'.length) : null);
  const profilePath = row => (uiField(row) === null ? row.path : 'planUi.' + uiField(row));
  const itemOf = (list, id) => (Array.isArray(list) ? list.find(x => isObj(x) && x.id === id) : undefined);

  const known = v => v !== null && v !== undefined;

  /**
   * The setup file adds and changes values; it never erases one. Where the file is silent (an item,
   * entry or field it does not have) or says "unknown" (null) about something the last file gave a
   * value (B), P takes B's value there, so the merge leaves the saved value as it is. Items and
   * entries the file no longer has, that the budget still holds, are named in `gone`.
   * (A part of the plan the file leaves out entirely is not merged at all: see apply.)
   */
  function keepKnown(row, s, b, p, raw, gone, names) {
    if (row.kind === 'value') return p;
    if (row.kind === 'map' || row.kind === 'fields') {
      const out = isObj(p) ? clone(p) : {};
      const r = isObj(raw) ? raw : {};
      for (const [k, bv] of Object.entries(isObj(b) ? b : {})) {
        if (bv === undefined) continue;
        const silent = r[k] === undefined && !Object.keys(r).some(x => x.trim() === k && r[x] !== undefined);
        if (!silent && (known(out[k]) || !known(bv))) continue;
        if (silent && has(s, k) && !has(out, k) && !row.quietGone) gone.push(unitLabel(row, k, null, null, names));
        out[k] = clone(bv);
      }
      return out;
    }
    const out = Array.isArray(p) ? clone(p) : [];
    const rawItems = Array.isArray(raw) ? raw : [];
    for (const bItem of Array.isArray(b) ? b : []) {
      if (!isObj(bItem)) continue;
      const pItem = itemOf(out, bItem.id);
      const rawItem = rawItems.find(x => isObj(x) && x.id === bItem.id);
      if (!pItem) {
        if (itemOf(s, bItem.id)) gone.push(unitLabel(row, bItem.id, null, bItem, names));
        out.push(clone(bItem));
        continue;
      }
      for (const [k, bv] of Object.entries(bItem)) {
        if (k === 'id' || bv === undefined) continue;
        if ((isObj(rawItem) && rawItem[k] === undefined) || (!known(pItem[k]) && known(bv))) pItem[k] = clone(bv);
      }
    }
    return out;
  }

  /** The rows this version can use: plan rows always, ui.plan rows when ui.plan has the field. */
  function activeRows() {
    const names = new Set((E.state.PLAN_UI || []).map(d => d.name));
    return MANAGED.filter(row => uiField(row) === null || names.has(uiField(row)));
  }

  /**
   * The managed values as a new budget would hold them (the normal checks): the plan through
   * E.state.defaults' cleaning (quiet; keys this version does not know left out), ui.plan through
   * E.state.cleanPlanUi. `source` is profile-shaped ({ plan, household? }). Returns { [path]: value }.
   */
  function checked(source, planUi, rows) {
    const plan = rows.some(row => uiField(row) === null) ? E.state.defaults(source, null).plan : null;
    const ui = E.state.cleanPlanUi(isObj(planUi) ? planUi : {});
    const out = {};
    for (const row of rows) out[row.path] = clone(uiField(row) === null ? get({ plan }, row.path) : ui[uiField(row)]);
    return out;
  }

  // ------------------------------------------------------------------ notes

  const itemName = item => (isObj(item) && typeof item.label === 'string' && item.label.trim() ? item.label.trim()
    : isObj(item) && typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null);

  function unitLabel(row, key, field, item, names) {
    const text = row.label ? row.label(key, item, names)
      : row.kind === 'list' ? (itemName(item) || key) + (field ? ' ' + words(field) : '')
        : words(key);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function shortList(labels) {
    const unique = Array.from(new Set(labels));
    return unique.slice(0, 3).join(', ') + (unique.length > 3 ? ', …' : '');
  }
  const settingsCount = n => n + ' setting' + (n === 1 ? '' : 's');

  // ------------------------------------------------------------------ the profile's values (P)

  /**
   * The profile's value for each row as the merge uses it, plus labels for what could not be used.
   * `clean` is the profile checked (checked()). A value the checks changed (not valid as written)
   * is replaced by B's value there, or S's when B has none, so it changes nothing; a new list item
   * keeps the checked value (its default). A list item without an id of its own cannot be followed
   * and is left out (an item B holds then stays as B has it, so it is not removed).
   */
  function profileValues(profile, rows, clean, S, B, names) {
    const raw = { plan: profile.plan, planUi: profile.planUi };
    const uiReadable = raw.planUi === undefined || isObj(raw.planUi);
    const values = {};
    const invalid = [];
    for (const row of rows) {
      const r = get(raw, profilePath(row));
      const c = clean[row.path];
      const s = S[row.path], b = B[row.path];
      const keep = (bv, sv) => clone(bv !== undefined ? bv : sv);
      const readable = r === undefined || (row.kind === 'list' ? Array.isArray(r) : row.kind === 'value' ? true : isObj(r));
      if (!readable || (!uiReadable && uiField(row) !== null)) {
        invalid.push(row.kind === 'value' ? unitLabel(row, uiField(row), null, null, names) : words(row.path.split('.').pop()));
        values[row.path] = keep(b, s);
        continue;
      }
      if (row.kind === 'value') {
        if (r !== undefined && !survivesAsWritten(r, c)) { invalid.push(unitLabel(row, uiField(row), null, null, names)); values[row.path] = keep(b, s); } else values[row.path] = c;
        continue;
      }
      if (row.kind === 'map' || row.kind === 'fields') {
        const out = clone(c) || {};
        for (const [k0, v] of Object.entries(r || {})) {
          const k = k0.trim();
          if (v === undefined || (has(c, k) && survivesAsWritten(v, c[k]))) continue;
          invalid.push(unitLabel(row, k, null, null, names));
          const sub = keep(has(b, k) ? b[k] : undefined, has(s, k) ? s[k] : undefined);
          if (sub === undefined) delete out[k]; else out[k] = sub;
        }
        values[row.path] = out;
        continue;
      }
      const rawItems = Array.isArray(r) ? r : [];
      const count = new Map();
      for (const it of rawItems) if (isObj(it) && typeof it.id === 'string') count.set(it.id, (count.get(it.id) || 0) + 1);
      const out = [];
      for (const item of Array.isArray(c) ? c : []) {
        if (count.get(item.id) !== 1) continue; // an id the profile did not give itself (made up, or renamed as a repeat)
        const rawItem = rawItems.find(x => isObj(x) && x.id === item.id);
        const bItem = itemOf(b, item.id), sItem = itemOf(s, item.id);
        const value = clone(item);
        for (const k of Object.keys(item)) {
          if (k === 'id' || rawItem[k] === undefined || survivesAsWritten(rawItem[k], item[k])) continue;
          invalid.push(unitLabel(row, item.id, k, item, names));
          if (has(bItem, k)) value[k] = clone(bItem[k]);
          else if (has(sItem, k)) value[k] = clone(sItem[k]);
        }
        out.push(value);
      }
      const reported = new Set();
      for (const rawItem of rawItems) {
        const id = isObj(rawItem) && typeof rawItem.id === 'string' ? rawItem.id : null;
        if (id !== null && (itemOf(out, id) || reported.has(id))) continue;
        if (id !== null) reported.add(id);
        invalid.push(unitLabel(row, id || 'an entry', null, rawItem, names));
        if (id !== null && itemOf(b, id)) out.push(clone(itemOf(b, id)));
      }
      values[row.path] = out;
    }
    return { values, invalid };
  }

  // ------------------------------------------------------------------ the merge

  /**
   * One row's three-way merge. Returns { value, units }: one unit per item field, item added or
   * removed, entry or value, as { key, field?, item?, s, b, p, r } (r: the merged value).
   */
  function mergeRow(row, s, b, p) {
    const units = [];
    const pick = (sv, bv, pv) => clone(eq(sv, bv) ? pv : sv);
    if (row.kind === 'value') {
      const r = pick(s, b, p);
      units.push({ key: uiField(row), s, b, p, r });
      return { value: r, units };
    }
    if (row.kind === 'map' || row.kind === 'fields') {
      const S = isObj(s) ? s : {}, B = isObj(b) ? b : {}, P = isObj(p) ? p : {};
      const out = {};
      const keys = Object.keys(S).concat(Object.keys(P).filter(k => !has(S, k)), Object.keys(B).filter(k => !has(S, k) && !has(P, k)));
      for (const k of keys) {
        const r = pick(S[k], B[k], P[k]);
        if (r !== undefined) out[k] = r;
        units.push({ key: k, s: S[k], b: B[k], p: P[k], r });
      }
      return { value: out, units };
    }
    const S = Array.isArray(s) ? s : [], B = Array.isArray(b) ? b : [], P = Array.isArray(p) ? p : [];
    const out = [];
    const visit = (id, sItem) => {
      const bItem = itemOf(B, id), pItem = itemOf(P, id);
      const unit = { key: id, item: true, s: sItem, b: bItem, p: pItem };
      if (sItem === undefined) {
        // New in the profile: added. In B but not saved: the household removed it; it stays removed.
        unit.r = bItem === undefined ? clone(pItem) : undefined;
        if (unit.r !== undefined) out.push(clone(pItem));
        units.push(unit);
        return;
      }
      if (bItem === undefined) { unit.r = sItem; out.push(clone(sItem)); units.push(unit); return; } // the household's own item
      if (pItem === undefined) {
        // Gone from the profile: removed when unchanged since B (on the fields B has; any others are the household's).
        unit.r = Object.keys(bItem).every(k => eq(sItem[k], bItem[k])) ? undefined : sItem;
        if (unit.r !== undefined) out.push(clone(sItem));
        units.push(unit);
        return;
      }
      const item = clone(sItem);
      for (const k of Object.keys(bItem).concat(Object.keys(pItem).filter(f => !has(bItem, f)))) {
        if (k === 'id') continue;
        const r = pick(sItem[k], bItem[k], pItem[k]);
        if (r === undefined) delete item[k]; else item[k] = r;
        units.push({ key: id, field: k, s: sItem[k], b: bItem[k], p: pItem[k], r });
      }
      out.push(item);
    };
    for (const sItem of S) visit(sItem.id, sItem);
    for (const pItem of P) if (!itemOf(S, pItem.id)) visit(pItem.id, undefined);
    for (const bItem of B) if (!itemOf(S, bItem.id) && !itemOf(P, bItem.id)) visit(bItem.id, undefined);
    return { value: out, units };
  }

  /**
   * Units whose merged value does not pass the normal checks. For a list the whole item is checked
   * (fields depend on each other: a start and an end month), and every changed unit of an item that
   * does not pass is rejected, so it goes back to exactly what was saved.
   */
  function rejectedUnits(row, units, merged, cleaned) {
    const changed = units.filter(u => !eq(u.r, u.s));
    if (row.kind === 'value') return eq(merged, cleaned) ? [] : changed;
    if (row.kind !== 'list') return changed.filter(u => (u.r === undefined ? has(cleaned, u.key) : !(has(cleaned, u.key) && eq(u.r, cleaned[u.key]))));
    const bad = new Set();
    for (const m of Array.isArray(merged) ? merged : []) {
      const c = itemOf(cleaned, m.id);
      // Fields the checks do not know (kept as saved from a newer copy of the app) are not compared.
      if (!c || !Object.keys(c).every(k => eq(m[k], c[k]))) bad.add(m.id);
    }
    return changed.filter(u => bad.has(u.key));
  }

  /** Put one unit's value into a row value (a list item's field, a whole item, an entry or the value). */
  function putUnit(row, value, unit, v, order) {
    if (row.kind === 'value') return clone(v);
    if (row.kind !== 'list') {
      const out = Object.assign({}, value);
      if (v === undefined) delete out[unit.key]; else out[unit.key] = clone(v);
      return out;
    }
    const list = Array.isArray(value) ? value.slice() : [];
    const at = list.findIndex(x => x.id === unit.key);
    if (unit.field) {
      if (at === -1) return list;
      const item = Object.assign({}, list[at]);
      if (v === undefined) delete item[unit.field]; else item[unit.field] = clone(v);
      list[at] = item;
      return list;
    }
    if (v === undefined) return list.filter(x => x.id !== unit.key);
    if (at !== -1) { list[at] = clone(v); return list; }
    // Back in its place: before the first item that comes after it in `order`.
    const ids = (Array.isArray(order) ? order : []).map(x => x.id);
    const pos = ids.indexOf(unit.key);
    const later = pos === -1 ? -1 : list.findIndex(x => ids.indexOf(x.id) > pos);
    if (later === -1) list.push(clone(v)); else list.splice(later, 0, clone(v));
    return list;
  }

  /**
   * Bring the setup file's values into a checked budget (the three-way merge described at the top
   * of this file). Pure: `state` is not changed. Nothing is done (no notes) without a profile, or
   * when the profile's content hash equals meta.setup.hash.
   * @param {object} state a checked State (from E.state.sanitize, loadFromStorage or importWorkbook)
   * @param {object|null} profile the household profile (§3), with its optional planUi
   * @param {{now?: string}} [opts] now: ISO time recorded as meta.setup.appliedAt (and meta.updatedAt when values changed)
   * @returns {{state: object, notes: string[], changed: boolean,
   *   report: null|{first: boolean, updated: string[], kept: string[], invalid: string[], gone: string[]}}}
   *   changed: whether any saved value changed; report: the labels behind the notes (null when nothing ran)
   */
  function apply(state, profile, opts) {
    const none = { state, notes: [], changed: false, report: null };
    if (!isObj(state) || !isObj(state.plan) || !isObj(profile)) return none;
    const now = opts && typeof opts.now === 'string' ? opts.now : null;
    const rows = activeRows();
    const source = { plan: isObj(profile.plan) ? profile.plan : {}, household: profile.household };
    const clean = checked(source, profile.planUi, rows);
    const raw = {};
    for (const row of rows) raw[row.path] = get({ plan: profile.plan, planUi: profile.planUi }, profilePath(row));
    raw.householdPeople = isObj(profile.household) ? profile.household.people : undefined;
    const hash = 'v' + SYNC_VERSION + '-' + E.util.hash(canonical({ rows: rows.map(r => r.path), raw, clean }));
    const setup = isObj(state.meta) && isObj(state.meta.setup) ? state.meta.setup : null;
    const first = !setup || !isObj(setup.base);
    if (!first && setup.hash === hash) return none;

    const names = {};
    for (const person of Array.isArray(state.plan.people) ? state.plan.people : []) if (isObj(person) && typeof person.name === 'string') names[person.id] = person.name;
    const S = {};
    for (const row of rows) S[row.path] = clone(get(state, row.path));
    // B as this version reads it: fields added to the format since it was recorded get their defaults.
    const B = first ? {} : checked({ plan: isObj(get(setup.base, 'plan')) ? setup.base.plan : {} }, get(setup.base, 'ui.plan'), rows);
    const prof = profileValues(profile, rows, clean, S, B, names);
    const P = prof.values;
    // A group row leaves its nested maps to their own rows: merged without them, written back with
    // them as they are (their rows, later in MANAGED, write their own merged values over them).
    const nestedSaved = {};
    const without = (row, v) => { if (!isObj(v)) return v; const o = Object.assign({}, v); for (const k of row.nested) delete o[k]; return o; };
    for (const row of rows.filter(r => r.nested)) {
      nestedSaved[row.path] = {};
      for (const k of row.nested) if (isObj(S[row.path]) && has(S[row.path], k)) nestedSaved[row.path][k] = clone(S[row.path][k]);
      S[row.path] = without(row, S[row.path]);
      if (B[row.path] !== undefined) B[row.path] = without(row, B[row.path]);
      P[row.path] = without(row, P[row.path]);
    }
    // Parts of the plan the file leaves out entirely are not merged this time (nothing saved there
    // changes, and B keeps what it had); elsewhere the file never erases a value (keepKnown).
    const rawAll = { plan: profile.plan, planUi: profile.planUi };
    const skip = new Set(rows.filter(row => get(rawAll, profilePath(row)) === undefined).map(row => row.path));
    const gone = [];
    if (!first) for (const row of rows) if (!skip.has(row.path)) P[row.path] = keepKnown(row, S[row.path], B[row.path], P[row.path], get(rawAll, profilePath(row)), gone, names);
    // First run: the plan came from the profile (E.state.defaults), so B := P and nothing saved
    // changes. ui.plan never came from it (profile.planUi is newer than every saved budget; a new
    // budget starts from the ui.plan defaults), so its B is those defaults: a setting still at its
    // default takes the profile's value, one the household changed is kept.
    const uiDefaults = first ? checked({ plan: {} }, {}, rows) : null;
    const firstRow = row => first && uiField(row) === null;
    const base = {};
    for (const row of rows) base[row.path] = skip.has(row.path) ? (first ? undefined : B[row.path]) : !first ? B[row.path] : firstRow(row) ? P[row.path] : uiDefaults[row.path];

    const merged = {}, units = {};
    for (const row of rows) {
      if (skip.has(row.path)) { merged[row.path] = clone(S[row.path]); units[row.path] = []; continue; }
      const m = mergeRow(row, S[row.path], base[row.path], P[row.path]);
      merged[row.path] = m.value;
      units[row.path] = m.units;
    }

    // The merged values through the normal checks; what does not pass stays as saved, and B keeps
    // its old value there, so a corrected setup file is tried again.
    const check = { plan: {} }, checkUi = {};
    for (const row of rows) {
      if (uiField(row) === null) set(check, row.path, merged[row.path]);
      else checkUi[uiField(row)] = merged[row.path];
    }
    const cleaned = checked(check, checkUi, rows);
    const rejected = [];
    const newBase = {};
    for (const row of rows) {
      if (skip.has(row.path)) { newBase[row.path] = clone(base[row.path]); continue; }
      let value = merged[row.path];
      let baseValue = clone(P[row.path]);
      for (const unit of rejectedUnits(row, units[row.path], merged[row.path], cleaned[row.path])) {
        const item = unit.field ? itemOf(S[row.path], unit.key) : (unit.p || unit.s);
        rejected.push(unitLabel(row, unit.key, unit.field, item, names));
        value = putUnit(row, value, unit, unit.s, S[row.path]);
        baseValue = putUnit(row, baseValue, unit, unit.b, base[row.path]);
        unit.r = clone(unit.s);
      }
      merged[row.path] = value;
      newBase[row.path] = baseValue;
    }

    const updated = [], keptHere = [];
    for (const row of rows) {
      for (const unit of units[row.path]) {
        const item = row.kind !== 'list' ? null : unit.field ? itemOf(S[row.path], unit.key) : (unit.s || unit.p || unit.b);
        const label = () => unitLabel(row, unit.key, unit.field, item, names);
        if (!eq(unit.r, unit.s)) {
          updated.push(label() + (row.kind === 'list' && !unit.field ? (unit.r === undefined ? ' (removed)' : ' (new)') : ''));
          continue;
        }
        // Kept: the profile has (or changed) something else here, and the household's value stays.
        const conflict = firstRow(row) ? (unit.p !== undefined && !eq(unit.s, unit.p)) : (!eq(unit.s, unit.b) && !eq(unit.p, unit.b) && !eq(unit.s, unit.p));
        if (conflict) keptHere.push(label() + (row.kind === 'list' && !unit.field && unit.s === undefined ? ' (removed here)' : ''));
      }
    }

    const next = clone(state);
    for (const row of rows) {
      if (eq(merged[row.path], S[row.path])) continue;
      set(next, row.path, row.nested ? Object.assign({}, merged[row.path], nestedSaved[row.path]) : merged[row.path]);
    }
    const baseOut = {};
    for (const row of rows) set(baseOut, row.path, newBase[row.path]);
    const appliedAt = now || (setup && typeof setup.appliedAt === 'string' ? setup.appliedAt : null) || (isObj(state.meta) && state.meta.updatedAt) || EPOCH;
    next.meta = Object.assign({}, next.meta, { setup: Object.assign({}, setup || {}, { hash, appliedAt, base: baseOut }) });
    const changed = updated.length > 0;
    if (changed && now) next.meta.updatedAt = now;

    const notes = [];
    if (updated.length) {
      notes.push('Your setup file updated ' + settingsCount(updated.length) + ' (' + shortList(updated) + ')' + (keptHere.length ? '; kept ' + keptHere.length + ' you changed here (' + shortList(keptHere) + ').' : '.'));
    } else if (first && keptHere.length) {
      notes.push('Your setup file is now linked to this budget; ' + settingsCount(keptHere.length) + ' here differ from it and were kept (' + shortList(keptHere) + ').');
    } else if (keptHere.length) {
      notes.push('Your setup file changed ' + settingsCount(keptHere.length) + ' you changed here; kept yours (' + shortList(keptHere) + ').');
    }
    if (gone.length) notes.push(gone.length + (gone.length === 1 ? ' entry is' : ' entries are') + ' no longer in your setup file and ' + (gone.length === 1 ? 'was' : 'were') + ' kept here (' + shortList(gone) + '); remove ' + (gone.length === 1 ? 'it' : 'them') + ' in the app if ' + (gone.length === 1 ? 'it is' : 'they are') + ' not needed.');
    const invalid = prof.invalid.concat(rejected);
    if (invalid.length) notes.push('Your setup file has ' + invalid.length + ' value' + (invalid.length === 1 ? '' : 's') + ' this version could not use (' + shortList(invalid) + '); kept what was here.');
    return { state: next, notes, changed, report: { first, updated, kept: keptHere, invalid, gone } };
  }

  /**
   * What the setup file supplied at `path` when it was last applied (B, read as apply reads it:
   * through the normal checks), or undefined when it supplied nothing there (no setup file yet, or
   * a part it left out). `path` is a managed path ('ui.plan.dials') or one key under it
   * ('ui.plan.dials.flexible', 'plan.targets.Groceries'; a list: an item id). What the Plan
   * screen's Reset writes back (timeline.resetDial, resetRow, resetPlan): the saved value then
   * equals B, so later changes to the setup file still reach it (S = B → P).
   */
  function baseValue(state, path) {
    const base = isObj(state) && isObj(state.meta) && isObj(state.meta.setup) && isObj(state.meta.setup.base) ? state.meta.setup.base : null;
    if (!base || typeof path !== 'string') return undefined;
    // The longest managed path it names (plan.balances.accounts before plan.balances).
    const row = activeRows().filter(r => path === r.path || path.startsWith(r.path + '.')).sort((a, b) => b.path.length - a.path.length)[0];
    if (!row || get(base, row.path) === undefined) return undefined;
    const b = checked({ plan: isObj(base.plan) ? base.plan : {} }, get(base, 'ui.plan'), [row])[row.path];
    if (path === row.path) return b;
    const key = path.slice(row.path.length + 1);
    return clone(row.kind === 'list' ? itemOf(b, key) : has(b, key) ? b[key] : undefined);
  }

  // ------------------------------------------------------------------ load paths
  // The page loads and imports through these, so setup sync runs on every load and import, after
  // the saved budget was checked and upgraded.

  /** E.state.loadFromStorage, then apply(). notes: the load's, then the sync's (also in setupNotes). */
  function loadFromStorage(storage, datasetId, profile, dataset, opts) {
    const r = E.state.loadFromStorage(storage, datasetId, profile, dataset, opts);
    const s = apply(r.state, profile, opts);
    return Object.assign({}, r, { state: s.state, notes: (r.notes || []).concat(s.notes), setupNotes: s.notes, setup: s.report });
  }

  /** E.state.importWorkbook, then apply(). Throws as importWorkbook does. */
  function importWorkbook(text, profile, dataset, opts) {
    const r = E.state.importWorkbook(text, profile, dataset, opts);
    const s = apply(r.state, profile, opts);
    return Object.assign({}, r, { state: s.state, notes: (r.notes || []).concat(s.notes), setupNotes: s.notes, setup: s.report });
  }

  E.setupSync = {
    // The setup-managed paths ({ path, kind }), as the table above lists them.
    MANAGED: Object.freeze(MANAGED.map(r => Object.freeze({ path: r.path, kind: r.kind }))),
    SYNC_VERSION,
    apply, loadFromStorage, importWorkbook, baseValue,
    equal: eq
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
