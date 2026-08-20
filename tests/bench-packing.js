#!/usr/bin/env node
'use strict';

/*
 * Manual V2 packing benchmark. Run with:
 *   node tests/bench-packing.js
 *
 * The harness measures the current working-tree V2 engine and the exact
 * pre-PR #8 engine from main in separate VM sandboxes. Each worker receives
 * the same seeded cabinet job and trailer; this reports per-job placement
 * deltas rather than only aggregate totals.
 */

const {execFileSync, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../load-placement-core.js');

const MAIN_REF = 'abef03fc80ac30fafa224f51b7acef93ee5e4cdc';
const MAIN_ENGINE_BLOB = 'f6ea90993e36a72642b7b5b042d838c504a7539d';
const SIZES = [40, 86, 120, 175, 250];
const GAPS = [0.5, 1];
const CAPACITY_JOBS = [
  {size:110, seeds:[77, 103, 211, 349]},
  {size:140, seeds:[13, 97, 241, 431]}
];
const PER_JOB_TIMEOUT_MS = 20 * 60 * 1000;
const root = path.join(__dirname, '..');
const workingSource = fs.readFileSync(path.join(root, 'load-rules-v2.js'), 'utf8');
const canPlacePattern = /function canPlace\(g,ix,gap,x,y,z,w,h,d,ply,cpose,ccls,ccab,nearIn,standMargin[^)]*\)\{/;

function readMainSource() {
  if(process.env.CLO_MAIN_ENGINE_PATH) return fs.readFileSync(process.env.CLO_MAIN_ENGINE_PATH, 'utf8');
  return execFileSync('git', ['show', `${MAIN_REF}:load-rules-v2.js`], {cwd:root, encoding:'utf8'});
}

function loadV2WithCounter(source, label) {
  const metrics = {canPlace:0};
  const instrumented = source.replace(
    canPlacePattern,
    match => `${match}\n    metrics.canPlace += 1;`
  );
  if(instrumented === source) throw new Error(`Benchmark instrumentation could not locate canPlace() in ${label}.`);

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
  vm.runInContext(instrumented, sandbox, {filename:`${label}-load-rules-v2.js`});
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

function makeCabinets(count, seed) {
  const random = randomGenerator(seed);
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
    cabinets.push(Object.assign(cab, {id:`bench-${count}-${seed}-${index+1}`, rc:`B${index+1}`}));
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

function standardSeed(size) {
  return (0xC0FFEE ^ size) >>> 0;
}

function allJobs() {
  const standard = SIZES.map(size => ({kind:'size', job:`size-${size}`, size, seed:standardSeed(size)}));
  const capacity = CAPACITY_JOBS.flatMap(({size, seeds}) =>
    seeds.map(seed => ({kind:'capacity', job:`capacity-${size}-seed-${seed}`, size, seed}))
  );
  return [...standard, ...capacity];
}

function sourceFor(engine) {
  if(engine === 'main') return readMainSource();
  if(engine === 'working') return workingSource;
  throw new Error(`Unsupported engine: ${engine}`);
}

function runWorker(engine, size, seed, gap, job) {
  const {packLoad, metrics} = loadV2WithCounter(sourceFor(engine), engine);
  const cabinets = makeCabinets(size, seed);
  const started = process.hrtime.bigint();
  const result = packLoad(cabinets, gooseneckTrailer(), {
    gap, ply:0.5, standMargin:3, allowStack:true, allowBack:true
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    job, engine, size, seed, gap, status:'OK', ms:elapsedMs,
    placed:result.placed.length, failed:result.failed.length,
    accounted:result.placed.length + result.failed.length, canPlace:metrics.canPlace
  };
}

function timedWorker(engine, job, gap) {
  const child = spawnSync(process.execPath, [__filename, '--worker', engine, String(job.size), String(job.seed), String(gap), job.job], {
    cwd:root,
    encoding:'utf8',
    timeout:PER_JOB_TIMEOUT_MS,
    maxBuffer:4*1024*1024,
    env:{...process.env, CLO_MAIN_ENGINE_PATH:process.env.CLO_MAIN_ENGINE_PATH || ''}
  });
  if(child.error && child.error.code === 'ETIMEDOUT') {
    return {job:job.job, engine, size:job.size, seed:job.seed, gap, status:'TIMEOUT', ms:null, placed:null, failed:null, accounted:null, canPlace:null};
  }
  if(child.status !== 0) {
    return {job:job.job, engine, size:job.size, seed:job.seed, gap, status:'ERROR', ms:null, placed:null, failed:null, accounted:null, canPlace:null, detail:(child.stderr || child.stdout || child.error?.message || 'worker failed').trim()};
  }
  try {
    return JSON.parse(child.stdout);
  } catch(error) {
    return {job:job.job, engine, size:job.size, seed:job.seed, gap, status:'ERROR', ms:null, placed:null, failed:null, accounted:null, canPlace:null, detail:`Invalid worker output: ${child.stdout.trim()}`};
  }
}

function runParent() {
  const rows = [];
  for(const gap of GAPS) for(const job of allJobs()) for(const engine of ['main','working']) rows.push(timedWorker(engine, job, gap));

  console.log(`Node ${process.version} | ${process.platform} ${process.arch} | per-job timeout ${PER_JOB_TIMEOUT_MS} ms`);
  console.log(`Main engine: ${MAIN_REF} (${MAIN_ENGINE_BLOB}); working engine: load-rules-v2.js from this checkout.`);
  console.log('Synthetic profile: 28 ft gooseneck, two wheel wells, rear door frame; options ply=0.5, standMargin=3, allowStack=true, allowBack=true.');
  console.log('Job                    | Gap | Engine  | Status  | Wall ms    | Placed | Failed | Accounted | canPlace calls');
  console.log('-----------------------|-----|---------|---------|------------|--------|--------|-----------|---------------');
  for(const row of rows) {
    const ms = row.ms === null ? '—' : row.ms.toFixed(3);
    const placed = row.placed === null ? '—' : String(row.placed);
    const failed = row.failed === null ? '—' : String(row.failed);
    const accounted = row.accounted === null ? '—' : String(row.accounted);
    const calls = row.canPlace === null ? '—' : String(row.canPlace);
    console.log(`${row.job.padEnd(23)}| ${String(row.gap).padStart(3)} | ${row.engine.padEnd(8)}| ${row.status.padEnd(8)}| ${ms.padStart(10)} | ${placed.padStart(6)} | ${failed.padStart(6)} | ${accounted.padStart(9)} | ${calls.padStart(13)}`);
    if(row.detail) console.log(`  ${row.detail}`);
  }

  console.log('\nDifferential placement results (working minus main):');
  console.log('Job                    | Gap | Main placed | Working placed | Delta | Status');
  console.log('-----------------------|-----|-------------|----------------|-------|--------');
  for(const gap of GAPS) for(const job of allJobs()) {
    const main = rows.find(row => row.job === job.job && row.gap === gap && row.engine === 'main');
    const working = rows.find(row => row.job === job.job && row.gap === gap && row.engine === 'working');
    const delta = main?.placed === null || working?.placed === null ? '—' : String(working.placed-main.placed);
    const status = main?.status === 'OK' && working?.status === 'OK' ? (Number(delta) >= 0 ? 'PASS' : 'FAIL') : 'UNVERIFIED';
    console.log(`${job.job.padEnd(23)}| ${String(gap).padStart(3)} | ${String(main?.placed ?? '—').padStart(11)} | ${String(working?.placed ?? '—').padStart(14)} | ${delta.padStart(5)} | ${status}`);
  }
  console.log(`\nJSON_RESULTS=${JSON.stringify({mainRef:MAIN_REF, mainBlob:MAIN_ENGINE_BLOB, rows})}`);
}

if(process.argv[2] === '--worker') {
  const [, , , engine, sizeText, seedText, gapText, job] = process.argv;
  const size = Number(sizeText), seed = Number(seedText), gap = Number(gapText);
  if(!Number.isInteger(size) || !Number.isInteger(seed) || !GAPS.includes(gap)) throw new Error('Invalid benchmark worker arguments.');
  process.stdout.write(`${JSON.stringify(runWorker(engine, size, seed, gap, job))}\n`);
} else {
  runParent();
}
