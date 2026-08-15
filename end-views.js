/* =============================================================================
   end-views.js — FRONT and BACK views of the trailer
   Cabinet Load Optimizer add-on.  Drop-in: no build step, no dependencies.

   Add ONE line to cabinet-load-optimizer.html, immediately before </body> and
   AFTER the other add-ons:

       <script src="end-views.js"></script>

   WHAT IT ADDS
   Two cross-section drawings in tab 4 (Floorplan & Elevations) and in the
   printout, sitting with the other drawings just above Loading Order:

     FRONT VIEW — standing at the nose, looking back down the trailer.
     BACK VIEW  — standing at the rear doors, looking forward. This is the view
                  you get the moment you open the doors, so it is the one to
                  check against before the truck leaves.

   The floorplan shows length and width but not height; the side elevations show
   length and height but not width. Neither one shows how the load fills the
   cross-section, which is exactly where a load runs out of room. These do.

   HOW TO READ THEM
   Every piece in the trailer is drawn, in depth order. Pieces nearest the end
   you are standing at are solid; pieces deeper into the load fade back, so the
   drawing reads front-to-back the way your eye does. A cabinet number is only
   printed where that cabinet actually shows a face — if something in front of
   it covers it, it gets no number rather than a number floating over the wrong
   box.

   NOTE THE MIRROR: in the BACK view the left wall is on your left. In the FRONT
   view you have turned around, so the same left wall is now on your right. Both
   drawings are labelled at the top corners. "Left wall" everywhere in this app
   means your left standing at the rear doors looking forward, which is what the
   manifest measurements are taken from.

   This file only reads the finished load and draws it. It does not touch the
   packing engine or the load rules.
   ============================================================================= */
'use strict';

