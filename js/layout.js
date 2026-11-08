// =====================================================================
// layout.js  公共布局（左侧菜单 + 顶部栏）
//
// 每个页面的用法：
//   import { initPage } from './js/layout.js';
//   const ctx = await initPage('receipt');   // ctx = { user, profile, isAdmin }
// =====================================================================
import { requireStaff, signOut } from './auth.js';
import { escapeHtml } from './ui.js';

// 简单的线条图标（stroke 跟随文字颜色）
const icon = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const ICONS = {
  dashboard: icon('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
  receipt:   icon('<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>'),
  usage:     icon('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
  inventory: icon('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>'),
  alerts:    icon('<path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  history:   icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  products:  icon('<path d="M4 4h16v16H4z"/><path d="M4 9h16"/><path d="M9 9v11"/>'),
};

// 菜单定义：在这里增减页面
const NAV = [
  { group: '業務' },
  { key: 'dashboard', href: 'index.html',     label: 'ダッシュボード' },
  { key: 'receipt',   href: 'receipt.html',   label: '検収登録' },
  { key: 'usage',     href: 'usage.html',     label: '使用登録' },
  { group: '在庫' },
  { key: 'inventory', href: 'inventory.html', label: '在庫一覧' },
  { key: 'alerts',    href: 'alerts.html',    label: '発注アラート' },
  { key: 'history',   href: 'history.html',   label: '入出庫履歴' },
  { group: 'マスタ' },
  { key: 'products',  href: 'products.html',  label: '医療資材マスタ' },
];

export function renderSidebar(activeKey) {
  const items = NAV.map((item) => {
    if (item.group) return `<div class="nav-group-label">${item.group}</div>`;
    const active = item.key === activeKey ? ' class="active" aria-current="page"' : '';
    return `<a href="${item.href}"${active}>${ICONS[item.key]}<span>${item.label}</span></a>`;
  }).join('');

  return `
    <a class="brand" href="index.html">
      <span class="brand-mark">資</span>
      <span class="brand-text">
        <span class="brand-name">資材検収・在庫管理</span><br>
        <span class="brand-sub">Dental Supply Manager</span>
      </span>
    </a>
    <nav class="nav" aria-label="メインメニュー">${items}</nav>`;
}

export function renderTopbar(title, profile) {
  const role = profile.role === 'admin' ? '管理者' : 'スタッフ';
  return `
    <div class="topbar-title">${escapeHtml(title)}</div>
    <div class="topbar-user">
      <span>${escapeHtml(profile.display_name)} <span class="user-role">（${role}）</span></span>
      <button type="button" class="btn btn-sm" id="logout-btn">ログアウト</button>
    </div>`;
}

/**
 * 页面初始化：确认登录 → 渲染菜单和顶部栏 → 显示页面
 * 页面 HTML 需要包含 <aside class="sidebar"> <header class="topbar"> <main class="main">
 */
export async function initPage(activeKey) {
  const title = NAV.find((n) => n.key === activeKey)?.label ?? '';
  document.title = `${title}｜歯科資材 検収・在庫管理`;

  let ctx;
  try {
    ctx = await requireStaff();
  } catch (e) {
    if (e?.type === 'network') {
      document.body.classList.remove('is-loading');
      document.body.innerHTML = `
        <div class="auth-page"><div class="card auth-card">
          <div class="alert alert-warning" style="margin:0">
            サーバーに接続できません。通信状況を確認してください。<br>
            デモ環境（データベース）が休止中の可能性があります。
          </div>
          <p style="text-align:center;margin:16px 0 0"><button class="btn" onclick="location.reload()">再読み込み</button></p>
        </div></div>`;
    }
    throw e;
  }

  document.querySelector('.sidebar').innerHTML = renderSidebar(activeKey);
  document.querySelector('.topbar').innerHTML = renderTopbar(title, ctx.profile);
  document.getElementById('logout-btn').addEventListener('click', signOut);

  // 带 data-admin-only 的元素只给管理者显示（只是界面上的隐藏，权限由数据库判断）
  if (!ctx.isAdmin) {
    document.querySelectorAll('[data-admin-only]').forEach((el) => el.remove());
  }

  document.body.classList.remove('is-loading');
  return ctx;
}
