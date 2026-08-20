function validatePoseClearance(cab, pose, y, trailerHeight, standMargin){
  const core = window.CLOPlacementCore;
  if(core && typeof core.validatePoseClearance==='function')
    return core.validatePoseClearance(cab, pose, y, trailerHeight, standMargin);
  return pose==='upright'
    ? {ok:false, code:'TIP_UP_HELPER_UNAVAILABLE', message:'Cannot verify upright tip-up clearance because the shared safety helper is unavailable.'}
    : {ok:true, code:null, message:''};
}
function fmtDim(v){ // 34.5 -> 34 1/2
  const whole=Math.floor(v), fr=v-whole;
  if(fr<0.01) return ''+whole;
  const sixteenths = Math.round(fr*16); if(sixteenths===0) return ''+whole; if(sixteenths===16) return ''+(whole+1);
  let n=sixteenths, dd=16; while(n%2===0){n/=2;dd/=2;}
  return (whole? whole+' ':'')+n+'/'+dd;
}
function poseText(p){ return p.pose==='back' ? 'FACE UP (doors up)' : p.pose==='side' ? 'on its side' : 'standing upright'; }
function geomOf(t){
  const g = { W:t.w, H:t.h, wells:[], gn:null, taper:null };
  if(t.type==='gooseneck'){
    const rise = t.h - t.gnh;
    g.totalL = t.len + t.gnl;
    g.gn = { len:t.gnl, rise, headroom:t.gnh }; // gooseneck occupies z in [0, gnl]
    if(t.vnose && t.gnvd < t.gnl){
      g.taper = { end: t.gnl - t.gnvd }; // full width at z>=end, tapers to point at z=0
    }
  } else {
    g.totalL = (t.vnose && t.vtip>0) ? t.vtip : t.len;
    if(t.vnose && t.vstart < g.totalL){
      g.taper = { end: g.totalL - t.vstart };
    }
  }
  if(t.ww){
    const z2 = g.totalL - t.wwr, z1 = z2 - t.wwl;
    g.wells.push({x:0, y:0, z:z1, w:t.wwd, h:t.wwh, d:t.wwl});
    g.wells.push({x:t.w-t.wwd, y:0, z:z1, w:t.wwd, h:t.wwh, d:t.wwl});
  }
  // Rear door opening: the frame has a lip that is narrower/shorter than the
  // interior, so the usable cross-section shrinks over the last `rd` inches near
  // the doors. Modelled as solid ledge obstacles (sides + top) — not supports.
  g.ledges = [];
  const rw = (t.rw && t.rw>0) ? t.rw : t.w;      // rear opening width
  const rh = (t.rh && t.rh>0) ? t.rh : t.h;      // rear opening height
  const rd = (t.rd && t.rd>0) ? t.rd : 0;        // how far forward the lip reaches
  const si = Math.max(0, (t.w - rw)/2);          // inset on each side
  const ti = Math.max(0, (t.h - rh));            // inset at the top
  if(rd>0 && (si>0.01 || ti>0.01)){
    const z0 = g.totalL - rd;
    if(si>0.01){
      g.ledges.push({x:0,       y:0, z:z0, w:si, h:t.h, d:rd});
      g.ledges.push({x:t.w-si,  y:0, z:z0, w:si, h:t.h, d:rd});
    }
    if(ti>0.01) g.ledges.push({x:0, y:t.h-ti, z:z0, w:t.w, h:ti, d:rd});
    g.rear = { w:rw, h:rh, depth:rd, si, ti, z0 };
  }
  return g;
}
function availWidthAt(g, z){
  if(!g.taper) return {min:0, max:g.W};
  if(z >= g.taper.end) return {min:0, max:g.W};
  const aw = Math.max(0, g.W * (z / g.taper.end));
  return { min:(g.W-aw)/2, max:(g.W+aw)/2 };
}
function floorYAt(g, z){ return (g.gn && z < g.gn.len - 0.01) ? g.gn.rise : 0; }

