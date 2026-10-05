'use strict';
/*
 * BudgetEngine.timeline: spending by group, the essentials and flexible drill-down (categories,
 * places, pattern badges) and the irregular dial's items (timeline-core.js says how the timeline
 * files fit together).
 *
 * Adds to E._timeline: rowIdOf, spendGroups, drillFor, irregularFor, and the constants
 * TINY_CATEGORY_CENTS, STABLE_MIN_CHARGES, STABLE_SPREAD and OTHER_CATEGORY.
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});
  const T = E._timeline;
  const { isObj, isCents, own, roundCents, median, SPEND_GROUPS, MERCHANT_KEY } = T;

  /** Categories averaging less than this a month (either sign) are grouped into "Other" (when 2 or more). */
  const TINY_CATEGORY_CENTS = 2000;
  /**
   * A regular place is a "stable" bill when it charged at least STABLE_MIN_CHARGES times in the
   * window, about once a month (median charges per month seen = 1), every charge within
   * STABLE_SPREAD of their median. Its plan amount is then its latest charge, not its average.
   */
  const STABLE_MIN_CHARGES = 3;
  const STABLE_SPREAD = 0.1;
  const OTHER_CATEGORY = 'Other';
  /** Words for what one-time costs were, by category (the irregular dial's basis); others are lower-cased. */
  const IRREGULAR_WORDS = {
    'Dental': 'dental work', 'Vision': 'eye care', 'Medical & pharmacy': 'medical bills', 'Travel': 'trips',
    'Home maintenance & repairs': 'repairs', 'Auto maintenance': 'car repairs', 'Property tax & HOA': 'tax',
    'Home improvement': 'home projects', 'Gifts & donations': 'gifts', 'Auto insurance': 'insurance',
    'Home insurance': 'insurance', 'Life insurance': 'insurance', 'Other insurance': 'insurance', 'Fees & interest': 'fees',
  };

  // ------------------------------------------------------------------ spending groups

  /** The group a category is planned in: the household's choice (ui.plan.groups), else the taxonomy's `essential` flag. */
  function categoryGroup(category, cfg) {
    const chosen = own(cfg.groups, category);
    if (SPEND_GROUPS.includes(chosen)) return { group: chosen, source: 'override' };
    return { group: E.categories.isEssential(category) ? 'essentials' : 'flexible', source: 'taxonomy' };
  }

  /** The group a place was moved to as a whole (ui.plan.groups['merchant:' + merchant]), or null. */
  function merchantGroup(merchant, cfg) {
    const chosen = own(cfg.groups, MERCHANT_KEY + String(merchant).trim());
    return SPEND_GROUPS.includes(chosen) ? chosen : null;
  }

  const rowIdOf = (dialKey, kind, ...parts) => dialKey + '-' + kind + '-' + E.util.hash(parts.join('\u0001'));

  /** Split `cents` over a purchase's category parts (splits), in whole cents that add up exactly. */
  function allocate(cents, parts, fallbackCategory) {
    if (!parts.length) return [{ category: fallbackCategory || E.categories.UNCATEGORIZED, cents }];
    const total = parts.reduce((s, p) => s + p.spendCents, 0);
    if (total === cents) return parts.map(p => ({ category: p.category, cents: p.spendCents }));
    if (!total) return [{ category: parts[0].category, cents }];
    let used = 0;
    return parts.map((p, i) => {
      const c = i === parts.length - 1 ? cents - used : Math.round(cents * p.spendCents / total);
      used += c;
      return { category: p.category, cents: c };
    });
  }

  /**
   * One card or bank purchase (a flows spend) split over its categories, each part with the
   * group it is planned in; `moved` when the whole place was moved to a group of its own.
   */
  function sharesOf(x, cents, byId, cfg) {
    const t = byId.get(x.id);
    const parts = t ? E.ledger.partsOf(t) : [];
    const moved = merchantGroup(x.merchant, cfg);
    return allocate(cents, parts, t ? t.category : null).map(sh => ({ category: sh.category, cents: sh.cents, group: moved || categoryGroup(sh.category, cfg).group, moved: !!moved }));
  }

  /**
   * A month's card and bank spending by group: one-time costs (kindOf: id -> flows kind) are
   * irregular, everything else essentials or flexible. The three add up to card + bank.
   */
  function spendGroups(spends, kindOf, byId, cfg) {
    const g = { essentials: 0, flexible: 0, irregular: 0 };
    for (const x of spends || []) {
      if (kindOf.get(x.id) === 'oneTime') { g.irregular += x.cents; continue; }
      for (const sh of sharesOf(x, x.cents, byId, cfg)) g[sh.group] += sh.cents;
    }
    return g;
  }

  // ------------------------------------------------------------------ drill-down (essentials, flexible)

  /**
   * Categories (level 1) and, under each, the places paid regularly plus everything else (level 2),
   * for one spending group. Averages are over the baseline months with one-time costs left out
   * (they are the irregular dial) and yearly bills spread, so: dial baseline = Σ category defaults
   * and category average = Σ its rows' averages, to the cent. A place moved to a group as a whole
   * becomes a category row of its own (synthetic) holding just that place.
   * Every row says how it was paid (paidBy, cardShare) so card and bank totals can be worked out
   * from it; cardCents/bankCents split its plan amount (at its default: card and bank averages
   * exactly; otherwise planCents × cardShare, rounded).
   * Rows changed under the earlier card/bank dials ('card-…', 'bank-…') still apply to the same
   * row when it is paid only that way (returned in `legacy` for migrateRows).
   * Every row lists the transactions behind it in the baseline months (txnIds, newest first; a
   * category: all of its rows'), so the screen can show them and have them recategorized.
   */
  function drillFor(group, base, byId, cfg) {
    const n = base.count;
    const regularAt = base.regularAt || 2;
    const empty = { kind: 'categories', group, rows: [], categoryCount: 0, baselineCents: null, rowsCents: null, baselineCardCents: null, rowsCardCents: null,
      cardShare: 0, overridden: false, stableCount: 0, yearlyCount: 0, orphanIds: Object.keys(cfg.rows).filter(id => id.startsWith(group + '-')), tinyCategoryCents: TINY_CATEGORY_CENTS, legacy: [], superseded: [] };
    if (!n) return empty;
    const cats = new Map();
    const yearly = new Set();
    for (const x of base.spends || []) {
      if (x.kind === 'oneTime') continue;
      const shares = sharesOf(x, x.planCents, byId, cfg);
      // The charge itself (before a yearly bill is spread), split the same way.
      const charges = sharesOf(x, x.cents, byId, cfg);
      shares.forEach((sh, i) => {
        if (sh.group !== group) return;
        const key = sh.moved ? MERCHANT_KEY + x.merchant : sh.category;
        if (!cats.has(key)) cats.set(key, { category: sh.moved ? x.merchant : sh.category, synthetic: sh.moved, merchants: new Map() });
        const merchants = cats.get(key).merchants;
        if (!merchants.has(x.merchant)) merchants.set(x.merchant, { merchant: x.merchant, regular: false, items: [] });
        const m = merchants.get(x.merchant);
        if (x.kind === 'regular' || x.kind === 'yearly' || x.keepRegular) m.regular = true;
        if (x.kind === 'yearly') yearly.add(x.id);
        m.items.push({ id: x.id, date: x.date, month: x.date.slice(0, 7), cents: sh.cents, charge: charges[i] ? charges[i].cents : sh.cents, route: x.role === 'card' ? 'card' : 'bank', category: sh.category });
      });
    }
    // Charges (purchases, not refunds) of a row: one per transaction, oldest first.
    const chargesOf = items => {
      const byTxn = new Map();
      for (const i of items) {
        if (!byTxn.has(i.id)) byTxn.set(i.id, { id: i.id, date: i.date, month: i.month, cents: 0, route: i.route });
        byTxn.get(i.id).cents += i.charge;
      }
      return Array.from(byTxn.values()).filter(c => c.cents > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    };
    /** latestCents, latestDate, seenMonths, ofMonths and stable for one level-2 row (route: how the latest charge was paid). */
    const recency = (items, regular) => {
      const charges = chargesOf(items);
      const last = charges.length ? charges[charges.length - 1] : null;
      const perMonth = new Map();
      for (const c of charges) perMonth.set(c.month, (perMonth.get(c.month) || 0) + 1);
      let stable = false;
      if (regular && charges.length >= STABLE_MIN_CHARGES && median(Array.from(perMonth.values())) === 1) {
        const mid = median(charges.map(c => c.cents));
        stable = mid > 0 && charges.every(c => Math.abs(c.cents - mid) <= mid * STABLE_SPREAD);
      }
      return { facts: { latestCents: regular && last ? last.cents : null, latestDate: regular && last ? last.date : null, seenMonths: perMonth.size, ofMonths: n, stable }, route: last ? last.route : null };
    };
    const stats = items => {
      let card = 0, bank = 0, cardAbs = 0, bankAbs = 0;
      for (const i of items) {
        if (i.route === 'card') { card += i.cents; cardAbs += Math.abs(i.cents); } else { bank += i.cents; bankAbs += Math.abs(i.cents); }
      }
      const cardAvg = E.money.divide(card, n), bankAvg = E.money.divide(bank, n);
      return { total: card + bank, card, bank, cardAbs, bankAbs, cardAvg, bankAvg, avg: cardAvg + bankAvg, months: new Set(items.map(i => i.month)).size, txnCount: new Set(items.map(i => i.id)).size };
    };
    /** The transactions behind a row's items, newest first: one id per transaction, however many parts it has here. */
    const idsOf = items => {
      const dateOf = new Map();
      for (const i of items) if (!dateOf.has(i.id)) dateOf.set(i.id, i.date);
      return Array.from(dateOf.keys()).sort((a, b) => {
        const da = dateOf.get(a), db = dateOf.get(b);
        return da < db ? 1 : da > db ? -1 : a < b ? 1 : a > b ? -1 : 0;
      });
    };
    const paidByOf = st => (st.cardAbs && st.bankAbs ? 'mixed' : st.cardAbs ? 'card' : 'bank');
    const shareOf = st => (st.cardAbs + st.bankAbs ? st.cardAbs / (st.cardAbs + st.bankAbs) : 0);
    const patternOf = (regular, stable, seen) => (regular && stable ? 'bill' : seen >= regularAt ? 'everyday' : 'occasional');
    // Per category: its regular places (in a moved place's own row: that place), and the rest.
    const real = Array.from(cats.values()).map(c => {
      const ms = Array.from(c.merchants.values());
      const ownRow = m => c.synthetic || m.regular;
      const regular = ms.filter(ownRow).map(m => Object.assign({ category: c.category }, m, stats(m.items)));
      const restItems = ms.filter(m => !ownRow(m)).flatMap(m => m.items);
      const rest = restItems.length ? Object.assign({ items: restItems }, stats(restItems)) : null;
      const avg = regular.reduce((s, r) => s + r.avg, 0) + (rest ? rest.avg : 0);
      return { category: c.category, synthetic: c.synthetic, regular, rest, avg, items: ms.flatMap(m => m.items) };
    });
    // Tiny categories (two or more) become one "Other" row; a category called "Other" joins it.
    const tiny = real.filter(c => !c.synthetic && (Math.abs(c.avg) < TINY_CATEGORY_CENTS || c.category === OTHER_CATEGORY));
    const grouped = tiny.length >= 2 ? tiny : [];
    const shown = real.filter(c => !grouped.includes(c)).map(c => ({ label: c.category, synthetic: c.synthetic, members: [c] }));
    shown.sort((a, b) => b.members[0].avg - a.members[0].avg || (a.label < b.label ? -1 : a.label > b.label ? 1 : (a.synthetic ? 1 : -1)));
    if (grouped.length) shown.push({ label: OTHER_CATEGORY, synthetic: false, members: grouped });

    const ov = id => (isObj(own(cfg.rows, id)) ? cfg.rows[id] : null);
    const legacy = [], superseded = [];
    // A row's change: its own id first; else the same row's change under the earlier card/bank
    // dial, when the row is paid only that way (so it holds exactly what that row held).
    const overrideFor = row => {
      const mine = ov(row.id);
      const sameRow = !row.synthetic && row.paidBy !== 'mixed' && !((row.kind === 'category' || row.kind === 'rest') && row.category === OTHER_CATEGORY);
      const lid = sameRow ? row.paidBy + row.id.slice(group.length) : null;
      const old = lid ? ov(lid) : null;
      row.legacyId = null;
      if (old && mine) superseded.push(lid);
      else if (old) { legacy.push({ from: lid, to: row.id }); row.legacyId = lid; }
      return mine || old;
    };
    const rows = [];
    const ids = new Set();
    const defaultCardOf = new Map();
    let overridden = false, stableCount = 0;
    for (const g of shown) {
      const catId = rowIdOf(group, 'c', g.synthetic ? MERCHANT_KEY + g.label : g.label);
      const kids = [];
      for (const c of g.members) {
        for (const m of c.regular) {
          const rec = recency(m.items, m.regular);
          kids.push(Object.assign({ id: rowIdOf(group, 'm', c.synthetic ? MERCHANT_KEY + c.category : c.category, m.merchant), level: 2, parent: catId, label: m.merchant, kind: 'merchant', category: g.label, sourceCategory: c.synthetic ? null : c.category,
            avgCents: m.avg, months: m.months, txnCount: m.txnCount, txnIds: idsOf(m.items), regular: m.regular }, rec.facts, {
            group, synthetic: c.synthetic, paidBy: paidByOf(m), cardShare: shareOf(m), pattern: patternOf(m.regular, rec.facts.stable, rec.facts.seenMonths),
            defaultCard: rec.facts.stable ? (rec.route === 'card' ? rec.facts.latestCents : 0) : m.cardAvg }));
        }
      }
      kids.sort((a, b) => b.avgCents - a.avgCents || (a.label < b.label ? -1 : 1));
      const withRest = g.members.filter(c => c.rest);
      if (withRest.length) {
        const restItems = withRest.flatMap(c => c.rest.items);
        const st = stats(restItems);
        const rec = recency(restItems, false);
        kids.push(Object.assign({ id: rowIdOf(group, 'r', g.label), level: 2, parent: catId, label: (kids.length ? 'Everything else in ' : 'Everything in ') + g.label, kind: 'rest', category: g.label, sourceCategory: null,
          avgCents: withRest.reduce((s, c) => s + c.rest.avg, 0), months: st.months, txnCount: st.txnCount, txnIds: idsOf(restItems), regular: false }, rec.facts, {
          group, synthetic: false, paidBy: paidByOf(st), cardShare: shareOf(st), pattern: patternOf(false, false, rec.facts.seenMonths),
          defaultCard: withRest.reduce((s, c) => s + c.rest.cardAvg, 0) }));
      }
      for (const k of kids) {
        const o = overrideFor(k);
        // Without a change: a stable bill at its latest charge, anything else at its average.
        k.defaultCents = k.stable ? k.latestCents : k.avgCents;
        k.override = o;
        k.included = !(o && o.included === false);
        k.planCents = o && isCents(o.cents) ? o.cents : k.defaultCents;
        k.cardCents = k.planCents === k.defaultCents ? k.defaultCard : roundCents(k.planCents * k.cardShare);
        k.bankCents = k.planCents - k.cardCents;
        defaultCardOf.set(k.id, k.defaultCard);
        delete k.defaultCard;
        if (o) overridden = true;
        if (k.stable) stableCount += 1;
        ids.add(k.id);
      }
      const allItems = g.members.flatMap(c => c.items);
      const st = stats(allItems);
      const seen = new Set(chargesOf(allItems).map(c => c.month)).size;
      const single = g.members.length === 1 ? g.members[0] : null;
      const row = { id: catId, level: 1, parent: null, label: g.label, kind: 'category', category: g.label, sourceCategory: null,
        members: g.synthetic ? [] : g.members.map(c => c.category), avgCents: g.members.reduce((s, c) => s + c.avg, 0), months: st.months, txnCount: st.txnCount,
        // Every transaction of its rows (they share out the category's items): the union of theirs.
        txnIds: idsOf(allItems), regular: false,
        defaultCents: kids.reduce((s, k) => s + k.defaultCents, 0),
        group, synthetic: g.synthetic, merchant: g.synthetic ? g.label : null,
        movedFrom: g.synthetic ? Array.from(new Set(allItems.map(i => i.category))).sort() : [],
        // What setGroup takes to move this row: a category name, or 'merchant:' + place (null for the grouped "Other").
        groupKey: g.synthetic ? MERCHANT_KEY + g.label : single ? single.category : null,
        groupSource: g.synthetic ? 'override' : single ? categoryGroup(single.category, cfg).source : null,
        paidBy: paidByOf(st), cardShare: shareOf(st), seenMonths: seen, ofMonths: n,
        pattern: kids.length && kids.every(k => k.pattern === 'bill') ? 'bill' : seen >= regularAt ? 'everyday' : 'occasional' };
      const o = overrideFor(row);
      if (o) overridden = true;
      ids.add(catId);
      const included = kids.filter(k => k.included);
      const defaultCard = kids.reduce((s, k) => s + defaultCardOf.get(k.id), 0);
      row.override = o;
      row.included = !(o && o.included === false);
      row.planCents = o && isCents(o.cents) ? o.cents : included.reduce((s, k) => s + k.planCents, 0);
      row.cardCents = o && isCents(o.cents)
        ? (o.cents === row.defaultCents ? defaultCard : roundCents(o.cents * row.cardShare))
        : included.reduce((s, k) => s + k.cardCents, 0);
      row.bankCents = row.planCents - row.cardCents;
      defaultCardOf.set(catId, defaultCard);
      rows.push(row, ...kids);
    }
    const categories = rows.filter(r => r.level === 1);
    const on = categories.filter(r => r.included);
    return {
      kind: 'categories', group, rows,
      categoryCount: categories.length,
      baselineCents: categories.reduce((s, r) => s + r.defaultCents, 0),
      rowsCents: on.reduce((s, r) => s + r.planCents, 0),
      baselineCardCents: categories.reduce((s, r) => s + defaultCardOf.get(r.id), 0),
      rowsCardCents: on.reduce((s, r) => s + r.cardCents, 0),
      cardShare: shareOf(stats(real.flatMap(c => c.items))),
      overridden,
      stableCount,
      yearlyCount: yearly.size,
      orphanIds: Object.keys(cfg.rows).filter(id => id.startsWith(group + '-') && !ids.has(id)),
      tinyCategoryCents: TINY_CATEGORY_CENTS,
      legacy, superseded,
    };
  }

  /**
   * The irregular dial's items: every one-time cost of the baseline months (found automatically
   * or marked by the household), in the allowance unless the household left it out
   * (ui.plan.irregularOff). baselineCents = Σ one-time costs ÷ months; rowsCents = Σ those still
   * in ÷ months. One the household counts as regular (planningBaseline 'include') is in its
   * category instead and not listed here. Each item's txnIds is [its own id], like a drill row's.
   */
  function irregularFor(base, byId, cfg) {
    const n = base.count;
    const items = (base.oneTime || []).map(o => {
      const t = byId.get(o.id);
      return {
        id: o.id, txnIds: [o.id], label: o.merchant, date: o.date, month: o.date.slice(0, 7), cents: o.cents, monthlyCents: n ? E.money.divide(o.cents, n) : null,
        included: own(cfg.irregularOff, o.id) !== true, auto: !!o.auto, paidBy: o.role === 'card' ? 'card' : 'bank',
        category: t && typeof t.category === 'string' ? t.category : null, description: o.description, accountLabel: o.accountLabel,
      };
    });
    const sum = (list, f) => list.reduce((s, i) => s + f(i), 0);
    const on = items.filter(i => i.included);
    const card = list => sum(list.filter(i => i.paidBy === 'card'), i => i.cents);
    const cardAbs = sum(items.filter(i => i.paidBy === 'card'), i => Math.abs(i.cents)), allAbs = sum(items, i => Math.abs(i.cents));
    const totalCents = sum(items, i => i.cents);
    // What the costs were, biggest first: "dental work, trips, repairs, tax".
    const byWord = new Map();
    for (const i of items) {
      if (!i.category || i.category === E.categories.UNCATEGORIZED) continue;
      const word = IRREGULAR_WORDS[i.category] || i.category.toLowerCase();
      byWord.set(word, (byWord.get(word) || 0) + i.cents);
    }
    const examples = Array.from(byWord.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(e => e[0]);
    const known = new Set(items.map(i => i.id));
    return {
      kind: 'items', rows: items, count: items.length, includedCount: on.length, leftOutCount: items.length - on.length,
      totalCents, includedCents: sum(on, i => i.cents),
      baselineCents: n ? E.money.divide(totalCents, n) : null,
      rowsCents: n ? E.money.divide(sum(on, i => i.cents), n) : null,
      baselineCardCents: n ? E.money.divide(card(items), n) : null,
      rowsCardCents: n ? E.money.divide(card(on), n) : null,
      cardShare: allAbs ? cardAbs / allAbs : 0,
      overridden: on.length !== items.length,
      orphanIds: Object.keys(cfg.irregularOff).filter(id => !known.has(id)),
      examples,
    };
  }

  Object.assign(T, { rowIdOf, spendGroups, drillFor, irregularFor, TINY_CATEGORY_CENTS, STABLE_MIN_CHARGES, STABLE_SPREAD, OTHER_CATEGORY });
})(typeof globalThis !== 'undefined' ? globalThis : this);
