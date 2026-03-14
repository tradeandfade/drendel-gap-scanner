const API={alerts:'/api/alerts',zones:'/api/zones',status:'/api/status',settings:'/api/settings',watchlist:'/api/watchlist',setup:'/api/setup',reinit:'/api/reinitialize'};
let state={activeTab:'scanner',alerts:{support:[],resistance:[],untested:[]},zones:[],status:{},settings:{},refreshTimer:null,zoneSortCol:'distance_pct',zoneSortDir:'asc',zoneFilter:'all',alertFeed:[],previousAlertKeys:new Set(),chart:null};
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

/* Auth */
let _isLoggingOut=false,_hasRedirected=false;
const _origFetch=window.fetch;
async function doLogout(){
  _isLoggingOut=true;stopAutoRefresh();
  const o=document.createElement('div');
  o.innerHTML=`<div style="text-align:center"><div style="width:40px;height:40px;font-size:18px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--olive);color:#000;font-weight:700;margin:0 auto 14px;">G</div><div style="font-size:13px;color:var(--text-1);margin-bottom:16px;">Logging out...</div><div style="width:200px;height:2px;background:var(--border-1);border-radius:1px;overflow:hidden;margin:0 auto;"><div id="logout-bar" style="height:100%;width:0%;background:var(--olive);border-radius:1px;transition:width 1s cubic-bezier(0.4,0,0.2,1);"></div></div></div>`;
  o.style.cssText='position:fixed;inset:0;z-index:600;background:var(--bg-0);display:flex;align-items:center;justify-content:center;';
  document.body.appendChild(o);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{const b=document.getElementById('logout-bar');if(b)b.style.width='100%';}));
  try{await _origFetch('/api/auth/logout',{method:'POST'});}catch(e){}
  await sleep(1100);window.location.replace('/login');
}
window.fetch=async function(...a){
  if(_isLoggingOut||_hasRedirected)return new Response('{}',{status:0});
  const r=await _origFetch.apply(this,a);
  if(r.status===401&&!_hasRedirected&&a[0]&&typeof a[0]==='string'&&a[0].startsWith('/api/')&&!a[0].includes('/auth/')){_hasRedirected=true;_isLoggingOut=true;stopAutoRefresh();await sleep(200);window.location.replace('/login');}
  return r;
};

/* Init */
document.addEventListener('DOMContentLoaded',async()=>{
  try{const r=await _origFetch('/api/auth/status');const d=await r.json();if(!d.authenticated){window.location.replace('/login');return;}}catch(e){}
  setupTabs();await initWithLoadingScreen();
});
async function initWithLoadingScreen(){
  const ov=document.getElementById('init-overlay'),st=document.getElementById('init-status-text'),dt=document.getElementById('init-detail'),pb=document.getElementById('init-progress-bar');
  if(!ov){await normalInit();return;}
  pb.classList.add('indeterminate');
  let att=0;
  while(att<120){
    if(_isLoggingOut||_hasRedirected)return;
    try{
      const r=await _origFetch(API.status);
      if(r.status===401){_hasRedirected=true;window.location.replace('/login');return;}
      state.status=await r.json();const s=state.status;
      if(s.initialized&&s.zone_count>0){pb.classList.remove('indeterminate');pb.style.width='100%';st.textContent='Ready';dt.textContent=`${s.symbol_count} symbols · ${s.zone_count} zones`;await sleep(300);await loadSettings();await loadAlerts();renderStatus();startAutoRefresh();ov.classList.add('hidden');return;}
      else if(s.initialized&&s.symbol_count>0&&s.zone_count===0){pb.classList.remove('indeterminate');pb.style.width='70%';st.textContent='Building zones...';dt.textContent=`${s.symbol_count} symbols`;}
      else if(s.initialized&&!s.symbol_count){pb.classList.remove('indeterminate');pb.style.width='100%';st.textContent='Add your watchlist to start.';await loadSettings();renderStatus();switchTab('setup');ov.classList.add('hidden');return;}
      else if(s.error){st.textContent='Setup needed';dt.textContent=s.error;await sleep(600);await loadSettings();renderStatus();switchTab('setup');ov.classList.add('hidden');return;}
      else{st.textContent='Loading market data...';if(s.symbol_count){dt.textContent=`${s.symbol_count} symbols...`;pb.classList.remove('indeterminate');pb.style.width='40%';}else dt.textContent='Connecting...';}
    }catch(e){st.textContent='Connecting...';}
    att++;await sleep(1500);
  }
  await normalInit();ov.classList.add('hidden');
}
async function normalInit(){await loadStatus();await loadSettings();if(!state.status.initialized&&!state.settings.alpaca_api_key_display)switchTab('setup');else{switchTab('scanner');await loadAlerts();startAutoRefresh();}}

