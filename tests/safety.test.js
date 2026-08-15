const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const safety = require('../load-safety-core.js');

const root = path.resolve(__dirname, '..');

test('HTML escaping neutralizes imported markup', () => {
  assert.equal(safety.escapeHTML('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('rear entry accepts any workable orientation and rejects impossible boxes', () => {
  const rear = {w: 70, h: 72};
  assert.equal(safety.canEnterRear({w: 60, h: 80, d: 24}, rear), true);
  assert.equal(safety.canEnterRear({w: 73, h: 80, d: 75}, rear), false);
});

test('door coverage is measured against the door bank, not the upper piece', () => {
  const doors = {x:0,z:0,w:30,d:30};
  assert.equal(safety.coversDoorBank({x:0,z:0,w:10,d:10}, doors, .85), false);
  assert.equal(safety.coversDoorBank({x:0,z:0,w:30,d:26}, doors, .85), true);
});

test('trailer schema rejects negative and contradictory geometry', () => {
  assert.ok(safety.validateTrailer({type:'standard',w:-1,h:96,len:240,rd:0}).length);
  assert.ok(safety.validateTrailer({type:'standard',w:96,h:96,len:240,rw:100,rd:0}).length);
  assert.equal(safety.validateTrailer({type:'standard',w:96,h:96,len:240,rw:90,rh:90,rd:3,ww:false,vnose:false}).length,0);
});

test('weight model combines measured empty reactions with cargo moments', () => {
  const trailer={emptyWeight:2000,emptyTongue:200,gvwr:4000,gawr:3500,maxTongue:500,axleRear:60};
  const placed=[{z:80,d:20,cab:{id:'c1',weight:100}}];
  const result=safety.analyzeWeight(placed,trailer,240);
  assert.equal(result.complete,true);
  assert.equal(Math.round(result.totalWeight),2100);
  assert.equal(Math.round(result.tongueWeight),250);
  assert.equal(Math.round(result.axleWeight),1850);
  assert.deepEqual(result.issues,[]);
});

test('source keeps critical safety wiring intact', () => {
  const rules=fs.readFileSync(path.join(root,'load-rules-v2.js'),'utf8');
  const manual=fs.readFileSync(path.join(root,'manual-layout.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'cabinet-load-optimizer.html'),'utf8');
  assert.doesNotMatch(rules,/flatOnFloor\s*:\s*true/);
  assert.match(rules,/CLO_POSE_ORDER/);
  assert.match(rules,/coversDoorBank/);
  assert.match(manual,/validatePlacementV2/);
  assert.match(manual,/Optimize stopped/);
  assert.doesNotMatch(html,/src="https:\/\//);
  for(const match of html.matchAll(/<script\s+src="([^"]+)"/g))
    assert.ok(fs.existsSync(path.join(root,match[1])), `missing browser dependency: ${match[1]}`);
});

test('all application scripts compile', () => {
  for(const file of ['load-safety-core.js','end-views.js','load-learning.js','load-rules-v2.js','manual-layout.js']){
    assert.doesNotThrow(()=>new Function(fs.readFileSync(path.join(root,file),'utf8')), file);
  }
  const html=fs.readFileSync(path.join(root,'cabinet-load-optimizer.html'),'utf8');
  const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(s=>s.trim());
  assert.equal(inline.length,1);
  assert.doesNotThrow(()=>new Function(inline[0]));
});
