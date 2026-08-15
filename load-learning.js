/* ============================================================================
   load-learning.js — What you changed, and what that suggests
   Add-on for the Cabinet Load Optimizer.

   Load this AFTER manual-layout.js:
       <script src="manual-layout.js"></script>
       <script src="load-learning.js"></script>

   What it does
     • Every time you press Optimize Load, it records the answer the packer gave
       — how many of each kind of cabinet it placed, how it laid them, and which
       ones it said would not fit.
     • Every time you move something by hand in the Manual Layout tab, it
       records the change against that original answer. One record per cabinet
       per run, so fiddling with the same piece ten times counts once.
     • A "Tuning" tab reads the whole history back and writes out CANDIDATE
       changes to the loading rules, with the counts behind each one.

   What it deliberately does NOT do
     Nothing here ever changes how the packer works. It cannot. There is no
     model, no weights and no training — it is counting the times you disagreed
     with the packer and looking for a consistent pattern in those counts. Every
     suggestion is text for you to read, accept or throw out. Real rule changes
     happen when you edit the active rules in load-rules-v2.js by hand.

   Storage: localStorage only, on this device, under the key below. Nothing is
   uploaded. Export the JSON if you want to keep it or hand it to someone.
   ============================================================================ */
'use strict';
(function(){

const LS_KEY   = 'clo_learn_v1';
const MAX_RUNS = 25;            // keep the last N optimize runs
const MAX_EDITS_PER_RUN = 300;
const MAX_BYTES = 1500000;      // trim oldest runs past roughly 1.5 MB

/* A pattern is worth reporting when there is enough of it, and when it points
   the same way most of the time. Two loose numbers, stated plainly, so you can
   argue with them. */
const MIN_N = 4, MIN_SHARE = 0.6;

const POSE_NAME  = { back:'face up', side:'on its side', upright:'standing upright' };
const LAYER_NAME = { floor:'on the floor / deck', stack:'up on the stacked layer' };
const CLS_NAME   = (typeof CLASS_LABEL !== 'undefined') ? CLASS_LABEL
                 : { base:'Base', tall:'Tall', wall:'Wall', flat:'Panel/Trim', pkg:'Package' };
const clsName = c => CLS_NAME[c] || c;
/* How to say a kind mid-sentence. "how a tall lies" reads badly. */
const CLS_PHRASE = { base:'base cabinet', tall:'tall cabinet', wall:'wall cabinet',
                     flat:'panel or trim piece', pkg:'package' };
const kind = c => CLS_PHRASE[c] || (clsName(c).toLowerCase() + ' piece');
/* The same cabinet number turns up once per run it was edited in. Listing it
   three times just pads the card, so list each one once and let the count speak. */
function uniq(list, n){
  const seen = new Set(), out = [];
  for(const s of list){ if(seen.has(s)) continue; seen.add(s); out.push(s); if(out.length>=n) break; }
  return { text: out.join(', ') + (list.length > out.length ? ' …' : ''), shown: out.length };
}

/* ============================================================================
   THE LOG
   ============================================================================ */
function blank(){ return { v:1, runs:[] }; }
function load(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return blank();
    const db = JSON.parse(raw);
    return (db && Array.isArray(db.runs)) ? db : blank();
  }catch(e){ return blank(); }
}
function save(db){
  try{
    while(db.runs.length > MAX_RUNS) db.runs.shift();
    let s = JSON.stringify(db);
    while(s.length > MAX_BYTES && db.runs.length > 1){ db.runs.shift(); s = JSON.stringify(db); }
    localStorage.setItem(LS_KEY, s);
  }catch(e){ /* storage full or blocked — the app carries on without a log */ }
}
function lastRun(db){ return db.runs.length ? db.runs[db.runs.length-1] : null; }

/* ---- an optimize run ---- */
document.addEventListener('clo:optimize', ev=>{
  const d = ev.detail || {};
  const autoByCls = {};
  for(const id in (d.baseline||{})){
    const b = d.baseline[id];
    autoByCls[b.cls] = (autoByCls[b.cls]||0) + 1;
  }
  const db = load();
  db.runs.push({
    runId: d.runId, at: d.at || Date.now(), job: d.job || '',
    trailer: d.trailer || null, opts: d.opts || null,
    loaded: d.loaded || 0, pinnedCount: d.pinnedCount || 0,
    autoByCls,
    failed: (d.failed || []).slice(0, 200),
    edits: {}, bulkUndos: 0
  });
  save(db);
  if(isShowing()) renderTuning();
});

/* ---- one hand edit. Keyed by cabinet, so the record is always the state you
       settled on rather than every intermediate nudge. ---- */
document.addEventListener('clo:edit', ev=>{
  const d = ev.detail || {};
  if(!d.cabId) return;
  const db = load();
  let run = d.runId ? db.runs.find(r=>r.runId === d.runId) : lastRun(db);
  if(!run){
    /* Placed by hand before any optimize run. Still worth keeping, in its own
       bucket, because a rescue here says the same thing about the rules. */
    run = { runId:'manual-'+Date.now(), at:Date.now(), job:d.job||'', trailer:null,
            opts:null, loaded:0, pinnedCount:0, autoByCls:{}, failed:[], edits:{}, bulkUndos:0 };
    db.runs.push(run);
  }
  if(!run.edits[d.cabId] && Object.keys(run.edits).length >= MAX_EDITS_PER_RUN){ save(db); return; }
  run.edits[d.cabId] = {
    at: d.at || Date.now(), rc: d.rc, name: d.name, cls: d.cls,
    w: d.w, h: d.h, d: d.d,
    action: d.action, base: d.base || null, to: d.to || null
  };
  save(db);
  if(isShowing()) renderTuning();
});

/* ---- a bulk undo: too broad to restate cabinet by cabinet, so the run is
       flagged and the tuning page says the numbers may include changes you
       later took back. ---- */
document.addEventListener('clo:undo', ev=>{
  if(!ev.detail || ev.detail.scope !== 'bulk') return;
  const db = load(), run = lastRun(db);
  if(!run) return;
  run.bulkUndos = (run.bulkUndos||0) + 1;
  save(db);
  if(isShowing()) renderTuning();
});

/* ============================================================================
   READING THE LOG BACK
   ============================================================================ */
function collect(){
  const db = load();
  const edits = [], autoTotals = {};
  let bulkUndos = 0, first = null, last = null;
  for(const r of db.runs){
    bulkUndos += r.bulkUndos || 0;
    if(first === null || r.at < first) first = r.at;
    if(last === null || r.at > last) last = r.at;
    for(const k in (r.autoByCls||{})) autoTotals[k] = (autoTotals[k]||0) + r.autoByCls[k];
    for(const id in r.edits) edits.push(Object.assign({ runId:r.runId, cabId:id }, r.edits[id]));
  }
  return { db, runs:db.runs, edits, autoTotals, bulkUndos, first, last };
}

const moves = edits => edits.filter(e => e.action === 'move' && e.base && e.to);
function tally(arr, keyFn){
  const out = {};
  for(const x of arr){ const k = keyFn(x); if(k==null) continue; out[k] = (out[k]||0) + 1; }
  return out;
}
function top(obj){
  let bk = null, bn = 0, total = 0;
  for(const k in obj){ total += obj[k]; if(obj[k] > bn){ bn = obj[k]; bk = k; } }
  return { key:bk, n:bn, total, share: total ? bn/total : 0 };
}
function median(a){
  if(!a.length) return 0;
  const b = [...a].sort((x,y)=>x-y), m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m-1] + b[m]) / 2;
}
function confidence(n, share){
  if(n >= 8 && share >= 0.75) return 'strong';
  if(n >= MIN_N && share >= MIN_SHARE) return 'medium';
  return 'watch';
}
function fd(v){ return (typeof fmtDim === 'function') ? fmtDim(Math.abs(v)) : Math.abs(v).toFixed(1); }
function pct(x){ return Math.round(x*100) + '%'; }
function orderOf(cls){
  try{
    const order=window.CLO_POSE_ORDER;
    return (order[cls] || order.other).map(p=>POSE_NAME[p]||p).join(' → ');
  }catch(e){ return '(see CLOSafety.POSE_ORDER in load-safety-core.js)'; }
}

