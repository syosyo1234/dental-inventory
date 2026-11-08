# 连接 Supabase 与实际操作测试指南（Phase 1〜2）

## 0. 文件结构（Phase 2 完成时）

```
在庫管理システム/
├── index.html              ダッシュボード（KPI・発注が必要な商品・最近の検収記録）
├── login.html              ログイン
├── products.html           医療資材マスタ（一覧・検索・新規・編集・在庫調整）
├── receipt.html            検収登録
├── usage.html              使用登録
├── history.html            入出庫履歴（検索・取消）
├── inventory.html          在庫一覧（平均使用量・残存日数・7/30日切替）
├── alerts.html             発注アラート（判定理由・発注済み管理）
├── css/style.css           全页面共用样式
├── js/
│   ├── config.js           ★ 填写 Supabase 的 URL 和 Publishable key
│   ├── supabaseClient.js   Supabase 客户端
│   ├── auth.js             登录状态检查
│   ├── layout.js           侧边菜单・顶部栏
│   ├── ui.js               通用函数（转义、格式化、全角→半角、错误信息、Toast）
│   ├── data.js             多个页面共用的数据读取
│   ├── stock.js            在库状况的读取与显示（在庫一覧・発注アラート・ダッシュボード共用）
│   └── pages/              各页面的 JS
├── supabase/
│   ├── 01_schema.sql       表结构・触发器
│   ├── 02_rls.sql          权限・RLS
│   ├── 03_functions.sql    库存变更函数・库存状态计算
│   ├── 04_seed_demo.sql    演示数据（⚠ 会清空现有资材数据）
│   └── 99_check.sql        一致性检查
└── docs/setup.md           本文件
```

### 各页面调用的数据库处理

| 页面 | 读取（SELECT，受 RLS 保护） | 写入（只通过数据库函数） |
|---|---|---|
| 医療資材マスタ | products + categories + stocks | `save_product`（新規・編集）、`adjust_stock`（在庫調整） |
| 検収登録 | products（按型番检索）、stocks（登记后再确认） | `register_receipt` |
| 使用登録 | products、stocks | `register_usage` |
| 入出庫履歴 | stock_transactions + products + staff_profiles | `cancel_transaction` |
| ダッシュボード | `get_inventory_status`（计算函数）、stock_transactions | — |
| 在庫一覧 | `get_inventory_status`（7日 / 30日） | — |
| 発注アラート | `get_inventory_status` | `set_ordered`（発注済み・解除） |

---

# 第一部分：连接 Supabase（约20分钟）

每完成一步，确认「✅ 确认点」后再进入下一步。

## 步骤1　创建 Supabase 项目

1. 登录 https://supabase.com/dashboard → **New project**
2. Name：例如 `dental-inventory`
3. Database Password：自动生成即可，**保存到密码管理器**（前端不会用到）
4. Region：**Northeast Asia (Tokyo)**
5. 点击 Create，等待约1〜2分钟

✅ 确认点：左侧菜单可以打开 **SQL Editor**

## 步骤2　执行 SQL（01 → 02 → 03）

**SQL Editor → New query**，按顺序把文件内容全部复制粘贴，点 **Run**：

1. `supabase/01_schema.sql`
2. `supabase/02_rls.sql`
3. `supabase/03_functions.sql`

✅ 确认点：每次都显示 `Success. No rows returned`。
**Table Editor** 里能看到 categories / products / staff_profiles / stock_transactions / stocks 五张表，每张表都显示 RLS 已启用。

> 如果中途报错：把错误信息原样发给我。不要修改 SQL 后重试，避免一半执行成功的状态。

## 步骤3　关闭公开注册

**Authentication → Sign In / Providers**

- Email：保持开启
- **Allow new users to sign up：关闭**

✅ 确认点：保存后开关为 OFF

## 步骤4　创建员工账号

**Authentication → Users → Add user → Create new user**，创建两个账号，都勾选 **Auto Confirm User**：

