import { parseJson } from './json.mjs';
import { verifySlh } from './slh-verify.mjs';
export { parseJson };
export const ALGORITHM = 'SLH-DSA-SHA2-128s';
export const CONTEXT = 'Qcommit.LaunchPreview.v1';
export const SIGNATURE_BYTES = 7856;
export const MAX_RECEIPT_BYTES = 32768;
const utf8 = new TextEncoder();
const keys = ['version','scope','network','creatorPublicKey','creatorLabel','fundingWallet','launchId','name','symbol','description','metadataUri','metadataSha256','decimals','supply','recipient','mintAuthority','freezeAuthority','issuedAt','expiresAt'];
export const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2,'0')).join('');
export function unhex(value, length) {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value) || value.length % 2 || (length !== undefined && value.length !== length * 2)) throw new Error('Invalid lowercase hexadecimal encoding.');
  return Uint8Array.from(value.match(/../g), x => parseInt(x,16));
}
export function bytes(...parts) { const result = new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let at=0; for(const part of parts){result.set(part,at);at+=part.length;}return result; }
export const digest = async data => new Uint8Array(await crypto.subtle.digest('SHA-256',data));
export function fields(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(k=>!Object.hasOwn(value,k))) throw new Error('Missing or unsupported fields.');
}
function text(value, max, name, required = false) {
  if (typeof value !== 'string' || utf8.encode(value).length > max || (required && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value) || !value.isWellFormed()) throw new Error(`Invalid ${name}.`);
  return value;
}
export function decodeAddress(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) throw new Error('A Solana address is required.');
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n,zeroes=0;
  for(const char of value){const d=alphabet.indexOf(char);if(d<0)throw new Error('Invalid Solana address.');n=n*58n+BigInt(d);}
  for(const char of value){if(char!=='1')break;zeroes++;}
  const out=[];while(n){out.unshift(Number(n&255n));n>>=8n;}
  if(zeroes+out.length!==32)throw new Error('Solana address must encode 32 bytes.');
  return Uint8Array.from([...new Uint8Array(zeroes),...out]);
}
export async function fingerprint(publicKey) { return hex(await digest(bytes(utf8.encode('Qcommit/Creator/v1\0'),unhex(publicKey,32)))); }
export function normalizeIntent(input) {
  fields(input,keys);
  if(input.version!==1 || input.scope!=='preview-only' || !['solana:devnet','solana:mainnet'].includes(input.network)) throw new Error('Unsupported launch scope or network.');
  unhex(input.creatorPublicKey,32);unhex(input.launchId,32);
  text(input.creatorLabel,80,'creator label',true);text(input.name,32,'token name',true);
  if(typeof input.symbol!=='string'||!/^[A-Z0-9]{1,10}$/.test(input.symbol))throw new Error('Symbol must be 1–10 uppercase letters or digits.');
  text(input.description,400,'description');text(input.metadataUri,200,'metadata URI');
  if(input.metadataUri){
    const uri=/^(https|ipfs|ar):\/\/([^/?#]+)(?:[/?#].*)?$/i.exec(input.metadataUri);
    if(!uri || /[\u0000-\u0020\u007f\\]/.test(input.metadataUri))throw new Error('Metadata URI must be absolute HTTPS, IPFS, or Arweave, without spaces/backslashes.');
    if(uri[1].toLowerCase()==='https'){
      const a=/^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(uri[2]);
      if(!a)throw new Error('Metadata HTTPS authority must be an ASCII hostname without credentials.');
      const host=a[1].replace(/\.$/,'');
      if(host.length>253||host.split('.').some(x=>!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(x))||(a[2]!==undefined&&(Number(a[2])<1||Number(a[2])>65535)))throw new Error('Invalid metadata hostname or port.');
    }else if(!/^[A-Za-z0-9._-]+$/.test(uri[2]))throw new Error('Invalid metadata content identifier.');
  }
  if(input.metadataSha256!==null)unhex(input.metadataSha256,32);
  decodeAddress(input.fundingWallet);decodeAddress(input.recipient);
  if(!Number.isInteger(input.decimals)||input.decimals<0||input.decimals>9)throw new Error('Decimals must be 0–9.');
  if(typeof input.supply!=='string'||!/^[1-9][0-9]{0,19}$/.test(input.supply)||BigInt(input.supply)*(10n**BigInt(input.decimals))>0xffffffffffffffffn)throw new Error('Supply must be a positive integer fitting SPL u64 after decimals.');
  if(input.mintAuthority!=='revoke'||input.freezeAuthority!=='none')throw new Error('Preview profile requires fixed supply and no freeze authority.');
  for(const field of ['issuedAt','expiresAt'])if(typeof input[field]!=='string'||!/^[1-9]\d{3}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input[field])||!Number.isFinite(Date.parse(input[field]))||new Date(input[field]).toISOString()!==input[field])throw new Error('Invalid timestamp.');
  const lifetime=Date.parse(input.expiresAt)-Date.parse(input.issuedAt);if(lifetime<60000||lifetime>86400000)throw new Error('Approval lifetime must be 1 minute to 24 hours.');
  return Object.fromEntries(keys.map(k=>[k,input[k]]));
}
export function intentBytes(input) {return utf8.encode(JSON.stringify(normalizeIntent(input)));}
export async function intentDigest(input) {return digest(bytes(utf8.encode('Qcommit/LaunchPreview/v1\0'),intentBytes(input)));}
export const b64 = input => {let s='';for(const b of input)s+=String.fromCharCode(b);return btoa(s);};
export function unb64(value, length) {
  if(typeof value!=='string'||value.length!==4*Math.ceil(length/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('Invalid base64 encoding.');
  const result=Uint8Array.from(atob(value),x=>x.charCodeAt(0));if(result.length!==length||b64(result)!==value)throw new Error('Noncanonical base64 encoding.');return result;
}
export function parseReceipt(input) {
  const p=typeof input==='string'?parseJson(input,MAX_RECEIPT_BYTES):input;
  fields(p,['format','algorithm','context','intent','signature']);
  if(p.format!=='qcommit/launch-authorization/1'||p.algorithm!==ALGORITHM||p.context!==CONTEXT)throw new Error('Unsupported receipt format, algorithm, or context.');
  return {format:p.format,algorithm:ALGORITHM,context:CONTEXT,intent:normalizeIntent(p.intent),signature:b64(unb64(p.signature,SIGNATURE_BYTES))};
}
export const serializeReceipt = receipt => JSON.stringify(parseReceipt(receipt),null,2)+'\n';
export async function verifyReceipt(input,{expectedFingerprint, now=Date.now()}={}) {
  const receipt=parseReceipt(input),hash=await intentDigest(receipt.intent);
  if(expectedFingerprint!==undefined&&expectedFingerprint!=='')unhex(expectedFingerprint,32);
  const trace=await verifySlh(hash,unb64(receipt.signature,SIGNATURE_BYTES),unhex(receipt.intent.creatorPublicKey,32),utf8.encode(CONTEXT));
  const creator=await fingerprint(receipt.intent.creatorPublicKey);
  const matched=expectedFingerprint?creator===expectedFingerprint:null;
  return {signatureValid:trace.valid,identityTrusted:trace.valid&&matched===true,identityMatch:matched,fingerprint:creator,
    authorizationExpired:now>Date.parse(receipt.intent.expiresAt),issuedInFuture:now<Date.parse(receipt.intent.issuedAt),
    onchainVerified:false,scope:'preview-only',id:hex(hash),trace,receipt};
}
export async function makeReceipt(intent,signature){return parseReceipt({format:'qcommit/launch-authorization/1',algorithm:ALGORITHM,context:CONTEXT,intent:normalizeIntent(intent),signature:b64(signature)});}