/* Tabs */
function setupTabs(){document.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));}
function switchTab(t){state.activeTab=t;document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===t));document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active',c.id===`tab-${t}`));if(t==='zones')loadZones();if(t==='settings')renderSettings();}

/* Data */
async function loadAlerts(){try{const r=await fetch(API.alerts);state.alerts=await r.json();renderAlerts();updateAlertFeed();updateAlertCounts();}catch(e){}}
async function loadZones(){try{const r=await fetch(API.zones);state.zones=await r.json();renderZoneTable();}catch(e){}}
async function loadStatus(){try{const r=await fetch(API.status);state.status=await r.json();renderStatus();}catch(e){}}
async function loadSettings(){try{const r=await fetch(API.settings);state.settings=await r.json();}catch(e){}}

/* Refresh */
function startAutoRefresh(){stopAutoRefresh();const ms=Math.max((state.settings.scan_interval_seconds||300)*1000,10000);state.refreshTimer=setInterval(async()=>{await loadAlerts();await loadStatus();if(state.activeTab==='zones')await loadZones();},ms);}
function stopAutoRefresh(){if(state.refreshTimer){clearInterval(state.refreshTimer);state.refreshTimer=null;}}

/* Status */
function renderStatus(){const s=state.status,d=document.getElementById('status-dot'),t=document.getElementById('status-text');if(!d||!t)return;if(s.error){d.className='status-dot error';t.textContent='Error';}else if(s.running){d.className='status-dot active';t.textContent=s.last_scan||'Running';}else if(s.initialized){d.className='status-dot';t.textContent='Idle';}else{d.className='status-dot';t.textContent='—';}const sc=document.getElementById('symbol-count'),zc=document.getElementById('zone-count');if(sc)sc.textContent=s.symbol_count||0;if(zc)zc.textContent=s.zone_count||0;}
function updateAlertCounts(){const a=state.alerts,n=(a.support?.length||0)+(a.resistance?.length||0)+(a.untested?.length||0);const e=document.querySelector('[data-tab="scanner"] .tab-count');if(e)e.textContent=n;}

/* Alerts */
function renderAlerts(){
  renderSection('support',state.alerts.support||[],'S','Support');
  renderSection('resistance',state.alerts.resistance||[],'R','Resistance');
  renderSection('untested',state.alerts.untested||[],'U','Untested');
}
function renderSection(type,alerts,icon,title){
  const c=document.getElementById(`alerts-${type}`);if(!c)return;
  const h=`<div class="section-header ${type}"><div class="section-icon ${type}">${icon}</div><div class="section-title">${title}</div><div class="section-count">${alerts.length}</div></div>`;
  if(!alerts.length){c.innerHTML=h+`<div class="empty-state"><div class="empty-state-text">No ${type} alerts.</div></div>`;return;}
  c.innerHTML=h+`<div class="alert-grid">${alerts.map(a=>card(a,type)).join('')}</div>`;
}
function card(a,type){
  const z=a.zone,sz=z.zone_top-z.zone_bottom;
  let pct=0;if(sz>0){pct=type==='resistance'?((a.current_price-z.zone_bottom)/sz)*100:((z.zone_top-a.current_price)/sz)*100;}
  pct=Math.max(0,Math.min(100,pct));
  const badges=a.is_first_test?'<div class="card-badges"><span class="badge first-test">1st Test</span></div>':'';
  return `<div class="alert-card ${type}" onclick="openChart('${a.symbol}')"><div class="card-top"><span class="card-symbol">${a.symbol}</span><span class="card-price">$${a.current_price.toFixed(2)}</span></div>${badges}<div class="zone-meter"><div class="zone-meter-bar"><div class="zone-meter-fill" style="width:${pct}%"></div><div class="zone-meter-marker" style="left:${pct}%"></div></div><div class="zone-meter-labels"><span class="zone-meter-label">$${z.zone_bottom.toFixed(2)}</span><span class="zone-meter-label">$${z.zone_top.toFixed(2)}</span></div></div></div>`;
}

