// Supabase 連線設定
// 1. 到 Supabase 專案 Settings → API 複製 Project URL 與 anon public key
// 2. 貼到下方 url / anonKey
// 3. enabled 改成 true
// 注意：不要把 service_role key 放在前端檔案中。
window.WORK_RECORD_SUPABASE_CONFIG = {
  enabled: true, 
  url: 'https://kktwhdlynoscxueslebq.supabase.co', 
  anonKey: 'sb_publishable_XLBFPpW9i9n09TzCYq1mJA_Nyywv_Fr', 
  schema: 'public',
  // 密碼重設信點開後要回到的完整網址。留空時，http/https 網頁會自動使用目前頁面網址。
  // 若平常直接以 file:// 開啟，建議填 GitHub Pages 或其他已部署的 index.html 網址。
  passwordResetRedirectUrl: 'https://huangruyu-art.github.io/wrs/'
};
