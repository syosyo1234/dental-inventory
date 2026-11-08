// =====================================================================
// products.js  医療資材マスタ
//   一覧・検索・カテゴリー絞り込み（全員）
//   新規登録・編集・在庫調整（管理者のみ。権限はデータベース側でも再チェック）
// =====================================================================
import { initPage } from '../layout.js';
import { supabase } from '../supabaseClient.js';
import { fetchProducts, fetchCategories } from '../data.js';
import {
  escapeHtml, formatQty, errorMessage, toast, setBusy, showAlert,
  normalizeModelNo, parseIntInput, parseDecimalInput, newRequestId,
} from '../ui.js';

const ctx = await initPage('products');

const els = {
  keyword: document.getElementById('f-keyword'),
  category: document.getElementById('f-category'),
  active: document.getElementById('f-active'),
  rows: document.getElementById('product-rows'),
  count: document.getElementById('result-count'),
  pageError: document.getElementById('page-error'),
};

let products = [];
let categories = [];

// ---------------------------------------------------------------------
// データ読み込み
// ---------------------------------------------------------------------
async function load() {
  const [p, c] = await Promise.all([fetchProducts(), fetchCategories()]);
  if (p.error || c.error) {
    showAlert(els.pageError, errorMessage(p.error || c.error));
    els.rows.innerHTML = '<tr><td colspan="12" class="empty">データを読み込めませんでした。</td></tr>';
    return;
  }
  showAlert(els.pageError, '');
  products = p.data;
  categories = c.data;
  const selected = els.category.value;   // 再読み込み時も絞り込み条件を保持
  fillCategorySelects();
  els.category.value = selected;
  render();
}

function fillCategorySelects() {
  const opts = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  els.category.innerHTML = '<option value="">すべて</option>' + opts;
  document.getElementById('p-category_id').innerHTML = '<option value="">選択してください</option>' + opts;
}

// ---------------------------------------------------------------------
// 一覧表示（検索・絞り込みはブラウザ内で実行）
// ---------------------------------------------------------------------
function render() {
  const kw = els.keyword.value.trim().normalize('NFKC').toLowerCase();
  const kwModel = normalizeModelNo(els.keyword.value);
  const cat = els.category.value;
  const active = els.active.value;

  const list = products.filter((p) => {
    if (cat && String(p.category_id) !== cat) return false;
    if (active === 'active' && !p.is_active) return false;
    if (active === 'inactive' && p.is_active) return false;
    if (!kw) return true;
    return p.model_no.includes(kwModel)
      || p.name.normalize('NFKC').toLowerCase().includes(kw)
      || p.maker.normalize('NFKC').toLowerCase().includes(kw);
  });

  els.count.textContent = `${list.length} 件（全 ${products.length} 件）`;

  if (!list.length) {
    els.rows.innerHTML = '<tr><td colspan="12" class="empty">該当する資材がありません。</td></tr>';
    return;
  }

  els.rows.innerHTML = list.map((p) => {
    const adminButtons = ctx.isAdmin
      ? `<button type="button" class="btn btn-sm" data-edit="${p.id}">編集</button>
         <button type="button" class="btn btn-sm" data-adjust="${p.id}" ${p.is_active ? '' : 'disabled'}>在庫調整</button>`
      : '';
    return `
      <tr class="${p.is_active ? '' : 'row-muted'}">
        <td><strong>${escapeHtml(p.model_no)}</strong></td>
        <td>${escapeHtml(p.maker)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.spec)}</td>
        <td>${escapeHtml(p.category_name)}</td>
        <td class="num">${formatQty(p.current_qty)}</td>
        <td>${escapeHtml(p.unit)}</td>
        <td class="num">${formatQty(p.reorder_point)}</td>
        <td class="num">${p.lead_time_days}日</td>
        <td class="num">${p.safety_days}日</td>
        <td>${p.is_active ? '<span class="badge badge-normal">使用中</span>' : '<span class="badge badge-none">使用停止</span>'}</td>
        <td>
          <a class="btn btn-sm" href="history.html?product=${p.id}">履歴</a>
          ${adminButtons}
        </td>
      </tr>`;
  }).join('');
}

els.keyword.addEventListener('input', render);
els.category.addEventListener('change', render);
els.active.addEventListener('change', render);

