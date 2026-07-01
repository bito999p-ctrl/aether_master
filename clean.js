import { bufferToWav } from './wav-exporter.js';

// ==========================================================================
// SYSTEM DIAGNOSTICS & LOGGER
// ==========================================================================
function logToUI(msg, type = 'info') {
  const logContainer = document.getElementById('debug-log');
  if (logContainer) {
    const line = document.createElement('div');
    line.style.color = type === 'error' ? '#ff0055' : type === 'warning' ? '#f77f00' : '#00f2fe';
    line.innerText = `[${new Date().toLocaleTimeString()}] [${type.toUpperCase()}] ${msg}`;
    logContainer.appendChild(line);
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

window.onerror = function(message, source, lineno, colno, error) {
  const file = source ? source.substring(source.lastIndexOf('/') + 1) : 'unknown';
  logToUI(`${message} (${file}:${lineno}:${colno})`, 'error');
  return false;
};

window.addEventListener('unhandledrejection', function(event) {
  logToUI(`Promise rejection: ${event.reason}`, 'error');
});

const originalConsoleError = console.error;
console.error = function(...args) {
  logToUI(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'error');
  originalConsoleError.apply(console, args);
};

// ==========================================================================
// STATE MANAGEMENT & GLOBALS
// ==========================================================================
let audioContext = null;
let audioBuffer = null;
let sourceNode = null;

// Playback state
let isPlaying = false;
let isLooping = false;
let isBypassed = false;
let isSeeking = false;
let startTime = 0;
let pausedAt = 0;
let playbackOffset = 0; // Current time position in track

// Downsampled peaks for waveform compare
let originalPeaks = null;
let cachedProcessedPeaks = null;
let baseLoudnessTarget = 'genre';
const PEAK_POINTS = 800;

// Web Audio API Nodes for active playback
let activeNodes = {
  inputGain: null,
  satDryGain: null,
  satWetGain: null,
  waveShaper: null,
  eqLow: null,
  kickPeaking: null,
  eqMid: null,
  eqHigh: null,
  eqCorrective1: null, // AI corrective EQ notch filter 1
  eqCorrective2: null, // AI corrective EQ notch filter 2
  eqCorrective3: null, // AI corrective EQ notch filter 3
  eqCorrective4: null, // AI corrective EQ notch filter 4
  eqCorrective5: null, // AI corrective EQ notch filter 5
  eqCorrective6: null, // AI corrective EQ notch filter 6
  eqCorrective7: null, // AI corrective EQ notch filter 7
  eqCorrective8: null, // AI corrective EQ notch filter 8
  compressor: null,
  midGain: null,
  sideGain: null,
  limiterGain: null,
  limiter: null,
  safetyClipper: null,
  ceilingGain: null,
  masteredOutGain: null,
  bypassGain: null,
  rumbleFilter: null,
  hissFilter: null,
  hissEnvelopeGain: null,
  
  // Analysers
  inputSplitter: null,
  inputAnalyserL: null,
  inputAnalyserR: null,
  outputSplitter: null,
  outputAnalyserL: null,
  outputAnalyserR: null,
  visualAnalyser: null
};

// Mastering Parameters
const params = {
  inputGainDb: 0.0,
  ceiling: -1.0,
  
  // AI Corrective Notches (up to 8)
  correctiveNotches: [
    { freq: 9000, gain: 0.0, q: 15.0, isBroad: false, enabled: false },
    { freq: 7500, gain: 0.0, q: 15.0, isBroad: false, enabled: false },
    { freq: 11000, gain: 0.0, q: 15.0, isBroad: false, enabled: false },
    { freq: 6500, gain: 0.0, q: 15.0, isBroad: false, enabled: false },
    { freq: 9500, gain: 0.0, q: 15.0, isBroad: false, enabled: false },
    { freq: 8000, gain: 0.0, q: 15.0, isBroad: false, enabled: false },
    { freq: 10500, gain: 0.0, q: 15.0, isBroad: false, enabled: false },
    { freq: 7000, gain: 0.0, q: 15.0, isBroad: false, enabled: false }
  ],
  
  // Saturator
  satEnabled: true,
  satType: 'tube',
  satDrive: 15,
  satMix: 30,
  
  // EQ
  eqLowGain: 1.0,
  eqLowFreq: 120,
  eqMidGain: -0.5,
  eqMidFreq: 1000,
  eqMidQ: 1.0,
  eqHighGain: 1.5,
  eqHighFreq: 10000,
  
  // Compressor
  compEnabled: true,
  compThreshold: -16.0,
  compRatio: 1.8,
  compAttack: 0.03, // 30ms
  compRelease: 0.15, // 150ms
  
  // Stereo Width
  stereoWidth: 1.20, // 120%
  sideHighPassFreq: 110,
  
  // Limiter/Maximizer
  limiterBoost: 4.0, // +4.0 dB
  
  // Noise Cleaner
  rumbleCutEnabled: false,
  hissReductionAmount: 0, // 0 to 100%
  sibilanceDynamicFreq: 0 // Detected sibilance frequency (0 if none)
};

// AI Suggested Parameters baseline (holds dynamically calculated parameters for the AUTO preset)
let aiSuggestedParams = null;
let aiDetectedGenre = null;

// Audio Spices State Configuration
const spices = {
  airTreble: false,
  kickPunch: false,
  stereoWider: false,
  vocalPresence: false,
  analogWarmth: false,
  loudnessPush: false
};

// Compute combined parameters (original sliders + spice offsets)
function getCombinedParams() {
  return {
    ...params,
    satEnabled: params.satEnabled || spices.analogWarmth,
    satDrive: Math.max(0, Math.min(100, params.satDrive + (spices.analogWarmth ? 15 : 0))),
    satMix: Math.max(0, Math.min(100, params.satMix + (spices.analogWarmth ? 18 : 0))),
    eqLowGain: params.eqLowGain, // No low shelf boost for kickPunch (prevents bass guitar mud)
    kickPeakingGain: spices.kickPunch ? 4.5 : 0.0, // Dedicated narrow 55Hz kick thump peaking boost
    eqMidGain: params.eqMidGain + (spices.vocalPresence ? 2.5 : 0.0),
    eqHighGain: params.eqHighGain + (spices.airTreble ? 3.0 : 0.0),
    compEnabled: params.compEnabled || spices.kickPunch,
    compThreshold: params.compThreshold, // No aggressive threshold lowering to prevent pumping
    compRatio: params.compRatio,         // Keep ratio natural and transparent
    compAttack: Math.max(0.001, Math.min(0.5, params.compAttack + (spices.kickPunch ? 0.030 : 0.0))), // Let transient punch pop out
    compRelease: params.compRelease,
    stereoWidth: Math.max(0.0, Math.min(2.0, params.stereoWidth + (spices.stereoWider ? 0.45 : 0.0))),
    limiterBoost: Math.max(0.0, Math.min(15.0, params.limiterBoost + (spices.loudnessPush ? 2.5 : 0.0)))
  };
}

// Genre Presets Configuration
export const GENRE_PRESETS = {
  auto: {
    satEnabled: true, satType: 'tube', satDrive: 12, satMix: 10,
    eqLowGain: 0.0, eqLowFreq: 90,
    eqMidGain: 0.0, eqMidFreq: 1000, eqMidQ: 1.0,
    eqHighGain: 0.0, eqHighFreq: 9000,
    compEnabled: true, compThreshold: -8.0, compRatio: 1.35, compAttack: 0.04, compRelease: 0.20,
    stereoWidth: 1.15, limiterBoost: 3.5, sideHighPassFreq: 110
  },
  pops: {
    satEnabled: true, satType: 'tube', satDrive: 15, satMix: 10,
    eqLowGain: 1.5, eqLowFreq: 100,
    eqMidGain: 1.2, eqMidFreq: 1800, eqMidQ: 1.0,
    eqHighGain: 2.2, eqHighFreq: 12000,
    compEnabled: true, compThreshold: -8.0, compRatio: 1.35, compAttack: 0.035, compRelease: 0.16,
    stereoWidth: 1.22, limiterBoost: 4.2, sideHighPassFreq: 110
  },
  rnb: {
    satEnabled: true, satType: 'tape', satDrive: 15, satMix: 12,
    eqLowGain: 2.2, eqLowFreq: 75,
    eqMidGain: -0.8, eqMidFreq: 1000, eqMidQ: 1.0,
    eqHighGain: 2.0, eqHighFreq: 10000,
    compEnabled: true, compThreshold: -8.0, compRatio: 1.35, compAttack: 0.04, compRelease: 0.20,
    stereoWidth: 1.25, limiterBoost: 4.2, sideHighPassFreq: 110
  },
  rock: {
    satEnabled: true, satType: 'tape', satDrive: 22, satMix: 12,
    eqLowGain: 2.0, eqLowFreq: 90,
    eqMidGain: 1.5, eqMidFreq: 2800, eqMidQ: 1.2,
    eqHighGain: 1.5, eqHighFreq: 8000,
    compEnabled: true, compThreshold: -7.5, compRatio: 1.35, compAttack: 0.05, compRelease: 0.15,
    stereoWidth: 1.15, limiterBoost: 4.8, sideHighPassFreq: 110
  },
  metal: {
    satEnabled: true, satType: 'tape', satDrive: 25, satMix: 14,
    eqLowGain: 2.2, eqLowFreq: 85,
    eqMidGain: -1.8, eqMidFreq: 400, eqMidQ: 0.8,
    eqHighGain: 2.5, eqHighFreq: 8500,
    compEnabled: true, compThreshold: -7.5, compRatio: 1.40, compAttack: 0.02, compRelease: 0.10,
    stereoWidth: 1.28, limiterBoost: 5.2, sideHighPassFreq: 120
  },
  edm: {
    satEnabled: true, satType: 'tape', satDrive: 18, satMix: 20,
    eqLowGain: 1.8, eqLowFreq: 90,
    eqMidGain: -0.5, eqMidFreq: 800, eqMidQ: 1.0,
    eqHighGain: 2.0, eqHighFreq: 11000,
    compEnabled: true, compThreshold: -7.0, compRatio: 1.35, compAttack: 0.05, compRelease: 0.20, // Tamed attack (50ms) and ratio (1.35) to prevent bass cycles clipping/buzzing
    stereoWidth: 1.30, limiterBoost: 5.0, sideHighPassFreq: 150 // Slightly reduced limiter boost (5.0dB) for safer headroom
  },
  hiphop: {
    satEnabled: true, satType: 'tape', satDrive: 15, satMix: 14,
    eqLowGain: 1.8, eqLowFreq: 65,
    eqMidGain: -0.8, eqMidFreq: 350, eqMidQ: 1.0,
    eqHighGain: 1.2, eqHighFreq: 10000,
    compEnabled: true, compThreshold: -8.0, compRatio: 1.40, compAttack: 0.035, compRelease: 0.15,
    stereoWidth: 1.20, limiterBoost: 4.8, sideHighPassFreq: 150
  },
  lofi: {
    satEnabled: true, satType: 'tape', satDrive: 45, satMix: 30,
    eqLowGain: 3.5, eqLowFreq: 150,
    eqMidGain: 1.5, eqMidFreq: 1200, eqMidQ: 1.0,
    eqHighGain: -4.5, eqHighFreq: 7000,
    compEnabled: true, compThreshold: -10.0, compRatio: 1.5, compAttack: 0.06, compRelease: 0.30,
    stereoWidth: 0.92, limiterBoost: 3.2, sideHighPassFreq: 110
  },
  hardcore: {
    satEnabled: true, satType: 'hardcore', satDrive: 28, satMix: 22,
    eqLowGain: 3.0, eqLowFreq: 80,
    eqMidGain: -1.2, eqMidFreq: 800, eqMidQ: 1.0,
    eqHighGain: 3.0, eqHighFreq: 12000,
    compEnabled: true, compThreshold: -8.5, compRatio: 1.45, compAttack: 0.015, compRelease: 0.10,
    stereoWidth: 1.38, limiterBoost: 6.0, sideHighPassFreq: 150
  },
  ambient: {
    satEnabled: true, satType: 'tube', satDrive: 8, satMix: 6,
    eqLowGain: 2.0, eqLowFreq: 80,
    eqMidGain: 0.0, eqMidFreq: 1000, eqMidQ: 0.7,
    eqHighGain: 3.0, eqHighFreq: 12000,
    compEnabled: true, compThreshold: -6.0, compRatio: 1.2, compAttack: 0.12, compRelease: 0.40,
    stereoWidth: 1.55, limiterBoost: 2.2, sideHighPassFreq: 90
  },
  podcast: {
    satEnabled: true, satType: 'tube', satDrive: 5, satMix: 5,
    eqLowGain: -2.0, eqLowFreq: 120,
    eqMidGain: 1.2, eqMidFreq: 1600, eqMidQ: 1.0,
    eqHighGain: 0.8, eqHighFreq: 8000,
    compEnabled: true, compThreshold: -10.0, compRatio: 1.3, compAttack: 0.02, compRelease: 0.15,
    stereoWidth: 1.00, limiterBoost: 3.0, sideHighPassFreq: 150
  },
  classic: {
    satEnabled: false, satType: 'tube', satDrive: 0, satMix: 0,
    eqLowGain: 0.5, eqLowFreq: 100,
    eqMidGain: 0.0, eqMidFreq: 1000, eqMidQ: 0.7,
    eqHighGain: 0.5, eqHighFreq: 10000,
    compEnabled: true, compThreshold: -4.0, compRatio: 1.15, compAttack: 0.15, compRelease: 0.50,
    stereoWidth: 1.30, limiterBoost: 1.8, sideHighPassFreq: 90
  },
  jazz: {
    satEnabled: true, satType: 'tube', satDrive: 10, satMix: 8,
    eqLowGain: 1.2, eqLowFreq: 110,
    eqMidGain: 0.5, eqMidFreq: 1500, eqMidQ: 1.0,
    eqHighGain: 1.0, eqHighFreq: 10000,
    compEnabled: true, compThreshold: -7.5, compRatio: 1.25, compAttack: 0.06, compRelease: 0.25,
    stereoWidth: 1.20, limiterBoost: 2.8, sideHighPassFreq: 90
  },
  acoustic: {
    satEnabled: true, satType: 'tube', satDrive: 8, satMix: 8,
    eqLowGain: 1.0, eqLowFreq: 120,
    eqMidGain: 0.8, eqMidFreq: 2000, eqMidQ: 1.0,
    eqHighGain: 1.8, eqHighFreq: 11000,
    compEnabled: true, compThreshold: -7.5, compRatio: 1.25, compAttack: 0.045, compRelease: 0.22,
    stereoWidth: 1.25, limiterBoost: 3.0, sideHighPassFreq: 90
  }
};

// Loudness Targets
const LOUDNESS_TARGETS = {
  genre: { boost: null },     // Genre Default (follows selected preset)
  streaming: { boost: 4.0 },  // Standard Streaming -14 LUFS target
  club: { boost: 7.0 },       // Standard Club -9 LUFS target
  loud: { boost: 10.0 },      // Standard Heavy -7 LUFS target
  pure: { boost: 0.0 }        // High Dynamic Range -18 LUFS target
};

// Level meter decay values
let meterInPeakL = -60;
let meterInPeakR = -60;
let meterOutPeakL = -60;
let meterOutPeakR = -60;
let grPeak = 0;
let correlationValue = 1.0;

// Visualizer animation frame
let animFrameId = null;
let activeTab = 'spectrum'; // 'spectrum' or 'waveform'

// ==========================================================================
// SATURATOR CURVE GENERATOR
// ==========================================================================
function generateSaturatorCurve(type, drive) {
  const n_samples = 44100;
  const curve = new Float32Array(n_samples);
  
  if (type === 'tube') {
    // Asymmetric soft distortion (vacuum tube even harmonics)
    const k = 0.5 + (drive / 100) * 8.5; // range 0.5 to 9.0
    const offset = 0.12; // asymmetry offset
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      const x_off = x + offset;
      const y = Math.tanh(k * x_off);
      // Subtract DC offset to keep zero-crossing centered
      curve[i] = y - Math.tanh(k * offset);
    }
    
    // 範囲[-1.0, 1.0]に正規化し、デジタルクリッピングノイズを防ぐ
    let maxVal = 0;
    for (let i = 0; i < n_samples; ++i) {
      const absVal = Math.abs(curve[i]);
      if (absVal > maxVal) maxVal = absVal;
    }
    if (maxVal > 0) {
      for (let i = 0; i < n_samples; ++i) {
        curve[i] /= maxVal;
      }
    }
  } else if (type === 'tape') {
    // Symmetric soft clipping (analog tape odd harmonics)
    const k = 0.5 + (drive / 100) * 5.5; // range 0.5 to 6.0
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
  } else if (type === 'hardcore') {
    // Hard clipping / Overdrive
    const k = 1.0 + (drive / 100) * 14.0; // gain factor
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      const val = x * k;
      // Hard clamp with soft knee transition
      curve[i] = Math.max(-0.82, Math.min(0.82, val));
    }
  } else {
    // Linear (Bypass)
    for (let i = 0; i < n_samples; ++i) {
      curve[i] = (i * 2) / n_samples - 1;
    }
  }
  return curve;
}

function generateSoftClipCurve() {
  const n_samples = 44100;
  const curve = new Float32Array(n_samples);
  const threshold = 0.96; // Linear up to 0.96 amplitude (~ -0.35 dBFS) to prevent low-end intermodulation distortion
  for (let i = 0; i < n_samples; ++i) {
    const x = (i * 2) / n_samples - 1;
    const absX = Math.abs(x);
    if (absX <= threshold) {
      curve[i] = x;
    } else {
      const sign = Math.sign(x);
      const excess = (absX - threshold) / (1.0 - threshold);
      const y = threshold + (1.0 - threshold) * (-Math.pow(excess, 3) + Math.pow(excess, 2) + excess);
      curve[i] = sign * y;
    }
  }
  return curve;
}

function generateAbsoluteValCurve() {
  const n_samples = 1024;
  const curve = new Float32Array(n_samples);
  for (let i = 0; i < n_samples; ++i) {
    const x = (i * 2) / (n_samples - 1) - 1;
    curve[i] = Math.abs(x);
  }
  return curve;
}

