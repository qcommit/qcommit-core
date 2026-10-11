import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as c from "../codec.mjs";
import { executeLaunchInstruction } from "../instructions.mjs";
import { openNetwork, UPGRADEABLE_LOADER } from "../network.mjs";
import { base58 } from "../transport.mjs";
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const bstr = (s) => c.concat(u32(c.utf8(s).length), c.utf8(s));
export async function mockedReceiptChain(
  fixture,
  { cluster = "localnet" } = {},
) {
  const authorization = structuredClone(fixture.authorization),
    intent = authorization.intent;
  const code = Uint8Array.of(1, 2, 3),
    program = c.address(intent.program),
    payer = c.address(intent.payer);
  const [programData] = PublicKey.findProgramAddressSync(
    [program.toBytes()],
    UPGRADEABLE_LOADER,
  );
  const { config, bump: configBump } = c.deriveConfig(program),
    derived = c.deriveLaunch(
      program,
      intent.creator,
      intent.nonce,
      intent.recipient,
    ),
    { proof } = c.deriveProof(
      program,
      intent.creator,
      c.intentDigest(intent),
      payer,
    );
  const creatorSalt = c.defaultCreatorSalt(
      intent,
      payer,
      authorization.creatorPublicKey,
    ),
    creatorDerived = c.deriveCreator(
      program,
      intent.genesis,
      intent.deploymentId,
      payer,
      authorization.creatorPublicKey,
      creatorSalt,
    );
  const slot = Number(fixture.confirmation.slot),
    state = {
      genesis: intent.genesis,
      slot,
      deploySlot: slot - 1,
      authority: cluster === "mainnet-beta" ? null : intent.payer,
      code: code.slice(),
      afterState: () => {},
      programReadCount: 0,
    };
  const configuration = {
    format: "qcommit/network/1",
    cluster,
    rpc:
      cluster === "localnet"
        ? "http://127.0.0.1:18896"
        : "https://rpc.invalid.example",
    genesis: intent.genesis,
    program: intent.program,
    programSha256: c.hex(sha256(code)),
    programSize: code.length,
    upgradeAuthority: state.authority,
    deploymentId: intent.deploymentId,
  };
  const accounts = new Map();
  const owned = (data, owner = program) => ({
    executable: false,
    owner,
    data: Buffer.from(data),
    lamports: 10000000,
  });
  accounts.set(
    config.toBase58(),
    owned(
      c.concat(
        c.utf8("QCCONF01"),
        Uint8Array.of(configBump),
        c.address(intent.genesis).toBytes(),
        c.raw(intent.deploymentId),
        payer.toBytes(),
      ),
    ),
  );
  accounts.set(
    intent.creator,
    owned(
      c.concat(
        c.utf8("QCCREA01"),
        Uint8Array.of(creatorDerived.bump),
        config.toBytes(),
        creatorDerived.id,
        payer.toBytes(),
        c.raw(authorization.creatorPublicKey),
        creatorSalt,
        c.u64(c.integer(intent.nonce) + 1n),
        Uint8Array.of(1),
      ),
    ),
  );
  const intentBytes = c.encodeIntent(intent),
    recordHead = c.concat(
      c.utf8("QCLAUN01"),
      Uint8Array.of(derived.recordBump),
      c.address(intent.creator).toBytes(),
      c.u64(intent.nonce),
      c.intentDigest(intent),
      derived.mint.toBytes(),
      c.address(intent.recipient).toBytes(),
      derived.ata.toBytes(),
      derived.metadata.toBytes(),
      c.u64(slot),
      payer.toBytes(),
      u32(intentBytes.length),
      intentBytes,
    );
  accounts.set(
    derived.record.toBase58(),
    owned(
      c.concat(recordHead, new Uint8Array(c.RECORD_BYTES - recordHead.length)),
    ),
  );
  const mint = new Uint8Array(82);
  mint.set(c.u64(intent.supplyBaseUnits), 36);
  mint[44] = intent.decimals;
  mint[45] = 1;
  accounts.set(intent.mint, owned(mint, c.TOKEN_PROGRAM));
  const ata = new Uint8Array(165);
  ata.set(derived.mint.toBytes());
  ata.set(c.address(intent.recipient).toBytes(), 32);
  ata.set(c.u64(intent.supplyBaseUnits), 64);
  ata[108] = 1;
  accounts.set(derived.ata.toBase58(), owned(ata, c.TOKEN_PROGRAM));
  accounts.set(
    derived.metadata.toBase58(),
    owned(
      c.concat(
        Uint8Array.of(4),
        c.address(intent.creator).toBytes(),
        derived.mint.toBytes(),
        bstr(intent.name),
        bstr(intent.symbol),
        bstr(intent.metadataUri),
        c.u16(0),
        Uint8Array.of(0, 0, 0),
      ),
      c.METADATA_PROGRAM,
    ),
  );
  const instruction = executeLaunchInstruction(intent, proof);
  const accountKeys = [payer];
  for (const m of [...instruction.keys, { pubkey: program }])
    if (!accountKeys.some((x) => x.equals(m.pubkey)))
      accountKeys.push(m.pubkey);
  const indices = instruction.keys.map((m) =>
      accountKeys.findIndex((k) => k.equals(m.pubkey)),
    ),
    ataIndex = accountKeys.findIndex((k) => k.equals(derived.ata));
  const signature = fixture.confirmation.transactionSignature;
  const tx = {
    slot,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys,
        instructions: [
          {
            programIdIndex: accountKeys.findIndex((k) => k.equals(program)),
            accounts: indices,
            data: base58(instruction.data),
          },
        ],
      },
    },
    meta: {
      err: null,
      fee: 5000,
      postTokenBalances: [
        {
          accountIndex: ataIndex,
          mint: intent.mint,
          owner: intent.recipient,
          programId: intent.tokenProgram,
          uiTokenAmount: {
            amount: intent.supplyBaseUnits,
            decimals: intent.decimals,
          },
        },
      ],
    },
  };
  const status = {
    confirmationStatus: cluster === "mainnet-beta" ? "finalized" : "confirmed",
    err: null,
  };
  const connection = {
    rpcEndpoint: configuration.rpc,
    getGenesisHash: async () => state.genesis,
    getAccountInfo: async (id) => {
      if (id.equals(program)) {
        state.programReadCount++;
        return {
          executable: true,
          owner: UPGRADEABLE_LOADER,
          data: Buffer.from(c.concat(u32(2), programData.toBytes())),
        };
      }
      if (id.equals(programData))
        return {
          executable: false,
          owner: UPGRADEABLE_LOADER,
          data: Buffer.from(
            c.concat(
              u32(3),
              c.u64(state.deploySlot),
              Uint8Array.of(state.authority ? 1 : 0),
              state.authority
                ? c.address(state.authority).toBytes()
                : new Uint8Array(32),
              state.code,
            ),
          ),
        };
      return accounts.get(id.toBase58()) ?? null;
    },
    getSignatureStatuses: async () => ({ value: [status] }),
    getTransaction: async () => tx,
    getMultipleAccountsInfo: async (ids) => {
      const result = ids.map((id) => accounts.get(id.toBase58()) ?? null);
      state.afterState();
      return result;
    },
  };
  return {
    network: await openNetwork(configuration, connection),
    authorization,
    transactionSignature: signature,
    configuration,
    connection,
    tx,
    status,
    state,
    accounts,
    derived,
    creator: intent.creator,
  };
}
