/* ============================================================================
   manual-layout.js — Manual placement, pinning and re-arranging
   Add-on for the Cabinet Load Optimizer.

   Load this AFTER the app's inline <script>:
       <script src="manual-layout.js"></script>

   What it adds
     • A "Manual Layout" tab: a top-view plan of the trailer you can drag in,
       with the live 3D view beside it.
     • Drag a cabinet or package straight out of the list into the trailer.
     • Drag anything already in the trailer to a new spot, rotate it, change how
       it lies, move it up onto the plywood layer.
     • Click a cabinet in the 3D view to select it, then reorient and move it
       with the buttons or the keyboard.
     • Undo and redo, back through every hand placement of this session.
     • Anything you place by hand is PINNED (📌). Pressing Optimize Load packs
       every remaining cabinet around the pinned ones without moving them.

   The 3D view is the app's own scene and renderer, moved between the 3D Load
   Plan tab and this tab. There is only ever one WebGL context.

   Every hand edit is also announced on the document as a `clo:edit` event, and
   each optimize run as `clo:optimize`. load-learning.js listens for those to
   build the tuning suggestions. If that file is absent the events go nowhere
   and nothing here changes.

   Nothing in the original file is deleted — this module replaces optimize(),
   showTab(), resize3D(), loadingOrderHTML() and decorates draw3D(),
   renderCabs() and plansHTML() at run time. Delete the script tag to go back
   to stock.
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
  svg: null, sc: 1, g: null, t: null,
  /* 3D: which container the app's renderer is currently sitting in, the
     pickable cabinet meshes found in it, and one reusable ray. */
  host3d: 'canvas3d', view: 'both', picks: [], ray: null,
  /* undo / redo: full snapshots of pins + placement, newest last */
  undo: [], redo: [], lastPush: 0, lastKey: '',
  /* what the packer chose on the last run, so an edit can be reported as a
     change away from the algorithm's own answer rather than from whatever the
     box happened to be a moment ago */
  runId: null, baseline: {}, baseFailed: new Set()
};
const UNDO_MAX = 60;

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
   makePoses() in the app exactly so a hand-placed cabinet and an auto-placed
   one of the same pose occupy the same box. */
function poseBox(cab, pose, rot){
  if(pose==='back') return rot ? {w:cab.h, h:cab.d, d:cab.w} : {w:cab.w, h:cab.d, d:cab.h};
  if(pose==='side') return rot ? {w:cab.d, h:cab.w, d:cab.h} : {w:cab.h, h:cab.w, d:cab.d};
  return              rot ? {w:cab.d, h:cab.h, d:cab.w} : {w:cab.w, h:cab.h, d:cab.d};
}
function pinBox(cab){
  const b = poseBox(cab, cab.pin.pose, cab.pin.rot);
  return { x:cab.pin.x, y:cab.pin.y, z:cab.pin.z, w:b.w, h:b.h, d:b.d,
           pose:cab.pin.pose, rot:cab.pin.rot, cls:cabClass(cab), cab, pinned:true, standMargin:curSC() };
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
    return (la-lb) || (a.y-b.y) || (a.z-b.z) || (a.x-b.x);
  });
  results.placed.forEach((p,i)=>p.seq=i+1);
}
function refreshAll(){
  if(results) resequence();
  renderCabs();
  updateStats();
  /* renderManual() first: it mounts the renderer into whichever panel is
     showing, so the draw below happens at the right size, once. */
  if(!el('tab-manual').classList.contains('hidden')) renderManual();
  draw3D();
  if(!el('tab-plans').classList.contains('hidden')) renderPlansPreview();
}
function commit(cab, box, undoKey){
  const r = ensureResults();
  const others = r.placed.filter(p=>p.cab.id!==cab.id);
  const candidate=Object.assign({},box,poseBox(cab,box.pose,box.rot),{cab});
  const validation=v2Check(r.geom,others,curGap(),candidate,curPly());
  if(!validation.ok){
    say(`Won't fit there: ${validation.why.join('; ')}`, 'bad');
    renderTools();
    return false;
  }
  const was = boxOf(cab);
  const from = was ? boxSig(was) : null;
  pushUndo(from ? `move ${cab.rc}` : `place ${cab.rc}`,
           undoKey ? cab.id+':'+undoKey : '', cab.id);

  cab.pin = { x:rnd(box.x), y:rnd(box.y), z:rnd(box.z), pose:box.pose, rot:box.rot };
  r.placed = r.placed.filter(p=>p.cab.id!==cab.id);
  r.failed = (r.failed||[]).filter(c=>c.id!==cab.id);
  const p = pinBox(cab);
  r.placed.push(p);
  M.sel = { kind:'placed', cab };
  reportEdit('move', cab, from, boxSig(p));
  say(`${cab.rc} pinned — ${poseText(p)}${p.rot?', turned 90°':''} at ${fmtDim(r.geom.totalL-(p.z+p.d))}" from the rear doors.`, 'ok');
  saveAll(); refreshAll();
  return true;
}
function takeOut(cab){                       // back to the list
  const was = boxOf(cab);
  pushUndo(`take out ${cab.rc}`, '', cab.id);
  reportEdit('remove', cab, was ? boxSig(was) : null, null);
  delete cab.pin;
  if(results) results.placed = results.placed.filter(p=>p.cab.id!==cab.id);
  M.sel = null;
  say(`${cab.rc} taken back out — it will be packed automatically next run.`);
  saveAll(); refreshAll();
}
function unpin(cab){                         // leave it there, let the packer move it
  pushUndo(`unpin ${cab.rc}`, '', cab.id);
  delete cab.pin;
  const p = boxOf(cab); if(p){ p.pinned=false; delete p.warn; }
  say(`${cab.rc} unpinned — the optimizer may move it.`);
  saveAll(); refreshAll();
}
function clearHandPlacements(){
  for(const c of cabinets) if(c.pin) delete c.pin;
  results = null; M.sel = null;
  saveAll();
  say('Hand placements cleared. Press Optimize Load to repack.');
  refreshAll();
}
function say(msg, kind){ M.msg = msg||''; M.msgKind = kind||'info'; const s=el('ml-status'); if(s) paintStatus(s); }

