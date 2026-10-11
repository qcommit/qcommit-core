import {Keypair,PublicKey} from '@solana/web3.js';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
if(process.env.QC_ISOLATED_LOCALNET!=='1')throw Error('Isolated synthetic validator required.');
mkdirSync('.runtime/onchain',{recursive:true});
const payer=Keypair.generate(),program=Keypair.generate();
for(const [name,key] of [['payer',payer],['program',program]])writeFileSync('.runtime/onchain/'+name+'.keypair.json',JSON.stringify([...key.secretKey]),{mode:0o600});
const code=readFileSync('target/deploy/qcommit_launch.so'),loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const [programData]=PublicKey.findProgramAddressSync([program.publicKey.toBytes()],loader);
const ph=Buffer.alloc(36);ph.writeUInt32LE(2);ph.set(programData.toBytes(),4);
const dh=Buffer.alloc(45);dh.writeUInt32LE(3);dh[12]=1;dh.set(payer.publicKey.toBytes(),13);
function account(key,data,executable,file){writeFileSync(file,JSON.stringify({pubkey:key.toBase58(),account:{lamports:10000000000,data:[data.toString('base64'),'base64'],owner:loader.toBase58(),executable,rentEpoch:0,space:data.length}}));}
account(program.publicKey,ph,true,'.runtime/onchain/genesis-program.json');account(programData,Buffer.concat([dh,code]),false,'.runtime/onchain/genesis-program-data.json');
const config={program:program.publicKey.toBase58(),programData:programData.toBase58(),payer:payer.publicKey.toBase58(),programSize:code.length,programSha256:createHash('sha256').update(code).digest('hex'),deploymentId:randomBytes(32).toString('hex')};
writeFileSync('.runtime/onchain/bootstrap.json',JSON.stringify(config,null,2)+'\n');
for(const [name,value] of Object.entries({program:config.program,programData:config.programData,payer:config.payer}))writeFileSync('.runtime/onchain/'+name+'.txt',value+'\n');

const bank=Keypair.generate();writeFileSync('.runtime/onchain/bank.txt',bank.publicKey.toBase58()+'\n');bank.secretKey.fill(0);
writeFileSync('.runtime/onchain/genesis-payer.json',JSON.stringify({pubkey:payer.publicKey.toBase58(),account:{lamports:1000000000000,data:['','base64'],owner:'11111111111111111111111111111111',executable:false,rentEpoch:0,space:0}}));