// ==========================================================================
// SIGNAL CHAIN CREATION FUNCTION
// ==========================================================================
function setupMasteringChain(context, sourceNode, parameters, customDestination = null) {
  const dest = customDestination || context.destination;

  // 1. Input Gain Node
  const inputGainNode = context.createGain();
  inputGainNode.gain.setValueAtTime(Math.pow(10, parameters.inputGainDb / 20), context.currentTime);

  // Rumble Filter (HPF)
  const rumbleFilter = context.createBiquadFilter();
  rumbleFilter.type = 'highpass';
  rumbleFilter.frequency.setValueAtTime(parameters.rumbleCutEnabled ? 80.0 : 18.0, context.currentTime); // 18Hz subsonic filter when disabled, protecting deep sub-bass while removing DC offset/infrasound mud.
  rumbleFilter.Q.setValueAtTime(0.707, context.currentTime);

  // Dynamic Hiss Filter (VCF Lowpass)
  const hissFilter = context.createBiquadFilter();
  hissFilter.type = 'lowpass';
  
  const hissAmount = parameters.hissReductionAmount || 0;
  const baseFreq = 20000.0 - (16250.0 * (hissAmount / 100.0)); // Maps 80% to 7,000Hz and 100% to 3,750Hz (dynamic VCF cleans 8kHz/7.4kHz metallic noise at default 80% setting)
  hissFilter.frequency.setValueAtTime(baseFreq, context.currentTime);
  hissFilter.Q.setValueAtTime(0.5, context.currentTime); // Gentle slope

  // Sidechain Envelope Follower for Hiss Filter
  const sidechainHpf = context.createBiquadFilter();
  sidechainHpf.type = 'highpass';
  sidechainHpf.frequency.setValueAtTime(2000.0, context.currentTime); // Lowered to 2,000Hz to detect vocal/midrange energy and open the filter.
  sidechainHpf.Q.setValueAtTime(0.707, context.currentTime);

  const sidechainGainNode = context.createGain();
  sidechainGainNode.gain.setValueAtTime(10.0, context.currentTime); // Boost sidechain energy to generate robust envelope values during active music

  const rectifier = context.createWaveShaper();
  rectifier.curve = generateAbsoluteValCurve();

  const envelopeSmoother = context.createBiquadFilter();
  envelopeSmoother.type = 'lowpass';
  envelopeSmoother.frequency.setValueAtTime(2.0, context.currentTime); // Slowed down from 10Hz to 2Hz to smooth out dynamic filter sweeps and eliminate swirling/phasing artifacts on reverb tails and cheers.
  envelopeSmoother.Q.setValueAtTime(0.707, context.currentTime);

  const hissEnvelopeGain = context.createGain();
  // 高域ヒスノイズ（13kHz〜20kHz）が楽曲再生中も完全に消え去るよう、上限遮断周波数（天井）を制限
  const ceilFreq = 20000.0 - (7000.0 * (hissAmount / 100.0)); // hissAmount=100%で最大天井を13,000Hzに固定
  const maxEnvGain = Math.max(0, ceilFreq - baseFreq);
  hissEnvelopeGain.gain.setValueAtTime(maxEnvGain, context.currentTime);

  // 2. Parallel Saturator Stage
  const satDryGain = context.createGain();
  const satWetGain = context.createGain();
  const waveShaper = context.createWaveShaper();
  const satSumNode = context.createGain();

  // High-pass filter for Saturator Wet path to prevent low-end intermodulation mud (ボワボワ)
  const satHpf = context.createBiquadFilter();
  satHpf.type = 'highpass';
  satHpf.frequency.setValueAtTime(150.0, context.currentTime); // Cut sub-bass/bass saturation
  satHpf.Q.setValueAtTime(0.707, context.currentTime);

  waveShaper.curve = generateSaturatorCurve(parameters.satType, parameters.satDrive);
  waveShaper.oversample = 'none'; // フィルター遅延による位相干渉（コームフィルター）を防ぐため、オーバーサンプリングを無効化します。

  if (parameters.satEnabled) {
    const blend = parameters.satMix / 100;
    satDryGain.gain.setValueAtTime(1.0 - blend, context.currentTime);
    satWetGain.gain.setValueAtTime(blend, context.currentTime);
  } else {
    satDryGain.gain.setValueAtTime(1.0, context.currentTime);
    satWetGain.gain.setValueAtTime(0.0, context.currentTime);
  }

  // Hook up main signal path
  inputGainNode.connect(rumbleFilter);
  rumbleFilter.connect(hissFilter);
  
  hissFilter.connect(satDryGain);
  hissFilter.connect(satHpf);
  satHpf.connect(waveShaper); // Feed highpassed signal to waveshaper to keep low end clean
  waveShaper.connect(satWetGain);

  // Hook up sidechain envelope follower path (splits from rumbleFilter output)
  rumbleFilter.connect(sidechainHpf);
  sidechainHpf.connect(sidechainGainNode);
  sidechainGainNode.connect(rectifier);
  rectifier.connect(envelopeSmoother);
  envelopeSmoother.connect(hissEnvelopeGain);
  
  // Connect envelope gain modulator to hissFilter frequency AudioParam
  hissEnvelopeGain.connect(hissFilter.frequency);

  satDryGain.connect(satSumNode);
  satWetGain.connect(satSumNode);

  // 3. 3-Band Equalizer (Low Shelf, Mid Peaking, High Shelf)
  const eqLow = context.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.setValueAtTime(parameters.eqLowFreq, context.currentTime);
  eqLow.gain.setValueAtTime(parameters.eqLowGain, context.currentTime);

  // Dedicated Peaking Filter for Kick Punch (v3.30+)
  const kickPeaking = context.createBiquadFilter();
  kickPeaking.type = 'peaking';
  kickPeaking.Q.setValueAtTime(2.0, context.currentTime); // narrow Q to isolate kick drum
  kickPeaking.frequency.setValueAtTime(55, context.currentTime); // 55Hz fundamental thump
  kickPeaking.gain.setValueAtTime(parameters.kickPeakingGain || 0.0, context.currentTime);

  const setupHissAmount = parameters.hissReductionAmount || 0;

  const eqMid = context.createBiquadFilter();
  eqMid.type = 'peaking';
  eqMid.Q.setValueAtTime(parameters.eqMidQ, context.currentTime);
  eqMid.frequency.setValueAtTime(parameters.eqMidFreq, context.currentTime);
  eqMid.gain.setValueAtTime(parameters.eqMidGain, context.currentTime);

  const eqHigh = context.createBiquadFilter();
  eqHigh.type = 'highshelf';
  eqHigh.frequency.setValueAtTime(parameters.eqHighFreq, context.currentTime);
  eqHigh.gain.setValueAtTime(parameters.eqHighGain, context.currentTime);

  // Dedicated Dynamic Sibilance Notch (9000Hz De-esser)
  const sibilanceNotch = context.createBiquadFilter();
  sibilanceNotch.type = 'peaking';
  sibilanceNotch.frequency.setValueAtTime(parameters.sibilanceDynamicFreq || 9000, context.currentTime);
  sibilanceNotch.Q.setValueAtTime(5.0, context.currentTime); // surgical Q targeting sibilance peak
  sibilanceNotch.gain.setValueAtTime(0.0, context.currentTime); // default neutral

  const sibilanceNotchDynamicGain = context.createGain();
  // Decoupled from hissAmount: always fully active (-6.0dB max depth) if sibilance is detected
  const isSibilant = (parameters.sibilanceDynamicFreq && parameters.sibilanceDynamicFreq > 0);
  const initDynamicCut = isSibilant ? -6.0 : 0.0;
  sibilanceNotchDynamicGain.gain.setValueAtTime(initDynamicCut, context.currentTime);
  envelopeSmoother.connect(sibilanceNotchDynamicGain);
  sibilanceNotchDynamicGain.connect(sibilanceNotch.gain);

  // 8連 AI Corrective Notch Filters
  const setupHissFactor = 1.0; // Keep surgical notches at full depth for uncompromised resonance removal

  const eqCorrective1 = context.createBiquadFilter();
  eqCorrective1.type = 'peaking';
  eqCorrective1.Q.setValueAtTime(parameters.correctiveNotches[0].q || 15.0, context.currentTime); // 動的なQ値（ピーキーな共鳴音は15.0、広範囲の盛り上がりは6.0）
  eqCorrective1.frequency.setValueAtTime(parameters.correctiveNotches[0].freq, context.currentTime);
  eqCorrective1.gain.setValueAtTime(parameters.correctiveNotches[0].enabled ? (parameters.correctiveNotches[0].gain * setupHissFactor) : 0.0, context.currentTime);

  const eqCorrective2 = context.createBiquadFilter();
  eqCorrective2.type = 'peaking';
  eqCorrective2.Q.setValueAtTime(parameters.correctiveNotches[1].q || 15.0, context.currentTime);
  eqCorrective2.frequency.setValueAtTime(parameters.correctiveNotches[1].freq, context.currentTime);
  eqCorrective2.gain.setValueAtTime(parameters.correctiveNotches[1].enabled ? (parameters.correctiveNotches[1].gain * setupHissFactor) : 0.0, context.currentTime);

  const eqCorrective3 = context.createBiquadFilter();
  eqCorrective3.type = 'peaking';
  eqCorrective3.Q.setValueAtTime(parameters.correctiveNotches[2].q || 15.0, context.currentTime);
  eqCorrective3.frequency.setValueAtTime(parameters.correctiveNotches[2].freq, context.currentTime);
  eqCorrective3.gain.setValueAtTime(parameters.correctiveNotches[2].enabled ? (parameters.correctiveNotches[2].gain * setupHissFactor) : 0.0, context.currentTime);

  const eqCorrective4 = context.createBiquadFilter();
  eqCorrective4.type = 'peaking';
  eqCorrective4.Q.setValueAtTime(parameters.correctiveNotches[3].q || 15.0, context.currentTime);
  eqCorrective4.frequency.setValueAtTime(parameters.correctiveNotches[3].freq, context.currentTime);
  eqCorrective4.gain.setValueAtTime(parameters.correctiveNotches[3].enabled ? (parameters.correctiveNotches[3].gain * setupHissFactor) : 0.0, context.currentTime);

  const eqCorrective5 = context.createBiquadFilter();
  eqCorrective5.type = 'peaking';
  eqCorrective5.Q.setValueAtTime(parameters.correctiveNotches[4].q || 15.0, context.currentTime);
  eqCorrective5.frequency.setValueAtTime(parameters.correctiveNotches[4].freq, context.currentTime);
  eqCorrective5.gain.setValueAtTime(parameters.correctiveNotches[4].enabled ? (parameters.correctiveNotches[4].gain * setupHissFactor) : 0.0, context.currentTime);

  const eqCorrective6 = context.createBiquadFilter();
  eqCorrective6.type = 'peaking';
  eqCorrective6.Q.setValueAtTime(parameters.correctiveNotches[5].q || 15.0, context.currentTime);
  eqCorrective6.frequency.setValueAtTime(parameters.correctiveNotches[5].freq, context.currentTime);
  eqCorrective6.gain.setValueAtTime(parameters.correctiveNotches[5].enabled ? (parameters.correctiveNotches[5].gain * setupHissFactor) : 0.0, context.currentTime);

  const eqCorrective7 = context.createBiquadFilter();
  eqCorrective7.type = 'peaking';
  eqCorrective7.Q.setValueAtTime(parameters.correctiveNotches[6].q || 15.0, context.currentTime);
  eqCorrective7.frequency.setValueAtTime(parameters.correctiveNotches[6].freq, context.currentTime);
  eqCorrective7.gain.setValueAtTime(parameters.correctiveNotches[6].enabled ? (parameters.correctiveNotches[6].gain * setupHissFactor) : 0.0, context.currentTime);

  const eqCorrective8 = context.createBiquadFilter();
  eqCorrective8.type = 'peaking';
  eqCorrective8.Q.setValueAtTime(parameters.correctiveNotches[7].q || 15.0, context.currentTime);
  eqCorrective8.frequency.setValueAtTime(parameters.correctiveNotches[7].freq, context.currentTime);
  eqCorrective8.gain.setValueAtTime(parameters.correctiveNotches[7].enabled ? (parameters.correctiveNotches[7].gain * setupHissFactor) : 0.0, context.currentTime);

  satSumNode.connect(eqLow);
  eqLow.connect(kickPeaking);
  kickPeaking.connect(eqMid);
  eqMid.connect(eqHigh);

  // 4. Glue Compressor
  const compressor = context.createDynamicsCompressor();
  compressor.knee.setValueAtTime(6.0, context.currentTime); // Soft knee

  if (parameters.compEnabled) {
    compressor.threshold.setValueAtTime(parameters.compThreshold, context.currentTime);
    compressor.ratio.setValueAtTime(parameters.compRatio, context.currentTime);
    compressor.attack.setValueAtTime(parameters.compAttack, context.currentTime);
    compressor.release.setValueAtTime(parameters.compRelease, context.currentTime);
  } else {
    compressor.threshold.setValueAtTime(0.0, context.currentTime);
    compressor.ratio.setValueAtTime(1.0, context.currentTime); // 1:1 ratio = Bypassed dynamics
  }

  // Connect eqHigh to sibilanceNotch, then to compressor, keeping the dynamic de-esser active while bypassing the 8x surgical notches
  eqHigh.connect(sibilanceNotch);
  sibilanceNotch.connect(compressor);

  // 5. Stereo Imager Matrix (Mid/Side Processing)
  const splitter = context.createChannelSplitter(2);
  const midSum = context.createGain();
  const sideDiff = context.createGain();

  const leftToMid = context.createGain(); leftToMid.gain.setValueAtTime(0.5, context.currentTime);
  const rightToMid = context.createGain(); rightToMid.gain.setValueAtTime(0.5, context.currentTime);
  const leftToSide = context.createGain(); leftToSide.gain.setValueAtTime(0.5, context.currentTime);
  const rightToSide = context.createGain(); rightToSide.gain.setValueAtTime(-0.5, context.currentTime);

  compressor.connect(splitter);

  // Map L/R to Mid-Side
  splitter.connect(leftToMid, 0); // L
  splitter.connect(rightToMid, 1); // R
  leftToMid.connect(midSum);
  rightToMid.connect(midSum);

  splitter.connect(leftToSide, 0); // L
  splitter.connect(rightToSide, 1); // R
  leftToSide.connect(sideDiff);
  rightToSide.connect(sideDiff);

  // Stereo Width Gain Nodes
  const midGain = context.createGain();
  const sideGain = context.createGain();
  
  // 低域の位相干渉（シュワシュワ音）を防ぎ、低中域のステレオ感とパンチを維持するため、Side信号の指定音域以下をカットするハイパスフィルター
  const sideHighPass = context.createBiquadFilter();
  sideHighPass.type = 'highpass';
  sideHighPass.frequency.setValueAtTime(parameters.sideHighPassFreq || 110, context.currentTime); // 指定された周波数（デフォルト110Hz）以下はモノラル（Midのみ）に維持
  sideHighPass.Q.setValueAtTime(0.707, context.currentTime);

  const w = parameters.stereoWidth;
  // センター音（ボーカルやベースなど）の定位と音量を維持するため、Midゲインは1.0に固定します。
  midGain.gain.setValueAtTime(1.0, context.currentTime);
  sideGain.gain.setValueAtTime(w, context.currentTime);

  midSum.connect(midGain);
  
  // Side信号はハイパスを通した後に広がりを適用
  sideDiff.connect(sideHighPass);
  sideHighPass.connect(sideGain);

  // Decode back to Stereo L/R
  const leftSum = context.createGain();
  const rightDiff = context.createGain();
  const sideInverter = context.createGain();
  sideInverter.gain.setValueAtTime(-1.0, context.currentTime);

  midGain.connect(leftSum);
  sideGain.connect(leftSum); // L = Mid + Side

  midGain.connect(rightDiff);
  sideGain.connect(sideInverter);
  sideInverter.connect(rightDiff); // R = Mid - Side

  const merger = context.createChannelMerger(2);
  leftSum.connect(merger, 0, 0);
  rightDiff.connect(merger, 0, 1);

  // 6. Limiter pre-gain (Maximizer)
  const limiterGain = context.createGain();
  limiterGain.gain.setValueAtTime(Math.pow(10, parameters.limiterBoost / 20), context.currentTime);

  merger.connect(limiterGain);

  // 7. Brickwall Limiter
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-3.0, context.currentTime); // -3.0dB threshold provides look-ahead emulation cushion (Web Audio automatic makeup gain restores peak level)
  limiter.knee.setValueAtTime(3.0, context.currentTime);      // Smooth knee
  limiter.ratio.setValueAtTime(20.0, context.currentTime);    // Dynamic limiting brickwall
  limiter.attack.setValueAtTime(0.0001, context.currentTime); // 0.1ms (near-instant reaction to catch peaks)
  limiter.release.setValueAtTime(0.08, context.currentTime);  // 80ms (optimized to prevent low-end distortion)

  // 7b. Safety Soft Clipper (WaveShaper Node)
  const safetyClipper = context.createWaveShaper();
  safetyClipper.curve = generateSoftClipCurve();
  safetyClipper.oversample = '2x'; // 2x oversampling to prevent aliasing

  limiterGain.connect(limiter);
  limiter.connect(safetyClipper);

  // 8. Ceiling Gain Node
  const ceilingGain = context.createGain();
  ceilingGain.gain.setValueAtTime(Math.pow(10, parameters.ceiling / 20), context.currentTime);

  safetyClipper.connect(ceilingGain);
  ceilingGain.connect(dest);

  // Connect Input Source to chain entry
  sourceNode.connect(inputGainNode);

  return {
    outputNode: ceilingGain,
    inputGain: inputGainNode,
    rumbleFilter,
    hissFilter,
    hissEnvelopeGain,
    satDryGain,
    satWetGain,
    waveShaper,
    eqLow,
    kickPeaking,
    eqMid,
    eqHigh,
    sibilanceNotch,
    sibilanceNotchDynamicGain,
    eqCorrective1,
    eqCorrective2,
    eqCorrective3,
    eqCorrective4,
    eqCorrective5,
    eqCorrective6,
    eqCorrective7,
    eqCorrective8,
    compressor,
    midGain,
    sideGain,
    sideHighPass,
    limiterGain,
    limiter,
    safetyClipper,
    ceilingGain
  };
}

function setupAudioContextListeners(ctx) {
  if (!ctx) return;
  
  ctx.addEventListener('statechange', () => {
    logToUI(`[AudioEngine] AudioContext state changed to: ${ctx.state}`, 'info');
    // If context is suspended or interrupted by the system while we think we are playing, pause playback UI
    if ((ctx.state === 'suspended' || ctx.state === 'interrupted') && isPlaying) {
      logToUI(`[AudioEngine] AudioContext suspended/interrupted by system. Syncing UI.`, 'warning');
      pausePlayback();
    }
  });

  // Listen for audio output device changes (like Bluetooth disconnecting, headphones unplugged)
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    if (!navigator.mediaDevices._hasDeviceChangeListener) {
      navigator.mediaDevices._hasDeviceChangeListener = true;
      navigator.mediaDevices.addEventListener('devicechange', () => {
        logToUI("[AudioEngine] Media device change detected (e.g. Bluetooth/Headphones connection changed).", "info");
        if (isPlaying) {
          logToUI("[AudioEngine] Pausing playback due to audio output route change.", "warning");
          pausePlayback();
        }
      });
    }
  }
}

function createAudioContext() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  logToUI(`createAudioContext: Created new AudioContext. State: ${ctx.state}`, 'info');
  setupAudioContextListeners(ctx);
  return ctx;
}

// ==========================================================================
// PLAYER & ENGINE INITIALIZATION
// ==========================================================================
function initAudio() {
  logToUI(`initAudio: State before init: ${audioContext ? audioContext.state : 'null'}`, 'info');
  if (!audioContext) {
    audioContext = createAudioContext();
  }
  
  // Set audio session type to 'playback' for iOS/mobile background playback support (unmutes silent switch and keeps background running)
  if (navigator.audioSession) {
    try {
      navigator.audioSession.type = 'playback';
      logToUI(`initAudio: Set audioSession.type to 'playback' for background playback support.`, 'info');
    } catch (e) {
      logToUI(`initAudio: Failed to set audioSession.type: ${e.message}`, 'warning');
    }
  }

  if (audioContext.state === 'suspended' || audioContext.state === 'interrupted') {
    logToUI(`initAudio: Resuming suspended/interrupted AudioContext...`, 'info');
    audioContext.resume()
      .then(() => {
        logToUI(`initAudio: AudioContext resumed. State: ${audioContext.state}`, 'info');
      })
      .catch((err) => {
        logToUI(`initAudio: Resume failed: ${err.message}`, 'error');
      });
  } else {
    logToUI(`initAudio: AudioContext is already running. State: ${audioContext.state}`, 'info');
  }
}

