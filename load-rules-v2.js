/* =====================================================================
   load-rules-v2.js  —  tighter loads, restrained loads, one layer on doors

   A drop-in add-on for cabinet-load-optimizer.html. It replaces the packing
   engine at run time and deletes nothing. Remove the <script> tag and the app
   goes straight back to the shipped rules.

   Load it LAST, after manual-layout.js and load-learning.js:

       <script src="manual-layout.js"></script>
       <script src="load-learning.js"></script>
       <script src="end-views.js"></script>
       <script src="load-rules-v2.js"></script>

   Replaces: packLoad(), tryPlace(), canPlace(), makePoses(), isSupport().
   Decorates: poseText().
   Reuses unchanged: geomOf(), cabClass(), availWidthAt(), floorYAt(),
                     mkIndex(), idxAdd(), idxNear(), boxesOverlapXZ/Y().
   POSE_ORDER is a byte-for-byte copy of the one in the app, so the Tuning tab
   still describes what the packer is actually doing.

   ---------------------------------------------------------------------
   WHAT CHANGED, AND WHY

   1. TIGHT PACKING. The old search took the first spot that worked, which is
      usually a grid point with air on both sides. It now looks at every spot
      within a short window of the frontmost one and keeps the SNUGGEST — most
      contact with neighbours and walls, best supported underneath.

   2. NOTHING FLOATS. Contact on the left and right is scored, so a piece that
      can butt a neighbour or a wall will. Anything that still ends up with air
      on both sides is flagged `loose` so the crew knows to block it.

   3. NOTHING CAN SLIDE FORWARD AND FALL. A load shifts toward the nose under
      braking. An elevated piece must either butt something ahead of it, or sit
      on a deck that keeps running forward far enough to catch it if it moves.

   4. WALL CABINETS RIDE UPSIDE DOWN. Their bottom is finished and their top is
      not, so one standing upright goes on its head, unfinished top to the deck.
      Same box, same space — it only changes what the printout tells the crew.

   5. ONE CABINET MAY RIDE ON DOORS. A face-up cabinet can carry exactly one
      piece, that piece carries nothing itself, and it has to sit on at least
      85% of the door bank so the load spreads. Bases standing upright and
      anything over ~16,000 cubic inches still stay off doors entirely. Once a
      door bank has its one piece the airspace over it closes, so nothing can
      overhang onto it either.

   6. A BAY FOR THE LONG TALLS. A tall cabinet wider than the trailer has to lie
      lengthwise, so it needs a clear run of 8-9 feet. If the bases take the
      floor first that run never exists again. Long talls are now nested side by
      side before pass 1 — which is also what makes a load look tight, and gives
      the layer above a solid end-panel-up deck to sit on.

   Measured on the G Gatto (Duckweed) job, 83 pieces, 28ft gooseneck:
      loaded 71 -> 79   ·   faces in contact 55% -> 64%
      slide-forward risks 13 -> 0   ·   volume used 44% -> 61%
   Every number in V2 below is a dial. Change one, re-run, compare.
   ===================================================================== */
