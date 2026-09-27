import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { buildLayers, hexResForZoom, PHASE_PERIOD_MM } from './layers';
import { basisIndex, getState, useStore, verticalFactor, type Basemap, type State } from '../lib/store';
import { fetchPoint, fetchTs, loadHex, MAX_TS_POINTS, postJson, visibleRanges } from '../lib/data';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const BASEMAPS: Record<Basemap, { base: string; baseMax: number; labels: string | null; labelsMax: number }> = {
  dark: { base: 'Canvas/World_Dark_Gray_Base', baseMax: 16, labels: 'Canvas/World_Dark_Gray_Reference', labelsMax: 16 },
  light: { base: 'Canvas/World_Light_Gray_Base', baseMax: 16, labels: 'Canvas/World_Light_Gray_Reference', labelsMax: 16 },
  satellite: { base: 'World_Imagery', baseMax: 19, labels: 'Reference/World_Boundaries_and_Places', labelsMax: 19 },
  topo: { base: 'World_Topo_Map', baseMax: 17, labels: null, labelsMax: 0 }
};

function style(): maplibregl.StyleSpecification {
  const sources: Record<string, any> = {};
  const layers: any[] = [];
  for (const [id, b] of Object.entries(BASEMAPS)) {
    sources[`bm-${id}`] = { type: 'raster', tiles: [`${ESRI}/${b.base}/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: b.baseMax, attribution: '© Esri' };
    layers.push({ id: `bm-${id}`, type: 'raster', source: `bm-${id}`, layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 150 } });
  }
  layers.push({ id: 'labels', type: 'background', paint: { 'background-opacity': 0 } }); // deck layers go below this
  for (const [id, b] of Object.entries(BASEMAPS)) {
    if (!b.labels) continue;
    sources[`lb-${id}`] = { type: 'raster', tiles: [`${ESRI}/${b.labels}/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: b.labelsMax };
    layers.push({ id: `lb-${id}`, type: 'raster', source: `lb-${id}`, layout: { visibility: 'none' } });
  }
  return { version: 8, sources, layers };
}

function applyBasemap(map: maplibregl.Map, bm: Basemap) {
  for (const id of Object.keys(BASEMAPS)) {
    const vis = id === bm ? 'visible' : 'none';
    map.setLayoutProperty(`bm-${id}`, 'visibility', vis);
    if (map.getLayer(`lb-${id}`)) map.setLayoutProperty(`lb-${id}`, 'visibility', vis);
  }
}

/** Mode value of pid i for view statistics. */
function statValue(s: State, i: number, dt: number): number {
  const b = s.base!;
  const vf = verticalFactor(s);
  switch (s.mode) {
    case 'accel': return b.accel[i];
    case 'seasonal': return b.seas[i];
    case 'quality': return b.quality[i];
    case 'displacement': return (b.vel[i] - (s.reference?.vel ?? 0)) * dt * vf;
    case 'phase': return (((b.vel[i] - (s.reference?.vel ?? 0)) * dt) / PHASE_PERIOD_MM % 1 + 1) % 1;
    default: return (b.vel[i] - (s.reference?.vel ?? 0)) * vf;
  }
}

export function computeViewStats() {
  const s = getState();
  const { base, bounds, meta } = s;
  if (!base || !bounds || !meta) return;
  const [x0, y0, x1, y1] = bounds;
  const [lo, hi] = s.mode === 'phase' ? [0, 1] : s.ranges[s.mode];
  const BINS = 56;
  const hist = new Uint32Array(BINS);
  const k = Math.floor(s.epochF);
  const dt = meta.t[k] + (meta.t[Math.min(k + 1, meta.epochs - 1)] - meta.t[k]) * (s.epochF - k) - meta.t[basisIndex(s)];
  const [f0, f1] = s.velFilter;
  let n = 0; let sum = 0; let away = 0; let toward = 0;
  const pos = base.positions;
  const refVel = s.reference?.vel ?? 0;
  const vf = verticalFactor(s);
  for (let i = 0; i < base.loaded; i++) {
    const x = pos[2 * i];
    const y = pos[2 * i + 1];
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const vel = base.vel[i];
    if (vel < f0 || vel > f1 || base.quality[i] < s.qualityMin) continue;
    n++;
    const rv = (vel - refVel) * vf;
    sum += rv;
    if (rv < -10) away++;
    else if (rv > 10) toward++;
    const v = statValue(s, i, dt);
    const bi = Math.floor(((v - lo) / (hi - lo)) * BINS);
    hist[Math.min(Math.max(bi, 0), BINS - 1)]++;
  }
  s.set({ viewStats: { n, mean: n ? sum / n : 0, away10: n ? away / n : 0, toward10: n ? toward / n : 0, hist, lo, hi } });
}

let tsAbort: AbortController | null = null;
let tsKey = '';
async function updateTs() {
  const s = getState();
  const { meta, base, bounds } = s;
  if (!meta || !base || !bounds || base.loaded < base.n) return;
  if (s.mode !== 'displacement' && s.mode !== 'phase') return;
  if (s.zoom < 10.5) {
    if (s.tsStatus !== 'idle' || s.ts) s.set({ ts: null, tsStatus: 'idle', tsInView: 0 });
    return;
  }
  const b = basisIndex(s);
  const cur = s.ts;
  if (cur && cur.basis === b && cur.bounds[0] <= bounds[0] && cur.bounds[1] <= bounds[1] && cur.bounds[2] >= bounds[2] && cur.bounds[3] >= bounds[3]) return;
  const w = bounds[2] - bounds[0];
  const h = bounds[3] - bounds[1];
  const padded: [number, number, number, number] = [bounds[0] - w * 0.2, bounds[1] - h * 0.2, bounds[2] + w * 0.2, bounds[3] + h * 0.2];
  let { ranges, count, inView } = visibleRanges(base, padded);
  if (count > MAX_TS_POINTS) {
    ({ ranges, count, inView } = visibleRanges(base, bounds));
    padded.splice(0, 4, ...bounds);
  }
  if (!count) { s.set({ ts: null, tsStatus: 'idle', tsInView: 0 }); return; }
  if (count > MAX_TS_POINTS) { s.set({ ts: null, tsStatus: 'too-many', tsInView: inView }); return; }
  const key = `${b}:${ranges.map((r) => r.join('-')).join(',')}`;
  if (key === tsKey) return;
  tsKey = key;
  tsAbort?.abort();
  tsAbort = new AbortController();
  s.set({ tsStatus: 'loading', tsInView: inView });
  try {
    const ts = await fetchTs(meta, base, ranges, b, padded, tsAbort.signal);
    getState().set({ ts, tsStatus: 'ready' });
  } catch (e: any) {
    if (e?.name !== 'AbortError') { tsKey = ''; getState().set({ tsStatus: 'error' }); }
  }
}

export async function selectPoint(pid: number, additive = false) {
  const s = getState();
  if (additive && s.selected !== null && pid !== s.selected) {
    if (!s.compare.includes(pid) && s.compare.length < 5) s.set({ compare: [...s.compare, pid] });
  } else {
    s.set({ selected: pid, panel: 'point' });
  }
  const rec = await fetchPoint(pid).catch(() => null);
  if (rec) getState().set({ points: { ...getState().points, [pid]: rec } });
}

export async function setReferencePoint(pid: number) {
  const rec = await fetchPoint(pid);
  getState().set({
    reference: { kind: 'point', id: `pid:${pid}`, label: `Point ${pid}`, vel: rec.vel_avg, series: rec.series, lon: rec.lon, lat: rec.lat },
    tool: 'none'
  });
  computeViewStats();
}

export async function runRegion(polygon: number[][]) {
  const s = getState();
  s.set({ regionLoading: true, panel: 'region', region: { n: 0, polygon }, tool: 'none', draft: [] });
  try {
    const r = await postJson<any>('/region', { polygon });
    getState().set({ region: r, regionLoading: false });
  } catch {
    getState().set({ regionLoading: false });
  }
}

export async function runProfile(line: number[][]) {
  const s = getState();
  s.set({ tool: 'none', draft: [], panel: 'profile' });
  const r = await postJson<any>('/profile', { line, width: 60 });
  getState().set({ profile: { ...r, line } });
}

export default function MapView() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const s0 = getState();
    const bbox = s0.meta!.bbox;
    const map = new maplibregl.Map({
      container: ref.current!,
      style: style(),
      bounds: [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      fitBoundsOptions: { padding: { top: 70, bottom: 110, left: window.innerWidth > 1100 ? 320 : 20, right: 20 } },
      maxPitch: 70,
      attributionControl: { compact: true },
      dragRotate: true,
      renderWorldCopies: false
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    let pulseStart = -1e9;
    let frame = 0;
    let animating = false;

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      pickingRadius: 4,
      useDevicePixels: true,
      onClick: (info: any, ev: any) => {
        const s = getState();
        const src = ev?.srcEvent;
        if (s.tool === 'lasso' || s.tool === 'profile') {
          if (!info.coordinate) return;
          const draft = [...s.draft, info.coordinate.slice(0, 2)];
          if (s.tool === 'profile' && draft.length === 2) { runProfile(draft); return; }
          if (s.tool === 'lasso' && draft.length > 3) {
            const [fx, fy] = draft[0];
            const p0 = map.project([fx, fy]);
            const p1 = map.project(info.coordinate);
            if (Math.hypot(p0.x - p1.x, p0.y - p1.y) < 12) { runRegion(draft.slice(0, -1)); return; }
          }
          s.set({ draft });
          return;
        }
        if (!info.layer) return;
        if (info.layer.id === 'refs' && info.object && s.tool === 'reference' && info.object.label !== 'REF') {
          const c = s.meta!.refCandidates[parseInt(info.object.label.slice(1), 10) - 1];
          s.set({ reference: { kind: 'candidate', id: c.h3, label: info.object.label, vel: c.vel_mean, series: c.series, lon: c.lon, lat: c.lat }, tool: 'none' });
          computeViewStats();
          return;
        }
        if (info.layer.id === 'hex' && info.object) {
          map.easeTo({ center: info.coordinate, zoom: Math.max(map.getZoom() + 2, 10.6), duration: 900 });
          return;
        }
        let pid: number | null = null;
        if (info.layer.id === 'points' && info.index >= 0) pid = info.index;
        if (info.layer.id === 'ts-points' && info.index >= 0) pid = s.ts!.pids[info.index];
        if (pid === null) return;
        if (s.tool === 'reference') { setReferencePoint(pid); return; }
        pulseStart = performance.now();
        selectPoint(pid, Boolean(src?.shiftKey));
        kick();
      },
      getTooltip: (info: any) => {
        const s = getState();
        if (!info.layer || s.tool === 'lasso' || s.tool === 'profile') return null;
        const base = s.base!;
        let pid = -1;
        if (info.layer.id === 'points') pid = info.index;
        else if (info.layer.id === 'ts-points') pid = s.ts!.pids[info.index];
        const box = { className: 'deck-tip', style: {} };
        if (pid >= 0) {
          return { ...box, html: `<b>${base.vel[pid] > 0 ? '+' : ''}${base.vel[pid].toFixed(1)}</b> mm/yr<span>pid ${pid} · q ${base.quality[pid]}${base.dup[pid] > 1 ? ` · ${base.dup[pid]} here` : ''}</span>` };
        }
        if (info.layer.id === 'hex' && info.object) {
          const c = info.object;
          return { ...box, html: `<b>${c.vel > 0 ? '+' : ''}${c.vel.toFixed(1)}</b> mm/yr mean<span>${c.n.toLocaleString()} scatterers · p10 ${c.p10.toFixed(1)} / p90 ${c.p90.toFixed(1)}</span>` };
        }
        if (info.layer.id === 'refs' && info.object) {
          if (info.object.label === 'REF') return { ...box, html: `<b>Reference</b><span>${s.reference?.label}</span>` };
          const c = s.meta!.refCandidates[parseInt(info.object.label.slice(1), 10) - 1];
          return { ...box, html: `<b>${info.object.label}</b> stable-area candidate<span>${c.n} pts · ${c.vel_mean.toFixed(2)} ± ${c.vel_std.toFixed(2)} mm/yr</span>` };
        }
        return null;
      }
    } as any);
    map.addControl(overlay as any);

    const render = () => {
      frame = 0;
      const now = performance.now();
      overlay.setProps({ layers: buildLayers(getState(), now, pulseStart) });
      if (now - pulseStart < 1700) { animating = true; frame = requestAnimationFrame(render); } else animating = false;
    };
    const kick = () => { if (!frame) frame = requestAnimationFrame(render); };

    const syncView = () => {
      const b = map.getBounds();
      getState().set({ zoom: map.getZoom(), bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] });
    };

    map.on('load', () => {
      applyBasemap(map, getState().basemap);
      syncView();
      kick();
    });
    map.on('move', () => {
      const z = map.getZoom();
      if (Math.abs(z - getState().zoom) > 0.02) getState().set({ zoom: z });
    });
    let idleTimer: any;
    map.on('moveend', () => {
      syncView();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { computeViewStats(); updateTs(); }, 120);
      const res = hexResForZoom(map.getZoom());
      if (!getState().hex[res]) loadHex(res).then((h) => getState().set({ hex: { ...getState().hex, [res]: h } }));
    });
    map.on('dblclick', (e) => {
      const s = getState();
      if (s.tool === 'lasso' && s.draft.length >= 3) { e.preventDefault(); runRegion(s.draft); }
    });

    const unsub = useStore.subscribe((s, prev) => {
      if (s.basemap !== prev.basemap && map.isStyleLoaded()) applyBasemap(map, s.basemap);
      if (s.flyTo && s.flyTo !== prev.flyTo) {
        map.flyTo({ center: [s.flyTo.lon, s.flyTo.lat], zoom: s.flyTo.zoom ?? Math.max(map.getZoom(), 14), duration: 1600, essential: true });
      }
      if (s.extrude !== prev.extrude) map.easeTo({ pitch: s.extrude ? 55 : 0, bearing: s.extrude ? -12 : 0, duration: 900 });
      if (s.tool !== prev.tool) {
        map.getCanvas().style.cursor = s.tool === 'none' ? '' : 'crosshair';
        if (s.tool === 'none') map.doubleClickZoom.enable(); else map.doubleClickZoom.disable();
      }
      if (s.mode !== prev.mode || s.basis !== prev.basis) { tsKey = ''; if (s.basis !== prev.basis) s.set({ ts: null, tsStatus: 'idle' }); setTimeout(updateTs, 0); }
      if (s.mode !== prev.mode || s.ranges !== prev.ranges || s.velFilter !== prev.velFilter || s.qualityMin !== prev.qualityMin
        || s.reference !== prev.reference || s.vertical !== prev.vertical || s.incidence !== prev.incidence
        || (s.loadFraction >= 1 && prev.loadFraction < 1)) {
        setTimeout(computeViewStats, 0);
      }
      if (s.selected !== prev.selected && s.selected !== null) pulseStart = performance.now();
      if (!animating) kick();
    });

    // initial hex overview before the points arrive
    Promise.all([loadHex(6), loadHex(7)]).then(([a, b]) => getState().set({ hex: { ...getState().hex, 6: a, 7: b } }));

    const w = window as any;
    w.__phase = { map, overlay, getState, runRegion, runProfile, selectPoint };
    return () => { unsub(); cancelAnimationFrame(frame); map.remove(); };
  }, []);

  return <div ref={ref} className="map" />;
}
