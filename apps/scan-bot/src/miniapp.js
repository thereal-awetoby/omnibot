// The interactive Bubblemap: a small web server inside the Scan bot. Telegram opens its page inside the app.
// Routes: /map?mint=... (the page), /api/map?mint=... (the data), /health.
import http from 'node:http';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// loaded: { built, groups, funders, layout, checked, total, curve } from bubbleload.js. Pure: shapes the JSON the page draws.
export function buildMapPayload({ symbol = null, name = null, loaded }) {
  const { built, groups = [], funders = new Map(), layout, checked = 0, total = 0, curve = false } = loaded;
  const bubbles = [...layout.bubbles]
    .sort((a, b) => (a.kind === 'pool') - (b.kind === 'pool') || b.pct - a.pct)
    .map((b, i) => ({
      owner: b.kind === 'pool' ? null : b.owner,
      pct: Math.round((b.kind === 'pool' ? built.poolPct : b.pct) * 100) / 100,
      kind: b.kind, group: b.group ?? null,
      funder: b.kind === 'pool' ? null : funders.get(b.owner) ?? null,
      rank: b.kind === 'pool' ? null : i + 1,
      x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, r: Math.round(b.r * 10) / 10,
    }));
  return {
    symbol, name,
    poolLabel: curve ? 'Bonding curve' : 'Liquidity pool',
    topPct: Math.round(built.topPct * 10) / 10,
    poolPct: Math.round(built.poolPct * 10) / 10,
    burnPct: Math.round(built.burnPct * 10) / 10,
    wallets: built.nodes.length,
    checked, total,
    bubbles,
    clusters: layout.clusters.map((c) => ({ group: c.group, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, r: Math.round(c.r * 10) / 10 })),
    groups: groups.map((g) => ({ funder: g.funder, count: g.owners.length, pct: Math.round(g.pct * 10) / 10 })),
  };
}

// loadData(mint) -> payload (or null). Answers are cached for a minute; each IP gets 30 data requests a minute.
export function startMiniApp({ port, loadData, log = console }) {
  const cache = new Map();
  const hits = new Map();
  const limited = (ip) => {
    const now = Date.now();
    const h = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    h.push(now);
    hits.set(ip, h);
    if (hits.size > 2000) hits.clear();
    return h.length > 30;
  };
  const send = (res, code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
      if (url.pathname === '/health') return send(res, 200, 'text/plain', 'ok');
      if (url.pathname === '/map') return send(res, 200, 'text/html; charset=utf-8', MAP_PAGE);
      if (url.pathname === '/api/map') {
        const mint = url.searchParams.get('mint') ?? '';
        if (!ADDR_RE.test(mint)) return send(res, 400, 'application/json', '{"error":"bad address"}');
        if (limited(ip)) return send(res, 429, 'application/json', '{"error":"slow down"}');
        const hit = cache.get(mint);
        if (hit && Date.now() - hit.at < 60_000) return send(res, 200, 'application/json', hit.body);
        const data = await loadData(mint);
        if (!data) return send(res, 404, 'application/json', '{"error":"no data"}');
        const body = JSON.stringify(data);
        if (cache.size > 100) cache.delete(cache.keys().next().value);
        cache.set(mint, { at: Date.now(), body });
        return send(res, 200, 'application/json', body);
      }
      return send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      log.error('miniapp error:', e.message);
      return send(res, 500, 'application/json', '{"error":"failed"}');
    }
  });
  server.listen(port, () => log.log(`Bubblemap mini app listening on port ${port}`));
  return server;
}

