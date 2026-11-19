import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FORECAST_SHADOW_PAGE} from '../src/forecast-shadow.js';
import {FORECAST_SHADOW_I18N_SCRIPT} from '../src/forecast-shadow-i18n.js';

test('German remains the default; French only when requested',()=>{
 assert.match(FORECAST_SHADOW_PAGE,/<html lang="de">/);
 assert.match(FORECAST_SHADOW_I18N_SCRIPT,/params.get\('lang'\)==='fr'/);
 assert.match(FORECAST_SHADOW_I18N_SCRIPT,/if\(lang!=='fr'\)return/);
 assert.match(FORECAST_SHADOW_I18N_SCRIPT,/Prévision des crues/);
 assert.match(FORECAST_SHADOW_I18N_SCRIPT,/Cette estimation n/);
});
test('forecast route injects presentation-only script without changing other admin pages',()=>{
 const src=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.match(src,/FORECAST_SHADOW_PAGE\.replace\('<\/script>',FORECAST_SHADOW_I18N_SCRIPT/);
 assert.match(src,/url\.pathname==='\/forecast-shadow'/);
 assert.doesNotMatch(FORECAST_SHADOW_I18N_SCRIPT,/fetch\s*\(/);
});
