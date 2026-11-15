import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const pageStart = src.indexOf('const PAGE=') + 'const PAGE='.length;
const pageEnd = src.indexOf(';\nconst response=', pageStart);
assert.ok(pageEnd > pageStart, 'Admin HTML template is present');
const html = JSON.parse(src.slice(pageStart, pageEnd));
const inlineScript = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
const dashboard = html.slice(html.indexOf('<div data-page="dashboard">'), html.indexOf('<div data-page="backups">'));
const backups = html.slice(html.indexOf('<div data-page="backups">'), html.indexOf('<div data-page="warnings">'));

test('Backup-Stationen is a real admin navigation destination', () => {
 assert.match(html, /href="#backups" data-nav="backups">Backup-Stationen/);
 assert.match(inlineScript, /'backups'/);
 assert.match(inlineScript, /if\(page==='backups'\)loadBackupCoverage\(\)/);
 assert.match(backups, /<h2>Backup-Stationen<\/h2>/);
});

test('the dashboard keeps compact Vigicrues health but not the per-station list', () => {
 assert.match(dashboard, /id="svcVigicrues"/);
 assert.doesNotMatch(dashboard, /id="svcCoverageSummary"|id="svcCoverageList"|id="svcCoverageRefresh"/);
 assert.match(backups, /id="svcCoverageSummary"/);
 assert.match(backups, /id="svcCoverageList"/);
 assert.match(backups, /id="svcCoverageRefresh"/);
});

test('station list is fetched only from the dedicated, Access-protected endpoint', () => {
 const healthStart=src.indexOf("url.pathname==='/api/service-health'");
 const healthEnd=src.indexOf("url.pathname==='/api/monitor'",healthStart);
 const health=src.slice(healthStart,healthEnd);
 assert.ok(healthStart>-1 && healthEnd>healthStart);
 assert.doesNotMatch(health, /vigicruesCoverageAdmin/);
 assert.doesNotMatch(health, /vigicruesCoverage,/);
 assert.ok(src.includes("url.pathname==='/api/vigicrues-coverage'"));
 assert.match(src, /response\(await env\.PUSH_SERVICE\.vigicruesCoverageAdmin\(\)\)/);
 assert.match(inlineScript, /fetch\('\/api\/vigicrues-coverage',\{cache:'no-store'\}\)/);
 const access=src.indexOf("if(!request.headers.get('Cf-Access-Jwt-Assertion'))");
 assert.ok(access>-1&&access<healthStart,'Access still guards the admin API');
});

test('the backup page and inline script are syntactically valid, with unique element IDs', () => {
 assert.doesNotThrow(()=>new Script(inlineScript));
 for(const id of ['svcCoverageSummary','svcCoverageList','svcCoverageRefresh','svcCoverageChecked']){
  assert.equal(html.split('id="'+id+'"').length-1,1,id+' must be unique');
 }
 assert.match(inlineScript,/summary\.textContent='Stationsübersicht wird geladen/);
 assert.match(inlineScript,/list\.replaceChildren\(\)/);
 assert.match(inlineScript,/status\.textContent=station\.status==='good'\?'Backup verfügbar'/);
});
