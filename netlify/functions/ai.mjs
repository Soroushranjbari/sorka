// Coach OS — Phase-3 AI assistant (OpenRouter, server-side key, FREE models).
//   POST /api/ai/draft   (Bearer) {catalog, ctx} -> {ok, draft, model, usage}
//   POST /api/ai/chat    (Bearer) {question, history?, catalog?} -> {ok, answer, model}
//   POST /api/ai/insight (Bearer) {kind:'weekly'|'reply', client?, lang?} -> {ok, text, model}
//   GET  /api/ai/quota   (Bearer) -> {ok, used, max, plan, chatToday, enabled}
//
// DESIGN CONTRACT — "the coach decides": the AI only DRAFTS and ADVISES. Its
// output is a suggestion the coach reviews/edits; nothing publishes
// automatically and no medical authority is claimed. The API key never leaves
// the server. The CHAT endpoint builds its context SERVER-SIDE from the KV
// store (the coach's real workspace: clients, workouts down to sets/reps/loads,
// nutrition plans down to meals, measurements, sessions, notes, messages,
// templates, billing) — the client only sends the question, so the assistant
// always sees the complete, current data.
//
// Quotas: drafts — monthly counter per coach (ai-usage:<id>:<YYYY-MM>), capped
// by plan. Chat — generous DAILY counter (ai-chat:<id>:<YYYY-MM-DD>) since the
// models are free. Failed upstream calls are NOT counted.
import { store, j, bearerOf, sessionOf, accountById, accessOf } from '../lib/saas.mjs';
import { planOf } from '../lib/billing.mjs';
import { readJsonCapped, tooLarge, badJson, rateLimit, ipOf, tooMany, secure, withLock } from '../lib/guard.mjs';