function startPlayback() {
  logToUI(`startPlayback: Started. isPlaying=${isPlaying}, hasBuffer=${!!audioBuffer}`, 'info');
  if (!audioBuffer) return;
  
  initAudio();
  
  // Re-create BufferSource
  sourceNode = audioContext.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.loop = isLooping;
  
  // Track offset when finished
  sourceNode.onended = () => {
    if (!isLooping) {
      stopPlayback();
    }
  };

  // 1. Set up live level analysers
  const inputSplitter = audioContext.createChannelSplitter(2);
  const inputAnalyserL = audioContext.createAnalyser();
  const inputAnalyserR = audioContext.createAnalyser();
  inputAnalyserL.fftSize = 512;
  inputAnalyserR.fftSize = 512;
  
  const outputSplitter = audioContext.createChannelSplitter(2);
  const outputAnalyserL = audioContext.createAnalyser();
  const outputAnalyserR = audioContext.createAnalyser();
  outputAnalyserL.fftSize = 512;
  outputAnalyserR.fftSize = 512;

  const visualAnalyser = audioContext.createAnalyser();
  visualAnalyser.fftSize = 1024;

  // Track reference node mappings
  activeNodes.inputSplitter = inputSplitter;
  activeNodes.inputAnalyserL = inputAnalyserL;
  activeNodes.inputAnalyserR = inputAnalyserR;
  activeNodes.outputSplitter = outputSplitter;
  activeNodes.outputAnalyserL = outputAnalyserL;
  activeNodes.outputAnalyserR = outputAnalyserR;
  activeNodes.visualAnalyser = visualAnalyser;

  // 2. Build Bypass Crossfaders
  const masteredOutGain = audioContext.createGain();
  const bypassGain = audioContext.createGain();

  activeNodes.masteredOutGain = masteredOutGain;
  activeNodes.bypassGain = bypassGain;

  // 3. Build Main Mastering Chain
  const chain = setupMasteringChain(audioContext, sourceNode, getCombinedParams(), masteredOutGain);
  
  // Connect references to let slider changes alter nodes in real time
  activeNodes.inputGain = chain.inputGain;
  activeNodes.satDryGain = chain.satDryGain;
  activeNodes.satWetGain = chain.satWetGain;
  activeNodes.waveShaper = chain.waveShaper;
  activeNodes.eqLow = chain.eqLow;
  activeNodes.kickPeaking = chain.kickPeaking;
  activeNodes.eqMid = chain.eqMid;
  activeNodes.eqHigh = chain.eqHigh;
  activeNodes.sibilanceNotch = chain.sibilanceNotch;
  activeNodes.sibilanceNotchDynamicGain = chain.sibilanceNotchDynamicGain;
  activeNodes.eqCorrective1 = chain.eqCorrective1;
  activeNodes.eqCorrective2 = chain.eqCorrective2;
  activeNodes.eqCorrective3 = chain.eqCorrective3;
  activeNodes.eqCorrective4 = chain.eqCorrective4;
  activeNodes.eqCorrective5 = chain.eqCorrective5;
  activeNodes.eqCorrective6 = chain.eqCorrective6;
  activeNodes.eqCorrective7 = chain.eqCorrective7;
  activeNodes.eqCorrective8 = chain.eqCorrective8;
  activeNodes.compressor = chain.compressor;
  activeNodes.midGain = chain.midGain;
  activeNodes.sideGain = chain.sideGain;
  activeNodes.sideHighPass = chain.sideHighPass;
  activeNodes.limiterGain = chain.limiterGain;
  activeNodes.limiter = chain.limiter;
  activeNodes.safetyClipper = chain.safetyClipper;
  activeNodes.ceilingGain = chain.ceilingGain;
  activeNodes.rumbleFilter = chain.rumbleFilter;
  activeNodes.hissFilter = chain.hissFilter;
  activeNodes.hissEnvelopeGain = chain.hissEnvelopeGain;

  // 4. Hook up Input monitoring (right after inputGain)
  chain.inputGain.connect(inputSplitter);
  inputSplitter.connect(inputAnalyserL, 0);
  inputSplitter.connect(inputAnalyserR, 1);

  // 5. Connect Bypass Node directly from source
  sourceNode.connect(bypassGain);

  // 6. Connect Outputs to Summing visualAnalyser and Speakers
  masteredOutGain.connect(visualAnalyser);
  bypassGain.connect(visualAnalyser);
  
  // Also connect to Level Analysers
  masteredOutGain.connect(outputSplitter);
  outputSplitter.connect(outputAnalyserL, 0);
  outputSplitter.connect(outputAnalyserR, 1);

  visualAnalyser.connect(audioContext.destination);

  // Set initial bypass volumes smoothly
  if (isBypassed) {
    masteredOutGain.gain.setValueAtTime(0.0, audioContext.currentTime);
    bypassGain.gain.setValueAtTime(1.0, audioContext.currentTime);
  } else {
    masteredOutGain.gain.setValueAtTime(1.0, audioContext.currentTime);
    bypassGain.gain.setValueAtTime(0.0, audioContext.currentTime);
  }

  // Run buffer
  sourceNode.start(0, pausedAt);
  startTime = audioContext.currentTime;
  isPlaying = true;
  
  updatePlayButtonUI(true);
  document.getElementById('status-text').innerText = isBypassed ? 'BYPASSED PLAYBACK' : 'MASTERING PLAYBACK';
  document.getElementById('status-indicator').className = 'status-indicator processing';

  // Start Realtime Canvas Render Loop
  startRenderLoop();
}

function pausePlayback() {
  if (!isPlaying) return;
  pausedAt += audioContext.currentTime - startTime;
  if (pausedAt >= audioBuffer.duration) {
    pausedAt = 0;
  }
  if (sourceNode) {
    sourceNode.onended = null;
    sourceNode.stop();
  }
  isPlaying = false;
  updatePlayButtonUI(false);
  document.getElementById('status-text').innerText = 'PLAYBACK PAUSED';
  document.getElementById('status-indicator').className = 'status-indicator online';
  
  cancelAnimationFrame(animFrameId);
  resetLevelMeters();

  // Suspend AudioContext to save battery when not playing
  if (audioContext && audioContext.state === 'running') {
    audioContext.suspend().then(() => {
      logToUI("AudioContext suspended to save battery.", "info");
    });
  }
}

function stopPlayback() {
  if (isPlaying && sourceNode) {
    sourceNode.onended = null;
    sourceNode.stop();
  }
  pausedAt = 0;
  isPlaying = false;
  updatePlayButtonUI(false);
  document.getElementById('status-text').innerText = 'SYSTEM READY';
  document.getElementById('status-indicator').className = 'status-indicator online';
  
  cancelAnimationFrame(animFrameId);
  resetLevelMeters();

  // Suspend AudioContext to save battery when stopped
  if (audioContext && audioContext.state === 'running') {
    audioContext.suspend().then(() => {
      logToUI("AudioContext suspended to save battery.", "info");
    });
  }
}

// ==========================================================================
// WAVEFORM RENDERING & SEEKING LOGIC
// ==========================================================================
function drawWaveformView() {
  const waveformCanvas = document.getElementById('waveform-canvas');
  if (!waveformCanvas || !originalPeaks || !audioBuffer) return;
  
  resizeCanvas(waveformCanvas);
  
  const waveCtx = waveformCanvas.getContext('2d');
  // HighDPI resize check
  const rect = waveformCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const wWidth = rect.width;
  const wHeight = rect.height;
  
  waveCtx.clearRect(0, 0, wWidth, wHeight);

  // Draw original waveform (Dry) in gray
  waveCtx.fillStyle = 'rgba(71, 85, 105, 0.35)';
  for (let i = 0; i < PEAK_POINTS; i++) {
    const x = (wWidth / PEAK_POINTS) * i;
    const maxVal = originalPeaks.max[i] * (wHeight * 0.45);
    const minVal = originalPeaks.min[i] * (wHeight * 0.45);
    waveCtx.fillRect(x, wHeight / 2 - maxVal, 1.2, maxVal - minVal);
  }

  // Draw active processed (wet) approximation in Cyan
  const proPeaks = getProcessedPeaks();
  waveCtx.fillStyle = 'rgba(0, 242, 254, 0.75)';
  const useShadows = window.innerWidth > 768;
  if (useShadows) {
    waveCtx.shadowBlur = 2;
    waveCtx.shadowColor = 'rgba(0, 242, 254, 0.4)';
  }
  for (let i = 0; i < PEAK_POINTS; i++) {
    const x = (wWidth / PEAK_POINTS) * i;
    const maxVal = proPeaks.max[i] * (wHeight * 0.45);
    const minVal = proPeaks.min[i] * (wHeight * 0.45);
    waveCtx.fillRect(x, wHeight / 2 - maxVal, 1.2, maxVal - minVal);
  }
  if (useShadows) {
    waveCtx.shadowBlur = 0;
  }

  // Draw playback cursor position
  const currentOffset = isPlaying ? (pausedAt + (audioContext.currentTime - startTime)) : pausedAt;
  const progress = currentOffset / audioBuffer.duration;
  if (progress <= 1.0) {
    const cursorX = progress * wWidth;
    waveCtx.strokeStyle = '#9d4edd';
    waveCtx.lineWidth = 1.5;
    if (useShadows) {
      waveCtx.shadowBlur = 8;
      waveCtx.shadowColor = '#9d4edd';
    }
    waveCtx.beginPath();
    waveCtx.moveTo(cursorX, 0);
    waveCtx.lineTo(cursorX, wHeight);
    waveCtx.stroke();
    if (useShadows) {
      waveCtx.shadowBlur = 0;
    }
  }
}

function seekTo(seconds) {
  if (!audioBuffer) return;
  
  // Clamp seek time to buffer boundaries
  seconds = Math.max(0, Math.min(audioBuffer.duration, seconds));
  
  logToUI(`Seeking playback position to ${seconds.toFixed(2)}s`, 'info');
  
  if (isPlaying) {
    // 1. Temporarily flag seeking to prevent stopPlayback triggering in sourceNode.onended
    isSeeking = true;
    try {
      sourceNode.onended = null; // Clear handler on old node before stopping to resolve race condition
      sourceNode.stop();
    } catch (e) {
      // already stopped or not started
    }
    
    pausedAt = seconds;
    
    // 2. Re-create source and trigger playback from new position
    sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.loop = isLooping;
    
    sourceNode.onended = () => {
      if (!isLooping) {
        stopPlayback();
      }
    };
    
    // Reconnect to entry points of live context
    sourceNode.connect(activeNodes.inputGain);
    sourceNode.connect(activeNodes.bypassGain);
    
    sourceNode.start(0, seconds);
    startTime = audioContext.currentTime;
    isSeeking = false;
  } else {
    // If paused, just update static position and redraw playhead
    pausedAt = seconds;
    drawWaveformView();
  }
}

// ==========================================================================
// REAL-TIME VISUALIZATIONS LOOP
// ==========================================================================
function startRenderLoop() {
  const spectrumCanvas = document.getElementById('spectrum-canvas');
  const specCtx = spectrumCanvas.getContext('2d');
  
  const waveformCanvas = document.getElementById('waveform-canvas');
  
  // HighDPI canvas resize
  resizeCanvas(spectrumCanvas);
  resizeCanvas(waveformCanvas);

  let lastFrameTime = 0;
  const isMobile = window.innerWidth <= 768;
  const targetFps = isMobile ? 15 : 60; // スマホ時は15fpsに制限し描画負荷を低減
  const fpsInterval = 1000 / targetFps;

  function draw(currentTime) {
    if (!isPlaying) return;
    animFrameId = requestAnimationFrame(draw);

    const timestamp = currentTime || performance.now();
    const elapsed = timestamp - lastFrameTime;
    if (elapsed < fpsInterval) {
      return; // Throttle frame rate
    }
    lastFrameTime = timestamp - (elapsed % fpsInterval);

    try {
      const currentW = spectrumCanvas.width;
      const currentH = spectrumCanvas.height;

      // ------------------------------------------
      // 1. Draw Spectrum Visualizer
      // ------------------------------------------
      if (activeTab === 'spectrum') {
        resizeCanvas(spectrumCanvas);
        const bufferLength = activeNodes.visualAnalyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        activeNodes.visualAnalyser.getByteFrequencyData(dataArray);

        specCtx.clearRect(0, 0, currentW, currentH);

        const sampleRate = activeNodes.visualAnalyser.context.sampleRate;
        
        // 周波数から描画X座標への対数マッピング計算
        function getX(f) {
          const fftSize = activeNodes.visualAnalyser.fftSize;
          const targetBin = (f * fftSize) / sampleRate;
          const percent = Math.pow(targetBin / (bufferLength * 0.7), 1 / 1.8);
          return percent * currentW;
        }

        // 1. 横軸（デシベル音量）のグリッド線とラベル描画
        const dbLines = [
          { label: '0 dB', y: currentH - 1.0 * (currentH * 0.82) },
          { label: '-18 dB', y: currentH - 0.5 * (currentH * 0.82) },
          { label: '-36 dB', y: currentH - 0.25 * (currentH * 0.82) }
        ];
        
        specCtx.lineWidth = 1;
        dbLines.forEach(line => {
          specCtx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
          specCtx.beginPath();
          specCtx.moveTo(0, line.y);
          specCtx.lineTo(currentW, line.y);
          specCtx.stroke();
          
          if (!isMobile) {
            specCtx.fillStyle = 'rgba(255, 255, 255, 0.55)';
            specCtx.font = '10px "JetBrains Mono", monospace';
            specCtx.textAlign = 'right';
            specCtx.fillText(line.label, currentW - 8, line.y - 4);
          }
        });

        // 2. 縦軸（周波数）のグリッド線とラベル描画（スマホ時はテキスト描画・縦グリッド線を省略して省電力化）
        if (!isMobile) {
          const freqLines = [
            { f: 100, label: '100Hz' },
            { f: 500, label: '500Hz' },
            { f: 1000, label: '1kHz' },
            { f: 2000, label: '2kHz' },
            { f: 5000, label: '5kHz' },
            { f: 10000, label: '10kHz' },
            { f: 15000, label: '15kHz' }
          ];

          freqLines.forEach(line => {
            const x = getX(line.f);
            if (x > 0 && x < currentW) {
              specCtx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
              specCtx.beginPath();
              specCtx.moveTo(x, 0);
              specCtx.lineTo(x, currentH - 18);
              specCtx.stroke();
              
              specCtx.fillStyle = 'rgba(255, 255, 255, 0.65)';
              specCtx.font = '10px "JetBrains Mono", monospace';
              specCtx.textAlign = 'center';
              specCtx.fillText(line.label, x, currentH - 5);
            }
          });
        }

        const sliceWidth = currentW / (bufferLength * 0.7); // Clip top frequencies (>15kHz) for nicer scale
        let x = 0;
        const step = isMobile ? 6 : 1; // スマホ時は描画頂点数を6分の1に間引いてCPU負荷を激減

        // 3. グラデーション塗りつぶし（スマホ時はGPUのフィルレート負荷削減のため完全にスキップ）
        if (!isMobile) {
          const gradient = specCtx.createLinearGradient(0, currentH, 0, 0);
          gradient.addColorStop(0, 'rgba(157, 78, 221, 0.0)');
          gradient.addColorStop(0.5, 'rgba(157, 78, 221, 0.3)');
          gradient.addColorStop(1, 'rgba(0, 242, 254, 0.8)');

          specCtx.beginPath();
          specCtx.moveTo(0, currentH);

          for (let i = 0; i < bufferLength * 0.7; i++) {
            const percentIdx = i / (bufferLength * 0.7);
            const logIdx = Math.floor(Math.pow(percentIdx, 1.8) * (bufferLength * 0.7));
            const v = dataArray[logIdx] / 255.0;
            const y = currentH - v * (currentH * 0.82);

            if (i === 0) {
              specCtx.moveTo(x, y);
            } else {
              specCtx.lineTo(x, y);
            }

            x += sliceWidth;
          }
          specCtx.lineTo(currentW, currentH);
          specCtx.fillStyle = gradient;
          specCtx.fill();
        }

        // 4. 外枠のアウトライン描画（スマホ時は間引きループを適用し、線幅を1.5pxへ細めてミニマル表示化）
        specCtx.lineWidth = isMobile ? 1.5 : 2.5;
        specCtx.strokeStyle = '#00f2fe';
        const useShadows = window.innerWidth > 768;
        if (useShadows) {
          specCtx.shadowBlur = 6;
          specCtx.shadowColor = 'rgba(0, 242, 254, 0.6)';
        }
        
        specCtx.beginPath();
        x = 0;
        for (let i = 0; i < bufferLength * 0.7; i += step) {
          const percentIdx = i / (bufferLength * 0.7);
          const logIdx = Math.floor(Math.pow(percentIdx, 1.8) * (bufferLength * 0.7));
          const v = dataArray[logIdx] / 255.0;
          const y = currentH - v * (currentH * 0.82);

          const currentX = i * sliceWidth;

          if (i === 0) {
            specCtx.moveTo(currentX, y);
          } else {
            specCtx.lineTo(currentX, y);
          }
        }
        specCtx.stroke();
        if (useShadows) {
          specCtx.shadowBlur = 0; // Reset shadow
        }
      }

      // ------------------------------------------
      // 2. Draw Waveform Visualizer
      // ------------------------------------------
      if (activeTab === 'waveform' && originalPeaks) {
        drawWaveformView();
      }

      // ------------------------------------------
      // 3. Peak/RMS level monitoring & VU meter update
      // ------------------------------------------
      updateLevelMeters();
    } catch (err) {
      console.error('Visualizer rendering loop error caught:', err);
    }
  }

  draw();
}

function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return true; // Canvas was resized
  }
  return false; // No resize needed
}

// Extract max and min peak envelopes from loaded buffer
function extractPeaks(buffer, numPoints) {
  const chL = buffer.getChannelData(0);
  const chR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : chL;
  const totalLength = buffer.length;
  const blockSize = Math.floor(totalLength / numPoints);
  
  const maxPeaks = new Float32Array(numPoints);
  const minPeaks = new Float32Array(numPoints);
  
  for (let i = 0; i < numPoints; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, totalLength);
    
    let max = -1.0;
    let min = 1.0;
    
    for (let j = start; j < end; j++) {
      const val = (chL[j] + chR[j]) * 0.5;
      if (val > max) max = val;
      if (val < min) min = val;
    }
    
    maxPeaks[i] = max;
    minPeaks[i] = min;
  }
  
  return { max: maxPeaks, min: minPeaks };
}

// Approximate processed waveform shape in JS based on sliders
function calculateProcessedPeaks() {
  const proMax = new Float32Array(PEAK_POINTS);
  const proMin = new Float32Array(PEAK_POINTS);
  
  const p = getCombinedParams();
  
  const inputG = Math.pow(10, p.inputGainDb / 20);
  const limitG = Math.pow(10, p.limiterBoost / 20);
  const ceilingG = Math.pow(10, p.ceiling / 20);
  
  const compThreshLinear = Math.pow(10, p.compThreshold / 20);
  const ratio = p.compEnabled ? p.compRatio : 1.0;

  // 視覚的な「のり波形（フラットな潰れ）」を防ぎ、音楽的なピークの強弱を維持するソフトリミッターシミュレータ
  const softLimit = (x) => {
    const absX = Math.abs(x);
    if (absX < 0.15) return x;
    return Math.sign(x) * (absX / Math.pow(1.0 + Math.pow(absX, 3.0), 1.0 / 3.0));
  };

  for (let i = 0; i < PEAK_POINTS; i++) {
    let max = originalPeaks.max[i] * inputG;
    let min = originalPeaks.min[i] * inputG;

    // Fast compressor math simulation
    if (p.compEnabled) {
      // Squash positive
      const absMax = Math.abs(max);
      if (absMax > compThreshLinear) {
        max = Math.sign(max) * (compThreshLinear + (absMax - compThreshLinear) / ratio);
      }
      // Squash negative
      const absMin = Math.abs(min);
      if (absMin > compThreshLinear) {
        min = Math.sign(min) * (compThreshLinear + (absMin - compThreshLinear) / ratio);
      }
    }

    // Saturation simulation (tape soft clip)
    if (p.satEnabled) {
      const blend = p.satMix / 100;
      const k = 0.5 + (p.satDrive / 100) * 5.5;
      
      const satMax = Math.tanh(k * max) / Math.tanh(k);
      const satMin = Math.tanh(k * min) / Math.tanh(k);

      max = max * (1.0 - blend) + satMax * blend;
      min = min * (1.0 - blend) + satMin * blend;
    }

    // Boost into Limiter
    max *= limitG;
    min *= limitG;

    // ソフトリミッターにより、波形の頂点が完全に平ら（音割れ風）になるのを防ぐ
    max = softLimit(max);
    min = softLimit(min);

    // Output Ceiling
    max *= ceilingG;
    min *= ceilingG;

    proMax[i] = max;
    proMin[i] = min;
  }
  
  return { max: proMax, min: proMin };
}

