import { ALGORITHM, fields, hex, unhex, b64, unb64, parseJson } from './protocol.mjs';
const FORMAT='qcommit/creator-vault/1',ITERATIONS=600000;
const utf8=new TextEncoder();
function password(value){if(typeof value!=='string'||value.length<12||value.length>256||!value.isWellFormed())throw new Error('Use a passphrase of 12–256 characters. Length is not an entropy guarantee.');return utf8.encode(value);}
function aad(v){return utf8.encode(`${FORMAT}\0${ALGORITHM}\0${v.publicKey}\0${v.label}\0${ITERATIONS}`);}
async function key(passphrase,salt,usage){const source=password(passphrase);try{const material=await crypto.subtle.importKey('raw',source,'PBKDF2',false,['deriveKey']);return await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},material,{name:'AES-GCM',length:256},false,usage);}finally{source.fill(0);}}
export function parseVault(input){const v=typeof input==='string'?parseJson(input,4096):input;
  fields(v,['format','algorithm','publicKey','label','kdf','iterations','salt','iv','ciphertext']);
  if(v.format!==FORMAT||v.algorithm!==ALGORITHM||v.kdf!=='PBKDF2-SHA256'||v.iterations!==ITERATIONS)throw new Error('Unsupported creator backup.');
  unhex(v.publicKey,32);unb64(v.salt,32);unb64(v.iv,12);unb64(v.ciphertext,80);
  if(typeof v.label!=='string'||!v.label.trim()||v.label.length>60||utf8.encode(v.label).length>80||!v.label.isWellFormed()||/[\x00-\x1f\x7f]/.test(v.label))throw new Error('Invalid creator label.');
  return {...v};
}
export async function encryptCreator(secret,passphrase,label){
  if(!(secret instanceof Uint8Array)||secret.length!==64)throw new Error('SLH secret key must be 64 bytes.');
  if(typeof label!=='string'||!label.trim()||label.length>60||utf8.encode(label).length>80||!label.isWellFormed()||/[\x00-\x1f\x7f]/.test(label))throw new Error('Choose a creator name of at most 60 characters.');
  const salt=crypto.getRandomValues(new Uint8Array(32)),iv=crypto.getRandomValues(new Uint8Array(12));
  const v={format:FORMAT,algorithm:ALGORITHM,publicKey:hex(secret.slice(32)),label,kdf:'PBKDF2-SHA256',iterations:ITERATIONS,salt:b64(salt),iv:b64(iv)};
  const aes=await key(passphrase,salt,['encrypt']);
  v.ciphertext=b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(v),tagLength:128},aes,secret)));
  return parseVault(v);
}
export async function decryptCreator(input,passphrase){
  const v=parseVault(input),aes=await key(passphrase,unb64(v.salt,32),['decrypt']);let secret;
  try{secret=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(v.iv,12),additionalData:aad(v),tagLength:128},aes,unb64(v.ciphertext,80)));}
  catch{throw new Error('Incorrect passphrase or altered backup.');}
  if(hex(secret.slice(32))!==v.publicKey){secret.fill(0);throw new Error('Creator backup key mismatch.');}return secret;
}
