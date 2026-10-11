import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { verifySlh } from '../src/slh-verify.mjs';
const provenance=JSON.parse(await readFile('fixtures/nist/PROVENANCE.json','utf8'));
const hex=s=>Uint8Array.from(Buffer.from(s,'hex'));const cases=[];
for(const entry of provenance.nistSources){
 const raw=await readFile('fixtures/nist/'+entry.mode+'.json');assert.equal(createHash('sha256').update(raw).digest('hex'),entry.subsetSha256);
 const doc=JSON.parse(raw);
 for(const g of doc.testGroups)for(const t of g.tests){
  assert.equal(g.parameterSet,'SLH-DSA-SHA2-128s');assert.equal(g.signatureInterface,'external');assert.equal(g.preHash,'pure');
  const expected=entry.mode==='sigGen'?true:t.testPassed;
  assert.equal((await verifySlh(hex(t.message),hex(t.signature),hex(t.pk),hex(t.context))).valid,expected,'JS tc'+t.tcId);
  cases.push({mode:entry.mode,tcId:t.tcId,expectedValid:expected,passed:true});
 }
}
const p=spawnSync('python3',['tests/nist.py'],{encoding:'utf8',timeout:30000});assert.equal(p.status,0,p.stderr);const python=JSON.parse(p.stdout);assert.equal(cases.length,28);assert.equal(python.cases,28);
await mkdir('evidence',{recursive:true});await writeFile('evidence/nist.json',JSON.stringify({profile:'SLH-DSA-SHA2-128s',scope:'28 selected external pure verification comparisons per implementation; sigGen outputs verified, not regenerated; no comprehensive conformance claim',cases,python,passed:true},null,2)+'\n');console.log('28 published signatures checked by independent JS and Python.');
