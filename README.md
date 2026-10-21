# Berry Wall (mpoov2) — modern Berry Club on NEAR

A 2026 rebuild of [Berry Club](https://github.com/evgenykuzyakov/berryclub) (2020):
shared pixel wall where painting burns paint and every pixel you own farms yield.
Product interaction follows r/place and Sui Pixel: zoom/pan canvas, tap-to-select,
tap-again-to-place, per-account cooldown, starter paint for instant onboarding.

**Live testnet deployment:** `berrywall1.testnet` (contract account = game board)

## Status

| Piece | State |
|---|---|
| Contract (Rust, near-sdk 5.29.1) | 7/7 tests pass, WASM builds (179 KB), deployed + init'd on testnet |
| Live smoke test | 2 accounts painted, cooldown enforced on-chain, overwrite works, yield accrues, chunk versions increment |
| Frontend (Vite + TS, near-connect) | tsc clean, production build 67 KB, served at :5180, wired to testnet |
| Tokenomics (MPOO packs, staking, shop) | deliberately deferred — internal paint/points ledgers are the seam |

## Contract API

View: `get_board` `get_chunk_versions` `get_chunk(chunk_index, since_version)` `get_pixels(from_index, limit)` `get_pixel(x, y)` `get_account(account_id)`

Call: `new()` `draw({ pixels: [{x, y, color}] })` `set_farm_preference(pref)`

Rules: 256×256 wall · 16 colors · batch ≤64 px/tx · 30s cooldown per account ·
1 paint unit per placement (18dp) · 8 starter units for new accounts ·
1 paint unit/day farmed per owned pixel (paint or points) · overwrite settles
the previous owner's yield first · same-artist/same-color is a free no-op (rejected if all no-ops) ·
decimal strings for all u128/ns on the wire · NEP-297 `draw` events.

## Sync design (the Berry Club trick, upgraded)

Original Berry Club versioned each 1px-wide row so clients refetched only
changed rows. Here each 64×64 chunk carries a version: clients poll
`get_chunk_versions` (cheap, O(16)) and refetch only dirty chunks.

## Local development

```bash
# contract
cd contract && cargo test
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$HOME/.cargo/bin:$PATH"
export DYLD_LIBRARY_PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/lib"
cargo build --target wasm32-unknown-unknown --release
near deploy berrywall1.testnet target/wasm32-unknown-unknown/release/pixel_board.wasm

# web
cd web && npm install && npm run dev   # .env sets VITE_CONTRACT_ID / VITE_NEAR_NETWORK
```

## Deploy notes (learned the hard way)

- Never reuse an account that held a different contract: state serialization
  is incompatible ("Cannot deserialize the contract state") and `new()` then
  refuses ("already initialized"). Fresh account per contract generation.
- Deploy costs ~0.8 NEAR storage staking; fund ≥3 NEAR before first deploy.
- Redeploys preserve state — the cooldown constant fix shipped without
  losing painted pixels.

## Next phases (tokenomics, built separately)

MPOO-only paint packs → TOILET-style longevity rewards → staking vault →
inventory shop. The board contract's paint ledger is the integration point;
no token code ships until the economy parameters are chosen.
