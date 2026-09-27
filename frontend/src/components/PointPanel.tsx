import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import SeriesChart, { type SeriesItem } from '../chart/SeriesChart';
import { basisIndex, COMPARE_COLORS, useStore, verticalFactor } from '../lib/store';
import { fetchPoint, type PointRecord } from '../lib/data';
import { selectPoint, setReferencePoint } from '../map/MapView';

const EASE = [0.16, 1, 0.3, 1] as const;

function useCountUp(target: number, ms = 750) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min((now - start) / ms, 1);
      const e = 1 - Math.pow(1 - p, 4);
      const cur = a + (target - a) * e;
      setV(cur);
      from.current = cur;
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const signed = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

function modelRaw(r: PointRecord, t: number, seasonal: boolean) {
  const f = r.fit;
  const dt = t - f.tc;
  let v = f.c0 + f.vel * dt + 0.5 * f.accel * dt * dt;
  if (seasonal) v += f.seas_sin * Math.sin(2 * Math.PI * t) + f.seas_cos * Math.cos(2 * Math.PI * t);
  return v;
}

export default function PointPanel() {
  const meta = useStore((s) => s.meta)!;
  const selected = useStore((s) => s.selected);
  const compare = useStore((s) => s.compare);
  const points = useStore((s) => s.points);
  const reference = useStore((s) => s.reference);
  const basis = useStore((s) => s.basis);
  const vertical = useStore((s) => s.vertical);
  const incidence = useStore((s) => s.incidence);
  const epochF = useStore((s) => s.epochF);
  const mode = useStore((s) => s.mode);
  const set = useStore((s) => s.set);
  const [show, setShow] = useState({ trend: true, seasonal: true, band: true, context: true });
  const [copied, setCopied] = useState(false);

  const rec = selected !== null ? points[selected] : undefined;
  const b = basisIndex({ basis, meta });
  const vf = verticalFactor({ vertical, incidence });
  const dates = useMemo(() => meta.dates.map((d) => new Date(`${d}T00:00:00Z`)), [meta]);
  const events = useMemo(() => meta.events.map((e) => ({ date: new Date(`${e.date}T00:00:00Z`), label: e.label })), [meta]);

  useEffect(() => { compare.forEach((pid) => { if (!points[pid]) fetchPoint(pid).then((r) => set({ points: { ...useStore.getState().points, [pid]: r } })); }); }, [compare]);

  const refRe = (i: number) => (reference ? reference.series[i] - reference.series[b] : 0);
  const refAtT = (t: number) => {
    if (!reference) return 0;
    const ts = meta.t;
    if (t <= ts[0]) return refRe(0);
    for (let i = 1; i < ts.length; i++) if (t <= ts[i]) return refRe(i - 1) + ((refRe(i) - refRe(i - 1)) * (t - ts[i - 1])) / (ts[i] - ts[i - 1]);
    return refRe(ts.length - 1);
  };
  const disp = (r: PointRecord) => r.series.map((v, i) => (v - r.series[b] - refRe(i)) * vf);

  const items: SeriesItem[] = [];
  if (rec) {
    const full = (t: number) => modelRaw(rec, t, true);
    const outliers = rec.series.map((v, i) => Math.abs(v - full(meta.t[i])) > 3 * rec.rmse);
    items.push({ key: 'primary', color: COMPARE_COLORS[0], values: disp(rec), primary: true, outliers, label: `pid ${rec.pid}` });
  }
  compare.forEach((pid, i) => {
    const r = points[pid];
    if (r) items.push({ key: `c${pid}`, color: COMPARE_COLORS[(i + 1) % COMPARE_COLORS.length], values: disp(r), label: `pid ${pid}` });
  });

  const model = rec ? {
    full: (t: number) => (modelRaw(rec, t, true) - rec.series[b] - refAtT(t)) * vf,
    trend: (t: number) => (modelRaw(rec, t, false) - rec.series[b] - refAtT(t)) * vf,
    rmse: rec.rmse * vf
  } : null;
  const contextOk = rec?.context?.p10 && basis === 'first' && !reference;
  const band = contextOk ? {
    lo: rec!.context!.p10!.map((v) => v * vf), hi: rec!.context!.p90!.map((v) => v * vf),
    label: `p10–p90 of ${rec!.context!.n} neighbours within ${rec!.context!.radius} m`
  } : null;

  const velShown = rec ? (rec.vel_avg - (reference?.vel ?? 0)) * vf : 0;
  const velAnim = useCountUp(velShown);
  const base = useStore((s) => s.base);

  if (selected === null) return null;
  const quick = base ? base.vel[selected] : 0;

  const copy = () => {
    if (!rec) return;
    navigator.clipboard?.writeText(JSON.stringify({ ...rec, dates: meta.dates }, null, 1));
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const downloadCsv = () => {
    if (!rec) return;
    const rows = ['date,los_mm,rebased_mm,model_mm', ...meta.dates.map((d, i) => `${d},${rec.series[i].toFixed(3)},${(rec.series[i] - rec.series[b]).toFixed(3)},${modelRaw(rec, meta.t[i], true).toFixed(3)}`)];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
    a.download = `phase_pid_${rec.pid}.csv`;
    a.click();
  };

  const chips = rec ? [
    { k: 'σ velocity', v: `±${(rec.vel_sigma * vf).toFixed(2)}`, u: 'mm/yr' },
    { k: 'Last 2 yr', v: signed((rec.vel_recent - (reference?.vel ?? 0)) * vf), u: 'mm/yr' },
    { k: 'Acceleration', v: signed(rec.fit.accel, 2), u: 'mm/yr²' },
    { k: 'Seasonal', v: rec.seas_amp.toFixed(1), u: `mm · peak ${MONTHS[Math.min(11, Math.floor((rec.seas_peak_doy / 365.25) * 12))]}` },
    { k: 'Total', v: signed(rec.disp_total * vf), u: 'mm' },
    { k: 'Fit', v: `r² ${rec.r2.toFixed(2)}`, u: `rmse ${rec.rmse.toFixed(1)} mm` },
    { k: 'Quality', v: String(rec.quality), u: `${rec.n_outliers} outlier epoch${rec.n_outliers === 1 ? '' : 's'}` },
    { k: 'StaMPS vs fit', v: signed(rec.fit.vel), u: 'mm/yr (LSQ)' }
  ] : [];

  return (
    <div className="panel-inner">
      <header className="pp-head">
        <div>
          <div className="eyebrow">Scatterer <span className="mono">#{selected}</span>{rec && rec.dup_n > 1 && <span className="badge">{rec.dup_n} at this spot</span>}</div>
          <div className="coords mono">{rec ? `${rec.lat.toFixed(5)}° N  ${rec.lon.toFixed(5)}° E` : '…'}</div>
        </div>
        <button className="icon-btn" aria-label="Close panel" onClick={() => set({ selected: null, panel: null, compare: [] })}>✕</button>
      </header>

      <div className="pp-vel">
        <div className="vel-num mono" style={{ color: velShown < -1 ? 'var(--away)' : velShown > 1 ? 'var(--toward)' : 'var(--text)' }}>
          {signed(rec ? velAnim : quick * vf)}
        </div>
        <div className="vel-meta">
          <span className="unit">mm/yr</span>
          <span className="dir">{velShown < 0 ? 'away from satellite' : 'toward satellite'}</span>
          <span className="lbl">{vertical ? `≈ vertical (θ ${incidence}°)` : 'LOS'} · {reference ? `ref ${reference.label}` : 'rel. scene mean'}</span>
        </div>
      </div>

      {rec?.duplicates && (
        <div className="dups">
          {rec.duplicates.map((d) => (
            <button key={d.pid} className={`chip-btn ${d.pid === selected ? 'on' : ''}`} onClick={() => selectPoint(d.pid)}>
              #{d.pid} <span className="mono">{signed(d.vel_avg)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="chart-card">
        <div className="chart-head">
          <span className="eyebrow">Displacement · {basis === 'first' ? `since ${meta.dates[0].slice(0, 4)}` : `vs master ${meta.master_estimate}`}</span>
          <span className="mono small muted">mm {vertical ? '≈ vert' : 'LOS'}</span>
        </div>
        {rec ? (
          <SeriesChart
            dates={dates} t={meta.t} items={items} model={model} band={band} show={show} events={events}
            cursorEpoch={mode === 'displacement' || mode === 'phase' ? epochF : null} unit="mm"
          />
        ) : <div className="chart-skel"><span /></div>}
        <div className="toggles">
          {([['trend', 'Trend'], ['seasonal', 'Seasonal model'], ['band', '± rmse']] as const).map(([k, l]) => (
            <button key={k} className={`tog ${show[k] ? 'on' : ''}`} onClick={() => setShow({ ...show, [k]: !show[k] })}>{l}</button>
          ))}
          <button className={`tog ${show.context && contextOk ? 'on' : ''}`} disabled={!contextOk} title={contextOk ? band!.label : 'Neighbour band only in "since first epoch" without reference'}
            onClick={() => setShow({ ...show, context: !show.context })}>Neighbours</button>
          <span className="spacer" />
          <div className="seg">
            <button className={basis === 'first' ? 'on' : ''} onClick={() => set({ basis: 'first' })}>t₀</button>
            <button className={basis === 'master' ? 'on' : ''} onClick={() => set({ basis: 'master' })} title={`StaMPS master ≈ ${meta.master_estimate}`}>master</button>
          </div>
        </div>
      </div>

      <div className="chips">
        {chips.map((c, i) => (
          <motion.div key={c.k} className="stat-chip" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.95 + i * 0.04, duration: 0.4, ease: EASE }}>
            <span className="k">{c.k}</span><span className="v mono">{c.v}</span><span className="u">{c.u}</span>
          </motion.div>
        ))}
      </div>

      {compare.length > 0 && (
        <div className="compare-list">
          <div className="eyebrow">Compare</div>
          {compare.map((pid, i) => (
            <div key={pid} className="cmp-row">
              <i style={{ background: COMPARE_COLORS[(i + 1) % COMPARE_COLORS.length] }} />
              <button className="link mono" onClick={() => selectPoint(pid)}>#{pid}</button>
              <span className="mono muted">{points[pid] ? `${signed(points[pid].vel_avg)} mm/yr` : '…'}</span>
              <button className="icon-btn sm" aria-label="Remove" onClick={() => set({ compare: compare.filter((p) => p !== pid) })}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="actions">
        <button className="btn" disabled={compare.length >= 5 || compare.includes(selected)} onClick={() => set({ compare: [...compare, selected] })} title="Keep this series; the next click adds a new one (or shift-click on the map)">⊕ Compare</button>
        <button className="btn" onClick={() => setReferencePoint(selected)}>◆ Set as reference</button>
        <button className="btn" onClick={downloadCsv}>⇩ CSV</button>
        <button className="btn" onClick={copy}>{copied ? '✓ Copied' : '⧉ JSON'}</button>
      </div>
      <p className="footnote">Tip: shift-click points on the map to compare up to 6 series. Hollow dots are epochs more than 3× rmse from the model.</p>
    </div>
  );
}
