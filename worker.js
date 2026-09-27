// Offline side: analysis, auto prescription, calibration, loudness lock, export render.
import { Session } from './engine/session.js';
import { applyPrefs } from './engine/prescribe.js';

let s = null;
const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const progress = (stage) => (f) => post('progress', { stage, f });

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      s = new Session(m.L, m.R, m.fs);
      const diag = s.analyze(progress('解析'));
      const auto = s.auto();
      const start = applyPrefs(auto.params, m.prefs);
      const p = s.calibrate(start);
      p.driveDb = s.solveLoudness(p, progress('ラウドネス'));
      post('analyzed', { diag: { ...diag, sectionLufs: undefined }, auto, params: p,
        ltas: { src: s.sourceLtas(p.targetLufs), master: s.masterLtas(p) } });
    } else if (m.type === 'solve') {
      // recalibrate (dyn depth / punch) and re-lock loudness for edited params
      const p = s.calibrate(m.params);
      if (m.lockLoudness) p.driveDb = s.solveLoudness(p, progress('ラウドネス'), { fast: true });
      post('solved', { id: m.id, params: p, ltas: { src: s.sourceLtas(p.targetLufs), master: s.masterLtas(p) } });
    } else if (m.type === 'render') {
      const out = s.render(m.params, progress('書き出し'), m.fs);
      post('rendered', { L: out.L, R: out.R, fs: out.fs, qc: out.qc, format: m.format }, [out.L.buffer, out.R.buffer]);
    }
  } catch (err) {
    post('error', { message: String(err && err.stack || err) });
  }
};
