// UI: decode -> worker (analyze / auto / loudness lock / export) + worklet (live preview).
import { learnPrefs } from './engine/prescribe.js';
import { GROUPS } from './engine/controls.js';
import { MasterChain } from './engine/chain.js';
import { Spectrum } from './spectrum.js';
import { EqGraph, BAND_COL } from './eqgraph.js';
import { AXES, FIXES, MAX_LEVEL, recommend, applyDeltas, describe } from './engine/spices.js';
import { GENRES, guessGenre, genreDeltas } from './engine/genres.js';
import { ENGINE_VERSION } from './engine/version.js';
import { LANG, tr, setLang } from './engine/i18n.js';

const FS = 44100;
const $ = (id) => document.getElementById(id);
$('engineVer').textContent = tr(`エンジン ${ENGINE_VERSION}`, `Engine ${ENGINE_VERSION}`);
translateStatic();

const SLIDER_KEYS = GROUPS.flatMap(([, rows]) => rows.map((r) => r[0]));

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let ctx, node, worker, spec;
const eqChain = new MasterChain(FS); // main-thread copy, only for drawing the EQ curve
let fileName = 'master', duration = 0;
let diag, rawAuto, lastAuto, start, cur;
let playing = false, bypass = false;
const rows = {}; // key -> {row, input, val}

// ------------------------------------------------------------------ setup
async function ensureAudio() {
  if (ctx) return;
  ctx = new AudioContext({ sampleRate: FS });
  await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
  node = new AudioWorkletNode(ctx, 'master-processor', { numberOfInputs: 0, outputChannelCount: [2] });
  node.connect(ctx.destination);
  spec = new Spectrum($('spec'), ctx, node);
  node.port.onmessage = (e) => e.data.type === 'meter' && onMeter(e.data);
  worker = new Worker(new URL(`./worker.js?lang=${LANG}`, import.meta.url), { type: 'module' });
  worker.onmessage = (e) => onWorker(e.data);
}

async function loadFile(file) {
  await ensureAudio();
  setReady(false); // no playback until analysis is done (otherwise the raw file sounds like the master)
  fileName = file.name.replace(/\.[^.]+$/, '');
  status(tr(`読み込み中: ${file.name}`, `Loading: ${file.name}`));
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  duration = buf.duration;
  node.port.postMessage({ type: 'load', L: L.slice(), R: R.slice() });
  worker.postMessage({ type: 'load', L: L.slice(), R: R.slice(), fs: FS, prefs: store.get('am5.prefs', {}) });
  status(tr('解析中…', 'Analysing…'));
}

// ------------------------------------------------------------------ worker
let solveBusy = false, solveQueued = false, solveTimer = 0, exportFormat = '';
function onWorker(m) {
  if (m.type === 'progress') { progress(m.f); return status(`${m.stage} ${Math.round(m.f * 100)}%`); }
  if (m.type === 'error') { console.error(m.message); status(tr('エラー: ', 'Error: ') + m.message.split('\n')[0]); solveBusy = false; return; }
  if (m.type === 'analyzed') {
    diag = m.diag; lastAuto = m.auto; rawAuto = m.auto.params; start = { ...m.params, off: {} }; cur = structuredClone(start); solvedAt = targetKey();
    spiceLv = {}; spiceStack = {}; genre = null; history = []; $('undo').disabled = true;
    buildUI(m.auto); renderSpices(); spiceMsg('');
    spec.setLtas(m.ltas);
    pushParams();
    for (const id of ['main', 'transport', 'viz', 'expGroup', 'presetWrap']) $(id).classList.remove('hidden');
    $('drop').classList.add('hidden');
    setReady(true);
    status(`${fileName} — ${tr('準備完了', 'ready')}`);
  } else if (m.type === 'solved') {
    solveBusy = false;
    cur.driveDb = m.params.driveDb;
    spec.setLtas(m.ltas);
    cur.punchMakeupDb = m.params.punchMakeupDb;
    for (const d of cur.dyn) { const s = m.params.dyn.find((x) => x.id === d.id); if (s) d.thr = s.thr; }
    pushParams();
    if (solveQueued) { solveQueued = false; sendSolve(); } else $('solving').textContent = '';
  } else if (m.type === 'rendered') {
    $('qc').textContent = `${tr('書き出し', 'Exported')}: ${m.fs / 1000} kHz / ${m.qc.lufs} LUFS / ${m.qc.truePeakDb} dBTP`;
    saveExport(m.L, m.R, exportFormat, m.fs);
    status(`${fileName} — ${tr('書き出し完了', 'export done')}`);
  }
}
function requestSolve() {
  clearTimeout(solveTimer);
  $('solving').textContent = tr('調整中…', 'Adjusting…');
  solveTimer = setTimeout(() => (solveBusy ? (solveQueued = true) : sendSolve()), 300);
}
// the loudness target itself always re-solves the limiter drive; the lock only decides
// whether other edits are followed back to the target
let solvedAt = '';
const targetKey = () => `${cur.targetLufs}|${cur.ceilingDb}`;
function sendSolve() {
  solveBusy = true;
  const lock = $('lock').checked || targetKey() !== solvedAt;
  solvedAt = targetKey();
  $('solving').textContent = lock ? tr('ラウドネス合わせ中…', 'Matching loudness…') : tr('調整中…', 'Adjusting…');
  worker.postMessage({ type: 'solve', params: cur, lockLoudness: lock });
}
function pushParams() {
  node.port.postMessage({ type: 'params', params: cur });
  eqChain.setParams(cur);
  spec.setEq((f) => eqChain.staticGainAt(f));
}

