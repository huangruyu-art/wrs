(function(){
  'use strict';
  const STORAGE_KEY='work-record-prototype-v9-project-schedules';
  const PRODUCT_KEY='work-record-prototype-v9-masters';
  const DAY=86400000;
  const $=id=>document.getElementById(id);
  const state={products:[],schedules:{},rows:[],pending:null,source:'local'};

  function iso(d){return d.toISOString().slice(0,10)}
  function parseDate(v){if(!v)return null;const d=new Date(v+'T00:00:00');return Number.isNaN(d.getTime())?null:d}
  function addDays(v,n){const d=parseDate(v);if(!d)return v;d.setDate(d.getDate()+n);return iso(d)}
  function diffDays(a,b){return Math.round((parseDate(b)-parseDate(a))/DAY)}
  function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
  function banner(msg,type=''){const el=$('statusBanner');el.textContent=msg;el.className='status-banner '+type}
  function projectParts(key){const [customer='',product='',spec='']=String(key).split('｜');return{customer,product,spec}}
  function nodeDates(config,node){const d=(config.nodeDates||{})[node.id]||{};let end=d.planned_end_date||d.planned_date||d.actual_date||'';let start=d.planned_start_date||d.start_date||end; if(!start)start=end; if(!end)end=start;return{start,end,actual:d.actual_date||''}}
  function production(name){return /生產|試產|排產/.test(name||'')}
  function statusFor(key){return state.products.find(p=>[p.customer||'',p.product_name||'',p.spec||''].join('｜')===key)?.status||'進行中'}

  async function load(){
    banner('載入資料中…');
    const svc=window.WR_SUPABASE_SERVICE;
    if(svc?.isReady()&&svc.isAuthenticated()){
      const data=await svc.loadGanttData(); state.source='supabase';
      state.products=data.productSpecs||[]; state.schedules={};
      (data.projectSchedules||[]).forEach(r=>state.schedules[r.project_key]=r.config||{});
    }else{
      state.source='local';
      const master=JSON.parse(localStorage.getItem(PRODUCT_KEY)||'{"customers":[],"productSpecs":[],"scheduleNodes":[]}');
      state.products=master.productSpecs||[];
      state.schedules=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');
    }
    buildRows(); populateFilters(); setDefaultRange(); render();
    banner(state.source==='supabase'?'已從 Supabase 載入。':'目前使用瀏覽器本機資料；登入 Supabase 後可同步寫回。');
  }

  function buildRows(){
    state.rows=[];
    Object.entries(state.schedules).forEach(([key,config])=>{
      const parts=projectParts(key); const nodes=(config.scheduleNodes||[]).slice().sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
      nodes.forEach((node,i)=>{const d=nodeDates(config,node); if(!d.start&&!d.end)return; state.rows.push({id:node.id,key,customer:parts.customer,product:parts.product,spec:parts.spec,nodeName:node.node_name||'',order:i+1,start:d.start,end:d.end,actual:d.actual,status:statusFor(key),production:production(node.node_name),config})});
    });
  }

  function populateFilters(){
    const customers=[...new Set(state.products.map(p=>p.customer).filter(Boolean))].sort();
    $('filterCustomer').innerHTML='<option value="">全部客戶</option>'+customers.map(x=>`<option>${esc(x)}</option>`).join('');
    const statuses=[...new Set(state.products.map(p=>p.status||'進行中'))].sort();
    $('filterStatus').innerHTML='<option value="">全部狀態</option>'+statuses.map(x=>`<option>${esc(x)}</option>`).join('');
  }
  function setDefaultRange(){if($('filterStart').value)return;const dates=state.rows.flatMap(r=>[r.start,r.end]).filter(Boolean).sort();const now=new Date();$('filterStart').value=dates[0]||iso(new Date(now.getFullYear(),now.getMonth(),1));$('filterEnd').value=dates.at(-1)||iso(new Date(now.getFullYear(),now.getMonth()+2,0))}
  function filtered(){const s=$('filterStart').value,e=$('filterEnd').value,c=$('filterCustomer').value,st=$('filterStatus').value,q=$('filterKeyword').value.trim().toLowerCase(),mode=$('viewMode').value;return state.rows.filter(r=>(!s||r.end>=s)&&(!e||r.start<=e)&&(!c||r.customer===c)&&(!st||r.status===st)&&(!q||`${r.key} ${r.nodeName}`.toLowerCase().includes(q))&&(mode!=='production'||r.production))}

  function render(){
    const start=$('filterStart').value,end=$('filterEnd').value;if(!start||!end||start>end){banner('日期區間不正確。','error');return}
    const rows=filtered();const mode=$('viewMode').value;const scale=$('scaleMode').value;const cell=scale==='week'?18:34;document.documentElement.style.setProperty('--cell',cell+'px');
    const days=diffDays(start,end)+1;const timelineWidth=days*cell;const grouped=new Map();rows.forEach(r=>{if(!grouped.has(r.key))grouped.set(r.key,[]);grouped.get(r.key).push(r)});
    $('ganttEmpty').hidden=grouped.size>0;let html=`<div class="gantt-header"><div class="left-head">專案 / 節點</div><div class="timeline-head" style="width:${timelineWidth}px">`;
    for(let i=0;i<days;i++){const d=addDays(start,i),dt=parseDate(d),weekend=[0,6].includes(dt.getDay());html+=`<div class="date-cell ${weekend?'weekend':''}" style="flex-basis:${cell}px"><strong>${dt.getDate()}</strong>${dt.getMonth()+1}月</div>`}html+='</div></div>';
    grouped.forEach((list,key)=>{const pStart=list.map(x=>x.start).sort()[0],pEnd=list.map(x=>x.end).sort().at(-1);html+=rowHtml({key,nodeName:'',start:pStart,end:pEnd,status:list[0].status},start,cell,true,mode==='projects');if(mode!=='projects')list.forEach(r=>html+=rowHtml(r,start,cell,false,true))});
    const today=iso(new Date());if(today>=start&&today<=end){const left=310+diffDays(start,today)*cell+cell/2;html+=`<div class="today-line" style="left:${left}px" title="今天"></div>`}
    $('ganttCanvas').innerHTML=html;bindDrag(start,cell);
  }
  function rowHtml(r,rangeStart,cell,isProject,showBar){const left=diffDays(rangeStart,r.start)*cell;const width=Math.max(cell,(diffDays(r.start,r.end)+1)*cell);const cls=isProject?'project-bar':`${r.actual?'completed':''} ${r.production?'production':''}`;return `<div class="gantt-row"><div class="row-label ${isProject?'project':''}" title="${esc(r.key)}">${isProject?esc(r.key):'↳ '+esc(r.nodeName)}<small>${isProject?esc(r.status):`${esc(r.start)}～${esc(r.end)}`}</small></div><div class="timeline-row ${$('scaleMode').value==='week'?'week-grid':''}">${showBar?`<div class="bar ${cls}" data-key="${esc(r.key)}" data-node="${esc(r.id||'')}" data-start="${esc(r.start)}" data-end="${esc(r.end)}" style="left:${left}px;width:${width}px" title="${esc(r.start)}～${esc(r.end)}"><i class="handle left" data-edge="left"></i><span>${esc(isProject?r.key:r.nodeName)}</span><i class="handle right" data-edge="right"></i></div>`:''}</div></div>`}

  function bindDrag(rangeStart,cell){document.querySelectorAll('.bar[data-node]:not([data-node=""])').forEach(bar=>{bar.onpointerdown=e=>{e.preventDefault();const edge=e.target.dataset.edge||'move',x0=e.clientX,origStart=bar.dataset.start,origEnd=bar.dataset.end;bar.setPointerCapture(e.pointerId);bar.style.cursor='grabbing';const move=ev=>{const delta=Math.round((ev.clientX-x0)/cell);let ns=origStart,ne=origEnd;if(edge==='move'){ns=addDays(origStart,delta);ne=addDays(origEnd,delta)}else if(edge==='left'){ns=addDays(origStart,delta);if(ns>ne)ns=ne}else{ne=addDays(origEnd,delta);if(ne<ns)ne=ns}bar.style.left=(diffDays(rangeStart,ns)*cell)+'px';bar.style.width=Math.max(cell,(diffDays(ns,ne)+1)*cell)+'px';bar.dataset.previewStart=ns;bar.dataset.previewEnd=ne};const up=ev=>{bar.releasePointerCapture(ev.pointerId);bar.removeEventListener('pointermove',move);bar.removeEventListener('pointerup',up);bar.style.cursor='grab';const ns=bar.dataset.previewStart||origStart,ne=bar.dataset.previewEnd||origEnd;delete bar.dataset.previewStart;delete bar.dataset.previewEnd;if(ns===origStart&&ne===origEnd)return render();openConfirm(bar.dataset.key,bar.dataset.node,origStart,origEnd,ns,ne)};bar.addEventListener('pointermove',move);bar.addEventListener('pointerup',up)}})}

  function openConfirm(key,nodeId,oldStart,oldEnd,newStart,newEnd){const row=state.rows.find(r=>r.key===key&&r.id===nodeId);state.pending={row,oldStart,oldEnd,newStart,newEnd,delta:diffDays(oldStart,newStart)};$('changeSummary').innerHTML=`<b>${esc(key)}</b><br>節點：${esc(row.nodeName)}<br><br>原日期：${esc(oldStart)}～${esc(oldEnd)}<br>新日期：${esc(newStart)}～${esc(newEnd)}`;const next=state.rows.filter(r=>r.key===key&&r.order>row.order).sort((a,b)=>a.order-b.order)[0];const conflict=next&&newEnd>next.start;$('conflictMessage').hidden=!conflict;$('conflictMessage').textContent=conflict?'本次調整會與下一個節點日期衝突。建議選擇「本節點及後續節點一起順延」。':'';$('confirmModal').classList.add('open');$('confirmModal').setAttribute('aria-hidden','false')}
  function closeConfirm(){state.pending=null;$('confirmModal').classList.remove('open');$('confirmModal').setAttribute('aria-hidden','true');render()}
  async function savePending(){const p=state.pending;if(!p)return;const mode=document.querySelector('input[name="applyMode"]:checked').value;const config=structuredClone(state.schedules[p.row.key]);const targets=(config.scheduleNodes||[]).filter(n=>n.id===p.row.id||(mode==='following'&&(n.sort_order||0)>p.row.order));const original=structuredClone(config);targets.forEach(n=>{const d={...(config.nodeDates?.[n.id]||{})};if(n.id===p.row.id){d.planned_start_date=p.newStart;d.planned_end_date=p.newEnd;d.planned_date=p.newEnd}else{const dates=nodeDates(config,n);d.planned_start_date=addDays(dates.start,p.delta);d.planned_end_date=addDays(dates.end,p.delta);d.planned_date=d.planned_end_date}config.nodeDates=config.nodeDates||{};config.nodeDates[n.id]=d});state.schedules[p.row.key]=config;closeModalOnly();try{if(state.source==='supabase')await window.WR_SUPABASE_SERVICE.updateProjectScheduleConfig(p.row.key,config);else localStorage.setItem(STORAGE_KEY,JSON.stringify(state.schedules));buildRows();render();banner('時程已儲存。','success')}catch(err){state.schedules[p.row.key]=original;buildRows();render();banner('儲存失敗，已恢復原日期：'+err.message,'error')}finally{state.pending=null}}
  function closeModalOnly(){$('confirmModal').classList.remove('open');$('confirmModal').setAttribute('aria-hidden','true')}

  ['filterStart','filterEnd','filterCustomer','filterStatus','viewMode','scaleMode','filterKeyword'].forEach(id=>$(id).addEventListener(id==='filterKeyword'?'input':'change',render));$('reloadBtn').onclick=()=>load().catch(e=>banner(e.message,'error'));$('cancelChangeBtn').onclick=closeConfirm;$('saveChangeBtn').onclick=savePending;
  load().catch(e=>banner(e.message,'error'));
})();
