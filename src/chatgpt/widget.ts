// Spike widget: one self-contained HTML document, vanilla JS, no build step.
// Speaks the MCP Apps bridge (JSON-RPC over postMessage) and falls back to
// window.openai.toolOutput. Replaced by the built React bundle in web/ later.
// The resource URI is a cache key: bump the version suffix on breaking changes.
export const WIDGET_URI = 'ui://widget/business-checking-v1.html'
export const WIDGET_MIME = 'text/html;profile=mcp-app'

export const WIDGET_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--accent:#4ebe7a;--on-accent:#111827}
@media (prefers-color-scheme:dark){:root{--bg:#1f2937;--fg:#f9fafb;--muted:#9ca3af;--line:#374151;--accent:#4ebe7a;--on-accent:#111827}}
body{margin:0;padding:8px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
.head{font-weight:600;margin:0 0 8px;min-height:20px}
.row{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x proximity;padding-bottom:4px}
.card{flex:0 0 220px;scroll-snap-align:start;border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:6px}
.inst{color:var(--muted);font-size:12px}.name{font-weight:600}
.fee{font-size:18px;font-weight:700}
.meta{color:var(--muted);font-size:12px}
button{margin-top:auto;border:0;border-radius:8px;padding:8px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.foot{margin-top:6px;color:var(--muted);font-size:12px}
.sk{flex:0 0 220px;box-sizing:border-box;height:210px;border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px}
.sk i{display:block;height:12px;border-radius:6px;background:var(--line);animation:pulse 1.4s ease-in-out infinite}
.sk i:nth-child(1){width:40%}.sk i:nth-child(2){width:70%}.sk i:nth-child(3){width:50%;height:18px}.sk i:nth-child(4){width:60%}.sk i:last-child{width:100%;height:34px;margin-top:auto;border-radius:8px}
@keyframes pulse{50%{opacity:.4}}
@media (prefers-reduced-motion:reduce){.sk i{animation:none}}
</style></head><body><div id="head" class="head"></div><div id="root" role="list" class="row" aria-busy="true"><div class="sk" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div class="sk" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div class="sk" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div></div><div id="foot" class="foot"></div>
<script>
(function(){
var nextId=1,pending={};
function rpc(method,params){return new Promise(function(res,rej){var id=nextId++;pending[id]={res:res,rej:rej};parent.postMessage({jsonrpc:'2.0',id:id,method:method,params:params},'*');});}
function notify(method,params){parent.postMessage({jsonrpc:'2.0',method:method,params:params},'*');}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
// Learn More asks the model for this account's details as a chat message; there is no outbound link.
function ask(r){
  var inst=r.institution_display_name||r.institution_name||'',prod=r.product_name||'';
  var name=(prod.toLowerCase().indexOf(inst.toLowerCase())===0?prod:inst+' '+prod).trim(); // product names often already start with the bank
  var text='Tell me more about '+name+' ('+r.listing_slug+') and why it could fit my business.';
  if(window.openai&&window.openai.sendFollowUpMessage){window.openai.sendFollowUpMessage({prompt:text});}
  else{rpc('ui/message',{role:'user',content:{type:'text',text:text}}).catch(function(){});}
}
function card(r){
  var c=el('div','card');c.setAttribute('role','listitem');
  c.appendChild(el('div','inst',r.institution_display_name||r.institution_name||''));
  c.appendChild(el('div','name',r.product_name||''));
  c.appendChild(el('div','fee',r.monthly_fee_display||'Fee not published'));
  if(r.minimum_opening_deposit_display)c.appendChild(el('div','meta',r.minimum_opening_deposit_display));
  if(r.apy_display)c.appendChild(el('div','meta',r.apy_display));
  if(r.insurance_display)c.appendChild(el('div','meta',r.insurance_display));
  if(r.last_verified)c.appendChild(el('div','meta','Verified '+String(r.last_verified).slice(0,10)));
  var b=el('button',null,'Learn More');b.setAttribute('aria-label','Learn more about '+(r.product_name||'this account'));
  b.addEventListener('click',function(){if(b.disabled)return;b.disabled=true;ask(r);setTimeout(function(){b.disabled=false;},3000);});
  c.appendChild(b);return c;
}
// Report the content height (not scrollHeight, which can never shrink below the frame).
var lastH=0;
function resize(){
  var h=Math.ceil(document.body.getBoundingClientRect().height);
  if(!h||h===lastH)return;lastH=h;
  if(window.openai&&window.openai.notifyIntrinsicHeight)window.openai.notifyIntrinsicHeight(h);
  notify('ui/notifications/size-changed',{height:h});
}
if(window.ResizeObserver)new ResizeObserver(resize).observe(document.body);
// The frame mounts before the result exists, so it starts as skeleton cards. A result, an error or a cancel replaces them; if none arrives the skeleton gives way to a message.
var head=document.getElementById('head'),root=document.getElementById('root'),foot=document.getElementById('foot');
var lastKey='',settled=false;
var timer=setTimeout(function(){fail('Results are unavailable. Ask me to search again.');},25000);
function settle(){settled=true;clearTimeout(timer);root.removeAttribute('aria-busy');head.textContent='';root.textContent='';foot.textContent='';}
function fail(msg){if(settled&&lastKey)return;settle();root.appendChild(el('div','meta',msg));resize();}
function render(data){
  var key=JSON.stringify(data);if(key===lastKey)return;lastKey=key; // toolOutput and tool-result both deliver the same data: render it once
  settle();
  var rows=(data&&data.rows)||[];
  if(!rows.length){root.appendChild(el('div','meta','No matching accounts.'));resize();return;}
  var total=data.total_matches>rows.length?data.total_matches:rows.length;
  head.textContent=total+(total===1?' account matches':' accounts match')+' your search';
  rows.forEach(function(r){root.appendChild(card(r));});
  if(total>rows.length)foot.textContent='Showing '+rows.length+' of '+total+'. Tell me more about your business to narrow these down.';
  resize();
}
window.addEventListener('message',function(e){
  if(e.source!==parent)return;var m=e.data;if(!m||m.jsonrpc!=='2.0')return;
  if(m.id!==undefined&&!m.method){var p=pending[m.id];if(p){delete pending[m.id];m.error?p.rej(m.error):p.res(m.result);}return;}
  if(m.method==='ui/notifications/tool-result'&&m.params){if(m.params.isError)fail('The search failed. Ask me to try again.');else if(m.params.structuredContent)render(m.params.structuredContent);}
  if(m.method==='ui/notifications/tool-cancelled')fail('The search was cancelled.');
});
window.addEventListener('openai:set_globals',function(){if(window.openai&&window.openai.toolOutput)render(window.openai.toolOutput);}); // ChatGPT can fill toolOutput after load
rpc('ui/initialize',{appInfo:{name:'bancadia-business-checking',version:'0.1.0'},appCapabilities:{},protocolVersion:'2026-01-26'})
  .then(function(){notify('ui/notifications/initialized',{});}).catch(function(){});
if(window.openai&&window.openai.toolOutput)render(window.openai.toolOutput);
})();
</script></body></html>`
