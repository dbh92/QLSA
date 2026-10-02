# Hệ thống Quản lý và Theo dõi Suất ăn

Ứng dụng quản lý suất ăn nhà ăn cho nhà máy, chạy trên **dữ liệu thật** từ hệ
thống chấm thẻ BioStar trong SQL Server.

- **Frontend**: React 19 + Vite + Tailwind v4
- **Backend**: Express (Node.js) + `mssql`
- **Dữ liệu**: SQL Server — toàn bộ truy cập đi qua stored procedure

## Kiến trúc dữ liệu

Hai database trên cùng một instance SQL Server:

| Database | Vai trò |
|---|---|
| `BioStar` | Dữ liệu gốc, **chỉ đọc**: `TB_EVENT_LOG` (lượt quẹt thẻ), `TB_READER` (máy đọc), `TB_USER` (nhân viên), `TB_USER_DEPT` (bộ phận nhỏ) |
| `QLSA` | Các bảng cấu hình `SA_*` + toàn bộ stored procedure `SA_*` của hệ thống suất ăn |

Stored procedure trong `QLSA` đọc cross-database sang `BioStar`. Các bảng của
BioStar không bị sửa đổi.

Chỉ 3 máy chấm ăn được tính:

| Máy | `nReaderIdn` | Ghi chú |
|---|---|---|
| `TA-102(CT Korea)[10.70.22.102]` | 547244627 | Nhà ăn Hàn Quốc — đặt `isKorean`, áp đơn giá cơm Hàn |
| `TA-103(CanteenV)[10.70.22.103]` | 547246370 | Canteen V |
| `TA-104(CanteenK)[10.70.22.104]` | 547244626 | Canteen K |

## Cài đặt

**Yêu cầu:** Node.js 18+, quyền truy cập SQL Server.

### 1. Cài dependency

```bash
npm install
```

### 2. Tạo bảng + stored procedure trên SQL Server

Chạy lần lượt 3 script trong thư mục [db/](db/) trên database `QLSA`. Cả 3
script đều **chạy lại được nhiều lần** (idempotent):

```bash
sqlcmd -S 10.70.22.240 -d QLSA -U sa -P '<mật khẩu>' -C -f 65001 -I -b -i db/01_schema.sql
sqlcmd -S 10.70.22.240 -d QLSA -U sa -P '<mật khẩu>' -C -f 65001 -I -b -i db/02_seed.sql
sqlcmd -S 10.70.22.240 -d QLSA -U sa -P '<mật khẩu>' -C -f 65001 -I -b -i db/03_procedures.sql
```

> Bắt buộc có `-I` (bật `QUOTED_IDENTIFIER`) và `-f 65001` (đọc file UTF-8, giữ
> đúng dấu tiếng Việt).

| Script | Nội dung |
|---|---|
| `01_schema.sql` | Tạo 12 bảng `SA_*` |
| `02_seed.sql` | Danh mục: bộ phận lớn, 41 ánh xạ bộ phận, quy tắc ánh xạ có điều kiện, 6 ca ăn, 3 máy chấm, mã sự kiện hợp lệ, đơn giá, tham số hệ thống, số liệu biểu đồ tháng |
| `03_procedures.sql` | Toàn bộ stored procedure `SA_*` |

### 3. Cấu hình kết nối

Sao chép [.env.example](.env.example) thành `.env` và điền thông tin:

```env
DB_SERVER=10.70.22.240
DB_DATABASE=QLSA
DB_USER=sa
DB_PASSWORD="mật-khẩu"   # luôn để trong nháy kép — dotenv coi # là comment
PORT=4000
```

### 4. Chạy

```bash
npm run dev:all    # chạy song song API (cổng 4000) + Vite (cổng 3000)
```

Hoặc chạy riêng từng tiến trình:

```bash
npm run server     # chỉ API, cổng 4000
npm run dev        # chỉ frontend, cổng 3000 (proxy /api sang cổng 4000)
```

Bản production:

```bash
npm run build      # build ra dist/
npm start          # Express phục vụ cả dist/ lẫn /api trên cổng 4000
```

### 5. Tạo tài khoản đăng nhập

Toàn bộ API đều đòi đăng nhập, nên phải có ít nhất một tài khoản trước khi
dùng. Tài khoản quản lý bằng dòng lệnh trên máy chủ:

```bash
npm run user -- add admin "Quản trị hệ thống"   # bỏ trống mật khẩu -> tự sinh
npm run user -- list                            # xem lại mật khẩu khi ai đó quên
npm run user -- passwd <tên đăng nhập>          # đặt lại mật khẩu
npm run user -- disable <tên đăng nhập>         # khoá, huỷ mọi phiên đang mở
```

> Mật khẩu lưu **dạng thường** (không băm) vì hệ thống chỉ chạy trong mạng nội
> bộ — xem chú thích đầu [server/auth.js](server/auth.js).

## Redeploy khi có bản mới

Chạy trên **máy chủ đang phục vụ ứng dụng**, tại thư mục dự án:

