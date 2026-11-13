module.exports = {
  plugins: {
    // Tailwind 4: the PostCSS plugin handles vendor prefixing itself. The theme is declared in CSS
    // (`src/app/index.css` imports the console kit's `tokens.css`).
    '@tailwindcss/postcss': {},
  },
};
