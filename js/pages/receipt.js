// =====================================================================
// receipt.js  検収登録
//
// 処理の流れ：
//   ① 型番を入力
//   ② products テーブルを型番で検索 → メーカー名・製品名・規格・カテゴリー・現在庫を表示
//   ③ 数量・検収日を入力（登録後の在庫を事前表示）
//   ④ データベース関数 register_receipt を呼び出し
//        → 関数内で「行ロック → 二重送信チェック → 履歴追加 → 在庫加算」を1トランザクションで実行
//   ⑤ 返ってきた「変更前/変更後在庫」を表示し、在庫を再取得して確認
// =====================================================================
import { initPage } from '../layout.js';
import { supabase } from '../supabaseClient.js';
import { fetchProducts, fetchCurrentQty, fetchCancelledIds, TXN_SELECT } from '../data.js';
import {
  escapeHtml, formatQty, formatDate, formatDateTime, errorMessage, toast, setBusy, showAlert,
  normalizeModelNo, parseIntInput, newRequestId, todayJST, addDays, one, nowTime,
} from '../ui.js';

await initPage('receipt');

const els = {
  form: document.getElementById('receipt-form'),
  model: document.getElementById('model-no'),
  lookupBtn: document.getElementById('lookup-btn'),
  info: document.getElementById('product-info'),
  qty: document.getElementById('quantity'),
  unit: document.getElementById('unit-label'),
  date: document.getElementById('receipt-date'),
  note: document.getElementById('note'),
  preview: document.getElementById('stock-preview'),
  error: document.getElementById('form-error'),
  submit: document.getElementById('submit-btn'),
  result: document.getElementById('result-body'),
  recent: document.getElementById('recent-rows'),
  steps: document.querySelectorAll('#flow-steps li'),
};

const today = todayJST();
els.date.value = today;
els.date.max = today;                 // 未来日は選択不可
els.date.min = addDays(today, -30);   // 過去30日以内（データベース側と同じルール）

let product = null;        // 検索で見つかった資材
let lookupSeq = 0;         // 検索の順番（古い検索結果で上書きしないため）
let requestId = newRequestId();
let lookupLog = [];        // 処理ログ（型番検索部分）

// ---------------------------------------------------------------------
// 画面の状態表示
// ---------------------------------------------------------------------
function setStep(current) {
  els.steps.forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('is-done', n < current);
    li.classList.toggle('is-current', n === current);
  });
}

function setInputsEnabled(enabled) {
  [els.qty, els.date, els.note, els.submit].forEach((el) => (el.disabled = !enabled));
}

function showProductInfo() {
  if (!product) return;
  els.info.className = 'info-panel is-found';
  els.info.innerHTML = `
    <dl class="info-grid">
      <dt>型番</dt><dd>${escapeHtml(product.model_no)}</dd>
      <dt>メーカー名</dt><dd>${escapeHtml(product.maker) || '-'}</dd>
      <dt>製品名</dt><dd>${escapeHtml(product.name)}</dd>
      <dt>規格</dt><dd>${escapeHtml(product.spec) || '-'}</dd>
      <dt>カテゴリー</dt><dd>${escapeHtml(product.category_name)}</dd>
      <dt>現在庫</dt><dd><strong>${formatQty(product.current_qty)}</strong> ${escapeHtml(product.unit)}</dd>
    </dl>`;
  els.unit.textContent = product.unit;
}

function resetProduct(message = null, type = '') {
  product = null;
  els.unit.textContent = '-';
  els.preview.hidden = true;
  setInputsEnabled(false);
  els.info.className = `info-panel ${type}`;
  els.info.innerHTML = message ?? '<span class="placeholder-text">型番を入力すると、メーカー名・製品名・規格・カテゴリーがここに表示されます。</span>';
  setStep(1);
}

// 登録後の在庫（予定）を表示。実際の値はデータベースの応答で確定する
function updatePreview() {
  // 入力内容が変わったら送信IDを作り直す（同じ内容の再送信だけを「二重送信」とみなす）
  requestId = newRequestId();
  if (!product) return;
  const qty = parseIntInput(els.qty.value);
  if (qty === null || Number.isNaN(qty) || qty <= 0) {
    els.preview.hidden = true;
    setStep(3);
    return;
  }
  els.preview.hidden = false;
  els.preview.innerHTML = `
    <span>登録後の在庫（予定）</span>
    <strong>${formatQty(product.current_qty)} → ${formatQty(product.current_qty + qty)} ${escapeHtml(product.unit)}
      <span class="text-plus">（+${formatQty(qty)}）</span></strong>`;
  setStep(4);
}

