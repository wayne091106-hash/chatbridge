/**
 * Interactive cards rendered inside ChatGPT (window.openai) or any MCP Apps host (postMessage
 * JSON-RPC). One small bridge script and one design system are shared by every card.
 */

import { createHash } from "node:crypto";

export const WIDGET_MIME = "text/html;profile=mcp-app";

/**
 * ChatGPT caches card HTML by URI (up to about an hour), so each URI carries a fingerprint of its HTML:
 * a changed card gets a new address and is loaded fresh.
 */
export function versionedUri(name: string, html: string): string {
  return `ui://chatbridge/${name}-${createHash("sha256").update(html).digest("hex").slice(0, 10)}.html`;
}

/** Cards load nothing from the network (images arrive as data: URLs) except the object store for fast uploads. */
export function cardResourceMeta(description: string, connectDomains: string[] = []) {
  return {
    ui: { csp: { connectDomains, resourceDomains: [] }, prefersBorder: true },
    "openai/widgetCSP": { connect_domains: connectDomains, resource_domains: [] },
    "openai/widgetPrefersBorder": true,
    "openai/widgetDescription": description,
  };
}

/** Tool result whose heavy card data stays out of the conversation (the card reads it from _meta). */
export function cardResult(light: Record<string, unknown>, heavy: Record<string, unknown>, content: any[]) {
  // awaitingCard lets the card wait until the host has delivered _meta as well.
  return { structuredContent: { ...light, awaitingCard: true }, content, _meta: { "chatbridge/card": { ...heavy, awaitingCard: false } } };
}

// ---------------------------------------------------------------------------------------------------------
// Design system: follows ChatGPT's own look (system font, neutral greys, soft radii) in light and dark.
const BASE_CSS = `
:root{color-scheme:light dark;--bg:#fff;--surface:#f7f7f8;--surface2:#efefef;--hover:rgba(0,0,0,.05);--line:rgba(0,0,0,.08);--line2:rgba(0,0,0,.15);--fg:#0d0d0d;--muted:#5d5d5d;--faint:#8f8f8f;--accent:#0285ff;--ok:#10a37f;--bad:#e02e2a;--warn:#b86e00;--add:rgba(16,163,127,.12);--del:rgba(224,46,42,.1);--addfg:#0a7a5c;--delfg:#c4302b;--inv:#0d0d0d;--invfg:#fff;--mono:ui-monospace,"SF Mono","Cascadia Code",Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not(.light){--bg:#212121;--surface:#2a2a2a;--surface2:#303030;--hover:rgba(255,255,255,.06);--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.16);--fg:#ececec;--muted:#b4b4b4;--faint:#8e8e8e;--accent:#48aaff;--ok:#3fbf8f;--bad:#ff6b66;--warn:#e6a23c;--add:rgba(63,191,143,.14);--del:rgba(255,107,102,.13);--addfg:#6fdcaf;--delfg:#ff8f8a;--inv:#ececec;--invfg:#0d0d0d}}
:root.dark{--bg:#212121;--surface:#2a2a2a;--surface2:#303030;--hover:rgba(255,255,255,.06);--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.16);--fg:#ececec;--muted:#b4b4b4;--faint:#8e8e8e;--accent:#48aaff;--ok:#3fbf8f;--bad:#ff6b66;--warn:#e6a23c;--add:rgba(63,191,143,.14);--del:rgba(255,107,102,.13);--addfg:#6fdcaf;--delfg:#ff8f8a;--inv:#ececec;--invfg:#0d0d0d}
*{box-sizing:border-box}html,body{margin:0;background:transparent}
body{font:14px/1.55 ui-sans-serif,-apple-system,system-ui,"Segoe UI","Noto Sans TC","PingFang TC",sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased}
button,select,input,textarea{font:inherit;color:inherit}
.btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--line2);background:transparent;cursor:pointer;font-size:13px;white-space:nowrap}
.btn:hover{background:var(--hover)}.btn.primary{background:var(--inv);color:var(--invfg);border-color:transparent}.btn.danger{color:var(--bad)}.btn.sm{height:28px;padding:0 10px;font-size:12.5px}
.btn:disabled{opacity:.45;cursor:default}
.ib{width:32px;height:32px;border-radius:999px;border:0;background:transparent;display:inline-grid;place-items:center;cursor:pointer;color:var(--muted)}.ib:hover{background:var(--hover);color:var(--fg)}
.ib svg,.btn svg{width:16px;height:16px}
.muted{color:var(--muted)}.faint{color:var(--faint)}.small{font-size:12.5px}.mono{font-family:var(--mono);font-size:12.5px}
.chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;background:var(--surface2);font-size:12px;color:var(--muted);white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:var(--faint)}.dot.running{background:var(--warn);animation:pulse 1.2s infinite}.dot.done{background:var(--ok)}.dot.failed,.dot.cancelled{background:var(--bad)}.dot.paused{background:var(--accent)}
@keyframes pulse{50%{opacity:.35}}
.av{width:26px;height:26px;border-radius:8px;display:inline-grid;place-items:center;color:#fff;font-weight:600;font-size:13px;flex:none}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.5 var(--mono)}
.dl{white-space:pre;padding:0 12px 0 0;display:flex}.dl .n{flex:none;width:3.4em;text-align:right;padding-right:10px;color:var(--faint);user-select:none}
.dl.a{background:var(--add);color:var(--addfg)}.dl.d{background:var(--del);color:var(--delfg)}.dl.h{color:var(--faint);background:var(--surface)}
.add{color:var(--ok)}.del{color:var(--bad)}
`;

const ICONS = `
const IC={
 expand:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
 shrink:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
 pip:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1"/></svg>',
 send:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
 pause:'<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
 play:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg>',
 stop:'<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
 chev:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
 undo:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/></svg>',
 diff:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M12 8v6M9 11h6M9 17h6"/></svg>',
 branch:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8"/></svg>',
 laptop:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/></svg>',
 commit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M2 12h6.5M15.5 12H22"/></svg>',
 gear:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
 clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
 plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
 side:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
 x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
 bolt:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
 term:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>',
 files:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h5l2 2h9v12H4z"/></svg>',
 check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>'
};
`;

