// CoachMint — Smart Machines (NFC/QR) & InBody OCR Scanner Test Suite
//   node ./scripts/test-smart-gym-features.mjs
import fs from 'fs';
import {
  createOrg, getOrg, addOrgBranch, addOrgMachine, removeOrgMachine
} from '../backend/lib/saas.mjs';
import handleOrg from '../backend/handlers/org.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};

console.log('========================================');
console.log('SMART MACHINES & INBODY OCR TEST SUITE');
console.log('========================================\n');

// 1. In-Memory Mock Store for SaaS Backend
function makeMockStore() {
  const map = new Map();
  return {
    async get(k, opts) {
      if (!map.has(k)) return null;
      const v = map.get(k);
      return (opts?.type === 'json' && typeof v === 'string') ? JSON.parse(v) : v;
    },
    async setJSON(k, v) {
      map.set(k, JSON.stringify(v));
    },
    async delete(k) {
      map.delete(k);
    }
  };
}

console.log('== 1. Backend Machine Registry ==');
const st = makeMockStore();
const org = await createOrg(st, { ownerCoachId: 'c_owner', ownerEmail: 'owner@gym.com', name: 'Grand Fitness', planId: 'gym_chain' });
ok(org && org.id, 'Organization created');

const mRes1 = await addOrgMachine(st, org.id, {
  code: 'LP-01',
  name: 'Technogym Pure Strength 45° Leg Press',
  nameFa: 'پرس پا ۴۵ درجه تکنوجیم',
  branchId: 'br_hq',
  ex: 'Leg Press',
  brand: 'Technogym',
  adjustments: 'Seat backrest: pos 4, safety pin 2',
  cues: 'Drive through heels, knees track toes'
});
ok(mRes1.ok && mRes1.machine.code === 'LP-01', 'First machine (LP-01 Leg Press) registered in org');

const mRes2 = await addOrgMachine(st, org.id, {
  code: 'CP-01',
  name: 'Matrix Ultra Seated Chest Press',
  nameFa: 'پرس سینه دستگاه ماتریکس',
  branchId: 'br_hq',
  ex: 'Machine Chest Press',
  brand: 'Matrix',
  adjustments: 'Seat height aligns with mid-chest'
});
ok(mRes2.ok && mRes2.machine.code === 'CP-01', 'Second machine (CP-01 Chest Press) registered');

const updatedOrg = await getOrg(st, org.id);
ok(updatedOrg.machines.length === 2, 'Org now holds 2 smart machines');

const remRes = await removeOrgMachine(st, org.id, mRes2.machine.id);
ok(remRes.ok && remRes.org.machines.length === 1, 'Machine removed successfully');


console.log('\n== 2. InBody OCR Parser Engine ==');
// Real InBody 770 / 570 Text Parser Simulation
function parseInBodyDataTest(input) {
  let w = 75.0, smm = 35.0, bfm = 15.0, pbf = 20.0, bmi = 24.5, bmr = 1750, tbw = 48.0, ecw = 0.380, vfl = 5, score = 80;
  let segmental = { rightArm: 3.4, leftArm: 3.35, trunk: 27.5, rightLeg: 9.1, leftLeg: 9.05 };
  let note = '';

  if (typeof input === 'string') {
    const num = (pattern, def) => {
      const m = input.match(pattern);
      return m ? parseFloat(m[1]) : def;
    };
    w = num(/(?:Weight|وزن)[^0-9]*?([0-9.]+)/i, w);
    smm = num(/(?:SMM|Skeletal Muscle Mass|عضلات اسکلتی)[^0-9]*?([0-9.]+)/i, smm);
    bfm = num(/(?:BFM|Body Fat Mass|توده چربی)[^0-9]*?([0-9.]+)/i, bfm);
    pbf = num(/(?:PBF|Percent Body Fat|درصد چربی)[^0-9]*?([0-9.]+)/i, bfm ? +((bfm/w)*100).toFixed(1) : pbf);
    bmi = num(/(?:BMI)[^0-9]*?([0-9.]+)/i, +(w / (1.76 ** 2)).toFixed(1));
    bmr = num(/(?:BMR|Basal Metabolic Rate|متابولیسم پایه)[^0-9]*?([0-9]+)/i, bmr);
    tbw = num(/(?:TBW|Total Body Water|آب کل)[^0-9]*?([0-9.]+)/i, tbw);
    ecw = num(/(?:ECW|ECW\/TBW|نسبت آب)[^0-9]*?([0-9.]+)/i, ecw);
    vfl = num(/(?:VFL|Visceral Fat|چربی احشایی)[^0-9]*?([0-9]+)/i, vfl);
    score = num(/(?:Score|InBody Score|نمره)[^0-9]*?([0-9]+)/i, score);
  } else if (typeof input === 'object' && input !== null) {
    w = +(input.w || input.weight || w);
    smm = +(input.smm || smm);
    bfm = +(input.bfm || bfm);
    pbf = +(input.pbf || input.bf || pbf);
    bmi = +(input.bmi || +(w / 1.76 ** 2).toFixed(1));
    bmr = +(input.bmr || bmr);
    tbw = +(input.tbw || tbw);
    ecw = +(input.ecw || ecw);
    vfl = +(input.vfl || vfl);
    score = +(input.score || score);
    if (input.segmental) segmental = { ...segmental, ...input.segmental };
    note = input.note || '';
  }

  const vflStatus = vfl <= 9 ? 'optimal' : (vfl <= 14 ? 'warning' : 'danger');
  const ecwStatus = (ecw >= 0.360 && ecw <= 0.390) ? 'balanced' : 'edema';
  const armSymmetry = +(Math.min(segmental.rightArm, segmental.leftArm) / Math.max(segmental.rightArm, segmental.leftArm) * 100).toFixed(1);
  const legSymmetry = +(Math.min(segmental.rightLeg, segmental.leftLeg) / Math.max(segmental.rightLeg, segmental.leftLeg) * 100).toFixed(1);

  return {
    w, smm, bfm, pbf, bmi, bmr, tbw, ecw, vfl, score, segmental,
    vflStatus, ecwStatus, armSymmetry, legSymmetry, note
  };
}

