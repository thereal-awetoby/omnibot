// Pure data-shaping for the dashboard Mini App's JSON API, and the page itself. No network, no DB, no Telegram —
// index.js supplies the live data (search results, prices, watchlist rows) and this file turns it into the
// compact JSON the dashboard's own JS expects, plus renders the page.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// searchTokens() result -> dashboard search results.
export function buildDashSearchJson(list) {
  return (list ?? []).map((t) => ({ mint: t.mint, symbol: t.symbol ?? null, name: t.name ?? null, marketCapUsd: num(t.marketCapUsd), liquidityUsd: num(t.liquidityUsd) }));
}

// fetchTrending() result (fetchPairsByTokens-shaped rows) -> dashboard trending list.
export function buildDashTrendingJson(list) {
  return (list ?? []).map((m) => ({
    mint: m.mint, symbol: m.symbol ?? null, name: m.name ?? null,
    priceUsd: num(m.priceUsd), marketCapUsd: num(m.marketCapUsd), change24h: num(m.change?.h24 ?? m.change24h),
  }));
}

// listWatches() rows + prices Map(mint -> market) -> dashboard watchlist.
export function buildDashWatchlistJson(rows, prices) {
  return (rows ?? []).map((r) => {
    const m = prices?.get(r.mint);
    const price = num(m?.priceUsd);
    const basePrice = num(r.added_price_usd);
    const changePct = price && basePrice ? ((price - basePrice) / basePrice) * 100 : null;
    return { mint: r.mint, symbol: r.symbol ?? null, priceUsd: price, addedPriceUsd: basePrice, changePct, alertPct: num(r.alert_pct) };
  });
}

// cachedCard()-shaped { market, security, intel } -> the compact token view the dashboard shows.
export function buildDashTokenJson(mint, { market, security, intel } = {}) {
  if (!market) return { mint, found: false };
  return {
    mint, found: true,
    symbol: market.symbol ?? null, name: market.name ?? null,
    priceUsd: num(market.priceUsd), marketCapUsd: num(market.marketCapUsd), liquidityUsd: num(market.liquidityUsd),
    volume24h: num(market.volume?.h24 ?? market.volume24h), change24h: num(market.change?.h24 ?? market.change24h),
    dex: market.dex ?? null,
    security: security ? { mintAuthority: Boolean(security.mintAuthority), freezeAuthority: Boolean(security.freezeAuthority) } : null,
    devPct: num(intel?.devPct), lpLockedPct: num(intel?.lpLockedPct),
    top10Pct: num(intel?.top10Pct), holdersTotal: num(intel?.holdersTotal),
    insiderNetworks: num(intel?.insiderNetworks) ?? 0, insiderWallets: num(intel?.insiderWallets) ?? 0,
    launchCount: num(intel?.launchCount),
    curve: intel?.curve ? { complete: Boolean(intel.curve.complete), progressPct: num(intel.curve.progressPct) } : null,
  };
}

