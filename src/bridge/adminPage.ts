export function adminPage(): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatBridge 控制台</title>
<style>
:root{color-scheme:light dark;--bg:#f5f4f0;--panel:#fff;--fg:#1c1c1a;--muted:#6d6b65;--line:#e3e1db;--accent:#1f6f5c;--warn:#a15c00;--bad:#b3261e;--good:#1f6f5c;--mono:ui-monospace,"Cascadia Code",Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#131312;--panel:#1d1d1b;--fg:#ebeae4;--muted:#9a988f;--line:#33322e;--accent:#5cc2a6;--warn:#f0b35a;--bad:#f2b8b5;--good:#5cc2a6}button.primary{color:#0b231c!important;font-weight:600}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,"Segoe UI","Noto Sans TC",sans-serif;padding:24px 16px}
.wrap{max-width:1100px;margin:0 auto}header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px}
h1{font-size:20px;margin:0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;min-width:0}
.big{font-size:22px;font-weight:600}.muted{color:var(--muted)}.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--good)}.dot.off{background:var(--bad)}
button{white-space:nowrap;font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad);border-color:var(--bad)}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere;font-family:var(--mono);font-size:12.5px}
.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
td.mono{font-family:var(--mono);font-size:12px;max-width:420px;overflow-wrap:anywhere}.ok{color:var(--good)}.error,.denied{color:var(--bad)}.paused{color:var(--warn)}
#login{max-width:420px;margin:12vh auto}input{font:inherit;width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);margin:8px 0 12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
</style></head><body><div class="wrap">
<div id="login" class="panel" hidden><h1>ChatBridge 控制台</h1><p class="muted">輸入管理 token（執行 <code>chatbridge admin-url</code> 取得）。</p>
<input id="tok" type="password" autocomplete="off"><button class="primary" id="go">進入</button></div>
<div id="app" hidden>
<header><div><h1>ChatBridge 控制台</h1><div class="muted" id="sub"></div></div>
<div class="row"><span class="pill" id="state"><span class="dot"></span>…</span><button id="pause">暫停所有遠端操作</button></div></header>
<div class="grid">
<section class="panel"><h2>連線</h2><dl id="info"></dl></section>
<section class="panel"><h2>已授權的應用程式</h2><div class="tablewrap"><table><thead><tr><th>名稱</th><th>最後使用</th><th></th></tr></thead><tbody id="clients"></tbody></table></div>
<div class="row" style="margin-top:12px"><button class="danger" id="revokeAll">撤銷全部授權</button></div></section>
</div>
<section class="panel" style="margin-top:16px"><h2>指令工作階段</h2><div class="tablewrap"><table><thead><tr><th>ID</th><th>指令</th><th>狀態</th><th>開始</th><th></th></tr></thead><tbody id="sessions"></tbody></table></div></section>
<section class="panel" style="margin-top:16px"><h2>操作紀錄 <span class="muted" id="chain"></span></h2><div class="tablewrap"><table><thead><tr><th>時間</th><th>來源</th><th>動作</th><th>結果</th><th>參數</th></tr></thead><tbody id="audit"></tbody></table></div></section>
</div></div>
<script>
const $=s=>document.querySelector(s);let token='';
try{const h=new URLSearchParams(location.hash.slice(1)).get('token');if(h){sessionStorage.setItem('cbt',h);history.replaceState(null,'',location.pathname)}token=sessionStorage.getItem('cbt')||''}catch(e){}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,body){const r=await fetch('/admin/api/'+p,{method:body?'POST':'GET',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(r.status===401){showLogin();throw new Error('unauthorized')}return r.json()}
function showLogin(){$('#app').hidden=true;$('#login').hidden=false}
$('#go').onclick=()=>{token=$('#tok').value.trim();try{sessionStorage.setItem('cbt',token)}catch(e){}$('#login').hidden=true;load()};
const t=s=>s?new Date(s).toLocaleString():'—';
async function load(){
 const s=await api('status');$('#app').hidden=false;
 $('#state').innerHTML='<span class="dot'+(s.paused?' off':'')+'"></span>'+(s.paused?'已暫停':'運作中');
 $('#pause').textContent=s.paused?'恢復遠端操作':'暫停所有遠端操作';$('#pause').className=s.paused?'primary':'danger';
 $('#pause').onclick=async()=>{await api('pause',{paused:!s.paused,reason:s.paused?'':'paused from dashboard'});load()};
 $('#sub').textContent=(s.executor.kind||'')+' '+(s.executor.version||'');
 $('#info').innerHTML=[['MCP 網址',s.mcpUrl],['公開網址',s.publicUrl||'（未設定）'],['認證',s.authMode],['權限模式',s.policy],['工作目錄',s.workingDirectory]].map(([k,v])=>'<dt>'+k+'</dt><dd>'+esc(v)+'</dd>').join('');
 $('#chain').textContent=s.auditChain.ok?'· 雜湊鏈完整（'+s.auditChain.records+' 筆）':'· 雜湊鏈在第 '+s.auditChain.brokenAt+' 筆損壞';
 const c=await api('clients');
 $('#clients').innerHTML=c.clients.map(x=>'<tr><td>'+esc(x.name)+'<div class="muted mono">'+esc(x.clientId)+'</div></td><td>'+t(x.lastUsedAt)+'</td><td><button class="danger" data-rev="'+esc(x.clientId)+'">撤銷</button></td></tr>').join('')+c.staticTokens.map(x=>'<tr><td>token: '+esc(x.name)+'</td><td>'+t(x.createdAt)+'</td><td class="muted">CLI 管理</td></tr>').join('')||'<tr><td colspan="3" class="muted">尚無</td></tr>';
 document.querySelectorAll('[data-rev]').forEach(b=>b.onclick=async()=>{if(confirm('撤銷這個應用程式的所有 token？')){await api('clients/'+encodeURIComponent(b.dataset.rev)+'/revoke',{});load()}});
 const ss=await api('sessions');
 $('#sessions').innerHTML=ss.sessions.slice().reverse().map(x=>'<tr><td>'+x.sessionId+'</td><td class="mono">'+esc(x.command)+'</td><td>'+(x.running?'<span class="paused">執行中</span>':'exit '+x.exitCode)+'</td><td>'+t(x.startedAt)+'</td><td>'+(x.running?'<button class="danger" data-kill="'+x.sessionId+'">停止</button>':'')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">尚無</td></tr>';
 document.querySelectorAll('[data-kill]').forEach(b=>b.onclick=async()=>{await api('sessions/'+b.dataset.kill+'/kill',{});load()});
 const a=await api('audit?n=150');
 $('#audit').innerHTML=a.records.map(r=>'<tr><td>'+t(r.ts)+'</td><td class="mono">'+esc(r.actor)+'</td><td>'+esc(r.action)+'</td><td class="'+r.outcome+'">'+r.outcome+(r.detail?'<div class="muted">'+esc(String(r.detail).slice(0,160))+'</div>':'')+'</td><td class="mono">'+esc(JSON.stringify(r.args??'').slice(0,240))+'</td></tr>').join('');
}
$('#revokeAll').onclick=async()=>{if(confirm('撤銷所有 OAuth 授權？ChatGPT / Claude 需要重新連線。')){await api('revoke-all',{});load()}};
if(token)load().catch(()=>{});else showLogin();
setInterval(()=>{if(!$('#app').hidden)load().catch(()=>{})},5000);
</script></body></html>`;
}