```bash
# 1. Dừng tiến trình đang chạy (Ctrl-C, hoặc tắt service/Task Scheduler).
#    Còn tiến trình cũ giữ cổng 4000 thì bản mới KHÔNG khởi động được và
#    người dùng vẫn đang chạy code cũ mà không biết.
netstat -ano | findstr :4000        # Windows — lấy PID rồi taskkill /F /PID <pid>

# 2. Lấy mã nguồn mới về (git pull / copy đè thư mục, GIỮ NGUYÊN .env và dist cũ)

# 3. Cài lại dependency — bắt buộc mỗi lần package.json đổi
npm install

# 4. Cập nhật cơ sở dữ liệu NẾU db/*.sql có thay đổi (xem mục dưới)

# 5. Build lại frontend — bỏ bước này thì trình duyệt vẫn chạy giao diện cũ
npm run build

# 6. Chạy lại
npm start
```

Kiểm tra nhanh sau khi chạy: mở trang, phải thấy **màn hình đăng nhập**; đăng
nhập xong phải thấy dữ liệu nạp theo bộ lọc thời gian đang chọn.

### Cập nhật cơ sở dữ liệu

`db/03_procedures.sql` **xoá rồi tạo lại TOÀN BỘ** proc `SA_*`. Nếu ai đó từng
sửa tay proc trên SSMS mà chưa đưa về repo, chạy lại script này sẽ xoá mất bản
sửa đó. Vì vậy trước khi chạy hãy đối chiếu bản live với repo, và chỉ chạy khi
`db/*.sql` thực sự có thay đổi:

```sql
-- Xem định nghĩa proc đang chạy trên server để so với file trong repo
SELECT o.name, m.definition
FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id
WHERE o.name LIKE 'SA[_]%' ORDER BY o.name;
```

Cả 3 script đều idempotent nên chạy lại được, theo đúng thứ tự 01 → 02 → 03.

## Lệnh khác

```bash
npm run lint       # tsc --noEmit — kiểm tra kiểu, là kiểm tra duy nhất của repo
npm run preview    # xem thử bản build bằng Vite
```

## Quy tắc nghiệp vụ

- **`actualDate` là đúng ngày lịch của lượt quẹt.** Không lùi ngày: quẹt lúc
  `2026-08-11 00:48:37` thuộc ngày `2026-08-11`. Ca ăn vẫn phân theo khung giờ
  (CA1 vắt qua nửa đêm) nhưng điều đó chỉ quyết định tên ca, không đổi ngày.
- **Bộ lọc thời gian toàn cục chính xác tới giây** (`YYYY-MM-DD HH:mm:ss`), hai
  biên đều là biên đóng. Các view lọc log theo `logDateTime`.
- **6 ca ăn theo khung giờ** (`SA_Shift`): CA1 đêm 22:50–01:50 (vắt qua nửa đêm),
  CA2 04:30–06:30, CA3 06:45–08:10, CA4 10:40–13:30, CA5 16:30–18:40,
  CA6 18:45–20:10, ngoài các khung trên là `Khác`.
- **Ánh xạ bộ phận 2 cấp.** Bộ phận nhỏ (`TB_USER_DEPT.sName`) được gộp về bộ
  phận lớn (`CSP`, `LFEM`, `SMT`, `SP`, `QC`, `WLP1`, `WLP2`, `R&D`, `KR`,
  `Khác`) qua bảng `SA_DepartmentMapping`. Bộ phận nhỏ chưa ánh xạ rơi vào `Khác`.
- **Quy tắc ánh xạ có điều kiện** (`SA_DepartmentMappingRule`): nhân viên thuộc
  `Khach cong tac` mà tên có chứa `Business` được tính vào `KR`; còn lại thuộc
  `SP`. Rule được ưu tiên hơn ánh xạ mặc định.
- **Bất thường = quẹt quá 3 lần** cho một nhân viên trong một ngày công.
- **Đơn giá** lấy từ `SA_MealPrice` theo `code` (cơm Việt 28K, cơm Hàn 65K, suất
  đặc biệt 50K…).

## API

| Method | Endpoint | Stored procedure |
|---|---|---|
| GET | `/api/health` | — |
| GET | `/api/bootstrap` | `SA_Bootstrap_GetConfig` |
| GET | `/api/meal-logs?from=&to=` | `SA_MealLog_GetByRange` |
| GET | `/api/departments/large` | `SA_LargeDepartment_Get` |
| GET | `/api/departments/small` | `SA_SmallDepartment_Get` |
| GET | `/api/mappings` | `SA_DepartmentMapping_Get` |
| POST | `/api/mappings` | `SA_DepartmentMapping_Save` |
| DELETE | `/api/mappings/:smallDepartment` | `SA_DepartmentMapping_Delete` |
| GET | `/api/mapping-rules` | `SA_DepartmentMappingRule_Get` |
| GET/POST | `/api/milk` | `SA_MilkEntry_Get` / `_Save` |
| DELETE | `/api/milk/:id` | `SA_MilkEntry_Delete` |
| GET/POST | `/api/birthday` | `SA_BirthdayConfig_Get` / `_Save` |
| DELETE | `/api/birthday/:id` | `SA_BirthdayConfig_Delete` |
| GET/POST | `/api/manual-entries` | `SA_ManualEntry_Get` / `_Save` |
| DELETE | `/api/manual-entries/:id` | `SA_ManualEntry_Delete` |
| GET | `/api/shifts` `/api/readers` `/api/prices` `/api/monthly-costs` | các proc `_Get` tương ứng |
| GET | `/api/settings` | `SA_SystemSetting_Get` |
| PUT | `/api/settings/:key` | `SA_SystemSetting_Save` |
