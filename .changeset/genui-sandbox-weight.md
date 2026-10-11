---
'@adonis-agora/agent': minor
---

genui sandbox: lighter frames, purged kit styles, overlays that fit, and several kits per app.

- **Shared assets (new default).** A page fetches the kit, its styles and the Tailwind runtime once; each sandbox `srcdoc` now carries only placeholders for them, asks its host (`agora:sandbox:load`) and gets their text (`agora:sandbox:assets`), put in inline elements under the same CSP as before (no `blob:`, no network, no `allow-same-origin`). Five Lastro-kit sandboxes went from 5.36 MB of HTML to 0.25 MB, with less browser memory. `createSandboxRenderer({ assets: 'inline' })` keeps the old behaviour; React Native keeps inlining. New: `SandboxDocumentOptions.sharedAssets`, `SANDBOX_MESSAGE.load` / `.assets`, `sandboxSharedAssetsWanted()`.
- **Purged kit styles.** `genuiSandboxKit({ purge })`, on by default: with Tailwind v4, the utilities layer keeps only what the kit's code names (the frame's runtime generates the rest); Tailwind v3 drops rules naming classes the kit does not use; other CSS drops unused CSS-modules classes. `purge: false` ships everything, `{ safelist }` keeps more. New: `purgeCss()`, `classTokensOf()`, `purgeSandboxKitStyles()`.
- **Complete class vocabulary.** Non-Tailwind stylesheets are described as patterns (`m{,b,e,s,t,x,y}-{0..5,auto}`) instead of a list capped at 600 names: all of Bootstrap's 2,025 classes, spacing included, in about 10 KB. `extractCssVocabulary` gains `maxChars` (default 12,000); `maxClasses` / `maxPerFamily` now default to no cap.
- **Overlays grow the frame.** An open dialog, menu or popover (portals, `position: fixed`, `<dialog open>`, `:popover-open`, ARIA roles) counts in the frame's height while it is open, and the frame shrinks back once it closes, so a tall MUI `Dialog` or Radix `Popover` is no longer clipped.
- **See-through frame page.** The frame's `html`/`body` stay transparent whatever a kit's baseline paints (MUI `CssBaseline`, Bootstrap reboot): no more box of the theme's background beside a narrower card.
- **Named kits.** `genuiSandboxKit({ name })` builds several kits in one app, each under `/@genui-sandbox-kit/<name>/`, its own descriptor and manifest keys; the server picks one with `kitName` (`sandbox: { kit: true, kitName }`, `defineSandbox({ kitName })`), and named discovery is available for per-request choices.
