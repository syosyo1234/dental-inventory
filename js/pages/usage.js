// =====================================================================
// usage.js  使用登録（出庫）
//
//   資材を選択 → 最新在庫を取得して表示 → 使用数量を入力
//   → データベース関数 register_usage を呼び出し
//      （関数内で行ロックしてから在庫を確認するため、同時に登録されてもマイナスにならない）
// =====================================================================
import { initPage } from '../layout.js';
import { supabase } from '../supabaseClient.js';
import { fetchProducts, fetchCategories, fetchCurrentQty, fetchCancelledIds, TXN_SELECT } from '../data.js';
import {
  escapeHtml, formatQty, formatDate, formatDateTime, errorMessage, toast, setBusy, showAlert,
  normalizeModelNo, parseIntInput, newRequestId, todayJST, addDays, one, isNetworkError,
} from '../ui.js';

await initPage('usage');

const els = {
  form: document.getElementById('usage-form'),
  category: document.getElementById('f-category'),
  select: document.getElementById('product-select'),
  model: document.getElementById('model-no'),
  info: document.getElementById('product-info'),
  qty: document.getElementById('quantity'),
  unit: document.getElementById('unit-label'),
  date: document.getElementById('usage-date'),
  note: document.getElementById('note'),
  preview: document.getElementById('stock-preview'),
  error: document.getElementById('form-error'),
  submit: document.getElementById('submit-btn'),
  result: document.getElementById('result-body'),
  historyRows: document.getElementById('history-rows'),
  historyTitle: document.getElementById('history-title'),
  historyLink: document.getElementById('history-link'),
};

const today = todayJST();
els.date.value = today;
els.date.max = today;
els.date.min = addDays(today, -30);

let products = [];
let product = null;
let requestId = newRequestId();

// ---------------------------------------------------------------------
// 資材の選択
// ---------------------------------------------------------------------
function fillProductSelect() {
  const cat = els.category.value;
  const current = els.select.value;
  els.select.innerHTML = '<option value="">選択してください</option>' + products
    .filter((p) => !cat || String(p.category_id) === cat)
    .map((p) => `<option value="${p.id}">${escapeHtml(p.model_no)}　${escapeHtml(p.name)}（${escapeHtml(p.spec)}）</option>`)
    .join('');
  els.select.value = current;
}

function setInputsEnabled(enabled) {
  [els.qty, els.date, els.note, els.submit].forEach((el) => (el.disabled = !enabled));
}

async function selectProduct(id) {
  showAlert(els.error, '');
  requestId = newRequestId();
  const base = products.find((p) => String(p.id) === String(id));
  if (!base) {
    product = null;
    setInputsEnabled(false);
    els.unit.textContent = '-';
    els.preview.hidden = true;
    els.info.className = 'info-panel';
    els.info.innerHTML = '<span class="placeholder-text">資材を選択すると、規格と現在庫が表示されます。</span>';
    loadHistory();
    return;
  }

  // 一覧を読み込んだ後に他のスタッフが登録しているかもしれないので、最新在庫を取り直す
  const { qty } = await fetchCurrentQty(base.id);
  product = { ...base, current_qty: qty ?? base.current_qty };
  base.current_qty = product.current_qty;

  els.select.value = String(product.id);
  els.model.value = product.model_no;
  els.unit.textContent = product.unit;
  els.info.className = 'info-panel is-found';
  els.info.innerHTML = `
    <dl class="info-grid">
      <dt>型番</dt><dd>${escapeHtml(product.model_no)}</dd>
      <dt>メーカー名</dt><dd>${escapeHtml(product.maker) || '-'}</dd>
      <dt>製品名</dt><dd>${escapeHtml(product.name)}</dd>
      <dt>規格</dt><dd>${escapeHtml(product.spec) || '-'}</dd>
      <dt>現在庫</dt><dd><strong>${formatQty(product.current_qty)}</strong> ${escapeHtml(product.unit)}</dd>
    </dl>`;
  setInputsEnabled(product.current_qty > 0);
  if (product.current_qty <= 0) {
    showAlert(els.error, '在庫が0のため使用登録できません。', 'warning');
  }
  updatePreview();
  loadHistory();
}

