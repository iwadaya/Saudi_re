# Underwriter Manual

Source for **[`../Universe3-Underwriter-Manual.pdf`](../Universe3-Underwriter-Manual.pdf)** — a
screen-by-screen guide to the platform for treaty and facultative underwriters.
95 pages, 68 screens, each one captured from a running instance rather than drawn.

| File | What it is |
| --- | --- |
| `manual-data.mjs` | All the prose. One entry per chapter and per screen — this is the file to edit when a screen changes. |
| `build-manual.mjs` | Renders `manual-data.mjs` + `web/` into `manual.html`, then prints it to the PDF. |
| `capture-screens.mjs` | Walks every wizard in a running instance and writes full-height PNGs to `raw/`. |
| `auth.mjs` | Logs in once and caches the session, so repeated runs don't hit the login rate limiter. |
| `web/` | Web-weight JPEG of each screen (1400px). The committed image source. |
| `raw/`, `screens/`, `manual.html` | Build artefacts — git-ignored, regenerated on demand. |

## Rebuilding the PDF

Text-only changes need no screenshots:

```bash
cd docs/underwriter-manual
npm install
npm run build            # web/ + manual-data.mjs → manual.html → ../Universe3-Underwriter-Manual.pdf
```

`build-manual.mjs` slices any screenshot taller than ~1.16× its width into
page-shaped bands, because a 5,700px-tall capture shrunk to fit an A4 page is an
unreadable sliver. Bands overlap slightly so nothing is lost at the seam, and
figures are captioned "(2 of 3)".

## Recapturing the screenshots

Needs a running instance with data. The screenshots in the committed PDF were
taken against a local server seeded with `npm run seed:treaties` (100 treaties)
plus one hand-built facultative risk.

```bash
# 1. a database with the seeded portfolio
createdb universe_manual
DATABASE_URL=postgresql://…/universe_manual npm run migrate --prefix server
DATABASE_URL=postgresql://…/universe_manual npm run seed:treaties

# 2. the app, with the dev auth shortcut enabled so the capture script can log in
npm run build
NODE_ENV=development ALLOW_DEMO_AUTH=true PORT=4000 \
  DATABASE_URL=postgresql://…/universe_manual node server/src/index.js

# 3. capture, then rebuild
cd docs/underwriter-manual
npm run capture          # → raw/*.png
npm run build            # → web/*.jpg, screens/*.jpg, the PDF
```

Environment overrides: `MANUAL_BASE_URL`, `MANUAL_USER`, `MANUAL_PASSWORD`,
`MANUAL_CHROME` (a Chromium binary, if not using Playwright's own),
`MANUAL_RAW_DIR`, and `MANUAL_PROP_ID` / `MANUAL_NP_ID` / `MANUAL_NPSL_ID` /
`MANUAL_FAC_ID` to point the wizards at different records.

The wizards must be walked **through the sidebar**, not by deep-linking each
URL — several screens read state that Treaty Detail publishes when it loads, and
a cold deep link leaves them without it. `capture-screens.mjs` already does this;
it also needs records the capture user can edit (a read-only treaty blocks the
save that navigation runs, and navigation then stays put).
