/**
 * Charts as images, for channels that take images but cannot draw a chart (WhatsApp, Telegram, an
 * email): `chartSvg(props)` draws the builtin `Chart` (bar or line) as SVG, and `chartImages()` turns
 * it into a PNG with `@resvg/resvg-js` — an OPTIONAL peer dependency, loaded only when a chart is
 * actually drawn.
 *
 * ```ts
 * import { chartImages } from '@adonis-agora/agent/genui/chart-image'
 * genui({ catalog, channels: { whatsapp: { chartImages: chartImages() } } })
 * ```
 */
import type { ChannelNativeImage, ChartImageRenderer } from './channels.js';
import type { ChartProps } from './registry.js';

export interface ChartSvgOptions {
  /** Default 800. */
  width?: number;
  /** Default 450. */
  height?: number;
  /** Series colors, in order. Default: a palette readable on white. */
  colors?: readonly string[];
  /** Default `#ffffff`. */
  background?: string;
  /** Default `#1f2328`. */
  foreground?: string;
  /** Default: a list of common sans-serif families (resvg picks the first installed one). */
  fontFamily?: string;
}

const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2'];

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cell(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** A round axis maximum: 1, 2, 2.5 or 5 times a power of ten, at least `value`. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${+(value / 1000).toFixed(1)}k`;
  return `${+value.toFixed(2)}`;
}

/** The builtin `Chart` as an SVG document: axes, gridlines, bars or lines, a legend for 2+ series. */
export function chartSvg(props: ChartProps, options: ChartSvgOptions = {}): string {
  const width = options.width ?? 800;
  const height = options.height ?? 450;
  const colors = options.colors ?? PALETTE;
  const fg = options.foreground ?? '#1f2328';
  const font = escapeXml(
    options.fontFamily ??
      "Inter, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'DejaVu Sans', 'Liberation Sans', sans-serif",
  );
  const series = (props.series ?? []).slice(0, 6);
  const data = (props.data ?? []).slice(0, 60);
  const value = (point: Record<string, unknown>, key: string) => {
    const number = Number(point[key]);
    return Number.isFinite(number) ? number : 0;
  };
  const top = props.title ? 56 : 24;
  const legend = series.length > 1 ? 28 : 0;
  const left = 64;
  const right = 24;
  const bottom = 56 + legend;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const values = data.flatMap((point) => series.map((each) => value(point, each.key)));
  const max = niceMax(Math.max(0, ...values));
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const y = (v: number) => top + plotH - ((v - min) / span) * plotH;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${font}">`,
    `<rect width="100%" height="100%" fill="${escapeXml(options.background ?? '#ffffff')}"/>`,
  ];
  if (props.title) {
    out.push(
      `<text x="${left}" y="34" font-size="20" font-weight="600" fill="${fg}">${escapeXml(props.title)}</text>`,
    );
  }
  for (let i = 0; i <= 4; i++) {
    const v = min + (span * i) / 4;
    const gy = y(v);
    out.push(
      `<line x1="${left}" x2="${left + plotW}" y1="${gy}" y2="${gy}" stroke="${fg}" stroke-opacity="0.12"/>`,
      `<text x="${left - 8}" y="${gy + 4}" font-size="12" text-anchor="end" fill="${fg}" fill-opacity="0.7">${escapeXml(formatNumber(v))}${props.unit ? escapeXml(` ${props.unit}`) : ''}</text>`,
    );
  }
  const n = Math.max(1, data.length);
  const slot = plotW / n;
  const labelEvery = Math.max(1, Math.ceil(n / 12));
  data.forEach((point, index) => {
    if (index % labelEvery !== 0) return;
    const label = cell(point[props.xKey]).slice(0, 14);
    out.push(
      `<text x="${left + slot * index + slot / 2}" y="${top + plotH + 20}" font-size="12" text-anchor="middle" fill="${fg}" fill-opacity="0.8">${escapeXml(label)}</text>`,
    );
  });
  if (props.type === 'line') {
    series.forEach((each, s) => {
      const points = data.map(
        (point, index) => `${left + slot * index + slot / 2},${y(value(point, each.key))}`,
      );
      const color = colors[s % colors.length];
      out.push(
        `<polyline fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" points="${points.join(' ')}"/>`,
      );
      for (const p of points) {
        const [cx, cy] = p.split(',');
        out.push(`<circle cx="${cx}" cy="${cy}" r="3.5" fill="${color}"/>`);
      }
    });
  } else {
    const groupW = slot * 0.75;
    const barW = groupW / Math.max(1, series.length);
    data.forEach((point, index) => {
      series.forEach((each, s) => {
        const v = value(point, each.key);
        const x = left + slot * index + (slot - groupW) / 2 + barW * s;
        const y0 = y(Math.max(0, min));
        const y1 = y(v);
        out.push(
          `<rect x="${x}" y="${Math.min(y0, y1)}" width="${Math.max(1, barW - 2)}" height="${Math.abs(y0 - y1)}" rx="2" fill="${colors[s % colors.length]}"/>`,
        );
      });
    });
  }
  out.push(
    `<line x1="${left}" x2="${left + plotW}" y1="${y(Math.max(0, min))}" y2="${y(Math.max(0, min))}" stroke="${fg}" stroke-opacity="0.4"/>`,
  );
  if (legend > 0) {
    let x = left;
    const ly = height - 18;
    series.forEach((each, s) => {
      const label = escapeXml(each.label || each.key);
      out.push(
        `<rect x="${x}" y="${ly - 10}" width="12" height="12" rx="2" fill="${colors[s % colors.length]}"/>`,
        `<text x="${x + 18}" y="${ly}" font-size="12" fill="${fg}">${label}</text>`,
      );
      x += 30 + label.length * 7;
    });
  }
  out.push('</svg>');
  return out.join('');
}

