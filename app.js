import { PostManRenderEngine, applyCropToImage, extractFrames, fileToDataUrl } from './render-engine.js?v=17';

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const screens = {
  dashboard: $('screen-dashboard'),
  form: $('screen-form'),
  generating: $('screen-generating'),
  results: $('screen-results'),
};
function showScreen(name, fromPopState = false) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
  // Push meaningful screens into browser history so the back button
  // navigates between PostMann screens rather than leaving the app.
  // 'generating' is intentionally excluded - there's no useful state
  // to return to mid-render, and it exits naturally to 'results'.
  if (!fromPopState && (name === 'form' || name === 'results')) {
    history.pushState({ screen: name }, '');
  }
}

// Browser back button: navigate between screens, not away from the app.
// When history runs out of PostMann states the browser naturally goes
// back to wherever the user came from (e.g. index.html).
window.addEventListener('popstate', (e) => {
  const screen = e.state?.screen;
  if (screen === 'results') showScreen('results', true);
  else if (screen === 'form') showScreen('form', true);
  else showScreen('dashboard', true); // initial state — still on app.html
});

// ---------- State ----------
let manifest    = null;
let currentTemplate = null;
let fontBank    = [];          // loaded from fonts.json on startup
const cropRects = new Map();   // keyed by "{slideKey}:{slotName}" for slots, "{slideKey}" for legacy
const fitModes  = new Map();   // same key space → 'cover' | 'fit'
const slotFonts = new Map();   // keyed by "{slideKey}:{layerName}" → font psName
let middleCount = 1;
let currentPageIndex = 0;
const templateDetailsCache = new Map(); // template id -> metadata, fetched lazily on first open

// Fetches the heavy per-layer metadata for one template, only when it's
// actually opened - never upfront for the whole list. This is the whole
// point of splitting the manifest: dashboard load time stays flat no
// matter how many templates exist, since none of their detail files are
// touched until a user picks that specific one.
//
// Backward compatible with old-format manifests where metadata was still
// embedded directly on the index entry (from before this split existed) -
// in that case it's already in hand, no fetch needed at all.
async function fetchTemplateMetadata(template) {
  if (template.metadata) return template.metadata;
  if (templateDetailsCache.has(template.id)) return templateDetailsCache.get(template.id);
  const res = await fetch(`templates/details/${template.id}.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(
      `Could not load details for "${template.name}" (HTTP ${res.status}). ` +
      `Was templates/details/${template.id}.json committed? Re-run the template tool if needed.`
    );
  }
  const details = await res.json();
  templateDetailsCache.set(template.id, details.metadata);
  return details.metadata;
}

// ---------- Load manifest, render dashboard ----------
async function loadManifest() {
  // Load font bank and manifest in parallel — both needed before anything renders.
  const [manifestRes, fontsRes] = await Promise.all([
    fetch(`templates/manifest.json?t=${Date.now()}`, { cache: 'no-store' }),
    fetch(`fonts.json?t=${Date.now()}`, { cache: 'no-store' }).catch(() => null),
  ]);
  manifest = await manifestRes.json();
  if (fontsRes && fontsRes.ok) {
    const fontsData = await fontsRes.json();
    fontBank = fontsData.fonts || [];
  }
  renderDashboard();
}

function renderDashboard() {
  const grid = $('templateGrid');
  grid.innerHTML = '';
  manifest.templates.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'template-card';
    const coverInner = t.thumbnail
      ? `<img src="${t.thumbnail}" alt="">`
      : '';
    card.innerHTML = `
      <div class="cover ${t.thumbnail ? '' : 'brand-gradient'}">
        ${coverInner}
        <div class="cover-caption"><span>${escapeHtml(t.name)}</span></div>
      </div>
      <div class="info">
        <div class="name">${escapeHtml(t.name)}</div>
        <div class="meta">${t.artboards.length} slide${t.artboards.length === 1 ? '' : 's'}${t.repeatable ? ' (expandable)' : ''}</div>
      </div>
    `;
    card.addEventListener('click', () => openTemplate(t));
    grid.appendChild(card);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Dynamic form ----------
async function openTemplate(template, { forceRebuild = false } = {}) {
  const isSameTemplate = currentTemplate && currentTemplate.id === template.id;
  const needsRebuild = forceRebuild || !isSameTemplate || !$('formPagesTrack').children.length;

  if (!needsRebuild) {
    showScreen('form');
    return;
  }

  // Transition immediately so the tap feels responsive, then stream the
  // real content in once the (usually fast, but not instant) details
  // fetch resolves - rather than leaving the dashboard looking frozen.
  $('formTemplateName').textContent = template.name;
  $('formPagesTrack').innerHTML = '<div style="padding:60px 0; text-align:center; color:var(--text-tertiary); font-size:13px;">Loading template...</div>';
  $('middleCountRow').classList.add('hidden');
  $('carouselDots').innerHTML = '';
  $('carouselPrevBtn').classList.add('hidden');
  $('carouselNextBtn').classList.add('hidden');
  showScreen('form');

  let metadata;
  try {
    metadata = await fetchTemplateMetadata(template);
  } catch (e) {
    $('formPagesTrack').innerHTML = '';
    alert(e.message);
    showScreen('dashboard');
    return;
  }

  currentTemplate = { ...template, metadata };
  cropRects.clear();
  fitModes.clear();
  slotFonts.clear();
  middleCount = 1;
  renderForm();
}

function toAspect(bounds) {
  return { width: bounds.width, height: bounds.height, aspect: bounds.width / bounds.height };
}

function aspectInfoFor(artboardName) {
  const ab = (currentTemplate.metadata.artboards || []).find(
    (a) => a.name.toLowerCase() === artboardName.toLowerCase()
  );
  if (!ab) return null;
  const layers = ab.childLayerNames || [];

  // 1. Prefer an explicitly-named "Image Placeholder" layer when present.
  const placeholderEntry = layers.find((c) => c.name === 'Image Placeholder' && c.bounds);
  if (placeholderEntry) return toAspect(placeholderEntry.bounds);

  // 2. Otherwise, mirror the SAME structural rule render-engine.js itself
  // uses to find the real clip-mask shape: whatever layer sits
  // immediately below "Image" at the same depth in the layer stack -
  // regardless of what the template author named it. This is the actual
  // visible crop window even when the "Image Placeholder" naming
  // convention wasn't used for this template.
  const imageIndex = layers.findIndex((c) => c.name === 'Image');
  if (imageIndex >= 0) {
    const imageDepth = layers[imageIndex].depth;
    for (let i = imageIndex + 1; i < layers.length; i++) {
      if (layers[i].depth < imageDepth) break; // walked back out of this nesting level without finding a sibling
      if (layers[i].depth === imageDepth) {
        if (layers[i].bounds) return toAspect(layers[i].bounds);
        break; // found the structural sibling, but its bounds are unreadable - that's a different problem, don't keep scanning past it
      }
    }
  }

  // 3. Last resort: "Image"'s own bounds (e.g. no sibling layer exists
  // at all below it - a flat, single-shape placeholder with no separate
  // clip mask).
  const entry = layers.find((c) => c.name === 'Image' && c.bounds);
  if (!entry) return null;
  return { width: entry.bounds.width, height: entry.bounds.height, aspect: entry.bounds.width / entry.bounds.height };
}

// Looks up this artboard's actual default-state preview, generated and
// saved by the vetting tool. Optional field - older manifest entries
// (vetted before this feature existed) simply won't have it, and the
// page falls back to a plain gradient placeholder instead of breaking.
function previewUrlFor(artboardName) {
  return (currentTemplate.artboardPreviews && currentTemplate.artboardPreviews[artboardName.toLowerCase()]) || null;
}

function buildPageList() {
  const repeatable = currentTemplate.repeatable;
  const list = [];
  currentTemplate.artboards.forEach((artboardName) => {
    if (repeatable && artboardName.toLowerCase() === repeatable.toLowerCase()) {
      for (let i = 0; i < middleCount; i++) {
        list.push({ artboardName, key: `middle-${i}`, label: `${artboardName} #${i + 1}` });
      }
    } else {
      list.push({ artboardName, key: artboardName.toLowerCase(), label: artboardName });
    }
  });
  return list;
}

