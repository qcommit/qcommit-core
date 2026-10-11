use qcommit_launch_core::*;
use seal_slh_verify::Sha256;
use sha2::{Digest, Sha256 as Native};
struct Hash;
impl Sha256 for Hash {
    fn hashv(p: &[&[u8]]) -> [u8; 32] {
        let mut h = Native::new();
        for x in p {
            h.update(x)
        }
        h.finalize().into()
    }
}
fn config() -> Config {
    Config {
        magic: CONFIG_MAGIC,
        bump: 1,
        genesis: [1; 32],
        deployment: [2; 32],
        bootstrap_authority: [3; 32],
    }
}
fn creator() -> Creator {
    Creator {
        magic: CREATOR_MAGIC,
        bump: 1,
        config: [4; 32],
        id: [5; 32],
        payer: [6; 32],
        key: [7; 32],
        salt: [8; 32],
        nonce: 0,
        active: false,
    }
}
fn proof() -> Proof {
    Proof {
        magic: PROOF_MAGIC,
        bump: 1,
        creator: [9; 32],
        uploader: [6; 32],
        digest: [10; 32],
        key: [7; 32],
        kind: 0,
        nonce: 0,
        expiry: 100,
        intent_len: 0,
        uploaded: 0,
        stage: 0,
        root: [0; 16],
        tree: 0,
        leaf: 0,
    }
}
fn intent() -> Intent {
    Intent {
        program: [1; 32],
        genesis: [2; 32],
        deployment: [3; 32],
        creator: [4; 32],
        epoch: 0,
        nonce: 0,
        expiry: 100,
        token_program: [5; 32],
        mint: [6; 32],
        recipient: [7; 32],
        payer: [8; 32],
        decimals: 9,
        supply: 1_000_000_000,
        max_execution_rent: 100_000_000,
        platform_fee: 0,
        max_network_fee: 1_000_000,
        name: "Quantum launch".into(),
        symbol: "QTEST".into(),
        uri: "https://example.invalid/metadata.json".into(),
        content_hash: [9; 32],
        mint_policy: 0,
        freeze_policy: 0,
    }
}
#[test]
fn layouts_are_exact() {
    assert_eq!(borsh::to_vec(&config()).unwrap().len(), CONFIG_BYTES);
    assert_eq!(borsh::to_vec(&creator()).unwrap().len(), CREATOR_BYTES);
    assert_eq!(borsh::to_vec(&proof()).unwrap().len(), PROOF_HEADER_BYTES);
    assert_eq!(PROOF_BYTES, 8811)
}
#[test]
fn intent_roundtrip_is_canonical() {
    let i = intent();
    let b = i.encode().unwrap();
    assert_eq!(Intent::decode(&b).unwrap(), i);
    assert_eq!(Intent::decode(&b).unwrap().encode().unwrap(), b)
}
#[test]
fn max_intent_fits_proof_and_record() {
    let mut i = intent();
    i.name = "n".repeat(32);
    i.symbol = "S".repeat(10);
    i.uri = format!("https://x/{}", "u".repeat(190));
    let b = i.encode().unwrap();
    assert_eq!(b.len(), 603);
    assert!(b.len() <= MAX_INTENT_BYTES);
    assert!(253 + b.len() <= RECORD_BYTES)
}
#[test]
fn every_truncation_and_tail_rejected() {
    let b = intent().encode().unwrap();
    for n in 0..b.len() {
        assert!(Intent::decode(&b[..n]).is_err(), "{n}");
    }
    let mut b = b;
    b.push(0);
    assert!(Intent::decode(&b).is_err());
}
#[test]
fn strict_utf8_and_length_bound() {
    let mut b = intent().encode().unwrap();
    let name_offset = 8 + 128 + 24 + 128 + 1 + 32;
    assert_eq!(
        u16::from_le_bytes(b[name_offset..name_offset + 2].try_into().unwrap()),
        14
    );
    b[name_offset + 2] = 255;
    assert!(Intent::decode(&b).is_err());
    let mut b = intent().encode().unwrap();
    b[name_offset..name_offset + 2].copy_from_slice(&65535u16.to_le_bytes());
    assert!(Intent::decode(&b).is_err());
}
#[test]
fn rejects_unimplemented_policies() {
    for field in 0..4 {
        let mut i = intent();
        match field {
            0 => i.epoch = 1,
            1 => i.mint_policy = 1,
            2 => i.freeze_policy = 1,
            _ => i.platform_fee = 1,
        };
        assert_eq!(i.encode(), Err(Error::UnsupportedPolicy));
    }
}
#[test]
fn invalid_supply_decimal_hash_and_rent_rejected() {
    for field in 0..4 {
        let mut i = intent();
        match field {
            0 => i.supply = 0,
            1 => i.decimals = 10,
            2 => i.content_hash = [0; 32],
            _ => i.max_execution_rent = 0,
        };
        assert_eq!(i.encode(), Err(Error::InvalidData));
    }
}
#[test]
fn rejects_control_ambiguous_and_oversized_metadata() {
    for v in ["", " bad", "bad ", "bad\0name", "bad\nname"] {
        let mut i = intent();
        i.name = v.into();
        assert!(i.encode().is_err());
    }
    let mut i = intent();
    i.symbol = "ü".repeat(6);
    assert!(i.encode().is_err());
    for v in [
        "file:///secret",
        "http://unsafe.example",
        "https://",
        "ipfs://",
        "ar://",
        "https://user:pass@example.com/x",
        "https://example.com/a b",
        "https://example.com/a\\b",
    ] {
        let mut i = intent();
        i.uri = v.into();
        assert!(i.encode().is_err());
    }
}
#[test]
fn creator_id_is_bound_to_payer_key_salt_genesis_deployment() {
    let c = config();
    let original = creator_id::<Hash>(&c, &[1; 32], &[2; 32], &[3; 32]);
    for n in 0..5 {
        let mut c = config();
        let (mut p, mut k, mut s) = ([1; 32], [2; 32], [3; 32]);
        match n {
            0 => c.genesis[0] ^= 1,
            1 => c.deployment[0] ^= 1,
            2 => p[0] ^= 1,
            3 => k[0] ^= 1,
            _ => s[0] ^= 1,
        };
        assert_ne!(original, creator_id::<Hash>(&c, &p, &k, &s));
    }
}
#[test]
fn registration_is_expiry_and_domain_bound() {
    let c = config();
    let d = register_digest::<Hash>(&[1; 32], &c, &[2; 32], &[3; 32], &[4; 32], 100);
    assert_ne!(
        d,
        register_digest::<Hash>(&[1; 32], &c, &[2; 32], &[3; 32], &[4; 32], 101)
    );
    assert_ne!(d, intent_digest::<Hash>(&d));
    assert_ne!(CONTEXT, b"Qcommit.Preview.v1");
}
#[test]
fn only_unactivated_zero_nonce_registration() {
    let mut c = creator();
    let h = proof();
    assert!(c.check_proof(&h, 99).is_ok());
    c.active = true;
    assert_eq!(c.check_proof(&h, 99), Err(Error::WrongPhase));
    c.active = false;
    c.nonce = 1;
    let mut h = h;
    h.nonce = 1;
    assert_eq!(c.check_proof(&h, 99), Err(Error::WrongPhase));
}
#[test]
fn launch_requires_active_creator() {
    let mut c = creator();
    let mut h = proof();
    h.kind = 1;
    assert_eq!(c.check_proof(&h, 99), Err(Error::WrongPhase));
    c.active = true;
    assert!(c.check_proof(&h, 100).is_ok());
}
#[test]
fn expired_replayed_wrongkey_proofs_rejected() {
    let c = creator();
    let h = proof();
    assert_eq!(c.check_proof(&h, 101), Err(Error::Expired));
    let mut h = proof();
    h.nonce = 1;
    assert_eq!(c.check_proof(&h, 99), Err(Error::Stale));
    let mut h = proof();
    h.key[0] ^= 1;
    assert_eq!(c.check_proof(&h, 99), Err(Error::Stale));
}
#[test]
fn arbitrary_kind_rejected() {
    let c = creator();
    let mut h = proof();
    h.kind = 2;
    assert_eq!(c.check_proof(&h, 99), Err(Error::InvalidData));
}
#[test]
fn every_launch_byte_affects_digest() {
    let b = intent().encode().unwrap();
    let d = intent_digest::<Hash>(&b);
    for n in 0..b.len() {
        let mut altered = b.clone();
        altered[n] ^= 1;
        assert_ne!(d, intent_digest::<Hash>(&altered));
    }
}
#[test]
fn independent_javascript_codec_vector_matches_rust() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../../sdk/tests/launch-intent-vector.json")).unwrap();
    let raw = hex::decode(v["bytesHex"].as_str().unwrap()).unwrap();
    let i = Intent::decode(&raw).unwrap();
    assert_eq!(
        hex::encode(intent_digest::<Hash>(&raw)),
        v["digestHex"].as_str().unwrap()
    );
    assert_eq!(i.encode().unwrap(), raw);
    assert_eq!(i.name, v["intent"]["name"].as_str().unwrap());
    assert_eq!(i.symbol, v["intent"]["symbol"].as_str().unwrap());
    assert_eq!(i.uri, v["intent"]["metadataUri"].as_str().unwrap());
    assert_eq!(
        i.supply.to_string(),
        v["intent"]["supplyBaseUnits"].as_str().unwrap()
    );
    let conf = Config {
        magic: CONFIG_MAGIC,
        bump: 0,
        genesis: i.genesis,
        deployment: i.deployment,
        bootstrap_authority: [0; 32],
    };
    assert_eq!(
        hex::encode(register_digest::<Hash>(
            &i.program, &conf, &i.creator, &[5; 32], &i.payer, i.expiry
        )),
        v["registrationDigestHex"].as_str().unwrap()
    );
    assert_eq!(
        hex::encode(creator_id::<Hash>(&conf, &i.payer, &[5; 32], &[6; 32])),
        v["creatorIdHex"].as_str().unwrap()
    );
}

