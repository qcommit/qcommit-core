"""Verify-only SLH-DSA-SHA2-128s, following NIST FIPS 205.

This module handles public data only. It does not generate keys or signatures.
Algorithm numbers refer to the August 2024 final standard.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from hmac import compare_digest
from struct import pack

N = 16
H = 63
D = 7
HP = 9
A = 12
K = 14
WOTS_LEN = 35
PUBLIC_KEY_BYTES = 2 * N
FORS_BYTES = K * (A + 1) * N
XMSS_BYTES = (WOTS_LEN + HP) * N
SIGNATURE_BYTES = N + FORS_BYTES + D * XMSS_BYTES
DIGEST_BYTES = 30

WOTS_HASH = 0
WOTS_PK = 1
TREE = 2
FORS_TREE = 3
FORS_ROOTS = 4


@dataclass(frozen=True, slots=True)
class Address:
    """The SHA2 compressed address: 1 + 8 + 1 + 4 + 4 + 4 bytes."""

    layer: int = 0
    tree: int = 0
    kind: int = 0
    keypair: int = 0
    height_or_chain: int = 0
    index_or_hash: int = 0

    def encode(self) -> bytes:
        return pack(">BQBIII", self.layer, self.tree, self.kind, self.keypair,
                    self.height_or_chain, self.index_or_hash)


def base_2b(data: bytes, width: int, count: int) -> list[int]:
    """Read fixed-width integers most-significant bit first (Algorithm 4)."""
    if width < 1 or count < 0 or len(data) * 8 < width * count:
        raise ValueError("invalid base_2b input length")
    value = int.from_bytes(data, "big")
    mask = (1 << width) - 1
    return [(value >> (len(data) * 8 - width * (i + 1))) & mask
            for i in range(count)]


class SHA2:
    """Section 11.2.1: F, H and T share this parameter-set instantiation."""

    __slots__ = ("_prefix", "calls")

    def __init__(self, seed: bytes) -> None:
        if len(seed) != N:
            raise ValueError("public seed must be 16 bytes")
        self._prefix = sha256(seed + bytes(64 - N))
        self.calls = 0

    def thash(self, address: Address, value: bytes) -> bytes:
        h = self._prefix.copy()
        h.update(address.encode())
        h.update(value)
        self.calls += 1
        return h.digest()[:N]


def h_msg(randomizer: bytes, public_key: bytes, message: bytes) -> bytes:
    seed = randomizer + public_key[:N] + sha256(randomizer + public_key + message).digest()
    return (sha256(seed + pack(">I", 0)).digest()
            + sha256(seed + pack(">I", 1)).digest())[:DIGEST_BYTES]


def wots_pk_from_sig(signature: bytes, message: bytes, hashes: SHA2,
                     layer: int, tree: int, leaf: int) -> bytes:
    """Algorithm 8: finish the 35 hash chains, then compress their endpoints."""
    digits = base_2b(message, 4, 2 * N)
    checksum = sum(15 - digit for digit in digits) << 4
    digits += base_2b(checksum.to_bytes(2, "big"), 4, 3)
    endpoints = bytearray()
    for chain, digit in enumerate(digits):
        node = signature[chain * N:(chain + 1) * N]
        for step in range(digit, 15):
            node = hashes.thash(Address(layer, tree, WOTS_HASH, leaf, chain, step), node)
        endpoints.extend(node)
    return hashes.thash(Address(layer, tree, WOTS_PK, leaf), bytes(endpoints))


def xmss_pk_from_sig(signature: bytes, message: bytes, hashes: SHA2,
                     layer: int, tree: int, leaf: int) -> bytes:
    """Algorithm 11: recover a WOTS+ key and climb its Merkle authentication path."""
    node = wots_pk_from_sig(signature[:WOTS_LEN * N], message, hashes, layer, tree, leaf)
    auth = signature[WOTS_LEN * N:]
    index = leaf
    for height in range(HP):
        sibling = auth[height * N:(height + 1) * N]
        pair = sibling + node if index & 1 else node + sibling
        index >>= 1
        node = hashes.thash(Address(layer, tree, TREE, 0, height + 1, index), pair)
    return node


def fors_pk_from_sig(signature: bytes, digest: bytes, hashes: SHA2,
                     tree: int, leaf: int) -> bytes:
    """Algorithm 17: recover 14 FORS roots, preserving each tree's index offset."""
    roots = bytearray()
    for number, local_index in enumerate(base_2b(digest, A, K)):
        start = number * (A + 1) * N
        index = (number << A) + local_index
        node = hashes.thash(Address(0, tree, FORS_TREE, leaf, 0, index),
                            signature[start:start + N])
        for height in range(A):
            pos = start + (height + 1) * N
            sibling = signature[pos:pos + N]
            pair = sibling + node if index & 1 else node + sibling
            index >>= 1
            node = hashes.thash(Address(0, tree, FORS_TREE, leaf, height + 1, index), pair)
        roots.extend(node)
    return hashes.thash(Address(0, tree, FORS_ROOTS, leaf), bytes(roots))


@dataclass(frozen=True, slots=True)
class VerificationTrace:
    valid: bool
    fors_public_key: str
    layer_roots: tuple[str, ...]
    tree_index: int
    leaf_index: int
    thash_calls: int


def verify_internal(message: bytes, signature: bytes, public_key: bytes,
                    *, trace: bool = False) -> bool | VerificationTrace:
    """Algorithm 20. The raw internal interface is for ACVP tests, not applications."""
    if not all(isinstance(x, bytes) for x in (message, signature, public_key)):
        raise TypeError("message, signature and public_key must be bytes")
    if len(signature) != SIGNATURE_BYTES or len(public_key) != PUBLIC_KEY_BYTES:
        return False
    digest = h_msg(signature[:N], public_key, message)
    tree = int.from_bytes(digest[21:28], "big") & ((1 << (H - HP)) - 1)
    leaf = int.from_bytes(digest[28:30], "big") & ((1 << HP) - 1)
    initial_tree, initial_leaf = tree, leaf
    hashes = SHA2(public_key[:N])
    node = fors_pk_from_sig(signature[N:N + FORS_BYTES], digest[:21], hashes, tree, leaf)
    fors_key = node.hex()
    roots: list[str] = []
    for layer in range(D):
        start = N + FORS_BYTES + layer * XMSS_BYTES
        node = xmss_pk_from_sig(signature[start:start + XMSS_BYTES], node,
                                hashes, layer, tree, leaf)
        roots.append(node.hex())
        leaf = tree & ((1 << HP) - 1)
        tree >>= HP
    valid = compare_digest(node, public_key[N:])
    if trace:
        return VerificationTrace(valid, fors_key, tuple(roots), initial_tree,
                                 initial_leaf, hashes.calls)
    return valid


def verify(message: bytes, signature: bytes, public_key: bytes,
           context: bytes = b"", *, trace: bool = False) -> bool | VerificationTrace:
    """Pure SLH-DSA external verification with FIPS 205 context encoding."""
    if not isinstance(context, bytes):
        raise TypeError("context must be bytes")
    if len(context) > 255:
        raise ValueError("context exceeds 255 bytes")
    return verify_internal(b"\x00" + bytes([len(context)]) + context + message,
                           signature, public_key, trace=trace)
