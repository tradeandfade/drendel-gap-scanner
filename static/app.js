const API={alerts:'/api/alerts',zones:'/api/zones',status:'/api/status',settings:'/api/settings',watchlist:'/api/watchlist',setup:'/api/setup',reinit:'/api/reinitialize'};
let state={activeTab:'scanner',alerts:{support:[],resistance:[],untested:[]},zones:[],status:{},settings:{},refreshTimer:null,zoneSortCol:'distance_pct',zoneSortDir:'asc',zoneFilter:'all',alertFeed:[],previousAlertKeys:new Set(),chart:null,chartSymbol:null,chartTf:'1Day'};
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
let _isLoggingOut=false,_hasRedirected=false;
const _origFetch=window.fetch;
async function doLogout(){_isLoggingOut=true;stopAutoRefresh();const o=document.createElement('div');o.innerHTML='<div style="text-align:center"><div style="width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--olive);color:#000;font-weight:700;font-size:16px;margin:0 auto 12px">G</div><div style="font-size:12px;color:var(--text-2);margin-bottom:14px">Logging out...</div><div style="width:160px;height:2px;background:var(--border-1);border-radius:1px;overflow:hidden;margin:0 auto"><div id="logout-bar" style="height:100%;width:0%;background:var(--olive);transition:width 1s cubic-bezier(.4,0,.2,1)"></div></div></div>';o.style.cssText='position:fixed;inset:0;z-index:600;background:var(--bg-0);display:flex;align-items:center;justify-content:center';document.body.appendChild(o);requestAnimationFrame(()=>requestAnimationFrame(()=>{const b=document.getElementById('logout-bar');if(b)b.style.width='100%'}));try{await _origFetch('/api/auth/logout',{method:'POST'})}catch(e){}await sleep(1100);window.location.replace('/login')}
window.fetch=async function(...a){if(_isLoggingOut||_hasRedirected)return new Response('{}',{status:0});const r=await _origFetch.apply(this,a);if(r.status===401&&!_hasRedirected&&a[0]&&typeof a[0]==='string'&&a[0].startsWith('/api/')&&!a[0].includes('/auth/')){_hasRedirected=true;_isLoggingOut=true;stopAutoRefresh();await sleep(200);window.location.replace('/login')}return r};

