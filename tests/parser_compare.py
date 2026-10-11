import sys,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'cli'))
from verify import validate_intent
out=[]
for i in json.loads(sys.stdin.read()):
 try:validate_intent(i);out.append(True)
 except (ValueError,UnicodeError):out.append(False)
print(json.dumps(out))
