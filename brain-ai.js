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

  function computeAll(notes) {
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

    // vectors, df and N stay on the result so search() reuses this exact IDF
    // table via the same rev-keyed cache instead of building a parallel one
    var result = { related: {}, pairs: [], docs: docs, df: df, N: N };

    // cold-start gate applies to note-to-note links only, not to search:
    // below it, IDF is too noisy to declare two notes "related" unprompted,
    // but ranking against an explicit query is still better than nothing
    var eligible = notes.filter(function (n) { return n.kind !== 'clip'; }).length;
    if (eligible < MIN_NOTES_FOR_LINKS) return result;

    var related = result.related;
    var pairs = result.pairs;
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

    return result;
  }

  function analyze(notes, rev) {
    if (cache.rev !== rev || !cache.result) {
      cache.result = computeAll(notes);
      cache.rev = rev;
    }
    return cache.result;
  }

  // Rank every note against a free-text query with the same TF-IDF + cosine
  // math the note-to-note links use. Returns [{id, score}] sorted desc.
  function search(queryText, notes, rev) {
    var a = analyze(notes, rev);
    var docs = a.docs || [];
    if (!docs.length) return [];

    var tf = {};
    tokenizeText(queryText).forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
    var vec = {};
    var norm = 0;
    Object.keys(tf).forEach(function (t) {
      if (!a.df[t]) return; // term absent from the corpus can't match anything
      var w = tf[t] * Math.log(1 + a.N / a.df[t]);
      vec[t] = w;
      norm += w * w;
    });
    var q = { vec: vec, norm: Math.sqrt(norm) };

    return docs
      .map(function (d) { return { id: d.id, score: cosine(q, d) }; })
      .filter(function (r) { return r.score > 0; })
      .sort(function (x, y) { return y.score - x.score; });
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

  // Digest a week of diary entries: one pattern, one tension, one question
  async function digestWeek(entriesText) {
    var prompt =
      'You are reading a week of private diary entries from a 16-year-old who trains seriously ' +
      'and is building a fitness brand called PRAZE.\n\n' +
      'Entries:\n' + entriesText + '\n\n' +
      'Respond with ONLY a JSON object, no markdown fences:\n' +
      '{"pattern": "...", "tension": "...", "question": "..."}\n\n' +
      'Rules:\n' +
      '- "pattern": one thing that genuinely repeats across entries. Concrete, drawn from what\'s written. Not a compliment.\n' +
      '- "tension": one thing pulling against another in these entries (e.g. two goals competing for time). If there\'s no real tension, use an empty string.\n' +
      '- "question": one sharp question worth sitting with. Not rhetorical, not advice.\n' +
      '- Each field under 30 words. Never diagnose, never mention being an AI, never praise for the sake of it. If the week is thin, say so plainly rather than inventing depth.';

    var text = await callClaude(prompt, 500);
    var parsed;
    try {
      parsed = parseJson(text);
    } catch (e) {
      throw new Error('AI response was malformed — try again.');
    }
    if (!parsed || typeof parsed.pattern !== 'string' ||
        typeof parsed.tension !== 'string' || typeof parsed.question !== 'string') {
      throw new Error('AI response was malformed — try again.');
    }
    return {
      pattern: parsed.pattern.trim(),
      tension: parsed.tension.trim(),
      question: parsed.question.trim()
    };
  }

  /* Synthesize: 2-4 selected notes → short-form content in the creator's voice */

  var SYNTH_TASKS = {
    reel: 'REEL SCRIPT: a 30-45 second Instagram Reel script. Format: HOOK (first line, under ' +
      '12 words), then the spoken script in short lines, then one-line CTA. Under 130 words total.',
    hooks: 'HOOK IDEAS: 5 distinct opening hooks for a Reel about the shared idea. ' +
      'Each under 12 words. Numbered.',
    post: 'POST: one Instagram caption, under 120 words, line breaks between thoughts, ' +
      'ending with a question to the audience.'
  };

  async function synthesize(notesText, format) {
    var task = SYNTH_TASKS[format];
    if (!task) throw new Error('Unknown format.');
    var prompt =
      'You are a short-form content writer for a fitness and self-improvement creator building ' +
      'a personal brand. Voice: direct, grounded, no hype words, no emojis, no hashtag spam.\n\n' +
      'Source notes from their knowledge base:\n' + notesText + '\n\n' +
      'Task: ' + task + '\n\n' +
      'Rules: Draw ONLY from the ideas in the notes — do not invent claims, statistics, or ' +
      'personal stories that are not in them. If the notes don\'t combine into one coherent ' +
      'piece, say so in one line instead of forcing it.';

    var text = (await callClaude(prompt, 700)).trim();
    if (!text) throw new Error('AI returned an empty response — try again.');
    return text;
  }

  var WHY_BODY_CHARS = 1500;

  function clipBody(body) {
    return body.length > WHY_BODY_CHARS ? body.slice(0, WHY_BODY_CHARS) + '…' : body;
  }

  // One concrete sentence on what two similarity-linked notes actually share.
  // "If the connection is weak, say so" is load-bearing: a WHY that manufactures
  // profundity for a coincidental token overlap is worse than no WHY.
  async function explainLink(noteA, noteB) {
    var prompt =
      'Two notes from a personal knowledge base were flagged as related by a similarity algorithm.\n\n' +
      'Note A: ' + (noteA.title || '(untitled)') + '\n' + clipBody(noteA.body) + '\n\n' +
      'Note B: ' + (noteB.title || '(untitled)') + '\n' + clipBody(noteB.body) + '\n\n' +
      'In one sentence under 25 words, state the specific idea these two share. Be concrete — ' +
      'name the actual concept, don\'t say "both discuss similar themes". ' +
      'If the connection is weak or coincidental, say so plainly.';

    var text = await callClaude(prompt, 200);
    return text.trim();
  }

  // Answer a question from retrieved notes only. Context is built by the
  // caller (already truncated and capped); the answer is plain prose.
  async function askBrain(question, context) {
    var prompt =
      "You are answering questions about a person's private notes. You can only use " +
      'the notes provided — you have no other knowledge of this person.\n\n' +
      'Their notes:\n' + context + '\n\n' +
      'Their question: ' + question + '\n\n' +
      'Answer in plain prose, under 120 words. Rules:\n' +
      "- Use only what's in the notes. If the notes don't answer it, say so plainly — do not guess or fill gaps.\n" +
      '- Cite which notes you drew on by their exact titles, in square brackets, e.g. [Protein brand idea].\n' +
      '- Never flatter, never pad, never mention being an AI.\n' +
      '- If the notes contradict each other, say that rather than picking one.';

    var text = await callClaude(prompt, 600);
    return text.trim();
  }

  async function testKey() {
    await callClaude('Reply with exactly: ok', 10);
    return true;
  }

  return {
    SIMILARITY_THRESHOLD: SIMILARITY_THRESHOLD,
    MIN_NOTES_FOR_LINKS: MIN_NOTES_FOR_LINKS,
    tokenize: tokenizeText,
    analyze: analyze,
    search: search,
    suggestTags: suggestTags,
    getKey: getKey,
    setKey: setKey,
    getModelPref: getModelPref,
    setModelPref: setModelPref,
    hasKey: hasKey,
    maskedKey: maskedKey,
    organizeNote: organizeNote,
    reflectEntry: reflectEntry,
    digestWeek: digestWeek,
    askBrain: askBrain,
    explainLink: explainLink,
    synthesize: synthesize,
    testKey: testKey
  };
})();
