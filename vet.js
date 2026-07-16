import { PostManRenderEngine } from './render-engine.js?v=7';

// Splits a manifest into a lightweight index (everything the dashboard
// needs to render cards - no metadata) plus one detail-file payload per
// template (the heavy layer-tree metadata, saved separately so the
// dashboard never has to download it just to show a card). Also migrates
// any OLD-FORMAT entries still carrying embedded metadata inline - so
// running this once against an existing manifest.json cleans up every
// template in it, not just the one being actively re-vetted.
function buildSplitManifest(currentManifestRaw, newEntryWithMetadata) {
  let manifest = { templates: [] };
  let parseError = null;
  if (currentManifestRaw) {
    try {
      manifest = JSON.parse(currentManifestRaw);
      if (!manifest.templates || !Array.isArray(manifest.templates)) {
        throw new Error('Valid JSON, but no "templates" array found at the top level - is this really your manifest.json?');
      }
    } catch (e) {
      parseError = e.message;
      manifest = { templates: [] };
    }
  }

  const detailFiles = [];
  manifest.templates = manifest.templates.map((t) => {
    if (t && t.metadata) {
      detailFiles.push({ id: t.id, metadata: t.metadata });
      const { metadata, ...rest } = t;
      return rest;
    }
    return t;
  });

  const { metadata, ...indexEntry } = newEntryWithMetadata;
  const existingIndex = manifest.templates.findIndex((t) => t.id === indexEntry.id);
  if (existingIndex >= 0) manifest.templates[existingIndex] = indexEntry;
  else manifest.templates.push(indexEntry);
  detailFiles.push({ id: indexEntry.id, metadata });

  // De-dupe by id, keeping the LAST occurrence - the freshly-vetted
  // result wins over a same-id entry pulled from migration.
  const seen = new Map();
  for (const d of detailFiles) seen.set(d.id, d);

  return { manifest, detailFiles: Array.from(seen.values()), parseError };
}

const $ = (id) => document.getElementById(id);
const psdFileInput = $('psdFile');
const runVetBtn = $('runVetBtn');
const statusLog = $('vetStatusLog');
const customThumbnailFile = $('customThumbnailFile');
const copyManifestBtn = $('copyManifestBtn');

copyManifestBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('manifestOutput').value);
    copyManifestBtn.textContent = 'Copied!';
    setTimeout(() => { copyManifestBtn.textContent = 'Copy to clipboard'; }, 1500);
  } catch (e) {
    logStatus(`Could not copy automatically - select the text manually instead. (${e.message})`, 'warn');
  }
});

let selectedFile = null;
let activeTemplateId = 'untitled-template';
let autoThumbnailUrl = null; // the auto-generated one, kept so we can fall back to it if a custom upload is cleared

psdFileInput.addEventListener('change', () => {
  selectedFile = psdFileInput.files[0] || null;
  $('psdFileName').textContent = selectedFile ? selectedFile.name : '';
  runVetBtn.disabled = !selectedFile;
});

function logStatus(message, level) {
  statusLog.classList.remove('hidden');
  const line = document.createElement('div');
  line.className = `status-line ${level}`;
  line.textContent = message;
  statusLog.appendChild(line);
  statusLog.scrollTop = statusLog.scrollHeight;
}

// Downscales an exported PNG blob to a small size for fast dashboard
// loading - the source export is at the artboard's native resolution
// (often 1000px+), far bigger than the ~170px-wide card it'll render in.
function downscaleToThumbnail(blob, maxDim = 480) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((thumbBlob) => (thumbBlob ? resolve(thumbBlob) : reject(new Error('toBlob returned null'))), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load exported PNG for downscaling')); };
    img.src = url;
  });
}

function setThumbnailPreview(blob) {
  const url = URL.createObjectURL(blob);
  $('thumbnailPreview').src = url;
  const link = $('thumbnailDownloadLink');
  link.href = url;
  link.download = `${activeTemplateId}.png`;
  $('thumbnailBox').classList.remove('hidden');
}

