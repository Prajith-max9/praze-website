/* PRAZE Second Brain — capture, tag, search. All data lives in localStorage. */
(function () {
  'use strict';

  var STORAGE_KEY = 'praze.brain.v1';
  var SCHEMA_VERSION = 1;

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

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- Storage ---------- */

  function loadStore() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      showBanner('Could not access browser storage — notes will not persist.', 'error', true);
      return { schemaVersion: SCHEMA_VERSION, notes: [] };
    }
    if (!raw) return { schemaVersion: SCHEMA_VERSION, notes: [] };
    try {
      var store = JSON.parse(raw);
      if (!store || !Array.isArray(store.notes)) throw new Error('bad shape');
      return migrateStore(store);
    } catch (e) {
      // Preserve the unreadable data instead of overwriting it
      try { localStorage.setItem(STORAGE_KEY + '.corrupt.' + Date.now(), raw); } catch (e2) {}
      showBanner('Stored notes were unreadable; a raw backup was kept in localStorage.', 'error', true);
      return { schemaVersion: SCHEMA_VERSION, notes: [] };
    }
  }

  function migrateStore(store) {
    if (store.schemaVersion === SCHEMA_VERSION) return store;
    // Future versions migrate here, step by step
    store.schemaVersion = SCHEMA_VERSION;
    return store;
  }

  function saveStore() {
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

  function createNote(title, body, tagsInput) {
    var now = Date.now();
    return {
      id: makeId(),
      title: title.trim(),
      body: body.trim(),
      tags: normalizeTags(tagsInput),
      createdAt: now,
      updatedAt: now
    };
  }

  /* ---------- State ---------- */

  var store = { schemaVersion: SCHEMA_VERSION, notes: [] };
  var state = {
    query: '',
    activeTag: null,
    editingId: null,
    confirmingDeleteId: null
  };

  /* ---------- Search ---------- */

  function tokenize(query) {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
  }

  function noteMatches(note, tokens, activeTag) {
    if (activeTag && note.tags.indexOf(activeTag) === -1) return false;
    if (!tokens.length) return true;
    var haystack = (note.title + '\n' + note.body + '\n' + note.tags.join(' ')).toLowerCase();
    return tokens.every(function (tok) { return haystack.indexOf(tok) !== -1; });
  }

  function filterNotes() {
    var tokens = tokenize(state.query);
    return store.notes
      .filter(function (n) { return noteMatches(n, tokens, state.activeTag); })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  /* ---------- Rendering ---------- */

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

  /* Wiki-links: [[Note Title]] in a body links to the note with that title */

  var WIKI_LINK_RE = /\[\[([^\[\]]+)\]\]/g;

  function buildLinkIndexes() {
    var titleIndex = {}; // lowercased title -> note (newest creation wins)
    store.notes
      .slice()
      .sort(function (a, b) { return a.createdAt - b.createdAt; })
      .forEach(function (n) {
        var key = n.title.trim().toLowerCase();
        if (key) titleIndex[key] = n;
      });

    var backlinks = {}; // target note id -> [source notes]
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
    // split with a capturing group alternates plain text (even) / link titles (odd)
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

  function renderTagChip(tag, count, extraClass) {
    var active = state.activeTag === tag;
    return '<button type="button" class="tag-chip' + (active ? ' tag-chip--active' : '') + (extraClass ? ' ' + extraClass : '') + '"' +
      ' data-action="tag" data-tag="' + escapeHtml(tag) + '">#' + escapeHtml(tag) +
      (count != null ? '<span class="tag-chip__count">' + count + '</span>' : '') +
      '</button>';
  }

  function renderTagRail() {
    var counts = {};
    store.notes.forEach(function (n) {
      n.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var tags = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b);
    });
    els.tagRail.innerHTML = tags.map(function (t) { return renderTagChip(t, counts[t]); }).join('');
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

  function renderNoteCard(note, tokens, links) {
    if (state.editingId === note.id) return renderEditForm(note);

    var titleHtml = note.title
      ? '<h2 class="note__title">' + highlight(note.title, tokens) + '</h2>'
      : '';
    var tagsHtml = note.tags.length
      ? '<div class="note__tags">' + note.tags.map(function (t) { return renderTagChip(t, null); }).join('') + '</div>'
      : '';
    var edited = note.updatedAt > note.createdAt
      ? ' &middot; edited ' + formatDate(note.updatedAt)
      : '';

    var sources = links.backlinks[note.id];
    var backlinksHtml = sources && sources.length
      ? '<div class="note__backlinks"><span class="note__backlinks-label">Linked from</span>' +
        sources.map(function (src) {
          var label = src.title || src.body.slice(0, 40) + (src.body.length > 40 ? '…' : '');
          return '<button type="button" class="backlink" data-action="open-note" data-note-id="' +
            escapeHtml(src.id) + '">' + escapeHtml(label) + '</button>';
        }).join('') + '</div>'
      : '';

    var actionsHtml = state.confirmingDeleteId === note.id
      ? '<span class="note__date">Delete?</span>' +
        '<button type="button" class="note__action note__action--danger" data-action="delete-yes">Yes</button>' +
        '<button type="button" class="note__action" data-action="delete-no">No</button>'
      : '<button type="button" class="note__action" data-action="edit">Edit</button>' +
        '<button type="button" class="note__action note__action--danger" data-action="delete-ask">Delete</button>';

    return '<li class="note" data-id="' + escapeHtml(note.id) + '">' +
      titleHtml +
      '<p class="note__body">' + renderBody(bodySnippet(note.body, tokens), tokens, links.titleIndex) + '</p>' +
      tagsHtml +
      backlinksHtml +
      '<div class="note__meta">' +
      '<span class="note__date">' + formatDate(note.createdAt) + edited + '</span>' +
      '<div class="note__actions">' + actionsHtml + '</div>' +
      '</div></li>';
  }

  function renderEmptyState() {
    if (!store.notes.length) {
      return '<li class="empty">' +
        '<p class="empty__title">Nothing captured yet.</p>' +
        '<p class="empty__text">First thought goes above.</p>' +
        '</li>';
    }
    var what = state.query ? '‘' + escapeHtml(state.query) + '’' : '#' + escapeHtml(state.activeTag || '');
    return '<li class="empty">' +
      '<p class="empty__title">No notes match ' + what + '.</p>' +
      '<button type="button" class="toolbar__btn" data-action="clear-filters">Clear filters</button>' +
      '</li>';
  }

  function render() {
    var tokens = tokenize(state.query);
    var filtered = filterNotes();
    var links = buildLinkIndexes();

    renderTagRail();

    els.noteList.innerHTML = filtered.length
      ? filtered.map(function (n) { return renderNoteCard(n, tokens, links); }).join('')
      : renderEmptyState();

    var filtering = state.query || state.activeTag;
    els.noteCount.textContent = filtering
      ? filtered.length + ' / ' + store.notes.length + ' NOTES'
      : store.notes.length + ' NOTES';
  }

  function showBanner(text, type, persistent) {
    // Banner elements may not be cached yet if called during load
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

  /* ---------- Actions ---------- */

  function handleCapture(e) {
    e.preventDefault();
    var body = els.captureBody.value.trim();
    if (!body) return;
    store.notes.push(createNote(els.captureTitle.value, body, els.captureTags.value));
    saveStore();
    els.captureForm.reset();
    render();
    els.captureBody.focus();
  }

  function handleListClick(e) {
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
      render();
      return;
    }

    if (action === 'open-note') {
      e.preventDefault();
      // clear filters so the target note is guaranteed to be in the list
      state.query = '';
      state.activeTag = null;
      els.search.value = '';
      render();
      var targetCard = els.noteList.querySelector('[data-id="' + btn.getAttribute('data-note-id') + '"]');
      if (targetCard) {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetCard.classList.add('note--flash');
        setTimeout(function () { targetCard.classList.remove('note--flash'); }, 1200);
      }
      return;
    }

    if (action === 'new-note') {
      els.captureTitle.value = btn.getAttribute('data-title');
      els.captureForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      els.captureBody.focus();
      return;
    }

    var card = btn.closest('[data-id]');
    if (!card) return;
    var id = card.getAttribute('data-id');
    var note = store.notes.find(function (n) { return n.id === id; });
    if (!note) return;

    switch (action) {
      case 'edit':
        state.editingId = id;
        state.confirmingDeleteId = null;
        render();
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
        state.confirmingDeleteId = id;
        render();
        break;
      case 'delete-yes':
        store.notes = store.notes.filter(function (n) { return n.id !== id; });
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

  function exportNotes() {
    var payload = {
      schemaVersion: store.schemaVersion,
      exportedAt: new Date().toISOString(),
      notes: store.notes
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
          existing.createdAt = incoming.createdAt;
          existing.updatedAt = incoming.updatedAt;
          updated++;
        }
      });
      saveStore();
      render();
      showBanner('Imported ' + (added + updated) + ' notes (' + updated + ' updated, ' + added + ' new).');
    };
    reader.onerror = function () {
      showBanner('Import failed — could not read that file.', 'error');
    };
    reader.readAsText(file);
  }

  /* ---------- Init ---------- */

  function init() {
    els.banner = document.getElementById('banner');
    els.bannerText = document.getElementById('banner-text');
    els.captureForm = document.getElementById('capture-form');
    els.captureTitle = document.getElementById('capture-title');
    els.captureBody = document.getElementById('capture-body');
    els.captureTags = document.getElementById('capture-tags');
    els.search = document.getElementById('search');
    els.noteCount = document.getElementById('note-count');
    els.tagRail = document.getElementById('tag-rail');
    els.noteList = document.getElementById('note-list');

    store = loadStore();

    els.captureForm.addEventListener('submit', handleCapture);
    els.captureBody.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleCapture(e);
      }
    });

    els.search.addEventListener('input', debounce(function () {
      state.query = els.search.value;
      render();
    }, 150));

    els.noteList.addEventListener('click', handleListClick);
    els.tagRail.addEventListener('click', handleListClick);

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

    render();
  }

  init();
})();
