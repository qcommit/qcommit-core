// Operator-only policy for a single reviewed binary. No private keys or signing.
import {PublicKey,Transaction,SystemProgram,SYSVAR_RENT_PUBKEY,SYSVAR_CLOCK_PUBKEY,ComputeBudgetProgram} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {sha256} from '@noble/hashes/sha2.js';
import {parseJson} from '../src/json.mjs';
import {handleRpc} from './rpc.mjs';
import {verifyNativeDeployment} from '../sdk/deployer.mjs';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const GENESIS={
 'mainnet-beta':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
 devnet:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
};
const utf8=new TextDecoder('utf-8',{fatal:true});
const equal=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
const check=(v,message)=>{if(!v)throw new Error(message);};
function u32(b,o=0){check(o+4<=b.length,'Truncated u32');return new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(o,true);}
function u64(b,o=0){check(o+8<=b.length,'Truncated u64');return new DataView(b.buffer,b.byteOffset,b.byteLength).getBigUint64(o,true);}
function bytesHex(s){check(typeof s==='string'&&/^[0-9a-f]{64}$/.test(s),'Expected a canonical digest');return Uint8Array.from(s.match(/../g),x=>parseInt(x,16));}
function key(s){const p=new PublicKey(s);check(typeof s==='string'&&p.toBase58()===s,'Noncanonical public key');return p;}
function accounts(ix,expected,authority){
 check(ix.keys.length===expected.length,'Unexpected instruction accounts');
 for(let i=0;i<expected.length;i++){
  const [pubkey,writable=false]=expected[i],actual=ix.keys[i];
  check(actual.pubkey.equals(pubkey),'Instruction account substitution');
  check(actual.isSigner===pubkey.equals(authority),'Unexpected signer privileges');
  check(actual.isWritable===(writable||pubkey.equals(authority)),'Unexpected writable privileges');
 }
}
export async function operatorPlan(header,cluster){
 const p=parseJson(header,1024),fields=['format','authority','programSeed','bufferSeed','deploymentId'];
 check(p&&Object.keys(p).length===fields.length&&fields.every(x=>Object.hasOwn(p,x)),'Invalid deployment header fields');
 check(p.format==='qcommit/deployment-plan/1'&&Object.hasOwn(GENESIS,cluster),'Invalid deployment header/cluster');
 const authority=key(p.authority);
 check(/^[0-9a-f]{32}$/.test(p.programSeed)&&/^[0-9a-f]{32}$/.test(p.bufferSeed)&&p.programSeed!==p.bufferSeed,'Expected distinct public deployment seeds');
 const deployment=bytesHex(p.deploymentId);check(deployment.some(Boolean),'Deployment ID must be nonzero');
 const program=await PublicKey.createWithSeed(authority,p.programSeed,LOADER),buffer=await PublicKey.createWithSeed(authority,p.bufferSeed,LOADER);
 const [programData]=PublicKey.findProgramAddressSync([program.toBytes()],LOADER),[config]=PublicKey.findProgramAddressSync([new TextEncoder().encode('config')],program);
 return Object.freeze({...p,authority,program,buffer,programData,config,genesis:new PublicKey(GENESIS[cluster]),deployment});
}
export function operatorTransactionPolicy(plan,binary,{binarySha256,rentForSize,inspectState}){
 check(binary instanceof Uint8Array&&binary.length>4&&binary.length<=2*1024*1024,'Invalid reviewed binary');
 check(equal(sha256(binary),bytesHex(binarySha256)),'Reviewed binary hash mismatch');
 check(typeof rentForSize==='function','Current rent verifier required');
 check(typeof inspectState==='function','Current deployment state verifier required');
 const p=plan;
 async function create(ix,which,signal){
  check(ix.programId.equals(SystemProgram.programId)&&u32(ix.data)===3,'Only seeded account creation is permitted');
  const b=ix.data;check(b.length===124,'Unexpected seeded account length');
  check(equal(b.subarray(4,36),p.authority.toBytes())&&u64(b,36)===32n,'Wrong base or seed length');
  const seed=utf8.decode(b.subarray(44,76));
  check(seed===(which==='buffer'?p.bufferSeed:p.programSeed),'Wrong deployment seed');
  const space=which==='buffer'?binary.length+37:36;
  check(u64(b,84)===BigInt(space)&&equal(b.subarray(92),LOADER.toBytes()),'Wrong allocation size or owner');
  const rent=BigInt(await rentForSize(space,signal));
  check(rent>0n&&rent<=3000000000n&&u64(b,76)===rent,'Account funding must equal current exact rent');
  accounts(ix,[[p.authority,true],[which==='buffer'?p.buffer:p.program,true]],p.authority);
 }
 function init(ix){
  check(ix.programId.equals(LOADER)&&ix.data.length===4&&u32(ix.data)===0,'Buffer creation must atomically initialize authority');
  accounts(ix,[[p.buffer,true],[p.authority]],p.authority);
 }
 function deploy(ix){
  check(ix.programId.equals(LOADER)&&ix.data.length===12&&u32(ix.data)===2&&u64(ix.data,4)===BigInt(binary.length),'Only exact reviewed maximum program length is permitted');
  accounts(ix,[[p.authority,true],[p.programData,true],[p.program,true],[p.buffer,true],[SYSVAR_RENT_PUBKEY],[SYSVAR_CLOCK_PUBKEY],[SystemProgram.programId],[p.authority]],p.authority);
 }
 return async function validate(base64,_expected,{allowUnsigned=false,signal}={}){
  check(typeof base64==='string'&&base64.length<=1644&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64),'Invalid bounded base64');
  const wire=Buffer.from(base64,'base64');check(wire.length<=1232&&wire.toString('base64')===base64,'Noncanonical transaction encoding');
  const tx=Transaction.from(wire),message=tx.compileMessage();
  check(message.version==='legacy'&&message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0,'Only one-wallet legacy messages are permitted');
  check(tx.feePayer?.equals(p.authority)&&tx.signatures.length===1&&tx.signatures[0].publicKey.equals(p.authority),'Wrong funding wallet');
  check(equal(tx.serialize({requireAllSignatures:false,verifySignatures:false}),wire),'Noncanonical transaction bytes');
  check(new Set(message.accountKeys.map(x=>x.toBase58())).size===message.accountKeys.length,'Duplicate account keys');
  if(!allowUnsigned)check(tx.verifySignatures(),'Operator transaction must carry a valid wallet signature');
  else if(tx.signatures[0].signature!==null)check(tx.verifySignatures(),'Invalid supplied wallet signature');
  const body=[],budget=new Set();
  for(const ix of tx.instructions){
   if(ix.programId.equals(ComputeBudgetProgram.programId)){
    check(body.length===0&&ix.keys.length===0&&!budget.has(ix.data[0]),'Compute budget must be unique and first');budget.add(ix.data[0]);
    if(ix.data[0]===2)check(ix.data.length===5&&u32(ix.data,1)>0&&u32(ix.data,1)<=1200000,'Invalid compute limit');
    else if(ix.data[0]===3)check(ix.data.length===9&&u64(ix.data,1)<=1000000n,'Invalid priority fee');
    else throw new Error('Unsupported compute operation');
   }else body.push(ix);
  }
  check(body.length>=1&&body.length<=2&&tx.instructions.length<=4,'Unexpected operator instruction count');
  if(body.length===2){
   if(body[1].programId.equals(LOADER)&&u32(body[1].data)===0){await create(body[0],'buffer',signal);init(body[1]);}
   else {await create(body[0],'program',signal);deploy(body[1]);await inspectState('deploy',signal);}
  }else{
   const ix=body[0];
   if(ix.programId.equals(p.program)){
    check(ix.data.length===65&&ix.data[0]===0&&equal(ix.data.subarray(1,33),p.genesis.toBytes())&&equal(ix.data.subarray(33),p.deployment),'Only exact configuration bootstrap is permitted');
    accounts(ix,[[p.authority,true],[p.config,true],[p.program],[p.programData],[SystemProgram.programId]],p.authority);
    await inspectState('bootstrap',signal);
   }else{
    check(ix.programId.equals(LOADER),'Unrelated program invocation');
    const tag=u32(ix.data);
    if(tag===1){
     check(ix.data.length>=17&&ix.data.length<=916,'Invalid write size');
     const off=u32(ix.data,4),len=u64(ix.data,8);
     check(len===BigInt(ix.data.length-16)&&off+Number(len)<=binary.length&&off%900===0&&Number(len)===Math.min(900,binary.length-off),'Invalid reviewed write range');
     check(equal(ix.data.subarray(16),binary.subarray(off,off+Number(len))),'Upload differs from reviewed binary');
     accounts(ix,[[p.buffer,true],[p.authority]],p.authority);
    }else{
     check(tag===4&&ix.data.length===4,'Only buffer writes and irreversible authority removal are permitted');
     accounts(ix,[[p.programData,true],[p.authority]],p.authority);
     await inspectState('finalize',signal);
    }
   }
  }
  // No unused writable keys may be smuggled into an otherwise approved message.
  const used=new Set([p.authority.toBase58()]);for(const ix of tx.instructions){used.add(ix.programId.toBase58());for(const a of ix.keys)used.add(a.pubkey.toBase58());}
  check(used.size===message.accountKeys.length&&message.accountKeys.every(k=>used.has(k.toBase58())),'Unused message accounts');
  return wire;
 };
}
export async function handleOperatorRpc(request,{upstream,allowedOrigin,binary,binarySha256,enabled=false},fetchImpl=(url,options)=>globalThis.fetch(url,options)){
 try{
  const url=new URL(request.url),match=/^\/rpc\/operator\/(mainnet-beta|devnet)$/.exec(url.pathname);
  check(match&&!url.search,'Unknown operator route');check(enabled===true,'Operator deployment is disabled');
  const p=await operatorPlan(request.headers.get('x-qcommit-deployment')??'',match[1]);
  const read=async(method,params,signal)=>{
   const r=await fetchImpl.call(globalThis,upstream,{method:'POST',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'qcommit-operator-read',method,params}),signal});
   check(r.status===200&&r.body,'Current deployment read refused');
   const reader=r.body.getReader(),parts=[];let size=0;const abort=()=>{void reader.cancel('deadline').catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});try{while(true){check(!signal?.aborted,'Deployment read expired');const x=await reader.read();check(!signal?.aborted,'Deployment read expired');if(x.done)break;size+=x.value.length;check(size<=3*1024*1024,'Deployment response too large');parts.push(x.value);}}finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
   const raw=new Uint8Array(size);let off=0;for(const part of parts){raw.set(part,off);off+=part.length;}const b=JSON.parse(utf8.decode(raw));
   check(b.id==='qcommit-operator-read'&&!b.error&&Object.hasOwn(b,'result'),'Invalid deployment read');return b.result;
  };
  const rentForSize=async(size,signal)=>{const n=await read('getMinimumBalanceForRentExemption',[size,{commitment:'finalized'}],signal);check(Number.isSafeInteger(n)&&n>0,'Invalid current rent quote');return n;};
  function data(account,owner,executable=false){check(account&&account.owner===owner.toBase58()&&account.executable===executable&&Array.isArray(account.data)&&account.data[1]==='base64','Wrong account owner/encoding/flags');return Buffer.from(account.data[0],'base64');}
  const inspectState=async(stage,signal)=>{
   const keys=stage==='deploy'?[p.buffer]:[p.program,p.programData,p.config];
   const r=await read('getMultipleAccounts',[keys.map(k=>k.toBase58()),{encoding:'base64',commitment:'finalized'}],signal);
   check(Array.isArray(r?.value)&&r.value.length===keys.length,'Missing deployment state');
   if(stage==='deploy'){
    const b=data(r.value[0],LOADER);check(b.length===binary.length+37&&u32(b)===1&&b[4]===1&&equal(b.subarray(5,37),p.authority.toBytes())&&equal(b.subarray(37),binary),'Buffer state is not the complete reviewed upload');
   }else{
    const program=data(r.value[0],LOADER,true),pd=data(r.value[1],LOADER);
    check(program.length===36&&u32(program)===2&&equal(program.subarray(4),p.programData.toBytes()),'Wrong executable program link');
    check(pd.length===binary.length+45&&u32(pd)===3&&pd[12]===1&&equal(pd.subarray(13,45),p.authority.toBytes())&&equal(pd.subarray(45),binary),'Wrong deployed code or upgrade authority');
    // Current bytes alone cannot exclude state written by an earlier program.
    const rows=await read('getSignaturesForAddress',[p.program.toBase58(),{limit:1000,commitment:'finalized'}],signal);
    check(Array.isArray(rows)&&rows.length>0&&rows.length<1000,'Complete bounded program history is required');
    const transactions=[];
    for(const row of rows){
     check(typeof row.signature==='string'&&row.signature.length>=80&&row.signature.length<=90,'Invalid history signature');
     const tx=await read('getTransaction',[row.signature,{encoding:'json',commitment:'finalized',maxSupportedTransactionVersion:0}],signal);
     check(tx?.meta&&tx.transaction?.signatures?.[0]===row.signature,'History is missing or mismatched');transactions.push({signature:row.signature,tx});
    }
    verifyNativeDeployment({authority:p.authority.toBase58(),program:p.program.toBase58(),programData:p.programData.toBase58(),buffer:p.buffer.toBase58(),programSeed:p.programSeed,genesis:p.genesis.toBase58(),deploymentId:Buffer.from(p.deployment).toString('hex'),binarySha256,binarySize:binary.length},{deployed:true,deployedSlot:u64(pd,4).toString()},transactions);
    if(stage==='bootstrap')check(r.value[2]===null,'Configuration already exists');
    else{
     const c=data(r.value[2],p.program),[,bump]=PublicKey.findProgramAddressSync([new TextEncoder().encode('config')],p.program);
     check(c.length===105&&utf8.decode(c.subarray(0,8))==='QCCONF01'&&c[8]===bump&&equal(c.subarray(9,41),p.genesis.toBytes())&&equal(c.subarray(41,73),p.deployment)&&equal(c.subarray(73,105),p.authority.toBytes()),'Finalization requires exact initialized configuration');
    }
   }
  };
  const validator=operatorTransactionPolicy(p,binary,{binarySha256,rentForSize,inspectState});
  url.pathname='/rpc/'+match[1];
  return await handleRpc(new Request(url,request),{upstream,allowedOrigin,expectedProgram:p.program.toBase58(),enabled:true,transactionValidator:validator},fetchImpl);
 }catch{
  return new Response(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32098,message:'Operator request does not match the enabled reviewed deployment policy.'}}),{status:403,headers:{'content-type':'application/json','cache-control':'no-store'}});
 }
}
