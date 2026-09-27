/**
 * Colour maps sampled at 9 stops: Crameri "Scientific colour maps" (berlin, vik, roma, batlow, lajolla,
 * romaO), ColorBrewer RdBu, matplotlib viridis / magma / twilight and Google turbo.
 * The same stops drive the GPU shader (points), the CPU path (hexes, charts) and the legend gradients.
 *
 * Diverging maps are stored low = blue end, so "reverse" puts negative (away from satellite) on the
 * red/warm end, the convention used throughout the app.
 */
export type CmapName =
  | 'berlin' | 'vik' | 'roma' | 'rdbu' | 'turbo'
  | 'batlow' | 'viridis' | 'magma' | 'lajolla'
  | 'romaO' | 'twilight';
export type CmapKind = 'diverging' | 'sequential' | 'cyclic';
type RGB = [number, number, number];

export const CMAPS: Record<CmapName, RGB[]> = {
  // diverging, dark centre: stable points recede on a dark basemap
  berlin: [
    [158, 176, 255], [104, 160, 222], [54, 121, 164], [30, 70, 95], [17, 25, 30],
    [65, 24, 12], [126, 48, 26], [190, 98, 80], [255, 173, 173]
  ],
  // diverging, light centre
  vik: [
    [0, 18, 97], [3, 62, 125], [40, 114, 163], [137, 178, 206], [235, 237, 233],
    [216, 174, 122], [193, 121, 56], [143, 55, 11], [89, 0, 8]
  ],
  // diverging, multi-hue (blue → pale → brown)
  roma: [
    [26, 51, 153], [33, 90, 165], [60, 145, 195], [111, 203, 212], [190, 232, 200],
    [220, 207, 130], [186, 145, 55], [156, 85, 25], [126, 23, 0]
  ],
  // classic ColorBrewer red–blue (stored blue → red)
  rdbu: [
    [5, 48, 97], [33, 102, 172], [67, 147, 195], [146, 197, 222], [247, 247, 247],
    [244, 165, 130], [214, 96, 77], [178, 24, 43], [103, 0, 31]
  ],
  // rainbow familiar from InSAR software, perceptually improved (blue → red)
  turbo: [
    [48, 18, 59], [70, 107, 227], [40, 187, 236], [49, 242, 153], [162, 252, 60],
    [237, 208, 58], [251, 128, 34], [208, 47, 5], [122, 4, 3]
  ],
  batlow: [
    [1, 25, 89], [16, 63, 96], [28, 90, 98], [60, 109, 86], [104, 123, 62],
    [157, 137, 43], [210, 147, 67], [248, 161, 125], [250, 204, 250]
  ],
  viridis: [
    [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141],
    [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37]
  ],
  magma: [
    [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
    [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]
  ],
  lajolla: [
    [255, 254, 203], [251, 236, 154], [244, 204, 104], [236, 160, 76], [227, 114, 70],
    [199, 78, 65], [142, 56, 48], [80, 37, 23], [26, 26, 1]
  ],
  // cyclic, for wrapped phase
  romaO: [
    [114, 56, 86], [133, 85, 51], [165, 138, 64], [199, 196, 137], [167, 219, 212],
    [103, 172, 210], [84, 109, 177], [97, 62, 125], [114, 56, 86]
  ],
  twilight: [
    [226, 217, 226], [155, 176, 201], [98, 127, 189], [93, 70, 164], [47, 20, 54],
    [130, 42, 79], [190, 94, 82], [213, 163, 143], [226, 217, 226]
  ]
};

export const CMAP_INFO: Record<CmapName, { kind: CmapKind; label: string; note: string }> = {
  berlin: { kind: 'diverging', label: 'Berlin', note: 'dark centre · best on dark maps' },
  vik: { kind: 'diverging', label: 'Vik', note: 'light centre · best on light maps' },
  roma: { kind: 'diverging', label: 'Roma', note: 'multi-hue · high contrast' },
  rdbu: { kind: 'diverging', label: 'Red–Blue', note: 'classic ColorBrewer' },
  turbo: { kind: 'diverging', label: 'Turbo', note: 'rainbow · familiar from InSAR tools' },
  batlow: { kind: 'sequential', label: 'Batlow', note: 'colour-blind safe' },
  viridis: { kind: 'sequential', label: 'Viridis', note: 'perceptually uniform' },
  magma: { kind: 'sequential', label: 'Magma', note: 'dark to bright' },
  lajolla: { kind: 'sequential', label: 'La Jolla', note: 'light to dark' },
  romaO: { kind: 'cyclic', label: 'Roma O', note: 'cyclic · wrapped phase' },
  twilight: { kind: 'cyclic', label: 'Twilight', note: 'cyclic · dark mid-phase' }
};

const NAMES = Object.keys(CMAPS) as CmapName[];
export const CMAP_INDEX = Object.fromEntries(NAMES.map((n, i) => [n, i])) as Record<CmapName, number>;

/** Snap t to the centre of one of `steps` classes (0 = continuous). */
export function classify(t: number, steps: number) {
  if (!steps) return t;
  const c = Math.min(Math.max(t, 0), 0.9999);
  return (Math.floor(c * steps) + 0.5) / steps;
}

export function sample(name: CmapName, t: number, steps = 0): RGB {
  const s = CMAPS[name];
  const x = Math.min(Math.max(classify(t, steps), 0), 1) * (s.length - 1);
  const i = Math.min(Math.floor(x), s.length - 2);
  const f = x - i;
  const a = s[i];
  const b = s[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function cssGradient(name: CmapName, reverse = false, dir = 'to right', steps = 0): string {
  const col = (t: number) => `rgb(${sample(name, reverse ? 1 - t : t).map((v) => Math.round(v)).join(',')})`;
  if (steps) {
    const parts: string[] = [];
    for (let k = 0; k < steps; k++) {
      const c = col((k + 0.5) / steps);
      parts.push(`${c} ${(k / steps) * 100}%`, `${c} ${((k + 1) / steps) * 100}%`);
    }
    return `linear-gradient(${dir}, ${parts.join(', ')})`;
  }
  const stops = Array.from({ length: 17 }, (_, i) => `${col(i / 16)} ${(i / 16) * 100}%`);
  return `linear-gradient(${dir}, ${stops.join(', ')})`;
}

const glslVec = (c: RGB) => `vec3(${c.map((v) => (v / 255).toFixed(4)).join(', ')})`;

/** GLSL: `vec3 vc_cmap(int idx, float t)` for all maps above. */
export function glslColormaps(): string {
  const consts = NAMES
    .map((n) => `const vec3 VC_${n.toUpperCase()}[9] = vec3[9](${CMAPS[n].map(glslVec).join(', ')});`)
    .join('\n');
  const branches = NAMES
    .map((n, i) => `  ${i ? 'else ' : ''}if (idx == ${i}) { a = VC_${n.toUpperCase()}[i]; b = VC_${n.toUpperCase()}[i + 1]; }`)
    .join('\n');
  return `${consts}
vec3 vc_cmap(int idx, float t) {
  float x = clamp(t, 0.0, 1.0) * 8.0;
  int i = int(min(floor(x), 7.0));
  float f = x - float(i);
  vec3 a = vec3(0.0); vec3 b = vec3(0.0);
${branches}
  return mix(a, b, f);
}`;
}
