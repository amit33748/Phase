import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import MapView, { selectPoint } from './map/MapView';
import TopBar from './components/TopBar';
import LeftRail from './components/LeftRail';
import Legend from './components/Legend';
import Timeline from './components/Timeline';
import PointPanel from './components/PointPanel';
import { RegionPanel, ProfilePanel } from './components/RegionPanel';
import { LosCompass, Splash, StreamingOverlay } from './components/Widgets';
import { defaultRanges, getState, MODES, useStore, type Mode } from './lib/store';
import { fetchMeta, loadBase } from './lib/data';

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const c = p.get('c')?.split(',').map(Number);
  return {
    mode: p.get('m') as Mode | null,
    pid: p.has('p') ? Number(p.get('p')) : null,
    center: c && c.length === 3 && c.every(Number.isFinite) ? c : null,
    epoch: p.has('e') ? Number(p.get('e')) : null
  };
}

export default function App() {
  const meta = useStore((s) => s.meta);
  const error = useStore((s) => s.error);
  const panel = useStore((s) => s.panel);
  const set = useStore((s) => s.set);

  // boot: meta → map (hexes) → streamed points
  useEffect(() => {
    const h = readHash();
    fetchMeta()
      .then((m) => {
        const patch: any = { meta: m, ranges: defaultRanges(m), incidence: m.incidence_default_deg };
        if (h.mode && MODES.some((x) => x.id === h.mode)) patch.mode = h.mode;
        if (h.epoch !== null && h.epoch >= 0 && h.epoch <= m.epochs - 1) patch.epochF = h.epoch;
        set(patch);
        loadBase(m, (base, fraction) => set({ base, loadFraction: fraction, baseVersion: getState().baseVersion + 1 }))
          .then(() => {
            if (h.pid !== null && h.pid < m.count) selectPoint(h.pid);
            if (h.center) set({ flyTo: { lon: h.center[0], lat: h.center[1], zoom: h.center[2], t: Date.now() } });
          })
          .catch((e) => set({ error: String(e.message || e) }));
      })
      .catch((e) => set({ error: String(e.message || e) }));
  }, [set]);

  // shareable URL state
  useEffect(() => {
    let timer: any;
    return useStore.subscribe((s) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const w = window as any;
        const map = w.__phase?.map;
        const p = new URLSearchParams();
        p.set('m', s.mode);
        if (s.selected !== null) p.set('p', String(s.selected));
        if (s.mode === 'displacement' || s.mode === 'phase') p.set('e', s.epochF.toFixed(2));
        if (map) { const c = map.getCenter(); p.set('c', `${c.lng.toFixed(5)},${c.lat.toFixed(5)},${map.getZoom().toFixed(2)}`); }
        history.replaceState(null, '', `#${p.toString()}`);
      }, 500);
    });
  }, []);

  // keep the selected point out from under the right panel
  useEffect(() => useStore.subscribe((s, prev) => {
    if (s.selected === null || s.selected === prev.selected || !s.base) return;
    const map = (window as any).__phase?.map;
    if (!map || window.innerWidth < 900) return;
    const lon = s.base.positions[2 * s.selected];
    const lat = s.base.positions[2 * s.selected + 1];
    const px = map.project([lon, lat]);
    if (px.x > window.innerWidth - 440) map.easeTo({ center: [lon, lat], offset: [-200, 0], duration: 600 });
  }), []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const s = getState();
      if (!s.meta) return;
      const m = MODES.find((x) => x.key === e.key);
      if (m) { s.set({ mode: m.id }); return; }
      switch (e.key) {
        case ' ': e.preventDefault(); s.set({ playing: !s.playing, ...(s.mode === 'displacement' || s.mode === 'phase' ? {} : { mode: 'displacement' }) }); break;
        case 'ArrowRight': s.set({ playing: false, epochF: Math.min(s.meta.epochs - 1, Math.floor(s.epochF) + 1) }); break;
        case 'ArrowLeft': s.set({ playing: false, epochF: Math.max(0, Math.ceil(s.epochF) - 1) }); break;
        case 'Escape':
          if (s.tool !== 'none') s.set({ tool: 'none', draft: [] });
          else if (s.panel) s.set({ panel: null, selected: null, compare: [], region: null, profile: null });
          break;
        case 'l': case 'L': s.set({ tool: s.tool === 'lasso' ? 'none' : 'lasso', draft: [] }); break;
        case 'p': case 'P': s.set({ tool: s.tool === 'profile' ? 'none' : 'profile', draft: [] }); break;
        case 'r': case 'R': s.set({ tool: s.tool === 'reference' ? 'none' : 'reference' }); break;
        case 'c': case 'C': if (s.selected !== null && !s.compare.includes(s.selected) && s.compare.length < 5) s.set({ compare: [...s.compare, s.selected] }); break;
        case 'v': case 'V': s.set({ vertical: !s.vertical }); break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!meta) return <Splash error={error} />;

  return (
    <div className="app">
      <TopBar />
      <div className="stage">
        <LeftRail />
        <main className="map-wrap">
          <MapView />
          <StreamingOverlay />
          <div className="map-overlays">
            <LosCompass />
            <Legend />
          </div>
          {error && <div className="toast">{error}</div>}
        </main>
        <AnimatePresence>
          {panel && (
            <motion.aside
              key="panel"
              className="side-panel"
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 40, opacity: 0, transition: { duration: 0.2 } }}
              transition={{ type: 'spring', stiffness: 260, damping: 28 }}
            >
              {panel === 'point' && <PointPanel />}
              {panel === 'region' && <RegionPanel />}
              {panel === 'profile' && <ProfilePanel />}
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
      <Timeline />
    </div>
  );
}
