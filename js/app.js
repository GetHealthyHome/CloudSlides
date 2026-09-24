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

  var PRESETS = ['#ffffff', '#f5f5f7', '#d1d1d6', '#8e8e93', '#1d1d1f', '#14213d', '#1f2f55', '#0a84ff', '#e8f1ff', '#34c759', '#ff9f0a', '#ff3b30', '#5e5ce6', '#bf5af2'];

  var state = {
    doc: null,
    project: null,
    currentId: null,
    selectedId: null,
    deckEntryId: null,
    zoom: 'fit',
    z: 1,
    dataPreview: true,
    clipboard: null
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

  function renderSelection(showSize) {
    selLayer.innerHTML = '';
    var el = sel();
    if (!el) return;
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

  function startDrag(e, kind, hd) {
    var el = sel();
    if (!el) return;
    e.preventDefault();
    var start = { x: e.clientX, y: e.clientY, el: clone(el) };
    var moved = false;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    function onMove(ev) {
      if (!moved && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 3) return;
      if (!moved) { pushHistory(); moved = true; }
      var dx = (ev.clientX - start.x) / (DPI * state.z);
      var dy = (ev.clientY - start.y) / (DPI * state.z);
      if (kind === 'move') {
        el.x = round3(clamp(snapV(start.el.x + dx), 0, PAGE_W - el.w));
        el.y = round3(clamp(snapV(start.el.y + dy), 0, PAGE_H - el.h));
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
    var handle = e.target.closest('.handle');
    if (handle) { startDrag(e, 'resize', handle.getAttribute('data-h')); return; }
    var node = e.target.closest('#slideHost .cs-el');
    if (node) {
      select(node.getAttribute('data-id'));
      startDrag(e, 'move');
      return;
    }
    select(null);
  });

  stage.addEventListener('dblclick', function (e) {
    var node = e.target.closest('#slideHost .cs-text');
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
    var g = grid().snap ? grid().size : 0.25;
    el.x = round3(clamp(el.x + g, 0, PAGE_W - el.w));
    el.y = round3(clamp(el.y + g, 0, PAGE_H - el.h));
    change(function () { t.elements.push(el); state.selectedId = el.id; });
  }

  function reorder(where) {
    var t = tpl(), el = sel();
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
    c.elements.forEach(function (e) { e.id = T.uid('e'); });
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
      var b = h('button', { type: 'button', class: 'sw', title: c, 'aria-label': 'Color ' + c, onclick: function () { apply(c); } });
      b.style.background = c;
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
    if (el) renderElementInspector(wrap, t, el);
    else renderTemplateInspector(wrap, t);
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

    wrap.appendChild(h('h2', { text: 'Page' }));
    wrap.appendChild(h('p', { class: 'note', text: 'US Letter landscape, 11 × 8.5 in. Every slide prints on exactly one page. Items can’t be dragged off the page.' }));
    wrap.appendChild(h('h2', { text: 'Shortcuts' }));
    wrap.appendChild(h('p', { class: 'note', text: 'T text · B box · R rounded · I image · arrows nudge (Shift ×4) · Delete remove · Ctrl/⌘ D duplicate · Ctrl/⌘ C / V copy/paste · Ctrl/⌘ Z undo · Shift-drag a corner keeps proportions · double-click text to edit.' }));
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
    if (el.type === 'image') return el.bind && el.bind.kind === 'photo' ? 'Photo slot' : 'Image';
    return (Number(el.radius) || 0) > 0 ? 'Rounded box' : 'Square box';
  }

  function renderElementInspector(wrap, t, el) {
    wrap.appendChild(h('h2', { text: elementTitle(el) }));

    // Position and size, in inches.
    var g = grid().snap ? grid().size : 0.01;
    var xywh = h('div', { class: 'xywh' });
    [['X', 'x', PAGE_W], ['Y', 'y', PAGE_H], ['W', 'w', PAGE_W], ['H', 'h', PAGE_H]].forEach(function (f) {
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
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn sm', title: 'Center horizontally on the page', onclick: function () { change(function () { el.x = round3((PAGE_W - el.w) / 2); }); } }, 'Center ↔'),
      h('button', { type: 'button', class: 'btn sm', title: 'Center vertically on the page', onclick: function () { change(function () { el.y = round3((PAGE_H - el.h) / 2); }); } }, 'Center ↕'),
      h('button', { type: 'button', class: 'btn sm', title: 'Fill the whole page', onclick: function () { change(function () { el.x = 0; el.y = 0; el.w = PAGE_W; el.h = PAGE_H; }); } }, 'Full page')
    ));
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn sm', onclick: function () { reorder('front'); } }, 'To front'),
      h('button', { type: 'button', class: 'btn sm', onclick: function () { reorder('forward'); } }, 'Forward'),
      h('button', { type: 'button', class: 'btn sm', onclick: function () { reorder('backward'); } }, 'Backward'),
      h('button', { type: 'button', class: 'btn sm', onclick: function () { reorder('back'); } }, 'To back')
    ));
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn sm', onclick: function () { pasteElement(el); } }, 'Duplicate'),
      h('button', { type: 'button', class: 'btn sm danger', onclick: deleteElement }, 'Delete')
    ));

    if (el.type === 'text') textInspector(wrap, el);
    if (el.type === 'image') imageInspector(wrap, el);

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

  function imageInspector(wrap, el) {
    wrap.appendChild(h('h2', { text: 'Image source' }));
    var b = el.bind;
    wrap.appendChild(row('Source', seg([['photo', 'Project photo'], ['none', 'File'], ['field', 'Field']], b.kind === 'none' ? 'none' : b.kind, function (v) {
      change(function () { b.kind = v; });
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
      wrap.appendChild(row('Field', selectInput([['', 'Choose a field with an image URL…']].concat(fieldOptions()), b.field || '', function (v) {
        change(function () { b.field = v; });
      })));
    } else {
      wrap.appendChild(h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn sm', onclick: function () { pickImageFor(el); } }, el.src ? 'Replace JPG/PNG…' : 'Upload JPG/PNG…'),
        el.src ? h('button', { type: 'button', class: 'btn sm', title: 'Resize the box to the image’s own proportions', onclick: function () { matchRatio(el); } }, 'Match image ratio') : null
      ));
      if (el.src) wrap.appendChild(h('p', { class: 'note', text: 'Stored at full resolution' + (el.alt ? ' (' + el.alt + ')' : '') + ', so it stays sharp at any size.' }));
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
  $('#fileImage').addEventListener('change', function () {
    var f = this.files && this.files[0];
    var el = imageTarget;
    imageTarget = null;
    if (!f || !el) return;
    if (!isImageFile(f)) return toast('Please choose a JPG or PNG file');
    X.readFile(f, true).then(function (src) {
      change(function () { el.src = src; el.alt = f.name; el.bind.kind = 'none'; });
    });
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

  $('#btnImport').addEventListener('click', function () { $('#fileImport').value = ''; $('#fileImport').click(); });
  $('#fileImport').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    X.readFile(f).then(function (txt) {
      var d = normalizeDoc(X.parseDeckFile(txt));
      var replace = confirm('Replace the current deck with "' + d.name + '"?\n\nOK = replace · Cancel = add its templates to this deck');
      change(function () {
        if (replace) {
          state.doc = d;
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
  });

  /* ---------- keyboard ---------- */

  document.addEventListener('keydown', function (e) {
    if (document.querySelector('.cs-viewer') || dialog.open) return;
    var typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
    var mod = e.metaKey || e.ctrlKey;
    var key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && key === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (typing) return;
    var el = sel();
    if (mod && key === 'd' && el) { e.preventDefault(); pasteElement(el); return; }
    if (mod && key === 'c' && el) { state.clipboard = clone(el); toast('Copied'); return; }
    if (mod && key === 'v' && state.clipboard) { e.preventDefault(); pasteElement(state.clipboard); return; }
    if (mod || e.altKey) return;
    if ((key === 'Delete' || key === 'Backspace') && el) { e.preventDefault(); deleteElement(); return; }
    if (key === 'Escape') { select(null); return; }
    var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[key] && el) {
      e.preventDefault();
      var step = (grid().snap ? grid().size : 0.0625) * (e.shiftKey ? 4 : 1);
      change(function () {
        el.x = round3(clamp(el.x + arrows[key][0] * step, 0, PAGE_W - el.w));
        el.y = round3(clamp(el.y + arrows[key][1] * step, 0, PAGE_H - el.h));
      }, { key: 'nudge:' + el.id });
      return;
    }
    var adds = { t: 'text', b: 'box', r: 'round', i: 'image' };
    if (adds[key]) { e.preventDefault(); addElement(adds[key]); }
  });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { applyZoom(); renderSelection(); fitThumbs(); renderStatus(); }, 60);
  });

  /* ---------- boot ---------- */

  Promise.all([store.get('doc'), store.get('project')]).then(function (res) {
    state.doc = normalizeDoc(res[0] || T.starterDeck());
    // First run: show the sample project so the templates have something to fill.
    state.project = res[1] !== undefined ? res[1] : D.sampleProject();
    var dp = prefs('dataPreview');
    state.dataPreview = dp == null ? true : !!dp;
    state.currentId = state.doc.templates[0] ? state.doc.templates[0].id : null;
    renderAll();
    if (!res[0]) save();
  });

  // Debug / automation hook.
  window.CloudSlidesApp = { state: state, renderAll: renderAll, setProject: setProject };
})();