| 用途 | 示例邮箱 | 权限 |
|---|---|---|
| 管理者（你自己） | 你的邮箱 | admin |
| 演示用员工 | demo@example.com 等 | staff（面试时给面试官用） |

然后在 SQL Editor 执行（替换成实际邮箱）：

```sql
update public.staff_profiles
set role = 'admin', display_name = '管理者'
where id = (select id from auth.users where email = 'admin@example.com');

update public.staff_profiles
set display_name = 'デモスタッフ'
where id = (select id from auth.users where email = 'demo@example.com');

select p.display_name, p.role, u.email
from public.staff_profiles p join auth.users u on u.id = p.id;
```

✅ 确认点：最后的查询显示2行，一个 `admin`、一个 `staff`

## 步骤5　导入演示数据

执行 `supabase/04_seed_demo.sql`，然后执行 `supabase/99_check.sql`。

✅ 确认点：
- 显示 `デモデータを作成しました：資材 31 件、履歴 ○○○ 件`
- 99_check.sql 的前两个查询都是 **0 行**

## 步骤6　设置前端连接

**Project Settings → API Keys** 复制 Project URL 和 **Publishable key**（`sb_publishable_...`；旧界面为 `anon` `public` key），写入 `js/config.js`：

```js
export const SUPABASE_URL = 'https://xxxx.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_xxxx';
```

> ⚠ `service_role` / `sb_secret_...` 绝对不要写进前端。

## 步骤7　本地启动

```bash
cd ~/Desktop/在庫管理システム
```

```bash
python3 -m http.server 8000
```

浏览器打开 http://localhost:8000/login.html

✅ 确认点：用管理者账号登录后，ダッシュボード显示「登録資材数 31件」

---

# 第二部分：实际操作测试（Phase 2）

按顺序操作，每一步都会影响下一步的数据，用来确认**页面之间的数据联动**。
「期待结果」中的库存数以演示数据为例，实际数字以你的画面为准。

### 测试A　検収登録（最重要）

| # | 操作 | 期待结果 |
|---|---|---|
| A1 | 打开「検収登録」，记下 DC-001 当前库存（例：27箱） | — |
| A2 | 型番输入 **ｄｃ－００１**（全角小写） | 自动变为 DC-001，显示 メーカー名・製品名・規格・カテゴリー・現在庫；步骤条前进到③ |
| A3 | 検収数量输入 **５**（全角） | 显示「登録後の在庫（予定）27 → 32 箱（+5）」 |
| A4 | **快速双击**「検収登録」 | 只登记1次。右侧显示 27→32 和处理日志（マスタ検索 → register_receipt → stocks 再取得 ✓） |
| A5 | 型番输入 ZZ-999 按 Enter | 「型番「ZZ-999」は医療資材マスタに登録されていません。」，无法输入数量 |
| A6 | 检收日选择明天 | 日期选择器无法选择未来日期 |

### 测试B　使用登録

| # | 操作 | 期待结果 |
|---|---|---|
| B1 | 打开「使用登録」，型番输入 DC-001 按 Enter | 現在庫显示 **32箱**（反映了测试A） |
| B2 | 使用数量输入 50 | 显示「在庫数（32箱）を超えています」，无法登记 |
| B3 | 使用数量改为 2，登记 | 32 → 30。下方「使用履歴」最上面出现这条记录 |

### 测试C　入出庫履歴・取消

| # | 操作 | 期待结果 |
|---|---|---|
| C1 | 打开「入出庫履歴」，资材选择 DC-001 | 最新两条是 B3 的出庫（−2）和 A4 的入庫（+5） |
| C2 | 对 B3 的出庫记录点「取消」，不填理由直接提交 | 「取消理由を入力してください。」 |
| C3 | 填写理由后提交 | 新增「取消 +2」记录，原记录变灰并显示「取消済み」，库存 30 → 32 |
| C4 | 区分选择「取消」 | 只显示取消记录，并显示「No.○○ を取消」 |

### 测试D　医療資材マスタ

