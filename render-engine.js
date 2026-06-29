/**
 * PostMan Render Engine
 * ======================
 * Drives a hidden Photopea iframe to load PSD templates, edit them per a
 * simple artboard convention, and export the results - with zero UI
 * coupling. This is the same logic proven across many rounds of real
 * testing in the original POC, restructured into a reusable module so it
 * can serve TWO separate call sites in the real product:
 *
 *   1. Template vetting/ingestion - run once, when a new .psd lands in
 *      Drive. Loads it, extracts its structure, checks it against the
 *      template spec, and returns a report (and the metadata that should
 *      get cached so generation never has to re-run extraction live).
 *
 *   2. Generation - run every time an end user submits the dynamic form.
 *      Loads the same template, applies their specific text/images, and
 *      exports the results.
 *
 * Every quirk this file works around was found empirically, not assumed -
 * see the inline comments at each one. Nothing here is theoretical.
 *
 * IMPORTANT - this can only run in a browser. It drives an iframe via
 * postMessage and needs window/document to exist at all, so it can never
 * run in an Apps Script context or any server-side code.
 *
 * USAGE
 * -----
 *   import { PostManRenderEngine } from './render-engine.js';
 *
 *   const iframe = document.createElement('iframe');
 *   iframe.style.display = 'none'; // Photopea never needs to be visible
 *   iframe.src = 'https://www.photopea.com/#'; // the trailing '#' is required
 *   document.body.appendChild(iframe);
 *
 *   const engine = new PostManRenderEngine(iframe, {
 *     onProgress: (message, level) => console.log(level, message),
 *   });
 *
 *   await engine.boot();
 *   await engine.loadPSD(arrayBuffer);
 *
 *   // Vetting:
 *   const report = await engine.vetTemplate(['Cover', 'Middle', 'Last']);
 *
 *   // Generation:
 *   const { artboards } = await engine.extract();
 *   await engine.editHeadline('Cover', 'Luxury Living');
 *   await engine.insertStaticImage('Cover', photoDataUrl);
 *   const { blob, bounds } = await engine.exportArtboardPNG('Cover');
 */

// gifuct-js ships no browser/UMD build (only CommonJS), and this file is
// loaded directly by the browser with no bundler in this version of the
// project. A dynamic import() of jsDelivr's CJS-to-ESM conversion endpoint
// handles that cleanly - modern browsers support importing a remote ES
// module URL directly, so this needs no separate bootstrap <script> tag,
// just a lazy load the one time a GIF actually needs decoding.
let _gifuctPromise = null;
function loadGifuct() {
  if (!_gifuctPromise) {
    _gifuctPromise = import('https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/+esm');
  }
  return _gifuctPromise;
}

// ============================================================================
// Internal: the postMessage queue, with two empirically-required behaviors
// ============================================================================

/**
 * Wraps a single Photopea iframe's postMessage channel as a serialized
 * call queue. Two non-obvious behaviors were added after real failures,
 * not as precautions:
 *
 * 1. GRACE WINDOW after seeing "done": Photopea can deliver a script's
 *    own echoToOE(JSON...) payload measurably AFTER its "done" signal -
 *    observed up to ~170ms late in testing, even for fully synchronous
 *    scripts with no async work at all. Resolving immediately on the
 *    first "done" let that late payload leak into the NEXT call's
 *    listener instead, causing one call's real result to show up
 *    mislabeled under a later call. Waiting briefly after "done" (and
 *    re-extending the window if another message arrives) fixed it.
 *
 * 2. WATCHDOG timeout: if a call never gets any response at all (this
 *    happened with `duplicate()` on documents containing certain smart
 *    object layers - a confirmed Photopea bug, not ours, see
 *    https://github.com/photopea/photopea/issues/1121), the whole queue
 *    would otherwise hang forever with zero feedback. The watchdog gives
 *    up after `timeoutMs` and resolves with whatever was collected
 *    (possibly nothing), so the caller always gets a result.
 */
class PhotopeaChannel {
  constructor(iframeEl, { defaultTimeoutMs = 60000, graceMs = 400 } = {}) {
    this.iframe = iframeEl;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.graceMs = graceMs;
    this.queue = Promise.resolve();
  }

  call(payload, { timeoutMs = this.defaultTimeoutMs, onRawMessage } = {}) {
    this.queue = this.queue.then(() => new Promise((resolve) => {
      const outputs = [];
      let settleTimer = null;
      let watchdogTimer = null;
      let doneSeen = false;

      const finish = (timedOut) => {
        window.removeEventListener('message', handler);
        clearTimeout(watchdogTimer);
        clearTimeout(settleTimer);
        resolve({ outputs, timedOut: !!timedOut });
      };

      const handler = (e) => {
        if (e.source !== this.iframe.contentWindow) return;
        outputs.push(e.data);
        if (onRawMessage) onRawMessage(e.data);
        if (e.data === 'done') {
          doneSeen = true;
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => finish(false), this.graceMs);
        }
      };

      window.addEventListener('message', handler);
      watchdogTimer = setTimeout(() => { if (!doneSeen) finish(true); }, timeoutMs);
      this.iframe.contentWindow.postMessage(payload, '*');
    }));
    return this.queue;
  }

  /** Waits for Photopea's initial "done" boot signal (no payload needed). */
  waitForBoot(timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const handler = (e) => {
        if (e.source !== this.iframe.contentWindow) return;
        if (e.data === 'done' && !settled) {
          settled = true;
          window.removeEventListener('message', handler);
          clearTimeout(timer);
          resolve();
        }
      };
      window.addEventListener('message', handler);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', handler);
        reject(new Error('Photopea did not signal ready within ' + timeoutMs + 'ms'));
      }, timeoutMs);
    });
  }
}

