/*
 * PowerPoint (.pptx) importer — Google Slides: File > Download > .pptx.
 *
 * Runs entirely in the browser with no libraries: a small ZIP reader
 * (inflating with the built-in DecompressionStream) plus DOMParser for the
 * slide XML. Every shape becomes a native, editable CloudSlides element:
 *   text boxes -> text, rect/roundRect/ellipse -> box, connectors -> line,
 *   pictures -> image, tables -> a grid of boxes + text, groups -> flattened.
 * Geometry is converted from EMU (914400 per inch) and fitted onto the
 * 11 x 8.5 in page.
 */
(function (root) {
  var T = root.CloudSlidesTemplates;
  var EMU = 914400;
  var PAGE_W = 11, PAGE_H = 8.5;

  /* ---------- ZIP ---------- */

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function readZip(buf) {
    var b = new Uint8Array(buf);
    var eocd = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not a .pptx file (no ZIP directory found).');
    var count = u16(b, eocd + 10);
    var off = u32(b, eocd + 16);
    var entries = {};
    var dec = new TextDecoder();
    for (var n = 0; n < count; n++) {
      if (u32(b, off) !== 0x02014b50) throw new Error('The .pptx file looks damaged.');
      var method = u16(b, off + 10);
      var csize = u32(b, off + 20);
      var nameLen = u16(b, off + 28), extraLen = u16(b, off + 30), commentLen = u16(b, off + 32);
      var local = u32(b, off + 42);
      var name = dec.decode(b.subarray(off + 46, off + 46 + nameLen));
      entries[name] = { method: method, csize: csize, local: local };
      off += 46 + nameLen + extraLen + commentLen;
    }
    function bytes(name) {
      var e = entries[name];
      if (!e) return Promise.resolve(null);
      var lo = e.local;
      var start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
      var data = b.subarray(start, start + e.csize);
      if (e.method === 0) return Promise.resolve(data.slice());
      if (e.method !== 8) return Promise.reject(new Error('Unsupported compression in ' + name));
      if (typeof DecompressionStream === 'undefined') {
        return Promise.reject(new Error('This browser cannot unzip files. Please use a current Chrome, Edge, Safari or Firefox.'));
      }
      var ds = new DecompressionStream('deflate-raw');
      var stream = new Blob([data]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    }
    return {
      has: function (name) { return !!entries[name]; },
      bytes: bytes,
      text: function (name) { return bytes(name).then(function (u) { return u ? new TextDecoder().decode(u) : null; }); }
    };
  }

  /* ---------- XML helpers (namespace-agnostic, by local name) ---------- */

  function parseXml(s) {
    if (!s) return null;
    var d = new DOMParser().parseFromString(s, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) return null;
    return d.documentElement;
  }
  function kids(node, name) {
    var out = [];
    if (!node) return out;
    for (var c = node.firstElementChild; c; c = c.nextElementSibling) if (!name || c.localName === name) out.push(c);
    return out;
  }
  function kid(node, name) { return kids(node, name)[0] || null; }
  function path(node) {
    for (var i = 1; i < arguments.length && node; i++) node = kid(node, arguments[i]);
    return node;
  }
  function all(node, name) {
    return node ? Array.prototype.slice.call(node.getElementsByTagNameNS('*', name)) : [];
  }
  function attr(node, name) { return node ? node.getAttribute(name) : null; }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function rid(node, name) {
    if (!node) return null;
    return node.getAttribute('r:' + name) || node.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', name);
  }

  function dirOf(p) { return p.slice(0, p.lastIndexOf('/') + 1); }
  function resolvePath(base, target) {
    if (target.charAt(0) === '/') return target.slice(1);
    var parts = (dirOf(base) + target).split('/');
    var out = [];
    parts.forEach(function (p) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); });
    return out.join('/');
  }
  function relsPath(p) { return dirOf(p) + '_rels/' + p.slice(p.lastIndexOf('/') + 1) + '.rels'; }

  function readRels(zip, partPath) {
    return zip.text(relsPath(partPath)).then(function (s) {
      var map = {};
      kids(parseXml(s), 'Relationship').forEach(function (r) {
        map[attr(r, 'Id')] = { type: attr(r, 'Type') || '', target: resolvePath(partPath, attr(r, 'Target') || ''), external: attr(r, 'TargetMode') === 'External' };
      });
      return map;
    });
  }
  function relOfType(rels, suffix) {
    for (var k in rels) if (rels[k].type.slice(-suffix.length) === suffix) return rels[k];
    return null;
  }

  /* ---------- colors ---------- */

  function hex2(n) { n = Math.max(0, Math.min(255, Math.round(n))); return (n < 16 ? '0' : '') + n.toString(16); }
  function rgbToHex(r, g, b) { return '#' + hex2(r) + hex2(g) + hex2(b); }
  function hexToRgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0;
    if (mx !== mn) {
      var d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    if (!s) return [l * 255, l * 255, l * 255];
    function f(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
  }

  var SCHEME_ALIAS = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };

  // Resolve <a:srgbClr>, <a:schemeClr>, <a:sysClr>, <a:prstClr> with lumMod/lumOff/tint/shade.
  function colorOf(node, theme) {
    if (!node) return null;
    var c = node.firstElementChild;
    if (!c) return null;
    var hex = null;
    if (c.localName === 'srgbClr') hex = '#' + attr(c, 'val');
    else if (c.localName === 'schemeClr') {
      var v = attr(c, 'val');
      hex = theme[SCHEME_ALIAS[v] || v] || null;
    } else if (c.localName === 'sysClr') hex = '#' + (attr(c, 'lastClr') || '000000');
    else if (c.localName === 'prstClr') hex = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000' }[attr(c, 'val')] || '#000000';
    if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
    var rgb = hexToRgb(hex);
    var hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    var alpha = 1;
    kids(c).forEach(function (m) {
      var val = num(attr(m, 'val'), 100000) / 100000;
      if (m.localName === 'lumMod') hsl[2] *= val;
      else if (m.localName === 'lumOff') hsl[2] += val;
      else if (m.localName === 'tint') hsl[2] = hsl[2] + (1 - hsl[2]) * (1 - val);
      else if (m.localName === 'shade') hsl[2] *= val;
      else if (m.localName === 'alpha') alpha = val;
    });
    hsl[2] = Math.max(0, Math.min(1, hsl[2]));
    var out = hslToRgb(hsl[0], hsl[1], hsl[2]);
    return { hex: rgbToHex(out[0], out[1], out[2]), alpha: alpha };
  }

  // Solid fill of a spPr / tcPr / bgPr, or 'none', or null if unspecified.
  function fillOf(pr, theme) {
    if (!pr) return null;
    if (kid(pr, 'noFill')) return { none: true };
    var sf = kid(pr, 'solidFill');
    if (sf) return colorOf(sf, theme);
    var gf = kid(pr, 'gradFill');
    if (gf) { // use the first stop so the area keeps roughly the right tone
      var gs = path(gf, 'gsLst', 'gs');
      if (gs) return colorOf(gs, theme);
    }
    return null;
  }

  function readTheme(xml) {
    var theme = {};
    var cs = all(xml, 'clrScheme')[0];
    kids(cs).forEach(function (c) {
      var inner = c.firstElementChild;
      if (!inner) return;
      theme[c.localName] = inner.localName === 'sysClr' ? '#' + (attr(inner, 'lastClr') || '000000') : '#' + attr(inner, 'val');
    });
    return theme;
  }

  /* ---------- geometry ---------- */

  // transform stack for groups: maps child EMU coords to slide EMU coords.
  function identity() { return { sx: 1, sy: 1, ox: 0, oy: 0 }; }
  function xfrmOf(spPr) {
    var x = kid(spPr, 'xfrm');
    if (!x) return null;
    var off = kid(x, 'off'), ext = kid(x, 'ext');
    if (!off || !ext) return null;
    return {
      x: num(attr(off, 'x'), 0), y: num(attr(off, 'y'), 0),
      w: num(attr(ext, 'cx'), 0), h: num(attr(ext, 'cy'), 0),
      rot: num(attr(x, 'rot'), 0) / 60000,
      flipH: attr(x, 'flipH') === '1', flipV: attr(x, 'flipV') === '1'
    };
  }
  function apply(tf, r) {
    return { x: r.x * tf.sx + tf.ox, y: r.y * tf.sy + tf.oy, w: r.w * tf.sx, h: r.h * tf.sy, rot: r.rot, flipH: r.flipH, flipV: r.flipV };
  }

  /* ---------- import ---------- */

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'photo'; }

  function bytesToDataUrl(u8, mime) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return 'data:' + mime + ';base64,' + btoa(s);
  }
  var MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' };

  /*
   * opts: { fit: 'fit'|'stretch', photoFields: bool }
   * Resolves { name, slideSize: {w,h}, templates: [...], fields: [...], report }
   */
  function importPptx(arrayBuffer, opts) {
    opts = opts || {};
    var zip = readZip(arrayBuffer);
    var report = { slides: 0, text: 0, shapes: 0, lines: 0, images: 0, tables: 0, photoSlots: 0, skipped: {}, rotated: 0 };
    function skip(what) { report.skipped[what] = (report.skipped[what] || 0) + 1; }

    var presPath = 'ppt/presentation.xml';
    return Promise.all([zip.text(presPath), readRels(zip, presPath)]).then(function (r) {
      var pres = parseXml(r[0]);
      if (!pres) throw new Error('This file has no slides (ppt/presentation.xml missing).');
      var presRels = r[1];
      var sz = kid(pres, 'sldSz');
      var slideW = num(attr(sz, 'cx'), 9144000) / EMU, slideH = num(attr(sz, 'cy'), 6858000) / EMU;
      var sx = PAGE_W / slideW, sy = PAGE_H / slideH, ox = 0, oy = 0;
      if (opts.fit !== 'stretch') {
        var s = Math.min(sx, sy);
        ox = (PAGE_W - slideW * s) / 2; oy = (PAGE_H - slideH * s) / 2;
        sx = sy = s;
      }
      var fontScale = Math.min(sx, sy);
      var slidePaths = kids(kid(pres, 'sldIdLst'), 'sldId').map(function (n) {
        var rel = presRels[rid(n, 'id')];
        return rel ? rel.target : null;
      }).filter(Boolean);
      var themeRel = relOfType(presRels, '/theme');
      return (themeRel ? zip.text(themeRel.target) : Promise.resolve(null)).then(function (themeXml) {
        var theme = themeXml ? readTheme(parseXml(themeXml)) : {};
        var ctx = { zip: zip, theme: theme, sx: sx, sy: sy, ox: ox, oy: oy, fontScale: fontScale, opts: opts, report: report, skip: skip, usedFields: {}, fields: [] };
        var templates = [];
        return slidePaths.reduce(function (p, sp, i) {
          return p.then(function () {
            return importSlide(ctx, sp, i).then(function (t) { if (t) templates.push(t); });
          });
        }, Promise.resolve()).then(function () {
          report.slides = templates.length;
          return { slideSize: { w: slideW, h: slideH }, templates: templates, fields: ctx.fields, report: report };
        });
      });
    });
  }

  function toIn(ctx, r) {
    return {
      x: r.x / EMU * ctx.sx + ctx.ox, y: r.y / EMU * ctx.sy + ctx.oy,
      w: r.w / EMU * ctx.sx, h: r.h / EMU * ctx.sy
    };
  }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function clampBox(b) {
    var x = Math.max(0, b.x), y = Math.max(0, b.y);
    var w = Math.min(b.w - (x - b.x), PAGE_W - x), h = Math.min(b.h - (y - b.y), PAGE_H - y);
    return { x: r3(x), y: r3(y), w: r3(Math.max(0.05, w)), h: r3(Math.max(0.05, h)) };
  }

  // Placeholder shapes without their own position inherit it from the layout/master.
  function placeholderIndex(xml) {
    var map = {};
    if (!xml) return map;
    all(xml, 'sp').concat(all(xml, 'pic')).forEach(function (sp) {
      var ph = all(sp, 'ph')[0];
      var pr = kid(sp, 'spPr');
      var xf = xfrmOf(pr);
      if (!ph || !xf) return;
      var type = attr(ph, 'type') || 'body', idx = attr(ph, 'idx');
      if (idx != null) map['idx:' + idx] = map['idx:' + idx] || { xf: xf, sp: sp };
      map['type:' + type] = map['type:' + type] || { xf: xf, sp: sp };
    });
    return map;
  }

  function importSlide(ctx, slidePath, index) {
    var zip = ctx.zip;
    return Promise.all([zip.text(slidePath), readRels(zip, slidePath)]).then(function (r) {
      var xml = parseXml(r[0]);
      if (!xml) return null;
      var rels = r[1];
      var layoutRel = relOfType(rels, '/slideLayout');
      return (layoutRel ? Promise.all([zip.text(layoutRel.target), readRels(zip, layoutRel.target)]) : Promise.resolve([null, {}])).then(function (lr) {
        var layout = parseXml(lr[0]);
        var masterRel = relOfType(lr[1], '/slideMaster');
        return (masterRel ? zip.text(masterRel.target) : Promise.resolve(null)).then(function (mx) {
          var master = parseXml(mx);
          var inherit = { layout: placeholderIndex(layout), master: placeholderIndex(master) };
          var tpl = T.newTemplate('Slide ' + (index + 1));
          // Background: slide, then layout, then master.
          var bg = null;
          [xml, layout, master].some(function (x) {
            var bgPr = x && path(x, 'cSld', 'bg', 'bgPr');
            var f = fillOf(bgPr, ctx.theme);
            if (f && !f.none) { bg = f.hex; return true; }
            var bgRef = x && path(x, 'cSld', 'bg', 'bgRef');
            var rc = bgRef && colorOf(bgRef, ctx.theme);
            if (rc) { bg = rc.hex; return true; }
            return false;
          });
          tpl.background = bg || '#ffffff';
          var els = [];
          var slideCtx = { slidePath: slidePath, rels: rels, inherit: inherit, els: els };
          var tree = path(xml, 'cSld', 'spTree');
          return walk(ctx, slideCtx, tree, identity()).then(function () {
            tpl.elements = els;
            var firstText = els.filter(function (e) { return e.type === 'text' && String(e.text).trim(); })[0];
            tpl.name = (index + 1) + ' · ' + (firstText ? String(firstText.text).split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 40) : 'Slide');
            return tpl;
          });
        });
      });
    });
  }

  function walk(ctx, sc, tree, tf) {
    var p = Promise.resolve();
    kids(tree).forEach(function (node) {
      p = p.then(function () {
        switch (node.localName) {
          case 'sp': return shape(ctx, sc, node, tf);
          case 'cxnSp': return connector(ctx, sc, node, tf);
          case 'pic': return picture(ctx, sc, node, tf);
          case 'grpSp': return group(ctx, sc, node, tf);
          case 'graphicFrame': return frame(ctx, sc, node, tf);
          case 'AlternateContent': {
            var fb = kid(node, 'Fallback') || kid(node, 'Choice');
            return fb ? walk(ctx, sc, fb, tf) : null;
          }
          default: return null;
        }
      });
    });
    return p;
  }

  function group(ctx, sc, node, tf) {
    var x = kid(kid(node, 'grpSpPr'), 'xfrm');
    if (!x) return walk(ctx, sc, node, tf);
    var off = kid(x, 'off'), ext = kid(x, 'ext'), chOff = kid(x, 'chOff'), chExt = kid(x, 'chExt');
    var gx = num(attr(off, 'x'), 0), gy = num(attr(off, 'y'), 0), gw = num(attr(ext, 'cx'), 1), gh = num(attr(ext, 'cy'), 1);
    var cx = num(attr(chOff, 'x'), gx), cy = num(attr(chOff, 'y'), gy), cw = num(attr(chExt, 'cx'), gw) || 1, ch = num(attr(chExt, 'cy'), gh) || 1;
    var ksx = gw / cw, ksy = gh / ch;
    // child -> group -> parent
    var inner = { sx: tf.sx * ksx, sy: tf.sy * ksy, ox: tf.ox + tf.sx * (gx - cx * ksx), oy: tf.oy + tf.sy * (gy - cy * ksy) };
    return walk(ctx, sc, node, inner);
  }

  function inheritedXfrm(sc, node) {
    var ph = all(node, 'ph')[0];
    if (!ph) return null;
    var idx = attr(ph, 'idx'), type = attr(ph, 'type') || 'body';
    var hit = (idx != null && (sc.inherit.layout['idx:' + idx] || sc.inherit.master['idx:' + idx])) ||
      sc.inherit.layout['type:' + type] || sc.inherit.master['type:' + type];
    return hit ? hit.xf : null;
  }

  function lineOf(spPr, ctx) {
    var ln = kid(spPr, 'ln');
    if (!ln || kid(ln, 'noFill')) return null;
    var c = colorOf(kid(ln, 'solidFill'), ctx.theme);
    if (!c) return null;
    var dash = attr(kid(ln, 'prstDash'), 'val') || 'solid';
    return {
      color: c.hex,
      width: Math.max(0.25, num(attr(ln, 'w'), 12700) / 12700 * ctx.fontScale),
      dash: /dot/i.test(dash) ? 'dotted' : (dash === 'solid' ? 'solid' : 'dashed'),
      head: kid(ln, 'headEnd') && (attr(kid(ln, 'headEnd'), 'type') || 'none') !== 'none',
      tail: kid(ln, 'tailEnd') && (attr(kid(ln, 'tailEnd'), 'type') || 'none') !== 'none'
    };
  }

  var PHOTO_RE = /^\s*\[\s*(?:photo|image|picture)\s*[:\-–]\s*([^\]]+?)\s*\]\s*$/i;

  function addPhotoField(ctx, label) {
    var base = slug(label), key = base, n = 2;
    while (ctx.usedFields[key]) key = base + '_' + n++;
    ctx.usedFields[key] = true;
    ctx.fields.push({ key: key, label: label.trim() });
    return key;
  }

  function shape(ctx, sc, node, tf) {
    var spPr = kid(node, 'spPr');
    var xf = xfrmOf(spPr) || inheritedXfrm(sc, node);
    if (!xf) { ctx.skip('shape without position'); return; }
    if (xf.rot) ctx.report.rotated++;
    var box = clampBox(toIn(ctx, apply(tf, xf)));
    var geom = attr(kid(spPr, 'prstGeom'), 'prst') || (kid(spPr, 'custGeom') ? 'custom' : 'rect');
    var fill = fillOf(spPr, ctx.theme);
    if (!fill) {
      // theme style reference (<p:style><a:fillRef idx="…"><a:schemeClr/></a:fillRef>)
      var fr = path(node, 'style', 'fillRef');
      if (fr && num(attr(fr, 'idx'), 0) > 0) fill = colorOf(fr, ctx.theme);
    }
    var ln = lineOf(spPr, ctx);
    if (geom === 'line' || geom === 'straightConnector1') return connector(ctx, sc, node, tf);

    var txBody = kid(node, 'txBody');
    var text = txBody ? readText(ctx, txBody) : null;
    var hasText = text && text.text.trim().length > 0;
    var hasFill = fill && !fill.none;

    var radius = 0;
    if (geom === 'roundRect') {
      var adj = all(kid(spPr, 'prstGeom'), 'gd').filter(function (g) { return attr(g, 'name') === 'adj'; })[0];
      var frac = adj ? num(String(attr(adj, 'fmla')).replace(/^val\s+/, ''), 16667) / 100000 : 0.16667;
      radius = Math.round(Math.min(box.w, box.h) * frac * 96);
    } else if (geom === 'ellipse' || geom === 'flowChartConnector') {
      radius = Math.round(Math.min(box.w, box.h) * 96 / 2);
    } else if (geom !== 'rect' && geom !== 'custom' && (hasFill || ln)) {
      ctx.skip('“' + geom + '” shape (imported as a box)');
    }

    // "[Photo: Front of home]" placeholders become photo fields.
    var m = hasText && ctx.opts.photoFields !== false && PHOTO_RE.exec(text.text);
    if (m) {
      var key = addPhotoField(ctx, m[1]);
      var img = T.makeElement('image');
      Object.assign(img, box, {
        bind: { kind: 'field', field: key, label: m[1].trim(), index: 0, zone: '', tag: '' },
        fill: hasFill ? fill.hex : 'none', radius: radius,
        stroke: ln ? ln.color : 'none', strokeWidth: ln ? ln.width : 0, opacity: 1
      });
      sc.els.push(img);
      ctx.report.photoSlots++;
      return;
    }

    if (hasFill || ln) {
      var bx = T.makeElement('box');
      Object.assign(bx, box, {
        fill: hasFill ? fill.hex : 'none', radius: radius,
        stroke: ln ? ln.color : 'none', strokeWidth: ln ? ln.width : 0,
        opacity: hasFill && fill.alpha < 1 ? r3(fill.alpha) : 1
      });
      sc.els.push(bx);
      ctx.report.shapes++;
    }
    if (hasText) {
      var tx = T.makeElement('text');
      Object.assign(tx, box, text.style, { text: text.text, fill: 'none', stroke: 'none', strokeWidth: 0, radius: 0 });
      sc.els.push(tx);
      ctx.report.text++;
    }
  }

  // One CloudSlides text box holds one style, so the first styled run wins;
  // paragraphs and line breaks are kept.
  function readText(ctx, txBody) {
    var bodyPr = kid(txBody, 'bodyPr');
    var scale = 1;
    var na = kid(bodyPr, 'normAutofit');
    if (na && attr(na, 'fontScale')) scale = num(attr(na, 'fontScale'), 100000) / 100000;
    var lstDef = path(txBody, 'lstStyle', 'lvl1pPr', 'defRPr');
    var first = null, align = null, lineHeight = null;
    var lines = kids(txBody, 'p').map(function (p) {
      var pPr = kid(p, 'pPr');
      if (align == null && pPr && attr(pPr, 'algn')) align = attr(pPr, 'algn');
      var lnSpc = path(pPr, 'lnSpc', 'spcPct');
      if (lineHeight == null && lnSpc) lineHeight = num(attr(lnSpc, 'val'), 100000) / 100000;
      var bullet = pPr && kid(pPr, 'buChar') ? (attr(kid(pPr, 'buChar'), 'char') || '•') + ' ' : '';
      var s = '';
      kids(p).forEach(function (r) {
        if (r.localName === 'r' || r.localName === 'fld') {
          var t = kid(r, 't');
          var val = t ? t.textContent : '';
          if (val.trim() && !first) first = kid(r, 'rPr');
          s += val;
        } else if (r.localName === 'br') s += '\n';
      });
      if (!first && kid(p, 'endParaRPr') && s.trim()) first = kid(p, 'endParaRPr');
      return s ? bullet + s : s;
    });
    // Drop trailing empty paragraphs.
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    var rPr = first || lstDef;
    var size = num(attr(rPr, 'sz'), num(attr(lstDef, 'sz'), 1800)) / 100;
    var col = rPr && colorOf(kid(rPr, 'solidFill'), ctx.theme);
    if (!col && lstDef) col = colorOf(kid(lstDef, 'solidFill'), ctx.theme);
    var anchor = attr(bodyPr, 'anchor');
    var style = {
      fontSize: Math.max(4, Math.round(size * scale * ctx.fontScale * 10) / 10),
      fontWeight: attr(rPr, 'b') === '1' ? 700 : 400,
      italic: attr(rPr, 'i') === '1',
      color: col ? col.hex : '#000000',
      align: { ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[align] || 'left',
      vAlign: { ctr: 'middle', b: 'bottom' }[anchor] || 'top',
      lineHeight: lineHeight ? Math.max(0.8, Math.min(3, r3(lineHeight * 1.2))) : 1.2,
      letterSpacing: rPr && attr(rPr, 'spc') ? r3(num(attr(rPr, 'spc'), 0) / 100 / size) : 0,
      padding: r3(num(attr(bodyPr, 'lIns'), 91440) / EMU * ctx.fontScale)
    };
    return { text: lines.join('\n'), style: style };
  }

  function connector(ctx, sc, node, tf) {
    var spPr = kid(node, 'spPr');
    var xf = xfrmOf(spPr);
    if (!xf) return;
    var r = apply(tf, xf);
    var a = toIn(ctx, { x: r.x, y: r.y, w: 0, h: 0 });
    var b = toIn(ctx, { x: r.x + r.w, y: r.y + r.h, w: 0, h: 0 });
    var x1 = r.flipH ? b.x : a.x, x2 = r.flipH ? a.x : b.x;
    var y1 = r.flipV ? b.y : a.y, y2 = r.flipV ? a.y : b.y;
    var ln = lineOf(spPr, ctx);
    if (!ln) {
      var ref = path(node, 'style', 'lnRef');
      var rc = ref && colorOf(ref, ctx.theme);
      ln = { color: rc ? rc.hex : '#000000', width: 1 * ctx.fontScale, dash: 'solid' };
    }
    var el = T.makeElement('line');
    function c(v, max) { return r3(Math.max(0, Math.min(max, v))); }
    Object.assign(el, {
      x1: c(x1, PAGE_W), y1: c(y1, PAGE_H), x2: c(x2, PAGE_W), y2: c(y2, PAGE_H),
      stroke: ln.color, strokeWidth: r3(ln.width), dash: ln.dash,
      capStart: ln.head ? 'arrow' : 'none', capEnd: ln.tail ? 'arrow' : 'none'
    });
    sc.els.push(el);
    ctx.report.lines++;
  }

  function picture(ctx, sc, node, tf) {
    var spPr = kid(node, 'spPr');
    var xf = xfrmOf(spPr) || inheritedXfrm(sc, node);
    if (!xf) return;
    var box = clampBox(toIn(ctx, apply(tf, xf)));
    var blip = all(node, 'blip')[0];
    var rel = blip && sc.rels[rid(blip, 'embed')];
    if (!rel || rel.external) { ctx.skip('linked picture'); return; }
    var ext = rel.target.split('.').pop().toLowerCase();
    var mime = MIME[ext];
    if (!mime) { ctx.skip('.' + ext + ' picture'); return; }
    return ctx.zip.bytes(rel.target).then(function (u8) {
      if (!u8) return;
      var el = T.makeElement('image');
      var ln = lineOf(spPr, ctx);
      var geom = attr(kid(spPr, 'prstGeom'), 'prst');
      Object.assign(el, box, {
        src: bytesToDataUrl(u8, mime), alt: attr(path(node, 'nvPicPr', 'cNvPr'), 'descr') || rel.target.split('/').pop(),
        bind: { kind: 'none', index: 0, zone: '', tag: '' }, fit: 'cover',
        radius: geom === 'ellipse' ? Math.round(Math.min(box.w, box.h) * 48) : (geom === 'roundRect' ? Math.round(Math.min(box.w, box.h) * 16) : 0),
        stroke: ln ? ln.color : 'none', strokeWidth: ln ? ln.width : 0
      });
      sc.els.push(el);
      ctx.report.images++;
    });
  }

  // Tables become a grid of cell boxes plus editable text boxes.
  function frame(ctx, sc, node, tf) {
    var tbl = all(node, 'tbl')[0];
    if (!tbl) {
      var uri = attr(all(node, 'graphicData')[0], 'uri') || '';
      ctx.skip(/chart/.test(uri) ? 'chart' : (/diagram/.test(uri) ? 'SmartArt diagram' : 'embedded object'));
      return;
    }
    var x = kid(node, 'xfrm');
    var off = kid(x, 'off');
    var ox = num(attr(off, 'x'), 0), oy = num(attr(off, 'y'), 0);
    var cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map(function (g) { return num(attr(g, 'w'), 0); });
    var y = oy;
    kids(tbl, 'tr').forEach(function (tr) {
      var hRow = num(attr(tr, 'h'), 370840);
      var xCur = ox;
      kids(tr, 'tc').forEach(function (tc, ci) {
        var wCol = cols[ci] || 0;
        var span = num(attr(tc, 'gridSpan'), 1);
        for (var k = 1; k < span; k++) wCol += cols[ci + k] || 0;
        if (attr(tc, 'hMerge') === '1') return; // covered by the spanning cell to its left
        if (attr(tc, 'vMerge') === '1') { xCur += cols[ci] || 0; return; } // covered by the cell above
        var box = clampBox(toIn(ctx, apply(tf, { x: xCur, y: y, w: wCol, h: hRow })));
        var tcPr = kid(tc, 'tcPr');
        var f = fillOf(tcPr, ctx.theme);
        var border = null;
        var lnB = kid(tcPr, 'lnB') || kid(tcPr, 'lnL');
        if (lnB && !kid(lnB, 'noFill')) {
          var bc = colorOf(kid(lnB, 'solidFill'), ctx.theme);
          if (bc) border = { color: bc.hex, width: Math.max(0.25, num(attr(lnB, 'w'), 12700) / 12700 * ctx.fontScale) };
        }
        if ((f && !f.none) || border) {
          var cell = T.makeElement('box');
          Object.assign(cell, box, { fill: f && !f.none ? f.hex : 'none', radius: 0, stroke: border ? border.color : 'none', strokeWidth: border ? r3(border.width) : 0 });
          sc.els.push(cell);
        }
        var txBody = kid(tc, 'txBody');
        var t = txBody && readText(ctx, txBody);
        if (t && t.text.trim()) {
          var tx = T.makeElement('text');
          Object.assign(tx, box, t.style, { text: t.text, fill: 'none', stroke: 'none', strokeWidth: 0, radius: 0,
            vAlign: { ctr: 'middle', b: 'bottom' }[attr(tcPr, 'anchor')] || 'top' });
          sc.els.push(tx);
          ctx.report.text++;
        }
        xCur += wCol;
      });
      y += hRow;
    });
    ctx.report.tables++;
  }

  root.CloudSlidesPptx = { importPptx: importPptx, readZip: readZip };
})(window);
