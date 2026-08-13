---
"@adonis-agora/agent-dashboard": minor
---

Ported the console's visual identity to match `nestjs-agent/packages/dashboard`'s Aviary console 1:1, overruling the earlier "Agora keeps its own distinct brand identity" decision (see `thin-buttons-relax` changeset) now that side-by-side screenshots show it was never actually close.

Verified by building both consoles against realistic seeded data (a thin API shim serving every governance endpoint on this side; the Nest sibling's own `preview.html` mock-data harness on the other) and screenshotting every section, light and dark, via an isolated headless Chrome.

- Dark is now the unconditional default canvas (was light-by-default with dark as an opt-out) — the single biggest reason the two consoles read as unrelated at a glance. Light stays available as an Agora-only extra behind the explicit toggle; Nest's agent console has no light mode at all.
- Token values now match Aviary's spec byte-for-byte: the shared dark neutrals (`--bg #09090b`, `--panel #0c0c0f`, `--panel-2 #101017`, `--line #1c1c22`, `--text #e7e7ea`, `--muted #76767f`) and the agent console's own accent (`#a78bfa` violet, replacing Agora's `#5a45ff`). The "in flight" status colour moved from cyan to Aviary's blue (`#60a5fa`).
- Body font is now Space Grotesk (was the system sans stack); `.mono` now matches the reference's stack order. Both are loaded the same way the Nest sibling loads them, via Google Fonts links in `index.html`.
- The active nav tab, and every semantic button (approve/reject), moved from a solid colour fill to a subtle tinted outline (`color-mix` border + background tint, text stays the console's normal foreground) — the loud filled-pill look was the second biggest source of "doesn't look anything alike".
- Panel radius (14px → 12px) and button/tab radius (999px pill / 8px → 6-8px) now match the reference's card and button primitives.
- Table bodies are fully monospace with tabular numerals now (previously only the numeric/id columns were), matching the reference's `TableBody` primitive.
- The brand mark and header subtitle now use the same bordered/tinted-tile and mono-uppercase-tracked treatments as the reference instead of a solid gradient badge and a plain grey caption.

Left alone, on purpose: the Nest sibling has no server-sent-events "Live" tab (no backend streaming plumbing here to back one — a real, pre-existing gap, not something this pass could close honestly); the Approvals/Runs sections keep this console's own table-based layout rather than the reference's stacked-card layout (same data, same button treatment, different list chrome — a lower-priority structural difference left for a follow-up); and no icon set was added to nav items/stat cards (the reference's SVG icon set was not ported in this pass).
