// Copyright (c) 2026 Sonografica. All rights reserved.
// usage: node tools/diag.js <a.f32> [b.f32 ...]  -> fixed peaks / HF share / resonances per file
import { readF32 } from './io.js';
import { diagnose } from '../engine/analyze.js';
for (const f of process.argv.slice(2)) {
  const { L, R } = readF32(f);
  const d = diagnose(L, R, 44100);
  console.log(f.split(/[\/]/).pop(), JSON.stringify({ fixed: d.fixedPeaks, hf: d.hfLoud, res: d.resonances, lh: +d.lowHighRatioDb.toFixed(1) }));
}