function renderForm() {
  const track = $('formPagesTrack');
  track.innerHTML = '';
  currentPageIndex = 0;
  const repeatable = currentTemplate.repeatable;

  $('middleCountRow').classList.toggle('hidden', !repeatable);
  if (repeatable) {
    $('middleCountLabel').textContent = `How many ${repeatable} slides?`;
    $('middleCountInput').value = middleCount;
  }

  buildPageList().forEach(({ artboardName, key, label }) => {
    track.appendChild(buildFormPage(artboardName, key, label));
  });
  setupCarouselNav();
}

function buildFormPage(artboardName, key, label) {
  const page = document.createElement('div');
  page.className = 'form-page';
  page.dataset.key = key;

  const previewUrl = previewUrlFor(artboardName);
  const preview = document.createElement('div');
  preview.className = `form-page-preview ${previewUrl ? '' : 'brand-gradient'}`;
  preview.innerHTML = `
    ${previewUrl ? `<img src="${previewUrl}" alt="">` : ''}
    <div class="form-page-label"><span>${escapeHtml(label)}</span></div>
  `;
  page.appendChild(preview);
  page.appendChild(buildSlideFields(artboardName, key));
  return page;
}

// ── Dynamic form builder ─────────────────────────────────────────────────
// Uses PostManRenderEngine.discoverFields() to read the template metadata
// and generate the right inputs for EACH artboard automatically.
// Both the new convention (text:, font:, image:) and legacy fields work.

function buildSlideFields(artboardName, key) {
  const card = document.createElement('div');
  card.className = 'slide-card';
  card.dataset.key   = key;
  card.dataset.artboard = artboardName;

  // Get the discovered fields for this artboard
  const ab = (currentTemplate.metadata?.artboards || []).find(
    (a) => a.name.toLowerCase() === artboardName.toLowerCase()
  );
  const fields = PostManRenderEngine.discoverFields(ab ? [ab] : []);

  // Render each field
  fields.forEach((field) => {
    if (field.type === 'text') {
      buildTextField(card, key, artboardName, field);
    } else if (field.type === 'image') {
      buildImageField(card, key, artboardName, field);
    }
  });

  // Fallback: if metadata has no fields at all, show the old generic layout
  if (!fields.length) {
    buildTextField(card, key, artboardName, { layerName: 'headline text', label: 'Headline text', fontSwitchable: false, legacy: true });
    buildImageField(card, key, artboardName, { layerName: 'Image', label: 'Photo / GIF', legacy: true });
  }

  return card;
}