// ---------------------------------------------------------------------
// ② 型番でマスタを検索
// ---------------------------------------------------------------------
async function lookup() {
  const modelNo = normalizeModelNo(els.model.value);
  showAlert(els.error, '');
  if (!modelNo) {
    resetProduct();
    return;
  }
  if (product && product.model_no === modelNo) return;   // 同じ型番は再検索しない

  const seq = ++lookupSeq;
  els.info.className = 'info-panel';
  els.info.innerHTML = '<span class="placeholder-text">医療資材マスタを検索中…</span>';
  const started = performance.now();

  const { data, error } = await supabase
    .from('products')
    .select('id, model_no, maker, name, spec, unit, is_active, categories(name), stocks(current_qty)')
    .eq('model_no', modelNo)
    .maybeSingle();

  if (seq !== lookupSeq) return;   // より新しい検索が始まっていたら結果を捨てる
  const ms = Math.round(performance.now() - started);

  if (error) {
    resetProduct(escapeHtml(errorMessage(error)), 'is-error');
    return;
  }
  if (!data) {
    resetProduct(`型番「${escapeHtml(modelNo)}」は医療資材マスタに登録されていません。<br>
      <span class="text-sub">型番を確認するか、管理者に<a href="products.html">マスタ登録</a>を依頼してください。</span>`, 'is-error');
    return;
  }
  if (!data.is_active) {
    resetProduct(`型番「${escapeHtml(modelNo)}」（${escapeHtml(data.name)}）は使用停止中の資材です。`, 'is-error');
    return;
  }

  product = {
    ...data,
    category_name: one(data.categories)?.name ?? '',
    current_qty: Number(one(data.stocks)?.current_qty ?? 0),
  };
  lookupLog = [
    [nowTime(), `型番「${product.model_no}」で医療資材マスタ（<code>products</code>）を検索`],
    [nowTime(), `該当あり：${escapeHtml(product.name)}／現在庫 ${formatQty(product.current_qty)}${escapeHtml(product.unit)}（${ms}ms）`],
  ];
  if (els.model.value !== product.model_no) els.model.value = product.model_no;   // 正規化した型番を表示

  showProductInfo();
  setInputsEnabled(true);
  updatePreview();
  setStep(els.qty.value ? 4 : 3);
}

// 入力中は少し待ってから自動検索（打ち終わるたびに検索しないように）
let timer = null;
els.model.addEventListener('input', () => {
  clearTimeout(timer);
  const modelNo = normalizeModelNo(els.model.value);
  if (product && product.model_no !== modelNo) resetProduct();
  timer = setTimeout(lookup, 350);
});
els.lookupBtn.addEventListener('click', lookup);

// 型番欄で Enter → 検索して数量欄へ（フォーム送信はしない）
els.model.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  clearTimeout(timer);
  await lookup();
  if (product) els.qty.focus();
});

els.qty.addEventListener('input', updatePreview);
els.date.addEventListener('input', updatePreview);
els.note.addEventListener('input', () => { requestId = newRequestId(); });

// ---------------------------------------------------------------------
// ④ 登録：データベース関数 register_receipt を呼び出す
// ---------------------------------------------------------------------
els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showAlert(els.error, '');

  // 画面側の入力チェック（同じチェックはデータベース関数でも必ず行われる）
  const qty = parseIntInput(els.qty.value);
  const date = els.date.value;
  const errors = [];
  if (!product) errors.push('型番を入力し、資材情報が表示されたことを確認してください。');
  if (qty === null) errors.push('検収数量を入力してください。');
  else if (Number.isNaN(qty) || qty <= 0) errors.push('検収数量は1以上の整数で入力してください。');
  else if (qty > 99999) errors.push('検収数量が大きすぎます。入力内容を確認してください。');
  if (!date) errors.push('検収日を入力してください。');
  else if (date > today) errors.push('検収日に未来の日付は指定できません。');
  else if (date < els.date.min) errors.push('検収日は過去30日以内の日付を指定してください。');
  els.qty.classList.toggle('is-invalid', qty === null || Number.isNaN(qty) || qty <= 0);
  if (errors.length) {
    showAlert(els.error, errors.join(' '));
    return;
  }

  const target = product;
  const sentRequestId = requestId;
  const log = [...lookupLog,
    [nowTime(), `データベース関数 <code>register_receipt</code> を呼び出し（送信ID ${sentRequestId.slice(0, 8)}…）`]];

  const done = setBusy(els.submit, '登録中…');   // 処理中はボタンを無効化（二重クリック防止）
  const { data, error } = await supabase.rpc('register_receipt', {
    p_model_no: target.model_no,
    p_quantity: qty,
    p_receipt_date: date,
    p_note: els.note.value.trim(),
    p_request_id: sentRequestId,
  });
  done();

  if (error) {
    // 通信エラーの場合は送信IDを変えない → 再送しても二重登録にならない
    showAlert(els.error, errorMessage(error));
    return;
  }

  log.push([nowTime(), `応答：在庫 ${formatQty(data.stock_before)} → ${formatQty(data.stock_after)}${escapeHtml(data.unit)}（履歴 No.${data.transaction_id}）`]);

  // ⑤ データベース上の在庫を再取得して確認
  const { qty: dbQty } = await fetchCurrentQty(target.id);
  if (dbQty !== null) {
    log.push([nowTime(), `<code>stocks</code> を再取得して確認：現在庫 ${formatQty(dbQty)}${escapeHtml(data.unit)} ✓`]);
  }

  showResult(data, log);
  if (!data.duplicate) toast(`検収を登録しました：${data.model_no} +${formatQty(data.quantity)}${data.unit}`, 'success');

  // 次の入力に備えてリセット（検収日はそのまま）
  requestId = newRequestId();
  els.model.value = '';
  els.qty.value = '';
  els.note.value = '';
  els.qty.classList.remove('is-invalid');
  resetProduct();
  setStep(5);   // すべて完了表示
  els.model.focus();
  loadRecent();
});

