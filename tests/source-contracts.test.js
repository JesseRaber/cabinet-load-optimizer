const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('manual commits enforce V2 validation before mutating the layout', () => {
  const source = read('manual-layout.js');
  const body = source.slice(source.indexOf('function commit('), source.indexOf('function takeOut('));
  assert.match(body, /const validation=v2Check\(/);
  assert.match(body, /if\(!validation\.ok\)/);
  assert.ok(body.indexOf('if(!validation.ok)') < body.indexOf('pushUndo('));
});

test('2D drag cleans up pointer-up and pointer-cancel listeners', () => {
  const source = read('manual-layout.js');
  assert.match(source, /addEventListener\('pointercancel', onDragCancel\)/);
  assert.match(source, /removeEventListener\('pointercancel', onDragCancel\)/);
  assert.match(source, /evt\.pointerId!==d\.pointerId/);
});

test('3D drag reuses one ghost mesh instead of allocating on every move', () => {
  const source = read('drag-3d.js');
  const paint = source.slice(source.indexOf('function paintGhost('), source.indexOf('function finish('));
  assert.doesNotMatch(paint, /new THREE\.BoxGeometry/);
  assert.match(paint, /ghostMesh\.scale\.set/);
});

test('replaced 3D load groups are disposed', () => {
  const source = read('cabinet-load-optimizer.html');
  assert.match(source, /scene\.remove\(loadGroup\); dispose3DObject\(loadGroup\)/);
});

test('Load Stats collapse is reversible, session-persistent, data-preserving, and does not alter the load or camera', () => {
  const source = read('cabinet-load-optimizer.html');
  assert.match(source, /id="load-stats-toggle"/);
  assert.match(source, /id="load-stats-body"/);
  assert.match(source, /aria-controls="load-stats-body"/);
  assert.match(source, /const LOAD_STATS_COLLAPSED_KEY = 'clo\.load-stats-collapsed';/);
  assert.match(source, /sessionStorage\.setItem\(LOAD_STATS_COLLAPSED_KEY/);
  assert.match(source, /body\.classList\.toggle\('hidden', !!collapsed\)/);
  assert.match(source, /glyph\.textContent=collapsed \? '▸' : '▾'/);
  assert.match(source, /id="s-trailer"/);
  assert.match(source, /id="s-loaded"/);
  assert.match(source, /id="s-failed"/);
  const toggle = source.slice(source.indexOf('function setLoadStatsCollapsed('), source.indexOf('function updateStats('));
  assert.doesNotMatch(toggle, /\b(optimize|draw3D|resize3D|packLoad)\s*\(/);
});
