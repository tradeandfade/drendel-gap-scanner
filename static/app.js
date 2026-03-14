/* ==========================================================================
   Drendel Gap Scanner — Dashboard JS (v3)
   Zone meters, alert feed sidebar, chart modal with MAs, daily reset.
   ========================================================================== */

const API = {
  alerts:'/api/alerts', zones:'/api/zones', status:'/api/status',
  settings:'/api/settings', watchlist:'/api/watchlist',
  setup:'/api/setup', reinit:'/api/reinitialize',
};

let state = {
  activeTab:'scanner', alerts:{support:[],resistance:[],untested:[]},
  zones:[], status:{}, settings:{}, refreshTimer:null,
  zoneSortCol:'distance_pct', zoneSortDir:'asc', zoneFilter:'all',
  alertFeed:[], // chronological feed of alerts
  previousAlertKeys: new Set(), // track which alerts we've seen
  chart:null, chartSeries:null, maLines:[],
};

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

/* ==========================================================================
   Auth
   ========================================================================== */
let _isLoggingOut=false, _hasRedirected=false;
const _origFetch=window.fetch;

async function doLogout(){
  _isLoggingOut=true; stopAutoRefresh();
  const overlay=document.createElement('div');
  overlay.innerHTML=`<div style="text-align:center;max-width:360px;padding:20px;">
    <div style="width:48px;height:48px;font-size:22px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--support-accent),var(--accent));color:white;font-weight:700;margin:0 auto 20px;">G</div>
    <div style="font-size:15px;font-weight:500;color:var(--text-primary);margin-bottom:20px;">Logging out...</div>
    <div style="width:240px;height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;margin:0 auto;">
      <div id="logout-bar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--support-accent),var(--accent));border-radius:2px;transition:width 1.1s cubic-bezier(0.4,0,0.2,1);"></div>
    </div></div>`;
  overlay.style.cssText='position:fixed;inset:0;z-index:600;background:var(--bg-primary);display:flex;align-items:center;justify-content:center;';
  document.body.appendChild(overlay);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{const b=document.getElementById('logout-bar');if(b)b.style.width='100%';}));
  try{await _origFetch('/api/auth/logout',{method:'POST'});}catch(e){}
  await sleep(1200);
  window.location.replace('/login');
}

window.fetch=async function(...args){
  if(_isLoggingOut||_hasRedirected)return new Response('{}',{status:0});
  const resp=await _origFetch.apply(this,args);
  if(resp.status===401&&!_hasRedirected&&args[0]&&typeof args[0]==='string'&&args[0].startsWith('/api/')&&!args[0].includes('/auth/')){
    _hasRedirected=true;_isLoggingOut=true;stopAutoRefresh();
    await sleep(300);window.location.replace('/login');
  }
  return resp;
};

/* ==========================================================================
   Init
   ========================================================================== */
document.addEventListener('DOMContentLoaded',async()=>{
  try{
    const r=await _origFetch('/api/auth/status');const d=await r.json();
    if(!d.authenticated){window.location.replace('/login');return;}
  }catch(e){}
  setupTabs();
  await initWithLoadingScreen();
});