/* =================== PACKING =================== */
function boxesOverlapXZ(a,b,gap){
  return a.x < b.x+b.w+gap && b.x < a.x+a.w+gap &&
         a.z < b.z+b.d+gap && b.z < a.z+a.d+gap;
}
function boxesOverlapY(a,b){ return a.y < b.y+b.h-0.01 && b.y < a.y+a.h-0.01; }

/* =================== WHAT KIND OF CABINET IS IT ===================
   The loading rules are different for each kind, so every item is sorted into
   one of these before packing:

     base  – short and deep (bases, vanities, sink & drawer bases). The strong
             ones. These ride STANDING UPRIGHT on the trailer floor and carry
             every layer above them.
     tall  – 55" or taller (pantries, oven cabinets, tall utility).
     wall  – short and shallow (uppers).
     flat  – anything under 3" in one direction: skins, panels, fillers,
             valances, floating shelves, mouldings. No doors to crush, so these
             lie flat and fill the gaps between layers.
     pkg   – trim bundles / loose doors / misc. added without a Room-Cab #.   */
function cabClass(c){
  if(c.isPkg) return 'pkg';
  if(Math.min(c.w,c.h,c.d) <= 3) return 'flat';
  if(c.h >= 55) return 'tall';
  if(c.d >= 17) return 'base';
  return 'wall';
}
const CLASS_LABEL = { base:'Base', tall:'Tall', wall:'Wall', flat:'Panel/Trim', pkg:'Package' };
const CLASS_TIP = {
  base:'Base cabinet — loaded standing upright on the floor, carries the layers above',
  tall:'Tall cabinet — laid on its side (end panel down) so weight never sits on the doors',
  wall:'Wall cabinet — laid on its side (end panel down) so weight never sits on the doors',
  flat:'Panel, filler or trim — lies flat and fills gaps between layers',
  pkg :'Package — no room/cabinet number'
};

/* Three ways a piece can ride, in plain terms:
     upright = sitting on its base, the way it hangs in the kitchen  (H vertical)
     side    = tipped onto an end panel                              (W vertical)
     back    = face up, doors toward the ceiling                     (D vertical)

   Preference by kind. Tall and wall cabinets go on their SIDE first: the face
   pointing up is a solid gable, so other cabinets can ride on top of them. Face
   up is the last resort for a real cabinet, because the doors end up carrying
   whatever is stacked over them. */
const POSE_ORDER = {
  base : ['upright','side','back'],
  tall : ['side','back','upright'],
  wall : ['side','upright','back'],
  flat : ['back','side','upright'],
  pkg  : ['back','side','upright'],
  other: ['side','upright','back']
};
window.CLO_LEGACY_POSE_ORDER = POSE_ORDER;
function makePoses(cab, kinds){
  const P=[];
  for(const k of kinds){
    if(k==='upright'){
      P.push({w:cab.w,h:cab.h,d:cab.d,pose:'upright',rot:false});
      if(cab.w!==cab.d) P.push({w:cab.d,h:cab.h,d:cab.w,pose:'upright',rot:true});
    } else if(k==='side'){
      P.push({w:cab.h,h:cab.w,d:cab.d,pose:'side',rot:false});
      if(cab.h!==cab.d) P.push({w:cab.d,h:cab.w,d:cab.h,pose:'side',rot:true});
    } else {
      P.push({w:cab.w,h:cab.d,d:cab.h,pose:'back',rot:false});
      if(cab.w!==cab.h) P.push({w:cab.h,h:cab.d,d:cab.w,pose:'back',rot:true});
    }
  }
  return P;
}
/* Can another layer ride on top of this placed piece? */
function isSupport(p){
  if(!p) return false;
  const c = p.cab || {};
  if(p.cls==='flat')  return p.h <= 3.01;   // lying flat — load passes straight through
  if(p.cls==='pkg')   return !!c.stackOn;
  if(p.pose==='back') return false;         // doors are facing up: never load on them
  if(p.pose==='side') return true;          // end panel up: the strongest way to stack
  return !!c.stackOn;                       // upright — bases yes, talls no
}
/* Only doorless pieces are allowed to lie face-up on the floor. */
function flatOnFloorOK(cls){ return cls==='pkg' || cls==='flat'; }
function isFaceUp(p){ return p.pose==='back' && p.cls!=='pkg' && p.cls!=='flat'; }