// Get the maximum amplitude peak in dB from analyser time domain array
function getPeakDb(timeData) {
  let peak = 0.0;
  for (let i = 0; i < timeData.length; i++) {
    const val = Math.abs(timeData[i]);
    if (val > peak) peak = val;
  }
  if (peak === 0.0) return -60;
  const db = 20 * Math.log10(peak);
  return db;
}

// Convert decibels to a visual meter percentage (range -60dB to 0dB)
function dbToPercent(db) {
  if (db < -60) return 0;
  if (db > 0) return 100;
  return ((db + 60) / 60) * 100;
}

function updateLevelMeters() {
  // Input Level Analyser Arrays
  const timeInL = new Float32Array(activeNodes.inputAnalyserL.fftSize);
  const timeInR = new Float32Array(activeNodes.inputAnalyserR.fftSize);
  activeNodes.inputAnalyserL.getFloatTimeDomainData(timeInL);
  activeNodes.inputAnalyserR.getFloatTimeDomainData(timeInR);

  // Output Level Analyser Arrays
  const timeOutL = new Float32Array(activeNodes.outputAnalyserL.fftSize);
  const timeOutR = new Float32Array(activeNodes.outputAnalyserR.fftSize);
  activeNodes.outputAnalyserL.getFloatTimeDomainData(timeOutL);
  activeNodes.outputAnalyserR.getFloatTimeDomainData(timeOutR);

  // Get current DB peaks
  const dbInL = getPeakDb(timeInL);
  const dbInR = getPeakDb(timeInR);
  const dbOutL = getPeakDb(timeOutL);
  const dbOutR = getPeakDb(timeOutR);

  // Meter envelope physics: instant attack, exponential slow release decay
  const DECAY_DB = 1.6; // dB per frame
  meterInPeakL = Math.max(dbInL, meterInPeakL - DECAY_DB);
  meterInPeakR = Math.max(dbInR, meterInPeakR - DECAY_DB);
  meterOutPeakL = Math.max(dbOutL, meterOutPeakL - DECAY_DB);
  meterOutPeakR = Math.max(dbOutR, meterOutPeakR - DECAY_DB);

  // Update DOM fills using GPU-accelerated transform: scaleY
  document.getElementById('meter-in-l').style.transform = `scaleY(${dbToPercent(meterInPeakL) / 100})`;
  document.getElementById('meter-in-r').style.transform = `scaleY(${dbToPercent(meterInPeakR) / 100})`;
  document.getElementById('meter-out-l').style.transform = `scaleY(${dbToPercent(meterOutPeakL) / 100})`;
  document.getElementById('meter-out-r').style.transform = `scaleY(${dbToPercent(meterOutPeakR) / 100})`;

  // ------------------------------------------
  // 4. Stereo Phase Correlation Index
  // ------------------------------------------
  let dotProduct = 0;
  let sumL2 = 0;
  let sumR2 = 0;
  for (let i = 0; i < timeOutL.length; i++) {
    const l = timeOutL[i];
    const r = timeOutR[i];
    dotProduct += l * r;
    sumL2 += l * l;
    sumR2 += r * r;
  }
  
  if (sumL2 > 0 && sumR2 > 0) {
    const correlation = dotProduct / Math.sqrt(sumL2 * sumR2);
    // Smooth the visual pointer changes slightly
    correlationValue = correlationValue * 0.8 + correlation * 0.2;
  } else {
    correlationValue = correlationValue * 0.8 + 1.0 * 0.2; // Return to center mono
  }
  
  // Pointer position from -1 (0%) to +1 (100%)
  const pointerPercent = ((correlationValue + 1) / 2) * 100;
  document.getElementById('corr-pointer').style.left = `${pointerPercent}%`;

  // ------------------------------------------
  // 5. Gain Reduction (GR) Meter
  // ------------------------------------------
  let compGr = 0;
  let limiterGr = 0;

  if (activeNodes.compressor) {
    // compressor.reduction is a negative float value representing dB
    compGr = Math.abs(activeNodes.compressor.reduction);
  }
  if (activeNodes.limiter) {
    limiterGr = Math.abs(activeNodes.limiter.reduction);
  }

  // Combined gain reduction display
  const combinedGr = compGr + limiterGr;
  grPeak = Math.max(combinedGr, grPeak - 0.4); // Decay GR meter slower

  // GR Meter height maps from 0dB to 15dB
  const grPercent = Math.min(100, (grPeak / 15) * 100);
  document.getElementById('meter-gr').style.transform = `scaleY(${grPercent / 100})`;

  // Limiter Active Light Indicator
  const limitLight = document.getElementById('limiter-light');
  if (limiterGr > 0.1) {
    limitLight.className = 'limiter-light active';
  } else {
    limitLight.className = 'limiter-light';
  }

  // Clip Detector indicator (Out peak > Ceiling warning)
  const isClipping = dbOutL > params.ceiling + 0.1 || dbOutR > params.ceiling + 0.1;
  const warningText = document.getElementById('limiter-warning');
  if (isClipping) {
    warningText.className = 'limiter-warning';
  } else {
    warningText.className = 'limiter-warning hidden';
  }
}

function resetLevelMeters() {
  document.getElementById('meter-in-l').style.transform = 'scaleY(0)';
  document.getElementById('meter-in-r').style.transform = 'scaleY(0)';
  document.getElementById('meter-out-l').style.transform = 'scaleY(0)';
  document.getElementById('meter-out-r').style.transform = 'scaleY(0)';
  document.getElementById('meter-gr').style.transform = 'scaleY(0)';
  document.getElementById('corr-pointer').style.left = '50%';
  document.getElementById('limiter-light').className = 'limiter-light';
  document.getElementById('limiter-warning').className = 'limiter-warning hidden';
  
  meterInPeakL = -60;
  meterInPeakR = -60;
  meterOutPeakL = -60;
  meterOutPeakR = -60;
  grPeak = 0;
  correlationValue = 1.0;
}

// ==========================================================================
// REAL-TIME NODE UPDATE ROUTINES
// ==========================================================================
function updateInputGainNode() {
  invalidatePeakCache();
  if (activeNodes.inputGain) {
    const gainVal = Math.pow(10, params.inputGainDb / 20);
    activeNodes.inputGain.gain.setTargetAtTime(gainVal, audioContext.currentTime, 0.01);
  }
}

function updateCeilingNode() {
  invalidatePeakCache();
  if (activeNodes.ceilingGain) {
    const gainVal = Math.pow(10, params.ceiling / 20);
    activeNodes.ceilingGain.gain.setTargetAtTime(gainVal, audioContext.currentTime, 0.01);
  }
}

function updateNoiseCutNodes() {
  invalidatePeakCache();
  if (activeNodes.rumbleFilter && activeNodes.hissFilter && activeNodes.hissEnvelopeGain) {
    const targetRumbleFreq = params.rumbleCutEnabled ? 80.0 : 18.0; // 18Hz subsonic filter when disabled, protecting deep sub-bass while removing DC offset/infrasound mud.
    activeNodes.rumbleFilter.frequency.setTargetAtTime(targetRumbleFreq, audioContext.currentTime, 0.02);
    
    const hissAmount = params.hissReductionAmount || 0;
    const baseFreq = 20000.0 - (16250.0 * (hissAmount / 100.0)); // Maps 80% to 7,000Hz and 100% to 3,750Hz (dynamic VCF cleans 8kHz/7.4kHz metallic noise at default 80% setting)
    activeNodes.hissFilter.frequency.setTargetAtTime(baseFreq, audioContext.currentTime, 0.02);
    
    // 高域ヒスノイズ（13kHz〜20kHz）が楽曲再生中も完全に消え去るよう、上限遮断周波数（天井）を制限
    const ceilFreq = 20000.0 - (7000.0 * (hissAmount / 100.0)); // hissAmount=100%で最大天井を13,000Hzに固定
    const maxEnvGain = Math.max(0, ceilFreq - baseFreq);
    activeNodes.hissEnvelopeGain.gain.setTargetAtTime(maxEnvGain, audioContext.currentTime, 0.02);

    // Decoupled from hissAmount: always active at -6.0dB max if sibilance is detected
    if (activeNodes.sibilanceNotch && activeNodes.sibilanceNotchDynamicGain) {
      const isSibilant = (params.sibilanceDynamicFreq && params.sibilanceDynamicFreq > 0);
      const dynamicCut = isSibilant ? -6.0 : 0.0;
      activeNodes.sibilanceNotch.frequency.setTargetAtTime(params.sibilanceDynamicFreq || 9000, audioContext.currentTime, 0.02);
      activeNodes.sibilanceNotchDynamicGain.gain.setTargetAtTime(dynamicCut, audioContext.currentTime, 0.02);
    }
  }
}

function updateSaturatorNode() {
  invalidatePeakCache();
  if (activeNodes.waveShaper) {
    const p = getCombinedParams();
    activeNodes.waveShaper.curve = generateSaturatorCurve(p.satType, p.satDrive);
    
    if (p.satEnabled) {
      const blend = p.satMix / 100;
      activeNodes.satDryGain.gain.setTargetAtTime(1.0 - blend, audioContext.currentTime, 0.01);
      activeNodes.satWetGain.gain.setTargetAtTime(blend, audioContext.currentTime, 0.01);
    } else {
      activeNodes.satDryGain.gain.setTargetAtTime(1.0, audioContext.currentTime, 0.01);
      activeNodes.satWetGain.gain.setTargetAtTime(0.0, audioContext.currentTime, 0.01);
    }
  }
}

function updateEqNodes() {
  invalidatePeakCache();
  const p = getCombinedParams();

  if (activeNodes.eqLow) {
    activeNodes.eqLow.frequency.setTargetAtTime(p.eqLowFreq, audioContext.currentTime, 0.01);
    activeNodes.eqLow.gain.setTargetAtTime(p.eqLowGain, audioContext.currentTime, 0.01);
  }
  if (activeNodes.kickPeaking) {
    activeNodes.kickPeaking.gain.setTargetAtTime(p.kickPeakingGain, audioContext.currentTime, 0.01);
  }
  if (activeNodes.eqMid) {
    activeNodes.eqMid.frequency.setTargetAtTime(p.eqMidFreq, audioContext.currentTime, 0.01);
    activeNodes.eqMid.gain.setTargetAtTime(p.eqMidGain, audioContext.currentTime, 0.01);
    activeNodes.eqMid.Q.setTargetAtTime(p.eqMidQ, audioContext.currentTime, 0.01);
  }
  if (activeNodes.eqHigh) {
    activeNodes.eqHigh.frequency.setTargetAtTime(p.eqHighFreq, audioContext.currentTime, 0.01);
    activeNodes.eqHigh.gain.setTargetAtTime(p.eqHighGain, audioContext.currentTime, 0.01);
  }
}

function updateCorrectiveEqNodes() {
  invalidatePeakCache();
  
  for (let i = 0; i < 8; i++) {
    const nodeName = `eqCorrective${i + 1}`;
    if (activeNodes[nodeName]) {
      const n = params.correctiveNotches[i];
      activeNodes[nodeName].frequency.setTargetAtTime(n.freq, audioContext.currentTime, 0.01);
      
      const targetGain = n.enabled ? n.gain : 0.0;
      activeNodes[nodeName].gain.setTargetAtTime(targetGain, audioContext.currentTime, 0.01);
      
      const targetQ = n.q || 15.0;
      activeNodes[nodeName].Q.setTargetAtTime(targetQ, audioContext.currentTime, 0.01);
    }
  }
}

function updateCompressorNode() {
  invalidatePeakCache();
  if (activeNodes.compressor) {
    const p = getCombinedParams();
    if (p.compEnabled) {
      activeNodes.compressor.threshold.setTargetAtTime(p.compThreshold, audioContext.currentTime, 0.01);
      activeNodes.compressor.ratio.setTargetAtTime(p.compRatio, audioContext.currentTime, 0.01);
      activeNodes.compressor.attack.setTargetAtTime(p.compAttack, audioContext.currentTime, 0.01);
      activeNodes.compressor.release.setTargetAtTime(p.compRelease, audioContext.currentTime, 0.01);
    } else {
      activeNodes.compressor.threshold.setTargetAtTime(0, audioContext.currentTime, 0.01);
      activeNodes.compressor.ratio.setTargetAtTime(1.0, audioContext.currentTime, 0.01); // no-compression
    }
  }
}

function updateStereoWidthNode() {
  if (activeNodes.midGain && activeNodes.sideGain) {
    const p = getCombinedParams();
    activeNodes.midGain.gain.setTargetAtTime(1.0, audioContext.currentTime, 0.01);
    activeNodes.sideGain.gain.setTargetAtTime(p.stereoWidth, audioContext.currentTime, 0.01);
    
    if (activeNodes.sideHighPass) {
      activeNodes.sideHighPass.frequency.setTargetAtTime(p.sideHighPassFreq || 110, audioContext.currentTime, 0.01);
    }
    
    // Animate width indicator beams in HTML
    // left: rotate angle based on width (0 width = 0 deg, 2 width = -60 deg)
    const angleL = -45 * p.stereoWidth;
    const angleR = 45 * p.stereoWidth;
    document.getElementById('width-beam-l').style.transform = `rotate(${angleL}deg)`;
    document.getElementById('width-beam-r').style.transform = `rotate(${angleR}deg)`;
  }
}

function updateLimiterGainNode() {
  invalidatePeakCache();
  if (activeNodes.limiterGain) {
    const p = getCombinedParams();
    const gainVal = Math.pow(10, p.limiterBoost / 20);
    activeNodes.limiterGain.gain.setTargetAtTime(gainVal, audioContext.currentTime, 0.01);
  }
}

function updateBypassRouting() {
  if (activeNodes.masteredOutGain && activeNodes.bypassGain) {
    const time = audioContext.currentTime;
    // Crossfade smoothly over 50ms to prevent pops/clicks
    if (isBypassed) {
      activeNodes.masteredOutGain.gain.setValueAtTime(activeNodes.masteredOutGain.gain.value, time);
      activeNodes.masteredOutGain.gain.linearRampToValueAtTime(0.0, time + 0.05);
      
      activeNodes.bypassGain.gain.setValueAtTime(activeNodes.bypassGain.gain.value, time);
      activeNodes.bypassGain.gain.linearRampToValueAtTime(1.0, time + 0.05);
      document.getElementById('status-text').innerText = 'BYPASSED PLAYBACK';
    } else {
      activeNodes.masteredOutGain.gain.setValueAtTime(activeNodes.masteredOutGain.gain.value, time);
      activeNodes.masteredOutGain.gain.linearRampToValueAtTime(1.0, time + 0.05);
      
      activeNodes.bypassGain.gain.setValueAtTime(activeNodes.bypassGain.gain.value, time);
      activeNodes.bypassGain.gain.linearRampToValueAtTime(0.0, time + 0.05);
      document.getElementById('status-text').innerText = 'MASTERING PLAYBACK';
    }
  }
}

// ==========================================================================
// AI SPECTRAL ANALYSIS & AUTO-EQ ALGORITHMS
// ==========================================================================
// Cooley-Tukey Radix-2 FFT (Fast Fourier Transform)
function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  
  const reEven = new Float32Array(n / 2);
  const imEven = new Float32Array(n / 2);
  const reOdd = new Float32Array(n / 2);
  const imOdd = new Float32Array(n / 2);
  
  for (let i = 0; i < n / 2; i++) {
    reEven[i] = re[2 * i];
    imEven[i] = im[2 * i];
    reOdd[i] = re[2 * i + 1];
    imOdd[i] = im[2 * i + 1];
  }
  
  fft(reEven, imEven);
  fft(reOdd, imOdd);
  
  for (let k = 0; k < n / 2; k++) {
    const t = (k / n) * 2 * Math.PI;
    const wr = Math.cos(t);
    const wi = -Math.sin(t);
    
    const reT = reOdd[k] * wr - imOdd[k] * wi;
    const imT = reOdd[k] * wi + imOdd[k] * wr;
    
    re[k] = reEven[k] + reT;
    im[k] = imEven[k] + imT;
    re[k + n / 2] = reEven[k] - reT;
    im[k + n / 2] = imEven[k] - imT;
  }
}

