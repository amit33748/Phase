import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type Basemap } from '../lib/store';
import { loadHex, type HexCell } from '../lib/data';
import { computeViewStats } from '../map/MapView';

const signed = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

function Range({ min, max, step, value, onChange, fmt }: { min: number; max: number; step: number; value: [number, number]; onChange: (v: [number, number]) => void; fmt: (v: number) => string }) {
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  return (
    <div className="range2">
      <div className="range2-track"><i style={{ left: `${pct(value[0])}%`, right: `${100 - pct(value[1])}%` }} /></div>
      <input type="range" min={min} max={max} step={step} value={value[0]} aria-label="Minimum"
        onChange={(e) => onChange([Math.min(Number(e.target.value), value[1] - step), value[1]])} />
      <input type="range" min={min} max={max} step={step} value={value[1]} aria-label="Maximum"
        onChange={(e) => onChange([value[0], Math.max(Number(e.target.value), value[0] + step)])} />
      <div className="range2-labels mono"><span>{fmt(value[0])}</span><span>{fmt(value[1])}</span></div>
    </div>
  );
}

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`rail-sec ${open ? 'open' : ''}`}>
      <button className="rail-title" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{title}</span><svg viewBox="0 0 10 10"><path d="M2 4l3 3 3-3" /></svg>
      </button>
      {open && <div className="rail-body">{children}</div>}
    </section>
  );
}

