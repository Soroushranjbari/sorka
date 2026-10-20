import { readFileSync } from 'node:fs';

const code = readFileSync('app.js', 'utf8');

const checks = [
  ['clientSport helper', code.includes('const clientSport =')],
  ['isClientRunner helper', code.includes('const isClientRunner =')],
  ['vClientEnduranceHub component', code.includes('function vClientEnduranceHub(')],
  ['shoeEditor component', code.includes('function shoeEditor(')],
  ['cl-sport-set action', code.includes("case 'cl-sport-set':")],
  ['shoe-save action', code.includes("case 'shoe-save':")],
  ['shoe-retire action', code.includes("case 'shoe-retire':")],
  ['shoe-del action', code.includes("case 'shoe-del':")],
  ['race-new-for action', code.includes("case 'race-new-for':")],
  ['Endurance Hub in SPORT_EXT', code.includes("label:'Endurance Hub'")],
  ['vWorkspace endurance tab gating', code.includes("isClientRunner(c)?[['endurance','Endurance Hub']]")],
  ['editClientModal sport select', code.includes('id="ec-sport"')],
  ['addClientModal sport select', code.includes('id="nc-sport"')],
  ['save-client sport persistence', code.includes("sport:ncV('nc-sport')")],
  ['ec-save sport persistence', code.includes("c.sport = $('ec-sport').value")],
  ['athToday runner gating', code.includes('if(!isClientRunner(c))return \'\';')]
];

let pass = 0, fail = 0;
for (const [name, ok] of checks) {
  if (ok) {
    console.log(`  PASS ${name}`);
    pass++;
  } else {
    console.error(`  FAIL ${name}`);
    fail++;
  }
}

console.log(`\nENDURANCE_HUB: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
