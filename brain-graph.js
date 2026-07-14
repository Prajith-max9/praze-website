/* PRAZE Second Brain — force-directed graph view on canvas.
   BrainGraph.mount(canvas, data, onNodeClick) / BrainGraph.destroy().
   The sim is fully torn down on destroy — no rAF left running in background. */
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

  var state = null; // null when unmounted

  function setDebug() {
    window.__brainDebug = {
      nodes: state ? state.nodes.length : 0,
      edges: state ? state.edges.length : 0,
      running: !!(state && state.raf)
    };
  }

  function mount(canvas, data, onNodeClick) {
    destroy();

    var COLORS = themeColors();
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var W = Math.max(rect.width, 200);
    var H = Math.max(rect.height, 200);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

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

    state = {
      canvas: canvas, ctx: ctx, W: W, H: H,
      nodes: nodes, edges: edges, byId: byId,
      onNodeClick: onNodeClick,
      raf: null, cooling: 1, dragging: null, hover: null,
      downAt: null, listeners: []
    };

    function radius(node) {
      return 5 + Math.min(6, node.deg * 1.2);
    }

    function step() {
      var i, j, n, m, dx, dy, d2, d, f;
      var REPULSION = 1800;
      var SPRING = 0.015;
      var REST = 90;
      var GRAVITY = 0.012;
      var moved = 0;

      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        for (j = i + 1; j < nodes.length; j++) {
          m = nodes[j];
          dx = n.x - m.x; dy = n.y - m.y;
          d2 = dx * dx + dy * dy || 1;
          if (d2 < 90000) { // ignore far pairs
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
        n.x = Math.max(15, Math.min(state.W - 15, n.x));
        n.y = Math.max(15, Math.min(state.H - 15, n.y));
        moved += Math.abs(n.vx) + Math.abs(n.vy);
      }

      state.cooling = Math.max(0.35, state.cooling * 0.995);
      return moved;
    }

    function draw() {
      ctx.clearRect(0, 0, state.W, state.H);

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
          ctx.font = '11px "Space Mono", monospace';
          ctx.fillStyle = COLORS.ink;
          ctx.textAlign = 'center';
          ctx.fillText(n.label.slice(0, 24), n.x, n.y - r - 6);
        }
      });
    }

    function loop() {
      var moved = step();
      draw();
      // keep animating while there's motion, a drag, or early settling
      if (moved > 0.5 || state.dragging) {
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

    function pointerPos(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function pick(p) {
      for (var i = state.nodes.length - 1; i >= 0; i--) {
        var n = state.nodes[i];
        var dx = p.x - n.x, dy = p.y - n.y;
        var r = radius(n) + 5;
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    }

    function on(target, type, fn) {
      target.addEventListener(type, fn);
      state.listeners.push({ target: target, type: type, fn: fn });
    }

    on(canvas, 'pointerdown', function (e) {
      var p = pointerPos(e);
      var n = pick(p);
      if (n) {
        state.dragging = n;
        state.downAt = { x: p.x, y: p.y, node: n };
        canvas.setPointerCapture(e.pointerId);
        wake();
      }
    });

    on(canvas, 'pointermove', function (e) {
      var p = pointerPos(e);
      if (state.dragging) {
        state.dragging.x = Math.max(15, Math.min(state.W - 15, p.x));
        state.dragging.y = Math.max(15, Math.min(state.H - 15, p.y));
        wake();
      } else {
        var n = pick(p);
        if (n !== state.hover) {
          state.hover = n;
          canvas.style.cursor = n ? 'pointer' : 'default';
          wake();
        }
      }
    });

    on(canvas, 'pointerup', function (e) {
      if (state.dragging && state.downAt) {
        var p = pointerPos(e);
        var dx = p.x - state.downAt.x, dy = p.y - state.downAt.y;
        if (dx * dx + dy * dy < 25 && state.onNodeClick) {
          state.onNodeClick(state.downAt.node.id);
        }
      }
      state.dragging = null;
      state.downAt = null;
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
      // static layout, no physics drama
      nodes.forEach(function (n, i) {
        n.x = state.W / 2 + (i - (nodes.length - 1) / 2) * 120;
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
      l.target.removeEventListener(l.type, l.fn);
    });
    state = null;
    setDebug();
  }

  setDebug();
  return { mount: mount, destroy: destroy };
})();