export default function LeftRail() {
  const s = useStore(useShallow((st) => ({
    meta: st.meta, set: st.set, viewStats: st.viewStats, velFilter: st.velFilter, qualityMin: st.qualityMin,
    reference: st.reference, tool: st.tool, vertical: st.vertical, incidence: st.incidence, aggregate: st.aggregate,
    extrude: st.extrude, basemap: st.basemap, railOpen: st.railOpen
  })));
  const { meta, set } = s;
  const [hot, setHot] = useState<HexCell[] | null>(null);
  if (!meta) return null;
  const vs = s.viewStats;

  const findHotspots = async () => {
    const h = await loadHex(8);
    set({ hex: { ...useStore.getState().hex, 8: h } });
    const b = useStore.getState().bounds;
    const { cellToLatLng } = await import('h3-js');
    const inView = h.cells.filter((c) => {
      if (c.n < 30) return false;
      if (!b) return true;
      const [lat, lon] = cellToLatLng(c.h3);
      return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
    });
    inView.sort((a, b2) => a.vel - b2.vel);
    const picked: HexCell[] = [];
    const cent: [number, number][] = [];
    for (const c of inView) {
      const [lat, lon] = cellToLatLng(c.h3);
      if (cent.some(([x, y]) => Math.hypot((x - lon) * 0.87, y - lat) < 0.03)) continue;
      picked.push(c); cent.push([lon, lat]);
      if (picked.length === 8) break;
    }
    setHot(picked);
  };
  const flyHex = async (c: HexCell) => {
    const { cellToLatLng } = await import('h3-js');
    const [lat, lon] = cellToLatLng(c.h3);
    set({ flyTo: { lon, lat, zoom: 14.5, t: Date.now() } });
  };

  const basemaps: { id: Basemap; label: string }[] = [
    { id: 'dark', label: 'Graphite' }, { id: 'light', label: 'Paper' }, { id: 'satellite', label: 'Imagery' }, { id: 'topo', label: 'Topo' }
  ];

  return (
    <aside className={`rail ${s.railOpen ? '' : 'closed'}`}>
      <div className="rail-scroll">
        <div className="kpis">
          <div className="kpi"><span className="k">In view</span><span className="v mono">{vs ? vs.n.toLocaleString() : '—'}</span></div>
          <div className="kpi"><span className="k">Mean</span><span className="v mono">{vs ? signed(vs.mean) : '—'}<em>mm/yr</em></span></div>
          <div className="kpi"><span className="k">&lt; −10 mm/yr</span><span className="v mono away">{vs ? `${(vs.away10 * 100).toFixed(1)}%` : '—'}</span></div>
          <div className="kpi"><span className="k">&gt; +10 mm/yr</span><span className="v mono toward">{vs ? `${(vs.toward10 * 100).toFixed(1)}%` : '—'}</span></div>
        </div>

        <Section title="Filter">
          <label className="field-label">Velocity <span className="mono muted">mm/yr</span></label>
          <Range min={-60} max={25} step={0.5} value={s.velFilter} onChange={(v) => set({ velFilter: v })} fmt={(v) => signed(v)} />
          <label className="field-label">Minimum quality <span className="mono muted">{s.qualityMin}</span></label>
          <input className="slider" type="range" min={0} max={250} step={5} value={s.qualityMin} onChange={(e) => set({ qualityMin: Number(e.target.value) })} />
          <p className="hint">Quality ranks each point by its fit residual (255 = cleanest) with a penalty per outlier epoch. 128 hides the noisier half.</p>
        </Section>

        <Section title="Reference">
          <div className="ref-now">
            <span className={`ref-dot ${s.reference ? 'on' : ''}`}>◆</span>
            <div>
              <div>{s.reference ? s.reference.label : 'Scene mean'}</div>
              <div className="hint">{s.reference ? `${signed(s.reference.vel, 2)} mm/yr subtracted everywhere` : 'StaMPS default · no GNSS tie'}</div>
            </div>
            {s.reference && <button className="icon-btn sm" aria-label="Clear reference" onClick={() => { set({ reference: null }); computeViewStats(); }}>✕</button>}
          </div>
          <div className="btn-row">
            <button className={`btn ${s.tool === 'reference' ? 'on' : ''}`} onClick={() => set({ tool: s.tool === 'reference' ? 'none' : 'reference' })}>
              {s.tool === 'reference' ? 'Click a point or ◇' : 'Pick on map'}
            </button>
          </div>
          <div className="cand-list">
            <div className="field-label">Stable-area candidates</div>
            {meta.refCandidates.slice(0, 6).map((c, i) => (
              <button key={c.h3} className={`cand ${s.reference?.id === c.h3 ? 'on' : ''}`}
                onClick={() => { set({ reference: { kind: 'candidate', id: c.h3, label: `R${i + 1}`, vel: c.vel_mean, series: c.series, lon: c.lon, lat: c.lat }, flyTo: { lon: c.lon, lat: c.lat, zoom: 13, t: Date.now() } }); computeViewStats(); }}>
                <span className="mono">R{i + 1}</span>
                <span className="mono">{signed(c.vel_mean, 2)}</span>
                <span className="muted">{c.n} pts · σ {c.vel_std.toFixed(1)}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Tools">
          <div className="tool-grid">
            <button className={`tool ${s.tool === 'lasso' ? 'on' : ''}`} onClick={() => set({ tool: s.tool === 'lasso' ? 'none' : 'lasso', draft: [] })}>
              <svg viewBox="0 0 20 20"><path d="M4 6l7-3 6 5-3 8-9-2z" /></svg><span>Region</span><kbd>L</kbd>
            </button>
            <button className={`tool ${s.tool === 'profile' ? 'on' : ''}`} onClick={() => set({ tool: s.tool === 'profile' ? 'none' : 'profile', draft: [] })}>
              <svg viewBox="0 0 20 20"><path d="M3 15L17 5" /><circle cx="3" cy="15" r="1.8" /><circle cx="17" cy="5" r="1.8" /></svg><span>Profile</span><kbd>P</kbd>
            </button>
            <button className="tool" onClick={findHotspots}>
              <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3.5" /><circle cx="10" cy="10" r="0.8" /></svg><span>Hotspots</span><kbd>H</kbd>
            </button>
          </div>
          {s.tool === 'lasso' && <p className="hint accent">Click to add vertices · click the first vertex or double-click to finish · Esc cancels</p>}
          {s.tool === 'profile' && <p className="hint accent">Click start and end of the cross-section</p>}
          {hot && (
            <div className="hot-list">
              {hot.length === 0 && <p className="hint">No dense cells in view.</p>}
              {hot.map((c, i) => (
                <button key={c.h3} className="top-row" onClick={() => flyHex(c)}>
                  <span className="mono muted">{i + 1}</span><span className="mono away">{signed(c.vel)} mm/yr</span><span className="muted">{c.n} pts</span>
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section title="Display">
          <label className="switch">
            <input type="checkbox" checked={s.vertical} onChange={(e) => set({ vertical: e.target.checked })} />
            <span className="sw" /> <span>≈ Vertical <em className="muted">(LOS ÷ cos θ)</em></span>
          </label>
          {s.vertical && (
            <div className="inc">
              <label className="field-label">Incidence θ <span className="mono">{s.incidence}°</span></label>
              <input className="slider" type="range" min={29} max={46} step={1} value={s.incidence} onChange={(e) => set({ incidence: Number(e.target.value) })} />
              <p className="hint">Assumes purely vertical motion. Ascending pass: eastward motion also reads as "toward".</p>
            </div>
          )}
          <label className="switch">
            <input type="checkbox" checked={s.aggregate} onChange={(e) => set({ aggregate: e.target.checked })} />
            <span className="sw" /> <span>H3 hexes below zoom 10</span>
          </label>
          <label className="switch">
            <input type="checkbox" checked={s.extrude} onChange={(e) => set({ extrude: e.target.checked, aggregate: e.target.checked ? true : s.aggregate })} />
            <span className="sw" /> <span>3D extrusion</span>
          </label>
          <div className="field-label">Basemap</div>
          <div className="seg full">
            {basemaps.map((b) => <button key={b.id} className={s.basemap === b.id ? 'on' : ''} onClick={() => set({ basemap: b.id })}>{b.label}</button>)}
          </div>
        </Section>

        <Section title="About the data" defaultOpen={false}>
          <dl className="about">
            <dt>Sensor</dt><dd>Sentinel-1 C-band · ascending</dd>
            <dt>Processing</dt><dd>StaMPS persistent scatterers</dd>
            <dt>Scatterers</dt><dd className="mono">{meta.count.toLocaleString()}</dd>
            <dt>Epochs</dt><dd className="mono">{meta.epochs} · {meta.dates[0]} → {meta.dates[meta.epochs - 1]}</dd>
            <dt>Master ≈</dt><dd className="mono">{meta.master_estimate}</dd>
            <dt>Reference</dt><dd>scene mean (relative values)</dd>
            <dt>Sign</dt><dd>negative = away from satellite</dd>
            <dt>Storage</dt><dd>GeoParquet 1.1 · Hilbert-sorted · ZSTD</dd>
          </dl>
        </Section>
      </div>
    </aside>
  );
}