const AI_KEY = (process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();
const AI_BASE = (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
/* v16.7 — COMPLETELY FREE models only. OpenRouter free tiers rotate
   availability and rate-limit aggressively, so we keep a fallback CHAIN: the
   first entry is OpenRouter's own free-models router (picks any currently
   available free model), followed by concrete free models. callModel() walks
   the list until one returns a parseable draft. Override with AI_MODELS=a,b,c. */
const AI_MODELS = (process.env.AI_MODELS ||
  'nvidia/nemotron-3-super-120b-a12b:free,openrouter/free,qwen/qwen3.8-27b:free,google/gemma-4-31b-it:free')
  .split(',').map((s) => s.trim()).filter(Boolean);
/* Draft bodies carry the exercise catalog (~25 rows) + context — 64 KB is generous. */
const MAX_BYTES = 64_000;
const UPSTREAM_TIMEOUT_MS = 45_000;
/* Free OpenRouter models are REASONING models: they burn max_tokens on hidden
   reasoning before emitting content. A tight budget leaves `content` empty or
   the JSON truncated mid-object (finish_reason=length) — 3000 leaves room for
   both. */
const MAX_TOKENS = 3000;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/* Monthly draft credits per plan. Kept generous: a draft costs fractions of a cent. */
const QUOTA = { trial: 20, basic: 20, professional: 100, club: 400 };
/* Chat questions per coach per DAY. The models are free, so this is generous —
   it only exists to stop a runaway script from hammering the upstream. */
const CHAT_DAILY = Math.max(50, Number(process.env.AI_CHAT_DAILY) || 300);
/* Hard cap on the workspace context handed to the model (chars). Free models
   carry 128K-262K token windows; ~90K chars ≈ 23K tokens — comfortably inside. */
const CTX_MAX_CHARS = 90_000;

const monthKey = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

async function quotaOf(st, acct) {
  const plan = planOf(acct);
  const max = QUOTA[plan.id] ?? 20;
  const key = `ai-usage:${acct.id}:${monthKey()}`;
  const used = Number((await st.get(key, { type: 'json' })) || 0);
  return { key, used, max, plan: plan.id };
}

/* ---------- prompt ---------- */
function buildPrompt(ctx, catalog) {
  const lang = ctx.lang === 'fa' ? 'fa' : 'en';
  const sys =
    'You are the drafting assistant inside Coach OS, a workout-planning app for human coaches. ' +
    'You DRAFT ONLY: the coach always reviews, edits and decides — never imply automatic publication, ' +
    'diagnosis or medical authority. If the stated limitations suggest injury, avoid contraindicated ' +
    'exercises and explain the substitution in the workout note. Output STRICT JSON only — no markdown ' +
    'fences, no commentary before or after.';
  const user = [
    'Client profile (privacy-safe, no personal identifiers):',
    `- Primary goal: ${ctx.goal}`,
    `- Experience level: ${ctx.level}`,
    `- Training frequency: ${ctx.freq || '3x / week'}`,
    `- Session duration: ${ctx.durMin} minutes`,
    `- Limitations / focus: ${ctx.focus || 'none stated'}`,
    `- Language for the "note" fields: ${lang === 'fa' ? 'Persian (Farsi)' : 'English'}`,
    '',
    'Exercise catalog — pick ONLY from these, referencing each choice by its "i" index:',
    JSON.stringify(catalog),
    '',
    'Rules:',
    '- 4 to 8 exercises (roughly one compound or two isolation exercises per 10-12 minutes).',
    '- Order: compound lifts first, isolation and core last.',
    '- sets: 2-5. reps: 5-15 for compounds, 8-20 for isolation. kg: a sensible STARTING load for this',
    '  profile (0 for bodyweight). rest: 45-180 seconds. rpe: 6-9.',
    '- day: one of Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.',
    '- name: short session label like "Full Body A". note: ONE line of coaching cue.',
    '',
    'Respond with JSON exactly in this shape:',
    '{"name":"...","day":"Monday","dur":"' + ctx.durMin + ' min","note":"...","exercises":[{"i":0,"sets":4,"reps":8,"kg":80,"rest":120,"rpe":8,"note":"..."}]}'
  ].join('\n');
  return { sys, user };
}

/* ---------- upstream ---------- */
/** Try every free model in the chain until one yields a VALID answer.
 *  `messages` is the full chat-completions message array; `validate` turns the
 *  raw content into the final value (or null to reject and try the next model). */
async function callModel(messages, validate) {
  for (const model of AI_MODELS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const r = await fetch(`${AI_BASE}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${AI_KEY}`,
          'content-type': 'application/json',
          'HTTP-Referer': process.env.PUBLIC_URL || 'https://coach-os.app',
          'X-Title': 'Coach OS'
        },
        body: JSON.stringify({
          model,
          temperature: 0.6,
          max_tokens: MAX_TOKENS,
          messages
        })
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        console.error('[ai] upstream', model, r.status, t.slice(0, 200));
        continue; // rate-limited / unavailable — try the next free model
      }
      const d = await r.json().catch(() => null);
      const content = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || null;
      if (!content) { console.error('[ai] upstream', model, 'empty content'); continue; }
      const parsed = validate ? validate(content) : content;
      if (parsed) return { model, parsed };
      console.error('[ai] upstream', model, 'rejected output — trying next free model');
    } catch (e) {
      console.error('[ai] upstream failed:', model, e.message);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/* Loose JSON parser shared by every structured output: strips fences, and on
   truncation (finish_reason=length) closes open brackets/quotes so the leading
   complete entries survive. A repaired draft is still coach-reviewed, so a
   slightly shorter list beats a hard failure. */
function parseJsonLoose(raw) {
  let txt = cleanText(raw).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(txt); } catch {}
  const start = txt.indexOf('{');
  if (start < 0) return null;
  txt = txt.slice(start);
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of txt) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  txt = txt.replace(/,\s*\{[^{}]*$/, '');
  txt += inStr ? '"' : '';
  for (let i = stack.length - 1; i >= 0; i--) txt += stack[i] === '{' ? '}' : ']';
  try { return JSON.parse(txt); } catch { return null; }
}

function parseDraft(raw, catalog) {
  const d = parseJsonLoose(raw);
  if (!d || typeof d !== 'object' || !Array.isArray(d.exercises)) return null;
  const byIdx = new Map(catalog.map((c) => [c.i, c]));
  const clamp = (v, lo, hi, def) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const exercises = [];
  const seen = new Set();
  for (const x of d.exercises.slice(0, 12)) {
    const i = Math.round(Number(x && x.i));
    if (!byIdx.has(i) || seen.has(i)) continue; // unknown or duplicated exercise — drop
    seen.add(i);
    exercises.push({
      i,
      sets: clamp(x.sets, 1, 8, 3),
      reps: clamp(x.reps, 1, 50, 10),
      kg: clamp(x.kg, 0, 500, 0),
      rest: clamp(x.rest, 15, 300, 90),
      rpe: clamp(x.rpe, 5, 10, 8),
      note: String(x.note || '').slice(0, 140)
    });
  }
  if (!exercises.length) return null;
  return {
    name: String(d.name || 'AI Draft').slice(0, 80),
    day: DAYS.includes(d.day) ? d.day : 'Monday',
    dur: /^\d{2,3} min$/.test(String(d.dur || '')) ? String(d.dur).slice(0, 12) : '60 min',
    note: String(d.note || '').slice(0, 300),
    exercises
  };
}

/* ---------- workspace context (chat) ---------- */
const strip = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const line = (arr, s) => { arr.push(s); };

/** Build a compact but COMPLETE text summary of the coach's workspace straight
 *  from the KV store — this is what gives the chat assistant full visibility:
 *  every client with profile + join code, every workout down to sets/reps/load/
 *  rest/RPE/cues, nutrition plans down to meals and grams, measurements,
 *  sessions, notes, messages, templates, the food library and billing state. */
async function buildContext(st, acct, catalog, onlyName) {
  const L = [];
  line(L, `COACH: ${acct.name || ''} <${acct.email}>, plan=${acct.plan || 'trial'}, role=${acct.role || 'coach'}`);
  if (Array.isArray(catalog) && catalog.length) {
    line(L, `EXERCISE LIBRARY (${catalog.length}): ` + catalog.map((c) => `${c.i}=${c.n}`).join(' | '));
  }
  if (!acct.workspaceId) { line(L, 'WORKSPACE: none yet (no clients synced)'); return L.join('\n'); }
  const m = await st.get(`ws-meta:${acct.workspaceId}`, { type: 'json' }).catch(() => null);
  if (!m || !m.data) { line(L, 'WORKSPACE: exists but holds no data yet'); return L.join('\n'); }
  const d = m.data;
  const db = d.DB || {};
  const foods = Array.isArray(d.FOODS) ? d.FOODS : [];
  const foodName = (fi) => (foods[fi] && foods[fi].n) || ('food#' + fi);
  const all = Array.isArray(d.CLIENTS) ? d.CLIENTS : [];
  // onlyName: focused mode for reply-drafting — just that one client.
  const cl = onlyName
    ? all.filter((c) => String(c.name || '').trim().toLowerCase() === onlyName.toLowerCase())
    : all;
  if (onlyName && !cl.length) return `WORKSPACE: no client named "${onlyName}" found. Clients: ` + all.map((c) => c.name).join(', ');
  line(L, `WORKSPACE: code=${m.code || '?'}, clients=${cl.length}, lastUpdated=${m.updatedAt ? new Date(m.updatedAt).toISOString() : '?'}`);

  cl.slice(0, 80).forEach((c, ci) => {
    if (L.length > CTX_MAX_CHARS) return;
    const b = db[c.id] || {};
    const P = [];
    line(P, `## CLIENT ${ci + 1}: ${c.name || '?'} (join code: ${c.code || '—'})`);
    line(P, `profile: status=${c.status || '?'} | goal=${c.goal || '—'} | weight=${c.weight != null ? c.weight + 'kg' : '—'} | height=${c.h != null ? c.h + 'cm' : '—'} | bodyfat=${c.bf != null ? c.bf + '%' : '—'} | freq=${c.freq || '—'} | streak=${c.streak || 0}wk | program=${c.prog || '—'} | week=${c.week || '—'}/12 | email=${c.email || '—'} | next=${c.next || '—'} | done=${(b.stats && b.stats.done) || 0} missed=${(b.stats && b.stats.missed) || 0}`);
    const ws = Array.isArray(b.workouts) ? b.workouts : [];
    if (ws.length) {
      line(P, `workouts (${ws.length}):`);
      ws.slice(0, 15).forEach((w) => {
        const exs = (w.exercises || []).map((x) => {
          const ex = catalog.find((k) => k.i === x.ex);
          return `${ex ? ex.n : 'ex#' + x.ex} ${x.sets}x${x.reps}@${x.kg}kg rest${x.rest}s ${x.rpe || ''} ${x.note || ''}`.trim();
        }).join(' | ');
        line(P, `  - "${w.name}" [${w.status}] ${w.day || ''} ${w.dur || ''}${w.note ? ' — note: ' + w.note : ''}`);
        if (exs) line(P, `    exercises: ${exs}`);
      });
    }
    const ms = Array.isArray(b.measures) ? b.measures : [];
    if (ms.length) {
      line(P, `measurements (${ms.length}): ` + ms.slice(-12).map((x) => `${x.d}: w=${x.w != null ? x.w + 'kg' : '—'} bf=${x.bf != null ? x.bf + '%' : '—'} waist=${x.wa != null ? x.wa : '—'} arm=${x.ar != null ? x.ar : '—'}`).join(' | '));
    }
    const ss = Array.isArray(b.sessions) ? b.sessions : [];
    if (ss.length) {
      line(P, `sessions (${ss.length}): ` + ss.slice(-10).map((x) => `day${x.day} ${x.start}:00 "${x.label || ''}" ${x.dur}h [${x.att || 'unmarked'}]`).join(' | '));
    }
    const notes = (Array.isArray(d.NOTES) ? d.NOTES : []).filter((n) => n.client === c.name);
    if (notes.length) {
      line(P, `notes (${notes.length}):`);
      notes.slice(-8).forEach((n) => line(P, `  - [${n.from === 'coach' ? 'coach' : 'client'}${n.shared ? ', shared' : ''}] "${n.title}" — ${strip(n.body).slice(0, 200)} (${n.date})`));
    }
    const msgs = (Array.isArray(d.MSGS) ? d.MSGS : []).filter((x) => x.client === c.name);
    if (msgs.length) {
      line(P, `messages (${msgs.length}), last 8:`);
      msgs.slice(-8).forEach((x) => line(P, `  - [${x.from}] ${strip(x.body).slice(0, 200)} (${x.time})`));
    }
    const np = (Array.isArray(d.NPLANS) ? d.NPLANS : []).find((p) => p.client === c.name && p.status !== 'Archived');
    if (np) {
      line(P, `nutrition plan: "${np.name}" [${np.status}] goal=${np.goal || '—'} phase=${np.phase || '—'} | train day: ${np.train && np.train.kcal}kcal P${np.train && np.train.p} C${np.train && np.train.c} F${np.train && np.train.f} | rest day: ${np.rest && np.rest.kcal}kcal P${np.rest && np.rest.p} C${np.rest && np.rest.c} F${np.rest && np.rest.f}`);
      const days = Array.isArray(np.days) ? np.days : [];
      days.slice(0, 7).forEach((dy, di) => {
        const meals = (dy.meals || []).map((mm) => `${mm.n || mm.name || 'Meal'}: ` + (mm.foods || []).map((f) => `${foodName(f.fi)} ${f.g}g`).join(' + ')).join(' ; ');
        if (meals) line(P, `  day${di + 1} (${dy.type}): ${meals}`);
      });
    }
    // Hard cap per client so one chatty client cannot eat the whole window.
    let sec = P.join('\n');
    if (sec.length > 6000) sec = sec.slice(0, 6000) + '\n  …[truncated]';
    L.push(sec);
  });

  const evs = Array.isArray(d.EVENTS) ? d.EVENTS : [];
  if (evs.length && !onlyName) line(L, `CALENDAR (${evs.length}): ` + evs.slice(-25).map((e) => `day${e.day} ${e.start}:00 "${e.label || ''}" for ${e.client} [${e.att || 'unmarked'}]`).join(' | '));
  const tps = Array.isArray(d.TEMPLATES) ? d.TEMPLATES : [];
  if (tps.length && !onlyName) line(L, `TEMPLATES (${tps.length}): ` + tps.slice(0, 10).map((t) => `"${t.n}" (${t.days}, ${t.dur}, ${(t.exs || []).length}ex)`).join(' | '));
  if (foods.length && !onlyName) line(L, `FOOD LIBRARY (${foods.length}): ` + foods.slice(0, 60).map((f) => `${f.n} ${f.kcal}kcal/${f.p}p`).join(' | '));
  const acts = Array.isArray(d.ACTIVITY) ? d.ACTIVITY : [];
  if (acts.length) line(L, `RECENT ACTIVITY: ` + acts.slice(0, 10).map((a) => strip(a.h).slice(0, 90)).join(' | '));
  const q = await quotaOf(st, acct);
  line(L, `BILLING: plan=${q.plan}, AI drafts this month=${q.used}/${q.max}`);

  let out = L.join('\n\n');
  if (out.length > CTX_MAX_CHARS) out = out.slice(0, CTX_MAX_CHARS) + '\n…[context truncated]';
  return out;
}

/* ---------- text answers (chat / insight) ---------- */
/* Free reasoning models sometimes leak their chain-of-thought into `content`
   (or wrap it in <think> tags). Strip the tags; REJECT obvious leaks so the
   chain falls through to a cleaner model instead of showing the coach the
   model's scratchpad. */
function cleanText(raw) {
  return String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
const looksLikeLeak = (t) =>
  /^(here'?s (a )?think|let me (analyze|think|work)|first,? (i|we) (need|should|will)|user safety|i cannot|i'm sorry,? but)/i.test(t.slice(0, 140)) ||
  /analyze (the )?user request|analyze the live workspace/i.test(t.slice(0, 400));
function textAnswer(raw, minLen) {
  const t = cleanText(raw);
  return t && t.length >= minLen && !looksLikeLeak(t) ? t : null;
}

/* ---------- handlers ---------- */
async function quota(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  const q = await quotaOf(st, acct);
  const chatKey = `ai-chat:${acct.id}:${new Date().toISOString().slice(0, 10)}`;
  const chatUsed = Number((await st.get(chatKey, { type: 'json' })) || 0);
  return j(200, { ok: true, used: q.used, max: q.max, plan: q.plan, chatToday: chatUsed, chatMax: CHAT_DAILY, enabled: !!AI_KEY, models: AI_MODELS });
}

async function draft(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  if (!AI_KEY) return j(503, { ok: false, error: 'ai-not-configured' });
  const access = accessOf(acct);
  if (access.status === 'suspended') return j(402, { ok: false, error: 'sub-suspended' });
  if (access.status === 'expired') return j(402, { ok: false, error: 'sub-expired' });
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, MAX_BYTES);
  if (big) return tooLarge(MAX_BYTES);
  if (bad) return badJson();
  // Catalog: the app's static exercise list, sent by the client. Validate shape
  // and size — the model may only reference indexes that exist in it.
  const rawCat = Array.isArray(body?.catalog) ? body.catalog : [];
  if (rawCat.length < 5 || rawCat.length > 300) return j(400, { ok: false, error: 'bad-catalog' });
  const catalog = [];
  for (const c of rawCat) {
    const i = Math.round(Number(c && c.i));
    const n = String((c && c.n) || '').slice(0, 60);
    if (!Number.isInteger(i) || i < 0 || !n) continue;
    catalog.push({ i, n, m: String((c && c.m) || '').slice(0, 30), e: String((c && c.e) || '').slice(0, 30) });
  }
  if (catalog.length < 5) return j(400, { ok: false, error: 'bad-catalog' });
  const ctxIn = body?.ctx || {};
  const ctx = {
    goal: String(ctxIn.goal || 'General Fitness').slice(0, 40),
    level: String(ctxIn.level || 'Intermediate').slice(0, 20),
    freq: String(ctxIn.freq || '3x / week').slice(0, 30),
    durMin: Math.min(180, Math.max(20, Math.round(Number(ctxIn.durMin) || 60))),
    focus: String(ctxIn.focus || '').slice(0, 300),
    lang: ctxIn.lang === 'fa' ? 'fa' : 'en'
  };
  // Quota is a check-then-increment — serialize per coach so two concurrent
  // drafts cannot both slip past the last remaining credit.
  return withLock(`ai:${acct.id}`, async () => {
    const q = await quotaOf(st, acct);
    if (q.used >= q.max) return j(402, { ok: false, error: 'ai-quota', used: q.used, max: q.max });
    const { sys, user } = buildPrompt(ctx, catalog);
    const out = await callModel([{ role: 'system', content: sys }, { role: 'user', content: user }], (raw) => parseDraft(raw, catalog));
    if (!out) return j(502, { ok: false, error: 'ai-upstream' });
    // Only a SUCCESSFUL draft burns a credit.
    await st.setJSON(q.key, q.used + 1);
    return j(200, { ok: true, draft: out.parsed, model: out.model, usage: { used: q.used + 1, max: q.max, plan: q.plan } });
  });
}

/** POST /api/ai/chat {question, history?, catalog?} — the coach's assistant
 *  with FULL workspace visibility. Context is built server-side from KV, so
 *  answers can cite real, current details (weights, meals, measurements…).
 *  Advisory only: the assistant never mutates anything. */
async function chat(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  if (!AI_KEY) return j(503, { ok: false, error: 'ai-not-configured' });
  const access = accessOf(acct);
  if (access.status === 'suspended') return j(402, { ok: false, error: 'sub-suspended' });
  if (access.status === 'expired') return j(402, { ok: false, error: 'sub-expired' });
  /* History (≤10 turns) + catalog + question — 200 KB is generous. */
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, 200_000);
  if (big) return tooLarge(200_000);
  if (bad) return badJson();
  const question = String(body?.question || '').trim().slice(0, 4000);
  if (!question) return j(400, { ok: false, error: 'bad-question' });
  const history = (Array.isArray(body?.history) ? body.history : []).slice(-10)
    .map((h) => ({ role: h && h.role === 'assistant' ? 'assistant' : 'user', content: String((h && h.content) || '').slice(0, 4000) }))
    .filter((h) => h.content);
  const catalog = (Array.isArray(body?.catalog) ? body.catalog : [])
    .map((c) => ({ i: Math.round(Number(c && c.i)), n: String((c && c.n) || '').slice(0, 60), m: String((c && c.m) || '').slice(0, 30), e: String((c && c.e) || '').slice(0, 30) }))
    .filter((c) => Number.isInteger(c.i) && c.i >= 0 && c.n)
    .slice(0, 300);
  const dayKey = new Date().toISOString().slice(0, 10);
  const ckey = `ai-chat:${acct.id}:${dayKey}`;
  return withLock(`ai:${acct.id}`, async () => {
    const used = Number((await st.get(ckey, { type: 'json' })) || 0);
    if (used >= CHAT_DAILY) return j(402, { ok: false, error: 'ai-quota', used, max: CHAT_DAILY });
    const context = await buildContext(st, acct, catalog);
    const sys = [
      'You are the built-in AI assistant of Coach OS, a workout & nutrition coaching app. The SIGNED-IN COACH is talking to you.',
      'You have FULL READ access to their workspace — the data block below is live server-side data. Answer questions about ANY detail:',
      'clients and their profiles, workouts (sets, reps, loads, rest, RPE, cues), nutrition plans (meals, grams, macros), measurements and trends,',
      'sessions and attendance, notes, message history, templates, the exercise/food library, billing and quotas, and how app features work.',
      'Rules:',
      '- Be CONCRETE: cite the actual names and numbers from the data instead of speaking generically.',
      '- If something is not in the data, say so plainly — never invent clients, numbers or history.',
      '- You ADVISE; the coach DECIDES. Never claim you changed, published or deleted anything — you cannot mutate data.',
      '- Health/safety: general fitness guidance is fine; for suspected injury or medical issues recommend a professional.',
      '- Answer in the SAME LANGUAGE the coach writes in (Persian or English).',
      '',
      '=== LIVE WORKSPACE DATA ===',
      context,
      '=== END DATA ==='
    ].join('\n');
    const messages = [{ role: 'system', content: sys }, ...history, { role: 'user', content: question }];
    const out = await callModel(messages, (raw) => textAnswer(raw, 2));
    if (!out) return j(502, { ok: false, error: 'ai-upstream' });
    // Only a SUCCESSFUL answer burns a daily chat credit.
    await st.setJSON(ckey, used + 1);
    return j(200, { ok: true, answer: out.parsed, model: out.model, usage: { chatToday: used + 1, chatMax: CHAT_DAILY } });
  });
}

/** POST /api/ai/insight {kind:'weekly'|'reply', client?, lang?} — Phase 3.
 *  weekly: a structured report over the WHOLE workspace (attention list,
 *  highlights, 3 suggested actions). reply: ONE draft message answering a
 *  specific client's latest messages — returned as TEXT for the composer;
 *  the coach edits and sends it (the AI never sends anything itself).
 *  Shares the daily chat quota. */
async function insight(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  if (!AI_KEY) return j(503, { ok: false, error: 'ai-not-configured' });
  const access = accessOf(acct);
  if (access.status === 'suspended') return j(402, { ok: false, error: 'sub-suspended' });
  if (access.status === 'expired') return j(402, { ok: false, error: 'sub-expired' });
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, 100_000);
  if (big) return tooLarge(100_000);
  if (bad) return badJson();
  const kind = body?.kind === 'reply' ? 'reply' : 'weekly';
  const clientName = String(body?.client || '').trim().slice(0, 80);
  const lang = body?.lang === 'fa' ? 'fa' : 'en';
  if (kind === 'reply' && !clientName) return j(400, { ok: false, error: 'bad-client' });
  const catalog = (Array.isArray(body?.catalog) ? body.catalog : [])
    .map((c) => ({ i: Math.round(Number(c && c.i)), n: String((c && c.n) || '').slice(0, 60), m: String((c && c.m) || '').slice(0, 30), e: String((c && c.e) || '').slice(0, 30) }))
    .filter((c) => Number.isInteger(c.i) && c.i >= 0 && c.n)
    .slice(0, 300);
  const dayKey = new Date().toISOString().slice(0, 10);
  const ckey = `ai-chat:${acct.id}:${dayKey}`;
  return withLock(`ai:${acct.id}`, async () => {
    const used = Number((await st.get(ckey, { type: 'json' })) || 0);
    if (used >= CHAT_DAILY) return j(402, { ok: false, error: 'ai-quota', used, max: CHAT_DAILY });
    const context = await buildContext(st, acct, catalog, kind === 'reply' ? clientName : null);
    const sys = kind === 'weekly'
      ? [
        'You are the built-in AI assistant of Coach OS. Produce a WEEKLY REPORT for the signed-in coach from the live workspace data below.',
        'Structure (plain text, short lines, "-" bullets, no markdown tables):',
        '1) Snapshot — one line: active clients, workouts pending review, unanswered client messages.',
        '2) Needs attention — every client with a REAL reason found in the data (missed sessions, no check-in, unanswered message, weight trend, archived) with the actual numbers.',
        '3) Highlights — streaks, completed workouts, measurements logged.',
        '4) This week — exactly 3 concrete suggested actions for the coach.',
        'Cite real names/numbers from the data. Never invent. If the workspace is empty, say so and suggest the first step.',
        'You advise; the coach decides. Answer in ' + (lang === 'fa' ? 'Persian (Farsi)' : 'English') + '.'
      ].join('\n')
      : [
        'You are the built-in AI assistant of Coach OS. Draft ONE reply message from the COACH to their client, based on the live data below.',
        'Rules:',
        '- 2-4 short sentences, warm and professional, coach-to-client tone.',
        '- Reference something SPECIFIC from the client\'s data (their latest message, workout status, streak, check-in) when it exists.',
        '- Output ONLY the reply text — no quotes, no preamble, no signature.',
        '- You are drafting for the coach to review and send; never claim anything was already done.',
        '- Write in ' + (lang === 'fa' ? 'Persian (Farsi)' : 'English') + '.'
      ].join('\n');
    const user = kind === 'weekly'
      ? 'Generate this week\'s report now.'
      : `Draft the reply to ${clientName} now.`;
    const out = await callModel([{ role: 'system', content: sys }, { role: 'user', content: user + '\n\n=== LIVE WORKSPACE DATA ===\n' + context }], (raw) => textAnswer(raw, kind === 'weekly' ? 150 : 15));
    if (!out) return j(502, { ok: false, error: 'ai-upstream' });
    await st.setJSON(ckey, used + 1);
    return j(200, { ok: true, text: out.parsed, kind, model: out.model, usage: { chatToday: used + 1, chatMax: CHAT_DAILY } });
  });
}

