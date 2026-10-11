/** Creator commitments accompanying Meteora DBC launches. No RPC or secret keys. */
import {parseJson,fields,decodeAddress,unhex,hex,fingerprint} from './protocol.mjs';
import {verifySlh} from './slh-verify.mjs';
export const METEORA_CONTEXT='Qcommit.MeteoraLaunch.v1';
export const METEORA_FORMAT='qcommit/meteora-launch-receipt/1';
export const METEORA_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const METEORA_FIELDS=Object.freeze(['network','genesis','config','mint','pool','owner','name','symbol','metadataSha256','messageSha256']);
export function normalizeMeteoraIntent(input){
 fields(input,METEORA_FIELDS);
 if(input.network!=='mainnet-beta'||input.genesis!==METEORA_GENESIS)throw Error('Wrong launch network');
 for(const k of ['config','mint','pool','owner'])decodeAddress(input[k]);
 for(const k of ['metadataSha256','messageSha256'])unhex(input[k],32);
 if(typeof input.name!=='string'||!input.name.trim()||new TextEncoder().encode(input.name).length>32||/[\u0000-\u001f\u007f]/.test(input.name))throw Error('Invalid token name');
 if(typeof input.symbol!=='string'||!/^[A-Z0-9]{1,10}$/.test(input.symbol))throw Error('Invalid token symbol');
 return Object.fromEntries(METEORA_FIELDS.map(k=>[k,input[k]]));
}
export async function meteoraIntentDigest(input){return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(normalizeMeteoraIntent(input)))));}
export async function verifyMeteoraProof(proof){
 fields(proof,['intent','publicKey','signature','context','algorithm']);
 if(proof.context!==METEORA_CONTEXT||proof.algorithm!=='SLH-DSA-SHA2-128s')throw Error('Wrong creator signature profile');
 return verifySlh(await meteoraIntentDigest(proof.intent),unhex(proof.signature,7856),unhex(proof.publicKey,32),new TextEncoder().encode(METEORA_CONTEXT));
}
export async function makeMeteoraProof(intent,publicKey,signature){
 const proof={intent:normalizeMeteoraIntent(intent),publicKey:typeof publicKey==='string'?publicKey:hex(publicKey),signature:typeof signature==='string'?signature:hex(signature),context:METEORA_CONTEXT,algorithm:'SLH-DSA-SHA2-128s'};
 if(!(await verifyMeteoraProof(proof)).valid)throw Error('Independent post-sign verification failed');
 return proof;
}
export async function verifyMeteoraReceipt(input,{expectedFingerprint}={}){
 const r=typeof input==='string'?parseJson(input):input;
 fields(r,['format','name','symbol','mint','pool','creatorProof','confirmation']);
 if(r.format!==METEORA_FORMAT||!r.creatorProof)throw Error('No post-quantum creator signature in this receipt');
 const p=r.creatorProof;
 if(['name','symbol','mint','pool'].some(k=>r[k]!==p.intent?.[k])||r.confirmation?.mint!==r.mint||r.confirmation?.pool!==r.pool||r.confirmation?.config!==p.intent.config)throw Error('Receipt differs from signed launch fields');
 if(expectedFingerprint)unhex(expectedFingerprint,32);
 const trace=await verifyMeteoraProof(p),fp=await fingerprint(p.publicKey),matched=expectedFingerprint?expectedFingerprint===fp:null;
 return{signatureValid:trace.valid,identityMatch:matched,identityTrusted:trace.valid&&matched===true,fingerprint:fp,onchainVerified:false,noExpiryClaim:true,intentDigest:hex(await meteoraIntentDigest(p.intent)),trace};
}