function buildTextField(card, key, artboardName, field) {
  const wrapId = `font-${key}-${field.layerName.replace(/[^a-z0-9]/gi, '_')}`;
  const label = document.createElement('label');
  label.className = 'field-label';
  label.style.marginTop = card.children.length === 0 ? '0' : '';
  label.textContent = field.label;
  card.appendChild(label);

  if (field.fontSwitchable && fontBank.length) {
    // font: layer — text input + inline font picker side by side
    const row = document.createElement('div');
    row.className = 'field-font-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input field-text-layer';
    input.dataset.layerName = field.layerName;
    input.placeholder = 'Leave blank to skip';
    const sel = document.createElement('select');
    sel.className = 'select-input font-select';
    sel.dataset.layerName = field.layerName;
    sel.title = 'Font for this text layer';
    sel.innerHTML = '<option value="">Template font</option>' +
      fontBank.map((f) => `<option value="${escapeHtml(f.psName)}">${escapeHtml(f.label)}</option>`).join('');
    sel.addEventListener('change', () => slotFonts.set(`${key}:${field.layerName}`, sel.value));
    row.appendChild(input);
    row.appendChild(sel);
    card.appendChild(row);
  } else {
    // text: or legacy headline — plain text input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = `text-input field-text-layer${field.legacy ? ' field-headline' : ''}`;
    input.dataset.layerName = field.layerName;
    input.placeholder = 'Leave blank to skip';
    card.appendChild(input);
  }
}

function buildImageField(card, key, artboardName, field) {
  // Each image slot gets its own crop key so multiple images per slide
  // (e.g. image:player a and image:player b) are tracked independently.
  const slotKey = field.legacy ? key : `${key}:${field.layerName}`;

  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = field.label;
  card.appendChild(label);

  // Attachment type (image / gif) — only for legacy single-image slots
  // For named slots we always use image (GIF support via existing insertFrames could be added later)
  if (field.legacy) {
    const typeLabel = document.createElement('label');
    typeLabel.className = 'field-label';
    typeLabel.textContent = 'Attachment type';
    card.appendChild(typeLabel);
    const typeSelect = document.createElement('select');
    typeSelect.className = 'select-input field-type';
    typeSelect.dataset.slotKey = slotKey;
    typeSelect.innerHTML = '<option value="image" selected>Image</option><option value="gif">GIF</option>';
    card.appendChild(typeSelect);
  }

  const fileRow = document.createElement('div');
  fileRow.className = 'file-row';
  fileRow.innerHTML = `
    <label class="file-input-label">
      Choose file
      <input type="file" class="field-file hidden" accept="image/*"
             data-slot-key="${escapeHtml(slotKey)}"
             data-slot-name="${escapeHtml(field.layerName)}"
             data-legacy="${field.legacy ? '1' : '0'}">
    </label>
    <span class="file-name"></span>
    <span class="crop-edit-link hidden">Edit crop</span>
  `;
  card.appendChild(fileRow);

  const fileInput   = fileRow.querySelector('.field-file');
  const fileNameSpan = fileRow.querySelector('.file-name');
  const cropEditLink = fileRow.querySelector('.crop-edit-link');
  const typeSelect  = card.querySelector(`.field-type[data-slot-key="${CSS.escape(slotKey)}"]`);

  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      fileInput.accept = typeSelect.value === 'gif' ? 'image/gif' : 'image/*';
      fileInput.value = '';
      fileNameSpan.textContent = '';
      cropEditLink.classList.add('hidden');
      cropRects.delete(slotKey);
    });
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) {
      fileNameSpan.textContent = '';
      cropRects.delete(slotKey);
      fitModes.delete(slotKey);
      cropEditLink.classList.add('hidden');
      return;
    }
    fileNameSpan.textContent = file.name;
    cropEditLink.classList.add('hidden');
    const aspectInfo = aspectInfoForSlot(artboardName, field.layerName, field.legacy);
    if (!aspectInfo) return;
    const attachmentType = typeSelect ? typeSelect.value : 'image';
    await promptCrop(slotKey, file, attachmentType, aspectInfo.aspect, cropEditLink, fileInput);
  });

  cropEditLink.addEventListener('click', async (e) => {
    e.preventDefault();
    const file = fileInput.files[0];
    if (!file) return;
    const aspectInfo = aspectInfoForSlot(artboardName, field.layerName, field.legacy);
    if (!aspectInfo) return;
    const attachmentType = typeSelect ? typeSelect.value : 'image';
    await promptCrop(slotKey, file, attachmentType, aspectInfo.aspect, cropEditLink, fileInput);
  });
}

