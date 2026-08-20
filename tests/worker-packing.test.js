'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const core = require('../load-placement-core.js');

const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'packing-runtime.js'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'load-rules-v2.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'packer-worker.js'), 'utf8');

function fixture() {
  const cabinets = [
    {id:'base-1', rc:'B1', name:'Base', cls:'base', w:36, h:34.5, d:24, stackOn:true},
    {id:'base-2', rc:'B2', name:'Base', cls:'base', w:30, h:34.5, d:24, stackOn:true},
    {id:'wall-1', rc:'W1', name:'Wall', cls:'wall', w:30, h:30, d:12, stackOn:false},
    {id:'tall-1', rc:'T1', name:'Tall', cls:'tall', w:24, h:84, d:24, stackOn:false}
  ];
  const geom = {W:96, H:96, totalL:240, wells:[], ledges:[], gn:null, taper:null};
  const options = {gap:1, ply:0.5, allowStack:true, allowBack:true, standMargin:3};
  return {cabinets, geom, options};
}

function loadSynchronousV2() {
  const window = {CLOPlacementCore:core, validatePoseClearance:core.validatePoseClearance};
  const sandbox = {window, document:{dispatchEvent(){}}, CustomEvent:function CustomEvent(){}, console:{log(){}, warn(){}, error(){}}, JSON, Math, Object, Set, Map, Array};
  vm.createContext(sandbox);
  vm.runInContext(runtime, sandbox, {filename:'packing-runtime.js'});
  vm.runInContext(rules, sandbox, {filename:'load-rules-v2.js'});
  assert.equal(sandbox.window.CLO_ACTIVE_ENGINE, 'v2');
  return sandbox.window.packLoad;
}

function loadWorkerHarness() {
  const messages = [];
  const sandbox = {console:{log(){}, warn(){}, error(){}}, JSON, Math, Object, Set, Map, Array};
  sandbox.self = sandbox;
  sandbox.postMessage = message => messages.push(JSON.parse(JSON.stringify(message)));
  sandbox.importScripts = (...names) => {
    for(const name of names) vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), sandbox, {filename:name});
  };
  vm.createContext(sandbox);
  vm.runInContext(workerSource, sandbox, {filename:'packer-worker.js'});
  return {sandbox, messages};
}

test('Worker message handler activates V2 and returns the same placement records as synchronous packing', () => {
  const syncPack = loadSynchronousV2();
  const input = fixture();
  const expected = JSON.parse(JSON.stringify(syncPack(input.cabinets, input.geom, input.options)));
  const {sandbox, messages} = loadWorkerHarness();
  assert.deepEqual(messages[0], {type:'ready', engine:'v2'});
  sandbox.onmessage({data:JSON.parse(JSON.stringify({type:'pack', ...input}))});
  const progress = messages.filter(message => message.type==='progress');
  const resultMessage = messages.find(message => message.type==='result');
  assert.ok(progress.length >= 1, 'Worker emits optional progress messages');
  assert.equal(resultMessage.engine, 'v2');
  assert.deepEqual(resultMessage.result, expected);
  assert.ok(resultMessage.result.placed.every(placement => placement.cab && typeof placement.cab.id==='string'), 'cabinet references survive structured clone');
});
