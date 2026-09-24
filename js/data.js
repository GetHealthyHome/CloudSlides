/*
 * Project data sources. A "project" is normalised to:
 *   { source, id, title, fields: {...}, photos: [{ id, url, zone, label, tag, taken_at, inspector }] }
 * Templates reference fields as {{customer_name}}, {{payload.some.key}} etc.
 *
 * Supabase is reached with plain fetch() against its REST + Auth endpoints,
 * so there is no SDK to bundle. The publishable key below is the public
 * client key; row access is still governed by the database's RLS policies
 * (signed-in crew only).
 */
(function (root) {
  var DEFAULTS = {
    url: 'https://xeiyzuolymbytegenevi.supabase.co',
    key: 'sb_publishable_PYlwXk8wQdp8cUWeTqabUQ__b7pjoBD',
    projectsTable: 'audits',
    photosTable: 'audit_photos',
    photosFk: 'audit_id',
    bucket: 'audit-photos'
  };

  var CFG_KEY = 'cloudslides.supabase.config';
  var SES_KEY = 'cloudslides.supabase.session';

  function readLS(k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
  }
  function writeLS(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ }
  }

  function getConfig() { return Object.assign({}, DEFAULTS, readLS(CFG_KEY, {})); }
  function setConfig(c) { writeLS(CFG_KEY, c); }
  function getSession() { return readLS(SES_KEY, null); }
  function setSession(s) { writeLS(SES_KEY, s); }

  function trimUrl(u) { return String(u || '').replace(/\/+$/, ''); }

  // fetch() rejects with a bare TypeError when offline or blocked; say so plainly.
  function netFetch(url, init) {
    return fetch(url, init).catch(function () {
      throw new Error('Can\u2019t reach Supabase. Check your internet connection (or use a saved project / JSON file offline).');
    });
  }

  function authFetch(path, body) {
    var c = getConfig();
    return netFetch(trimUrl(c.url) + path, {
      method: 'POST',
      headers: { apikey: c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error_description || j.msg || j.message || ('Sign-in failed (' + r.status + ')'));
        return j;
      });
    });
  }

  function storeSession(j) {
    var s = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)),
      email: j.user && j.user.email
    };
    setSession(s);
    return s;
  }

  function signIn(email, password) {
    return authFetch('/auth/v1/token?grant_type=password', { email: email, password: password }).then(storeSession);
  }

  function signOut() { setSession(null); }

  function validSession() {
    var s = getSession();
    if (!s) return Promise.resolve(null);
    if (s.expires_at - 60 > Date.now() / 1000) return Promise.resolve(s);
    return authFetch('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token })
      .then(storeSession)
      .catch(function () { setSession(null); return null; });
  }

  // init: optional { method, body, headers } for writes.
  function rest(path, init) {
    var c = getConfig();
    init = init || {};
    return validSession().then(function (s) {
      if (!s) throw new Error('Please sign in to Supabase first.');
      var headers = Object.assign({ apikey: c.key, Authorization: 'Bearer ' + s.access_token, Accept: 'application/json' }, init.headers || {});
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';
      return netFetch(trimUrl(c.url) + '/rest/v1/' + path, {
        method: init.method || 'GET',
        headers: headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined
      });
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('Supabase ' + r.status + ': ' + t); });
      return r.status === 204 ? [] : r.json();
    });
  }

  /* ---------- shared template library (table: slide_decks) ---------- */

  var DECKS = 'slide_decks';
  var ASSET_BUCKET = 'template-assets';

  function listDecks() {
    return rest(DECKS + '?select=id,name,updated_at,updated_by&order=updated_at.desc&limit=500');
  }

  function getDeck(id) {
    return rest(DECKS + '?select=*&id=eq.' + encodeURIComponent(id)).then(function (rows) {
      if (!rows[0]) throw new Error('That deck no longer exists in the library.');
      return rows[0];
    });
  }

  function createDeck(doc) {
    return rest(DECKS + '?select=id,name,updated_at,updated_by', {
      method: 'POST', body: { name: doc.name || 'Untitled deck', doc: doc }, headers: { Prefer: 'return=representation' }
    }).then(function (rows) { return rows[0]; });
  }

  // Only overwrites if nobody else saved since we loaded it (expectedUpdatedAt).
  // Resolves null on a conflict so the caller can ask what to do.
  function updateDeck(id, doc, expectedUpdatedAt) {
    var q = DECKS + '?id=eq.' + encodeURIComponent(id) + (expectedUpdatedAt ? '&updated_at=eq.' + encodeURIComponent(expectedUpdatedAt) : '') + '&select=id,name,updated_at,updated_by';
    return rest(q, {
      method: 'PATCH', body: { name: doc.name || 'Untitled deck', doc: doc }, headers: { Prefer: 'return=representation' }
    }).then(function (rows) { return rows[0] || null; });
  }

  function deleteDeck(id) {
    return rest(DECKS + '?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
  }

  // Upload a data: URL image to the public template-assets bucket; resolves its public URL.
  function uploadAsset(dataUrl) {
    var c = getConfig();
    var m = /^data:(image\/(png|jpeg));base64,/.exec(dataUrl || '');
    if (!m) return Promise.reject(new Error('Only PNG and JPG images can be saved to the library.'));
    var bin = atob(dataUrl.slice(m[0].length));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var name = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)) + (m[2] === 'png' ? '.png' : '.jpg');
    return validSession().then(function (s) {
      if (!s) throw new Error('Please sign in to Supabase first.');
      return netFetch(trimUrl(c.url) + '/storage/v1/object/' + ASSET_BUCKET + '/' + name, {
        method: 'POST',
        headers: { apikey: c.key, Authorization: 'Bearer ' + s.access_token, 'Content-Type': m[1], 'x-upsert': 'false' },
        body: new Blob([bytes], { type: m[1] })
      });
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('Image upload failed (' + r.status + '): ' + t); });
      return trimUrl(c.url) + '/storage/v1/object/public/' + ASSET_BUCKET + '/' + name;
    });
  }

  function listProjects() {
    var c = getConfig();
    return rest(encodeURIComponent(c.projectsTable) + '?select=id,customer_name,address,status,appointment_date,photo_count,updated_at&order=updated_at.desc&limit=200');
  }

  function publicPhotoUrl(path) {
    if (!path) return '';
    if (/^(https?:|data:|blob:)/.test(path)) return path;
    var c = getConfig();
    var clean = String(path).replace(/^\/+/, '');
    var prefix = c.bucket + '/';
    if (clean.indexOf(prefix) === 0) clean = clean.slice(prefix.length);
    return trimUrl(c.url) + '/storage/v1/object/public/' + encodeURIComponent(c.bucket) + '/' +
      clean.split('/').map(encodeURIComponent).join('/');
  }

  function loadProject(id) {
    var c = getConfig();
    var q = encodeURIComponent(id);
    return Promise.all([
      rest(encodeURIComponent(c.projectsTable) + '?select=*&id=eq.' + q),
      rest(encodeURIComponent(c.photosTable) + '?select=*&' + encodeURIComponent(c.photosFk) + '=eq.' + q + '&order=taken_at.asc.nullslast')
    ]).then(function (res) {
      var row = res[0][0];
      if (!row) throw new Error('Project not found or not visible to this account.');
      return normalise(row, res[1], 'supabase');
    });
  }

  function normalise(row, photos, source) {
    var fields = Object.assign({}, row);
    delete fields.share_token;
    if (fields.appointment_date) {
      var d = new Date(fields.appointment_date + 'T12:00:00');
      if (!isNaN(d)) fields.appointment_date_long = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    }
    return {
      source: source,
      id: row.id,
      title: row.customer_name || row.title || row.name || row.id || 'Project',
      fields: fields,
      photos: (photos || []).map(function (p, i) {
        return {
          id: p.id || String(i),
          url: p.url || publicPhotoUrl(p.storage_path || p.path || p.src),
          zone: p.zone || '',
          label: p.label || p.caption || '',
          tag: p.tag || '',
          taken_at: p.taken_at || '',
          inspector: p.inspector || ''
        };
      }).filter(function (p) { return p.url; })
    };
  }

  // Accepts {fields, photos} (our own format), {project/audit, photos}, or a bare row.
  function fromJSON(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('Not a JSON object');
    if (obj.fields && Array.isArray(obj.photos)) {
      return normalise(Object.assign({ id: obj.id || 'json' }, obj.fields), obj.photos, 'json');
    }
    var row = obj.project || obj.audit || obj;
    var photos = obj.photos || obj.audit_photos || row.photos || [];
    var r = Object.assign({}, row);
    delete r.photos;
    return normalise(r, photos, 'json');
  }

  function svgPhoto(label, a, b) {
    label = String(label).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + a + '"/><stop offset="1" stop-color="' + b + '"/></linearGradient></defs>' +
      '<rect width="1600" height="1200" fill="url(#g)"/>' +
      '<circle cx="1250" cy="300" r="160" fill="#ffffff" fill-opacity=".25"/>' +
      '<path d="M0 1200 L520 640 L820 940 L1080 700 L1600 1200 Z" fill="#000" fill-opacity=".18"/>' +
      '<text x="80" y="1110" font-family="Helvetica, Arial, sans-serif" font-size="84" font-weight="700" fill="#fff">' + label + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function sampleProject() {
    var zones = [
      ['Attic', '#5b7db1', '#9fc1e8', 'Insulation depth'],
      ['Attic', '#4a6b9a', '#86a9d6', 'Air sealing gaps'],
      ['Basement', '#7a6a58', '#c4ad8f', 'Rim joist'],
      ['Basement', '#6b5b4a', '#b39c7e', 'Water heater'],
      ['Crawlspace', '#5f7d5a', '#a9c7a2', 'Vapor barrier'],
      ['HVAC', '#8a4f5a', '#d99aa5', 'Furnace filter'],
      ['HVAC', '#7a4450', '#c98a96', 'Duct leakage'],
      ['Exterior', '#b07a2a', '#f0c070', 'Siding & trim']
    ];
    return {
      source: 'sample',
      id: 'sample-001',
      title: 'Jordan Rivera',
      fields: {
        id: 'sample-001',
        customer_name: 'Jordan Rivera',
        address: '1428 Elm Street, Springfield',
        status: 'completed',
        appointment_date: '2026-09-18',
        appointment_date_long: 'September 18, 2026',
        photo_count: zones.length,
        owner_email: 'auditor@example.com',
        payload: {
          summary: 'Whole-home energy and health audit with blower-door test.',
          blower_door_cfm50: 3150,
          recommended_package: 'Comfort Plus',
          estimate_total: '$8,450'
        }
      },
      photos: zones.map(function (z, i) {
        return { id: 's' + i, url: svgPhoto(z[3], z[1], z[2]), zone: z[0], label: z[3], tag: i % 3 === 0 ? 'priority' : '', taken_at: '', inspector: 'A. Auditor' };
      })
    };
  }

  // Flatten field paths for the "insert field" menus.
  function fieldPaths(project) {
    var out = [];
    function walk(obj, prefix, depth) {
      Object.keys(obj || {}).forEach(function (k) {
        var v = obj[k];
        var p = prefix ? prefix + '.' + k : k;
        if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) walk(v, p, depth + 1);
        else out.push(p);
      });
    }
    walk(project ? project.fields : {}, '', 0);
    ['page', 'pages', 'today', 'photoCount', 'zone', 'part', 'parts', 'photo.label', 'photo.zone', 'photo.tag', 'photo.inspector'].forEach(function (k) {
      if (out.indexOf(k) < 0) out.push(k);
    });
    return out;
  }

  root.CloudSlidesData = {
    DEFAULTS: DEFAULTS,
    getConfig: getConfig,
    setConfig: setConfig,
    getSession: getSession,
    signIn: signIn,
    signOut: signOut,
    listProjects: listProjects,
    listDecks: listDecks,
    getDeck: getDeck,
    createDeck: createDeck,
    updateDeck: updateDeck,
    deleteDeck: deleteDeck,
    uploadAsset: uploadAsset,
    loadProject: loadProject,
    fromJSON: fromJSON,
    sampleProject: sampleProject,
    fieldPaths: fieldPaths,
    publicPhotoUrl: publicPhotoUrl
  };
})(window);