// 分析関数：オーディオバッファをマルチスライス分析し、ダイナミクス、ステレオ音像、周波数バランス、耳障りな周波数（シャリシャリ音）を検出する
function analyzeAudioResonances(buffer, userPresetKey) {
  const fftSize = 2048;
  const numSlices = 32; // サンプリング精度を高めるため、32箇所を走査
  const sampleRate = buffer.sampleRate;
  const chL = buffer.getChannelData(0);
  const chR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : chL;
  
  const avgSpectrum = new Float32Array(fftSize / 2);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  
  // 1. サンプリングポイントの算出（前後10%はブレや静音部回避のため避ける）
  const slicePoints = [];
  const startOffset = Math.floor(buffer.length * 0.1);
  const endOffset = Math.floor(buffer.length * 0.9);
  const range = endOffset - startOffset;
  for (let i = 0; i < numSlices; i++) {
    slicePoints.push(startOffset + Math.floor(range * (i / (numSlices - 1))));
  }
  
  const sliceRMSList = [];
  const sliceSpectrums = [];
  
  let totalEnergyL2 = 0;
  let totalEnergyR2 = 0;
  let totalDotProduct = 0;
  let maxAbsSample = 0.0;
  let sumRMS2 = 0.0;
  let sampleCount = 0;

  for (const startIdx of slicePoints) {
    let sliceMax = 0.0;
    let sliceSumSq = 0.0;
    
    let sliceDotProduct = 0;
    let sliceSumL2 = 0;
    let sliceSumR2 = 0;

    // 左右チャネルの平均を窓に格納しつつ、各種統計データを集計
    for (let j = 0; j < fftSize; j++) {
      const idx = startIdx + j;
      if (idx >= buffer.length) break;

      const l = chL[idx];
      const r = chR[idx];
      const mid = (l + r) * 0.5;

      // FFT用データ
      re[j] = mid;
      im[j] = 0;

      // True peak estimation using L/R channels to prevent input overload on wide stereo tracks
      const absL = Math.abs(l);
      const absR = Math.abs(r);
      if (absL > sliceMax) sliceMax = absL;
      if (absR > sliceMax) sliceMax = absR;
      sliceSumSq += mid * mid;

      // ステレオ相関用
      sliceDotProduct += l * r;
      sliceSumL2 += l * l;
      sliceSumR2 += r * r;
    }
    
    // 最大ピークの更新
    if (sliceMax > maxAbsSample) maxAbsSample = sliceMax;
    
    // RMS集計
    const sliceRMS = Math.sqrt(sliceSumSq / fftSize);
    sumRMS2 += sliceRMS * sliceRMS;

    // ステレオ相関の加算
    totalDotProduct += sliceDotProduct;
    totalEnergyL2 += sliceSumL2;
    totalEnergyR2 += sliceSumR2;

    // ハニング窓（Hanning window）を適用
    for (let j = 0; j < fftSize; j++) {
      const windowVal = 0.5 * (1 - Math.cos((2 * Math.PI * j) / (fftSize - 1)));
      re[j] *= windowVal;
    }
    
    // FFT実行
    fft(re, im);
    
    // スペクトラム強度の算出と累積（FFTサイズで正規化して正確なdBFSレベルにする）
    const spec = new Float32Array(fftSize / 2);
    const normFactor = fftSize / 2; // Cooley-Tukey FFTの振幅正規化係数 (N/2)
    for (let j = 0; j < fftSize / 2; j++) {
      const mag = Math.sqrt(re[j] * re[j] + im[j] * im[j]) / normFactor;
      avgSpectrum[j] += mag / numSlices;
      spec[j] = mag;
    }
    sliceSpectrums.push(spec);
    sliceRMSList.push(sliceRMS);
  }

  // クレストファクター (dB)
  const avgRMS = Math.sqrt(sumRMS2 / numSlices);
  const crestRatio = maxAbsSample / (avgRMS + 1e-6);
  const crestFactorDb = Math.max(0.0, 20 * Math.log10(crestRatio));

  // ステレオ相関値 (-1.0 〜 +1.0)
  let avgCorrelation = 1.0;
  if (totalEnergyL2 > 0 && totalEnergyR2 > 0) {
    avgCorrelation = totalDotProduct / Math.sqrt(totalEnergyL2 * totalEnergyR2);
    avgCorrelation = Math.max(-1.0, Math.min(1.0, avgCorrelation));
  }

  // 2. 周波数帯域別エネルギーの集計（音楽音響工学に基づいた4バンド分割）
  // Bass (低域基礎): 20Hz - 160Hz
  // Low-Mids (基音・温かみ・厚み): 160Hz - 800Hz
  // High-Mids (母音・倍音・存在感): 800Hz - 5,000Hz (聴覚感度が最も高いエリア)
  // Treble (空気感・煌びやかさ): 5,000Hz - 20,000Hz
  const binSub = Math.floor((20 * fftSize) / sampleRate);
  const binBassEnd = Math.floor((160 * fftSize) / sampleRate);
  const binMidStart = binBassEnd + 1;
  const binMidEnd = Math.floor((800 * fftSize) / sampleRate);
  const binHighMidStart = binMidEnd + 1;
  const binHighMidEnd = Math.floor((5000 * fftSize) / sampleRate);
  const binAirStart = binHighMidEnd + 1;
  const binAirEnd = Math.min(fftSize / 2 - 1, Math.floor((20000 * fftSize) / sampleRate));

  let bassSum = 0;
  for (let j = binSub; j <= binBassEnd; j++) bassSum += avgSpectrum[j];
  const energyBass = bassSum / (binBassEnd - binSub + 1);

  let lowMidSum = 0;
  for (let j = binMidStart; j <= binMidEnd; j++) lowMidSum += avgSpectrum[j];
  const energyLowMid = lowMidSum / (binMidEnd - binMidStart + 1);

  let highMidSum = 0;
  for (let j = binHighMidStart; j <= binHighMidEnd; j++) highMidSum += avgSpectrum[j];
  const energyHighMid = highMidSum / (binHighMidEnd - binHighMidStart + 1);

  let trebleSum = 0;
  for (let j = binAirStart; j <= binAirEnd; j++) trebleSum += avgSpectrum[j];
  const energyTreble = trebleSum / (binAirEnd - binAirStart + 1);

  // 実際のエネルギー比率 (中低域/ローミッドを基準とする)
  const actualLowMidRatio = energyBass / (energyLowMid + 1e-6);
  const actualHighMidRatio = energyTreble / (energyLowMid + 1e-6);
  const actualPresenceRatio = energyHighMid / (energyLowMid + 1e-6);

  // Noise Floor Estimation in the quietest segment
  let minRmsIdx = 0;
  let minRmsVal = 1.0;
  for (let i = 0; i < sliceRMSList.length; i++) {
    if (sliceRMSList[i] < minRmsVal) {
      minRmsVal = sliceRMSList[i];
      minRmsIdx = i;
    }
  }

  // Hiss estimation (amplitude average between 6kHz and 15kHz in the quietest block)
  const binHissStart = Math.floor((6000 * fftSize) / sampleRate);
  const binHissEnd = Math.floor((15000 * fftSize) / sampleRate);
  let hissSum = 0;
  for (let j = binHissStart; j <= binHissEnd; j++) {
    hissSum += sliceSpectrums[minRmsIdx][j];
  }
  const hissNoiseFloor = hissSum / (binHissEnd - binHissStart + 1);
  const hissNoiseFloorDb = 20 * Math.log10(hissNoiseFloor + 1e-6) + 26.0; // Added FFT bin bandwidth gain correction factor (+26dB) to align bin average with broadband level

  // Rumble estimation (amplitude average between 20Hz and 60Hz in the quietest block)
  const binRumbleStart = Math.floor((20 * fftSize) / sampleRate);
  const binRumbleEnd = Math.floor((60 * fftSize) / sampleRate);
  let rumbleSum = 0;
  for (let j = binRumbleStart; j <= binRumbleEnd; j++) {
    rumbleSum += sliceSpectrums[minRmsIdx][j];
  }
  const rumbleNoiseFloor = rumbleSum / (binRumbleEnd - binRumbleStart + 1);
  const rumbleNoiseFloorDb = 20 * Math.log10(rumbleNoiseFloor + 1e-6) + 26.0; // Added FFT bin bandwidth gain correction factor (+26dB) to align bin average with broadband level

  // Suggested values (ノイズ検出時にのみONにし、ノイズ未検出時は完全にOFFのままにする仕様へ復元)
  let sugRumbleCut = false;
  if (rumbleNoiseFloorDb > -58.0) {
    sugRumbleCut = true;
  }

  let sugHissAmount = 0;
  if (hissNoiseFloorDb > -73.0) { // Lowered threshold from -68dB to -73dB for higher sensitivity
    // -73dB で 0%、-40dB で最大 90% になるよう調整（3.5倍スケール）
    const rawHiss = Math.round(Math.max(0, Math.min(90, (hissNoiseFloorDb + 73.0) * 3.5)));
    
    // 静寂区間（最も静かな1秒間）のRMS音量が比較的高い場合、それはヒスではなく楽曲の音（シンセパッドやエフェクトの残響等）である可能性が高いため
    // LPFの過剰カットを防ぐため、Hiss Reducerの適用度を減衰する安全スケーラー
    let quietnessScale = 1.0;
    if (minRmsVal > 0.05) {
      // 最低RMSが 0.05（約-26dBFS）〜0.13（約-17dBFS）の間で、スケール値を 1.0 から 0.50 まで滑らかに減衰（適用量をより敏感に残すように調整）
      quietnessScale = Math.max(0.50, 1.0 - (minRmsVal - 0.05) / 0.08);
    }
    sugHissAmount = Math.round(rawHiss * quietnessScale);
  }

  // Pro Clean: 8連サージカルノッチフィルターはバイパスしますが、サ行のキンキン音（sibilance）を検知して高域EQのブーストを安全クランプするためにスキャンを実行します
  const filteredPeaks = [];
  let sibilanceDynamicFreq = 0;
  
  const sibilanceMinBin = Math.floor((8000 * fftSize) / sampleRate);
  const sibilanceMaxBin = Math.min(fftSize / 2 - 1, Math.floor((11000 * fftSize) / sampleRate));
  const rawSibilancePeaks = [];
  
  for (let j = sibilanceMinBin; j <= sibilanceMaxBin; j++) {
    const val = avgSpectrum[j];
    const peakFreq = Math.round((j * sampleRate) / fftSize);
    if (val > avgSpectrum[j - 1] && val > avgSpectrum[j + 1]) {
      const localBins = [
        avgSpectrum[j - 3], avgSpectrum[j - 2],
        avgSpectrum[j + 2], avgSpectrum[j + 3]
      ];
      const localFloor = localBins.reduce((sum, v) => sum + v, 0) / localBins.length;
      const ratio = val / (localFloor + 1e-9);
      if (ratio > 1.15) {
        rawSibilancePeaks.push({ freq: peakFreq, score: ratio });
      }
    }
  }
  if (rawSibilancePeaks.length > 0) {
    rawSibilancePeaks.sort((a, b) => b.score - a.score);
    sibilanceDynamicFreq = rawSibilancePeaks[0].freq;
  }
  // 3.5. AIジャンル自動判定 (Heuristic Genre Classifier)
  let detectedGenre = 'pops';
  if (actualLowMidRatio > 3.2 && actualHighMidRatio > 0.16 && crestFactorDb < 12.8) {
    detectedGenre = 'edm';
  } else if (actualLowMidRatio > 3.1 && actualHighMidRatio <= 0.16 && crestFactorDb < 12.8) {
    detectedGenre = 'hiphop';
  } else if (actualLowMidRatio >= 1.6 && actualLowMidRatio <= 3.3 && crestFactorDb < 15.5) {
    if (crestFactorDb >= 12.8) {
      if (actualLowMidRatio >= 2.4 && actualLowMidRatio <= 3.1 && avgCorrelation > 0.75 && actualHighMidRatio < 0.12) {
        detectedGenre = 'jazz';
      } else if (actualLowMidRatio < 2.4 && avgCorrelation > 0.75 && actualHighMidRatio < 0.12) {
        detectedGenre = 'acoustic';
      } else {
        detectedGenre = (actualHighMidRatio > 0.14) ? 'metal' : 'rock';
      }
    } else {
      if (actualHighMidRatio >= 0.11) {
        detectedGenre = (actualHighMidRatio > 0.14) ? 'metal' : 'rock';
      } else {
        detectedGenre = 'pops';
      }
    }
  } else if (crestFactorDb >= 13.0) {
    if (actualLowMidRatio < 2.2 && actualHighMidRatio < 0.12) {
      detectedGenre = 'classic';
    } else if (actualHighMidRatio > 0.18 && actualLowMidRatio < 2.8) {
      detectedGenre = 'ambient';
    } else {
      detectedGenre = 'acoustic';
    }
  } else if (actualLowMidRatio < 2.0 && actualHighMidRatio < 0.10) {
    detectedGenre = 'podcast';
  } else {
    detectedGenre = 'pops';
  }

  const genreSelect = document.getElementById('preset-select');
  const userGenreKey = userPresetKey || (genreSelect ? genreSelect.value : 'auto');
  const genreKey = (userGenreKey === 'auto' || userGenreKey === 'custom') ? 'auto' : userGenreKey;
  const basePreset = GENRE_PRESETS[genreKey] || GENRE_PRESETS.auto;

   // 3. 音楽理論・等ラウドネス曲線に基づいたリファレンス目標値 (Refactored Golden Targets)
  // low: Bass/LowMid 比率 (目標 +8.9dB 付近)
  // high: Treble/LowMid 比率 (目標 -17.1dB 付近)
  // presence: HighMid/LowMid 比率 (目標 -6.9dB 付近)
  const genreTargets = {
    auto: { low: 2.8, high: 0.12, presence: 0.42 },     // AI AUTO: スタディオリファレンス・フラット (高域ターゲットを0.14➔0.12に微調整)
    pops: { low: 2.6, high: 0.14, presence: 0.44 },     // POPS: ボーカル明瞭、高音は煌びやか (0.16➔0.14)
    rnb: { low: 3.2, high: 0.13, presence: 0.41 },      // R&B: サブベース強調、中高域は控えめ (0.15➔0.13)
    rock: { low: 2.9, high: 0.11, presence: 0.43 },     // ROCK: キック厚め、エッジの効いた中音 (0.13➔0.11)
    metal: { low: 3.0, high: 0.13, presence: 0.42 },    // METAL: 重厚な低域とエッジの効いた高域 (0.15➔0.13)
    edm: { low: 3.2, high: 0.14, presence: 0.40 },      // EDM: 太いサブベース、高域シンセのヌケ (0.16➔0.14)
    hiphop: { low: 3.3, high: 0.11, presence: 0.38 },   // HIPHOP: 極太ローエンド、ボーカルフォーカス (0.13➔0.11)
    lofi: { low: 3.1, high: 0.07, presence: 0.36 },     // LOFI: 温かみのある中低域、ナローな高域 (0.08➔0.07)
    hardcore: { low: 3.2, high: 0.15, presence: 0.42 }, // HARDCORE: 極限のクラブ音圧、サチュレーション (0.18➔0.15)
    ambient: { low: 2.9, high: 0.17, presence: 0.44 },  // AMBIENT: ワイドで広がりのある空気感 (0.20➔0.17)
    podcast: { low: 1.6, high: 0.09, presence: 0.47 },  // PODCAST: 会話明瞭、低域カット (0.10➔0.09)
    classic: { low: 2.2, high: 0.10, presence: 0.39 },  // CLASSIC: ナチュラルの強弱、広い奥行き (0.11➔0.10)
    jazz: { low: 2.7, high: 0.11, presence: 0.41 },     // JAZZ: 有機的なウッドベースと生音感 (0.12➔0.11)
    acoustic: { low: 2.4, high: 0.12, presence: 0.43 }, // ACOUSTIC: 繊細な弦の響きと生楽器の共鳴 (0.13➔0.12)
    custom: { low: 2.8, high: 0.12, presence: 0.42 }
  };
  const target = genreTargets[genreKey] || genreTargets.auto;

  // 各帯域のエネルギー差分（dB換算）
  const lowDiffDb = 20 * Math.log10(actualLowMidRatio / target.low);
  const highDiffDb = 20 * Math.log10(actualHighMidRatio / target.high);
  const targetPresence = target.presence || 0.45;
  const presenceDiffDb = 20 * Math.log10(actualPresenceRatio / targetPresence);

  // 3バンドEQ補正量の算出 (等ラウドネス曲線からの偏差に応じてクローズドループで補正)
  // 低域: Bassが多すぎる場合は下げ、足りない場合は持ち上げる
  let eqLowAdjustment = 0;
  if (lowDiffDb > 0.5) {
    eqLowAdjustment = -Math.min(3.5, lowDiffDb * 0.75); // マイルドに下げる
  } else if (lowDiffDb < -0.5) {
    eqLowAdjustment = Math.min(2.2, -lowDiffDb * 0.75); // 不足分を足す（最大+2.2dBに制限）
  }
  const eqLowGain = Math.max(-5.0, Math.min(3.0, Math.round((basePreset.eqLowGain + eqLowAdjustment) * 2) / 2));

  // 中域 (High-Mids/Presence): 聴覚感度が最も高い帯域の補正
  let eqMidAdjustment = 0;
  if (presenceDiffDb > 0.5) {
    eqMidAdjustment = -Math.min(1.8, presenceDiffDb * 0.5); // 派手すぎる場合は中域を抑えてマイルドに（最大-1.8dB）
  } else if (presenceDiffDb < -0.5) {
    eqMidAdjustment = Math.min(1.2, -presenceDiffDb * 0.45); // こもっている場合はマイルドに補強（最大+1.2dB）
  }
  const eqMidGain = Math.max(-4.0, Math.min(1.5, Math.round((basePreset.eqMidGain + eqMidAdjustment) * 2) / 2)); // 中音域が強くなりすぎないよう最大値を+1.5dBにクランプ

  // 高域: Highが派手すぎる場合は下げ、こもっている場合は持ち上げる
  let eqHighAdjustment = 0;
  if (highDiffDb > 0.5) {
    eqHighAdjustment = -Math.min(2.0, highDiffDb * 0.5); // 派手すぎる場合はマイルドに減衰（最大-2.0dB）
  } else if (highDiffDb < -0.5) {
    eqHighAdjustment = Math.min(1.5, -highDiffDb * 0.45); // 不足している場合はマイルドに補強（最大+1.5dB）
  }
  let eqHighGain = Math.max(-5.0, Math.min(2.0, Math.round((basePreset.eqHighGain + eqHighAdjustment) * 2) / 2)); // キンキンしすぎないよう最大ブースト量を+2.0dBに制限

  // 現在選択されているラウドネス・ターゲットの取得と基準ブースト値の設定
  const loudnessKey = typeof baseLoudnessTarget !== 'undefined' ? baseLoudnessTarget : (document.getElementById('loudness-select')?.value || 'genre');
  let baseBoost = 4.0;
  let baseLoudnessDesc = "STREAMING (-14 LUFS)";
  
  if (loudnessKey === 'genre') {
    baseBoost = basePreset.limiterBoost;
    const genreName = genreKey.toUpperCase();
    baseLoudnessDesc = `GENRE DEFAULT (${genreName}: +${baseBoost.toFixed(1)} dB)`;
  } else if (LOUDNESS_TARGETS[loudnessKey] && LOUDNESS_TARGETS[loudnessKey].boost !== null) {
    baseBoost = LOUDNESS_TARGETS[loudnessKey].boost;
    const targetNames = {
      streaming: "STREAMING (-14 LUFS)",
      club: "CLUB/MODERN (-9 LUFS)",
      loud: "LOUD (-7 LUFS)",
      pure: "PURE (-18 LUFS)"
    };
    baseLoudnessDesc = targetNames[loudnessKey] || `TARGET (+${baseBoost.toFixed(1)} dB)`;
  } else {
    baseBoost = params.limiterBoost;
    baseLoudnessDesc = `CUSTOM (+${baseBoost.toFixed(1)} dB)`;
  }

  // ダイナミクス補正 (音楽理論・ダイナミックレンジ基準によるクレストファクター分析)
  let compThreshold = basePreset.compThreshold;
  let compRatio = basePreset.compRatio;
  let limiterBoost = baseBoost;
  let crestDesc = "Normal (Balanced)";

  // ジャンル別理想ターゲット・クレストファクター（強弱の幅）
  const genreTargetCrest = {
    auto: 10.5,     // AI AUTO: リファレンス中立（適正ダイナミクス）
    pops: 11.0,     // POPS: 標準的なポップス
    rnb: 10.0,      // R&B: 低域圧縮とグルーヴ
    rock: 11.0,     // ROCK: 生ドラムのパンチ感を残す
    metal: 9.5,     // METAL: 音圧の壁とタイトさ
    edm: 8.5,       // EDM: クラブ向けの均一で高い音圧
    hiphop: 9.0,    // HIPHOP: キックの抜けとアタック重視
    lofi: 12.0,     // LOFI: 生音の暖かみ・広がり
    hardcore: 7.5,  // HARDCORE: 最大限の押し込み
    ambient: 13.5,  // AMBIENT: 広い強弱と空気感
    podcast: 10.5,  // PODCAST: 会話の聞き取りやすさ優先
    classic: 14.5,  // CLASSIC: 生楽器のダイナミクスを最大限活かす
    jazz: 12.5,     // JAZZ: アコースティックなニュアンス
    acoustic: 13.0, // ACOUSTIC: ピッキング等の生々しさ
    custom: 10.5
  };
  const targetCrest = genreTargetCrest[genreKey] || genreTargetCrest.auto;

  const crestDiff = crestFactorDb - targetCrest;
  if (crestDiff > 0.0) {
    // 音源がターゲットよりもダイナミック（強弱が広い） -> コンプレッサーのしきい値を下げ、リミッターのブースト量を増やして適正レベルに収束させる
    const compressionFactor = Math.min(6.0, crestDiff * 0.4); // 最大-6dBしきい値を下げる
    const ratioFactor = Math.min(0.2, crestDiff * 0.05);     // 圧縮比もマイルドに加算
    compThreshold = Math.max(-14.0, basePreset.compThreshold - compressionFactor);
    compRatio = Math.min(1.6, basePreset.compRatio + ratioFactor);
    crestDesc = "High (Highly Dynamic)";
    
    // リミッターを適正にドライブして音圧を出す
    const bonus = Math.min(3.5, crestDiff * 0.75);
    limiterBoost = baseBoost + bonus;
  } else {
    // 音源がすでに強く圧縮されている -> 二重圧縮での音割れを防ぐため、コンプレッサーを逃がし（浅くし）、ブーストも下げる
    const releaseFactor = Math.min(4.0, -crestDiff * 0.5);
    const ratioFactor = Math.min(0.2, -crestDiff * 0.05);
    compThreshold = Math.min(-5.0, basePreset.compThreshold + releaseFactor);
    compRatio = Math.max(1.15, basePreset.compRatio - ratioFactor);
    crestDesc = "Low (Highly Compressed)";
    
    const penalty = Math.min(3.0, -crestDiff * 0.6);
    limiterBoost = Math.max(1.5, baseBoost - penalty);
  }

  // 低域飽和による音割れ・ビビリ防止（低域が基準ターゲットより著しく大きい場合、リミッターブーストを自動で控えめにする）
  if (lowDiffDb > 1.0) {
    const bassOverloadPenalty = Math.min(1.5, (lowDiffDb - 1.0) * 0.75);
    limiterBoost = Math.max(2.0, limiterBoost - bassOverloadPenalty);
  }

  // 0.0〜10.0dB の範囲に制限し（歪み防止のため最大値を10dBに抑制）、小数点第一位に丸める
  limiterBoost = Math.max(0.0, Math.min(10.0, Math.round(limiterBoost * 10) / 10));

  // ステレオ幅の補正 (位相相関に基づいた連続的スケーリング)
  let stereoWidth = basePreset.stereoWidth;
  let corrDesc = "Balanced";
  
  if (avgCorrelation > 0.82) {
    // 位相がほぼセンターに集まっている（モノラルに近い）-> 音源の広がり不足に応じて自動拡張
    const expansion = Math.min(0.25, (avgCorrelation - 0.82) * 1.5);
    stereoWidth = Math.min(1.4, basePreset.stereoWidth + expansion);
    corrDesc = "Mono-leaning (Expanded)";
  } else if (avgCorrelation < 0.72) {
    // ライブ音源やリバーブで既に左右に広がりすぎている -> コムフィルターや歪みを防ぐため、1.0（等倍）以下にクランプする
    const reduction = Math.min(0.2, (0.72 - avgCorrelation) * 0.8);
    stereoWidth = Math.max(0.85, Math.min(1.0, basePreset.stereoWidth - 0.2 - reduction));
    corrDesc = "Wide/Phasey (Clamped)";
  } else {
    corrDesc = "Balanced Stereo";
  }

  // サチュレーター微調整 (高域の量に応じて歪みの強さを補正)
  let satDrive = basePreset.satDrive;
  let satMix = basePreset.satMix;
  if (highDiffDb > 1.5) {
    // 元々高域がかなり明るい（またはうるさい）曲の場合、サチュレーションを抑えて金属的なキツさを防ぐ
    satDrive = Math.max(1, basePreset.satDrive - 5);
    satMix = Math.max(0, basePreset.satMix - 8);
  } else if (highDiffDb < -1.5) {
    // 高域がこもっている曲の場合、サチュレーターのブレンド率とドライブを少し上げて倍音を付加する
    satDrive = Math.min(100, basePreset.satDrive + 5);
    satMix = Math.min(100, basePreset.satMix + 5);
  }

  // 入力音量の自動ゲインステージング（ピークを-6.0dBに合わせることで歪みを防ぎ、ヘッドルームを確保する）
  const originalPeakDb = 20 * Math.log10(maxAbsSample + 1e-6);
  const suggestedInputGainDb = Math.max(-12.0, Math.min(12.0, -6.0 - originalPeakDb));

  // High Shelf Frequency Dynamic Calculation
  const bin4k = Math.floor((4000 * fftSize) / sampleRate);
  const bin9k = Math.floor((9000 * fftSize) / sampleRate);
  const bin18k = Math.floor((18000 * fftSize) / sampleRate);

  let brillianceSum = 0;
  for (let j = bin4k; j <= bin9k; j++) brillianceSum += avgSpectrum[j];
  const brillianceEnergy = brillianceSum / (bin9k - bin4k + 1);

  let airSum = 0;
  for (let j = bin9k + 1; j <= bin18k; j++) airSum += avgSpectrum[j];
  const airEnergy = airSum / (bin18k - bin9k);

  const airToBrillianceRatio = airEnergy / (brillianceEnergy + 1e-6);

  let suggestedEqHighFreq = basePreset.eqHighFreq;

  if (actualHighMidRatio < 0.10) {
    // High-mids are extremely dull overall -> Pull down the shelf to boost from 8.0kHz
    suggestedEqHighFreq = 8000;
  } else if (airToBrillianceRatio < 0.16) {
    // Air drops off sharply compared to mid-highs -> Target the transition around 9.5kHz
    suggestedEqHighFreq = 9500;
  } else if (airToBrillianceRatio > 0.32) {
    // Air is already present, but could use air-band finish -> Target 12kHz
    suggestedEqHighFreq = 12000;
  } else {
    // Normal balanced spectrum -> Target standard 10kHz or preset default
    suggestedEqHighFreq = Math.round((basePreset.eqHighFreq || 10000) / 500) * 500;
  }

  // Clamp within safe high shelf ranges (7,500Hz to 13,000Hz)
  suggestedEqHighFreq = Math.max(7500, Math.min(13000, suggestedEqHighFreq));

  // 4. Stereo Bass phase cancellation safeguard (ビビリ音・歪み防止)
  let finalEqLowGain = eqLowGain;
  let finalLimiterBoost = limiterBoost;
  let finalSideHPF = basePreset.sideHighPassFreq || 110;
  
  if (avgCorrelation < 0.72) {
    // 左右の位相ズレが大きい（広いL/R Bass / 深いリバーブ等）場合、
    // モノラル加算時の相関キャンセリングによるAI過剰EQブーストと、L/R個別ピークのソフトクリッパー限界突破（ビビリ音）を防ぐための補正
    
    // 1. 低域EQブーストを厳格に制限（位相ズレがある場合は低域ブースト上限を最大+1.0dB、深刻な場合は+0.0dBに固定）
    const maxLowBoost = avgCorrelation < 0.60 ? 0.0 : 1.0;
    finalEqLowGain = Math.min(maxLowBoost, finalEqLowGain);
    
    // 2. マキシマイザーの押し込み量（Limiter Boost）に位相相関ペナルティを適用
    const phasePenalty = (0.75 - avgCorrelation) * 4.0; // ズレが大きいほどマキシマイザーを緩和（最大2.0dB以上引き下げ）
    finalLimiterBoost = Math.max(1.5, finalLimiterBoost - phasePenalty);
    
    // 3. Sideチャンネルのハイパス周波数を引き上げ（低域をセンターモノラルに集約し、L/R独立クリップを根本防止）
    finalSideHPF = Math.max(160, finalSideHPF);
  }
  
  finalLimiterBoost = Math.round(finalLimiterBoost * 10) / 10;

  return {
    detected: filteredPeaks.length > 0,
    notches: filteredPeaks,
    crestFactor: crestFactorDb,
    crestDesc: crestDesc,
    correlation: avgCorrelation,
    correlationDesc: corrDesc,
    bassDiff: lowDiffDb,
    trebleDiff: highDiffDb,
    rumbleNoiseFloorDb: rumbleNoiseFloorDb,
    hissNoiseFloorDb: hissNoiseFloorDb,
    baseLoudnessDesc: baseLoudnessDesc,
    detectedGenre: detectedGenre,
    suggestedParams: {
      inputGainDb: Math.round(suggestedInputGainDb * 10) / 10,
      satEnabled: basePreset.satEnabled,
      satType: basePreset.satType,
      satDrive: satDrive,
      satMix: satMix,
      eqLowGain: finalEqLowGain,
      eqLowFreq: basePreset.eqLowFreq,
      eqMidGain: eqMidGain,
      eqMidFreq: basePreset.eqMidFreq,
      eqMidQ: basePreset.eqMidQ || 1.0,
      eqHighGain: eqHighGain,
      eqHighFreq: suggestedEqHighFreq,
      compEnabled: basePreset.compEnabled,
      compThreshold: compThreshold,
      compRatio: compRatio,
      compAttack: basePreset.compAttack,
      compRelease: basePreset.compRelease,
      stereoWidth: stereoWidth,
      sideHighPassFreq: finalSideHPF,
      limiterBoost: finalLimiterBoost,
      rumbleCutEnabled: sugRumbleCut,
      hissReductionAmount: sugHissAmount,
      sibilanceDynamicFreq: sibilanceDynamicFreq
    }
  };
}

