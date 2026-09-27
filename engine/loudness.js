// ITU-R BS.1770-4 loudness (integrated / short-term / momentary) and true peak.
import { Biquad, Upsampler } from './filters.js';

function kWeighting(fs) {
  const shelf = new Biquad(2).set('highshelf', fs, 1681.9744509555319, 0.7071752369554193, 3.99984385397);
  const hp = new Biquad(2).set('highpass', fs, 38.13547087613982, 0.5003270373253953);
  return { shelf, hp };
}

// Mean-square power of K-weighted audio in 100 ms steps (sum of channels).
export function kPower100ms(L, R, fs) {
  const { shelf, hp } = kWeighting(fs);
  const step = Math.round(fs * 0.1);
  const n = Math.floor(L.length / step);
  const out = new Float64Array(n);
  let k = 0;
  for (let b = 0; b < n; b++) {
    let s = 0;
    for (let i = 0; i < step; i++, k++) {
      const l = hp.tick(shelf.tick(L[k], 0), 0);
      const r = hp.tick(shelf.tick(R[k], 1), 1);
      s += l * l + r * r;
    }
    out[b] = s / step;
  }
  return out;
}

const toLufs = (p) => -0.691 + 10 * Math.log10(p + 1e-20);

// Integrated loudness from 100 ms powers (400 ms blocks, 75 % overlap, gating).
export function integratedFromPowers(P) {
  const blocks = [];
  for (let i = 0; i + 4 <= P.length; i++) blocks.push((P[i] + P[i + 1] + P[i + 2] + P[i + 3]) / 4);
  const abs = blocks.filter((p) => toLufs(p) > -70);
  if (!abs.length) return -70;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const rel = toLufs(mean(abs)) - 10;
  const g = abs.filter((p) => toLufs(p) > rel);
  return toLufs(mean(g.length ? g : abs));
}

// Short-term (3 s) loudness series every 100 ms.
export function shortTermFromPowers(P) {
  const out = [];
  let s = 0;
  for (let i = 0; i < P.length; i++) {
    s += P[i];
    if (i >= 30) s -= P[i - 30];
    if (i >= 29) out.push(toLufs(s / 30));
  }
  return out;
}

export function integrated(L, R, fs) {
  return integratedFromPowers(kPower100ms(L, R, fs));
}

// Loudness range (EBU R128 LRA) from short-term values.
export function lra(P) {
  const st = shortTermFromPowers(P).filter((v) => v > -70);
  if (st.length < 2) return 0;
  const lin = st.map((v) => Math.pow(10, (v + 0.691) / 10));
  const rel = toLufs(lin.reduce((a, b) => a + b, 0) / lin.length) - 20;
  const g = st.filter((v) => v > rel).sort((a, b) => a - b);
  const q = (p) => g[Math.min(g.length - 1, Math.floor(p * (g.length - 1)))];
  return q(0.95) - q(0.10);
}

export function truePeakDb(L, R) {
  const up = new Upsampler(4, 32, 2); // long filter: this is the export QC meter
  const N = L.length, lat = up.latency;
  // Inter-sample peaks only matter where the samples are already near the peak: interpolate
  // only there (samples >= half the sample peak, i.e. > 6 dB overshoot is ignored) - ~5x faster.
  let pk = 0;
  for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  const thr = 0.5 * pk, loud = new Uint8Array(N + 4);
  for (let i = 0; i < N; i++) loud[i + 2] = Math.abs(L[i]) >= thr || Math.abs(R[i]) >= thr ? 1 : 0;
  for (let i = 0; i < N; i++) {
    const c = i - lat + 2; // loud[] index of the samples the current outputs sit between
    if (c < 2 || !(loud[c - 2] | loud[c - 1] | loud[c] | loud[c + 1] | loud[c + 2])) { up.feed(L[i], 0); up.feed(R[i], 1); continue; }
    const a = up.push(L[i], 0);
    pk = Math.max(pk, Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2]), Math.abs(a[3]));
    const b = up.push(R[i], 1);
    pk = Math.max(pk, Math.abs(b[0]), Math.abs(b[1]), Math.abs(b[2]), Math.abs(b[3]));
  }
  return 20 * Math.log10(pk + 1e-20);
}

// Realtime meter used by the worklet: momentary (400 ms) + short-term (3 s).
export class LiveMeter {
  constructor(fs) {
    this.fs = fs;
    const k = kWeighting(fs);
    this.shelf = k.shelf; this.hp = k.hp;
    this.step = Math.round(fs * 0.1);
    this.acc = 0; this.cnt = 0;
    this.ring = new Float64Array(30); this.rp = 0; this.filled = 0;
    this.peak = 0;
    this.momentary = -70; this.shortTerm = -70;
  }
  process(L, R, n) {
    for (let i = 0; i < n; i++) {
      const l = this.hp.tick(this.shelf.tick(L[i], 0), 0);
      const r = this.hp.tick(this.shelf.tick(R[i], 1), 1);
      this.acc += l * l + r * r;
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > this.peak) this.peak = a;
      if (++this.cnt === this.step) {
        this.ring[this.rp] = this.acc / this.step;
        this.rp = (this.rp + 1) % 30; this.filled = Math.min(30, this.filled + 1);
        this.acc = 0; this.cnt = 0;
        let m = 0, s = 0;
        for (let k = 0; k < 4; k++) m += this.ring[(this.rp - 1 - k + 30) % 30];
        for (let k = 0; k < this.filled; k++) s += this.ring[k];
        this.momentary = toLufs(m / 4);
        this.shortTerm = toLufs(s / Math.max(1, this.filled));
      }
    }
  }
  takePeakDb() { const p = this.peak; this.peak = 0; return 20 * Math.log10(p + 1e-20); }
  reset() { this.ring.fill(0); this.filled = 0; this.acc = 0; this.cnt = 0; this.shelf.reset(); this.hp.reset(); }
}
