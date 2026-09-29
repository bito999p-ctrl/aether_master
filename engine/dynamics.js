// Copyright (c) 2026 Sonografica. All rights reserved.
// Dynamic processors: Nova-style dynamic bell, low-band punch shaper, glue compressor.
import { Biquad, coef, dbToLin } from './filters.js';

// ---------------------------------------------------------------------------
// Dynamic bell (TDR Nova "dyn" band with gain 0): y = x + (g - 1) * BP(x).
// With a constant-0dB bandpass this is an exact bell whose centre gain is g,
// so the gain can move every sample without recomputing coefficients.
// Detection = linked mid of the band signal, power envelope.
// `thr` is absolute (dB, power of the band); calibrate() in analyze.js sets it
// so that the loudest 15% of the track gets `depth` dB of reduction.
export class DynBand {
  constructor(fs) {
    this.fs = fs;
    this.bp = new Biquad(2);
    this.env = 0;
    this.gr = 0; // last gain reduction in dB (for metering)
    this.set({ hz: 1000, q: 2, thr: 0, ratio: 3, att: 5, rel: 80, range: 12, on: false });
  }
  set(p) {
    this.p = { ...this.p, ...p };
    const { hz, q, att, rel } = this.p;
    this.bp.set('bandpass', this.fs, hz, q);
    this.ca = coef(att, this.fs);
    this.cr = coef(rel, this.fs);
    this.slope = 1 - 1 / Math.max(1, this.p.ratio);
  }
  process(L, R, n) {
    if (!this.p.on) { this.gr = 0; return; }
    const { thr, range } = this.p, slope = this.slope, bp = this.bp, ca = this.ca, cr = this.cr;
    let env = this.env, g = 1, gr = 0;
    for (let i = 0; i < n; i++) {
      const bl = bp.tick(L[i], 0), br = bp.tick(R[i], 1);
      const m = 0.5 * (bl + br), d = m * m;
      env += (d > env ? ca : cr) * (d - env);
      // update the gain every 8 samples (envelope is already smooth)
      if ((i & 7) === 0) {
        const lv = 10 * Math.log10(env + 1e-20);
        gr = lv > thr ? Math.min(range, (lv - thr) * slope) : 0;
        g = gr > 0 ? dbToLin(-gr) : 1;
      }
      L[i] += (g - 1) * bl;
      R[i] += (g - 1) * br;
    }
    this.env = env;
    this.gr = gr;
  }
  reset() { this.env = 0; this.bp.reset(); }
}

// ---------------------------------------------------------------------------
// Low-band punch: complementary split (low = LP2(x), high = x - low, so the
// sum is always exactly the input), transient shaping on the low band only
// (kick reads, snare/cymbals untouched), then a low-band gain.
// makeup (dB) is measured offline so shaping does not change the band level.
export class Punch {
  constructor(fs) {
    this.fs = fs;
    this.lp = new Biquad(2);
    this.fast = 0; this.slow = 0;
    this.set({ splitHz: 150, attackDb: 0, sustainDb: 0, lowGainDb: 0, makeupDb: 0 });
  }
  set(p) {
    this.p = { ...this.p, ...p };
    this.lp.set('lowpass', this.fs, this.p.splitHz, 0.7071);
    this.fa = coef(0.8, this.fs); this.fr = coef(40, this.fs);
    this.sa = coef(25, this.fs); this.sr = coef(40, this.fs);
    this.on = Math.abs(this.p.attackDb) > 0.01 || Math.abs(this.p.sustainDb) > 0.01 || Math.abs(this.p.lowGainDb) > 0.01;
  }
  // gain (dB) from the fast/slow envelope difference; shared with the analyzer
  static shape(diffDb, attackDb, sustainDb) {
    // attacks: fast env above slow env; ~8 dB difference = full effect
    if (diffDb > 0) return attackDb * Math.min(1, diffDb / 8);
    return sustainDb * Math.min(1, -diffDb / 8);
  }
  process(L, R, n) {
    if (!this.on) return;
    const { attackDb, sustainDb, lowGainDb, makeupDb } = this.p;
    const lp = this.lp;
    let fast = this.fast, slow = this.slow, g = 1;
    for (let i = 0; i < n; i++) {
      const ll = lp.tick(L[i], 0), lr = lp.tick(R[i], 1);
      const d = 0.5 * (ll * ll + lr * lr);
      fast += (d > fast ? this.fa : this.fr) * (d - fast);
      slow += (d > slow ? this.sa : this.sr) * (d - slow);
      if ((i & 3) === 0) {
        const diff = 10 * Math.log10((fast + 1e-20) / (slow + 1e-20));
        g = dbToLin(Punch.shape(diff, attackDb, sustainDb) + makeupDb + lowGainDb);
      }
      L[i] += (g - 1) * ll;
      R[i] += (g - 1) * lr;
    }
    this.fast = fast; this.slow = slow;
  }
  reset() { this.fast = this.slow = 0; this.lp.reset(); }
}

