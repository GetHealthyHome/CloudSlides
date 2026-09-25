/*
 * CloudSlides renderer — shared by the editor, the presenter and every
 * exported HTML file. It is written as a single self-contained factory so
 * its source can be embedded verbatim into exports (factory.toString()).
 *
 * All geometry is stored in inches, so a slide is always rendered at its
 * physical size (11in x 8.5in, US Letter landscape) and simply scaled on
 * screen. Nothing is rasterised, which is why resizing never loses detail.
 */
(function (root) {
  function factory() {
    var PAGE = { width: 11, height: 8.5, unit: 'in' };
    var DPI = 96; // CSS pixels per inch
    var FONT_STACK = '"SF Pro Display", "SF Pro Text", "SF Hello", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';

    var CSS = [
      '.cs-slide{position:relative;width:11in;height:8.5in;box-sizing:border-box;overflow:hidden;background:#fff;font-family:' + FONT_STACK + ';color:#1d1d1f;-webkit-print-color-adjust:exact;print-color-adjust:exact;}',
      '.cs-slide *{box-sizing:border-box;}',
      '.cs-el{position:absolute;overflow:hidden;}',
      '.cs-line{left:0;top:0;width:11in;height:8.5in;overflow:visible;pointer-events:none;}',
      '.cs-line>svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;}',
      '.cs-line .cs-hit{pointer-events:stroke;}',
      '.cs-text{display:flex;flex-direction:column;white-space:pre-wrap;overflow-wrap:break-word;}',
      '.cs-text>.cs-tx{width:100%;}',
      '.cs-img>img{display:block;width:100%;height:100%;}',
      '.cs-img.cs-empty{display:flex;align-items:center;justify-content:center;}',
      '.cs-print{display:none;}',
      /* viewer */
      '.cs-viewer{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;background:#111214;color:#f5f5f7;font-family:' + FONT_STACK + ';}',
      '.cs-vh{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #2a2b2f;}',
      '.cs-vh .cs-vtitle{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.cs-vh .cs-vcount{font-variant-numeric:tabular-nums;color:#a1a1a6;font-size:14px;}',
      '.cs-vbtn{appearance:none;border:1px solid #3a3b40;background:#1f2024;color:#f5f5f7;border-radius:8px;padding:7px 14px;font:inherit;font-size:14px;cursor:pointer;}',
      '.cs-vbtn:hover{background:#2a2b30;}',
      '.cs-vbtn.cs-primary{background:#0a84ff;border-color:#0a84ff;color:#fff;}',
      '.cs-vbtn.cs-primary:hover{background:#0071e3;}',
      '.cs-vstage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:16px;}',
      '.cs-vframe{position:relative;aspect-ratio:11/8.5;max-width:100%;max-height:100%;width:100%;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.5);background:#fff;}',
      '.cs-vframe>.cs-slide{position:absolute;left:0;top:0;transform-origin:0 0;}',
      '.cs-vf{display:flex;align-items:center;justify-content:center;gap:14px;padding:10px 16px 16px;}',
      '.cs-dots{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:60vw;}',
      '.cs-dot{width:10px;height:10px;border-radius:50%;border:0;padding:0;background:#48494e;cursor:pointer;}',
      '.cs-dot[aria-current="true"]{background:#0a84ff;}',
      '@page{size:letter landscape;margin:0;}',
      '@media print{',
      'html,body{margin:0!important;padding:0!important;background:#fff!important;width:11in!important;height:auto!important;min-height:0!important;overflow:visible!important;}',
      'body>*{display:none!important;}',
      'body>.cs-print{display:block!important;margin:0;padding:0;}',
      '.cs-print>.cs-slide{width:11in!important;height:8.5in!important;margin:0!important;box-shadow:none!important;transform:none!important;page-break-after:always;break-after:page;page-break-inside:avoid;break-inside:avoid;}',
      '.cs-print>.cs-slide:last-child{page-break-after:auto;break-after:auto;}',
      '*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}',
      '}'
    ].join('\n');

    function injectCSS(doc) {
      doc = doc || document;
      if (doc.getElementById('cs-render-css')) return;
      var s = doc.createElement('style');
      s.id = 'cs-render-css';
      s.textContent = CSS;
      doc.head.appendChild(s);
    }

    function get(obj, path) {
      if (obj == null) return undefined;
      var parts = String(path).replace(/\[(\w+)\]/g, '.$1').split('.');
      var cur = obj;
      for (var i = 0; i < parts.length; i++) {
        if (cur == null) return undefined;
        cur = cur[parts[i]];
      }
      return cur;
    }

    function formatValue(v) {
      if (v == null) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    }

    // Replace {{field.path}} placeholders. Unknown fields are left visible
    // (when keepMissing) so a designer can see what still needs data.
    function fillText(str, ctx, keepMissing) {
      return String(str == null ? '' : str).replace(/\{\{\s*([\w.\[\]-]+)\s*\}\}/g, function (m, p) {
        var v = get(ctx, p);
        if (v === undefined) return keepMissing ? m : '';
        return formatValue(v);
      });
    }

    function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

    function filterPhotos(photos, zone, tag) {
      return (photos || []).filter(function (p) {
        if (zone && norm(p.zone) !== norm(zone)) return false;
        if (tag && norm(p.tag) !== norm(tag)) return false;
        return true;
      });
    }

    function countPhotoSlots(tpl) {
      return (tpl.elements || []).filter(function (e) {
        return e.type === 'image' && e.bind && e.bind.kind === 'photo';
      }).length;
    }

    function chunk(list, n) {
      var out = [];
      for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
      return out;
    }

    function baseContext(project) {
      var p = project || {};
      var fields = p.fields || {};
      var ctx = {};
      Object.keys(fields).forEach(function (k) { ctx[k] = fields[k]; });
      ctx.project = fields;
      ctx.photos = p.photos || [];
      ctx.photoCount = ctx.photos.length;
      ctx.today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
      return ctx;
    }

    /*
     * Turn the deck (an ordered list of template references) into concrete
     * slides. A template with a repeat rule becomes one slide per photo
     * chunk (or per zone), which is how "many slides from one template" works.
     */
    function expandDeck(doc, project) {
      var base = baseContext(project);
      var byId = {};
      (doc.templates || []).forEach(function (t) { byId[t.id] = t; });
      var out = [];
      (doc.deck || []).forEach(function (entry) {
        var tpl = byId[entry.templateId];
        if (!tpl) return;
        var rep = tpl.repeat || { mode: 'none' };
        if (!rep.mode || rep.mode === 'none') {
          out.push({ template: tpl, entryId: entry.id, ctx: Object.assign({}, base, { slidePhotos: base.photos, photo: base.photos[0] || {}, repeating: false }) });
          return;
        }
        var per = Math.max(1, Number(rep.perSlide) || countPhotoSlots(tpl) || 1);
        var pool = filterPhotos(base.photos, rep.zone, rep.tag);
        var groups = [];
        if (rep.mode === 'perZone') {
          var order = [];
          var map = {};
          pool.forEach(function (ph) {
            var z = ph.zone || 'General';
            if (!map[z]) { map[z] = []; order.push(z); }
            map[z].push(ph);
          });
          order.forEach(function (z) {
            chunk(map[z], per).forEach(function (c, i, all) {
              groups.push({ zone: z, photos: c, part: i + 1, parts: all.length });
            });
          });
        } else {
          chunk(pool, per).forEach(function (c, i, all) {
            groups.push({ zone: c[0] ? c[0].zone || '' : '', photos: c, part: i + 1, parts: all.length });
          });
        }
        if (!groups.length) groups.push({ zone: rep.zone || '', photos: [], part: 1, parts: 1 });
        groups.forEach(function (g) {
          out.push({
            template: tpl,
            entryId: entry.id,
            ctx: Object.assign({}, base, {
              slidePhotos: g.photos,
              photo: g.photos[0] || {},
              zone: g.zone,
              part: g.part,
              parts: g.parts,
              repeating: true
            })
          });
        });
      });
      out.forEach(function (s, i) { s.ctx.page = i + 1; s.ctx.pages = out.length; });
      return out;
    }

    function colorOrNone(c) { return c && c !== 'none' ? c : 'transparent'; }

    function applyBoxStyle(node, el) {
      var st = node.style;
      st.left = el.x + 'in';
      st.top = el.y + 'in';
      st.width = el.w + 'in';
      st.height = el.h + 'in';
      st.background = colorOrNone(el.fill);
      st.borderRadius = (Number(el.radius) || 0) + 'px';
      if (el.strokeWidth > 0 && el.stroke && el.stroke !== 'none') {
        st.border = el.strokeWidth + 'pt solid ' + el.stroke;
      }
      if (el.opacity != null && el.opacity < 1) st.opacity = el.opacity;
    }

    function resolveImage(el, ctx) {
      var b = el.bind || {};
      if (b.kind === 'photo') {
        var pool = ctx.repeating ? ctx.slidePhotos : ctx.photos;
        pool = filterPhotos(pool, b.zone, b.tag);
        var ph = pool[Number(b.index) || 0];
        return ph ? { src: ph.url, alt: ph.label || ph.zone || 'Project photo' } : null;
      }
      if (b.kind === 'field') {
        if (!b.field) return null; // no field chosen yet: never fall back to an old uploaded file
        // 1) a URL stored in the project data under that field (e.g. payload.front_elevation)
        var v = get(ctx, b.field);
        if (v == null && ctx.project) v = get(ctx.project.payload, b.field);
        if (typeof v === 'string' && /^(https?:|data:image\/|blob:)/.test(v)) return { src: v, alt: b.label || b.field };
        // 2) otherwise the project photo whose label, tag or zone matches the field name
        var key = fieldKey(b.field);
        var hit = (ctx.photos || []).filter(function (p) {
          return fieldKey(p.label) === key || fieldKey(p.tag) === key || fieldKey(p.zone) === key;
        })[0];
        return hit ? { src: hit.url, alt: hit.label || b.label || b.field } : null;
      }
      return el.src ? { src: el.src, alt: el.alt || '' } : null;
    }

    // "Front Elevation", "front_elevation" and "front-elevation" all match.
    function fieldKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

    function describeSlot(el) {
      var b = el.bind || {};
      if (b.kind === 'photo') {
        return 'Photo #' + ((Number(b.index) || 0) + 1) + (b.zone ? ' · ' + b.zone : '') + (b.tag ? ' · ' + b.tag : '');
      }
      if (b.kind === 'field') return b.field ? 'Photo field: ' + (b.label || b.field) : 'Choose a photo field';
      return 'Double-click to add a JPG or PNG';
    }

    var SVGNS = 'http://www.w3.org/2000/svg';

    function svgEl(doc, tag, attrs) {
      var n = doc.createElementNS(SVGNS, tag);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      return n;
    }

    // Bounding box of a line in inches (used by the editor and exports).
    function lineBox(el) {
      return {
        x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2),
        w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1)
      };
    }

    /*
     * A line is drawn in an SVG that covers the page, in inch units
     * (viewBox 0 0 11 8.5), so it stays razor sharp at any zoom or in print.
     * Only the stroke itself catches clicks, so items underneath stay clickable.
     */
    function renderLine(el, doc) {
      var node = doc.createElement('div');
      node.className = 'cs-el cs-line';
      node.setAttribute('data-id', el.id);
      if (el.opacity != null && el.opacity < 1) node.style.opacity = el.opacity;
      var color = el.stroke && el.stroke !== 'none' ? el.stroke : '#1d1d1f';
      var sw = Math.max(0.25, Number(el.strokeWidth) || 1) / 72; // pt -> in
      var svg = svgEl(doc, 'svg', { viewBox: '0 0 ' + PAGE.width + ' ' + PAGE.height, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      var x1 = el.x1, y1 = el.y1, x2 = el.x2, y2 = el.y2;
      var dx = x2 - x1, dy = y2 - y1;
      var len = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      var ux = dx / len, uy = dy / len;
      var head = Math.max(0.09, sw * 4.5);
      var heads = [];
      if (el.capEnd === 'arrow') heads.push([x2, y2, ux, uy]);
      if (el.capStart === 'arrow') heads.push([x1, y1, -ux, -uy]);
      // Pull the stroke back so it does not poke through the arrow tip.
      var sx1 = x1, sy1 = y1, sx2 = x2, sy2 = y2;
      if (el.capEnd === 'arrow' && len > head) { sx2 = x2 - ux * head * 0.7; sy2 = y2 - uy * head * 0.7; }
      if (el.capStart === 'arrow' && len > head) { sx1 = x1 + ux * head * 0.7; sy1 = y1 + uy * head * 0.7; }
      var dash = { dashed: (sw * 4) + ' ' + (sw * 3), dotted: '0 ' + (sw * 2.2) }[el.dash] || null;
      var attrs = { x1: sx1, y1: sy1, x2: sx2, y2: sy2, stroke: color, 'stroke-width': sw, 'stroke-linecap': el.dash === 'dotted' ? 'round' : 'butt', fill: 'none' };
      if (dash) attrs['stroke-dasharray'] = dash;
      svg.appendChild(svgEl(doc, 'line', attrs));
      heads.forEach(function (hd) {
        var tx = hd[0], ty = hd[1], hx = hd[2], hy = hd[3];
        var bx = tx - hx * head, by = ty - hy * head;
        var px = -hy * head * 0.45, py = hx * head * 0.45;
        svg.appendChild(svgEl(doc, 'polygon', {
          points: tx + ',' + ty + ' ' + (bx + px) + ',' + (by + py) + ' ' + (bx - px) + ',' + (by - py),
          fill: color
        }));
      });
      // Wide invisible stroke so thin lines are easy to click in the editor.
      svg.appendChild(svgEl(doc, 'line', { class: 'cs-hit', x1: x1, y1: y1, x2: x2, y2: y2, stroke: 'transparent', 'stroke-width': Math.max(sw, 0.12) }));
      node.appendChild(svg);
      return node;
    }

    // Bar values may be numbers or placeholders like {{payload.cfm50}}; "$8,450" -> 8450.
    function toNumber(v) {
      var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
      return isFinite(n) ? n : 0;
    }

    function chartBars(el, ctx, useData) {
      return (el.bars || []).map(function (b) {
        var label = useData ? fillText(b.label, ctx, false) : String(b.label || '');
        var raw = useData ? fillText(b.value, ctx, false) : b.value;
        return { label: label, value: Math.max(0, toNumber(raw)) };
      });
    }

    // Round the axis top up to 1, 2, 2.5 or 5 x 10^n so tick labels stay tidy.
    function niceStep(v) {
      if (!(v > 0)) return 1;
      var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
      var f = v / e;
      return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
    }

    function fmtNum(n, el) {
      var dec = Math.max(0, Math.min(4, Number(el.decimals) || 0));
      return (el.prefix || '') + n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + (el.suffix || '');
    }

    function fitLabel(s, maxW, fs) {
      var maxChars = Math.max(1, Math.floor(maxW / (fs * 0.55)));
      return s.length > maxChars ? s.slice(0, Math.max(1, maxChars - 1)) + '\u2026' : s;
    }

    /*
     * Simple vertical bar chart, drawn as SVG in point units (viewBox = box
     * size in pt) so font sizes match text boxes and it prints crisply.
     * One series, one color; values are labelled in text ink above each bar.
     */
    function renderChart(el, ctx, opts, doc) {
      var node = doc.createElement('div');
      node.className = 'cs-el cs-chart';
      node.setAttribute('data-id', el.id);
      applyBoxStyle(node, el);
      var useData = opts.mode !== 'edit' || opts.data;
      var bars = chartBars(el, ctx, useData);
      var W = el.w * 72, H = el.h * 72;
      var fs = Number(el.fontSize) || 10;
      var ink = el.color || '#4a4a4a';
      var barColor = el.barColor || '#2f7d45';
      var maxV = 0;
      bars.forEach(function (b) { if (b.value > maxV) maxV = b.value; });
      var step = niceStep((maxV || 1) / 4);
      var top = Math.max(step, Math.ceil(maxV / step) * step);
      var ticks = [];
      for (var t = 0; t <= top + step / 2; t += step) ticks.push(t);
      var axisW = el.showAxis === false ? 0 : Math.max.apply(null, ticks.map(function (v) { return fmtNum(v, el).length; })) * fs * 0.58 + 6;
      var pad = 4;
      var left = pad + axisW, right = W - pad;
      var plotTop = pad + (el.showValues === false ? fs * 0.6 : fs * 1.7);
      var base = H - pad - fs * 1.9;
      var ph = Math.max(1, base - plotTop), pw = Math.max(1, right - left);

      var svg = svgEl(doc, 'svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img',
        'aria-label': 'Bar chart: ' + bars.map(function (b) { return b.label + ' ' + fmtNum(b.value, el); }).join(', ') });
      svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;font-family:' + FONT_STACK + ';';
      function txt(x, y, s, anchor, size, weight) {
        var n = svgEl(doc, 'text', { x: x, y: y, 'text-anchor': anchor, fill: ink, 'font-size': size || fs, 'font-weight': weight || 400 });
        n.textContent = s;
        svg.appendChild(n);
      }
      ticks.forEach(function (v) {
        var y = base - (v / top) * ph;
        if (el.showGrid !== false && v > 0) svg.appendChild(svgEl(doc, 'line', { x1: left, x2: right, y1: y, y2: y, stroke: el.gridColor || '#d9d9d9', 'stroke-width': 0.5 }));
        if (el.showAxis !== false) txt(left - 5, y + fs * 0.35, fmtNum(v, el), 'end', fs * 0.9);
      });
      var n = Math.max(1, bars.length);
      var band = pw / n;
      var bw = Math.max(1, Math.min(band * 0.64, band - 1.5)); // at least a 1.5pt gap between bars
      bars.forEach(function (b, i) {
        var bh = (b.value / top) * ph;
        var x = left + i * band + (band - bw) / 2;
        var y = base - bh;
        if (bh > 0) {
          var r = Math.min(3, bw / 2, bh); // rounded data end, square at the baseline
          svg.appendChild(svgEl(doc, 'path', {
            d: 'M' + x + ',' + base + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + y + ' ' + (x + bw) + ',' + (y + r) + 'V' + base + 'Z',
            fill: barColor
          }));
        }
        if (el.showValues !== false) txt(x + bw / 2, y - fs * 0.45, fmtNum(b.value, el), 'middle', fs, 600);
        txt(left + i * band + band / 2, base + fs * 1.35, fitLabel(b.label, band - 2, fs), 'middle', fs);
      });
      svg.appendChild(svgEl(doc, 'line', { x1: left, x2: right, y1: base, y2: base, stroke: ink, 'stroke-width': 0.75 }));
      node.appendChild(svg);
      return node;
    }

    // opts: { mode: 'edit'|'preview'|'final', data: bool }
    function renderElement(el, ctx, opts, doc) {
      doc = doc || document;
      if (el.type === 'line') return renderLine(el, doc);
      if (el.type === 'chart') return renderChart(el, ctx || {}, opts || { mode: 'final' }, doc);
      var node = doc.createElement('div');
      node.className = 'cs-el cs-' + el.type;
      node.setAttribute('data-id', el.id);
      applyBoxStyle(node, el);

      if (el.type === 'text') {
        var st = node.style;
        st.color = el.color || '#1d1d1f';
        st.fontSize = (el.fontSize || 18) + 'pt';
        st.fontWeight = el.fontWeight || 400;
        st.fontStyle = el.italic ? 'italic' : 'normal';
        st.textAlign = el.align || 'left';
        st.lineHeight = el.lineHeight || 1.25;
        st.letterSpacing = (el.letterSpacing || 0) + 'em';
        st.padding = (el.padding != null ? el.padding : 0.08) + 'in';
        st.justifyContent = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[el.vAlign || 'top'];
        var tx = doc.createElement('div');
        tx.className = 'cs-tx';
        var useData = opts.mode !== 'edit' || opts.data;
        tx.textContent = useData ? fillText(el.text, ctx, opts.mode !== 'final') : (el.text || '');
        node.appendChild(tx);
      } else if (el.type === 'image') {
        var useImgData = opts.mode !== 'edit' || opts.data || !(el.bind && el.bind.kind && el.bind.kind !== 'none');
        var img = useImgData ? resolveImage(el, ctx) : null;
        if (img) {
          var im = doc.createElement('img');
          im.src = img.src;
          im.alt = img.alt;
          im.draggable = false;
          im.decoding = 'async';
          im.style.objectFit = el.fit || 'cover';
          im.style.objectPosition = el.position || 'center';
          node.appendChild(im);
        } else if (opts.mode !== 'final') {
          node.classList.add('cs-empty');
          if (!el.fill || el.fill === 'none') node.style.background = 'repeating-linear-gradient(45deg,#eef1f5 0 10px,#e3e7ee 10px 20px)';
          var lab = doc.createElement('div');
          lab.style.cssText = 'font-size:11pt;color:#6e6e73;text-align:center;padding:6px;';
          lab.textContent = describeSlot(el);
          node.appendChild(lab);
        }
      }
      return node;
    }

    function renderSlide(tpl, ctx, opts, doc) {
      doc = doc || document;
      opts = opts || { mode: 'final' };
      var slide = doc.createElement('section');
      slide.className = 'cs-slide';
      slide.setAttribute('data-template', tpl.id);
      slide.style.background = colorOrNone(tpl.background || '#ffffff');
      (tpl.elements || []).forEach(function (el) {
        slide.appendChild(renderElement(el, ctx || {}, opts, doc));
      });
      return slide;
    }

    function renderDeck(doc, project, opts) {
      opts = opts || { mode: 'final' };
      return expandDeck(doc, project).map(function (s) {
        return renderSlide(s.template, s.ctx, opts);
      });
    }

    function buildPrintRoot(slides, docRef) {
      docRef = docRef || document;
      var old = docRef.querySelector('body > .cs-print');
      if (old) old.remove();
      var pr = docRef.createElement('div');
      pr.className = 'cs-print';
      slides.forEach(function (s) { pr.appendChild(s); });
      docRef.body.appendChild(pr);
      return pr;
    }

    function waitForImages(rootEl, timeoutMs) {
      var imgs = Array.prototype.slice.call(rootEl.querySelectorAll('img'));
      var all = Promise.all(imgs.map(function (im) {
        if (im.complete) return Promise.resolve();
        return new Promise(function (res) { im.onload = im.onerror = function () { res(); }; });
      }));
      return Promise.race([all, new Promise(function (res) { setTimeout(res, timeoutMs || 8000); })]);
    }

    // Render every slide into a print-only container and open the print
    // dialog; choose "Save as PDF" to get one Letter-landscape page per slide.
    function printSlides(slides) {
      var pr = buildPrintRoot(slides);
      return waitForImages(pr, 8000).then(function () {
        var cleanup = function () { pr.remove(); window.removeEventListener('afterprint', cleanup); };
        window.addEventListener('afterprint', cleanup);
        window.print();
      });
    }

    /*
     * Slide viewer: sequential stage that keeps the 11:8.5 ratio, arrow /
     * space keyboard navigation, dots, prev/next and an Export / Print PDF
     * button. makeSlides() is called again for printing so print gets fresh
     * nodes.
     */
    function mountViewer(opts) {
      injectCSS(document);
      var makeSlides = opts.makeSlides;
      var slides = makeSlides();
      var idx = Math.min(opts.start || 0, Math.max(0, slides.length - 1));
      var v = document.createElement('div');
      v.className = 'cs-viewer';
      v.setAttribute('role', 'dialog');
      v.setAttribute('aria-label', 'Slide presentation');
      v.innerHTML =
        '<header class="cs-vh"><div class="cs-vtitle"></div><div class="cs-vcount" aria-live="polite"></div>' +
        '<button type="button" class="cs-vbtn cs-primary" data-act="print">Export / Print PDF</button>' +
        (opts.onClose ? '<button type="button" class="cs-vbtn" data-act="close" aria-label="Close presentation">Close</button>' : '') +
        '</header><main class="cs-vstage"><div class="cs-vframe"></div></main>' +
        '<footer class="cs-vf"><button type="button" class="cs-vbtn" data-act="prev" aria-label="Previous slide">&#8592; Prev</button>' +
        '<div class="cs-dots" role="tablist"></div>' +
        '<button type="button" class="cs-vbtn" data-act="next" aria-label="Next slide">Next &#8594;</button></footer>';
      v.querySelector('.cs-vtitle').textContent = opts.title || 'Presentation';
      var frame = v.querySelector('.cs-vframe');
      var stage = v.querySelector('.cs-vstage');
      var dots = v.querySelector('.cs-dots');
      var count = v.querySelector('.cs-vcount');

      slides.forEach(function (_, i) {
        var d = document.createElement('button');
        d.type = 'button';
        d.className = 'cs-dot';
        d.setAttribute('aria-label', 'Go to slide ' + (i + 1));
        d.addEventListener('click', function () { go(i); });
        dots.appendChild(d);
      });

      function fit() {
        var sw = stage.clientWidth - 32, sh = stage.clientHeight - 32;
        var ratio = PAGE.width / PAGE.height;
        var w = Math.max(50, Math.min(sw, sh * ratio));
        frame.style.width = w + 'px';
        frame.style.height = (w / ratio) + 'px';
        var s = frame.firstChild;
        if (s) s.style.transform = 'scale(' + (w / (PAGE.width * DPI)) + ')';
      }

      function go(i) {
        if (!slides.length) { count.textContent = 'No slides'; return; }
        idx = (i + slides.length) % slides.length;
        frame.innerHTML = '';
        frame.appendChild(slides[idx]);
        count.textContent = (idx + 1) + ' / ' + slides.length;
        Array.prototype.forEach.call(dots.children, function (d, j) {
          d.setAttribute('aria-current', j === idx ? 'true' : 'false');
        });
        fit();
      }

      function onKey(e) {
        if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); go(idx + 1); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(idx - 1); }
        else if (e.key === 'Home') { go(0); }
        else if (e.key === 'End') { go(slides.length - 1); }
        else if (e.key === 'Escape' && opts.onClose) { close(); }
      }

      function close() {
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', fit);
        v.remove();
        if (opts.onClose) opts.onClose();
      }

      v.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]');
        if (!b) return;
        var a = b.getAttribute('data-act');
        if (a === 'prev') go(idx - 1);
        if (a === 'next') go(idx + 1);
        if (a === 'close') close();
        if (a === 'print') printSlides(makeSlides());
      });
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', fit);
      (opts.parent || document.body).appendChild(v);
      go(idx);
      return { go: go, close: close, el: v };
    }

    return {
      version: 1,
      PAGE: PAGE,
      DPI: DPI,
      FONT_STACK: FONT_STACK,
      CSS: CSS,
      injectCSS: injectCSS,
      get: get,
      fillText: fillText,
      filterPhotos: filterPhotos,
      countPhotoSlots: countPhotoSlots,
      expandDeck: expandDeck,
      renderElement: renderElement,
      lineBox: lineBox,
      chartBars: chartBars,
      fieldKey: fieldKey,
      renderSlide: renderSlide,
      renderDeck: renderDeck,
      buildPrintRoot: buildPrintRoot,
      waitForImages: waitForImages,
      printSlides: printSlides,
      mountViewer: mountViewer
    };
  }

  root.CloudSlidesRender = factory();
  root.CloudSlidesRender.factorySource = factory.toString();
})(typeof window !== 'undefined' ? window : this);
