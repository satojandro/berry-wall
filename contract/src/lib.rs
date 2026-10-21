// Modern Berry Club — shared pixel wall on NEAR.
//
// Original Berry Club mechanics kept, upgraded to 2026 standards:
//   * paint pixels at a cost (paid from an internal paint ledger)
//   * every owned pixel farms yield per day — choose paint OR points
//   * overwriting settles the overwritten account's accrued yield
//   * versioned 64px chunks: clients refetch only changed chunks (the
//     original's per-row version trick, upgraded)
// Modernized: near-sdk 5, decimal-string timestamps/amounts on the wire,
// batch draw, per-account cooldown, starter paint, pagination,
// NEP-297 events, board epoch for future seasons.
//
// Wire rule: all u128 amounts and ns timestamps are decimal STRINGS in JSON.
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap, Vector};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

const BOARD_SIZE: u16 = 256; // 256x256 = 65,536 cells (fixture; clients read metadata)
const PALETTE_LEN: u8 = 16;
const CHUNK: u16 = 64;
const CHUNKS_PER_ROW: u16 = BOARD_SIZE / CHUNK;
const NUM_CHUNKS: u64 = (CHUNKS_PER_ROW as u64) * (CHUNKS_PER_ROW as u64);
const MAX_BATCH: u32 = 64;

const NS_PER_DAY: u128 = 86_400_000_000_000;

/// Yield: 1 paint unit per owned pixel per day, farmed as paint or points.
const YIELD_PER_PIXEL_PER_DAY: u128 = 1_000_000_000_000_000_000; // 18dp

/// New accounts start with enough paint to place a few art strokes.
const STARTER_PAINT: u128 = 8_000_000_000_000_000_000; // 8 paint units (18dp)

/// Paint cost per placement (base price; pressure pricing is a later phase).
const PAINT_COST: u128 = 1_000_000_000_000_000_000; // 1 paint unit (18dp)

/// Cooldown between successful paint transactions (r/place core tension).
const COOLDOWN_NS: u64 = 30_000_000_000; // 30s

pub type Balance = u128;

#[derive(BorshDeserialize, BorshSerialize)]
pub struct Pixel {
    pub color: u8,          // palette index 0..15
    pub owner: u32,         // index into account_by_index
    pub written_at_ns: u64, // block timestamp of last successful write
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct Account {
    pub balance: Balance,   // paint units, 18dp
    pub points: Balance,    // farming points, 18dp
    pub last_touch_ns: u64, // last yield settlement
    pub last_paint_ns: u64, // cooldown clock
    pub pixel_count: u64,   // currently owned pixels
    pub farm_pref: u8,      // 0 = paint, 1 = points
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub board_epoch: u64,
    pub created_at_ns: u64,
    /// chunk_index -> version (increments on any pixel change inside)
    pub chunk_versions: Vector<u64>,
    /// row-major cell index -> Pixel
    pub pixels: UnorderedMap<u32, Pixel>,
    /// account_id -> Account
    pub accounts: LookupMap<AccountId, Account>,
    /// account_id -> numeric index
    pub account_index: LookupMap<AccountId, u32>,
    /// numeric index -> account_id
    pub account_by_index: Vector<AccountId>,
    pub total_paint_burned: Balance,
    pub total_pixels_drawn: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        let mut this = Self {
            owner_id: env::predecessor_account_id(),
            board_epoch: 0,
            created_at_ns: env::block_timestamp(),
            chunk_versions: Vector::new(StorageKey::ChunkVersions),
            pixels: UnorderedMap::new(StorageKey::Pixels),
            accounts: LookupMap::new(StorageKey::Accounts),
            account_index: LookupMap::new(StorageKey::AccountIndex),
            account_by_index: Vector::new(StorageKey::AccountByIndex),
            total_paint_burned: 0,
            total_pixels_drawn: 0,
        };
        for _ in 0..NUM_CHUNKS {
            this.chunk_versions.push(&0);
        }
        this
    }

    // ---------- views ----------

