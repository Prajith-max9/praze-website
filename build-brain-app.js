/* Bundle the second brain into one self-contained file: brain-app.html.
   Inlines styles.css + brain.css and the three scripts so the app opens
   from a plain file:// with no server and no separate files. Re-run after
   editing any source: `node build-brain-app.js`. */
const fs = require('fs');
const path = require('path');
const dir = __dirname;

const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

/* ---------- Minification (bundle output only; sources stay readable) ----------
   Deliberately conservative: no renaming, no reordering, no semicolon games.
   Both minifiers walk the text character by character so a `//` or `/* *​/`
   inside a string, template literal or regex is never mistaken for a comment.
   The JS pass keeps every newline, so automatic semicolon insertion behaves
   exactly as it does in the source — the saving comes from comments and
   indentation, which is most of it and carries no behavioural risk. */

function minifyJs(src) {
  var out = '';
  var i = 0;
  var prev = ''; // last significant char emitted, for regex-vs-divide
  while (i < src.length) {
    var c = src[i];
    var d = src[i + 1];

    if (c === '/' && d === '/') {                 // line comment
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {                 // block comment
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {    // string / template literal
      var quote = c;
      var str = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { str += src[i] + src[i + 1]; i += 2; continue; }
        str += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      out += str;
      prev = quote;
      continue;
    }
    // regex literal: only where a value can start. After an operand
    // (identifier, `)`, `]`) a slash is division — unless that "identifier"
    // is a keyword like `return` or `typeof`, which is followed by a value.
    if (c === '/' && (!/[\w$)\]]/.test(prev) || /\b(return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)$/.test(out.replace(/\s+$/, '')))) {
      var re = '/';
      i++;
      var inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { re += src[i] + src[i + 1]; i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { re += '/'; i++; break; }
        else if (src[i] === '\n') break; // not a regex after all
        re += src[i];
        i++;
      }
      while (i < src.length && /[gimsuy]/.test(src[i])) { re += src[i]; i++; }
      out += re;
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out
    .split('\n')
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line.length; })
    .join('\n');
}

function minifyCss(src) {
  var out = '';
  var strings = [];   // quoted runs are parked here so the whitespace pass
  var i = 0;          // below can never reach inside content:'…' or url('…')
  while (i < src.length) {
    var c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      var quote = c;
      var str = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { str += src[i] + src[i + 1]; i += 2; continue; }
        str += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      out += '\u0000' + (strings.push(str) - 1) + '\u0000';
      continue;
    }
    out += c;
    i++;
  }
  return out
    .replace(/\s+/g, ' ')                     // collapse all whitespace
    .replace(/\s*([{};,>])\s*/g, '$1')        // trim around separators
    .replace(/:\s+/g, ':')                    // only AFTER a colon, so a
    .replace(/;}/g, '}')                      // descendant `.a :hover` is safe
    .trim()
    .replace(/\u0000(\d+)\u0000/g, function (m, n) { return strings[+n]; });
}

let html = read('brain.html');

// The bundle has to open from a bare file:// with nothing beside it, so the
// self-hosted woff2 files are embedded as data: URIs rather than left as
// relative paths. (The multi-file app keeps the real paths and caches them
// through the service worker.)
function inlineFonts(css) {
  return css.replace(/url\('(fonts\/[^']+\.woff2)'\)/g, function (match, file) {
    const b64 = fs.readFileSync(path.join(dir, file)).toString('base64');
    return "url('data:font/woff2;base64," + b64 + "')";
  });
}

// Minify first, THEN embed the fonts: a base64 data: URI is full of `;` and
// `,` and would be wrecked by the whitespace pass, so it never goes near it.
const stylesMin = minifyCss(read('styles.css'));
const styles = inlineFonts(stylesMin);
const brainCss = minifyCss(read('brain.css'));
const inlineStyle = '<style>' + styles + brainCss + '</style>';

// Replace the two external stylesheet links with one inline <style>.
// Function-form replacements throughout: a plain string replacement treats
// `$&` as "the matched text", which mangles any inlined code containing `$&`
// (escapeRegExp's '\\$&' became '\\</body>' in earlier bundles).
html = html.replace(
  /<link rel="stylesheet" href="styles\.css">\s*<link rel="stylesheet" href="brain\.css">/,
  function () { return inlineStyle; }
);

// Remove the three deferred external scripts from <head>
html = html.replace(/\s*<script src="brain-ai\.js" defer><\/script>/, '');
html = html.replace(/\s*<script src="brain-graph\.js" defer><\/script>/, '');
html = html.replace(/\s*<script src="brain\.js" defer><\/script>/, '');

// Inline the three scripts right before </body>, in load order. Each one is
// parsed after minifying — a minifier bug that produces invalid JS must fail
// the build here, not ship silently into the bundle.
function script(file) {
  const min = minifyJs(read(file));
  try {
    new Function(min);
  } catch (e) {
    throw new Error('Minified ' + file + ' failed to parse: ' + e.message);
  }
  return '<script>\n' + min + '\n</script>\n';
}

const inlineScripts = '\n' + script('brain-ai.js') + script('brain-graph.js') + script('brain.js');

html = html.replace('</body>', function () { return inlineScripts + '</body>'; });

fs.writeFileSync(path.join(dir, 'brain-app.html'), html);

const raw = ['styles.css', 'brain.css', 'brain-ai.js', 'brain-graph.js', 'brain.js']
  .reduce(function (n, f) { return n + read(f).length; }, 0);
const min = stylesMin.length + brainCss.length + inlineScripts.length;
console.log('Wrote brain-app.html (' + html.length + ' bytes)');
console.log('  minified CSS+JS: ' + raw + ' → ' + min + ' bytes (saved ' +
  (raw - min) + ', fonts embedded separately)');
