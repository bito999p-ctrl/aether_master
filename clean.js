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
let clippingScanTimeout = null;
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
  satLpfFreq: 4500,
  
  // EQ
  eqLowGain: 1.0,
  eqLowFreq: 120,
  eqLowQ: 0.70,
  eqLowMidGain: 0.0,
  eqLowMidFreq: 200,
  eqLowMidQ: 0.60,
  eqMidGain: -0.5,
  eqMidFreq: 1000,
  eqMidQ: 1.0,
  eqMidHighGain: 0.0,
  eqMidHighFreq: 4800,
  eqMidHighQ: 1.0,
  eqHighGain: 1.5,
  eqHighFreq: 10000,
  eqHighQ: 0.70,
  
  // Compressor
  compEnabled: true,
  compThreshold: -16.0,
  compRatio: 1.8,
  compAttack: 0.03, // 30ms
  compRelease: 0.15, // 150ms
  
  // Stereo Width
  stereoWidth: 1.20, // 120%
  sideHighPassFreq: 110,
  
  // Limiter/Maximizer & Pre-Clipper
  clipperDrive: 1.5, // +1.5 dB (Mastering Pre-Limiter Soft Clipper)
  limiterBoost: 4.0, // +4.0 dB
  
  // Noise Cleaner
  rumbleCutEnabled: false,
  hissReductionAmount: 0, // 0 to 100%
  hissReductionMaxCut: -16.0, // -24.0 to -6.0 dB
  hissReductionFreq: 9000, // 4000 to 12000 Hz
  hissReductionMaxFreq: 16000, // 6000 to 20000 Hz
  deesserAmount: 0,
  deesserMaxCut: -15.0, // -24.0 to -6.0 dB
  deesserFreq: 7500, // 5000 to 10000 Hz
  deesserMaxFreq: 9500, // 5000 to 16000 Hz
  sibilanceDynamicFreq: 0 // Detected sibilance frequency (0 if none)
};

// Audio Suggested Parameters baseline (holds dynamically calculated parameters for the AUTO preset)
let aiSuggestedParams = null;
let aiDetectedGenre = null;
let lastAnalysisResult = null;

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
    kickPeakingGain: spices.kickPunch ? 3.0 : 0.0, // Dedicated narrow 55Hz kick thump peaking boost
    eqMidGain: params.eqMidGain + (spices.vocalPresence ? 1.2 : 0.0),
    eqHighGain: params.eqHighGain + (spices.airTreble ? 1.5 : 0.0),
    compEnabled: params.compEnabled || spices.kickPunch,
    compThreshold: params.compThreshold, // No aggressive threshold lowering to prevent pumping
    compRatio: params.compRatio,         // Keep ratio natural and transparent
    compAttack: Math.max(0.001, Math.min(0.5, params.compAttack + (spices.kickPunch ? 0.030 : 0.0))), // Let transient punch pop out
    compRelease: params.compRelease,
    stereoWidth: Math.max(0.0, Math.min(2.0, params.stereoWidth + (spices.stereoWider ? 0.45 : 0.0))),
    clipperDrive: Math.max(0.0, Math.min(6.0, (params.clipperDrive !== undefined ? params.clipperDrive : 0.0) + (spices.loudnessPush ? 1.5 : 0.0))),
    limiterBoost: Math.max(0.0, Math.min(15.0, params.limiterBoost + (spices.loudnessPush ? 1.5 : 0.0)))
  };
}

// Genre Presets Configuration (Academic Mastering Reference: eqMidHigh is reset to 0.0dB neutral)
export const GENRE_PRESETS = {
  auto: {
    satEnabled: true, satType: 'tube', satDrive: 12, satMix: 10, satLpfFreq: 12000,
    eqLowGain: 0.0, eqLowFreq: 90, eqLowQ: 0.55,
    eqLowMidGain: 0.0, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: 0.0, eqMidFreq: 1000, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.3, eqHighFreq: 9000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -8.0, compRatio: 1.35, compAttack: 0.04, compRelease: 0.20,
    stereoWidth: 1.15, clipperDrive: 1.5, limiterBoost: 3.5, sideHighPassFreq: 110
  },
  pops: {
    satEnabled: true, satType: 'tube', satDrive: 15, satMix: 10, satLpfFreq: 12000,
    eqLowGain: 1.0, eqLowFreq: 80, eqLowQ: 0.55,
    eqLowMidGain: 0.0, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: 0.0, eqMidFreq: 1000, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: 0.0, eqHighFreq: 12000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -8.0, compRatio: 1.35, compAttack: 0.035, compRelease: 0.16,
    stereoWidth: 1.15, clipperDrive: 1.8, limiterBoost: 3.5, sideHighPassFreq: 110
  },
  rnb: {
    satEnabled: true, satType: 'tape', satDrive: 15, satMix: 12, satLpfFreq: 10000,
    eqLowGain: 1.2, eqLowFreq: 75, eqLowQ: 0.55,
    eqLowMidGain: -0.6, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: -0.8, eqMidFreq: 1000, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.4, eqHighFreq: 10000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -8.0, compRatio: 1.35, compAttack: 0.04, compRelease: 0.20,
    stereoWidth: 1.25, clipperDrive: 1.2, limiterBoost: 3.2, sideHighPassFreq: 110
  },
  rock: {
    satEnabled: true, satType: 'tape', satDrive: 18, satMix: 12, satLpfFreq: 12000,
    eqLowGain: 1.0, eqLowFreq: 80, eqLowQ: 0.55,
    eqLowMidGain: 0.6, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: -0.4, eqMidFreq: 1000, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.6, eqHighFreq: 12000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -7.5, compRatio: 1.35, compAttack: 0.05, compRelease: 0.15,
    stereoWidth: 1.15, clipperDrive: 2.5, limiterBoost: 4.0, sideHighPassFreq: 110
  },
  metal: {
    satEnabled: true, satType: 'tape', satDrive: 25, satMix: 14, satLpfFreq: 12000,
    eqLowGain: 1.0, eqLowFreq: 70, eqLowQ: 0.55,
    eqLowMidGain: -1.2, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: -1.5, eqMidFreq: 1000, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.5, eqHighFreq: 8500, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -7.5, compRatio: 1.40, compAttack: 0.02, compRelease: 0.10,
    stereoWidth: 1.28, clipperDrive: 3.0, limiterBoost: 3.8, sideHighPassFreq: 120
  },
  edm: {
    satEnabled: true, satType: 'tape', satDrive: 18, satMix: 20, satLpfFreq: 16000,
    eqLowGain: 1.8, eqLowFreq: 65, eqLowQ: 0.55,
    eqLowMidGain: -0.8, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: -0.5, eqMidFreq: 800, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.4, eqHighFreq: 14000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -7.0, compRatio: 1.35, compAttack: 0.05, compRelease: 0.20,
    stereoWidth: 1.30, clipperDrive: 3.5, limiterBoost: 4.5, sideHighPassFreq: 150
  },
  hiphop: {
    satEnabled: true, satType: 'tape', satDrive: 15, satMix: 14, satLpfFreq: 12000,
    eqLowGain: 1.8, eqLowFreq: 65, eqLowQ: 0.55,
    eqLowMidGain: -0.5, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: -0.8, eqMidFreq: 350, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.5, eqHighFreq: 10000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -8.0, compRatio: 1.40, compAttack: 0.035, compRelease: 0.15,
    stereoWidth: 1.20, clipperDrive: 2.5, limiterBoost: 3.6, sideHighPassFreq: 150
  },
  lofi: {
    satEnabled: true, satType: 'tape', satDrive: 45, satMix: 30, satLpfFreq: 16000,
    eqLowGain: 2.0, eqLowFreq: 100, eqLowQ: 0.55,
    eqLowMidGain: -0.5, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: 0.8, eqMidFreq: 1200, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -4.5, eqHighFreq: 7000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -10.0, compRatio: 1.5, compAttack: 0.06, compRelease: 0.30,
    stereoWidth: 0.92, clipperDrive: 1.0, limiterBoost: 2.8, sideHighPassFreq: 110
  },
  hardcore: {
    satEnabled: true, satType: 'hardcore', satDrive: 28, satMix: 22, satLpfFreq: 16000,
    eqLowGain: 1.5, eqLowFreq: 80, eqLowQ: 0.55,
    eqLowMidGain: -0.8, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: -1.2, eqMidFreq: 800, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.3, eqHighFreq: 12000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -8.5, compRatio: 1.45, compAttack: 0.015, compRelease: 0.10,
    stereoWidth: 1.38, clipperDrive: 4.0, limiterBoost: 4.2, sideHighPassFreq: 150
  },
  ambient: {
    satEnabled: true, satType: 'tube', satDrive: 8, satMix: 6, satLpfFreq: 12000,
    eqLowGain: 2.0, eqLowFreq: 80, eqLowQ: 0.50,
    eqLowMidGain: 0.0, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: 0.0, eqMidFreq: 1000, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.3, eqHighFreq: 12000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -6.0, compRatio: 1.2, compAttack: 0.12, compRelease: 0.40,
    stereoWidth: 1.55, clipperDrive: 0.0, limiterBoost: 2.0, sideHighPassFreq: 90
  },
  podcast: {
    satEnabled: true, satType: 'tube', satDrive: 5, satMix: 5, satLpfFreq: 8000,
    eqLowGain: -2.0, eqLowFreq: 120, eqLowQ: 0.55,
    eqLowMidGain: 0.0, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: 0.8, eqMidFreq: 1600, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.3, eqHighFreq: 8000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -10.0, compRatio: 1.3, compAttack: 0.02, compRelease: 0.15,
    stereoWidth: 1.00, clipperDrive: 0.8, limiterBoost: 2.5, sideHighPassFreq: 150
  },
  classic: {
    satEnabled: false, satType: 'tube', satDrive: 0, satMix: 0, satLpfFreq: 10000,
    eqLowGain: 0.5, eqLowFreq: 100, eqLowQ: 0.55,
    eqLowMidGain: 0.0, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: 0.0, eqMidFreq: 1000, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.3, eqHighFreq: 10000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -4.0, compRatio: 1.15, compAttack: 0.15, compRelease: 0.50,
    stereoWidth: 1.30, clipperDrive: 0.0, limiterBoost: 1.5, sideHighPassFreq: 90
  },
  jazz: {
    satEnabled: true, satType: 'tube', satDrive: 6, satMix: 5, satLpfFreq: 12000,
    eqLowGain: 0.8, eqLowFreq: 80, eqLowQ: 0.55,
    eqLowMidGain: 0.0, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: 0.0, eqMidFreq: 1000, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.3, eqHighFreq: 14000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -7.5, compRatio: 1.20, compAttack: 0.06, compRelease: 0.25,
    stereoWidth: 1.15, clipperDrive: 0.5, limiterBoost: 2.2, sideHighPassFreq: 90
  },
  acoustic: {
    satEnabled: true, satType: 'tube', satDrive: 8, satMix: 8, satLpfFreq: 12000,
    eqLowGain: 1.0, eqLowFreq: 120, eqLowQ: 0.55,
    eqLowMidGain: 0.8, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: 0.4, eqMidFreq: 2000, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.2, eqHighFreq: 11000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -7.5, compRatio: 1.25, compAttack: 0.045, compRelease: 0.22,
    stereoWidth: 1.25, clipperDrive: 0.5, limiterBoost: 2.5, sideHighPassFreq: 90
  },
  custom: {
    satEnabled: true, satType: 'tube', satDrive: 12, satMix: 10, satLpfFreq: 12000,
    eqLowGain: 0.0, eqLowFreq: 90, eqLowQ: 0.55,
    eqLowMidGain: 0.0, eqLowMidFreq: 200, eqLowMidQ: 0.55,
    eqMidGain: 0.0, eqMidFreq: 1000, eqMidQ: 0.70,
    eqMidHighGain: 0.0, eqMidHighFreq: 4500, eqMidHighQ: 0.70,
    eqHighGain: -0.3, eqHighFreq: 9000, eqHighQ: 0.50,
    compEnabled: true, compThreshold: -8.0, compRatio: 1.35, compAttack: 0.04, compRelease: 0.20,
    stereoWidth: 1.15, clipperDrive: 1.5, limiterBoost: 3.5, sideHighPassFreq: 110
  }
};

// Genre Targets Configuration (Pink Noise Slope -4.5dB/octave Academic Profile)
export const GENRE_TARGETS = {
  auto: { low: 2.6, high: 0.16, presence: 0.40 },
  pops: { low: 2.4, high: 0.16, presence: 0.39 },
  rnb: { low: 2.8, high: 0.15, presence: 0.38 },
  rock: { low: 2.6, high: 0.14, presence: 0.40 },
  metal: { low: 2.7, high: 0.16, presence: 0.40 },
  edm: { low: 3.1, high: 0.18, presence: 0.38 },
  hiphop: { low: 3.0, high: 0.14, presence: 0.36 },
  lofi: { low: 2.7, high: 0.12, presence: 0.35 },
  hardcore: { low: 2.8, high: 0.18, presence: 0.40 },
  ambient: { low: 2.5, high: 0.18, presence: 0.40 },
  podcast: { low: 1.6, high: 0.13, presence: 0.42 },
  classic: { low: 2.2, high: 0.13, presence: 0.38 },
  jazz: { low: 2.4, high: 0.14, presence: 0.39 },
  acoustic: { low: 2.2, high: 0.14, presence: 0.39 },
  custom: { low: 2.6, high: 0.16, presence: 0.40 }
};

