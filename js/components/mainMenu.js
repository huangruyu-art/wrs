(function(){
  'use strict';
  const items=[
    ['dashboard','首頁總覽'],['settings','設定'],['log','快速記錄'],['projects','專案總覽'],
    ['timeline','歷程時間軸'],['gantt','跨專案甘特式時間軸'],['calendar','月曆 / 日期清單'],
    ['samples','樣品版本'],['attachments','照片 / 附件']
  ];
  const host=document.querySelector('[data-main-menu]');
  const page=host?.dataset.page||'index';

  function render(){
    if(!host)return;
    document.title=document.title.replace(/Version\s+[0-9.]+/,'Version 1.2.0');
    host.className='sidebar'; host.setAttribute('aria-label','主要功能選單');
    host.innerHTML=items.map(([id,label])=>{
      if(id==='gantt') return `<a class="nav-btn nav-link ${page==='gantt'?'active':''}" href="gantt.html">${label}</a>`;
      if(page==='gantt') return `<a class="nav-btn nav-link" href="index.html#${id}" data-target-view="${id}">${label}</a>`;
      return `<button class="nav-btn ${id==='dashboard'?'active':''}" data-view="${id}" type="button">${label}</button>`;
    }).join('')+`<div class="sidebar-account"><small data-auth-user>檢查登入中…</small><button class="nav-btn" data-auth-signout type="button">登出</button></div>`;
  }

  function loadScript(src){
    if(document.querySelector(`script[data-v120-src="${src}"]`)) return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src=src;
      script.dataset.v120Src=src;
      script.onload=resolve;
      script.onerror=()=>reject(new Error(`無法載入 ${src}`));
      document.body.appendChild(script);
    });
  }

  async function bootstrapV120(){
    try{
      await loadScript('js/services/supabaseServiceV120.js');
      await loadScript('js/authGuard.js');
      if(page==='index') await loadScript('js/modules/scheduleV120.js');
    }catch(error){
      console.error('[v1.2.0 bootstrap]',error);
    }
  }

  render();
  if(!document.getElementById('v120-menu-style')){
    const style=document.createElement('style');
    style.id='v120-menu-style';
    style.textContent='.sidebar-account{margin-top:auto;padding-top:12px;border-top:1px solid rgba(255,255,255,.18)}.sidebar-account small{display:block;padding:0 10px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}';
    document.head.appendChild(style);
  }
  window.addEventListener('load',bootstrapV120,{once:true});
})();
