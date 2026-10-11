"""Review publishable paths and public-fixture provenance without runtime reads."""
from pathlib import Path
import subprocess,json,hashlib,re
root=Path(__file__).resolve().parents[1]
files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
count=0
for name in filter(None,files):
 p=root/name
 assert not p.is_symlink(), 'Symlink requires review: '+name
 assert not any(x in Path(name).parts for x in ['node_modules','.runtime','__pycache__','.git']),name
 assert not name.endswith(('.pem','.key','.keystore.json','.encrypted.json')),name
 raw=p.read_bytes();assert not re.search(rb'-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----',raw),name
 count+=1
for name in ['README.md','LICENSE','SECURITY.md','package-lock.json','.github/workflows/check.yml','docs/PROTOCOL.md']:
 assert (root/name).is_file(),name
f=json.loads((root/'fixtures/PROVENANCE.json').read_text());assert hashlib.sha256((root/'fixtures/orbital.receipt.json').read_bytes()).hexdigest()==f['sha256']
n=json.loads((root/'fixtures/nist/PROVENANCE.json').read_text())
for x in n['nistSources']:assert hashlib.sha256((root/'fixtures/nist'/ (x['mode']+'.json')).read_bytes()).hexdigest()==x['subsetSha256']
print(json.dumps({'publishableFiles':count,'fixtureHashesMatch':True,'scope':'Path, PEM-marker and fixture integrity check; not a comprehensive secret scanner or security audit'}))
