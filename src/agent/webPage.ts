export function webPage(name: string): string {
  const safeName = name.replace(/[<>&"]/g, "");
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f3ee;--panel:#fbfaf7;--card:#fff;--fg:#1b1b19;--muted:#6f6d66;--faint:#9b988f;--line:#e4e1d8;--accent:#b4541f;--accent-soft:#f3e3d6;--ok:#2f7a55;--bad:#b3261e;--warn:#9a6400;--code:#f0eee7;--mono:ui-monospace,"Cascadia Code",Consolas,monospace;--sans:system-ui,"Segoe UI","Noto Sans TC","PingFang TC",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--panel:#181816;--card:#1f1f1c;--fg:#ecebe5;--muted:#a3a198;--faint:#75736b;--line:#2f2e2a;--accent:#e58a4e;--accent-soft:#3a2618;--ok:#6cc596;--bad:#f2a19b;--warn:#e7b85c;--code:#262622}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:14.5px/1.55 var(--sans)}
button,input,textarea,select{font:inherit;color:inherit}
button{cursor:pointer;border:1px solid var(--line);background:var(--card);border-radius:8px;padding:6px 12px}
button:hover{border-color:var(--faint)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.ghost{background:transparent;border-color:transparent;color:var(--muted)}button.ghost:hover{color:var(--fg);background:var(--code)}
button.danger{color:var(--bad)}input,textarea,select{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;width:100%}
input:focus,textarea:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
.app{display:grid;grid-template-columns:272px 1fr;height:100vh}
aside{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.brand{padding:16px 16px 8px;display:flex;align-items:center;gap:10px}.logo{width:30px;height:30px;border-radius:9px;background:var(--accent);display:grid;place-items:center;color:#fff;font-weight:700}
.brand b{font-size:16px}.model{font-size:11.5px;color:var(--muted);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}
nav{display:flex;flex-direction:column;gap:2px;padding:8px}nav button{border:0;background:transparent;text-align:left;padding:8px 10px;display:flex;justify-content:space-between;align-items:center;color:var(--muted)}
nav button.on{background:var(--accent-soft);color:var(--fg);font-weight:600}.badge{background:var(--accent);color:#fff;border-radius:999px;font-size:11px;padding:0 7px;min-width:18px;text-align:center}
.newchat{margin:4px 12px 8px}.sessions{overflow-y:auto;padding:4px 8px 16px;flex:1;min-height:0}
.sessions h4{margin:12px 8px 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.sess{display:block;width:100%;text-align:left;border:0;background:transparent;padding:7px 10px;border-radius:8px}.sess:hover{background:var(--code)}.sess.on{background:var(--card);box-shadow:0 0 0 1px var(--line)}
.sess .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}.sess .m{font-size:11.5px;color:var(--faint)}
main{display:flex;flex-direction:column;min-width:0;min-height:0}
.topbar{display:flex;align-items:center;gap:8px;padding:10px 20px;border-bottom:1px solid var(--line);min-height:52px}.topbar h2{font-size:15px;margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu{display:none}
.scroll{flex:1;overflow-y:auto;min-height:0}.thread{max-width:860px;margin:0 auto;padding:24px 20px 40px}
.msg{margin:0 0 18px}.user{display:flex;justify-content:flex-end}.user .bubble{background:var(--accent-soft);border-radius:14px 14px 4px 14px;padding:10px 14px;max-width:80%;white-space:pre-wrap;overflow-wrap:anywhere}
.assistant .body{overflow-wrap:anywhere}.assistant .body p{margin:.4em 0}.assistant .body pre{background:var(--code);border-radius:8px;padding:10px 12px;overflow-x:auto;font:12.5px/1.5 var(--mono)}
.assistant .body code{font-family:var(--mono);font-size:.92em;background:var(--code);padding:1px 5px;border-radius:5px}.assistant .body pre code{background:none;padding:0}
.assistant .body h1,.assistant .body h2,.assistant .body h3{font-size:1.05em;margin:.9em 0 .3em}.assistant .body ul,.assistant .body ol{padding-left:1.4em;margin:.3em 0}
.assistant .body a{color:var(--accent)}
.tools{margin:6px 0;border-left:2px solid var(--line);padding-left:10px}
.tool{font-size:12.5px;color:var(--muted);font-family:var(--mono)}.tool summary{cursor:pointer;list-style:none;padding:2px 0;display:flex;gap:8px;align-items:baseline}.tool summary::-webkit-details-marker{display:none}
.tool .n{color:var(--fg)}.tool .a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.tool .s.ok{color:var(--ok)}.tool .s.bad{color:var(--bad)}.tool .s.run{color:var(--warn)}
.tool pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code);border-radius:6px;padding:8px;margin:4px 0 8px;max-height:280px;overflow-y:auto}
.note{font-size:12.5px;color:var(--faint);margin:6px 0}.note.learn{color:var(--accent)}
.composer{border-top:1px solid var(--line);padding:12px 20px 16px;background:var(--bg)}.composer .box{max-width:860px;margin:0 auto;display:flex;gap:8px;align-items:flex-end}
.composer textarea{resize:none;min-height:46px;max-height:240px;border-radius:12px;padding:12px 14px;overflow-y:hidden;line-height:1.45}
.composer button{white-space:nowrap;min-width:72px;height:46px;border-radius:12px}
.empty{max-width:560px;margin:14vh auto 0;text-align:center;color:var(--muted)}.empty h1{color:var(--fg);font-size:26px;margin-bottom:6px}
.chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:18px}.chips button{border-radius:999px;font-size:13px}
.page{max-width:980px;margin:0 auto;padding:22px 20px 60px}.page h3{margin:0 0 12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:180px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:8px 0}
.kind{font-size:11px;border-radius:999px;padding:1px 8px;background:var(--code);color:var(--muted);font-family:var(--mono)}
.imp{height:4px;border-radius:2px;background:var(--code);width:60px;overflow:hidden;display:inline-block;vertical-align:middle}.imp i{display:block;height:100%;background:var(--accent)}
.split{display:grid;grid-template-columns:300px 1fr;gap:16px}.list button{display:block;width:100%;text-align:left;margin:4px 0;border-radius:10px}
.muted{color:var(--muted)}.small{font-size:12.5px}.mono{font-family:var(--mono);font-size:12.5px}
.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top;font-size:13px}th{color:var(--muted);font-weight:500}
#login{max-width:420px;margin:18vh auto;padding:0 16px}
@media (max-width:760px){.app{grid-template-columns:1fr}aside{position:fixed;inset:0 25% 0 0;z-index:5;transform:translateX(-105%);transition:transform .2s;box-shadow:0 0 40px rgba(0,0,0,.25)}aside.open{transform:none}.menu{display:inline-block}.split{grid-template-columns:1fr}.user .bubble{max-width:92%}.thread,.page{padding-left:16px;padding-right:16px}.composer{padding-left:16px;padding-right:16px}}
</style></head><body>
<div id="login" hidden><h1>${safeName}</h1><p class="muted">輸入 Web token（執行 <code>kestrel web-url</code> 取得連結）。</p><input id="tok" type="password" autocomplete="off"><p><button class="primary" id="go">進入</button></p></div>
<div class="app" id="app" hidden>
<aside id="side">
  <div class="brand"><div class="logo">K</div><div><b>${safeName}</b><div class="model" id="model"></div></div></div>
  <button class="primary newchat" id="newchat">＋ 新對話</button>
  <nav id="nav">
    <button data-v="chat" class="on">對話</button>
    <button data-v="memory">記憶 <span class="muted small" id="cMem"></span></button>
    <button data-v="skills">技能 <span class="muted small" id="cSk"></span></button>
    <button data-v="jobs">排程 <span class="muted small" id="cJobs"></span></button>
    <button data-v="inbox">收件匣 <span class="badge" id="cInbox" hidden></span></button>
  </nav>
  <div class="sessions" id="sessions"></div>
</aside>
<main>
  <div class="topbar"><button class="ghost menu" id="menu">☰</button><h2 id="title">新對話</h2><span id="actions" class="row"></span></div>
  <div class="scroll" id="scroll"><div id="view"></div></div>
  <div class="composer" id="composer"><div class="box"><textarea id="input" rows="1" placeholder="交代任務，或問任何事…（Enter 送出，Shift+Enter 換行）"></textarea><button class="primary" id="send">送出</button></div></div>
</main>
</div>
<script>
const $=s=>document.querySelector(s);let token='';
try{const h=new URLSearchParams(location.hash.slice(1)).get('token');if(h){sessionStorage.setItem('kt',h);history.replaceState(null,'','/')}token=sessionStorage.getItem('kt')||''}catch(e){}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(p,opt={}){const r=await fetch('/api/'+p,{method:opt.method||(opt.body?'POST':'GET'),headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:opt.body?JSON.stringify(opt.body):undefined});
 if(r.status===401){showLogin();throw new Error('unauthorized')}const j=await r.json();if(!r.ok)throw new Error(j.error||r.statusText);return j}
function showLogin(){$('#app').hidden=true;$('#login').hidden=false}
$('#go').onclick=()=>{token=$('#tok').value.trim();try{sessionStorage.setItem('kt',token)}catch(e){}$('#login').hidden=true;boot()};
function md(src){const blocks=[];let s=String(src||'').replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g,(m,l,c)=>{blocks.push('<pre><code>'+esc(c.replace(/\\n$/,''))+'</code></pre>');return '\\u0000'+(blocks.length-1)+'\\u0000'});
 s=esc(s);s=s.replace(/\`([^\`\\n]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*\\n]+)\\*\\*/g,'<b>$1</b>').replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');
 const out=[];let list=null;for(const line of s.split('\\n')){const h=line.match(/^(#{1,3}) (.*)/),li=line.match(/^\\s*(?:[-*•]|\\d+\\.) (.*)/);
  if(li){if(!list){list=[];out.push(list)}list.push('<li>'+li[1]+'</li>');continue}list=null;
  if(h)out.push('<h3>'+h[2]+'</h3>');else if(line.trim()==='')out.push('');else out.push('<p>'+line+'</p>')}
 return out.map(x=>Array.isArray(x)?'<ul>'+x.join('')+'</ul>':x).join('').replace(/\\u0000(\\d+)\\u0000/g,(m,i)=>blocks[+i])}
const ago=t=>{const d=(Date.now()-Date.parse(t))/1000;return d<60?'剛剛':d<3600?Math.floor(d/60)+' 分鐘前':d<86400?Math.floor(d/3600)+' 小時前':new Date(t).toLocaleDateString()};
let view='chat',sessionId=null,busy=false,ctl=null,sessionsCache=[];
document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>{view=b.dataset.v;document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('on',x===b));$('#side').classList.remove('open');render()});
$('#menu').onclick=()=>$('#side').classList.toggle('open');
$('#newchat').onclick=()=>{sessionId=null;view='chat';document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('on',x.dataset.v==='chat'));$('#side').classList.remove('open');render()};
async function refreshSide(){const st=await api('state');$('#model').textContent=st.model;$('#cMem').textContent=st.memories;$('#cSk').textContent=st.skills;$('#cJobs').textContent=st.jobs;$('#cInbox').hidden=!st.unread;$('#cInbox').textContent=st.unread;
 const {sessions}=await api('sessions');sessionsCache=sessions;const groups={};for(const x of sessions){const k=x.source.startsWith('job:')?'排程執行':x.source==='telegram'?'Telegram':x.source==='mcp'?'來自 ChatGPT / Claude':'對話';(groups[k]=groups[k]||[]).push(x)}
 $('#sessions').innerHTML=Object.entries(groups).map(([k,v])=>'<h4>'+k+'</h4>'+v.map(x=>'<button class="sess'+(x.id===sessionId?' on':'')+'" data-id="'+x.id+'"><span class="t">'+esc(x.title||'(未命名)')+'</span><span class="m">'+ago(x.updatedAt)+' · '+x.messages+' 則</span></button>').join('')).join('');
 document.querySelectorAll('.sess').forEach(b=>b.onclick=()=>{sessionId=b.dataset.id;view='chat';document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('on',x.dataset.v==='chat'));$('#side').classList.remove('open');render()})}
function toolRow(name,args,state,preview,ms){let a=args;try{const j=JSON.parse(args);a=j.command||j.path||j.pattern||j.query||j.url||j.name||j.goal||j.task||(j.tasks?j.tasks.length+' 個子任務':'')||args}catch(e){}
 const s=state==='run'?'<span class="s run">…</span>':state==='ok'?'<span class="s ok">✓'+(ms!=null?' '+(ms/1000).toFixed(1)+'s':'')+'</span>':'<span class="s bad">✗</span>';
 return '<details class="tool"><summary><span class="n">'+esc(name)+'</span><span class="a">'+esc(String(a).slice(0,200))+'</span>'+s+'</summary><pre>'+esc(args)+'</pre>'+(preview?'<pre>'+esc(preview)+'</pre>':'')+'</details>'}
function composer(on){$('#composer').hidden=!on}
async function renderChat(){composer(true);const v=$('#view');
 if(!sessionId){$('#title').textContent='新對話';$('#actions').innerHTML='';v.innerHTML='<div class="empty"><h1>今天要我做什麼？</h1><p>我在你的電腦上工作：執行指令、改程式、操作桌面、上網查資料，並記住學到的東西。</p><div class="chips">'+['看一下這台電腦的 GPU 和磁碟狀況','幫我整理下載資料夾，按類型分類','每天早上 9 點摘要我專案的 git 變更'].map(x=>'<button>'+esc(x)+'</button>').join('')+'</div></div>';
  v.querySelectorAll('.chips button').forEach(b=>b.onclick=()=>{$('#input').value=b.textContent;$('#input').focus()});return}
 const d=await api('sessions/'+sessionId);$('#title').textContent=d.session.title||'(未命名)';
 $('#actions').innerHTML='<button class="ghost" id="aLearn" title="整理這段對話學到的記憶與技能">學習</button><button class="ghost" id="aUndo" title="還原最近一次檔案變更">還原</button><button class="ghost danger" id="aDel">刪除</button>';
 $('#aLearn').onclick=async()=>{const r=await api('sessions/'+sessionId+'/reflect',{body:{}});alert('記住 '+r.memories+' 筆記憶'+(r.skill?'，新技能「'+r.skill+'」':''));refreshSide()};
 $('#aUndo').onclick=async()=>{if(!confirm('還原這個對話最近一次修改的檔案？'))return;try{const r=await api('sessions/'+sessionId+'/undo',{body:{}});alert('已還原 '+r.restored.length+' 個檔案')}catch(e){alert(e.message)}};
 $('#aDel').onclick=async()=>{if(!confirm('刪除這段對話？'))return;await api('sessions/'+sessionId,{method:'DELETE'});sessionId=null;refreshSide();render()};
 const results={};for(const m of d.messages)if(m.role==='tool')results[m.toolCallId]=m;
 let html='';if(d.session.summary)html+='<div class="note">⟲ 較早的內容已壓縮成摘要</div>';
 for(const m of d.messages){const text=typeof m.content==='string'?m.content:(m.content||[]).map(p=>p.type==='text'?p.text:'[圖片]').join('\\n');
  if(m.role==='user'){if(text.startsWith('[system]')||text.startsWith('[images returned'))continue;html+='<div class="msg user"><div class="bubble">'+esc(text)+'</div></div>'}
  else if(m.role==='assistant'){html+='<div class="msg assistant">'+(text?'<div class="body">'+md(text)+'</div>':'')+((m.toolCalls||[]).length?'<div class="tools">'+m.toolCalls.map(c=>{const r=results[c.id];const rt=r?(typeof r.content==='string'?r.content:''):'';return toolRow(c.name,c.arguments,r?(rt.startsWith('Error')?'bad':'ok'):'run',rt.slice(0,3000))}).join('')+'</div>':'')+'</div>'}}
 v.innerHTML='<div class="thread" id="thread">'+html+'</div>';$('#scroll').scrollTop=1e9}
async function send(){const text=$('#input').value.trim();if(!text||busy)return;busy=true;$('#input').value='';autosize();$('#send').textContent='停止';
 if(view!=='chat'){view='chat'}if(!sessionId){$('#view').innerHTML='<div class="thread" id="thread"></div>'}
 const th=$('#thread')||(()=>{$('#view').innerHTML='<div class="thread" id="thread"></div>';return $('#thread')})();
 th.insertAdjacentHTML('beforeend','<div class="msg user"><div class="bubble">'+esc(text)+'</div></div>');
 let cur=null,raw='';const tools={};const newBlock=()=>{th.insertAdjacentHTML('beforeend','<div class="msg assistant"><div class="body"></div><div class="tools"></div></div>');cur=th.lastElementChild;raw=''};newBlock();
 const scroll=()=>{const sc=$('#scroll');if(sc.scrollHeight-sc.scrollTop-sc.clientHeight<200)sc.scrollTop=1e9};scroll();
 ctl=new AbortController();
 try{const r=await fetch('/api/chat',{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({sessionId,message:text}),signal:ctl.signal});
  if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||r.statusText)}
  const reader=r.body.getReader();const dec=new TextDecoder();let buf='';
  for(;;){const {value,done}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
   while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line)continue;const e=JSON.parse(line);
    if(e.type==='session'){if(!sessionId){sessionId=e.sessionId;refreshSide()}}
    else if(e.type==='text'){raw+=e.delta;cur.querySelector('.body').innerHTML=md(raw);scroll()}
    else if(e.type==='assistant'){if(e.toolCalls.length){}}
    else if(e.type==='tool_start'){const t=cur.querySelector('.tools');t.insertAdjacentHTML('beforeend','<div data-t="'+esc(e.id)+'">'+toolRow(e.name,e.args,'run')+'</div>');tools[e.id]=e;scroll()}
    else if(e.type==='tool_end'){const el=cur.querySelector('[data-t="'+CSS.escape(e.id)+'"]');if(el)el.innerHTML=toolRow(e.name,tools[e.id]?tools[e.id].args:'',e.ok?'ok':'bad',e.preview,e.durationMs);if(raw||Object.keys(tools).length){} }
    else if(e.type==='compaction'){th.insertAdjacentHTML('beforeend','<div class="note">⟲ 內容已壓縮（'+e.beforeTokens+' → '+e.afterTokens+' tokens）</div>')}
    else if(e.type==='reflection'){th.insertAdjacentHTML('beforeend','<div class="note learn">✦ 學到 '+e.memories+' 筆記憶'+(e.skill?'，新技能「'+esc(e.skill)+'」':'')+'</div>')}
    else if(e.type==='error'){th.insertAdjacentHTML('beforeend','<div class="note" style="color:var(--bad)">✗ '+esc(e.message)+'</div>')}
    else if(e.type==='turn_end'){if(e.stopped!=='completed')th.insertAdjacentHTML('beforeend','<div class="note">（'+e.stopped+'）</div>')}
    if(e.type==='assistant'&&e.toolCalls.length){newBlock()}
   }}
 }catch(err){if(err.name!=='AbortError')th.insertAdjacentHTML('beforeend','<div class="note" style="color:var(--bad)">✗ '+esc(err.message)+'</div>')}
 finally{busy=false;ctl=null;$('#send').textContent='送出';refreshSide();setTimeout(()=>{if(view==='chat'&&!busy)renderChat()},300)}}
$('#send').onclick=()=>{if(busy){if(sessionId)api('chat/'+sessionId+'/abort',{body:{}}).catch(()=>{});ctl&&setTimeout(()=>ctl&&ctl.abort(),4000)}else send()};
const autosize=()=>{const t=$('#input');t.style.height='auto';const h=Math.max(46,t.scrollHeight+2);t.style.height=Math.min(240,h)+'px';t.style.overflowY=h>240?'auto':'hidden'};
$('#input').addEventListener('input',autosize);$('#input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send()}});
async function renderMemory(){composer(false);$('#title').textContent='記憶';$('#actions').innerHTML='';const v=$('#view');
 const load=async q=>{const d=await api('memories'+(q?'?q='+encodeURIComponent(q):''));
  $('#memlist').innerHTML=d.memories.map(m=>'<div class="card"><div class="row"><span class="kind">'+m.kind+'</span><span class="imp" title="重要度 '+m.importance.toFixed(2)+'"><i style="width:'+Math.round(m.importance*100)+'%"></i></span><span class="muted small grow">#'+m.id+' · 使用 '+m.useCount+' 次 · '+ago(m.updatedAt)+'</span><button class="ghost danger" data-del="'+m.id+'">刪除</button></div><div style="margin-top:6px">'+esc(m.content)+'</div></div>').join('')||'<p class="muted">沒有記憶</p>';
  $('#profile').innerHTML=Object.entries(d.profile).map(([k,val])=>'<tr><td class="mono">'+esc(k)+'</td><td>'+esc(val)+'</td></tr>').join('')||'<tr><td class="muted">尚未學到個人資料</td></tr>';
  v.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{await api('memories/'+b.dataset.del,{method:'DELETE'});load($('#q').value);refreshSide()})};
 v.innerHTML='<div class="page"><h3>長期記憶</h3><div class="row"><input id="q" class="grow" placeholder="搜尋記憶（中英文皆可）"></div><div class="card"><div class="row"><select id="mk" style="width:130px"><option>fact</option><option>preference</option><option>project</option><option>lesson</option><option>person</option><option>environment</option></select><input id="mc" class="grow" placeholder="新增一筆記憶…"><button class="primary" id="madd">新增</button></div></div><div id="memlist"></div><h3 style="margin-top:28px">關於你</h3><div class="tablewrap"><table id="profile"></table></div></div>';
 let tmr;$('#q').oninput=()=>{clearTimeout(tmr);tmr=setTimeout(()=>load($('#q').value),250)};
 $('#madd').onclick=async()=>{if(!$('#mc').value.trim())return;await api('memories',{body:{content:$('#mc').value,kind:$('#mk').value}});$('#mc').value='';load();refreshSide()};load()}
async function renderSkills(){composer(false);$('#title').textContent='技能庫';$('#actions').innerHTML='';const v=$('#view');const d=await api('skills');
 v.innerHTML='<div class="page"><div class="split"><div class="list" id="sklist">'+(d.skills.map(k=>'<button data-s="'+esc(k.slug)+'"><b>'+esc(k.name)+'</b><div class="muted small">v'+k.version+' · '+k.origin+(k.uses?' · 成功 '+k.successes+'/'+k.uses:'')+'</div></button>').join('')||'<p class="muted">還沒有技能。完成可重複的任務後，我會自動整理成技能。</p>')+'</div><div id="skdetail" class="card" style="min-height:200px"><p class="muted">選擇一個技能</p></div></div></div>';
 v.querySelectorAll('[data-s]').forEach(b=>b.onclick=async()=>{const k=await api('skills/'+encodeURIComponent(b.dataset.s));$('#skdetail').innerHTML='<div class="row"><h3 class="grow" style="margin:0">'+esc(k.name)+'</h3><button class="ghost danger" id="skdel">刪除</button></div><p class="muted">'+esc(k.description)+'</p><div class="assistant"><div class="body">'+md(k.body)+'</div></div>';
  $('#skdel').onclick=async()=>{if(confirm('刪除技能？')){await api('skills/'+encodeURIComponent(k.slug),{method:'DELETE'});renderSkills();refreshSide()}}})}
async function renderJobs(){composer(false);$('#title').textContent='排程任務';$('#actions').innerHTML='';const v=$('#view');const d=await api('jobs');
 v.innerHTML='<div class="page">'+(d.scheduler?'':'<div class="card small" style="border-color:var(--warn)">排程器沒有在這個程序執行。請用 <code>kestrel daemon</code> 啟動才會自動執行。</div>')+'<div class="card"><div class="row"><input id="jn" style="max-width:200px" placeholder="名稱"><input id="js" style="max-width:220px" placeholder="daily 09:00 / every 30m / 0 9 * * 1-5"></div><textarea id="jp" rows="2" style="margin-top:8px" placeholder="要做什麼（會在新的對話中自動執行）"></textarea><div class="row" style="margin-top:8px"><button class="primary" id="jadd">建立排程</button><span class="muted small" id="jerr"></span></div></div><div class="tablewrap"><table><thead><tr><th>任務</th><th>時間</th><th>下次</th><th>上次結果</th><th></th></tr></thead><tbody>'+
 d.jobs.map(j=>'<tr><td><b>'+esc(j.name)+'</b><div class="muted small">'+esc(j.prompt.slice(0,140))+'</div></td><td class="small">'+esc(j.description)+'</td><td class="small">'+(j.nextRunAt&&j.enabled?new Date(j.nextRunAt).toLocaleString():'—')+'</td><td class="small">'+esc(j.lastStatus||'—')+'</td><td><div class="row"><button class="ghost" data-run="'+j.id+'">立即執行</button><button class="ghost" data-tog="'+j.id+'">'+(j.enabled?'暫停':'啟用')+'</button><button class="ghost danger" data-jdel="'+j.id+'">刪除</button></div></td></tr>').join('')+'</tbody></table></div></div>';
 $('#jadd').onclick=async()=>{try{await api('jobs',{body:{name:$('#jn').value,schedule:$('#js').value,prompt:$('#jp').value}});renderJobs();refreshSide()}catch(e){$('#jerr').textContent=e.message}};
 v.querySelectorAll('[data-run]').forEach(b=>b.onclick=async()=>{await api('jobs/'+b.dataset.run+'/run',{body:{}});b.textContent='已開始'});
 v.querySelectorAll('[data-tog]').forEach(b=>b.onclick=async()=>{await api('jobs/'+b.dataset.tog+'/toggle',{body:{}});renderJobs()});
 v.querySelectorAll('[data-jdel]').forEach(b=>b.onclick=async()=>{if(confirm('刪除排程？')){await api('jobs/'+b.dataset.jdel,{method:'DELETE'});renderJobs();refreshSide()}})}
async function renderInbox(){composer(false);$('#title').textContent='收件匣';$('#actions').innerHTML='<button class="ghost" id="readall">全部標為已讀</button>';const v=$('#view');const d=await api('inbox');
 v.innerHTML='<div class="page">'+(d.items.map(i=>'<div class="card"'+(i.read?'':' style="border-color:var(--accent)"')+'><div class="row"><b class="grow">'+esc(i.title)+'</b><span class="muted small">'+ago(i.created_at)+' · '+esc(i.source)+'</span></div><div class="assistant"><div class="body">'+md(i.body)+'</div></div></div>').join('')||'<p class="muted">收件匣是空的</p>')+'</div>';
 $('#readall').onclick=async()=>{await api('inbox/read',{body:{}});refreshSide();renderInbox()}}
async function render(){try{if(view==='chat')await renderChat();else if(view==='memory')await renderMemory();else if(view==='skills')await renderSkills();else if(view==='jobs')await renderJobs();else await renderInbox()}catch(e){if(e.message!=='unauthorized')$('#view').innerHTML='<div class="page"><p style="color:var(--bad)">'+esc(e.message)+'</p></div>'}
 document.querySelectorAll('.sess').forEach(b=>b.classList.toggle('on',b.dataset.id===sessionId))}
async function boot(){try{await refreshSide();$('#app').hidden=false;render()}catch(e){if(e.message!=='unauthorized'){document.body.textContent=e.message}}}
if(token)boot();else showLogin();setInterval(()=>{if(!$('#app').hidden&&!busy)refreshSide().catch(()=>{})},15000);
</script></body></html>`;
}
