const fs = require('fs');
const path = require('path');
const express = require('express');
const { DATA } = require('./db');

const WEB = path.join(DATA, 'web');
const MAX_TS_POINTS = 900_000;
const MAX_EXPORT_ROWS = 200_000;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;

class Lru {
  constructor(limit) { this.limit = limit; this.map = new Map(); }
  get(k) {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k, v) {
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const bad = (res, msg) => res.status(400).json({ error: msg });

function parseRing(body) {
  const ring = body && Array.isArray(body.polygon) ? body.polygon : null;
  if (!ring || ring.length < 3 || ring.length > 500) return null;
  const pts = ring.map((p) => [Number(p[0]), Number(p[1])]);
  if (pts.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90)) return null;
  const [fx, fy] = pts[0];
  const [lx, ly] = pts[pts.length - 1];
  if (fx !== lx || fy !== ly) pts.push([fx, fy]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    wkt: `POLYGON((${pts.map(([x, y]) => `${x} ${y}`).join(', ')}))`,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  };
}

function createRouter(pool) {
  const router = express.Router();
  const meta = JSON.parse(fs.readFileSync(path.join(WEB, 'meta.json'), 'utf8'));
  const refCandidates = JSON.parse(fs.readFileSync(path.join(WEB, 'ref_candidates.json'), 'utf8'));
  const E = meta.epochs;
  const epochCols = meta.dates.map((d) => `d_${d.replace(/-/g, '')}`);
  const first = epochCols[0];
  const pointCache = new Lru(2000);
  const dispFd = fs.openSync(path.join(WEB, meta.files.disp), 'r');

  router.get('/health', (req, res) => res.json({ ok: true, points: meta.count }));

  router.get('/meta', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ...meta, refCandidates });
  });

  // Browser buffers, pre-compressed by the ETL (Arrow JS cannot read compressed IPC bodies)
  router.get('/web/:name', (req, res) => {
    const { name } = req.params;
    if (!/^[a-z0-9_]+\.(arrow|json)$/.test(name)) return bad(res, 'bad file');
    const file = path.join(WEB, name);
    if (!fs.existsSync(file)) return res.sendStatus(404);
    const gz = `${file}.gz`;
    const type = name.endsWith('.arrow') ? 'application/vnd.apache.arrow.stream' : 'application/json';
    const stat = fs.statSync(file);
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) return res.sendStatus(304);
    res.set({ 'Content-Type': type, ETag: etag, 'Cache-Control': 'public, max-age=86400', 'X-Raw-Length': stat.size });
    if (fs.existsSync(gz) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.set({ 'Content-Encoding': 'gzip', 'Content-Length': fs.statSync(gz).size, Vary: 'Accept-Encoding' });
      return fs.createReadStream(gz).pipe(res);
    }
    res.set('Content-Length', stat.size);
    fs.createReadStream(file).pipe(res);
  });

  // Full record of one scatterer, plus the neighbourhood band (p10/p50/p90 of re-based series)
  router.get('/points/:pid', async (req, res, next) => {
    try {
      const pid = parseInt(req.params.pid, 10);
      if (!Number.isInteger(pid) || pid < 0 || pid >= meta.count) return bad(res, 'bad pid');
      const ctx = Math.min(Math.max(parseInt(req.query.ctx, 10) || 0, 0), 500);
      const key = `${pid}:${ctx}`;
      const hit = pointCache.get(key);
      if (hit) return res.json(hit);

      const rows = await pool.query('SELECT * EXCLUDE (geometry, bbox) FROM los WHERE pid = $1', [pid]);
      if (!rows.length) return res.sendStatus(404);
      const r = rows[0];
      const out = {
        pid, lon: num(r.lon), lat: num(r.lat),
        series: epochCols.map((c) => num(r[c])),
        fit: {
          c0: num(r.c0), vel: num(r.vel), accel: num(r.accel), seas_sin: num(r.seas_sin), seas_cos: num(r.seas_cos),
          tc: meta.tc
        }
      };
      for (const k of ['vel_avg', 'vel_sigma', 'vel_recent', 'seas_amp', 'seas_peak_doy', 'rmse', 'r2',
        'disp_total', 'jump_max', 'n_outliers', 'quality', 'dup_n']) out[k] = num(r[k]);

      if (out.dup_n > 1) {
        const dups = await pool.query(
          'SELECT pid, vel_avg FROM los WHERE lon = $1 AND lat = $2 ORDER BY pid', [out.lon, out.lat]);
        out.duplicates = dups.map((d) => ({ pid: num(d.pid), vel_avg: num(d.vel_avg) }));
      }

      if (ctx > 0) {
        const dLat = ctx / M_PER_DEG_LAT;
        const kLon = M_PER_DEG_LON_EQ * Math.cos((out.lat * Math.PI) / 180);
        const dLon = ctx / kLon;
        const q = epochCols.map((c) => `quantile_cont(${c} - ${first}, [0.1, 0.5, 0.9])`).join(', ');
        const [band] = await pool.query(`
          SELECT count(*) AS n, [${q}] AS q FROM los
          WHERE lon BETWEEN $1 AND $2 AND lat BETWEEN $3 AND $4 AND pid <> $5
            AND pow((lon - $6) * ${kLon}, 2) + pow((lat - $7) * ${M_PER_DEG_LAT}, 2) <= ${ctx * ctx}`,
        [out.lon - dLon, out.lon + dLon, out.lat - dLat, out.lat + dLat, pid, out.lon, out.lat]);
        const n = num(band.n);
        out.context = n >= 3
          ? { radius: ctx, n, p10: band.q.map((v) => v[0]), p50: band.q.map((v) => v[1]), p90: band.q.map((v) => v[2]) }
          : { radius: ctx, n };
      }
      pointCache.set(key, out);
      res.json(out);
    } catch (err) { next(err); }
  });

  // Point-major int16 displacement for pid ranges: ?r=0-1000,5000-9000 → Int16[n × E] (mm × disp_scale)
  router.get('/ts', (req, res) => {
    const spec = String(req.query.r || '');
    if (!/^\d+-\d+(,\d+-\d+)*$/.test(spec)) return bad(res, 'bad ranges');
    const ranges = spec.split(',').map((s) => s.split('-').map(Number));
    let total = 0;
    let prevEnd = -1;
    for (const [a, b] of ranges) {
      if (a > b || a <= prevEnd || b >= meta.count) return bad(res, 'ranges must be sorted and within bounds');
      prevEnd = b;
      total += b - a + 1;
    }
    if (total > MAX_TS_POINTS) return bad(res, `too many points (${total} > ${MAX_TS_POINTS})`);
    const bytesPer = E * 2;
    const buf = Buffer.allocUnsafe(total * bytesPer);
    let off = 0;
    for (const [a, b] of ranges) {
      const len = (b - a + 1) * bytesPer;
      fs.readSync(dispFd, buf, off, len, a * bytesPer);
      off += len;
    }
    res.set({ 'Content-Type': 'application/octet-stream', 'X-Points': total, 'Cache-Control': 'no-store' });
    res.end(buf);
  });

  // Polygon statistics: counts, histogram, median series with p10–p90 band, fastest points
  router.post('/region', async (req, res, next) => {
    try {
      const ring = parseRing(req.body);
      if (!ring) return bad(res, 'polygon must be [[lon, lat], …] with 3–500 vertices');
      const [x0, y0, x1, y1] = ring.bbox;
      const where = `lon BETWEEN ${x0} AND ${x1} AND lat BETWEEN ${y0} AND ${y1}
        AND ST_Contains(ST_GeomFromText('${ring.wkt}'), ST_Point(lon, lat))`;
      const q = epochCols.map((c) => `quantile_cont(${c} - ${first}, [0.1, 0.5, 0.9])`).join(', ');
      const [[s], hist, top] = await Promise.all([
        pool.query(`
          SELECT count(*) AS n, avg(vel_avg) AS vel_mean, median(vel_avg) AS vel_median,
                 min(vel_avg) AS vel_min, max(vel_avg) AS vel_max, stddev_samp(vel_avg) AS vel_std,
                 avg(accel) AS accel_mean, avg(seas_amp) AS seas_mean, avg(rmse) AS rmse_mean,
                 count(*) FILTER (WHERE vel_avg < -10) AS n_fast_away,
                 count(*) FILTER (WHERE vel_avg > 10) AS n_fast_toward,
                 [${q}] AS q
          FROM los WHERE ${where}`),
        pool.query(`SELECT floor(greatest(least(vel_avg, 24.99), -59.99))::INT AS b, count(*) AS n
                    FROM los WHERE ${where} GROUP BY 1 ORDER BY 1`),
        pool.query(`SELECT pid, lon, lat, vel_avg, accel FROM los WHERE ${where} ORDER BY vel_avg LIMIT 20`)
      ]);
      const n = num(s.n);
      const out = { n, polygon: req.body.polygon };
      if (n > 0) {
        for (const k of ['vel_mean', 'vel_median', 'vel_min', 'vel_max', 'vel_std', 'accel_mean', 'seas_mean',
          'rmse_mean', 'n_fast_away', 'n_fast_toward']) out[k] = num(s[k]);
        out.p10 = s.q.map((v) => v[0]);
        out.p50 = s.q.map((v) => v[1]);
        out.p90 = s.q.map((v) => v[2]);
        out.hist = hist.map((h) => [num(h.b), num(h.n)]);
        out.top = top.map((t) => ({ pid: num(t.pid), lon: num(t.lon), lat: num(t.lat), vel: num(t.vel_avg), accel: num(t.accel) }));
      }
      res.json(out);
    } catch (err) { next(err); }
  });

  // Cross-section: points within `width` metres of segment a→b, projected onto it
  router.post('/profile', async (req, res, next) => {
    try {
      const line = req.body && req.body.line;
      const width = Math.min(Math.max(Number(req.body && req.body.width) || 50, 5), 1000);
      if (!Array.isArray(line) || line.length !== 2) return bad(res, 'line must be [[lon, lat], [lon, lat]]');
      const [[ax, ay], [bx, by]] = line.map((p) => p.map(Number));
      if (![ax, ay, bx, by].every(Number.isFinite)) return bad(res, 'bad coordinates');
      const lat0 = (ay + by) / 2;
      const kx = M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180);
      const ky = M_PER_DEG_LAT;
      const ux = (bx - ax) * kx;
      const uy = (by - ay) * ky;
      const L = Math.hypot(ux, uy);
      if (L < 10 || L > 100_000) return bad(res, 'profile length must be 10 m – 100 km');
      const padX = width / kx;
      const padY = width / ky;
      const rows = await pool.query(`
        WITH p AS (
          SELECT pid, vel_avg, quality,
                 ((lon - ${ax}) * ${kx} * ${ux} + (lat - ${ay}) * ${ky} * ${uy}) / ${L} AS s,
                 ((lon - ${ax}) * ${kx} * ${uy} - (lat - ${ay}) * ${ky} * ${ux}) / ${L} AS o
          FROM los
          WHERE lon BETWEEN ${Math.min(ax, bx) - padX} AND ${Math.max(ax, bx) + padX}
            AND lat BETWEEN ${Math.min(ay, by) - padY} AND ${Math.max(ay, by) + padY})
        SELECT pid, vel_avg, quality, s, o FROM p
        WHERE s BETWEEN 0 AND ${L} AND abs(o) <= ${width}
        ORDER BY s LIMIT 40000`);
      res.json({
        length: L, width, n: rows.length,
        pid: rows.map((r) => num(r.pid)), s: rows.map((r) => num(r.s)), o: rows.map((r) => num(r.o)),
        vel: rows.map((r) => num(r.vel_avg)), quality: rows.map((r) => num(r.quality))
      });
    } catch (err) { next(err); }
  });

  // CSV export of a polygon (all attributes + every epoch)
  router.post('/export', async (req, res, next) => {
    try {
      const ring = parseRing(req.body);
      if (!ring) return bad(res, 'bad polygon');
      const [x0, y0, x1, y1] = ring.bbox;
      const cols = ['pid', 'lon', 'lat', 'vel_avg', 'vel', 'vel_sigma', 'accel', 'seas_amp', 'rmse', 'r2', 'quality', ...epochCols];
      const rows = await pool.query(`
        SELECT ${cols.join(', ')} FROM los
        WHERE lon BETWEEN ${x0} AND ${x1} AND lat BETWEEN ${y0} AND ${y1}
          AND ST_Contains(ST_GeomFromText('${ring.wkt}'), ST_Point(lon, lat))
        ORDER BY pid LIMIT ${MAX_EXPORT_ROWS}`);
      res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="phase_export.csv"' });
      const header = cols.map((c) => (c.startsWith('d_') ? `${c.slice(2, 6)}-${c.slice(6, 8)}-${c.slice(8)}` : c));
      res.write(`${header.join(',')}\n`);
      for (const r of rows) res.write(`${cols.map((c) => r[c]).join(',')}\n`);
      res.end();
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createRouter };