// Returns aspect info for a specific image layer name within an artboard.
// For legacy "Image" slots: delegates to the existing aspectInfoFor().
// For named "image:*" slots: searches inside the named group.
function aspectInfoForSlot(artboardName, layerName, isLegacy) {
  if (isLegacy) return aspectInfoFor(artboardName);
  const ab = (currentTemplate.metadata?.artboards || []).find(
    (a) => a.name.toLowerCase() === artboardName.toLowerCase()
  );
  if (!ab) return null;
  const layers = ab.childLayerNames || [];
  // Find layers that are children of the named slot group
  // childLayerNames is flat so we find Image Placeholder/Image scoped by slot
  // For now, use the same logic but scoped to slot group children
  const placeholder = layers.find((c) => c.name === 'Image Placeholder' && c.bounds);
  if (placeholder) return toAspect(placeholder.bounds);
  const img = layers.find((c) => c.name === 'Image' && c.bounds);
  if (img) return toAspect(img.bounds);
  return null;
}

// ---------- Carousel navigation ----------
function setupCarouselNav() {
  const track = $('formPagesTrack');
  const pages = Array.from(track.children);
  const dotsEl = $('carouselDots');
  dotsEl.innerHTML = '';
  pages.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.className = 'carousel-dot';
    dot.addEventListener('click', () => goToPage(i));
    dotsEl.appendChild(dot);
  });
  const showNav = pages.length > 1;
  $('carouselPrevBtn').classList.toggle('hidden', !showNav);
  $('carouselNextBtn').classList.toggle('hidden', !showNav);
  dotsEl.classList.toggle('hidden', !showNav);
  goToPage(Math.min(currentPageIndex, Math.max(0, pages.length - 1)));
}

function goToPage(index) {
  const pages = Array.from($('formPagesTrack').children);
  if (!pages.length) return;
  currentPageIndex = Math.max(0, Math.min(index, pages.length - 1));
  pages.forEach((p, i) => p.classList.toggle('active', i === currentPageIndex));
  Array.from($('carouselDots').children).forEach((d, i) => d.classList.toggle('active', i === currentPageIndex));
  $('carouselPrevBtn').disabled = currentPageIndex === 0;
  $('carouselNextBtn').disabled = currentPageIndex === pages.length - 1;
}

$('carouselPrevBtn').addEventListener('click', () => goToPage(currentPageIndex - 1));
$('carouselNextBtn').addEventListener('click', () => goToPage(currentPageIndex + 1));

// Swipe gesture, scoped specifically to the preview-image area (not the
// whole page) so dragging a finger across a text field or select while
// typing/scrolling never gets mistaken for a swipe.
(() => {
  let touchStartX = null;
  const track = $('formPagesTrack');
  track.addEventListener('touchstart', (e) => {
    if (!e.target.closest('.form-page-preview')) { touchStartX = null; return; }
    touchStartX = e.touches[0].clientX;
  }, { passive: true });
  track.addEventListener('touchend', (e) => {
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) goToPage(currentPageIndex + (dx < 0 ? 1 : -1));
    touchStartX = null;
  });
})();

$('middleCountInput').addEventListener('change', () => {
  let n = parseInt($('middleCountInput').value, 10);
  if (!n || n < 1) n = 1;
  if (n > 20) n = 20;
  $('middleCountInput').value = n;
  updateMiddleCount(n);
});

// Targeted add/remove at the tail of the repeatable block, instead of
// rebuilding every middle page from scratch - so increasing or decreasing
// the count never wipes out text/photos already entered on slides that
// still exist after the change.
function updateMiddleCount(newCount) {
  const track = $('formPagesTrack');
  const repeatable = currentTemplate.repeatable;
  const repeatableArtboardName = currentTemplate.artboards.find((a) => a.toLowerCase() === repeatable.toLowerCase());
  const existingMiddlePages = Array.from(track.querySelectorAll('.form-page')).filter((p) => p.dataset.key.startsWith('middle-'));
  const oldCount = existingMiddlePages.length;

  if (newCount > oldCount) {
    const insertBeforeNode = oldCount ? existingMiddlePages[oldCount - 1].nextSibling : null;
    for (let i = oldCount; i < newCount; i++) {
      const page = buildFormPage(repeatableArtboardName, `middle-${i}`, `${repeatableArtboardName} #${i + 1}`);
      if (insertBeforeNode) track.insertBefore(page, insertBeforeNode);
      else track.appendChild(page);
    }
  } else if (newCount < oldCount) {
    for (let i = oldCount - 1; i >= newCount; i--) {
      cropRects.delete(existingMiddlePages[i].dataset.key);
      fitModes.delete(existingMiddlePages[i].dataset.key);
      existingMiddlePages[i].remove();
    }
  }
  middleCount = newCount;
  setupCarouselNav();
}

async function promptCrop(key, file, attachmentType, aspect, cropEditLink, fileInput = null) {
  let previewSrc;
  try {
    if (attachmentType === 'gif') {
      const frames = await extractFrames(file, 'gif', { maxFrames: 1 });
      previewSrc = frames[0]?.dataUrl;
    } else {
      previewSrc = await fileToDataUrl(file);
    }
  } catch (e) {
    console.error('Could not generate a crop preview:', e);
    return;
  }
  if (!previewSrc) return;

  const result = await openCropModal(previewSrc, aspect, () => {
    // "Change" button in modal: trigger file picker (sync, inside user gesture)
    if (fileInput) fileInput.click();
  });

  if (result === 'change') {
    // User tapped Change — file picker opened, new selection will trigger modal again
    return;
  } else if (result === 'fit') {
    fitModes.set(key, 'fit');
    cropRects.delete(key);
    cropEditLink.classList.remove('hidden');
  } else if (result) {
    fitModes.set(key, 'cover');
    cropRects.set(key, result);
    cropEditLink.classList.remove('hidden');
  }
  // null = closed via X without saving; preserve previous state, keep Edit crop visible
}