async function initWithLoadingScreen(){
  const overlay=document.getElementById('init-overlay');
  const statusText=document.getElementById('init-status-text');
  const detail=document.getElementById('init-detail');
  const progressBar=document.getElementById('init-progress-bar');
  if(!overlay){await normalInit();return;}
  progressBar.classList.add('indeterminate');
  let attempts=0;
  while(attempts<120){
    if(_isLoggingOut||_hasRedirected)return;
    try{
      const resp=await _origFetch(API.status);
      if(resp.status===401){_hasRedirected=true;window.location.replace('/login');return;}
      state.status=await resp.json();
      const s=state.status;
      if(s.initialized&&s.zone_count>0){
        progressBar.classList.remove('indeterminate');progressBar.style.width='100%';
        statusText.textContent='Ready!';detail.textContent=`${s.symbol_count} symbols · ${s.zone_count} zones`;
        await sleep(400);await loadSettings();await loadAlerts();renderStatus();startAutoRefresh();
        overlay.classList.add('hidden');return;
      }else if(s.initialized&&s.symbol_count>0&&s.zone_count===0){
        progressBar.classList.remove('indeterminate');progressBar.style.width='70%';
        statusText.textContent='Building gap zones...';detail.textContent=`${s.symbol_count} symbols loaded`;
      }else if(s.initialized&&!s.symbol_count){
        progressBar.classList.remove('indeterminate');progressBar.style.width='100%';
        statusText.textContent='Ready — add your watchlist to start.';
        await loadSettings();renderStatus();switchTab('setup');overlay.classList.add('hidden');return;
      }else if(s.error){
        statusText.textContent='Scanner needs setup';detail.textContent=s.error;
        await sleep(800);await loadSettings();renderStatus();switchTab('setup');overlay.classList.add('hidden');return;
      }else{
        statusText.textContent='Loading market data...';
        if(s.symbol_count){detail.textContent=`Fetching data for ${s.symbol_count} symbols...`;progressBar.classList.remove('indeterminate');progressBar.style.width='40%';}
        else{detail.textContent='Connecting to Alpaca...';}
      }
    }catch(e){statusText.textContent='Connecting to server...';}
    attempts++;await sleep(1500);
  }
  await normalInit();overlay.classList.add('hidden');
}

async function normalInit(){
  await loadStatus();await loadSettings();
  if(!state.status.initialized&&!state.settings.alpaca_api_key_display)switchTab('setup');
  else{switchTab('scanner');await loadAlerts();startAutoRefresh();}
}

/* ==========================================================================
   Tabs
   ========================================================================== */
function setupTabs(){document.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));}
function switchTab(tabId){
  state.activeTab=tabId;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tabId));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active',c.id===`tab-${tabId}`));
  if(tabId==='zones')loadZones();
  if(tabId==='settings')renderSettings();
}

/* ==========================================================================
   Data Loading
   ========================================================================== */
async function loadAlerts(){
  try{
    const resp=await fetch(API.alerts);state.alerts=await resp.json();
    renderAlerts();updateAlertFeed();updateAlertCounts();
  }catch(e){}
}
async function loadZones(){
  try{const resp=await fetch(API.zones);state.zones=await resp.json();renderZoneTable();}catch(e){}
}
async function loadStatus(){
  try{const resp=await fetch(API.status);state.status=await resp.json();renderStatus();}catch(e){}
}
async function loadSettings(){
  try{const resp=await fetch(API.settings);state.settings=await resp.json();}catch(e){}
}

/* ==========================================================================
   Auto-Refresh
   ========================================================================== */
function startAutoRefresh(){
  stopAutoRefresh();
  const sec=state.settings.scan_interval_seconds||300;
  const ms=Math.max(sec*1000,10000);
  state.refreshTimer=setInterval(async()=>{
    await loadAlerts();await loadStatus();
    if(state.activeTab==='zones')await loadZones();
  },ms);
}
function stopAutoRefresh(){if(state.refreshTimer){clearInterval(state.refreshTimer);state.refreshTimer=null;}}

/* ==========================================================================
   Render: Status
   ========================================================================== */
function renderStatus(){
  const s=state.status;
  const dot=document.getElementById('status-dot');
  const text=document.getElementById('status-text');
  if(!dot||!text)return;
  if(s.error){dot.className='status-dot error';text.textContent='Error';}
  else if(s.running){dot.className='status-dot active';text.textContent=s.last_scan?`${s.last_scan}`:'Running...';}
  else if(s.initialized){dot.className='status-dot';text.textContent='Idle';}
  else{dot.className='status-dot';text.textContent='Not configured';}
  const sc=document.getElementById('symbol-count');const zc=document.getElementById('zone-count');
  if(sc)sc.textContent=s.symbol_count||0;if(zc)zc.textContent=s.zone_count||0;
}
function updateAlertCounts(){
  const a=state.alerts;const total=(a.support?.length||0)+(a.resistance?.length||0)+(a.untested?.length||0);
  const el=document.querySelector('[data-tab="scanner"] .tab-count');if(el)el.textContent=total;
}

/* ==========================================================================
   Render: Alerts with Zone Meters
   ========================================================================== */
function renderAlerts(){
  renderAlertSection('support',state.alerts.support||[],'S','Support Gap Alerts');
  renderAlertSection('resistance',state.alerts.resistance||[],'R','Resistance Gap Alerts');
  renderAlertSection('untested',state.alerts.untested||[],'U','Untested Gap Alerts');
}

