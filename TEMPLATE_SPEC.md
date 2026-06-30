# PostMann Template Spec

This is what a `.psd` file needs to look like for PostMann's rendering engine
to work with it. Every rule here exists because of something we actually hit
while building and testing the pipeline - not theoretical caution.

## Your workflow

1. Build the template in Photoshop, following the naming rules below.
2. Upload it to the `Templates/` folder in Google Drive.
3. **Run the vetting tool before it goes live.** This loads the template into
   the same render engine end users will use, checks it against this spec,
   and reports problems - missing artboards, ambiguous layer names,
   overlapping slides, unreadable bounds - before a real user ever hits them.
4. Fix anything flagged in Photoshop, re-upload, re-vet.
5. Once vetting passes, the template's metadata (artboard list, placeholder
   sizes, layer names) gets cached. End users never trigger extraction live -
   they just read this cached metadata when the form renders, and the engine
   only loads the template again at actual generation time.

## Required structure

### Artboards (top-level layer groups)

Every slide is its own top-level layer group ("LayerSet" in Photoshop's own
terms). For the carousel template type validated so far, that's three groups
named exactly **Cover**, **Middle**, and **Last** (matching is
case-insensitive, but use this casing for consistency). Other template types
(single-slide promos, flyers) should still wrap their content in one named
top-level group rather than leaving it flat at the document root - the engine
is built around "find a group by name, then look inside it," and a flat,
group-less document doesn't fit that model.

**All of a slide's visual content must live inside its own group.** Nothing
should sit at the top level outside any group. Why: when the engine exports
one slide, it hides every top-level layer except that slide's group. Anything
floating outside all groups gets hidden in every single export, including
ones it was supposed to appear in.

**Artboards must not overlap.** They typically sit side by side on one shared
canvas. If two artboards' bounding boxes overlap, exporting one will bleed
into the other, because isolation works by hiding everything else - it
doesn't crop at the pixel level.

### Inside each artboard

Two layer names are load-bearing - the engine finds them by exact name, not
by guessing:

- **`headline text`** (lowercase, exact spelling) - a text layer, if this
  slide should have editable text. Not required; a slide can have no text.
- **`Image`** (capital I) - the layer that holds the photo/GIF content, if
  this slide should have a photo placeholder. **Not required.** A text-only
  slide (a closing CTA slide, for example) legitimately has no `Image`
  layer at all, and the engine treats that as normal, not an error.

If you do include an `Image` layer, **clip it to the shape that defines the
visible crop region**, the same way you'd clip any photo into a frame in
Photoshop. That underlying shape can be named anything - the engine finds it
by its position in the layer stack (directly below `Image`), not by name. The
engine resizes and re-clips whatever photo goes in to match this layer's
current size and position, so make sure `Image`'s bounds in the original PSD
already match where you want photos to appear.

**Don't duplicate these names within one artboard.** If an artboard has two
layers both named `Image`, lookups use the first match found, and the result
is ambiguous - not necessarily wrong, but not something you control. It's
completely fine and expected for `headline text` and `Image` to repeat
*across* different artboards (Cover and Middle can each have their own) -
each artboard's content is looked up scoped to that artboard, so there's no
collision between slides.

## Known limitations to plan around

These aren't bugs to wait on - they're current, deliberate trade-offs in how
rendering works today:

- **Animated (GIF) exports come out at full canvas size**, not cropped to
  one artboard. A from-scratch fix (decode each frame, crop, re-encode
  client-side) was scoped but deliberately shelved for now. If a slide will
  be animated, keep that artboard reasonably small relative to the whole
  canvas, since the exported file carries the full canvas's dimensions.
- **Video is paused.** Photopea has a documented, currently open bug
  producing inconsistent MP4 exports. GIF is the only supported animated
  format right now.
- **Certain smart-object structures can hang a whole-document duplicate
  operation indefinitely** (a confirmed Photopea bug, not specific to any
  one template). The current rendering pipeline never calls that operation,
  so this isn't an active risk today - but if you're extending the engine
  later and reach for "duplicate the document," test against a template with
  embedded/linked smart objects first.
- **Nested layer bounds can occasionally not be ready immediately after a
  large PSD finishes loading**, even though the artboards' own bounds
  already are. The engine retries automatically once after a short delay if
  it sees this, so it's self-healing - but if a *very* large or complex
  template still fails after that retry, that's worth investigating rather
  than dismissing.

## Vetting checklist (what the tool checks for you)

Running `engine.vetTemplate(['Cover', 'Middle', 'Last'])` (or whatever your
template's expected artboard names are) checks:

- [ ] Every expected artboard name is found as a top-level group.
- [ ] Every found artboard has readable bounds.
- [ ] No artboard has more than one layer named `Image` (ambiguous lookup).
- [ ] Any `Image` layer found has readable bounds (catches the rare
      timing/structural issue the auto-retry doesn't resolve on its own).
- [ ] No two artboards' bounds overlap.
- [ ] No unexpected top-level content exists outside the named artboards
      (content there will be silently hidden during every export).

It will *not* flag a missing `headline text` or `Image` layer as an error -
those are valid, common designs (a text-only slide, an image-only slide). It
flags them as informational notes so you can confirm that's intentional, not
a mistake.

## Quick reference

- Top-level groups, one per slide, named exactly per the template type's
  convention (Cover/Middle/Last for carousels).
- Nothing visual outside those groups.
- Groups don't overlap.
- `headline text` for editable text (optional, exact name).
- `Image`, clipped to a shape directly below it, for a photo placeholder
  (optional, exact name).
- At most one `headline text` and one `Image` per artboard.
- Run vetting before publishing. Fix what it flags as an issue; read what it
  flags as a note, and confirm it matches your intent.
