import { motion, AnimatePresence } from 'motion/react';
import { useStore } from '../lib/store';

/** Ascending-pass geometry: flight heading ≈ −10°, right-looking → LOS azimuth ≈ 80°. */
export function LosCompass() {
  const meta = useStore((s) => s.meta)!;
  const incidence = useStore((s) => s.incidence);
  const vertical = useStore((s) => s.vertical);
  const h = meta.heading_deg;
  const look = meta.look_azimuth_deg;
  const R = 30;
  const pt = (deg: number, r: number) => [44 + r * Math.sin((deg * Math.PI) / 180), 44 - r * Math.cos((deg * Math.PI) / 180)];
  const [fx, fy] = pt(h, R);
  const [bx, by] = pt(h + 180, R * 0.55);
  const [lx, ly] = pt(look, R);
  return (
    <div className="compass" title="Sentinel-1 ascending: satellite flies ≈ north (heading −10°) and looks right, toward ≈ 80° (ENE). LOS is nearly blind to north–south motion.">
      <svg viewBox="0 0 88 88" width="88" height="88" aria-label="Line-of-sight geometry">
        <circle cx="44" cy="44" r="36" className="ring" />
        {[0, 90, 180, 270].map((d) => { const [x1, y1] = pt(d, 33); const [x2, y2] = pt(d, 38); return <line key={d} x1={x1} y1={y1} x2={x2} y2={y2} className="tick" />; })}
        <text x="44" y="6.5" textAnchor="middle" className="n">N</text>
        <line x1={bx} y1={by} x2={fx} y2={fy} className="flight" />
        <path d={`M${fx} ${fy} l-3.5 6 h7z`} className="flight-head" transform={`rotate(${h} ${fx} ${fy})`} />
        <line x1="44" y1="44" x2={lx} y2={ly} className="los" />
        <circle cx={lx} cy={ly} r="3" className="los-head" />
        <circle cx="44" cy="44" r="2" className="sat" />
      </svg>
      <div className="compass-meta mono">
        <span>ASC</span>
        <span>LOS {look}°</span>
        <span className={vertical ? 'accent' : ''}>θ {incidence}°</span>
      </div>
    </div>
  );
}

/** Interferometric fringe sweep while the scatterer buffer streams in. */
export function StreamingOverlay() {
  const fraction = useStore((s) => s.loadFraction);
  const meta = useStore((s) => s.meta);
  const done = fraction >= 1;
  return (
    <AnimatePresence>
      {!done && meta && (
        <motion.div className="streaming" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.9 } }}>
          <div className="fringe-sweep" />
          <div className="stream-card">
            <div className="mono">Streaming {meta.count.toLocaleString()} scatterers</div>
            <div className="stream-bar"><i style={{ width: `${Math.round(fraction * 100)}%` }} /></div>
            <div className="mono muted small">{Math.round(fraction * 100)}% · Hilbert order · GeoParquet → Arrow → GPU</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Splash({ error }: { error?: string | null }) {
  return (
    <div className="splash">
      <svg viewBox="0 0 120 120" className="splash-logo" aria-hidden>
        {[52, 40, 28, 16].map((r, i) => <circle key={r} cx="60" cy="60" r={r} style={{ animationDelay: `${i * 0.18}s` }} />)}
      </svg>
      <div className="splash-word">PHASE</div>
      <div className="splash-sub mono">{error ? `API unreachable: ${error}` : 'PSInSAR line-of-sight deformation'}</div>
    </div>
  );
}
