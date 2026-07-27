(function(){
  'use strict';

  if(typeof state==='undefined'||typeof writeStore!=='function'||typeof renderAll!=='function') return;

  const TASK='TASK';
  const MILESTONE='MILESTONE';
  const AUTO='AUTO';
  const MANUAL='MANUAL';
  const originalEnsure=typeof ensureProjectScheduleCopy==='function'?ensureProjectScheduleCopy:null;
  const originalSetStateFromRemote=typeof setStateFromRemote==='function'?setStateFromRemote:null;

  function own(obj,key){ return Object.prototype.hasOwnProperty.call(obj||{},key); }
  function typeOf(node){ return node?.node_type===MILESTONE?MILESTONE:TASK; }
  function modeOf(value){ return value?.data_mode===MANUAL?MANUAL:AUTO; }
  function ordered(config){
    return (config?.scheduleNodes||[]).slice().sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0));
  }
  function datesOf(value={}){
    const plannedEnd=own(value,'planned_end_date')||own(value,'planned_date')?(value.planned_end_date||value.planned_date||''):'';
    const plannedStart=own(value,'planned_start_date')||own(value,'start_date')?(value.planned_start_date||value.start_date||''):(plannedEnd||'');
    return {
      ...value,
      planned_start_date:plannedStart,
      planned_end_date:plannedEnd,
      actual_start_date:own(value,'actual_start_date')?(value.actual_start_date||''):'',
      actual_end_date:own(value,'actual_end_date')||own(value,'actual_date')?(value.actual_end_date||value.actual_date||''):'',
      data_mode:modeOf(value)
    };
  }
  function normalizeDependencies(config={}){
    const ids=new Set((config.scheduleNodes||[]).map(node=>String(node.id)));
    const seen=new Set();
    return (Array.isArray(config.dependencies)?config.dependencies:[]).flatMap(dep=>{
      const nodeId=String(dep?.node_id||'');
      const predecessorId=String(dep?.predecessor_node_id||'');
      if(!ids.has(nodeId)||!ids.has(predecessorId)||nodeId===predecessorId) return [];
      const key=`${nodeId}\u0000${predecessorId}`;
      if(seen.has(key)) return [];
      seen.add(key);
      return [{
        node_id:nodeId,
        predecessor_node_id:predecessorId,
        dependency_type:'FS',
        lag_work_days:Math.max(0,Number(dep.lag_work_days||0))
      }];
    });
  }
  function migrateConfig(config={}){
    const next={...config};
    next.scheduleNodes=ordered(next).map(node=>({
      ...node,
      node_type:typeOf(node),
      work_days:typeOf(node)===MILESTONE?0:Math.max(0,Number(node.work_days||0))
    }));
    next.nodeDates={...(next.nodeDates||{})};
    next.scheduleNodes.forEach(node=>{
      next.nodeDates[node.id]=datesOf(next.nodeDates[node.id]||{});
    });
    next.dependencies=normalizeDependencies(next);
    next.v121Migrated=true;
    return next;
  }
  function migrateAll(){
    Object.keys(state.projectSchedules||{}).forEach(key=>{
      state.projectSchedules[key]=migrateConfig(state.projectSchedules[key]||{});
    });
    try{
      if(typeof SCHEDULE_STORAGE_KEY!=='undefined') localStorage.setItem(SCHEDULE_STORAGE_KEY,JSON.stringify(state.projectSchedules));
    }catch(_){ }
  }
  function storeConfig(key,config,{message='',render=true}={}){
    state.projectSchedules[key]=migrateConfig(config);
    writeStore();
    if(render) renderAll();
    if(message&&typeof toast==='function') toast(message);
  }
  function dependenciesFor(config,nodeId){
    return normalizeDependencies(config).filter(dep=>String(dep.node_id)===String(nodeId));
  }
  function successorsFor(config,nodeId){
    return normalizeDependencies(config).filter(dep=>String(dep.predecessor_node_id)===String(nodeId));
  }
  function topological(config){
    const nodes=ordered(config);
    const ids=nodes.map(node=>String(node.id));
    const indegree=new Map(ids.map(id=>[id,0]));
    const next=new Map(ids.map(id=>[id,[]]));
    normalizeDependencies(config).forEach(dep=>{
      indegree.set(dep.node_id,(indegree.get(dep.node_id)||0)+1);
      next.get(dep.predecessor_node_id)?.push(dep.node_id);
    });
    const queue=ids.filter(id=>(indegree.get(id)||0)===0);
    const result=[];
    while(queue.length){
      const id=queue.shift();
      result.push(id);
      (next.get(id)||[]).forEach(child=>{
        indegree.set(child,(indegree.get(child)||0)-1);
        if(indegree.get(child)===0) queue.push(child);
      });
    }
    return result.length===ids.length?result:null;
  }
  function hasCycle(config){ return !topological(config); }
  function descendants(config,startId){
    const found=new Set([String(startId)]);
    const queue=[String(startId)];
    while(queue.length){
      const id=queue.shift();
      successorsFor(config,id).forEach(dep=>{
        const child=String(dep.node_id);
        if(!found.has(child)){
          found.add(child);
          queue.push(child);
        }
      });
    }
    return found;
  }
  function latest(values){ return values.filter(Boolean).sort().slice(-1)[0]||''; }
  function earliest(values){ return values.filter(Boolean).sort()[0]||''; }
  function addLag(date,days){ return Number(days||0)>0?addWorkDays(date,Number(days||0)):date; }
  function subtractLag(date,days){ return Number(days||0)>0?subtractWorkDays(date,Number(days||0)):date; }

  function forwardRecalculate(config,selectedIds){
    const nodes=ordered(config);
    const nodeMap=new Map(nodes.map(node=>[String(node.id),node]));
    const order=topological(config);
    if(!order) throw new Error('前置任務形成循環，無法重新計算。');
    const nodeDates={...(config.nodeDates||{})};

    order.forEach(id=>{
      if(!selectedIds.has(id)) return;
      const node=nodeMap.get(id);
      const deps=dependenciesFor(config,id);
      let start='';
      if(deps.length){
        const constraints=deps.map(dep=>{
          const predecessor=datesOf(nodeDates[dep.predecessor_node_id]||{});
          return predecessor.planned_end_date?addLag(predecessor.planned_end_date,dep.lag_work_days):'';
        });
        if(constraints.some(value=>!value)) throw new Error(`「${node.node_name||id}」的前置任務尚未有預計完成日。`);
        start=latest(constraints);
      }else{
        const current=datesOf(nodeDates[id]||{});
        start=config.baseDate||current.planned_start_date;
        if(!start) throw new Error(`「${node.node_name||id}」沒有前置任務，請先設定專案起算日或該節點開始日。`);
      }
      const end=typeOf(node)===MILESTONE?start:addWorkDays(start,Math.max(0,Number(node.work_days||0)));
      nodeDates[id]={...datesOf(nodeDates[id]||{}),planned_start_date:start,planned_end_date:end,planned_date:end,data_mode:AUTO};
    });
    return {...config,nodeDates,scheduleInitialized:true};
  }

  function backwardRecalculateAll(config){
    const nodes=ordered(config);
    const nodeMap=new Map(nodes.map(node=>[String(node.id),node]));
    const order=topological(config);
    if(!order) throw new Error('前置任務形成循環，無法重新計算。');
    const target=config.targetDate;
    if(!target) throw new Error('請先輸入目標上市／可出貨日。');
    const nodeDates={...(config.nodeDates||{})};

    order.slice().reverse().forEach(id=>{
      const node=nodeMap.get(id);
      const successors=successorsFor(config,id);
      let end='';
      if(successors.length){
        const constraints=successors.map(dep=>{
          const child=datesOf(nodeDates[dep.node_id]||{});
          return child.planned_start_date?subtractLag(child.planned_start_date,dep.lag_work_days):'';
        });
        if(constraints.some(value=>!value)) throw new Error(`「${node.node_name||id}」的後續節點尚未完成回推。`);
        end=earliest(constraints);
      }else{
        end=target;
      }
      const start=typeOf(node)===MILESTONE?end:subtractWorkDays(end,Math.max(0,Number(node.work_days||0)));
      nodeDates[id]={...datesOf(nodeDates[id]||{}),planned_start_date:start,planned_end_date:end,planned_date:end,data_mode:AUTO};
    });
    return {...config,nodeDates,scheduleInitialized:true};
  }

  function recalculate(key,nodeId,scope='following'){
    try{
      let config=migrateConfig((typeof ensureProjectScheduleCopy==='function'?ensureProjectScheduleCopy(key,true):null)||getScheduleForProject(key));
      const allIds=new Set(ordered(config).map(node=>String(node.id)));
      let selected;
      if(scope==='all') selected=allIds;
      else if(scope==='single') selected=new Set([String(nodeId)]);
      else selected=descendants(config,nodeId);

      config=(scope==='all'&&config.mode==='backward')
        ?backwardRecalculateAll(config)
        :forwardRecalculate(config,selected);
      storeConfig(key,config,{message:'已依前置任務重新計算日期；指定範圍恢復 AUTO'});
    }catch(error){
      if(typeof toast==='function') toast(error?.message||'重新計算失敗');
      else alert(error?.message||'重新計算失敗');
    }
  }

  if(originalEnsure){
    ensureProjectScheduleCopy=function(key,shouldPersist=true){
      const config=originalEnsure(key,shouldPersist);
      if(!config) return config;
      const migrated=migrateConfig(config);
      if(shouldPersist) state.projectSchedules[key]=migrated;
      return migrated;
    };
  }

  if(originalSetStateFromRemote){
    setStateFromRemote=function(remote){
      originalSetStateFromRemote(remote);
      migrateAll();
    };
  }

  calculateProjectSchedule=function(key){
    const config=migrateConfig((typeof ensureProjectScheduleCopy==='function'?ensureProjectScheduleCopy(key,true):null)||getScheduleForProject(key));
    return ordered(config).map(node=>{
      const dates=datesOf((config.nodeDates||{})[node.id]||{});
      return {
        ...node,
        ...dates,
        node_type:typeOf(node),
        calculated_start_date:dates.planned_start_date,
        calculated_end_date:dates.planned_end_date
      };
    });
  };

  updateProjectSchedule=function(key,field,value){
    let config=migrateConfig((typeof ensureProjectScheduleCopy==='function'?ensureProjectScheduleCopy(key,true):null)||getScheduleForProject(key));
    config={...config,[field]:value};
    const hasDates=Object.values(config.nodeDates||{}).some(value=>{
      const dates=datesOf(value);
      return dates.planned_start_date||dates.planned_end_date||dates.actual_start_date||dates.actual_end_date;
    });
    if((field==='baseDate'||field==='targetDate')&&value&&!config.scheduleInitialized&&!hasDates){
      try{
        config={...config,mode:field==='targetDate'?'backward':'forward'};
        config=config.mode==='backward'?backwardRecalculateAll(config):forwardRecalculate(config,new Set(ordered(config).map(node=>String(node.id))));
        storeConfig(key,config,{message:'已依前置任務完成第一次日期推算'});
      }catch(error){
        storeConfig(key,config,{message:error?.message||'日期推算失敗'});
      }
      return;
    }
    storeConfig(key,config,{message:'已更新上市時程；既有節點日期未重新推算'});
  };

  function escapeHtml(value){
    return String(value??'').replace(/[&<>"']/g,char=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[char]));
  }
  function projectKeyFromRow(row){
    const source=row.querySelector('[data-node-id]');
    return source?.dataset.scheduleDate||source?.dataset.projectNodeName||source?.dataset.projectNodeDays||source?.dataset.schedulePlanned||source?.dataset.scheduleStart||source?.dataset.scheduleActual||'';
  }
  function nodeIdFromRow(row){ return row.querySelector('[data-node-id]')?.dataset.nodeId||''; }
  function nodeById(config,nodeId){ return (config.scheduleNodes||[]).find(node=>String(node.id)===String(nodeId)); }
  function dependencySummary(config,nodeId){
    const map=new Map((config.scheduleNodes||[]).map(node=>[String(node.id),node.node_name||String(node.id)]));
    const deps=dependenciesFor(config,nodeId);
    if(!deps.length) return '無前置任務';
    return deps.map(dep=>`${map.get(dep.predecessor_node_id)||dep.predecessor_node_id}${dep.lag_work_days?`＋${dep.lag_work_days}工作日`:''}`).join('、');
  }
  function conflictFor(config,nodeId){
    const dates=datesOf((config.nodeDates||{})[nodeId]||{});
    if(dates.data_mode!==MANUAL||!dates.planned_start_date) return '';
    const deps=dependenciesFor(config,nodeId);
    if(!deps.length) return '';
    const constraints=deps.map(dep=>{
      const predecessor=datesOf((config.nodeDates||{})[dep.predecessor_node_id]||{});
      return predecessor.planned_end_date?addLag(predecessor.planned_end_date,dep.lag_work_days):'';
    });
    if(constraints.some(value=>!value)) return '';
    const allowed=latest(constraints);
    return dates.planned_start_date<allowed?`開始日早於前置任務允許日期 ${allowed}`:'';
  }

  let modalState=null;
  function ensureModal(){
    if(document.getElementById('v121DependencyModal')) return;
    const modal=document.createElement('div');
    modal.id='v121DependencyModal';
    modal.className='v121-modal-backdrop';
    modal.setAttribute('aria-hidden','true');
    modal.innerHTML=`<section class="v121-modal" role="dialog" aria-modal="true" aria-labelledby="v121DependencyTitle">
      <div class="v121-modal-head"><h3 id="v121DependencyTitle">設定前置任務</h3><button type="button" data-v121-close>關閉</button></div>
      <p class="v121-modal-note">本版關聯固定為「完成後開始（FS）」。勾選多個時，必須全部完成後，本節點才可開始。</p>
      <div id="v121DependencyList" class="v121-dependency-list"></div>
      <div id="v121DependencyError" class="v121-error" hidden></div>
      <div class="v121-modal-actions"><button type="button" data-v121-close>取消</button><button type="button" class="primary" id="v121DependencySave">儲存前置任務</button></div>
    </section>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-v121-close]').forEach(button=>button.onclick=closeModal);
    modal.addEventListener('click',event=>{ if(event.target===modal) closeModal(); });
    modal.querySelector('#v121DependencySave').onclick=saveDependencies;
  }
  function openModal(key,nodeId){
    ensureModal();
    const config=migrateConfig(state.projectSchedules[key]||getScheduleForProject(key));
    const current=nodeById(config,nodeId);
    if(!current) return;
    modalState={key,nodeId:String(nodeId)};
    const selected=new Map(dependenciesFor(config,nodeId).map(dep=>[String(dep.predecessor_node_id),dep]));
    const list=document.getElementById('v121DependencyList');
    list.innerHTML=ordered(config).filter(node=>String(node.id)!==String(nodeId)).map(node=>{
      const dep=selected.get(String(node.id));
      return `<label class="v121-dependency-option">
        <input type="checkbox" data-predecessor-id="${escapeHtml(node.id)}" ${dep?'checked':''}>
        <span><b>${escapeHtml(node.node_name||node.id)}</b><small>${typeOf(node)==='MILESTONE'?'里程碑':'工作節點'}</small></span>
        <input type="number" min="0" value="${dep?.lag_work_days||0}" data-lag-for="${escapeHtml(node.id)}" aria-label="間隔工作日">
        <em>工作日後</em>
      </label>`;
    }).join('')||'<p>此專案沒有其他可選節點。</p>';
    document.getElementById('v121DependencyTitle').textContent=`設定前置任務：${current.node_name||current.id}`;
    document.getElementById('v121DependencyError').hidden=true;
    const modal=document.getElementById('v121DependencyModal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden','false');
  }
  function closeModal(){
    modalState=null;
    const modal=document.getElementById('v121DependencyModal');
    modal?.classList.remove('open');
    modal?.setAttribute('aria-hidden','true');
  }
  function saveDependencies(){
    if(!modalState) return;
    const {key,nodeId}=modalState;
    const config=migrateConfig(state.projectSchedules[key]||getScheduleForProject(key));
    const retained=normalizeDependencies(config).filter(dep=>String(dep.node_id)!==String(nodeId));
    const added=Array.from(document.querySelectorAll('#v121DependencyList [data-predecessor-id]:checked')).map(checkbox=>{
      const predecessorId=String(checkbox.dataset.predecessorId);
      const lag=document.querySelector(`#v121DependencyList [data-lag-for="${CSS.escape(predecessorId)}"]`);
      return {node_id:String(nodeId),predecessor_node_id:predecessorId,dependency_type:'FS',lag_work_days:Math.max(0,Number(lag?.value||0))};
    });
    const next=migrateConfig({...config,dependencies:[...retained,...added]});
    if(hasCycle(next)){
      const error=document.getElementById('v121DependencyError');
      error.textContent='前置任務形成循環，請重新設定。';
      error.hidden=false;
      return;
    }
    storeConfig(key,next,{message:'已儲存前置任務關聯；日期不會自動覆蓋，請視需要按重新計算日期'});
    closeModal();
  }

  function changeNodeType(key,nodeId,value){
    const config=migrateConfig(state.projectSchedules[key]||getScheduleForProject(key));
    const nodes=config.scheduleNodes.map(node=>{
      if(String(node.id)!==String(nodeId)) return node;
      return {...node,node_type:value===MILESTONE?MILESTONE:TASK,work_days:value===MILESTONE?0:Math.max(0,Number(node.work_days||0))};
    });
    storeConfig(key,{...config,scheduleNodes:nodes},{message:value===MILESTONE?'已改為里程碑；工作日固定為 0，請視需要重新計算日期':'已改為工作節點'});
  }

  function decorateEditors(){
    document.querySelectorAll('.schedule-editor').forEach(editor=>{
      if(!editor.querySelector('.v121-rule-note')){
        const note=document.createElement('p');
        note.className='v121-rule-note';
        note.textContent='v1.2.1：節點可設定為工作或里程碑，並可複選前置任務。節點排序不代表依賴關係。';
        editor.querySelector('h4')?.insertAdjacentElement('afterend',note);
      }
    });

    document.querySelectorAll('.editable-schedule-table tbody tr').forEach(row=>{
      const key=projectKeyFromRow(row);
      const nodeId=nodeIdFromRow(row);
      const cell=row.lastElementChild;
      if(!key||!nodeId||!cell) return;
      const config=migrateConfig(state.projectSchedules[key]||getScheduleForProject(key));
      const node=nodeById(config,nodeId);
      if(!node) return;

      if(!row.querySelector('.v121-node-controls')){
        const controls=document.createElement('div');
        controls.className='v121-node-controls';
        controls.innerHTML=`<label>類型<select data-v121-node-type><option value="TASK">工作</option><option value="MILESTONE">里程碑</option></select></label><button type="button" class="mini" data-v121-dependencies>前置任務…</button><small data-v121-dependency-summary></small><span class="v121-conflict" data-v121-conflict hidden></span>`;
        cell.appendChild(controls);
        controls.querySelector('[data-v121-node-type]').onchange=event=>changeNodeType(key,nodeId,event.target.value);
        controls.querySelector('[data-v121-dependencies]').onclick=()=>openModal(key,nodeId);
      }
      const controls=row.querySelector('.v121-node-controls');
      controls.querySelector('[data-v121-node-type]').value=typeOf(node);
      controls.querySelector('[data-v121-dependency-summary]').textContent=dependencySummary(config,nodeId);
      const conflict=conflictFor(config,nodeId);
      const warning=controls.querySelector('[data-v121-conflict]');
      warning.textContent=conflict?`⚠ ${conflict}`:'';
      warning.hidden=!conflict;

      const numberInput=Array.from(row.querySelectorAll('input[type="number"]')).find(input=>!input.closest('.v121-node-controls'));
      if(numberInput){
        numberInput.disabled=typeOf(node)===MILESTONE;
        if(typeOf(node)===MILESTONE) numberInput.value='0';
      }

      const recalc=row.querySelector('.v120-recalc-controls');
      if(recalc){
        const button=recalc.querySelector('button');
        if(button&&!button.dataset.v121Bound){
          button.dataset.v121Bound='1';
          button.onclick=()=>recalculate(key,nodeId,recalc.querySelector('select')?.value||'following');
        }
      }
    });
  }

  if(!document.getElementById('v121-schedule-style')){
    const style=document.createElement('style');
    style.id='v121-schedule-style';
    style.textContent=`
      .v121-rule-note{margin:6px 0 12px;color:#475569;font-size:13px}
      .v121-node-controls{display:grid;gap:5px;margin-top:8px;padding-top:8px;border-top:1px dashed #cbd5e1}
      .v121-node-controls label{display:flex;align-items:center;gap:6px;font-size:12px}
      .v121-node-controls select{padding:5px 7px;border:1px solid #cbd5e1;border-radius:6px}
      .v121-node-controls small{color:#64748b;line-height:1.4}
      .v121-conflict{color:#b42318;font-size:12px;font-weight:700}
      .v121-modal-backdrop{display:none;position:fixed;inset:0;background:rgba(15,23,42,.48);z-index:9999;padding:24px;overflow:auto}
      .v121-modal-backdrop.open{display:grid;place-items:center}
      .v121-modal{width:min(720px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:16px;padding:20px;box-shadow:0 24px 70px rgba(15,23,42,.28)}
      .v121-modal-head,.v121-modal-actions{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .v121-modal-head h3{margin:0}.v121-modal-note{color:#64748b;font-size:13px}
      .v121-dependency-list{display:grid;gap:8px;margin:16px 0}
      .v121-dependency-option{display:grid;grid-template-columns:auto 1fr 90px auto;align-items:center;gap:10px;padding:10px;border:1px solid #e2e8f0;border-radius:10px}
      .v121-dependency-option span{display:grid}.v121-dependency-option small{color:#64748b}.v121-dependency-option em{font-style:normal;font-size:12px;color:#64748b}
      .v121-dependency-option input[type="number"]{padding:7px;border:1px solid #cbd5e1;border-radius:7px}
      .v121-error{color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:8px;padding:10px;margin-bottom:12px}
      .v121-modal-actions{justify-content:flex-end}.v121-modal button{padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;cursor:pointer}.v121-modal button.primary{background:#2563eb;color:#fff;border-color:#2563eb}
      @media(max-width:600px){.v121-dependency-option{grid-template-columns:auto 1fr}.v121-dependency-option input[type="number"]{grid-column:2}.v121-dependency-option em{grid-column:2}}
    `;
    document.head.appendChild(style);
  }

  migrateAll();
  renderAll();
  decorateEditors();
  new MutationObserver(decorateEditors).observe(document.body,{childList:true,subtree:true});

  window.WR_SCHEDULE_V121={
    TASK,MILESTONE,recalculate,normalizeDependencies,topological,descendants,migrateConfig
  };
})();
