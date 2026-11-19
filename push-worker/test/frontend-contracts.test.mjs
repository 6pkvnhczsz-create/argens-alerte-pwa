import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const html = read('../../index.html');
const germanSource = read('../../i18n-de.js');

function englishDictionary() {
 const start = html.indexOf('const translations={');
 const end = html.indexOf('};\nconst patterns=', start);
 assert.ok(start >= 0 && end > start, 'Public translation table must be present');
 const literal = html.slice(start + 'const translations='.length, end + 1);
 return { raw: literal, values: runInNewContext('(' + literal + ')') };
}
function germanDictionary() {
 const context = { window: {} };
 runInNewContext(germanSource, context);
 return context.window;
}

test('the public French-English dictionary has no duplicate keys or untyped values', () => {
 const { raw, values } = englishDictionary();
 const keys = [...raw.matchAll(/^\s*("(?:\\.|[^"\\])*")\s*:/gm)].map(x => JSON.parse(x[1]));
 assert.ok(keys.length >= 200);
 assert.equal(keys.length, new Set(keys).size, 'Duplicate keys silently override earlier translations');
 assert.equal(keys.length, Object.keys(values).length);
 assert.ok(Object.values(values).every(v => typeof v === 'string' && v.length));
});

test('every public French-English string has a German translation', () => {
 const { values } = englishDictionary(), de = germanDictionary().argensGermanDictionary;
 for (const [french, english] of Object.entries(values)) {
  assert.ok(Object.hasOwn(de, french), 'Missing German text: ' + french);
  assert.ok(typeof de[french] === 'string' && de[french].length > 0);
  assert.ok(typeof english === 'string' && english.length > 0);
 }
});

test('town-search failures are localized and accessible labels have translations', () => {
 const { values } = englishDictionary();
 const window = germanDictionary(), de = window.argensGermanDictionary;
 const townErrors = [
  'Commune introuvable. Vérifiez le nom ou le code postal.',
  'Les services de recherche de communes ne répondent pas. Réessayez.',
  'Commune trouvée, mais le répertoire de stations Hub’Eau ne répond pas. Réessayez plus tard.'
 ];
 for (const text of townErrors) {
  const german = window.argensGermanText(text, '');
  assert.ok(german !== text && german.length >= 15, 'Not localized: ' + text);
 }
 const aria = [
  'Date et heure de la dernière mesure', 'Hauteurs en mètres', 'Heures des mesures',
  'Indicateurs de précocité Argens', 'Prévisions de pluie pour 6 et 24 heures',
  'Précipitations estimées sur 3 et 6 heures', 'Animation des pluies prévues',
  'Lire la prévision', 'Heure de prévision',
  'Six couleurs de pluie, du plus faible au plus fort',
  'Carte des stations hydrologiquement connectées',
  'Stations de mesure de l’Argens sur la carte', 'Carte des stations hydrométriques'
 ];
 for (const phrase of aria) {
  assert.ok(Object.hasOwn(values, phrase), 'Missing English ARIA label: ' + phrase);
  assert.ok(Object.hasOwn(de, phrase), 'Missing German ARIA label: ' + phrase);
 }
});

test('public PWA scripts parse and every local JavaScript entrypoint exists', () => {
 const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).filter(Boolean);
 assert.ok(inline.length >= 4, 'Expected the public PWA entrypoints');
 for (const script of inline) new Script(script);
 for (const path of ['i18n-de.js', 'home-vigilance.js', 'piaf-player.js',
  'piaf-palette.js', 'national-upstream.js', 'sw.js']) {
  assert.ok(existsSync(new URL('../../' + path, import.meta.url)), 'Missing entrypoint: ' + path);
  new Script(read('../../' + path));
 }
});

