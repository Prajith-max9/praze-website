/* Runs every verify-*.js in this directory and reports a single verdict.
 *
 * Node rather than the bash runall.sh the old suites used: the project is now
 * built and tested on Windows too, and `bash` is not a given there.
 *
 * Run:  node runall.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = fs.readdirSync(__dirname)
  .filter(f => /^verify-.*\.js$/.test(f))
  .sort();

if (!suites.length) {
  console.error('No verify-*.js suites found in ' + __dirname);
  process.exit(1);
}

const failed = [];
for (const suite of suites) {
  console.log('\n=== ' + suite + ' ' + '='.repeat(Math.max(0, 60 - suite.length)));
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: 'inherit', cwd: __dirname
  });
  if (r.status !== 0) failed.push(suite);
}

console.log('\n' + '='.repeat(64));
console.log(suites.length - failed.length + '/' + suites.length + ' suites passed');
if (failed.length) {
  console.log('failed: ' + failed.join(', '));
  process.exit(1);
}