// ---------- Crop / Fit modal ----------
const cropModalOverlay = $('cropModalOverlay');
const cropCanvas       = $('cropCanvas');
const cropZoomSlider   = $('cropZoomSlider');
const cropZoomRow      = $('cropZoomRow');
const cropZoomMinus    = $('cropZoomMinus');
const cropZoomPlus     = $('cropZoomPlus');
const cropCloseBtn     = $('cropCloseBtn');
const cropFitBtn       = $('cropFitBtn');
const cropChangeBtn    = $('cropChangeBtn');
const cropSaveBtn      = $('cropSaveBtn');
const cropHint         = $('cropHint');

function openCropModal(imageSrc, targetAspect, onChangePhoto) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Canvas size: generous on the new full-height modal
      const availW = Math.min(440, window.innerWidth - 40);
      const availH = Math.min(440, window.innerHeight * 0.9 - 280);
      let canvasW, canvasH;
      if (targetAspect >= 1) {
        canvasW = availW;
        canvasH = Math.round(canvasW / targetAspect);
        if (canvasH > availH) { canvasH = Math.round(availH); canvasW = Math.round(canvasH * targetAspect); }
      } else {
        canvasH = availH;
        canvasW = Math.round(canvasH * targetAspect);
        if (canvasW > availW) { canvasW = Math.round(availW); canvasH = Math.round(canvasW / targetAspect); }
      }
      cropCanvas.width  = canvasW;
      cropCanvas.height = canvasH;
      const ctx = cropCanvas.getContext('2d');

      // ── Crop mode state ──
      const minScale = Math.max(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
      const maxScale = minScale * 4;
      let scale = minScale;
      let offsetX = (canvasW - img.naturalWidth  * scale) / 2;
      let offsetY = (canvasH - img.naturalHeight * scale) / 2;

      function clampOffsets() {
        offsetX = Math.min(0, Math.max(canvasW - img.naturalWidth  * scale, offsetX));
        offsetY = Math.min(0, Math.max(canvasH - img.naturalHeight * scale, offsetY));
      }
      function renderCrop() {
        ctx.clearRect(0, 0, canvasW, canvasH);
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
      }

      // ── Fit-to-frame preview ──
      // Shows the full image contained within the canvas with a checkerboard
      // letterbox so the user can clearly see no part of the image is lost.
      function renderFitPreview() {
        ctx.clearRect(0, 0, canvasW, canvasH);
        const tile = 10;
        for (let ty = 0; ty < canvasH; ty += tile) {
          for (let tx = 0; tx < canvasW; tx += tile) {
            ctx.fillStyle = ((tx / tile + ty / tile) % 2 === 0) ? '#e8e8e8' : '#d4d4d4';
            ctx.fillRect(tx, ty, tile, tile);
          }
        }
        const fs = Math.min(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
        const dw = img.naturalWidth * fs, dh = img.naturalHeight * fs;
        const dx = (canvasW - dw) / 2, dy = (canvasH - dh) / 2;
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, dw, dh);
        ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 1;
        ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
      }

      // ── Modal mode toggle ──
      let modalMode = 'crop';

      function showCropMode() {
        modalMode = 'crop';
        cropZoomRow.style.display = '';
        cropHint.textContent = 'Drag to reposition · use slider to zoom';
        cropFitBtn.classList.remove('active');
        renderCrop();
      }
      function showFitMode() {
        modalMode = 'fit';
        cropZoomRow.style.display = 'none';
        cropHint.textContent = 'Full image will be fitted inside the frame — no cropping';
        cropFitBtn.classList.add('active');
        renderFitPreview();
      }

      // Initial state
      cropZoomSlider.value = 0;
      clampOffsets();
      showCropMode();

      // ── Zoom ──
      cropZoomSlider.oninput = () => {
        if (modalMode !== 'crop') return;
        const t = cropZoomSlider.value / 100;
        const newScale = minScale + t * (maxScale - minScale);
        const cx = (canvasW / 2 - offsetX) / scale;
        const cy = (canvasH / 2 - offsetY) / scale;
        scale = newScale;
        offsetX = canvasW / 2 - cx * scale;
        offsetY = canvasH / 2 - cy * scale;
        clampOffsets();
        renderCrop();
      };
      cropZoomMinus.onclick = () => {
        cropZoomSlider.value = Math.max(0, parseInt(cropZoomSlider.value) - 10);
        cropZoomSlider.dispatchEvent(new Event('input'));
      };
      cropZoomPlus.onclick = () => {
        cropZoomSlider.value = Math.min(100, parseInt(cropZoomSlider.value) + 10);
        cropZoomSlider.dispatchEvent(new Event('input'));
      };

      // ── Drag to pan ──
      let dragging = false, dragX = 0, dragY = 0, startOX = 0, startOY = 0;
      function pDown(x, y) { if (modalMode !== 'crop') return; dragging = true; dragX = x; dragY = y; startOX = offsetX; startOY = offsetY; }
      function pMove(x, y) { if (!dragging || modalMode !== 'crop') return; offsetX = startOX + (x - dragX); offsetY = startOY + (y - dragY); clampOffsets(); renderCrop(); }
      function pUp() { dragging = false; }

      const mmh = (e) => pMove(e.clientX, e.clientY);
      cropCanvas.onmousedown  = (e) => pDown(e.clientX, e.clientY);
      window.addEventListener('mousemove', mmh);
      window.addEventListener('mouseup', pUp);
      cropCanvas.ontouchstart = (e) => { const t = e.touches[0]; pDown(t.clientX, t.clientY); };
      cropCanvas.ontouchmove  = (e) => { const t = e.touches[0]; pMove(t.clientX, t.clientY); e.preventDefault(); };
      cropCanvas.ontouchend   = pUp;

      function cleanup() {
        window.removeEventListener('mousemove', mmh);
        window.removeEventListener('mouseup', pUp);
        showCropMode(); // reset for next open
        cropModalOverlay.classList.remove('open');
      }

      // ── Buttons ──
      cropCloseBtn.onclick = () => { cleanup(); resolve(null); };

      cropFitBtn.onclick = () => {
        if (modalMode === 'crop') showFitMode();
        else showCropMode();
      };

      cropChangeBtn.onclick = () => {
        // Call onChangePhoto SYNCHRONOUSLY here (still in user gesture) before async cleanup
        if (onChangePhoto) onChangePhoto();
        cleanup();
        resolve('change');
      };

      cropSaveBtn.onclick = () => {
        if (modalMode === 'fit') {
          cleanup();
          resolve('fit');
        } else {
          const rect = { x: -offsetX / scale, y: -offsetY / scale, width: canvasW / scale, height: canvasH / scale };
          cleanup();
          resolve(rect);
        }
      };

      cropModalOverlay.classList.add('open');
    };
    img.onerror = () => resolve(null);
    img.src = imageSrc;
  });
}