/* ============================================================================
   UNDO / REDO
   A snapshot is the whole editable state: which cabinets are pinned and where,
   plus every box currently in the trailer. Boxes are stored as a cabinet id and
   a pose, never as width/height/depth, so a restored box is rebuilt through
   poseBox() and can never disagree with the packer about its own size.
   ============================================================================ */
function boxSig(p){
  const g = (results && results.geom) || M.g;
  return { x:rnd(p.x), y:rnd(p.y), z:rnd(p.z), pose:p.pose, rot:!!p.rot,
           layer: (g && Math.abs(p.y-floorYAt(g,p.z))<0.5) ? 'floor' : 'stack' };
}
function snapshot(){
  return {
    pins: cabinets.filter(c=>c.pin).map(c=>({ id:c.id, pin:Object.assign({}, c.pin) })),
    placed: results ? results.placed.map(p=>({ id:p.cab.id, x:p.x, y:p.y, z:p.z,
                                               pose:p.pose, rot:!!p.rot, pinned:!!p.pinned })) : null,
    failed: results ? (results.failed||[]).map(c=>c.id) : null,
    sel: M.sel ? M.sel.cab.id : null
  };
}
function restore(s){
  for(const c of cabinets) if(c.pin) delete c.pin;
  for(const r of s.pins){ const c = cabinets.find(x=>x.id===r.id); if(c) c.pin = Object.assign({}, r.pin); }

  if(s.placed == null){
    results = null;
  } else {
    const t = activeTrailer(), g = geomOf(t), placed = [];
    for(const r of s.placed){
      const cab = cabinets.find(x=>x.id===r.id); if(!cab) continue;   // deleted since
      const b = poseBox(cab, r.pose, r.rot);
      placed.push({ x:r.x, y:r.y, z:r.z, w:b.w, h:b.h, d:b.d, pose:r.pose, rot:r.rot,
                    cls:cabClass(cab), cab, pinned:r.pinned });
    }
    const failed = (s.failed||[]).map(id=>cabinets.find(c=>c.id===id)).filter(Boolean);
    results = { trailer:t, geom:g, placed, failed, gap:curGap(), ply:curPly() };
    /* re-check every box: a restored layout is only as valid as the current
       clearance and plywood settings, which may have changed since. */
    annotateExistingLayout(g, placed, curGap(), curPly());
  }

  M.sel = null;
  if(s.sel){
    const c = cabinets.find(x=>x.id===s.sel);
    if(c) M.sel = { kind: (results && results.placed.some(p=>p.cab.id===c.id)) ? 'placed' : 'list', cab:c };
  }
}
/* Repeated arrow-key nudges on the same cabinet collapse into one undo step so
   a single button press does not eat the whole history. */
function pushUndo(label, key, cabId){
  const now = Date.now();
  if(key && key===M.lastKey && now-M.lastPush < 1500){ M.lastPush = now; return; }
  M.undo.push({ label, cabId:cabId||null, state:snapshot() });
  if(M.undo.length > UNDO_MAX) M.undo.shift();
  M.redo.length = 0;
  M.lastPush = now; M.lastKey = key || '';
  paintUndoBtns();
}
function undoLast(){
  if(!M.undo.length){ say('Nothing left to undo.', 'warn'); return; }
  const step = M.undo.pop();
  M.redo.push({ label:step.label, cabId:step.cabId, state:snapshot() });
  if(M.redo.length > UNDO_MAX) M.redo.shift();
  restore(step.state);
  M.lastKey = '';
  say('Undone: ' + step.label, 'ok');
  reportUndo(step);
  saveAll(); refreshAll();
}
function redoLast(){
  if(!M.redo.length){ say('Nothing left to redo.', 'warn'); return; }
  const step = M.redo.pop();
  M.undo.push({ label:step.label, cabId:step.cabId, state:snapshot() });
  restore(step.state);
  M.lastKey = '';
  say('Redone: ' + step.label, 'ok');
  saveAll(); refreshAll();
}
/* Undoing one cabinet's move is reported as that cabinet's new state, so the
   learning log ends up holding what you actually settled on. A bulk undo covers
   too many cabinets to restate, so it is flagged instead and the tuning page
   says so. */
