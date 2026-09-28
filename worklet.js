// Copyright (c) 2026 Sonografica. All rights reserved.
// Realtime preview: plays the loaded track through MasterChain.
// A/B: "bypass" plays the untouched source, delayed by the chain latency.
import { MasterChain } from './engine/chain.js';
import { LiveMeter } from './engine/loudness.js';

const BLOCK = 128;

class MasterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chain = new MasterChain(sampleRate);
    this.meter = new LiveMeter(sampleRate);
    this.L = null; this.R = null;
    this.pos = 0; this.playing = false;
    this.bypass = false; this.bypassGain = 1;
    this.bl = new Float64Array(BLOCK); this.br = new Float64Array(BLOCK);
    this.tick = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }
  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.L = m.L; this.R = m.R; this.pos = 0; this.playing = false;
        this.chain.reset(); this.meter.reset();
        break;
      case 'params': this.chain.setParams(m.params); break;
      case 'play': this.playing = true; break;
      case 'pause': this.playing = false; break;
      case 'seek':
        this.pos = Math.max(0, Math.min(this.L ? this.L.length - 1 : 0, Math.round(m.pos * sampleRate)));
        this.chain.reset(); this.meter.reset();
        break;
      case 'bypass': this.bypass = m.on; this.bypassGain = Math.pow(10, (m.gainDb || 0) / 20); break;
    }
  }
  process(_, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    if (!this.L || !this.playing) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }
    const { L, R, bl, br } = this, N = L.length, n = oL.length;
    for (let i = 0; i < n; i++) {
      const k = this.pos + i;
      bl[i] = k < N ? L[k] : 0; br[i] = k < N ? R[k] : 0;
    }
    this.chain.process(bl, br, n); // always run so switching back is seamless
    if (this.bypass) {
      const lat = this.chain.latency, g = this.bypassGain;
      for (let i = 0; i < n; i++) {
        const k = this.pos + i - lat;
        bl[i] = k >= 0 && k < N ? L[k] * g : 0; br[i] = k >= 0 && k < N ? R[k] * g : 0;
      }
    }
    for (let i = 0; i < n; i++) { oL[i] = bl[i]; if (oR !== oL) oR[i] = br[i]; }
    this.meter.process(bl, br, n);
    this.pos += n;
    if (this.pos >= N) { this.pos = 0; this.chain.reset(); } // loop
    if (++this.tick % 12 === 0) { // ~35 ms
      const m = this.chain.meters();
      this.port.postMessage({ type: 'meter', pos: this.pos / sampleRate, momentary: this.meter.momentary,
        shortTerm: this.meter.shortTerm, peakDb: this.meter.takePeakDb(), dyn: m.dyn, glue: m.glue, limiter: m.limiter });
    }
    return true;
  }
}
registerProcessor('master-processor', MasterProcessor);
