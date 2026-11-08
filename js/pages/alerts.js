// =====================================================================
// alerts.js  発注アラート
//   get_inventory_status の結果から「緊急」「注意」の資材だけを表示。
//   「発注済みにする / 解除」はデータベース関数 set_ordered（スタッフ可）。
//   検収登録（register_receipt）すると、発注済みフラグは自動で解除される。
// =====================================================================
import { initPage } from '../layout.js';
import { supabase } from '../supabaseClient.js';
import { escapeHtml, formatQty, errorMessage, showAlert, toast, setBusy } from '../ui.js';
import {
  fetchInventoryStatus, sortByUrgency, usageHtml, remainingHtml, orderStatusHtml, alertReason, suggestedOrderHtml, PERIODS,
} from '../stock.js';

await initPage('alerts');

const els = {
  periodToggle: document.getElementById('period-toggle'),
  hideOrdered: document.getElementById('hide-ordered'),
  urgentRows: document.getElementById('urgent-rows'),
  warningRows: document.getElementById('warning-rows'),
  urgentTitle: document.getElementById('urgent-title'),
  warningTitle: document.getElementById('warning-title'),
  pageError: document.getElementById('page-error'),
};

const q = new URLSearchParams(location.search);
let period = PERIODS.includes(Number(q.get('period'))) ? Number(q.get('period')) : 7;
let rows = [];

async function load() {
  els.periodToggle.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.period) === period)));

  const { data, error } = await fetchInventoryStatus(period);
  if (error) {
    showAlert(els.pageError, errorMessage(error));
    return;
  }
  showAlert(els.pageError, '');
  rows = data.filter((r) => r.status !== 'normal').sort(sortByUrgency);
  render();
}

function rowHtml(r) {
  const action = r.ordered_at
    ? `<button type="button" class="btn btn-sm" data-unorder="${r.product_id}">発注済みを解除</button>`
    : `<button type="button" class="btn btn-sm btn-primary" data-order="${r.product_id}">発注済みにする</button>`;
  return `
    <tr class="st-${r.status}">
      <td><strong>${escapeHtml(r.model_no)}</strong></td>
      <td>${escapeHtml(r.name)}<br><span class="text-sub">${escapeHtml(r.spec)}</span></td>
      <td class="num"><strong>${formatQty(r.current_qty)}</strong> ${escapeHtml(r.unit)}</td>
      <td class="num">${usageHtml(r)}</td>
      <td class="num days-cell">${remainingHtml(r)}</td>
      <td class="num">${r.lead_time_days}日</td>
      <td class="num">${suggestedOrderHtml(r)}</td>
      <td class="reason">${alertReason(r)}</td>
      <td>${orderStatusHtml(r)}</td>
      <td>
        ${action}
        <a class="btn btn-sm" href="history.html?product=${r.product_id}">履歴</a>
      </td>
    </tr>`;
}

function renderSection(tbody, titleEl, label, list, emptyText) {
  const notOrdered = list.filter((r) => !r.ordered_at).length;
  titleEl.textContent = `${label}（${list.length}件・うち未発注 ${notOrdered}件）`;
  const shown = els.hideOrdered.checked ? list.filter((r) => !r.ordered_at) : list;
  tbody.innerHTML = shown.length
    ? shown.map(rowHtml).join('')
    : `<tr><td colspan="10" class="empty">${emptyText}</td></tr>`;
}

function render() {
  renderSection(els.urgentRows, els.urgentTitle, '至急発注が必要な資材',
    rows.filter((r) => r.status === 'urgent'), '該当する資材はありません。');
  renderSection(els.warningRows, els.warningTitle, '発注をおすすめする資材',
    rows.filter((r) => r.status === 'warning'), '該当する資材はありません。');
}

// ---------------------------------------------------------------------
// 発注済みの設定・解除
// ---------------------------------------------------------------------
document.querySelector('.main').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-order], [data-unorder]');
  if (!btn) return;
  const ordered = btn.hasAttribute('data-order');
  const id = Number(btn.dataset.order ?? btn.dataset.unorder);
  const r = rows.find((x) => x.product_id === id);

  const done = setBusy(btn, '処理中…');
  const { error } = await supabase.rpc('set_ordered', { p_product_id: id, p_ordered: ordered });
  done();
  if (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  toast(ordered ? `${r.model_no} を発注済みにしました。` : `${r.model_no} の発注済みを解除しました。`, 'success');
  await load();
});

els.periodToggle.addEventListener('click', (e) => {
  const p = Number(e.target.closest('[data-period]')?.dataset.period);
  if (!p || p === period) return;
  period = p;
  history.replaceState(null, '', period === 7 ? 'alerts.html' : `alerts.html?period=${period}`);
  load();
});
els.hideOrdered.addEventListener('change', render);

await load();