/* Feed */
function updateAlertFeed(){
  const all=[];
  for(const t of['support','resistance','untested'])for(const a of(state.alerts[t]||[])){const k=`${a.symbol}_${t}_${a.zone.zone_bottom}_${a.zone.zone_top}`;all.push({...a,feedType:t,key:k,isNew:!state.previousAlertKeys.has(k),time:a.timestamp||new Date().toISOString()});}
  const cur=new Set(all.map(a=>a.key));
  const nw=all.filter(a=>a.isNew);
  if(nw.length)state.alertFeed=[...nw.map(a=>({...a,feedTime:new Date()})),...state.alertFeed].slice(0,200);
  state.previousAlertKeys=cur;
  renderFeed();
}
function renderFeed(){
  const c=document.getElementById('alert-feed'),cn=document.getElementById('feed-count');if(!c)return;
  if(cn)cn.textContent=state.alertFeed.length;
  if(!state.alertFeed.length){c.innerHTML='<div class="empty-state"><div class="empty-state-text">No alerts yet today.</div></div>';return;}
  c.innerHTML=state.alertFeed.map(a=>{const t=a.feedTime?new Date(a.feedTime):new Date();const ts=t.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true});const lbl=a.feedType==='support'?'Support':a.feedType==='resistance'?'Resistance':'Untested';return `<div class="feed-item ${a.feedType} ${a.isNew?'new-alert':''}" onclick="openChart('${a.symbol}')"><span class="feed-sym">${a.symbol}</span><span class="feed-price">$${a.current_price.toFixed(2)}</span><span class="feed-time">${ts}</span><div class="feed-type">${lbl}</div></div>`;}).join('');
}

/* Chart — FIXED height, NO ResizeObserver */
async function openChart(sym){
  document.getElementById('chart-modal').style.display='flex';
  document.getElementById('chart-symbol').textContent=sym;
  const c=document.getElementById('chart-container');
  c.innerHTML='<div class="loading-overlay"><div class="loading-spinner"></div><div class="loading-text">Loading chart...</div></div>';
  try{
    const r=await fetch(`/api/chart/${sym}`);if(!r.ok){c.innerHTML='<div class="empty-state"><div class="empty-state-text">Could not load chart.</div></div>';return;}
    const d=await r.json();c.innerHTML='';
    // Fixed dimensions — no resize observer
    const w=c.offsetWidth,h=c.offsetHeight;
    const chart=LightweightCharts.createChart(c,{width:w,height:h,layout:{background:{type:'solid',color:'#0e0e0e'},textColor:'#777'},grid:{vertLines:{color:'#1a1a1a'},horzLines:{color:'#1a1a1a'}},crosshair:{mode:0},timeScale:{borderColor:'#1e1e1e'},rightPriceScale:{borderColor:'#1e1e1e'}});
    state.chart=chart;
    const cs=chart.addCandlestickSeries({upColor:'#6aaa5c',downColor:'#c45c4c',borderUpColor:'#6aaa5c',borderDownColor:'#c45c4c',wickUpColor:'#6aaa5c',wickDownColor:'#c45c4c'});
    cs.setData(d.bars.map(b=>({time:b.date,open:b.open,high:b.high,low:b.low,close:b.close})));
    const s=state.settings,closes=d.bars.map(b=>b.close);
    [{p:10,t:s.chart?.ma10_type||'sma',c:s.chart?.ma10_color||'#f59e0b'},{p:20,t:s.chart?.ma20_type||'sma',c:s.chart?.ma20_color||'#3b82f6'},{p:50,t:s.chart?.ma50_type||'sma',c:s.chart?.ma50_color||'#a855f7'},{p:200,t:s.chart?.ma200_type||'sma',c:s.chart?.ma200_color||'#ef4444'}].forEach(ma=>{
      const vals=ma.t==='ema'?calcEMA(closes,ma.p):calcSMA(closes,ma.p);
      const ld=vals.map((v,i)=>v!==null?{time:d.bars[i].date,value:v}:null).filter(Boolean);
      if(ld.length){const l=chart.addLineSeries({color:ma.c,lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});l.setData(ld);}
    });
    chart.timeScale().fitContent();
  }catch(e){c.innerHTML='<div class="empty-state"><div class="empty-state-text">Chart error.</div></div>';}
}
function closeChart(){document.getElementById('chart-modal').style.display='none';if(state.chart){state.chart.remove();state.chart=null;}}
function calcSMA(d,p){return d.map((v,i)=>{if(i<p-1)return null;let s=0;for(let j=i-p+1;j<=i;j++)s+=d[j];return Math.round((s/p)*100)/100;});}
function calcEMA(d,p){const k=2/(p+1);const r=[];let e=null;for(let i=0;i<d.length;i++){if(i<p-1){r.push(null);continue;}if(e===null){let s=0;for(let j=i-p+1;j<=i;j++)s+=d[j];e=s/p;}else e=d[i]*k+e*(1-k);r.push(Math.round(e*100)/100);}return r;}

