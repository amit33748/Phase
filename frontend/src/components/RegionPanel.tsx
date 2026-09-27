import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import SeriesChart from '../chart/SeriesChart';
import { basisIndex, useStore, verticalFactor } from '../lib/store';
import { downloadCsv } from '../lib/data';
import { colorSpec, specColor } from '../map/layers';
import { selectPoint } from '../map/MapView';

const signed = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

export function RegionPanel() {
  const meta = useStore((s) => s.meta)!;
  const region = useStore((s) => s.region);
  const loading = useStore((s) => s.regionLoading);
  const reference = useStore((s) => s.reference);
  const basis = useStore((s) => s.basis);
  const vertical = useStore((s) => s.vertical);
  const incidence = useStore((s) => s.incidence);
  const theme = useStore((s) => s.theme);
  const ranges = useStore((s) => s.ranges);
  const cmapChoice = useStore((s) => s.cmapChoice);
  const cmapFlip = useStore((s) => s.cmapFlip);
  const classes = useStore((s) => s.classes);
  const set = useStore((s) => s.set);
  const dates = useMemo(() => meta.dates.map((d) => new Date(`${d}T00:00:00Z`)), [meta]);
  const b = basisIndex({ basis, meta });
  const vf = verticalFactor({ vertical, incidence });
  const refRe = (i: number) => (reference ? reference.series[i] - reference.series[b] : 0);
  const spec = colorSpec({ theme, mode: 'velocity', cmapChoice, cmapFlip, classes });
  const [lo, hi] = ranges.velocity;

  if (!region) return null;
  const tr = (arr: number[]) => arr.map((v, i) => (v - arr[b] - refRe(i)) * vf);
  const ok = region.n > 0 && region.p50;
  const maxH = ok ? Math.max(...region.hist!.map((h) => h[1])) : 1;

  return (
    <div className="panel-inner">
      <header className="pp-head">
        <div>
          <div className="eyebrow">Region · {region.polygon.length} vertices</div>
          <div className="coords mono">{loading ? 'Querying GeoParquet…' : `${region.n.toLocaleString()} scatterers`}</div>
        </div>
        <button className="icon-btn" aria-label="Close panel" onClick={() => set({ region: null, panel: null })}>✕</button>
      </header>
      {loading && <div className="chart-skel"><span /></div>}
      {!loading && !ok && <p className="empty">No scatterers here. PS points need stable reflectors: buildings, rock, roads.</p>}
      {ok && (
        <>
          <div className="pp-vel">
            <div className="vel-num mono" style={{ color: region.vel_median! < -1 ? 'var(--away)' : 'var(--text)' }}>{signed((region.vel_median! - (reference?.vel ?? 0)) * vf)}</div>
            <div className="vel-meta"><span className="unit">mm/yr median</span><span className="lbl">mean {signed(region.vel_mean!)} · σ {region.vel_std?.toFixed(1)}</span></div>
          </div>
          <div className="chips">
            <div className="stat-chip"><span className="k">Range</span><span className="v mono">{signed(region.vel_min!)} … {signed(region.vel_max!)}</span><span className="u">mm/yr</span></div>
            <div className="stat-chip"><span className="k">Faster than −10</span><span className="v mono">{((region.n_fast_away! / region.n) * 100).toFixed(1)}%</span><span className="u">{region.n_fast_away!.toLocaleString()} pts</span></div>
            <div className="stat-chip"><span className="k">Seasonal</span><span className="v mono">{region.seas_mean!.toFixed(1)}</span><span className="u">mm mean amp.</span></div>
            <div className="stat-chip"><span className="k">Noise</span><span className="v mono">{region.rmse_mean!.toFixed(1)}</span><span className="u">mm mean rmse</span></div>
          </div>
          <div className="chart-card">
            <div className="chart-head"><span className="eyebrow">Velocity distribution</span><span className="mono small muted">mm/yr</span></div>
            <svg className="mini-hist" viewBox="0 0 340 70" preserveAspectRatio="none">
              {region.hist!.map(([bin, n]) => {
                const x = ((bin + 60) / 85) * 340;
                const t = (bin + 0.5 - lo) / (hi - lo);
                const c = specColor(spec, t);
                return <rect key={bin} x={x} width={340 / 85 - 0.6} y={70 - (n / maxH) * 66} height={(n / maxH) * 66} fill={`rgb(${c.join(',')})`} />;
              })}
            </svg>
            <div className="hist-axis mono"><span>−60</span><span>−30</span><span>0</span><span>+25</span></div>
          </div>
          <div className="chart-card">
            <div className="chart-head"><span className="eyebrow">Median displacement · p10–p90 band</span><span className="mono small muted">mm</span></div>
            <SeriesChart dates={dates} t={meta.t} unit="mm"
              items={[{ key: 'median', color: '#FFB547', values: tr(region.p50!), primary: true }]}
              band={{ lo: tr(region.p10!), hi: tr(region.p90!), label: 'p10–p90' }}
              show={{ trend: false, seasonal: false, band: false, context: true }} />
          </div>
          <div className="top-list">
            <div className="eyebrow">Fastest moving away</div>
            {region.top!.slice(0, 8).map((t) => (
              <button key={t.pid} className="top-row" onClick={() => { selectPoint(t.pid); set({ flyTo: { lon: t.lon, lat: t.lat, zoom: 16, t: Date.now() } }); }}>
                <span className="mono">#{t.pid}</span><span className="mono away">{signed(t.vel)} mm/yr</span><span className="mono muted">{signed(t.accel, 2)} mm/yr²</span>
              </button>
            ))}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => downloadCsv(region.polygon)}>⇩ Export CSV (all epochs)</button>
          </div>
        </>
      )}
    </div>
  );
}

