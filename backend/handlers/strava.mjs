// CoachMint — Strava Activity Provider & OAuth Integration (Multi-Athlete Supported).
//   GET  /api/strava/config           -> { ok, configured, clientId, simulator }
//   POST /api/strava/config           -> { ok }  body: { clientId, clientSecret, simulator }
//   GET  /api/strava/auth?cid=...     -> { ok, mode, url, cid }
//   GET  /api/strava/callback         -> OAuth redirect handler (processes state=cid)
//   GET  /api/strava/status?cid=...   -> { ok, connected, athleteName, lastSync, importedCount, isSimulator, cid }
//   POST /api/strava/sync             -> { ok, count, activities, cid }  body: { cid }
//   POST /api/strava/disconnect       -> { ok, connected: false, cid }   body: { cid }
import { store, j } from '../lib/saas.mjs';
import { originOf, readJsonCapped, secure } from '../lib/guard.mjs';

const CONFIG_KEY = 'strava:config';
const CONN_KEY = 'strava:connection';

function athleteConnKey(cid) {
  const c = cid != null ? String(cid).trim() : '';
  return c ? `strava:connection:${c}` : CONN_KEY;
}

export default async function handleStrava(req) {
  const url = new URL(req.url, originOf(req));
  const sub = url.pathname.replace(/^\/api\/strava\/?/, '').replace(/\/+$/, '');
  const method = req.method.toUpperCase();

  // 1. CONFIG (Platform-wide Strava API Client ID & Secret)
  if (sub === 'config') {
    if (method === 'GET') {
      const cfg = (await store().get(CONFIG_KEY)) || {};
      const envId = process.env.STRAVA_CLIENT_ID || '';
      const clientId = cfg.clientId || envId;
      return secure(j(200, {
        ok: true,
        configured: !!(clientId && (cfg.clientSecret || process.env.STRAVA_CLIENT_SECRET)),
        clientId: clientId ? String(clientId).slice(0, 4) + '••••' : '',
        simulator: cfg.simulator !== false // defaults to true for immediate out-of-the-box readiness
      }));
    }
    if (method === 'POST') {
      const { data } = await readJsonCapped(req);
      const cur = (await store().get(CONFIG_KEY)) || {};
      const updated = {
        clientId: (data && data.clientId != null) ? String(data.clientId).trim() : (cur.clientId || ''),
        clientSecret: (data && data.clientSecret != null) ? String(data.clientSecret).trim() : (cur.clientSecret || ''),
        simulator: data ? !!data.simulator : true,
        updatedAt: new Date().toISOString()
      };
      await store().setJSON(CONFIG_KEY, updated);
      return secure(j(200, { ok: true, simulator: updated.simulator, configured: !!(updated.clientId && updated.clientSecret) }));
    }
  }

  // 2. AUTH URL (Per-Athlete OAuth Generator)
  if (sub === 'auth') {
    const cfg = (await store().get(CONFIG_KEY)) || {};
    const envId = process.env.STRAVA_CLIENT_ID || '';
    const clientId = cfg.clientId || envId;
    const origin = originOf(req);
    const cid = url.searchParams.get('cid') || '';

    // If simulator mode is enabled OR credentials not configured, provide seamless sandbox auth
    if (cfg.simulator !== false || !clientId) {
      const sandboxUrl = `${origin}/api/strava/callback?code=mock_strava_sandbox_token&scope=read,activity:read_all${cid ? `&state=${encodeURIComponent(cid)}` : ''}`;
      return secure(j(200, { ok: true, mode: 'simulator', url: sandboxUrl, cid }));
    }

    const redirectUri = encodeURIComponent(`${origin}/api/strava/callback`);
    const stravaUrl = `https://www.strava.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${redirectUri}&approval_prompt=auto&scope=read,activity:read_all${cid ? `&state=${encodeURIComponent(cid)}` : ''}`;
    return secure(j(200, { ok: true, mode: 'oauth', url: stravaUrl, cid }));
  }

  // 3. OAUTH CALLBACK (Links OAuth token to specific athlete via state=cid)
  if (sub === 'callback') {
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    const stateCid = url.searchParams.get('state') || '';

    if (err || !code) {
      const redUrl = `/?view=wear&strava=denied${stateCid ? `&cid=${encodeURIComponent(stateCid)}` : ''}`;
      return new Response(`<!DOCTYPE html><html><body><script>
        alert("Strava authorization was denied or cancelled.");
        window.location.href = ${JSON.stringify(redUrl)};
      </script></body></html>`, { status: 302, headers: { 'content-type': 'text/html', Location: redUrl } });
    }

    // A. Simulator / Sandbox Mode
    if (code === 'mock_strava_sandbox_token') {
      const mockConn = {
        connected: true,
        cid: stateCid || '',
        athleteName: stateCid ? `Athlete #${stateCid} (Strava)` : 'Daniel Okoye',
        athleteId: stateCid ? 8940000 + (+stateCid || 1) : 8941205,
        connectedAt: new Date().toISOString(),
        lastSync: new Date().toISOString(),
        importedCount: 3,
        isSimulator: true
      };
      await store().setJSON(athleteConnKey(stateCid), mockConn);
      if (!stateCid) await store().setJSON(CONN_KEY, mockConn);

      const dest = `/?view=wear&strava=connected${stateCid ? `&cid=${encodeURIComponent(stateCid)}` : ''}`;
      return new Response(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${dest}"></head><body>Redirecting to CoachMint...</body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    }

    // B. Real Strava Token Exchange
    const cfg = (await store().get(CONFIG_KEY)) || {};
    const clientId = cfg.clientId || process.env.STRAVA_CLIENT_ID;
    const clientSecret = cfg.clientSecret || process.env.STRAVA_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return new Response(`<!DOCTYPE html><html><body><script>
        alert("Strava client secret is missing in server configuration.");
        window.location.href = "/?view=wear";
      </script></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    }

    try {
      const resp = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code: code,
          grant_type: 'authorization_code'
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data.access_token) {
        throw new Error(data.message || 'Token exchange failed');
      }

      const athlete = data.athlete || {};
      const athleteName = [athlete.firstname, athlete.lastname].filter(Boolean).join(' ') || athlete.username || 'Strava Athlete';

      const connRecord = {
        connected: true,
        cid: stateCid || '',
        athleteName: athleteName,
        athleteId: athlete.id || '',
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_at,
        connectedAt: new Date().toISOString(),
        lastSync: new Date().toISOString(),
        importedCount: 0,
        isSimulator: false
      };
      await store().setJSON(athleteConnKey(stateCid), connRecord);
      if (!stateCid) await store().setJSON(CONN_KEY, connRecord);

      const dest = `/?view=wear&strava=connected${stateCid ? `&cid=${encodeURIComponent(stateCid)}` : ''}`;
      return new Response(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${dest}"></head><body>Redirecting to CoachMint...</body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    } catch (e) {
      return new Response(`<!DOCTYPE html><html><body><script>
        alert("Failed to complete Strava connection: ${escapeHtml(e.message)}");
        window.location.href = "/?view=wear";
      </script></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    }
  }

  // 4. CONNECTION STATUS (Checks specific athlete or default)
  if (sub === 'status') {
    const cid = url.searchParams.get('cid') || '';
    const connKey = athleteConnKey(cid);
    let conn = (await store().get(connKey)) || {};
    if (!conn.connected && !cid) {
      conn = (await store().get(CONN_KEY)) || {};
    }
    return secure(j(200, {
      ok: true,
      connected: !!conn.connected,
      cid: cid || conn.cid || '',
      athleteName: conn.athleteName || '',
      athleteId: conn.athleteId || '',
      lastSync: conn.lastSync || '',
      importedCount: conn.importedCount || 0,
      isSimulator: !!conn.isSimulator
    }));
  }

  // 5. SYNC ACTIVITIES (Per-Athlete Activity Fetching)
  if (sub === 'sync') {
    let cid = url.searchParams.get('cid') || '';
    if (method === 'POST') {
      try {
        const { data } = await readJsonCapped(req);
        if (data && data.cid) cid = String(data.cid);
      } catch (_) {}
    }

    const connKey = athleteConnKey(cid);
    let conn = (await store().get(connKey)) || {};
    if (!conn.connected && !cid) {
      conn = (await store().get(CONN_KEY)) || {};
    }

    if (!conn.connected) {
      return secure(j(400, { ok: false, error: 'not-connected', cid }));
    }

    let activities = [];

    // A. Simulator Fresh Activities Generator
    if (conn.isSimulator) {
      const now = Date.now();
      const d1 = new Date(now - 1 * 864e5).toISOString().slice(0, 10);
      const d2 = new Date(now - 3 * 864e5).toISOString().slice(0, 10);
      const d3 = new Date(now - 5 * 864e5).toISOString().slice(0, 10);
      const prefix = cid ? `strava_sim_${cid}_` : 'strava_sim_';
      activities = [
        {
          id: prefix + d1.replace(/-/g, ''),
          cid: cid ? +cid : (conn.cid ? +conn.cid : 1),
          name: 'Morning Tempo Run · Strava',
          km: 10.4,
          min: 49,
          elev: 75,
          rpe: 8,
          kind: 'hi',
          date: d1,
          splits: '4:42, 4:38, 4:35, 4:40, 4:32'
        },
        {
          id: prefix + d2.replace(/-/g, ''),
          cid: cid ? +cid : (conn.cid ? +conn.cid : 1),
          name: 'Track Intervals · 8 × 400m',
          km: 8.6,
          min: 44,
          elev: 12,
          rpe: 8,
          kind: 'hi',
          date: d2,
          splits: '1:38, 1:40, 1:39, 1:41, 1:37'
        },
        {
          id: prefix + d3.replace(/-/g, ''),
          cid: cid ? +cid : (conn.cid ? +conn.cid : 1),
          name: 'Aerobic Base Long Run',
          km: 21.2,
          min: 112,
          elev: 195,
          rpe: 6,
          kind: 'long',
          date: d3,
          splits: '5:20, 5:18, 5:15, 5:22, 5:14'
        }
      ];
    } else {
      // B. Live Strava API Activities Fetch using athlete's accessToken
      const cfg = (await store().get(CONFIG_KEY)) || {};
      const clientId = cfg.clientId || process.env.STRAVA_CLIENT_ID;
      const clientSecret = cfg.clientSecret || process.env.STRAVA_CLIENT_SECRET;

      let token = conn.accessToken;
      // Refresh token if expired
      if (conn.expiresAt && Date.now() / 1000 > conn.expiresAt - 120) {
        try {
          const rf = await fetch('https://www.strava.com/oauth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              refresh_token: conn.refreshToken,
              grant_type: 'refresh_token'
            })
          });
          const rfData = await rf.json();
          if (rfData.access_token) {
            token = rfData.access_token;
            conn.accessToken = token;
            conn.refreshToken = rfData.refresh_token || conn.refreshToken;
            conn.expiresAt = rfData.expires_at;
          }
        } catch {}
      }

      // Fetch last 30 activities
      const actResp = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=30', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!actResp.ok) {
        return secure(j(actResp.status, { ok: false, error: 'strava-api-error' }));
      }
      const rawActs = await actResp.json();
      const filtered = Array.isArray(rawActs)
        ? rawActs.filter(a => a.type === 'Run' || a.type === 'TrailRun' || a.type === 'Walk')
        : [];

      activities = filtered.map(a => {
        const km = +(a.distance / 1000).toFixed(2);
        const min = Math.max(1, Math.round((a.moving_time || a.elapsed_time || 0) / 60));
        const elev = Math.round(a.total_elevation_gain || 0);
        const dt = String(a.start_date_local || a.start_date || new Date().toISOString()).slice(0, 10);
        let kind = 'easy';
        if (a.type === 'TrailRun' || km >= 18) kind = 'long';
        else if (a.average_speed > 3.7) kind = 'hi';

        return {
          id: 'strava_' + a.id,
          cid: cid ? +cid : (conn.cid ? +conn.cid : 1),
          name: a.name || 'Strava Activity',
          km: km,
          min: min,
          elev: elev,
          rpe: a.average_heartrate ? (a.average_heartrate > 165 ? 8 : (a.average_heartrate > 150 ? 7 : 5)) : 6,
          kind: kind,
          date: dt,
          splits: ''
        };
      });
    }

    conn.lastSync = new Date().toISOString();
    conn.importedCount = (conn.importedCount || 0) + activities.length;
    await store().setJSON(connKey, conn);
    if (!cid) await store().setJSON(CONN_KEY, conn);

    return secure(j(200, {
      ok: true,
      count: activities.length,
      activities: activities,
      lastSync: conn.lastSync,
      cid: cid || conn.cid || ''
    }));
  }

  // 6. DISCONNECT (Per-Athlete Disconnect)
  if (sub === 'disconnect') {
    let cid = url.searchParams.get('cid') || '';
    if (method === 'POST') {
      try {
        const { data } = await readJsonCapped(req);
        if (data && data.cid) cid = String(data.cid);
      } catch (_) {}
    }
    const connKey = athleteConnKey(cid);
    await store().delete(connKey);
    if (!cid) await store().delete(CONN_KEY);
    return secure(j(200, { ok: true, connected: false, cid }));
  }

  return secure(j(404, { ok: false, error: 'not-found' }));
}

export const config = { path: '/api/strava/*' };

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