// ==========================================================================
// PRESET LOADER
// ==========================================================================
function loadGenrePreset(genreKey) {
  if (genreKey === 'custom') return;
  const p = GENRE_PRESETS[genreKey];
  if (!p) return;

  // 1. Copy presets into current params (or load dynamic AI suggested baseline if available and key is auto)
  const isAiAutoActive = (genreKey === 'auto' && aiSuggestedParams !== null);
  const src = isAiAutoActive ? aiSuggestedParams : p;

  params.satEnabled = src.satEnabled;
  params.satType = src.satType;
  params.satDrive = src.satDrive;
  params.satMix = src.satMix;
  
  params.eqLowGain = src.eqLowGain;
  params.eqLowFreq = src.eqLowFreq;
  params.eqMidGain = src.eqMidGain;
  params.eqMidFreq = src.eqMidFreq;
  params.eqMidQ = src.eqMidQ || 1.0;
  params.eqHighGain = src.eqHighGain;
  params.eqHighFreq = src.eqHighFreq;
  
  params.compEnabled = src.compEnabled;
  params.compThreshold = src.compThreshold;
  params.compRatio = src.compRatio;
  params.compAttack = src.compAttack;
  params.compRelease = src.compRelease;
  
  params.stereoWidth = src.stereoWidth;
  params.sideHighPassFreq = src.sideHighPassFreq || 110;
  
  // Only override input gain, noise cleaner and limiter boost if loading the AI suggested baseline
  if (isAiAutoActive) {
    params.inputGainDb = aiSuggestedParams.inputGainDb;
    params.rumbleCutEnabled = aiSuggestedParams.rumbleCutEnabled;
    params.hissReductionAmount = aiSuggestedParams.hissReductionAmount;
    params.limiterBoost = aiSuggestedParams.limiterBoost;
    params.sibilanceDynamicFreq = aiSuggestedParams.sibilanceDynamicFreq || 0;
    // Set UI badge to show detected genre
    const genreBadge = document.getElementById('ai-detected-genre-badge');
    if (genreBadge && aiDetectedGenre) {
      genreBadge.innerText = aiDetectedGenre.toUpperCase();
    }
  } else {
    // 楽曲自体のノイズ状態はプリセット変更で変わらないため、AI検出済みのノイズクリーナー設定があれば継承し、なければOFFにする
    if (aiSuggestedParams !== null) {
      params.rumbleCutEnabled = aiSuggestedParams.rumbleCutEnabled;
      params.hissReductionAmount = aiSuggestedParams.hissReductionAmount;
      params.sibilanceDynamicFreq = aiSuggestedParams.sibilanceDynamicFreq || 0;
    } else {
      params.rumbleCutEnabled = false;
      params.hissReductionAmount = 0;
      params.sibilanceDynamicFreq = 0;
    }
    
    // Reset UI badge back to AUTO if loading normal auto template or another preset
    const genreBadge = document.getElementById('ai-detected-genre-badge');
    if (genreBadge) {
      genreBadge.innerText = genreKey === 'auto' ? 'AUTO' : genreKey.toUpperCase();
    }
    
    // Preserve or set limiter boost based on loudness target selection
    const loudnessSelect = document.getElementById('loudness-select');
    const loudnessKey = loudnessSelect ? loudnessSelect.value : 'genre';
    
    if (loudnessKey === 'genre') {
      params.limiterBoost = p.limiterBoost;
    } else if (LOUDNESS_TARGETS[loudnessKey] && LOUDNESS_TARGETS[loudnessKey].boost !== null) {
      params.limiterBoost = LOUDNESS_TARGETS[loudnessKey].boost;
    }
  }

  // AI Corrective Notches and AI report panel are preserved during preset switching to allow interactive comparison

  // 2. Refresh HTML Controls
  updateGuiControls();
  
  // 3. Update Audio DSP
  updateInputGainNode();
  updateNoiseCutNodes();
  updateSaturatorNode();
  updateEqNodes();
  updateCompressorNode();
  updateStereoWidthNode();
  updateLimiterGainNode();
  updateCeilingNode();
}

function applyLoudnessTarget(targetKey) {
  if (targetKey === 'custom') return;
  
  if (targetKey === 'genre') {
    const genreSelect = document.getElementById('preset-select');
    const genreKey = genreSelect ? genreSelect.value : 'auto';
    const p = GENRE_PRESETS[genreKey] || GENRE_PRESETS.auto;
    params.limiterBoost = p.limiterBoost;
  } else {
    const t = LOUDNESS_TARGETS[targetKey];
    if (!t) return;
    params.limiterBoost = t.boost;
  }
  
  // Update GUI
  document.getElementById('limiter-gain').value = params.limiterBoost;
  document.getElementById('limiter-gain-val').innerText = `+${params.limiterBoost.toFixed(1)} dB`;
  
  // Update DSP
  updateLimiterGainNode();
}

// ==========================================================================
// MP3 ENCODING UTILITY (lamejs)
// ==========================================================================
function bufferToMp3(audioBuffer, bitrate) {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  
  // Create LAME encoder
  const mp3encoder = new window.lamejs.Mp3Encoder(channels, sampleRate, bitrate);
  
  const mp3Data = [];
  const sampleBlockSize = 1152;
  
  const left = audioBuffer.getChannelData(0);
  const right = channels > 1 ? audioBuffer.getChannelData(1) : left;
  
  // Helper to convert float samples [-1, 1] to 16-bit Int16Array
  const convertSample = (s) => {
    if (s > 1.0) s = 1.0;
    else if (s < -1.0) s = -1.0;
    return s < 0 ? s * 0x8000 : s * 0x7FFF;
  };
  
  const leftInt = new Int16Array(left.length);
  const rightInt = new Int16Array(right.length);
  
  for (let i = 0; i < left.length; i++) {
    leftInt[i] = convertSample(left[i]);
    if (channels > 1) {
      rightInt[i] = convertSample(right[i]);
    }
  }
  
  for (let i = 0; i < leftInt.length; i += sampleBlockSize) {
    const leftChunk = leftInt.subarray(i, i + sampleBlockSize);
    const rightChunk = rightInt.subarray(i, i + sampleBlockSize);
    
    let mp3buf;
    if (channels === 2) {
      mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
    } else {
      mp3buf = mp3encoder.encodeBuffer(leftChunk);
    }
    
    if (mp3buf.length > 0) {
      mp3Data.push(new Int8Array(mp3buf));
    }
  }
  
  const mp3buf = mp3encoder.flush();
  if (mp3buf.length > 0) {
    mp3Data.push(new Int8Array(mp3buf));
  }
  
  return new Blob(mp3Data, { type: 'audio/mp3' });
}