// ============================================================================
// Internal: Photopea-side script fragments
// ============================================================================

/**
 * Shared helper functions inlined into every artboard-scoped script.
 * findTopLevelGroup/findLayerByName intentionally compare by `.name`,
 * never by object identity (`===`) - Photopea hands back a fresh wrapper
 * object on every read of a layers collection, even for the same
 * underlying layer, so `===` comparisons silently never match. This bit
 * us twice (clip-target lookup, "is this really the new layer" checks)
 * before settling on name-based comparison everywhere.
 */
const ARTBOARD_HELPERS = `
  function findTopLevelGroup(doc, groupName) {
    var lower = groupName.toLowerCase();
    for (var i = 0; i < doc.layers.length; i++) {
      var l = doc.layers[i];
      if (l.typename === "LayerSet" && l.name && l.name.toLowerCase() === lower) return l;
    }
    return null;
  }
  function findLayerByName(layers, name) {
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      if (l.typename === "LayerSet") { var found = findLayerByName(l.layers, name); if (found) return found; continue; }
      if (l.name === name) return l;
    }
    return null;
  }
  function countAllLayers(layers) {
    var n = 0;
    for (var i = 0; i < layers.length; i++) {
      n++;
      if (layers[i].typename === "LayerSet") n += countAllLayers(layers[i].layers);
    }
    return n;
  }
  function dim(d) { return (d && typeof d === "object" && d.value !== undefined) ? d.value : d; }
`;

function buildExtractionScript() {
  // Reports: document size, a flat recursive layer list (legacy/diagnostic),
  // and - the part generation and vetting both depend on - a per-artboard
  // breakdown of every top-level group's own nested layers, each with its
  // own bounds.
  //
  // IMPORTANT: error handling here is per-layer, not one outer try/catch
  // around the whole traversal. The first version wrapped the entire
  // recursive walk in one safe(), so if reading a property threw on EVEN
  // ONE layer anywhere in a group (locked layer, odd layer type, whatever),
  // the whole group's collected list silently reset to empty - discarding
  // every entry already gathered, "Image" included. That was a real,
  // confirmed bug, not a hypothetical one. Each layer's own properties,
  // and separately each layer's recursion into its children, get their own
  // try/catch so one bad layer can never erase its siblings.
  return `
(function(){
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  function readBounds(layer) {
    var b = layer.bounds;
    return { left: b[0].value, top: b[1].value, right: b[2].value, bottom: b[3].value,
             width: b[2].value - b[0].value, height: b[3].value - b[1].value };
  }
  function describeLayer(layer) {
    var item = { name: layer.name, typename: layer.typename, id: layer.id };
    item.bounds = safe(function(){ return readBounds(layer); }, null);
    item.kind = safe(function(){ return String(layer.kind); }, null);
    var isText = safe(function(){ return layer.kind == LayerKind.TEXT; }, false);
    item.isTextLayer = isText;
    if (isText === true) {
      item.text = safe(function(){
        var ti = layer.textItem;
        return { contents: ti.contents, font: ti.font,
                 size_px: (ti.size && ti.size.value !== undefined) ? ti.size.value : ti.size,
                 justification: String(ti.justification),
                 color_rgb: [ti.color.rgb.red, ti.color.rgb.green, ti.color.rgb.blue] };
      }, null);
    }
    return item;
  }
  function walk(layers, out) {
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      if (l.typename === "LayerSet") { walk(l.layers, out); continue; }
      out.push(describeLayer(l));
    }
  }
  function describeArtboardCandidate(layerSet) {
    var item = { name: layerSet.name, typename: layerSet.typename, bounds: null, boundsError: null };
    try { item.bounds = readBounds(layerSet); } catch (boundsErr) { item.boundsError = String(boundsErr); }
    var names = [];
    function collect(layers, depth) {
      if (!layers) return;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        var entry = null;
        try {
          entry = { name: l.name, typename: l.typename, depth: depth, bounds: null, boundsError: null };
          try { entry.bounds = readBounds(l); } catch (boundsErr) { entry.boundsError = String(boundsErr); }
          names.push(entry);
        } catch (innerErr) {
          names.push({ name: "(error reading this layer)", typename: "unknown", depth: depth, error: String(innerErr) });
        }
        try {
          if (l && l.typename === "LayerSet") collect(l.layers, depth + 1);
        } catch (recurseErr) {
          names.push({ name: "(error recursing into this group)", typename: "unknown", depth: depth + 1, error: String(recurseErr) });
        }
      }
    }
    collect(layerSet.layers, 1);
    item.childLayerNames = names;
    return item;
  }
  try {
    var doc = app.activeDocument;
    var out = [];
    walk(doc.layers, out);
    var artboards = [];
    for (var ai = 0; ai < doc.layers.length; ai++) {
      var topLayer = doc.layers[ai];
      if (topLayer.typename === "LayerSet") artboards.push(describeArtboardCandidate(topLayer));
    }
    app.echoToOE(JSON.stringify({
      __poc: "extraction",
      docWidth: dim2(doc.width), docHeight: dim2(doc.height),
      layers: out, artboards: artboards
    }));
  } catch (topLevelErr) {
    app.echoToOE(JSON.stringify({ __poc: "extraction_error", message: String(topLevelErr) }));
  }
  function dim2(d) { return (d && typeof d === "object" && d.value !== undefined) ? d.value : d; }
  app.echoToOE("done");
})();
`;
}

