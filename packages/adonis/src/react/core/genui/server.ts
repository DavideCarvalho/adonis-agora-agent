import { readFile } from 'node:fs/promises';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentPresentation } from '../../../genui/index.js';
import type { ReactComponentRegistry } from './react-registry.js';

export { createReactComponentRegistry, type ReactComponentRegistry } from './react-registry.js';

export interface CaptureOptions {
  width?: number;
  height?: number;
  timeoutMs?: number;
}
export interface CaptureAdapter {
  images(html: readonly string[], options: CaptureOptions): Promise<Uint8Array[]>;
  pdf(html: readonly string[], options: CaptureOptions): Promise<Uint8Array>;
}
export interface ServerRenderOptions extends CaptureOptions {
  rowsPerPage?: number;
  capture?: CaptureAdapter;
}
export interface ReactServerRendererOptions {
  registry: ReactComponentRegistry;
  /** Trusted app CSS, or a trusted filesystem path; never supply user CSS. */
  stylesheet?: string | { path: string };
  theme?: string;
  capture?: CaptureAdapter;
}
export function boundedCaptureOptions(options: CaptureOptions): Required<CaptureOptions> {
  const result = {
    width: options.width ?? 1200,
    height: options.height ?? 1600,
    timeoutMs: options.timeoutMs ?? 15000,
  };
  for (const [key, value, min, max] of [
    ['width', result.width, 320, 4096],
    ['height', result.height, 200, 16384],
    ['timeoutMs', result.timeoutMs, 100, 60000],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max)
      throw new RangeError(`genui: ${key} must be ${min}–${max}`);
  }
  return result;
}
export function createReactServerRenderer(options: ReactServerRendererOptions) {
  async function content(presentation: ComponentPresentation<object>) {
    const rendered = await options.registry.render(presentation, 'react');
    return renderToStaticMarkup(
      createElement(
        'main',
        { 'data-component': presentation.component, 'data-theme': options.theme },
        rendered as ReactNode,
      ),
    );
  }
  async function stylesheet() {
    return typeof options.stylesheet === 'object'
      ? readFile(options.stylesheet.path, 'utf8')
      : (options.stylesheet ?? '');
  }
  async function html(presentation: ComponentPresentation<object>): Promise<string> {
    return document(await content(presentation));
  }
  async function document(markup: string) {
    const css = await stylesheet();
    // Closing tags in trusted CSS must still never break out of the style element.
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body>${markup}</body></html>`;
  }
  async function pages(presentation: ComponentPresentation<object>, settings: ServerRenderOptions) {
    const limits = boundedCaptureOptions(settings);
    const size = settings.rowsPerPage ?? 30;
    if (!Number.isInteger(size) || size < 1 || size > 500)
      throw new RangeError('genui: rowsPerPage must be 1–500');
    const capture = settings.capture ?? options.capture;
    if (!capture) throw new Error('genui: a capture adapter is required for PNG/PDF output');
    const rendered = await options.registry.renderPages(presentation, size);
    return {
      html: await Promise.all(
        rendered.map((node) =>
          document(
            renderToStaticMarkup(
              createElement(
                'main',
                { 'data-component': presentation.component, 'data-theme': options.theme },
                node,
              ),
            ),
          ),
        ),
      ),
      capture,
      limits,
    };
  }
  return {
    html,
    async images(presentation: ComponentPresentation<object>, settings: ServerRenderOptions = {}) {
      const page = await pages(presentation, settings);
      return page.capture.images(page.html, page.limits);
    },
    async pdf(presentation: ComponentPresentation<object>, settings: ServerRenderOptions = {}) {
      const page = await pages(presentation, settings);
      return page.capture.pdf(page.html, page.limits);
    },
  };
}