// ------------------------------------------------------------------ transport / A-B
let ready = false;
function setReady(on) {
  ready = on;
  if (!on) setPlaying(false);
  $('play').disabled = $('ab').disabled = !on;
  document.body.classList.toggle('busy', !on);
}
function setPlaying(on) {
  if (on && !ready) return;
  playing = on;
  if (on) ctx.resume();
  node.port.postMessage({ type: on ? 'play' : 'pause' });
  $('play').classList.toggle('on', on);
}
function sendBypass() {
  // plain bypass: the untouched source at its original level
  node.port.postMessage({ type: 'bypass', on: bypass, gainDb: 0 });
}
function toggleAB() {
  bypass = !bypass;
  $('ab').classList.toggle('ab-on', bypass);
  spec.bypass = bypass;
  $('mBig').classList.toggle('b', bypass);
  sendBypass();
}

const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let seeking = false;
function onMeter(m) {
  if (!seeking && duration) {
    $('pos').value = m.pos / duration; $('pos').style.setProperty('--p', (100 * m.pos / duration).toFixed(2) + '%');
    $('time').textContent = `${fmtT(m.pos)} / ${fmtT(duration)}`;
  }
  const db = (v) => (v <= -69 ? '-inf' : v.toFixed(1));
  const gr = (v) => (Math.abs(v) < 0.05 ? '0.0' : (-Math.abs(v)).toFixed(1));
  const pct = (v, range) => Math.max(0, Math.min(100, (100 * v) / range)) + '%';
  $('mS').textContent = db(m.shortTerm);
  $('mM').textContent = db(m.momentary);
  $('mP').textContent = db(m.peakDb);
  $('mP').style.color = m.peakDb > -0.5 ? 'var(--red)' : '';
  $('bP').style.width = pct(m.peakDb + 30, 30);
  $('mG').textContent = gr(m.glue); $('bG').style.width = pct(Math.abs(m.glue), 8);
  $('mL').textContent = gr(m.limiter); $('bL').style.width = pct(Math.abs(m.limiter), 8);
  $('mTarget').textContent = bypass ? tr('原音を再生中', 'Playing original') : `${tr('目標', 'Target')} ${cur.targetLufs.toFixed(1)} LUFS`;
  (cur?.dyn || []).forEach((d, i) => {
    const el = rows['dyn:' + d.id]?.gr; if (!el) return;
    el.firstChild.style.width = pct(m.dyn[i], 6); el.title = m.dyn[i] > 0.05 ? `${tr('今', 'Now')} -${m.dyn[i].toFixed(1)} dB` : '';
  });
  for (const [k, v] of [['glue', m.glue], ['limiter', m.limiter]]) {
    const mm = modMeters[k]; if (!mm) continue;
    mm.bar.style.width = pct(Math.abs(v), 8); mm.val.textContent = gr(v);
  }
}

// ------------------------------------------------------------------ UI
function status(t) { $('status').textContent = t; $('status').parentElement.title = t; if (!/%$/.test(t)) progress(null); }
function progress(f) { $('prog').style.width = f == null ? '0' : `${Math.round(f * 100)}%`; }

// ------------------------------------------------------------------ detail rack
// Each module is a card with its own colour, a live meter where there is one, and a reset.
const MODS = {
  dyn: { id: 'dyn', color: '#ff6b9a', sub: tr('大きい瞬間だけ効くEQ。赤いバーが今効いている量', 'EQ that acts only at loud moments. The red bar shows how much it is working now') },
  [tr('トーン', 'Tone')]: { id: 'tone', color: '#62d98b', sub: tr('曲全体の音色（常にかかるEQ）', 'Overall tone (always-on EQ)') },
  [tr('手動EQ（特定の帯域を削る・足す）', 'Manual EQ (cut or boost a band)')]: { id: 'eq', title: tr('手動EQ', 'Manual EQ'), color: '#c58bff', sub: tr('特定の帯域をピンポイントで削る・足す', 'Cut or boost a specific band precisely'), wide: true },
  [tr('パンチ', 'Punch')]: { id: 'punch', color: '#ff8a5b', sub: tr('キックとベースの立ち上がり', 'Attack of kick and bass') },
  [tr('グルー', 'Glue')]: { id: 'glue', color: '#58c4ff', sub: tr('全体をまとめるコンプ', 'Compressor that glues the mix together'), meter: 'glue' },
  [tr('カラー／空間', 'Colour / Space')]: { id: 'color', color: '#f6d365', sub: tr('テープの温かさと響き', 'Tape warmth and room') },
  [tr('ステレオ', 'Stereo')]: { id: 'stereo', color: '#7ee0d0', sub: tr('広がりと真ん中の存在感', 'Width and centre presence') },
  [tr('ラウドネス', 'Loudness')]: { color: '#ffb03b', sub: tr('目標の音量に合わせるリミッター', 'Limiter that reaches the target loudness'), meter: 'limiter' },
};
const modMeters = {}; // 'glue' | 'limiter' -> { bar, val }
const mods = []; // built modules, for power / dirty refresh
let eqGraph = null;

