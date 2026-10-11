import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { encodeIntent, decodeIntent, concat, u16, utf8 } from '../codec.mjs';
const vector=JSON.parse(readFileSync(new URL('../tests/launch-intent-vector.json',import.meta.url)));
const corpus=JSON.parse(readFileSync(new URL('../tests/launch-text-corpus.json',import.meta.url)));
function replaceWireField(field,value){
 const raw=encodeIntent(vector.intent);let offset=321;
 for(const name of ['name','symbol','metadataUri']){
  const n=raw[offset]+raw[offset+1]*256;
  if(name===field){const bytes=utf8(value);return concat(raw.slice(0,offset),u16(bytes.length),bytes,raw.slice(offset+2+n));}
  offset+=2+n;
 }
 throw Error('Unknown fixture field');
}
test('165 shared Rust/JS text cases agree for object encoding and raw-wire decoding',()=>{
 assert.equal(corpus.cases.length,165);
 for(const c of corpus.cases){
  const input={...vector.intent,[c.field]:c.value},wire=replaceWireField(c.field,c.value);
  if(c.valid){assert.doesNotThrow(()=>encodeIntent(input),c.id+' encode');const decoded=decodeIntent(wire);assert.equal(decoded[c.field],c.value,c.id+' unchanged');assert.deepEqual(encodeIntent(decoded),wire,c.id+' exact bytes');}
  else{assert.throws(()=>encodeIntent(input),undefined,c.id+' encode');assert.throws(()=>decodeIntent(wire),undefined,c.id+' decode');}
 }
});
test('Raw UTF-8 decoder rejects invalid bytes and preserves an interior BOM',()=>{
 const bad=replaceWireField('name','Name');bad[323]=255;assert.throws(()=>decodeIntent(bad));
 const bom=replaceWireField('name','\ufeffName');assert.throws(()=>decodeIntent(bom));
 const valid=replaceWireField('name','A\ufeffB');assert.equal(decodeIntent(valid).name,'A\ufeffB');
});