function renderAlertSection(type,alerts,icon,title){
  const container=document.getElementById(`alerts-${type}`);if(!container)return;
  const header=`<div class="section-header ${type}"><div class="section-icon ${type}">${icon}</div><div class="section-title">${title}</div><div class="section-count">${alerts.length}</div></div>`;
  if(!alerts.length){
    container.innerHTML=header+`<div class="empty-state"><div class="empty-state-text">No ${type} alerts right now.</div></div>`;return;
  }
  container.innerHTML=header+`<div class="alert-grid">${alerts.map(a=>renderAlertCard(a,type)).join('')}</div>`;
}

function renderAlertCard(alert,type){
  const z=alert.zone;
  const badges=[];
  if(alert.is_first_test)badges.push('<span class="badge first-test">First Test</span>');

  // Zone meter: position of current price within zone
  const zoneSize=z.zone_top-z.zone_bottom;
  let pct=0;
  if(zoneSize>0){
    if(type==='support'||type==='untested'){
      pct=((z.zone_top-alert.current_price)/zoneSize)*100;
    }else{
      pct=((alert.current_price-z.zone_bottom)/zoneSize)*100;
    }
  }
  pct=Math.max(0,Math.min(100,pct));

  return `
    <div class="alert-card ${type}" onclick="openChart('${alert.symbol}')">
      <div class="card-top">
        <span class="card-symbol">${alert.symbol}</span>
        <span class="card-price">$${alert.current_price.toFixed(2)}</span>
      </div>
      ${badges.length?`<div class="card-badges">${badges.join('')}</div>`:''}
      <div class="zone-meter">
        <div class="zone-meter-bar">
          <div class="zone-meter-fill" style="width:${pct}%"></div>
          <div class="zone-meter-marker" style="left:${pct}%"></div>
        </div>
        <div class="zone-meter-labels">
          <span class="zone-meter-label">$${z.zone_bottom.toFixed(2)}</span>
          <span class="zone-meter-label">$${z.zone_top.toFixed(2)}</span>
        </div>
      </div>
    </div>`;
}

/* ==========================================================================
   Alert Feed Sidebar
   ========================================================================== */
function updateAlertFeed(){
  const all=[];
  for(const type of ['support','resistance','untested']){
    for(const a of (state.alerts[type]||[])){
      const key=`${a.symbol}_${type}_${a.zone.zone_bottom}_${a.zone.zone_top}`;
      const isNew=!state.previousAlertKeys.has(key);
      all.push({...a,feedType:type,key,isNew,time:a.timestamp||new Date().toISOString()});
    }
  }
  // Update previous keys
  const currentKeys=new Set(all.map(a=>a.key));
  // Add new items to feed (prepend)
  const newItems=all.filter(a=>a.isNew);
  if(newItems.length>0){
    state.alertFeed=[...newItems.map(a=>({...a,feedTime:new Date()})),...state.alertFeed].slice(0,200);
  }
  state.previousAlertKeys=currentKeys;
  renderAlertFeed();
}

function renderAlertFeed(){
  const container=document.getElementById('alert-feed');
  const countEl=document.getElementById('feed-count');
  if(!container)return;
  if(countEl)countEl.textContent=state.alertFeed.length;

  if(!state.alertFeed.length){
    container.innerHTML='<div class="empty-state"><div class="empty-state-text">No alerts yet today.<br>Alerts appear here as they fire.</div></div>';
    return;
  }

  container.innerHTML=state.alertFeed.map(a=>{
    const t=a.feedTime?new Date(a.feedTime):new Date();
    const timeStr=t.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true});
    const typeLabel=a.feedType==='support'?'Support':a.feedType==='resistance'?'Resistance':'Untested';
    return `
      <div class="feed-item ${a.feedType} ${a.isNew?'new-alert':''}" onclick="openChart('${a.symbol}')">
        <span class="feed-sym">${a.symbol}</span><span class="feed-price">$${a.current_price.toFixed(2)}</span>
        <span class="feed-time">${timeStr}</span>
        <div class="feed-type">${typeLabel} gap zone</div>
      </div>`;
  }).join('');
}