/* ============================================================================
   THE DETECTORS
   Each one returns zero or more candidate changes. A candidate says what was
   counted, what it might mean, and which part of the app would have to change.
   ============================================================================ */
function analyse(){
  const { edits, autoTotals } = collect();
  const mv = moves(edits);
  const out = [];

  const byCls = {};
  const bucket = c => (byCls[c] = byCls[c] || { mv:0, pose:{}, rot:0, layer:{}, dz:[], dx:[] });
  for(const e of mv){
    const b = bucket(e.cls);
    b.mv++;
    if(e.base.pose !== e.to.pose) b.pose[e.base.pose + '>' + e.to.pose] = (b.pose[e.base.pose+'>'+e.to.pose]||0) + 1;
    else if(!!e.base.rot !== !!e.to.rot) b.rot++;
    if(e.base.layer && e.to.layer && e.base.layer !== e.to.layer)
      b.layer[e.base.layer + '>' + e.to.layer] = (b.layer[e.base.layer+'>'+e.to.layer]||0) + 1;
    const dz = (e.to.z||0) - (e.base.z||0), dx = (e.to.x||0) - (e.base.x||0);
    if(Math.abs(dz) >= 1) b.dz.push(dz);
    if(Math.abs(dx) >= 1) b.dx.push(dx);
  }

  /* 1 — how a kind of cabinet lies */
  for(const cls in byCls){
    const t = top(byCls[cls].pose);
    if(!t.key || t.n < MIN_N || t.share < MIN_SHARE) continue;
    const [from, to] = t.key.split('>');
    out.push({
      cls, n:t.n, share:t.share, conf:confidence(t.n, t.share),
      title: `${clsName(cls)} cabinets: you keep changing ${POSE_NAME[from]} to ${POSE_NAME[to]}`,
      observed: `${t.n} of the ${t.total} times you changed how a ${kind(cls)} lies, `
              + `you went from <b>${POSE_NAME[from]}</b> to <b>${POSE_NAME[to]}</b> (${pct(t.share)} of those changes). `
              + `The packer laid ${autoTotals[cls]||0} ${kind(cls)}(s) in total across the runs on file.`,
      suggest: `Try <b>${POSE_NAME[to]}</b> ahead of <b>${POSE_NAME[from]}</b> for this kind. `
             + `The order right now is <code>${orderOf(cls)}</code>.`,
      where: `CLOSafety.POSE_ORDER.${cls} in load-safety-core.js`
    });
  }

  /* 2 — which way round it goes */
  for(const cls in byCls){
    const b = byCls[cls];
    if(b.rot < MIN_N) continue;
    const share = b.mv ? b.rot / b.mv : 0;
    if(share < 0.4) continue;   // a looser bar: turning is a small change
    out.push({
      cls, n:b.rot, share, conf:confidence(b.rot, share),
      title: `${clsName(cls)} cabinets: you turn them 90° after the packer places them`,
      observed: `You turned ${b.rot} ${kind(cls)}(s) without changing how they lie — `
              + `${pct(share)} of the ${b.mv} moves you made to this kind.`,
      suggest: `Offer the turned version of each pose first for this kind, so the search tries the long way `
             + `across the trailer before the long way along it.`,
      where: `load-rules-v2.js makePoses() — the order the rot:true variants are pushed`
    });
  }

  /* 3 — floor or stacked */
  for(const cls in byCls){
    const t = top(byCls[cls].layer);
    if(!t.key || t.n < 3 || t.share < MIN_SHARE) continue;
    const [from, to] = t.key.split('>');
    const toFloor = (to === 'floor');
    out.push({
      cls, n:t.n, share:t.share, conf:confidence(t.n, t.share),
      title: `${clsName(cls)} cabinets: you move them ${LAYER_NAME[to]}`,
      observed: `${t.n} ${kind(cls)}(s) were moved from ${LAYER_NAME[from]} to ${LAYER_NAME[to]} `
              + `(${pct(t.share)} of the layer changes for this kind).`,
      suggest: toFloor
        ? `Give this kind a floor pass of its own before the layers above are filled, or let it into the `
        + `existing floor pass. It is currently reaching the deck only by spilling into the "layers above" queue.`
        : `Stop trying this kind on the floor first. Send it straight to the layers above so the deck is left `
        + `for the pieces that carry weight.`,
      where: `load-rules-v2.js packLoad() — the phase order, and which classes get O('floor')`
    });
  }

  /* 4 / 5 — a consistent shove along or across the trailer */
  for(const cls in byCls){
    for(const axis of ['dz','dx']){
      const a = byCls[cls][axis];
      if(a.length < MIN_N) continue;
      const med = median(a);
      if(Math.abs(med) < 6) continue;
      const pos = a.filter(v=>v>0).length, neg = a.length - pos;
      const share = Math.max(pos, neg) / a.length;
      if(share < 0.7) continue;
      const toward = axis === 'dz' ? (med > 0 ? 'the rear doors' : 'the front of the trailer')
                                   : (med > 0 ? 'the right wall'  : 'the left wall');
      out.push({
        cls, n:a.length, share, conf:confidence(a.length, share),
        title: `${clsName(cls)} cabinets end up further toward ${toward}`,
        observed: `Across ${a.length} moves, the middle move was <b>${fd(med)}"</b> toward ${toward}, `
                + `and ${pct(share)} of them went that way.`,
        suggest: axis === 'dz'
          ? `The scan fills from the front, so a consistent pull toward ${toward} usually means this kind is `
          + `being placed too early or too late in the queue rather than in the wrong spot. Try moving it in the `
          + `sort order for its phase.`
          : `The scan fills from the left wall. A consistent drift toward ${toward} suggests this kind should be `
          + `placed after the pieces it is being pushed past, not before them.`,
        where: `load-rules-v2.js packLoad() — the sort comparators (byVol / byWide) and the phase each class sits in`
      });
    }
  }

  /* 6 — pieces the packer gave up on that you fitted anyway. The strongest
         signal in the whole log: the rules were not wrong, the search was. */
  const rescues = edits.filter(e => e.action === 'rescue' && e.to);
  if(rescues.length){
    const byC = tally(rescues, e=>e.cls);
    const t = top(byC);
    const how = tally(rescues, e=>e.to.pose);
    const topHow = top(how);
    out.push({
      cls: t.key, n:rescues.length, share:1,
      conf: rescues.length >= 3 ? 'strong' : 'watch',
      title: `${rescues.length} piece(s) the packer said would not fit, and you fitted by hand`,
      observed: `Mostly ${kind(t.key)}(s) (${t.n} of ${rescues.length}). `
              + `You ended up putting them <b>${POSE_NAME[topHow.key]||topHow.key}</b> in ${topHow.n} of those cases. `
              + `Pieces: ${esc(uniq(rescues.map(e=>e.rc), 12).text)}.`,
      suggest: `The candidate-position search is giving up while there is still room. Widen it for these pieces — `
             + `either allow the pose you settled on earlier in the preference list, or add a final pass that `
             + `retries anything in the failed list against every surface before reporting it as unfittable.`,
      where: `load-rules-v2.js packLoad() — the failed list, and tryPlace()'s candidate positions`
    });
  }

  /* 7 — face up is a shop rule, not a preference. Treat any pattern here as
         higher priority than the tuning items above. */
  const faceUp = mv.filter(e => e.base.pose === 'back' && e.to.pose !== 'back'
                             && e.cls !== 'flat' && e.cls !== 'pkg');
  if(faceUp.length >= 2){
    const byC = tally(faceUp, e=>e.cls);
    out.push({
      cls: top(byC).key, n:faceUp.length, share:1, conf:'strong', rule:true,
      title: `Face-up fallback is firing when a better pose was available`,
      observed: `${faceUp.length} real cabinet placement(s) were face up and you turned them off their doors: `
              + `${esc(uniq(faceUp.map(e=>e.rc+' → '+(POSE_NAME[e.to.pose]||e.to.pose)), 12).text)}.`,
      suggest: `Face up is supposed to be the last resort for a cabinet, because whatever goes on top rides on `
             + `the doors. If it is being chosen while an on-its-side spot existed, the side pose is being `
             + `rejected too readily — check the stand-up and support tests before the back pose is offered.`,
      where: `load-rules-v2.js packLoad() — the pref / noBack fallback, and isFaceUp() handling`
    });
  }

  /* 8 — taken out of the load altogether */
  const removed = edits.filter(e => e.action === 'remove' && e.base);
  if(removed.length >= 3){
    const byC = tally(removed, e=>e.cls);
    const t = top(byC);
    out.push({
      cls: t.key, n:removed.length, share:t.share, conf:confidence(removed.length, t.share),
      title: `${removed.length} piece(s) were pulled out of the load after packing`,
      observed: `Mostly ${kind(t.key)}(s) (${t.n} of ${removed.length}): `
              + `${esc(uniq(removed.map(e=>e.rc), 12).text)}.`,
      suggest: `Taking a piece out is usually about the job rather than the rules — a second trip, or something `
             + `that ships another way. Worth a look only if the same kind keeps coming out, which would mean it `
             + `should not be in the packing list at all.`,
      where: `the cabinet list — not the packer`
    });
  }

  /* Rule breaches first, then the best-supported tuning items. */
  const rank = { strong:0, medium:1, watch:2 };
  out.sort((a,b)=> (b.rule?1:0)-(a.rule?1:0) || rank[a.conf]-rank[b.conf] || b.n-a.n);
  return out;
}

