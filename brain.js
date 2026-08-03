/* Second Brain — capture, tag, search, link, reflect. All data lives in localStorage.
   (praze.* localStorage keys are a legacy internal namespace — never rename them.) */
(function () {
  'use strict';

  var STORAGE_KEY = 'praze.brain.v1';
  var PRE_MIGRATION_KEY = 'praze.brain.v1.pre-migration';
  var RESURFACE_DISMISSED_KEY = 'praze.brain.resurface.dismissed'; // UI state — never in store or exports
  var NOTIFY_ASKED_KEY = 'praze.brain.notifyasked'; // UI state — never in store or exports
  var SCHEMA_VERSION = 2;
  var VIEWS = ['dashboard', 'ask', 'ideas', 'diary', 'timeline', 'clips', 'goals', 'todos', 'graph'];

  /* ---------- Utils ---------- */

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  function formatDate(ms) {
    var d = new Date(ms);
    var day = String(d.getDate()).padStart(2, '0');
    return day + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  var DAY_MS = 86400000;

  function formatRelative(ms) {
    var now = new Date();
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= startOfToday) return 'today';
    if (ms >= startOfToday - DAY_MS) return 'yesterday';
    var daysAgo = Math.floor((startOfToday - ms) / DAY_MS) + 1;
    if (daysAgo < 7) return daysAgo + 'd ago';
    return formatDate(ms);
  }

  // Plain-words age for old notes ("4 months ago"). formatRelative switches to an
  // absolute date after a week, which reads wrong when the point is distance in time.
  function formatAge(ms) {
    var days = Math.floor((Date.now() - ms) / DAY_MS);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 30) {
      var weeks = Math.floor(days / 7);
      return weeks + (weeks === 1 ? ' week ago' : ' weeks ago');
    }
    if (days < 365) {
      var months = Math.floor(days / 30);
      return months + (months === 1 ? ' month ago' : ' months ago');
    }
    var years = Math.floor(days / 365);
    return years + (years === 1 ? ' year ago' : ' years ago');
  }

  // Collapse an element (height + fade, ~180ms) then run fn. The stylesheet's
  // reduced-motion override collapses the inline duration too, so with motion
  // off this resolves immediately; the timeout guarantees fn always runs.
  function collapseThen(el, fn) {
    if (!el) {
      fn();
      return;
    }
    el.style.height = el.offsetHeight + 'px';
    el.style.overflow = 'hidden';
    void el.offsetHeight;
    el.style.transition = 'height 0.18s ease-out, opacity 0.18s ease-out';
    el.style.height = '0px';
    el.style.opacity = '0';
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      fn();
    }
    el.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 240);
  }

  // One-shot spring pop (see .pop-once). Restartable: remove + reflow + add.
  function popOnce(el) {
    if (!el) return;
    el.classList.remove('pop-once');
    void el.offsetWidth;
    el.classList.add('pop-once');
  }

  // Grows a textarea to fit its content, but never past the max-height its CSS
  // sets — otherwise a long dictation session ends up with a 24,000px box and
  // the save button nowhere near the screen.
  // Grows a textarea to fit its content, up to the max-height its CSS sets.
  // Dictation calls this on every speech event, so the common case has to cost
  // nothing: the ceiling is cached (reading it back forces a style recalc), and
  // once the box is pinned at that ceiling more text cannot change its height,
  // so the reset-and-remeasure — the actual layout thrash — is skipped
  // entirely. Any shrink falls through and re-measures properly.
  function autoGrow(el) {
    if (el.__growVh !== window.innerHeight) {   // vh-based ceiling, recheck on resize
      var m = parseFloat(getComputedStyle(el).maxHeight); // NaN when 'none'
      el.__growMax = m > 0 ? m : 0;
      el.__growVh = window.innerHeight;
      el.__growCapped = false;
    }
    var len = el.value.length;
    if (el.__growMax && el.__growCapped && len > el.__growLen) {
      el.__growLen = len;
      return;
    }
    el.__growLen = len;
    el.style.height = 'auto';
    var h = el.scrollHeight;
    if (el.__growMax && h > el.__growMax) {
      el.style.height = el.__growMax + 'px';
      el.__growCapped = true;
    } else {
      el.style.height = h + 'px';
      el.__growCapped = false;
    }
  }

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function dayKeyOf(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  // Only http/https URLs are ever rendered as hrefs
  function safeUrl(url) {
    try {
      var u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (e) {}
    return null;
  }

  /* ---------- Storage ---------- */

  function migrateStore(store, rawString) {
    if (store.schemaVersion === SCHEMA_VERSION) return store;
    // v1 → v2: keep a one-time untouched safety copy of the pre-migration payload
    try {
      if (rawString && !localStorage.getItem(PRE_MIGRATION_KEY)) {
        localStorage.setItem(PRE_MIGRATION_KEY, rawString);
      }
    } catch (e) {}
    store.notes.forEach(function (n) {
      if (!n.kind) n.kind = 'idea';
      if (typeof n.url !== 'string') n.url = '';
    });
    if (!Array.isArray(store.goals)) store.goals = [];
    if (!Array.isArray(store.todos)) store.todos = [];
    if (typeof store.rev !== 'number') store.rev = 0;
    store.schemaVersion = SCHEMA_VERSION;
    // persist immediately so localStorage reflects v2 without waiting for an edit
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) {}
    return store;
  }

  function emptyStore() {
    return { schemaVersion: SCHEMA_VERSION, rev: 0, notes: [], goals: [], todos: [] };
  }

  function backupCorrupt(raw) {
    try { localStorage.setItem(STORAGE_KEY + '.corrupt.' + Date.now(), raw); } catch (e) {}
  }

  // The single definition of a well-formed note, shared by the import path and
  // the boot load path. Returns a normalized copy, or null when the input can't
  // be repaired into a note. Valid notes round-trip unchanged.
  function sanitizeNote(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (typeof raw.body !== 'string') return null;
    return {
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : '',
      body: raw.body,
      tags: normalizeTags(Array.isArray(raw.tags) ? raw.tags.join(',') : ''),
      pinned: !!raw.pinned,
      kind: raw.kind === 'diary' || raw.kind === 'clip' ? raw.kind : 'idea',
      url: typeof raw.url === 'string' ? raw.url : '',
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
    };
  }

  function sanitizeGoal(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    var target = typeof raw.target === 'number' && raw.target >= 1 ? Math.floor(raw.target) : null;
    if (target === null) return null;
    return {
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : '',
      target: target,
      progress: typeof raw.progress === 'number' && raw.progress >= 0 ? Math.floor(raw.progress) : 0,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : null
    };
  }

  // Todos arrived after schema v2 shipped, so there is no version bump behind
  // them: a store written by the previous build simply has no `todos` key, and
  // every read path defaults it to []. That keeps old exports importable and
  // old tabs from choking on the new field.
  function sanitizeTodo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (typeof raw.text !== 'string' || isBlank(raw.text)) return null;
    var due = typeof raw.dueAt === 'number' && isFinite(raw.dueAt) ? raw.dueAt : null;
    return {
      id: raw.id,
      text: raw.text,
      done: !!raw.done,
      dueAt: due,
      // no due time means nothing to fire, so such a todo is never "pending"
      notified: due ? !!raw.notified : false,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : null,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
    };
  }

  // Repair what can be repaired, drop what can't, and report how much was lost.
  // Without this a single null note — or one with a missing tags array, or a
  // non-string body — took render() down on boot and left a blank app with no
  // banner and no way back in.
  function sanitizeStore(s) {
    var dropped = 0;
    var notes = [];
    s.notes.forEach(function (n) {
      var clean = sanitizeNote(n);
      if (clean) notes.push(clean); else dropped++;
    });
    var goals = [];
    s.goals.forEach(function (g) {
      var clean = sanitizeGoal(g);
      if (clean) goals.push(clean); else dropped++;
    });
    var todos = [];
    (s.todos || []).forEach(function (t) {
      var clean = sanitizeTodo(t);
      if (clean) todos.push(clean); else dropped++;
    });
    s.notes = notes;
    s.goals = goals;
    s.todos = todos;
    return dropped;
  }

  function loadStore() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      showBanner('Could not access browser storage — notes will not persist.', 'error', true);
      return emptyStore();
    }
    if (!raw) return emptyStore();
    var parsed, dropped = 0;
    try {
      parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.notes)) throw new Error('bad shape');
      if (!Array.isArray(parsed.goals)) parsed.goals = [];
      if (!Array.isArray(parsed.todos)) parsed.todos = [];
      if (typeof parsed.rev !== 'number') parsed.rev = 0;
      // Sanitize before migrating, for two reasons: migrateStore walks every
      // note, so one null entry would throw and take the good notes down with
      // it; and it returns early on an already-v2 payload, which is how
      // malformed notes used to reach render() untouched.
      dropped = sanitizeStore(parsed);
      parsed = migrateStore(parsed, raw);
    } catch (e) {
      // Preserve the unreadable data instead of overwriting it
      backupCorrupt(raw);
      showBanner('Stored notes were unreadable; a raw backup was kept in localStorage.', 'error', true);
      return emptyStore();
    }
    if (dropped) {
      backupCorrupt(raw);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)); } catch (e2) {}
      showBanner('Skipped ' + dropped + (dropped === 1 ? ' unreadable item' : ' unreadable items') +
        '; a raw backup was kept in localStorage.', 'error', true);
    }
    return parsed;
  }

  /* ---------- Cross-tab merge ----------
     Two tabs each hold the whole store in memory and write it whole, so the
     last writer used to erase whatever the other had added. On another tab's
     write we merge per id instead of adopting its store wholesale: later
     updatedAt wins per note, and anything only we hold is kept.

     This is a union, not a CRDT — it has no way to tell "deleted over there"
     from "created over here", so a note deleted in one tab can be brought back
     by another tab that still has it. That is exactly what already happened
     before this change, and unlike before, nothing new is lost. */

  function mergeById(theirs, mine, newerWins) {
    var byId = {};
    var order = [];
    function take(list) {
      list.forEach(function (item) {
        var prev = byId[item.id];
        if (!prev) { byId[item.id] = item; order.push(item.id); }
        else if (newerWins(item, prev)) byId[item.id] = item;
      });
    }
    take(theirs);
    take(mine);
    return order.map(function (id) { return byId[id]; });
  }

  function mergeStores(mine, theirs) {
    return {
      notes: mergeById(theirs.notes, mine.notes, function (a, b) {
        return (a.updatedAt || 0) > (b.updatedAt || 0);
      }),
      // goals carry no updatedAt, so the one further along wins
      goals: mergeById(theirs.goals, mine.goals, function (a, b) {
        return (a.progress || 0) > (b.progress || 0);
      }),
      todos: mergeById(theirs.todos, mine.todos, function (a, b) {
        return (a.updatedAt || 0) > (b.updatedAt || 0);
      })
    };
  }

  function handleStorageEvent(e) {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    var theirs;
    try { theirs = JSON.parse(e.newValue); } catch (err) { return; }
    if (!theirs || !Array.isArray(theirs.notes)) return;
    if (!Array.isArray(theirs.goals)) theirs.goals = [];
    if (!Array.isArray(theirs.todos)) theirs.todos = [];
    sanitizeStore(theirs);

    var merged = mergeStores(store, theirs);
    // If the merge holds anything their payload didn't, write it back so the
    // other tab picks it up. Their write already matches the merge otherwise,
    // which is what stops two tabs echoing each other forever.
    var weHoldMore = JSON.stringify(merged) !==
      JSON.stringify({ notes: theirs.notes, goals: theirs.goals, todos: theirs.todos });
    store.notes = merged.notes;
    store.goals = merged.goals;
    store.todos = merged.todos;
    if (typeof theirs.rev === 'number') store.rev = Math.max(store.rev || 0, theirs.rev);
    scheduleTodoReminders(); // the other tab may have added or cleared a due time
    render();
    if (weHoldMore) saveStore();
  }

  // Returns true when the write actually landed. Callers MUST check it before
  // reporting success, clearing a draft or resetting a form: a full quota used
  // to be reported as "Idea captured." and the draft was wiped along with it,
  // so the note vanished on the next reload with the user none the wiser.
  function saveStore() {
    store.rev = (store.rev || 0) + 1;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      return true;
    } catch (e) {
      showBanner('Storage full — export your notes now to avoid losing them.', 'error', true);
      return false;
    }
  }

  /* ---------- Model ---------- */

  // trim() only removes whitespace, and a zero-width joiner is not whitespace,
  // so pasting text made only of invisible characters passed the "is it empty"
  // check and produced a blank note card. Used for the emptiness test alone —
  // the text itself is stored untouched, because U+200D is what holds an emoji
  // like 👨‍👩‍👧‍👦 together.
  var INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD\u2800]/g;

  function isBlank(text) {
    return !String(text == null ? '' : text).replace(INVISIBLE, '').trim();
  }

  function normalizeTags(input) {
    var seen = {};
    return String(input || '')
      .split(',')
      .map(function (t) { return t.trim().replace(/^#+/, '').toLowerCase(); })
      .filter(function (t) {
        if (!t || seen[t]) return false;
        seen[t] = true;
        return true;
      });
  }

  function createNote(title, body, tagsInput, kind, url) {
    var now = Date.now();
    return {
      id: makeId(),
      title: title.trim(),
      body: body.trim(),
      tags: normalizeTags(tagsInput),
      pinned: false,
      kind: kind || 'idea',
      url: url || '',
      createdAt: now,
      updatedAt: now
    };
  }

  /* Draft persistence: a half-typed capture survives refresh/close */

  var DRAFT_KEY = 'praze.brain.draft.v1';

  function saveDraft() {
    try {
      var draft = {
        title: els.captureTitle.value,
        body: els.captureBody.value,
        tags: els.captureTags.value
      };
      if (draft.title || draft.body || draft.tags) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch (e) {}
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  // The diary entry gets the same treatment as the capture box: half-written
  // entries used to be the one kind of unsaved text a reload threw away.
  var DIARY_DRAFT_KEY = 'praze.brain.diarydraft.v1';

  function saveDiaryDraft() {
    try {
      var body = els.diaryBody.value;
      if (body) localStorage.setItem(DIARY_DRAFT_KEY, body);
      else localStorage.removeItem(DIARY_DRAFT_KEY);
    } catch (e) {}
  }

  function clearDiaryDraft() {
    try { localStorage.removeItem(DIARY_DRAFT_KEY); } catch (e) {}
  }

  function restoreDraft() {
    var draft;
    try {
      draft = JSON.parse(localStorage.getItem(DRAFT_KEY));
    } catch (e) {}
    var diary = '';
    try { diary = localStorage.getItem(DIARY_DRAFT_KEY) || ''; } catch (e) {}

    if (diary) {
      els.diaryBody.value = diary;
      autoGrow(els.diaryBody);
    }
    if (!draft || !(draft.title || draft.body || draft.tags)) {
      if (diary) showBanner('Draft restored — you have an unsaved diary entry.');
      return;
    }
    els.captureTitle.value = draft.title || '';
    els.captureBody.value = draft.body || '';
    els.captureTags.value = draft.tags || '';
    autoGrow(els.captureBody);
    renderTagSuggest();
    showBanner(diary
      ? 'Drafts restored — you have an unsaved note and diary entry.'
      : 'Draft restored — you have an unsaved note.');
  }

  /* ---------- State ---------- */

  var store = emptyStore();
  var state = {
    view: 'ideas',
    query: '',
    activeTag: null,
    editingId: null,
    confirmingDeleteId: null,
    confirmingGoalId: null,
    aiBusy: {},
    aiSuggest: {},   // note id -> suggested tags from Claude
    aiReflect: {},   // note id -> {themes, reflection} from Claude
    digest: null,    // {pattern, tension, question} — render-time only, never stored
    digestBusy: false,
    lastDeleted: null, // {kind, item, index} — in-memory undo, never persisted or exported
    timelineFilter: 'all', // all | idea | diary | clip
    timelineShown: 50,     // lazy-render window; grows as the sentinel comes into view
    ask: null,   // {busy, question, sources, answer, keyless} — render-time only, never stored
    whyBusy: {}, // pair key -> in-flight flag
    whyText: {}, // pair key -> one-sentence explanation — render-time only, never stored
    selectMode: false,   // IDEAS multi-select for synthesize
    selected: {},        // note id -> true
    synthChoosing: false, // format chooser open in the bottom bar
    synth: null,         // {busy, format, text} — render-time only, never stored unless saved
    todosDoneOpen: false, // the Done section starts collapsed
    todoDueId: null      // todo whose inline due-time editor is open
  };

  /* ---------- Todo reminders ----------
     Browser-local only: there is no server, so there is no push. A due time
     arms a setTimeout in this tab and (when permission is granted) fires one
     Notification. That works while the app is open or freshly backgrounded and
     stops being reliable once the OS suspends or kills the page — iOS Safari
     in particular gives a closed PWA no timer at all. Nothing in the UI claims
     otherwise, and a todo with no notification is still a todo with a visible
     due time. */

  var todoTimers = {};      // todo id -> setTimeout handle
  var swReg = null;         // service-worker registration, when one exists
  var REMINDER_GRACE_MS = 5 * 60 * 1000;
  var TIMER_CEILING_MS = 2147483000; // setTimeout overflows past ~24.8 days and fires at once

  function notifyPermission() {
    try {
      if (!('Notification' in window) || !window.Notification) return 'unsupported';
      return Notification.permission;
    } catch (e) {
      return 'unsupported';
    }
  }

  function notifyAsked() {
    try { return localStorage.getItem(NOTIFY_ASKED_KEY) === '1'; } catch (e) { return true; }
  }

  // Asked at most once, ever, and only when a due time is actually set. A
  // refusal is final here: browsers suppress the prompt after one denial
  // anyway, so re-calling it on every save would only be the nagging the
  // feature is supposed to avoid.
  function maybeRequestNotifications() {
    if (notifyPermission() !== 'default' || notifyAsked()) return;
    try { localStorage.setItem(NOTIFY_ASKED_KEY, '1'); } catch (e) {}
    try {
      var settled = function () {
        if (state.view === 'todos') renderTodos();
        scheduleTodoReminders();
      };
      var r = Notification.requestPermission(settled);
      if (r && typeof r.then === 'function') r.then(settled, function () {});
    } catch (e) {}
  }

  // Prefers the service worker: Android Chrome throws on `new Notification()`
  // and only accepts notifications raised from a registration.
  function fireTodoNotification(todo) {
    if (notifyPermission() !== 'granted') return false;
    var opts = {
      body: todo.text.slice(0, 120),
      tag: 'todo-' + todo.id,
      icon: 'icon-192.png'
    };
    try {
      if (swReg && typeof swReg.showNotification === 'function') {
        swReg.showNotification('Second Brain', opts);
        return true;
      }
      new Notification('Second Brain', opts); // constructed for the side effect
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearTodoTimers() {
    Object.keys(todoTimers).forEach(function (id) { clearTimeout(todoTimers[id]); });
    todoTimers = {};
  }

  // Re-armed from scratch on every todo change, on boot, and whenever the tab
  // comes back to the foreground — background timers get throttled or dropped,
  // so the wake-up is the only moment their state can be trusted.
  function scheduleTodoReminders() {
    clearTodoTimers();
    var now = Date.now();
    var changed = false;
    store.todos.forEach(function (t) {
      if (t.done || !t.dueAt || t.notified) return;
      var delay = t.dueAt - now;
      if (delay <= 0) {
        // Came due while the tab was closed or asleep. Inside the grace window
        // the popup is still the nudge it was meant to be; older than that it
        // would just be noise on open, so it is marked missed and the list
        // shows it as OVERDUE instead.
        if (delay > -REMINDER_GRACE_MS) fireTodoNotification(t);
        t.notified = true;
        changed = true;
        return;
      }
      if (delay > TIMER_CEILING_MS) return; // too far out to arm; the next boot re-arms it
      todoTimers[t.id] = setTimeout(function () {
        delete todoTimers[t.id];
        // the todo may have been ticked off, deleted or rescheduled since
        var live = store.todos.filter(function (x) { return x.id === t.id; })[0];
        if (!live || live.done || live.notified || live.dueAt !== t.dueAt) return;
        fireTodoNotification(live);
        live.notified = true;
        live.updatedAt = Date.now();
        saveStore();
        if (state.view === 'todos') renderTodos();
      }, delay);
    });
    if (changed) saveStore();
  }

  /* ---------- Graph settings ----------
     Visual/tuning knobs on the force layout that already exists in
     brain-graph.js — no new physics, just multipliers a user can move. Kept
     separate from `store` (never exported, never synced across tabs — purely
     a local display preference, same tier as theme). */

  var GRAPH_SETTINGS_KEY = 'praze.brain.graphsettings.v1';
  var GRAPH_SETTINGS_DEFAULTS = {
    nodeSize: 1, linkThickness: 1, repelForce: 1, linkForce: 1,
    centerForce: 1, linkDistance: 1, showOrphans: true
  };
  var GRAPH_SETTINGS_RANGE = {
    nodeSize: [0.5, 2], linkThickness: [0.5, 3], repelForce: [0.3, 3],
    linkForce: [0.3, 3], centerForce: [0.3, 3], linkDistance: [0.5, 2.5]
  };

  function loadGraphSettings() {
    var out = Object.assign({}, GRAPH_SETTINGS_DEFAULTS);
    try {
      var raw = JSON.parse(localStorage.getItem(GRAPH_SETTINGS_KEY));
      if (raw && typeof raw === 'object') {
        Object.keys(GRAPH_SETTINGS_RANGE).forEach(function (k) {
          if (typeof raw[k] === 'number' && isFinite(raw[k])) {
            var r = GRAPH_SETTINGS_RANGE[k];
            out[k] = Math.max(r[0], Math.min(r[1], raw[k]));
          }
        });
        if (typeof raw.showOrphans === 'boolean') out.showOrphans = raw.showOrphans;
      }
    } catch (e) {}
    return out;
  }

  function saveGraphSettings() {
    try { localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(graphSettings)); } catch (e) {}
  }

  var graphSettings = GRAPH_SETTINGS_DEFAULTS;

  /* ---------- Search (ideas) ---------- */

  function tokenize(query) {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
  }

  function noteMatches(note, tokens, activeTag) {
    if (activeTag && note.tags.indexOf(activeTag) === -1) return false;
    if (!tokens.length) return true;
    var haystack = (note.title + '\n' + note.body + '\n' + note.tags.join(' ')).toLowerCase();
    return tokens.every(function (tok) { return haystack.indexOf(tok) !== -1; });
  }

  function ideas() {
    return store.notes.filter(function (n) { return n.kind === 'idea'; });
  }

  function filterIdeas() {
    var tokens = tokenize(state.query);
    return ideas()
      .filter(function (n) { return noteMatches(n, tokens, state.activeTag); })
      .sort(function (a, b) {
        return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.createdAt - a.createdAt;
      });
  }

  /* ---------- Wiki-links ---------- */

  var WIKI_LINK_RE = /\[\[([^\[\]]+)\]\]/g;

  function buildLinkIndexes() {
    var titleIndex = {};
    store.notes
      .slice()
      .sort(function (a, b) { return a.createdAt - b.createdAt; })
      .forEach(function (n) {
        var key = n.title.trim().toLowerCase();
        if (key) titleIndex[key] = n;
      });

    var backlinks = {};
    store.notes.forEach(function (src) {
      var seen = {};
      var m;
      WIKI_LINK_RE.lastIndex = 0;
      while ((m = WIKI_LINK_RE.exec(src.body))) {
        var target = titleIndex[m[1].trim().toLowerCase()];
        if (target && target.id !== src.id && !seen[target.id]) {
          seen[target.id] = true;
          (backlinks[target.id] = backlinks[target.id] || []).push(src);
        }
      }
    });

    return { titleIndex: titleIndex, backlinks: backlinks };
  }

  function renderBody(text, tokens, titleIndex) {
    return text.split(WIKI_LINK_RE).map(function (part, i) {
      if (i % 2 === 0) return highlight(part, tokens);
      var target = titleIndex[part.trim().toLowerCase()];
      if (target) {
        return '<a href="#" class="wiki-link" data-action="open-note" data-note-id="' +
          escapeHtml(target.id) + '">' + highlight(part, tokens) + '</a>';
      }
      return '<button type="button" class="wiki-link wiki-link--missing" data-action="new-note" data-title="' +
        escapeHtml(part.trim()) + '" title="No note with this title yet — click to create it">' +
        highlight(part, tokens) + '</button>';
    }).join('');
  }

  /* ---------- Similarity glue ---------- */

  function getAnalysis() {
    return window.BrainAI.analyze(store.notes, store.rev);
  }

  function notesById() {
    var map = {};
    store.notes.forEach(function (n) { map[n.id] = n; });
    return map;
  }

  function noteLabel(note) {
    return note.title || note.body.slice(0, 32) + (note.body.length > 32 ? '…' : '');
  }

  function whyPairKey(aId, bId) {
    return aId < bId ? aId + '|' + bId : bId + '|' + aId;
  }

  function renderRelatedRow(note, byId) {
    var entries = getAnalysis().related[note.id];
    if (!entries || !entries.length) return '';
    var hasKey = window.BrainAI.hasKey(); // keyless → no WHY? at all, not a dead button
    var chips = '';
    var whys = '';
    entries.forEach(function (r) {
      var other = byId[r.id];
      if (!other) return;
      chips += '<button type="button" class="backlink" data-action="open-note" data-note-id="' +
        escapeHtml(other.id) + '">' + escapeHtml(noteLabel(other)) + '</button>';
      if (hasKey) {
        var key = whyPairKey(note.id, other.id);
        var busy = state.whyBusy[key];
        chips += '<button type="button" class="why-btn" data-action="why-link" data-other-id="' +
          escapeHtml(other.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? '…' : 'why?') + '</button>';
        if (state.whyText[key]) {
          whys += '<p class="why-text"><span class="why-text__pair">↔ ' + escapeHtml(noteLabel(other)) +
            '</span> ' + escapeHtml(state.whyText[key]) + '</p>';
        }
      }
    });
    if (!chips) return '';
    return '<div class="note__backlinks note__related"><span class="note__backlinks-label">Related</span>' +
      chips + '</div>' + whys;
  }

  function renderSimTagRow(note, byId) {
    var entries = getAnalysis().related[note.id];
    var suggestions = window.BrainAI.suggestTags(note, entries, byId);
    if (!suggestions.length) return '';
    return '<div class="note__backlinks"><span class="note__backlinks-label">Add?</span>' +
      suggestions.map(function (t) {
        return '<button type="button" class="tag-chip" data-action="apply-tag" data-tag="' +
          escapeHtml(t) + '">+ #' + escapeHtml(t) + '</button>';
      }).join('') + '</div>';
  }

  function renderAiSuggestRow(note) {
    var tags = state.aiSuggest[note.id];
    if (!tags || !tags.length) return '';
    return '<div class="note__backlinks note__ai"><span class="note__backlinks-label">AI says</span>' +
      tags.map(function (t) {
        return '<button type="button" class="tag-chip tag-chip--ai" data-action="apply-tag" data-tag="' +
          escapeHtml(t) + '">+ #' + escapeHtml(t) + '</button>';
      }).join('') + '</div>';
  }

  /* ---------- Rendering: shared ---------- */

  var els = {};

  function highlight(text, tokens) {
    if (!tokens.length) return escapeHtml(text);
    var re = new RegExp('(' + tokens.map(escapeRegExp).join('|') + ')', 'gi');
    return text.split(re).map(function (part, i) {
      var safe = escapeHtml(part);
      return i % 2 === 1 ? '<mark>' + safe + '</mark>' : safe;
    }).join('');
  }

  function bodySnippet(body, tokens) {
    var LIMIT = 280;
    if (body.length <= LIMIT) return body;
    if (tokens.length) {
      var lower = body.toLowerCase();
      var first = -1;
      tokens.forEach(function (tok) {
        var idx = lower.indexOf(tok);
        if (idx !== -1 && (first === -1 || idx < first)) first = idx;
      });
      if (first > LIMIT / 2) {
        var start = Math.max(0, first - Math.floor(LIMIT / 2));
        return '…' + body.slice(start, start + LIMIT) + '…';
      }
    }
    return body.slice(0, LIMIT) + '…';
  }

  function tagCounts() {
    var counts = {};
    ideas().forEach(function (n) {
      n.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    return counts;
  }

  function sortedTags(counts) {
    return Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b);
    });
  }

  function renderTagChip(tag, count) {
    var active = state.activeTag === tag;
    return '<button type="button" class="tag-chip' + (active ? ' tag-chip--active' : '') + '"' +
      ' data-action="tag" data-tag="' + escapeHtml(tag) + '">#' + escapeHtml(tag) +
      (count != null ? '<span class="tag-chip__count">' + count + '</span>' : '') +
      '</button>';
  }

  function renderTagRail() {
    var counts = tagCounts();
    els.tagRail.innerHTML = sortedTags(counts).map(function (t) {
      return renderTagChip(t, counts[t]);
    }).join('');
  }

  function renderTagSuggest() {
    var counts = tagCounts();
    var current = normalizeTags(els.captureTags.value);
    var tags = sortedTags(counts).slice(0, 12);
    els.tagSuggest.innerHTML = tags.length
      ? '<span class="tag-suggest__label">quick add</span>' + tags.map(function (t) {
          var active = current.indexOf(t) !== -1;
          return '<button type="button" class="tag-chip' + (active ? ' tag-chip--active' : '') +
            '" data-action="suggest-tag" data-tag="' + escapeHtml(t) + '">#' + escapeHtml(t) + '</button>';
        }).join('')
      : '';
  }

  function renderEditForm(note) {
    return '<li class="note note--editing" data-id="' + escapeHtml(note.id) + '">' +
      '<input class="note__edit-title" type="text" value="' + escapeHtml(note.title) + '" placeholder="Title (optional)">' +
      '<textarea class="note__edit-body" rows="4">' + escapeHtml(note.body) + '</textarea>' +
      '<input class="note__edit-tags" type="text" value="' + escapeHtml(note.tags.join(', ')) + '" placeholder="tags: training, content">' +
      '<div class="note__meta"><span class="note__date">' + formatDate(note.createdAt) + '</span>' +
      '<div class="note__actions">' +
      '<button type="button" class="note__action" data-action="edit-save">Save</button>' +
      '<button type="button" class="note__action" data-action="edit-cancel">Cancel</button>' +
      '</div></div></li>';
  }

  function deleteOrActions(note, extraActions) {
    if (state.confirmingDeleteId === note.id) {
      return '<span class="note__date">Delete?</span>' +
        '<button type="button" class="note__action note__action--danger" data-action="delete-yes">Yes</button>' +
        '<button type="button" class="note__action" data-action="delete-no">No</button>';
    }
    return (extraActions || '') +
      '<button type="button" class="note__action" data-action="edit">Edit</button>' +
      '<button type="button" class="note__action note__action--danger" data-action="delete-ask">Delete</button>';
  }

  /* ---------- IDEAS view ---------- */

  function renderNoteCard(note, tokens, links, byId) {
    if (state.editingId === note.id) return renderEditForm(note);

    var titleHtml = note.title
      ? '<h2 class="note__title">' + highlight(note.title, tokens) + '</h2>'
      : '';
    var tagsHtml = note.tags.length
      ? '<div class="note__tags">' + note.tags.map(function (t) { return renderTagChip(t, null); }).join('') + '</div>'
      : '';
    var edited = note.updatedAt > note.createdAt
      ? ' &middot; edited ' + formatRelative(note.updatedAt)
      : '';

    var sources = links.backlinks[note.id];
    var backlinksHtml = sources && sources.length
      ? '<div class="note__backlinks"><span class="note__backlinks-label">Linked from</span>' +
        sources.map(function (src) {
          return '<button type="button" class="backlink" data-action="open-note" data-note-id="' +
            escapeHtml(src.id) + '">' + escapeHtml(noteLabel(src)) + '</button>';
        }).join('') + '</div>'
      : '';

    var aiBtn = '<button type="button" class="note__action" data-action="ai-organize"' +
      (state.aiBusy[note.id] ? ' disabled' : '') + '>' +
      (state.aiBusy[note.id] ? 'AI…' : 'AI tags') + '</button>';

    var actionsHtml = deleteOrActions(note,
      '<button type="button" class="note__action" data-action="pin">' + (note.pinned ? 'Unpin' : 'Pin') + '</button>' + aiBtn);

    var pinnedMark = note.pinned ? '<span class="note__pinned">Pinned</span> ' : '';

    var selectCls = state.selectMode
      ? ' note--selectable' + (state.selected[note.id] ? ' note--selected' : '')
      : '';
    var checkHtml = state.selectMode ? '<span class="note__check" aria-hidden="true"></span>' : '';

    return '<li class="note' + (note.pinned ? ' note--pinned' : '') + selectCls + '" data-id="' + escapeHtml(note.id) + '">' +
      checkHtml +
      titleHtml +
      '<p class="note__body">' + renderBody(bodySnippet(note.body, tokens), tokens, links.titleIndex) + '</p>' +
      tagsHtml +
      renderAiSuggestRow(note) +
      renderSimTagRow(note, byId) +
      backlinksHtml +
      renderRelatedRow(note, byId) +
      '<div class="note__meta">' +
      '<span class="note__date">' + pinnedMark + formatRelative(note.createdAt) + edited + '</span>' +
      '<div class="note__actions">' + actionsHtml + '</div>' +
      '</div></li>';
  }

  function renderEmptyState() {
    if (!ideas().length) {
      return '<li class="empty">' +
        '<p class="empty__title">Nothing captured yet.</p>' +
        '<p class="empty__text">First thought goes above.</p>' +
        '<ul class="empty__tips">' +
        '<li>Add tags — <em>training, ideas</em> — to organize</li>' +
        '<li>Write [[Note Title]] to link notes together</li>' +
        '<li>Press <em>/</em> to search, <em>Ctrl/Cmd+Enter</em> to save</li>' +
        '<li>Similar ideas auto-link once you have 5+ notes</li>' +
        '</ul></li>';
    }
    var what = state.query ? '‘' + escapeHtml(state.query) + '’' : '#' + escapeHtml(state.activeTag || '');
    return '<li class="empty">' +
      '<p class="empty__title">No notes match ' + what + '.</p>' +
      '<button type="button" class="toolbar__btn" data-action="clear-filters">Clear filters</button>' +
      '</li>';
  }

  function renderIdeas() {
    var tokens = tokenize(state.query);
    var filtered = filterIdeas();
    var links = buildLinkIndexes();
    var byId = notesById();

    renderTagRail();
    renderTagSuggest();

    els.noteList.innerHTML = filtered.length
      ? filtered.map(function (n) { return renderNoteCard(n, tokens, links, byId); }).join('')
      : renderEmptyState();

    var total = ideas().length;
    var filtering = state.query || state.activeTag;
    els.noteCount.textContent = filtering
      ? filtered.length + ' / ' + total + ' NOTES'
      : total + ' NOTES';

    var streak = computeStreak('idea');
    els.captureStreak.textContent = streak.current > 0 ? '🔥 ' + streak.current + '-day streak' : '';

    var selBtn = document.getElementById('select-toggle');
    selBtn.textContent = state.selectMode ? 'Done' : 'Select';
    selBtn.classList.toggle('toolbar__btn--active', state.selectMode);
    renderSynthBar();
    renderSynthResult();
  }

  /* ---------- Synthesize: selected notes → short-form content ---------- */

  var SYNTH_MAX_NOTES = 4;
  var SYNTH_BODY_CHARS = 1200;
  var SYNTH_LABELS = { reel: 'Reel script', hooks: 'Hook ideas', post: 'Post' };

  function selectedCount() {
    return Object.keys(state.selected).length;
  }

  function exitSelectMode() {
    state.selectMode = false;
    state.selected = {};
    state.synthChoosing = false;
  }

  function toggleSelect(id) {
    var checking = !state.selected[id];
    if (!checking) {
      delete state.selected[id];
    } else if (selectedCount() >= SYNTH_MAX_NOTES) {
      showBanner('Four notes max — deselect one first.');
      return;
    } else {
      state.selected[id] = true;
    }
    state.synthChoosing = false;
    render();
    if (checking) {
      popOnce(document.querySelector('#note-list [data-id="' + id + '"] .note__check'));
    }
  }

  function runSynthesize(format) {
    if (state.synth && state.synth.busy) return;
    var byId = notesById();
    var notes = Object.keys(state.selected)
      .map(function (id) { return byId[id]; })
      .filter(Boolean);
    if (notes.length < 2) return;

    var blocks = notes.map(function (n) {
      var body = n.body.length > SYNTH_BODY_CHARS ? n.body.slice(0, SYNTH_BODY_CHARS) + '…' : n.body;
      return '[' + n.kind + '] ' + (n.title || '(untitled)') + ' (' + formatDate(n.createdAt) + '): ' + body;
    });

    state.synthChoosing = false;
    state.synth = { busy: true, format: format };
    render();
    window.BrainAI.synthesize(blocks.join('\n\n'), format).then(function (text) {
      state.synth = { format: format, text: text };
      render();
    }).catch(function (err) {
      state.synth = null;
      showBanner(err.message || 'AI request failed.', 'error');
      render();
    });
  }

  function copySynth() {
    var text = state.synth && state.synth.text;
    if (!text) return;
    function done() { showBanner('Copied to clipboard.'); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (ok) done();
      else showBanner('Copy failed — select the text manually.', 'error');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function saveSynthAsIdea() {
    var s = state.synth;
    if (!s || !s.text) return;
    var prevEligible = eligibleNoteCount();
    store.notes.push(createNote(SYNTH_LABELS[s.format] + ' — ' + formatDate(Date.now()), s.text, 'content', 'idea'));
    if (!saveStore()) {
      render(); // keep the draft text on screen so it can still be copied out
      return;
    }
    state.synth = null;
    exitSelectMode();
    render();
    showBanner('Saved as idea.');
    recordNoteSaved(prevEligible);
  }

  function renderSynthBar() {
    var bar = els.synthBar;
    var count = selectedCount();
    if (!state.selectMode || count < 2) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    if (state.synth && state.synth.busy) {
      bar.innerHTML = '<span class="synth-bar__count">SYNTHESIZING…</span>';
    } else if (state.synthChoosing) {
      bar.innerHTML =
        '<button type="button" class="synth-bar__btn" data-action="synth-run" data-format="reel">REEL SCRIPT</button>' +
        '<button type="button" class="synth-bar__btn" data-action="synth-run" data-format="hooks">HOOK IDEAS</button>' +
        '<button type="button" class="synth-bar__btn" data-action="synth-run" data-format="post">POST</button>' +
        '<button type="button" class="synth-bar__cancel" data-action="synth-cancel" aria-label="Cancel">&times;</button>';
    } else {
      bar.innerHTML =
        '<span class="synth-bar__count">' + count + ' selected</span>' +
        '<button type="button" class="synth-bar__btn" data-action="synth-open">SYNTHESIZE</button>';
    }
  }

  function renderSynthResult() {
    var s = state.synth;
    if (!s || !s.text) {
      els.synthResult.hidden = true;
      els.synthResult.innerHTML = '';
      return;
    }
    els.synthResult.hidden = false;
    els.synthResult.innerHTML =
      '<div class="synth-result__head"><span class="label">' +
      escapeHtml(SYNTH_LABELS[s.format].toUpperCase()) + '</span>' +
      '<span class="synth-result__actions">' +
      '<button type="button" class="toolbar__btn" data-action="synth-copy">Copy</button>' +
      '<button type="button" class="toolbar__btn" data-action="synth-save">Save as idea</button>' +
      '<button type="button" class="banner__dismiss" data-action="synth-dismiss" aria-label="Dismiss">&times;</button>' +
      '</span></div>' +
      '<p class="synth-result__text">' + escapeHtml(s.text) + '</p>';
  }

  /* ---------- DIARY view ---------- */

  var MOOD_POSITIVE = ['good', 'great', 'happy', 'proud', 'win', 'won', 'strong', 'calm', 'grateful', 'progress', 'pumped', 'focused', 'best', 'love', 'enjoyed'];
  var MOOD_NEGATIVE = ['bad', 'tired', 'sad', 'angry', 'stressed', 'anxious', 'failed', 'weak', 'worried', 'frustrated', 'lost', 'hurt', 'skipped', 'lazy', 'guilty'];
  var MOOD_ENERGY = ['gym', 'trained', 'workout', 'ran', 'lifted', 'pr', 'built', 'shipped', 'posted', 'studied', 'coded', 'created'];

  function detectMood(body) {
    var words = body.toLowerCase().split(/[^a-z']+/);
    var pos = 0, neg = 0, energy = 0;
    words.forEach(function (w) {
      if (MOOD_POSITIVE.indexOf(w) !== -1) pos++;
      if (MOOD_NEGATIVE.indexOf(w) !== -1) neg++;
      if (MOOD_ENERGY.indexOf(w) !== -1) energy++;
    });
    var score = pos - neg;
    return {
      label: score > 0 ? 'good' : score < 0 ? 'rough' : 'neutral',
      active: energy > 0
    };
  }

  function renderDiaryEntry(note, links, byId) {
    if (state.editingId === note.id) return renderEditForm(note);

    var mood = detectMood(note.body);
    var moodHtml = '<span class="mood mood--' + mood.label + '">' + mood.label + '</span>' +
      (mood.active ? '<span class="mood mood--activedot">active</span>' : '');

    var tagsHtml = note.tags.length
      ? '<div class="note__tags">' + note.tags.map(function (t) { return renderTagChip(t, null); }).join('') + '</div>'
      : '';

    var reflect = state.aiReflect[note.id];
    var reflectHtml = reflect
      ? '<div class="reflect"><span class="note__backlinks-label">Reflection</span>' +
        '<p class="reflect__text">' + escapeHtml(reflect.reflection) + '</p>' +
        '<div class="note__backlinks">' + reflect.themes.map(function (t) {
          return '<button type="button" class="tag-chip tag-chip--ai" data-action="apply-tag" data-tag="' +
            escapeHtml(t) + '">+ #' + escapeHtml(t) + '</button>';
        }).join('') + '</div></div>'
      : '';

    var aiBtn = '<button type="button" class="note__action" data-action="ai-reflect"' +
      (state.aiBusy[note.id] ? ' disabled' : '') + '>' +
      (state.aiBusy[note.id] ? 'AI…' : 'AI reflect') + '</button>';

    return '<li class="note note--diary" data-id="' + escapeHtml(note.id) + '">' +
      '<p class="note__body">' + renderBody(note.body, [], links.titleIndex) + '</p>' +
      tagsHtml +
      reflectHtml +
      renderRelatedRow(note, byId) +
      '<div class="note__meta">' +
      '<span class="note__date">' + moodHtml + '</span>' +
      '<div class="note__actions">' + deleteOrActions(note, aiBtn) + '</div>' +
      '</div></li>';
  }

  function renderDiary() {
    var entries = store.notes
      .filter(function (n) { return n.kind === 'diary'; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });

    var links = buildLinkIndexes();
    var byId = notesById();
    var html = '';
    var lastDay = null;
    entries.forEach(function (n) {
      var day = dayKeyOf(n.createdAt);
      if (day !== lastDay) {
        html += '<li class="diary-day">' + formatRelative(n.createdAt).toUpperCase() + '</li>';
        lastDay = day;
      }
      html += renderDiaryEntry(n, links, byId);
    });

    els.diaryList.innerHTML = html ||
      '<li class="empty"><p class="empty__title">No entries yet.</p>' +
      '<p class="empty__text">One honest paragraph a day builds the record.</p></li>';

    var streak = computeStreak('diary');
    els.diaryStreak.textContent = streak.current > 0
      ? '🔥 ' + streak.current + '-day streak · best ' + streak.best
      : '';

    renderDigest();
  }

  /* ---------- Weekly diary digest (Claude, optional key) ---------- */

  var DIGEST_MIN_ENTRIES = 3;
  var DIGEST_MAX_CHARS = 6000; // a heavy week must not blow up the request or the bill

  function weekDiaryEntries() {
    var cutoff = Date.now() - 7 * DAY_MS;
    return store.notes
      .filter(function (n) { return n.kind === 'diary' && n.createdAt >= cutoff; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
  }

  // Entries concatenated with dates, oldest dropped first when over budget
  function buildDigestInput(entries) {
    var blocks = entries.map(function (n) {
      return formatDate(n.createdAt) + ':\n' + n.body;
    });
    var kept = [];
    var total = 0;
    for (var i = blocks.length - 1; i >= 0; i--) {
      total += blocks[i].length + 2;
      if (total > DIGEST_MAX_CHARS && kept.length) break;
      kept.unshift(blocks[i]);
    }
    var joined = kept.join('\n\n');
    // a single oversized entry still gets clipped, keeping its latest words
    return joined.length > DIGEST_MAX_CHARS ? joined.slice(joined.length - DIGEST_MAX_CHARS) : joined;
  }

  function renderDigest() {
    var count = weekDiaryEntries().length;
    els.digestBtn.disabled = state.digestBusy || count < DIGEST_MIN_ENTRIES;
    els.digestBtn.textContent = state.digestBusy ? 'DIGESTING…' : 'DIGEST THIS WEEK';
    els.digestHint.hidden = count >= DIGEST_MIN_ENTRIES;

    if (state.digest) {
      var d = state.digest;
      var rows = '<p class="digest__row"><span class="digest__label">PATTERN</span>' + escapeHtml(d.pattern) + '</p>';
      if (d.tension) rows += '<p class="digest__row"><span class="digest__label">TENSION</span>' + escapeHtml(d.tension) + '</p>';
      rows += '<p class="digest__row"><span class="digest__label">QUESTION</span>' + escapeHtml(d.question) + '</p>';
      els.digestResult.innerHTML = rows;
      els.digestResult.hidden = false;
    } else {
      els.digestResult.innerHTML = '';
      els.digestResult.hidden = true;
    }
  }

  function runDigest() {
    if (state.digestBusy) return;
    if (!window.BrainAI.hasKey()) {
      showBanner('Add your Claude API key in Settings (⚙) to enable AI.');
      openSettings(true);
      return;
    }
    var entries = weekDiaryEntries();
    if (entries.length < DIGEST_MIN_ENTRIES) return;
    state.digestBusy = true;
    state.digest = null;
    render();
    window.BrainAI.digestWeek(buildDigestInput(entries)).then(function (result) {
      state.digestBusy = false;
      state.digest = result; // shown, never stored — same as AI reflect
      render();
    }).catch(function (err) {
      state.digestBusy = false;
      showBanner(err.message || 'AI request failed.', 'error');
      render();
    });
  }

  /* ---------- ASK view: retrieval-augmented Q&A over your own notes ---------- */

  // The question is a few words, so cosine scores run lower than note-to-note —
  // hence a floor well under SIMILARITY_THRESHOLD.
  var ASK_FLOOR = 0.05;
  var ASK_TOP = 10;
  var ASK_NOTE_CHARS = 600;    // per-note cap in the context
  var ASK_CONTEXT_CHARS = 8000; // whole-context cap; lowest-scored notes dropped first

  // Retrieved notes → "[kind] title (date): body" blocks. Walking the desc-sorted
  // list and stopping at the cap drops the lowest-scored notes first.
  function buildAskContext(results, byId) {
    var parts = [];
    var total = 0;
    for (var i = 0; i < results.length; i++) {
      var n = byId[results[i].id];
      if (!n) continue;
      var body = n.body.length > ASK_NOTE_CHARS ? n.body.slice(0, ASK_NOTE_CHARS) + '…' : n.body;
      var block = '[' + n.kind + '] ' + noteLabel(n) + ' (' + formatDate(n.createdAt) + '): ' + body;
      if (total + block.length + 2 > ASK_CONTEXT_CHARS && parts.length) break;
      parts.push(block);
      total += block.length + 2;
    }
    return parts.join('\n\n');
  }

  // [Exact Note Title] in the answer becomes a chip when it matches a retrieved
  // note; anything else stays plain text — never a dead link for a made-up title.
  function askAnswerHtml(answer, sources) {
    var byLabel = {};
    sources.forEach(function (s) { byLabel[s.label] = s.id; });
    return answer.split(/\[([^\[\]]+)\]/g).map(function (part, i) {
      if (i % 2 === 0) return escapeHtml(part);
      var id = byLabel[part.trim()];
      if (id) {
        return '<button type="button" class="backlink ask-cite" data-action="open-note" data-note-id="' +
          escapeHtml(id) + '">' + escapeHtml(part.trim()) + '</button>';
      }
      return escapeHtml('[' + part + ']');
    }).join('');
  }

  function askSourceChips(sources) {
    return sources.map(function (s) {
      return '<button type="button" class="backlink" data-action="open-note" data-note-id="' +
        escapeHtml(s.id) + '">' + escapeHtml(s.label) + '</button>';
    }).join('');
  }

  function renderAsk() {
    var a = state.ask;
    els.askBtn.disabled = !!(a && a.busy);
    els.askBtn.textContent = a && a.busy ? 'ASKING…' : 'ASK';
    if (!a) {
      els.askResult.innerHTML = store.notes.length ? '' :
        '<p class="empty__text">Nothing to ask yet — capture a few ideas first.</p>';
      return;
    }
    var html = '';
    if (a.busy) {
      html = '<p class="empty__text">Reading your notes…</p>';
    } else if (!a.sources.length) {
      html = '<p class="empty__title">Nothing in your notes matches that.</p>' +
        '<p class="empty__text">Try different words — the search reads your actual notes, not the internet.</p>';
    } else if (a.keyless) {
      // keyless degrade: the retrieval half is still a useful semantic search
      html = '<p class="label">CLOSEST NOTES</p>' +
        a.sources.map(function (s) {
          return '<button type="button" class="dash-row" data-action="open-note" data-note-id="' +
            escapeHtml(s.id) + '">' + escapeHtml(s.label) +
            '<span class="dash-row__meta">' + escapeHtml(s.kind) + '</span></button>';
        }).join('') +
        '<p class="empty__text ask-keyless-hint">Add your API key in Settings (⚙) to get an answer.</p>';
    } else if (a.answer != null) {
      html = '<p class="label">ANSWER</p>' +
        '<p class="ask-answer">' + askAnswerHtml(a.answer, a.sources) + '</p>' +
        '<div class="note__backlinks ask-sources"><span class="note__backlinks-label">Sources</span>' +
        askSourceChips(a.sources) + '</div>';
    }
    els.askResult.innerHTML = html;
  }

  function handleAsk(e) {
    e.preventDefault();
    if (state.ask && state.ask.busy) return;
    var q = els.askInput.value.trim();
    if (!q) return;

    var byId = notesById();
    var results = window.BrainAI.search(q, store.notes, store.rev)
      .filter(function (r) { return r.score >= ASK_FLOOR; })
      .slice(0, ASK_TOP);
    var sources = results.map(function (r) {
      var n = byId[r.id];
      return { id: r.id, label: noteLabel(n), kind: n.kind };
    });

    // zero matches → no API call, ever: never pay for a question the brain can't answer
    if (!sources.length) {
      state.ask = { question: q, sources: [] };
      renderAsk();
      return;
    }
    if (!window.BrainAI.hasKey()) {
      state.ask = { question: q, sources: sources, keyless: true };
      renderAsk();
      return;
    }

    state.ask = { busy: true, question: q, sources: sources };
    renderAsk();
    window.BrainAI.askBrain(q, buildAskContext(results, byId)).then(function (answer) {
      state.ask = { question: q, sources: sources, answer: answer };
      renderAsk();
    }).catch(function (err) {
      state.ask = null;
      showBanner(err.message || 'AI request failed.', 'error');
      renderAsk();
    });
  }

  /* ---------- TIMELINE view ---------- */

  var TIMELINE_PAGE = 50;
  var timelineObserver = null;

  // Bucket labels from local-time calendar days — same startOfToday/DAY_MS logic
  // formatRelative uses, and dayKeyOf-style component comparison for months.
  function timelineBucket(ms) {
    var now = new Date();
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= startOfToday) return 'TODAY';
    if (ms >= startOfToday - DAY_MS) return 'YESTERDAY';
    if (ms >= startOfToday - 6 * DAY_MS) return 'THIS WEEK';
    var d = new Date(ms);
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'THIS MONTH';
    var monthsBack = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if (monthsBack <= 12) return MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    return String(d.getFullYear());
  }

  function renderTimelineRow(n) {
    var preview = n.body.slice(0, 90) + (n.body.length > 90 ? '…' : '');
    var tagsHtml = n.tags.length
      ? '<span class="tl-row__tags">' + n.tags.map(function (t) { return '#' + escapeHtml(t); }).join(' ') + '</span>'
      : '';
    return '<li class="tl-item"><button type="button" class="tl-row" data-action="open-note" data-note-id="' +
      escapeHtml(n.id) + '">' +
      '<span class="clip__badge tl-row__badge tl-row__badge--' + escapeHtml(n.kind) + '">' + escapeHtml(n.kind).toUpperCase() + '</span>' +
      '<span class="tl-row__main">' +
      (n.title ? '<span class="tl-row__title">' + escapeHtml(n.title) + '</span>' : '') +
      (preview ? '<span class="tl-row__preview">' + escapeHtml(preview) + '</span>' : '') +
      tagsHtml +
      '</span>' +
      '<span class="tl-row__age">' + formatAge(n.createdAt) + '</span>' +
      '</button></li>';
  }

  function renderTimeline() {
    var filter = state.timelineFilter;
    var kinds = [['all', 'ALL'], ['idea', 'IDEAS'], ['diary', 'DIARY'], ['clip', 'CLIPS']];
    els.timelineFilters.innerHTML = kinds.map(function (k) {
      return '<button type="button" class="tag-chip' + (filter === k[0] ? ' tag-chip--active' : '') +
        '" data-action="tl-filter" data-kind="' + k[0] + '">' + k[1] + '</button>';
    }).join('');

    if (!store.notes.length) {
      els.timelineList.innerHTML = '<li class="empty"><p class="empty__title">Nothing here yet.</p>' +
        '<p class="empty__text">Capture your first thought in Ideas and it shows up here.</p></li>';
      els.timelineSentinel.hidden = true;
      if (timelineObserver) timelineObserver.disconnect();
      return;
    }

    var filtered = store.notes
      .filter(function (n) { return filter === 'all' || n.kind === filter; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
    var visible = filtered.slice(0, state.timelineShown);

    var html = '';
    var lastBucket = null;
    visible.forEach(function (n) {
      var bucket = timelineBucket(n.createdAt);
      if (bucket !== lastBucket) {
        html += '<li class="timeline-bucket">' + escapeHtml(bucket) + '</li>';
        lastBucket = bucket;
      }
      html += renderTimelineRow(n);
    });
    els.timelineList.innerHTML = html ||
      '<li class="empty"><p class="empty__text">No ' + escapeHtml(filter) + ' notes yet.</p></li>';

    // sentinel drives lazy append: only observed while there are unrendered rows
    var more = filtered.length > visible.length;
    els.timelineSentinel.hidden = !more;
    if (timelineObserver) {
      timelineObserver.disconnect();
      if (more) timelineObserver.observe(els.timelineSentinel);
    }
  }

  /* ---------- CLIPS view ---------- */

  function detectPlatform(url) {
    try {
      var host = new URL(url).hostname.toLowerCase();
      if (host.indexOf('instagram') !== -1) return 'instagram';
      if (host.indexOf('tiktok') !== -1) return 'tiktok';
      if (host.indexOf('youtube') !== -1 || host === 'youtu.be') return 'youtube';
    } catch (e) {}
    return 'link';
  }

  function youtubeId(url) {
    try {
      var u = new URL(url);
      var host = u.hostname.toLowerCase();
      if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
      if (host.indexOf('youtube') !== -1) {
        if (u.searchParams.get('v')) return u.searchParams.get('v');
        var m = u.pathname.match(/\/shorts\/([\w-]+)/);
        if (m) return m[1];
      }
    } catch (e) {}
    return null;
  }

  function renderClipCard(note) {
    if (state.editingId === note.id) return renderEditForm(note);

    var href = safeUrl(note.url);
    var platform = href ? detectPlatform(href) : 'link';
    var ytId = href && platform === 'youtube' ? youtubeId(href) : null;

    // thumbnail by default; the player iframe loads only on explicit click
    var thumbHtml = ytId
      ? '<div class="clip__player" data-yt="' + encodeURIComponent(ytId) + '">' +
        // 480x360 is hqdefault's intrinsic size — stating it lets the browser
        // reserve the box from the aspect ratio before the image arrives
        '<img class="clip__thumb" src="https://img.youtube.com/vi/' + encodeURIComponent(ytId) +
        '/hqdefault.jpg" alt="" width="480" height="360" loading="lazy" onerror="this.style.display=\'none\'">' +
        '<button type="button" class="clip__play" data-action="clip-play" aria-label="Play video">&#9654;</button>' +
        '</div>'
      : '';

    var tagsHtml = note.tags.length
      ? '<div class="note__tags">' + note.tags.map(function (t) { return renderTagChip(t, null); }).join('') + '</div>'
      : '';

    return '<li class="note clip" data-id="' + escapeHtml(note.id) + '">' +
      '<span class="clip__badge clip__badge--' + platform + '">' + platform.toUpperCase() + '</span>' +
      thumbHtml +
      (note.body ? '<p class="note__body">' + escapeHtml(note.body) + '</p>' : '') +
      tagsHtml +
      '<div class="note__meta">' +
      '<span class="note__date">' + formatRelative(note.createdAt) + '</span>' +
      '<div class="note__actions">' +
      (href ? '<a class="note__action clip__open" href="' + escapeHtml(href) + '" target="_blank" rel="noopener">Open ↗</a>' : '') +
      deleteOrActions(note) +
      '</div></div></li>';
  }

  function renderClips() {
    var clips = store.notes
      .filter(function (n) { return n.kind === 'clip'; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });

    els.clipList.innerHTML = clips.length
      ? clips.map(renderClipCard).join('')
      : '<li class="empty"><p class="empty__title">No clips saved.</p>' +
        '<p class="empty__text">Paste a video link above — it lives here with your reason for saving it.</p></li>';
  }

  /* ---------- GOALS view ---------- */

  function computeStreak(kind) {
    var days = {};
    store.notes.forEach(function (n) {
      if (n.kind === kind) days[dayKeyOf(n.createdAt)] = true;
    });

    // current streak: walk back day-by-day in local time; alive if today OR yesterday has an entry
    var cursor = new Date();
    cursor.setHours(12, 0, 0, 0);
    var current = 0;
    if (!days[dayKeyOf(cursor.getTime())]) cursor.setDate(cursor.getDate() - 1);
    while (days[dayKeyOf(cursor.getTime())]) {
      current++;
      cursor.setDate(cursor.getDate() - 1);
    }

    // best streak: longest consecutive run over history (noon-anchored, DST-tolerant)
    var stamps = Object.keys(days).map(function (k) {
      var p = k.split('-');
      return new Date(+p[0], +p[1] - 1, +p[2], 12).getTime();
    }).sort(function (a, b) { return a - b; });
    var best = 0, run = 0, prev = null;
    stamps.forEach(function (t) {
      run = (prev !== null && t - prev > DAY_MS * 0.5 && t - prev < DAY_MS * 1.5) ? run + 1 : 1;
      prev = t;
      if (run > best) best = run;
    });

    return { current: current, best: Math.max(best, current) };
  }

  // Pop the streak number only when it actually grew since the last render
  // this session — reopening the app must not fire it (starts as null).
  var lastStreakShown = { idea: null, diary: null };

  function popStreakIfGrew(kind, current, el) {
    var prev = lastStreakShown[kind];
    lastStreakShown[kind] = current;
    if (prev !== null && current > prev) popOnce(el);
  }

  function renderGoals() {
    var ideaStreak = computeStreak('idea');
    var diaryStreak = computeStreak('diary');
    els.streaks.innerHTML =
      '<div class="streak-card"><span class="streak-card__flame">🔥</span>' +
      '<span class="streak-card__value" data-streak="idea">' + ideaStreak.current + '</span>' +
      '<span class="streak-card__label">day idea streak · best ' + ideaStreak.best + '</span></div>' +
      '<div class="streak-card"><span class="streak-card__flame">🔥</span>' +
      '<span class="streak-card__value" data-streak="diary">' + diaryStreak.current + '</span>' +
      '<span class="streak-card__label">day diary streak · best ' + diaryStreak.best + '</span></div>';
    popStreakIfGrew('idea', ideaStreak.current, els.streaks.querySelector('[data-streak="idea"]'));
    popStreakIfGrew('diary', diaryStreak.current, els.streaks.querySelector('[data-streak="diary"]'));

    var active = store.goals.filter(function (g) { return !g.completedAt; });
    var wins = store.goals.filter(function (g) { return g.completedAt; })
      .sort(function (a, b) { return b.completedAt - a.completedAt; });

    els.goalList.innerHTML = active.length
      ? active.map(function (g) {
          var pct = Math.min(100, Math.round((g.progress / g.target) * 100));
          var confirming = state.confirmingGoalId === g.id;
          return '<div class="goal" data-goal="' + escapeHtml(g.id) + '">' +
            '<div class="goal__head"><span class="goal__title">' + escapeHtml(g.title) + '</span>' +
            '<span class="goal__count">' + g.progress + ' / ' + g.target + '</span></div>' +
            '<div class="goal__bar"><div class="goal__fill" style="width:' + pct + '%"></div></div>' +
            '<div class="goal__actions">' +
            (confirming
              ? '<span class="note__date">Delete?</span>' +
                '<button type="button" class="note__action note__action--danger" data-action="goal-del-yes">Yes</button>' +
                '<button type="button" class="note__action" data-action="goal-del-no">No</button>'
              : '<button type="button" class="toolbar__btn goal__plus" data-action="goal-inc">+1</button>' +
                '<button type="button" class="note__action note__action--danger" data-action="goal-del-ask">Delete</button>') +
            '</div></div>';
        }).join('')
      : '<div class="empty"><p class="empty__title">No active goals.</p>' +
        '<p class="empty__text">Set one above — make it a number you can count.</p></div>';

    els.wins.innerHTML = wins.length
      ? '<p class="label">WINS</p>' + wins.map(function (g) {
          return '<div class="win">🏆 <span class="win__title">' + escapeHtml(g.title) + '</span>' +
            '<span class="win__meta">' + g.target + ' done · ' + formatDate(g.completedAt) + '</span></div>';
        }).join('')
      : '';
  }

  /* ---------- TODO ----------
     Deliberately flat: text, a checkbox, an optional due time. No sub-tasks,
     no priorities, no AI. Goals track a number climbing to a target; this
     tracks whether a thing is done, and nothing here is ever destroyed by
     ticking it — done todos move to a collapsed section, same as WINS. */

  function pad2(n) { return String(n).padStart(2, '0'); }

  // <input type="datetime-local"> speaks local wall-clock time with no offset,
  // which is also how `new Date('YYYY-MM-DDTHH:MM')` parses it.
  function toDueInputValue(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fromDueInputValue(v) {
    if (!v) return null;
    var t = new Date(v).getTime();
    return isFinite(t) ? t : null;
  }

  function formatDue(ms) {
    var d = new Date(ms);
    var time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= today && ms < today + DAY_MS) return 'today ' + time;
    if (ms >= today + DAY_MS && ms < today + 2 * DAY_MS) return 'tomorrow ' + time;
    if (ms >= today - DAY_MS && ms < today) return 'yesterday ' + time;
    return formatDate(ms) + ' ' + time;
  }

  // Honest about what browser-local reminders can and cannot do. Only shown
  // once something actually has a due time — there is nothing to explain
  // before that.
  function todoNoticeText() {
    var pending = store.todos.some(function (t) { return !t.done && t.dueAt; });
    if (!pending) return '';
    var perm = notifyPermission();
    if (perm === 'granted') {
      return 'Reminders pop up while this app is open or freshly backgrounded — a nudge, not a guaranteed alarm.';
    }
    if (perm === 'denied') return 'Notifications are blocked in this browser. Due times still show here.';
    if (perm === 'unsupported') return 'This browser can’t show notifications. Due times still show here.';
    return 'Allow notifications when asked and due times can also nudge you. They show here either way.';
  }

  function todoRow(t) {
    var overdue = !t.done && t.dueAt && t.dueAt < Date.now();
    var editing = state.todoDueId === t.id;
    return '<li class="todo' + (t.done ? ' todo--done' : '') + '" data-todo="' + escapeHtml(t.id) + '">' +
      '<button type="button" class="todo__check" data-action="todo-toggle" role="checkbox" aria-checked="' +
      (t.done ? 'true' : 'false') + '" aria-label="' +
      (t.done ? 'Mark as not done' : 'Mark as done') + '"></button>' +
      '<div class="todo__body">' +
      '<span class="todo__text">' + escapeHtml(t.text) + '</span>' +
      (t.dueAt
        ? '<span class="todo__due' + (overdue ? ' todo__due--over' : '') + '">' +
          (overdue ? 'overdue · ' : '⏰ ') + escapeHtml(formatDue(t.dueAt)) + '</span>'
        : '') +
      '</div>' +
      '<div class="todo__actions">' +
      (t.done
        ? ''
        : '<button type="button" class="note__action" data-action="todo-due-ask">' +
          (t.dueAt ? 'Time' : '+ Time') + '</button>') +
      '<button type="button" class="note__action note__action--danger" data-action="todo-del">Delete</button>' +
      '</div>' +
      (editing
        ? '<div class="todo__due-edit">' +
          '<input type="datetime-local" class="todo__due-input" aria-label="Due date and time"' +
          (t.dueAt ? ' value="' + escapeHtml(toDueInputValue(t.dueAt)) + '"' : '') + '>' +
          '<button type="button" class="toolbar__btn" data-action="todo-due-save">Set</button>' +
          (t.dueAt ? '<button type="button" class="note__action" data-action="todo-due-clear">Clear</button>' : '') +
          '<button type="button" class="note__action" data-action="todo-due-cancel">Cancel</button>' +
          '</div>'
        : '') +
      '</li>';
  }

  function renderTodos() {
    var open = store.todos.filter(function (t) { return !t.done; });
    var done = store.todos.filter(function (t) { return t.done; })
      .sort(function (a, b) { return (b.completedAt || 0) - (a.completedAt || 0); });

    // anything with a deadline floats up, soonest first; the rest is newest-first
    open.sort(function (a, b) {
      if (a.dueAt && b.dueAt) return a.dueAt - b.dueAt;
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return b.createdAt - a.createdAt;
    });

    els.todoList.innerHTML = open.length
      ? open.map(todoRow).join('')
      : '<li class="empty"><p class="empty__title">Nothing on the list.</p>' +
        '<p class="empty__text">Type it above and hit ADD — this is for fast capture, not planning.</p></li>';

    els.todoDone.innerHTML = done.length
      ? '<button type="button" class="todo-done__toggle" data-action="todo-done-toggle" aria-expanded="' +
        (state.todosDoneOpen ? 'true' : 'false') + '">' +
        (state.todosDoneOpen ? '▾' : '▸') + ' DONE (' + done.length + ')</button>' +
        (state.todosDoneOpen
          ? '<ol class="todo-list todo-list--done">' + done.map(todoRow).join('') + '</ol>'
          : '')
      : '';

    var notice = todoNoticeText();
    els.todoNotice.textContent = notice;
    els.todoNotice.hidden = !notice;

    var count = open.length;
    els.todoCount.textContent = count === 1 ? '1 OPEN' : count + ' OPEN';
  }

  function celebrate() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var canvas = document.createElement('canvas');
    canvas.id = 'confetti-canvas';
    canvas.className = 'confetti';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var colors = ['#d4ff00', '#d4ff00', '#d4ff00', '#131313', '#f5f3ee'];
    var parts = [];
    for (var i = 0; i < 90; i++) {
      parts.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * 120,
        y: canvas.height * 0.45,
        vx: (Math.random() - 0.5) * 14,
        vy: -Math.random() * 11 - 4,
        s: 4 + Math.random() * 6,
        c: colors[Math.floor(Math.random() * colors.length)],
        r: Math.random() * Math.PI
      });
    }
    var frames = 0;
    (function tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      parts.forEach(function (p) {
        p.vy += 0.3;
        p.x += p.vx;
        p.y += p.vy;
        p.r += 0.1;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
        ctx.restore();
      });
      frames++;
      if (frames < 100) requestAnimationFrame(tick);
      else canvas.remove();
    })();
  }

  /* ---------- Resurface: old similar notes next to what you're writing now ---------- */

  var RESURFACE_MIN_AGE_MS = 30 * DAY_MS;
  var RESURFACE_DISMISSED_MAX = 100;

  function getResurfaceDismissed() {
    try {
      var arr = JSON.parse(localStorage.getItem(RESURFACE_DISMISSED_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function dismissResurfaced(id) {
    var arr = getResurfaceDismissed();
    if (arr.indexOf(id) === -1) arr.push(id);
    if (arr.length > RESURFACE_DISMISSED_MAX) arr = arr.slice(arr.length - RESURFACE_DISMISSED_MAX);
    try { localStorage.setItem(RESURFACE_DISMISSED_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  // Seeds = the 3 most recent notes. A candidate resurfaces when the similarity
  // engine already relates it to a seed, it's over 30 days old, the pair isn't
  // wiki-linked in either direction, and it hasn't been dismissed.
  function computeResurface() {
    var related = getAnalysis().related;
    var byId = notesById();
    var now = Date.now();
    var dismissed = getResurfaceDismissed();
    var backlinks = buildLinkIndexes().backlinks;
    var seeds = store.notes.slice()
      .sort(function (a, b) { return b.createdAt - a.createdAt; })
      .slice(0, 3);

    function wikiLinked(aId, bId) {
      return (backlinks[aId] || []).some(function (n) { return n.id === bId; }) ||
             (backlinks[bId] || []).some(function (n) { return n.id === aId; });
    }

    var best = {};
    seeds.forEach(function (seed) {
      (related[seed.id] || []).forEach(function (r) {
        var cand = byId[r.id];
        if (!cand) return;
        if (now - cand.createdAt <= RESURFACE_MIN_AGE_MS) return;
        if (dismissed.indexOf(cand.id) !== -1) return;
        if (wikiLinked(seed.id, cand.id)) return;
        if (!best[cand.id] || r.score > best[cand.id].score) {
          best[cand.id] = { note: cand, seed: seed, score: r.score };
        }
      });
    });

    return Object.keys(best).map(function (id) { return best[id]; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 3);
  }

  /* ---------- Echoes: what you keep circling back to this week ---------- */

  var ECHO_WINDOW_MS = 7 * DAY_MS;
  var ECHO_MIN_NOTES_IN_WINDOW = 5; // small samples produce garbage echoes
  var ECHO_MIN_HITS = 3;
  var ECHO_TOP = 2;

  // A term echoes when it appears in ≥3 distinct notes from the last 7 days.
  // Tags count as appearances too, but a term every matching note already
  // carries as a tag is old news — you tagged it, you know.
  function computeEchoes() {
    var cutoff = Date.now() - ECHO_WINDOW_MS;
    var windowNotes = store.notes.filter(function (n) { return n.createdAt >= cutoff; });
    if (windowNotes.length < ECHO_MIN_NOTES_IN_WINDOW) return [];

    var docs = windowNotes.map(function (n) {
      var stream = window.BrainAI.tokenize(n.title + ' ' + n.body);
      var terms = {};
      stream.forEach(function (t) { terms[t] = true; });
      n.tags.forEach(function (t) { terms[t] = true; });
      return { note: n, stream: stream, terms: terms };
    });

    var counts = {};
    docs.forEach(function (d) {
      Object.keys(d.terms).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });

    var echoes = [];
    Object.keys(counts).forEach(function (term) {
      if (counts[term] < ECHO_MIN_HITS) return;
      var matched = docs.filter(function (d) { return d.terms[term]; });
      var display = echoPhrase(term, matched);
      // already tagged on every match — as the token, the joined phrase, or any
      // word of the phrase — means you noticed the theme yourself → old news
      var known = [term, display].concat(display.split(' '));
      var allTagged = matched.every(function (d) {
        return known.some(function (k) { return d.note.tags.indexOf(k) !== -1; });
      });
      if (allTagged) return;
      echoes.push({
        term: term,
        display: display,
        notes: matched.map(function (d) { return d.note; }),
        count: matched.length
      });
    });

    echoes.sort(function (a, b) { return b.count - a.count || (a.term < b.term ? -1 : 1); });
    // both halves of a joined phrase qualify on their own — show the phrase once
    var seenDisplay = {};
    echoes = echoes.filter(function (e) {
      if (seenDisplay[e.display]) return false;
      seenDisplay[e.display] = true;
      return true;
    });
    return echoes.slice(0, ECHO_TOP);
  }

  // If the same neighbor token sits next to the term in every matching note,
  // display the phrase ("financial freedom") instead of the bare token.
  function echoPhrase(term, matched) {
    function partnerEverywhere(offset) {
      var survivors = null;
      for (var i = 0; i < matched.length; i++) {
        var stream = matched[i].stream;
        var neighbors = {};
        for (var j = 0; j < stream.length; j++) {
          if (stream[j] === term && stream[j + offset]) neighbors[stream[j + offset]] = true;
        }
        var keys = Object.keys(neighbors);
        if (!keys.length) return null; // tag-only match, or term at the edge
        if (survivors === null) {
          survivors = neighbors;
        } else {
          var next = {};
          keys.forEach(function (k) { if (survivors[k]) next[k] = true; });
          survivors = next;
          if (!Object.keys(survivors).length) return null;
        }
      }
      var left = Object.keys(survivors || {});
      return left.length ? left[0] : null;
    }
    var after = partnerEverywhere(1);
    if (after) return term + ' ' + after;
    var before = partnerEverywhere(-1);
    if (before) return before + ' ' + term;
    return term;
  }

  /* ---------- First-run milestones ---------- */

  // UI state only — never in the store or exports (same rule as resurface.dismissed).
  // '' = fresh, '1' = first note saved (panel gone forever), '2' = connect banner fired.
  var ONBOARD_KEY = 'praze.brain.onboarded';

  function onboardStage() {
    // storage unreadable → act fully onboarded rather than nag every load
    try { return localStorage.getItem(ONBOARD_KEY) || ''; } catch (e) { return '2'; }
  }

  function setOnboardStage(s) {
    try { localStorage.setItem(ONBOARD_KEY, s); } catch (e) {}
  }

  function eligibleNoteCount() {
    return store.notes.filter(function (n) { return n.kind !== 'clip'; }).length;
  }

  // Called after every note save. Sets the first-note flag, and fires the
  // one-time "brain connected" banner when a save crosses the similarity
  // gate (non-clip count 4 → 5) — the app's best moment shouldn't be silent.
  function recordNoteSaved(prevEligible) {
    var stage = onboardStage();
    if (!stage) {
      setOnboardStage('1');
      stage = '1';
    }
    // "crossed the gate" not "landed exactly on 5" — a brain-dump save can add
    // several notes at once and jump straight past the threshold
    var min = window.BrainAI.MIN_NOTES_FOR_LINKS;
    if (stage !== '2' && prevEligible < min && eligibleNoteCount() >= min) {
      setOnboardStage('2');
      showBanner('Your brain just connected.', null, true, {
        label: 'SEE THE GRAPH',
        fn: function () { setView('graph'); }
      });
    }
  }

  /* ---------- DASHBOARD view ---------- */

  function renderDashboard() {
    // first run: nothing captured at all, and nothing ever saved → the panel
    // replaces the cards. Someone who went straight to TODO and filled a list
    // is past first run, even with no notes yet.
    if (!store.notes.length && !store.todos.length && !onboardStage()) {
      els.dash.innerHTML =
        '<div class="dash-card dash-card--hero">' +
        '<p class="dash-greeting">Second Brain</p>' +
        '<p class="dash-tagline">I remember what you don’t.</p>' +
        '<button type="button" class="btn" data-action="dash-capture">CAPTURE YOUR FIRST IDEA</button>' +
        '</div>' +
        '<div class="onboard-unlocks">' +
        '<p class="onboard-unlocks__line">1 note — your brain starts</p>' +
        '<p class="onboard-unlocks__line">5 notes — connections appear</p>' +
        '<p class="onboard-unlocks__line">Write daily — patterns emerge</p>' +
        '</div>';
      return;
    }
    renderDashboardCards();
  }

  function renderDashboardCards() {
    var h = new Date().getHours();
    var greeting = h < 12 ? 'Morning.' : h < 18 ? 'Afternoon.' : 'Evening.';
    var ideaStreak = computeStreak('idea');
    var diaryStreak = computeStreak('diary');
    var activeGoals = store.goals.filter(function (g) { return !g.completedAt; });
    var recent = store.notes.slice()
      .sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 3);
    var latestDiary = store.notes.filter(function (n) { return n.kind === 'diary'; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; })[0];
    var pairs = getAnalysis().pairs.slice()
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 2);
    var byId = notesById();

    var html =
      '<div class="dash-card dash-card--hero">' +
      '<p class="dash-greeting">' + greeting + '</p>' +
      '<p class="dash-tagline">BUILT NOT BORN.</p>' +
      '<button type="button" class="btn" data-action="dash-capture">CAPTURE AN IDEA</button>' +
      '</div>';

    // below the similarity gate, one quiet line where ECHOES/RESURFACED will live
    var eligible = eligibleNoteCount();
    var minLinks = window.BrainAI.MIN_NOTES_FOR_LINKS;
    if (eligible < minLinks) {
      var left = minLinks - eligible;
      html += '<p class="dash-linkline">' + left + ' more note' + (left === 1 ? '' : 's') +
        ' until your ideas start linking.</p>';
    }

    var resurfaced = computeResurface();
    if (resurfaced.length) {
      html += '<div class="dash-card"><p class="label">RESURFACED</p>' +
        resurfaced.map(function (r) {
          return '<div class="resurface-row">' +
            '<button type="button" class="dash-row" data-action="open-note" data-note-id="' +
            escapeHtml(r.note.id) + '">' + escapeHtml(noteLabel(r.note)) +
            '<span class="dash-row__meta">' + formatAge(r.note.createdAt) +
            ' · because you wrote about ' + escapeHtml(noteLabel(r.seed)) + '</span></button>' +
            '<button type="button" class="resurface-dismiss" data-action="resurface-dismiss" data-note-id="' +
            escapeHtml(r.note.id) + '" title="Dismiss" aria-label="Dismiss">✕</button>' +
            '</div>';
        }).join('') + '</div>';
    }

    var echoes = computeEchoes();
    if (echoes.length) {
      html += '<div class="dash-card"><p class="label">ECHOES</p>' +
        echoes.map(function (e) {
          return '<div class="echo">' +
            '<p class="echo__copy">You’ve written about “' + escapeHtml(e.display) +
            '” in ' + e.count + ' notes this week.</p>' +
            e.notes.map(function (n) {
              return '<button type="button" class="dash-row" data-action="open-note" data-note-id="' +
                escapeHtml(n.id) + '">' + escapeHtml(noteLabel(n)) + '</button>';
            }).join('') +
            '<button type="button" class="echo__link" data-action="echo-link" data-term="' +
            escapeHtml(e.term) + '">LINK THESE</button>' +
            '</div>';
        }).join('') + '</div>';
    }

    html += '<div class="dash-card">' +
      '<p class="label">STREAKS</p>' +
      '<button type="button" class="dash-row" data-action="goto" data-go="goals">🔥 ' +
      '<span class="streak-num" data-streak="idea">' + ideaStreak.current + '</span>' +
      '-day idea streak <span class="dash-row__meta">best ' + ideaStreak.best + '</span></button>' +
      '<button type="button" class="dash-row" data-action="goto" data-go="goals">🔥 ' +
      '<span class="streak-num" data-streak="diary">' + diaryStreak.current + '</span>' +
      '-day diary streak <span class="dash-row__meta">best ' + diaryStreak.best + '</span></button>' +
      '</div>';

    html += '<div class="dash-card"><p class="label">ACTIVE GOALS</p>' +
      (activeGoals.length
        ? activeGoals.map(function (g) {
            var pct = Math.min(100, Math.round((g.progress / g.target) * 100));
            return '<button type="button" class="dash-row" data-action="goto" data-go="goals">' +
              escapeHtml(g.title) +
              '<span class="dash-row__meta">' + g.progress + ' / ' + g.target + '</span>' +
              '<span class="dash-bar"><span class="dash-bar__fill" style="width:' + pct + '%"></span></span>' +
              '</button>';
          }).join('')
        : '<button type="button" class="dash-row" data-action="goto" data-go="goals">No active goals — set one<span class="dash-row__meta">→</span></button>') +
      '</div>';

    var openTodos = store.todos.filter(function (t) { return !t.done; });
    if (openTodos.length) {
      openTodos.sort(function (a, b) {
        if (a.dueAt && b.dueAt) return a.dueAt - b.dueAt;
        if (a.dueAt) return -1;
        if (b.dueAt) return 1;
        return b.createdAt - a.createdAt;
      });
      html += '<div class="dash-card"><p class="label">TODO</p>' +
        openTodos.slice(0, 3).map(function (t) {
          return '<button type="button" class="dash-row" data-action="goto" data-go="todos">' +
            escapeHtml(t.text) +
            (t.dueAt ? '<span class="dash-row__meta">' + escapeHtml(formatDue(t.dueAt)) + '</span>' : '') +
            '</button>';
        }).join('') +
        (openTodos.length > 3
          ? '<button type="button" class="dash-row" data-action="goto" data-go="todos">' +
            (openTodos.length - 3) + ' more<span class="dash-row__meta">→</span></button>'
          : '') +
        '</div>';
    }

    html += '<div class="dash-card"><p class="label">RECENT</p>' +
      (recent.length
        ? recent.map(function (n) {
            return '<button type="button" class="dash-row" data-action="open-note" data-note-id="' +
              escapeHtml(n.id) + '">' + escapeHtml(noteLabel(n)) +
              '<span class="dash-row__meta">' + escapeHtml(n.kind) + ' · ' + formatRelative(n.createdAt) + '</span></button>';
          }).join('')
        : '<p class="empty__text">Nothing captured yet — hit the lime button.</p>') +
      '</div>';

    if (latestDiary) {
      var mood = detectMood(latestDiary.body);
      html += '<div class="dash-card"><p class="label">LATEST DIARY</p>' +
        '<button type="button" class="dash-row" data-action="open-note" data-note-id="' + escapeHtml(latestDiary.id) + '">' +
        escapeHtml(latestDiary.body.slice(0, 90)) + (latestDiary.body.length > 90 ? '…' : '') +
        '<span class="dash-row__meta">' + mood.label + ' · ' + formatRelative(latestDiary.createdAt) + '</span></button></div>';
    }

    if (pairs.length) {
      html += '<div class="dash-card"><p class="label">YOUR BRAIN CONNECTED THESE</p>' +
        pairs.map(function (p) {
          var a = byId[p.a], b = byId[p.b];
          if (!a || !b) return '';
          return '<button type="button" class="dash-row" data-action="open-note" data-note-id="' + escapeHtml(a.id) + '">' +
            escapeHtml(noteLabel(a)) + ' ↔ ' + escapeHtml(noteLabel(b)) + '</button>';
        }).join('') + '</div>';
    }

    els.dash.innerHTML = html;
    popStreakIfGrew('idea', ideaStreak.current, els.dash.querySelector('[data-streak="idea"]'));
    popStreakIfGrew('diary', diaryStreak.current, els.dash.querySelector('[data-streak="diary"]'));
  }

  /* ---------- GRAPH view ---------- */

  function renderGraph() {
    var total = store.notes.length;
    els.graphEmpty.hidden = total > 0;
    els.graphCanvas.style.display = total ? 'block' : 'none';
    if (els.graphSettingsToggle) els.graphSettingsToggle.hidden = total === 0;
    if (!total) {
      if (els.graphCold) els.graphCold.hidden = true;
      teardownGraph();
      return;
    }

    // Below the similarity cold-start gate the canvas still draws nodes and any
    // wiki-links, but no dashed similarity edges — say why instead of leaving a
    // sparse graph unexplained. Gate matches BrainAI (non-clip notes ≥ min).
    var eligible = store.notes.filter(function (n) { return n.kind !== 'clip'; }).length;
    var min = window.BrainAI.MIN_NOTES_FOR_LINKS;

    var nodes = store.notes.map(function (n) {
      return { id: n.id, label: noteLabel(n), kind: n.kind, pinned: n.pinned };
    });

    var links = buildLinkIndexes();
    var edges = [];
    var seen = {};
    Object.keys(links.backlinks).forEach(function (targetId) {
      links.backlinks[targetId].forEach(function (src) {
        var key = src.id < targetId ? src.id + '|' + targetId : targetId + '|' + src.id;
        if (!seen[key]) {
          seen[key] = true;
          edges.push({ a: src.id, b: targetId, type: 'wiki' });
        }
      });
    });
    getAnalysis().pairs.forEach(function (p) {
      var key = p.a < p.b ? p.a + '|' + p.b : p.b + '|' + p.a;
      if (!seen[key]) {
        seen[key] = true;
        edges.push({ a: p.a, b: p.b, type: 'sim' });
      }
    });

    // "Show orphans" trims which nodes reach the canvas — it never touches the
    // notes, tags, or the similarity pairs that feed RELATED chips elsewhere.
    // An orphan by definition has no edge, so no edge ever needs dropping here.
    if (!graphSettings.showOrphans) {
      var connected = {};
      edges.forEach(function (e) { connected[e.a] = true; connected[e.b] = true; });
      nodes = nodes.filter(function (n) { return connected[n.id]; });
    }

    if (els.graphCold) {
      if (!graphSettings.showOrphans && !nodes.length) {
        els.graphCold.textContent = 'Every note here is unconnected — turn on "Show orphans" in the ' +
          'graph settings to see them.';
        els.graphCold.hidden = false;
      } else if (eligible < min) {
        els.graphCold.textContent = 'Similar-idea links switch on at ' + min + ' notes — you have ' +
          eligible + '. Wiki-links [[like this]] show as soon as you write them.';
        els.graphCold.hidden = false;
      } else {
        els.graphCold.hidden = true;
      }
    }

    if (!nodes.length) {
      window.BrainGraph.destroy();
      return;
    }

    var byId = notesById();
    window.BrainGraph.mount(els.graphCanvas, { nodes: nodes, edges: edges }, function (id) {
      openNote(id);
    }, function (id) {
      var n = byId[id];
      return n ? { title: noteLabel(n), kind: n.kind, tags: n.tags, date: formatDate(n.createdAt) } : null;
    }, graphSettings);
  }

  function teardownGraph() {
    window.BrainGraph.destroy();
    closeGraphSettings();
  }

  var GRAPH_SETTING_KEYS = ['nodeSize', 'linkThickness', 'repelForce', 'linkForce', 'centerForce', 'linkDistance'];

  function formatMultiplier(v) {
    return (Math.round(v * 100) / 100) + 'x';
  }

  function renderGraphSettingsPanel() {
    GRAPH_SETTING_KEYS.forEach(function (key) {
      var input = els.graphSettingsPanel.querySelector('[data-setting="' + key + '"]');
      var label = els.graphSettingsPanel.querySelector('[data-value-for="' + key + '"]');
      if (input) input.value = graphSettings[key];
      if (label) label.textContent = formatMultiplier(graphSettings[key]);
    });
    var orphans = els.graphSettingsPanel.querySelector('[data-setting="showOrphans"]');
    if (orphans) orphans.checked = !!graphSettings.showOrphans;
  }

  // Same click-outside-to-dismiss pattern as the app-wide settings panel: the
  // listener arms on the next tick so the click that opened the panel doesn't
  // immediately close it again.
  var graphSettingsOutside = null;

  function closeGraphSettings() {
    if (!els.graphSettingsPanel) return;
    els.graphSettingsPanel.hidden = true;
    if (graphSettingsOutside) {
      document.removeEventListener('click', graphSettingsOutside);
      graphSettingsOutside = null;
    }
  }

  function openGraphSettings(open) {
    var show = open === undefined ? els.graphSettingsPanel.hidden : !!open;
    if (!show) {
      closeGraphSettings();
      return;
    }
    els.graphSettingsPanel.hidden = false;
    renderGraphSettingsPanel();
    if (graphSettingsOutside) return;
    graphSettingsOutside = function (e) {
      if (els.graphSettingsPanel.hidden) return;
      if (e.target.closest('#graph-settings-panel') || e.target.closest('#graph-settings-toggle')) return;
      closeGraphSettings();
    };
    setTimeout(function () {
      if (graphSettingsOutside) document.addEventListener('click', graphSettingsOutside);
    }, 0);
  }

  /* ---------- Router + render dispatcher ---------- */

  // The slide animates only when the change came from a physical tab click —
  // that's the movement the eye tracks. Palette/hash jumps reposition instantly.
  var tabClickPending = false;

  // Fade whichever edge of the tab row still has tabs beyond it, so it's
  // visible that the row scrolls. Both edges can be faded at once mid-scroll.
  function updateTabFades() {
    var t = els.tabs;
    if (!t) return;
    var max = t.scrollWidth - t.clientWidth;
    var more = max > 2; // nothing to scroll on a wide screen
    var left = more && t.scrollLeft > 2;
    var right = more && t.scrollLeft < max - 2;
    t.classList.toggle('tabs--fade-both', left && right);
    t.classList.toggle('tabs--fade-left', left && !right);
    t.classList.toggle('tabs--fade-right', right && !left);
  }

  function positionTabIndicator() {
    var ind = els.tabsIndicator;
    if (!ind) return;
    var animate = tabClickPending;
    tabClickPending = false;
    var active = els.tabs.querySelector('.tabs__tab--active');
    if (!active) {
      ind.style.transform = 'scaleX(0)';
      return;
    }
    ind.classList.toggle('tabs__indicator--slide', animate);
    // both the slide and the width ride on one transform (100px base × scale),
    // so the animation stays on the compositor instead of triggering layout
    ind.style.transform = 'translateX(' + active.offsetLeft + 'px) scaleX(' +
      (active.offsetWidth / 100) + ')';
  }

  function currentViewFromHash() {
    var h = location.hash.replace('#', '');
    return VIEWS.indexOf(h) !== -1 ? h : 'dashboard';
  }

  function setView(view) {
    if (dump.open) closeDump(); // tab switch never leaves the mic hot behind an overlay
    if (state.view === 'graph' && view !== 'graph') teardownGraph();
    state.view = view;
    if (location.hash !== '#' + view) {
      // pushes a history entry — browser back walks tabs, the Chrome feel
      location.hash = '#' + view;
    }
    render();
  }

  function render() {
    // leaving the diary tab must not leave the mic hot in the background
    if (state.view !== 'diary') stopDictation();
    // tab bar
    var tabs = els.tabs.querySelectorAll('.tabs__tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('tabs__tab--active', tabs[i].getAttribute('data-view') === state.view);
    }
    positionTabIndicator();
    updateTabFades();
    // view visibility
    VIEWS.forEach(function (v) {
      els.views[v].hidden = v !== state.view;
    });

    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'ask') renderAsk();
    else if (state.view === 'ideas') renderIdeas();
    else if (state.view === 'diary') renderDiary();
    else if (state.view === 'timeline') renderTimeline();
    else if (state.view === 'clips') renderClips();
    else if (state.view === 'goals') renderGoals();
    else if (state.view === 'todos') renderTodos();
    else if (state.view === 'graph') renderGraph();
  }

  // action (optional): { label, fn } renders a button in the banner (e.g. Undo).
  function showBanner(text, type, persistent, action) {
    var banner = els.banner || document.getElementById('banner');
    var bannerText = els.bannerText || document.getElementById('banner-text');
    var bannerAction = els.bannerAction || document.getElementById('banner-action');
    if (!banner || !bannerText) return;
    bannerText.textContent = text;
    banner.className = 'banner' + (type === 'error' ? ' banner--error' : '');
    if (bannerAction) {
      if (action && action.label && typeof action.fn === 'function') {
        bannerAction.textContent = action.label;
        bannerAction.hidden = false;
        showBanner._action = action.fn;
      } else {
        bannerAction.hidden = true;
        showBanner._action = null;
      }
    }
    banner.hidden = false;
    clearTimeout(showBanner._t);
    if (!persistent) {
      showBanner._t = setTimeout(function () { banner.hidden = true; }, 6000);
    }
  }

  // Restore the most recently deleted note or goal at its original position.
  // The buffer lives only in memory (state.lastDeleted) — nothing is read from
  // or written to the persisted store beyond re-inserting the same object.
  function undoDelete() {
    var d = state.lastDeleted;
    if (!d) return;
    state.lastDeleted = null;
    if (d.kind === 'note') {
      store.notes.splice(Math.max(0, Math.min(d.index, store.notes.length)), 0, d.item);
    } else if (d.kind === 'goal') {
      store.goals.splice(Math.max(0, Math.min(d.index, store.goals.length)), 0, d.item);
    } else if (d.kind === 'todo') {
      store.todos.splice(Math.max(0, Math.min(d.index, store.todos.length)), 0, d.item);
      scheduleTodoReminders(); // a restored todo gets its pending reminder back
    }
    var restored = saveStore();
    render();
    var label = d.kind === 'note' ? 'Note' : d.kind === 'goal' ? 'Goal' : 'Todo';
    if (restored) showBanner(label + ' restored.');
  }

  /* ---------- Navigation to a note ---------- */

  function openNote(id) {
    var byId = notesById();
    var note = byId[id];
    if (!note) return;
    var view = note.kind === 'diary' ? 'diary' : note.kind === 'clip' ? 'clips' : 'ideas';
    if (view === 'ideas') {
      state.query = '';
      state.activeTag = null;
      els.search.value = '';
    }
    setView(view);
    var card = document.querySelector('.view [data-id="' + id + '"]');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('note--flash');
      setTimeout(function () { card.classList.remove('note--flash'); }, 1200);
    }
  }

  /* ---------- Actions ---------- */

  function handleCapture(e) {
    e.preventDefault();
    var body = els.captureBody.value.trim();
    if (isBlank(body)) return;
    var prevEligible = eligibleNoteCount();
    store.notes.push(createNote(els.captureTitle.value, body, els.captureTags.value, 'idea'));
    if (!saveStore()) {
      // The note is in memory but not on disk. Leave the form filled and the
      // draft intact so the text is still there after a reload.
      saveDraft();
      render();
      return;
    }
    clearDraft();
    els.captureForm.reset();
    els.captureBody.style.height = '';
    render();
    els.captureBody.focus();
    showBanner('Idea captured.');
    recordNoteSaved(prevEligible); // after the save banner so the connect moment wins the slot
  }

  function handleDiarySubmit(e) {
    e.preventDefault();
    stopDictation(); // if the mic is hot, end it before the normal submit runs
    var body = els.diaryBody.value.trim();
    if (isBlank(body)) return;
    var prevEligible = eligibleNoteCount();
    store.notes.push(createNote(formatDate(Date.now()), body, '', 'diary'));
    if (!saveStore()) {
      // keep both the textarea and the draft: the entry was never written
      saveDiaryDraft();
      render();
      return;
    }
    clearDiaryDraft();
    els.diaryForm.reset();
    els.diaryBody.style.height = '';
    render();
    els.diaryBody.focus();
    showBanner('Entry saved.');
    recordNoteSaved(prevEligible);
  }

  function handleClipSubmit(e) {
    e.preventDefault();
    var url = safeUrl(els.clipUrl.value.trim());
    if (!url) {
      showBanner('That link doesn\'t look right — it needs to start with http(s).', 'error');
      return;
    }
    var prevEligible = eligibleNoteCount();
    store.notes.push(createNote('', els.clipNote.value.trim(), els.clipTags.value, 'clip', url));
    if (!saveStore()) {
      render(); // keep the URL and note in the form
      return;
    }
    els.clipForm.reset();
    render();
    showBanner('Clip saved.');
    recordNoteSaved(prevEligible); // clips don't move the eligible count, but they do count as a first note
  }

  function handleGoalSubmit(e) {
    e.preventDefault();
    var title = els.goalTitle.value.trim();
    var target = parseInt(els.goalTarget.value, 10);
    if (isBlank(title) || !(target >= 1)) return;
    store.goals.push({
      id: makeId(),
      title: title,
      target: target,
      progress: 0,
      createdAt: Date.now(),
      completedAt: null
    });
    if (!saveStore()) {
      render(); // keep the goal title/target in the form
      return;
    }
    els.goalForm.reset();
    render();
    showBanner('Goal set.');
  }

  function handleTodoSubmit(e) {
    e.preventDefault();
    var text = els.todoText.value.trim();
    if (isBlank(text)) return;
    var due = fromDueInputValue(els.todoDue.value);
    var now = Date.now();
    store.todos.push({
      id: makeId(),
      text: text,
      done: false,
      dueAt: due,
      notified: false,
      createdAt: now,
      completedAt: null,
      updatedAt: now
    });
    if (!saveStore()) {
      render(); // leave the text in the box — it was never written
      return;
    }
    els.todoForm.reset();
    closeTodoDueField();
    if (due) maybeRequestNotifications();
    scheduleTodoReminders();
    render();
    els.todoText.focus();
    showBanner('Added to the list.');
  }

  function openTodoDueField() {
    els.todoDue.hidden = false;
    els.todoDueToggle.hidden = true;
    els.todoDue.focus();
  }

  function closeTodoDueField() {
    els.todoDue.value = '';
    els.todoDue.hidden = true;
    els.todoDueToggle.hidden = false;
  }

  function findTodoFromEvent(btn) {
    var row = btn.closest('[data-todo]');
    if (!row) return null;
    var id = row.getAttribute('data-todo');
    var todo = store.todos.filter(function (t) { return t.id === id; })[0];
    return todo ? { row: row, todo: todo } : null;
  }

  // Returns true when the click was a todo action and has been handled.
  function handleTodoClick(action, btn) {
    if (action === 'todo-done-toggle') {
      state.todosDoneOpen = !state.todosDoneOpen;
      renderTodos();
      return true;
    }
    var found = findTodoFromEvent(btn);
    if (!found) return false;
    var todo = found.todo;

    if (action === 'todo-toggle') {
      todo.done = !todo.done;
      todo.completedAt = todo.done ? Date.now() : null;
      todo.updatedAt = Date.now();
      // a reopened todo whose time has passed shouldn't fire a stale popup
      if (!todo.done && todo.dueAt && todo.dueAt < Date.now()) todo.notified = true;
      state.todoDueId = null;
      saveStore();
      scheduleTodoReminders();
      renderTodos();
      return true;
    }

    if (action === 'todo-del') {
      var idx = store.todos.indexOf(todo);
      store.todos = store.todos.filter(function (t) { return t.id !== todo.id; });
      state.lastDeleted = { kind: 'todo', item: todo, index: idx };
      state.todoDueId = null;
      var gone = saveStore();
      scheduleTodoReminders();
      renderTodos();
      if (gone) showBanner('Todo deleted.', null, true, { label: 'Undo', fn: undoDelete });
      return true;
    }

    if (action === 'todo-due-ask') {
      state.todoDueId = state.todoDueId === todo.id ? null : todo.id;
      renderTodos();
      var input = els.todoList.querySelector('[data-todo="' + todo.id + '"] .todo__due-input');
      if (input) input.focus();
      return true;
    }

    if (action === 'todo-due-cancel') {
      state.todoDueId = null;
      renderTodos();
      return true;
    }

    if (action === 'todo-due-save' || action === 'todo-due-clear') {
      var field = found.row.querySelector('.todo__due-input');
      var next = action === 'todo-due-clear' ? null : fromDueInputValue(field ? field.value : '');
      if (action === 'todo-due-save' && next === null) return true; // empty box, nothing to set
      todo.dueAt = next;
      // a fresh time re-arms the reminder even if the old one already fired
      todo.notified = false;
      todo.updatedAt = Date.now();
      state.todoDueId = null;
      saveStore();
      if (next) maybeRequestNotifications();
      scheduleTodoReminders();
      renderTodos();
      return true;
    }

    return false;
  }

  function findNoteFromEvent(btn) {
    var card = btn.closest('[data-id]');
    if (!card) return null;
    var id = card.getAttribute('data-id');
    var note = store.notes.find(function (n) { return n.id === id; });
    return note ? { card: card, note: note } : null;
  }

  function runAi(note, work) {
    if (!window.BrainAI.hasKey()) {
      showBanner('Add your Claude API key in Settings (⚙) to enable AI.');
      openSettings(true);
      return;
    }
    state.aiBusy[note.id] = true;
    render();
    work().then(function () {
      delete state.aiBusy[note.id];
      render();
    }).catch(function (err) {
      delete state.aiBusy[note.id];
      showBanner(err.message || 'AI request failed.', 'error');
      render();
    });
  }

  function handleMainClick(e) {
    // select mode: any tap inside a note card toggles selection and swallows
    // the card's inner actions (pin/edit/chips) — tap-to-select, nothing else
    if (state.selectMode && state.view === 'ideas') {
      var selCard = e.target.closest('#note-list [data-id]');
      if (selCard) {
        e.preventDefault();
        toggleSelect(selCard.getAttribute('data-id'));
        return;
      }
    }

    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');

    if (action === 'select-toggle') {
      if (state.selectMode) exitSelectMode();
      else state.selectMode = true;
      render();
      return;
    }

    if (action === 'synth-open') {
      if (!window.BrainAI.hasKey()) {
        showBanner('Add your Claude API key in Settings (⚙) to enable AI.');
        openSettings(true);
        return;
      }
      state.synthChoosing = true;
      render();
      return;
    }

    if (action === 'synth-cancel') {
      state.synthChoosing = false;
      render();
      return;
    }

    if (action === 'synth-run') {
      runSynthesize(btn.getAttribute('data-format'));
      return;
    }

    if (action === 'synth-copy') {
      copySynth();
      return;
    }

    if (action === 'synth-save') {
      saveSynthAsIdea();
      return;
    }

    if (action === 'synth-dismiss') {
      state.synth = null;
      render();
      return;
    }

    if (action === 'clear-filters') {
      state.query = '';
      state.activeTag = null;
      els.search.value = '';
      render();
      return;
    }

    if (action === 'tag') {
      var tag = btn.getAttribute('data-tag');
      state.activeTag = state.activeTag === tag ? null : tag;
      if (state.view !== 'ideas') setView('ideas');
      else render();
      return;
    }

    if (action === 'open-note') {
      e.preventDefault();
      openNote(btn.getAttribute('data-note-id'));
      return;
    }

    if (action === 'new-note') {
      setView('ideas');
      els.captureTitle.value = btn.getAttribute('data-title');
      saveDraft();
      els.captureForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      els.captureBody.focus();
      return;
    }

    if (action === 'goto') {
      setView(btn.getAttribute('data-go'));
      return;
    }

    if (action === 'tl-filter') {
      state.timelineFilter = btn.getAttribute('data-kind');
      state.timelineShown = TIMELINE_PAGE;
      renderTimeline();
      return;
    }

    if (action === 'resurface-dismiss') {
      var dismissId = btn.getAttribute('data-note-id');
      collapseThen(btn.closest('.resurface-row'), function () {
        dismissResurfaced(dismissId);
        render();
      });
      return;
    }

    if (action === 'digest-week') {
      runDigest();
      return;
    }

    if (action === 'echo-link') {
      var term = btn.getAttribute('data-term');
      var echo = computeEchoes().filter(function (e) { return e.term === term; })[0];
      if (!echo) return;
      collapseThen(btn.closest('.echo'), function () {
        // the tag is the phrase the user was shown, not the internal token
        var linked = 0;
        echo.notes.forEach(function (n) {
          if (n.tags.indexOf(echo.display) === -1) {
            n.tags.push(echo.display);
            n.updatedAt = Date.now();
            linked++;
          }
        });
        if (linked && saveStore()) {
          showBanner('Linked ' + echo.notes.length + ' notes with #' + echo.display);
        }
        render();
      });
      return;
    }

    if (action === 'dash-capture') {
      setView('ideas');
      els.captureBody.focus();
      return;
    }

    if (action === 'clip-play') {
      // swap this card's thumbnail for a 16:9 iframe — render-time only,
      // never persisted; other cards stay as thumbnails
      var player = btn.closest('.clip__player');
      if (player) {
        var embed = document.createElement('div');
        embed.className = 'clip__embed';
        var iframe = document.createElement('iframe');
        iframe.src = 'https://www.youtube.com/embed/' + player.getAttribute('data-yt');
        iframe.setAttribute('allow', 'accelerometer; autoplay; encrypted-media; picture-in-picture');
        iframe.setAttribute('allowfullscreen', '');
        iframe.setAttribute('title', 'YouTube video');
        embed.appendChild(iframe);
        player.replaceWith(embed);
      }
      return;
    }

    if (action === 'suggest-tag') {
      var suggested = btn.getAttribute('data-tag');
      var tags = normalizeTags(els.captureTags.value);
      var idx = tags.indexOf(suggested);
      if (idx === -1) tags.push(suggested); else tags.splice(idx, 1);
      els.captureTags.value = tags.join(', ');
      saveDraft();
      renderTagSuggest();
      return;
    }

    // todo actions
    if (action.indexOf('todo-') === 0 && handleTodoClick(action, btn)) return;

    // goal actions
    var goalEl = btn.closest('[data-goal]');
    if (goalEl) {
      var goalId = goalEl.getAttribute('data-goal');
      var goal = store.goals.find(function (g) { return g.id === goalId; });
      if (!goal) return;
      if (action === 'goal-inc') {
        var oldPct = Math.min(100, Math.round((goal.progress / goal.target) * 100));
        var hitNow = false;
        goal.progress++;
        if (goal.progress >= goal.target && !goal.completedAt) {
          goal.completedAt = Date.now();
          hitNow = true;
        }
        // celebrate only once the milestone is actually on disk
        if (saveStore() && hitNow) {
          celebrate();
          showBanner('GOAL HIT — ' + goal.title + ' 🏆');
        }
        render();
        // render() rebuilds the card, so the fill is born at its new width and
        // the CSS transition never fires — replay old → new on the fresh node
        var fill = document.querySelector('[data-goal="' + goalId + '"] .goal__fill');
        if (fill) {
          var newWidth = fill.style.width;
          fill.style.transition = 'none';
          fill.style.width = oldPct + '%';
          void fill.offsetWidth;
          fill.style.transition = '';
          fill.style.width = newWidth;
        }
      } else if (action === 'goal-del-ask') {
        state.confirmingGoalId = goalId;
        render();
      } else if (action === 'goal-del-yes') {
        var goalIdx = store.goals.indexOf(goal);
        store.goals = store.goals.filter(function (g) { return g.id !== goalId; });
        state.confirmingGoalId = null;
        state.lastDeleted = { kind: 'goal', item: goal, index: goalIdx };
        var goalGone = saveStore();
        render();
        if (goalGone) showBanner('Goal deleted.', null, true, { label: 'Undo', fn: undoDelete });
      } else if (action === 'goal-del-no') {
        state.confirmingGoalId = null;
        render();
      }
      return;
    }

    // note actions
    var found = findNoteFromEvent(btn);
    if (!found) return;
    var note = found.note;
    var card = found.card;

    switch (action) {
      case 'pin':
        note.pinned = !note.pinned;
        saveStore();
        render();
        break;
      case 'apply-tag':
        var newTag = btn.getAttribute('data-tag');
        if (note.tags.indexOf(newTag) === -1) {
          note.tags.push(newTag);
          note.updatedAt = Date.now();
          if (state.aiSuggest[note.id]) {
            state.aiSuggest[note.id] = state.aiSuggest[note.id].filter(function (t) { return t !== newTag; });
          }
          saveStore();
          render();
        }
        break;
      case 'ai-organize':
        runAi(note, function () {
          return window.BrainAI.organizeNote(note, sortedTags(tagCounts())).then(function (tags) {
            state.aiSuggest[note.id] = tags;
            if (!tags.length) showBanner('AI had no new tags to suggest — your tagging is on point.');
          });
        });
        break;
      case 'why-link':
        var otherId = btn.getAttribute('data-other-id');
        var other = notesById()[otherId];
        if (!other || !window.BrainAI.hasKey()) break;
        var pairKey = whyPairKey(note.id, otherId);
        if (state.whyBusy[pairKey]) break;
        state.whyBusy[pairKey] = true;
        render();
        window.BrainAI.explainLink(note, other).then(function (sentence) {
          delete state.whyBusy[pairKey];
          state.whyText[pairKey] = sentence; // shown, never stored — same as reflect
          render();
        }).catch(function (err) {
          delete state.whyBusy[pairKey];
          showBanner(err.message || 'AI request failed.', 'error');
          render();
        });
        break;
      case 'ai-reflect':
        runAi(note, function () {
          return window.BrainAI.reflectEntry(note.body).then(function (result) {
            state.aiReflect[note.id] = result;
          });
        });
        break;
      case 'edit':
        state.editingId = note.id;
        state.confirmingDeleteId = null;
        render();
        var editBody = document.querySelector('.note--editing .note__edit-body');
        if (editBody) {
          autoGrow(editBody);
          editBody.focus();
        }
        break;
      case 'edit-save':
        var newBody = card.querySelector('.note__edit-body').value.trim();
        if (isBlank(newBody)) return;
        note.title = card.querySelector('.note__edit-title').value.trim();
        note.body = newBody;
        note.tags = normalizeTags(card.querySelector('.note__edit-tags').value);
        note.updatedAt = Date.now();
        // only close the editor once the edit is on disk, so a failed write
        // leaves the rewritten text in front of the user instead of burying it
        if (saveStore()) state.editingId = null;
        render();
        break;
      case 'edit-cancel':
        state.editingId = null;
        render();
        break;
      case 'delete-ask':
        state.confirmingDeleteId = note.id;
        render();
        break;
      case 'delete-yes':
        var noteIdx = store.notes.indexOf(note);
        store.notes = store.notes.filter(function (n) { return n.id !== note.id; });
        state.confirmingDeleteId = null;
        state.lastDeleted = { kind: 'note', item: note, index: noteIdx };
        var noteGone = saveStore();
        render();
        if (noteGone) showBanner('Note deleted.', null, true, { label: 'Undo', fn: undoDelete });
        break;
      case 'delete-no':
        state.confirmingDeleteId = null;
        render();
        break;
    }
  }

  /* ---------- Export / Import ---------- */

  function exportNotes() {
    var payload = {
      schemaVersion: store.schemaVersion,
      exportedAt: new Date().toISOString(),
      notes: store.notes,
      goals: store.goals,
      todos: store.todos
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date();
    a.href = url;
    a.download = 'second-brain-' + d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showBanner('Exported ' + store.notes.length + ' notes.');
  }

  function importNotes(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try {
        data = JSON.parse(reader.result);
      } catch (e) {
        showBanner('Import failed — that file is not valid JSON.', 'error');
        return;
      }
      if (!data || !Array.isArray(data.notes)) {
        showBanner('Import failed — no notes found in that file.', 'error');
        return;
      }
      var byId = {};
      store.notes.forEach(function (n) { byId[n.id] = n; });
      var added = 0, updated = 0;
      data.notes.forEach(function (raw) {
        var incoming = sanitizeNote(raw);
        if (!incoming) return;
        var existing = byId[incoming.id];
        if (!existing) {
          byId[incoming.id] = incoming;
          store.notes.push(incoming);
          added++;
        } else if (incoming.updatedAt > existing.updatedAt) {
          existing.title = incoming.title;
          existing.body = incoming.body;
          existing.tags = incoming.tags;
          existing.pinned = incoming.pinned;
          existing.kind = incoming.kind;
          existing.url = incoming.url;
          existing.createdAt = incoming.createdAt;
          existing.updatedAt = incoming.updatedAt;
          updated++;
        }
      });
      if (Array.isArray(data.goals)) {
        var goalsById = {};
        store.goals.forEach(function (g) { goalsById[g.id] = g; });
        data.goals.forEach(function (raw) {
          if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') return;
          var existing = goalsById[raw.id];
          if (!existing) {
            store.goals.push({
              id: raw.id,
              title: raw.title,
              target: typeof raw.target === 'number' ? raw.target : 1,
              progress: typeof raw.progress === 'number' ? raw.progress : 0,
              createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
              completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : null
            });
          } else {
            existing.progress = Math.max(existing.progress, raw.progress || 0);
            existing.completedAt = existing.completedAt || raw.completedAt || null;
          }
        });
      }
      // Todos merge on updatedAt, same rule as notes. A file without them (any
      // export from before this feature) simply leaves the list alone.
      if (Array.isArray(data.todos)) {
        var todosById = {};
        store.todos.forEach(function (t) { todosById[t.id] = t; });
        data.todos.forEach(function (raw) {
          var incoming = sanitizeTodo(raw);
          if (!incoming) return;
          var current = todosById[incoming.id];
          if (!current) {
            todosById[incoming.id] = incoming;
            store.todos.push(incoming);
          } else if (incoming.updatedAt > current.updatedAt) {
            current.text = incoming.text;
            current.done = incoming.done;
            current.dueAt = incoming.dueAt;
            current.notified = incoming.notified;
            current.createdAt = incoming.createdAt;
            current.completedAt = incoming.completedAt;
            current.updatedAt = incoming.updatedAt;
          }
        });
      }
      var imported = saveStore();
      scheduleTodoReminders();
      render();
      if (imported) {
        showBanner('Imported ' + (added + updated) + ' notes (' + updated + ' updated, ' + added + ' new).');
      }
    };
    reader.onerror = function () {
      showBanner('Import failed — could not read that file.', 'error');
    };
    reader.readAsText(file);
  }

  /* ---------- Command palette (Cmd/Ctrl+K) ---------- */

  var palette = { open: false, items: [], sel: 0 };

  function paletteCommands() {
    return [
      { label: 'Ask my brain', hint: 'command', run: function () { setView('ask'); els.askInput.focus(); } },
      { label: 'New idea', hint: 'command', run: function () { setView('ideas'); els.captureBody.focus(); } },
      { label: 'New diary entry', hint: 'command', run: function () { setView('diary'); els.diaryBody.focus(); } },
      { label: 'New todo', hint: 'command', run: function () { setView('todos'); els.todoText.focus(); } },
      { label: 'Go to Ideas', hint: 'go', run: function () { setView('ideas'); } },
      { label: 'Go to Diary', hint: 'go', run: function () { setView('diary'); } },
      { label: 'Go to Timeline', hint: 'go', run: function () { setView('timeline'); } },
      { label: 'Go to Clips', hint: 'go', run: function () { setView('clips'); } },
      { label: 'Go to Goals', hint: 'go', run: function () { setView('goals'); } },
      { label: 'Go to Todo', hint: 'go', run: function () { setView('todos'); } },
      { label: 'Go to Graph', hint: 'go', run: function () { setView('graph'); } },
      { label: 'Export backup', hint: 'command', run: exportNotes },
      { label: 'Import backup', hint: 'command', run: function () { document.getElementById('import-file').click(); } },
      { label: 'Open Settings', hint: 'command', run: function () { openSettings(true); } }
    ];
  }

  // subsequence match: every query char appears in order
  function subsequence(query, text) {
    var qi = 0;
    for (var i = 0; i < text.length && qi < query.length; i++) {
      if (text[i] === query[qi]) qi++;
    }
    return qi === query.length;
  }

  function paletteFilter(query) {
    var q = query.trim().toLowerCase();
    var noteItems = store.notes
      .slice()
      .sort(function (a, b) { return b.createdAt - a.createdAt; })
      .map(function (n) { return { label: noteLabel(n), hint: n.kind, noteId: n.id }; });

    if (!q) return paletteCommands().concat(noteItems.slice(0, 5));

    var ranked = [];
    paletteCommands().concat(noteItems).forEach(function (item) {
      var text = item.label.toLowerCase();
      if (text.indexOf(q) !== -1) ranked.push({ rank: 0, item: item });
      else if (subsequence(q, text)) ranked.push({ rank: 1, item: item });
    });
    ranked.sort(function (a, b) {
      return a.rank - b.rank || a.item.label.length - b.item.label.length;
    });
    return ranked.slice(0, 12).map(function (r) { return r.item; });
  }

  function renderPalette() {
    els.paletteList.innerHTML = palette.items.map(function (item, i) {
      return '<li class="palette__item' + (i === palette.sel ? ' palette__item--active' : '') +
        '" data-idx="' + i + '">' +
        '<span>' + escapeHtml(item.label) + '</span>' +
        '<span class="palette__hint">' + escapeHtml(item.hint) + '</span></li>';
    }).join('') || '<li class="palette__item"><span class="palette__hint">No matches</span></li>';
  }

  function openPalette() {
    palette.open = true;
    palette.sel = 0;
    palette.items = paletteFilter('');
    els.palette.hidden = false;
    els.paletteInput.value = '';
    renderPalette();
    els.paletteInput.focus();
  }

  function closePalette() {
    palette.open = false;
    els.palette.hidden = true;
  }

  function runPaletteItem(item) {
    if (!item) return;
    closePalette();
    if (item.noteId) openNote(item.noteId);
    else item.run();
  }

  /* ---------- Theme ---------- */

  var THEME_KEY = 'praze.brain.theme';

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? 'Switch to light' : 'Switch to dark';
    // the graph paints theme colors at mount — remount if it's on screen
    if (state.view === 'graph') renderGraph();
  }

  /* ---------- Settings ---------- */

  function renderSettings() {
    var has = window.BrainAI.hasKey();
    els.apiKeyInput.value = '';
    els.apiKeyInput.placeholder = has ? window.BrainAI.maskedKey() + ' (saved)' : 'sk-ant-…';
    els.apiKeyClear.hidden = !has;
    els.apiKeyStatus.textContent = has
      ? 'AI is on — smart tags and reflections are one tap away.'
      : 'No key yet. Everything else works without one; similar ideas still auto-link offline.';
    var pref = window.BrainAI.getModelPref();
    var btns = document.querySelectorAll('#model-row [data-model]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('toolbar__btn--active', btns[i].getAttribute('data-model') === pref);
    }
  }

  // Clicking anywhere outside the panel closes it (the gear keeps toggling,
  // Esc still works). The listener is armed on the next tick so the very click
  // that opened the panel — including "add your API key" prompts fired from a
  // button elsewhere in the app — doesn't immediately close it again.
  var settingsOutside = null;

  function closeSettings() {
    els.settingsPanel.hidden = true;
    if (settingsOutside) {
      document.removeEventListener('click', settingsOutside);
      settingsOutside = null;
    }
  }

  function openSettings(open) {
    var show = open === undefined ? els.settingsPanel.hidden : !!open;
    if (!show) {
      closeSettings();
      return;
    }
    els.settingsPanel.hidden = false;
    renderSettings();
    if (settingsOutside) return;
    settingsOutside = function (e) {
      if (els.settingsPanel.hidden) return;
      if (e.target.closest('#settings-panel') || e.target.closest('#settings-toggle')) return;
      closeSettings();
    };
    setTimeout(function () {
      if (settingsOutside) document.addEventListener('click', settingsOutside);
    }, 0);
  }

  /* ---------- Speech recognition (shared wiring) ---------- */

  // One home for the SpeechRecognition setup and the cumulative-results trap:
  // e.results is cumulative for the session, so the transcript is rebuilt from
  // scratch on every event — a re-sent final never double-counts and interim
  // keeps replacing itself. Used by diary dictation and the brain dump.
  function makeRecognizer(opts) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    var recog = new SR();
    recog.lang = 'en-IN';
    recog.continuous = true;
    recog.interimResults = true;

    var finalTranscript = '';
    var lastInterim = '';
    var r = { listening: false };

    // e.results is cumulative, so rebuilding the whole transcript on every
    // event is O(n) per event and O(n²) over a session — by 400 chunks that
    // was 10ms an event. Finalized results form a stable prefix, so fold only
    // the ones past finalCount and keep the rest. Anything already folded is
    // never revisited, which is the same protection against a re-sent final
    // that the full rebuild gave.
    var finalCount = 0;

    recog.onresult = function (e) {
      var interim = '';
      for (var i = finalCount; i < e.results.length; i++) {
        var chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalTranscript += chunk;
          finalCount = i + 1;
        } else {
          interim += chunk;
        }
      }
      lastInterim = interim;
      opts.onText(finalTranscript, interim);
    };

    recog.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        showBanner('Microphone access denied — allow it in your browser to dictate.', 'error');
      }
      // 'no-speech' / 'aborted' are normal — reset silently
      r.listening = false;
      if (opts.onIdle) opts.onIdle();
    };

    recog.onend = function () {
      // fold any trailing interim into the final text so nothing is lost
      finalTranscript += lastInterim;
      lastInterim = '';
      opts.onText(finalTranscript, '');
      r.listening = false;
      if (opts.onIdle) opts.onIdle();
      if (opts.onEnd) opts.onEnd(finalTranscript);
    };

    r.start = function () {
      finalTranscript = '';
      lastInterim = '';
      finalCount = 0;
      try {
        recog.start();
      } catch (err) {
        return false; // guard double-start: start() throws if already running
      }
      r.listening = true;
      return true;
    };

    r.stop = function () {
      if (r.listening) recog.stop();
    };

    return r;
  }

  /* ---------- Diary voice dictation (browser-native, online-only) ---------- */

  var dictation = { supported: false, recognizer: null };

  function setupDictation() {
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      return; // unsupported (e.g. Firefox): no button, diary works as before
    }
    dictation.supported = true;

    var micBtn = document.createElement('button');
    micBtn.type = 'button'; // never submit the form
    micBtn.className = 'toolbar__btn diary-mic';
    micBtn.setAttribute('aria-label', 'Dictate diary entry');
    micBtn.textContent = '🎤 Dictate';
    // place it right after SAVE ENTRY, before the hint
    var actions = els.diaryForm.querySelector('.capture__actions');
    var hint = actions.querySelector('.capture__hint');
    actions.insertBefore(micBtn, hint || null);
    dictation.btn = micBtn;

    var baseText = '';
    var separator = '';

    // Resizing the box and pushing the caret to the end both force the browser
    // to lay out the whole transcript, which gets steadily more expensive as it
    // grows — 8ms an event by the 400th chunk. The text itself goes in
    // immediately; the layout-touching part is coalesced to once a frame, which
    // is as often as it could be seen anyway.
    var growRaf = 0;
    function scheduleGrow() {
      if (growRaf) return;
      growRaf = requestAnimationFrame(function () {
        growRaf = 0;
        autoGrow(els.diaryBody);
        els.diaryBody.selectionStart = els.diaryBody.selectionEnd = els.diaryBody.value.length;
      });
    }

    var recognizer = makeRecognizer({
      onText: function (finalText, interim) {
        els.diaryBody.value = baseText + separator + finalText + interim;
        scheduleGrow();
      },
      onIdle: function () {
        micBtn.textContent = '🎤 Dictate';
        micBtn.classList.remove('diary-mic--live');
      }
    });
    dictation.recognizer = recognizer;

    micBtn.addEventListener('click', function () {
      if (recognizer.listening) {
        recognizer.stop();
        return;
      }
      baseText = els.diaryBody.value;
      separator = (baseText && !/\s$/.test(baseText)) ? ' ' : '';
      if (!recognizer.start()) return;
      micBtn.textContent = '⏹ Stop';
      micBtn.classList.add('diary-mic--live');
      els.diaryBody.focus();
    });
  }

  function stopDictation() {
    if (dictation.recognizer) dictation.recognizer.stop();
  }

  /* ---------- Brain dump: talk long, get split notes ---------- */

  var DUMP_MIN_SPLIT_WORDS = 40; // under this, splitting would waste a call

  // The recognizer is created lazily on first open, NOT at init — the diary
  // recognizer must stay the only one constructed on page load.
  var dump = {
    recog: null, open: false, phase: null, // live | busy | review | short | keyless | fallback
    transcript: '', interim: '', proposals: [], startedAt: 0, timer: null
  };

  function openDump() {
    if (!dump.recog) {
      dump.recog = makeRecognizer({
        onText: function (finalText, interim) {
          dump.transcript = finalText;
          dump.interim = interim;
          if (dump.open && dump.phase === 'live') renderDump();
        },
        onEnd: function (finalText) {
          dump.transcript = finalText;
          dump.interim = '';
          if (dump.open && dump.phase === 'live') afterDumpStop();
        }
      });
      if (!dump.recog) return;
    }
    dump.open = true;
    dump.phase = 'live';
    dump.transcript = '';
    dump.interim = '';
    dump.proposals = [];
    dump.startedAt = Date.now();
    clearInterval(dump.timer);
    dump.timer = setInterval(updateDumpTime, 1000);
    els.dumpOverlay.hidden = false;
    updateDumpTime();
    dump.recog.start();
    renderDump();
  }

  function closeDump() {
    // open goes false BEFORE stop(): stop fires onend synchronously in some
    // implementations, and the onEnd handler must see the overlay as closed
    dump.open = false;
    dump.phase = null;
    clearInterval(dump.timer);
    if (dump.recog) dump.recog.stop();
    els.dumpOverlay.hidden = true;
  }

  function updateDumpTime() {
    var s = Math.max(0, Math.floor((Date.now() - dump.startedAt) / 1000));
    els.dumpTime.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function afterDumpStop() {
    clearInterval(dump.timer);
    var trimmed = dump.transcript.trim();
    var words = trimmed ? trimmed.split(/\s+/).length : 0;
    if (!words) {
      closeDump();
      return;
    }
    if (words < DUMP_MIN_SPLIT_WORDS) {
      dump.phase = 'short';
      renderDump();
      return;
    }
    if (!window.BrainAI.hasKey()) {
      dump.phase = 'keyless';
      renderDump();
      return;
    }
    dump.phase = 'busy';
    renderDump();
    window.BrainAI.splitDump(trimmed).then(function (notes) {
      if (!dump.open) return;
      dump.proposals = notes.map(function (n) {
        return { title: n.title, body: n.body, tags: n.tags, checked: true };
      });
      dump.phase = 'review';
      renderDump();
    }).catch(function (err) {
      if (!dump.open) return;
      showBanner(err.message || 'AI request failed.', 'error');
      dump.phase = 'fallback'; // transcript stays intact — never silently lost
      renderDump();
    });
  }

  function saveDumpAsOne() {
    var text = dump.transcript.trim();
    if (isBlank(text)) return;
    var prevEligible = eligibleNoteCount();
    store.notes.push(createNote('Brain dump — ' + formatDate(Date.now()), text, '', 'idea'));
    if (!saveStore()) return; // keep the overlay open: the transcript is the only copy
    closeDump();
    render();
    showBanner('Saved as one note.');
    recordNoteSaved(prevEligible);
  }

  function saveDumpChecked() {
    var chosen = dump.proposals.filter(function (p) { return p.checked; });
    if (!chosen.length) return;
    var prevEligible = eligibleNoteCount();
    chosen.forEach(function (p) {
      store.notes.push(createNote(p.title, p.body, p.tags.join(', '), 'idea'));
    });
    if (!saveStore()) return; // keep the overlay open: the transcript is the only copy
    closeDump();
    render();
    showBanner('Saved ' + chosen.length + ' note' + (chosen.length === 1 ? '' : 's') + '.');
    recordNoteSaved(prevEligible);
  }

  function dumpTranscriptHtml() {
    return '<div class="dump__transcript">' + escapeHtml(dump.transcript) +
      (dump.interim ? '<span class="dump__interim">' + escapeHtml(dump.interim) + '</span>' : '') +
      '</div>';
  }

  function renderDump() {
    if (!dump.open) return;
    var body = '';
    var actions = '';
    if (dump.phase === 'live') {
      body = dumpTranscriptHtml() +
        '<p class="dump__hint">Talk it all out — separate thoughts get split into separate notes.</p>';
      actions = '<button type="button" class="btn" data-action="dump-stop">STOP</button>';
    } else if (dump.phase === 'busy') {
      body = dumpTranscriptHtml() + '<p class="dump__hint">Splitting into notes…</p>';
    } else if (dump.phase === 'review') {
      body = '<ol class="dump__list">' + dump.proposals.map(function (p, i) {
        return '<li class="dump__item' + (p.checked ? ' dump__item--checked' : '') +
          '" data-action="dump-check" data-idx="' + i + '">' +
          '<span class="note__check" aria-hidden="true"></span>' +
          '<span class="dump__item-main">' +
          '<span class="dump__item-title">' + escapeHtml(p.title) + '</span>' +
          '<span class="dump__item-body">' + escapeHtml(p.body.slice(0, 90)) + (p.body.length > 90 ? '…' : '') + '</span>' +
          (p.tags.length
            ? '<span class="tl-row__tags">' + p.tags.map(function (t) { return '#' + escapeHtml(t); }).join(' ') + '</span>'
            : '') +
          '</span></li>';
      }).join('') + '</ol>';
      var n = dump.proposals.filter(function (p) { return p.checked; }).length;
      actions =
        '<button type="button" class="btn" data-action="dump-save-checked"' + (n ? '' : ' disabled') + '>' +
        'SAVE ' + n + ' NOTE' + (n === 1 ? '' : 'S') + '</button>' +
        '<button type="button" class="toolbar__btn" data-action="dump-save-one">SAVE AS ONE NOTE</button>' +
        '<button type="button" class="toolbar__btn" data-action="dump-discard">DISCARD</button>';
    } else { // short | keyless | fallback
      var hint = dump.phase === 'short' ? 'Too short to split — save it whole.'
        : dump.phase === 'keyless' ? 'Add your API key in Settings to split this into separate notes.'
        : 'Splitting failed — your words are safe below.';
      body = dumpTranscriptHtml() + '<p class="dump__hint">' + escapeHtml(hint) + '</p>';
      actions =
        '<button type="button" class="btn" data-action="dump-save-one">SAVE AS ONE NOTE</button>' +
        '<button type="button" class="toolbar__btn" data-action="dump-discard">DISCARD</button>';
    }
    els.dumpBody.innerHTML = body;
    els.dumpActions.innerHTML = actions;
  }

  function handleDumpClick(e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'dump-stop') {
      if (dump.recog) dump.recog.stop();
    } else if (action === 'dump-close' || action === 'dump-discard') {
      closeDump();
    } else if (action === 'dump-save-one') {
      saveDumpAsOne();
    } else if (action === 'dump-save-checked') {
      saveDumpChecked();
    } else if (action === 'dump-check') {
      var idx = +el.getAttribute('data-idx');
      var p = dump.proposals[idx];
      if (p) {
        p.checked = !p.checked;
        renderDump();
        if (p.checked) {
          popOnce(els.dumpBody.querySelector('[data-idx="' + idx + '"] .note__check'));
        }
      }
    }
  }

  /* ---------- Init ---------- */

  function init() {
    els.banner = document.getElementById('banner');
    els.bannerText = document.getElementById('banner-text');
    els.bannerAction = document.getElementById('banner-action');
    els.tabs = document.getElementById('tabs');
    els.tabsIndicator = document.getElementById('tabs-indicator');
    els.views = {
      dashboard: document.getElementById('view-dashboard'),
      ask: document.getElementById('view-ask'),
      ideas: document.getElementById('view-ideas'),
      diary: document.getElementById('view-diary'),
      timeline: document.getElementById('view-timeline'),
      clips: document.getElementById('view-clips'),
      goals: document.getElementById('view-goals'),
      todos: document.getElementById('view-todos'),
      graph: document.getElementById('view-graph')
    };
    els.captureForm = document.getElementById('capture-form');
    els.captureTitle = document.getElementById('capture-title');
    els.captureBody = document.getElementById('capture-body');
    els.captureTags = document.getElementById('capture-tags');
    els.captureStreak = document.getElementById('capture-streak');
    els.search = document.getElementById('search');
    els.noteCount = document.getElementById('note-count');
    els.tagRail = document.getElementById('tag-rail');
    els.tagSuggest = document.getElementById('tag-suggest');
    els.noteList = document.getElementById('note-list');
    els.synthBar = document.getElementById('synth-bar');
    els.synthResult = document.getElementById('synth-result');
    els.diaryForm = document.getElementById('diary-form');
    els.diaryBody = document.getElementById('diary-body');
    els.diaryList = document.getElementById('diary-list');
    els.diaryStreak = document.getElementById('diary-streak');
    els.digestBtn = document.getElementById('digest-btn');
    els.digestHint = document.getElementById('digest-hint');
    els.digestResult = document.getElementById('digest-result');
    els.askForm = document.getElementById('ask-form');
    els.askInput = document.getElementById('ask-input');
    els.askBtn = document.getElementById('ask-btn');
    els.askResult = document.getElementById('ask-result');
    els.askForm.addEventListener('submit', handleAsk);
    els.askInput.addEventListener('input', function () { autoGrow(els.askInput); });
    els.askInput.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleAsk(e);
      }
    });
    els.timelineFilters = document.getElementById('timeline-filters');
    els.timelineList = document.getElementById('timeline-list');
    els.timelineSentinel = document.getElementById('timeline-sentinel');
    if (window.IntersectionObserver) {
      timelineObserver = new IntersectionObserver(function (entries) {
        if (state.view !== 'timeline') return;
        if (entries.some(function (en) { return en.isIntersecting; })) {
          state.timelineShown += TIMELINE_PAGE;
          renderTimeline();
        }
      }, { rootMargin: '400px' });
    }
    els.clipForm = document.getElementById('clip-form');
    els.clipUrl = document.getElementById('clip-url');
    els.clipNote = document.getElementById('clip-note');
    els.clipTags = document.getElementById('clip-tags');
    els.clipList = document.getElementById('clip-list');
    els.goalForm = document.getElementById('goal-form');
    els.goalTitle = document.getElementById('goal-title');
    els.goalTarget = document.getElementById('goal-target');
    els.goalList = document.getElementById('goal-list');
    els.streaks = document.getElementById('streaks');
    els.wins = document.getElementById('wins');
    els.todoForm = document.getElementById('todo-form');
    els.todoText = document.getElementById('todo-text');
    els.todoDue = document.getElementById('todo-due');
    els.todoDueToggle = document.getElementById('todo-due-toggle');
    els.todoList = document.getElementById('todo-list');
    els.todoDone = document.getElementById('todo-done');
    els.todoNotice = document.getElementById('todo-notice');
    els.todoCount = document.getElementById('todo-count');
    els.graphCanvas = document.getElementById('graph-canvas');
    els.graphCold = document.getElementById('graph-cold');
    els.graphEmpty = document.getElementById('graph-empty');
    els.graphSettingsToggle = document.getElementById('graph-settings-toggle');
    els.graphSettingsPanel = document.getElementById('graph-settings-panel');
    els.dash = document.getElementById('dash');
    els.settingsPanel = document.getElementById('settings-panel');
    els.apiKeyInput = document.getElementById('api-key-input');
    els.apiKeyStatus = document.getElementById('api-key-status');
    els.apiKeyClear = document.getElementById('api-key-clear');

    store = loadStore();
    graphSettings = loadGraphSettings();
    state.view = currentViewFromHash();

    // The service worker is the only way to raise a notification on Android
    // Chrome; grabbing the registration here means fireTodoNotification never
    // has to await anything at the moment a timer fires.
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg) swReg = reg;
      }).catch(function () {});
    }
    scheduleTodoReminders();

    // fires only in the OTHER tabs when one of them writes
    window.addEventListener('storage', handleStorageEvent);

    // Leaving the diary view already stops the mic; backgrounding the app did
    // not, so it stayed hot while the user was in another app and whatever it
    // picked up landed in their entry when they came back. The graph pauses on
    // this same event.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        stopDictation();
        return;
      }
      // Background tabs get their timers throttled or dropped outright, so
      // coming back to the foreground is the only moment a pending reminder's
      // state can be trusted — re-arm from the clock, not from what survived.
      scheduleTodoReminders();
      if (state.view === 'todos') renderTodos();
    });

    // forms
    els.captureForm.addEventListener('submit', handleCapture);
    els.diaryForm.addEventListener('submit', handleDiarySubmit);
    els.clipForm.addEventListener('submit', handleClipSubmit);
    els.goalForm.addEventListener('submit', handleGoalSubmit);
    els.todoForm.addEventListener('submit', handleTodoSubmit);
    els.todoDueToggle.addEventListener('click', openTodoDueField);

    els.captureBody.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleCapture(e);
      }
    });
    els.diaryBody.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleDiarySubmit(e);
      }
    });

    // draft autosave + auto-growing textareas
    var debouncedDraft = debounce(saveDraft, 300);
    [els.captureTitle, els.captureBody, els.captureTags].forEach(function (el) {
      el.addEventListener('input', debouncedDraft);
    });
    els.captureBody.addEventListener('input', function () { autoGrow(els.captureBody); });
    var debouncedDiaryDraft = debounce(saveDiaryDraft, 300);
    els.diaryBody.addEventListener('input', function () {
      autoGrow(els.diaryBody);
      debouncedDiaryDraft();
    });
    els.captureTags.addEventListener('input', renderTagSuggest);

    // search
    els.search.addEventListener('input', debounce(function () {
      state.query = els.search.value;
      render();
    }, 150));
    els.search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        state.query = '';
        els.search.value = '';
        render();
        els.search.blur();
      }
    });

    // '/' focuses search from anywhere outside a field (jumps to IDEAS first)
    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        if (state.view !== 'ideas') setView('ideas');
        els.search.focus();
      }
      if (e.key === 'Escape' && !els.settingsPanel.hidden) {
        closeSettings();
      }
      if (e.key === 'Escape' && !els.graphSettingsPanel.hidden) {
        closeGraphSettings();
      }
      if (e.key === 'Escape' && dump.open) {
        closeDump();
        return;
      }
      if (e.key === 'Escape' && state.selectMode) {
        exitSelectMode();
        render();
      }
    });

    // one delegated click handler for every view
    var main = document.querySelector('main');
    main.addEventListener('click', handleMainClick);

    // inline edit keyboard
    main.addEventListener('keydown', function (e) {
      var card = e.target.closest && e.target.closest('.note--editing');
      if (!card) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        card.querySelector('[data-action="edit-save"]').click();
      } else if (e.key === 'Escape') {
        card.querySelector('[data-action="edit-cancel"]').click();
      }
    });
    main.addEventListener('input', function (e) {
      if (e.target.classList.contains('note__edit-body')) autoGrow(e.target);
    });

    // tabs + routing
    els.tabs.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-view]');
      if (tab) {
        tabClickPending = true;
        setView(tab.getAttribute('data-view'));
      }
    });
    window.addEventListener('resize', debounce(function () {
      positionTabIndicator();
      updateTabFades();
    }, 100));
    // the row itself scrolls (swipe, or the browser bringing a tapped tab into
    // view), so the fades follow it
    els.tabs.addEventListener('scroll', updateTabFades, { passive: true });
    // font-display:swap means the tab labels are measured in the fallback font
    // first; when the real faces land the tabs resize and the indicator would
    // be left behind, so re-measure once fonts settle (instant, no slide).
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        positionTabIndicator();
        updateTabFades(); // label widths change, so what's off-screen does too
      });
    }
    window.addEventListener('hashchange', function () {
      var v = currentViewFromHash();
      if (v !== state.view) {
        if (dump.open) closeDump();
        if (state.view === 'graph') teardownGraph();
        state.view = v;
        render();
      }
    });

    // export / import
    document.getElementById('export-btn').addEventListener('click', exportNotes);
    var importFile = document.getElementById('import-file');
    document.getElementById('import-btn').addEventListener('click', function () {
      importFile.click();
    });
    importFile.addEventListener('change', function () {
      if (importFile.files[0]) importNotes(importFile.files[0]);
      importFile.value = '';
    });

    document.getElementById('banner-dismiss').addEventListener('click', function () {
      els.banner.hidden = true;
    });

    els.bannerAction.addEventListener('click', function () {
      var fn = showBanner._action;
      showBanner._action = null;
      els.banner.hidden = true;
      if (fn) fn();
    });

    // settings
    document.getElementById('settings-toggle').addEventListener('click', function () {
      openSettings();
    });

    // graph settings
    els.graphSettingsToggle.addEventListener('click', function () {
      openGraphSettings();
    });
    els.graphSettingsPanel.addEventListener('input', function (e) {
      var el = e.target;
      if (el.type !== 'range') return;
      var key = el.getAttribute('data-setting');
      if (!key) return;
      var range = GRAPH_SETTINGS_RANGE[key];
      var v = parseFloat(el.value);
      if (range) v = Math.max(range[0], Math.min(range[1], v));
      graphSettings[key] = v;
      saveGraphSettings();
      var label = els.graphSettingsPanel.querySelector('[data-value-for="' + key + '"]');
      if (label) label.textContent = formatMultiplier(v);
      // live-tweak the running sim, no remount — dragging a slider shouldn't
      // reset the camera or scramble node positions
      window.BrainGraph.setSettings(graphSettings);
    });
    els.graphSettingsPanel.addEventListener('change', function (e) {
      var el = e.target;
      if (el.type !== 'checkbox') return;
      var key = el.getAttribute('data-setting');
      if (key !== 'showOrphans') return;
      graphSettings.showOrphans = el.checked;
      saveGraphSettings();
      // orphans are trimmed from the node list mount() receives, so this needs
      // a full re-render rather than a live setSettings() tweak
      renderGraph();
    });
    document.getElementById('api-key-save').addEventListener('click', function () {
      var key = els.apiKeyInput.value.trim();
      if (!key) {
        els.apiKeyStatus.textContent = 'Paste a key first.';
        return;
      }
      window.BrainAI.setKey(key);
      renderSettings();
      els.apiKeyStatus.textContent = 'Key saved — stored only in this browser.';
    });
    document.getElementById('api-key-test').addEventListener('click', function () {
      // a freshly pasted (unsaved) key gets saved first, then tested
      var pending = els.apiKeyInput.value.trim();
      if (pending) {
        window.BrainAI.setKey(pending);
        renderSettings();
      }
      if (!window.BrainAI.hasKey()) {
        els.apiKeyStatus.textContent = 'Paste a key first.';
        return;
      }
      els.apiKeyStatus.textContent = 'Testing…';
      window.BrainAI.testKey().then(function () {
        els.apiKeyStatus.textContent = 'Key works ✓ AI is ready.';
      }).catch(function (err) {
        els.apiKeyStatus.textContent = err.message;
      });
    });
    document.getElementById('api-key-clear').addEventListener('click', function () {
      window.BrainAI.setKey('');
      renderSettings();
      els.apiKeyStatus.textContent = 'Key removed.';
    });
    // command palette
    els.palette = document.getElementById('palette');
    els.paletteInput = document.getElementById('palette-input');
    els.paletteList = document.getElementById('palette-list');

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (palette.open) closePalette(); else openPalette();
      }
    });
    els.paletteInput.addEventListener('input', function () {
      palette.items = paletteFilter(els.paletteInput.value);
      palette.sel = 0;
      renderPalette();
    });
    els.paletteInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        palette.sel = Math.min(palette.sel + 1, palette.items.length - 1);
        renderPalette();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        palette.sel = Math.max(palette.sel - 1, 0);
        renderPalette();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runPaletteItem(palette.items[palette.sel]);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        closePalette();
      }
    });
    els.paletteList.addEventListener('click', function (e) {
      var li = e.target.closest('[data-idx]');
      if (li) runPaletteItem(palette.items[+li.getAttribute('data-idx')]);
    });
    document.getElementById('palette-backdrop').addEventListener('click', closePalette);

    document.getElementById('model-row').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-model]');
      if (!btn) return;
      window.BrainAI.setModelPref(btn.getAttribute('data-model'));
      renderSettings();
    });

    var themeBtn = document.getElementById('theme-toggle');
    themeBtn.textContent = currentTheme() === 'dark' ? 'Switch to light' : 'Switch to dark';
    themeBtn.addEventListener('click', function () {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      popOnce(themeBtn);
    });

    // brain dump overlay (button only appears when SpeechRecognition exists)
    els.dumpOverlay = document.getElementById('dump-overlay');
    els.dumpBody = document.getElementById('dump-body');
    els.dumpActions = document.getElementById('dump-actions');
    els.dumpTime = document.getElementById('dump-time');
    els.dumpOverlay.addEventListener('click', handleDumpClick);
    var dumpBtn = document.getElementById('dump-btn');
    if (window.SpeechRecognition || window.webkitSpeechRecognition) {
      dumpBtn.hidden = false;
      dumpBtn.addEventListener('click', openDump);
    }

    setupDictation();
    render();
    restoreDraft();
  }

  init();
})();
