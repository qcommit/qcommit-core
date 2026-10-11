from pathlib import Path
import datetime,subprocess,json,hashlib,time,sys
root=Path(__file__).resolve().parents[1];out=root/'evidence';out.mkdir(exist_ok=True)
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Local CPU-only preview core; no browser, chain transactions or deployment','phases':[],'passed':False}
for name,args in [('install',['npm','ci','--ignore-scripts','--no-audit','--no-fund']),('application',['npm','test']),('signing',['npm','run','test:signing']),('nist',['npm','run','test:vectors']),('mutations',['npm','run','test:mutations']),('release-source',['python3','scripts/check-source.py'])]:
 start=time.monotonic();p=subprocess.run(args,cwd=root,capture_output=True,text=True,timeout=90)
 (out/(name+'.log')).write_text(p.stdout+p.stderr);r['phases'].append({'name':name,'command':args,'exitCode':p.returncode,'seconds':round(time.monotonic()-start,3)})
 print(name,'exit',p.returncode,flush=True)
 if p.returncode!=0:r['error']=name+' failed';print((p.stdout+p.stderr)[-1500:]);break
else:r['passed']=True
r['sourceHashes']={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['src','cli','tests'] for p in (root/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts}
(out/'validation.json').write_text(json.dumps(r,indent=2)+'\n');sys.exit(0 if r['passed'] else 1)