/* ---------- client diagnostics (Phase 4) ---------- */
/* Deterministic calorie baseline (Mifflin-St Jeor) computed SERVER-SIDE from
   the coach-entered profile, so the model explains real math instead of
   inventing numbers. Age/sex are not tracked in the client profile — the
   assumption is stated in the hint and the model relays it. */
function calorieHints(c) {
  const kg = Number(c && c.weight) || 0, cm = Number(c && c.h) || 0;
  if (kg <= 20 || cm <= 100) return null;
  const bmr = 10 * kg + 6.25 * cm - 5 * 30 + 5; // assumes age 30, male
  const perWeek = { '2x / week': 2, '3x / week': 3, '4x / week': 4, '5x / week': 5 }[String(c.freq || '').trim()] || 3;
  const tdee = Math.round(bmr * (1.2 + perWeek * 0.075));
  const goal = String(c.goal || '');
  const isCut = /fat loss/i.test(goal), isBulk = /muscle gain/i.test(goal);
  const target = Math.max(1200, tdee + (isCut ? -500 : isBulk ? 300 : 0));
  const protein = Math.round(kg * (isCut ? 2.2 : 1.8));
  const fat = Math.round(kg * (isCut ? 0.8 : 1.0));
  const carbs = Math.max(50, Math.round((target - protein * 4 - fat * 9) / 4));
  return { bmr: Math.round(bmr), tdee, target, protein, carbs, fat, assumption: 'age≈30, male (not tracked in profile) — adjust if needed' };
}

