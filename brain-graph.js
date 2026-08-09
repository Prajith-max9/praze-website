/* Second Brain — force-directed graph view on canvas.
   BrainGraph.mount(canvas, data, onNodeClick, getNoteInfo) / BrainGraph.destroy().
   Camera (pan + zoom) sits between world space and the screen; the force sim
   and node data stay in world coords. Fully torn down on destroy — no rAF
   left running in background. */
window.BrainGraph = (function () {
  'use strict';

  // Colors come from the live CSS variables so the graph follows the theme.
  // Read at mount time — the graph is remounted on every entry to #graph.
  function themeColors() {
    var css = getComputedStyle(document.documentElement);
    var v = function (name, fallback) {
      var val = css.getPropertyValue(name).trim();
      return val || fallback;
    };
    return {
      bone: v('--bone', '#f5f3ee'),
      ink: v('--ink', '#131313'),
      lime: v('--lime', '#d4ff00'),
      gray: v('--gray', '#6b6b66'),
      edge: v('--graph-edge', 'rgba(19, 19, 19, 0.18)'),
      simEdge: v('--graph-edge-sim', 'rgba(19, 19, 19, 0.30)')
    };
  }

  var LABEL_LIMIT = 40; // draw all labels up to this many nodes; above it, hover only
  var LABEL_FONT = '11px "Space Mono", monospace';
  var LABEL_CLEAR_MAX = 165; // ceiling on label-driven spacing, so long titles
                             // can't blow a graph apart
  var MIN_SCALE = 0.4;
  var MAX_SCALE = 3;

  // Fit-to-content. The layout's equilibrium size is in absolute pixels — the
  // repulsion and rest-length constants below have no idea how big the canvas
  // is — so the cluster settles at roughly the same physical size whatever room
  // it is given, and a bigger canvas only ever means more empty canvas.
  // Measured before this existed, at 1440x900: 20 notes spanned 165px of a
  // 538px-tall canvas (31%), and 168px of a 718px one (23%) — i.e. more height
  // made it worse. The camera closes that gap. The physics are untouched.
  var FIT_PAD = 0.88;        // margin, so nodes never sit flush to the edge
  var FIT_MAX_SCALE = 2.4;   // below MAX_SCALE on purpose: a fit should only
                             // land somewhere the user could have pinched to
  var FIT_MIN_NODES = 5;     // below this the graph is sparse, not small. Two
                             // dots blown up to fill 1300px reads as broken,
                             // and .graph-cold already explains the sparseness.
  // The camera eases towards the fit every frame rather than being set once the
  // layout settles. Measured: 8 notes settle in ~1.4s, but 40 and 80 notes were
  // still moving after 12s — a fit that waits for rest would never reach the
  // graphs with the most notes, which are the ones with the least room to
  // waste. Following the layout also means the graph is framed while it forms
  // instead of snapping at the end.
  var FIT_EASE = 0.12;
  var CAM_EPS = 0.002;       // camera close enough to its target to stop
  // The frame follows the envelope of where the graph has been, not where it is
  // this instant. A large graph never truly rests — at 80 notes the raw fit
  // target swung 79% as nodes churned against the world bounds, which the
  // camera turned into a visible pulse (7.6% zoom change in a single frame).
  // The envelope grows immediately, so nothing ever clips, and shrinks slowly,
  // so the frame stays still while still following a layout that really is
  // contracting. Measured after: 0.3% worst-case per frame at the same 80.
  var ENV_DECAY = 0.004;

  // Canvas animation, so the global prefers-reduced-motion override in
  // brain.css cannot reach it — checked here instead. Read per fit rather than
  // cached, so changing the OS setting mid-session is honoured.
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  // Average movement per node per frame below which the layout counts as
  // settled. Well under a pixel, so the loop only stops once nothing on screen
  // is visibly moving.
  var SETTLE_PER_NODE = 0.05;

  // Multipliers on the constants below, tunable from the graph settings panel.
  // All default to 1 — the physics and visuals are byte-for-byte the same as
  // before this existed until a user actually moves a slider.
  var DEFAULT_SETTINGS = {
    nodeSize: 1, linkThickness: 1, repelForce: 1, linkForce: 1, centerForce: 1, linkDistance: 1
  };

  var state = null; // null when unmounted

  function setDebug() {
    window.__brainDebug = {
      nodes: state ? state.nodes.length : 0,
      edges: state ? state.edges.length : 0,
      running: !!(state && state.raf),
      scale: state ? state.scale : 1,
      ox: state ? state.ox : 0,
      oy: state ? state.oy : 0,
      // the framing the graph is easing towards, and whether it still owns the
      // camera at all (a pan, zoom or node drag hands it to the user)
      fit: state ? state.fit : null,
      autoFit: !!(state && state.autoFit),
      // screen position of the first node, for tests
      sample: state && state.nodes.length
        ? { x: state.nodes[0].x * state.scale + state.ox, y: state.nodes[0].y * state.scale + state.oy }
        : null,
      // world positions, for layout/overlap assertions
      w: state ? state.W : 0,
      h: state ? state.H : 0,
      positions: state ? state.nodes.map(function (n) {
        return { id: n.id, label: n.label, x: n.x, y: n.y, deg: n.deg, halfLabel: n.halfLabel };
      }) : []
    };
  }

  function mount(canvas, data, onNodeClick, getNoteInfo, settings) {
    destroy();

    var COLORS = themeColors();
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var W = Math.max(rect.width, 200);
    var H = Math.max(rect.height, 200);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    var ctx = canvas.getContext('2d');

    var byId = {};
    var nodes = data.nodes.map(function (n, i) {
      var angle = (i / Math.max(data.nodes.length, 1)) * Math.PI * 2;
      var r = Math.min(W, H) * 0.3 * (0.4 + 0.6 * Math.random());
      var node = {
        id: n.id, label: n.label, kind: n.kind, pinned: n.pinned,
        x: W / 2 + Math.cos(angle) * r,
        y: H / 2 + Math.sin(angle) * r,
        vx: 0, vy: 0, deg: 0
      };
      byId[n.id] = node;
      return node;
    });

    var edges = data.edges.filter(function (e) {
      return byId[e.a] && byId[e.b];
    }).map(function (e) {
      byId[e.a].deg++;
      byId[e.b].deg++;
      return { a: byId[e.a], b: byId[e.b], type: e.type };
    });

    // tooltip lives in the graph wrapper (position: relative)
    var tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';
    tooltip.hidden = true;
    (canvas.parentElement || document.body).appendChild(tooltip);

    state = {
      canvas: canvas, ctx: ctx, W: W, H: H, dpr: dpr,
      nodes: nodes, edges: edges, byId: byId,
      onNodeClick: onNodeClick, getNoteInfo: getNoteInfo,
      raf: null, cooling: 1,
      scale: 1, ox: 0, oy: 0,
      // The camera target, and whether the graph is still framing itself. Any
      // pan, zoom or node drag hands the camera to the user and clears
      // autoFit; double-click gives it back.
      fit: { scale: 1, ox: 0, oy: 0 }, autoFit: true, env: null,
      dragging: null, panning: null, downAt: null,
      pointers: {}, pinch: null,
      hover: null, tooltip: tooltip, listeners: [],
      settings: Object.assign({}, DEFAULT_SETTINGS, settings || {})
    };

    function radius(node) {
      return (5 + Math.min(6, node.deg * 1.2)) * state.settings.nodeSize;
    }

    // Labels are drawn centred above the node, so how far two nodes must sit
    // apart to stay readable depends on their label widths. Measured once at
    // mount (labels never change) rather than per frame.
    ctx.save();
    ctx.font = LABEL_FONT;
    nodes.forEach(function (n) {
      n.halfLabel = ctx.measureText(n.label.slice(0, 24)).width / 2;
    });
    ctx.restore();

    // Minimum centre-to-centre distance before two nodes are considered to be
    // colliding. With labels on screen that includes room for the labels, but
    // the label share is capped and eased off as the graph grows: in a dense
    // web some label crowding is normal and spreading everything out to avoid
    // it would destroy the layout.
    function minGap(a, b) {
      var solid = radius(a) + radius(b) + 18;
      if (nodes.length > LABEL_LIMIT) return solid;
      var share = nodes.length <= 6 ? 1 : nodes.length <= 12 ? 0.7 : 0.4;
      var wanted = (a.halfLabel + b.halfLabel + 10) * share;
      return Math.max(solid, Math.min(LABEL_CLEAR_MAX, wanted));
    }

    /* --- coordinate helpers --- */

    function rawPos(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function toWorld(p) {
      return { x: (p.x - state.ox) / state.scale, y: (p.y - state.oy) / state.scale };
    }

    function pick(world) {
      for (var i = state.nodes.length - 1; i >= 0; i--) {
        var n = state.nodes[i];
        var dx = world.x - n.x, dy = world.y - n.y;
        var r = radius(n) + 5;
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    }

    /* --- fit-to-content --- */

    // The box the drawing actually occupies in world coords: node circles plus
    // the labels centred above them. Measuring circles alone would frame the
    // graph so that the labels — the widest thing on screen, and the part that
    // was already overlapping — clip against the edges.
    function contentBox() {
      var showAllLabels = nodes.length <= LABEL_LIMIT;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var r = radius(n);
        var halfW = showAllLabels ? Math.max(r, n.halfLabel) : r;
        // draw() puts the baseline at y - r - 6 in an 11px font
        var top = showAllLabels ? n.y - r - 17 : n.y - r;
        if (n.x - halfW < x0) x0 = n.x - halfW;
        if (n.x + halfW > x1) x1 = n.x + halfW;
        if (top < y0) y0 = top;
        if (n.y + r > y1) y1 = n.y + r;
      }
      return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    // contentBox() smoothed: each edge jumps outwards the moment the content
    // reaches it, and creeps inwards when it retreats.
    //
    // The smoothing exists to reject churn, so a layout at rest skips it
    // entirely and the envelope collapses onto the real box. Without that, a
    // small graph — which settles in about a second — spent a further six
    // seconds creeping inwards, keeping the rAF loop alive for the whole crawl.
    function frameBox(settled) {
      var b = contentBox();
      var e = state.env;
      if (!e || settled) {
        state.env = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
        return state.env;
      }
      e.x0 = b.x0 < e.x0 ? b.x0 : e.x0 + (b.x0 - e.x0) * ENV_DECAY;
      e.y0 = b.y0 < e.y0 ? b.y0 : e.y0 + (b.y0 - e.y0) * ENV_DECAY;
      e.x1 = b.x1 > e.x1 ? b.x1 : e.x1 + (b.x1 - e.x1) * ENV_DECAY;
      e.y1 = b.y1 > e.y1 ? b.y1 : e.y1 + (b.y1 - e.y1) * ENV_DECAY;
      return e;
    }

    // The camera that centres the content and scales it to fill, or null when
    // the graph is too sparse to be worth framing.
    function computeFit(settled) {
      if (nodes.length < FIT_MIN_NODES) return null;
      var b = frameBox(settled);
      var bw = b.x1 - b.x0, bh = b.y1 - b.y0;
      if (!(bw > 0) || !(bh > 0)) return null;
      var s = Math.min(state.W / bw, state.H / bh) * FIT_PAD;
      s = Math.max(MIN_SCALE, Math.min(FIT_MAX_SCALE, s));
      return {
        scale: s,
        ox: state.W / 2 - ((b.x0 + b.x1) / 2) * s,
        oy: state.H / 2 - ((b.y0 + b.y1) / 2) * s
      };
    }

    // zoom about a screen point: the world point under it stays put
    function zoomAt(screen, factor) {
      state.autoFit = false;   // the camera is the user's from here
      var newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.scale * factor));
      var wx = (screen.x - state.ox) / state.scale;
      var wy = (screen.y - state.oy) / state.scale;
      state.ox = screen.x - wx * newScale;
      state.oy = screen.y - wy * newScale;
      state.scale = newScale;
      wake();
    }

    /* --- physics --- */

    function step() {
      var i, j, n, m, dx, dy, d2, d, f;
      var count = nodes.length;
      // With few notes there are no edges yet (similarity needs 5+), so
      // repulsion is the only thing separating nodes and it was tuned for a
      // denser graph where springs pull back. Scale it up as the graph gets
      // smaller, and ease off the centring pull for the same reason — a
      // handful of notes shouldn't be squeezed into a pile in the middle.
      var REPULSION = 1800 * Math.max(1, 30 / Math.max(count, 1)) * state.settings.repelForce;
      var SPRING = 0.015 * state.settings.linkForce;
      var REST = 90 * state.settings.linkDistance;
      var GRAVITY = 0.012 * Math.max(0.35, Math.min(1, count / 10)) * state.settings.centerForce;
      var moved = 0;

      // Movement is measured from actual displacement, not velocity: the
      // collision pass below corrects positions directly, and a spring pulling
      // against it would otherwise leave a permanent velocity churn that never
      // falls under the settle threshold — an rAF loop that never stops.
      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        n.px = n.x; n.py = n.y;
      }

      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        for (j = i + 1; j < nodes.length; j++) {
          m = nodes[j];
          dx = n.x - m.x; dy = n.y - m.y;
          d2 = dx * dx + dy * dy || 1;
          if (d2 < 90000) {
            f = REPULSION / d2;
            d = Math.sqrt(d2);
            n.vx += (dx / d) * f; n.vy += (dy / d) * f;
            m.vx -= (dx / d) * f; m.vy -= (dy / d) * f;
          }
        }
        n.vx += (state.W / 2 - n.x) * GRAVITY;
        n.vy += (state.H / 2 - n.y) * GRAVITY;
      }

      for (i = 0; i < edges.length; i++) {
        var e = edges[i];
        dx = e.b.x - e.a.x; dy = e.b.y - e.a.y;
        d = Math.sqrt(dx * dx + dy * dy) || 1;
        f = (d - REST) * SPRING;
        e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f;
        e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f;
      }

      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        if (n === state.dragging) { n.vx = 0; n.vy = 0; continue; }
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += n.vx * state.cooling;
        n.y += n.vy * state.cooling;
        // world-space bounds (the camera views this box)
        n.x = Math.max(15, Math.min(state.W - 15, n.x));
        n.y = Math.max(15, Math.min(state.H - 15, n.y));
      }

      // Safety net: whatever the physics converges to, two nodes may never end
      // up on top of each other. Positions are corrected directly and the
      // closing velocity is killed, so this settles instead of oscillating
      // against gravity forever (which would keep the rAF loop alive).
      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        for (j = i + 1; j < nodes.length; j++) {
          m = nodes[j];
          var need = minGap(n, m);
          dx = m.x - n.x; dy = m.y - n.y;
          d = Math.sqrt(dx * dx + dy * dy);
          if (d >= need) continue;
          if (d < 0.01) {  // exactly coincident: pick a deterministic axis
            dx = Math.cos(i * 2.399); dy = Math.sin(i * 2.399); d = 1;
          }
          var push = (need - d) / 2;
          var ux = dx / d, uy = dy / d;
          if (n !== state.dragging) { n.x -= ux * push; n.y -= uy * push; }
          if (m !== state.dragging) { m.x += ux * push; m.y += uy * push; }
          // remove the component of velocity closing the gap
          var closing = (m.vx - n.vx) * ux + (m.vy - n.vy) * uy;
          if (closing < 0) {
            n.vx += ux * closing / 2; n.vy += uy * closing / 2;
            m.vx -= ux * closing / 2; m.vy -= uy * closing / 2;
          }
          n.x = Math.max(15, Math.min(state.W - 15, n.x));
          n.y = Math.max(15, Math.min(state.H - 15, n.y));
          m.x = Math.max(15, Math.min(state.W - 15, m.x));
          m.y = Math.max(15, Math.min(state.H - 15, m.y));
        }
      }

      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        moved += Math.abs(n.x - n.px) + Math.abs(n.y - n.py);
      }
      // Per node, not the raw total: the sum grows with the graph, so a fixed
      // total threshold gets harder to reach the more nodes there are. At 120
      // nodes each one moved 0.01px a frame — visually frozen — while the sum
      // stayed above the old cut-off and the rAF loop ran for ever.
      moved = moved / Math.max(1, nodes.length);

      // Anneal towards a low floor rather than parking at 0.35: a crowded
      // graph where springs and the collision pass tug against each other
      // never stops jiggling otherwise, and the rAF loop runs forever.
      // wake() re-energises this on any interaction.
      state.cooling = Math.max(0.06, state.cooling * 0.99);
      return moved;
    }

    function draw() {
      // clear in raw device pixels, then draw the world through the camera
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * state.scale, 0, 0, dpr * state.scale, dpr * state.ox, dpr * state.oy);

      state.edges.forEach(function (e) {
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
        if (e.type === 'sim') {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = COLORS.simEdge;
        } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = COLORS.edge;
        }
        ctx.lineWidth = state.settings.linkThickness;
        ctx.stroke();
      });
      ctx.setLineDash([]);

      var showAllLabels = state.nodes.length <= LABEL_LIMIT;
      state.nodes.forEach(function (n) {
        var r = radius(n);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        if (n.pinned) {
          ctx.fillStyle = COLORS.lime;
          ctx.fill();
          ctx.strokeStyle = COLORS.ink;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else if (n.kind === 'clip') {
          ctx.fillStyle = COLORS.bone;
          ctx.fill();
          ctx.strokeStyle = COLORS.ink;
          ctx.lineWidth = 2;
          ctx.stroke();
        } else if (n.kind === 'diary') {
          ctx.fillStyle = COLORS.gray;
          ctx.fill();
        } else {
          ctx.fillStyle = COLORS.ink;
          ctx.fill();
        }
        if (n === state.hover) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2);
          ctx.strokeStyle = COLORS.lime;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        if (showAllLabels || n === state.hover) {
          ctx.font = LABEL_FONT;
          ctx.fillStyle = COLORS.ink;
          ctx.textAlign = 'center';
          ctx.fillText(n.label.slice(0, 24), n.x, n.y - r - 6);
        }
      });
    }

    // Moves the camera a step towards the framing the current layout wants.
    // Returns true while it still has ground to cover, so the loop knows not to
    // stop mid-move. A no-op once the user has taken the camera, and for a
    // graph too sparse to frame.
    function stepCamera(settled) {
      if (!state.autoFit) return false;
      var f = computeFit(settled);
      if (!f) return false;
      state.fit = f;
      // Scale is what the eye reads first, so converge on it: the offsets are
      // derived from it and settle with it.
      var near = Math.abs(state.scale - f.scale) <= CAM_EPS * f.scale &&
                 Math.abs(state.ox - f.ox) <= 0.5 && Math.abs(state.oy - f.oy) <= 0.5;
      if (near || reducedMotion()) {
        state.scale = f.scale; state.ox = f.ox; state.oy = f.oy;
        return false;
      }
      state.scale += (f.scale - state.scale) * FIT_EASE;
      state.ox += (f.ox - state.ox) * FIT_EASE;
      state.oy += (f.oy - state.oy) * FIT_EASE;
      return true;
    }

    function loop() {
      var moved = step();
      var moving = stepCamera(moved <= SETTLE_PER_NODE && !state.dragging);
      draw();
      if (moved > SETTLE_PER_NODE || state.dragging || state.panning || moving) {
        state.raf = requestAnimationFrame(loop);
      } else {
        state.raf = null;
      }
      setDebug();
    }

    function wake() {
      state.cooling = Math.max(state.cooling, 0.6);
      if (!state.raf) {
        state.raf = requestAnimationFrame(loop);
        setDebug();
      }
    }

    // Exposed so the module-level setSettings() below can reach into whichever
    // mount is currently live, without mount()'s other internals leaking out.
    state.draw = draw;
    state.wake = wake;

    /* --- tooltip --- */

    function showTooltip(node, screen) {
      if (!state.getNoteInfo) return;
      var info = state.getNoteInfo(node.id);
      if (!info) return;
      tooltip.textContent = '';
      var title = document.createElement('div');
      title.className = 'graph-tooltip__title';
      title.textContent = info.title;
      var meta = document.createElement('div');
      meta.className = 'graph-tooltip__meta';
      meta.textContent = info.kind.toUpperCase() +
        (info.tags.length ? ' · #' + info.tags.join(' #') : '') +
        ' · ' + info.date;
      tooltip.appendChild(title);
      tooltip.appendChild(meta);
      var wrap = canvas.parentElement;
      tooltip.hidden = false;
      var x = Math.min(screen.x + 14, wrap.clientWidth - tooltip.offsetWidth - 6);
      var y = Math.min(screen.y + 14, wrap.clientHeight - tooltip.offsetHeight - 6);
      tooltip.style.left = Math.max(4, x) + 'px';
      tooltip.style.top = Math.max(4, y) + 'px';
    }

    function hideTooltip() {
      tooltip.hidden = true;
    }

    /* --- input --- */

    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      state.listeners.push({ target: target, type: type, fn: fn, opts: opts });
    }

    function pinchInfo() {
      var ids = Object.keys(state.pointers);
      if (ids.length < 2) return null;
      var a = state.pointers[ids[0]], b = state.pointers[ids[1]];
      return {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      };
    }

    on(canvas, 'pointerdown', function (e) {
      if (!state) return;
      var raw = rawPos(e);
      state.pointers[e.pointerId] = raw;
      canvas.setPointerCapture(e.pointerId);

      if (Object.keys(state.pointers).length === 2) {
        // second finger: switch to pinch, cancel drag/pan
        state.dragging = null;
        state.panning = null;
        state.downAt = null;
        state.pinch = pinchInfo();
        hideTooltip();
        return;
      }

      var n = pick(toWorld(raw));
      if (n) {
        // Dragging a node moves the layout under the camera. Re-framing while
        // that happens would slide the graph out from under the finger doing
        // the dragging, so the camera stops following here too.
        state.autoFit = false;
        state.dragging = n;
        state.downAt = { x: raw.x, y: raw.y, node: n };
        hideTooltip();
        wake();
      } else {
        state.autoFit = false;
        state.panning = { x: raw.x, y: raw.y, ox: state.ox, oy: state.oy };
        hideTooltip();
        wake();
      }
    });

    on(canvas, 'pointermove', function (e) {
      if (!state) return;
      var raw = rawPos(e);
      if (state.pointers[e.pointerId]) state.pointers[e.pointerId] = raw;

      if (state.pinch) {
        var cur = pinchInfo();
        if (cur) {
          zoomAt(cur.mid, cur.dist / state.pinch.dist);
          state.ox += cur.mid.x - state.pinch.mid.x;
          state.oy += cur.mid.y - state.pinch.mid.y;
          state.pinch = cur;
        }
        return;
      }

      if (state.dragging) {
        var w = toWorld(raw);
        state.dragging.x = Math.max(15, Math.min(state.W - 15, w.x));
        state.dragging.y = Math.max(15, Math.min(state.H - 15, w.y));
        wake();
        return;
      }

      if (state.panning) {
        state.ox = state.panning.ox + (raw.x - state.panning.x);
        state.oy = state.panning.oy + (raw.y - state.panning.y);
        wake();
        return;
      }

      var n = pick(toWorld(raw));
      if (n !== state.hover) {
        state.hover = n;
        canvas.style.cursor = n ? 'pointer' : 'default';
        wake();
      }
      if (n) showTooltip(n, raw);
      else hideTooltip();
    });

    function endPointer(e) {
      if (!state) return;
      delete state.pointers[e.pointerId];
      if (state.pinch && Object.keys(state.pointers).length < 2) state.pinch = null;

      var clickedNode = null;
      if (state.dragging && state.downAt) {
        var raw = rawPos(e);
        var dx = raw.x - state.downAt.x, dy = raw.y - state.downAt.y;
        if (dx * dx + dy * dy < 25) clickedNode = state.downAt.node;
      }
      state.dragging = null;
      state.panning = null;
      state.downAt = null;
      // fire last: the click callback may navigate away and destroy() this
      // graph synchronously — state must already be settled by then
      if (clickedNode && state.onNodeClick) state.onNodeClick(clickedNode.id);
    }

    on(canvas, 'pointerup', endPointer);
    on(canvas, 'pointercancel', endPointer);
    on(canvas, 'pointerleave', function () {
      if (!state) return;
      state.hover = null;
      hideTooltip();
      canvas.style.cursor = 'default';
    });

    on(canvas, 'wheel', function (e) {
      if (!state) return;
      e.preventDefault();
      // trackpad pinch arrives as wheel+ctrlKey — stronger factor there
      var k = e.ctrlKey ? 0.01 : 0.0018;
      zoomAt(rawPos(e), Math.exp(-e.deltaY * k));
    }, { passive: false });

    // Reset view: hand the camera back to the graph. It eases to the framing
    // from wherever the user left it, which is the same motion the graph makes
    // on arrival — rather than snapping to an identity transform that would
    // put the layout back in the middle of an empty canvas.
    on(canvas, 'dblclick', function (e) {
      if (!state) return;
      if (pick(toWorld(rawPos(e)))) return; // dblclick on a node: nothing new
      state.autoFit = true;
      wake();
    });

    on(document, 'visibilitychange', function () {
      if (!state) return;
      if (document.hidden) {
        if (state.raf) {
          cancelAnimationFrame(state.raf);
          state.raf = null;
          setDebug();
        }
      } else {
        wake();
      }
    });

    if (nodes.length <= 2) {
      // static layout, no physics drama — but the spacing still has to clear
      // the labels, which a fixed 120px didn't for longer titles
      var gap = nodes.length === 2
        ? Math.min(Math.max(120, minGap(nodes[0], nodes[1])), Math.max(120, state.W - 60))
        : 0;
      nodes.forEach(function (n, i) {
        n.x = state.W / 2 + (i - (nodes.length - 1) / 2) * gap;
        n.y = state.H / 2;
      });
      draw();
      setDebug();
    } else {
      state.raf = requestAnimationFrame(loop);
      setDebug();
    }
  }

  function destroy() {
    if (!state) { setDebug(); return; }
    if (state.raf) cancelAnimationFrame(state.raf);
    state.listeners.forEach(function (l) {
      l.target.removeEventListener(l.type, l.fn, l.opts);
    });
    if (state.tooltip && state.tooltip.parentElement) state.tooltip.remove();
    state = null;
    setDebug();
  }

  // Live-tweak the running simulation from the settings panel — no remount,
  // so dragging a slider doesn't reset the camera or scramble node positions.
  // Node size and link thickness are read straight off state.settings by
  // draw(), so a redraw is all they need. The four force multipliers change
  // what step() computes, so those re-wake the sim: without this the settle
  // detector (S-4) would see the graph as already at rest under its OLD
  // forces and never apply the new ones until some other interaction woke it.
  function setSettings(newSettings) {
    if (!state || !newSettings) return;
    var physicsKeys = ['repelForce', 'linkForce', 'centerForce', 'linkDistance'];
    var changed = physicsKeys.some(function (k) {
      return newSettings[k] !== undefined && newSettings[k] !== state.settings[k];
    });
    var merged = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      merged[k] = newSettings[k] !== undefined ? newSettings[k] : state.settings[k];
    });
    state.settings = merged;
    if (changed) state.wake();
    else state.draw();
  }

  setDebug();
  return { mount: mount, destroy: destroy, setSettings: setSettings };
})();
