import { readF32 } from './io.js';
import { renderOffline, DEFAULTS } from '../engine/chain.js';
import { integrated, truePeakDb } from '../engine/loudness.js';
const { L, R } = readF32(process.argv[2]);
let t = Date.now();
console.log('src LUFS', integrated(L, R, 44100).toFixed(2), 'TP', truePeakDb(L, R).toFixed(2), 'ms', Date.now() - t);
const p = { ...DEFAULTS, dyn: [{ hz: 8000, q: 0.5, depth: 2, ratio: 1.5, att: 5, rel: 120, thr: -40, on: true }],
  punchDb: 3, colorDrive: 2.5, spaceMix: 3.5, width: 5, driveDb: 6 };
t = Date.now();
const o = renderOffline(L, R, 44100, p);
console.log('render ms', Date.now() - t, 'x realtime', (L.length / 44100 * 1000 / (Date.now() - t)).toFixed(1));
console.log('out LUFS', integrated(o.L, o.R, 44100).toFixed(2), 'TP', truePeakDb(o.L, o.R).toFixed(2));
