const { Redis } = require('@upstash/redis');
const fs = require('fs');
const path = require('path');
const redis = Redis.fromEnv();

module.exports = async (req, res) => {
  let html = null;
  try { html = await redis.get('site:html'); } catch (e) {}
  if (!html) html = fs.readFileSync(path.join(process.cwd(), 'default.html'), 'utf8');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=30');
  res.status(200).send(html);
};
