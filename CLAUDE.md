## Visual direction: "Kiosk Print"

Off-white paper, black ink, one signal orange; two-ink riso scenes of everyday Nigerian bills. Precise, local, tactile. Tokens live in the `:root` block of `public/index.html` (mapped to Tailwind names in `public/tailwind-config.js`).

- **Colour has meaning:** signal orange `#ff4f00` = the one action / G$ leaving your wallet · green `#1f7a4d` = paid, funded, safe · red `#b42318` = overdue, error · ink `#111111` = text · rule `#d9d5cc` = hairlines. Never a second action colour.
- **Type:** Space Grotesk (display, headings), IBM Plex Mono (numbers, labels, amounts). Tabular numbers for money. No italics.
- **Shape:** hairline 1px rules and borders instead of shadows; cards 16px radius, buttons are pills; dot-grid only behind hero areas.
- **Illustration:** generated two-ink risograph (black + signal orange, halftone, slight misregistration), flat `#F1EFE9` knocked out to transparent WebP in `public/art/` (`scripts/knockout.py`). Hero 1–3 pieces, spots ≤ 160px for empty states and success. No text in art. In dark mode, art sits on a paper plate.
- **Motion:** press = scale .97 / 120ms ease-out; jar fill animates once on first view; respect reduced motion.
- **Don't:** gradients, glows, coloured icon tiles, grey drop shadows, emoji in UI, em-dashes in copy.