function makeModule(parent, meta, fallbackTitle) {
  const el = document.createElement('section');
  el.className = 'mod' + (meta.wide ? ' wide' : '');
  el.style.setProperty('--mc', meta.color);
  el.innerHTML = `<header>${meta.id ? `<button class="pwr" role="switch" title="${tr('このモジュールをON／OFF（OFFで素通し）', 'Turn this module on/off (off = bypass)')}"></button>` : '<i class="led"></i>'}<div class="mt"><b>${meta.title || fallbackTitle}</b><small>${meta.sub}</small></div>`
    + (meta.meter ? '<div class="mm"><span class="k">GR</span><span class="bar"><i></i></span><span class="v">0.0</span></div>' : '')
    + `<button class="mreset" title="${tr('このモジュールをオートに戻す', 'Reset this module to auto')}">↺ ${tr('オート', 'Auto')}</button></header><div class="mbody"></div>`;
  parent.append(el);
  const mod = { el, body: el.querySelector('.mbody'), rows: [], id: meta.id };
  mods.push(mod);
  if (meta.id) el.querySelector('.pwr').onclick = () => { snapshot(); setOff(meta.id, !cur.off?.[meta.id]); };
  if (meta.meter) modMeters[meta.meter] = { bar: el.querySelector('.mm i'), val: el.querySelector('.mm .v') };
  el.querySelector('.mreset').onclick = () => {
    snapshot();
    for (const r of mod.rows) { r.set(r.autoVal); if (r.dyn) r.dyn.on = r.autoOn; }
    if (mod.id && cur.off) delete cur.off[mod.id];
    refreshUI(); pushParams(); requestSolve();
  };
  return mod;
}
const updMod = (mod) => {
  const off = !!(mod.id && cur.off?.[mod.id]);
  mod.el.classList.toggle('bypassed', off);
  mod.el.classList.toggle('dirty', off || mod.rows.some((r) => r.row.classList.contains('changed')));
};
// switch modules off (bypass) / on; values are kept, the engine just runs them flat
function setOff(ids, off) {
  cur.off = { ...cur.off };
  for (const id of [].concat(ids)) { if (off) cur.off[id] = true; else delete cur.off[id]; }
  refreshUI(); pushParams(); requestSolve();
}
const MOD_IDS = ['tone', 'eq', 'dyn', 'punch', 'glue', 'color', 'stereo'];

// A fader: label / value on top, a track filled from 0 (or the minimum) with a tick at the auto value.
// log: frequency faders move on a log scale (input position 0..1000)
function fader(mod, key, label, min, max, step, unit, get, set, autoVal, { log, dyn, parent } = {}) {
  const toPos = (v) => (log ? Math.round(1000 * Math.log(v / min) / Math.log(max / min)) : v);
  const fromPos = (x) => (log ? Math.round(min * Math.pow(max / min, x / 1000)) : x);
  const frac = (v) => Math.min(1, Math.max(0, (toPos(v) - toPos(min)) / (toPos(max) - toPos(min))));
  const zero = !log && min < 0 && max > 0 ? frac(0) : 0;
  const row = document.createElement('div'); row.className = 'fd';
  const top = document.createElement('div'); top.className = 'fd-top';
  let cb = null, gr = null;
  if (dyn) {
    cb = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'sw', checked: dyn.on, title: tr('オン／オフ', 'On / off') });
    cb.onchange = () => { snapshot(); dyn.on = cb.checked; show(); pushParams(); requestSolve(); };
    top.append(cb);
  }
  const lab = Object.assign(document.createElement('span'), { className: 'l', textContent: label, title: tr(`${label}（ダブルクリックでオートに戻す）`, `${label} (double-click to reset to auto)`) });
  top.append(lab);
  if (dyn) { gr = document.createElement('span'); gr.className = 'grb'; gr.innerHTML = '<i></i>'; top.append(gr); }
  const reset = Object.assign(document.createElement('button'), { className: 'rs', textContent: '↺', title: tr(`オートに戻す（${+(+autoVal).toFixed(2)}${unit}）`, `Reset to auto (${+(+autoVal).toFixed(2)}${unit})`) });
  const val = document.createElement('span'); val.className = 'val';
  top.append(reset, val);
  const trk = document.createElement('div'); trk.className = 'fd-trk';
  const input = Object.assign(document.createElement('input'), { type: 'range', min: toPos(min), max: toPos(max), step: log ? 1 : step, value: toPos(get()) });
  const tick = document.createElement('i'); tick.className = 'tick';
  trk.append(input, tick);
  row.append(top, trk);
  const fmtV = (v) => {
    const s = +(+v).toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0);
    return `${zero > 0 && s > 0 ? '+' : ''}${s}${unit ? ' ' + unit : ''}`;
  };
  const r = { row, input, get, set, toPos, autoVal, dyn, autoOn: dyn ? start.dyn.find((x) => x.id === dyn.id)?.on ?? true : true, gr, cb };
  const show = () => {
    const v = get(), p = frac(v);
    val.textContent = fmtV(v);
    input.style.setProperty('--a', Math.min(zero, p)); input.style.setProperty('--b', Math.max(zero, p));
    tick.style.setProperty('--t', frac(autoVal));
    row.classList.toggle('changed', Math.abs(v - autoVal) > 1e-6 || (!!dyn && dyn.on !== r.autoOn));
    row.classList.toggle('off', !!dyn && !dyn.on);
    updMod(mod);
  };
  r.show = show;
  const toAuto = () => { snapshot(); set(autoVal); if (dyn) { dyn.on = r.autoOn; cb.checked = dyn.on; } input.value = toPos(autoVal); show(); pushParams(); requestSolve(); };
  input.addEventListener('pointerdown', snapshot);
  input.addEventListener('keydown', snapshot);
  input.oninput = () => { set(fromPos(+input.value)); show(); pushParams(); requestSolve(); };
  reset.onclick = toAuto; lab.ondblclick = toAuto;
  (parent || mod.body).append(row);
  rows[key] = r; mod.rows.push(r);
  show();
  return r;
}

