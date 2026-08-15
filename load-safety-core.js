/* Shared, pure safety helpers used by the packer, manual editor and tests. */
(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.CLOSafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const POSE_ORDER = Object.freeze({
    base : Object.freeze(['upright','side','back']),
    tall : Object.freeze(['side','back','upright']),
    wall : Object.freeze(['side','upright','back']),
    flat : Object.freeze(['back','side','upright']),
    pkg  : Object.freeze(['back','side','upright']),
    other: Object.freeze(['side','upright','back'])
  });

  function finitePositive(v){
    return Number.isFinite(Number(v)) && Number(v) > 0;
  }

  function escapeHTML(value){
    return String(value == null ? '' : value).replace(/[&<>'"]/g, ch=>({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;'
    })[ch]);
  }

  /* A rectangular cabinet can enter if any two of its three dimensions fit
     through the clear rear-door rectangle. This is a necessary feasibility
     check; the final placement validator still handles the interior envelope. */
  function canEnterRear(cab, rear){
    if(!rear || !finitePositive(rear.w) || !finitePositive(rear.h)) return true;
    const dims = [Number(cab.w), Number(cab.h), Number(cab.d)];
    if(!dims.every(finitePositive)) return false;
    for(let i=0;i<dims.length;i++) for(let j=0;j<dims.length;j++){
      if(i!==j && dims[i] <= rear.w + 0.01 && dims[j] <= rear.h + 0.01) return true;
    }
    return false;
  }

  function overlapArea(a,b){
    const ox = Math.max(0, Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x));
    const oz = Math.max(0, Math.min(a.z+a.d,b.z+b.d)-Math.max(a.z,b.z));
    return ox*oz;
  }

  function coversDoorBank(candidate, support, required){
    const area = Number(support.w)*Number(support.d);
    return area > 0 && overlapArea(candidate,support) >= area*required-0.01;
  }

  function validateTrailer(t){
    const errors=[];
    for(const [key,label] of [['w','Interior width'],['h','Interior height'],['len','Interior length']])
      if(!finitePositive(t[key])) errors.push(label+' must be greater than zero.');
    if(t.type==='gooseneck'){
      if(!finitePositive(t.gnl)) errors.push('Gooseneck length must be greater than zero.');
      if(!finitePositive(t.gnh) || Number(t.gnh)>=Number(t.h))
        errors.push('Gooseneck headroom must be greater than zero and less than the interior height.');
    }
    if(t.vnose && t.type==='standard' && (!finitePositive(t.vtip) || Number(t.vtip)<=Number(t.vstart)))
      errors.push('The V-nose tip must be farther from the rear than the start of the V.');
    if(t.ww){
      if(!finitePositive(t.wwd) || Number(t.wwd)*2>=Number(t.w)) errors.push('Wheel-well depth must leave clear floor between the wells.');
      if(!finitePositive(t.wwh) || Number(t.wwh)>=Number(t.h)) errors.push('Wheel-well height must be below the ceiling.');
      if(!finitePositive(t.wwl) || Number(t.wwr)<0 || Number(t.wwr)+Number(t.wwl)>Number(t.len)+0.01)
        errors.push('Wheel-well position must stay within the main floor length.');
    }
    if(t.rw!=null && (!finitePositive(t.rw) || Number(t.rw)>Number(t.w))) errors.push('Rear opening width must fit within the interior width.');
    if(t.rh!=null && (!finitePositive(t.rh) || Number(t.rh)>Number(t.h))) errors.push('Rear opening height must fit within the interior height.');
    if(Number(t.rd)<0 || Number(t.rd)>Number(t.len)) errors.push('Rear frame depth must stay within the trailer.');
    for(const key of ['emptyWeight','emptyTongue','gvwr','gawr','maxTongue','axleRear']) if(t[key]!=null && t[key]!=='' && !finitePositive(t[key]))
      errors.push(key+' must be greater than zero.');
    if(finitePositive(t.axleRear) && Number(t.axleRear)>=Number(t.len)) errors.push('Axle center must be inside the trailer length.');
    return errors;
  }

  /* Static two-support model: hitch at z=0 and axle group at totalL-axleRear.
     Empty trailer reactions are supplied as measured emptyWeight/emptyTongue;
     cargo reactions are added from the packed cabinet centers. */
  function analyzeWeight(placed, trailer, totalL){
    const unknown=placed.filter(p=>!finitePositive(p.cab&&p.cab.weight));
    const required=['emptyWeight','emptyTongue','gvwr','gawr','maxTongue','axleRear'];
    const missing=required.filter(k=>!finitePositive(trailer&&trailer[k]));
    if(unknown.length || missing.length) return {complete:false,unknown,missing,issues:[]};
    const cargoWeight=placed.reduce((n,p)=>n+Number(p.cab.weight),0);
    const cargoCg=cargoWeight ? placed.reduce((n,p)=>n+Number(p.cab.weight)*(p.z+p.d/2),0)/cargoWeight : 0;
    const axleZ=Number(totalL)-Number(trailer.axleRear);
    if(axleZ<=0) return {complete:false,unknown,missing:['axleRear'],issues:['Axle position is invalid.']};
    const cargoTongue=cargoWeight*(axleZ-cargoCg)/axleZ;
    const cargoAxle=cargoWeight-cargoTongue;
    const totalWeight=Number(trailer.emptyWeight)+cargoWeight;
    const tongueWeight=Number(trailer.emptyTongue)+cargoTongue;
    const axleWeight=(Number(trailer.emptyWeight)-Number(trailer.emptyTongue))+cargoAxle;
    const tonguePct=totalWeight?tongueWeight/totalWeight:0;
    const issues=[];
    if(totalWeight>Number(trailer.gvwr)+0.01) issues.push('GVWR exceeded');
    if(axleWeight>Number(trailer.gawr)+0.01) issues.push('axle rating exceeded');
    if(tongueWeight>Number(trailer.maxTongue)+0.01) issues.push('maximum tongue weight exceeded');
    if(tongueWeight<=0) issues.push('non-positive tongue weight');
    return {complete:true,unknown:[],missing:[],issues,cargoWeight,cargoCg,totalWeight,tongueWeight,axleWeight,tonguePct};
  }

  return { POSE_ORDER, finitePositive, escapeHTML, canEnterRear, overlapArea, coversDoorBank, validateTrailer, analyzeWeight };
});
