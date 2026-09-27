import { useRef } from 'react';
import { cssGradient } from '../lib/colormaps';
import ColorPicker from './ColorPicker';
import { defaultRanges, MODES, useStore } from '../lib/store';
import { colorSpec, PHASE_PERIOD_MM, specColor } from '../map/layers';

const LIMITS: Record<string, [number, number]> = {
  velocity: [-60, 60], displacement: [-600, 600], accel: [-10, 10], seasonal: [0, 60], quality: [0, 255], phase: [0, 1]
};

export default function Legend() {
  const mode = useStore((s) => s.mode);
  const theme = useStore((s) => s.theme);
  const ranges = useStore((s) => s.ranges);
  const stats = useStore((s) => s.viewStats);
  const meta = useStore((s) => s.meta)!;
  const vertical = useStore((s) => s.vertical);
  const cmapChoice = useStore((s) => s.cmapChoice);
  const cmapFlip = useStore((s) => s.cmapFlip);
  const classes = useStore((s) => s.classes);
  const set = useStore((s) => s.set);
  const bar = useRef<HTMLDivElement>(null);
  const spec = colorSpec({ mode, theme, cmapChoice, cmapFlip, classes });
  const [lo, hi] = ranges[mode];
  const info = MODES.find((m) => m.id === mode)!;
  const diverging = mode === 'velocity' || mode === 'displacement' || mode === 'accel';

  const drag = (which: 0 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const [L0, L1] = LIMITS[mode];
    const move = (ev: PointerEvent) => {
      const r = bar.current!.getBoundingClientRect();
      const f = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
      // the bar spans the current range ±50%, so handles can widen or narrow it
      const span = hi - lo;
      let v = lo - span * 0.5 + f * span * 2;
      v = Math.min(Math.max(v, L0), L1);
      const step = Math.abs(span) > 60 ? 5 : Math.abs(span) > 8 ? 1 : 0.1;
      v = Math.round(v / step) * step;
      const cur = useStore.getState().ranges[mode];
      let next: [number, number] = which === 0 ? [Math.min(v, cur[1] - step), cur[1]] : [cur[0], Math.max(v, cur[0] + step)];
      if (diverging && !ev.altKey) next = which === 0 ? [next[0], -next[0]] : [-next[1], next[1]];
      if (next[0] >= next[1]) return;
      set({ ranges: { ...useStore.getState().ranges, [mode]: next } });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const stretch = () => {
    if (!stats || !stats.n) return;
    const { hist, lo: a, hi: b } = stats;
    const total = hist.reduce((s, v) => s + v, 0);
    let c = 0; let p2 = a; let p98 = b;
    for (let i = 0; i < hist.length; i++) {
      c += hist[i];
      const x = a + ((i + 1) / hist.length) * (b - a);
      if (c / total < 0.02) p2 = x;
      if (c / total < 0.98) p98 = x;
    }
    let next: [number, number] = [p2, p98];
    if (diverging) { const m = Math.max(Math.abs(p2), Math.abs(p98)); next = [-m, m]; }
    const r = (v: number) => (Math.abs(next[1] - next[0]) > 10 ? Math.round(v) : Math.round(v * 10) / 10);
    set({ ranges: { ...ranges, [mode]: [r(next[0]), r(next[1])] } });
  };

  // handles sit on a bar that spans [lo − 50%, hi + 50%]
  const span = hi - lo;
  const pos = (v: number) => ((v - (lo - span * 0.5)) / (span * 2)) * 100;
  const hist = stats?.hist;
  const max = hist ? Math.max(1, ...Array.from(hist)) : 1;
  const fmt = (v: number) => (Math.abs(v) >= 10 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1));

  return (
    <div className="legend">
      <div className="lg-head">
        <span className="eyebrow">{info.label}{vertical && (mode === 'velocity' || mode === 'displacement') ? ' · ≈ vertical' : ' · LOS'}</span>
        <span className="mono small muted">{mode === 'phase' ? `fringe = λ/2 = ${PHASE_PERIOD_MM.toFixed(1)} mm` : info.unit}</span>
      </div>
      <ColorPicker />
      {mode === 'phase' ? (
        <>
          <div className="lg-ramp cyclic" style={{ background: cssGradient(spec.cmap, false) }} />
          <div className="lg-scale mono"><span>0</span><span>π</span><span>2π</span></div>
          <p className="lg-note">Each colour cycle = {PHASE_PERIOD_MM.toFixed(1)} mm of LOS motion, like a wrapped interferogram. Deformation bowls show up as concentric fringes.</p>
        </>
      ) : (
        <>
          <div className="lg-hist">
            {hist && Array.from(hist).map((n, i) => {
              const t = (i + 0.5) / hist.length;
              const c = specColor(spec, t);
              return <i key={i} style={{ height: `${Math.max(n ? 6 : 0, Math.sqrt(n / max) * 100)}%`, background: `rgb(${c.join(',')})` }} />;
            })}
          </div>
          <div className="lg-bar" ref={bar}>
            <div className="lg-ramp" style={{ left: `${pos(lo)}%`, width: `${pos(hi) - pos(lo)}%`, background: cssGradient(spec.cmap, spec.reverse, 'to right', spec.steps) }} />
            <button className="lg-handle" style={{ left: `${pos(lo)}%` }} onPointerDown={drag(0)} aria-label="Lower bound" />
            <button className="lg-handle" style={{ left: `${pos(hi)}%` }} onPointerDown={drag(1)} aria-label="Upper bound" />
          </div>
          <div className="lg-scale mono">
            <span>{fmt(lo)}</span>
            {diverging && <span className="dir">{mode === 'accel' ? 'slowing · speeding' : '← away · toward →'}</span>}
            <span>{fmt(hi)}</span>
          </div>
          <div className="lg-actions">
            <button className="link" onClick={stretch}>Stretch to view</button>
            <button className="link" onClick={() => set({ ranges: { ...ranges, [mode]: defaultRanges(meta)[mode] } })}>Reset</button>
            {diverging && <span className="muted small">alt-drag: asymmetric</span>}
          </div>
        </>
      )}
    </div>
  );
}