function reportUndo(step){
  if(step.cabId){
    const cab = cabinets.find(c=>c.id===step.cabId);
    if(cab){
      const now = boxOf(cab);
      reportEdit(now ? 'move' : 'remove', cab, null, now ? boxSig(now) : null);
      return;
    }
  }
  emit('clo:undo', { label:step.label, scope:'bulk' });
}
function paintUndoBtns(){
  const u = el('ml-undo'), r = el('ml-redo');
  if(u){ u.disabled = !M.undo.length; u.classList.toggle('opacity-40', !M.undo.length);
         u.title = M.undo.length ? 'Undo: ' + M.undo[M.undo.length-1].label : 'Nothing to undo'; }
  if(r){ r.disabled = !M.redo.length; r.classList.toggle('opacity-40', !M.redo.length);
         r.title = M.redo.length ? 'Redo: ' + M.redo[M.redo.length-1].label : 'Nothing to redo'; }
}

/* ============================================================================
   EDIT LOG FEED
   Announced, never acted on here. load-learning.js turns these into suggested
   changes for the loading rules, which you review by hand.
   ============================================================================ */
function emit(name, detail){
  try{ document.dispatchEvent(new CustomEvent(name, { detail })); }catch(e){}
}
function reportEdit(action, cab, from, to){
  const base = M.baseline[cab.id] || null;
  emit('clo:edit', {
    runId: M.runId, at: Date.now(),
    job: el('job-name').value || '', trailerId: activeTrailerId,
    cabId: cab.id, rc: cab.rc, name: cab.name, cls: cabClass(cab),
    w: cab.w, h: cab.h, d: cab.d,
    /* rescued = the packer reported it would not fit, and you fitted it anyway */
    action: (action==='move' && !base && M.baseFailed.has(cab.id)) ? 'rescue' : action,
    base, from: from || null, to: to || null
  });
}

/* ============================================================================
   OPTIMIZE — pinned cabinets go in first and are never moved
   ============================================================================ */
window.optimize = function(){
  const t = activeTrailer();
  if(!t){ alert('Select a trailer first (Trailers tab).'); return; }
  if(cabinets.length===0){ alert('Add cabinets first (Cabinets tab).'); return; }

  const g = geomOf(t), gap = curGap(), ply = curPly(), SC = curSC();
  const allowStack = el('allow-stack').checked;
  const allowBack  = el('allow-back') ? el('allow-back').checked : true;
  pushUndo('optimize run');

  /* ---- Phase 0: the pins. Checked for problems, then handed to the packer as
     immovable seed boxes so nothing is ever placed through them. ---- */
  let seed = []; const pinIssueMap = new Map();
  const addPinIssue=(cab,why)=>{
    const old=pinIssueMap.get(cab.id)||{cab,why:[]};
    old.why=[...new Set(old.why.concat(why))]; pinIssueMap.set(cab.id,old);
  };
  for(const cab of cabinets){
    if(!cab.pin) continue;
    const p = pinBox(cab);
    if(!window.CLO_RULES_V2){
      const chk = checkPlace(g, seed, gap, p, ply);
      if(!chk.ok){ p.warn = chk.why.join('; '); addPinIssue(cab,chk.why); }
    }
    seed.push(p);
  }
  if(window.CLO_RULES_V2){
    const api=window.CLO_RULES_V2;
    const state=api.analyzeLoadState(g,seed,gap,ply);
    seed=state.boxes;
    for(const p of seed){
      const others=state.boxes.filter(q=>q.cab.id!==p.cab.id);
      const validation=api.validatePlacement(g,gap,Object.assign({},p,{standMargin:SC}),ply,{boxes:others});
      const vs=state.byCabinetId[p.cab.id]||[];
      const why=[...new Set([
        ...(!validation.ok ? [validation.message] : []),
        ...vs.map(v=>v.message)
      ].filter(Boolean))];
      if(!why.length) continue;
      p.warn=[p.warn,...why].filter(Boolean).join('; ');
      addPinIssue(p.cab,why);
    }
  }
  const pinIssues=[...pinIssueMap.values()];
  if(pinIssues.length){
    results = { trailer:t, geom:g, placed:seed, failed:[], gap, ply, pinIssues };
    resequence(); saveAll(); updateStats();
    say('Optimize stopped: fix the highlighted pinned cabinet placement(s) before packing around them.', 'warn');
    if(!el('tab-manual').classList.contains('hidden')) renderManual();
    return;
  }

  /* ---- Everything else: the app's own engine packs around them. packLoad()
     owns the loading rules -- bases upright on the deck, tall and wall cabinets
     on their side with the end panel down, panels and trim lying flat in the
     gaps, a cabinet face up only as a last resort and never on the floor. The
     V2 may allow a bounded protected face-up stack only when every interface
     passes its support, coverage, bulk, restraint and depth checks. Those rules
     live in ONE place. Do not restate them here. ---- */
  const r = packLoad(cabinets.filter(c=>!c.pin), g,
                     { gap, ply, allowStack, allowBack, standMargin:SC, seed });

  results = { trailer:t, geom:g, placed:r.placed, failed:r.failed, gap, ply, pinIssues };
  resequence();
  saveAll();
  updateStats();

  /* ---- Baseline: the answer the algorithm gave, before anybody touched it.
     Hand-pinned boxes are left out, because the packer did not choose those and
     moving one later says nothing about the rules. ---- */
  M.runId = 'r' + Date.now();
  M.baseline = {};
  for(const p of r.placed){ if(!p.pinned) M.baseline[p.cab.id] = boxSig(p); }
  M.baseFailed = new Set(r.failed.map(c=>c.id));
  emit('clo:optimize', {
    runId: M.runId, at: Date.now(), job: el('job-name').value || '',
    trailer: { id:t.id, name:t.name, type:t.type, w:t.w, h:t.h, len:t.len,
               totalL: Math.round(g.totalL) },
    opts: { gap, ply, allowStack, allowBack, standMargin:SC },
    loaded: r.placed.length, pinnedCount: r.placed.filter(p=>p.pinned).length,
    baseline: Object.keys(M.baseline).reduce((o,id)=>{
      const p = r.placed.find(q=>q.cab.id===id);
      o[id] = Object.assign({ rc:p.cab.rc, name:p.cab.name, cls:p.cls || cabClass(p.cab),
                              w:p.cab.w, h:p.cab.h, d:p.cab.d }, M.baseline[id]);
      return o;
    }, {}),
    failed: r.failed.map(c=>({ cabId:c.id, rc:c.rc, name:c.name, cls:cabClass(c),
                               w:c.w, h:c.h, d:c.d }))
  });

  const onManual = !el('tab-manual').classList.contains('hidden');
  if(onManual){ renderManual(); draw3D(); }
  else { document.querySelector('[data-tab="tab-3d"]').click(); draw3D(); }

  const nPin = r.placed.filter(p=>p.pinned).length;
  if(pinIssues.length){
    say(`${pinIssues.length} pinned cabinet(s) need a look: ` +
        pinIssues.map(p=>`${p.cab.rc} (${p.why.join(', ')})`).join(' \u00b7 '), 'warn');
  } else if(nPin){
    say(`Packed ${r.placed.length-nPin} cabinet(s) around ${nPin} pinned.`, 'ok');
  }
};

