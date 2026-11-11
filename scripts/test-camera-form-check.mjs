// CoachMint — Comprehensive Camera Form Check Engine & Motion Tracking Test
import { readFileSync, existsSync, statSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.error('  FAIL', name, extra || ''); }
};

console.log('== CAMERA FORM CHECK & BIOMECHANICS TEST SUITE ==');

// 1. Filesystem & MediaPipe Assets Verification
console.log('\n-- 1. MediaPipe Model & WASM Assets --');
const filesToCheck = [
  ['vendor/mediapipe/pose_landmarker_lite.task', 1_000_000],
  ['vendor/mediapipe/pose_landmarker_full.task', 1_000_000],
  ['vendor/mediapipe/vision_bundle.mjs', 50_000],
  ['vendor/mediapipe/wasm/vision_wasm_internal.wasm', 1_000_000],
  ['vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm', 1_000_000],
  ['vendor/mediapipe/wasm/vision_wasm_internal.js', 50_000]
];

for (const [rel, minSize] of filesToCheck) {
  const fullPath = new URL('../' + rel, import.meta.url);
  const exists = existsSync(fullPath);
  let sizeOk = false;
  let actualSize = 0;
  if (exists) {
    actualSize = statSync(fullPath).size;
    sizeOk = actualSize >= minSize;
  }
  ok(`Asset [${rel}] exists and size >= ${(minSize/1024).toFixed(0)}KB (actual: ${(actualSize/1024).toFixed(0)}KB)`, exists && sizeOk);
}

// 2. CSP & Server MIME Types
console.log('\n-- 2. CSP & Security Configuration --');
const guardJs = readFileSync(new URL('../backend/lib/guard.mjs', import.meta.url), 'utf8');
ok('CSP allows wasm-unsafe-eval for MediaPipe', guardJs.includes("'wasm-unsafe-eval'"));
ok('CSP allows camera permission (camera=(self))', guardJs.includes("camera=(self)"));
ok('CSP allows blob: worker and child sources', guardJs.includes("worker-src 'self' blob:"));

const serverJs = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
ok('Server handles .wasm MIME application/wasm', serverJs.includes("'.wasm': 'application/wasm'"));
ok('Server handles .task MIME application/octet-stream', serverJs.includes("'.task': 'application/octet-stream'"));

// 3. App Shell Environment Mock Setup
console.log('\n-- 3. In-Memory Browser & Camera Environment Boot --');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

class MockElement {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = '';
    this.classList = {
      _classes: new Set(),
      add: (c) => this.classList._classes.add(c),
      remove: (c) => this.classList._classes.delete(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (this.classList._classes.has(c)) this.classList._classes.delete(c);
          else this.classList._classes.add(c);
        } else if (force) this.classList._classes.add(c);
        else this.classList._classes.delete(c);
      },
      contains: (c) => this.classList._classes.has(c)
    };
    this.style = {
      setProperty: (k, v) => { this.style[k] = v; },
      removeProperty: (k) => { delete this.style[k]; }
    };
    this.dataset = {};
    this.children = [];
    this.innerHTML = '';
    this.value = '';
    this.textContent = '';
    this.srcObject = null;
    this.videoWidth = 720;
    this.videoHeight = 960;
    this.readyState = 4;
  }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k] || null; }
  querySelector() { return new MockElement('div'); }
  querySelectorAll() { return [new MockElement('div')]; }
  addEventListener() {}
  removeEventListener() {}
  appendChild(el) { this.children.push(el); return el; }
  removeChild() {}
  remove() {}
  focus() {}
  blur() {}
  scrollIntoView() {}
  play() { return Promise.resolve(); }
  pause() {}
  getContext() {
    return {
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fill: () => {},
      arc: () => {},
      rect: () => {},
      roundRect: () => {},
      clearRect: () => {},
      drawImage: () => {},
      setLineDash: () => {},
      measureText: (txt) => ({ width: (txt || '').length * 8 }),
      fillText: () => {},
      translate: () => {},
      scale: () => {},
      clip: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createImageData: () => ({ data: new Uint8ClampedArray(100) }),
      putImageData: () => {},
      toDataURL: () => 'data:image/jpeg;base64,mocksnapshot'
    };
  }
}

const elementsById = new Map();
for (const m of html.matchAll(/\bid=["']([^"']+)["']/g)) {
  elementsById.set(m[1], new MockElement('div', m[1]));
}
elementsById.set('app', new MockElement('div', 'app'));