/* ==========================================================================
   Chart Modal (TradingView Lightweight Charts)
   ========================================================================== */
async function openChart(symbol){
  document.getElementById('chart-modal').style.display='flex';
  document.getElementById('chart-symbol').textContent=symbol;
  const container=document.getElementById('chart-container');
  container.innerHTML='<div class="loading-overlay"><div class="loading-spinner"></div><div class="loading-text">Loading chart...</div></div>';

  // Fetch daily bars from our API
  try{
    const resp=await fetch(`/api/chart/${symbol}`);
    if(!resp.ok){container.innerHTML='<div class="empty-state"><div class="empty-state-text">Could not load chart data.</div></div>';return;}
    const data=await resp.json();
    container.innerHTML='';
    renderLightweightChart(container,data,symbol);
  }catch(e){
    container.innerHTML='<div class="empty-state"><div class="empty-state-text">Chart error.</div></div>';
  }
}

function closeChart(){
  document.getElementById('chart-modal').style.display='none';
  if(state.chartResizeObserver){state.chartResizeObserver.disconnect();state.chartResizeObserver=null;}
  if(state.chart){state.chart.remove();state.chart=null;}
}

function renderLightweightChart(container,data,symbol){
  // Use fixed dimensions to prevent resize loops
  const w=container.clientWidth;
  const h=container.clientHeight;

  const chart=LightweightCharts.createChart(container,{
    width:w,height:h,
    layout:{background:{color:'#151d2e'},textColor:'#94a3b8'},
    grid:{vertLines:{color:'#1e293b'},horzLines:{color:'#1e293b'}},
    crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
    timeScale:{borderColor:'#1e293b',timeVisible:false},
    rightPriceScale:{borderColor:'#1e293b',autoScale:true},
    handleScale:true,
    handleScroll:true,
  });
  state.chart=chart;

  const candleSeries=chart.addCandlestickSeries({
    upColor:'#10b981',downColor:'#ef4444',borderUpColor:'#10b981',borderDownColor:'#ef4444',
    wickUpColor:'#10b981',wickDownColor:'#ef4444',
  });

  const bars=data.bars.map(b=>({time:b.date,open:b.open,high:b.high,low:b.low,close:b.close}));
  candleSeries.setData(bars);

  // Per-MA type and color settings
  const s=state.settings;
  const maConfig=[
    {period:10, type:s.chart?.ma10_type||'sma', color:s.chart?.ma10_color||'#f59e0b'},
    {period:20, type:s.chart?.ma20_type||'sma', color:s.chart?.ma20_color||'#3b82f6'},
    {period:50, type:s.chart?.ma50_type||'sma', color:s.chart?.ma50_color||'#a855f7'},
    {period:200, type:s.chart?.ma200_type||'sma', color:s.chart?.ma200_color||'#ef4444'},
  ];

  const closes=data.bars.map(b=>b.close);
  for(const ma of maConfig){
    const maData=ma.type==='ema'?calcEMA(closes,ma.period):calcSMA(closes,ma.period);
    const lineData=maData.map((v,i)=>v!==null?{time:data.bars[i].date,value:v}:null).filter(Boolean);
    if(lineData.length>0){
      const line=chart.addLineSeries({color:ma.color,lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
      line.setData(lineData);
    }
  }

  chart.timeScale().fitContent();

  // Debounced resize handler to prevent infinite loop
  let resizeTimeout;
  const ro=new ResizeObserver(()=>{
    clearTimeout(resizeTimeout);
    resizeTimeout=setTimeout(()=>{
      const newW=container.clientWidth;
      const newH=container.clientHeight;
      if(newW>0&&newH>0)chart.applyOptions({width:newW,height:newH});
    },100);
  });
  ro.observe(container);
  state.chartResizeObserver=ro;
}

function calcSMA(data,period){
  return data.map((v,i)=>{
    if(i<period-1)return null;
    let sum=0;for(let j=i-period+1;j<=i;j++)sum+=data[j];
    return Math.round((sum/period)*100)/100;
  });
}

function calcEMA(data,period){
  const k=2/(period+1);
  const result=[];
  let ema=null;
  for(let i=0;i<data.length;i++){
    if(i<period-1){result.push(null);continue;}
    if(ema===null){let sum=0;for(let j=i-period+1;j<=i;j++)sum+=data[j];ema=sum/period;}
    else{ema=data[i]*k+ema*(1-k);}
    result.push(Math.round(ema*100)/100);
  }
  return result;
}

/* ==========================================================================
   Zone Explorer
   ========================================================================== */
function renderZoneTable(){
  const container=document.getElementById('zone-explorer-content');if(!container)return;
  let zones=[...state.zones];
  if(state.zoneFilter!=='all'){
    zones=zones.filter(z=>{
      if(state.zoneFilter==='support')return z.base_type==='support'&&!z.is_untested;
      if(state.zoneFilter==='resistance')return z.base_type==='resistance'&&!z.is_untested;
      if(state.zoneFilter==='untested')return z.is_untested;return true;
    });
  }
  const col=state.zoneSortCol,dir=state.zoneSortDir==='asc'?1:-1;
  zones.sort((a,b)=>{let va=a[col],vb=b[col];if(typeof va==='string')return va.localeCompare(vb)*dir;return((va||0)-(vb||0))*dir;});

  const filters=`<div class="table-filters">
    <button class="filter-btn ${state.zoneFilter==='all'?'active':''}" onclick="setZoneFilter('all')">All (${state.zones.length})</button>
    <button class="filter-btn ${state.zoneFilter==='support'?'active':''}" onclick="setZoneFilter('support')">Support</button>
    <button class="filter-btn ${state.zoneFilter==='resistance'?'active':''}" onclick="setZoneFilter('resistance')">Resistance</button>
    <button class="filter-btn ${state.zoneFilter==='untested'?'active':''}" onclick="setZoneFilter('untested')">Untested</button>
  </div>`;

  const cols=[{key:'symbol',label:'Symbol'},{key:'gap_type',label:'Type'},{key:'zone_top',label:'Zone Top'},{key:'zone_bottom',label:'Zone Bottom'},{key:'zone_size_pct',label:'Size %'},{key:'created_date',label:'Created'},{key:'distance_pct',label:'Distance %'}];
  const ths=cols.map(c=>{let cls='';if(state.zoneSortCol===c.key)cls=state.zoneSortDir==='asc'?'sorted-asc':'sorted-desc';return `<th class="${cls}" onclick="sortZoneTable('${c.key}')">${c.label}</th>`;}).join('');
  const rows=zones.map(z=>{
    const tc=z.is_untested?'untested':z.base_type;
    return `<tr onclick="openChart('${z.symbol}')" style="cursor:pointer">
      <td class="mono" style="font-weight:600;color:var(--text-primary)">${z.symbol}</td>
      <td><span class="zone-type-pill ${tc}">${z.is_untested?'untested '+z.base_type:z.gap_type}</span></td>
      <td class="mono">$${z.zone_top.toFixed(2)}</td><td class="mono">$${z.zone_bottom.toFixed(2)}</td>
      <td class="mono">${z.zone_size_pct.toFixed(2)}%</td><td class="mono">${z.created_date}</td>
      <td class="mono" style="color:${(z.distance_pct||0)<=1?'var(--warning)':'inherit'}">${(z.distance_pct||0).toFixed(2)}%</td>
    </tr>`;
  }).join('');

  container.innerHTML=filters+`<div class="zone-table-wrap"><table class="zone-table"><thead><tr>${ths}</tr></thead>
    <tbody>${rows||'<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--text-muted)">No zones found.</td></tr>'}</tbody></table></div>`;
}
function sortZoneTable(col){if(state.zoneSortCol===col)state.zoneSortDir=state.zoneSortDir==='asc'?'desc':'asc';else{state.zoneSortCol=col;state.zoneSortDir='asc';}renderZoneTable();}
function setZoneFilter(f){state.zoneFilter=f;renderZoneTable();}

/* ==========================================================================
   Settings
   ========================================================================== */
function renderSettings(){
  const s=state.settings;
  setVal('setting-interval',s.scan_interval_seconds);
  setVal('setting-lookback',s.lookback_days);
  setVal('setting-max-gaps',s.max_gaps_per_symbol);
  setVal('setting-support-prox',s.alert_sensitivity?.support_proximity_pct);
  setVal('setting-resistance-prox',s.alert_sensitivity?.resistance_proximity_pct);
  setChecked('setting-first-test-only',s.alert_sensitivity?.alert_on_first_test_only);
  // Chart settings - per MA
  setVal('setting-ma10-type',s.chart?.ma10_type||'sma');
  setVal('setting-ma20-type',s.chart?.ma20_type||'sma');
  setVal('setting-ma50-type',s.chart?.ma50_type||'sma');
  setVal('setting-ma200-type',s.chart?.ma200_type||'sma');
  if(s.chart?.ma10_color)document.getElementById('setting-ma10-color').value=s.chart.ma10_color;
  if(s.chart?.ma20_color)document.getElementById('setting-ma20-color').value=s.chart.ma20_color;
  if(s.chart?.ma50_color)document.getElementById('setting-ma50-color').value=s.chart.ma50_color;
  if(s.chart?.ma200_color)document.getElementById('setting-ma200-color').value=s.chart.ma200_color;
  loadWatchlistManager();
}
function setVal(id,val){const el=document.getElementById(id);if(el&&val!==undefined)el.value=val;}
function setChecked(id,val){const el=document.getElementById(id);if(el)el.checked=!!val;}

/* ==========================================================================
   Watchlist Manager
   ========================================================================== */
let watchlistSymbols = [];

async function loadWatchlistManager(){
  try{
    const resp=await fetch(API.watchlist);const data=await resp.json();
    watchlistSymbols=(data.watchlist||[]).slice();
    renderWatchlistManager();
  }catch(e){}
}

function renderWatchlistManager(){
  const container=document.getElementById('watchlist-symbols');
  const countEl=document.getElementById('watchlist-count');
  const search=(document.getElementById('watchlist-search')?.value||'').toUpperCase().trim();
  if(!container)return;

  if(countEl)countEl.textContent=watchlistSymbols.length;

  const filtered=search?watchlistSymbols.filter(s=>s.includes(search)):watchlistSymbols;

  if(!filtered.length){
    container.innerHTML=`<div class="wl-empty">${watchlistSymbols.length?'No symbols match your search.':'No symbols yet. Add some above.'}</div>`;
    return;
  }

  container.innerHTML=filtered.map(sym=>`
    <div class="wl-item">
      <span class="wl-sym">${sym}</span>
      <button class="wl-remove" onclick="removeSymbol('${sym}')" title="Remove ${sym}">✕</button>
    </div>
  `).join('');
}

function addSymbol(){
  const input=document.getElementById('watchlist-add-input');
  if(!input)return;
  const raw=input.value.trim().toUpperCase();
  if(!raw)return;

  // Support adding multiple comma/space separated from the single input too
  const syms=raw.split(/[\n,\s]+/).map(s=>s.trim()).filter(s=>s&&/^[A-Z.]+$/.test(s));

  let added=0;
  for(const sym of syms){
    if(!watchlistSymbols.includes(sym)){
      watchlistSymbols.push(sym);
      added++;
    }
  }

  input.value='';
  renderWatchlistManager();
  if(added>0)showToast(`Added ${added} symbol${added>1?'s':''}. Click Save to apply.`,'success');
  else showToast('Symbol already in watchlist.','info');
  input.focus();
}

function removeSymbol(sym){
  watchlistSymbols=watchlistSymbols.filter(s=>s!==sym);
  renderWatchlistManager();
}

function clearWatchlist(){
  if(!confirm('Remove all symbols from your watchlist?'))return;
  watchlistSymbols=[];
  renderWatchlistManager();
}

function toggleBulkPaste(){
  const area=document.getElementById('bulk-paste-area');
  if(area)area.style.display=area.style.display==='none'?'block':'none';
}

function addBulkSymbols(){
  const ta=document.getElementById('watchlist-bulk');
  if(!ta)return;
  const raw=ta.value;
  const syms=raw.split(/[\n,\s]+/).map(s=>s.trim().toUpperCase()).filter(s=>s&&/^[A-Z.]+$/.test(s));

  let added=0;
  for(const sym of syms){
    if(!watchlistSymbols.includes(sym)){
      watchlistSymbols.push(sym);
      added++;
    }
  }

  ta.value='';
  renderWatchlistManager();
  if(added>0)showToast(`Added ${added} symbol${added>1?'s':''}. Click Save to apply.`,'success');
  else showToast('All symbols already in watchlist.','info');
}

async function saveWatchlist(){
  const unique=[...new Set(watchlistSymbols)];
  const btn=document.querySelector('#tab-settings .btn-primary[onclick="saveWatchlist()"]');
  if(btn){btn.disabled=true;btn.innerHTML='<span class="loading-spinner"></span> Saving...';}
  try{
    const resp=await fetch(API.watchlist,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({watchlist:unique})});
    const data=await resp.json();
    if(data.ok){
      showToast(data.message||'Saved.','success');
      watchlistSymbols=unique;
      renderWatchlistManager();
      await loadStatus();await loadAlerts();if(state.activeTab==='zones')await loadZones();startAutoRefresh();
    }else showToast('Failed.','error');
  }catch(e){showToast('Error.','error');}
  finally{if(btn){btn.disabled=false;btn.textContent='Save Watchlist & Reinitialize';}}
}

async function saveSettings(){
  const updates={
    scan_interval_seconds:parseInt(document.getElementById('setting-interval')?.value)||300,
    lookback_days:parseInt(document.getElementById('setting-lookback')?.value)||252,
    max_gaps_per_symbol:parseInt(document.getElementById('setting-max-gaps')?.value)||50,
    alert_sensitivity:{
      support_proximity_pct:parseFloat(document.getElementById('setting-support-prox')?.value)||0,
      resistance_proximity_pct:parseFloat(document.getElementById('setting-resistance-prox')?.value)||0,
      alert_on_first_test_only:document.getElementById('setting-first-test-only')?.checked||false,
    },
    chart:{
      ma10_type:document.getElementById('setting-ma10-type')?.value||'sma',
      ma20_type:document.getElementById('setting-ma20-type')?.value||'sma',
      ma50_type:document.getElementById('setting-ma50-type')?.value||'sma',
      ma200_type:document.getElementById('setting-ma200-type')?.value||'sma',
      ma10_color:document.getElementById('setting-ma10-color')?.value||'#f59e0b',
      ma20_color:document.getElementById('setting-ma20-color')?.value||'#3b82f6',
      ma50_color:document.getElementById('setting-ma50-color')?.value||'#a855f7',
      ma200_color:document.getElementById('setting-ma200-color')?.value||'#ef4444',
    },
  };
  try{
    const resp=await fetch(API.settings,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(updates)});
    const data=await resp.json();
    if(data.ok){showToast('Settings saved.','success');await loadSettings();startAutoRefresh();}
    else showToast(data.message||'Failed.','error');
  }catch(e){showToast('Error saving.','error');}
}

