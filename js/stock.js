// =====================================================================
// stock.js  在庫状況の取得と表示（在庫一覧・発注アラート・ダッシュボード共通）
//
// 平均使用量・残存日数・状態の「計算」はすべてデータベース関数
// get_inventory_status が行う。ここでは表示用の整形だけを行う。
// → 3つの画面で計算結果が必ず一致する
// =====================================================================
import { supabase } from './supabaseClient.js';
import { escapeHtml, formatQty, formatDate } from './ui.js';

export const PERIODS = [7, 30];

/** 在庫状況を取得（p_period_days = 7 または 30） */
export async function fetchInventoryStatus(periodDays) {
  const { data, error } = await supabase.rpc('get_inventory_status', { p_period_days: periodDays });
  if (error) return { data: null, error };
  // numeric 型は文字列で返る場合もあるので数値に揃える
  const rows = data.map((r) => ({
    ...r,
    current_qty: Number(r.current_qty),
    reorder_point: Number(r.reorder_point),
    period_usage: Number(r.period_usage),
    daily_usage: r.daily_usage === null ? null : Number(r.daily_usage),
  }));
  return { data: rows, error: null };
}

// 状態の重さ（並べ替え用）：緊急 → 注意 → 正常
const SEVERITY = { urgent: 0, warning: 1, normal: 2 };

/** 並べ替え用の残存日数：在庫0は最優先（-1）、データ不足は最後 */
export function daysForSort(r) {
  if (r.current_qty <= 0) return -1;
  return r.remaining_days ?? 99999;
}

/** 状態順（緊急が先）→ 残存日数が少ない順 → 型番順 */
export function sortByUrgency(a, b) {
  return (SEVERITY[a.status] - SEVERITY[b.status])
    || (daysForSort(a) - daysForSort(b))
    || a.model_no.localeCompare(b.model_no);
}

/** 1日あたり平均使用量の表示（実績／手動設定／データ不足） */
export function usageHtml(r) {
  if (r.usage_source === 'none') return '<span class="badge badge-none">データ不足</span>';
  const tag = r.usage_source === 'manual' ? '<span class="source-tag">手動設定</span>' : '<span class="source-tag">実績</span>';
  return `${formatQty(r.daily_usage)} ${escapeHtml(r.unit)}/日${tag}`;
}

/** 在庫残存日数の表示 */
export function remainingHtml(r) {
  if (r.remaining_days === null) {
    return r.current_qty <= 0 ? '<strong class="days-urgent">0日</strong>' : '<span class="muted">データ不足</span>';
  }
  const cls = r.status === 'urgent' ? 'days-urgent' : r.status === 'warning' ? 'days-warning' : '';
  return `<strong class="${cls}">${r.remaining_days}日</strong>`;
}

/** 発注状況の表示 */
export function orderStatusHtml(r) {
  if (r.ordered_at) return `<span class="badge badge-info">発注済（${formatDate(r.ordered_at).slice(5)}）</span>`;
  if (r.status === 'normal') return '<span class="muted">-</span>';
  return '<span class="text-minus" style="font-weight:600">未発注</span>';
}

/**
 * 推奨発注数
 *   ＝ 1日平均使用量 ×（リードタイム ＋ 安全在庫日数 ＋ 補充周期）− 現在庫（切り上げ）
 *   「今発注すると、到着後さらに 補充周期 日分もつ量」まで補充する考え方。
 *   ・正常な資材は発注不要なので null
 *   ・平均使用量がない（データ不足）場合は計算できないので null
 * 計算に使う値（平均使用量・在庫）はデータベース関数の結果をそのまま使う。
 */
export const ORDER_CYCLE_DAYS = 14;   // 補充周期（1回の発注で何日分を確保するか）

export function suggestedOrderQty(r) {
  if (r.status === 'normal' || !(r.daily_usage > 0)) return null;
  const target = r.daily_usage * (r.lead_time_days + r.safety_days + ORDER_CYCLE_DAYS);
  return Math.max(0, Math.ceil(target - r.current_qty));
}

/** 推奨発注数の表示 */
export function suggestedOrderHtml(r) {
  if (r.status === 'normal') return '<span class="muted">-</span>';
  const qty = suggestedOrderQty(r);
  if (qty === null) {
    return '<span class="muted" title="平均使用量がないため計算できません。直近30日に切り替えると計算できる場合があります。">-（手動で判断）</span>';
  }
  const days = r.lead_time_days + r.safety_days + ORDER_CYCLE_DAYS;
  return `<strong>${formatQty(qty)}</strong> ${escapeHtml(r.unit)}
    <span class="text-sub" style="display:block">${formatQty(r.daily_usage)}×${days}日−${formatQty(r.current_qty)}</span>`;
}

/**
 * アラートの理由（データベースの判定ルールを、人が読める文章にしたもの）
 *   urgent  : Q = 0、または D ≤ L
 *   warning : D ≤ L + S、または Q ≤ R
 */
export function alertReason(r) {
  const unit = escapeHtml(r.unit);
  const D = r.remaining_days, L = r.lead_time_days, S = r.safety_days;
  if (r.current_qty <= 0) {
    return '<strong>在庫が0です。</strong>至急発注してください。';
  }
  if (r.status === 'urgent' && D !== null) {
    return `残り<strong>${D}日分</strong> ≤ リードタイム<strong>${L}日</strong>：今発注しても到着前に欠品の恐れがあります。`;
  }
  if (r.status === 'warning' && D !== null && D <= L + S) {
    return `残り<strong>${D}日分</strong> ≤ リードタイム${L}日＋安全在庫${S}日＝<strong>${L + S}日</strong>：発注をおすすめします。`;
  }
  if (r.status === 'warning' && r.current_qty <= r.reorder_point) {
    return `現在庫<strong>${formatQty(r.current_qty)}${unit}</strong> ≤ 発注点<strong>${formatQty(r.reorder_point)}${unit}</strong>：発注をおすすめします。`;
  }
  return '';
}
