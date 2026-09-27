// Interactive 4-band EQ graph: drag a node (frequency / gain), wheel over it for Q, double-click = flat.
// Also draws the auto tone EQ faintly so the manual bands are seen in context.
import { magDb } from './engine/chain.js';
import { tr } from './engine/i18n.js';

const F_MIN = 20, F_MAX = 20000, RANGE = 12;
const GRID = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
export const BAND_COL = ['#ff8a5b', '#f6d365', '#62d98b', '#58c4ff'];
const fmt = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f < 10000 ? 1 : 0)}k` : `${Math.round(f)}`);

export class EqGraph {
  // io: { chain (MasterChain with current params), get(key), begin(), change(key, value), select(k) }
  constructor(canvas, io) {
    this.cv = canvas; this.io = io; this.sel = 1; this.drag = 0; this.hover = 0;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => {
      const k = this.hit(e.offsetX, e.offsetY); if (!k) return;
      this.drag = k; this.select(k); io.begin();
      canvas.setPointerCapture(e.pointerId); e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) { const h = this.hit(e.offsetX, e.offsetY); if (h !== this.hover) { this.hover = h; canvas.style.cursor = h ? 'grab' : ''; this.draw(); } return; }
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const hz = Math.round(Math.min(F_MAX, Math.max(F_MIN, this.xToF(e.offsetX, w))));
      const db = Math.round(10 * Math.min(RANGE, Math.max(-RANGE, this.yToDb(e.offsetY, h)))) / 10;
      io.change(`eq${this.drag}Hz`, hz); io.change(`eq${this.drag}Db`, db);
    });
    const end = () => { this.drag = 0; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => { if (this.hover) { this.hover = 0; this.draw(); } });
    canvas.addEventListener('dblclick', (e) => {
      const k = this.hit(e.offsetX, e.offsetY); if (!k) return;
      io.begin(); io.change(`eq${k}Db`, 0);
    });
    // wheel over a node changes its width (Q); elsewhere the page scrolls normally
    canvas.addEventListener('wheel', (e) => {
      const k = this.hit(e.offsetX, e.offsetY, 30); if (!k) return;
      e.preventDefault();
      const q = io.get(`eq${k}Q`) * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
      this.select(k); io.begin(); io.change(`eq${k}Q`, Math.round(10 * Math.min(10, Math.max(0.3, q))) / 10);
    }, { passive: false });
  }
  select(k) { if (k !== this.sel) { this.sel = k; this.io.select(k); } this.draw(); }
  xToF(x, w) { return F_MIN * Math.pow(F_MAX / F_MIN, x / w); }
  fToX(f, w) { return (w * Math.log(f / F_MIN)) / Math.log(F_MAX / F_MIN); }
  yToDb(y, h) { return RANGE * (1 - (2 * (y - 10)) / (h - 20)); }
  dbToY(db, h) { return 10 + ((h - 20) * (1 - db / RANGE)) / 2; }
  node(k) {
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    return [this.fToX(this.io.get(`eq${k}Hz`), w), this.dbToY(this.io.get(`eq${k}Db`), h)];
  }
  hit(x, y, r = 16) {
    let best = 0, bd = r * r;
    for (let k = 1; k <= 4; k++) { const [nx, ny] = this.node(k), d = (nx - x) ** 2 + (ny - y) ** 2; if (d < bd) { bd = d; best = k; } }
    return best;
  }

  draw() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'), ch = this.io.chain, fs = ch.fs;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0a0c10'; g.fillRect(0, 0, w, h);
    g.font = '10px system-ui'; g.lineWidth = 1;
    for (const f of GRID) {
      const x = this.fToX(f, w);
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillText(fmt(f), x + 2, h - 3);
    }
    for (const db of [-12, -6, 0, 6, 12]) {
      const y = this.dbToY(db, h);
      g.strokeStyle = db ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.18)';
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      if (db) { g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillText(`${db > 0 ? '+' : ''}${db}`, 3, y - 2); }
    }
    const user = (f, only) => { let s = 0; for (let k = 1; k <= 4; k++) if (!only || only === k) s += magDb(ch.eq['u' + k].c, f, fs); return s; };
    const curve = (fn) => { const a = new Float32Array(w); for (let x = 0; x < w; x++) a[x] = fn(this.xToF(x, w)); return a; };
    const path = (a) => { g.beginPath(); for (let x = 0; x < w; x++) { const y = this.dbToY(Math.max(-RANGE - 2, Math.min(RANGE + 2, a[x])), h); x ? g.lineTo(x, y) : g.moveTo(x, y); } };

    // auto tone EQ (everything static except the manual bands), faint dashed
    const tone = curve((f) => ch.staticGainAt(f) - user(f));
    path(tone); g.strokeStyle = 'rgba(255,255,255,0.28)'; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);
    // each band's own bell, filled in its colour
    const y0 = this.dbToY(0, h);
    for (let k = 1; k <= 4; k++) {
      if (Math.abs(this.io.get(`eq${k}Db`)) < 0.05) continue;
      path(curve((f) => user(f, k))); g.lineTo(w, y0); g.lineTo(0, y0); g.closePath();
      g.fillStyle = BAND_COL[k - 1] + (k === this.sel ? '40' : '22'); g.fill();
    }
    // total manual EQ
    path(curve((f) => user(f))); g.strokeStyle = '#e9ecf3'; g.lineWidth = 2; g.stroke(); g.lineWidth = 1;
    // nodes
    for (let k = 1; k <= 4; k++) {
      const [x, y] = this.node(k), on = k === this.sel || k === this.hover || k === this.drag;
      g.beginPath(); g.arc(x, y, on ? 9 : 7, 0, 2 * Math.PI);
      g.fillStyle = BAND_COL[k - 1]; g.fill();
      if (k === this.sel) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); g.lineWidth = 1; }
      g.fillStyle = '#10131a'; g.font = 'bold 10px system-ui'; g.textAlign = 'center'; g.fillText(k, x, y + 3.5); g.textAlign = 'left';
    }
    g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = '10px system-ui';
    g.fillText(tr('点をドラッグ ・ ホイールで幅 ・ ダブルクリックで 0 dB', 'Drag points · wheel for width · double-click for 0 dB'), 6, 13);
    g.fillStyle = 'rgba(255,255,255,0.3)'; g.textAlign = 'right'; g.fillText(tr('点線 = 自動のトーンEQ', 'Dotted = auto tone EQ'), w - 6, 13); g.textAlign = 'left';
  }
}