/* Zone Table */
function renderZoneTable(){
  const c=document.getElementById('zone-explorer-content');if(!c)return;
  let z=[...state.zones];
  if(state.zoneFilter!=='all')z=z.filter(x=>{if(state.zoneFilter==='support')return x.base_type==='support'&&!x.is_untested;if(state.zoneFilter==='resistance')return x.base_type==='resistance'&&!x.is_untested;if(state.zoneFilter==='untested')return x.is_untested;return true;});
  const col=state.zoneSortCol,dir=state.zoneSortDir==='asc'?1:-1;
  z.sort((a,b)=>{let va=a[col],vb=b[col];if(typeof va==='string')return va.localeCompare(vb)*dir;return((va||0)-(vb||0))*dir;});
  const f=`<div class="table-filters"><button class="filter-btn ${state.zoneFilter==='all'?'active':''}" onclick="setZoneFilter('all')">All (${state.zones.length})</button><button class="filter-btn ${state.zoneFilter==='support'?'active':''}" onclick="setZoneFilter('support')">Support</button><button class="filter-btn ${state.zoneFilter==='resistance'?'active':''}" onclick="setZoneFilter('resistance')">Resistance</button><button class="filter-btn ${state.zoneFilter==='untested'?'active':''}" onclick="setZoneFilter('untested')">Untested</button></div>`;
  const cols=[{k:'symbol',l:'Symbol'},{k:'gap_type',l:'Type'},{k:'zone_top',l:'Top'},{k:'zone_bottom',l:'Bottom'},{k:'zone_size_pct',l:'Size%'},{k:'created_date',l:'Created'},{k:'distance_pct',l:'Dist%'}];
  const th=cols.map(x=>{let cl='';if(state.zoneSortCol===x.k)cl=state.zoneSortDir==='asc'?'sorted-asc':'sorted-desc';return`<th class="${cl}" onclick="sortZoneTable('${x.k}')">${x.l}</th>`;}).join('');
  const rows=z.map(x=>{const tc=x.is_untested?'untested':x.base_type;return`<tr onclick="openChart('${x.symbol}')" style="cursor:pointer"><td class="mono" style="font-weight:600;color:var(--text-1)">${x.symbol}</td><td><span class="zone-type-pill ${tc}">${x.is_untested?'U/'+x.base_type:x.gap_type}</span></td><td class="mono">$${x.zone_top.toFixed(2)}</td><td class="mono">$${x.zone_bottom.toFixed(2)}</td><td class="mono">${x.zone_size_pct.toFixed(2)}%</td><td class="mono">${x.created_date}</td><td class="mono" style="color:${(x.distance_pct||0)<=1?'var(--warning)':'inherit'}">${(x.distance_pct||0).toFixed(2)}%</td></tr>`;}).join('');
  c.innerHTML=f+`<div class="zone-table-wrap"><table class="zone-table"><thead><tr>${th}</tr></thead><tbody>${rows||'<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-4)">No zones.</td></tr>'}</tbody></table></div>`;
}
function sortZoneTable(c){if(state.zoneSortCol===c)state.zoneSortDir=state.zoneSortDir==='asc'?'desc':'asc';else{state.zoneSortCol=c;state.zoneSortDir='asc';}renderZoneTable();}
function setZoneFilter(f){state.zoneFilter=f;renderZoneTable();}