(function(){

/* ---- drawing constants -------------------------------------------------- */
const MAX_W = 330;      // px budget for one view, so two sit side by side
const MAX_H = 300;
const PAD   = 30;       // room for the height ruler and the wall labels
const NEAR_FILL = 0.62; // opacity of a piece at the near end
const FAR_FILL  = 0.13; // ...and at the far end
const SAMP_X = 7, SAMP_Y = 6;   // visibility sampling grid per box

const r1 = n => Math.round(n*10)/10;

/* A package added without a Room-Cab number has nothing to print, same rule the
   manifest uses. */
function numberOf(p){
  return (p.cab.isPkg && !p.cab.pkg) ? '' : p.cab.rc;
}

/* ---- one end view ------------------------------------------------------- */
/* which: 'front' | 'back'.  Returns {svg, shown, total}. */
function endView(which){
  const g = results.geom, placed = results.placed;
  const sc = Math.min(MAX_W/(g.W+16), MAX_H/(g.H+16));
  const bw = g.W*sc, bh = g.H*sc;
  const W = bw + PAD*2, H = bh + PAD*2 + 14;

  /* 'back' looks forward from the doors: x=0 (left wall) is on the screen left.
     'front' looks the other way, so the whole section mirrors. */
  const mirror = (which === 'front');
  const sx = x => PAD + (mirror ? (g.W - x) : x) * sc;
  const sy = y => PAD + (g.H - y) * sc;
  const boxL = (x,w) => mirror ? sx(x+w) : sx(x);   // screen-left edge of a box

  /* how far a piece sits from the end we are standing at */
  const dist = p => which === 'back' ? (g.totalL - (p.z + p.d)) : p.z;
  /* farthest drawn first so nearer pieces paint over them */
  const items = placed.slice().sort((a,b) => dist(b) - dist(a));

  /* Which faces are actually visible from here. Each box is sampled on a grid;
     a sample is dropped if any NEARER box covers it. The surviving samples give
     both how much of the face shows and where on it to put the number. */
  const vis = items.map((p,i) => {
    let seen = 0, cx = 0, cy = 0;
    for(let a=0; a<SAMP_X; a++) for(let b=0; b<SAMP_Y; b++){
      const px = p.x + p.w*(a+0.5)/SAMP_X;
      const py = p.y + p.h*(b+0.5)/SAMP_Y;
      let hidden = false;
      for(let j=i+1; j<items.length && !hidden; j++){
        const o = items[j];
        if(px > o.x && px < o.x+o.w && py > o.y && py < o.y+o.h) hidden = true;
      }
      if(!hidden){ seen++; cx += px; cy += py; }
    }
    return seen ? { frac:seen/(SAMP_X*SAMP_Y), cx:cx/seen, cy:cy/seen }
                : { frac:0, cx:p.x+p.w/2, cy:p.y+p.h/2 };
  });

  let s = `<svg viewBox="0 0 ${r1(W)} ${r1(H)}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${r1(W)}px">`;

  /* body of the trailer */
  s += `<rect x="${PAD}" y="${PAD}" width="${r1(bw)}" height="${r1(bh)}" fill="#f8fafc" stroke="#0f172a" stroke-width="2"/>`;

  /* the gooseneck deck is raised, so at the front the floor starts higher up */
  if(which === 'front' && g.gn){
    s += `<rect x="${PAD}" y="${r1(sy(g.gn.rise))}" width="${r1(bw)}" height="${r1(g.gn.rise*sc)}" fill="#e2e8f0" stroke="#b45309" stroke-width="1.4" stroke-dasharray="4 2"/>`
       + `<text x="${r1(PAD+bw/2)}" y="${r1(sy(g.gn.rise/2)+3)}" font-size="7.5" fill="#b45309" text-anchor="middle">GOOSENECK DECK &mdash; floor ${fmtDim(g.gn.rise)}" higher</text>`;
  }

  /* wheel wells are mid-trailer, drawn as ghosts so the section is honest */
  for(const wl of g.wells){
    s += `<rect x="${r1(boxL(wl.x,wl.w))}" y="${r1(sy(wl.h))}" width="${r1(wl.w*sc)}" height="${r1(wl.h*sc)}" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 2"/>`;
  }

  /* the load, far to near */
  let shown = 0;
  items.forEach((p,i) => {
    const c = roomColor(p.cab);
    const t = g.totalL > 0 ? Math.min(1, dist(p)/g.totalL) : 0;
    const fo = NEAR_FILL - (NEAR_FILL-FAR_FILL)*t;
    s += `<rect x="${r1(boxL(p.x,p.w))}" y="${r1(sy(p.y+p.h))}" width="${r1(p.w*sc)}" height="${r1(p.h*sc)}" fill="${c}" fill-opacity="${fo.toFixed(2)}" stroke="${c}" stroke-width="1.2" stroke-opacity="${(0.35+0.55*(1-t)).toFixed(2)}"/>`;

    const v = vis[i], area = p.w*p.h*v.frac*sc*sc;
    if(v.frac >= 0.30 && area >= 300 && Math.min(p.w,p.h)*sc >= 13){
      shown++;
      const fs = Math.max(6, Math.min(10, Math.sqrt(area)/3.4));
      const num = numberOf(p);
      const tx = r1(sx(v.cx)), ty = r1(sy(v.cy));
      if(num) s += `<text x="${tx}" y="${ty}" font-size="${r1(fs)}" font-weight="bold" fill="#0f172a" text-anchor="middle" dominant-baseline="middle">${esc(num)}</text>`;
      if(!num || area >= 620){
        s += `<text x="${tx}" y="${r1(num ? ty+fs : ty)}" font-size="${r1(num ? fs*0.72 : fs)}" fill="#334155" text-anchor="middle" dominant-baseline="middle">#${p.seq}</text>`;
      }
    }
  });

  /* the rear frame is the last thing between the load and the ground */
  if(which === 'back' && g.rear){
    if(g.rear.si > 0.01){
      s += `<rect x="${PAD}" y="${PAD}" width="${r1(g.rear.si*sc)}" height="${r1(bh)}" fill="#94a3b8" fill-opacity="0.55" stroke="#475569" stroke-width="1" stroke-dasharray="2 2"/>`
         + `<rect x="${r1(PAD+bw-g.rear.si*sc)}" y="${PAD}" width="${r1(g.rear.si*sc)}" height="${r1(bh)}" fill="#94a3b8" fill-opacity="0.55" stroke="#475569" stroke-width="1" stroke-dasharray="2 2"/>`;
    }
    if(g.rear.ti > 0.01){
      s += `<rect x="${PAD}" y="${PAD}" width="${r1(bw)}" height="${r1(g.rear.ti*sc)}" fill="#94a3b8" fill-opacity="0.55" stroke="#475569" stroke-width="1" stroke-dasharray="2 2"/>`;
    }
    s += `<rect x="${r1(PAD+g.rear.si*sc)}" y="${r1(sy(g.rear.h))}" width="${r1(g.rear.w*sc)}" height="${r1(g.rear.h*sc)}" fill="none" stroke="#dc2626" stroke-width="1.6" stroke-dasharray="6 3"/>`;
  }

  /* height ruler up the screen-left edge */
  for(let ft=1; ft*12 < g.H; ft++){
    const y = sy(ft*12);
    s += `<line x1="${PAD-4}" y1="${r1(y)}" x2="${PAD}" y2="${r1(y)}" stroke="#94a3b8"/>`
       + `<text x="${PAD-6}" y="${r1(y+3)}" font-size="7" fill="#94a3b8" text-anchor="end">${ft}'</text>`;
  }

  /* wall labels, because the front view is mirrored */
  s += `<text x="${PAD+1}" y="${PAD-8}" font-size="8" font-weight="bold" fill="#64748b">${mirror?'RIGHT':'LEFT'} WALL</text>`
     + `<text x="${r1(PAD+bw-1)}" y="${PAD-8}" font-size="8" font-weight="bold" fill="#64748b" text-anchor="end">${mirror?'LEFT':'RIGHT'} WALL</text>`
     + `<text x="${r1(PAD+bw/2)}" y="${r1(PAD+bh+12)}" font-size="8" fill="#475569" text-anchor="middle">${fmtDim(g.W)}" wide &times; ${fmtDim(g.H)}" tall</text>`;

  s += '</svg>';
  return { svg:s, shown, total:items.length };
}

/* ---- the section that goes into the plans and the printout -------------- */
function endViewsSection(forPrint){
  const g = results.geom;
  const front = endView('front'), back = endView('back');

  const notes = [];
  if(g.taper) notes.push('the V-nose narrows the front &mdash; check the floorplan for how far back full width starts');
  if(g.gn)    notes.push('the gooseneck deck is raised, so headroom over it is only ' + fmtDim(g.gn.headroom) + '"');
  if(g.wells.length) notes.push('wheel wells are dashed &mdash; they sit mid-trailer, not at either end');
  if(g.rear)  notes.push('the red dashed line is the rear door opening, ' + fmtDim(g.rear.w) + '" &times; ' + fmtDim(g.rear.h) + '" &mdash; grey is frame you cannot pass');

  const cell = (heading, sub, view) => `<td style="width:50%;vertical-align:top;padding:0 5px">
    <div style="font-size:12px;font-weight:800;color:#0f172a">${heading}</div>
    <div style="font-size:10px;color:#64748b;line-height:1.35;margin:1px 0 5px">${sub}</div>
    ${view.svg}
    <div style="font-size:9.5px;color:#94a3b8;margin-top:2px">${view.shown} of ${view.total} pieces show a face from this end</div></td>`;

  return `<div ${forPrint?'class="page-break"':''} style="margin-bottom:18px">
    <h2 style="font-size:15px;font-weight:800;background:#f1f5f9;padding:5px 9px;border-left:4px solid #1e3a8a;margin-bottom:8px">End Views &mdash; the load through the front and the rear doors</h2>
    <div style="font-size:11px;color:#475569;margin-bottom:8px;line-height:1.45">
      Cross-sections through the trailer. Pieces closest to the end you are looking at are solid; pieces deeper into the load fade back.
      A cabinet number is printed only where that cabinet really shows a face, so anything unnumbered is buried behind what is in front of it.
      <b>The two views are mirrored</b> &mdash; turning to face the other way swaps your left and right, so the walls are labelled on both.
      ${notes.length?'<br>'+notes.map(n=>'&bull; '+n).join(' ')+'.':''}
    </div>
    <table style="width:100%;border-collapse:collapse"><tr>
      ${cell('FRONT VIEW', 'Standing at the nose looking back toward the doors.', front)}
      ${cell('BACK VIEW', 'Standing at the rear doors looking forward &mdash; what you see when the doors open.', back)}
    </tr></table></div>`;
}

/* ---- splice it in beside the other drawings ----------------------------- */
const _plansHTML = window.plansHTML;
if(typeof _plansHTML !== 'function'){
  console.warn('[end-views] plansHTML() not found — load this after the main script.');
  return;
}
window.plansHTML = function(forPrint){
  const out = _plansHTML(forPrint);
  if(!results || !results.placed || !results.placed.length) return out;

  let block;
  try { block = endViewsSection(forPrint); }
  catch(err){ console.warn('[end-views] could not draw end views:', err); return out; }

  /* Sit with the other drawings, just above Loading Order. If that heading ever
     moves or is renamed, fall back to appending rather than dropping the views. */
  const mark = out.indexOf('>Loading Order');
  const at = mark > -1 ? out.lastIndexOf('<div ', mark) : -1;
  return at > -1 ? out.slice(0,at) + block + out.slice(at) : out + block;
};

})();