    /// Board metadata. Clients must read dimensions/palette from here.
    pub fn get_board(&self) -> BoardInfo {
        BoardInfo {
            epoch: self.board_epoch,
            size: BOARD_SIZE,
            palette_len: PALETTE_LEN,
            chunk: CHUNK,
            open_wall: true,
            created_at_ns: self.created_at_ns.to_string(),
            total_pixels_drawn: self.total_pixels_drawn,
            total_paint_burned: U128(self.total_paint_burned),
        }
    }

    /// Current chunk versions — clients diff and refetch only changed chunks.
    pub fn get_chunk_versions(&self) -> Vec<u64> {
        self.chunk_versions.to_vec()
    }

    /// All pixels in one 64x64 chunk, or empty when unchanged since `since_version`.
    pub fn get_chunk(&self, chunk_index: u64, since_version: u64) -> ChunkData {
        require!(chunk_index < NUM_CHUNKS, "chunk out of range");
        let current = self.chunk_versions.get(chunk_index).unwrap_or(0);
        let changed = current > since_version;
        let mut cells = Vec::new();
        if changed {
            let cx = ((chunk_index % CHUNKS_PER_ROW as u64) * CHUNK as u64) as u16;
            let cy = ((chunk_index / CHUNKS_PER_ROW as u64) * CHUNK as u64) as u16;
            for y in cy..cy + CHUNK {
                for x in cx..cx + CHUNK {
                    let idx = cell_index(x, y);
                    if let Some(p) = self.pixels.get(&idx) {
                        cells.push(PixelWire {
                            x,
                            y,
                            color: p.color,
                            owner: self.owner_id_of(p.owner),
                            written_at_ns: p.written_at_ns.to_string(),
                        });
                    }
                }
            }
        }
        ChunkData {
            chunk_index,
            version: current,
            changed,
            cells,
        }
    }

    /// Paginated painted-cell read for initial full load.
    pub fn get_pixels(&self, from_index: u32, limit: u32) -> PixelsPage {
        require!(limit > 0 && limit <= 512, "limit 1..=512");
        let keys = self.pixels.keys_as_vector();
        let total = keys.len() as u32;
        let mut entries = Vec::new();
        let mut i = from_index;
        while (i < total) && (entries.len() as u32) < limit {
            let idx = keys.get(i as u64).unwrap();
            if let Some(p) = self.pixels.get(&idx) {
                let (x, y) = cell_xy(idx);
                entries.push(PixelWire {
                    x,
                    y,
                    color: p.color,
                    owner: self.owner_id_of(p.owner),
                    written_at_ns: p.written_at_ns.to_string(),
                });
            }
            i += 1;
        }
        PixelsPage {
            total,
            next_from_index: i,
            entries,
        }
    }

    pub fn get_pixel(&self, x: u16, y: u16) -> Option<PixelWire> {
        require!(x < BOARD_SIZE && y < BOARD_SIZE, "out of bounds");
        self.pixels.get(&cell_index(x, y)).map(|p| PixelWire {
            x,
            y,
            color: p.color,
            owner: self.owner_id_of(p.owner),
            written_at_ns: p.written_at_ns.to_string(),
        })
    }

    // ---------- account / farming ----------

