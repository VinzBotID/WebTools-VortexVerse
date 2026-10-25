const { Redis } = require('@upstash/redis');
const redis = Redis.fromEnv();

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.ADMIN_PASSWORD}`)
    return res.status(401).json({ error: 'Password salah' });

  if (req.method === 'GET') {
    const html = await redis.get('site:html');
    return res.json({ html: html || '' });
  }
  if (req.method === 'POST') {
    const { html } = req.body || {};
    if (typeof html !== 'string' || html.length < 20)
      return res.status(400).json({ error: 'HTML kosong/tidak valid' });
    const old = await redis.get('site:html');
    if (old) await redis.set('site:html:backup', old); // cadangan 1 versi
    await redis.set('site:html', html);
    return res.json({ ok: true });
  }
  res.status(405).end();
};
