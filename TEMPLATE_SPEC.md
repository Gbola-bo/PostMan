# PostMann Template Spec

This is what a `.psd` file needs to look like for PostMann's rendering engine
to work with it. Every rule here exists because of something we actually hit
while building and testing the pipeline — not theoretical caution.

## Two conventions — old and new

PostMann supports both. Existing templates keep working unchanged. New
templates can use the richer multi-field convention.

---

## NEW convention — flexible named layers

Any layer name can be made editable by prefixing it. The app discovers these
automatically and builds the correct form inputs from them — no code changes
needed when you add new templates.

### Layer prefixes

| Prefix | Example name | What the non-designer gets |
|---|---|---|
| `text:LABEL` | `text:headline` | Text input labelled "Headline" |
| `font:LABEL` | `font:name a` | Text input + **font picker** (each `font:` layer has its own picker) |
| `image:LABEL` | `image:player a` | Image picker with crop/fit modal |

`LABEL` becomes the field label in the form (title-cased). Use whatever
makes sense for your design — `text:match date`, `font:team name`,
`image:home team badge`, etc.

### PSD structure for multi-field templates

```
Artboard: "Cover"                   ← top-level LayerSet
├── text:headline                   → "Headline" text input
├── text:match date                 → "Match Date" text input
├── font:team a name                → "Team A Name" text + font picker
├── font:team b name                → "Team B Name" text + font picker
├── image:team a badge              → "Team A Badge" image picker
│   ├── Image Placeholder           → defines the crop frame
│   └── Image                       → clipped photo layer
└── image:team b badge              → "Team B Badge" image picker
    ├── Image Placeholder
    └── Image
```

**font: vs text: — when to use which:**
- Use `text:` when the font is part of the design and shouldn't change
  (a footer note, a tagline in a specific brand font)
- Use `font:` when the user should be able to pick from the font bank
  (player names, team names, headlines where brand flexibility matters)

Each `font:` layer gets a completely independent font picker. Person A can
have CoffeeCake, Person B can have Riffic Free — or the same font — it's
fully per-layer.

### Font bank

Available fonts live in `fonts.json` at the repo root. Only fonts in this
file can be selected. To add a font: drop the `.woff2`/`.otf` file into
`assets/fonts/`, add an entry to `fonts.json`, done.

Current fonts: **Funnel Display**, **CoffeeCake**, **Riffic Free**

---

## LEGACY convention — still fully supported

Templates built with the old naming keep working unchanged. The engine
auto-detects which convention a template uses.

- **`headline text`** — single editable text layer
- **`Image`** — single editable image/GIF placeholder  
- **`Image Placeholder`** — optional clip frame (if present, overrides `Image`'s own bounds)

---

## Required structure (applies to both conventions)

### Artboards (top-level layer groups)

Every slide is its own top-level LayerSet. For carousels: **Cover**, **Middle**,
**Last** (case-insensitive). Single-slide templates: one named group.

**All visual content must live inside its group.** Anything floating at the
document root gets hidden in every export.

**Artboards must not overlap.** The engine isolates one slide by hiding the
others — overlapping bounds cause bleed between exports.

### Image slots (both conventions)

The `Image` layer (or the one inside an `image:LABEL` group) works the same
way in both conventions:

1. `Image` is the sacrificial layer — it gets replaced with the user's photo
2. `Image Placeholder` (optional) defines the visible crop frame
3. `Image` should be clipped to the shape directly below it (Create Clipping Mask)
4. If `Image Placeholder` is present, it — not `Image` — sets the crop aspect ratio

---

## Vetting checklist

Run `vetTemplate(['Cover', 'Middle', 'Last'])` (or your artboard names) before
publishing any new template. It checks:

- [ ] Every expected artboard exists as a top-level group
- [ ] Every artboard has readable bounds
- [ ] No artboard has duplicate `Image` or `Image Placeholder` layers
- [ ] Any `Image` layer found has readable bounds
- [ ] No two artboards' bounds overlap
- [ ] No unexpected content floats outside the named artboard groups
- [ ] **NEW**: Lists all discovered editable fields so you can confirm the
      form will look exactly as intended

Missing `headline text` or `Image` layers are noted (not errors) — a
text-only or image-only slide is valid.

---

## Quick reference

**New convention:**
- `text:LABEL` — editable text, designer's font
- `font:LABEL` — editable text + per-layer font picker
- `image:LABEL` — group with `Image` + optional `Image Placeholder`

**Legacy convention (still works):**
- `headline text` — editable text
- `Image` — editable image/GIF

**Always:**
- One named top-level group per slide
- Nothing visual outside those groups
- Groups don't overlap
- Run the vetting tool before publishing
