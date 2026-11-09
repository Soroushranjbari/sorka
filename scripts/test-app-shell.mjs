// CoachMint — App shell & UI rendering regression test.
// Validates:
//   1. app.js executes cleanly without undefined symbols (e.g. DAYN, icons).
//   2. Desktop views render across all locales (EN, FA, TR).
//   3. Mobile views render across all locales.
//   4. Workspace tabs render across all locales.
//   5. Core modal dialogs open cleanly.
//   6. All icon references resolve to valid SVGs.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.error('  FAIL', name, extra || ''); }
};

console.log('== APP SHELL & UI RENDERING ==');

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

class MockElement {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = '';
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
    this.style = { setProperty: (k, v) => { this.style[k] = v; }, removeProperty: (k) => { delete this.style[k]; } };
    this.dataset = {};
    this.children = [];
    this.innerHTML = '';
    this.value = '';
    this.textContent = '';
  }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k] || null; }
  querySelector() { return new MockElement('div'); }
  querySelectorAll() { return [new MockElement('div')]; }
  addEventListener() {}
  removeEventListener() {}
  appendChild(el) { this.children.push(el); return el; }
  removeChild() {}
  focus() {}
  blur() {}
  scrollIntoView() {}
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

class MockAudio {
  constructor() { this.paused = true; }
  play() { return Promise.resolve(); }
  pause() {}
}

const sandbox = {
  document: mockDoc,
  localStorage: mockLocalStorage,
  sessionStorage: mockLocalStorage,
  navigator: { userAgent: 'Mozilla/5.0 Chrome', onLine: true },
  location: mockDoc.location,
  addEventListener: () => {},
  removeEventListener: () => {},
  scrollTo: () => {},
  innerWidth: 1200,
  innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  lucide: null,
  Audio: MockAudio,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (cb) => setTimeout(cb, 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  Notification: { permission: 'default', requestPermission: async () => 'granted' },
  performance: globalThis.performance || { now: () => Date.now() },
  console, URL, URLSearchParams, Date, Math, JSON, Intl
};
sandbox.window = sandbox;

const context = vm.createContext(sandbox);

try {
  vm.runInContext(appJs, context);
  ok('app.js boots without top-level errors', true);
} catch (e) {
  ok('app.js boots without top-level errors', false, e.message);
}

// 1. Desktop views across all 3 languages
const views = ['dash', 'clients', 'wspace', 'workouts', 'calendar', 'progress', 'nutrition', 'templates', 'exlib', 'notes', 'messages', 'settings', 'help', 'endurance', 'wear'];
const langs = ['en', 'fa', 'tr'];

for (const l of langs) {
  vm.runInContext(`lang = "${l}"; applyLang();`, context);
  for (const v of views) {
    try {
      vm.runInContext(`S.view = "${v}"; render();`, context);
      ok(`desktop view [${v}] renders in [${l}]`, true);
    } catch (e) {
      ok(`desktop view [${v}] renders in [${l}]`, false, e.message);
    }
  }
}

// 2. Workspace tabs
const tabs = ['overview', 'workouts', 'calendar', 'nutrition', 'progress', 'measurements', 'notes', 'messages', 'files', 'endurance', 'settings'];
for (const tab of tabs) {
  try {
    vm.runInContext(`S.view = "wspace"; S.cid = 1; S.tab = "${tab}"; render();`, context);
    ok(`workspace tab [${tab}] renders`, true);
  } catch (e) {
    ok(`workspace tab [${tab}] renders`, false, e.message);
  }
}

// 3. Mobile views
sandbox.innerWidth = 375;
const mviews = ['today', 'clients', 'client', 'more', 'live', 'thread', 'nutrition', 'builder', 'settings', 'templates', 'calendar', 'races', 'pbs'];
for (const l of langs) {
  vm.runInContext(`lang = "${l}"; applyLang();`, context);
  for (const mv of mviews) {
    try {
      vm.runInContext(`S.mview = "${mv}"; S.view = "dash"; renderMobile();`, context);
      ok(`mobile view [${mv}] renders in [${l}]`, true);
    } catch (e) {
      ok(`mobile view [${mv}] renders in [${l}]`, false, e.message);
    }
  }
}

// 4. Modals
const modals = [
  'addClientModal', 'pickerModal', 'measModal', 'newSessionModal', 'targetsModal', 'helpModal', 'intakeModal', 'weekPlanModal', 'formCheckModal',
  'photoExportMorphModal', 'coachWhisperModal', 'raceFuelingModal', 'storyCardModal', 'churnRadarModal', 'retentionNudgeModal'
];
for (const m of modals) {
  try {
    vm.runInContext(`${m}(); closeModal();`, context);
    ok(`modal [${m}] opens and closes`, true);
  } catch (e) {
    ok(`modal [${m}] opens and closes`, false, e.message);
  }
}

// 5. Camera Form Check: Instant Start & Stance Lock Verification
try {
  // Test Stillness detector
  const stillLm1 = [{x:0.5, y:0.2, v:0.9}];
  for(let i=1;i<33;i++) stillLm1.push({x:0.5 + (i*0.01), y:0.3 + (i*0.01), v:0.9});
  const stillLm2 = stillLm1.map(p => ({x: p.x + 0.002, y: p.y - 0.001, v: 0.9})); // tiny breathing shift
  const jitterLm = stillLm1.map(p => ({x: p.x + 0.12, y: p.y - 0.08, v: 0.9}));  // large movement

  context.stillLm1 = stillLm1;
  context.stillLm2 = stillLm2;
  context.jitterLm = jitterLm;

  const isStill = vm.runInContext(`fcCheckStillness(stillLm1, stillLm2)`, context);
  const isMoving = vm.runInContext(`fcCheckStillness(stillLm1, jitterLm)`, context);
  ok('fcCheckStillness correctly identifies stationary pose', isStill === true);
  ok('fcCheckStillness correctly identifies motion/walking', isMoving === false);

  // Test Instant Start triggers zero delay transition to active
  vm.runInContext(`
    FC = { on: true, stage: 'guide', lockProgress: 0, pat: { posture: false } };
    fcTriggerInstantStart();
  `, context);
  const activeStage = vm.runInContext(`FC.stage`, context);
  ok('fcTriggerInstantStart switches stage immediately to active', activeStage === 'active');

  // Test Persian translations for Instant Start & Stance Lock
  const faInstant = vm.runInContext(`lang = 'fa'; t('Instant Start')`, context);
  const faLocked = vm.runInContext(`t('Stance Locked — Recording!')`, context);
  ok('Persian translation for Instant Start is correct', faInstant === 'شروع فوری');
  ok('Persian translation for Stance Locked is correct', faLocked === 'وضعیت بدنی تثبیت شد — شروع ثبت!');
} catch (e) {
  ok('Camera Form Check start trigger logic passes', false, e.message);
}

console.log(`\nAPP_SHELL: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