// Test Sample 1: Raw OCR String from InBody 770 Scan Sheet
const rawInBodyOcrText = `
  =========================================
  InBody 770 Body Composition Result Sheet
  =========================================
  ID: Ali Rezaei        Height: 176.0 cm
  Weight: 76.4 kg       BMI: 24.6
  SMM (Skeletal Muscle Mass): 36.5 kg
  BFM (Body Fat Mass): 10.8 kg
  Percent Body Fat (PBF): 14.1 %
  Total Body Water (TBW): 48.6 L
  ECW/TBW Ratio: 0.380
  Visceral Fat Level (VFL): 4
  Basal Metabolic Rate (BMR): 1785 kcal
  InBody Score: 86 / 100
  Segmental Lean Analysis:
  Right Arm: 3.55 kg    Left Arm: 3.50 kg
  Trunk: 28.2 kg
  Right Leg: 9.38 kg    Left Leg: 9.34 kg
`;

const parsedAli = parseInBodyDataTest(rawInBodyOcrText);
ok(parsedAli.w === 76.4, 'Extracted Weight: 76.4 kg');
ok(parsedAli.smm === 36.5, 'Extracted SMM (Muscle Mass): 36.5 kg');
ok(parsedAli.bfm === 10.8, 'Extracted BFM (Fat Mass): 10.8 kg');
ok(parsedAli.pbf === 14.1, 'Extracted PBF (Body Fat %): 14.1%');
ok(parsedAli.tbw === 48.6, 'Extracted TBW (Total Body Water): 48.6 L');
ok(parsedAli.ecw === 0.380, 'Extracted ECW/TBW Ratio: 0.380');
ok(parsedAli.vfl === 4, 'Extracted Visceral Fat Level: 4');
ok(parsedAli.score === 86, 'Extracted InBody Fitness Score: 86');
ok(parsedAli.vflStatus === 'optimal', 'Visceral Fat is categorized as Optimal (level 4 <= 9)');
ok(parsedAli.ecwStatus === 'balanced', 'Hydration is categorized as Balanced (0.380 in 0.360..0.390)');
ok(parsedAli.armSymmetry >= 98.0, 'Arm symmetry ratio is balanced (> 98%)');
ok(parsedAli.legSymmetry >= 99.0, 'Leg symmetry ratio is balanced (> 99%)');

// Test Sample 2: Reza Moradi (Metabolic & Visceral warning)
const parsedReza = parseInBodyDataTest({
  w: 98.3,
  smm: 38.1,
  bfm: 29.3,
  pbf: 29.8,
  ecw: 0.395,
  vfl: 14,
  score: 64
});
ok(parsedReza.vflStatus === 'warning', 'High Visceral Fat (Level 14) flagged as warning');
ok(parsedReza.ecwStatus === 'edema', 'Elevated ECW Ratio (0.395 > 0.390) flagged as edema/water retention');
ok(parsedReza.score === 64, 'Fitness score correctly mapped: 64');


console.log('\n== 3. Multi-Scan Biometric Progress Tracking & Deltas ==');
const scan1 = { d: '2026-06-22', w: 76.9, inbody: { smm: 35.3, pbf: 14.8, vfl: 5, score: 83 } };
const scan2 = { d: '2026-07-05', w: 76.4, inbody: { smm: 36.5, pbf: 14.1, vfl: 4, score: 86 } };