// ---------------------------------------------------------------------------
// Glue compressor (Kotelnikov-like): feed-forward, stereo-linked, sidechain
// high-passed, dual detection (RMS body + peak), soft knee, program release.
export class Glue {
  constructor(fs) {
    this.fs = fs;
    this.hp = new Biquad(2);
    this.rms = 0; this.pk = 0; this.gdb = 0; this.gr = 0;
    this.set({ thr: -22, ratio: 1.25, knee: 6, attack: 30, releasePeak: 125, releaseRms: 250, scHz: 100, on: true });
  }
  set(p) {
    this.p = { ...this.p, ...p };
    const fs = this.fs;
    this.hp.set('highpass', fs, this.p.scHz, 0.7071);
    this.cRms = coef(this.p.releaseRms, fs);
    this.cPkA = coef(0.5, fs); this.cPkR = coef(this.p.releasePeak, fs);
    // gain is smoothed once per 8 samples
    this.cAtt = coef(this.p.attack / 8, fs); this.cRel = coef(this.p.releasePeak / 8, fs);
    this.slope = 1 - 1 / Math.max(1, this.p.ratio);
  }
  gain(lv) {
    const { thr, knee } = this.p, s = this.slope;
    const o = lv - thr;
    if (o <= -knee / 2) return 0;
    if (o >= knee / 2) return o * s;
    const t = o + knee / 2;
    return s * t * t / (2 * knee);
  }
  process(L, R, n) {
    if (!this.p.on || this.p.ratio <= 1.0001) { this.gr = 0; return; }
    const hp = this.hp;
    let rms = this.rms, pk = this.pk, gdb = this.gdb, g = dbToLin(-gdb);
    for (let i = 0; i < n; i++) {
      const sl = hp.tick(L[i], 0), sr = hp.tick(R[i], 1);
      const d = Math.max(sl * sl, sr * sr);
      rms += this.cRms * (d - rms);
      pk += (d > pk ? this.cPkA : this.cPkR) * (d - pk);
      if ((i & 7) === 0) {
        // RMS carries the body; peaks (6 dB down) only take over on hard hits
        const lv = Math.max(10 * Math.log10(rms * 2 + 1e-20), 10 * Math.log10(pk + 1e-20) - 6);
        const want = this.gain(lv);
        gdb += (want > gdb ? this.cAtt : this.cRel) * (want - gdb);
        g = dbToLin(-gdb);
      }
      L[i] *= g; R[i] *= g;
    }
    this.rms = rms; this.pk = pk; this.gdb = gdb; this.gr = gdb;
  }
  reset() { this.rms = this.pk = this.gdb = 0; this.hp.reset(); }
}

// ---------------------------------------------------------------------------
// Hi-hat / cymbal stab tamer: a wide dynamic bell (same exact-bell trick as DynBand)
// keyed on *transients*, not level. fast = band power env (0.2 ms / 5 ms), slow = its
// running average (15 ms / 120 ms); each hit that jumps `sens` dB over the band's own
// average gets up to `depth` dB, released in `rel` ms. Quiet hats are caught as well as loud ones.
export class HatTamer {
  constructor(fs) {
    this.fs = fs;
    this.bp = new Biquad(2);
    this.cf = coef(0.2, fs); this.cfr = coef(5, fs); this.cs = coef(15, fs); this.csr = coef(120, fs);
    this.fast = 0; this.slow = 0; this.gr = 0;
    this.set({ hz: 10000, q: 0.8, depth: 0, sens: 6, ratio: 4, rel: 40 });
  }
  set(p) {
    this.p = { ...this.p, ...p };
    this.bp.set('bandpass', this.fs, this.p.hz, this.p.q);
    this.crel = coef(this.p.rel, this.fs);
    this.slope = 1 - 1 / Math.max(1, this.p.ratio);
  }
  process(L, R, n) {
    const { depth, sens } = this.p;
    if (!(depth > 0)) { this.gr = 0; return; }
    const bp = this.bp, slope = this.slope, cf = this.cf, cfr = this.cfr, cs = this.cs, csr = this.csr, crel = this.crel;
    let fast = this.fast, slow = this.slow, gr = this.gr, k = dbToLin(-gr) - 1;
    for (let i = 0; i < n; i++) {
      const bl = bp.tick(L[i], 0), br = bp.tick(R[i], 1);
      const m = 0.5 * (bl + br), d = m * m;
      fast += (d > fast ? cf : cfr) * (d - fast);
      slow += (fast > slow ? cs : csr) * (fast - slow);
      if ((i & 3) === 0) {
        const x = 10 * Math.log10((fast + 1e-20) / (slow + 1e-20)) - sens;
        const t = x > 0 ? Math.min(depth, x * slope) : 0;
        gr = t > gr ? t : gr + crel * 4 * (t - gr);
        k = dbToLin(-gr) - 1;
      }
      L[i] += k * bl;
      R[i] += k * br;
    }
    this.fast = fast; this.slow = slow; this.gr = gr;
  }
  reset() { this.fast = this.slow = this.gr = 0; this.bp.reset(); }
}