export const DASH_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Omni Scan</title>
<script src="https://telegram.org/js/telegram-web-app.js" onerror="void 0"></script>
<style>
:root{--bg:#06080d;--fg:#eef2fb;--mut:#8493ad;--card:#0f1625;--line:#1b2640;--acc:#4f8cff;--up:#26de81;--down:#ff5d5d}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
body{display:flex;flex-direction:column}
#head{padding:14px 16px 8px;font-size:20px;font-weight:700}
#search{margin:0 16px 10px;display:flex;gap:8px}
#q{flex:1;background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:10px 12px;font-size:14px;outline:none}
#view{flex:1;overflow:auto;padding:0 16px 80px}
.row{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.row .sym{font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .mc{color:var(--mut);font-size:12px}
.chg{font-weight:700;font-size:13px}
.up{color:var(--up)}.down{color:var(--down)}
.empty{color:var(--mut);text-align:center;padding:40px 10px}
#tabs{position:fixed;left:0;right:0;bottom:0;display:flex;background:#0b1326;border-top:1px solid var(--line);padding:6px 6px calc(6px + env(safe-area-inset-bottom))}
#tabs button{flex:1;background:none;border:none;color:var(--mut);padding:10px 4px;font-size:12px;border-radius:10px}
#tabs button.on{color:var(--fg);background:#ffffff0d}
#tok{display:none}
#tok .big{font-size:24px;font-weight:700}
#tok .price{font-size:28px;font-weight:800;margin:4px 0}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:14px 0}
.stats div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;text-align:center}
.stats b{display:block;font-size:15px}.stats span{font-size:11px;color:var(--mut)}
.fact{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
.btn{display:block;width:100%;text-align:center;border:1px solid var(--line);background:#1a2a4d;color:var(--fg);padding:12px;border-radius:10px;font-size:14px;text-decoration:none;cursor:pointer;margin-top:10px}
.btn.pri{background:var(--acc);border-color:var(--acc);font-weight:700}
#back{background:none;border:none;color:var(--acc);font-size:14px;padding:4px 0 10px;cursor:pointer}
</style></head><body>
<div id="head">⭐ Omni Scan</div>
<div id="search"><input id="q" placeholder="Search token or paste address"></div>
<div id="view">
  <div id="list"></div>
  <div id="tok">
    <button id="back">‹ Back</button>
    <div class="big" id="t-name"></div>
    <div class="price" id="t-price"></div>
    <div class="stats" id="t-stats"></div>
    <div id="t-facts"></div>
    <button class="btn pri" id="t-watch"></button>
    <a class="btn" id="t-map" href="#">🫧 Bubblemap</a>
  </div>
</div>
<div id="tabs"><button id="tab-home" class="on">🔥 Home</button><button id="tab-watch">⭐ Watchlist</button></div>
<script>
(function(){
var tg=window.Telegram&&window.Telegram.WebApp; if(tg){try{tg.ready();tg.expand();}catch(e){}}
var initData=(tg&&tg.initData)||'';
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function abbr(n){if(n==null)return 'n/a';var a=Math.abs(n);if(a>=1e9)return '$'+(n/1e9).toFixed(2)+'B';if(a>=1e6)return '$'+(n/1e6).toFixed(2)+'M';if(a>=1e3)return '$'+(n/1e3).toFixed(2)+'K';return '$'+n.toFixed(2);}
function price(p){if(p==null)return 'n/a';if(p>=1)return '$'+p.toFixed(2);if(p>=0.01)return '$'+p.toFixed(4);return '$'+p.toPrecision(3);}
function chg(n){if(n==null)return '';return '<span class="chg '+(n>=0?'up':'down')+'">'+(n>=0?'+':'')+n.toFixed(1)+'%</span>';}
function api(path,opts){
  opts=opts||{};opts.headers=opts.headers||{};opts.headers['X-Init-Data']=initData;
  return fetch(path,opts).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'request failed');return j;});});
}
var list=document.getElementById('list'),tokView=document.getElementById('tok'),qEl=document.getElementById('q');
var tabHome=document.getElementById('tab-home'),tabWatch=document.getElementById('tab-watch');
var mode='home';
function rowHtml(r,onClick){
  var d=document.createElement('div');d.className='row';
  d.innerHTML='<span class="sym">'+(r.symbol?'$'+esc(r.symbol):r.mint.slice(0,4)+'…'+r.mint.slice(-4))+'<div class="mc">'+(r.marketCapUsd!=null?abbr(r.marketCapUsd):price(r.priceUsd))+'</div></span>'+(r.change24h!=null?chg(r.change24h):r.changePct!=null?chg(r.changePct):'');
  d.onclick=onClick;
  return d;
}
function loadHome(){
  list.innerHTML='<div class="empty">Loading…</div>';
  api('/api/dash/trending').then(function(j){
    list.innerHTML='';
    if(!j.results.length){list.innerHTML='<div class="empty">Nothing trending right now.</div>';return;}
    j.results.forEach(function(r){list.appendChild(rowHtml(r,function(){openToken(r.mint);}));});
  }).catch(function(){list.innerHTML='<div class="empty">Could not load trending tokens.</div>';});
}
function loadWatch(){
  list.innerHTML='<div class="empty">Loading…</div>';
  api('/api/dash/watchlist').then(function(j){
    list.innerHTML='';
    if(!j.results.length){list.innerHTML='<div class="empty">Your watchlist is empty.<br>Search a token and tap Watch.</div>';return;}
    j.results.forEach(function(r){list.appendChild(rowHtml(r,function(){openToken(r.mint);}));});
  }).catch(function(e){list.innerHTML='<div class="empty">'+(String(e.message).indexOf('sign')>=0?'Open this from inside Telegram to see your watchlist.':'Could not load your watchlist.')+'</div>';});
}
function doSearch(q){
  if(!q){mode==='watch'?loadWatch():loadHome();return;}
  list.innerHTML='<div class="empty">Searching…</div>';
  api('/api/dash/search?q='+encodeURIComponent(q)).then(function(j){
    list.innerHTML='';
    if(!j.results.length){list.innerHTML='<div class="empty">No tokens found.</div>';return;}
    j.results.forEach(function(r){list.appendChild(rowHtml(r,function(){openToken(r.mint);}));});
  }).catch(function(){list.innerHTML='<div class="empty">Search is not working right now.</div>';});
}
var qTimer=null;
qEl.addEventListener('input',function(){clearTimeout(qTimer);var v=qEl.value.trim();qTimer=setTimeout(function(){doSearch(v);},300);});
tabHome.onclick=function(){mode='home';tabHome.className='on';tabWatch.className='';qEl.value='';tokView.style.display='none';list.style.display='block';loadHome();};
tabWatch.onclick=function(){mode='watch';tabWatch.className='on';tabHome.className='';qEl.value='';tokView.style.display='none';list.style.display='block';loadWatch();};
document.getElementById('back').onclick=function(){tokView.style.display='none';list.style.display='block';};
var curMint=null,curWatching=false;
function openToken(mint){
  curMint=mint;
  list.style.display='none';tokView.style.display='block';
  document.getElementById('t-name').textContent='Loading…';
  document.getElementById('t-price').textContent='';
  document.getElementById('t-stats').innerHTML='';
  document.getElementById('t-facts').innerHTML='';
  document.getElementById('t-map').href='/map?mint='+encodeURIComponent(mint);
  api('/api/dash/token?mint='+encodeURIComponent(mint)).then(function(t){
    if(!t.found){document.getElementById('t-name').textContent='No market data yet.';return;}
    document.getElementById('t-name').textContent=(t.symbol?'$'+t.symbol:mint.slice(0,4)+'…'+mint.slice(-4))+(t.name?' · '+t.name:'');
    document.getElementById('t-price').innerHTML=price(t.priceUsd)+' '+(t.change24h!=null?chg(t.change24h):'');
    document.getElementById('t-stats').innerHTML=
      '<div><b>'+abbr(t.marketCapUsd)+'</b><span>Market cap</span></div>'+
      '<div><b>'+abbr(t.liquidityUsd)+'</b><span>Liquidity</span></div>'+
      '<div><b>'+(t.holdersTotal!=null?t.holdersTotal.toLocaleString():'n/a')+'</b><span>Holders</span></div>'+
      '<div><b>'+(t.top10Pct!=null?t.top10Pct.toFixed(1)+'%':'n/a')+'</b><span>Top 10 hold</span></div>';
    var facts=[];
    if(t.devPct!=null)facts.push(['Dev holds',t.devPct.toFixed(1)+'%'+(t.launchCount>1?' · '+t.launchCount+' launches':'')]);
    if(t.lpLockedPct!=null)facts.push(['LP locked/burned',t.lpLockedPct.toFixed(0)+'%']);
    if(t.curve)facts.push(['Bonding curve',t.curve.complete?'graduated':Math.round(t.curve.progressPct)+'% filled']);
    if(t.insiderNetworks>0)facts.push(['Insider networks',t.insiderNetworks+' · '+t.insiderWallets+' wallets']);
    if(t.security)facts.push(['Authorities','Mint '+(t.security.mintAuthority?'active ⚠️':'off ✅')+' · Freeze '+(t.security.freezeAuthority?'active ⚠️':'off ✅')]);
    document.getElementById('t-facts').innerHTML=facts.map(function(f){return '<div class="fact"><span>'+f[0]+'</span><b>'+f[1]+'</b></div>';}).join('');
    refreshWatchButton();
  }).catch(function(){document.getElementById('t-name').textContent='Could not load this token.';});
}
function refreshWatchButton(){
  var btn=document.getElementById('t-watch');
  api('/api/dash/watchlist').then(function(j){
    curWatching=j.results.some(function(r){return r.mint===curMint;});
    btn.textContent=curWatching?'✖ Remove from watchlist':'⭐ Add to watchlist';
  }).catch(function(){btn.textContent='⭐ Add to watchlist';curWatching=false;});
}
document.getElementById('t-watch').onclick=function(){
  if(!curMint)return;
  var action=curWatching?'/api/dash/unwatch':'/api/dash/watch';
  api(action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mint:curMint})})
    .then(function(){curWatching=!curWatching;document.getElementById('t-watch').textContent=curWatching?'✖ Remove from watchlist':'⭐ Add to watchlist';})
    .catch(function(e){alert(String(e.message||'Could not update your watchlist. Open this from inside Telegram.'));});
};
loadHome();
})();
</script></body></html>`;
