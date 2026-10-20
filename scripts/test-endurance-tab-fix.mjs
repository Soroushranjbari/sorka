import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code = readFileSync('app.js', 'utf8');

class MockAudio {
  play() {}
  pause() {}
}

const window = {
  location: { href: 'http://localhost:8888/', pathname: '/', search: '', hash: '' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  scrollTo: () => {},
  navigator: { userAgent: 'test' }
};

let clickHandler = null;
const document = {
  documentElement: { lang: 'en', setAttribute: () => {}, style: { setProperty: () => {} }, dataset: {} },
  createElement: () => ({ appendChild: () => {}, classList: { add: () => {} }, remove: () => {} }),
  getElementById: () => ({ value: '', checked: false, addEventListener: () => {}, focus: () => {}, appendChild: () => {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (evt, handler) => {
    if (evt === 'click') clickHandler = handler;
  },
  body: { classList: { add: () => {}, remove: () => {} } }
};

const ctx = vm.createContext({
  window,
  document,
  location: window.location,
  navigator: window.navigator,
  Audio: MockAudio,
  URLSearchParams,
  URL,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp
});

vm.runInContext(code, ctx);
const evalIn = (expr) => vm.runInContext(expr, ctx);

let pass = 0, fail = 0;
function test(name, ok) {
  if (ok) {
    console.log(`  PASS ${name}`);
    pass++;
  } else {
    console.error(`  FAIL ${name}`);
    fail++;
  }
}

console.log('=== TEST SUITE: ENDURANCE HUB TAB FIX ===');

// 1. Client 6 (Amir Jafari - runner)
evalIn("S.cid = 6; S.view = 'wspace'; S.tab = 'overview';");
let ws6Overview = evalIn("vWorkspace()");
test('Client 6 has Endurance Hub tab in overview', ws6Overview.includes('data-tab="endurance"'));
test('Client 6 overview tab is on', ws6Overview.includes('class="tab on" data-act="tab" data-tab="overview"'));

// Now click Endurance Hub tab on Client 6
evalIn("S.tab = 'endurance';");
let ws6Endurance = evalIn("vWorkspace()");
test('Client 6 Endurance Hub tab stays present when active (NO DISAPPEAR)', ws6Endurance.includes('data-tab="endurance"'));
test('Client 6 Endurance Hub tab has on class', ws6Endurance.includes('class="tab on" data-act="tab" data-tab="endurance"'));
test('Client 6 renders Shoe Tracker in Endurance Hub', ws6Endurance.includes('Shoe Tracker'));
test('Client 6 renders Training Pace Zones', ws6Endurance.includes('Training Pace Zones'));

// 2. Client 1 (Ali Rezaei - default non-runner)
evalIn("S.cid = 1; S.view = 'wspace'; S.tab = 'overview';");
let ws1Overview = evalIn("vWorkspace()");
test('Client 1 has Endurance Hub tab available', ws1Overview.includes('data-tab="endurance"'));

// Click Endurance Hub tab on Client 1
evalIn("S.tab = 'endurance';");
let ws1Endurance = evalIn("vWorkspace()");
test('Client 1 Endurance Hub tab stays present when active (NO DISAPPEAR)', ws1Endurance.includes('data-tab="endurance"'));
test('Client 1 Endurance Hub tab has on class', ws1Endurance.includes('class="tab on" data-act="tab" data-tab="endurance"'));
test('Client 1 shows banner with Set as Runner action', ws1Endurance.includes('data-act="cl-set-runner"'));

// 3. Test cl-set-runner action
const mockEl = {
  getAttribute: (a) => a === 'data-act' ? 'cl-set-runner' : null,
  hasAttribute: (a) => a === 'data-act',
  dataset: { act: 'cl-set-runner', cid: '1' },
  closest: (sel) => sel === '[data-act]' ? mockEl : null
};
clickHandler({ target: mockEl });
let c1After = evalIn("client(1)");
test('Client 1 sport updated to Running & Endurance', c1After.sport === 'Running & Endurance');
test('Client 1 isClientRunner is now true', evalIn("isClientRunner(client(1))"));

// 4. Test currentView mapping for top-level endurance view
evalIn("S.view = 'endurance';");
let cvEndurance = evalIn("currentView()");
test('currentView endurance navigates to wspace', evalIn("S.view") === 'wspace');
test('currentView endurance sets S.tab to endurance', evalIn("S.tab") === 'endurance');
test('currentView endurance returns workspace HTML', cvEndurance.includes('data-tab="endurance"'));

// 5. Test Persian translations for Endurance Hub and tab labels
evalIn("lang = 'fa';");
evalIn("S.cid = 6; S.view = 'wspace'; S.tab = 'endurance';");
let wsFa = evalIn("vWorkspace()");
test('Persian translation for Endurance Hub tab', wsFa.includes('مرکز استقامت و دویدن'));
test('Persian Endurance Hub tab is on and not vanished', wsFa.includes('class="tab on" data-act="tab" data-tab="endurance"'));

console.log(`\nRESULTS: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