document.addEventListener('DOMContentLoaded',async()=>{try{const r=await _origFetch('/api/auth/status');const d=await r.json();if(!d.authenticated){window.location.replace('/login');return}}catch(e){}setupTabs();await initLoad()});
async function initLoad(){const ov=document.getElementById('init-overlay'),st=document.getElementById('init-status-text'),dt=document.getElementById('init-detail'),pb=document.getElementById('init-progress-bar');if(!ov){await normalInit();return}pb.classList.add('indeterminate');st.textContent='Loading...';let att=0;while(att<180){if(_isLoggingOut||_hasRedirected)return;try{const r=await _origFetch(API.status);if(r.status===401){_hasRedirected=true;window.location.replace('/login');return}state.status=await r.json();const s=state.status;if(s.initialized){pb.classList.remove('indeterminate');pb.style.width='100%';st.textContent='Ready';dt.textContent=s.zone_count?`${s.symbol_count} sym · ${s.zone_count} zones`:`${s.symbol_count} symbols`;await sleep(250);await loadSettings();await loadAlerts();renderStatus();startAutoRefresh();ov.classList.add('hidden');return}else if(s.error&&!s.running){st.textContent='Setup needed';dt.textContent=s.error;await sleep(500);await loadSettings();renderStatus();switchTab('setup');ov.classList.add('hidden');return}else{st.textContent='Loading...';dt.textContent=s.symbol_count?`${s.symbol_count} symbols`:'Connecting...';if(s.symbol_count){pb.classList.remove('indeterminate');pb.style.width='50%'}}}catch(e){st.textContent='Connecting...'}att++;await sleep(1000)}await normalInit();ov.classList.add('hidden')}
async function normalInit(){await loadStatus();await loadSettings();if(!state.status.initialized)switchTab('setup');else{switchTab('scanner');await loadAlerts();startAutoRefresh()}}
function setupTabs(){document.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)))}
function switchTab(t){state.activeTab=t;document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===t));document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active',c.id==='tab-'+t));if(t==='zones')loadZones();if(t==='settings')renderSettings()}
async function loadAlerts(){try{const r=await fetch(API.alerts);state.alerts=await r.json();renderAlerts();updateAlertFeed();updateAlertCounts()}catch(e){}}
async function loadZones(){try{const r=await fetch(API.zones);state.zones=await r.json();renderZoneTable()}catch(e){}}
async function loadStatus(){try{const r=await fetch(API.status);state.status=await r.json();renderStatus()}catch(e){}}
async function loadSettings(){try{const r=await fetch(API.settings);state.settings=await r.json()}catch(e){}}
function startAutoRefresh(){stopAutoRefresh();const ms=Math.max((state.settings.scan_interval_seconds||300)*1000,10000);state.refreshTimer=setInterval(async()=>{await loadAlerts();await loadStatus();if(state.activeTab==='zones')await loadZones()},ms)}
function stopAutoRefresh(){if(state.refreshTimer){clearInterval(state.refreshTimer);state.refreshTimer=null}}
function renderStatus(){const s=state.status,d=document.getElementById('status-dot'),t=document.getElementById('status-text');if(!d||!t)return;if(s.error){d.className='status-dot error';t.textContent='Err'}else if(s.running){d.className='status-dot active';t.textContent=s.last_scan||'On'}else if(s.initialized){d.className='status-dot';t.textContent='Idle'}else{d.className='status-dot';t.textContent='—'}const sc=document.getElementById('symbol-count'),zc=document.getElementById('zone-count');if(sc)sc.textContent=s.symbol_count||0;if(zc)zc.textContent=s.zone_count||0;const lst=document.getElementById('last-scan-time');if(lst)lst.textContent=s.last_scan||'—';const lbt=document.getElementById('last-build-time');if(lbt)lbt.textContent=s.last_eod_update||s.last_scan||'—'}
function updateAlertCounts(){const a=state.alerts,n=(a.support?.length||0)+(a.resistance?.length||0)+(a.untested?.length||0);const e=document.querySelector('[data-tab="scanner"] .tab-count');if(e)e.textContent=n}

function renderAlerts(){renderSec('support',state.alerts.support||[],'S','Support');renderSec('resistance',state.alerts.resistance||[],'R','Resistance');renderSec('untested',state.alerts.untested||[],'U','Untested')}
function renderSec(type,alerts,icon,title){const c=document.getElementById('alerts-'+type);if(!c)return;const h='<div class="section-header '+type+'"><div class="section-icon '+type+'">'+icon+'</div><div class="section-title">'+title+'</div><div class="section-count">'+alerts.length+'</div></div>';if(!alerts.length){c.innerHTML=h+'<div class="empty-state"><div class="empty-state-text">No '+type+' alerts.</div></div>';return}c.innerHTML=h+'<div class="alert-grid">'+alerts.map(a=>card(a,type)).join('')+'</div>'}

function card(a,type){
  const z=a.zone,sz=z.zone_top-z.zone_bottom;
  let mk=50;if(sz>0)mk=((z.zone_top-a.current_price)/sz)*100;
  mk=Math.max(0,Math.min(100,mk));
  let fs;if(type==='support')fs='top:0;height:'+mk+'%';else if(type==='resistance')fs='bottom:0;height:'+(100-mk)+'%';else fs='top:0;height:'+mk+'%';
  const badges=[];
  if(a.is_first_test)badges.push('<span class="card-badge">1st</span>');
  if(a.multi_zone)badges.push('<span class="card-badge multi">'+a.same_side_count+'x</span>');
  return '<div class="alert-card '+type+'" onclick="openChart(\''+a.symbol+'\')"><div class="card-info"><div class="card-symbol">'+a.symbol+'</div><div class="card-price">$'+a.current_price.toFixed(2)+'</div>'+badges.join('')+'</div><div class="card-meter-wrap"><span class="meter-label top">$'+z.zone_top.toFixed(2)+'</span><div class="v-meter"><div class="v-meter-fill" style="'+fs+'"></div><div class="v-meter-marker" style="top:'+mk+'%"></div></div><span class="meter-label bot">$'+z.zone_bottom.toFixed(2)+'</span></div></div>'
}

