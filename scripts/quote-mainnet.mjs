#!/usr/bin/env node
// Read-only deployment quote. This script cannot sign or submit a transaction.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const args=process.argv.slice(2);
if(args.length<1 || args.length>2) throw new Error('Usage: node scripts/quote-mainnet.mjs BINARY.so [NEW-OUTPUT.json]');
const binary=await readFile(resolve(args[0]));
if(binary.length<4 || binary.length>10485760 || binary.subarray(0,4).toString('hex')!=='7f454c46') throw new Error('Expected a bounded compiled ELF program.');
const rpc='https://api.mainnet-beta.solana.com';
let id=0;
async function call(method,params=[]){
 const requestId=++id;
 const response=await fetch(rpc,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}),signal:AbortSignal.timeout(15000)});
 if(!response.ok) throw new Error(`RPC HTTP ${response.status}`);
 const value=await response.json();
 if(value.id!==requestId || value.error || !Object.hasOwn(value,'result')) throw new Error('RPC did not return the requested quote.');
 return value.result;
}
const genesis=await call('getGenesisHash');
if(genesis!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new Error('Wrong genesis: expected mainnet-beta.');
const rent={};
for(const [label,bytes] of Object.entries({programAccount:36,programData:binary.length+45,uploadBuffer:binary.length+37,configuration:105})){
 const lamports=await call('getMinimumBalanceForRentExemption',[bytes,{commitment:'finalized'}]);
 if(!Number.isSafeInteger(lamports)||lamports<0) throw new Error('Invalid rent quote.');
 rent[label]={bytes,lamports:String(lamports)};
}
const permanent=BigInt(rent.programAccount.lamports)+BigInt(rent.programData.lamports)+BigInt(rent.configuration.lamports);
const quote={format:'qcommit/deployment-rent-quote/1',checkedAt:new Date().toISOString(),cluster:'mainnet-beta',genesis,rpc,programBytes:binary.length,programSha256:createHash('sha256').update(binary).digest('hex'),rent,permanentRentLamports:String(permanent),conservativePeakRentLamports:String(permanent+BigInt(rent.uploadBuffer.lamports)),networkFeesIncluded:false,feePayerSelected:false,transactionsSubmitted:0,notes:['Quote assumes exact program allocation with no growth reserve.','Conservative peak includes both upload buffer and deployed program allocation. Confirm actual loader funding flows in the final deployment plan.','After irreversible authority removal, deployed program rent cannot be reclaimed by closing the program.','Re-quote the final artifact immediately before wallet approval. No private key or default wallet is read.']};
if(args[1]) await writeFile(resolve(args[1]),JSON.stringify(quote,null,2)+'\n',{flag:'wx',mode:0o644});
console.log(JSON.stringify(quote,null,2));