/* =================== PACKING ===================
   Placed pieces are bucketed along the length of the trailer so a collision test
   only looks at its neighbours instead of the whole load. */
const BK=48;
function mkIndex(){ return {b:{}, stamp:0}; }
function idxAdd(ix,p){
  const a=Math.floor(p.z/BK), b=Math.floor((p.z+p.d)/BK);
  for(let i=a;i<=b;i++) (ix.b[i]=ix.b[i]||[]).push(p);
}
function idxNear(ix,z0,z1,out){
  out.length=0; const s=++ix.stamp;
  const a=Math.floor(z0/BK), b=Math.floor(z1/BK);
  for(let i=a;i<=b;i++){ const L=ix.b[i]; if(!L) continue;
    for(let j=0;j<L.length;j++){ const p=L[j]; if(p._s!==s){ p._s=s; out.push(p); } } }
  return out;
}
const _near=[];
function canPlace(g,ix,gap,x,y,z,w,h,d,ply,cpose,ccls){
  const eps=0.01;
  if(x<-eps || z<-eps) return false;
  if(y+h > g.H+eps) return false;
  if(z+d > g.totalL+eps) return false;
  if(g.gn){
    const inGN = z < g.gn.len-eps;
    if(inGN && z+d > g.gn.len+eps) return false;   // can't bridge the deck step
    if(inGN && y < g.gn.rise-eps) return false;    // must sit at/above deck level
  }
  const wr = availWidthAt(g,z);                    // V-nose taper
  if(x < wr.min-eps || x+w > wr.max+eps) return false;
  const box={x,y,z,w,h,d};
  for(const wl of g.wells)  if(boxesOverlapXZ(box,wl,0) && boxesOverlapY(box,wl)) return false;
  if(g.ledges) for(const ob of g.ledges) if(boxesOverlapXZ(box,ob,0) && boxesOverlapY(box,ob)) return false;

  const near = idxNear(ix, z-gap-1, z+d+gap+1, _near);
  for(let i=0;i<near.length;i++){ const p=near[i];
    if(boxesOverlapY(box,p) && boxesOverlapXZ(box,p,gap)) return false; }

  /* Keep the airspace directly above a face-up cabinet clear, in both
     directions, so nothing ever comes to rest on its doors. A cabinet loaded
     face up is always the top of its own column. */
  for(let i=0;i<near.length;i++){ const p=near[i];
    if(!isFaceUp(p)) continue;
    if(y < p.y+p.h+ply+1.0 && y > p.y+p.h-0.6 && boxesOverlapXZ(box,p,0)) return false; }
  if(cpose==='back' && !flatOnFloorOK(ccls)){
    for(let i=0;i<near.length;i++){ const p=near[i];
      if(p.y < y+h+ply+1.0 && p.y > y+h-0.6 && boxesOverlapXZ(box,p,0)) return false; } }

  const fy = floorYAt(g,z);
  if(Math.abs(y-fy) < 0.5) return true;            // on the floor / gooseneck deck
  /* Otherwise it must land on a plywood-covered deck that carries at least 60%
     of its footprint. Plywood raises the surface by `ply`. */
  let support=0; const area=w*d;
  for(let i=0;i<near.length;i++){ const p=near[i];
    if(!isSupport(p)) continue;
    if(Math.abs(p.y+p.h+ply-y) < 1.25){
      const ox=Math.max(0, Math.min(x+w,p.x+p.w)-Math.max(x,p.x));
      const oz=Math.max(0, Math.min(z+d,p.z+p.d)-Math.max(z,p.z));
      support += ox*oz;
    } }
  for(const wl of g.wells){
    if(Math.abs(wl.y+wl.h-y) < 1.25){
      const ox=Math.max(0, Math.min(x+w,wl.x+wl.w)-Math.max(x,wl.x));
      const oz=Math.max(0, Math.min(z+d,wl.z+wl.d)-Math.max(z,wl.z));
      support += ox*oz;
    } }
  return support >= area*0.6;
}