function buildUI(auto) {
  const g = $('groups'); g.innerHTML = ''; mods.length = 0;
  for (const k of Object.keys(rows)) delete rows[k];
  // dynamic bells first: they are the per-song part
  const md = makeModule(g, MODS.dyn, tr('ダイナミックEQ', 'Dynamic EQ'));
  for (const d of cur.dyn) {
    const a = start.dyn.find((x) => x.id === d.id);
    const k = a.fast ? 'fast' : 'depth'; // the hi-hat band's amount is its jump detector
    fader(md, 'dyn:' + d.id, d.label, 0, 6, 0.1, 'dB', () => d[k], (v) => { d[k] = v; }, a[k], { dyn: d });
  }
  for (const [title, defs] of GROUPS) {
    const meta = MODS[title] || { color: '#858d9e', sub: '' };
    const mod = makeModule(g, meta, title);
    if (title === GROUPS[1][0]) { buildEq(mod, defs); continue; }
    for (const [key, label, min, max, step, unit, log] of defs) {
      fader(mod, key, label, min, max, step, unit, () => cur[key], (v) => { cur[key] = v; }, start[key], { log });
    }
  }
  $('reasons').innerHTML = auto.reasons.map((r) => `<li>${r.text} <span class="k">${r.key}</span></li>`).join('');
  const dcs = auto.decisions;
  const flags = [dcs.is808 && '808', dcs.ballad && tr('バラード', 'ballad'), dcs.brightSource && tr('明るい音源', 'bright source'), dcs.veryDark && tr('暗い音源', 'dark source'),
    dcs.sparseDrums && tr('ドラム少なめ', 'sparse drums'), dcs.movingBass && tr('ベース音程大', 'moving bass')].filter(Boolean);
  $('diag').innerHTML = `${tr('元音源', 'Source')} ${diag.lufs.toFixed(1)} LUFS / ${diag.truePeakDb.toFixed(1)} dBTP / ${tr('クレスト', 'crest')} ${diag.crestDb.toFixed(1)} dB / LRA ${diag.lra.toFixed(1)}<br>`
    + `BPM ${dcs.bpm} / ${tr('低域÷高域', 'low÷high')} ${diag.lowHighRatioDb.toFixed(1)} dB / ${tr('ベース', 'bass')} f0 ${diag.bassProfile.f0p10}–${diag.bassProfile.f0p90} Hz<br>`
    + `${tr('判定', 'Flags')}: ${flags.join(tr('・', ', ')) || tr('標準', 'standard')}`;
  refreshPresets();
}

const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f < 10000 ? 2 : 1)}k` : `${Math.round(f)}`) + 'Hz';
// manual EQ: the graph + band tabs, with the selected band's three faders below
function buildEq(mod, defs) {
  const cv = document.createElement('canvas'); cv.className = 'eqg';
  const tabs = document.createElement('div'); tabs.className = 'btabs';
  mod.body.classList.add('eqbody');
  mod.body.append(cv, tabs);
  const groups = [];
  for (let k = 1; k <= 4; k++) {
    const t = document.createElement('button'); t.style.setProperty('--bc', BAND_COL[k - 1]);
    t.onclick = () => eqGraph.select(k);
    tabs.append(t);
    const box = document.createElement('div'); box.className = 'bfaders';
    mod.body.append(box);
    for (const [key, label, min, max, step, unit, log] of defs.filter((d) => d[0].startsWith(`eq${k}`))) {
      fader(mod, key, label.replace(/^(バンド\d |Band \d )/, ''), min, max, step, unit, () => cur[key], (v) => { cur[key] = v; }, start[key], { log, parent: box });
    }
    groups.push({ t, box, k });
  }
  const sync = (sel) => {
    for (const { t, box, k } of groups) {
      box.classList.toggle('hidden', k !== sel); t.classList.toggle('on', k === sel);
      const db = cur[`eq${k}Db`];
      t.innerHTML = `<b>${k}</b> ${fmtHz(cur[`eq${k}Hz`])} <span>${db > 0 ? '+' : ''}${db.toFixed(1)} dB</span>`;
    }
  };
  const prev = eqGraph?.sel || 1;
  eqGraph = new EqGraph(cv, {
    chain: eqChain,
    get: (k) => cur[k],
    begin: snapshot,
    change: (k, v) => { cur[k] = v; rows[k].input.value = rows[k].toPos(v); rows[k].show(); pushParams(); requestSolve(); sync(eqGraph.sel); eqGraph.draw(); },
    select: sync,
  });
  eqGraph.sel = prev; eqGraph.sync = () => sync(eqGraph.sel);
  sync(prev);
}

function refreshUI() {
  for (const r of Object.values(rows)) {
    r.input.value = r.toPos(r.get());
    if (r.cb) r.cb.checked = r.dyn.on;
    r.show();
  }
  for (const m of mods) updMod(m);
  if (eqGraph) { eqGraph.sync(); eqGraph.draw(); }
}

// ------------------------------------------------------------------ spice menu + undo
let spiceLv = {}, spiceStack = {}, genre = null, history = []; // genre: { id, done }
function snapshot() {
  history.push(structuredClone({ cur, spiceLv, spiceStack, genre }));
  if (history.length > 60) history.shift();
  $('undo').disabled = false;
}
function undo() {
  const h = history.pop(); if (!h) return;
  ({ cur, spiceLv, spiceStack, genre } = h);
  buildUI(lastAuto); renderSpices(); pushParams(); requestSolve();
  spiceMsg(tr('1つ前に戻しました', 'Undone'));
  $('undo').disabled = !history.length;
}
function spiceMsg(t) { $('spiceMsg').textContent = t; }
// spiceLv: axis id -> -3..+3, fix id -> 0..3. spiceStack[id]: applied deltas of the current side.
const AXIS = Object.fromEntries(AXES.map((x) => [x.id, x]));
const FIX = Object.fromEntries(FIXES.map((x) => [x.id, x]));
const ctxOf = () => ({ diag, dec: lastAuto.decisions, p: cur });
function popStep(id) {
  const done = spiceStack[id].pop();
  spiceLv[id] -= Math.sign(spiceLv[id]);
  return applyDeltas(cur, done, -1);
}
function pushStep(id, side, dir) {
  const done = applyDeltas(cur, side.step(ctxOf()));
  (spiceStack[id] ||= []).push(done);
  spiceLv[id] = (spiceLv[id] || 0) + dir;
  return done;
}
function afterSpice(msg) { refreshUI(); renderSpices(); pushParams(); requestSolve(); spiceMsg(msg); }
function tapAxis(id, dir) {
  const ax = AXIS[id], lv = spiceLv[id] || 0, side = dir > 0 ? ax.right : ax.left;
  if (lv * dir >= MAX_LEVEL) { spiceMsg(tr(`「${side.label}」はこれ以上強くできません。もっと欲しいときは CUSTOM で`, `"${side.label}" is at maximum. Use CUSTOM for more`)); return; }
  snapshot();
  if (lv * dir < 0) {
    const back = dir > 0 ? ax.left : ax.right;
    const done = popStep(id);
    afterSpice(tr(`${ax.title}: 「${back.label}」を1段戻しました（${describe(done, cur)}）`, `${ax.title}: "${back.label}" one step back (${describe(done, cur)})`));
  } else {
    const done = pushStep(id, side, dir);
    afterSpice(`${ax.title}: ${side.label}${tr(`（${Math.abs(spiceLv[id])}段目）`, ` (step ${Math.abs(spiceLv[id])})`)}… ${describe(done, cur) || tr('変化なし（スライダーが上限です）', 'no change (sliders at their limit)')}