function buildArtboardHeadlineEditScript(artboardName, newText) {
  const escaped = newText.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/\r?\n/g, '\\n');
  return `
(function(){
  ${ARTBOARD_HELPERS}
  try {
    var doc = app.activeDocument;
    var group = findTopLevelGroup(doc, "${artboardName}");
    if (!group) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "headline", artboard: "${artboardName}", message: "No top-level group named '${artboardName}' found." }));
      app.echoToOE("done");
      return;
    }
    var target = findLayerByName(group.layers, "headline text");
    if (!target) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "headline", artboard: "${artboardName}", message: "No layer named 'headline text' found inside '${artboardName}'." }));
    } else {
      target.textItem.contents = "${escaped}";
      app.echoToOE(JSON.stringify({ __poc: "edit_ok", step: "headline", artboard: "${artboardName}", layerName: target.name }));
    }
  } catch (e) {
    app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "headline", artboard: "${artboardName}", message: String(e) }));
  }
  app.echoToOE("done");
})();
`;
}

function buildArtboardLayerCountScript(artboardName) {
  // Recursive document-wide count, not group.layers.length - we don't know
  // for certain whether app.open(..., null, true) inserts the new layer
  // inside the active group or at the document's top level. A recursive
  // total catches the new layer either way.
  return `
(function(){
  ${ARTBOARD_HELPERS}
  try {
    var doc = app.activeDocument;
    var group = findTopLevelGroup(doc, "${artboardName}");
    if (!group) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "image", artboard: "${artboardName}", message: "No top-level group named '${artboardName}' found." }));
    } else {
      app.echoToOE(JSON.stringify({
        __poc: "layer_count_check", artboard: "${artboardName}",
        count: countAllLayers(doc.layers),
        activeLayerName: doc.activeLayer ? doc.activeLayer.name : null
      }));
    }
  } catch (e) {
    app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "image", artboard: "${artboardName}", message: String(e) }));
  }
  app.echoToOE("done");
})();
`;
}

function buildArtboardKickoffOpenScript(artboardName, dataUrl) {
  // Deliberately does nothing else, and the caller must not trust this
  // call's response timing or content. Confirmed empirically: calling
  // app.open() makes Photopea send "done" almost immediately, while the
  // rest of that SAME script keeps running separately afterward and
  // reports back whenever it's actually ready - landing on whatever
  // ppCall happens to be listening at that moment, not necessarily this
  // one. So: never put follow-up logic in the same script as app.open().
  return `
(function(){
  ${ARTBOARD_HELPERS}
  try {
    var doc = app.activeDocument;
    var group = findTopLevelGroup(doc, "${artboardName}");
    if (!group) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "image", artboard: "${artboardName}", message: "No top-level group named '${artboardName}' found." }));
      app.echoToOE("done");
      return;
    }
    var oldImg = findLayerByName(group.layers, "Image");
    if (oldImg) { doc.activeLayer = oldImg; } // best-effort nudge, not load-bearing - move() in finalize corrects placement regardless
    app.open("${dataUrl}", null, true);
  } catch (e) {
    app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "image", artboard: "${artboardName}", message: "Failed to call app.open(): " + String(e) }));
  }
  app.echoToOE("done");
})();
`;
}

function buildArtboardFinalizeImagePlacementScript(artboardName) {
  return `
(function(){
  ${ARTBOARD_HELPERS}
  try {
    var doc = app.activeDocument;
    var group = findTopLevelGroup(doc, "${artboardName}");
    if (!group) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "image", artboard: "${artboardName}", message: "No top-level group named '${artboardName}' found." }));
      app.echoToOE("done");
      return;
    }
    var oldImg = findLayerByName(group.layers, "Image");
    var newLayer = doc.activeLayer;
    if (!oldImg) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "image", artboard: "${artboardName}", message: "No layer named 'Image' found inside '${artboardName}'." }));
      app.echoToOE("done");
      return;
    }
    if (!newLayer || newLayer.name === oldImg.name) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "image", artboard: "${artboardName}", message: "Could not identify the newly inserted layer (activeLayer missing or unchanged)." }));
      app.echoToOE("done");
      return;
    }
    var ob = oldImg.bounds;
    var targetW = ob[2].value - ob[0].value, targetH = ob[3].value - ob[1].value;
    var targetCx = (ob[0].value + ob[2].value) / 2, targetCy = (ob[1].value + ob[3].value) / 2;
    var nb = newLayer.bounds;
    var curW = nb[2].value - nb[0].value, curH = nb[3].value - nb[1].value;
    var scalePct = Math.max(targetW / curW, targetH / curH) * 100;
    newLayer.resize(scalePct, scalePct, AnchorPosition.TOPLEFT);
    var nb2 = newLayer.bounds;
    var curCx = (nb2[0].value + nb2[2].value) / 2, curCy = (nb2[1].value + nb2[3].value) / 2;
    newLayer.translate(targetCx - curCx, targetCy - curCy);
    // move() can relocate a layer into a different group than it's
    // currently in, so this corrects placement even if app.open() landed
    // the new layer outside the target group.
    newLayer.move(oldImg, ElementPlacement.PLACEBEFORE);
    oldImg.remove();
    newLayer.grouped = true;
    newLayer.name = "Image";
    app.echoToOE(JSON.stringify({ __poc: "edit_ok", step: "image", artboard: "${artboardName}", layerName: newLayer.name, scalePct: scalePct }));
  } catch (e) {
    app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "image", artboard: "${artboardName}", message: String(e) }));
  }
  app.echoToOE("done");
})();
`;
}

