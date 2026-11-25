// Copyright (c) 2026 Sonografica. All rights reserved.
// Offline side: analysis, auto prescription, calibration, loudness lock, export render.
import { Session } from './engine/session.js';
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
      // auto prescription + master-measured fixes (fizz / grit, over-cut or too-dark highs, kick guard)
      const { auto, params: p } = s.autoMaster(m.prefs, progress(tr('ラウドネス', 'Loudness')));
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
