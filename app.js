// UI: decode -> worker (analyze / auto / loudness lock / export) + worklet (live preview).
import { learnPrefs } from './engine/prescribe.js';
import { GROUPS } from './engine/controls.js';
import { MasterChain } from './engine/chain.js';
import { Spectrum } from './spectrum.js';
import { EqGraph, BAND_COL } from './eqgraph.js';
import { AXES, FIXES, MAX_LEVEL, recommend, applyDeltas, describe } from './engine/spices.js';
import { GENRES, guessGenre, genreDeltas } from './engine/genres.js';

const FS = 44100;
const $ = (id) => document.getElementById(id);

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
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => onWorker(e.data);
}

async function loadFile(file) {
  await ensureAudio();
  setReady(false); // no playback until analysis is done (otherwise the raw file sounds like the master)
  fileName = file.name.replace(/\.[^.]+$/, '');
  status(`読み込み中: ${file.name}`);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  duration = buf.duration;
  node.port.postMessage({ type: 'load', L: L.slice(), R: R.slice() });
  worker.postMessage({ type: 'load', L: L.slice(), R: R.slice(), fs: FS, prefs: store.get('am5.prefs', {}) });
  status('解析中…');
}

// ------------------------------------------------------------------ worker
let solveBusy = false, solveQueued = false, solveTimer = 0, exportFormat = '';
function onWorker(m) {
  if (m.type === 'progress') return status(`${m.stage} ${Math.round(m.f * 100)}%`);
  if (m.type === 'error') { console.error(m.message); status('エラー: ' + m.message.split('\n')[0]); solveBusy = false; return; }
  if (m.type === 'analyzed') {
    diag = m.diag; lastAuto = m.auto; rawAuto = m.auto.params; start = { ...m.params, off: {} }; cur = structuredClone(start);
    spiceLv = {}; spiceStack = {}; genre = null; history = []; $('undo').disabled = true;
    buildUI(m.auto); renderSpices(); spiceMsg('');
    spec.setLtas(m.ltas);
    pushParams();
    for (const id of ['main', 'transport', 'viz', 'expGroup', 'presetWrap']) $(id).classList.remove('hidden');
    $('drop').classList.add('hidden');
    setReady(true);
    status(`${fileName} — 準備完了`);
  } else if (m.type === 'solved') {
    solveBusy = false;
    cur.driveDb = m.params.driveDb;
    spec.setLtas(m.ltas);
    cur.punchMakeupDb = m.params.punchMakeupDb;
    for (const d of cur.dyn) { const s = m.params.dyn.find((x) => x.id === d.id); if (s) d.thr = s.thr; }
    pushParams();
    if (solveQueued) { solveQueued = false; sendSolve(); } else $('solving').textContent = '';
  } else if (m.type === 'rendered') {
    $('qc').textContent = `書き出し: ${m.fs / 1000} kHz / ${m.qc.lufs} LUFS / ${m.qc.truePeakDb} dBTP`;
    saveExport(m.L, m.R, exportFormat, m.fs);
    status(`${fileName} — 書き出し完了`);
  }
}
function requestSolve() {
  clearTimeout(solveTimer);
  $('solving').textContent = '調整中…';
  solveTimer = setTimeout(() => (solveBusy ? (solveQueued = true) : sendSolve()), 300);
}
function sendSolve() {
  solveBusy = true;
  $('solving').textContent = $('lock').checked ? 'ラウドネス合わせ中…' : '調整中…';
  worker.postMessage({ type: 'solve', params: cur, lockLoudness: $('lock').checked });
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
  $('play').textContent = on ? '❚❚' : '▶';
}
function sendBypass() {
  // plain bypass: the untouched source at its original level
  node.port.postMessage({ type: 'bypass', on: bypass, gainDb: 0 });
}
function toggleAB() {
  bypass = !bypass;
  $('ab').classList.toggle('ab-on', bypass);
  spec.bypass = bypass;
  $('ab').textContent = bypass ? 'B 原音' : 'A/B';
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
  $('mTarget').textContent = bypass ? '原音を再生中' : `目標 ${cur.targetLufs.toFixed(1)} LUFS`;
  (cur?.dyn || []).forEach((d, i) => {
    const el = rows['dyn:' + d.id]?.gr; if (!el) return;
    el.firstChild.style.width = pct(m.dyn[i], 6); el.title = m.dyn[i] > 0.05 ? `今 -${m.dyn[i].toFixed(1)} dB` : '';
  });
  for (const [k, v] of [['glue', m.glue], ['limiter', m.limiter]]) {
    const mm = modMeters[k]; if (!mm) continue;
    mm.bar.style.width = pct(Math.abs(v), 8); mm.val.textContent = gr(v);
  }
}

