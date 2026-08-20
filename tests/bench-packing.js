'use strict';

/*
 * Manual packing-runtime differential. Run with:
 *   node tests/bench-packing.js
 *
 * The harness executes the preserved pre-refactor runtime plus its V2 rules and
 * the current extracted runtime plus its V2 rules in isolated VM sandboxes.
 * Every row compares the full ordered placement record, not only counts.
 */

const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../load-placement-core.js');

const MAIN_REF = '56d83cfb1204677276f4b2b9bf9b90c6d6213892';
const PRE_REFACTOR_ENGINE_BLOB = '8ca41c414cb9f901da57a47abf27cfac7358ebb6';
const PRE_REFACTOR_HTML_BLOB = 'b2d950c41fbf88dc8308d2c83784f9e58a1c3135';
const SIZES = [40, 86, 120, 175, 250];
const GAPS = [0.5, 1];
const CAPACITY_JOBS = [
  {size:110, seeds:[77, 103, 211, 349]},
  {size:140, seeds:[13, 97, 241, 431]}
];
const PER_JOB_TIMEOUT_MS = 20 * 60 * 1000;
const root = path.join(__dirname, '..');
const preservedRoot = process.env.CLO_PRE_REFACTOR_DIR || '/home/ubuntu/packing-worker-baseline';
const currentRuntime = fs.readFileSync(path.join(root, 'packing-runtime.js'), 'utf8');
const currentRules = fs.readFileSync(path.join(root, 'load-rules-v2.js'), 'utf8');
const canPlacePattern = /function canPlace\(g,ix,gap,x,y,z,w,h,d,ply,cpose,ccls,ccab,nearIn,standMargin[^)]*\)\{/;

function preservedFile(name) {
  const file = path.join(preservedRoot, name);
  if(!fs.existsSync(file)) throw new Error(`Preserved pre-refactor source is required: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function extractPreRefactorRuntime(html) {
  const clearance = html.match(/function validatePoseClearance\(cab, pose, y, trailerHeight, standMargin\)\{[\s\S]*?\n\}/);
  const start = html.indexOf('function fmtDim(v)');
  const end = html.indexOf('\nfunction optimize()', start);
  if(!clearance || start < 0 || end < 0) throw new Error('Could not locate the preserved pre-refactor packing runtime closure.');
  return `${clearance[0]}\n${html.slice(start, end)}`;
}

const preRuntime = extractPreRefactorRuntime(preservedFile('cabinet-load-optimizer.pre.html'));
const preRules = preservedFile('load-rules-v2.pre.js');

function sourceFor(engine) {
  if(engine === 'pre') return {runtime:preRuntime, rules:preRules};
  if(engine === 'working') return {runtime:currentRuntime, rules:currentRules};
  throw new Error(`Unsupported engine: ${engine}`);
}

function loadEngine(engine) {
  const source = sourceFor(engine);
  const metrics = {canPlace:0};
  const instrumentedRules = source.rules.replace(canPlacePattern, match => `${match}\n    metrics.canPlace += 1;`);
  if(instrumentedRules === source.rules) throw new Error(`Benchmark instrumentation could not locate canPlace() in ${engine}.`);
  const window = {CLOPlacementCore:core, validatePoseClearance:core.validatePoseClearance};
  const sandbox = {
    console:{log(){}, warn(){}, error(){}}, window, metrics,
    document:{dispatchEvent(){}}, CustomEvent:function CustomEvent(){},
    JSON, Math, Object, Set, Map, Array
  };
  vm.createContext(sandbox);
  vm.runInContext(source.runtime, sandbox, {filename:`${engine}-packing-runtime.js`});
  vm.runInContext(instrumentedRules, sandbox, {filename:`${engine}-load-rules-v2.js`});
  if(sandbox.window.CLO_ACTIVE_ENGINE !== 'v2') throw new Error(`${engine} did not activate V2.`);
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
    if(type <= 3) cab = {cls:'base', name:'Base cabinet', w:step(random,21,42,3), h:step(random,30,36,1.5), d:step(random,21,27,3), stackOn:true};
    else if(type <= 5) cab = {cls:'wall', name:'Wall cabinet', w:step(random,18,48,3), h:step(random,24,42,3), d:step(random,12,18,3), stackOn:false};
    else if(type === 6) cab = {cls:'tall', name:'Tall pantry', w:step(random,18,36,3), h:step(random,78,90,3), d:step(random,21,27,3), stackOn:false};
    else if(type === 7) cab = {cls:'flat', name:'Finished panel', w:step(random,24,84,6), h:step(random,0.75,1.5,0.75), d:step(random,18,36,3), stackOn:false};
    else cab = {cls:'pkg', name:'Filler or trim package', w:step(random,6,24,3), h:step(random,3,12,3), d:step(random,24,48,3), stackOn:true};
    cabinets.push(Object.assign(cab, {id:`bench-${count}-${seed}-${index+1}`, rc:`B${index+1}`}));
  }
  return cabinets;
}

function gooseneckTrailer() {
  return {
    W:96, H:96, totalL:336,
    wells:[{x:0, y:0, z:48, w:12, h:14, d:72}, {x:84, y:0, z:48, w:12, h:14, d:72}],
    ledges:[{x:0, y:0, z:312, w:8, h:96, d:24}],
    gn:{len:72, rise:24, headroom:72}, taper:null
  };
}

function standardSeed(size) { return (0xC0FFEE ^ size) >>> 0; }
function allJobs() {
  const standard = SIZES.map(size => ({kind:'size', job:`size-${size}`, size, seed:standardSeed(size)}));
  const capacity = CAPACITY_JOBS.flatMap(({size, seeds}) => seeds.map(seed => ({kind:'capacity', job:`capacity-${size}-seed-${seed}`, size, seed})));
  return [...standard, ...capacity];
}

function placementRecords(placed) {
  return placed.map(p => ({cabinetId:p.cab.id, x:p.x, y:p.y, z:p.z, pose:p.pose}));
}

function firstPlacementDifference(pre, working) {
  const count = Math.max(pre.length, working.length);
  for(let index=0; index<count; index++) {
    if(JSON.stringify(pre[index]) !== JSON.stringify(working[index])) return {index, pre:pre[index] || null, working:working[index] || null};
  }
  return null;
}

function runWorker(engine, size, seed, gap, job) {
  const {packLoad, metrics} = loadEngine(engine);
  const cabinets = makeCabinets(size, seed);
  const started = process.hrtime.bigint();
  const result = packLoad(cabinets, gooseneckTrailer(), {gap, ply:0.5, standMargin:3, allowStack:true, allowBack:true});
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    job, engine, size, seed, gap, status:'OK', ms:elapsedMs,
    placed:result.placed.length, failed:result.failed.length,
    accounted:result.placed.length + result.failed.length, canPlace:metrics.canPlace,
    placements:placementRecords(result.placed)
  };
}

function errorRow(engine, job, gap, status, detail) {
  return {job:job.job, engine, size:job.size, seed:job.seed, gap, status, ms:null, placed:null, failed:null, accounted:null, canPlace:null, placements:null, detail};
}

function timedWorker(engine, job, gap) {
  const child = spawnSync(process.execPath, [__filename, '--worker', engine, String(job.size), String(job.seed), String(gap), job.job], {
    cwd:root, encoding:'utf8', timeout:PER_JOB_TIMEOUT_MS, maxBuffer:8*1024*1024,
    env:{...process.env, CLO_PRE_REFACTOR_DIR:preservedRoot}
  });
  if(child.error && child.error.code === 'ETIMEDOUT') return errorRow(engine, job, gap, 'TIMEOUT', 'per-job timeout');
  if(child.status !== 0) return errorRow(engine, job, gap, 'ERROR', (child.stderr || child.stdout || child.error?.message || 'worker failed').trim());
  try { return JSON.parse(child.stdout); }
  catch(error) { return errorRow(engine, job, gap, 'ERROR', `Invalid worker output: ${child.stdout.trim()}`); }
}

function runParent() {
  const rows = [];
  for(const gap of GAPS) for(const job of allJobs()) for(const engine of ['pre','working']) rows.push(timedWorker(engine, job, gap));
  console.log(`Node ${process.version} | ${process.platform} ${process.arch} | per-job timeout ${PER_JOB_TIMEOUT_MS} ms`);
  console.log(`Preserved pre-refactor engine: ${PRE_REFACTOR_ENGINE_BLOB}; preserved HTML: ${PRE_REFACTOR_HTML_BLOB}; working runtime: packing-runtime.js.`);
  console.log('Synthetic profile: 28 ft gooseneck, two wheel wells, rear door frame; options ply=0.5, standMargin=3, allowStack=true, allowBack=true.');
  console.log('Job                    | Gap | Engine  | Status  | Wall ms    | Placed | Failed | Accounted | canPlace calls');
  console.log('-----------------------|-----|---------|---------|------------|--------|--------|-----------|---------------');
  for(const row of rows) {
    const ms = row.ms === null ? '—' : row.ms.toFixed(3);
    console.log(`${row.job.padEnd(23)}| ${String(row.gap).padStart(3)} | ${row.engine.padEnd(8)}| ${row.status.padEnd(8)}| ${ms.padStart(10)} | ${String(row.placed ?? '—').padStart(6)} | ${String(row.failed ?? '—').padStart(6)} | ${String(row.accounted ?? '—').padStart(9)} | ${String(row.canPlace ?? '—').padStart(13)}`);
    if(row.detail) console.log(`  ${row.detail}`);
  }
  console.log('\nFull placement-record differential (working versus preserved pre-refactor):');
  console.log('Job                    | Gap | Placement records | Status');
  console.log('-----------------------|-----|-------------------|--------');
  for(const gap of GAPS) for(const job of allJobs()) {
    const pre = rows.find(row => row.job === job.job && row.gap === gap && row.engine === 'pre');
    const working = rows.find(row => row.job === job.job && row.gap === gap && row.engine === 'working');
    const difference = pre?.status === 'OK' && working?.status === 'OK' ? firstPlacementDifference(pre.placements, working.placements) : null;
    const status = pre?.status === 'OK' && working?.status === 'OK' ? (difference ? 'FAIL' : 'PASS') : 'UNVERIFIED';
    console.log(`${job.job.padEnd(23)}| ${String(gap).padStart(3)} | ${String(pre?.placements?.length ?? '—').padStart(17)} | ${status}`);
    if(difference) console.log(`  first difference at index ${difference.index}: pre=${JSON.stringify(difference.pre)} working=${JSON.stringify(difference.working)}`);
  }
  console.log(`\nJSON_RESULTS=${JSON.stringify({mainRef:MAIN_REF, preRefactorEngineBlob:PRE_REFACTOR_ENGINE_BLOB, preRefactorHtmlBlob:PRE_REFACTOR_HTML_BLOB, rows})}`);
}

if(process.argv[2] === '--worker') {
  const [, , , engine, sizeText, seedText, gapText, job] = process.argv;
  const size = Number(sizeText), seed = Number(seedText), gap = Number(gapText);
  if(!Number.isInteger(size) || !Number.isInteger(seed) || !GAPS.includes(gap)) throw new Error('Invalid benchmark worker arguments.');
  process.stdout.write(`${JSON.stringify(runWorker(engine, size, seed, gap, job))}\n`);
} else {
  runParent();
}
