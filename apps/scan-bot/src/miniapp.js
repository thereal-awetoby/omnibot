// The interactive Bubblemap: a small web server inside the Scan bot. Telegram opens its page inside the app.
// Routes: /map?mint=... (the page), /api/map?mint=... (the data), /health.
import http from 'node:http';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// loaded: { built, groups, funders, layout, checked, total, curve } from bubbleload.js. Pure: shapes the JSON the page draws.
export function buildMapPayload({ symbol = null, name = null, market = null, loaded }) {
  const { built, more = [], groups = [], funders = new Map(), layout, checked = 0, total = 0, curve = false } = loaded;
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
  const ranked = bubbles.filter((b) => b.kind !== 'pool').length;
  const others = more.map((n, i) => ({ owner: n.owner, pct: Math.round(n.pct * 100) / 100, kind: n.kind, group: null, funder: null, rank: ranked + i + 1 }));
  const shownTop = built.topPct + more.reduce((a, n) => a + n.pct, 0);
  const supply = market?.fdvUsd > 0 && market?.priceUsd > 0 ? Math.round(market.fdvUsd / market.priceUsd) : null;
  return {
    symbol, name,
    mcapUsd: market?.marketCapUsd ?? market?.fdvUsd ?? null,
    supply,
    poolLabel: curve ? 'Bonding curve' : 'Liquidity pool',
    topPct: Math.round(shownTop * 10) / 10,
    poolPct: Math.round(built.poolPct * 10) / 10,
    burnPct: Math.round(built.burnPct * 10) / 10,
    wallets: built.nodes.length + more.length,
    others,
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
:root{--bg:#06080d;--fg:#eef2fb;--mut:#8493ad;--card:#0f1625;--line:#1b2640;--acc:#4f8cff}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
body{display:flex;flex-direction:column;background:radial-gradient(110% 70% at 50% 35%,#0f1a30 0%,#06080d 72%)}
#top{padding:10px 12px 2px;display:flex;align-items:flex-start;gap:10px}
#head{flex:1;min-width:0}
#title{font-size:18px;font-weight:700;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#sub{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.chip{background:#ffffff0d;border:1px solid #ffffff14;color:#c9d4ea;border-radius:999px;padding:3px 10px;font-size:12px}
.chip b{color:#fff}
#al{flex:none;border:1px solid var(--line);background:#101a30;color:var(--fg);padding:8px 12px;border-radius:10px;font-size:13px;cursor:pointer}
#stage{position:relative;flex:1;min-height:0}
svg{width:100%;height:100%;display:block;touch-action:none;cursor:grab;user-select:none}
.n{cursor:pointer;transition:filter .15s}
.n:hover{filter:brightness(1.35)}
.n.sel{stroke:#fff!important;stroke-width:3.5!important}
.lbl{pointer-events:none;font-weight:700;fill:#fff;paint-order:stroke;stroke:#000a;stroke-width:3px}
#tip{position:absolute;pointer-events:none;background:#050a14ee;border:1px solid var(--line);padding:5px 10px;border-radius:8px;font-size:12px;display:none;white-space:nowrap;box-shadow:0 4px 14px #0008}
#zoom{position:absolute;right:10px;top:8px;display:flex;flex-direction:column;gap:6px}
#zoom button{width:36px;height:36px;border-radius:10px;border:1px solid var(--line);background:#0f1625e6;color:var(--fg);font-size:18px;cursor:pointer}
#zoom button:active{background:#1a2a4d}
#legend{display:flex;flex-wrap:wrap;gap:4px 14px;padding:6px 14px 8px;color:var(--mut);font-size:12px}
#legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
#info{background:linear-gradient(180deg,#13213e,#0b1326);padding:14px 16px calc(14px + env(safe-area-inset-bottom));min-height:96px;max-height:46vh;overflow:auto;border-top:1px solid var(--line);border-radius:18px 18px 0 0;box-shadow:0 -8px 24px #0006}
#info .hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
#info .big{font-size:20px;font-weight:700}
.pill{font-size:11px;padding:2px 9px;border-radius:999px;background:#ffffff14;color:#dbe4f7}
#info code{display:block;word-break:break-all;font-size:12px;color:#a9b7d3;background:#00000030;border:1px solid #ffffff10;border-radius:10px;padding:8px 10px;margin:10px 0}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}
.stats div{background:#00000030;border:1px solid #ffffff10;border-radius:10px;padding:8px 4px;text-align:center}
.stats b{display:block;font-size:15px}.stats span{font-size:11px;color:var(--mut)}
.clu{margin-top:8px;padding:8px 10px;border-left:3px solid var(--acc);background:#00000030;border-radius:8px;font-size:12px;color:#c9d4ea}
.row{display:flex;gap:8px;flex-wrap:wrap}
.btn{border:1px solid var(--line);background:#1a2a4d;color:var(--fg);padding:9px 14px;border-radius:10px;font-size:13px;text-decoration:none;cursor:pointer}
.btn.pri{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
.btn.ok{background:#15803d;border-color:#15803d}
#msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--mut);text-align:center;padding:20px}
#sheet{position:fixed;left:0;right:0;bottom:0;height:68%;background:#0b1326;border-top:1px solid var(--line);border-radius:18px 18px 0 0;box-shadow:0 -10px 30px #000a;display:none;flex-direction:column;z-index:5}
#sheet.open{display:flex}
#sh{display:flex;gap:8px;padding:12px;align-items:center}
#q{flex:1;min-width:0;background:#00000040;border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:9px 12px;font-size:14px;outline:none}
#list{flex:1;overflow:auto;padding:0 8px 12px}
.li{display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:10px;cursor:pointer}
.li:active,.li:hover{background:#ffffff0d}
.li i{width:10px;height:10px;border-radius:50%;flex:none}
.li .rk{color:var(--mut);width:34px;flex:none;font-size:12px}
.li .ad{flex:1;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.li .pc{font-weight:700;font-size:13px}
</style></head><body>
<div id="top"><div id="head"><div id="title">Bubblemap</div><div id="sub"></div></div><button id="al">Address list</button></div>
<div id="stage"><svg id="svg" viewBox="-400 -400 800 800" preserveAspectRatio="xMidYMid meet"><g id="vp"></g></svg>
<div id="zoom"><button id="zi">+</button><button id="zo">−</button><button id="zr">⟲</button></div>
<div id="tip"></div><div id="msg">Loading holders…</div></div>
<div id="legend"></div>
<div id="info"><span style="color:var(--mut)">Tap a bubble to see its wallet. Drag a bubble to move it, drag the background to pan, pinch or use + / − to zoom.</span></div>
<div id="sheet"><div id="sh"><input id="q" placeholder="Search address" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn" id="sx">Close</button></div><div id="list"></div></div>
<script>
(function(){
var tg=window.Telegram&&window.Telegram.WebApp; if(tg){try{tg.ready();tg.expand();}catch(e){}}
var GROUPS=['#ff9f43','#a55eea','#26de81','#fd79a8','#00cec9','#fdcb6e','#e17055','#74b9ff'];
var C={holder:'#5b8def',insider:'#ff4d4d',dev:'#ff5db1',lp:'#8b98b0',curve:'#f5a524'};
var mint=new URLSearchParams(location.search).get('mint')||'';
var svg=document.getElementById('svg'),vp=document.getElementById('vp'),tip=document.getElementById('tip'),info=document.getElementById('info');
var NS='http://www.w3.org/2000/svg',data=null,selEl=null,k=1,tx=0,ty=0,vc={x:0,y:0};
var nodes=[],all=[],links=[],hubs=[],rings=[];
function el(n,a,p){var e=document.createElementNS(NS,n);for(var i in a)e.setAttribute(i,a[i]);if(p)p.appendChild(e);return e;}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function short(a){return a?a.slice(0,4)+'…'+a.slice(-4):'';}
function abbr(n){return n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':n.toFixed(0);}
function fmt(p){return p>=10?p.toFixed(0):p>=1?p.toFixed(1):p.toFixed(2);}
function colour(b){if(b.pool)return data.poolLabel==='Bonding curve'?C.curve:C.lp;return b.kind==='dev'?C.dev:b.kind==='insider'?C.insider:b.group!==null&&b.group!==undefined?GROUPS[b.group%GROUPS.length]:C.holder;}
function apply(){vp.setAttribute('transform','translate('+tx+' '+ty+') scale('+k+')');}
function zoomAt(f,cx,cy){var nk=Math.max(0.4,Math.min(8,k*f));f=nk/k;tx=cx-(cx-tx)*f;ty=cy-(cy-ty)*f;k=nk;apply();}
function toSvg(ev){var p=svg.createSVGPoint();p.x=ev.clientX;p.y=ev.clientY;return p.matrixTransform(svg.getScreenCTM().inverse());}
function copy(text,btn){
  function done(){var t=btn.textContent;btn.textContent='Copied ✓';btn.classList.add('ok');setTimeout(function(){btn.textContent=t;btn.classList.remove('ok');},1500);}
  function fallback(){var t=document.createElement('textarea');t.value=text;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();try{document.execCommand('copy');done();}catch(e){}document.body.removeChild(t);}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,fallback);}else fallback();
}
function openLink(u){if(tg&&tg.openLink)tg.openLink(u);else window.open(u,'_blank');}

/* ---------- layout: a small force simulation (no libraries) ---------- */
function relax(iters,fixed){
  var N=all.length;
  for(var it=0;it<iters;it++){
    var a=Math.max(0.15,1-it/iters);
    for(var i=0;i<N;i++){var n=all[i];if(n===fixed||n.pin||n.hub)continue;n.x-=n.x*0.010;n.y-=n.y*0.010;}
    for(var l=0;l<links.length;l++){
      var L=links[l],h=L.h,m=L.m,dx=m.x-h.x,dy=m.y-h.y,d=Math.hypot(dx,dy)||0.01,want=h.r+m.r+16,diff=(d-want)/d*0.12;
      if(m!==fixed&&!m.pin){m.x-=dx*diff;m.y-=dy*diff;}
    }
    for(var hi=0;hi<hubs.length;hi++){var H=hubs[hi],sx=0,sy=0,c=0;for(var q=0;q<H.members.length;q++){sx+=H.members[q].x;sy+=H.members[q].y;c++;}if(c){H.x=sx/c;H.y=sy/c;}}
    for(var i2=0;i2<N;i2++){
      var A=all[i2];if(A.hub)continue;
      for(var j=i2+1;j<N;j++){
        var B=all[j];if(B.hub)continue;
        var ddx=B.x-A.x,ddy=B.y-A.y,dd=Math.hypot(ddx,ddy)||0.01,min=A.r+B.r+(A.group!==null&&A.group===B.group?4:6);
        if(dd<min){
          var push=(min-dd)*0.55,ma=A.r*A.r,mb=B.r*B.r,wa=mb/(ma+mb),wb=ma/(ma+mb),ux=ddx/dd,uy=ddy/dd;
          if(A!==fixed&&!A.pin){A.x-=ux*push*wa*1.6;A.y-=uy*push*wa*1.6;}
          if(B!==fixed&&!B.pin){B.x+=ux*push*wb*1.6;B.y+=uy*push*wb*1.6;}
        }
      }
    }
  }
}
function layout(d){
  var wallets=d.bubbles.filter(function(b){return b.kind!=='pool';}).concat(d.others||[]);
  var poolB=d.bubbles.filter(function(b){return b.kind==='pool';})[0];
  var maxP=0.1;wallets.forEach(function(b){maxP=Math.max(maxP,b.pct);});
  function rad(p){return 6+Math.sqrt(p/maxP)*40;}
  wallets.forEach(function(b,i){
    var ang=i*2.399963,rr=30*Math.sqrt(i+1);
    nodes.push({owner:b.owner,pct:b.pct,kind:b.kind,group:b.group,funder:b.funder,rank:b.rank,r:rad(b.pct),x:rr*Math.cos(ang),y:rr*Math.sin(ang),small:i>=40});
  });
  if(poolB){nodes.push({pool:true,kind:'pool',pct:poolB.pct,group:null,r:rad(Math.min(poolB.pct,maxP*5)),x:0,y:0});}
  all=nodes.slice();
  d.groups.forEach(function(g,gi){
    var mem=nodes.filter(function(n){return n.group===gi;});if(!mem.length)return;
    var H={hub:true,g:gi,r:9,x:0,y:0,members:mem,group:gi};
    hubs.push(H);all.push(H);
    mem.forEach(function(m){links.push({h:H,m:m});});
  });
  relax(320,null);
}

/* ---------- drawing ---------- */
var els=[];
function draw(d){
  var defs=el('defs',{},vp);
  var marks={};
  function marker(col){if(marks[col])return marks[col];var id='m'+Object.keys(marks).length;marks[col]=id;var m=el('marker',{id:id,markerWidth:8,markerHeight:8,refX:7,refY:4,orient:'auto',markerUnits:'userSpaceOnUse'},defs);el('path',{d:'M0,0 L8,4 L0,8 z',fill:col},m);return id;}
  var ringLayer=el('g',{},vp),linkLayer=el('g',{},vp),nodeLayer=el('g',{},vp),hubLayer=el('g',{},vp);
  hubs.forEach(function(H){
    var col=GROUPS[H.g%GROUPS.length];
    H.ring=el('circle',{fill:col,'fill-opacity':'0.06',stroke:col,'stroke-width':2.5,'stroke-dasharray':'10 8','stroke-opacity':0.9},ringLayer);
  });
  links.forEach(function(L){
    var col=GROUPS[L.h.g%GROUPS.length];
    L.el=el('line',{stroke:col,'stroke-width':2,'stroke-opacity':0.9,'marker-end':'url(#'+marker(col)+')'},linkLayer);
  });
  nodes.forEach(function(n){
    var col=colour(n);
    n.el=el('circle',{r:n.r,fill:col,'fill-opacity':n.small?0.10:n.pool?0.30:0.26,stroke:col,'stroke-width':n.small?1.5:2.4,'stroke-dasharray':n.small?'3 3':'none','class':'n'},nodeLayer);
    n.el.style.filter='drop-shadow(0 0 '+(n.pool?10:5)+'px '+col+'88)';
    n.el.__n=n;
    if(n.pool){
      n.t=el('text',{'text-anchor':'middle','font-size':Math.max(14,n.r*0.26),'class':'lbl'},nodeLayer);
      n.t.textContent=fmt(n.pct)+'%';
      n.t2=el('text',{'text-anchor':'middle','font-size':Math.max(10,n.r*0.17),'class':'lbl',opacity:0.8},nodeLayer);
      n.t2.textContent=d.poolLabel;
    }else if(n.r>=15){
      n.t=el('text',{'text-anchor':'middle','font-size':Math.max(10,Math.min(n.r*0.45,24)),'class':'lbl'},nodeLayer);
      n.t.textContent=fmt(n.pct)+'%';
    }
    n.el.addEventListener('mouseenter',function(){tip.style.display='block';tip.textContent=(n.pool?d.poolLabel:'#'+n.rank+' '+short(n.owner))+' · '+fmt(n.pct)+'%';});
    n.el.addEventListener('mousemove',moveTip);
    n.el.addEventListener('mouseleave',function(){tip.style.display='none';});
  });
  hubs.forEach(function(H){
    var col=GROUPS[H.g%GROUPS.length];
    H.el=el('circle',{r:H.r,fill:'#06080d',stroke:col,'stroke-width':2.6,'stroke-dasharray':'4 3','class':'n'},hubLayer);
    H.el.__n=H;
    H.el.addEventListener('mouseenter',function(){tip.style.display='block';tip.textContent='Funder '+short((d.groups[H.g]||{}).funder||'');});
    H.el.addEventListener('mousemove',moveTip);
    H.el.addEventListener('mouseleave',function(){tip.style.display='none';});
  });
}
function moveTip(ev){var r=document.getElementById('stage').getBoundingClientRect();tip.style.left=Math.min(ev.clientX-r.left+12,r.width-190)+'px';tip.style.top=(ev.clientY-r.top+12)+'px';}
function redraw(){
  nodes.forEach(function(n){
    n.el.setAttribute('cx',n.x);n.el.setAttribute('cy',n.y);
    if(n.t){n.t.setAttribute('x',n.x);n.t.setAttribute('y',n.pool?n.y-2:n.y+Math.max(10,Math.min(n.r*0.45,24))*0.36);}
    if(n.t2){n.t2.setAttribute('x',n.x);n.t2.setAttribute('y',n.y+n.r*0.26+8);}
  });
  hubs.forEach(function(H){
    H.el.setAttribute('cx',H.x);H.el.setAttribute('cy',H.y);
    var R=0;H.members.forEach(function(m){R=Math.max(R,Math.hypot(m.x-H.x,m.y-H.y)+m.r);});
    H.ring.setAttribute('cx',H.x);H.ring.setAttribute('cy',H.y);H.ring.setAttribute('r',R+12);
  });
  links.forEach(function(L){
    var dx=L.m.x-L.h.x,dy=L.m.y-L.h.y,d=Math.hypot(dx,dy)||1,ux=dx/d,uy=dy/d;
    L.el.setAttribute('x1',L.h.x+ux*(L.h.r+2));L.el.setAttribute('y1',L.h.y+uy*(L.h.r+2));
    L.el.setAttribute('x2',L.m.x-ux*(L.m.r+3));L.el.setAttribute('y2',L.m.y-uy*(L.m.r+3));
  });
}
function fit(){
  var x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
  all.forEach(function(n){x0=Math.min(x0,n.x-n.r);x1=Math.max(x1,n.x+n.r);y0=Math.min(y0,n.y-n.r);y1=Math.max(y1,n.y+n.r);});
  hubs.forEach(function(H){var R=0;H.members.forEach(function(m){R=Math.max(R,Math.hypot(m.x-H.x,m.y-H.y)+m.r);});x0=Math.min(x0,H.x-R-12);x1=Math.max(x1,H.x+R+12);y0=Math.min(y0,H.y-R-12);y1=Math.max(y1,H.y+R+12);});
  var pad=16;svg.setAttribute('viewBox',(x0-pad)+' '+(y0-pad)+' '+(x1-x0+2*pad)+' '+(y1-y0+2*pad));vc={x:(x0+x1)/2,y:(y0+y1)/2};
}

/* ---------- info card ---------- */
function select(n){
  if(selEl)selEl.classList.remove('sel');selEl=n.el;n.el.classList.add('sel');
  if(n.hub){selectHub(n);return;}
  var b=n;
  if(b.pool){info.innerHTML='<div class="hd"><span class="big">'+fmt(b.pct)+'%</span><span class="pill">'+esc(data.poolLabel)+'</span></div><code>Not a holder: this is where the token trades.</code>';return;}
  var tags=[];if(b.kind==='dev')tags.push('Dev');if(b.kind==='insider')tags.push('Flagged linked');if(b.group!==null&&b.group!==undefined)tags.push('Linked group');
  var st='<div><b>'+fmt(b.pct)+'%</b><span>Of supply</span></div>';
  if(data.supply)st+='<div><b>'+abbr(b.pct/100*data.supply)+'</b><span>Amount</span></div>';
  if(data.mcapUsd)st+='<div><b>$'+abbr(b.pct/100*data.mcapUsd)+'</b><span>Value</span></div>';
  var g=b.group!==null&&b.group!==undefined?data.groups[b.group]:null;
  info.innerHTML='<div class="hd"><span class="big">'+esc(short(b.owner))+'</span><span class="pill">#'+b.rank+'</span>'+tags.map(function(t){return '<span class="pill">'+t+'</span>';}).join('')+'</div>'+
    '<div class="stats">'+st+'</div>'+
    (g?'<div class="clu">Cluster supply: <b>'+fmt(g.pct)+'%</b> · '+g.count+' wallets funded by '+esc(short(g.funder))+'</div>':'')+
    '<code>'+esc(b.owner)+'</code>'+
    '<div class="row"><button class="btn pri" id="cp">Copy address</button><a class="btn" id="sl" href="https://solscan.io/account/'+esc(b.owner)+'">Solscan</a>'+
    (b.funder?'<button class="btn" id="cf">Copy funder '+esc(short(b.funder))+'</button>':'')+'</div>';
  document.getElementById('cp').onclick=function(){copy(b.owner,this);};
  document.getElementById('sl').onclick=function(e){e.preventDefault();openLink(this.href);};
  if(b.funder)document.getElementById('cf').onclick=function(){copy(b.funder,this);};
}
function selectHub(H){
  var g=data.groups[H.g];if(!g)return;
  info.innerHTML='<div class="hd"><span class="big">'+esc(short(g.funder))+'</span><span class="pill">Funder</span></div>'+
    '<div class="stats"><div><b>'+g.count+'</b><span>Wallets</span></div><div><b>'+fmt(g.pct)+'%</b><span>Of supply</span></div>'+(data.mcapUsd?'<div><b>$'+abbr(g.pct/100*data.mcapUsd)+'</b><span>Value</span></div>':'')+'</div>'+
    '<code>'+esc(g.funder)+'</code><div class="row"><button class="btn pri" id="cp">Copy funder</button><a class="btn" id="sl" href="https://solscan.io/account/'+esc(g.funder)+'">Solscan</a></div>';
  document.getElementById('cp').onclick=function(){copy(g.funder,this);};
  document.getElementById('sl').onclick=function(e){e.preventDefault();openLink(this.href);};
}
function focusNode(n){k=2;tx=vc.x-n.x*k;ty=vc.y-n.y*k;apply();select(n);}

/* ---------- address list ---------- */
var sheet=document.getElementById('sheet'),listEl=document.getElementById('list'),q=document.getElementById('q');
function fillList(){
  var f=q.value.trim().toLowerCase();
  var rows=nodes.filter(function(n){return !n.pool&&(!f||n.owner.toLowerCase().indexOf(f)>=0);}).sort(function(a,b){return a.rank-b.rank;});
  listEl.innerHTML='';
  rows.forEach(function(n){
    var d=document.createElement('div');d.className='li';
    d.innerHTML='<i style="background:'+colour(n)+'"></i><span class="rk">#'+n.rank+'</span><span class="ad">'+esc(short(n.owner))+'</span><span class="pc">'+fmt(n.pct)+'%</span>';
    d.onclick=function(){sheet.classList.remove('open');focusNode(n);};
    listEl.appendChild(d);
  });
  if(!rows.length)listEl.innerHTML='<div style="color:var(--mut);padding:16px">No match.</div>';
}
document.getElementById('al').onclick=function(){fillList();sheet.classList.add('open');};
document.getElementById('sx').onclick=function(){sheet.classList.remove('open');};
q.addEventListener('input',fillList);

/* ---------- start ---------- */
function render(d){
  data=d;layout(d);draw(d);redraw();fit();
  document.getElementById('title').textContent=(d.symbol?'$'+d.symbol:'Bubblemap')+(d.name?' · '+d.name:'');
  var chips=['<span class="chip">Top '+d.wallets+' hold <b>'+fmt(d.topPct)+'%</b></span>'];
  if(d.poolPct>0.05)chips.push('<span class="chip">'+esc(d.poolLabel)+' <b>'+fmt(d.poolPct)+'%</b></span>');
  if(d.groups.length)chips.push('<span class="chip"><b>'+d.groups.length+'</b> linked group'+(d.groups.length>1?'s':'')+'</span>');
  else if(d.checked>0)chips.push('<span class="chip">No shared funders found</span>');
  document.getElementById('sub').innerHTML=chips.join('');
  var items=[['Wallet',C.holder],['Linked group',GROUPS[0]],['Dev',C.dev],['Flagged',C.insider],[d.poolLabel,d.poolLabel==='Bonding curve'?C.curve:C.lp]];
  document.getElementById('legend').innerHTML=items.map(function(i){return '<span><i style="background:'+i[1]+'"></i>'+i[0]+'</span>';}).join('')+'<span>Dashed = smaller holders</span>';
}

/* ---------- pan, drag a bubble, pinch, wheel ---------- */
var ptrs={},moved=0,lastD=0,drag=null;
svg.addEventListener('pointerdown',function(e){
  ptrs[e.pointerId]={x:e.clientX,y:e.clientY};moved=0;lastD=0;
  drag=Object.keys(ptrs).length===1&&e.target&&e.target.__n?e.target.__n:null;
});
svg.addEventListener('pointermove',function(e){
  var p=ptrs[e.pointerId];if(!p)return;
  var ids=Object.keys(ptrs),sc=svg.getScreenCTM().a||1;
  if(ids.length===1){
    var dx=e.clientX-p.x,dy=e.clientY-p.y;moved+=Math.abs(dx)+Math.abs(dy);
    if(moved>5){
      if(drag){var m=toSvg(e);drag.x=(m.x-tx)/k;drag.y=(m.y-ty)/k;if(!drag.hub){drag.pin=true;}relax(6,drag);redraw();}
      else{tx+=dx/sc;ty+=dy/sc;apply();}
    }
  }else if(ids.length===2){
    ptrs[e.pointerId]={x:e.clientX,y:e.clientY};
    var a=ptrs[ids[0]],b=ptrs[ids[1]],d=Math.hypot(a.x-b.x,a.y-b.y);moved=10;drag=null;
    if(lastD){var mm=toSvg({clientX:(a.x+b.x)/2,clientY:(a.y+b.y)/2});zoomAt(d/lastD,mm.x,mm.y);}
    lastD=d;return;
  }
  ptrs[e.pointerId]={x:e.clientX,y:e.clientY};
});
function up(e){
  if(drag&&moved<=5)select(drag);
  if(drag){drag.pin=false;}
  drag=null;delete ptrs[e.pointerId];lastD=0;
}
svg.addEventListener('pointerup',up);svg.addEventListener('pointercancel',up);
svg.addEventListener('wheel',function(e){e.preventDefault();var m=toSvg(e);zoomAt(e.deltaY<0?1.15:1/1.15,m.x,m.y);},{passive:false});
document.getElementById('zi').onclick=function(){zoomAt(1.4,vc.x,vc.y);};
document.getElementById('zo').onclick=function(){zoomAt(1/1.4,vc.x,vc.y);};
document.getElementById('zr').onclick=function(){k=1;tx=0;ty=0;apply();};
fetch('/api/map?mint='+encodeURIComponent(mint)).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
 .then(function(d){document.getElementById('msg').remove();render(d);})
 .catch(function(){document.getElementById('msg').textContent='Could not build this map right now. Close and try again in a moment.';});
})();
</script></body></html>`;
