'use strict';
// Unit tests for BudgetEngine.importer and tools/import.cjs. All data is invented.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadEngine } = require('../load-engine.cjs');

const E = loadEngine();
const I = E.importer;
const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'tools', 'import.cjs');

const ACCOUNTS = [
  { id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint' },
  { id: 'card', label: 'Joint card', type: 'credit_card', scope: 'joint', paidInFull: true },
  { id: 'sav', label: 'Joint savings', type: 'savings', scope: 'joint' }
];
const CHECKING = ACCOUNTS[0], CARD = ACCOUNTS[1];

let rowCounter = 0;
/** An unclassified transaction as normalizeFile would produce it. */
function raw(over) {
  rowCounter += 1;
  return {
    id: 'row-' + rowCounter, accountId: 'chk', date: '2026-03-10', description: 'SOMETHING', merchant: '',
    amountCents: -1000, kind: null, subtype: null, category: null, sourceCategory: null, categoryReason: '',
    confidence: null, flags: [], pairId: null, matchIds: [], sourceFile: 'test.csv', sourceRow: rowCounter, note: '', ...over
  };
}
/** A classified transaction, for pairing / reimbursement tests. */
function txn(over) {
  return raw({ kind: 'spend', category: 'Uncategorized', confidence: 'high', ...over });
}
const one = (over, rules) => I.classify([raw(over)], rules, ACCOUNTS)[0];
const csv = lines => lines.join('\n') + '\n';

// ====================================================================== CSV

describe('parseCSV', () => {
  test('parses simple rows', () => {
    assert.deepEqual(I.parseCSV('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
  });
  test('quoted fields keep commas', () => {
    assert.deepEqual(I.parseCSV('"Smith, A",12\n'), [['Smith, A', '12']]);
  });
  test('doubled quotes become one quote', () => {
    assert.deepEqual(I.parseCSV('"say ""hi""",x\n'), [['say "hi"', 'x']]);
  });
  test('newlines inside quoted fields are kept', () => {
    assert.deepEqual(I.parseCSV('"line one\nline two",2\n3,4'), [['line one\nline two', '2'], ['3', '4']]);
    assert.deepEqual(I.parseCSV('"a\r\nb",1\r\n'), [['a\r\nb', '1']]);
  });
  test('CRLF, LF and lone CR line endings', () => {
    assert.deepEqual(I.parseCSV('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(I.parseCSV('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(I.parseCSV('a,b\r1,2\r'), [['a', 'b'], ['1', '2']]);
  });
  test('strips a UTF-8 byte order mark', () => {
    const rows = I.parseCSV('﻿Date,Amount\n01/02/2026,5\n');
    assert.equal(rows[0][0], 'Date');
  });
  test('skips blank lines, including trailing ones', () => {
    assert.deepEqual(I.parseCSV('a,b\n\n1,2\n   \n\n\r\n'), [['a', 'b'], ['1', '2']]);
  });
  test('keeps empty fields and a trailing empty field', () => {
    assert.deepEqual(I.parseCSV('a,,c,\n'), [['a', '', 'c', '']]);
  });
  test('a quoted empty field is a record, not a blank line', () => {
    assert.deepEqual(I.parseCSV('""\n'), [['']]);
  });
  test('tolerates an unterminated quote at the end of the file', () => {
    assert.deepEqual(I.parseCSV('a,"unfinished'), [['a', 'unfinished']]);
  });
  test('empty or missing input gives no rows', () => {
    assert.deepEqual(I.parseCSV(''), []);
    assert.deepEqual(I.parseCSV(null), []);
  });
  test('parseCSVRecords reports the physical start line of each record', () => {
    const recs = I.parseCSVRecords('h1,h2\n"multi\nline",1\n\nlast,2\n');
    assert.deepEqual(recs.map(r => r.line), [1, 2, 5]);
  });
});

// ====================================================================== header detection

describe('detectMapping', () => {
  test('signed amount export with balance', () => {
    const m = I.detectMapping(['Date', 'Description', 'Amount', 'Balance']);
    assert.equal(m.profile, 'signed_amount');
    assert.equal(m.date, 'Date');
    assert.equal(m.amount, 'Amount');
    assert.equal(m.balance, 'Balance');
    assert.equal(m.dateFormat, 'MDY');
  });
  test('checking export with Details/Posting Date/Type columns', () => {
    const m = I.detectMapping(['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #']);
    assert.equal(m.profile, 'signed_amount');
    assert.equal(m.date, 'Posting Date');
    assert.equal(m.description, 'Description');
    assert.equal(m.type, 'Type');
  });
  test('debit/credit export with a Status column', () => {
    const m = I.detectMapping(['Status', 'Date', 'Description', 'Debit', 'Credit']);
    assert.equal(m.profile, 'debit_credit');
    assert.equal(m.debit, 'Debit');
    assert.equal(m.credit, 'Credit');
    assert.equal(m.status, 'Status');
    assert.equal(m.amount, undefined);
  });
  test('card export with transaction + posted dates and debit/credit', () => {
    const m = I.detectMapping(['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit']);
    assert.equal(m.profile, 'card_debit_credit');
    assert.equal(m.date, 'Transaction Date');
    assert.equal(m.postDate, 'Posted Date');
    assert.equal(m.category, 'Category');
  });
  test('card export with transaction + post dates and one amount (memo is not the description)', () => {
    const m = I.detectMapping(['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo']);
    assert.equal(m.profile, 'card_signed_amount');
    assert.equal(m.postDate, 'Post Date');
    assert.equal(m.description, 'Description');
    assert.equal(m.amount, 'Amount');
  });
  test('header matching ignores case, spacing and punctuation', () => {
    const m = I.detectMapping(['  DATE ', 'payee', 'AMOUNT ($)']);
    assert.equal(m.profile, 'signed_amount');
    assert.equal(m.description, 'payee');
    assert.equal(m.amount, 'AMOUNT ($)');
  });
  test('Merchant and Withdrawals/Deposits synonyms', () => {
    const m = I.detectMapping(['Transaction Date', 'Merchant', 'Withdrawals', 'Deposits']);
    assert.equal(m.profile, 'debit_credit');
    assert.equal(m.description, 'Merchant');
    assert.equal(m.debit, 'Withdrawals');
    assert.equal(m.credit, 'Deposits');
  });
  test('unrecognised or empty headers return null', () => {
    assert.equal(I.detectMapping(['When', 'What', 'How much']), null);
    assert.equal(I.detectMapping(['Date', 'Description']), null);
    assert.equal(I.detectMapping([]), null);
    assert.equal(I.detectMapping(null), null);
  });
  test('every profile is documented', () => {
    for (const p of I.PROFILES) {
      assert.equal(typeof p.id, 'string');
      assert.ok(p.label.length > 10);
    }
  });
});

// ====================================================================== dates

describe('parseDate', () => {
  test('MDY with 4- and 2-digit years', () => {
    assert.equal(I.parseDate('1/2/2025', 'MDY'), '2025-01-02');
    assert.equal(I.parseDate('01/02/25', 'MDY'), '2025-01-02');
    assert.equal(I.parseDate('12-31-2025', 'MDY'), '2025-12-31');
    assert.equal(I.parseDate('3.4.2026'), '2026-03-04');
  });
  test('YMD with dashes, slashes or compact', () => {
    assert.equal(I.parseDate('2025-01-02', 'YMD'), '2025-01-02');
    assert.equal(I.parseDate('2025/1/2', 'YMD'), '2025-01-02');
    assert.equal(I.parseDate('20250102', 'YMD'), '2025-01-02');
  });
  test('year-first dates are unambiguous and accepted in any format', () => {
    assert.equal(I.parseDate('2025-07-04', 'MDY'), '2025-07-04');
    assert.equal(I.parseDate('2025-07-04', 'DMY'), '2025-07-04');
  });
  test('DMY when asked', () => {
    assert.equal(I.parseDate('02/01/2025', 'DMY'), '2025-01-02');
    assert.equal(I.parseDate('31/12/25', 'DMY'), '2025-12-31');
  });
  test('YMD rejects month-day-year text', () => {
    assert.equal(I.parseDate('01/02/2025', 'YMD'), null);
  });
  test('ignores a trailing time', () => {
    assert.equal(I.parseDate('01/02/2025 00:00:00'), '2025-01-02');
    assert.equal(I.parseDate('2025-01-02T10:15:00Z'), '2025-01-02');
    assert.equal(I.parseDate('1/2/2025 3:04 PM'), '2025-01-02');
  });
  test('invalid dates return null', () => {
    assert.equal(I.parseDate('02/30/2025'), null);
    assert.equal(I.parseDate('13/01/2025', 'MDY'), null);
    assert.equal(I.parseDate('2025-02-29'), null);
    assert.equal(I.parseDate('Total'), null);
    assert.equal(I.parseDate(''), null);
    assert.equal(I.parseDate(null), null);
  });
  test('leap day is valid in a leap year', () => {
    assert.equal(I.parseDate('02/29/2024'), '2024-02-29');
  });
  test('unknown format throws', () => {
    assert.throws(() => I.parseDate('01/02/2025', 'XYZ'), E.ValidationError);
  });
});

// ====================================================================== normalizeFile

describe('normalizeFile', () => {
  test('signed checking export: amounts, rows and dates', () => {
    const res = I.normalizeFile({ name: 'chk.csv', account: CHECKING, text: csv([
      'Date,Description,Amount,Balance',
      '03/02/2026,SAMPLE PAYROLL DIR DEP,"$1,234.56",2000.00',
      '03/03/2026,  SAMPLE   GROCER  ,(12.30),1987.70',
      '03/04/2026,SAMPLE STORE,45.00-,1942.70'
    ]) });
    assert.deepEqual(res.txns.map(t => t.amountCents), [123456, -1230, -4500]);
    assert.equal(res.txns[1].description, 'SAMPLE GROCER');
    assert.deepEqual(res.txns.map(t => t.sourceRow), [2, 3, 4]);
    assert.equal(res.rows, 3);
    assert.equal(res.start, '2026-03-02');
    assert.equal(res.end, '2026-03-04');
    assert.equal(res.headerRow, 1);
    assert.equal(res.txns[0].sourceFile, 'chk.csv');
    assert.equal(res.txns[0].accountId, 'chk');
    assert.equal(res.txns[0].sourceCategory, null);
    assert.equal(res.skipped.length, 0);
  });
  test('bad rows are skipped with reasons and row numbers', () => {
    const res = I.normalizeFile({ name: 'chk.csv', account: CHECKING, text: csv([
      'Date,Description,Amount',
      '02/30/2026,BAD DATE,-1.00',
      ',NO DATE,-1.00',
      '03/01/2026,BAD AMOUNT,abc',
      '03/01/2026,NO AMOUNT,',
      '03/01/2026,ZERO,0.00',
      '03/02/2026,GOOD,-2.00',
      ',,'
    ]) });
    assert.deepEqual(res.skipped, [
      { row: 2, reason: 'invalid date "02/30/2026"' },
      { row: 3, reason: 'missing date' },
      { row: 4, reason: 'invalid amount "abc"' },
      { row: 5, reason: 'missing amount' },
      { row: 6, reason: 'zero amount' }
    ]);
    assert.equal(res.txns.length, 1);
    assert.equal(res.rows, 6, 'an all-blank row is not counted');
  });
  test('pending rows are skipped with reason "pending"', () => {
    const res = I.normalizeFile({ name: 'c.csv', account: CHECKING, text: csv([
      'Status,Date,Description,Debit,Credit',
      'Pending,03/05/2026,SAMPLE CAFE,4.50,',
      'Cleared,03/04/2026,SAMPLE CAFE,4.50,'
    ]) });
    assert.deepEqual(res.skipped, [{ row: 2, reason: 'pending' }]);
    assert.equal(res.txns.length, 1);
  });
  test('debit/credit columns: debit is money out, credit money in, whatever sign is printed', () => {
    const res = I.normalizeFile({ name: 'c.csv', account: CHECKING, text: csv([
      'Date,Description,Debit,Credit',
      '03/01/2026,BILL,25.00,',
      '03/02/2026,BILL NEGATIVE,-30.00,',
      '03/03/2026,DEPOSIT,,100.00'
    ]) });
    assert.deepEqual(res.txns.map(t => t.amountCents), [-2500, -3000, 10000]);
    assert.match(res.signConvention, /Debit\/Credit/);
  });
  test('card export: posted date is the date; transaction date goes to the note', () => {
    const res = I.normalizeFile({ name: 'card.csv', account: CARD, text: csv([
      'Transaction Date,Posted Date,Description,Category,Debit,Credit',
      '03/01/2026,03/03/2026,SAMPLE BOOKSHOP,Shopping,20.00,',
      '03/05/2026,03/05/2026,PAYMENT THANK YOU,,,500.00'
    ]) });
    assert.equal(res.txns[0].date, '2026-03-03');
    assert.match(res.txns[0].note, /Transaction date 2026-03-01/);
    assert.equal(res.txns[1].note, '', 'no note when both dates agree');
    assert.equal(res.txns[0].sourceCategory, 'Shopping');
    assert.equal(res.txns[1].sourceCategory, null);
    assert.deepEqual(res.txns.map(t => t.amountCents), [-2000, 50000]);
  });
  test('card export with charges as positive numbers is inferred and flipped', () => {
    const res = I.normalizeFile({ name: 'card.csv', account: CARD, text: csv([
      'Date,Description,Amount',
      '03/01/2026,SAMPLE GROCER,54.10',
      '03/02/2026,SAMPLE CAFE,8.25',
      '03/03/2026,SAMPLE STORE RETURN,-10.00',
      '03/10/2026,AUTOMATIC PAYMENT - THANK YOU,-300.00'
    ]) });
    assert.deepEqual(res.txns.map(t => t.amountCents), [-5410, -825, 1000, 30000]);
    assert.ok(res.warnings.some(w => /inferred that card charges are POSITIVE/.test(w)));
    assert.match(res.signConvention, /inferred/);
  });
  test('card export already in account flow (charges negative) is inferred and kept', () => {
    const res = I.normalizeFile({ name: 'card.csv', account: CARD, text: csv([
      'Transaction Date,Post Date,Description,Category,Type,Amount',
      '03/01/2026,03/02/2026,SAMPLE GROCER,Groceries,Sale,-54.10',
      '03/02/2026,03/03/2026,SAMPLE CAFE,Food & Drink,Sale,-8.25',
      '03/10/2026,03/10/2026,Payment Thank You-Mobile,,Payment,300.00'
    ]) });
    assert.deepEqual(res.txns.map(t => t.amountCents), [-5410, -825, 30000]);
    assert.ok(res.warnings.some(w => /inferred that card charges are negative/.test(w)));
  });
  test('explicit chargesPositive overrides inference both ways', () => {
    const text = csv(['Date,Description,Amount', '03/01/2026,SAMPLE GROCER,54.10']);
    const flipped = I.normalizeFile({ name: 'c.csv', account: CARD, text, mapping: { chargesPositive: true } });
    assert.equal(flipped.txns[0].amountCents, -5410);
    assert.equal(flipped.warnings.length, 0);
    const kept = I.normalizeFile({ name: 'c.csv', account: CARD, text, mapping: { chargesPositive: false } });
    assert.equal(kept.txns[0].amountCents, 5410);
  });
  test('card export where purchases and payments share a sign cannot be inferred', () => {
    const text = csv(['Date,Description,Amount', '03/01/2026,SAMPLE GROCER,54.10', '03/02/2026,SAMPLE CAFE,8.00', '03/10/2026,PAYMENT THANK YOU,300.00']);
    assert.throws(() => I.normalizeFile({ name: 'c.csv', account: CARD, text }), err => err instanceof E.ValidationError && err.code === 'SIGN_UNKNOWN');
  });
  test('unsigned checking export takes direction from the type column', () => {
    const res = I.normalizeFile({ name: 'c.csv', account: CHECKING, text: csv([
      'Date,Description,Amount,Type', '03/01/2026,SAMPLE BILL,25.00,DEBIT', '03/02/2026,SAMPLE DEPOSIT,100.00,CREDIT'
    ]) });
    assert.deepEqual(res.txns.map(t => t.amountCents), [-2500, 10000]);
    assert.ok(res.warnings.some(w => /direction was taken/.test(w)));
  });
  test('all-positive checking export without a type column is kept but warned about', () => {
    const res = I.normalizeFile({ name: 'c.csv', account: CHECKING, text: csv(['Date,Description,Amount', '03/01/2026,A,1.00', '03/02/2026,B,2.00']) });
    assert.deepEqual(res.txns.map(t => t.amountCents), [100, 200]);
    assert.ok(res.warnings.some(w => /every amount is positive/.test(w)));
  });
  test('savings exports with only deposits raise no sign warning', () => {
    const res = I.normalizeFile({ name: 's.csv', account: ACCOUNTS[2], text: csv(['Posting Date,Description,Amount', '2026-03-02,TRANSFER FROM CHECKING,250.00', '2026-03-31,INTEREST PAID,1.10']) });
    assert.deepEqual(res.warnings, []);
    assert.equal(res.txns[0].date, '2026-03-02');
  });
  test('preamble lines before the header are skipped', () => {
    const res = I.normalizeFile({ name: 'c.csv', account: CHECKING, text: csv([
      'Account Name : Sample Checking', 'Date Range: 03/01/2026 - 03/31/2026', '', 'Date,Description,Amount', '03/02/2026,SAMPLE,-3.00'
    ]) });
    assert.equal(res.headerRow, 4);
    assert.equal(res.txns[0].sourceRow, 5);
  });
  test('unrecognised headers throw with the header row attached', () => {
    assert.throws(() => I.normalizeFile({ name: 'odd.csv', account: CHECKING, text: 'When,What,How much\n1,2,3\n' }),
      err => err instanceof E.ValidationError && err.code === 'UNRECOGNISED_HEADER' && err.header[0] === 'When' && /odd\.csv/.test(err.message));
  });
  test('a full custom mapping uses the file\'s own column names', () => {
    const res = I.normalizeFile({ name: 'c.csv', account: CHECKING, mapping: { date: 'When', description: 'What', amount: 'How much', dateFormat: 'DMY' },
      text: 'When,What,How much\n02/03/2026,SAMPLE,-1.50\n' });
    assert.equal(res.txns[0].date, '2026-03-02');
    assert.equal(res.txns[0].amountCents, -150);
  });
  test('a positional mapping reads header-less exports', () => {
    const res = I.normalizeFile({ name: 'c.csv', account: CHECKING, mapping: { date: 0, amount: 1, description: 4 },
      text: '"03/02/2026","-7.25","*","","SAMPLE SHOP"\n' });
    assert.equal(res.txns[0].amountCents, -725);
    assert.equal(res.txns[0].description, 'SAMPLE SHOP');
    assert.equal(res.txns[0].sourceRow, 1);
  });
  test('a mapped column that does not exist is an error', () => {
    assert.throws(() => I.normalizeFile({ name: 'c.csv', account: CHECKING, mapping: { date: 'Date', description: 'Nope', amount: 'Amount' }, text: 'Date,Description,Amount\n' }), E.ValidationError);
  });
  test('an empty file gives no transactions and a warning', () => {
    const res = I.normalizeFile({ name: 'empty.csv', account: CHECKING, text: '' });
    assert.deepEqual(res.txns, []);
    assert.equal(res.start, null);
    assert.equal(res.warnings.length, 1);
  });
  test('merchant names are cleaned for display', () => {
    assert.equal(I.cleanMerchant('KROGER #0412'), 'Kroger');
    assert.equal(I.cleanMerchant('AMAZON MKTPL*2K4H71'), 'Amazon Mktpl');
    assert.equal(I.cleanMerchant('CVS/PHARMACY #4410'), 'CVS/Pharmacy');
    assert.equal(I.cleanMerchant('SQ *SAMPLE CAFE'), 'Sample Cafe');
    assert.equal(I.cleanMerchant('SHELL OIL 57441'), 'Shell Oil');
    assert.equal(I.cleanMerchant('12345'), '12345');
  });
});

// ====================================================================== dedupe & ids

describe('dedupe', () => {
  const row = (file, r, over) => raw({ sourceFile: file, sourceRow: r, date: '2026-01-05', description: 'SAMPLE GROCER', amountCents: -2500, ...over });

  test('identical rows in overlapping files are imported once', () => {
    const { kept, removed } = I.dedupe([row('a.csv', 2), row('a.csv', 3, { date: '2026-01-06' }), row('b.csv', 7), row('b.csv', 8, { date: '2026-01-09' })]);
    assert.equal(kept.length, 3);
    assert.deepEqual(removed.map(r => [r.file, r.row, r.keptFile, r.keptRow]), [['b.csv', 7, 'a.csv', 2]]);
  });
  test('genuine same-day repeats within one file are kept', () => {
    const { kept, removed } = I.dedupe([row('a.csv', 2), row('a.csv', 3), row('a.csv', 4)]);
    assert.equal(kept.length, 3);
    assert.equal(removed.length, 0);
  });
  test('keeps the maximum count seen in any single file (larger file first)', () => {
    const { kept, removed } = I.dedupe([row('a.csv', 2), row('a.csv', 3), row('b.csv', 2)]);
    assert.equal(kept.length, 2);
    assert.ok(kept.every(t => t.sourceFile === 'a.csv'));
    assert.equal(removed.length, 1);
  });
  test('keeps the maximum count seen in any single file (larger file second)', () => {
    const { kept, removed } = I.dedupe([row('a.csv', 2), row('b.csv', 2), row('b.csv', 3)]);
    assert.equal(kept.length, 2);
    assert.ok(kept.every(t => t.sourceFile === 'b.csv'));
    assert.deepEqual(removed.map(r => r.file), ['a.csv']);
  });
  test('rows of different accounts, amounts or dates are not duplicates', () => {
    const { kept } = I.dedupe([row('a.csv', 2), row('b.csv', 2, { accountId: 'card' }), row('b.csv', 3, { amountCents: -2501 }), row('b.csv', 4, { date: '2026-01-04' })]);
    assert.equal(kept.length, 4);
  });
  test('descriptions are compared after normalizing case and spacing', () => {
    const { kept } = I.dedupe([row('a.csv', 2, { description: 'SAMPLE  GROCER #12' }), row('b.csv', 2, { description: 'sample grocer #12' })]);
    assert.equal(kept.length, 1);
  });
});

describe('ids', () => {
  const header = 'Date,Description,Amount\n';
  const lines = {
    jan: '01/10/2026,SAMPLE GROCER,-25.00\n01/10/2026,SAMPLE GROCER,-25.00\n',
    feb: '02/03/2026,SAMPLE CAFE,-4.50\n',
    mar: '03/04/2026,SAMPLE PAYROLL DIR DEP,1000.00\n'
  };
  const build = files => I.buildDataset({ files, accounts: [CHECKING], datasetId: 't', generatedAt: '2026-04-01' }).dataset.transactions;

  test('ids are stable across re-imports of overlapping exports', () => {
    const split = build([
      { name: 'a.csv', accountId: 'chk', text: header + lines.jan + lines.feb },
      { name: 'b.csv', accountId: 'chk', text: header + lines.feb + lines.mar }
    ]);
    const whole = build([{ name: 'all.csv', accountId: 'chk', text: header + lines.mar + lines.feb + lines.jan }]);
    assert.deepEqual(split.map(t => t.id), whole.map(t => t.id));
    assert.equal(split.length, 4);
  });
  test('same-day repeats get distinct ids', () => {
    const t = build([{ name: 'a.csv', accountId: 'chk', text: header + lines.jan }]);
    assert.equal(t.length, 2);
    assert.notEqual(t[0].id, t[1].id);
    assert.ok(t.every(x => /^tx-[0-9a-z]+$/.test(x.id)));
  });
  test('assignIds follows the documented hash input', () => {
    const [t] = I.assignIds([raw({ accountId: 'chk', date: '2026-01-10', amountCents: -2500, description: 'Sample  Grocer' })]);
    assert.equal(t.id, 'tx-' + E.util.hash('chk|2026-01-10|-2500|sample grocer|0'));
  });
});

// ====================================================================== classify

describe('classify: precedence', () => {
  test('a user rule beats a default rule', () => {
    const t = one({ accountId: 'card', description: 'COSTCO WHSE #0001' }, { merchantRules: [{ match: 'COSTCO WHSE', category: 'Groceries', reason: 'We only buy food there' }] });
    assert.equal(t.category, 'Groceries');
    assert.equal(t.categoryReason, 'We only buy food there');
    assert.ok(!t.flags.includes('mixed_retail'), 'the overridden default adds no flags');
  });
  test('a default rule beats the bank category', () => {
    const t = one({ accountId: 'card', description: 'CHEWY.COM', sourceCategory: 'Shopping' });
    assert.equal(t.category, 'Pets');
    assert.equal(t.sourceCategory, 'Shopping');
  });
  test('the bank category map applies when no rule matched', () => {
    const t = one({ accountId: 'card', description: 'SAMPLE BISTRO', sourceCategory: 'Food & Drink' });
    assert.equal(t.category, 'Dining & takeout');
    assert.equal(t.confidence, 'medium');
    assert.equal(t.categoryReason, 'Bank category "Food & Drink"');
  });
  test('a user categoryMap overrides the default map', () => {
    const t = one({ accountId: 'card', description: 'SAMPLE BISTRO', sourceCategory: 'Food & Drink' }, { categoryMap: { 'food & drink': 'Groceries' } });
    assert.equal(t.category, 'Groceries');
  });
  test('broad bank categories become Uncategorized for review', () => {
    for (const src of ['Shopping', 'Merchandise', 'Bills & Utilities', 'Services', 'Other']) {
      const t = one({ accountId: 'card', description: 'SAMPLE THING', sourceCategory: src });
      assert.equal(t.category, 'Uncategorized', src);
      assert.ok(t.flags.includes('needs_category_review'));
      assert.match(t.categoryReason, /too broad/);
      assert.equal(t.confidence, 'low');
    }
  });
  test('an unknown bank category is reported, not guessed', () => {
    const t = one({ accountId: 'card', description: 'SAMPLE THING', sourceCategory: 'Widgets' });
    assert.equal(t.category, 'Uncategorized');
    assert.match(t.categoryReason, /Bank category "Widgets" has no household mapping/);
  });
  test('a bank category equal to a household category name is used', () => {
    assert.equal(one({ accountId: 'card', description: 'SAMPLE TOYS', sourceCategory: 'hobbies' }).category, 'Hobbies');
  });
  test('no rule and no bank category: Uncategorized, low confidence, plain reason', () => {
    const t = one({ description: 'SAMPLE UNKNOWN SHOP', amountCents: -1999 });
    assert.equal(t.kind, 'spend');
    assert.equal(t.category, 'Uncategorized');
    assert.equal(t.confidence, 'low');
    assert.deepEqual(t.flags, ['needs_category_review']);
    assert.equal(t.categoryReason, 'No rule or bank category matched');
  });
  test('rules can match the bank category field', () => {
    const t = one({ accountId: 'card', description: 'SAMPLE X', sourceCategory: 'Lawn & Garden' }, { merchantRules: [{ match: '^Lawn', field: 'sourceCategory', category: 'Home maintenance & repairs', reason: 'Garden supplies' }] });
    assert.equal(t.category, 'Home maintenance & repairs');
  });
  test('rules can be limited by account type and direction', () => {
    const rules = { merchantRules: [{ match: 'SAMPLE SHOP', accountType: 'credit_card', sign: 'out', category: 'Hobbies', reason: 'Card hobby shop' }] };
    assert.equal(one({ accountId: 'card', description: 'SAMPLE SHOP' }, rules).category, 'Hobbies');
    assert.equal(one({ accountId: 'chk', description: 'SAMPLE SHOP' }, rules).category, 'Uncategorized');
    assert.ok(one({ accountId: 'card', description: 'SAMPLE SHOP', amountCents: 500 }, rules).flags.includes('refund'));
    assert.equal(one({ accountId: 'card', description: 'SAMPLE SHOP', amountCents: 500 }, rules).category, 'Uncategorized');
  });
  test('flags from a flags-only rule are combined with a later category rule', () => {
    const t = one({ accountId: 'card', description: 'THE HOME DEPOT #0001' }, { merchantRules: [{ match: 'HOME DEPOT', flags: ['business_candidate'], reason: 'Possible business purchase — confirm' }] });
    assert.equal(t.category, 'Household & hardware');
    assert.deepEqual(t.flags, ['business_candidate']);
    assert.equal(t.categoryReason, 'Rule: hardware store; Possible business purchase — confirm');
  });
  test('hardware chains are not business-flagged by default', () => {
    const t = one({ accountId: 'card', description: "LOWE'S #0002" });
    assert.equal(t.category, 'Household & hardware');
    assert.deepEqual(t.flags, []);
  });
  test('sourceCategory is preserved exactly', () => {
    assert.equal(one({ accountId: 'card', description: 'KROGER #1', sourceCategory: '  Groceries ' }).sourceCategory, '  Groceries ');
    assert.equal(one({ description: 'X' }).sourceCategory, null);
  });
  test('classify does not mutate its input', () => {
    const input = raw({ description: 'KROGER #1' });
    const before = JSON.stringify(input);
    I.classify([input], {}, ACCOUNTS);
    assert.equal(JSON.stringify(input), before);
  });
  test('invalid user rules are reported', () => {
    assert.throws(() => I.classify([raw({})], { merchantRules: [{ match: '(unclosed', category: 'X' }] }, ACCOUNTS), /Rule 1 .* not a valid pattern/);
    assert.throws(() => I.classify([raw({})], { merchantRules: [{ match: 'X', kind: 'gift' }] }, ACCOUNTS), E.ValidationError);
    assert.throws(() => I.classify([raw({})], { merchantRules: [{ category: 'X' }] }, ACCOUNTS), E.ValidationError);
    assert.throws(() => I.classify([raw({})], { transferHints: [{ match: 'X', subtype: 'gift' }] }, ACCOUNTS), E.ValidationError);
    assert.throws(() => I.classify([raw({})], { merchantRules: 'nope' }, ACCOUNTS), E.ValidationError);
  });
});

describe('classify: merchants', () => {
  test('Costco gas is fuel; the Costco warehouse is mixed retail', () => {
    const gas = one({ accountId: 'card', description: 'COSTCO GAS #0123', sourceCategory: 'Gas' });
    const whse = one({ accountId: 'card', description: 'COSTCO WHSE #0123', sourceCategory: 'Shopping' });
    assert.equal(gas.category, 'Fuel');
    assert.equal(gas.merchant, 'Costco Gas');
    assert.deepEqual(gas.flags, []);
    assert.equal(whse.category, 'Mixed retail');
    assert.equal(whse.merchant, 'Costco');
    assert.deepEqual(whse.flags, ['mixed_retail']);
  });
  test('Amazon is mixed retail, never a goods category, even when the bank says Groceries', () => {
    for (const desc of ['AMAZON MKTPL*AB12CD', 'AMZN Mktp US*XY99', 'Amazon.com*Z1']) {
      const t = one({ accountId: 'card', description: desc, sourceCategory: 'Groceries' });
      assert.equal(t.category, 'Mixed retail', desc);
      assert.equal(t.confidence, 'medium');
      assert.ok(t.flags.includes('mixed_retail'));
      assert.match(t.categoryReason, /contents not inferred from merchant name/);
    }
  });
  test('an Amazon Prime membership is a subscription without the mixed-retail flag', () => {
    const t = one({ accountId: 'card', description: 'AMAZON PRIME*1A2B3C' });
    assert.equal(t.category, 'Subscriptions');
    assert.deepEqual(t.flags, []);
  });
  test('other mixed-retail chains', () => {
    for (const d of ['TARGET 00012345', 'WAL-MART #1', 'WALMART.COM', "SAM'S CLUB #2", "BJ'S WHOLESALE #3"]) {
      assert.equal(one({ accountId: 'card', description: d }).category, 'Mixed retail', d);
    }
  });
  test('dental, vision, pharmacy and pets', () => {
    assert.equal(one({ accountId: 'card', description: 'SAMPLE ENDODONTICS' }).category, 'Dental');
    assert.equal(one({ accountId: 'card', description: 'SMILES DDS' }).category, 'Dental');
    assert.equal(one({ accountId: 'card', description: 'SAMPLE OPTOMETRY' }).category, 'Vision');
    const cvs = one({ accountId: 'card', description: 'CVS/PHARMACY #1' });
    assert.equal(cvs.category, 'Medical & pharmacy');
    assert.equal(cvs.confidence, 'medium');
    assert.equal(one({ accountId: 'card', description: 'SAMPLE ANIMAL HOSPITAL' }).category, 'Pets');
  });
  test('travel, fuel, groceries, dining and rideshare', () => {
    assert.equal(one({ accountId: 'card', description: 'SAMPLE AIRLINES' }).category, 'Travel');
    assert.equal(one({ accountId: 'card', description: 'SHELL OIL 1' }).category, 'Fuel');
    assert.equal(one({ accountId: 'card', description: 'T-MOBILE AUTOPAY' }).category, 'Internet & phone');
    assert.equal(one({ accountId: 'card', description: 'KROGER #1' }).category, 'Groceries');
    assert.equal(one({ accountId: 'card', description: 'SAMPLE PIZZA CO' }).category, 'Dining & takeout');
    assert.equal(one({ accountId: 'card', description: 'UBER *EATS' }).category, 'Dining & takeout');
    assert.equal(one({ accountId: 'card', description: 'UBER *TRIP' }).category, 'Rideshare & transit');
  });
  test('fees and interest charges', () => {
    const fee = one({ accountId: 'card', description: 'ANNUAL MEMBERSHIP FEE', sourceCategory: 'Fees & Adjustments' });
    assert.equal(fee.category, 'Fees & interest');
    assert.deepEqual(fee.flags, ['fee']);
    const interest = one({ accountId: 'card', description: 'INTEREST CHARGE ON PURCHASES' });
    assert.equal(interest.category, 'Fees & interest');
    assert.ok(interest.flags.includes('fee'));
  });
  test('cash withdrawals need review', () => {
    const t = one({ description: 'ATM WITHDRAWAL 0001' });
    assert.equal(t.category, 'Cash withdrawals');
    assert.ok(t.flags.includes('needs_category_review'));
  });
  test('person-to-person payments: purpose unknown', () => {
    const out = one({ description: 'ZELLE PAYMENT TO SAMPLE PERSON', amountCents: -8000 });
    assert.equal(out.kind, 'spend');
    assert.equal(out.category, 'Uncategorized');
    assert.ok(out.flags.includes('needs_category_review'));
    assert.equal(out.categoryReason, 'Person-to-person payment: purpose unknown');
    const inbound = one({ description: 'VENMO CASHOUT', amountCents: 8000 });
    assert.equal(inbound.kind, 'income');
    assert.equal(inbound.subtype, 'other');
    assert.ok(inbound.flags.includes('needs_category_review'));
    assert.ok(!inbound.flags.includes('refund'));
  });
  test('default rules are generic and frozen', () => {
    const text = JSON.stringify(I.DEFAULT_RULES);
    assert.ok(!/SAMPLE|ALEX|SAM PERSONAL|J SMITH/i.test(text), 'no household-specific names');
    assert.ok(Object.isFrozen(I.DEFAULT_RULES.merchantRules));
    assert.ok(Object.isFrozen(I.DEFAULT_RULES.merchantRules[0]));
  });
});

describe('classify: kinds', () => {
  test('a credit on a card without payment wording is a refund that keeps the merchant category', () => {
    const t = one({ accountId: 'card', description: 'AMAZON MKTPL*AB12CD', amountCents: 2599, sourceCategory: 'Shopping' });
    assert.equal(t.kind, 'spend');
    assert.equal(t.category, 'Mixed retail');
    assert.ok(t.flags.includes('refund'));
    assert.match(t.categoryReason, /refund/);
  });
  test('a card refund falls back to the bank category, then to review', () => {
    const mapped = one({ accountId: 'card', description: 'SAMPLE BISTRO', amountCents: 1200, sourceCategory: 'Restaurants' });
    assert.equal(mapped.category, 'Dining & takeout');
    assert.ok(mapped.flags.includes('refund'));
    const unknown = one({ accountId: 'card', description: 'SAMPLE MYSTERY CREDIT', amountCents: 1200 });
    assert.equal(unknown.kind, 'spend');
    assert.equal(unknown.category, 'Uncategorized');
    assert.deepEqual(unknown.flags.sort(), ['needs_category_review', 'refund']);
  });
  test('a payment received on a card is a card payment', () => {
    for (const d of ['AUTOMATIC PAYMENT - THANK YOU', 'Payment Thank You-Mobile', 'AUTOPAY PAYMENT']) {
      const t = one({ accountId: 'card', description: d, amountCents: 50000 });
      assert.equal(t.kind, 'card_payment', d);
      assert.equal(t.subtype, null);
    }
  });
  test('card payments from checking: strong wording is high confidence, bare autopay medium', () => {
    for (const d of ['SAMPLE BANK CARD AUTOPAY', 'CREDIT CRD AUTOPAY', 'SAMPLE CRD PMT', 'ONLINE PAYMENT TO CARD 1234']) {
      const t = one({ description: d, amountCents: -50000 });
      assert.equal(t.kind, 'card_payment', d);
      assert.equal(t.confidence, 'high', d);
    }
    const weak = one({ description: 'SAMPLE BANK EPAY', amountCents: -50000 });
    assert.equal(weak.kind, 'card_payment');
    assert.equal(weak.confidence, 'medium');
  });
  test('an unknown deposit is other income for review, never payroll', () => {
    const t = one({ description: 'MOBILE DEPOSIT', amountCents: 48660 });
    assert.equal(t.kind, 'income');
    assert.equal(t.subtype, 'other');
    assert.equal(t.confidence, 'low');
    assert.ok(t.flags.includes('needs_category_review'));
    assert.match(t.categoryReason, /not assumed to be pay/);
  });
  test('payroll needs a payroll pattern and an inflow', () => {
    assert.equal(one({ description: 'SAMPLE EMPLOYER PAYROLL', amountCents: 100000 }).subtype, 'payroll');
    assert.equal(one({ description: 'SAMPLE CO DIR DEP', amountCents: 100000 }).subtype, 'payroll');
    const fee = one({ description: 'PAYROLL SERVICE FEE', amountCents: -1500 });
    assert.equal(fee.kind, 'spend');
    assert.equal(fee.category, 'Fees & interest');
  });
  test('interest earned is income; on a card a credit is not interest income', () => {
    const t = one({ accountId: 'sav', description: 'INTEREST PAID', amountCents: 312 });
    assert.equal(t.kind, 'income');
    assert.equal(t.subtype, 'interest');
  });
  test('savings and internal transfers', () => {
    const toSav = one({ description: 'TRANSFER TO SAVINGS', amountCents: -25000 });
    assert.equal(toSav.kind, 'transfer');
    assert.equal(toSav.subtype, 'savings');
    const onSav = one({ accountId: 'sav', description: 'TRANSFER FROM CHECKING', amountCents: 25000 });
    assert.equal(onSav.subtype, 'savings');
    const internal = one({ description: 'ONLINE TRANSFER FROM CHK 0001', amountCents: 50000 });
    assert.equal(internal.kind, 'transfer');
    assert.equal(internal.subtype, 'internal');
  });
  test('mortgage is housing spending; loan servicers are debt payments', () => {
    const m = one({ description: 'SAMPLE MORTGAGE SERVICER PMT', amountCents: -141256 });
    assert.equal(m.kind, 'spend');
    assert.equal(m.category, 'Mortgage');
    for (const d of ['NELNET STUDENT LN', 'SAMPLE AUTO LOAN PMT', 'MOHELA', 'DEPT EDUCATION']) {
      const t = one({ description: d, amountCents: -28950 });
      assert.equal(t.kind, 'debt_payment', d);
      assert.equal(t.subtype, 'loan');
    }
  });
  test('transfer hints set the subtype and person, beating default subtypes', () => {
    const rules = { transferHints: [{ match: 'FROM PARTNER B PERSONAL', subtype: 'contribution', personId: 'p2' }] };
    const t = one({ description: 'ONLINE TRANSFER FROM PARTNER B PERSONAL', amountCents: 132500 }, rules);
    assert.equal(t.kind, 'transfer');
    assert.equal(t.subtype, 'contribution');
    assert.equal(t.personId, 'p2');
    assert.match(t.categoryReason, /Transfer hint/);
    const p2p = one({ description: 'ZELLE FROM PARTNER B PERSONAL', amountCents: 5000 }, rules);
    assert.equal(p2p.kind, 'transfer', 'a hint beats the default person-to-person rule');
  });
  test('a user rule kind beats a transfer hint', () => {
    const t = one({ description: 'TRANSFER FROM SAMPLE TRUST', amountCents: 5000 }, {
      merchantRules: [{ match: 'SAMPLE TRUST', kind: 'income', subtype: 'other', reason: 'Gift from family' }],
      transferHints: [{ match: 'TRANSFER FROM', subtype: 'internal' }]
    });
    assert.equal(t.kind, 'income');
    assert.ok(!t.flags.includes('needs_category_review'), 'a user decision needs no review');
  });
  test('non-spend kinds get a kind label as category', () => {
    assert.equal(one({ description: 'TRANSFER TO SAVINGS', amountCents: -1 }).category, 'Transfer');
    assert.equal(one({ description: 'SAMPLE EMPLOYER PAYROLL', amountCents: 1 }).category, 'Income');
  });
});

// ====================================================================== pairing

describe('pairTransfers', () => {
  const pair = (list, opts) => I.pairTransfers(list, ACCOUNTS, opts);

  test('pairs a checking autopay with the payment received on the card', () => {
    const a = txn({ id: 'a', accountId: 'chk', date: '2026-02-25', kind: 'card_payment', amountCents: -123456 });
    const b = txn({ id: 'b', accountId: 'card', date: '2026-02-25', kind: 'card_payment', amountCents: 123456 });
    const [x, y] = pair([a, b]);
    assert.equal(x.pairId, 'b');
    assert.equal(y.pairId, 'a');
    assert.ok(!x.flags.includes('unpaired_transfer'));
    assert.match(x.categoryReason, /Paired with the payment received on Joint card/);
    assert.equal(a.pairId, null, 'input not mutated');
  });
  test('pairs savings transfers and labels both sides savings', () => {
    const out = pair([
      txn({ id: 'a', accountId: 'chk', date: '2026-02-02', kind: 'transfer', subtype: 'internal', amountCents: -25000 }),
      txn({ id: 'b', accountId: 'sav', date: '2026-02-03', kind: 'transfer', subtype: 'internal', amountCents: 25000 })
    ]);
    assert.deepEqual(out.map(t => [t.pairId, t.subtype]), [['b', 'savings'], ['a', 'savings']]);
  });
  test('closest date wins, deterministically', () => {
    const list = [
      txn({ id: 'o1', accountId: 'chk', date: '2026-02-01', kind: 'transfer', amountCents: -10000 }),
      txn({ id: 'o2', accountId: 'chk', date: '2026-02-04', kind: 'transfer', amountCents: -10000 }),
      txn({ id: 'i1', accountId: 'sav', date: '2026-02-04', kind: 'transfer', amountCents: 10000 })
    ];
    const out = pair(list);
    assert.equal(out.find(t => t.id === 'i1').pairId, 'o2');
    assert.ok(out.find(t => t.id === 'o1').flags.includes('unpaired_transfer'));
    const reversed = pair(list.slice().reverse());
    assert.equal(reversed.find(t => t.id === 'i1').pairId, 'o2');
  });
  test('does not pair the same account, different amounts or distant dates', () => {
    const out = pair([
      txn({ id: 'a', accountId: 'chk', date: '2026-02-01', kind: 'transfer', amountCents: -5000 }),
      txn({ id: 'b', accountId: 'chk', date: '2026-02-01', kind: 'transfer', amountCents: 5000 }),
      txn({ id: 'c', accountId: 'sav', date: '2026-02-01', kind: 'transfer', amountCents: 5001 }),
      txn({ id: 'd', accountId: 'sav', date: '2026-02-07', kind: 'transfer', amountCents: 5000 })
    ]);
    assert.ok(out.every(t => t.pairId === null));
    assert.ok(out.every(t => t.flags.includes('unpaired_transfer')));
  });
  test('the window is configurable', () => {
    const out = pair([
      txn({ id: 'a', accountId: 'chk', date: '2026-02-01', kind: 'transfer', amountCents: -5000 }),
      txn({ id: 'd', accountId: 'sav', date: '2026-02-07', kind: 'transfer', amountCents: 5000 })
    ], { days: 6 });
    assert.equal(out[0].pairId, 'd');
  });
  test('an unexplained deposit matching an outbound transfer becomes a transfer', () => {
    const out = pair([
      txn({ id: 'a', accountId: 'chk', date: '2026-02-01', kind: 'transfer', subtype: 'internal', amountCents: -7000 }),
      txn({ id: 'b', accountId: 'sav', date: '2026-02-02', kind: 'income', subtype: 'other', confidence: 'low', amountCents: 7000, flags: ['needs_category_review'] })
    ]);
    const b = out[1];
    assert.equal(b.kind, 'transfer');
    assert.equal(b.pairId, 'a');
    assert.equal(b.category, 'Transfer');
    assert.ok(!b.flags.includes('needs_category_review'));
    assert.match(b.categoryReason, /treated as a transfer, not income/);
  });
  test('income a user rule classified on purpose is not turned into a transfer', () => {
    const out = pair([
      txn({ id: 'a', accountId: 'chk', date: '2026-02-01', kind: 'transfer', subtype: 'internal', amountCents: -7000 }),
      txn({ id: 'b', accountId: 'sav', date: '2026-02-02', kind: 'income', subtype: 'other', amountCents: 7000 })
    ]);
    assert.equal(out[1].kind, 'income');
    assert.equal(out[1].pairId, null);
  });
  test('an unexplained deposit never pairs with a card payment', () => {
    const out = pair([
      txn({ id: 'a', accountId: 'chk', date: '2026-02-01', kind: 'card_payment', amountCents: -7000 }),
      txn({ id: 'b', accountId: 'sav', date: '2026-02-01', kind: 'income', subtype: 'other', amountCents: 7000, flags: ['needs_category_review'] })
    ]);
    assert.equal(out[1].kind, 'income');
    assert.equal(out[1].pairId, null);
  });
  test('a transfer that lands on a card account is a card payment', () => {
    const out = pair([
      txn({ id: 'a', accountId: 'chk', date: '2026-02-01', kind: 'transfer', subtype: 'internal', amountCents: -30000 }),
      txn({ id: 'b', accountId: 'card', date: '2026-02-02', kind: 'card_payment', amountCents: 30000 })
    ]);
    assert.deepEqual(out.map(t => t.kind), ['card_payment', 'card_payment']);
    assert.equal(out[0].subtype, null);
  });
  test('unpaired card payment with no card covering the date: purchases are not in the data', () => {
    const accounts = [CHECKING, { ...CARD, coverage: [{ start: '2026-01-01', end: '2026-06-30' }] }];
    const [t] = I.pairTransfers([txn({ id: 'a', accountId: 'chk', date: '2025-11-25', kind: 'card_payment', amountCents: -40000 })], accounts);
    assert.equal(t.kind, 'card_payment');
    assert.ok(t.flags.includes('unpaired_transfer'));
    assert.match(t.note, /not in the data/);
  });
  test('unpaired card payment while a card is covered: confirm it is not a bill', () => {
    const accounts = [CHECKING, { ...CARD, coverage: [{ start: '2026-01-01', end: '2026-06-30' }] }];
    const [t] = I.pairTransfers([txn({ id: 'a', accountId: 'chk', date: '2026-03-25', kind: 'card_payment', amountCents: -40000 })], accounts);
    assert.ok(t.flags.includes('unpaired_transfer'));
    assert.match(t.note, /confirm this pays a card/);
  });
  test('without declared coverage, a card account covers its own transaction dates', () => {
    const out = pair([
      txn({ id: 'c', accountId: 'card', date: '2026-03-01', amountCents: -100 }),
      txn({ id: 'c2', accountId: 'card', date: '2026-03-31', amountCents: -100 }),
      txn({ id: 'a', accountId: 'chk', date: '2026-03-25', kind: 'card_payment', amountCents: -40000 })
    ]);
    assert.match(out[2].note, /confirm this pays a card/);
  });
  test('unpaired inbound transfers are flagged; contributions are expected to be unpaired', () => {
    const out = pair([
      txn({ id: 'a', accountId: 'chk', date: '2026-05-11', kind: 'transfer', subtype: 'internal', amountCents: 50000 }),
      txn({ id: 'b', accountId: 'chk', date: '2026-05-15', kind: 'transfer', subtype: 'contribution', amountCents: 132500 })
    ]);
    assert.ok(out[0].flags.includes('unpaired_transfer'));
    assert.match(out[0].note, /where this money came from/);
    assert.deepEqual(out[1].flags, []);
    assert.equal(out[1].note, '');
  });
  test('running twice does not duplicate notes or flags', () => {
    const once = pair([txn({ id: 'a', accountId: 'chk', kind: 'transfer', amountCents: 50000 })]);
    const twice = pair(once);
    assert.equal(twice[0].note, once[0].note);
    assert.deepEqual(twice[0].flags, ['unpaired_transfer']);
  });
});

// ====================================================================== reimbursements

describe('markReimbursementCandidates', () => {
  const mark = (list, opts) => I.markReimbursementCandidates(list, { accounts: ACCOUNTS, ...opts });
  const airline = over => txn({ id: 'air', accountId: 'card', date: '2026-07-08', merchant: 'Sample Airlines', category: 'Travel', amountCents: -48660, ...over });
  const deposit = over => txn({ id: 'dep', accountId: 'chk', date: '2026-08-21', kind: 'income', subtype: 'other', category: 'Income', amountCents: 48660, ...over });

  test('a deposit equal to an earlier charge flags both and links them', () => {
    const [a, d] = mark([airline(), deposit()]);
    assert.ok(a.flags.includes('reimbursement_candidate'));
    assert.ok(d.flags.includes('reimbursement_candidate'));
    assert.deepEqual(a.matchIds, ['dep']);
    assert.deepEqual(d.matchIds, ['air']);
    assert.equal(a.kind, 'spend', 'never reclassified');
    assert.equal(d.kind, 'income');
    assert.match(d.note, /Sample Airlines/);
  });
  test('same-card refunds are not reimbursements', () => {
    const refund = txn({ id: 'ref', accountId: 'card', date: '2026-07-20', amountCents: 48660, flags: ['refund'] });
    const out = mark([airline(), refund]);
    assert.ok(out.every(t => !t.flags.includes('reimbursement_candidate')));
  });
  test('payroll, interest and contributions are not reimbursements', () => {
    for (const over of [{ subtype: 'payroll' }, { subtype: 'interest' }, { kind: 'transfer', subtype: 'contribution' }]) {
      const out = mark([airline(), deposit(over)]);
      assert.ok(out.every(t => !t.flags.includes('reimbursement_candidate')), JSON.stringify(over));
    }
  });
  test('an unpaired inbound internal transfer can be a reimbursement; a paired one cannot', () => {
    assert.ok(mark([airline(), deposit({ kind: 'transfer', subtype: 'internal' })])[1].flags.includes('reimbursement_candidate'));
    assert.ok(!mark([airline(), deposit({ kind: 'transfer', subtype: 'internal', pairId: 'x' })])[1].flags.includes('reimbursement_candidate'));
  });
  test('small charges, later charges and charges outside the window do not match', () => {
    assert.equal(mark([airline({ amountCents: -2499 }), deposit({ amountCents: 2499 })])[1].matchIds.length, 0);
    assert.equal(mark([airline({ amountCents: -2500 }), deposit({ amountCents: 2500 })])[1].matchIds.length, 1, '$25 is enough');
    assert.equal(mark([airline({ date: '2026-08-22' }), deposit()])[1].matchIds.length, 0);
    assert.equal(mark([airline({ date: '2026-04-22' }), deposit()])[1].matchIds.length, 0, '121 days earlier');
    assert.equal(mark([airline({ date: '2026-04-23' }), deposit()])[1].matchIds.length, 1, '120 days earlier');
    assert.equal(mark([airline({ date: '2026-04-22' }), deposit()], { days: 121 })[1].matchIds.length, 1);
  });
  test('matches the closest earlier charge, one to one', () => {
    const out = mark([
      airline({ id: 'old', date: '2026-06-01' }),
      airline({ id: 'new', date: '2026-08-01' }),
      deposit({ id: 'd1' }),
      deposit({ id: 'd2', date: '2026-08-25' })
    ]);
    const byId = Object.fromEntries(out.map(t => [t.id, t]));
    assert.deepEqual(byId.d1.matchIds, ['new']);
    assert.deepEqual(byId.d2.matchIds, ['old']);
  });
  test('deposits on card accounts are ignored', () => {
    const out = mark([airline(), deposit({ accountId: 'card', kind: 'transfer', subtype: 'internal' })]);
    assert.equal(out[1].matchIds.length, 0);
  });
});

// ====================================================================== coverage & dataset

describe('coverage', () => {
  test('mergeRanges merges overlapping and adjacent ranges, keeps gaps', () => {
    assert.deepEqual(I.mergeRanges([
      { start: '2025-11-01', end: '2026-09-30' },
      { start: '2024-10-01', end: '2025-12-31' },
      { start: '2026-10-01', end: '2026-10-31' },
      { start: '2027-01-01', end: '2027-01-31' }
    ]), [{ start: '2024-10-01', end: '2026-10-31' }, { start: '2027-01-01', end: '2027-01-31' }]);
  });
  test('mergeRanges drops invalid ranges', () => {
    assert.deepEqual(I.mergeRanges([{ start: '2026-02-01', end: '2026-01-01' }, { start: 'x', end: '2026-01-01' }, null]), []);
  });
  test('buildDataset uses declared coverage, else first/last row dates, and reports gaps', () => {
    const { dataset, report } = I.buildDataset({
      datasetId: 't', generatedAt: '2026-10-01', accounts: [CHECKING, CARD],
      files: [
        { name: 'c1.csv', accountId: 'chk', coverageStart: '2026-01-01', coverageEnd: '2026-02-28', text: 'Date,Description,Amount\n01/15/2026,A,-1.00\n' },
        { name: 'c2.csv', accountId: 'chk', coverageStart: '2026-02-01', coverageEnd: '2026-03-31', text: 'Date,Description,Amount\n03/15/2026,B,-1.00\n' },
        { name: 'k1.csv', accountId: 'card', text: 'Date,Description,Amount\n01/10/2026,C,-1.00\n01/20/2026,D,-1.00\n' },
        { name: 'k2.csv', accountId: 'card', text: 'Date,Description,Amount\n03/05/2026,E,-1.00\n03/09/2026,F,-1.00\n' }
      ]
    });
    assert.deepEqual(dataset.accounts[0].coverage, [{ start: '2026-01-01', end: '2026-03-31' }]);
    assert.deepEqual(dataset.accounts[1].coverage, [{ start: '2026-01-10', end: '2026-01-20' }, { start: '2026-03-05', end: '2026-03-09' }]);
    assert.ok(report.warnings.some(w => /Joint card: no export covers 2026-01-21 – 2026-03-04/.test(w)));
    const jan = report.months.find(m => m.month === '2026-01');
    assert.equal(jan.coverage.chk, 31);
    assert.equal(jan.coverage.card, 11);
    assert.equal(jan.spendingCoverage, 'partial');
  });
  test('savings coverage does not affect spending coverage in the monthly summary', () => {
    const rows = I.monthlySummary({
      accounts: [
        { id: 'chk', type: 'checking', coverage: [{ start: '2026-01-01', end: '2026-02-28' }] },
        { id: 'sav', type: 'savings', coverage: [{ start: '2026-02-01', end: '2026-02-28' }] }
      ],
      transactions: []
    });
    assert.deepEqual(rows.map(r => r.spendingCoverage), ['full', 'full']);
  });
});

describe('buildDataset', () => {
  const CHK_TEXT = csv([
    'Date,Description,Amount',
    '02/02/2026,TRANSFER TO SAVINGS,-250.00',
    '02/05/2026,SAMPLE EMPLOYER PAYROLL,1500.00',
    '02/25/2026,SAMPLE BANK CARD AUTOPAY,-80.00',
    '02/26/2026,MOBILE DEPOSIT,45.00',
    'not a date,JUNK,1.00'
  ]);
  const CARD_TEXT = csv([
    'Transaction Date,Posted Date,Description,Category,Debit,Credit',
    '02/01/2026,02/02/2026,KROGER #1,Groceries,35.00,',
    '02/09/2026,02/10/2026,SAMPLE AIRLINES,Travel,45.00,',
    '02/25/2026,02/25/2026,AUTOMATIC PAYMENT - THANK YOU,,,80.00'
  ]);
  const SAV_TEXT = csv(['Posting Date,Description,Amount', '2026-02-02,TRANSFER FROM CHECKING,250.00']);
  const input = () => ({
    datasetId: 'test', generatedAt: '2026-03-01', isSynthetic: true, accounts: ACCOUNTS,
    files: [
      { name: 'chk.csv', accountId: 'chk', text: CHK_TEXT, coverageStart: '2026-02-01', coverageEnd: '2026-02-28' },
      { name: 'card.csv', accountId: 'card', text: CARD_TEXT, coverageStart: '2026-02-01', coverageEnd: '2026-02-28' },
      { name: 'sav.csv', accountId: 'sav', text: SAV_TEXT }
    ]
  });

  test('produces a schema v2 dataset, sorted by date then id', () => {
    const { dataset } = I.buildDataset(input());
    assert.equal(dataset.schemaVersion, 2);
    assert.equal(dataset.datasetId, 'test');
    assert.equal(dataset.isSynthetic, true);
    assert.equal(dataset.currency, 'USD');
    assert.equal(dataset.generatedAt, '2026-03-01');
    const sorted = dataset.transactions.slice().sort((a, b) => (a.date + a.id < b.date + b.id ? -1 : 1));
    assert.deepEqual(dataset.transactions.map(t => t.id), sorted.map(t => t.id));
    assert.deepEqual(Object.keys(dataset.transactions[0]), ['id', 'accountId', 'date', 'description', 'merchant', 'amountCents', 'kind', 'subtype',
      'category', 'sourceCategory', 'categoryReason', 'confidence', 'flags', 'pairId', 'matchIds', 'sourceFile', 'sourceRow', 'note']);
  });
  test('runs pairing and reimbursement matching', () => {
    const { dataset } = I.buildDataset(input());
    const by = d => dataset.transactions.find(t => t.description === d);
    assert.equal(by('SAMPLE BANK CARD AUTOPAY').pairId, by('AUTOMATIC PAYMENT - THANK YOU').id);
    assert.equal(by('TRANSFER TO SAVINGS').pairId, by('TRANSFER FROM CHECKING').id);
    assert.deepEqual(by('MOBILE DEPOSIT').matchIds, [by('SAMPLE AIRLINES').id]);
  });
  test('report: per-file counts add up and totals by kind are given', () => {
    const { report } = I.buildDataset(input());
    for (const f of report.files) assert.equal(f.rows, f.imported + f.skipped + f.duplicatesRemoved, f.name);
    const chk = report.files.find(f => f.name === 'chk.csv');
    assert.equal(chk.skipped, 1);
    assert.deepEqual(chk.skippedReasons, { 'invalid date': 1 });
    assert.deepEqual(report.skippedRows, [{ file: 'chk.csv', row: 6, reason: 'invalid date "not a date"' }]);
    assert.equal(report.totalsByKind.card_payment.count, 2);
    assert.equal(report.totalsByKind.spend.outflowCents, 8000);
    assert.equal(report.spending.netCents, 8000);
    assert.equal(report.flagCounts.reimbursement_candidate, 2);
    assert.deepEqual(report.accounts.map(a => a.id), ['chk', 'card', 'sav']);
  });
  test('importLog records each file without timestamps', () => {
    const { dataset } = I.buildDataset(input());
    assert.equal(dataset.importLog.length, 3);
    assert.equal(dataset.importLog[1].profile, 'card_debit_credit');
    assert.ok(!JSON.stringify(dataset.importLog).includes('T0'));
  });
  test('rows outside the declared coverage are imported and warned about', () => {
    const inp = input();
    inp.files[0].coverageEnd = '2026-02-20';
    const { dataset, report } = I.buildDataset(inp);
    assert.ok(dataset.transactions.some(t => t.description === 'MOBILE DEPOSIT'));
    assert.ok(report.warnings.some(w => /outside the declared coverage/.test(w)));
  });
  test('validation: datasetId, generatedAt, files, accounts', () => {
    assert.throws(() => I.buildDataset({ ...input(), generatedAt: undefined }), /generatedAt/);
    assert.throws(() => I.buildDataset({ ...input(), datasetId: '' }), /datasetId/);
    assert.throws(() => I.buildDataset({ ...input(), files: [] }), E.ValidationError);
    const inp = input();
    inp.files[0].accountId = 'nope';
    assert.throws(() => I.buildDataset(inp), /unknown account "nope"/);
    const dup = input();
    dup.files[1].name = 'chk.csv';
    assert.throws(() => I.buildDataset(dup), /distinct name/);
    const badCov = input();
    badCov.files[0].coverageStart = '2026-13-01';
    assert.throws(() => I.buildDataset(badCov), /coverageStart/);
    assert.throws(() => I.buildDataset({ ...input(), accounts: [{ id: 'chk', type: 'bank' }] }), /type must be/);
  });
  test('an unpaired card payment before card coverage is warned about', () => {
    const inp = input();
    inp.files[0].text = 'Date,Description,Amount\n01/25/2026,SAMPLE BANK CARD AUTOPAY,-60.00\n';
    inp.files[0].coverageStart = '2026-01-01';
    const { report } = I.buildDataset(inp);
    assert.ok(report.warnings.some(w => /no card export covers/.test(w)));
  });
  test('the dataset passes ledger validation when the ledger module is present', { skip: !E.ledger }, () => {
    const { dataset } = I.buildDataset(input());
    assert.deepEqual(E.ledger.validateDataset(dataset).errors, []);
  });
  test('periodBreakdown reconciles spending by account, category and kind', () => {
    const { dataset } = I.buildDataset(input());
    const b = I.periodBreakdown(dataset, '2026-02-01', '2026-02-28');
    assert.equal(b.spending.netCents, 8000);
    assert.deepEqual(b.byAccount, [{ accountId: 'card', spendCents: 8000, count: 2 }]);
    assert.deepEqual(b.byCategory.map(r => r.category).sort(), ['Groceries', 'Travel']);
    assert.equal(b.cardPaymentsExcluded.paidFromCashCents, 8000);
    assert.equal(b.cardPaymentsExcluded.receivedOnCardsCents, 8000);
    assert.deepEqual(b.transfers, [{ subtype: 'savings', count: 2, inCents: 25000, outCents: 25000, unpaired: 0 }]);
    assert.equal(b.income.payrollCents, 150000);
    assert.equal(b.candidates.reimbursement.count, 2);
    assert.equal(b.coverage.find(c => c.accountId === 'chk').coveredDays, 28);
    assert.throws(() => I.periodBreakdown(dataset, '2026-03-01', '2026-02-01'), E.ValidationError);
  });
});

// ====================================================================== CLI

describe('tools/import.cjs', () => {
  const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'budget-import-'));
  const run = (root, args) => spawnSync(process.execPath, [CLI, '--root', root, ...args], { encoding: 'utf8' });
  const writeConfig = (root, extra = {}) => {
    fs.mkdirSync(path.join(root, 'private', 'raw'), { recursive: true });
    fs.writeFileSync(path.join(root, 'private', 'raw', 'chk.csv'), 'Date,Description,Amount\n02/02/2026,SAMPLE GROCER,-12.00\n02/05/2026,SAMPLE EMPLOYER PAYROLL,900.00\n');
    fs.writeFileSync(path.join(root, 'private', 'import.json'), JSON.stringify({
      datasetId: 'household', isSynthetic: false, generatedAt: '2026-03-01', accounts: [CHECKING],
      files: [{ path: 'private/raw/chk.csv', accountId: 'chk', coverageStart: '2026-02-01', coverageEnd: '2026-02-28' }], rules: 'private/rules.json', ...extra
    }));
  };

  test('without a config it prints setup help and writes a placeholder example once', () => {
    const root = tmpRoot();
    const res = run(root, []);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No import config found/);
    assert.match(res.stderr, /private\/raw/);
    const examplePath = path.join(root, 'private', 'import.example.json');
    const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    assert.equal(example.isSynthetic, false);
    assert.ok(example.files.every(f => f.path.startsWith('private/raw/') && f.coverageStart === 'YYYY-MM-DD'));
    fs.writeFileSync(examplePath, '{"edited":true}');
    run(root, []);
    assert.equal(fs.readFileSync(examplePath, 'utf8'), '{"edited":true}', 'an existing example is never overwritten');
  });
  test('imports into private/ and writes JSON and Markdown reports with a privacy warning', () => {
    const root = tmpRoot();
    writeConfig(root);
    const res = run(root, ['--period', '2026-02-01..2026-02-28']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /PRIVATE/);
    assert.match(res.stdout, /Period 2026-02-01 \.\. 2026-02-28/);
    assert.match(res.stdout, /Spending: purchases \$12\.00/);
    const data = JSON.parse(fs.readFileSync(path.join(root, 'private', 'budget-data.json'), 'utf8'));
    assert.equal(data.transactions.length, 2);
    assert.equal(data.transactions[0].sourceFile, 'chk.csv', 'folder names stay out of the dataset');
    const report = JSON.parse(fs.readFileSync(path.join(root, 'private', 'import-report.json'), 'utf8'));
    assert.ok(report.warnings.some(w => /Rules file private\/rules\.json not found/.test(w)));
    const md = fs.readFileSync(path.join(root, 'private', 'import-report.md'), 'utf8');
    assert.match(md, /## Coverage and spending by month/);
    assert.match(md, /\| 2026-02 \| full \| full \|/);
    assert.match(md.split('\n')[0], /^<!-- household-budget: PRIVATE import\sreport/, 'marker that the privacy check looks for');
  });
  test('--period accepts whole months and rejects malformed periods', () => {
    const root = tmpRoot();
    writeConfig(root);
    const ok = run(root, ['--period', '2026-02..2026-02']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Period 2026-02-01 \.\. 2026-02-28/);
    const bad = run(root, ['--period', 'last quarter']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--period/);
  });
  test('refuses to write outputs inside fixtures/ without --sample', () => {
    const root = tmpRoot();
    writeConfig(root);
    const res = run(root, ['--out', 'fixtures/leak.json']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Refusing/);
    assert.ok(!fs.existsSync(path.join(root, 'fixtures', 'leak.json')));
  });
  test('refuses private outputs inside the repository but outside private/', () => {
    const root = tmpRoot();
    writeConfig(root);
    for (const out of ['leak.json', 'docs/leak.json', 'Fixtures/leak.json', 'Private/leak.json']) {
      const res = run(root, ['--out', out]);
      assert.equal(res.status, 2, out);
      assert.match(res.stderr, /Refusing/, out);
      assert.ok(!fs.existsSync(path.join(root, out)), out + ' not written');
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-out-'));
    const ok = run(root, ['--out', path.join(outside, 'data.json')]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /outside this repository/);
  });
  test('a symlink into fixtures/ is treated as fixtures/', () => {
    const root = tmpRoot();
    writeConfig(root);
    fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
    fs.symlinkSync(path.join(root, 'fixtures'), path.join(root, 'private', 'shortcut'));
    const res = run(root, ['--out', 'private/shortcut/leak.json']);
    assert.equal(res.status, 2);
    assert.ok(!fs.existsSync(path.join(root, 'fixtures', 'leak.json')));
  });
  test('--sample refuses a config that is not marked synthetic', () => {
    const root = tmpRoot();
    writeConfig(root);
    const res = run(root, ['--sample', '--config', 'private/import.json']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /isSynthetic/);
  });
  test('--sample only reads inputs from fixtures/, even when a private config claims to be synthetic', () => {
    const root = tmpRoot();
    writeConfig(root, { isSynthetic: true });
    const res = run(root, ['--sample', '--config', 'private/import.json']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /fixtures\//);
    assert.ok(!fs.existsSync(path.join(root, 'fixtures', 'sample-data.json')), 'nothing written into fixtures/');
    assert.ok(!fs.existsSync(path.join(root, 'fixtures', 'sample-import-report.json')));
  });
  test('--sample refuses a synthetic config in fixtures/ that points at private exports', () => {
    const root = tmpRoot();
    writeConfig(root, { isSynthetic: true });
    fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
    fs.copyFileSync(path.join(root, 'private', 'import.json'), path.join(root, 'fixtures', 'sample-import.json'));
    const res = run(root, ['--sample']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /private\/raw\/chk\.csv/);
    assert.ok(!fs.existsSync(path.join(root, 'fixtures', 'sample-data.json')));
  });
  test('an unrecognised export asks for a mapping', () => {
    const root = tmpRoot();
    writeConfig(root);
    fs.writeFileSync(path.join(root, 'private', 'raw', 'chk.csv'), 'When,What,How much\n1,2,3\n');
    const res = run(root, []);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /"mapping"/);
    assert.match(res.stderr, /When/);
  });
  test('rejects unknown options', () => {
    const res = run(tmpRoot(), ['--bogus']);
    assert.equal(res.status, 2);
  });
});

// ====================================================================== hardening (adversarial review)

describe('hardening: loan accounts', () => {
  const LOAN = { id: 'auto', label: 'Auto loan', type: 'loan', scope: 'joint' };
  const WITH_LOAN = [CHECKING, CARD, LOAN];
  const run = list => I.pairTransfers(I.classify(list, {}, WITH_LOAN), WITH_LOAN);

  test('a payment received on a loan account is not a refund that reduces spending', () => {
    const [t] = I.classify([raw({ accountId: 'auto', description: 'PAYMENT RECEIVED - THANK YOU', amountCents: 30000 })], {}, WITH_LOAN);
    assert.notEqual(t.kind, 'spend');
    assert.equal(t.kind, 'transfer');
    assert.ok(!t.flags.includes('refund'));
    assert.match(t.categoryReason, /loan/i);
  });
  test('an unexplained credit on a loan account is never spending or income', () => {
    const [t] = I.classify([raw({ accountId: 'auto', description: 'PRINCIPAL ADJ', amountCents: 1234 })], {}, WITH_LOAN);
    assert.equal(t.kind, 'transfer');
    assert.ok(!t.flags.includes('refund'));
  });
  test('interest charged on a loan account is still a fee (money out)', () => {
    const [t] = I.classify([raw({ accountId: 'auto', description: 'INTEREST CHARGE', amountCents: -4000 })], {}, WITH_LOAN);
    assert.equal(t.kind, 'spend');
    assert.equal(t.category, 'Fees & interest');
  });
  test('a merchant refund credited to a loan account still reduces spending', () => {
    const [t] = I.classify([raw({ accountId: 'auto', description: 'LATE FEE REVERSAL', amountCents: 2500 })], {}, WITH_LOAN);
    assert.equal(t.kind, 'spend');
    assert.ok(t.flags.includes('refund'));
  });
  test('a checking debt payment pairs with the payment received on the loan', () => {
    const out = run([
      raw({ id: 'pay', accountId: 'chk', date: '2026-03-05', description: 'AUTO LOAN PMT', amountCents: -30000 }),
      raw({ id: 'rcv', accountId: 'auto', date: '2026-03-06', description: 'PAYMENT RECEIVED', amountCents: 30000 })
    ]);
    const [pay, rcv] = out;
    assert.equal(pay.pairId, 'rcv');
    assert.equal(rcv.pairId, 'pay');
    assert.equal(pay.kind, 'debt_payment', 'the paying side stays the debt payment');
    assert.equal(pay.subtype, 'loan');
    assert.equal(rcv.kind, 'transfer');
    assert.ok(!rcv.flags.includes('unpaired_transfer'));
    assert.ok(!pay.flags.includes('unpaired_transfer'));
  });
  test('a generic transfer that lands on a loan account counts as a debt payment', () => {
    const [pay, rcv] = run([
      raw({ id: 'pay', accountId: 'chk', date: '2026-03-05', description: 'ONLINE TRANSFER TO AUTO LN 01', amountCents: -30000 }),
      raw({ id: 'rcv', accountId: 'auto', date: '2026-03-05', description: 'ONLINE PAYMENT', amountCents: 30000 })
    ]);
    assert.equal(pay.pairId, 'rcv');
    assert.equal(pay.kind, 'debt_payment');
    assert.equal(pay.subtype, 'loan');
    assert.equal(rcv.kind, 'transfer');
    assert.match(pay.categoryReason, /Auto loan/);
  });
  test('an unpaired payment on the loan is flagged with a loan-specific note', () => {
    const [t] = run([raw({ accountId: 'auto', description: 'PAYMENT RECEIVED', amountCents: 30000 })]);
    assert.ok(t.flags.includes('unpaired_transfer'));
    assert.match(t.note, /loan/i);
  });
  test('loan-side activity does not change household spending (ledger)', { skip: !E.ledger }, () => {
    const { dataset } = I.buildDataset({
      datasetId: 'loan', generatedAt: '2026-04-01', accounts: WITH_LOAN,
      files: [
        { name: 'c.csv', accountId: 'chk', text: 'Date,Description,Amount\n03/05/2026,AUTO LOAN PMT,-300.00\n03/06/2026,SAMPLE GROCER,-50.00\n' },
        { name: 'l.csv', accountId: 'auto', text: 'Date,Description,Amount\n03/06/2026,PAYMENT RECEIVED,300.00\n' }
      ]
    });
    const s = E.ledger.summarize(E.ledger.applyEdits(dataset, {}));
    assert.equal(s.spendingCents, 5000);
    assert.equal(s.refundsCents, 0);
    assert.equal(s.debtPaymentsCents, 30000);
  });
  test('loan exports that print payments as negative balance changes are inferred and flipped', () => {
    const res = I.normalizeFile({
      name: 'loan.csv', account: LOAN,
      text: csv(['Date,Description,Amount', '01/05/2026,PAYMENT RECEIVED,-300.00', '01/31/2026,INTEREST CHARGE,40.00', '02/05/2026,PAYMENT RECEIVED,-300.00'])
    });
    assert.deepEqual(res.txns.map(t => t.amountCents), [30000, -4000, 30000]);
    assert.ok(res.warnings.some(w => /inferred/.test(w)));
  });
  test('loan exports already in account flow are kept', () => {
    const res = I.normalizeFile({
      name: 'loan.csv', account: LOAN,
      text: csv(['Date,Description,Amount', '01/05/2026,PAYMENT RECEIVED,300.00', '02/05/2026,PAYMENT RECEIVED,300.00'])
    });
    assert.deepEqual(res.txns.map(t => t.amountCents), [30000, 30000]);
  });
  test('chargesPositive in a loan mapping is honoured', () => {
    const res = I.normalizeFile({
      name: 'loan.csv', account: LOAN, mapping: { chargesPositive: true },
      text: csv(['Date,Description,Amount', '01/05/2026,PAYMENT RECEIVED,-300.00'])
    });
    assert.deepEqual(res.txns.map(t => t.amountCents), [30000]);
  });
});

describe('hardening: debt payments to a card that is in the data', () => {
  const STORE = { id: 'store', label: 'Store card', type: 'credit_card', scope: 'joint' };
  const ACC = [CHECKING, CARD, STORE];
  const RULES = { merchantRules: [{ match: 'STORE CARD PMT', sign: 'out', kind: 'debt_payment', subtype: 'store_card', reason: 'Household rule: store card' }] };

  test('a debt payment that lands on a card account in the data becomes a card payment on both sides', () => {
    const out = I.pairTransfers(I.classify([
      raw({ id: 'pay', accountId: 'chk', date: '2026-03-09', description: 'STORE CARD PMT', amountCents: -5500 }),
      raw({ id: 'rcv', accountId: 'store', date: '2026-03-10', description: 'PAYMENT - THANK YOU', amountCents: 5500 })
    ], RULES, ACC), ACC);
    assert.deepEqual(out.map(t => [t.kind, t.pairId]), [['card_payment', 'rcv'], ['card_payment', 'pay']]);
    assert.equal(out[0].subtype, null);
    assert.ok(out.every(t => !t.flags.includes('unpaired_transfer')));
    assert.match(out[0].categoryReason, /card payment/i);
  });
  test('without the card in the data, the debt payment rule stands and is not flagged', () => {
    const out = I.pairTransfers(I.classify([
      raw({ id: 'pay', accountId: 'chk', date: '2026-03-09', description: 'STORE CARD PMT', amountCents: -5500 })
    ], RULES, ACC), ACC);
    assert.equal(out[0].kind, 'debt_payment');
    assert.equal(out[0].subtype, 'store_card');
    assert.deepEqual(out[0].flags, []);
  });
  test('a debt payment never pairs with a deposit on a cash account', () => {
    const out = I.pairTransfers([
      txn({ id: 'pay', accountId: 'chk', date: '2026-03-09', kind: 'debt_payment', subtype: 'loan', amountCents: -5500 }),
      txn({ id: 'in', accountId: 'sav', date: '2026-03-09', kind: 'transfer', subtype: 'internal', amountCents: 5500 })
    ], ACCOUNTS);
    assert.equal(out[0].pairId, null);
    assert.equal(out[0].kind, 'debt_payment');
  });
});

describe('hardening: amounts and mappings', () => {
  test('absurdly large amounts are skipped with a reason instead of losing precision', () => {
    const res = I.normalizeFile({ name: 'big.csv', account: CHECKING, text: csv(['Date,Description,Amount', '01/02/2026,BIG,99999999999999999.99', '01/03/2026,OK,-5.00']) });
    assert.deepEqual(res.txns.map(t => t.amountCents), [-500]);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /amount/);
    for (const t of res.txns) assert.ok(Number.isSafeInteger(t.amountCents));
  });
  test('large debit/credit amounts are bounded the same way', () => {
    const res = I.normalizeFile({ name: 'big.csv', account: CHECKING, text: csv(['Date,Description,Debit,Credit', '01/02/2026,BIG,,"200,000,000.00"', '01/03/2026,OK,5.00,']) });
    assert.deepEqual(res.txns.map(t => t.amountCents), [-500]);
    assert.match(res.skipped[0].reason, /amount/);
  });
  test('a non-boolean chargesPositive is an error, never silently ignored', () => {
    const text = csv(['Date,Description,Amount', '01/02/2026,KROGER,10.00', '01/03/2026,PAYMENT - THANK YOU,-10.00']);
    assert.throws(() => I.normalizeFile({ name: 'c.csv', account: CARD, text, mapping: { chargesPositive: 'false' } }), /chargesPositive/);
    assert.throws(() => I.normalizeFile({ name: 'c.csv', account: CARD, text, mapping: { chargesPositive: 1 } }), E.ValidationError);
  });
});

describe('hardening: classification', () => {
  test('a debit-card purchase is spending, not a credit card payment', () => {
    const u = one({ description: 'DEBIT CARD PURCHASE SAMPLE SHOP', amountCents: -1200 });
    assert.equal(u.kind, 'spend');
  });
  test('genuine card payment wording is still a card payment', () => {
    assert.equal(one({ description: 'CREDIT CARD PAYMENT', amountCents: -5000 }).kind, 'card_payment');
    assert.equal(one({ description: 'SAMPLE BANK CARD AUTOPAY', amountCents: -5000 }).kind, 'card_payment');
  });
});

describe('hardening: unpaired card payments', () => {
  test('when a card is covered, the note still says the payment may be for a card not in the data', () => {
    const accounts = [CHECKING, { ...CARD, coverage: [{ start: '2026-01-01', end: '2026-06-30' }] }];
    const [t] = I.pairTransfers([txn({ id: 'a', accountId: 'chk', date: '2026-03-25', kind: 'card_payment', amountCents: -40000 })], accounts);
    assert.match(t.note, /confirm this pays a card/);
    assert.match(t.note, /not in the data/);
  });
  test('buildDataset warns about every unpaired card payment from a cash account', () => {
    const { report } = I.buildDataset({
      datasetId: 't', generatedAt: '2026-04-01', accounts: [CHECKING, CARD],
      files: [
        { name: 'c.csv', accountId: 'chk', coverageStart: '2026-03-01', coverageEnd: '2026-03-31', text: 'Date,Description,Amount\n03/25/2026,OTHER BANK CARD AUTOPAY,-400.00\n' },
        { name: 'k.csv', accountId: 'card', coverageStart: '2026-03-01', coverageEnd: '2026-03-31', text: 'Date,Description,Amount\n03/10/2026,KROGER,-20.00\n' }
      ]
    });
    assert.ok(report.warnings.some(w => /card payment/.test(w) && /\$400\.00/.test(w)), report.warnings.join('\n'));
  });
});

describe('hardening: reimbursement candidates', () => {
  const mark = list => I.markReimbursementCandidates(list, { accounts: ACCOUNTS });
  test('a charge already refunded on the same account is not offered as reimbursed', () => {
    const out = mark([
      txn({ id: 'buy', accountId: 'card', date: '2026-07-01', merchant: 'Sample Shop', description: 'SAMPLE SHOP', amountCents: -6000 }),
      txn({ id: 'ref', accountId: 'card', date: '2026-07-09', merchant: 'Sample Shop', description: 'SAMPLE SHOP', amountCents: 6000, flags: ['refund'] }),
      txn({ id: 'dep', accountId: 'chk', date: '2026-07-20', kind: 'income', subtype: 'other', category: 'Income', amountCents: 6000 })
    ]);
    assert.ok(out.every(t => !t.flags.includes('reimbursement_candidate')));
  });
  test('a refund of a different charge does not block the match', () => {
    const out = mark([
      txn({ id: 'buy1', accountId: 'card', date: '2026-07-01', merchant: 'Sample Shop', description: 'SAMPLE SHOP', amountCents: -6000 }),
      txn({ id: 'buy2', accountId: 'card', date: '2026-07-02', merchant: 'Sample Shop', description: 'SAMPLE SHOP', amountCents: -6000 }),
      txn({ id: 'ref', accountId: 'card', date: '2026-07-09', merchant: 'Sample Shop', description: 'SAMPLE SHOP', amountCents: 6000, flags: ['refund'] }),
      txn({ id: 'dep', accountId: 'chk', date: '2026-07-20', kind: 'income', subtype: 'other', category: 'Income', amountCents: 6000 })
    ]);
    const dep = out.find(t => t.id === 'dep');
    assert.equal(dep.matchIds.length, 1, 'one of the two charges is still unrefunded');
  });
});

describe('hardening: posted date columns', () => {
  test('a plain Date column next to a Posted Date column: the posted date is the transaction date', () => {
    const m = I.detectMapping(['Date', 'Posted Date', 'Description', 'Amount']);
    assert.equal(m.postDate, 'Posted Date');
    assert.equal(m.date, 'Date');
    const r = I.normalizeFile({ name: 'x.csv', account: CHECKING, text: csv(['Date,Posted Date,Description,Amount', '01/30/2026,02/02/2026,SAMPLE SHOP,-10.00']) });
    assert.equal(r.txns[0].date, '2026-02-02', 'counted in the month it posted');
    assert.match(r.txns[0].note, /Transaction date 2026-01-30/);
  });
  test('the same works with Debit/Credit columns', () => {
    const m = I.detectMapping(['Date', 'Description', 'Debit', 'Credit', 'Date Posted']);
    assert.equal(m.postDate, 'Date Posted');
  });
  test('a bare "Posted" status column is not mistaken for a posted date', () => {
    const m = I.detectMapping(['Date', 'Description', 'Amount', 'Posted']);
    assert.equal(m.postDate, undefined);
    const r = I.normalizeFile({ name: 'x.csv', account: CHECKING, text: csv(['Date,Description,Amount,Posted', '01/30/2026,SAMPLE SHOP,-10.00,Y']) });
    assert.equal(r.txns.length, 1);
  });
});

describe('hardening: pairing priority', () => {
  test('a card payment beats a same-amount debt payment for the same card credit', () => {
    for (const ids of [['a-card', 'z-debt'], ['z-card', 'a-debt']]) {
      const out = I.pairTransfers([
        txn({ id: ids[1], accountId: 'chk', date: '2026-03-25', kind: 'debt_payment', subtype: 'store_card', amountCents: -5500 }),
        txn({ id: ids[0], accountId: 'chk', date: '2026-03-25', kind: 'card_payment', amountCents: -5500 }),
        txn({ id: 'rcv', accountId: 'card', date: '2026-03-25', kind: 'card_payment', amountCents: 5500 })
      ], ACCOUNTS);
      const by = Object.fromEntries(out.map(t => [t.id, t]));
      assert.equal(by.rcv.pairId, ids[0], ids.join());
      assert.equal(by[ids[1]].kind, 'debt_payment');
      assert.equal(by[ids[1]].pairId, null);
    }
  });
});

describe('hardening: extra edge cases', () => {
  test('CSV: a quoted field after leading spaces, and line numbers after a multi-line field', () => {
    assert.deepEqual(I.parseCSV('a,  "b, c"\n'), [['a', 'b, c']]);
    const recs = I.parseCSVRecords('h1,h2\n"x\ny\nz",1\r\n2,3\n');
    assert.deepEqual(recs.map(r => r.line), [1, 2, 5]);
  });
  test('CSV: a lone CR inside quotes counts as a line break for row numbers', () => {
    const recs = I.parseCSVRecords('h\r"a\rb"\rc\r');
    assert.deepEqual(recs.map(r => r.line), [1, 2, 4]);
  });
  test('detectMapping: Discover-style "Trans. Date" and "Post Date"', () => {
    const m = I.detectMapping(['Trans. Date', 'Post Date', 'Description', 'Amount', 'Category']);
    assert.equal(m.profile, 'card_signed_amount');
    assert.equal(m.date, 'Trans. Date');
    assert.equal(m.postDate, 'Post Date');
    assert.equal(m.category, 'Category');
  });
  test('parseDate: compact, short and two-digit forms', () => {
    assert.equal(I.parseDate('20260310'), '2026-03-10');
    assert.equal(I.parseDate('3/5/26'), '2026-03-05');
    assert.equal(I.parseDate('2024-02-30', 'YMD'), null);
    assert.equal(I.parseDate('2/29/2028'), '2028-02-29');
    assert.equal(I.parseDate('2/29/2100'), null, '2100 is not a leap year');
    assert.equal(I.parseDate('31/12/2025', 'MDY'), null);
  });
  test('normalizeFile: parentheses, trailing minus and negative zero', () => {
    const r = I.normalizeFile({ name: 'p.csv', account: CHECKING, text: csv(['Date,Description,Amount', '01/02/2026,A,(12.50)', '01/03/2026,B,7.25-', '01/04/2026,C,-0.00', '01/05/2026,D,"$1,234.56"']) });
    assert.deepEqual(r.txns.map(t => t.amountCents), [-1250, -725, 123456]);
    assert.deepEqual(r.skipped, [{ row: 4, reason: 'zero amount' }]);
  });
  test('normalizeFile: amounts are exact integer cents (no float drift)', () => {
    const r = I.normalizeFile({ name: 'p.csv', account: CHECKING, text: csv(['Date,Description,Amount', '01/02/2026,A,-0.29', '01/03/2026,B,-1.005', '01/04/2026,C,-4.35']) });
    assert.deepEqual(r.txns.map(t => t.amountCents), [-29, -101, -435]);
    for (const t of r.txns) assert.ok(Number.isInteger(t.amountCents));
  });
  test('card sign inference: a tie between conventions is refused, not guessed', () => {
    const text = csv(['Date,Description,Amount', '01/02/2026,SHOP A,10.00', '01/03/2026,SHOP B,-10.00']);
    assert.throws(() => I.normalizeFile({ name: 't.csv', account: CARD, text }), err => err.code === 'SIGN_UNKNOWN');
  });
  test('card sign inference: purchases only, positive, are treated as charges', () => {
    const r = I.normalizeFile({ name: 't.csv', account: CARD, text: csv(['Date,Description,Amount', '01/02/2026,SHOP A,10.00', '01/03/2026,SHOP B,20.00']) });
    assert.deepEqual(r.txns.map(t => t.amountCents), [-1000, -2000]);
    assert.ok(r.warnings.some(w => /no payment rows to confirm/.test(w)));
  });
  test('normalizeFile does not mutate the mapping it is given', () => {
    const mapping = Object.freeze({ chargesPositive: true });
    const r = I.normalizeFile({ name: 't.csv', account: CARD, mapping, text: csv(['Date,Description,Amount', '01/02/2026,SHOP,10.00']) });
    assert.equal(r.txns[0].amountCents, -1000);
    assert.deepEqual(mapping, { chargesPositive: true });
  });
  test('dedupe: three overlapping files keep the largest single-file count', () => {
    const t = (file, row) => raw({ sourceFile: file, sourceRow: row, description: 'COFFEE', amountCents: -300 });
    const { kept, removed } = I.dedupe([t('a', 1), t('b', 1), t('b', 2), t('c', 1), t('c', 2), t('c', 3)]);
    assert.equal(kept.length, 3);
    assert.ok(kept.every(k => k.sourceFile === 'c'));
    assert.equal(removed.length, 3);
    assert.ok(removed.every(r => r.keptFile === 'c'));
  });
  test('dedupe: the same export listed twice imports each row once', () => {
    const text = csv(['Date,Description,Amount', '01/02/2026,COFFEE,-3.00', '01/02/2026,COFFEE,-3.00']);
    const { dataset, report } = I.buildDataset({ datasetId: 't', generatedAt: '2026-02-01', accounts: [CHECKING],
      files: [{ name: 'a.csv', accountId: 'chk', text }, { name: 'a-copy.csv', accountId: 'chk', text }] });
    assert.equal(dataset.transactions.length, 2);
    assert.equal(report.files[1].duplicatesRemoved, 2);
    for (const f of report.files) assert.equal(f.rows, f.imported + f.skipped + f.duplicatesRemoved);
  });
  test('buildDataset does not mutate its inputs', () => {
    const accounts = [{ ...CHECKING, coverage: [{ start: '2026-01-01', end: '2026-01-31' }] }];
    const files = [{ name: 'a.csv', accountId: 'chk', text: csv(['Date,Description,Amount', '02/02/2026,SHOP,-3.00']), coverageStart: '2026-02-01', coverageEnd: '2026-02-28' }];
    const rules = { merchantRules: [{ match: 'SHOP', category: 'Groceries', reason: 'test' }] };
    const before = JSON.stringify({ accounts, files, rules });
    const { dataset } = I.buildDataset({ datasetId: 't', generatedAt: '2026-03-01', accounts, files, rules });
    assert.equal(JSON.stringify({ accounts, files, rules }), before);
    assert.deepEqual(dataset.accounts[0].coverage, [{ start: '2026-01-01', end: '2026-02-28' }]);
  });
  test('buildDataset is deterministic regardless of row order within a day', () => {
    const a = csv(['Date,Description,Amount', '01/02/2026,B,-2.00', '01/02/2026,A,-1.00']);
    const b = csv(['Date,Description,Amount', '01/02/2026,A,-1.00', '01/02/2026,B,-2.00']);
    const ids = text => I.buildDataset({ datasetId: 't', generatedAt: '2026-02-01', accounts: [CHECKING], files: [{ name: 'x.csv', accountId: 'chk', text }] })
      .dataset.transactions.map(t => t.id);
    assert.deepEqual(ids(a), ids(b));
  });
  test('monthlySummary: a leap-year February needs 29 covered days to be full', () => {
    const rows = I.monthlySummary({ accounts: [{ id: 'chk', type: 'checking', coverage: [{ start: '2028-02-01', end: '2028-02-28' }] }], transactions: [] });
    assert.equal(rows[0].days, 29);
    assert.equal(rows[0].spendingCoverage, 'partial');
  });
  test('periodBreakdown: both ends of the period are inclusive', () => {
    const { dataset } = I.buildDataset({ datasetId: 't', generatedAt: '2026-04-01', accounts: [CHECKING],
      files: [{ name: 'a.csv', accountId: 'chk', text: csv(['Date,Description,Amount', '02/28/2026,A,-1.00', '03/01/2026,B,-2.00', '03/31/2026,C,-4.00', '04/01/2026,D,-8.00']) }] });
    assert.equal(I.periodBreakdown(dataset, '2026-03-01', '2026-03-31').spending.netCents, 600);
  });
  test('reimbursement: a deposit on the same day as the charge can match', () => {
    const out = I.markReimbursementCandidates([
      txn({ id: 'c', accountId: 'card', date: '2026-05-01', amountCents: -4000 }),
      txn({ id: 'd', accountId: 'chk', date: '2026-05-01', kind: 'income', subtype: 'other', amountCents: 4000 })
    ], { accounts: ACCOUNTS });
    assert.deepEqual(out[1].matchIds, ['c']);
  });
  test('pairing: a contribution paired with a personal account keeps its subtype', () => {
    const accounts = [...ACCOUNTS, { id: 'p2chk', label: 'Partner B checking', type: 'checking', scope: 'personal', ownerId: 'p2' }];
    const out = I.pairTransfers([
      txn({ id: 'o', accountId: 'p2chk', date: '2026-05-01', kind: 'transfer', subtype: 'internal', amountCents: -132500 }),
      txn({ id: 'i', accountId: 'chk', date: '2026-05-01', kind: 'transfer', subtype: 'contribution', amountCents: 132500 })
    ], accounts);
    assert.equal(out[1].pairId, 'o');
    assert.equal(out[1].subtype, 'contribution');
  });
  test('pairing: a withdrawal from savings is labelled savings on both sides', () => {
    const out = I.pairTransfers([
      txn({ id: 'o', accountId: 'sav', date: '2026-05-01', kind: 'transfer', subtype: 'savings', amountCents: -20000 }),
      txn({ id: 'i', accountId: 'chk', date: '2026-05-02', kind: 'transfer', subtype: 'internal', amountCents: 20000 })
    ], ACCOUNTS);
    assert.deepEqual(out.map(t => [t.pairId, t.subtype]), [['i', 'savings'], ['o', 'savings']]);
  });
});

test('buildDataset warns when a file contributes no transactions', () => {
  const accounts = [{ id: 'chk', label: 'Joint checking', type: 'checking', scope: 'joint', ownerId: null, paidInFull: false, coverage: [] }];
  const r = E.importer.buildDataset({ files: [{ name: 'empty.csv', text: 'Date,Description,Amount\n', accountId: 'chk' }], accounts, rules: null, datasetId: 'empty-test', isSynthetic: true, generatedAt: '2026-10-01' });
  assert.equal(r.dataset.transactions.length, 0);
  assert.ok(r.report.warnings.some(w => /empty\.csv.*no transactions were read/.test(w)), r.report.warnings.join(' | '));
  const r2 = E.importer.buildDataset({ files: [{ name: 'quiet.csv', text: 'Date,Description,Amount\n', accountId: 'chk', coverageStart: '2026-09-01', coverageEnd: '2026-09-30' }], accounts, rules: null, datasetId: 'empty-test', isSynthetic: true, generatedAt: '2026-10-01' });
  assert.ok(r2.report.warnings.some(w => /declared dates still count as covered/.test(w)));
  assert.deepEqual(r2.dataset.accounts[0].coverage, [{ start: '2026-09-01', end: '2026-09-30' }]);
});