// ------------------------------------------------------------------ UI
function status(t) { $('status').textContent = t; }

// ------------------------------------------------------------------ detail rack
// Each module is a card with its own colour, a live meter where there is one, and a reset.
const MODS = {
  dyn: { id: 'dyn', color: '#ff6b9a', sub: '大きい瞬間だけ効くEQ。赤いバーが今効いている量' },
  'トーン': { id: 'tone', color: '#62d98b', sub: '曲全体の音色（常にかかるEQ）' },
  '手動EQ（特定の帯域を削る・足す）': { id: 'eq', title: '手動EQ', color: '#c58bff', sub: '特定の帯域をピンポイントで削る・足す', wide: true },
  'パンチ': { id: 'punch', color: '#ff8a5b', sub: 'キックとベースの立ち上がり' },
  'グルー': { id: 'glue', color: '#58c4ff', sub: '全体をまとめるコンプ', meter: 'glue' },
  'カラー／空間': { id: 'color', color: '#f6d365', sub: 'テープの温かさと響き' },
  'ステレオ': { id: 'stereo', color: '#7ee0d0', sub: '広がりと真ん中の存在感' },
  'ラウドネス': { color: '#ffb03b', sub: '目標の音量に合わせるリミッター', meter: 'limiter' },
};
const modMeters = {}; // 'glue' | 'limiter' -> { bar, val }
const mods = []; // built modules, for power / dirty refresh
let eqGraph = null;

