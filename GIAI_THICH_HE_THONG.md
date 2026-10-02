# GIẢI THÍCH HỆ THỐNG QUẢN LÝ VÀ THEO DÕI SUẤT ĂN

> Tài liệu mô tả nhiệm vụ, thao tác nghiệp vụ, API và kỹ thuật các script SQL.
> Nội dung dựa trên code thực tế trong repo. Cập nhật: 2026-08-07.

---

## Mục lục

1. [Hệ thống này làm nhiệm vụ gì](#1-hệ-thống-này-làm-nhiệm-vụ-gì)
2. [Kiến trúc 3 lớp và luồng chạy](#2-kiến-trúc-3-lớp-và-luồng-chạy)
3. [Các thao tác nghiệp vụ (10 tab)](#3-các-thao-tác-nghiệp-vụ-10-tab)
4. [API — toàn bộ 22 endpoint](#4-api--toàn-bộ-22-endpoint)
5. [Kỹ thuật các script SQL](#5-kỹ-thuật-các-script-sql)
6. [Sáu quy tắc nghiệp vụ và nơi cài đặt](#6-sáu-quy-tắc-nghiệp-vụ-và-nơi-cài-đặt)
7. [Quy ước lập trình cần giữ](#7-quy-ước-lập-trình-cần-giữ)

---

# 1. Hệ thống này làm nhiệm vụ gì

**Bài toán:** Nhà máy có 3 máy quẹt thẻ BioStar đặt ở 3 nhà ăn. Mỗi lần nhân viên quẹt thẻ để lấy suất ăn, BioStar ghi 1 dòng vào `BioStar.dbo.TB_EVENT_LOG`. Dữ liệu thô đó không dùng trực tiếp để tính tiền được vì: lẫn sự kiện nhiễu của thiết bị, chưa biết ca ăn nào, chưa biết bộ phận lớn nào, và ca đêm vắt qua nửa đêm nên ngày lịch ≠ ngày công.

**Nhiệm vụ của hệ thống:** biến log quẹt thẻ thô thành **số suất ăn có thể quyết toán với nhà thầu căng-tin**, gồm 4 việc:

| Việc | Nội dung |
|---|---|
| Chuẩn hoá | Lọc sự kiện hợp lệ, gán ca ăn, gán ngày công, gán bộ phận lớn |
| Thống kê | Đếm suất theo ngày / ca / bộ phận / máy (Hàn vs Việt) |
| Bổ sung thủ công | Nhập suất ăn không quẹt được thẻ, sữa hằng ngày, suất sinh nhật |
| Quyết toán | Nhân đơn giá → chi phí tháng, cộng chi phí nhân công cố định, xuất CSV |

Ngoài ra có **hàng đợi rà soát**: người quẹt > 3 lần / ngày công (badge đỏ trên navbar) — không phải lỗi, mà là danh sách cần kiểm tra.

**Ranh giới dữ liệu (rất quan trọng):**

- `BioStar` = nguồn, **chỉ đọc, tuyệt đối không ghi**.
- `QLSA` = database của hệ thống này, chứa các bảng `SA_*` và toàn bộ procedure. Procedure đọc **cross-database** sang BioStar. Connection string trỏ vào `QLSA`.

---

# 2. Kiến trúc 3 lớp và luồng chạy

```
Trình duyệt (React 19 SPA)
   ↓ fetch('/api/...')            src/services/api.ts
Express (server/, ESM JavaScript thuần)
   ↓ request.execute('SA_*')      server/db.js
SQL Server 2012 Express  →  QLSA (SA_*)  ⟶ đọc ⟶  BioStar (TB_*)
```

Nguyên tắc xuyên suốt: **server không viết một dòng SQL nào.** Mỗi endpoint trong `server/routes.js` chỉ làm 3 việc — validate tham số, bind kiểu, gọi **đúng một** procedure `SA_*`. Muốn đổi truy vấn thì sửa `db/03_procedures.sql` rồi deploy lại, không sửa JavaScript.

## Luồng khởi động ứng dụng

1. `App.tsx` mount → `loadConfig()` bắn **4 request song song** (`src/App.tsx:78-83`): `/api/bootstrap`, `/api/milk`, `/api/birthday`, `/api/manual-entries`.
2. `/api/bootstrap` gọi `SA_Bootstrap_GetConfig` — một procedure trả về **7 result set** trong 1 lượt round-trip. Route destructure theo đúng thứ tự đó (`server/routes.js:123-132`).
3. `useEffect` thứ hai theo dõi `[startDate, endDate]` → gọi `/api/meal-logs?from=&to=` → `SA_MealLog_GetByRange`. Có cờ `cancelled` để bỏ kết quả request cũ khi người dùng đổi ngày liên tục (`src/App.tsx:111-139`).

## Nơi giữ state

`App.tsx` là **chủ sở hữu duy nhất của toàn bộ state**. Không có Context, không Redux, không reducer. Các View chỉ nhận props: dữ liệu thô + `onSave` / `onDelete`. View **không bao giờ gọi API trực tiếp**; lỗi được bung lên `alert`.

Sau mỗi lần ghi, App gọi lại API để làm mới (`saveMilkEntry` → `fetchMilkEntries`). Riêng ánh xạ bộ phận thì tiết kiệm hơn: procedure `SA_DepartmentMapping_Save` tự `EXEC SA_DepartmentMapping_Get` ở cuối, nên **một lượt POST trả về luôn danh sách đầy đủ sau khi lưu** — client `setMappings(await api.saveMapping(...))` là xong.

## Định tuyến không router

Không dùng react-router. `TabType` ở `src/components/Navbar.tsx:19-29` là union 10 tab id; `App.tsx` render bằng chuỗi `activeTab === '...' && <View/>`. Thêm màn hình = thêm 1 thành viên `TabType` + 1 mục `navItems` + 1 nhánh trong `App.tsx`.

## Tổng hợp số liệu ở client — cố ý

`SA_MealLog_GetByRange` trả **punch thô** (~50.000 dòng / 1,2 MB gzip cho 1 tháng), trình duyệt tự tổng hợp. Mỗi `*View.tsx` tự `useMemo` lọc `l.actualDate >= startDate && l.actualDate <= endDate` rồi tự tính tổng của riêng nó. Lặp lại phép tổng hợp giữa các view là quy ước sẵn có, không phải thiếu sót. Middleware `compression()` ở `server/index.js:28` là thứ khiến cách này khả thi — **không được gỡ**.

---

# 3. Các thao tác nghiệp vụ (10 tab)

| Tab | `TabType` | Thao tác | Đọc/Ghi |
|---|---|---|---|
| Dashboard | `dashboard` | Tổng quan số suất, biểu đồ ca/máy | Chỉ đọc |
| Lịch Sử Chấm Ăn | `history` | Xem chi tiết từng lượt quẹt, xuất CSV | Chỉ đọc |
| Thống Kê Ca / Bộ Phận | `dept-report` | Pivot ca × bộ phận lớn | Chỉ đọc |
| Ánh Xạ Bộ Phận | `dept-mapping` | **Sửa ánh xạ bộ phận nhỏ → lớn ngay trên UI** | Đọc + Ghi |
| Hàn Quốc vs Việt Nam | `korean-viet` | Tách suất máy Hàn (TA-102) vs máy Việt | Chỉ đọc |
| Chấm Ăn >3 Lần | `abnormal` | Hàng đợi rà soát bất thường | Chỉ đọc (tính ở client) |
| Cấu Hình Sinh Nhật | `birthday` | Khai báo ngày sinh nhật tập thể + đơn giá suất đặc biệt | Đọc + Ghi |
| Nhập Thủ Công Ca | `manual-entry` | Bù suất khi máy hỏng / mất mạng / ăn đột xuất | Đọc + Ghi |
| Quản Lý Sữa | `milk` | Nhập sữa hằng ngày (loại, SL, đơn giá, NCC) | Đọc + Ghi |
| Báo Cáo Chi Phí | `financial` | Quyết toán: suất × đơn giá + sữa + sinh nhật + nhân công | Chỉ đọc (tổng hợp) |

Thanh ngày tháng ở Navbar là **bộ lọc toàn cục**, có 2 nút tắt "Tháng này" / "Tháng trước" (`Navbar.tsx:124-143`). Mặc định khi mở app: từ ngày 1 tháng hiện tại → hôm nay.

---

# 4. API — toàn bộ 22 endpoint

Base path `/api`. Dev: Vite (3000) proxy sang Express (4000). Production: Express phục vụ cả `dist/` lẫn `/api` trên 4000.

## Hệ thống

| Method | Path | Procedure | Ghi chú |
|---|---|---|---|
| GET | `/health` | *(query trực tiếp)* | Endpoint duy nhất không gọi proc — `SELECT DB_NAME(), SYSDATETIME()` |
| GET | `/bootstrap` | `SA_Bootstrap_GetConfig` | 7 result set → 1 JSON |

## Dữ liệu chấm ăn

| Method | Path | Procedure | Tham số |
|---|---|---|---|
| GET | `/meal-logs?from=&to=` | `SA_MealLog_GetByRange` | 2 ngày bắt buộc; kiểm `to >= from` ở `routes.js:161` |

## Bộ phận & ánh xạ

| Method | Path | Procedure |
|---|---|---|
| GET | `/departments/large` | `SA_LargeDepartment_Get` |
| GET | `/departments/small` | `SA_SmallDepartment_Get` |
| GET | `/mappings` | `SA_DepartmentMapping_Get` |
| GET | `/mapping-rules` | `SA_DepartmentMappingRule_Get` |
| POST | `/mappings` | `SA_DepartmentMapping_Save` → trả về full list |
| DELETE | `/mappings/:smallDepartment` | `SA_DepartmentMapping_Delete` → trả về full list |

## Ba domain CRUD (cùng một khuôn mẫu GET / POST-upsert / DELETE)

| Domain | Endpoints | Procedures |
|---|---|---|
| Sữa | `GET/POST /milk`, `DELETE /milk/:id` | `SA_MilkEntry_Get / _Save / _Delete` |
| Sinh nhật | `GET/POST /birthday`, `DELETE /birthday/:id` | `SA_BirthdayConfig_Get / _Save / _Delete` |
| Nhập thủ công | `GET/POST /manual-entries`, `DELETE /manual-entries/:id` | `SA_ManualEntry_Get / _Save / _Delete` |

POST là **upsert**: gửi kèm `id` → UPDATE, không có `id` → INSERT. Procedure trả về bản ghi vừa lưu, route lấy `rows[0] || null`.

## Danh mục & tham số

| Method | Path | Procedure |
|---|---|---|
| GET | `/shifts` | `SA_Shift_Get` |
| GET | `/readers` | `SA_Reader_Get` |
| GET | `/prices` | `SA_MealPrice_Get` |
| GET | `/monthly-costs` | `SA_MonthlyCost_Get` |
| GET | `/settings` | `SA_SystemSetting_Get` |
| PUT | `/settings/:key` | `SA_SystemSetting_Save` → trả về full list |

## Kỹ thuật lớp API

**Validator bắt buộc.** Bốn hàm `parseDate` / `parseInteger` / `parseNumber` / `parseText` ở đầu `routes.js:14-84`. Mọi tham số phải đi qua chúng — không có ngoại lệ. Thông điệp lỗi là tiếng Việt, ném `HttpError(400, ...)`.

**Ngày đi qua dây dưới dạng chuỗi.** `parseDate` chỉ chấp nhận regex `^\d{4}-\d{2}-\d{2}$`, và bind bằng `sql.VarChar(10)` **chứ không phải JS `Date`**. Lý do ghi rõ trong comment: SQL Server parse chuỗi ISO thành `date` không mơ hồ, còn bind `Date` sẽ tái tạo lệch múi giờ.

**Bọc async.** `wrap(fn)` (`routes.js:94`) đẩy mọi Promise rejection về error middleware thay vì treo request.

**Xử lý lỗi tập trung** (`server/index.js:45-53`): `HttpError` giữ status của nó, còn lại là 500. Nếu lỗi có `err.number` (tức là `RAISERROR` từ procedure) thì trả kèm `sqlErrorNumber`. Chuỗi lan truyền:

```
RAISERROR tiếng Việt trong proc → mssql → error handler → ApiError (api.ts) → alert trên UI
```

Người dùng đọc được đúng câu tiếng Việt do DBA viết.

**Connection pool dùng chung** (`server/db.js:38-53`): tạo một lần, tái sử dụng. Nếu connect lỗi thì `poolPromise = null` để lần gọi sau thử lại — tránh kẹt vĩnh viễn ở một promise đã reject. Server *fail fast* lúc khởi động: không kết nối được SQL thì `process.exit(1)`.

---

# 5. Kỹ thuật các script SQL

Ba file trong `db/` là **nguồn chân lý của schema**. Deploy tuần tự bằng:

```bash
sqlcmd -f 65001 -I -S 10.70.22.240 -d QLSA -i db\01_schema.sql
sqlcmd -f 65001 -I -S 10.70.22.240 -d QLSA -i db\02_seed.sql
sqlcmd -f 65001 -I -S 10.70.22.240 -d QLSA -i db\03_procedures.sql
```

- `-I` bật `QUOTED_IDENTIFIER` — **bắt buộc**, vì có cột computed PERSISTED (`TotalAmount`, `TotalSum`). Thiếu cờ này thì CREATE TABLE fail.
- `-f 65001` đọc file UTF-8 — thiếu thì tiếng Việt trong seed và trong `RAISERROR` bị mangle.

**Ràng buộc SQL Server 2012 Express:** không có `CREATE OR ALTER`, không có `DROP ... IF EXISTS`, không có `STRING_AGG`. Mọi kỹ thuật dưới đây là hệ quả của ràng buộc đó.

---

## 5.1 `01_schema.sql` — 12 bảng

**Kỹ thuật idempotent:** mỗi bảng bọc trong `IF OBJECT_ID('dbo.X','U') IS NULL BEGIN CREATE TABLE ... END`. Chạy lại lần 2 không lỗi, không mất dữ liệu. Đây là cách thay thế `DROP IF EXISTS` không có trên 2012.

### 12 bảng, chia 3 nhóm

**Nhóm cấu hình ánh xạ (1–3):**

- `SA_LargeDepartment` — 10 bộ phận lớn, PK là `LargeDeptCode` (nvarchar chứ không phải identity, để FK đọc được nghĩa).
- `SA_DepartmentMapping` — nhỏ → lớn, `UNIQUE(SmallDepartment)` đảm bảo 1 bộ phận nhỏ chỉ ánh xạ 1 nơi; FK về `SA_LargeDepartment`.
- `SA_DepartmentMappingRule` — ánh xạ có điều kiện theo tên nhân viên. Hai `CHECK constraint` khoá chặt miền giá trị: `MatchOperator IN ('CONTAINS','NOT_CONTAINS','EQUALS')` và `MatchField = 'sUserName'` (hiện chỉ hỗ trợ đúng một trường). `SmallDepartment NULL` = áp dụng cho mọi bộ phận.

**Nhóm cấu hình engine (4–7):**

- `SA_Shift` — 6 ca, dùng kiểu `time(0)`, cờ `WrapsMidnight` cho CA1.
- `SA_Reader` — 3 máy, PK `ReaderIdn` khớp `TB_READER.nReaderIdn`, cờ `IsKoreanMachine`.
- `SA_MealEventCode` — whitelist mã sự kiện hợp lệ.
- `SA_MealPrice` — đơn giá, `UNIQUE(Code)` để tra cứu bằng code chứ không bằng id.

**Nhóm nghiệp vụ (8–12):**

- `SA_MilkEntry` — có **computed column PERSISTED** `TotalAmount AS (CONVERT(decimal(18,2), Quantity) * UnitPrice)`. PERSISTED = tính sẵn, lưu trên đĩa, đọc không tốn CPU. `CHECK (Quantity > 0)` + index trên `EntryDate`.
- `SA_BirthdayConfig` — `UNIQUE(ConfigDate)`, một ngày chỉ một cấu hình.
- `SA_ManualEntry` — `CHECK (Quantity > 0)` + index `EntryDate`.
- `SA_SystemSetting` — key-value có cột `DataType` để client biết ép kiểu.
- `SA_MonthlyCost` — 7 cột chi phí + `TotalSum` PERSISTED cộng cả 7. `CostMonth char(7)` dạng `'YYYY-MM'`.

**Phòng thủ ở 2 tầng:** ràng buộc số lượng > 0 tồn tại **cả** ở `CHECK CONSTRAINT` trong bảng, **cả** ở `RAISERROR` trong procedure, **cả** ở `parseInteger(..., {min:1})` trong route. Ba lớp — lớp trong cùng là đảm bảo cuối, lớp ngoài cho thông điệp đẹp.

---

## 5.2 `02_seed.sql` — dữ liệu danh mục

**Kỹ thuật idempotent bằng `MERGE ... WHEN NOT MATCHED BY TARGET THEN INSERT`.** Cố ý **không có** nhánh `WHEN MATCHED THEN UPDATE` — nghĩa là: seed chỉ điền vào chỗ trống, **không bao giờ ghi đè dữ liệu người dùng đã chỉnh trên UI**. Chạy lại `02_seed.sql` sau khi vận hành 6 tháng là an toàn. Quy tắc rule ở mục 3 dùng `IF NOT EXISTS ... INSERT` cùng ý nghĩa.

Seed đầu file có `SET QUOTED_IDENTIFIER ON` với comment giải thích rằng sqlcmd mặc định để OFF — bảo hiểm phòng khi quên `-I`.

### Nội dung seed

| Mục | Nội dung |
|---|---|
| 1 | 10 bộ phận lớn: CSP, LFEM, SMT, SP, QC, WLP1, WLP2, R&D, KR, Khác (SortOrder 99) |
| 2 | ~41 ánh xạ bộ phận nhỏ → lớn, tên khớp **chính xác** `TB_USER_DEPT.sName` |
| 3 | 1 rule: `Khach cong tac` + tên chứa `Business` → `KR` |
| 4 | 6 ca ăn |
| 5 | 3 máy đọc thẻ (nReaderIdn thật) |
| 6 | 17 mã sự kiện: 39, 43–53, 55, 58, 59, 61, 62 |
| 7 | 7 đơn giá |
| 8 | 2 tham số hệ thống |
| 9 | 7 tháng số liệu chi phí (Jan-26 → Jul-26) |

**Bảng nghiệp vụ được để trống có chủ ý** (`SA_MilkEntry`, `SA_BirthdayConfig`, `SA_ManualEntry`) — dữ liệu thật do người dùng nhập qua giao diện.

Lưu ý nhỏ về seed mục 3: nhánh SP của quy tắc không cần rule riêng, vì `Khach cong tac → SP` đã là ánh xạ mặc định ở mục 2. Chỉ cần 1 rule cho nhánh KR là đủ diễn tả toàn bộ logic.

Số liệu `SA_MonthlyCost` trước đây hard-code trong `FinancialReportView.tsx`, nay đã chuyển hẳn vào DB — muốn cập nhật thì sửa trực tiếp trong bảng.

---

## 5.3 `03_procedures.sql` — 22 procedure

### Kỹ thuật deploy lại được

Không có `CREATE OR ALTER`, nên file mở đầu bằng một **batch header sinh SQL động để drop sạch**:

```sql
DECLARE @drop nvarchar(max) = N'';
SELECT @drop = @drop + N'DROP PROCEDURE dbo.' + QUOTENAME(name) + N';' + CHAR(10)
FROM sys.procedures WHERE name LIKE 'SA[_]%';
IF @drop <> N'' EXEC sp_executesql @drop;
```

Ba chi tiết đáng chú ý:

1. Gán tích luỹ `@drop = @drop + ...` là cách thay `STRING_AGG` không có trên 2012.
2. `SA[_]%` — dấu `_` được escape bằng `[ ]` vì trong LIKE nó là ký tự đại diện một ký tự bất kỳ.
3. `QUOTENAME` chống chèn tên.

Sau đó là loạt `CREATE PROCEDURE` thuần.

---

### `SA_MealLog_GetByRange` — trái tim của hệ thống

Đây là procedure duy nhất chạm dữ liệu thật và là nơi **toàn bộ quy tắc nghiệp vụ được thực thi**.

#### Bước 1 — Ngày công 08:00 → 08:00

```sql
DECLARE @SHIFT_BACK int = 6601;   -- 01:50:01
```

Trừ 6601 giây rồi lấy phần ngày: quẹt lúc `01:50:00` lùi về hôm trước, quẹt lúc `01:50:01` giữ nguyên ngày. Cắt biên **chính xác tại `<= 01:50:00`**. Cột `actualDate` sinh ra từ đây, và **mọi filter, group-by, report đều dùng `actualDate`, không dùng ngày lịch**. `logDateTime` chỉ để hiển thị và sắp xếp.

#### Bước 2 — Chuyển khoảng ngày sang khoảng epoch (tối ưu hiệu năng then chốt)

```sql
DECLARE @FromEpoch int = DATEDIFF(SECOND,'1970-01-01', CAST(@FromDate AS datetime2(0))) + @SHIFT_BACK;
DECLARE @ToEpoch   int = DATEDIFF(SECOND,'1970-01-01', CAST(DATEADD(DAY,1,@ToDate) AS datetime2(0))) + @SHIFT_BACK - 1;
...
WHERE e.nDateTime BETWEEN @FromEpoch AND @ToEpoch
```

`TB_EVENT_LOG.nDateTime` là **epoch giây theo giờ LOCAL** (không phải UTC) — `DATEADD(SECOND, nDateTime, '1970-01-01')` cho ra đúng giờ đồng hồ treo tường, không cần chỉnh múi giờ. Vì lọc trực tiếp trên `nDateTime`, query **seek được clustered PK `(nDateTime, ...)`** thay vì scan 3,3 triệu dòng. Nếu lọc trên biểu thức datetime đã convert thì mất index ngay — đây là lý do **không được filter trên datetime đã đổi kiểu**.

Biên `@ToEpoch` cộng thêm 1 ngày rồi trừ 1 giây, để bao trọn phần đuôi ca đêm rạng sáng thuộc về `@ToDate`.

#### Bước 3 — Bảng tạm `#Users` giải quyết 2 vấn đề cùng lúc

**Vấn đề kiểu dữ liệu:** `TB_EVENT_LOG.nUserID` là `int` nhưng `TB_USER.sUserID` là `varchar` — không join trực tiếp được. Giải bằng `TRY_CAST(u.sUserID AS int)`, loại bỏ những mã không phải số. Vì `TRY_CAST` có thể sinh trùng, dùng `ROW_NUMBER() OVER (PARTITION BY TRY_CAST(...) ORDER BY nUserIdn DESC)` rồi lấy `rn = 1` (bản ghi mới nhất thắng).

**Vấn đề bộ phận:** độ ưu tiên **rule > mapping > 'Khác'**, viết gọn thành:

```sql
COALESCE(r.LargeDeptCode, m.LargeDeptCode, N'Khác')
```

Trong đó `r` đến từ `OUTER APPLY ... TOP 1 ... ORDER BY rr.Priority, rr.RuleId` — chọn rule khớp có priority nhỏ nhất. Ba toán tử `CONTAINS` / `NOT_CONTAINS` / `EQUALS` được dịch thành `LIKE N'%'+MatchValue+N'%'` / `NOT LIKE` / `=`.

Mọi so sánh chuỗi cross-database đều có `COLLATE DATABASE_DEFAULT` — bắt buộc, vì `BioStar` và `QLSA` có thể khác collation, không có nó sẽ lỗi collation conflict. Collation CI cũng là lý do so khớp tên bộ phận không phân biệt hoa/thường.

Bảng tạm được materialize trước rồi mới join, thay vì viết một query khổng lồ — giúp optimizer không phải đánh giá lại logic rule cho từng dòng trong 50.000 punch.

#### Bước 4 — Query chính, 4 phép lọc chồng nhau

| Kỹ thuật | Tác dụng |
|---|---|
| `INNER JOIN SA_Reader ... AND IsActive = 1` | Chỉ 3 máy chấm ăn; loại mọi reader cửa/khác |
| `INNER JOIN SA_MealEventCode` | Whitelist 17 mã sự kiện; loại nhiễu thiết bị (mở cửa, tamper) |
| `INNER JOIN #Users` | Loại punch của mã nhân viên không phân giải được |
| `WHERE nDateTime BETWEEN ...` | Khoảng epoch, seek index |

`CROSS APPLY` tính `LogTime` một lần rồi tái sử dụng ở 4 cột output — tránh lặp biểu thức `DATEADD`.

#### Bước 5 — Phân ca bằng `OUTER APPLY`

```sql
OUTER APPLY (
    SELECT TOP (1) s.ShiftCode FROM dbo.SA_Shift s
    WHERE s.IsActive = 1
      AND ( (s.WrapsMidnight = 1 AND (t >= StartTime OR  t <= EndTime))
         OR (s.WrapsMidnight = 0 AND  t >= StartTime AND t <= EndTime) )
    ORDER BY s.SortOrder
) sh
```

Cờ `WrapsMidnight` **chuyển toán tử từ `AND` sang `OR`** — đó chính là cách CA1 (22:50 → 01:50) hoạt động. `OUTER APPLY` (không phải `CROSS`) để punch ngoài mọi khung giờ vẫn được giữ lại, gán `ISNULL(..., N'Khác')`.

#### Bước 6 — Định dạng đầu ra là hợp đồng với frontend

Procedure trả về chuỗi **đã format sẵn**, không trả kiểu date/time:

| Cột | Kiểu trả về | Format |
|---|---|---|
| `logDateTime` | `char(19)` | style 120 → `2026-08-07 12:34:56` |
| `logTimeOnly` | `char(8)` | style 108 → `12:34:56` |
| `actualDate` | `char(10)` | style 23 → `2026-08-07` |
| `id` | `varchar(20)` | ép từ `nEventLogIdn` |

Đây là nền tảng cho quy ước **so sánh ngày giờ bằng chuỗi xuyên suốt hệ thống**: `"YYYY-MM-DD"` và `"HH:mm:ss"` sắp xếp/so sánh lexicographic đúng thứ tự thời gian. Nhờ vậy `l.actualDate >= startDate && l.actualDate <= endDate` ở client là phép so sánh chuỗi thuần, không cần parse `Date`, không có rủi ro lệch múi giờ. **Đừng đưa object `Date` vào đường so sánh.**

Các proc khác cũng theo quy ước này: `CONVERT(char(10), EntryDate, 23)`, `CONVERT(char(19), CreatedAt, 120)`, và `CAST(decimal AS float)` cho mọi cột tiền (JSON không có kiểu decimal — nếu không ép, mssql trả về chuỗi và client sẽ ra `NaN`).

---

### Các procedure còn lại

**`SA_Bootstrap_GetConfig`** — gọi tuần tự 7 proc `_Get`, tận dụng cơ chế **nested procedure kế thừa result set**. Đổi 7 round-trip mạng thành 1.

**`SA_SmallDepartment_Get`** — proc phục vụ màn hình "Ánh Xạ Bộ Phận": liệt kê bộ phận nhỏ **thật** trong BioStar kèm `isMapped` (bit) và `userCount`, để người dùng thấy ngay bộ phận nào còn rơi vào `'Khác'`. Đây là vòng phản hồi để bảng ánh xạ không bị lệch khi nhân sự tạo phòng ban mới.

**Ba proc `_Save` upsert** (`Milk`, `Birthday`, `ManualEntry`) theo cùng khuôn:

1. Validate → `RAISERROR` tiếng Việt nếu sai.
2. `IF @Id IS NULL OR NOT EXISTS(...)` → INSERT, lấy `SCOPE_IDENTITY()`; ngược lại UPDATE.
3. `SELECT` lại bản ghi vừa lưu với đúng format của proc `_Get`.

Điều kiện `@Id IS NULL **OR NOT EXISTS**` xử lý được trường hợp client gửi id đã bị xoá — thay vì UPDATE 0 dòng rồi trả rỗng, nó tạo mới.

`SA_BirthdayConfig_Save` có thêm một bước riêng: vì `ConfigDate` là `UNIQUE`, nếu client không gửi `id` mà ngày đã tồn tại, proc **tự tra `ConfigId` theo ngày rồi chuyển sang UPDATE** thay vì để INSERT vi phạm unique constraint. Đây là xử lý trước ràng buộc, không phải bắt lỗi sau.

**Ba proc `_Delete`** trả `SELECT @@ROWCOUNT AS deleted`, còn `_Save`/`_Delete` của mapping và setting thì `EXEC ..._Get` để trả về danh sách đầy đủ.

---

# 6. Sáu quy tắc nghiệp vụ và nơi cài đặt

| Quy tắc | Giá trị | Cài ở đâu |
|---|---|---|
| Ngày công 08:00→08:00 | `<= 01:50:00` lùi 1 ngày (6601s) | `SA_MealLog_GetByRange` + `getActualWorkDate` |
| 6 ca | CA1 22:50–01:50 (wrap), CA2 04:30–06:30, CA3 06:45–08:10, CA4 10:40–13:30, CA5 16:30–18:40, CA6 18:45–20:10, ngoài ra `'Khác'` | `SA_Shift` + `determineShift` |
| Máy Hàn | `TA-102` = `547244627` → `isKorean` → giá 65.000đ thay vì 28.000đ | `SA_Reader.IsKoreanMachine` |
| Ưu tiên bộ phận | rule > mapping > `'Khác'` | `COALESCE(r, m, N'Khác')` |
| Sự kiện hợp lệ | 39, 43–53, 55, 58, 59, 61, 62 | `SA_MealEventCode` |
| Bất thường | > 3 lượt / userId / actualDate | `getAbnormalPunches` (client) |

**Điểm cần cảnh giác nhất:** quy tắc ngày công và phân ca được cài **hai lần** — trong `SA_MealLog_GetByRange` (bản có thẩm quyền, áp dụng lúc đọc) và trong `src/services/mealEngine.ts` (`determineShift`, `getActualWorkDate` — hiện **không còn được tham chiếu ở đâu**, giữ lại như đặc tả tài liệu hoá). Nếu sửa khung giờ ca, phải sửa **cả hai nơi** cùng lúc, nếu không tài liệu sẽ nói dối.

Ngưỡng bất thường có tham số `ABNORMAL_MIN_PUNCH = 3` trong `SA_SystemSetting`, nhưng `getAbnormalPunches` đang hard-code `userLogs.length > 3` (`mealEngine.ts:144`) — tham số DB hiện chưa được nối vào. Trên dữ liệu thật, con số này kích hoạt khoảng 800 lần/tháng: đây là **hàng đợi rà soát**, không phải ngoại lệ hiếm.

Đơn giá luôn tra qua `getUnitPrice(code, fallback)` (`FinancialReportView.tsx:76`) — thiếu một mã trong `SA_MealPrice` thì rơi về giá mặc định thay vì sinh `NaN` lan khắp báo cáo.

---

# 7. Quy ước lập trình cần giữ

- **Không nối chuỗi SQL trong JavaScript.** Cần query mới → thêm procedure.
- **Ngày/giờ so sánh dạng chuỗi** từ đầu đến cuối. Không đưa `Date` vào đường so sánh.
- **`RAISERROR` là văn bản tiếng Việt cho người dùng cuối** — nó đi thẳng lên `alert`.
- **UI toàn tiếng Việt**, giữ nguyên.
- Tailwind v4 qua `@tailwindcss/vite`; `src/index.css` chỉ có một dòng `@import "tailwindcss"`. Không file config, không custom theme — giao diện slate/amber là utility class inline.
- Icon `lucide-react`, chart `recharts`, tiền tệ `formatVND` (`Intl.NumberFormat('vi-VN')`).
- Xuất CSV qua `exportToCSV(filename, headers, rows)` — hàm này **prepend BOM UTF-8** (`﻿`) để Excel hiển thị đúng dấu tiếng Việt.
- Alias `@/*` có khai báo trong cả `tsconfig.json` lẫn `vite.config.ts` nhưng **không file nào dùng**; import đều là đường dẫn tương đối.
- TypeScript chạy `noEmit` và **không bật `strict`** (`strictNullChecks` tắt). Thư mục `server/` là JavaScript thuần, không được type-check.
- `.env` chứa mật khẩu DB, đã gitignore. **Phải đặt trong dấu nháy** — dotenv coi `#` không nháy là comment và sẽ cắt cụt mật khẩu.
- `DISABLE_HMR=true` tắt cả HMR lẫn file watching trong `vite.config.ts`. Đừng động vào khối đó.

## Lệnh

```bash
npm install
npm run dev:all      # API (4000) + Vite (3000) — lệnh dev thông thường
npm run server       # chỉ API
npm run dev          # chỉ Vite, port 3000, host 0.0.0.0, proxy /api -> 4000
npm run lint         # tsc --noEmit — kiểm tra duy nhất của repo
npm run build        # vite build
npm start            # Express phục vụ dist/ + /api trên port 4000
```

**Kiểm tra:** repo không có test framework, không ESLint, không CI. `npm run lint` (`tsc --noEmit`) là **toàn bộ** khả năng xác minh — và nó không nhìn thấy thư mục `server/`.

## Thêm một domain dữ liệu mới

Đúng 5 bước, theo thứ tự:

1. `db/01_schema.sql` — thêm bảng
2. `db/03_procedures.sql` — thêm proc `_Get` / `_Save` / `_Delete`
3. `server/routes.js` — thêm route + validator
4. `src/services/api.ts` — thêm hàm client
5. `src/App.tsx` — thêm `useState` + handler

Nếu cần màn hình mới thì thêm `TabType` + `navItems` + nhánh render.

## Ghi chú dọn dẹp

`@google/genai` vẫn nằm trong `package.json` nhưng **không file nguồn nào import**, và không chỗ nào đọc Gemini key. Dự án đã thôi là applet Google AI Studio kể từ khi nối vào SQL Server — dependency này là tàn dư.