/* Try to place one piece.  o = { levels:'floor'|'above'|'any', allowStack,
   standMargin, flatOnFloor }

   Rather than sweeping a blind grid, each piece is tried hard against the front
   wall, hard against the rear face of whatever is already loaded, flush beside
   its neighbours and hard against the side walls — plus a coarse grid so
   awkward gaps still get found. Butting pieces up flush wastes far less room. */
function tryPlace(cab, cls, poses, g, ix, placed, gap, ply, o){
  const wantFloor = o.levels!=='above', wantAbove = o.levels!=='floor';
  const floorFlatOK = o.flatOnFloor || flatOnFloorOK(cls);

  // stacking heights available along each stretch of the trailer, gathered once
  const lvl={};
  if(wantAbove && o.allowStack){
    const add=(z0,z1,v)=>{ const a=Math.floor(z0/BK), b=Math.floor(z1/BK);
      for(let i=a;i<=b;i++) (lvl[i]=lvl[i]||[]).push(v); };
    for(const p of placed) if(isSupport(p)) add(p.z, p.z+p.d, Math.round((p.y+p.h+ply)*100)/100);
    for(const wl of g.wells) add(wl.z, wl.z+wl.d, wl.h);
  }
  // candidate distances from the nose
  const zs=[0];
  if(g.gn) zs.push(g.gn.len);
  if(g.taper) zs.push(g.taper.end);
  for(const p of placed) zs.push(p.z+p.d+gap);
  for(const wl of g.wells){ zs.push(wl.z+wl.d+gap); zs.push(wl.z-1e-9); }
  for(let v=0; v<=g.totalL; v+=4) zs.push(v);
  zs.sort((a,b)=>a-b);

  const maxD = poses.reduce((m,p)=>Math.max(m,p.d),0);
  const nearBuf=[], ys=[], xs=[];
  let pz=-99;
  for(const z of zs){
    if(z < -0.01 || z > g.totalL-0.01) continue;
    if(z-pz < 0.24) continue; pz=z;
    const fy=floorYAt(g,z), wr=availWidthAt(g,z);
    if(wr.max-wr.min < 1) continue;

    ys.length=0;
    if(wantFloor) ys.push(fy);
    if(wantAbove && o.allowStack){
      const b=Math.floor(z/BK);
      for(let i=b-1;i<=b+1;i++){ const L=lvl[i]; if(L) for(let j=0;j<L.length;j++) ys.push(L[j]); }
    }
    ys.sort((a,b)=>a-b);

    const near = idxNear(ix, z-gap-1, z+maxD+gap+1, nearBuf);
    let py=-99;
    for(const y of ys){
      if(y-py < 0.2) continue; py=y;
      if(y+1 > g.H) break;
      const onFloor = Math.abs(y-fy) < 0.5;
      for(const o2 of poses){
        if(o2.pose==='back' && onFloor && !floorFlatOK) continue;
        const poseClearance = validatePoseClearance(cab, o2.pose, y, g.H, o.standMargin);
        if(!poseClearance.ok) continue;
        if(z+o2.d > g.totalL+0.01) continue;
        if(y+o2.h > g.H+0.01) continue;
        if(o2.w > wr.max-wr.min+0.01) continue;

        xs.length=0;
        xs.push(Math.max(0,wr.min), wr.max-o2.w);
        for(let i=0;i<near.length;i++){ const p=near[i];
          if(p.z > z+o2.d+gap || p.z+p.d < z-gap) continue;
          xs.push(p.x+p.w+gap); xs.push(p.x-o2.w-gap); }
        for(let v=Math.max(0,wr.min); v<=wr.max-o2.w+0.01; v+=6) xs.push(v);
        xs.sort((a,b)=>a-b);
        let px=-99;
        for(const x of xs){
          if(x < Math.max(0,wr.min)-0.01 || x > wr.max-o2.w+0.01) continue;
          if(x-px < 0.24) continue; px=x;
          if(canPlace(g,ix,gap,x,y,z,o2.w,o2.h,o2.d,ply,o2.pose,cls)){
            const np={x,y,z,w:o2.w,h:o2.h,d:o2.d,rot:o2.rot,pose:o2.pose,cab,cls};
            placed.push(np); idxAdd(ix,np);
            return true;
          }
        }
      }
    }
  }
  return false;
}