// Loudness Targets
const LOUDNESS_TARGETS = {
  genre: { boost: null, clipper: null },     // Genre Default (follows selected preset)
  streaming: { boost: 4.0, clipper: 1.2 },  // Standard Streaming -14 LUFS target
  club: { boost: 7.0, clipper: 2.5 },       // Standard Club -9 LUFS target
  loud: { boost: 10.0, clipper: 3.5 },      // Standard Heavy -7 LUFS target
  pure: { boost: 0.0, clipper: 0.0 }        // High Dynamic Range -18 LUFS target
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
  const n_samples = 65536;
  const curve = new Float32Array(n_samples);
  const threshold = 0.85; // Linear up to 0.85 (-1.4 dBFS) to preserve bit transparency
  for (let i = 0; i < n_samples; ++i) {
    const x = (i * 2) / (n_samples - 1) - 1;
    const absX = Math.abs(x);
    if (absX <= threshold) {
      curve[i] = x;
    } else {
      const sign = Math.sign(x);
      const u = (absX - threshold) / (1.0 - threshold);
      // C2 continuous soft knee with horizontal tangent at 1.0 (zero slope, zero crackle)
      const y = threshold + (1.0 - threshold) * (u - u * u + (u * u * u) / 3.0);
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

// Pre-Limiter Mastering Soft Clipper Curve (Smooth C2 continuous saturation with variable drive)
function generateMasteringClipCurve(driveDb = 0.0) {
  const n_samples = 65536; // high resolution for mastering precision
  const curve = new Float32Array(n_samples);
  if (!driveDb || driveDb <= 0.05) {
    // Pure 100% bit-transparent bypass
    for (let i = 0; i < n_samples; ++i) {
      curve[i] = (i * 2) / (n_samples - 1) - 1;
    }
    return curve;
  }
  // Knee threshold dynamically scales with clipperDrive (0dB: 1.0 -> 6dB: 0.65)
  const T = Math.max(0.60, 1.0 - (driveDb / 6.0) * 0.35);
  for (let i = 0; i < n_samples; ++i) {
    const x = (i * 2) / (n_samples - 1) - 1;
    const absX = Math.abs(x);
    if (absX <= T) {
      curve[i] = x;
    } else {
      const sign = Math.sign(x);
      const u = (absX - T) / (1.0 - T);
      // C2 continuous smooth saturation: slope reaches exactly 0.0 at x = 1.0 (no hard clamp kink, no crackle)
      const y = T + (1.0 - T) * (u - u * u + (u * u * u) / 3.0);
      curve[i] = sign * y;
    }
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
  rumbleFilter.frequency.setValueAtTime(parameters.rumbleCutEnabled ? 90.0 : 18.0, context.currentTime); // 18Hz subsonic filter when disabled, protecting deep sub-bass while removing DC offset/infrasound mud.
  rumbleFilter.Q.setValueAtTime(0.707, context.currentTime);

  // Dynamic Hiss Filter (VCF High Shelf - Lower bound)
  const safeHissStart = Math.min(parameters.hissReductionFreq || 9000.0, (parameters.hissReductionMaxFreq || 16000.0) - 1000.0);
  const safeHissEnd = Math.max(parameters.hissReductionMaxFreq || 16000.0, safeHissStart + 1000.0);

  const hissFilter = context.createBiquadFilter();
  hissFilter.type = 'highshelf';
  hissFilter.frequency.setValueAtTime(safeHissStart, context.currentTime); // Dynamic hiss cutoff frequency
  hissFilter.Q.setValueAtTime(0.707, context.currentTime);
  
  const hissAmount = parameters.hissReductionAmount || 0;
  const maxCut = parameters.hissReductionMaxCut !== undefined ? parameters.hissReductionMaxCut : -16.0;
  // ベースゲインはマイナスの値（減衰）。スライダー設定値（0-100%）に上限値を掛け合わせて音量を決定
  const baseGain = maxCut * (hissAmount / 100.0);
  hissFilter.gain.setValueAtTime(baseGain, context.currentTime);

  // Dynamic Hiss Air Filter (VCF High Shelf - Upper bound to preserve air band)
  const hissAirFilter = context.createBiquadFilter();
  hissAirFilter.type = 'highshelf';
  hissAirFilter.frequency.setValueAtTime(safeHissEnd, context.currentTime); // Dynamic hiss max cutoff frequency
  hissAirFilter.Q.setValueAtTime(0.707, context.currentTime);
  // 相殺ゲインはプラスの値。ベースゲインの逆符号を設定することで上限周波数以上の帯域をフラットに戻す
  hissAirFilter.gain.setValueAtTime(-baseGain, context.currentTime);

  // Sidechain Envelope Follower for Hiss Filter
  const sidechainHpf = context.createBiquadFilter();
  sidechainHpf.type = 'highpass';
  // サイドチェーンの周波数を6,000Hzに引き上げ、中域のメロディ音量に惑わされず超高音域の音量だけに反応させます
  sidechainHpf.frequency.setValueAtTime(6000.0, context.currentTime);
  sidechainHpf.Q.setValueAtTime(0.707, context.currentTime);

  const sidechainGainNode = context.createGain();
  sidechainGainNode.gain.setValueAtTime(10.0, context.currentTime); // Boost sidechain energy to generate robust envelope values during active music

  const rectifier = context.createWaveShaper();
  rectifier.curve = generateAbsoluteValCurve();

  const envelopeSmoother = context.createBiquadFilter();
  envelopeSmoother.type = 'lowpass';
  envelopeSmoother.frequency.setValueAtTime(2.0, context.currentTime);
  envelopeSmoother.Q.setValueAtTime(0.707, context.currentTime);

  const hissEnvelopeGain = context.createGain();
  // 楽曲演奏時には減衰量を打ち消してフラットにするため、正のゲインを封入
  const maxEnvGain = -baseGain;
  hissEnvelopeGain.gain.setValueAtTime(maxEnvGain, context.currentTime);

  const hissAirEnvelopeGain = context.createGain();
  // 上限周波数の正の相殺ゲインを打ち消すため、負 of maxEnvGain (i.e. -maxEnvGain)
  hissAirEnvelopeGain.gain.setValueAtTime(-maxEnvGain, context.currentTime);

  // 2. Parallel Saturator Stage
  const satDryGain = context.createGain();
  const satWetGain = context.createGain();
  const waveShaper = context.createWaveShaper();
  const satSumNode = context.createGain();

  // High-pass filter for Saturator Wet path to prevent low-end intermodulation mud (ボワボワ)
  const satHpf = context.createBiquadFilter();
  satHpf.type = 'highpass';
  satHpf.frequency.setValueAtTime(220.0, context.currentTime); // Cut sub-bass/bass saturation below 220Hz
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
  hissFilter.connect(hissAirFilter);
  
  hissAirFilter.connect(satDryGain);
  hissAirFilter.connect(satHpf);
  satHpf.connect(waveShaper); // Feed highpassed signal to waveshaper to keep low end clean
  
  const satLpf = context.createBiquadFilter();
  satLpf.type = 'lowpass';
  satLpf.frequency.setValueAtTime(parameters.satLpfFreq || 4500.0, context.currentTime);
  satLpf.Q.setValueAtTime(0.5, context.currentTime);
  
  waveShaper.connect(satLpf);
  satLpf.connect(satWetGain);

  // Hook up sidechain envelope follower path (splits from rumbleFilter output)
  rumbleFilter.connect(sidechainHpf);
  sidechainHpf.connect(sidechainGainNode);
  sidechainGainNode.connect(rectifier);
  rectifier.connect(envelopeSmoother);
  envelopeSmoother.connect(hissEnvelopeGain);
  envelopeSmoother.connect(hissAirEnvelopeGain);
  
  // Connect envelope gain modulator to hissFilter & hissAirFilter gain AudioParams
  hissEnvelopeGain.connect(hissFilter.gain);
  hissAirEnvelopeGain.connect(hissAirFilter.gain);

  satDryGain.connect(satSumNode);
  satWetGain.connect(satSumNode);

  // 3. 3-Band Equalizer (Low Shelf, Mid Peaking, High Shelf)
  const eqLow = context.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.setValueAtTime(parameters.eqLowFreq, context.currentTime);
  eqLow.gain.setValueAtTime(parameters.eqLowGain, context.currentTime);
  eqLow.Q.setValueAtTime(parameters.eqLowQ || 0.70, context.currentTime);
  
  // Dedicated Low-Mid Peaking Filter for Warmth & Vocal Body (200Hz)
  const eqLowMid = context.createBiquadFilter();
  eqLowMid.type = 'peaking';
  eqLowMid.frequency.setValueAtTime(parameters.eqLowMidFreq || 200.0, context.currentTime);
  eqLowMid.gain.setValueAtTime(parameters.eqLowMidGain || 0.0, context.currentTime);
  eqLowMid.Q.setValueAtTime(parameters.eqLowMidQ || 0.60, context.currentTime);

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

  // Dedicated Mid-High Peaking Filter for Vocal Presence & Modern Shine (4800Hz)
  const eqMidHigh = context.createBiquadFilter();
  eqMidHigh.type = 'peaking';
  eqMidHigh.frequency.setValueAtTime(parameters.eqMidHighFreq || 4800.0, context.currentTime);
  eqMidHigh.gain.setValueAtTime(parameters.eqMidHighGain || 0.0, context.currentTime);
  eqMidHigh.Q.setValueAtTime(parameters.eqMidHighQ || 1.0, context.currentTime);

  const eqHigh = context.createBiquadFilter();
  eqHigh.type = 'highshelf';
  eqHigh.frequency.setValueAtTime(parameters.eqHighFreq, context.currentTime);
  eqHigh.gain.setValueAtTime(parameters.eqHighGain, context.currentTime);
  eqHigh.Q.setValueAtTime(parameters.eqHighQ || 0.70, context.currentTime);

  // Dedicated Dynamic Sibilance Notch (9000Hz De-esser)
  const sibilanceNotch = context.createBiquadFilter();
  sibilanceNotch.type = 'peaking';
  const safeDeesserStart = Math.min(parameters.deesserFreq || parameters.sibilanceDynamicFreq || 7500, (parameters.deesserMaxFreq || 9500) - 500);
  const safeDeesserEnd = Math.max(parameters.deesserMaxFreq || 9500, safeDeesserStart + 500);
  const deesserCenterFreq = Math.sqrt(safeDeesserStart * safeDeesserEnd);
  const deesserQ = deesserCenterFreq / (safeDeesserEnd - safeDeesserStart);
  sibilanceNotch.frequency.setValueAtTime(deesserCenterFreq, context.currentTime);
  sibilanceNotch.Q.setValueAtTime(deesserQ, context.currentTime); // dynamically calculated Q based on frequency band span
  sibilanceNotch.gain.setValueAtTime(0.0, context.currentTime); // default neutral

  const sibilanceNotchDynamicGain = context.createGain();
  // Decoupled from hissAmount: active if deesserAmount > 0
  const deesserAmt = parameters.deesserAmount || 0;
  const deesserMax = parameters.deesserMaxCut !== undefined ? parameters.deesserMaxCut : -15.0;
  const initDynamicCut = deesserMax * (deesserAmt / 100.0);
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
  eqLow.connect(eqLowMid);
  eqLowMid.connect(kickPeaking);
  kickPeaking.connect(eqMid);
  eqMid.connect(eqMidHigh);
  eqMidHigh.connect(eqHigh);
  eqHigh.connect(sibilanceNotch);
  sibilanceNotch.connect(eqCorrective1);
  eqCorrective1.connect(eqCorrective2);
  eqCorrective2.connect(eqCorrective3);
  eqCorrective3.connect(eqCorrective4);
  eqCorrective4.connect(eqCorrective5);
  eqCorrective5.connect(eqCorrective6);
  eqCorrective6.connect(eqCorrective7);
  eqCorrective7.connect(eqCorrective8);

  // 4. Glue Compressor
  const compressor = context.createDynamicsCompressor();
  compressor.knee.setValueAtTime(18.0, context.currentTime); // analog-style soft knee (18dB transition)

  if (parameters.compEnabled) {
    compressor.threshold.setValueAtTime(parameters.compThreshold, context.currentTime);
    compressor.ratio.setValueAtTime(parameters.compRatio, context.currentTime);
    compressor.attack.setValueAtTime(parameters.compAttack, context.currentTime);
    compressor.release.setValueAtTime(parameters.compRelease, context.currentTime);
  } else {
    compressor.threshold.setValueAtTime(0.0, context.currentTime);
    compressor.ratio.setValueAtTime(1.0, context.currentTime); // 1:1 ratio = Bypassed dynamics
  }

  eqCorrective8.connect(compressor);

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

  // 6. Pre-Limiter Mastering Soft Clipper (Tames transient peaks without digital clipping)
  const clipperDrive = parameters.clipperDrive !== undefined ? parameters.clipperDrive : 0.0;
  const preClipper = context.createWaveShaper();
  preClipper.curve = generateMasteringClipCurve(clipperDrive);
  preClipper.oversample = '2x';

  // 7. Maximizer Gain Stage (Loudness Boost to Target)
  const limiterGain = context.createGain();
  limiterGain.gain.setValueAtTime(Math.pow(10, parameters.limiterBoost / 20), context.currentTime);

  // Pro Mastering Pipeline:
  // (1) M/S Merger (audio <= 1.0) -> Pre-Clipper (Curve rounds peaks smoothly without C++ engine clamp)
  merger.connect(preClipper);
  // (2) Pre-Clipper -> Maximizer Boost (raises loudness cleanly)
  preClipper.connect(limiterGain);

  // 8. Brickwall Limiter (DynamicsCompressorNode)
  // Receives already peak-tamed audio, eliminating transient overshoot & pumping
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-1.0, context.currentTime); // -1.0dB に引き上げて過剰な圧縮圧と高域トランジェントの潰れを低減（ダイナミクスを保護）
  
  // 温和なジャンルでの低音サイクルの波形歪み（ビビり音）を完全に防止するため、リミッター時定数を動的設定
  const genreSelect = typeof document !== 'undefined' ? document.getElementById('preset-select') : null;
  const genreKey = genreSelect ? genreSelect.value : 'auto';
  const isGentle = (genreKey === 'classic' || genreKey === 'jazz' || genreKey === 'ambient' || genreKey === 'acoustic' || genreKey === 'podcast' ||
                    (genreKey === 'auto' && (aiDetectedGenre === 'classic' || aiDetectedGenre === 'jazz' || aiDetectedGenre === 'ambient' || aiDetectedGenre === 'acoustic' || aiDetectedGenre === 'podcast')));
  
  const initialAttack = isGentle ? 0.005 : 0.001; // 温和な曲には5msアタックで超低域波形を保護、モダンな大音圧曲には1.0ms超高速アタック
  const initialRelease = isGentle ? 0.25 : 0.12;  // 温和な曲には250msリリースで歪み防止、モダンな曲には音圧重視の120ms
  const initialKnee = isGentle ? 12.0 : 4.0;      // 温和な曲には12dBソフト膝で極めて自然な制限、モダンな曲には4dB

  limiter.knee.setValueAtTime(initialKnee, context.currentTime);
  limiter.ratio.setValueAtTime(20.0, context.currentTime);
  limiter.attack.setValueAtTime(initialAttack, context.currentTime);
  limiter.release.setValueAtTime(initialRelease, context.currentTime);

  // (3) Maximizer Boost -> Limiter
  limiterGain.connect(limiter);

  // 8b. Safety Soft Clipper (WaveShaper Node)
  const safetyClipper = context.createWaveShaper();
  safetyClipper.curve = generateSoftClipCurve();
  safetyClipper.oversample = '2x'; // 2x oversampling to prevent aliasing

  limiter.connect(safetyClipper);

  // 9. Ceiling Gain Node
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
    hissAirFilter,
    hissEnvelopeGain,
    hissAirEnvelopeGain,
    satDryGain,
    satWetGain,
    satLpf,
    waveShaper,
    eqLow,
    eqLowMid,
    kickPeaking,
    eqMid,
    eqMidHigh,
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
    preClipper,
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
  activeNodes.satLpf = chain.satLpf;
  activeNodes.waveShaper = chain.waveShaper;
  activeNodes.eqLow = chain.eqLow;
  activeNodes.eqLowMid = chain.eqLowMid;
  activeNodes.kickPeaking = chain.kickPeaking;
  activeNodes.eqMid = chain.eqMid;
  activeNodes.eqMidHigh = chain.eqMidHigh;
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
  activeNodes.preClipper = chain.preClipper;
  activeNodes.limiterGain = chain.limiterGain;
  activeNodes.limiter = chain.limiter;
  activeNodes.safetyClipper = chain.safetyClipper;
  activeNodes.ceilingGain = chain.ceilingGain;
  activeNodes.rumbleFilter = chain.rumbleFilter;
  activeNodes.hissFilter = chain.hissFilter;
  activeNodes.hissAirFilter = chain.hissAirFilter;
  activeNodes.hissEnvelopeGain = chain.hissEnvelopeGain;
  activeNodes.hissAirEnvelopeGain = chain.hissAirEnvelopeGain;

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

  // Draw timeline grid and time labels
  const duration = audioBuffer.duration;
  let intervalSec = 10;
  if (duration > 300) {
    intervalSec = 60;
  } else if (duration > 120) {
    intervalSec = 30;
  } else if (duration > 60) {
    intervalSec = 20;
  } else if (duration > 30) {
    intervalSec = 10;
  } else {
    intervalSec = 5;
  }

  waveCtx.font = '9px "Outfit", "Segoe UI", sans-serif';
  waveCtx.fillStyle = 'rgba(148, 163, 184, 0.65)'; // Sleek slate gray text
  waveCtx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  waveCtx.lineWidth = 1;
  waveCtx.textBaseline = 'bottom';
  
  for (let t = intervalSec; t < duration; t += intervalSec) {
    const progress = t / duration;
    const x = progress * wWidth;
    
    // Vertical grid line
    waveCtx.beginPath();
    waveCtx.moveTo(x, 0);
    waveCtx.lineTo(x, wHeight);
    waveCtx.stroke();
    
    // Time string MM:SS
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    waveCtx.fillText(timeStr, x + 4, wHeight - 4);
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

    // 1. Pre-Limiter Soft Clipper simulation (shaves transient peaks gently without engine clamping)
    if (p.clipperDrive > 0) {
      const T = Math.max(0.60, 1.0 - (p.clipperDrive / 6.0) * 0.35);
      const clipFunc = (v) => {
        const absV = Math.abs(v);
        if (absV <= T) return v;
        const u = Math.min(1.0, (absV - T) / (1.0 - T));
        return Math.sign(v) * (T + (1.0 - T) * (u - u * u + (u * u * u) / 3.0));
      };
      max = clipFunc(max);
      min = clipFunc(min);
    }

    // 2. Boost into Maximizer Stage (Raises loudness to target)
    max *= limitG;
    min *= limitG;

    // 3. Limiter dynamic control (receives peak-tamed audio, zero pumping)
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
  if (activeNodes.rumbleFilter && activeNodes.hissFilter && activeNodes.hissAirFilter &&
      activeNodes.hissEnvelopeGain && activeNodes.hissAirEnvelopeGain) {
    const targetRumbleFreq = params.rumbleCutEnabled ? 90.0 : 18.0; // 18Hz subsonic filter when disabled, protecting deep sub-bass while removing DC offset/infrasound mud.
    activeNodes.rumbleFilter.frequency.setTargetAtTime(targetRumbleFreq, audioContext.currentTime, 0.02);
    
    const hissAmount = params.hissReductionAmount || 0;
    const maxCut = params.hissReductionMaxCut !== undefined ? params.hissReductionMaxCut : -16.0;
    // ベースゲインはマイナスの値（減衰）
    const baseGain = maxCut * (hissAmount / 100.0);
    const safeHissStart = Math.min(params.hissReductionFreq || 9000.0, (params.hissReductionMaxFreq || 16000.0) - 1000.0);
    const safeHissEnd = Math.max(params.hissReductionMaxFreq || 16000.0, safeHissStart + 1000.0);
    activeNodes.hissFilter.gain.setTargetAtTime(baseGain, audioContext.currentTime, 0.02);
    activeNodes.hissFilter.frequency.setTargetAtTime(safeHissStart, audioContext.currentTime, 0.02);
    
    // Hiss Air Filter (相殺ゲインはプラスの値、ベースゲインの逆符号)
    activeNodes.hissAirFilter.gain.setTargetAtTime(-baseGain, audioContext.currentTime, 0.02);
    activeNodes.hissAirFilter.frequency.setTargetAtTime(safeHissEnd, audioContext.currentTime, 0.02);
    
    // 楽曲演奏時には減衰量を打ち消してフラットにするため、正のゲインを封入
    const maxEnvGain = -baseGain;
    activeNodes.hissEnvelopeGain.gain.setTargetAtTime(maxEnvGain, audioContext.currentTime, 0.02);
    // 上限周波数の正の相殺ゲインを打ち消すため、負のゲインを封入
    activeNodes.hissAirEnvelopeGain.gain.setTargetAtTime(-maxEnvGain, audioContext.currentTime, 0.02);

    // Decoupled from hissAmount: active if deesserAmount > 0
    if (activeNodes.sibilanceNotch && activeNodes.sibilanceNotchDynamicGain) {
      const amount = params.deesserAmount || 0;
      const deesserMax = params.deesserMaxCut !== undefined ? params.deesserMaxCut : -15.0;
      // シャリシャリ（サ行等のシビランス）を強力に吸い取るため、最大減衰量を調整可能にして除去力を向上
      const dynamicCut = deesserMax * (amount / 100.0);
      
      const safeDeesserStart = Math.min(params.deesserFreq || params.sibilanceDynamicFreq || 7500, (params.deesserMaxFreq || 9500) - 500);
      const safeDeesserEnd = Math.max(params.deesserMaxFreq || 9500, safeDeesserStart + 500);
      const deesserCenterFreq = Math.sqrt(safeDeesserStart * safeDeesserEnd);
      const deesserQ = deesserCenterFreq / (safeDeesserEnd - safeDeesserStart);
      
      activeNodes.sibilanceNotch.frequency.setTargetAtTime(deesserCenterFreq, audioContext.currentTime, 0.02);
      activeNodes.sibilanceNotch.Q.setTargetAtTime(deesserQ, audioContext.currentTime, 0.02);
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
    if (activeNodes.satLpf) {
      activeNodes.satLpf.frequency.setTargetAtTime(p.satLpfFreq || 4500.0, audioContext.currentTime, 0.01);
    }
  }
}

function updateEqNodes() {
  invalidatePeakCache();
  const p = getCombinedParams();

  if (activeNodes.eqLow) {
    activeNodes.eqLow.frequency.setTargetAtTime(p.eqLowFreq, audioContext.currentTime, 0.01);
    activeNodes.eqLow.gain.setTargetAtTime(p.eqLowGain, audioContext.currentTime, 0.01);
    activeNodes.eqLow.Q.setTargetAtTime(p.eqLowQ || 0.70, audioContext.currentTime, 0.01);
  }
  if (activeNodes.eqLowMid) {
    activeNodes.eqLowMid.frequency.setTargetAtTime(p.eqLowMidFreq || 200, audioContext.currentTime, 0.01);
    activeNodes.eqLowMid.gain.setTargetAtTime(p.eqLowMidGain || 0.0, audioContext.currentTime, 0.01);
    activeNodes.eqLowMid.Q.setTargetAtTime(p.eqLowMidQ || 0.60, audioContext.currentTime, 0.01);
  }
  if (activeNodes.kickPeaking) {
    activeNodes.kickPeaking.gain.setTargetAtTime(p.kickPeakingGain, audioContext.currentTime, 0.01);
  }
  if (activeNodes.eqMid) {
    activeNodes.eqMid.frequency.setTargetAtTime(p.eqMidFreq, audioContext.currentTime, 0.01);
    activeNodes.eqMid.gain.setTargetAtTime(p.eqMidGain, audioContext.currentTime, 0.01);
    activeNodes.eqMid.Q.setTargetAtTime(p.eqMidQ, audioContext.currentTime, 0.01);
  }
  if (activeNodes.eqMidHigh) {
    activeNodes.eqMidHigh.frequency.setTargetAtTime(p.eqMidHighFreq || 4800, audioContext.currentTime, 0.01);
    activeNodes.eqMidHigh.gain.setTargetAtTime(p.eqMidHighGain || 0.0, audioContext.currentTime, 0.01);
    activeNodes.eqMidHigh.Q.setTargetAtTime(p.eqMidHighQ || 1.0, audioContext.currentTime, 0.01);
  }
  if (activeNodes.eqHigh) {
    activeNodes.eqHigh.frequency.setTargetAtTime(p.eqHighFreq, audioContext.currentTime, 0.01);
    activeNodes.eqHigh.gain.setTargetAtTime(p.eqHighGain, audioContext.currentTime, 0.01);
    activeNodes.eqHigh.Q.setTargetAtTime(p.eqHighQ || 0.70, audioContext.currentTime, 0.01);
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
  invalidatePeakCache();
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
    
    // プリセット切替時やAI解析時にもリミッターの時定数を動的に再調整して中低域のビビリ歪みを防止
    if (activeNodes.limiter) {
      const genreSelect = typeof document !== 'undefined' ? document.getElementById('preset-select') : null;
      const genreKey = genreSelect ? genreSelect.value : 'auto';
      const isGentle = (genreKey === 'classic' || genreKey === 'jazz' || genreKey === 'ambient' || genreKey === 'acoustic' || genreKey === 'podcast' ||
                        (genreKey === 'auto' && (aiDetectedGenre === 'classic' || aiDetectedGenre === 'jazz' || aiDetectedGenre === 'ambient' || aiDetectedGenre === 'acoustic' || aiDetectedGenre === 'podcast')));
      
      const targetAttack = isGentle ? 0.005 : 0.001; // 5ms attack to protect low cycles; 1.0ms for modern loud tracks
      const targetRelease = isGentle ? 0.25 : 0.12;  // 250ms release for clean low end; 120ms for modern loud tracks
      const targetKnee = isGentle ? 12.0 : 4.0;      // 12dB soft knee for transparent limiting; 4dB knee for modern loud tracks
      
      activeNodes.limiter.attack.setTargetAtTime(targetAttack, audioContext.currentTime, 0.02);
      activeNodes.limiter.release.setTargetAtTime(targetRelease, audioContext.currentTime, 0.02);
      activeNodes.limiter.knee.setTargetAtTime(targetKnee, audioContext.currentTime, 0.02);
    }
  }
}

function updateClipperNode() {
  invalidatePeakCache();
  if (activeNodes.preClipper) {
    const p = getCombinedParams();
    const drive = p.clipperDrive !== undefined ? p.clipperDrive : 0.0;
    activeNodes.preClipper.curve = generateMasteringClipCurve(drive);
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
export function analyzeAudioResonances(buffer, userPresetKey) {
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
  
  // 1. 第一パス：各スライスのRMSを算出して最大RMS値を特定し、無音しきい値を決定
  const sliceRMSList = [];
  let maxRmsVal = 0.001;
  
  for (const startIdx of slicePoints) {
    let sliceSumSq = 0.0;
    for (let j = 0; j < fftSize; j++) {
      const idx = startIdx + j;
      if (idx >= buffer.length) break;
      const l = chL[idx];
      const r = chR[idx];
      const mid = (l + r) * 0.5;
      sliceSumSq += mid * mid;
    }
    const sliceRMS = Math.sqrt(sliceSumSq / fftSize);
    sliceRMSList.push(sliceRMS);
    if (sliceRMS > maxRmsVal) {
      maxRmsVal = sliceRMS;
    }
  }

  // 無音判定のしきい値（最大音量の2%）
  const silenceThreshold = maxRmsVal * 0.02;

  // 2. 第二パス：アクティブな（無音でない）スライスのみを対象にFFT解析と累積平均スペクトラムの計算を実行
  let activeSliceCount = 0;
  const sliceSpectrums = [];
  let totalEnergyL2 = 0;
  let totalEnergyR2 = 0;
  let totalDotProduct = 0;
  let maxAbsSample = 0.0;
  let sumRMS2 = 0.0;

  for (let i = 0; i < slicePoints.length; i++) {
    const startIdx = slicePoints[i];
    const sliceRMS = sliceRMSList[i];
    
    // このスライスがアクティブかどうか
    const isActive = (sliceRMS >= silenceThreshold);
    
    let sliceMax = 0.0;
    let sliceSumSq = 0.0;
    let sliceDotProduct = 0;
    let sliceSumL2 = 0;
    let sliceSumR2 = 0;

    // サンプルデータの集計（統計とFFT用）
    for (let j = 0; j < fftSize; j++) {
      const idx = startIdx + j;
      if (idx >= buffer.length) break;

      const l = chL[idx];
      const r = chR[idx];
      const mid = (l + r) * 0.5;

      re[j] = mid;
      im[j] = 0;

      const absL = Math.abs(l);
      const absR = Math.abs(r);
      if (absL > sliceMax) sliceMax = absL;
      if (absR > sliceMax) sliceMax = absR;
      
      sliceSumSq += mid * mid;
      sliceDotProduct += l * r;
      sliceSumL2 += l * l;
      sliceSumR2 += r * r;
    }

    if (sliceMax > maxAbsSample) maxAbsSample = sliceMax;
    sumRMS2 += sliceRMS * sliceRMS;
    totalDotProduct += sliceDotProduct;
    totalEnergyL2 += sliceSumL2;
    totalEnergyR2 += sliceSumR2;

    const spec = new Float32Array(fftSize / 2);
    
    // アクティブなスライスのみFFTを実行し、平均スペクトラムに累積
    if (isActive) {
      for (let j = 0; j < fftSize; j++) {
        const windowVal = 0.5 * (1 - Math.cos((2 * Math.PI * j) / (fftSize - 1)));
        re[j] *= windowVal;
      }
      fft(re, im);
      const normFactor = fftSize / 2;
      for (let j = 0; j < fftSize / 2; j++) {
        const mag = Math.sqrt(re[j] * re[j] + im[j] * im[j]) / normFactor;
        avgSpectrum[j] += mag; // 後でactiveSliceCountで除算
        spec[j] = mag;
      }
      activeSliceCount++;
    } else {
      // 無音スライスの場合はスペクトラムを0にする
      spec.fill(0);
    }
    sliceSpectrums.push(spec);
  }

  // 平均スペクトラムの正規化（アクティブなスライス数で平均化）
  if (activeSliceCount > 0) {
    for (let j = 0; j < fftSize / 2; j++) {
      avgSpectrum[j] /= activeSliceCount;
    }
  } else {
    // 万が一すべてが無音だった場合は全体の平均にする
    for (let j = 0; j < fftSize / 2; j++) {
      avgSpectrum[j] /= numSlices;
    }
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
  // 高域（Treble）のエネルギー比率は、低中域（Low-Mid）ではなく中高域（High-Mid / プレゼンス）と比較することで、
  // Suno音源特有の「中域の過圧縮（デコボコした密度）」による影響を排除し、純粋な高域のシャリシャリ感のみを精密測定します。
  const actualHighMidRatio = energyTreble / (energyHighMid + 1e-6);
  const actualPresenceRatio = energyHighMid / (energyLowMid + 1e-6);

  let minRmsIdx = 0;
  let minRmsVal = 1.0;
  let foundValidBlock = false;
  // (silenceThresholdは既に上部で算出されています)

  for (let i = 0; i < sliceRMSList.length; i++) {
    if (sliceRMSList[i] >= silenceThreshold) {
      if (sliceRMSList[i] < minRmsVal) {
        minRmsVal = sliceRMSList[i];
        minRmsIdx = i;
        foundValidBlock = true;
      }
    }
  }

  // 万が一すべての区間が閾値以下になった場合は、従来の絶対最小の区間を使用
  if (!foundValidBlock) {
    minRmsVal = 1.0;
    for (let i = 0; i < sliceRMSList.length; i++) {
      if (sliceRMSList[i] < minRmsVal) {
        minRmsVal = sliceRMSList[i];
        minRmsIdx = i;
      }
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
  // しきい値を-58dBから-65dBに引き下げ、微小な超低音ノイズに対しても過敏に反応してカットできるように感度を向上
  if (rumbleNoiseFloorDb > -65.0) {
    sugRumbleCut = true;
  }

  let sugHissAmount = 0;
  // しきい値を-78dBから-83dBに引き下げ（ヘッドホン等で聞こえる微小なアナログサー音やヒスノイズまで検知可能に）
  if (hissNoiseFloorDb > -83.0) {
    // ノイズフロアに応じて20%〜98%の間で段階的に適用度を算出するスケール（感度係数を8.0に高め、ノイズ検知力を向上）
    const rawHiss = Math.round(Math.max(0, Math.min(98, 20 + (hissNoiseFloorDb + 83.0) * 8.0)));
    
    // 静寂区間（最も静かな1秒間）のRMS音量が比較的高い場合、それはヒスではなく楽曲の音である可能性が高いため
    // LPFの過剰カットを防ぐため、Hiss Reducerの適用度を少し抑える安全スケーラー（最小減衰幅を0.70に緩和して感度を維持）
    let quietnessScale = 1.0;
    if (minRmsVal > 0.05) {
      quietnessScale = Math.max(0.70, 1.0 - (minRmsVal - 0.05) / 0.15);
    }
    sugHissAmount = Math.round(rawHiss * quietnessScale);
  }

  // 歌の音域のカーン域共鳴音（1000Hz-4000Hz）および高域の鋭いピーク（4000Hz-12000Hz）をマルチスキャンして自動補正ノッチを構築
  const filteredPeaks = [];
  const scanMinBin = Math.floor((1000 * fftSize) / sampleRate);
  const scanMaxBin = Math.min(fftSize / 2 - 1, Math.floor((12000 * fftSize) / sampleRate));
  const rawResonancePeaks = [];

  for (let j = scanMinBin; j < scanMaxBin; j++) {
    const val = avgSpectrum[j];
    const peakFreq = Math.round((j * sampleRate) / fftSize);
    
    if (val > avgSpectrum[j - 1] && val > avgSpectrum[j + 1]) {
      const localBins = [
        avgSpectrum[j - 4], avgSpectrum[j - 3], avgSpectrum[j - 2],
        avgSpectrum[j + 2], avgSpectrum[j + 3], avgSpectrum[j + 4]
      ];
      const localFloor = localBins.reduce((sum, v) => sum + v, 0) / localBins.length;
      const ratio = val / (localFloor + 1e-9);

      // Mid range (1kHz-4kHz) vs High range (4kHz-12kHz) detection thresholds
      const isMidRange = (peakFreq >= 1000 && peakFreq < 4000);
      const thresholdMultiplier = isMidRange ? 1.25 : 1.15; // Mid is slightly more robust, high is sensitive
      
      if (ratio > thresholdMultiplier) {
        let cutDb = 0;
        let targetQ = 10.0;
        
        if (isMidRange) {
          // Mid range (vocals, "ka-n" resonance): apply gentle notch (-1.0dB to -2.8dB max) to avoid hollow vocals
          cutDb = -Math.min(2.8, 1.0 + (ratio - thresholdMultiplier) * 5.0);
          targetQ = 10.0; // musical Q for voice resonance removal
        } else {
          // High range (whistles, sibilance): apply surgical notch (-1.5dB to -4.5dB max)
          cutDb = -Math.min(4.5, 1.5 + (ratio - thresholdMultiplier) * 7.0);
          targetQ = 15.0; // very narrow Q for high frequency whistle notch
        }

        rawResonancePeaks.push({
          freq: peakFreq,
          cut: Math.round(cutDb * 10) / 10,
          q: targetQ,
          score: ratio,
          isBroad: isMidRange
        });
      }
    }
  }

  // Sort peaks by prominence score descending
  rawResonancePeaks.sort((a, b) => b.score - a.score);

  // Select top 8 peaks that are at least 350Hz apart to avoid clustering
  for (const peak of rawResonancePeaks) {
    if (filteredPeaks.length >= 8) break;
    const tooClose = filteredPeaks.some(p => Math.abs(p.freq - peak.freq) < 350);
    if (!tooClose) {
      filteredPeaks.push(peak);
    }
  }
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

  // 決定木型ジャンル自動検出 (2パス実効解析による周波数バランス比率分類)
  let detectedGenre = 'pops';
  if (actualLowMidRatio > 3.2) {
    // 重低音が強烈な電子音楽・クラブ系
    if (actualHighMidRatio > 0.09 || actualPresenceRatio > 0.38) {
      detectedGenre = 'edm';
    } else {
      detectedGenre = 'hiphop';
    }
  } else if (actualPresenceRatio > 0.42) {
    // 中高域（1.5kHz-5kHzのギター壁・ボーカル）が際立つ激しい音楽
    if (actualHighMidRatio > 0.12 || actualLowMidRatio > 3.0) {
      detectedGenre = 'metal';
    } else {
      detectedGenre = 'rock';
    }
  } else if (crestFactorDb >= 12.8) {
    // ダイナミックレンジが広く圧縮感のない音楽
    if (actualLowMidRatio >= 2.2 && actualLowMidRatio <= 3.0) {
      detectedGenre = 'jazz';
    } else if (actualLowMidRatio < 2.2 && actualHighMidRatio < 0.03) {
      detectedGenre = 'classic';
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
  // AI AUTO解析時は、検出されたジャンル専用のターゲットとベースプリセットを使用することで、
  // ジャンル本来の強み（EDMなら重低音、クラシックなら控えめで自然な音響など）を損なわずに精密補正します。
  const basePresetKey = (genreKey === 'auto') ? detectedGenre : genreKey;
  const basePreset = GENRE_PRESETS[basePresetKey] || GENRE_PRESETS.auto;
  const target = GENRE_TARGETS[basePresetKey] || GENRE_TARGETS.auto;

  // EDM, HIPHOP, HARDCORE などの重低音（サブベース）を重視するジャンルの場合、
  // 80Hz以下の帯域を急峻にカットする Rumble Cut はサブベースをごそっと削り取ってしまうため、AI自動解析によるONを禁止します。
  const isSubBassGenre = (detectedGenre === 'edm' || detectedGenre === 'hiphop' || detectedGenre === 'hardcore' ||
                          genreKey === 'edm' || genreKey === 'hiphop' || genreKey === 'hardcore');
  if (isSubBassGenre) {
    sugRumbleCut = false;
  }

  const lowDiffDb = 20 * Math.log10(actualLowMidRatio / target.low);
  const highDiffDb = 20 * Math.log10(actualHighMidRatio / target.high);
  const targetPresence = target.presence || 0.42;
  const presenceDiffDb = 20 * Math.log10(actualPresenceRatio / targetPresence);

  // クラシックやアコースティックなどの生楽器主体のダイナミックな楽曲は、
  // アレンジャーや録音エンジニアが意図的に調整した繊細な帯域バランスを破壊しないよう、
  // AIによる自動イコライジング（補正値）の適用強度を25%以下に大幅に抑制（スケールダウン）します。
  // また、クレストファクター（強弱差）が大きい楽曲全体も適用度を50%に抑え、不要な歪みやビビリ音の発生を未然に防止します。
  const isGentleGenre = (detectedGenre === 'classic' || detectedGenre === 'acoustic' || basePresetKey === 'classic' || basePresetKey === 'acoustic');
  const spectralCorrectionScale = isGentleGenre ? 0.25 : (crestFactorDb > 12.0 ? 0.50 : 1.0);

  // 5. HIGH EQ (高域・エアバンド補正: 14000Hz) の先行計算（スペクトル傾斜リンク用）
  const eqHighAdjustment = -highDiffDb * 1.25 * spectralCorrectionScale;
  const eqHighGainTemp = Math.max(-4.5, Math.min(4.0, Math.round((basePreset.eqHighGain + eqHighAdjustment) * 10) / 10));

  // 高域をカットした際、聴感上の低域のブワつき（ぼわーん感）を防ぐため、
  // HIGH EQの減衰量に連動してLOW/LOW-MIDを自動的かつ微量に引き締める「スペクトル・傾斜リンク補正」を適用します。
  let tiltCompensation = 0.0;
  if (eqHighGainTemp < 0.0) {
    tiltCompensation = eqHighGainTemp * 0.12; // 例: -1.2dBカットのとき、-0.14dBの低音引き締め（中間値へマイルド化）
  }

  // =========================================================================
  // ACADEMIC SPECTRAL FREQUENCY OPTIMIZATION FOR 5-BAND EQ
  // =========================================================================
  // 1. 周波数重心 (Spectral Centroid) 算出関数
  const getSpectralCentroid = (minHz, maxHz) => {
    const bStart = Math.max(1, Math.floor((minHz * fftSize) / sampleRate));
    const bEnd = Math.min(fftSize / 2 - 1, Math.floor((maxHz * fftSize) / sampleRate));
    let weightedSum = 0;
    let energySum = 0;
    for (let b = bStart; b <= bEnd; b++) {
      const f = (b * sampleRate) / fftSize;
      const mag = avgSpectrum[b];
      weightedSum += f * mag;
      energySum += mag;
    }
    return energySum > 0 ? (weightedSum / energySum) : ((minHz + maxHz) / 2);
  };

  // 2. 局所共鳴ピーク (Prominent Spectral Peak) 探索関数
  const getProminentPeakFreq = (minHz, maxHz, fallbackHz) => {
    const bStart = Math.max(2, Math.floor((minHz * fftSize) / sampleRate));
    const bEnd = Math.min(fftSize / 2 - 2, Math.floor((maxHz * fftSize) / sampleRate));
    let bestFreq = fallbackHz;
    let maxProminence = 1.05; // 最低でも5%の局所突起が必要
    for (let b = bStart; b <= bEnd; b++) {
      const mag = avgSpectrum[b];
      if (mag > avgSpectrum[b - 1] && mag > avgSpectrum[b + 1]) {
        const floor = (avgSpectrum[b - 2] + avgSpectrum[b + 2]) * 0.5 + 1e-9;
        const prom = mag / floor;
        if (prom > maxProminence) {
          maxProminence = prom;
          bestFreq = Math.round((b * sampleRate) / fftSize);
        }
      }
    }
    return bestFreq;
  };

  // 3. 最大エネルギー周波数 (Max Energy Frequency) 探索関数
  const getMaxEnergyFreq = (minHz, maxHz, fallbackHz) => {
    const bStart = Math.max(1, Math.floor((minHz * fftSize) / sampleRate));
    const bEnd = Math.min(fftSize / 2 - 1, Math.floor((maxHz * fftSize) / sampleRate));
    let bestFreq = fallbackHz;
    let maxEnergy = -1;
    for (let b = bStart; b <= bEnd; b++) {
      if (avgSpectrum[b] > maxEnergy) {
        maxEnergy = avgSpectrum[b];
        bestFreq = Math.round((b * sampleRate) / fftSize);
      }
    }
    return bestFreq;
  };

  // 1. LOW EQ (低域シェルフ: 50Hz〜130Hz)
  // ターゲットからのズレを100%反転して補正値とします（最大+4.0dB〜-4.0dB）
  const eqLowAdjustment = -lowDiffDb * spectralCorrectionScale;
  // Spotify基準のタイトな低音に極限まで肉薄させるため、自動算出値に対してわずか -0.3dB の微調整用カットバイアスおよび傾斜リンク補正を適用します
  const eqLowGain = Math.max(-4.0, Math.min(4.0, Math.round((basePreset.eqLowGain + eqLowAdjustment - 0.3 + tiltCompensation) * 10) / 10));

  // 40Hz〜160Hz区間のスペクトルエネルギー重心および最大ピークを解析
  const lowCentroid = getSpectralCentroid(40, 160);
  const lowPeak = getMaxEnergyFreq(40, 130, 80);
  let suggestedEqLowFreq;
  if (lowDiffDb < -0.8) {
    // 低域不足（ブースト時）：キックの胴鳴りとベース土台を豊かに持ち上げるため、重心やや下（60〜85Hz）に配置
    const targetHz = lowCentroid * 0.4 + lowPeak * 0.6;
    suggestedEqLowFreq = Math.max(60, Math.min(85, Math.round(targetHz / 5) * 5));
  } else if (lowDiffDb > 0.8) {
    // 低域過剰（カット時）：50Hz付近のサブベースを削らず、不要な100Hz前後のブーミー感を落とすため高め（95〜125Hz）に配置
    const targetHz = Math.max(95, lowCentroid * 1.12);
    suggestedEqLowFreq = Math.max(95, Math.min(125, Math.round(targetHz / 5) * 5));
  } else {
    // 概ねバランス良好：重心周波数をベースに75〜105Hzで自然にチューニング
    suggestedEqLowFreq = Math.max(75, Math.min(105, Math.round(lowCentroid / 5) * 5));
  }

  // 2. LOW-MID EQ (中低域ピーク: 180Hz〜360Hz)
  // 低域全体の過不足に対して50%の割合で追従し、ふくよかさ・スッキリ感を調整します（最大+2.0dB〜-2.0dB）。傾斜リンク補正も加味します。
  const eqLowMidAdjustment = -lowDiffDb * 0.5 * spectralCorrectionScale;
  const eqLowMidGain = Math.max(-2.0, Math.min(2.0, Math.round((basePreset.eqLowMidGain + eqLowMidAdjustment + tiltCompensation) * 10) / 10));

  // 180Hz〜360Hzの「こもり・箱鳴り・帯域重複」の共鳴ピークをスキャン
  const lowMidPeak = getProminentPeakFreq(180, 360, 0);
  const lowMidCentroid = getSpectralCentroid(180, 360);
  let suggestedEqLowMidFreq;
  if (lowMidPeak >= 180 && lowMidPeak <= 360) {
    suggestedEqLowMidFreq = Math.round(lowMidPeak / 5) * 5;
  } else {
    suggestedEqLowMidFreq = Math.max(190, Math.min(340, Math.round(lowMidCentroid / 5) * 5));
  }

  // 3. MID EQ (中域ピーク: 700Hz〜1600Hz)
  // 箱鳴りやラジオ感を防ぐため、追従感度を 0.5 → 0.75 に高め、カットバイアスも -0.8 → -1.5dB へ強めてすっきりさせます
  const eqMidAdjustment = (-presenceDiffDb * 0.75 - 1.5) * spectralCorrectionScale; 
  const eqMidGain = Math.max(-4.5, Math.min(0.5, Math.round((basePreset.eqMidGain + eqMidAdjustment) * 10) / 10));

  // 700Hz〜1600Hzの中域母音フォルマント・鼻声・缶鳴りピークをスキャン
  const midPeak = getProminentPeakFreq(700, 1600, 0);
  const midCentroid = getSpectralCentroid(700, 1600);
  let suggestedEqMidFreq;
  if (midPeak >= 700 && midPeak <= 1600) {
    suggestedEqMidFreq = Math.round(midPeak / 25) * 25;
  } else {
    suggestedEqMidFreq = Math.max(750, Math.min(1500, Math.round(midCentroid / 25) * 25));
  }

  // 4. MID-HIGH EQ (中高域ピーク: 2500Hz〜5500Hz)
  // 等ラウドネス曲線（ISO 226）に基づき、聴覚感度が急峻に高まる3k〜5kHz帯の過剰な持ち上げ（聴覚疲労・音割れの原因）を完全リセット。
  // 原則としてフラット（0.0dB）を基準とし、ターゲット偏差に対する微細なティルト補正（±1.5dB以内、感度0.35）にとどめます。
  const eqMidHighAdjustment = -presenceDiffDb * 0.35 * spectralCorrectionScale;
  const eqMidHighGain = Math.max(-1.5, Math.min(1.5, Math.round((basePreset.eqMidHighGain + eqMidHighAdjustment) * 10) / 10));

  // 2500Hz〜5500Hzの外耳道共鳴・耳障りな摩擦音（Presence/Harshness）ピークをスキャン
  let harshPeak = 0;
  const harshRes = filteredPeaks.find(p => p.freq >= 2500 && p.freq <= 5500);
  if (harshRes) {
    harshPeak = harshRes.freq;
  } else {
    harshPeak = getProminentPeakFreq(2500, 5500, 0);
  }
  const midHighCentroid = getSpectralCentroid(2500, 5500);
  let suggestedEqMidHighFreq;
  if (harshPeak >= 2500 && harshPeak <= 5500) {
    suggestedEqMidHighFreq = Math.round(harshPeak / 50) * 50;
  } else {
    suggestedEqMidHighFreq = Math.max(2800, Math.min(5000, Math.round(midHighCentroid / 50) * 50));
  }

  // 5. HIGH EQ (高域・エアバンド補正: 14000Hz)
  // ターゲットからのズレを100%反転して直接補正。曇った音源は明るく、うるさい音源は暖かく整えます（最大+3.5dB〜-4.5dB）
  // 1. 入力ゲインステージングの先行計算（ピークレベルを -6.0dBFS に整えヘッドルームを確保）
  const originalPeakDb = 20 * Math.log10(maxAbsSample + 1e-6);
  const suggestedInputGainDb = Math.max(-12.0, Math.min(12.0, -6.0 - originalPeakDb));

  // 2. ダイナミクス補正 (音楽理論・ダイナミックレンジ基準によるクレストファクター分析 ＆ 目標ラウドネス自動追従)
  let compThreshold = basePreset.compThreshold;
  let compRatio = basePreset.compRatio;
  let crestDesc = "Normal (Balanced)";

  // ピーク正規化後の信号の平均音量（RMS dBFS）
  const avgRmsDb = 20 * Math.log10(avgRMS + 1e-6);
  const rmsAfterGainDb = avgRmsDb + suggestedInputGainDb;

  // ジャンル別目標平均音量（RMS dB FS。-14LUFSターゲットに準拠）
  const genreTargetRmsDb = {
    auto: -14.5,
    pops: -14.0,     // Pops/J-POP: 標準ストリーミング (-14 LUFS相当)
    rnb: -13.5,
    rock: -13.0,
    metal: -12.5,    // Metal: 迫力ある音圧壁 (-12.5 dB)
    edm: -11.5,      // EDM: クラブ向け最大音圧 (-11.5 dB)
    hiphop: -12.5,
    lofi: -15.5,
    hardcore: -10.5, // Hardcore: 限界の押し込み (-10.5 dB)
    ambient: -17.5,
    podcast: -15.0,
    classic: -19.5,
    jazz: -16.0,
    acoustic: -16.5,
    custom: -14.5
  };
  const targetRmsDb = genreTargetRmsDb[genreKey] || genreTargetRmsDb.auto;

  // 目標ラウドネスまでに不足しているゲイン量（dB）
  let requiredBoost = targetRmsDb - rmsAfterGainDb;

  // クレストファクター（ダイナミックレンジの広さ）に応じたコンプレッションと音圧補正
  const genreTargetCrest = {
    auto: 10.5, pops: 11.0, rnb: 10.0, rock: 11.0, metal: 9.5, edm: 8.5,
    hiphop: 9.0, lofi: 12.0, hardcore: 7.5, ambient: 13.5, podcast: 10.5,
    classic: 14.5, jazz: 12.5, acoustic: 13.0, custom: 10.5
  };
  const targetCrest = genreTargetCrest[genreKey] || genreTargetCrest.auto;
  const crestDiff = crestFactorDb - targetCrest;

  if (crestDiff > 0.0) {
    // 音源がダイナミック（強弱が広い）-> コンプのしきい値を下げ、リミッターのブースト量を増やしてダイナミクスを制御
    const compressionFactor = Math.min(6.0, crestDiff * 0.45);
    const ratioFactor = Math.min(0.3, crestDiff * 0.06);
    compThreshold = Math.max(-14.0, basePreset.compThreshold - compressionFactor);
    compRatio = Math.min(1.8, basePreset.compRatio + ratioFactor);
    crestDesc = "High (Highly Dynamic)";
    
    // 強弱が広いものはリミッターで叩く余地を増やすためにブーストを加算
    requiredBoost += Math.min(1.5, crestDiff * 0.35);
  } else {
    // 音源がすでに強く圧縮されている -> 二重圧縮を防ぐため、コンプレッサーを逃がす
    const releaseFactor = Math.min(4.0, -crestDiff * 0.5);
    const ratioFactor = Math.min(0.2, -crestDiff * 0.05);
    compThreshold = Math.min(-5.0, basePreset.compThreshold + releaseFactor);
    compRatio = Math.max(1.15, basePreset.compRatio - ratioFactor);
    crestDesc = "Low (Highly Compressed)";
    
    // すでにダイナミクスがないためリミッターでの歪みを防ぐようブーストを減衰
    requiredBoost += Math.max(-2.5, crestDiff * 0.5);
  }

  // 音量低下を防止するための最低限のリミッターブースト（出力ピークが少なくとも-1.0dBFSに達するように補償）
  const baselineLimiterBoost = -1.0 - (suggestedInputGainDb + originalPeakDb);
  let limiterBoost = Math.max(baselineLimiterBoost, requiredBoost);

  // 低域飽和による歪み・ビビリ防止（低域が基準ターゲットより著しく大きい場合、マキシマイザーブーストを自動制限）
  if (lowDiffDb > 1.0) {
    const bassOverloadPenalty = Math.min(1.5, (lowDiffDb - 1.0) * 0.75);
    limiterBoost = Math.max(baselineLimiterBoost - 1.0, limiterBoost - bassOverloadPenalty);
  }

  // 温和なアコースティック・クラシック系ジャンルでは、リミッターによる強烈な圧縮歪みやビビリ音を防ぎ、
  // 原音の広いダイナミクスを保護するために、マキシマイザーブースト（limiterBoost）の最大上限値を控えめに制限します。
  let maxAllowedLimiterBoost = 10.0;
  if (detectedGenre === 'classic' || basePresetKey === 'classic') {
    maxAllowedLimiterBoost = 3.5;
  } else if (detectedGenre === 'acoustic' || basePresetKey === 'acoustic') {
    maxAllowedLimiterBoost = 4.5;
  } else if (detectedGenre === 'jazz' || detectedGenre === 'ambient' || detectedGenre === 'podcast' ||
             basePresetKey === 'jazz' || basePresetKey === 'ambient' || basePresetKey === 'podcast') {
    maxAllowedLimiterBoost = 5.5;
  }

  // どんなに静かな音源でも上限+10.0dB（温和なジャンルでは個別の最大上限）、元の音が大きい音源でも最小+1.0dB（のり効果）の範囲で調整
  limiterBoost = Math.max(1.0, Math.min(maxAllowedLimiterBoost, Math.round(limiterBoost * 10) / 10));

  // GUI表示および音圧制御用のラウドネス目標キーの取得
  const loudnessKey = typeof baseLoudnessTarget !== 'undefined' ? baseLoudnessTarget : (document.getElementById('loudness-select')?.value || 'genre');

  // 3. プレ・クリッパー＆リミッター・オーケストレーション（Crest Factor & Loudness Target に基づく統合音圧制御）
  let suggestedClipperDrive = basePreset.clipperDrive !== undefined ? basePreset.clipperDrive : 1.5;
  
  if (crestFactorDb > 11.5) {
    // トランジェントのトゲ（ドラムピーク）が大きいダイナミックな楽曲:
    // リミッターのポンピング（不自然な息継ぎ歪み）を防ぐため、クリッパーで過渡ピークを自然に 2〜3dB トリミング
    const clipperAdaptation = Math.min(2.0, (crestFactorDb - 11.5) * 0.5);
    suggestedClipperDrive = Math.min(5.0, suggestedClipperDrive + clipperAdaptation);
  } else if (crestFactorDb < 8.5) {
    // 既に強く圧縮されている楽曲: 余計なサチュレーション歪みを避けるため、クリッパーのドライブを控えめに緩和
    const clipperReduction = Math.min(1.5, (8.5 - crestFactorDb) * 0.5);
    suggestedClipperDrive = Math.max(0.0, suggestedClipperDrive - clipperReduction);
  }
  
  // ラウドネス目標に応じたクリッパーの最適補正
  if (loudnessKey === 'club') {
    suggestedClipperDrive = Math.max(suggestedClipperDrive, 2.5);
  } else if (loudnessKey === 'loud') {
    suggestedClipperDrive = Math.max(suggestedClipperDrive, 3.5);
  } else if (loudnessKey === 'streaming') {
    suggestedClipperDrive = Math.min(suggestedClipperDrive, 1.5);
  } else if (loudnessKey === 'pure') {
    suggestedClipperDrive = 0.0;
  }
  suggestedClipperDrive = Math.round(suggestedClipperDrive * 10) / 10;

  // GUI表示用のラウドネス説明テキストの構築
  let baseLoudnessDesc = "STREAMING (-14 LUFS)";
  if (loudnessKey === 'genre') {
    const genreName = genreKey.toUpperCase();
    baseLoudnessDesc = `GENRE DEFAULT (${genreName})`;
  } else if (LOUDNESS_TARGETS[loudnessKey]) {
    const targetNames = {
      streaming: "STREAMING (-14 LUFS)",
      club: "CLUB/MODERN (-9 LUFS)",
      loud: "LOUD (-7 LUFS)",
      pure: "PURE (-18 LUFS)"
    };
    baseLoudnessDesc = targetNames[loudnessKey] || `TARGET (${loudnessKey})`;
  } else {
    baseLoudnessDesc = "CUSTOM";
  }
  
  const isElectronicGenre = (detectedGenre === 'edm' || detectedGenre === 'hardcore' || detectedGenre === 'metal' ||
                             genreKey === 'edm' || genreKey === 'hardcore' || genreKey === 'metal');
  
  // 先行計算した eqHighGainTemp を本採用します
  let eqHighGain = eqHighGainTemp;

  // サ行（シビランス）検知時の高域クランプを少し緩和（超高音の曇りを防ぐため、2.2dB〜2.6dBまで許容）
  if (sibilanceDynamicFreq > 0) {
    const sibilanceClampLimit = isElectronicGenre ? 2.6 : 2.2; // 2.2〜2.6dB までは高域ブーストを許容して抜けを確保
    eqHighGain = Math.min(sibilanceClampLimit, eqHighGain);
  }

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

  // Calculate the high-frequency crossover frequency dynamically based on the treble roll-off slope (airToBrillianceRatio)
  // ボーカルのサ行や高域のきつい金属音（6kHz〜9kHz）をブーストするのを防ぐため、クロスオーバー下限周波数を10,500Hzに引き上げ（10.5kHz〜14kHzのエアバンド域のみを処理）
  const normalizedRatio = Math.max(0.08, Math.min(0.38, airToBrillianceRatio));
  let suggestedEqHighFreq = 10500 + ((normalizedRatio - 0.08) / 0.30) * 3500;
  if (sibilanceDynamicFreq > 0) {
    const deesserUpperLimit = Math.min(16000, Math.max(9500, sibilanceDynamicFreq + 1500));
    suggestedEqHighFreq = Math.max(suggestedEqHighFreq, deesserUpperLimit + 500);
  }
  suggestedEqHighFreq = Math.round(suggestedEqHighFreq / 100) * 100;
  suggestedEqHighFreq = Math.max(10000, Math.min(15000, suggestedEqHighFreq));

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

  let suggestedDeesserAmount = 0; // デフォルトは 0 (無効)
  if (sibilanceDynamicFreq > 0 && rawSibilancePeaks.length > 0) {
    const maxScore = rawSibilancePeaks[0].score;
    // 共鳴ピークが検出された場合のみアクティブにし、スコアに応じて35%〜80%の範囲で適用
    suggestedDeesserAmount = Math.round(Math.max(35, Math.min(80, 35 + (maxScore - 1.15) * 60)));
  }

  // ノイズクリーナー（Hiss Reducer ＆ De-esser）のジャンル別安全保護リミッター
  let finalHissAmount = sugHissAmount;
  let finalDeesserAmount = suggestedDeesserAmount;

  if (detectedGenre === 'edm' || detectedGenre === 'hiphop') {
    finalHissAmount = Math.min(25, finalHissAmount); // 最大25%に拡張（電子音楽の抜けを保護しつつノイズを吸い取る）
    finalDeesserAmount = Math.min(25, finalDeesserAmount); // 最大25%に拡張
  } else if (detectedGenre === 'rock' || detectedGenre === 'metal') {
    finalHissAmount = Math.min(35, finalHissAmount); // 最大35%に拡張
    finalDeesserAmount = Math.min(35, finalDeesserAmount); // 最大35%に拡張
  } else if (detectedGenre === 'jazz' || detectedGenre === 'acoustic' || detectedGenre === 'classic') {
    finalHissAmount = Math.min(35, finalHissAmount); // 最大35%に拡張
    finalDeesserAmount = Math.min(30, finalDeesserAmount); // 最大30%に拡張
  } else {
    // pops, lofi 等
    finalHissAmount = Math.min(60, finalHissAmount); // 最大60%に拡張（高域ヒスを最大-4.8dBまで低減）
    finalDeesserAmount = Math.min(70, finalDeesserAmount); // 最大70%に拡張（サ行トゲを最大-3.1dBまで低減）
  }

  // AI Dynamic Q-value calculation based on the correction gains
  let finalEqLowQ = basePreset.eqLowQ || 0.70;
  const absLowGain = Math.abs(finalEqLowGain);
  if (absLowGain > 2.0) {
    // Narrow the Q slightly for deep boosts/cuts to avoid bloating adjacent low-mids (up to 0.85)
    finalEqLowQ = Math.min(0.85, 0.70 + (absLowGain - 2.0) * 0.05);
  } else if (absLowGain < 1.0) {
    // Widen the Q for transparent minor corrections (down to 0.55)
    finalEqLowQ = Math.max(0.55, 0.70 - (1.0 - absLowGain) * 0.15);
  }
  finalEqLowQ = Math.round(finalEqLowQ * 100) / 100;

  let finalEqHighQ = basePreset.eqHighQ || 0.70;
  const absHighGain = Math.abs(eqHighGain);
  if (absHighGain > 1.2) {
    // Narrow the Q slightly for deep boosts/cuts to protect critical vocal presence frequencies (up to 0.80)
    finalEqHighQ = Math.min(0.80, 0.70 + (absHighGain - 1.2) * 0.05);
  } else if (absHighGain < 0.6) {
    // Widen the Q for broad, airy high-end shine (down to 0.55)
    finalEqHighQ = Math.max(0.55, 0.70 - (0.6 - absHighGain) * 0.25);
  }
  finalEqHighQ = Math.round(finalEqHighQ * 100) / 100;

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
      satLpfFreq: basePreset.satLpfFreq || 4500,
      eqLowGain: finalEqLowGain,
      eqLowFreq: suggestedEqLowFreq,
      eqLowQ: finalEqLowQ,
      eqLowMidGain: eqLowMidGain,
      eqLowMidFreq: suggestedEqLowMidFreq,
      eqLowMidQ: basePreset.eqLowMidQ || 0.60,
      eqMidGain: eqMidGain,
      eqMidFreq: suggestedEqMidFreq,
      eqMidQ: basePreset.eqMidQ || 1.0,
      eqMidHighGain: eqMidHighGain,
      eqMidHighFreq: suggestedEqMidHighFreq,
      eqMidHighQ: basePreset.eqMidHighQ || 1.0,
      eqHighGain: eqHighGain,
      eqHighFreq: suggestedEqHighFreq,
      eqHighQ: finalEqHighQ,
      compEnabled: basePreset.compEnabled,
      compThreshold: compThreshold,
      compRatio: compRatio,
      compAttack: basePreset.compAttack,
      compRelease: basePreset.compRelease,
      stereoWidth: stereoWidth,
      sideHighPassFreq: finalSideHPF,
      clipperDrive: suggestedClipperDrive,
      limiterBoost: finalLimiterBoost,
      rumbleCutEnabled: sugRumbleCut,
      hissReductionAmount: finalHissAmount,
      hissReductionMaxCut: -16.0,
      hissReductionFreq: 9000,
      sibilanceDynamicFreq: sibilanceDynamicFreq,
      deesserAmount: finalDeesserAmount,
      deesserMaxCut: -15.0,
      deesserFreq: sibilanceDynamicFreq > 0 ? Math.min(10000, sibilanceDynamicFreq) : 7500,
      deesserMaxFreq: sibilanceDynamicFreq > 0 ? Math.min(16000, Math.max(9500, sibilanceDynamicFreq + 1500)) : 9500
    },
    // 中間解析値のデバッグ用出力
    crestFactorDb: crestFactorDb,
    actualLowMidRatio: actualLowMidRatio,
    actualHighMidRatio: actualHighMidRatio,
    actualPresenceRatio: actualPresenceRatio,
    avgCorrelation: avgCorrelation
  };
}

// ==========================================================================
// PRESET LOADER
// ==========================================================================
function loadGenrePreset(genreKey) {
  if (genreKey === 'custom') return;
  const p = GENRE_PRESETS[genreKey];
  if (!p) return;

  // 1. Determine source parameters (dynamic AI suggestions optimized for this preset if audio is loaded, else static template)
  let src;
  const isAiAutoActive = (genreKey === 'auto' && aiSuggestedParams !== null);
  if (audioBuffer && genreKey !== 'auto') {
    // 選択されたジャンルプリセットのターゲット特性に合わせてリアルタイム動的AI解析を適用
    const dynamicResult = analyzeAudioResonances(audioBuffer, genreKey);
    src = dynamicResult.suggestedParams;
  } else if (isAiAutoActive) {
    src = aiSuggestedParams;
  } else {
    src = p;
  }

  params.satEnabled = src.satEnabled;
  params.satType = src.satType;
  params.satDrive = src.satDrive;
  params.satMix = src.satMix;
  params.satLpfFreq = src.satLpfFreq || 4500;
  
  params.eqLowGain = src.eqLowGain;
  params.eqLowFreq = src.eqLowFreq;
  params.eqLowQ = src.eqLowQ || 0.70;
  params.eqLowMidGain = src.eqLowMidGain || 0.0;
  params.eqLowMidFreq = src.eqLowMidFreq || 200;
  params.eqLowMidQ = src.eqLowMidQ || 0.60;
  params.eqMidGain = src.eqMidGain;
  params.eqMidFreq = src.eqMidFreq;
  params.eqMidQ = src.eqMidQ || 1.0;
  params.eqMidHighGain = src.eqMidHighGain || 0.0;
  params.eqMidHighFreq = src.eqMidHighFreq || 4800;
  params.eqMidHighQ = src.eqMidHighQ || 1.0;
  params.eqHighGain = src.eqHighGain;
  params.eqHighFreq = src.eqHighFreq;
  params.eqHighQ = src.eqHighQ || 0.70;
  
  params.compEnabled = src.compEnabled;
  params.compThreshold = src.compThreshold;
  params.compRatio = src.compRatio;
  params.compAttack = src.compAttack;
  params.compRelease = src.compRelease;
  
  params.stereoWidth = src.stereoWidth;
  params.sideHighPassFreq = src.sideHighPassFreq || 110;
  params.ceiling = src.ceiling !== undefined ? src.ceiling : -1.0;
  params.clipperDrive = src.clipperDrive !== undefined ? src.clipperDrive : 1.5;
  params.hissReductionMaxFreq = src.hissReductionMaxFreq || 16000;
  params.deesserMaxFreq = src.deesserMaxFreq || 9500;
  
  if (genreKey === 'auto') {
    params.inputGainDb = src.inputGainDb !== undefined ? src.inputGainDb : 0.0;
    params.rumbleCutEnabled = src.rumbleCutEnabled !== undefined ? src.rumbleCutEnabled : false;
    params.hissReductionAmount = src.hissReductionAmount !== undefined ? src.hissReductionAmount : 0;
    params.hissReductionMaxCut = src.hissReductionMaxCut !== undefined ? src.hissReductionMaxCut : -16.0;
    params.hissReductionFreq = src.hissReductionFreq || 9000;
    params.limiterBoost = src.limiterBoost !== undefined ? src.limiterBoost : 3.5;
    params.sibilanceDynamicFreq = src.sibilanceDynamicFreq !== undefined ? src.sibilanceDynamicFreq : 0;
    params.deesserAmount = src.deesserAmount !== undefined ? src.deesserAmount : 0;
    params.deesserMaxCut = src.deesserMaxCut !== undefined ? src.deesserMaxCut : -15.0;
    params.deesserFreq = src.deesserFreq || src.sibilanceDynamicFreq || 7500;
    
    // Set UI badge to show AUTO
    const genreBadge = document.getElementById('ai-detected-genre-badge');
    if (genreBadge) {
      genreBadge.innerText = 'AUTO';
    }
  } else {
    // プリセット変更時は、AIが自動適用した入力ゲインを0.0dB(ニュートラル)に戻して各プリセットの標準音量を担保します
    params.inputGainDb = 0.0;
    
    // 楽曲自体のノイズ状態はプリセット変更で変わらないため、AI検出済みのノイズクリーナー設定があれば継承し、なければOFFにする
    if (aiSuggestedParams !== null) {
      params.rumbleCutEnabled = aiSuggestedParams.rumbleCutEnabled;
      params.hissReductionAmount = aiSuggestedParams.hissReductionAmount;
      params.hissReductionMaxCut = aiSuggestedParams.hissReductionMaxCut !== undefined ? aiSuggestedParams.hissReductionMaxCut : -16.0;
      params.hissReductionFreq = aiSuggestedParams.hissReductionFreq || 9000;
      params.hissReductionMaxFreq = aiSuggestedParams.hissReductionMaxFreq || 16000;
      params.sibilanceDynamicFreq = aiSuggestedParams.sibilanceDynamicFreq || 0;
      params.deesserAmount = aiSuggestedParams.deesserAmount || 0;
      params.deesserMaxCut = aiSuggestedParams.deesserMaxCut !== undefined ? aiSuggestedParams.deesserMaxCut : -15.0;
      params.deesserFreq = aiSuggestedParams.deesserFreq || aiSuggestedParams.sibilanceDynamicFreq || 7500;
      params.deesserMaxFreq = aiSuggestedParams.deesserMaxFreq || 9500;
    } else {
      params.rumbleCutEnabled = false;
      params.hissReductionAmount = 0;
      params.hissReductionMaxCut = -16.0;
      params.hissReductionFreq = 9000;
      params.hissReductionMaxFreq = 16000;
      params.sibilanceDynamicFreq = 0;
      params.deesserAmount = 0;
      params.deesserMaxCut = -15.0;
      params.deesserFreq = 7500;
      params.deesserMaxFreq = 9500;
    }
    
    // Set UI badge back to the selected genre name
    const genreBadge = document.getElementById('ai-detected-genre-badge');
    if (genreBadge) {
      genreBadge.innerText = genreKey.toUpperCase();
    }
  }

  // Set clipper drive and limiter boost based on loudness target selection or preset (applies to both auto and other presets)
  const loudnessSelect = document.getElementById('loudness-select');
  const loudnessKey = loudnessSelect ? loudnessSelect.value : 'genre';
  if (loudnessKey === 'genre') {
    params.limiterBoost = src.limiterBoost; // This is the dynamically calculated boost matching target loudness, capped for classic/acoustic
    params.clipperDrive = src.clipperDrive !== undefined ? src.clipperDrive : (p.clipperDrive !== undefined ? p.clipperDrive : 1.5);
  } else if (LOUDNESS_TARGETS[loudnessKey]) {
    if (LOUDNESS_TARGETS[loudnessKey].boost !== null) {
      params.limiterBoost = LOUDNESS_TARGETS[loudnessKey].boost;
    }
    if (LOUDNESS_TARGETS[loudnessKey].clipper !== null) {
      params.clipperDrive = LOUDNESS_TARGETS[loudnessKey].clipper;
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
  updateClipperNode();
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
    params.clipperDrive = p.clipperDrive !== undefined ? p.clipperDrive : 1.5;
  } else {
    const t = LOUDNESS_TARGETS[targetKey];
    if (!t) return;
    params.limiterBoost = t.boost;
    params.clipperDrive = t.clipper !== null ? t.clipper : 1.5;
  }
  
  // Update GUI
  document.getElementById('limiter-gain').value = params.limiterBoost;
  document.getElementById('limiter-gain-val').innerText = `+${params.limiterBoost.toFixed(1)} dB`;
  const clipperDriveInput = document.getElementById('clipper-drive');
  if (clipperDriveInput) clipperDriveInput.value = params.clipperDrive;
  const clipperDriveVal = document.getElementById('clipper-drive-val');
  if (clipperDriveVal) clipperDriveVal.innerText = `+${params.clipperDrive.toFixed(1)} dB`;
  
  // Update DSP
  updateClipperNode();
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
  const sampleRateSelect = document.getElementById('export-sample-rate');
  const sampleRateSetting = sampleRateSelect ? sampleRateSelect.value : '44100';
  
  let targetSampleRate = audioBuffer.sampleRate;
  if (sampleRateSetting === '44100' || format.includes('44100')) {
    targetSampleRate = 44100;
  } else if (sampleRateSetting === '48000' || format.includes('48000')) {
    targetSampleRate = 48000;
  } else if (sampleRateSetting === 'original') {
    targetSampleRate = audioBuffer.sampleRate;
  }
  
  // Show UI progress
  const exportBtn = document.getElementById('btn-export');
  const progressContainer = document.getElementById('export-progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const progressPercent = document.getElementById('export-percentage');
  
  exportBtn.disabled = true;
  progressContainer.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressPercent.innerText = '0%';

  const numChannels = audioBuffer.numberOfChannels;
  const duration = audioBuffer.duration;
  const totalRenderSamples = Math.ceil(duration * targetSampleRate);
  
  // Create offline context matching target sample rate
  const offlineCtx = new OfflineAudioContext(numChannels, totalRenderSamples, targetSampleRate);
  
  // Create offline buffer source
  const offlineSource = offlineCtx.createBufferSource();
  offlineSource.buffer = audioBuffer;
  
  // Set up the EXACT same signal chain in the offline context
  const offlineChain = setupMasteringChain(offlineCtx, offlineSource, getCombinedParams(), offlineCtx.destination);
  
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
        const bitrate = format.includes('320') ? 320 : 192;
        logToUI(`Encoding to MP3 (${bitrate} kbps, ${renderedBuffer.sampleRate} Hz)...`, "info");
        fileBlob = bufferToMp3(renderedBuffer, bitrate);
        fileExtension = 'mp3';
      }
    } else {
      logToUI(`Encoding to WAV (16-bit PCM, ${renderedBuffer.sampleRate} Hz)...`, "info");
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
  
  document.getElementById('eq-low-gain').value = params.eqLowGain;
  document.getElementById('eq-low-freq').value = params.eqLowFreq;
  document.getElementById('eq-low-val').innerText = `${params.eqLowGain >= 0 ? '+' : ''}${params.eqLowGain.toFixed(1)} dB`;
  const eqLowQInput = document.getElementById('eq-low-q');
  if (eqLowQInput) eqLowQInput.value = params.eqLowQ || 0.70;
  const eqLowQVal = document.getElementById('eq-low-q-val');
  if (eqLowQVal) eqLowQVal.innerText = (params.eqLowQ || 0.70).toFixed(2);
  
  const eqLowMidGainInput = document.getElementById('eq-low-mid-gain');
  if (eqLowMidGainInput) eqLowMidGainInput.value = params.eqLowMidGain || 0.0;
  const eqLowMidFreqInput = document.getElementById('eq-low-mid-freq');
  if (eqLowMidFreqInput) eqLowMidFreqInput.value = params.eqLowMidFreq || 200;
  const eqLowMidVal = document.getElementById('eq-low-mid-val');
  if (eqLowMidVal) eqLowMidVal.innerText = `${params.eqLowMidGain >= 0 ? '+' : ''}${params.eqLowMidGain.toFixed(1)} dB`;
  const eqLowMidQInput = document.getElementById('eq-low-mid-q');
  if (eqLowMidQInput) eqLowMidQInput.value = params.eqLowMidQ || 0.60;
  const eqLowMidQVal = document.getElementById('eq-low-mid-q-val');
  if (eqLowMidQVal) eqLowMidQVal.innerText = (params.eqLowMidQ || 0.60).toFixed(2);
  
  document.getElementById('eq-mid-gain').value = params.eqMidGain;
  document.getElementById('eq-mid-freq').value = params.eqMidFreq;
  document.getElementById('eq-mid-val').innerText = `${params.eqMidGain >= 0 ? '+' : ''}${params.eqMidGain.toFixed(1)} dB`;
  document.getElementById('eq-mid-q').value = params.eqMidQ;
  document.getElementById('eq-mid-q-val').innerText = params.eqMidQ.toFixed(1);
  
  const eqMidHighGainInput = document.getElementById('eq-mid-high-gain');
  if (eqMidHighGainInput) eqMidHighGainInput.value = params.eqMidHighGain || 0.0;
  const eqMidHighFreqInput = document.getElementById('eq-mid-high-freq');
  if (eqMidHighFreqInput) eqMidHighFreqInput.value = params.eqMidHighFreq || 4800;
  const eqMidHighVal = document.getElementById('eq-mid-high-val');
  if (eqMidHighVal) eqMidHighVal.innerText = `${params.eqMidHighGain >= 0 ? '+' : ''}${params.eqMidHighGain.toFixed(1)} dB`;
  const eqMidHighQInput = document.getElementById('eq-mid-high-q');
  if (eqMidHighQInput) eqMidHighQInput.value = params.eqMidHighQ || 1.0;
  const eqMidHighQVal = document.getElementById('eq-mid-high-q-val');
  if (eqMidHighQVal) eqMidHighQVal.innerText = (params.eqMidHighQ || 1.0).toFixed(2);
  
  document.getElementById('eq-high-gain').value = params.eqHighGain;
  document.getElementById('eq-high-freq').value = params.eqHighFreq;
  document.getElementById('eq-high-val').innerText = `${params.eqHighGain >= 0 ? '+' : ''}${params.eqHighGain.toFixed(1)} dB`;
  const eqHighQInput = document.getElementById('eq-high-q');
  if (eqHighQInput) eqHighQInput.value = params.eqHighQ || 0.70;
  const eqHighQVal = document.getElementById('eq-high-q-val');
  if (eqHighQVal) eqHighQVal.innerText = (params.eqHighQ || 0.70).toFixed(2);
  
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
  
  // Clipper & Limiter Gain Boost
  const clipperDriveInput = document.getElementById('clipper-drive');
  if (clipperDriveInput) clipperDriveInput.value = params.clipperDrive !== undefined ? params.clipperDrive : 1.5;
  const clipperDriveVal = document.getElementById('clipper-drive-val');
  if (clipperDriveVal) clipperDriveVal.innerText = `+${(params.clipperDrive !== undefined ? params.clipperDrive : 1.5).toFixed(1)} dB`;

  document.getElementById('limiter-gain').value = params.limiterBoost;
  document.getElementById('limiter-gain-val').innerText = `+${params.limiterBoost.toFixed(1)} dB`;

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
  const hissLimitSliderEl = document.getElementById('hiss-limit-slider');
  if (hissLimitSliderEl) {
    const lVal = params.hissReductionMaxCut !== undefined ? params.hissReductionMaxCut : -16.0;
    hissLimitSliderEl.value = lVal;
    document.getElementById('hiss-limit-val').innerText = `${lVal.toFixed(1)} dB`;
  }
  const hissFreqSliderEl = document.getElementById('hiss-freq-slider');
  const hissMaxFreqSliderEl = document.getElementById('hiss-max-freq-slider');
  let hStart = params.hissReductionFreq || 9000;
  let hEnd = params.hissReductionMaxFreq || 16000;
  if (hEnd <= hStart + 1000) {
    hEnd = Math.min(20000, hStart + 1000);
    params.hissReductionMaxFreq = hEnd;
  }
  params.hissReductionFreq = hStart;
  if (hissFreqSliderEl) {
    hissFreqSliderEl.value = hStart;
    document.getElementById('hiss-freq-val').innerText = `${hStart.toLocaleString()} Hz`;
  }
  if (hissMaxFreqSliderEl) {
    hissMaxFreqSliderEl.value = hEnd;
    document.getElementById('hiss-max-freq-val').innerText = `${hEnd.toLocaleString()} Hz`;
  }
  const deesserSliderEl = document.getElementById('deesser-slider');
  if (deesserSliderEl) {
    deesserSliderEl.value = params.deesserAmount;
  }
  const deesserValEl = document.getElementById('deesser-val');
  if (deesserValEl) {
    deesserValEl.innerText = params.deesserAmount > 0 ? `${params.deesserAmount}%` : 'OFF';
  }
  const deesserLimitSliderEl = document.getElementById('deesser-limit-slider');
  if (deesserLimitSliderEl) {
    const lVal = params.deesserMaxCut !== undefined ? params.deesserMaxCut : -15.0;
    deesserLimitSliderEl.value = lVal;
    document.getElementById('deesser-limit-val').innerText = `${lVal.toFixed(1)} dB`;
  }
  const deesserFreqSliderEl = document.getElementById('deesser-freq-slider');
  const deesserMaxFreqSliderEl = document.getElementById('deesser-max-freq-slider');
  let dStart = params.deesserFreq || params.sibilanceDynamicFreq || 7500;
  let dEnd = params.deesserMaxFreq || 9500;
  if (dEnd <= dStart + 500) {
    dEnd = Math.min(16000, dStart + 500);
    params.deesserMaxFreq = dEnd;
  }
  params.deesserFreq = dStart;
  if (deesserFreqSliderEl) {
    deesserFreqSliderEl.value = dStart;
    document.getElementById('deesser-freq-val').innerText = `${dStart.toLocaleString()} Hz`;
  }
  if (deesserMaxFreqSliderEl) {
    deesserMaxFreqSliderEl.value = dEnd;
    document.getElementById('deesser-max-freq-val').innerText = `${dEnd.toLocaleString()} Hz`;
  }

  // AIレポートカードのアナライザー表示と適用パラメータ一覧をリアルタイムに同期・更新
  if (lastAnalysisResult) {
    updateAiReportCard();
  }
}

// AI SMART ASSISTANCEの解析詳細レポートを動的に再計算・描画する関数
function updateAiReportCard() {
  if (!lastAnalysisResult) return;
  
  const genreSelect = document.getElementById('preset-select');
  const genreKey = genreSelect ? genreSelect.value : 'auto';
  const basePresetKey = (genreKey === 'auto') ? lastAnalysisResult.detectedGenre : genreKey;
  const target = GENRE_TARGETS[basePresetKey] || GENRE_TARGETS.auto;

  // 選択されたプリセットのターゲット周波数特性に合わせて偏差(Deviation)を動的再計算
  const bassDiff = 20 * Math.log10(lastAnalysisResult.actualLowMidRatio / target.low);
  const trebleDiff = 20 * Math.log10(lastAnalysisResult.actualHighMidRatio / target.high);

  // 1. 各音響特性ステータスのテキスト表示更新
  const crestEl = document.getElementById('ai-crest-factor');
  if (crestEl) crestEl.innerText = `${lastAnalysisResult.crestFactor.toFixed(1)} dB`;
  const crestDescEl = document.getElementById('ai-crest-desc');
  if (crestDescEl) crestDescEl.innerText = lastAnalysisResult.crestDesc;
  
  const stereoEl = document.getElementById('ai-stereo-corr');
  if (stereoEl) stereoEl.innerText = `${lastAnalysisResult.correlation >= 0 ? '+' : ''}${lastAnalysisResult.correlation.toFixed(2)}`;
  const stereoDescEl = document.getElementById('ai-stereo-desc');
  if (stereoDescEl) stereoDescEl.innerText = lastAnalysisResult.correlationDesc;
  
  const bassSign = bassDiff >= 0 ? '+' : '';
  const bassEl = document.getElementById('ai-bass-energy');
  if (bassEl) bassEl.innerText = `${bassSign}${bassDiff.toFixed(1)} dB`;
  const bassDescEl = document.getElementById('ai-bass-desc');
  if (bassDescEl) bassDescEl.innerText = bassDiff > 0.8 ? "Heavy Bass" : bassDiff < -0.8 ? "Weak Bass" : "Balanced Bass";
  
  const trebleSign = trebleDiff >= 0 ? '+' : '';
  const trebleEl = document.getElementById('ai-treble-energy');
  if (trebleEl) trebleEl.innerText = `${trebleSign}${trebleDiff.toFixed(1)} dB`;
  const trebleDescEl = document.getElementById('ai-treble-desc');
  if (trebleDescEl) trebleDescEl.innerText = trebleDiff > 0.8 ? "Bright / Sibilant" : trebleDiff < -0.8 ? "Warm / Dull" : "Balanced Highs";

  // 2. 現在エンジンに適用中の実マスタリングパラメータリストを同期表示
  const adjContainer = document.getElementById('ai-adjustments-list');
  if (adjContainer) {
    adjContainer.innerHTML = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
        <span>INPUT GAIN:</span>
        <span style="color: #00f2fe; font-weight: 600;">${params.inputGainDb >= 0 ? '+' : ''}${params.inputGainDb.toFixed(1)} dB</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
        <span>EQ LOW (${params.eqLowFreq} Hz):</span>
        <span style="color: #00f2fe; font-weight: 600;">${params.eqLowGain >= 0 ? '+' : ''}${params.eqLowGain.toFixed(1)} dB</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
        <span>EQ LOW-MID (${params.eqLowMidFreq} Hz):</span>
        <span style="color: #00f2fe; font-weight: 600;">${params.eqLowMidGain >= 0 ? '+' : ''}${params.eqLowMidGain.toFixed(1)} dB</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
        <span>EQ MID (${params.eqMidFreq >= 1000 ? (params.eqMidFreq / 1000).toFixed(2) + 'k' : params.eqMidFreq} Hz):</span>
        <span style="color: #00f2fe; font-weight: 600;">${params.eqMidGain >= 0 ? '+' : ''}${params.eqMidGain.toFixed(1)} dB</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
        <span>EQ MID-HIGH (${(params.eqMidHighFreq / 1000).toFixed(2)}k Hz):</span>
        <span style="color: #00f2fe; font-weight: 600;">${params.eqMidHighGain >= 0 ? '+' : ''}${params.eqMidHighGain.toFixed(1)} dB</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
        <span>EQ HIGH (${(params.eqHighFreq / 1000).toFixed(1)}k Hz):</span>
        <span style="color: #00f2fe; font-weight: 600;">${params.eqHighGain >= 0 ? '+' : ''}${params.eqHighGain.toFixed(1)} dB</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
        <span>COMPRESSOR:</span>
        <span style="color: #00f2fe; font-weight: 600;">Thresh: ${params.compThreshold.toFixed(1)} dB / Ratio: ${params.compRatio.toFixed(1)}:1</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
        <span>STEREO WIDTH:</span>
        <span style="color: #00f2fe; font-weight: 600;">${Math.round(params.stereoWidth * 100)}%</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.03);">
        <span>CLIPPER / LIMITER:</span>
        <span style="color: #00f2fe; font-weight: 600;">Clip: +${(params.clipperDrive !== undefined ? params.clipperDrive : 1.5).toFixed(1)} dB / Boost: +${params.limiterBoost.toFixed(1)} dB</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; padding: 2px 4px;">
        <span>NOISE CLEANER:</span>
        <span style="color: #00f2fe; font-weight: 600;">Rumble: ${params.rumbleCutEnabled ? 'CUT' : 'OFF'} / Hiss: ${params.hissReductionAmount > 0 ? params.hissReductionAmount + '%' : 'OFF'}</span>
      </div>
      <div style="text-align: right; font-size: 0.58rem; color: var(--text-muted); margin-top: -2px; padding: 0 4px 4px 0;">
        (Base: ${lastAnalysisResult.baseLoudnessDesc})
      </div>
    `;
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

  document.getElementById('deesser-slider').addEventListener('input', (e) => {
    params.deesserAmount = parseInt(e.target.value);
    document.getElementById('deesser-val').innerText = params.deesserAmount > 0 ? `${params.deesserAmount}%` : 'OFF';
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

  document.getElementById('hiss-freq-slider').addEventListener('input', (e) => {
    let val = parseInt(e.target.value);
    params.hissReductionFreq = val;
    // 連動制約: Start Freq は End Freq (上限) より常に 1000Hz 以上低く保つ
    if (params.hissReductionMaxFreq <= val + 1000) {
      params.hissReductionMaxFreq = Math.min(20000, val + 1000);
      const maxSlider = document.getElementById('hiss-max-freq-slider');
      if (maxSlider) maxSlider.value = params.hissReductionMaxFreq;
      const maxValEl = document.getElementById('hiss-max-freq-val');
      if (maxValEl) maxValEl.innerText = `${params.hissReductionMaxFreq.toLocaleString()} Hz`;
    }
    document.getElementById('hiss-freq-val').innerText = `${val.toLocaleString()} Hz`;
    selectCustomPreset();
    updateNoiseCutNodes();
  });

  document.getElementById('hiss-max-freq-slider').addEventListener('input', (e) => {
    let val = parseInt(e.target.value);
    params.hissReductionMaxFreq = val;
    // 連動制約: End Freq (上限) は Start Freq より常に 1000Hz 以上高く保つ
    if (params.hissReductionFreq >= val - 1000) {
      params.hissReductionFreq = Math.max(4000, val - 1000);
      const minSlider = document.getElementById('hiss-freq-slider');
      if (minSlider) minSlider.value = params.hissReductionFreq;
      const minValEl = document.getElementById('hiss-freq-val');
      if (minValEl) minValEl.innerText = `${params.hissReductionFreq.toLocaleString()} Hz`;
    }
    document.getElementById('hiss-max-freq-val').innerText = `${val.toLocaleString()} Hz`;
    selectCustomPreset();
    updateNoiseCutNodes();
  });

  document.getElementById('hiss-limit-slider').addEventListener('input', (e) => {
    params.hissReductionMaxCut = parseFloat(e.target.value);
    document.getElementById('hiss-limit-val').innerText = `${params.hissReductionMaxCut.toFixed(1)} dB`;
    selectCustomPreset();
    updateNoiseCutNodes();
  });

  document.getElementById('deesser-freq-slider').addEventListener('input', (e) => {
    let val = parseInt(e.target.value);
    params.deesserFreq = val;
    // 連動制約: Start Freq は End Freq (上限) より常に 500Hz 以上低く保つ
    if (params.deesserMaxFreq <= val + 500) {
      params.deesserMaxFreq = Math.min(16000, val + 500);
      const maxSlider = document.getElementById('deesser-max-freq-slider');
      if (maxSlider) maxSlider.value = params.deesserMaxFreq;
      const maxValEl = document.getElementById('deesser-max-freq-val');
      if (maxValEl) maxValEl.innerText = `${params.deesserMaxFreq.toLocaleString()} Hz`;
    }
    document.getElementById('deesser-freq-val').innerText = `${val.toLocaleString()} Hz`;
    selectCustomPreset();
    updateNoiseCutNodes();
  });

  document.getElementById('deesser-max-freq-slider').addEventListener('input', (e) => {
    let val = parseInt(e.target.value);
    params.deesserMaxFreq = val;
    // 連動制約: End Freq (上限) は Start Freq より常に 500Hz 以上高く保つ
    if (params.deesserFreq >= val - 500) {
      params.deesserFreq = Math.max(4000, val - 500);
      const minSlider = document.getElementById('deesser-freq-slider');
      if (minSlider) minSlider.value = params.deesserFreq;
      const minValEl = document.getElementById('deesser-freq-val');
      if (minValEl) minValEl.innerText = `${params.deesserFreq.toLocaleString()} Hz`;
    }
    document.getElementById('deesser-max-freq-val').innerText = `${val.toLocaleString()} Hz`;
    selectCustomPreset();
    updateNoiseCutNodes();
  });

  document.getElementById('deesser-limit-slider').addEventListener('input', (e) => {
    params.deesserMaxCut = parseFloat(e.target.value);
    document.getElementById('deesser-limit-val').innerText = `${params.deesserMaxCut.toFixed(1)} dB`;
    selectCustomPreset();
    updateNoiseCutNodes();
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

  const eqLowQSlider = document.getElementById('eq-low-q');
  if (eqLowQSlider) {
    eqLowQSlider.addEventListener('input', (e) => {
      params.eqLowQ = parseFloat(e.target.value);
      const eqLowQVal = document.getElementById('eq-low-q-val');
      if (eqLowQVal) eqLowQVal.innerText = params.eqLowQ.toFixed(2);
      selectCustomPreset();
      updateEqNodes();
    });
  }

  // EQ Low-Mid
  const eqLowMidGainSlider = document.getElementById('eq-low-mid-gain');
  if (eqLowMidGainSlider) {
    eqLowMidGainSlider.addEventListener('input', (e) => {
      params.eqLowMidGain = parseFloat(e.target.value);
      const eqLowMidVal = document.getElementById('eq-low-mid-val');
      if (eqLowMidVal) eqLowMidVal.innerText = `${params.eqLowMidGain >= 0 ? '+' : ''}${params.eqLowMidGain.toFixed(1)} dB`;
      selectCustomPreset();
      updateEqNodes();
    });
  }
  const eqLowMidFreqInput = document.getElementById('eq-low-mid-freq');
  if (eqLowMidFreqInput) {
    eqLowMidFreqInput.addEventListener('change', (e) => {
      params.eqLowMidFreq = Math.max(150, Math.min(400, parseInt(e.target.value)));
      e.target.value = params.eqLowMidFreq;
      selectCustomPreset();
      updateEqNodes();
    });
  }
  const eqLowMidQSlider = document.getElementById('eq-low-mid-q');
  if (eqLowMidQSlider) {
    eqLowMidQSlider.addEventListener('input', (e) => {
      params.eqLowMidQ = parseFloat(e.target.value);
      const eqLowMidQVal = document.getElementById('eq-low-mid-q-val');
      if (eqLowMidQVal) eqLowMidQVal.innerText = params.eqLowMidQ.toFixed(2);
      selectCustomPreset();
      updateEqNodes();
    });
  }

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

  // EQ Mid-High
  const eqMidHighGainSlider = document.getElementById('eq-mid-high-gain');
  if (eqMidHighGainSlider) {
    eqMidHighGainSlider.addEventListener('input', (e) => {
      params.eqMidHighGain = parseFloat(e.target.value);
      const eqMidHighVal = document.getElementById('eq-mid-high-val');
      if (eqMidHighVal) eqMidHighVal.innerText = `${params.eqMidHighGain >= 0 ? '+' : ''}${params.eqMidHighGain.toFixed(1)} dB`;
      selectCustomPreset();
      updateEqNodes();
    });
  }
  const eqMidHighFreqInput = document.getElementById('eq-mid-high-freq');
  if (eqMidHighFreqInput) {
    eqMidHighFreqInput.addEventListener('change', (e) => {
      params.eqMidHighFreq = Math.max(2000, Math.min(6000, parseInt(e.target.value)));
      e.target.value = params.eqMidHighFreq;
      selectCustomPreset();
      updateEqNodes();
    });
  }
  const eqMidHighQSlider = document.getElementById('eq-mid-high-q');
  if (eqMidHighQSlider) {
    eqMidHighQSlider.addEventListener('input', (e) => {
      params.eqMidHighQ = parseFloat(e.target.value);
      const eqMidHighQVal = document.getElementById('eq-mid-high-q-val');
      if (eqMidHighQVal) eqMidHighQVal.innerText = params.eqMidHighQ.toFixed(2);
      selectCustomPreset();
      updateEqNodes();
    });
  }

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

  const eqHighQSlider = document.getElementById('eq-high-q');
  if (eqHighQSlider) {
    eqHighQSlider.addEventListener('input', (e) => {
      params.eqHighQ = parseFloat(e.target.value);
      const eqHighQVal = document.getElementById('eq-high-q-val');
      if (eqHighQVal) eqHighQVal.innerText = params.eqHighQ.toFixed(2);
      selectCustomPreset();
      updateEqNodes();
    });
  }

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

  // Clipper Drive
  const clipperDriveSlider = document.getElementById('clipper-drive');
  if (clipperDriveSlider) {
    clipperDriveSlider.addEventListener('input', (e) => {
      params.clipperDrive = parseFloat(e.target.value);
      const valEl = document.getElementById('clipper-drive-val');
      if (valEl) valEl.innerText = `+${params.clipperDrive.toFixed(1)} dB`;
      // Selecting custom target
      document.getElementById('loudness-select').value = 'custom';
      updateClipperNode();
    });
  }

  // Limiter Gain Boost
  document.getElementById('limiter-gain').addEventListener('input', (e) => {
    params.limiterBoost = parseFloat(e.target.value);
    document.getElementById('limiter-gain-val').innerText = `+${params.limiterBoost.toFixed(1)} dB`;
    // Selecting custom target
    document.getElementById('loudness-select').value = 'custom';
    updateLimiterGainNode();
  });

  // Manual Clipping & Distortion Radar Scan Button
  const scanClippingBtn = document.getElementById('btn-scan-clipping');
  if (scanClippingBtn) {
    scanClippingBtn.addEventListener('click', async () => {
      if (!audioBuffer) {
        const logEl = document.getElementById('clipping-log');
        if (logEl) {
          logEl.innerHTML = `<div style="color: #f77f00;">[INFO] 音源ファイルを読み込んでからスキャンを実行してください。</div>`;
        }
        return;
      }
      scanClippingBtn.disabled = true;
      scanClippingBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> SCANNING...`;
      try {
        await runClippingAnalysis();
      } finally {
        scanClippingBtn.disabled = false;
        scanClippingBtn.innerHTML = `<i class="fa-solid fa-magnifying-glass"></i> SCAN NOW (音割れ検査)`;
      }
    });
  }

  // Preset Selections
  document.getElementById('preset-select').addEventListener('change', (e) => {
    loadGenrePreset(e.target.value);
    // ユーザーが手動で特定プリセット（EDM等）を選択した場合、AIの自動最適化で強制的にAUTOに戻されるのを防ぐため、
    // 切り替え先が 'auto' の場合のみ自動解析を走らせます。
    const autoRun = document.getElementById('ai-auto-run').checked;
    if (e.target.value === 'auto' && autoRun && audioBuffer) {
      runAiAnalysis(false);
    }
  });

  document.getElementById('loudness-select').addEventListener('change', (e) => {
    const val = e.target.value;
    if (val !== 'custom') {
      baseLoudnessTarget = val;
    }
    applyLoudnessTarget(val);
    // AI AUTOモード選択中のみ、ラウドネス変更に追従して自動解析を走らせます
    const presetSelect = document.getElementById('preset-select');
    const autoRun = document.getElementById('ai-auto-run').checked;
    if (presetSelect && presetSelect.value === 'auto' && autoRun && audioBuffer) {
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
    updateClipperNode();
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
  lastAnalysisResult = null;

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
  lastAnalysisResult = null;
  
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
  params.deesserAmount = 0;
  
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
  
  logToUI(`[Reset State JSON] ${JSON.stringify({ ...params, correctiveNotches: params.correctiveNotches.filter(n => n.enabled) })}`, "info");
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
  
  setTimeout(async () => {
    try {
      const result = analyzeAudioResonances(audioBuffer);
      lastAnalysisResult = result;
      
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
      
      // AUTOモードかどうかにかかわらず、常に解析された自動パラメータをaiSuggestedParamsに保存
      aiSuggestedParams = JSON.parse(JSON.stringify(sug));
      
      if (isAutoMode) {
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
        loadGenrePreset('auto');
      } else {
        // 個別ジャンルプリセット選択時の動的AI補正
        loadGenrePreset(genreSelect.value);
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
      
      logToUI(`[AI State JSON] ${JSON.stringify({ ...params, correctiveNotches: params.correctiveNotches.filter(n => n.enabled) })}`, "success");
      
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
      
      // レポート表示のフェードインと動的値の反映
      document.getElementById('ai-report').style.display = 'block';
      updateAiReportCard();
      
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
  
  // Copy log button
  const copyLogBtn = document.getElementById('btn-copy-log');
  if (copyLogBtn) {
    copyLogBtn.addEventListener('click', () => {
      const logContainer = document.getElementById('debug-log');
      if (logContainer) {
        const logLines = Array.from(logContainer.querySelectorAll('.log-line'))
          .map(el => el.innerText)
          .join('\n');
          
        navigator.clipboard.writeText(logLines)
          .then(() => {
            const originalText = copyLogBtn.innerHTML;
            copyLogBtn.innerHTML = '<i class="fa-solid fa-check"></i> COPIED!';
            copyLogBtn.style.color = '#00f2fe';
            setTimeout(() => {
              copyLogBtn.innerHTML = originalText;
              copyLogBtn.style.color = '';
            }, 1500);
          })
          .catch(err => {
            console.error('Failed to copy log:', err);
            try {
              const textarea = document.createElement('textarea');
              textarea.value = logLines;
              textarea.style.position = 'fixed';
              textarea.style.opacity = '0';
              document.body.appendChild(textarea);
              textarea.select();
              document.execCommand('copy');
              document.body.removeChild(textarea);
              const originalText = copyLogBtn.innerHTML;
              copyLogBtn.innerHTML = '<i class="fa-solid fa-check"></i> COPIED!';
              copyLogBtn.style.color = '#00f2fe';
              setTimeout(() => {
                copyLogBtn.innerHTML = originalText;
                copyLogBtn.style.color = '';
              }, 1500);
            } catch (fallbackErr) {
              console.error('Fallback copy failed:', fallbackErr);
              alert('ログのコピーに失敗しました。');
            }
          });
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
  // 自動全曲レンダリング（queueClippingScan）は廃止し、CPU使用率をゼロ化（手動ボタン実行に完全移行）
}

function getProcessedPeaks() {
  if (!cachedProcessedPeaks) {
    cachedProcessedPeaks = calculateProcessedPeaks();
  }
  return cachedProcessedPeaks;
}

// ==========================================================================
// BACKGROUND CLIPPING & DISTORTION DETECTOR (音割れ対策スキャナー)
// ==========================================================================
function queueClippingScan() {
  // 手動ボタン実行（#btn-scan-clipping）に移行したため、自動スキャンは実行しない
}

async function runClippingAnalysis() {
  if (!audioBuffer) return;
  
  const statusEl = document.getElementById('clipping-status');
  const logEl = document.getElementById('clipping-log');
  
  if (statusEl) {
    statusEl.innerText = "STATUS: SCANNING...";
    statusEl.style.color = "#00f2fe";
  }
  
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const duration = audioBuffer.duration;
  
  // Create an OfflineAudioContext to render the actual mastered output
  const offlineCtx = new OfflineAudioContext(numChannels, Math.ceil(sampleRate * duration), sampleRate);
  
  // Create offline source node
  const offlineSource = offlineCtx.createBufferSource();
  offlineSource.buffer = audioBuffer;
  
  // Setup the EXACT mastering chain connected directly to the offline context destination
  const offlineChain = setupMasteringChain(offlineCtx, offlineSource, getCombinedParams(), offlineCtx.destination);
  
  // Start rendering
  offlineSource.start(0);
  
  try {
    const renderedBuffer = await offlineCtx.startRendering();
    
    // Analyze peaks in 100ms blocks
    const blockSizeSec = 0.1;
    const blockSizeSamples = Math.floor(sampleRate * blockSizeSec);
    const numBlocks = Math.floor(renderedBuffer.length / blockSizeSamples);
    
    const clippingPoints = [];
    let globalMaxVal = 0.0;
    
    const leftData = renderedBuffer.getChannelData(0);
    const rightData = numChannels > 1 ? renderedBuffer.getChannelData(1) : leftData;
    
    const currentParams = getCombinedParams();
    const ceilingDb = currentParams.ceiling !== undefined ? currentParams.ceiling : -1.0;
    // 0.9995 (~0dBFS) is the threshold where actual true digital clipping occurs
    const trueClipThreshold = 0.9995;
    
    for (let b = 0; b < numBlocks; b++) {
      const startSample = b * blockSizeSamples;
      const endSample = startSample + blockSizeSamples;
      
      let maxVal = 0.0;
      for (let i = startSample; i < endSample; i++) {
        const valL = Math.abs(leftData[i]);
        const valR = Math.abs(rightData[i]);
        if (valL > maxVal) maxVal = valL;
        if (valR > maxVal) maxVal = valR;
      }
      
      if (maxVal > globalMaxVal) {
        globalMaxVal = maxVal;
      }
      
      // Check if actual digital clipping occurs (exceeding 0dBFS)
      if (maxVal >= trueClipThreshold) {
        const peakDb = 20 * Math.log10(maxVal);
        const timeSec = b * blockSizeSec;
        const type = 'HARD DIGITAL CLIPPING (音割れ/0dBFS超過)';
        clippingPoints.push({
          time: timeSec,
          peakDb: peakDb,
          type: type
        });
      }
    }
    
    const globalPeakDb = globalMaxVal > 0 ? (20 * Math.log10(globalMaxVal)) : -99;
    
    // Group consecutive clipping blocks into time ranges to prevent console spam
    const groupedRanges = [];
    if (clippingPoints.length > 0) {
      let currentRange = {
        startTime: clippingPoints[0].time,
        endTime: clippingPoints[0].time,
        maxDb: clippingPoints[0].peakDb,
        type: clippingPoints[0].type
      };
      
      for (let i = 1; i < clippingPoints.length; i++) {
        const pt = clippingPoints[i];
        // Merge if within 0.25 seconds and of the same overload type
        if (pt.time - currentRange.endTime <= 0.25 && pt.type === currentRange.type) {
          currentRange.endTime = pt.time;
          if (pt.peakDb > currentRange.maxDb) {
            currentRange.maxDb = pt.peakDb;
          }
        } else {
          groupedRanges.push(currentRange);
          currentRange = {
            startTime: pt.time,
            endTime: pt.time,
            maxDb: pt.peakDb,
            type: pt.type
          };
        }
      }
      groupedRanges.push(currentRange);
    }
    
    // Display results in the UI log
    if (logEl) {
      logEl.innerHTML = "";
      if (groupedRanges.length === 0) {
        if (statusEl) {
          statusEl.innerText = `STATUS: SECURE (音割れなし / Peak: ${globalPeakDb.toFixed(2)} dBFS)`;
          statusEl.style.color = "#06d6a0";
        }
        const line = document.createElement('div');
        line.style.color = "#06d6a0";
        line.innerText = `[${new Date().toLocaleTimeString()}] [SECURE] 全周波数・全タイムラインの検証完了。クリッパーとリミッターにより全ピークは安全に制御されています（True Peak: ${globalPeakDb.toFixed(2)} dBFS / Ceiling: ${ceilingDb.toFixed(1)} dBFS）。デジタル音割れ（0dBFS超過）はありません。`;
        logEl.appendChild(line);
      } else {
        if (statusEl) {
          statusEl.innerText = `STATUS: WARNING (${groupedRanges.length} points)`;
          statusEl.style.color = "#ff0055";
        }
        
        const summaryLine = document.createElement('div');
        summaryLine.style.color = "#f77f00";
        summaryLine.style.fontWeight = "bold";
        summaryLine.style.marginBottom = "6px";
        summaryLine.innerText = `[${new Date().toLocaleTimeString()}] [WARNING] 検出: ${groupedRanges.length}箇所でデジタルクリッピング（0dBFS超過）の恐れがあります。INPUT GAIN または LIMITER BOOST を下げてください。`;
        logEl.appendChild(summaryLine);
        
        groupedRanges.forEach(range => {
          const line = document.createElement('div');
          const timeDesc = Math.abs(range.startTime - range.endTime) < 0.15
            ? formatClippingTime(range.startTime)
            : `${formatClippingTime(range.startTime)} ~ ${formatClippingTime(range.endTime)}`;
          
          line.style.color = "#ff0055";
          line.innerText = `[${timeDesc}] 🚨 ${range.type} | Max Peak: ${range.maxDb >= 0 ? '+' : ''}${range.maxDb.toFixed(2)} dBFS`;
          logEl.appendChild(line);
        });
      }
      logEl.scrollTop = 0;
    }
  } catch (err) {
    console.error("Clipping analysis error:", err);
    if (statusEl) {
      statusEl.innerText = "STATUS: ERROR";
      statusEl.style.color = "#ff0055";
    }
  }
}

function formatClippingTime(sec) {
  const mins = Math.floor(sec / 60);
  const secs = (sec % 60).toFixed(1);
  return `${mins.toString().padStart(2, '0')}:${secs.padStart(4, '0')}`;
}



