(function(){
  'use strict';

  const service=window.WR_SUPABASE_SERVICE;
  if(!service||service.__v121Wrapped) return;

  const originalPushAll=service.pushAll?.bind(service);
  const originalLoadGanttData=service.loadGanttData?.bind(service);
  const originalUpdateDates=service.updateProjectScheduleDates?.bind(service);
  const originalUpdateConfig=service.updateProjectScheduleConfig?.bind(service);

  const TASK='TASK';
  const MILESTONE='MILESTONE';

  function nodeType(value){ return value===MILESTONE?MILESTONE:TASK; }
  function dependencyType(value){ return value==='FS'?'FS':'FS'; }
  function cfg(){ return service.getConfig?.()||window.WORK_RECORD_SUPABASE_CONFIG||{}; }
  function baseUrl(){ return String(cfg().url||'').replace(/\/$/,''); }
  function authHeaders(extra={}){
    const config=cfg();
    const token=service.getSession?.()?.access_token||config.anonKey;
    return {
      apikey:config.anonKey,
      Authorization:`Bearer ${token}`,
      'Content-Type':'application/json',
      ...extra
    };
  }

  async function rest(path,options={}){
    await service.ensureFreshSession?.();
    const response=await fetch(`${baseUrl()}/rest/v1/${path}`,{
      ...options,
      headers:authHeaders(options.headers||{})
    });
    const text=await response.text();
    if(!response.ok){
      const error=new Error(text||`Supabase HTTP ${response.status}`);
      error.status=response.status;
      error.body=text;
      throw error;
    }
    return text?JSON.parse(text):null;
  }

  function normalizedDependencies(config={}){
    const seen=new Set();
    return (Array.isArray(config.dependencies)?config.dependencies:[]).flatMap(dep=>{
      const nodeId=String(dep?.node_id||'').trim();
      const predecessorId=String(dep?.predecessor_node_id||'').trim();
      if(!nodeId||!predecessorId||nodeId===predecessorId) return [];
      const key=`${nodeId}\u0000${predecessorId}`;
      if(seen.has(key)) return [];
      seen.add(key);
      return [{
        node_id:nodeId,
        predecessor_node_id:predecessorId,
        dependency_type:dependencyType(dep.dependency_type),
        lag_work_days:Math.max(0,Number(dep.lag_work_days||0))
      }];
    });
  }

  function projectNodeRows(projectSchedules){
    const userId=service.getUser?.()?.id||null;
    const now=new Date().toISOString();
    const rows=[];
    Object.entries(projectSchedules||{}).forEach(([projectKey,config])=>{
      (config?.scheduleNodes||[]).forEach((node,index)=>{
        rows.push({
          project_key:projectKey,
          node_id:String(node.id),
          node_name:node.node_name||'',
          sort_order:Number(node.sort_order||index+1),
          node_type:nodeType(node.node_type),
          updated_by:userId,
          updated_at:now,
          deleted_at:null
        });
      });
    });
    return rows;
  }

  function dependencyRows(projectKey,config){
    const userId=service.getUser?.()?.id||null;
    const now=new Date().toISOString();
    return normalizedDependencies(config).map(dep=>({
      project_key:projectKey,
      ...dep,
      created_by:userId,
      updated_by:userId,
      updated_at:now,
      deleted_at:null
    }));
  }

  async function upsertNodeTypes(projectSchedules){
    const rows=projectNodeRows(projectSchedules);
    if(!rows.length||!service.isReady?.()||!service.isAuthenticated?.()) return;
    await rest('project_schedule_nodes?on_conflict=project_key%2Cnode_id',{
      method:'POST',
      headers:{Prefer:'resolution=merge-duplicates,return=minimal'},
      body:JSON.stringify(rows)
    });
  }

  async function syncDependenciesForProject(projectKey,config){
    if(!projectKey||!service.isReady?.()||!service.isAuthenticated?.()) return;
    const encoded=encodeURIComponent(projectKey);
    const now=new Date().toISOString();
    await rest(`project_schedule_node_dependencies?project_key=eq.${encoded}&deleted_at=is.null`,{
      method:'PATCH',
      headers:{Prefer:'return=minimal'},
      body:JSON.stringify({deleted_at:now,updated_at:now,updated_by:service.getUser?.()?.id||null})
    });
    const rows=dependencyRows(projectKey,config);
    if(rows.length){
      await rest('project_schedule_node_dependencies?on_conflict=project_key%2Cnode_id%2Cpredecessor_node_id',{
        method:'POST',
        headers:{Prefer:'resolution=merge-duplicates,return=minimal'},
        body:JSON.stringify(rows)
      });
    }
  }

  async function syncStructure(projectSchedules){
    await upsertNodeTypes(projectSchedules);
    for(const [projectKey,config] of Object.entries(projectSchedules||{})){
      await syncDependenciesForProject(projectKey,config||{});
    }
  }

  async function loadDependencies(){
    try{
      return await rest('project_schedule_node_dependencies?select=*&deleted_at=is.null&order=project_key.asc,node_id.asc');
    }catch(error){
      const missing=/project_schedule_node_dependencies|42P01|PGRST205/i.test(String(error.body||error.message));
      if(missing){
        console.warn('[v1.2.1] 尚未建立前置任務資料表，請先執行 migration。');
        return [];
      }
      throw error;
    }
  }

  if(originalPushAll){
    service.pushAll=async function(state){
      const result=await originalPushAll(state);
      await syncStructure(state?.projectSchedules||{});
      return result;
    };
  }

  if(originalLoadGanttData){
    service.loadGanttData=async function(){
      const [data,dependencies]=await Promise.all([originalLoadGanttData(),loadDependencies()]);
      data.projectScheduleNodes=(data.projectScheduleNodes||[]).map(row=>({
        ...row,
        node_type:nodeType(row.node_type)
      }));
      data.projectScheduleNodeDependencies=dependencies||[];
      return data;
    };
  }

  if(originalUpdateDates){
    service.updateProjectScheduleDates=async function(projectKey,config,nodeUpdates){
      const enriched=(nodeUpdates||[]).map(update=>{
        const node=(config?.scheduleNodes||[]).find(item=>String(item.id)===String(update.node_id));
        return {...update,node_type:nodeType(node?.node_type)};
      });
      const result=await originalUpdateDates(projectKey,config,enriched);
      await syncStructure({[projectKey]:config});
      return result;
    };
  }

  if(originalUpdateConfig){
    service.updateProjectScheduleConfig=async function(projectKey,config){
      const result=await originalUpdateConfig(projectKey,config);
      await syncStructure({[projectKey]:config});
      return result;
    };
  }

  service.syncV121Structure=syncStructure;
  service.loadV121Dependencies=loadDependencies;
  service.__v121Wrapped=true;
})();