els.category.addEventListener('change', fillProductSelect);
els.select.addEventListener('change', () => selectProduct(els.select.value));

// 型番入力で選択（Enter またはフォーカスが外れたとき）
function selectByModel() {
  const modelNo = normalizeModelNo(els.model.value);
  if (!modelNo || modelNo === product?.model_no) return;
  const found = products.find((p) => p.model_no === modelNo);
  if (found) {
    els.category.value = '';
    fillProductSelect();
    selectProduct(found.id);
  } else {
    showAlert(els.error, `型番「${modelNo}」は登録されていないか、使用停止中です。`);
  }
}
els.model.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  selectByModel();
  if (product) els.qty.focus();
});
els.model.addEventListener('change', selectByModel);

// ---------------------------------------------------------------------
// 登録後在庫のプレビュー（在庫超過は画面でも警告。最終判定はデータベース）
// ---------------------------------------------------------------------
function updatePreview() {
  requestId = newRequestId();
  if (!product) return;
  const qty = parseIntInput(els.qty.value);
  els.qty.classList.remove('is-invalid');
  if (qty === null || Number.isNaN(qty) || qty <= 0) {
    els.preview.hidden = true;
    return;
  }
  const after = product.current_qty - qty;
  els.preview.hidden = false;
  if (after < 0) {
    els.qty.classList.add('is-invalid');
    els.preview.innerHTML = `<span class="text-minus">在庫数（${formatQty(product.current_qty)}${escapeHtml(product.unit)}）を超えています</span>`;
    return;
  }
  els.preview.innerHTML = `
    <span>登録後の在庫（予定）</span>
    <strong>${formatQty(product.current_qty)} → ${formatQty(after)} ${escapeHtml(product.unit)}
      <span class="text-minus">（−${formatQty(qty)}）</span></strong>`;
}
els.qty.addEventListener('input', updatePreview);
els.date.addEventListener('input', () => { requestId = newRequestId(); });
els.note.addEventListener('input', () => { requestId = newRequestId(); });

// ---------------------------------------------------------------------
// 登録：データベース関数 register_usage
// ---------------------------------------------------------------------
els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showAlert(els.error, '');

  const qty = parseIntInput(els.qty.value);
  const date = els.date.value;
  const errors = [];
  if (!product) errors.push('資材を選択してください。');
  if (qty === null) errors.push('使用数量を入力してください。');
  else if (Number.isNaN(qty) || qty <= 0) errors.push('使用数量は1以上の整数で入力してください。');
  else if (product && qty > product.current_qty) errors.push(`使用数量が現在庫（${formatQty(product.current_qty)}${product.unit}）を超えています。`);
  if (!date) errors.push('使用日を入力してください。');
  else if (date > today) errors.push('使用日に未来の日付は指定できません。');
  else if (date < els.date.min) errors.push('使用日は過去30日以内の日付を指定してください。');
  if (errors.length) {
    showAlert(els.error, errors.join(' '));
    return;
  }

  const target = product;
  const done = setBusy(els.submit, '登録中…');
  const { data, error } = await supabase.rpc('register_usage', {
    p_product_id: target.id,
    p_quantity: qty,
    p_usage_date: date,
    p_note: els.note.value.trim(),
    p_request_id: requestId,
  });
  done();

  if (error) {
    showAlert(els.error, errorMessage(error));
    // 通信エラーのときは送信IDを変えない（再送しても二重登録にならない）。
    // それ以外（在庫不足など）は最新在庫で表示を更新する
    if (!isNetworkError(error)) {
      const message = els.error.innerHTML;
      await selectProduct(target.id);
      els.error.innerHTML = message;
    }
    return;
  }

  els.result.innerHTML = `
    ${data.duplicate
      ? '<div class="result-head dup">ℹ この登録は既に処理済みです（二重送信を検知したため、在庫は変更していません）</div>'
      : '<div class="result-head ok">✓ 使用を登録し、在庫を更新しました</div>'}
    <dl class="info-grid">
      <dt>型番</dt><dd>${escapeHtml(data.model_no)}</dd>
      <dt>製品名</dt><dd>${escapeHtml(data.name)}</dd>
      <dt>使用数量</dt><dd>${formatQty(data.quantity)} ${escapeHtml(data.unit)}</dd>
      <dt>使用日</dt><dd>${formatDate(data.txn_date)}</dd>
      <dt>履歴No.</dt><dd>No.${data.transaction_id}</dd>
    </dl>
    <div class="stock-change">
      <span class="from">${formatQty(data.stock_before)}<span class="unit">${escapeHtml(data.unit)}</span></span>
      <span class="arrow">→</span>
      <span class="to">${formatQty(data.stock_after)}<span class="unit">${escapeHtml(data.unit)}</span></span>
      <span class="text-minus">−${formatQty(data.quantity)}</span>
    </div>`;
  if (!data.duplicate) toast(`使用を登録しました：${data.model_no} −${formatQty(data.quantity)}${data.unit}`, 'success');

  els.qty.value = '';
  els.note.value = '';
  await selectProduct(target.id);   // 最新在庫と履歴を再表示（送信IDもここで新しくなる）
  els.qty.focus();
});

