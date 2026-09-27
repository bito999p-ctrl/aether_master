// Tone colour and space: oversampled tape/tube-style saturation (IVGI-like),
// small FDN room (RAUM-like, used at a few % wet), M/S imaging.
import { Biquad, Upsampler, Downsampler, coef } from './filters.js';

// ---------------------------------------------------------------------------
// Saturation at 2x oversampling. Asymmetric tanh (even + odd harmonics),
// normalised to unity small-signal gain so the drive changes colour, not level.
export class Color {
  constructor(fs) {
    this.fs = fs;
    this.up = new Upsampler(2, 16, 2);
    this.down = new Downsampler(2, 32, 2);
    this.tmp = new Float64Array(2);
    this.dc = new Biquad(2);
    this.dc.set('highpass', fs, 8, 0.5);
    this.latency = this.up.latency + (32 - 1) / 2 / 2;
    this.set({ drive: 0, asym: 0.15 });
  }
  set(p) {
    this.p = { ...this.p, ...p };
    const k = this.k = Math.max(1e-4, this.p.drive * 0.14);
    const b = this.b = this.p.asym;
    const t = Math.tanh(k * b);
    this.off = t;
    this.norm = 1 / (k * (1 - t * t));
    this.on = this.p.drive > 0.01;
  }
  shape(x) {
    return (Math.tanh(this.k * (x + this.b)) - this.off) * this.norm;
  }
  process(L, R, n) {
    // keep the oversampler running even when off so toggling is click-free
    const up = this.up, down = this.down, tmp = this.tmp, on = this.on;
    for (let ch = 0; ch < 2; ch++) {
      const X = ch === 0 ? L : R;
      for (let i = 0; i < n; i++) {
        const o = up.push(X[i], ch);
        tmp[0] = on ? this.shape(o[0]) : o[0];
        tmp[1] = on ? this.shape(o[1]) : o[1];
        X[i] = this.dc.tick(down.push(tmp, ch), ch);
      }
    }
  }
  reset() { this.up.reset(); this.down.reset(); this.dc.reset(); }
}

// ---------------------------------------------------------------------------
// 8-line feedback delay network, Hadamard mixing, damped loop, predelay.
// Output is wet only; the chain adds it at `mix`.
const LINES_MS = [29.7, 37.1, 41.1, 43.7, 47.9, 53.3, 59.9, 67.1];

export class Space {
  constructor(fs) {
    this.fs = fs;
    this.maxPre = Math.ceil(0.25 * fs);
    this.pre = [new Float64Array(this.maxPre), new Float64Array(this.maxPre)];
    this.prePos = 0;
    this.lines = LINES_MS.map((ms) => new Float64Array(Math.ceil(ms * 0.001 * fs * 1.6) + 2));
    this.len = new Int32Array(8);
    this.pos = new Int32Array(8);
    this.lpState = new Float64Array(8);
    this.fb = new Float64Array(8);
    this.v = new Float64Array(8);
    this.inHp = new Biquad(2); this.inLp = new Biquad(2);
    this.set({ mix: 0, decay: 1.2, predelay: 30, size: 1.0, damp: 6000, lowCut: 250 });
  }
  set(p) {
    this.p = { ...this.p, ...p };
    const { decay, size, damp, lowCut, predelay } = this.p, fs = this.fs;
    for (let i = 0; i < 8; i++) {
      this.len[i] = Math.min(this.lines[i].length - 1, Math.round(LINES_MS[i] * 0.001 * fs * size));
      this.fb[i] = Math.pow(10, -3 * this.len[i] / (decay * fs));
    }
    this.dampC = coef(1000 / (2 * Math.PI * damp), fs);
    this.inHp.set('highpass', fs, lowCut, 0.7071);
    this.inLp.set('lowpass', fs, damp, 0.7071);
    this.preN = Math.min(this.maxPre - 1, Math.round(predelay * 0.001 * fs));
    this.on = this.p.mix > 0.0005;
  }
  process(L, R, n) {
    if (!this.on) return;
    const { mix } = this.p, lines = this.lines, len = this.len, pos = this.pos, v = this.v, fb = this.fb, lp = this.lpState;
    const pre = this.pre, N = this.maxPre, dc = this.dampC;
    for (let i = 0; i < n; i++) {
      // predelay ring
      const wp = this.prePos;
      pre[0][wp] = this.inLp.tick(this.inHp.tick(L[i], 0), 0);
      pre[1][wp] = this.inLp.tick(this.inHp.tick(R[i], 1), 1);
      const rp = (wp - this.preN + N) % N;
      const il = pre[0][rp], ir = pre[1][rp];
      this.prePos = (wp + 1) % N;
      // read line outputs, damp
      for (let k = 0; k < 8; k++) {
        const buf = lines[k];
        const r = (pos[k] - len[k] + buf.length) % buf.length;
        lp[k] += dc * (buf[r] - lp[k]);
        v[k] = lp[k];
      }
      const outL = (v[0] - v[2] + v[4] - v[6]) * 0.5, outR = (v[1] - v[3] + v[5] - v[7]) * 0.5;
      // 8x8 Hadamard (normalised) via fast Walsh transform
      for (let h = 1; h < 8; h <<= 1)
        for (let a = 0; a < 8; a += h << 1)
          for (let b = a; b < a + h; b++) { const x = v[b], y = v[b + h]; v[b] = x + y; v[b + h] = x - y; }
      for (let k = 0; k < 8; k++) {
        const buf = lines[k];
        buf[pos[k]] = v[k] * 0.35355339 * fb[k] + (k & 1 ? ir : il) * 0.5;
        pos[k] = (pos[k] + 1) % buf.length;
      }
      L[i] += mix * outL;
      R[i] += mix * outR;
    }
  }
  reset() { this.lines.forEach((b) => b.fill(0)); this.pre.forEach((b) => b.fill(0)); this.lpState.fill(0); }
}

// ---------------------------------------------------------------------------
// Stereo: mono below `monoHz` (side high-passed, 4th order), side gain = width,
// M/S presence (vocals sit in the mid): mid bell up, side bell down half.
export class Stereo {
  constructor(fs) {
    this.fs = fs;
    this.sh1 = new Biquad(1); this.sh2 = new Biquad(1);
    this.midBell = new Biquad(1); this.sideBell = new Biquad(1);
    this.set({ monoHz: 100, width: 0, presenceDb: 0, presenceHz: 3000 });
  }
  set(p) {
    this.p = { ...this.p, ...p };
    const fs = this.fs, { monoHz, presenceDb, presenceHz } = this.p;
    this.sh1.set('highpass', fs, Math.max(10, monoHz), 0.5412);
    this.sh2.set('highpass', fs, Math.max(10, monoHz), 1.3066);
    this.midBell.set('peaking', fs, presenceHz, 0.7, presenceDb);
    this.sideBell.set('peaking', fs, presenceHz, 0.7, -presenceDb / 2);
    this.sideGain = 1 + this.p.width / 100;
    this.mono = monoHz > 10;
  }
  process(L, R, n) {
    const pres = !this.midBell.bypass;
    for (let i = 0; i < n; i++) {
      let m = 0.5 * (L[i] + R[i]), s = 0.5 * (L[i] - R[i]);
      if (this.mono) s = this.sh2.tick(this.sh1.tick(s, 0), 0);
      if (pres) { m = this.midBell.tick(m, 0); s = this.sideBell.tick(s, 0); }
      s *= this.sideGain;
      L[i] = m + s; R[i] = m - s;
    }
  }
  reset() { [this.sh1, this.sh2, this.midBell, this.sideBell].forEach((b) => b.reset()); }
}
