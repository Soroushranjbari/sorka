// CoachMint — guard contract tests: rate limiter, body cap, security headers.
// No network, no services — pure logic over mocked Request objects.
import { rateLimit, readBody, readJsonCapped, secure, ipOf, withLock, SECURITY_HEADERS, CSP } from '../backend/lib/guard.mjs';

let pass = 0, fail = 0;
const A = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

console.log('== rate limiter ==');
{
  const key = 'test:' + Math.random();
  A('first 3 allowed', rateLimit(key, 3, 1000).ok && rateLimit(key, 3, 1000).ok && rateLimit(key, 3, 1000).ok);
  const r4 = rateLimit(key, 3, 1000);
  A('4th blocked', !r4.ok);
  A('retryAfter >= 1', r4.retryAfter >= 1);
  A('independent keys', rateLimit(key + 'x', 3, 1000).ok);
}
console.log('== body cap ==');
{
  const big = new Request('http://x/', { method: 'POST', headers: { 'content-length': String(10_000_000) }, body: 'x' });
  A('content-length over cap rejected', (await readBody(big, 1000)).tooLarge === true);
  const ok = new Request('http://x/', { method: 'POST', headers: { 'content-length': '11' }, body: 'hello world' });
  A('small body passes', (await readBody(ok, 1000)).body === 'hello world');
  const streamed = new Request('http://x/', { method: 'POST', body: 'a'.repeat(5000) });
  A('streamed body over cap rejected', (await readBody(streamed, 1000)).tooLarge === true);
  const jok = new Request('http://x/', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
  const jr = await readJsonCapped(jok, 1000);
  A('json parse ok', jr.data && jr.data.a === 1);
  const jbad = new Request('http://x/', { method: 'POST', body: 'not-json' });
  A('bad json flagged', (await readJsonCapped(jbad, 1000)).bad === true);
}
console.log('== security headers ==');
{
  const res = secure(new Response('{}'));
  A('nosniff set', res.headers.get('x-content-type-options') === 'nosniff');
  A('frame deny set', res.headers.get('x-frame-options') === 'DENY');
  A('hsts set', (res.headers.get('strict-transport-security') || '').includes('max-age=31536000'));
  A('csp defined', typeof CSP === 'string' && CSP.includes("frame-ancestors 'none'"));
  A('all headers present', Object.keys(SECURITY_HEADERS).length === 5);
}
console.log('== ip extraction ==');
{
  const req = new Request('http://x/', { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } });
  A('xff first ip', ipOf(req) === '1.2.3.4');
  A('missing ip -> local', ipOf(new Request('http://x/')) === 'local');
}
console.log('== withLock (per-key mutex) ==');
{
  let running = 0, maxConcurrent = 0;
  const task = () => withLock('L', async () => {
    running++; maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
  });
  await Promise.all([task(), task(), task(), task()]);
  A('serializes concurrent sections', maxConcurrent === 1);
  A('returns the callback value', (await withLock('L2', async () => 42)) === 42);
  let threw = false;
  try { await withLock('L3', async () => { throw new Error('boom'); }); } catch { threw = true; }
  A('propagates callback errors', threw);
  A('releases the lock after an error', (await withLock('L3', async () => 'ok')) === 'ok');
  // Independent keys must not block each other.
  const t0 = Date.now();
  await Promise.all([withLock('K1', () => new Promise((r) => setTimeout(r, 30))), withLock('K2', () => new Promise((r) => setTimeout(r, 30)))]);
  A('independent keys run in parallel', Date.now() - t0 < 55);
}

console.log(`GUARD: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
