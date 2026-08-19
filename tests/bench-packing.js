#!/usr/bin/env node
'use strict';

/*
 * Manual V2 packing benchmark. Run with:
 *   node tests/bench-packing.js
 *
 * The parent process gives each size a hard timeout by launching this same
 * script in worker mode. The worker loads load-rules-v2.js through the same
 * VM-style runtime used by behavioral-safety.test.js, with a one-line counter
 * inserted at canPlace() entry so the shipped algorithm is measured directly.
 */

const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../load-placement-core.js');

const SIZES = [40, 86, 120, 175, 250];
const PER_SIZE_TIMEOUT_MS = 45000;
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'load-rules-v2.js'), 'utf8');
const canPlacePattern = /function canPlace\(g,ix,gap,x,y,z,w,h,d,ply,cpose,ccls,ccab,nearIn,standMargin[^)]*\)\{/;

function loadV2WithCounter() {
  const metrics = {canPlace:0};
  const instrumented = source.replace(
    canPlacePattern,
    match => `${match}\n    metrics.canPlace += 1;`
  );
  if(instrumented === source) throw new Error('Benchmark instrumentation could not locate canPlace().');

  const window = {
    CLOPlacementCore: core,
    validatePoseClearance: core.validatePoseClearance,
    CLO_LEGACY_POSE_ORDER: {
      base:['upright','side','back'], tall:['side','back','upright'], wall:['side','upright','back'],
      flat:['back','side','upright'], pkg:['back','side','upright'], other:['side','upright','back']
    }
  };
  const sandbox = {
    console: {log(){}, warn(){}, error(){}}, window, metrics,
    document: {dispatchEvent(){}}, CustomEvent: function CustomEvent(){},
    packLoad(){}, geomOf(){},
    cabClass(cab) { return cab.cls || 'base'; },
    availWidthAt(g, z) {
      if(!g.taper || z >= g.taper.end) return {min:0,max:g.W};
      const width = Math.max(0, g.W * (z / g.taper.end));
      return {min:(g.W-width)/2,max:(g.W+width)/2};
    },
    floorYAt(g, z) { return g.gn && z < g.gn.len-0.01 ? g.gn.rise : 0; },
    mkIndex() { return {items:[]}; },
    idxAdd(ix, p) { ix.items.push(p); },
    idxNear(ix, z0, z1, out) {
      out.length = 0;
      for(const p of ix.items) if(p.z+p.d >= z0 && p.z <= z1) out.push(p);
      return out;
    },
    boxesOverlapXZ(a,b,gap) {
      return a.x < b.x+b.w+gap && b.x < a.x+a.w+gap && a.z < b.z+b.d+gap && b.z < a.z+a.d+gap;
    },
    boxesOverlapY(a,b) { return a.y < b.y+b.h-0.01 && b.y < a.y+a.h-0.01; },
    JSON, Math, Object, Set, Map, Array
  };
  vm.createContext(sandbox);
  vm.runInContext(instrumented, sandbox, {filename:'load-rules-v2.js'});
  return {packLoad:sandbox.window.packLoad, metrics};
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function step(random, min, max, increment) {
  const count = Math.floor((max-min)/increment) + 1;
  return min + Math.floor(random()*count)*increment;
}

function makeCabinets(count) {
  const random = randomGenerator(0xC0FFEE ^ count);
  const cabinets = [];
  for(let index=0; index<count; index++) {
    const type = index % 10;
    let cab;
    if(type <= 3) {
      cab = {cls:'base', name:'Base cabinet', w:step(random,21,42,3), h:step(random,30,36,1.5), d:step(random,21,27,3), stackOn:true};
    } else if(type <= 5) {
      cab = {cls:'wall', name:'Wall cabinet', w:step(random,18,48,3), h:step(random,24,42,3), d:step(random,12,18,3), stackOn:false};
    } else if(type === 6) {
      cab = {cls:'tall', name:'Tall pantry', w:step(random,18,36,3), h:step(random,78,90,3), d:step(random,21,27,3), stackOn:false};
    } else if(type === 7) {
      cab = {cls:'flat', name:'Finished panel', w:step(random,24,84,6), h:step(random,0.75,1.5,0.75), d:step(random,18,36,3), stackOn:false};
    } else {
      cab = {cls:'pkg', name:'Filler or trim package', w:step(random,6,24,3), h:step(random,3,12,3), d:step(random,24,48,3), stackOn:true};
    }
    cabinets.push(Object.assign(cab, {id:`bench-${count}-${index+1}`, rc:`B${index+1}`}));
  }
  return cabinets;
}

function gooseneckTrailer() {
  return {
    W:96, H:96, totalL:336,
    wells:[
      {x:0, y:0, z:48, w:12, h:14, d:72},
      {x:84, y:0, z:48, w:12, h:14, d:72}
    ],
    ledges:[{x:0, y:0, z:312, w:8, h:96, d:24}],
    gn:{len:72, rise:24, headroom:72},
    taper:null
  };
}

function runWorker(size) {
  const {packLoad, metrics} = loadV2WithCounter();
  const cabinets = makeCabinets(size);
  const started = process.hrtime.bigint();
  const result = packLoad(cabinets, gooseneckTrailer(), {
    gap:0.5, ply:0.5, standMargin:3, allowStack:true, allowBack:true
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    size,
    status:'OK',
    ms:elapsedMs,
    placed:result.placed.length,
    failed:result.failed.length,
    accounted:result.placed.length + result.failed.length,
    canPlace:metrics.canPlace
  };
}

function runParent() {
  const rows = SIZES.map(size => {
    const child = spawnSync(process.execPath, [__filename, '--worker', String(size)], {
      cwd:root,
      encoding:'utf8',
      timeout:PER_SIZE_TIMEOUT_MS,
      maxBuffer:1024*1024
    });
    if(child.error && child.error.code === 'ETIMEDOUT') {
      return {size, status:'TIMEOUT', ms:null, placed:null, failed:null, accounted:null, canPlace:null};
    }
    if(child.status !== 0) {
      return {size, status:'ERROR', ms:null, placed:null, failed:null, accounted:null, canPlace:null, detail:(child.stderr || child.stdout || child.error?.message || 'worker failed').trim()};
    }
    try {
      return JSON.parse(child.stdout);
    } catch(error) {
      return {size, status:'ERROR', ms:null, placed:null, failed:null, accounted:null, canPlace:null, detail:`Invalid worker output: ${child.stdout.trim()}`};
    }
  });

  console.log(`Node ${process.version} | ${process.platform} ${process.arch} | per-size timeout ${PER_SIZE_TIMEOUT_MS} ms`);
  console.log('Synthetic profile: 28 ft gooseneck, two wheel wells, rear door frame; options gap=0.5, ply=0.5, standMargin=3, allowStack=true, allowBack=true.');
  console.log('Items | Status  | Wall ms    | Placed | Failed | Accounted | canPlace calls');
  console.log('------|---------|------------|--------|--------|-----------|---------------');
  for(const row of rows) {
    const ms = row.ms === null ? '—' : row.ms.toFixed(3);
    const placed = row.placed === null ? '—' : String(row.placed);
    const failed = row.failed === null ? '—' : String(row.failed);
    const accounted = row.accounted === null ? '—' : String(row.accounted);
    const calls = row.canPlace === null ? '—' : String(row.canPlace);
    console.log(`${String(row.size).padStart(5)} | ${row.status.padEnd(7)} | ${ms.padStart(10)} | ${placed.padStart(6)} | ${failed.padStart(6)} | ${accounted.padStart(9)} | ${calls.padStart(13)}`);
    if(row.detail) console.log(`      ${row.detail}`);
  }
}

if(process.argv[2] === '--worker') {
  const size = Number(process.argv[3]);
  if(!SIZES.includes(size)) throw new Error(`Unsupported benchmark size: ${process.argv[3]}`);
  process.stdout.write(`${JSON.stringify(runWorker(size))}\n`);
} else {
  runParent();
}
