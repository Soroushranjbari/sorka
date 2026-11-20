import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const ARTIFACT_DIR = 'C:/Users/Home/.gemini/antigravity/brain/d338dab8-28f6-44a8-a057-e9b697af7142';
const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TEMP_USER_DATA = path.join(process.cwd(), '.tmp_edge_profile');

// Ensure tmp dir exists
if (!fs.existsSync(TEMP_USER_DATA)) fs.mkdirSync(TEMP_USER_DATA, { recursive: true });

async function run() {
  console.log('Launching headless Edge for CDP capture...');
  const edgeProc = spawn(EDGE_PATH, [
    '--headless=new',
    '--remote-debugging-port=9222',
    `--user-data-dir=${TEMP_USER_DATA}`,
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], { stdio: 'ignore' });

  // Wait for remote debugging endpoint to be ready
  let version = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const res = await fetch('http://127.0.0.1:9222/json/version');
      if (res.ok) {
        version = await res.json();
        break;
      }
    } catch (e) {}
  }

  if (!version || !version.webSocketDebuggerUrl) {
    console.error('Could not connect to Edge DevTools');
    edgeProc.kill();
    process.exit(1);
  }

  console.log('Connected to DevTools:', version.webSocketDebuggerUrl);
  // Get existing page or create new target
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  const pages = await listRes.json();
  const targetPage = pages.find(p => p.type === 'page') || pages[0];
  const pageWsUrl = targetPage.webSocketDebuggerUrl;

  const ws = new WebSocket(pageWsUrl);
  let id = 1;
  const pending = new Map();

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(data.error);
      else resolve(data.result);
    }
  };

  await new Promise(r => ws.onopen = r);
  console.log('CDP WebSocket opened');

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 860,
    deviceScaleFactor: 2,
    mobile: false
  });

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res?.exceptionDetails) {
      console.error('JS Exception:', res.exceptionDetails);
    }
    return res?.result?.value;
  }

  async function snap(filename) {
    // Settle delay for animations & font rendering
    await new Promise(r => setTimeout(r, 1000));
    const result = await send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(result.data, 'base64');
    const outPath = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(outPath, buf);
    console.log(`Saved screenshot: ${outPath} (${Math.round(buf.length / 1024)} KB)`);
  }

  // 1. Navigate to base app
  console.log('Navigating to app on http://localhost:8888/#org-login ...');
  await send('Page.navigate', { url: 'http://localhost:8888/#org-login' });
  await new Promise(r => setTimeout(r, 3500));

  // --- FA Organization Login Portal ---
  console.log('Rendering Persian Organization Login...');
  await evaluate(`
    lang = 'fa';
    S.loginPortal = 'org';
    S.authMode = 'login';
    S.role = null;
    applyLang();
    render();
  `);
  await snap('org-login-portal-fa.png');
  // Copy to org-login-portal.png as well for primary view
  fs.copyFileSync(path.join(ARTIFACT_DIR, 'org-login-portal-fa.png'), path.join(ARTIFACT_DIR, 'org-login-portal.png'));

  // --- EN Organization Login Portal ---
  console.log('Rendering English Organization Login...');
  await evaluate(`
    lang = 'en';
    S.loginPortal = 'org';
    S.authMode = 'login';
    S.role = null;
    applyLang();
    render();
  `);
  await snap('org-login-portal-en.png');

  // --- FA Executive Console (Overview) ---
  console.log('Rendering Persian Executive Overview...');
  await evaluate(`
    lang = 'fa';
    applyLang();
    AUTH.token = '';
    AUTH.coach = null;
    S.role = 'coach';
    S.org = getDemoOrg('fa');
    S.orgRole = 'gym_owner';
    S.isGymOwner = true;
    S.workspaceMode = 'executive';
    S.view = 'org';
    S.orgTab = 'overview';
    render();
  `);
  await snap('gym-executive-overview-fa.png');
  fs.copyFileSync(path.join(ARTIFACT_DIR, 'gym-executive-overview-fa.png'), path.join(ARTIFACT_DIR, 'gym-executive-overview.png'));

  // --- EN Executive Console (Overview) ---
  console.log('Rendering English Executive Overview...');
  await evaluate(`
    lang = 'en';
    applyLang();
    S.org = getDemoOrg('en');
    S.orgTab = 'overview';
    render();
  `);
  await snap('gym-executive-overview-en.png');

  // --- FA Executive Console (Staff) ---
  console.log('Rendering Persian Executive Staff...');
  await evaluate(`
    lang = 'fa';
    applyLang();
    S.org = getDemoOrg('fa');
    S.orgTab = 'staff';
    render();
  `);
  await snap('gym-executive-staff-fa.png');
  fs.copyFileSync(path.join(ARTIFACT_DIR, 'gym-executive-staff-fa.png'), path.join(ARTIFACT_DIR, 'gym-executive-staff.png'));

  // --- EN Executive Console (Staff) ---
  console.log('Rendering English Executive Staff...');
  await evaluate(`
    lang = 'en';
    applyLang();
    S.org = getDemoOrg('en');
    S.orgTab = 'staff';
    render();
  `);
  await snap('gym-executive-staff-en.png');

  // --- FA Executive Console (Machines) ---
  console.log('Rendering Persian Executive Machines...');
  await evaluate(`
    lang = 'fa';
    applyLang();
    S.org = getDemoOrg('fa');
    S.orgTab = 'machines';
    render();
  `);
  await snap('gym-executive-machines-fa.png');
  fs.copyFileSync(path.join(ARTIFACT_DIR, 'gym-executive-machines-fa.png'), path.join(ARTIFACT_DIR, 'gym-executive-machines.png'));

  // --- EN Executive Console (Machines) ---
  console.log('Rendering English Executive Machines...');
  await evaluate(`
    lang = 'en';
    applyLang();
    S.org = getDemoOrg('en');
    S.orgTab = 'machines';
    render();
  `);
  await snap('gym-executive-machines-en.png');

  ws.close();
  edgeProc.kill();
  console.log('All unmixed screenshots successfully captured!');
}

run().catch(err => {
  console.error('Capture error:', err);
  process.exit(1);
});
