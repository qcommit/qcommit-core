import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Connection,Keypair,PublicKey,Transaction,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
import {slh_dsa_sha2_128s as slh} from '@noble/post-quantum/slh-dsa.js';
import * as sdk from '../sdk/index.mjs';
if(process.env.QC_ISOLATED_LOCALNET!=='1')throw Error('Use the network-disabled local-validator runner.');
const records=[],checks=[];let negativeCreator=null,negativeNonce=null;const report={status:'running',startedAt:new Date().toISOString(),scope:'Actual isolated local validator, synthetic funds, real SPL/ATA/Metaplex bytecode; no public transactions',records,checks};
const persist=()=>writeFileSync('evidence/onchain-localnet.json',JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
const check=(name,fn)=>{fn();checks.push({name,passed:true});console.log('PASS '+name);persist();};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const connection=new Connection('http://127.0.0.1:18899','confirmed');
const originalSimulation=connection.simulateTransaction.bind(connection);connection.simulateTransaction=async(...args)=>{const result=await originalSimulation(...args);if(result.value.err){report.lastSimulation=result.value;persist();}return result;};
const b=JSON.parse(readFileSync('.runtime/onchain/bootstrap.json'));
const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.runtime/onchain/payer.keypair.json'))));
let network;const secrets=[];
const onRecord=r=>{if(r.phase==='confirmed'){records.push(r);console.log('TX '+r.label+' '+r.computeUnits+'CU');persist();}};
async function rawSend(instructions,{label='raw',reject=false,signer=payer}={}){
 const latest=await connection.getLatestBlockhash('confirmed');const tx=new Transaction({feePayer:signer.publicKey,recentBlockhash:latest.blockhash}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1200000}),...instructions);tx.sign(signer);const bytes=tx.serialize();assert.ok(bytes.length<=1232,'wire bound');const signature=await connection.sendRawTransaction(bytes,{skipPreflight:reject,maxRetries:3});
 let confirmation;try{confirmation=await connection.confirmTransaction({signature,...latest},'confirmed');}catch(error){if(!reject)throw error;confirmation={value:{err:error}};}
 let detail;for(let n=0;n<40;n++){detail=await connection.getTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});if(detail)break;await sleep(100);}assert.ok(detail?.meta,'confirmed metadata');assert.equal(!!detail.meta.err,reject,label+': '+JSON.stringify(detail.meta.err));if(reject&&negativeCreator!==null){const state=await sdk.readOwned(network,negativeCreator,sdk.decodeCreator);assert.equal(state.nonce,negativeNonce,label+': failed transaction changed nonce');}records.push({label,signature,bytes:bytes.length,computeUnits:detail.meta.computeUnitsConsumed,error:detail.meta.err,slot:detail.slot,feeLamports:detail.meta.fee});persist();console.log((reject?'REJECT ':'TX ')+label);return {signature,detail};
}
async function rejectCode(instruction,label,code,{signer=payer}={}){
 const result=await rawSend([instruction],{label,reject:true,signer});
 check(label+' exact program rejection',()=>assert.deepEqual(result.detail.meta.err,{InstructionError:[1,{Custom:code}]}));return result;
}
function replaceAccount(instruction,index,key){instruction.keys[index]={...instruction.keys[index],pubkey:new PublicKey(key)};return instruction;}
async function waitAfterSlot(target){const deadline=Date.now()+60000;let slot;while(Date.now()<deadline){slot=await connection.getSlot('confirmed');if(BigInt(slot)>BigInt(target))return slot;await sleep(100);}throw Error('Bounded expiry wait did not observe required slot: '+slot+' <= '+target);}
const sign=(digest,key,context=sdk.CONTEXT)=>slh.sign(digest,key.secretKey,{context:new TextEncoder().encode(context)});
async function stage(intent,key,{context=sdk.CONTEXT,signature,stopAfterUpload=false}={}){
 const digest=sdk.intentDigest(intent),bytes=sdk.encodeIntent(intent),creator=intent.creator,uploader=payer.publicKey,program=b.program;
 const start=sdk.beginProofInstruction({program,creator,uploader,kind:1,nonce:intent.nonce,expirySlot:intent.expirySlot,digest,intentLength:bytes.length});
 await rawSend([start.instruction],{label:'begin-proof-test'});
 const payload=sdk.concat(signature??sign(digest,key,context),bytes),args={program,creator,uploader,proof:start.proof};
 for(let offset=0;offset<payload.length;offset+=sdk.MAX_CHUNK_BYTES)await rawSend([sdk.appendProofInstruction({...args,offset,chunk:payload.slice(offset,offset+sdk.MAX_CHUNK_BYTES)})],{label:'upload-test'});
 if(stopAfterUpload)return args;
 await rawSend([sdk.sealProofInstruction(args)],{label:'seal-test'});for(let n=0;n<8;n++)await rawSend([sdk.stepProofInstruction(args)],{label:'verify-test-'+n});return args;
}
try{
 let genesis;for(let n=0;n<180;n++){try{genesis=await connection.getGenesisHash();break;}catch{await sleep(500);}}assert.ok(genesis,'validator ready');
 for(let n=0;n<100;n++){if(await connection.getSlot('confirmed')>=8)break;await sleep(100);}assert.ok(await connection.getSlot('confirmed')>=8,'programs visible after genesis activation');
 const config={format:'qcommit/network/1',cluster:'localnet',rpc:connection.rpcEndpoint,genesis,program:b.program,programSha256:b.programSha256,programSize:b.programSize,upgradeAuthority:b.payer,deploymentId:b.deploymentId};
 report.network=config;writeFileSync('.runtime/onchain/network.json',JSON.stringify(config,null,2)+'\n');network=await sdk.openNetwork(config,connection);
 await sdk.submitNetwork(connection,payer,[sdk.initializeConfigInstruction({...b,genesis,programData:b.programData,payer:payer.publicKey})],{network,label:'initialize-config',onRecord});
 await rawSend([sdk.initializeConfigInstruction({...b,genesis,programData:b.programData,payer:payer.publicKey})],{label:'configuration-cannot-reinitialize',reject:true});
 const key=slh.keygen();secrets.push(key.secretKey);const creatorPublicKey=sdk.hex(key.publicKey);
 const registration=await sdk.prepareRegistration(network,{payer,creatorPublicKey});
 const attacker=Keypair.generate();secrets.push(attacker.secretKey);
 await rawSend([SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:attacker.publicKey,lamports:2_000_000_000})],{label:'fund-isolated-adversarial-payer'});
 await rejectCode(replaceAccount(sdk.initializeCreatorInstruction(registration.registration),2,attacker.publicKey),'creator-original-payer-front-run-rejected',3,{signer:attacker});
 const substitutedKey=Uint8Array.from(key.publicKey);substitutedKey[0]^=1;
 await rejectCode(sdk.initializeCreatorInstruction({...registration.registration,creatorPublicKey:sdk.hex(substitutedKey)}),'creator-key-substitution-at-original-address-rejected',3);
 const afterFrontRun=await connection.getAccountInfo(new PublicKey(registration.creator),'confirmed');check('Failed creator front-runs leave identity uninitialized',()=>assert.equal(afterFrontRun,null));
 await sdk.registerCreator(network,{registration:registration.registration,signature:sign(registration.digest,key),payer,onRecord});
 let c=await sdk.getCreator(network,{payer,creatorPublicKey});negativeCreator=registration.creator;negativeNonce='0';check('Real PQ possession activates registered creator',()=>assert.ok(c.state.active&&c.state.nonce==='0'));
 const params={payer,creatorPublicKey,name:'Qcommit Local Token',symbol:'QCT',metadataUri:'https://example.com/qcommit-test.json',metadataSha256:createHash('sha256').update('synthetic local metadata').digest('hex'),decimals:6,supplyBaseUnits:'1000000000000',maxExecutionRent:'100000000',maxNetworkFee:'10000000'};
 const prepared=await sdk.prepareLaunch(network,params);report.estimatedCosts=prepared.estimate;
 const result=await sdk.executeLaunch(network,{intent:prepared.intent,signature:sign(prepared.digest,key),creatorPublicKey,payer,onRecord});report.executionReceipt=result;negativeNonce='1';check('Actual atomic token launch independently confirmed',()=>assert.ok(result.confirmation.onchainVerified&&result.confirmation.mint===prepared.intent.mint));
 const d=sdk.deriveLaunch(b.program,prepared.intent.creator,prepared.intent.nonce,prepared.intent.recipient);const mint=await connection.getAccountInfo(d.mint);check('Exact supply,decimals,revokedmint and nofreeze authority',()=>{assert.equal(mint.data.readBigUInt64LE(36).toString(),params.supplyBaseUnits);assert.equal(mint.data[44],6);assert.equal(mint.data.readUInt32LE(0),0);assert.equal(mint.data.readUInt32LE(46),0);});
 const proof=sdk.deriveProof(b.program,prepared.intent.creator,prepared.digest,payer.publicKey).proof;
 await rawSend([sdk.executeLaunchInstruction(prepared.intent,proof)],{label:'executed-launch-cannot-replay',reject:true});
 const next=await sdk.prepareLaunch(network,{...params,name:'Qcommit Rollback Test'});const low={...next.intent,maxExecutionRent:'1'};const staged=await stage(low,key);const deriv=sdk.deriveLaunch(b.program,low.creator,low.nonce,low.recipient);
 await rawSend([sdk.executeLaunchInstruction(low,staged.proof)],{label:'rent-cap-rejects-after-CPI',reject:true});
 const accounts=await connection.getMultipleAccountsInfo([deriv.mint,deriv.ata,deriv.metadata,deriv.record]);c=await sdk.getCreator(network,{payer,creatorPublicKey});check('Failed execution rolls back mint,ATA,metadata,record andnonce',()=>{assert.ok(accounts.every(x=>x===null));assert.equal(c.state.nonce,low.nonce);});
 await rawSend([sdk.appendProofInstruction({...staged,offset:0,chunk:Uint8Array.of(1)})],{label:'sealed-proof-cannot-change',reject:true});
 const bad={...next.intent,name:'Qcommit Context Test'};const badProof=await stage(bad,key,{context:'Qcommit.LaunchPreview.v1',stopAfterUpload:true});await rawSend([sdk.sealProofInstruction(badProof)],{label:'seal-wrong-context'});
 for(let i=0;i<7;i++)await rawSend([sdk.stepProofInstruction(badProof)],{label:'wrong-context-stage-'+i});await rawSend([sdk.stepProofInstruction(badProof)],{label:'preview-domain-rejected-on-chain',reject:true});
 const nonceBefore=(await sdk.getCreator(network,{payer,creatorPublicKey})).state.nonce;check('Rejected preview signature does not consume creator nonce',()=>assert.equal(nonceBefore,next.intent.nonce));

 // The already fully verified low-rent proof exercises account binding before CPIs.
 await rejectCode(replaceAccount(sdk.executeLaunchInstruction(low,staged.proof),3,attacker.publicKey),'wrong-execution-payer-rejected',6,{signer:attacker});
 for(const [index,name,code] of [[4,'mint',6],[5,'recipient',6],[6,'associated-token-account',3],[7,'metadata-address',3],[8,'launch-record-address',3],[10,'token-program',6],[12,'metadata-program',6]]){
  const replacement=index===10||index===12?SystemProgram.programId:attacker.publicKey;
  await rejectCode(replaceAccount(sdk.executeLaunchInstruction(low,staged.proof),index,replacement),'substituted-'+name+'-rejected',code);
 }
 // Upload offsets, uploader identity and sealing must fail without mutating stored bytes.
 const uploadIntent={...next.intent,name:'Qcommit Upload Guards'};
 const uploadBytes=sdk.encodeIntent(uploadIntent),uploadDigest=sdk.intentDigest(uploadIntent);
 const uploadStart=sdk.beginProofInstruction({program:b.program,creator:uploadIntent.creator,uploader:payer.publicKey,kind:1,nonce:uploadIntent.nonce,expirySlot:uploadIntent.expirySlot,digest:uploadDigest,intentLength:uploadBytes.length});
 await rawSend([uploadStart.instruction],{label:'begin-upload-guards'});
 const uploadArgs={program:b.program,creator:uploadIntent.creator,proof:uploadStart.proof,uploader:payer.publicKey};
 await rejectCode(sdk.appendProofInstruction({...uploadArgs,offset:1,chunk:Uint8Array.of(1)}),'wrong-upload-offset-rejected',8);
 await rejectCode(sdk.appendProofInstruction({...uploadArgs,uploader:attacker.publicKey,offset:0,chunk:Uint8Array.of(1)}),'wrong-uploader-rejected',6,{signer:attacker});
 await rejectCode(sdk.sealProofInstruction(uploadArgs),'incomplete-proof-cannot-seal',7);
 await rejectCode(sdk.executeLaunchInstruction(uploadIntent,uploadStart.proof),'unverified-proof-cannot-execute',10);
 const uploadState=await sdk.readOwned(network,uploadStart.proof,sdk.decodeProof);
 check('Rejected upload mutations preserve zero bytes and stage',()=>assert.ok(uploadState.uploaded===0&&uploadState.stage===0));
 // Alter a signature from the actual production context, then alter a signed intent separately.
 for(const mode of ['corrupted-signature','altered-signed-intent']){
  const original={...next.intent,name:mode==='corrupted-signature'?'Qcommit Corrupt Signature':'Qcommit Original Details'};
  const signature=sign(sdk.intentDigest(original),key);
  let intent=original;if(mode==='corrupted-signature')signature[0]^=1;else intent={...original,name:'Qcommit Changed Details'};
  const bad=await stage(intent,key,{signature,stopAfterUpload:true});
  await rawSend([sdk.sealProofInstruction(bad)],{label:'seal-'+mode});
  for(let i=0;i<7;i++)await rawSend([sdk.stepProofInstruction(bad)],{label:mode+'-stage-'+i});
  await rejectCode(sdk.stepProofInstruction(bad),mode+'-final-root-rejected',10);
  await rejectCode(sdk.executeLaunchInstruction(intent,bad.proof),mode+'-cannot-execute',10);
 }
 // Verify while live, then wait for actual confirmed slot expiry before trying execution.
 const expiryStart=await connection.getSlot('confirmed');
 const expiring={...next.intent,name:'Qcommit Expiry Test',expirySlot:String(expiryStart+400)};
 const expiringProof=await stage(expiring,key);
 const beforeExpiry=await sdk.readOwned(network,expiringProof.proof,sdk.decodeProof);
 assert.equal(beforeExpiry.stage,9,'expiry test proof was not fully verified');
 await waitAfterSlot(expiring.expirySlot);
 await rejectCode(sdk.executeLaunchInstruction(expiring,expiringProof.proof),'expiry-rechecked-after-full-verification',12);
 const expiredAccounts=await connection.getMultipleAccountsInfo([deriv.mint,deriv.record],'confirmed');check('Expired authorization produced no mint or launch record',()=>assert.ok(expiredAccounts.every(x=>x===null)));
 // Correct second launch demonstrates nonce progression after the rejected attempt.
 const second=await sdk.executeLaunch(network,{intent:next.intent,signature:sign(next.digest,key),creatorPublicKey,payer,onRecord});check('Subsequent correctlyauthorized launch succeeds',()=>assert.ok(second.confirmation.onchainVerified&&second.confirmation.mint!==result.confirmation.mint));
 report.status='passed';report.finishedAt=new Date().toISOString();report.transactionCount=records.length;report.expectedRejectedTransactions=records.filter(x=>x.error).length;report.publicTransactions=0;
}catch(e){report.status='failed';report.error=e?.stack??JSON.stringify(e);process.exitCode=1;console.error(report.error);}finally{for(const s of secrets)s.fill(0);persist();}
