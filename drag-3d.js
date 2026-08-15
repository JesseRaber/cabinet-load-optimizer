/* 3D cabinet dragging for the Manual Layout view. */
(function(){
  'use strict';
  let active=null, ghostGroup=null, ghostMesh=null;

  function rayFromEvent(evt){
    const r=renderer.domElement.getBoundingClientRect();
    const nd=new THREE.Vector2(((evt.clientX-r.left)/r.width)*2-1,
                              -((evt.clientY-r.top)/r.height)*2+1);
    const ray=new THREE.Raycaster(); ray.setFromCamera(nd,camera); return ray;
  }
  function pointOnPlane(evt,y){
    const ray=rayFromEvent(evt);
    if(Math.abs(ray.ray.direction.y)<0.02) return null;
    const hit=new THREE.Vector3();
    if(!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-y),hit)) return null;
    const g=window.CLO_ML.getGeometry();
    return {x:hit.x+g.W/2,z:hit.z+g.totalL/2};
  }
  function clearGhost(){
    if(ghostGroup) ghostGroup.visible=false;
  }
  function ensureGhost(){
    if(ghostGroup) return;
    ghostGroup=new THREE.Group(); ghostGroup.name='dragGhostGroup';
    ghostMesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),
      new THREE.MeshBasicMaterial({color:0x22c55e,transparent:true,opacity:0.42,depthWrite:false}));
    ghostGroup.add(ghostMesh); scene.add(ghostGroup);
  }
  function paintGhost(box,chk){
    ensureGhost(); ghostGroup.visible=true;
    const g=window.CLO_ML.getGeometry(), ox=-g.W/2, oz=-g.totalL/2;
    ghostMesh.scale.set(box.w,box.h,box.d);
    ghostMesh.position.set(box.x+box.w/2+ox,box.y+box.h/2,box.z+box.d/2+oz);
    ghostMesh.material.color.setHex(chk.ok?0x22c55e:0xef4444);
  }
  function finish(evt,commit){
    const a=active; if(!a) return;
    active=null;
    try{
      if(commit && a.last && a.last.chk.ok) window.CLO_ML.commit(a.cab,a.last.box);
      else window.CLO_ML.cancelDrag();
    } finally {
      clearGhost();
      controls.enabled=a.controlsEnabled;
      window.removeEventListener('pointermove',move,true);
      window.removeEventListener('pointerup',up,true);
      window.removeEventListener('pointercancel',cancel,true);
      a.canvas.removeEventListener('lostpointercapture',lost,true);
      try{ if(a.canvas.hasPointerCapture(evt.pointerId)) a.canvas.releasePointerCapture(evt.pointerId); }catch(e){}
    }
  }
  function move(evt){
    if(!active || evt.pointerId!==active.pointerId) return;
    const q=pointOnPlane(evt,active.planeY);
    if(!q) return; // grazing ray: keep the last stable ghost
    const out=window.CLO_ML.dragBoxAt(q,window.CLO_ML.getDragState());
    active.last=out; paintGhost(out.box,out.chk); evt.preventDefault();
  }
  function up(evt){ if(active&&evt.pointerId===active.pointerId) finish(evt,true); }
  function cancel(evt){ if(active&&evt.pointerId===active.pointerId) finish(evt,false); }
  function lost(evt){ if(active&&evt.pointerId===active.pointerId) finish(evt,false); }

  document.addEventListener('pointerdown',evt=>{
    if(evt.button!==0 || !window.CLO_ML || !window.CLO_RULES_V2 || !renderer || evt.target!==renderer.domElement) return;
    if(!renderer.domElement.parentElement || renderer.domElement.parentElement.id!=='ml-3d') return;
    const hits=rayFromEvent(evt).intersectObjects(window.CLO_ML.getPickables(),false);
    if(!hits.length) return; // empty space remains OrbitControls territory
    const cab=cabinets.find(c=>c.id===hits[0].object.userData.cid);
    const box=cab&&window.CLO_ML.getPlacedBox(cab); if(!box) return;
    const q=pointOnPlane(evt,box.y); if(!q) return;
    const was=controls.enabled; controls.enabled=false;
    try{
      window.CLO_ML.selectCabinet(cab);
      const d=window.CLO_ML.beginDragAt(q,cab,box);
      active={cab,canvas:renderer.domElement,pointerId:evt.pointerId,planeY:box.y,controlsEnabled:was,last:null};
      active.canvas.setPointerCapture(evt.pointerId);
      window.addEventListener('pointermove',move,true);
      window.addEventListener('pointerup',up,true);
      window.addEventListener('pointercancel',cancel,true);
      active.canvas.addEventListener('lostpointercapture',lost,true);
      const out=window.CLO_ML.dragBoxAt(q,d); active.last=out; paintGhost(out.box,out.chk);
      evt.preventDefault();
    }catch(e){
      controls.enabled=was; active=null; clearGhost(); throw e;
    }
  },true);
})();
