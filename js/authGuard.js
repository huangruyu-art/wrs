(function(){
  'use strict';
  const service=window.WR_SUPABASE_SERVICE;
  const page=location.pathname.split('/').pop()||'index.html';

  function loginUrl(){
    const next=encodeURIComponent(page+location.search+location.hash);
    return `login.html?next=${next}`;
  }

  if(page!=='login.html'&&service?.isReady?.()&&!service.isAuthenticated?.()){
    location.replace(loginUrl());
    return;
  }

  function setupAccountUi(){
    const user=service?.getUser?.();
    document.querySelectorAll('[data-auth-user]').forEach(el=>{
      el.textContent=user?.email||'已登入';
      el.title=user?.email||'';
    });
    document.querySelectorAll('[data-auth-signout]').forEach(btn=>{
      btn.onclick=async()=>{
        btn.disabled=true;
        try{ await service?.signOut?.(); }catch(_){ }
        location.replace('login.html');
      };
    });

    const loginBox=document.querySelector('[data-settings-panel="supabase"] .auth-box');
    if(loginBox) loginBox.hidden=true;
    const recoveryBox=document.getElementById('passwordRecoveryBox');
    if(recoveryBox) recoveryBox.hidden=true;
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',setupAccountUi,{once:true});
  else setupAccountUi();
})();
