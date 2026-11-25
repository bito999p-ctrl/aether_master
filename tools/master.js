// Copyright (c) 2026 Sonografica. All rights reserved.
// Offline harness: analyze -> auto prescription -> calibrate -> loudness lock -> render.
// usage: node tools/master.js <src.f32> <out.f32> [overrides.json]
import fs from 'node:fs';
import { readF32, writeF32 } from './io.js';
import { Session } from '../engine/session.js';
import { GENRES, genreDeltas } from '../engine/genres.js';
import { applyDeltas } from '../engine/spices.js';

const [src, dst, over] = process.argv.slice(2);
const { L, R } = readF32(src);
const s = new Session(L, R, 44100);
let t = Date.now();
const lap = (m) => { console.error(`${m}: ${Date.now() - t} ms`); t = Date.now(); };
const diag = s.analyze(); lap('analyze');
// full auto pass (same as the browser), then optional overrides (JSON; "genre": id applies a genre preset)
let { auto: { reasons, decisions }, params: p } = s.autoMaster(null); lap('auto');
const o = over ? JSON.parse(fs.readFileSync(over, 'utf8')) : {};
if (o.genre) {
  const g = GENRES.find((x) => x.id === o.genre);
  applyDeltas(p, genreDeltas(g, { diag, dec: decisions, p }).deltas);
  delete o.genre;
}
Object.assign(p, o);
p = s.calibrate(p); p.driveDb = s.solveLoudness(p); lap('loudness');
const out = s.render(p); lap('render');
writeF32(dst, out.L, out.R);
const slim = { ...diag, sectionLufs: undefined };
fs.writeFileSync(dst.replace(/\.f32$/, '.json'), JSON.stringify({ diag: slim, decisions, reasons, params: p, qc: out.qc }, null, 1));
console.log(JSON.stringify({ decisions, qc: out.qc, driveDb: p.driveDb, dyn: p.dyn.map((d) => [d.label, d.depth, d.thr]) }));