/* ============================================================================
   THE 3D VIEW, SHARED BETWEEN TWO TABS
   The app builds one scene, one camera and one WebGL renderer bound to
   #canvas3d. Rather than stand up a second context here, the renderer's canvas
   element is moved into whichever panel is on screen. OrbitControls stays
   attached to that same element, so dragging keeps working after a move.
   ============================================================================ */
function host3D(){ return el(M.host3d) || el('canvas3d'); }

/* Replaces the app's resize3D so it measures the panel the canvas is actually
   sitting in. init3D() registers this on window.resize by name, so overriding
   it before the first init is enough for both paths. */
window.resize3D = function(){
  if(!threeReady) return;
  const c = host3D(); if(!c) return;
  const w = c.clientWidth, h = c.clientHeight;
  if(w < 2 || h < 2) return;                  // panel is hidden — leave it alone
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
};
function mount3D(id){
  M.host3d = id;
  if(!threeReady) init3D();                   // sizes against a hidden div; fixed below
  const host = el(id);
  if(!host || !renderer) return;
  if(renderer.domElement.parentNode !== host) host.appendChild(renderer.domElement);
  bindPicking();
  resize3D();
  requestAnimationFrame(()=>resize3D());      // again once the layout has settled
}

/* The app's cabinet meshes carry no back-reference to the load, so match them
   to their boxes by centre point. Both are computed from the same arithmetic in
   the same order, so the comparison is exact rather than approximate. Trailer
   parts (gooseneck deck, wheel wells, ledges) match nothing and are skipped. */
function tagPicks(){
  M.picks = [];
  if(!threeReady || !loadGroup || !results) return;
  const g = results.geom, ox = -g.W/2, oz = -g.totalL/2;
  const key = (a,b,c) => a.toFixed(2)+'|'+b.toFixed(2)+'|'+c.toFixed(2);
  const byCentre = new Map();
  for(const p of results.placed)
    byCentre.set(key(p.x+p.w/2+ox, p.y+p.h/2, p.z+p.d/2+oz), p);
  for(const ch of loadGroup.children){
    if(!ch.isMesh || !ch.geometry || ch.geometry.type !== 'BoxGeometry') continue;
    const p = byCentre.get(key(ch.position.x, ch.position.y, ch.position.z));
    if(!p) continue;
    ch.userData.cid = p.cab.id;
    M.picks.push(ch);
  }
}
/* Ring the selected cabinet so it is findable from any camera angle: a bright
   outline plus a post running up to the ceiling. */
function highlight3D(){
  if(!threeReady || !loadGroup || !results || !M.sel) return;
  const p = boxOf(M.sel.cab); if(!p) return;
  const g = results.geom, ox = -g.W/2, oz = -g.totalL/2;
  const cx = p.x+p.w/2+ox, cy = p.y+p.h/2, cz = p.z+p.d/2+oz;
  const geo = new THREE.BoxGeometry(p.w+1.5, p.h+1.5, p.d+1.5);
  const ring = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
                 new THREE.LineBasicMaterial({ color:0x2563eb }));
  ring.position.set(cx, cy, cz);
  loadGroup.add(ring);
  geo.dispose();
  loadGroup.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(cx, p.y+p.h, cz), new THREE.Vector3(cx, g.H, cz)]),
    new THREE.LineDashedMaterial({ color:0x2563eb })));
}

