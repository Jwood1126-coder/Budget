// The reviewer's portable gate for three plan-model regressions (October 2026), kept as written:
// its fixtures, assertions and expected values are unchanged; only the checkout path is this
// repository's, and each check also runs as a node:test test. Every value and name is invented.
'use strict';
const test = require('node:test');
// No household data, private aliases, filesystem paths, or runtime dependencies.
// From a checkout: node /path/to/this-file.cjs .
// This is a desired-behavior gate: the current baseline fails all three cases.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..', '..');
for (const file of JSON.parse(fs.readFileSync(path.join(root,'src/manifest.json'),'utf8')).engine)
  require(path.join(root,'src',file));
const E = globalThis.BudgetEngine;
const coverage = [{start:'2025-01-01',end:'2025-12-31'}];
const transactions = [];
let seq = 0;
function add(month, category, dollars, kind='spend', merchant=category) {
  transactions.push({id:'synthetic-'+(++seq),accountId:'checking',
    date:month+'-15',amountCents:-100*dollars,kind,category,merchant,description:merchant});
}
for (let i=1;i<=12;i++) {
  const month='2025-'+String(i).padStart(2,'0');
  add(month,'Natural gas',100);
  add(month,'Electricity',50);
  add(month,'Groceries & meal kits',200);
  add(month,'Fuel & charging',60);
  if(i>=10)add(month,'Debt payment',80,'debt_payment','Example installment');
}
const dataset=E.ledger.normalizeDataset({schemaVersion:2,datasetId:'synthetic-model-regressions',
  isSynthetic:true,accounts:[{id:'checking',label:'Example checking',type:'checking',scope:'joint',coverage}],transactions});
const plan={people:[{id:'p1',name:'Person A'},{id:'p2',name:'Person B'}],incomes:[],
  bills:[{id:'example-debt',label:'Example installment',type:'debt',category:null,
    fundedFrom:'joint',monthlyCents:8000,status:'existing',startMonth:null,endMonth:null}],
  debts:[],targets:{'Energy (gas + electric, migrated)':15000},savings:[],personalSpending:[],
  balances:{jointCashCents:null,asOf:null,accounts:{},accountsAsOf:null,accountDates:{}}};
const tl=E.timeline.build({txns:E.ledger.applyEdits(dataset,{}),dataset,plan,
  settings:{baselineMonths:12},today:'2026-01-06'});
const topRows=tl.dials.flatMap(d=>(d.drill?.rows||[]).filter(r=>r.level===1&&r.included!==false));
const results=[];
function check(name, actual, expected, references) {
  let passed=true;
  try {assert.deepEqual(actual,expected);}catch{passed=false;}
  results.push({name,actual,expected,passed,references});
}
// Existing merged energy target is the SAME cost as its two components.
// Preserve the original input; prevent a second addition in the effective plan.
check('energy aggregate and constituents count once',
  topRows.filter(r=>['Natural gas','Electricity','Energy (gas + electric, migrated)'].includes(r.category))
    .reduce((sum,r)=>sum+r.planCents,0),15000,
  ['src/engine/timeline-spending.js:drillFor, budget-only rows and category totals']);
// Three observed $80 payments total $240; averaging over 12 months gives $20.
// A current explicit $80 recurring bill must not be suppressed as merely seen.
check('explicit current recurring debt beats diluted historical average',
  tl.months.find(m=>m.month==='2026-01').out.debt,8000,
  ['src/engine/timeline-dials.js:buildDials, otherBase/parts.debt',
   'src/engine/timeline-changes.js:billChanges, debtSeen/seen early exit']);
const necessities=['Natural gas','Electricity','Groceries & meal kits','Fuel & charging'];
check('imported essential-category names resolve without silent flexible fallback',
  necessities.map(category=>topRows.find(r=>r.category===category)?.group),
  necessities.map(()=>'essentials'),
  ['src/engine/timeline-spending.js:categoryGroup',
   'src/engine/categories.js:isEssential, exact-name lookup']);
console.log(JSON.stringify({synthetic:true,units:'integer cents',baselineMonths:tl.baseline.count,
  checks:results.length,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results},null,2));

for (const r of results) test(r.name, () => assert.deepEqual(r.actual, r.expected));
test('the gate passes all three checks', () => assert.deepEqual({ checks: results.length, passed: results.filter(r => r.passed).length }, { checks: 3, passed: 3 }));