    /// Account state with lazily accrued yield included (view math only).
    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        match self.accounts.get(&account_id) {
            None => AccountView {
                account_id,
                paint_balance: U128(0),
                points: U128(0),
                pixels_owned: 0,
                farm_pref: 0,
                cooldown_ready_ns: "0".to_string(),
                can_paint: true,
            },
            Some(a) => {
                let now = env::block_timestamp();
                let accrued = pending_yield(&a, now);
                AccountView {
                    account_id,
                    paint_balance: U128(a.balance + split(&a, accrued, 0)),
                    points: U128(a.points + split(&a, accrued, 1)),
                    pixels_owned: a.pixel_count,
                    farm_pref: a.farm_pref,
                    cooldown_ready_ns: a.last_paint_ns.saturating_add(COOLDOWN_NS).to_string(),
                    can_paint: now >= a.last_paint_ns.saturating_add(COOLDOWN_NS),
                }
            }
        }
    }

    /// Where farming yield goes: 0 = paint, 1 = points. Settles first.
    pub fn set_farm_preference(&mut self, pref: u8) {
        require!(pref <= 1, "pref must be 0 (paint) or 1 (points)");
        let caller = env::predecessor_account_id();
        let mut a = self.ensure_account(&caller);
        settle_yield(&mut a, env::block_timestamp());
        a.farm_pref = pref;
        self.accounts.insert(&caller, &a);
    }

    // ---------- gameplay ----------

    /// Draw 1..=64 pixels in one transaction. Each placement costs
    /// PAINT_COST; overwrites settle the overwritten owner's yield first.
    /// Same-artist + same-color placements are skipped without charge.
    pub fn draw(&mut self, pixels: Vec<DrawInput>) {
        let artist = env::predecessor_account_id();
        let now = env::block_timestamp();
        require!(!pixels.is_empty(), "empty draw");
        require!(
            (pixels.len() as u32) <= MAX_BATCH,
            "max MAX_BATCH pixels per tx"
        );

        let mut account = self.ensure_account(&artist);
        settle_yield(&mut account, now);
        require!(
            now >= account.last_paint_ns.saturating_add(COOLDOWN_NS),
            "cooldown active"
        );

        let my_index = self.index_of(&artist);
        let mut charged: Balance = 0;
        let mut owned_delta: i64 = 0;
        let mut touched_chunks: Vec<u64> = Vec::new();

        for p in pixels.iter() {
            require!(p.x < BOARD_SIZE && p.y < BOARD_SIZE, "out of bounds");
            require!((p.color as u32) < PALETTE_LEN as u32, "bad color");
            let idx = cell_index(p.x, p.y);
            let prev = self.pixels.get(&idx);
            if let Some(prev) = &prev {
                if prev.owner == my_index && prev.color == p.color {
                    continue; // no-op: same artist, same color
                }
                if prev.owner != my_index {
                    // settle + decrement the overwritten owner
                    let prev_owner = self.owner_id_of(prev.owner);
                    let mut acc = self.ensure_account(&prev_owner);
                    settle_yield(&mut acc, now);
                    acc.pixel_count = acc.pixel_count.saturating_sub(1);
                    self.accounts.insert(&prev_owner, &acc);
                    owned_delta += 1;
                }
            } else {
                owned_delta += 1;
            }
            charged += PAINT_COST;
            self.pixels.insert(
                &idx,
                &Pixel {
                    color: p.color,
                    owner: my_index,
                    written_at_ns: now,
                },
            );
            let chunk = chunk_of(p.x, p.y);
            if !touched_chunks.contains(&chunk) {
                touched_chunks.push(chunk);
            }
        }

        require!(charged > 0, "all pixels were no-ops");
        require!(account.balance >= charged, "not enough paint");
        account.balance -= charged;
        account.pixel_count = (account.pixel_count as i64 + owned_delta) as u64;
        account.last_paint_ns = now;
        self.total_paint_burned += charged;
        self.total_pixels_drawn += pixels.len() as u64;
        self.accounts.insert(&artist, &account);

        for c in touched_chunks {
            let v = self.chunk_versions.get(c).unwrap_or(0);
            self.chunk_versions.replace(c, &(v + 1));
        }

        env::log_str(
            &json!({
                "standard": "mpoov2-pixel",
                "version": "1.0.0",
                "event": "draw",
                "data": [{
                    "artist": artist,
                    "count": pixels.len(),
                    "charged": charged.to_string(),
                    "timestamp_ns": now.to_string(),
                }]
            })
            .to_string(),
        );
    }

    // ---------- internals ----------

    fn ensure_account(&mut self, id: &AccountId) -> Account {
        if let Some(a) = self.accounts.get(id) {
            return a;
        }
        let a = Account {
            balance: STARTER_PAINT,
            points: 0,
            last_touch_ns: env::block_timestamp(),
            last_paint_ns: env::block_timestamp().saturating_sub(COOLDOWN_NS),
            pixel_count: 0,
            farm_pref: 0,
        };
        let idx = self.account_by_index.len() as u32;
        self.account_by_index.push(id);
        self.account_index.insert(id, &idx);
        self.accounts.insert(id, &a);
        a
    }

    fn index_of(&self, id: &AccountId) -> u32 {
        self.account_index
            .get(id)
            .expect("account registered via ensure_account")
    }

    fn owner_id_of(&self, idx: u32) -> AccountId {
        self.account_by_index
            .get(idx as u64)
            .expect("owner index out of range")
    }
}