function showResult(r, log) {
  const head = r.duplicate
    ? '<div class="result-head dup">ℹ この登録は既に処理済みです（二重送信を検知したため、在庫は変更していません）</div>'
    : '<div class="result-head ok">✓ 検収を登録し、在庫を更新しました</div>';
  els.result.innerHTML = `
    ${head}
    <dl class="info-grid">
      <dt>型番</dt><dd>${escapeHtml(r.model_no)}</dd>
      <dt>製品名</dt><dd>${escapeHtml(r.name)}</dd>
      <dt>検収数量</dt><dd>${formatQty(r.quantity)} ${escapeHtml(r.unit)}</dd>
      <dt>検収日</dt><dd>${formatDate(r.txn_date)}</dd>
      <dt>履歴No.</dt><dd><a href="history.html?product=${r.product_id}">No.${r.transaction_id}</a></dd>
    </dl>
    <div class="stock-change" aria-label="在庫の変化">
      <span class="from">${formatQty(r.stock_before)}<span class="unit">${escapeHtml(r.unit)}</span></span>
      <span class="arrow">→</span>
      <span class="to">${formatQty(r.stock_after)}<span class="unit">${escapeHtml(r.unit)}</span></span>
      <span class="text-plus">+${formatQty(r.quantity)}</span>
    </div>
    <ol class="process-log">
      ${log.map(([t, msg]) => `<li><span class="t">${t}</span><span>${msg}</span></li>`).join('')}
    </ol>`;
}

// ---------------------------------------------------------------------
// 最近の検収記録
// ---------------------------------------------------------------------
async function loadRecent() {
  const { data, error } = await supabase
    .from('stock_transactions')
    .select(TXN_SELECT)
    .eq('txn_type', 'IN')
    .order('id', { ascending: false })
    .limit(10);

  if (error) {
    els.recent.innerHTML = `<tr><td colspan="9" class="empty">${escapeHtml(errorMessage(error))}</td></tr>`;
    return;
  }
  if (!data.length) {
    els.recent.innerHTML = '<tr><td colspan="9" class="empty">検収記録はまだありません。</td></tr>';
    return;
  }
  const { set: cancelled } = await fetchCancelledIds(data.map((t) => t.id));

  els.recent.innerHTML = data.map((t) => {
    const p = one(t.products) ?? {};
    const isCancelled = cancelled.has(t.id);
    return `
      <tr class="${isCancelled ? 'row-muted' : ''}">
        <td>${t.id}</td>
        <td>${formatDateTime(t.created_at)}</td>
        <td>${formatDate(t.txn_date)}</td>
        <td>${escapeHtml(p.model_no)}</td>
        <td>${escapeHtml(p.name)} <span class="text-sub">${escapeHtml(p.spec)}</span></td>
        <td class="num"><span class="text-plus">+${formatQty(t.quantity)}</span> ${escapeHtml(p.unit)}</td>
        <td class="num">${formatQty(t.stock_before)} → ${formatQty(t.stock_after)}</td>
        <td>${escapeHtml(one(t.staff_profiles)?.display_name ?? '')}</td>
        <td>${isCancelled ? '<span class="badge badge-cancel">取消済み</span>' : '<span class="badge badge-normal">有効</span>'}</td>
      </tr>`;
  }).join('');
}

// ---------------------------------------------------------------------
// 初期表示：型番の入力候補と最近の検収記録
// ---------------------------------------------------------------------
setStep(1);
const { data: list } = await fetchProducts({ activeOnly: true });
document.getElementById('model-list').innerHTML = (list ?? [])
  .map((p) => `<option value="${escapeHtml(p.model_no)}">${escapeHtml(p.name)} ${escapeHtml(p.spec)}</option>`)
  .join('');
loadRecent();
