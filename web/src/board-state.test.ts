import { describe, it, expect } from "vitest";
import { BoardState } from "./board-state";
import type { ChunkData, PixelsPage } from "./protocol";

function page(entries: PixelsPage["entries"], total = entries.length, next = total): PixelsPage {
  return { total, next_from_index: next, entries };
}

describe("BoardState", () => {
  it("applies pixels and reports colors", () => {
    const s = new BoardState();
    s.applyPixels(page([
      { x: 1, y: 2, color: 5, owner: "alice.testnet", written_at_ns: "1" },
    ]));
    expect(s.colorAt(1, 2)).toBe(5);
    expect(s.colorAt(0, 0)).toBe(0);
    expect(s.ownerAt(1, 2)).toBe("alice.testnet");
    expect(s.fullyLoaded).toBe(true);
  });

  it("tracks pagination completeness", () => {
    const s = new BoardState();
    s.applyPixels(page([{ x: 0, y: 0, color: 1, owner: "a", written_at_ns: "1" }], 2, 1));
    expect(s.fullyLoaded).toBe(false);
    s.applyPixels(page([{ x: 1, y: 0, color: 2, owner: "b", written_at_ns: "1" }], 2, 2));
    expect(s.fullyLoaded).toBe(true);
  });

  it("diffs chunk versions", () => {
    const s = new BoardState();
    s.initChunkVersions(4);
    expect(s.dirtyChunks([0, 0, 0, 0])).toEqual([]);
    expect(s.dirtyChunks([0, 1, 0, 2])).toEqual([1, 3]);
    s.applyChunk({ chunk_index: 1, version: 1, changed: true, cells: [] });
    expect(s.dirtyChunks([0, 1, 0, 2])).toEqual([3]);
  });

  it("applies chunk changes including erasures", () => {
    const s = new BoardState();
    s.applyMeta({ epoch: 0, size: 128, palette_len: 16, chunk: 64, open_wall: true, created_at_ns: "0", total_pixels_drawn: 0, total_paint_burned: "0" });
    s.initChunkVersions(4);
    // chunk 3 = cells x 64..127, y 64..127
    s.applyPixels(page([{ x: 70, y: 70, color: 9, owner: "a", written_at_ns: "1" }]));
    const chunk: ChunkData = {
      chunk_index: 3,
      version: 2,
      changed: true,
      cells: [{ x: 71, y: 71, color: 4, owner: "b", written_at_ns: "2" }],
    };
    s.applyChunk(chunk);
    expect(s.colorAt(70, 70)).toBe(0); // erased
    expect(s.colorAt(71, 71)).toBe(4);
    expect(s.chunkVersions[3]).toBe(2);
  });

  it("ignores unchanged chunks", () => {
    const s = new BoardState();
    s.applyChunk({ chunk_index: 0, version: 5, changed: false, cells: [] });
    expect(s.chunkVersions.length).toBe(0);
  });
});
