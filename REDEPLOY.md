# Quy trình RE-DEPLOY — Windows Server 2019 (10.70.21.97)

Tài liệu này dành cho việc **cập nhật một bản đã chạy**. Lần cài đặt đầu tiên (Node.js,
NSSM service `QLSA-API`, firewall, múi giờ) xem [DEPLOY_WINSERVER2019.md](DEPLOY_WINSERVER2019.md).

| Thành phần | Máy | Đường dẫn |
|---|---|---|
| App (Express + SPA) | 10.70.21.97 | `C:\QLSA`, service `QLSA-API`, cổng 4000 |
| Database `QLSA` + `BioStar` | 10.70.22.240 | SQL Server 2012 Express, cổng 1433 |

## Chạy bước nào?

| Thay đổi trong repo | A. Build & gói | B. SQL | C. Deploy | D. Nghiệm thu |
|---|:--:|:--:|:--:|:--:|
| `src/**` (giao diện, báo cáo) | ✅ | — | ✅ | ✅ |
| `server/**` (route, db.js) | ✅ | — | ✅ | ✅ |
| `db/*.sql` (procedure, bảng, seed) | — | ✅ | — | ✅ |
| `dependencies` trong `package.json` | ✅ + `node_modules` | — | ✅ | ✅ |

---

## A. Trên máy dev — dựng gói cập nhật

```powershell
cd "d:\11.QLSA\hệ-thống-quản-lý-và-theo-dõi-suất-ăn"
npm run lint       # tsc --noEmit — kiểm tra duy nhất của repo, phải sạch mới build
npm run build      # sinh lại dist\
```

Dựng thư mục staging **chỉ chứa phần thay đổi**. Lưu ý: không mang `.env` sang, để giữ
nguyên file cấu hình production đang chạy trên server.

```powershell
$src   = "d:\11.QLSA\hệ-thống-quản-lý-và-theo-dõi-suất-ăn"
$stage = "C:\Users\Wisol\Desktop\QLSA-update"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

Copy-Item "$src\dist"   $stage -Recurse -Force
Copy-Item "$src\server" $stage -Recurse -Force

Compress-Archive -Path "$stage\*" -DestinationPath "C:\Users\Wisol\Desktop\QLSA-update.zip" -Force
```

**Chỉ khi `dependencies` trong `package.json` đổi** mới phải kèm `node_modules`: dựng lại
theo Phương án B (mục 4.2 của tài liệu triển khai — 5 gói runtime `express`, `compression`,
`cors`, `dotenv`, `mssql`), chạy `npm install --omit=dev`, rồi nén thêm `node_modules\` và
`package.json` vào gói. Nếu không đổi thì bỏ qua hoàn toàn.

Chuyển `QLSA-update.zip` sang server qua RDP copy-paste, UNC share hoặc USB.

---

## B. Cập nhật SQL Server (chỉ khi `db\*.sql` có thay đổi)

App **không chứa một dòng SQL nào** — mọi thay đổi truy vấn nằm trong database `QLSA` trên
`10.70.22.240`. Deploy app mà quên bước này thì giao diện mới sẽ gọi procedure cũ.

> ⚠️ **Procedure trên máy thật hay bị sửa tay bằng SSMS.** Luôn dump procedure đang chạy và
> so sánh với `db\03_procedures.sql` trước khi ghi đè, nếu không sẽ xoá mất sửa đổi live.

Mật khẩu `sa` lấy trong `.env` (`DB_PASSWORD`); dưới đây ghi là `<mật khẩu>`.

```powershell
$sqlcmd = @("-S","10.70.22.240,1433","-U","sa","-P","<mật khẩu>","-d","QLSA","-f","65001","-I")

# 1. Sao lưu toàn bộ procedure SA_* hiện hành
sqlcmd @sqlcmd -h -1 -y 0 `
  -Q "SELECT definition + CHAR(13)+'GO'+CHAR(13) FROM sys.sql_modules m JOIN sys.objects o ON o.object_id=m.object_id WHERE o.name LIKE 'SA[_]%'" `
  -o "C:\Users\Wisol\Desktop\QLSA-procs-backup.sql"

# 2. So sánh QLSA-procs-backup.sql với db\03_procedures.sql.
#    Nếu có khác biệt do sửa tay: gộp vào 03_procedures.sql trước, rồi mới chạy tiếp.

