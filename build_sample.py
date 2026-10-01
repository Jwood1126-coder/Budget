"""Generate an entirely invented fixture. Never reads a private input dataset."""
from pathlib import Path
from collections import Counter, defaultdict
import json
ROOT = Path(__file__).parent
MONTHS = [f'{y}-{m:02}' for y, ms in [(2029, range(10,13)),(2030,range(1,13)),(2031,range(1,10))] for m in ms]
CATEGORIES = [
 ('Mortgage',110000),('Electricity',10000),('Natural gas',6000),
 ('Municipal payments',3500),('Groceries & meal kits',48000),('Dining & drinks',18000),
 ('Shopping & mixed retail',16000),('Fuel & charging',12000),('Vehicle care & registration',4500),
 ('Pets',6500),('Home & hardware',8000),('Medical & pharmacy',2500),('Dental',3000),
 ('Travel & parking',5000),('Apps & subscriptions',3500),('Entertainment',4000),
 ('Vision',1500),('Uncategorized / review',2000)]
rows=[]
def add(month,day,category,amount,kind='spend',flags=None,source='sample-card',merchant=None):
 flags=flags or []
 n=len(rows)+1
 revised=category in ['Dental','Vision']
 category_review=category=='Uncategorized / review'
 item_review=category=='Shopping & mixed retail'
 scope_review=any(f in flags for f in ['reimbursement_candidate','business_candidate'])
 source_category='Health' if revised else category
 rows.append(dict(id=f'sample-{n:04}',date=f'{month}-{day:02}',transactionDate=f'{month}-{day:02}',merchant=merchant or f'Sample {category} Merchant',amount=amount/100,amountCents=amount,sourceAmount=amount/100,sourceAmountCents=amount,category=category,sourceCategory=source_category,sourceType='synthetic',kind=kind,source=source,confidence='low' if category_review else 'high',flags=flags+(['source_category_revised'] if revised else []),note='Invented fixture record; no real purchase or person.',direction='inbound' if kind=='income' or amount<0 else 'outbound',incomeType='observed_payroll_deposit' if kind=='income' else None,scopeStatus='unconfirmed' if scope_review else 'synthetic',sourceRow=n,matchingTransactionIds=[],priorCategory=source_category,classificationChanged=revised,classificationEvidence=dict(summary='Synthetic evidence demonstrates the record-review interface.',basis='synthetic_fixture',confidence='low' if category_review else 'high'),needsCategoryReview=category_review,needsItemReview=item_review,needsScopeReview=scope_review,reviewReasons=['Synthetic example requires review'] if category_review or item_review or scope_review else [],sourceCategoryRevised=revised))
for i,month in enumerate(MONTHS):
 for day,(category,base) in enumerate(CATEGORIES,1):
  flags=[];amount=base if category=='Mortgage' else base+(i%3-1)*100
  if category=='Dental' and month=='2031-09':amount=45000;flags=['nonroutine_dental_episode']
  if category=='Travel & parking' and month=='2031-08':amount=24000;flags=['reimbursement_candidate']
  if category=='Home & hardware' and month=='2031-07':flags=['business_candidate']
  if category=='Shopping & mixed retail':flags.append('mixed_retail')
  add(month,day,category,amount,flags=flags,source='sample-bank' if category in ['Mortgage','Electricity','Natural gas','Municipal payments'] else 'sample-card')
 add(month,20,'Shopping & mixed retail',-1500,merchant='Sample Shopping & mixed retail Merchant')
 add(month,21,'Payroll',300000,'income',source='sample-bank',merchant='Sample Employer A')
 add(month,22,'Card repayment',90000,'card_payment',source='sample-bank',merchant='Sample Card Provider')
 add(month,23,'Internal transfer',10000,'transfer',source='sample-bank',merchant='Sample Savings Transfer')
 add(month,24,'Investment funding',5000,'investment',source='sample-bank',merchant='Sample Investment Transfer')
 add(month,25,'Store-card payment',4000,'debt_payment',source='sample-bank',merchant='Sample Store Card')
def totals(rs,key='category'):
 d=defaultdict(int)
 for r in rs:
  if r['kind']=='spend':d[r[key]]+=r['amountCents']
 return dict(sorted(d.items()))
def spend(rs):return sum(r['amountCents'] for r in rs if r['kind']=='spend')
def kind_sum(rs,kind):return sum(r['amountCents'] for r in rs if r['kind']==kind)
def flag_sum(rs,flag):return sum(r['amountCents'] for r in rs if flag in r['flags'])
monthly=[]
for month in MONTHS:
 rs=[r for r in rows if r['date'].startswith(month)]
 m=dict(month=month,transactionCount=len(rs),hasMainCardCoverage=month>='2030-01',coverage='Synthetic complete coverage' if month>='2030-01' else 'Synthetic incomplete coverage',spendingCents=spend(rs),categoriesCents=totals(rs),sourceCategoriesCents=totals(rs,'sourceCategory'),observedPayrollDepositsCents=kind_sum(rs,'income'),interestCreditsCents=0,unclassifiedCreditsCents=0,debtPaymentsCents=kind_sum(rs,'debt_payment'),investmentOutflowsCents=kind_sum(rs,'investment'),cashWithdrawalsUnallocatedCents=0,cardRepaymentsExcludedCents=kind_sum(rs,'card_payment'),mainCardPurchasesCents=sum(r['amountCents'] for r in rs if r['kind']=='spend' and r['source']=='sample-card' and r['amountCents']>0),mainCardRefundsCents=-sum(r['amountCents'] for r in rs if r['kind']=='spend' and r['amountCents']<0),mainCardFeesCents=0,mainCardAdjustmentsCents=0,directCheckingSpendCents=spend([r for r in rs if r['source']=='sample-bank']),checkingTransfersInFromOtherCheckingCents=0,savingsNetTransactionChangeCents=kind_sum(rs,'transfer'),categoryAuditReview={})
 monthly.append(m)