#[test]
fn shared_javascript_rust_text_validation_corpus() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../../../sdk/tests/launch-text-corpus.json")).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 165);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let field = case["field"].as_str().unwrap();
        let value = case["value"].as_str().unwrap();
        let expected = case["valid"].as_bool().unwrap();
        let mut i = intent();
        match field {
            "name" => i.name = value.into(),
            "symbol" => i.symbol = value.into(),
            "metadataUri" => i.uri = value.into(),
            _ => panic!("unexpected field"),
        };
        assert_eq!(i.encode().is_ok(), expected, "{id} object encode");
        // Exercise independently assembled bytes, including values rejected before signing.
        let mut wire = intent().encode().unwrap();
        let mut offset = 321;
        for candidate in ["name", "symbol", "metadataUri"] {
            let n = u16::from_le_bytes(wire[offset..offset + 2].try_into().unwrap()) as usize;
            if candidate == field {
                let mut replacement = (value.len() as u16).to_le_bytes().to_vec();
                replacement.extend(value.as_bytes());
                wire.splice(offset..offset + 2 + n, replacement);
                break;
            }
            offset += 2 + n;
        }
        let parsed = Intent::decode(&wire);
        assert_eq!(parsed.is_ok(), expected, "{id} raw decode");
        if expected {
            assert_eq!(parsed.unwrap().encode().unwrap(), wire, "{id} exact bytes");
        }
    }
}
