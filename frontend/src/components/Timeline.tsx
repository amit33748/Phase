import { useEffect, useMemo, useRef, useState } from 'react';
import { epochDate, getState, useStore } from '../lib/store';

const PLAY_SECONDS = 8; // full sweep at 1×

export default function Timeline() {
  const meta = useStore((s) => s.meta)!;
  const epochF = useStore((s) => s.epochF);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const mode = useStore((s) => s.mode);
  const tsStatus = useStore((s) => s.tsStatus);
  const tsInView = useStore((s) => s.tsInView);
  const ts = useStore((s) => s.ts);
  const zoom = useStore((s) => s.zoom);
  const set = useStore((s) => s.set);
  const track = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const E = meta.epochs;
  const times = useMemo(() => meta.dates.map((d) => Date.parse(`${d}T00:00:00Z`)), [meta]);
  const t0 = times[0];
  const t1 = times[E - 1];
  const temporal = mode === 'displacement' || mode === 'phase';

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(track.current!);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    let hold = 0;
    const tick = (now: number) => {
      const dt = Math.min(now - last, 64) / 1000;
      last = now;
      const s = getState();
      if (s.epochF >= E - 1) {
        hold += dt; // rest on the last epoch, then loop
        if (hold > 0.8) { hold = 0; s.set({ epochF: 0 }); }
      } else {
        s.set({ epochF: Math.min(E - 1, s.epochF + (dt * (E - 1) * s.speed) / PLAY_SECONDS) });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, E]);

  const eShown = Math.min(epochF, E - 1);
  const xOfTime = (t: number) => ((t - t0) / (t1 - t0)) * w;
  const xOfEpoch = (e: number) => {
    const k = Math.floor(e);
    const k1 = Math.min(k + 1, E - 1);
    return xOfTime(times[k] + (times[k1] - times[k]) * (e - k));
  };
  const epochOfX = (x: number) => {
    const t = t0 + (Math.min(Math.max(x, 0), w) / w) * (t1 - t0);
    for (let i = 0; i < E - 1; i++) if (t <= times[i + 1]) return i + (t - times[i]) / (times[i + 1] - times[i]);
    return E - 1;
  };
  const scrub = (clientX: number, snap: boolean) => {
    const r = track.current!.getBoundingClientRect();
    let e = epochOfX(clientX - r.left);
    if (snap) e = Math.round(e);
    const patch: any = { epochF: e };
    if (!temporal) patch.mode = 'displacement';
    set(patch);
  };
  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    set({ playing: false });
    scrub(e.clientX, false);
  };

  const date = epochDate(meta, eShown);
  const years: number[] = [];
  for (let y = new Date(t0).getUTCFullYear() + 1; y <= new Date(t1).getUTCFullYear(); y++) years.push(Date.UTC(y, 0, 1));
  const maxGap = Math.max(...times.slice(1).map((t, i) => t - times[i]));

  let status: { cls: string; text: string };
  if (!temporal) status = { cls: '', text: 'Press play to animate displacement' };
  else if (zoom < 10.5) status = { cls: 'model', text: 'Linear model at this zoom · zoom in for measured series' };
  else if (tsStatus === 'loading') status = { cls: 'loading', text: `Loading measured series · ${tsInView.toLocaleString()} pts` };
  else if (tsStatus === 'too-many') status = { cls: 'model', text: `Linear model · ${tsInView.toLocaleString()} pts in view, zoom in for measured` };
  else if (tsStatus === 'ready' && ts) status = { cls: 'measured', text: `Measured · ${ts.n.toLocaleString()} scatterers` };
  else status = { cls: 'model', text: 'Linear model' };

  return (
    <div className={`timeline ${temporal ? 'active' : ''}`}>
      <div className="tl-controls">
        <button className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => set({ playing: !playing, ...(temporal ? {} : { mode: 'displacement' }), ...(epochF >= E - 1 ? { epochF: 0 } : {}) })}>
          {playing ? <svg viewBox="0 0 16 16"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
            : <svg viewBox="0 0 16 16"><path d="M4 2.5v11a.6.6 0 0 0 .9.5l9-5.5a.6.6 0 0 0 0-1l-9-5.5a.6.6 0 0 0-.9.5z" /></svg>}
        </button>
        <button className="step" aria-label="Previous epoch" onClick={() => set({ playing: false, epochF: Math.max(0, Math.ceil(eShown) - 1), ...(temporal ? {} : { mode: 'displacement' }) })}>‹</button>
        <button className="step" aria-label="Next epoch" onClick={() => set({ playing: false, epochF: Math.min(E - 1, Math.floor(eShown) + 1), ...(temporal ? {} : { mode: 'displacement' }) })}>›</button>
        <div className="seg speed">
          {[0.5, 1, 2].map((v) => <button key={v} className={speed === v ? 'on' : ''} onClick={() => set({ speed: v })}>{v}×</button>)}
        </div>
      </div>

      <div className="tl-date">
        <div className="mono big">{date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })}</div>
        <div className={`tl-status ${status.cls}`}><i />{status.text}</div>
      </div>

      <div className="tl-track" ref={track}
        onPointerDown={onDown}
        onPointerMove={(e) => {
          const r = track.current!.getBoundingClientRect();
          setHoverX(e.clientX - r.left);
          if (e.buttons === 1) scrub(e.clientX, false);
        }}
        onPointerUp={(e) => scrub(e.clientX, true)}
        onPointerLeave={() => setHoverX(null)}>
        <svg width={w} height={44}>
          <line x1={0} x2={w} y1={30} y2={30} className="tl-base" />
          <line x1={0} x2={xOfEpoch(eShown)} y1={30} y2={30} className="tl-progress" />
          {years.map((t) => (
            <g key={t} transform={`translate(${xOfTime(t)},0)`}>
              <line y1={34} y2={40} className="tl-year" />
              <text y={11} textAnchor="middle" className="tl-year-label">{new Date(t).getUTCFullYear()}</text>
            </g>
          ))}
          {times.map((t, i) => {
            const gap = i ? t - times[i - 1] : times[1] - t;
            const h = 5 + (gap / maxGap) * 9;
            const passed = i <= eShown + 1e-6;
            return <line key={i} x1={xOfTime(t)} x2={xOfTime(t)} y1={30 - h} y2={30} className={`tl-tick ${passed ? 'on' : ''} ${Math.round(eShown) === i ? 'cur' : ''}`} />;
          })}
          {meta.events.map((ev) => {
            const x = xOfTime(Date.parse(`${ev.date}T00:00:00Z`));
            return <g key={ev.label} transform={`translate(${x},0)`}><path d="M0 16 L3 20 L0 24 L-3 20Z" className="tl-event" /><title>{ev.label} · {ev.date}</title></g>;
          })}
          <g transform={`translate(${xOfEpoch(eShown)},30)`} className="tl-head">
            <circle r={7} className="halo" />
            <circle r={4} />
          </g>
          {hoverX !== null && (
            <g transform={`translate(${hoverX},0)`} className="tl-hover">
              <line y1={14} y2={40} />
            </g>
          )}
        </svg>
        {hoverX !== null && (
          <div className="tl-hover-label mono" style={{ left: Math.min(Math.max(hoverX, 40), w - 40) }}>
            {epochDate(meta, epochOfX(hoverX)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })}
          </div>
        )}
      </div>
    </div>
  );
}