| # | 操作 | 期待结果 |
|---|---|---|
| D1 | 搜索「グローブ」 | 显示 DC-001・DC-002，DC-001 的现在库为 **32**（反映 A〜C） |
| D2 | 「新規登録」，型番输入 dc-001 并填写必填项后保存 | 「型番「DC-001」は既に登録されています。」 |
| D3 | 型番改为 TG-701，初期在庫 10，保存 | 一览中出现 TG-701，现在库 10 |
| D4 | TG-701「編集」→ 修改製品名 → 保存 | 名称更新，库存仍为 10（编辑画面不显示初期在庫） |
| D5 | TG-701「在庫調整」→ 实际库存 8，理由「棚卸」 | 预览「差異 −2　10 → 8」，登记后库存 8 |
| D6 | 「検収登録」输入 TG-701，数量 4 | 能找到新资材，8 → 12 |
| D7 | 「入出庫履歴」选择 TG-701 | 3条：調整 +10（初期在庫登録）→ 調整 −2（棚卸調整）→ 入庫 +4 |
| D8 | TG-701「編集」→ 取消勾选「使用中」→ 保存，再到検収登録输入 TG-701 | 「使用停止中の資材です」，无法登记 |

### 测试E　权限（用演示员工账号登录）

| # | 操作 | 期待结果 |
|---|---|---|
| E1 | 右上角显示 | 「デモスタッフ（スタッフ）」 |
| E2 | 医療資材マスタ | 没有「新規登録」「編集」「在庫調整」按钮，只有「履歴」 |
| E3 | 入出庫履歴 | 没有「操作」列和「取消」按钮 |
| E4 | 使用登録 DC-001 数量 1 | 可以登记，履历中登记者为デモスタッフ |
| E5 | 在浏览器 Console 执行下方代码 | 两个都返回「この操作は管理者のみ実行できます。」 |

```js
const { supabase } = await import('./js/supabaseClient.js');
(await supabase.rpc('cancel_transaction', { p_txn_id: 1, p_reason: 'test', p_request_id: crypto.randomUUID() })).error?.message;
```

```js
const { supabase } = await import('./js/supabaseClient.js');
(await supabase.from('stocks').update({ current_qty: 999 }).eq('product_id', 1)).error?.message;
```

（第二段代码的期待结果是 `permission denied for table stocks`）

### 测试F　数据一致性

所有测试结束后，在 SQL Editor 执行 `supabase/99_check.sql` → 前两个查询都是 **0 行**。

测试完如果想恢复干净的演示数据，重新执行 `04_seed_demo.sql` 即可（员工账号会保留）。

---

# 第三部分：Phase 3 测试（ダッシュボード・在庫一覧・発注アラート）

Phase 3 只新增了前端画面，使用的是已经测试过的数据库函数 `get_inventory_status`（计算）和 `set_ordered`（发注済み标记），没有修改任何 SQL。
数字会因为之前的测试操作而和下面的例子略有不同，**重点确认的是各画面之间的数字一致**。

### 测试⑧　ダッシュボード

| # | 操作 | 期待结果 |
|---|---|---|
| 8-1 | 打开ダッシュボード | 4 个卡片：登録資材数・在庫不足（緊急）・発注推奨（注意）・発注済み（入荷待ち） |
| 8-2 | 查看「発注が必要な商品」 | 緊急在上、注意在下；在库为0的资材排在最前面 |
| 8-3 | 查看「最近の検収記録」 | 最新的检收在最上面；**已取消的检收不显示** |
| 8-4 | 点击「在庫不足（緊急）」卡片 | 跳转到在庫一覧，并自动筛选为「緊急」 |

### 测试⑨　在庫一覧

