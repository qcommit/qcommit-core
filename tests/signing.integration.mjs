import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js';
import { CONTEXT, intentDigest, makeReceipt, verifyReceipt, hex, serializeReceipt } from '../src/protocol.mjs';
import { encryptCreator, decryptCreator } from '../src/vault.mjs';
const base=JSON.parse(await readFile(new URL('../fixtures/orbital.receipt.json',import.meta.url),'utf8'));
const keys=slh.keygen(),dir=await mkdtemp(join(tmpdir(),'qcommit-signing-'));
try{
 const vault=await encryptCreator(keys.secretKey,'integration-test-only passphrase','Integration creator');
 const restored=await decryptCreator(vault,'integration-test-only passphrase');
 try{
  for(const name of ['Cross-implementation','Unicode π check']){
   const intent={...base.intent,creatorPublicKey:hex(keys.publicKey),name};
   const signature=slh.sign(await intentDigest(intent),restored,{context:new TextEncoder().encode(CONTEXT),extraEntropy:crypto.getRandomValues(new Uint8Array(16))});
   const receipt=await makeReceipt(intent,signature);
   assert.equal((await verifyReceipt(receipt)).signatureValid,true);
   const path=join(dir,'receipt.json');await writeFile(path,serializeReceipt(receipt),{mode:0o600});
   const result=JSON.parse(execFileSync('python3',[new URL('../cli/verify.py',import.meta.url).pathname,path,'--key',hex(keys.publicKey)],{encoding:'utf8'}));
   assert.equal(result.signatureValid,true);assert.equal(result.onchainVerified,false);
  }
 }finally{restored.fill(0);}
 console.log('Noble signing → encrypted backup → independent JS and Python verification passed (2 receipts).');
}finally{keys.secretKey.fill(0);await rm(dir,{recursive:true,force:true});}