test('public markup has unique IDs and only the active PIAF renderer', () => {
 const staticHtml = html.slice(0, html.indexOf('<script'));
 const ids = [...staticHtml.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
 assert.equal(ids.length, new Set(ids).size, 'Duplicate DOM IDs are ambiguous');
 for (const id of ['piafForecastPanel', 'piafForecastMap', 'piafForecastControls',
  'earlyUpstreamRows', 'upstreamMap', 'homeOfficialPanel', 'longRangeDays']) {
  assert.ok(ids.includes(id), 'Missing essential PWA element: ' + id);
 }
 assert.doesNotMatch(html, /function loadOfficialRadarMap\(/,
  'Removed observed-radar renderer must not access non-existent DOM nodes');
 assert.match(html, /piaf-player\.js/, 'PIAF forecast animation must remain installed');
});

test('Cloudflare Access admin page is German and its embedded JavaScript parses', () => {
 const admin = read('../../admin-worker/src/index.js');
 const start = admin.indexOf('const PAGE='), end = admin.indexOf('\nconst response=', start);
 assert.ok(start > 0 && end > start);
 const page = JSON.parse(admin.slice(start + 'const PAGE='.length, end).trim().replace(/;$/, ''));
 assert.match(page, /<html lang="de">/);
 const scripts = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).filter(Boolean);
 assert.ok(scripts.length);
 for (const source of scripts) new Script(source);
});

test('all named backend imports resolve to existing exported symbols', () => {
 const modules = [
  'push-worker/src/index.js',
  'push-worker/src/water-sources.mjs',
  'push-worker/src/vigicrues-snapshot.mjs',
  'push-worker/src/early-signals.mjs',
  'push-worker/src/feedback-translation.mjs',
  'push-worker/src/radar-map.mjs',
  'push-worker/src/piaf-map.mjs',
  'push-worker/src/piaf-station.mjs',
  'push-worker/src/measured-rain.mjs',
  'push-worker/src/observed-argens-rain.mjs',
  'push-worker/src/long-range-forecast.mjs',
  'push-worker/src/upstream-topage.mjs',
  'admin-worker/src/index.js',
  'admin-worker/src/forecast-shadow.js',
  'admin-worker/src/forecast-shadow-schedule.js',
  'admin-worker/src/national-rain.js',
  'admin-worker/src/forecast-shadow-comparison.js',
  'admin-worker/src/rain-archive-2026.js',
  'admin-worker/src/forecast-shadow-model.js',
  'admin-worker/src/forecast-shadow-page.js'
 ];
 const sources = Object.fromEntries(modules.map(file => [file, read('../../' + file)]));
 const available = {};
 for (const [path, source] of Object.entries(sources)) {
  const names = [...source.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|function|class)\s+(\w+)/g)]
   .map(match => match[1]);
  for (const match of source.matchAll(/\bexport\s*{([^}]+)}\s*from\s*['"][^'"]+['"]/g))
   names.push(...match[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()));
  available[path] = new Set(names);
 }
 let count = 0;
 for (const [from, source] of Object.entries(sources)) {
  for (const match of source.matchAll(/import\s*{([^}]+)}\s*from\s*['"](\.[^'"]+)['"]/g)) {
   const to = from.slice(0, from.lastIndexOf('/') + 1) + match[2].slice(2);
   assert.ok(Object.hasOwn(sources, to), 'Missing backend module: ' + to);
   for (const part of match[1].split(',')) {
    const symbol = part.trim().split(/\s+as\s+/)[0];
    assert.ok(available[to].has(symbol), 'Missing export ' + symbol + ' in ' + to + ' (required by ' + from + ')');
    count++;
   }
  }
 }
 assert.ok(count >= 50, 'The backend import contract checker must cover both Workers');
});

test('service worker keeps public application scripts in its shell and has matching version tags', () => {
 const worker = read('../../sw.js');
 const version = worker.match(/argens-alerte-pwa-v(\d+)/)?.[1];
 assert.ok(version, 'PWA must have a versioned cache');
 assert.match(worker, new RegExp("_pwa_update','" + version + "'"));
 for (const asset of ['index.html', 'i18n-de.js', 'piaf-palette.js',
  'piaf-player.js', 'national-upstream.js', 'home-vigilance.js']) {
  assert.ok(worker.includes("'./" + asset + "'"), 'Missing offline shell asset: ' + asset);
 }
});

test('public and admin API paths must have a matching Worker route', () => {
 const push = read('../../push-worker/src/index.js');
 const admin = read('../../admin-worker/src/index.js');
 const declared = source => new Set([...source.matchAll(/url\.pathname\s*===\s*['"]([^'"]+)['"]/g)].map(m => m[1]));
 const pushPaths = declared(push), adminPaths = declared(admin);
 for (const file of ['../../index.html','../../home-vigilance.js',
  '../../piaf-player.js','../../national-upstream.js']) {
  const paths = [...new Set([...read(file).matchAll(/\/api\/[a-zA-Z0-9_\/-]+/g)].map(m=>m[0]))]
   .filter(name => !name.startsWith('/api/v2/'));
  for (const name of paths)
   assert.ok(pushPaths.has(name)||[...pushPaths].some(x=>x.startsWith(name+'/')),
    'Public app references unavailable Worker route ' + name + ' in ' + file);
 }
 const adminReferenced = [...new Set([...admin.matchAll(/\/api\/[a-zA-Z0-9_\/-]+/g)].map(m=>m[0]))]
  .filter(name => !name.startsWith('/api/v2/'));
 for (const name of adminReferenced)
  assert.ok(adminPaths.has(name), 'Admin HTML references missing admin route ' + name);
});