| # | 操作 | 期待结果 |
|---|---|---|
| 9-1 | 打开在庫一覧 | 上方的「緊急 / 注意 / 正常」件数和ダッシュボード的卡片一致 |
| 9-2 | 挑一个资材手动验算：直近7日の使用量 ÷ 7 = 平均使用量；現在庫 ÷ 平均使用量（舍去小数）= 残存日数 | 和画面显示一致 |
| 9-3 | 点击「直近30日」 | 件数和数值重新计算；「データ不足」的件数明显减少（低使用量的资材在30天内有记录） |
| 9-4 | 点击「データ不足」标签 | 只显示平均使用量为「データ不足」的资材；MN-602 显示「0.3 箱/日 **手動設定**」，不属于データ不足 |
| 9-5 | 关键词输入全角「ｄｃ」 | 只显示 DC- 开头的资材 |
| 9-6 | 展开最下方「計算方法について」 | 显示计算公式和判定表 |

### 测试⑩　発注アラート → 検収 联动

| # | 操作 | 期待结果 |
|---|---|---|
| 10-1 | 打开発注アラート | 「緊急」「注意」分两块显示；每行有「判定理由」，例如「残り6日分 ≤ リードタイム10日」 |
| 10-2 | 选一个「未発注」的緊急资材（例：BR-101），点「発注済みにする」 | 发注状况变为「発注済（今天日期）」；标题中「うち未発注」减少 1 |
| 10-3 | 勾选「発注済みの資材を表示しない」 | 该资材从列表中消失 |
| 10-4 | ダッシュボード的「発注済み（入荷待ち）」 | 增加 1 |
| 10-5 | 到検収登録，对该资材检收足够的数量（例：BR-101 检收 6） | 检收成功 |
| 10-6 | 回到発注アラート | 该资材**自动解除发注済み**；如果库存已充足，就从提醒列表中消失 |
| 10-7 | 在庫一覧中查看该资材 | 状态变为「正常」（或残存日数增加），发注状况为「-」 |

### 测试⑪　staff 账号

| # | 操作 | 期待结果 |
|---|---|---|
| 11-1 | 用 demo 账号登录，打开発注アラート | 可以看到列表，「発注済みにする」按钮**可以使用**（发注标记是员工的日常工作，所以 staff 也可以操作） |

---

# 附录：开发时已验证的内容

### 数据库（Phase 1，本地 PostgreSQL 16）

| 测试 | 结果 |
|---|---|
| 未登录：查询表 / 调用函数 | 全部 permission denied |
| 员工直接 UPDATE/INSERT 库存・履历・Master | 全部 permission denied |
| 同一 request_id 重复发送 | duplicate=true，库存不变 |
| 数量 0 / 负数 / 小数 / 空、未来日期、31天前 | 分别显示对应日语错误 |
| 出库超过库存、取消导致负库存 | 被拒绝 |
| staff 执行取消・Master 登记・在庫調整 | 「この操作は管理者のみ実行できます。」 |
| 停用的员工 | 看不到任何数据，也无法登记 |
| 履历 UPDATE / DELETE（即使是数据库管理员） | 被触发器拒绝 |
| 30 个连接同时对库存 10 的资材各出库 1 | 恰好 10 件成功，最终库存 0 |
| 5 个连接同时用同一 request_id 检收 | 只登记 1 件 |

### 画面（Phase 2，浏览器 + 本地 Postgres + 测试用 API）

本地用一个模拟 Supabase 接口的测试服务器连接真实的 PostgreSQL，
以 `authenticated` 角色执行，所以 RLS 和数据库函数都是真实运行的。上面测试 A〜F 的内容都已经操作确认：

- 全角型番自动规范化、自动检索、步骤条、预览、双击只登记1次、处理日志
- 検収 → 使用 → 履历 → 取消 → マスタ 各页面的库存数一致（27 → 32 → 30 → 32 → 31）
- 新规登记（初期在库）→ 编辑 → 棚卸调整 → 检收 → 履历 3 条全部正确
- 停用资材在检收画面被拒绝；staff 看不到管理按钮，直接调用 RPC 也被拒绝
- 手机宽度（375px）无横向滚动
- 全部操作后 99_check.sql 一致性 0 件不一致
