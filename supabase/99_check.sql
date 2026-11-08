-- =====================================================================
-- 99_check.sql  数据一致性检查（随时可以执行，只读）
-- =====================================================================

-- ① 現在庫数 = 履歴の増減合計 になっているか（不一致の行が0件なら正常）
select p.model_no, p.name, s.current_qty, coalesce(sum(t.delta), 0) as ledger_total
from public.products p
join public.stocks s on s.product_id = p.id
left join public.stock_transactions t on t.product_id = p.id
group by p.model_no, p.name, s.current_qty
having s.current_qty <> coalesce(sum(t.delta), 0);

-- ② 履歴の連続性：各記録の「変更前在庫」が直前記録の「変更後在庫」と一致するか（0件なら正常）
select *
from (
  select t.id, p.model_no, t.stock_before,
         lag(t.stock_after) over (partition by t.product_id order by t.id) as prev_after
  from public.stock_transactions t
  join public.products p on p.id = t.product_id
) x
where prev_after is not null and stock_before <> prev_after;

-- ③ 在庫状況のサマリー
select status, count(*) from public.get_inventory_status(7) group by status order by status;