/* Settings */
function renderSettings(){
  const s=state.settings;
  sv('setting-interval',s.scan_interval_seconds);sv('setting-lookback',s.lookback_days);sv('setting-max-gaps',s.max_gaps_per_symbol);
  sv('setting-support-prox',s.alert_sensitivity?.support_proximity_pct);sv('setting-resistance-prox',s.alert_sensitivity?.resistance_proximity_pct);
  sc('setting-first-test-only',s.alert_sensitivity?.alert_on_first_test_only);
  sv('setting-ma10-type',s.chart?.ma10_type||'sma');sv('setting-ma20-type',s.chart?.ma20_type||'sma');sv('setting-ma50-type',s.chart?.ma50_type||'sma');sv('setting-ma200-type',s.chart?.ma200_type||'sma');
  if(s.chart?.ma10_color)document.getElementById('setting-ma10-color').value=s.chart.ma10_color;
  if(s.chart?.ma20_color)document.getElementById('setting-ma20-color').value=s.chart.ma20_color;
  if(s.chart?.ma50_color)document.getElementById('setting-ma50-color').value=s.chart.ma50_color;
  if(s.chart?.ma200_color)document.getElementById('setting-ma200-color').value=s.chart.ma200_color;
  loadWatchlist();
}
function sv(id,v){const e=document.getElementById(id);if(e&&v!==undefined)e.value=v;}
function sc(id,v){const e=document.getElementById(id);if(e)e.checked=!!v;}

/* Watchlist Manager */
let wlSymbols=[];
async function loadWatchlist(){try{const r=await fetch(API.watchlist);const d=await r.json();wlSymbols=(d.watchlist||[]).slice();renderWL();}catch(e){}}
function renderWL(){
  const c=document.getElementById('watchlist-symbols'),cn=document.getElementById('watchlist-count'),q=(document.getElementById('watchlist-search')?.value||'').toUpperCase();
  if(!c)return;if(cn)cn.textContent=wlSymbols.length;
  const f=q?wlSymbols.filter(s=>s.includes(q)):wlSymbols;
  if(!f.length){c.innerHTML=`<div class="wl-empty">${wlSymbols.length?'No match.':'Empty.'}</div>`;return;}
  c.innerHTML=f.map(s=>`<div class="wl-item"><span class="wl-sym">${s}</span><button class="wl-remove" onclick="rmSym('${s}')">✕</button></div>`).join('');
}
function renderWatchlistManager(){renderWL();}
function addSymbol(){const i=document.getElementById('watchlist-add-input');if(!i)return;const ss=i.value.trim().toUpperCase().split(/[\n,\s]+/).filter(s=>s&&/^[A-Z.]+$/.test(s));let n=0;for(const s of ss)if(!wlSymbols.includes(s)){wlSymbols.push(s);n++;}i.value='';renderWL();if(n)showToast(`Added ${n}. Save to apply.`,'success');else showToast('Already in list.','info');i.focus();}
function rmSym(s){wlSymbols=wlSymbols.filter(x=>x!==s);renderWL();}
function clearWatchlist(){if(!confirm('Remove all symbols?'))return;wlSymbols=[];renderWL();}
function toggleBulkPaste(){const a=document.getElementById('bulk-paste-area');if(a)a.style.display=a.style.display==='none'?'block':'none';}
function addBulkSymbols(){const t=document.getElementById('watchlist-bulk');if(!t)return;const ss=t.value.split(/[\n,\s]+/).map(s=>s.trim().toUpperCase()).filter(s=>s&&/^[A-Z.]+$/.test(s));let n=0;for(const s of ss)if(!wlSymbols.includes(s)){wlSymbols.push(s);n++;}t.value='';renderWL();if(n)showToast(`Added ${n}. Save to apply.`,'success');else showToast('All already in list.','info');}
async function saveWatchlist(){
  const u=[...new Set(wlSymbols)],btn=document.querySelector('[onclick="saveWatchlist()"]');
  if(btn){btn.disabled=true;btn.innerHTML='<span class="loading-spinner"></span> Saving...';}
  try{const r=await fetch(API.watchlist,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({watchlist:u})});const d=await r.json();if(d.ok){showToast(d.message||'Saved.','success');wlSymbols=u;renderWL();await loadStatus();await loadAlerts();if(state.activeTab==='zones')await loadZones();startAutoRefresh();}else showToast('Failed.','error');}catch(e){showToast('Error.','error');}
  finally{if(btn){btn.disabled=false;btn.textContent='Save & Reinitialize';}}
}
async function saveSettings(){
  const u={scan_interval_seconds:parseInt(document.getElementById('setting-interval')?.value)||300,lookback_days:parseInt(document.getElementById('setting-lookback')?.value)||252,max_gaps_per_symbol:parseInt(document.getElementById('setting-max-gaps')?.value)||50,
    alert_sensitivity:{support_proximity_pct:parseFloat(document.getElementById('setting-support-prox')?.value)||0,resistance_proximity_pct:parseFloat(document.getElementById('setting-resistance-prox')?.value)||0,alert_on_first_test_only:document.getElementById('setting-first-test-only')?.checked||false},
    chart:{ma10_type:document.getElementById('setting-ma10-type')?.value||'sma',ma20_type:document.getElementById('setting-ma20-type')?.value||'sma',ma50_type:document.getElementById('setting-ma50-type')?.value||'sma',ma200_type:document.getElementById('setting-ma200-type')?.value||'sma',ma10_color:document.getElementById('setting-ma10-color')?.value||'#f59e0b',ma20_color:document.getElementById('setting-ma20-color')?.value||'#3b82f6',ma50_color:document.getElementById('setting-ma50-color')?.value||'#a855f7',ma200_color:document.getElementById('setting-ma200-color')?.value||'#ef4444'}};
  try{const r=await fetch(API.settings,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(u)});const d=await r.json();if(d.ok){showToast('Saved.','success');await loadSettings();startAutoRefresh();}else showToast(d.message||'Failed.','error');}catch(e){showToast('Error.','error');}
}
async function submitSetup(){
  const ak=document.getElementById('setup-api-key')?.value?.trim(),sk=document.getElementById('setup-secret-key')?.value?.trim(),bu=document.getElementById('setup-base-url')?.value?.trim()||'https://paper-api.alpaca.markets',btn=document.getElementById('setup-submit-btn');
  if(!ak||!sk){showToast('Both keys required.','error');return;}
  if(btn){btn.disabled=true;btn.textContent='Validating...';}
  try{const r=await fetch(API.setup,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alpaca_api_key:ak,alpaca_secret_key:sk,alpaca_base_url:bu})});const d=await r.json();if(d.ok){showToast('Keys validated!','success');await loadSettings();await loadStatus();switchTab('settings');showToast('Add your watchlist.','success');}else showToast(d.message||'Failed.','error');}catch(e){showToast('Error.','error');}
  finally{if(btn){btn.disabled=false;btn.textContent='Validate & Save';}}
}

