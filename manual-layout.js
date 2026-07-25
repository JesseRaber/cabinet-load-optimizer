/* ============================================================================
   manual-layout.js — Manual placement, pinning and re-arranging
   Add-on for the Cabinet Load Optimizer.

   Load this AFTER the app's inline <script>:
       <script src="manual-layout.js"></script>

   What it adds
     • A "Manual Layout" tab: a top-view plan of the trailer you can drag in.
     • Drag a cabinet or package straight out of the list into the trailer.
     • Drag anything already in the trailer to a new spot, rotate it, change how
       it lies, move it up onto the plywood layer.
     • Anything you place by hand is PINNED (📌). Pressing Optimize Load packs
       every remaining cabinet around the pinned ones without moving them.

   Nothing in the original file is deleted — this module replaces optimize(),
   showTab(), loadingOrderHTML() and decorates draw3D(), renderCabs() and
   plansHTML() at run time. Delete the script tag to go back to stock.
   ============================================================================ */
'use strict';
(function(){

const PAD = 30;                 // svg padding, in svg units
const SVG_LEN = 900;            // trailer length maps to this many svg units

/* Editor state. `sel` is what the toolbar and keyboard act on:
     {kind:'list', cab}    an item not in the trailer yet
     {kind:'placed', cab}  an item currently in the trailer          */
const M = {
  snap: 1, magnet: true, layer: 'all',
  sel: null, drag: null, msg: '', msgKind: 'info',
  pose: 'back', rot: false,        // pose used for the next item off the list
  svg: null, sc: 1, g: null, t: null
};

/* ============ small helpers ============ */
const rnd = v => Math.round(v*100)/100;
const curGap  = () => Math.max(0.25, parseFloat(el('gap').value)||1);
const curPly  = () => el('allow-stack').checked ? Math.max(0, parseFloat(el('plywood').value)||0) : 0;
const curSC   = () => { const v = parseFloat(el('stand-clear').value); return isNaN(v)?3:Math.max(0,v); };
const activeTrailer = () => trailers.find(t=>t.id===activeTrailerId);
const pinned = () => cabinets.filter(c=>c.pin);
const POSES = ['back','side','upright'];
const POSE_SHORT = { back:'BACK', side:'SIDE', upright:'UP' };

/* Which face is down, and therefore which dimension is vertical. Mirrors
   flatPoses()/uprightPoses() in the app exactly so a hand-placed cabinet and an
   auto-placed one of the same pose occupy the same box. */
function poseBox(cab, pose, rot){
  if(pose==='back') return rot ? {w:cab.h, h:cab.d, d:cab.w} : {w:cab.w, h:cab.d, d:cab.h};
  if(pose==='side') return rot ? {w:cab.d, h:cab.w, d:cab.h} : {w:cab.h, h:cab.w, d:cab.d};
  return              rot ? {w:cab.d, h:cab.h, d:cab.w} : {w:cab.w, h:cab.h, d:cab.d};
}
function pinBox(cab){
  const b = poseBox(cab, cab.pin.pose, cab.pin.rot);
  return { x:cab.pin.x, y:cab.pin.y, z:cab.pin.z, w:b.w, h:b.h, d:b.d,
           pose:cab.pin.pose, rot:cab.pin.rot, cab, pinned:true };
}
function boxOf(cab){ return results ? results.placed.find(p=>p.cab.id===cab.id) : null; }
function inTrailer(cab){ return !!boxOf(cab); }
function overlapArea(a,b){
  const ox = Math.max(0, Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x,b.x));
  const oz = Math.max(0, Math.min(a.z+a.d, b.z+b.d) - Math.max(a.z,b.z));
  return ox*oz;
}

/* ============ validity, with plain-English reasons ============ */
/* Same rules as the packer's canPlace(), but it tells you what is wrong so the
   status bar can say "hits the wheel well" instead of just refusing. */
function checkPlace(g, others, gap, box, ply){
  const eps = 0.01, why = [];
  const {x,y,z,w,h,d} = box;
  if(x < -eps || z < -eps)      why.push('past the front/left wall');
  if(y + h > g.H + eps)         why.push('taller than the ceiling');
  if(z + d > g.totalL + eps)    why.push('sticks out the rear doors');
  if(g.gn){
    const inGN = z < g.gn.len - eps;
    if(inGN && z + d > g.gn.len + eps) why.push('straddles the gooseneck step');
    else if(inGN && y < g.gn.rise - eps) why.push('below the gooseneck deck');
  }
  const wr = availWidthAt(g, z);
  if(x < wr.min - eps || x + w > wr.max + eps) why.push('through a side wall / the V-nose');
  const b = {x,y,z,w,h,d};
  for(const wl of g.wells) if(boxesOverlapXZ(b,wl,0) && boxesOverlapY(b,wl)){ why.push('hits a wheel well'); break; }
  if(g.ledges) for(const ob of g.ledges) if(boxesOverlapXZ(b,ob,0) && boxesOverlapY(b,ob)){ why.push('hits the rear door frame'); break; }

  const hit = [];
  for(const p of others) if(boxesOverlapY(b,p) && boxesOverlapXZ(b,p,gap)) hit.push(p.cab ? p.cab.rc : '?');
  if(hit.length) why.push('too close to ' + hit.slice(0,3).join(', ') + (hit.length>3 ? ' +'+(hit.length-3) : ''));

  let supported = Math.abs(y - floorYAt(g,z)) < 0.5;
  if(!supported){
    let sup = 0;
    for(const p of others){
      if(!isSupport(p)) continue;
      if(Math.abs(p.y + p.h + ply - y) < 0.6) sup += overlapArea(b,p);
    }
    for(const wl of g.wells) if(Math.abs(wl.y + wl.h - y) < 0.6) sup += overlapArea(b,wl);
    supported = sup >= w*d*0.6;
  }
  if(!supported) why.push('nothing solid underneath');
  return { ok: why.length===0, why, supported };
}

/* Heights this footprint could sit at: the floor/deck, plus the top of anything
   flat beneath it (plus the plywood) and the tops of the wheel wells. */
function candidateYs(g, others, x, z, w, d, ply){
  const set = new Set([ floorYAt(g, z) ]);
  const foot = {x,y:0,z,w,h:0,d};
  for(const p of others){
    if(!isSupport(p)) continue;
    if(overlapArea(foot,p) > 1) set.add(rnd(p.y + p.h + ply));
  }
  for(const wl of g.wells) if(overlapArea(foot,wl) > 1) set.add(rnd(wl.h));
  return [...set].sort((a,b)=>a-b);
}

/* ============ live model ============ */
/* The editor always works on `results` so the 3D view, stats and printouts stay
   in step. Before the first Optimize run it is synthesised from the pins alone. */
function ensureResults(){
  const t = activeTrailer();
  if(!results || !results.trailer || results.trailer.id !== t.id){
    results = { trailer:t, geom:geomOf(t), placed:pinned().map(pinBox), failed:[],
                gap:curGap(), ply:curPly() };
    resequence();
  }
  return results;
}
function resequence(){
  const g = results.geom;
  results.placed.sort((a,b)=>{
    const la = Math.abs(a.y-floorYAt(g,a.z))<0.5 ? 0:1;
    const lb = Math.abs(b.y-floorYAt(g,b.z))<0.5 ? 0:1;
    return (la-lb) || (a.z-b.z) || (a.y-b.y) || (a.x-b.x);
  });
  results.placed.forEach((p,i)=>p.seq=i+1);
}
function refreshAll(){
  if(results) resequence();
  renderCabs();
  updateStats();
  draw3D();
  if(!el('tab-manual').classList.contains('hidden')) renderManual();
  if(!el('tab-plans').classList.contains('hidden')) renderPlansPreview();
}
function commit(cab, box){
  cab.pin = { x:rnd(box.x), y:rnd(box.y), z:rnd(box.z), pose:box.pose, rot:box.rot };
  const r = ensureResults();
  r.placed = r.placed.filter(p=>p.cab.id!==cab.id);
  r.failed = (r.failed||[]).filter(c=>c.id!==cab.id);
  const p = pinBox(cab);
  const chk = checkPlace(r.geom, r.placed, curGap(), p, curPly());
  if(!chk.ok) p.warn = chk.why.join('; ');
  r.placed.push(p);
  M.sel = { kind:'placed', cab };
  say(chk.ok ? `${cab.rc} pinned — ${poseText(p)}${p.rot?', turned 90°':''} at ${fmtDim(r.geom.totalL-(p.z+p.d))}" from the rear doors.`
             : `${cab.rc} pinned, but check it: ${chk.why.join('; ')}.`, chk.ok?'ok':'warn');
  saveAll(); refreshAll();
}
function takeOut(cab){                       // back to the list
  delete cab.pin;
  if(results) results.placed = results.placed.filter(p=>p.cab.id!==cab.id);
  M.sel = null;
  say(`${cab.rc} taken back out — it will be packed automatically next run.`);
  saveAll(); refreshAll();
}
function unpin(cab){                         // leave it there, let the packer move it
  delete cab.pin;
  const p = boxOf(cab); if(p){ p.pinned=false; delete p.warn; }
  say(`${cab.rc} unpinned — the optimizer may move it.`);
  saveAll(); refreshAll();
}
function say(msg, kind){ M.msg = msg||''; M.msgKind = kind||'info'; const s=el('ml-status'); if(s) paintStatus(s); }

/* ============================================================================
   OPTIMIZE — pinned cabinets go in first and are never moved
   ============================================================================ */
window.optimize = function(){
  const t = activeTrailer();
  if(!t){ alert('Select a trailer first (Trailers tab).'); return; }
  if(cabinets.length===0){ alert('Add cabinets first (Cabinets tab).'); return; }

  const g = geomOf(t), gap = curGap(), ply = curPly(), SC = curSC();
  const allowStack = el('allow-stack').checked;
  const layFlat    = el('lay-flat') ? el('lay-flat').checked : true;
  const allowSide  = el('allow-side') ? el('allow-side').checked : false;

  const placed = [], failed = [], pinIssues = [];

  /* ---- Phase 0: the pins. Seeded straight into `placed`, so every later
     placement treats them as immovable obstacles (and, when they lie flat, as
     part of the deck that carries the layer above). ---- */
  for(const cab of cabinets){
    if(!cab.pin) continue;
    const p = pinBox(cab);
    const chk = checkPlace(g, placed, gap, p, ply);
    if(!chk.ok){ p.warn = chk.why.join('; '); pinIssues.push({cab, why:chk.why}); }
    placed.push(p);
  }
  const pool = cabinets.filter(c=>!c.pin);

  if(layFlat){
    const deckH = dominantDepth(cabinets);
    const deckCabs = pool.filter(c=> Math.abs(c.d-deckH) < 1.01)
                         .sort((a,b)=> (b.w*b.h*b.d - a.w*a.h*a.d) || (b.w*b.h - a.w*a.h));
    const rest = pool.filter(c=> !(Math.abs(c.d-deckH) < 1.01));
    for(const cab of deckCabs)
      if(!tryPlace(cab, flatPoses(cab, allowSide), g, placed, gap, ply, false, SC)) rest.push(cab);
    rest.sort((a,b)=> (b.d-a.d) || (b.w*b.h*b.d - a.w*a.h*a.d));
    for(const cab of rest){
      let done = tryPlace(cab, flatPoses(cab, allowSide), g, placed, gap, ply, allowStack, SC);
      if(!done) done = tryPlace(cab, uprightPoses(cab), g, placed, gap, ply, allowStack, SC);
      if(!done) failed.push(cab);
    }
  } else {
    const units = [...pool].sort((a,b)=> (b.h-a.h) || (b.w*b.h*b.d - a.w*a.h*a.d));
    for(const cab of units){
      let done = tryPlace(cab, flatPoses(cab, allowSide), g, placed, gap, ply, allowStack, SC);
      if(!done) done = tryPlace(cab, uprightPoses(cab), g, placed, gap, ply, allowStack, SC);
      if(!done) failed.push(cab);
    }
  }

  results = { trailer:t, geom:g, placed, failed, gap, ply, pinIssues };
  resequence();
  saveAll();
  updateStats();

  const onManual = !el('tab-manual').classList.contains('hidden');
  if(onManual){ renderManual(); draw3D(); }
  else { document.querySelector('[data-tab="tab-3d"]').click(); draw3D(); }

  if(pinIssues.length){
    say(`${pinIssues.length} pinned cabinet(s) need a look: ` +
        pinIssues.map(p=>`${p.cab.rc} (${p.why.join(', ')})`).join(' · '), 'warn');
  } else if(placed.some(p=>p.pinned)){
    say(`Packed ${placed.filter(p=>!p.pinned).length} cabinet(s) around ${placed.filter(p=>p.pinned).length} pinned.`, 'ok');
  }
};

/* ============================================================================
   TAB PLUMBING
   ============================================================================ */
window.showTab = function(btn){
  document.querySelectorAll('.tabbtn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  ['tab-cabinets','tab-trailers','tab-manual','tab-3d','tab-plans'].forEach(t=>{
    const e = el(t); if(e) e.classList.add('hidden');
  });
  el(btn.dataset.tab).classList.remove('hidden');
  if(btn.dataset.tab==='tab-3d'){ init3D(); resize3D(); }
  if(btn.dataset.tab==='tab-plans'){ renderPlansPreview(); }
  if(btn.dataset.tab==='tab-manual'){ renderManual(); }
};