// ---------------------------------------------------------------------
// 使用履歴（資材選択中はその資材のみ）
// ---------------------------------------------------------------------
async function loadHistory() {
  let query = supabase
    .from('stock_transactions')
    .select(TXN_SELECT)
    .eq('txn_type', 'OUT')
    .order('id', { ascending: false })
    .limit(product ? 15 : 10);
  if (product) query = query.eq('product_id', product.id);

  els.historyTitle.textContent = product ? `使用履歴：${product.model_no} ${product.name}` : '最近の使用記録（全資材）';
  els.historyLink.href = product ? `history.html?product=${product.id}&type=OUT` : 'history.html?type=OUT';
  els.historyLink.textContent = product ? 'この資材の履歴をすべて見る →' : 'すべての出庫履歴を見る →';

  const { data, error } = await query;
  if (error) {
    els.historyRows.innerHTML = `<tr><td colspan="10" class="empty">${escapeHtml(errorMessage(error))}</td></tr>`;
    return;
  }
  if (!data.length) {
    els.historyRows.innerHTML = '<tr><td colspan="10" class="empty">使用記録はまだありません。</td></tr>';
    return;
  }
  const { set: cancelled } = await fetchCancelledIds(data.map((t) => t.id));
  els.historyRows.innerHTML = data.map((t) => {
    const p = one(t.products) ?? {};
    const isCancelled = cancelled.has(t.id);
    return `
      <tr class="${isCancelled ? 'row-muted' : ''}">
        <td>${t.id}</td>
        <td>${formatDate(t.txn_date)}</td>
        <td>${formatDateTime(t.created_at)}</td>
        <td>${escapeHtml(p.model_no)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td class="num"><span class="text-minus">−${formatQty(t.quantity)}</span> ${escapeHtml(p.unit)}</td>
        <td class="num">${formatQty(t.stock_before)} → ${formatQty(t.stock_after)}</td>
        <td>${escapeHtml(one(t.staff_profiles)?.display_name ?? '')}</td>
        <td>${escapeHtml(t.note)}</td>
        <td>${isCancelled ? '<span class="badge badge-cancel">取消済み</span>' : '<span class="badge badge-normal">有効</span>'}</td>
      </tr>`;
  }).join('');
}

// ---------------------------------------------------------------------
// 初期表示（?product=ID で資材を指定して開ける）
// ---------------------------------------------------------------------
const [p, c] = await Promise.all([fetchProducts({ activeOnly: true }), fetchCategories()]);
if (p.error || c.error) {
  showAlert(els.error, errorMessage(p.error || c.error));
} else {
  products = p.data;
  els.category.innerHTML = '<option value="">すべて</option>' +
    c.data.map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
  fillProductSelect();
}
const initialId = new URLSearchParams(location.search).get('product');
if (initialId) await selectProduct(initialId);
else loadHistory();
