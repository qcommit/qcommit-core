// These are explicit mocked RPC mutations, not additional on-chain execution evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { verifyExecution } from "../receipt.mjs";
import { hex } from "../codec.mjs";
import { mockedReceiptChain } from "./receipt-fixture.mjs";
const local = JSON.parse(
  readFileSync(
    new URL("../tests/receipt-authorization-localnet.json", import.meta.url),
  ),
);
const mainnet = JSON.parse(
  readFileSync(
    new URL(
      "../tests/receipt-authorization-mainnet-fixture.json",
      import.meta.url,
    ),
  ),
);
const verify = (f) =>
  verifyExecution(f.network, {
    authorization: f.authorization,
    transactionSignature: f.transactionSignature,
  });
async function rejection(change, pattern) {
  const f = await mockedReceiptChain(local);
  change(f);
  await assert.rejects(verify(f), pattern);
}
test("mocked RPC reconstruction retains real localnet approval signature and independently verifies", async () => {
  const f = await mockedReceiptChain(local),
    r = await verify(f);
  assert.equal(r.signatureValid, true);
  assert.equal(r.creatorTrusted, false);
  assert.equal(r.confirmation.onchainVerified, true);
});
test("creator fingerprint trust stays separate from signature and chain validity", async () => {
  const f = await mockedReceiptChain(local),
    first = await verify(f);
  const good = await verifyExecution(f.network, {
    authorization: f.authorization,
    transactionSignature: f.transactionSignature,
    expectedCreatorFingerprint: first.creatorFingerprint,
  });
  const wrong = await verifyExecution(f.network, {
    authorization: f.authorization,
    transactionSignature: f.transactionSignature,
    expectedCreatorFingerprint: "ab".repeat(32),
  });
  assert.equal(good.creatorTrusted, true);
  assert.equal(wrong.creatorTrusted, false);
  assert.equal(wrong.signatureValid, true);
  assert.equal(wrong.confirmation.onchainVerified, true);
});
test("wrong RPC genesis rejects", () =>
  rejection((f) => {
    f.state.genesis = "11111111111111111111111111111111";
  }, /genesis/));
test("changed program bytes reject", () =>
  rejection((f) => {
    f.state.code[0] ^= 1;
  }, /binary/));
test("transaction predating the pinned program deployment rejects", () =>
  rejection((f) => {
    f.state.deploySlot = f.tx.slot;
  }, /predates/));
test("program upgrade during receipt verification rejects", () =>
  rejection((f) => {
    f.state.afterState = () => {
      f.state.deploySlot--;
    };
  }, /Deployment changed/));
test("changed upgrade authority rejects", () =>
  rejection((f) => {
    f.state.authority = "11111111111111111111111111111111";
  }, /authority/));
test("failed transaction cannot become a successful receipt", () =>
  rejection((f) => {
    f.tx.meta.err = { InstructionError: [0, "Custom"] };
  }, /failed/));
test("processed-only transaction rejects", () =>
  rejection((f) => {
    f.status.confirmationStatus = "processed";
  }, /commitment/));
test("substituted transaction mint account rejects", () =>
  rejection((f) => {
    const keys = f.tx.transaction.message.accountKeys;
    const n = keys.findIndex(
      (k) => k.toBase58() === f.authorization.intent.mint,
    );
    keys[n] = new PublicKey("11111111111111111111111111111111");
  }, /accounts/));
test("different original distribution amount rejects", () =>
  rejection((f) => {
    f.tx.meta.postTokenBalances[0].uiTokenAmount.amount = "1";
  }, /exact signed supply/));
test("a different transaction signature cannot borrow valid record evidence", () =>
  rejection((f) => {
    f.tx.transaction.signatures[0] = "2".repeat(88);
  }, /different transaction/));
test("record digest mutation rejects", () =>
  rejection((f) => {
    f.accounts.get(f.derived.record.toBase58()).data[49] ^= 1;
  }, /record/));
test("creator registration salt mutation rejects", () =>
  rejection((f) => {
    f.accounts.get(f.creator).data[137] ^= 1;
  }, /registration address/));
test("mint authority restoration rejects", () =>
  rejection((f) => {
    f.accounts.get(f.authorization.intent.mint).data[0] = 1;
  }, /authorities/));
test("immutable metadata flag change rejects", () =>
  rejection((f) => {
    const metadata = f.accounts.get(f.derived.metadata.toBase58());
    metadata.data[metadata.data.length - 1] = 1;
  }, /immutability/));
test("later transfer, burn and recipient-account closure do not falsify original distribution", async () => {
  const f = await mockedReceiptChain(local);
  f.accounts.delete(f.derived.ata.toBase58());
  f.accounts.get(f.authorization.intent.mint).data.writeBigUInt64LE(1n, 36);
  const r = await verify(f);
  assert.equal(r.confirmation.onchainVerified, true);
  assert.equal(r.confirmation.currentRecipientAccount, "closed-or-repurposed");
  assert.equal(r.confirmation.currentRecipientAmount, null);
});
test("fully synthetic mainnet-domain RPC requires finalized confirmation", async () => {
  const f = await mockedReceiptChain(mainnet, { cluster: "mainnet-beta" });
  const valid = await verify(f);
  assert.equal(valid.confirmation.commitment, "finalized");
  f.status.confirmationStatus = "confirmed";
  await assert.rejects(verify(f), /required commitment/);
});
