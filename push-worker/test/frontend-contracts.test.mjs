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
