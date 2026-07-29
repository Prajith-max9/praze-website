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

  var state = null; // null when unmounted

  function setDebug() {
    window.__brainDebug = {
      nodes: state ? state.nodes.length : 0,
      edges: state ? state.edges.length : 0,
      running: !!(state && state.raf),
      scale: state ? state.scale : 1,
      ox: state ? state.ox : 0,
      oy: state ? state.oy : 0,
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

  function mount(canvas, data, onNodeClick, getNoteInfo) {
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
      dragging: null, panning: null, downAt: null,
      pointers: {}, pinch: null, camAnim: null,
      hover: null, tooltip: tooltip, listeners: []
    };

    function radius(node) {
      return 5 + Math.min(6, node.deg * 1.2);
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

    // zoom about a screen point: the world point under it stays put
    function zoomAt(screen, factor) {
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
      var REPULSION = 1800 * Math.max(1, 30 / Math.max(count, 1));
      var SPRING = 0.015;
      var REST = 90;
      var GRAVITY = 0.012 * Math.max(0.35, Math.min(1, count / 10));
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
        ctx.lineWidth = 1;
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

    function stepCamAnim() {
      var a = state.camAnim;
      if (!a) return;
      var p = Math.min(1, (performance.now() - a.t0) / 250);
      var ease = p * (2 - p);
      state.scale = a.fromS + (1 - a.fromS) * ease;
      state.ox = a.fromOx * (1 - ease);
      state.oy = a.fromOy * (1 - ease);
      if (p >= 1) state.camAnim = null;
    }

    function loop() {
      stepCamAnim();
      var moved = step();
      draw();
      if (moved > 0.5 || state.dragging || state.panning || state.camAnim) {
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
        state.dragging = n;
        state.downAt = { x: raw.x, y: raw.y, node: n };
        hideTooltip();
        wake();
      } else {
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

    on(canvas, 'dblclick', function (e) {
      if (!state) return;
      if (pick(toWorld(rawPos(e)))) return; // dblclick on a node: nothing new
      state.camAnim = { t0: performance.now(), fromS: state.scale, fromOx: state.ox, fromOy: state.oy };
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

  setDebug();
  return { mount: mount, destroy: destroy };
})();
