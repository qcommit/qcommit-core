# Contributing

Keep changes narrow. Protocol changes need matching JavaScript/Python parsing and
cross-implementation tests. A receipt format or signature context change is a
versioned protocol change, not a UI refactor.

Run `npm test`, `python3 tests/native_mutations.py`, and—after installing the
pinned dependency—`npm run test:signing`. Do not merge a signing change based only
on a same-library sign/verify roundtrip. Report what was tested and what was not.
Never publish private keys, funded wallet data, fabricated benchmark numbers,
passing-audit claims or made-up deployment IDs. Fixture secrets must be ephemeral
or explicitly documented public test material.
