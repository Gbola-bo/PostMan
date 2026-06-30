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
file storage - so the `.psd` files just live in this repo instead, and a
single `templates/manifest.json` file replaces what Sheets was doing.

What's identical either way: the actual rendering engine
(`render-engine.js`) and the rules a template has to follow
(`TEMPLATE_SPEC.md`). Neither one cared whether the file came from Drive or
sat next to the HTML.

## File structure

```
index.html          <- the app itself (dashboard -> form -> generate -> results)
app.js               <- all the app's logic
vet.html / vet.js    <- the template vetting tool (open this when adding a new template)
render-engine.js     <- the rendering engine, unchanged in behavior
styles.css           <- all styling (brand colors extracted from the real logo, Funnel Display font)
assets/              <- logo files, favicons, self-hosted font files
templates/
  manifest.json      <- the template "database" - replaces Sheets + Drive
  *.psd              <- your actual template files live here
```

## How it works

1. `index.html` loads `templates/manifest.json` on page load and shows
   each template as a card.
2. Picking a template builds the form **using cached metadata already in
   the manifest** - artboard names, placeholder aspect ratios for the crop
   tool. No Photopea load happens yet, so this is instant.
3. Photopea only boots once you click "Generate" - it fetches the actual
   `.psd` from `templates/`, applies your text/images, and exports.

## Adding a new template

1. Open `vet.html` (also linked from the top bar).
2. Pick the `.psd` from your computer, fill in its expected artboard names
   (and which one, if any, repeats - like a carousel's middle slides).
3. Click "Run vetting". If it passes, a dashboard preview image is
   generated automatically from the template's actual default state
   (the first artboard listed) - no separate image to create by hand, and
   it can never drift out of sync since it *is* the template. Prefer a
   custom shot instead? Upload one right there and it replaces the
   auto-generated one - entirely optional.
4. You'll also get a ready-made JSON block.
5. Copy that block into `templates/manifest.json`'s `templates` array.
6. Copy the actual `.psd` file into `templates/`, and the downloaded
   preview image into `templates/thumbnails/` - both named to match the
   `"file"` and `"thumbnail"` fields in the JSON you just pasted.
7. Commit both changes and push. That's the entire publish step - no
   separate upload, no waiting on anything else.

`TEMPLATE_SPEC.md` has the full rules a `.psd` needs to follow for any of
this to work.

## Running it locally before you push

Opening `index.html` directly as a `file://` URL won't work - `fetch()`
(used to load the manifest and the PSDs) is blocked from `file://` pages in
most browsers. Run a tiny local server instead:

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
