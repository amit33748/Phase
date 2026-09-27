import { useEffect, useMemo, useRef, useState } from 'react';
import { MODES, useStore } from '../lib/store';
import { selectPoint } from '../map/MapView';

// Towns inside the scene footprint (lon 75.6–78.0, lat 27.4–31.3)
const PLACES: [string, number, number][] = [
  ['New Delhi', 77.209, 28.614], ['Gurugram', 77.026, 28.459], ['Faridabad', 77.317, 28.408], ['Noida', 77.391, 28.535],
  ['Ghaziabad', 77.454, 28.669], ['Chandigarh', 76.779, 30.733], ['Mohali', 76.717, 30.704], ['Zirakpur', 76.818, 30.643],
  ['Panchkula', 76.860, 30.695], ['Ambala', 76.777, 30.378], ['Ludhiana', 75.857, 30.901], ['Patiala', 76.387, 30.340],
  ['Karnal', 76.990, 29.686], ['Panipat', 76.968, 29.391], ['Sonipat', 77.016, 28.993], ['Rohtak', 76.606, 28.895],
  ['Kurukshetra', 76.878, 29.969], ['Yamunanagar', 77.288, 30.129], ['Saharanpur', 77.545, 29.964], ['Meerut', 77.706, 28.984],
  ['Muzaffarnagar', 77.703, 29.473], ['Baghpat', 77.218, 28.944], ['Bahadurgarh', 76.924, 28.692], ['Jhajjar', 76.656, 28.607],
  ['Rewari', 76.619, 28.197], ['Manesar', 76.938, 28.358], ['Palwal', 77.326, 28.144], ['Bhiwani', 76.134, 28.799],
  ['Jind', 76.316, 29.316], ['Kaithal', 76.399, 29.801], ['Sangrur', 75.844, 30.245], ['Rajpura', 76.595, 30.484],
  ['Shimla', 77.173, 31.105], ['Solan', 77.110, 30.905], ['Alwar', 76.604, 27.553], ['Mathura', 77.673, 27.492],
  ['Bulandshahr', 77.849, 28.407], ['Greater Noida', 77.504, 28.474], ['Hapur', 77.776, 28.731], ['Narnaul', 76.110, 28.044]
];

type Hit = { label: string; sub: string; go: () => void };

export default function TopBar() {
  const mode = useStore((s) => s.mode);
  const theme = useStore((s) => s.theme);
  const meta = useStore((s) => s.meta);
  const railOpen = useStore((s) => s.railOpen);
  const set = useStore((s) => s.set);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hits: Hit[] = useMemo(() => {
    const s = q.trim();
    if (!s) return [];
    const out: Hit[] = [];
    const nums = s.match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
    const pidM = s.match(/^(?:pid:?|#)\s*(\d+)$/i) || (nums.length === 1 && /^\d+$/.test(s) ? [s, s] : null);
    if (pidM && meta && Number(pidM[1]) < meta.count) {
      const pid = Number(pidM[1]);
      out.push({ label: `Scatterer #${pid}`, sub: 'open time series', go: () => {
        const b = useStore.getState().base;
        selectPoint(pid);
        if (b && pid < b.loaded) set({ flyTo: { lon: b.positions[2 * pid], lat: b.positions[2 * pid + 1], zoom: 16, t: Date.now() } });
      } });
    }
    if (nums.length === 2 && /[.,\s]/.test(s)) {
      let [a, b] = nums;
      if (a > 60 && b < 60) [a, b] = [b, a]; // accept "lon, lat" too
      out.push({ label: `${a.toFixed(5)}° N, ${b.toFixed(5)}° E`, sub: 'go to coordinates', go: () => set({ flyTo: { lon: b, lat: a, zoom: 15, t: Date.now() } }) });
    }
    const low = s.toLowerCase();
    PLACES.filter(([n]) => n.toLowerCase().includes(low))
      .sort((x, y) => Number(!x[0].toLowerCase().startsWith(low)) - Number(!y[0].toLowerCase().startsWith(low)))
      .slice(0, 6)
      .forEach(([n, lon, lat]) => out.push({ label: n, sub: `${lat.toFixed(2)}° N ${lon.toFixed(2)}° E`, go: () => set({ flyTo: { lon, lat, zoom: 12.5, t: Date.now() } }) }));
    return out;
  }, [q, meta, set]);

  const go = (h?: Hit) => { if (!h) return; h.go(); setOpen(false); setQ(''); input.current?.blur(); };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('phase-theme', next); } catch { /* private mode */ }
    set({ theme: next, basemap: next === 'dark' ? 'dark' : 'light' });
  };

  return (
    <header className="topbar">
      <div className="brand">
        <button className="icon-btn rail-toggle" aria-label="Toggle side panel" onClick={() => set({ railOpen: !railOpen })}>
          <svg viewBox="0 0 20 20"><path d="M3 5h14M3 10h14M3 15h9" /></svg>
        </button>
        <svg className="logo" viewBox="0 0 32 32" aria-hidden>
          <circle cx="16" cy="16" r="12.5" className="f1" /><circle cx="16" cy="16" r="8.3" className="f2" /><circle cx="16" cy="16" r="4.2" className="f3" />
        </svg>
        <div className="wordmark">
          <b>PHASE</b>
          <span>Sentinel-1 · ASC · StaMPS PS</span>
        </div>
      </div>

      <nav className="modes" aria-label="Map mode">
        {MODES.map((m) => (
          <button key={m.id} className={`mode ${mode === m.id ? 'on' : ''}`} onClick={() => set({ mode: m.id })} title={`${m.label} (${m.key})`}>
            <span className="full">{m.label}</span><span className="short">{m.short}</span>
          </button>
        ))}
      </nav>

      <div className="search">
        <svg viewBox="0 0 20 20" aria-hidden><circle cx="9" cy="9" r="5.5" /><path d="M13 13l4 4" /></svg>
        <input ref={input} value={q} placeholder="Place, lat, lon or #pid" aria-label="Search"
          onChange={(e) => { setQ(e.target.value); setOpen(true); setIdx(0); }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(Math.min(idx + 1, hits.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(Math.max(idx - 1, 0)); }
            if (e.key === 'Enter') go(hits[idx]);
            if (e.key === 'Escape') { setQ(''); input.current?.blur(); }
          }} />
        <kbd>/</kbd>
        {open && hits.length > 0 && (
          <ul className="search-results">
            {hits.map((h, i) => (
              <li key={h.label} className={i === idx ? 'on' : ''} onMouseDown={() => go(h)} onMouseEnter={() => setIdx(i)}>
                <span>{h.label}</span><em>{h.sub}</em>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button className="icon-btn theme" aria-label="Toggle theme" onClick={toggleTheme}>
        {theme === 'dark'
          ? <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.5" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" /></svg>
          : <svg viewBox="0 0 20 20"><path d="M16 12.5A6.5 6.5 0 017.5 4a6.5 6.5 0 108.5 8.5z" /></svg>}
      </button>
    </header>
  );
}