function makeModule(parent, meta, fallbackTitle) {
  const el = document.createElement('section');
  el.className = 'mod' + (meta.wide ? ' wide' : '');
  el.style.setProperty('--mc', meta.color);
  el.innerHTML = `<header>${meta.id ? '<button class="pwr" role="switch" title="このモジュールをON／OFF（OFFで素通し）"></button>' : '<i class="led"></i>'}<div class="mt"><b>${meta.title || fallbackTitle}</b><small>${meta.sub}</small></div>`
    + (meta.meter ? '<div class="mm"><span class="k">GR</span><span class="bar"><i></i></span><span class="v">0.0</span></div>' : '')
    + '<button class="mreset" title="このモジュールをオートに戻す">↺ オート</button></header><div class="mbody"></div>';
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
    cb = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'sw', checked: dyn.on, title: 'オン／オフ' });
    cb.onchange = () => { snapshot(); dyn.on = cb.checked; show(); pushParams(); requestSolve(); };
    top.append(cb);
  }
  const lab = Object.assign(document.createElement('span'), { className: 'l', textContent: label, title: `${label}（ダブルクリックでオートに戻す）` });
  top.append(lab);
  if (dyn) { gr = document.createElement('span'); gr.className = 'grb'; gr.innerHTML = '<i></i>'; top.append(gr); }
  const reset = Object.assign(document.createElement('button'), { className: 'rs', textContent: '↺', title: `オートに戻す（${+(+autoVal).toFixed(2)}${unit}）` });
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
  const md = makeModule(g, MODS.dyn, 'ダイナミックEQ');
  for (const d of cur.dyn) {
    const a = start.dyn.find((x) => x.id === d.id);
    fader(md, 'dyn:' + d.id, d.label, 0, 6, 0.1, 'dB', () => d.depth, (v) => { d.depth = v; }, a.depth, { dyn: d });
  }
  for (const [title, defs] of GROUPS) {
    const meta = MODS[title] || { color: '#858d9e', sub: '' };
    const mod = makeModule(g, meta, title);
    if (title.startsWith('手動EQ')) { buildEq(mod, defs); continue; }
    for (const [key, label, min, max, step, unit, log] of defs) {
      fader(mod, key, label, min, max, step, unit, () => cur[key], (v) => { cur[key] = v; }, start[key], { log });
    }
  }
  $('reasons').innerHTML = auto.reasons.map((r) => `<li>${r.text} <span class="k">${r.key}</span></li>`).join('');
  const dcs = auto.decisions;
  const flags = [dcs.is808 && '808', dcs.ballad && 'バラード', dcs.brightSource && '明るい音源', dcs.veryDark && '暗い音源',
    dcs.sparseDrums && 'ドラム少なめ', dcs.movingBass && 'ベース音程大'].filter(Boolean);
  $('diag').innerHTML = `元音源 ${diag.lufs.toFixed(1)} LUFS / ${diag.truePeakDb.toFixed(1)} dBTP / クレスト ${diag.crestDb.toFixed(1)} dB / LRA ${diag.lra.toFixed(1)}<br>`
    + `BPM ${dcs.bpm} / 低域÷高域 ${diag.lowHighRatioDb.toFixed(1)} dB / ベース f0 ${diag.bassProfile.f0p10}–${diag.bassProfile.f0p90} Hz<br>`
    + `判定: ${flags.join('・') || '標準'}`;
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
      fader(mod, key, label.replace(/^バンド\d /, ''), min, max, step, unit, () => cur[key], (v) => { cur[key] = v; }, start[key], { log, parent: box });
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
  spiceMsg('1つ前に戻しました');
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
  if (lv * dir >= MAX_LEVEL) { spiceMsg(`「${side.label}」はこれ以上強くできません。もっと欲しいときは CUSTOM で`); return; }
  snapshot();
  if (lv * dir < 0) {
    const back = dir > 0 ? ax.left : ax.right;
    const done = popStep(id);
    afterSpice(`${ax.title}: 「${back.label}」を1段戻しました（${describe(done, cur)}）`);
  } else {
    const done = pushStep(id, side, dir);
    afterSpice(`${ax.title}: ${side.label}（${Math.abs(spiceLv[id])}段目）… ${describe(done, cur) || '変化なし（スライダーが上限です）'}
聴くポイント: ${side.listen}`);
  }
}
function tapFix(id) {
  const fx = FIX[id];
  if ((spiceLv[id] || 0) >= MAX_LEVEL) { spiceMsg(`「${fx.label}」はこれ以上強くできません`); return; }
  snapshot();
  const done = pushStep(id, fx, 1);
  afterSpice(`${fx.label}（${spiceLv[id]}段目）… ${describe(done, cur) || '変化なし（スライダーが上限です）'}
聴くポイント: ${fx.listen}`);
}
function clearSpice(id) {
  snapshot();
  while (spiceLv[id]) popStep(id);
  afterSpice('解除しました');
}
// Genre: a base layer under the spices. Switching removes the previous genre's exact deltas first.
function pickGenre(id) {
  snapshot();
  if (genre) applyDeltas(cur, genre.done, -1);
  const g = GENRES.find((x) => x.id === id);
  if (!g || genre?.id === id) { genre = null; return afterSpice('ジャンルを外しました（自動設定＋スパイスのまま）'); }
  const { deltas, notes } = genreDeltas(g, ctxOf());
  genre = { id, done: applyDeltas(cur, deltas) };
  afterSpice(`ジャンル: ${g.label} … ${describe(genre.done, cur) || '変化なし'}\n${notes.join(' / ')}`);
}
function renderGenres() {
  const guess = guessGenre(diag, lastAuto.decisions);
  const box = $('genres');
  box.innerHTML = '<p class="rh">ジャンルに寄せる<small>この曲の分析結果とジャンルの目安の差から調整量を決めます。★ は分析からの推定。もう一度押すと外れます</small></p>';
  const grid = document.createElement('div'); grid.className = 'genreGrid';
  for (const g of GENRES) {
    const b = document.createElement('button');
    b.className = 'side' + (genre?.id === g.id ? ' on' : '') + (g.id === guess ? ' rec' : '');
    b.innerHTML = `${g.id === guess ? '★' : ''}${g.label}<small>${g.hint}（${g.lufs} LUFS）</small>`;
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
  if (!recs.length) box0.innerHTML = '<p>自動設定でバランスは取れています。気になるところだけ下のボタンで調整してください</p>';
  else {
    box0.innerHTML = '<p class="rh">この曲へのおすすめ<small>押すと1段かかります。A/B で聴き比べて、好みでなければ「↶ 元に戻す」</small></p>';
    for (const r of recs) {
      const applied = r.fix ? (spiceLv[r.fix] || 0) > 0 : (spiceLv[r.axis] || 0) * r.dir > 0;
      const row = document.createElement('div'); row.className = 'recrow';
      const b = Object.assign(document.createElement('button'), { className: applied ? 'on' : '' });
      b.textContent = applied ? `✓ 「${recLabel(r)}」をかけ中（もう一度で強く）` : `「${recLabel(r)}」を試す`;
      b.onclick = () => (r.fix ? tapFix(r.fix) : tapAxis(r.axis, r.dir));
      const t = document.createElement('span'); t.textContent = r.why;
      row.append(b, t); box0.append(row);
    }
  }
  const isRec = (axis, dir) => recs.some((r) => r.axis === axis && r.dir === dir);
  const box = $('spices'); box.innerHTML = '<h4>好みの方向 — ◀ ▶ でどちらかへ（最大3段）</h4>';
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
    if (lv) { const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '0 に戻す' }); x.onclick = () => clearSpice(ax.id); mid.append(x); }
    row.append(btn(ax.left, -1), mid, btn(ax.right, 1));
    box.append(row);
  }
  const fh = document.createElement('h4'); fh.textContent = '気になる所を直す — タップするたびに 弱 → 中 → 強（× で解除）'; box.append(fh);
  const grid = document.createElement('div'); grid.className = 'fixes';
  for (const fx of FIXES) {
    const lv = spiceLv[fx.id] || 0, rec = recs.some((r) => r.fix === fx.id);
    const card = document.createElement('div'); card.className = 'fix';
    const b = document.createElement('button');
    b.className = 'side' + (lv ? ' on' : '') + (rec ? ' rec' : '');
    const names = ['弱', '中', '強'].slice(0, MAX_LEVEL);
    const state = !lv ? 'オフ・タップで弱' : lv >= MAX_LEVEL ? '最大（強）' : `${names[lv - 1]}・タップで${names[lv]}`;
    b.innerHTML = `${rec ? '★' : ''}${fx.label}<small>${fx.hint}</small>`
      + `<span class="lv">${names.map((n, i) => `<i class="${i < lv ? 'f' : ''}">${n}</i>`).join('')}<em>${state}</em></span>`;
    b.onclick = () => tapFix(fx.id);
    card.append(b);
    if (lv) { const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: '解除' }); x.onclick = () => clearSpice(fx.id); card.append(x); }
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
  $('presetSel').innerHTML = '<option value="">プリセット…</option>' + Object.keys(ps).map((n) => `<option>${n}</option>`).join('');
}
$('presetSave').onclick = () => {
  const name = prompt('プリセット名'); if (!name) return;
  const ps = store.get('am5.presets', {});
  // song-specific values (bell frequencies, input trim) are left out
  ps[name] = Object.fromEntries(SLIDER_KEYS.filter((k) => !['lowHz', 'mudHz'].includes(k)).map((k) => [k, cur[k]]));
  ps[name].off = { ...cur.off };
  store.set('am5.presets', ps); refreshPresets(); $('presetSel').value = name;
};
$('presetLoad').onclick = () => { const n = $('presetSel').value, p = store.get('am5.presets', {})[n]; if (!p) return; snapshot(); cur.off = { ...p.off }; setValues(p, Object.keys(p).filter((k) => k !== 'off')); spiceMsg(`プリセット「${n}」を読み込みました`); };
$('presetDel').onclick = () => { const ps = store.get('am5.presets', {}); delete ps[$('presetSel').value]; store.set('am5.presets', ps); refreshPresets(); };
$('forget').onclick = () => { if (confirm('学習した好みをリセットしますか？')) { store.set('am5.prefs', {}); status('好みの学習をリセットしました'); } };
$('allOff').onclick = () => { snapshot(); setOff(MOD_IDS, true); spiceMsg('すべてバイパスしました。使うモジュールだけスイッチでONにしてください'); };
$('allOn').onclick = () => { snapshot(); setOff(MOD_IDS, false); spiceMsg('すべてのモジュールをONにしました'); };
$('resetAll').onclick = () => {
  snapshot(); cur = structuredClone(start); spiceLv = {}; spiceStack = {}; genre = null;
  buildUI(lastAuto); renderSpices(); pushParams(); requestSolve(); spiceMsg('自動設定に戻しました');
};
$('undo').onclick = undo;

// ------------------------------------------------------------------ export
function exportAs(format) {
  if (solveBusy) { status('調整の完了を待ってから書き出してください'); return; }
  exportFormat = format;
  if ($('learn').checked) store.set('am5.prefs', learnPrefs(store.get('am5.prefs', {}), rawAuto, cur));
  status('書き出し中…');
  worker.postMessage({ type: 'render', params: cur, format, fs: +$('expRate').value });
}
$('expRate').value = store.get('am5.expRate', 44100);
$('expRate').onchange = () => store.set('am5.expRate', +$('expRate').value);
// presets popover in the deck
$('presetBtn').onclick = (e) => { e.stopPropagation(); $('presetPop').classList.toggle('hidden'); };
document.addEventListener('click', (e) => { if (!$('presetPop').contains(e.target)) $('presetPop').classList.add('hidden'); });
$('learn').checked = store.get('am5.learn', true);
$('learn').onchange = () => store.set('am5.learn', $('learn').checked);
document.querySelectorAll('[data-export]').forEach((b) => { b.onclick = () => exportAs(b.dataset.export); });

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
  if (!window.lamejs) { status('MP3 エンコーダ（lamejs）が読み込めませんでした'); return null; }
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
