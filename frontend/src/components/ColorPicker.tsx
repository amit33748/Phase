import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CMAP_INFO, CMAPS, cssGradient, type CmapKind, type CmapName } from '../lib/colormaps';
import { useStore } from '../lib/store';
import { autoCmap, colorSpec } from '../map/layers';

const CLASSES = [0, 5, 7, 9, 11];
const EASE = [0.16, 1, 0.3, 1] as const;

/** Colour map, flip and discrete-classes controls for the current map mode. */
export default function ColorPicker() {
  const mode = useStore((s) => s.mode);
  const theme = useStore((s) => s.theme);
  const cmapChoice = useStore((s) => s.cmapChoice);
  const cmapFlip = useStore((s) => s.cmapFlip);
  const classes = useStore((s) => s.classes);
  const set = useStore((s) => s.set);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const spec = colorSpec({ mode, theme, cmapChoice, cmapFlip, classes });
  const cyclic = mode === 'phase';
  const auto = autoCmap(mode, theme);

  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('pointerdown', off);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('pointerdown', off); window.removeEventListener('keydown', esc, true); };
  }, [open]);

  const choose = (name: CmapName | null) => {
    const next = { ...cmapChoice };
    if (name) next[mode] = name; else delete next[mode];
    set({ cmapChoice: next });
  };
  // preview each map the way it would be drawn in this mode (same reverse rule)
  const preview = (name: CmapName) => colorSpec({ mode, theme, cmapChoice: { [mode]: name }, cmapFlip, classes });
  const groups: { kind: CmapKind; title: string }[] = cyclic
    ? [{ kind: 'cyclic', title: 'Cyclic' }]
    : mode === 'seasonal' || mode === 'quality'
      ? [{ kind: 'sequential', title: 'Sequential' }, { kind: 'diverging', title: 'Diverging' }]
      : [{ kind: 'diverging', title: 'Diverging' }, { kind: 'sequential', title: 'Sequential' }];

  return (
    <div className="cpick" ref={root}>
      <button className={`cp-current ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="listbox">
        <i style={{ background: cssGradient(spec.cmap, spec.reverse && !cyclic, 'to right', spec.steps) }} />
        <span>{CMAP_INFO[spec.cmap].label}{!cmapChoice[mode] && <em> auto</em>}</span>
        <svg viewBox="0 0 10 10"><path d="M2 6l3-3 3 3" /></svg>
      </button>
      <button className={`icon-btn sm flip ${cmapFlip[mode] ? 'on' : ''}`} title="Flip colour map" aria-label="Flip colour map" aria-pressed={!!cmapFlip[mode]}
        onClick={() => set({ cmapFlip: { ...cmapFlip, [mode]: !cmapFlip[mode] } })}>
        <svg viewBox="0 0 16 16"><path d="M3 5h9l-2.5-2.5M13 11H4l2.5 2.5" /></svg>
      </button>
      {!cyclic && (
        <div className="seg classes" role="group" aria-label="Colour classes">
          {CLASSES.map((c) => (
            <button key={c} className={classes === c ? 'on' : ''} onClick={() => set({ classes: c })} title={c ? `${c} discrete classes` : 'Continuous'}>
              {c || '∿'}
            </button>
          ))}
        </div>
      )}

      <AnimatePresence>
        {open && (
          <motion.div className="cp-pop" role="listbox" initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, transition: { duration: 0.12 } }} transition={{ duration: 0.28, ease: EASE }}>
            <button className={`cp-opt ${!cmapChoice[mode] ? 'on' : ''}`} onClick={() => { choose(null); setOpen(false); }}>
              <i style={{ background: cssGradient(auto, preview(auto).reverse && !cyclic, 'to right', spec.steps) }} />
              <span className="cp-name">Automatic</span>
              <span className="cp-note">{CMAP_INFO[auto].label} · follows theme</span>
            </button>
            {groups.map((g) => (
              <div key={g.kind}>
                <div className="cp-group">{g.title}</div>
                {(Object.keys(CMAPS) as CmapName[]).filter((n) => CMAP_INFO[n].kind === g.kind).map((n) => (
                  <button key={n} role="option" aria-selected={cmapChoice[mode] === n} className={`cp-opt ${cmapChoice[mode] === n ? 'on' : ''}`}
                    onClick={() => { choose(n); setOpen(false); }}>
                    <i style={{ background: cssGradient(n, preview(n).reverse && !cyclic, 'to right', spec.steps) }} />
                    <span className="cp-name">{CMAP_INFO[n].label}</span>
                    <span className="cp-note">{CMAP_INFO[n].note}</span>
                  </button>
                ))}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