function injectUI(){
  /* nav button, inserted after Trailers, then renumber the whole row */
  const nav = document.querySelector('nav');
  const b = document.createElement('button');
  b.className = 'tabbtn'; b.dataset.tab = 'tab-manual';
  b.textContent = 'Manual Layout';
  b.addEventListener('click', ()=>showTab(b));
  nav.insertBefore(b, nav.children[2]);
  [...nav.children].forEach((btn,i)=>{
    btn.textContent = (i+1) + ' · ' + btn.textContent.replace(/^\s*\d+\s*·\s*/,'');
  });

  const sec = document.createElement('section');
  sec.id = 'tab-manual'; sec.className = 'hidden';
  sec.innerHTML = `
    <div class="flex gap-4 flex-col xl:flex-row">
      <div class="w-full xl:w-80 flex-none space-y-3">
        <div class="bg-white rounded-lg shadow p-3">
          <h2 class="font-bold text-sm mb-1">Place by hand</h2>
          <p class="text-xs text-slate-500 mb-2">Drag an item into the trailer, or tap it then tap where it goes.
            Anything you place is <b>pinned</b> and stays put when you optimize.</p>
          <div id="ml-palette" class="space-y-1 max-h-[34vh] overflow-auto pr-1"></div>
        </div>
        <div class="bg-white rounded-lg shadow p-3">
          <h2 class="font-bold text-sm mb-2">Selected item</h2>
          <div id="ml-tools"></div>
        </div>
        <div class="bg-white rounded-lg shadow p-3 space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <div><span class="lbl">Snap to</span>
              <select id="ml-snap">
                <option value="0.0625">1/16"</option><option value="0.25">1/4"</option>
                <option value="0.5">1/2"</option><option value="1" selected>1"</option>
                <option value="3">3"</option><option value="6">6"</option>
              </select></div>
            <div><span class="lbl">Show</span>
              <select id="ml-layer">
                <option value="all">Both layers</option>
                <option value="floor">Floor / deck only</option>
                <option value="stack">Stacked layer only</option>
              </select></div>
          </div>
          <label class="text-xs flex items-center gap-1.5"><input type="checkbox" id="ml-magnet" checked class="w-4 h-4">
            Snap up against walls and neighbours</label>
          <div class="flex flex-wrap gap-1.5 pt-1 border-t">
            <button class="btn btn-green !py-1 !px-2 text-xs" onclick="optimize()">⚙ Optimize around pinned</button>
            <button class="btn btn-gray !py-1 !px-2 text-xs" id="ml-pinall">📌 Pin everything placed</button>
            <button class="btn btn-gray !py-1 !px-2 text-xs" id="ml-unpinall">Unpin all</button>
            <button class="btn btn-red !py-1 !px-2 text-xs" id="ml-clearpins">Clear hand placements</button>
          </div>
        </div>
      </div>
      <div class="flex-1 min-w-0 space-y-2">
        <div id="ml-status" class="text-xs rounded px-3 py-2"></div>
        <div id="ml-canvas" class="bg-white rounded-lg shadow p-2 overflow-auto"></div>
        <div class="text-[11px] text-slate-500 leading-relaxed">
          Top view — front of the trailer at the left, rear doors at the right. Drag a box to move it.
          Keys: <b>R</b> turn 90° · <b>P</b> change how it lies · <b>[</b> / <b>]</b> down / up a layer ·
          ← → nudge fore/aft, ↑ ↓ nudge across · <b>Backspace</b> take it back out · <b>Esc</b> deselect.
        </div>
      </div>
    </div>`;
  document.querySelector('main').appendChild(sec);

  el('ml-snap').addEventListener('change', e=>{ M.snap = parseFloat(e.target.value); });
  el('ml-layer').addEventListener('change', e=>{ M.layer = e.target.value; renderCanvas(); });
  el('ml-magnet').addEventListener('change', e=>{ M.magnet = e.target.checked; });
  el('ml-pinall').addEventListener('click', ()=>{
    if(!results) return say('Nothing is loaded yet.', 'warn');
    let n=0; for(const p of results.placed){ if(!p.cab.pin){ p.cab.pin={x:rnd(p.x),y:rnd(p.y),z:rnd(p.z),pose:p.pose,rot:p.rot}; p.pinned=true; n++; } }
    say(`Pinned ${n} cabinet(s) where they sit.`, 'ok'); saveAll(); refreshAll();
  });
  el('ml-unpinall').addEventListener('click', ()=>{
    let n=0; for(const c of cabinets) if(c.pin){ delete c.pin; n++; }
    if(results) results.placed.forEach(p=>{ p.pinned=false; delete p.warn; });
    say(`Unpinned ${n} cabinet(s) — they stay where they are until the next run.`); saveAll(); refreshAll();
  });
  el('ml-clearpins').addEventListener('click', ()=>{
    if(!pinned().length) return say('There are no hand placements.', 'warn');
    if(!confirm('Remove every hand placement? Cabinets go back to being packed automatically.')) return;
    for(const c of cabinets) if(c.pin) delete c.pin;
    results = null; M.sel = null;
    say('Hand placements cleared. Press Optimize Load to repack.');
    refreshAll();
  });
}