export function ProfilePanel() {
  const profile = useStore((s) => s.profile);
  const theme = useStore((s) => s.theme);
  const ranges = useStore((s) => s.ranges);
  const set = useStore((s) => s.set);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const spec = colorSpec({ ...state, mode: 'velocity' });
  const [lo, hi] = ranges.velocity;
  const W = 340;
  const H = 200;

  const geom = useMemo(() => {
    if (!profile || !profile.n) return null;
    let vmin = Infinity; let vmax = -Infinity;
    for (const v of profile.vel) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
    const pad = Math.max((vmax - vmin) * 0.08, 2);
    vmin -= pad; vmax += pad;
    const L = profile.length;
    const X = (s: number) => 36 + (s / L) * (W - 44);
    const Y = (v: number) => 8 + (1 - (v - vmin) / (vmax - vmin)) * (H - 30);
    const bins = 60;
    const acc: number[][] = Array.from({ length: bins }, () => []);
    profile.s.forEach((s, i) => acc[Math.min(bins - 1, Math.floor((s / L) * bins))].push(profile.vel[i]));
    const med = acc.map((a, i) => {
      if (a.length < 3) return null;
      const srt = [...a].sort((p, q) => p - q);
      return [X(((i + 0.5) / bins) * L), Y(srt[Math.floor(srt.length / 2)])];
    }).filter(Boolean) as number[][];
    return { X, Y, vmin, vmax, L, med };
  }, [profile]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !profile || !geom) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < profile.n; i++) {
      const t = (profile.vel[i] - lo) / (hi - lo);
      const col = specColor(spec, t);
      ctx.fillStyle = `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},0.9)`;
      ctx.strokeStyle = 'rgba(128,128,128,0.35)';
      ctx.beginPath();
      ctx.arc(geom.X(profile.s[i]), geom.Y(profile.vel[i]), 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }, [profile, geom, lo, hi, spec.cmap, spec.reverse, spec.steps]);

  if (!profile) {
    return (
      <div className="panel-inner">
        <header className="pp-head"><div><div className="eyebrow">Profile</div><div className="coords mono">Querying…</div></div></header>
        <div className="chart-skel"><span /></div>
      </div>
    );
  }
  const ticks = geom ? [0, 0.25, 0.5, 0.75, 1].map((f) => f * geom.L) : [];
  const yt = geom ? [geom.vmin, (geom.vmin + geom.vmax) / 2, geom.vmax] : [];

  return (
    <div className="panel-inner">
      <header className="pp-head">
        <div>
          <div className="eyebrow">Profile · ±{profile.width} m corridor</div>
          <div className="coords mono">{(profile.length / 1000).toFixed(2)} km · {profile.n.toLocaleString()} scatterers</div>
        </div>
        <button className="icon-btn" aria-label="Close panel" onClick={() => set({ profile: null, panel: null })}>✕</button>
      </header>
      {!geom && <p className="empty">No scatterers in this corridor.</p>}
      {geom && (
        <div className="chart-card">
          <div className="chart-head"><span className="eyebrow">Velocity along profile</span><span className="mono small muted">mm/yr</span></div>
          <div className="profile-plot" style={{ width: W, height: H }}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const s = ((e.clientX - r.left - 36) / (W - 44)) * geom.L;
              let best = 0; let bd = Infinity;
              profile.s.forEach((v, i) => { const d = Math.abs(v - s); if (d < bd) { bd = d; best = i; } });
              setHover(best);
            }}
            onPointerLeave={() => setHover(null)}
            onClick={() => { if (hover !== null) selectPoint(profile.pid[hover]); }}>
            <canvas ref={canvas} style={{ width: W, height: H }} />
            <svg width={W} height={H}>
              {yt.map((v) => (<g key={v}><line x1={36} x2={W - 8} y1={geom.Y(v)} y2={geom.Y(v)} className="grid-h" /><text x={30} y={geom.Y(v)} dy="0.32em" textAnchor="end" className="axis-label">{v.toFixed(0)}</text></g>))}
              {geom.vmin < 0 && geom.vmax > 0 && <line x1={36} x2={W - 8} y1={geom.Y(0)} y2={geom.Y(0)} className="grid-zero" />}
              {ticks.map((s) => (<text key={s} x={geom.X(s)} y={H - 6} textAnchor="middle" className="axis-label">{(s / 1000).toFixed(1)}</text>))}
              <path d={`M${geom.med.map((p) => p.join(',')).join('L')}`} className="profile-median" />
              {hover !== null && <circle cx={geom.X(profile.s[hover])} cy={geom.Y(profile.vel[hover])} r={4.5} fill="none" stroke="#FFB547" strokeWidth={2} />}
            </svg>
          </div>
          <div className="hist-axis mono"><span>A</span><span>distance (km) · amber = running median</span><span>B</span></div>
          {hover !== null && <div className="mono small">#{profile.pid[hover]} · {profile.vel[hover].toFixed(1)} mm/yr at {(profile.s[hover] / 1000).toFixed(2)} km · click to open</div>}
        </div>
      )}
    </div>
  );
}
