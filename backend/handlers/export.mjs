// CoachMint — Printable plan export (v18.38).
//
//   GET /api/export/pdf?code=WS&client=<id|name>&kind=week|workout|nutrition&wid=<id>&lang=fa|en
//
// Renders a print-ready A4 page (CoachMint-branded) with the client's week
// plan, nutrition summary and a QR code that opens the app on the client's
// phone. The browser's "Save as PDF" turns it into a PDF — window.print() +
// @media print, no PDF library needed (the page auto-opens the print dialog).
//
// Trust model = /api/data GET: the workspace code IS the credential (students
// sync by code alone), so the export works from any device that knows the
// code — including a coach printing from a tablet at the gym desk.
import { store, j, normCode, CODE_RE, legacyBlobs } from '../lib/saas.mjs';
import { rateLimit, ipOf, tooMany, secure } from '../lib/guard.mjs';
import { qrSvg } from '../lib/qr.mjs';
import { EX_EN, FA_PRINT } from '../lib/fa-print.mjs';

/* ---------- i18n ---------- */
const faDigits = '۰۱۲۳۴۵۶۷۸۹';
const nf = (v, lang) => {
  const s = String(v ?? '');
  return lang === 'fa' ? s.replace(/\d/g, (d) => faDigits[+d]) : s;
};
const tr = (s, lang) => (lang === 'fa' ? (FA_PRINT[s] || s) : String(s ?? ''));
/* '4x / week' has no single dict key — the unit part is translated inline. */
const freqLbl = (f, lang) => {
  const s = String(f || '');
  return lang === 'fa' ? s.replace('x / week', '× در هفته').replace('—', '—') : s;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- workspace resolution (same chain as /api/data) ---------- */
async function loadWorkspace(st, code) {
  try {
    const ptr = await st.get(`ws-by-code:${code}`, { type: 'json' });
    if (ptr && ptr.wid) {
      const ws = await st.get(`ws:${ptr.wid}`, { type: 'json' });
      if (ws) {
        const meta = await st.get(`ws-meta:${ws.id}`, { type: 'json' });
        if (meta && meta.data) return meta.data;
      }
    }
  } catch {}
  try {
    const leg = await legacyBlobs().get(code, { type: 'json' });
    if (leg && leg.data) return leg.data;
  } catch {}
  return null;
}

/* ---------- data shaping ---------- */
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const dayIdx = (d) => { const i = DAY_ORDER.indexOf(d); return i < 0 ? 99 : i; };
/* Workout rows store the exercise as an INDEX into the client-side EXERCISES
   array; custom exercises are appended after it (payload CEXS). */
const exName = (i, cexs) => {
  const n = EX_EN[i];
  if (n) return n;
  const c = (cexs || [])[i - EX_EN.length];
  return (c && c.n) || 'Exercise';
};
const foodName = (f, lang) => {
  if (!f) return '';
  const n = f.n || '';
  return lang === 'fa' ? (FA_PRINT[n] || n) : n;
};
const mealKcal = (m, foods) => (m.foods || []).reduce((a, x) => {
  const f = foods[x.fi]; if (!f) return a;
  return a + Math.round((f.kcal || 0) * (x.g || 0) / 100);
}, 0);

function workoutBlock(w, data, lang) {
  const rows = (w.exercises || []).map((b, i) => {
    const name = tr(exName(b.ex, data.CEXS), lang);
    return `<tr><td>${nf(i + 1, lang)}</td><td>${esc(name)}${b.note ? `<div class="exnote">${esc(tr(b.note, lang))}</div>` : ''}</td><td>${nf(b.sets, lang)} × ${esc(String(b.reps ?? ''))}</td><td>${b.kg ? nf(b.kg, lang) + ' kg' : '—'}</td><td>${nf(b.rest, lang)} s</td></tr>`;
  }).join('');
  const sets = (w.exercises || []).reduce((a, b) => a + (b.sets || 0), 0);
  return `<div class="wk"><span class="day">${esc(tr(w.day || '', lang))}</span><b>${esc(w.name || '')}</b><span class="meta">${esc(String(w.dur || ''))} · ${nf(sets, lang)} ${tr('sets', lang)} · ${nf((w.exercises || []).length, lang)} ${tr('exercises', lang)}</span></div>
  <table><thead><tr><th style="width:26px">#</th><th>${esc(tr('Exercise', lang))}</th><th style="width:90px">${esc(tr('Sets × Reps', lang))}</th><th style="width:80px">${esc(tr('Load', lang))}</th><th style="width:70px">${esc(tr('Rest', lang))}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function nutritionBlock(p, data, lang, full) {
  const foods = data.FOODS || [];
  const head = `<div class="chips">
    <span class="chip">${esc(tr('Training Day', lang))}: ${nf(p.train && p.train.kcal, lang)} kcal</span>
    <span class="chip">${esc(tr('Rest Day', lang))}: ${nf(p.rest && p.rest.kcal, lang)} kcal</span></div>`;
  const days = (p.days || []).map((d, i) => {
    const tg = d.type === 'train' ? p.train : p.rest;
    const rows = (d.meals || []).map(m => `<tr><td style="width:110px">${esc(tr(m.time, lang))}</td><td>${esc(tr(m.name, lang))}</td><td>${(m.foods || []).map(x => {
      const f = foods[x.fi]; return f ? esc(foodName(f, lang)) + ' ' + nf(x.g, lang) + 'g' : '';
    }).filter(Boolean).join(', ') || '—'}</td><td style="width:80px">${nf(Math.round(mealKcal(m, foods)), lang)}</td></tr>`).join('');
    return `<div class="wk"><span class="day ${d.type === 'train' ? '' : 'rest'}">${esc(tr(DAY_ORDER[i] || '', lang))}</span><b>${esc(tr(d.type === 'train' ? 'Training Day' : 'Rest Day', lang))}</b><span class="meta">${nf(tg && tg.kcal, lang)} kcal</span></div>
    <table><thead><tr><th>${esc(tr('Meal', lang))}</th><th></th><th>${esc(tr('Foods', lang))}</th><th>${esc(tr('Calories', lang))}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
  return head + (full ? days : '');
}

/* ---------- page ---------- */
function page(o) {
  const { lang, title, clientName, metaChips, body, qrLink, qrCode, coach, dateLbl } = o;
  const dir = lang === 'fa' ? 'rtl' : 'ltr';
  return `<!DOCTYPE html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--lime:#C8F04B;--deep:#8FB51E;--ink:#12151B;--mut:#6B7280;--line:#E7E9DD}
*{box-sizing:border-box}
body{font-family:Vazirmatn,'Segoe UI',Tahoma,'Iranian Sans',sans-serif;color:var(--ink);margin:0;background:#F1F2EC;font-size:13px}
.sheet{max-width:820px;margin:22px auto;background:#fff;padding:38px 44px 30px;box-shadow:0 2px 16px rgba(18,21,27,.09);border-radius:6px}
.brand{display:flex;align-items:center;gap:11px;border-bottom:3px solid var(--lime);padding-bottom:14px}
.brand .mark{width:36px;height:30px;color:var(--deep);flex:none}
.brand .wm{font-weight:800;font-size:19px;letter-spacing:.04em}
.brand .wm b{color:var(--deep);font-weight:800}
.brand .dt{margin-inline-start:auto;color:var(--mut);font-size:11.5px}
h1{font-size:23px;margin:20px 0 3px;letter-spacing:-.01em}
.meta{color:var(--mut);font-size:12.5px}
.chips{display:flex;gap:7px;flex-wrap:wrap;margin:13px 0 4px}
.chip{font-size:11px;font-weight:700;padding:4px 11px;border-radius:99px;background:#F5F9E4;color:#4A6210;border:1px solid #DFE8BC}
h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--deep);margin:26px 0 4px}
h2::after{content:'';display:block;height:2px;background:linear-gradient(90deg,#DFE8BC,transparent);margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0 4px}
th{background:#F7FAEC;text-align:start;padding:7px 10px;border-bottom:2px solid #DFE8BC;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#4A6210}
td{padding:7px 10px;border-bottom:1px solid #EEF0E4;vertical-align:top}
tr:last-child td{border-bottom:none}
.exnote{color:var(--mut);font-size:11px;margin-top:2px}
.wk{display:flex;align-items:baseline;gap:10px;margin:18px 0 2px;flex-wrap:wrap}
.wk .day{background:var(--ink);color:#fff;font-weight:800;font-size:10.5px;padding:4px 10px;border-radius:6px;letter-spacing:.06em}
.wk .day.rest{background:#7C5CFC}
.wk b{font-size:14.5px}
.wk .meta{font-size:11.5px}
.qr{display:flex;gap:18px;align-items:center;margin-top:28px;padding:16px 18px;border:1.5px dashed #C9D6A0;border-radius:12px;background:#FBFDF3;page-break-inside:avoid}
.qr .txt b{font-size:14px;display:block}
.qr .txt .meta{margin-top:3px}
.qr .code{font-weight:800;letter-spacing:.12em;font-size:15px;margin-top:7px;color:#4A6210}
.foot{margin-top:26px;padding-top:11px;border-top:1px solid var(--line);color:#9CA3AF;font-size:10.5px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.printbtn{position:fixed;bottom:22px;inset-inline-end:22px;background:var(--ink);color:#fff;border:none;border-radius:99px;padding:12px 22px;font-size:13.5px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(18,21,27,.35);font-family:inherit}
.printbtn:hover{background:#232833}
@page{size:A4;margin:12mm}
@media print{
  body{background:#fff;font-size:12px}
  .sheet{box-shadow:none;margin:0;max-width:none;padding:0;border-radius:0}
  .printbtn{display:none}
  h2{page-break-after:avoid}
  .wk{page-break-after:avoid}
  table,.qr,.brand{page-break-inside:avoid}
}
</style></head><body>
<div class="sheet">
  <div class="brand">
    <svg class="mark" viewBox="0 0 120 100" fill="none" aria-hidden="true"><path d="M36 6L116 6 94 30 56 30 44 50 56 70 94 70 116 94 4 94Z" fill="currentColor"/></svg>
    <span class="wm">COACH<b>MINT</b></span>
    <span class="dt">${esc(dateLbl)}</span>
  </div>
  <h1>${esc(clientName)}</h1>
  <div class="meta">${esc(o.subline || '')}</div>
  <div class="chips">${metaChips}</div>
  ${body}
  ${qrLink ? `<div class="qr"><div>${qrSvg(qrLink, 108)}</div><div class="txt">
    <b>${esc(tr('Scan to connect', lang))}</b>
    <div class="meta">${esc(tr('Open the CoachMint app — your plan syncs live', lang))}</div>
    <div class="code">${esc(qrCode || '')}</div>
  </div></div>` : ''}
  <div class="foot"><span>CoachMint — ${esc(tr('Coach', lang))}: ${esc(coach || '')}</span><span>${esc(tr('Printed from CoachMint on', lang))} ${esc(dateLbl)}</span></div>
</div>
<button class="printbtn" onclick="window.print()">🖨 ${esc(tr('Print / Save as PDF', lang))}</button>
<script>setTimeout(function(){try{window.print()}catch(e){}},450)</script>
</body></html>`;
}

/* ---------- handler ---------- */
async function exportPdf(req) {
  const url = new URL(req.url);
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'fa';
  const kind = ['week', 'workout', 'nutrition'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : 'week';
  const code = normCode(url.searchParams.get('code'));
  if (!CODE_RE.test(code)) return j(400, { ok: false, error: 'bad code' });
  const st = store();
  const data = await loadWorkspace(st, code);
  if (!data) return j(404, { ok: false, error: 'workspace-not-found' });

  const clients = Array.isArray(data.CLIENTS) ? data.CLIENTS : [];
  const cParam = url.searchParams.get('client');
  let c = null;
  if (cParam != null && cParam !== '') {
    const asId = Number(cParam);
    c = clients.find(x => x.id === asId) || clients.find(x => String(x.name) === cParam);
  }
  if (!c) c = clients.find(x => x.status !== 'Archived') || clients[0];
  if (!c) return j(404, { ok: false, error: 'client-not-found' });

  const dateLbl = new Date().toLocaleDateString(lang === 'fa' ? 'fa-IR' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const db = (data.DB || {})[c.id] || {};
  const workouts = Array.isArray(db.workouts) ? db.workouts : [];
  const plans = Array.isArray(data.NPLANS) ? data.NPLANS : [];
  const plan = plans.find(p => p.client === c.name && !p.arch) || plans.find(p => p.client === c.name);

  /* Join link — same shape the app's invite buttons produce. */
  const base = (process.env.COACH_OS_URL && !/YOUR-SITE|localhost/.test(process.env.COACH_OS_URL))
    ? process.env.COACH_OS_URL.replace(/\/+$/, '')
    : url.origin;
  const joinCode = c.code ? `${code}-${c.code}` : code;
  const qrLink = `${base}/#join=${encodeURIComponent(joinCode)}`;

  const chips = [
    c.goal ? tr(c.goal, lang) : '',
    c.prog ? `${tr('Program', lang)}: ${c.prog}` : '',
    c.week ? `${tr('Week', lang)} ${nf(c.week, lang)}` : '',
    c.freq ? freqLbl(c.freq, lang) : ''
  ].filter(Boolean).map(x => `<span class="chip">${esc(x)}</span>`).join('');
  const gam = [
    (c.dayStreak || c.streak) ? `🔥 ${nf(c.dayStreak || c.streak, lang)} ${tr('day streak', lang)}` : '',
    c.pts ? `⭐ ${nf(c.pts, lang)} ${tr('Points', lang)}` : ''
  ].filter(Boolean).map(x => `<span class="chip">${esc(x)}</span>`).join('');

  let body = '';
  let title = `CoachMint — ${c.name}`;
  if (kind === 'nutrition') {
    if (!plan) return j(404, { ok: false, error: 'no-nutrition-plan' });
    title = `CoachMint — ${c.name} — ${plan.name}`;
    body = `<h2>${esc(tr('Nutrition Plan', lang))} — ${esc(plan.name)}</h2>${nutritionBlock(plan, data, lang, true)}`;
  } else if (kind === 'workout') {
    const wid = url.searchParams.get('wid');
    const w = workouts.find(x => String(x.id) === String(wid)) || workouts[0];
    if (!w) return j(404, { ok: false, error: 'no-workout' });
    title = `CoachMint — ${c.name} — ${w.name}`;
    body = `<h2>${esc(tr('Week Plan', lang))}</h2>${workoutBlock(w, data, lang)}`;
  } else {
    const list = [...workouts].sort((a, b) => dayIdx(a.day) - dayIdx(b.day)).slice(0, 14);
    body = `<h2>${esc(tr('Week Plan', lang))}</h2>` +
      (list.length ? list.map(w => workoutBlock(w, data, lang)).join('') : `<div class="meta">${esc(lang === 'fa' ? 'هنوز تمرینی ثبت نشده است' : 'No workouts yet')}</div>`);
    if (plan) body += `<h2>${esc(tr('Nutrition Plan', lang))} — ${esc(plan.name)}</h2>${nutritionBlock(plan, data, lang, false)}`;
  }

  const html = page({
    lang,
    title,
    clientName: c.name,
    subline: [c.prog, c.freq ? freqLbl(c.freq, lang) : ''].filter(Boolean).join(' · '),
    metaChips: chips + gam,
    body,
    qrLink,
    qrCode: joinCode,
    coach: data.ownerName || '',
    dateLbl
  });
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default async (req) => {
  if (req.method !== 'GET') return j(405, { ok: false, error: 'method not allowed' });
  const r = rateLimit(`export:${ipOf(req)}`, 30, 60_000);
  if (!r.ok) return tooMany(r.retryAfter);
  try {
    return secure(await exportPdf(req));
  } catch (e) {
    console.error('[export] handler error:', e.message);
    return j(500, { ok: false, error: 'server-error' });
  }
};

export const config = { path: '/api/export/*' };
