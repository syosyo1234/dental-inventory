// =====================================================================
// dashboard.js  ダッシュボード
//   ① KPI：登録資材数・緊急・注意・発注済み（get_inventory_status で計算）
//   ② 発注が必要な商品（緊急 → 注意、残存日数の少ない順に最大8件）
//   ③ 最近の検収記録（取消済みは除外、最大8件）
// =====================================================================
import { initPage } from '../layout.js';
import { supabase } from '../supabaseClient.js';
import { fetchCancelledIds, TXN_SELECT } from '../data.js';
import { errorMessage, escapeHtml, formatQty, formatDate, one, showAlert, statusBadge } from '../ui.js';
import { fetchInventoryStatus, sortByUrgency, remainingHtml, orderStatusHtml } from '../stock.js';

await initPage('dashboard');

const LIMIT = 8;
const errorEl = document.getElementById('dashboard-error');

// ---------------------------------------------------------------------
// ①② 在庫状況（在庫一覧・発注アラートと同じデータベース関数）
// ---------------------------------------------------------------------
async function loadStatus() {
  const { data, error } = await fetchInventoryStatus(7);
  const alertRows = document.getElementById('alert-rows');
  if (error) {
    showAlert(errorEl, errorMessage(error));
    alertRows.innerHTML = '<tr><td colspan="7" class="empty">データを読み込めませんでした。</td></tr>';
    return;
  }

  const unit = '<small>件</small>';
  const needs = data.filter((r) => r.status !== 'normal').sort(sortByUrgency);
  document.getElementById('kpi-total').innerHTML = data.length + unit;
  document.getElementById('kpi-urgent').innerHTML = data.filter((r) => r.status === 'urgent').length + unit;
  document.getElementById('kpi-warning').innerHTML = data.filter((r) => r.status === 'warning').length + unit;
  document.getElementById('kpi-ordered').innerHTML = needs.filter((r) => r.ordered_at).length + unit;

  if (!needs.length) {
    alertRows.innerHTML = '<tr><td colspan="7" class="empty">現在、発注が必要な資材はありません。</td></tr>';
    return;
  }
  const more = needs.length > LIMIT
    ? `<tr><td colspan="7" class="empty"><a href="alerts.html">ほか ${needs.length - LIMIT} 件を発注アラートで見る →</a></td></tr>`
    : '';
  alertRows.innerHTML = needs.slice(0, LIMIT).map((r) => `
    <tr class="st-${r.status}">
      <td>${statusBadge(r.status)}</td>
      <td><strong>${escapeHtml(r.model_no)}</strong></td>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${formatQty(r.current_qty)} ${escapeHtml(r.unit)}</td>
      <td class="num days-cell">${remainingHtml(r)}</td>
      <td class="num">${r.lead_time_days}日</td>
      <td>${orderStatusHtml(r)}</td>
    </tr>`).join('') + more;
}

// ---------------------------------------------------------------------
// ③ 最近の検収記録（取消済みは表示しない）
// ---------------------------------------------------------------------
async function loadReceipts() {
  const tbody = document.getElementById('receipt-rows');
  const { data, error } = await supabase
    .from('stock_transactions')
    .select(TXN_SELECT)
    .eq('txn_type', 'IN')
    .order('id', { ascending: false })
    .limit(LIMIT + 5);   // 取消済みを除いても8件残るよう少し多めに取得

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(errorMessage(error))}</td></tr>`;
    return;
  }
  const { set: cancelled } = await fetchCancelledIds(data.map((t) => t.id));
  const list = data.filter((t) => !cancelled.has(t.id)).slice(0, LIMIT);

  tbody.innerHTML = list.length ? list.map((t) => {
    const p = one(t.products) ?? {};
    return `
      <tr>
        <td>${formatDate(t.txn_date)}</td>
        <td>${escapeHtml(p.model_no)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td class="num"><span class="text-plus">+${formatQty(t.quantity)}</span> ${escapeHtml(p.unit)}</td>
        <td>${escapeHtml(one(t.staff_profiles)?.display_name ?? '')}</td>
      </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">検収記録はまだありません。</td></tr>';
}

await Promise.all([loadStatus(), loadReceipts()]);