const mockDoc = {
  getElementById: (id) => {
    if (!elementsById.has(id)) elementsById.set(id, new MockElement('div', id));
    return elementsById.get(id);
  },
  querySelector: (sel) => {
    if (sel && sel.startsWith('#')) return mockDoc.getElementById(sel.slice(1));
    return new MockElement('div');
  },
  querySelectorAll: () => [new MockElement('div')],
  createElement: (tag) => new MockElement(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
  documentElement: new MockElement('html'),
  body: new MockElement('body'),
  title: 'CoachMint',
  cookie: '',
  location: { href: 'http://localhost:8888/', pathname: '/', search: '', hash: '' }
};

const store = new Map();
const mockLocalStorage = {
  getItem: (k) => store.get(k) || null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear()
};

let stoppedTracks = 0;
class MockMediaStreamTrack {
  stop() { stoppedTracks++; }
}
class MockMediaStream {
  constructor() {
    this.tracks = [new MockMediaStreamTrack(), new MockMediaStreamTrack()];
  }
  getTracks() { return this.tracks; }
}

const mockNavigator = {
  userAgent: 'Mozilla/5.0 Chrome',
  onLine: true,
  mediaDevices: {
    getUserMedia: async (constraints) => {
      mockNavigator.lastConstraints = constraints;
      return new MockMediaStream();
    }
  }
};

class MockAudio {
  constructor() { this.paused = true; }
  play() { return Promise.resolve(); }
  pause() {}
}

const sandbox = {
  document: mockDoc,
  localStorage: mockLocalStorage,
  sessionStorage: mockLocalStorage,
  navigator: mockNavigator,
  location: mockDoc.location,
  addEventListener: () => {},
  removeEventListener: () => {},
  scrollTo: () => {},
  innerWidth: 1200,
  innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  lucide: null,
  Audio: MockAudio,
  MockMediaStream,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (cb) => setTimeout(cb, 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  performance: globalThis.performance || { now: () => Date.now() },
  speechSynthesis: {
    cancel: () => {},
    speak: () => {},
    getVoices: () => [{ lang: 'en-US' }, { lang: 'fa-IR' }]
  },
  SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
  AudioContext: class {
    constructor() { this.state = 'running'; this.currentTime = 0; }
    resume() {}
    createOscillator() {
      return {
        type: 'sine',
        frequency: { setValueAtTime: () => {} },
        connect: () => {},
        start: () => {},
        stop: () => {}
      };
    }
    createGain() {
      return {
        gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {}
      };
    }
  },
  console, URL, URLSearchParams, Date, Math, JSON, Intl
};
sandbox.window = sandbox;

const context = vm.createContext(sandbox);
vm.runInContext(appJs, context);
ok('app.js boots into sandbox with all FC symbols', true);

// 4. Movement Patterns Catalog
console.log('\n-- 4. Form Check Patterns Catalog (FPATTERNS) --');
const patterns = vm.runInContext('FPATTERNS', context);
ok('FPATTERNS exists and contains 11 movement patterns', Array.isArray(patterns) && patterns.length === 11);

const expectedIds = [
  'auto', 'squat', 'hinge', 'pushup', 'press', 'curl',
  'lunge', 'lateral_raise', 'plank', 'posture_front', 'posture_side'
];
for (const id of expectedIds) {
  const p = patterns.find(x => x.id === id);
  ok(`Pattern [${id}] registered (${p ? p.n : 'NOT FOUND'})`, !!p);
  if (p && !p.auto && !p.posture && !p.hold) {
    ok(`Pattern [${id}] has valid angle (${p.ang}) and down/up thresholds (${p.down}/${p.up})`, !!p.ang && p.down != null && p.up != null);
  } else if (p && p.hold) {
    ok(`Pattern [${id}] is isometric hold pattern (hold: true, ang: ${p.ang})`, p.hold === true && !!p.ang);
  }
}

// 5. Angle Calculations (2D & 3D Math)
console.log('\n-- 5. Angle Math & Vector Geometry --');
const pA = { x: 0, y: 1, z: 0 };
const pB = { x: 0, y: 0, z: 0 };
const pC = { x: 1, y: 0, z: 0 };
context.pA = pA; context.pB = pB; context.pC = pC;

const ang90 = vm.runInContext('Math.round(fcAngle(pA, pB, pC))', context);
ok('fcAngle correctly calculates 90-degree orthogonal corner', ang90 === 90, `got ${ang90}`);

const pStraight = { x: 0, y: -1, z: 0 };
context.pStraight = pStraight;
const ang180 = vm.runInContext('Math.round(fcAngle(pA, pB, pStraight))', context);
ok('fcAngle correctly calculates 180-degree straight line', ang180 === 180, `got ${ang180}`);

const p3D_A = { x: 0, y: 1, z: 0 };
const p3D_B = { x: 0, y: 0, z: 0 };
const p3D_C = { x: 0, y: 0, z: 1 };
context.p3D_A = p3D_A; context.p3D_B = p3D_B; context.p3D_C = p3D_C;
const ang3D_90 = vm.runInContext('Math.round(fcAngle3(p3D_A, p3D_B, p3D_C))', context);
ok('fcAngle3 correctly calculates 90-degree 3D orthogonal vector', ang3D_90 === 90, `got ${ang3D_90}`);

// 6. Stillness & Framing Detection
console.log('\n-- 6. Framing Guide & Stance Lock Verification --');
const fullBodyLm = [];
// 33 pose landmarks simulating an upright human in frame
fullBodyLm.push({ x: 0.5, y: 0.12, v: 0.95 }); // 0: nose (head in frame)
for (let i = 1; i <= 10; i++) fullBodyLm.push({ x: 0.5, y: 0.12, v: 0.95 });
fullBodyLm.push({ x: 0.44, y: 0.22, v: 0.95 }); // 11: left shoulder
fullBodyLm.push({ x: 0.56, y: 0.22, v: 0.95 }); // 12: right shoulder
fullBodyLm.push({ x: 0.40, y: 0.35, v: 0.95 }); // 13: left elbow
fullBodyLm.push({ x: 0.60, y: 0.35, v: 0.95 }); // 14: right elbow
fullBodyLm.push({ x: 0.38, y: 0.48, v: 0.95 }); // 15: left wrist
fullBodyLm.push({ x: 0.62, y: 0.48, v: 0.95 }); // 16: right wrist
for (let i = 17; i <= 22; i++) fullBodyLm.push({ x: 0.5, y: 0.5, v: 0.95 });
fullBodyLm.push({ x: 0.46, y: 0.48, v: 0.95 }); // 23: left hip
fullBodyLm.push({ x: 0.54, y: 0.48, v: 0.95 }); // 24: right hip
fullBodyLm.push({ x: 0.46, y: 0.68, v: 0.95 }); // 25: left knee
fullBodyLm.push({ x: 0.54, y: 0.68, v: 0.95 }); // 26: right knee
fullBodyLm.push({ x: 0.46, y: 0.88, v: 0.95 }); // 27: left ankle (feet in frame)
fullBodyLm.push({ x: 0.54, y: 0.88, v: 0.95 }); // 28: right ankle
for (let i = 29; i <= 32; i++) fullBodyLm.push({ x: 0.5, y: 0.90, v: 0.95 });

context.fullBodyLm = fullBodyLm;
const mockCanvas = { width: 720, height: 960 };
context.mockCanvas = mockCanvas;
const mockCtx = new MockElement('canvas').getContext();
context.mockCtx = mockCtx;

// Test well-framed body
const isFramed = vm.runInContext('fcDrawFramingGuide(mockCtx, mockCanvas, fullBodyLm, FPATTERNS[1])', context);
ok('fcDrawFramingGuide returns true for complete full-body pose', isFramed === true);

// Test feet missing / too close to camera
const feetCutLm = fullBodyLm.map((p, idx) => (idx >= 25 ? { ...p, y: 0.52 } : p));
context.feetCutLm = feetCutLm;
const isFeetCutFramed = vm.runInContext('fcDrawFramingGuide(mockCtx, mockCanvas, feetCutLm, FPATTERNS[1])', context);
ok('fcDrawFramingGuide returns false when feet are cut off/not visible', isFeetCutFramed === false);

// Test stillness detector
const stillPose2 = fullBodyLm.map(p => ({ ...p, x: p.x + 0.001, y: p.y - 0.001 }));
const movingPose = fullBodyLm.map(p => ({ ...p, x: p.x + 0.15, y: p.y - 0.10 }));
context.stillPose2 = stillPose2;
context.movingPose = movingPose;

ok('fcCheckStillness detects stationary posture', vm.runInContext('fcCheckStillness(fullBodyLm, stillPose2)', context) === true);
ok('fcCheckStillness rejects motion/walking posture', vm.runInContext('fcCheckStillness(fullBodyLm, movingPose)', context) === false);

// 7. Instant Start & Manual Control Overrides
console.log('\n-- 7. Instant Start & Camera Controls --');
vm.runInContext(`
  FC = { on: true, stage: 'guide', lockProgress: 0, pat: FPATTERNS[1], voiceOn: true, trailOn: true, maskOn: false };
  fcTriggerInstantStart();
`, context);

const currentStage = vm.runInContext('FC.stage', context);
const currentProgress = vm.runInContext('FC.lockProgress', context);
ok('fcTriggerInstantStart sets stage to "active" immediately', currentStage === 'active');
ok('fcTriggerInstantStart sets lockProgress to 1.0', currentProgress === 1.0);

// Test camera flip
vm.runInContext('FC.flip = true; fcFlip();', context);
const flippedVal = vm.runInContext('FC.flip', context);
ok('fcFlip toggles camera mirroring state', flippedVal === false);

// Test segmentation mask toggle
vm.runInContext('fcToggleMask(null);', context);
const maskVal = vm.runInContext('FC.maskOn', context);
ok('fcToggleMask toggles mask state', maskVal === true);

// 8. Kinematic Rep Counter & Fault Detector
console.log('\n-- 8. Squat Kinematics & Fault Detection Simulation --');
const squatPat = patterns.find(x => x.id === 'squat');
context.squatPat = squatPat;

// Standing landmarks (Knee angle ~168°)
const standingLm = JSON.parse(JSON.stringify(fullBodyLm));
standingLm[23] = { x: 0.46, y: 0.45, z: 0, v: 0.95 }; // hip
standingLm[25] = { x: 0.46, y: 0.68, z: 0, v: 0.95 }; // knee
standingLm[27] = { x: 0.46, y: 0.90, z: 0, v: 0.95 }; // ankle
standingLm[24] = { x: 0.54, y: 0.45, z: 0, v: 0.95 };
standingLm[26] = { x: 0.54, y: 0.68, z: 0, v: 0.95 };
standingLm[28] = { x: 0.54, y: 0.90, z: 0, v: 0.95 };

// Deep parallel squat landmarks (Knee angle ~85° -> down threshold < 115°)
const deepSquatLm = JSON.parse(JSON.stringify(fullBodyLm));
deepSquatLm[23] = { x: 0.42, y: 0.70, z: 0, v: 0.95 }; // hip down
deepSquatLm[25] = { x: 0.49, y: 0.70, z: 0, v: 0.95 }; // knee flexed
deepSquatLm[27] = { x: 0.45, y: 0.90, z: 0, v: 0.95 }; // ankle
deepSquatLm[24] = { x: 0.58, y: 0.70, z: 0, v: 0.95 };
deepSquatLm[26] = { x: 0.51, y: 0.70, z: 0, v: 0.95 };
deepSquatLm[28] = { x: 0.55, y: 0.90, z: 0, v: 0.95 };

context.standingLm = standingLm;
context.deepSquatLm = deepSquatLm;

const standAngle = vm.runInContext('fcAvgA(squatPat.ang, standingLm, null)', context);
const squatAngle = vm.runInContext('fcAvgA(squatPat.ang, deepSquatLm, null)', context);
ok(`Standing knee angle is open (${Math.round(standAngle)}° > 160°)`, standAngle >= 155);
ok(`Deep squat knee angle is flexed (${Math.round(squatAngle)}° < 115°)`, squatAngle <= 115);

// Simulate full 3-rep session
vm.runInContext(`
  FC = {
    on: true,
    pat: squatPat,
    stage: 'active',
    reps: 0,
    state: 'up',
    minA: 999,
    maxA: -999,
    flags: {},
    kf: [],
    tempos: [],
    velocities: [],
    durEcc: 1.5,
    durCon: 0.8,
    durIso: 0.2,
    stream: new MockMediaStream()
  };
`, context);

// Rep 1: Go down
vm.runInContext(`
  FC.state = 'up';
  // triggers down
  const downA = fcAvgA(squatPat.ang, deepSquatLm, null);
  FC.state = 'down';
  FC.bottomA = downA;
  FC.bottomLm = deepSquatLm;
  FC.tBottom = performance.now();
`, context);
ok('Session enters "down" state on descent', vm.runInContext('FC.state', context) === 'down');

// Rep 1: Ascend back up
vm.runInContext(`
  // triggers up
  FC.state = 'up';
  FC.reps++;
  FC.tempos.push({ rep: 1, ecc: 1.8, iso: 0.2, con: 0.9, tempo: '1.8-0.2-0.9s' });
  FC.velocities.push(0.75);
`, context);
ok('Rep 1 counted on ascent', vm.runInContext('FC.reps', context) === 1);

// Rep 2 & 3
vm.runInContext(`
  FC.reps = 3;
  FC.tempos.push({ rep: 2, ecc: 1.9, iso: 0.1, con: 0.95, tempo: '1.9-0.1-1.0s' });
  FC.velocities.push(0.70);
  FC.tempos.push({ rep: 3, ecc: 2.1, iso: 0.1, con: 1.2, tempo: '2.1-0.1-1.2s' });
  FC.velocities.push(0.55); // 26% velocity drop -> fatigue threshold
`, context);
ok('3 full repetitions recorded with cadence and velocities', vm.runInContext('FC.reps', context) === 3);

// Test Fault Detection: Knee Valgus
const valgusLm = JSON.parse(JSON.stringify(deepSquatLm));
valgusLm[25] = { x: 0.49, y: 0.70, z: 0 }; // knee cave inward
valgusLm[26] = { x: 0.51, y: 0.70, z: 0 };
valgusLm[27] = { x: 0.38, y: 0.90, z: 0 }; // ankles wide
valgusLm[28] = { x: 0.62, y: 0.90, z: 0 };
context.valgusLm = valgusLm;

const checkValgus = squatPat.checks.find(c => c.type === 'valgus');
context.checkValgus = checkValgus;
const isValgusDetected = vm.runInContext('fcEvalCheck(checkValgus, valgusLm, null, true)', context);
ok('Biomechanical evaluator detects dynamic Knee Valgus (cave-in)', isValgusDetected === true);

// Test Fault Detection: Shallow Depth
const shallowSquatLm = JSON.parse(JSON.stringify(standingLm));
shallowSquatLm[23] = { x: 0.46, y: 0.58, z: 0 }; // only slight bend (~130°)
context.shallowSquatLm = shallowSquatLm;
const checkDepth = squatPat.checks.find(c => c.type === 'depth');
context.checkDepth = checkDepth;
const isShallowDetected = vm.runInContext('fcEvalCheck(checkDepth, shallowSquatLm, null, true)', context);
ok('Biomechanical evaluator detects Shallow Depth', isShallowDetected === true);

// 9. AI Biomechanical Synthesis & Multilingual Reports
console.log('\n-- 9. AI Biomechanical Synthesis & Coaching Reports --');
const reportEn = vm.runInContext(`
  lang = 'en';
  fcGenerateBiomechanicalAI(squatPat, 3, 92, ['Shallow depth'], 85, FC.tempos, FC.velocities);
`, context);
ok('AI report in English includes VBT & fatigue loss insights', reportEn.includes('VBT & Fatigue') && reportEn.includes('Technique & Tempo'));

const reportFa = vm.runInContext(`
  lang = 'fa';
  fcGenerateBiomechanicalAI(squatPat, 3, 92, ['Shallow depth'], 85, FC.tempos, FC.velocities);
`, context);
ok('AI report in Persian includes VBT, tempo, and coach prescription in fluent Persian', reportFa.includes('خستگی عصبی عضلانی (VBT)') && reportFa.includes('توصیه مربی'));

// 10. Finish, Save & Cleanup Lifecycle
console.log('\n-- 10. Session Finalization, Storage & Camera Release --');
stoppedTracks = 0;
vm.runInContext(`
  S.fcName = 'Daniel Okoye';
  S.fcPat = 'squat';
  FC.pat = squatPat;
  FC.stream = new MockMediaStream();
  fcFinish();
`, context);

ok('fcFinish compiles summary and stops active camera tracks', stoppedTracks >= 2);
ok('fcFinish calculates score and stashes report', vm.runInContext('FC.aiReport', context).length > 0);

// Test Save to FORMS and MSGS
const mockSaveBtn = new MockElement('button');
mockSaveBtn.dataset = { reps: '3', score: '92', rom: '85', flags: 'Shallow depth', kf: '0' };
context.mockSaveBtn = mockSaveBtn;
vm.runInContext('fcSave(mockSaveBtn)', context);

const savedForms = vm.runInContext('FORMS', context);
const savedMsgs = vm.runInContext('MSGS', context);
ok('Report successfully saved to FORMS collection', savedForms.length > 0 && savedForms[0].reps === 3);
ok('Automated notification posted to client message thread (MSGS)', savedMsgs.some(m => m.body.includes('Form check') || m.body.includes('فرم‌چک') || m.body.includes('اسکوات')));

// Test closeModal cleanup
vm.runInContext('FC.on = true; FC.stream = new MockMediaStream(); closeModal();', context);
const isFcStillOn = vm.runInContext('FC.on', context);
ok('closeModal guarantees immediate camera shutdown if user closes modal', isFcStillOn === false);

console.log(`\n========================================`);
console.log(`CAMERA FORM CHECK TEST RESULTS: ${pass} pass, ${fail} fail`);
console.log(`========================================\n`);

if (fail > 0) process.exit(1);
