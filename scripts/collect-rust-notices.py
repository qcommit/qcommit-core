"""Collect shipped license/notice files for the locked Rust dependency graph.

The inventory is deliberately inclusive of build/test dependencies. It does not
claim that every listed package is linked into the deployed executable.
"""
import hashlib,json,os,subprocess,sys,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
out=Path(sys.argv[1]).resolve() if len(sys.argv)==2 else root/'.runtime/distribution-notices'
out.mkdir(parents=True,exist_ok=True)
metadata=json.loads(subprocess.check_output(['cargo','metadata','--format-version','1','--locked','--offline'],cwd=root,text=True))
records=[];archive=out/'rust-dependency-notices.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for package in sorted(metadata['packages'],key=lambda p:(p['name'],p['version'])):
  directory=Path(package['manifest_path']).parent
  record={'name':package['name'],'version':package['version'],'declaredLicense':package.get('license'),'source':package.get('source'),'notices':[]}
  for p in sorted(directory.iterdir()):
   if not p.is_file() or p.is_symlink() or not p.name.upper().startswith(('LICENSE','LICENCE','COPYING','NOTICE','COPYRIGHT')):continue
   data=p.read_bytes()
   if len(data)>512000:raise ValueError('Unexpected notice size')
   name=package['name']+'-'+package['version']+'/'+p.name
   info=zipfile.ZipInfo(name,date_time=(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16;z.writestr(info,data)
   record['notices'].append({'path':name,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
  records.append(record)
 inventory={'format':'qcommit/locked-rust-license-inventory/1','scope':'Inclusive locked workspace graph; build/test-only dependencies may be present. Original notices are unmodified.','cargoLockSha256':hashlib.sha256((root/'Cargo.lock').read_bytes()).hexdigest(),'packages':records}
 z.writestr('INVENTORY.json',json.dumps(inventory,indent=2)+'\n')
(out/'rust-dependency-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
print(json.dumps({'packages':len(records),'packagesWithShippedNotices':sum(bool(p['notices']) for p in records),'archiveBytes':archive.stat().st_size,'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'scope':inventory['scope']}))