/* A press-and-release that did not travel is a click, not an orbit. */
function bindPicking(){
  if(!renderer || renderer.domElement.dataset.mlPick) return;
  const dom = renderer.domElement;
  dom.dataset.mlPick = '1';
  let sx = 0, sy = 0, travel = 0, btn = 0;
  dom.addEventListener('pointerdown', e=>{ sx=e.clientX; sy=e.clientY; travel=0; btn=e.button; });
  dom.addEventListener('pointermove', e=>{
    travel = Math.max(travel, Math.abs(e.clientX-sx) + Math.abs(e.clientY-sy)); });
  dom.addEventListener('pointerup', e=>{
    if(btn !== 0 || travel > 6) return;       // that was a camera move
    if(M.host3d !== 'ml-3d') return;          // only the Manual Layout copy selects
    pick3D(e);
  });
}
function pick3D(evt){
  if(!results || !M.picks.length) return;
  const r = renderer.domElement.getBoundingClientRect();
  const nd = new THREE.Vector2(((evt.clientX-r.left)/r.width)*2 - 1,
                              -((evt.clientY-r.top)/r.height)*2 + 1);
  M.ray = M.ray || new THREE.Raycaster();
  M.ray.setFromCamera(nd, camera);
  const hits = M.ray.intersectObjects(M.picks, false);
  if(!hits.length){
    M.sel = null; say('Nothing there — tap a cabinet to pick it up.');
    renderCanvas(); renderTools(); renderPalette(); draw3D();
    return;
  }
  const cab = cabinets.find(c=>c.id === hits[0].object.userData.cid);
  if(!cab) return;
  M.sel = { kind:'placed', cab };
  const p = boxOf(cab);
  say(`${cab.rc} selected — ${poseText(p)}${p.rot?', turned 90°':''}, `
    + `${fmtDim(M.g.totalL-(p.z+p.d))}" from the rear doors. Use the buttons or arrow keys to move it.`, 'ok');
  renderCanvas(); renderTools(); renderPalette(); draw3D();
}

/* ============================================================================
   TAB PLUMBING
   ============================================================================ */
