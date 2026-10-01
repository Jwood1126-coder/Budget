"""Build a self-contained local HTML file. A private input takes precedence if present."""
import argparse
import json
from pathlib import Path
root=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--sample',action='store_true',help='Ignore any private input and build only the public synthetic fixture.')
args=parser.parse_args()
private=root/'data/budget-data.json'
source=private if private.exists() and not args.sample else root/'data/sample-data.json'
data=json.loads(source.read_text())
for key in ['transactions','monthly','quarter','sources','recurring','defaultPeriod']:
    if key not in data:raise ValueError(f'Missing required data field: {key}')
def safe_json(value):return json.dumps(value,separators=(',',':'),ensure_ascii=False).replace('<','\\u003c')
content=(root/'layout.html').read_text().replace('__STYLE__',(root/'style.css').read_text()).replace('__SCRIPT__',(root/'math.js').read_text()+'\n'+(root/'app.js').read_text()).replace('__DATA__',safe_json(data)).replace('__STATE__',safe_json({'copyId':'local-sample' if source.name=='sample-data.json' else 'local-private','state':None}))
(root/'dist').mkdir(exist_ok=True)
(root/'dist/index.html').write_text(content)
print(f'Assembled {len(content.encode()):,} bytes from {source.name}')
if source==private:print('PRIVATE BUILD: dist/index.html embeds all input records. Do not commit, upload, or publish it.')
