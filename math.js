'use strict';
(function(root){
const frequencies={weekly:52,biweekly:26,semimonthly:24,monthly:12};
const numericKeys=['personAPay','personBPay','personAAllocation','personBContribution','otherIncome','otherExpenses','childcare','babyCosts','leaveReduction','homeFund','emergencyFund','anniversaryFund','otherSavings','currentCash','cashGoal'];
function cents(v){if(v===null||v===undefined||v==='')return null;const n=Number(v);if(!Number.isFinite(n)||n<0||n>1e8)throw new Error('Enter a nonnegative amount below $100 million.');return Math.round((n+Number.EPSILON)*100);}
function multiplier(f,basis){if(!frequencies[f])return null;if(basis==='average')return frequencies[f]/12;return {weekly:4,biweekly:2,semimonthly:2,monthly:1}[f];}
function calculate(s,defs){
 const get=k=>cents(s[k]);const whole=s.planMode!=='joint';
 const knownPersonAMult=multiplier(s.personAFrequency,s.incomeBasis),personAMult=knownPersonAMult??(!whole?2:null),personBMult=multiplier(s.personBFrequency,s.incomeBasis);
 const jp=get('personAPay'),ja=get('personAAllocation');const personB=get('personBPay');let income=null,personAIncome=null,personBIncome=null;const missing=[];
 if(jp!==null&&personAMult!==null)personAIncome=Math.round(jp*personAMult);
 if(whole){if(personAIncome===null)missing.push('Person A pay frequency');if(personB===null||personBMult===null)missing.push('Person B full take-home and frequency');else personBIncome=Math.round(personB*personBMult);if(personAIncome!==null&&personBIncome!==null)income=personAIncome+personBIncome+(get('otherIncome')??0);}
 else {const jc=get('personBContribution');if(jp===null||ja===null||jc===null)missing.push('Joint contribution amounts');else if(ja>jp)missing.push('Personal allocation exceeds take-home');else income=Math.round((jp-ja)*personAMult)+jc+(get('otherIncome')??0);}
 let expense=0,personalDebt=0;const blankTargets=[];
 defs.forEach(d=>{if(d.key==='dental'&&s.healthMode==='combined')return;const val=cents(s.targets[d.key]);if(d.personal)personalDebt+=val??0;if(d.personal&&!whole)return;if(d.personBPersonal&&!whole&&s.vehicleBFunding!=='joint')return;if(val===null)blankTargets.push(d.label);else expense+=val;});
 let allocation=null,allowance=null,allocationDeficit=0;if(ja!==null&&personAMult!==null){allocation=Math.round(ja*personAMult);allowance=Math.max(0,allocation-personalDebt);allocationDeficit=Math.max(0,personalDebt-allocation);if(whole)expense+=allowance;}
 if(!whole&&s.vehicleBFunding==='unknown')missing.push('Which account funds Person B’s vehicle payment');if(whole&&allocation===null)missing.push('Personal allocation monthly total');
 const otherExpenses=get('otherExpenses');expense+=otherExpenses??0;
 const baby=(get('childcare')??0)+(get('babyCosts')??0);const savings=(get('homeFund')??0)+(get('emergencyFund')??0)+(get('anniversaryFund')??0)+(get('otherSavings')??0);const reduction=get('leaveReduction')??0;
 const currentRoom=income===null?null:income-expense-savings;const futureRoom=income===null?null:income-expense-savings-baby-reduction;
 const incomplete=[...missing,...blankTargets];if(otherExpenses===null)incomplete.push('Other missing household expenses');if(get('childcare')===null)incomplete.push('Childcare');if(get('babyCosts')===null)incomplete.push('Other baby costs');['homeFund','emergencyFund','anniversaryFund'].forEach(k=>{if(get(k)===null)incomplete.push({homeFund:'Home-repair savings',emergencyFund:'Cash-cushion savings',anniversaryFund:'Anniversary savings'}[k]);});
 const cash=get('currentCash'),goal=get('cashGoal'),contribution=get('emergencyFund');let monthsToGoal=null;if(cash!==null&&goal!==null){if(cash>=goal)monthsToGoal=0;else if(contribution>0)monthsToGoal=Math.ceil((goal-cash)/contribution);}
 return {whole,income,personAIncome,personBIncome,personAMultiplier:personAMult,personBMultiplier:personBMult,usesIllustrativeTwoChecks:!whole&&knownPersonAMult===null,expense,personalDebt,allocation,allowance,allocationDeficit,baby,savings,reduction,currentRoom,futureRoom,missing,blankTargets,incomplete,monthsToGoal,cash,goal,contribution};
}
function totals(rows,{start,end,category='all',basis='category',query='',review='all',adjustments={}}={}){let spending=0,adjusted=0,adjustment=0;const cats={};const filtered=rows.filter(r=>(!start||r.date>=start)&&(!end||r.date<=end)&&(category==='all'||r[basis]===category)&&(!query||(r.merchant+' '+r.note+' '+r.category+' '+r.sourceCategory).toLowerCase().includes(query.toLowerCase()))&&matchesReview(r,review));for(const r of filtered){if(r.kind!=='spend')continue;const amount=r.amountCents;spending+=amount;const remove=(adjustments.airfare&&r.flags.includes('reimbursement_candidate'))||(adjustments.business&&r.flags.includes('business_candidate'));if(remove){adjustment+=amount;continue;}adjusted+=amount;const cat=r[basis]||'Uncategorized';cats[cat]=(cats[cat]||0)+amount;}return{rows:filtered,spending,adjusted,adjustment,categories:Object.entries(cats).map(([category,totalCents])=>({category,totalCents})).sort((a,b)=>b.totalCents-a.totalCents)};}
function matchesReview(r,review){const f=r.flags||[];if(review==='dental')return r.category==='Dental';if(review==='episode')return f.includes('nonroutine_dental_episode');if(review==='unresolved'){if('needsCategoryReview' in r||'needsItemReview' in r||'needsScopeReview' in r)return !!(r.needsCategoryReview||r.needsItemReview||r.needsScopeReview);return r.needsReview===true||r.confidence==='provisional'||f.some(x=>/mixed_retail|fuel_or_convenience|purpose_unconfirmed|needs_category_review|subscription_or_digital_purchase|unresolved/i.test(x));}if(review==='changed')return f.includes('source_category_revised')||f.includes('classification_audit_changed')||r.classificationChanged===true;if(review==='business')return f.includes('business_candidate');if(review==='refund')return r.kind==='spend'&&r.amountCents<0;return true;}
function healthMigration(raw){if(!raw||typeof raw!=='object')return raw;const copy=JSON.parse(JSON.stringify(raw));if(!['combined','separate'].includes(copy.healthMode)){copy.healthMode=copy.version<3&&Object.prototype.hasOwnProperty.call(copy.targets||{},'medical')?'combined':'separate';if(copy.healthMode==='combined'){copy.targets.dental=null;copy.healthMigrationNotice=true;}}copy.version=3;return copy;}
function splitHealth(total,dental){const t=cents(total),d=cents(dental);if(t===null||d===null||d>t)throw new Error('Choose a dental amount between zero and the existing combined target.');return {medical:(t-d)/100,dental:d/100};}
function monthIndex(m){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m||''))return null;const [y,n]=m.split('-').map(Number);return y*12+n-1;}
function monthFromIndex(i){return Math.floor(i/12)+'-'+String(i%12+1).padStart(2,'0');}
function project(s,defs){
 const f=s.forecast||{},start=monthIndex(f.start),months=Number(f.months),c=calculate(s,defs);
 if(start===null||!Number.isInteger(months)||months<1||months>120)throw new Error('Choose a valid start month and a horizon from 1 to 120 months.');
 const pct=k=>{const n=Number(f[k]??0);if(!Number.isFinite(n)||n<0||n>20)throw new Error('Use a percentage from 0 to 20.');return n/100;};
 const incomeRate=pct('incomeGrowth'),costRate=pct('expenseGrowth'),yieldRate=pct('cashYield');
 const missing=[...c.incomplete];if(c.cash===null)missing.push('Starting available cash');
 if((cents(s.babyCosts)||0)>0&&monthIndex(f.babyStart)===null)missing.push('Baby-cost start month');
 if((cents(s.childcare)||0)>0&&monthIndex(f.childcareStart)===null)missing.push('Childcare start month');
 const leaveMonths=Number(f.leaveMonths)||0;if(!Number.isInteger(leaveMonths)||leaveMonths<0||leaveMonths>120)throw new Error('Leave duration must be from 0 to 120 months.');
 if(c.usesIllustrativeTwoChecks)missing.push('Person A’s actual pay frequency');if(leaveMonths>0&&cents(s.leaveReduction)===null)missing.push('Monthly leave-income reduction');if(c.reduction>0&&leaveMonths>0&&monthIndex(f.leaveStart)===null)missing.push('Leave-income reduction start month');
 const oneoffs=(f.oneoffs||[]).map(x=>({...x,cents:cents(x.amount),index:monthIndex(x.month)}));
 for(const x of oneoffs){if(x.cents>0&&x.index===null)missing.push(x.label+' month');if(x.index!==null&&x.cents===null)missing.push(x.label+' amount');}
 const rows=[];let cash=c.cash,goalReached=c.cash!==null&&c.goal!==null&&c.cash>=c.goal?0:null,firstDeficit=null,firstNegativeCash=null;
 for(let i=0;i<months;i++){
  const idx=start+i,month=monthFromIndex(idx),growth=Math.pow(1+costRate,i/12),incomeGrowth=Math.pow(1+incomeRate,i/12);
  let debtReduction=0;for(const [key,end] of Object.entries(f.debtEnds||{})){const di=monthIndex(end),d=defs.find(d=>d.key===key);if(di!==null&&idx>di&&d&&(!d.personal||c.whole)&&(!d.personBPersonal||c.whole||s.vehicleBFunding==='joint'))debtReduction+=cents(s.targets[key])||0;}
  const fixedKeys=['mortgage','vehicleA','student','vehicleB','storeCard'];const fixed=defs.filter(d=>fixedKeys.includes(d.key)&&(!d.personal||c.whole)&&(!d.personBPersonal||c.whole||s.vehicleBFunding==='joint')).reduce((a,d)=>a+(cents(s.targets[d.key])||0),0)+(c.whole?(c.allowance||0):0);const expense=Math.round((c.expense-fixed)*growth)+fixed-debtReduction;
  const leaveStart=monthIndex(f.leaveStart);const reduction=leaveStart!==null&&idx>=leaveStart&&idx<leaveStart+leaveMonths?c.reduction:0;
  const income=c.income===null?null:Math.round(c.income*incomeGrowth)-reduction;
  const baby=(monthIndex(f.babyStart)!==null&&idx>=monthIndex(f.babyStart)?cents(s.babyCosts)||0:0)+(monthIndex(f.childcareStart)!==null&&idx>=monthIndex(f.childcareStart)?cents(s.childcare)||0:0);
  const once=oneoffs.filter(x=>x.index===idx).reduce((a,x)=>a+(x.cents||0),0);
  const net=income===null?null:income-expense-Math.round(baby*growth)-once;
  const unassigned=net===null?null:net-c.savings;
  const interest=cash===null?null:Math.round(Math.max(0,cash)*(Math.pow(1+yieldRate,1/12)-1));
  if(cash!==null&&net!==null)cash+=net+interest;else cash=null;
  if(net!==null&&net<0&&firstDeficit===null)firstDeficit=month;
  if(cash!==null&&cash<0&&firstNegativeCash===null)firstNegativeCash=month;
  if(goalReached===null&&cash!==null&&c.goal!==null&&cash>=c.goal)goalReached=i+1;
  rows.push({month,income,expense,baby:Math.round(baby*growth),oneoff:once,net,plannedSavings:c.savings,unassigned,interest,cash,debtReduction,leaveReduction:reduction});
 }
 return{rows,endCash:cash,missing:[...new Set(missing)],goalReached,firstDeficit,firstNegativeCash,complete:missing.length===0,base:c};
}
function merchantGroups(rows,basis='category'){const groups={};for(const r of rows.filter(r=>r.kind==='spend')){const k=r[basis]||'Uncategorized';const c=groups[k]??={category:k,totalCents:0,merchants:{},count:0};c.totalCents+=r.amountCents;c.count++;const m=c.merchants[r.merchant]??={merchant:r.merchant,totalCents:0,rows:[],reviewCount:0};m.totalCents+=r.amountCents;m.rows.push(r);if(matchesReview(r,'unresolved'))m.reviewCount++;}return Object.values(groups).sort((a,b)=>b.totalCents-a.totalCents).map(g=>({...g,merchants:Object.values(g.merchants).sort((a,b)=>b.totalCents-a.totalCents)}));}
function compareMonth(rows,coverage,selected,lookback=3,options={}){
 const idx=monthIndex(selected);if(idx===null||![3,6,12].includes(Number(lookback)))throw new Error('Choose a month and 3, 6, or 12 prior months.');
 const months=coverage.filter(m=>m.hasMainCardCoverage&&monthIndex(m.month)<idx&&monthIndex(m.month)>=idx-Number(lookback)).map(m=>m.month).sort();
 const actual=totals(rows,{...options,start:selected+'-01',end:selected+'-31'}),base=totals(rows,{...options,start:monthFromIndex(idx-Number(lookback))+'-01',end:monthFromIndex(idx-1)+'-31'});
 const eligible=base.rows.filter(r=>months.includes(r.date.slice(0,7)));const bt=totals(eligible,options);const ac=Object.fromEntries(actual.categories.map(x=>[x.category,x.totalCents])),bc=Object.fromEntries(bt.categories.map(x=>[x.category,x.totalCents]));
 const categories=[...new Set([...Object.keys(ac),...Object.keys(bc)])].map(category=>{const value=ac[category]||0,average=months.length?Math.round((bc[category]||0)/months.length):null,difference=average===null?null:value-average,percent=average>0?difference/average*100:null,seasonal=['Electricity','Natural gas','Electric','Gas & Fuel'].includes(category);let signal=average===null?'No baseline':average===0?(value>0?'New in this window':value<0?'Refund / credit':'No spending'):average<0?'Refund-heavy baseline':difference>Math.max(10000,average*.25)?(seasonal?'Seasonal comparison':'Higher than usual'):difference< -Math.max(10000,average*.25)?'Lower than usual':'Within comparison band';return{category,actualCents:value,averageCents:average,differenceCents:difference,percent,signal,seasonal};}).sort((a,b)=>b.actualCents-a.actualCents);
 return{selected,lookback:Number(lookback),months,coverageCount:months.length,selectedCovered:!!coverage.find(m=>m.month===selected)?.hasMainCardCoverage,categories,actualCents:actual.adjusted,averageCents:months.length?Math.round(bt.adjusted/months.length):null};
}
root.HouseholdBudgetMath={compareMonth,project,monthIndex,monthFromIndex,merchantGroups,cents,multiplier,calculate,totals,numericKeys,matchesReview,healthMigration,splitHealth};
})(globalThis);
