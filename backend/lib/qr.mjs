// CoachMint — self-contained QR encoder (backend twin of the in-app module).
// Compact byte-mode adaptation of Project Nayuki's qrcodegen (MIT): byte mode,
// ECC level M, versions 1..10 (join links are ~50 chars → version 4).
// Zero dependencies, no DOM: make() returns the module matrix, qrSvg() renders
// an inline SVG string for the printable export pages (/api/export/pdf).
// Kept in lock-step with the encoder inside index.html — if one changes,
// change both (the app CSP forbids sharing via a CDN, so the code is duplicated).

const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], NB = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/* GF(256) exp/log tables, polynomial 0x11D */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
const rsDiv = deg => { const r = Array(deg).fill(0); r[deg - 1] = 1; let root = 1;
  for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = mul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = mul(root, 2); }
  return r; };
const rsRem = (data, div) => { const res = div.map(() => 0);
  for (const b of data) { const f = b ^ res.shift(); res.push(0); div.forEach((c, i) => res[i] ^= mul(c, f)); }
  return res; };
const rawModules = v => { let r = (16 * v + 128) * v + 64;
  if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
const dataCW = v => Math.floor(rawModules(v) / 8) - ECC[v] * NB[v];
const interleave = (v, data) => { const nb = NB[v], el = ECC[v];
  const raw = Math.floor(rawModules(v) / 8), short = Math.floor(raw / nb), nShort = nb - raw % nb;
  const div = rsDiv(el), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) { const len = short - el + (i < nShort ? 0 : 1);
    const dat = data.slice(k, k + len); k += len;
    const ecc = rsRem(dat, div), blk = dat.concat(ecc);
    if (i < nShort) blk.splice(dat.length, 0, 0); /* pad byte sits before ecc */
    blocks.push(blk); }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i != short - el || j >= nShort) out.push(b[i]); });
  return out; };

function make(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = 0;
  for (let v = 1; v <= 10; v++) { if (4 + (v < 10 ? 8 : 16) + 8 * bytes.length <= dataCW(v) * 8) { ver = v; break; } }
  if (!ver) throw new Error('qr-too-long');
  const bits = [], put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); /* byte mode + count */
  bytes.forEach(b => put(b, 8));
  const cap = dataCW(ver) * 8;
  put(0, Math.min(4, cap - bits.length)); /* terminator */
  while (bits.length % 8) bits.push(0);
  const dcw = dataCW(ver), data = [];
  for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b); }
  for (let p = 0xEC; data.length < dcw; p ^= 0xEC ^ 0x11) data.push(p);
  const all = interleave(ver, data);
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => Array(size).fill(false));
  const fn = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y, c) => { mod[y][x] = c; fn[y][x] = true; };
  const finder = (x, y) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
    if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d != 2 && d != 4); } };
  const align = (x, y) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
    set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1); };
  const drawFmt = mask => { const d = mask; let rem = d; /* ECL M format bits = 0 */
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = (d << 10 | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, (b >>> i) & 1);
    set(8, 7, (b >>> 6) & 1); set(8, 8, (b >>> 7) & 1); set(7, 8, (b >>> 8) & 1);
    for (let i = 9; i < 15; i++) set(14 - i, 8, (b >>> i) & 1);
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, (b >>> i) & 1);
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, (b >>> i) & 1);
    set(8, size - 8, true); };
  const drawVer = () => { if (ver < 7) return; let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const b = ver << 12 | rem;
    for (let i = 0; i < 18; i++) { const c = (b >>> i) & 1, a = size - 11 + i % 3, q = Math.floor(i / 3);
      set(a, q, c); set(q, a, c); } };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 == 0); set(i, 6, i % 2 == 0); } /* timing */
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const ap = [6];
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2, st = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    for (let pos = size - 7; ap.length < n; pos -= st) ap.splice(1, 0, pos); }
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++)
    if (!(i == 0 && j == 0 || i == 0 && j == ap.length - 1 || i == ap.length - 1 && j == 0)) align(ap[i], ap[j]);
  drawFmt(0); drawVer();
  let bi = 0; /* zigzag codeword placement */
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right == 6) right = 5;
    for (let vt = 0; vt < size; vt++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) == 0, y = up ? size - 1 - vt : vt;
      if (!fn[y][x] && bi < all.length * 8) { mod[y][x] = ((all[bi >>> 3] >>> (7 - (bi & 7))) & 1) == 1; bi++; } } }
  const inv = (m, x, y) => m == 0 ? (x + y) % 2 == 0 : m == 1 ? y % 2 == 0 : m == 2 ? x % 3 == 0 : m == 3 ? (x + y) % 3 == 0
    : m == 4 ? (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0 : m == 5 ? (x * y % 2 + x * y % 3) == 0
    : m == 6 ? (x * y % 2 + x * y % 3) % 2 == 0 : ((x + y) % 2 + x * y % 3) % 2 == 0;
  const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    if (!fn[y][x] && inv(m, x, y)) mod[y][x] = !mod[y][x]; };
  const addHist = (run, h) => { if (h[0] == 0) run += size; h.pop(); h.unshift(run); };
  const countPat = h => { const n = h[1], core = n > 0 && h[2] == n && h[3] == n * 3 && h[4] == n && h[5] == n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0); };
  const term = (color, run, h) => { if (color) { addHist(run, h); run = 0; } run += size; addHist(run, h); return countPat(h); };
  const penalty = () => { let res = 0;
    for (let y = 0; y < size; y++) { let rc = false, rx = 0; const h = [0];
      for (let x = 0; x < size; x++) { if (mod[y][x] == rc) { rx++; if (rx == 5) res += 3; else if (rx > 5) res++; }
        else { addHist(rx, h); if (!rc) res += countPat(h) * 40; rc = mod[y][x]; rx = 1; } }
      res += term(rc, rx, h) * 40; }
    for (let x = 0; x < size; x++) { let rc = false, ry = 0; const h = [0];
      for (let y = 0; y < size; y++) { if (mod[y][x] == rc) { ry++; if (ry == 5) res += 3; else if (ry > 5) res++; }
        else { addHist(ry, h); if (!rc) res += countPat(h) * 40; rc = mod[y][x]; ry = 1; } }
      res += term(rc, ry, h) * 40; }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = mod[y][x];
      if (c == mod[y][x + 1] && c == mod[y + 1][x] && c == mod[y + 1][x + 1]) res += 3; }
    let dark = 0; for (const row of mod) for (const c of row) if (c) dark++;
    const k = Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1;
    return res + k * 10; };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) { applyMask(m); drawFmt(m); const s = penalty();
    if (s < bestScore) { bestScore = s; best = m; } applyMask(m); } /* second apply undoes */
  applyMask(best); drawFmt(best);
  return mod;
}

/* Inline SVG with the 4-module quiet zone baked into the viewBox — always
   dark-on-white so phone cameras scan it on paper in any lighting. */
export function qrSvg(text, px) {
  let m; try { m = make(text); } catch { return ''; }
  const n = m.length; let path = '';
  m.forEach((row, y) => row.forEach((v, x) => { if (v) path += `M${x} ${y}h1v1h-1z`; }));
  return `<svg viewBox="-4 -4 ${n + 8} ${n + 8}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect x="-4" y="-4" width="${n + 8}" height="${n + 8}" fill="#fff"/><path d="${path}" fill="#161c04"/></svg>`;
}
