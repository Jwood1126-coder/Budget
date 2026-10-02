'use strict';
/*
 * Data & privacy: what the page is using, loading private files in this browser (bank CSV
 * exports, a prepared data file, a household profile), saving, backing up and sharing, upgrade
 * notes, reset, and an honest account of where the data lives and who can see it.
 *
 * Routes (every step is its own URL, so Back works):
 *   #/data                          hub: what is loaded, load files, save/back up, privacy, reset
 *   #/data?load=csv                 bank exports: files, their accounts and columns
 *   #/data?load=csv&step=report     import report — nothing changes until "Use this data"
 *   #/data?load=dataset             a prepared data file (.json): summary, then use
 *   #/data?load=profile             a household profile (.json): summary, then use
 *   #/data?load=workbook            a workbook or earlier saved budget: what changes, then replace
 *   #/data?loaded=csv|dataset|profile and #/data?forgot=1   one-line confirmations after a reload
 *
 * Files chosen here are held only in this module's memory until the person chooses to use them.
 * Nothing is sent anywhere: the page's Content-Security-Policy blocks every network request, and
 * this view has no network code. Loaded data is stored with app.useLoadedDataset/useLoadedProfile.
 */
(function (root) {
  const UI = root.BudgetUI;
  const E = root.BudgetEngine;
  const { esc } = UI.dom;
  const fmt = UI.fmt;
  const c = UI.c;

  const TYPE_LABEL = { checking: 'Checking', savings: 'Savings', credit_card: 'Credit card', loan: 'Loan', other: 'Other' };
  const NEW_TYPES = ['checking', 'savings', 'credit_card'];
  const KIND_ROWS = [
    ['spend', 'Spending', 'Purchases, bills and fees; refunds come in'],
    ['income', 'Income', 'Pay, interest and other deposits'],
    ['transfer', 'Transfers and savings', 'Between your own accounts or from a partner'],
    ['card_payment', 'Card payments', 'Paying a card bill: not spending'],
    ['debt_payment', 'Debt payments', 'Loans and financing'],
  ];
  // Most important first; [one, many].
  const FLAG_TEXT = {
    needs_category_review: ['needs a category check', 'need a category check'],
    unpaired_transfer: ['is a transfer or card payment with no matching account in these files', 'are transfers or card payments with no matching account in these files'],
    reimbursement_candidate: ['may have been paid back (a possible reimbursement)', 'may have been paid back (possible reimbursements)'],
    business_candidate: ['may be a business purchase', 'may be business purchases'],
    mixed_retail: ['is from a store that sells many kinds of things (contents are not guessed)', 'are from stores that sell many kinds of things (contents are not guessed)'],
    refund: ['is a refund (it reduces spending)', 'are refunds (they reduce spending)'],
    fee: ['is a bank or card fee', 'are bank or card fees'],
  };
  const RESERVED_IDS = ['sample', 'no-data'];
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
  const EPOCH = '1970-01-01T00:00:00.000Z';

  // ------------------------------------------------------------------ session (memory only)
  function freshCsv() {
    return { files: [], newAccounts: [], rules: null, rulesName: '', rulesInfo: '', rulesError: null, pickError: null, datasetId: null, result: null, error: null, useError: null };
  }
  const S = { csv: freshCsv(), dataset: null, profile: null, workbook: null };
  let seq = 0;
  let pendingFocus = null;
  const analysisCache = new Map();
  let metaCache;

  function rerender(ctx, focusId) {
    if (focusId) pendingFocus = focusId;
    ctx.app.render();
  }

  // ------------------------------------------------------------------ small helpers
  const pad = n => String(n).padStart(2, '0');
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  function localDay(d = new Date()) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dayOf(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : localDay(d);
  }
  function sizeText(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1048576) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
  function dateRange(a, b) {
    if (!a || !b) return 'No dates';
    return a === b ? fmt.date(a) : fmt.date(a) + ' – ' + fmt.date(b);
  }
  /** Same as dateRange, as HTML that may wrap at the dash but never inside a date. */
  function rangeHtml(a, b) {
    if (!a || !b || a === b) return `<span class="nowrap">${esc(dateRange(a, b))}</span>`;
    return `<span class="nowrap">${esc(fmt.date(a))} –</span> <span class="nowrap">${esc(fmt.date(b))}</span>`;
  }
  const count = (n, one, many) => fmt.count(n, one, many);
  const clip = (s, n = 28) => { const t = String(s).trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  function monthList(list) {
    try { return E.compare.describeMonths(list); } catch { return list.map(fmt.month).join(', '); }
  }
  function centsText(cents) {
    const a = Math.abs(cents);
    return (cents < 0 ? '-' : '') + Math.floor(a / 100) + '.' + pad(a % 100);
  }
  function details(id, summary, body, { open = false, cls = '' } = {}) {
    return `<details class="disclosure ${esc(cls)}" id="${esc(id)}"${open ? ' open' : ''}><summary id="${esc(id)}-sum">${summary}</summary><div class="disclosure-body">${body}</div></details>`;
  }
  function uniqueName(name) {
    const taken = new Set(S.csv.files.map(f => f.name));
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    let n = 2;
    while (taken.has(`${stem} (${n})${ext}`)) n++;
    return `${stem} (${n})${ext}`;
  }
  function profileName(profile) {
    return isObj(profile) && isObj(profile.household) && typeof profile.household.name === 'string' && profile.household.name.trim()
      ? profile.household.name.trim() : null;
  }
  function builtInName(ctx) {
    const kind = ctx.build && ctx.build.kind;
    return kind === 'sample' ? 'the built-in fictional sample' : kind === 'private' ? 'the data built into this file' : kind === 'empty' ? 'no data (this copy has none built in)' : 'the built-in data';
  }

  /** "Loaded on …" details kept next to files loaded in this browser (read once per page load). */
  function loadedMeta(app) {
    if (metaCache !== undefined) return metaCache;
    metaCache = { dataset: null, profile: null };
    try {
      const st = app.storage;
      if (!st) return metaCache;
      const tail = text => {
        // The stored value is {"dataset"|"profile": …, "loadedAt": …, …}: read only the tail.
        const i = text ? text.lastIndexOf('"loadedAt":') : -1;
        return i > 0 ? JSON.parse('{' + text.slice(i)) : null;
      };
      metaCache.dataset = tail(st.getItem(app.keys.LOADED_DATASET_KEY));
      metaCache.profile = tail(st.getItem(app.keys.LOADED_PROFILE_KEY));
    } catch { /* unreadable: shown without a date */ }
    return metaCache;
  }

  function savedBudgetExists(ctx, id) {
    try { return !!(ctx.app.storage && ctx.app.storage.getItem(E.state.storageKey(id))); } catch { return false; }
  }

  function datasetIdProblem(id) {
    if (!id) return 'Enter a name for this data set, such as “household”.';
    if (!ID_RE.test(id)) return 'Use letters, numbers, dashes, dots or underscores (no spaces), starting with a letter or a number.';
    if (RESERVED_IDS.includes(id)) return `“${id}” is reserved for the built-in ${id === 'sample' ? 'sample' : 'empty data set'}. Choose another name.`;
    return null;
  }

  function defaultDatasetId(ctx) {
    const id = ctx.dataset.datasetId;
    return !ctx.dataset.isSynthetic && id && !RESERVED_IDS.includes(id) ? id : 'household';
  }

  /** Plain sentence about which budget will be used with a data set name. */
  function budgetNameStatus(ctx, id) {
    if (datasetIdProblem(id)) return '';
    if (id === ctx.dataset.datasetId) return `Your current budget is saved under “${id}”, so it stays with the new data.`;
    if (savedBudgetExists(ctx, id)) return `A budget is already saved under “${id}” in this browser. It will be used with this data.`;
    const name = profileName(ctx.profile);
    const fict = isObj(ctx.profile) && ctx.profile.isSynthetic;
    return `Nothing is saved under “${id}” yet, so the budget will start from the household profile${name ? ` “${name}”` : ''}${fict ? ' (the fictional sample: load your own profile, or edit the plan in Budget afterwards)' : ''}.`;
  }

  // ------------------------------------------------------------------ file pickers
  /** A real file input (keyboard and screen-reader accessible) shown as a button-like label. */
  function filePicker({ id, kind, label, accept, multiple = false, variant = 'secondary', describedBy }) {
    return `<span class="dp-file">
      <input type="file" id="${esc(id)}" class="dp-file-input" data-action="dp:pick" data-kind="${esc(kind)}" accept="${esc(accept)}"${multiple ? ' multiple' : ''}${describedBy ? ` aria-describedby="${esc(describedBy)}"` : ''}>
      <label for="${esc(id)}" class="btn btn-${esc(variant)}">${esc(label)}</label>
    </span>`;
  }
  const ACCEPT = {
    csv: '.csv,.txt,text/csv,text/plain',
    json: '.json,application/json',
    workbook: '.json,.html,.htm,application/json,text/html',
  };

  // ------------------------------------------------------------------ accounts for the CSV import
  function accountOptions(ctx) {
    const existing = (ctx.dataset.accounts || []).map(a => ({ id: a.id, label: a.label, type: a.type, scope: a.scope, ownerId: a.ownerId || null, paidInFull: !!a.paidInFull, origin: 'existing' }));
    return existing.concat(S.csv.newAccounts.map(a => ({ ...a, origin: 'new' })));
  }
  function accountById(ctx, id) { return id ? accountOptions(ctx).find(a => a.id === id) || null : null; }
  function accountText(ctx, a) {
    const owner = a.scope === 'personal' ? 'Personal' + (a.ownerId ? ' (' + ctx.person(a.ownerId) + ')' : '') : 'Joint';
    return (TYPE_LABEL[a.type] || a.type) + ' · ' + owner;
  }
  function slugId(label, taken) {
    let base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'account';
    let id = base, n = 2;
    while (taken.has(id)) id = base + '-' + n++;
    return id;
  }
  const typeFromName = name => (/card|credit|visa|amex|master/i.test(name) ? 'credit_card' : /sav/i.test(name) ? 'savings' : /check|chk/i.test(name) ? 'checking' : null);
  /** Pre-select an account only when the file name points at exactly one account of that type. */
  function guessAccount(ctx, name) {
    const type = typeFromName(name);
    if (!type) return '';
    const list = accountOptions(ctx).filter(a => a.type === type);
    return list.length === 1 ? list[0].id : '';
  }
  function fileByKey(key) { return S.csv.files.find(f => f.key === key) || null; }

  // ------------------------------------------------------------------ per-file reading preview
  const COL_FIELDS = ['date', 'postDate', 'description', 'amount', 'debit', 'credit', 'category'];
  function mappingFor(f) {
    const m = {};
    if (f.cols) {
      const val = v => (f.noHeader ? Number(v) : v);
      const keys = ['date', 'postDate', 'description', 'category'].concat(f.amountStyle === 'split' ? ['debit', 'credit'] : ['amount']);
      for (const k of keys) if (f.cols[k] !== undefined && f.cols[k] !== null && f.cols[k] !== '') m[k] = val(f.cols[k]);
      if (f.noHeader) m.hasHeader = false;
    }
    if (f.dateFormat) m.dateFormat = f.dateFormat;
    if (f.charges) m.chargesPositive = f.charges === 'positive';
    return Object.keys(m).length ? m : undefined;
  }
  function missingColumns(f) {
    if (!f.cols) return [];
    const need = [['date', 'date'], ['description', 'description']].concat(f.amountStyle === 'split' ? [['debit', 'money out'], ['credit', 'money in']] : [['amount', 'amount']]);
    return need.filter(([k]) => f.cols[k] === undefined || f.cols[k] === null || f.cols[k] === '').map(([, label]) => label);
  }

  /** Read one file with its current settings (memoized): rows, dates, columns or the problem. */
  function analyze(ctx, f) {
    const acct = accountById(ctx, f.account);
    const type = acct ? acct.type : 'checking';
    const mapping = mappingFor(f);
    const key = f.key + '|' + type + '|' + JSON.stringify(mapping || null);
    if (analysisCache.has(key)) return analysisCache.get(key);
    let out;
    const missing = missingColumns(f);
    if (missing.length) {
      out = { ok: false, incomplete: true, error: `Choose the ${missing.join(', ')} column${missing.length === 1 ? '' : 's'} below.` };
    } else {
      try {
        const r = E.importer.normalizeFile({ name: f.name, text: f.text, account: { id: 'preview', type }, mapping });
        out = { ok: true, rows: r.rows, count: r.txns.length, start: r.start, end: r.end, skipped: r.skipped, signConvention: r.signConvention, warnings: r.warnings, mapping: r.mapping || {}, headerRow: r.headerRow };
      } catch (err) {
        if (!err || err.name !== 'ValidationError') throw err;
        out = { ok: false, error: friendlyError(err), code: err.code || null };
      }
    }
    analysisCache.set(key, out);
    return out;
  }

  /** Dates skipped under the US order that read fine day first (31/01/2026): suggest that order. */
  function dateOrderSuspect(an) {
    if (!an.mapping || an.mapping.dateFormat !== 'MDY') return false;
    return an.skipped.some(s => {
      const m = /^invalid date "(.*)"$/.exec(String(s.reason));
      return !!(m && E.importer.parseDate(m[1], 'DMY'));
    });
  }

  /** A full date with a plausible year, so a half-typed year (0002) is not judged yet. */
  const plausibleDay = d => E.dates.isDate(d) && d >= '1990-01-01' && d <= '2099-12-31';

  /** Problem with a file's export dates, or ''. */
  function coverProblem(f) {
    const bad = [f.coverageStart, f.coverageEnd].filter(d => d && !plausibleDay(d));
    if (bad.length) return `Check the year: ${bad.map(fmt.date).join(' and ')} ${bad.length === 1 ? 'looks' : 'look'} mistyped.`;
    if (f.coverageStart && f.coverageEnd && f.coverageStart > f.coverageEnd) return 'The end is before the start.';
    return '';
  }

  /** Update a file's date error in place (the fields are not re-rendered while they are typed in). */
  function coverStatus(f) {
    const b = 'dp-f-' + f.key;
    // Only judge complete dates: Chrome reports each part as it is typed (year 0002, 0020, …).
    const typing = [f.coverageStart, f.coverageEnd].some(d => d && d < '1000-01-01');
    const problem = typing ? '' : coverProblem(f);
    const err = document.getElementById(b + '-cover-error');
    if (err) { err.textContent = problem; err.hidden = !problem; }
    for (const id of [b + '-cs', b + '-ce']) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (problem) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    }
  }

  /** The importer words two errors for its config file; say what to do on this page instead. */
  function friendlyError(err) {
    if (err.code === 'SIGN_UNKNOWN') {
      const evidence = /\((purchases [^)]*)\)/.exec(err.message);
      return 'This file does not show whether card charges are positive or negative numbers' + (evidence ? ` (${evidence[1]})` : '') + '. Choose the answer under “Card charges in this file are”.';
    }
    if (err.code === 'UNRECOGNISED_HEADER') return 'The column names in this file were not recognised. Choose the date, description and amount columns under “Columns” below.';
    return err.message;
  }

  function ensureCols(ctx, f) {
    if (f.cols) return;
    const an = analyze(ctx, f);
    f.cols = {};
    if (an.ok && !f.noHeader) for (const k of COL_FIELDS) if (typeof an.mapping[k] === 'string') f.cols[k] = an.mapping[k];
    if (!f.amountStyle) f.amountStyle = an.ok && an.mapping.amount == null && an.mapping.debit != null ? 'split' : 'signed';
  }

  /** Column choices: the header row's names (with an example value) or positions when there is none. */
  function headerCells(f, an) {
    const recs = f.records;
    if (!recs.length) return [];
    if (f.noHeader) {
      return recs[0].fields.map((v, i) => ({ value: String(i), label: 'Column ' + (i + 1) + (v.trim() ? ' — e.g. ' + clip(v) : '') }));
    }
    let idx = -1;
    if (an && an.ok && an.headerRow) idx = recs.findIndex(r => r.line === an.headerRow);
    if (idx < 0) {
      // Exports sometimes start with account details: the header is usually the widest early row.
      const max = Math.max(...recs.map(r => r.fields.length));
      idx = recs.findIndex(r => r.fields.length === max);
    }
    const header = recs[idx].fields, sample = (recs[idx + 1] || { fields: [] }).fields;
    return header.map((h, i) => ({ value: h, label: h.trim() + (sample[i] && sample[i].trim() ? ' — e.g. ' + clip(sample[i]) : '') })).filter(x => x.value.trim() !== '');
  }

  function columnsText(m) {
    if (!m) return '';
    const name = v => (typeof v === 'number' ? 'column ' + (v + 1) : '“' + v + '”');
    const parts = [];
    if (m.postDate != null) parts.push('posted date ' + name(m.postDate), 'transaction date ' + name(m.date));
    else if (m.date != null) parts.push('date ' + name(m.date));
    if (m.description != null) parts.push('description ' + name(m.description));
    if (m.amount != null) parts.push('amount ' + name(m.amount));
    if (m.debit != null) parts.push('money out ' + name(m.debit));
    if (m.credit != null) parts.push('money in ' + name(m.credit));
    if (m.category != null) parts.push('bank category ' + name(m.category));
    return parts.join(', ');
  }

  /** "2 invalid dates": the importer's skip reasons are singular phrases. */
  const reasonCount = (k, n) => `${fmt.number(n)} ${n === 1 ? k : String(k).replace(/\b(date|amount)\b/, '$1s')}`;
  function reasonsText(skipped) {
    const by = {};
    for (const s of skipped) { const k = String(s.reason).replace(/\s*".*$/, ''); by[k] = (by[k] || 0) + 1; }
    return Object.entries(by).map(([k, n]) => reasonCount(k, n)).join(', ');
  }

  // ------------------------------------------------------------------ files: prepare previews
  function firstRecords(text) {
    try { return E.importer.parseCSVRecords(String(text).slice(0, 65536)).slice(0, 32); } catch { return []; }
  }

  function prepareDataset(ctx, file, text) {
    const out = { name: file.name, size: file.size, error: null, dataset: null, warnings: [], legacy: false };
    let raw;
    try { raw = JSON.parse(String(text).replace(/^﻿/, '')); } catch {
      out.error = 'This file is not valid JSON, so it is not a prepared data file. Bank exports (.csv) are loaded with “Choose CSV files”.';
      return out;
    }
    if (isObj(raw) && raw.format === E.state.WORKBOOK_FORMAT) { out.error = 'This is a budget workbook, not a data file. Import it with “Import a workbook” on the Data & privacy page.'; return out; }
    if (isObj(raw) && isObj(raw.plan) && !Array.isArray(raw.transactions)) { out.error = 'This looks like a household profile, not a data file. Load it with “Choose a profile”.'; return out; }
    try {
      out.dataset = E.ledger.normalizeDataset(raw);
      out.legacy = E.ledger.isLegacy(raw);
      out.warnings = E.ledger.validateDataset(raw).warnings || [];
    } catch (err) {
      if (!err || err.name !== 'ValidationError') throw err;
      out.error = err.message;
    }
    return out;
  }

  function prepareProfile(ctx, file, text) {
    const out = { name: file.name, size: file.size, error: null, profile: null, notes: [], preview: null };
    let raw;
    try { raw = JSON.parse(String(text).replace(/^﻿/, '')); } catch { out.error = 'This file is not valid JSON, so it cannot be a household profile.'; return out; }
    if (!isObj(raw)) { out.error = 'This file is not a household profile.'; return out; }
    if (raw.format === E.state.WORKBOOK_FORMAT) { out.error = 'This is a budget workbook, not a household profile. Import it with “Import a workbook” on the Data & privacy page.'; return out; }
    if (Array.isArray(raw.transactions)) { out.error = 'This file holds transactions, so it is a data file, not a household profile. Load it with “Choose a data file”.'; return out; }
    if (!isObj(raw.plan)) { out.error = 'This file has no “plan” section, so it is not a household profile.'; return out; }
    if (raw.schemaVersion !== 1) out.notes.push(`The profile format version is ${raw.schemaVersion === undefined ? 'missing' : JSON.stringify(raw.schemaVersion)} (expected 1). It was read anyway.`);
    try {
      const templates = Array.isArray(raw.scenarios) ? raw.scenarios : [];
      const check = E.state.sanitize({
        version: E.state.VERSION, datasetId: ctx.dataset.datasetId, plan: raw.plan,
        scenarios: [{ id: E.state.BASELINE_ID, name: E.state.BASELINE_NAME, events: [] }].concat(templates),
      }, null, ctx.dataset);
      out.notes.push(...check.notes);
      out.preview = E.state.defaults(raw, ctx.dataset);
    } catch (err) {
      out.error = 'This profile could not be read: ' + (err && err.message ? err.message : String(err));
      return out;
    }
    out.profile = raw;
    return out;
  }

  function prepareWorkbook(ctx, file, text) {
    const out = { name: file.name, size: file.size, error: null, state: null, notes: [], kind: 'unknown', sourceDatasetId: null, exportedAt: null };
    const trimmed = String(text).replace(/^﻿/, '').trim();
    if (trimmed[0] === '<') out.kind = 'page';
    else {
      try {
        const d = JSON.parse(trimmed);
        // Other files of this app chosen here by mistake: say where they belong.
        if (isObj(d) && Array.isArray(d.transactions)) { out.error = 'This is a data file with transactions, not a workbook. Load it with “Choose a data file” under “Load your own files”.'; return out; }
        if (isObj(d) && isObj(d.plan) && isObj(d.household)) { out.error = 'This is a household profile, not a workbook. Load it with “Choose a profile” under “Load your own files”.'; return out; }
        if (isObj(d) && (Array.isArray(d.merchantRules) || Array.isArray(d.transferHints) || isObj(d.categoryMap))) { out.error = 'This is a rules file for importing bank exports, not a workbook. Choose it while loading CSV files.'; return out; }
        if (isObj(d) && d.format === E.state.WORKBOOK_FORMAT) {
          out.kind = 'workbook';
          out.sourceDatasetId = d.datasetId || (isObj(d.state) ? d.state.datasetId : null) || null;
          out.exportedAt = typeof d.exportedAt === 'string' && d.exportedAt !== EPOCH ? d.exportedAt : null;
        } else if (isObj(d) && d.version === E.state.VERSION) {
          out.kind = 'state';
          out.sourceDatasetId = d.datasetId || null;
        } else out.kind = 'earlier';
      } catch { /* importWorkbook explains */ }
    }
    try {
      const r = E.state.importWorkbook(String(text), ctx.profile, ctx.dataset, { now: new Date().toISOString() });
      out.state = r.state;
      out.notes = r.notes || [];
    } catch (err) {
      if (!err || err.name !== 'ValidationError') throw err;
      out.error = err.message;
    }
    return out;
  }

  // ------------------------------------------------------------------ hub: what this page is using
  function dataSourceInfo(ctx, meta) {
    const kind = (ctx.build && ctx.build.kind) || 'unknown';
    const ds = ctx.dataset;
    const badge = ds.isSynthetic ? c.badge('Fictional', 'info') : ds.transactions.length ? c.badge('Household data', 'neutral') : '';
    if (ctx.app.dataSource === 'browser') {
      const d = meta.dataset;
      const when = d && d.loadedAt && dayOf(d.loadedAt) ? ' on ' + fmt.date(dayOf(d.loadedAt)) : '';
      const from = d && d.source === 'csv' ? ' from ' + count(Array.isArray(d.files) ? d.files.length : 0, 'CSV file')
        : d && d.source === 'json' ? ' from ' + (d.file ? '“' + d.file + '”' : 'a prepared data file') : '';
      if (ctx.app.datasetError) return { title: 'Files loaded in this browser could not be read', detail: `Loaded${when}${from}. No transactions are shown until you forget them or load the files again.`, badge: c.badge('Not in use', 'bad') };
      return { title: 'Files loaded in this browser', detail: `Loaded${when}${from}. Used instead of ${builtInName(ctx)} until you choose Forget.`, badge };
    }
    if (kind === 'sample') return { title: 'Built-in sample', detail: 'A fictional household. Every name, merchant and amount is invented.', badge };
    if (kind === 'private') return { title: 'Private build', detail: 'Your data is inside this HTML file. Anyone who has the file can read it.', badge };
    if (kind === 'empty') return { title: 'None yet', detail: 'This copy has no built-in transactions. Load your files below.', badge: '' };
    return { title: 'Built into this page', detail: '', badge };
  }

  function profileFact(ctx, meta) {
    const p = ctx.profile;
    if (!isObj(p)) return '<strong>None</strong><span class="dp-fact-sub">The budget starts empty. Enter it in Budget, or load a profile below.</span>';
    const where = ctx.app.profileSource === 'browser'
      ? 'Loaded in this browser' + (meta.profile && meta.profile.loadedAt && dayOf(meta.profile.loadedAt) ? ' on ' + fmt.date(dayOf(meta.profile.loadedAt)) : '')
      : 'Built into this page';
    const mixed = p.isSynthetic && !ctx.dataset.isSynthetic && ctx.dataset.transactions.length > 0;
    return `<strong>${esc(profileName(p) || 'Unnamed household')}</strong> ${p.isSynthetic ? c.badge('Fictional', 'info') : ''}<span class="dp-fact-sub">${esc(where)}. The budget starts from it, and Reset returns to it.</span>` +
      (mixed ? `<span class="dp-fact-sub tone-warn">Your transactions are real but this profile is the fictional sample, so the plan’s pay, bills and targets are invented until you change them. Load your own profile below, or edit the plan in Budget.</span>` : '');
  }

  function budgetFact(ctx) {
    const m = ctx.state.meta || {};
    const last = m.updatedAt && m.updatedAt !== EPOCH ? dayOf(m.updatedAt) : null;
    const status = ctx.app.storageOk ? c.badge('Saved in this browser', 'good') : c.badge('Not saved', 'bad');
    const migrated = m.migratedFrom !== null && m.migratedFrom !== undefined;
    const sub = [
      last ? 'Last change ' + fmt.date(last) + '.' : '',
      ctx.app.storageOk ? '' : 'Browser storage is not available here: export a workbook to keep your changes.',
      migrated ? 'Carried over from the earlier version (see Upgrade notes).' : '',
    ].filter(Boolean).join(' ');
    return status + (sub ? `<span class="dp-fact-sub">${esc(sub)}</span>` : '');
  }

  function coverageText(a) {
    const ranges = a.coverage || [];
    if (!ranges.length) return '<span class="tone-warn">No export covers it</span><small>Its months count as incomplete until one does.</small>';
    return ranges.map(r => rangeHtml(r.start, r.end)).join('<br>') + (ranges.length > 1 ? `<small>Gap between exports: those days count as incomplete.</small>` : '');
  }

  /** Files read for a data set (import log) or an import report: one row per file. */
  function fileTable(ctx, files, labelFor, caption, { showSigns = true } = {}) {
    const skippedOf = f => (f.skippedReasons && Object.keys(f.skippedReasons).length ? `<small>${esc(Object.entries(f.skippedReasons).map(([k, n]) => reasonCount(k, n)).join(', '))}</small>` : '');
    return c.table({
      caption,
      cls: 'dp-filetable',
      columns: [
        {
          key: 'file', label: 'File', cls: 'dp-col-file', html: f => `<span class="dp-fn">${esc(f.name)}</span><small>${esc(labelFor(f.accountId))} · ${esc(dateRange(f.start, f.end))}</small>` +
            // Phones show the counts here instead of in the narrow number columns.
            `<span class="dp-fstats">Read ${esc(fmt.number(f.rows))} · imported ${esc(fmt.number(f.imported))} · <strong>${esc(fmt.number(f.duplicatesRemoved || 0))} duplicates removed</strong> · skipped ${esc(fmt.number(f.skipped || 0))}</span>` +
            (f.coverageStart && f.coverageEnd && (f.coverageStart !== f.start || f.coverageEnd !== f.end) ? `<small>Counted as covering ${esc(dateRange(f.coverageStart, f.coverageEnd))}</small>` : '') +
            (showSigns && f.signConvention ? `<small>Amounts: ${esc(f.signConvention)}</small>` : ''),
        },
        { key: 'rows', label: 'Read', align: 'right', html: f => esc(fmt.number(f.rows)) },
        { key: 'imported', label: 'Imported', align: 'right', html: f => esc(fmt.number(f.imported)) },
        { key: 'dupes', label: 'Duplicates', align: 'right', html: f => esc(fmt.number(f.duplicatesRemoved || 0)) },
        { key: 'skipped', label: 'Skipped', align: 'right', html: f => esc(fmt.number(f.skipped || 0)) + skippedOf(f) },
      ],
      rows: files,
    });
  }

  /** Account, its transactions (linked when the data is in use) and the dates its exports cover. */
  function accountsTable(ctx, accounts, countOf, { caption, href } = {}) {
    return c.table({
      caption,
      cls: 'dp-accounts',
      columns: [
        {
          key: 'acct', label: 'Account', html: a => {
            const n = countOf(a);
            const name = href && n ? `<a href="${esc(href(a))}">${esc(a.label)}<span class="sr-only">: ${esc(count(n, 'transaction'))}</span></a>` : esc(a.label);
            return `${name}<small>${esc(accountText(ctx, a))} · ${esc(count(n, 'transaction'))}</small>`;
          },
        },
        { key: 'cov', label: 'Covered by exports', html: a => coverageText(a) },
      ],
      rows: accounts,
    });
  }

  function usingCard(ctx) {
    const ds = ctx.dataset;
    const meta = loadedMeta(ctx.app);
    const src = dataSourceInfo(ctx, meta);
    const months = ctx.months;
    const partial = months.filter(m => (ctx.coverageMap[m] || {}).status !== 'full');
    const counts = new Map();
    for (const t of ds.transactions) counts.set(t.accountId, (counts.get(t.accountId) || 0) + 1);
    const n = ds.transactions.length;
    const notCounted = ctx.txns.filter(t => t.excluded).length;
    const facts = [
      ['Transactions', `<strong>${esc(src.title)}</strong> ${src.badge}${src.detail ? `<span class="dp-fact-sub">${esc(src.detail)}</span>` : ''}`],
      ['Data set name', `<code class="dp-code">${esc(ds.datasetId)}</code><span class="dp-fact-sub">Your budget is saved in this browser under this name.</span>`],
      ['Dates', months.length ? `${esc(fmt.month(months[0]))} – ${esc(fmt.month(months[months.length - 1]))}${ds.generatedAt ? `<span class="dp-fact-sub">Prepared ${esc(fmt.date(ds.generatedAt))}</span>` : ''}` : 'No transactions yet'],
      ['Records', n ? `<a href="${esc(ctx.href('spending', { period: 'all', list: '1', kind: 'all', show: 'excluded' }))}">${esc(count(n, 'transaction'))}</a> in ${esc(count(ds.accounts.length, 'account'))}${notCounted ? `<span class="dp-fact-sub">${esc(fmt.number(notCounted))} of them ${notCounted === 1 ? 'is' : 'are'} not counted in totals (marked as a duplicate, reimbursed or business, or left out by a what-if setting). The list shows them struck through.</span>` : ''}` : `0 transactions${ds.accounts.length ? ' in ' + esc(count(ds.accounts.length, 'account')) : ''}`],
      ['Complete months', months.length ? `${months.length - partial.length} of ${months.length}${partial.length ? `<span class="dp-fact-sub">Incomplete: ${esc(monthList(partial))}. They are left out of usual-spending averages. <a href="${esc(ctx.href('review', { queue: 'coverage' }))}">See which accounts are missing days</a>.</span>` : '<span class="dp-fact-sub">Every month has every spending account covered.</span>'}` : '—'],
      ['Household profile', profileFact(ctx, meta)],
      ['Your budget', budgetFact(ctx)],
    ];
    const factList = `<dl class="dp-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
    const accounts = ds.accounts.length ? `<h3 class="dp-sub dp-accounts-h">Accounts</h3>${accountsTable(ctx, ds.accounts, a => counts.get(a.id) || 0, {
      caption: 'Accounts in the data, their transactions and the dates their exports cover',
      href: a => ctx.href('spending', { period: 'all', list: '1', acct: a.id, kind: 'all', show: 'excluded' }),
    })}` : '';
    const labelFor = id => { const a = ds.accounts.find(x => x.id === id); return a ? a.label : id; };
    const log = Array.isArray(ds.importLog) && ds.importLog.length
      ? details('dp-importlog', `How the files were imported (${count(ds.importLog.length, 'file')})`,
        fileTable(ctx, ds.importLog.map(f => ({ ...f, name: f.file })), labelFor, 'Files read for this data, with rows imported, duplicates removed and rows skipped'))
      : '';
    const notes = Array.isArray(ds.notes) && ds.notes.length
      ? details('dp-dsnotes', `Notes saved with the data (${ds.notes.length})`, `<ul class="dp-notes">${ds.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`) : '';
    // Upgrade notes have their own card: list only the other notes from opening the page.
    const upgradeNotes = new Set((ctx.state.meta && ctx.state.meta.migrationNotes) || []);
    const openNotes = (ctx.app.loadNotes || []).filter(x => !upgradeNotes.has(x));
    const loadNotes = openNotes.length
      ? details('dp-loadnotes', `Notes from opening this page (${openNotes.length})`, `<ul class="dp-notes">${openNotes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`) : '';
    const err = ctx.app.datasetError ? c.notice({
      tone: 'bad', title: 'The loaded data could not be read',
      body: esc(ctx.app.datasetError) + '<br>The page is showing no transactions instead. Forget the loaded files to go back to the built-in data, or load the files again.',
      actions: ctx.app.dataSource === 'browser' ? c.button('Forget files loaded in this browser…', { action: 'dp:forget', variant: 'danger', cls: 'btn-small', id: 'dp-forget-error' }) : '',
    }) : '';
    return c.card(`${err ? `<div class="dp-using-error">${err}</div>` : ''}<div class="dp-using-grid"><div>${factList}</div><div>${accounts}<div class="dp-more">${log}${notes}${loadNotes}</div></div></div>`, {
      title: 'What this page is using', id: 'dp-using',
      subtitle: 'The transactions, profile and saved budget behind every number in this app.',
    });
  }

  // ------------------------------------------------------------------ hub: load your files
  function loadCard(ctx) {
    const meta = loadedMeta(ctx.app);
    const loadedData = ctx.app.dataSource === 'browser';
    const loadedProfile = ctx.app.profileSource === 'browser';
    const loader = (id, title, text, picker) => `<li class="dp-loader">
        <div class="dp-loader-text"><h3 id="${esc(id)}-h">${esc(title)}</h3><p id="${esc(id)}-help">${text}</p></div>
        <div class="dp-loader-action">${picker}</div>
      </li>`;
    const loaders = `<ul class="dp-loaders">
      ${loader('dp-load-csv', 'Bank and card exports (CSV)', 'Download CSV files from your bank and card websites: one or more per account. You choose the account for each file and check an import report before anything changes.',
        filePicker({ id: 'dp-pick-csv', kind: 'csv', label: 'Choose CSV files…', accept: ACCEPT.csv, multiple: true, variant: 'primary', describedBy: 'dp-load-csv-help' }))}
      ${loader('dp-load-dataset', 'Prepared data file (JSON)', 'Made by the command-line import (<code>budget-data.json</code>), or the data file of the earlier version.',
        filePicker({ id: 'dp-pick-dataset', kind: 'dataset', label: 'Choose a data file…', accept: ACCEPT.json, describedBy: 'dp-load-dataset-help' }))}
      ${loader('dp-load-profile', 'Household profile (JSON)', 'Names, pay, bills, targets and goals to start your budget from (<code>household-profile.json</code>).',
        filePicker({ id: 'dp-pick-profile', kind: 'profile', label: 'Choose a profile…', accept: ACCEPT.json, describedBy: 'dp-load-profile-help' }))}
    </ul>`;
    const dataLine = loadedData
      ? (() => {
        const d = meta.dataset;
        const when = d && d.loadedAt && dayOf(d.loadedAt) ? fmt.date(dayOf(d.loadedAt)) : 'earlier';
        if (ctx.app.datasetError) return `Loaded ${esc(when)}, but the data could not be read, so it is not in use (see above).`;
        return `Loaded ${esc(when)}: ${esc(count(ctx.dataset.transactions.length, 'transaction'))}, data set “${esc(ctx.dataset.datasetId)}”.`;
      })()
      : `Nothing loaded. Using ${esc(builtInName(ctx))}.`;
    const profileLine = loadedProfile
      ? `Loaded${meta.profile && meta.profile.loadedAt && dayOf(meta.profile.loadedAt) ? ' ' + esc(fmt.date(dayOf(meta.profile.loadedAt))) : ''}: “${esc(profileName(ctx.profile) || 'Unnamed household')}”.`
      : `Nothing loaded. Using the profile built into this page${profileName(ctx.profile) ? ` (“${esc(profileName(ctx.profile))}”)` : ''}.`;
    const status = `<div class="dp-loaded">
      <h3>Loaded in this browser</h3>
      <dl class="dp-facts dp-facts-tight"><dt>Transactions</dt><dd>${dataLine}</dd><dt>Profile</dt><dd>${profileLine}</dd></dl>
      ${loadedData || loadedProfile
        ? `<div class="dp-actions">${c.button('Forget files loaded in this browser…', { action: 'dp:forget', variant: 'danger', id: 'dp-forget' })}</div><p class="fine">The page goes back to ${esc(builtInName(ctx))}. Budgets saved in this browser are kept.</p>`
        : ''}
    </div>`;
    const tip = `<p class="fine dp-tip">Several years of exports may not fit in browser storage. Then use the command-line import (<code>node tools/import.cjs</code>) and build a private copy (<code>node tools/build.cjs</code>): it carries the data inside the page file itself.</p>`;
    return c.card(loaders + status + tip, {
      title: 'Load your own files', id: 'dp-load',
      subtitle: 'Read on this device. Nothing is uploaded, and nothing changes until you have checked what was read.',
    });
  }

  // ------------------------------------------------------------------ hub: save, share, back up
  function saveCard(ctx) {
    const m = ctx.state.meta || {};
    const last = m.updatedAt && m.updatedAt !== EPOCH ? dayOf(m.updatedAt) : null;
    const status = ctx.app.storageOk
      ? `<p class="dp-status">${c.badge('Saved in this browser', 'good')}${last ? ` <span class="fine">Last change ${esc(fmt.date(last))}</span>` : ''}</p>`
      : c.notice({ tone: 'bad', title: 'Changes are not being saved', body: 'This browser is not letting the page store anything (for example a private window, or blocked site data). Export a workbook before you close the page.' });
    const hasTxns = ctx.txns.length > 0;
    const body = `${ctx.app.storageOk ? '' : status}<ul class="dp-points">
        <li><strong>${ctx.app.storageOk ? 'Saved automatically, in this browser only.' : 'Normally saved automatically, in this browser only.'}</strong> ${ctx.app.storageOk ? 'Every change is kept in this browser’s storage on this device.' : 'Right now nothing is kept: see above.'}</li>
        <li><strong>Not shared.</strong> Your partner’s browser and your other devices do not see these changes.</li>
        <li><strong>Easy to lose.</strong> Clearing browser data (history, cookies and site data) deletes them. Private or incognito windows may not keep them after closing.</li>
      </ul>
      ${ctx.app.storageOk ? status : ''}
      <div class="dp-task">
        <h3>Export workbook</h3>
        <p>A workbook file holds your plan, scenarios, transaction corrections and reconciliation references. It does not hold the transactions themselves. Use it as a backup, or to move your budget to the other device.</p>
        <div class="dp-actions">${c.button('Export workbook', { action: 'dp:export-workbook', variant: 'primary', id: 'dp-export-wb' })}</div>
      </div>
      <div class="dp-task">
        <h3>Import a workbook</h3>
        <p id="dp-import-help">A workbook from the other device, a budget saved by the earlier version, or a page downloaded from the earlier version (.html). You see what will change before anything is replaced.</p>
        <div class="dp-actions">${filePicker({ id: 'dp-pick-workbook', kind: 'workbook', label: 'Choose a workbook…', accept: ACCEPT.workbook, describedBy: 'dp-import-help' })}</div>
      </div>
      <div class="dp-task">
        <h3>Corrected transactions (CSV)</h3>
        <p id="dp-csv-out-help">Every transaction with its category, the original bank category, why it has that category, flags, whether it is counted, and the reasons for your corrections. Opens in any spreadsheet.</p>
        <div class="dp-actions">${c.button('Download transactions (CSV)', { action: 'dp:export-csv', id: 'dp-export-csv', disabled: !hasTxns })}${hasTxns ? '' : '<span class="fine">No transactions are loaded.</span>'}</div>
      </div>
      <div class="dp-task">
        <h3>Print</h3>
        <p>Opens Budget and your browser’s print window. On any page you can also use the browser’s Print command (Ctrl+P, or ⌘P on a Mac); navigation and buttons are left out of the printout.</p>
        <div class="dp-actions">${c.button('Print the budget', { action: 'dp:print', id: 'dp-print' })}</div>
      </div>`;
    return c.card(body, { title: 'Save, share and back up', id: 'dp-save', subtitle: 'How your changes are kept, and how to back them up or move them.' });
  }

  function upgradeCard(ctx) {
    const meta = ctx.state.meta || {};
    const notes = Array.isArray(meta.migrationNotes) ? meta.migrationNotes : [];
    const migrated = meta.migratedFrom !== null && meta.migratedFrom !== undefined;
    if (!migrated && !notes.length && !meta.legacySnapshot) return '';
    const from = !migrated ? 'an earlier version of this app'
      : meta.migratedFrom === 0 ? 'a budget saved by the earlier version (from before it numbered its saved budgets)'
        : `a budget saved by the earlier version (saved-budget version ${meta.migratedFrom})`;
    const body = `<p>This budget was carried over from ${esc(from)}. Every earlier value was either carried over or is named in these notes.</p>
      ${notes.length ? details('dp-upgrade-notes', `What was carried over or changed (${count(notes.length, 'note')})`, `<ul class="dp-notes">${notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`) : ''}
      <p class="dp-gap">Data the earlier version saved in this browser is left untouched: this app only reads it, and never changes or deletes it.</p>
      ${meta.legacySnapshot ? `<div class="dp-actions">${c.button('Download the pre-upgrade backup', { action: 'dp:backup-download', id: 'dp-backup' })}</div><p class="fine">The earlier saved budget exactly as it was found, as a file you can keep. It may contain household financial details.</p>` : ''}`;
    return c.card(body, { title: 'Upgrade notes', id: 'dp-upgrade', subtitle: 'What happened to the budget saved by the earlier version.' });
  }

  function privacyCard(ctx) {
    const option = (title, badges, text) => `<li class="dp-option"><div class="dp-option-head"><h4>${esc(title)}</h4><span class="dp-option-badges">${badges}</span></div><p>${text}</p></li>`;
    const body = `<h3 class="dp-sub dp-first">Where your data is</h3>
      <ul class="dp-points">
        <li><strong>No network requests.</strong> The page’s security policy blocks connections to any server, so nothing you load or type can be sent anywhere. No analytics, no tracking, no bank connection.</li>
        <li><strong>Files are read on this device.</strong> Files you choose to use are kept in this browser’s storage until you choose Forget.</li>
        <li><strong>Anyone using this browser can see it.</strong> Nothing here is password-protected. Someone with this device and browser profile can open the page.</li>
        <li><strong>Private builds and downloads contain your financial data.</strong> That includes workbooks, CSV exports and backups. Keep them on your own devices. Do not commit them, upload them or post them anywhere.</li>
        <li><strong>The code repository is public.</strong> Only the fictional sample household belongs there. Your exports, profile, rules and private builds stay in the git-ignored <code>private/</code> folder.</li>
        ${ctx.build && ctx.build.kind === 'private' ? '<li><strong>This page is a private build.</strong> Your transactions are inside this file: treat the file itself as private.</li>' : ''}
      </ul>
      <h3 class="dp-sub">Sharing between the two of you</h3>
      <p>Nothing is set up for automatic sharing. These are options to decide on together; none of them is built.</p>
      <ul class="dp-options">
        ${option('Pass workbook files to each other', `${c.badge('Free', 'good')} ${c.badge('No approval needed', 'neutral')}`,
          'Export a workbook after making changes and import it on the other device, through a channel only the two of you use. Manual, and the last import wins: changes made on both devices are not merged.')}
        ${option('A small self-hosted sync service with sign-in', `${c.badge('Paid hosting', 'warn')} ${c.badge('Needs approval', 'warn')}`,
          'Automatic sharing between your devices. It needs approval first, a decision on where to host it and who pays, sign-in for both of you, and backups. This page would need network code, which it deliberately does not have.')}
        ${option('An end-to-end encrypted file in a shared cloud folder', `${c.badge('Usually no extra cost', 'good')} ${c.badge('Needs a tool decision', 'info')}`,
          'Keep the workbook encrypted, with a passphrase only you two know, in a cloud folder you already share. The provider cannot read it. Still manual, and you need to choose an encryption tool you both trust.')}
      </ul>
      <p class="fine">Proposal only: nothing has been set up, and this page sends nothing anywhere.</p>`;
    return c.card(body, { title: 'Privacy and sharing', id: 'dp-privacy', subtitle: 'Who can see your data, and ways to share the budget between you.' });
  }

  function resetCard(ctx) {
    const name = profileName(ctx.profile);
    const body = `<p>Replace the budget saved in this browser for “${esc(ctx.dataset.datasetId)}” with the starting values from the household profile${name ? ` “${esc(name)}”` : ''}. Plan changes, scenarios, corrections and references are replaced. Transactions and loaded files are not affected.</p>
      <div class="dp-actions">${c.button('Reset to the household profile…', { action: 'dp:reset', variant: 'danger', id: 'dp-reset' })}</div>
      <p class="fine">You are asked to confirm first, and you can undo it straight after (until this page is closed).</p>`;
    return c.card(body, { title: 'Start over', id: 'dp-reset-card' });
  }

  function hub(ctx) {
    const p = ctx.route.params;
    const flash = [];
    if (p.loaded === 'csv' || p.loaded === 'dataset') {
      flash.push(ctx.app.dataSource === 'browser' && !ctx.app.datasetError
        ? c.notice({ tone: 'good', title: 'Your data is loaded.', body: `This page now uses ${esc(count(ctx.dataset.transactions.length, 'transaction'))} from data set “${esc(ctx.dataset.datasetId)}”. It is kept in this browser only. <a href="${esc(ctx.href('review'))}">Check the items that need a look in Review</a>.` })
        : c.notice({ tone: 'warn', title: 'The loaded data is not in use.', body: 'It may have been forgotten, or this browser did not keep it. Load the files again below.' }));
    } else if (p.loaded === 'profile') {
      flash.push(ctx.app.profileSource === 'browser'
        ? c.notice({ tone: 'good', title: 'Your household profile is loaded.', body: `“${esc(profileName(ctx.profile) || 'Unnamed household')}” is kept in this browser only. Reset (below) starts the budget from it at any time.` })
        : c.notice({ tone: 'warn', title: 'The loaded profile is not in use.', body: 'This browser did not keep it. Load it again below.' }));
    } else if (p.forgot === '1') {
      flash.push(c.notice({ tone: 'good', title: 'Files loaded in this browser were forgotten.', body: `The page is using ${esc(builtInName(ctx))} again.` }));
    }
    const header = c.pageHeader({
      eyebrow: 'Data & privacy',
      title: 'Your data, saving and privacy',
      subtitle: 'What this page is using, how to load your own bank exports, how your changes are kept and who can see them. Nothing here leaves this device.',
    });
    return `${header}<div class="dp stack">
      ${flash.join('')}
      ${usingCard(ctx)}
      <div class="dp-grid">
        <div class="stack">${loadCard(ctx)}${saveCard(ctx)}</div>
        <div class="stack">${upgradeCard(ctx)}${privacyCard(ctx)}${resetCard(ctx)}</div>
      </div>
    </div>`;
  }

  // ------------------------------------------------------------------ CSV import: files page
  function crumbs(ctx, items) {
    return c.breadcrumbs([{ label: 'Data & privacy', href: ctx.href('data') }, ...items]);
  }

  function fileBlock(ctx, f) {
    const an = analyze(ctx, f);
    const acct = accountById(ctx, f.account);
    const b = 'dp-f-' + f.key;
    const opts = accountOptions(ctx);
    const group = (label, list) => (list.length ? `<optgroup label="${esc(label)}">${list.map(a => `<option value="${esc(a.id)}"${a.id === f.account ? ' selected' : ''}>${esc(a.label + ' — ' + accountText(ctx, a))}</option>`).join('')}</optgroup>` : '');
    const select = `<div class="field dp-acct-field">
        <label for="${b}-acct">Account this file belongs to</label>
        <select id="${b}-acct" data-action="dp:csv-account" data-file="${esc(f.key)}" aria-describedby="${b}-acct-help"${!f.account && S.csv.error ? ' aria-invalid="true"' : ''}>
          <option value=""${!f.account ? ' selected' : ''}>Choose an account…</option>
          ${group(ctx.dataset.isSynthetic ? 'Accounts in the sample now' : 'Accounts in the data now', opts.filter(a => a.origin === 'existing'))}
          ${group('New in this import', opts.filter(a => a.origin === 'new'))}
          <option value="__new__"${f.account === '__new__' ? ' selected' : ''}>New account…</option>
        </select>
        <p class="field-help" id="${b}-acct-help">${f.guessed && acct ? 'Chosen from the file name. Check it.' : f.account ? '' : 'Two exports of the same account can overlap: identical rows are counted once.'}</p>
      </div>`;
    const newForm = f.account === '__new__' ? `<form class="dp-newacct" data-action="dp:csv-new-account" data-file="${esc(f.key)}" aria-label="New account for ${esc(f.name)}">
        <div class="field"><label for="${b}-nlabel">Account name</label><input id="${b}-nlabel" name="label" maxlength="80" required placeholder="e.g. Joint checking" autocomplete="off"></div>
        <div class="field"><label for="${b}-ntype">Type</label><select id="${b}-ntype" name="type">${NEW_TYPES.map(t => `<option value="${t}"${t === (typeFromName(f.name) || 'checking') ? ' selected' : ''}>${esc(TYPE_LABEL[t])}</option>`).join('')}</select></div>
        <div class="field"><label for="${b}-nowner">Whose account</label><select id="${b}-nowner" name="owner"><option value="joint">Joint (shared)</option><option value="p1">Personal: ${esc(ctx.person('p1'))}</option><option value="p2">Personal: ${esc(ctx.person('p2'))}</option></select></div>
        <div class="dp-newacct-actions"><button type="submit" class="btn btn-primary btn-small" id="${b}-nadd">Add account</button>${c.button('Cancel', { action: 'dp:csv-new-cancel', data: { file: f.key }, variant: 'ghost', cls: 'btn-small', id: b + '-ncancel' })}</div>
      </form>` : '';
    const coverBad = coverProblem(f);
    // These date fields are never re-rendered while in use (see dp:csv-cover): coverStatus()
    // updates the error line and aria-invalid in place.
    const cover = `<div class="dp-cover">
        <div class="field"><label for="${b}-cs">Export covers from <span class="fine">(optional)</span></label>
          <input type="date" id="${b}-cs" value="${esc(f.coverageStart)}" min="1990-01-01" max="2099-12-31" data-action="dp:csv-cover" data-file="${esc(f.key)}" data-edge="start" aria-describedby="${b}-cover-help ${b}-cover-error"${coverBad ? ' aria-invalid="true"' : ''}></div>
        <div class="field"><label for="${b}-ce">Export covers to <span class="fine">(optional)</span></label>
          <input type="date" id="${b}-ce" value="${esc(f.coverageEnd)}" min="1990-01-01" max="2099-12-31" data-action="dp:csv-cover" data-file="${esc(f.key)}" data-edge="end" aria-describedby="${b}-cover-help ${b}-cover-error"${coverBad ? ' aria-invalid="true"' : ''}></div>
        <p class="field-error dp-cover-help" id="${b}-cover-error"${coverBad ? '' : ' hidden'}>${esc(coverBad || '')}</p>
        <p class="field-help dp-cover-help" id="${b}-cover-help">Blank uses the first and last transaction dates${an.ok && an.start ? ` (${esc(dateRange(an.start, an.end))})` : ''}. Enter the period you asked the bank for, so quiet days at either end still count as covered.</p>
      </div>`;
    const cardLike = acct && (acct.type === 'credit_card' || acct.type === 'loan');
    const single = f.cols ? f.amountStyle !== 'split' : an.ok ? an.mapping.amount != null : an.code === 'SIGN_UNKNOWN';
    const charges = cardLike && single ? `<div class="field dp-charges">
        <label for="${b}-charges">${acct.type === 'loan' ? 'Loan charges' : 'Card charges'} in this file are</label>
        <select id="${b}-charges" data-action="dp:csv-opt" data-opt="charges" data-file="${esc(f.key)}" aria-describedby="${b}-charges-help"${an.code === 'SIGN_UNKNOWN' ? ' aria-invalid="true"' : ''}>
          <option value=""${!f.charges ? ' selected' : ''}>Work it out from the file</option>
          <option value="positive"${f.charges === 'positive' ? ' selected' : ''}>Positive numbers</option>
          <option value="negative"${f.charges === 'negative' ? ' selected' : ''}>Negative numbers</option>
        </select>
        <p class="field-help" id="${b}-charges-help">Banks differ. Look at one purchase in the file: is it a positive or a negative number?</p>
      </div>` : '';

    // Columns: recognised automatically, or chosen here.
    const cells = headerCells(f, an);
    const cur = k => (f.cols ? f.cols[k] : an.ok && !f.noHeader && an.mapping[k] != null ? an.mapping[k] : '');
    const style = f.amountStyle || (an.ok && an.mapping.amount == null && an.mapping.debit != null ? 'split' : 'signed');
    const pick = (k, label, optional) => {
      const value = cur(k) === undefined || cur(k) === null ? '' : String(cur(k));
      const known = cells.some(x => x.value === value);
      return `<div class="field"><label for="${b}-col-${k}">${esc(label)}${optional ? ' <span class="fine">(optional)</span>' : ''}</label>
        <select id="${b}-col-${k}" data-action="dp:csv-col" data-col="${k}" data-file="${esc(f.key)}">
          <option value=""${!value ? ' selected' : ''}>${optional ? 'Not in this file' : 'Choose a column…'}</option>
          ${value && !known ? `<option value="${esc(value)}" selected>${esc(value)}</option>` : ''}
          ${cells.map(x => `<option value="${esc(x.value)}"${x.value === value ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
        </select></div>`;
    };
    const colsBody = `<div class="form-grid dp-cols-grid">
        ${pick('date', 'Date', false)}
        ${pick('postDate', 'Posted date', true)}
        ${pick('description', 'Description', false)}
        <div class="field"><label for="${b}-style">Amounts are in</label>
          <select id="${b}-style" data-action="dp:csv-opt" data-opt="amountStyle" data-file="${esc(f.key)}">
            <option value="signed"${style !== 'split' ? ' selected' : ''}>One amount column</option>
            <option value="split"${style === 'split' ? ' selected' : ''}>Separate money-out and money-in columns</option>
          </select></div>
        ${style === 'split' ? pick('debit', 'Money out (debit)', false) + pick('credit', 'Money in (credit)', false) : pick('amount', 'Amount', false)}
        ${pick('category', 'Bank category', true)}
        <div class="field"><label for="${b}-datefmt">Dates are written</label>
          <select id="${b}-datefmt" data-action="dp:csv-opt" data-opt="dateFormat" data-file="${esc(f.key)}" aria-describedby="${b}-datefmt-help">
            <option value=""${!f.dateFormat ? ' selected' : ''}>Month/day/year (US)</option>
            <option value="DMY"${f.dateFormat === 'DMY' ? ' selected' : ''}>Day/month/year</option>
            <option value="YMD"${f.dateFormat === 'YMD' ? ' selected' : ''}>Year-month-day only</option>
          </select><p class="field-help" id="${b}-datefmt-help">Dates like 2025-01-31 are read with any setting.</p></div>
      </div>
      <label class="check dp-nohead"><input type="checkbox" id="${b}-nohead" data-action="dp:csv-nohead" data-file="${esc(f.key)}"${f.noHeader ? ' checked' : ''}> The first line is a transaction (this file has no column names)</label>
      ${f.cols || f.noHeader ? `<div class="dp-actions">${c.button('Use the recognised columns', { action: 'dp:csv-detect', data: { file: f.key }, cls: 'btn-small', id: b + '-detect' })}</div>` : ''}`;
    const colsSummary = f.cols || f.noHeader ? 'Columns (chosen by you)' : an.ok && !an.headerRow && !an.rows ? 'Columns (none: the file is empty)' : an.ok ? 'Columns (recognised)' : 'Columns (not recognised: choose them)';
    const dateHint = an.ok && dateOrderSuspect(an);
    const cols = details(b + '-cols', esc(colsSummary), colsBody, { open: (!an.ok && !cardLike) || dateHint, cls: 'dp-cols' });

    let status;
    if (!f.account) status = `<p class="dp-fstatus">${c.badge('Needs an account', 'warn')} <span class="fine">${an.ok ? esc(count(an.count, 'transaction')) + ' found so far.' : ''}</span></p>`;
    else if (f.account === '__new__') status = `<p class="dp-fstatus">${c.badge('Needs an account', 'warn')} <span class="fine">Add the new account above.</span></p>`;
    else if (!an.ok) status = c.notice({ tone: 'warn', title: an.incomplete ? 'Choose the columns' : 'This file cannot be read yet', body: esc(an.error) });
    else if (!an.count) {
      // Nothing usable: never a green "Read". An account whose export reads as empty would have
      // no covered days, so every month would count as incomplete.
      const why = !an.rows && !an.headerRow ? 'The file has no rows.'
        : an.skipped.length ? `Every row is skipped (${reasonsText(an.skipped)}).`
          : 'It has column names but no transactions.';
      const fix = dateHint ? ' The dates may be written day first: choose “Day/month/year” under “Dates are written” below.'
        : !an.rows || !an.skipped.length ? ' If the account really had no activity, enter the dates this export covers; otherwise remove the file.'
          : ' Check the columns below.';
      status = c.notice({ tone: 'warn', title: 'No transactions could be read', body: esc(why + fix) });
    } else {
      const skipped = an.skipped.length ? `<span>${esc(count(an.skipped.length, 'row'))} will be skipped (${esc(reasonsText(an.skipped))})</span>` : '';
      status = `<p class="dp-fstatus">${c.badge('Read', 'good')} <strong>${esc(count(an.count, 'transaction'))}</strong> <span>${esc(an.start === an.end ? 'on ' + fmt.date(an.start) : 'from ' + fmt.date(an.start) + ' to ' + fmt.date(an.end))}</span>${skipped}</p>
        ${dateHint ? `<p class="dp-hint">${esc('Some dates could not be read. If this bank writes the day first (31/01/2026), choose “Day/month/year” under “Dates are written” below.')}</p>` : ''}
        <p class="fine dp-fdetail">Columns: ${esc(columnsText(an.mapping))}. Amounts: ${esc(an.signConvention)}.</p>
        ${an.warnings.length ? `<ul class="dp-warnings">${an.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
    }
    return `<li class="dp-fileblock" id="${b}">
      <div class="dp-fhead">
        <div class="dp-fname"><h3 id="${b}-h" tabindex="-1">${esc(f.name)}</h3><p class="fine">${esc(sizeText(f.size))}${f.records.length ? '' : ' · empty'}</p></div>
        ${c.button('Remove', { action: 'dp:csv-remove', data: { file: f.key }, variant: 'ghost', cls: 'btn-small', id: b + '-remove', ariaLabel: 'Remove ' + f.name })}
      </div>
      <div class="dp-fbody">${select}${newForm}${charges}</div>
      ${status}
      ${cover}
      ${cols}
    </li>`;
  }

  function rulesBlock() {
    const st = S.csv;
    return `<div class="dp-rules">
      <h3 id="dp-rules-h" tabindex="-1">Household rules <span class="fine">(optional)</span></h3>
      <p class="fine" id="dp-rules-help">A rules file (<code>rules.json</code>) names your employer, utilities and regular transfers so they are sorted correctly. Without one, the general rules are used.</p>
      ${st.rules
        ? `<p class="dp-status">${c.badge('Using rules', 'good')} <span class="dp-break">${esc(st.rulesName)}</span> <span class="fine">${esc(st.rulesInfo)}</span></p>
           <div class="dp-actions">${c.button('Stop using these rules', { action: 'dp:csv-rules-remove', cls: 'btn-small', id: 'dp-rules-remove' })}</div>`
        : filePicker({ id: 'dp-pick-rules', kind: 'rules', label: 'Choose a rules file…', accept: ACCEPT.json, describedBy: 'dp-rules-help' })}
      ${st.rulesError ? c.notice({ tone: 'bad', title: 'These rules could not be used', body: esc(st.rulesError) }) : ''}
    </div>`;
  }

  function csvPage(ctx) {
    const st = S.csv;
    if (st.datasetId === null) st.datasetId = defaultDatasetId(ctx);
    const replaces = ctx.dataset.transactions.length
      ? `These files replace the ${esc(count(ctx.dataset.transactions.length, 'transaction'))} this page uses now (${esc(builtInName(ctx))}); they are not added to them. Include every export you want, for every account.`
      : 'Include every export you want, for every account.';
    const header = crumbs(ctx, [{ label: 'Bank exports' }]) + c.pageHeader({
      eyebrow: 'Data & privacy',
      title: 'Load bank and card exports',
      subtitle: 'Files are read on this device. Nothing is uploaded, and nothing changes until you have checked the import report and chosen “Use this data”.',
    });
    const pickErr = st.pickError ? c.notice({ tone: 'warn', title: 'Some files were not added', body: `<ul class="dp-notes">${st.pickError.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` }) : '';
    const filesBody = `<p class="dp-intro">${replaces} Overlapping exports of the same account are fine: identical rows are counted once.</p>
      <div class="dp-actions">${filePicker({ id: 'dp-csv-add', kind: 'csv', label: st.files.length ? 'Add more CSV files…' : 'Choose CSV files…', accept: ACCEPT.csv, multiple: true, variant: st.files.length ? 'secondary' : 'primary', describedBy: 'dp-csv-add-help' })}
        <span class="fine" id="dp-csv-add-help">You can choose several files at once.</span></div>
      ${pickErr}
      ${st.files.length ? `<ol class="dp-filelist">${st.files.map(f => fileBlock(ctx, f)).join('')}</ol>` : c.empty('No files chosen yet.')}
      ${rulesBlock()}`;
    const dsidProblem = datasetIdProblem(st.datasetId);
    const err = st.error ? `<div id="dp-csv-error" class="dp-error" tabindex="-1">${c.notice({ tone: 'bad', title: st.error.title, body: `<ul class="dp-notes">${st.error.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` })}</div>` : '';
    const checkBody = `<form id="dp-csv-form" data-action="dp:csv-check" aria-label="Check the files">
        <div class="field dp-dsid">
          <label for="dp-csv-dsid">Data set name</label>
          <input id="dp-csv-dsid" name="datasetId" value="${esc(st.datasetId)}" maxlength="60" autocomplete="off" spellcheck="false" aria-describedby="dp-csv-dsid-help dp-csv-dsid-error"${dsidProblem ? ' aria-invalid="true"' : ''}>
          <p class="field-help" id="dp-csv-dsid-help">Your budget is saved in this browser under this name. Use the same name each time you load newer exports, so your plan and corrections stay with them.</p>
          <p class="field-error" id="dp-csv-dsid-error" role="alert"${dsidProblem ? '' : ' hidden'}>${esc(dsidProblem || '')}</p>
        </div>
        <p class="dp-dsid-status" id="dp-csv-dsid-status">${esc(budgetNameStatus(ctx, st.datasetId))}</p>
        ${err}
        <div class="dp-actions"><button type="submit" class="btn btn-primary" id="dp-csv-check-btn">Check these files</button><span class="fine">Nothing changes yet: you see a report first.</span></div>
      </form>`;
    return `${header}<div class="dp stack">
      ${c.card(filesBody, { title: '1. Your files and their accounts', id: 'dp-csv-files' })}
      ${c.card(checkBody, { title: '2. Check what was read', id: 'dp-csv-check' })}
    </div>`;
  }

  // ------------------------------------------------------------------ CSV import: report page
  function useDecision(ctx, { id, count: n, what, useId, useAction, cancelWhat, backHref, backLabel, error }) {
    const items = [
      `The page reloads and uses ${esc(count(n, 'transaction'))} ${esc(what)} instead of ${esc(builtInName(ctx))}${ctx.app.dataSource === 'browser' ? ' (and instead of the files loaded earlier)' : ''}.`,
      'They are kept in this browser’s storage on this device only, until you choose Forget on the Data & privacy page.',
      esc(budgetNameStatus(ctx, id)),
    ];
    return c.card(`<ul class="dp-points">${items.map(x => `<li>${x}</li>`).join('')}</ul>
      ${error ? `<div id="${esc(useId)}-error" class="dp-error" tabindex="-1">${c.notice({ tone: 'bad', title: 'This data could not be kept in this browser', body: `${esc(error)}<p class="dp-gap">The steps, in this app’s folder on a computer: run <code>node tools/import.cjs</code>, then <code>node tools/build.cjs</code>. That makes a private copy of the page with the data inside the file itself.</p>` })}</div>` : ''}
      <div class="dp-actions">
        ${c.button('Use this data', { action: useAction, variant: 'primary', id: useId })}
        ${backHref ? c.linkButton(backLabel, backHref) : ''}
        ${c.button('Cancel', { action: 'dp:cancel', data: { what: cancelWhat }, variant: 'ghost', id: useId + '-cancel' })}
      </div>`, { title: 'Use this data?', id: useId + '-card' });
  }

  function reportPage(ctx) {
    const st = S.csv;
    const header = crumbs(ctx, [{ label: 'Bank exports', href: ctx.href('data', { load: 'csv' }) }, { label: 'Import report' }]) + c.pageHeader({
      eyebrow: 'Data & privacy',
      title: 'Check the import report',
      subtitle: 'Nothing has changed yet. Read what was found, then use the data or go back and adjust the files.',
    });
    if (!st.result) {
      const msg = st.files.length
        ? `The files or their settings changed after the last check, so this report is out of date. Go back to the ${esc(count(st.files.length, 'file'))} and check them again.`
        : 'There is no report to show. Files are kept only while this page is open, so choose them again.';
      return header + c.card(c.empty(msg, c.linkButton(st.files.length ? 'Back to the files' : 'Choose files', ctx.href('data', { load: 'csv' }), { variant: 'primary' })), { title: st.files.length ? 'Report out of date' : 'No report yet', id: 'dp-report-none' });
    }
    const { report, dataset } = st.result;
    const labelFor = id => { const a = dataset.accounts.find(x => x.id === id); return a ? a.label : id; };
    const rowsRead = report.files.reduce((a, f) => a + f.rows, 0);
    const dupes = report.duplicatesRemoved.length;
    const skipped = report.skippedRows.length;
    const metrics = `<div class="metrics dp-metrics">
      ${c.metric({ label: 'Transactions imported', value: fmt.number(report.transactions), sub: esc(dateRange(report.start, report.end)) })}
      ${c.metric({ label: 'Rows read', value: fmt.number(rowsRead), sub: esc('from ' + count(report.files.length, 'file')) })}
      ${c.metric({ label: 'Duplicates removed', value: fmt.number(dupes), sub: dupes ? 'Rows found in two overlapping exports, counted once' : 'No overlapping rows' })}
      ${c.metric({ label: 'Rows skipped', value: fmt.number(skipped), sub: skipped ? esc(reasonsText(report.skippedRows)) : 'Every row was read' })}
    </div>`;

    const files = c.card(fileTable(ctx, report.files, labelFor, 'Rows read, imported, removed as duplicates and skipped, per file', { showSigns: false }), {
      title: 'Files', id: 'dp-report-files', subtitle: 'Imported + duplicates removed + skipped = rows read.',
    });

    // Coverage per account and per month (spending accounts decide whether a month is complete).
    const months = report.months || [];
    const partialMonths = months.filter(m => m.spendingCoverage !== 'full');
    const spendAccts = dataset.accounts.filter(a => E.ledger.SPENDING_ACCOUNT_TYPES.includes(a.type));
    const missingFor = m => spendAccts.filter(a => (m.coverage[a.id] || 0) < m.days).map(a => a.label);
    const covTable = accountsTable(ctx, dataset.accounts, a => (report.accounts.find(x => x.id === a.id) || {}).transactions || 0, { caption: 'Dates covered by each account’s exports' });
    const partialList = partialMonths.length ? `<p class="dp-gap">${esc(count(months.length - partialMonths.length, 'month'))} of ${months.length} are complete for spending. Incomplete months are left out of usual-spending averages:</p>
      <ul class="dp-notes">${partialMonths.slice(0, 8).map(m => `<li><strong>${esc(fmt.month(m.month))}</strong>: ${missingFor(m).length ? esc('days missing from ' + missingFor(m).join(', ')) : 'no spending account covers it'}</li>`).join('')}</ul>
      ${partialMonths.length > 8 ? details('dp-report-partial', `${partialMonths.length - 8} more incomplete months`, `<ul class="dp-notes">${partialMonths.slice(8).map(m => `<li><strong>${esc(fmt.month(m.month))}</strong>: ${esc(missingFor(m).length ? 'days missing from ' + missingFor(m).join(', ') : 'no spending account covers it')}</li>`).join('')}</ul>`) : ''}`
      : months.length ? `<p class="dp-gap">All ${esc(count(months.length, 'month'))} are complete for spending.</p>` : '';
    const coverage = c.card(covTable + partialList, { title: 'Coverage by account', id: 'dp-report-coverage', subtitle: 'Savings and loan accounts do not decide whether a month’s spending is complete.' });

    const kinds = c.table({
      caption: 'Imported rows by kind, with money in and out',
      columns: [
        { key: 'k', label: 'Kind', html: r => `${esc(r.label)}<small>${esc(r.sub)}</small>` },
        { key: 'n', label: 'Rows', align: 'right', html: r => esc(fmt.number(r.count)) },
        { key: 'in', label: 'In', align: 'right', html: r => esc(fmt.money(r.inflowCents, { whole: true })) },
        { key: 'out', label: 'Out', align: 'right', html: r => esc(fmt.money(r.outflowCents, { whole: true })) },
      ],
      rows: KIND_ROWS.map(([k, label, sub]) => ({ label, sub, ...(report.totalsByKind[k] || { count: 0, inflowCents: 0, outflowCents: 0 }) })),
    });
    const sp = report.spending;
    const totals = c.card(`${kinds}<p class="dp-gap">Spending before your corrections: ${esc(fmt.money(sp.purchasesCents))} of purchases − ${esc(fmt.money(sp.refundsCents))} of refunds = <strong>${esc(fmt.money(sp.netCents))}</strong>. Card payments and transfers between your own accounts are not spending.</p>`, {
      title: 'Totals by kind', id: 'dp-report-kinds', subtitle: 'How each row was read, with money in and out in whole dollars. Card payments appear on both the paying and the card side.',
    });

    const signNotes = report.warnings.filter(w => /inferred that/.test(w));
    const otherWarnings = report.warnings.filter(w => !/inferred that/.test(w));
    const signs = report.files.map(f => `<li><strong class="dp-break">${esc(f.name)}</strong>: ${esc(f.signConvention)}</li>`).join('');
    const reading = c.card(`<ul class="dp-notes">${signs}</ul>
      ${signNotes.length ? c.notice({ tone: 'info', title: 'Worked out from the file', body: `<ul class="dp-notes">${signNotes.map(w => `<li>${esc(w)}</li>`).join('')}</ul>If this is wrong, go back and set “Card charges in this file are”.` }) : ''}
      ${otherWarnings.length ? c.notice({ tone: 'warn', title: count(otherWarnings.length, 'warning'), body: `<ul class="dp-notes">${otherWarnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` }) : ''}`,
    { title: 'How amounts were read', id: 'dp-report-reading', subtitle: 'Money out is negative and money in is positive for every account.' });

    const flagCounts = report.flagCounts || {};
    const flags = Object.keys(FLAG_TEXT).filter(k => flagCounts[k] > 0).map(k => [k, flagCounts[k]]);
    const review = flags.length ? c.card(`<ul class="dp-notes">${flags.map(([k, n]) => `<li><strong>${esc(fmt.number(n))}</strong> ${esc(FLAG_TEXT[k][n === 1 ? 0 : 1])}</li>`).join('')}</ul><p class="fine">These are counted as imported until you decide. After you use the data, Review lists each one.</p>`, {
      title: 'Worth a look after import', id: 'dp-report-flags',
    }) : '';

    const where = r => `Removed: ${r.file}, line ${r.row}. Kept: ${r.keptFile}, line ${r.keptRow}.`;
    const dupTable = dupes ? details('dp-report-dupes', `Duplicates removed (${fmt.number(dupes)})`, c.table({
      caption: 'Rows removed because the same row is in another export',
      cls: 'dp-dupes',
      columns: [
        // Phones show the date and where the row was removed and kept under the description,
        // so the table is two columns wide there.
        { key: 'desc', label: 'Description', html: r => `<span class="dp-break">${esc(r.description)}</span><small><span class="dp-inline">${esc(fmt.date(r.date))} · </span>${esc(labelFor(r.accountId))}</small><small class="dp-inline dp-break">${esc(where(r))}</small>` },
        { key: 'd', label: 'Date', cls: 'dp-col-wide', html: r => `<span class="nowrap">${esc(fmt.date(r.date))}</span>` },
        { key: 'amt', label: 'Amount', align: 'right', html: r => esc(fmt.money(r.amountCents)) },
        { key: 'src', label: 'Removed from / kept in', cls: 'dp-col-wide', html: r => `<span class="dp-break">${esc(r.file)}, line ${esc(r.row)}</span><small class="dp-break">Kept: ${esc(r.keptFile)}, line ${esc(r.keptRow)}</small>` },
      ],
      rows: report.duplicatesRemoved.slice(0, 300),
    }) + (dupes > 300 ? `<p class="fine">Showing the first 300 of ${esc(fmt.number(dupes))}.</p>` : '')) : '';
    const skipTable = skipped ? details('dp-report-skipped', `Skipped rows (${fmt.number(skipped)})`, c.table({
      caption: 'Rows that were not imported, with the reason',
      columns: [
        { key: 'f', label: 'File', html: r => `<span class="dp-break">${esc(r.file)}</span>` },
        { key: 'row', label: 'Line', align: 'right', html: r => esc(r.row) },
        { key: 'reason', label: 'Reason', html: r => esc(r.reason) },
      ],
      rows: report.skippedRows.slice(0, 300),
    })) : '';
    const audit = dupTable || skipTable ? c.card(`<div class="dp-more">${dupTable}${skipTable}</div>`, { title: 'Row by row', id: 'dp-report-rows', subtitle: 'Every removed or skipped row, with its file and line.' }) : '';

    const decision = useDecision(ctx, {
      id: dataset.datasetId, count: report.transactions, what: `from ${count(report.files.length, 'file')}`,
      useId: 'dp-csv-use', useAction: 'dp:csv-use', cancelWhat: 'csv', backHref: ctx.href('data', { load: 'csv' }), backLabel: 'Back to the files', error: st.useError,
    });
    // The report reads top to bottom; the decision stays beside it on wide screens and comes
    // after it (before the row-by-row audit) on narrow ones.
    return `${header}<div class="dp stack">
      ${metrics}
      <div class="dp-grid dp-grid-report">
        <div class="stack">${files}${coverage}${totals}${reading}${review}</div>
        <div class="stack dp-aside">${decision}</div>
      </div>
      ${audit}
    </div>`;
  }

  // ------------------------------------------------------------------ prepared data file page
  function datasetPage(ctx) {
    const d = S.dataset;
    const header = crumbs(ctx, [{ label: 'Prepared data file' }]) + c.pageHeader({
      eyebrow: 'Data & privacy', title: 'Load a prepared data file',
      subtitle: 'A data file made by the command-line import, or the earlier version’s data file. It is read on this device; nothing changes until you choose “Use this data”.',
    });
    const picker = `<div class="dp-actions">${filePicker({ id: 'dp-dataset-pick', kind: 'dataset', label: d ? 'Choose a different file…' : 'Choose a data file…', accept: ACCEPT.json, variant: d ? 'secondary' : 'primary' })}</div>`;
    if (!d) return header + `<div class="dp stack">${c.card(picker + c.empty('No file chosen yet. Files are kept only while this page is open.'), { title: 'Data file', id: 'dp-dataset-file' })}</div>`;
    if (d.error) {
      return header + `<div class="dp stack">${c.card(`<div id="dp-dataset-result" class="dp-result" tabindex="-1">${c.notice({ tone: 'bad', title: `“${d.name}” cannot be used`, body: esc(d.error) })}</div>${picker}`, { title: 'Data file', id: 'dp-dataset-file' })}</div>`;
    }
    const ds = d.dataset;
    const months = E.ledger.months(ds);
    const full = months.filter(m => E.ledger.coverage(ds, m).status === 'full').length;
    const first = ds.transactions[0], last = ds.transactions[ds.transactions.length - 1];
    const facts = [
      ['File', `<span class="dp-break">${esc(d.name)}</span><span class="dp-fact-sub">${esc(sizeText(d.size))}</span>`],
      ['Data set name', `<code class="dp-code">${esc(ds.datasetId)}</code>`],
      ['Kind of data', ds.isSynthetic ? `${c.badge('Fictional', 'info')} <span class="dp-fact-sub">Sample data: every name and amount is invented.</span>` : c.badge('Household data', 'neutral')],
      ['Format', d.legacy ? 'The earlier version’s format, converted on loading' : 'Current format (version 2)'],
      ['Transactions', `${esc(count(ds.transactions.length, 'transaction'))} in ${esc(count(ds.accounts.length, 'account'))}${first ? `<span class="dp-fact-sub">${esc(dateRange(first.date, last.date))}</span>` : ''}`],
      ['Complete months', months.length ? `${full} of ${months.length}` : '—'],
      ['Prepared', ds.generatedAt ? esc(fmt.date(ds.generatedAt)) : 'Not recorded'],
    ];
    const perAccount = new Map();
    for (const t of ds.transactions) perAccount.set(t.accountId, (perAccount.get(t.accountId) || 0) + 1);
    const accounts = accountsTable(ctx, ds.accounts, a => perAccount.get(a.id) || 0, { caption: 'Accounts in this data file and the dates their exports cover' });
    const warn = d.warnings.length ? c.notice({ tone: 'warn', title: count(d.warnings.length, 'thing') + ' to know', body: `<ul class="dp-notes">${d.warnings.slice(0, 20).map(w => `<li>${esc(w)}</li>`).join('')}</ul>` }) : '';
    const notes = ds.notes.length ? details('dp-dataset-notes', `Notes saved with the data (${ds.notes.length})`, `<ul class="dp-notes">${ds.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`) : '';
    const sizeWarn = d.size > 4 * 1048576 ? c.notice({ tone: 'warn', title: 'This file is large', body: 'It may not fit in browser storage. If it does not, use a private build instead (see below).' }) : '';
    const summary = c.card(`<div id="dp-dataset-result" class="dp-result" tabindex="-1"><dl class="dp-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>
      <h3 class="dp-sub">Accounts</h3>${accounts}${warn}${sizeWarn}<div class="dp-more">${notes}</div>${picker}`, { title: 'What is in the file', id: 'dp-dataset-file' });
    const decision = useDecision(ctx, {
      id: ds.datasetId, count: ds.transactions.length, what: `from “${d.name}”`,
      useId: 'dp-dataset-use', useAction: 'dp:dataset-use', cancelWhat: 'dataset', error: d.useError,
    });
    return `${header}<div class="dp stack"><div class="dp-grid"><div class="stack">${summary}</div><div class="stack">${decision}</div></div></div>`;
  }

  // ------------------------------------------------------------------ profile page
  function profilePage(ctx) {
    const p = S.profile;
    const header = crumbs(ctx, [{ label: 'Household profile' }]) + c.pageHeader({
      eyebrow: 'Data & privacy', title: 'Load a household profile',
      subtitle: 'Your starting plan: names, pay, bills, targets, goals and starting scenarios. Read on this device; nothing changes until you choose “Use this profile”.',
    });
    const picker = `<div class="dp-actions">${filePicker({ id: 'dp-profile-pick', kind: 'profile', label: p ? 'Choose a different file…' : 'Choose a profile…', accept: ACCEPT.json, variant: p ? 'secondary' : 'primary' })}</div>`;
    if (!p) return header + `<div class="dp stack">${c.card(picker + c.empty('No file chosen yet. Files are kept only while this page is open.'), { title: 'Profile file', id: 'dp-profile-file' })}</div>`;
    if (p.error) return header + `<div class="dp stack">${c.card(`<div id="dp-profile-result" class="dp-result" tabindex="-1">${c.notice({ tone: 'bad', title: `“${p.name}” cannot be used`, body: esc(p.error) })}</div>${picker}`, { title: 'Profile file', id: 'dp-profile-file' })}</div>`;
    const plan = p.preview.plan;
    const blank = (list, field) => list.filter(x => x[field] === null || x[field] === undefined).length;
    const targets = Object.values(plan.targets || {});
    const unknownPay = plan.incomes.filter(i => i.kind === 'paycheck' && (i.netPerPaycheckCents === null || i.netPerPaycheckCents === undefined)).length;
    const facts = [
      ['File', `<span class="dp-break">${esc(p.name)}</span><span class="dp-fact-sub">${esc(sizeText(p.size))}</span>`],
      ['Household', `<strong>${esc(profileName(p.profile) || 'Unnamed household')}</strong> ${p.profile.isSynthetic ? c.badge('Fictional', 'info') : ''}<span class="dp-fact-sub">${esc((plan.people || []).map(x => x.name).join(' and '))}</span>`],
      ['Income', esc(count(plan.incomes.length, 'income stream')) + (unknownPay ? `<span class="dp-fact-sub">${esc(count(unknownPay, 'paycheck'))} with take-home pay not set</span>` : '')],
      ['Bills', esc(count(plan.bills.length, 'bill')) + (blank(plan.bills, 'monthlyCents') ? `<span class="dp-fact-sub">${esc(blank(plan.bills, 'monthlyCents'))} with the amount not set</span>` : '')],
      ['Spending targets', esc(count(targets.length, 'category', 'categories')) + (targets.filter(v => v === null).length ? `<span class="dp-fact-sub">${targets.filter(v => v === null).length} not set yet</span>` : '')],
      ['Savings goals and debts', `${esc(count(plan.savings.length, 'goal'))}, ${esc(count(plan.debts.length, 'debt'))}`],
      ['Starting scenarios', esc(String(Math.max(0, p.preview.scenarios.length - 1)))],
    ];
    const problems = p.notes.length ? c.notice({ tone: 'warn', title: `${count(p.notes.length, 'value')} could not be used as written`, body: `<ul class="dp-notes">${p.notes.slice(0, 30).map(x => `<li>${esc(x)}</li>`).join('')}</ul>Invalid amounts are treated as not set (unknown), never as $0.` }) : '';
    const summary = c.card(`<div id="dp-profile-result" class="dp-result" tabindex="-1"><dl class="dp-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>${problems}${picker}`, { title: 'What is in the profile', id: 'dp-profile-file' });
    const startDefault = !isObj(ctx.profile) || !!ctx.profile.isSynthetic;
    const form = `<form id="dp-profile-form" data-action="dp:profile-use" aria-label="Use this profile">
      <fieldset class="dp-choice"><legend>Your budget in this browser</legend>
        <label class="check" for="dp-profile-start"><input type="radio" id="dp-profile-start" name="mode" value="start"${startDefault ? ' checked' : ''}> <span><strong>Start the budget from this profile.</strong> The plan and scenarios saved for “${esc(ctx.dataset.datasetId)}” are replaced. Transaction corrections and references are kept.</span></label>
        <label class="check" for="dp-profile-keep"><input type="radio" id="dp-profile-keep" name="mode" value="keep"${startDefault ? '' : ' checked'}> <span><strong>Keep the budget saved in this browser.</strong> Your saved plan stays as it is. The profile is used by Reset, and for a data set with no saved budget yet.</span></label>
      </fieldset>
      <ul class="dp-points"><li>The page reloads. The profile is kept in this browser’s storage on this device only, until you choose Forget.</li></ul>
      ${p.useError ? `<div id="dp-profile-use-error" class="dp-error" tabindex="-1">${c.notice({ tone: 'bad', title: 'The profile could not be kept in this browser', body: esc(p.useError) })}</div>` : ''}
      <div class="dp-actions">
        <button type="submit" class="btn btn-primary" id="dp-profile-use">Use this profile</button>
        ${c.button('Export workbook first', { action: 'dp:export-workbook', id: 'dp-profile-backup' })}
        ${c.button('Cancel', { action: 'dp:cancel', data: { what: 'profile' }, variant: 'ghost', id: 'dp-profile-cancel' })}
      </div>
    </form>`;
    return `${header}<div class="dp stack"><div class="dp-grid"><div class="stack">${summary}</div><div class="stack">${c.card(form, { title: 'Use this profile?', id: 'dp-profile-decide' })}</div></div></div>`;
  }

  // ------------------------------------------------------------------ workbook import page
  function workbookChanges(ctx, next) {
    const cur = ctx.state;
    const lines = [];
    if (JSON.stringify(cur.plan) === JSON.stringify(next.plan)) lines.push('The plan (pay, bills, targets, goals and debts) is the same as now.');
    else {
      try { lines.push(...E.plan.whatChanged(cur.plan, next.plan, { scope: ctx.scope }).lines); } catch { lines.push('The plan is different from the one in this browser.'); }
    }
    const names = st => st.scenarios.map(s => s.name);
    const a = names(cur), b = names(next);
    if (JSON.stringify(a) !== JSON.stringify(b)) lines.push(`Scenarios: ${a.length} now (${a.join(', ')}) → ${b.length} in the file (${b.join(', ')}).`);
    else lines.push(`Scenarios: the same ${count(b.length, 'scenario')} by name (their changes may differ).`);
    const ids = new Set(ctx.dataset.transactions.map(t => t.id));
    const curEdits = Object.keys(cur.ledgerEdits || {}).length;
    const nextIds = Object.keys(next.ledgerEdits || {});
    const matched = nextIds.filter(id => ids.has(id)).length;
    lines.push(`Transaction corrections: ${curEdits} now → ${nextIds.length} in the file${nextIds.length ? ` (${matched} match transactions in the data used now)` : ''}.`);
    lines.push(`Reconciliation references: ${(cur.references || []).length} now → ${(next.references || []).length} in the file.`);
    return lines;
  }

  function workbookPage(ctx) {
    const w = S.workbook;
    const header = crumbs(ctx, [{ label: 'Import a workbook' }]) + c.pageHeader({
      eyebrow: 'Data & privacy', title: 'Import a workbook',
      subtitle: 'See what would change before your budget is replaced. Nothing changes until you choose “Replace my budget”.',
    });
    const picker = `<div class="dp-actions">${filePicker({ id: 'dp-workbook-pick', kind: 'workbook', label: w ? 'Choose a different file…' : 'Choose a workbook…', accept: ACCEPT.workbook, variant: w ? 'secondary' : 'primary' })}</div>`;
    if (!w) return header + `<div class="dp stack">${c.card(picker + c.empty('No file chosen yet. Files are kept only while this page is open.'), { title: 'Workbook file', id: 'dp-workbook-file' })}</div>`;
    if (w.error) return header + `<div class="dp stack">${c.card(`<div id="dp-workbook-result" class="dp-result" tabindex="-1">${c.notice({ tone: 'bad', title: `“${w.name}” cannot be imported`, body: esc(w.error) })}</div>${picker}`, { title: 'Workbook file', id: 'dp-workbook-file' })}</div>`;
    const kindText = {
      workbook: 'Budget workbook' + (w.exportedAt && dayOf(w.exportedAt) ? `, exported ${fmt.date(dayOf(w.exportedAt))}` : ''),
      state: 'Saved budget (current format)',
      earlier: 'Budget saved by the earlier version',
      page: 'Page downloaded from the earlier version',
    }[w.kind] || 'Budget file';
    const migrated = w.state.meta && w.state.meta.migratedFrom !== null && w.state.meta.migratedFrom !== undefined;
    const mismatch = w.sourceDatasetId && w.sourceDatasetId !== ctx.dataset.datasetId;
    const facts = [
      ['File', `<span class="dp-break">${esc(w.name)}</span><span class="dp-fact-sub">${esc(sizeText(w.size))}</span>`],
      ['Type', esc(kindText) + (migrated ? `<span class="dp-fact-sub">Upgraded to the current format; notes below.</span>` : '')],
      ['Made for data set', w.sourceDatasetId ? `<code class="dp-code">${esc(w.sourceDatasetId)}</code>` : 'Not recorded'],
    ];
    const mis = mismatch ? c.notice({ tone: 'warn', title: 'Made for different data', body: `This file was made for the data set “${esc(w.sourceDatasetId)}”; this page uses “${esc(ctx.dataset.datasetId)}”. The plan and scenarios apply as they are. Corrections only take effect for transactions that are in both.` }) : '';
    const changes = `<h3 class="dp-sub">What will change</h3><ul class="dp-points">${workbookChanges(ctx, w.state).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    const notes = w.notes.length ? details('dp-workbook-notes', `Notes from reading the file (${w.notes.length})`, `<ul class="dp-notes">${w.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`, { open: w.notes.length <= 12 }) : '';
    const summary = c.card(`<div id="dp-workbook-result" class="dp-result" tabindex="-1"><dl class="dp-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>${mis}${changes}<div class="dp-more">${notes}</div>${picker}`, { title: 'What is in the file', id: 'dp-workbook-file' });
    const decide = c.card(`<ul class="dp-points">
        <li>Your budget in this browser for “${esc(ctx.dataset.datasetId)}” is replaced by the one in the file.</li>
        <li>Transactions are not affected: a workbook does not contain them.</li>
        <li>You can undo it straight after, until this page is closed. To keep a copy of the current budget, export a workbook first.</li>
      </ul>
      <div class="dp-actions">
        ${c.button('Replace my budget', { action: 'dp:wb-apply', variant: 'primary', id: 'dp-wb-apply' })}
        ${c.button('Export current budget first', { action: 'dp:export-workbook', id: 'dp-wb-backup' })}
        ${c.button('Cancel', { action: 'dp:cancel', data: { what: 'workbook' }, variant: 'ghost', id: 'dp-wb-cancel' })}
      </div>`, { title: 'Replace your budget?', id: 'dp-wb-decide' });
    return `${header}<div class="dp stack"><div class="dp-grid"><div class="stack">${summary}</div><div class="stack">${decide}</div></div></div>`;
  }

  // ------------------------------------------------------------------ render
  function render(ctx) {
    const p = ctx.route.params;
    if (p.load === 'csv') return p.step === 'report' ? reportPage(ctx) : csvPage(ctx);
    if (p.load === 'dataset') return datasetPage(ctx);
    if (p.load === 'profile') return profilePage(ctx);
    if (p.load === 'workbook') return workbookPage(ctx);
    return hub(ctx);
  }

  /**
   * The data set name is checked while it is typed (an input listener, not a change action), so
   * nothing on the page moves when focus leaves the field: a click on "Check these files" that
   * follows still lands on the button.
   */
  function watchDatasetName(container, ctx) {
    const input = container.querySelector('#dp-csv-dsid');
    if (!input) return;
    input.addEventListener('input', () => {
      const id = input.value.trim();
      S.csv.datasetId = id;
      changed();
      const problem = datasetIdProblem(id);
      const err = document.getElementById('dp-csv-dsid-error');
      if (err) { err.textContent = problem || ''; err.hidden = !problem; }
      if (problem) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      const status = document.getElementById('dp-csv-dsid-status');
      if (status) status.textContent = budgetNameStatus(ctx, id);
    });
  }

  function afterRender(container, ctx) {
    watchDatasetName(container, ctx);
    // The confirmation after a reload is shown once: drop it from the address (and so from the
    // remembered last route) without another render.
    const p = ctx.route.params;
    if (!p.load && (p.loaded || p.forgot)) root.history.replaceState(null, '', ctx.href('data'));
    if (!pendingFocus) return;
    const id = pendingFocus;
    pendingFocus = null;
    // After the app has restored focus to the element that was active before the render.
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
    }, 0);
  }

  // ------------------------------------------------------------------ exports
  function csvCell(v, { text = true } = {}) {
    let s = v === null || v === undefined ? '' : String(v);
    // Spreadsheets run cells that start with = + - @ as formulas: bank text must stay text.
    if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function transactionsCsv(ctx) {
    const sh = UI.shared;
    const head = ['Date', 'Account', 'Description', 'Merchant', 'Amount (money out negative)', 'Kind', 'Category', 'Original bank category', 'Category reason',
      'Flags', 'Excluded', 'Counted spending', 'Edit reasons', 'Note', 'Transaction id'];
    const lines = [head.map(h => csvCell(h)).join(',')];
    for (const t of ctx.txns) {
      const edit = t.edit || {};
      const category = t.splitApplied && t.parts.length > 1 ? 'Split: ' + t.parts.map(p => p.category + ' ' + centsText(p.spendCents)).join('; ') : t.category;
      const reason = edit.category !== undefined && edit.category !== null ? edit.categoryReason || '' : t.categoryReason || '';
      const excluded = [
        t.excluded ? (sh.EXCLUDED_LABEL[t.excluded] || 'Not counted') : '',
        t.reimbursedCents ? `Partly reimbursed: ${centsText(t.reimbursedCents)} paid back` : '',
        t.planningExcluded ? 'Left out of the planning baseline' : '',
      ].filter(Boolean).join('; ');
      const history = (edit.history || []).map(h => `${h.at ? String(h.at).slice(0, 10) + ' ' : ''}${h.field}: ${h.reason || ''}`.trim()).join(' | ');
      lines.push([
        csvCell(t.date, { text: false }), csvCell(t.accountLabel || t.accountId), csvCell(t.description), csvCell(t.merchant),
        csvCell(centsText(t.amountCents), { text: false }), csvCell(sh.kindLabel(t)), csvCell(category), csvCell(t.sourceCategory || ''),
        csvCell(reason), csvCell((t.flags || []).join('; ')), csvCell(excluded), csvCell(centsText(E.ledger.measure(t).spendCents), { text: false }),
        csvCell(history), csvCell(t.note || ''), csvCell(t.id),
      ].join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function exportWorkbook(ctx) {
    const text = E.state.exportWorkbook(ctx.state, { datasetId: ctx.dataset.datasetId, now: new Date().toISOString() });
    ctx.app.download(`household-budget-workbook-${localDay()}.json`, text, 'application/json');
    ctx.app.toast('Workbook downloaded. It holds household financial details: keep it private.');
  }

  // ------------------------------------------------------------------ using loaded files
  function storageMissing() {
    return 'This browser is not letting the page keep anything (for example a private window, or blocked site data), so the data would be gone as soon as the page reloads. Use the command-line import and a private build instead.';
  }

  /** Store a dataset with app.useLoadedDataset (which reloads), landing on the hub afterwards. */
  function useDataset(ctx, dataset, meta, which, setError, errorId) {
    if (!ctx.app.storage) { setError(storageMissing()); rerender(ctx, errorId); return; }
    const before = root.location.hash;
    root.history.replaceState(null, '', ctx.href('data', { loaded: which }));
    try {
      ctx.app.useLoadedDataset(dataset, meta);
    } catch (err) {
      root.history.replaceState(null, '', before);
      setError(err && err.message ? err.message : String(err));
      rerender(ctx, errorId);
    }
  }

  // ------------------------------------------------------------------ actions
  async function readOne(ctx, file) {
    try { return await ctx.app.readFile(file); } catch (err) {
      throw new E.ValidationError(`“${file.name}” could not be read${err && err.message ? ' (' + err.message + ')' : ''}.`);
    }
  }

  async function pickCsv(ctx, files) {
    const added = [], problems = [];
    for (const file of files) {
      let text;
      try { text = await ctx.app.readFile(file); } catch (err) { problems.push(`“${file.name}” could not be read.`); continue; }
      if (/\u0000/.test(text.slice(0, 4096))) { problems.push(`“${file.name}” is not a CSV text file. Download the CSV version from your bank; a spreadsheet can also be saved as CSV.`); continue; }
      if (S.csv.files.some(f => f.text === text)) { problems.push(`“${file.name}” is already in the list.`); continue; }
      const f = {
        key: 'f' + (++seq), name: uniqueName(file.name), size: file.size, text, records: firstRecords(text),
        account: '', guessed: false, coverageStart: '', coverageEnd: '', cols: null, amountStyle: '', dateFormat: '', charges: '', noHeader: false,
      };
      const guess = guessAccount(ctx, file.name);
      if (guess) { f.account = guess; f.guessed = true; }
      S.csv.files.push(f);
      added.push(f);
    }
    S.csv.result = null;
    S.csv.error = null;
    S.csv.pickError = problems.length ? problems : null;
    const p = ctx.route.params;
    const onPage = p.load === 'csv' && p.step !== 'report';
    if (onPage) pendingFocus = added.length ? 'dp-f-' + added[0].key + '-h' : 'dp-csv-add';
    ctx.app.navigate('data', { load: 'csv' }, { keepFocus: onPage });
  }

  function goLoad(ctx, which) {
    const onPage = ctx.route.params.load === which;
    if (onPage) pendingFocus = 'dp-' + which + '-result';
    ctx.app.navigate('data', { load: which }, { keepFocus: onPage });
  }

  function fileFrom(el) {
    const f = fileByKey(el.dataset.file);
    if (!f) throw new E.ValidationError('That file is no longer in the list.');
    return f;
  }

  function changed() { S.csv.result = null; S.csv.useError = null; }

  const actions = {
    /** Any file input on this page: data-kind = csv | rules | dataset | profile | workbook. */
    'dp:pick': async (ctx, el) => {
      const kind = el.dataset.kind;
      const files = Array.from(el.files || []);
      try { el.value = ''; } catch { /* some browsers keep the value; harmless */ }
      if (!files.length) return;
      if (kind === 'csv') return pickCsv(ctx, files);
      const file = files[0];
      const text = await readOne(ctx, file);
      if (kind === 'rules') {
        const st = S.csv;
        st.rulesError = null;
        try {
          const rules = JSON.parse(text.replace(/^﻿/, ''));
          if (!isObj(rules)) throw new E.ValidationError('A rules file is a JSON object with merchantRules, transferHints and categoryMap.');
          E.importer.prepareRules(rules); // validates every pattern
          st.rules = rules;
          st.rulesName = file.name;
          const n = k => (Array.isArray(rules[k]) ? rules[k].length : 0);
          st.rulesInfo = `${count(n('merchantRules'), 'rule')}, ${count(n('transferHints'), 'transfer hint')}, ${count(Object.keys(isObj(rules.categoryMap) ? rules.categoryMap : {}).length, 'bank category', 'bank categories')} mapped`;
        } catch (err) {
          st.rules = null;
          st.rulesError = err instanceof SyntaxError ? 'This file is not valid JSON.' : (err && err.message) || String(err);
        }
        changed();
        rerender(ctx, st.rules ? 'dp-rules-remove' : 'dp-rules-h');
        return;
      }
      if (kind === 'dataset') { S.dataset = prepareDataset(ctx, file, text); return goLoad(ctx, 'dataset'); }
      if (kind === 'profile') { S.profile = prepareProfile(ctx, file, text); return goLoad(ctx, 'profile'); }
      if (kind === 'workbook') { S.workbook = prepareWorkbook(ctx, file, text); return goLoad(ctx, 'workbook'); }
    },

    'dp:csv-remove': (ctx, el) => {
      const i = S.csv.files.findIndex(f => f.key === el.dataset.file);
      if (i < 0) return;
      S.csv.files.splice(i, 1);
      changed();
      const next = S.csv.files[i] || S.csv.files[i - 1];
      rerender(ctx, next ? 'dp-f-' + next.key + '-h' : 'dp-csv-add');
    },

    'dp:csv-account': (ctx, el) => {
      const f = fileFrom(el);
      f.account = el.value;
      f.guessed = false;
      changed();
      rerender(ctx, f.account === '__new__' ? `dp-f-${f.key}-nlabel` : null);
    },

    'dp:csv-new-account': (ctx, form) => {
      const f = fileFrom(form);
      const data = new FormData(form);
      const label = String(data.get('label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!label) throw new E.ValidationError('Give the new account a name, such as “Joint checking”.');
      const all = accountOptions(ctx);
      if (all.some(a => a.label.toLowerCase() === label.toLowerCase())) throw new E.ValidationError(`An account called “${label}” is already in the list. Choose it, or use another name.`);
      const type = NEW_TYPES.includes(data.get('type')) ? data.get('type') : 'checking';
      const owner = data.get('owner');
      const scope = owner === 'p1' || owner === 'p2' ? 'personal' : 'joint';
      const id = slugId(label, new Set(all.map(a => a.id)));
      S.csv.newAccounts.push({ id, label, type, scope, ownerId: scope === 'personal' ? owner : null, paidInFull: false });
      f.account = id;
      changed();
      rerender(ctx, `dp-f-${f.key}-acct`);
      ctx.app.toast(`Account “${label}” added to this import.`);
    },

    'dp:csv-new-cancel': (ctx, el) => {
      const f = fileFrom(el);
      f.account = '';
      rerender(ctx, `dp-f-${f.key}-acct`);
    },

    'dp:csv-cover': (ctx, el) => {
      const f = fileFrom(el);
      const v = el.value && E.dates.isDate(el.value) ? el.value : '';
      if (el.dataset.edge === 'end') f.coverageEnd = v; else f.coverageStart = v;
      changed();
      // No re-render: a date typed from the keyboard reports a change after each part, and a
      // re-render would put the cursor back on the month and scramble the date being typed.
      coverStatus(f);
    },

    'dp:csv-col': (ctx, el) => {
      const f = fileFrom(el);
      ensureCols(ctx, f);
      f.cols = { ...f.cols, [el.dataset.col]: el.value };
      changed();
      rerender(ctx);
    },

    'dp:csv-opt': (ctx, el) => {
      const f = fileFrom(el);
      const opt = el.dataset.opt;
      if (!['amountStyle', 'dateFormat', 'charges'].includes(opt)) return;
      if (opt === 'amountStyle') ensureCols(ctx, f);
      f[opt] = el.value;
      changed();
      rerender(ctx);
    },

    'dp:csv-nohead': (ctx, el) => {
      const f = fileFrom(el);
      f.noHeader = !!el.checked;
      f.cols = f.noHeader ? {} : null;
      if (!f.noHeader) f.amountStyle = '';
      else if (!f.amountStyle) f.amountStyle = 'signed';
      changed();
      rerender(ctx);
    },

    'dp:csv-detect': (ctx, el) => {
      const f = fileFrom(el);
      f.cols = null;
      f.noHeader = false;
      f.amountStyle = '';
      changed();
      rerender(ctx, `dp-f-${f.key}-cols-sum`);
    },

    'dp:csv-rules-remove': ctx => {
      S.csv.rules = null; S.csv.rulesName = ''; S.csv.rulesInfo = ''; S.csv.rulesError = null;
      changed();
      rerender(ctx, 'dp-pick-rules');
    },

    'dp:csv-check': (ctx, form) => {
      const st = S.csv;
      const data = new FormData(form);
      st.datasetId = String(data.get('datasetId') || '').trim();
      const problems = [];
      if (!st.files.length) problems.push('Choose at least one CSV file.');
      let readable = 0;
      for (const f of st.files) {
        if (!accountById(ctx, f.account)) { problems.push(`Choose the account for “${f.name}”.`); continue; }
        const cover = coverProblem(f);
        if (cover) problems.push(`“${f.name}”, export dates: ${cover}`);
        const an = analyze(ctx, f);
        if (!an.ok) { problems.push(`“${f.name}”: ${an.error}`); continue; }
        readable += an.count;
        // An export with no transactions and no stated period would add an account with no
        // covered days, which makes every month look incomplete.
        if (!an.count && !(f.coverageStart && f.coverageEnd)) {
          problems.push(`“${f.name}”: no transactions could be read. ${dateOrderSuspect(an) ? 'Choose “Day/month/year” under “Dates are written”, ' : ''}Remove the file, or enter both dates the export covers if the account had no activity.`);
        }
      }
      if (st.files.length && !problems.length && !readable) problems.push('None of these files has a transaction that could be read.');
      const dsProblem = datasetIdProblem(st.datasetId);
      if (dsProblem) problems.push('Data set name: ' + dsProblem);
      st.result = null;
      st.useError = null;
      if (problems.length) {
        st.error = { title: problems.length === 1 ? 'One thing to fix first' : `${problems.length} things to fix first`, items: problems };
        rerender(ctx, 'dp-csv-error');
        return;
      }
      const used = new Set(st.files.map(f => f.account));
      // Only the accounts these files belong to, without old coverage: an account in the list
      // with no export would make every month look incomplete, and old coverage would claim
      // days these files do not have.
      const accounts = accountOptions(ctx).filter(a => used.has(a.id)).map(a => ({ id: a.id, label: a.label, type: a.type, scope: a.scope, ownerId: a.ownerId, paidInFull: a.paidInFull, coverage: [] }));
      const today = localDay();
      try {
        const res = E.importer.buildDataset({
          files: st.files.map(f => ({ name: f.name, text: f.text, accountId: f.account, mapping: mappingFor(f), coverageStart: f.coverageStart || undefined, coverageEnd: f.coverageEnd || undefined })),
          accounts,
          rules: st.rules || E.importer.DEFAULT_RULES,
          datasetId: st.datasetId,
          isSynthetic: false,
          generatedAt: today,
          notes: [`Imported in the browser on ${today} from ${count(st.files.length, 'CSV file')}${st.rules ? ' with the rules in ' + st.rulesName : ' with the general rules'}.`],
        });
        st.result = res;
        st.error = null;
        ctx.app.navigate('data', { load: 'csv', step: 'report' });
      } catch (err) {
        if (!err || err.name !== 'ValidationError') throw err;
        st.error = { title: 'The files could not be imported', items: [err.message] };
        rerender(ctx, 'dp-csv-error');
      }
    },

    'dp:csv-use': ctx => {
      const st = S.csv;
      if (!st.result) return;
      if (!st.result.report.transactions) throw new E.ValidationError('These files have no transactions to use.');
      useDataset(ctx, st.result.dataset, { source: 'csv', files: st.files.map(f => f.name) }, 'csv', msg => { st.useError = msg; }, 'dp-csv-use-error');
    },

    'dp:dataset-use': ctx => {
      const d = S.dataset;
      if (!d || !d.dataset) return;
      useDataset(ctx, d.dataset, { source: 'json', file: d.name }, 'dataset', msg => { d.useError = msg; }, 'dp-dataset-use-error');
    },

    'dp:profile-use': (ctx, form) => {
      const p = S.profile;
      if (!p || !p.profile) return;
      const mode = new FormData(form).get('mode') === 'keep' ? 'keep' : 'start';
      if (!ctx.app.storage) { p.useError = storageMissing(); rerender(ctx, 'dp-profile-use-error'); return; }
      let replaced = false;
      if (mode === 'start') {
        // Start the plan and scenarios from the new profile; keep corrections, references and settings.
        const cur = ctx.state;
        const fresh = E.state.defaults(p.profile, ctx.dataset, { now: new Date().toISOString() });
        const next = { ...fresh, ledgerEdits: cur.ledgerEdits, references: cur.references, checklist: cur.checklist, ui: cur.ui, meta: { ...cur.meta, updatedAt: fresh.meta.updatedAt } };
        ctx.app.replaceState(next);
        replaced = true;
      }
      const before = root.location.hash;
      root.history.replaceState(null, '', ctx.href('data', { loaded: 'profile' }));
      try {
        ctx.app.useLoadedProfile(p.profile);
      } catch (err) {
        root.history.replaceState(null, '', before);
        if (replaced) ctx.app.undo();
        p.useError = (err && err.message ? err.message : String(err)) + ' The profile may be too large for this browser’s storage.';
        rerender(ctx, 'dp-profile-use-error');
      }
    },

    'dp:wb-apply': ctx => {
      const w = S.workbook;
      if (!w || !w.state) return;
      const migrated = w.state.meta && w.state.meta.migratedFrom !== null && w.state.meta.migratedFrom !== undefined;
      ctx.app.replaceState(w.state, migrated ? `Budget replaced from “${w.name}”. Upgrade notes are on this page.` : `Budget replaced from “${w.name}”.`);
      S.workbook = null;
      ctx.app.navigate('data', {});
    },

    'dp:cancel': (ctx, el) => {
      const what = el.dataset.what;
      if (what === 'csv') S.csv = freshCsv();
      else if (what === 'dataset') S.dataset = null;
      else if (what === 'profile') S.profile = null;
      else if (what === 'workbook') S.workbook = null;
      analysisCache.clear();
      ctx.app.navigate('data', {});
    },

    'dp:forget': async ctx => {
      const loadedData = ctx.app.dataSource === 'browser', loadedProfile = ctx.app.profileSource === 'browser';
      const what = [loadedData ? `the transactions (data set “${esc(ctx.dataset.datasetId)}”)` : '', loadedProfile ? 'the household profile' : ''].filter(Boolean).join(' and ') || 'the files';
      const ok = await ctx.app.confirm({
        title: 'Forget the files loaded in this browser?',
        body: `<p>This browser stops keeping ${what} you loaded. The page reloads with ${esc(builtInName(ctx))}${loadedProfile ? ' and its built-in profile' : ''}.</p>
          <p>Budgets saved in this browser are kept, so loading the same files again brings yours back. To remove everything this page saved, clear this site’s data in your browser settings.</p>`,
        confirmLabel: 'Forget loaded files',
        danger: true,
      });
      if (!ok) return;
      root.history.replaceState(null, '', ctx.href('data', { forgot: '1' }));
      ctx.app.forgetLoadedFiles();
    },

    'dp:export-workbook': ctx => exportWorkbook(ctx),

    'dp:export-csv': ctx => {
      if (!ctx.txns.length) throw new E.ValidationError('There are no transactions to export.');
      ctx.app.download(`household-budget-transactions-${localDay()}.csv`, transactionsCsv(ctx), 'text/csv');
      ctx.app.toast(`${count(ctx.txns.length, 'transaction')} downloaded. The file holds financial details: keep it private.`);
    },

    'dp:backup-download': ctx => {
      const snap = ctx.state.meta && ctx.state.meta.legacySnapshot;
      if (!snap) throw new E.ValidationError('There is no pre-upgrade backup in this budget.');
      let json = true;
      try { JSON.parse(snap); } catch { json = false; }
      ctx.app.download(`household-budget-pre-upgrade-backup-${localDay()}.${json ? 'json' : 'txt'}`, snap, json ? 'application/json' : 'text/plain');
      ctx.app.toast('Pre-upgrade backup downloaded. Keep it private.');
    },

    'dp:print': ctx => {
      const print = () => setTimeout(() => { try { root.print(); } catch { /* printing unavailable */ } }, 300);
      root.addEventListener('hashchange', print, { once: true });
      ctx.app.navigate('budget', {});
    },

    'dp:reset': async ctx => {
      const st = ctx.state;
      const name = profileName(ctx.profile);
      const edits = Object.keys(st.ledgerEdits || {}).length;
      const extra = st.scenarios.length - 1;
      const ok = await ctx.app.confirm({
        title: 'Reset the budget to the household profile?',
        body: `<p>The budget saved in this browser for “${esc(ctx.dataset.datasetId)}” is replaced with the starting values from ${name ? `“${esc(name)}”` : 'the household profile'}. You lose:</p>
          <ul class="dp-notes">
            <li>Changes to pay, bills, targets, savings goals and debts</li>
            <li>Your scenarios and their changes (${esc(count(extra, 'scenario'))} besides the current budget); the profile’s starting scenarios come back</li>
            <li>${esc(count(edits, 'transaction correction'))} and ${esc(count((st.references || []).length, 'reconciliation reference'))}</li>
            ${st.meta && st.meta.legacySnapshot ? '<li>The upgrade notes and the pre-upgrade backup</li>' : ''}
          </ul>
          <p>Transactions and loaded files are not affected. <strong>Export a workbook first</strong> if you may want this budget back later; you can also undo the reset straight after, until this page is closed.</p>
          <p>${c.button('Export workbook first', { action: 'dp:export-workbook', id: 'dp-reset-backup', cls: 'btn-small' })}</p>`,
        confirmLabel: 'Reset the budget',
        danger: true,
      });
      if (!ok) return;
      const fresh = E.state.defaults(ctx.profile, ctx.dataset, { now: new Date().toISOString() });
      fresh.ui = { ...fresh.ui, scope: st.ui.scope, lastRoute: st.ui.lastRoute };
      ctx.app.replaceState(fresh, 'Budget reset to the household profile.');
    },
  };

  UI.views = UI.views || {};
  UI.views.data = { title: 'Data & privacy', render, afterRender, actions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
