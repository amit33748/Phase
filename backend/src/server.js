const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { DuckPool } = require('./db');
const { createRouter } = require('./routes');

const PORT = parseInt(process.env.PORT, 10) || 3002;

async function main() {
  const t0 = Date.now();
  const pool = new DuckPool();
  await pool.init();

  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  // JSON only: buffers are pre-compressed on disk and /ts is binary
  app.use(compression({ filter: (req, res) => /json|csv/.test(String(res.getHeader('Content-Type') || '')) }));
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    const end = res.end;
    res.end = function (...args) {
      if (!res.headersSent) res.setHeader('Server-Timing', `app;dur=${Number(process.hrtime.bigint() - start) / 1e6}`);
      return end.apply(this, args);
    };
    next();
  });

  app.use('/api', createRouter(pool));

  // Production: serve the built frontend (npm --prefix frontend run build) from the same origin
  const dist = path.resolve(__dirname, '../../frontend/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { maxAge: '1h', index: 'index.html' }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(`[api] ${req.method} ${req.url}:`, err.message);
    res.status(500).json({ error: 'internal error' });
  });

  app.listen(PORT, () => console.log(`[PHASE] API on http://localhost:${PORT}/api (ready in ${Date.now() - t0} ms)`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
