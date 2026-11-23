/**
 * "Build" for a zero-build static site: verify every relative ES import and
 * every local <script>/<link> reference resolves to a real file, and that each
 * app folder has an index.html. Exits non-zero on any problem.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'tests', 'docs', 'scripts', 'coverage', '.claude', '.vscode', 'test-results', 'playwright-report']);
const problems = [];
let jsFiles = 0;
let htmlFiles = 0;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

for (const file of walk(root)) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) {
    jsFiles++;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2];
      if (!existsSync(resolve(dirname(file), spec))) problems.push(`${relative(root, file)}: unresolved import "${spec}"`);
    }
  } else if (file.endsWith('.html')) {
    htmlFiles++;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:src|href)=["'](?!https?:|data:|#|mailto:|\/\/)([^"'#?]+)["']/g)) {
      const target = m[1];
      if (target.startsWith('./') || !target.startsWith('/')) {
        if (!existsSync(resolve(dirname(file), target))) problems.push(`${relative(root, file)}: missing asset "${target}"`);
      }
    }
  }
}

for (const dir of readdirSync(root)) {
  const p = join(root, dir);
  if (SKIP.has(dir) || dir.startsWith('.') || !statSync(p).isDirectory() || dir === 'shared') continue;
  if (!existsSync(join(p, 'index.html'))) problems.push(`${dir}/: no index.html`);
}

if (problems.length) {
  console.error(`build-check FAILED (${problems.length}):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`build-check OK — ${jsFiles} JS modules, ${htmlFiles} HTML pages, all local references resolve.`);