function renderPreviewGallery(previews) {
  // previews: [{ artboardName, blob }]
  const gallery = $('previewGallery');
  gallery.innerHTML = '';
  previews.forEach(({ artboardName, blob }) => {
    const url = URL.createObjectURL(blob);
    const item = document.createElement('div');
    item.style.textAlign = 'center';
    item.innerHTML = `
      <img src="${url}" alt="${escapeHtmlAttr(artboardName)}" style="max-width:140px; border:1px solid var(--border-default); border-radius:var(--radius-md); display:block; margin:0 auto 6px;">
      <div style="font-size:11px; font-weight:600; margin-bottom:4px;">${escapeHtmlAttr(artboardName)}</div>
      <a href="${url}" download="${activeTemplateId}-${artboardName.toLowerCase()}.png" style="font-size:11px; color:var(--brand-600); font-weight:600;">Download</a>
    `;
    gallery.appendChild(item);
  });
  $('previewGalleryBox').classList.remove('hidden');
}
function escapeHtmlAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

customThumbnailFile.addEventListener('change', () => {
  const file = customThumbnailFile.files[0];
  if (!file) {
    $('customThumbnailName').textContent = '';
    if (autoThumbnailUrl) setThumbnailPreview(autoThumbnailUrl); // fall back to the auto-generated one
    return;
  }
  $('customThumbnailName').textContent = file.name;
  setThumbnailPreview(file);
});

runVetBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  runVetBtn.disabled = true;
  statusLog.innerHTML = '';
  $('reportBox').classList.add('hidden');
  $('thumbnailBox').classList.add('hidden');
  $('manifestBox').classList.add('hidden');
  $('detailFilesBox').classList.add('hidden');
  customThumbnailFile.value = '';
  $('customThumbnailName').textContent = '';

  const expectedArtboards = $('artboardNames').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!expectedArtboards.length) {
    alert('Enter at least one expected artboard name before running vetting - without one, vetting would "pass" having checked nothing.');
    runVetBtn.disabled = false;
    return;
  }
  const repeatable = $('repeatableName').value.trim() || null;
  const templateId = $('templateId').value.trim() || 'untitled-template';
  const templateName = $('templateName').value.trim() || templateId;
  activeTemplateId = templateId;

  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = 'https://www.photopea.com/#';
  document.body.appendChild(iframe);

  const engine = new PostManRenderEngine(iframe, {
    onProgress: (message, level) => logStatus(message, level),
  });

  try {
    await engine.boot();
    const buffer = await selectedFile.arrayBuffer();
    await engine.loadPSD(buffer);
    const report = await engine.vetTemplate(expectedArtboards);

    showReport(report);

    let thumbnailGenerated = false;
    let artboardPreviews = {};
    if (report.passed && expectedArtboards.length) {
      const previewsForGallery = [];
      for (let i = 0; i < expectedArtboards.length; i++) {
        const artboardName = expectedArtboards[i];
        try {
          logStatus(`Generating a preview of "${artboardName}"...`, 'info');
          const { blob } = await engine.exportArtboardPNG(artboardName);
          const thumbBlob = await downscaleToThumbnail(blob);
          previewsForGallery.push({ artboardName, blob: thumbBlob });
          artboardPreviews[artboardName.toLowerCase()] = `templates/thumbnails/${templateId}-${artboardName.toLowerCase()}.png`;
          if (i === 0) {
            autoThumbnailUrl = thumbBlob;
            setThumbnailPreview(thumbBlob);
            thumbnailGenerated = true;
          }
        } catch (e) {
          logStatus(`Could not generate a preview for "${artboardName}" - ${e.message}.`, 'warn');
          if (i === 0) $('thumbnailBox').classList.remove('hidden'); // keep the manual-override option available even if auto-generation failed
        }
      }
      if (previewsForGallery.length) renderPreviewGallery(previewsForGallery);
    }

    if (report.passed) {
      const manifestEntry = {
        id: templateId,
        name: templateName,
        file: `templates/${templateId}.psd`,
        thumbnail: thumbnailGenerated ? `templates/thumbnails/${templateId}.png` : null,
        artboards: expectedArtboards,
        repeatable: repeatable,
        artboardPreviews: Object.keys(artboardPreviews).length ? artboardPreviews : null,
        vettedAt: new Date().toISOString(),
        metadata: { artboards: report.extraction.artboards },
      };

      const currentManifestRaw = $('currentManifestInput').value.trim();
      const { manifest, detailFiles, parseError } = buildSplitManifest(currentManifestRaw, manifestEntry);
      if (parseError) {
        logStatus(`Could not parse the manifest you pasted in - ${parseError}. Starting fresh with just this one template instead; you'll need to re-add any others by hand, or fix the pasted JSON and try again.`, 'err');
      }
      if (detailFiles.length > 1) {
        logStatus(`Also migrated ${detailFiles.length - 1} existing template(s) that still had their metadata embedded inline - each now gets its own detail file below, same as this one.`, 'info');
      }

      $('manifestOutput').value = JSON.stringify(manifest, null, 2);
      $('manifestBox').classList.remove('hidden');
      renderDetailFileLinks(detailFiles);
    }
  } catch (e) {
    logStatus(`Vetting failed unexpectedly: ${e.message || e}`, 'err');
  } finally {
    iframe.remove();
    runVetBtn.disabled = false;
  }
});

