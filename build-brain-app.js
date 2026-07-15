/* Bundle the second brain into one self-contained file: brain-app.html.
   Inlines styles.css + brain.css and the three scripts so the app opens
   from a plain file:// with no server and no separate files. Re-run after
   editing any source: `node build-brain-app.js`. */
const fs = require('fs');
const path = require('path');
const dir = __dirname;

const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

let html = read('brain.html');

const styles = read('styles.css');
const brainCss = read('brain.css');
const inlineStyle =
  '<style>\n/* --- styles.css --- */\n' + styles +
  '\n/* --- brain.css --- */\n' + brainCss + '\n</style>';

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

// Inline the three scripts right before </body>, in load order
const inlineScripts =
  '\n<script>\n' + read('brain-ai.js') + '\n</script>\n' +
  '<script>\n' + read('brain-graph.js') + '\n</script>\n' +
  '<script>\n' + read('brain.js') + '\n</script>\n';

html = html.replace('</body>', function () { return inlineScripts + '</body>'; });

fs.writeFileSync(path.join(dir, 'brain-app.html'), html);
console.log('Wrote brain-app.html (' + html.length + ' bytes)');