/* Per class: how much of the packer's work you left alone. */
function stability(){
  const { edits, autoTotals } = collect();
  const touched = {};
  for(const e of edits) if(e.base) touched[e.cls] = (touched[e.cls]||0) + 1;
  return Object.keys(autoTotals).sort().map(cls=>{
    const total = autoTotals[cls], t = touched[cls] || 0;
    return { cls, total, touched:t, kept: total ? 1 - Math.min(1, t/total) : 1 };
  });
}

/* ============================================================================
   THE TAB
   ============================================================================ */
function isShowing(){
  const t = document.getElementById('tab-tuning');
  return !!t && !t.classList.contains('hidden');
}

function injectUI(){
  const nav = document.querySelector('nav');
  const b = document.createElement('button');
  b.className = 'tabbtn'; b.dataset.tab = 'tab-tuning';
  b.textContent = 'Tuning';
  b.addEventListener('click', ()=>showTab(b));
  nav.appendChild(b);
  [...nav.children].forEach((btn,i)=>{
    btn.textContent = (i+1) + ' · ' + btn.textContent.replace(/^\s*\d+\s*·\s*/,'');
  });

  const sec = document.createElement('section');
  sec.id = 'tab-tuning'; sec.className = 'hidden';
  sec.innerHTML = `
    <div class="max-w-5xl space-y-4">
      <div class="bg-amber-50 border border-amber-300 rounded-lg p-4">
        <h2 class="font-bold text-sm text-amber-900 mb-1">Nothing on this page is applied automatically</h2>
        <p class="text-xs text-amber-900 leading-relaxed">
          This is a count of the times you moved a cabinet away from where the packer put it, grouped to see
          whether the same disagreement keeps happening. There is no model and no training — it is arithmetic on
          your edits. Read a suggestion, decide whether it matches what you know about the shop floor, and if it
          does, change the rule in the app yourself. The loading rules stay in one place and only change on purpose.
        </p>
      </div>

      <div class="bg-white rounded-lg shadow p-4">
        <div class="flex justify-between items-start gap-3 flex-wrap">
          <div>
            <h2 class="font-bold text-sm">Edit history</h2>
            <div id="tn-summary" class="text-xs text-slate-500 mt-1"></div>
          </div>
          <div class="flex gap-1.5 flex-wrap">
            <button class="btn btn-gray !py-1 !px-2 text-xs" id="tn-copy">Copy suggestions</button>
            <button class="btn btn-blue !py-1 !px-2 text-xs" id="tn-export">Download log (JSON)</button>
            <button class="btn btn-red !py-1 !px-2 text-xs" id="tn-clear">Clear log</button>
          </div>
        </div>
        <div id="tn-runs" class="mt-3 overflow-auto"></div>
      </div>

      <div>
        <h2 class="font-bold text-sm mb-2">Suggested changes to review</h2>
        <div id="tn-cards" class="space-y-3"></div>
      </div>

      <div class="bg-white rounded-lg shadow p-4">
        <h2 class="font-bold text-sm mb-1">Where the packer and you already agree</h2>
        <p class="text-xs text-slate-500 mb-2">Share of the packer's placements you left alone, by kind.
          A high number here means the rules for that kind are doing their job.</p>
        <div id="tn-stability" class="overflow-auto"></div>
      </div>
    </div>`;
  document.querySelector('main').appendChild(sec);

  document.getElementById('tn-copy').addEventListener('click', copySuggestions);
  document.getElementById('tn-export').addEventListener('click', exportLog);
  document.getElementById('tn-clear').addEventListener('click', ()=>{
    if(!confirm('Clear the whole edit history? The suggestions on this page are rebuilt from it, so they go too.')) return;
    try{ localStorage.removeItem(LS_KEY); }catch(e){}
    renderTuning();
  });
}

