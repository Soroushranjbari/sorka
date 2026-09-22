// CoachMint — AI assistant (OpenRouter, server-side key, FREE models).
//   POST /api/ai/draft   (Bearer) {catalog, ctx} -> {ok, draft, model, usage}
//   POST /api/ai/chat    (Bearer) {question, history?, catalog?} -> {ok, answer, model}
//   POST /api/ai/insight (Bearer) {kind:'weekly'|'reply', client?, lang?} -> {ok, text, model}
//   POST /api/ai/analyze (Bearer) {client, lang, catalog?} -> {ok, analysis, model}
//   POST /api/ai/action  (Bearer) {request, lang?, catalog?} -> {ok, reply, applied, failed}
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
  'openrouter/free,qwen/qwen3.8-27b:free,google/gemma-4-31b-it:free')
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
    'You are the drafting assistant inside CoachMint, a workout-planning app for human coaches. ' +
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
          'HTTP-Referer': process.env.PUBLIC_URL || 'https://coachmint.app',
          'X-Title': 'CoachMint'
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
  /* v18.16 — FULL coach profile: identity, plan, role, workspace pointer and
     the account's own billing window, so "what do you know about me" answers
     with real facts instead of guessing. */
  const access = accessOf(acct);
  const until = acct.sub_ends_at || (acct.sub && acct.sub.endsAt) || acct.trialEndsAt || null;
  line(L, `COACH PROFILE: name=${acct.name || ''} | email=${acct.email} | plan=${acct.plan || 'trial'} | role=${acct.role || 'coach'} | workspace=${acct.workspaceId || 'none'} | access=${access.status}${until ? ` (until ${new Date(until).toISOString().slice(0, 10)})` : ''}`);
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
  const actN = all.filter((c) => c && c.status !== 'Archived').length;
  line(L, `WORKSPACE: code=${m.code || '?'}, clients=${all.length} (${actN} active, ${all.length - actN} archived), lastUpdated=${m.updatedAt ? new Date(m.updatedAt).toISOString() : '?'}`);

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
      'You are the built-in AI assistant of CoachMint, a workout & nutrition coaching app. The SIGNED-IN COACH is talking to you.',
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
        'You are the built-in AI assistant of CoachMint. Produce a WEEKLY REPORT for the signed-in coach from the live workspace data below.',
        'Structure (plain text, short lines, "-" bullets, no markdown tables):',
        '1) Snapshot — one line: active clients, workouts pending review, unanswered client messages.',
        '2) Needs attention — every client with a REAL reason found in the data (missed sessions, no check-in, unanswered message, weight trend, archived) with the actual numbers.',
        '3) Highlights — streaks, completed workouts, measurements logged.',
        '4) This week — exactly 3 concrete suggested actions for the coach.',
        'Cite real names/numbers from the data. Never invent. If the workspace is empty, say so and suggest the first step.',
        'You advise; the coach decides. Answer in ' + (lang === 'fa' ? 'Persian (Farsi)' : 'English') + '.'
      ].join('\n')
      : [
        'You are the built-in AI assistant of CoachMint. Draft ONE reply message from the COACH to their client, based on the live data below.',
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
      'You are the built-in AI assistant of CoachMint. Perform a DIAGNOSTIC assessment of ONE client for the signed-in coach, from the live workspace data below.',
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

/* ---------- Phase 5: APPLY changes (write access) ---------- */
/* The coach can flip the assistant into "Apply" mode: the model returns
   structured actions, THIS FILE validates them against a strict whitelist and
   mutates the workspace KV itself. The model never writes directly — every
   field is clamped, every target re-resolved against live data, and the
   response lists exactly what was applied (or why an action failed). */

const STATUSES = ['Active', 'Paused', 'Archived'];
const NOTE_TYPES = ['General Note', 'Training Note', 'Progress Note', 'Injury / Restriction Note', 'Nutrition Note'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/* Measurement keys → sane metric ranges (kg / cm / %). */
const MEAS_RANGES = { w: [20, 400], ht: [80, 260], bf: [1, 70], ch: [20, 200], wa: [20, 200], hi: [20, 200], ar: [10, 80], th: [10, 120], ca: [10, 80] };

const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, n);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 10) / 10)) : null; };
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const normFreq = (v) => {
  const m = String(v || '').match(/(\d)\s*x\s*\/?\s*week/i);
  const n = m && Number(m[1]);
  return n >= 2 && n <= 5 ? `${n}x / week` : (clean(v, 30) || null);
};
const genClientCode = () => {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
};

