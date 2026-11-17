import { afterEach } from 'vitest';

// Pages keep their filters in the URL hash (`#runs?status=failed`). The test
// environment keeps one `location` per file, so reset it after each test: a filter left by one test
// must not open the next one filtered. (Node-environment specs have no `window`.)
afterEach(() => {
  if (typeof window !== 'undefined') window.history.replaceState(null, '', '/');
});
