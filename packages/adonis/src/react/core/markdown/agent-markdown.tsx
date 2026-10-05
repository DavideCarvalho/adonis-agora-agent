import 'katex/dist/katex.min.css';
import 'streamdown/styles.css';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import type { ComponentProps } from 'react';
import { Streamdown } from 'streamdown';

type StreamdownProps = ComponentProps<typeof Streamdown>;

export interface AgentMarkdownProps {
  /** The markdown source (typically the streaming assistant text). */
  children: string;
  /**
   * True while the surrounding chat believes the model is still streaming this message. Streamdown
   * uses the hint to defer expensive renders (Mermaid, syntax highlighting) until the block settles.
   */
  isStreaming?: boolean;
  /**
   * Extra remark plugins. This is the seam for app-specific markdown — e.g. flip splices its
   * `@base:/@user:` mention chips in via a remark plugin + a matching `components` entry here,
   * keeping that domain logic in the app rather than the library.
   */
  remarkPlugins?: StreamdownProps['remarkPlugins'];
  /** Custom element renderers (keyed by tag name), paired with `remarkPlugins`/`allowedTags`. */
  components?: StreamdownProps['components'];
  /** Custom tags (and their attributes) to keep through Streamdown's hardened sanitize schema. */
  allowedTags?: Record<string, string[]>;
  /** Tags whose children Streamdown should keep as literal text (not re-parse as markdown). */
  literalTagContent?: string[];
}

const STREAMDOWN_PLUGINS = { code, mermaid, math } as const;

/**
 * The optional rich markdown renderer for agent chat — the exact streamdown stack flip uses
 * (GFM, KaTeX math, syntax-highlighted code, Mermaid), ported 1:1 but with the flip-specific
 * mention handling lifted out into the `remarkPlugins`/`components` props so the library stays
 * domain-agnostic. Lives behind the `@adonis-agora/agent/react/markdown` subpath so the base
 * package never forces these heavy peers on consumers that don't want them.
 *
 * Pass it to a `MessageItem`/`MessageList` `renderText` slot:
 *   `renderText={(text, { isStreaming }) => <AgentMarkdown isStreaming={isStreaming}>{text}</AgentMarkdown>}`
 */
export function AgentMarkdown({
  children,
  isStreaming = false,
  remarkPlugins,
  components,
  allowedTags,
  literalTagContent,
}: AgentMarkdownProps) {
  return (
    <Streamdown
      animated
      isAnimating={isStreaming}
      plugins={STREAMDOWN_PLUGINS}
      {...(remarkPlugins !== undefined ? { remarkPlugins } : {})}
      {...(components !== undefined ? { components } : {})}
      {...(allowedTags !== undefined ? { allowedTags } : {})}
      {...(literalTagContent !== undefined ? { literalTagContent } : {})}
    >
      {children}
    </Streamdown>
  );
}
