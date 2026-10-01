'use strict';
(() => {
const D=JSON.parse(document.getElementById('budget-data').textContent),embedded=JSON.parse(document.getElementById('budget-state').textContent);const M=HouseholdBudgetMath;
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=(n,digits=2)=>n===null?'Not set':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:digits,maximumFractionDigits:digits}).format(n/100);
const monthLabel=m=>new Date(m+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'short',year:'numeric',timeZone:'UTC'});
const latestMonth=D.monthly.at(-1).month,currentYear=Number(latestMonth.slice(0,4)),priorYear=currentYear-1;
const quarterCats=Object.fromEntries(D.quarter.categories.map(c=>[c.category,c.totalCents/D.quarter.months.length]));
const defs=[
 {
  "key": "mortgage",
  "label": "Mortgage",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": true,
  "cat": "Mortgage"
 },
 {
  "key": "energy",
  "label": "Electricity + natural gas",
  "target": 180,
  "basis": "Fictitious demo allowance; replace before planning",
  "essential": true,
  "observed": null
 },
 {
  "key": "municipal",
  "label": "Municipal payments",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": true,
  "cat": "Municipal payments"
 },
 {
  "key": "groceries",
  "label": "Groceries & meal kits",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": true,
  "cat": "Groceries & meal kits"
 },
 {
  "key": "dining",
  "label": "Dining & drinks",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": false,
  "cat": "Dining & drinks"
 },
 {
  "key": "shopping",
  "label": "Shopping & mixed retail",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": false,
  "cat": "Shopping & mixed retail"
 },
 {
  "key": "fuel",
  "label": "Fuel & charging",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": true,
  "cat": "Fuel & charging"
 },
 {
  "key": "vehicle",
  "label": "Vehicle care & registration",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": false,
  "cat": "Vehicle care & registration"
 },
 {
  "key": "pets",
  "label": "Pets",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": true,
  "cat": "Pets"
 },
 {
  "key": "home",
  "label": "Home purchases & maintenance",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": false,
  "cat": "Home & hardware"
 },
 {
  "key": "medical",
  "label": "Medical & pharmacy",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": true,
  "cat": "Medical & pharmacy"
 },
 {
  "key": "dental",
  "label": "Dental reserve",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": true,
  "cat": "Dental"
 },
 {
  "key": "travel",
  "label": "Travel & parking",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": false,
  "cat": "Travel & parking"
 },
 {
  "key": "subscriptions",
  "label": "Apps & subscriptions",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": false,
  "cat": "Apps & subscriptions"
 },
 {
  "key": "entertainment",
  "label": "Entertainment",
  "target": null,
  "basis": "Historical category average; choose your own target",
  "essential": false,
  "cat": "Entertainment"
 },
 {
  "key": "phoneInsurance",
  "label": "Phone, internet & other insurance",
  "target": null,
  "basis": "Fictitious demo allowance; replace before planning",
  "essential": true,
  "observed": null
 },
 {
  "key": "cardFee",
  "label": "Annual card-fee reserve",
  "target": 10,
  "basis": "Fictitious demo allowance; replace before planning",
  "essential": false,
  "observed": null
 },
 {
  "key": "storeCard",
  "label": "Store-card debt payment",
  "target": 40,
  "basis": "Fictitious demo allowance; replace before planning",
  "essential": true,
  "observed": null
 },
 {
  "key": "vehicleA",
  "label": "Person A vehicle payment",
  "target": 180,
  "basis": "Fictitious demo allowance; replace before planning",
  "essential": true,
  "observed": null,
  "personal": true
 },
 {
  "key": "student",
  "label": "Education-loan payment",
  "target": 220,
  "basis": "Fictitious demo allowance; replace before planning",
  "essential": true,
  "observed": null,
  "personal": true
 },
 {
  "key": "vehicleB",
  "label": "Person B vehicle payment",
  "target": 300,
  "basis": "Fictitious demo allowance; replace before planning",
  "essential": true,
  "observed": null,
  "personBPersonal": true
 },
 {
  "key": "lifeInsurance",
  "label": "Life-insurance allowance",
  "target": null,
  "basis": "Fictitious demo allowance; replace before planning",
  "essential": true,
  "observed": null
 }
];
for(const name of ['Vision','Uncategorized / review'])if(quarterCats[name])defs.push({key:name==='Vision'?'vision':'unclassified',label:name,cat:name,target:null,basis:'Audited historical amount; review before setting a future target',essential:false,auditedNewCategory:true});
defs.forEach(d=>{if(d.cat){d.observed=Math.round(quarterCats[d.cat]??0);d.target=d.key==='dental'?null:d.observed/100;}});
const forecastDefaults={start:M.monthFromIndex(M.monthIndex(latestMonth)+1),months:36,babyStart:'',childcareStart:'',leaveStart:'',leaveMonths:0,incomeGrowth:0,expenseGrowth:0,cashYield:0,oneoffs:[{label:'Home repair',amount:null,month:''},{label:'Celebration',amount:null,month:''},{label:'Family setup',amount:null,month:''}],debtEnds:{vehicleA:'',student:'',vehicleB:'',storeCard:''}};
// Every starting amount is fictitious. Blanks demonstrate explicit unknown-input handling.
const defaults={version:4,forecast:forecastDefaults,vehicleBFunding:'unknown',healthMode:'separate',healthMigrationNotice:false,auditBudgetNotice:false,planMode:'household',personAPay:3000,personAFrequency:'',personBPay:null,personBFrequency:'',personAAllocation:350,personBContribution:2000,incomeBasis:'regular',otherIncome:0,otherExpenses:null,childcare:null,babyCosts:null,leaveReduction:0,homeFund:null,emergencyFund:null,anniversaryFund:null,otherSavings:0,currentCash:null,cashGoal:null,targets:Object.fromEntries(defs.map(d=>[d.key,d.target])),adjustments:{airfare:false,business:false},checks:{},tab:'overview'};
const key='sample-household-budget-v1-'+(embedded.copyId||'hosted');let S=structuredClone(defaults),storageAvailable=true;
function mergeState(raw){if(!raw||typeof raw!=='object')return;const previousVersion=raw.version; if(['unknown','personal','joint'].includes(raw.vehicleBFunding))S.vehicleBFunding=raw.vehicleBFunding;mergeForecast(raw.forecast);const legacy=raw.version<3;raw=M.healthMigration(raw);if(legacy){S.auditBudgetNotice=true;defs.filter(d=>d.auditedNewCategory).forEach(d=>S.targets[d.key]=null);}else if(typeof raw.auditBudgetNotice==='boolean')S.auditBudgetNotice=raw.auditBudgetNotice;if(['combined','separate'].includes(raw.healthMode))S.healthMode=raw.healthMode;if(typeof raw.healthMigrationNotice==='boolean')S.healthMigrationNotice=raw.healthMigrationNotice;for(const k of M.numericKeys){if(raw[k]===null||raw[k]===''){S[k]=null;continue;}if(typeof raw[k]==='number'&&Number.isFinite(raw[k])&&raw[k]>=0&&raw[k]<=1e8)S[k]=raw[k];}['personAFrequency','personBFrequency'].forEach(k=>{if(['','weekly','biweekly','semimonthly','monthly'].includes(raw[k]))S[k]=raw[k];});if(['household','joint'].includes(raw.planMode))S.planMode=raw.planMode;if(['regular','average'].includes(raw.incomeBasis))S.incomeBasis=raw.incomeBasis;if(['overview','spending','plan','future','review'].includes(raw.tab))S.tab=raw.tab;for(const d of defs){const val=raw.targets?.[d.key];if(val===null||(typeof val==='number'&&Number.isFinite(val)&&val>=0&&val<=1e8))S.targets[d.key]=val;}for(const k of ['airfare','business'])if(typeof raw.adjustments?.[k]==='boolean')S.adjustments[k]=raw.adjustments[k];if(previousVersion<4)S.auditBudgetNotice=true;if(raw.checks&&typeof raw.checks==='object')for(const k of Object.keys(raw.checks))if(typeof raw.checks[k]==='boolean')S.checks[k]=raw.checks[k];}
mergeState(embedded.state);try{const saved=localStorage.getItem(key);if(saved)mergeState(JSON.parse(saved));}catch{storageAvailable=false;}
let page=0;const pageSize=30;let currentTab=S.tab;
function persist(){try{localStorage.setItem(key,JSON.stringify(S));$('storageStatus').textContent='Local changes saved';}catch{storageAvailable=false;$('storageStatus').textContent='Browser saving unavailable. Download a copy to keep changes.';}}
function toast(s){$('toast').textContent=s;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5500);}
function tab(name,focus=false){if(!['overview','spending','plan','future','review'].includes(name))return;currentTab=name;S.tab=name;if(name==='spending')spending();document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==name);document.querySelectorAll('.nav-button').forEach(b=>{const on=b.dataset.tab===name;b.classList.toggle('active',on);on?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current');});if(focus){window.scrollTo({top:0,behavior:'instant'});$('main').focus({preventScroll:true});}persist();}
function bars(id,cats,divisor=1,limit=0){let data=cats.filter(c=>c.totalCents!==0);if(limit&&data.length>limit){const rest=data.slice(limit).reduce((a,b)=>a+b.totalCents,0);data=[...data.slice(0,limit),{category:'All other categories',totalCents:rest}];}const max=Math.max(...data.map(c=>Math.abs(c.totalCents)),1);$(id).innerHTML=data.length?data.map(c=>`<div class="bar-row"><div class="bar-top">${c.category==='All other categories'?'<span>All other categories</span>':`<button class="bar-category-button" data-open-category="${esc(c.category)}" data-from-chart="${id}" aria-label="View ${esc(c.category)} transactions">${esc(c.category)}</button>`}<strong>${money(Math.round(c.totalCents/divisor))}</strong></div><div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${Math.max(0,Math.min(100,Math.abs(c.totalCents)/max*100))}%"></div></div></div>`).join(''):'<p class="empty">No spending matches these filters.</p>';}
function overview(){const dental=D.transactions.filter(r=>r.kind==='spend'&&r.category==='Dental'&&r.date>=D.defaultPeriod.start&&r.date<=D.defaultPeriod.end);const episode=dental.filter(r=>r.flags.includes('nonroutine_dental_episode'));const dentalTotal=dental.reduce((a,r)=>a+r.amountCents,0),episodeTotal=episode.reduce((a,r)=>a+r.amountCents,0);$('dentalEpisodeSummary').textContent=money(dentalTotal)+' in '+dental.length+' dated charges. These amounts were already counted in actual spending; Dental is now its own category.';$('dentalReference').innerHTML='<div><span>Recorded quarter average</span><strong>'+money(D.quarter.spendingCents/D.quarter.months.length)+'</strong></div><div><span>Unusual episode, total</span><strong>'+money(episodeTotal)+'</strong></div><div><span>Quarter average without this episode</span><strong>'+money(Math.round((D.quarter.spendingCents-episodeTotal)/D.quarter.months.length))+'</strong></div><p class="caption">An isolated comparison, not a verified recurring rate. Other irregular costs and future dental care still need a plan. Actual totals remain unchanged.</p>';const last=M.totals(D.transactions,{start:priorYear+'-01-01',end:priorYear+D.defaultPeriod.end.slice(4)}).spending;const now=M.totals(D.transactions,{start:currentYear+'-01-01',end:D.defaultPeriod.end}).spending;$('historyComparison').innerHTML='<strong>'+money(now)+'</strong><span>'+(last>0?((now/last-1)*100).toFixed(1)+'% change from ':'No percentage baseline; prior total ')+money(last)+' in the comparable prior-year period</span>';const q=M.totals(D.transactions,D.defaultPeriod);$('observedAverage').textContent=money(q.spending/D.quarter.months.length);bars('overviewCategories',q.categories,D.quarter.months.length,6);const months=D.monthly.filter(x=>D.quarter.months.includes(x.month));const max=Math.max(...months.map(x=>x.spendingCents));$('overviewTrend').innerHTML=months.map(m=>`<div class="trend-item"><span class="trend-value">${money(m.spendingCents,0)}</span><div class="trend-column" style="height:${m.spendingCents/max*125}px" aria-hidden="true"></div><span class="trend-month">${monthLabel(m.month)}</span></div>`).join('');}
function period(){const p=$('period').value;if(p==='quarter')return{...D.defaultPeriod,months:D.quarter.months.length,label:'Baseline period'};if(p==='ytd')return{start:currentYear+'-01-01',end:D.defaultPeriod.end,months:Number(D.defaultPeriod.end.slice(5,7)),label:'Year to date'};if(p==='previousYear')return{start:priorYear+'-01-01',end:priorYear+'-12-31',months:12,label:String(priorYear)};if(p==='all')return{start:D.monthly[0].month+'-01',end:latestMonth+'-31',months:D.monthly.length,label:'All available history'};return{start:p+'-01',end:p+'-31',months:1,label:monthLabel(p)};}
function fillCategories(){const basis=$('categoryBasis').value;const keep=$('category').value;const cats=[...new Set(D.transactions.filter(r=>r.kind==='spend').map(r=>r[basis]))].sort();$('category').innerHTML='<option value="all">All categories</option>'+cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');if(cats.includes(keep))$('category').value=keep;}
function spending(){const p=period(),kind=$('rowKind').value,basis=$('categoryBasis').value;const options={...p,category:$('category').value,basis,query:$('search').value.trim(),review:$('reviewFilter').value,adjustments:S.adjustments};const t=M.totals(D.transactions,options);const raw=M.totals(D.transactions,{...p});const spendView=kind==='spend';let rows=t.rows.filter(r=>kind==='all'||(kind==='excluded'?r.kind!=='spend'&&r.kind!=='income':r.kind===kind)).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));const count=rows.length;const unresolved=rows.filter(r=>M.matchesReview(r,'unresolved')).length,changed=rows.filter(r=>M.matchesReview(r,'changed')).length;$('auditSummary').innerHTML='<span><strong>'+count.toLocaleString()+'</strong> records in view</span><span><strong>'+unresolved.toLocaleString()+'</strong> need item / purpose review</span><span><strong>'+changed.toLocaleString()+'</strong> category corrections</span><span>Original bank categories stay visible</span>';const dentalView=$('category').value==='Dental'||['dental','episode'].includes($('reviewFilter').value);$('categoryContext').hidden=!dentalView;$('categoryContext').innerHTML=dentalView?'<strong>Dental is included in actual spending.</strong>The fixture includes an invented nonroutine example. Provider labels and amounts are synthetic; no real medical history is included. A future dental reserve is a separate budget decision.':'';const pages=Math.max(1,Math.ceil(count/pageSize));page=Math.min(page,pages-1);$('rowCount').textContent=count.toLocaleString()+' records';
 if(spendView){$('spendingSummary').innerHTML=`<strong>${money(t.adjusted)}</strong><span>${esc(p.label)} · ${money(Math.round(t.adjusted/p.months))}/month across ${p.months} month${p.months===1?'':'s'}${S.adjustments.airfare||S.adjustments.business?' · Adjusted scenario':''}</span>`;bars('spendingCategories',t.categories);}else if(kind==='income'){const payroll=rows.filter(r=>r.incomeType==='observed_payroll_deposit').reduce((s,r)=>s+r.amountCents,0);$('spendingSummary').innerHTML=`<strong>${money(payroll)}</strong><span>Observed payroll deposits · not full household take-home</span>`;$('spendingCategories').innerHTML='<p class="empty">These are deposits observed in supplied accounts. They may represent only part of household income. Transfers and unknown credits are not salary.</p>';}else{$('spendingSummary').innerHTML=`<strong>${count.toLocaleString()} items</strong><span>Both sides of matched transfers may appear. No combined total is shown.</span>`;$('spendingCategories').innerHTML='<p class="empty">Choose “Spending only” for category totals. Repayments and transfers are not added to purchases.</p>';}
 if(D.monthly.some(m=>!m.hasMainCardCoverage&&m.month>=p.start.slice(0,7)&&m.month<=p.end.slice(0,7)))$('spendingSummary').innerHTML+='<span class="badge warn">Selected period includes incomplete coverage</span>';
 $('grossSpend').textContent=money(t.spending);$('adjustmentAmount').textContent=money(-t.adjustment);$('netSpend').textContent=money(t.adjusted);
 for(const k of ['airfare','business']){const rows=raw.rows.filter(r=>r.kind==='spend'&&r.flags.includes(k==='airfare'?'reimbursement_candidate':'business_candidate'));const total=rows.reduce((a,r)=>a+r.amountCents,0);$('adjust-'+k+'-amount').textContent=money(total)+' in the selected period';}
 $('transactionRows').innerHTML=count?rows.slice(page*pageSize,(page+1)*pageSize).map(r=>{const adjusted=r.kind==='spend'&&((S.adjustments.airfare&&r.flags.includes('reimbursement_candidate'))||(S.adjustments.business&&r.flags.includes('business_candidate')));const status=adjusted?'Scenario exclusion':r.needsCategoryReview?'Category unresolved':M.matchesReview(r,'unresolved')?'Items / use to review':'Category supported';const source=D.sources.find(s=>s.id===r.source)?.label||r.source;const isSpend=r.kind==='spend';const amount=isSpend?r.amountCents:(r.direction==='outbound'?-r.amountCents:r.amountCents);return `<tr${r.category==='Dental'?' class="dental-row"':''}><td>${esc(r.date)}</td><td><strong>${esc(r.merchant)}</strong><small>${esc(source)}</small>${r.note||r.classificationEvidence?`<details><summary>Why this label</summary><p>${esc(r.classificationEvidence?.summary||r.note)}</p>${r.classificationEvidence?`<p>Category evidence: ${esc(r.classificationEvidence.basis)} · Confidence: ${esc(r.classificationEvidence.confidence)}</p>`:''}<p>Source category: ${esc(r.sourceCategory||'Not supplied')} · Type: ${esc(r.kind.replaceAll('_',' '))}${r.matchingTransactionIds?.length?' · Matched counterpart found':''}</p></details>`:''}</td><td>${esc(r.category)}${r.flags.includes('nonroutine_dental_episode')?'<span class="episode-tag">Nonroutine episode</span>':''}<small>Bank: ${esc(r.sourceCategory||'Uncategorized')}</small></td><td><span class="badge ${M.matchesReview(r,'unresolved')||adjusted?'warn':''}">${status}</span>${isSpend&&r.amountCents<0?'<small>Refund / credit</small>':''}</td><td class="num ${amount<0&&isSpend?'refund':''}">${money(amount)}${!isSpend?`<small>${esc(r.direction||r.kind)}</small>`:''}</td></tr>`;}).join(''):'<tr><td colspan="5"><p class="empty">No records match. Try another period, category, or search.</p></td></tr>';
 renderComparison();
 renderDrill(t.rows.filter(r=>r.kind==='spend'&&!((S.adjustments.airfare&&r.flags.includes('reimbursement_candidate'))||(S.adjustments.business&&r.flags.includes('business_candidate')))),basis);
 $('pageInfo').textContent=`Page ${page+1} of ${pages}`;$('prevPage').disabled=page===0;$('nextPage').disabled=page>=pages-1;
}
function renderBudgetInputs(){const whole=S.planMode==='household';$('budgetInputs').innerHTML=defs.filter(d=>(whole||!d.personal)&&(!d.personBPersonal||whole||S.vehicleBFunding==='joint')&&!(d.key==='dental'&&S.healthMode==='combined')).map(d=>`<div class="budget-row"><div><label for="target-${d.key}">${esc(d.key==='medical'&&S.healthMode==='combined'?'Health reserve (medical + dental)':d.label)}</label><small>${d.essential?'Core / commitment':'Flexible / review'} · ${esc(d.key==='medical'&&S.healthMode==='combined'?'Your saved combined amount, unchanged until you choose a split':d.basis)}</small></div><span>${d.observed===null?'Not known':money(d.key==='medical'&&S.healthMode==='combined'?Math.round((quarterCats['Medical & pharmacy']||0)+(quarterCats['Dental']||0)):d.observed,0)}</span><input id="target-${d.key}" data-target="${d.key}" type="number" min="0" max="100000000" step="0.01" value="${S.targets[d.key]??''}" placeholder="Set target" aria-label="${esc(d.key==='medical'&&S.healthMode==='combined'?'Health reserve (medical + dental)':d.label)} monthly target"></div>`).join('');document.querySelector('.budget-row.locked').hidden=!whole;}
function syncInputs(){document.querySelectorAll('[data-plan]').forEach(el=>{el.value=S[el.dataset.plan]??'';if(el.tagName==='INPUT')el.setCustomValidity('');el.removeAttribute('aria-invalid');});renderBudgetInputs();refreshValidation();}
function plan(){$('auditBudgetNotice').hidden=!S.auditBudgetNotice;$('healthMigration').hidden=S.healthMode!=='combined';$('healthMigrationNote').textContent='Your saved '+(S.targets.medical===null?'unset':money(M.cents(S.targets.medical)))+' monthly health target still combines medical and dental. No saved amounts were replaced. Split it only after deciding what belongs in each reserve.';$('splitHealthBudget').disabled=S.targets.medical===null;const c=M.calculate(S,defs),isJoint=!c.whole;const wholeForOverview=M.calculate({...S,planMode:'household'},defs);$('overviewIncome').textContent=wholeForOverview.income===null?'Needs input':money(wholeForOverview.income,0);$('overviewIncomeNote').textContent=wholeForOverview.income===null?'Confirm pay frequency and Person B’s take-home to finish the plan':'Calculated from your scenario inputs; not independently verified household income';$('personalAllowance').textContent=c.allowance===null?'Needs frequency':money(c.allowance);$('planModeBadge').textContent=isJoint?'Joint-account scenario':'Whole-household view';$('modeExplanation').textContent=isJoint?'Joint view counts Person A’s pay after the personal allocation plus Person B’s provisional contribution. Personal debt targets, and personal spending stay outside this joint plan.':'Whole-household view counts full net pay, personal debt targets, and the remaining personal allowance once. Person B’s contribution transfer is not added to her pay.';
 $('allocationSummary').innerHTML=c.allocation===null?'<span>Choose Person A’s pay frequency to calculate the monthly allocation. The allocation pays the personal debt targets first; any remainder is counted once as personal spending.</span>':`<strong>${money(c.allocation)}</strong><span>Personal allocation · ${money(c.personalDebt)} vehicle + education loans · ${money(c.allowance)} left${c.allocationDeficit?' · '+money(c.allocationDeficit)+' debt exceeds allocation':''}</span>`;
 $('compactPlan').innerHTML='<strong>'+(c.currentRoom===null?'Needs income':money(c.currentRoom))+'</strong><span>'+(c.currentRoom===null?'Enter the missing pay details below':'Unassigned before missing costs')+'</span>';$('monthlyRoom').textContent=c.currentRoom===null?'Needs income':money(c.currentRoom);$('monthlyRoom').className='balance-number'+(c.currentRoom!==null&&c.currentRoom<0?' negative':'');$('roomExplanation').textContent=c.currentRoom===null?'Fill in the missing income fields. Expense and savings totals remain visible below.':c.currentRoom<0?'Current targets exceed the income entered, before any blank costs. Adjust the scenario before committing.':'Unassigned in the current scenario, before blank or missing costs. This is not yet an affordability green light.';
 const line=(label,val)=>`<div><span>${esc(label)}</span><strong>${val===null?'Not complete':money(val)}</strong></div>`;
 $('planBreakdown').innerHTML=line(isJoint?'Joint funding':'Household take-home',c.income)+line('Spending + debt targets',c.expense)+line('Savings allocations',c.savings)+line('Current unassigned',c.currentRoom)+line('Childcare + baby costs entered',c.baby)+line('Leave income reduction entered',c.reduction)+line('Baby + leave what-if, before timing',c.futureRoom);
 let projection='';if(c.cash!==null&&c.goal!==null){if(c.monthsToGoal===0)projection='<strong>Cash goal entered is covered</strong><p>Based on the balance you entered. Confirm it is available after bills.</p>';else if(c.monthsToGoal!==null)projection=`<strong>${c.monthsToGoal} months to the cash goal</strong><p>${money(c.goal-c.cash)} remaining at ${money(c.contribution)}/month. Mechanical projection only; income must support the contributions.</p>`;else projection='<p>Enter a cash-cushion monthly contribution to estimate time to the goal.</p>';}else projection='<p>Enter current available cash and your cushion goal to see a savings timeline. Current balances are not in the exports.</p>';$('cashProjection').innerHTML=projection;
 let warnings=[];if(S.healthMode==='combined')warnings.push('Your medical + dental target is still combined and may include the unusual dental episode. Use the split control to separate it without changing the total.');else warnings.push('The Dental’s observed average is a historical comparison, not a recurring bill. Its future reserve starts unset. Review your target against future dental needs; the unusual episode remains in actual spending.');if(c.usesIllustrativeTwoChecks)warnings.push('Illustrative joint month: two checks for Person A are assumed only for this scenario. The actual pay frequency remains unconfirmed.');if(isJoint)warnings.push('Person B’s joint contribution is entered as '+money(M.cents(S.personBContribution))+'/month. This is a fictitious contribution input, not full take-home pay.');if(c.incomplete.length)warnings.push('Still to set or verify: '+[...new Set(c.incomplete)].join('; ')+'.');if(c.allocationDeficit)warnings.push('The personal allocation falls '+money(c.allocationDeficit)+' short of the entered vehicle and education-loan payments.');if(S.personAAllocation>S.personAPay)warnings.push('Personal allocation cannot exceed net pay per check.');if(S.incomeBasis==='average')warnings.push('Annual monthly averages include extra-paycheck months. Ordinary months may have less cash.');if(c.futureRoom!==null&&c.futureRoom<0)warnings.push('The untimed baby + leave what-if is short by '+money(-c.futureRoom)+' per month, before missing costs.');$('planWarnings').innerHTML=warnings.map(w=>`<p class="warning">${esc(w)}</p>`).join('');forecast();
}
const checklist=[
 {id:'income',label:'Confirm income and pay schedules',detail:'Replace the fictitious Person A and Person B inputs. Transfers are not extra household salary.'},
 {id:'airfare',label:'Review reimbursement candidates',detail:'The fixture includes an invented travel expense. Keep optional offsets off until reimbursement is confirmed.'},
 {id:'mixed',label:'Choose flexible spending targets',detail:'Review groceries, dining and mixed-retailer contents before choosing forward targets.'},
 {id:'subscriptions',label:'Review recurring candidates',detail:'A repeated merchant is not proof of an active subscription. Review contracts and receipts.'},
 {id:'baby',label:'Price future care and leave',detail:'Enter your own schedule and costs. The demonstration childcare button uses a fictitious allowance.'},
 {id:'insurance',label:'Review missing commitments',detail:'Enter verified costs and coverage where appropriate. Sample allowances are not quotes.'},
 {id:'repairs',label:'Set savings goals and one-off timing',detail:'Keep monthly reserves separate from eventual spending so cash withdrawals count only once.'},
 {id:'balances',label:'Verify available cash and debt terms',detail:'Transaction history is not a balance sheet. Confirm cash, debt balances, rates and final payment dates independently.'}
];
function review(){const unresolvedGroups={};for(const r of D.transactions.filter(r=>r.kind==='spend'&&r.needsCategoryReview)){const g=unresolvedGroups[r.merchant]??={merchant:r.merchant,count:0,total:0};g.count++;g.total+=r.amountCents;}const unresolvedList=Object.values(unresolvedGroups).sort((a,b)=>b.total-a.total);$('unresolvedMerchantCount').textContent=unresolvedList.length+' merchant labels · all available history';$('unresolvedMerchants').innerHTML=unresolvedList.length?unresolvedList.map(g=>`<div><button class="text-button" data-merchant-review="${esc(g.merchant)}">${esc(g.merchant)}</button><span>${g.count} records · ${money(g.total)}</span></div>`).join(''):'<p class="caption">No merchant-level category gaps are flagged. Receipt contents and household/work purpose may still need review.</p>';$('classificationAuditNotes').innerHTML='<div class="audit-note"><strong>Classification is separate from amount verification.</strong><p>The synthetic fixture demonstrates separate source labels, reviewed categories and evidence fields. Its examples do not describe a real person or transaction. Ambiguous retailer contents, work use, and reimbursements remain unresolved rather than being silently treated as facts.</p><button class="text-button" data-open-unresolved>Open items needing review</button></div>';
 $('checklist').innerHTML=checklist.map(c=>`<div class="checklist-row ${S.checks[c.id]?'completed':''}"><input type="checkbox" id="check-${c.id}" data-check="${c.id}" ${S.checks[c.id]?'checked':''}><div><label for="check-${c.id}">${esc(c.label)}</label><p>${esc(c.detail)}</p>${c.url?`<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.link)}</a>`:''}</div></div>`).join('');
 $('coverageNotes').innerHTML=D.sources.map(s=>`<div class="coverage-item"><strong>${esc(s.label)}</strong><span>${esc(s.start)} to ${esc(s.end)} · ${s.rowCount.toLocaleString()} records · ${esc(s.dateBasis)}</span></div>`).join('')+'<p class="caption">The earliest fixture months demonstrate incomplete card coverage. Coverage flags control comparison eligibility. Replace all sample records before using private financial data.</p>';
 const quarterRows=D.transactions.filter(r=>r.date>=D.defaultPeriod.start&&r.date<=D.defaultPeriod.end);const sumKind=k=>quarterRows.filter(r=>r.kind===k).reduce((a,r)=>a+r.amountCents,0);const sumFlag=f=>quarterRows.filter(r=>r.kind==='spend'&&r.flags.includes(f)).reduce((a,r)=>a+r.amountCents,0);const ex=[[money(sumKind('card_payment')),'Card repayments excluded from spending'],[money(sumKind('transfer')),'Transfers shown separately; counterpart rows are not net spending'],[money(sumKind('investment')),'Investment funding shown separately'],[money(sumKind('debt_payment')),'Debt servicing belongs in editable plan targets'],[money(sumFlag('reimbursement_candidate')),'Unconfirmed reimbursement candidates'],[money(sumFlag('nonroutine_dental_episode')),'Fictitious nonroutine example included in actuals']];$('exclusionSummary').innerHTML=ex.map(([a,b])=>`<div><strong>${a}</strong><span>${b}</span></div>`).join('');
 $('recurringRows').innerHTML=D.recurring.map(r=>`<tr><td><strong>${esc(r.label)}</strong><small>${esc(r.basis)}</small></td><td><span class="badge ${r.status==='recurring_candidate'?'warn':''}">${esc(r.status.replaceAll('_',' '))}</span></td><td class="num">${money(r.monthlyCents)}</td></tr>`).join('');
}
function download(){const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script').forEach(el=>{if(!['budget-data','budget-state','budget-app'].includes(el.id))el.remove();});clone.querySelectorAll('iframe').forEach(el=>el.remove());clone.querySelector('#budget-state').textContent=JSON.stringify({copyId:'copy-'+Date.now(),state:S}).replace(/</g,'\\u003c');clone.querySelector('#toast').hidden=true;clone.querySelector('#resetDialog').removeAttribute('open');clone.querySelector('#healthSplitDialog').removeAttribute('open');const html='<!doctype html>\n'+clone.outerHTML;const blob=new Blob([html],{type:'text/html;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='Sample-household-budget-private.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);toast('Private copy downloaded. It includes financial records and this scenario. Share it only with someone you choose.');}
function refreshValidation(){const any=document.querySelectorAll('[aria-invalid="true"]').length>0;const fi=document.querySelectorAll('[data-forecast-invalid]').length>0;$('inputError').hidden=!any;$('forecastInputError').hidden=!(any||fi);$('download').disabled=any||fi;$('printPlan').disabled=any||fi;}
function validateInput(el){const n=el.value===''?null:Number(el.value);const valid=!el.validity.badInput&&(n===null||(Number.isFinite(n)&&n>=0&&n<=1e8));el.setCustomValidity(valid?'':'Enter an amount from $0 to $100,000,000.');valid?el.removeAttribute('aria-invalid'):el.setAttribute('aria-invalid','true');refreshValidation();return valid;}
function updateNumeric(key,value){const n=value===''?null:Number(value);if(n!==null&&(!Number.isFinite(n)||n<0||n>1e8))return false;S[key]=n;return true;}
function setPlanInputs(values){if(!values||typeof values!=='object'||Array.isArray(values))throw new Error('Provide an object of numeric planning fields.');const entries=Object.entries(values);for(const [k,v] of entries){if(!M.numericKeys.includes(k)||!(v===null||(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e8)))throw new Error('Invalid field or nonnegative numeric value.');}for(const [k,v] of entries)S[k]=v;syncInputs();plan();persist();return M.calculate(S,defs);}

function mergeForecast(raw){
 if(!raw||typeof raw!=='object')return;
 const f=S.forecast;for(const k of ['start','babyStart','childcareStart','leaveStart'])if(raw[k]===''||M.monthIndex(raw[k])!==null)f[k]=raw[k];
 for(const k of ['months','leaveMonths','incomeGrowth','expenseGrowth','cashYield']){const n=raw[k],max=['months','leaveMonths'].includes(k)?120:20;if(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=max&&(k!=='months'||n>=1)&&(!['months','leaveMonths'].includes(k)||Number.isInteger(n)))f[k]=n;}
 if(Array.isArray(raw.oneoffs))f.oneoffs=raw.oneoffs.slice(0,24).filter(x=>x&&typeof x==='object').map(x=>({label:String(x.label||'One-off cost').slice(0,80),amount:typeof x.amount==='number'&&Number.isFinite(x.amount)&&x.amount>=0&&x.amount<=1e8?x.amount:null,month:M.monthIndex(x.month)!==null?x.month:''}));
 for(const k of Object.keys(f.debtEnds))if(raw.debtEnds?.[k]===''||M.monthIndex(raw.debtEnds?.[k])!==null)f.debtEnds[k]=raw.debtEnds[k];
}
function renderComparison(){
 const selected=$('compareMonth').value||latestMonth,basis=$('categoryBasis').value;const c=M.compareMonth(D.transactions,D.monthly,selected,Number($('baselineMonths').value),{basis,category:$('category').value,query:$('search').value.trim(),review:$('reviewFilter').value,adjustments:S.adjustments});
 $('comparisonCoverage').textContent=monthLabel(selected)+' vs '+c.coverageCount+' fully covered prior month'+(c.coverageCount===1?'':'s')+' in the '+c.lookback+'-month window'+(c.months.length?' ('+c.months.map(monthLabel).join(', ')+')':'')+'. '+(!c.selectedCovered?'Selected month has bank-only coverage; comparisons are partial. ':'')+(c.coverageCount<c.lookback?'Unavailable or card-incomplete months are excluded, not treated as $0. ':'')+'Category, search, review and adjustment filters apply to both sides.';
 $('categoryComparison').innerHTML=c.categories.map(x=>{const d=basis==='category'?defs.find(d=>d.cat===x.category):null;let target=d?money(M.cents(S.targets[d.key])):'—';if(S.healthMode==='combined'&&['Medical & pharmacy','Dental'].includes(x.category))target='Shared health target';const diff=x.differenceCents===null?'No baseline':(x.differenceCents>0?'+':'')+money(x.differenceCents);const pct=x.percent===null?'% not defined':(x.percent>0?'+':'')+x.percent.toFixed(0)+'%';const episode=x.category==='Dental'&&D.transactions.some(r=>r.date.startsWith(selected)&&r.flags.includes('nonroutine_dental_episode'));return `<tr><td><button class="text-button" data-compare-category="${esc(x.category)}">${esc(x.category)}</button></td><td class="num">${money(x.actualCents)}</td><td class="num">${money(x.averageCents)}</td><td class="num">${diff}<small>${pct}</small></td><td><span class="badge ${['Higher than usual','New in this window'].includes(x.signal)?'warn':''}">${esc(x.signal)}</span>${episode?'<small>Synthetic nonroutine example</small>':''}</td><td class="num">${target}</td></tr>`;}).join('')||'<tr><td colspan="6">No category activity matches these filters.</td></tr>';
}
function renderDrill(rows,basis){
 const groups=M.merchantGroups(rows,basis);const byMonth={};for(const r of rows)byMonth[r.date.slice(0,7)]=(byMonth[r.date.slice(0,7)]||0)+r.amountCents;
 $('monthDrill').innerHTML=Object.entries(byMonth).sort((a,b)=>b[0].localeCompare(a[0])).map(([m,v])=>`<button data-drill-month="${m}"><span>${monthLabel(m)}</span><strong>${money(v)}</strong></button>`).join('');
 $('spendingDrill').innerHTML=groups.length?groups.map(g=>`<details class="category-drill"><summary><span>${esc(g.category)}<small>${g.count} records · ${g.merchants.length} merchants</small></span><strong>${money(g.totalCents)}</strong></summary><div class="merchant-drill-list">${g.merchants.map(m=>`<details class="merchant-drill"><summary><span>${esc(m.merchant)}<small>${m.rows.length} records${m.reviewCount?' · '+m.reviewCount+' to review':''}</small></span><strong>${money(m.totalCents)}</strong></summary><div class="drill-transactions">${m.rows.sort((a,b)=>b.date.localeCompare(a.date)).map(r=>`<details class="transaction-drill"><summary><span>${esc(r.date)}${r.amountCents<0?' · Refund':''}${r.flags.includes('nonroutine_dental_episode')?' · Nonroutine dental':''}</span><strong>${money(r.amountCents)}</strong></summary><p>${esc(r.classificationEvidence?.summary||r.note||'Category follows the supplied source label. Item contents are not available.')}</p><p>Source: ${esc(D.sources.find(x=>x.id===r.source)?.label||r.source)} · Bank category: ${esc(r.sourceCategory||'Not supplied')} · ${esc(r.classificationEvidence?.confidence||r.confidence||'Unreviewed')} confidence</p><p>Record ${esc(r.id)}. ${r.needsCategoryReview?'Category needs confirmation. ':''}${r.needsItemReview?'Item contents need a receipt. ':''}${r.needsScopeReview?'Household/work use needs confirmation.':''}</p></details>`).join('')}</div></details>`).join('')}</div></details>`).join(''):'<p class="empty">No spending matches the current filters.</p>';
}
function renderForecastInputs(){
 document.querySelectorAll('[data-forecast]').forEach(el=>{el.removeAttribute('data-forecast-invalid');el.removeAttribute('aria-invalid');el.setCustomValidity('');});
 document.querySelectorAll('[data-forecast]').forEach(el=>el.value=S.forecast[el.dataset.forecast]??'');
 $('oneoffInputs').innerHTML=S.forecast.oneoffs.map((x,i)=>`<div class="oneoff-row"><label>Name<input data-once="label" data-once-index="${i}" value="${esc(x.label)}" maxlength="80"></label><label>Amount ($)<input data-once="amount" data-once-index="${i}" type="number" min="0" max="100000000" step="0.01" value="${x.amount??''}" placeholder="Not set"></label><label>Month<input data-once="month" data-once-index="${i}" type="month" value="${esc(x.month)}"></label><button data-remove-once="${i}" class="text-button" aria-label="Remove ${esc(x.label)}">Remove</button></div>`).join('');
 $('debtEndInputs').innerHTML=Object.entries(S.forecast.debtEnds).map(([k,v])=>`<label>${esc(defs.find(d=>d.key===k)?.label||k)}<input type="month" data-debt-end="${k}" value="${esc(v)}"></label>`).join('');refreshValidation();
}
function forecast(){
 let p;try{p=M.project(S,defs);}catch(e){$('forecastStatus').innerHTML='<strong>'+esc(e.message)+'</strong>';$('forecastMetrics').innerHTML='';$('forecastRows').innerHTML='';$('forecastChart').innerHTML='';return;}
 const f=S.forecast,last=p.rows.at(-1),known=p.base.income!==null;
 const state=p.missing.length?'Incomplete scenario':'Input-complete scenario';
 $('forecastStatus').innerHTML='<strong>'+state+' · '+(S.planMode==='joint'?'joint-account funding':'whole-household income')+'</strong><p>'+(p.missing.length?'Still unknown or unset: '+esc(p.missing.join('; '))+'. Blank costs are not included, so results may overstate available cash.':'All listed inputs are entered. They remain your assumptions; actual costs and pay may differ.')+'</p>'+(p.base.usesIllustrativeTwoChecks?'<p>Two Person A checks per month are assumed here. Actual pay cadence remains unconfirmed.</p>':'');
 const card=(label,value,sub,negative=false)=>`<article class="metric ${negative?'negative':''}"><span>${label}</span><strong>${value}</strong><p>${sub}</p></article>`;
 $('forecastMetrics').innerHTML=card('Cash at '+monthLabel(last.month),money(p.endCash,0),p.base.cash===null?'Enter starting cash to calculate a balance':'All future surplus retained; before missing costs',p.endCash!==null&&p.endCash<0)+card('First month after savings',money(p.rows[0].unassigned,0),'Unassigned after entered reserves and costs',p.rows[0].unassigned!==null&&p.rows[0].unassigned<0)+card('Monthly savings allocations',money(p.base.savings,0),'Earmarked within cash, never counted twice');
 const valid=p.rows.filter(r=>r.cash!==null);if(valid.length){const w=850,h=230,pad=35,vals=[p.base.cash,...valid.map(r=>r.cash),0],min=Math.min(...vals),max=Math.max(...vals),range=Math.max(max-min,1),x=i=>pad+i/Math.max(1,p.rows.length)*(w-pad*2),y=v=>h-pad-(v-min)/range*(h-pad*2);const pts=[`${x(0)},${y(p.base.cash)}`,...p.rows.map((r,i)=>`${x(i+1)},${y(r.cash)}`)].join(' ');$('forecastChart').innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Projected available cash from ${esc(money(p.base.cash))} to ${esc(money(p.endCash))}. Detailed monthly values follow below."><line x1="${pad}" x2="${w-pad}" y1="${y(0)}" y2="${y(0)}" stroke="#cdd5e4" stroke-dasharray="4 4"/><polyline points="${pts}" fill="none" stroke="${p.endCash<0?'#b43b32':'#244ac8'}" stroke-width="3"/><text x="${pad}" y="20">${esc(money(max,0))}</text><text x="${pad}" y="${h-7}">${esc(monthLabel(f.start))}</text><text x="${w-pad}" y="${h-7}" text-anchor="end">${esc(monthLabel(last.month))}</text></svg>`;}else $('forecastChart').innerHTML='<p class="empty">Add the missing income and starting cash to draw your savings path. Monthly costs remain visible below.</p>';
 let goal=p.base.goal===null?'Set a cash goal to compare it with this scenario.':p.goalReached===0?'The entered starting cash already covers the goal.':p.goalReached!==null?'Cash reaches '+money(p.base.goal)+' in '+monthLabel(p.rows[p.goalReached-1].month)+', if every assumption holds.':'The entered goal is not reached within this horizon, or cash/income is still unknown.';
 if(p.firstDeficit)goal+=' Monthly income falls below spending in '+monthLabel(p.firstDeficit)+'.';if(p.firstNegativeCash)goal+=' Cash first goes below zero in '+monthLabel(p.firstNegativeCash)+'.';
 $('forecastGoal').innerHTML='<span>'+esc(goal)+'</span>';
 $('forecastRows').innerHTML=p.rows.map(r=>`<details><summary><span>${monthLabel(r.month)}<small>${r.oneoff?'Includes '+money(r.oneoff)+' one-off costs':r.leaveReduction?'Reduced leave income':'Entered monthly scenario'}</small></span><strong class="${r.cash!==null&&r.cash<0?'negative':''}">${money(r.cash)}<small>Closing cash</small></strong></summary><div class="forecast-month-grid">${[['Income after leave reduction',r.income],['Spending + debt targets',r.expense],['Childcare + other baby costs',r.baby],['One-off spending',r.oneoff],['Cash change before interest',r.net],['Planned savings allocations',r.plannedSavings],['Unassigned after allocations',r.unassigned],['Scenario cash interest',r.interest],['Closing available cash',r.cash]].map(([label,n])=>`<div><span>${label}</span><strong>${money(n)}</strong></div>`).join('')}</div>${r.unassigned!==null&&r.unassigned<0?'<p class="warning">This month cannot fully fund the entered savings allocations from income. Reduce targets, use existing cash deliberately, or change the assumptions.</p>':''}</details>`).join('');
 const flex=['groceries','dining','shopping'].map(k=>defs.find(d=>d.key===k));const flexTotal=flex.reduce((a,d)=>a+(M.cents(S.targets[d.key])||0),0);const lines=[['Flexible-spending trade-off',`Your entered flexible targets total ${money(flexTotal)}/month. A hypothetical 10% change is ${money(Math.round(flexTotal*.1))}/month. Review contents before deciding.`],['Irregular costs stay in actuals','Historical health spending is not automatically a recurring bill. Choose future reserves independently.'],['Timing changes cash','Childcare and leave begin in the months you enter. The optional allowance is fictitious, not a provider quote.'],['Debt timing needs evidence','No payoff date is inferred. Enter confirmed final payment months and verify balances and terms outside this model.'],['Savings earmarks existing cash',`Your reserves total ${money(p.base.savings)}/month. Surplus is retained once in the cash model. A $100 monthly spending change is $1,200 per year before growth.`]];
 $('tradeoffInsights').innerHTML=lines.map(([title,body])=>`<div class="tradeoff"><strong>${title}</strong><p>${esc(body)}</p></div>`).join('');
}
function renderDebtInventory(){
 const debts=[['Sample housing loan','Fictitious balance: $120,000','Editable Mortgage target'],['Sample Person A vehicle loan','Fictitious balance: $8,000','Editable Person A vehicle target'],['Sample education loan','Fictitious balance: $9,000','Editable education-loan target'],['Sample Person B vehicle loan','Fictitious balance: $15,000','Editable Person B vehicle target'],['Sample store card','Fictitious balance: $1,200','Editable store-card target']];
 $('debtInventory').innerHTML=debts.map(([label,balance,payment])=>`<details class="debt-item"><summary><span>${esc(label)}<small>Invented demonstration only</small></span><strong>${esc(balance)}</strong></summary><p>${esc(payment)} is the only amount counted in the monthly plan. Confirm real balances, rates and terms separately.</p></details>`).join('');
 $('studentLoanDetails').innerHTML='<p>No personal loan inventory is included. This export demonstrates a configurable payment target, not amortization, payoff quotes or verified loan terms.</p>';
}
function installForecastEvents(){
 ['compareMonth','baselineMonths'].forEach(id=>$(id).addEventListener('change',renderComparison));
 $('clearDrill').addEventListener('click',()=>{$('category').value='all';$('search').value='';$('reviewFilter').value='all';$('period').value='quarter';$('rowKind').value='spend';page=0;spending();});
 $('addOneoff').addEventListener('click',()=>{if(S.forecast.oneoffs.length>=24)return;S.forecast.oneoffs.push({label:'One-off cost',amount:null,month:''});renderForecastInputs();forecast();persist();});
 document.addEventListener('click',e=>{const cmp=e.target.closest('[data-compare-category]');if(cmp){$('period').value=$('compareMonth').value;$('category').value=cmp.dataset.compareCategory;page=0;spending();$('spendingDrill').scrollIntoView({behavior:'smooth',block:'start'});}const month=e.target.closest('[data-drill-month]');if(month){$('period').value=month.dataset.drillMonth;$('compareMonth').value=month.dataset.drillMonth;page=0;spending();}const h=e.target.closest('[data-horizon]');if(h){S.forecast.months=Number(h.dataset.horizon);renderForecastInputs();forecast();persist();}const remove=e.target.closest('[data-remove-once]');if(remove){S.forecast.oneoffs.splice(Number(remove.dataset.removeOnce),1);renderForecastInputs();forecast();persist();}});
 document.addEventListener('input',e=>{const el=e.target;let changed=false;
 if(el.dataset.forecast){const k=el.dataset.forecast;if(el.type==='month'){if(el.value===''||M.monthIndex(el.value)!==null){S.forecast[k]=el.value;changed=true;}}else{const v=Number(el.value),max=['months','leaveMonths'].includes(k)?120:20,min=k==='months'?1:0;const ok=el.value!==''&&Number.isFinite(v)&&v>=min&&v<=max&&(!['months','leaveMonths'].includes(k)||Number.isInteger(v));el.setCustomValidity(ok?'':'Enter a value within the displayed range.');el.toggleAttribute('data-forecast-invalid',!ok);if(ok)el.removeAttribute('aria-invalid');else el.setAttribute('aria-invalid','true');refreshValidation();if(ok){S.forecast[k]=v;changed=true;}}}
 if(el.dataset.once){const row=S.forecast.oneoffs[Number(el.dataset.onceIndex)],k=el.dataset.once;if(k==='amount'){if(validateInput(el)){row.amount=el.value===''?null:Number(el.value);changed=true;}}else if(k==='label'){row.label=el.value.slice(0,80);changed=true;}else if(el.value===''||M.monthIndex(el.value)!==null){row.month=el.value;changed=true;}}
 if(el.dataset.debtEnd&&(el.value===''||M.monthIndex(el.value)!==null)){S.forecast.debtEnds[el.dataset.debtEnd]=el.value;changed=true;}
 if(changed){forecast();persist();}
 });
}

function init(){
 renderForecastInputs();renderDebtInventory();
 $('period').insertAdjacentHTML('beforeend','<optgroup label="Individual months">'+[...D.monthly].reverse().map(m=>`<option value="${m.month}">${monthLabel(m.month)}${m.hasMainCardCoverage?'':' · bank only'}</option>`).join('')+'</optgroup>');fillCategories();
 $('adjustmentControls').innerHTML=`<label class="check-option"><input id="adjust-airfare" type="checkbox" ${S.adjustments.airfare?'checked':''}><span>Treat the matched airfare as reimbursed<small id="adjust-airfare-amount"></small><small>Unconfirmed. Apply only as a what-if until verified.</small></span></label><label class="check-option"><input id="adjust-business" type="checkbox" ${S.adjustments.business?'checked':''}><span>Exclude candidate work purchases<small id="adjust-business-amount"></small><small>All flagged synthetic work-cost examples. Hypothetical only; confirm which are truly paid outside the household.</small></span></label>`;
 $('compareMonth').innerHTML=[...D.monthly].reverse().map(m=>`<option value="${m.month}">${monthLabel(m.month)}${m.hasMainCardCoverage?'':' · partial'}</option>`).join('');$('compareMonth').value=latestMonth;overview();syncInputs();plan();spending();review();tab(S.tab);
 document.querySelectorAll('[data-tab],[data-goto]').forEach(b=>b.addEventListener('click',()=>tab(b.dataset.tab||b.dataset.goto,true)));
 ['period','category','rowKind','categoryBasis','reviewFilter'].forEach(id=>$(id).addEventListener('change',()=>{if(id==='categoryBasis')fillCategories();if(id==='period'&&/^\d{4}-\d{2}$/.test($('period').value))$('compareMonth').value=$('period').value;page=0;spending();}));$('search').addEventListener('input',()=>{page=0;spending();});$('prevPage').addEventListener('click',()=>{page--;spending();});$('nextPage').addEventListener('click',()=>{page++;spending();});
 for(const k of ['airfare','business'])$('adjust-'+k).addEventListener('change',e=>{S.adjustments[k]=e.target.checked;spending();persist();});
 document.addEventListener('input',e=>{const el=e.target;if(el.dataset.plan&&el.tagName!=='SELECT'){if(validateInput(el)&&updateNumeric(el.dataset.plan,el.value)){document.querySelectorAll('[data-plan="'+el.dataset.plan+'"]').forEach(x=>{if(x!==el)x.value=el.value;});plan();persist();}}if(el.dataset.target){const val=el.value===''?null:Number(el.value);if(validateInput(el)){S.targets[el.dataset.target]=val;plan();persist();}}});
 document.addEventListener('change',e=>{const el=e.target;if(el.dataset.plan&&el.tagName==='SELECT'){S[el.dataset.plan]=el.value;if(['planMode','vehicleBFunding'].includes(el.dataset.plan))renderBudgetInputs();plan();persist();}if(el.dataset.check){S.checks[el.dataset.check]=el.checked;el.closest('.checklist-row').classList.toggle('completed',el.checked);persist();}});
 $('childcareQuote').addEventListener('click',()=>{S.childcare=1200;syncInputs();plan();persist();toast('Fictitious childcare allowance applied: $1,200/month. Replace it with your own confirmed cost and schedule.');});
 $('useObserved').addEventListener('click',()=>{for(const d of defs)if(d.observed!==null&&d.cat&&!(S.healthMode==='combined'&&['medical','dental'].includes(d.key)))S.targets[d.key]=Math.round(quarterCats[d.cat])/100;S.targets.energy=Math.round((quarterCats.Electricity||0)+(quarterCats['Natural gas']||0))/100;syncInputs();plan();persist();toast('Observed category averages applied. A saved combined health target is preserved. Debt, missing bills, and the annual fee reserve remain separate. Summer utilities may understate winter costs.');});
 document.addEventListener('click',e=>{const b=e.target.closest('[data-open-dental],[data-open-category],[data-open-unresolved],[data-merchant-review]');if(!b)return;$('rowKind').value='spend';$('search').value='';$('reviewFilter').value=b.hasAttribute('data-open-unresolved')?'unresolved':'all';const chart=b.dataset.fromChart;if(b.hasAttribute('data-merchant-review')){$('period').value='all';$('categoryBasis').value='category';fillCategories();$('category').value='all';$('reviewFilter').value='unresolved';$('search').value=b.dataset.merchantReview;}else if(b.hasAttribute('data-open-dental')){$('period').value=latestMonth;$('categoryBasis').value='category';fillCategories();$('category').value='Dental';}else if(b.hasAttribute('data-open-unresolved')){$('period').value='quarter';$('categoryBasis').value='category';fillCategories();$('category').value='all';}else{if(chart==='overviewCategories'){$('period').value='quarter';$('categoryBasis').value='category';}fillCategories();$('category').value=b.dataset.openCategory;}page=0;spending();tab('spending',true);});
 $('splitHealthBudget').addEventListener('click',()=>{$('healthSplitTotal').textContent='Current combined monthly target: '+money(M.cents(S.targets.medical));$('healthSplitDental').value='';$('healthSplitRemainder').textContent='Enter the part you want to reserve for dental. The rest will remain medical / pharmacy.';$('applyHealthSplit').disabled=true;$('healthSplitDialog').showModal();});
 $('healthSplitDental').addEventListener('input',()=>{try{const split=M.splitHealth(S.targets.medical,$('healthSplitDental').value);$('healthSplitRemainder').textContent=money(M.cents(split.medical))+' medical / pharmacy + '+money(M.cents(split.dental))+' dental = unchanged total';$('applyHealthSplit').disabled=false;}catch{$('healthSplitRemainder').textContent='Choose a dental amount between $0 and the existing total.';$('applyHealthSplit').disabled=true;}});
 $('cancelHealthSplit').addEventListener('click',()=>$('healthSplitDialog').close());$('applyHealthSplit').addEventListener('click',()=>{try{const split=M.splitHealth(S.targets.medical,$('healthSplitDental').value);S.targets.medical=split.medical;S.targets.dental=split.dental;S.healthMode='separate';S.healthMigrationNotice=false;syncInputs();plan();persist();$('healthSplitDialog').close();toast('Health target split. Your combined total is unchanged.');}catch{toast('Choose a dental amount within the current combined target.');}});
 $('download').addEventListener('click',download);$('printPlan').addEventListener('click',()=>{tab('plan');window.print();});$('reset').addEventListener('click',()=>$('resetDialog').showModal());$('cancelReset').addEventListener('click',()=>$('resetDialog').close());$('confirmReset').addEventListener('click',()=>{S=structuredClone(defaults);persist();syncInputs();renderForecastInputs();plan();review();['airfare','business'].forEach(k=>$('adjust-'+k).checked=false);spending();tab('overview');$('resetDialog').close();toast('Local changes reset to the current audited snapshot.');});
 installForecastEvents();
 if(!storageAvailable)$('storageStatus').textContent='Local saving unavailable. Download a copy to keep changes.';
 const ctx=document.modelContext;if(ctx?.registerTool){const controller=new AbortController();try{Promise.resolve(ctx.registerTool({name:'read_household_budget',title:'Read household budget',description:'Read this browser’s current household or joint-account budget scenario and its unresolved fields.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute(input){if(!input||Object.keys(input).length)throw new Error('No input fields are accepted.');return M.calculate(S,defs);}},{signal:controller.signal})).catch(()=>{});Promise.resolve(ctx.registerTool({name:'configure_budget_inputs',title:'Configure budget inputs',description:'Update numeric budget scenario inputs in this browser. Does not share, sync, or move money.',inputSchema:{type:'object',properties:Object.fromEntries(M.numericKeys.map(k=>[k,{type:['number','null'],minimum:0,maximum:100000000}])),additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:setPlanInputs},{signal:controller.signal})).catch(()=>{});window.addEventListener('pagehide',()=>controller.abort(),{once:true});}catch{}}
 window.HouseholdBudget={project:()=>M.project(S,defs),data:D,definitions:defs,getState:()=>structuredClone(S),calculate:()=>M.calculate(S,defs),setPlanInputs};
}
init();
})();
