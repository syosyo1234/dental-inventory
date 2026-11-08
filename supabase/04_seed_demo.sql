-- =====================================================================
-- 04_seed_demo.sql  演示用模拟数据（不含任何真实患者信息，厂商名均为虚构）
--
-- ⚠ 注意：执行时会【删除】所有资材、库存、履历数据后重新生成。
--         员工账号（staff_profiles）会保留。
--         面试前重新执行一次，可以让"最近7天/30天"的数据保持新鲜。
--
-- 前提：已经至少有一个 admin 员工（见 docs/setup.md 步骤）
--
-- 生成方式：模拟过去60天的诊所运营
--   ・每天（周日休诊）按平均使用量随机出库
--   ・库存降到発注点以下时自动"发注"，リードタイム天数后检收入库
--   ・部分资材在途中停止发注 → 形成「注意」「緊急」状态，便于演示
--   ・另外加入：登记错误后取消、棚卸调整、データ不足、手動設定 等场景
-- =====================================================================

do $$
declare
  v_today   date := public.jst_today();
  v_start   date := public.jst_today() - 59;
  v_staff   uuid[];
  v_d       date;
  v_day     integer;
  r         record;
  v_use     integer;
  v_qty     numeric;
  v_res     jsonb;
  v_txn_id  bigint;
