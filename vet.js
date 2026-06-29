import { PostManRenderEngine } from './render-engine.js';

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
    if (report.passed && expectedArtboards.length) {
      try {
        logStatus(`Generating a dashboard preview from "${expectedArtboards[0]}"...`, 'info');
        const { blob } = await engine.exportArtboardPNG(expectedArtboards[0]);
        const thumbBlob = await downscaleToThumbnail(blob);
        autoThumbnailUrl = thumbBlob;
        setThumbnailPreview(thumbBlob);
        thumbnailGenerated = true;
      } catch (e) {
        logStatus(`Could not auto-generate a preview - ${e.message}. You can still upload your own below.`, 'warn');
        $('thumbnailBox').classList.remove('hidden');
      }
    }

    if (report.passed) {
      const manifestEntry = {
        id: templateId,
        name: templateName,
        file: `templates/${templateId}.psd`,
        thumbnail: thumbnailGenerated ? `templates/thumbnails/${templateId}.png` : null,
        artboards: expectedArtboards,
        repeatable: repeatable,
        vettedAt: new Date().toISOString(),
        metadata: { artboards: report.extraction.artboards },
      };

      const currentManifestRaw = $('currentManifestInput').value.trim();
      let manifest = { templates: [] };
      if (currentManifestRaw) {
        try {
          manifest = JSON.parse(currentManifestRaw);
          if (!manifest.templates || !Array.isArray(manifest.templates)) {
            throw new Error('Valid JSON, but no "templates" array found at the top level - is this really your manifest.json?');
          }
        } catch (e) {
          logStatus(`Could not parse the manifest you pasted in - ${e.message}. Starting fresh with just this one template instead; you'll need to re-add any others by hand, or fix the pasted JSON and try again.`, 'err');
          manifest = { templates: [] };
        }
      }

      const existingIndex = manifest.templates.findIndex((t) => t.id === templateId);
      if (existingIndex >= 0) {
        manifest.templates[existingIndex] = manifestEntry;
        logStatus(`Updated the existing "${templateId}" entry in place.`, 'info');
      } else {
        manifest.templates.push(manifestEntry);
      }

      $('manifestOutput').value = JSON.stringify(manifest, null, 2);
      $('manifestBox').classList.remove('hidden');
    }
  } catch (e) {
    logStatus(`Vetting failed unexpectedly: ${e.message || e}`, 'err');
  } finally {
    iframe.remove();
    runVetBtn.disabled = false;
  }
});

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