function updateAlertFeed(){const all=[];for(const t of['support','resistance','untested'])for(const a of(state.alerts[t]||[])){if(a.already_fired)continue;const k=a.symbol+'_'+t+'_'+a.zone.zone_bottom+'_'+a.zone.zone_top;all.push(Object.assign({},a,{feedType:t,key:k,isNew:!state.previousAlertKeys.has(k)}))}const cur=new Set(all.map(a=>a.key));const nw=all.filter(a=>a.isNew);if(nw.length)state.alertFeed=[].concat(nw.map(a=>Object.assign({},a,{feedTime:new Date()})),state.alertFeed).slice(0,200);state.previousAlertKeys=cur;renderFeed()}
function renderFeed(){const c=document.getElementById('alert-feed'),cn=document.getElementById('feed-count');if(!c)return;if(cn)cn.textContent=state.alertFeed.length;if(!state.alertFeed.length){c.innerHTML='<div class="empty-state"><div class="empty-state-text">No alerts yet.</div></div>';return}c.innerHTML=state.alertFeed.map(function(a){const t=a.feedTime?new Date(a.feedTime):new Date();const ts=t.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true});return'<div class="feed-item '+a.feedType+(a.isNew?' new-alert':'')+'" onclick="openChart(\''+a.symbol+'\')"><span class="feed-sym">'+a.symbol+'</span><span class="feed-price">$'+a.current_price.toFixed(2)+'</span><span class="feed-time">'+ts+'</span></div>'}).join('')}

/* ===== CHART ===== */
var TFS=[{v:'1Min',l:'1m'},{v:'5Min',l:'5m'},{v:'15Min',l:'15m'},{v:'30Min',l:'30m'},{v:'1Hour',l:'1H'},{v:'4Hour',l:'4H'},{v:'1Day',l:'D'},{v:'1Week',l:'W'}];

