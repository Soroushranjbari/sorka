// CoachMint — health endpoint (public, no secrets).
// GET /api/health -> { ok, backend, postgresConfigured, postgresHost, time }
import { j } from '../lib/saas.mjs';
import { dbInfo } from '../lib/db.mjs';

export default async () =>
  j(200, { ok: true, ...dbInfo(), time: new Date().toISOString() });

export const config = { path: '/api/health' };