/* ============================================================================
   RENDER
   ============================================================================ */
function renderManual(){
  M.t = activeTrailer();
  if(!M.t){ el('ml-canvas').innerHTML = '<div class="p-4 text-sm">Pick a trailer on the Trailers tab first.</div>'; return; }
  ensureResults();
  M.g = results.geom;
  renderPalette(); renderTools(); renderCanvas(); paintStatus(el('ml-status'));
}

function renderPalette(){
  const out = cabinets.filter(c=>!inTrailer(c));
  const host = el('ml-palette');
  if(!out.length){ host.innerHTML = '<div class="text-xs text-slate-400 py-2">Everything is in the trailer.</div>'; return; }
  const byRoom = {};
  for(const c of out){ const r = roomOf(c); (byRoom[r] = byRoom[r]||[]).push(c); }
  host.innerHTML = Object.keys(byRoom).map(r=>`
    <div class="text-[10px] font-bold uppercase text-slate-400 pt-1">${r===PKG_ROOM?'Packages':'Room '+r}</div>` +
    byRoom[r].map(c=>{
      const on = M.sel && M.sel.kind==='list' && M.sel.cab.id===c.id;
      return `<div class="ml-chip flex items-center gap-2 border rounded px-2 py-1 cursor-grab ${on?'border-blue-600 bg-blue-50':'border-slate-200 hover:border-slate-400'}"
               data-cid="${c.id}" style="touch-action:none">
        <span class="w-2.5 h-2.5 rounded-sm flex-none" style="background:${roomColor(c)}"></span>
        <div class="min-w-0 leading-tight">
          <div class="text-xs font-bold truncate">${c.rc} <span class="font-normal text-slate-500">${c.name}</span></div>
          <div class="text-[10px] text-slate-400">${fmtDim(c.w)} × ${fmtDim(c.h)} × ${fmtDim(c.d)}${isBulky(c)?' · 2+ ppl':''}</div>
        </div>
      </div>`;
    }).join('')).join('');
  host.querySelectorAll('.ml-chip').forEach(chip=>{
    chip.addEventListener('pointerdown', e=>{
      const cab = cabinets.find(c=>c.id===chip.dataset.cid);
      M.sel = { kind:'list', cab };
      startDrag(e, cab, null);
      renderPalette(); renderTools();
    });
  });
}

