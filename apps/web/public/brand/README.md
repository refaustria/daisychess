# DaisyChess brand assets

- `daisy.svg` – the mark (14 white petals, yellow centre with a faint pawn hint), viewBox 0 0 64 64.
- `daisy-wordmark.svg` – mark plus "DaisyChess" (system sans, 700, `currentColor` text).
- `../favicon.svg` – copy of the mark.
- `icon-192.png`, `icon-512.png` – transparent PNGs; `apple-touch-icon.png` – 180x180 on white with padding; `favicon-32.png`.

Regenerate PNGs and the contact sheet (`test-results/screenshots/brand-sheet.png`) with
`node apps/web/scripts/render-brand.mjs` (Playwright/Chromium). Re-copy `daisy.svg` to `../favicon.svg` if the mark changes.

Colours: petal fill `#FFFFFF`, petal outline `#B8C0CA`, centre `#F5C518`, centre ring `#D9A000`, pawn hint `#B88A00` at 55% opacity. Wordmark text follows `currentColor`.