// ---------- Minimal ZIP writer (STORE mode - uncompressed but valid,
// no external library needed) so "Download all" produces one real .zip
// instead of triggering several separate browser downloads at once. ----------
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function dosDateTime() {
  // Arbitrary but valid fixed timestamp - the exact date/time doesn't
  // matter for files that only exist to be immediately downloaded.
  return { time: 0, date: 0x21 };
}
async function buildZip(files) {
  // files: [{ name: string, blob: Blob }]
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, date } = dosDateTime();

  for (const { name, blob } of files) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0, true);
    localHeader.setUint16(8, 0, true);
    localHeader.setUint16(10, time, true);
    localHeader.setUint16(12, date, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, data.length, true);
    localHeader.setUint32(22, data.length, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);

    localParts.push(new Uint8Array(localHeader.buffer), nameBytes, data);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint16(8, 0, true);
    centralHeader.setUint16(10, 0, true);
    centralHeader.setUint16(12, time, true);
    centralHeader.setUint16(14, date, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, data.length, true);
    centralHeader.setUint32(24, data.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true);
    centralHeader.setUint16(32, 0, true);
    centralHeader.setUint16(34, 0, true);
    centralHeader.setUint16(36, 0, true);
    centralHeader.setUint32(38, 0, true);
    centralHeader.setUint32(42, offset, true);

    centralParts.push(new Uint8Array(centralHeader.buffer), nameBytes);
    offset += localHeader.buffer.byteLength + nameBytes.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const part of centralParts) centralSize += part.length;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)], { type: 'application/zip' });
}


$('generateBtn').addEventListener('click', runGeneration);
$('backToDashboard').addEventListener('click', (e) => { e.preventDefault(); showScreen('dashboard'); });
$('backToFormFromResults').addEventListener('click', (e) => {
  e.preventDefault();
  if (currentTemplate) openTemplate(currentTemplate); // isSameTemplate check inside means this won't rebuild/wipe anything
});
$('startOverBtn').addEventListener('click', () => {
  currentTemplate = null; // a genuinely fresh start - picking any template (even the same one) next rebuilds from scratch
  showScreen('dashboard');
});

