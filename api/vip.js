/*
 * api/vip.js  -  Backend VIP (Vercel Serverless + Supabase)
 *
 * Environment Variables (Vercel -> Settings -> Environment Variables):
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key (JANGAN pernah ditaruh di HTML / repo)
 *   VIP_ADMIN_KEY         kata sandi admin VIP (buat panjang & acak)
 *
 * Semua request: POST /api/vip  dengan body JSON { action, ... }
 *   Publik : login, session, logout
 *   Admin  : admin_list, admin_create, admin_delete   (header Authorization: Bearer <VIP_ADMIN_KEY>)
 */
import crypto from 'node:crypto';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, VIP_ADMIN_KEY } = process.env;
const SESSION_DAYS = 30;

const scrypt = (pw, salt) =>
  new Promise((ok, no) => crypto.scrypt(pw, salt, 32, (e, k) => (e ? no(e) : ok(k))));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const normName = (s) => String(s || '').trim().toLowerCase();
const validName = (s) => /^[a-z0-9_.-]{3,24}$/.test(s);

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(await r.text());
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function findUser(name) {
  if (!validName(name)) return null;
  const rows = await sb(`vip_users?username=eq.${encodeURIComponent(name)}&select=*`);
  const u = rows && rows[0];
  if (!u) return null;
  if (u.expires_at && Date.now() > Date.parse(u.expires_at)) return null;
  return u;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !VIP_ADMIN_KEY)
    return res.status(500).json({ ok: false, error: 'Environment variable belum lengkap.' });

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }

  try {
    /* ---------- PUBLIK ---------- */
    if (b.action === 'login') {
      const name = normName(b.username);
      const u = await findUser(name);
      const salt = u ? Buffer.from(u.salt, 'base64') : Buffer.from('dummy-salt-value!');
      const hash = (await scrypt(String(b.password || ''), salt)).toString('base64');
      if (!u || !safeEq(hash, u.hash))
        return res.status(401).json({ ok: false, error: 'Username atau password salah.' });

      const token = crypto.randomBytes(32).toString('hex');
      await sb('vip_sessions', {
        method: 'POST',
        prefer: 'return=minimal',
        body: {
          token_hash: sha256(token),
          username: name,
          expires_at: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString()
        }
      });
      return res.json({ ok: true, token, username: name });
    }

    if (b.action === 'session') {
      const rows = await sb(`vip_sessions?token_hash=eq.${sha256(b.token)}&select=username,expires_at`);
      const s = rows && rows[0];
      if (!s || Date.now() > Date.parse(s.expires_at)) return res.status(401).json({ ok: false });
      const u = await findUser(s.username);          // akun dihapus / kedaluwarsa -> sesi ditolak
      if (!u) return res.status(401).json({ ok: false });
      return res.json({ ok: true, username: s.username });
    }

    if (b.action === 'logout') {
      if (b.token) await sb(`vip_sessions?token_hash=eq.${sha256(b.token)}`, { method: 'DELETE' });
      return res.json({ ok: true });
    }

    /* ---------- ADMIN ---------- */
    if (String(b.action).startsWith('admin_')) {
      const auth = req.headers.authorization || '';
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!safeEq(sha256(key), sha256(VIP_ADMIN_KEY)))
        return res.status(401).json({ ok: false, error: 'Admin key salah.' });

      if (b.action === 'admin_list') {
        const rows = await sb('vip_users?select=username,created_at,expires_at&order=created_at.desc');
        return res.json({
          ok: true,
          users: rows.map((r) => ({
            username: r.username,
            created: Date.parse(r.created_at),
            expires: r.expires_at ? Date.parse(r.expires_at) : 0
          }))
        });
      }

      if (b.action === 'admin_create') {
        const name = normName(b.username);
        const password = String(b.password || '');
        const days = Math.max(0, parseInt(b.days, 10) || 0);
        if (!validName(name))
          return res.status(400).json({ ok: false, error: 'Username 3-24 karakter: huruf kecil, angka, _ . -' });
        if (password.length < 6)
          return res.status(400).json({ ok: false, error: 'Password minimal 6 karakter.' });

        const salt = crypto.randomBytes(16);
        const expires = days ? Date.now() + days * 864e5 : 0;
        await sb('vip_users?on_conflict=username', {      // username sudah ada -> password & masa aktif ditimpa
          method: 'POST',
          prefer: 'resolution=merge-duplicates,return=minimal',
          body: {
            username: name,
            salt: salt.toString('base64'),
            hash: (await scrypt(password, salt)).toString('base64'),
            created_at: new Date().toISOString(),
            expires_at: expires ? new Date(expires).toISOString() : null
          }
        });
        await sb(`vip_sessions?username=eq.${encodeURIComponent(name)}`, { method: 'DELETE' }); // paksa login ulang
        return res.json({ ok: true, username: name, expires });
      }

      if (b.action === 'admin_delete') {
        const name = normName(b.username);
        if (!validName(name)) return res.status(400).json({ ok: false, error: 'Username tidak valid.' });
        await sb(`vip_users?username=eq.${encodeURIComponent(name)}`, { method: 'DELETE' });
        return res.json({ ok: true });
      }
    }

    return res.status(400).json({ ok: false, error: 'Action tidak dikenal.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
}
