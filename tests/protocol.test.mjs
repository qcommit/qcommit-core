import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJson, parseReceipt, normalizeIntent, verifyReceipt, serializeReceipt, fingerprint, hex, unhex, intentDigest, unb64, SIGNATURE_BYTES } from '../src/protocol.mjs';
import { verifySlh } from '../src/slh-verify.mjs';
import { encryptCreator, decryptCreator, parseVault } from '../src/vault.mjs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/orbital.receipt.json',import.meta.url)));
const clone=()=>structuredClone(fixture);

test('native OpenSSL fixture verifies with all seven independent XMSS roots',async()=>{
 const result=await verifyReceipt(fixture,{expectedFingerprint:await fingerprint(fixture.intent.creatorPublicKey)});
 assert.equal(result.signatureValid,true);assert.equal(result.identityTrusted,true);assert.equal(result.onchainVerified,false);
 assert.equal(result.trace.layerRoots.length,7);assert.ok(result.trace.hashCalls>1000);
});
test('no supplied pin means valid cryptography but not a trusted creator identity',async()=>{
 const result=await verifyReceipt(fixture);assert.equal(result.signatureValid,true);assert.equal(result.identityTrusted,false);assert.equal(result.identityMatch,null);
});
test('wrong creator fingerprint stays separate from signature validity',async()=>{
 const result=await verifyReceipt(fixture,{expectedFingerprint:'00'.repeat(32)});assert.equal(result.signatureValid,true);assert.equal(result.identityTrusted,false);assert.equal(result.identityMatch,false);
});
test('all mutable descriptive and numeric token fields are bound by the signature',async()=>{
 for(const [key,value] of [['name','Altered'],['symbol','BAD'],['description','Different text'],['supply','100'],['decimals',5],['creatorLabel','Someone else'],['metadataUri','https://example.invalid/metadata.json'],['metadataSha256','12'.repeat(32)],['launchId','ab'.repeat(32)],['network','solana:mainnet']]){
  const receipt=clone();receipt.intent[key]=value;assert.equal((await verifyReceipt(receipt)).signatureValid,false,key);
 }
});
test('a different mathematically sized key is not accepted',async()=>{const r=clone();r.intent.creatorPublicKey='23'.repeat(32);assert.equal((await verifyReceipt(r)).signatureValid,false);});
test('signature mutation in FORS and each hypertree layer is rejected',async()=>{
 const sig=unb64(fixture.signature,SIGNATURE_BYTES),msg=await intentDigest(fixture.intent),key=unhex(fixture.intent.creatorPublicKey,32),ctx=new TextEncoder().encode(fixture.context);
 for(const offset of [0,16,2928,3632,4336,5040,5744,6448,7152,7855]){const copy=sig.slice();copy[offset]^=1;assert.equal((await verifySlh(msg,copy,key,ctx)).valid,false,offset);}
});
test('context is cryptographically bound',async()=>{assert.equal((await verifySlh(await intentDigest(fixture.intent),unb64(fixture.signature,SIGNATURE_BYTES),unhex(fixture.intent.creatorPublicKey,32),new TextEncoder().encode('OtherContext'))).valid,false);});
test('duplicate fields and oversized/deep JSON fail before verification',()=>{
 assert.throws(()=>parseReceipt(serializeReceipt(fixture).replace('"format":','"format":"duplicate", "format":')),/Duplicate/);
 assert.throws(()=>parseJson(' '.repeat(65537)));assert.throws(()=>parseJson('['.repeat(20)+'0'+']'.repeat(20)));
});
test('unknown fields and unsupported production scope fail closed',()=>{
 const r=clone();r.extra=true;assert.throws(()=>parseReceipt(r));
 r.intent.scope='production';delete r.extra;assert.throws(()=>parseReceipt(r));
});
test('canonical serialization is independent of transport field order',()=>{
 const r=clone();r.intent=Object.fromEntries(Object.entries(r.intent).reverse());assert.equal(serializeReceipt(r),serializeReceipt(fixture));
});
test('malformed base64 and truncated signatures are rejected',()=>{
 for(const signature of [fixture.signature.slice(0,-4),fixture.signature+'\n',fixture.signature.replace(/A/,'-')])assert.throws(()=>parseReceipt({...fixture,signature}));
});
test('funding and recipient addresses must encode exactly 32 bytes',()=>{
 for(const value of ['abc','0'.repeat(32),'1'.repeat(31),'1'.repeat(33)]){
  const r=clone();r.intent.recipient=value;assert.throws(()=>parseReceipt(r));
 }
});
test('exact u64 supply bounds and decimals reject unsafe coercion',()=>{
 for(const [supply,decimals] of [['1e9',6],['0',6],['01',6],['18446744073709551615',1],['1',true],['1',10],['1',-1]]){
  const r=clone();r.intent.supply=supply;r.intent.decimals=decimals;assert.throws(()=>parseReceipt(r));
 }
});
test('permissions and metadata schemas cannot silently change',()=>{
 for(const patch of [{mintAuthority:'keep'},{freezeAuthority:'creator'},{metadataUri:'javascript:alert(1)'},{metadataSha256:'AA'.repeat(32)},{name:'bad\u0000text'}])assert.throws(()=>normalizeIntent({...fixture.intent,...patch}));
});
test('expiry and future issue times are reported independently of signature validity',async()=>{
 const expired=await verifyReceipt(fixture,{now:Date.parse(fixture.intent.expiresAt)+1});assert.equal(expired.signatureValid,true);assert.equal(expired.authorizationExpired,true);
 const future=await verifyReceipt(fixture,{now:Date.parse(fixture.intent.issuedAt)-1});assert.equal(future.issuedInFuture,true);
});
test('encrypted vault roundtrip preserves key bytes without plaintext storage',async()=>{
 const secret=crypto.getRandomValues(new Uint8Array(64)),passphrase='test-only passphrase with length';
 const vault=await encryptCreator(secret,passphrase,'Unit test creator');assert.equal(vault.publicKey,hex(secret.slice(32)));assert.ok(!JSON.stringify(vault).includes(hex(secret)));
 assert.deepEqual(await decryptCreator(JSON.stringify(vault),passphrase),secret);secret.fill(0);
});
test('incorrect passphrase and authenticated metadata edits fail vault decryption',async()=>{
 const secret=crypto.getRandomValues(new Uint8Array(64)),vault=await encryptCreator(secret,'test-only passphrase with length','Test creator');
 await assert.rejects(decryptCreator(vault,'different passphrase with length'));
 for(const patch of [{label:'Tampered label'},{publicKey:'12'.repeat(32)}])await assert.rejects(decryptCreator({...vault,...patch},'test-only passphrase with length'));
 secret.fill(0);
});
test('vault KDF cannot be downgraded or escalated by untrusted backup fields',async()=>{
 const secret=new Uint8Array(64),vault=await encryptCreator(secret,'test-only passphrase with length','Test creator');
 for(const patch of [{iterations:1},{iterations:600001},{kdf:'scrypt'},{format:'other'},{extra:true}])assert.throws(()=>parseVault({...vault,...patch}));
});