/* =================== LOAD STRATEGY ===================
   1. Fill the trailer floor with base cabinets standing upright. They are the
      only pieces strong enough to carry several layers, so the bottom deck is
      built out of them wherever possible — widest first, which puts the heavy
      pieces up front while the trailer is still empty.
   2. Whatever floor is left over (usually toward the rear) gets tall and wall
      cabinets laid on their SIDE, end panel down. The face pointing up is a
      solid gable, so the next layer can ride on them.
   3. Everything else goes into the layers above in its preferred pose. A real
      cabinet is only laid face up once side and upright have both failed, and
      never on the floor. The active V2 engine may later allow one qualifying
      piece on that door bank; nothing may ride above that piece.              */
function packLoad(cabinets, g, opt){
  const gap=opt.gap, allowStack=opt.allowStack, ply=allowStack?opt.ply:0;
  const SC=opt.standMargin, allowBack=opt.allowBack!==false;
const placed=[], failed=[], ix=mkIndex();
  /* Pre-placed pieces (hand-pinned in the Manual Layout tab). Seeding them here
     means everything packed below treats them as immovable obstacles and, where
     their pose allows it, as part of the deck that carries the layer above. */
  if(opt.seed) for(const p of opt.seed){ placed.push(p); idxAdd(ix,p); }
  const vol=c=>c.w*c.h*c.d;
  const byVol =(a,b)=>vol(b.cab)-vol(a.cab);
  const byWide=(a,b)=>b.cab.w-a.cab.w || vol(b.cab)-vol(a.cab);
  const all=cabinets.map(c=>({cab:c, cls:cabClass(c)}));
  const O=(levels,extra)=>Object.assign({levels,allowStack,standMargin:SC},extra||{});

  /* 1 — the bottom deck: base cabinets standing upright on the floor */
  const spill=[];
  for(const it of all.filter(i=>i.cls==='base').sort(byWide))
    if(!tryPlace(it.cab,it.cls,makePoses(it.cab,['upright']),g,ix,placed,gap,ply,O('floor')))
      spill.push(it);

  /* 2 — remaining floor: tall & wall cabinets on their side */
  const later=[];
  for(const it of all.filter(i=>i.cls==='tall'||i.cls==='wall').sort(byVol))
    if(!tryPlace(it.cab,it.cls,makePoses(it.cab,['side']),g,ix,placed,gap,ply,O('floor')))
      later.push(it);

  /* 3 — the layers above */
  const queue=[...spill, ...later,
               ...all.filter(i=>i.cls!=='base'&&i.cls!=='tall'&&i.cls!=='wall')].sort(byVol);
  for(const it of queue){
    const pref=(POSE_ORDER[it.cls]||POSE_ORDER.other).filter(k=>allowBack||k!=='back');
    const noBack=pref.filter(k=>k!=='back');
    let ok = tryPlace(it.cab,it.cls,makePoses(it.cab,pref),g,ix,placed,gap,ply,O('above'))
          || tryPlace(it.cab,it.cls,makePoses(it.cab,noBack.length?noBack:pref),g,ix,placed,gap,ply,O('any'));
    if(!ok && allowBack)     // last resort: face up, nothing allowed on top of it
      ok = tryPlace(it.cab,it.cls,makePoses(it.cab,['back','side','upright']),g,ix,placed,gap,ply,
                    O('any',{flatOnFloor:true}));
    if(!ok) failed.push(it.cab);
  }

  /* Load order: finish the deck front-to-rear, then each layer above it. */
  placed.sort((a,b)=>{
    const la=Math.abs(a.y-floorYAt(g,a.z))<0.5?0:1, lb=Math.abs(b.y-floorYAt(g,b.z))<0.5?0:1;
    return (la-lb) || (a.y-b.y) || (a.z-b.z) || (a.x-b.x);
  });
  placed.forEach((p,i)=>p.seq=i+1);
  return {placed, failed};
}
