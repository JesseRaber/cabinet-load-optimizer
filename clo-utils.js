(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.CLO_UTIL=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  function escapeHtmlText(value){
    return String(value==null?'':value).replace(/[&<>"']/g,ch=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[ch]);
  }
  const escapeHtmlAttribute=escapeHtmlText;
  return {escapeHtmlText,escapeHtmlAttribute};
});
