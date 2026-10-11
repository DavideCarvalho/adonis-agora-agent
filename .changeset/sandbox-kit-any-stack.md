---
"@adonis-agora/agent": minor
---

The sandbox kit works with any styling or component stack, without presets.

`genuiSandboxKit({ styles, components, wrapper })`:

- `styles` are your style entries (plain CSS, Sass/Less, PostCSS, CSS modules, Bootstrap through `.scss`, Tailwind v3/v4). They are compiled with Vite's own CSS pipeline, and fonts and images are inlined as `data:` URIs (`inlineAssetLimit` and `inlineAssetBudget`, with warnings).
  - Tailwind is detected. The frame runs Tailwind's browser runtime with your `@theme`, `@custom-variant` and `@utility` directives, and a v3 config is mapped to v4.
  - Any other CSS reaches the model as its class vocabulary. `stylesDocs` adds your own notes.
- `components` are modules, globs, directories or packages exporting React components. In a JavaScript project the docs fall back to names and propTypes.
- `wrapper` is a module whose default export wraps the model's App (MUI's ThemeProvider + CssBaseline, emotion, styled-components). Portals render inside the frame.
- With no options, the styles come from the Vite entrypoints and the components from `components/ui`.
- `defineSandbox({ theme, kit })`: `kit: true` picks up whatever the plugin produced. The prompt describes only what exists. The frame mirrors every `data-*theme` attribute of the page root.

Other fixes:

- The frame's JSX transpiler now ships prebuilt as a string. A minifying consumer build no longer breaks it (`m is not defined`).
- Outside production, the newer of the dev descriptor and the build manifest wins.
- Theme variables are read from workspace packages linked into `node_modules`.

**Breaking (0.x):** `tailwind` and `tailwindCss` on the plugin, `entry` and `include` (now `components`), the hook's `css` (now `styles`), and `defineSandbox({ tailwind })` are removed. Passing them throws a migration message. The descriptor is `version: 2`, with assets under `assets`. See "Migration from 0.74" in the sandbox kit docs.