const BRIDGE_JS = `
const bridge=(()=>{const o=window.openai;const pending=new Map();let seq=0,toolResult=null;const listeners=[];
 function post(method,params){const id=++seq;return new Promise(res=>{pending.set(id,res);window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*')})}
 if(!o){window.addEventListener('message',ev=>{const m=ev.data;if(!m||m.jsonrpc!=='2.0')return;
   if(m.id!==undefined&&pending.has(m.id)){pending.get(m.id)(m.result!==undefined?m.result:{error:m.error});pending.delete(m.id)}
   else if(m.method==='ui/notifications/tool-result'){toolResult=m.params;listeners.forEach(f=>f())}});
  post('ui/initialize',{appInfo:{name:'chatbridge',version:'1'},appCapabilities:{},protocolVersion:'2025-06-18'}).then(()=>window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*'))}
 const th=o&&o.theme;if(th==='dark')document.documentElement.classList.add('dark');else if(th==='light')document.documentElement.classList.add('light');
 // Heavy card data (images, file bytes, terminal text) travels in _meta["chatbridge/card"], which the host gives
 // to the card but does not add to the conversation. structuredContent only carries the light fields.
 const card=m=>(m&&m['chatbridge/card'])||null;
 const merge=(sc,m)=>{const c=card(m);return c?Object.assign({},sc||{},c):sc};
 const unwrap=r=>{if(!r)return r;const x=r.result&&typeof r.result==='object'?r.result:r;if(x.isError){const t=(x.content||[]).map(c=>c.text||'').join(' ');throw new Error(t||'tool error')}return merge(x.structuredContent,x._meta||x.meta)||x};
 return{
  data(){if(o){const t=o.toolOutput;return merge(t&&(t.structuredContent||t),o.toolResponseMetadata)}return toolResult&&merge(toolResult.structuredContent,toolResult._meta)},
  onData(f){listeners.push(f);if(o)window.addEventListener('openai:set_globals',f)},
  async call(name,args){if(o)return unwrap(await o.callTool(name,args));return unwrap(await post('tools/call',{name,arguments:args}))},
  // Tools that answer in plain text (shell_run, agent_result …) rather than card data.
  async callText(name,args){const r=o?await o.callTool(name,args):await post('tools/call',{name,arguments:args});const x=r&&r.result&&typeof r.result==='object'?r.result:r;
   const t=((x&&x.content)||[]).map(c=>c&&c.text||'').join(String.fromCharCode(10)).trim();return t||(typeof x==='string'?x:'')},
  followUp(text){if(o&&o.sendFollowUpMessage)return o.sendFollowUpMessage({prompt:text});return post('ui/message',{role:'user',content:[{type:'text',text}]})},
  display(mode){if(o&&o.requestDisplayMode)return o.requestDisplayMode({mode});return post('ui/request-display-mode',{mode})},
  state(){return (o&&o.widgetState)||null},
  saveState(s){try{if(o&&o.setWidgetState)o.setWidgetState(s)}catch(e){}},
  displayMode(){return (o&&o.displayMode)||''}
 }})();
function waitData(cb){const ok=x=>x&&Object.keys(x).length&&!x.awaitingCard;let d=bridge.data();if(ok(d))return cb(d);let n=0;bridge.onData(()=>{const x=bridge.data();if(ok(x)&&n>=0){n=-1;cb(x)}});const t=setInterval(()=>{const x=bridge.data();if(ok(x)&&n>=0){n=-1;clearInterval(t);cb(x)}else if(++n>150)clearInterval(t)},200)}
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const NL=String.fromCharCode(10);
function diffHtml(d){if(!d)return '<div class="muted small" style="padding:10px">（沒有差異內容）</div>';let a=0,b=0;
 return d.split(NL).map(l=>{const m=l.match(/^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)/);if(m){a=+m[1];b=+m[2];return '<div class="dl h"><span class="n"></span>'+esc(l)+'</div>'}
  if(/^(diff |index |--- |\\+\\+\\+ |new file|deleted file|similarity|rename |old mode|new mode|warning:)/.test(l))return '';
  let c='',n='';if(l[0]==='+'){c='a';n=b++}else if(l[0]==='-'){c='d';n=a++}else{n=b;a++;b++}
  return '<div class="dl '+c+'"><span class="n">'+(n||'')+'</span>'+esc(l)+'</div>'}).join('')}
`;