qmonths=MONTHS[-3:];qr=[r for r in rows if r['date'][:7] in qmonths]
qtotal=spend(qr);qcats=[dict(category=k,totalCents=v) for k,v in totals(qr).items()]
episode=flag_sum(qr,'nonroutine_dental_episode');reimbursement=flag_sum(qr,'reimbursement_candidate')
quarter=dict(months=qmonths,spendingCents=qtotal,monthlyAverageCents=round(qtotal/3),mainCardPurchasesCents=sum(m['mainCardPurchasesCents'] for m in monthly[-3:]),mainCardRefundsCents=sum(m['mainCardRefundsCents'] for m in monthly[-3:]),directCheckingSpendCents=sum(m['directCheckingSpendCents'] for m in monthly[-3:]),categories=qcats,debtPaymentsExcludedCents=kind_sum(qr,'debt_payment'),reimbursementCandidateCents=reimbursement,spendingIfAirfareReimbursementConfirmedCents=qtotal-reimbursement,septemberDentalProviderCents=sum(r['amountCents'] for r in qr if r['category']=='Dental' and r['date'].startswith('2031-09')),nonroutineDentalEpisodeCents=episode,categoryAuditReview={})
sources=[dict(id=id,label=label,rowCount=sum(r['source']==id for r in rows),start=rows[0]['date'],end=rows[-1]['date'],dateBasis='Synthetic posted dates',userConfirmedType='synthetic',openingBalance=None,closingBalance=None) for id,label in [('sample-bank','Sample bank fixture'),('sample-card','Sample card fixture')]]
expense=[r for r in rows if r['kind']=='spend']
audit=dict(version='synthetic-v1',asOfDate='2031-10-01',coverage=dict(allRows=len(rows),expenseRows=len(expense),expenseMerchants=len(set(r['merchant'] for r in expense)),otherCashFlowRows=len(rows)-len(expense),earliestDate=rows[0]['date'],latestDate=rows[-1]['date']),summary=dict(changedExpenseRows=sum(r['classificationChanged'] for r in expense),changedExpenseMerchants=len(set(r['merchant'] for r in expense if r['classificationChanged'])),allPeriodSpendingCents=spend(rows),quarterSpendingCents=qtotal,nonroutineDentalEpisodeCents=episode),fieldDefinitions={'classificationEvidence':'Fictitious demonstration evidence; not real classification research.'},reviewTotals={},confidenceCounts=dict(Counter(r['confidence'] for r in expense)),basisCounts={'synthetic_fixture':len(expense)},categoryTotals=[dict(category=k,totalCents=v) for k,v in totals(rows).items()],quarterCategoryTotals=qcats,merchantTotals=[],quarterMerchantTotals=[],changedRows=[r['id'] for r in rows if r['classificationChanged']],nonroutineEpisodes=[dict(label='Synthetic irregular expense',totalCents=episode)],publicMerchantSources=[],verification={'synthetic':True,'monthlyTotalsReconcile':True})
data=dict(schemaVersion='sample-1',isSynthetic=True,currency='USD',asOfDate='2031-10-01',defaultPeriod={'start':'2031-07-01','end':'2031-09-30'},amountConvention='Integer cents; spending positive and refunds negative. Non-spending records remain separate.',coverageNote='All records and labels are invented. Incomplete early coverage is a test case.',sources=sources,excludedSourceNote='No real source exports are included.',transactions=rows,monthly=monthly,quarter=quarter,income={'personA':{'netPerPaycheckCents':300000,'frequency':None,'synthetic':True},'personB':{'netPerPaycheckCents':None,'frequency':None,'synthetic':True},'householdCurrentMonthlyNetCents':None,'surplusAvailableForSavingsCents':None,'jointTwoPaycheckMonthExample':None},knownCommitments=[dict(id='sample-store-card',label='Sample store-card payment',monthlyCents=4000,status='synthetic',observedInSuppliedAccounts=False,type='debt',note='Invented example',owner='Person A')],recurring=[dict(id='sample-subscription',label='Sample media service',monthlyCents=3500,status='recurring_candidate',basis='Invented repeated merchant; not proof of a live subscription',category='Apps & subscriptions'),dict(id='sample-housing',label='Sample housing payment',monthlyCents=110000,status='synthetic',basis='Invented fixed payment',category='Mortgage')],uncertainties=[dict(id='income',priority='high',label='Income is incomplete',detail='Set both fictional pay frequencies or supply private inputs locally.')],recommendations=[dict(label='Replace sample assumptions',detail='Verify every value before using the model privately.')],reconciliation=dict(cardRepaymentPairs=[],checkingSavingsPairs=[],pairs=[],crossMainCardFileOverlap=0,duplicateRowsAutomaticallyRemoved=0,sourceRowCount=len(rows),currentLiquidBalanceCents=None,currentDebtBalanceCents=None),methodology=['Entirely invented data generated deterministically.','Transfers and debt repayments do not add to purchase spending.','Amounts use integer cents.'],categoryAudit=audit)
(ROOT/'data').mkdir(exist_ok=True)
(ROOT/'data/sample-data.json').write_text(json.dumps(data,indent=2)+'\n')
print(f'Generated {len(rows)} synthetic records, {len(monthly)} months; quarter cents = {qtotal}')
