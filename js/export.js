/*
 * Export / import of template decks.
 *
 *  - Deck JSON           the master template (templates + deck order + bindings)
 *  - Rendered JSON       every expanded slide with text and image URLs resolved
 *  - HTML (template)     standalone viewer with placeholders; other apps feed data in
 *  - HTML (rendered)     standalone viewer with the current project's data baked in
 */
(function (root) {
  var R = root.CloudSlidesRender;

  function download(filename, text, type) {
    var blob = new Blob([text], { type: type || 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function slug(s) {
    return String(s || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck';
  }

  // JSON that is safe to place inside a <script> element.
  function scriptJSON(v) {
    return JSON.stringify(v == null ? null : v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function deckJSON(doc) {
    var out = JSON.parse(JSON.stringify(doc));
    out.schema = 'cloudslides.deck';
    out.exportedAt = new Date().toISOString();
    out.page = { width: 11, height: 8.5, unit: 'in', size: 'letter', orientation: 'landscape' };
    return out;
  }

  function renderedJSON(doc, project) {
    var slides = R.expandDeck(doc, project).map(function (s) {
      return {
        page: s.ctx.page,
        templateId: s.template.id,
        templateName: s.template.name,
        background: s.template.background,
        elements: s.template.elements.map(function (el) {
          var e = JSON.parse(JSON.stringify(el));
          if (el.type === 'text') e.text = R.fillText(el.text, s.ctx, false);
          if (el.type === 'chart') e.bars = R.chartBars(el, s.ctx, true);
          if (el.type === 'image') {
            var node = R.renderElement(el, s.ctx, { mode: 'final' });
            var img = node.querySelector('img');
            e.src = img ? img.getAttribute('src') : '';
            delete e.bind;
          }
          return e;
        })
      };
    });
    return {
      schema: 'cloudslides.rendered',
      name: doc.name,
      exportedAt: new Date().toISOString(),
      page: { width: 11, height: 8.5, unit: 'in', size: 'letter', orientation: 'landscape' },
      project: project ? { id: project.id, title: project.title, source: project.source } : null,
      slides: slides
    };
  }

  var RUNTIME = function () {
    var R = window.CloudSlidesRender;
    var deck = JSON.parse(document.getElementById('cloudslides-deck').textContent);
    var project = JSON.parse(document.getElementById('cloudslides-project').textContent);
    var viewer = null;
    R.injectCSS(document);
    function show(p) {
      if (p) project = p;
      if (viewer) viewer.close();
      viewer = R.mountViewer({
        title: deck.name,
        makeSlides: function () { return R.renderDeck(deck, project, { mode: project ? 'final' : 'preview' }); }
      });
    }
    // Public API for host apps: CloudSlides.setProject({ fields: {...}, photos: [{ url, zone, label }] })
    window.CloudSlides = {
      deck: deck,
      renderer: R,
      setProject: show,
      renderSlides: function (p) { return R.renderDeck(deck, p || project, { mode: 'final' }); }
    };
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (d && d.type === 'cloudslides:project' && d.project) show(d.project);
    });
    var src = new URLSearchParams(location.search).get('data');
    if (src) {
      fetch(src).then(function (r) { return r.json(); }).then(show, function () { show(); });
    } else {
      show();
    }
  };

  function standaloneHTML(doc, project) {
    var d = deckJSON(doc);
    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<meta name="generator" content="CloudSlides">\n' +
      '<title>' + escapeHTML(doc.name || 'Proposal') + '</title>\n' +
      '<style>html,body{margin:0;height:100%;background:#111214;}</style>\n' +
      '</head>\n<body>\n' +
      '<script type="application/json" id="cloudslides-deck">' + scriptJSON(d) + '</script>\n' +
      '<script type="application/json" id="cloudslides-project">' + scriptJSON(project || null) + '</script>\n' +
      '<script>\n(function (root) {\n  root.CloudSlidesRender = (' + R.factorySource + ')();\n})(window);\n</script>\n' +
      '<script>\n(' + RUNTIME.toString() + ')();\n</script>\n' +
      '</body>\n</html>\n';
  }

  function exportDeckJSON(doc) {
    download(slug(doc.name) + '.cloudslides.json', JSON.stringify(deckJSON(doc), null, 2), 'application/json');
  }
  function exportRenderedJSON(doc, project) {
    download(slug(doc.name) + (project ? '-' + slug(project.title) : '') + '.slides.json', JSON.stringify(renderedJSON(doc, project), null, 2), 'application/json');
  }
  function exportTemplateHTML(doc) {
    download(slug(doc.name) + '-template.html', standaloneHTML(doc, null), 'text/html');
  }
  function exportRenderedHTML(doc, project) {
    download(slug(doc.name) + (project ? '-' + slug(project.title) : '') + '.html', standaloneHTML(doc, project), 'text/html');
  }

  function readFile(file, asDataURL) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      if (asDataURL) fr.readAsDataURL(file); else fr.readAsText(file);
    });
  }

  // Accepts a deck JSON, or an exported HTML file (reads its embedded deck).
  function parseDeckFile(text) {
    var t = String(text).trim();
    if (t.charAt(0) !== '{') {
      var m = t.match(/<script type="application\/json" id="cloudslides-deck">([\s\S]*?)<\/script>/);
      if (!m) throw new Error('No CloudSlides deck found in that file.');
      t = m[1];
    }
    var d = JSON.parse(t);
    if (!Array.isArray(d.templates)) throw new Error('That file is not a CloudSlides deck (missing "templates").');
    if (!Array.isArray(d.deck)) d.deck = d.templates.map(function (tp, i) { return { id: 'd' + i, templateId: tp.id }; });
    return d;
  }

  root.CloudSlidesExport = {
    download: download,
    deckJSON: deckJSON,
    renderedJSON: renderedJSON,
    standaloneHTML: standaloneHTML,
    exportDeckJSON: exportDeckJSON,
    exportRenderedJSON: exportRenderedJSON,
    exportTemplateHTML: exportTemplateHTML,
    exportRenderedHTML: exportRenderedHTML,
    readFile: readFile,
    parseDeckFile: parseDeckFile
  };
})(window);