// ---------------------------------------------------------------------
// 新規登録・編集ダイアログ
// ---------------------------------------------------------------------
const productDialog = document.getElementById('product-dialog');
const productForm = document.getElementById('product-form');
const productError = document.getElementById('product-form-error');
const f = (name) => document.getElementById(`p-${name}`);
let editingId = null;

function openProductDialog(product = null) {
  editingId = product?.id ?? null;
  showAlert(productError, '');
  productForm.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));

  document.getElementById('product-dialog-title').textContent = product ? `資材の編集（${product.model_no}）` : '資材の新規登録';
  document.getElementById('initial-qty-field').hidden = !!product;
  document.getElementById('active-field').hidden = !product;
  document.getElementById('edit-stock-note').hidden = !product;

  f('model_no').value = product?.model_no ?? '';
  f('maker').value = product?.maker ?? '';
  f('name').value = product?.name ?? '';
  f('spec').value = product?.spec ?? '';
  f('category_id').value = product?.category_id ?? '';
  f('unit').value = product?.unit ?? '';
  f('reorder_point').value = product ? formatQty(product.reorder_point) : '0';
  f('lead_time_days').value = product?.lead_time_days ?? 7;
  f('safety_days').value = product?.safety_days ?? 3;
  f('manual_daily_usage').value = product?.manual_daily_usage ?? '';
  f('notes').value = product?.notes ?? '';
  f('is_active').checked = product?.is_active ?? true;
  f('initial_qty').value = '0';

  productDialog.showModal();
  f('model_no').focus();
}

// 画面側の入力チェック（同じチェックはデータベース関数でも行う）
function readProductForm() {
  const v = {
    model_no: normalizeModelNo(f('model_no').value),
    maker: f('maker').value.trim(),
    name: f('name').value.trim(),
    spec: f('spec').value.trim(),
    category_id: f('category_id').value ? Number(f('category_id').value) : null,
    unit: f('unit').value.trim(),
    reorder_point: parseIntInput(f('reorder_point').value),
    lead_time_days: parseIntInput(f('lead_time_days').value),
    safety_days: parseIntInput(f('safety_days').value),
    manual_daily_usage: parseDecimalInput(f('manual_daily_usage').value),
    notes: f('notes').value.trim(),
    is_active: f('is_active').checked,
    initial_qty: parseIntInput(f('initial_qty').value) ?? 0,
  };

  const errors = [];
  const mark = (name, msg) => { f(name).classList.add('is-invalid'); errors.push(msg); };
  productForm.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));

  if (!v.model_no) mark('model_no', '型番を入力してください。');
  if (!v.name) mark('name', '製品名を入力してください。');
  if (!v.category_id) mark('category_id', 'カテゴリーを選択してください。');
  if (!v.unit) mark('unit', '単位を入力してください。');
  if (v.reorder_point === null || Number.isNaN(v.reorder_point)) mark('reorder_point', '発注点は0以上の整数で入力してください。');
  if (v.lead_time_days === null || Number.isNaN(v.lead_time_days) || v.lead_time_days > 365) mark('lead_time_days', '発注リードタイムは0〜365の整数で入力してください。');
  if (v.safety_days === null || Number.isNaN(v.safety_days) || v.safety_days > 365) mark('safety_days', '安全在庫日数は0〜365の整数で入力してください。');
  if (Number.isNaN(v.manual_daily_usage) || v.manual_daily_usage === 0) mark('manual_daily_usage', '平均使用量は0より大きい数値で入力してください（未設定の場合は空欄）。');
  if (!editingId && Number.isNaN(v.initial_qty)) mark('initial_qty', '初期在庫数は0以上の整数で入力してください。');

  return { v, errors };
}

productForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { v, errors } = readProductForm();
  if (errors.length) {
    showAlert(productError, errors.join(' '));
    return;
  }

  const done = setBusy(document.getElementById('product-save-btn'), '保存中…');
  // 登録・更新はデータベース関数 save_product で実行（管理者チェック・型番重複チェックも関数内）
  const { error } = await supabase.rpc('save_product', {
    p_id: editingId,
    p_model_no: v.model_no,
    p_maker: v.maker,
    p_name: v.name,
    p_spec: v.spec,
    p_category_id: v.category_id,
    p_unit: v.unit,
    p_reorder_point: v.reorder_point,
    p_lead_time_days: v.lead_time_days,
    p_safety_days: v.safety_days,
    p_manual_daily_usage: v.manual_daily_usage,
    p_notes: v.notes,
    p_is_active: editingId ? v.is_active : true,
    p_initial_qty: editingId ? 0 : v.initial_qty,
  });
  done();

  if (error) {
    showAlert(productError, errorMessage(error));
    return;
  }
  productDialog.close();
  toast(editingId ? `「${v.model_no}」を更新しました。` : `「${v.model_no}」を登録しました。`, 'success');
  await load();
});