function buildArtboardInsertFrameScript(artboardName, frameIndex, isLastFrame, clipBaseName) {
  // Used for GIF jobs - inserts ONE frame, named "_a_frame<N>".
  //
  // Multiple frames must all clip to the SAME underlying placeholder
  // shape, not to each other or to the previous frame. The first call
  // (clipBaseName not yet known) derives it structurally - the layer
  // right after "Image" in the stack, since nothing has moved yet - and
  // reports its name back. Every later call is told that name explicitly
  // and looks it up directly: re-deriving it structurally on later frames
  // would be wrong, since by then a previously-inserted frame sits
  // between "Image" and the real placeholder, shifting the position-based
  // heuristic.
  //
  // "Image" itself stays alive (not deleted) until the very last frame,
  // so its bounds remain a stable, re-readable target box throughout.
  const clipBaseNameEscaped = clipBaseName ? clipBaseName.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : null;
  return `
(function(){
  ${ARTBOARD_HELPERS}
  try {
    var doc = app.activeDocument;
    var group = findTopLevelGroup(doc, "${artboardName}");
    if (!group) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "frame", artboard: "${artboardName}", message: "No top-level group named '${artboardName}' found." }));
      app.echoToOE("done");
      return;
    }
    var oldImg = findLayerByName(group.layers, "Image");
    var newLayer = doc.activeLayer;
    if (!oldImg) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "frame", artboard: "${artboardName}", message: "No layer named 'Image' found inside '${artboardName}'." }));
      app.echoToOE("done");
      return;
    }
    if (!newLayer || newLayer.name === oldImg.name) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "frame", artboard: "${artboardName}", message: "Could not identify the newly inserted layer." }));
      app.echoToOE("done");
      return;
    }
    var clipBase = null;
    ${clipBaseNameEscaped
      ? `clipBase = findLayerByName(group.layers, "${clipBaseNameEscaped}");`
      : `var oldImgIndex = -1;
    for (var k = 0; k < group.layers.length; k++) {
      if (group.layers[k].name === oldImg.name) { oldImgIndex = k; break; }
    }
    clipBase = (oldImgIndex >= 0 && oldImgIndex + 1 < group.layers.length) ? group.layers[oldImgIndex + 1] : null;`}
    if (!clipBase) {
      app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "frame", artboard: "${artboardName}", message: "Could not determine the layer to clip frames to." }));
      app.echoToOE("done");
      return;
    }
    var ob = oldImg.bounds;
    var targetW = ob[2].value - ob[0].value, targetH = ob[3].value - ob[1].value;
    var targetCx = (ob[0].value + ob[2].value) / 2, targetCy = (ob[1].value + ob[3].value) / 2;
    var nb = newLayer.bounds;
    var curW = nb[2].value - nb[0].value, curH = nb[3].value - nb[1].value;
    var scalePct = Math.max(targetW / curW, targetH / curH) * 100;
    newLayer.resize(scalePct, scalePct, AnchorPosition.TOPLEFT);
    var nb2 = newLayer.bounds;
    var curCx = (nb2[0].value + nb2[2].value) / 2, curCy = (nb2[1].value + nb2[3].value) / 2;
    newLayer.translate(targetCx - curCx, targetCy - curCy);
    newLayer.move(clipBase, ElementPlacement.PLACEBEFORE);
    newLayer.grouped = true;
    newLayer.name = "_a_frame${frameIndex}";
    ${isLastFrame ? 'oldImg.remove();' : ''}
    app.echoToOE(JSON.stringify({
      __poc: "edit_ok", step: "frame", artboard: "${artboardName}", frameIndex: ${frameIndex},
      layerName: newLayer.name, clipBaseName: clipBase.name, removedOldImage: ${isLastFrame ? 'true' : 'false'}
    }));
  } catch (e) {
    app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "frame", artboard: "${artboardName}", message: String(e) }));
  }
  app.echoToOE("done");
})();
`;
}

function buildArtboardIsolateAndExportScript(artboardName, format) {
  format = format || 'png';
  // duplicate() is confirmed unreliable on documents with certain smart
  // object layers (a known Photopea bug, not specific to us - see
  // https://github.com/photopea/photopea/issues/1121, "the whole
  // application hangs" on duplicate() for documents with linked/embedded
  // smart objects). Never call it.
  //
  // Instead: hide every top-level layer except the target artboard's
  // group, export the FULL canvas (the single most reliable operation in
  // this whole project), then restore visibility in a separate call. For
  // PNG, cropping to just this artboard's rectangle happens afterward in
  // the browser via <canvas> (see cropImageToRect below). For gif/mp4 that
  // crop trick doesn't work - drawing an animated GIF onto a canvas
  // freezes it to one frame, and there's no equivalent for video - so
  // animated exports currently come out at the full multi-artboard canvas
  // size. Known, documented limitation; not fixed in this version.
  return `
(function(){
  ${ARTBOARD_HELPERS}
  try {
    var doc = app.activeDocument;
    var group = findTopLevelGroup(doc, "${artboardName}");
    if (!group) {
      app.echoToOE(JSON.stringify({ __poc: "export_error", artboard: "${artboardName}", message: "No top-level group named '${artboardName}' found." }));
      app.echoToOE("done");
      return;
    }
    var b = group.bounds;
    var left = b[0].value, top = b[1].value, right = b[2].value, bottom = b[3].value;
    app.echoToOE(JSON.stringify({
      __poc: "export_probe", artboard: "${artboardName}",
      bounds: { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top }
    }));
    for (var i = 0; i < doc.layers.length; i++) {
      doc.layers[i].visible = (doc.layers[i].name === group.name);
    }
    app.echoToOE(JSON.stringify({ __poc: "export_checkpoint", artboard: "${artboardName}", step: "visibility_isolated" }));
    doc.saveToOE("${format}");
  } catch (e) {
    app.echoToOE(JSON.stringify({ __poc: "export_error", artboard: "${artboardName}", message: String(e) }));
  }
  app.echoToOE("done");
})();
`;
}