export interface ChartImagesOptions extends ChartSvgOptions {
  /** The components drawn as images, all taking {@link ChartProps}. Default `['Chart']`. */
  components?: readonly string[];
  /** Font files for resvg (a server without system fonts draws no text otherwise). */
  fontFiles?: readonly string[];
}

interface ResvgModule {
  Resvg: new (
    svg: string,
    options?: Record<string, unknown>,
  ) => { render(): { asPng(): Uint8Array } };
}

let resvg: Promise<ResvgModule> | undefined;
async function loadResvg(): Promise<ResvgModule> {
  const id = '@resvg/resvg-js';
  resvg ??= (import(/* @vite-ignore */ id) as Promise<ResvgModule>).catch((error: unknown) => {
    resvg = undefined;
    throw new Error(
      `genui: chartImages() needs the optional peer dependency @resvg/resvg-js (npm i @resvg/resvg-js): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return resvg;
}

/** SVG → PNG bytes, with `@resvg/resvg-js`. */
export async function svgToPng(
  svg: string,
  options: { width?: number; fontFiles?: readonly string[] } = {},
): Promise<Uint8Array> {
  const { Resvg } = await loadResvg();
  const renderer = new Resvg(svg, {
    ...(options.width !== undefined ? { fitTo: { mode: 'width', value: options.width } } : {}),
    font: {
      loadSystemFonts: true,
      ...(options.fontFiles !== undefined ? { fontFiles: [...options.fontFiles] } : {}),
    },
  });
  return renderer.render().asPng();
}

/**
 * Charts as PNG images on a channel (`genui({ channels: { whatsapp: { chartImages: chartImages() } } })`).
 * A chart the renderer cannot draw (resvg missing, bad props) falls back to its text summary.
 */
export function chartImages(options: ChartImagesOptions = {}): ChartImageRenderer {
  const components = Object.freeze([...(options.components ?? ['Chart'])]);
  return {
    components,
    async render(component, props): Promise<ChannelNativeImage | null> {
      if (!components.includes(component)) return null;
      const chart = props as unknown as ChartProps;
      if (!Array.isArray(chart.data) || !Array.isArray(chart.series) || chart.data.length === 0)
        return null;
      const png = await svgToPng(chartSvg(chart, options), {
        ...(options.fontFiles !== undefined ? { fontFiles: options.fontFiles } : {}),
      });
      return { data: png, contentType: 'image/png' };
    },
  };
}