function renderTools(){
  const host = el('ml-tools');
  if(!M.sel){ host.innerHTML = '<div class="text-xs text-slate-400">Nothing selected. Tap an item in the list or a box in the trailer.</div>'; return; }
  const cab = M.sel.cab, p = boxOf(cab);
  const pose = p ? p.pose : M.pose, rot = p ? p.rot : M.rot;
  const bx = p || Object.assign({}, poseBox(cab,pose,rot));
  host.innerHTML = `
    <div class="text-xs font-bold mb-0.5">${cab.rc} <span class="font-normal text-slate-500">${cab.name}</span></div>
    <div class="text-[11px] text-slate-500 mb-2">
      ${fmtDim(cab.w)} × ${fmtDim(cab.h)} × ${fmtDim(cab.d)} · lying <b>${poseText({pose})}</b>${rot?', turned 90°':''}<br>
      Footprint ${fmtDim(bx.d)}" along the trailer × ${fmtDim(bx.w)}" across, ${fmtDim(bx.h)}" tall
      ${p ? `<br>${fmtDim(M.g.totalL-(p.z+p.d))}" from the rear doors, ${fmtDim(p.x)}" from the left wall${Math.abs(p.y-floorYAt(M.g,p.z))<0.5?'':', stacked at '+fmtDim(p.y)+'"'}` : ''}
      ${p && p.warn ? `<br><span class="text-red-600 font-bold">⚠ ${p.warn}</span>` : ''}
    </div>
    <div class="flex flex-wrap gap-1.5">
      <button class="btn btn-gray !py-1 !px-2 text-xs" data-act="rot">↻ Turn 90°</button>
      <button class="btn btn-gray !py-1 !px-2 text-xs" data-act="pose">⇅ ${POSE_SHORT[pose]}</button>
      ${p?`<button class="btn btn-gray !py-1 !px-2 text-xs" data-act="down">↓ layer</button>
      <button class="btn btn-gray !py-1 !px-2 text-xs" data-act="up">↑ layer</button>
      ${cab.pin?`<button class="btn btn-gray !py-1 !px-2 text-xs" data-act="unpin">Unpin, leave it</button>`:
                `<button class="btn btn-blue !py-1 !px-2 text-xs" data-act="pinhere">📌 Pin here</button>`}
      <button class="btn btn-red !py-1 !px-2 text-xs" data-act="out">Take back out</button>`:''}
    </div>`;
  host.querySelectorAll('[data-act]').forEach(btn=>btn.addEventListener('click', ()=>doAction(btn.dataset.act)));
}

