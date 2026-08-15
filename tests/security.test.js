const test=require('node:test');
const assert=require('node:assert/strict');
const {escapeHtmlText,escapeHtmlAttribute}=require('../clo-utils.js');

test('escapes hostile imported text without deleting its meaning',()=>{
  const raw=`<svg onload="alert('x')">R&D</svg>`;
  const safe=escapeHtmlText(raw);
  assert.equal(safe,'&lt;svg onload=&quot;alert(&#39;x&#39;)&quot;&gt;R&amp;D&lt;/svg&gt;');
  assert.doesNotMatch(safe,/<svg|onload="/);
});

test('escapes values placed in quoted attributes',()=>{
  assert.equal(escapeHtmlAttribute(`x" onerror='boom'`),'x&quot; onerror=&#39;boom&#39;');
});

test('normalizes nullish text safely',()=>{
  assert.equal(escapeHtmlText(null),'');
  assert.equal(escapeHtmlText(undefined),'');
});
