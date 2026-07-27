(function(){
  'use strict';
  const service=window.WR_SUPABASE_SERVICE;
  if(!service||service.__v120Wrapped) return;

  const originalPushAll=service.pushAll?.bind(service);
  const originalLoadGanttData=service.loadGanttData?.bind(service);
  const originalUpdateDates=service.updateProjectScheduleDates?.bind(service);
  const originalUpdateConfig=service.updateProjectScheduleConfig?.bind(service);

  function dataMode(value){ return value==='MANUAL'?'MANUAL':'AUTO'; }
  function dateFields(value={}){
    return {
      planned_start_date:value.planned_start_date||value.start_date||null,
      planned_end_date:value.planned_end_date||value.planned_date||null,
      actual_start_date:value.actual_start_date||null,
      actual_end_date:value.actual_end_date||value.actual_date||null,
      data_mode:dataMode(value.data_mode)
    };
  }

  function nodeRows(projectSchedules){
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
          ...dateFields((config.nodeDates||{})[node.id]),
          updated_by:userId,
          updated_at:now,
          deleted_at:null
        });
      });
    });
    return rows;
  }

  async function upsertNodeModes(projectSchedules){
    const rows=nodeRows(projectSchedules);
    if(!rows.length||!service.isReady?.()||!service.isAuthenticated?.()) return;
    await service.ensureFreshSession?.();
    const cfg=service.getConfig?.()||{};
    const session=service.getSession?.();
    const token=session?.access_token||cfg.anonKey;
    const url=`${String(cfg.url||'').replace(/\/$/,'')}/rest/v1/project_schedule_nodes?on_conflict=project_key%2Cnode_id`;
    const response=await fetch(url,{
      method:'POST',
      headers:{
        apikey:cfg.anonKey,
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json',
        Prefer:'resolution=merge-duplicates,return=minimal'
      },
      body:JSON.stringify(rows)
    });
    if(!response.ok){
      const text=await response.text();
      throw new Error(text||`同步 data_mode 失敗（HTTP ${response.status}）`);
    }
  }

  function markUpdatesManual(config,nodeUpdates){
    if(!config) return;
    config.nodeDates=config.nodeDates||{};
    (nodeUpdates||[]).forEach(update=>{
      const id=String(update.node_id||'');
      if(!id) return;
      config.nodeDates[id]={...(config.nodeDates[id]||{}),data_mode:'MANUAL'};
      update.data_mode='MANUAL';
    });
  }

  if(originalPushAll){
    service.pushAll=async function(state){
      const result=await originalPushAll(state);
      await upsertNodeModes(state?.projectSchedules||{});
      return result;
    };
  }

  if(originalLoadGanttData){
    service.loadGanttData=async function(){
      const data=await originalLoadGanttData();
      data.projectScheduleNodes=(data.projectScheduleNodes||[]).map(row=>({...row,data_mode:dataMode(row.data_mode)}));
      return data;
    };
  }

  if(originalUpdateDates){
    service.updateProjectScheduleDates=async function(projectKey,config,nodeUpdates){
      markUpdatesManual(config,nodeUpdates);
      const result=await originalUpdateDates(projectKey,config,nodeUpdates);
      await upsertNodeModes({[projectKey]:config});
      return result;
    };
  }

  if(originalUpdateConfig){
    service.updateProjectScheduleConfig=async function(projectKey,config){
      const result=await originalUpdateConfig(projectKey,config);
      await upsertNodeModes({[projectKey]:config});
      return result;
    };
  }

  service.__v120Wrapped=true;
})();