/** Turn the model's raw JSON into a SAFE action list. Unknown shapes are
 *  dropped here; anything that references missing clients is reported later,
 *  at apply time, so the coach sees a precise reason. */
function parseActions(raw) {
  const d = parseJsonLoose(raw);
  if (!d || typeof d !== 'object') return null;
  const reply = clean(d.reply, 2000);
  const list = Array.isArray(d.actions) ? d.actions.slice(0, 8) : [];
  const actions = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const kind = String(a.action || '').trim();
    const client = clean(a.client, 80);
    if (kind === 'update_client') {
      const f = a.fields && typeof a.fields === 'object' ? a.fields : {};
      const fields = {};
      if (f.name != null) { const v = clean(f.name, 80); if (v.length >= 2) fields.name = v; }
      if (f.email != null) { const v = clean(f.email, 120); if (isEmail(v)) fields.email = v; }
      if (f.phone != null) { const v = clean(f.phone, 30); if (v) fields.phone = v; }
      if (f.goal != null) { const v = clean(f.goal, 40); if (v) fields.goal = v; }
      if (f.status != null && STATUSES.includes(f.status)) fields.status = f.status;
      if (f.freq != null) { const v = normFreq(f.freq); if (v) fields.freq = v; }
      if (f.prog != null) { const v = clean(f.prog, 80); if (v) fields.prog = v; }
      if (f.week != null) { const v = num(f.week, 1, 52); if (v != null) fields.week = Math.round(v); }
      if (f.weight != null) { const v = num(f.weight, 20, 400); if (v != null) fields.weight = v; }
      if (f.h != null) { const v = num(f.h, 80, 260); if (v != null) fields.h = v; }
      if (f.bf != null) { const v = num(f.bf, 1, 70); if (v != null) fields.bf = v; }
      if (f.targetW != null) { const v = num(f.targetW, 20, 400); if (v != null) fields.targetW = v; }
      if (f.targetDate != null) { const v = isoDate(f.targetDate); if (v) fields.targetDate = v; }
      if (f.nid != null) { const v = clean(f.nid, 20); if (v) fields.nid = v; }
      if (client && Object.keys(fields).length) actions.push({ action: 'update_client', client, fields });
    } else if (kind === 'add_client') {
      const f = a.fields && typeof a.fields === 'object' ? a.fields : {};
      const name = clean(f.name, 80);
      if (name.length < 2) continue;
      const fields = { name };
      if (f.goal != null) { const v = clean(f.goal, 40); if (v) fields.goal = v; }
      if (f.freq != null) { const v = normFreq(f.freq); if (v) fields.freq = v; }
      if (f.email != null) { const v = clean(f.email, 120); if (isEmail(v)) fields.email = v; }
      if (f.phone != null) { const v = clean(f.phone, 30); if (v) fields.phone = v; }
      if (f.weight != null) { const v = num(f.weight, 20, 400); if (v != null) fields.weight = v; }
      if (f.h != null) { const v = num(f.h, 80, 260); if (v != null) fields.h = v; }
      actions.push({ action: 'add_client', fields });
    } else if (kind === 'add_note') {
      const body = clean(a.body, 2000), title = clean(a.title, 120);
      if (!client || (!body && !title)) continue;
      actions.push({ action: 'add_note', client, title: title || 'Note', body, shared: !!a.shared, type: NOTE_TYPES.includes(a.type) ? a.type : 'General Note' });
    } else if (kind === 'send_message') {
      const body = clean(a.body, 2000);
      if (!client || !body) continue;
      actions.push({ action: 'send_message', client, body });
    } else if (kind === 'add_measurement') {
      const fields = {};
      for (const [k, [lo, hi]] of Object.entries(MEAS_RANGES)) {
        if (a[k] != null) { const v = num(a[k], lo, hi); if (v != null) fields[k] = v; }
      }
      if (!client || !Object.keys(fields).length) continue;
      actions.push({ action: 'add_measurement', client, fields, d: isoDate(a.d) });
    } else if (kind === 'schedule_session') {
      const day = Math.round(Number(a.day)), start = Math.round(Number(a.start));
      const dur = num(a.dur, 0.5, 4) || 1, label = clean(a.label, 60) || 'Session';
      if (!client || !Number.isInteger(day) || day < 0 || day > 6) continue;
      if (!Number.isInteger(start) || start < 6 || start > 22) continue;
      actions.push({ action: 'schedule_session', client, day, start, dur, label });
    } else if (kind === 'update_coach') {
      const name = clean(a.name, 80);
      if (name.length >= 2) actions.push({ action: 'update_coach', name });
    }
  }
  return { reply, actions };
}

