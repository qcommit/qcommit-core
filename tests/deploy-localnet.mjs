/** Actual loader-v3 rehearsal. Only the isolated loopback validator and synthetic wallet. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {Connection,Keypair,PublicKey,Transaction,TransactionInstruction,SystemProgram,ComputeBudgetProgram,SYSVAR_RENT_PUBKEY,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {initializeConfigInstruction} from '../sdk/instructions.mjs';
import {deriveConfig,decodeConfig} from '../sdk/codec.mjs';
import * as sdk from '../sdk/index.mjs';
import {prepareDeployment,deploymentInstructions,executeDeployment,finalizeDeployment,inspectFinalization} from '../sdk/deployer.mjs';
import {slh_dsa_sha2_128s as slh} from '@noble/post-quantum/slh-dsa.js';
if(process.env.QC_ISOLATED_LOCALNET!=='1')throw Error('Only isolated synthetic validator execution is allowed.');
const connection=new Connection('http://127.0.0.1:18899','confirmed');
const wallet=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.runtime/deploy/payer.keypair.json'))));
const code=readFileSync('target/deploy/qcommit_launch.so');
const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const digest=b=>createHash('sha256').update(b).digest('hex');
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
const native=(keys,data)=>new TransactionInstruction({programId:loader,keys,data});
let bufferSeed,programSeed,buffer,program,programData,prepared,operators;
const report={status:'running',startedAt:new Date().toISOString(),scope:'Actual native loader-v3 deployment, isolated synthetic wallet, no program/buffer secret keys or public transactions',wallet:wallet.publicKey.toBase58(),programSha256:digest(code),programSize:code.length,checks:[],transactions:[]};
const persist=()=>writeFileSync('evidence/deploy-localnet.json',JSON.stringify(report,null,2)+'\n');
const check=(name,fn)=>{fn();report.checks.push({name,passed:true});console.log('PASS '+name);persist();};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFinalized(slot){const deadline=Date.now()+30000;while(await connection.getSlot('finalized')<slot){assert.ok(Date.now()<deadline,'finalization visibility deadline');await sleep(100);}}
async function send(instructions,label,error=null){
 const latest=await connection.getLatestBlockhash('confirmed');
 const tx=new Transaction({feePayer:wallet.publicKey,recentBlockhash:latest.blockhash}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1200000}),...instructions);
 assert.equal(tx.compileMessage().header.numRequiredSignatures,1,'only wallet signature may be required');
 tx.sign(wallet);const bytes=tx.serialize();assert.ok(bytes.length<=1232,'wire limit');
 const signature=await connection.sendRawTransaction(bytes,{skipPreflight:error!==null,maxRetries:3});
 try{await connection.confirmTransaction({signature,...latest},'confirmed');}catch(e){if(error===null)throw e;}
 let actual;for(let n=0;n<60;n++){actual=await connection.getTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});if(actual?.meta)break;await sleep(100);}
 assert.ok(actual?.meta,'confirmed transaction metadata is required');
 if(error===null)assert.equal(actual.meta.err,null,label);else assert.equal(actual.meta.err?.InstructionError?.[1],error,label+' exact native failure');
 report.transactions.push({label,signature,slot:actual.slot,bytes:bytes.length,requiredSignatures:1,feeLamports:actual.meta.fee,error:actual.meta.err,computeUnits:actual.meta.computeUnitsConsumed});persist();return actual;
}
const createSeeded=(address,seed,space,lamports)=>SystemProgram.createAccountWithSeed({fromPubkey:wallet.publicKey,newAccountPubkey:address,basePubkey:wallet.publicKey,seed,lamports,space,programId:loader});
const write=(offset,bytes,authority=wallet.publicKey)=>native([meta(buffer,true),meta(authority,false,authority.equals(wallet.publicKey))],Buffer.concat([u32(1),u32(offset),u64(bytes.length),bytes]));
const deploy=(maxDataLen)=>native([meta(wallet.publicKey,true,true),meta(programData,true),meta(program,true),meta(buffer,true),meta(SYSVAR_RENT_PUBKEY),meta(SYSVAR_CLOCK_PUBKEY),meta(SystemProgram.programId),meta(wallet.publicKey,false,true)],Buffer.concat([u32(2),u64(maxDataLen)]));
try{
 let genesis;for(let n=0;n<180;n++){try{genesis=await connection.getGenesisHash();break;}catch{await sleep(500);}}assert.ok(genesis,'isolated validator ready');report.genesis=genesis;
 const prepareOptions={cluster:'localnet',rpc:connection.rpcEndpoint,payer:wallet.publicKey,binary:code,binarySha256:report.programSha256,maxFeeLamports:'2000000',maxTotalLamports:'10000000000',connection};
 prepared=await prepareDeployment(prepareOptions);
 ({bufferSeed,programSeed}=prepared.plan);buffer=new PublicKey(prepared.plan.buffer);program=new PublicKey(prepared.plan.program);programData=new PublicKey(prepared.plan.programData);
 Object.assign(report,{program:program.toBase58(),buffer:buffer.toBase58(),programData:programData.toBase58(),programSeed,bufferSeed,publicPlan:prepared.plan});
 operators=await deploymentInstructions(prepared.plan,code,connection);
 await assert.rejects(prepareDeployment({...prepareOptions,journal:prepared.journal,payer:SystemProgram.programId}),/another wallet|wallet/);
 const badJournal=structuredClone(prepared.journal);badJournal.plan.programSeed=badJournal.plan.programSeed==='0'.repeat(32)?'1'.repeat(32):'0'.repeat(32);
 await assert.rejects(prepareDeployment({...prepareOptions,journal:badJournal}),/addresses mismatch/);
 const raisedCaps=structuredClone(prepared.journal);raisedCaps.plan.maxFeeLamports='2000001';await assert.rejects(prepareDeployment({...prepareOptions,journal:raisedCaps}),/raises the currently approved spending caps/);
 const changedBinary=Buffer.from(code);changedBinary[changedBinary.length-1]^=1;
 await assert.rejects(prepareDeployment({...prepareOptions,journal:prepared.journal,binary:changedBinary}),/binary differs/);
 check('Wrong wallet, raised caps, changed seed journal and changed artifact are refused before signing',()=>assert.equal(report.transactions.length,0));
 const bufferRent=await connection.getMinimumBalanceForRentExemption(37+code.length,'confirmed');
 const programRent=await connection.getMinimumBalanceForRentExemption(36,'confirmed');
 const dataRent=await connection.getMinimumBalanceForRentExemption(45+code.length,'confirmed');
 report.rent={bufferLamports:bufferRent,programLamports:programRent,programDataLamports:dataRent,permanentLamports:programRent+dataRent,bufferCreditReusedDuringDeploy:true};
 assert.equal(await connection.getAccountInfo(buffer),null);assert.equal(await connection.getAccountInfo(program),null);
 await send(operators.setup,'atomic-seeded-buffer-create-initialize');
 let bufferAccount=await connection.getAccountInfo(buffer,'confirmed');
 check('Wallet-base seeded buffer initialized atomically with exact authority',()=>{assert.ok(bufferAccount.owner.equals(loader));assert.equal(bufferAccount.data.length,37+code.length);assert.equal(bufferAccount.data.readUInt32LE(0),1);assert.equal(bufferAccount.data[4],1);assert.deepEqual(bufferAccount.data.subarray(5,37),wallet.publicKey.toBuffer());});
 await send([write(0,Buffer.from([1]),SystemProgram.programId)],'wrong-buffer-authority-cannot-write','IncorrectAuthority');
 await send([write(code.length,Buffer.from([1]))],'write-cannot-exceed-declared-buffer','AccountDataTooSmall');
 const corrupt=await send([write(0,Buffer.from([1]))],'deliberate-synthetic-owner-buffer-corruption');
 await waitFinalized(corrupt.slot);
 await assert.rejects(prepareDeployment({...prepareOptions,journal:prepared.journal}),/changed\/partial chunk/);
 check('SDK refuses a changed on-chain buffer chunk without overwriting it',()=>assert.equal(report.transactions.at(-1).label,'deliberate-synthetic-owner-buffer-corruption'));
 const first=await send([operators.write(0)],'owner-explicitly-repairs-first-chunk');
 await waitFinalized(first.slot);
 // Stopping here represents an interrupted upload; resumption uses public state and no hidden key.
 const resumed=await prepareDeployment({...prepareOptions,journal:prepared.journal});
 check('Public journal and chain bytes recover an interrupted first-chunk upload',()=>{assert.equal(resumed.plan.program,prepared.plan.program);assert.ok(resumed.state.uploadedOffsets.includes(0));assert.equal(resumed.state.deployed,false);});
 let journal=resumed.journal;
 const recordJournal=value=>{journal=structuredClone(value);for(const row of value.records){if(row.phase==='confirmed'&&!report.transactions.some(x=>x.signature===row.signature)){report.transactions.push({...row,requiredSignatures:1});}}report.deploymentJournal=journal;persist();};
 let cancelDeploy=true;
 const browserDeployer={publicKey:wallet.publicKey,signTransaction:async tx=>{assert.equal(tx.compileMessage().header.numRequiredSignatures,1);if(cancelDeploy&&tx.instructions.some(ix=>ix.programId.equals(loader)&&ix.data.readUInt32LE(0)===2))throw Error('Synthetic wallet cancelled deployment approval');tx.sign(wallet);return tx;},signAllTransactions:async txs=>{for(const tx of txs){assert.equal(tx.compileMessage().header.numRequiredSignatures,1);tx.sign(wallet);}return txs;}};
 const operation=()=>({plan:prepared.plan,binary:code,payer:browserDeployer,journal,onJournal:recordJournal,connection,batchSize:10});
 await assert.rejects(executeDeployment(operation()),/Synthetic wallet cancelled deployment approval/);
 const cancelledProgram=await connection.getAccountInfo(program,'finalized');
 check('Actual wallet cancellation before deployment retains only recoverable uploaded buffer',()=>{assert.equal(cancelledProgram,null);assert.ok(journal.records.some(r=>r.phase==='confirmed'&&r.label.startsWith('write-buffer-')));assert.ok(!journal.records.some(r=>r.phase==='confirmed'&&r.label==='deploy-program'));});
 const countBeforeGuard=report.transactions.length;
 await assert.rejects(executeDeployment({...operation(),payer:{publicKey:wallet.publicKey}}),/Connect the exact selected funding wallet/);
 const maliciousSigner={publicKey:wallet.publicKey,signTransaction:async tx=>{tx.add(SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:SystemProgram.programId,lamports:1}));tx.sign(wallet);return tx;}};
 await assert.rejects(executeDeployment({...operation(),payer:maliciousSigner}),/Wallet changed an approved deployment message/);
 check('Missing signer and modified wallet message cause no broadcast',()=>assert.equal(report.transactions.length,countBeforeGuard));
 bufferAccount=await connection.getAccountInfo(buffer,'confirmed');
 check('Every uploaded executable byte matches the reviewed artifact',()=>{assert.equal(digest(bufferAccount.data.subarray(37)),report.programSha256);assert.deepEqual(bufferAccount.data.subarray(37),code);});
 const beforeBadBufferLamports=bufferAccount.lamports;
 const failedDeploy=await send([createSeeded(program,programSeed,36,programRent),deploy(code.length-1)],'undersized-deploy-rolls-back-created-program','AccountDataTooSmall');
 await waitFinalized(failedDeploy.slot);
 const afterBadBuffer=await connection.getAccountInfo(buffer,'confirmed');
 const afterBadProgram=await connection.getAccountInfo(program,'confirmed');
 check('Failed native deploy preserves complete buffer and rolls back seeded program',()=>{assert.equal(afterBadProgram,null);assert.equal(afterBadBuffer.lamports,beforeBadBufferLamports);assert.deepEqual(afterBadBuffer.data,bufferAccount.data);});
 cancelDeploy=false;
 const completed=await executeDeployment(operation());journal=completed.journal;
 const deployedRow=journal.records.find(r=>r.phase==='confirmed'&&r.label==='deploy-program');assert.ok(deployedRow,'SDK confirmed native deployment');
 const deployed=await connection.getTransaction(deployedRow.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});assert.ok(deployed?.meta,'actual deployed transaction metadata');
 const [p,d,remainingBuffer]=await connection.getMultipleAccountsInfo([program,programData,buffer],'confirmed');
 const walletIndex=deployed.transaction.message.accountKeys.findIndex(k=>k.equals(wallet.publicKey));assert.ok(walletIndex>=0);
 check('Native loader deploy accepts one wallet signer and no program/buffer keys',()=>{assert.ok(p.executable&&p.owner.equals(loader));assert.equal(p.data.readUInt32LE(0),2);assert.deepEqual(p.data.subarray(4),programData.toBuffer());assert.equal(d.data.readUInt32LE(0),3);assert.equal(d.data[12],1);assert.deepEqual(d.data.subarray(13,45),wallet.publicKey.toBuffer());assert.equal(d.data.readBigUInt64LE(4),BigInt(deployed.slot));assert.deepEqual(d.data.subarray(45),code);});
 check('Buffer rent is reused and no funded upload buffer remains',()=>{assert.ok(!remainingBuffer||remainingBuffer.lamports===0);assert.equal(deployed.meta.preBalances[walletIndex]-deployed.meta.postBalances[walletIndex],programRent+dataRent-bufferRent+deployed.meta.fee);});
 const visibleDeadline=Date.now()+15000;while(await connection.getSlot('confirmed')<=deployed.slot){assert.ok(Date.now()<visibleDeadline,'deployment visibility deadline');await sleep(100);}
 const deploymentId=prepared.plan.deploymentId;report.deploymentId=deploymentId;
 report.bootstrapSignature=completed.bootstrapSignature;assert.equal(completed.readyForFinalization,true);
 const configAddress=deriveConfig(program).config,account=await connection.getAccountInfo(configAddress,'confirmed'),state=decodeConfig(account.data);
 check('Actually deployed binary executes and persists exact bootstrap domain',()=>{assert.ok(account.owner.equals(program));assert.equal(state.genesis,genesis);assert.equal(state.deploymentId,deploymentId);assert.equal(state.bootstrapAuthority,wallet.publicKey.toBase58());});
 const finalReview=await inspectFinalization({plan:prepared.plan,binary:code,journal,connection});assert.equal(finalReview.ready,true);assert.equal(finalReview.irreversible,true);
 const finalized=await finalizeDeployment({plan:prepared.plan,binary:code,payer:browserDeployer,journal,onJournal:recordJournal,connection});journal=finalized.journal;report.finalizationSignature=journal.records.find(r=>r.phase==='confirmed'&&r.label==='make-program-immutable').signature;
 const immutable=await connection.getAccountInfo(programData,'confirmed');
 check('Actual native finalization removes upgrade authority and preserves executable bytes',()=>{assert.equal(immutable.data[12],0);assert.deepEqual(immutable.data.subarray(45),code);});
 await send([native([meta(programData,true),meta(wallet.publicKey,false,true)],u32(4))],'immutable-program-authority-cannot-be-restored','Immutable');
 const finalConfig=await connection.getAccountInfo(configAddress,'confirmed');check('Finalization preserves initialized configuration',()=>assert.deepEqual(finalConfig.data,account.data));

 // Exercise the deployed-and-finalized artifact through the same SDK wallet interface as a browser.
 const config={format:'qcommit/network/1',cluster:'localnet',rpc:connection.rpcEndpoint,genesis,program:program.toBase58(),programSha256:report.programSha256,programSize:code.length,upgradeAuthority:null,deploymentId};
 const network=await sdk.openNetwork(config,connection);
 const browserWallet={publicKey:wallet.publicKey,signTransaction:async tx=>{assert.equal(tx.compileMessage().header.numRequiredSignatures,1);tx.sign(wallet);return tx;}};
 const onRecord=r=>{if(r.phase==='confirmed'){report.transactions.push({...r,requiredSignatures:1});persist();}};
 const pq=slh.keygen();
 try {
  const creatorPublicKey=sdk.hex(pq.publicKey);
  const registration=await sdk.prepareRegistration(network,{payer:browserWallet,creatorPublicKey});
  const regSignature=slh.sign(registration.digest,pq.secretKey,{context:new TextEncoder().encode(sdk.CONTEXT)});
  const registered=await sdk.registerCreator(network,{registration:registration.registration,signature:regSignature,payer:browserWallet,onRecord});
  check('Wallet-interface creator registration works after immutable native deployment',()=>assert.equal(registered.active,true));
  const launch=await sdk.prepareLaunch(network,{payer:browserWallet,creatorPublicKey,name:'Qcommit Seeded Deployment',symbol:'QDEP',metadataUri:'https://example.com/qcommit-deploy-test.json',metadataSha256:digest(Buffer.from('isolated deployment test metadata')),decimals:6,supplyBaseUnits:'1000000000',maxExecutionRent:'100000000',maxNetworkFee:'10000000'});
  const signature=slh.sign(launch.digest,pq.secretKey,{context:new TextEncoder().encode(sdk.CONTEXT)});
  const receipt=await sdk.executeLaunch(network,{intent:launch.intent,signature,creatorPublicKey,payer:browserWallet,onRecord});
  report.executionReceipt=receipt;
  check('Fresh seeded deployment completes actual immutable token launch and independent receipt',()=>{assert.equal(receipt.signatureValid,true);assert.equal(receipt.confirmation.immutableProgram,true);assert.equal(receipt.confirmation.onchainVerified,true);assert.equal(receipt.confirmation.program,program.toBase58());});
 }finally{pq.secretKey.fill(0);}
 report.status='passed';report.completedAt=new Date().toISOString();report.transactionCount=report.transactions.length;report.publicTransactions=0;
}catch(e){report.status='failed';report.error=e?.stack??JSON.stringify(e);process.exitCode=1;console.error(report.error);}finally{wallet.secretKey.fill(0);persist();}
