'use strict';
/*
 * BudgetEngine.importer — turns bank and card CSV exports into the normalized dataset (schema v2).
 *
 * Pipeline used by buildDataset():
 *   parseCSV -> detectMapping -> normalizeFile (dates, signed account flow, skipped rows)
 *   -> dedupe (overlapping exports) -> assignIds (stable) -> classify (rules)
 *   -> pairTransfers -> markReimbursementCandidates -> { dataset, report }
 *
 * Runs unchanged in the browser and in Node: no fs/require, no clock, no storage.
 * Amounts are integer cents in SIGNED ACCOUNT FLOW: negative = money left the account
 * (purchase, bill, card charge, transfer out); positive = money entered (deposit, refund,
 * transfer in, payment received on a card).
 */
(function (root) {
  const E = root.BudgetEngine || (root.BudgetEngine = {});

  const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'loan', 'other'];
  const KINDS = ['spend', 'income', 'transfer', 'card_payment', 'debt_payment'];
  const CONFIDENCE = ['high', 'medium', 'low'];
  const DATE_FORMATS = ['MDY', 'YMD', 'DMY'];
  const RULE_FIELDS = ['description', 'merchant', 'sourceCategory'];
  const HINT_SUBTYPES = ['savings', 'contribution', 'internal', 'investment'];
  /** Accounts whose exports must be present for a month's spending to be complete (matches ledger). */
  const SPENDING_ACCOUNT_TYPES = ['checking', 'credit_card', 'other'];
  const UNCATEGORIZED = 'Uncategorized';
  const KIND_CATEGORY = { income: 'Income', transfer: 'Transfer', card_payment: 'Card payment', debt_payment: 'Debt payment' };
  /** Card-side text that identifies a payment toward the card (used for sign inference). */
  const PAYMENT_TEXT = /PAYMENT|THANK YOU|AUTOPAY|AUTO PAY|AUTOMATIC PAYMENT/i;
  const HEADER_SCAN_ROWS = 30;
  const CASH_SIDE = ['checking', 'savings', 'other'];

  function fail(message, extra) {
    const err = new E.ValidationError(message);
    if (extra) Object.assign(err, extra);
    return err;
  }
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const norm = s => E.util.normalizeText(s);
  const money = cents => E.money.format(cents);
  const byDateThenId = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const copyTxn = t => ({ ...t, flags: (t.flags || []).slice(), matchIds: (t.matchIds || []).slice() });

  function addFlag(t, flag) { if (!t.flags.includes(flag)) t.flags.push(flag); }
  function removeFlag(t, flag) { t.flags = t.flags.filter(f => f !== flag); }
  function addNote(t, text) {
    if (!text || (t.note || '').includes(text)) return;
    t.note = t.note ? t.note + ' ' + text : text;
  }
  function addReason(t, text) {
    if (!text || (t.categoryReason || '').includes(text)) return;
    t.categoryReason = t.categoryReason ? t.categoryReason + '; ' + text : text;
  }

  // ------------------------------------------------------------------ CSV

  /**
   * RFC 4180 parser that also reports the physical line each record starts on.
   * Handles quoted fields (commas, newlines, doubled quotes), CRLF/LF/CR, a UTF-8 BOM and
   * blank lines (skipped). Lenient with stray quotes inside unquoted fields.
   * @returns {{line: number, fields: string[]}[]}
   */
  function parseCSVRecords(text) {
    let s = String(text ?? '');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const records = [];
    let fields = [], field = '', inQuotes = false, quoted = false;
    let line = 1, recordLine = 1;

    const endField = () => { fields.push(field); field = ''; };
    const endRecord = () => {
      endField();
      const blank = !quoted && fields.length === 1 && fields[0].trim() === '';
      if (!blank) records.push({ line: recordLine, fields });
      fields = []; quoted = false;
    };

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else {
          if (c === '\n' || (c === '\r' && s[i + 1] !== '\n')) line++;
          field += c;
        }
      } else if (c === '"' && field.trim() === '') {
        field = ''; inQuotes = true; quoted = true; // opening quote (leading spaces dropped)
      } else if (c === ',') {
        endField();
      } else if (c === '\r' || c === '\n') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        endRecord();
        line++;
        recordLine = line;
      } else {
        field += c;
      }
    }
    if (field !== '' || fields.length > 0 || quoted) endRecord(); // last line without a newline
    return records;
  }

  /** Parse CSV text into rows of strings (see parseCSVRecords). */
  function parseCSV(text) {
    return parseCSVRecords(text).map(r => r.fields);
  }

  // ------------------------------------------------------------------ header detection

  /** Header names recognised for each logical column (compared after normalizeText). */
  const COLUMN_SYNONYMS = {
    transactionDate: ['transaction date', 'trans date', 'purchase date', 'date of transaction'],
    postedDate: ['posted date', 'post date', 'posting date', 'date posted', 'posted on', 'posted'],
    plainDate: ['date', 'effective date', 'value date'],
    description: ['description', 'payee', 'merchant', 'merchant name', 'transaction description', 'original description', 'name', 'memo'],
    amount: ['amount', 'transaction amount', 'amount usd', 'amt'],
    debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'withdrawal amount', 'money out'],
    credit: ['credit', 'credits', 'credit amount', 'deposit', 'deposits', 'deposit amount', 'money in'],
    category: ['category', 'transaction category', 'merchant category'],
    type: ['type', 'transaction type', 'details'],
    balance: ['balance', 'running balance', 'running bal', 'available balance'],
    status: ['status', 'transaction status']
  };
  const ANY_DATE = ['plainDate', 'postedDate', 'transactionDate'];

  /**
   * Header-based mappings, most specific first. `sources` lists which synonym groups may fill
   * each mapping field. Card exports with a single Amount column have no fixed sign convention:
   * normalizeFile uses mapping.chargesPositive or infers it from the rows.
   */
  const PROFILES = [
    {
      id: 'card_debit_credit',
      label: 'Card export: transaction + posted dates, Debit and Credit columns (Capital One style)',
      sources: { date: ['transactionDate'], postDate: ['postedDate'], description: ['description'], debit: ['debit'], credit: ['credit'] }
    },
    {
      id: 'card_signed_amount',
      label: 'Card export: transaction + posted dates and one Amount column (charge sign inferred or set by chargesPositive)',
      sources: { date: ['transactionDate'], postDate: ['postedDate'], description: ['description'], amount: ['amount'] }
    },
    {
      id: 'debit_credit',
      label: 'Date, Description, Debit and Credit columns (Citi style)',
      sources: { date: ANY_DATE, description: ['description'], debit: ['debit'], credit: ['credit'] }
    },
    {
      id: 'signed_amount',
      label: 'Date, Description and one signed Amount column (money out negative)',
      sources: { date: ANY_DATE, description: ['description'], amount: ['amount'] }
    }
  ];
  const OPTIONAL_COLUMNS = ['category', 'type', 'balance', 'status'];

  function findColumn(normHeader, groups, used) {
    for (const g of groups) {
      for (const name of COLUMN_SYNONYMS[g]) {
        const idx = normHeader.findIndex((h, i) => h === name && !used.has(i));
        if (idx >= 0) return idx;
      }
    }
    return -1;
  }

  /**
   * Recognise a header row from common US bank/card exports (case and whitespace insensitive).
   * @param {string[]} header
   * @returns {object|null} Mapping with the file's own column names, or null when unrecognised.
   */
  function detectMapping(header) {
    if (!Array.isArray(header) || !header.length) return null;
    const normHeader = header.map(h => norm(h));
    for (const profile of PROFILES) {
      const used = new Set();
      const mapping = { profile: profile.id, dateFormat: 'MDY' };
      let ok = true;
      for (const [field, groups] of Object.entries(profile.sources)) {
        const idx = findColumn(normHeader, groups, used);
        if (idx < 0) { ok = false; break; }
        used.add(idx);
        mapping[field] = String(header[idx]).trim();
      }
      if (!ok) continue;
      // Txn.date is the POSTED date. When a plain "Date" sits next to a posted-date column, the
      // plain one is the transaction date: book by the posted date. (A bare "Posted" column is
      // often a yes/no status, so only names that say "date" count here.)
      if (!mapping.postDate) {
        const idx = findColumn(normHeader, ['postedDate'], used);
        if (idx >= 0 && normHeader[idx].includes('date')) { used.add(idx); mapping.postDate = String(header[idx]).trim(); }
      }
      for (const field of OPTIONAL_COLUMNS) {
        const idx = findColumn(normHeader, [field], used);
        if (idx >= 0) { used.add(idx); mapping[field] = String(header[idx]).trim(); }
      }
      return mapping;
    }
    return null;
  }

  // ------------------------------------------------------------------ dates

  /**
   * Parse a bank date. Year-first dates (YYYY-MM-DD, YYYY/MM/DD, YYYYMMDD) are unambiguous and
   * accepted in every format; 'MDY' reads M/D/YYYY and MM/DD/YY (-> 20YY); 'DMY' reads D/M/Y.
   * A trailing time is ignored. Invalid dates (2/30/2025) return null.
   * @returns {string|null} 'YYYY-MM-DD'
   */
  function parseDate(text, format = 'MDY') {
    if (!DATE_FORMATS.includes(format)) throw fail('Date format must be MDY, YMD or DMY (got ' + JSON.stringify(format) + ').');
    if (text === null || text === undefined) return null;
    let s = String(text).trim();
    if (!s) return null;
    s = s.replace(/[T\s]+\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*([AP]M)?\s*(Z|[+-]\d{2}:?\d{2})?$/i, '');
    let y, m, d, mt;
    if ((mt = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)) || (mt = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
      y = Number(mt[1]); m = Number(mt[2]); d = Number(mt[3]);
    } else if ((mt = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) {
      if (format === 'YMD') return null;
      const a = Number(mt[1]), b = Number(mt[2]);
      y = mt[3].length === 2 ? 2000 + Number(mt[3]) : Number(mt[3]);
      if (format === 'DMY') { d = a; m = b; } else { m = a; d = b; }
    } else {
      return null;
    }
    const iso = String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    return E.dates.isDate(iso) ? iso : null;
  }

  // ------------------------------------------------------------------ merchant names

  const MERCHANT_PREFIXES = /^(POS PURCHASE|POS|DEBIT CARD PURCHASE|DEBIT PURCHASE|CHECKCARD|CHECK CARD|PURCHASE AUTHORIZED ON \d{1,2}\/\d{1,2}|PURCHASE|RECURRING|PREAUTHORIZED|SQ ?\*|TST ?\*|SP ?\*)\s*/i;

  /** Readable display name from raw bank text: drops POS prefixes, reference codes and store numbers. */
  function cleanMerchant(description) {
    const original = String(description ?? '').replace(/\s+/g, ' ').trim();
    let s = original;
    for (let k = 0; k < 3 && MERCHANT_PREFIXES.test(s); k++) s = s.replace(MERCHANT_PREFIXES, '');
    const star = s.indexOf('*');
    if (star > 0) {
      const before = s.slice(0, star).trim();
      s = /[A-Za-z].*[A-Za-z].*[A-Za-z]/.test(before) ? before : s.slice(star + 1).trim();
    }
    const words = s.split(' ').filter(w => w && !w.includes('#') && !/^[\d\-./]+$/.test(w));
    if (!words.length) return original;
    const caseWord = w => {
      if (/[a-z]/.test(w)) return w;                                             // already mixed case
      if (w.length <= 3 && !/[AEIOU]/.test(w) && /^[A-Z&]+$/.test(w)) return w; // CVS-like acronyms
      return w.charAt(0) + w.slice(1).toLowerCase();
    };
    return words.map(w => w.split(/([/-])/).map(caseWord).join('')).join(' ');
  }

  // ------------------------------------------------------------------ normalizeFile

  function resolveColumn(header, spec) {
    if (typeof spec === 'number') return Number.isInteger(spec) && spec >= 0 ? spec : -1;
    if (typeof spec !== 'string' || !spec.trim()) return -1;
    const want = norm(spec);
    return header ? header.findIndex(h => norm(h) === want) : -1;
  }

  function isCompleteMapping(m) {
    return isObj(m) && m.date != null && m.description != null && (m.amount != null || (m.debit != null && m.credit != null));
  }

  /** Find the header row (exports sometimes start with account details) and resolve columns. */
  function locateHeader(records, mapping, fileName) {
    const user = isObj(mapping) ? mapping : null;
    const scan = Math.min(records.length, HEADER_SCAN_ROWS);
    let index = -1, map = null;
    if (isCompleteMapping(user)) {
      map = { ...user, dateFormat: user.dateFormat || 'MDY' };
      const named = ['date', 'postDate', 'description', 'amount', 'debit', 'credit'].filter(k => typeof map[k] === 'string');
      if (!named.length && !user.hasHeader) {
        index = -1; // purely positional mapping for a header-less export
      } else {
        for (let i = 0; i < scan && index < 0; i++) {
          if (named.every(k => resolveColumn(records[i].fields, map[k]) >= 0)) index = i;
        }
        if (index < 0) throw fail('"' + fileName + '": the mapped columns (' + named.map(k => map[k]).join(', ') + ') were not found in the first ' + HEADER_SCAN_ROWS + ' rows.');
      }
    } else {
      for (let i = 0; i < scan && index < 0; i++) {
        const detected = detectMapping(records[i].fields);
        if (detected) {
          index = i;
          map = { ...detected };
          if (user) for (const [k, v] of Object.entries(user)) if (v !== undefined && v !== null) map[k] = v;
        }
      }
      if (index < 0) {
        throw fail('Could not recognise the column headers in "' + fileName + '". Add a "mapping" for this file in the import config ' +
          '(date, description, and amount or debit + credit column names).', { code: 'UNRECOGNISED_HEADER', header: records.length ? records[0].fields.slice() : [] });
      }
    }
    if (!DATE_FORMATS.includes(map.dateFormat)) throw fail('"' + fileName + '": dateFormat must be MDY, YMD or DMY.');
    // An explicit sign instruction must never be silently ignored (e.g. "true" as text would
    // otherwise fall back to inference and could import every charge with the wrong sign).
    if (map.chargesPositive !== undefined && map.chargesPositive !== null && typeof map.chargesPositive !== 'boolean') {
      throw fail('"' + fileName + '": chargesPositive must be true or false (without quotes), got ' + JSON.stringify(map.chargesPositive) + '.');
    }
    const header = index >= 0 ? records[index].fields : null;
    const columns = {};
    for (const key of ['date', 'postDate', 'description', 'amount', 'debit', 'credit', ...OPTIONAL_COLUMNS]) {
      if (map[key] === undefined || map[key] === null) continue;
      const idx = resolveColumn(header, map[key]);
      if (idx >= 0) columns[key] = idx;
      else if (['date', 'description', 'amount', 'debit', 'credit'].includes(key)) {
        throw fail('"' + fileName + '": column ' + JSON.stringify(map[key]) + ' (' + key + ') was not found.');
      }
    }
    return { index, map, columns };
  }

  /**
   * Decide whether a single-Amount card export lists charges as positive numbers.
   * Evidence: purchases (rows without payment wording) and payments should have opposite signs.
   * Throws when the file cannot tell (all one sign including payments, or a tie).
   */
  function inferCardSign(raw, fileName, noun = 'card') {
    let purchPos = 0, purchNeg = 0, payPos = 0, payNeg = 0;
    for (const x of raw) {
      if (PAYMENT_TEXT.test(x.description)) { if (x.amount > 0) payPos++; else payNeg++; } else if (x.amount > 0) purchPos++; else purchNeg++;
    }
    const purchases = purchPos + purchNeg, payments = payPos + payNeg;
    const sameSign = purchases && payments && purchPos !== purchNeg && payPos !== payNeg && (purchPos > purchNeg) === (payPos > payNeg);
    const forPositive = purchPos + payNeg, forNegative = purchNeg + payPos;
    if (sameSign || forPositive === forNegative) {
      throw fail('Cannot tell how "' + fileName + '" signs ' + noun + ' charges (purchases ' + purchPos + ' positive / ' + purchNeg +
        ' negative; payments ' + payPos + ' positive / ' + payNeg + ' negative). Set "chargesPositive": true or false in this file\'s mapping.',
      { code: 'SIGN_UNKNOWN' });
    }
    const chargesPositive = forPositive > forNegative;
    const evidence = (chargesPositive ? purchPos : purchNeg) + ' of ' + purchases + ' purchase rows ' + (chargesPositive ? 'positive' : 'negative') +
      (payments ? ', ' + (chargesPositive ? payNeg : payPos) + ' of ' + payments + ' payment rows ' + (chargesPositive ? 'negative' : 'positive') : ', no payment rows to confirm');
    const warning = '"' + fileName + '": inferred that ' + noun + ' charges are ' + (chargesPositive ? 'POSITIVE' : 'negative') + ' numbers (' + evidence + '). ' +
      (chargesPositive ? 'Signs were flipped so charges are money out.' : 'Amounts kept as account flow.') +
      ' Set "chargesPositive" in the mapping if this is wrong.';
    return { chargesPositive, warning };
  }

  /**
   * Parse one export for one account into unclassified transactions in signed account flow.
   * @param {{name: string, text: string, account: object, mapping?: object}} input
   * @returns {{txns: object[], skipped: {row: number, reason: string}[], mapping: object, start: string|null,
   *            end: string|null, rows: number, headerRow: number|null, signConvention: string, warnings: string[]}}
   */
  function normalizeFile({ name, text, account, mapping } = {}) {
    if (!account || typeof account.id !== 'string' || !account.id) throw fail('normalizeFile needs the account the file belongs to.');
    const fileName = String(name || 'file');
    const records = parseCSVRecords(text);
    const warnings = [];
    if (!records.length) {
      return { txns: [], skipped: [], mapping: isObj(mapping) ? { ...mapping } : null, start: null, end: null, rows: 0, headerRow: null, signConvention: 'empty file', warnings: ['"' + fileName + '" has no rows.'] };
    }
    const { index, map, columns } = locateHeader(records, mapping, fileName);
    const has = key => columns[key] !== undefined;
    const usesDebitCredit = !has('amount');

    const raw = [];
    const skipped = [];
    let rows = 0;
    for (let r = index + 1; r < records.length; r++) {
      const { fields, line } = records[r];
      if (fields.every(f => f.trim() === '')) continue;
      rows += 1;
      const get = key => (has(key) ? String(fields[columns[key]] ?? '').trim() : '');

      if (has('status') && /pending/i.test(get('status'))) { skipped.push({ row: line, reason: 'pending' }); continue; }

      const postedText = has('postDate') ? get('postDate') : '';
      const dateText = postedText || get('date');
      if (!dateText) { skipped.push({ row: line, reason: 'missing date' }); continue; }
      const date = parseDate(dateText, map.dateFormat);
      if (!date) { skipped.push({ row: line, reason: 'invalid date "' + dateText + '"' }); continue; }
      const transactionDate = postedText ? parseDate(get('date'), map.dateFormat) : null;

      let amount;
      try {
        if (usesDebitCredit) {
          const debit = E.money.parseAmount(get('debit'));
          const credit = E.money.parseAmount(get('credit'));
          if (debit === null && credit === null) { skipped.push({ row: line, reason: 'missing amount' }); continue; }
          // Debit = money out, credit = money in, whatever sign the bank printed.
          amount = Math.abs(credit || 0) - Math.abs(debit || 0);
        } else {
          amount = E.money.parseAmount(get('amount'));
          if (amount === null) { skipped.push({ row: line, reason: 'missing amount' }); continue; }
        }
      } catch (err) {
        if (!(err instanceof E.ValidationError)) throw err;
        const shown = usesDebitCredit ? (get('debit') + ' / ' + get('credit')) : get('amount');
        skipped.push({ row: line, reason: 'invalid amount "' + shown + '"' });
        continue;
      }
      if (amount === 0) { skipped.push({ row: line, reason: 'zero amount' }); continue; }
      // Beyond any household amount (and beyond exact integer cents): a column mix-up, not money.
      if (!Number.isSafeInteger(amount) || Math.abs(amount) > E.money.MAX_INPUT_CENTS) {
        const shown = usesDebitCredit ? (get('debit') + ' / ' + get('credit')) : get('amount');
        skipped.push({ row: line, reason: 'amount too large "' + shown + '"' });
        continue;
      }

      raw.push({
        row: line,
        date,
        transactionDate,
        description: get('description').replace(/\s+/g, ' ') || '(no description)',
        amount,
        category: get('category') || null,
        type: get('type')
      });
    }

    // ---- sign convention -> signed account flow
    let signConvention;
    if (usesDebitCredit) {
      signConvention = 'Debit/Credit columns (debit = money out, credit = money in)';
    } else if (account.type === 'credit_card' || account.type === 'loan') {
      // Loan exports, like card exports, often print balance changes (payment negative, interest
      // positive) instead of account flow, so they get the same explicit-or-inferred treatment.
      let chargesPositive;
      if (typeof map.chargesPositive === 'boolean') {
        chargesPositive = map.chargesPositive;
        signConvention = chargesPositive ? 'Charges positive (set in mapping): signs flipped to account flow' : 'Charges negative (set in mapping): kept as account flow';
      } else if (raw.length) {
        const inferred = inferCardSign(raw, fileName, account.type === 'loan' ? 'loan' : 'card');
        chargesPositive = inferred.chargesPositive;
        warnings.push(inferred.warning);
        signConvention = chargesPositive ? 'Charges positive (inferred): signs flipped to account flow' : 'Charges negative (inferred): kept as account flow';
      } else {
        chargesPositive = false;
        signConvention = 'No rows';
      }
      if (chargesPositive) for (const x of raw) x.amount = -x.amount;
    } else {
      signConvention = 'Signed amounts as exported (money out negative)';
      if (raw.length > 1 && raw.every(x => x.amount > 0)) {
        const debitType = /debit|withdraw|\bdr\b/i, creditType = /credit|deposit|\bcr\b/i;
        if (has('type') && raw.some(x => debitType.test(x.type))) {
          let unknown = 0;
          for (const x of raw) {
            if (debitType.test(x.type)) x.amount = -x.amount;
            else if (!creditType.test(x.type)) unknown++;
          }
          signConvention = 'Unsigned amounts: direction taken from the "' + map.type + '" column';
          warnings.push('"' + fileName + '": every amount is positive, so the direction was taken from the "' + map.type + '" column' +
            (unknown ? ' (' + unknown + ' rows with an unrecognised type were kept as money in — check them)' : '') + '.');
        } else if (account.type === 'checking' || account.type === 'other') {
          // A savings export with only deposits and interest is normal; a checking one is not.
          warnings.push('"' + fileName + '": every amount is positive. If this export lists withdrawals as positive numbers, map its Debit/Credit columns instead.');
        }
      }
    }

    const txns = raw.map(x => ({
      id: 'row-' + E.util.hash(fileName + '|' + x.row),
      accountId: account.id,
      date: x.date,
      description: x.description,
      merchant: cleanMerchant(x.description),
      amountCents: x.amount,
      kind: null,
      subtype: null,
      category: null,
      sourceCategory: x.category,
      categoryReason: '',
      confidence: null,
      flags: [],
      pairId: null,
      matchIds: [],
      sourceFile: fileName,
      sourceRow: x.row,
      note: x.transactionDate && x.transactionDate !== x.date ? 'Transaction date ' + x.transactionDate + '.' : ''
    }));
    let start = null, end = null;
    for (const t of txns) {
      if (start === null || t.date < start) start = t.date;
      if (end === null || t.date > end) end = t.date;
    }
    return { txns, skipped, mapping: map, start, end, rows, headerRow: index >= 0 ? records[index].line : null, signConvention, warnings };
  }

  // ------------------------------------------------------------------ de-duplication & ids

  function dedupeKey(t) {
    return t.accountId + '|' + t.date + '|' + t.amountCents + '|' + norm(t.description);
  }

  /**
   * Multiset de-duplication across overlapping exports of the same account. For each key
   * (account, date, amount, normalized description) keep max(count in any single file) rows —
   * all taken from one file (the first with that count) — and remove the rest. Rows are never
   * removed against other rows of their own file: genuine same-day repeats survive.
   * @returns {{kept: object[], removed: object[]}}
   */
  function dedupe(txns) {
    const fileOrder = new Map();
    const groups = new Map();
    txns.forEach((t, i) => {
      const file = t.sourceFile ?? '';
      if (!fileOrder.has(file)) fileOrder.set(file, fileOrder.size);
      const key = dedupeKey(t);
      if (!groups.has(key)) groups.set(key, new Map());
      const byFile = groups.get(key);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(i);
    });
    const removedIdx = new Map(); // index -> kept counterpart index
    for (const byFile of groups.values()) {
      if (byFile.size < 2) continue;
      let keepFile = null;
      for (const [file, list] of byFile) {
        if (keepFile === null || list.length > byFile.get(keepFile).length ||
          (list.length === byFile.get(keepFile).length && fileOrder.get(file) < fileOrder.get(keepFile))) keepFile = file;
      }
      const keptList = byFile.get(keepFile);
      for (const [file, list] of byFile) {
        if (file === keepFile) continue;
        list.forEach((idx, k) => removedIdx.set(idx, keptList[k % keptList.length]));
      }
    }
    const kept = [], removed = [];
    txns.forEach((t, i) => {
      if (!removedIdx.has(i)) { kept.push(t); return; }
      const twin = txns[removedIdx.get(i)];
      removed.push({ file: t.sourceFile ?? null, row: t.sourceRow ?? null, accountId: t.accountId, date: t.date, amountCents: t.amountCents, description: t.description, keptFile: twin.sourceFile ?? null, keptRow: twin.sourceRow ?? null });
    });
    return { kept, removed };
  }

  /**
   * Final ids: 'tx-' + hash(accountId|date|amount|normalizedDescription|occurrenceIndex). After
   * dedupe, identical rows all come from one file, so ids stay stable when overlapping exports
   * are re-imported.
   */
  function assignIds(txns) {
    const seen = new Map();
    const used = new Set();
    return txns.map(t => {
      const key = dedupeKey(t);
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      let id = 'tx-' + E.util.hash(key + '|' + n);
      for (let k = 2; used.has(id); k++) id = 'tx-' + E.util.hash(key + '|' + n + '|' + k); // hash collision guard
      used.add(id);
      return { ...t, id };
    });
  }

  // ------------------------------------------------------------------ rules

  const MIXED_RETAIL_REASON = 'Rule: mixed-retail chain — contents not inferred from merchant name';
  const mixed = (match, merchant) => ({ match, merchant, category: 'Mixed retail', flags: ['mixed_retail'], confidence: 'medium', reason: MIXED_RETAIL_REASON });

  /**
   * Generic, national patterns only. Household-specific names (utilities, local shops, employers)
   * belong in private/rules.json. Order matters: specific rules come before broad ones.
   */
  const DEFAULT_RULES = {
    categoryMap: {
      'Groceries': 'Groceries', 'Supermarkets': 'Groceries',
      'Food & Drink': 'Dining & takeout', 'Restaurants': 'Dining & takeout', 'Dining': 'Dining & takeout', 'Fast Food': 'Dining & takeout', 'Coffee Shops': 'Dining & takeout',
      'Gas': 'Fuel', 'Gasoline': 'Fuel', 'Gas Stations': 'Fuel', 'Fuel': 'Fuel',
      'Travel': 'Travel', 'Airfare': 'Travel', 'Airlines': 'Travel', 'Lodging': 'Travel', 'Hotels': 'Travel',
      'Health & Wellness': 'Medical & pharmacy', 'Health': 'Medical & pharmacy', 'Medical': 'Medical & pharmacy', 'Healthcare': 'Medical & pharmacy', 'Pharmacy': 'Medical & pharmacy',
      'Dentist': 'Dental',
      'Home': 'Household & hardware', 'Home Improvement': 'Household & hardware',
      'Automotive': 'Auto maintenance', 'Auto Service': 'Auto maintenance',
      'Entertainment': 'Entertainment',
      'Personal': 'Personal care', 'Personal Care': 'Personal care',
      'Education': 'Education',
      'Pets': 'Pets', 'Pet Care': 'Pets',
      'Gifts & Donations': 'Gifts & donations', 'Charity': 'Gifts & donations', 'Donations': 'Gifts & donations',
      'Fees & Adjustments': 'Fees & interest', 'Fees': 'Fees & interest', 'Bank Fees': 'Fees & interest',
      'Clothing': 'Clothing', 'Electronics': 'Electronics',
      'Childcare': 'Baby & childcare',
      'Insurance': 'Other insurance',
      'Subscriptions': 'Subscriptions',
      'Parking': 'Parking & tolls', 'Tolls': 'Parking & tolls',
      'Public Transportation': 'Rideshare & transit', 'Rideshare': 'Rideshare & transit', 'Taxi': 'Rideshare & transit',
      // Too broad to pick a household category: flagged for review unless a merchant rule matched first.
      'Shopping': UNCATEGORIZED, 'Merchandise': UNCATEGORIZED, 'General Merchandise': UNCATEGORIZED,
      'Bills & Utilities': UNCATEGORIZED, 'Utilities': UNCATEGORIZED, 'Services': UNCATEGORIZED,
      'Professional Services': UNCATEGORIZED, 'Other': UNCATEGORIZED, 'Miscellaneous': UNCATEGORIZED,
      'General': UNCATEGORIZED, 'Other Expenses': UNCATEGORIZED, 'Uncategorized': UNCATEGORIZED
    },
    merchantRules: [
      // --- payments, income and transfers (decide the kind before any merchant category)
      { match: 'PAYMENT|THANK YOU|AUTOPAY|AUTO PAY|AUTOMATIC PAYMENT', accountType: 'credit_card', sign: 'in', kind: 'card_payment', category: 'Card payment', confidence: 'high',
        reason: 'Rule: payment received on the card — moves money; the card purchases are the spending' },
      // Money arriving on a loan account pays the loan down. The paying side (checking) is the
      // debt payment; counting this side too, or as a refund, would double count it.
      { match: 'PAYMENT|PYMT|PMT|THANK YOU|AUTOPAY|AUTO PAY', accountType: 'loan', sign: 'in', kind: 'transfer', subtype: 'internal', category: 'Transfer', confidence: 'high',
        reason: 'Rule: payment received on the loan account — moves money; the paying side counts as the debt payment' },
      { match: 'CARD PAYMENT|CARD PMT|CRD PMT|CREDIT CRD|CREDIT CARD|CARD AUTOPAY|CRD AUTOPAY|CARD AUTO PAY|CARD EPAY|CRD EPAY|PAYMENT TO .*CARD|AUTOPAY.*CARD', accountType: CASH_SIDE, sign: 'out',
        kind: 'card_payment', category: 'Card payment', confidence: 'high', reason: 'Rule: credit card payment — excluded from spending (the card purchases are the spending)' },
      { match: 'PAYROLL|PAYRLL|DIR DEP|DIRECT DEP|SALARY', accountType: CASH_SIDE, sign: 'in', kind: 'income', subtype: 'payroll', category: 'Income', confidence: 'high',
        reason: 'Rule: payroll deposit pattern' },
      { match: 'INTEREST PAID|INTEREST EARNED|INTEREST PAYMENT|INTEREST CREDIT|INT EARNED|\\bDIVIDEND', accountType: CASH_SIDE, sign: 'in', kind: 'income', subtype: 'interest', category: 'Income', confidence: 'high',
        reason: 'Rule: interest or dividend paid by the bank' },
      { match: 'ZELLE|VENMO|PAYPAL|CASH APP|SQUARE CASH|\\bSQC\\*', sign: 'out', category: UNCATEGORIZED, flags: ['needs_category_review'], confidence: 'low',
        reason: 'Person-to-person payment: purpose unknown' },
      { match: 'ZELLE|VENMO|PAYPAL|CASH APP|SQUARE CASH|\\bSQC\\*', accountType: CASH_SIDE, sign: 'in', kind: 'income', subtype: 'other', category: 'Income', flags: ['needs_category_review'], confidence: 'low',
        reason: 'Person-to-person payment received: purpose unknown (not assumed to be pay)' },
      { match: 'TRANSFER (TO|FROM) .*SAV|XFER (TO|FROM) .*SAV', kind: 'transfer', subtype: 'savings', category: 'Transfer', confidence: 'high',
        reason: 'Rule: transfer to or from savings' },
      { match: 'TRANSFER|XFER', accountType: 'savings', kind: 'transfer', subtype: 'savings', category: 'Transfer', confidence: 'high',
        reason: 'Rule: transfer on the savings account' },
      { match: 'ONLINE TRANSFER|ONLINE XFER|INTERNAL TRANSFER|MOBILE TRANSFER|TRANSFER FROM|TRANSFER TO|XFER FROM|XFER TO', kind: 'transfer', subtype: 'internal', category: 'Transfer', confidence: 'medium',
        reason: 'Rule: transfer between accounts — not income or spending' },
      // --- fees, housing and debt
      { match: 'INTEREST CHARGE|PURCHASE INTEREST|FINANCE CHARGE', sign: 'out', category: 'Fees & interest', flags: ['fee'], reason: 'Rule: interest charged' },
      { match: 'ANNUAL MEMBERSHIP FEE|ANNUAL FEE|LATE FEE|LATE PAYMENT FEE|OVERDRAFT (FEE|CHARGE|ITEM)|\\bNSF\\b|SERVICE FEE|SERVICE CHARGE|MAINTENANCE FEE|MONTHLY FEE|FOREIGN TRANSACTION FEE|FOREIGN TRANS FEE|ATM FEE|WIRE FEE|RETURNED ITEM',
        category: 'Fees & interest', flags: ['fee'], reason: 'Rule: bank or card fee' },
      { match: 'MORTGAGE|\\bMTG (PMT|PYMT|PAYMENT)', sign: 'out', category: 'Mortgage', reason: 'Rule: mortgage payment — housing spending (escrow split unknown)' },
      { match: 'AUTO LOAN|AUTO LN|AUTO PMT|CAR LOAN|VEHICLE LOAN|STUDENT LN|STUDENT LOAN|NELNET|NAVIENT|MOHELA|AIDVANTAGE|EDFINANCIAL|DEPT EDUCATION|DEPT OF ED', sign: 'out',
        kind: 'debt_payment', subtype: 'loan', category: 'Debt payment', confidence: 'medium', reason: 'Rule: loan servicer payment — a debt payment, not category spending' },
      { match: '\\bATM\\b|CASH WITHDRAWAL|CASH WDRL|CASH ADVANCE', sign: 'out', category: 'Cash withdrawals', flags: ['needs_category_review'], confidence: 'low',
        reason: 'Rule: cash withdrawal — what the cash paid for is unknown' },
      // --- specific merchants before the broad chains they belong to
      { match: 'COSTCO GAS|COSTCO FUEL', merchant: 'Costco Gas', category: 'Fuel', reason: 'Rule: Costco fuel station (not the warehouse)' },
      { match: 'AMAZON PRIME|AMZN PRIME|PRIME MEMBERSHIP|PRIME VIDEO', merchant: 'Amazon Prime', category: 'Subscriptions', reason: 'Rule: Amazon Prime membership' },
      { match: 'WALMART\\+|WALMART PLUS|WMT PLUS', merchant: 'Walmart+', category: 'Subscriptions', reason: 'Rule: Walmart+ membership' },
      { match: 'DENTAL|DENTIST|\\bDDS\\b|\\bDMD\\b|ORTHODONT|ENDODONT|PERIODONT|ORAL SURG', category: 'Dental', reason: 'Rule: dental provider' },
      { match: 'OPTOMETR|OPTICAL|EYE CARE|EYECARE|\\bVISION\\b|OPHTHALM|WARBY PARKER|LENSCRAFTERS', category: 'Vision', reason: 'Rule: eye care provider' },
      { match: 'CHEWY|PETSMART|PETCO|BANFIELD|VETERINAR|\\bVET\\b|ANIMAL HOSP', category: 'Pets', reason: 'Rule: pet store or veterinarian' },
      { match: 'PHARMACY|\\bCVS\\b|WALGREENS|RITE AID|URGENT CARE|HOSPITAL|CLINIC|MEDICAL|PEDIATRIC|PHYSICIAN|LABCORP|QUEST DIAG', category: 'Medical & pharmacy', confidence: 'medium',
        reason: 'Rule: pharmacy or medical provider (drugstores also sell everyday goods)' },
      mixed('\\bAMAZON|\\bAMZN', 'Amazon'),
      mixed('COSTCO', 'Costco'),
      mixed('\\bTARGET\\b', 'Target'),
      mixed('WAL-?MART|WM SUPERCENTER', 'Walmart'),
      mixed('SAMS ?CLUB|SAM\'S CLUB', 'Sam\'s Club'),
      mixed('BJ\'?S WHOLESALE', 'BJ\'s Wholesale'),
      { match: 'AIRLINE|AIRWAYS|AIR LINES|DELTA AIR|UNITED AIRL|AMERICAN AIR|SOUTHWEST AIR|JETBLUE|ALASKA AIR|SPIRIT AIRL|FRONTIER AIRL|MARRIOTT|HILTON|HYATT|HOLIDAY INN|HAMPTON INN|BEST WESTERN|AIRBNB|VRBO|EXPEDIA|BOOKING\\.COM|HOTELS\\.COM|\\bHOTEL\\b|\\bMOTEL\\b',
        category: 'Travel', reason: 'Rule: airline or lodging' },
      { match: '\\bSHELL\\b|EXXON|\\bMOBIL\\b|CHEVRON|\\bBP\\b|SUNOCO|CITGO|MARATHON PETRO|SPEEDWAY|CIRCLE K|VALERO|PHILLIPS 66|CONOCO|\\bARCO\\b|LOVE\'?S TRAVEL|PILOT TRAVEL|FLYING J|\\bFUEL\\b|GASOLINE',
        category: 'Fuel', reason: 'Rule: fuel station' },
      { match: 'KROGER|\\bALDI\\b|\\bLIDL\\b|WHOLE FOODS|WHOLEFDS|TRADER JOE|SAFEWAY|ALBERTSONS|SPROUTS|INSTACART|GROCERY|SUPERMARKET', category: 'Groceries', reason: 'Rule: grocery store' },
      { match: 'RESTAURANT|PIZZA|\\bCAFE\\b|COFFEE|STARBUCKS|DUNKIN|MCDONALD|CHIPOTLE|PANERA|SUBWAY|TACO BELL|WENDY\'?S|BURGER KING|CHICK-FIL-A|DOMINO|PAPA JOHN|DOORDASH|GRUBHUB|UBER\\s*\\*?\\s*EATS|POSTMATES|DAIRY QUEEN|OLIVE GARDEN|APPLEBEE|PANDA EXPRESS|FIVE GUYS|\\bKFC\\b|POPEYES|BAKERY|\\bDINER\\b',
        category: 'Dining & takeout', reason: 'Rule: restaurant or food delivery' },
      { match: '\\bUBER\\b|\\bLYFT\\b', category: 'Rideshare & transit', reason: 'Rule: rideshare' },
      { match: 'HOME DEPOT|\\bLOWE\'?S\\b|ACE HARDWARE|HARBOR FREIGHT|TRUE VALUE', category: 'Household & hardware', reason: 'Rule: hardware store' },
      { match: 'NETFLIX|SPOTIFY|HULU|DISNEY ?PLUS|DISNEY\\+|HBO ?MAX|PARAMOUNT\\+|PARAMOUNT PLUS|PEACOCK|YOUTUBE ?PREMIUM|YOUTUBE ?TV|APPLE\\.COM/BILL|AUDIBLE|SIRIUSXM|PATREON|\\bICLOUD',
        category: 'Subscriptions', reason: 'Rule: streaming or subscription service' },
      { match: 'VERIZON|\\bAT&T\\b|\\bATT\\b|T-MOBILE|TMOBILE|COMCAST|XFINITY|SPECTRUM|GOOGLE FI|MINT MOBILE', category: 'Internet & phone', reason: 'Rule: phone or internet provider' },
      { match: 'GEICO|STATE FARM|PROGRESSIVE|ALLSTATE|LIBERTY MUTUAL|NATIONWIDE|FARMERS INS|TRAVELERS INS|\\bINSURANCE\\b|\\bINS PREM', category: 'Other insurance', confidence: 'medium',
        reason: 'Rule: insurer — policy type unknown' },
      { match: 'CHILDCARE|CHILD CARE|DAYCARE|DAY CARE|KINDERCARE|BRIGHT HORIZONS|PRESCHOOL|BABYSIT|NANNY', category: 'Baby & childcare', reason: 'Rule: childcare provider' },
      // --- weak card-payment wording last, so a named biller above wins
      { match: 'AUTOPAY|AUTO PAY|EPAY|E-PAYMENT|EPAYMENT', accountType: CASH_SIDE, sign: 'out', kind: 'card_payment', category: 'Card payment', confidence: 'medium',
        reason: 'Rule: looks like an automatic card payment — confirm it pays a card' }
    ],
    transferHints: []
  };
  deepFreeze(DEFAULT_RULES);

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  }

  function compileRule(r, label) {
    if (!isObj(r) || typeof r.match !== 'string' || !r.match) throw fail(label + ' needs a "match" pattern.');
    let re;
    try { re = new RegExp(r.match, 'i'); } catch (err) { throw fail(label + ' ("' + r.match + '") is not a valid pattern: ' + err.message); }
    const field = r.field || 'description';
    if (!RULE_FIELDS.includes(field)) throw fail(label + ': field must be one of ' + RULE_FIELDS.join(', ') + '.');
    if (r.kind !== undefined && !KINDS.includes(r.kind)) throw fail(label + ': kind "' + r.kind + '" is not one of ' + KINDS.join(', ') + '.');
    if (r.confidence !== undefined && !CONFIDENCE.includes(r.confidence)) throw fail(label + ': confidence must be high, medium or low.');
    if (r.sign !== undefined && r.sign !== 'in' && r.sign !== 'out') throw fail(label + ': sign must be "in" or "out".');
    if (r.flags !== undefined && (!Array.isArray(r.flags) || r.flags.some(f => typeof f !== 'string'))) throw fail(label + ': flags must be a list of text labels.');
    const types = r.accountType === undefined ? null : [].concat(r.accountType);
    if (types && types.some(t => !ACCOUNT_TYPES.includes(t))) throw fail(label + ': accountType must be one of ' + ACCOUNT_TYPES.join(', ') + '.');
    return {
      re, field, accountTypes: types, sign: r.sign || null,
      kind: r.kind || null, subtype: r.subtype || null, category: r.category || null, merchant: r.merchant || null,
      flags: r.flags ? r.flags.slice() : [], confidence: r.confidence || null, personId: r.personId || null,
      reason: r.reason || 'Rule matched "' + r.match + '"'
    };
  }

  /** User rules first, then transfer hints, then DEFAULT_RULES; user categoryMap overrides defaults. */
  function prepareRules(rules) {
    const user = isObj(rules) ? rules : {};
    if (user.merchantRules !== undefined && !Array.isArray(user.merchantRules)) throw fail('rules.merchantRules must be a list.');
    if (user.transferHints !== undefined && !Array.isArray(user.transferHints)) throw fail('rules.transferHints must be a list.');
    if (user.categoryMap !== undefined && !isObj(user.categoryMap)) throw fail('rules.categoryMap must be an object.');
    const list = [];
    (user.merchantRules || []).forEach((r, i) => list.push(compileRule(r, 'Rule ' + (i + 1))));
    (user.transferHints || []).forEach((h, i) => {
      const label = 'Transfer hint ' + (i + 1);
      if (!isObj(h) || !HINT_SUBTYPES.includes(h.subtype)) throw fail(label + ': subtype must be one of ' + HINT_SUBTYPES.join(', ') + '.');
      if (h.personId !== undefined && h.personId !== null && h.personId !== 'p1' && h.personId !== 'p2') throw fail(label + ': personId must be p1 or p2.');
      list.push(compileRule({
        match: h.match, accountType: h.accountType, sign: h.sign, kind: 'transfer', subtype: h.subtype, category: 'Transfer', personId: h.personId || null,
        confidence: 'high', reason: h.reason || 'Transfer hint: ' + h.subtype + (h.personId ? ' from ' + h.personId : '')
      }, label));
    });
    DEFAULT_RULES.merchantRules.forEach((r, i) => list.push(compileRule(r, 'Default rule ' + (i + 1))));
    const categoryMap = new Map();
    for (const [k, v] of Object.entries(DEFAULT_RULES.categoryMap)) categoryMap.set(k.trim().toLowerCase(), v);
    for (const [k, v] of Object.entries(user.categoryMap || {})) {
      if (typeof v !== 'string' || !v.trim()) throw fail('categoryMap["' + k + '"] must be a category name.');
      categoryMap.set(k.trim().toLowerCase(), v.trim());
    }
    return { rules: list, categoryMap };
  }

  function bankCategory(src, categoryMap) {
    if (!src) return null;
    const key = String(src).trim().toLowerCase();
    let mapped = categoryMap.get(key);
    if (!mapped && E.categories) mapped = E.categories.names().find(n => n.toLowerCase() === key) || null;
    if (!mapped) return { category: null, reason: 'Bank category "' + src + '" has no household mapping' };
    if (mapped === UNCATEGORIZED) return { category: UNCATEGORIZED, reason: 'Bank category "' + src + '" is too broad to choose a household category' };
    return { category: mapped, reason: 'Bank category "' + src + '"' };
  }

  function classifyOne(t, prepared, accountType) {
    const flow = t.amountCents;
    const sign = flow < 0 ? 'out' : 'in';
    const cleaned = cleanMerchant(t.description);
    const values = { description: t.description || '', merchant: cleaned, sourceCategory: t.sourceCategory || '' };
    const st = { kind: null, implied: null, subtype: null, category: null, merchant: null, confidence: null, personId: null };
    const flags = [];
    const reasons = [];      // rules that decided kind / subtype / category
    const extraReasons = []; // rules that only added flags or a display name

    for (const r of prepared.rules) {
      if (r.accountTypes && !r.accountTypes.includes(accountType)) continue;
      if (r.sign && r.sign !== sign) continue;
      if (!r.re.test(values[r.field])) continue;
      // A rule that implies a different reading than an earlier (higher-priority) rule is ignored
      // entirely, so e.g. the generic Amazon rule cannot add mixed_retail to an Amazon Prime fee.
      const implied = r.kind || (r.category ? 'spend' : null);
      if (implied && st.implied && implied !== st.implied) continue;
      if (r.category && st.category && r.category !== st.category) continue;
      if (r.subtype && st.subtype && r.subtype !== st.subtype) continue;
      let decided = false, added = false;
      if (implied && !st.implied) st.implied = implied;
      if (r.kind && !st.kind) { st.kind = r.kind; decided = true; }
      if (r.subtype && !st.subtype) { st.subtype = r.subtype; decided = true; }
      if (r.category && !st.category) { st.category = r.category; decided = true; }
      if (decided && r.confidence && !st.confidence) st.confidence = r.confidence;
      if (r.merchant && !st.merchant) { st.merchant = r.merchant; added = true; }
      if (r.personId && !st.personId) st.personId = r.personId;
      for (const f of r.flags) if (!flags.includes(f)) { flags.push(f); added = true; }
      if (decided) { if (!reasons.includes(r.reason)) reasons.push(r.reason); } else if (added && !extraReasons.includes(r.reason)) extraReasons.push(r.reason);
    }

    let kind = st.kind, subtype = st.subtype, category = st.category, confidence = st.confidence;
    const after = [];
    const flag = f => { if (!flags.includes(f)) flags.push(f); };
    const cardLike = accountType === 'credit_card' || accountType === 'loan';
    if (!kind) {
      if (accountType === 'loan' && flow > 0 && st.implied !== 'spend') {
        // A credit on a loan account is almost always money paid toward it. Treating it as a
        // refund would cancel real spending; as income it would be counted twice. Neutral + review.
        kind = 'transfer'; subtype = subtype || 'internal'; confidence = 'low';
        flag('needs_category_review');
        after.push('Credit on a loan account with no matching rule: treated as money paid toward the loan (not spending or income) — confirm');
      } else if (st.implied === 'spend' || flow < 0 || cardLike) kind = 'spend';
      else {
        // Never payroll without a payroll pattern: an unexplained deposit is 'other' income to review.
        kind = 'income'; subtype = 'other'; confidence = 'low';
        flag('needs_category_review');
        after.push('Deposit with no matching rule: purpose unknown (not assumed to be pay)');
      }
    }
    if (kind === 'spend') {
      subtype = null;
      if (flow > 0) {
        flag('refund');
        after.push(cardLike ? 'Credit on a ' + (accountType === 'loan' ? 'loan' : 'card') + ' account without a payment pattern: treated as a refund that reduces spending'
          : 'Credit from a merchant: treated as a refund that reduces spending');
      }
      if (!category) {
        const bank = bankCategory(t.sourceCategory, prepared.categoryMap);
        if (bank && bank.category && bank.category !== UNCATEGORIZED) {
          category = bank.category; confidence = confidence || 'medium'; reasons.push(bank.reason);
        } else {
          category = UNCATEGORIZED;
          reasons.push(bank ? bank.reason : 'No rule or bank category matched');
        }
      }
      if (category === UNCATEGORIZED) { flag('needs_category_review'); confidence = 'low'; }
    } else if (kind === 'income') {
      subtype = subtype || 'other';
      category = category || KIND_CATEGORY.income;
    } else {
      category = category || KIND_CATEGORY[kind];
      if (kind === 'transfer') subtype = subtype || 'internal';
      else if (kind === 'debt_payment') subtype = subtype || 'other';
      else subtype = null;
    }

    const out = {
      ...t,
      merchant: st.merchant || cleaned,
      kind, subtype, category,
      sourceCategory: t.sourceCategory ?? null,
      categoryReason: [...reasons, ...after, ...extraReasons].join('; '),
      confidence: confidence || 'high',
      flags,
      pairId: t.pairId ?? null,
      matchIds: (t.matchIds || []).slice(),
      note: t.note || ''
    };
    if (st.personId) out.personId = st.personId; else delete out.personId;
    return out;
  }

  /**
   * Assign kind/subtype/category/merchant/flags from rules. Precedence: user merchantRules, then
   * transferHints, then DEFAULT_RULES (first match wins per field, flags are unioned), then the
   * bank's categoryMap, then plain-language fallbacks. sourceCategory is never modified.
   * @returns {object[]} new transaction objects
   */
  function classify(txns, rules, accounts) {
    const prepared = prepareRules(rules);
    const typeById = new Map((accounts || []).map(a => [a.id, a.type]));
    return (txns || []).map(t => classifyOne(t, prepared, typeById.get(t.accountId) || 'other'));
  }

  // ------------------------------------------------------------------ coverage

  /** Merge overlapping or adjacent inclusive date ranges. Invalid ranges are dropped. */
  function mergeRanges(ranges) {
    const valid = (ranges || []).filter(r => r && E.dates.isDate(r.start) && E.dates.isDate(r.end) && r.start <= r.end)
      .map(r => ({ start: r.start, end: r.end }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
    const out = [];
    for (const r of valid) {
      const last = out[out.length - 1];
      if (last && r.start <= E.dates.addDays(last.end, 1)) { if (r.end > last.end) last.end = r.end; } else out.push(r);
    }
    return out;
  }

  /** Coverage ranges per account: declared coverage, or the account's transaction date span. */
  function coverageIndex(accounts, txns) {
    const span = new Map();
    for (const t of txns) {
      const s = span.get(t.accountId);
      if (!s) span.set(t.accountId, { start: t.date, end: t.date });
      else { if (t.date < s.start) s.start = t.date; if (t.date > s.end) s.end = t.date; }
    }
    const out = new Map();
    for (const a of accounts) {
      const ranges = Array.isArray(a.coverage) && a.coverage.length ? a.coverage : (span.has(a.id) ? [span.get(a.id)] : []);
      out.set(a.id, ranges);
    }
    return out;
  }
  const covers = (ranges, date) => (ranges || []).some(r => r.start <= date && date <= r.end);

  // ------------------------------------------------------------------ transfer pairing

  /**
   * Pair opposite flows of equal size between two different household accounts within `days`.
   * Candidates: transfers and card payments (plus an unexplained inbound 'other' deposit that
   * matches an outbound transfer, which is upgraded to a transfer). A debt payment from a cash
   * account also pairs with the money arriving on a card or loan account in the data: on a card it
   * becomes a card payment (the card's purchases are the spending); on a loan the cash side is the
   * debt payment and the loan side a neutral transfer, so the payment is counted once. Greedy
   * closest-date matching with a deterministic tie-break. Unmatched internal-looking rows get the
   * unpaired_transfer flag.
   * @returns {object[]} new transaction objects (input order kept)
   */
  function pairTransfers(txns, accounts, { days = 5 } = {}) {
    const acct = new Map((accounts || []).map(a => [a.id, a]));
    const out = (txns || []).map(copyTxn);
    const typeOf = t => (acct.get(t.accountId) || {}).type || 'other';
    const labelOf = id => (acct.get(id) || {}).label || id;
    const movable = t => t.kind === 'transfer' || t.kind === 'card_payment';
    // Only an unexplained deposit (fallback or person-to-person, still awaiting review) may turn
    // into a transfer; income a user rule classified on purpose is left alone.
    const unexplained = t => t.kind === 'income' && t.subtype === 'other' && t.flags.includes('needs_category_review');

    const inbound = new Map();
    out.forEach((t, i) => {
      if (t.pairId || !acct.has(t.accountId) || t.amountCents <= 0) return;
      if (movable(t) || unexplained(t)) {
        if (!inbound.has(t.amountCents)) inbound.set(t.amountCents, []);
        inbound.get(t.amountCents).push(i);
      }
    });
    // A debt payment from a cash account can also be one side of a pair: when the card or loan it
    // pays is itself in the data, the money arrives there too and must not be counted twice.
    const debtSide = t => t.kind === 'debt_payment' && CASH_SIDE.includes(typeOf(t));
    const isDebtAccount = t => typeOf(t) === 'credit_card' || typeOf(t) === 'loan';
    const candidates = [];
    out.forEach((a, o) => {
      if (a.pairId || !acct.has(a.accountId) || a.amountCents >= 0 || !(movable(a) || debtSide(a))) return;
      for (const i of inbound.get(-a.amountCents) || []) {
        const b = out[i];
        if (b.accountId === a.accountId) continue;
        const gap = Math.abs(E.dates.daysBetween(a.date, b.date));
        if (gap > days) continue;
        if (b.kind === 'income' && a.kind !== 'transfer') continue;
        // A card payment only pairs with money arriving on a card account.
        if ((a.kind === 'card_payment' || b.kind === 'card_payment') && typeOf(b) !== 'credit_card') continue;
        // A debt payment only pairs with money arriving on a card or loan account.
        if (a.kind === 'debt_payment' && !isDebtAccount(b)) continue;
        // Money arriving on a loan comes from a transfer or a debt payment, never from another loan.
        if (typeOf(b) === 'loan' && (b.kind !== 'transfer' || typeOf(a) === 'loan')) continue;
        // Explicit transfer / card-payment wording pairs first; a debt-rule match next; an
        // unexplained deposit last (it is only upgraded when nothing better claims the money).
        candidates.push({ o, i, gap, priority: b.kind === 'income' ? 2 : a.kind === 'debt_payment' ? 1 : 0 });
      }
    });
    candidates.sort((x, y) => x.priority - y.priority || x.gap - y.gap ||
      byDateThenId(out[x.o], out[y.o]) || byDateThenId(out[x.i], out[y.i]));

    const used = new Set();
    for (const c of candidates) {
      if (used.has(c.o) || used.has(c.i)) continue;
      used.add(c.o); used.add(c.i);
      const a = out[c.o], b = out[c.i];
      a.pairId = b.id; b.pairId = a.id;
      for (const t of [a, b]) removeFlag(t, 'unpaired_transfer');
      if (typeOf(b) === 'credit_card') {
        // Money arriving on a card from a household account is a card payment, whatever its wording.
        // (A debt payment to a card whose purchases are in the data would count that money twice.)
        for (const t of [a, b]) {
          if (t.kind !== 'card_payment') {
            addReason(t, 'Matches a card payment between ' + labelOf(a.accountId) + ' and ' + labelOf(b.accountId) + ': treated as a card payment' +
              (t.kind === 'debt_payment' ? ', not a debt payment, because the card\'s purchases are in the data' : ''));
          }
          t.kind = 'card_payment'; t.subtype = null; t.category = KIND_CATEGORY.card_payment; t.confidence = 'high';
        }
        addReason(a, 'Paired with the payment received on ' + labelOf(b.accountId) + ' (' + b.date + ')');
        addReason(b, 'Paired with the payment from ' + labelOf(a.accountId) + ' (' + a.date + ')');
        continue;
      }
      if (typeOf(b) === 'loan') {
        // Paying a household loan: the cash side is the debt payment; the loan side only records
        // the money arriving (a neutral transfer), so the payment is counted once.
        if (a.kind !== 'debt_payment') {
          addReason(a, 'Matches the payment received on ' + labelOf(b.accountId) + ': treated as a debt payment');
          a.kind = 'debt_payment'; a.subtype = 'loan'; a.category = KIND_CATEGORY.debt_payment;
        }
        a.confidence = 'high'; b.confidence = 'high';
        b.kind = 'transfer'; b.subtype = b.subtype || 'internal'; b.category = KIND_CATEGORY.transfer;
        removeFlag(b, 'needs_category_review');
        addReason(a, 'Paired with the payment received on ' + labelOf(b.accountId) + ' (' + b.date + ')');
        addReason(b, 'Paired with the debt payment from ' + labelOf(a.accountId) + ' (' + a.date + '), which is where it counts');
        continue;
      }
      if (b.kind === 'income') {
        b.kind = 'transfer'; b.subtype = 'internal'; b.category = KIND_CATEGORY.transfer; b.confidence = 'medium';
        removeFlag(b, 'needs_category_review');
        addReason(b, 'Matches an outbound transfer of the same amount from ' + labelOf(a.accountId) + ' on ' + a.date + ': treated as a transfer, not income');
      } else {
        b.confidence = 'high';
      }
      a.confidence = 'high';
      // Money moved to or from a household savings account is saving on both sides of the pair.
      const special = s => s === 'contribution' || s === 'investment';
      if (!special(a.subtype) && !special(b.subtype) &&
        (typeOf(a) === 'savings' || typeOf(b) === 'savings' || a.subtype === 'savings' || b.subtype === 'savings')) {
        a.subtype = 'savings'; b.subtype = 'savings';
      }
      addReason(a, 'Paired with the transfer into ' + labelOf(b.accountId) + ' (' + b.date + ')');
      addReason(b, 'Paired with the transfer from ' + labelOf(a.accountId) + ' (' + a.date + ')');
    }

    const coverageById = coverageIndex(accounts || [], out);
    const cards = (accounts || []).filter(a => a.type === 'credit_card');
    for (const t of out) {
      if (t.pairId) continue;
      if (t.kind === 'card_payment') {
        addFlag(t, 'unpaired_transfer');
        if (t.amountCents < 0 && typeOf(t) !== 'credit_card') {
          const cardCovered = cards.some(c => covers(coverageById.get(c.id), t.date));
          addNote(t, cardCovered
            ? 'No matching payment on the card account(s) in the data within ' + days + ' days: confirm this pays a card and is not a bill. ' +
              'If it pays a card whose export is not in the data, that card\'s purchases (the spending) are missing.'
            : 'No card account in the data covers this date: the purchases this payment covers are not in the data, so that card\'s spending is missing (the payment itself is excluded).');
        } else {
          addNote(t, 'No matching payment found in the data within ' + days + ' days: paid from an account that is not in the data?');
        }
      } else if (t.kind === 'transfer' && t.subtype !== 'contribution' && t.subtype !== 'investment') {
        // Contributions come from a partner's personal account outside the data: expected unpaired.
        addFlag(t, 'unpaired_transfer');
        addNote(t, typeOf(t) === 'loan' && t.amountCents > 0
          ? 'Payment received on the loan with no matching payment from a household account in the data within ' + days + ' days: paid from an account that is not in the data?'
          : t.amountCents > 0
          ? 'No matching outbound transfer in the data within ' + days + ' days: confirm where this money came from.'
          : 'No matching inbound transfer in the data within ' + days + ' days: confirm where this money went.');
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ reimbursement candidates

  /**
   * Flag an inbound non-payroll, non-interest deposit (income 'other', or an unpaired inbound
   * internal transfer) whose amount equals an earlier spend charge of at least minCents within
   * `days`. Both rows get reimbursement_candidate and point at each other in matchIds. Nothing is
   * reclassified or excluded: the user confirms in Review. Card refunds are spend rows, never deposits,
   * and a charge already refunded on its own account is not offered as a candidate.
   * @returns {object[]} new transaction objects
   */
  function markReimbursementCandidates(txns, { days = 120, minCents = 2500, accounts } = {}) {
    const out = (txns || []).map(copyTxn);
    const cardIds = new Set((accounts || []).filter(a => a.type === 'credit_card' || a.type === 'loan').map(a => a.id));
    const deposits = out.filter(t => t.amountCents >= minCents && !cardIds.has(t.accountId) &&
      ((t.kind === 'income' && t.subtype === 'other') ||
       (t.kind === 'transfer' && !t.pairId && (t.subtype === 'internal' || !t.subtype))))
      .sort(byDateThenId);
    const charges = new Map();
    for (const t of out) {
      if (t.kind !== 'spend' || t.amountCents > -minCents) continue;
      if (!charges.has(-t.amountCents)) charges.set(-t.amountCents, []);
      charges.get(-t.amountCents).push(t);
    }
    // A charge already refunded on its own account (same amount and merchant, refund on or after
    // the charge) has nothing left to reimburse: offering it would let the user remove it twice.
    const matched = new Set();
    const sameMerchant = (x, y) => norm(x.merchant) === norm(y.merchant) || norm(x.description) === norm(y.description);
    const refunds = out.filter(t => t.kind === 'spend' && t.amountCents >= minCents).sort(byDateThenId);
    for (const r of refunds) {
      let best = null;
      for (const ch of charges.get(r.amountCents) || []) {
        if (matched.has(ch.id) || ch.accountId !== r.accountId || ch.date > r.date || E.dates.daysBetween(ch.date, r.date) > days || !sameMerchant(ch, r)) continue;
        if (!best || ch.date > best.date || (ch.date === best.date && ch.id < best.id)) best = ch;
      }
      if (best) matched.add(best.id);
    }
    for (const dep of deposits) {
      let best = null;
      for (const ch of charges.get(dep.amountCents) || []) {
        if (matched.has(ch.id) || ch.date > dep.date || E.dates.daysBetween(ch.date, dep.date) > days) continue;
        if (!best || ch.date > best.date || (ch.date === best.date && ch.id < best.id)) best = ch;
      }
      if (!best) continue;
      matched.add(best.id);
      addFlag(dep, 'reimbursement_candidate'); addFlag(best, 'reimbursement_candidate');
      if (!dep.matchIds.includes(best.id)) dep.matchIds.push(best.id);
      if (!best.matchIds.includes(dep.id)) best.matchIds.push(dep.id);
      addNote(dep, 'Equals the ' + money(dep.amountCents) + ' charge on ' + best.date + ' (' + best.merchant + '): possibly a reimbursement — confirm in Review.');
      addNote(best, 'A deposit of the same amount arrived on ' + dep.date + ': possibly reimbursed — confirm in Review.');
    }
    return out;
  }

  // ------------------------------------------------------------------ dataset

  function normalizeAccounts(accounts) {
    if (!Array.isArray(accounts) || !accounts.length) throw fail('At least one account is required.');
    const seen = new Set();
    return accounts.map((a, i) => {
      const label = 'Account #' + (i + 1);
      if (!isObj(a) || typeof a.id !== 'string' || !a.id.trim()) throw fail(label + ' needs an id.');
      if (seen.has(a.id)) throw fail('Duplicate account id "' + a.id + '".');
      seen.add(a.id);
      if (!ACCOUNT_TYPES.includes(a.type)) throw fail('Account "' + a.id + '": type must be one of ' + ACCOUNT_TYPES.join(', ') + '.');
      const scope = a.scope === undefined ? 'joint' : a.scope;
      if (scope !== 'joint' && scope !== 'personal') throw fail('Account "' + a.id + '": scope must be joint or personal.');
      const ownerId = a.ownerId === 'p1' || a.ownerId === 'p2' ? a.ownerId : null;
      return {
        id: a.id, label: typeof a.label === 'string' && a.label.trim() ? a.label : a.id, type: a.type, scope, ownerId,
        paidInFull: a.paidInFull === true, coverage: mergeRanges(Array.isArray(a.coverage) ? a.coverage : [])
      };
    });
  }

  function finalizeTxn(t) {
    const out = {
      id: t.id, accountId: t.accountId, date: t.date, description: t.description, merchant: t.merchant,
      amountCents: t.amountCents, kind: t.kind, subtype: t.subtype ?? null, category: t.category,
      sourceCategory: t.sourceCategory ?? null, categoryReason: t.categoryReason || '', confidence: t.confidence,
      flags: t.flags.slice(), pairId: t.pairId ?? null, matchIds: t.matchIds.slice(),
      sourceFile: t.sourceFile ?? null, sourceRow: t.sourceRow ?? null, note: t.note || ''
    };
    if (t.personId) out.personId = t.personId;
    return out;
  }

  function coveredDaysIn(ranges, month) {
    const first = E.months.start(month), last = E.months.end(month);
    let days = 0;
    for (const r of ranges || []) {
      const s = r.start > first ? r.start : first;
      const e = r.end < last ? r.end : last;
      if (s <= e) days += E.dates.daysBetween(s, e) + 1;
    }
    return days;
  }

  /**
   * Per-month import summary: covered days per account, spending coverage (checking, card and
   * other accounts expected from the earliest to the latest coverage among them — savings and
   * loans do not affect spending completeness) and raw totals by counting rule.
   */
  function monthlySummary(dataset) {
    const accounts = dataset.accounts || [];
    const txns = dataset.transactions || [];
    let first = null, last = null;
    const extend = (s, e) => { if (first === null || s < first) first = s; if (last === null || e > last) last = e; };
    for (const a of accounts) for (const r of a.coverage || []) extend(r.start, r.end);
    for (const t of txns) extend(t.date, t.date);
    if (first === null) return [];
    let spanStart = null, spanEnd = null;
    for (const a of accounts) {
      if (!SPENDING_ACCOUNT_TYPES.includes(a.type)) continue;
      for (const r of a.coverage || []) {
        if (spanStart === null || r.start < spanStart) spanStart = r.start;
        if (spanEnd === null || r.end > spanEnd) spanEnd = r.end;
      }
    }
    const typeById = new Map(accounts.map(a => [a.id, a.type]));
    const rows = E.months.range(E.months.of(first), E.months.of(last)).map(month => {
      const days = E.months.daysIn(month);
      const coverage = {};
      for (const a of accounts) coverage[a.id] = coveredDaysIn(a.coverage, month);
      const expected = spanStart !== null && month >= spanStart.slice(0, 7) && month <= spanEnd.slice(0, 7);
      const spendAccounts = accounts.filter(a => SPENDING_ACCOUNT_TYPES.includes(a.type));
      let spendingCoverage = 'none';
      if (expected && spendAccounts.some(a => coverage[a.id] > 0)) {
        spendingCoverage = spendAccounts.every(a => coverage[a.id] === days) ? 'full' : 'partial';
      }
      return { month, days, spendingCoverage, coverage, transactions: 0, purchasesCents: 0, refundsCents: 0, spendingCents: 0,
        incomeCents: 0, payrollCents: 0, contributionsCents: 0, debtPaymentsCents: 0, cardPaymentsCents: 0, transfersInCents: 0, transfersOutCents: 0 };
    });
    const byMonth = new Map(rows.map(r => [r.month, r]));
    for (const t of txns) {
      const r = byMonth.get(t.date.slice(0, 7));
      if (!r) continue;
      r.transactions += 1;
      const a = t.amountCents;
      if (t.kind === 'spend') {
        if (a < 0) r.purchasesCents -= a; else r.refundsCents += a;
        r.spendingCents -= a;
      } else if (t.kind === 'income') {
        r.incomeCents += a;
        if (t.subtype === 'payroll') r.payrollCents += a;
      } else if (t.kind === 'debt_payment') {
        r.debtPaymentsCents -= a;
      } else if (t.kind === 'card_payment') {
        if (a < 0 && typeById.get(t.accountId) !== 'credit_card') r.cardPaymentsCents -= a;
      } else if (t.kind === 'transfer') {
        if (t.subtype === 'contribution' && a > 0) r.contributionsCents += a;
        if (a > 0) r.transfersInCents += a; else r.transfersOutCents -= a;
      }
    }
    return rows;
  }

  function totalsByKind(txns) {
    const totals = {};
    for (const k of KINDS) totals[k] = { count: 0, inflowCents: 0, outflowCents: 0, netCents: 0 };
    for (const t of txns) {
      const s = totals[t.kind];
      if (!s) continue;
      s.count += 1;
      if (t.amountCents > 0) s.inflowCents += t.amountCents; else s.outflowCents -= t.amountCents;
      s.netCents += t.amountCents;
    }
    return totals;
  }

  /**
   * Run the whole pipeline over a set of exports.
   * @param {{files: {name, text, accountId, mapping?, coverageStart?, coverageEnd?}[], accounts: object[], rules?: object,
   *          datasetId: string, isSynthetic?: boolean, generatedAt: string, coverageOverrides?: object,
   *          references?: object[], notes?: string[], pairDays?: number, reimbursementDays?: number}} input
   * @returns {{dataset: object, report: object}}
   */
  function buildDataset(input) {
    const opts = input || {};
    if (typeof opts.datasetId !== 'string' || !opts.datasetId.trim()) throw fail('datasetId is required.');
    if (!E.dates.isDate(opts.generatedAt)) throw fail('generatedAt must be a YYYY-MM-DD date (the importer never reads the clock).');
    if (!Array.isArray(opts.files) || !opts.files.length) throw fail('At least one file is required.');
    const accounts = normalizeAccounts(opts.accounts);
    const accountById = new Map(accounts.map(a => [a.id, a]));
    const warnings = [];
    const names = new Set();

    const fileResults = opts.files.map((f, i) => {
      if (!isObj(f) || typeof f.name !== 'string' || !f.name) throw fail('File #' + (i + 1) + ' needs a name.');
      if (names.has(f.name)) throw fail('Two files are both named "' + f.name + '"; give each file a distinct name.');
      names.add(f.name);
      const account = accountById.get(f.accountId);
      if (!account) throw fail('File "' + f.name + '" refers to unknown account "' + f.accountId + '".');
      for (const key of ['coverageStart', 'coverageEnd']) {
        if (f[key] !== undefined && f[key] !== null && !E.dates.isDate(f[key])) throw fail('File "' + f.name + '": ' + key + ' must be a YYYY-MM-DD date.');
      }
      const res = normalizeFile({ name: f.name, text: f.text, account, mapping: f.mapping });
      warnings.push(...res.warnings);
      const coverageStart = f.coverageStart || res.start;
      const coverageEnd = f.coverageEnd || res.end;
      if (coverageStart && coverageEnd && coverageStart > coverageEnd) throw fail('File "' + f.name + '": coverageEnd is before coverageStart.');
      if (f.coverageStart || f.coverageEnd) {
        const outside = res.txns.filter(t => (coverageStart && t.date < coverageStart) || (coverageEnd && t.date > coverageEnd)).length;
        if (outside) warnings.push('"' + f.name + '": ' + outside + ' rows fall outside the declared coverage ' + coverageStart + ' – ' + coverageEnd + ' (imported anyway; check the dates).');
      }
      if (!res.txns.length) {
        warnings.push('"' + f.name + '": no transactions were read' + (res.skipped && res.skipped.length ? ' (' + res.skipped.length + ' rows skipped)' : '') +
          (coverageStart && coverageEnd ? '. Its declared dates still count as covered for ' + account.label + '.' : '. ' + account.label + ' has no dates covered by this file, so months may show as incomplete; enter the dates the export covers if it was a quiet period.'));
      }
      return { file: f, account, res, coverageStart, coverageEnd };
    });

    // Coverage: declared or observed ranges per account, merged when they overlap or touch.
    const rangesById = new Map(accounts.map(a => [a.id, a.coverage.slice()]));
    for (const fr of fileResults) {
      if (fr.coverageStart && fr.coverageEnd) rangesById.get(fr.account.id).push({ start: fr.coverageStart, end: fr.coverageEnd });
    }
    for (const a of accounts) {
      a.coverage = mergeRanges(rangesById.get(a.id));
      for (let k = 1; k < a.coverage.length; k++) {
        warnings.push(a.label + ': no export covers ' + E.dates.addDays(a.coverage[k - 1].end, 1) + ' – ' + E.dates.addDays(a.coverage[k].start, -1) + '.');
      }
    }

    const all = [].concat(...fileResults.map(fr => fr.res.txns));
    const { kept, removed } = dedupe(all);
    const classified = classify(assignIds(kept), opts.rules, accounts);
    const paired = pairTransfers(classified, accounts, { days: opts.pairDays ?? 5 });
    const marked = markReimbursementCandidates(paired, { days: opts.reimbursementDays ?? 120, accounts });
    const transactions = marked.sort(byDateThenId).map(finalizeTxn);

    const removedByFile = new Map();
    for (const r of removed) removedByFile.set(r.file, (removedByFile.get(r.file) || 0) + 1);
    const keptByFile = new Map();
    for (const t of transactions) keptByFile.set(t.sourceFile, (keptByFile.get(t.sourceFile) || 0) + 1);

    const fileReports = fileResults.map(fr => {
      const skippedReasons = {};
      for (const s of fr.res.skipped) {
        const key = s.reason.replace(/\s*".*$/, '');
        skippedReasons[key] = (skippedReasons[key] || 0) + 1;
      }
      return {
        name: fr.file.name, accountId: fr.account.id, profile: fr.res.mapping ? fr.res.mapping.profile || 'custom' : null,
        rows: fr.res.rows, imported: keptByFile.get(fr.file.name) || 0, skipped: fr.res.skipped.length, skippedReasons,
        duplicatesRemoved: removedByFile.get(fr.file.name) || 0, start: fr.res.start, end: fr.res.end,
        coverageStart: fr.coverageStart || null, coverageEnd: fr.coverageEnd || null, signConvention: fr.res.signConvention
      };
    });

    // Every unmatched card payment from a cash account points at card spending that may be missing.
    const unpairedPayments = transactions.filter(t => t.kind === 'card_payment' && !t.pairId && t.amountCents < 0 &&
      accountById.get(t.accountId).type !== 'credit_card');
    const unpairedNoCard = unpairedPayments.filter(t => /No card account in the data covers/.test(t.note));
    const unpairedOther = unpairedPayments.filter(t => !unpairedNoCard.includes(t));
    const total = list => money(-list.reduce((s, t) => s + t.amountCents, 0));
    if (unpairedNoCard.length) {
      warnings.push(unpairedNoCard.length + ' card payment(s) totalling ' + total(unpairedNoCard) +
        ' fall on dates no card export covers: those cards\' purchases are missing from spending for those months.');
    }
    if (unpairedOther.length) {
      warnings.push(unpairedOther.length + ' card payment(s) totalling ' + total(unpairedOther) +
        ' have no matching payment on a card account in the data: if they pay a card whose export is missing, that card\'s purchases are missing from spending; otherwise reclassify them (for example as a bill).');
    }

    const dataset = {
      schemaVersion: 2,
      datasetId: opts.datasetId,
      isSynthetic: opts.isSynthetic === true,
      generatedAt: opts.generatedAt,
      currency: 'USD',
      accounts,
      transactions,
      coverageOverrides: isObj(opts.coverageOverrides) ? E.util.clone(opts.coverageOverrides) : {},
      importLog: fileReports.map(f => ({
        file: f.name, accountId: f.accountId, profile: f.profile, rows: f.rows, imported: f.imported, skipped: f.skipped,
        duplicatesRemoved: f.duplicatesRemoved, start: f.start, end: f.end, coverageStart: f.coverageStart, coverageEnd: f.coverageEnd,
        signConvention: f.signConvention
      })),
      references: Array.isArray(opts.references) ? E.util.clone(opts.references) : [],
      notes: Array.isArray(opts.notes) ? opts.notes.slice() : []
    };

    const flagCounts = {};
    for (const t of transactions) for (const f of t.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
    const spend = transactions.filter(t => t.kind === 'spend');
    const purchasesCents = spend.reduce((s, t) => s + (t.amountCents < 0 ? -t.amountCents : 0), 0);
    const refundsCents = spend.reduce((s, t) => s + (t.amountCents > 0 ? t.amountCents : 0), 0);
    const report = {
      datasetId: dataset.datasetId,
      generatedAt: dataset.generatedAt,
      isSynthetic: dataset.isSynthetic,
      transactions: transactions.length,
      start: transactions.length ? transactions[0].date : null,
      end: transactions.length ? transactions[transactions.length - 1].date : null,
      files: fileReports,
      accounts: accounts.map(a => ({ id: a.id, label: a.label, type: a.type, coverage: a.coverage.map(r => ({ ...r })), transactions: transactions.filter(t => t.accountId === a.id).length })),
      totalsByKind: totalsByKind(transactions),
      spending: { purchasesCents, refundsCents, netCents: purchasesCents - refundsCents },
      flagCounts: Object.fromEntries(Object.keys(flagCounts).sort().map(k => [k, flagCounts[k]])),
      months: monthlySummary(dataset),
      duplicatesRemoved: removed,
      skippedRows: [].concat(...fileResults.map(fr => fr.res.skipped.map(s => ({ file: fr.file.name, row: s.row, reason: s.reason })))),
      warnings
    };
    return { dataset, report };
  }

  // ------------------------------------------------------------------ period breakdown

  function transferRows(list) {
    const m = new Map();
    for (const t of list) {
      const key = t.subtype || 'internal';
      const row = m.get(key) || { subtype: key, count: 0, inCents: 0, outCents: 0, unpaired: 0 };
      row.count += 1;
      if (t.amountCents > 0) row.inCents += t.amountCents; else row.outCents -= t.amountCents;
      if (!t.pairId) row.unpaired += 1;
      m.set(key, row);
    }
    return [...m.values()].sort((a, b) => (a.subtype < b.subtype ? -1 : 1));
  }

  /**
   * Raw (pre-edit) breakdown of one period, for reconciling against an external total:
   * spending by account / category / kind, refunds, excluded card payments, transfers,
   * debt payments and review candidates, plus account coverage of the period.
   */
  function periodBreakdown(dataset, start, end) {
    if (!E.dates.isDate(start) || !E.dates.isDate(end) || start > end) throw fail('Period must be two YYYY-MM-DD dates, start before end.');
    const accounts = dataset.accounts || [];
    const typeById = new Map(accounts.map(a => [a.id, a.type]));
    const txns = (dataset.transactions || []).filter(t => t.date >= start && t.date <= end);
    const sum = (list, fn) => list.reduce((s, t) => s + fn(t), 0);
    const spend = txns.filter(t => t.kind === 'spend');
    const spendCents = t => -t.amountCents;
    const tally = (list, keyFn) => {
      const m = new Map();
      for (const t of list) {
        const k = keyFn(t);
        const row = m.get(k) || { key: k, cents: 0, count: 0 };
        row.cents += spendCents(t); row.count += 1;
        m.set(k, row);
      }
      return [...m.values()].sort((a, b) => b.cents - a.cents || (a.key < b.key ? -1 : 1));
    };
    const flagged = flag => txns.filter(t => t.flags.includes(flag));
    const totalDays = E.dates.daysBetween(start, end) + 1;
    const coverage = accounts.map(a => {
      let days = 0;
      for (const r of a.coverage || []) {
        const s = r.start > start ? r.start : start, e = r.end < end ? r.end : end;
        if (s <= e) days += E.dates.daysBetween(s, e) + 1;
      }
      return { accountId: a.id, label: a.label, type: a.type, coveredDays: days, totalDays };
    });
    const kinds = new Map();
    for (const t of txns) {
      const k = t.kind + (t.subtype ? ':' + t.subtype : '');
      const row = kinds.get(k) || { kind: t.kind, subtype: t.subtype || null, count: 0, inflowCents: 0, outflowCents: 0 };
      row.count += 1;
      if (t.amountCents > 0) row.inflowCents += t.amountCents; else row.outflowCents -= t.amountCents;
      kinds.set(k, row);
    }
    const cardPayments = txns.filter(t => t.kind === 'card_payment');
    const reimb = flagged('reimbursement_candidate');
    return {
      start, end, transactions: txns.length,
      spending: { purchasesCents: sum(spend, t => (t.amountCents < 0 ? -t.amountCents : 0)), refundsCents: sum(spend, t => (t.amountCents > 0 ? t.amountCents : 0)), netCents: sum(spend, spendCents) },
      byAccount: tally(spend, t => t.accountId).map(r => ({ accountId: r.key, spendCents: r.cents, count: r.count })),
      byCategory: tally(spend, t => t.category).map(r => ({ category: r.key, spendCents: r.cents, count: r.count })),
      byKind: [...kinds.values()].sort((a, b) => (a.kind + (a.subtype || '') < b.kind + (b.subtype || '') ? -1 : 1)),
      refunds: { count: spend.filter(t => t.amountCents > 0).length, cents: sum(spend, t => (t.amountCents > 0 ? t.amountCents : 0)) },
      cardPaymentsExcluded: {
        count: cardPayments.length,
        paidFromCashCents: sum(cardPayments.filter(t => t.amountCents < 0 && typeById.get(t.accountId) !== 'credit_card'), t => -t.amountCents),
        receivedOnCardsCents: sum(cardPayments.filter(t => t.amountCents > 0), t => t.amountCents)
      },
      transfers: transferRows(txns.filter(t => t.kind === 'transfer')),
      debtPayments: { count: txns.filter(t => t.kind === 'debt_payment').length, cents: sum(txns.filter(t => t.kind === 'debt_payment'), t => -t.amountCents) },
      income: {
        payrollCents: sum(txns.filter(t => t.kind === 'income' && t.subtype === 'payroll'), t => t.amountCents),
        interestCents: sum(txns.filter(t => t.kind === 'income' && t.subtype === 'interest'), t => t.amountCents),
        otherCents: sum(txns.filter(t => t.kind === 'income' && t.subtype !== 'payroll' && t.subtype !== 'interest'), t => t.amountCents)
      },
      candidates: {
        reimbursement: { count: reimb.length, chargesCents: sum(reimb.filter(t => t.amountCents < 0), t => -t.amountCents), depositsCents: sum(reimb.filter(t => t.amountCents > 0), t => t.amountCents) },
        business: { count: flagged('business_candidate').length, spendCents: sum(flagged('business_candidate').filter(t => t.kind === 'spend'), spendCents) },
        mixedRetail: { count: flagged('mixed_retail').length, spendCents: sum(flagged('mixed_retail').filter(t => t.kind === 'spend'), spendCents) },
        needsReview: { count: flagged('needs_category_review').length, cents: sum(flagged('needs_category_review'), t => Math.abs(t.amountCents)) },
        unpairedTransfers: { count: flagged('unpaired_transfer').length, cents: sum(flagged('unpaired_transfer'), t => Math.abs(t.amountCents)) }
      },
      coverage
    };
  }

  E.importer = {
    PROFILES, DEFAULT_RULES, COLUMN_SYNONYMS,
    parseCSV, parseCSVRecords, detectMapping, parseDate, cleanMerchant, normalizeFile, inferCardSign,
    dedupe, assignIds, classify, prepareRules, pairTransfers, markReimbursementCandidates,
    mergeRanges, monthlySummary, buildDataset, periodBreakdown
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
