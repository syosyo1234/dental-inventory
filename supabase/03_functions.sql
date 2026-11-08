-- =====================================================================
-- 03_functions.sql  数据库函数（前端通过 supabase.rpc() 调用）
--
-- 所有库存变更都经过 _apply_stock_change()，它保证：
--   ① 行锁（SELECT ... FOR UPDATE）：同一产品的并发操作按顺序执行，不会丢失更新
--   ② 事务：流水记录与库存更新同时成功或同时失败
--   ③ 二重送信防止：同一个 request_id 只会登记一次
--   ④ 负库存拒绝：变更后库存 < 0 时报错
--
-- 函数命名：
--   _xxx  … 内部函数（不授予前端执行权限）
--   xxx   … 公开 RPC（授予 authenticated）
-- 错误信息直接用日语抛出，前端原样显示
-- =====================================================================


-- ---------------------------------------------------------------------
-- 共通ヘルパー
-- ---------------------------------------------------------------------

-- 日本時間の「今日」
create or replace function public.jst_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Tokyo')::date;
$$;

-- 数値の表示用（15.00 → 15）
create or replace function public._fmt(p numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim_scale(p)::text;
$$;

-- 有効なスタッフかチェックし、ユーザーIDを返す
create or replace function public._require_staff()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'ログインしていないか、利用権限がありません。' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- 管理者かチェックし、ユーザーIDを返す
create or replace function public._require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者のみ実行できます。' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- 数量チェック（MVP：1以上の整数）
create or replace function public._validate_qty(p_qty numeric, p_label text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_qty is null then
    raise exception '%を入力してください。', p_label;
  end if;
  if p_qty <= 0 then
    raise exception '%は1以上の数値を入力してください。', p_label;
  end if;
  if p_qty <> trunc(p_qty) then
    raise exception '%は整数で入力してください。', p_label;
  end if;
  if p_qty > 99999 then
    raise exception '%が大きすぎます。入力内容を確認してください。', p_label;
  end if;
end;
$$;

-- 業務日チェック：未来日不可、過去30日以内
create or replace function public._validate_txn_date(p_date date, p_label text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_date is null then
    raise exception '%を入力してください。', p_label;
  end if;
  if p_date > public.jst_today() then
    raise exception '%に未来の日付は指定できません。', p_label;
  end if;
  if p_date < public.jst_today() - 30 then
    raise exception '%は過去30日以内の日付を指定してください。', p_label;
  end if;
end;
$$;

-- 処理結果を JSON で返す
create or replace function public._txn_result(t public.stock_transactions, p_duplicate boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'transaction_id', t.id,
    'product_id',     t.product_id,
    'model_no',       p.model_no,
    'name',           p.name,
    'unit',           p.unit,
    'txn_type',       t.txn_type,
    'quantity',       t.quantity,
    'stock_before',   t.stock_before,
    'stock_after',    t.stock_after,
    'txn_date',       t.txn_date,
    'duplicate',      p_duplicate      -- true = 二重送信のため既存の結果を返した
  )
  from public.products p
  where p.id = t.product_id;
$$;


-- ---------------------------------------------------------------------
-- 在庫変更の中核処理（内部専用）
-- ---------------------------------------------------------------------
create or replace function public._apply_stock_change(
  p_product_id  bigint,
  p_type        text,
  p_delta       numeric,
  p_txn_date    date,
  p_note        text,
  p_request_id  uuid,
  p_user        uuid,
  p_reverses_id bigint      default null,
  p_created_at  timestamptz default now()
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_before numeric;
  v_after  numeric;
  v_unit   text;
  v_txn    public.stock_transactions;
begin
  if p_request_id is null then
    raise exception '送信IDがありません。画面を再読み込みしてから再度登録してください。';
  end if;

  -- ① 行ロック：同じ資材への同時更新はここで順番待ちになる
  select s.current_qty, p.unit into v_before, v_unit
  from public.stocks s
  join public.products p on p.id = s.product_id
  where s.product_id = p_product_id
  for update of s;

  if not found then
    raise exception '指定された資材が見つかりません。';
  end if;

  -- ③ 二重送信チェック
  --   ロック取得「後」に確認するため、同時に届いた2回目のリクエストも
  --   1回目のコミットを待ってから確実に検出できる
  select * into v_txn from public.stock_transactions where request_id = p_request_id;
  if found then
    return public._txn_result(v_txn, true);
  end if;

  -- ④ マイナス在庫の拒否
  v_after := v_before + p_delta;
  if v_after < 0 then
    if p_type = 'CANCEL' then
      raise exception '取消すると在庫がマイナスになるため取消できません（現在庫：%）。',
        public._fmt(v_before) || v_unit;
    else
      raise exception '在庫が不足しています（現在庫：%、使用数量：%）。',
        public._fmt(v_before) || v_unit, public._fmt(abs(p_delta)) || v_unit;
    end if;
  end if;

  -- ② 履歴の追加と在庫の更新（同一トランザクション）
  insert into public.stock_transactions (
    product_id, txn_type, quantity, delta, stock_before, stock_after,
    txn_date, note, reverses_id, request_id, created_by, created_at
  ) values (
    p_product_id, p_type, abs(p_delta), p_delta, v_before, v_after,
    p_txn_date, coalesce(btrim(p_note), ''), p_reverses_id, p_request_id, p_user, p_created_at
  )
  returning * into v_txn;

  update public.stocks
  set current_qty = v_after, updated_at = now()
  where product_id = p_product_id;

  return public._txn_result(v_txn, false);
end;
$$;


-- =====================================================================
-- 公開 RPC
-- =====================================================================

-- ---------------------------------------------------------------------
-- 検収登録：型番で資材を特定し、在庫を増やす
-- ---------------------------------------------------------------------
create or replace function public.register_receipt(
  p_model_no     text,
  p_quantity     numeric,
  p_receipt_date date,
  p_note         text,
  p_request_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := public._require_staff();
  v_product public.products;
  v_result  jsonb;
begin
  if nullif(btrim(coalesce(p_model_no, '')), '') is null then
    raise exception '型番を入力してください。';
  end if;
  perform public._validate_qty(p_quantity, '検収数量');
  perform public._validate_txn_date(p_receipt_date, '検収日');

  select * into v_product
  from public.products
  where model_no = public.normalize_model_no(p_model_no);

  if not found then
    raise exception '型番「%」は登録されていません。医療資材マスタを確認してください。',
      public.normalize_model_no(p_model_no);
  end if;
  if not v_product.is_active then
    raise exception '型番「%」は使用停止中の資材です。', v_product.model_no;
  end if;

  v_result := public._apply_stock_change(
    v_product.id, 'IN', p_quantity, p_receipt_date, p_note, p_request_id, v_user);

  -- 入荷したので「発注済み」フラグを解除
  if not (v_result ->> 'duplicate')::boolean then
    update public.products set ordered_at = null
    where id = v_product.id and ordered_at is not null;
  end if;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- 使用登録：在庫を減らす（在庫不足ならエラー）
-- ---------------------------------------------------------------------
create or replace function public.register_usage(
  p_product_id bigint,
  p_quantity   numeric,
  p_usage_date date,
  p_note       text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := public._require_staff();
  v_active boolean;
begin
  if p_product_id is null then
    raise exception '資材を選択してください。';
  end if;
  perform public._validate_qty(p_quantity, '使用数量');
  perform public._validate_txn_date(p_usage_date, '使用日');

  select is_active into v_active from public.products where id = p_product_id;
  if not found then
    raise exception '指定された資材が見つかりません。';
  end if;
  if not v_active then
    raise exception 'この資材は使用停止中です。';
  end if;

  return public._apply_stock_change(
    p_product_id, 'OUT', -p_quantity, p_usage_date, p_note, p_request_id, v_user);
end;
$$;

-- ---------------------------------------------------------------------
-- 在庫調整（棚卸）：実在庫数を入力し、差分を調整記録として残す【管理者】
-- ---------------------------------------------------------------------
create or replace function public.adjust_stock(
  p_product_id bigint,
  p_actual_qty numeric,
  p_reason     text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := public._require_admin();
  v_current numeric;
begin
  if p_actual_qty is null then
    raise exception '実在庫数を入力してください。';
  end if;
  if p_actual_qty < 0 or p_actual_qty <> trunc(p_actual_qty) then
    raise exception '実在庫数は0以上の整数で入力してください。';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception '調整理由を入力してください。';
  end if;

  -- 差分は「ロック後の最新在庫」から計算する（ロック前に計算すると同時更新でずれる）
  select current_qty into v_current
  from public.stocks where product_id = p_product_id
  for update;
  if not found then
    raise exception '指定された資材が見つかりません。';
  end if;

  return public._apply_stock_change(
    p_product_id, 'ADJUST', p_actual_qty - v_current, public.jst_today(),
    '棚卸調整：' || btrim(p_reason), p_request_id, v_user);
end;
$$;

-- ---------------------------------------------------------------------
-- 取消：元の記録は変更せず、逆方向の記録を追加する【管理者】
-- ---------------------------------------------------------------------
create or replace function public.cancel_transaction(
  p_txn_id     bigint,
  p_reason     text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public._require_admin();
  v_orig public.stock_transactions;
  v_dup  public.stock_transactions;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception '取消理由を入力してください。';
  end if;

  select * into v_orig from public.stock_transactions where id = p_txn_id;
  if not found then
    raise exception '指定された履歴が見つかりません。';
  end if;
  if v_orig.txn_type = 'CANCEL' then
    raise exception '取消記録をさらに取消すことはできません。';
  end if;

  -- 同じ資材をロックしてから判定
  perform 1 from public.stocks where product_id = v_orig.product_id for update;

  -- 二重送信なら既存結果を返す（「取消済み」エラーより先に判定）
  select * into v_dup from public.stock_transactions where request_id = p_request_id;
  if found then
    return public._txn_result(v_dup, true);
  end if;

  if exists (select 1 from public.stock_transactions where reverses_id = p_txn_id) then
    raise exception 'この記録は既に取消されています。';
  end if;

  return public._apply_stock_change(
    v_orig.product_id, 'CANCEL', -v_orig.delta, public.jst_today(),
    '取消（No.' || v_orig.id || '）：' || btrim(p_reason),
    p_request_id, v_user, v_orig.id);
end;
$$;

-- ---------------------------------------------------------------------
-- 資材マスタの登録・更新【管理者】
--   p_id が null → 新規登録（初期在庫があれば「調整」記録として登録）
--   p_id を指定  → 更新（在庫数はここでは変更しない）
-- ---------------------------------------------------------------------
create or replace function public.save_product(
  p_id                 bigint,
  p_model_no           text,
  p_maker              text,
  p_name               text,
  p_spec               text,
  p_category_id        integer,
  p_unit               text,
  p_reorder_point      numeric,
  p_lead_time_days     integer,
  p_safety_days        integer,
  p_manual_daily_usage numeric,
  p_notes              text,
  p_is_active          boolean default true,
  p_initial_qty        numeric default 0
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := public._require_admin();
  v_model_no text := public.normalize_model_no(p_model_no);
  v_id       bigint;
begin
  -- 入力チェック
  if v_model_no = '' then
    raise exception '型番を入力してください。';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception '製品名を入力してください。';
  end if;
  if p_category_id is null or not exists (select 1 from public.categories where id = p_category_id) then
    raise exception 'カテゴリーを選択してください。';
  end if;
  if nullif(btrim(coalesce(p_unit, '')), '') is null then
    raise exception '単位を入力してください。';
  end if;
  if p_reorder_point is null or p_reorder_point < 0 then
    raise exception '発注点は0以上の数値を入力してください。';
  end if;
  if p_lead_time_days is null or p_lead_time_days not between 0 and 365 then
    raise exception '発注リードタイムは0〜365日の範囲で入力してください。';
  end if;
  if p_safety_days is null or p_safety_days not between 0 and 365 then
    raise exception '安全在庫日数は0〜365日の範囲で入力してください。';
  end if;
  if p_manual_daily_usage is not null and p_manual_daily_usage <= 0 then
    raise exception '手動設定の平均使用量は0より大きい数値を入力してください（未設定の場合は空欄）。';
  end if;

  if p_id is null then
    -- 新規登録
    if coalesce(p_initial_qty, 0) < 0 or coalesce(p_initial_qty, 0) <> trunc(coalesce(p_initial_qty, 0)) then
      raise exception '初期在庫数は0以上の整数で入力してください。';
    end if;

    begin
      insert into public.products (
        model_no, maker, name, spec, category_id, unit, reorder_point,
        lead_time_days, safety_days, manual_daily_usage, notes, is_active, updated_by
      ) values (
        v_model_no, btrim(coalesce(p_maker, '')), btrim(p_name), btrim(coalesce(p_spec, '')),
        p_category_id, btrim(p_unit), p_reorder_point, p_lead_time_days, p_safety_days,
        p_manual_daily_usage, coalesce(p_notes, ''), coalesce(p_is_active, true), v_user
      )
      returning id into v_id;   -- stocks 行はトリガーで自動作成（在庫0）
    exception when unique_violation then
      raise exception '型番「%」は既に登録されています。', v_model_no;
    end;

    if coalesce(p_initial_qty, 0) > 0 then
      perform public._apply_stock_change(
        v_id, 'ADJUST', p_initial_qty, public.jst_today(), '初期在庫登録',
        gen_random_uuid(), v_user);
    end if;
  else
    -- 更新
    begin
      update public.products set
        model_no           = v_model_no,
        maker              = btrim(coalesce(p_maker, '')),
        name               = btrim(p_name),
        spec               = btrim(coalesce(p_spec, '')),
        category_id        = p_category_id,
        unit               = btrim(p_unit),
        reorder_point      = p_reorder_point,
        lead_time_days     = p_lead_time_days,
        safety_days        = p_safety_days,
        manual_daily_usage = p_manual_daily_usage,
        notes              = coalesce(p_notes, ''),
        is_active          = coalesce(p_is_active, true)
      where id = p_id
      returning id into v_id;
    exception when unique_violation then
      raise exception '型番「%」は既に登録されています。', v_model_no;
    end;

    if v_id is null then
      raise exception '指定された資材が見つかりません。';
    end if;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 発注済みフラグの設定・解除（スタッフ可）
-- ---------------------------------------------------------------------
create or replace function public.set_ordered(p_product_id bigint, p_ordered boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._require_staff();
  update public.products
  set ordered_at = case when p_ordered then public.jst_today() else null end
  where id = p_product_id;
  if not found then
    raise exception '指定された資材が見つかりません。';
  end if;
end;
$$;


-- =====================================================================
-- 在庫状況の計算（在庫一覧・発注アラート・ダッシュボード共通）
--
--   期間内出庫合計 = 過去 N 日（今日を含む）の「出庫」合計（取消済みは除外）
--   1日平均使用量 = 実績あり → 期間内出庫合計 ÷ N
--                  実績なし → 手動設定値
--                  どちらもなし → null（「データ不足」）
--   在庫残存日数  = floor(現在庫数 ÷ 1日平均使用量)  ※切り捨て＝安全側
--                  平均使用量が null / 0 のときは計算しない（ゼロ除算回避）
--
--   状態判定（D=残存日数, L=リードタイム, S=安全在庫日数, Q=現在庫, R=発注点）
--     urgent  : Q = 0、または D ≤ L          … 今発注しても到着前に欠品の恐れ
--     warning : D ≤ L + S、または Q ≤ R       … 発注推奨
--     normal  : 上記以外
--
-- security invoker：呼び出したユーザーの RLS がそのまま適用される
-- =====================================================================
create or replace function public.get_inventory_status(p_period_days integer default 7)
returns table (
  product_id         bigint,
  model_no           text,
  maker              text,
  name               text,
  spec               text,
  category_id        integer,
  category_name      text,
  unit               text,
  current_qty        numeric,
  reorder_point      numeric,
  lead_time_days     integer,
  safety_days        integer,
  manual_daily_usage numeric,
  ordered_at         date,
  period_days        integer,
  period_usage       numeric,
  daily_usage        numeric,
  usage_source       text,     -- actual=実績 / manual=手動設定 / none=データ不足
  remaining_days     integer,
  status             text      -- normal / warning / urgent
)
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select public.jst_today() as today,
           greatest(1, least(coalesce(p_period_days, 7), 365)) as days
  ),
  usage as (
    select t.product_id, sum(t.quantity) as qty
    from public.stock_transactions t
    cross join params pr
    where t.txn_type = 'OUT'
      and t.txn_date >  pr.today - pr.days
      and t.txn_date <= pr.today
      and not exists (select 1 from public.stock_transactions c where c.reverses_id = t.id)
    group by t.product_id
  ),
  base as (
    select
      p.id, p.model_no, p.maker, p.name, p.spec, p.category_id, c.name as category_name,
      p.unit, s.current_qty, p.reorder_point, p.lead_time_days, p.safety_days,
      p.manual_daily_usage, p.ordered_at, pr.days,
      coalesce(u.qty, 0) as period_usage,
      case when u.qty > 0 then u.qty / pr.days else p.manual_daily_usage end as daily_raw,
      case when u.qty > 0 then 'actual'
           when p.manual_daily_usage is not null then 'manual'
           else 'none' end as usage_source
    from public.products p
    join public.categories c on c.id = p.category_id
    join public.stocks s     on s.product_id = p.id
    left join usage u        on u.product_id = p.id
    cross join params pr
    where p.is_active
  ),
  calc as (
    select b.*,
           case when b.daily_raw > 0 then floor(b.current_qty / b.daily_raw)::integer end as rdays
    from base b
  )
  select
    id, model_no, maker, name, spec, category_id, category_name, unit,
    current_qty, reorder_point, lead_time_days, safety_days, manual_daily_usage, ordered_at,
    days, period_usage, round(daily_raw, 2), usage_source, rdays,
    case
      when current_qty <= 0                                          then 'urgent'
      when rdays is not null and rdays <= lead_time_days               then 'urgent'
      when rdays is not null and rdays <= lead_time_days + safety_days then 'warning'
      when current_qty <= reorder_point                                then 'warning'
      else 'normal'
    end
  from calc
  order by model_no;
$$;


-- =====================================================================
-- 実行権限
--   いったん全関数の実行権限を外し、公開 RPC と RLS で使う関数だけ authenticated に付与
--   （Supabase は既定で anon にも関数の実行権限を付与するため）
-- =====================================================================
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.normalize_model_no(text),
  public.current_staff_role(),
  public.is_staff(),
  public.is_admin(),
  public.jst_today(),
  public.register_receipt(text, numeric, date, text, uuid),
  public.register_usage(bigint, numeric, date, text, uuid),
  public.adjust_stock(bigint, numeric, text, uuid),
  public.cancel_transaction(bigint, text, uuid),
  public.save_product(bigint, text, text, text, text, integer, text, numeric, integer, integer, numeric, text, boolean, numeric),
  public.set_ordered(bigint, boolean),
  public.get_inventory_status(integer)
to authenticated;
