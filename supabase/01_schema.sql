-- =====================================================================
-- 01_schema.sql  表结构定义
-- 在 Supabase 控制台 → SQL Editor 中按 01 → 02 → 03 → 04 的顺序执行
--
-- 设计思想：三层分离
--   マスタ（products）    ：基本不变的产品信息
--   在庫  （stocks）      ：当前库存数，只能通过数据库函数变更
--   履歴  （stock_transactions）：只追加、不修改、不删除的库存流水
-- =====================================================================

-- ---------------------------------------------------------------------
-- 员工信息（与 Supabase Auth 的 auth.users 一对一）
-- ---------------------------------------------------------------------
create table public.staff_profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role         text not null default 'staff' check (role in ('admin', 'staff')),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
comment on table public.staff_profiles is 'スタッフ情報（admin: 全操作 / staff: 検収・使用・閲覧）';

-- ---------------------------------------------------------------------
-- 类别
-- ---------------------------------------------------------------------
create table public.categories (
  id         integer generated always as identity primary key,
  name       text not null unique check (btrim(name) <> ''),
  sort_order integer not null default 0
);
comment on table public.categories is '資材カテゴリー';

-- ---------------------------------------------------------------------
-- 医療資材マスタ
-- 数量类列使用 numeric(12,2)：MVP 阶段在函数里限制为整数，
-- 以后需要允许小数（如 0.5本）时不必修改表结构
-- ---------------------------------------------------------------------
create table public.products (
  id                 bigint generated always as identity primary key,
  model_no           text not null unique check (model_no <> ''),
  maker              text not null default '',
  name               text not null check (btrim(name) <> ''),
  spec               text not null default '',
  category_id        integer not null references public.categories(id),
  unit               text not null check (btrim(unit) <> ''),
  reorder_point      numeric(12,2) not null default 0 check (reorder_point >= 0),
  lead_time_days     integer not null default 7 check (lead_time_days between 0 and 365),
  safety_days        integer not null default 3 check (safety_days between 0 and 365),
  manual_daily_usage numeric(12,2) check (manual_daily_usage is null or manual_daily_usage > 0),
  ordered_at         date,                -- 発注済みフラグ（null = 未発注）
  notes              text not null default '',
  is_active          boolean not null default true,   -- 論理削除用
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.staff_profiles(id)
);
comment on table  public.products is '医療資材マスタ';
comment on column public.products.model_no           is '型番（正規化して保存：全角→半角、空白除去、大文字）';
comment on column public.products.reorder_point      is '発注点（この数量以下で「発注推奨」）';
comment on column public.products.lead_time_days     is '発注リードタイム（発注から到着までの日数）';
comment on column public.products.safety_days        is '安全在庫日数（リードタイムに上乗せする余裕日数）';
comment on column public.products.manual_daily_usage is '手動設定の1日あたり平均使用量（実績がない場合に使用）';

create index idx_products_category on public.products(category_id);

-- ---------------------------------------------------------------------
-- 在庫（products と一対一）
-- check (current_qty >= 0) は「マイナス在庫」を防ぐ最後の防衛線
-- ---------------------------------------------------------------------
create table public.stocks (
  product_id  bigint primary key references public.products(id) on delete restrict,
  current_qty numeric(12,2) not null default 0 check (current_qty >= 0),
  updated_at  timestamptz not null default now()
);
comment on table public.stocks is '現在庫数（データベース関数経由でのみ更新）';

-- ---------------------------------------------------------------------
-- 入出庫履歴（追記専用の台帳）
--   txn_type : IN=入庫(検収) / OUT=出庫(使用) / ADJUST=調整(棚卸・初期在庫) / CANCEL=取消
--   delta    : 在庫の増減（符号付き）
--   取消は元の記録を変更せず、逆方向の CANCEL 記録を追加する（reverses_id で元記録を参照）
-- ---------------------------------------------------------------------
create table public.stock_transactions (
  id           bigint generated always as identity primary key,
  product_id   bigint not null references public.products(id),
  txn_type     text not null check (txn_type in ('IN', 'OUT', 'ADJUST', 'CANCEL')),
  quantity     numeric(12,2) not null check (quantity >= 0),
  delta        numeric(12,2) not null,
  stock_before numeric(12,2) not null check (stock_before >= 0),
  stock_after  numeric(12,2) not null check (stock_after >= 0),
  txn_date     date not null,                          -- 業務日（検収日・使用日）
  note         text not null default '',
  reverses_id  bigint unique references public.stock_transactions(id),  -- unique：同じ記録は1回しか取消できない
  request_id   uuid not null unique,                   -- 二重送信防止キー
  created_by   uuid not null references public.staff_profiles(id),
  created_at   timestamptz not null default now(),     -- 登録日時

  -- 変更後在庫 = 変更前在庫 + 増減
  constraint chk_balance check (stock_after = stock_before + delta),
  -- CANCEL のときだけ元記録を参照する
  constraint chk_cancel_ref check ((txn_type = 'CANCEL') = (reverses_id is not null)),
  -- 区分ごとの符号ルール
  constraint chk_sign check (
       (txn_type = 'IN'  and delta > 0 and quantity = delta)
    or (txn_type = 'OUT' and delta < 0 and quantity = -delta)
    or (txn_type in ('ADJUST', 'CANCEL') and quantity = abs(delta))
  )
);
comment on table public.stock_transactions is '入出庫履歴（追記専用・更新削除不可）';

create index idx_txn_product_date on public.stock_transactions(product_id, txn_date);
create index idx_txn_type_date    on public.stock_transactions(txn_type, txn_date);
create index idx_txn_created_at   on public.stock_transactions(created_at desc);


-- =====================================================================
-- 触发器
-- =====================================================================

-- 型番の正規化：「ＤＣ－００１」「dc-001 」→「DC-001」
--   normalize(..., NFKC) で全角英数字・記号を半角に変換
create or replace function public.normalize_model_no(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(normalize(coalesce(p, ''), NFKC), '\s', '', 'g'));
$$;

create or replace function public.trg_products_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.model_no   := public.normalize_model_no(new.model_no);
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

create trigger products_before_write
before insert or update on public.products
for each row execute function public.trg_products_before_write();

-- 产品登记时自动建立库存行（数量0）
create or replace function public.trg_products_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.stocks (product_id, current_qty) values (new.id, 0);
  return new;
end;
$$;

create trigger products_after_insert
after insert on public.products
for each row execute function public.trg_products_after_insert();

-- 履历禁止 UPDATE / DELETE（即使是数据库函数也不能修改，保证可追溯）
create or replace function public.trg_forbid_txn_modify()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '入出庫履歴は変更・削除できません。取消機能を使用してください。';
end;
$$;

create trigger stock_transactions_forbid_modify
before update or delete on public.stock_transactions
for each row execute function public.trg_forbid_txn_modify();

-- Supabase Auth で新しいユーザーが作成されたら、自動で staff_profiles を作成（権限は staff）
create or replace function public.trg_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.staff_profiles (id, display_name, role)
  values (new.id, split_part(coalesce(new.email, 'staff'), '@', 1), 'staff')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.trg_handle_new_user();
