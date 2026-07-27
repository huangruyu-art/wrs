(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const service=window.WR_SUPABASE_SERVICE;

  function show(message,type=''){
    const box=$('loginMessage');
    box.textContent=message||'';
    box.className=`message ${type}`;
  }
  function nextPage(){
    const value=new URLSearchParams(location.search).get('next')||'index.html';
    if(/^https?:/i.test(value)||value.startsWith('//')) return 'index.html';
    return value.startsWith('login.html')?'index.html':value;
  }
  function clearRecoveryUrl(){
    history.replaceState({},document.title,location.href.split('#')[0].split('?')[0]);
  }

  async function init(){
    if(!service?.isReady?.()){
      show('Supabase 尚未啟用，請檢查連線設定。','error');
      return;
    }
    const recovery=Boolean(service.consumePasswordRecoveryFromUrl?.());
    if(recovery){
      $('loginForm').hidden=true;
      $('forgotPasswordBtn').hidden=true;
      $('recoveryBox').hidden=false;
      show('重設連結驗證成功，請設定新密碼。','success');
      return;
    }
    if(service.isAuthenticated?.()) location.replace(nextPage());
  }

  $('loginForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const email=$('loginEmail').value.trim();
    const password=$('loginPassword').value;
    if(!email||!password) return show('請輸入 Email 與密碼。','error');
    const button=$('loginSubmit');
    button.disabled=true;
    try{
      show('登入中…');
      await service.signIn(email,password);
      location.replace(nextPage());
    }catch(error){
      show(`登入失敗：${error?.message||'未知錯誤'}`,'error');
      button.disabled=false;
    }
  });

  $('forgotPasswordBtn').addEventListener('click',async()=>{
    const email=$('loginEmail').value.trim();
    if(!email) return show('請先輸入要找回密碼的 Email。','error');
    try{
      show('正在寄送密碼重設信…');
      await service.requestPasswordReset(email);
      show('密碼重設信已寄出，請檢查收件匣與垃圾郵件。','success');
    }catch(error){
      show(`寄送失敗：${error?.message||'未知錯誤'}`,'error');
    }
  });

  $('updatePasswordBtn').addEventListener('click',async()=>{
    const password=$('newPassword').value;
    const confirmPassword=$('confirmPassword').value;
    if(password.length<8) return show('新密碼至少需要 8 碼。','error');
    if(password!==confirmPassword) return show('兩次輸入的新密碼不一致。','error');
    const button=$('updatePasswordBtn');
    button.disabled=true;
    try{
      show('正在更新密碼…');
      await service.updatePassword(password);
      clearRecoveryUrl();
      show('密碼更新完成，正在進入系統…','success');
      setTimeout(()=>location.replace('index.html'),700);
    }catch(error){
      show(`更新失敗：${error?.message||'未知錯誤'}`,'error');
      button.disabled=false;
    }
  });

  init();
})();
