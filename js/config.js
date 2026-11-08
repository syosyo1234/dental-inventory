// =====================================================================
// config.js  Supabase 连接设置
//
// 从 Supabase 控制台 → Project Settings → API Keys 复制：
//   ・Project URL
//   ・Publishable key（sb_publishable_...）或旧版 anon key
//
// ⚠ 这里只能放「公开用」的 key。
//   service_role / secret key（sb_secret_...）绝对不能写在前端代码里。
//   安全性由数据库的 RLS 和函数内的权限检查保证。
// =====================================================================
export const SUPABASE_URL = 'https://yndznugcsvpyucmrjtsw.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_b2cp551ewvKEWe_IQ1d-HA_UlZesK-r';

// 面试演示用：如果想在登录页显示演示账号，填写这里（不需要时保持 null）
// 例：{ email: 'demo@example.com', password: 'demo-password' }
// ※ 只填写权限为 staff 的演示账号，不要填写 admin 账号
export const DEMO_ACCOUNT = { email: 'demo@example.com', password: 'demo1234' };