/* Wrap whatever showTab is in place — the app's own, or manual-layout's. */
const _showTab = window.showTab;
window.showTab = function(btn){
  _showTab(btn);
  const t = document.getElementById('tab-tuning');
  if(t) t.classList.toggle('hidden', btn.dataset.tab !== 'tab-tuning');
  if(btn.dataset.tab === 'tab-tuning') renderTuning();
};

const CONF_BADGE = {
  strong: ['bg-emerald-100 text-emerald-800 border-emerald-300', 'well supported'],
  medium: ['bg-blue-100 text-blue-800 border-blue-300',           'worth a look'],
  watch : ['bg-slate-100 text-slate-600 border-slate-300',        'too early to say']
};

function renderTuning(){
  const { runs, edits, bulkUndos, first, last } = collect();
  const cards = analyse();

  const nEdited = new Set(edits.map(e=>e.cabId)).size;
  const span = (first && last)
    ? new Date(first).toLocaleDateString() + ' – ' + new Date(last).toLocaleDateString()
    : '—';
  document.getElementById('tn-summary').innerHTML = runs.length
    ? `<b>${runs.length}</b> optimize run(s) on file · <b>${edits.length}</b> hand edit(s) across
       <b>${nEdited}</b> cabinet(s) · ${span}`
      + (bulkUndos ? `<div class="text-amber-700 mt-1">⚠ ${bulkUndos} bulk undo(s) happened. Some counted
           edits may have been taken back, so treat the numbers below as a little high.</div>` : '')
    : 'Nothing recorded yet. Press <b>Optimize Load</b>, then move a few cabinets in the Manual Layout tab.';

  /* recent runs, newest first */
  const host = document.getElementById('tn-runs');
  if(!runs.length){ host.innerHTML = ''; }
  else {
    host.innerHTML = `<table class="grid"><thead><tr>
        <th>When</th><th>Job</th><th>Trailer</th><th>Loaded</th><th>Would not fit</th><th>Hand edits</th>
      </tr></thead><tbody>` +
      [...runs].reverse().slice(0,10).map(r=>{
        const n = Object.keys(r.edits||{}).length;
        return `<tr>
          <td>${new Date(r.at).toLocaleString()}</td>
          <td>${r.job ? esc(r.job) : '<span class="text-slate-400">—</span>'}</td>
          <td>${r.trailer ? esc(r.trailer.name) : '<span class="text-slate-400">—</span>'}</td>
          <td>${r.loaded || 0}</td>
          <td>${(r.failed||[]).length}</td>
          <td class="${n?'font-bold':''}">${n}</td>
        </tr>`;
      }).join('') + '</tbody></table>';
  }

  /* the candidate changes */
  const cardHost = document.getElementById('tn-cards');
  cardHost.innerHTML = cards.length ? cards.map(c=>{
    const [cls, label] = CONF_BADGE[c.conf] || CONF_BADGE.watch;
    return `<div class="bg-white rounded-lg shadow p-4 ${c.rule?'border-l-4 border-red-500':''}">
      <div class="flex justify-between items-start gap-3 flex-wrap">
        <h3 class="font-bold text-sm">${c.rule?'<span class="text-red-600">Shop rule · </span>':''}${c.title}</h3>
        <span class="text-[10px] font-bold uppercase border rounded-full px-2 py-0.5 whitespace-nowrap ${cls}">${label}</span>
      </div>
      <div class="text-xs text-slate-600 mt-2"><b class="text-slate-800">Counted:</b> ${c.observed}</div>
      <div class="text-xs text-slate-600 mt-1.5"><b class="text-slate-800">Might mean:</b> ${c.suggest}</div>
      <div class="text-[11px] text-slate-400 mt-2 pt-2 border-t">Would change: <code>${c.where}</code>
        · ${c.n} sample(s)${c.share<1?', '+pct(c.share)+' consistent':''}</div>
    </div>`;
  }).join('')
  : `<div class="bg-white rounded-lg shadow p-4 text-xs text-slate-500">
       No pattern is clear enough to suggest anything yet. A pattern needs about ${MIN_N} edits of the same kind,
       pointing the same way ${pct(MIN_SHARE)} of the time. Keep loading jobs — this fills up on its own.</div>`;

  /* stability */
  const st = stability();
  document.getElementById('tn-stability').innerHTML = st.length
    ? `<table class="grid"><thead><tr><th>Kind</th><th>Placed by the packer</th><th>You moved</th><th>Left alone</th></tr></thead><tbody>` +
      st.map(r=>`<tr><td><b>${clsName(r.cls)}</b></td><td>${r.total}</td><td>${r.touched}</td>
        <td><b class="${r.kept>=0.9?'text-emerald-700':r.kept>=0.7?'text-slate-700':'text-amber-700'}">${pct(r.kept)}</b></td></tr>`).join('') +
      '</tbody></table>'
    : '<div class="text-xs text-slate-400">Nothing recorded yet.</div>';
}

