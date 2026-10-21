// r/place palette: 16 colors (15 placeable + blank-eraser style white base).
// Classic r/place 2022 palette.
export const PALETTE: string[] = [
  "#ffffff", // 0 white (also the empty-board look)
  "#d4d7d9", // 1 light gray
  "#898d90", // 2 dark gray
  "#000000", // 3 black
  "#ff4500", // 4 orange-red
  "#ffa800", // 5 orange
  "#ffd635", // 6 yellow
  "#fff8b8", // 7 pale yellow
  "#00a368", // 8 green
  "#00cc78", // 9 light green
  "#7eed56", // 10 mint
  "#00756f", // 11 teal
  "#00ccc0", // 12 cyan
  "#3690ea", // 13 blue
  "#51e9f4", // 14 light blue
  "#b44ac0", // 15 purple
];

export interface BoardMeta {
  epoch: number;
  size: number;
  palette_len: number;
  chunk: number;
  open_wall: boolean;
  created_at_ns: string;
  total_pixels_drawn: number;
  total_paint_burned: string;
}

export interface PixelWire {
  x: number;
  y: number;
  color: number;
  owner: string;
  written_at_ns: string;
}

export interface ChunkData {
  chunk_index: number;
  version: number;
  changed: boolean;
  cells: PixelWire[];
}

export interface PixelsPage {
  total: number;
  next_from_index: number;
  entries: PixelWire[];
}

export interface AccountView {
  account_id: string;
  paint_balance: string;
  points: string;
  pixels_owned: number;
  farm_pref: number;
  cooldown_ready_ns: string;
  can_paint: boolean;
}

export interface DrawInput {
  x: number;
  y: number;
  color: number;
}

// 18 decimals — paint unit formatting
const UNIT = 10n ** 18n;

export function formatPaint(raw: string): string {
  const v = BigInt(raw);
  const whole = v / UNIT;
  const frac = (v % UNIT) * 100n / UNIT;
  return frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(2, "0")}`;
}
