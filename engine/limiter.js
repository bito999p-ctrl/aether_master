// True-peak lookahead limiter (LoudMax-like, ISP on).
// 1. drive, 2. per-sample true peak (4x polyphase interpolation),
// 3. required gain -> min-hold over the lookahead window -> release smoothing
//    -> box filter of the same length. Because every value inside the box is
//    <= the required gain at the peak, the output never exceeds the ceiling
//    (apart from tiny inter-sample overshoot of the gain modulation, handled
//    by the export's final true-peak check).
import { Upsampler, coef, dbToLin } from './filters.js';

export class Limiter {
  constructor(fs, lookaheadMs = 2.0) {
    this.fs = fs;
    this.W = Math.max(8, Math.round(lookaheadMs * 0.001 * fs));
    this.tp = new Upsampler(4, 12, 2);
    // the interpolator delays its output by tp.latency; delay the audio to match
    const D = this.delay = this.W - 1 + Math.round(this.tp.latency);
    this.latency = D;
    this.dl = [new Float64Array(D + 1), new Float64Array(D + 1)];
    this.dp = 0;
    this.minQ = new Float64Array(this.W); this.minI = new Int32Array(this.W);
    this.qh = 0; this.qt = 0; this.t = 0;
    this.box = new Float64Array(this.W); this.bp = 0; this.bsum = this.W;
    this.box.fill(1);
    this.env = 1;
    this.gr = 0;
    this.set({ driveDb: 0, ceilingDb: -1, release: 60, on: true });
  }
  set(p) {
    this.p = { ...this.p, ...p };
    this.drive = dbToLin(this.p.driveDb);
    this.ceil = dbToLin(this.p.ceilingDb);
    this.cr = coef(this.p.release, this.fs);
    // slower second release for sustained reduction (less pumping on dense mixes)
    this.cr2 = coef(this.p.release * 6, this.fs);
  }
  // sliding-window minimum (monotonic deque) of the required gain
  pushMin(v) {
    const W = this.W, q = this.minQ, idx = this.minI, t = this.t++;
    while (this.qt > this.qh && idx[this.qh % W] <= t - W) this.qh++;
    while (this.qt > this.qh && q[(this.qt - 1) % W] >= v) this.qt--;
    q[this.qt % W] = v; idx[this.qt % W] = t; this.qt++;
    return q[this.qh % W];
  }
  process(L, R, n) {
    const drive = this.drive, ceil = this.ceil, tp = this.tp, W = this.W, D = this.delay;
    const dl0 = this.dl[0], dl1 = this.dl[1], box = this.box;
    let env = this.env, bsum = this.bsum, bp = this.bp, dp = this.dp, minGain = 1;
    for (let i = 0; i < n; i++) {
      const xl = L[i] * drive, xr = R[i] * drive;
      const ul = tp.push(xl, 0);
      let pk = Math.max(Math.abs(ul[0]), Math.abs(ul[1]), Math.abs(ul[2]), Math.abs(ul[3]));
      const ur = tp.push(xr, 1);
      pk = Math.max(pk, Math.abs(ur[0]), Math.abs(ur[1]), Math.abs(ur[2]), Math.abs(ur[3]));
      const req = pk > ceil ? ceil / pk : 1;
      const held = this.pushMin(req);
      // two-stage release: fast recovery for transients, slow when reduction persists
      if (held < env) env = held;
      else {
        const c = (1 - env) > 0.1 ? this.cr2 : this.cr;
        env += c * (held - env);
      }
      bsum += env - box[bp]; box[bp] = env; bp = (bp + 1) % W;
      const g = Math.min(1, bsum / W);
      if (g < minGain) minGain = g;
      // delayed audio
      const rp = (dp + 1) % (D + 1);
      dl0[dp] = xl; dl1[dp] = xr;
      L[i] = dl0[rp] * g; R[i] = dl1[rp] * g;
      dp = rp;
    }
    this.env = env; this.bsum = bsum; this.bp = bp; this.dp = dp;
    this.gr = -20 * Math.log10(minGain);
  }
  reset() {
    this.dl.forEach((b) => b.fill(0)); this.tp.reset(); this.box.fill(1); this.bsum = this.W;
    this.env = 1; this.qh = this.qt = this.t = 0;
  }
}
