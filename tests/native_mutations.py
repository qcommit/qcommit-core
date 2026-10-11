"""Component-level rejection sweep using the independent native verifier."""
import sys,json,base64,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'cli'))
from slh_verify import verify
from verify import FIELDS,verify_receipt
root=Path(__file__).resolve().parents[1]
r=json.loads((root/'fixtures/orbital.receipt.json').read_text())
i=r['intent'];msg=hashlib.sha256(b'Qcommit/LaunchPreview/v1\0'+json.dumps({k:i[k] for k in FIELDS},separators=(',',':'),ensure_ascii=False).encode()).digest()
sig=base64.b64decode(r['signature']);key=bytes.fromhex(i['creatorPublicKey']);ctx=r['context'].encode()
assert verify(msg,sig,key,ctx)
for offset in range(0,len(sig),16):
 damaged=bytearray(sig);damaged[offset]^=1
 assert not verify(msg,bytes(damaged),key,ctx),offset
report={'status':'passed','cases':len(sig)//16,'componentBytes':16,'fixture':'OpenSSL-generated reference; not NIST corpus','scope':'one altered byte per signature component; independent Python verifier','onchainTests':0}
print(json.dumps(report,indent=2))