// ---------------------------------------------------------------------------------------------------------
// Coding card: "chat coding" inline card (agent_run) and the fullscreen "serious coding" workbench.
export const AGENT_PANEL_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}
#app{padding:4px 2px}
.hd{display:flex;align-items:center;gap:10px;padding:6px 4px 10px}
.hd .who{min-width:0;flex:1}.hd .ttl{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hd .sub{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conv{display:flex;flex-direction:column;gap:12px;padding:4px 4px 8px}
.inline .conv{max-height:380px;overflow:auto}
.u{align-self:flex-end;max-width:85%;background:var(--surface2);padding:9px 14px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.m{overflow-wrap:anywhere}.m .gap{height:8px}.m .mh{font-weight:600;margin:6px 0 2px}.m .li{padding-left:16px;position:relative}.m .li:not(.n)::before{content:"•";position:absolute;left:4px;color:var(--faint)}
.m code{font:12.5px var(--mono);background:var(--surface2);padding:1px 5px;border-radius:5px}
.m pre.cb{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:6px 0;white-space:pre;overflow:auto;font:12.5px/1.5 var(--mono)}
.e{color:var(--bad);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
.act{font-size:13px;color:var(--muted)}
.act>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:2px 0}.act>summary::-webkit-details-marker{display:none}
.act>summary svg{width:14px;height:14px;transition:transform .15s}.act[open]>summary svg{transform:rotate(90deg)}
.act ul{margin:6px 0 2px;padding:0 0 0 12px;border-left:2px solid var(--line);list-style:none;display:flex;flex-direction:column;gap:4px}
.act li{font:12.5px/1.45 var(--mono);color:var(--muted);overflow-wrap:anywhere;white-space:pre-wrap}
.act li.thinking{font-family:inherit;font-style:italic;color:var(--faint)}
.live{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.chg{border:1px solid var(--line);border-radius:16px;overflow:hidden;margin:4px}
.chg .top{display:flex;align-items:center;gap:10px;padding:10px 12px}
.chg .top .ic{width:34px;height:34px;border-radius:10px;background:var(--surface2);display:grid;place-items:center;flex:none}.chg .top .ic svg{width:17px;height:17px}
.chg .top .t{flex:1;min-width:0}.chg .top b{font-weight:600}
.row{display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid var(--line);cursor:pointer;font-size:13px}.row:hover{background:var(--hover)}
.row .p{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:12.5px}
.row .s{font-family:var(--mono);font-size:12px;white-space:nowrap}
.dv{border-top:1px solid var(--line);max-height:360px;overflow:auto;font:12px/1.5 var(--mono)}
.comp{margin:8px 4px 4px;border:1px solid var(--line2);border-radius:24px;background:var(--bg);padding:8px 8px 8px 16px;display:flex;flex-direction:column;gap:6px}
.comp textarea{border:0;outline:0;background:transparent;resize:none;min-height:24px;max-height:160px;padding:6px 0;line-height:1.5}
.comp .bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.comp .sp{flex:1}
.sendb{width:34px;height:34px;border-radius:50%;border:0;background:var(--inv);color:var(--invfg);display:grid;place-items:center;cursor:pointer}.sendb:disabled{opacity:.3;cursor:default}.sendb svg{width:17px;height:17px}
.sel{height:30px;border-radius:999px;border:1px solid var(--line);background:transparent;padding:0 10px;font-size:12.5px;color:var(--muted);max-width:220px}
.tog{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 10px;border-radius:999px;border:1px solid var(--line);font-size:12.5px;color:var(--muted);cursor:pointer;background:transparent}.tog.on{color:var(--accent);border-color:var(--accent)}.tog svg{width:13px;height:13px}
.foot{display:flex;gap:6px;flex-wrap:wrap;padding:8px 4px 2px}
.qs{display:flex;flex-direction:column;gap:6px;margin-top:4px}.q{display:flex;gap:8px;align-items:flex-start;background:var(--surface);border-radius:12px;padding:10px 12px;font-size:13.5px}.q svg{width:14px;height:14px;margin-top:3px;color:var(--faint);flex:none}
.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:var(--inv);color:var(--invfg);padding:8px 16px;border-radius:999px;font-size:13px;z-index:9;box-shadow:0 6px 24px rgba(0,0,0,.2)}
.empty{padding:40px 16px;text-align:center;color:var(--muted)}.empty h2{font-size:22px;font-weight:600;color:var(--fg);margin:0 0 6px}
/* workbench */
.wb{display:grid;grid-template-columns:minmax(0,1fr) 340px;height:560px;background:var(--bg);border-radius:14px;overflow:hidden}
.wb.full{height:100vh;border-radius:0}
.wb.diffon{grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)}
.wb.noside{grid-template-columns:minmax(0,1fr)}
.wmain{display:flex;flex-direction:column;min-width:0;min-height:0}
.wtop{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line)}
.wtop .ttl{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wscroll{flex:1;overflow:auto;min-height:0}
.wscroll .conv{max-width:780px;margin:0 auto;padding:22px 20px 12px;gap:14px}
.wscroll .chg{max-width:740px;margin:4px auto 16px}
.wcomp{max-width:780px;width:100%;margin:0 auto;padding:0 16px 14px}
.wside{border-left:1px solid var(--line);overflow:auto;min-height:0;background:var(--bg)}
.box{margin:12px;border:1px solid var(--line);border-radius:16px;padding:6px}
.box h5{margin:6px 8px 4px;font-size:12px;font-weight:600;color:var(--muted)}
.it{display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;font-size:13px;cursor:pointer}.it:hover{background:var(--hover)}
.it svg{width:16px;height:16px;color:var(--muted);flex:none}.it .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.field{display:flex;flex-direction:column;gap:4px;padding:6px 8px}.field label{font-size:12px;color:var(--muted)}
.field select,.field input{height:32px;border-radius:10px;border:1px solid var(--line2);background:transparent;padding:0 10px;font-size:13px}
.seg{display:flex;border:1px solid var(--line2);border-radius:10px;overflow:hidden}.seg button{flex:1;height:30px;border:0;background:transparent;font-size:12.5px;cursor:pointer;color:var(--muted)}.seg button.on{background:var(--surface2);color:var(--fg);font-weight:600}
.term{border:1px solid var(--line);border-radius:14px;margin:0 0 10px;overflow:hidden;background:var(--bg)}
.term .th{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--line);font-size:12.5px}
.term .tb{max-height:200px;overflow:auto;padding:10px 12px;background:var(--surface);font:12px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.term .ti{display:flex;gap:6px;padding:8px}
.term .ti input{flex:1;height:32px;border-radius:10px;border:1px solid var(--line2);background:transparent;padding:0 10px;font:12.5px var(--mono)}
.tree{padding:4px 8px 8px;font:12px/1.5 var(--mono);white-space:pre;overflow:auto;max-height:320px}
.dpane{display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--line)}
.dpane .dh{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.dpane .dh .p{flex:1;min-width:0;font-family:var(--mono);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpane .db{flex:1;overflow:auto;font:12px/1.55 var(--mono)}
@media (max-width:820px){.wb,.wb.diffon{grid-template-columns:minmax(0,1fr)}.wside,.dpane{position:fixed;inset:0 0 0 12%;z-index:5;box-shadow:-10px 0 30px rgba(0,0,0,.25)}}
</style></head><body><div id="app"></div><script>${ICONS}${BRIDGE_JS}
const AG={kilo:['K','#e8792b'],cline:['C','#3b6fe0'],codex:['X','#111'],claude:['A','#d27656'],gemini:['G','#4285f4'],opencode:['O','#777']};
const ST={running:'執行中',done:'完成',failed:'失敗',cancelled:'已停止',paused:'已暫停'};
const ACC={read:'唯讀',workspace:'可編輯專案',full:'完整存取'};
const S={term:{open:false,sid:'',text:'',running:false,cmd:''},tree:{open:false,items:null},mode:'inline',sum:null,job:null,events:[],cwd:'',project:null,agents:[],preferred:'',threads:[],sel:{agent:'',model:'',access:'workspace'},interrupt:false,autoReview:false,openDiff:null,diffText:null,diffSrc:'',side:true,confirmRevert:false,commitMsg:'',newBranch:'',pt:0,spt:0,lastStatus:''};
const $=id=>document.getElementById(id);
function toast(t){let el=$('toast');if(!el){el=document.createElement('div');el.id='toast';el.className='toast';document.body.appendChild(el)}el.textContent=t;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>el.hidden=true,2600)}
function rel(t){const cwd=(S.job&&S.job.cwd)||S.cwd;if(!cwd)return String(t);const n=x=>String(x).split(String.fromCharCode(92)).join('/');const base=n(cwd).replace(/[/]$/,'')+'/';let o=n(t);let i;while((i=o.toLowerCase().indexOf(base.toLowerCase()))>=0)o=o.slice(0,i)+o.slice(i+base.length);return o}
// Minimal Markdown for agent replies: code fences, inline code, bold, headings, bullets.
const BT=String.fromCharCode(96);const INLINE_CODE=new RegExp(BT+'([^'+BT+']+)'+BT,'g');
function mdInline(p){return p.split(NL).map(line=>{let l=esc(line).replace(INLINE_CODE,'<code>$1</code>').replace(/[*][*]([^*]+)[*][*]/g,'<b>$1</b>');
 if(/^#{1,4} /.test(line))return '<div class="mh">'+l.replace(/^#+ /,'')+'</div>';if(/^ *[-*] /.test(line))return '<div class="li">'+l.replace(/^ *[-*] /,'')+'</div>';if(/^ *[0-9]+[.] /.test(line))return '<div class="li n">'+l+'</div>';return l?'<div>'+l+'</div>':'<div class="gap"></div>'}).join('')}
function md(t){const parts=rel(t).split(BT+BT+BT);return parts.map((p,i)=>{if(i%2===0)return mdInline(p);const nl=p.indexOf(NL);const code=nl>=0&&/^[A-Za-z0-9_+.-]*$/.test(p.slice(0,nl))?p.slice(nl+1):p;return '<pre class="cb">'+esc(code.replace(/[ ]*$/,'').split(NL).filter((l,k,a)=>!(k===a.length-1&&!l)).join(NL))+'</pre>'}).join('')}
function folderName(p){return String(p||'').split(String.fromCharCode(92)).join('/').replace(/[/]+$/,'').split('/').pop()}
function av(id){const a=AG[id]||['?','#777'];return '<span class="av" style="background:'+a[1]+'">'+a[0]+'</span>'}
function fmtS(s){s=Math.max(0,Math.round(s));return s>=3600?Math.floor(s/3600)+'時'+Math.floor(s%3600/60)+'分':s>=60?Math.floor(s/60)+'分'+String(s%60).padStart(2,'0')+'秒':s+'秒'}
function agentRow(id){return S.agents.find(a=>a.id===id)||null}
function loadPrefs(){const st=bridge.state();if(st&&st.sel)Object.assign(S.sel,st.sel);if(st&&st.autoReview!==undefined)S.autoReview=st.autoReview}
function savePrefs(){bridge.saveState({sel:S.sel,autoReview:S.autoReview,job:S.job&&S.job.id,mode:S.mode})}
// ---- conversation model
function blocks(){const out=[];let act=null;if(S.job)out.push({t:'u',text:S.job.task});
 for(const e of S.events){
  if(e.kind==='user'){act=null;out.push({t:'u',text:e.text});continue}
  if(e.kind==='message'||e.kind==='done'){act=null;const last=out[out.length-1];if(!(last&&last.t==='m'&&last.text===e.text))out.push({t:'m',text:e.text});continue}
  if(e.kind==='error'){act=null;out.push({t:'e',text:e.text});continue}
  if(!act){act={t:'a',items:[]};out.push(act)}act.items.push(e)}
 return out}
function actTitle(items){const c={command:0,file:0,tool:0,thinking:0,info:0};items.forEach(i=>c[i.kind]=(c[i.kind]||0)+1);const p=[];
 if(c.command)p.push('已執行 '+c.command+' 個指令');if(c.file)p.push('已編輯 '+c.file+' 處');if(c.tool)p.push('用了 '+c.tool+' 個工具');if(c.thinking&&!p.length)p.push('思考中');if(c.info&&!p.length)p.push('狀態更新');return p.join(' · ')||'活動'}
function convHtml(){const bs=blocks();if(!bs.length)return '';let h='';bs.forEach((b,i)=>{
  if(b.t==='u')h+='<div class="u">'+esc(b.text)+'</div>';
  else if(b.t==='m')h+='<div class="m">'+md(b.text)+'</div>';
  else if(b.t==='e')h+='<div class="e">'+esc(rel(b.text))+'</div>';
  else{const open=S.openAct&&S.openAct[i];h+='<details class="act" data-i="'+i+'"'+(open?' open':'')+'><summary>'+IC.chev+esc(actTitle(b.items))+'</summary><ul>'+b.items.map(x=>'<li class="'+x.kind+'">'+esc(rel(x.text))+'</li>').join('')+'</ul></details>'}});
 if(S.job&&S.job.status==='running')h+='<div class="live"><span class="dot running"></span>'+esc((agentRow(S.job.agent)||{label:S.job.agentLabel}).label||S.job.agentLabel)+' 工作中…'+((S.job.queued||[]).length?'（'+S.job.queued.length+' 則指示排隊中）':'')+'</div>';
 // A failed run whose reason never appeared as an event still shows why it failed.
 if(S.job&&S.job.status==='failed'&&S.job.final&&!bs.some(b=>(b.t==='e'||b.t==='m')&&b.text===S.job.final))h+='<div class="e">'+esc(rel(S.job.final))+'</div>';
 if(S.job&&S.job.note)h+='<div class="small faint">'+esc(S.job.note)+'</div>';
 return h}
function totals(ch){return ch.reduce((t,c)=>({a:t.a+(c.added||0),r:t.r+(c.removed||0)}),{a:0,r:0})}
function changesHtml(){if(!S.job||S.job.status==='running')return '';const ch=S.job.changed||[];if(!ch.length)return '<div class="small faint" style="padding:0 4px">沒有偵測到檔案變更</div>';const t=totals(ch);
 let h='<div class="chg"><div class="top"><span class="ic">'+IC.diff+'</span><div class="t"><b>已編輯 '+ch.length+' 個檔案</b><div class="small"><span class="add">+'+t.a+'</span> <span class="del">-'+t.r+'</span></div></div>'+
  '<button class="btn sm'+(S.confirmRevert?' danger':'')+'" data-act="revert">'+IC.undo+(S.confirmRevert?'確定復原？':'復原')+'</button></div>';
 ch.forEach((c,i)=>{h+='<div class="row" data-act="jdiff" data-i="'+i+'"><span class="p" title="'+esc(c.path)+'">'+esc(rel(c.path))+'</span><span class="s"><span class="add">+'+(c.added||0)+'</span> <span class="del">-'+(c.removed||0)+'</span></span></div>';
  if(S.mode==='inline'&&S.openDiff===c.path&&S.diffSrc==='job')h+='<div class="dv">'+(S.diffText==null?'<div class="muted small" style="padding:10px">載入中…</div>':diffHtml(S.diffText))+'</div>'});
 return h+'</div>'}
function composerHtml(){const busy=S.job&&S.job.status==='running';const ph=!S.job?'想做什麼都可以，描述要 agent 完成的工作…':busy?'追加指示（會在目前步驟結束後送出）…':'繼續對話，或給新的指示…';
 const agentSel=!S.job?'<select class="sel" id="selAgent">'+S.agents.filter(a=>a.offered&&a.installed).map(a=>'<option value="'+a.id+'"'+(a.id===(S.sel.agent||S.preferred)?' selected':'')+'>'+esc(a.label)+(a.ok===false?'（異常）':'')+'</option>').join('')+'</select>':'';
 const cur=agentRow(S.job?S.job.agent:(S.sel.agent||S.preferred));const models=cur?cur.models:[];const curModel=S.job?(S.job.model||''):(S.sel.model||(cur&&cur.model)||'');
 const modelSel=!S.job&&models.length?'<select class="sel" id="selModel">'+models.map(m=>'<option'+(m===curModel?' selected':'')+'>'+esc(m)+'</option>').join('')+'</select>':'';
 const accSel=!S.job?'<select class="sel" id="selAcc">'+Object.keys(ACC).map(k=>'<option value="'+k+'"'+(k===S.sel.access?' selected':'')+'>'+ACC[k]+'</option>').join('')+'</select>':'<span class="chip">'+esc(ACC[S.job.access]||S.job.access)+'</span>';
 const toGpt=LOCAL?'<button class="tog'+(S.toGpt?' on':'')+'" data-act="togpt" title="送給 ChatGPT 對話，而不是本機 agent">'+IC.send+(S.toGpt?'送給 GPT':'交給本機 agent')+'</button>':'';
 const intr=busy?'<button class="tog'+(S.interrupt?' on':'')+'" data-act="intr" title="打開後，送出的指示會立刻打斷目前步驟">'+IC.bolt+'立即打斷</button>':'';
 return '<div class="comp"><textarea id="msg" rows="1" placeholder="'+(S.toGpt?'想跟 ChatGPT 說什麼…（會送進你開著的對話）':ph)+'"></textarea><div class="bar">'+toGpt+(S.toGpt?'':agentSel+modelSel+accSel+intr)+'<span class="sp"></span><button class="sendb" id="sendb" data-act="send" title="送出">'+IC.send+'</button></div></div>'}
function controlsHtml(){if(!S.job)return '';const s=S.job.status;let h='';
 if(s==='running')h+='<button class="btn sm" data-act="pause">'+IC.pause+'暫停</button><button class="btn sm danger" data-act="stop">'+IC.stop+'停止</button>';
 if(s==='paused')h+='<button class="btn sm" data-act="resume">'+IC.play+'繼續</button>';
 if(s!=='running')h+='<button class="btn sm" data-act="review">請 GPT 檢查</button>';
 return h}
// ---- inline (chat coding)
// ---- result card: the model writes the words, the PC supplies the measured facts
function summaryChangesHtml(){const ch=S.sum.changed||[];if(!ch.length)return '';const t=totals(ch);
 let h='<div class="chg"><div class="top"><span class="ic">'+IC.diff+'</span><div class="t"><b>'+ch.length+' 個檔案有變更</b><div class="small"><span class="add">+'+t.a+'</span> <span class="del">-'+t.r+'</span> · 點檔名看差異</div></div>'+
  (S.sum.job?'<button class="btn sm'+(S.confirmRevert?' danger':'')+'" data-act="srevert">'+IC.undo+(S.confirmRevert?'確定？':'復原')+'</button>':'')+'</div>';
 ch.forEach((c,i)=>{h+='<div class="row" data-act="sdiff" data-i="'+i+'"><span class="p" title="'+esc(c.path)+'">'+esc(rel(c.path))+'</span><span class="s"><span class="add">+'+c.added+'</span> <span class="del">-'+c.removed+'</span></span></div>'+
  (S.openDiff===c.path?'<div class="dv">'+(S.diffText==null?'<div class="muted small" style="padding:10px">載入中…</div>':diffHtml(S.diffText))+'</div>':'')});
 return h+'</div>'}
function renderSummary(){const s=S.sum;$('app').className='inline';
 const chips=(s.nextSteps||[]).map((t,i)=>'<button class="btn sm" data-act="step" data-i="'+i+'">'+esc(t)+'</button>').join('');
 $('app').innerHTML='<div class="hd">'+(s.job?av(s.job.agentLabel):'<span class="av" style="background:var(--inv);color:var(--invfg)">'+IC.check+'</span>')+
  '<div class="who"><div class="ttl">'+esc(s.title)+'</div><div class="sub" title="'+esc(s.cwd||'')+'">'+esc(folderName(s.cwd)||'')+'</div></div>'+
  '<span class="chip"><span class="dot '+esc(s.status)+'"></span>'+(ST[s.status]||(s.status==='question'?'待回覆':s.status))+'</span></div>'+
  '<div class="conv"><div class="m">'+md(s.notes)+'</div>'+
  ((s.questions||[]).length?'<div class="qs">'+s.questions.map(q=>'<div class="q">'+IC.chev+'<span>'+esc(q)+'</span></div>').join('')+'</div>':'')+'</div>'+
  summaryChangesHtml()+
  '<div class="foot">'+chips+(s.cwd?'<button class="btn sm" data-act="swb">'+IC.expand+'工作台</button><button class="btn sm" data-act="sdrive">送到 Drive</button>':'')+'</div>';
 afterRender()}
function renderInline(){const j=S.job;const ag=j?j.agent:(S.sel.agent||S.preferred);const cur=agentRow(ag);
 $('app').className='inline';
 $('app').innerHTML='<div class="hd">'+av(ag)+'<div class="who"><div class="ttl">'+esc(j?(j.agentLabel||(cur&&cur.label)):'寫程式')+'</div><div class="sub" title="'+esc(j?j.cwd:S.cwd)+'">'+esc([(j?j.model:''),folderName(j?j.cwd:S.cwd)].filter(Boolean).join(' · '))+'</div></div>'+
  (j?'<span class="chip"><span class="dot '+j.status+'"></span>'+(ST[j.status]||j.status)+' · <span id="clock"></span></span>':'')+
  '<button class="ib" data-act="wb" title="工作台（全螢幕）">'+IC.expand+'</button><button class="ib" data-act="pip" title="子母畫面">'+IC.pip+'</button></div>'+
  '<div class="conv" id="conv">'+convHtml()+'</div>'+changesHtml()+composerHtml()+'<div class="foot">'+controlsHtml()+'</div>';
 afterRender()}
// ---- workbench (serious coding)
function sideHtml(){const p=S.project||{changes:[]};const t=totals(p.changes||[]);let h='';
 h+='<div class="box"><h5>環境</h5>'+
  '<div class="it" data-act="pchanges">'+IC.diff+'<span class="grow">變更'+((p.changes||[]).length?' · '+p.changes.length+' 個檔案':'')+'</span><span class="small"><span class="add">+'+t.a+'</span> <span class="del">-'+t.r+'</span></span></div>'+
  (S.showP?(p.changes||[]).map(c=>'<div class="it" data-act="pdiff" data-p="'+esc(c.path)+'" style="padding-left:34px"><span class="grow mono">'+esc(c.path)+'</span><span class="small mono">'+esc(c.status)+'</span></div>').join(''):'')+
  '<div class="it" title="'+esc(S.cwd)+'">'+IC.laptop+'<span class="grow">本機 · '+esc(p.name||S.cwd)+'</span></div>'+
  (p.git?'<div class="it">'+IC.branch+'<select class="sel" id="selBranch" style="flex:1;max-width:none">'+(p.branches||[]).map(b=>'<option'+(b===p.branch?' selected':'')+'>'+esc(b)+'</option>').join('')+'</select></div>'+
   '<div class="field"><input id="newBranch" placeholder="新分支名稱…" value="'+esc(S.newBranch)+'"></div>'+
   '<div class="field"><label>'+IC.commit.replace('<svg','<svg style="width:13px;height:13px;vertical-align:-2px"')+' 送交或推送'+(p.ahead?' · 領先 '+p.ahead:'')+(p.behind?' · 落後 '+p.behind:'')+'</label><input id="commitMsg" placeholder="送交訊息…" value="'+esc(S.commitMsg)+'">'+
   '<div style="display:flex;gap:6px;margin-top:4px"><button class="btn sm" data-act="commit">送交</button><button class="btn sm" data-act="push"'+(p.remote?'':' disabled')+'>推送</button><button class="btn sm" data-act="branch">建立分支</button></div>'+
   (p.lastCommit?'<div class="small faint mono" style="margin-top:4px">'+esc(p.lastCommit)+'</div>':'')+'</div>':'<div class="small faint" style="padding:4px 8px 8px">這個資料夾不是 git 專案</div>')+'</div>';
 const cur=agentRow(S.sel.agent||S.preferred);
 h+='<div class="box"><h5>設定</h5><div class="field"><label>Agent（新對話）</label><select id="selAgent2">'+S.agents.filter(a=>a.installed).map(a=>'<option value="'+a.id+'"'+(a.id===(S.sel.agent||S.preferred)?' selected':'')+'>'+esc(a.label)+(a.offered?'':'（未推薦）')+(a.ok===false?'（異常）':'')+'</option>').join('')+'</select></div>'+
  '<div class="field"><label>模型</label><select id="selModel2">'+(cur?cur.models:[]).map(m=>'<option'+(m===(S.sel.model||(cur&&cur.model))?' selected':'')+'>'+esc(m)+'</option>').join('')+'<option value="__custom">自訂…</option></select>'+
  (S.customModel?'<input id="customModel" placeholder="例如 google-vertex/gemini-3.1-pro-preview">':'')+'<button class="btn sm" data-act="defmodel" style="align-self:flex-start;margin-top:2px">設為預設模型</button></div>'+
  '<div class="field"><label>權限</label><div class="seg">'+Object.keys(ACC).map(k=>'<button data-act="acc" data-v="'+k+'" class="'+(k===S.sel.access?'on':'')+'">'+ACC[k]+'</button>').join('')+'</div></div>'+
  '<div class="it" data-act="auto">'+IC.check+'<span class="grow">完成後自動請 GPT 審查</span><span class="chip">'+(S.autoReview?'開':'關')+'</span></div></div>';
 h+=(S.tree.open?'<div class="box"><h5>檔案</h5>'+treeHtml()+'</div>':'');
 h+='<div class="box"><h5>對話紀錄</h5>'+(S.threads.length?S.threads.map(t=>'<div class="it" data-act="thread" data-id="'+esc(t.id)+'">'+IC.clock+'<span class="grow">'+esc(t.task)+'</span><span class="dot '+esc(t.status)+'"></span></div>').join(''):'<div class="small faint" style="padding:4px 8px 8px">還沒有對話</div>')+'</div>';
 return h}
function termHtml(){if(!S.term.open)return '';
 return '<div class="term"><div class="th"><span class="grow mono">'+esc(S.term.cmd||'終端機')+'</span>'+
  (S.term.running?'<button class="btn sm danger" data-act="termkill">停止</button>':'')+'<button class="ib" data-act="term">'+IC.x+'</button></div>'+
  '<pre class="tb" id="termout">'+esc(S.term.text||'（還沒有輸出）')+'</pre>'+
  '<div class="ti"><input id="termcmd" placeholder="在 '+esc(folderName(S.cwd))+' 執行指令…"><button class="btn sm" data-act="termrun">執行</button></div></div>'}
function treeHtml(){return S.tree.items==null?'<div class="small faint" style="padding:4px 8px 8px">載入中…</div>':'<pre class="tree">'+esc(S.tree.items)+'</pre>'}
function diffPaneHtml(){return '<div class="dpane"><div class="dh"><span class="p">'+esc(rel(S.openDiff))+'</span><button class="ib" data-act="closediff" title="關閉">'+IC.x+'</button></div><div class="db">'+(S.diffText==null?'<div class="muted small" style="padding:12px">載入中…</div>':diffHtml(S.diffText))+'</div></div>'}
function renderWorkbench(){const j=S.job;const diffOn=!!S.openDiff;const full=S.full=bridge.displayMode()==='fullscreen';
 $('app').className='';
 const empty=!j?'<div class="empty"><h2>要做什麼？</h2><div>在 '+esc((S.project&&S.project.name)||S.cwd)+' 用 '+esc((agentRow(S.sel.agent||S.preferred)||{label:'agent'}).label)+' 開始一個新工作</div></div>':'';
 $('app').innerHTML='<div class="wb'+(full?' full':'')+(diffOn?' diffon':'')+(!S.side&&!diffOn?' noside':'')+'"><div class="wmain"><div class="wtop">'+av(j?j.agent:(S.sel.agent||S.preferred))+'<span class="ttl">'+esc(j?j.task:'新的對話')+'</span>'+
  (j?'<span class="chip"><span class="dot '+j.status+'"></span>'+(ST[j.status]||j.status)+' · <span id="clock"></span></span>':'')+
  '<button class="ib" data-act="tree" title="檔案">'+IC.files+'</button><button class="ib" data-act="term" title="終端機">'+IC.term+'</button><button class="ib" data-act="new" title="新對話">'+IC.plus+'</button><button class="ib" data-act="side" title="側邊欄">'+IC.side+'</button><button class="ib" data-act="inline" title="回到對話中">'+IC.shrink+'</button></div>'+
  '<div class="wscroll" id="scroll"><div class="conv" id="conv">'+convHtml()+'</div>'+empty+changesHtml()+'</div>'+
  '<div class="wcomp">'+termHtml()+composerHtml()+'<div class="foot">'+controlsHtml()+'</div></div></div>'+
  (diffOn?diffPaneHtml():S.side?'<div class="wside">'+sideHtml()+'</div>':'')+'</div>';
 afterRender()}
let draft='';
function render(){const ta=$('msg');if(ta)draft=ta.value;const sc=$('scroll')||$('conv');const atBottom=!sc||sc.scrollHeight-sc.scrollTop-sc.clientHeight<60;
 if(S.mode==='summary')renderSummary();else if(S.mode==='workbench')renderWorkbench();else renderInline();
 const ta2=$('msg');if(ta2){ta2.value=draft;autosize(ta2)}const sc2=$('scroll')||$('conv');if(sc2&&atBottom)sc2.scrollTop=sc2.scrollHeight;tick()}
function autosize(t){t.style.height='';if(t.value)t.style.height=Math.min(160,t.scrollHeight)+'px'}
function afterRender(){const ta=$('msg');if(ta){ta.oninput=()=>autosize(ta);ta.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();act('send')}}}
 ['selAgent','selAgent2'].forEach(id=>{const sa=$(id);if(sa)sa.onchange=()=>{S.sel.agent=sa.value;S.sel.model='';savePrefs();render()}});
 ['selModel','selModel2'].forEach(id=>{const sm=$(id);if(sm)sm.onchange=()=>{if(sm.value==='__custom'){S.customModel=true;render();return}S.sel.model=sm.value;savePrefs()}});
 const cm=$('customModel');if(cm)cm.onchange=()=>{S.sel.model=cm.value.trim();S.customModel=false;const r=agentRow(S.sel.agent||S.preferred);if(r&&S.sel.model&&r.models.indexOf(S.sel.model)<0)r.models.push(S.sel.model);savePrefs();render()};
 const acc=$('selAcc');if(acc)acc.onchange=()=>{S.sel.access=acc.value;savePrefs();render()};
 const br=$('selBranch');if(br)br.onchange=()=>git('switch',{branch:br.value});
 const nb=$('newBranch');if(nb)nb.oninput=()=>S.newBranch=nb.value;const cmi=$('commitMsg');if(cmi)cmi.oninput=()=>S.commitMsg=cmi.value;
 document.querySelectorAll('details.act').forEach(d=>d.ontoggle=()=>{S.openAct=S.openAct||{};S.openAct[d.dataset.i]=d.open})}
function tick(){const c=$('clock');if(c&&S.job)c.textContent=fmtS(((S.job.endedAt&&S.job.status!=='running'?S.job.endedAt:Date.now())-S.job.startedAt)/1000)}
// ---- data
function setJob(d){if(!d||!d.job)return;const prev=S.job;S.job=d.job;if(d.events)S.events=d.events;S.cwd=d.job.cwd||S.cwd;if(!prev||prev.thread!==d.job.thread)S.confirmRevert=false}
async function poll(){clearTimeout(S.pt);if(!S.job)return;try{const r=await bridge.call('agent_status',{job_id:S.job.id,since:S.events.length});if(r&&r.job){const was=S.job.status;S.job=r.job;
  // New activity keeps the card responsive; a quiet agent is polled more and more slowly.
  S.pollWait=(r.events||[]).length?2000:Math.min((S.pollWait||2000)*1.5,10000);
  S.events=S.events.concat(r.events||[]);
  if(was==='running'&&r.job.status!=='running'){if(S.autoReview&&r.job.status==='done')review();if(S.mode==='workbench')refreshProject()}render()}}catch(e){}
 // Polling costs a tool call each time: slow down while nothing happens, stop while the card is hidden.
 if(S.job&&(S.job.status==='running'||(S.job.queued||[]).length))S.pt=setTimeout(poll,document.hidden?8000:S.pollWait||2000)}
async function termPoll(){if(!S.term.sid||!S.term.running)return;
 try{const r=await bridge.call('shell_peek',{session_id:S.term.sid});if(r){S.term.text=r.text||S.term.text;S.term.running=r.live!==false;render();
  const el=$('termout');if(el)el.scrollTop=el.scrollHeight}}catch(e){S.term.running=false}
 if(S.term.running)setTimeout(termPoll,document.hidden?6000:2000)}
async function refreshProject(){if(!S.cwd)return;try{const r=await bridge.call('workbench_state',{cwd:S.cwd});if(r){S.project=r.project;S.agents=r.agents||S.agents;S.threads=r.threads||S.threads;render()}}catch(e){}}
async function git(action,extra){try{const r=await bridge.call('workbench_git',Object.assign({cwd:S.cwd,action},extra||{}));toast(r.result||'完成');if(r.project)S.project=r.project;if(action==='commit')S.commitMsg='';if(action==='create_branch')S.newBranch='';render()}catch(e){toast('✗ '+e.message)}}
function review(){if(!S.job)return;bridge.followUp('請用 agent_result 檢查 agent 對話 '+S.job.id+'（'+S.job.agentLabel+'）的結果和所有改動，告訴我有沒有問題、還缺什麼。')}
async function act(a,el){try{
 if(a==='term'){S.term.open=!S.term.open;render();if(S.term.open)setTimeout(()=>{const i=$('termcmd');if(i)i.focus()},50);return}
 if(a==='termrun'){const i=$('termcmd');const cmd=(i&&i.value||'').trim();if(!cmd)return;S.term.cmd=cmd;S.term.text='';S.term.running=true;render();
  const t=await bridge.callText('shell_run',{command:cmd,cwd:S.cwd,yield_seconds:2});
  const m=t.match(/session (sh[0-9]+)/);S.term.sid=m?m[1]:'';S.term.text=t;S.term.running=/still running/.test(t);render();termPoll();return}
 if(a==='termkill'){if(S.term.sid)await bridge.call('shell_kill',{session_id:S.term.sid});S.term.running=false;render();return}
 if(a==='tree'){S.tree.open=!S.tree.open;S.side=true;render();if(S.tree.open&&S.tree.items==null){const r=await bridge.call('view',{path:S.cwd});S.tree.items=(r&&r.text)||'';render()}return}
 if(a==='togpt'){S.toGpt=!S.toGpt;savePrefs();render();return}
 if(a==='send'){const ta=$('msg');const text=(ta&&ta.value||'').trim();if(!text)return;$('sendb').disabled=true;
  if(S.toGpt){await bridge.followUp(text);draft='';ta.value='';toast('已送到 ChatGPT 對話（在那個分頁會看到）');render();return}
  if(!S.job){const r=await bridge.call('agent_run',{task:text,cwd:S.cwd||undefined,agent:S.sel.agent||S.preferred||undefined,model:S.sel.model||undefined,access:S.sel.access});setJob(r)}
  else{const r=await bridge.call('agent_message',{job_id:S.job.id,message:text,interrupt:S.interrupt});setJob(r);toast(r.delivered==='queued'?'已排隊，會在目前步驟結束後送出':'已送出')}
  draft='';if(ta)ta.value='';S.interrupt=false;savePrefs();render();poll();return}
 if(a==='sdiff'){const c=S.sum.changed[+el.dataset.i];if(S.openDiff===c.path){S.openDiff=null;render();return}S.openDiff=c.path;S.diffText=null;render();
  const r=S.sum.job?await bridge.call('agent_diff',{job_id:S.sum.job.id,path:c.path,card:true}):await bridge.call('summary_diff',{cwd:S.sum.cwd,path:c.path});
  S.diffText=(r&&r.diff)||'';render();return}
 if(a==='srevert'){if(!S.confirmRevert){S.confirmRevert=true;render();setTimeout(()=>{S.confirmRevert=false;render()},5000);return}S.confirmRevert=false;await bridge.call('agent_revert',{job_id:S.sum.job.id});toast('已復原');S.sum.changed=[];render();return}
 if(a==='step'){const t=S.sum.nextSteps[+el.dataset.i];bridge.followUp(t);toast('已送出：'+t);return}
 if(a==='sdrive'){await bridge.call('drive_send',{paths:(S.sum.changed||[]).map(c=>c.path).slice(0,20)});toast('已送到 Drive 的寄件匣');return}
 if(a==='swb'){S.mode='workbench';S.side=true;S.cwd=S.sum.cwd;try{await bridge.display('fullscreen')}catch(e){}render();refreshProject();return}
 if(a==='intr'){S.interrupt=!S.interrupt;render();return}
 if(a==='pause'){setJob(await bridge.call('agent_pause',{job_id:S.job.id}));render();return}
 if(a==='stop'){setJob(await bridge.call('agent_cancel',{job_id:S.job.id}));render();return}
 if(a==='resume'){setJob(await bridge.call('agent_resume',{job_id:S.job.id}));render();poll();return}
 if(a==='review'){review();return}
 if(a==='revert'){if(!S.confirmRevert){S.confirmRevert=true;render();setTimeout(()=>{S.confirmRevert=false;render()},5000);return}S.confirmRevert=false;const r=await bridge.call('agent_revert',{job_id:S.job.id});toast('已復原');S.job.changed=[];render();refreshProject();return}
 if(a==='jdiff'){const c=S.job.changed[+el.dataset.i];if(S.openDiff===c.path&&S.diffSrc==='job'){S.openDiff=null;render();return}S.openDiff=c.path;S.diffSrc='job';S.diffText=null;render();const r=await bridge.call('agent_diff',{job_id:S.job.id,path:c.path,card:true});S.diffText=r&&r.diff!==undefined?r.diff:'';render();return}
 if(a==='pdiff'){const p=el.dataset.p;S.openDiff=p;S.diffSrc='proj';S.diffText=null;render();const r=await bridge.call('workbench_diff',{cwd:S.cwd,path:p});S.diffText=r&&r.diff||'';render();return}
 if(a==='pchanges'){S.showP=!S.showP;render();return}
 if(a==='closediff'){S.openDiff=null;render();return}
 if(a==='wb'){S.mode='workbench';S.side=true;savePrefs();try{await bridge.display('fullscreen')}catch(e){}setTimeout(render,300);render();refreshProject();return}
 if(a==='inline'){S.mode='inline';S.side=false;S.openDiff=null;savePrefs();try{await bridge.display('inline')}catch(e){}render();return}
 if(a==='pip'){try{await bridge.display('pip')}catch(e){}return}
 if(a==='side'){S.side=!S.side;render();return}
 if(a==='new'){S.job=null;S.events=[];S.openDiff=null;savePrefs();render();return}
 if(a==='thread'){const r=await bridge.call('agent_status',{job_id:el.dataset.id,since:0});S.events=[];setJob(r);S.openDiff=null;render();poll();return}
 if(a==='acc'){S.sel.access=el.dataset.v;savePrefs();render();return}
 if(a==='auto'){S.autoReview=!S.autoReview;savePrefs();render();return}
 if(a==='defmodel'){const ag=S.sel.agent||S.preferred;const m=S.sel.model||(agentRow(ag)||{}).model;if(!m)return;await bridge.call('agents_configure',{agent:ag,model:m});const r=agentRow(ag);if(r)r.model=m;toast('已設為 '+ag+' 的預設模型');return}
 if(a==='commit'){if(!S.commitMsg.trim()){toast('先寫送交訊息');return}await git('commit',{message:S.commitMsg});return}
 if(a==='push'){await git('push');return}
 if(a==='branch'){if(!S.newBranch.trim()){toast('先輸入新分支名稱');return}await git('create_branch',{branch:S.newBranch});return}
 }catch(e){toast('✗ '+(e&&e.message||e));const sb=$('sendb');if(sb)sb.disabled=false}}
document.addEventListener('click',e=>{const el=e.target.closest('[data-act]');if(!el||el.disabled)return;e.preventDefault();act(el.dataset.act,el)});
const LOCAL=!!window.WB_LOCAL;
// In ChatGPT the card is the only thing that can talk into the conversation, so it carries messages
// typed in the local workbench. Polls slowly, and not at all while the card is off screen.
async function relayTick(){clearTimeout(S.rt);
 if(!LOCAL&&window.openai&&!document.hidden){try{const r=await bridge.call('relay_poll',{});
  for(const m of (r&&r.messages)||[]){await bridge.followUp(m);toast('已送出工作台的指令')}}catch(e){}}
 S.rt=setTimeout(relayTick,document.hidden?60000:25000)}
if(!LOCAL&&window.openai)S.rt=setTimeout(relayTick,4000);
setInterval(tick,1000);
window.addEventListener('openai:set_globals',()=>{if(S.mode==='workbench'&&S.full!==(bridge.displayMode()==='fullscreen'))render()});
waitData(async d=>{loadPrefs();
 if(d.mode==='summary'){S.mode='summary';S.sum=d;S.cwd=d.cwd||'';render();return}
 if(d.mode==='workbench'){S.mode='workbench';S.side=bridge.displayMode()==='fullscreen';S.cwd=d.cwd;S.project=d.project;S.agents=d.agents||[];S.preferred=d.preferred||'';S.threads=d.threads||[];if(d.job)setJob(d);render();try{await bridge.display('fullscreen')}catch(e){}if(S.job)poll();return}
 setJob(d);render();poll();
 try{const r=await bridge.call('agents_list',{});S.agents=(r.agents||[]).map(a=>({id:a.agent,label:a.name,offered:a.offered,installed:a.installed,ok:a.ok,model:a.model,models:Array.from(new Set([a.model].concat(a.suggestedModels||[]).filter(Boolean)))}));S.preferred=r.preferred||'';render()}catch(e){}});
</script></body></html>`;

export const VIEWER_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}
.hd{display:flex;align-items:center;gap:8px;padding:6px 4px 10px}.hd .ttl{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{max-height:540px;overflow:auto;border:1px solid var(--line);border-radius:14px}.fs .body{max-height:calc(100vh - 70px)}
img{max-width:100%;display:block;margin:0 auto}
.code{font:12.5px/1.55 var(--mono);white-space:pre;padding:8px 0;counter-reset:ln}.code div{counter-increment:ln;padding-right:12px}.code div::before{content:counter(ln);display:inline-block;width:3.4em;color:var(--faint);text-align:right;margin-right:14px;user-select:none}
.tree{font:12.5px/1.65 var(--mono);white-space:pre;padding:10px 14px}
.term{background:#0d0d0d;color:#e6e6e6;padding:12px 14px;font:12.5px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;min-height:120px}
.note{padding:16px;color:var(--muted)}
</style></head><body><div id="app"><div class="hd"><span class="ttl" id="title">載入中…</span><span class="chip" id="meta"></span><button class="ib" id="refresh" hidden title="重新整理"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/></svg></button><button class="ib" id="fs" title="全螢幕"></button><button class="ib" id="pip" title="子母畫面"></button></div>
<div class="body" id="body"></div></div><script>${ICONS}${BRIDGE_JS}
document.getElementById('fs').innerHTML=IC.expand;document.getElementById('pip').innerHTML=IC.pip;
let d=null,live=null;
function render(){const b=document.getElementById('body');document.getElementById('title').textContent=d.title||d.path||'';const m=document.getElementById('meta');m.textContent=d.meta||'';m.hidden=!d.meta;
 document.getElementById('refresh').hidden=!d.refreshTool;
 if(d.kind==='image')b.innerHTML='<img src="data:'+esc(d.mime)+';base64,'+d.data+'" alt="">';
 else if(d.kind==='text')b.innerHTML='<div class="code">'+d.text.split(NL).map(l=>'<div>'+esc(l)+'</div>').join('')+'</div>';
 else if(d.kind==='dir')b.innerHTML='<div class="tree">'+esc(d.text)+'</div>';
 else if(d.kind==='diff')b.innerHTML=diffHtml(d.text);
 else if(d.kind==='terminal'){b.innerHTML='<div class="term" id="term">'+esc(d.text)+'</div>';b.scrollTop=b.scrollHeight}
 else b.innerHTML='<div class="note">'+esc(d.text||'（無法預覽）')+'</div>'}
async function refresh(){if(!d||!d.refreshTool)return;try{const r=await bridge.call(d.refreshTool,d.refreshArgs||{});if(r&&r.kind){d=r;render()}}catch(e){}}
// Every refresh is a tool call through ChatGPT, so an unchanging view slows down (and a hidden card
// stops) instead of polling at full speed forever.
let wait=0,same=0;
function schedule(){if(!d||!d.liveMs)return;clearTimeout(live);wait=wait||d.liveMs;
 live=setTimeout(async()=>{
  if(document.hidden){schedule();return}
  const before=d.text||d.data||'';await refresh();
  if((d.text||d.data||'')===before){same++;wait=Math.min(wait*1.6,20000)}else{same=0;wait=d.liveMs}
  if(d.live!==false&&same<40)schedule()},wait)}
waitData(x=>{d=x;render();schedule()});
document.getElementById('refresh').onclick=refresh;
document.getElementById('fs').onclick=()=>{document.body.classList.add('fs');bridge.display('fullscreen')};
document.getElementById('pip').onclick=()=>bridge.display('pip');
</script></body></html>`;

export const AGENT_PANEL_URI = versionedUri("agent-panel", AGENT_PANEL_HTML);
export const VIEWER_URI = versionedUri("viewer", VIEWER_HTML);