function buildRestoreAllVisibilityScript() {
  // Self-contained, no native open/save/duplicate calls - sets every
  // top-level layer back to visible. Each artboard's own isolate step
  // overwrites visibility for everyone anyway, so this is for tidiness
  // between jobs more than strict correctness.
  return `
(function(){
  try {
    var doc = app.activeDocument;
    for (var i = 0; i < doc.layers.length; i++) { doc.layers[i].visible = true; }
    app.echoToOE(JSON.stringify({ __poc: "visibility_restored", count: doc.layers.length }));
  } catch (e) {
    app.echoToOE(JSON.stringify({ __poc: "edit_error", step: "restore_visibility", message: String(e) }));
  }
  app.echoToOE("done");
})();
`;
}

// ============================================================================
// Internal: browser-only pure utilities (no Photopea involved)
// ============================================================================

/**
 * Crops a binary PNG (as received from Photopea) down to a pixel rect,
 * returning a Blob at that rect's native size. PNG only - drawing an
 * animated GIF onto canvas captures a single frame, so this cannot be
 * used to crop animated exports (see exportArtboardAnimated below).
 */
function cropImageToRect(binaryPngData, rect) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([binaryPngData], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    let settled = false;
    const hardTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      reject(new Error('Image never loaded or errored within 10s'));
    }, 10000);
    img.onload = () => {
      if (settled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(rect.width));
        canvas.height = Math.max(1, Math.round(rect.height));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas.getContext("2d") returned null');
        ctx.drawImage(img, rect.left, rect.top, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((croppedBlob) => {
          if (settled) return;
          settled = true;
          clearTimeout(hardTimeout);
          if (croppedBlob) resolve(croppedBlob);
          else reject(new Error('canvas.toBlob() returned null'));
        }, 'image/png');
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load the exported PNG into an Image element'));
    };
    img.src = url;
  });
}

/** Crops an arbitrary image data URL down to a source-pixel rect (used by the crop-tool flow, before anything goes to Photopea). */
function applyCropToImage(dataUrl, rect) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(rect.width));
        canvas.height = Math.max(1, Math.round(rect.height));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('applyCropToImage: failed to load source image'));
    img.src = dataUrl;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) { resolve(null); return; }
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Failed to read ' + file.name));
    r.readAsDataURL(file);
  });
}

function seekVideoTo(video, t) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onSeeked = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      reject(new Error('Timed out seeking video to ' + t.toFixed(2) + 's'));
    }, 8000);
    video.currentTime = t;
  });
}

/**
 * PAUSED, not deleted. Video support was explored and intentionally
 * shelved (Photopea has a documented, currently-open MP4 export
 * reliability bug - see https://github.com/photopea/photopea/issues/6509)
 * but the extraction mechanism itself (browser-native <video> + <canvas>,
 * no ffmpeg, no server transcoding) worked fine and is kept here for
 * whenever video gets revisited.
 */
function extractVideoFrames(file, opts = {}) {
  const maxFrames = opts.maxFrames || 6;
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    const cleanup = () => URL.revokeObjectURL(url);
    video.onloadedmetadata = async () => {
      try {
        const duration = video.duration;
        if (!isFinite(duration) || duration <= 0) {
          throw new Error('Could not determine video duration (got ' + duration + ').');
        }
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) throw new Error('Video reported no visible width/height.');
        const frameCount = Math.max(2, Math.min(maxFrames, Math.ceil(duration * 4)));
        const delayMs = Math.round((duration * 1000) / frameCount);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const results = [];
        for (let i = 0; i < frameCount; i++) {
          const t = (duration * (i + 0.5)) / frameCount;
          await seekVideoTo(video, t);
          ctx.drawImage(video, 0, 0, w, h);
          results.push({ dataUrl: canvas.toDataURL('image/png'), delayMs });
        }
        cleanup();
        resolve(results);
      } catch (e) { cleanup(); reject(e); }
    };
    video.onerror = () => { cleanup(); reject(new Error('Failed to load the video file - unsupported format/codec, most likely.')); };
    video.src = url;
  });
}

/**
 * Decodes a GIF in the browser via gifuct-js (pure JS, no workers, no
 * SharedArrayBuffer - works without any special server headers, unlike
 * ffmpeg.wasm, which was evaluated and rejected for exactly that reason).
 */
