import { RecordBatchReader, tableFromIPC } from 'apache-arrow';

export const API = (import.meta.env.VITE_API_ROOT as string) || '/api';

export interface RefCandidate {
  h3: string; lon: number; lat: number; n: number; vel_mean: number; vel_std: number;
  rmse_mean: number; seas_mean: number; accel_abs_mean: number; score: number; series: number[];
}

export interface Meta {
  count: number; epochs: number; dates: string[]; t: number[]; tc: number;
  bbox: [number, number, number, number];
  heading_deg: number; look_azimuth_deg: number; incidence_default_deg: number; wavelength_mm: number;
  master_estimate: string; disp_scale: number; vel_scale: number; accel_scale: number; seas_scale: number;
  stats: Record<string, Record<string, number>>;
  vel_hist: { edges: number[]; counts: number[] };
  hex: Record<string, number>;
  duplicates: number;
  events: { date: string; label: string }[];
  refCandidates: RefCandidate[];
}

/** Resident GPU buffers for every scatterer, index = pid. */
export interface Base {
  n: number;
  loaded: number;
  positions: Float32Array; // [lon, lat] × n
  vel: Float32Array;
  accel: Float32Array;
  seas: Float32Array;
  quality: Float32Array;
  dup: Uint8Array;
  filter: Float32Array; // [vel, quality] × n  (DataFilterExtension)
}

export interface HexCell {
  h3: string; n: number; vel: number; p10: number; p90: number; std: number;
  accel: number; seas: number; rmse: number; quality: number; i: number;
}
export interface HexSet { res: number; cells: HexCell[]; series: Int16Array; epochs: number }

export async function fetchMeta(): Promise<Meta> {
  let r = await fetch(`${API}/meta`);
  let text = '';
  if (!r.ok || r.headers.get('content-type')?.includes('text/html')) {
    const r2 = await fetch(`${API}/meta.json`);
    if (r2.ok) r = r2;
  }
  text = await r.text();
  if (text.trim().startsWith('<')) {
    const r3 = await fetch('/api/meta.json');
    if (r3.ok) return r3.json();
    throw new Error('API returned HTML instead of JSON. Ensure backend is running or static data is deployed.');
  }
  return JSON.parse(text);
}

/**
 * Streams base.arrow record batch by record batch. Batches are in Hilbert order, so each one fills
 * a spatially coherent patch of the map; `onBatch` fires after each so the map can redraw.
 */
export async function loadBase(meta: Meta, onBatch: (b: Base, fraction: number) => void): Promise<Base> {
  const n = meta.count;
  const base: Base = {
    n, loaded: 0,
    positions: new Float32Array(2 * n), vel: new Float32Array(n), accel: new Float32Array(n),
    seas: new Float32Array(n), quality: new Float32Array(n), dup: new Uint8Array(n), filter: new Float32Array(2 * n)
  };
  const res = await fetch(`${API}/web/base.arrow`);
  if (!res.ok || !res.body) throw new Error(`base.arrow ${res.status}`);
  const reader = await RecordBatchReader.from(res.body as any);
  let ilon = 0;
  let ilat = 0;
  const vs = 1 / meta.vel_scale;
  const as = 1 / meta.accel_scale;
  const ss = 1 / meta.seas_scale;
  for await (const batch of reader as any) {
    const dlon = batch.getChild('dlon').toArray() as Int32Array;
    const dlat = batch.getChild('dlat').toArray() as Int32Array;
    const vel = batch.getChild('vel').toArray() as Int16Array;
    const accel = batch.getChild('accel').toArray() as Int16Array;
    const seas = batch.getChild('seas').toArray() as Uint8Array;
    const q = batch.getChild('quality').toArray() as Uint8Array;
    const dup = batch.getChild('dup').toArray() as Uint8Array;
    const off = base.loaded;
    for (let i = 0; i < dlon.length; i++) {
      const j = off + i;
      ilon += dlon[i];
      ilat += dlat[i];
      base.positions[2 * j] = ilon * 1e-5;
      base.positions[2 * j + 1] = ilat * 1e-5;
      const v = vel[i] * vs;
      base.vel[j] = v;
      base.accel[j] = accel[i] * as;
      base.seas[j] = seas[i] * ss;
      base.quality[j] = q[i];
      base.filter[2 * j] = v;
      base.filter[2 * j + 1] = q[i];
    }
    base.dup.set(dup, off);
    base.loaded = off + dlon.length;
    onBatch(base, base.loaded / n);
    await new Promise((r) => setTimeout(r, 0)); // let the map paint between batches
  }
  return base;
}

const hexCache = new Map<number, Promise<HexSet>>();

