// =====================================================================
// inventory.js  在庫一覧
//   データベース関数 get_inventory_status(7 or 30) の結果を表示し、
//   キーワード・カテゴリー・状態でブラウザ内絞り込みを行う。
//   URL の ?status=urgent&period=30 で条件を指定して開ける。
// =====================================================================
import { initPage } from '../layout.js';
import { fetchCategories } from '../data.js';
import { escapeHtml, formatQty, errorMessage, showAlert, statusBadge, normalizeModelNo } from '../ui.js';
import {
  fetchInventoryStatus, sortByUrgency, daysForSort, usageHtml, remainingHtml, orderStatusHtml, PERIODS,
} from '../stock.js';

await initPage('inventory');

const els = {
  periodToggle: document.getElementById('period-toggle'),
  summary: document.getElementById('status-summary'),
  keyword: document.getElementById('f-keyword'),
  category: document.getElementById('f-category'),
  status: document.getElementById('f-status'),
  sort: document.getElementById('f-sort'),
  rows: document.getElementById('rows'),
  count: document.getElementById('result-count'),
  thPeriod: document.getElementById('th-period'),
  pageError: document.getElementById('page-error'),
};

const q = new URLSearchParams(location.search);
let period = PERIODS.includes(Number(q.get('period'))) ? Number(q.get('period')) : 7;
els.status.value = ['urgent', 'warning', 'normal', 'none'].includes(q.get('status')) ? q.get('status') : '';
let rows = [];

// ---------------------------------------------------------------------
// 読み込み（期間を切り替えるたびにデータベースで再計算）
// ---------------------------------------------------------------------
async function load() {
  els.periodToggle.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.period) === period)));
  els.thPeriod.textContent = `直近${period}日の使用量`;
  els.rows.innerHTML = '<tr><td colspan="12" class="empty">計算中…</td></tr>';

  const { data, error } = await fetchInventoryStatus(period);
  if (error) {
    showAlert(els.pageError, errorMessage(error));
    els.rows.innerHTML = '<tr><td colspan="12" class="empty">データを読み込めませんでした。</td></tr>';
    return;
  }
  showAlert(els.pageError, '');
  rows = data;
  render();
}

function renderSummary() {
  const count = (fn) => rows.filter(fn).length;
  const chips = [
    { key: '', label: 'すべて', n: rows.length, dot: '' },
    { key: 'urgent', label: '緊急', n: count((r) => r.status === 'urgent'), dot: 'dot-urgent' },
    { key: 'warning', label: '注意', n: count((r) => r.status === 'warning'), dot: 'dot-warning' },
    { key: 'normal', label: '正常', n: count((r) => r.status === 'normal'), dot: 'dot-normal' },
    { key: 'none', label: 'データ不足', n: count((r) => r.usage_source === 'none'), dot: 'dot-none' },
  ];
  els.summary.innerHTML = chips.map((c) => `
    <button type="button" class="status-chip" data-status="${c.key}" aria-pressed="${els.status.value === c.key}">
      ${c.dot ? `<span class="dot ${c.dot}"></span>` : ''}${c.label} <strong>${c.n}</strong>
    </button>`).join('');
}

function render() {
  renderSummary();

  const kw = els.keyword.value.trim().normalize('NFKC').toLowerCase();
  const kwModel = normalizeModelNo(els.keyword.value);
  const cat = els.category.value;
  const st = els.status.value;

  const list = rows.filter((r) => {
    if (cat && String(r.category_id) !== cat) return false;
    if (st === 'none' && r.usage_source !== 'none') return false;
    if (st && st !== 'none' && r.status !== st) return false;
    if (!kw) return true;
    return r.model_no.includes(kwModel) || r.name.normalize('NFKC').toLowerCase().includes(kw);
  });

  const sorters = {
    urgency: sortByUrgency,
    model: (a, b) => a.model_no.localeCompare(b.model_no),
    days: (a, b) => (daysForSort(a) - daysForSort(b)) || sortByUrgency(a, b),
  };
  list.sort(sorters[els.sort.value]);

  els.count.textContent = `${list.length} 件（全 ${rows.length} 件）`;
  if (!list.length) {
    els.rows.innerHTML = '<tr><td colspan="12" class="empty">該当する資材がありません。</td></tr>';
    return;
  }

  els.rows.innerHTML = list.map((r) => `
    <tr class="st-${r.status}">
      <td><strong>${escapeHtml(r.model_no)}</strong></td>
      <td>${escapeHtml(r.name)} <span class="text-sub">${escapeHtml(r.spec)}</span></td>
      <td>${escapeHtml(r.category_name)}</td>
      <td class="num"><strong>${formatQty(r.current_qty)}</strong> ${escapeHtml(r.unit)}</td>
      <td class="num">${formatQty(r.period_usage)} ${escapeHtml(r.unit)}</td>
      <td class="num">${usageHtml(r)}</td>
      <td class="num days-cell">${remainingHtml(r)}</td>
      <td class="num">${r.lead_time_days}日＋${r.safety_days}日</td>
      <td class="num">${formatQty(r.reorder_point)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${orderStatusHtml(r)}</td>
      <td>
        <a class="btn btn-sm" href="usage.html?product=${r.product_id}">使用登録</a>
        <a class="btn btn-sm" href="history.html?product=${r.product_id}">履歴</a>
      </td>
    </tr>`).join('');
}

// ---------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------
els.periodToggle.addEventListener('click', (e) => {
  const p = Number(e.target.closest('[data-period]')?.dataset.period);
  if (!p || p === period) return;
  period = p;
  syncUrl();
  load();
});

els.summary.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-status]');
  if (!chip) return;
  els.status.value = chip.dataset.status;
  syncUrl();
  render();
});

[els.keyword].forEach((el) => el.addEventListener('input', render));
[els.category, els.sort].forEach((el) => el.addEventListener('change', render));
els.status.addEventListener('change', () => { syncUrl(); render(); });

function syncUrl() {
  const p = new URLSearchParams();
  if (period !== 7) p.set('period', period);
  if (els.status.value) p.set('status', els.status.value);
  history.replaceState(null, '', `inventory.html${p.toString() ? '?' + p : ''}`);
}

// ---------------------------------------------------------------------
// 初期表示
// ---------------------------------------------------------------------
const { data: cats } = await fetchCategories();
els.category.innerHTML = '<option value="">すべて</option>' +
  (cats ?? []).map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
await load();