/** Apply validated actions to the workspace payload IN PLACE. Returns
 *  {applied, failed, coachName} — the caller persists the payload and handles
 *  the coach rename (which lives on the ACCOUNT, not in the workspace). */
function applyActions(data, actions, lang, acct) {
  const applied = [], failed = [];
  let coachName = null;
  const fa = lang === 'fa';
  const clients = Array.isArray(data.CLIENTS) ? data.CLIENTS : (data.CLIENTS = []);
  if (!data.DB || typeof data.DB !== 'object' || Array.isArray(data.DB)) data.DB = {};
  const db = data.DB;
  const findClient = (name) => clients.find((c) => String(c.name || '').trim().toLowerCase() === String(name || '').trim().toLowerCase());
  const seats = () => clients.filter((c) => c && c.status !== 'Archived').length;
  const plan = planOf(acct);
  const base = Date.now() * 1000;
  const today = new Date().toISOString().slice(0, 10);
  const fmtFields = (fields) => Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ');

  actions.forEach((a, ai) => {
    const fail = (reason) => failed.push({ action: a.action, target: a.client || a.name || '', reason });
    try {
      if (a.action === 'update_client') {
        const c = findClient(a.client);
        if (!c) return fail('client-not-found');
        const rename = a.fields.name && a.fields.name !== c.name ? a.fields.name : null;
        if (rename && findClient(rename)) return fail('name-exists');
        // Un-archiving grows the seat count — respect the owner's plan cap.
        if (c.status === 'Archived' && a.fields.status && a.fields.status !== 'Archived' && seats() + 1 > plan.maxClients) return fail('quota-exceeded');
        Object.assign(c, a.fields);
        if (rename) {
          // Notes/messages/plans/events key on the NAME — follow the rename
          // exactly like the app's own edit modal does.
          [data.NOTES, data.MSGS, data.NPLANS, data.EVENTS].forEach((arr) => {
            if (Array.isArray(arr)) arr.forEach((x) => { if (x && x.client === a.client) x.client = rename; });
          });
        }
        applied.push({ action: 'update_client', target: rename || a.client, detail: `${rename || a.client}: ${fmtFields(a.fields)}` });
      } else if (a.action === 'add_client') {
        if (seats() + 1 > plan.maxClients) return fail('quota-exceeded');
        if (findClient(a.fields.name)) return fail('name-exists');
        const c = {
          id: base + ai, name: a.fields.name, code: genClientCode(),
          goal: a.fields.goal || 'Muscle Gain', weight: a.fields.weight != null ? a.fields.weight : 0,
          prog: 'Onboarding — Week 1', week: 1, next: '—', status: 'Active',
          freq: a.fields.freq || '3x / week', streak: 0, done: 0, missed: 0, last: '—', nextW: 'Unscheduled',
          h: a.fields.h != null ? a.fields.h : 0, bf: a.fields.bf != null ? a.fields.bf : 0
        };
        if (a.fields.email) c.email = a.fields.email;
        if (a.fields.phone) c.phone = a.fields.phone;
        clients.unshift(c);
        db[c.id] = { workouts: [], sessions: [], stats: { done: 0, missed: 0 }, nutrition: null, measures: [] };
        applied.push({ action: 'add_client', target: c.name, detail: `${c.name} (${c.code})` });
      } else if (a.action === 'add_note') {
        const c = findClient(a.client);
        if (!c) return fail('client-not-found');
        if (!Array.isArray(data.NOTES)) data.NOTES = [];
        data.NOTES.unshift({ id: base + ai, client: c.name, from: 'coach', shared: !!a.shared, type: a.type, title: a.title, date: 'Just now', body: a.body, pin: false, arch: false });
        applied.push({ action: 'add_note', target: c.name, detail: `${c.name}: "${a.title}"` });
      } else if (a.action === 'send_message') {
        const c = findClient(a.client);
        if (!c) return fail('client-not-found');
        if (!Array.isArray(data.MSGS)) data.MSGS = [];
        data.MSGS.push({ id: base + ai, client: c.name, from: 'coach', type: 'text', body: a.body, time: 'Just now', read: true });
        applied.push({ action: 'send_message', target: c.name, detail: `${c.name}: ${a.body.slice(0, 60)}${a.body.length > 60 ? '…' : ''}` });
      } else if (a.action === 'add_measurement') {
        const c = findClient(a.client);
        if (!c) return fail('client-not-found');
        const bucket = db[c.id] = db[c.id] || { workouts: [], sessions: [], stats: { done: 0, missed: 0 }, measures: [] };
        if (!Array.isArray(bucket.measures)) bucket.measures = [];
        const e = { d: a.d || today, ...a.fields };
        bucket.measures.push(e);
        bucket.measures.sort((x, y) => (x.d < y.d ? -1 : 1));
        if (e.w != null) c.weight = e.w;
        if (e.bf != null) c.bf = e.bf;
        if (e.ht != null) c.h = e.ht;
        applied.push({ action: 'add_measurement', target: c.name, detail: `${c.name}: ${fmtFields(a.fields)}${a.d ? ` @${a.d}` : ''}` });
      } else if (a.action === 'schedule_session') {
        const c = findClient(a.client);
        if (!c) return fail('client-not-found');
        if (!Array.isArray(data.EVENTS)) data.EVENTS = [];
        data.EVENTS.push({ id: base + ai, day: a.day, start: a.start, dur: a.dur, client: c.name, label: a.label, type: 'Session' });
        applied.push({ action: 'schedule_session', target: c.name, detail: `${c.name}: day${a.day} ${String(a.start).padStart(2, '0')}:00 "${a.label}"` });
      } else if (a.action === 'update_coach') {
        coachName = a.name;
        // Client devices greet the coach by the payload's ownerName — keep it
        // in sync with the account rename.
        if (typeof data.ownerName === 'string' && data.ownerName) data.ownerName = a.name;
        applied.push({ action: 'update_coach', target: a.name, detail: `${acct.name || ''} → ${a.name}` });
      }
    } catch (e) {
      console.error('[ai] apply failed:', a.action, e.message);
      fail('failed');
    }
  });

  // One activity-feed entry for the whole batch (the feed renders HTML).
  if (applied.length) {
    if (!Array.isArray(data.ACTIVITY)) data.ACTIVITY = [];
    const n = applied.length;
    data.ACTIVITY.unshift({
      w: 'Just now', i: 'zap',
      h: fa ? `<b>${'دستیار هوشمند'}</b> ${n} تغییر اعمال کرد` : `<b>AI assistant</b> applied ${n} change${n > 1 ? 's' : ''}`
    });
  }
  return { applied, failed, coachName };
}