// ---------------------------------------------------------------------
// 在庫調整（棚卸）ダイアログ
// ---------------------------------------------------------------------
const adjustDialog = document.getElementById('adjust-dialog');
const adjustForm = document.getElementById('adjust-form');
const adjustError = document.getElementById('adjust-form-error');
const actualEl = document.getElementById('a-actual');
const reasonEl = document.getElementById('a-reason');
const adjustPreview = document.getElementById('adjust-preview');
let adjusting = null;
let adjustRequestId = null;

function openAdjustDialog(product) {
  adjusting = product;
  adjustRequestId = newRequestId();   // ダイアログを開くたびに新しい送信ID
  showAlert(adjustError, '');
  document.getElementById('adjust-info').innerHTML = `
    <dt>型番</dt><dd>${escapeHtml(product.model_no)}</dd>
    <dt>製品名</dt><dd>${escapeHtml(product.name)} ${escapeHtml(product.spec)}</dd>
    <dt>帳簿在庫</dt><dd>${formatQty(product.current_qty)} ${escapeHtml(product.unit)}</dd>`;
  document.getElementById('a-unit').textContent = product.unit;
  actualEl.value = '';
  reasonEl.value = '';
  updateAdjustPreview();
  adjustDialog.showModal();
  actualEl.focus();
}

function updateAdjustPreview() {
  const actual = parseIntInput(actualEl.value);
  if (actual === null || Number.isNaN(actual)) {
    adjustPreview.innerHTML = '<span class="muted">実在庫数を入力すると差異が表示されます</span>';
    return;
  }
  const diff = actual - adjusting.current_qty;
  const diffText = diff > 0 ? `<span class="text-plus">+${formatQty(diff)}</span>`
    : diff < 0 ? `<span class="text-minus">−${formatQty(-diff)}</span>` : '±0（差異なし）';
  adjustPreview.innerHTML = `<span>差異 ${diffText}</span>
    <strong>${formatQty(adjusting.current_qty)} → ${formatQty(actual)} ${escapeHtml(adjusting.unit)}</strong>`;
}
actualEl.addEventListener('input', updateAdjustPreview);

adjustForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const actual = parseIntInput(actualEl.value);
  const reason = reasonEl.value.trim();
  if (actual === null || Number.isNaN(actual)) {
    showAlert(adjustError, '実在庫数は0以上の整数で入力してください。');
    return;
  }
  if (!reason) {
    showAlert(adjustError, '調整理由を入力してください。');
    return;
  }

  const done = setBusy(document.getElementById('adjust-save-btn'), '登録中…');
  const { data, error } = await supabase.rpc('adjust_stock', {
    p_product_id: adjusting.id,
    p_actual_qty: actual,
    p_reason: reason,
    p_request_id: adjustRequestId,
  });
  done();

  if (error) {
    showAlert(adjustError, errorMessage(error));
    return;
  }
  adjustDialog.close();
  toast(`在庫を調整しました：${formatQty(data.stock_before)} → ${formatQty(data.stock_after)} ${adjusting.unit}`, 'success');
  await load();
});

// ---------------------------------------------------------------------
// ボタン操作
// ---------------------------------------------------------------------
document.getElementById('new-btn')?.addEventListener('click', () => openProductDialog());

els.rows.addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit]')?.dataset.edit;
  const adjustId = e.target.closest('[data-adjust]')?.dataset.adjust;
  if (editId) openProductDialog(products.find((p) => String(p.id) === editId));
  if (adjustId) openAdjustDialog(products.find((p) => String(p.id) === adjustId));
});

document.querySelectorAll('dialog [data-close]').forEach((btn) =>
  btn.addEventListener('click', () => btn.closest('dialog').close()));

// 初期表示
await load();
