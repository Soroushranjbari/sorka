// CoachMint — Executive Console B2B Verification Test
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.error('  FAIL', name, extra || ''); }
};

console.log('== B2B EXECUTIVE CONSOLE TEST SUITE ==');

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
vm.runInContext(appJs, context);

// 1. Setup simulated Gym Owner State
vm.runInContext(`
  S.org = {
    id: 'org_test_100',
    name: 'Olympex Fitness Clubs',
    plan: 'gym_chain',
    quotas: { branches: 5, staff: 25, athletes: 500 },
    branches: [
      { id: 'br_hq', name: 'Central Tower HQ', isHQ: true },
      { id: 'br_west', name: 'West Arena', isHQ: false }
    ],
    staff: [
      { coachId: 'c_owner', name: 'Chief Director', role: 'gym_owner', email: 'director@olympex.com', branches: ['*'] },
      { coachId: 'c_trainer1', name: 'Babak Trainer', role: 'trainer', email: 'babak@olympex.com', branches: ['br_hq'] }
    ]
  };
  S.isGymOwner = true;
  S.orgRole = 'gym_owner';
  S.workspaceMode = 'executive';
  S.view = 'org';
  S.orgTab = 'overview';
`, context);

// 2. Render Shell in Executive Mode
let out = vm.runInContext(`shell(currentView())`, context);
ok('Executive Console brand header renders', out.includes('EXECUTIVE CONSOLE') && out.includes('Olympex Fitness Clubs'));
ok('Workspace mode switcher renders with Executive active', out.includes('data-act="set-ws-mode"') && out.includes('btn-primary'));
ok('Executive Navigation rail includes Command Center, Staff, Branches', out.includes('data-view="org-overview"') && out.includes('data-view="org-staff"') && out.includes('data-view="org-branches"'));
ok('Executive Navigation rail includes Master Roster & Anti-Poaching', out.includes('data-view="clients"') && out.includes('data-view="org-reassign"'));
const hasQuotas = out.includes('<b>2</b>/<span class="muted">5</span>') && out.includes('<b>2</b>/<span class="muted">25</span>');
ok('Topbar Quotas badge renders active counts and quotas', hasQuotas);

// 3. Persian Locale Render Check
vm.runInContext(`lang = 'fa'; applyLang();`, context);
let faOut = vm.runInContext(`shell(currentView())`, context);
ok('Persian translation for Executive Console renders', faOut.includes('کنسول مدیریت سازمان') || faOut.includes('مدیریت ارشد'));
ok('Persian translation for Command Center renders', faOut.includes('کنسول فرماندهی باشگاه') || faOut.includes('فرماندهی سازمانی'));

// 4. Switch to Personal Coach Desk Mode
vm.runInContext(`
  S.workspaceMode = 'coach';
  S.view = 'dash';
`, context);
let coachOut = vm.runInContext(`shell(currentView())`, context);
ok('Coach Desk mode renders standard COACHMINT brand mark', coachOut.includes('ONE COACH. ONE WORKSPACE.'));
ok('Coach Desk mode renders standard Coach navigation', coachOut.includes('data-view="dash"') && coachOut.includes('data-view="builder"'));

// 5. Direct view routing via currentView()
vm.runInContext(`S.view = 'org-staff';`, context);
let staffView = vm.runInContext(`currentView()`, context);
ok('org-staff view routes directly to Staff & Trainers tab', staffView.includes('Staff & Trainers') || staffView.includes('کادر فنی'));

vm.runInContext(`S.view = 'org-reassign';`, context);
let reassignView = vm.runInContext(`currentView()`, context);
ok('org-reassign view routes directly to Anti-Poaching Transfer tab', reassignView.includes('Anti-Poaching') || reassignView.includes('انتقال هوشمند شاگرد'));

console.log(`\nEXECUTIVE_CONSOLE: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
