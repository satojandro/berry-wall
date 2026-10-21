// Board state + chunked sync. Mirrors the contract's versioned-chunk API:
// initial load = paginated get_pixels, then poll get_chunk_versions and
// refetch only changed chunks. Pure state logic, DOM-free, unit-testable.
import type { BoardMeta, ChunkData, PixelWire, PixelsPage } from "./protocol";

export class BoardState {
  meta: BoardMeta | null = null;
  // x,y -> color
  cells = new Map<number, number>();
  // owner by cell (for tooltips/credit)
  owners = new Map<number, string>();
  chunkVersions: number[] = [];
  fullyLoaded = false;
  totalPainted = 0;

  static key(x: number, y: number): number {
    return y * 65536 + x;
  }

  applyMeta(meta: BoardMeta) {
    this.meta = meta;
  }

  applyPixels(page: PixelsPage) {
    for (const p of page.entries) this.put(p);
    this.totalPainted = page.total;
    if (page.next_from_index >= page.total) this.fullyLoaded = true;
  }

  applyChunk(chunk: ChunkData) {
    if (!chunk.changed) return;
    // clear old cells inside this chunk then repaint (handles erasures)
    const size = this.meta?.size ?? 0;
    const chunkEdge = this.meta?.chunk ?? 64;
    const chunksPerRow = Math.ceil(size / chunkEdge);
    const cx = (chunk.chunk_index % chunksPerRow) * chunkEdge;
    const cy = Math.floor(chunk.chunk_index / chunksPerRow) * chunkEdge;
    for (let y = cy; y < cy + chunkEdge && y < size; y++) {
      for (let x = cx; x < cx + chunkEdge && x < size; x++) {
        const k = BoardState.key(x, y);
        if (this.cells.has(k)) {
          this.cells.delete(k);
          this.owners.delete(k);
        }
      }
    }
    for (const p of chunk.cells) this.put(p);
    if (chunk.version > (this.chunkVersions[chunk.chunk_index] ?? 0)) {
      this.chunkVersions[chunk.chunk_index] = chunk.version;
    }
  }

  private put(p: PixelWire) {
    const k = BoardState.key(p.x, p.y);
    this.cells.set(k, p.color);
    this.owners.set(k, p.owner);
  }

  colorAt(x: number, y: number): number {
    return this.cells.get(BoardState.key(x, y)) ?? 0;
  }

  ownerAt(x: number, y: number): string | undefined {
    return this.owners.get(BoardState.key(x, y));
  }

  initChunkVersions(n: number) {
    this.chunkVersions = new Array(n).fill(0);
  }

  dirtyChunks(remote: number[]): number[] {
    const dirty: number[] = [];
    for (let i = 0; i < remote.length; i++) {
      if (remote[i] > (this.chunkVersions[i] ?? 0)) dirty.push(i);
    }
    return dirty;
  }
}
