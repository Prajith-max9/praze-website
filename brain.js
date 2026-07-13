/* PRAZE Second Brain — capture, tag, search, link, reflect. All data lives in localStorage. */
(function () {
  'use strict';

  var STORAGE_KEY = 'praze.brain.v1';
  var PRE_MIGRATION_KEY = 'praze.brain.v1.pre-migration';
  var SCHEMA_VERSION = 2;
  var VIEWS = ['ideas', 'diary', 'clips', 'goals', 'graph'];

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

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
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
    if (typeof store.rev !== 'number') store.rev = 0;
    store.schemaVersion = SCHEMA_VERSION;
    // persist immediately so localStorage reflects v2 without waiting for an edit
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) {}
    return store;
  }

  function emptyStore() {
    return { schemaVersion: SCHEMA_VERSION, rev: 0, notes: [], goals: [] };
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
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.notes)) throw new Error('bad shape');
      if (!Array.isArray(parsed.goals)) parsed.goals = [];
      if (typeof parsed.rev !== 'number') parsed.rev = 0;
      return migrateStore(parsed, raw);
    } catch (e) {
      // Preserve the unreadable data instead of overwriting it
      try { localStorage.setItem(STORAGE_KEY + '.corrupt.' + Date.now(), raw); } catch (e2) {}
      showBanner('Stored notes were unreadable; a raw backup was kept in localStorage.', 'error', true);
      return emptyStore();
    }
  }

  function saveStore() {
    store.rev = (store.rev || 0) + 1;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      showBanner('Storage full — export your notes now to avoid losing them.', 'error', true);
    }
  }

  /* ---------- Model ---------- */

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

  function restoreDraft() {
    var draft;
    try {
      draft = JSON.parse(localStorage.getItem(DRAFT_KEY));
    } catch (e) {}
    if (!draft || !(draft.title || draft.body || draft.tags)) return;
    els.captureTitle.value = draft.title || '';
    els.captureBody.value = draft.body || '';
    els.captureTags.value = draft.tags || '';
    autoGrow(els.captureBody);
    renderTagSuggest();
    showBanner('Draft restored — you have an unsaved note.');
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
    aiReflect: {}    // note id -> {themes, reflection} from Claude
  };

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

  function renderRelatedRow(note, byId) {
    var entries = getAnalysis().related[note.id];
    if (!entries || !entries.length) return '';
    var chips = entries.map(function (r) {
      var other = byId[r.id];
      if (!other) return '';
      return '<button type="button" class="backlink" data-action="open-note" data-note-id="' +
        escapeHtml(other.id) + '">' + escapeHtml(noteLabel(other)) + '</button>';
    }).join('');
    if (!chips) return '';
    return '<div class="note__backlinks note__related"><span class="note__backlinks-label">Related</span>' + chips + '</div>';
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

    return '<li class="note' + (note.pinned ? ' note--pinned' : '') + '" data-id="' + escapeHtml(note.id) + '">' +
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

    var thumbHtml = ytId
      ? '<img class="clip__thumb" src="https://img.youtube.com/vi/' + encodeURIComponent(ytId) +
        '/hqdefault.jpg" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
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

  function renderGoals() {
    var ideaStreak = computeStreak('idea');
    var diaryStreak = computeStreak('diary');
    els.streaks.innerHTML =
      '<div class="streak-card"><span class="streak-card__flame">🔥</span>' +
      '<span class="streak-card__value">' + ideaStreak.current + '</span>' +
      '<span class="streak-card__label">day idea streak · best ' + ideaStreak.best + '</span></div>' +
      '<div class="streak-card"><span class="streak-card__flame">🔥</span>' +
      '<span class="streak-card__value">' + diaryStreak.current + '</span>' +
      '<span class="streak-card__label">day diary streak · best ' + diaryStreak.best + '</span></div>';

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

  /* ---------- GRAPH view ---------- */

  function renderGraph() {
    var hasNotes = store.notes.length > 0;
    els.graphEmpty.hidden = hasNotes;
    els.graphCanvas.style.display = hasNotes ? 'block' : 'none';
    if (!hasNotes) {
      window.BrainGraph.destroy();
      return;
    }

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

    window.BrainGraph.mount(els.graphCanvas, { nodes: nodes, edges: edges }, function (id) {
      openNote(id);
    });
  }

  /* ---------- Router + render dispatcher ---------- */

  function currentViewFromHash() {
    var h = location.hash.replace('#', '');
    return VIEWS.indexOf(h) !== -1 ? h : 'ideas';
  }

  function setView(view) {
    if (state.view === 'graph' && view !== 'graph') window.BrainGraph.destroy();
    state.view = view;
    if (location.hash !== '#' + view) {
      // pushes a history entry — browser back walks tabs, the Chrome feel
      location.hash = '#' + view;
    }
    render();
  }

  function render() {
    // tab bar
    var tabs = els.tabs.querySelectorAll('.tabs__tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('tabs__tab--active', tabs[i].getAttribute('data-view') === state.view);
    }
    // view visibility
    VIEWS.forEach(function (v) {
      els.views[v].hidden = v !== state.view;
    });

    if (state.view === 'ideas') renderIdeas();
    else if (state.view === 'diary') renderDiary();
    else if (state.view === 'clips') renderClips();
    else if (state.view === 'goals') renderGoals();
    else if (state.view === 'graph') renderGraph();
  }

  function showBanner(text, type, persistent) {
    var banner = els.banner || document.getElementById('banner');
    var bannerText = els.bannerText || document.getElementById('banner-text');
    if (!banner || !bannerText) return;
    bannerText.textContent = text;
    banner.className = 'banner' + (type === 'error' ? ' banner--error' : '');
    banner.hidden = false;
    if (!persistent) {
      clearTimeout(showBanner._t);
      showBanner._t = setTimeout(function () { banner.hidden = true; }, 6000);
    }
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
    if (!body) return;
    store.notes.push(createNote(els.captureTitle.value, body, els.captureTags.value, 'idea'));
    saveStore();
    clearDraft();
    els.captureForm.reset();
    els.captureBody.style.height = '';
    render();
    els.captureBody.focus();
  }

  function handleDiarySubmit(e) {
    e.preventDefault();
    var body = els.diaryBody.value.trim();
    if (!body) return;
    store.notes.push(createNote(formatDate(Date.now()), body, '', 'diary'));
    saveStore();
    els.diaryForm.reset();
    els.diaryBody.style.height = '';
    render();
    els.diaryBody.focus();
  }

  function handleClipSubmit(e) {
    e.preventDefault();
    var url = safeUrl(els.clipUrl.value.trim());
    if (!url) {
      showBanner('That link doesn\'t look right — it needs to start with http(s).', 'error');
      return;
    }
    store.notes.push(createNote('', els.clipNote.value.trim(), els.clipTags.value, 'clip', url));
    saveStore();
    els.clipForm.reset();
    render();
  }

  function handleGoalSubmit(e) {
    e.preventDefault();
    var title = els.goalTitle.value.trim();
    var target = parseInt(els.goalTarget.value, 10);
    if (!title || !(target >= 1)) return;
    store.goals.push({
      id: makeId(),
      title: title,
      target: target,
      progress: 0,
      createdAt: Date.now(),
      completedAt: null
    });
    saveStore();
    els.goalForm.reset();
    render();
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
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');

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

    // goal actions
    var goalEl = btn.closest('[data-goal]');
    if (goalEl) {
      var goalId = goalEl.getAttribute('data-goal');
      var goal = store.goals.find(function (g) { return g.id === goalId; });
      if (!goal) return;
      if (action === 'goal-inc') {
        goal.progress++;
        if (goal.progress >= goal.target && !goal.completedAt) {
          goal.completedAt = Date.now();
          celebrate();
          showBanner('GOAL HIT — ' + goal.title + ' 🏆');
        }
        saveStore();
        render();
      } else if (action === 'goal-del-ask') {
        state.confirmingGoalId = goalId;
        render();
      } else if (action === 'goal-del-yes') {
        store.goals = store.goals.filter(function (g) { return g.id !== goalId; });
        state.confirmingGoalId = null;
        saveStore();
        render();
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
        if (!newBody) return;
        note.title = card.querySelector('.note__edit-title').value.trim();
        note.body = newBody;
        note.tags = normalizeTags(card.querySelector('.note__edit-tags').value);
        note.updatedAt = Date.now();
        state.editingId = null;
        saveStore();
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
        store.notes = store.notes.filter(function (n) { return n.id !== note.id; });
        state.confirmingDeleteId = null;
        saveStore();
        render();
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
      goals: store.goals
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date();
    a.href = url;
    a.download = 'praze-brain-' + d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
        if (!raw || typeof raw.id !== 'string' || typeof raw.body !== 'string') return;
        var incoming = {
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
      saveStore();
      render();
      showBanner('Imported ' + (added + updated) + ' notes (' + updated + ' updated, ' + added + ' new).');
    };
    reader.onerror = function () {
      showBanner('Import failed — could not read that file.', 'error');
    };
    reader.readAsText(file);
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
  }

  function openSettings(open) {
    els.settingsPanel.hidden = open === undefined ? !els.settingsPanel.hidden : !open;
    if (!els.settingsPanel.hidden) renderSettings();
  }

  /* ---------- Init ---------- */

  function init() {
    els.banner = document.getElementById('banner');
    els.bannerText = document.getElementById('banner-text');
    els.tabs = document.getElementById('tabs');
    els.views = {
      ideas: document.getElementById('view-ideas'),
      diary: document.getElementById('view-diary'),
      clips: document.getElementById('view-clips'),
      goals: document.getElementById('view-goals'),
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
    els.diaryForm = document.getElementById('diary-form');
    els.diaryBody = document.getElementById('diary-body');
    els.diaryList = document.getElementById('diary-list');
    els.diaryStreak = document.getElementById('diary-streak');
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
    els.graphCanvas = document.getElementById('graph-canvas');
    els.graphEmpty = document.getElementById('graph-empty');
    els.settingsPanel = document.getElementById('settings-panel');
    els.apiKeyInput = document.getElementById('api-key-input');
    els.apiKeyStatus = document.getElementById('api-key-status');
    els.apiKeyClear = document.getElementById('api-key-clear');

    store = loadStore();
    state.view = currentViewFromHash();

    // forms
    els.captureForm.addEventListener('submit', handleCapture);
    els.diaryForm.addEventListener('submit', handleDiarySubmit);
    els.clipForm.addEventListener('submit', handleClipSubmit);
    els.goalForm.addEventListener('submit', handleGoalSubmit);

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
    els.diaryBody.addEventListener('input', function () { autoGrow(els.diaryBody); });
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
        els.settingsPanel.hidden = true;
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
      if (tab) setView(tab.getAttribute('data-view'));
    });
    window.addEventListener('hashchange', function () {
      var v = currentViewFromHash();
      if (v !== state.view) {
        if (state.view === 'graph') window.BrainGraph.destroy();
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

    // settings
    document.getElementById('settings-toggle').addEventListener('click', function () {
      openSettings();
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

    render();
    restoreDraft();
  }

  init();
})();
