import { PostManRenderEngine, applyCropToImage, extractFrames, fileToDataUrl } from './render-engine.js?v=2';

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const screens = {
  dashboard: $('screen-dashboard'),
  form: $('screen-form'),
  generating: $('screen-generating'),
  results: $('screen-results'),
};
function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}

// ---------- State ----------
let manifest = null;
let currentTemplate = null;
const cropRects = new Map(); // keyed by slide key ('cover', 'middle-0', ...)
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
  // no-store + a timestamp query param: belt-and-suspenders against both
  // the browser's own cache and any CDN/proxy in front of GitHub Pages
  // serving a stale copy. manifest.json changes every time a template is
  // added, so staleness here directly causes "I pushed but don't see it."
  const res = await fetch(`templates/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
  manifest = await res.json();
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
  middleCount = 1;
  renderForm();
}

function aspectInfoFor(artboardName) {
  const ab = (currentTemplate.metadata.artboards || []).find(
    (a) => a.name.toLowerCase() === artboardName.toLowerCase()
  );
  if (!ab) return null;
  // "Image Placeholder" is the actual visible crop frame the template
  // author drew for this slide - can be a different size/shape per slide
  // (e.g. a smaller, near-square frame on a Middle slide vs. a full-bleed
  // portrait frame on Cover). "Image" itself is just whatever bitmap gets
  // replaced/clipped, and isn't necessarily the same shape as the visible
  // window - using it for the crop aspect was the bug. Falls back to
  // "Image" for templates that don't define a separate placeholder layer.
  const placeholderEntry = (ab.childLayerNames || []).find((c) => c.name === 'Image Placeholder' && c.bounds);
  const entry = placeholderEntry || (ab.childLayerNames || []).find((c) => c.name === 'Image' && c.bounds);
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

function buildSlideFields(artboardName, key) {
  const card = document.createElement('div');
  card.className = 'slide-card';
  card.dataset.key = key;
  card.dataset.artboard = artboardName;
  card.innerHTML = `
    <label class="field-label" style="margin-top:0;">Headline text</label>
    <input type="text" class="text-input field-headline" placeholder="Leave blank to skip">
    <label class="field-label">Attachment type</label>
    <select class="select-input field-type">
      <option value="image" selected>Image</option>
      <option value="gif">GIF</option>
    </select>
    <label class="field-label">Photo / GIF</label>
    <div class="file-row">
      <label class="file-input-label">
        Choose file
        <input type="file" class="field-file hidden" accept="image/*">
      </label>
      <span class="file-name"></span>
      <span class="crop-edit-link hidden">Edit crop</span>
    </div>
  `;

  const fileInput = card.querySelector('.field-file');
  const typeSelect = card.querySelector('.field-type');
  const fileNameSpan = card.querySelector('.file-name');
  const cropEditLink = card.querySelector('.crop-edit-link');

  typeSelect.addEventListener('change', () => {
    fileInput.accept = typeSelect.value === 'gif' ? 'image/gif' : 'image/*';
    fileInput.value = '';
    fileNameSpan.textContent = '';
    cropEditLink.classList.add('hidden');
    cropRects.delete(key);
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) { fileNameSpan.textContent = ''; cropRects.delete(key); return; }
    fileNameSpan.textContent = file.name;

    const aspectInfo = aspectInfoFor(artboardName);
    if (!aspectInfo) {
      cropEditLink.classList.add('hidden');
      return; // no Image placeholder on this artboard - nothing to crop against
    }
    await promptCrop(key, file, typeSelect.value, aspectInfo.aspect, cropEditLink);
  });

  cropEditLink.addEventListener('click', async (e) => {
    e.preventDefault();
    const file = fileInput.files[0];
    if (!file) return;
    const aspectInfo = aspectInfoFor(artboardName);
    if (!aspectInfo) return;
    await promptCrop(key, file, typeSelect.value, aspectInfo.aspect, cropEditLink);
  });

  return card;
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
      existingMiddlePages[i].remove();
    }
  }
  middleCount = newCount;
  setupCarouselNav();
}

async function promptCrop(key, file, attachmentType, aspect, cropEditLink) {
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
  const rect = await openCropModal(previewSrc, aspect);
  if (rect) {
    cropRects.set(key, rect);
    cropEditLink.classList.remove('hidden');
  } else {
    cropRects.delete(key);
    cropEditLink.classList.add('hidden');
  }
}

// ---------- Crop modal (pan to drag, slider to zoom) ----------
const cropModalOverlay = $('cropModalOverlay');
const cropCanvas = $('cropCanvas');
const cropZoomSlider = $('cropZoomSlider');
const cropCancelBtn = $('cropCancelBtn');
const cropConfirmBtn = $('cropConfirmBtn');

function openCropModal(imageSrc, targetAspect) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Budget for everything else in the modal (heading, zoom slider,
      // button row, padding) so the canvas itself never forces a height
      // that doesn't fit a short phone screen alongside that other chrome.
      const availW = Math.min(360, window.innerWidth - 80);
      const availH = Math.min(360, window.innerHeight * 0.88 - 220);
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
      cropCanvas.width = canvasW;
      cropCanvas.height = canvasH;
      const ctx = cropCanvas.getContext('2d');

      const minScale = Math.max(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
      const maxScale = minScale * 4;
      let scale = minScale;
      let offsetX = (canvasW - img.naturalWidth * scale) / 2;
      let offsetY = (canvasH - img.naturalHeight * scale) / 2;

      function clampOffsets() {
        const minOffsetX = canvasW - img.naturalWidth * scale;
        const minOffsetY = canvasH - img.naturalHeight * scale;
        offsetX = Math.min(0, Math.max(minOffsetX, offsetX));
        offsetY = Math.min(0, Math.max(minOffsetY, offsetY));
      }
      function render() {
        ctx.clearRect(0, 0, canvasW, canvasH);
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
      }

      cropZoomSlider.value = 0;
      clampOffsets();
      render();

      cropZoomSlider.oninput = () => {
        const t = cropZoomSlider.value / 100;
        const newScale = minScale + t * (maxScale - minScale);
        const centerImgX = (canvasW / 2 - offsetX) / scale;
        const centerImgY = (canvasH / 2 - offsetY) / scale;
        scale = newScale;
        offsetX = canvasW / 2 - centerImgX * scale;
        offsetY = canvasH / 2 - centerImgY * scale;
        clampOffsets();
        render();
      };

      let dragging = false, dragStartX = 0, dragStartY = 0, startOffsetX = 0, startOffsetY = 0;
      function pointerDown(x, y) { dragging = true; dragStartX = x; dragStartY = y; startOffsetX = offsetX; startOffsetY = offsetY; cropCanvas.style.cursor = 'grabbing'; }
      function pointerMove(x, y) {
        if (!dragging) return;
        offsetX = startOffsetX + (x - dragStartX);
        offsetY = startOffsetY + (y - dragStartY);
        clampOffsets();
        render();
      }
      function pointerUp() { dragging = false; cropCanvas.style.cursor = 'grab'; }

      const windowMouseMoveHandler = (e) => pointerMove(e.clientX, e.clientY);
      cropCanvas.onmousedown = (e) => pointerDown(e.clientX, e.clientY);
      window.addEventListener('mousemove', windowMouseMoveHandler);
      window.addEventListener('mouseup', pointerUp);
      cropCanvas.ontouchstart = (e) => { const t = e.touches[0]; pointerDown(t.clientX, t.clientY); };
      cropCanvas.ontouchmove = (e) => { const t = e.touches[0]; pointerMove(t.clientX, t.clientY); e.preventDefault(); };
      cropCanvas.ontouchend = pointerUp;

      function cleanup() {
        window.removeEventListener('mousemove', windowMouseMoveHandler);
        window.removeEventListener('mouseup', pointerUp);
        cropModalOverlay.classList.remove('open');
      }

      cropConfirmBtn.onclick = () => {
        const rect = { x: -offsetX / scale, y: -offsetY / scale, width: canvasW / scale, height: canvasH / scale };
        cleanup();
        resolve(rect);
      };
      cropCancelBtn.onclick = () => { cleanup(); resolve(null); };

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
    const key = card.dataset.key;
    const artboard = card.dataset.artboard;
    const label = key.startsWith('middle') ? `${artboard}_${key.split('-')[1] === '0' ? 1 : parseInt(key.split('-')[1], 10) + 1}` : artboard;
    const headline = card.querySelector('.field-headline').value;
    const attachmentType = card.querySelector('.field-type').value;
    const file = card.querySelector('.field-file').files[0] || null;
    let dataUrl = await fileToDataUrl(file);
    dataUrl = await cropDataUrlIfNeeded(key, dataUrl, attachmentType);
    jobs.push({ artboard, label, headline, attachmentType, file, dataUrl, cropRect: cropRects.get(key) || null });
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
  iframe.src = 'https://www.photopea.com/#';
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
  const isAnimated = job.attachmentType === 'gif';

  if (job.headline) await engine.editHeadline(job.artboard, job.headline);

  if (isAnimated && job.file) {
    let frames = null;
    try {
      frames = await extractFrames(job.file, 'gif', { maxFrames: 8 });
      if (job.cropRect) {
        frames = await Promise.all(frames.map(async (f) => ({ ...f, dataUrl: await applyCropToImage(f.dataUrl, job.cropRect) })));
      }
    } catch (e) {
      logStatus(`${job.label}: frame extraction failed - ${e.message}`, 'err');
    }
    if (frames && frames.length) await engine.insertFrames(job.artboard, frames);
  } else if (job.dataUrl) {
    await engine.insertStaticImage(job.artboard, job.dataUrl);
  }

  try {
    if (isAnimated) {
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

function renderResults(results) {
  const grid = $('resultsGrid');
  grid.innerHTML = '';
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
  if (results.length > 1) {
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
  } else {
    downloadAllBtn.classList.add('hidden');
  }
}

// ---------- Boot ----------
loadManifest();