/* Toast */
function showToast(m,t='info'){const c=document.getElementById('toast-container');if(!c)return;const e=document.createElement('div');e.className=`toast ${t}`;e.textContent=m;c.appendChild(e);setTimeout(()=>e.remove(),3500);}
async function forceRefresh(){showToast('Refreshing...','info');await loadAlerts();await loadStatus();if(state.activeTab==='zones')await loadZones();}

/* Clear / Undo */
function confirmClearAlerts(){
  const n=(state.alerts.support?.length||0)+(state.alerts.resistance?.length||0)+(state.alerts.untested?.length||0);
  if(!n){showToast('No alerts.','info');return;}
  const o=document.createElement('div');o.className='confirm-overlay';o.id='confirm-clear';
  o.innerHTML=`<div class="confirm-box"><h3>Clear All Alerts?</h3><p>Remove all ${n} alerts. You can undo immediately after.</p><div class="confirm-actions"><button class="btn btn-secondary" onclick="dismissConfirm()">Cancel</button><button class="btn btn-danger" onclick="doClear()">Clear</button></div></div>`;
  document.body.appendChild(o);
}
function dismissConfirm(){const e=document.getElementById('confirm-clear');if(e)e.remove();}
async function doClear(){
  dismissConfirm();
  try{const r=await fetch('/api/alerts/clear',{method:'POST'});const d=await r.json();
    if(d.ok){state.alerts={support:[],resistance:[],untested:[]};state.alertFeed=[];state.previousAlertKeys=new Set();renderAlerts();renderFeed();updateAlertCounts();document.getElementById('undo-bar').style.display='flex';setTimeout(()=>dismissUndo(),15000);}
  }catch(e){showToast('Error.','error');}
}
async function undoClearAlerts(){
  dismissUndo();
  try{const r=await fetch('/api/alerts/restore',{method:'POST'});const d=await r.json();
    if(d.ok){showToast('Restored.','success');await loadAlerts();}
    else showToast(d.message||'Cannot restore.','error');
  }catch(e){showToast('Error.','error');}
}
function dismissUndo(){const e=document.getElementById('undo-bar');if(e)e.style.display='none';}