function paintStatus(node){
  if(!node) return;
  const nPin = pinned().length, nIn = results ? results.placed.length : 0;
  const cls = M.msgKind==='bad'  ? 'bg-red-50 border border-red-200 text-red-700'
            : M.msgKind==='warn' ? 'bg-amber-50 border border-amber-200 text-amber-800'
            : M.msgKind==='ok'   ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
            :                      'bg-slate-100 border border-slate-200 text-slate-600';
  node.className = 'text-xs rounded px-3 py-2 ' + cls;
  node.innerHTML = `<b>${nIn}</b> in the trailer · <b>${nPin}</b> pinned 📌 · <b>${cabinets.length-nIn}</b> still in the list`
    + (M.msg ? ` — ${M.msg}` : '');
}

function renderCanvas(){
  const g = M.g, sc = M.sc = SVG_LEN/(g.totalL+40);
  const W = g.totalL*sc + PAD*2 + 20, H = g.W*sc + PAD*2 + 16;
  const sx = z=>PAD+z*sc, sy = x=>PAD+x*sc;
  let s = `<svg id="ml-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
            style="width:100%;height:auto;display:block;touch-action:none;user-select:none;-webkit-user-select:none">`;
  s += svgFloorOutline(g, sc, PAD);

  const boxes = [...results.placed].sort((a,b)=>a.y-b.y);   // low layer first
  for(const p of boxes){
    const onFloor = Math.abs(p.y-floorYAt(g,p.z))<0.5;
    const hidden = (M.layer==='floor' && !onFloor) || (M.layer==='stack' && onFloor);
    const seld = M.sel && M.sel.kind==='placed' && M.sel.cab.id===p.cab.id;
    const col = roomColor(p.cab);
    const stroke = p.warn ? '#dc2626' : seld ? '#1d4ed8' : p.pinned ? '#d97706' : col;
    s += `<rect x="${sx(p.z)}" y="${sy(p.x)}" width="${p.d*sc}" height="${p.w*sc}"
            fill="${col}" fill-opacity="${hidden?0.12:(onFloor?0.5:0.72)}"
            stroke="${stroke}" stroke-width="${seld?3.5:p.pinned?2.5:1.5}"
            ${p.pinned&&!seld?'stroke-dasharray="7 3"':''} ${hidden?'':'class="ml-box"'} data-cid="${p.cab.id}"/>`;
    if(hidden) continue;
    const fs = Math.max(6.5, Math.min(12, p.d*sc/4, p.w*sc/3));
    s += `<text x="${sx(p.z+p.d/2)}" y="${sy(p.x+p.w/2)-fs*0.15}" font-size="${fs}" font-weight="bold"
            fill="#0f172a" text-anchor="middle" dominant-baseline="middle" pointer-events="none"
            >${p.pinned?'📌':''}${p.cab.rc}</text>`;
    s += `<text x="${sx(p.z+p.d/2)}" y="${sy(p.x+p.w/2)+fs}" font-size="${fs*0.72}" fill="#334155"
            text-anchor="middle" dominant-baseline="middle" pointer-events="none"
            >#${p.seq} · ${POSE_SHORT[p.pose]}${p.rot?'↻':''}${onFloor?'':' · '+fmtDim(p.y)+'"'}</text>`;
  }
  s += `<rect id="ml-ghost" x="0" y="0" width="0" height="0" pointer-events="none" style="display:none"/>`;
  s += `<text id="ml-ghost-t" x="0" y="0" font-size="10" font-weight="bold" text-anchor="middle"
          dominant-baseline="middle" pointer-events="none" style="display:none"></text>`;
  for(let ft=0; ft*12<=g.totalL; ft++){
    const z = g.totalL-ft*12;
    s += `<line x1="${sx(z)}" y1="${sy(g.W)+2}" x2="${sx(z)}" y2="${sy(g.W)+7}" stroke="#94a3b8"/>
          <text x="${sx(z)}" y="${sy(g.W)+16}" font-size="7" fill="#94a3b8" text-anchor="middle">${ft}'</text>`;
  }
  s += '</svg>';
  el('ml-canvas').innerHTML = s;
  M.svg = document.getElementById('ml-svg');
  M.svg.addEventListener('pointerdown', onCanvasDown);
}

/* ============================================================================
   DRAGGING
   ============================================================================ */
function svgPt(evt){
  const pt = M.svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const p = pt.matrixTransform(M.svg.getScreenCTM().inverse());
  return { z:(p.x-PAD)/M.sc, x:(p.y-PAD)/M.sc };
}
function overSvg(evt){
  if(!M.svg) return false;
  const r = M.svg.getBoundingClientRect();
  return evt.clientX>=r.left && evt.clientX<=r.right && evt.clientY>=r.top && evt.clientY<=r.bottom;
}
function snapv(v){ return Math.round(v/M.snap)*M.snap; }

