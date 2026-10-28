
// /api/testi  — Vercel Serverless Function
// Penyimpanan: Upstash Redis (REST). Tidak perlu install package apa pun.
//
// Environment Variables yang dibutuhkan (Vercel > Settings > Environment Variables):
//   ADMIN_PASSWORD            -> password untuk halaman admin testi
//   UPSTASH_REDIS_REST_URL    -> (atau KV_REST_API_URL)
//   UPSTASH_REDIS_REST_TOKEN  -> (atau KV_REST_API_TOKEN)

const crypto = require('crypto');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const KEY = 'vv_testi';
const MAX_ITEMS = 200;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || 'Redis error');
  return d.result;
}

async function readItems() {
  const raw = await redis(['GET', KEY]);
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeItems(items) {
  await redis(['SET', KEY, JSON.stringify(items)]);
}

function isAdmin(req) {
  const given = String(req.headers['x-admin-password'] || '');
  const real = String(process.env.ADMIN_PASSWORD || '');
  if (!real) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

function isHttp(u) {
  return /^https?:\/\/[^\s]+$/i.test(u || '');
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Database belum dikonfigurasi (env Upstash/KV belum diisi).' });
  }

  try {
    // ===== PUBLIK: ambil daftar testimoni =====
    if (req.method === 'GET') {
      const items = await readItems();
      return res.status(200).json({ ok: true, items });
    }

    // ===== ADMIN =====
    if (req.method === 'POST' || req.method === 'DELETE') {
      if (!isAdmin(req)) {
        return res.status(401).json({ ok: false, error: 'Password admin salah.' });
      }
      const body = parseBody(req);

      // cek login saja
      if (req.method === 'POST' && body.action === 'check') {
        return res.status(200).json({ ok: true });
      }

      // tambah testimoni
      if (req.method === 'POST') {
        const foto = String(body.foto || '').trim();
        const judul = String(body.judul || '').trim().slice(0, 120);
        if (!isHttp(foto)) return res.status(400).json({ ok: false, error: 'URL foto harus diawali http:// atau https://' });
        if (!judul) return res.status(400).json({ ok: false, error: 'Judul testi wajib diisi.' });

        const items = await readItems();
        if (items.length >= MAX_ITEMS) return res.status(400).json({ ok: false, error: 'Maksimal ' + MAX_ITEMS + ' testimoni.' });

        const item = { id: crypto.randomUUID(), foto, judul, createdAt: Date.now() };
        items.unshift(item); // terbaru di atas
        await writeItems(items);
        return res.status(200).json({ ok: true, item, items });
      }

      // hapus testimoni
      if (req.method === 'DELETE') {
        const id = String(body.id || '');
        const items = (await readItems()).filter(t => t.id !== id);
        await writeItems(items);
        return res.status(200).json({ ok: true, items });
      }
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ ok: false, error: 'Method tidak diizinkan.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + e.message });
  }
};
