//! Program-enforced SLH-DSA launch authorization; immutable classic SPL supply/metadata.
use borsh::{BorshDeserialize, BorshSerialize};
use qcommit_launch_core::*;
use seal_slh_verify::{Progress, Sha256, SIGNATURE_BYTES};
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::{instruction as system_ix, program::ID as SYSTEM_ID};
#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);
pub const TOKEN_ID: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_ID: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const METADATA_ID: Pubkey =
    solana_program::pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
pub const LOADER_ID: Pubkey =
    solana_program::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
struct Hash;
impl Sha256 for Hash {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        solana_program::hash::hashv(parts).to_bytes()
    }
}
#[derive(Debug)]
enum Failure {
    Core(Error),
    Runtime(ProgramError),
}
impl From<Error> for Failure {
    fn from(e: Error) -> Self {
        Self::Core(e)
    }
}
impl From<ProgramError> for Failure {
    fn from(e: ProgramError) -> Self {
        Self::Runtime(e)
    }
}
type R<T> = core::result::Result<T, Failure>;
fn check(v: bool, e: Error) -> R<()> {
    ensure(v, e).map_err(Into::into)
}
fn exact(a: &[AccountInfo], n: usize) -> R<()> {
    check(a.len() == n, Error::AccountMismatch)
}
fn signer(a: &AccountInfo) -> R<()> {
    check(a.is_signer, Error::MissingSigner)
}
fn writable(a: &AccountInfo) -> R<()> {
    check(a.is_writable, Error::NotWritable)
}
fn save<T: BorshSerialize>(a: &AccountInfo, value: &T, bytes: usize) -> R<()> {
    writable(a)?;
    let mut d = a.try_borrow_mut_data()?;
    check(d.len() >= bytes, Error::InvalidData)?;
    let mut out = &mut d[..bytes];
    value.serialize(&mut out).map_err(|_| Error::InvalidData)?;
    check(out.is_empty(), Error::InvalidData)
}
fn load_config(p: &Pubkey, a: &AccountInfo) -> R<Config> {
    check(a.owner == p, Error::WrongOwner)?;
    let d = a.try_borrow_data()?;
    check(d.len() == CONFIG_BYTES, Error::InvalidData)?;
    let c = Config::try_from_slice(&d).map_err(|_| Error::InvalidData)?;
    let (k, b) = Pubkey::find_program_address(&[b"config"], p);
    check(
        c.magic == CONFIG_MAGIC && *a.key == k && c.bump == b,
        Error::WrongAddress,
    )?;
    Ok(c)
}
fn load_creator(p: &Pubkey, a: &AccountInfo) -> R<Creator> {
    check(a.owner == p, Error::WrongOwner)?;
    let d = a.try_borrow_data()?;
    check(d.len() == CREATOR_BYTES, Error::InvalidData)?;
    let c = Creator::try_from_slice(&d).map_err(|_| Error::InvalidData)?;
    let (k, b) = Pubkey::find_program_address(&[b"creator", &c.id], p);
    check(
        c.magic == CREATOR_MAGIC && *a.key == k && c.bump == b,
        Error::WrongAddress,
    )?;
    Ok(c)
}
fn load_proof(p: &Pubkey, a: &AccountInfo) -> R<Proof> {
    check(a.owner == p, Error::WrongOwner)?;
    let d = a.try_borrow_data()?;
    check(d.len() == PROOF_BYTES, Error::InvalidData)?;
    let h = Proof::try_from_slice(&d[..PROOF_HEADER_BYTES]).map_err(|_| Error::InvalidData)?;
    check(
        h.magic == PROOF_MAGIC
            && h.kind <= 1
            && h.stage <= 9
            && h.intent_len as usize <= MAX_INTENT_BYTES
            && h.uploaded as usize <= SIGNATURE_BYTES + h.intent_len as usize,
        Error::InvalidData,
    )?;
    let (k, b) = Pubkey::find_program_address(&[b"proof", &h.creator, &h.digest, &h.uploader], p);
    check(*a.key == k && h.bump == b, Error::WrongAddress)?;
    Ok(h)
}
fn live(p: &Pubkey, c: &AccountInfo, proof: &AccountInfo) -> R<(Creator, Proof)> {
    let cstate = load_creator(p, c)?;
    let h = load_proof(p, proof)?;
    check(h.creator == c.key.to_bytes(), Error::AccountMismatch)?;
    cstate.check_proof(&h, Clock::get()?.slot)?;
    Ok((cstate, h))
}
fn with_config(p: &Pubkey, a: &AccountInfo, c: &Creator) -> R<Config> {
    let conf = load_config(p, a)?;
    check(
        c.config == a.key.to_bytes()
            && c.id == creator_id::<Hash>(&conf, &c.payer, &c.key, &c.salt),
        Error::IntentMismatch,
    )?;
    Ok(conf)
}
fn intent_bound(
    p: &Pubkey,
    conf: &Config,
    c: &Creator,
    creator: &Pubkey,
    h: &Proof,
    i: &Intent,
) -> R<()> {
    check(
        i.program == p.to_bytes()
            && i.genesis == conf.genesis
            && i.deployment == conf.deployment
            && i.creator == creator.to_bytes()
            && i.epoch == 0
            && i.nonce == c.nonce
            && i.nonce == h.nonce
            && i.expiry == h.expiry
            && i.payer == h.uploader
            && i.payer == c.payer
            && h.kind == 1
            && i.token_program == TOKEN_ID.to_bytes(),
        Error::IntentMismatch,
    )?;
    check(c.active && i.expiry >= Clock::get()?.slot, Error::Expired)
}
fn allocate<'a>(
    owner: &Pubkey,
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    bytes: usize,
    seeds: &[&[u8]],
) -> R<()> {
    signer(payer)?;
    writable(payer)?;
    writable(target)?;
    check(
        payer.key != target.key && system.key == &SYSTEM_ID && system.executable,
        Error::AccountMismatch,
    )?;
    check(
        target.owner == &SYSTEM_ID && target.data_is_empty(),
        Error::WrongOwner,
    )?;
    let top = Rent::get()?
        .minimum_balance(bytes)
        .max(1)
        .saturating_sub(target.lamports());
    if top > 0 {
        invoke(
            &system_ix::transfer(payer.key, target.key, top),
            &[payer.clone(), target.clone(), system.clone()],
        )?;
    }
    invoke_signed(
        &system_ix::allocate(target.key, bytes as u64),
        &[target.clone(), system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_ix::assign(target.key, owner),
        &[target.clone(), system.clone()],
        &[seeds],
    )?;
    Ok(())
}
fn init_config(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    exact(a, 5)?;
    let mut r = Reader(data);
    let genesis = r.array()?;
    let deployment = r.array()?;
    r.end()?;
    check(
        genesis != [0; 32] && deployment != [0; 32],
        Error::InvalidData,
    )?;
    signer(&a[0])?;
    check(
        a[2].key == p && a[2].executable && a[2].owner == &LOADER_ID && a[3].owner == &LOADER_ID,
        Error::UntrustedDeployment,
    )?;
    let expected = Pubkey::find_program_address(&[p.as_ref()], &LOADER_ID).0;
    check(*a[3].key == expected, Error::UntrustedDeployment)?;
    {
        let pd = a[2].try_borrow_data()?;
        let d = a[3].try_borrow_data()?;
        check(
            pd.len() == 36
                && pd[..4] == 2u32.to_le_bytes()
                && pd[4..36] == a[3].key.to_bytes()
                && d.len() >= 45
                && d[..4] == 3u32.to_le_bytes()
                && d[12] == 1
                && d[13..45] == a[0].key.to_bytes(),
            Error::UntrustedDeployment,
        )?;
    }
    let (k, bump) = Pubkey::find_program_address(&[b"config"], p);
    check(*a[1].key == k, Error::WrongAddress)?;
    allocate(p, &a[0], &a[1], &a[4], CONFIG_BYTES, &[b"config", &[bump]])?;
    save(
        &a[1],
        &Config {
            magic: CONFIG_MAGIC,
            bump,
            genesis,
            deployment,
            bootstrap_authority: a[0].key.to_bytes(),
        },
        CONFIG_BYTES,
    )
}
fn init_creator(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    exact(a, 4)?;
    let conf = load_config(p, &a[0])?;
    let mut r = Reader(data);
    let key = r.array()?;
    let salt = r.array()?;
    r.end()?;
    check(key != [0; 32] && salt != [0; 32], Error::InvalidData)?;
    let payer = a[2].key.to_bytes();
    let id = creator_id::<Hash>(&conf, &payer, &key, &salt);
    let (k, bump) = Pubkey::find_program_address(&[b"creator", &id], p);
    check(*a[1].key == k, Error::WrongAddress)?;
    allocate(
        p,
        &a[2],
        &a[1],
        &a[3],
        CREATOR_BYTES,
        &[b"creator", &id, &[bump]],
    )?;
    save(
        &a[1],
        &Creator {
            magic: CREATOR_MAGIC,
            bump,
            config: a[0].key.to_bytes(),
            id,
            payer,
            key,
            salt,
            nonce: 0,
            active: false,
        },
        CREATOR_BYTES,
    )
}
fn begin(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    exact(a, 5)?;
    let c = load_creator(p, &a[1])?;
    let conf = with_config(p, &a[0], &c)?;
    let mut r = Reader(data);
    let kind = r.byte()?;
    let nonce = r.u64()?;
    let expiry = r.u64()?;
    let digest = r.array()?;
    let intent_len = r.u16()?;
    r.end()?;
    check(
        (kind == 0 && intent_len == 0)
            || (kind == 1 && intent_len > 0 && intent_len as usize <= MAX_INTENT_BYTES),
        Error::InvalidData,
    )?;
    let creator = a[1].key.to_bytes();
    let uploader = a[3].key.to_bytes();
    if kind == 0 {
        check(
            uploader == c.payer
                && digest
                    == register_digest::<Hash>(
                        &p.to_bytes(),
                        &conf,
                        &creator,
                        &c.key,
                        &c.payer,
                        expiry,
                    ),
            Error::IntentMismatch,
        )?;
    }
    let (k, bump) = Pubkey::find_program_address(&[b"proof", &creator, &digest, &uploader], p);
    check(*a[2].key == k, Error::WrongAddress)?;
    let h = Proof {
        magic: PROOF_MAGIC,
        bump,
        creator,
        uploader,
        digest,
        key: c.key,
        kind,
        nonce,
        expiry,
        intent_len,
        uploaded: 0,
        stage: 0,
        root: [0; 16],
        tree: 0,
        leaf: 0,
    };
    c.check_proof(&h, Clock::get()?.slot)?;
    allocate(
        p,
        &a[3],
        &a[2],
        &a[4],
        PROOF_BYTES,
        &[b"proof", &creator, &digest, &uploader, &[bump]],
    )?;
    save(&a[2], &h, PROOF_HEADER_BYTES)
}
fn append(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    exact(a, 3)?;
    let (_, mut h) = live(p, &a[0], &a[1])?;
    signer(&a[2])?;
    check(a[2].key.to_bytes() == h.uploader, Error::AccountMismatch)?;
    check(h.stage == 0, Error::WrongPhase)?;
    let mut r = Reader(data);
    let offset = r.u16()? as usize;
    let chunk = r.0;
    check(
        !chunk.is_empty() && chunk.len() <= MAX_CHUNK_BYTES,
        Error::InvalidData,
    )?;
    check(offset == h.uploaded as usize, Error::WrongOffset)?;
    let end = offset.checked_add(chunk.len()).ok_or(Error::Overflow)?;
    check(
        end <= SIGNATURE_BYTES + h.intent_len as usize,
        Error::InvalidData,
    )?;
    writable(&a[1])?;
    {
        let mut d = a[1].try_borrow_mut_data()?;
        d[PROOF_HEADER_BYTES + offset..PROOF_HEADER_BYTES + end].copy_from_slice(chunk);
    }
    h.uploaded = end as u16;
    save(&a[1], &h, PROOF_HEADER_BYTES)
}
fn seal(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    exact(a, 3)?;
    check(data.is_empty(), Error::InvalidData)?;
    let (c, mut h) = live(p, &a[0], &a[1])?;
    signer(&a[2])?;
    check(a[2].key.to_bytes() == h.uploader, Error::AccountMismatch)?;
    check(
        h.stage == 0 && h.uploaded as usize == SIGNATURE_BYTES + h.intent_len as usize,
        Error::WrongPhase,
    )?;
    if h.kind == 1 {
        let d = a[1].try_borrow_data()?;
        let bytes = &d[PROOF_HEADER_BYTES + SIGNATURE_BYTES
            ..PROOF_HEADER_BYTES + SIGNATURE_BYTES + h.intent_len as usize];
        let i = Intent::decode(bytes)?;
        check(
            intent_digest::<Hash>(bytes) == h.digest
                && i.creator == h.creator
                && i.payer == h.uploader
                && i.payer == c.payer
                && i.nonce == h.nonce
                && i.expiry == h.expiry
                && i.program == p.to_bytes(),
            Error::IntentMismatch,
        )?;
    }
    h.stage = 1;
    save(&a[1], &h, PROOF_HEADER_BYTES)
}
fn step(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    exact(a, 2)?;
    check(data.is_empty(), Error::InvalidData)?;
    let (_, mut h) = live(p, &a[0], &a[1])?;
    check(
        (1..=8).contains(&h.stage)
            && h.uploaded as usize == SIGNATURE_BYTES + h.intent_len as usize,
        Error::WrongPhase,
    )?;
    let progress = {
        let d = a[1].try_borrow_data()?;
        let sig = &d[PROOF_HEADER_BYTES..PROOF_HEADER_BYTES + SIGNATURE_BYTES];
        if h.stage == 1 {
            seal_slh_verify::start::<Hash>(&h.key, sig, &h.digest, CONTEXT)
        } else {
            seal_slh_verify::advance::<Hash>(
                &h.key,
                sig,
                Progress {
                    layer: h.stage - 2,
                    tree: h.tree,
                    leaf: h.leaf,
                    root: h.root,
                },
            )
        }
        .map_err(|_| Error::Signature)?
    };
    h.stage += 1;
    h.root = progress.root;
    h.tree = progress.tree;
    h.leaf = progress.leaf;
    save(&a[1], &h, PROOF_HEADER_BYTES)
}
fn complete(h: &Proof) -> R<()> {
    check(
        h.stage == 9
            && h.uploaded as usize == SIGNATURE_BYTES + h.intent_len as usize
            && h.root == h.key[16..32]
            && h.tree == 0
            && h.leaf == 0,
        Error::Signature,
    )
}
fn activate(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    exact(a, 4)?;
    check(data.is_empty(), Error::InvalidData)?;
    let (mut c, h) = live(p, &a[1], &a[2])?;
    let conf = with_config(p, &a[0], &c)?;
    signer(&a[3])?;
    check(
        a[3].key.to_bytes() == c.payer
            && h.kind == 0
            && h.intent_len == 0
            && h.digest
                == register_digest::<Hash>(
                    &p.to_bytes(),
                    &conf,
                    &a[1].key.to_bytes(),
                    &c.key,
                    &c.payer,
                    h.expiry,
                ),
        Error::IntentMismatch,
    )?;
    complete(&h)?;
    c.active = true;
    save(&a[1], &c, CREATOR_BYTES)
}
fn execute(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    exact(a, 14)?;
    check(data.is_empty(), Error::InvalidData)?;
    let (mut c, h) = live(p, &a[1], &a[2])?;
    let conf = with_config(p, &a[0], &c)?;
    complete(&h)?;
    let raw = {
        let d = a[2].try_borrow_data()?;
        d[PROOF_HEADER_BYTES + SIGNATURE_BYTES
            ..PROOF_HEADER_BYTES + SIGNATURE_BYTES + h.intent_len as usize]
            .to_vec()
    };
    let i = Intent::decode(&raw)?;
    intent_bound(p, &conf, &c, a[1].key, &h, &i)?;
    check(
        intent_digest::<Hash>(&raw) == h.digest,
        Error::IntentMismatch,
    )?;
    signer(&a[3])?;
    writable(&a[3])?;
    check(
        a[3].key.to_bytes() == i.payer
            && a[4].key.to_bytes() == i.mint
            && a[5].key.to_bytes() == i.recipient,
        Error::AccountMismatch,
    )?;
    for (index, id) in [
        (9, SYSTEM_ID),
        (10, TOKEN_ID),
        (11, ATA_ID),
        (12, METADATA_ID),
    ] {
        check(
            *a[index].key == id && a[index].executable,
            Error::AccountMismatch,
        )?;
    }
    check(
        *a[13].key == solana_program::sysvar::rent::ID,
        Error::AccountMismatch,
    )?;
    let nonce = i.nonce.to_le_bytes();
    let (mint, mb) = Pubkey::find_program_address(&[b"mint", a[1].key.as_ref(), &nonce], p);
    let (record, rb) = Pubkey::find_program_address(&[b"launch", a[1].key.as_ref(), &nonce], p);
    let ata = Pubkey::find_program_address(
        &[a[5].key.as_ref(), TOKEN_ID.as_ref(), mint.as_ref()],
        &ATA_ID,
    )
    .0;
    let metadata = Pubkey::find_program_address(
        &[b"metadata", METADATA_ID.as_ref(), mint.as_ref()],
        &METADATA_ID,
    )
    .0;
    check(
        *a[4].key == mint && *a[6].key == ata && *a[7].key == metadata && *a[8].key == record,
        Error::WrongAddress,
    )?;
    // No protocol transfer is possible; network fees precede this invocation and are SDK-capped.
    let before = a[3].lamports();
    let bump = [c.bump];
    let creator_seeds: &[&[u8]] = &[b"creator", &c.id, &bump];
    allocate(
        &TOKEN_ID,
        &a[3],
        &a[4],
        &a[9],
        82,
        &[b"mint", a[1].key.as_ref(), &nonce, &[mb]],
    )?;
    allocate(
        p,
        &a[3],
        &a[8],
        &a[9],
        RECORD_BYTES,
        &[b"launch", a[1].key.as_ref(), &nonce, &[rb]],
    )?;
    let mut mint_data = vec![20, i.decimals];
    mint_data.extend(a[1].key.as_ref());
    mint_data.push(0);
    invoke(
        &Instruction {
            program_id: TOKEN_ID,
            accounts: vec![AccountMeta::new(mint, false)],
            data: mint_data,
        },
        &[a[4].clone(), a[10].clone()],
    )?;
    invoke(
        &Instruction {
            program_id: ATA_ID,
            accounts: vec![
                AccountMeta::new(*a[3].key, true),
                AccountMeta::new(ata, false),
                AccountMeta::new_readonly(*a[5].key, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(SYSTEM_ID, false),
                AccountMeta::new_readonly(TOKEN_ID, false),
            ],
            data: vec![1],
        },
        &[
            a[3].clone(),
            a[6].clone(),
            a[5].clone(),
            a[4].clone(),
            a[9].clone(),
            a[10].clone(),
            a[11].clone(),
        ],
    )?;
    // Metaplex CreateMetadataAccountV3: immutable DataV2, zero royalties, no creators/collection/uses.
    let mut metadata_data = vec![33];
    for s in [&i.name, &i.symbol, &i.uri] {
        metadata_data.extend((s.len() as u32).to_le_bytes());
        metadata_data.extend(s.as_bytes());
    }
    metadata_data.extend([0, 0, 0, 0, 0, 0, 0]);
    invoke_signed(
        &Instruction {
            program_id: METADATA_ID,
            accounts: vec![
                AccountMeta::new(metadata, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(*a[1].key, true),
                AccountMeta::new(*a[3].key, true),
                AccountMeta::new_readonly(*a[1].key, true),
                AccountMeta::new_readonly(SYSTEM_ID, false),
                AccountMeta::new_readonly(*a[13].key, false),
            ],
            data: metadata_data,
        },
        &[
            a[7].clone(),
            a[4].clone(),
            a[1].clone(),
            a[3].clone(),
            a[9].clone(),
            a[13].clone(),
            a[12].clone(),
        ],
        &[creator_seeds],
    )?;
    let mut mint_to = vec![7];
    mint_to.extend(i.supply.to_le_bytes());
    invoke_signed(
        &Instruction {
            program_id: TOKEN_ID,
            accounts: vec![
                AccountMeta::new(mint, false),
                AccountMeta::new(ata, false),
                AccountMeta::new_readonly(*a[1].key, true),
            ],
            data: mint_to,
        },
        &[a[4].clone(), a[6].clone(), a[1].clone(), a[10].clone()],
        &[creator_seeds],
    )?;
    invoke_signed(
        &Instruction {
            program_id: TOKEN_ID,
            accounts: vec![
                AccountMeta::new(mint, false),
                AccountMeta::new_readonly(*a[1].key, true),
            ],
            data: vec![6, 0, 0],
        },
        &[a[4].clone(), a[1].clone(), a[10].clone()],
        &[creator_seeds],
    )?;
    {
        let d = a[4].try_borrow_data()?;
        check(
            d.len() == 82
                && d[..4] == [0; 4]
                && d[36..44] == i.supply.to_le_bytes()
                && d[44] == i.decimals
                && d[45] == 1
                && d[46..50] == [0; 4],
            Error::IntentMismatch,
        )?;
    }
    {
        let d = a[6].try_borrow_data()?;
        check(
            a[6].owner == &TOKEN_ID
                && d.len() == 165
                && d[..32] == mint.to_bytes()
                && d[32..64] == i.recipient
                && d[64..72] == i.supply.to_le_bytes(),
            Error::IntentMismatch,
        )?;
    }
    check(a[7].owner == &METADATA_ID, Error::WrongOwner)?;
    let spent = before.checked_sub(a[3].lamports()).ok_or(Error::Overflow)?;
    check(spent <= i.max_execution_rent, Error::RentExceeded)?;
    let record_state = LaunchRecord {
        magic: RECORD_MAGIC,
        bump: rb,
        creator: i.creator,
        nonce: i.nonce,
        digest: h.digest,
        mint: i.mint,
        recipient: i.recipient,
        ata: ata.to_bytes(),
        metadata: metadata.to_bytes(),
        slot: Clock::get()?.slot,
        payer: i.payer,
        intent: raw,
    };
    let packed = borsh::to_vec(&record_state).map_err(|_| Error::InvalidData)?;
    check(packed.len() <= RECORD_BYTES, Error::InvalidData)?;
    writable(&a[8])?;
    a[8].try_borrow_mut_data()?[..packed.len()].copy_from_slice(&packed);
    c.nonce = c.nonce.checked_add(1).ok_or(Error::Overflow)?;
    save(&a[1], &c, CREATOR_BYTES)?;
    solana_program::msg!("QcommitLaunch {} {} {}", a[1].key, i.nonce, mint);
    Ok(())
}
fn close(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    exact(a, 2)?;
    check(data.is_empty(), Error::InvalidData)?;
    let h = load_proof(p, &a[0])?;
    signer(&a[1])?;
    writable(&a[0])?;
    writable(&a[1])?;
    check(
        a[1].key.to_bytes() == h.uploader && a[0].key != a[1].key,
        Error::AccountMismatch,
    )?;
    let total = a[1]
        .lamports()
        .checked_add(a[0].lamports())
        .ok_or(Error::Overflow)?;
    **a[1].try_borrow_mut_lamports()? = total;
    **a[0].try_borrow_mut_lamports()? = 0;
    a[0].try_borrow_mut_data()?.fill(0);
    Ok(())
}
pub fn process_instruction(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let result = (|| -> R<()> {
        let (tag, data) = data.split_first().ok_or(Error::InvalidData)?;
        match tag {
            0 => init_config(p, a, data),
            1 => init_creator(p, a, data),
            2 => begin(p, a, data),
            3 => append(p, a, data),
            4 => seal(p, a, data),
            5 => step(p, a, data),
            6 => activate(p, a, data),
            7 => execute(p, a, data),
            8 => close(p, a, data),
            _ => Err(Error::InvalidData.into()),
        }
    })();
    result.map_err(|e| match e {
        Failure::Core(e) => ProgramError::Custom(e as u32),
        Failure::Runtime(e) => e,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_and_empty_instruction_fail_closed() {
        let p = Pubkey::new_unique();
        assert_eq!(
            process_instruction(&p, &[], &[]),
            Err(ProgramError::Custom(Error::InvalidData as u32))
        );
        assert_eq!(
            process_instruction(&p, &[], &[255]),
            Err(ProgramError::Custom(Error::InvalidData as u32))
        );
    }
    #[test]
    fn every_instruction_checks_account_count() {
        let p = Pubkey::new_unique();
        for tag in 0..=8 {
            assert_eq!(
                process_instruction(&p, &[], &[tag]),
                Err(ProgramError::Custom(Error::AccountMismatch as u32))
            );
        }
    }
    #[test]
    fn initialization_rejects_untrusted_loader_authority() {
        let p = Pubkey::new_unique();
        let key = Pubkey::new_unique();
        let owner = SYSTEM_ID;
        let mut lamports = 1;
        let mut bytes = [];
        let a = AccountInfo::new(&key, true, true, &mut lamports, &mut bytes, &owner, false);
        let accounts = vec![a; 5];
        let mut args = vec![0];
        args.extend([1; 32]);
        args.extend([2; 32]);
        assert_eq!(
            process_instruction(&p, &accounts, &args),
            Err(ProgramError::Custom(Error::UntrustedDeployment as u32))
        );
    }
    #[test]
    fn initialization_cannot_infer_signer_from_address() {
        let p = Pubkey::new_unique();
        let key = Pubkey::new_unique();
        let mut lamports = 1;
        let mut bytes = [];
        let a = AccountInfo::new(
            &key,
            false,
            true,
            &mut lamports,
            &mut bytes,
            &SYSTEM_ID,
            false,
        );
        let mut args = vec![0];
        args.extend([1; 32]);
        args.extend([2; 32]);
        assert_eq!(
            process_instruction(&p, &vec![a; 5], &args),
            Err(ProgramError::Custom(Error::MissingSigner as u32))
        );
    }
    #[test]
    fn arbitrary_account_cannot_supply_verified_proof() {
        let p = Pubkey::new_unique();
        let key = Pubkey::new_unique();
        let mut lamports = 1;
        let mut bytes = vec![0; PROOF_BYTES];
        let a = AccountInfo::new(
            &key,
            false,
            true,
            &mut lamports,
            &mut bytes,
            &SYSTEM_ID,
            false,
        );
        assert!(matches!(
            load_proof(&p, &a),
            Err(Failure::Core(Error::WrongOwner))
        ));
    }
    #[test]
    fn wrong_discriminator_and_size_fail_before_trust() {
        let p = Pubkey::new_unique();
        let key = Pubkey::new_unique();
        let mut lamports = 1;
        let mut bytes = vec![0; PROOF_BYTES - 1];
        let a = AccountInfo::new(&key, false, true, &mut lamports, &mut bytes, &p, false);
        assert!(matches!(
            load_proof(&p, &a),
            Err(Failure::Core(Error::InvalidData))
        ));
    }
    #[test]
    fn launch_cannot_switch_original_funding_wallet() {
        let p = Pubkey::new_unique();
        let creator_address = Pubkey::new_unique();
        let config = Config {
            magic: CONFIG_MAGIC,
            bump: 0,
            genesis: [1; 32],
            deployment: [2; 32],
            bootstrap_authority: [3; 32],
        };
        let creator = Creator {
            magic: CREATOR_MAGIC,
            bump: 0,
            config: [4; 32],
            id: [5; 32],
            payer: [6; 32],
            key: [7; 32],
            salt: [8; 32],
            nonce: 0,
            active: true,
        };
        let proof = Proof {
            magic: PROOF_MAGIC,
            bump: 0,
            creator: creator_address.to_bytes(),
            uploader: [9; 32],
            digest: [10; 32],
            key: creator.key,
            kind: 1,
            nonce: 0,
            expiry: 100,
            intent_len: 1,
            uploaded: 0,
            stage: 0,
            root: [0; 16],
            tree: 0,
            leaf: 0,
        };
        let intent = Intent {
            program: p.to_bytes(),
            genesis: config.genesis,
            deployment: config.deployment,
            creator: creator_address.to_bytes(),
            epoch: 0,
            nonce: 0,
            expiry: 100,
            token_program: TOKEN_ID.to_bytes(),
            mint: [11; 32],
            recipient: [12; 32],
            payer: proof.uploader,
            decimals: 6,
            supply: 1,
            max_execution_rent: 1,
            platform_fee: 0,
            max_network_fee: 1,
            name: "Test".into(),
            symbol: "TEST".into(),
            uri: "https://example.invalid/test.json".into(),
            content_hash: [13; 32],
            mint_policy: 0,
            freeze_policy: 0,
        };
        assert!(matches!(
            intent_bound(&p, &config, &creator, &creator_address, &proof, &intent),
            Err(Failure::Core(Error::IntentMismatch))
        ));
    }
    #[test]
    fn final_stage_alone_does_not_qualify_signature() {
        let mut h = Proof {
            magic: PROOF_MAGIC,
            bump: 0,
            creator: [1; 32],
            uploader: [2; 32],
            digest: [3; 32],
            key: [4; 32],
            kind: 0,
            nonce: 0,
            expiry: 100,
            intent_len: 0,
            uploaded: SIGNATURE_BYTES as u16,
            stage: 9,
            root: [0; 16],
            tree: 0,
            leaf: 0,
        };
        assert!(complete(&h).is_err());
        h.root = [4; 16];
        assert!(complete(&h).is_ok());
        h.tree = 1;
        assert!(complete(&h).is_err());
        h.tree = 0;
        h.leaf = 1;
        assert!(complete(&h).is_err());
    }
}
