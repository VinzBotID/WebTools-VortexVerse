
const { Redis } = require('@upstash/redis');
const fs = require('fs');
const path = require('path');

const redis = Redis.fromEnv();

module.exports = async (req, res) => {
  try {
    let html = null;

    try {
      html = await redis.get('site:html');
    } catch (error) {
      console.error('Gagal membaca HTML dari Redis:', error);
    }

    if (typeof html !== 'string' || html.length < 20) {
      html = fs.readFileSync(
        path.join(process.cwd(), 'default.html'),
        'utf8'
      );
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate'
    );

    return res.status(200).send(html);
  } catch (error) {
    console.error('Gagal memuat HTML:', error);
    return res.status(500).send('Gagal memuat halaman website.');
  }
};
