import { readFileSync } from 'node:fs';
import vm from 'node:vm';

console.log('== COMPREHENSIVE SHOP ENGINE VALIDATION ==');

const html = readFileSync(new URL('../shop/index.html', import.meta.url), 'utf8');

// 1. Check patterns
const singleDollarForEach = /(?<!\$)\$\(([^)]+)\)\.forEach/g;
let m;
let patternErrors = 0;
while ((m = singleDollarForEach.exec(html)) !== null) {
  console.error('ERROR: Found single $(...).forEach:', m[0]);
  patternErrors++;
}
if (patternErrors === 0) {
  console.log('PASS: No single $(...).forEach patterns found in HTML.');
}

// 2. Mock DOM and execute
class MockElement {
  constructor(tag, id = '', classes = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = classes;
    const set = new Set(classes ? classes.split(' ') : []);
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        if (force !== undefined) {
          if (force) set.add(c); else set.delete(c);
          return force;
        }
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      }
    };
    this.style = {
      setProperty: (k, v) => { this.style[k] = String(v); },
      getPropertyValue: (k) => this.style[k] || ''
    };
    this.attributes = {};
    this.children = [];
    this.parentNode = { removeChild: () => {} };
    this.offsetWidth = 1200;
    this.offsetHeight = 1800;
    this.clientWidth = 1200;
    this.clientHeight = 1800;
    this.scrollWidth = 2400;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  querySelector(s) { return new MockElement('div'); }
  querySelectorAll(s) { return [new MockElement('div'), new MockElement('div')]; }
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 1200, height: 1800, bottom: 1800, right: 1200 };
  }
  addEventListener() {}
  removeEventListener() {}
  getTotalLength() { return 100; }
}

const mockDoc = {
  documentElement: new MockElement('html'),
  body: new MockElement('body'),
  querySelector: (sel) => new MockElement('div'),
  querySelectorAll: (sel) => [new MockElement('div'), new MockElement('div')],
  getElementById: (id) => new MockElement('div', id),
  fonts: { ready: Promise.resolve(), check: () => true }
};

let rafCallbacks = [];
const mockWindow = {
  document: mockDoc,
  history: { scrollRestoration: 'auto' },
  performance: { now: () => Date.now() },
  requestAnimationFrame: (cb) => { rafCallbacks.push(cb); return rafCallbacks.length; },
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false }),
  innerWidth: 1200,
  innerHeight: 800,
  scrollY: 0,
  scrollTo: () => {},
  devicePixelRatio: 1,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  CanvasRenderingContext2D: function() {}
};
mockWindow.window = mockWindow;

const ctx = vm.createContext({
  ...mockWindow,
  console: console,
  document: mockDoc,
  window: mockWindow,
  CanvasRenderingContext2D: mockWindow.CanvasRenderingContext2D,
  innerWidth: 1200,
  innerHeight: 800,
  performance: mockWindow.performance,
  requestAnimationFrame: mockWindow.requestAnimationFrame,
  addEventListener: mockWindow.addEventListener,
  matchMedia: mockWindow.matchMedia,
  scrollTo: mockWindow.scrollTo,
  history: mockWindow.history
});

const scriptMatches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

// Run Script 1
vm.runInContext(scriptMatches[1][2], ctx);
console.log('PASS: Script 1 ran cleanly.');

// Run Script 3
vm.runInContext(scriptMatches[3][2], ctx);
console.log('PASS: Script 3 ran cleanly.');

if (ctx.window.__COACHOS_OK === true) {
  console.log('PASS: window.__COACHOS_OK === true');
} else {
  console.error('FAIL: window.__COACHOS_OK is', ctx.window.__COACHOS_OK);
}

if (rafCallbacks.length > 0) {
  console.log('PASS: requestAnimationFrame queued:', rafCallbacks.length);
} else {
  console.error('FAIL: No requestAnimationFrame callback queued!');
}

// Simulate scroll frames across different positions
const scrollSteps = [0, 500, 1200, 2500, 5000, 8000, 12000];
let frameSuccess = true;
scrollSteps.forEach(scrollY => {
  ctx.scrollY = scrollY;
  ctx.window.scrollY = scrollY;
  const cb = rafCallbacks[rafCallbacks.length - 1];
  try {
    cb(Date.now());
  } catch (err) {
    console.error(`FAIL at scrollY=${scrollY}:`, err);
    frameSuccess = false;
  }
});

if (frameSuccess) {
  console.log('PASS: frame() and updateScenes() simulated successfully at all scroll positions (0px -> 12000px).');
}
