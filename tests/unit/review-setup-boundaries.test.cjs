// Synthetic regressions from the assistant's independent review (October 2026), kept as written;
// only the checkout path is this repository's. Every value and identity here is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const E = require(path.join(root, 'tests/load-engine.cjs')).loadEngine();
function opened() {
  const profile = { isSynthetic:true, household:{name:'Synthetic'}, plan:{ balances:{ accounts:{checking:123000,savings:456000}, accountDates:{checking:'2031-05-31',savings:'2031-05-31'} } } };
  return E.setupSync.apply(E.state.defaults(profile,{datasetId:'synthetic-anchors'}),profile).state;
}
test('partial account balances must preserve the omitted savings balance and date', () => {
  const before=opened();
  const after=E.setupSync.apply(before,{plan:{balances:{accounts:{checking:124000},accountDates:{checking:'2031-06-30'}}}});
  console.log('partial-accounts',JSON.stringify({before:before.plan.balances,after:after.state.plan.balances,notes:after.notes,report:after.report}));
  assert.equal(after.state.plan.balances.accounts.checking,124000);
  assert.equal(after.state.plan.balances.accounts.savings,456000);
  assert.equal(after.state.plan.balances.accountDates.savings,'2031-05-31');
});
test('empty nested accounts maps must not erase saved account balances', () => {
  const before=opened();
  const after=E.setupSync.apply(before,{plan:{balances:{accounts:{},accountDates:{}}}});
  console.log('empty-accounts',JSON.stringify({before:before.plan.balances,after:after.state.plan.balances,notes:after.notes}));
  assert.deepEqual(after.state.plan.balances,before.plan.balances);
});
test('omitting balances entirely preserves all account anchors',()=>{
  const before=opened();
  const after=E.setupSync.apply(before,{plan:{}});
  assert.deepEqual(after.state.plan.balances,before.plan.balances);
});