function extractGifFrames(file, opts = {}) {
  const maxFrames = opts.maxFrames || 8;
  return new Promise(async (resolve, reject) => {
    try {
      const { parseGIF, decompressFrames } = await loadGifuct();
      const arrayBuffer = await file.arrayBuffer();
      const gif = parseGIF(arrayBuffer);
      const allFrames = decompressFrames(gif, true);
      if (!allFrames.length) throw new Error('GIF has no frames.');
      const canvasW = (gif.lsd && gif.lsd.width) || allFrames[0].dims.width;
      const canvasH = (gif.lsd && gif.lsd.height) || allFrames[0].dims.height;
      const composeCanvas = document.createElement('canvas');
      composeCanvas.width = canvasW; composeCanvas.height = canvasH;
      const composeCtx = composeCanvas.getContext('2d');
      const step = Math.max(1, Math.ceil(allFrames.length / maxFrames));
      const results = [];
      for (let i = 0; i < allFrames.length && results.length < maxFrames; i++) {
        const frame = allFrames[i];
        const patchCanvas = document.createElement('canvas');
        patchCanvas.width = frame.dims.width; patchCanvas.height = frame.dims.height;
        patchCanvas.getContext('2d').putImageData(new ImageData(frame.patch, frame.dims.width, frame.dims.height), 0, 0);
        composeCtx.drawImage(patchCanvas, frame.dims.left, frame.dims.top);
        if (i % step === 0) {
          const snapshot = document.createElement('canvas');
          snapshot.width = canvasW; snapshot.height = canvasH;
          snapshot.getContext('2d').drawImage(composeCanvas, 0, 0);
          results.push({ dataUrl: snapshot.toDataURL('image/png'), delayMs: frame.delay || 100 });
        }
        // Disposal type 2 = restore to background before the next frame -
        // a reasonable approximation, not a full GIF-spec implementation.
        if (frame.disposalType === 2) composeCtx.clearRect(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
      }
      resolve(results);
    } catch (e) { reject(e); }
  });
}

function extractFrames(file, attachmentType, opts) {
  if (attachmentType === 'gif') return extractGifFrames(file, opts);
  if (attachmentType === 'video') return extractVideoFrames(file, opts); // paused in product, kept functional here
  return Promise.reject(new Error(`extractFrames: unsupported attachmentType "${attachmentType}"`));
}

// ============================================================================
// The engine
// ============================================================================

export class PostManRenderEngine {
  /**
   * @param {HTMLIFrameElement} iframeEl - an iframe already pointed at
   *   'https://www.photopea.com/#' (the trailing '#' is required - without
   *   it Photopea loads its marketing page, not the editor). The caller
   *   owns creating/appending/hiding this element; the engine never
   *   touches its visibility or styling.
   * @param {object} [options]
   * @param {(message: string, level: 'info'|'ok'|'warn'|'err') => void} [options.onProgress] -
   *   called at each meaningful step. Optional - defaults to a no-op.
   *   This is how the engine reports progress without knowing anything
   *   about the UI rendering it (console.log, a React state update, a
   *   websocket message to a job-status page - caller's choice).
   * @param {number} [options.callTimeoutMs=60000] - watchdog timeout per call.
   */
  constructor(iframeEl, { onProgress = () => {}, callTimeoutMs = 60000 } = {}) {
    this.channel = new PhotopeaChannel(iframeEl, { defaultTimeoutMs: callTimeoutMs });
    this.onProgress = onProgress;
    this.artboardImageBounds = {}; // populated by extract(); keyed by lowercased artboard name
  }

  _progress(message, level = 'info') { this.onProgress(message, level); }

  /** Waits for Photopea's initial ready signal. Call once, right after creating the iframe. */
  async boot() {
    this._progress('Booting Photopea...', 'info');
    await this.channel.waitForBoot();
    this._progress('Photopea ready.', 'ok');
  }

  /** Loads PSD bytes into the (now-booted) Photopea instance. */
  async loadPSD(arrayBuffer) {
    this._progress('Loading PSD...', 'info');
    const { outputs, timedOut } = await this.channel.call(arrayBuffer);
    if (timedOut) throw new Error('Photopea did not respond to the PSD load within the timeout.');
    this._progress('PSD loaded.', 'ok');
    return outputs;
  }

  /**
   * Runs extraction and returns the parsed structure. Also updates the
   * internal per-artboard "Image" placeholder aspect-ratio lookup used by
   * insertStaticImage/insertFrames callers that want to offer a crop step
   * (see applyCropToImage / the crop-tool pattern in the original POC).
   *
   * Known timing quirk, handled automatically: nested layer bounds aren't
   * always ready to read immediately after a large document finishes
   * loading, even though TOP-LEVEL group bounds already are. If this
   * shows up (an "Image" layer found by name but its bounds throw), this
   * method waits 2.5s and retries extraction once before giving up.
   */
  async extract() {
    const result = await this._runExtractionOnce('extract');
    if (result.hadBoundsTimingSymptom) {
      this._progress('Some layer bounds were not ready yet (known timing quirk right after loading a large PSD) - retrying once after 2.5s...', 'warn');
      await new Promise((r) => setTimeout(r, 2500));
      return this._runExtractionOnce('extract-auto-retry');
    }
    return result;
  }

  async _runExtractionOnce(label) {
    const { outputs } = await this.channel.call(buildExtractionScript());
    let parsed = null;
    for (const o of outputs) {
      if (typeof o !== 'string') continue;
      try {
        const p = JSON.parse(o);
        if (p.__poc === 'extraction') { parsed = p; break; }
        if (p.__poc === 'extraction_error') throw new Error('Extraction script threw: ' + p.message);
      } catch (e) { if (e.message && e.message.startsWith('Extraction script threw')) throw e; }
    }
    if (!parsed) throw new Error('Extraction finished but returned no recognizable result.');
    this._progress(`Extraction (${label}): found ${parsed.layers.length} layers, ${(parsed.artboards || []).length} top-level group(s) (doc: ${parsed.docWidth}x${parsed.docHeight}px).`, 'ok');
    const hadBoundsTimingSymptom = this._updateImageBoundsLookup(parsed.artboards || []);
    return { ...parsed, hadBoundsTimingSymptom };
  }

  _updateImageBoundsLookup(artboards) {
    this.artboardImageBounds = {};
    let hadBoundsTimingSymptom = false;
    for (const ab of artboards) {
      if (!ab.bounds) {
        // Same class of issue as the "Image" layer case below: we've
        // proven repeatedly elsewhere (every export call) that artboard
        // bounds ARE readable, so a null here right after a fresh load is
        // almost certainly the same load-timing quirk, not a structural
        // problem - flag it so extract() retries instead of accepting it.
        hadBoundsTimingSymptom = true;
        this._progress(`${ab.name}: could not read this artboard's own bounds yet${ab.boundsError ? ' - ' + ab.boundsError : ''}.`, 'err');
      }
      const allNamedImage = (ab.childLayerNames || []).filter((c) => c.name === 'Image');
      const withBounds = allNamedImage.find((c) => c.bounds);
      if (withBounds) {
        this.artboardImageBounds[ab.name.toLowerCase()] = {
          width: withBounds.bounds.width, height: withBounds.bounds.height,
          aspect: withBounds.bounds.width / withBounds.bounds.height,
        };
        this._progress(`${ab.name}: Image placeholder = ${withBounds.bounds.width.toFixed(0)}x${withBounds.bounds.height.toFixed(0)} (${(withBounds.bounds.width / withBounds.bounds.height).toFixed(2)}:1)`, 'ok');
      } else if (allNamedImage.length) {
        hadBoundsTimingSymptom = true;
        const errs = allNamedImage.map((c) => c.boundsError).filter(Boolean);
        this._progress(`${ab.name}: found a layer named "Image" but could not read its bounds${errs.length ? ' - ' + errs.join('; ') : ''}.`, 'err');
      } else {
        this._progress(`${ab.name}: no "Image" layer found - fine if this slide has no photo placeholder by design (e.g. a text-only closing slide).`, 'info');
      }
    }
    return hadBoundsTimingSymptom;
  }

  /**
   * Structural validation against the template spec. Run this once when a
   * new template is uploaded, before it goes live - not on every
   * generation. Returns a report; does not throw on structural problems
   * (those are exactly what it exists to surface).
   *
   * @param {string[]} expectedArtboardNames - e.g. ['Cover', 'Middle', 'Last']
   */
  async vetTemplate(expectedArtboardNames) {
    const extraction = await this.extract();
    const artboards = extraction.artboards || [];
    const byLowerName = new Map(artboards.map((ab) => [ab.name.toLowerCase(), ab]));
    const issues = [];
    const notes = [];

    for (const expected of expectedArtboardNames) {
      const ab = byLowerName.get(expected.toLowerCase());
      if (!ab) {
        issues.push(`Missing expected artboard "${expected}" - no top-level group with this name was found.`);
        continue;
      }
      if (!ab.bounds) issues.push(`Artboard "${expected}" has no readable bounds${ab.boundsError ? ' (' + ab.boundsError + ')' : ''} - if this persists after a re-run, it's worth investigating further; the auto-retry in extract() should normally resolve a one-off timing issue here.`);
      const hasHeadline = (ab.childLayerNames || []).some((c) => c.name === 'headline text');
      if (!hasHeadline) notes.push(`"${expected}" has no layer named "headline text" - fine if this slide has no editable text.`);
      const imageEntries = (ab.childLayerNames || []).filter((c) => c.name === 'Image');
      if (imageEntries.length > 1) issues.push(`"${expected}" has more than one layer named "Image" - lookups will use the first match, which is ambiguous.`);
      if (imageEntries.length === 1 && !imageEntries[0].bounds) issues.push(`"${expected}" has a layer named "Image" but its bounds could not be read: ${imageEntries[0].boundsError || 'no specific error'}.`);
      if (imageEntries.length === 0) notes.push(`"${expected}" has no layer named "Image" - fine for a text-only slide.`);
    }

    // Overlap check across ALL detected top-level groups (not just expected
    // ones) - export isolates one artboard by hiding the others, so two
    // overlapping artboards would bleed into each other's exports.
    const withBounds = artboards.filter((a) => a.bounds);
    for (let i = 0; i < withBounds.length; i++) {
      for (let j = i + 1; j < withBounds.length; j++) {
        const a = withBounds[i].bounds, b = withBounds[j].bounds;
        const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        if (overlaps) issues.push(`Artboards "${withBounds[i].name}" and "${withBounds[j].name}" have overlapping bounds - exporting one will bleed into the other.`);
      }
    }

    // Unexpected top-level content - anything not matching an expected
    // name gets hidden during every single-artboard export, so any visual
    // content meant to be shared/always-visible needs to live inside an
    // expected artboard group, not floating at the top level.
    const expectedLower = new Set(expectedArtboardNames.map((n) => n.toLowerCase()));
    for (const ab of artboards) {
      if (!expectedLower.has(ab.name.toLowerCase())) {
        notes.push(`Unexpected top-level group "${ab.name}" - it will be HIDDEN during every export of an expected artboard. Move its content inside an expected group, or remove it, if it's meant to be visible.`);
      }
    }

    const passed = issues.length === 0;
    this._progress(passed ? 'Vetting passed.' : `Vetting found ${issues.length} issue(s).`, passed ? 'ok' : 'err');
    return { passed, issues, notes, extraction, artboardImageBounds: { ...this.artboardImageBounds } };
  }

  /** Edits the headline text layer (named exactly "headline text") inside the given artboard. */
  async editHeadline(artboardName, text) {
    const { outputs } = await this.channel.call(buildArtboardHeadlineEditScript(artboardName, text));
    return this._reportEditOutcome(outputs, `${artboardName} headline`);
  }

  /**
   * Replaces the "Image" layer's content with a single static photo,
   * preserving its clip mask, position, and size. `dataUrl` should
   * already be cropped to the desired framing if you're using the
   * crop-tool pattern - this method does not crop, only resizes-to-fit
   * and re-clips.
   */
  async insertStaticImage(artboardName, dataUrl) {
    const ready = await this._waitForNewLayer(artboardName, dataUrl);
    if (!ready.ok) return ready;
    const { outputs } = await this.channel.call(buildArtboardFinalizeImagePlacementScript(artboardName));
    return this._reportEditOutcome(outputs, `${artboardName} image`);
  }

  /**
   * Replaces the "Image" layer with N animated frames, each clipped to
   * the same placeholder and named "_a_frameN". `frames` is an array of
   * { dataUrl, delayMs } as returned by extractFrames(). Costs roughly
   * one full insertion round-trip PER FRAME (~1.5-2s each in testing) -
   * a 6-7 frame GIF slide takes on the order of 15-20+ seconds on its own.
   */
  async insertFrames(artboardName, frames) {
    let clipBaseName = null;
    for (let i = 0; i < frames.length; i++) {
      const isLast = i === frames.length - 1;
      this._progress(`${artboardName}: inserting frame ${i + 1}/${frames.length}...`, 'info');
      const ready = await this._waitForNewLayer(artboardName, frames[i].dataUrl);
      if (!ready.ok) return ready;
      const { outputs } = await this.channel.call(buildArtboardInsertFrameScript(artboardName, i, isLast, clipBaseName));
      const result = this._parseEditOutcome(outputs);
      if (!result.ok) {
        this._progress(`${artboardName}: frame ${i + 1} failed - ${result.message}`, 'err');
        return result;
      }
      clipBaseName = result.clipBaseName;
    }
    this._progress(`${artboardName}: all ${frames.length} frames inserted.`, 'ok');
    return { ok: true };
  }

  async _waitForNewLayer(artboardName, dataUrl) {
    const before = await this.channel.call(buildArtboardLayerCountScript(artboardName));
    const baseline = this._parseLayerCount(before.outputs);
    if (baseline === null) return { ok: false, message: 'Could not establish a baseline layer count.' };

    await this.channel.call(buildArtboardKickoffOpenScript(artboardName, dataUrl));

    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const check = await this.channel.call(buildArtboardLayerCountScript(artboardName));
      const count = this._parseLayerCount(check.outputs);
      if (count !== null && count > baseline) return { ok: true };
    }
    return { ok: false, message: 'Gave up waiting for the new image layer to appear.' };
  }

  _parseLayerCount(outputs) {
    for (const o of outputs) {
      if (typeof o !== 'string') continue;
      try { const p = JSON.parse(o); if (p.__poc === 'layer_count_check') return p.count; } catch {}
    }
    return null;
  }

  _parseEditOutcome(outputs) {
    for (const o of outputs) {
      if (typeof o !== 'string') continue;
      try {
        const p = JSON.parse(o);
        if (p.__poc === 'edit_ok') return { ok: true, layerName: p.layerName, clipBaseName: p.clipBaseName };
        if (p.__poc === 'edit_error') return { ok: false, message: p.message };
      } catch {}
    }
    return { ok: false, message: 'No response from Photopea.' };
  }

  _reportEditOutcome(outputs, label) {
    const result = this._parseEditOutcome(outputs);
    if (result.ok) {
      this._progress(`${label}: applied to layer "${result.layerName || ''}".`, 'ok');
    } else {
      // "No layer named 'Image' found" is the normal case for a text-only
      // slide with no photo placeholder by design - not an error.
      const isMissingImageLayer = /No layer named 'Image' found/.test(result.message || '');
      this._progress(`${label}: ${isMissingImageLayer ? 'no "Image" layer here - skipping (expected for a text-only slide).' : result.message}`, isMissingImageLayer ? 'info' : 'err');
    }
    return result;
  }

  /**
   * Isolates one artboard (hides the others), exports it, restores
   * visibility, and crops the result to that artboard's exact bounds.
   * @returns {{ blob: Blob, bounds: object }}
   */
  async exportArtboardPNG(artboardName) {
    const { binary, bounds } = await this._isolateAndExport(artboardName, 'png');
    if (!binary) throw new Error(`${artboardName}: export finished but no image data came back.`);
    const blob = await cropImageToRect(binary, bounds);
    this._progress(`${artboardName}: export complete, cropped to ${Math.round(bounds.width)}x${Math.round(bounds.height)}.`, 'ok');
    return { blob, bounds };
  }

  /**
   * Same isolate/export/restore flow, for an animated format (gif/mp4).
   * KNOWN LIMITATION, by deliberate decision, not oversight: this comes
   * back at the FULL multi-artboard canvas size, not cropped to just this
   * artboard - the PNG crop trick doesn't work on animated content
   * (canvas freezes a GIF to one frame; there's no equivalent for video).
   * A from-scratch client-side reassembly approach was scoped (decode
   * each frame, crop, re-encode with a library like gifenc) but shelved
   * in favor of shipping with this documented limitation for now.
   */
  async exportArtboardAnimated(artboardName, format = 'gif') {
    const { binary, bounds } = await this._isolateAndExport(artboardName, format);
    if (!binary) throw new Error(`${artboardName}: export finished but no ${format} data came back.`);
    const mime = format === 'gif' ? 'image/gif' : 'video/mp4';
    const blob = new Blob([binary], { type: mime });
    this._progress(`${artboardName}: ${format.toUpperCase()} export complete (${binary.byteLength || binary.length} bytes, full canvas size - not cropped to this slide).`, 'ok');
    return { blob, bounds, croppedToArtboard: false };
  }

  async _isolateAndExport(artboardName, format) {
    const { outputs } = await this.channel.call(buildArtboardIsolateAndExportScript(artboardName, format));
    let bounds = null;
    for (const o of outputs) {
      if (typeof o !== 'string') continue;
      try {
        const p = JSON.parse(o);
        if (p.__poc === 'export_probe') bounds = p.bounds;
        else if (p.__poc === 'export_error') this._progress(`${artboardName}: export error - ${p.message}`, 'err');
      } catch {}
    }
    const binary = outputs.find((o) => typeof o !== 'string');
    const restore = await this.channel.call(buildRestoreAllVisibilityScript());
    for (const o of restore.outputs) {
      if (typeof o !== 'string') continue;
      try { const p = JSON.parse(o); if (p.__poc === 'edit_error') this._progress(`${artboardName}: restore-visibility error - ${p.message}`, 'err'); } catch {}
    }
    return { binary, bounds };
  }
}

// ============================================================================
// Exported pure utilities (usable independently of the engine class - e.g.
// from a React crop-tool component, before anything is sent to Photopea)
// ============================================================================

export {
  applyCropToImage,
  cropImageToRect,
  fileToDataUrl,
  extractFrames,
  extractGifFrames,
  extractVideoFrames,
};