// ==========================================================================
// OFFLINE WAV & MP3 EXPORT RENDERER
// ==========================================================================
async function renderMasteredTrack() {
  if (!audioBuffer) return;
  
  const format = document.getElementById('export-format').value;
  
  // Show UI progress
  const exportBtn = document.getElementById('btn-export');
  const progressContainer = document.getElementById('export-progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const progressPercent = document.getElementById('export-percentage');
  
  exportBtn.disabled = true;
  progressContainer.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressPercent.innerText = '0%';

  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const duration = audioBuffer.duration;
  
  // Create offline context matching the source file
  const offlineCtx = new OfflineAudioContext(numChannels, sampleRate * duration, sampleRate);
  
  // Create offline buffer source
  const offlineSource = offlineCtx.createBufferSource();
  offlineSource.buffer = audioBuffer;
  
  // Set up the EXACT same signal chain in the offline context
  const offlineChain = setupMasteringChain(offlineCtx, offlineSource, getCombinedParams());
  offlineChain.outputNode.connect(offlineCtx.destination);
  
  offlineSource.start(0);

  // Poll progress (Web Audio doesn't have native progress callbacks, so we estimate)
  let progressPoll = setInterval(() => {
    // Offline rendering in browser is normally extremely fast, but we draw a smooth mock indicator
    let curWidth = parseFloat(progressFill.style.width) || 0;
    if (curWidth < 90) {
      curWidth += 15;
      progressFill.style.width = `${curWidth}%`;
      progressPercent.innerText = `${curWidth}%`;
    }
  }, 100);

  try {
    const renderedBuffer = await offlineCtx.startRendering();
    clearInterval(progressPoll);
    
    progressFill.style.width = '95%';
    progressPercent.innerText = '95% (Encoding...)';
    
    // UIスレッドを一時的に解放して描画を更新させてから、重いエンコード処理に入る
    await new Promise(resolve => setTimeout(resolve, 50));
    
    let fileBlob;
    let fileExtension;
    
    if (format.startsWith('mp3')) {
      if (!window.lamejs) {
        logToUI("MP3 Encoder (lamejs) not loaded. Falling back to WAV.", "warning");
        alert("MP3エンコーダー（lamejs）が読み込めませんでした。WAV形式で保存します。");
        fileBlob = bufferToWav(renderedBuffer);
        fileExtension = 'wav';
      } else {
        const bitrate = format === 'mp3-320' ? 320 : 192;
        logToUI(`Encoding to MP3 (${bitrate} kbps)...`, "info");
        fileBlob = bufferToMp3(renderedBuffer, bitrate);
        fileExtension = 'mp3';
      }
    } else {
      logToUI("Encoding to WAV (16-bit PCM)...", "info");
      fileBlob = bufferToWav(renderedBuffer);
      fileExtension = 'wav';
    }
    
    progressFill.style.width = '100%';
    progressPercent.innerText = '100%';
    
    const downloadUrl = URL.createObjectURL(fileBlob);
    
    // Auto download trigger
    const link = document.createElement('a');
    link.href = downloadUrl;
    
    const origName = document.getElementById('file-input').files[0]?.name || 'aether_master.wav';
    const baseName = origName.substring(0, origName.lastIndexOf('.')) || origName;
    link.download = `mastered_${baseName}.${fileExtension}`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    document.getElementById('status-text').innerText = 'RENDER COMPLETE';
    logToUI(`Mastered file exported successfully as ${fileExtension.toUpperCase()}`, "info");
    
    // Auto reset uploader after 2 seconds
    setTimeout(() => {
      progressContainer.classList.add('hidden');
      exportBtn.disabled = false;
    }, 2000);
    
  } catch (error) {
    clearInterval(progressPoll);
    console.error('Offline rendering failed:', error);
    alert('エクスポートのレンダリング中にエラーが発生しました。');
    progressContainer.classList.add('hidden');
    exportBtn.disabled = false;
  }
}

// ==========================================================================
// GUI CONTROLLER BINDINGS & SYNCS
// ==========================================================================
function updateGuiControls() {
  // Input / Ceiling
  document.getElementById('input-gain-slider').value = params.inputGainDb;
  document.getElementById('input-gain-val').innerText = `${params.inputGainDb >= 0 ? '+' : ''}${params.inputGainDb.toFixed(1)} dB`;
  document.getElementById('ceiling-slider').value = params.ceiling;
  document.getElementById('ceiling-val').innerText = `${params.ceiling.toFixed(1)} dB`;
  
  // Saturator
  document.getElementById('sat-enable').checked = params.satEnabled;
  document.getElementById('sat-type').value = params.satType;
  document.getElementById('sat-drive-slider').value = params.satDrive;
  document.getElementById('sat-drive-val').innerText = `${params.satDrive}%`;
  document.getElementById('sat-mix-slider').value = params.satMix;
  document.getElementById('sat-mix-val').innerText = `${params.satMix}%`;
  
  // EQ
  document.getElementById('eq-low-gain').value = params.eqLowGain;
  document.getElementById('eq-low-freq').value = params.eqLowFreq;
  document.getElementById('eq-low-val').innerText = `${params.eqLowGain >= 0 ? '+' : ''}${params.eqLowGain.toFixed(1)} dB`;
  
  document.getElementById('eq-mid-gain').value = params.eqMidGain;
  document.getElementById('eq-mid-freq').value = params.eqMidFreq;
  document.getElementById('eq-mid-val').innerText = `${params.eqMidGain >= 0 ? '+' : ''}${params.eqMidGain.toFixed(1)} dB`;
  document.getElementById('eq-mid-q').value = params.eqMidQ;
  document.getElementById('eq-mid-q-val').innerText = params.eqMidQ.toFixed(1);
  
  document.getElementById('eq-high-gain').value = params.eqHighGain;
  document.getElementById('eq-high-freq').value = params.eqHighFreq;
  document.getElementById('eq-high-val').innerText = `${params.eqHighGain >= 0 ? '+' : ''}${params.eqHighGain.toFixed(1)} dB`;
  
  // Compressor
  document.getElementById('comp-enable').checked = params.compEnabled;
  document.getElementById('comp-thresh').value = params.compThreshold;
  document.getElementById('comp-thresh-val').innerText = `${params.compThreshold.toFixed(1)} dB`;
  document.getElementById('comp-ratio').value = params.compRatio;
  document.getElementById('comp-ratio-val').innerText = `${params.compRatio.toFixed(1)}:1`;
  document.getElementById('comp-attack').value = params.compAttack;
  document.getElementById('comp-attack-val').innerText = `${Math.round(params.compAttack * 1000)} ms`;
  document.getElementById('comp-release').value = params.compRelease;
  document.getElementById('comp-release-val').innerText = `${Math.round(params.compRelease * 1000)} ms`;
  
  // Stereo Width
  document.getElementById('width-slider').value = params.stereoWidth;
  document.getElementById('width-val').innerText = `${Math.round(params.stereoWidth * 100)}%`;
  
  // Limiter Gain Boost
  document.getElementById('limiter-gain').value = params.limiterBoost;
  document.getElementById('limiter-gain-val').innerText = `+${params.limiterBoost.toFixed(1)} dB`;

  // Update Loudness Select dropdown if it mismatches
  const loudnessSelect = document.getElementById('loudness-select');
  if (loudnessSelect) {
    const curVal = loudnessSelect.value;
    if (curVal === 'genre') {
      const genreSelect = document.getElementById('preset-select');
      const genreKey = genreSelect ? genreSelect.value : 'auto';
      const p = GENRE_PRESETS[genreKey] || GENRE_PRESETS.auto;
      if (Math.abs(params.limiterBoost - p.limiterBoost) > 0.05) {
        loudnessSelect.value = 'custom';
      }
    } else if (curVal !== 'custom') {
      const target = LOUDNESS_TARGETS[curVal];
      if (!target || Math.abs(params.limiterBoost - target.boost) > 0.05) {
        loudnessSelect.value = 'custom';
      }
    }
  }

  // Noise Cleaner
  const rumbleCutEl = document.getElementById('rumble-cut-enable');
  if (rumbleCutEl) {
    rumbleCutEl.checked = params.rumbleCutEnabled;
  }
  const hissSliderEl = document.getElementById('hiss-reducer-slider');
  if (hissSliderEl) {
    hissSliderEl.value = params.hissReductionAmount;
  }
  const hissValEl = document.getElementById('hiss-reducer-val');
  if (hissValEl) {
    hissValEl.innerText = params.hissReductionAmount > 0 ? `${params.hissReductionAmount}%` : 'OFF';
  }
}

function updatePlayButtonUI(playing) {
  const btn = document.getElementById('btn-play-pause');
  if (playing) {
    btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    btn.className = 'ctrl-btn play-btn active';
  } else {
    btn.innerHTML = '<i class="fa-solid fa-play"></i>';
    btn.className = 'ctrl-btn play-btn';
  }
}

function registerGuiEvents() {
  const selectCustomPreset = () => {
    document.getElementById('preset-select').value = 'custom';
  };

  // Input Gain / Ceiling
  document.getElementById('input-gain-slider').addEventListener('input', (e) => {
    params.inputGainDb = parseFloat(e.target.value);
    document.getElementById('input-gain-val').innerText = `${params.inputGainDb >= 0 ? '+' : ''}${params.inputGainDb.toFixed(1)} dB`;
    updateInputGainNode();
  });

  document.getElementById('ceiling-slider').addEventListener('input', (e) => {
    params.ceiling = parseFloat(e.target.value);
    document.getElementById('ceiling-val').innerText = `${params.ceiling.toFixed(1)} dB`;
    updateCeilingNode();
  });

  // Noise Cleaner
  document.getElementById('rumble-cut-enable').addEventListener('change', (e) => {
    params.rumbleCutEnabled = e.target.checked;
    selectCustomPreset();
    updateNoiseCutNodes();
  });

  document.getElementById('hiss-reducer-slider').addEventListener('input', (e) => {
    params.hissReductionAmount = parseInt(e.target.value);
    document.getElementById('hiss-reducer-val').innerText = params.hissReductionAmount > 0 ? `${params.hissReductionAmount}%` : 'OFF';
    selectCustomPreset();
    updateNoiseCutNodes();
    updateCorrectiveEqNodes();
    updateEqNodes();
  });

  // Saturator
  document.getElementById('sat-enable').addEventListener('change', (e) => {
    params.satEnabled = e.target.checked;
    selectCustomPreset();
    updateSaturatorNode();
  });
  
  document.getElementById('sat-type').addEventListener('change', (e) => {
    params.satType = e.target.value;
    selectCustomPreset();
    updateSaturatorNode();
  });

  document.getElementById('sat-drive-slider').addEventListener('input', (e) => {
    params.satDrive = parseInt(e.target.value);
    document.getElementById('sat-drive-val').innerText = `${params.satDrive}%`;
    selectCustomPreset();
    updateSaturatorNode();
  });

  document.getElementById('sat-mix-slider').addEventListener('input', (e) => {
    params.satMix = parseInt(e.target.value);
    document.getElementById('sat-mix-val').innerText = `${params.satMix}%`;
    selectCustomPreset();
    updateSaturatorNode();
  });

  // EQ Low
  document.getElementById('eq-low-gain').addEventListener('input', (e) => {
    params.eqLowGain = parseFloat(e.target.value);
    document.getElementById('eq-low-val').innerText = `${params.eqLowGain >= 0 ? '+' : ''}${params.eqLowGain.toFixed(1)} dB`;
    selectCustomPreset();
    updateEqNodes();
  });
  document.getElementById('eq-low-freq').addEventListener('change', (e) => {
    params.eqLowFreq = Math.max(40, Math.min(250, parseInt(e.target.value)));
    e.target.value = params.eqLowFreq;
    selectCustomPreset();
    updateEqNodes();
  });

  // EQ Mid
  document.getElementById('eq-mid-gain').addEventListener('input', (e) => {
    params.eqMidGain = parseFloat(e.target.value);
    document.getElementById('eq-mid-val').innerText = `${params.eqMidGain >= 0 ? '+' : ''}${params.eqMidGain.toFixed(1)} dB`;
    selectCustomPreset();
    updateEqNodes();
  });
  document.getElementById('eq-mid-freq').addEventListener('change', (e) => {
    params.eqMidFreq = Math.max(300, Math.min(5000, parseInt(e.target.value)));
    e.target.value = params.eqMidFreq;
    selectCustomPreset();
    updateEqNodes();
  });

  document.getElementById('eq-mid-q').addEventListener('input', (e) => {
    params.eqMidQ = parseFloat(e.target.value);
    document.getElementById('eq-mid-q-val').innerText = params.eqMidQ.toFixed(1);
    selectCustomPreset();
    updateEqNodes();
  });

  // EQ High
  document.getElementById('eq-high-gain').addEventListener('input', (e) => {
    params.eqHighGain = parseFloat(e.target.value);
    document.getElementById('eq-high-val').innerText = `${params.eqHighGain >= 0 ? '+' : ''}${params.eqHighGain.toFixed(1)} dB`;
    selectCustomPreset();
    updateEqNodes();
  });
  document.getElementById('eq-high-freq').addEventListener('change', (e) => {
    params.eqHighFreq = Math.max(6000, Math.min(16000, parseInt(e.target.value)));
    e.target.value = params.eqHighFreq;
    selectCustomPreset();
    updateEqNodes();
  });

  // Compressor
  document.getElementById('comp-enable').addEventListener('change', (e) => {
    params.compEnabled = e.target.checked;
    selectCustomPreset();
    updateCompressorNode();
  });
  
  document.getElementById('comp-thresh').addEventListener('input', (e) => {
    params.compThreshold = parseFloat(e.target.value);
    document.getElementById('comp-thresh-val').innerText = `${params.compThreshold.toFixed(1)} dB`;
    selectCustomPreset();
    updateCompressorNode();
  });
  
  document.getElementById('comp-ratio').addEventListener('input', (e) => {
    params.compRatio = parseFloat(e.target.value);
    document.getElementById('comp-ratio-val').innerText = `${params.compRatio.toFixed(1)}:1`;
    selectCustomPreset();
    updateCompressorNode();
  });
  
  document.getElementById('comp-attack').addEventListener('input', (e) => {
    params.compAttack = parseFloat(e.target.value);
    document.getElementById('comp-attack-val').innerText = `${Math.round(params.compAttack * 1000)} ms`;
    selectCustomPreset();
    updateCompressorNode();
  });
  
  document.getElementById('comp-release').addEventListener('input', (e) => {
    params.compRelease = parseFloat(e.target.value);
    document.getElementById('comp-release-val').innerText = `${Math.round(params.compRelease * 1000)} ms`;
    selectCustomPreset();
    updateCompressorNode();
  });

  // Stereo Width
  document.getElementById('width-slider').addEventListener('input', (e) => {
    params.stereoWidth = parseFloat(e.target.value);
    document.getElementById('width-val').innerText = `${Math.round(params.stereoWidth * 100)}%`;
    selectCustomPreset();
    updateStereoWidthNode();
  });

  // Limiter Gain Boost
  document.getElementById('limiter-gain').addEventListener('input', (e) => {
    params.limiterBoost = parseFloat(e.target.value);
    document.getElementById('limiter-gain-val').innerText = `+${params.limiterBoost.toFixed(1)} dB`;
    // Selecting custom target
    document.getElementById('loudness-select').value = 'custom';
    updateLimiterGainNode();
  });

  // Preset Selections
  document.getElementById('preset-select').addEventListener('change', (e) => {
    loadGenrePreset(e.target.value);
    const autoRun = document.getElementById('ai-auto-run').checked;
    if (autoRun && audioBuffer) {
      runAiAnalysis(false);
    }
  });

  document.getElementById('loudness-select').addEventListener('change', (e) => {
    const val = e.target.value;
    if (val !== 'custom') {
      baseLoudnessTarget = val;
    }
    applyLoudnessTarget(val);
    const autoRun = document.getElementById('ai-auto-run').checked;
    if (autoRun && audioBuffer) {
      runAiAnalysis(false);
    }
  });
  
  // Visualizer Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      
      activeTab = e.target.dataset.target;
      if (activeTab === 'spectrum') {
        document.getElementById('spectrum-view').classList.remove('hidden');
        document.getElementById('waveform-view').classList.add('hidden');
      } else {
        document.getElementById('spectrum-view').classList.add('hidden');
        document.getElementById('waveform-view').classList.remove('hidden');
        if (!isPlaying && audioBuffer) {
          drawWaveformView();
        }
      }
    });
  });
}

// ==========================================================================
// FILE HANDLER & DRAG-AND-DROP SETUP
// ==========================================================================
function setupFileLoader() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  
  dropZone.addEventListener('click', () => fileInput.click());
  
  const quickUploadBtn = document.getElementById('btn-quick-upload');
  if (quickUploadBtn) {
    quickUploadBtn.addEventListener('click', () => fileInput.click());
  }
  
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      loadAudioFile(files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files.length > 0) {
      loadAudioFile(files[0]);
    }
  });

  // Audio Spices Event Listeners
  document.getElementById('spice-air-treble').addEventListener('change', (e) => {
    spices.airTreble = e.target.checked;
    updateEqNodes();
    drawWaveformView();
  });

  document.getElementById('spice-kick-punch').addEventListener('change', (e) => {
    spices.kickPunch = e.target.checked;
    updateEqNodes();
    updateCompressorNode();
    drawWaveformView();
  });

  document.getElementById('spice-stereo-wider').addEventListener('change', (e) => {
    spices.stereoWider = e.target.checked;
    updateStereoWidthNode();
    drawWaveformView();
  });

  document.getElementById('spice-vocal-presence').addEventListener('change', (e) => {
    spices.vocalPresence = e.target.checked;
    updateEqNodes();
    drawWaveformView();
  });

  document.getElementById('spice-analog-warmth').addEventListener('change', (e) => {
    spices.analogWarmth = e.target.checked;
    updateSaturatorNode();
    drawWaveformView();
  });

  document.getElementById('spice-loudness-push').addEventListener('change', (e) => {
    spices.loudnessPush = e.target.checked;
    updateLimiterGainNode();
    drawWaveformView();
  });
}

function loadAudioFile(file) {
  if (isPlaying) {
    stopPlayback();
  }

  // 新しい楽曲ファイルが読み込まれた際、前回の楽曲のAI解析値が漏洩・干渉するのを防ぐため初期化する
  aiSuggestedParams = null;
  aiDetectedGenre = null;

  document.getElementById('status-text').innerText = 'LOADING AUDIO FILE...';
  document.getElementById('status-indicator').className = 'status-indicator processing';

  const reader = new FileReader();
  reader.onload = async (e) => {
    const arrayBuffer = e.target.result;
    
    // Create initial dummy audio context if not loaded
    if (!audioContext) {
      audioContext = createAudioContext();
    }
    
    try {
      audioContext.decodeAudioData(arrayBuffer, (buffer) => {
        audioBuffer = buffer;
        
        // Downsample for waveform display
        originalPeaks = extractPeaks(audioBuffer, PEAK_POINTS);
        invalidatePeakCache();

        // Update UI info
        document.getElementById('track-name').innerText = file.name;
        const mobTrack = document.getElementById('mobile-track-name');
        if (mobTrack) {
          mobTrack.innerText = file.name;
        }
        
        const durationMin = Math.floor(buffer.duration / 60);
        const durationSec = Math.floor(buffer.duration % 60).toString().padStart(2, '0');
        const infoStr = `${buffer.sampleRate / 1000} kHz / ${buffer.numberOfChannels === 2 ? 'Stereo' : 'Mono'} | ${durationMin}:${durationSec}`;
        document.getElementById('track-meta').innerText = infoStr;

        // Display controls and swap panels
        const mainUpload = document.getElementById('main-upload-panel');
        if (mainUpload) {
          mainUpload.classList.add('hidden');
        }
        const playerPanel = document.getElementById('player-panel');
        if (playerPanel) {
          playerPanel.classList.remove('hidden');
        }
        document.body.classList.add('has-track');
        
        // Enable buttons
        document.getElementById('btn-play-pause').disabled = false;
        document.getElementById('btn-stop').disabled = false;
        document.getElementById('btn-loop').disabled = false;
        document.getElementById('btn-bypass').disabled = false;
        document.getElementById('btn-export').disabled = false;
        document.getElementById('btn-ai-analyze').disabled = false; // AIボタン有効化
        document.getElementById('btn-reset-master').disabled = false; // リセットボタン有効化
        
        // AIパラメータとレポートのリセット
        document.getElementById('ai-report').style.display = 'none';
        params.correctiveNotches.forEach(n => {
          n.enabled = false;
          n.gain = 0.0;
        });
        updateCorrectiveEqNodes();
        
        pausedAt = 0;
        playbackOffset = 0;
        
        document.getElementById('status-text').innerText = 'AUDIO LOADED SUCCESFULLY';
        document.getElementById('status-indicator').className = 'status-indicator online';

        // Load default AUTO preset
        baseLoudnessTarget = 'genre';
        document.getElementById('loudness-select').value = 'genre';
        document.getElementById('preset-select').value = 'auto';
        loadGenrePreset('auto');

        // Auto-run AI optimization on file load if checked
        const autoRun = document.getElementById('ai-auto-run').checked;
        if (autoRun) {
          runAiAnalysis(true);
        }

        // Draw initial static wave
        activeTab = 'waveform';
        document.querySelector('[data-target="waveform"]').click();
        drawWaveformView();
        
      }, (err) => {
        console.error('Audio decoding error:', err);
        alert('オーディオファイルのデコードに失敗しました。対応フォーマットをご確認ください。');
        document.getElementById('status-text').innerText = 'DECODE FAILED';
        document.getElementById('status-indicator').className = 'status-indicator online';
      });
    } catch (err) {
      console.error('decodeAudioData syntax error:', err);
    }
  };
  
  reader.readAsArrayBuffer(file);
}

// ==========================================================================
// RESET MASTERING SETTINGS
// ==========================================================================
function resetMasterSettings() {
  if (!audioBuffer) return;
  
  // Clear stored AI suggested parameters
  aiSuggestedParams = null;
  aiDetectedGenre = null;
  
  invalidatePeakCache();
  logToUI("Resetting mastering parameters to AI Auto...", "info");
  
  // 1. Reset dropdown selections
  baseLoudnessTarget = 'genre';
  document.getElementById('preset-select').value = 'auto';
  document.getElementById('loudness-select').value = 'genre';
  
  // Reset spices
  for (let key in spices) {
    spices[key] = false;
  }
  const spiceIds = ['air-treble', 'kick-punch', 'stereo-wider', 'vocal-presence', 'analog-warmth', 'loudness-push'];
  spiceIds.forEach(id => {
    const el = document.getElementById(`spice-${id}`);
    if (el) el.checked = false;
  });
  
  // Reset Noise Cleaner
  params.rumbleCutEnabled = false;
  params.hissReductionAmount = 0;
  
  // 2. Reset sibilance corrective notches
  params.correctiveNotches.forEach(n => {
    n.enabled = false;
    n.gain = 0.0;
  });
  updateCorrectiveEqNodes();
  
  // 3. Load the default genre preset
  loadGenrePreset('auto');
  
  // 4. Trigger AI auto-run if checked
  const autoRun = document.getElementById('ai-auto-run').checked;
  if (autoRun) {
    runAiAnalysis(true);
  } else {
    document.getElementById('ai-report').style.display = 'none';
  }
}

