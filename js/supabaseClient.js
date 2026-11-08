// =====================================================================
// supabaseClient.js  创建 Supabase 客户端（全页面共用一个实例）
// =====================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// config.js 还是占位值时为 false（用于显示设置提示）
export const isConfigured =
  !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_KEY.includes('YOUR-');

export const supabase = createClient(
  isConfigured ? SUPABASE_URL : 'https://placeholder.supabase.co',
  isConfigured ? SUPABASE_KEY : 'placeholder',
  {
    auth: {
      persistSession: true,     // 登录状态保存在浏览器，刷新页面不需要重新登录
      autoRefreshToken: true,   // 自动刷新访问令牌
    },
  }
);