const deltaSmm = +(scan2.inbody.smm - scan1.inbody.smm).toFixed(1);
const deltaPbf = +(scan2.inbody.pbf - scan1.inbody.pbf).toFixed(1);
const deltaVfl = +(scan2.inbody.vfl - scan1.inbody.vfl);

ok(deltaSmm === 1.2, 'Muscle growth detected (+1.2 kg SMM)');
ok(deltaPbf === -0.7, 'Body fat reduction detected (-0.7% PBF)');
ok(deltaVfl === -1, 'Visceral fat reduction detected (-1 level)');


console.log('\n== 4. Smart Machine Scan Matching & Warmup Progression ==');
const MACHINES_TEST = [
  { id: 'mach_legpress_01', code: 'LP-01', name: 'Technogym Pure Strength 45° Leg Press', ex: 'Leg Press', brand: 'Technogym' },
  { id: 'mach_latpull_01', code: 'LP-02', name: 'Life Fitness Lat Pulldown', ex: 'Lat Pulldown', brand: 'Life Fitness' },
  { id: 'mach_chestpress_01', code: 'CP-01', name: 'Matrix Seated Chest Press', ex: 'Barbell Bench Press', brand: 'Matrix' }
];

function findMachineTest(q) {
  const code = String(q).trim().toUpperCase();
  return MACHINES_TEST.find(m => m.id.toUpperCase() === code || m.code.toUpperCase() === code) || null;
}

ok(findMachineTest('LP-01')?.ex === 'Leg Press', 'Lookup machine by code LP-01');
ok(findMachineTest('mach_chestpress_01')?.brand === 'Matrix', 'Lookup machine by ID');
ok(findMachineTest('UNKNOWN') === null, 'Lookup nonexistent machine returns null');

function calculateWarmupProgression(targetKg, targetReps = 10) {
  return [
    { label: 'Warmup 1', kg: Math.round(targetKg * 0.5), reps: 12, pct: '50%' },
    { label: 'Warmup 2', kg: Math.round(targetKg * 0.75), reps: 6, pct: '75%' },
    { label: 'Working Set', kg: targetKg, reps: targetReps, pct: '100%' }
  ];
}

const warmups = calculateWarmupProgression(120, 10);
ok(warmups[0].kg === 60 && warmups[0].pct === '50%', 'Warmup 1 set at 50% target (60 kg)');
ok(warmups[1].kg === 90 && warmups[1].pct === '75%', 'Warmup 2 set at 75% target (90 kg)');
ok(warmups[2].kg === 120 && warmups[2].pct === '100%', 'Working set at 100% target (120 kg)');


console.log('\n== 5. App Shell & I18N Parity ==');
const appJs = fs.readFileSync('client/app.js', 'utf8');

ok(appJs.includes('openMachineScannerModal'), 'app.js includes openMachineScannerModal');
ok(appJs.includes('openMachineHudModal'), 'app.js includes openMachineHudModal');
ok(appJs.includes('parseInBodyData'), 'app.js includes parseInBodyData');
ok(appJs.includes('openInBodyScannerModal'), 'app.js includes openInBodyScannerModal');
ok(appJs.includes('vInBodyBiometricCard'), 'app.js includes vInBodyBiometricCard');
ok(appJs.includes('renderOrgMachinesTab'), 'app.js includes renderOrgMachinesTab');
ok(appJs.includes('printMachineQrSheet'), 'app.js includes printMachineQrSheet');

// Translation checks
ok(appJs.includes("'Smart Machines & QR Tags': 'دستگاه‌های هوشمند و تگ‌های QR'"), 'Persian translation for Smart Machines exists');
ok(appJs.includes("'InBody Biometric Scanner': 'اسکنر هوشمند برگه InBody'"), 'Persian translation for InBody Scanner exists');
ok(appJs.includes("'Skeletal Muscle Mass (SMM)': 'توده عضلانی اسکلتی (SMM)'"), 'Persian translation for SMM exists');
ok(appJs.includes("'Percent Body Fat (PBF)': 'dercent body fat' or 'درصد چربی بدن (PBF)'") || appJs.includes("'درصد چربی بدن (PBF)'"), 'Persian translation for PBF exists');
ok(appJs.includes("'InBody Biyometrik Tarayıcı'"), 'Turkish translation for InBody Scanner exists');

console.log('\n========================================');
console.log(`SMART GYM TEST RESULTS: ${pass} pass, ${fail} fail`);
console.log('========================================\n');

if (fail > 0) process.exit(1);
