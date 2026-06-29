import { PostManRenderEngine, applyCropToImage, extractFrames, fileToDataUrl } from './render-engine.js';

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

// ---------- Load manifest, render dashboard ----------
async function loadManifest() {
  const res = await fetch('templates/manifest.json');
  manifest = await res.json();
  renderDashboard();
}

function renderDashboard() {
  const grid = $('templateGrid');
  grid.innerHTML = '';
  manifest.templates.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'template-card';
    const coverStyle = t.thumbnail ? `background-image:url('${t.thumbnail}')` : 'background-image:var(--brand-gradient,linear-gradient(135deg,#ff684d,#fb3662,#9d356c))';
    card.innerHTML = `
      <div class="cover brand-gradient" style="${t.thumbnail ? coverStyle : ''}"><span>${escapeHtml(t.name)}</span></div>
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
function openTemplate(template) {
  if (!template.metadata) {
    alert(`"${template.name}" hasn't been vetted yet - its metadata is missing from the manifest. Run the template tool first (see vet.html), then add the result here before this template can be used.`);
    return;
  }
  currentTemplate = template;
  cropRects.clear();
  middleCount = 1;
  $('formTemplateName').textContent = template.name;
  renderForm();
  showScreen('form');
}

function aspectInfoFor(artboardName) {
  const ab = (currentTemplate.metadata.artboards || []).find(
    (a) => a.name.toLowerCase() === artboardName.toLowerCase()
  );
  const imgEntry = ab && (ab.childLayerNames || []).find((c) => c.name === 'Image' && c.bounds);
  if (!imgEntry) return null;
  return { width: imgEntry.bounds.width, height: imgEntry.bounds.height, aspect: imgEntry.bounds.width / imgEntry.bounds.height };
}

function renderForm() {
  const container = $('formSlides');
  container.innerHTML = '';
  const repeatable = currentTemplate.repeatable;

  currentTemplate.artboards.forEach((artboardName) => {
    if (repeatable && artboardName.toLowerCase() === repeatable.toLowerCase()) {
      container.appendChild(buildRepeatableSection(artboardName));
    } else {
      container.appendChild(buildSlideCard(artboardName, artboardName.toLowerCase(), 1));
    }
  });
}

function buildRepeatableSection(artboardName) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="middle-count-row">
      <label class="field-label" style="margin:0;">How many ${escapeHtml(artboardName)} slides?</label>
      <input type="number" id="middleCountInput" class="text-input" min="1" max="20" value="${middleCount}">
    </div>
    <div id="middleSlidesContainer"></div>
  `;
  const countInput = wrap.querySelector('#middleCountInput');
  const slidesContainer = wrap.querySelector('#middleSlidesContainer');

  function renderSlides() {
    slidesContainer.innerHTML = '';
    for (let i = 0; i < middleCount; i++) {
      slidesContainer.appendChild(buildSlideCard(artboardName, `middle-${i}`, i + 1));
    }
  }
  countInput.addEventListener('change', () => {
    let n = parseInt(countInput.value, 10);
    if (!n || n < 1) n = 1;
    if (n > 20) n = 20;
    countInput.value = n;
    middleCount = n;
    renderSlides();
  });
  renderSlides();
  return wrap;
}

function buildSlideCard(artboardName, key, displayIndex) {
  const card = document.createElement('div');
  card.className = 'slide-card';
  card.dataset.key = key;
  card.dataset.artboard = artboardName;
  const label = key.startsWith('middle') ? `${artboardName} #${displayIndex}` : artboardName;
  card.innerHTML = `
    <div class="slide-card-title">${escapeHtml(label)}</div>
    <label class="field-label">Headline text</label>
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

// ---------- Generation ----------
$('generateBtn').addEventListener('click', runGeneration);
$('backToDashboard').addEventListener('click', (e) => { e.preventDefault(); showScreen('dashboard'); });
$('startOverBtn').addEventListener('click', () => showScreen('dashboard'));

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
  const cards = Array.from($('formSlides').querySelectorAll('.slide-card'));
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
}

// ---------- Boot ----------
loadManifest();