test('a matching fingerprint never makes an invalid signature a trusted authorization',async()=>{const r=clone();r.intent.name='Altered token';const result=await verifyReceipt(r,{expectedFingerprint:await fingerprint(r.intent.creatorPublicKey)});assert.equal(result.identityMatch,true);assert.equal(result.signatureValid,false);assert.equal(result.identityTrusted,false);});
test('JS/Python agree on URI, whitespace and timestamp edge cases',async()=>{
 const {spawnSync}=await import('node:child_process');
 const entries=[['metadataUri','https://example.com/π',true],['metadataUri','ipfs://bafy.test/path',true],['metadataUri','ar://example_id',true],['metadataUri','HTTPS://EXAMPLE.COM',true],['metadataUri','https://@example.com',false],['metadataUri','https:///example.com',false],['metadataUri','https://example.com\\@foo',false],['metadataUri','https:example.com',false],['metadataUri','ipfs:',false],['metadataUri','https://example.com:65536',false],['creatorLabel','\ufeff',false],['name','\u0085',true],['issuedAt','0000-01-01T00:00:00.000Z',false]];
 const inputs=entries.map(([key,value])=>({...fixture.intent,[key]:value}));const expected=entries.map(x=>x[2]);
 assert.deepEqual(inputs.map(i=>{try{normalizeIntent(i);return true;}catch{return false;}}),expected);
 const r=spawnSync('python3',['tests/parser_compare.py'],{input:JSON.stringify(inputs),encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),expected);
});