function renderDetailFileLinks(detailFiles) {
  const box = $('detailFilesBox');
  const list = $('detailFilesList');
  list.innerHTML = '';
  detailFiles.forEach(({ id, metadata }) => {
    const blob = new Blob([JSON.stringify({ metadata }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const row = document.createElement('div');
    row.className = 'file-row';
    row.style.marginBottom = '8px';
    row.innerHTML = `
      <a href="${url}" download="${id}.json" class="btn-secondary" style="font-size:12px; padding:7px 12px;">
        Download templates/details/${id}.json
      </a>
    `;
    list.appendChild(row);
  });
  box.classList.remove('hidden');
}

function showReport(report) {
  const box = $('reportBox');
  box.classList.remove('hidden');
  const summary = $('reportSummary');
  summary.textContent = report.passed ? 'Vetting passed' : `Vetting found ${report.issues.length} issue(s)`;
  summary.style.color = report.passed ? 'var(--success-text)' : 'var(--danger-text)';

  const issuesEl = $('reportIssues');
  issuesEl.innerHTML = '';
  report.issues.forEach((issue) => {
    const li = document.createElement('li');
    li.textContent = issue;
    issuesEl.appendChild(li);
  });

  const notesEl = $('reportNotes');
  notesEl.innerHTML = '';
  report.notes.forEach((note) => {
    const li = document.createElement('li');
    li.textContent = note;
    notesEl.appendChild(li);
  });
}
// ═══════════════════════════════════════════════════════════════════════
// REMOVE A TEMPLATE
// ═══════════════════════════════════════════════════════════════════════

const loadTemplatesBtn      = $('loadTemplatesBtn');
const removePickerBox       = $('removePickerBox');
const removeTemplateList    = $('removeTemplateList');
const removeTemplateBtn     = $('removeTemplateBtn');
const removeOutputBox       = $('removeOutputBox');
const copyRemovedManifestBtn = $('copyRemovedManifestBtn');

let removeManifest   = null;  // the parsed manifest object
let selectedRemoveId = null;  // id of the template the user clicked

// ── Parse the pasted manifest and render the picker ──────────────────────
loadTemplatesBtn.addEventListener('click', () => {
  const raw = $('removeManifestInput').value.trim();
  if (!raw) { alert('Paste your manifest.json first.'); return; }

  try {
    removeManifest = JSON.parse(raw);
  } catch (e) {
    alert(`Could not parse the JSON: ${e.message}`);
    return;
  }

  const templates = removeManifest.templates;
  if (!Array.isArray(templates) || !templates.length) {
    alert('No templates found in that manifest.');
    return;
  }

  // Reset state
  selectedRemoveId = null;
  removeTemplateBtn.disabled = true;
  removeOutputBox.classList.add('hidden');

  // Render one card per template
  removeTemplateList.innerHTML = '';
  templates.forEach(t => {
    const card = document.createElement('button');
    card.type = 'button';
    card.dataset.id = t.id;
    card.style.cssText = `
      display:flex; align-items:center; justify-content:space-between;
      width:100%; text-align:left; padding:12px 14px;
      border:1.5px solid var(--border-default); border-radius:var(--radius-md);
      background:var(--surface); cursor:pointer; gap:12px;
    `;
    card.innerHTML = `
      <div>
        <div style="font-size:14px; font-weight:600; color:var(--text-primary);">${escapeHtmlAttr(t.name || t.id)}</div>
        <div style="font-size:11px; color:var(--text-tertiary); margin-top:2px;">
          ID: ${escapeHtmlAttr(t.id)} &nbsp;·&nbsp;
          ${(t.artboards || []).length} artboard(s)
          ${t.repeatable ? ` · repeatable: ${escapeHtmlAttr(t.repeatable)}` : ''}
        </div>
      </div>
      <div style="font-size:11px; color:var(--text-tertiary); white-space:nowrap;">Select →</div>
    `;
    card.addEventListener('click', () => {
      // Deselect all, select this one
      removeTemplateList.querySelectorAll('button').forEach(b => {
        b.style.borderColor = 'var(--border-default)';
        b.style.background  = 'var(--surface)';
        b.querySelector('div:last-child').textContent = 'Select →';
      });
      card.style.borderColor = 'var(--danger-text)';
      card.style.background  = 'var(--danger-bg)';
      card.querySelector('div:last-child').textContent = '✓ Selected';
      selectedRemoveId = t.id;
      removeTemplateBtn.disabled = false;
    });
    removeTemplateList.appendChild(card);
  });

  removePickerBox.classList.remove('hidden');
});

// ── Remove the selected template and generate outputs ─────────────────────
removeTemplateBtn.addEventListener('click', () => {
  if (!selectedRemoveId || !removeManifest) return;

  const entry = removeManifest.templates.find(t => t.id === selectedRemoveId);
  if (!entry) { alert('Could not find that template in the manifest.'); return; }

  // Build the updated manifest without this entry
  const updatedManifest = {
    ...removeManifest,
    templates: removeManifest.templates.filter(t => t.id !== selectedRemoveId),
  };

  // Build the list of files to delete
  const filesToDelete = [];

  // PSD file
  if (entry.file) filesToDelete.push(entry.file);

  // Main thumbnail
  if (entry.thumbnail) filesToDelete.push(entry.thumbnail);

  // Per-artboard preview thumbnails
  if (entry.artboardPreviews && typeof entry.artboardPreviews === 'object') {
    Object.values(entry.artboardPreviews).forEach(p => { if (p) filesToDelete.push(p); });
  }

  // Detail JSON file (always follows this convention)
  filesToDelete.push(`templates/details/${selectedRemoveId}.json`);

  // ── Render output ────────────────────────────────────────────────────
  $('removeManifestOutput').value = JSON.stringify(updatedManifest, null, 2);

  const listEl = $('filesToDeleteList');
  listEl.innerHTML = filesToDelete
    .map(f => `<div>🗑 ${escapeHtmlAttr(f)}</div>`)
    .join('');

  removeOutputBox.classList.remove('hidden');
  removeOutputBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ── Copy updated manifest ─────────────────────────────────────────────────
copyRemovedManifestBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('removeManifestOutput').value);
    copyRemovedManifestBtn.textContent = 'Copied!';
    setTimeout(() => { copyRemovedManifestBtn.textContent = 'Copy to clipboard'; }, 1500);
  } catch (e) {
    alert('Could not copy automatically — select the text manually.');
  }
});