/* Validate the model's structured assessment. Anything malformed is dropped;
   an assessment without findings is rejected so the chain tries another model. */
function parseAnalysis(raw) {
  const d = parseJsonLoose(raw);
  if (!d || typeof d !== 'object' || !Array.isArray(d.findings) || !d.findings.length) return null;
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  const clampN = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  const cal = d.calories && typeof d.calories === 'object' ? {
    target: clampN(d.calories.target, 1000, 6000),
    protein: clampN(d.calories.protein, 20, 400),
    carbs: clampN(d.calories.carbs, 0, 800),
    fat: clampN(d.calories.fat, 10, 250),
    rationale: s(d.calories.rationale, 300)
  } : null;
  if (cal && (cal.target == null || cal.protein == null)) return null;
  const sec = (x) => x && typeof x === 'object' ? { summary: s(x.summary, 400), changes: (Array.isArray(x.changes) ? x.changes : []).slice(0, 5).map((c) => s(c, 200)).filter(Boolean) } : null;
  return {
    status: ['ok', 'warning', 'critical'].includes(d.status) ? d.status : 'warning',
    findings: d.findings.slice(0, 6).map((f) => ({
      area: s(f && f.area, 40),
      severity: ['low', 'medium', 'high'].includes(f && f.severity) ? f.severity : 'medium',
      title: s(f && f.title, 120),
      detail: s(f && f.detail, 400)
    })).filter((f) => f.title),
    calories: cal,
    nutrition: sec(d.nutrition),
    workout: sec(d.workout),
    actions: (Array.isArray(d.actions) ? d.actions : []).slice(0, 5).map((a) => s(a, 200)).filter(Boolean)
  };
}

