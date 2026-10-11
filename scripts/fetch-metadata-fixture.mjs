#!/usr/bin/env node
// Read-only acquisition of the exact canonical external program used by tests.
// No signing, deployments, key loading, or transaction submission.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {Connection,PublicKey} from '@solana/web3.js';
const out=resolve(process.argv[2]??'.runtime/program-fixtures');
const rpc='https://api.mainnet-beta.solana.com';
const program=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const expected='31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011';
const connection=new Connection(rpc,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(url,init)=>fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000)})});
const genesis=await connection.getGenesisHash();
if(genesis!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new Error('Unexpected genesis.');
const p=await connection.getAccountInfo(program,'finalized');
if(!p?.executable||!p.owner.equals(loader)||p.data.length!==36||p.data.readUInt32LE(0)!==2) throw new Error('Unexpected external program loader.');
const programData=new PublicKey(p.data.subarray(4));
if(!PublicKey.findProgramAddressSync([program.toBuffer()],loader)[0].equals(programData)) throw new Error('Noncanonical ProgramData.');
const result=await connection.getAccountInfoAndContext(programData,'finalized'),d=result.value;
if(!d||d.executable||!d.owner.equals(loader)||d.data.length<45||d.data.readUInt32LE(0)!==3||d.data[12]!==0) throw new Error('Fixture requires the expected immutable external program.');
const binary=d.data.subarray(45),hash=createHash('sha256').update(binary).digest('hex');
if(binary.length!==793991||hash!==expected) throw new Error('External program differs from the tested binary; review a new fixture explicitly.');
const receipt={checkedAt:new Date().toISOString(),source:'Read-only finalized mainnet accounts; no transactions',rpc,genesis,program:program.toBase58(),programData:programData.toBase58(),contextSlot:result.context.slot,deploymentSlot:d.data.readBigUInt64LE(4).toString(),upgradeAuthority:null,binaryBytes:binary.length,binarySha256:hash,purpose:'External local-validator fixture only; fetched separately and not distributed as Qcommit source'};
await mkdir(out,{recursive:true});
await writeFile(join(out,'metaplex-token-metadata.so'),binary,{flag:'wx'});
await writeFile(join(out,'metaplex-provenance.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt,null,2));