/* Pull the edge onto a wall or flush against a neighbour when it is close. */
function magnet(g, others, box, gap){
  if(!M.magnet) return box;
  const TOL = 2, wr = availWidthAt(g, box.z);
  const xs = [0, wr.min, g.W-box.w, wr.max-box.w];
  const zs = [0, g.totalL-box.d];
  for(const p of others){
    if(!boxesOverlapY(box, p) && !(Math.abs(p.y-box.y)<0.6)) continue;
    xs.push(p.x + p.w + gap, p.x - box.w - gap, p.x, p.x + p.w - box.w);
    zs.push(p.z + p.d + gap, p.z - box.d - gap, p.z, p.z + p.d - box.d);
  }
  for(const wl of g.wells){ xs.push(wl.x + wl.w, wl.x - box.w); zs.push(wl.z + wl.d, wl.z - box.d); }
  let bx = box.x, bz = box.z, dx = TOL, dz = TOL;
  for(const c of xs){ const d = Math.abs(c-box.x); if(d < dx){ dx = d; bx = c; } }
  for(const c of zs){ const d = Math.abs(c-box.z); if(d < dz){ dz = d; bz = c; } }
  return Object.assign({}, box, { x:rnd(Math.max(0,bx)), z:rnd(Math.max(0,bz)) });
}

function startDrag(evt, cab, existing){
  evt.preventDefault();
  const pose = existing ? existing.pose : M.pose;
  const rot  = existing ? existing.rot  : M.rot;
  M.drag = { cab, pose, rot, from:existing||null,
             grab: existing && overSvg(evt) ? (()=>{ const q=svgPt(evt); return {dz:q.z-existing.z, dx:q.x-existing.x}; })() : null,
             yIdx: null, moved:false, box:null };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp, {once:true});
}
function dragBox(evt, d){
  const g = M.g, gap = curGap(), ply = curPly();
  const others = results.placed.filter(p=>p.cab.id!==d.cab.id);
  const dim = poseBox(d.cab, d.pose, d.rot);
  const q = svgPt(evt);
  let box = { x:snapv(q.x - (d.grab? d.grab.dx : dim.w/2)),
              z:snapv(q.z - (d.grab? d.grab.dz : dim.d/2)),
              y:0, w:dim.w, h:dim.h, d:dim.d, pose:d.pose, rot:d.rot };
  box.x = Math.max(0, Math.min(box.x, g.W - box.w));
  box.z = Math.max(0, Math.min(box.z, g.totalL - box.d));
  box = magnet(g, others, box, gap);
  /* pick a height: the level the user asked for, else the lowest that works */
  const ys = candidateYs(g, others, box.x, box.z, box.w, box.d, ply);
  let chosen = null;
  if(d.yIdx!=null && ys[Math.min(d.yIdx, ys.length-1)]!=null){
    chosen = ys[Math.min(d.yIdx, ys.length-1)];
  } else {
    for(const y of ys){ if(checkPlace(g, others, gap, Object.assign({},box,{y}), ply).ok){ chosen = y; break; } }
    if(chosen==null) chosen = ys[0];
  }
  box.y = chosen;
  const chk = checkPlace(g, others, gap, box, ply);
  return { box, chk, levels:ys };
}
function paintGhost(box, chk){
  const gh = document.getElementById('ml-ghost'), tx = document.getElementById('ml-ghost-t');
  if(!gh) return;
  const sc = M.sc, sx = z=>PAD+z*sc, sy = x=>PAD+x*sc;
  gh.setAttribute('x', sx(box.z)); gh.setAttribute('y', sy(box.x));
  gh.setAttribute('width', box.d*sc); gh.setAttribute('height', box.w*sc);
  gh.setAttribute('fill', chk.ok ? '#22c55e' : '#ef4444');
  gh.setAttribute('fill-opacity', '0.4');
  gh.setAttribute('stroke', chk.ok ? '#15803d' : '#b91c1c');
  gh.setAttribute('stroke-width', '2.5');
  gh.style.display = '';
  tx.setAttribute('x', sx(box.z+box.d/2)); tx.setAttribute('y', sy(box.x+box.w/2));
  tx.setAttribute('fill', '#0f172a');
  tx.textContent = POSE_SHORT[box.pose] + (box.rot?'↻':'') + (box.y>0.5 ? ' @'+fmtDim(box.y)+'"' : '');
  tx.style.display = '';
}
function hideGhost(){
  ['ml-ghost','ml-ghost-t'].forEach(id=>{ const n=document.getElementById(id); if(n) n.style.display='none'; });
}
function onDragMove(evt){
  const d = M.drag; if(!d) return;
  d.moved = true;
  if(!overSvg(evt)){ hideGhost(); d.box = null; return; }
  const {box, chk} = dragBox(evt, d);
  d.box = box; d.chk = chk;
  paintGhost(box, chk);
  say(chk.ok ? `${fmtDim(M.g.totalL-(box.z+box.d))}" from the rear doors, ${fmtDim(box.x)}" from the left wall`
             : chk.why.join('; '), chk.ok ? 'ok' : 'warn');
}
function onDragUp(evt){
  window.removeEventListener('pointermove', onDragMove);
  const d = M.drag; M.drag = null;
  hideGhost();
  if(!d) return;
  if(overSvg(evt)){
    const {box, chk} = dragBox(evt, d);
    if(!chk.ok && (chk.why.includes('taller than the ceiling') || chk.why.some(w=>w.indexOf('wall')>=0 || w.indexOf('rear doors')>=0))){
      say('Won\'t fit there: ' + chk.why.join('; '), 'bad'); renderTools(); return;
    }
    M.pose = box.pose; M.rot = box.rot;
    commit(d.cab, box);
    return;
  }
  renderTools();
}
function onCanvasDown(evt){
  /* topmost visible box under the pointer, else place the list selection here */
  const q = svgPt(evt);
  const cand = results.placed.filter(p=>{
    const onFloor = Math.abs(p.y-floorYAt(M.g,p.z))<0.5;
    if((M.layer==='floor' && !onFloor) || (M.layer==='stack' && onFloor)) return false;
    return q.z>=p.z && q.z<=p.z+p.d && q.x>=p.x && q.x<=p.x+p.w;
  }).sort((a,b)=>b.y-a.y);
  if(cand.length){
    M.sel = { kind:'placed', cab:cand[0].cab };
    renderCanvas(); renderTools(); renderPalette();
    startDrag(evt, cand[0].cab, cand[0]);
    return;
  }
  if(M.sel && M.sel.kind==='list'){ startDrag(evt, M.sel.cab, null); onDragMove(evt); return; }
  M.sel = null; renderCanvas(); renderTools();
}

