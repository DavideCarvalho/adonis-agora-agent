---
"@adonis-agora/agent": patch
---

The native genui tree renderer (`@adonis-agora/agent/react/genui`) re-renders only the nodes that changed. The transcript keeps a pushed component's block, and the tree renderer keeps each node, the same object while it is structurally equal to the previous frame's, and tree nodes are memoized on that identity. Before, every node rendered again on each chat update (every token, every partial frame), and a renderer that set state in a layout effect (a chart that measures itself) could drive a fast stream into "Maximum update depth exceeded". A node whose props grew, or whose `incomplete`/`held` flag flipped, still renders.
