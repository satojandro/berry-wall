// App shell: boots the board, wires interaction, sync loop, wallet + draw.
import "./style.css";
import { Buffer } from "buffer";
// @near-js borsh-serializes transactions with Node's Buffer API.
const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) {
  g.Buffer = Buffer;
}
import { PALETTE, formatPaint } from "./protocol";
import type { DrawInput } from "./protocol";
import { BoardState } from "./board-state";
import { BoardClient, type ViewCaller } from "./board-client";
import { BoardRenderer } from "./renderer";
import { connectWallet, disconnectWallet } from "./wallet";
import { signAndSendTransaction } from "./sign";

const CONTRACT_ID: string = import.meta.env.VITE_CONTRACT_ID ?? "";
const NETWORK: "mainnet" | "testnet" = (import.meta.env.VITE_NEAR_NETWORK as "mainnet" | "testnet") ?? "testnet";
const RPC_URL: string | undefined = import.meta.env.VITE_RPC_URL;

// ---- DOM ----
const canvas = document.getElementById("board") as HTMLCanvasElement;
const paletteEl = document.getElementById("palette")!;
const statusEl = document.getElementById("status")!;
const acctEl = document.getElementById("account")!;
const loginBtn = document.getElementById("login") as HTMLButtonElement;
const zoomIn = document.getElementById("zoom-in") as HTMLButtonElement;
const zoomOut = document.getElementById("zoom-out") as HTMLButtonElement;
const fitBtn = document.getElementById("fit") as HTMLButtonElement;

const state = new BoardState();
const renderer = new BoardRenderer(canvas);
let selectedColor = 3;
let selectedCell: { x: number; y: number } | null = null;
let account: string | null = null;
const pending = new Map<number, number>(); // key -> color awaiting confirmation
let syncing = false;

// ---- RPC caller ----
async function makeCaller(): Promise<ViewCaller> {
  const { JsonRpcProvider } = await import("@near-js/providers");
  const provider = new JsonRpcProvider({ url: RPC_URL ?? `https://test.rpc.fastnear.com` });
  return {
    async view({ methodName, args }) {
      const res = (await provider.query({
        request_type: "call_function",
        account_id: CONTRACT_ID,
        method_name: methodName,
        args_base64: btoa(JSON.stringify(args)),
        finality: "optimistic",
      })) as unknown as { result: number[] };
      return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
    },
  };
}

let client: BoardClient | null = null;

async function boot() {
  setStatus(CONTRACT_ID ? "connecting…" : "demo mode (no contract configured)");
  if (CONTRACT_ID) {
    client = new BoardClient(CONTRACT_ID, await makeCaller());
    // RPC failures (rate limits, network) must not brick the page at "connecting…".
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const meta = await client.getBoard();
        state.applyMeta(meta);
        state.initChunkVersions(Math.ceil(meta.size / meta.chunk) ** 2);
        break;
      } catch (e) {
        if (attempt === 5) {
          setStatus(`RPC error: ${String(e).slice(0, 60)} — retrying in background`);
          void demoFallback();
          return;
        }
        setStatus(`connecting… retry ${attempt}/5`);
        await sleep(2000 * attempt);
      }
    }
    await fullLoad();
    void syncLoop();
  } else {
    await demoFallback();
  }
  renderer.fitView(state.meta!.size);
  buildPalette();
  setStatus(CONTRACT_ID ? "live" : "demo mode (paint not persisted)");
}

async function demoFallback() {
  // Demo mode: checkerboard so interaction can be tested without RPC.
  state.applyMeta({ epoch: 0, size: 64, palette_len: 16, chunk: 64, open_wall: true, created_at_ns: "0", total_pixels_drawn: 0, total_paint_burned: "0" });
  state.initChunkVersions(1);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 40; x++) {
    if ((x + y) % 3 === 0) state.cells.set(BoardState.key(x, y), (x * 7 + y * 13) % 16);
  }
}

async function fullLoad() {
  if (!client) return;
  let from = 0;
  for (;;) {
    const page = await client.getPixels(from, 512);
    state.applyPixels(page);
    if (page.next_from_index >= page.total) break;
    from = page.next_from_index;
  }
  renderer.requestRender();
}

// Incremental sync: poll chunk versions, refetch only dirty chunks.
async function syncLoop() {
  for (;;) {
    await sleep(4000);
    if (document.hidden || !client || syncing) continue;
    syncing = true;
    try {
      const remote = await client.getChunkVersions();
      const dirty = state.dirtyChunks(remote);
      for (const i of dirty) {
        const chunk = await client.getChunk(i, state.chunkVersions[i] ?? 0);
        state.applyChunk(chunk);
      }
      if (dirty.length) renderer.requestRender();
      for (const [k, _c] of pending) {
        void _c;
        const x = k >> 16, y = k & 0xffff;
        if (state.cells.has(k)) {
          pending.delete(k);
          setStatus(`pixel (${x}, ${y}) confirmed`);
        }
      }
    } catch (e) {
      setStatus(`sync retrying: ${String(e).slice(0, 80)}`);
    } finally {
      syncing = false;
    }
  }
}

