import { COMPONENT_NAME } from './genui/catalog.js';

/** Renderer support only. Component definitions and authorization remain server-owned. */
export interface UiCapabilities {
  components: Array<{ name: string; version: number }>;
}

export function validateUiCapabilities(value: unknown): UiCapabilities {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== 'components') ||
    !Array.isArray(value.components)
  )
    throw new TypeError('Invalid UI capabilities');
  const seen = new Set<string>();
  const components = value.components.map((component: unknown) => {
    if (
      !record(component) ||
      Object.keys(component).some((key) => key !== 'name' && key !== 'version') ||
      typeof component.name !== 'string' ||
      !COMPONENT_NAME.test(component.name) ||
      !Number.isSafeInteger(component.version) ||
      Number(component.version) <= 0 ||
      seen.has(component.name)
    )
      throw new TypeError('Invalid UI component capability');
    seen.add(component.name);
    return { name: component.name, version: Number(component.version) };
  });
  return { components };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
