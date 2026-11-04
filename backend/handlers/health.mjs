// CoachMint — health endpoint (public, no secrets).
// GET /api/health -> { ok, backend, postgresConfigured, postgresHost, lanIp, time }
import { networkInterfaces } from 'node:os';
import { j } from '../lib/saas.mjs';
import { dbInfo } from '../lib/db.mjs';

function getLanIp() {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      const list = nets[name] || [];
      for (const net of list) {
        if (net.family === 'IPv4' && !net.internal && (net.address.startsWith('192.168.') || net.address.startsWith('10.') || net.address.startsWith('172.'))) {
          return net.address;
        }
      }
    }
    for (const name of Object.keys(nets)) {
      const list = nets[name] || [];
      for (const net of list) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  } catch {}
  return null;
}

export default async () =>
  j(200, { ok: true, ...dbInfo(), lanIp: getLanIp(), time: new Date().toISOString() });

export const config = { path: '/api/health' };
