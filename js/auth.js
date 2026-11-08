// =====================================================================
// auth.js  登录状态检查
//
// 注意：这里的检查只是为了"用户体验"（未登录时跳转到登录页）。
//       真正的数据保护由数据库的 RLS 负责——即使有人绕过这段 JS，
//       没有有效登录令牌也读不到任何数据。
// =====================================================================
import { supabase, isConfigured } from './supabaseClient.js';
import { isNetworkError } from './ui.js';

// 只允许跳转到本站的页面（防止 ?next= 被用于跳到外部网站）
const SAFE_NEXT = /^[a-z_]+\.html(\?[\w=&%-]*)?$/;

export function loginUrl(params = {}) {
  const q = new URLSearchParams(params).toString();
  return 'login.html' + (q ? `?${q}` : '');
}

export function safeNext(next) {
  return next && SAFE_NEXT.test(next) ? next : 'index.html';
}

/** 一个永远不会完成的 Promise：页面跳转期间让后续代码停下 */
const halt = () => new Promise(() => {});

/**
 * 确认当前用户是"有效的员工"。
 * 返回 { user, profile, isAdmin }；未登录时跳转到登录页。
 * 连接失败时抛出 { type: 'network' }，由调用方显示提示。
 */
export async function requireStaff() {
  if (!isConfigured) {
    location.replace(loginUrl());
    return halt();
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    const here = location.pathname.split('/').pop() + location.search;
    location.replace(loginUrl({ next: here || 'index.html' }));
    return halt();
  }

  const { data: profile, error } = await supabase
    .from('staff_profiles')
    .select('id, display_name, role, is_active')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error) {
    if (isNetworkError(error)) throw { type: 'network', error };
    // 令牌失效等 → 重新登录
    await supabase.auth.signOut();
    location.replace(loginUrl({ reason: 'expired' }));
    return halt();
  }

  // 员工信息不存在或已停用（RLS 下停用的员工连自己的信息都读不到）
  if (!profile || !profile.is_active) {
    await supabase.auth.signOut();
    location.replace(loginUrl({ reason: 'inactive' }));
    return halt();
  }

  // 在其他标签页登出时，这个页面也跳转到登录页
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.replace(loginUrl());
  });

  return { user: session.user, profile, isAdmin: profile.role === 'admin' };
}

export async function signOut() {
  await supabase.auth.signOut();
  location.replace(loginUrl({ reason: 'signed_out' }));
}
