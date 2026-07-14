/* PRAZE Second Brain — intelligence layer.
   Built-in: TF-IDF similarity engine (offline, free) for auto-linking and tag suggestions.
   Optional: Claude API client using the user's own key (stored locally, never exported). */
window.BrainAI = (function () {
  'use strict';

  /* ---------- Similarity engine ---------- */

  var SIMILARITY_THRESHOLD = 0.15;
  var MIN_NOTES_FOR_LINKS = 5; // cold-start gate: below this, IDF is noise
  var TOP_RELATED = 3;

  var STOPWORDS = {};
  ('a an the and or but if then so of to in on at by for with from as is are was were be been being ' +
   'it its this that these those i im me my you your we our they them he she his her do does did ' +
   'have has had will would can could just not').split(' ').forEach(function (w) { STOPWORDS[w] = true; });

  function tokenizeText(text) {
    return String(text).toLowerCase().split(/[^a-z0-9]+/).filter(function (t) {
      return t.length > 2 && !STOPWORDS[t];
    });
  }

  var cache = { rev: -1, result: null };

  function computeAll(notes) {
    var eligible = notes.filter(function (n) { return n.kind !== 'clip'; }).length;
    if (eligible < MIN_NOTES_FOR_LINKS) {
      return { related: {}, pairs: [] };
    }

    // term frequencies per note; title tokens count double (titles are dense signal)
    var docs = notes.map(function (n) {
      var tf = {};
      tokenizeText(n.body).forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
      tokenizeText(n.title).forEach(function (t) { tf[t] = (tf[t] || 0) + 2; });
      return { id: n.id, tf: tf };
    });

    var df = {};
    docs.forEach(function (d) {
      Object.keys(d.tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    });

    var N = docs.length;
    docs.forEach(function (d) {
      var vec = {};
      var norm = 0;
      Object.keys(d.tf).forEach(function (t) {
        // smoothed IDF: keeps shared-term weight meaningful on small corpora
        var w = d.tf[t] * Math.log(1 + N / df[t]);
        if (w > 0) {
          vec[t] = w;
          norm += w * w;
        }
      });
      d.vec = vec;
      d.norm = Math.sqrt(norm);
    });

    function cosine(a, b) {
      if (!a.norm || !b.norm) return 0;
      var dot = 0;
      var small = Object.keys(a.vec).length <= Object.keys(b.vec).length ? a : b;
      var other = small === a ? b : a;
      Object.keys(small.vec).forEach(function (t) {
        if (other.vec[t]) dot += small.vec[t] * other.vec[t];
      });
      return dot / (a.norm * b.norm);
    }

    var related = {};
    var pairs = [];
    for (var i = 0; i < docs.length; i++) {
      for (var j = i + 1; j < docs.length; j++) {
        var score = cosine(docs[i], docs[j]);
        if (score >= SIMILARITY_THRESHOLD) {
          (related[docs[i].id] = related[docs[i].id] || []).push({ id: docs[j].id, score: score });
          (related[docs[j].id] = related[docs[j].id] || []).push({ id: docs[i].id, score: score });
          pairs.push({ a: docs[i].id, b: docs[j].id, score: score });
        }
      }
    }
    Object.keys(related).forEach(function (id) {
      related[id].sort(function (x, y) { return y.score - x.score; });
      related[id] = related[id].slice(0, TOP_RELATED);
    });

    return { related: related, pairs: pairs };
  }

  function analyze(notes, rev) {
    if (cache.rev !== rev || !cache.result) {
      cache.result = computeAll(notes);
      cache.rev = rev;
    }
    return cache.result;
  }

  // Suggest tags the note lacks but ≥2 of its related notes carry
  function suggestTags(note, relatedEntries, notesById) {
    var counts = {};
    (relatedEntries || []).forEach(function (r) {
      var other = notesById[r.id];
      if (!other) return;
      other.tags.forEach(function (t) {
        if (note.tags.indexOf(t) === -1) counts[t] = (counts[t] || 0) + 1;
      });
    });
    return Object.keys(counts).filter(function (t) { return counts[t] >= 2; }).slice(0, 3);
  }

  /* ---------- Claude API client (optional, user-supplied key) ---------- */

  var API_KEY_STORAGE = 'praze.brain.apikey';
  var MODEL_PREF_KEY = 'praze.brain.aimodel';
  var API_URL = 'https://api.anthropic.com/v1/messages';
  var TIMEOUT_MS = 20000;

  // one place to touch when model ids change (current ids as of build time)
  var MODELS = {
    fast: 'claude-haiku-4-5',
    balanced: 'claude-sonnet-5',
    best: 'claude-opus-4-8'
  };

  function getModelPref() {
    try {
      var p = localStorage.getItem(MODEL_PREF_KEY);
      return MODELS[p] ? p : 'balanced';
    } catch (e) { return 'balanced'; }
  }

  function setModelPref(pref) {
    try { if (MODELS[pref]) localStorage.setItem(MODEL_PREF_KEY, pref); } catch (e) {}
  }

  function getKey() {
    try { return localStorage.getItem(API_KEY_STORAGE) || ''; } catch (e) { return ''; }
  }

  function setKey(key) {
    try {
      if (key) localStorage.setItem(API_KEY_STORAGE, key);
      else localStorage.removeItem(API_KEY_STORAGE);
    } catch (e) {}
  }

  function hasKey() {
    return !!getKey();
  }

  function maskedKey() {
    var k = getKey();
    if (!k) return '';
    return k.slice(0, 7) + '…' + k.slice(-4);
  }

  async function callClaude(prompt, maxTokens) {
    var key = getKey();
    if (!key) throw new Error('Add your Claude API key in Settings to enable AI.');

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

    var response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: MODELS[getModelPref()],
          max_tokens: maxTokens || 300,
          messages: [{ role: 'user', content: prompt }]
        })
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('AI request timed out — try again.');
      throw new Error('Network error reaching the AI — check your connection.');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) throw new Error('API key rejected — check it in Settings.');
    if (response.status === 429) throw new Error('AI rate limit hit — wait a minute and try again.');
    if (!response.ok) throw new Error('AI request failed (' + response.status + ') — try again.');

    var data = await response.json();
    var textBlock = (data.content || []).filter(function (b) { return b.type === 'text'; })[0];
    if (!textBlock) throw new Error('AI returned an empty response — try again.');
    return textBlock.text;
  }

  function parseJson(text) {
    // strip accidental markdown fences
    var cleaned = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned);
  }

  // Suggest 1-3 tags for a note, preferring the existing vocabulary
  async function organizeNote(note, tagVocabulary) {
    var prompt =
      'You are tagging a note in a personal knowledge base.\n\n' +
      'Note title: ' + (note.title || '(none)') + '\n' +
      'Note body: ' + note.body + '\n\n' +
      'Existing tags in this knowledge base: ' + (tagVocabulary.join(', ') || '(none yet)') + '\n\n' +
      'Suggest 1-3 tags for this note. Prefer existing tags when they genuinely fit; ' +
      'invent a new lowercase single-word tag only when nothing existing fits. ' +
      'Respond with ONLY a JSON array of strings, no markdown fences, no explanation. ' +
      'Example: ["fitness","content"]';

    var text = await callClaude(prompt, 300);
    var parsed;
    try {
      parsed = parseJson(text);
    } catch (e) {
      throw new Error('AI response was malformed — try again.');
    }
    if (!Array.isArray(parsed)) throw new Error('AI response was malformed — try again.');
    var seen = {};
    return parsed
      .filter(function (t) { return typeof t === 'string' && t.trim(); })
      .map(function (t) { return t.trim().toLowerCase(); })
      .filter(function (t) {
        if (seen[t] || note.tags.indexOf(t) !== -1) return false;
        seen[t] = true;
        return true;
      })
      .slice(0, 3);
  }

  // Reflect on a diary entry: themes + one grounded observation
  async function reflectEntry(body) {
    var prompt =
      'You are a reflection assistant inside a private diary app. The user is a driven young ' +
      'person building a fitness brand; be honest and grounded, never sycophantic, never clinical.\n\n' +
      'Diary entry: ' + body + '\n\n' +
      'Respond with ONLY a JSON object, no markdown fences: ' +
      '{"themes": ["theme1","theme2"], "reflection": "one or two sentences"}\n' +
      'Rules: 2-3 lowercase single-word themes. The reflection observes a pattern or asks one ' +
      'sharp question. It never diagnoses, never mentions being an AI, never exceeds 40 words.';

    var text = await callClaude(prompt, 300);
    var parsed;
    try {
      parsed = parseJson(text);
    } catch (e) {
      throw new Error('AI response was malformed — try again.');
    }
    if (!parsed || !Array.isArray(parsed.themes) || typeof parsed.reflection !== 'string') {
      throw new Error('AI response was malformed — try again.');
    }
    return {
      themes: parsed.themes
        .filter(function (t) { return typeof t === 'string' && t.trim(); })
        .map(function (t) { return t.trim().toLowerCase(); })
        .slice(0, 3),
      reflection: parsed.reflection.trim()
    };
  }

  async function testKey() {
    await callClaude('Reply with exactly: ok', 10);
    return true;
  }

  return {
    SIMILARITY_THRESHOLD: SIMILARITY_THRESHOLD,
    MIN_NOTES_FOR_LINKS: MIN_NOTES_FOR_LINKS,
    analyze: analyze,
    suggestTags: suggestTags,
    getKey: getKey,
    setKey: setKey,
    getModelPref: getModelPref,
    setModelPref: setModelPref,
    hasKey: hasKey,
    maskedKey: maskedKey,
    organizeNote: organizeNote,
    reflectEntry: reflectEntry,
    testKey: testKey
  };
})();