fn cell_index(x: u16, y: u16) -> u32 {
    (y as u32) * (BOARD_SIZE as u32) + (x as u32)
}

fn cell_xy(idx: u32) -> (u16, u16) {
    ((idx % BOARD_SIZE as u32) as u16, (idx / BOARD_SIZE as u32) as u16)
}

fn chunk_of(x: u16, y: u16) -> u64 {
    ((y / CHUNK) as u64) * (CHUNKS_PER_ROW as u64) + ((x / CHUNK) as u64)
}

fn pending_yield(a: &Account, now: u64) -> u128 {
    let elapsed = now.saturating_sub(a.last_touch_ns) as u128;
    (a.pixel_count as u128) * YIELD_PER_PIXEL_PER_DAY * elapsed / NS_PER_DAY
}

fn split(a: &Account, accrued: u128, pref: u8) -> u128 {
    if a.farm_pref == pref { accrued } else { 0 }
}

fn settle_yield(a: &mut Account, now: u64) {
    let accrued = pending_yield(a, now);
    if a.farm_pref == 0 {
        a.balance += accrued;
    } else {
        a.points += accrued;
    }
    a.last_touch_ns = now;
}

#[near(serializers = [json])]
pub struct BoardInfo {
    pub epoch: u64,
    pub size: u16,
    pub palette_len: u8,
    pub chunk: u16,
    pub open_wall: bool,
    pub created_at_ns: String,
    pub total_pixels_drawn: u64,
    pub total_paint_burned: U128,
}

#[near(serializers = [json])]
pub struct PixelWire {
    pub x: u16,
    pub y: u16,
    pub color: u8,
    pub owner: AccountId,
    pub written_at_ns: String,
}

#[near(serializers = [json])]
pub struct ChunkData {
    pub chunk_index: u64,
    pub version: u64,
    pub changed: bool,
    pub cells: Vec<PixelWire>,
}

#[near(serializers = [json])]
pub struct PixelsPage {
    pub total: u32,
    pub next_from_index: u32,
    pub entries: Vec<PixelWire>,
}

#[near(serializers = [json])]
pub struct DrawInput {
    pub x: u16,
    pub y: u16,
    pub color: u8,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub account_id: AccountId,
    pub paint_balance: U128,
    pub points: U128,
    pub pixels_owned: u64,
    pub farm_pref: u8,
    pub cooldown_ready_ns: String,
    pub can_paint: bool,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    ChunkVersions,
    Pixels,
    Accounts,
    AccountIndex,
    AccountByIndex,
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    fn ctx(predecessor: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(predecessor.clone())
            .current_account_id(accounts(0))
            .block_timestamp(1_760_000_000_000_000_000u64); // realistic ns epoch time
        b
    }

    const UNIT: u128 = 1_000_000_000_000_000_000; // 1 paint unit, 18dp

    #[test]
    fn starter_paint_and_draw() {
        let mut c = Contract::new();
        let alice = accounts(1);
        testing_env!(ctx(alice.clone()).attached_deposit(NearToken::from_yoctonear(0)).build());
        c.draw(vec![
            DrawInput { x: 0, y: 0, color: 3 },
            DrawInput { x: 1, y: 0, color: 4 },
        ]);
        let p = c.get_pixel(0, 0).unwrap();
        assert_eq!(p.owner, alice.clone());
        assert_eq!(p.color, 3);
        let a = c.get_account(alice.clone());
        // 8 starter units - 2 spent
        assert_eq!(a.paint_balance.0, 8 * UNIT - 2 * UNIT);
        assert_eq!(a.pixels_owned, 2);
    }

