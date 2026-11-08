// =====================================================================
// history.js  入出庫履歴
//
//   検索条件（資材・区分・期間）はデータベース側で絞り込み、50件ずつ表示
//   取消（管理者のみ）はデータベース関数 cancel_transaction を呼び出す
//     → 元の記録は変更せず、逆方向の CANCEL 記録を追加（修正の痕跡が残る）
//   URL の ?product=ID&type=OUT で条件を指定して開ける（他画面からのリンク用）
// =====================================================================
import { initPage } from '../layout.js';
import { supabase } from '../supabaseClient.js';
import { fetchProducts, fetchCancelledIds, TXN_SELECT } from '../data.js';
import {
  escapeHtml, formatQty, formatDate, formatDateTime, errorMessage, toast, setBusy, showAlert,
  newRequestId, todayJST, addDays, one, signedQty, txnBadge, TXN_TYPES,
} from '../ui.js';

const ctx = await initPage('history');

const PAGE_SIZE = 50;
const DEFAULT_DAYS = 90;
const today = todayJST();

const els = {
  form: document.getElementById('filter-form'),
  product: document.getElementById('f-product'),
  type: document.getElementById('f-type'),
  from: document.getElementById('f-from'),
  to: document.getElementById('f-to'),
  rows: document.getElementById('rows'),
  count: document.getElementById('result-count'),
  pager: document.getElementById('pager'),
  pageError: document.getElementById('page-error'),
};
const colCount = ctx.isAdmin ? 13 : 12;

let page = 0;
let currentRows = [];
let cancelledSet = new Set();

// ---------------------------------------------------------------------
// 検索条件
// ---------------------------------------------------------------------
function readParamsFromUrl() {
  const q = new URLSearchParams(location.search);
  els.product.value = q.get('product') ?? '';
  els.type.value = TXN_TYPES[q.get('type')] ? q.get('type') : '';
  els.from.value = q.get('from') ?? addDays(today, -DEFAULT_DAYS);
  els.to.value = q.get('to') ?? today;
}

function writeParamsToUrl() {
  const q = new URLSearchParams();
  if (els.product.value) q.set('product', els.product.value);
  if (els.type.value) q.set('type', els.type.value);
  if (els.from.value) q.set('from', els.from.value);
  if (els.to.value) q.set('to', els.to.value);
  history.replaceState(null, '', `history.html${q.toString() ? '?' + q : ''}`);
}

