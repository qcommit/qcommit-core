// Actual offline CLI key generation, encrypted backup and registration signing.
// Temporary synthetic secret material only; no RPC or transaction submission.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import * as sdk from '../index.mjs';
const dir=mkdtempSync(join(tmpdir(),'qcommit-cli-identity-'));
const run=(...args)=>spawnSync(process.execPath,['sdk/cli.mjs',...args],{encoding:'utf8',timeout:90000,maxBuffer:65536});
try{
 const password=join(dir,'passphrase'),vaultPath=join(dir,'creator.vault.json'),request=join(dir,'register.request.json'),signedPath=join(dir,'registration.signed.json');
 writeFileSync(password,'Synthetic offline CLI test passphrase 2026!',{mode:0o600});
 let r=run('create-identity','--label','Offline test creator','--passphrase-file',password,'--out',vaultPath);assert.equal(r.status,0,r.stderr);
 const vault=JSON.parse(readFileSync(vaultPath));assert.equal(vault.format,'qcommit/creator-vault/1');assert.equal(Object.hasOwn(vault,'secretKey'),false);
 const fixture=JSON.parse(readFileSync(new URL('./launch-intent-vector.json',import.meta.url))),base=fixture.registration;
 const salt=sdk.defaultCreatorSalt(base,base.payer,vault.publicKey),creator=sdk.deriveCreator(base.program,base.genesis,base.deploymentId,base.payer,vault.publicKey,salt).creator.toBase58();
 const registration={...base,creator,creatorPublicKey:vault.publicKey,salt:sdk.hex(salt)},digest=sdk.registrationDigest(registration);
 writeFileSync(request,JSON.stringify({format:'qcommit/production-request/1',kind:'registration',creatorPublicKey:vault.publicKey,context:sdk.CONTEXT,registration,digest:sdk.hex(digest),estimate:{scope:'offline fixture; no RPC estimate'}}));
 r=run('sign','--request',request,'--vault',vaultPath,'--passphrase-file',password,'--out',signedPath);assert.equal(r.status,0,r.stderr);
 const signed=JSON.parse(readFileSync(signedPath));assert.equal(signed.format,'qcommit/creator-registration/1');assert.equal(await sdk.verifyApproval({digest,signature:signed.signature,creatorPublicKey:vault.publicKey}),true);
 writeFileSync(password,'Deliberately incorrect test passphrase',{mode:0o600});r=run('sign','--request',request,'--vault',vaultPath,'--passphrase-file',password,'--out',join(dir,'wrong.json'));assert.notEqual(r.status,0);assert.equal(existsSync(join(dir,'wrong.json')),false);
 console.log(JSON.stringify({passed:true,checks:4,scope:'Actual offline CLI identity creation/encryption/restoration/signature and incorrect-password rejection; no network transactions'}));
}finally{rmSync(dir,{recursive:true,force:true});}
