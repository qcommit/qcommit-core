import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'cli'))
from slh_verify import verify
count=0
for mode in ['sigVer','sigGen']:
 d=json.loads(Path('fixtures/nist/'+mode+'.json').read_text())
 for g in d['testGroups']:
  for t in g['tests']:
   actual=verify(bytes.fromhex(t['message']),bytes.fromhex(t['signature']),bytes.fromhex(t['pk']),bytes.fromhex(t['context']))
   expected=True if mode=='sigGen' else t['testPassed']
   assert bool(actual)==expected, 'Python tc'+str(t['tcId']);count+=1
print(json.dumps({'cases':count,'passed':True}))
