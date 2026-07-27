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
  // v1.2.0：忘記密碼信件統一回到獨立登入頁。
  passwordResetRedirectUrl: 'https://huangruyu-art.github.io/wrs/login.html'
};
