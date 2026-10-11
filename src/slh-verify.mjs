/** Verify-only FIPS 205 SHA2-128s. No secret keys and no signing implementation. */
const N=16, A=12, K=14, D=7, HP=9, WOTS=35, FORS=2912, XMSS=704, SIG=7856;
const concat=(...parts)=>{const b=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){b.set(p,at);at+=p.length;}return b;};
const sha=async input=>new Uint8Array(await crypto.subtle.digest('SHA-256',input));
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
function address(layer,tree,kind,leaf=0,chain=0,step=0){const a=new Uint8Array(22),v=new DataView(a.buffer);a[0]=layer;v.setBigUint64(1,tree);a[9]=kind;v.setUint32(10,leaf);v.setUint32(14,chain);v.setUint32(18,step);return a;}
function base(data,b,count){const result=[];let pos=0,bits=0,total=0;for(let i=0;i<count;i++){while(bits<b){total=(total<<8)|data[pos++];bits+=8;}bits-=b;result.push((total>>>bits)&((1<<b)-1));}return result;}
function integer(data){let n=0n;for(const b of data)n=n*256n+BigInt(b);return n;}
export async function verifySlh(message,signature,publicKey,context=new Uint8Array()) {
  if(![message,signature,publicKey,context].every(x=>x instanceof Uint8Array))throw new TypeError('Verification inputs must be byte arrays.');
  if(message.length>32768||context.length>255)throw new Error('Verification input exceeds its bound.');
  if(signature.length!==SIG||publicKey.length!==32)return {valid:false,hashCalls:0,layerRoots:[]};
  const framed=concat(Uint8Array.of(0,context.length),context,message);
  const r=signature.slice(0,N),seed=publicKey.slice(0,N);
  const inner=await sha(concat(r,publicKey,framed));
  const md=(await sha(concat(r,seed,inner,new Uint8Array(4)))).slice(0,30);
  let tree=integer(md.slice(21,28))&((1n<<54n)-1n),leaf=Number(integer(md.slice(28,30))&511n);
  const prefix=concat(seed,new Uint8Array(48));let hashCalls=0;
  const hash=async(a,v)=>{hashCalls++;return (await sha(concat(prefix,a,v))).slice(0,N);};
  const roots=[];
  for(const [i,local] of base(md.slice(0,21),A,K).entries()){
    let index=(i<<A)+local,at=N+i*(A+1)*N;
    let node=await hash(address(0,tree,3,leaf,0,index),signature.slice(at,at+N));
    for(let h=0;h<A;h++){at+=N;const sibling=signature.slice(at,at+N),pair=index&1?concat(sibling,node):concat(node,sibling);index>>=1;node=await hash(address(0,tree,3,leaf,h+1,index),pair);}
    roots.push(node);
  }
  let node=await hash(address(0,tree,4,leaf),concat(...roots));
  const forsRoot=hex(node),layerRoots=[];
  for(let layer=0;layer<D;layer++){
    const start=N+FORS+layer*XMSS,digits=base(node,4,32);
    const sum=digits.reduce((n,d)=>n+15-d,0)<<4;
    digits.push(...base(Uint8Array.of(sum>>>8,sum&255),4,3));
    const chains=[];
    for(const [chain,digit] of digits.entries()){
      let part=signature.slice(start+chain*N,start+(chain+1)*N);
      for(let step=digit;step<15;step++)part=await hash(address(layer,tree,0,leaf,chain,step),part);
      chains.push(part);
    }
    node=await hash(address(layer,tree,1,leaf),concat(...chains));
    let index=leaf;
    for(let h=0;h<HP;h++){
      const pos=start+WOTS*N+h*N,sibling=signature.slice(pos,pos+N),pair=index&1?concat(sibling,node):concat(node,sibling);
      index>>=1;node=await hash(address(layer,tree,2,0,h+1,index),pair);
    }
    layerRoots.push(hex(node));leaf=Number(tree&511n);tree>>=9n;
  }
  let difference=0;for(let i=0;i<N;i++)difference|=node[i]^publicKey[N+i];
  return {valid:difference===0,hashCalls,forsRoot,layerRoots};
}
