import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { scaleLinear, scaleUtc } from 'd3-scale';
import { area, line, curveMonotoneX, curveLinear } from 'd3-shape';

export interface SeriesItem {
  key: string;
  color: string;
  values: number[];
  primary?: boolean;
  outliers?: boolean[];
  label?: string;
}

export interface ChartModel {
  trend: (t: number) => number;
  full: (t: number) => number;
  rmse: number;
}

interface Props {
  dates: Date[];
  t: number[];
  items: SeriesItem[];
  model?: ChartModel | null;
  band?: { lo: number[]; hi: number[]; label: string } | null;
  show: { trend: boolean; seasonal: boolean; band: boolean; context: boolean };
  cursorEpoch?: number | null;
  events?: { date: Date; label: string }[];
  unit: string;
  height?: number;
  onHover?: (epoch: number | null) => void;
}

const M = { top: 14, right: 12, bottom: 24, left: 44 };
const EASE = [0.16, 1, 0.3, 1] as const;

function yearToDate(t: number) {
  const y = Math.floor(t);
  const a = Date.UTC(y, 0, 1);
  const b = Date.UTC(y + 1, 0, 1);
  return new Date(a + (b - a) * (t - y));
}

export default function SeriesChart({ dates, t, items, model, band, show, cursorEpoch, events = [], unit, height = 230, onHover }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(340);
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useMemo(() => `clip-${Math.random().toString(36).slice(2)}`, []);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);

  const W = width - M.left - M.right;
  const H = height - M.top - M.bottom;

  const modelT = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= 160; i++) out.push(t[0] + ((t[t.length - 1] - t[0]) * i) / 160);
    return out;
  }, [t]);

  const { x, y } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    const acc = (v: number) => { if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
    items.forEach((it) => it.values.forEach(acc));
    if (band && show.context) { band.lo.forEach(acc); band.hi.forEach(acc); }
    if (model && show.band) modelT.forEach((tt) => { acc(model.full(tt) - model.rmse); acc(model.full(tt) + model.rmse); });
    if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
    const pad = Math.max((hi - lo) * 0.08, 2);
    return {
      x: scaleUtc().domain([dates[0], dates[dates.length - 1]]).range([0, W]),
      y: scaleLinear().domain([lo - pad, hi + pad]).nice(5).range([H, 0])
    };
  }, [items, band, model, show, dates, W, H, modelT]);

  const seriesPath = line<number>().x((_, i) => x(dates[i])).y((v) => y(v)).curve(curveLinear);
  const modelLine = (f: (tt: number) => number) =>
    line<number>().x((tt) => x(yearToDate(tt))).y((tt) => y(f(tt))).curve(curveMonotoneX)(modelT) || '';
  const bandArea = (lo: (i: number) => number, hi: (i: number) => number, xs: (i: number) => number, n: number) =>
    area<number>().x((i) => xs(i)).y0((i) => y(lo(i))).y1((i) => y(hi(i))).curve(curveMonotoneX)(Array.from({ length: n }, (_, i) => i)) || '';

  const ctxD = band ? bandArea((i) => band.lo[i], (i) => band.hi[i], (i) => x(dates[i]), dates.length) : '';
  const bandD = model ? bandArea((i) => model.full(modelT[i]) - model.rmse, (i) => model.full(modelT[i]) + model.rmse, (i) => x(yearToDate(modelT[i])), modelT.length) : '';
  const fullD = model ? modelLine(model.full) : '';
  const trendD = model ? modelLine(model.trend) : '';

  const years: Date[] = [];
  for (let yr = dates[0].getUTCFullYear() + 1; yr <= dates[dates.length - 1].getUTCFullYear(); yr++) years.push(new Date(Date.UTC(yr, 0, 1)));
  const yTicks = y.ticks(5);

  const primary = items.find((i) => i.primary) || items[0];
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    const d = x.invert(px).getTime();
    let best = 0;
    for (let i = 1; i < dates.length; i++) if (Math.abs(dates[i].getTime() - d) < Math.abs(dates[best].getTime() - d)) best = i;
    setHover(best);
    onHover?.(best);
  };
  const hv = hover ?? null;

  return (
    <div className="chart" ref={wrap}>
      <svg width={width} height={height} role="img" aria-label={`Displacement time series in ${unit}`}>
        <defs>
          <clipPath id={clipId}>
            <motion.rect x={0} y={-10} height={H + 20} initial={{ width: 0 }} animate={{ width: W }} transition={{ duration: 0.9, delay: 0.62, ease: EASE }} />
          </clipPath>
        </defs>
        <g transform={`translate(${M.left},${M.top})`}>
          {/* grid */}
          <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.1 }}>
            {years.map((d) => (
              <g key={d.toISOString()} transform={`translate(${x(d)},0)`}>
                <line y1={0} y2={H} className="grid-v" />
                <text y={H + 16} className="axis-label" textAnchor="middle">{String(d.getUTCFullYear()).slice(2).padStart(3, "'")}</text>
              </g>
            ))}
            {events.map((ev) => (
              <g key={ev.label} transform={`translate(${x(ev.date)},0)`}>
                <line y1={0} y2={H} className="grid-event" />
                <text y={8} x={4} className="event-label">{ev.label}</text>
              </g>
            ))}
            {yTicks.map((v) => (
              <motion.g key={v} initial={false} animate={{ y: y(v) }} transition={{ duration: 0.42, ease: EASE }}>
                <line x1={0} x2={W} className={v === 0 ? 'grid-zero' : 'grid-h'} />
                <text x={-8} dy="0.32em" className="axis-label" textAnchor="end">{v}</text>
              </motion.g>
            ))}
          </motion.g>

          {/* neighbourhood / region band */}
          {band && show.context && (
            <motion.path
              className="band-context"
              initial={{ opacity: 0, d: ctxD }}
              animate={{ opacity: 1, d: ctxD }}
              transition={{ opacity: { duration: 0.5, delay: 0.5 }, d: { duration: 0.42, ease: EASE } }}
            />
          )}

          {/* model: ±rmse band, trend, seasonal */}
          {model && (
            <g clipPath={`url(#${clipId})`}>
              {show.band && (
                <motion.path className="band-model" initial={{ d: bandD }} animate={{ d: bandD }}
                  transition={{ duration: 0.42, ease: EASE }} />
              )}
              {show.seasonal && (
                <motion.path className="line-seasonal" initial={{ d: fullD }} animate={{ d: fullD }} transition={{ duration: 0.42, ease: EASE }} />
              )}
              {show.trend && (
                <motion.path className="line-trend" initial={{ d: trendD }} animate={{ d: trendD }} transition={{ duration: 0.42, ease: EASE }} />
              )}
            </g>
          )}

          {/* measured series */}
          <AnimatePresence>
            {items.map((it) => {
              const d = seriesPath(it.values) || '';
              return (
                <motion.g key={it.key} initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
                  <motion.path
                    d={d}
                    fill="none"
                    stroke={it.color}
                    strokeWidth={it.primary ? 1.8 : 1.4}
                    strokeLinejoin="round"
                    initial={{ pathLength: 0, d }}
                    animate={{ pathLength: 1, d }}
                    transition={{ pathLength: { duration: 0.72, delay: it.primary ? 0.28 : 0.05, ease: EASE }, d: { duration: 0.42, ease: EASE } }}
                    opacity={it.primary ? 0.95 : 0.85}
                  />
                  {it.values.map((v, i) => (
                    <motion.circle
                      key={i}
                      cx={x(dates[i])}
                      r={it.primary ? 2.6 : 2}
                      className={it.outliers?.[i] ? 'dot-outlier' : undefined}
                      fill={it.outliers?.[i] ? 'var(--surface-solid)' : it.color}
                      stroke={it.color}
                      strokeWidth={it.outliers?.[i] ? 1.4 : 0}
                      style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                      initial={{ scale: 0, cy: y(v) }}
                      animate={{ scale: 1, cy: y(v) }}
                      transition={{ scale: { duration: 0.3, delay: (it.primary ? 0.3 : 0.08) + i * 0.02, ease: EASE }, cy: { duration: 0.42, ease: EASE } }}
                    />
                  ))}
                </motion.g>
              );
            })}
          </AnimatePresence>

          {/* timeline cursor */}
          {cursorEpoch !== null && cursorEpoch !== undefined && (
            <line className="cursor-epoch" x1={x(dateAt(dates, cursorEpoch))} x2={x(dateAt(dates, cursorEpoch))} y1={0} y2={H} />
          )}

          {/* hover */}
          {hv !== null && primary && (
            <g className="hover">
              <line x1={x(dates[hv])} x2={x(dates[hv])} y1={0} y2={H} />
              {items.map((it) => (
                <circle key={it.key} cx={x(dates[hv])} cy={y(it.values[hv])} r={4.5} fill="var(--surface-solid)" stroke={it.color} strokeWidth={2} />
              ))}
            </g>
          )}
          <rect width={W} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => { setHover(null); onHover?.(null); }} />
        </g>
      </svg>
      {hv !== null && primary && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(M.left + x(dates[hv]), 70), width - 70) }}>
          <span className="tip-date">{dates[hv].toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })}</span>
          {items.map((it) => (
            <span key={it.key} className="tip-val" style={{ color: it.color }}>
              {it.values[hv] > 0 ? '+' : ''}{it.values[hv].toFixed(1)}
              {it.primary && model && <em> · resid {(it.values[hv] - model.full(t[hv])).toFixed(1)}</em>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function dateAt(dates: Date[], e: number) {
  const k = Math.floor(e);
  const k1 = Math.min(k + 1, dates.length - 1);
  return new Date(dates[k].getTime() + (dates[k1].getTime() - dates[k].getTime()) * (e - k));
}
