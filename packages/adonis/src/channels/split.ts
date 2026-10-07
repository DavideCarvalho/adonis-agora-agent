/**
 * Split `text` into messages of at most `maxLength` characters, cutting where a reader would: at a
 * paragraph break, else a line break, else the end of a sentence, else a space — and only when
 * none of those falls past the first third of the window, mid-word. Whitespace at the cut is dropped;
 * empty pieces are never returned.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError('maxLength must be a positive integer');
  }
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength + 1);
    const floor = Math.floor(maxLength / 3);
    const cut =
      lastBreak(window, /\n\s*\n/g, floor) ??
      lastBreak(window, /\n/g, floor) ??
      lastBreak(window, /[.!?…](?=\s)/g, floor, true) ??
      lastBreak(window, /\s/g, floor) ??
      maxLength;
    const piece = rest.slice(0, cut).trimEnd();
    if (piece.length > 0) pieces.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * Where the last match of `pattern` in `window` lets the text be cut, if that is past `floor`:
 * before the match, or after it (`keep` — a sentence keeps its full stop). `null` when there is none.
 */
function lastBreak(window: string, pattern: RegExp, floor: number, keep = false): number | null {
  let found: number | null = null;
  for (const match of window.matchAll(pattern)) {
    const index = match.index ?? 0;
    const at = keep ? index + match[0].length : index;
    // A cut must leave the piece within the limit (the window is one character longer).
    if (at > floor && at <= window.length - 1) found = at;
  }
  return found;
}
