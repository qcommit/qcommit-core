#!/usr/bin/env python3
"""Independent offline verification of a Meteora launch's creator commitment."""
import argparse, hashlib, json, re, sys
from pathlib import Path
from verify import distinct, exact_fields, hex32, address, text
from slh_verify import verify

FIELDS=['network','genesis','config','mint','pool','owner','name','symbol','metadataSha256','messageSha256']
CONTEXT='Qcommit.MeteoraLaunch.v1'

def verify_receipt(path,expected_key):
    with Path(path).open('rb') as f:raw=f.read(32769)
    if len(raw)>32768:raise ValueError('Receipt exceeds 32 KiB.')
    def invalid_constant(value):raise ValueError('Invalid JSON number')
    r=json.loads(raw.decode('utf8'),object_pairs_hook=distinct,parse_constant=invalid_constant)
    exact_fields(r,['format','name','symbol','mint','pool','creatorProof','confirmation'])
    if r['format']!='qcommit/meteora-launch-receipt/1':raise ValueError('Wrong receipt profile.')
    p=r['creatorProof'];exact_fields(p,['intent','publicKey','signature','context','algorithm'])
    if p['context']!=CONTEXT or p['algorithm']!='SLH-DSA-SHA2-128s':raise ValueError('Wrong creator signature profile.')
    i=p['intent'];exact_fields(i,FIELDS)
    if i['network']!='mainnet-beta' or i['genesis']!='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':raise ValueError('Wrong launch network.')
    for k in ['config','mint','pool','owner']:address(i[k])
    for k in ['metadataSha256','messageSha256']:hex32(i[k])
    text(i['name'],32,True)
    if not isinstance(i['symbol'],str) or not re.fullmatch('[A-Z0-9]{1,10}',i['symbol']):raise ValueError('Invalid symbol.')
    if any(r[k]!=i[k] for k in ['name','symbol','mint','pool']) or not isinstance(r['confirmation'],dict) or any(r['confirmation'].get(k)!=i[k] for k in ['mint','pool','config']):raise ValueError('Receipt differs from signed launch fields.')
    hex32(expected_key);hex32(p['publicKey'])
    if p['publicKey']!=expected_key:raise ValueError('Creator key differs from independently supplied key.')
    if not isinstance(p['signature'],str) or not re.fullmatch('[0-9a-f]{15712}',p['signature']):raise ValueError('Invalid signature encoding.')
    message=hashlib.sha256(json.dumps({k:i[k] for k in FIELDS},ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf8')).digest()
    result=verify(message,bytes.fromhex(p['signature']),bytes.fromhex(expected_key),CONTEXT.encode(),trace=True)
    if result is False or not result.valid:raise ValueError('Creator signature rejected.')
    return {'signatureValid':True,'creatorKeyMatched':True,'onchainVerified':False,'scope':'creator-commitment','intentDigest':message.hex(),'layerRoots':result.layer_roots,'note':'The signature authenticates the original launch commitment. RPC transaction and pool confirmation are separate checks.'}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('receipt');parser.add_argument('--key',required=True);args=parser.parse_args()
    try:print(json.dumps(verify_receipt(args.receipt,args.key),indent=2))
    except (ValueError,TypeError,KeyError,OSError,UnicodeError,RecursionError) as e:print('INVALID: '+str(e),file=sys.stderr);return 1
    return 0
if __name__=='__main__':raise SystemExit(main())