// ==========================================================================
// AI SMART ASSISTANT RUNNER
// ==========================================================================
function runAiAnalysis(showLog = true) {
  if (!audioBuffer) return;
  
  const aiAnalyzeBtn = document.getElementById('btn-ai-analyze');
  if (aiAnalyzeBtn) {
    aiAnalyzeBtn.disabled = true;
    aiAnalyzeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ANALYZING...';
  }
  
  if (showLog) {
    logToUI("AI Assistant: Analyzing frequency spectrum & dynamics...", "info");
  }
  
  setTimeout(() => {
    try {
      const result = analyzeAudioResonances(audioBuffer);
      
      // AIノッチフィルターの設定適用
      params.correctiveNotches.forEach((n, idx) => {
        if (result.notches[idx]) {
          n.freq = result.notches[idx].freq;
          n.gain = result.notches[idx].cut;
          n.q = result.notches[idx].q || 15.0;
          n.isBroad = result.notches[idx].isBroad || false;
          n.enabled = true;
          if (showLog) {
            const peakType = n.isBroad ? "Broad Hump" : "Sharp Whistle";
            logToUI(`[AI Assistant] Detected harsh peak #${idx+1} (${peakType}) at ${n.freq} Hz. Applied corrective cut of ${n.gain.toFixed(1)} dB (Q=${n.q.toFixed(1)}).`, "warning");
          }
        } else {
          n.enabled = false;
          n.gain = 0.0;
          n.q = 15.0;
          n.isBroad = false;
        }
      });
      
      // 自動提案パラメーターの適用とグローバル保存
      const sug = result.suggestedParams;
      const genreSelect = document.getElementById('preset-select');
      const isAutoMode = (genreSelect && genreSelect.value === 'auto');
      
      if (isAutoMode) {
        aiSuggestedParams = JSON.parse(JSON.stringify(sug));
        aiDetectedGenre = "OPTIMIZED";
        
        // UIバッジにOPTIMIZEDを表示
        const genreBadge = document.getElementById('ai-detected-genre-badge');
        if (genreBadge) {
          genreBadge.innerText = "OPTIMIZED";
        }
        if (showLog) {
          logToUI(`[AI Assistant] Applied Genre-Agnostic Studio Reference baseline. Audio is mathematically balanced.`, "success");
          logToUI(`[AI Assistant] (Recommendation) Identified track style: ${result.detectedGenre.toUpperCase()}. Select the ${result.detectedGenre.toUpperCase()} preset from the dropdown to apply specific genre coloration!`, "info");
        }
      } else {
        // 個別ジャンルプリセット選択時の動的AI補正
        if (showLog) {
          logToUI(`[AI Assistant] Dynamically optimized the selected ${genreSelect.value.toUpperCase()} preset parameters to match this track's sonic profile.`, "success");
        }
      }

      // Noise Cleanerの検出ステータスをコンソールログに出力
      if (showLog) {
        if (sug.rumbleCutEnabled) {
          logToUI(`[Noise Cleaner] Low-end rumble/sub-bass noise detected (${result.rumbleNoiseFloorDb.toFixed(1)} dB). Rumble Cut (80Hz HPF) auto-activated.`, "warning");
        } else {
          logToUI(`[Noise Cleaner] Low-end noise floor is clean (${result.rumbleNoiseFloorDb.toFixed(1)} dB). Subsonic protection active (18Hz HPF).`, "info");
        }
        
        if (sug.hissReductionAmount > 0) {
          logToUI(`[Noise Cleaner] High-frequency hiss/sibilance detected (${result.hissNoiseFloorDb.toFixed(1)} dB). Hiss Reducer auto-set to ${sug.hissReductionAmount}%.`, "warning");
        } else {
          logToUI(`[Noise Cleaner] High-frequency noise floor is clean (${result.hissNoiseFloorDb.toFixed(1)} dB). Hiss Reducer is OFF.`, "info");
        }

        // サ行のキンキン共鳴音（シビランス）の検知・クランプ保護のログ
        if (sug.sibilanceDynamicFreq > 0) {
          logToUI(`[AI Assistant] Detected harsh vocal sibilance at ${sug.sibilanceDynamicFreq} Hz. Clamped High Shelf EQ to ${sug.eqHighGain.toFixed(1)} dB to prevent ear fatigue and activated dynamic De-esser notch.`, "warning");
        }

        // 広帯域ステレオ低域／リバーブの検知ログ
        if (result.correlation < 0.72) {
          logToUI(`[AI Assistant] Detected wide stereo low-end / deep phase reverb (Correlation: ${result.correlation.toFixed(2)}). Centered sub-bass below ${sug.sideHighPassFreq}Hz and adjusted limiting to prevent low-end distortion.`, "warning");
        }
      }
      
      params.inputGainDb = sug.inputGainDb;
      params.satEnabled = sug.satEnabled;
      params.satType = sug.satType;
      params.satDrive = sug.satDrive;
      params.satMix = sug.satMix;
      params.eqLowGain = sug.eqLowGain;
      params.eqMidGain = sug.eqMidGain;
      params.eqMidQ = sug.eqMidQ || 1.0;
      params.eqHighGain = sug.eqHighGain;
      params.compThreshold = sug.compThreshold;
      params.compRatio = sug.compRatio;
      params.stereoWidth = sug.stereoWidth;
      params.sideHighPassFreq = sug.sideHighPassFreq || 110;
      params.limiterBoost = sug.limiterBoost;
      params.rumbleCutEnabled = sug.rumbleCutEnabled;
      params.hissReductionAmount = sug.hissReductionAmount;
      params.sibilanceDynamicFreq = sug.sibilanceDynamicFreq || 0;
      
      // UIスライダーコントロールの同期
      updateGuiControls();
      
      // 現在再生中の音声ノードにパラメーターを反映
      updateInputGainNode();
      updateNoiseCutNodes();
      updateSaturatorNode();
      updateEqNodes();
      updateCompressorNode();
      updateStereoWidthNode();
      updateLimiterGainNode();
      updateCeilingNode();
      updateCorrectiveEqNodes();
      
      // AI詳細レポートカード表示の更新
      document.getElementById('ai-crest-factor').innerText = `${result.crestFactor.toFixed(1)} dB`;
      document.getElementById('ai-crest-desc').innerText = result.crestDesc;
      document.getElementById('ai-stereo-corr').innerText = `${result.correlation >= 0 ? '+' : ''}${result.correlation.toFixed(2)}`;
      document.getElementById('ai-stereo-desc').innerText = result.correlationDesc;
      
      const bassSign = result.bassDiff >= 0 ? '+' : '';
      document.getElementById('ai-bass-energy').innerText = `${bassSign}${result.bassDiff.toFixed(1)} dB`;
      document.getElementById('ai-bass-desc').innerText = result.bassDiff > 0.8 ? "Heavy Bass" : result.bassDiff < -0.8 ? "Weak Bass" : "Balanced Bass";
      
      const trebleSign = result.trebleDiff >= 0 ? '+' : '';
      document.getElementById('ai-treble-energy').innerText = `${trebleSign}${result.trebleDiff.toFixed(1)} dB`;
      document.getElementById('ai-treble-desc').innerText = result.trebleDiff > 0.8 ? "Bright / Sibilant" : result.trebleDiff < -0.8 ? "Warm / Dull" : "Balanced Highs";
      
      // ノッチフィルター検出リストのHTML生成
      const notchListContainer = document.getElementById('ai-notches-list');
      if (notchListContainer) {
        notchListContainer.innerHTML = '';
        if (result.notches.length > 0) {
          result.notches.forEach((n, idx) => {
            const typeLabel = n.isBroad ? "HUMP" : "WHISTLE";
            const bgColor = n.isBroad ? "rgba(0, 242, 254, 0.08)" : "rgba(255, 0, 85, 0.08)";
            const borderColor = n.isBroad ? "rgba(0, 242, 254, 0.15)" : "rgba(255, 0, 85, 0.15)";
            const badgeColor = n.isBroad ? "rgba(0, 242, 254, 0.2)" : "rgba(255, 0, 85, 0.2)";
            const badgeTextColor = n.isBroad ? "#00f2fe" : "var(--accent-red)";
            
            notchListContainer.innerHTML += `
              <div style="display: flex; justify-content: space-between; align-items: center; background: ${bgColor}; border-radius: 4px; padding: 4px 8px; border: 1px solid ${borderColor}; gap: 8px;">
                <span style="color: var(--text-secondary); display: flex; align-items: center; gap: 4px;">
                  <i class="fa-solid fa-circle-notch"></i> PEAK ${idx+1}:
                </span>
                <span style="background: ${badgeColor}; color: ${badgeTextColor}; font-size: 8px; font-weight: 700; padding: 1px 4px; border-radius: 3px; letter-spacing: 0.5px;">${typeLabel}</span>
                <span style="color: #fff; font-weight: 700; flex-grow: 1; text-align: center;">${n.freq} Hz</span>
                <span style="color: ${badgeTextColor}; font-weight: 700;">${n.cut.toFixed(1)} dB</span>
              </div>
            `;
          });
        } else {
          notchListContainer.innerHTML = '<div style="color: var(--text-muted); font-style: italic; padding: 4px;">No harsh resonances detected.</div>';
        }
      }
      
      // 自動調整内容サマリーのHTML生成
      const adjContainer = document.getElementById('ai-adjustments-list');
      adjContainer.innerHTML = `
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
          <span>INPUT GAIN:</span>
          <span style="color: #00f2fe; font-weight: 600;">${sug.inputGainDb >= 0 ? '+' : ''}${sug.inputGainDb.toFixed(1)} dB (Auto Gain)</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
          <span>EQ LOW:</span>
          <span style="color: #00f2fe; font-weight: 600;">${sug.eqLowGain >= 0 ? '+' : ''}${sug.eqLowGain.toFixed(1)} dB</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
          <span>EQ HIGH:</span>
          <span style="color: #00f2fe; font-weight: 600;">${sug.eqHighGain >= 0 ? '+' : ''}${sug.eqHighGain.toFixed(1)} dB</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
          <span>COMPRESSOR:</span>
          <span style="color: #00f2fe; font-weight: 600;">Thresh: ${sug.compThreshold.toFixed(1)} dB / Ratio: ${sug.compRatio.toFixed(1)}:1</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
          <span>STEREO WIDTH:</span>
          <span style="color: #00f2fe; font-weight: 600;">${Math.round(sug.stereoWidth * 100)}%</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
          <span>MAXIMIZER LIMITER:</span>
          <span style="color: #00f2fe; font-weight: 600;">Boost: +${sug.limiterBoost.toFixed(1)} dB</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px;">
          <span>NOISE CLEANER:</span>
          <span style="color: #00f2fe; font-weight: 600;">Rumble: ${sug.rumbleCutEnabled ? 'CUT' : 'OFF'} / Hiss: ${sug.hissReductionAmount > 0 ? sug.hissReductionAmount + '%' : 'OFF'}</span>
        </div>
        <div style="text-align: right; font-size: 0.58rem; color: var(--text-muted); margin-top: -2px; padding: 0 4px 4px 0;">
          (Base: ${result.baseLoudnessDesc})
        </div>
      `;
      
      // レポート表示のフェードイン
      document.getElementById('ai-report').style.display = 'block';
      
      if (showLog) {
        logToUI("[AI Assistant] Optimization completed successfully. Audio nodes updated.", "info");
      }
    } catch (e) {
      console.error(e);
      logToUI(`AI analysis failed: ${e.message}`, "error");
    } finally {
      if (aiAnalyzeBtn) {
        aiAnalyzeBtn.disabled = false;
        aiAnalyzeBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> ANALYZE & AUTO-CORRECT EQ';
      }
    }
  }, 100);
}

// ==========================================================================
// MOBILE HELP BOTTOM SHEET INITIALIZER
// ==========================================================================
function initMobileHelp() {
  const tooltipElements = document.querySelectorAll('[data-tooltip]');
  const sheet = document.getElementById('mobile-help-sheet');
  const sheetTitle = document.getElementById('sheet-title');
  const sheetBody = document.getElementById('sheet-body');
  const closeBtn = document.getElementById('btn-close-sheet');
  const backdrop = document.getElementById('sheet-backdrop');

  if (!sheet || !sheetTitle || !sheetBody) return;

  function openSheet(title, text) {
    sheetTitle.textContent = title;
    sheetBody.textContent = text;
    sheet.classList.remove('hidden');
    // Force reflow
    sheet.offsetHeight;
    sheet.classList.add('active');
  }

  function closeSheet() {
    sheet.classList.remove('active');
    setTimeout(() => {
      sheet.classList.add('hidden');
    }, 300);
  }

  tooltipElements.forEach(el => {
    // If it's the reset button wrapper or reset button itself, skip mobile help tooltip completely to let the button work cleanly without popping up the sheet
    if (el.id === 'btn-reset-master' || el.querySelector('#btn-reset-master') || el.closest('#btn-reset-master')) {
      return;
    }

    // Add tabindex dynamically to make spans focusable/tappable
    el.setAttribute('tabindex', '0');

    el.addEventListener('click', (e) => {
      if (window.innerWidth <= 768) {
        e.preventDefault();
        e.stopPropagation();
        
        let titleText = "HELP";
        const tooltipText = el.getAttribute('data-tooltip') || "";
        
        const resetBtn = el.querySelector('#btn-reset-master');
        if (el.id === "btn-reset-master" || el.parentElement.id === "btn-reset-master" || resetBtn) {
          titleText = "RESET";
        } else {
          const parent = el.parentElement;
          if (parent) {
            const clone = parent.cloneNode(true);
            clone.querySelectorAll('[data-tooltip]').forEach(t => t.remove());
            titleText = clone.textContent.replace(/[\n\r\t]+/g, ' ').trim() || "HELP";
          }
        }
        
        openSheet(titleText, tooltipText);
      }
    });
  });

  if (closeBtn) closeBtn.addEventListener('click', closeSheet);
  if (backdrop) backdrop.addEventListener('click', closeSheet);
}

// ==========================================================================
// APP STARTUP BINDINGS
// ==========================================================================
function initializeApp() {
  setupFileLoader();
  registerGuiEvents();
  initMobileHelp();
  
  // Clear log button
  const clearLogBtn = document.getElementById('btn-clear-log');
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      const logContainer = document.getElementById('debug-log');
      if (logContainer) {
        logContainer.innerHTML = '<div class="log-line info" style="color: #00f2fe;">[SYSTEM] Log cleared.</div>';
      }
    });
  }
  
  // Play/Pause button
  document.getElementById('btn-play-pause').addEventListener('click', () => {
    logToUI("Play/Pause button clicked", "info");
    if (isPlaying) {
      pausePlayback();
    } else {
      startPlayback();
    }
  });

  // Spacebar Play/Pause Shortcut
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.key === ' ') {
      const activeEl = document.activeElement;
      if (activeEl && (
        (activeEl.tagName === 'INPUT' && activeEl.type !== 'range') ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.isContentEditable
      )) {
        return;
      }
      
      const playBtn = document.getElementById('btn-play-pause');
      if (playBtn && !playBtn.disabled && audioBuffer) {
        e.preventDefault();
        if (isPlaying) {
          pausePlayback();
        } else {
          startPlayback();
        }
      }
    }
  });

  // Stop button
  document.getElementById('btn-stop').addEventListener('click', () => {
    stopPlayback();
  });

  // Loop Toggle
  const loopBtn = document.getElementById('btn-loop');
  loopBtn.addEventListener('click', () => {
    isLooping = !isLooping;
    if (isLooping) {
      loopBtn.classList.add('active');
    } else {
      loopBtn.classList.remove('active');
    }
    if (sourceNode) {
      sourceNode.loop = isLooping;
    }
  });

  // Bypass (A/B Test) Toggle
  const bypassBtn = document.getElementById('btn-bypass');
  bypassBtn.addEventListener('click', () => {
    isBypassed = !isBypassed;
    if (isBypassed) {
      bypassBtn.classList.add('active');
    } else {
      bypassBtn.classList.remove('active');
    }
    updateBypassRouting();
  });

  // Export button
  document.getElementById('btn-export').addEventListener('click', () => {
    renderMasteredTrack();
  });
  
  // AI Analyze Button click handler
  const aiAnalyzeBtn = document.getElementById('btn-ai-analyze');
  if (aiAnalyzeBtn) {
    aiAnalyzeBtn.addEventListener('click', () => {
      runAiAnalysis(true);
    });
  }
  
  // Reset Button click handler
  const resetBtn = document.getElementById('btn-reset-master');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      resetMasterSettings();
    });
  }
  
  // Waveform click seeking & scrubbing
  const waveformCanvas = document.getElementById('waveform-canvas');
  if (waveformCanvas) {
    waveformCanvas.style.cursor = 'pointer';
    let isMouseDown = false;
    
    const handleSeek = (e) => {
      if (!audioBuffer) return;
      const rect = waveformCanvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickPercent = Math.max(0, Math.min(1.0, clickX / rect.width));
      const seekTime = clickPercent * audioBuffer.duration;
      seekTo(seekTime);
    };
    
    waveformCanvas.addEventListener('mousedown', (e) => {
      isMouseDown = true;
      handleSeek(e);
    });
    
    window.addEventListener('mousemove', (e) => {
      if (isMouseDown) {
        handleSeek(e);
      }
    });
    
    window.addEventListener('mouseup', () => {
      isMouseDown = false;
    });
  }
  
  // Mobile monitor toggle (collapse/expand)
  const toggleMonitorBtn = document.getElementById('btn-toggle-monitor');
  if (toggleMonitorBtn) {
    toggleMonitorBtn.addEventListener('click', () => {
      const panel = document.querySelector('.visualizer-panel');
      if (panel) {
        panel.classList.toggle('collapsed');
      }
    });
  }

  // Handle scroll/resize events: toggle sticky collapse state and relocate controls
  function handleScroll() {
    relocatePlayerControls();
    
    const wrapper = document.querySelector('.app-sticky-header-wrapper');
    if (wrapper) {
      const wasSticky = wrapper.classList.contains('is-sticky');
      
      // Calculate static threshold from the non-sticky header bottom position + gap (20px) - sticky top (15px)
      const header = document.querySelector('.app-header');
      const baseThreshold = header ? Math.max(0, header.offsetTop + header.offsetHeight + 20 - 15) : 75;
      
      // Hysteresis: un-stick slightly earlier (10px buffer) when scrolling up to prevent scroll wheel jitter
      const threshold = wasSticky ? Math.max(0, baseThreshold - 10) : baseThreshold;
      
      const isSticky = window.scrollY > threshold;
      
      console.log('[handleScroll Internal Log]', JSON.stringify({ scrollY: window.scrollY, baseThreshold, threshold, isSticky, wasSticky }));
      
      if (isSticky !== wasSticky) {
        if (isSticky) {
          wrapper.classList.add('is-sticky');
        } else {
          wrapper.classList.remove('is-sticky');
        }
        // Force visualizer redraw immediately to adjust to the collapsed canvas height
        invalidatePeakCache();
      }
    }
  }

  // Relocate player controls dynamically based on screen size/scroll
  handleScroll();
  window.addEventListener('resize', handleScroll);
  window.addEventListener('scroll', handleScroll);

  // Initialize width beam animation angle L/R
  updateStereoWidthNode();
}

// Bulletproof execution strategy for DOM initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

// Relocate player controls (Play/Pause, Stop, Loop, Bypass) to sticky visualizer header on mobile/desktop scroll
function relocatePlayerControls() {
  const controls = document.querySelector('.player-controls');
  if (!controls) return;
  
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    // On mobile, keep player controls in the sticky visualizer header placeholder
    const mobileTarget = document.querySelector('#mobile-controls-target .mobile-controls-placeholder');
    if (mobileTarget && controls.parentElement !== mobileTarget) {
      mobileTarget.appendChild(controls);
    }
  } else {
    // On PC/tablet, keep player controls in the upload panel (since the upload panel sticks side-by-side with visualizer)
    const desktopTarget = document.getElementById('desktop-controls-target');
    if (desktopTarget && controls.parentElement !== desktopTarget) {
      desktopTarget.appendChild(controls);
    }
  }
}

// Performance Optimization: Cache processed peaks calculations
function invalidatePeakCache() {
  cachedProcessedPeaks = null;
  // 音源ロード済かつ一時停止中の場合、パラメータ変更に伴う波形表示を即座に更新する
  if (!isPlaying && audioBuffer && activeTab === 'waveform') {
    drawWaveformView();
  }
}

function getProcessedPeaks() {
  if (!cachedProcessedPeaks) {
    cachedProcessedPeaks = calculateProcessedPeaks();
  }
  return cachedProcessedPeaks;
}