function logStatus(message, level = 'info') {
  const log = $('statusLog');
  const line = document.createElement('div');
  line.className = `status-line ${level}`;
  line.textContent = message;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function setProgress(pct) {
  $('progressFill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

async function cropDataUrlIfNeeded(key, dataUrl, attachmentType) {
  if (attachmentType !== 'image' || !dataUrl) return dataUrl;
  const rect = cropRects.get(key);
  if (!rect) return dataUrl;
  try {
    return await applyCropToImage(dataUrl, rect);
  } catch (e) {
    console.error('Crop failed, using uncropped image:', e);
    return dataUrl;
  }
}

async function collectJobs() {
  const cards = Array.from($('formPagesTrack').querySelectorAll('.slide-card'));
  const jobs = [];
  for (const card of cards) {
    const key      = card.dataset.key;
    const artboard = card.dataset.artboard;
    const label    = key.startsWith('middle')
      ? `${artboard}_${parseInt(key.split('-')[1], 10) + 1}`
      : artboard;

    // Collect all text fields (both new-convention and legacy)
    const textFields = [];
    card.querySelectorAll('.field-text-layer').forEach((input) => {
      const layerName = input.dataset.layerName;
      const value     = input.value.trim();
      const fontKey   = `${key}:${layerName}`;
      textFields.push({ layerName, value, fontPsName: slotFonts.get(fontKey) || null });
    });

    // Collect all image fields (may be multiple per card)
    const imageFields = [];
    for (const fileInput of card.querySelectorAll('.field-file')) {
      const slotKey    = fileInput.dataset.slotKey;
      const slotName   = fileInput.dataset.slotName;   // e.g. "image:player a" or "Image"
      const isLegacy   = fileInput.dataset.legacy === '1';
      const file       = fileInput.files[0] || null;
      const typeEl     = card.querySelector(`.field-type[data-slot-key="${CSS.escape(slotKey)}"]`);
      const attachType = typeEl ? typeEl.value : 'image';
      let dataUrl = await fileToDataUrl(file);
      if (attachType !== 'gif' && dataUrl) {
        const rect = cropRects.get(slotKey);
        if (rect) dataUrl = await applyCropToImage(dataUrl, rect).catch(() => dataUrl);
      }
      imageFields.push({
        slotKey, slotName, isLegacy,
        attachmentType: attachType,
        file, dataUrl,
        cropRect: cropRects.get(slotKey) || null,
        fitMode:  fitModes.get(slotKey)  || 'cover',
      });
    }

    jobs.push({ artboard, label, textFields, imageFields });
  }
  return jobs;
}

async function runGeneration() {
  showScreen('generating');
  $('statusLog').innerHTML = '';
  setProgress(2);

  const jobs = await collectJobs();

  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  // Pre-load all font bank fonts into Photopea so they're available
  // before any PSD is loaded. Fonts outside the bank cannot be applied.
  PostManRenderEngine.configureFontedIframeSrc(iframe, fontBank);
  document.body.appendChild(iframe);

  const engine = new PostManRenderEngine(iframe, {
    onProgress: (message, level) => logStatus(message, level),
  });

  const results = [];
  try {
    await engine.boot();
    setProgress(8);
    const psdRes = await fetch(currentTemplate.file);
    if (!psdRes.ok) throw new Error(`Could not fetch ${currentTemplate.file} (${psdRes.status})`);
    const buffer = await psdRes.arrayBuffer();
    await engine.loadPSD(buffer);
    setProgress(15);

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const result = await runOneJob(engine, job);
      if (result) results.push(result);
      setProgress(15 + ((i + 1) / jobs.length) * 80);
    }
  } catch (e) {
    logStatus(`Generation failed: ${e.message || e}`, 'err');
  } finally {
    iframe.remove();
  }

  setProgress(100);
  renderResults(results);
  showScreen('results');
}

async function runOneJob(engine, job) {
  logStatus(`--- ${job.label} ---`, 'info');
  let hasAnimated = false;

  // ── Text fields (both legacy and new-convention) ──────────────────────
  for (const tf of (job.textFields || [])) {
    if (!tf.value) continue;
    await engine.editTextLayer(job.artboard, tf.layerName, tf.value);
    if (tf.fontPsName) {
      await engine.setTextFont(job.artboard, tf.layerName, tf.fontPsName);
    }
  }

  // ── Image / GIF fields ────────────────────────────────────────────────
  for (const img of (job.imageFields || [])) {
    if (!img.dataUrl && !img.file) continue;
    if (img.attachmentType === 'gif' && img.file) {
      hasAnimated = true;
      let frames = null;
      try {
        frames = await extractFrames(img.file, 'gif', { maxFrames: 8 });
        if (img.cropRect) {
          frames = await Promise.all(frames.map(async (f) => ({
            ...f, dataUrl: await applyCropToImage(f.dataUrl, img.cropRect).catch(() => f.dataUrl)
          })));
        }
      } catch (e) {
        logStatus(`${job.label}: frame extraction failed - ${e.message}`, 'err');
      }
      if (frames?.length) {
        if (img.isLegacy) {
          await engine.insertFrames(job.artboard, frames, img.fitMode);
        } else {
          // Named slot GIF: insert frames into slot (first frame only for now, full GIF support TBD)
          if (img.dataUrl) await engine.insertImageToSlot(job.artboard, img.slotName, img.dataUrl, img.fitMode);
        }
      }
    } else if (img.dataUrl) {
      if (img.isLegacy) {
        await engine.insertStaticImage(job.artboard, img.dataUrl, img.fitMode);
      } else {
        await engine.insertImageToSlot(job.artboard, img.slotName, img.dataUrl, img.fitMode);
      }
    }
  }

  try {
    if (hasAnimated) {
      const { blob } = await engine.exportArtboardAnimated(job.artboard, 'gif');
      return { label: job.label, blob, ext: 'gif', croppedToArtboard: false };
    } else {
      const { blob } = await engine.exportArtboardPNG(job.artboard);
      return { label: job.label, blob, ext: 'png', croppedToArtboard: true };
    }
  } catch (e) {
    logStatus(`${job.label}: export failed - ${e.message}`, 'err');
    return null;
  }
}

// ---------- Drive export ----------

// Paste your Apps Script /exec URL here after deploying drive-exporter.gs.
// Leave as null to hide the "Export to Drive" button entirely until
// the script is set up.
const DRIVE_EXPORT_URL = 'https://script.google.com/macros/s/AKfycbxqTm35dUNSPxfAosKy9wdECMKoFZFSwjoV7F5ARiOCKOyPBSLXA5hapvWsavXrT6-c/exec'; // e.g. 'https://script.google.com/macros/s/AKfy.../exec'

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('FileReader failed while encoding file for Drive upload'));
    reader.readAsDataURL(blob);
  });
}