/* ============================================================================
   TAKING IT WITH YOU
   ============================================================================ */
function suggestionsText(){
  const { runs, edits, bulkUndos } = collect();
  const cards = analyse();
  const strip = h => String(h).replace(/<[^>]*>/g, '');
  const lines = [
    'CABINET LOAD OPTIMIZER — suggested rule changes',
    'Generated ' + new Date().toLocaleString(),
    `${runs.length} optimize run(s), ${edits.length} hand edit(s) on file.`,
    bulkUndos ? `NOTE: ${bulkUndos} bulk undo(s) — counts may be a little high.` : '',
    'These are candidates only. Nothing has been applied to the packer.',
    ''
  ].filter(Boolean);
  if(!cards.length) lines.push('No pattern is clear enough to suggest anything yet.');
  cards.forEach((c,i)=>{
    lines.push(`${i+1}. ${c.rule?'[SHOP RULE] ':''}${strip(c.title)}   (${c.conf}, n=${c.n})`);
    lines.push('   Counted:     ' + strip(c.observed));
    lines.push('   Might mean:  ' + strip(c.suggest));
    lines.push('   Would change: ' + c.where);
    lines.push('');
  });
  return lines.join('\n');
}
function copySuggestions(){
  const txt = suggestionsText();
  const done = ()=>{ const b = document.getElementById('tn-copy'); if(b){ b.textContent = 'Copied'; setTimeout(()=>b.textContent='Copy suggestions', 1600); } };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done, ()=>fallback(txt, done));
  } else fallback(txt, done);
}
function fallback(txt, done){
  const ta = document.createElement('textarea');
  ta.value = txt; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); done(); }catch(e){ alert('Copy did not work — the log download has the same detail.'); }
  document.body.removeChild(ta);
}
function exportLog(){
  const { db } = collect();
  const payload = { exported: new Date().toISOString(), suggestions: analyse(), log: db };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'load-learning-' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 0);
}

/* ============ boot ============ */
injectUI();

})();
