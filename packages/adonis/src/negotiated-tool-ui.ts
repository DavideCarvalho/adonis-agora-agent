import { snapshotActionProposal } from './action-proposal-transitions.js';
import type { Catalog } from './genui/index.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { ToolDescribeScope } from './spi/tool.js';

import { createUiCollector, type UiCollector } from './tool-ui.js';
export type ResolveToolUiCatalog = (scope: ToolDescribeScope) => Catalog | Promise<Catalog>;
export interface NegotiatedUiCollector extends UiCollector {
  text(): string;
}
export function createNegotiatedUiCollector(
  toolCallId: string,
  scope: ToolDescribeScope,
  resolveCatalog?: ResolveToolUiCatalog,
  writer?: SinkWriter,
): NegotiatedUiCollector {
  const collector = createUiCollector(toolCallId, writer);
  const texts = new Map<string, string>();
  let next = 0;
  return {
    components: collector.components,
    text: () => [...texts.values()].join('\n'),
    restart: () => {
      next = 0;
      texts.clear();
      collector.restart();
    },
    emit: async (component, props, options = {}) => {
      if (!resolveCatalog) {
        if (scope.uiCapabilities !== undefined)
          throw new Error('UI capabilities require an authorized server catalog');
        return collector.emit(component, props, options);
      }
      props = snapshotActionProposal(props);
      options = { ...options };
      const { prepareUiEmission } = await import('./genui/index.js');
      if (typeof prepareUiEmission !== 'function') {
        if (scope.uiCapabilities !== undefined)
          throw new Error('UI capabilities require an upgraded @dudousxd/nestjs-agent-core peer');
        return collector.emit(component, props, options);
      }
      const catalog = await resolveCatalog(scope);
      const prepared = await prepareUiEmission(
        catalog,
        scope.uiCapabilities,
        component,
        props,
        options.version,
      );
      const id = options.id ?? `${toolCallId}:ui:${next++}`;
      if (prepared.kind === 'text') {
        texts.set(id, prepared.text);
        await writer?.write({ t: 'text', v: prepared.text });
        return { id };
      }
      const fallbackText =
        'fallbackText' in prepared && typeof prepared.fallbackText === 'string'
          ? prepared.fallbackText
          : undefined;
      const versions = 'componentVersions' in prepared ? prepared.componentVersions : undefined;
      const componentVersions =
        versions !== null && typeof versions === 'object' && !Array.isArray(versions)
          ? (snapshotActionProposal(versions) as Record<string, number>)
          : undefined;
      return collector.emit(prepared.component, prepared.props, {
        id,
        version: prepared.version,
        ...(fallbackText !== undefined ? { fallbackText } : {}),
        ...(componentVersions !== undefined ? { componentVersions } : {}),
      });
    },
  };
}
