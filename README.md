# PostMann (static version)

The simplified rebuild: no backend, no build step, no npm. Just static
files - HTML, CSS, JS, and your `.psd` templates - all in this one repo,
hosted on GitHub Pages.

## Why this version exists

The first build used Next.js + Google Apps Script + Drive + Sheets. That's
a reasonable architecture for a team of engineers shipping a product over
time, but for a 5-person internal tool maintained by one person, it was
more moving parts than the job needed - a real backend, OAuth/Drive setup,
and a documented CORS workaround, just to store some template files and
metadata. This version removes all of that. Google Drive's only role was
file storage - so the `.psd` files just live in this repo instead, and
`templates/manifest.json` replaces what Sheets was doing.

What's identical either way: the actual rendering engine
(`render-engine.js`) and the rules a template has to follow
(`TEMPLATE_SPEC.md`). Neither one cared whether the file came from Drive or
sat next to the HTML.

## File structure

```
index.html           <- the homepage / landing page
app.html              <- the actual app (dashboard -> form -> generate -> results)
app.js                 <- all the app's logic
home.css               <- homepage-only styling
vet.html / vet.js     <- the template vetting tool (open this when adding a new template)
render-engine.js      <- the rendering engine, unchanged in behavior
styles.css            <- shared styling (brand colors extracted from the real logo, Funnel Display font)
assets/               <- logo files, favicons, self-hosted font files, cursor accent
templates/
  manifest.json       <- the lightweight template index - just enough for the
                          dashboard to render cards (name, thumbnail, slide
                          count). Kept deliberately small so adding more
                          templates never slows down the dashboard.
  details/
    <template-id>.json  <- the heavy per-layer data for ONE template (every
                            layer name and bounds, per artboard). Fetched
                            lazily, only when that specific template is
                            opened - never loaded upfront for the whole list.
  thumbnails/
    *.png               <- dashboard card images and per-slide preview images
  *.psd                <- your actual template files
```

## How it works

1. `index.html` (the homepage) links to `app.html` ("Get Started") and
   `vet.html` ("Template tool").
2. `app.html` loads `templates/manifest.json` - the lightweight index only -
   and shows each template as a card. This stays fast no matter how many
   templates exist, since it never downloads any template's heavy
   per-layer data just to render a card.
3. Picking a template fetches that ONE template's `templates/details/<id>.json`
   (cached after the first time), then builds the form from it - artboard
   names, placeholder aspect ratios for the crop tool. No Photopea load
   happens yet.
4. Photopea only boots once you click "Generate" - it fetches the actual
   `.psd` from `templates/`, applies your text/images, and exports.

**Backward compatible:** if a manifest entry still has its metadata
embedded directly (the old, pre-split format), the app uses it as-is with
no fetch at all - nothing breaks, you just don't get the faster-dashboard
benefit for that one entry until it's re-vetted with the current tool.

## Adding a new template

1. Open `vet.html` (also linked from the top bar).
2. Pick the `.psd` from your computer, fill in its expected artboard names
   (and which one, if any, repeats - like a carousel's middle slides).
3. Click "Run vetting". If it passes, a dashboard preview image and a
   per-slide preview for every artboard are generated automatically from
   the template's actual default state - no separate images to create by
   hand, and they can never drift out of sync since they *are* the
   template. Prefer a custom dashboard shot instead? Upload one right
   there and it replaces the auto-generated one - entirely optional.
4. You'll get the updated `manifest.json` (the lightweight index - paste
   your current one into the tool first so it can merge correctly) plus a
   separate detail-file download for every template that needs one -
   including any older entries it automatically migrates out of the old
   embedded-metadata format the first time you run it.
5. Replace the entire contents of `templates/manifest.json` with the new
   index.
6. Save each downloaded detail file into `templates/details/`, using the
   filename shown.
7. Copy the actual `.psd` file into `templates/`, and every downloaded
   preview image into `templates/thumbnails/` - each named to match its
   path in the index.
8. Commit everything and push. That's the entire publish step - no
   separate upload, no waiting on anything else.

`TEMPLATE_SPEC.md` has the full rules a `.psd` needs to follow for any of
this to work.

## Running it locally before you push

Opening `index.html` directly as a `file://` URL won't work - `fetch()`
(used to load the manifest, detail files, and the PSDs) is blocked from
`file://` pages in most browsers. Run a tiny local server instead:

```
python3 -m http.server 8000
```
(or, if you have Node: `npx serve`)

then open `http://localhost:8000`.

## Known limitations (unchanged from before)

- GIF exports come out at the full canvas size, not cropped to one slide -
  see the comment in `render-engine.js`'s `exportArtboardAnimated`.
- Video is paused, not supported.
- No cross-device project history - this version has no backend to store
  it in. If that's ever actually needed, that's the point to reconsider
  adding one back.
