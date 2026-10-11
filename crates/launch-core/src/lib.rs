//! Qcommit production launch wire format. All integers little-endian, no ignored tails.
use borsh::{BorshDeserialize, BorshSerialize};
use seal_slh_verify::{Sha256, SIGNATURE_BYTES};
pub const CONTEXT: &[u8] = b"Qcommit.Launch.v1";
pub const CONFIG_MAGIC: [u8; 8] = *b"QCCONF01";
pub const CREATOR_MAGIC: [u8; 8] = *b"QCCREA01";
pub const PROOF_MAGIC: [u8; 8] = *b"QCPROF01";
pub const RECORD_MAGIC: [u8; 8] = *b"QCLAUN01";
pub const CONFIG_BYTES: usize = 105;
pub const CREATOR_BYTES: usize = 178;
pub const PROOF_HEADER_BYTES: usize = 187;
pub const PROOF_BYTES: usize = PROOF_HEADER_BYTES + SIGNATURE_BYTES + MAX_INTENT_BYTES;
pub const MAX_INTENT_BYTES: usize = 768;
pub const RECORD_BYTES: usize = 1536;
pub const MAX_CHUNK_BYTES: usize = 700;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    InvalidData = 1,
    WrongOwner,
    WrongAddress,
    MissingSigner,
    NotWritable,
    AccountMismatch,
    WrongPhase,
    WrongOffset,
    Overflow,
    Signature,
    Stale,
    Expired,
    IntentMismatch,
    RentExceeded,
    UntrustedDeployment,
    UnsupportedPolicy,
}
pub type Result<T> = core::result::Result<T, Error>;
pub fn ensure(condition: bool, error: Error) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(error)
    }
}
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct Config {
    pub magic: [u8; 8],
    pub bump: u8,
    pub genesis: [u8; 32],
    pub deployment: [u8; 32],
    pub bootstrap_authority: [u8; 32],
}
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct Creator {
    pub magic: [u8; 8],
    pub bump: u8,
    pub config: [u8; 32],
    pub id: [u8; 32],
    pub payer: [u8; 32],
    pub key: [u8; 32],
    pub salt: [u8; 32],
    pub nonce: u64,
    pub active: bool,
}
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct Proof {
    pub magic: [u8; 8],
    pub bump: u8,
    pub creator: [u8; 32],
    pub uploader: [u8; 32],
    pub digest: [u8; 32],
    pub key: [u8; 32],
    pub kind: u8,
    pub nonce: u64,
    pub expiry: u64,
    pub intent_len: u16,
    pub uploaded: u16,
    pub stage: u8,
    pub root: [u8; 16],
    pub tree: u64,
    pub leaf: u32,
}
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct LaunchRecord {
    pub magic: [u8; 8],
    pub bump: u8,
    pub creator: [u8; 32],
    pub nonce: u64,
    pub digest: [u8; 32],
    pub mint: [u8; 32],
    pub recipient: [u8; 32],
    pub ata: [u8; 32],
    pub metadata: [u8; 32],
    pub slot: u64,
    pub payer: [u8; 32],
    pub intent: Vec<u8>,
}
pub fn creator_id<H: Sha256>(
    config: &Config,
    payer: &[u8; 32],
    key: &[u8; 32],
    salt: &[u8; 32],
) -> [u8; 32] {
    H::hashv(&[
        b"Qcommit.Creator.v1\0",
        &config.genesis,
        &config.deployment,
        payer,
        key,
        salt,
    ])
}
pub fn register_digest<H: Sha256>(
    program: &[u8; 32],
    config: &Config,
    creator: &[u8; 32],
    key: &[u8; 32],
    payer: &[u8; 32],
    expiry: u64,
) -> [u8; 32] {
    H::hashv(&[
        b"Qcommit.Register.v1\0",
        program,
        &config.genesis,
        &config.deployment,
        creator,
        key,
        payer,
        &0u64.to_le_bytes(),
        &expiry.to_le_bytes(),
    ])
}
pub fn intent_digest<H: Sha256>(bytes: &[u8]) -> [u8; 32] {
    H::hashv(&[b"Qcommit.LaunchIntent.v1\0", bytes])
}
impl Creator {
    pub fn check_proof(&self, proof: &Proof, slot: u64) -> Result<()> {
        ensure(
            proof.key == self.key && proof.nonce == self.nonce,
            Error::Stale,
        )?;
        ensure(proof.expiry >= slot, Error::Expired)?;
        match proof.kind {
            0 => ensure(!self.active && self.nonce == 0, Error::WrongPhase),
            1 => ensure(self.active, Error::WrongPhase),
            _ => Err(Error::InvalidData),
        }
    }
}
// Protocol-defined whitespace: Unicode White_Space plus the JavaScript BOM whitespace.
fn protocol_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Deliberately bounded URI syntax shared byte-for-byte with the SDK. No network fetch.
pub fn valid_metadata_uri(uri: &str) -> bool {
    let bytes = uri.as_bytes();
    if bytes.is_empty() || bytes.len() > 200 {
        return false;
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || b"-._~:/?#@!$&'()*+,;=%".contains(b))
    {
        return false;
    }
    for (n, b) in bytes.iter().enumerate() {
        if *b == b'%'
            && (n + 2 >= bytes.len()
                || !bytes[n + 1].is_ascii_hexdigit()
                || !bytes[n + 2].is_ascii_hexdigit())
        {
            return false;
        }
    }
    let (scheme, rest) = if let Some(rest) = uri.strip_prefix("https://") {
        (0, rest)
    } else if let Some(rest) = uri.strip_prefix("ipfs://") {
        (1, rest)
    } else if let Some(rest) = uri.strip_prefix("ar://") {
        (1, rest)
    } else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return false;
    }
    if scheme == 1 {
        return authority
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b));
    }
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if let Some(port) = port {
        if port.is_empty()
            || port.len() > 5
            || !port.bytes().all(|b| b.is_ascii_digit())
            || (port.len() > 1 && port.starts_with('0'))
            || port.parse::<u16>().ok().filter(|p| *p > 0).is_none()
        {
            return false;
        }
    }
    let host = host.strip_suffix('.').unwrap_or(host);
    let labels: Vec<&str> = host.split('.').collect();
    if labels.iter().any(|label| {
        label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) {
        return false;
    }
    let last = *labels.last().unwrap();
    let numeric_hex = last
        .strip_prefix("0x")
        .or_else(|| last.strip_prefix("0X"))
        .map(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .unwrap_or(false);
    if numeric_hex || last.bytes().all(|b| b.is_ascii_digit()) {
        return labels.len() == 4
            && labels.iter().all(|label| {
                (label.len() == 1 || !label.starts_with('0'))
                    && label.bytes().all(|b| b.is_ascii_digit())
                    && label.parse::<u8>().is_ok()
            });
    }
    true
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub program: [u8; 32],
    pub genesis: [u8; 32],
    pub deployment: [u8; 32],
    pub creator: [u8; 32],
    pub epoch: u64,
    pub nonce: u64,
    pub expiry: u64,
    pub token_program: [u8; 32],
    pub mint: [u8; 32],
    pub recipient: [u8; 32],
    pub payer: [u8; 32],
    pub decimals: u8,
    pub supply: u64,
    pub max_execution_rent: u64,
    pub platform_fee: u64,
    pub max_network_fee: u64,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub content_hash: [u8; 32],
    pub mint_policy: u8,
    pub freeze_policy: u8,
}
impl Intent {
    pub fn decode(data: &[u8]) -> Result<Self> {
        let mut r = Reader(data);
        ensure(r.take(8)? == b"QCLNCH01", Error::InvalidData)?;
        let value = Self {
            program: r.array()?,
            genesis: r.array()?,
            deployment: r.array()?,
            creator: r.array()?,
            epoch: r.u64()?,
            nonce: r.u64()?,
            expiry: r.u64()?,
            token_program: r.array()?,
            mint: r.array()?,
            recipient: r.array()?,
            payer: r.array()?,
            decimals: r.byte()?,
            supply: r.u64()?,
            max_execution_rent: r.u64()?,
            platform_fee: r.u64()?,
            max_network_fee: r.u64()?,
            name: r.string(32)?,
            symbol: r.string(10)?,
            uri: r.string(200)?,
            content_hash: r.array()?,
            mint_policy: r.byte()?,
            freeze_policy: r.byte()?,
        };
        r.end()?;
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<()> {
        ensure(
            self.epoch == 0
                && self.mint_policy == 0
                && self.freeze_policy == 0
                && self.platform_fee == 0,
            Error::UnsupportedPolicy,
        )?;
        ensure(
            self.decimals <= 9
                && self.supply > 0
                && self.max_execution_rent > 0
                && self.content_hash != [0; 32],
            Error::InvalidData,
        )?;
        for (s, max) in [(&self.name, 32), (&self.symbol, 10), (&self.uri, 200)] {
            ensure(
                !s.is_empty()
                    && s.len() <= max
                    && s.trim_matches(protocol_whitespace) == s
                    && !s.chars().any(char::is_control),
                Error::InvalidData,
            )?;
        }
        ensure(
            self.symbol
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            Error::InvalidData,
        )?;
        ensure(valid_metadata_uri(&self.uri), Error::InvalidData)
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut o = b"QCLNCH01".to_vec();
        for v in [
            &self.program,
            &self.genesis,
            &self.deployment,
            &self.creator,
        ] {
            o.extend(v);
        }
        for v in [self.epoch, self.nonce, self.expiry] {
            o.extend(v.to_le_bytes());
        }
        for v in [
            &self.token_program,
            &self.mint,
            &self.recipient,
            &self.payer,
        ] {
            o.extend(v);
        }
        o.push(self.decimals);
        for v in [
            self.supply,
            self.max_execution_rent,
            self.platform_fee,
            self.max_network_fee,
        ] {
            o.extend(v.to_le_bytes());
        }
        for v in [&self.name, &self.symbol, &self.uri] {
            o.extend((v.len() as u16).to_le_bytes());
            o.extend(v.as_bytes());
        }
        o.extend(self.content_hash);
        o.extend([self.mint_policy, self.freeze_policy]);
        Ok(o)
    }
}
pub struct Reader<'a>(pub &'a [u8]);
impl<'a> Reader<'a> {
    pub fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        ensure(n <= self.0.len(), Error::InvalidData)?;
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Ok(a)
    }
    pub fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.take(N)?.try_into().map_err(|_| Error::InvalidData)
    }
    pub fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    pub fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.array()?))
    }
    pub fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.array()?))
    }
    pub fn string(&mut self, max: usize) -> Result<String> {
        let n = self.u16()? as usize;
        ensure(n <= max, Error::InvalidData)?;
        String::from_utf8(self.take(n)?.to_vec()).map_err(|_| Error::InvalidData)
    }
    pub fn end(self) -> Result<()> {
        ensure(self.0.is_empty(), Error::InvalidData)
    }
}
