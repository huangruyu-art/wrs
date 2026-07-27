(function(){
  'use strict';
  if(typeof state==='undefined'||typeof writeStore!=='function'||typeof renderAll!=='function') return;

  const AUTO='AUTO';
  const MANUAL='MANUAL';
  const originalEnsure=ensureProjectScheduleCopy;
  const originalSetStateFromRemote=typeof setStateFromRemote==='function'?setStateFromRemote:null;

  function own(obj,key){ return Object.prototype.hasOwnProperty.call(obj||{},key); }
  function modeOf(value){ return value?.data_mode===MANUAL?MANUAL:AUTO; }
  function ordered(config){
    return (config?.scheduleNodes||[]).slice().sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0));
  }
  function datesOf(value={}){
    const hasPlannedStart=own(value,'planned_start_date')||own(value,'start_date');
    const hasPlannedEnd=own(value,'planned_end_date')||own(value,'planned_date');
    const plannedEnd=hasPlannedEnd?(value.planned_end_date||value.planned_date||''):'';
    const plannedStart=hasPlannedStart?(value.planned_start_date||value.start_date||''):(plannedEnd||'');
    const hasActualEnd=own(value,'actual_end_date')||own(value,'actual_date');
    return {
      ...value,
      planned_start_date:plannedStart,
      planned_end_date:plannedEnd,
      actual_start_date:own(value,'actual_start_date')?(value.actual_start_date||''):'',
      actual_end_date:hasActualEnd?(value.actual_end_date||value.actual_date||''):'',
      data_mode:modeOf(value)
    };
  }
  function hasAnyDates(config){
    return Object.values(config?.nodeDates||{}).some(value=>{
      const d=datesOf(value);
      return d.planned_start_date||d.planned_end_date||d.actual_start_date||d.actual_end_date;
    });
  }
  function hasPlannedDates(config){
    return Object.values(config?.nodeDates||{}).some(value=>{
      const d=datesOf(value);
      return d.planned_start_date||d.planned_end_date;
    });
  }
  function storeConfig(key,config,{render=true,message=''}={}){
    state.projectSchedules[key]=config;
    writeStore();
    if(render) renderAll();
    if(message) toast(message);
  }
  function forwardRows(config,startIndex,endIndex,anchor,nodeDates){
    const nodes=ordered(config);
    let cursor=anchor;
    for(let i=startIndex;i<=endIndex;i++){
      const node=nodes[i];
      if(!node||!cursor) break;
      const old=datesOf(nodeDates[node.id]||{});
      const end=addWorkDays(cursor,Number(node.work_days||0));
      nodeDates[node.id]={...old,planned_start_date:cursor,planned_end_date:end,data_mode:AUTO};
      cursor=end;
    }
  }
  function backwardRows(config,startIndex,endIndex,anchor,nodeDates){
    const nodes=ordered(config);
    let cursor=anchor;
    for(let i=endIndex;i>=startIndex;i--){
      const node=nodes[i];
      if(!node||!cursor) break;
      const old=datesOf(nodeDates[node.id]||{});
      const start=subtractWorkDays(cursor,Number(node.work_days||0));
      nodeDates[node.id]={...old,planned_start_date:start,planned_end_date:cursor,data_mode:AUTO};
      cursor=start;
    }
  }
  function initializeDates(config,direction){
    const nodes=ordered(config);
    const nodeDates={...(config.nodeDates||{})};
    if(!nodes.length) return {...config,nodeDates,scheduleInitialized:true};
    if(direction==='backward'){
      if(!config.targetDate) return config;
      backwardRows(config,0,nodes.length-1,config.targetDate,nodeDates);
    }else{
      if(!config.baseDate) return config;
      forwardRows(config,0,nodes.length-1,config.baseDate,nodeDates);
    }
    return {...config,nodeDates,scheduleInitialized:true};
  }
  function migrateConfig(config){
    let next={...config,nodeDates:{...(config?.nodeDates||{})}};
    let changed=false;
    Object.entries(next.nodeDates).forEach(([id,value])=>{
      const normalized=datesOf(value);
      if(!own(value,'data_mode')){
        normalized.data_mode=(normalized.planned_start_date||normalized.planned_end_date||normalized.actual_start_date||normalized.actual_end_date)?MANUAL:AUTO;
        changed=true;
      }
      next.nodeDates[id]=normalized;
    });
    if(!next.v120Migrated){
      if(!hasPlannedDates(next)&&(next.baseDate||next.targetDate)){
        const direction=(next.mode==='backward'||(!next.baseDate&&next.targetDate))?'backward':'forward';
        next=initializeDates({...next,mode:direction},direction);
      }
      next.scheduleInitialized=Boolean(next.scheduleInitialized||hasAnyDates(next)||next.baseDate||next.targetDate);
      next.v120Migrated=true;
      changed=true;
    }
    return {config:next,changed};
  }
  function migrateAll(){
    let changed=false;
    Object.keys(state.projectSchedules||{}).forEach(key=>{
      const result=migrateConfig(state.projectSchedules[key]||{});
      state.projectSchedules[key]=result.config;
      changed=changed||result.changed;
    });
    if(changed){
      try{ localStorage.setItem(SCHEDULE_STORAGE_KEY,JSON.stringify(state.projectSchedules)); }catch(_){ }
    }
  }

  ensureProjectScheduleCopy=function(key,shouldPersist=true){
    const config=originalEnsure(key,shouldPersist);
    if(!config) return config;
    const result=migrateConfig(config);
    if(shouldPersist) state.projectSchedules[key]=result.config;
    return result.config;
  };

  normalizeScheduleDates=function(value={}){ return datesOf(value); };

  calculateProjectSchedule=function(key){
    const config=ensureProjectScheduleCopy(key,true)||getScheduleForProject(key);
    const saved=config.nodeDates||{};
    return ordered(config).map(node=>{
      const d=datesOf(saved[node.id]||{});
      return {
        ...node,
        ...d,
        calculated_start_date:d.planned_start_date,
        calculated_end_date:d.planned_end_date
      };
    });
  };

  updateProjectSchedule=function(key,field,value){
    let config=ensureProjectScheduleCopy(key,true)||getScheduleForProject(key);
    config={...config,nodeDates:{...(config.nodeDates||{})},[field]:value};
    if((field==='baseDate'||field==='targetDate')&&value&&!config.scheduleInitialized&&!hasAnyDates(config)){
      const direction=field==='targetDate'?'backward':'forward';
      config={...config,mode:direction};
      config=initializeDates(config,direction);
      storeConfig(key,config,{message:'已依工作日完成第一次日期推算'});
      return;
    }
    storeConfig(key,config,{message:'已更新上市時程；既有節點日期未重新推算'});
  };

  updateProjectScheduleNodeDate=function(key,nodeId,field,value){
    const config=ensureProjectScheduleCopy(key,true)||getScheduleForProject(key);
    const nodeDates={...(config.nodeDates||{})};
    nodeDates[nodeId]={...datesOf(nodeDates[nodeId]||{}),[field]:value,data_mode:MANUAL};
    storeConfig(key,{...config,nodeDates,scheduleInitialized:true},{message:value?'已儲存手動日期（MANUAL）':'日期已清空並保留為手動設定（MANUAL）'});
  };

  function recalculate(key,nodeId,scope){
    const config=ensureProjectScheduleCopy(key,true)||getScheduleForProject(key);
    const nodes=ordered(config);
    const index=nodes.findIndex(node=>String(node.id)===String(nodeId));
    if(index<0) return toast('找不到要重新計算的節點');
    const nodeDates={...(config.nodeDates||{})};

    if(scope==='all'){
      if(config.mode==='backward'){
        const last=datesOf(nodeDates[nodes.at(-1)?.id]||{});
        const anchor=config.targetDate||last.planned_end_date;
        if(!anchor) return toast('請先輸入目標上市／可出貨日，或最後節點的預計完成日');
        backwardRows(config,0,nodes.length-1,anchor,nodeDates);
      }else{
        const first=datesOf(nodeDates[nodes[0]?.id]||{});
        const anchor=config.baseDate||first.planned_start_date;
        if(!anchor) return toast('請先輸入第一節點起算日，或第一節點的預計開始日');
        forwardRows(config,0,nodes.length-1,anchor,nodeDates);
      }
    }else{
      const current=datesOf(nodeDates[nodes[index].id]||{});
      const previous=index>0?datesOf(nodeDates[nodes[index-1].id]||{}):null;
      const anchor=(index===0?(config.baseDate||current.planned_start_date):(previous?.planned_end_date||current.planned_start_date));
      if(!anchor&&scope==='single'&&current.planned_end_date){
        const start=subtractWorkDays(current.planned_end_date,Number(nodes[index].work_days||0));
        nodeDates[nodes[index].id]={...current,planned_start_date:start,planned_end_date:current.planned_end_date,data_mode:AUTO};
      }else{
        if(!anchor) return toast('目前節點缺少可供重新計算的起始日期');
        const endIndex=scope==='single'?index:nodes.length-1;
        forwardRows(config,index,endIndex,anchor,nodeDates);
      }
    }

    storeConfig(key,{...config,nodeDates,scheduleInitialized:true},{message:'已重新計算日期；指定範圍恢復 AUTO'});
  }

  function decorateEditors(){
    document.querySelectorAll('.schedule-editor').forEach(editor=>{
      if(!editor.querySelector('.v120-rule-note')){
        const note=document.createElement('p');
        note.className='v120-rule-note';
        note.textContent='第一次輸入起算日或目標日才會自動推算；之後修改或清空節點日期均保留為 MANUAL，除非按「重新計算日期」。';
        editor.querySelector('h4')?.insertAdjacentElement('afterend',note);
      }
    });
    document.querySelectorAll('.editable-schedule-table tbody tr').forEach(row=>{
      if(row.querySelector('.v120-recalc-controls')) return;
      const source=row.querySelector('[data-node-id]');
      const nodeId=source?.dataset.nodeId;
      const key=source?.dataset.scheduleDate||source?.dataset.projectNodeName||source?.dataset.projectNodeDays;
      const cell=row.lastElementChild;
      if(!nodeId||!key||!cell) return;
      const config=state.projectSchedules[key]||{};
      const mode=modeOf((config.nodeDates||{})[nodeId]);
      const controls=document.createElement('span');
      controls.className='v120-recalc-controls';
      controls.innerHTML=`<input type="hidden" value="${mode}" data-node-data-mode="${mode}"><select aria-label="重新計算日期範圍"><option value="following" selected>本節點＋後續</option><option value="single">僅本節點</option><option value="all">整個專案</option></select><button class="mini" type="button">重新計算日期</button>`;
      controls.querySelector('button').onclick=()=>recalculate(key,nodeId,controls.querySelector('select').value);
      cell.appendChild(controls);
    });
  }

  if(originalSetStateFromRemote){
    setStateFromRemote=function(remote){
      originalSetStateFromRemote(remote);
      migrateAll();
    };
  }

  if(!document.getElementById('v120-schedule-style')){
    const style=document.createElement('style');
    style.id='v120-schedule-style';
    style.textContent='.v120-rule-note{margin:6px 0 12px;color:#475569;font-size:13px}.v120-recalc-controls{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:6px}.v120-recalc-controls select{max-width:135px;padding:5px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px}';
    document.head.appendChild(style);
  }

  migrateAll();
  renderAll();
  decorateEditors();
  new MutationObserver(decorateEditors).observe(document.body,{childList:true,subtree:true});
  window.WR_SCHEDULE_V120={recalculate,AUTO,MANUAL};
})();
