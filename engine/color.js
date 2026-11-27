// Copyright (c) 2026 Sonografica. All rights reserved.
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
    // keep the oversampler running even when off so toggling is click-free.
    // Inlined Upsampler(2).push -> shape -> Downsampler(2).push -> dc.tick (same arithmetic, same order).
    const up = this.up, down = this.down, on = this.on, k = this.k, b = this.b, off = this.off, norm = this.norm;
    const P = up.P, k0 = up.ph[0], k1 = up.ph[1], N = down.N, h = down.h, c = this.dc.c;
    const { b0, b1, b2, a1, a2 } = c, z1 = this.dc.z1, z2 = this.dc.z2;
    for (let ch = 0; ch < 2; ch++) {
      const X = ch === 0 ? L : R, ub = up.buf[ch], db = down.buf[ch];
      let up_p = up.pos[ch], dp = down.pos[ch], s1 = z1[ch], s2 = z2[ch];
      for (let i = 0; i < n; i++) {
        up_p = up_p + 1 === P ? 0 : up_p + 1;
        const x = X[i];
        ub[up_p] = x; ub[up_p + P] = x;
        let o0 = 0, o1 = 0;
        const e = up_p + P;
        for (let j = 0; j < P; j++) o0 += k0[j] * ub[e - j];
        for (let j = 0; j < P; j++) o1 += k1[j] * ub[e - j];
        if (on) {
          o0 = (Math.tanh(k * (o0 + b)) - off) * norm;
          o1 = (Math.tanh(k * (o1 + b)) - off) * norm;
        }
        dp = dp + 1 === N ? 0 : dp + 1; db[dp] = o0; db[dp + N] = o0;
        dp = dp + 1 === N ? 0 : dp + 1; db[dp] = o1; db[dp + N] = o1;
        let d = 0;
        const f = dp + N;
        for (let j = 0; j < N; j++) d += h[j] * db[f - j];
        const y = b0 * d + s1;
        s1 = b1 * d - a1 * y + s2;
        s2 = b2 * d - a2 * y;
        X[i] = y;
      }
      up.pos[ch] = up_p; down.pos[ch] = dp; z1[ch] = s1; z2[ch] = s2;
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
    this.set({ mix: 0, decay: 1.2, predelay: 30, size: 1.0, damp: 6000, lowCut: 500 }); // HP 500: no low-mid smear (big mix reverbs on this user's songs: HP >= 500 Hz)
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
      let rp = wp - this.preN; if (rp < 0) rp += N;
      const il = pre[0][rp], ir = pre[1][rp];
      this.prePos = wp + 1 === N ? 0 : wp + 1;
      // read line outputs, damp
      for (let k = 0; k < 8; k++) {
        const buf = lines[k];
        let r = pos[k] - len[k]; if (r < 0) r += buf.length;
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
        pos[k] = pos[k] + 1 === buf.length ? 0 : pos[k] + 1;
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