export const MAP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Bubblemap</title>
<script src="https://telegram.org/js/telegram-web-app.js" onerror="void 0"></script>
<style>
:root{--bg:#070d1a;--fg:#eef2fb;--mut:#8493ad;--card:#0f1a30;--line:#1d2b4a;--acc:#4f8cff}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
body{display:flex;flex-direction:column;background:radial-gradient(120% 70% at 50% 30%,#10203f 0%,#070d1a 70%)}
#top{padding:12px 14px 4px}#title{font-size:18px;font-weight:700;letter-spacing:.2px}
#sub{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
.chip{background:#ffffff0d;border:1px solid #ffffff14;color:#c9d4ea;border-radius:999px;padding:3px 10px;font-size:12px}
.chip b{color:#fff}
#stage{position:relative;flex:1;min-height:0}
svg{width:100%;height:100%;display:block;touch-action:none;cursor:grab}svg:active{cursor:grabbing}
.b{cursor:pointer;filter:drop-shadow(0 3px 7px #0007);transition:filter .15s}
.b:hover{filter:drop-shadow(0 0 9px #fff9) brightness(1.12)}
.b.sel{filter:drop-shadow(0 0 12px #fff) brightness(1.15);stroke:#fff!important;stroke-width:3.5!important}
#tip{position:absolute;pointer-events:none;background:#050a14ee;border:1px solid var(--line);padding:5px 10px;border-radius:8px;font-size:12px;display:none;white-space:nowrap;box-shadow:0 4px 14px #0008}
#zoom{position:absolute;right:10px;top:8px;display:flex;flex-direction:column;gap:6px}
#zoom button{width:36px;height:36px;border-radius:10px;border:1px solid var(--line);background:#0f1a30e6;color:var(--fg);font-size:18px;cursor:pointer}
#zoom button:active{background:#1a2a4d}
#legend{display:flex;flex-wrap:wrap;gap:4px 14px;padding:6px 14px 8px;color:var(--mut);font-size:12px}
#legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
#info{background:linear-gradient(180deg,#13213e,#0d1730);padding:14px 16px calc(14px + env(safe-area-inset-bottom));min-height:104px;border-top:1px solid var(--line);border-radius:18px 18px 0 0;box-shadow:0 -8px 24px #0006}
#info .hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
#info .big{font-size:20px;font-weight:700}
.pill{font-size:11px;padding:2px 9px;border-radius:999px;background:#ffffff14;color:#dbe4f7}
#info code{display:block;word-break:break-all;font-size:12px;color:#a9b7d3;background:#00000030;border:1px solid #ffffff10;border-radius:10px;padding:8px 10px;margin:10px 0}
.row{display:flex;gap:8px;flex-wrap:wrap}
.btn{border:1px solid var(--line);background:#1a2a4d;color:var(--fg);padding:9px 14px;border-radius:10px;font-size:13px;text-decoration:none;cursor:pointer}
.btn.pri{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
.btn.ok{background:#15803d;border-color:#15803d}
#msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--mut);text-align:center;padding:20px}
</style></head><body>
<div id="top"><div id="title">Bubblemap</div><div id="sub"></div></div>
<div id="stage"><svg id="svg" viewBox="0 0 940 820" preserveAspectRatio="xMidYMid meet"><g id="vp"></g></svg>
<div id="zoom"><button id="zi">+</button><button id="zo">−</button><button id="zr">⟲</button></div>
<div id="tip"></div><div id="msg">Loading holders…</div></div>
<div id="legend"></div>
<div id="info"><span style="color:var(--mut)">Tap a bubble to see its wallet. Drag to move, pinch or use + / − to zoom.</span></div>
<script>
(function(){
var tg=window.Telegram&&window.Telegram.WebApp; if(tg){try{tg.ready();tg.expand();}catch(e){}}
var GROUPS=['#ff9f43','#a55eea','#26de81','#fd79a8','#00cec9','#fdcb6e','#e17055','#74b9ff'];
var C={holder:'#4f8cff',insider:'#ff4d4d',dev:'#ffd43b',pool:'#6b7280'};
var mint=new URLSearchParams(location.search).get('mint')||'';
var svg=document.getElementById('svg'),vp=document.getElementById('vp'),tip=document.getElementById('tip'),info=document.getElementById('info');
var NS='http://www.w3.org/2000/svg',data=null,selEl=null,k=1,tx=0,ty=0,vc={x:470,y:410};
function el(n,a,p){var e=document.createElementNS(NS,n);for(var i in a)e.setAttribute(i,a[i]);if(p)p.appendChild(e);return e;}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function short(a){return a?a.slice(0,4)+'…'+a.slice(-4):'';}
function fmt(p){return p>=10?p.toFixed(0):p>=1?p.toFixed(1):p.toFixed(2);}
function colour(b){return b.kind==='pool'?C.pool:b.kind==='dev'?C.dev:b.kind==='insider'?C.insider:b.group!==null?GROUPS[b.group%GROUPS.length]:C.holder;}
function mix(a,b,t){var pa=parseInt(a.slice(1),16),pb=parseInt(b.slice(1),16),r='';[16,8,0].forEach(function(sh){var x=Math.round(((pa>>sh)&255)*(1-t)+((pb>>sh)&255)*t);r+=('0'+x.toString(16)).slice(-2);});return '#'+r;}
var gid={},defs=null;
function grad(col){if(gid[col])return gid[col];var id='g'+Object.keys(gid).length;gid[col]=id;var g=el('radialGradient',{id:id,cx:'35%',cy:'28%',r:'80%'},defs);el('stop',{offset:'0','stop-color':mix(col,'#ffffff',0.5)},g);el('stop',{offset:'0.55','stop-color':col},g);el('stop',{offset:'1','stop-color':mix(col,'#000000',0.28)},g);return id;}
function apply(){vp.setAttribute('transform','translate('+tx+' '+ty+') scale('+k+')');}
function zoomAt(f,cx,cy){var nk=Math.max(0.6,Math.min(8,k*f));f=nk/k;tx=cx-(cx-tx)*f;ty=cy-(cy-ty)*f;k=nk;apply();}
function toSvg(ev){var p=svg.createSVGPoint();p.x=ev.clientX;p.y=ev.clientY;return p.matrixTransform(svg.getScreenCTM().inverse());}
function copy(text,btn){
  function done(){var t=btn.textContent;btn.textContent='Copied ✓';btn.classList.add('ok');setTimeout(function(){btn.textContent=t;btn.classList.remove('ok');},1500);}
  function fallback(){var t=document.createElement('textarea');t.value=text;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();try{document.execCommand('copy');done();}catch(e){}document.body.removeChild(t);}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,fallback);}else fallback();
}
function openLink(u){if(tg&&tg.openLink)tg.openLink(u);else window.open(u,'_blank');}
function select(b,node){
  if(selEl)selEl.classList.remove('sel');selEl=node;node.classList.add('sel');
  var h;
  if(b.kind==='pool'){info.innerHTML='<div class="hd"><span class="big">'+fmt(b.pct)+'%</span><span class="pill">'+esc(data.poolLabel)+'</span></div><code>Not a holder: this is where the token trades.</code>';return;}
  var tags=[];if(b.kind==='dev')tags.push('Dev');if(b.kind==='insider')tags.push('Flagged linked');if(b.group!==null)tags.push('Linked group');
  h='<div class="hd"><span class="big">'+fmt(b.pct)+'%</span><span class="pill">#'+b.rank+' holder</span>'+tags.map(function(t){return '<span class="pill">'+t+'</span>';}).join('')+'</div>'+
    '<code>'+esc(b.owner)+'</code>'+
    '<div class="row"><button class="btn pri" id="cp">Copy address</button><a class="btn" id="sl" href="https://solscan.io/account/'+esc(b.owner)+'">Solscan</a>'+
    (b.funder?'<button class="btn" id="cf">Copy funder '+esc(short(b.funder))+'</button>':'')+'</div>';
  info.innerHTML=h;
  document.getElementById('cp').onclick=function(){copy(b.owner,this);};
  document.getElementById('sl').onclick=function(e){e.preventDefault();openLink(this.href);};
  if(b.funder)document.getElementById('cf').onclick=function(){copy(b.funder,this);};
}
function render(d){
  data=d;defs=el('defs',{},vp);
  var x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
  d.bubbles.concat(d.clusters).forEach(function(b){x0=Math.min(x0,b.x-b.r);x1=Math.max(x1,b.x+b.r);y0=Math.min(y0,b.y-b.r);y1=Math.max(y1,b.y+b.r);});
  if(x1>x0){var pad=14;svg.setAttribute('viewBox',(x0-pad)+' '+(y0-pad)+' '+(x1-x0+2*pad)+' '+(y1-y0+2*pad));vc={x:(x0+x1)/2,y:(y0+y1)/2};}
  document.getElementById('title').textContent=(d.symbol?'$'+d.symbol:'Bubblemap')+(d.name?' · '+d.name:'');
  var chips=['<span class="chip">Top '+d.wallets+' hold <b>'+fmt(d.topPct)+'%</b></span>'];
  if(d.poolPct>0.05)chips.push('<span class="chip">'+esc(d.poolLabel)+' <b>'+fmt(d.poolPct)+'%</b></span>');
  if(d.groups.length)chips.push('<span class="chip"><b>'+d.groups.length+'</b> linked group'+(d.groups.length>1?'s':'')+'</span>');
  else if(d.checked>0)chips.push('<span class="chip">No shared funders found</span>');
  document.getElementById('sub').innerHTML=chips.join('');
  d.clusters.forEach(function(c){var col=GROUPS[c.group%GROUPS.length];el('circle',{cx:c.x,cy:c.y,r:c.r,fill:col,'fill-opacity':'0.08',stroke:col,'stroke-width':3,'stroke-dasharray':'10 8'},vp);});
  d.bubbles.forEach(function(b){
    var col=colour(b),g=el('circle',{cx:b.x,cy:b.y,r:b.r,fill:'url(#'+grad(col)+')',stroke:mix(col,'#ffffff',0.4),'stroke-width':1.5,'class':'b'},vp);
    if(b.r>=15){var sz=Math.max(10,Math.min(b.r*0.5,28));var t=el('text',{x:b.x,y:b.y+sz*0.35,'text-anchor':'middle','font-size':sz,'font-weight':700,fill:'#06101f','pointer-events':'none'},vp);t.textContent=fmt(b.pct)+'%';}
    g.addEventListener('mouseenter',function(ev){tip.style.display='block';tip.textContent=(b.kind==='pool'?d.poolLabel:'#'+b.rank+' '+short(b.owner))+' · '+fmt(b.pct)+'%';});
    g.addEventListener('mousemove',function(ev){var r=document.getElementById('stage').getBoundingClientRect();tip.style.left=Math.min(ev.clientX-r.left+12,r.width-170)+'px';tip.style.top=(ev.clientY-r.top+12)+'px';});
    g.addEventListener('mouseleave',function(){tip.style.display='none';});
    g.addEventListener('click',function(ev){if(moved>5)return;select(b,g);});
  });
  var items=[['Wallet',C.holder],['Linked group',GROUPS[0]],['Flagged linked',C.insider],['Dev',C.dev],['Pool',C.pool]];
  document.getElementById('legend').innerHTML=items.map(function(i){return '<span><i style="background:'+i[1]+'"></i>'+i[0]+'</span>';}).join('');
}
// pan, wheel zoom and two-finger pinch
var ptrs={},moved=0,lastD=0;
svg.addEventListener('pointerdown',function(e){ptrs[e.pointerId]={x:e.clientX,y:e.clientY};moved=0;lastD=0;});
svg.addEventListener('pointermove',function(e){
  var p=ptrs[e.pointerId];if(!p)return;
  var ids=Object.keys(ptrs),sc=svg.getScreenCTM().a||1;
  if(ids.length===1){var dx=e.clientX-p.x,dy=e.clientY-p.y;moved+=Math.abs(dx)+Math.abs(dy);if(moved>5){tx+=dx/sc;ty+=dy/sc;apply();}}
  else if(ids.length===2){
    ptrs[e.pointerId]={x:e.clientX,y:e.clientY};
    var a=ptrs[ids[0]],b=ptrs[ids[1]],d=Math.hypot(a.x-b.x,a.y-b.y);moved=10;
    if(lastD){var m=toSvg({clientX:(a.x+b.x)/2,clientY:(a.y+b.y)/2});zoomAt(d/lastD,m.x,m.y);}
    lastD=d;return;
  }
  ptrs[e.pointerId]={x:e.clientX,y:e.clientY};
});
function up(e){delete ptrs[e.pointerId];lastD=0;}
svg.addEventListener('pointerup',up);svg.addEventListener('pointercancel',up);svg.addEventListener('pointerleave',up);
svg.addEventListener('wheel',function(e){e.preventDefault();var m=toSvg(e);zoomAt(e.deltaY<0?1.15:1/1.15,m.x,m.y);},{passive:false});
document.getElementById('zi').onclick=function(){zoomAt(1.4,vc.x,vc.y);};
document.getElementById('zo').onclick=function(){zoomAt(1/1.4,vc.x,vc.y);};
document.getElementById('zr').onclick=function(){k=1;tx=0;ty=0;apply();};
fetch('/api/map?mint='+encodeURIComponent(mint)).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
 .then(function(d){document.getElementById('msg').remove();render(d);})
 .catch(function(){document.getElementById('msg').textContent='Could not build this map right now. Close and try again in a moment.';});
})();
</script></body></html>`;
