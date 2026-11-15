import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { parseFeedbackTranslation, translateFeedbackRecord } from '../src/feedback-translation.mjs';

function testDb(message='Il y a de l’eau près de la maison.'){
 const translations=new Map();let writes=0;
 const db={translations,prepare(sql){let args=[];
  return {
   bind(...values){args=values;return this},
   async run(){
    if(sql.startsWith('INSERT INTO feedback_translations')){
     writes++;if(!translations.has(args[0]))translations.set(args[0],{source_language:args[1],translated_de:args[2]});
    }return {meta:{changes:1}};
   },
   async first(){
    if(sql.startsWith('SELECT source_language'))return translations.get(args[0])||null;
    if(sql.startsWith('SELECT id,message'))return args[0]===23?{id:23,message}:null;
    return null;
   }
  };
 }};
 return {db,getWrites:()=>writes};
}

test('French feedback receives plain German translation and original remains unchanged',async()=>{
 const original='Il y a de l’eau près de la maison.';
 const {db,getWrites}=testDb(original);
 let calls=0;
 const ai={run:async(model,args)=>{
  calls++;assert.match(model,/llama-3.1-8b-instruct-fast/);
  assert.equal(args.messages[1].content,JSON.stringify({feedback:original}));
  return {response:JSON.stringify({language:'fr',translation_de:'In der Nähe des Hauses steht Wasser.'})};
 }};
 const result=await translateFeedbackRecord({DB:db,AI:ai},23);
 assert.equal(result.translated_de,'In der Nähe des Hauses steht Wasser.');
 assert.equal(result.source_language,'fr');
 assert.equal(original,'Il y a de l’eau près de la maison.');
 const cached=await translateFeedbackRecord({DB:db,AI:ai},23);
 assert.equal(cached.cached,true);
 assert.equal(calls,1);
 assert.equal(getWrites(),1);
});

test('German feedback always preserves exact original, even when AI rewrites it',()=>{
 const original='Bitte zeigt die Station Y531201001 weiter an!';
 const parsed=parseFeedbackTranslation({response:JSON.stringify({language:'de',translation_de:'Anderer Inhalt'})},original);
 assert.equal(parsed.translated_de,original);
 assert.equal(parsed.source_language,'de');
});

test('Spanish, English, French and Dutch model response parsed even in fenced output',()=>{
 for(const lang of ['es','en','fr','nl']){
  const fence=String.fromCharCode(96).repeat(3);
  const response={response:fence+'json\n'+JSON.stringify({language:lang,translation_de:'Eine Meldung auf Deutsch.'})+'\n'+fence};
  assert.deepEqual(parseFeedbackTranslation(response,'Test'),{source_language:lang,translated_de:'Eine Meldung auf Deutsch.'});
 }
});

test('rejects malformed or excessive model output, and missing AI does not destroy original',async()=>{
 assert.throws(()=>parseFeedbackTranslation({response:'no translation'},'Bonjour'),/JSON/);
 assert.throws(()=>parseFeedbackTranslation({response:'{"language":"fr","translation_de":""}'},'Bonjour'),/Invalid translation/);
 const {db}=testDb('Something is not working.');
 await assert.rejects(()=>translateFeedbackRecord({DB:db},23),/AI binding/);
 assert.equal(db.translations.size,0);
 await assert.rejects(()=>translateFeedbackRecord({DB:db,AI:{run:async()=>({response:'unusable'})}},23),/JSON/);
 assert.equal(db.translations.size,0);
});

test('feedback translation only accepts a valid existing DB feedback ID, never user supplied text',async()=>{
 const {db}=testDb('Translated input');
 await assert.rejects(()=>translateFeedbackRecord({DB:db,AI:{run:async()=>({})}},24),/Feedback not found/);
 await assert.rejects(()=>translateFeedbackRecord({DB:db},-1),/Invalid feedback translation request/);
 await assert.rejects(()=>translateFeedbackRecord({DB:db},'23'),/Invalid feedback translation request/);
});

test('admin route is Access protected, cached, shows originals without injecting HTML',()=>{
 const admin=readFileSync(new URL('../../admin-worker/src/index.js',import.meta.url),'utf8');
 const push=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const from=admin.indexOf('const PAGE=')+'const PAGE='.length,to=admin.indexOf(';\nconst response=',from);
 const html=JSON.parse(admin.slice(from,to));
 const script=html.slice(html.indexOf('<script>')+8,html.indexOf('</script>'));
 assert.doesNotThrow(()=>new Script(script));
 assert.match(admin,/LEFT JOIN feedback_translations t ON t.feedback_id=f.id/);
 assert.ok(admin.includes("url.pathname==='/api/feedback/translate'"));
 assert.match(admin,/request.headers.get\('Origin'\)!==url.origin/);
 assert.ok(admin.indexOf("if(!request.headers.get('Cf-Access-Jwt-Assertion'))")<admin.indexOf("url.pathname==='/api/feedback/translate'"));
 assert.match(html,/Originalnachricht anzeigen/);
 assert.match(script,/old.textContent=german\?x.message:entry.translated_de/);
 assert.match(script,/original.textContent=x.message/);
 assert.match(script,/Übersetzung gerade nicht verfügbar/);
 assert.match(push,/ctx.waitUntil\(translateFeedbackRecord\(env,feedbackId\)/);
});
