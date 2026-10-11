#!/usr/bin/env python3
"""Offline preview receipt verification with an independently supplied creator key."""
import argparse
import base64
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from slh_verify import verify

FIELDS = ['version','scope','network','creatorPublicKey','creatorLabel','fundingWallet','launchId','name','symbol','description','metadataUri','metadataSha256','decimals','supply','recipient','mintAuthority','freezeAuthority','issuedAt','expiresAt']

def distinct(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError(f'Duplicate field: {key}')
        result[key] = value
    return result

def exact_fields(value, fields):
    if not isinstance(value,dict) or set(value) != set(fields):raise ValueError('Unexpected or missing fields.')

def hex32(value):
    if not isinstance(value,str) or not re.fullmatch('[0-9a-f]{64}',value):raise ValueError('Expected 32-byte lowercase hexadecimal value.')

def text(value, limit, required=False):
    if not isinstance(value,str) or len(value.encode('utf8')) > limit or re.search(r'[\x00-\x1f\x7f]',value) or (required and not value.strip('\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')):
        raise ValueError('Invalid text field.')

def address(value):
    alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    if not isinstance(value,str) or not 32 <= len(value) <= 44 or any(c not in alphabet for c in value):raise ValueError('Invalid Solana address.')
    n=0
    for c in value:n=n*58+alphabet.index(c)
    zeros=len(value)-len(value.lstrip('1'))
    if zeros+(n.bit_length()+7)//8 != 32:raise ValueError('Address does not encode 32 bytes.')

def stamp(value):
    if not isinstance(value,str) or not re.fullmatch(r'[1-9]\d{3}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z',value):raise ValueError('Invalid timestamp encoding.')
    return datetime.strptime(value,'%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)

def validate_intent(i):
    exact_fields(i,FIELDS)
    if type(i['version']) is not int or i['version']!=1 or i['scope']!='preview-only' or i['network'] not in ('solana:devnet','solana:mainnet'):raise ValueError('Unsupported intent profile.')
    hex32(i['creatorPublicKey']);hex32(i['launchId'])
    text(i['creatorLabel'],80,True);text(i['name'],32,True);text(i['description'],400);text(i['metadataUri'],200)
    if not isinstance(i['symbol'],str) or not re.fullmatch('[A-Z0-9]{1,10}',i['symbol']):raise ValueError('Invalid symbol.')
    if i['metadataUri']:
        u=re.fullmatch(r'(https|ipfs|ar)://([^/?#]+)(?:[/?#].*)?',i['metadataUri'],re.I)
        if not u or re.search(r'[\x00-\x20\x7f\\]',i['metadataUri']):raise ValueError('Invalid absolute metadata URI.')
        if u.group(1).lower()=='https':
            a=re.fullmatch(r'([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?',u.group(2))
            if not a:raise ValueError('Invalid metadata HTTPS authority.')
            host=a.group(1).removesuffix('.')
            if len(host)>253 or any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?',x) for x in host.split('.')) or (a.group(2) is not None and not 1<=int(a.group(2))<=65535):raise ValueError('Invalid metadata hostname or port.')
        elif not re.fullmatch(r'[A-Za-z0-9._-]+',u.group(2)):raise ValueError('Invalid metadata content identifier.')
    if i['metadataSha256'] is not None:hex32(i['metadataSha256'])
    address(i['fundingWallet']);address(i['recipient'])
    if type(i['decimals']) is not int or not 0<=i['decimals']<=9:raise ValueError('Invalid decimals.')
    if not isinstance(i['supply'],str) or not re.fullmatch('[1-9][0-9]{0,19}',i['supply']) or int(i['supply'])*10**i['decimals']>2**64-1:raise ValueError('Invalid exact supply.')
    if i['mintAuthority']!='revoke' or i['freezeAuthority']!='none':raise ValueError('Unsupported authority policy.')
    issued,expires=stamp(i['issuedAt']),stamp(i['expiresAt'])
    if not 60<=(expires-issued).total_seconds()<=86400:raise ValueError('Invalid approval lifetime.')
    return issued,expires

def verify_receipt(path, expected_key):
    with Path(path).open('rb') as f:raw=f.read(32769)
    if len(raw)>32768:raise ValueError('Receipt exceeds 32 KiB.')
    def invalid_constant(value):raise ValueError(f'Invalid JSON number: {value}')
    p=json.loads(raw.decode('utf8'),object_pairs_hook=distinct,parse_constant=invalid_constant)
    exact_fields(p,['format','algorithm','context','intent','signature'])
    if (p['format'],p['algorithm'],p['context'])!=('qcommit/launch-authorization/1','SLH-DSA-SHA2-128s','Qcommit.LaunchPreview.v1'):raise ValueError('Unsupported receipt profile.')
    i=p['intent'];issued,expires=validate_intent(i);hex32(expected_key)
    if i['creatorPublicKey']!=expected_key:raise ValueError('Creator key does not match the separately supplied key.')
    canonical=json.dumps({k:i[k] for k in FIELDS},ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf8')
    message=hashlib.sha256(b'Qcommit/LaunchPreview/v1\0'+canonical).digest()
    signature=base64.b64decode(p['signature'],validate=True)
    if base64.b64encode(signature).decode()!=p['signature']:raise ValueError('Noncanonical signature encoding.')
    result=verify(message,signature,bytes.fromhex(expected_key),p['context'].encode(),trace=True)
    if result is False or not result.valid:raise ValueError('Signature verification failed.')
    now=datetime.now(timezone.utc)
    return {'signatureValid':True,'creatorKeyMatched':True,'onchainVerified':False,'scope':'preview-only',
            'authorizationExpired':now>expires,'issuedInFuture':now<issued,'intentDigest':message.hex(),
            'layerRoots':result.layer_roots,'note':'Checks a preview authorization, not token creation, on-chain registration or metadata availability.'}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('receipt');parser.add_argument('--key',required=True)
    args=parser.parse_args()
    try:print(json.dumps(verify_receipt(args.receipt,args.key),indent=2))
    except (ValueError,TypeError,KeyError,OSError,UnicodeError,RecursionError) as error:
        print(f'INVALID: {error}',file=sys.stderr);return 1
    return 0
if __name__=='__main__':raise SystemExit(main())