${tr('聴くポイント', 'Listen for')}: ${side.listen}`);
  }
}
function tapFix(id) {
  const fx = FIX[id];
  if ((spiceLv[id] || 0) >= MAX_LEVEL) { spiceMsg(tr(`「${fx.label}」はこれ以上強くできません`, `"${fx.label}" is at maximum`)); return; }
  snapshot();
  const done = pushStep(id, fx, 1);
  afterSpice(`${fx.label}${tr(`（${spiceLv[id]}段目）`, ` (step ${spiceLv[id]})`)}… ${describe(done, cur) || tr('変化なし（スライダーが上限です）', 'no change (sliders at their limit)')}
${tr('聴くポイント', 'Listen for')}: ${fx.listen}`);
}
function clearSpice(id) {
  snapshot();
  while (spiceLv[id]) popStep(id);
  afterSpice(tr('解除しました', 'Removed'));
}
// Genre: a base layer under the spices. Switching removes the previous genre's exact deltas first.
function pickGenre(id) {
  snapshot();
  if (genre) applyDeltas(cur, genre.done, -1);
  const g = GENRES.find((x) => x.id === id);
  if (!g || genre?.id === id) { genre = null; return afterSpice(tr('ジャンルを外しました（自動設定＋スパイスのまま）', 'Genre removed (auto settings + spices kept)')); }
  const { deltas, notes } = genreDeltas(g, ctxOf());
  genre = { id, done: applyDeltas(cur, deltas) };
  afterSpice(`${tr('ジャンル', 'Genre')}: ${g.label} … ${describe(genre.done, cur) || tr('変化なし', 'no change')}\n${notes.join(' / ')}`);
}
function renderGenres() {
  const guess = guessGenre(diag, lastAuto.decisions);
  const box = $('genres');
  box.innerHTML = tr('<p class="rh">ジャンルに寄せる<small>この曲の分析結果とジャンルの目安の差から調整量を決めます。★ は分析からの推定。もう一度押すと外れます</small></p>', '<p class="rh">Lean toward a genre<small>The amount is set from how far this song is from the genre reference. ★ = guessed from the analysis. Tap again to remove</small></p>');
  const grid = document.createElement('div'); grid.className = 'genreGrid';
  for (const g of GENRES) {
    const b = document.createElement('button');
    b.className = 'side' + (genre?.id === g.id ? ' on' : '') + (g.id === guess ? ' rec' : '');
    b.innerHTML = `${g.id === guess ? '★' : ''}${g.label}<small>${g.hint}<br>${tr(`${g.use}に・${g.lufs} LUFS`, `${g.use} · ${g.lufs} LUFS`)}</small>`;
    b.onclick = () => pickGenre(g.id);
    grid.append(b);
  }
  box.append(grid);
}
function renderSpices() {
  renderGenres();
  const recs = recommend(diag, lastAuto.decisions);
  const recLabel = (r) => (r.fix ? FIX[r.fix].label : (r.dir > 0 ? AXIS[r.axis].right : AXIS[r.axis].left).label);
  const box0 = $('recs'); box0.innerHTML = '';
  if (!recs.length) box0.innerHTML = tr('<p>自動設定でバランスは取れています。気になるところだけ下のボタンで調整してください</p>', '<p>The auto settings are already balanced. Use the buttons below only for what bothers you</p>');
  else {
    box0.innerHTML = tr('<p class="rh">この曲へのおすすめ<small>押すと1段かかります。A/B で聴き比べて、好みでなければ「↶ 元に戻す」</small></p>', '<p class="rh">Suggestions for this song<small>Each tap adds one step. Compare with A/B and use "↶ Undo" if you don\'t like it</small></p>');
    for (const r of recs) {
      const applied = r.fix ? (spiceLv[r.fix] || 0) > 0 : (spiceLv[r.axis] || 0) * r.dir > 0;
      const row = document.createElement('div'); row.className = 'recrow';
      const b = Object.assign(document.createElement('button'), { className: applied ? 'on' : '' });
      b.textContent = applied ? tr(`✓ 「${recLabel(r)}」をかけ中（もう一度で強く）`, `✓ "${recLabel(r)}" on (tap again for more)`) : tr(`「${recLabel(r)}」を試す`, `Try "${recLabel(r)}"`);
      b.onclick = () => (r.fix ? tapFix(r.fix) : tapAxis(r.axis, r.dir));
      const t = document.createElement('span'); t.textContent = r.why;
      row.append(b, t); box0.append(row);
    }
  }
  const isRec = (axis, dir) => recs.some((r) => r.axis === axis && r.dir === dir);
  const box = $('spices'); box.innerHTML = tr('<h4>好みの方向 — ◀ ▶ でどちらかへ（最大3段）</h4>', '<h4>Your taste — push ◀ or ▶ (up to 3 steps)</h4>');
  for (const ax of AXES) {
    const lv = spiceLv[ax.id] || 0;
    const row = document.createElement('div'); row.className = 'axis';
    const btn = (side, dir) => {
      const b = document.createElement('button');
      b.className = 'side' + (lv * dir > 0 ? ' on' : '') + (isRec(ax.id, dir) ? ' rec' : '');
      b.innerHTML = dir < 0 ? `◀ ${isRec(ax.id, dir) ? '★' : ''}${side.label}<small>${side.hint}</small>`
        : `${isRec(ax.id, dir) ? '★' : ''}${side.label} ▶<small>${side.hint}</small>`;
      b.onclick = () => tapAxis(ax.id, dir);
      return b;
    };
    const mid = document.createElement('div'); mid.className = 'mid';
    const cells = [];
    for (let k = -MAX_LEVEL; k <= MAX_LEVEL; k++) if (k) cells.push(`<i class="${(k < 0 ? lv <= k : lv >= k) ? 'f' : ''}"></i>`);
    cells.splice(MAX_LEVEL, 0, '<b>|</b>');
    mid.innerHTML = `<span class="t">${ax.title}</span><span class="meter">${cells.join('')}</span>`;
    if (lv) { const x = Object.assign(document.createElement('button'), { className: 'x', textContent: tr('0 に戻す', 'Back to 0') }); x.onclick = () => clearSpice(ax.id); mid.append(x); }
    row.append(btn(ax.left, -1), mid, btn(ax.right, 1));
    box.append(row);
  }
  const fh = document.createElement('h4'); fh.textContent = tr('気になる所を直す — タップするたびに 弱 → 中 → 強（× で解除）', 'Fix what bothers you — each tap: light → medium → strong (× to remove)'); box.append(fh);
  const grid = document.createElement('div'); grid.className = 'fixes';
  for (const fx of FIXES) {
    const lv = spiceLv[fx.id] || 0, rec = recs.some((r) => r.fix === fx.id);
    const card = document.createElement('div'); card.className = 'fix';
    const b = document.createElement('button');
    b.className = 'side' + (lv ? ' on' : '') + (rec ? ' rec' : '');
    const names = (LANG === 'ja' ? ['弱', '中', '強'] : ['Light', 'Med', 'Strong']).slice(0, MAX_LEVEL);
    const state = !lv ? tr('オフ・タップで弱', 'Off · tap for light') : lv >= MAX_LEVEL ? tr('最大（強）', 'Max (strong)') : tr(`${names[lv - 1]}・タップで${names[lv]}`, `${names[lv - 1]} · tap for ${names[lv]}`);
    b.innerHTML = `${rec ? '★' : ''}${fx.label}<small>${fx.hint}</small>`
      + `<span class="lv">${names.map((n, i) => `<i class="${i < lv ? 'f' : ''}">${n}</i>`).join('')}<em>${state}</em></span>`;
    b.onclick = () => tapFix(fx.id);
    card.append(b);
    if (lv) { const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: tr('解除', 'Remove') }); x.onclick = () => clearSpice(fx.id); card.append(x); }
    grid.append(card);
  }
  box.append(grid);
}
function setValues(src, keys) {
  for (const k of keys) if (k in src) { cur[k] = src[k]; if (rows[k]) rows[k].input.value = src[k]; }
  refreshUI(); pushParams(); requestSolve();
}

// ------------------------------------------------------------------ presets / preferences
function refreshPresets() {
  const ps = store.get('am5.presets', {});
  $('presetSel').innerHTML = `<option value="">${tr('プリセット…', 'Presets…')}</option>` + Object.keys(ps).map((n) => `<option>${n}</option>`).join('');
}
$('presetSave').onclick = () => {
  const name = $('presetName').value.trim();
  if (!name) { $('presetName').focus(); return; }
  const ps = store.get('am5.presets', {});
  // song-specific values (bell frequencies, input trim) are left out
  ps[name] = Object.fromEntries(SLIDER_KEYS.filter((k) => !['lowHz', 'mudHz'].includes(k)).map((k) => [k, cur[k]]));
  ps[name].off = { ...cur.off };
  store.set('am5.presets', ps); refreshPresets(); $('presetSel').value = name; $('presetName').value = '';
  spiceMsg(tr(`プリセット「${name}」を保存しました`, `Preset "${name}" saved`));
};
$('presetName').onkeydown = (e) => { if (e.key === 'Enter') $('presetSave').click(); };
$('presetLoad').onclick = () => { const n = $('presetSel').value, p = store.get('am5.presets', {})[n]; if (!p) return; snapshot(); cur.off = { ...p.off }; setValues(p, Object.keys(p).filter((k) => k !== 'off')); spiceMsg(tr(`プリセット「${n}」を読み込みました`, `Preset "${n}" loaded`)); };
$('presetDel').onclick = () => { const ps = store.get('am5.presets', {}); delete ps[$('presetSel').value]; store.set('am5.presets', ps); refreshPresets(); };
$('forget').onclick = () => { if (confirm(tr('学習した好みをリセットしますか？', 'Reset the learned preferences?'))) { store.set('am5.prefs', {}); status(tr('好みの学習をリセットしました', 'Learned preferences reset')); } };
$('allOff').onclick = () => { snapshot(); setOff(MOD_IDS, true); spiceMsg(tr('すべてバイパスしました。使うモジュールだけスイッチでONにしてください', 'Everything bypassed. Switch on only the modules you want')); };
$('allOn').onclick = () => { snapshot(); setOff(MOD_IDS, false); spiceMsg(tr('すべてのモジュールをONにしました', 'All modules on')); };
$('resetAll').onclick = () => {
  snapshot(); cur = structuredClone(start); spiceLv = {}; spiceStack = {}; genre = null;
  buildUI(lastAuto); renderSpices(); pushParams(); requestSolve(); spiceMsg(tr('自動設定に戻しました', 'Back to auto settings'));
};
$('undo').onclick = undo;

// ------------------------------------------------------------------ export
function exportAs(format) {
  if (solveBusy) { status(tr('調整の完了を待ってから書き出してください', 'Wait for adjustment to finish before exporting')); return; }
  exportFormat = format;
  if ($('learn').checked) store.set('am5.prefs', learnPrefs(store.get('am5.prefs', {}), rawAuto, cur));
  status(tr('書き出し中…', 'Exporting…'));
  worker.postMessage({ type: 'render', params: cur, format, fs: +$('expRate').value });
}
$('expRate').value = store.get('am5.expRate', 44100);
for (const r of document.querySelectorAll('[name=expRate]')) {
  r.checked = r.value === $('expRate').value;
  r.onchange = () => { $('expRate').value = r.value; store.set('am5.expRate', +r.value); };
}
// deck popovers (presets / export); on phones they hang just below the button, full width
// (the deck's backdrop-filter makes it the containing block of position: fixed, so the offset is deck-relative)
const POPS = { presetBtn: 'presetPop', expBtn: 'expPop' };
for (const [b, p] of Object.entries(POPS)) {
  $(b).onclick = (e) => {
    e.stopPropagation();
    const open = $(p).classList.contains('hidden');
    for (const q of Object.values(POPS)) $(q).classList.add('hidden');
    if (open) { $(p).style.setProperty('--pop-top', `${$(b).getBoundingClientRect().bottom - $('deck').getBoundingClientRect().top + 8}px`); $(p).classList.remove('hidden'); }
  };
}
document.addEventListener('click', (e) => { for (const q of Object.values(POPS)) if (!$(q).contains(e.target)) $(q).classList.add('hidden'); });
$('learn').checked = store.get('am5.learn', true);
$('learn').onchange = () => store.set('am5.learn', $('learn').checked);
document.querySelectorAll('[data-export]').forEach((b) => { b.onclick = () => { $('expPop').classList.add('hidden'); exportAs(b.dataset.export); }; });

function saveExport(L, R, format, fs) {
  let blob, ext;
  if (format === 'mp3') { blob = encodeMp3(L, R, fs); ext = 'mp3'; } else { blob = encodeWav(L, R, format === 'wav24' ? 24 : 16, fs); ext = 'wav'; }
  if (!blob) return;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${fileName}_master_${fs === 48000 ? '48k' : '44k'}.${ext}` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function encodeWav(L, R, bits, fs) {
  const n = L.length, bps = bits / 8, size = n * 2 * bps;
  const buf = new ArrayBuffer(44 + size), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + size, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, fs, true);
  v.setUint32(28, fs * 2 * bps, true); v.setUint16(32, 2 * bps, true); v.setUint16(34, bits, true);
  w(36, 'data'); v.setUint32(40, size, true);
  let o = 44;
  const full = bits === 16 ? 32767 : 8388607;
  for (let i = 0; i < n; i++) {
    for (const x of [L[i], R[i]]) {
      // TPDF dither (1 LSB) on 16-bit
      let s = Math.round(x * full + (bits === 16 ? Math.random() - Math.random() : 0));
      s = Math.max(-full - 1, Math.min(full, s));
      if (bits === 16) { v.setInt16(o, s, true); o += 2; } else { v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3; }
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function encodeMp3(L, R, fs) {
  if (!window.lamejs) { status(tr('MP3 エンコーダ（lamejs）が読み込めませんでした', 'Could not load the MP3 encoder (lamejs)')); return null; }
  const enc = new lamejs.Mp3Encoder(2, fs, 320), chunks = [], B = 1152;
  const toI16 = (a, s, e) => { const o = new Int16Array(e - s); for (let i = s; i < e; i++) { const x = Math.max(-1, Math.min(1, a[i])); o[i - s] = x < 0 ? x * 32768 : x * 32767; } return o; };
  for (let i = 0; i < L.length; i += B) {
    const e = Math.min(L.length, i + B), d = enc.encodeBuffer(toI16(L, i, e), toI16(R, i, e));
    if (d.length) chunks.push(new Uint8Array(d));
  }
  const f = enc.flush(); if (f.length) chunks.push(new Uint8Array(f));
  return new Blob(chunks, { type: 'audio/mpeg' });
}

// ------------------------------------------------------------------ events
$('file').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
$('open').onclick = $('open2').onclick = () => $('file').click();
// drop a file anywhere on the page
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('over'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('over'); });
document.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
for (const t of document.querySelectorAll('.tab')) {
  t.onclick = () => {
    for (const u of document.querySelectorAll('.tab')) { u.classList.toggle('on', u === t); $('tab-' + u.dataset.tab).classList.toggle('hidden', u !== t); }
  };
}
$('play').onclick = () => setPlaying(!playing);
$('ab').onclick = toggleAB;
$('pos').oninput = () => { seeking = true; $('pos').style.setProperty('--p', $('pos').value * 100 + '%'); $('time').textContent = `${fmtT($('pos').value * duration)} / ${fmtT(duration)}`; };
$('pos').onchange = () => { seeking = false; node.port.postMessage({ type: 'seek', pos: $('pos').value * duration }); };
$('lock').onchange = requestSolve;
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (!cur) return;
  if (e.key === 'b' || e.key === 'B') toggleAB();
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
  if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
});

