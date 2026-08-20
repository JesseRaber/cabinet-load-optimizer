/* Load-integrity invariants.

   These are the "a plan the crew can actually follow" checks. They exist
   because the 220-piece sanity fixture in behavioral-safety.test.js is built
   from identical 12" cubes flagged isPkg, which never reach the protected
   face-up stack pass — so it cannot see a bug that lives in that pass.

   The regression these guard: the staged protected face-up stack committed
   EVERY cabinet it had placed, but reported back only the ones flagged
   protectedFaceUpStack. The unflagged remainder stayed eligible for the later
   passes and were placed a SECOND time, in a second pose, at a second
   location. The printed plan told the crew to load one cabinet twice, and the
   loaded count read higher than the number of cabinets in the job. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const core = require('../load-placement-core.js');
const rules = fs.readFileSync(path.join(root, 'load-rules-v2.js'), 'utf8');

function loadV2() {
  const window = {
    CLOPlacementCore: core,
    validatePoseClearance: core.validatePoseClearance
  };
  const sandbox = {
    console: { log(){}, warn(){}, error(){} }, window,
    document: { dispatchEvent(){} }, CustomEvent: function CustomEvent(){},
    packLoad(){}, geomOf(){},
    cabClass(cab) { return cab.cls || 'base'; },
    availWidthAt(g, z) {
      if(!g.taper || z >= g.taper.end) return {min:0,max:g.W};
      const width=Math.max(0,g.W*(z/g.taper.end));
      return {min:(g.W-width)/2,max:(g.W+width)/2};
    },
    floorYAt(g, z) { return g.gn && z < g.gn.len-0.01 ? g.gn.rise : 0; },
    mkIndex() { return {items:[]}; },
    idxAdd(ix, p) { ix.items.push(p); },
    idxNear(ix, z0, z1, out) { out.length=0; for(const p of ix.items) if(p.z+p.d>=z0 && p.z<=z1) out.push(p); return out; },
    boxesOverlapXZ(a,b,gap) { return a.x < b.x+b.w+gap && b.x < a.x+a.w+gap && a.z < b.z+b.d+gap && b.z < a.z+a.d+gap; },
    boxesOverlapY(a,b) { return a.y < b.y+b.h-0.01 && b.y < a.y+a.h-0.01; },
    JSON, Math, Object, Set, Map, Array
  };
  vm.createContext(sandbox);
  vm.runInContext(rules, sandbox, {filename:'load-rules-v2.js'});
  return sandbox.window;
}

/* A job shaped to reach the protected face-up stack pass: a solid base deck to
   build on, plus enough shallow wall cabinets to clear
   minProtectedFaceUpStackDiscoveryCount. Identical cubes will not do it. */
function faceUpStackJob() {
  const job = [];
  for(let i=0;i<6;i++)
    job.push({id:`base-${i}`, rc:`R1C${i+1}`, name:'Base Cab', cls:'base',
              w:30, h:34.5, d:24, stackOn:true});
  for(let i=0;i<10;i++)
    job.push({id:`wall-${i}`, rc:`R2C${i+1}`, name:'Wall Cab', cls:'wall',
              w:30, h:42, d:13, stackOn:false});
  return job;
}

const TRAILER = { W:96, H:102, totalL:240, wells:[], ledges:[], gn:null, taper:null };
const OPT = { gap:0.5, ply:0.5, standMargin:3, allowStack:true, allowBack:true };

function runPack(overrides) {
  const api = loadV2();
  const job = faceUpStackJob();
  const result = api.packLoad(job.map(c => ({...c})), TRAILER,
                              Object.assign({}, OPT, overrides || {}));
  return { job, result };
}

test('no cabinet is placed more than once', () => {
  const { result } = runPack();
  const ids = result.placed.map(p => p.cab.id);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(duplicates, [],
    `these cabinets appear at more than one position in the plan: ${duplicates.join(', ')}`);
});

test('the loaded count never exceeds the number of cabinets in the job', () => {
  const { job, result } = runPack();
  assert.ok(result.placed.length <= job.length,
    `placed ${result.placed.length} of a ${job.length}-item job`);
});

test('every cabinet is either placed or reported as not fitting, exactly once', () => {
  const { job, result } = runPack();
  const placedIds = result.placed.map(p => p.cab.id);
  const failedIds = result.failed.map(c => c.id);
  const accounted = [...placedIds, ...failedIds];

  assert.equal(accounted.length, job.length,
    'each cabinet is accounted for exactly once across placed and failed');
  assert.deepEqual([...new Set(accounted)].sort(), job.map(c => c.id).sort(),
    'the accounted set is exactly the input set');

  /* packLoad() builds its arrays inside the vm sandbox, so they carry that
     realm's Array.prototype. assert/strict compares prototypes, so anything
     coming back from the engine is copied into this realm before comparison. */
  const both = Array.from(placedIds.filter(id => failedIds.includes(id)));
  assert.deepEqual(both, [], 'no cabinet is reported as both placed and not fitting');
});

/* The bug only appeared with stacking and face-up both enabled, so pin the
   invariant across the option combinations the app can actually produce. */
for(const [label, overrides] of [
  ['stacking and face-up enabled', {}],
  ['face-up disabled',             {allowBack:false}],
  ['stacking disabled',            {allowStack:false}],
  ['door decks disabled',          {allowDoorDeck:false}]
]) {
  test(`load integrity holds with ${label}`, () => {
    const { job, result } = runPack(overrides);
    const ids = result.placed.map(p => p.cab.id);
    assert.deepEqual([...new Set(ids.filter((id,i) => ids.indexOf(id) !== i))], [],
      'no duplicate placements');
    assert.equal(result.placed.length + result.failed.length, job.length,
      'every cabinet accounted for');
  });
}

test('placed boxes do not overlap each other', () => {
  const { result } = runPack();
  const span = (a0,a1,b0,b1) => Math.max(0, Math.min(a1,b1) - Math.max(a0,b0));
  const collisions = [];
  const P = result.placed;
  for(let i=0;i<P.length;i++) for(let j=i+1;j<P.length;j++) {
    const a=P[i], b=P[j];
    const v = span(a.x,a.x+a.w,b.x,b.x+b.w)
            * span(a.y,a.y+a.h,b.y,b.y+b.h)
            * span(a.z,a.z+a.d,b.z,b.z+b.d);
    if(v > 0.5) collisions.push(`${a.cab.rc}/${b.cab.rc}`);
  }
  assert.deepEqual(collisions, [], `overlapping placements: ${collisions.join(', ')}`);
});