async function openChart(sym,tf){
  tf=tf||state.chartTf||'1Day';
  state.chartSymbol=sym;state.chartTf=tf;
  document.getElementById('chart-modal').style.display='flex';
  document.getElementById('chart-symbol').textContent=sym;
  document.getElementById('chart-tf-bar').innerHTML=TFS.map(function(o){return'<button class="tf-btn'+(o.v===tf?' active':'')+'" onclick="openChart(\''+sym+'\',\''+o.v+'\')">'+o.l+'</button>'}).join('');
  var c=document.getElementById('chart-container');
  c.innerHTML='<div class="loading-overlay"><div class="loading-spinner"></div></div>';
  if(state.chart){try{state.chart.remove()}catch(e){}state.chart=null}
  try{
    var r=await fetch('/api/chart/'+sym+'?tf='+tf);
    if(!r.ok){c.innerHTML='<div class="empty-state"><div class="empty-state-text">No data.</div></div>';return}
    var d=await r.json();
    c.innerHTML='';
    var w=c.offsetWidth,h=c.offsetHeight;
    var isIntra=['1Min','5Min','15Min','30Min','1Hour','4Hour'].indexOf(tf)>=0;

    // Split height: 75% price, 25% volume
    var priceH=Math.floor(h*0.78);
    var volH=h-priceH;

    // Create price chart container and volume chart container
    var priceDiv=document.createElement('div');priceDiv.style.cssText='width:100%;height:'+priceH+'px;position:relative;';
    var volDiv=document.createElement('div');volDiv.style.cssText='width:100%;height:'+volH+'px;border-top:1px solid #1e1e1e;';
    c.appendChild(priceDiv);c.appendChild(volDiv);

    // OHLCV legend overlay
    var legend=document.createElement('div');
    legend.id='chart-legend';
    legend.style.cssText='position:absolute;top:4px;left:8px;z-index:10;font-family:DM Mono,monospace;font-size:10px;color:#888;pointer-events:none;';
    priceDiv.appendChild(legend);

    // === PRICE CHART ===
    var chart=LightweightCharts.createChart(priceDiv,{
      width:w,height:priceH,
      layout:{background:{type:'solid',color:'#0a0a0a'},textColor:'#555'},
      grid:{vertLines:{color:'#141414'},horzLines:{color:'#141414'}},
      crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
      timeScale:{borderColor:'#1a1a1a',timeVisible:isIntra,secondsVisible:false},
      rightPriceScale:{borderColor:'#1a1a1a',scaleMargins:{top:0.05,bottom:0.05}},
    });
    state.chart=chart;

    var cs=chart.addCandlestickSeries({
      upColor:'#5a9a4c',downColor:'#b45040',
      borderUpColor:'#5a9a4c',borderDownColor:'#b45040',
      wickUpColor:'#cccccc',wickDownColor:'#cccccc',
    });
    var bars=d.bars.map(function(b){return{time:b.date,open:b.open,high:b.high,low:b.low,close:b.close}});
    cs.setData(bars);

    // === VOLUME CHART (separate pane) ===
    var volChart=LightweightCharts.createChart(volDiv,{
      width:w,height:volH,
      layout:{background:{type:'solid',color:'#0a0a0a'},textColor:'#444'},
      grid:{vertLines:{color:'#141414'},horzLines:{color:'#141414'}},
      crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
      timeScale:{visible:false},
      rightPriceScale:{borderColor:'#1a1a1a'},
    });
    state.volChart=volChart;
    var volSeries=volChart.addHistogramSeries({priceFormat:{type:'volume'}});
    volSeries.setData(d.bars.map(function(b){
      return{time:b.date,value:b.vol||0,color:b.close>=b.open?'rgba(90,154,76,0.4)':'rgba(180,80,64,0.4)'}
    }));

    // Sync time scales
    chart.timeScale().subscribeVisibleLogicalRangeChange(function(range){
      if(range)try{volChart.timeScale().setVisibleLogicalRange(range)}catch(e){}
    });
    volChart.timeScale().subscribeVisibleLogicalRangeChange(function(range){
      if(range)try{chart.timeScale().setVisibleLogicalRange(range)}catch(e){}
    });

    // === OHLCV CROSSHAIR LEGEND ===
    chart.subscribeCrosshairMove(function(param){
      if(!param||!param.time){legend.innerHTML='';return}
      var bar=null;
      for(var bi=0;bi<d.bars.length;bi++){if(d.bars[bi].date===param.time||d.bars[bi].date==param.time){bar=d.bars[bi];break}}
      if(!bar){legend.innerHTML='';return}
      var clr=bar.close>=bar.open?'#5a9a4c':'#b45040';
      var vol=bar.vol||0;var volStr=vol>=1e6?(vol/1e6).toFixed(1)+'M':vol>=1e3?(vol/1e3).toFixed(0)+'K':vol.toString();
      legend.innerHTML='<span style="color:#888">O</span> <span style="color:'+clr+'">'+bar.open.toFixed(2)+'</span> <span style="color:#888">H</span> <span style="color:'+clr+'">'+bar.high.toFixed(2)+'</span> <span style="color:#888">L</span> <span style="color:'+clr+'">'+bar.low.toFixed(2)+'</span> <span style="color:#888">C</span> <span style="color:'+clr+'">'+bar.close.toFixed(2)+'</span> <span style="color:#888">V</span> <span style="color:#666">'+volStr+'</span>';
    });

    // === ZONE OVERLAYS (on main price scale so they align with candles) ===
    if(d.zones&&d.zones.length>0&&bars.length>0){
      for(var zi=0;zi<d.zones.length;zi++){
        var z=d.zones[zi];
        var lineClr,fillClr;
        if(z.is_untested){lineClr='rgba(230,160,40,0.9)';fillClr='rgba(230,160,40,0.15)'}
        else if(z.base_type==='support'){lineClr='rgba(80,180,60,0.9)';fillClr='rgba(80,180,60,0.15)'}
        else{lineClr='rgba(210,60,50,0.9)';fillClr='rgba(210,60,50,0.15)'}

        var si=0;
        for(var i=0;i<bars.length;i++){if(bars[i].time>=z.created_date){si=i;break}}
        var pts=bars.slice(si);
        if(pts.length<2)continue;

        try{
          // Baseline series on DEFAULT scale — fills between zone_top line and zone_bottom baseline
          var bs=chart.addBaselineSeries({
            baseValue:{type:'price',price:z.zone_bottom},
            topLineColor:lineClr,
            bottomLineColor:lineClr,
            topFillColor1:fillClr,
            topFillColor2:fillClr,
            bottomFillColor1:'transparent',
            bottomFillColor2:'transparent',
            lineWidth:1,
            priceLineVisible:false,
            lastValueVisible:false,
            crosshairMarkerVisible:false,
          });
          bs.setData(pts.map(function(p){return{time:p.time,value:z.zone_top}}));
          // Bottom border line on default scale
          var btmLine=chart.addLineSeries({color:lineClr,lineWidth:1,lineStyle:0,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
          btmLine.setData(pts.map(function(p){return{time:p.time,value:z.zone_bottom}}));
        }catch(e){
          // Fallback: just two lines on default scale
          var tl=chart.addLineSeries({color:lineClr,lineWidth:1,lineStyle:0,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
          tl.setData(pts.map(function(p){return{time:p.time,value:z.zone_top}}));
          var bl=chart.addLineSeries({color:lineClr,lineWidth:1,lineStyle:0,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
          bl.setData(pts.map(function(p){return{time:p.time,value:z.zone_bottom}}));
        }
      }
    }

    // === MOVING AVERAGES ===
    var s=state.settings;
    var closes=d.bars.map(function(b){return b.close});
    var maList=[
      {p:10,t:(s.chart&&s.chart.ma10_type)||'sma',c:(s.chart&&s.chart.ma10_color)||'#f59e0b'},
      {p:20,t:(s.chart&&s.chart.ma20_type)||'sma',c:(s.chart&&s.chart.ma20_color)||'#3b82f6'},
      {p:50,t:(s.chart&&s.chart.ma50_type)||'sma',c:(s.chart&&s.chart.ma50_color)||'#a855f7'},
      {p:200,t:(s.chart&&s.chart.ma200_type)||'sma',c:(s.chart&&s.chart.ma200_color)||'#ef4444'},
    ];
    for(var mi=0;mi<maList.length;mi++){
      var ma=maList[mi];
      var vals=ma.t==='ema'?calcEMA(closes,ma.p):calcSMA(closes,ma.p);
      var ld=[];
      for(var vi=0;vi<vals.length;vi++){
        if(vals[vi]!==null)ld.push({time:d.bars[vi].date,value:vals[vi]});
      }
      if(ld.length>0){
        var ml=chart.addLineSeries({color:ma.c,lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
        ml.setData(ld);
      }
    }

    // === AUTO ZOOM ===
    if(tf==='1Day'&&bars.length>252){
      chart.timeScale().setVisibleRange({from:bars[bars.length-252].time,to:bars[bars.length-1].time});
    }else{
      chart.timeScale().fitContent();
    }

  }catch(e){
    c.innerHTML='<div class="empty-state"><div class="empty-state-text">Chart error.</div></div>';
    console.error('Chart error:',e);
  }
}

function closeChart(){document.getElementById('chart-modal').style.display='none';if(state.chart){try{state.chart.remove()}catch(e){}state.chart=null}if(state.volChart){try{state.volChart.remove()}catch(e){}state.volChart=null}}

function calcSMA(d,p){var r=[];for(var i=0;i<d.length;i++){if(i<p-1){r.push(null);continue}var s=0;for(var j=i-p+1;j<=i;j++)s+=d[j];r.push(Math.round((s/p)*100)/100)}return r}
function calcEMA(d,p){var k=2/(p+1),r=[],e=null;for(var i=0;i<d.length;i++){if(i<p-1){r.push(null);continue}if(e===null){var s=0;for(var j=i-p+1;j<=i;j++)s+=d[j];e=s/p}else{e=d[i]*k+e*(1-k)}r.push(Math.round(e*100)/100)}return r}

/* Zone Table */
function renderZoneTable(){var c=document.getElementById('zone-explorer-content');if(!c)return;var z=state.zones.slice();var sq=(document.getElementById('zone-search')?document.getElementById('zone-search').value:'').toUpperCase();if(sq)z=z.filter(function(x){return x.symbol.indexOf(sq)>=0});if(state.zoneFilter!=='all')z=z.filter(function(x){if(state.zoneFilter==='support')return x.base_type==='support'&&!x.is_untested;if(state.zoneFilter==='resistance')return x.base_type==='resistance'&&!x.is_untested;if(state.zoneFilter==='untested')return x.is_untested;return true});var col=state.zoneSortCol,dir=state.zoneSortDir==='asc'?1:-1;z.sort(function(a,b){var va=a[col],vb=b[col];if(typeof va==='string')return va.localeCompare(vb)*dir;return((va||0)-(vb||0))*dir});var f='<div class="table-filters"><button class="filter-btn '+(state.zoneFilter==='all'?'active':'')+'" onclick="setZoneFilter(\'all\')">All ('+state.zones.length+')</button><button class="filter-btn '+(state.zoneFilter==='support'?'active':'')+'" onclick="setZoneFilter(\'support\')">Sup</button><button class="filter-btn '+(state.zoneFilter==='resistance'?'active':'')+'" onclick="setZoneFilter(\'resistance\')">Res</button><button class="filter-btn '+(state.zoneFilter==='untested'?'active':'')+'" onclick="setZoneFilter(\'untested\')">Unt</button></div>';var cols=[{k:'symbol',l:'Sym'},{k:'gap_type',l:'Type'},{k:'zone_top',l:'Top'},{k:'zone_bottom',l:'Bot'},{k:'zone_size_pct',l:'Size'},{k:'created_date',l:'Date'},{k:'distance_pct',l:'Dist'}];var th=cols.map(function(x){var cl='';if(state.zoneSortCol===x.k)cl=state.zoneSortDir==='asc'?'sorted-asc':'sorted-desc';return'<th class="'+cl+'" onclick="sortZoneTable(\''+x.k+'\')">'+x.l+'</th>'}).join('');var rows=z.map(function(x){var tc=x.is_untested?'untested':x.base_type;return'<tr onclick="openChart(\''+x.symbol+'\')" style="cursor:pointer"><td class="mono" style="font-weight:600;color:var(--text-1)">'+x.symbol+'</td><td><span class="zone-type-pill '+tc+'">'+tc.substring(0,3)+'</span></td><td class="mono">$'+x.zone_top.toFixed(2)+'</td><td class="mono">$'+x.zone_bottom.toFixed(2)+'</td><td class="mono">'+x.zone_size_pct.toFixed(1)+'%</td><td class="mono">'+x.created_date+'</td><td class="mono" style="color:'+((x.distance_pct||0)<=1?'var(--warning)':'inherit')+'">'+((x.distance_pct||0).toFixed(1))+'%</td></tr>'}).join('');c.innerHTML=f+'<div class="zone-table-wrap"><table class="zone-table"><thead><tr>'+th+'</tr></thead><tbody>'+(rows||'<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-4)">No zones.</td></tr>')+'</tbody></table></div>'}
function sortZoneTable(c){if(state.zoneSortCol===c)state.zoneSortDir=state.zoneSortDir==='asc'?'desc':'asc';else{state.zoneSortCol=c;state.zoneSortDir='asc'}renderZoneTable()}
function setZoneFilter(f){state.zoneFilter=f;renderZoneTable()}

/* Settings */
function renderSettings(){
  var s=state.settings;
  sv('setting-interval',s.scan_interval_seconds);sv('setting-lookback',s.lookback_days);sv('setting-max-gaps',s.max_gaps_per_symbol);
  sv('setting-proximity',s.alert_sensitivity?s.alert_sensitivity.proximity_pct:0);
  sv('setting-ma10-type',(s.chart&&s.chart.ma10_type)||'sma');sv('setting-ma20-type',(s.chart&&s.chart.ma20_type)||'sma');sv('setting-ma50-type',(s.chart&&s.chart.ma50_type)||'sma');sv('setting-ma200-type',(s.chart&&s.chart.ma200_type)||'sma');
  var colors=['ma10','ma20','ma50','ma200'];for(var i=0;i<colors.length;i++){var k=colors[i];if(s.chart&&s.chart[k+'_color']){var el=document.getElementById('setting-'+k+'-color');if(el)el.value=s.chart[k+'_color']}}
  // Show API key status
  var akd=document.getElementById('api-key-display');
  if(akd){akd.textContent=s.alpaca_api_key_display||'Not configured';akd.style.color=s.alpaca_api_key_display?'var(--olive-bright)':'var(--text-4)'}
  loadWatchlist();
}
function sv(id,v){var e=document.getElementById(id);if(e&&v!==undefined)e.value=v}
function sc(id,v){var e=document.getElementById(id);if(e)e.checked=!!v}

/* Watchlist — alphabetically sorted */
var wlSymbols=[];
async function loadWatchlist(){try{var r=await fetch(API.watchlist);var d=await r.json();wlSymbols=(d.watchlist||[]).slice().sort();renderWL()}catch(e){}}
function renderWL(){var c=document.getElementById('watchlist-symbols'),cn=document.getElementById('watchlist-count'),q=(document.getElementById('watchlist-search')?document.getElementById('watchlist-search').value:'').toUpperCase();if(!c)return;var sorted=wlSymbols.slice().sort();if(cn)cn.textContent=sorted.length;var f=q?sorted.filter(function(s){return s.indexOf(q)>=0}):sorted;if(!f.length){c.innerHTML='<div class="wl-empty">'+(wlSymbols.length?'No match.':'Empty.')+'</div>';return}c.innerHTML=f.map(function(s){return'<div class="wl-item"><span class="wl-sym">'+s+'</span><button class="wl-remove" onclick="rmSym(\''+s+'\')">✕</button></div>'}).join('')}
function renderWatchlistManager(){renderWL()}
function addSymbol(){var inp=document.getElementById('watchlist-add-input');if(!inp)return;var ss=inp.value.trim().toUpperCase().split(/[\n,\s]+/).filter(function(s){return s&&/^[A-Z.]+$/.test(s)});var n=0;for(var i=0;i<ss.length;i++){if(wlSymbols.indexOf(ss[i])<0){wlSymbols.push(ss[i]);n++}}inp.value='';renderWL();if(n)showToast('+'+n+'. Save to apply.','success');inp.focus()}
function rmSym(s){wlSymbols=wlSymbols.filter(function(x){return x!==s});renderWL()}
function clearWatchlist(){if(!confirm('Clear all?'))return;wlSymbols=[];renderWL()}
function toggleBulkPaste(){var a=document.getElementById('bulk-paste-area');if(a)a.style.display=a.style.display==='none'?'block':'none'}
function addBulkSymbols(){var t=document.getElementById('watchlist-bulk');if(!t)return;var ss=t.value.split(/[\n,\s]+/).map(function(s){return s.trim().toUpperCase()}).filter(function(s){return s&&/^[A-Z.]+$/.test(s)});var n=0;for(var i=0;i<ss.length;i++){if(wlSymbols.indexOf(ss[i])<0){wlSymbols.push(ss[i]);n++}}t.value='';renderWL();if(n)showToast('+'+n+'. Save to apply.','success')}
async function saveWatchlist(){var u=wlSymbols.slice().sort().filter(function(v,i,a){return a.indexOf(v)===i});var btn=document.querySelector('[onclick="saveWatchlist()"]');if(btn){btn.disabled=true;btn.innerHTML='<span class="loading-spinner"></span>'}try{var r=await fetch(API.watchlist,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({watchlist:u})});var d=await r.json();if(d.ok){showToast(d.message||'Saved.','success');wlSymbols=u;renderWL();await loadStatus();await loadAlerts();if(state.activeTab==='zones')await loadZones();startAutoRefresh()}else showToast('Failed.','error')}catch(e){showToast('Error.','error')}finally{if(btn){btn.disabled=false;btn.textContent='Save & Reinitialize'}}}

async function saveSettings(){var u={scan_interval_seconds:parseInt(document.getElementById('setting-interval').value)||300,lookback_days:parseInt(document.getElementById('setting-lookback').value)||252,max_gaps_per_symbol:parseInt(document.getElementById('setting-max-gaps').value)||50,alert_sensitivity:{proximity_pct:parseFloat(document.getElementById('setting-proximity').value)||0},chart:{ma10_type:document.getElementById('setting-ma10-type').value||'sma',ma20_type:document.getElementById('setting-ma20-type').value||'sma',ma50_type:document.getElementById('setting-ma50-type').value||'sma',ma200_type:document.getElementById('setting-ma200-type').value||'sma',ma10_color:document.getElementById('setting-ma10-color').value||'#f59e0b',ma20_color:document.getElementById('setting-ma20-color').value||'#3b82f6',ma50_color:document.getElementById('setting-ma50-color').value||'#a855f7',ma200_color:document.getElementById('setting-ma200-color').value||'#ef4444'}};try{var r=await fetch(API.settings,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(u)});var d=await r.json();if(d.ok){showToast('Saved.','success');await loadSettings();startAutoRefresh()}else showToast('Failed.','error')}catch(e){showToast('Error.','error')}}

async function submitSetup(){var ak=document.getElementById('setup-api-key').value.trim(),sk=document.getElementById('setup-secret-key').value.trim(),bu=(document.getElementById('setup-base-url').value||'').trim()||'https://paper-api.alpaca.markets',btn=document.getElementById('setup-submit-btn');if(!ak||!sk){showToast('Both required.','error');return}if(btn){btn.disabled=true;btn.textContent='Validating...'}try{var r=await fetch(API.setup,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alpaca_api_key:ak,alpaca_secret_key:sk,alpaca_base_url:bu})});var d=await r.json();if(d.ok){showToast('Validated!','success');await loadSettings();await loadStatus();switchTab('settings')}else showToast(d.message||'Failed.','error')}catch(e){showToast('Error.','error')}finally{if(btn){btn.disabled=false;btn.textContent='Validate & Save Keys'}}}

function showToast(m,t){t=t||'info';var c=document.getElementById('toast-container');if(!c)return;var e=document.createElement('div');e.className='toast '+t;e.textContent=m;c.appendChild(e);setTimeout(function(){e.remove()},3500)}
async function forceRefresh(){showToast('Refreshing...','info');await loadAlerts();await loadStatus();if(state.activeTab==='zones')await loadZones()}
function confirmClearAlerts(){var n=(state.alerts.support?state.alerts.support.length:0)+(state.alerts.resistance?state.alerts.resistance.length:0)+(state.alerts.untested?state.alerts.untested.length:0);if(!n){showToast('None.','info');return}var o=document.createElement('div');o.className='confirm-overlay';o.id='confirm-clear';o.innerHTML='<div class="confirm-box"><h3>Clear Alerts?</h3><p>Remove '+n+' alerts.</p><div class="confirm-actions"><button class="btn btn-secondary" onclick="dismissConfirm()">Cancel</button><button class="btn btn-danger" onclick="doClear()">Clear</button></div></div>';document.body.appendChild(o)}
function dismissConfirm(){var e=document.getElementById('confirm-clear');if(e)e.remove()}
async function doClear(){dismissConfirm();try{var r=await fetch('/api/alerts/clear',{method:'POST'});var d=await r.json();if(d.ok){state.alerts={support:[],resistance:[],untested:[]};state.alertFeed=[];state.previousAlertKeys=new Set();renderAlerts();renderFeed();updateAlertCounts();document.getElementById('undo-bar').style.display='flex';setTimeout(function(){dismissUndo()},15000)}}catch(e){showToast('Error.','error')}}
async function undoClearAlerts(){dismissUndo();try{var r=await fetch('/api/alerts/restore',{method:'POST'});var d=await r.json();if(d.ok){showToast('Restored.','success');await loadAlerts()}else showToast('No backup.','error')}catch(e){showToast('Error.','error')}}
function dismissUndo(){var e=document.getElementById('undo-bar');if(e)e.style.display='none'}
