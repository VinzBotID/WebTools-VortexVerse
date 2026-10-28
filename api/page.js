
const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  try {
    const html = fs.readFileSync(
      path.join(process.cwd(), 'default.html'),
      'utf8'
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    return res.status(200).send(html);
  } catch (error) {
    console.error('Gagal membaca default.html:', error);
    return res.status(500).send('Gagal memuat halaman website.');
  }
};
