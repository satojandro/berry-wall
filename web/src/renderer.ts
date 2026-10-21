// Canvas renderer with r/place-style zoom/pan. Pure math + canvas draw;
// hit-testing shares the same camera transform so taps land exactly.
export interface Camera {
  // board-space (cell) coords of the viewport's top-left, in cell units
  cx: number;
  cy: number;
  // screen pixels per cell
  scale: number;
}

export class BoardRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  camera: Camera = { cx: 0, cy: 0, scale: 12 };
  onRender?: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
  }

  fitView(size: number) {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth * dpr;
    const h = this.canvas.clientHeight * dpr;
    this.camera.scale = Math.min(w, h) / size;
    this.camera.cx = 0;
    this.camera.cy = 0;
    this.render(() => ({}) as never, size, [] as string[], new Map());
  }

  // screen -> board cell
  hitTest(px: number, py: number, size: number): { x: number; y: number } | null {
    const dpr = window.devicePixelRatio || 1;
    const bx = this.camera.cx + px * dpr / this.camera.scale;
    const by = this.camera.cy + py * dpr / this.camera.scale;
    if (bx < 0 || by < 0 || bx >= size || by >= size) return null;
    return { x: Math.floor(bx), y: Math.floor(by) };
  }

  pan(dxCells: number, dyCells: number, size: number) {
    const viewCells = this.canvas.clientWidth / this.camera.scale;
    const viewCellsY = this.canvas.clientHeight / this.camera.scale;
    this.camera.cx = clamp(this.camera.cx - dxCells, 0, Math.max(0, size - viewCells));
    this.camera.cy = clamp(this.camera.cy - dyCells, 0, Math.max(0, size - viewCellsY));
    this.requestRender();
  }

  zoomAt(px: number, py: number, factor: number, size: number) {
    const dpr = window.devicePixelRatio || 1;
    const beforeX = this.camera.cx + px * dpr / this.camera.scale;
    const beforeY = this.camera.cy + py * dpr / this.camera.scale;
    this.camera.scale = clamp(this.camera.scale * factor, 4, 80);
    const afterX = this.camera.cx + px * dpr / this.camera.scale;
    const afterY = this.camera.cy + py * dpr / this.camera.scale;
    this.camera.cx = clamp(this.camera.cx + (beforeX - afterX), 0, Math.max(0, size - this.canvas.clientWidth / this.camera.scale));
    this.camera.cy = clamp(this.camera.cy + (beforeY - afterY), 0, Math.max(0, size - this.canvas.clientHeight / this.camera.scale));
    this.requestRender();
  }

  requestRender() {
    this.onRender?.();
  }

  render(
    colorAt: (x: number, y: number) => number,
    size: number,
    palette: string[],
    pending: Map<number, number>,
  ) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.ctx;
    const s = this.camera.scale * dpr;
    const x0 = Math.max(0, Math.floor(this.camera.cx));
    const y0 = Math.max(0, Math.floor(this.camera.cy));
    const x1 = Math.min(size, Math.ceil(this.camera.cx + w / s + 1));
    const y1 = Math.min(size, Math.ceil(this.camera.cy + h / s + 1));
    // Dark page background outside the board so edges are always visible.
    ctx.fillStyle = "#0e0f13";
    ctx.fillRect(0, 0, w, h);
    // Board surface (white) drawn as an explicit rectangle = visible edges.
    const boardPx = size * s;
    const boardX = -this.camera.cx * s;
    const boardY = -this.camera.cy * s;
    ctx.fillStyle = palette[0];
    ctx.fillRect(boardX, boardY, boardPx, boardPx);
    // Subtle chunk grid (64-cell chunks) so orientation is never lost.
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 1;
    const chunkCells = 64;
    for (let gx = 0; gx <= size; gx += chunkCells) {
      const px = Math.floor(boardX + gx * s) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, boardY);
      ctx.lineTo(px, boardY + boardPx);
      ctx.stroke();
      const py = Math.floor(boardY + gx * s) + 0.5;
      ctx.beginPath();
      ctx.moveTo(boardX, py);
      ctx.lineTo(boardX + boardPx, py);
      ctx.stroke();
    }
    // Fine cell grid only when zoomed in enough to be useful.
    if (s >= 14) {
      ctx.strokeStyle = "rgba(0,0,0,0.05)";
      for (let gx = x0; gx <= x1; gx++) {
        const px = Math.floor(boardX + (gx - this.camera.cx) * s) + 0.5;
        if (px < boardX || px > boardX + boardPx) continue;
        ctx.beginPath();
        ctx.moveTo(px, Math.max(boardY, 0));
        ctx.lineTo(px, Math.min(boardY + boardPx, h));
        ctx.stroke();
      }
      for (let gy = y0; gy <= y1; gy++) {
        const py = Math.floor(boardY + (gy - this.camera.cy) * s) + 0.5;
        if (py < boardY || py > boardY + boardPx) continue;
        ctx.beginPath();
        ctx.moveTo(Math.max(boardX, 0), py);
        ctx.lineTo(Math.min(boardX + boardPx, w), py);
        ctx.stroke();
      }
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const c = colorAt(x, y);
        if (c === 0) continue;
        const sx = (x - this.camera.cx) * s;
        const sy = (y - this.camera.cy) * s;
        ctx.fillStyle = palette[c];
        ctx.fillRect(sx, sy, s + 0.5, s + 0.5);
      }
    }
    // pending overlays (submitted, awaiting confirmation)
    for (const [k, c] of pending) {
      const x = k >> 16;
      const y = k & 0xffff;
      if (x < x0 || y < y0 || x >= x1 || y >= y1) continue;
      const sx = (x - this.camera.cx) * s;
      const sy = (y - this.camera.cy) * s;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = palette[c];
      ctx.fillRect(sx, sy, s, s);
      ctx.globalAlpha = 1;
    }
    // selection ring drawn by caller (needs selection state)
  }

  drawSelection(x: number, y: number, color: string) {
    const dpr = window.devicePixelRatio || 1;
    const s = this.camera.scale * dpr;
    const sx = (x - this.camera.cx) * s;
    const sy = (y - this.camera.cy) * s;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = Math.max(2, s * 0.12);
    this.ctx.strokeRect(sx - 1, sy - 1, s + 2, s + 2);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