async function submitSetup(){
  const apiKey=document.getElementById('setup-api-key')?.value?.trim();
  const secretKey=document.getElementById('setup-secret-key')?.value?.trim();
  const baseUrl=document.getElementById('setup-base-url')?.value?.trim()||'https://paper-api.alpaca.markets';
  const btn=document.getElementById('setup-submit-btn');
  if(!apiKey||!secretKey){showToast('Both keys required.','error');return;}
  if(btn){btn.disabled=true;btn.textContent='Validating...';}
  try{
    const resp=await fetch(API.setup,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alpaca_api_key:apiKey,alpaca_secret_key:secretKey,alpaca_base_url:baseUrl})});
    const data=await resp.json();
    if(data.ok){showToast('Keys validated!','success');await loadSettings();await loadStatus();switchTab('settings');showToast('Now add your watchlist.','success');}
    else showToast(data.message||'Failed.','error');
  }catch(e){showToast('Connection error.','error');}
  finally{if(btn){btn.disabled=false;btn.textContent='Validate & Save';}}
}

/* ==========================================================================
   Toast
   ========================================================================== */
function showToast(msg,type='info'){
  const c=document.getElementById('toast-container');if(!c)return;
  const t=document.createElement('div');t.className=`toast ${type}`;t.textContent=msg;c.appendChild(t);
  setTimeout(()=>t.remove(),3500);
}

async function forceRefresh(){
  showToast('Refreshing...','info');await loadAlerts();await loadStatus();
  if(state.activeTab==='zones')await loadZones();
}