// ---- palette ----
function buildPalette() {
  PALETTE.forEach((hex, i) => {
    if (i === 0) return; // white = empty board look, keep placeable anyway
    const b = document.createElement("button");
    b.className = "swatch" + (i === selectedColor ? " active" : "");
    b.style.background = hex;
    b.setAttribute("aria-label", `color ${i}`);
    b.addEventListener("click", () => {
      selectedColor = i;
      paletteEl.querySelectorAll(".swatch").forEach((el) => el.classList.remove("active"));
      b.classList.add("active");
      renderer.requestRender();
    });
    paletteEl.appendChild(b);
  });
}

// ---- interaction: tap select, second tap confirm; drag pans; wheel zooms ----
let dragging = false;
let dragMoved = false;
let last: { x: number; y: number } | null = null;

canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  dragMoved = false;
  last = { x: e.offsetX, y: e.offsetY };
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging || !last) return;
  const dx = e.offsetX - last.x;
  const dy = e.offsetY - last.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
  renderer.pan(dx / renderer.camera.scale, dy / renderer.camera.scale, state.meta!.size);
  last = { x: e.offsetX, y: e.offsetY };
});
canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  last = null;
  if (dragMoved) return;
  const cell = renderer.hitTest(e.offsetX, e.offsetY, state.meta!.size);
  if (!cell) return;
  if (
    selectedCell &&
    selectedCell.x === cell.x &&
    selectedCell.y === cell.y
  ) {
    void placePixel(cell);
  } else {
    selectedCell = cell;
    const owner = state.ownerAt(cell.x, cell.y);
    setStatus(
      `selected (${cell.x}, ${cell.y})${owner ? ` by ${owner}` : " — empty"} — tap again or press Paint`,
    );
    updatePaintButton();
    renderer.requestRender();
  }
});

// Explicit Paint button — tap-select then Paint (same as double-tap).
const paintBtn = document.createElement("button");
paintBtn.id = "paint-btn";
paintBtn.textContent = "Paint";
paintBtn.style.marginLeft = "auto";
paintBtn.disabled = true;
paintBtn.addEventListener("click", () => {
  if (selectedCell) void placePixel(selectedCell);
});
document.getElementById("palette")!.appendChild(paintBtn);

function updatePaintButton() {
  paintBtn.disabled = !selectedCell || !account;
  paintBtn.title = account ? "Paint the selected cell" : "Sign in to paint";
}
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    renderer.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.2 : 1 / 1.2, state.meta!.size);
  },
  { passive: false },
);
// pinch zoom
let pinchDist = 0;
canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    pinchDist = touchDist(e);
  }
}, { passive: true });
canvas.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2) {
    const d = touchDist(e);
    if (pinchDist) renderer.zoomAt(e.touches[0].clientX, e.touches[0].clientY, d / pinchDist, state.meta!.size);
    pinchDist = d;
  }
}, { passive: true });
canvas.addEventListener("touchend", () => { pinchDist = 0; });

function touchDist(e: TouchEvent): number {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.hypot(dx, dy);
}

zoomIn.addEventListener("click", () => renderer.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.3, state.meta!.size));
zoomOut.addEventListener("click", () => renderer.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.3, state.meta!.size));
fitBtn.addEventListener("click", () => renderer.fitView(state.meta!.size));

// ---- painting ----
async function placePixel(cell: { x: number; y: number }) {
  if (!CONTRACT_ID) {
    setStatus("demo mode: connect a contract to paint for real");
    return;
  }
  if (!account) {
    setStatus("sign in to paint");
    return;
  }
  const k = BoardState.key(cell.x, cell.y);
  pending.set(k, selectedColor);
  renderer.requestRender();
  setStatus("submitting…");
  try {
    const draw: DrawInput[] = [{ x: cell.x, y: cell.y, color: selectedColor }];
    const args = client!.drawArgs(draw);
    const { actionCreators } = await import("@near-js/transactions");
    const action = actionCreators.functionCall("draw", args, 300_000_000_000_000n, 0n);
    setStatus("waiting for signature…");
    await signAndSendTransaction({ receiverId: CONTRACT_ID, actions: [action] });
    setStatus(`painting (${cell.x}, ${cell.y})…`);
  } catch (e) {
    pending.delete(k);
    renderer.requestRender();
    setStatus(`failed: ${String(e).slice(0, 100)}`);
  }
}

// ---- wallet ----
loginBtn.addEventListener("click", async () => {
  if (account) {
    await disconnectWallet();
    account = null;
    loginBtn.textContent = "Sign in";
    acctEl.textContent = "";
    return;
  }
  try {
    account = await connectWallet(NETWORK);
    loginBtn.textContent = "Sign out";
    updatePaintButton();
    if (client && account) {
      const v = await client.getAccount(account);
      acctEl.textContent = `paint: ${formatPaint(v.paint_balance)} · pixels: ${v.pixels_owned}`;
    }
  } catch (e) {
    setStatus(`login failed: ${String(e).slice(0, 80)}`);
  }
});

// ---- render pump ----
function draw() {
  renderer.render((x, y) => state.colorAt(x, y), state.meta?.size ?? 64, PALETTE, pending);
  if (selectedCell) renderer.drawSelection(selectedCell.x, selectedCell.y, "#ff4500");
  requestAnimationFrame(() => {
    // only re-render on demand, not continuously
  });
}
renderer.onRender = () => draw();
new ResizeObserver(() => draw()).observe(canvas);

function setStatus(s: string) {
  statusEl.textContent = s;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

void boot();
