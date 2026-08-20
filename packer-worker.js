'use strict';

/* Dedicated packing Worker. The page creates this as an additive async path;
   the synchronous window.packLoad API remains installed by load-rules-v2.js. */
(function(scope){
  function errorMessage(error){ return error && error.message ? error.message : String(error); }
  try {
    scope.window = scope;
    importScripts('load-placement-core.js', 'packing-runtime.js', 'load-rules-v2.js');
    if(scope.CLO_ACTIVE_ENGINE !== 'v2' || typeof scope.packLoad !== 'function')
      throw new Error('V2 packing engine did not activate in the Worker.');
    scope.postMessage({type:'ready', engine:scope.CLO_ACTIVE_ENGINE});
  } catch(error) {
    scope.postMessage({type:'startup-error', error:errorMessage(error)});
    return;
  }

  scope.onmessage = event => {
    const message = event.data || {};
    if(message.type !== 'pack') return;
    try {
      const result = scope.packLoad(message.cabinets, message.geom, Object.assign({}, message.options, {
        onProgress: progress => scope.postMessage({type:'progress', attempted:progress.attempted, total:progress.total})
      }));
      scope.postMessage({type:'result', engine:scope.CLO_ACTIVE_ENGINE, result});
    } catch(error) {
      scope.postMessage({type:'runtime-error', error:errorMessage(error)});
    }
  };
})(self);
