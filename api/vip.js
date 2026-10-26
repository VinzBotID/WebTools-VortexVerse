const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
  automaticDeserialization: false,
});

const USERS = 'vip:users';
const SESSION_MAX = 24 * 60 * 60; // detik

function adminOk(input) {
  const real = process.env.ADMIN_PASSWORD || '';
  if (!real || typeof input !== 'string') return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

function hashPw(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString('hex');
}

function cleanName(n) {
  return String(n || '').trim().toLowerCase();
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const action = body.action;

  try {
    // ---------- LOGIN ----------
    if (action === 'login') {
      const ip = (req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
      const rlKey = 'vip:rl:' + ip;
      const tries = await redis.incr(rlKey);
      if (tries === 1) await redis.expire(rlKey, 600);
      if (tries > 10) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi 10 menit lagi.' });

      const username = cleanName(body.username);
      const password = String(body.password || '');
      const raw = username ? await redis.hget(USERS, username) : null;
      const bad = () => res.status(401).json({ error: 'Username atau password salah.' });
      if (!raw) return bad();

      const u = JSON.parse(raw);
      const test = Buffer.from(hashPw(password, u.salt), 'hex');
      const real = Buffer.from(u.hash, 'hex');
      if (test.length !== real.length || !crypto.timingSafeEqual(test, real)) return bad();

      if (u.expiresAt && Date.now() > u.expiresAt) {
        return res.status(403).json({ error: 'Masa aktif VIP sudah habis.' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      let ttl = SESSION_MAX;
      if (u.expiresAt) ttl = Math.max(60, Math.min(SESSION_MAX, Math.floor((u.expiresAt - Date.now()) / 1000)));
      await redis.set('vip:sess:' + token, JSON.stringify({ username: u.username }), { ex: ttl });
      await redis.del(rlKey);
      return res.json({ token, username: u.username, expiresAt: u.expiresAt || Date.now() + SESSION_MAX * 1000 });
    }

    // ---------- CEK SESI ----------
    if (action === 'session') {
      const token = String(body.token || '');
      if (!/^[a-f0-9]{64}$/.test(token)) return res.json({ valid: false });
      const s = await redis.get('vip:sess:' + token);
      if (!s) return res.json({ valid: false });
      const { username } = JSON.parse(s);
      const raw = await redis.hget(USERS, cleanName(username));
      if (!raw) return res.json({ valid: false });
      const u = JSON.parse(raw);
      if (u.expiresAt && Date.now() > u.expiresAt) return res.json({ valid: false });
      return res.json({ valid: true, username: u.username, expiresAt: u.expiresAt || Date.now() + SESSION_MAX * 1000 });
    }

    // ---------- ADMIN ----------
    if (action === 'admin_list' || action === 'admin_add' || action === 'admin_delete') {
      if (!adminOk(body.adminPassword)) return res.status(401).json({ error: 'Password admin salah' });

      if (action === 'admin_list') {
        const all = (await redis.hgetall(USERS)) || {};
        const users = Object.values(all).map((r) => {
          const u = JSON.parse(r);
          return { username: u.username, expiresAt: u.expiresAt };
        });
        return res.json({ users });
      }

      const username = cleanName(body.username);
      if (!/^[a-z0-9_]{3,32}$/.test(username)) {
        return res.status(400).json({ error: 'Username 3-32 karakter: huruf kecil, angka, underscore.' });
      }

      if (action === 'admin_delete') {
        await redis.hdel(USERS, username);
        return res.json({ ok: true });
      }

      const password = String(body.password || '');
      const days = Number(body.days);
      if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter.' });
      if (!(days > 0 && days <= 3650)) return res.status(400).json({ error: 'Durasi harus 1-3650 hari.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        username,
        salt,
        hash: hashPw(password, salt),
        expiresAt: Date.now() + days * 86400000,
      };
      await redis.hset(USERS, { [username]: JSON.stringify(user) });
      return res.json({ ok: true, expiresAt: user.expiresAt });
    }

    return res.status(400).json({ error: 'Action tidak dikenal' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
};
