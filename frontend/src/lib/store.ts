import { create } from 'zustand';
import type { Base, HexSet, Meta, PointRecord, TsSubset } from './data';
import type { CmapName } from './colormaps';

export type Mode = 'velocity' | 'displacement' | 'accel' | 'seasonal' | 'phase' | 'quality';
export type Tool = 'none' | 'lasso' | 'profile' | 'reference';
export type Basemap = 'dark' | 'light' | 'satellite' | 'topo';

export const MODES: { id: Mode; label: string; short: string; key: string; unit: string }[] = [
  { id: 'velocity', label: 'Velocity', short: 'VEL', key: '1', unit: 'mm/yr' },
  { id: 'displacement', label: 'Displacement', short: 'DSP', key: '2', unit: 'mm' },
  { id: 'accel', label: 'Acceleration', short: 'ACC', key: '3', unit: 'mm/yr²' },
  { id: 'seasonal', label: 'Seasonal', short: 'SEA', key: '4', unit: 'mm' },
  { id: 'phase', label: 'Wrapped phase', short: 'PHS', key: '5', unit: 'rad' },
  { id: 'quality', label: 'Quality', short: 'QLT', key: '6', unit: '0–255' }
];

export const COMPARE_COLORS = ['#FFB547', '#4FD1C5', '#A3E635', '#D58CF0', '#FF7A6B', '#60A5FA'];

export interface Reference {
  kind: 'candidate' | 'point';
  id: string;
  label: string;
  vel: number;
  series: number[]; // raw series (not re-based)
  lon: number;
  lat: number;
}

export interface RegionResult {
  n: number; polygon: number[][]; vel_mean?: number; vel_median?: number; vel_min?: number; vel_max?: number;
  vel_std?: number; accel_mean?: number; seas_mean?: number; rmse_mean?: number; n_fast_away?: number;
  n_fast_toward?: number; p10?: number[]; p50?: number[]; p90?: number[]; hist?: [number, number][];
  top?: { pid: number; lon: number; lat: number; vel: number; accel: number }[];
}

export interface ProfileResult {
  line: number[][]; length: number; width: number; n: number;
  pid: number[]; s: number[]; o: number[]; vel: number[]; quality: number[];
}

export interface ViewStats { n: number; mean: number; away10: number; toward10: number; hist: Uint32Array; lo: number; hi: number }

type Ranges = Record<Mode, [number, number]>;

export interface State {
  meta: Meta | null;
  base: Base | null;
  baseVersion: number;
  loadFraction: number;
  error: string | null;
  hex: Record<number, HexSet>;

  mode: Mode;
  ranges: Ranges;
  cmapChoice: Partial<Record<Mode, CmapName>>; // per-mode colour map (unset = automatic by theme)
  cmapFlip: Partial<Record<Mode, boolean>>;
  classes: number; // 0 = continuous, else number of discrete colour classes
  velFilter: [number, number];
  qualityMin: number;
  vertical: boolean;
  incidence: number;
  aggregate: boolean;
  extrude: boolean;
  basemap: Basemap;
  theme: 'dark' | 'light';

  epochF: number;
  playing: boolean;
  speed: number;
  basis: 'first' | 'master';
  ts: TsSubset | null;
  tsStatus: 'idle' | 'loading' | 'ready' | 'too-many' | 'error';
  tsInView: number;

  reference: Reference | null;
  selected: number | null;
  compare: number[];
  points: Record<number, PointRecord>;
  hoverEpoch: number | null;

  tool: Tool;
  draft: number[][];
  region: RegionResult | null;
  regionLoading: boolean;
  profile: ProfileResult | null;
  panel: 'point' | 'region' | 'profile' | null;

  zoom: number;
  bounds: [number, number, number, number] | null;
  viewStats: ViewStats | null;
  flyTo: { lon: number; lat: number; zoom?: number; t: number } | null;
  railOpen: boolean;

  set: (p: Partial<State>) => void;
}

export function defaultRanges(meta: Meta): Ranges {
  const s = meta.stats;
  const sym = (k: string, round: number) => {
    const m = Math.max(Math.abs(s[k].p02), Math.abs(s[k].p98));
    return Math.ceil(m / round) * round;
  };
  const v = sym('vel', 2);
  const d = sym('disp_total', 10);
  const a = Math.max(0.5, Math.ceil(Math.max(Math.abs(s.accel.p02), Math.abs(s.accel.p98)) * 2) / 2);
  return {
    velocity: [-v, v],
    displacement: [-d, d],
    accel: [-a, a],
    seasonal: [0, Math.ceil(s.seas_amp.p98)],
    phase: [0, 1],
    quality: [0, 255]
  };
}

export const useStore = create<State>((set) => ({
  meta: null,
  base: null,
  baseVersion: 0,
  loadFraction: 0,
  error: null,
  hex: {},

  mode: 'velocity',
  ranges: {
    velocity: [-20, 20], displacement: [-150, 150], accel: [-2, 2], seasonal: [0, 20], phase: [0, 1], quality: [0, 255]
  },
  cmapChoice: {},
  cmapFlip: {},
  classes: 0,
  velFilter: [-60, 25],
  qualityMin: 0,
  vertical: false,
  incidence: 39,
  aggregate: true,
  extrude: false,
  basemap: (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark') as Basemap,
  theme: (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'),

  epochF: 0,
  playing: false,
  speed: 1,
  basis: 'first',
  ts: null,
  tsStatus: 'idle',
  tsInView: 0,

  reference: null,
  selected: null,
  compare: [],
  points: {},
  hoverEpoch: null,

  tool: 'none',
  draft: [],
  region: null,
  regionLoading: false,
  profile: null,
  panel: null,

  zoom: 7,
  bounds: null,
  viewStats: null,
  flyTo: null,
  railOpen: window.innerWidth > 1100,

  set: (p) => set(p)
}));

export const getState = useStore.getState;

/** Index of the epoch used as zero for displacement. */
export function basisIndex(s: Pick<State, 'basis' | 'meta'>): number {
  if (!s.meta || s.basis === 'first') return 0;
  return Math.max(0, s.meta.dates.indexOf(s.meta.master_estimate));
}

/** LOS → "≈ vertical" factor (assumes purely vertical motion). */
export function verticalFactor(s: Pick<State, 'vertical' | 'incidence'>): number {
  return s.vertical ? 1 / Math.cos((s.incidence * Math.PI) / 180) : 1;
}

/** Reference value (re-based) at a fractional epoch. */
export function refAt(ref: Reference | null, epochF: number, basis: number): number {
  if (!ref) return 0;
  const k = Math.floor(epochF);
  const k1 = Math.min(k + 1, ref.series.length - 1);
  const f = epochF - k;
  return ref.series[k] + (ref.series[k1] - ref.series[k]) * f - ref.series[basis];
}

export function fmtDate(iso: string, style: 'short' | 'long' = 'long') {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', style === 'long'
    ? { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }
    : { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function epochDate(meta: Meta, epochF: number): Date {
  const k = Math.floor(epochF);
  const k1 = Math.min(k + 1, meta.dates.length - 1);
  const a = Date.parse(`${meta.dates[k]}T00:00:00Z`);
  const b = Date.parse(`${meta.dates[k1]}T00:00:00Z`);
  return new Date(a + (b - a) * (epochF - k));
}