async function runDriveExport(results, folderName) {
  const confirmBtn = $('driveConfirmBtn');
  const nameInput = $('driveFolderNameInput');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Uploading...';
  nameInput.disabled = true;

  try {
    const files = await Promise.all(results.map(async (r) => ({
      name: `${r.label}.${r.ext}`,
      base64: await blobToBase64(r.blob),
      mimeType: r.ext === 'gif' ? 'image/gif' : 'image/png',
    })));

    // text/plain;charset=utf-8 is a "simple request" that never
    // triggers a CORS preflight, which Apps Script can't respond to.
    const response = await fetch(DRIVE_EXPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ folderName, files }),
    });

    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Unknown error from the Apps Script endpoint');

    // Hide the name panel, show the sharing-link result card
    $('driveNamePanel').classList.add('hidden');
    $('driveResultFolderName').textContent = `PostMann Exports / ${data.folderName}`;

    const copyBtn = $('copyDriveLinkBtn');
    copyBtn.textContent = 'Copy link';
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(data.folderUrl);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1800);
      } catch (e) {
        // Clipboard API blocked on some Android browsers - fall back
        // to a native prompt so they can long-press and copy manually.
        prompt('Copy this link:', data.folderUrl);
      }
    };
    $('driveResultCard').classList.remove('hidden');
  } catch (e) {
    alert(`Drive export failed: ${e.message}`);
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Export';
    nameInput.disabled = false;
  }
}

function renderResults(results) {
  const grid = $('resultsGrid');
  grid.innerHTML = '';
  $('driveResultCard').classList.add('hidden');
  $('driveNamePanel').classList.add('hidden');
  results.forEach((r) => {
    const url = URL.createObjectURL(r.blob);
    const card = document.createElement('div');
    card.className = 'result-card';
    const preview = `<img src="${url}" alt="">`;
    card.innerHTML = `
      <div class="label">${escapeHtml(r.label)}</div>
      ${preview}
      <a class="download-btn" href="${url}" download="${escapeHtml(r.label)}.${r.ext}">Download .${r.ext}</a>
      ${!r.croppedToArtboard ? '<div class="caveat">Full canvas size - not yet cropped to this slide</div>' : ''}
    `;
    grid.appendChild(card);
  });

  const downloadAllBtn = $('downloadAllBtn');
  const driveBtn = $('exportToDriveBtn');

  // Always show Download all - useful even for a single file, and
  // hiding it for single results was confusing (users couldn't find it).
  downloadAllBtn.classList.remove('hidden');
  downloadAllBtn.onclick = async () => {
    downloadAllBtn.disabled = true;
    downloadAllBtn.textContent = 'Preparing zip...';
    try {
      const zipBlob = await buildZip(results.map((r) => ({ name: `${r.label}.${r.ext}`, blob: r.blob })));
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentTemplate?.name || 'postmann-designs'}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      alert(`Could not build the zip: ${e.message}`);
    } finally {
      downloadAllBtn.disabled = false;
      downloadAllBtn.textContent = 'Download all (.zip)';
    }
  };

  // Always show Export to Drive so it's visible. If the Apps Script URL
  // hasn't been configured yet, tapping it explains what to do rather
  // than hiding the button entirely and leaving the user wondering.
  driveBtn.classList.remove('hidden');
  driveBtn.onclick = () => {
    if (!DRIVE_EXPORT_URL) {
      alert('Export to Drive isn\'t connected yet.\n\nTo set it up:\n1. Deploy drive-exporter.gs as a Google Apps Script Web App\n2. Paste the /exec URL into DRIVE_EXPORT_URL in app.js');
      return;
    }
    const panel = $('driveNamePanel');
    const input = $('driveFolderNameInput');
    const confirmBtn = $('driveConfirmBtn');
    // Always reset state when revealing - a previous export's
    // "Uploading..." disabled state would otherwise carry over.
    input.value = currentTemplate?.name || '';
    input.disabled = false;
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Export';
    $('driveResultCard').classList.add('hidden');
    panel.classList.remove('hidden');
    if (window.matchMedia('(min-width: 640px)').matches) input.focus();
  };

  $('driveConfirmBtn').onclick = () => {
    const folderName = $('driveFolderNameInput').value.trim();
    if (!folderName) { $('driveFolderNameInput').focus(); return; }
    runDriveExport(results, folderName);
  };
  $('driveFolderNameInput').onkeydown = (e) => {
    if (e.key === 'Enter') $('driveConfirmBtn').click();
  };
}

// ---------- Boot ----------
loadManifest();