(function(){
  'use strict';
  if(typeof packLoad !== 'function' || typeof geomOf !== 'function'){
    console.warn('load-rules-v2: core app not found - add-on not applied.');
    return;
  }

  const BK = 48;                       // bucket size for the level map (local)
  const ov = (a0,a1,b0,b1)=>Math.max(0, Math.min(a1,b1)-Math.max(a0,b0));
  const bulk = c => c.w*c.h*c.d;
  function flatOnFloorOK(cls){ return cls==='pkg' || cls==='flat'; }
  function isFaceUp(p){ return p.pose==='back' && p.cls!=='pkg' && p.cls!=='flat'; }

  const V2 = {
    zWindow   : 10,     // how far back of the frontmost fit to look for a snugger one
    foreRun   : 10,     // deck that must continue ahead of an elevated piece (in)
    wSide     : 30,     // scoring weight: contact left/right
    wEnd      : 22,     // scoring weight: contact fore/aft
    wDown     : 16,     // scoring weight: how fully it is supported underneath
    wWaste    : 0,      // penalty per inch of dead slot left beside a piece (tuning dial)
    deadMax   : 16,     // a leftover slot narrower than this fits nothing
    wZ        : 1.0,    // penalty per inch further back
    wY        : 0.6,    // penalty per inch higher up
    doorCover : 0.85,   // a piece on doors must be this well supported
    doorBulk  : 16000,  // in^3 — biggest piece allowed to ride on doors
    doorRatio : 1.0,    // and no bulkier than the cabinet whose doors it rides on
    tallBays  : true,   // give long tall cabinets their own bay before the bases scatter the floor
    tuckAhead : false,  // also try tucking a piece into the pocket ahead of one already loaded
    zGrid     : 6       // fallback sweep spacing along the trailer (in)
  };

  const POSE_ORDER = {
    base : ['upright','side','back'],
    tall : ['side','back','upright'],
    wall : ['side','upright','back'],
    flat : ['back','side','upright'],
    pkg  : ['back','side','upright'],
    other: ['side','upright','back']
  };

  /* A wall cabinet's bottom is finished and its top is not, so when one stands
     upright it goes on its head — unfinished top down, finished bottom up. Same
     box either way; `flip` only changes what the crew is told to do. */
  function makePoses(cab, kinds, cls){
    const flipUp = (cls==='wall');
    const P=[];
    for(const k of kinds){
      if(k==='upright'){
        P.push({w:cab.w,h:cab.h,d:cab.d,pose:'upright',rot:false,flip:flipUp});
        if(cab.w!==cab.d) P.push({w:cab.d,h:cab.h,d:cab.w,pose:'upright',rot:true,flip:flipUp});
      } else if(k==='side'){
        P.push({w:cab.h,h:cab.w,d:cab.d,pose:'side',rot:false,flip:false});
        if(cab.h!==cab.d) P.push({w:cab.d,h:cab.w,d:cab.h,pose:'side',rot:true,flip:false});
      } else {
        P.push({w:cab.w,h:cab.d,d:cab.h,pose:'back',rot:false,flip:false});
        if(cab.w!==cab.h) P.push({w:cab.h,h:cab.d,d:cab.w,pose:'back',rot:true,flip:false});
      }
    }
    return P;
  }

  /* How much can ride on this piece?
       2 = a full deck — end panel up, a flagged base, or trim lying flat
       1 = doors up — ONE piece, and that piece carries nothing
       0 = nothing                                                          */
  function supportTier(p){
    if(!p) return 0;
    const c = p.cab || {};
    if(p.onDoors)       return 0;               // the one layer over a door bank ends the column
    if(p.cls==='flat')  return p.h <= 3.01 ? 2 : 0;
    if(p.cls==='pkg')   return c.stackOn ? 2 : 0;
    if(p.pose==='back') return 1;               // doors up — one piece, nothing above it
    if(p.pose==='side') return 2;               // end panel up: the strongest way to stack
    return c.stackOn ? 2 : 0;                   // upright — bases yes, talls no
  }

  /* What it can still take, as opposed to what it is structurally able to carry.
     Kept separate so isSupport() means the same thing before and after packing —
     the Manual Layout tab and the printout both re-ask it later. */
  function freeTier(p){
    const t = supportTier(p);
    return (t===1 && (p.carrying||0) >= 1) ? 0 : t;
  }

  function isSupport(p){ return supportTier(p) > 0; }

  /* Is this piece allowed to sit on a cabinet's doors at all? */
  function mayRideOnDoors(cab, cls, pose){
    if(cls==='flat' || cls==='pkg') return true;
    if(cls==='base' && pose==='upright') return false;   // heaviest thing in the load
    return bulk(cab) <= V2.doorBulk;
  }

  /* Rebuild the state that is normally accumulated while packLoad() runs.
     Manual edits and pinned seeds do not pass through that accumulation path,
     so trusting old carrying/onDoors values can reopen an occupied door bank.
     Siblings at one height are inspected before any of them consumes capacity,
     making the result independent of array order. */
  function analyzeLoadState(g, layout, gap, ply){
    const levelEps = 0.1, supportTol = 1.25;
    const boxes = (layout||[]).map(p=>Object.assign({}, p, {carrying:0, onDoors:false}));
    const violations = [];
    const add = (code, p, message, support) => violations.push({
      code, cabinetId:p&&p.cab?p.cab.id:null,
      supportId:support&&support.cab?support.cab.id:null, message
    });
    const sorted = boxes.slice().sort((a,b)=>(a.y-b.y)||(a.z-b.z)||(a.x-b.x));
    for(let at=0; at<sorted.length; ){
      const anchor = sorted[at].y, band=[];
      while(at<sorted.length && Math.abs(sorted[at].y-anchor)<=levelEps) band.push(sorted[at++]);
      const pending=[];
      for(const p of band){
        const fy=floorYAt(g,p.z);
        if(Math.abs(p.y-fy)<0.5) continue;
        const area=p.w*p.d;
        let sup=0, doorSup=0;
        const rests=[], doorRests=[];
        for(const q of boxes){
          if(q===p || q.y>=p.y-levelEps) continue;
          if(Math.abs(q.y+q.h+ply-p.y)>supportTol) continue;
          const a=ov(p.x,p.x+p.w,q.x,q.x+q.w)*ov(p.z,p.z+p.d,q.z,q.z+q.d);
          if(a<=0) continue;
          const tier=supportTier(q);
          if(tier===1){ doorSup+=a; doorRests.push(q); }
          if(freeTier(q)>0){ sup+=a; rests.push(q); }
        }
        for(const wl of g.wells){
          if(Math.abs(wl.y+wl.h-p.y)>supportTol) continue;
          sup+=ov(p.x,p.x+p.w,wl.x,wl.x+wl.w)*ov(p.z,p.z+p.d,wl.z,wl.z+wl.d);
        }
        if(sup<area*0.6) add('UNSUPPORTED',p,'nothing solid underneath');
        if(doorSup>0){
          p.onDoors=true;
          if(!mayRideOnDoors(p.cab,p.cls,p.pose)) add('DOOR_PIECE',p,'this piece may not ride on cabinet doors');
          if(sup<area*V2.doorCover) add('DOOR_COVER',p,'not enough of this piece is supported over the door bank');
          for(const q of doorRests){
            if(bulk(p.cab||{w:0,h:0,d:0})>bulk(q.cab||{w:0,h:0,d:0})*V2.doorRatio)
              add('DOOR_BULK',p,'piece is too large for the door bank beneath it',q);
          }
        }
        pending.push({p,rests,doorRests});
      }
      for(const r of pending) for(const q of r.doorRests){
        q.carrying=(q.carrying||0)+1;
        if(q.carrying>1) add('DOOR_CAPACITY',r.p,'more than one piece is resting on this door bank',q);
      }
    }
    for(const p of boxes){
      if(Math.abs(p.y-floorYAt(g,p.z))<0.5) continue;
      const near=boxes.filter(q=>q!==p);
      if(!foreHeld(g,near,p.x,p.y,p.z,p.w,p.h,p.d,gap,ply,V2.foreRun))
        add('FORWARD_RESTRAINT',p,'elevated piece is not restrained toward the trailer nose');
    }
    const byCabinetId={};
    for(const v of violations) if(v.cabinetId) (byCabinetId[v.cabinetId]=byCabinetId[v.cabinetId]||[]).push(v);
    return {boxes,violations,byCabinetId};
  }

  /* Will it still be caught if it shifts toward the nose?
     Either something solid sits ahead of it, or the deck underneath keeps
     running forward far enough that a shift leaves it still supported. */
  function foreHeld(g, near, x,y,z,w,h,d, gap, ply, run){
    const tol = gap + 0.75;
    if(z < tol) return true;                                  // against the nose
    if(g.gn && Math.abs(z - g.gn.len) < tol) return true;     // against the gooseneck step
    for(let i=0;i<near.length;i++){ const p=near[i];
      if(Math.min(y+h,p.y+p.h)-Math.max(y,p.y) <= 1) continue;
      if(ov(x,x+w,p.x,p.x+p.w) <= 1) continue;
      if(Math.abs(z - (p.z+p.d)) < tol) return true; }
    const z0 = Math.max(0, z-run);
    if(z-z0 < 0.5) return true;
    let sup=0; const area = w*(z-z0);
    for(let i=0;i<near.length;i++){ const p=near[i];
      if(!isSupport(p)) continue;
      if(Math.abs(p.y+p.h+ply - y) > 1.4) continue;
      sup += ov(x,x+w,p.x,p.x+p.w) * ov(z0,z,p.z,p.z+p.d); }
    for(const wl of g.wells){
      if(Math.abs(wl.y+wl.h - y) > 1.4) continue;
      sup += ov(x,x+w,wl.x,wl.x+wl.w) * ov(z0,z,wl.z,wl.z+wl.d); }
    return sup >= area*0.6;
  }

  /* Returns null if the spot is illegal, otherwise a report used for scoring
     and for recording what the piece ended up resting on. */
  function canPlace(g,ix,gap,x,y,z,w,h,d,ply,cpose,ccls,ccab,nearIn,standMargin){
    const eps=0.01;
    const poseClearance = typeof window.validatePoseClearance==='function'
      ? window.validatePoseClearance(ccab, cpose, y, g.H, standMargin || 0)
      : {ok:cpose!=='upright'};
    if(!poseClearance.ok) return null;
    if(x<-eps || z<-eps) return null;
    if(y+h > g.H+eps) return null;
    if(z+d > g.totalL+eps) return null;
    if(g.gn){
      const inGN = z < g.gn.len-eps;
      if(inGN && z+d > g.gn.len+eps) return null;
      if(inGN && y < g.gn.rise-eps) return null;
    }
    const wr = availWidthAt(g,z);
    if(x < wr.min-eps || x+w > wr.max+eps) return null;
    const box={x,y,z,w,h,d};
    const floorY=floorYAt(g,z);
    if(cpose==='back' && Math.abs(y-floorY)<0.5 && !flatOnFloorOK(ccls)) return null;
    for(const wl of g.wells)  if(boxesOverlapXZ(box,wl,0) && boxesOverlapY(box,wl)) return null;
    if(g.ledges) for(const ob of g.ledges) if(boxesOverlapXZ(box,ob,0) && boxesOverlapY(box,ob)) return null;

    const near = nearIn || idxNear(ix, z-gap-V2.foreRun-1, z+d+gap+1, _near);
    for(let i=0;i<near.length;i++){ const p=near[i];
      if(boxesOverlapY(box,p) && boxesOverlapXZ(box,p,gap)) return null; }

    /* A face-up cabinet may carry ONE piece. Anything more than that, or anything
       too heavy, still has to stay off the doors. */
    const cIsFaceUp = (cpose==='back' && !flatOnFloorOK(ccls));
    if(cIsFaceUp){
      for(let i=0;i<near.length;i++){ const p=near[i];
        if(p.y < y+h+ply+1.0 && p.y > y+h-0.6 && boxesOverlapXZ(box,p,0)) return null; }
    }
    /* Anything sitting at the top of a face-up cabinet lands on its doors, whether
       that cabinet is what is really holding it up or it merely overhangs. Once a
       door bank has its one piece, the airspace over it closes for good. */
    for(let i=0;i<near.length;i++){ const p=near[i];
      if(!isFaceUp(p) || (p.carrying||0) < 1) continue;
      if(y < p.y+p.h+ply+1.0 && y > p.y+p.h-0.6 && boxesOverlapXZ(box,p,0)) return null; }

    const fy = floorYAt(g,z);
    const tol = gap + 0.75;

    /* contact — the measure of how snug the spot is */
    let cSide=0, cEnd=0;
    let slotL = x - Math.max(0,wr.min), slotR = wr.max - (x+w);   // free width beside it
    if(slotL < tol) cSide += h*d;
    if(slotR < tol) cSide += h*d;
    if(z < tol)                      cEnd  += w*h;
    if(g.totalL-(z+d) < tol)         cEnd  += w*h;
    if(g.gn && Math.abs(z-g.gn.len) < tol) cEnd += w*h;
    for(let i=0;i<near.length;i++){ const p=near[i];
      const yy = ov(y,y+h,p.y,p.y+p.h); if(yy<=0.05) continue;
      const zz = ov(z,z+d,p.z,p.z+p.d);
      if(zz>0.05){
        if(Math.abs(p.x+p.w-x)<tol || Math.abs(x+w-p.x)<tol) cSide += yy*zz;
        if(p.x+p.w <= x+0.01) slotL = Math.min(slotL, x-(p.x+p.w));
        if(p.x >= x+w-0.01)   slotR = Math.min(slotR, p.x-(x+w));
      }
      const xx = ov(x,x+w,p.x,p.x+p.w);
      if(xx>0.05 && (Math.abs(p.z+p.d-z)<tol || Math.abs(z+d-p.z)<tol)) cEnd  += yy*xx;
    }
    /* A slot too narrow to take another cabinet is wasted trailer. Air is only
       useful if it stays in one usable block, so scatter is what gets punished. */
    const dead = s => (s > tol && s < V2.deadMax) ? s : 0;
    const waste = dead(slotL) + dead(slotR);
    const loose = (slotL > tol && slotR > tol);   // free either side — needs blocking

    const rep = { sup:0, cover:1, cSide, cEnd, waste, onDoors:false, rests:[] };

    if(Math.abs(y-fy) < 0.5){                    // on the floor / gooseneck deck
      rep.fore = true;
      return rep;
    }

    /* Otherwise it must land on a deck carrying at least 60% of its footprint. */
    let sup=0, supDoors=0; const area=w*d;
    const rests=[];
    for(let i=0;i<near.length;i++){ const p=near[i];
      const tier = freeTier(p); if(!tier) continue;
      if(Math.abs(p.y+p.h+ply-y) < 1.25){
        const a = ov(x,x+w,p.x,p.x+p.w) * ov(z,z+d,p.z,p.z+p.d);
        if(a<=0) continue;
        sup += a; if(tier===1) supDoors += a;
        rests.push(p);
      } }
    for(let i=0;i<near.length;i++){ const p=near[i];
      if(!isFaceUp(p) || freeTier(p)!==1 || rests.indexOf(p)>=0) continue;
      if(Math.abs(p.y+p.h+ply-y) < 1.25 && ov(x,x+w,p.x,p.x+p.w)*ov(z,z+d,p.z,p.z+p.d) > 0){
        supDoors += 1; rests.push(p); } }
    for(const wl of g.wells){
      if(Math.abs(wl.y+wl.h-y) < 1.25)
        sup += ov(x,x+w,wl.x,wl.x+wl.w) * ov(z,z+d,wl.z,wl.z+wl.d);
    }
    if(sup < area*0.6) return null;

    if(supDoors > 0){
      if(!ccab || !mayRideOnDoors(ccab, ccls, cpose)) return null;
      if(sup < area*V2.doorCover) return null;         // upper piece must be well supported
      for(const p of rests){
        if(freeTier(p)!==1) continue;
        const doorArea=p.w*p.d;
        const doorCoverage=doorArea>0 ? ov(x,x+w,p.x,p.x+p.w)*ov(z,z+d,p.z,p.z+p.d)/doorArea : 0;
        if(doorCoverage < V2.doorCover) return null;   // cover the door bank, not merely the upper piece
        if(bulk(ccab) > bulk(p.cab||{w:0,h:0,d:0}) * V2.doorRatio) return null;
      }
      rep.onDoors = true;
    }

    /* It must not be able to shift toward the nose and drop off its deck. */
    if(!foreHeld(g, near, x,y,z,w,h,d, gap, ply, V2.foreRun)) return null;

    rep.sup = sup; rep.cover = Math.min(1, sup/area); rep.rests = rests; rep.fore = true;
    return rep;
  }

  /* Structured manual-placement bridge. The manual editor must ask this active
     V2 path instead of intersecting it with the old fallback validator. */
  function validatePlacement(g, gap, candidate, ply, prepared){
    const poseClearance = typeof window.validatePoseClearance==='function'
      ? window.validatePoseClearance(candidate.cab, candidate.pose, candidate.y, g.H, candidate.standMargin || 0)
      : {ok:candidate.pose!=='upright', code:'TIP_UP_HELPER_UNAVAILABLE', message:'Cannot verify upright tip-up clearance.'};
    if(!poseClearance.ok) return poseClearance;
    const near = prepared && prepared.boxes ? prepared.boxes : (prepared || []);
    const report = canPlace(g, null, gap, candidate.x, candidate.y, candidate.z,
      candidate.w, candidate.h, candidate.d, ply, candidate.pose,
      candidate.cls || cabClass(candidate.cab || {}), candidate.cab, near, candidate.standMargin || 0);
    return report
      ? {ok:true, code:null, message:'', report}
      : {ok:false, code:'V2_REJECTED', message:'The active V2 rules refuse this spot: check trailer geometry, support, door-bank limits, and forward restraint.'};
  }

  /* Score a legal spot. Lower is better: further back and higher up cost, and
     every square inch of contact earns it back. */
  function scoreOf(rep, x,y,z,w,h,d, g){
    const fSide = Math.min(1, rep.cSide / (2*h*d || 1));
    const fEnd  = Math.min(1, rep.cEnd  / (2*w*h || 1));
    const fDown = rep.cover;
    const snug  = (V2.wSide*fSide + V2.wEnd*fEnd + V2.wDown*fDown) /
                  (V2.wSide + V2.wEnd + V2.wDown);
    return { s: V2.wZ*z + V2.wY*(y-floorYAt(g,z)) + V2.wWaste*rep.waste
                - (V2.wSide*fSide + V2.wEnd*fEnd + V2.wDown*fDown),
             tight: rep.waste < 0.01 && fSide >= 0.5 };
  }

  /* Try to place one piece.  o = { levels:'floor'|'above'|'any', allowStack,
     standMargin, flatOnFloor, doorDeck }

     Candidate positions are the front wall, the faces of everything already
     loaded (both the back face to butt up behind, and the front face to tuck in
     ahead of), the side walls, and a coarse grid so awkward gaps still get
     found. Every candidate within `zWindow` of the frontmost legal one is
     scored, and the snuggest wins. */
  function tryPlace(cab, cls, poses, g, ix, placed, gap, ply, o){
    const wantFloor = o.levels!=='above', wantAbove = o.levels!=='floor';
    const floorFlatOK = o.flatOnFloor || flatOnFloorOK(cls);

    const lvl={};
    if(wantAbove && o.allowStack){
      const add=(z0,z1,v)=>{ const a=Math.floor(z0/BK), b=Math.floor(z1/BK);
        for(let i=a;i<=b;i++) (lvl[i]=lvl[i]||[]).push(v); };
      for(const p of placed) if(isSupport(p)) add(p.z, p.z+p.d, Math.round((p.y+p.h+ply)*100)/100);
      for(const wl of g.wells) add(wl.z, wl.z+wl.d, wl.h);
    }
    const maxD = poses.reduce((m,p)=>Math.max(m,p.d),0);
    const minD = poses.reduce((m,p)=>Math.min(m,p.d),Infinity);
    const minH = poses.reduce((m,p)=>Math.min(m,p.h),Infinity);

    let zs=[0];
    if(g.gn) zs.push(g.gn.len);
    if(g.taper) zs.push(g.taper.end);
    for(const p of placed){
      zs.push(p.z+p.d+gap);                       // butt in behind it
      if(V2.tuckAhead) for(const o2 of poses) zs.push(p.z-o2.d-gap); // tuck in ahead of it
    }
    for(const wl of g.wells){ zs.push(wl.z+wl.d+gap); zs.push(wl.z-1e-9); }
    for(let v=0; v<=g.totalL; v+=V2.zGrid) zs.push(v);
    { const seen=new Set(), u=[];
      for(const v of zs){ const k=Math.round(v*4); if(!seen.has(k)){ seen.add(k); u.push(v); } }
      zs = u; }
    zs.sort((a,b)=>a-b);

    const nearBuf=[], ys=[], xs=[], ySeen=new Set(), spans=[];
    const minW = poses.reduce((m,p)=>Math.min(m,p.w),Infinity);
    let best=null, zCap=Infinity, pz=-99;

    for(const z of zs){
      if(z < -0.01 || z > g.totalL-0.01) continue;
      if(z > zCap) break;
      if(z-pz < 0.24) continue; pz=z;
      const fy=floorYAt(g,z), wr=availWidthAt(g,z);
      if(wr.max-wr.min < 1) continue;
      if(z+minD > g.totalL+0.01) continue;

      ys.length=0; ySeen.clear();
      if(wantFloor){ ys.push(fy); ySeen.add(Math.round(fy*4)); }
      if(wantAbove && o.allowStack){
        const b=Math.floor(z/BK);
        for(let i=b-1;i<=b+1;i++){ const L=lvl[i]; if(!L) continue;
          for(let j=0;j<L.length;j++){ const k=Math.round(L[j]*4);
            if(!ySeen.has(k)){ ySeen.add(k); ys.push(L[j]); } } }
      }
      ys.sort((a,b)=>a-b);

      const near = idxNear(ix, z-gap-V2.foreRun-1, z+maxD+gap+1, nearBuf);
      let py=-99;
      for(const y of ys){
        if(y-py < 0.2) continue; py=y;
        if(y+minH > g.H+0.01) break;
        /* Cheap gate: if the widest clear run across the trailer at this height is
           narrower than the slimmest way this piece can ride, nothing here can
           work, and the pose and position sweeps are skipped entirely. */
        spans.length=0;
        for(let i=0;i<near.length;i++){ const p=near[i];
          if(p.y+p.h <= y+0.01 || p.y >= y+minH-0.01) continue;
          if(p.z+p.d <= z-gap+0.01 || p.z >= z+minD+gap-0.01) continue;
          spans.push(p); }
        spans.sort((a,b)=>a.x-b.x);
        { let cur=Math.max(0,wr.min), run=0;
          for(const p of spans){ if(p.x-gap-cur > run) run=p.x-gap-cur;
                                 cur=Math.max(cur, p.x+p.w+gap); }
          if(wr.max-cur > run) run=wr.max-cur;
          if(run < minW-0.01) continue; }
        const onFloor = Math.abs(y-fy) < 0.5;
        for(const o2 of poses){
          if(o2.pose==='back' && onFloor && !floorFlatOK) continue;
          if(o2.pose==='upright'){
            /* To stand a cabinet up you tip it from flat and the far corner sweeps
               the diagonal of its height x depth face. A 90" tall x 25" deep box
               needs ~93.4" of headroom to rotate up. */
            const diag=Math.hypot(cab.h, cab.d);
            if(g.H-y < diag + o.standMargin) continue;
          }
          if(z+o2.d > g.totalL+0.01) continue;
          if(y+o2.h > g.H+0.01) continue;
          if(o2.w > wr.max-wr.min+0.01) continue;

          xs.length=0;
          xs.push(Math.max(0,wr.min), wr.max-o2.w);
          for(let i=0;i<near.length;i++){ const p=near[i];
            if(p.z > z+o2.d+gap || p.z+p.d < z-gap) continue;
            xs.push(p.x+p.w+gap); xs.push(p.x-o2.w-gap);
            xs.push(p.x); xs.push(p.x+p.w-o2.w); }   // flush-edge alignment
          for(let v=Math.max(0,wr.min); v<=wr.max-o2.w+0.01; v+=6) xs.push(v);
          xs.sort((a,b)=>a-b);
          let px=-99;
          for(const x of xs){
            if(x < Math.max(0,wr.min)-0.01 || x > wr.max-o2.w+0.01) continue;
            if(x-px < 0.24) continue; px=x;
            const rep = canPlace(g,ix,gap,x,y,z,o2.w,o2.h,o2.d,ply,o2.pose,cls,cab,near,o.standMargin || 0);
            if(!rep) continue;
            if(!o.doorDeck && rep.onDoors) continue;   // door decks only in the retry pass
            const sc = scoreOf(rep, x,y,z,o2.w,o2.h,o2.d, g);
            if(!best || sc.s < best.s){
              best = { s:sc.s, tight:sc.tight, x,y,z, o2, rep };
              if(zCap===Infinity) zCap = z + V2.zWindow;
            }
            if(best.tight) zCap = Math.min(zCap, z);   // snug and wasting nothing — stop looking
          }
        }
      }
    }

    if(!best) return false;
    const np = { x:best.x, y:best.y, z:best.z,
                 w:best.o2.w, h:best.o2.h, d:best.o2.d,
                 rot:best.o2.rot, pose:best.o2.pose, flip:!!best.o2.flip,
                 cab, cls, onDoors:best.rep.onDoors };
    for(const p of best.rep.rests) p.carrying = (p.carrying||0)+1;
    placed.push(np); idxAdd(ix,np);
    return true;
  }

  /* =================== LOAD STRATEGY ===================
     1. Fill the trailer floor with base cabinets standing upright. They are the
        only pieces strong enough to carry several layers.
     2. Whatever floor is left over gets tall and wall cabinets on their SIDE.
     3. Everything else goes into the layers above in its preferred pose.
     4. Anything still homeless gets one more try, this time allowed to ride on
        the doors of a face-up cabinet — one piece per door bank, nothing above
        it, nothing heavy.                                                    */
  function packLoad(cabinets, g, opt){
    const gap=opt.gap, allowStack=opt.allowStack, ply=allowStack?opt.ply:0;
    const SC=opt.standMargin, allowBack=opt.allowBack!==false;
    const allowDoorDeck = opt.allowDoorDeck!==false;
    const placed=[], failed=[], ix=mkIndex();
    if(opt.seed) for(const p of opt.seed){ placed.push(p); idxAdd(ix,p); }
    const vol=c=>c.w*c.h*c.d;
    const byVol =(a,b)=>vol(b.cab)-vol(a.cab);
    const byWide=(a,b)=>b.cab.w-a.cab.w || vol(b.cab)-vol(a.cab);
    const all=cabinets.map(c=>({cab:c, cls:cabClass(c)}));
    const O=(levels,extra)=>Object.assign({levels,allowStack,standMargin:SC},extra||{});

    /* 0 — bays for the long talls. A tall wider than the trailer has to lie
       lengthwise, so it needs a clear run of 8-9 ft. If the bases take the floor
       first that run never exists again. Nested side by side they also make a
       solid end-panel-up deck for the layer over them. */
    if(V2.tallBays){
      const longTalls = all.filter(i=>i.cls==='tall' && i.cab.h > g.W)
                           .sort((a,b)=>b.cab.h-a.cab.h || b.cab.w-a.cab.w);
      /* Any that will not nest fall through to the normal passes below. */
      for(const it of longTalls)
        tryPlace(it.cab,it.cls,makePoses(it.cab,['side'],it.cls),g,ix,placed,gap,ply,O('any'));
    }
    const bayed = new Set(placed.map(p=>p.cab));

    /* 1 — the bottom deck: base cabinets standing upright on the floor */
    const spill=[];
    for(const it of all.filter(i=>i.cls==='base').sort(byWide))
      if(!tryPlace(it.cab,it.cls,makePoses(it.cab,['upright'],it.cls),g,ix,placed,gap,ply,O('floor')))
        spill.push(it);

    /* 2 — remaining floor: tall & wall cabinets on their side */
    const later=[];
    for(const it of all.filter(i=>(i.cls==='tall'||i.cls==='wall') && !bayed.has(i.cab)).sort(byVol))
      if(!tryPlace(it.cab,it.cls,makePoses(it.cab,['side'],it.cls),g,ix,placed,gap,ply,O('floor')))
        later.push(it);

    /* 3 — the layers above */
    const queue=[...spill, ...later,
                 ...all.filter(i=>i.cls!=='base'&&i.cls!=='tall'&&i.cls!=='wall')]
                 .filter(i=>!bayed.has(i.cab)).sort(byVol);
    const stillOut=[];
    for(const it of queue){
      const pref=(POSE_ORDER[it.cls]||POSE_ORDER.other).filter(k=>allowBack||k!=='back');
      const noBack=pref.filter(k=>k!=='back');
      let ok = tryPlace(it.cab,it.cls,makePoses(it.cab,pref,it.cls),g,ix,placed,gap,ply,O('above'))
            || tryPlace(it.cab,it.cls,makePoses(it.cab,noBack.length?noBack:pref,it.cls),g,ix,placed,gap,ply,O('any'));
      if(!ok && allowBack)
        ok = tryPlace(it.cab,it.cls,makePoses(it.cab,['back','side','upright'],it.cls),g,ix,placed,gap,ply,
                      O('any',{flatOnFloor:true}));
      if(!ok) stillOut.push(it);
    }

    /* 4 — last call: ride on a door bank, one piece only */
    for(const it of stillOut){
      let ok=false;
      if(allowDoorDeck && allowStack){
        const pref=(POSE_ORDER[it.cls]||POSE_ORDER.other).filter(k=>allowBack||k!=='back');
        ok = tryPlace(it.cab,it.cls,makePoses(it.cab,pref,it.cls),g,ix,placed,gap,ply,
                      O('any',{doorDeck:true,flatOnFloor:true}));
      }
      if(!ok) failed.push(it.cab);
    }

    /* Which pieces ended up with air on BOTH sides? Only answerable once the
       whole load is built, since a later cabinet often braces an earlier one.
       Flagged rather than forbidden - the crew blocks or straps these. */
    const looseTol = gap + 1.0;
    for(const p of placed){
      const wr = availWidthAt(g, p.z + p.d/2);
      let sL = p.x - Math.max(0, wr.min), sR = wr.max - (p.x + p.w);
      for(const q of placed){
        if(q===p) continue;
        if(ov(p.y,p.y+p.h,q.y,q.y+q.h) <= 1 || ov(p.z,p.z+p.d,q.z,q.z+q.d) <= 1) continue;
        if(q.x+q.w <= p.x+0.01) sL = Math.min(sL, p.x-(q.x+q.w));
        if(q.x >= p.x+p.w-0.01) sR = Math.min(sR, q.x-(p.x+p.w));
      }
      p.loose = (sL > looseTol && sR > looseTol);
    }

    /* Load order: finish the deck front-to-rear, then each layer above it. */
    placed.sort((a,b)=>{
      const la=Math.abs(a.y-floorYAt(g,a.z))<0.5?0:1, lb=Math.abs(b.y-floorYAt(g,b.z))<0.5?0:1;
      return (la-lb) || (a.y-b.y) || (a.z-b.z) || (a.x-b.x);
    });
    placed.forEach((p,i)=>p.seq=i+1);
    return {placed, failed};
  }

  /* ---- hand the new engine to the app -------------------------------- */
  window.packLoad    = packLoad;
  window.tryPlace    = tryPlace;
  window.canPlace    = canPlace;
  window.makePoses   = makePoses;
  window.isSupport   = isSupport;
  window.supportTier = supportTier;
  window.freeTier    = freeTier;
  window.isFaceUp    = isFaceUp;
  window.LOAD_RULES_V2 = V2;          // tunable from the browser console
  window.CLO_V2_POSE_ORDER = POSE_ORDER;
  window.CLO_RULES_V2 = { canPlace, validatePlacement, analyzeLoadState, supportTier, freeTier, isFaceUp, poseOrder:POSE_ORDER, constants:V2 };
  window.CLO_ACTIVE_ENGINE = 'v2';
  if(typeof window.setEngineStatus==='function') window.setEngineStatus('Packing rules: V2 active', false);
  if(window.CLO_LEGACY_POSE_ORDER && JSON.stringify(window.CLO_LEGACY_POSE_ORDER)!==JSON.stringify(POSE_ORDER))
    console.error('load-rules-v2: POSE_ORDER drift detected between legacy and V2 engines.');
  document.dispatchEvent(new CustomEvent('clo:rules-ready'));

  /* ---- tell the crew when a wall cabinet is on its head, and which
          pieces are floating and need blocking ------------------------- */
  const basePoseText = window.poseText;
  window.poseText = function(p){
    let s = basePoseText ? basePoseText(p) : '';
    if(p && p.flip && p.pose==='upright') s += ', upside down';
    if(p && p.loose) s += ' \u00b7 block it';
    return s;
  };

  console.log('load-rules-v2 active - tighter packing, forward restraint, '
            + 'one layer on doors. Dials: window.LOAD_RULES_V2');
})();
