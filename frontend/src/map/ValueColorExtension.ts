import { LayerExtension } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { glslColormaps } from '../lib/colormaps';

/**
 * Colours points on the GPU from one or two scalar attributes.
 *
 *   v = (mix(valueA, valueB, t) − mix(refA, refB, t)) · scale
 *   colour = cmap( (v − vmin) / (vmax − vmin) )     or, when cyclic, cmap(fract(v / period))
 *
 * Timeline animation binds epoch k to valueA and epoch k+1 to valueB (zero-copy subarrays), so a
 * frame only changes the `t` uniform. Re-referencing changes refA/refB; the colour range changes
 * vmin/vmax. None of these touch per-point data.
 */
export type ValueColorProps = {
  getValueA?: any;
  getValueB?: any;
  vcMix?: number;
  vcRefA?: number;
  vcRefB?: number;
  vcScale?: number;
  vcMin?: number;
  vcMax?: number;
  vcCmap?: number;
  vcReverse?: boolean;
  vcCyclic?: boolean;
  vcPeriod?: number;
  vcDim?: number;
  vcSteps?: number;
};

const uniformBlock = /* glsl */ `\
layout(std140) uniform valueColorUniforms {
  float mixT;
  float refA;
  float refB;
  float scale;
  float vmin;
  float vmax;
  float period;
  float dim;
  float steps;
  highp int cmap;
  highp int reverse;
  highp int cyclic;
} valueColor;
`;

const valueColorModule = {
  name: 'valueColor',
  vs: `${uniformBlock}\nin float vcValueA;\nin float vcValueB;\n${glslColormaps()}`,
  fs: uniformBlock,
  uniformTypes: {
    mixT: 'f32', refA: 'f32', refB: 'f32', scale: 'f32', vmin: 'f32', vmax: 'f32', period: 'f32', dim: 'f32', steps: 'f32',
    cmap: 'i32', reverse: 'i32', cyclic: 'i32'
  },
  inject: {
    'vs:DECKGL_FILTER_COLOR': /* glsl */ `
      float vcV = (mix(vcValueA, vcValueB, valueColor.mixT) - mix(valueColor.refA, valueColor.refB, valueColor.mixT)) * valueColor.scale;
      float vcT;
      if (valueColor.cyclic == 1) {
        vcT = fract(vcV / valueColor.period);
      } else {
        vcT = (vcV - valueColor.vmin) / max(valueColor.vmax - valueColor.vmin, 1e-6);
        if (valueColor.reverse == 1) vcT = 1.0 - vcT;
      }
      if (valueColor.steps > 0.5) {
        vcT = (floor(clamp(vcT, 0.0, 0.9999) * valueColor.steps) + 0.5) / valueColor.steps;
      }
      color = vec4(vc_cmap(valueColor.cmap, vcT) * valueColor.dim, color.a);
    `
  }
} as any;

const defaultProps = {
  getValueA: { type: 'accessor', value: 0 },
  getValueB: { type: 'accessor', value: 0 },
  vcMix: 0,
  vcRefA: 0,
  vcRefB: 0,
  vcScale: 1,
  vcMin: -20,
  vcMax: 20,
  vcCmap: 0,
  vcReverse: true,
  vcCyclic: false,
  vcPeriod: 27.73,
  vcDim: 1,
  vcSteps: 0
};

export class ValueColorExtension extends LayerExtension {
  static extensionName = 'ValueColorExtension';
  static defaultProps = defaultProps as any;

  getShaders() {
    return { modules: [valueColorModule] };
  }

  initializeState(this: Layer<ValueColorProps>) {
    this.getAttributeManager()?.add({
      vcValueA: { size: 1, type: 'float32', accessor: 'getValueA', stepMode: 'dynamic' } as any,
      vcValueB: { size: 1, type: 'float32', accessor: 'getValueB', stepMode: 'dynamic' } as any
    });
  }

  draw(this: Layer<ValueColorProps>) {
    const p = this.props;
    this.setShaderModuleProps({
      valueColor: {
        mixT: p.vcMix ?? 0,
        refA: p.vcRefA ?? 0,
        refB: p.vcRefB ?? 0,
        scale: p.vcScale ?? 1,
        vmin: p.vcMin ?? -20,
        vmax: p.vcMax ?? 20,
        period: p.vcPeriod ?? 27.73,
        dim: p.vcDim ?? 1,
        steps: p.vcSteps ?? 0,
        cmap: p.vcCmap ?? 0,
        reverse: p.vcReverse ? 1 : 0,
        cyclic: p.vcCyclic ? 1 : 0
      }
    });
  }
}
