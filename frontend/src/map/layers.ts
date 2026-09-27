import { ScatterplotLayer, PathLayer, PolygonLayer, TextLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import { ValueColorExtension } from './ValueColorExtension';
import { CMAP_INDEX, classify, sample, type CmapName } from '../lib/colormaps';
import { basisIndex, COMPARE_COLORS, refAt, verticalFactor, type State } from '../lib/store';
import type { Base, HexSet, TsSubset } from '../lib/data';

const valueColor = new ValueColorExtension();
const dataFilter = new DataFilterExtension({ filterSize: 2 });
export const PHASE_PERIOD_MM = 55.465763 / 2;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

export function hexResForZoom(z: number) {
  return z < 7 ? 6 : z < 8.6 ? 7 : 8;
}

const DIVERGING_MODES = new Set(['velocity', 'displacement', 'accel']);

/** Automatic colour map for a mode in the current theme. */
export function autoCmap(mode: State['mode'], theme: State['theme']): CmapName {
  if (mode === 'seasonal') return 'lajolla';
  if (mode === 'quality') return 'batlow';
  if (mode === 'phase') return 'romaO';
  return theme === 'light' ? 'vik' : 'berlin';
}

export function colorSpec(s: Pick<State, 'mode' | 'theme' | 'cmapChoice' | 'cmapFlip' | 'classes'>) {
  const choice = s.cmapChoice?.[s.mode];
  const cmap: CmapName = choice ?? autoCmap(s.mode, s.theme);
  const cyclic = s.mode === 'phase';
  // diverging modes: negative (away) on the warm/last end; La Jolla auto on dark runs dark → light
  let reverse = DIVERGING_MODES.has(s.mode) || (!choice && s.mode === 'seasonal' && s.theme === 'dark');
  if (s.cmapFlip?.[s.mode]) reverse = !reverse;
  return { cmap, reverse, cyclic, steps: cyclic ? 0 : s.classes || 0 };
}

/** Colour for a normalised value t ∈ [0, 1] under a spec (legend, hexes, charts). */
export function specColor(spec: ReturnType<typeof colorSpec>, t: number) {
  return sample(spec.cmap, spec.reverse && !spec.cyclic ? 1 - classify(t, spec.steps) : classify(t, spec.steps));
}

/** Years between the basis epoch and the (fractional) current epoch. */
function dtYears(s: State) {
  const t = s.meta!.t;
  const k = Math.floor(s.epochF);
  const k1 = Math.min(k + 1, t.length - 1);
  return t[k] + (t[k1] - t[k]) * (s.epochF - k) - t[basisIndex(s)];
}

/** Uniform set + per-point arrays for the resident point layer in the current mode. */
function baseValues(s: State, base: Base) {
  const vf = verticalFactor(s);
  const refVel = s.reference?.vel ?? 0;
  switch (s.mode) {
    case 'accel': return { arr: base.accel, ref: 0, scale: 1 };
    case 'seasonal': return { arr: base.seas, ref: 0, scale: 1 };
    case 'quality': return { arr: base.quality, ref: 0, scale: 1 };
    case 'displacement': return { arr: base.vel, ref: refVel, scale: dtYears(s) * vf };
    case 'phase': return { arr: base.vel, ref: refVel, scale: dtYears(s) };
    default: return { arr: base.vel, ref: refVel, scale: vf };
  }
}

const dataMemo = new WeakMap<object, Map<string, any>>();
function memoData(owner: object, key: string, make: () => any) {
  let m = dataMemo.get(owner);
  if (!m) { m = new Map(); dataMemo.set(owner, m); }
  if (!m.has(key)) {
    if (m.size > 80) m.clear();
    m.set(key, make());
  }
  return m.get(key);
}

function hexValue(s: State, hex: HexSet, c: { i: number; vel: number; accel: number; seas: number; quality: number }) {
  const vf = verticalFactor(s);
  const b = basisIndex(s);
  switch (s.mode) {
    case 'accel': return c.accel;
    case 'seasonal': return c.seas;
    case 'quality': return c.quality;
    case 'velocity': return (c.vel - (s.reference?.vel ?? 0)) * vf;
    default: {
      const E = hex.epochs;
      const k = Math.floor(s.epochF);
      const k1 = Math.min(k + 1, E - 1);
      const f = s.epochF - k;
      const sc = 1 / (s.meta!.disp_scale);
      const o = c.i * E;
      const v = (hex.series[o + k] + (hex.series[o + k1] - hex.series[o + k]) * f - hex.series[o + b]) * sc
        - refAt(s.reference, s.epochF, b);
      return s.mode === 'phase' ? v : v * vf;
    }
  }
}

export function buildLayers(s: State, now: number, pulseStart: number) {
  const layers: any[] = [];
  const { meta, base } = s;
  if (!meta) return layers;
  const spec = colorSpec(s);
  const [vmin, vmax] = s.ranges[s.mode];
  const z = s.zoom;
  const hexOpacity = s.aggregate ? 1 - smooth(9.4, 10.4, z) : 0;
  const pointOpacity = s.aggregate ? smooth(9.0, 10.0, z) : 1;
  const beforeId = 'labels';

  // ── hexes ────────────────────────────────────────────────────────────
  const hex = s.hex[hexResForZoom(z)];
  if (hex && hexOpacity > 0.01) {
    const refKey = s.reference?.id ?? '';
    const colorOf = (c: any) => {
      const v = hexValue(s, hex, c);
      const t = spec.cyclic ? ((v / PHASE_PERIOD_MM) % 1 + 1) % 1 : (v - vmin) / (vmax - vmin || 1);
      const rgb = specColor(spec, t);
      const a = Math.min(255, 70 + 60 * Math.log10(c.n + 1));
      return [rgb[0], rgb[1], rgb[2], a];
    };
    const valueTrigger = `${s.mode}|${vmin}|${vmax}|${spec.cmap}|${spec.reverse}|${spec.steps}|${refKey}|${s.vertical}|${s.incidence}|${s.basis}|${s.mode === 'displacement' || s.mode === 'phase' ? s.epochF.toFixed(3) : ''}`;
    layers.push(new H3HexagonLayer({
      id: `hex`,
      data: hex.cells,
      getHexagon: (d: any) => d.h3,
      getFillColor: colorOf,
      getElevation: (d: any) => {
        const v = Math.abs(hexValue(s, hex, d));
        const span = Math.max(Math.abs(vmin), Math.abs(vmax)) || 1;
        return (Math.min(v / span, 1.5) * 18000) / (hex.res - 4);
      },
      extruded: s.extrude,
      elevationScale: 1,
      coverage: 0.9,
      highPrecision: false,
      stroked: false,
      filled: true,
      opacity: hexOpacity * (s.mode === 'displacement' || s.mode === 'phase' ? 0.95 : 0.9),
      pickable: true,
      material: s.extrude ? { ambient: 0.55, diffuse: 0.6, shininess: 24 } : false,
      updateTriggers: { getFillColor: valueTrigger, getElevation: valueTrigger },
      transitions: { getElevation: 500 },
      beforeId
    } as any));
  }

  // ── points ───────────────────────────────────────────────────────────
  const radius = { radiusUnits: 'meters', getRadius: 6, radiusMinPixels: z < 9 ? 0.7 : z < 12 ? 1.2 : z < 14 ? 2 : 2.8, radiusMaxPixels: 8 };
  const filterRange = [[s.velFilter[0], s.velFilter[1]], [s.qualityMin, 255]];
  const measured = (s.mode === 'displacement' || s.mode === 'phase') && s.ts && s.tsStatus === 'ready';
  const uniforms = {
    vcMin: vmin, vcMax: vmax, vcCmap: CMAP_INDEX[spec.cmap], vcReverse: spec.reverse, vcCyclic: spec.cyclic,
    vcPeriod: PHASE_PERIOD_MM, vcSteps: spec.steps
  };

  if (base && base.loaded > 0 && pointOpacity > 0.01) {
    const v = baseValues(s, base);
    const arrKey = v.arr === base.vel ? 'vel' : v.arr === base.accel ? 'accel' : v.arr === base.seas ? 'seas' : 'q';
    const data = memoData(base, `${arrKey}:${base.loaded}:${s.baseVersion}`, () => ({
      length: base.loaded,
      attributes: {
        getPosition: { value: base.positions, size: 2 },
        getValueA: { value: v.arr, size: 1 },
        getValueB: { value: v.arr, size: 1 },
        getFilterValue: { value: base.filter, size: 2 }
      }
    }));
    layers.push(new ScatterplotLayer({
      id: 'points',
      data,
      ...radius,
      opacity: pointOpacity * (measured ? 0.12 : 0.92),
      stroked: false,
      pickable: !measured,
      autoHighlight: false,
      extensions: [valueColor, dataFilter],
      filterRange,
      ...uniforms,
      vcRefA: v.ref, vcRefB: v.ref, vcScale: v.scale, vcMix: 0,
      vcDim: measured ? 0.6 : 1,
      beforeId
    } as any));
  }

  // measured displacement for the viewport (epoch k ↔ k+1 interpolated on the GPU)
  if (measured && pointOpacity > 0.01) {
    const ts = s.ts as TsSubset;
    const E = ts.epochs.length;
    const k = Math.min(Math.floor(s.epochF), E - 1);
    const k1 = Math.min(k + 1, E - 1);
    const b = basisIndex(s);
    const data = memoData(ts, `${k}`, () => ({
      length: ts.n,
      attributes: {
        getPosition: { value: ts.positions, size: 2 },
        getValueA: { value: ts.epochs[k], size: 1 },
        getValueB: { value: ts.epochs[k1], size: 1 },
        getFilterValue: { value: ts.filter, size: 2 }
      }
    }));
    const refA = s.reference ? s.reference.series[k] - s.reference.series[b] : 0;
    const refB = s.reference ? s.reference.series[k1] - s.reference.series[b] : 0;
    layers.push(new ScatterplotLayer({
      id: 'ts-points',
      data,
      ...radius,
      opacity: pointOpacity * 0.95,
      stroked: false,
      pickable: true,
      extensions: [valueColor, dataFilter],
      filterRange,
      ...uniforms,
      vcRefA: refA, vcRefB: refB, vcMix: s.epochF - k,
      vcScale: s.mode === 'phase' ? 1 : verticalFactor(s),
      beforeId
    } as any));
  }

  // ── reference candidates / active reference ─────────────────────────
  const refs = s.tool === 'reference' ? meta.refCandidates : [];
  if (refs.length || s.reference) {
    const items = [
      ...refs.map((c, i) => ({ pos: [c.lon, c.lat], text: '◇', label: `R${i + 1}`, active: false })),
      ...(s.reference ? [{ pos: [s.reference.lon, s.reference.lat], text: '◆', label: 'REF', active: true }] : [])
    ];
    layers.push(new TextLayer({
      id: 'refs',
      data: items,
      getPosition: (d: any) => d.pos,
      getText: (d: any) => d.text,
      getSize: (d: any) => (d.active ? 22 : 18),
      getColor: (d: any) => (d.active ? [255, 181, 71, 255] : [255, 181, 71, 200]),
      characterSet: ['◇', '◆'],
      fontFamily: 'Martian Mono, monospace',
      fontWeight: 400,
      pickable: true,
      outlineWidth: 2,
      outlineColor: [10, 12, 15, 200],
      fontSettings: { sdf: true }
    } as any));
  }

  // ── selection & compare rings ────────────────────────────────────────
  if (base && (s.selected !== null || s.compare.length)) {
    const pts = [
      ...s.compare.map((pid, i) => ({ pid, color: COMPARE_COLORS[(i + 1) % COMPARE_COLORS.length] })),
      ...(s.selected !== null ? [{ pid: s.selected, color: COMPARE_COLORS[0] }] : [])
    ].filter((p) => p.pid < base.loaded);
    const hexToRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const pos = (d: any) => [base.positions[2 * d.pid], base.positions[2 * d.pid + 1]];
    layers.push(new ScatterplotLayer({
      id: 'selection',
      data: pts,
      getPosition: pos,
      getRadius: 7,
      radiusUnits: 'pixels',
      stroked: true,
      filled: true,
      getFillColor: (d: any) => [...hexToRgb(d.color), 255],
      getLineColor: [10, 12, 15, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 2.5,
      updateTriggers: { getFillColor: pts.map((p) => p.color).join() }
    } as any));
    const age = now - pulseStart;
    if (s.selected !== null && age < 1600) {
      const rings = [0, 280].map((delay) => {
        const t = Math.min(Math.max((age - delay) / 1100, 0), 1);
        return { t };
      }).filter((r) => r.t > 0 && r.t < 1);
      layers.push(new ScatterplotLayer({
        id: 'pulse',
        data: rings,
        getPosition: () => pos({ pid: s.selected }),
        getRadius: (d: any) => 8 + 46 * (1 - Math.pow(1 - d.t, 3)),
        radiusUnits: 'pixels',
        stroked: true,
        filled: false,
        getLineColor: (d: any) => [255, 181, 71, 255 * (1 - d.t)],
        lineWidthUnits: 'pixels',
        getLineWidth: (d: any) => 2.5 * (1 - d.t) + 0.5,
        updateTriggers: { getRadius: age, getLineColor: age, getLineWidth: age }
      } as any));
    }
  }

  // ── drawing tools ────────────────────────────────────────────────────
  const amber = [255, 181, 71];
  if (s.region?.polygon) {
    layers.push(new PolygonLayer({
      id: 'region',
      data: [{ polygon: s.region.polygon }],
      getPolygon: (d: any) => d.polygon,
      getFillColor: [...amber, 18],
      getLineColor: [...amber, 230],
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      stroked: true
    } as any));
  }
  if (s.profile) {
    const [[ax, ay], [bx, by]] = s.profile.line;
    const lat0 = (ay + by) / 2;
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110540;
    const L = Math.hypot((bx - ax) * kx, (by - ay) * ky);
    const nx = (-(by - ay) * ky / L) * (s.profile.width / kx);
    const ny = ((bx - ax) * kx / L) * (s.profile.width / ky);
    layers.push(new PolygonLayer({
      id: 'profile-corridor',
      data: [{ polygon: [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]] }],
      getPolygon: (d: any) => d.polygon,
      getFillColor: [...amber, 22],
      getLineColor: [...amber, 120],
      lineWidthUnits: 'pixels',
      getLineWidth: 1
    } as any));
    layers.push(new PathLayer({
      id: 'profile-line', data: [{ path: s.profile.line }], getPath: (d: any) => d.path,
      getColor: [...amber, 255], widthUnits: 'pixels', getWidth: 2
    } as any));
  }
  if (s.draft.length) {
    const closed = s.tool === 'lasso' && s.draft.length > 2 ? [...s.draft, s.draft[0]] : s.draft;
    layers.push(new PathLayer({
      id: 'draft', data: [{ path: closed }], getPath: (d: any) => d.path,
      getColor: [...amber, 220], widthUnits: 'pixels', getWidth: 1.5
    } as any));
    layers.push(new ScatterplotLayer({
      id: 'draft-vertices', data: s.draft, getPosition: (d: any) => d,
      getRadius: 4, radiusUnits: 'pixels', getFillColor: [10, 12, 15, 255], getLineColor: [...amber, 255],
      stroked: true, lineWidthUnits: 'pixels', getLineWidth: 1.5
    } as any));
  }
  return layers;
}