/* ============================================================================
   TOOLBAR / KEYBOARD ACTIONS
   ============================================================================ */
/* Actions:
     rot / pose               turn 90°, cycle back -> side -> upright
     fwd / aft                nudge along the trailer
     toLeft / toRight         nudge across the trailer
     layerUp / layerDown      step onto the next surface up or down
     pinhere / unpin / out                                                    */
const NUDGE = { fwd:{z:-1}, aft:{z:1}, toLeft:{x:-1}, toRight:{x:1} };

function doAction(act){
  if(!M.sel) return;
  const cab = M.sel.cab, p = boxOf(cab);

  if(!p){                                  // still in the list: set the drop pose
    if(act==='rot')  M.rot = !M.rot;
    if(act==='pose') M.pose = POSES[(POSES.indexOf(M.pose)+1) % POSES.length];
    renderTools(); return;
  }
  if(act==='out')     return takeOut(cab);
  if(act==='unpin')   return unpin(cab);
  if(act==='pinhere') return commit(cab, Object.assign({}, p));

  let box = { x:p.x, y:p.y, z:p.z, pose:p.pose, rot:p.rot };
  if(act==='rot')  box.rot  = !box.rot;
  if(act==='pose') box.pose = POSES[(POSES.indexOf(box.pose)+1) % POSES.length];
  const n = NUDGE[act];
  if(n){ box.x = rnd(box.x + (n.x||0)*M.snap); box.z = rnd(box.z + (n.z||0)*M.snap); }

  Object.assign(box, poseBox(cab, box.pose, box.rot));
  box.x = Math.max(0, box.x); box.z = Math.max(0, box.z);
  const others = results.placed.filter(q=>q.cab.id!==cab.id);
  const ys = candidateYs(M.g, others, box.x, box.z, box.w, box.d, curPly());
  if(act==='layerUp' || act==='layerDown'){
    let i = ys.findIndex(y=>Math.abs(y-box.y)<0.6);
    if(i<0) i = 0;
    box.y = ys[Math.max(0, Math.min(ys.length-1, i + (act==='layerUp'?1:-1)))];
  } else if(!ys.some(y=>Math.abs(y-box.y)<0.6)){
    box.y = ys[0];                        // the surface it was sitting on is gone
  }
  commit(cab, box);
}
document.addEventListener('keydown', e=>{
  const t = el('tab-manual');
  if(!t || t.classList.contains('hidden')) return;
  const tag = (e.target.tagName||'').toLowerCase();
  if(tag==='input' || tag==='select' || tag==='textarea') return;
  if(e.key==='Escape'){ M.sel=null; renderCanvas(); renderTools(); renderPalette(); return; }
  if(!M.sel) return;
  const map = { r:'rot', R:'rot', p:'pose', P:'pose', '[':'layerDown', ']':'layerUp',
                ArrowLeft:'fwd', ArrowRight:'aft', ArrowUp:'toLeft', ArrowDown:'toRight',
                Backspace:'out', Delete:'out' };
  const act = map[e.key]; if(!act) return;
  e.preventDefault();
  doAction(act);
});

/* ============================================================================
   DECORATION OF THE EXISTING VIEWS
   ============================================================================ */
const _draw3D = window.draw3D;
window.draw3D = function(){
  _draw3D();
  if(!threeReady || !loadGroup || !results) return;
  const g = results.geom, ox = -g.W/2, oz = -g.totalL/2;
  for(const p of results.placed){
    if(!p.pinned && !p.warn) continue;
    const geo = new THREE.BoxGeometry(p.w, p.h, p.d);
    const ln = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: p.warn ? 0xdc2626 : 0xf59e0b }));
    ln.position.set(p.x+p.w/2+ox, p.y+p.h/2, p.z+p.d/2+oz);
    loadGroup.add(ln);
    geo.dispose();
  }
};

const _renderCabs = window.renderCabs;
window.renderCabs = function(){
  _renderCabs();
  const rows = el('cab-tbody').rows;
  cabinets.forEach((c,i)=>{
    if(c.pin && rows[i]) rows[i].cells[0].insertAdjacentHTML('beforeend',
      ' <span title="Placed by hand — the optimizer will not move it">📌</span>');
  });
};

const _updateStats = window.updateStats;
window.updateStats = function(){
  _updateStats();
  if(!results) return;
  const {geom:g, placed} = results;
  el('seq-list').innerHTML = placed.map(p=>{
    const fromRear = g.totalL-(p.z+p.d);
    const onFloor = Math.abs(p.y-floorYAt(g,p.z))<0.5;
    return `<div class="border rounded p-1.5 flex items-center gap-2" style="border-left:4px solid ${roomColor(p.cab)}">
      <b class="text-slate-400">#${p.seq}</b>
      <div><b>${p.cab.rc}</b> ${p.cab.name}${p.pinned?' <span title="placed by hand">📌</span>':''}${isBulky(p.cab)?' <span class="text-[9px] font-bold text-white bg-orange-500 rounded px-1">2+ ppl</span>':''}<br>
      <span class="text-slate-500">${fmtDim(p.cab.w)}×${fmtDim(p.cab.h)}×${fmtDim(p.cab.d)} · ${fromRear.toFixed(0)}" from rear · ${p.x.toFixed(0)}" from left${onFloor?'':' · stacked at '+p.y.toFixed(0)+'"'} · <b class="text-slate-600">${poseText(p)}</b>${p.rot?', turned 90°':''}</span>
      ${p.warn?`<br><span class="text-red-600 text-[10px] font-bold">⚠ ${p.warn}</span>`:''}</div>
    </div>`;
  }).join('');
};

