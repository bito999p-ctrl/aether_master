// Spectrum (log frequency): live analyser as a faint background, whole-song average lines for
// the original and the master (loudness-matched), and the static EQ curve.
const F_MIN = 20, F_MAX = 20000, DB_MIN = -90, DB_MAX = -10, EQ_RANGE = 12;
const GRID = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const fmt = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f < 10000 ? 1 : 0)}k` : `${Math.round(f)}`);
const COL = { src: '#58c4ff', master: '#ffb03b', eq: '#6f6' };

export class Spectrum {
  constructor(canvas, ctx, source) {
    this.cv = canvas;
    this.an = ctx.createAnalyser();
    this.an.fftSize = 8192;
    this.an.smoothingTimeConstant = 0.8;
    source.connect(this.an); // analyser downmixes stereo to mono
    this.bins = new Float32Array(this.an.frequencyBinCount);
    this.fs = ctx.sampleRate;
    this.peak = null;
    this.eqCurve = null; // Float32Array of dB per x pixel
    this.eqFn = null;
    this.lt = null; // { src, master }: { db (per FFT bin), offsetDb }
    this.ltCurve = null;
    this.show = { src: true, master: true, eq: true };
    this.hoverX = -1;
    this.bypass = false;
    this.chips = [];
    canvas.addEventListener('pointermove', (e) => { this.hoverX = e.offsetX; });
    canvas.addEventListener('pointerleave', () => { this.hoverX = -1; });
    // legend chips toggle the overlays
    canvas.addEventListener('click', (e) => {
      const c = this.chips.find((c) => e.offsetX >= c.x0 && e.offsetX <= c.x1 && e.offsetY <= 18);
      if (c) this.show[c.key] = !this.show[c.key];
    });
    const loop = () => { this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  xToF(x, w) { return F_MIN * Math.pow(F_MAX / F_MIN, x / w); }
  fToX(f, w) { return (w * Math.log(f / F_MIN)) / Math.log(F_MAX / F_MIN); }
  // fn(f) -> dB of the static EQ; recomputed lazily at the canvas width
  setEq(fn) { this.eqFn = fn; this.eqCurve = null; }
  setLtas(lt) { this.lt = lt; this.ltCurve = null; }

  draw() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      this.eqCurve = null; this.ltCurve = null; this.peak = null;
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(cv);
    g.fillStyle = css.getPropertyValue('--sp-bg') || '#111';
    g.fillRect(0, 0, w, h);
    const yDb = (db) => h * (1 - (db - DB_MIN) / (DB_MAX - DB_MIN));
    const line = (arr, color, width) => {
      g.beginPath();
      for (let x = 0; x < w; x++) x ? g.lineTo(x, yDb(arr[x])) : g.moveTo(x, yDb(arr[x]));
      g.strokeStyle = color; g.lineWidth = width; g.stroke(); g.lineWidth = 1;
    };

    // grid
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = '10px system-ui';
    for (const f of GRID) {
      const x = this.fToX(f, w);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.fillText(fmt(f), x + 2, h - 3);
    }

    // live analyser (faint background) + peak hold
    this.an.getFloatFrequencyData(this.bins);
    const cur = this.bands(this.bins, w, 1 / 6, 0);
    if (!this.peak || this.peak.length !== w) this.peak = new Float32Array(w).fill(DB_MIN);
    for (let x = 0; x < w; x++) this.peak[x] = Math.max(cur[x], this.peak[x] - 0.4);
    const col = this.bypass ? '120,170,255' : '255,170,60';
    g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x < w; x++) g.lineTo(x, yDb(cur[x]));
    g.lineTo(w, h); g.closePath();
    g.fillStyle = `rgba(${col},0.18)`; g.fill();
    line(this.peak, 'rgba(255,255,255,0.18)', 1);

    // whole-song average: original and master, loudness-matched (1/3-octave smoothing)
    if (this.lt) {
      if (!this.ltCurve || this.ltCurve.src.length !== w) {
        this.ltCurve = {};
        for (const k of ['src', 'master']) this.ltCurve[k] = this.bands(this.lt[k].db, w, 1 / 3, this.lt[k].offsetDb);
      }
      if (this.show.src) line(this.ltCurve.src, COL.src, 1.8);
      if (this.show.master) line(this.ltCurve.master, COL.master, 1.8);
    }

    // EQ curve (static tone + manual EQ), centred, ±12 dB full scale
    if (this.eqFn && this.show.eq) {
      if (!this.eqCurve || this.eqCurve.length !== w) {
        this.eqCurve = new Float32Array(w);
        for (let x = 0; x < w; x++) this.eqCurve[x] = this.eqFn(this.xToF(x, w));
      }
      const yEq = (db) => h / 2 - (db / EQ_RANGE) * (h / 2 - 8);
      g.strokeStyle = 'rgba(255,255,255,0.15)'; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); g.setLineDash([]);
      g.beginPath();
      for (let x = 0; x < w; x++) x ? g.lineTo(x, yEq(this.eqCurve[x])) : g.moveTo(x, yEq(this.eqCurve[x]));
      g.strokeStyle = COL.eq; g.lineWidth = 1.2; g.setLineDash([5, 3]); g.stroke(); g.setLineDash([]); g.lineWidth = 1;
    }

    // hover readout
    if (this.hoverX >= 0) {
      const x = this.hoverX, f = this.xToF(x, w), xi = Math.min(w - 1, x | 0);
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      let t = f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : Math.round(f) + ' Hz';
      if (this.ltCurve) {
        const d = this.ltCurve.master[xi] - this.ltCurve.src[xi];
        t += ` / 原曲との差 ${d >= 0 ? '+' : ''}${d.toFixed(1)} dB`;
      }
      if (this.eqCurve && this.show.eq) t += ` / EQ ${this.eqCurve[xi].toFixed(1)} dB`;
      g.fillStyle = '#fff'; g.font = '11px system-ui';
      g.fillText(t, Math.min(x + 4, w - g.measureText(t).width - 4), 30);
    }
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '10px system-ui';
    g.fillText(this.bypass ? '再生中: 元音源（バイパス）' : '再生中: マスター', 4, 12);

    // legend chips (right-aligned, click to toggle)
    this.chips = [];
    const items = [];
    if (this.lt) items.push(['src', '原曲 平均'], ['master', 'マスター 平均']);
    if (this.eqFn) items.push(['eq', 'EQ 設定']);
    let rx = w - 4;
    for (const [key, label] of items.reverse()) {
      const tw = g.measureText(label).width + 14, x0 = rx - tw, c = COL[key];
      g.globalAlpha = this.show[key] ? 1 : 0.35;
      g.fillStyle = c; g.fillRect(x0, 5, 8, 8);
      g.fillText(label, x0 + 12, 12);
      if (!this.show[key]) { g.strokeStyle = c; g.beginPath(); g.moveTo(x0 + 12, 8.5); g.lineTo(rx, 8.5); g.stroke(); }
      g.globalAlpha = 1;
      this.chips.push({ key, x0, x1: rx });
      rx = x0 - 10;
    }
  }

  // Power average over an `oct`-octave window per pixel, +3 dB/oct tilt so a balanced mix reads
  // roughly flat (like most mastering analysers). bins: dB per bin of an 8192 FFT.
  bands(bins, w, oct, offsetDb) {
    const n = bins.length, binHz = this.fs / 8192;
    if (!this.cum || this.cum.length !== n + 1) this.cum = new Float64Array(n + 1);
    for (let b = 0; b < n; b++) this.cum[b + 1] = this.cum[b] + Math.pow(10, bins[b] / 10);
    const out = new Float32Array(w), half = Math.pow(2, oct / 2);
    for (let x = 0; x < w; x++) {
      const f = this.xToF(x + 0.5, w);
      const b0 = Math.max(1, Math.floor(f / half / binHz));
      const b1 = Math.min(n - 1, Math.max(b0, Math.ceil(f * half / binHz)));
      const pw = (this.cum[b1 + 1] - this.cum[b0]) / (b1 - b0 + 1);
      out[x] = Math.max(DB_MIN, 10 * Math.log10(pw + 1e-20) + 3 * Math.log2(f / 1000) + offsetDb);
    }
    return out;
  }
}
