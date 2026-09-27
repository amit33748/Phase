// Smoke tests against a running API: node test/api.test.js [baseUrl]
const assert = require('assert');

const BASE = process.argv[2] || process.env.API || 'http://localhost:3002/api';
const POLY = [[76.68, 30.63], [76.72, 30.63], [76.72, 30.67], [76.68, 30.67]];

async function get(path, opts) {
  const t = Date.now();
  const r = await fetch(`${BASE}${path}`, opts);
  return { r, ms: Date.now() - t };
}
const post = (path, body) => get(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const tests = {
  async health() {
    const { r } = await get('/health');
    assert.strictEqual((await r.json()).ok, true);
  },
  async meta() {
    const m = await (await get('/meta')).r.json();
    assert.strictEqual(m.epochs, m.dates.length);
    assert.ok(m.count > 0 && m.refCandidates.length > 0);
  },
  async baseBufferGzip() {
    const { r } = await get('/web/base.arrow', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.strictEqual(r.status, 200);
    assert.ok(Number(r.headers.get('x-raw-length')) > 0);
  },
  async rejectsPathTraversal() {
    const { r } = await get('/web/..%2Fmeta.json');
    assert.ok(r.status === 400 || r.status === 404);
  },
  async point() {
    const { r, ms } = await get('/points/1000?ctx=100');
    const p = await r.json();
    assert.strictEqual(p.pid, 1000);
    assert.strictEqual(p.series.length, 34);
    assert.ok(Number.isFinite(p.fit.vel));
    return `${ms} ms`;
  },
  async pointOutOfRange() {
    assert.strictEqual((await get('/points/999999999')).r.status, 400);
  },
  async ts() {
    const { r } = await get('/ts?r=0-9,100-109');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(buf.length, 20 * 34 * 2);
    assert.strictEqual((await get('/ts?r=10-5')).r.status, 400);
  },
  async region() {
    const { r, ms } = await post('/region', { polygon: POLY });
    const j = await r.json();
    assert.ok(j.n > 0 && j.p50.length === 34 && j.top.length > 0);
    return `${ms} ms, n=${j.n}`;
  },
  async regionRejectsBadInput() {
    assert.strictEqual((await post('/region', { polygon: [[0, 0], ["x'); DROP", 1], [1, 1]] })).r.status, 400);
  },
  async profile() {
    const j = await (await post('/profile', { line: [[76.62, 30.64], [76.86, 30.69]], width: 60 })).r.json();
    assert.ok(j.n > 0 && j.s.length === j.n);
  },
  async exportCsv() {
    const text = await (await post('/export', { polygon: POLY })).r.text();
    assert.ok(text.startsWith('pid,lon,lat'));
  }
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      const note = await fn();
      console.log(`  ✓ ${name}${note ? ` (${note})` : ''}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: ${e.message}`);
    }
  }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
