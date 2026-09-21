// CoachMint — minimal .env loader (zero dependencies).
// Imported FIRST by server.mjs so the variables exist before backend/lib/db.mjs
// reads the environment at module load. Values already present in the real
// environment always win (12-factor style) — the file only fills gaps, so
// `PORT=3000 node server.mjs` and the test suite keep full control.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// backend/lib/env.mjs -> project root is three levels up.
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
try {
  const src = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // real environment wins
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #'); // trailing comment on an unquoted value
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    process.env[key] = val;
  }
} catch { /* no .env file — everything has a default */ }