/** POST /api/ai/analyze {client, lang, catalog?} — Phase 4: deep diagnostic for
 *  ONE client. Detects weight trend vs goal, adherence, nutrition gaps and
 *  engagement from the live data; prescribes calories/macros (grounded in the
 *  server-computed Mifflin-St Jeor hints) plus nutrition & workout changes.
 *  Advisory only — the coach decides. Shares the daily chat quota. */
async function analyze(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  if (!AI_KEY) return j(503, { ok: false, error: 'ai-not-configured' });
  const access = accessOf(acct);
  if (access.status === 'suspended') return j(402, { ok: false, error: 'sub-suspended' });
  if (access.status === 'expired') return j(402, { ok: false, error: 'sub-expired' });
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, 100_000);
  if (big) return tooLarge(100_000);
  if (bad) return badJson();
  const clientName = String(body?.client || '').trim().slice(0, 80);
  if (!clientName) return j(400, { ok: false, error: 'bad-client' });
  const lang = body?.lang === 'fa' ? 'fa' : 'en';
  const catalog = (Array.isArray(body?.catalog) ? body.catalog : [])
    .map((c) => ({ i: Math.round(Number(c && c.i)), n: String((c && c.n) || '').slice(0, 60), m: String((c && c.m) || '').slice(0, 30), e: String((c && c.e) || '').slice(0, 30) }))
    .filter((c) => Number.isInteger(c.i) && c.i >= 0 && c.n)
    .slice(0, 300);
  const dayKey = new Date().toISOString().slice(0, 10);
  const ckey = `ai-chat:${acct.id}:${dayKey}`;
  return withLock(`ai:${acct.id}`, async () => {
    const used = Number((await st.get(ckey, { type: 'json' })) || 0);
    if (used >= CHAT_DAILY) return j(402, { ok: false, error: 'ai-quota', used, max: CHAT_DAILY });
    // Structured record for the deterministic hints + focused context.
    const m = acct.workspaceId ? await st.get(`ws-meta:${acct.workspaceId}`, { type: 'json' }).catch(() => null) : null;
    const rec = m && m.data && (Array.isArray(m.data.CLIENTS) ? m.data.CLIENTS : []).find((c) => String(c.name || '').trim().toLowerCase() === clientName.toLowerCase());
    if (!rec) return j(404, { ok: false, error: 'client-not-found' });
    const hints = calorieHints(rec);
    const context = await buildContext(st, acct, catalog, clientName);
    const sys = [
      'You are the built-in AI assistant of Coach OS. Perform a DIAGNOSTIC assessment of ONE client for the signed-in coach, from the live workspace data below.',
      'Detect problems and prescribe — but you ADVISE; the coach DECIDES. Never claim you changed anything.',
      'Diagnose across these areas, citing the client\'s REAL numbers:',
      '- weight-trend: measurement history vs the stated goal (e.g. weight DROPPING while goal is Muscle Gain = high severity; rising while Fat Loss = high).',
      '- adherence: missed sessions, streak, completed vs assigned workouts, attendance.',
      '- nutrition: no plan? plan macros far from the computed target? train/rest structure?',
      '- engagement: unanswered messages, last check-in, notes.',
      'Use the COMPUTED HINTS (BMR/TDEE/macros from Mifflin-St Jeor) as the calorie baseline — adjust only with a clear reason and say why.',
      'Respond with STRICT JSON only — no markdown fences, no commentary:',
      '{"status":"ok|warning|critical",',
      ' "findings":[{"area":"weight-trend|adherence|nutrition|engagement|other","severity":"low|medium|high","title":"...","detail":"..."}],',
      ' "calories":{"target":2600,"protein":170,"carbs":300,"fat":80,"rationale":"..."},',
      ' "nutrition":{"summary":"...","changes":["..."]},',
      ' "workout":{"summary":"...","changes":["..."]},',
      ' "actions":["..."]} ',
      'All text values in ' + (lang === 'fa' ? 'Persian (Farsi)' : 'English') + '.'
    ].join('\n');
    const user = [
      'Client to assess: ' + clientName,
      hints ? 'COMPUTED HINTS (Mifflin-St Jeor, server-side): BMR=' + hints.bmr + 'kcal, TDEE=' + hints.tdee + 'kcal, suggested target=' + hints.target + 'kcal, protein=' + hints.protein + 'g, carbs=' + hints.carbs + 'g, fat=' + hints.fat + 'g (' + hints.assumption + ')' : 'COMPUTED HINTS: unavailable (weight/height missing) — give qualitative advice only and omit calories.',
      '=== LIVE WORKSPACE DATA ===',
      context
    ].join('\n');
    const out = await callModel([{ role: 'system', content: sys }, { role: 'user', content: user }], parseAnalysis);
    if (!out) return j(502, { ok: false, error: 'ai-upstream' });
    await st.setJSON(ckey, used + 1);
    return j(200, { ok: true, analysis: out.parsed, model: out.model, usage: { chatToday: used + 1, chatMax: CHAT_DAILY } });
  });
}

export default async (req) => {
  if (req.method === 'POST') {
    const r = rateLimit(`ai:${ipOf(req)}`, 20, 60_000);
    if (!r.ok) return tooMany(r.retryAfter);
  }
  const st = store();
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);
  const action = (segs[2] || '').toLowerCase();
  try {
    if (req.method === 'GET' && action === 'quota') return secure(await quota(req, st));
    if (req.method === 'POST' && action === 'draft') return secure(await draft(req, st));
    if (req.method === 'POST' && action === 'chat') return secure(await chat(req, st));
    if (req.method === 'POST' && action === 'insight') return secure(await insight(req, st));
    if (req.method === 'POST' && action === 'analyze') return secure(await analyze(req, st));
    return j(404, { ok: false, error: 'not-found' });
  } catch (e) {
    console.error('[ai] handler error:', e.message);
    return j(500, { ok: false, error: 'server-error' });
  }
};

export const config = { path: '/api/ai/*' };