// Static page text is written in Japanese in index.html; swap it for English here.
function translateStatic() {
  document.documentElement.lang = LANG;
  const sw = $('langSw');
  sw.textContent = LANG === 'ja' ? 'EN' : '日本語';
  sw.title = LANG === 'ja' ? 'Switch to English' : '日本語に切り替え';
  sw.onclick = () => setLang(LANG === 'ja' ? 'en' : 'ja');
  if (LANG === 'ja') return;
  const EN = {
    'サイト': 'Site', '曲を読み込んでください': 'Load a song', '曲を開く': 'Open a song', '開く': 'Open',
    'プリセットと好みの学習': 'Presets and taste learning', 'プリセット': 'Presets', '保存したプリセット…': 'Saved presets…',
    '読込': 'Load', '選んだプリセットを削除': 'Delete the selected preset', '削除': 'Delete',
    '今の設定に名前を付けて保存': 'Name and save the current settings', '保存': 'Save', '好みの学習': 'Taste learning',
    '書き出し時に好みを学習して、次の曲の自動設定に反映': 'Learn my taste on export and apply it to the next song',
    '学習をリセット': 'Reset learning', '書き出し': 'Export', 'サンプルレート': 'Sample rate', '形式': 'Format',
    'CD・配信向け（ディザあり）': 'For CD / streaming (dithered)', '高音質で保存': 'High-resolution master', '320kbps・共有用': '320 kbps · for sharing',
    '再生／停止（Space）': 'Play / stop (Space)', '再生／停止': 'Play / stop', '加工前の音と比べる（B キー）': 'Compare with the original (B key)',
    'マスター': 'Master', '原音': 'Original', '再生位置': 'Position', 'スライダーを動かしても音量を目標 LUFS に保つ': 'Keep the loudness at the target LUFS while you move sliders',
    'ラウドネス固定': 'Loudness lock', 'LUFS固定': 'LUFS lock', '周波数スペクトル（カーソルで周波数を表示）': 'Spectrum (hover to read the frequency)',
    '曲をドロップして開始': 'Drop a song to start', '自動で解析して、この曲に合ったマスタリングを設定します': 'It analyses the song and sets up a mastering that suits it',
    'ファイルを選ぶ': 'Choose a file', 'WAV / MP3 / FLAC など · 処理はすべてブラウザ内で行われます': 'WAV / MP3 / FLAC etc. · everything runs in your browser',
    '以前のバージョン（AetherMaster Classic）はこちら →': 'Previous version (AetherMaster Classic) →', 'モード': 'Mode',
    'おまかせで仕上げる': 'Let it finish for you', 'すべて自分で追い込む': 'Fine-tune everything yourself',
    'すべて解析直後の自動設定に戻す': 'Reset everything to the auto settings', '↺ リセット': '↺ Reset',
    'この曲の解析結果と、自動設定の理由': 'Analysis of this song and why it was set this way', '診断': 'Diagnosis', '自動設定の理由': 'Why these settings',
    '全モジュールを素通しにして、ゼロから自分で組む（音量合わせのリミッターだけ残ります）': 'Bypass every module and build from scratch (only the loudness limiter stays)',
    'すべてバイパス': 'Bypass all', 'すべてON': 'All on', '↶ 元に戻す': '↶ Undo',
    '使い方ガイド': "User's guide", '技術仕様': 'Technical spec',
    'AetherMaster のプログラム（JavaScript・HTML・CSS）、信号処理アルゴリズム、自動設定のルールの著作権は Sonografica に帰属します。許可のない複製・改変・再配布・転載を禁じます。':
      'The AetherMaster program code (JavaScript, HTML, CSS), its signal-processing algorithms and its auto-setting rules are copyright Sonografica. Copying, modifying, redistributing or republishing them without permission is prohibited.',
    '第三者ソフトウェア: lamejs 1.2.1（MP3 エンコード, LGPL-3.0）、フォント Inter / JetBrains Mono（SIL OFL 1.1）': 'Third-party software: lamejs 1.2.1 (MP3 encoding, LGPL-3.0); fonts Inter and JetBrains Mono (SIL OFL 1.1)',
  };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) { const k = n.nodeValue.trim(); if (EN[k]) n.nodeValue = n.nodeValue.replace(k, EN[k]); }
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]'))
    for (const a of ['title', 'placeholder', 'aria-label']) { const v = el.getAttribute(a); if (v && EN[v]) el.setAttribute(a, EN[v]); }
  document.querySelector('.rackhelp').innerHTML = 'Changes are heard immediately. <span class="tk"></span> marks the auto position. <b>↺</b> or double-clicking a label resets to auto. Each module\'s <b>ON/OFF</b> switch bypasses it';
}
