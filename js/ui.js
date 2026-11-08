// =====================================================================
// ui.js  通用的界面辅助函数
// =====================================================================

/** HTML 转义：显示数据库内容时必须使用，防止 XSS */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 日本时间的今天（YYYY-MM-DD），用于日期输入框的默认值和上限 */
export function todayJST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

/** 数量显示：15.00 → 15、1234 → 1,234 */
export function formatQty(value) {
  if (value === null || value === undefined || value === '') return '-';
  return Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 2 });
}

/** 日期显示：2026-11-08 → 2026/11/08 */
export function formatDate(value) {
  if (!value) return '-';
  return String(value).slice(0, 10).replaceAll('-', '/');
}

/** 日期时间显示（日本时间）：2026/11/08 14:05 */
export function formatDateTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

/** 是否为网络错误（服务器无法连接、数据库暂停等） */
export function isNetworkError(error) {
  const msg = String(error?.message ?? error ?? '');
  return /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(msg);
}

/** 把 Supabase 返回的错误转换为给用户看的日语信息 */
export function errorMessage(error) {
  if (!error) return '';
  const msg = String(error.message ?? error);

  if (isNetworkError(error)) {
    return 'サーバーに接続できません。通信状況を確認してください。（デモ環境が休止中の可能性があります）';
  }
  if (/JWT expired|invalid JWT|PGRST301/i.test(msg) || error.code === 'PGRST301') {
    return 'ログインの有効期限が切れました。再度ログインしてください。';
  }
  if (error.code === '42501' && !/[ぁ-んァ-ヶ一-龠]/.test(msg)) {
    return 'この操作を行う権限がありません。';
  }
  // 数据库函数抛出的日语信息直接显示
  if (/[ぁ-んァ-ヶ一-龠]/.test(msg)) return msg;

  console.error(error);
  return '処理中にエラーが発生しました。時間をおいて再度お試しください。';
}

/** 右下角的通知 */
export function toast(message, type = 'info', ms = 4000) {
  let area = document.querySelector('.toast-area');
  if (!area) {
    area = document.createElement('div');
    area.className = 'toast-area';
    area.setAttribute('role', 'status');
    area.setAttribute('aria-live', 'polite');
    document.body.appendChild(area);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  area.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * 按钮处理中状态：禁用 + 转圈，防止重复点击
 * 用法：const done = setBusy(button, '登録中…'); ...; done();
 */
export function setBusy(button, busyText) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${escapeHtml(busyText)}`;
  return () => {
    button.disabled = false;
    button.innerHTML = original;
  };
}

/**
 * 型番の正規化：数据库的 normalize_model_no() 相同的规则
 * 全角→半角（NFKC）、去掉空格、转为大写。例：「ｄｃ－００１ 」→「DC-001」
 */
export function normalizeModelNo(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s/g, '').toUpperCase();
}

/**
 * 读取整数输入。日语输入法下容易输入全角数字「５」，这里统一转换。
 * 空 → null、整数 → number、其他 → NaN
 */
export function parseIntInput(value) {
  const s = String(value ?? '').normalize('NFKC').replace(/[,\s]/g, '');
  if (s === '') return null;
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

/** 读取小数输入（平均使用量等）。规则同上 */
export function parseDecimalInput(value) {
  const s = String(value ?? '').normalize('NFKC').replace(/[,\s]/g, '');
  if (s === '') return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** 二重送信防止用的请求ID（同一次提交重发时保持不变） */
export function newRequestId() {
  return crypto.randomUUID();
}

/** 'YYYY-MM-DD' 加减天数 */
export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** PostgREST 的嵌入结果可能是对象也可能是数组，统一取一个 */
export function one(rel) {
  return Array.isArray(rel) ? rel[0] ?? null : rel ?? null;
}

/** 带符号的数量：+5 / −2 */
export function signedQty(delta) {
  const n = Number(delta);
  if (n > 0) return `<span class="text-plus">+${formatQty(n)}</span>`;
  if (n < 0) return `<span class="text-minus">−${formatQty(-n)}</span>`;
  return '±0';
}

/** 入出庫区分 → 标签 HTML */
export const TXN_TYPES = {
  IN:     { label: '入庫', cls: 'badge-in' },
  OUT:    { label: '出庫', cls: 'badge-out' },
  ADJUST: { label: '調整', cls: 'badge-adjust' },
  CANCEL: { label: '取消', cls: 'badge-cancel' },
};
export function txnBadge(type) {
  const t = TXN_TYPES[type];
  return t ? `<span class="badge ${t.cls}">${t.label}</span>` : escapeHtml(type);
}

/** 在指定元素中显示错误提示（message 为空时清除） */
export function showAlert(el, message, type = 'error') {
  el.innerHTML = message ? `<div class="alert alert-${type}">${escapeHtml(message)}</div>` : '';
}

/** 现在时刻 HH:MM:SS（处理日志用） */
export function nowTime() {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
}

/** 库存状态 → 标签 HTML */
export const STATUS_LABELS = {
  normal:  { text: '正常', sub: '在庫十分', cls: 'badge-normal' },
  warning: { text: '注意', sub: '発注推奨', cls: 'badge-warning' },
  urgent:  { text: '緊急', sub: '在庫不足', cls: 'badge-urgent' },
};
export function statusBadge(status, { compact = false } = {}) {
  const s = STATUS_LABELS[status];
  if (!s) return '<span class="badge badge-none">-</span>';
  // compact：幅の狭い表（ダッシュボード）用に「緊急」「注意」だけ表示
  return compact
    ? `<span class="badge ${s.cls}" title="${s.text}：${s.sub}">${s.text}</span>`
    : `<span class="badge ${s.cls}">${s.text}：${s.sub}</span>`;
}
