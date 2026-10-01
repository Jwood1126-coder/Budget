"""Validate the synthetic assembled artifact and fixture without accessing private data."""
from html.parser import HTMLParser
from pathlib import Path
from collections import Counter
import json, re
root=Path(__file__).resolve().parent
class Audit(HTMLParser):
    def __init__(self):
        super().__init__();self.ids=[];self.scripts={};self.script=None;self.links=[]
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if 'id' in attrs:self.ids.append(attrs['id'])
        if tag=='script':self.script=attrs.get('id');self.scripts[self.script]=''
        if tag=='a':self.links.append(attrs.get('href',''))
    def handle_endtag(self,tag):
        if tag=='script':self.script=None
    def handle_data(self,data):
        if self.script:self.scripts[self.script]+=data
parser=Audit();parser.feed((root/'dist/index.html').read_text())
assert len(parser.ids)==len(set(parser.ids)),'Duplicate HTML IDs'
raw=json.loads(parser.scripts['budget-data'])
fixture=json.loads((root/'data/sample-data.json').read_text())
assert raw==fixture,'Validation requires a sample build: python3 assemble.py --sample'
assert raw['isSynthetic'] is True
assert json.loads(parser.scripts['budget-state'])=={'copyId':'local-sample','state':None}
refs=set(re.findall(r"\$\('([^']+)'\)",(root/'app.js').read_text()))
dynamic={'adjust-airfare','adjust-business','adjust-airfare-amount','adjust-business-amount'}
assert not refs-set(parser.ids)-dynamic,'Missing HTML targets'
assert all(not url.startswith(('javascript:','http:','https:')) for url in parser.links),'Unexpected outbound link'
assert all(x in parser.ids for x in ['overview','spending','plan','future','review','forecastRows','spendingDrill','categoryComparison','compareMonth','baselineMonths'])
rows=raw['transactions'];ids=[r['id'] for r in rows]
assert len(ids)==len(set(ids))
assert all(r['merchant'].startswith('Sample ') for r in rows)
assert all(isinstance(r['amountCents'],int) for r in rows)
assert all(r['classificationEvidence']['basis']=='synthetic_fixture' for r in rows)
assert len(rows)==sum(s['rowCount'] for s in raw['sources'])
assert set(r['source'] for r in rows)==set(s['id'] for s in raw['sources'])
for m in raw['monthly']:
    selected=[r for r in rows if r['date'].startswith(m['month'])]
    assert len(selected)==m['transactionCount']
    assert sum(r['amountCents'] for r in selected if r['kind']=='spend')==m['spendingCents']
    assert sum(m['categoriesCents'].values())==m['spendingCents']
q=[r for r in rows if raw['defaultPeriod']['start']<=r['date']<=raw['defaultPeriod']['end']]
assert sum(r['amountCents'] for r in q if r['kind']=='spend')==raw['quarter']['spendingCents']
assert sum(c['totalCents'] for c in raw['quarter']['categories'])==raw['quarter']['spendingCents']
assert sum(r['amountCents'] for r in q if 'nonroutine_dental_episode' in r['flags'])==raw['quarter']['nonroutineDentalEpisodeCents']
assert {'spend','income','card_payment','transfer','investment','debt_payment'}<=set(r['kind'] for r in rows)
assert any(r['amountCents']<0 for r in rows)
assert any(not m['hasMainCardCoverage'] for m in raw['monthly'])
assert any(r['needsCategoryReview'] for r in rows)
assert any('reimbursement_candidate' in r['flags'] for r in rows)
assert any('business_candidate' in r['flags'] for r in rows)
assert not (root/'.openai').exists(),'No deployment metadata in source export'
print(f'PASS fixture: {len(rows)} invented records, {len(raw["monthly"])} months, {raw["quarter"]["spendingCents"]} baseline cents')
print('PASS HTML IDs, all five views, safe links, sample-only embedded state, monthly/quarter reconciliation, review and cash-flow cases')