    #[test]
    fn cooldown_blocks_second_draw() {
        let mut c = Contract::new();
        let alice = accounts(1);
        testing_env!(ctx(alice.clone()).build());
        c.draw(vec![DrawInput { x: 0, y: 0, color: 1 }]);
        testing_env!(ctx(alice.clone()).block_timestamp(1_760_000_000_000_000_000 + 10_000_000_000).build());
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.draw(vec![DrawInput { x: 1, y: 1, color: 1 }]);
        }));
        assert!(res.is_err());
    }

    #[test]
    fn overwrite_settles_previous_owner() {
        let mut c = Contract::new();
        let alice = accounts(1);
        let bob = accounts(2);
        testing_env!(ctx(alice.clone()).build());
        c.draw(vec![DrawInput { x: 5, y: 5, color: 1 }]);
        // advance exactly 1 day: alice farms 1 unit from her 1 pixel
        testing_env!(ctx(bob.clone()).block_timestamp(1_760_000_000_000_000_000 + NS_PER_DAY as u64).build());
        c.draw(vec![DrawInput { x: 5, y: 5, color: 2 }]);
        testing_env!(ctx(alice.clone()).build());
        let a = c.get_account(alice.clone());
        // starter 8 - 1 (draw) + 1 farmed unit = 8
        assert_eq!(a.paint_balance.0, 8 * UNIT);
        assert_eq!(a.pixels_owned, 0);
        let bob_view = c.get_account(bob.clone());
        assert_eq!(bob_view.pixels_owned, 1);
        assert_eq!(bob_view.paint_balance.0, 8 * UNIT - UNIT);
    }

    #[test]
    fn chunk_versions_track_changes() {
        let mut c = Contract::new();
        let alice = accounts(1);
        testing_env!(ctx(alice.clone()).build());
        assert_eq!(c.get_chunk_versions(), vec![0; NUM_CHUNKS as usize]);
        // cell (70, 70) lives in chunk (1,1) = index 5
        c.draw(vec![DrawInput { x: 70, y: 70, color: 9 }]);
        let versions = c.get_chunk_versions();
        assert_eq!(versions[5], 1);
        let chunk = c.get_chunk(5, 0);
        assert!(chunk.changed);
        assert_eq!(chunk.cells.len(), 1);
        assert_eq!(chunk.cells[0].x, 70);
        // unchanged since v1
        let chunk2 = c.get_chunk(5, 1);
        assert!(!chunk2.changed);
        // other chunk untouched
        assert!(!c.get_chunk(0, 0).changed);
    }

    #[test]
    fn points_farming_preference() {
        let mut c = Contract::new();
        let alice = accounts(1);
        testing_env!(ctx(alice.clone()).build());
        c.set_farm_preference(1);
        c.draw(vec![DrawInput { x: 0, y: 0, color: 1 }]);
        testing_env!(ctx(alice.clone()).block_timestamp(1_760_000_000_000_000_000 + NS_PER_DAY as u64).build());
        let a = c.get_account(alice.clone());
        // pref = points: 1 day of yield went to points, not paint
        assert_eq!(a.points.0, UNIT);
        assert_eq!(a.paint_balance.0, 8 * UNIT - UNIT);
    }

    #[test]
    fn same_artist_same_color_is_noop() {
        let mut c = Contract::new();
        let alice = accounts(1);
        testing_env!(ctx(alice.clone()).build());
        c.draw(vec![DrawInput { x: 2, y: 2, color: 1 }]);
        testing_env!(ctx(alice.clone()).block_timestamp(1_760_000_000_000_000_000 + 60_000_000_000).build());
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.draw(vec![DrawInput { x: 2, y: 2, color: 1 }]);
        }));
        // all no-ops → reject without spending paint or resetting cooldown
        assert!(res.is_err());
        let a = c.get_account(alice.clone());
        // 8 - 1 spent, plus 60s of farming on 1 pixel (1 unit/day rate)
        let expected = 8 * UNIT - UNIT + UNIT * 60_000_000_000u128 / NS_PER_DAY;
        assert_eq!(a.paint_balance.0, expected);
    }

    #[test]
    fn out_of_bounds_and_bad_color_rejected() {
        let mut c = Contract::new();
        let alice = accounts(1);
        testing_env!(ctx(alice.clone()).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.draw(vec![DrawInput { x: BOARD_SIZE, y: 0, color: 1 }]);
        }))
        .is_err());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.draw(vec![DrawInput { x: 0, y: 0, color: PALETTE_LEN }]);
        }))
        .is_err());
    }
}
