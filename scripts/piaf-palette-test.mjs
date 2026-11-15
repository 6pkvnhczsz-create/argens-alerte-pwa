import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const window={};
runInNewContext(readFileSync(new URL('../piaf-palette.js',import.meta.url),'utf8'),{window});
const palette=window.PiafPalette;
const samples=[
 [99,0,110,0], // seen in live PIAF raster, violet
 [0,0,254,1], // royal blue
 [0,177,254,2], // cyan
 [0,240,20,3], // green
 [255,255,0,4], // yellow
 [255,20,0,5] // red
];
test('the provider colour sequence is remapped to six ordered user colours',()=>{
 assert.equal(palette.colors.length,6);
 assert.deepEqual([...palette.colors],['#bae9ff','#50b8f0','#1555a5','#f5d547','#f28b2f','#d92f45']);
 for(const [r,g,b,expected] of samples)assert.equal(palette.sourceBand(r,g,b),expected);
 assert.equal(palette.colors.some(c=>c==='#00ff00'||c==='#7f00ff'),false);
 assert.equal(palette.sourceBand(255,0,255),5,'Extreme magenta must be red, never light blue');
 assert.equal(palette.sourceBand(99,0,110),0,'Low dark violet remains very light blue');
});
test('RGBA conversion preserves transparency and unknown neutral colours',()=>{
 const pixels=new Uint8ClampedArray([99,0,110,255,0,0,254,170,0,177,254,255,0,240,20,255,255,255,0,255,255,20,0,255,99,0,110,0,255,255,255,255]);
 const outcome=palette.recolorPixels(pixels);
 assert.deepEqual([pixels[0],pixels[1],pixels[2]], [186,233,255]);
 assert.deepEqual([pixels[4],pixels[5],pixels[6],pixels[7]],[80,184,240,170]);
 assert.deepEqual([pixels[8],pixels[9],pixels[10]],[21,85,165]);
 assert.deepEqual([pixels[12],pixels[13],pixels[14]],[245,213,71]);
 assert.deepEqual([pixels[16],pixels[17],pixels[18]],[242,139,47]);
 assert.deepEqual([pixels[20],pixels[21],pixels[22]],[217,47,69]);
 assert.deepEqual([pixels[24],pixels[25],pixels[26],pixels[27]],[99,0,110,0]);
 assert.deepEqual([pixels[28],pixels[29],pixels[30],pixels[31]],[255,255,255,255]);
 assert.equal(outcome.changed,6);assert.equal(outcome.unknown,1);
});
test('Canvas recolouring rejects tainted image or inconsistent size rather than showing raw WMS colours',()=>{
 assert.throws(()=>palette.recolorImage({naturalWidth:5000,naturalHeight:5000}),/dimensions/);
 assert.throws(()=>palette.recolorImage({naturalWidth:4,naturalHeight:1},{createElement:()=>({getContext:()=>null})}),/cannot recolor/);
});
