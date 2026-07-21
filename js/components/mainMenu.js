(function(){
  'use strict';
  const items=[
    ['dashboard','首頁總覽'],['settings','設定'],['log','快速記錄'],['projects','專案總覽'],
    ['timeline','歷程時間軸'],['gantt','跨專案甘特式時間軸'],['calendar','月曆 / 日期清單'],
    ['samples','樣品版本'],['attachments','照片 / 附件']
  ];
  function render(){
    const host=document.querySelector('[data-main-menu]'); if(!host)return;
    const page=host.dataset.page||'index';
    host.className='sidebar'; host.setAttribute('aria-label','主要功能選單');
    host.innerHTML=items.map(([id,label])=>{
      if(id==='gantt') return `<a class="nav-btn nav-link ${page==='gantt'?'active':''}" href="gantt.html">${label}</a>`;
      if(page==='gantt') return `<a class="nav-btn nav-link" href="index.html#${id}" data-target-view="${id}">${label}</a>`;
      return `<button class="nav-btn ${id==='dashboard'?'active':''}" data-view="${id}" type="button">${label}</button>`;
    }).join('');
  }
  render();
})();