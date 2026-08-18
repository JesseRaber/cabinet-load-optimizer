/* Shared pure placement helpers for the fallback engine, V2 engine, manual editor, and tests. */
(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.CLOPlacementCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  function finiteNumber(value){ return Number.isFinite(Number(value)); }

  /* Upright cabinets must have enough vertical room for their height/depth face
     to sweep through the stand-up manoeuvre, not merely enough room to exist
     after they are upright. `y` matters for manually elevated placements. */
  function uprightTipUpClearance(cab, y, standMargin){
    const h = Number(cab && cab.h), d = Number(cab && cab.d);
    const baseY = finiteNumber(y) ? Number(y) : 0;
    const margin = finiteNumber(standMargin) ? Math.max(0, Number(standMargin)) : 0;
    if(!finiteNumber(h) || !finiteNumber(d) || h <= 0 || d <= 0) return NaN;
    return baseY + Math.hypot(h, d) + margin;
  }

  function validatePoseClearance(cab, pose, y, trailerHeight, standMargin){
    if(pose !== 'upright') return { ok:true, code:null, message:'' };
    const required = uprightTipUpClearance(cab, y, standMargin);
    const available = Number(trailerHeight);
    if(!finiteNumber(required) || !finiteNumber(available)){
      return { ok:false, code:'TIP_UP_INPUT', message:'Cannot verify upright tip-up clearance from the current dimensions.' };
    }
    if(required <= available + 0.01){
      return { ok:true, code:null, message:'', required, available };
    }
    return {
      ok:false,
      code:'TIP_UP_CLEARANCE',
      required,
      available,
      message:`Cannot stand upright: needs ${required.toFixed(1)}" of tip-up clearance; ${available.toFixed(1)}" is available.`
    };
  }

  return Object.freeze({ uprightTipUpClearance, validatePoseClearance, finiteNumber });
});
