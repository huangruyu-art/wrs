(function(){
  'use strict';

  const STORAGE_KEY='work-record-prototype-v9-project-schedules';
  const PRODUCT_KEY='work-record-prototype-v9-masters';
  const DAY=86400000;
  const TASK='TASK';
  const MILESTONE='MILESTONE';
  const $=id=>document.getElementById(id);
  const zooms=[
    {label:'日',cell:34},{label:'2日',cell:22},{label:'週',cell:12},
    {label:'月',cell:5},{label:'季',cell:2.2},{label:'半年',cell:1.2},{label:'年',cell:.65}
  ];
  const state={
    products:[],schedules:{},dbNodes:[],dbDependencies:[],rows:[],pending:null,
    source:'local',zoom:0,collapsed:new Set()
  };

  function iso(date){
    const y=date.getFullYear();
    const m=String(date.getMonth()+1).padStart(2,'0');
    const d=String(date.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }
  function parseDate(value){
    const match=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!match) return null;
    const date=new Date(Number(match[1]),Number(match[2])-1,Number(match[3]));
    return Number.isNaN(date.getTime())?null:date;
  }
  function addDays(value,days){
    const date=parseDate(value);
    if(!date) return value;
    date.setDate(date.getDate()+Number(days||0));
    return iso(date);
  }
  function diffDays(start,end){
    const a=parseDate(start),b=parseDate(end);
    return a&&b?Math.round((b-a)/DAY):0;
  }
  function escapeHtml(value){
    return String(value??'').replace(/[&<>"']/g,char=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[char]));
  }
  function banner(message,type=''){
    const element=$('statusBanner');
    if(!element) return;
    element.textContent=message||'';
    element.className=`status-banner ${type}`;
  }
  function parts(key){
    const [customer='',product='',spec='']=String(key||'').split('｜');
    return {customer,product,spec};
  }
  function production(name){ return /生產|試產|排產/.test(name||''); }
  function statusFor(key){
    return state.products.find(item=>[item.customer||'',item.product_name||'',item.spec||''].join('｜')===key)?.status||'進行中';
  }
  function nodeType(node,db){ return (node?.node_type||db?.node_type)===MILESTONE?MILESTONE:TASK; }
  function modeOf(value,db){ return (value?.data_mode||db?.data_mode)==='MANUAL'?'MANUAL':'AUTO'; }
  function datesOf(config,node,db){
    const value=(config.nodeDates||{})[node.id]||{};
    const plannedEnd=value.planned_end_date||value.planned_date||db?.planned_end_date||'';
    const plannedStart=value.planned_start_date||value.start_date||db?.planned_start_date||plannedEnd||'';
    const actualEnd=value.actual_end_date||value.actual_date||db?.actual_end_date||'';
    const actualStart=value.actual_start_date||db?.actual_start_date||'';
    return {
      plannedStart,plannedEnd,actualStart,actualEnd,
      start:plannedStart||actualStart||actualEnd,
      end:plannedEnd||plannedStart||actualEnd||actualStart,
      dataMode:modeOf(value,db)
    };
  }
  function normalizedDependencies(config,key){
    const local=Array.isArray(config?.dependencies)?config.dependencies:[];
    const database=state.dbDependencies.filter(dep=>dep.project_key===key&&!dep.deleted_at);
    const source=local.length?local:database;
    const ids=new Set((config?.scheduleNodes||[]).map(node=>String(node.id)));
    const seen=new Set();
    return source.flatMap(dep=>{
      const nodeId=String(dep?.node_id||'');
      const predecessorId=String(dep?.predecessor_node_id||'');
      if(!ids.has(nodeId)||!ids.has(predecessorId)||nodeId===predecessorId) return [];
      const unique=`${nodeId}\u0000${predecessorId}`;
      if(seen.has(unique)) return [];
      seen.add(unique);
      return [{
        node_id:nodeId,
        predecessor_node_id:predecessorId,
        dependency_type:'FS',
        lag_work_days:Math.max(0,Number(dep.lag_work_days||0))
      }];
    });
  }
  function descendants(config,key,startId){
    const deps=normalizedDependencies(config,key);
    const found=new Set([String(startId)]);
    const queue=[String(startId)];
    while(queue.length){
      const id=queue.shift();
      deps.filter(dep=>dep.predecessor_node_id===id).forEach(dep=>{
        if(!found.has(dep.node_id)){
          found.add(dep.node_id);
          queue.push(dep.node_id);
        }
      });
    }
    return found;
  }
  function constraintDate(row){
    const deps=normalizedDependencies(row.config,row.key).filter(dep=>dep.node_id===String(row.id));
    if(!deps.length) return '';
    const constraints=deps.map(dep=>{
      const predecessor=state.rows.find(item=>item.key===row.key&&String(item.id)===dep.predecessor_node_id);
      return predecessor?.plannedEnd?addWorkDaysLocal(predecessor.plannedEnd,dep.lag_work_days):'';
    });
    return constraints.some(value=>!value)?'':constraints.sort().slice(-1)[0];
  }
  function addWorkDaysLocal(value,days){
    let date=parseDate(value);
    if(!date) return value;
    let remaining=Math.max(0,Number(days||0));
    while(remaining>0){
      date.setDate(date.getDate()+1);
      if(![0,6].includes(date.getDay())) remaining--;
    }
    return iso(date);
  }

  async function load(){
    banner('載入時程中…');
    const service=window.WR_SUPABASE_SERVICE;
    if(service?.isReady?.()&&service.isAuthenticated?.()){
      const data=await service.loadGanttData();
      state.source='supabase';
      state.products=data.productSpecs||[];
      state.dbNodes=data.projectScheduleNodes||[];
      state.dbDependencies=data.projectScheduleNodeDependencies||[];
      state.schedules={};
      (data.projectSchedules||[]).forEach(row=>{ state.schedules[row.project_key]=row.config||{}; });
    }else{
      state.source='local';
      const masters=JSON.parse(localStorage.getItem(PRODUCT_KEY)||'{"productSpecs":[]}');
      state.products=masters.productSpecs||[];
      state.schedules=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');
      state.dbNodes=[];
      state.dbDependencies=[];
    }
    buildRows();
    populateFilters();
    setDefaultDates();
    render();
    banner('');
  }

  function buildRows(){
    state.rows=[];
    Object.entries(state.schedules).forEach(([key,config])=>{
      const project=parts(key);
      const nodes=(config.scheduleNodes||[]).slice().sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0));
      nodes.forEach((node,index)=>{
        const db=state.dbNodes.find(item=>item.project_key===key&&String(item.node_id)===String(node.id));
        const dates=datesOf(config,node,db);
        if(!dates.start&&!dates.end) return;
        const type=nodeType(node,db);
        const start=dates.start;
        const end=type===MILESTONE?start:dates.end;
        state.rows.push({
          id:String(node.id),key,customer:project.customer,product:project.product,spec:project.spec,
          nodeName:node.node_name||'',order:index+1,start,end,
          plannedStart:dates.plannedStart,plannedEnd:type===MILESTONE?(dates.plannedStart||dates.plannedEnd):dates.plannedEnd,
          actualStart:dates.actualStart,actualEnd:dates.actualEnd,actual:dates.actualEnd||'',
          dataMode:dates.dataMode,nodeType:type,status:statusFor(key),production:production(node.node_name),config,node
        });
      });
    });
  }

  function populateFilters(){
    const customers=[...new Set(state.products.map(item=>item.customer).filter(Boolean))].sort();
    $('filterCustomer').innerHTML='<option value="">全部客戶</option>'+customers.map(value=>`<option>${escapeHtml(value)}</option>`).join('');
    const statuses=[...new Set(state.products.map(item=>item.status||'進行中'))].sort();
    $('filterStatus').innerHTML='<option value="">全部狀態</option>'+statuses.map(value=>`<option>${escapeHtml(value)}</option>`).join('');
  }
  function setDefaultDates(){
    if($('filterStart').value) return;
    const dates=state.rows.flatMap(row=>[row.start,row.end]).filter(Boolean).sort();
    const now=new Date();
    $('filterStart').value=dates[0]||iso(new Date(now.getFullYear(),now.getMonth(),1));
    $('filterEnd').value=dates.at(-1)||iso(new Date(now.getFullYear(),now.getMonth()+2,0));
  }
  function filteredRows(){
    const start=$('filterStart').value;
    const end=$('filterEnd').value;
    const customer=$('filterCustomer').value;
    const status=$('filterStatus').value;
    const keyword=$('filterKeyword').value.trim().toLowerCase();
    const mode=$('viewMode').value;
    return state.rows.filter(row=>(!start||row.end>=start)&&(!end||row.start<=end)&&(!customer||row.customer===customer)&&(!status||row.status===status)&&(!keyword||`${row.key} ${row.nodeName}`.toLowerCase().includes(keyword))&&(mode!=='production'||row.production));
  }

  function render(){
    const start=$('filterStart').value;
    const end=$('filterEnd').value;
    if(!start||!end||start>end){ banner('日期區間不正確。','error'); return; }
    const rows=filteredRows();
    const mode=$('viewMode').value;
    const cell=zooms[state.zoom].cell;
    const days=diffDays(start,end)+1;
    const timelineWidth=Math.max(days*cell,600);
    $('zoomLabel').textContent=zooms[state.zoom].label;

    const groups=new Map();
    rows.forEach(row=>{
      if(!groups.has(row.key)) groups.set(row.key,[]);
      groups.get(row.key).push(row);
    });
    $('ganttEmpty').hidden=groups.size>0;

    let html=`<div class="v121-gantt" style="--timeline-width:${timelineWidth}px;--cell:${cell}px">
      <div class="v121-gantt-header"><div class="v121-left-header">專案 / 節點</div><div class="v121-timeline-header" style="width:${timelineWidth}px">${dateHeader(start,days,cell)}</div></div>
      <div class="v121-gantt-body">`;

    groups.forEach((list,key)=>{
      const collapsed=state.collapsed.has(key);
      const projectStart=list.map(row=>row.start).sort()[0];
      const projectEnd=list.map(row=>row.end).sort().at(-1);
      html+=projectRow(key,projectStart,projectEnd,start,cell,collapsed,timelineWidth);
      if(mode!=='projects'&&!collapsed){
        list.sort((a,b)=>a.order-b.order).forEach(row=>{ html+=nodeRow(row,start,cell,timelineWidth); });
      }
    });
    html+='</div><svg id="v121DependencySvg" class="v121-dependency-svg" aria-hidden="true"></svg></div>';
    $('ganttCanvas').innerHTML=html;
    bindCollapse();
    bindDrag(start,cell);
    requestAnimationFrame(drawDependencies);
  }

  function dateHeader(start,days,cell){
    let html='';
    for(let index=0;index<days;index++){
      const date=parseDate(addDays(start,index));
      const weekend=[0,6].includes(date.getDay());
      const show=cell>=10||date.getDate()===1;
      html+=`<div class="v121-date-cell ${weekend?'weekend':''}" style="left:${index*cell}px;width:${cell}px">${show?`<b>${date.getDate()}</b><small>${date.getDate()===1?`${date.getMonth()+1}月`:''}</small>`:''}</div>`;
    }
    return html;
  }
  function projectRow(key,start,end,rangeStart,cell,collapsed,width){
    const left=diffDays(rangeStart,start)*cell;
    const barWidth=Math.max(cell,(diffDays(start,end)+1)*cell);
    return `<div class="v121-row v121-project-row" data-project-row="${escapeHtml(key)}">
      <button class="v121-row-label v121-project-label" type="button" data-collapse="${escapeHtml(key)}">${collapsed?'▶':'▼'} ${escapeHtml(key)}</button>
      <div class="v121-row-timeline" style="width:${width}px"><div class="v121-project-bar" style="left:${left}px;width:${barWidth}px">${escapeHtml(key)}</div></div>
    </div>`;
  }
  function nodeRow(row,rangeStart,cell,width){
    const left=diffDays(rangeStart,row.start)*cell;
    const barWidth=Math.max(cell,(diffDays(row.start,row.end)+1)*cell);
    const allowed=constraintDate(row);
    const conflict=row.dataMode==='MANUAL'&&allowed&&row.plannedStart&&row.plannedStart<allowed;
    const classes=[row.nodeType===MILESTONE?'milestone':'task',row.actual?'completed':'',row.production?'production':'',conflict?'conflict':''].filter(Boolean).join(' ');
    const typeLabel=row.nodeType===MILESTONE?'◆':'▰';
    const modeLabel=row.dataMode==='MANUAL'?'MANUAL':'AUTO';
    const title=`${row.nodeName}\n${row.start}～${row.end}\n${modeLabel}${conflict?`\n衝突：最早可開始 ${allowed}`:''}`;
    const bar=row.nodeType===MILESTONE
      ?`<div class="v121-bar ${classes}" data-key="${escapeHtml(row.key)}" data-node="${escapeHtml(row.id)}" data-start="${row.start}" data-end="${row.end}" title="${escapeHtml(title)}" style="left:${left}px"><span>${escapeHtml(row.nodeName)}</span></div>`
      :`<div class="v121-bar ${classes}" data-key="${escapeHtml(row.key)}" data-node="${escapeHtml(row.id)}" data-start="${row.start}" data-end="${row.end}" title="${escapeHtml(title)}" style="left:${left}px;width:${barWidth}px"><i data-edge="left"></i><span>${escapeHtml(row.nodeName)}</span><i data-edge="right"></i></div>`;
    return `<div class="v121-row v121-node-row" data-key="${escapeHtml(row.key)}" data-node-row="${escapeHtml(row.id)}">
      <div class="v121-row-label"><b>${typeLabel} ${escapeHtml(row.nodeName)}</b><small>${modeLabel}${conflict?`　⚠ 最早 ${allowed}`:''}</small></div>
      <div class="v121-row-timeline" style="width:${width}px">${bar}</div>
    </div>`;
  }

  function bindCollapse(){
    document.querySelectorAll('[data-collapse]').forEach(button=>{
      button.onclick=()=>{
        const key=button.dataset.collapse;
        state.collapsed.has(key)?state.collapsed.delete(key):state.collapsed.add(key);
        render();
      };
    });
  }
  function bindDrag(rangeStart,cell){
    document.querySelectorAll('.v121-bar[data-node]').forEach(bar=>{
      bar.onpointerdown=event=>{
        event.preventDefault();
        const row=state.rows.find(item=>item.key===bar.dataset.key&&String(item.id)===String(bar.dataset.node));
        if(!row) return;
        const milestone=row.nodeType===MILESTONE;
        const edge=milestone?'move':(event.target.dataset.edge||'move');
        const pointerStart=event.clientX;
        const oldStart=bar.dataset.start;
        const oldEnd=bar.dataset.end;
        bar.setPointerCapture(event.pointerId);
        const move=moveEvent=>{
          const delta=Math.round((moveEvent.clientX-pointerStart)/cell);
          let nextStart=oldStart;
          let nextEnd=oldEnd;
          if(edge==='move'||milestone){
            nextStart=addDays(oldStart,delta);
            nextEnd=milestone?nextStart:addDays(oldEnd,delta);
          }else if(edge==='left'){
            nextStart=addDays(oldStart,delta);
            if(nextStart>nextEnd) nextStart=nextEnd;
          }else{
            nextEnd=addDays(oldEnd,delta);
            if(nextEnd<nextStart) nextEnd=nextStart;
          }
          bar.style.left=`${diffDays(rangeStart,nextStart)*cell}px`;
          if(!milestone) bar.style.width=`${Math.max(cell,(diffDays(nextStart,nextEnd)+1)*cell)}px`;
          bar.dataset.pendingStart=nextStart;
          bar.dataset.pendingEnd=nextEnd;
        };
        const up=upEvent=>{
          bar.releasePointerCapture(upEvent.pointerId);
          bar.removeEventListener('pointermove',move);
          bar.removeEventListener('pointerup',up);
          const nextStart=bar.dataset.pendingStart||oldStart;
          const nextEnd=bar.dataset.pendingEnd||oldEnd;
          delete bar.dataset.pendingStart;
          delete bar.dataset.pendingEnd;
          if(nextStart===oldStart&&nextEnd===oldEnd){ render(); return; }
          confirmChange(row,oldStart,oldEnd,nextStart,nextEnd);
        };
        bar.addEventListener('pointermove',move);
        bar.addEventListener('pointerup',up);
      };
    });
  }

  function confirmChange(row,oldStart,oldEnd,newStart,newEnd){
    const delta=diffDays(oldStart,newStart);
    state.pending={row,oldStart,oldEnd,newStart,newEnd,delta};
    $('changeSummary').innerHTML=`<b>${escapeHtml(row.key)}</b><br>節點：${escapeHtml(row.nodeName)}<br><br>原日期：${oldStart}～${oldEnd}<br>新日期：${newStart}～${newEnd}`;
    const successors=normalizedDependencies(row.config,row.key).filter(dep=>dep.predecessor_node_id===String(row.id));
    const conflicts=successors.flatMap(dep=>{
      const child=state.rows.find(item=>item.key===row.key&&String(item.id)===dep.node_id);
      const allowed=addWorkDaysLocal(newEnd,dep.lag_work_days);
      return child&&child.start<allowed?[`${child.nodeName} 最早應於 ${allowed} 開始`]:[];
    });
    $('conflictMessage').hidden=!conflicts.length;
    $('conflictMessage').textContent=conflicts.length?`本次調整會造成前置任務衝突：${conflicts.join('；')}`:'';
    const followingLabel=document.querySelector('input[name="applyMode"][value="following"]')?.closest('label');
    if(followingLabel) followingLabel.lastChild.textContent=' 本節點及相依的後續節點一起順延';
    $('confirmModal').classList.add('open');
    $('confirmModal').setAttribute('aria-hidden','false');
  }
  function closeModal(){
    state.pending=null;
    $('confirmModal').classList.remove('open');
    $('confirmModal').setAttribute('aria-hidden','true');
    render();
  }

  async function saveChange(){
    const pending=state.pending;
    if(!pending) return;
    const mode=document.querySelector('input[name="applyMode"]:checked')?.value||'single';
    const config=structuredClone(state.schedules[pending.row.key]||{});
    config.nodeDates=config.nodeDates||{};
    const affected=mode==='following'?descendants(config,pending.row.key,pending.row.id):new Set([String(pending.row.id)]);
    const updates=[];

    (config.scheduleNodes||[]).forEach((node,index)=>{
      const id=String(node.id);
      if(!affected.has(id)) return;
      const oldRow=state.rows.find(item=>item.key===pending.row.key&&String(item.id)===id);
      if(!oldRow) return;
      const isCurrent=id===String(pending.row.id);
      const type=nodeType(node,state.dbNodes.find(item=>item.project_key===pending.row.key&&String(item.node_id)===id));
      let start=isCurrent?pending.newStart:addDays(oldRow.start,pending.delta);
      let end=isCurrent?pending.newEnd:addDays(oldRow.end,pending.delta);
      if(type===MILESTONE) end=start;
      const previous=config.nodeDates[id]||{};
      config.nodeDates[id]={
        ...previous,
        planned_start_date:start,
        planned_end_date:end,
        planned_date:end,
        data_mode:'MANUAL'
      };
      updates.push({
        node_id:id,
        node_name:node.node_name||'',
        sort_order:Number(node.sort_order||index+1),
        node_type:type,
        data_mode:'MANUAL',
        planned_start_date:start,
        planned_end_date:end,
        actual_start_date:previous.actual_start_date||null,
        actual_end_date:previous.actual_end_date||previous.actual_date||null
      });
    });

    state.schedules[pending.row.key]=config;
    $('confirmModal').classList.remove('open');
    try{
      if(state.source==='supabase'){
        await window.WR_SUPABASE_SERVICE.updateProjectScheduleDates(pending.row.key,config,updates);
      }else{
        localStorage.setItem(STORAGE_KEY,JSON.stringify(state.schedules));
      }
      await load();
      banner(mode==='following'?'時程已儲存，並順延相依的後續節點。':'時程已儲存。','success');
    }catch(error){
      await load();
      banner(`儲存失敗，已恢復原日期：${error?.message||error}`,'error');
    }finally{
      state.pending=null;
    }
  }

  function drawDependencies(){
    const canvas=$('ganttCanvas');
    const svg=$('v121DependencySvg');
    if(!canvas||!svg) return;
    const canvasRect=canvas.getBoundingClientRect();
    svg.setAttribute('width',String(canvas.scrollWidth));
    svg.setAttribute('height',String(canvas.scrollHeight));
    svg.setAttribute('viewBox',`0 0 ${canvas.scrollWidth} ${canvas.scrollHeight}`);
    svg.innerHTML='<defs><marker id="v121Arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker></defs>';
    const paths=[];
    Object.entries(state.schedules).forEach(([key,config])=>{
      normalizedDependencies(config,key).forEach(dep=>{
        const from=canvas.querySelector(`.v121-bar[data-key="${CSS.escape(key)}"][data-node="${CSS.escape(dep.predecessor_node_id)}"]`);
        const to=canvas.querySelector(`.v121-bar[data-key="${CSS.escape(key)}"][data-node="${CSS.escape(dep.node_id)}"]`);
        if(!from||!to) return;
        const a=from.getBoundingClientRect();
        const b=to.getBoundingClientRect();
        const x1=a.right-canvasRect.left;
        const y1=a.top+a.height/2-canvasRect.top;
        const x2=b.left-canvasRect.left;
        const y2=b.top+b.height/2-canvasRect.top;
        const mid=Math.max(x1+12,(x1+x2)/2);
        paths.push(`<path d="M ${x1} ${y1} H ${mid} V ${y2} H ${x2}" marker-end="url(#v121Arrow)"></path>`);
      });
    });
    svg.insertAdjacentHTML('beforeend',paths.join(''));
  }

  function zoom(delta){
    const scroller=$('ganttScroller');
    const oldCell=zooms[state.zoom].cell;
    const center=(scroller.scrollLeft+scroller.clientWidth/2)/Math.max(oldCell,.01);
    state.zoom=Math.max(0,Math.min(zooms.length-1,state.zoom+delta));
    render();
    scroller.scrollLeft=Math.max(0,center*zooms[state.zoom].cell-scroller.clientWidth/2);
  }
  function today(){
    const todayValue=iso(new Date());
    if(todayValue<$('filterStart').value||todayValue>$('filterEnd').value){
      $('filterStart').value=addDays(todayValue,-30);
      $('filterEnd').value=addDays(todayValue,90);
      render();
    }
    const scroller=$('ganttScroller');
    scroller.scrollLeft=Math.max(0,diffDays($('filterStart').value,todayValue)*zooms[state.zoom].cell-scroller.clientWidth/2);
  }
  function fit(){
    const rows=filteredRows();
    if(!rows.length) return;
    $('filterStart').value=rows.map(row=>row.start).sort()[0];
    $('filterEnd').value=rows.map(row=>row.end).sort().at(-1);
    render();
  }

  function injectStyle(){
    if(document.getElementById('v121-gantt-style')) return;
    const style=document.createElement('style');
    style.id='v121-gantt-style';
    style.textContent=`
      #ganttCanvas{position:relative;min-width:max-content}.v121-gantt{position:relative;min-width:calc(280px + var(--timeline-width));font-size:13px}
      .v121-gantt-header,.v121-row{display:grid;grid-template-columns:280px var(--timeline-width)}
      .v121-gantt-header{position:sticky;top:0;z-index:8;background:#fff;border-bottom:1px solid #cbd5e1;height:48px}
      .v121-left-header{position:sticky;left:0;z-index:10;padding:14px;font-weight:800;background:#f8fafc;border-right:1px solid #cbd5e1}
      .v121-timeline-header,.v121-row-timeline{position:relative;min-height:48px;background-image:linear-gradient(to right,rgba(148,163,184,.25) 1px,transparent 1px);background-size:var(--cell) 100%}
      .v121-date-cell{position:absolute;top:0;bottom:0;padding:6px 2px;text-align:center;border-right:1px solid rgba(148,163,184,.25);overflow:hidden}.v121-date-cell.weekend{background:rgba(241,245,249,.8)}.v121-date-cell b,.v121-date-cell small{display:block;font-size:11px}
      .v121-row{min-height:48px;border-bottom:1px solid #e2e8f0}.v121-row-label{position:sticky;left:0;z-index:5;border:0;border-right:1px solid #cbd5e1;background:#fff;text-align:left;padding:8px 12px;display:grid;align-content:center;gap:2px;min-width:0}.v121-row-label b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.v121-row-label small{color:#64748b;font-size:11px}
      .v121-project-row{background:#eef2ff}.v121-project-label{background:#eef2ff;font-weight:800;cursor:pointer}.v121-project-bar{position:absolute;top:10px;height:28px;border-radius:7px;background:#475569;color:#fff;padding:5px 8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .v121-bar{position:absolute;top:10px;height:28px;border-radius:7px;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;cursor:grab;user-select:none;z-index:3;min-width:12px}.v121-bar span{padding:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}.v121-bar i{width:7px;align-self:stretch;cursor:ew-resize;background:rgba(255,255,255,.15)}
      .v121-bar.completed{background:#15803d}.v121-bar.production{outline:2px solid #f59e0b}.v121-bar.conflict{box-shadow:0 0 0 3px #dc2626}.v121-bar.milestone{width:18px!important;height:18px;top:15px;border-radius:2px;transform:rotate(45deg);overflow:visible}.v121-bar.milestone span{position:absolute;left:16px;top:-7px;transform:rotate(-45deg);color:#1e293b;background:#fff;padding:2px 5px;border-radius:4px;overflow:visible}.v121-bar.milestone i{display:none}
      .v121-dependency-svg{position:absolute;inset:0;pointer-events:none;z-index:2;overflow:visible}.v121-dependency-svg path{fill:none;stroke:#64748b;stroke-width:1.5}.v121-dependency-svg marker path{fill:#64748b;stroke:none}
      @media(max-width:700px){.v121-gantt-header,.v121-row{grid-template-columns:210px var(--timeline-width)}.v121-gantt{min-width:calc(210px + var(--timeline-width))}}
    `;
    document.head.appendChild(style);
  }

  function init(){
    document.title=document.title.replace(/Version\s+[0-9.]+/,'Version 1.2.1');
    injectStyle();
    ['filterStart','filterEnd','filterCustomer','filterStatus','viewMode'].forEach(id=>$(id)?.addEventListener('change',render));
    $('filterKeyword')?.addEventListener('input',render);
    $('zoomOutBtn').onclick=()=>zoom(1);
    $('zoomInBtn').onclick=()=>zoom(-1);
    $('todayBtn').onclick=today;
    $('fitAllBtn').onclick=fit;
    $('cancelChangeBtn').onclick=closeModal;
    $('saveChangeBtn').onclick=saveChange;
    $('ganttScroller').addEventListener('wheel',event=>{
      if(event.ctrlKey){ event.preventDefault(); zoom(event.deltaY>0?1:-1); }
    },{passive:false});
    $('ganttScroller').addEventListener('scroll',()=>requestAnimationFrame(drawDependencies));
    window.addEventListener('resize',()=>requestAnimationFrame(drawDependencies));
    load().catch(error=>banner(error?.message||String(error),'error'));
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