window.showTab = function(btn){
  document.querySelectorAll('.tabbtn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  /* every tab section, found by id, so a further add-on tab is hidden too */
  document.querySelectorAll('main > section[id^="tab-"]').forEach(e=>e.classList.add('hidden'));
  el(btn.dataset.tab).classList.remove('hidden');
  if(btn.dataset.tab==='tab-3d'){ init3D(); mount3D('canvas3d'); }
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
            <div class="col-span-2"><span class="lbl">Views</span>
              <select id="ml-view">
                <option value="both" selected>3D and top-view plan</option>
                <option value="3d">3D only</option>
                <option value="plan">Top-view plan only</option>
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
        <div class="flex items-center gap-1.5 flex-wrap">
          <button class="btn btn-gray !py-1 !px-2 text-xs" id="ml-undo">↶ Undo</button>
          <button class="btn btn-gray !py-1 !px-2 text-xs" id="ml-redo">↷ Redo</button>
          <span class="text-[11px] text-slate-400">Ctrl+Z / Ctrl+Shift+Z</span>
        </div>
        <div id="ml-status" class="text-xs rounded px-3 py-2"></div>
        <div id="ml-3d-panel" class="bg-slate-800 rounded-lg overflow-hidden relative" style="height:44vh">
          <div id="ml-3d" class="w-full h-full"></div>
          <div class="absolute top-2 left-2 bg-white/90 rounded px-2 py-1 text-[10px] text-slate-600 pointer-events-none">
            Drag a cabinet to move it · drag empty space to orbit · right-drag to pan · scroll to zoom
          </div>
        </div>
        <div id="ml-canvas" class="bg-white rounded-lg shadow p-2 overflow-auto"></div>
        <div class="text-[11px] text-slate-500 leading-relaxed">
          Top view — front of the trailer at the left, rear doors at the right. Drag a box to move it,
          or pick one in the 3D view and move it with the buttons.
          Keys: <b>R</b> turn 90° · <b>P</b> change how it lies · <b>[</b> / <b>]</b> down / up a layer ·
          ← → nudge fore/aft, ↑ ↓ nudge across · <b>Backspace</b> take it back out · <b>Esc</b> deselect.
        </div>
      </div>
    </div>`;
  document.querySelector('main').appendChild(sec);

  el('ml-snap').addEventListener('change', e=>{ M.snap = parseFloat(e.target.value); });
  el('ml-layer').addEventListener('change', e=>{ M.layer = e.target.value; renderCanvas(); });
  el('ml-magnet').addEventListener('change', e=>{ M.magnet = e.target.checked; });
  el('ml-view').addEventListener('change', e=>{ M.view = e.target.value; applyView(true); });
  el('ml-undo').addEventListener('click', undoLast);
  el('ml-redo').addEventListener('click', redoLast);
  el('ml-pinall').addEventListener('click', ()=>{
    if(!results) return say('Nothing is loaded yet.', 'warn');
    pushUndo('pin everything placed');
    let n=0; for(const p of results.placed){ if(!p.cab.pin){ p.cab.pin={x:rnd(p.x),y:rnd(p.y),z:rnd(p.z),pose:p.pose,rot:p.rot}; p.pinned=true; n++; } }
    say(`Pinned ${n} cabinet(s) where they sit.`, 'ok'); saveAll(); refreshAll();
  });
  el('ml-unpinall').addEventListener('click', ()=>{
    pushUndo('unpin all');
    let n=0; for(const c of cabinets) if(c.pin){ delete c.pin; n++; }
    if(results) results.placed.forEach(p=>{ p.pinned=false; delete p.warn; });
    say(`Unpinned ${n} cabinet(s) — they stay where they are until the next run.`); saveAll(); refreshAll();
  });
  el('ml-clearpins').addEventListener('click', ()=>{
    if(!pinned().length) return say('There are no hand placements.', 'warn');
    if(!confirm('Remove every hand placement? Cabinets go back to being packed automatically.')) return;
    pushUndo('clear hand placements');
    clearHandPlacements();
  });
  paintUndoBtns();
}

/* Which of the two views is on screen. Hiding a panel makes its width zero, so
   the renderer is resized only once its panel is back. */
function applyView(redraw){
  const p3 = el('ml-3d-panel'), pp = el('ml-canvas');
  if(!p3 || !pp) return;
  p3.classList.toggle('hidden', M.view === 'plan');
  pp.classList.toggle('hidden', M.view === '3d');
  p3.style.height = M.view === '3d' ? '72vh' : '44vh';
  if(M.view !== 'plan'){ mount3D('ml-3d'); if(redraw) draw3D(); }
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
  paintUndoBtns();
  applyView();
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
               data-cid="${escAttr(c.id)}" style="touch-action:none">
        <span class="w-2.5 h-2.5 rounded-sm flex-none" style="background:${roomColor(c)}"></span>
        <div class="min-w-0 leading-tight">
          <div class="text-xs font-bold truncate">${esc(c.rc)} <span class="font-normal text-slate-500">${esc(c.name)}</span></div>
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
    <div class="text-xs font-bold mb-0.5">${esc(cab.rc)} <span class="font-normal text-slate-500">${esc(cab.name)}</span></div>
    <div class="text-[11px] text-slate-500 mb-2">
      ${fmtDim(cab.w)} × ${fmtDim(cab.h)} × ${fmtDim(cab.d)} · lying <b>${poseText({pose})}</b>${rot?', turned 90°':''}<br>
      Footprint ${fmtDim(bx.d)}" along the trailer × ${fmtDim(bx.w)}" across, ${fmtDim(bx.h)}" tall
      ${p ? `<br>${fmtDim(M.g.totalL-(p.z+p.d))}" from the rear doors, ${fmtDim(p.x)}" from the left wall${Math.abs(p.y-floorYAt(M.g,p.z))<0.5?'':', stacked at '+fmtDim(p.y)+'"'}` : ''}
      ${p && p.warn ? `<br><span class="text-red-600 font-bold">⚠ ${esc(p.warn)}</span>` : ''}
    </div>
    <div class="flex flex-wrap gap-1.5">
      <button class="btn btn-gray !py-1 !px-2 text-xs" data-act="rot" title="Swap which way it faces across the trailer">↻ Turn 90°</button>
      <button class="btn btn-gray !py-1 !px-2 text-xs" data-act="pose" title="Cycle face up → on its side → standing upright">⇅ Lying ${POSE_SHORT[pose]}</button>
    </div>
    ${p?`
    <div class="mt-2 flex items-start gap-3">
      <div>
        <span class="lbl">Move by ${fmtDim(M.snap)}"</span>
        <div class="grid grid-cols-3 gap-1" style="width:7.5rem">
          <span></span>
          <button class="btn btn-gray !py-1 !px-0 justify-center text-xs" data-act="toLeft" title="Toward the left wall">↑</button>
          <span></span>
          <button class="btn btn-gray !py-1 !px-0 justify-center text-xs" data-act="fwd" title="Toward the front of the trailer">←</button>
          <span></span>
          <button class="btn btn-gray !py-1 !px-0 justify-center text-xs" data-act="aft" title="Toward the rear doors">→</button>
          <span></span>
          <button class="btn btn-gray !py-1 !px-0 justify-center text-xs" data-act="toRight" title="Toward the right wall">↓</button>
          <span></span>
        </div>
      </div>
      <div>
        <span class="lbl">Layer</span>
        <div class="flex flex-col gap-1">
          <button class="btn btn-gray !py-1 !px-2 text-xs" data-act="layerUp" title="Up onto the next surface">↑ Up a layer</button>
          <button class="btn btn-gray !py-1 !px-2 text-xs" data-act="layerDown" title="Down onto the surface below">↓ Down a layer</button>
        </div>
      </div>
    </div>
    <div class="flex flex-wrap gap-1.5 mt-2 pt-2 border-t">
      ${cab.pin?`<button class="btn btn-gray !py-1 !px-2 text-xs" data-act="unpin">Unpin, leave it</button>`:
                `<button class="btn btn-blue !py-1 !px-2 text-xs" data-act="pinhere">📌 Pin here</button>`}
      <button class="btn btn-red !py-1 !px-2 text-xs" data-act="out">Take back out</button>
    </div>`:''}`;
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
    + (M.msg ? ` — ${esc(M.msg)}` : '');
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
            ${p.pinned&&!seld?'stroke-dasharray="7 3"':''} ${hidden?'':'class="ml-box"'} data-cid="${escAttr(p.cab.id)}"/>`;
    if(hidden) continue;
    const fs = Math.max(6.5, Math.min(12, p.d*sc/4, p.w*sc/3));
    s += `<text x="${sx(p.z+p.d/2)}" y="${sy(p.x+p.w/2)-fs*0.15}" font-size="${fs}" font-weight="bold"
            fill="#0f172a" text-anchor="middle" dominant-baseline="middle" pointer-events="none"
            >${p.pinned?'📌':''}${esc(p.cab.rc)}</text>`;
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

function beginDragAt(q, cab, existing){
  const pose = existing ? existing.pose : M.pose;
  const rot  = existing ? existing.rot  : M.rot;
  const others=results.placed.filter(p=>p.cab.id!==cab.id), gap=curGap(), ply=curPly();
  const api=window.CLO_RULES_V2;
  const state=api ? api.analyzeLoadState(M.g,others,gap,ply) : null;
  M.drag = { cab, pose, rot, from:existing||null,
             grab: existing && q ? {dz:q.z-existing.z, dx:q.x-existing.x} : null,
             yIdx: null, moved:false, box:null,
             validation:{others,gap,ply,boxes:state?state.boxes:others}, pointerId:null };
  return M.drag;
}
function startDrag(evt, cab, existing){
  evt.preventDefault();
  const d=beginDragAt(existing && overSvg(evt) ? svgPt(evt) : null, cab, existing);
  d.pointerId=evt.pointerId;
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp);
  window.addEventListener('pointercancel', onDragCancel);
}
function v2Check(g, others, gap, box, ply, prepared){
  const poseClearance=typeof validatePoseClearance==='function'
    ? validatePoseClearance(box.cab, box.pose, box.y, g.H, curSC())
    : {ok:box.pose!=='upright', message:'Cannot verify upright tip-up clearance.'};
  if(!poseClearance.ok) return {ok:false, code:poseClearance.code, why:[poseClearance.message], supported:false};
  const api=window.CLO_RULES_V2;
  if(!api || typeof api.validatePlacement!=='function') return checkPlace(g,others,gap,box,ply);
  const state=prepared ? {boxes:prepared.boxes} : api.analyzeLoadState(g,others,gap,ply);
  const candidate=Object.assign({},box,{cls:cabClass(box.cab||{}),standMargin:curSC()});
  const result=api.validatePlacement(g,gap,candidate,ply,state);
  return result.ok
    ? {ok:true, why:[], supported:true, report:result.report}
    : {ok:false, v2Rejected:true, code:result.code, why:[result.message || 'The active V2 rules refuse this spot.'], supported:false};
}
function annotateExistingLayout(g, boxes, gap, ply){
  const api=window.CLO_RULES_V2;
  for(const p of boxes){
    delete p.warn;
    const others=boxes.filter(q=>q!==p);
    if(api && typeof api.validatePlacement==='function'){
      const validation=api.validatePlacement(g,gap,Object.assign({},p,{standMargin:curSC()}),ply,{boxes:others});
      if(!validation.ok) p.warn=validation.message;
    } else {
      const chk=checkPlace(g,others,gap,p,ply);
      if(!chk.ok) p.warn=chk.why.join('; ');
    }
  }
  if(!api) return boxes;
  const state=api.analyzeLoadState(g,boxes,gap,ply);
  const byId=new Map(boxes.map(p=>[p.cab.id,p]));
  for(const p of state.boxes){
    const target=byId.get(p.cab.id), violations=state.byCabinetId[p.cab.id]||[];
    if(!target || !violations.length) continue;
    const messages=[...new Set(violations.map(v=>v.message))];
    target.warn=[target.warn,...messages].filter(Boolean).join('; ');
  }
  return boxes;
}
function dragBoxAt(q, d){
  const g = M.g, gap = d.validation.gap, ply = d.validation.ply;
  const others = d.validation.others;
  const dim = poseBox(d.cab, d.pose, d.rot);
  let box = { x:snapv(q.x - (d.grab? d.grab.dx : dim.w/2)),
              z:snapv(q.z - (d.grab? d.grab.dz : dim.d/2)),
              y:0, w:dim.w, h:dim.h, d:dim.d, pose:d.pose, rot:d.rot, cab:d.cab };
  box.x = Math.max(0, Math.min(box.x, g.W - box.w));
  box.z = Math.max(0, Math.min(box.z, g.totalL - box.d));
  box = magnet(g, others, box, gap);
  /* pick a height: the level the user asked for, else the lowest that works */
  const ys = candidateYs(g, others, box.x, box.z, box.w, box.d, ply);
  let chosen = null;
  if(d.yIdx!=null && ys[Math.min(d.yIdx, ys.length-1)]!=null){
    chosen = ys[Math.min(d.yIdx, ys.length-1)];
  } else {
    for(const y of ys){ if(v2Check(g, others, gap, Object.assign({},box,{y}), ply,d.validation).ok){ chosen = y; break; } }
    if(chosen==null) chosen = ys[0];
  }
  box.y = chosen;
  const chk = v2Check(g, others, gap, box, ply,d.validation);
  return { box, chk, levels:ys };
}
function dragBox(evt, d){ return dragBoxAt(svgPt(evt),d); }
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
  if(d.pointerId!=null && evt.pointerId!==d.pointerId) return;
  d.moved = true;
  if(!overSvg(evt)){ hideGhost(); d.box = null; return; }
  const {box, chk} = dragBox(evt, d);
  d.box = box; d.chk = chk;
  paintGhost(box, chk);
  say(chk.ok ? `${fmtDim(M.g.totalL-(box.z+box.d))}" from the rear doors, ${fmtDim(box.x)}" from the left wall`
             : chk.why.join('; '), chk.ok ? 'ok' : 'warn');
}
function cleanup2DDrag(){
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragUp);
  window.removeEventListener('pointercancel', onDragCancel);
}
function onDragCancel(evt){
  const d=M.drag; if(!d || (d.pointerId!=null && evt.pointerId!==d.pointerId)) return;
  cleanup2DDrag(); M.drag=null; hideGhost(); say('Move cancelled.'); renderTools();
}
function onDragUp(evt){
  const live=M.drag; if(!live || (live.pointerId!=null && evt.pointerId!==live.pointerId)) return;
  cleanup2DDrag();
  const d = M.drag; M.drag = null;
  hideGhost();
  if(!d) return;
  if(overSvg(evt)){
    const {box, chk} = dragBox(evt, d);
    if(!chk.ok){
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
  commit(cab, box, n ? 'nudge' : '');
}
document.addEventListener('keydown', e=>{
  const t = el('tab-manual');
  if(!t || t.classList.contains('hidden')) return;
  const tag = (e.target.tagName||'').toLowerCase();
  if(tag==='input' || tag==='select' || tag==='textarea') return;
  if((e.ctrlKey||e.metaKey) && (e.key==='z'||e.key==='Z')){
    e.preventDefault(); e.shiftKey ? redoLast() : undoLast(); return;
  }
  if((e.ctrlKey||e.metaKey) && (e.key==='y'||e.key==='Y')){ e.preventDefault(); redoLast(); return; }
  if(e.key==='Escape'){ M.sel=null; renderCanvas(); renderTools(); renderPalette(); draw3D(); return; }
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
  /* tag first, so the outline added below is never itself pickable */
  tagPicks();
  highlight3D();
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
      <div><b>${esc(p.cab.rc)}</b> ${esc(p.cab.name)}${p.pinned?' <span title="placed by hand">📌</span>':''}${isBulky(p.cab)?' <span class="text-[9px] font-bold text-white bg-orange-500 rounded px-1">2+ ppl</span>':''}<br>
      <span class="text-slate-500">${fmtDim(p.cab.w)}×${fmtDim(p.cab.h)}×${fmtDim(p.cab.d)} · ${fromRear.toFixed(0)}" from rear · ${p.x.toFixed(0)}" from left${onFloor?'':' · stacked at '+p.y.toFixed(0)+'"'} · <b class="text-slate-600">${poseText(p)}</b>${p.rot?', turned 90°':''}</span>
      ${p.warn?`<br><span class="text-red-600 text-[10px] font-bold">⚠ ${esc(p.warn)}</span>`:''}</div>
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
        <span style="font-weight:700">${esc(p.cab.rc)}</span> ${esc(p.cab.name)}
        ${p.pinned?'<span style="border:1.5px solid #d97706;color:#92400e;font-size:9px;font-weight:800;padding:0 5px;border-radius:8px;margin-left:4px;white-space:nowrap">SET SPOT</span>':''}
        ${big?'<span style="background:#ea580c;color:#fff;font-size:9px;font-weight:800;padding:1px 6px;border-radius:8px;margin-left:4px;white-space:nowrap">LARGE · 2+ PEOPLE</span>':''}
        <div style="font-size:11px;color:#475569">${fmtDim(p.cab.w)}×${fmtDim(p.cab.h)}×${fmtDim(p.cab.d)} · <b>${poseText(p)}</b>${p.rot?', turned 90°':''} · ${fmtDim(fromRear)}" from rear doors, ${fmtDim(p.x)}" from left wall</div>
        ${p.warn?`<div style="font-size:11px;color:#b91c1c;font-weight:700">⚠ ${esc(p.warn)}</div>`:''}
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
      <td><b>${esc(p.cab.rc)}</b></td><td>${esc(p.cab.name)}</td>
      <td>${fmtDim(g.totalL-(p.z+p.d))}" fwd of rear doors, ${fmtDim(p.x)}" from left wall${Math.abs(p.y-floorYAt(g,p.z))<0.5?'':', stacked at '+fmtDim(p.y)+'"'}</td>
      <td><b>${poseText(p).replace(/^./,c=>c.toUpperCase())}</b>${p.rot?' · turned 90°':''}</td>
      <td style="color:${p.warn?'#b91c1c':'#166534'}">${p.warn? '⚠ '+esc(p.warn) : 'OK'}</td>
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

/* Small, read-mostly bridge used by drag-3d.js. Placement rules and commit
   ownership stay here so 2D and 3D cannot drift into separate algorithms. */
window.CLO_ML = {
  beginDragAt,
  dragBoxAt,
  validatePlacement:v2Check,
  clearHandPlacements,
  commit,
  getPickables:()=>M.picks.slice(),
  getDragState:()=>M.drag,
  getPlacedBox:cab=>boxOf(cab),
  getGeometry:()=>M.g,
  selectCabinet:cab=>{ M.sel={kind:'placed',cab}; },
  cancelDrag:()=>{ M.drag=null; }
};

/* ============ boot ============ */
injectUI();
if(pinned().length){ ensureResults(); refreshAll(); }

})();