# 3. Deploy — đúng thứ tự, cả ba script đều idempotent
sqlcmd @sqlcmd -i "d:\11.QLSA\hệ-thống-quản-lý-và-theo-dõi-suất-ăn\db\01_schema.sql"
sqlcmd @sqlcmd -i "d:\11.QLSA\hệ-thống-quản-lý-và-theo-dõi-suất-ăn\db\02_seed.sql"
sqlcmd @sqlcmd -i "d:\11.QLSA\hệ-thống-quản-lý-và-theo-dõi-suất-ăn\db\03_procedures.sql"
```

Hai tham số bắt buộc, không được bỏ:

- `-I` — bật `QUOTED_IDENTIFIER`, các computed column PERSISTED trong `01_schema.sql` yêu cầu.
- `-f 65001` — đọc file UTF-8, thiếu nó tiếng Việt trong seed và trong message `RAISERROR` sẽ vỡ.

Đích là SQL Server 2012 Express: không `CREATE OR ALTER`, không `DROP ... IF EXISTS`,
không `STRING_AGG`. `03_procedures.sql` tự drop mọi proc `SA_*` ở batch đầu rồi `CREATE` lại.

---

## C. Trên server 10.70.21.97 — PowerShell quyền Administrator

```powershell
# 1. Dừng dịch vụ
Stop-Service QLSA-API

# 2. Sao lưu bản đang chạy (để rollback)
$bk = "C:\QLSA-backup-$(Get-Date -f yyyyMMdd-HHmm)"
Copy-Item C:\QLSA -Destination $bk -Recurse

# 3. Xoá thư mục cũ — Expand-Archive -Force chỉ ghi đè, KHÔNG xoá file thừa.
#    dist: asset build có hash trong tên, không xoá sẽ tích rác qua từng lần deploy.
#    server: route đã bị xoá trong mã nguồn sẽ còn sót lại nếu không xoá.
Remove-Item C:\QLSA\dist   -Recurse -Force
Remove-Item C:\QLSA\server -Recurse -Force

# 4. Bung gói mới
Expand-Archive -Path "C:\Users\Administrator\Desktop\QLSA-update.zip" -DestinationPath C:\QLSA -Force

# 5. Xác nhận .env vẫn còn nguyên (bước 3 không đụng tới nó)
Get-Content C:\QLSA\.env

# 6. Khởi động lại và xem log
Start-Service QLSA-API
Get-Service  QLSA-API
Get-Content  C:\QLSA\logs\out.log -Tail 20
```

Kỳ vọng trong log: `[api] Đang lắng nghe trên http://0.0.0.0:4000`.

Nếu thấy `[db] Không kết nối được SQL Server` thì tiến trình đã tự `exit(1)`:

- Kiểm tra `.env` — `DB_PASSWORD` **bắt buộc** nằm trong nháy kép vì mật khẩu chứa ký tự `#`,
  thiếu nháy kép dotenv cắt mất phần sau `#` và SQL Server trả về "Login failed".
- Kiểm tra đường mạng: `Test-NetConnection 10.70.22.240 -Port 1433`.

---

## D. Nghiệm thu

Ngay trên server:

```powershell
Invoke-RestMethod "http://localhost:4000/api/shifts" | Select-Object -First 3
```

Từ máy trạm, mở `http://10.70.21.97:4000` và Ctrl+F5 (tránh `index.html` cache cũ trỏ tới
asset đã bị xoá):

- [ ] Dashboard lên số liệu; đổi khoảng ngày → dữ liệu đổi theo
- [ ] Badge "bất thường" trên Navbar hiện số (dữ liệu thật ~800 lượt/tháng — bình thường)
- [ ] Tab **Báo cáo chi phí**: mở vài sub-report, đối chiếu tổng tiền với bảng kê của nhà bếp
- [ ] Bấm "Báo cáo tổng hợp" → tải được file Excel, màu các sheet khớp với màu trên web
- [ ] Tab **Ánh Xạ Bộ Phận** và **Cấu Hình Giá Suất Ăn**: sửa và lưu được (kiểm tra đường ghi DB)

---

## E. Rollback

```powershell
Stop-Service QLSA-API
Rename-Item C:\QLSA C:\QLSA-failed
Rename-Item "C:\QLSA-backup-<timestamp>" C:\QLSA
Start-Service QLSA-API
```

Nếu đã chạy bước B, khôi phục procedure từ `QLSA-procs-backup.sql` đã dump ở bước B.1:

```powershell
sqlcmd -S 10.70.22.240,1433 -U sa -P "<mật khẩu>" -d QLSA -f 65001 -I -i "C:\...\QLSA-procs-backup.sql"
```

---

## Lệnh vận hành thường dùng

```powershell
Restart-Service QLSA-API
Get-Content C:\QLSA\logs\out.log -Tail 50 -Wait    # theo dõi thời gian thực
Get-Content C:\QLSA\logs\err.log -Tail 50
Get-Process node | Select-Object Id, CPU, WS, StartTime
```

Bộ nhớ kỳ vọng ổn định 150–400 MB. Tăng liên tục không dừng → nghi rò rỉ connection pool.

Dữ liệu nằm hoàn toàn trong SQL Server; `C:\QLSA` chỉ là mã nguồn đã build, tái tạo lại
được từ máy dev bất cứ lúc nào.