export function loadHex(res: number): Promise<HexSet> {
  if (!hexCache.has(res)) {
    hexCache.set(res, (async () => {
      const r = await fetch(`${API}/web/hex_r${res}.arrow`);
      const table = tableFromIPC(new Uint8Array(await r.arrayBuffer()));
      const col = (k: string) => table.getChild(k)!.toArray();
      const h3 = table.getChild('h3')!.toArray() as string[];
      const n = col('n'); const vel = col('vel_mean'); const p10 = col('vel_p10'); const p90 = col('vel_p90');
      const std = col('vel_std'); const accel = col('accel_mean'); const seas = col('seas_mean');
      const rmse = col('rmse_mean'); const quality = col('quality_mean');
      const seriesVec = table.getChild('series')!;
      const epochs = (seriesVec.type as any).listSize as number;
      const series = new Int16Array(table.numRows * epochs);
      let o = 0;
      for (const chunk of seriesVec.data) {
        const vals = chunk.children[0].values as Int16Array;
        const start = chunk.offset * epochs;
        series.set(vals.subarray(start, start + chunk.length * epochs), o);
        o += chunk.length * epochs;
      }
      const cells: HexCell[] = new Array(table.numRows);
      for (let i = 0; i < table.numRows; i++) {
        cells[i] = { h3: String(h3[i]), n: n[i], vel: vel[i], p10: p10[i], p90: p90[i], std: std[i], accel: accel[i],
          seas: seas[i], rmse: rmse[i], quality: quality[i], i };
      }
      return { res, cells, series, epochs };
    })());
  }
  return hexCache.get(res)!;
}

export interface PointRecord {
  pid: number; lon: number; lat: number; series: number[];
  fit: { c0: number; vel: number; accel: number; seas_sin: number; seas_cos: number; tc: number };
  vel_avg: number; vel_sigma: number; vel_recent: number; seas_amp: number; seas_peak_doy: number;
  rmse: number; r2: number; disp_total: number; jump_max: number; n_outliers: number; quality: number; dup_n: number;
  duplicates?: { pid: number; vel_avg: number }[];
  context?: { radius: number; n: number; p10?: number[]; p50?: number[]; p90?: number[] };
}

const pointCache = new Map<number, Promise<PointRecord>>();
export function fetchPoint(pid: number): Promise<PointRecord> {
  if (!pointCache.has(pid)) {
    const p = fetch(`${API}/points/${pid}?ctx=100`).then((r) => {
      if (!r.ok) throw new Error(`point ${r.status}`);
      return r.json();
    });
    p.catch(() => pointCache.delete(pid));
    pointCache.set(pid, p);
  }
  return pointCache.get(pid)!;
}

/** Measured displacement for the scatterers in a viewport, re-arranged epoch-major on arrival. */
export interface TsSubset {
  n: number;
  pids: Uint32Array;
  positions: Float32Array;
  vel: Float32Array;
  filter: Float32Array;
  epochs: Float32Array[]; // E arrays of n values: displacement (mm) re-based to epoch `basis`
  basis: number;
  bounds: [number, number, number, number];
}

export const MAX_TS_POINTS = 850_000;

/** pid ranges of points inside bounds (Hilbert order keeps them few), merging small gaps. */
export function visibleRanges(base: Base, b: [number, number, number, number], maxRanges = 400) {
  const [x0, y0, x1, y1] = b;
  const pos = base.positions;
  const hits: number[] = [];
  for (let i = 0; i < base.loaded; i++) {
    const x = pos[2 * i];
    const y = pos[2 * i + 1];
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) hits.push(i);
  }
  if (!hits.length) return { ranges: [] as [number, number][], count: 0, inView: 0 };
  let gap = 64;
  let ranges: [number, number][] = [];
  for (;;) {
    ranges = [];
    let a = hits[0];
    let prev = hits[0];
    for (let k = 1; k < hits.length; k++) {
      if (hits[k] - prev > gap) { ranges.push([a, prev]); a = hits[k]; }
      prev = hits[k];
    }
    ranges.push([a, prev]);
    if (ranges.length <= maxRanges) break;
    gap *= 2;
  }
  const count = ranges.reduce((s, [a, c]) => s + c - a + 1, 0);
  return { ranges, count, inView: hits.length };
}

export async function fetchTs(meta: Meta, base: Base, ranges: [number, number][], basis: number,
  bounds: [number, number, number, number], signal?: AbortSignal): Promise<TsSubset> {
  const r = await fetch(`${API}/ts?r=${ranges.map(([a, b]) => `${a}-${b}`).join(',')}`, { signal });
  if (!r.ok) throw new Error(`ts ${r.status}`);
  const raw = new Int16Array(await r.arrayBuffer());
  const E = meta.epochs;
  const n = raw.length / E;
  const pids = new Uint32Array(n);
  let k = 0;
  for (const [a, b] of ranges) for (let p = a; p <= b; p++) pids[k++] = p;
  const positions = new Float32Array(2 * n);
  const vel = new Float32Array(n);
  const filter = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const p = pids[i];
    positions[2 * i] = base.positions[2 * p];
    positions[2 * i + 1] = base.positions[2 * p + 1];
    vel[i] = base.vel[p];
    filter[2 * i] = base.filter[2 * p];
    filter[2 * i + 1] = base.filter[2 * p + 1];
  }
  const s = 1 / meta.disp_scale;
  const epochs: Float32Array[] = [];
  for (let e = 0; e < E; e++) epochs.push(new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const row = i * E;
    const b0 = raw[row + basis];
    for (let e = 0; e < E; e++) epochs[e][i] = (raw[row + e] - b0) * s;
  }
  return { n, pids, positions, vel, filter, epochs, basis, bounds };
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

export async function downloadCsv(polygon: number[][]) {
  const r = await fetch(`${API}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ polygon }) });
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'phase_region.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
