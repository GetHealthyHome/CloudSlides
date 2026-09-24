/*
 * Element factories and the starter deck. Geometry is in inches on an
 * 11 x 8.5 in page; font sizes in points; corner radius in CSS px.
 */
(function (root) {
  function uid(prefix) {
    return (prefix || 'e') + Math.random().toString(36).slice(2, 9);
  }

  var ROUND_RADIUS = 25;

  // Brand palette: the only swatches offered in the color pickers.
  var PALETTE = [
    { name: 'White', hex: '#ffffff' },
    { name: 'Black', hex: '#000000' },
    { name: 'Dark gray', hex: '#4a4a4a' },
    { name: 'Light gray', hex: '#d9d9d9' },
    { name: 'Forest green', hex: '#1b4d2b' },
    { name: 'Green', hex: '#2f7d45' },
    { name: 'Leaf green', hex: '#5fae6e' },
    { name: 'Mint', hex: '#cfe8d4' }
  ];

  function makeElement(kind, at) {
    var p = at || {};
    var base = { id: uid('e'), x: p.x != null ? p.x : 1, y: p.y != null ? p.y : 1, opacity: 1 };
    if (kind === 'text') {
      return Object.assign(base, {
        type: 'text', w: 4, h: 1, text: 'Double-click to edit text',
        fontSize: 24, fontWeight: 600, italic: false, align: 'left', vAlign: 'top',
        lineHeight: 1.2, letterSpacing: 0, padding: 0.08,
        color: '#000000', fill: 'none', stroke: 'none', strokeWidth: 0, radius: 0
      });
    }
    if (kind === 'box' || kind === 'round') {
      return Object.assign(base, {
        type: 'shape', w: 3, h: 2,
        fill: kind === 'round' ? '#cfe8d4' : '#d9d9d9',
        stroke: 'none', strokeWidth: 0,
        radius: kind === 'round' ? ROUND_RADIUS : 0
      });
    }
    if (kind === 'line') {
      var lx = p.x != null ? p.x : 1, ly = p.y != null ? p.y : 1;
      return { id: base.id, type: 'line', x1: lx, y1: ly, x2: lx + 3, y2: ly, stroke: '#000000', strokeWidth: 1.5, dash: 'solid', capStart: 'none', capEnd: 'none', opacity: 1 };
    }
    if (kind === 'chart') {
      return Object.assign(base, {
        type: 'chart', w: 5, h: 3,
        bars: [{ label: 'Item A', value: '40' }, { label: 'Item B', value: '65' }, { label: 'Item C', value: '30' }, { label: 'Item D', value: '80' }],
        barColor: '#2f7d45', color: '#4a4a4a', gridColor: '#d9d9d9', fontSize: 10,
        prefix: '', suffix: '', decimals: 0, showValues: true, showGrid: true, showAxis: true,
        fill: 'none', stroke: 'none', strokeWidth: 0, radius: 0
      });
    }
    if (kind === 'image') {
      return Object.assign(base, {
        type: 'image', w: 4, h: 3, src: '', alt: '', fit: 'cover', position: 'center',
        bind: { kind: 'photo', index: 0, zone: '', tag: '' },
        fill: 'none', stroke: 'none', strokeWidth: 0, radius: 0
      });
    }
    throw new Error('Unknown element kind ' + kind);
  }

  function el(kind, props) { return Object.assign(makeElement(kind), props); }

  function newTemplate(name) {
    return { id: uid('t'), name: name || 'Untitled slide', background: '#ffffff', repeat: { mode: 'none', perSlide: 0, zone: '', tag: '' }, elements: [] };
  }

  var NAVY = '#1b4d2b'; // forest green
  var ACCENT = '#2f7d45'; // green

  function starterDeck() {
    var cover = newTemplate('Cover');
    cover.background = NAVY;
    cover.elements = [
      el('image', { x: 5.5, y: 0, w: 5.5, h: 8.5, bind: { kind: 'photo', index: 0, zone: '', tag: '' } }),
      el('round', { x: 0.75, y: 0.75, w: 1.5, h: 0.5, fill: ACCENT, radius: ROUND_RADIUS }),
      el('text', { x: 0.75, y: 0.75, w: 1.5, h: 0.5, text: 'PROPOSAL', fontSize: 12, fontWeight: 700, letterSpacing: 0.12, align: 'center', vAlign: 'middle', color: '#ffffff' }),
      el('text', { x: 0.75, y: 2.25, w: 4.5, h: 2, text: 'Home Performance Plan for {{customer_name}}', fontSize: 34, fontWeight: 700, lineHeight: 1.1, color: '#ffffff', vAlign: 'bottom' }),
      el('text', { x: 0.75, y: 4.5, w: 4.5, h: 0.75, text: '{{address}}', fontSize: 16, fontWeight: 400, color: '#d9d9d9' }),
      el('box', { x: 0.75, y: 6.75, w: 4.5, h: 0.03125, fill: '#5fae6e' }),
      el('text', { x: 0.75, y: 7, w: 4.5, h: 0.75, text: 'Audit date: {{appointment_date_long}}', fontSize: 12, fontWeight: 500, color: '#d9d9d9' })
    ];

    var summary = newTemplate('Summary');
    summary.elements = [
      el('text', { x: 0.75, y: 0.5, w: 9.5, h: 0.75, text: 'What we found', fontSize: 30, fontWeight: 700, color: NAVY }),
      el('box', { x: 0.75, y: 1.25, w: 1, h: 0.0625, fill: ACCENT }),
      el('text', { x: 0.75, y: 1.75, w: 5.75, h: 3.5, text: '{{payload.summary}}', fontSize: 16, fontWeight: 400, lineHeight: 1.45, color: '#4a4a4a' }),
      el('round', { x: 7, y: 1.75, w: 3.25, h: 2.5, fill: '#cfe8d4', radius: ROUND_RADIUS }),
      el('text', { x: 7.25, y: 2, w: 2.75, h: 0.5, text: 'Recommended package', fontSize: 11, fontWeight: 600, color: '#4a4a4a' }),
      el('text', { x: 7.25, y: 2.5, w: 2.75, h: 0.75, text: '{{payload.recommended_package}}', fontSize: 22, fontWeight: 700, color: NAVY }),
      el('text', { x: 7.25, y: 3.25, w: 2.75, h: 0.75, text: '{{payload.estimate_total}}', fontSize: 22, fontWeight: 600, color: ACCENT }),
      el('image', { x: 0.75, y: 5.5, w: 3, h: 2.25, radius: ROUND_RADIUS, bind: { kind: 'photo', index: 1, zone: '', tag: '' } }),
      el('image', { x: 4, y: 5.5, w: 3, h: 2.25, radius: ROUND_RADIUS, bind: { kind: 'photo', index: 2, zone: '', tag: '' } }),
      el('image', { x: 7.25, y: 5.5, w: 3, h: 2.25, radius: ROUND_RADIUS, bind: { kind: 'photo', index: 3, zone: '', tag: '' } }),
      el('text', { x: 8.25, y: 7.875, w: 2, h: 0.375, text: '{{page}} / {{pages}}', fontSize: 9, fontWeight: 500, align: 'right', color: '#4a4a4a' })
    ];

    var photos = newTemplate('Photo findings (repeats per zone)');
    photos.repeat = { mode: 'perZone', perSlide: 4, zone: '', tag: '' };
    photos.background = '#ffffff';
    var slots = [[0.75, 1.75], [5.625, 1.75], [0.75, 4.875], [5.625, 4.875]];
    photos.elements = [
      el('text', { x: 0.75, y: 0.5, w: 7, h: 0.75, text: '{{zone}}', fontSize: 28, fontWeight: 700, color: NAVY }),
      el('text', { x: 7.75, y: 0.625, w: 2.5, h: 0.5, text: 'Part {{part}} of {{parts}}', fontSize: 11, fontWeight: 500, align: 'right', color: '#4a4a4a', vAlign: 'middle' })
    ];
    slots.forEach(function (s, i) {
      photos.elements.push(el('image', { x: s[0], y: s[1], w: 4.625, h: 2.625, radius: 12, bind: { kind: 'photo', index: i, zone: '', tag: '' } }));
    });
    photos.elements.push(el('text', { x: 8.25, y: 7.875, w: 2, h: 0.375, text: '{{page}} / {{pages}}', fontSize: 9, fontWeight: 500, align: 'right', color: '#4a4a4a' }));

    var closing = newTemplate('Next steps');
    closing.background = NAVY;
    closing.elements = [
      el('text', { x: 0.75, y: 0.75, w: 9.5, h: 1, text: 'Next steps', fontSize: 34, fontWeight: 700, color: '#ffffff' }),
      el('round', { x: 0.75, y: 2.25, w: 3, h: 4, fill: '#2f7d45', radius: ROUND_RADIUS }),
      el('round', { x: 4, y: 2.25, w: 3, h: 4, fill: '#2f7d45', radius: ROUND_RADIUS }),
      el('round', { x: 7.25, y: 2.25, w: 3, h: 4, fill: '#2f7d45', radius: ROUND_RADIUS }),
      el('text', { x: 1, y: 2.5, w: 2.5, h: 3.5, text: '1\n\nReview this proposal and ask us anything.', fontSize: 16, fontWeight: 500, lineHeight: 1.35, color: '#ffffff' }),
      el('text', { x: 4.25, y: 2.5, w: 2.5, h: 3.5, text: '2\n\nApprove the {{payload.recommended_package}} package.', fontSize: 16, fontWeight: 500, lineHeight: 1.35, color: '#ffffff' }),
      el('text', { x: 7.5, y: 2.5, w: 2.5, h: 3.5, text: '3\n\nWe schedule installation at {{address}}.', fontSize: 16, fontWeight: 500, lineHeight: 1.35, color: '#ffffff' }),
      el('text', { x: 0.75, y: 7.25, w: 9.5, h: 0.5, text: 'Prepared {{today}}', fontSize: 11, fontWeight: 400, color: '#d9d9d9' })
    ];

    var templates = [cover, summary, photos, closing];
    return {
      schema: 'cloudslides.deck',
      version: 1,
      name: 'Home Performance Proposal',
      grid: { size: 0.25, snap: true, show: true },
      templates: templates,
      deck: templates.map(function (t) { return { id: uid('d'), templateId: t.id }; })
    };
  }

  root.CloudSlidesTemplates = {
    uid: uid,
    ROUND_RADIUS: ROUND_RADIUS,
    PALETTE: PALETTE,
    makeElement: makeElement,
    newTemplate: newTemplate,
    starterDeck: starterDeck
  };
})(window);