// ---------------------------------------------------------------------
// 読み込み（データベース側で絞り込み・ページング）
// ---------------------------------------------------------------------
async function load() {
  showAlert(els.pageError, '');
  if (els.from.value && els.to.value && els.from.value > els.to.value) {
    showAlert(els.pageError, '期間の開始日が終了日より後になっています。');
    return;
  }
  els.rows.innerHTML = `<tr><td colspan="${colCount}" class="empty">読み込み中…</td></tr>`;

  let query = supabase
    .from('stock_transactions')
    .select(TXN_SELECT, { count: 'exact' })
    .order('id', { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (els.product.value) query = query.eq('product_id', els.product.value);
  if (els.type.value) query = query.eq('txn_type', els.type.value);
  if (els.from.value) query = query.gte('txn_date', els.from.value);
  if (els.to.value) query = query.lte('txn_date', els.to.value);

  const { data, error, count } = await query;
  if (error) {
    showAlert(els.pageError, errorMessage(error));
    els.rows.innerHTML = `<tr><td colspan="${colCount}" class="empty">データを読み込めませんでした。</td></tr>`;
    return;
  }

  currentRows = data;
  cancelledSet = (await fetchCancelledIds(data.map((t) => t.id))).set;
  render(count ?? 0);
}

function render(total) {
  const start = total ? page * PAGE_SIZE + 1 : 0;
  const end = Math.min(total, (page + 1) * PAGE_SIZE);
  els.count.textContent = `全 ${total} 件中 ${start}〜${end} 件を表示`;

  if (!currentRows.length) {
    els.rows.innerHTML = `<tr><td colspan="${colCount}" class="empty">該当する記録がありません。</td></tr>`;
  } else {
    els.rows.innerHTML = currentRows.map((t) => {
      const p = one(t.products) ?? {};
      const isCancelled = cancelledSet.has(t.id);

      let status = '<span class="badge badge-normal">有効</span>';
      if (t.txn_type === 'CANCEL') status = `<span class="text-sub">No.${t.reverses_id} を取消</span>`;
      else if (isCancelled) status = '<span class="badge badge-cancel">取消済み</span>';

      const canCancel = t.txn_type !== 'CANCEL' && !isCancelled;
      const action = ctx.isAdmin
        ? `<td>${canCancel ? `<button type="button" class="btn btn-sm btn-danger" data-cancel="${t.id}">取消</button>` : ''}</td>`
        : '';

      return `
        <tr class="${isCancelled ? 'row-muted' : ''}">
          <td>${t.id}</td>
          <td>${formatDateTime(t.created_at)}</td>
          <td>${formatDate(t.txn_date)}</td>
          <td><a href="history.html?product=${t.product_id}">${escapeHtml(p.model_no)}</a></td>
          <td>${escapeHtml(p.name)} <span class="text-sub">${escapeHtml(p.spec)}</span></td>
          <td>${txnBadge(t.txn_type)}</td>
          <td class="num">${signedQty(t.delta)} ${escapeHtml(p.unit)}</td>
          <td class="num">${formatQty(t.stock_before)}</td>
          <td class="num">${formatQty(t.stock_after)}</td>
          <td>${escapeHtml(one(t.staff_profiles)?.display_name ?? '')}</td>
          <td style="white-space:normal;min-width:160px">${escapeHtml(t.note)}</td>
          <td>${status}</td>
          ${action}
        </tr>`;
    }).join('');
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  els.pager.innerHTML = total > PAGE_SIZE ? `
    <button type="button" class="btn btn-sm" data-page="-1" ${page === 0 ? 'disabled' : ''}>← 前へ</button>
    <span>${page + 1} / ${pages} ページ</span>
    <button type="button" class="btn btn-sm" data-page="1" ${page + 1 >= pages ? 'disabled' : ''}>次へ →</button>` : '';
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  page = 0;
  writeParamsToUrl();
  load();
});
document.getElementById('reset-btn').addEventListener('click', () => {
  els.product.value = '';
  els.type.value = '';
  els.from.value = addDays(today, -DEFAULT_DAYS);
  els.to.value = today;
  page = 0;
  writeParamsToUrl();
  load();
});
// 条件を選んだらすぐ反映（日付は検索ボタンで反映）
els.product.addEventListener('change', () => els.form.requestSubmit());
els.type.addEventListener('change', () => els.form.requestSubmit());

els.pager.addEventListener('click', (e) => {
  const step = Number(e.target.closest('[data-page]')?.dataset.page);
  if (!step) return;
  page += step;
  load();
  window.scrollTo({ top: 0 });
});

// ---------------------------------------------------------------------
// 取消（管理者のみ。権限はデータベース関数内でも確認）
// ---------------------------------------------------------------------
const dialog = document.getElementById('cancel-dialog');
const cancelForm = document.getElementById('cancel-form');
const cancelError = document.getElementById('cancel-error');
const reasonEl = document.getElementById('cancel-reason');
let target = null;
let cancelRequestId = null;

function openCancelDialog(txn) {
  target = txn;
  cancelRequestId = newRequestId();
  const p = one(txn.products) ?? {};
  const label = TXN_TYPES[txn.txn_type]?.label ?? txn.txn_type;
  const reverse = -Number(txn.delta);
  showAlert(cancelError, '');
  document.getElementById('cancel-info').innerHTML = `
    <dt>No.</dt><dd>${txn.id}</dd>
    <dt>区分</dt><dd>${txnBadge(txn.txn_type)}</dd>
    <dt>資材</dt><dd>${escapeHtml(p.model_no)} ${escapeHtml(p.name)}</dd>
    <dt>数量</dt><dd>${signedQty(txn.delta)} ${escapeHtml(p.unit)}</dd>
    <dt>業務日</dt><dd>${formatDate(txn.txn_date)}</dd>`;
  document.getElementById('cancel-effect').innerHTML =
    `この${escapeHtml(label)}記録を取消すと、在庫が <strong>${reverse >= 0 ? '+' : '−'}${formatQty(Math.abs(reverse))}${escapeHtml(p.unit)}</strong> 戻ります。`;
  reasonEl.value = '';
  dialog.showModal();
  reasonEl.focus();
}

els.rows.addEventListener('click', (e) => {
  const id = e.target.closest('[data-cancel]')?.dataset.cancel;
  if (id) openCancelDialog(currentRows.find((t) => String(t.id) === id));
});
dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());

cancelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const reason = reasonEl.value.trim();
  if (!reason) {
    showAlert(cancelError, '取消理由を入力してください。');
    reasonEl.classList.add('is-invalid');
    return;
  }
  reasonEl.classList.remove('is-invalid');

  const done = setBusy(document.getElementById('cancel-submit'), '処理中…');
  const { data, error } = await supabase.rpc('cancel_transaction', {
    p_txn_id: target.id,
    p_reason: reason,
    p_request_id: cancelRequestId,
  });
  done();

  if (error) {
    showAlert(cancelError, errorMessage(error));
    return;
  }
  dialog.close();
  toast(`No.${target.id} を取消しました（在庫 ${formatQty(data.stock_before)} → ${formatQty(data.stock_after)}${data.unit}）`, 'success');
  load();
});

// ---------------------------------------------------------------------
// 初期表示
// ---------------------------------------------------------------------
const { data: products, error } = await fetchProducts();
if (error) {
  showAlert(els.pageError, errorMessage(error));
} else {
  els.product.innerHTML = '<option value="">すべての資材</option>' + products
    .map((p) => `<option value="${p.id}">${escapeHtml(p.model_no)}　${escapeHtml(p.name)}（${escapeHtml(p.spec)}）${p.is_active ? '' : '［使用停止］'}</option>`)
    .join('');
}
readParamsFromUrl();
load();
