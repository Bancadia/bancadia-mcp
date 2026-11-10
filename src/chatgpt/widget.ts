// Spike widget: one self-contained HTML document, vanilla JS, no build step.
// Speaks the MCP Apps bridge (JSON-RPC over postMessage) and falls back to
// window.openai.toolOutput. Replaced by the built React bundle in web/ later.
// The resource URI is a cache key: bump the version suffix on breaking changes.
export const WIDGET_URI = 'ui://widget/business-checking-v1.html'
export const WIDGET_MIME = 'text/html;profile=mcp-app'

export const WIDGET_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#1f2937;--fg:#f9fafb;--muted:#9ca3af;--line:#374151;--accent:#2dd4bf}}
body{margin:0;padding:8px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
.row{display:flex;gap:8px;overflow-x:auto}
.card{flex:0 0 220px;border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:6px}
.inst{color:var(--muted);font-size:12px}.name{font-weight:600}
.fee{font-size:18px;font-weight:700}
.meta{color:var(--muted);font-size:12px}
button{margin-top:auto;border:0;border-radius:8px;padding:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.foot{margin-top:6px;color:var(--muted);font-size:12px}
</style></head><body><div id="root" role="list" class="row"></div><div id="foot" class="foot"></div>
<script>
(function(){
var APPLY_PREFIX='https://bancadia.com/go/';
var nextId=1,pending={};
function rpc(method,params){return new Promise(function(res,rej){var id=nextId++;pending[id]={res:res,rej:rej};parent.postMessage({jsonrpc:'2.0',id:id,method:method,params:params},'*');});}
function notify(method,params){parent.postMessage({jsonrpc:'2.0',method:method,params:params},'*');}
function money(n){return '$'+Number(n).toLocaleString('en-US',{maximumFractionDigits:2});}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function openApply(url){
  if(typeof url!=='string'||url.indexOf(APPLY_PREFIX)!==0)return;
  if(window.openai&&window.openai.openExternal){window.openai.openExternal({href:url});}
  else{rpc('ui/open-link',{url:url}).catch(function(){});}
}
function render(data){
  var root=document.getElementById('root'),foot=document.getElementById('foot');
  root.textContent='';foot.textContent='';
  var rows=(data&&data.rows)||[];
  if(!rows.length){root.appendChild(el('div','meta','No matching accounts.'));return;}
  rows.forEach(function(r){
    var c=el('div','card');c.setAttribute('role','listitem');
    c.appendChild(el('div','inst',r.institution_display_name||r.institution_name||''));
    c.appendChild(el('div','name',r.product_name||''));
    c.appendChild(el('div','fee',r.monthly_fee===0?'No monthly fee':(r.monthly_fee==null?'Fee not published':money(r.monthly_fee)+'/mo')));
    if(r.minimum_opening_deposit!=null)c.appendChild(el('div','meta',r.minimum_opening_deposit===0?'No minimum to open':money(r.minimum_opening_deposit)+' to open'));
    if(r.apy_max)c.appendChild(el('div','meta','Up to '+r.apy_max+'% APY'));
    if(r.insurance_type)c.appendChild(el('div','meta',String(r.insurance_type).toUpperCase()+' insured'));
    if(r.last_verified)c.appendChild(el('div','meta','Verified '+String(r.last_verified).slice(0,10)));
    var b=el('button',null,'Apply');b.setAttribute('aria-label','Apply for '+(r.product_name||'this account'));
    b.addEventListener('click',function(){openApply(r.application_url);});
    c.appendChild(b);root.appendChild(c);
  });
  if(data.total_matches>rows.length)foot.textContent='Showing '+rows.length+' of '+data.total_matches+' matches';
}
window.addEventListener('message',function(e){
  if(e.source!==parent)return;var m=e.data;if(!m||m.jsonrpc!=='2.0')return;
  if(m.id!==undefined&&!m.method){var p=pending[m.id];if(p){delete pending[m.id];m.error?p.rej(m.error):p.res(m.result);}return;}
  if(m.method==='ui/notifications/tool-result'&&m.params)render(m.params.structuredContent);
});
rpc('ui/initialize',{appInfo:{name:'bancadia-business-checking',version:'0.1.0'},appCapabilities:{},protocolVersion:'2026-01-26'})
  .then(function(){notify('ui/notifications/initialized',{});}).catch(function(){});
if(window.openai&&window.openai.toolOutput)render(window.openai.toolOutput);
})();
</script></body></html>`
