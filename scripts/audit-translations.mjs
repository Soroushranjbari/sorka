import fs from 'fs';
import vm from 'vm';

const content = fs.readFileSync('client/app.js', 'utf8');
const lines = content.split('\n');

const checkSections = [
  { name: 'Org Views', text: lines.slice(2980, 3900).join('\n') },
  { name: 'Login Views', text: lines.slice(5550, 5700).join('\n') },
  { name: 'Shell / Nav', text: lines.slice(15700, 15900).join('\n') },
  { name: 'Machines Tab', text: lines.slice(16700, 16850).join('\n') }
];

const sandbox = {
  window: {},
  localStorage: { getItem: () => 'fa' },
  P: {},
  lucideSvg: () => '',
  LUCIDE_ALIAS: {}
};
vm.createContext(sandbox);

const dictCode = lines.slice(80, 1228).join('\n');
const { FA, TR } = vm.runInContext(dictCode + '\n;({ FA, TR });', sandbox);

const regex = /t\(\s*['"]([^'"]+)['"]\s*\)/g;

let totalMissingFA = 0;
let totalMissingTR = 0;

for (const sec of checkSections) {
  console.log(`\n=== Section: ${sec.name} ===`);
  const tCalls = new Set();
  let m;
  while ((m = regex.exec(sec.text)) !== null) {
    tCalls.add(m[1]);
  }
  for (const k of tCalls) {
    if (!FA[k]) {
      console.log(`[FA MISSING] "${k}"`);
      totalMissingFA++;
    }
    if (!TR[k]) {
      console.log(`[TR MISSING] "${k}"`);
      totalMissingTR++;
    }
  }
}
console.log(`\nResults: FA missing: ${totalMissingFA}, TR missing: ${totalMissingTR}`);