begin
  select array_agg(id order by created_at) into v_staff
  from public.staff_profiles where is_active;

  if not exists (select 1 from public.staff_profiles where role = 'admin' and is_active) then
    raise exception '先に管理者ユーザーを作成してください（docs/setup.md 手順を参照）。';
  end if;

  perform setseed(0.42);   -- 毎回同じ傾向のデータになるよう乱数を固定

  -- 既存データ削除（TRUNCATE は行トリガーを起動しないため、追記専用制約の影響を受けない）
  truncate public.stock_transactions, public.stocks, public.products, public.categories
    restart identity cascade;

  -- ------------------------------------------------------------------
  -- カテゴリー
  -- ------------------------------------------------------------------
  insert into public.categories (name, sort_order) values
    ('感染対策', 1), ('切削・研磨', 2), ('印象材', 3),
    ('修復材', 4), ('麻酔・薬剤', 5), ('衛生用品', 6);

  -- ------------------------------------------------------------------
  -- シミュレーション用パラメータ
  --   avg      : 実際の1日平均使用量（シミュレーション用、マスタには保存しない）
  --   init     : 60日前の初期在庫
  --   order_q  : 1回の発注数量
  --   stop_day : この日以降は発注しない（null = 最後まで通常運用）
  -- ------------------------------------------------------------------
  create temp table seed_items (
    model_no text, maker text, name text, spec text, category text, unit text,
    reorder numeric, lead integer, safety integer, manual numeric, notes text,
    avg numeric, init integer, order_q integer, stop_day integer,
    product_id bigint, pending_day integer, pending_order_day integer
  ) on commit drop;

  insert into seed_items (model_no, maker, name, spec, category, unit, reorder, lead, safety, manual, notes, avg, init, order_q, stop_day) values
    -- 感染対策
    ('DC-001','A社','歯科用グローブ（ニトリル）','Mサイズ・100枚入り','感染対策','箱',12,5,3,null,'',1.5,25,20,null),
    ('DC-002','A社','歯科用グローブ（ニトリル）','Sサイズ・100枚入り','感染対策','箱',8,5,3,null,'',1.0,16,15,36),
    ('DC-003','A社','サージカルマスク','フリーサイズ・50枚入り','感染対策','箱',6,5,3,null,'',0.8,12,10,40),
    ('DC-004','B社','ペーパーエプロン','2枚重ね・125枚入り','感染対策','箱',4,7,3,null,'',0.4,8,8,null),
    ('DC-005','B社','滅菌パック','平型 90×230mm・200枚入り','感染対策','箱',3,7,3,null,'',0.3,6,6,null),
    ('DC-006','B社','環境除菌ワイプ','ボトルタイプ・100枚入り','感染対策','個',4,5,3,null,'',0.5,8,8,48),
    -- 切削・研磨
    ('BR-101','C社','ダイヤモンドバー（ラウンド）','FG #1・5本入り','切削・研磨','箱',3,10,3,null,'',0.3,6,6,46),
    ('BR-102','C社','ダイヤモンドバー（テーパー）','FG #2・5本入り','切削・研磨','箱',3,10,3,null,'',0.25,6,6,null),
    ('BR-103','C社','カーバイドバー','CA #6・6本入り','切削・研磨','箱',2,10,3,null,'',0.15,4,4,null),
    ('BR-104','C社','研磨用ディスク','中粗・50枚入り','切削・研磨','箱',2,7,3,null,'',0.15,4,4,null),
    ('BR-105','C社','ポリッシングペースト','ファイン・40g','切削・研磨','個',2,7,3,null,'',0.12,4,3,null),
    -- 印象材
    ('IM-201','D社','アルジネート印象材','普通硬化型・500g','印象材','袋',5,7,3,null,'',0.6,10,10,44),
    ('IM-202','D社','シリコーン印象材（レギュラー）','カートリッジ50mL×2本','印象材','箱',3,7,3,null,'',0.35,7,5,49),
    ('IM-203','D社','シリコーン印象材（インジェクション）','カートリッジ50mL×2本','印象材','箱',2,7,3,null,'',0.2,5,4,null),
    ('IM-204','D社','印象用トレー','上顎 Mサイズ・50個入り','印象材','箱',2,7,3,null,'',0.1,3,2,null),
    -- 修復材
    ('RS-301','E社','コンポジットレジン','A2・シリンジ4g','修復材','本',4,7,3,null,'',0.5,9,8,51),
    ('RS-302','E社','コンポジットレジン','A3・シリンジ4g','修復材','本',3,7,3,null,'',0.3,7,6,40),
    ('RS-303','E社','ボンディング材','1液型・5mL','修復材','本',2,7,3,null,'',0.12,4,3,null),
    ('RS-304','E社','グラスアイオノマーセメント','粉液セット','修復材','個',2,10,3,null,'',0.1,3,2,null),
    ('RS-305','E社','仮封材','30g','修復材','個',2,7,3,null,'',0.15,4,3,null),
    -- 麻酔・薬剤
    ('AN-401','F社','歯科用局所麻酔剤','カートリッジ1.8mL・50本入り','麻酔・薬剤','箱',3,3,2,null,'要冷所保管',0.45,6,6,28),
    ('AN-402','F社','表面麻酔ゲル','30g','麻酔・薬剤','個',2,5,3,null,'',0.12,3,3,null),
    ('AN-403','F社','根管洗浄剤','500mL','麻酔・薬剤','本',2,5,3,null,'',0.2,4,4,null),
    ('AN-404','F社','フッ化物歯面塗布剤','ゲルタイプ・60g','麻酔・薬剤','個',2,5,3,null,'',0.15,4,3,null),
    -- 衛生用品
    ('HY-501','A社','紙コップ','5オンス・1000個入り','衛生用品','ケース',1,5,3,null,'',0.08,2,2,null),
    ('HY-502','A社','歯ブラシ（患者配布用）','ふつう・50本入り','衛生用品','箱',2,7,3,null,'',0.2,4,4,null),
    ('HY-503','B社','デンタルフロス','ワックス付き・50m','衛生用品','個',3,7,3,null,'',0.3,6,6,null),
    ('HY-504','B社','綿球','#3・1000個入り','衛生用品','袋',3,5,3,null,'',0.4,7,6,53),
    ('HY-505','B社','ロールワッテ','#2・300個入り','衛生用品','袋',4,5,3,null,'',0.5,8,8,null),
    -- 特殊ケース
    ('NW-601','E社','光重合型シーラント','シリンジ1.2mL×2本','修復材','箱',1,7,3,null,'新規採用品（使用実績なし）',0,4,0,null),
    ('MN-602','F社','歯周ポケット洗浄チップ','ディスポーザブル・100本入り','衛生用品','箱',2,7,3,0.3,'使用量は手動設定',0,6,0,null);

  -- ------------------------------------------------------------------
  -- マスタ登録（stocks 行はトリガーで自動作成）
  -- ------------------------------------------------------------------
  for r in select * from seed_items loop
    insert into public.products (model_no, maker, name, spec, category_id, unit,
      reorder_point, lead_time_days, safety_days, manual_daily_usage, notes, updated_by, created_at)
    select r.model_no, r.maker, r.name, r.spec, c.id, r.unit,
      r.reorder, r.lead, r.safety, r.manual, r.notes, v_staff[1],
      ((v_start - 1) + time '18:00') at time zone 'Asia/Tokyo'
    from public.categories c where c.name = r.category;

    update seed_items set product_id = (select id from public.products where model_no = r.model_no)
    where model_no = r.model_no;
  end loop;

  -- 初期在庫（調整記録として登録）
  for r in select * from seed_items loop
    perform public._apply_stock_change(r.product_id, 'ADJUST', r.init, v_start, '初期在庫登録',
      gen_random_uuid(), v_staff[1], null, (v_start + time '08:30') at time zone 'Asia/Tokyo');
  end loop;

  -- ------------------------------------------------------------------
  -- 60日分の日次シミュレーション
  -- ------------------------------------------------------------------
  for v_day in 0..59 loop
    v_d := v_start + v_day;

    for r in select * from seed_items where avg > 0 order by model_no loop
      -- (1) 入荷（日曜休診のため、到着予定日が日曜なら翌日に検収）
      if r.pending_day is not null and v_day >= r.pending_day and extract(dow from v_d) <> 0 then
        -- 1回の発注量：指定値 と 約30日分 の大きい方
        perform public._apply_stock_change(r.product_id, 'IN', greatest(r.order_q, ceil(r.avg * 30)), v_d, '',
          gen_random_uuid(), v_staff[1 + (v_day % array_length(v_staff, 1))], null,
          (v_d + time '10:00' + (random() * interval '90 minutes')) at time zone 'Asia/Tokyo');
        update seed_items set pending_day = null, pending_order_day = null where model_no = r.model_no;
        r.pending_day := null;
      end if;

      -- (2) 使用（日曜は休診）。期待値が avg になるよう確率的に丸める
      if extract(dow from v_d) <> 0 then
        v_use := floor(r.avg * (7.0 / 6.0) * (0.5 + random()) + random());
        select current_qty into v_qty from public.stocks where product_id = r.product_id;
        v_use := least(v_use, v_qty::integer);
        if v_use > 0 then
          perform public._apply_stock_change(r.product_id, 'OUT', -v_use, v_d, '',
            gen_random_uuid(), v_staff[1 + ((v_day + 1) % array_length(v_staff, 1))], null,
            (v_d + time '17:30' + (random() * interval '60 minutes')) at time zone 'Asia/Tokyo');
        end if;
      end if;

      -- (3) 発注判定：（発注点 または「リードタイム＋安全日数＋4日分」）以下 かつ 未発注 かつ 発注停止日前
      --     ※ 小口の資材は日々の使用量の揺れが大きいため、少し早めに発注する運用を想定
      select current_qty into v_qty from public.stocks where product_id = r.product_id;
      if v_qty <= greatest(r.reorder, ceil(r.avg * (r.lead + r.safety + 4))) and r.pending_day is null
         and (r.stop_day is null or v_day < r.stop_day) then
        update seed_items set pending_day = v_day + r.lead, pending_order_day = v_day
        where model_no = r.model_no;
      end if;
    end loop;

    -- ---- デモ用の特殊な記録 ----
    -- 3日前：グローブの使用数を誤入力 → 取消
    if v_d = v_today - 3 then
      v_res := public._apply_stock_change(
        (select product_id from seed_items where model_no = 'DC-001'), 'OUT', -5, v_d,
        '', gen_random_uuid(), v_staff[1], null, (v_d + time '12:05') at time zone 'Asia/Tokyo');
      v_txn_id := (v_res ->> 'transaction_id')::bigint;
      perform public._apply_stock_change(
        (select product_id from seed_items where model_no = 'DC-001'), 'CANCEL', 5, v_d,
        '取消（No.' || v_txn_id || '）：数量の入力ミス（正しくは0箱）', gen_random_uuid(), v_staff[1],
        v_txn_id, (v_d + time '12:20') at time zone 'Asia/Tokyo');
    end if;

    -- 5日前：型番を間違えて検収 → 取消
    if v_d = v_today - 5 then
      v_res := public._apply_stock_change(
        (select product_id from seed_items where model_no = 'HY-505'), 'IN', 8, v_d,
        '', gen_random_uuid(), v_staff[1], null, (v_d + time '11:40') at time zone 'Asia/Tokyo');
      v_txn_id := (v_res ->> 'transaction_id')::bigint;
      perform public._apply_stock_change(
        (select product_id from seed_items where model_no = 'HY-505'), 'CANCEL', -8, v_d,
        '取消（No.' || v_txn_id || '）：型番誤り（HY-504と取り違え）', gen_random_uuid(), v_staff[1],
        v_txn_id, (v_d + time '11:55') at time zone 'Asia/Tokyo');
    end if;

    -- 10日前：棚卸で差異（研磨ディスク1箱破損）
    if v_d = v_today - 10 then
      select current_qty into v_qty from public.stocks
      where product_id = (select product_id from seed_items where model_no = 'BR-104');
      if v_qty >= 1 then
        perform public._apply_stock_change(
          (select product_id from seed_items where model_no = 'BR-104'), 'ADJUST', -1, v_d,
          '棚卸調整：外箱破損のため1箱廃棄', gen_random_uuid(), v_staff[1], null,
          (v_d + time '18:40') at time zone 'Asia/Tokyo');
      end if;
    end if;
  end loop;

  -- 発注中（未入荷）のものは「発注済み」フラグを立てる
  update public.products p
  set ordered_at = v_start + s.pending_order_day
  from seed_items s
  where s.product_id = p.id and s.pending_day is not null;

  raise notice 'デモデータを作成しました：資材 % 件、履歴 % 件',
    (select count(*) from public.products), (select count(*) from public.stock_transactions);
end;
$$;