/** POST /api/ai/action {request, lang?, catalog?} — Phase 5: the assistant
 *  with WRITE access. The coach describes a change; the model returns
 *  structured actions; the server validates + applies them to the live
 *  workspace KV and reports exactly what changed. Shares the daily chat
 *  quota. The coach's device pulls the new revision right after. */
async function aiAction(req, st) {
  const s = await sessionOf(st, bearerOf(req));
  if (!s) return j(401, { ok: false, error: 'unauthorized' });
  const acct = await accountById(st, s.coachId);
  if (!acct) return j(401, { ok: false, error: 'unauthorized' });
  if (!AI_KEY) return j(503, { ok: false, error: 'ai-not-configured' });
  const access = accessOf(acct);
  if (access.status === 'suspended') return j(402, { ok: false, error: 'sub-suspended' });
  if (access.status === 'expired') return j(402, { ok: false, error: 'sub-expired' });
  const { data: body, tooLarge: big, bad } = await readJsonCapped(req, 200_000);
  if (big) return tooLarge(200_000);
  if (bad) return badJson();
  const request = String(body?.request || '').trim().slice(0, 4000);
  if (!request) return j(400, { ok: false, error: 'bad-question' });
  const lang = body?.lang === 'fa' ? 'fa' : 'en';
  const catalog = (Array.isArray(body?.catalog) ? body.catalog : [])
    .map((c) => ({ i: Math.round(Number(c && c.i)), n: String((c && c.n) || '').slice(0, 60), m: String((c && c.m) || '').slice(0, 30), e: String((c && c.e) || '').slice(0, 30) }))
    .filter((c) => Number.isInteger(c.i) && c.i >= 0 && c.n)
    .slice(0, 300);
  const meta = acct.workspaceId ? await st.get(`ws-meta:${acct.workspaceId}`, { type: 'json' }).catch(() => null) : null;
  if (!meta || !meta.data) return j(404, { ok: false, error: 'no-workspace' });
  const dayKey = new Date().toISOString().slice(0, 10);
  const ckey = `ai-chat:${acct.id}:${dayKey}`;
  return withLock(`ai:${acct.id}`, async () => {
    const used = Number((await st.get(ckey, { type: 'json' })) || 0);
    if (used >= CHAT_DAILY) return j(402, { ok: false, error: 'ai-quota', used, max: CHAT_DAILY });
    const context = await buildContext(st, acct, catalog);
    const sys = [
      'You are the built-in AI assistant of CoachMint with WRITE access to the signed-in coach\'s workspace.',
      'The coach asks you to MAKE CHANGES (update a client profile, log a measurement, add a note, message a client, schedule a session, add a client, rename the coach).',
      'You have FULL READ access via the live data block below. Apply ONLY what was explicitly asked — never invent extra changes, never delete data.',
      'Respond with STRICT JSON only — no markdown fences, no commentary:',
      '{"reply":"one short sentence confirming what you changed (or a clarifying question if the request is ambiguous)","actions":[…]}',
      'Available actions (use ONLY these exact shapes; omit optional fields you do not need):',
      '- {"action":"update_client","client":"<exact name>","fields":{"name":"…","email":"…","phone":"…","goal":"…","status":"Active|Paused|Archived","freq":"3x / week","prog":"…","week":6,"weight":82.4,"h":176,"bf":14.2,"targetW":78,"targetDate":"2026-12-01","nid":"…"}}',
      '- {"action":"add_client","fields":{"name":"…","goal":"…","freq":"3x / week","email":"…","phone":"…","weight":75,"h":178}}',
      '- {"action":"add_note","client":"…","title":"…","body":"…","shared":false}',
      '- {"action":"send_message","client":"…","body":"…"}',
      '- {"action":"add_measurement","client":"…","w":75.2,"ht":176,"bf":14,"wa":84,"d":"YYYY-MM-DD"}  (w=weight kg, ht=height cm, bf=bodyfat %, wa=waist, hi=hips, ch=chest, ar=arm, th=thigh, ca=calf; d defaults to today)',
      '- {"action":"schedule_session","client":"…","day":0,"start":9,"dur":1,"label":"…"}  (day: 0=Monday…6=Sunday; start: hour 6-22; dur: hours)',
      '- {"action":"update_coach","name":"…"}  (rename the coach themself)',
      'Rules:',
      '- Use the EXACT client name as it appears in the data.',
      '- Numbers are METRIC (kg, cm, %). Never invent values the coach did not give.',
      '- If the request is ambiguous or the client does not exist, return an EMPTY actions list and ask in "reply".',
      '- "reply" in the SAME LANGUAGE the coach writes in (Persian or English).'
    ].join('\n');
    const user = [
      `Today is ${dayKey} (YYYY-MM-DD).`,
      `The coach says: "${request}"`,
      '=== LIVE WORKSPACE DATA ===',
      context
    ].join('\n');
    const out = await callModel([{ role: 'system', content: sys }, { role: 'user', content: user }], parseActions);
    if (!out) return j(502, { ok: false, error: 'ai-upstream' });
    const { reply, actions } = out.parsed;
    let applied = [], failed = [], renamedCoach = null;
    if (actions.length) {
      // Serialize against the coach's own data writes (same lock key as the
      // data handler) and RE-READ the payload inside the lock so a concurrent
      // PUT that landed while the model was thinking is not clobbered.
      const res = await withLock(`data:${meta.code}`, async () => {
        const cur = await st.get(`ws-meta:${acct.workspaceId}`, { type: 'json' }).catch(() => null);
        if (!cur || !cur.data) return null;
        const r = applyActions(cur.data, actions, lang, acct);
        const rev = Date.now();
        await st.setJSON(`ws-meta:${acct.workspaceId}`, { rev, data: cur.data, owner: cur.owner || null, code: cur.code || meta.code, updatedAt: rev });
        return r;
      });
      if (res) { applied = res.applied; failed = res.failed; renamedCoach = res.coachName || null; }
      else failed.push({ action: 'all', target: '', reason: 'no-workspace' });
      // Coach rename lives on the ACCOUNT — same lock the profile endpoint uses.
      if (res && res.coachName) {
        await withLock(`acct:${acct.email}`, async () => {
          const cur = (await st.get(`acct:${acct.email}`, { type: 'json' })) || acct;
          cur.name = res.coachName;
          await st.setJSON(`acct:${cur.email}`, cur);
        });
      }
    }
    await st.setJSON(ckey, used + 1);
    return j(200, { ok: true, reply, applied, failed, coachName: renamedCoach, model: out.model, usage: { chatToday: used + 1, chatMax: CHAT_DAILY } });
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
    if (req.method === 'POST' && action === 'action') return secure(await aiAction(req, st));
    return j(404, { ok: false, error: 'not-found' });
  } catch (e) {
    console.error('[ai] handler error:', e.message);
    return j(500, { ok: false, error: 'server-error' });
  }
};

export const config = { path: '/api/ai/*' };
