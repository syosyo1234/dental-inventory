-- =====================================================================
-- 02_rls.sql  访问权限控制（权限 + Row Level Security）
--
-- 原则：
--   1. 未登录(anon) 对所有表没有任何权限
--   2. 已登录且有效的员工才可以 SELECT
--   3. 所有表都不允许从前端直接写入，
--      只能通过 03_functions.sql 中的数据库函数（RPC）变更
--   4. 产品 Master 的编辑、在庫調整、取消只允许 admin（在函数内判断）
--
-- 两层防护：
--   GRANT/REVOKE（能不能碰这张表、这一列）
--   RLS 策略   （能碰哪些行、需要什么条件）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 权限判断辅助函数
-- security definer：内部读取 staff_profiles 时不受 RLS 影响，避免策略递归
-- ---------------------------------------------------------------------
create or replace function public.current_staff_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.staff_profiles
  where id = auth.uid() and is_active;
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_staff_role() is not null;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_staff_role() = 'admin', false);
$$;

-- ---------------------------------------------------------------------
-- 表级权限：先全部收回，再按需授予
-- （Supabase 默认会把 public 下的表授权给 anon / authenticated）
-- ---------------------------------------------------------------------
revoke all on public.staff_profiles     from anon, authenticated;
revoke all on public.categories         from anon, authenticated;
revoke all on public.products           from anon, authenticated;
revoke all on public.stocks             from anon, authenticated;
revoke all on public.stock_transactions from anon, authenticated;

-- 前端（已登录）对所有表只有 SELECT 权限。
-- 所有写操作（Master 登记/修改、检收、使用、调整、取消）都通过 03_functions.sql 的函数进行，
-- 这样校验逻辑集中在数据库一处，前端被篡改也无法绕过。
grant select on public.staff_profiles     to authenticated;
grant select on public.categories         to authenticated;
grant select on public.products           to authenticated;
grant select on public.stocks             to authenticated;
grant select on public.stock_transactions to authenticated;

-- ---------------------------------------------------------------------
-- 开启 RLS
-- ---------------------------------------------------------------------
alter table public.staff_profiles     enable row level security;
alter table public.categories         enable row level security;
alter table public.products           enable row level security;
alter table public.stocks             enable row level security;
alter table public.stock_transactions enable row level security;

-- ---------------------------------------------------------------------
-- 策略
-- ---------------------------------------------------------------------
-- 员工：有效员工可以查看（履历中显示登记者姓名）
create policy staff_select on public.staff_profiles
  for select to authenticated using (public.is_staff());

-- 以下全部只有 SELECT 策略。
-- 没有 insert/update/delete 策略 → 即使权限被误开，RLS 也会拒绝直接写入（双重防护）
create policy categories_select on public.categories
  for select to authenticated using (public.is_staff());

create policy products_select on public.products
  for select to authenticated using (public.is_staff());

create policy stocks_select on public.stocks
  for select to authenticated using (public.is_staff());
create policy transactions_select on public.stock_transactions
  for select to authenticated using (public.is_staff());
