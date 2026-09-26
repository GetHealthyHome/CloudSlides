/*
 * CloudSlides editor. Plain browser JavaScript, no build step.
 *
 * The document model (state.doc) is plain JSON:
 *   { name, grid: { size, snap, show }, templates: [Template], deck: [{ id, templateId }] }
 * Templates hold elements positioned in inches on the 11 x 8.5 in page.
 */
(function () {
  'use strict';

  var R = window.CloudSlidesRender;
  var D = window.CloudSlidesData;
  var X = window.CloudSlidesExport;
  var T = window.CloudSlidesTemplates;
  var PAGE_W = R.PAGE.width;
  var PAGE_H = R.PAGE.height;
  var DPI = R.DPI;

  R.injectCSS(document);

  var PRESETS = T.PALETTE; // [{ name, hex }]

  var state = {
    doc: null,
    project: null,
    currentId: null,
    selectedId: null,
    deckEntryId: null,
    zoom: 'fit',
    z: 1,
    dataPreview: true,
    clipboard: null,
    tool: null, // 'line' while drawing a line
    cloud: null // { id, name, updatedAt, updatedBy, dirty } when this deck is in the shared library
  };
  var history = { undo: [], redo: [], lastKey: null, lastTime: 0 };

  /* ---------- small helpers ---------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Tiny DOM builder: h('div', { class: 'x', onclick: fn }, child, 'text')
  function h(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
      else node.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (cc) { if (cc) node.appendChild(typeof cc === 'string' ? document.createTextNode(cc) : cc); });
      else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function prefs(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem('cloudslides.pref.' + k));
      localStorage.setItem('cloudslides.pref.' + k, JSON.stringify(v));
    } catch (e) { return null; }
  }

  /* ---------- persistence (IndexedDB: photos can be large) ---------- */

  var store = (function () {
    var dbp;
    function open() {
      if (!dbp) {
        dbp = new Promise(function (res, rej) {
          var r = indexedDB.open('cloudslides', 1);
          r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
          r.onsuccess = function () { res(r.result); };
          r.onerror = function () { rej(r.error); };
        });
      }
      return dbp;
    }
    return {
      get: function (k) {
        return open().then(function (db) {
          return new Promise(function (res, rej) {
            var q = db.transaction('kv').objectStore('kv').get(k);
            q.onsuccess = function () { res(q.result); };
            q.onerror = function () { rej(q.error); };
          });
        }).catch(function () { return undefined; });
      },
      set: function (k, v) {
        return open().then(function (db) {
          return new Promise(function (res, rej) {
            var tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(v, k);
            tx.oncomplete = function () { res(); };
            tx.onerror = function () { rej(tx.error); };
          });
        });
      }
    };
  })();

  var saveTimer;
  function save() {
    if (state.cloud && !state.cloud.dirty) {
      state.cloud.dirty = true;
      store.set('cloud', state.cloud).catch(function () {});
      renderCloudStatus();
    }
    clearTimeout(saveTimer);
    setStatus('Saving…');
    saveTimer = setTimeout(function () {
      store.set('doc', state.doc).then(function () { setStatus('Saved'); }, function (e) {
        setStatus('Not saved');
        toast('Could not save locally: ' + (e && e.message ? e.message : e));
      });
    }, 350);
  }

  /* ---------- model access ---------- */

  function tpl() {
    var id = state.currentId;
    return state.doc.templates.filter(function (t) { return t.id === id; })[0] || null;
  }
  function sel() {
    var t = tpl();
    if (!t) return null;
    return t.elements.filter(function (e) { return e.id === state.selectedId; })[0] || null;
  }
  function grid() { return state.doc.grid; }
  function isLine(el) { return el && el.type === 'line'; }
  // Bounding box in inches for any element (lines store two end points).
  function boxOf(el) { return isLine(el) ? R.lineBox(el) : { x: el.x, y: el.y, w: el.w, h: el.h }; }

  // Move an element by (dx, dy) inches, keeping all of it on the page.
  function moveBy(el, dx, dy) {
    var b = boxOf(el);
    var nx = clamp(b.x + dx, 0, PAGE_W - b.w), ny = clamp(b.y + dy, 0, PAGE_H - b.h);
    dx = nx - b.x; dy = ny - b.y;
    if (isLine(el)) {
      el.x1 = round3(el.x1 + dx); el.x2 = round3(el.x2 + dx);
      el.y1 = round3(el.y1 + dy); el.y2 = round3(el.y2 + dy);
    } else {
      el.x = round3(el.x + dx); el.y = round3(el.y + dy);
    }
  }
  function snapV(v) {
    var g = grid();
    return g.snap ? round3(Math.round(v / g.size) * g.size) : round3(v);
  }

  function normalizeDoc(d) {
    d = d || {};
    d.schema = 'cloudslides.deck';
    d.version = 1;
    d.name = d.name || 'Untitled deck';
    d.grid = Object.assign({ size: 0.25, snap: true, show: true }, d.grid || {});
    d.templates = (d.templates || []).map(function (t) {
      t.id = t.id || T.uid('t');
      t.name = t.name || 'Untitled slide';
      t.background = t.background || '#ffffff';
      t.repeat = Object.assign({ mode: 'none', perSlide: 0, zone: '', tag: '' }, t.repeat || {});
      t.elements = (t.elements || []).map(function (e) {
        e.id = e.id || T.uid('e');
        if (e.type === 'image') e.bind = Object.assign({ kind: 'none', index: 0, zone: '', tag: '' }, e.bind || {});
        return e;
      });
      return t;
    });
    d.fields = (Array.isArray(d.fields) ? d.fields : []).filter(function (f) { return f && f.key; }).map(function (f) {
      return { key: String(f.key), label: String(f.label || f.key) };
    });
    var ids = d.templates.map(function (t) { return t.id; });
    d.deck = (d.deck || []).filter(function (e) { return ids.indexOf(e.templateId) >= 0; }).map(function (e) {
      return { id: e.id || T.uid('d'), templateId: e.templateId };
    });
    return d;
  }

  /* ---------- history ---------- */

  function pushHistory(key) {
    var now = Date.now();
    if (key && key === history.lastKey && now - history.lastTime < 1200) { history.lastTime = now; return; }
    history.undo.push(JSON.stringify(state.doc));
    if (history.undo.length > 100) history.undo.shift();
    history.redo = [];
    history.lastKey = key || null;
    history.lastTime = now;
  }
  function restore(json) {
    state.doc = normalizeDoc(JSON.parse(json));
    history.lastKey = null;
    if (!tpl()) state.currentId = state.doc.templates[0] ? state.doc.templates[0].id : null;
    if (!sel()) state.selectedId = null;
    renderAll();
    save();
  }
  function undo() {
    if (!history.undo.length) return toast('Nothing to undo');
    history.redo.push(JSON.stringify(state.doc));
    restore(history.undo.pop());
  }
  function redo() {
    if (!history.redo.length) return toast('Nothing to redo');
    history.undo.push(JSON.stringify(state.doc));
    restore(history.redo.pop());
  }

  // Every edit goes through change(): snapshot for undo, apply, save, redraw.
  function change(fn, opts) {
    opts = opts || {};
    pushHistory(opts.key);
    fn();
    save();
    if (opts.stage !== false) renderStage();
    if (opts.inspector !== false) renderInspector();
    if (opts.lists !== false) renderListsSoon();
  }

  /* ---------- context / expansion ---------- */

  function expanded() { return R.expandDeck(state.doc, state.project); }

  function previewCtx(t) {
    var all = expanded();
    var hit = all.filter(function (s) { return s.entryId === state.deckEntryId && s.template.id === t.id; })[0] ||
      all.filter(function (s) { return s.template.id === t.id; })[0];
    if (hit) return hit.ctx;
    return R.expandDeck({ templates: [t], deck: [{ id: 'x', templateId: t.id }] }, state.project)[0].ctx;
  }

  function renderMode() { return state.project ? 'final' : 'preview'; }

  /* ---------- stage ---------- */

  var stage = $('#stage');
  var stageSize = $('#stageSize');
  var stageWrap = $('#stageWrap');
  var slideHost = $('#slideHost');
  var selLayer = $('#selLayer');
  var gridOverlay = $('#gridOverlay');

  function effectiveZoom() {
    if (state.zoom !== 'fit') return Number(state.zoom);
    var pad = window.innerWidth <= 900 ? 32 : 56;
    var w = stageWrap.clientWidth - pad;
    var hgt = stageWrap.clientHeight - pad;
    return Math.max(0.15, Math.min(w / (PAGE_W * DPI), hgt / (PAGE_H * DPI)));
  }

  function applyZoom() {
    var z = effectiveZoom();
    state.z = z;
    stage.style.transform = 'scale(' + z + ')';
    stageSize.style.width = (PAGE_W * DPI * z) + 'px';
    stageSize.style.height = (PAGE_H * DPI * z) + 'px';
    document.documentElement.style.setProperty('--z', z);
  }

  function renderStage() {
    var t = tpl();
    slideHost.innerHTML = '';
    if (!t) {
      slideHost.appendChild(h('div', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;color:#8e8e93;' }, 'Create a template slide to begin'));
    } else {
      slideHost.appendChild(R.renderSlide(t, previewCtx(t), { mode: 'edit', data: state.dataPreview }));
    }
    applyZoom();
    gridOverlay.hidden = !grid().show;
    gridOverlay.style.setProperty('--g', grid().size + 'in');
    renderSelection();
    renderStatus();
  }

  var HANDLES = [['nw', 0, 0], ['n', 50, 0], ['ne', 100, 0], ['e', 100, 50], ['se', 100, 100], ['s', 50, 100], ['sw', 0, 100], ['w', 0, 50]];

  function lineLength(el) { return Math.sqrt(Math.pow(el.x2 - el.x1, 2) + Math.pow(el.y2 - el.y1, 2)); }

  function renderLineSelection(el, showSize) {
    [['p1', el.x1, el.y1], ['p2', el.x2, el.y2]].forEach(function (p) {
      var n = h('div', { class: 'handle end', 'data-h': p[0], title: 'Drag to move this end (Shift = straight / 45°)' });
      n.style.left = p[1] + 'in';
      n.style.top = p[2] + 'in';
      selLayer.appendChild(n);
    });
    if (showSize) {
      var tip = h('div', { class: 'size-tip', text: fmtIn(lineLength(el)) + ' in' });
      tip.style.left = ((el.x1 + el.x2) / 2) + 'in';
      tip.style.top = Math.max(el.y1, el.y2) + 'in';
      selLayer.appendChild(tip);
    }
  }

  function renderSelection(showSize) {
    selLayer.innerHTML = '';
    var el = sel();
    if (!el) return;
    if (isLine(el)) return renderLineSelection(el, showSize);
    var box = h('div', { class: 'sel-box' });
    box.style.left = el.x + 'in';
    box.style.top = el.y + 'in';
    box.style.width = el.w + 'in';
    box.style.height = el.h + 'in';
    HANDLES.forEach(function (hd) {
      var n = h('div', { class: 'handle', 'data-h': hd[0] });
      n.style.left = hd[1] + '%';
      n.style.top = hd[2] + '%';
      box.appendChild(n);
    });
    if (showSize) {
      var tip = h('div', { class: 'size-tip', text: fmtIn(el.x) + ', ' + fmtIn(el.y) + '  ·  ' + fmtIn(el.w) + ' × ' + fmtIn(el.h) + ' in' });
      tip.style.left = '50%';
      tip.style.top = '100%';
      box.appendChild(tip);
    }
    selLayer.appendChild(box);
  }

  function fmtIn(v) { return String(round3(v)); }

  function updateNodeGeometry(el) {
    var node = slideHost.querySelector('[data-id="' + el.id + '"]');
    if (!node) return;
    if (isLine(el)) { node.replaceWith(R.renderElement(el, {}, { mode: 'edit' })); return; }
    node.style.left = el.x + 'in';
    node.style.top = el.y + 'in';
    node.style.width = el.w + 'in';
    node.style.height = el.h + 'in';
  }

  function select(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    renderSelection();
    renderInspector();
  }

  function resizeFrom(el, s, hd, dx, dy, keepRatio) {
    var min = Math.max(0.125, grid().snap ? grid().size : 0.125);
    var L = s.x, Tp = s.y, Rt = s.x + s.w, B = s.y + s.h;
    if (hd.indexOf('w') >= 0) L = clamp(snapV(s.x + dx), 0, Rt - min);
    if (hd.indexOf('e') >= 0) Rt = clamp(snapV(Rt + dx), L + min, PAGE_W);
    if (hd.indexOf('n') >= 0) Tp = clamp(snapV(s.y + dy), 0, B - min);
    if (hd.indexOf('s') >= 0) B = clamp(snapV(B + dy), Tp + min, PAGE_H);
    if (keepRatio && hd.length === 2) {
      var ratio = s.w / s.h;
      var w = Rt - L;
      var hh = w / ratio;
      var maxH = hd.indexOf('n') >= 0 ? B : PAGE_H - Tp;
      if (hh > maxH) { hh = maxH; w = hh * ratio; if (hd.indexOf('w') >= 0) L = Rt - w; else Rt = L + w; }
      if (hd.indexOf('n') >= 0) Tp = B - hh; else B = Tp + hh;
    }
    el.x = round3(L); el.y = round3(Tp); el.w = round3(Rt - L); el.h = round3(B - Tp);
  }

  function dragLineEnd(el, s, hd, dx, dy, constrain) {
    var mine = hd === 'p1' ? ['x1', 'y1'] : ['x2', 'y2'];
    var other = hd === 'p1' ? [s.x2, s.y2] : [s.x1, s.y1];
    var nx = clamp(snapV(s[mine[0]] + dx), 0, PAGE_W);
    var ny = clamp(snapV(s[mine[1]] + dy), 0, PAGE_H);
    if (constrain) {
      // Lock to 0°, 45° or 90° from the other end, keeping the end on the grid.
      var ddx = nx - other[0], ddy = ny - other[1];
      var oct = Math.round(Math.atan2(ddy, ddx) / (Math.PI / 4));
      if (oct % 4 === 0) ny = other[1];
      else if (Math.abs(oct) === 2) nx = other[0];
      else {
        var d = Math.min(snapV((Math.abs(ddx) + Math.abs(ddy)) / 2),
          ddx > 0 ? PAGE_W - other[0] : other[0], ddy > 0 ? PAGE_H - other[1] : other[1]);
        nx = other[0] + (ddx < 0 ? -d : d);
        ny = other[1] + (ddy < 0 ? -d : d);
      }
    }
    el[mine[0]] = round3(nx);
    el[mine[1]] = round3(ny);
  }

  function startDrag(e, kind, hd, opts) {
    var el = sel();
    if (!el) return;
    e.preventDefault();
    opts = opts || {};
    var start = { x: e.clientX, y: e.clientY, el: clone(el) };
    var moved = !!opts.created; // a freshly drawn line already has its undo point
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    function onMove(ev) {
      if (!moved && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 3) return;
      if (!moved) { pushHistory(); moved = true; }
      var dx = (ev.clientX - start.x) / (DPI * state.z);
      var dy = (ev.clientY - start.y) / (DPI * state.z);
      if (kind === 'move' && isLine(el)) {
        // Snap the first end to the grid; the other end keeps its offset.
        Object.assign(el, { x1: start.el.x1, y1: start.el.y1, x2: start.el.x2, y2: start.el.y2 });
        moveBy(el, snapV(start.el.x1 + dx) - start.el.x1, snapV(start.el.y1 + dy) - start.el.y1);
      } else if (kind === 'move') {
        el.x = round3(clamp(snapV(start.el.x + dx), 0, PAGE_W - el.w));
        el.y = round3(clamp(snapV(start.el.y + dy), 0, PAGE_H - el.h));
      } else if (hd === 'p1' || hd === 'p2') {
        dragLineEnd(el, start.el, hd, dx, dy, ev.shiftKey);
      } else {
        resizeFrom(el, start.el, hd, dx, dy, ev.shiftKey);
      }
      updateNodeGeometry(el);
      renderSelection(true);
    }
    function onUp() {
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
      if (opts.created && lineLength(el) < 0.1) {
        // A click without a drag drops a 3 in line starting at that point.
        el.x2 = round3(Math.min(PAGE_W, el.x1 + 3));
        if (el.x2 - el.x1 < 1) el.x1 = round3(el.x2 - 3);
        el.y2 = el.y1;
        updateNodeGeometry(el);
      }
      if (moved) {
        save();
        renderSelection();
        renderInspector();
        renderListsSoon();
      }
    }
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
  }

  stage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || !tpl()) return;
    if (e.target.closest('[contenteditable="true"],[contenteditable="plaintext-only"]')) return;
    if (state.tool === 'line') { beginLine(e); return; }
    var handle = e.target.closest('.handle');
    if (handle) { startDrag(e, 'resize', handle.getAttribute('data-h')); return; }
    var node = e.target.closest('#slideHost .cs-el');
    if (node && e.altKey) node = nodeBelow(e, node) || node;
    if (node) {
      select(node.getAttribute('data-id'));
      startDrag(e, 'move');
      return;
    }
    select(null);
  });

  // Alt/Option-click picks the next item down in the stack under the pointer,
  // so a box hidden behind text (or text behind a photo) can still be grabbed.
  function nodeBelow(e, top) {
    var stack = document.elementsFromPoint(e.clientX, e.clientY)
      .map(function (n) { return n.closest && n.closest('#slideHost .cs-el'); })
      .filter(function (n, i, a) { return n && a.indexOf(n) === i; });
    var cur = stack.indexOf(slideHost.querySelector('[data-id="' + state.selectedId + '"]'));
    if (cur < 0) return top;
    return stack[(cur + 1) % stack.length];
  }

  function setTool(tool) {
    state.tool = tool;
    stage.classList.toggle('drawing', tool === 'line');
    var b = $('[data-add="line"]');
    if (b) b.setAttribute('aria-pressed', tool === 'line' ? 'true' : 'false');
    if (tool === 'line') toast('Drag on the slide to draw a line · Shift keeps it straight');
  }

  function beginLine(e) {
    var t = tpl();
    var rect = stage.getBoundingClientRect();
    var px = clamp(snapV((e.clientX - rect.left) / (DPI * state.z)), 0, PAGE_W);
    var py = clamp(snapV((e.clientY - rect.top) / (DPI * state.z)), 0, PAGE_H);
    var el = T.makeElement('line', { x: px, y: py });
    el.x2 = px; el.y2 = py;
    pushHistory();
    t.elements.push(el);
    state.selectedId = el.id;
    setTool(null);
    renderStage();
    startDrag(e, 'resize', 'p2', { created: true });
  }

  // The stage captures the pointer while dragging, so click events report the
  // stage itself as their target; look up what is actually under the pointer.
  function nodeAt(e, selector) {
    var hits = document.elementsFromPoint(e.clientX, e.clientY);
    for (var i = 0; i < hits.length; i++) {
      var n = hits[i].closest && hits[i].closest('#slideHost .cs-el');
      if (n) return n.matches(selector) ? n : null; // topmost item only
    }
    return null;
  }

  stage.addEventListener('dblclick', function (e) {
    var imgNode = nodeAt(e, '.cs-image');
    if (imgNode) {
      var imgEl = tpl().elements.filter(function (x) { return x.id === imgNode.getAttribute('data-id'); })[0];
      // Uploaded-file boxes open the picker; photo/field slots fill from project data instead.
      if (imgEl && (!imgEl.bind || imgEl.bind.kind === 'none')) pickImageFor(imgEl);
      return;
    }
    var node = nodeAt(e, '.cs-text');
    if (!node) return;
    var t = tpl();
    var el = t.elements.filter(function (x) { return x.id === node.getAttribute('data-id'); })[0];
    if (!el) return;
    var tx = node.querySelector('.cs-tx');
    tx.textContent = el.text;
    tx.contentEditable = 'plaintext-only';
    if (tx.contentEditable !== 'plaintext-only') tx.contentEditable = 'true';
    tx.focus();
    var range = document.createRange();
    range.selectNodeContents(tx);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    selLayer.innerHTML = '';
    function finish() {
      tx.removeEventListener('blur', finish);
      var v = tx.innerText.replace(/\n$/, '');
      tx.contentEditable = 'false';
      if (v !== el.text) change(function () { el.text = v; });
      else renderStage();
    }
    tx.addEventListener('blur', finish);
    tx.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); tx.blur(); }
      ev.stopPropagation();
    });
  });

  // Drop JPG / PNG files straight onto the slide.
  stage.addEventListener('dragover', function (e) {
    if (!tpl() || !e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
    e.preventDefault();
    stage.classList.add('dropping');
  });
  stage.addEventListener('dragleave', function () { stage.classList.remove('dropping'); });
  stage.addEventListener('drop', function (e) {
    stage.classList.remove('dropping');
    if (!tpl()) return;
    var files = Array.prototype.filter.call(e.dataTransfer.files || [], isImageFile);
    if (!files.length) return;
    e.preventDefault();
    var onto = document.elementFromPoint(e.clientX, e.clientY);
    onto = onto && onto.closest('#slideHost .cs-image');
    if (onto && files.length === 1) {
      var target = tpl().elements.filter(function (x) { return x.id === onto.getAttribute('data-id'); })[0];
      if (target) { state.selectedId = target.id; setImageFile(target, files[0]); return; }
    }
    var rect = stage.getBoundingClientRect();
    var at = { x: (e.clientX - rect.left) / (DPI * state.z), y: (e.clientY - rect.top) / (DPI * state.z) };
    files.forEach(function (f, i) { addImageFromFile(f, { x: at.x + i * 0.25, y: at.y + i * 0.25 }); });
  });

  function isImageFile(f) { return /^image\/(png|jpeg)$/.test(f.type) || /\.(png|jpe?g)$/i.test(f.name); }

  function loadImageSize(src) {
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () { res({ w: im.naturalWidth, h: im.naturalHeight }); };
      im.onerror = function () { res(null); };
      im.src = src;
    });
  }

  function fitSize(nat, maxW, maxH) {
    if (!nat || !nat.w || !nat.h) return { w: 4, h: 3 };
    var w = maxW, hh = w * nat.h / nat.w;
    if (hh > maxH) { hh = maxH; w = hh * nat.w / nat.h; }
    return { w: round3(w), h: round3(hh) };
  }

  function addImageFromFile(file, at) {
    return X.readFile(file, true).then(function (src) {
      return loadImageSize(src).then(function (nat) {
        var t = tpl();
        var el = T.makeElement('image');
        var sz = fitSize(nat, 5, 5);
        el.w = sz.w; el.h = sz.h;
        el.x = round3(clamp(snapV(at.x - el.w / 2), 0, PAGE_W - el.w));
        el.y = round3(clamp(snapV(at.y - el.h / 2), 0, PAGE_H - el.h));
        el.src = src;
        el.alt = file.name;
        el.bind = { kind: 'none', index: 0, zone: '', tag: '' };
        change(function () { t.elements.push(el); state.selectedId = el.id; });
      });
    }).catch(function (e) { toast('Could not read image: ' + e.message); });
  }

  /* ---------- element operations ---------- */

  function addElement(kind) {
    var t = tpl();
    if (!t) return toast('Create a template first');
    if (kind === 'line') { setTool(state.tool === 'line' ? null : 'line'); return; }
    var el = T.makeElement(kind);
    if (kind === 'image') {
      el.bind.index = t.elements.filter(function (e) { return e.type === 'image' && e.bind && e.bind.kind === 'photo'; }).length;
    }
    var offset = (t.elements.length % 6) * grid().size;
    el.x = round3(clamp(snapV((PAGE_W - el.w) / 2 + offset), 0, PAGE_W - el.w));
    el.y = round3(clamp(snapV((PAGE_H - el.h) / 2 + offset), 0, PAGE_H - el.h));
    change(function () { t.elements.push(el); state.selectedId = el.id; });
  }

  function deleteElement() {
    var t = tpl(), el = sel();
    if (!el) return;
    change(function () {
      t.elements = t.elements.filter(function (e) { return e.id !== el.id; });
      state.selectedId = null;
    });
  }

  function pasteElement(src) {
    var t = tpl();
    if (!t || !src) return;
    var el = clone(src);
    el.id = T.uid('e');
    if (el.type === 'image' && el.bind && el.bind.kind === 'field') { el.bind.field = ''; el.bind.label = ''; } // each field is used once
    var g = grid().snap ? grid().size : 0.25;
    moveBy(el, g, g);
    change(function () { t.elements.push(el); state.selectedId = el.id; });
  }

  function reorder(where, target) {
    var t = tpl(), el = target || sel();
    if (!el) return;
    change(function () {
      var arr = t.elements;
      var i = arr.indexOf(el);
      arr.splice(i, 1);
      var j = { front: arr.length, back: 0, forward: Math.min(arr.length, i + 1), backward: Math.max(0, i - 1) }[where];
      arr.splice(j, 0, el);
    });
  }

  /* ---------- templates & deck ---------- */

  function openTemplate(id, entryId) {
    state.currentId = id;
    state.selectedId = null;
    state.deckEntryId = entryId || null;
    renderAll();
  }

  function addTemplate() {
    var t = T.newTemplate('Slide ' + (state.doc.templates.length + 1));
    change(function () {
      state.doc.templates.push(t);
      state.doc.deck.push({ id: T.uid('d'), templateId: t.id });
      state.currentId = t.id;
      state.selectedId = null;
    });
  }

  function duplicateTemplate(t) {
    var c = clone(t);
    c.id = T.uid('t');
    c.name = t.name + ' copy';
    c.elements.forEach(function (e) {
      e.id = T.uid('e');
      if (e.type === 'image' && e.bind && e.bind.kind === 'field') { e.bind.field = ''; e.bind.label = ''; } // each field is used once
    });
    change(function () {
      var i = state.doc.templates.indexOf(t);
      state.doc.templates.splice(i + 1, 0, c);
      state.doc.deck.push({ id: T.uid('d'), templateId: c.id });
      state.currentId = c.id;
      state.selectedId = null;
    });
  }

  function deleteTemplate(t) {
    var uses = state.doc.deck.filter(function (d) { return d.templateId === t.id; }).length;
    if (!confirm('Delete template "' + t.name + '"' + (uses ? ' and its ' + uses + ' place(s) in the deck' : '') + '?')) return;
    change(function () {
      var i = state.doc.templates.indexOf(t);
      state.doc.templates.splice(i, 1);
      state.doc.deck = state.doc.deck.filter(function (d) { return d.templateId !== t.id; });
      var next = state.doc.templates[Math.min(i, state.doc.templates.length - 1)];
      state.currentId = next ? next.id : null;
      state.selectedId = null;
    });
  }

  function addToDeck(t) {
    change(function () { state.doc.deck.push({ id: T.uid('d'), templateId: t.id }); }, { stage: false, inspector: false });
    toast('Added "' + t.name + '" to the deck');
  }

  function moveDeckEntry(from, to) {
    if (to < 0 || to >= state.doc.deck.length || from === to) return;
    change(function () {
      var arr = state.doc.deck;
      var item = arr.splice(from, 1)[0];
      arr.splice(to, 0, item);
    }, { stage: false, inspector: false });
  }

  /* ---------- lists (templates + deck) ---------- */

  var listTimer;
  function renderListsSoon() {
    clearTimeout(listTimer);
    listTimer = setTimeout(renderLists, 120);
  }

  function thumbFor(t, ctx) {
    var frame = h('div', { class: 'thumb-frame' });
    frame.appendChild(R.renderSlide(t, ctx, { mode: 'edit', data: state.dataPreview }));
    return frame;
  }

  function fitThumbs() {
    $all('.thumb-frame').forEach(function (f) {
      var s = f.firstChild;
      if (s) s.style.transform = 'scale(' + (f.clientWidth / (PAGE_W * DPI)) + ')';
    });
  }

  function repeatLabel(t) {
    var r = t.repeat || {};
    if (r.mode === 'perZone') return 'repeats per zone';
    if (r.mode === 'perPhoto') return 'repeats per photos';
    return '';
  }

  function renderLists() {
    var list = $('#templateList');
    list.innerHTML = '';
    var all = expanded();
    state.doc.templates.forEach(function (t) {
      var inDeck = state.doc.deck.filter(function (d) { return d.templateId === t.id; }).length;
      var hit = all.filter(function (s) { return s.template.id === t.id; })[0];
      var ctx = hit ? hit.ctx : R.expandDeck({ templates: [t], deck: [{ id: 'x', templateId: t.id }] }, state.project)[0].ctx;
      var rl = repeatLabel(t);
      list.appendChild(h('li', null,
        h('button', { type: 'button', class: 'thumb', 'aria-current': t.id === state.currentId ? 'true' : 'false', 'aria-label': 'Edit template ' + t.name, onclick: function () { openTemplate(t.id); } },
          thumbFor(t, ctx)),
        h('div', { class: 'thumb-meta' },
          h('span', { class: 'thumb-name', title: t.name, text: t.name }),
          rl ? h('span', { class: 'badge', text: '↻' , title: rl }) : null,
          h('span', { class: 'muted', title: 'Times used in the deck', text: inDeck ? '×' + inDeck : '' }),
          h('button', { type: 'button', class: 'icon-btn', title: 'Add to master deck', 'aria-label': 'Add ' + t.name + ' to deck', onclick: function () { addToDeck(t); } }, '＋')
        )
      ));
    });

    var dl = $('#deckList');
    dl.innerHTML = '';
    var byId = {};
    state.doc.templates.forEach(function (t) { byId[t.id] = t; });
    var dragFrom = null;
    state.doc.deck.forEach(function (entry, i) {
      var t = byId[entry.templateId];
      var n = all.filter(function (s) { return s.entryId === entry.id; }).length;
      var li = h('li', { class: (entry.id === state.deckEntryId || (!state.deckEntryId && t.id === state.currentId)) ? 'active' : '', draggable: 'true' },
        h('span', { class: 'num', text: String(i + 1) }),
        h('span', { class: 'name', title: t.name, text: t.name, onclick: function () { openTemplate(t.id, entry.id); } }),
        n > 1 ? h('span', { class: 'badge', title: 'Expands to ' + n + ' slides with this project', text: n + ' slides' }) : (repeatLabel(t) ? h('span', { class: 'badge', text: '↻' }) : null),
        h('button', { type: 'button', class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: function () { moveDeckEntry(i, i - 1); } }, '↑'),
        h('button', { type: 'button', class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', disabled: i === state.doc.deck.length - 1, onclick: function () { moveDeckEntry(i, i + 1); } }, '↓'),
        h('button', { type: 'button', class: 'icon-btn', title: 'Remove from deck', 'aria-label': 'Remove from deck', onclick: function () {
          change(function () { state.doc.deck.splice(i, 1); if (state.deckEntryId === entry.id) state.deckEntryId = null; }, { stage: false, inspector: false });
        } }, '✕')
      );
      li.addEventListener('dragstart', function (e) { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
      li.addEventListener('dragover', function (e) { if (dragFrom == null) return; e.preventDefault(); li.classList.add('drag-over'); });
      li.addEventListener('dragleave', function () { li.classList.remove('drag-over'); });
      li.addEventListener('drop', function (e) {
        e.preventDefault();
        li.classList.remove('drag-over');
        if (dragFrom != null) moveDeckEntry(dragFrom, i);
        dragFrom = null;
      });
      dl.appendChild(li);
    });
    if (!state.doc.deck.length) dl.appendChild(h('li', { class: 'muted' }, 'Deck is empty — use ＋ on a template.'));
    $('#deckCount').textContent = all.length + ' page' + (all.length === 1 ? '' : 's');
    requestAnimationFrame(fitThumbs);
    renderStatus();
  }

  /* ---------- inspector ---------- */

  var inspector = $('#inspector');

  function toHex6(v) {
    var s = String(v || '').trim();
    if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s.slice(1).split('').map(function (c) { return c + c; }).join('');
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    return '#ffffff';
  }

  // Simple color picker: native wheel + hex field + preset swatches (+ "none").
  function colorField(label, value, allowNone, set) {
    var isNone = !value || value === 'none';
    var inp = h('input', { type: 'color', value: isNone ? '#ffffff' : toHex6(value), 'aria-label': label });
    var sw = h('span', { class: 'swatch-input' + (isNone ? ' none' : '') }, inp);
    var hex = h('input', { class: 'hex', value: isNone ? 'none' : value, 'aria-label': label + ' hex value', spellcheck: 'false' });
    function apply(v) {
      sw.classList.toggle('none', v === 'none');
      if (v !== 'none') inp.value = toHex6(v);
      hex.value = v;
      set(v);
    }
    inp.addEventListener('input', function () { apply(inp.value); });
    hex.addEventListener('change', function () {
      var v = hex.value.trim().toLowerCase();
      if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/.test(v)) apply(toHex6(v.charAt(0) === '#' ? v : '#' + v));
      else if (allowNone && (v === 'none' || v === '' || v === 'transparent')) apply('none');
      else hex.value = isNone ? 'none' : inp.value;
    });
    var swatches = h('div', { class: 'swatches' });
    if (allowNone) swatches.appendChild(h('button', { type: 'button', class: 'sw none', title: 'None (transparent)', 'aria-label': 'No color', onclick: function () { apply('none'); } }));
    PRESETS.forEach(function (c) {
      var b = h('button', { type: 'button', class: 'sw', title: c.name + ' ' + c.hex, 'aria-label': c.name, onclick: function () { apply(c.hex); } });
      b.style.background = c.hex;
      swatches.appendChild(b);
    });
    return h('div', { class: 'color-field' },
      h('div', { class: 'color-top' }, h('span', { class: 'field-label', text: label }), sw, hex),
      swatches);
  }

  function row(label, control) {
    return h('div', { class: 'row' }, h('label', { text: label }), control);
  }

  function numInput(value, step, min, max, onSet, suffixTitle) {
    var inp = h('input', { type: 'number', value: String(value), step: String(step), min: min != null ? String(min) : null, max: max != null ? String(max) : null, title: suffixTitle || null });
    inp.addEventListener('change', function () {
      var v = parseFloat(inp.value);
      if (isNaN(v)) return;
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      onSet(v);
    });
    return inp;
  }

  function seg(options, current, onPick) {
    var wrap = h('div', { class: 'seg', role: 'group' });
    options.forEach(function (o) {
      wrap.appendChild(h('button', { type: 'button', 'aria-pressed': o[0] === current ? 'true' : 'false', title: o[2] || o[1], onclick: function () { onPick(o[0]); } }, o[1]));
    });
    return wrap;
  }

  function selectInput(options, current, onSet) {
    var s = h('select', null);
    options.forEach(function (o) {
      s.appendChild(h('option', { value: String(o[0]), selected: String(o[0]) === String(current) }, o[1]));
    });
    s.addEventListener('change', function () { onSet(s.value); });
    return s;
  }

  function setProp(el, key, v, opts) {
    change(function () { el[key] = v; }, Object.assign({ key: key + ':' + el.id, inspector: false }, opts || {}));
  }

  function renderInspector() {
    inspector.innerHTML = '';
    var t = tpl();
    var wrap = h('div', { class: 'insp' });
    inspector.appendChild(wrap);
    if (!t) {
      wrap.appendChild(h('h2', { text: 'Getting started' }));
      wrap.appendChild(h('p', { class: 'note', text: 'Create a template slide with “+ New”, then add text, boxes and photo slots.' }));
      return;
    }
    var el = sel();
    if (el) {
      renderElementInspector(wrap, t, el);
      renderLayers(wrap, t);
    } else {
      renderTemplateInspector(wrap, t);
    }
  }

  function layerLabel(el) {
    if (el.type === 'text') {
      var txt = String(el.text || '').replace(/\s+/g, ' ').trim();
      return txt ? (txt.length > 26 ? txt.slice(0, 25) + '…' : txt) : 'Empty text';
    }
    if (el.type === 'image' && el.bind && el.bind.kind === 'field') return 'Field: ' + (el.bind.label || el.bind.field || 'not set');
    if (el.type === 'image') return el.bind && el.bind.kind === 'photo' ? 'Photo #' + ((Number(el.bind.index) || 0) + 1) + (el.bind.zone ? ' · ' + el.bind.zone : '') : (el.alt || 'Image');
    return elementTitle(el);
  }

  var LAYER_ICON = { text: 'T', image: '▣', line: '╱', chart: '▮' };

  // Stack of items on this slide, front-most first (like PowerPoint's Selection Pane).
  function renderLayers(wrap, t) {
    wrap.appendChild(h('h2', { text: 'Layers' }));
    if (!t.elements.length) {
      wrap.appendChild(h('p', { class: 'note', text: 'Nothing on this slide yet.' }));
      return;
    }
    var list = h('ol', { class: 'layers', 'aria-label': 'Layers, front to back' });
    var n = t.elements.length;
    t.elements.slice().reverse().forEach(function (el, i) {
      var swatch = h('span', { class: 'layer-icon', 'aria-hidden': 'true', text: LAYER_ICON[el.type] || '' });
      if (el.type === 'shape') {
        swatch.style.background = el.fill && el.fill !== 'none' ? el.fill : '#fff';
        swatch.style.borderRadius = (Number(el.radius) || 0) > 0 ? '4px' : '0';
      }
      list.appendChild(h('li', { class: el.id === state.selectedId ? 'active' : '' },
        h('button', { type: 'button', class: 'layer-name', title: 'Select', onclick: function () { select(el.id); } }, swatch, h('span', { class: 'layer-text', text: layerLabel(el) })),
        h('button', { type: 'button', class: 'icon-btn', title: 'Bring forward', 'aria-label': 'Bring ' + layerLabel(el) + ' forward', disabled: i === 0, onclick: function () { reorder('forward', el); } }, '↑'),
        h('button', { type: 'button', class: 'icon-btn', title: 'Send backward', 'aria-label': 'Send ' + layerLabel(el) + ' backward', disabled: i === n - 1, onclick: function () { reorder('backward', el); } }, '↓')
      ));
    });
    wrap.appendChild(list);
    wrap.appendChild(h('p', { class: 'note', text: 'Top of the list is in front. To put text on a box or photo, keep the text above it. Alt/Option-click on the slide picks the item underneath.' }));
  }

  function renderTemplateInspector(wrap, t) {
    wrap.appendChild(h('h2', { text: 'Template slide' }));
    var name = h('input', { type: 'text', value: t.name, 'aria-label': 'Template name' });
    name.addEventListener('input', function () { change(function () { t.name = name.value; }, { key: 'tname:' + t.id, stage: false, inspector: false }); });
    wrap.appendChild(row('Name', name));
    wrap.appendChild(colorField('Background', t.background, false, function (v) {
      change(function () { t.background = v; }, { key: 'bg:' + t.id, inspector: false });
    }));

    wrap.appendChild(h('h2', { text: 'Repeat with project data' }));
    var r = t.repeat;
    wrap.appendChild(row('Make', selectInput([
      ['none', 'One slide'],
      ['perPhoto', 'One slide per group of photos'],
      ['perZone', 'One slide per photo zone']
    ], r.mode, function (v) { change(function () { r.mode = v; }); })));
    if (r.mode !== 'none') {
      var slots = R.countPhotoSlots(t);
      wrap.appendChild(row('Photos/slide', numInput(r.perSlide || slots || 1, 1, 1, 48, function (v) {
        change(function () { r.perSlide = Math.round(v); });
      }, 'Photos placed on each repeated slide')));
      var zones = projectValues('zone');
      wrap.appendChild(row('Only zone', selectInput([['', 'Any zone']].concat(zones.map(function (z) { return [z, z]; })).concat(r.zone && zones.indexOf(r.zone) < 0 ? [[r.zone, r.zone]] : []), r.zone, function (v) {
        change(function () { r.zone = v; });
      })));
      var tagIn = h('input', { type: 'text', value: r.tag || '', placeholder: 'Any tag' });
      tagIn.addEventListener('change', function () { change(function () { r.tag = tagIn.value.trim(); }); });
      wrap.appendChild(row('Only tag', tagIn));
      var n = expanded().filter(function (s) { return s.template.id === t.id; }).length;
      wrap.appendChild(h('p', { class: 'note', text: 'Photo slots on this slide count from 1 within each repeated page. ' +
        (state.project ? 'With “' + state.project.title + '” each use in the deck makes ' + (n / Math.max(1, state.doc.deck.filter(function (d) { return d.templateId === t.id; }).length) || 0) + ' slide(s).' : 'Load a project to see how many slides it makes.') +
        ' Use {{zone}}, {{part}} and {{parts}} in text.' }));
    } else {
      wrap.appendChild(h('p', { class: 'note', text: 'Photo slots use the project’s photos in order (slot 1 = first photo). Switch to a repeat mode to make one slide per zone or per group of photos.' }));
    }

    wrap.appendChild(h('h2', { text: 'Deck' }));
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn sm', onclick: function () { addToDeck(t); } }, 'Add to deck'),
      h('button', { type: 'button', class: 'btn sm', onclick: function () { duplicateTemplate(t); } }, 'Duplicate'),
      h('button', { type: 'button', class: 'btn sm danger', onclick: function () { deleteTemplate(t); } }, 'Delete')
    ));

    renderLayers(wrap, t);
    wrap.appendChild(h('h2', { text: 'Page' }));
    wrap.appendChild(h('p', { class: 'note', text: 'US Letter landscape, 11 × 8.5 in. Every slide prints on exactly one page. Items can’t be dragged off the page.' }));
    wrap.appendChild(h('h2', { text: 'Shortcuts' }));
    wrap.appendChild(h('p', { class: 'note', text: 'T text · B box · R rounded · L line (drag to draw) · G bar chart · I image · Ctrl/⌘ ] / [ bring forward / send backward (Shift = all the way) · Alt/Option-click selects the item underneath · arrows nudge (Shift ×4) · Delete remove · Ctrl/⌘ D duplicate · Ctrl/⌘ C / V copy/paste · Ctrl/⌘ Z undo · Shift-drag a corner keeps proportions · double-click text to edit.' }));
  }

  function projectValues(key) {
    var out = [];
    ((state.project && state.project.photos) || []).forEach(function (p) {
      if (p[key] && out.indexOf(p[key]) < 0) out.push(p[key]);
    });
    return out;
  }

  function elementTitle(el) {
    if (el.type === 'text') return 'Text box';
    if (el.type === 'line') return el.capEnd === 'arrow' || el.capStart === 'arrow' ? 'Arrow' : 'Line';
    if (el.type === 'chart') return 'Bar chart';
    if (el.type === 'image') return el.bind && el.bind.kind === 'photo' ? 'Photo slot' : (el.bind && el.bind.kind === 'field' ? 'Photo field' : 'Image');
    return (Number(el.radius) || 0) > 0 ? 'Rounded box' : 'Square box';
  }

  function renderElementInspector(wrap, t, el) {
    wrap.appendChild(h('h2', { text: elementTitle(el) }));

    // Position and size, in inches.
    var g = grid().snap ? grid().size : 0.01;
    var xywh = h('div', { class: 'xywh' });
    var geomFields = isLine(el)
      ? [['X1', 'x1', PAGE_W], ['Y1', 'y1', PAGE_H], ['X2', 'x2', PAGE_W], ['Y2', 'y2', PAGE_H]]
      : [['X', 'x', PAGE_W], ['Y', 'y', PAGE_H], ['W', 'w', PAGE_W], ['H', 'h', PAGE_H]];
    geomFields.forEach(function (f) {
      if (isLine(el)) {
        var li = numInput(el[f[1]], g, 0, f[2], function (v) { change(function () { el[f[1]] = round3(clamp(v, 0, f[2])); }, { key: 'geom:' + el.id }); }, 'inches');
        li.setAttribute('aria-label', f[0] + ' in inches');
        xywh.appendChild(h('label', null, f[0], li));
        return;
      }
      var inp = numInput(el[f[1]], g, 0, f[2], function (v) {
        change(function () {
          el[f[1]] = round3(v);
          el.w = clamp(el.w, 0.125, PAGE_W);
          el.h = clamp(el.h, 0.125, PAGE_H);
          el.x = round3(clamp(el.x, 0, PAGE_W - el.w));
          el.y = round3(clamp(el.y, 0, PAGE_H - el.h));
        }, { key: 'geom:' + el.id });
      }, 'inches');
      inp.setAttribute('aria-label', f[0] + ' in inches');
      xywh.appendChild(h('label', null, f[0], inp));
    });
    wrap.appendChild(xywh);
    if (isLine(el)) wrap.appendChild(h('p', { class: 'note', text: 'Length ' + fmtIn(lineLength(el)) + ' in. Drag an end to reshape; hold Shift for straight or 45° lines.' }));
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn sm', title: 'Center horizontally on the page', onclick: function () { change(function () { var b = boxOf(el); moveBy(el, (PAGE_W - b.w) / 2 - b.x, 0); }); } }, 'Center ↔'),
      h('button', { type: 'button', class: 'btn sm', title: 'Center vertically on the page', onclick: function () { change(function () { var b = boxOf(el); moveBy(el, 0, (PAGE_H - b.h) / 2 - b.y); }); } }, 'Center ↕'),
      isLine(el) ? null : h('button', { type: 'button', class: 'btn sm', title: 'Fill the whole page', onclick: function () { change(function () { el.x = 0; el.y = 0; el.w = PAGE_W; el.h = PAGE_H; }); } }, 'Full page')
    ));
    wrap.appendChild(h('h2', { text: 'Layer order' }));
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn sm', title: 'Ctrl/⌘ Shift ]', onclick: function () { reorder('front'); } }, 'Bring to front'),
      h('button', { type: 'button', class: 'btn sm', title: 'Ctrl/⌘ ]', onclick: function () { reorder('forward'); } }, 'Forward'),
      h('button', { type: 'button', class: 'btn sm', title: 'Ctrl/⌘ [', onclick: function () { reorder('backward'); } }, 'Backward'),
      h('button', { type: 'button', class: 'btn sm', title: 'Ctrl/⌘ Shift [', onclick: function () { reorder('back'); } }, 'Send to back')
    ));
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn sm', onclick: function () { pasteElement(el); } }, 'Duplicate'),
      h('button', { type: 'button', class: 'btn sm danger', onclick: deleteElement }, 'Delete')
    ));

    if (el.type === 'text') textInspector(wrap, el);
    if (el.type === 'image') imageInspector(wrap, el);
    if (isLine(el)) { lineInspector(wrap, el); return; }
    if (el.type === 'chart') chartInspector(wrap, el);

    wrap.appendChild(h('h2', { text: el.type === 'shape' ? 'Box' : 'Box style' }));
    wrap.appendChild(row('Corners', seg([['square', 'Square'], ['round', 'Rounded']], (Number(el.radius) || 0) > 0 ? 'round' : 'square', function (v) {
      change(function () { el.radius = v === 'round' ? (el.radius > 0 ? el.radius : T.ROUND_RADIUS) : 0; });
    })));
    if ((Number(el.radius) || 0) > 0) {
      wrap.appendChild(row('Radius', numInput(el.radius, 1, 1, 400, function (v) { setProp(el, 'radius', Math.round(v), { inspector: true }); }, 'Corner radius in px (1/96 in)')));
    }
    wrap.appendChild(colorField(el.type === 'image' ? 'Backdrop' : 'Fill', el.fill, true, function (v) { setProp(el, 'fill', v); }));
    wrap.appendChild(colorField('Border', el.stroke, true, function (v) {
      change(function () {
        el.stroke = v;
        if (v !== 'none' && !(el.strokeWidth > 0)) el.strokeWidth = 1;
      }, { key: 'stroke:' + el.id, inspector: false });
    }));
    wrap.appendChild(row('Border pt', numInput(el.strokeWidth || 0, 0.5, 0, 24, function (v) { setProp(el, 'strokeWidth', v); })));
    var op = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(el.opacity == null ? 1 : el.opacity), 'aria-label': 'Opacity' });
    op.addEventListener('input', function () { setProp(el, 'opacity', parseFloat(op.value)); });
    wrap.appendChild(row('Opacity', op));
  }

  function chartInspector(wrap, el) {
    wrap.appendChild(h('h2', { text: 'Bars' }));
    // Suggest {{field}} tokens in the value boxes so bars can come from project data.
    var dl = h('datalist', { id: 'cs-field-tokens' });
    D.fieldPaths(state.project).forEach(function (f) { dl.appendChild(h('option', { value: '{{' + f + '}}' })); });
    wrap.appendChild(dl);
    var table = h('div', { class: 'bars' },
      h('div', { class: 'bars-head' }, h('span', { text: 'Label' }), h('span', { text: 'Value' }), h('span')));
    el.bars.forEach(function (b, i) {
      var lab = h('input', { type: 'text', value: b.label, 'aria-label': 'Bar ' + (i + 1) + ' label' });
      lab.addEventListener('input', function () { change(function () { b.label = lab.value; }, { key: 'bars:' + el.id, inspector: false }); });
      var val = h('input', { type: 'text', value: String(b.value), list: 'cs-field-tokens', inputmode: 'decimal', placeholder: '0 or {{field}}', 'aria-label': 'Bar ' + (i + 1) + ' value' });
      val.addEventListener('input', function () { change(function () { b.value = val.value; }, { key: 'bars:' + el.id, inspector: false }); });
      table.appendChild(h('div', { class: 'bars-row' }, lab, val,
        h('button', { type: 'button', class: 'icon-btn', title: 'Remove bar', 'aria-label': 'Remove bar ' + (i + 1), disabled: el.bars.length <= 1, onclick: function () {
          change(function () { el.bars.splice(i, 1); });
        } }, '✕')));
    });
    wrap.appendChild(table);
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn sm', disabled: el.bars.length >= 24, onclick: function () {
        change(function () { el.bars.push({ label: 'Item ' + String.fromCharCode(65 + el.bars.length % 26), value: '50' }); });
      } }, '+ Add bar')));
    wrap.appendChild(h('p', { class: 'note', text: 'Values can be numbers or project fields such as {{payload.blower_door_cfm50}}. Symbols like $ and commas are ignored.' }));

    wrap.appendChild(h('h2', { text: 'Chart style' }));
    wrap.appendChild(colorField('Bar color', el.barColor || '#2f7d45', false, function (v) { setProp(el, 'barColor', v); }));
    wrap.appendChild(colorField('Text color', el.color || '#4a4a4a', false, function (v) { setProp(el, 'color', v); }));
    wrap.appendChild(row('Text pt', numInput(el.fontSize || 10, 1, 6, 36, function (v) { setProp(el, 'fontSize', v); })));
    var pre = h('input', { type: 'text', value: el.prefix || '', placeholder: 'e.g. $' });
    pre.addEventListener('input', function () { setProp(el, 'prefix', pre.value); });
    wrap.appendChild(row('Prefix', pre));
    var suf = h('input', { type: 'text', value: el.suffix || '', placeholder: 'e.g. % or CFM' });
    suf.addEventListener('input', function () { setProp(el, 'suffix', suf.value); });
    wrap.appendChild(row('Suffix', suf));
    wrap.appendChild(row('Decimals', numInput(el.decimals || 0, 1, 0, 4, function (v) { setProp(el, 'decimals', Math.round(v)); })));
    [['showValues', 'Values on bars'], ['showGrid', 'Gridlines'], ['showAxis', 'Value axis']].forEach(function (o) {
      var cb = h('input', { type: 'checkbox', checked: el[o[0]] !== false });
      cb.addEventListener('change', function () { change(function () { el[o[0]] = cb.checked; }, { inspector: false }); });
      wrap.appendChild(h('label', { class: 'check-row' }, cb, ' ' + o[1]));
    });
  }

  function lineInspector(wrap, el) {
    wrap.appendChild(h('h2', { text: 'Line style' }));
    wrap.appendChild(colorField('Color', el.stroke || '#1d1d1f', false, function (v) { setProp(el, 'stroke', v); }));
    wrap.appendChild(row('Weight pt', numInput(el.strokeWidth || 1, 0.5, 0.25, 36, function (v) { setProp(el, 'strokeWidth', v); })));
    wrap.appendChild(row('Style', seg([['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']], el.dash || 'solid', function (v) { change(function () { el.dash = v; }); })));
    var ends = el.capStart === 'arrow' ? 'both' : (el.capEnd === 'arrow' ? 'end' : 'none');
    wrap.appendChild(row('Arrows', seg([['none', 'None'], ['end', '→', 'Arrow at end'], ['both', '↔', 'Arrows at both ends']], ends, function (v) {
      change(function () { el.capEnd = v === 'none' ? 'none' : 'arrow'; el.capStart = v === 'both' ? 'arrow' : 'none'; });
    })));
    var op = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(el.opacity == null ? 1 : el.opacity), 'aria-label': 'Opacity' });
    op.addEventListener('input', function () { setProp(el, 'opacity', parseFloat(op.value)); });
    wrap.appendChild(row('Opacity', op));
  }

  function fieldOptions() {
    return D.fieldPaths(state.project).map(function (p) { return [p, p]; });
  }

  function textInspector(wrap, el) {
    wrap.appendChild(h('h2', { text: 'Text' }));
    var ta = h('textarea', { 'aria-label': 'Text content', spellcheck: 'true' });
    ta.value = el.text || '';
    ta.addEventListener('input', function () { change(function () { el.text = ta.value; }, { key: 'text:' + el.id, inspector: false }); });
    wrap.appendChild(ta);
    var ins = selectInput([['', 'Insert project field…']].concat(fieldOptions()), '', function (v) {
      if (!v) return;
      var token = '{{' + v + '}}';
      var s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
      var e2 = ta.selectionEnd != null ? ta.selectionEnd : s;
      ta.value = ta.value.slice(0, s) + token + ta.value.slice(e2);
      change(function () { el.text = ta.value; }, { key: 'text:' + el.id, inspector: false });
      ins.value = '';
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + token.length;
    });
    wrap.appendChild(h('div', { class: 'row', style: 'margin-top:6px' }, ins));
    wrap.appendChild(row('Size pt', numInput(el.fontSize || 18, 1, 4, 400, function (v) { setProp(el, 'fontSize', v); })));
    wrap.appendChild(row('Weight', selectInput([[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Heavy']], el.fontWeight || 400, function (v) { setProp(el, 'fontWeight', Number(v)); })));
    wrap.appendChild(row('Style', seg([[false, 'Normal'], [true, 'Italic']], !!el.italic, function (v) { change(function () { el.italic = v; }); })));
    wrap.appendChild(row('Align', seg([['left', '⟸', 'Left'], ['center', '≡', 'Center'], ['right', '⟹', 'Right'], ['justify', '☰', 'Justify']], el.align || 'left', function (v) { change(function () { el.align = v; }); })));
    wrap.appendChild(row('Vertical', seg([['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], el.vAlign || 'top', function (v) { change(function () { el.vAlign = v; }); })));
    wrap.appendChild(row('Line height', numInput(el.lineHeight || 1.25, 0.05, 0.8, 3, function (v) { setProp(el, 'lineHeight', v); })));
    wrap.appendChild(row('Tracking em', numInput(el.letterSpacing || 0, 0.01, -0.1, 0.5, function (v) { setProp(el, 'letterSpacing', v); })));
    wrap.appendChild(colorField('Text color', el.color || '#1d1d1f', false, function (v) { setProp(el, 'color', v); }));
  }

  /* ---------- photo fields (imported list, each used once) ---------- */

  function humanize(key) {
    var s = String(key).replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Which image slot (if any) already uses each field, across the whole deck.
  function fieldUsage() {
    var used = {};
    state.doc.templates.forEach(function (t) {
      t.elements.forEach(function (e) {
        if (e.type === 'image' && e.bind && e.bind.kind === 'field' && e.bind.field) {
          used[R.fieldKey(e.bind.field)] = { el: e, template: t };
        }
      });
    });
    return used;
  }

  function fieldPicker(wrap, el) {
    var b = el.bind;
    var fields = state.doc.fields;
    var used = fieldUsage();
    var s = h('select', { 'aria-label': 'Photo field' });
    s.appendChild(h('option', { value: '' }, fields.length ? 'Choose a photo field…' : 'No fields yet — import a list'));
    var free = 0;
    fields.forEach(function (f) {
      var u = used[R.fieldKey(f.key)];
      var mine = u && u.el === el;
      var taken = u && !mine;
      if (!taken) free++;
      s.appendChild(h('option', { value: f.key, disabled: taken, selected: mine },
        f.label + (taken ? ' — used on ' + u.template.name : '')));
    });
    // A field that was bound before the list changed stays visible.
    if (b.field && !fields.some(function (f) { return R.fieldKey(f.key) === R.fieldKey(b.field); })) {
      s.appendChild(h('option', { value: b.field, selected: true }, (b.label || b.field) + ' (not in list)'));
    }
    s.addEventListener('change', function () {
      var f = fields.filter(function (x) { return x.key === s.value; })[0];
      change(function () { b.field = s.value; b.label = f ? f.label : ''; });
    });
    wrap.appendChild(row('Field', s));
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn sm', onclick: openFields }, fields.length ? 'Manage fields…' : 'Import field list…')));
    wrap.appendChild(h('p', { class: 'note', text: fields.length
      ? free + ' of ' + fields.length + ' fields still available. A field used on another slot is greyed out. It fills from a URL in the project data with that name, or the project photo whose label, tag or zone matches it.'
      : 'Import the list of photo fields your field app fills in. Each field can be used once in the deck.' }));
  }

  function parseFieldList(text, filename) {
    var t = String(text || '').replace(/^\uFEFF/, '').trim();
    var items = [];
    if (!t) return items;
    if (/\.json$/i.test(filename || '') || /^[\[{]/.test(t)) {
      var j = JSON.parse(t);
      if (!Array.isArray(j)) j = j.fields || j.photoFields || j.photo_fields || Object.keys(j);
      items = j.map(function (x) {
        return typeof x === 'string' ? { key: x } : { key: x.key || x.field || x.name || x.id, label: x.label || x.title || x.name };
      });
    } else {
      t.split(/\r?\n/).forEach(function (line) {
        if (!line.trim()) return;
        var cols = line.split(line.indexOf('\t') >= 0 ? '\t' : ',').map(function (c) { return c.trim().replace(/^"(.*)"$/, '$1').trim(); });
        items.push({ key: cols[0], label: cols[1] });
      });
      if (items.length && /^(key|field|fields|name|field ?name|field_name)$/i.test(items[0].key)) items.shift();
    }
    var seen = {};
    return items.filter(function (x) {
      x.key = String(x.key == null ? '' : x.key).trim();
      if (!x.key || seen[R.fieldKey(x.key)] || !R.fieldKey(x.key)) return false;
      seen[R.fieldKey(x.key)] = true;
      x.label = String(x.label || '').trim() || humanize(x.key);
      return true;
    }).map(function (x) { return { key: x.key, label: x.label }; });
  }

  var fieldsDialog = $('#fieldsDialog');

  function fieldsError(m) { $('#fieldsError').textContent = m || ''; }

  function renderFields() {
    var list = $('#fieldsList');
    var used = fieldUsage();
    list.innerHTML = '';
    var fields = state.doc.fields;
    $('#fieldsCount').textContent = fields.length + ' field' + (fields.length === 1 ? '' : 's') + ' · ' +
      fields.filter(function (f) { return !used[R.fieldKey(f.key)]; }).length + ' available';
    if (!fields.length) list.appendChild(h('li', { class: 'muted' }, 'No fields yet. Paste a list above or upload a file.'));
    fields.forEach(function (f, i) {
      var u = used[R.fieldKey(f.key)];
      list.appendChild(h('li', null,
        h('div', { class: 'lib-meta' }, h('b', { text: f.label }), h('small', { text: f.key })),
        h('span', { class: 'field-used' + (u ? '' : ' free'), text: u ? 'Used on ' + u.template.name : 'Available' }),
        h('button', { type: 'button', class: 'icon-btn', title: 'Remove from list', 'aria-label': 'Remove ' + f.label, onclick: function () {
          change(function () { state.doc.fields.splice(i, 1); });
          renderFields();
        } }, '✕')));
    });
  }

  function openFields() {
    fieldsError('');
    renderFields();
    fieldsDialog.showModal();
  }

  function importFields(text, filename, replace) {
    fieldsError('');
    var items;
    try { items = parseFieldList(text, filename); } catch (e) { fieldsError('Could not read that list: ' + e.message); return; }
    if (!items.length) { fieldsError('No field names found.'); return; }
    var added = 0;
    change(function () {
      if (replace) state.doc.fields = [];
      items.forEach(function (it) {
        if (!state.doc.fields.some(function (f) { return R.fieldKey(f.key) === R.fieldKey(it.key); })) {
          state.doc.fields.push(it);
          added++;
        }
      });
    });
    $('#fieldsPaste').value = '';
    renderFields();
    toast((replace ? 'List replaced: ' : 'Added ') + added + ' field' + (added === 1 ? '' : 's'));
  }

  $('#fieldsAdd').addEventListener('click', function () { importFields($('#fieldsPaste').value, '', false); });
  $('#fieldsReplace').addEventListener('click', function () {
    if (state.doc.fields.length && !confirm('Replace all ' + state.doc.fields.length + ' fields with the pasted list?')) return;
    importFields($('#fieldsPaste').value, '', true);
  });
  $('#fieldsUpload').addEventListener('click', function () { $('#fileFields').value = ''; $('#fileFields').click(); });
  $('#fileFields').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    X.readFile(f).then(function (txt) { importFields(txt, f.name, false); });
  });
  fieldsDialog.addEventListener('close', function () { renderInspector(); });

  function imageInspector(wrap, el) {
    wrap.appendChild(h('h2', { text: 'Image source' }));
    var b = el.bind;
    wrap.appendChild(row('Source', seg([['photo', 'Project photo'], ['none', 'File'], ['field', 'Field']], b.kind === 'none' ? 'none' : b.kind, function (v) {
      change(function () { b.kind = v; });
      // Choosing "File" on an empty box goes straight to the file picker.
      if (v === 'none' && !el.src) pickImageFor(el);
    })));
    if (b.kind === 'photo') {
      wrap.appendChild(row('Photo #', numInput((Number(b.index) || 0) + 1, 1, 1, 999, function (v) { change(function () { b.index = Math.round(v) - 1; }); })));
      var zones = projectValues('zone');
      wrap.appendChild(row('Zone', selectInput([['', 'Any zone']].concat(zones.map(function (z) { return [z, z]; })).concat(b.zone && zones.indexOf(b.zone) < 0 ? [[b.zone, b.zone]] : []), b.zone || '', function (v) {
        change(function () { b.zone = v; });
      })));
      var tagIn = h('input', { type: 'text', value: b.tag || '', placeholder: 'Any tag' });
      tagIn.addEventListener('change', function () { change(function () { b.tag = tagIn.value.trim(); }); });
      wrap.appendChild(row('Tag', tagIn));
      wrap.appendChild(h('p', { class: 'note', text: tpl().repeat.mode !== 'none'
        ? 'This slide repeats, so photo # counts within each repeated page.'
        : 'Photo # picks the Nth project photo (after the zone/tag filter).' }));
    } else if (b.kind === 'field') {
      fieldPicker(wrap, el);
    } else {
      var pick = h('button', { type: 'button', class: 'drop-pick', onclick: function () { pickImageFor(el); } },
        el.src ? h('img', { src: el.src, alt: '' }) : null,
        h('b', { text: el.src ? 'Replace image…' : 'Choose a JPG or PNG…' }),
        h('small', { text: 'or drop a file here or onto the box on the slide' }));
      pick.addEventListener('dragover', function (e) { e.preventDefault(); pick.classList.add('over'); });
      pick.addEventListener('dragleave', function () { pick.classList.remove('over'); });
      pick.addEventListener('drop', function (e) {
        e.preventDefault();
        pick.classList.remove('over');
        var f = Array.prototype.filter.call(e.dataTransfer.files || [], isImageFile)[0];
        if (f) setImageFile(el, f); else toast('Please drop a JPG or PNG file');
      });
      wrap.appendChild(pick);
      if (el.src) {
        wrap.appendChild(h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn sm', title: 'Resize the box to the image’s own proportions', onclick: function () { matchRatio(el); } }, 'Match image ratio')));
        wrap.appendChild(h('p', { class: 'note', text: 'Kept at full resolution' + (el.alt ? ' (' + el.alt + ')' : '') + ', so it stays sharp at any size.' }));
      }
    }
    wrap.appendChild(row('Fit', selectInput([['cover', 'Fill box (crop)'], ['contain', 'Fit inside'], ['fill', 'Stretch']], el.fit || 'cover', function (v) { change(function () { el.fit = v; }); })));
    wrap.appendChild(row('Focus', selectInput([['center', 'Center'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']], el.position || 'center', function (v) { change(function () { el.position = v; }); })));
  }

  var imageTarget = null;
  function pickImageFor(el) {
    imageTarget = el;
    $('#fileImage').value = '';
    $('#fileImage').click();
  }
  function setImageFile(el, f) {
    if (!isImageFile(f)) return toast('Please choose a JPG or PNG file');
    X.readFile(f, true).then(function (src) {
      change(function () { el.src = src; el.alt = f.name; el.bind.kind = 'none'; });
      toast('Added ' + f.name);
    }).catch(function (e) { toast('Could not read image: ' + e.message); });
  }
  $('#fileImage').addEventListener('change', function () {
    var f = this.files && this.files[0];
    var el = imageTarget;
    imageTarget = null;
    if (f && el) setImageFile(el, f);
  });

  function matchRatio(el) {
    loadImageSize(el.src).then(function (nat) {
      if (!nat) return;
      change(function () {
        el.h = round3(clamp(el.w * nat.h / nat.w, 0.125, PAGE_H));
        if (el.y + el.h > PAGE_H) el.y = round3(PAGE_H - el.h);
      });
    });
  }

  /* ---------- status ---------- */

  var saveStatus = 'Saved';
  function setStatus(s) { saveStatus = s; renderStatus(); }
  function renderStatus() {
    var st = $('#status');
    if (!st || !state.doc) return;
    var t = tpl();
    var n = expanded().length;
    var g = grid();
    st.textContent = [
      t ? t.name + ' · ' + t.elements.length + ' item' + (t.elements.length === 1 ? '' : 's') : 'No template',
      'Deck: ' + state.doc.deck.length + ' entr' + (state.doc.deck.length === 1 ? 'y' : 'ies') + ' → ' + n + ' page' + (n === 1 ? '' : 's'),
      '11 × 8.5 in Letter landscape',
      'Grid ' + g.size + ' in' + (g.snap ? ', snap on' : ', snap off'),
      Math.round(state.z * 100) + '%',
      saveStatus
    ].join('  ·  ');
  }

  /* ---------- header / project ---------- */

  function renderHeader() {
    $('#deckName').value = state.doc.name;
    $('#projectLabel').textContent = state.project ? state.project.title + (state.project.source === 'sample' ? ' (sample)' : '') : 'No project';
    $('#projectDot').classList.toggle('on', !!state.project);
    $('#gridSize').value = String(grid().size);
    $('#snapToggle').checked = grid().snap;
    $('#gridToggle').checked = grid().show;
    $('#dataToggle').checked = state.dataPreview;
    $('#zoom').value = String(state.zoom);
  }

  function renderAll() {
    renderHeader();
    renderStage();
    renderInspector();
    renderLists();
  }

  function setProject(p) {
    state.project = p;
    store.set('project', p).catch(function () { /* offline cache only */ });
    renderAll();
    renderProjectDialog();
  }

  var dialog = $('#projectDialog');

  function renderProjectDialog() {
    var p = state.project;
    var cur = $('#currentProject');
    cur.innerHTML = '';
    if (p) {
      var zones = projectValues('zone');
      cur.appendChild(h('div', null, h('b', { text: p.title }), ' ', h('span', { class: 'muted', text: '· ' + ({ supabase: 'Supabase audit', json: 'JSON file', sample: 'Sample data' }[p.source] || p.source) })));
      cur.appendChild(h('div', { class: 'muted', text: [p.fields.address, p.fields.appointment_date].filter(Boolean).join(' · ') }));
      cur.appendChild(h('div', { class: 'muted', text: p.photos.length + ' photo' + (p.photos.length === 1 ? '' : 's') + (zones.length ? ' in ' + zones.length + ' zone' + (zones.length === 1 ? '' : 's') + ' (' + zones.join(', ') + ')' : '') }));
    } else {
      cur.appendChild(h('div', { class: 'muted', text: 'No project loaded. Templates show their {{placeholders}} and empty photo slots.' }));
    }
    var chips = $('#fieldChips');
    chips.innerHTML = '';
    D.fieldPaths(p).forEach(function (f) {
      var token = '{{' + f + '}}';
      chips.appendChild(h('button', { type: 'button', class: 'chip', title: 'Copy ' + token, onclick: function () {
        (navigator.clipboard ? navigator.clipboard.writeText(token) : Promise.reject()).then(function () { toast('Copied ' + token); }, function () { toast(token); });
      } }, token));
    });
    var c = D.getConfig();
    $('#sbUrl').value = c.url;
    $('#sbKey').value = c.key;
    $('#sbTable').value = c.projectsTable;
    $('#sbPhotoTable').value = c.photosTable;
    $('#sbFk').value = c.photosFk;
    $('#sbBucket').value = c.bucket;
    var s = D.getSession();
    $('#sbSignedOut').hidden = !!s;
    $('#sbSignedIn').hidden = !s;
    if (s) $('#sbWho').textContent = 'Signed in as ' + (s.email || 'crew member');
  }

  function sbError(msg) { $('#sbError').textContent = msg || ''; }

  function refreshProjects() {
    sbError('');
    var selEl = $('#sbProjects');
    selEl.innerHTML = '<option>Loading…</option>';
    return D.listProjects().then(function (rows) {
      selEl.innerHTML = '';
      if (!rows.length) selEl.appendChild(h('option', { value: '' }, 'No audits visible to this account'));
      rows.forEach(function (r) {
        var label = (r.customer_name || r.id) + (r.address ? ' — ' + r.address : '') + (r.appointment_date ? ' (' + r.appointment_date + ')' : '') + ' · ' + (r.photo_count || 0) + ' photos';
        selEl.appendChild(h('option', { value: r.id, selected: state.project && state.project.id === r.id }, label));
      });
    }).catch(function (e) {
      selEl.innerHTML = '';
      sbError(e.message);
      if (/sign in/i.test(e.message)) renderProjectDialog();
    });
  }

  $('#btnProject').addEventListener('click', function () {
    renderProjectDialog();
    sbError('');
    dialog.showModal();
    if (D.getSession()) refreshProjects();
  });
  $('#sbLogin').addEventListener('submit', function (e) {
    e.preventDefault();
    sbError('');
    var btn = this.querySelector('button');
    btn.disabled = true;
    D.signIn($('#sbEmail').value.trim(), $('#sbPassword').value).then(function () {
      $('#sbPassword').value = '';
      renderProjectDialog();
      return refreshProjects();
    }).catch(function (err) { sbError(err.message); }).then(function () { btn.disabled = false; });
  });
  $('#sbSignOut').addEventListener('click', function () { D.signOut(); renderProjectDialog(); });
  $('#sbRefresh').addEventListener('click', refreshProjects);
  $('#sbLoad').addEventListener('click', function () {
    var id = $('#sbProjects').value;
    if (!id) return;
    sbError('');
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Loading…';
    D.loadProject(id).then(function (p) {
      setProject(p);
      toast('Loaded ' + p.title + ' · ' + p.photos.length + ' photos');
    }).catch(function (e) { sbError(e.message); }).then(function () { btn.disabled = false; btn.textContent = 'Load'; });
  });
  $('#sbSaveCfg').addEventListener('click', function () {
    D.setConfig({
      url: $('#sbUrl').value.trim(),
      key: $('#sbKey').value.trim(),
      projectsTable: $('#sbTable').value.trim() || D.DEFAULTS.projectsTable,
      photosTable: $('#sbPhotoTable').value.trim() || D.DEFAULTS.photosTable,
      photosFk: $('#sbFk').value.trim() || D.DEFAULTS.photosFk,
      bucket: $('#sbBucket').value.trim() || D.DEFAULTS.bucket
    });
    toast('Connection settings saved');
  });
  $('#projJson').addEventListener('click', function () { $('#fileProjectJSON').value = ''; $('#fileProjectJSON').click(); });
  $('#fileProjectJSON').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    X.readFile(f).then(function (txt) {
      var p = D.fromJSON(JSON.parse(txt));
      setProject(p);
      toast('Loaded ' + p.title);
    }).catch(function (e) { sbError('Could not read project JSON: ' + e.message); });
  });
  $('#projSample').addEventListener('click', function () { setProject(D.sampleProject()); toast('Sample project loaded'); });
  $('#projClear').addEventListener('click', function () { setProject(null); });

  /* ---------- shared template library (Supabase) ---------- */

  var libDialog = $('#libraryDialog');

  function timeAgo(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderCloudStatus() {
    var c = state.cloud;
    var dot = $('#cloudDot');
    dot.classList.toggle('on', !!c && !c.dirty);
    dot.classList.toggle('warn', !!c && c.dirty);
    $('#cloudLabel').textContent = !c ? 'Library' : (c.dirty ? 'Library · unsaved' : 'Library · saved');
  }

  function setCloud(meta) {
    state.cloud = meta;
    store.set('cloud', meta).catch(function () {});
    renderCloudStatus();
  }

  function libError(msg) { $('#libError').textContent = msg || ''; }

  function renderLibrary() {
    var s = D.getSession();
    $('#libSignedOut').hidden = !!s;
    $('#libSignedIn').hidden = !s;
    if (!s) return;
    $('#libWho').textContent = 'Signed in as ' + (s.email || 'crew member');
    var c = state.cloud;
    var cur = $('#libCurrent');
    cur.innerHTML = '';
    cur.appendChild(h('div', null, h('b', { text: state.doc.name })));
    cur.appendChild(h('div', { class: 'muted', text: !c
      ? 'This deck is only in this browser. Click Save to put it in the shared library.'
      : (c.dirty ? 'Has changes that are not in the library yet.' : 'Up to date in the library.') +
        (c.updatedAt ? ' Last saved ' + timeAgo(c.updatedAt) + (c.updatedBy ? ' by ' + c.updatedBy : '') + '.' : '') }));
    $('#libSave').textContent = c ? 'Save changes' : 'Save to library';
  }

  function refreshLibrary() {
    libError('');
    var list = $('#libList');
    list.innerHTML = '<li class="muted">Loading…</li>';
    return D.listDecks().then(function (rows) {
      list.innerHTML = '';
      if (!rows.length) list.appendChild(h('li', { class: 'muted' }, 'No decks saved yet. Save this one to start the library.'));
      rows.forEach(function (r) {
        var isCur = state.cloud && state.cloud.id === r.id;
        list.appendChild(h('li', { class: isCur ? 'current' : '' },
          h('div', { class: 'lib-meta' },
            h('b', { text: r.name + (isCur ? ' (open now)' : '') }),
            h('small', { text: 'Saved ' + timeAgo(r.updated_at) + (r.updated_by ? ' by ' + r.updated_by : '') })),
          h('button', { type: 'button', class: 'btn sm', onclick: function () { openFromLibrary(r); } }, 'Open'),
          h('button', { type: 'button', class: 'btn sm danger', onclick: function () { deleteFromLibrary(r); } }, 'Delete')));
      });
    }).catch(function (e) {
      list.innerHTML = '';
      libError(e.message);
      renderLibrary();
    });
  }

  function openLibrary() {
    libError('');
    renderLibrary();
    if (!libDialog.open) libDialog.showModal();
    if (D.getSession()) refreshLibrary();
  }

  // Uploaded JPG/PNGs live inside the deck as data: URLs; move them to
  // storage first so the saved deck stays small and exports can load them.
  function uploadEmbeddedImages() {
    var els = [];
    state.doc.templates.forEach(function (t) {
      t.elements.forEach(function (e) { if (e.type === 'image' && /^data:image\//.test(e.src || '')) els.push(e); });
    });
    if (!els.length) return Promise.resolve();
    var cache = {};
    return els.reduce(function (p, e) {
      return p.then(function () {
        cache[e.src] = cache[e.src] || D.uploadAsset(e.src);
        return cache[e.src].then(function (url) { e.uploaded = url; });
      });
    }, Promise.resolve()).then(function () {
      change(function () { els.forEach(function (e) { e.src = e.uploaded; delete e.uploaded; }); });
    });
  }

  var saving = false;
  function saveToLibrary(asCopy) {
    if (!D.getSession()) { openLibrary(); return Promise.resolve(); }
    if (saving) return Promise.resolve();
    saving = true;
    libError('');
    setStatus('Saving to library…');
    return uploadEmbeddedImages().then(function () {
      var c = state.cloud;
      if (asCopy || !c) {
        var doc = clone(state.doc);
        if (asCopy) {
          var nm = prompt('Name for the new copy', state.doc.name + ' copy');
          if (nm == null) return null;
          doc.name = nm.trim() || doc.name;
        }
        return D.createDeck(doc).then(function (row) {
          if (asCopy) state.doc.name = doc.name;
          return row;
        });
      }
      return D.updateDeck(c.id, clone(state.doc), c.updatedAt).then(function (row) {
        if (row) return row;
        // Someone else saved since this deck was opened.
        if (confirm('Someone else saved "' + c.name + '" in the library since you opened it.\n\nOK = replace their version with yours\nCancel = keep both (save yours as a new copy)')) {
          return D.updateDeck(c.id, clone(state.doc), null);
        }
        var copy = clone(state.doc);
        copy.name = state.doc.name + ' (my copy)';
        state.doc.name = copy.name;
        return D.createDeck(copy);
      });
    }).then(function (row) {
      if (!row) { setStatus('Saved'); return; }
      setCloud({ id: row.id, name: row.name, updatedAt: row.updated_at, updatedBy: row.updated_by, dirty: false });
      store.set('doc', state.doc).catch(function () {});
      renderHeader();
      setStatus('Saved to library');
      toast('Saved “' + row.name + '” to the library');
      if (libDialog.open) { renderLibrary(); refreshLibrary(); }
    }).catch(function (e) {
      setStatus('Library save failed');
      libError(e.message);
      if (!libDialog.open) toast('Library save failed: ' + e.message);
    }).then(function () { saving = false; });
  }

  function confirmLeave(action) {
    var c = state.cloud;
    if (c && !c.dirty) return true;
    return confirm(c ? 'This deck has changes that are not saved to the library. ' + action + ' anyway?'
      : 'This deck is not saved to the library. ' + action + ' anyway? (It will be replaced in this browser.)');
  }

  function loadDoc(doc, cloudMeta) {
    pushHistory();
    state.doc = normalizeDoc(doc);
    state.currentId = state.doc.templates[0] ? state.doc.templates[0].id : null;
    state.selectedId = null;
    state.deckEntryId = null;
    setCloud(cloudMeta);
    store.set('doc', state.doc).catch(function () {});
    renderAll();
  }

  function openFromLibrary(r) {
    if (state.cloud && state.cloud.id === r.id && !state.cloud.dirty) { libDialog.close(); return; }
    if (!confirmLeave('Open “' + r.name + '”')) return;
    libError('');
    D.getDeck(r.id).then(function (row) {
      loadDoc(row.doc, { id: row.id, name: row.name, updatedAt: row.updated_at, updatedBy: row.updated_by, dirty: false });
      libDialog.close();
      toast('Opened “' + row.name + '”');
    }).catch(function (e) { libError(e.message); });
  }

  function deleteFromLibrary(r) {
    if (!confirm('Delete “' + r.name + '” from the shared library for everyone? This cannot be undone.')) return;
    D.deleteDeck(r.id).then(function () {
      if (state.cloud && state.cloud.id === r.id) setCloud(null);
      toast('Deleted “' + r.name + '” from the library');
      renderLibrary();
      refreshLibrary();
    }).catch(function (e) { libError(e.message); });
  }

  $('#btnLibrary').addEventListener('click', openLibrary);
  $('#libLogin').addEventListener('submit', function (e) {
    e.preventDefault();
    libError('');
    var btn = this.querySelector('button');
    btn.disabled = true;
    D.signIn($('#libEmail').value.trim(), $('#libPassword').value).then(function () {
      $('#libPassword').value = '';
      renderLibrary();
      return refreshLibrary();
    }).catch(function (err) { libError(err.message); }).then(function () { btn.disabled = false; });
  });
  $('#libSignOut').addEventListener('click', function () { D.signOut(); renderLibrary(); });
  $('#libRefresh').addEventListener('click', refreshLibrary);
  $('#libSave').addEventListener('click', function () { saveToLibrary(false); });
  $('#libSaveCopy').addEventListener('click', function () { saveToLibrary(true); });
  $('#libNew').addEventListener('click', function () {
    if (!confirmLeave('Start a new deck')) return;
    loadDoc(T.starterDeck(), null);
    libDialog.close();
    toast('New deck started from the starter templates');
  });

  /* ---------- header actions ---------- */

  $('#deckName').addEventListener('input', function () {
    var v = this.value;
    change(function () { state.doc.name = v; }, { key: 'deckname', stage: false, inspector: false, lists: false });
  });

  $('#addTemplate').addEventListener('click', addTemplate);
  $all('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () { addElement(b.getAttribute('data-add')); });
  });
  $('#gridSize').addEventListener('change', function () {
    var v = parseFloat(this.value);
    change(function () { grid().size = v; }, { inspector: true });
  });
  $('#snapToggle').addEventListener('change', function () {
    var v = this.checked;
    change(function () { grid().snap = v; }, { lists: false });
  });
  $('#gridToggle').addEventListener('change', function () {
    var v = this.checked;
    change(function () { grid().show = v; }, { lists: false, inspector: false });
  });
  $('#dataToggle').addEventListener('change', function () {
    state.dataPreview = this.checked;
    prefs('dataPreview', state.dataPreview);
    renderStage();
    renderLists();
  });
  $('#zoom').addEventListener('change', function () {
    state.zoom = this.value;
    renderStage();
  });
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);

  function deckSlides() {
    return R.renderDeck(state.doc, state.project, { mode: renderMode() });
  }

  function present() {
    if (!state.doc.deck.length) return toast('Add templates to the deck first');
    var all = expanded();
    var start = 0;
    for (var i = 0; i < all.length; i++) {
      if ((state.deckEntryId && all[i].entryId === state.deckEntryId) || (!state.deckEntryId && all[i].template.id === state.currentId)) { start = i; break; }
    }
    R.mountViewer({ title: state.doc.name, makeSlides: deckSlides, start: start, onClose: function () {} });
  }

  function printPDF() {
    if (!state.doc.deck.length) return toast('Add templates to the deck first');
    toast('Choose “Save as PDF” in the print dialog');
    R.printSlides(deckSlides());
  }

  $('#btnPresent').addEventListener('click', present);
  $('#btnPrint').addEventListener('click', printPDF);

  var exportBtn = $('#btnExport');
  var exportMenu = $('#exportMenu');
  function toggleMenu(open) {
    exportMenu.hidden = !open;
    exportBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) exportMenu.querySelector('button').focus();
  }
  exportBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(exportMenu.hidden); });
  document.addEventListener('click', function (e) { if (!exportMenu.hidden && !e.target.closest('.menu')) toggleMenu(false); });
  exportMenu.addEventListener('keydown', function (e) { if (e.key === 'Escape') { toggleMenu(false); exportBtn.focus(); } });
  exportMenu.addEventListener('click', function (e) {
    var b = e.target.closest('[data-export]');
    if (!b) return;
    toggleMenu(false);
    var kind = b.getAttribute('data-export');
    if (kind === 'deck-json') X.exportDeckJSON(state.doc);
    if (kind === 'template-html') X.exportTemplateHTML(state.doc);
    if (kind === 'rendered-html') X.exportRenderedHTML(state.doc, state.project);
    if (kind === 'rendered-json') X.exportRenderedJSON(state.doc, state.project);
    if (kind === 'pdf') printPDF();
  });

  $('#btnImport').addEventListener('click', openImportDialog);
  $('#fileImport').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (f) handleImportFile(f);
  });

  // One entry point for every way a file arrives: drop box, picker, or dropped anywhere.
  function handleImportFile(f) {
    if (/\.pptx$/i.test(f.name)) { openPptxImport(f); return; }
    if (/\.(json|html?)$/i.test(f.name)) {
      if (pptxDialog.open) pptxDialog.close();
      importDeckFile(f);
      return;
    }
    if (isImageFile(f)) { toast('To add a picture, drop it onto the slide'); return; }
    if (/\.(ppt|key|odp|pdf)$/i.test(f.name)) {
      openImportDialog();
      pptxError('“' + f.name + '” can’t be imported. Save it as PowerPoint (.pptx) first — in Google Slides use File → Download → Microsoft PowerPoint.');
      return;
    }
    openImportDialog();
    pptxError('“' + f.name + '” isn’t a file CloudSlides can import. Use a .pptx, or a CloudSlides .json / .html deck.');
  }

  function importDeckFile(f) {
    X.readFile(f).then(function (txt) {
      var d = normalizeDoc(X.parseDeckFile(txt));
      var replace = confirm('Replace the current deck with "' + d.name + '"?\n\nOK = replace · Cancel = add its templates to this deck');
      change(function () {
        if (replace) {
          state.doc = d;
          setCloud(null); // an imported file is a new deck, not the library copy
        } else {
          d.templates.forEach(function (t) {
            if (state.doc.templates.some(function (x) { return x.id === t.id; })) {
              var old = t.id;
              t.id = T.uid('t');
              d.deck.forEach(function (en) { if (en.templateId === old) en.templateId = t.id; });
            }
            state.doc.templates.push(t);
          });
          d.deck.forEach(function (en) { state.doc.deck.push({ id: T.uid('d'), templateId: en.templateId }); });
        }
        state.currentId = d.templates[0] ? d.templates[0].id : (state.doc.templates[0] || {}).id;
        state.selectedId = null;
        state.deckEntryId = null;
      });
      renderHeader();
      toast('Imported ' + d.templates.length + ' template(s)');
    }).catch(function (e) { toast('Import failed: ' + e.message); });
  }

  /* ---------- PowerPoint / Google Slides import ---------- */

  var pptxDialog = $('#pptxDialog');
  var pptxFile = null, pptxBuf = null;

  function pptxError(m) { $('#pptxError').textContent = m || ''; }

  var importDrop = $('#importDrop');

  // First state of the Import window: just the drop box.
  function openImportDialog() {
    pptxFile = null;
    pptxBuf = null;
    pptxError('');
    importDrop.hidden = false;
    $('#pptxInfo').hidden = true;
    $('#pptxOptions').hidden = true;
    $('#pptxReport').innerHTML = '';
    if (!pptxDialog.open) pptxDialog.showModal();
    importDrop.focus();
  }

  function pickImportFile() { $('#fileImport').value = ''; $('#fileImport').click(); }

  importDrop.addEventListener('click', pickImportFile);
  importDrop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickImportFile(); }
  });
  importDrop.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); importDrop.classList.add('over'); });
  importDrop.addEventListener('dragleave', function () { importDrop.classList.remove('over'); });
  importDrop.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    importDrop.classList.remove('over');
    hideDropOverlay();
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleImportFile(f);
  });

  function openPptxImport(file) {
    pptxFile = file;
    pptxBuf = null;
    pptxError('');
    importDrop.hidden = true;
    $('#pptxReport').innerHTML = '';
    $('#pptxOptions').hidden = false;
    $('#pptxGo').disabled = true;
    var info = $('#pptxInfo');
    info.hidden = false;
    info.innerHTML = '';
    info.appendChild(h('div', { class: 'form-row', style: 'margin:0' },
      h('b', { text: file.name }), h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn sm', onclick: openImportDialog }, 'Use a different file')));
    info.appendChild(h('div', { class: 'muted', text: 'Reading…' }));
    if (!pptxDialog.open) pptxDialog.showModal();
    file.arrayBuffer().then(function (buf) {
      pptxBuf = buf;
      var zip = window.CloudSlidesPptx.readZip(buf);
      return zip.text('ppt/presentation.xml').then(function (xml) {
        var d = xml && new DOMParser().parseFromString(xml, 'application/xml');
        var sz = d && d.getElementsByTagNameNS('*', 'sldSz')[0];
        var count = d ? d.getElementsByTagNameNS('*', 'sldId').length : 0;
        if (!sz) throw new Error('No slides found in this file.');
        var w = +sz.getAttribute('cx') / 914400, hh = +sz.getAttribute('cy') / 914400;
        info.lastChild.textContent = count + ' slide' + (count === 1 ? '' : 's') + ' · ' + (Math.round(w * 100) / 100) + ' × ' + (Math.round(hh * 100) / 100) + ' in';
        var same = Math.abs(w / hh - PAGE_W / PAGE_H) < 0.02;
        $('#pptxFitBox').hidden = same;
        $('#pptxFitNote').textContent = 'These slides are ' + (w / hh > 1.6 ? 'widescreen' : 'a different shape') + '; CloudSlides pages are US Letter landscape (11 × 8.5 in).';
        $('#pptxGo').disabled = false;
      });
    }).catch(function (e) { info.lastChild.textContent = ''; pptxError(e.message); });
  }

  function radioVal(name) { var r = document.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ''; }

  $('#pptxGo').addEventListener('click', function () {
    if (!pptxBuf) return;
    var mode = radioVal('pptxMode');
    if (mode === 'new' && !confirmLeave('Start a new deck')) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Importing…';
    pptxError('');
    window.CloudSlidesPptx.importPptx(pptxBuf, { fit: radioVal('pptxFit') || 'fit', photoFields: $('#pptxPhoto').checked }).then(function (res) {
      var name = pptxFile.name.replace(/\.pptx$/i, '').replace(/[_]+/g, ' ');
      if (!res.templates.length) throw new Error('No slides could be read from this file.');
      if (mode === 'new') {
        loadDoc({ name: name, grid: clone(state.doc.grid), templates: res.templates, fields: res.fields,
          deck: res.templates.map(function (t) { return { id: T.uid('d'), templateId: t.id }; }) }, null);
      } else {
        change(function () {
          // Keep photo field keys unique across the whole deck.
          var taken = {};
          state.doc.fields.forEach(function (f) { taken[R.fieldKey(f.key)] = true; });
          var renamed = {};
          res.fields.forEach(function (f) {
            var key = f.key, n = 2;
            while (taken[R.fieldKey(key)]) key = f.key + '_' + n++;
            taken[R.fieldKey(key)] = true;
            renamed[f.key] = key;
            state.doc.fields.push({ key: key, label: f.label });
          });
          res.templates.forEach(function (t) {
            t.elements.forEach(function (e) { if (e.type === 'image' && e.bind && e.bind.kind === 'field' && renamed[e.bind.field]) e.bind.field = renamed[e.bind.field]; });
            state.doc.templates.push(t);
            state.doc.deck.push({ id: T.uid('d'), templateId: t.id });
          });
        });
        openTemplate(res.templates[0].id);
      }
      showPptxReport(res.report);
      toast('Imported ' + res.templates.length + ' slides');
    }).catch(function (e) {
      pptxError('Import failed: ' + e.message);
    }).then(function () { btn.disabled = false; btn.textContent = 'Import slides'; });
  });

  function showPptxReport(r) {
    $('#pptxOptions').hidden = true;
    var box = $('#pptxReport');
    box.innerHTML = '';
    box.appendChild(h('h3', { text: 'Imported ' + r.slides + ' slide' + (r.slides === 1 ? '' : 's') + ' as editable templates' }));
    var list = h('ul', { class: 'report-list' });
    [[r.text, 'text box', 'text boxes'], [r.shapes, 'box', 'boxes'], [r.lines, 'line', 'lines'], [r.images, 'picture', 'pictures'],
      [r.tables, 'table, as editable cells', 'tables, as editable cells'], [r.photoSlots, 'photo field', 'photo fields']]
      .forEach(function (x) { if (x[0]) list.appendChild(h('li', { text: x[0] + ' ' + (x[0] === 1 ? x[1] : x[2]) })); });
    box.appendChild(list);
    var notes = [];
    Object.keys(r.skipped).forEach(function (k) { notes.push(r.skipped[k] + ' × ' + k); });
    if (r.rotated) notes.push(r.rotated + ' rotated item' + (r.rotated === 1 ? ' was' : 's were') + ' placed straight');
    if (notes.length) {
      box.appendChild(h('h3', { text: 'Needs a look' }));
      var nl = h('ul', { class: 'report-list' });
      notes.forEach(function (n) { nl.appendChild(h('li', { text: n })); });
      box.appendChild(nl);
    }
    box.appendChild(h('p', { class: 'note', text: 'Fonts switch to San Francisco, so check that long text still fits its box. Save to the Library when you are happy with it.' }));
    box.appendChild(h('div', { class: 'form-row' }, h('button', { type: 'button', class: 'btn primary', onclick: function () { pptxDialog.close(); } }, 'Done')));
  }

  /* ---------- drop a file anywhere to import ---------- */

  var dropOverlay = $('#dropOverlay');
  var dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
  function hideDropOverlay() { dragDepth = 0; dropOverlay.hidden = true; }
  // Dragging over the slide is for pictures, so the overlay stays out of the way there.
  function overStage(e) { return e.target && e.target.closest && e.target.closest('#stage'); }

  window.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    dragDepth++;
    dropOverlay.hidden = !!(overStage(e) || pptxDialog.open);
  });
  window.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); // otherwise the browser would open the file in place of the app
    dropOverlay.hidden = !!(overStage(e) || pptxDialog.open);
  });
  window.addEventListener('dragleave', function (e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.hidden = true;
  });
  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    var tookPicture = e.defaultPrevented && overStage(e); // the slide already added the picture
    e.preventDefault();
    hideDropOverlay();
    if (tookPicture) return;
    var files = Array.prototype.slice.call(e.dataTransfer.files || []);
    var f = files.filter(function (x) { return !isImageFile(x); })[0] || files[0];
    if (f && !(overStage(e) && isImageFile(f))) handleImportFile(f);
  });

  /* ---------- keyboard ---------- */

  document.addEventListener('keydown', function (e) {
    if (document.querySelector('.cs-viewer') || dialog.open || libDialog.open || fieldsDialog.open || pptxDialog.open) return;
    var typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
    var mod = e.metaKey || e.ctrlKey;
    var key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && key === 's') { e.preventDefault(); saveToLibrary(false); return; }
    if (mod && key === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (typing) return;
    var el = sel();
    if (mod && key === 'd' && el) { e.preventDefault(); pasteElement(el); return; }
    if (mod && key === 'c' && el) { state.clipboard = clone(el); toast('Copied'); return; }
    if (mod && key === 'v' && state.clipboard) { e.preventDefault(); pasteElement(state.clipboard); return; }
    // Layer order, as in PowerPoint / Figma: Ctrl/⌘ ] forward, [ backward, + Shift = all the way.
    if (mod && el && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
      e.preventDefault();
      var up = e.code === 'BracketRight';
      reorder(e.shiftKey ? (up ? 'front' : 'back') : (up ? 'forward' : 'backward'));
      return;
    }
    if (mod || e.altKey) return;
    if ((key === 'Delete' || key === 'Backspace') && el) { e.preventDefault(); deleteElement(); return; }
    if (key === 'Escape') { if (state.tool) setTool(null); else select(null); return; }
    var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[key] && el) {
      e.preventDefault();
      var step = (grid().snap ? grid().size : 0.0625) * (e.shiftKey ? 4 : 1);
      change(function () { moveBy(el, arrows[key][0] * step, arrows[key][1] * step); }, { key: 'nudge:' + el.id });
      return;
    }
    var adds = { t: 'text', b: 'box', r: 'round', i: 'image', l: 'line', g: 'chart' };
    if (adds[key]) { e.preventDefault(); addElement(adds[key]); }
  });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { applyZoom(); renderSelection(); fitThumbs(); renderStatus(); }, 60);
  });

  /* ---------- boot ---------- */

  Promise.all([store.get('doc'), store.get('project'), store.get('cloud')]).then(function (res) {
    state.cloud = res[2] || null;
    state.doc = normalizeDoc(res[0] || T.starterDeck());
    // First run: show the sample project so the templates have something to fill.
    state.project = res[1] !== undefined ? res[1] : D.sampleProject();
    var dp = prefs('dataPreview');
    state.dataPreview = dp == null ? true : !!dp;
    state.currentId = state.doc.templates[0] ? state.doc.templates[0].id : null;
    renderAll();
    renderCloudStatus();
    if (!res[0]) save();
  });

  // Debug / automation hook.
  window.CloudSlidesApp = { state: state, renderAll: renderAll, setProject: setProject };
})();