/* Crew sheet: same layout as stock, with a pin badge so the loader knows a spot
   was chosen deliberately and should not be improvised. */
window.loadingOrderHTML = function(){
  const {geom:g, placed} = results;
  const ply = results.ply || 0;
  let body = '', prevLayer = null;
  for(const p of placed){
    const layer = Math.abs(p.y-floorYAt(g,p.z))<0.5 ? 0 : 1;
    if(prevLayer===0 && layer===1){
      body += `<div style="display:flex;align-items:center;gap:8px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:6px 10px;margin:8px 0;font-weight:800;color:#92400e;font-size:12px">
        ▩ LAY ${fmtDim(ply||0.5)}" PLYWOOD over the whole deck now — then keep loading on top</div>`;
    }
    prevLayer = layer;
    const fromRear = g.totalL-(p.z+p.d), big = isBulky(p.cab);
    body += `<div style="display:flex;gap:9px;align-items:center;padding:5px 8px;border-bottom:1px solid #e5e7eb;${big?'background:#fff7ed':''}">
      <div style="font-weight:800;font-size:14px;min-width:26px;text-align:right;color:#0f172a">${p.seq}</div>
      <div style="width:11px;height:11px;border-radius:2px;background:${roomColor(p.cab)};flex:none"></div>
      <div style="flex:1;line-height:1.25">
        <span style="font-weight:700">${p.cab.rc}</span> ${p.cab.name}
        ${p.pinned?'<span style="border:1.5px solid #d97706;color:#92400e;font-size:9px;font-weight:800;padding:0 5px;border-radius:8px;margin-left:4px;white-space:nowrap">SET SPOT</span>':''}
        ${big?'<span style="background:#ea580c;color:#fff;font-size:9px;font-weight:800;padding:1px 6px;border-radius:8px;margin-left:4px;white-space:nowrap">LARGE · 2+ PEOPLE</span>':''}
        <div style="font-size:11px;color:#475569">${fmtDim(p.cab.w)}×${fmtDim(p.cab.h)}×${fmtDim(p.cab.d)} · <b>${poseText(p)}</b>${p.rot?', turned 90°':''} · ${fmtDim(fromRear)}" from rear doors, ${fmtDim(p.x)}" from left wall</div>
        ${p.warn?`<div style="font-size:11px;color:#b91c1c;font-weight:700">⚠ ${p.warn}</div>`:''}
      </div>
    </div>`;
  }
  const intro = `<div style="font-size:11px;color:#475569;margin-bottom:8px">
    Load strictly top-to-bottom. The bottom deck goes in first (heavy pieces first, while the trailer is empty and there's the most room to carry them up front), then plywood, then the top layer.
    Orange rows need a two-person carry. Rows marked <b>SET SPOT</b> were positioned by hand — put them exactly where the plan says.</div>`;
  return intro + `<div style="border:1px solid #cbd5e1;border-radius:8px;overflow:hidden">${body}</div>`;
};

const _plansHTML = window.plansHTML;
window.plansHTML = function(forPrint){
  let out = _plansHTML(forPrint);
  if(!results) return out;
  const pins = results.placed.filter(p=>p.pinned);
  if(!pins.length) return out;
  const g = results.geom;
  const rows = pins.map(p=>`<tr>
      <td style="font-weight:bold">${p.seq}</td>
      <td><b>${p.cab.rc}</b></td><td>${p.cab.name}</td>
      <td>${fmtDim(g.totalL-(p.z+p.d))}" fwd of rear doors, ${fmtDim(p.x)}" from left wall${Math.abs(p.y-floorYAt(g,p.z))<0.5?'':', stacked at '+fmtDim(p.y)+'"'}</td>
      <td><b>${poseText(p).replace(/^./,c=>c.toUpperCase())}</b>${p.rot?' · turned 90°':''}</td>
      <td style="color:${p.warn?'#b91c1c':'#166534'}">${p.warn? '⚠ '+p.warn : 'OK'}</td>
    </tr>`).join('');
  return out + `<div ${forPrint?'class="page-break"':''} style="margin-bottom:18px">
    <h2 style="font-size:15px;font-weight:800;background:#fffbeb;padding:5px 9px;border-left:4px solid #d97706;margin-bottom:8px">
      Set Spots — positioned by hand, do not improvise (${pins.length})</h2>
    <table class="grid" style="font-size:11px"><thead><tr>
      <th>Load #</th><th>Cabinet · Pkg #</th><th>Name</th><th>Position</th><th>How it lies</th><th>Check</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
};

/* Deleting a cabinet must also pull it out of the load, or the plan keeps
   showing a box for something that no longer exists. */
const _delCab = window.delCab;
window.delCab = function(id){
  const cab = cabinets.find(c=>c.id===id);
  if(cab && results) results.placed = results.placed.filter(p=>p.cab.id!==id);
  if(M.sel && M.sel.cab.id===id) M.sel = null;
  _delCab(id);
  if(results) resequence();
  refreshAll();
};
const _clearCabs = window.clearCabs;
window.clearCabs = function(){ M.sel = null; _clearCabs(); };

/* ============ boot ============ */
injectUI();
if(pinned().length){ ensureResults(); refreshAll(); }

})();
