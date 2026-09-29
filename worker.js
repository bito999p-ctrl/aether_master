// Copyright (c) 2026 Sonografica. All rights reserved.
// Offline side: analysis, auto prescription, calibration, loudness lock, export render.
import { Session } from './engine/session.js';
import { applyPrefs, tameAir } from './engine/prescribe.js';
import { tr } from './engine/i18n.js';

let s = null;
const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const progress = (stage) => (f) => post('progress', { stage, f });

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      s = new Session(m.L, m.R, m.fs);
      const diag = s.analyze(progress(tr('解析', 'Analysing')));
      let auto = s.auto();
      let p = s.calibrate(applyPrefs(auto.params, m.prefs));
      p.driveDb = s.solveLoudness(p, progress(tr('ラウドネス', 'Loudness')));
      const tamed = tameAir(auto, s.airExcess(p)); // master-measured high-end fixes (9-10k fizz, 11k grit): re-solve once
      if (tamed !== auto) {
        auto = tamed;
        p = s.calibrate(applyPrefs(auto.params, m.prefs));
        p.driveDb = s.solveLoudness(p, progress(tr('ラウドネス', 'Loudness')));
      }
      post('analyzed', { diag: { ...diag, sectionLufs: undefined }, auto, params: p,
        ltas: { src: s.sourceLtas(p.targetLufs), master: s.masterLtas(p) } });
    } else if (m.type === 'solve') {
      // recalibrate (dyn depth / punch) and re-lock loudness for edited params
      const p = s.calibrate(m.params);
      if (m.lockLoudness) p.driveDb = s.solveLoudness(p, progress(tr('ラウドネス', 'Loudness')), { fast: true });
      post('solved', { id: m.id, params: p, ltas: { src: s.sourceLtas(p.targetLufs), master: s.masterLtas(p) } });
    } else if (m.type === 'render') {
      const out = s.render(m.params, progress(tr('書き出し', 'Exporting')), m.fs);
      post('rendered', { L: out.L, R: out.R, fs: out.fs, qc: out.qc, format: m.format }, [out.L.buffer, out.R.buffer]);
    }
  } catch (err) {
    post('error', { message: String(err && err.stack || err) });
  }
};
