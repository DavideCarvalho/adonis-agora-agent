import { useCallback, useEffect, useRef, useState } from 'react';

export interface StickToBottomOptions {
  /**
   * Changes whenever the rendered content grows — the signal to re-pin. A string rather than the
   * message array because a streaming turn mutates in place: the array identity is stable while its
   * last part's text keeps growing.
   */
  contentKey: string;
  /**
   * How far off the bottom (px) still counts as "at the bottom". Sub-pixel layout and fractional
   * device ratios leave a residue of a pixel or two after a programmatic scroll, so an exact
   * comparison unpins the view on the very scroll event it just caused.
   */
  threshold?: number;
}

export interface StickToBottom {
  /** While true, new content scrolls into view; the user scrolling up turns it off. */
  isAtBottom: boolean;
  /** Whether a "jump to latest" affordance is warranted. */
  showJumpToLatest: boolean;
  scrollToBottom: () => void;
  /** Spread onto the scrolling element. Behaviour only — no classes, no styles. */
  getContainerProps: () => {
    ref: (element: HTMLElement | null) => void;
    onScroll: () => void;
  };
}

/**
 * Follow a streaming transcript only while the reader is already at the bottom. Reading back
 * through history during a stream is the case this exists for: an unconditional scroll-to-bottom
 * yanks the viewport away mid-sentence on every token.
 */
export function useStickToBottom({
  contentKey,
  threshold = 32,
}: StickToBottomOptions): StickToBottom {
  const containerRef = useRef<HTMLElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const measure = useCallback(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setIsAtBottom(distance <= threshold);
  }, [threshold]);

  const scrollToBottom = useCallback(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
    setIsAtBottom(true);
  }, []);

  const setContainer = useCallback(
    (element: HTMLElement | null) => {
      containerRef.current = element;
      if (element) {
        measure();
      }
    },
    [measure],
  );

  // Re-pin as content arrives. Guarded on `isAtBottom` so a reader who scrolled up keeps their
  // position for the rest of the stream, and re-pins the moment they scroll back down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `contentKey` IS the content dependency
  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom();
    }
  }, [contentKey, isAtBottom, scrollToBottom]);

  const getContainerProps = useCallback(
    () => ({ ref: setContainer, onScroll: measure }),
    [setContainer, measure],
  );

  return {
    isAtBottom,
    showJumpToLatest: !isAtBottom,
    scrollToBottom,
    getContainerProps,
  };
}
