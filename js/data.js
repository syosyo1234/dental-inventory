// =====================================================================
// data.js  多个页面共用的数据读取
//
// 读取（SELECT）直接查询表，受 RLS 保护；
// 写入一律调用数据库函数（supabase.rpc），见各页面 JS。
// =====================================================================
import { supabase } from './supabaseClient.js';
import { one } from './ui.js';

/**
 * 读取资材一览（含类别名、现库存）
 * 诊所的资材数量一般是几十〜几百件，所以一次全部读取，在浏览器里筛选，代码更简单
 */
export async function fetchProducts({ activeOnly = false } = {}) {
  let query = supabase
    .from('products')
    .select(`id, model_no, maker, name, spec, category_id, unit, reorder_point,
             lead_time_days, safety_days, manual_daily_usage, notes, is_active, updated_at,
             categories(name), stocks(current_qty)`)
    .order('model_no');
  if (activeOnly) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) return { data: null, error };

  // 把嵌入的类别名和库存数展开成普通字段，方便使用
  const rows = data.map((p) => ({
    ...p,
    category_name: one(p.categories)?.name ?? '',
    current_qty: Number(one(p.stocks)?.current_qty ?? 0),
  }));
  return { data: rows, error: null };
}

/** 读取类别一览 */
export async function fetchCategories() {
  return supabase.from('categories').select('id, name').order('sort_order');
}

/** 读取单个资材的最新库存（登记后用来确认数据库中的实际值） */
export async function fetchCurrentQty(productId) {
  const { data, error } = await supabase
    .from('stocks').select('current_qty').eq('product_id', productId).single();
  return { qty: data ? Number(data.current_qty) : null, error };
}

/**
 * 在给定的履历ID中，找出已经被取消的ID
 * 取消记录(CANCEL)的 reverses_id 指向原记录
 */
export async function fetchCancelledIds(ids) {
  if (!ids.length) return { set: new Set(), error: null };
  const { data, error } = await supabase
    .from('stock_transactions').select('reverses_id').in('reverses_id', ids);
  return { set: new Set((data ?? []).map((r) => r.reverses_id)), error };
}

/** 履历查询时共用的 select 列 */
export const TXN_SELECT = `id, product_id, txn_type, quantity, delta, stock_before, stock_after,
  txn_date, note, reverses_id, created_at,
  products(model_no, name, spec, unit), staff_profiles(display_name)`;
