
const crypto = require('crypto');

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const KEY = 'vv_testi';
const MAX_ITEMS = 200;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cmd)
  });

  const d = await r.json();

  if (!r.ok || d.error) {
    throw new Error(d.error || 'Redis error');
  }

  return d.result;
}

async function readItems() {
  const raw = await redis(['GET', KEY]);

  try {
    const items = JSON.parse(raw || '[]');
    return Array.isArray(items) ? items : [];
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

function isHttp(url) {
  return /^https?:\/\/[^\s]+$/i.test(url || '');
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  try {
    return JSON.parse(req.body || '{}');
  } catch {
    return {};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: 'Database belum dikonfigurasi. Periksa environment variable Upstash/KV.'
    });
  }

  try {
    // PUBLIK: mengambil daftar testimoni
    if (req.method === 'GET') {
      const items = await readItems();
      return res.status(200).json({ ok: true, items });
    }

    // ADMIN: tambah, edit, dan hapus
    if (['POST', 'DELETE'].includes(req.method)) {
      if (!isAdmin(req)) {
        return res.status(401).json({
          ok: false,
          error: 'Password admin salah.'
        });
      }

      const body = parseBody(req);

      // Memeriksa password admin
      if (req.method === 'POST' && body.action === 'check') {
        return res.status(200).json({ ok: true });
      }

      // EDIT testimoni yang sudah ada
      if (req.method === 'POST' && body.action === 'edit') {
        const id = String(body.id || '').trim();
        const foto = String(body.foto || '').trim();
        const judul = String(body.judul || '').trim().slice(0, 120);

        if (!id) {
          return res.status(400).json({
            ok: false,
            error: 'ID testimoni tidak valid.'
          });
        }

        if (!isHttp(foto)) {
          return res.status(400).json({
            ok: false,
            error: 'URL foto harus diawali http:// atau https://'
          });
        }

        if (!judul) {
          return res.status(400).json({
            ok: false,
            error: 'Judul testi wajib diisi.'
          });
        }

        const items = await readItems();
        const index = items.findIndex(item => item.id === id);

        if (index === -1) {
          return res.status(404).json({
            ok: false,
            error: 'Testimoni tidak ditemukan.'
          });
        }

        // Mengubah foto dan judul tanpa mengganti ID
        items[index] = {
          ...items[index],
          foto,
          judul
        };

        await writeItems(items);

        return res.status(200).json({
          ok: true,
          message: 'Testimoni berhasil diperbarui.',
          items
        });
      }

      // TAMBAH testimoni baru
      if (req.method === 'POST') {
        const foto = String(body.foto || '').trim();
        const judul = String(body.judul || '').trim().slice(0, 120);

        if (!isHttp(foto)) {
          return res.status(400).json({
            ok: false,
            error: 'URL foto harus diawali http:// atau https://'
          });
        }

        if (!judul) {
          return res.status(400).json({
            ok: false,
            error: 'Judul testi wajib diisi.'
          });
        }

        const items = await readItems();

        if (items.length >= MAX_ITEMS) {
          return res.status(400).json({
            ok: false,
            error: 'Maksimal ' + MAX_ITEMS + ' testimoni.'
          });
        }

        const item = {
          id: crypto.randomUUID(),
          foto,
          judul,
          createdAt: Date.now()
        };

        items.unshift(item);
        await writeItems(items);

        return res.status(200).json({
          ok: true,
          item,
          items
        });
      }

      // HAPUS testimoni
      if (req.method === 'DELETE') {
        const body = parseBody(req);
        const id = String(body.id || '');

        if (!id) {
          return res.status(400).json({
            ok: false,
            error: 'ID testimoni tidak valid.'
          });
        }

        const items = await readItems();
        const filtered = items.filter(item => item.id !== id);

        if (filtered.length === items.length) {
          return res.status(404).json({
            ok: false,
            error: 'Testimoni tidak ditemukan.'
          });
        }

        await writeItems(filtered);

        return res.status(200).json({
          ok: true,
          items: filtered
        });
      }
    }

    res.setHeader('Allow', 'GET, POST, DELETE');

    return res.status(405).json({
      ok: false,
      error: 'Method tidak diizinkan.'
    });
  } catch (e) {
    console.error('API testi error:', e);

    return res.status(500).json({
      ok: false,
      error: 'Terjadi kesalahan server atau database.'
    });
  }
};
