const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const core = require('../load-placement-core.js');
const html = fs.readFileSync(path.join(root, 'cabinet-load-optimizer.html'), 'utf8');
const manual = fs.readFileSync(path.join(root, 'manual-layout.js'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'load-rules-v2.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'packing-runtime.js'), 'utf8');
const learning = fs.readFileSync(path.join(root, 'load-learning.js'), 'utf8');

function rectangularTrailer(height) {
  return { W:96, H:height, totalL:240, wells:[], ledges:[], gn:null, taper:null };
}

function loadLegacyPoseOrder() {
  const sandbox = { window:{ CLOPlacementCore:core }, console:{log(){}, warn(){}, error(){}} };
  vm.createContext(sandbox);
  vm.runInContext(runtime, sandbox, {filename:'packing-runtime.js'});
  return JSON.parse(JSON.stringify(sandbox.window.CLO_LEGACY_POSE_ORDER));
}

function loadV2() {
  const window = {
    CLOPlacementCore: core,
    validatePoseClearance: core.validatePoseClearance,
    CLO_LEGACY_POSE_ORDER: loadLegacyPoseOrder()
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
  return Object.assign(sandbox.window.CLO_RULES_V2, {runtime:sandbox.window});
}

function loadImportGuards() {
  const match = html.match(/const IMPORT_LIMITS = Object\.freeze\([\s\S]*?function hasImportCapacity\(count\)\{[\s\S]*?\n\}/);
  assert.ok(match, 'import guard implementation was found');
  const sandbox = { cabinets:[] };
  vm.createContext(sandbox);
  vm.runInContext(`${match[0]}\nglobalThis.api={IMPORT_LIMITS,importRowsSummary,hasImportCapacity};`, sandbox);
  return sandbox;
}

test('shared tip-up helper rejects the confirmed 24 × 84 × 24 in / 90 in manual-placement regression', () => {
  const cab = { w:24, h:84, d:24 };
  const result = core.validatePoseClearance(cab, 'upright', 0, 90, 3);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TIP_UP_CLEARANCE');
  assert.equal(result.required.toFixed(3), '90.361');
  assert.match(result.message, /needs 90\.4" of tip-up clearance; 90\.0" is available/);
});

test('shared tip-up helper accepts exact and clearly valid upright boundaries and accounts for elevation', () => {
  const cab = { w:24, h:84, d:24 };
  const required = core.uprightTipUpClearance(cab, 0, 3);
  assert.equal(core.validatePoseClearance(cab, 'upright', 0, required, 3).ok, true);
  assert.equal(core.validatePoseClearance(cab, 'upright', 0, 100, 3).ok, true);
  assert.equal(core.validatePoseClearance(cab, 'side', 30, 10, 3).ok, true);
  assert.equal(core.validatePoseClearance(cab, 'upright', 10, 100, 3).ok, false);
});

test('active V2 validator rejects the confirmed manual upright regression and accepts an exact boundary', () => {
  const api = loadV2();
  const cab = { id:'tip-up', w:24, h:84, d:24, stackOn:true, cls:'base' };
  const candidate = { x:0, y:0, z:0, w:24, h:84, d:24, pose:'upright', cls:'base', cab, standMargin:3 };
  const fail = api.validatePlacement(rectangularTrailer(90), 1, candidate, 0.5, {boxes:[]});
  assert.equal(fail.ok, false);
  assert.equal(fail.code, 'TIP_UP_CLEARANCE');
  const exact = api.validatePlacement(rectangularTrailer(core.uprightTipUpClearance(cab, 0, 3)), 1, candidate, 0.5, {boxes:[]});
  assert.equal(exact.ok, true);
});

test('V2 enforces basic trailer geometry, collision clearance, and unsupported-stack rejection', () => {
  const api = loadV2();
  const g = rectangularTrailer(96);
  const cab = {id:'candidate', w:24, h:24, d:24, stackOn:true, cls:'base'};
  const floor = {x:0,y:0,z:0,w:24,h:24,d:24,pose:'side',cls:'base',cab:{id:'support',w:24,h:24,d:24,stackOn:true}};
  const overlapping = Object.assign({}, floor, {cab, pose:'side'});
  const overlapResult = api.validatePlacement(g, 1, overlapping, 0.5, {boxes:[floor]});
  assert.equal(overlapResult.ok, false);
  const unsupported = {x:30,y:30,z:0,w:24,h:24,d:24,pose:'side',cls:'base',cab,standMargin:3};
  const unsupportedResult = api.validatePlacement(g, 1, unsupported, 0.5, {boxes:[floor]});
  assert.equal(unsupportedResult.ok, false);
});

test('V2 enforces V-nose, gooseneck, wheel-well, and rear-door-ledge geometry', () => {
  const api = loadV2();
  const cab = {id:'geometry', w:24, h:24, d:24, stackOn:true, cls:'wall'};
  const candidate = {x:0,y:0,z:10,w:24,h:24,d:24,pose:'side',cls:'wall',cab,standMargin:3};
  const vNose = Object.assign(rectangularTrailer(96), {taper:{end:50}});
  assert.equal(api.validatePlacement(vNose, 1, candidate, 0.5, {boxes:[]}).ok, false);
  const gooseneck = Object.assign(rectangularTrailer(96), {gn:{len:60,rise:24,headroom:72}});
  assert.equal(api.validatePlacement(gooseneck, 1, candidate, 0.5, {boxes:[]}).ok, false);
  const raised = Object.assign({}, candidate, {y:24});
  assert.equal(api.validatePlacement(gooseneck, 1, raised, 0.5, {boxes:[]}).ok, true);
  const wellTrailer = Object.assign(rectangularTrailer(96), {wells:[{x:0,y:0,z:0,w:8,h:12,d:60}]});
  assert.equal(api.validatePlacement(wellTrailer, 1, Object.assign({}, candidate,{z:0}), 0.5, {boxes:[]}).ok, false);
  const ledgeTrailer = Object.assign(rectangularTrailer(96), {ledges:[{x:0,y:0,z:216,w:8,h:96,d:24}]});
  assert.equal(api.validatePlacement(ledgeTrailer, 1, Object.assign({}, candidate,{z:216}), 0.5, {boxes:[]}).ok, false);
});

test('Kemp mirror-frame geometry rejects a free-standing slender upright pose while retaining a stable alternative', () => {
  const api = loadV2();
  const g = rectangularTrailer(96);
  const mirror = {id:'R3CN1',rc:'R3CN1',name:'Mirror Frame',w:25,h:36,d:0.75,stackOn:false,cls:'flat'};
  assert.equal(api.constants.maxFreeStandingSlenderness, 12);
  assert.equal(api.isFreeStandingUprightStable(25,36,0.75), false);
  const upright = {x:0,y:0,z:0,w:25,h:36,d:0.75,pose:'upright',cls:'flat',cab:mirror,standMargin:3};
  assert.equal(api.validatePlacement(g, 1, upright, 0.5, {boxes:[]}).ok, false);
  const side = {x:0,y:0,z:0,w:36,h:25,d:0.75,pose:'side',cls:'flat',cab:mirror,standMargin:3};
  assert.equal(api.validatePlacement(g, 1, side, 0.5, {boxes:[]}).ok, true);
  const deckCab = {id:'elevated-deck',w:80,h:31.375,d:60,stackOn:true,cls:'base'};
  const deck = {x:0,y:0,z:0,w:80,h:31.375,d:60,pose:'upright',cls:'base',cab:deckCab,carrying:0};
  const elevated = {x:0,y:31.875,z:0,w:25,h:36,d:0.75,pose:'upright',cls:'flat',cab:mirror,standMargin:3};
  const elevatedResult = api.validatePlacement(g, 1, elevated, 0.5, {boxes:[deck]});
  assert.equal(elevatedResult.ok, false);
  assert.equal(elevatedResult.code, 'UPRIGHT_SLENDERNESS');
  const reconstructed = api.analyzeLoadState(g, [deck,elevated], 1, 0.5);
  assert.ok(reconstructed.violations.some(v=>v.code==='UPRIGHT_SLENDERNESS' && v.cabinetId==='R3CN1'));
  const normal = {id:'normal-upright',w:24,h:30,d:24,stackOn:true,cls:'base'};
  const normalBox = {x:0,y:0,z:80,w:24,h:30,d:24,pose:'upright',cls:'base',cab:normal,standMargin:3};
  assert.equal(api.validatePlacement(g, 1, normalBox, 0.5, {boxes:[]}).ok, true);
});

test('Kemp wall hutch geometry permits a capped three-level protected face-up stack with padding instruction and automatic discovery', () => {
  const api = loadV2();
  const g = rectangularTrailer(96);
  const baseCab = {id:'deck',w:80,h:24,d:60,stackOn:true,cls:'base'};
  const deck = {x:0,y:0,z:0,w:80,h:24,d:60,pose:'upright',cls:'base',cab:baseCab,carrying:0};
  const lowerCab = {id:'R2C4',rc:'R2C4',name:'Wall Hutch',w:64.625,h:58.25,d:15,stackOn:false,cls:'wall'};
  const middleCab = {id:'R2C9',rc:'R2C9',name:'Wall Hutch',w:64,h:58.25,d:15,stackOn:false,cls:'wall'};
  const upperCab = {id:'R2C6',rc:'R2C6',name:'Wall Hutch',w:57.5,h:58.25,d:15,stackOn:false,cls:'wall'};
  assert.equal(api.mayFormProtectedFaceUpStack(lowerCab, 'wall'), true);
  assert.equal(api.constants.minProtectedFaceUpStackDiscoveryCount, 3);
  const lower = {x:0,y:24.5,z:0,w:64.625,h:15,d:58.25,pose:'back',cls:'wall',cab:lowerCab,faceUpStackLevel:1,carrying:0,standMargin:3};
  assert.equal(api.validatePlacement(g, 1, lower, 0.5, {boxes:[deck]}).ok, true);
  const middle = {x:0,y:40,z:0,w:64,h:15,d:58.25,pose:'back',cls:'wall',cab:middleCab,faceUpStackLevel:2,carrying:0,standMargin:3};
  assert.equal(api.validatePlacement(g, 1, middle, 0.5, {boxes:[deck,lower]}).ok, true);
  const upper = {x:0,y:55.5,z:0,w:57.5,h:15,d:58.25,pose:'back',cls:'wall',cab:upperCab,faceUpStackLevel:3,carrying:0,standMargin:3};
  assert.equal(api.validatePlacement(g, 1, upper, 0.5, {boxes:[deck,lower,middle]}).ok, true);
  const analyzed = api.analyzeLoadState(g, [deck,lower,middle,upper], 1, 0.5);
  assert.equal(analyzed.violations.length, 0);
  assert.ok(analyzed.boxes.filter(p=>p.protectedFaceUpStack).length >= 3);
  assert.match(api.runtime.poseText(Object.assign({}, upper, {protectedFaceUpStack:true})), /PAD \/ BLANKET BETWEEN CABINETS/);
  const fourth = Object.assign({}, upper, {y:71, faceUpStackLevel:4, cab:{id:'fourth',w:56,h:58.25,d:15,cls:'wall'}});
  assert.equal(api.validatePlacement(g, 1, fourth, 0.5, {boxes:[deck,lower,middle,upper]}).ok, false);

  const result = api.runtime.packLoad([baseCab,lowerCab,middleCab,upperCab], g, {gap:1,ply:0.5,allowStack:true,allowBack:true,standMargin:3});
  const faceUp = result.placed.filter(p=>p.pose==='back' && p.cls==='wall');
  assert.equal(faceUp.length, 3);
  assert.equal(faceUp.filter(p=>p.protectedFaceUpStack).length, 3);
  assert.equal(result.failed.length, 0);

  const ordinaryPair = api.runtime.packLoad([baseCab,lowerCab,middleCab], g, {gap:1,ply:0.5,allowStack:true,allowBack:true,standMargin:3});
  assert.equal(ordinaryPair.placed.some(p=>p.protectedFaceUpStack), false);
});

test('protected face-up discovery is atomic when three shallow candidates cannot form a legal stack', () => {
  const api = loadV2();
  const g = rectangularTrailer(96);
  const base = {id:'deck',w:80,h:24,d:60,stackOn:true,cls:'base'};
  const candidates = [
    {id:'candidate-a',w:64.625,h:58.25,d:15,stackOn:false,cls:'wall'},
    {id:'candidate-b',w:64,h:58.25,d:15,stackOn:false,cls:'wall'},
    {id:'candidate-c',w:40,h:58.25,d:15,stackOn:false,cls:'wall'}
  ];
  assert.equal(candidates.every(c=>api.mayFormProtectedFaceUpStack(c, c.cls)), true);
  const result = api.runtime.packLoad([base,...candidates], g, {gap:1,ply:0.5,allowStack:true,allowBack:true,standMargin:3});
  const candidatePlacements = result.placed.filter(p=>candidates.includes(p.cab));
  assert.equal(candidatePlacements.length, 3);
  assert.equal(candidatePlacements.some(p=>p.protectedFaceUpStack), false);
  assert.equal(candidatePlacements.some(p=>p.pose==='back'), false);
  assert.equal(result.failed.length, 0);
});

test('V2 enforces 60% support, plywood height, and forward restraint', () => {
  const api = loadV2();
  const g = rectangularTrailer(96);
  const support = {x:0,y:0,z:0,w:24,h:24,d:100,pose:'side',cls:'base',cab:{id:'deck',w:24,h:24,d:100,stackOn:true}};
  const cab = {id:'upper',w:24,h:20,d:24,stackOn:true,cls:'wall'};
  const supported = {x:0,y:24.5,z:20,w:24,h:20,d:24,pose:'side',cls:'wall',cab,standMargin:3};
  assert.equal(api.validatePlacement(g, 1, supported, 0.5, {boxes:[support]}).ok, true);
  const partial = Object.assign({}, supported, {x:11});
  assert.equal(api.validatePlacement(g, 1, partial, 0.5, {boxes:[support]}).ok, false);
  const noForwardDeck = Object.assign({}, support, {z:20,d:24});
  assert.equal(api.validatePlacement(g, 1, supported, 0.5, {boxes:[noForwardDeck]}).ok, false);
  const wrongPlywood = Object.assign({}, supported, {y:26});
  assert.equal(api.validatePlacement(g, 1, wrongPlywood, 0.5, {boxes:[support]}).ok, false);
});

test('V2 keeps real face-up cabinets off the floor and enforces both explicit door-rider thresholds, capacity, bulk, and no further stacking', () => {
  const api = loadV2();
  const g = rectangularTrailer(96);
  assert.equal(api.constants.doorRiderSupport, 0.85);
  assert.equal(api.constants.doorBankCoverage, 0.85);
  assert.equal(Object.hasOwn(api.constants, 'doorCover'), false);

  const faceCab = {id:'face',w:30,h:30,d:24,stackOn:false,cls:'wall'};
  const faceUp = {x:0,y:0,z:0,w:30,h:24,d:30,pose:'back',cls:'wall',cab:faceCab,carrying:0};
  const upperCab = {id:'upper',w:30,h:10,d:30,stackOn:false,cls:'wall'};
  const floorFaceUp = {x:40,y:0,z:0,w:30,h:24,d:30,pose:'back',cls:'wall',cab:faceCab,standMargin:3};
  assert.equal(api.validatePlacement(g, 1, floorFaceUp, 0.5, {boxes:[]}).ok, false);

  const qualifying = {x:0,y:24.5,z:0,w:30,h:10,d:30,pose:'side',cls:'wall',cab:upperCab,standMargin:3};
  assert.equal(api.validatePlacement(g, 1, qualifying, 0.5, {boxes:[faceUp]}).ok, true);

  // The underlying door bank is fully covered, but only 30/36 = 83.3% of the rider is supported.
  const insufficientRiderSupport = Object.assign({}, qualifying, {w:36});
  assert.equal(api.validatePlacement(g, 1, insufficientRiderSupport, 0.5, {boxes:[faceUp]}).ok, false);

  // Jesse's explicit shop rule: 24 × 30 on a 30 × 30 door bank is 100% supported
  // as a rider but covers only 80% of the door bank, so it must fail independently.
  const insufficientDoorBankCoverage = Object.assign({}, qualifying, {w:24});
  assert.equal(api.validatePlacement(g, 1, insufficientDoorBankCoverage, 0.5, {boxes:[faceUp]}).ok, false);

  const stateForNarrowRider = api.analyzeLoadState(g, [faceUp, insufficientDoorBankCoverage], 1, 0.5);
  assert.ok(stateForNarrowRider.violations.some(v => v.code==='DOOR_BANK_COVERAGE'));
  const stateForWideRider = api.analyzeLoadState(g, [faceUp, insufficientRiderSupport], 1, 0.5);
  assert.ok(stateForWideRider.violations.some(v => v.code==='DOOR_RIDER_SUPPORT'));

  const bulky = Object.assign({}, qualifying, {cab:{id:'bulky',w:40,h:40,d:40}, cls:'base', pose:'upright'});
  assert.equal(api.validatePlacement(g, 1, bulky, 0.5, {boxes:[faceUp]}).ok, false);
  const occupiedDoorBank = Object.assign({}, faceUp, {carrying:1});
  assert.equal(api.validatePlacement(g, 1, qualifying, 0.5, {boxes:[occupiedDoorBank]}).ok, false);
  const onDoors = Object.assign({}, qualifying, {onDoors:true});
  const above = {x:0,y:35,z:0,w:30,h:10,d:30,pose:'side',cls:'wall',cab:upperCab,standMargin:3};
  assert.equal(api.validatePlacement(g, 1, above, 0.5, {boxes:[faceUp,onDoors]}).ok, false);
});

test('V2 accounts for every item in a 220-piece synthetic packing sanity fixture', () => {
  const api = loadV2();
  const cabinets = Array.from({length:220}, (_, index) => ({
    id:`perf-${index}`, rc:`R1C${index+1}`, name:'Fixture cabinet', w:12, h:12, d:12,
    stackOn:true, isPkg:true
  }));
  const result = api.runtime.packLoad(cabinets, rectangularTrailer(96), {
    gap:1, ply:0.5, allowStack:true, allowBack:true, standMargin:3
  });
  assert.equal(result.placed.length + result.failed.length, cabinets.length);
});

test('Manual Layout calls the same active V2 validation bridge used by the current packer', () => {
  assert.match(manual, /api\.validatePlacement\(g,gap,candidate,ply,state\)/);
  assert.match(manual, /validatePoseClearance\(box\.cab, box\.pose, box\.y, g\.H, curSC\(\)\)/);
  assert.doesNotMatch(manual, /if\(rep\) return legacy/);
});

test('import guardrails reject zero, negative, fractional, excessive quantities and extreme dimensions', () => {
  const sandbox = loadImportGuards();
  const {importRowsSummary, IMPORT_LIMITS} = sandbox.api;
  const normal = importRowsSummary([{rc:'R1C1',qty:2,w:24,h:34.5,d:24}]);
  assert.deepEqual(JSON.parse(JSON.stringify(normal)), {ok:true,total:2,errors:[]});
  for(const qty of [0,-1,1.5,IMPORT_LIMITS.maxPerRow+1]) {
    assert.equal(importRowsSummary([{rc:'R1C1',qty,w:24,h:34.5,d:24}]).ok, false, `qty ${qty} is rejected`);
  }
  assert.equal(importRowsSummary([{rc:'R1C1',qty:1,w:IMPORT_LIMITS.maxDimension+1,h:34.5,d:24}]).ok, false);
  assert.equal(importRowsSummary([{rc:'R1C1',qty:IMPORT_LIMITS.maxItems+1,w:24,h:34.5,d:24}]).ok, false);
});

test('import guardrails cap the current job as well as each import batch', () => {
  const sandbox = loadImportGuards();
  sandbox.cabinets = Array.from({length:2400}, () => ({}));
  assert.equal(sandbox.api.hasImportCapacity(100), true);
  assert.equal(sandbox.api.hasImportCapacity(101), false);
});

test('clear hand placements persists immediately and all user-controlled plan/warning sinks escape text', () => {
  assert.match(manual, /function clearHandPlacements\(\)[\s\S]*?saveAll\(\);[\s\S]*?refreshAll\(\);/);
  assert.match(html, /<b>\$\{esc\(numLabel\)\}<\/b>/);
  assert.match(manual, /\$\{esc\(p\.warn\)\}/);
  const hostile = '<img src=x onerror=alert(1)>';
  const escaped = require('../clo-utils.js').escapeHtmlText(hostile);
  assert.equal(escaped, '&lt;img src=x onerror=alert(1)&gt;');
  assert.doesNotMatch(escaped, /<img/);
});

test('the fallback and active V2 pose-order copies stay identical and diagnostics expose V2 as active', () => {
  const api = loadV2();
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.runtime.CLO_LEGACY_POSE_ORDER)),
    JSON.parse(JSON.stringify(api.poseOrder))
  );
  assert.match(rules, /window\.CLO_ACTIVE_ENGINE = 'v2'/);
  assert.match(rules, /setEngineStatus\('Packing rules: V2 active'/);
  assert.match(learning, /POSE_ORDER\.\$\{cls\} in load-rules-v2\.js/);
});

test('main inline application script compiles after the safety changes', () => {
  const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(source => source.trim());
  assert.equal(inline.length, 1);
  assert.doesNotThrow(() => new Function(inline[0]));
});

test('static deployment mode has no default settings API endpoint', () => {
  assert.match(html, /const SETTINGS_URL = typeof window\.CLO_SETTINGS_URL === 'string' \? window\.CLO_SETTINGS_URL\.trim\(\) : '';/);
  assert.match(html, /if\(!SETTINGS_URL\)\{ syncStatus\('Saved in this browser'\); done\(\); return; \}/);
});
