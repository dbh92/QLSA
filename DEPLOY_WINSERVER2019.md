# Tài liệu triển khai — Windows Server 2019 (10.70.21.97)

> Trạng thái: **BẢN KẾ HOẠCH — CHƯA THỰC HIỆN**. Không có bước nào trong tài liệu này
> được chạy. Chờ phê duyệt của người phụ trách.

---

## 0. Kết luận nhanh

**Có deploy được.** Ứng dụng là Node.js + Express phục vụ cả frontend (`dist/`) lẫn API
`/api` trên **một cổng duy nhất**, không cần IIS, không cần biên dịch native, không cần
Internet lúc chạy.

Chỉ có **1 điểm chặn duy nhất**: máy 10.70.21.97 **chưa cài Node.js** (xem lại danh sách
Programs and Features — không có mục Node.js nào). Cài bộ MSI Node.js 22 LTS là xử lý xong.

Ngoài ra có **2 điều kiện tiên quyết bắt buộc phải xác minh trước** khi bắt đầu (mục 3).

---

## 1. Đối chiếu yêu cầu với hiện trạng server

| Yêu cầu của ứng dụng | Hiện trạng 10.70.21.97 | Kết luận |
|---|---|---|
| Node.js 18+ (runtime chính) | **Không có** trong Programs and Features | ❌ **Phải cài** — Node.js 22 LTS |
| RAM / CPU | 256 GB RAM, Xeon Gold 6326 16 vCPU | ✅ Dư thừa rất nhiều (app cần ~200–400 MB) |
| Hệ điều hành | Windows Server 2019 Standard, x64, đã kích hoạt | ✅ Node.js 22 hỗ trợ chính thức |
| Kết nối tới SQL Server `10.70.22.240:1433` | Chưa xác minh (khác subnet: 21.x → 22.x) | ⚠️ **Phải test trước** (mục 3.1) |
| SQL Server engine trên chính máy này | Đã có SQL Server 2019 + SSMS 20 + ODBC 17 | ℹ️ **Không dùng tới** (mục 3.2) — nhưng `sqlcmd` rất tiện để kiểm tra |
| IIS / .NET | Có .NET 5 + 6 Hosting Bundle (⇒ nhiều khả năng IIS đã bật) | ℹ️ Không bắt buộc. Chỉ dùng nếu muốn chạy cổng 80 qua IIS (mục 7-B) |
| Internet lúc chạy | Không rõ | ✅ **Không cần** — app không gọi dịch vụ ngoài nào |
| Trình duyệt để nghiệm thu | Microsoft Edge 151 | ✅ |

**Về gói `@google/genai` trong `package.json`:** tôi đã grep toàn bộ `src/` và `server/` —
**không có dòng code nào import hay gọi nó**. Đây là dependency thừa còn sót lại từ template
AI Studio. Ứng dụng **không gọi Gemini, không cần API key, không cần ra Internet**. Có thể gỡ
bỏ (mục 4, Phương án B).

---

## 2. Kiến trúc triển khai

```
                    ┌──────────────────────────────────────────┐
   Người dùng       │  VN-APP-SMTSVR  —  10.70.21.97 (Win2019)  │
   trình duyệt      │                                          │
   ───────────────► │  Node.js 22  ─  node server\index.js      │
   http://10.70.    │  chạy dưới dạng Windows Service           │
   21.97:4000       │                                          │
                    │   ├── GET /            → dist\index.html  │  (React SPA đã build)
                    │   ├── GET /assets/*    → dist\assets\*    │
                    │   └── ALL /api/*       → routes.js        │
                    └───────────────────┬──────────────────────┘
                                        │ TCP 1433  (mssql / tedious)
                                        ▼
                    ┌──────────────────────────────────────────┐
                    │  SQL Server  —  10.70.22.240:1433         │
                    │   ├── [QLSA]    bảng SA_* + stored proc   │
                    │   └── [BioStar] dữ liệu quẹt thẻ (chỉ đọc)│
                    └──────────────────────────────────────────┘
```

**Điểm mấu chốt:** trong `server/index.js` (dòng 34–39), Express đã tự phục vụ thư mục
`dist/` và fallback mọi route không phải `/api` về `index.html`. Nghĩa là **không cần IIS,
không cần cấu hình SPA rewrite, không cần cổng 3000**. Chỉ một tiến trình `node.exe` duy nhất.

---

## 3. Điều kiện tiên quyết — XÁC MINH TRƯỚC KHI LÀM BẤT CỨ VIỆC GÌ

### 3.1. Thông mạng từ 10.70.21.97 tới SQL Server 10.70.22.240:1433 — **rủi ro số 1**

Máy app nằm ở subnet `10.70.21.x`, SQL Server ở `10.70.22.x`. Nếu giữa 2 subnet có firewall
hoặc ACL chặn, toàn bộ việc deploy sẽ thất bại ở bước cuối.

Chạy trên **10.70.21.97** (PowerShell):

```powershell
Test-NetConnection -ComputerName 10.70.22.240 -Port 1433
```

Kỳ vọng: `TcpTestSucceeded : True`. Nếu `False` → phải làm việc với đội Network/IT mở port
trước, mọi bước còn lại vô nghĩa.

Kiểm tra sâu hơn bằng `sqlcmd` (đã có sẵn trên server nhờ SQL Server 2019):

```powershell
sqlcmd -S 10.70.22.240 -U sa -P "<mật khẩu sa>" -C -Q "SELECT @@SERVERNAME, DB_NAME();"
sqlcmd -S 10.70.22.240 -U sa -P "<mật khẩu sa>" -C -d QLSA -Q "SELECT COUNT(*) AS SoProc FROM sys.procedures WHERE name LIKE 'SA[_]%';"
sqlcmd -S 10.70.22.240 -U sa -P "<mật khẩu sa>" -C -d QLSA -Q "SELECT COUNT(*) FROM BioStar.dbo.TB_EVENT_LOG;"
```

Câu thứ 2 phải trả về số lượng stored procedure > 0 (nghĩa là 3 script trong `db/` đã được
chạy). Câu thứ 3 xác nhận truy vấn cross-database sang `BioStar` hoạt động.

### 3.2. KHÔNG chuyển database sang SQL Server 2019 trên chính máy 10.70.21.97

Server đích có sẵn SQL Server 2019, dễ nảy sinh ý tưởng "chuyển luôn DB về đây cho gọn".
**Không làm được**, vì theo thiết kế (README + `db/03_procedures.sql`), các stored procedure
trong `[QLSA]` **truy vấn cross-database trực tiếp sang `[BioStar]`** trên **cùng một
instance**. Muốn tách ra thì phải dựng linked server hoặc đồng bộ dữ liệu — thay đổi kiến
trúc lớn, ngoài phạm vi việc deploy này.

➡️ **Database giữ nguyên tại 10.70.22.240.** SQL Server trên 10.70.21.97 không đụng tới.

### 3.3. Phần mềm bảo mật đầu cuối — **rủi ro số 2**

Server đang chạy đồng thời **AhnLab EPP (3 agent)** và **SentinelOne Agent**. Đây là các
EDR có khả năng:
- chặn tiến trình `node.exe` mới lạ thực thi,
- chặn `node.exe` mở cổng lắng nghe (listener),
- cách ly (quarantine) file `.js` được sao chép hàng loạt từ máy khác.

➡️ Cần **đăng ký whitelist trước** với đội bảo mật: đường dẫn `C:\QLSA\` và tiến trình
`C:\Program Files\nodejs\node.exe`. Nếu bỏ qua bước này, triệu chứng điển hình là service
khởi động rồi tự chết sau vài giây, hoặc `npm` báo lỗi ghi file rất khó hiểu.

### 3.4. Các điểm cần chốt (xin quyết định của anh/chị)

| # | Vấn đề | Đề xuất |
|---|---|---|
| a | Cổng truy cập | Dùng **4000** (`http://10.70.21.97:4000`). Nếu bắt buộc cổng 80 → mục 7-B |
| b | Tài khoản SQL | `.env` đang dùng **`sa`** với mật khẩu ghi thẳng trong file. Đề xuất tạo login riêng `qlsa_app` chỉ có quyền `EXECUTE` trên các proc `SA_*` (mục 10) |
| c | Server đã bật IIS chưa | Cần chạy lệnh kiểm tra ở mục 7 để biết cổng 80 có bị chiếm không |
| d | Múi giờ server | Phải là `SE Asia Standard Time` (mục 5.2) — nghiệp vụ phụ thuộc rất nặng vào giờ (ngày công 08:00→08:00, 6 ca ăn theo khung giờ) |

---

## 4. Chuẩn bị gói triển khai (làm trên máy dev — máy đang mở tài liệu này)

Không build trên server (server có thể không có Internet, và không nên cài công cụ build lên
máy production). Build ở đây, mang gói hoàn chỉnh sang.

### Bước 4.1 — Build frontend

```powershell
cd "d:\11.QLSA\hệ-thống-quản-lý-và-theo-dõi-suất-ăn"
npm run lint      # tsc --noEmit — bắt lỗi kiểu trước khi build
npm run build     # sinh ra dist\
```

Kỳ vọng: `dist\index.html` + `dist\assets\index-*.js` + `index-*.css` (~745 KB).

### Bước 4.2 — Tạo thư mục staging

Có 2 phương án cho `node_modules`. **Khuyến nghị Phương án B.**

#### Phương án A — bê nguyên dependencies (nhanh, an toàn nhất, ~150 MB)

```powershell
$stage = "C:\Users\Wisol\Desktop\QLSA-deploy"
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item package.json, package-lock.json $stage
cd $stage
npm ci --omit=dev
```

Lưu ý: `vite`, `tailwindcss`, `@vitejs/plugin-react` đang nằm nhầm trong `dependencies` nên
vẫn bị cài, dù runtime không cần.

#### Phương án B — gói tinh gọn, chỉ 5 thư viện runtime (~15 MB) ✅ khuyến nghị

Server thực sự chỉ `import`: `express`, `compression`, `cors`, `dotenv`, `mssql`.

```powershell
$stage = "C:\Users\Wisol\Desktop\QLSA-deploy"
New-Item -ItemType Directory -Force $stage | Out-Null
```

Tạo file `$stage\package.json` với nội dung sau (⚠️ **bắt buộc giữ `"type": "module"`** —
`server/*.js` viết bằng cú pháp ESM `import`, thiếu dòng này Node sẽ báo
`Cannot use import statement outside a module`):

```json
{
  "name": "qlsa-server",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server/index.js"
  },
  "dependencies": {
    "compression": "^1.8.1",
    "cors": "^2.8.6",
    "dotenv": "^17.2.3",
    "express": "^4.21.2",
    "mssql": "^12.7.0"
  }
}
```

```powershell
cd $stage
npm install --omit=dev
```

> Cả 5 gói này đều là **JavaScript thuần** (`mssql` dùng driver `tedious` viết bằng JS,
> không phải native addon). Vì vậy sao chép `node_modules` từ máy dev Windows x64 sang
> server Windows x64 là **an toàn tuyệt đối**, không cần build tool trên server.

### Bước 4.3 — Chép mã nguồn runtime + cấu hình vào staging

```powershell
$src = "d:\11.QLSA\hệ-thống-quản-lý-và-theo-dõi-suất-ăn"
Copy-Item "$src\dist"   $stage -Recurse -Force
Copy-Item "$src\server" $stage -Recurse -Force
Copy-Item "$src\.env"   $stage -Force
```

Cấu trúc staging cuối cùng:

```
QLSA-deploy\
├── dist\            ← frontend đã build
├── server\          ← index.js, routes.js, db.js
├── node_modules\    ← chỉ dependencies runtime
├── package.json
└── .env
```

**KHÔNG chép sang server:** `src/`, `db/`, `assets/`, `node_modules` bản đầy đủ,
`vite.config.ts`, `tsconfig.json`, `index.html` (ở gốc), `bun.lock`, `README.md`.

### Bước 4.4 — Sửa `.env` cho môi trường production

Tạo `$stage\.env`:

```env
# Kết nối SQL Server (BioStar + QLSA nằm trên cùng instance 10.70.22.240)
DB_SERVER=10.70.22.240
DB_PORT=1433
DB_DATABASE=QLSA
DB_USER=sa
# Bắt buộc để trong nháy kép: dotenv coi ký tự # ngoài chuỗi là bắt đầu comment.
DB_PASSWORD="<mật khẩu sa>"
DB_ENCRYPT=false

PORT=4000
```

⚠️ Dấu nháy kép quanh mật khẩu là **bắt buộc** — mật khẩu chứa ký tự `#`, thiếu nháy kép
`dotenv` sẽ cắt mất phần từ `#` trở đi và kết nối thất bại với lỗi "Login failed".

### Bước 4.5 — Nén lại để chuyển sang server

```powershell
Compress-Archive -Path "$stage\*" -DestinationPath "C:\Users\Wisol\Desktop\QLSA-deploy.zip" -Force
```

Chuyển sang 10.70.21.97 qua RDP copy-paste, UNC share, hoặc USB.

### Bước 4.6 — Tải bộ cài Node.js (offline)

Server có thể không ra được Internet, nên **tải sẵn trên máy dev** rồi mang sang:

- Truy cập <https://nodejs.org/dist/latest-v22.x/>
- Tải file **`node-v22.x.x-x64.msi`**

Chọn **Node.js 22 LTS** vì: (a) máy dev đang chạy `v22.15.0` — đồng nhất môi trường, loại
bỏ rủi ro khác biệt phiên bản; (b) Windows Server 2019 nằm trong danh sách hỗ trợ chính thức
của Node 22; (c) Node 22 còn được bảo trì bảo mật tới 04/2027.

---

## 5. Cài đặt trên server 10.70.21.97

> Toàn bộ mục này chạy trong **PowerShell với quyền Administrator**, ngay trên console
> hoặc phiên RDP của 10.70.21.97.

### 5.1. Cài Node.js 22 LTS

Chạy `node-v22.x.x-x64.msi`, giữ nguyên mọi tùy chọn mặc định.
**Bỏ tick** mục *"Automatically install the necessary tools (Chocolatey / Python / VS Build
Tools)"* — không cần, và nó sẽ cố tải từ Internet.

Đóng và mở lại PowerShell (để nạp lại biến `PATH`), rồi kiểm tra:

```powershell
node -v      # kỳ vọng: v22.x.x
npm -v       # kỳ vọng: 10.x hoặc 11.x
```

### 5.2. Kiểm tra và đặt múi giờ

Nghiệp vụ phụ thuộc hoàn toàn vào giờ cục bộ (`useUTC: false` trong `server/db.js`,
ngày công 08:00→08:00, phân ca theo khung giờ). Sai múi giờ sẽ khiến số liệu lệch ngày,
lệch ca — lỗi rất khó phát hiện vì hệ thống vẫn chạy bình thường.

```powershell
Get-TimeZone
# Nếu chưa đúng:
Set-TimeZone -Id "SE Asia Standard Time"   # UTC+07:00 Bangkok, Hanoi, Jakarta
w32tm /resync                               # đồng bộ lại đồng hồ
```

### 5.3. Giải nén ứng dụng

```powershell
New-Item -ItemType Directory -Force "C:\QLSA" | Out-Null
Expand-Archive -Path "C:\Users\<user>\Desktop\QLSA-deploy.zip" -DestinationPath "C:\QLSA" -Force
New-Item -ItemType Directory -Force "C:\QLSA\logs" | Out-Null
Get-ChildItem C:\QLSA
```

⚠️ **Bắt buộc dùng đường dẫn ASCII `C:\QLSA`**, tuyệt đối không giữ tên thư mục tiếng Việt
có dấu như trên máy dev (`hệ-thống-quản-lý-và-theo-dõi-suất-ăn`). Đường dẫn có dấu thường
gây lỗi khó lường với NSSM, Task Scheduler và console codepage của Windows Server.

### 5.4. Chạy thử ở chế độ foreground (bước quyết định — chưa cài service vội)

```powershell
cd C:\QLSA
node server\index.js
```

Kỳ vọng thấy đúng 2 dòng:

```
[db] Đã kết nối 10.70.22.240/QLSA
[api] Đang lắng nghe trên http://0.0.0.0:4000
```

**Bảng chẩn đoán lỗi thường gặp:**

| Thông báo | Nguyên nhân | Xử lý |
|---|---|---|
| `[db] Không kết nối được SQL Server: ... ETIMEOUT` | Firewall giữa 2 subnet chặn 1433 | Quay lại mục 3.1 |
| `Login failed for user 'sa'` | Mật khẩu trong `.env` thiếu nháy kép → mất phần sau `#` | Sửa `.env` mục 4.4 |
| `Cannot find module 'express'` | Thiếu `node_modules` | Chép lại từ staging |
| `Cannot use import statement outside a module` | `package.json` thiếu `"type": "module"` | Sửa mục 4.2 |
| `EADDRINUSE :::4000` | Cổng 4000 đã bị dịch vụ khác chiếm | Đổi `PORT` trong `.env` |
| Tiến trình khởi động rồi biến mất, không log | AhnLab / SentinelOne chặn | Quay lại mục 3.3 |

Kiểm tra ngay tại chỗ (mở PowerShell thứ 2, **giữ nguyên cửa sổ đang chạy node**):

```powershell
Invoke-RestMethod http://localhost:4000/api/health
Invoke-RestMethod http://localhost:4000/api/bootstrap | ConvertTo-Json -Depth 3 | Select-Object -First 40
```

Xong thì nhấn `Ctrl+C` để dừng, chuyển sang bước cài service.

---

## 6. Chạy như Windows Service (tự khởi động cùng máy)

Yêu cầu: app phải tự chạy lại sau khi server reboot và tự restart nếu crash.

### Phương án 1 — NSSM ✅ khuyến nghị

NSSM (Non-Sucking Service Manager) là công cụ nhỏ gọn, không cần cài đặt, tự động restart
tiến trình khi crash và ghi log ra file.

Tải trên máy dev từ <https://nssm.cc/download> (bản 2.24), giải nén, mang file
`win64\nssm.exe` sang, đặt tại `C:\QLSA\nssm.exe`.

```powershell
cd C:\QLSA

.\nssm.exe install QLSA-API "C:\Program Files\nodejs\node.exe"
.\nssm.exe set QLSA-API AppParameters      "server\index.js"
.\nssm.exe set QLSA-API AppDirectory       "C:\QLSA"
.\nssm.exe set QLSA-API DisplayName        "QLSA - He thong Quan ly Suat an"
.\nssm.exe set QLSA-API Description        "Express API + React SPA, ket noi SQL Server 10.70.22.240"
.\nssm.exe set QLSA-API Start              SERVICE_AUTO_START

# Ghi log ra file, tự xoay vòng khi file vượt 10 MB
.\nssm.exe set QLSA-API AppStdout          "C:\QLSA\logs\out.log"
.\nssm.exe set QLSA-API AppStderr          "C:\QLSA\logs\err.log"
.\nssm.exe set QLSA-API AppRotateFiles     1
.\nssm.exe set QLSA-API AppRotateOnline    1
.\nssm.exe set QLSA-API AppRotateBytes     10485760

# Crash thì đợi 5 giây rồi tự khởi động lại
.\nssm.exe set QLSA-API AppExit Default    Restart
.\nssm.exe set QLSA-API AppRestartDelay    5000

# Chờ SQL Server sẵn sàng sau khi máy khởi động
.\nssm.exe set QLSA-API DependOnService     Tcpip

Start-Service QLSA-API
Get-Service QLSA-API
```

Lệnh vận hành hằng ngày:

```powershell
Restart-Service QLSA-API
Stop-Service    QLSA-API
Get-Content C:\QLSA\logs\out.log -Tail 50 -Wait
Get-Content C:\QLSA\logs\err.log -Tail 50
```

### Phương án 2 — Task Scheduler (nếu không được phép mang `nssm.exe` vào)

Hoàn toàn dùng công cụ có sẵn của Windows, không cần tải gì thêm. Nhược điểm: **không tự
restart khi tiến trình crash**, chỉ chạy lại khi server khởi động.

Tạo `C:\QLSA\start.cmd`:

```bat
@echo off
cd /d C:\QLSA
"C:\Program Files\nodejs\node.exe" server\index.js >> C:\QLSA\logs\out.log 2>&1
```

Đăng ký task:

```powershell
schtasks /create /tn "QLSA-API" /tr "C:\QLSA\start.cmd" /sc onstart /ru SYSTEM /rl highest /f
schtasks /run /tn "QLSA-API"
schtasks /query /tn "QLSA-API" /v /fo LIST
```

---

## 7. Cổng truy cập và firewall

### Bước bắt buộc — mở firewall cho cổng 4000

```powershell
New-NetFirewallRule -DisplayName "QLSA API (TCP 4000)" `
  -Direction Inbound -Protocol TCP -LocalPort 4000 `
  -Action Allow -Profile Domain,Private
```

Sau bước này, người dùng truy cập: **`http://10.70.21.97:4000`**

### 7-B. Nếu bắt buộc phải dùng cổng 80 (`http://10.70.21.97`)

Trước tiên kiểm tra cổng 80 có đang bị chiếm không (server đã cài .NET Hosting Bundle nên
IIS nhiều khả năng đang chạy):

```powershell
Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue
Get-WindowsFeature Web-Server
```

**Trường hợp cổng 80 đang trống** → cách đơn giản nhất: sửa `PORT=80` trong `C:\QLSA\.env`,
`Restart-Service QLSA-API`, và mở firewall cổng 80 thay cho 4000. (Trên Windows, cổng < 1024
không cần đặc quyền riêng như Linux, và service chạy dưới `SYSTEM` nên chắc chắn bind được.)

**Trường hợp IIS đang giữ cổng 80** → 2 lựa chọn:

- **Port proxy tích hợp sẵn** (không cần cài thêm gì):
  ```powershell
  netsh interface portproxy add v4tov4 listenport=80 listenaddress=10.70.21.97 `
        connectport=4000 connectaddress=127.0.0.1
  ```
  Đơn giản nhưng không có log HTTP, không hỗ trợ HTTPS.

- **IIS Reverse Proxy (ARR + URL Rewrite)** — chuẩn mực hơn, có log, sau này dễ gắn chứng
  chỉ HTTPS. Cần tải sẵn 2 gói offline: *Application Request Routing 3.0* và *URL Rewrite
  2.1*, cài lên server, bật `Proxy > Enable`, rồi tạo rule rewrite mọi request `(.*)` sang
  `http://localhost:4000/{R:1}`. Việc này phức tạp hơn — chỉ nên làm nếu có yêu cầu HTTPS
  hoặc tên miền nội bộ.

➡️ **Đề xuất giai đoạn đầu: dùng cổng 4000 cho gọn.** Khi hệ thống chạy ổn định mới tính
việc chuyển sang cổng 80/HTTPS.

---

## 8. Nghiệm thu (checklist)

Thực hiện theo đúng thứ tự, tick từng mục:

| # | Hạng mục | Cách kiểm tra | Kết quả mong đợi |
|---|---|---|---|
| 1 | Service đang chạy | `Get-Service QLSA-API` | `Status: Running` |
| 2 | Đang lắng nghe cổng | `Get-NetTCPConnection -LocalPort 4000 -State Listen` | Có 1 dòng, `OwningProcess` là `node` |
| 3 | Kết nối DB thành công | `Get-Content C:\QLSA\logs\out.log -Tail 20` | Có dòng `[db] Đã kết nối 10.70.22.240/QLSA` |
| 4 | API health | `Invoke-RestMethod http://localhost:4000/api/health` | Phản hồi OK, không lỗi |
| 5 | Cấu hình khởi tạo | `Invoke-RestMethod http://localhost:4000/api/bootstrap` | Trả về ca ăn, máy chấm, đơn giá, bộ phận |
| 6 | Dữ liệu chấm ăn thật | `Invoke-RestMethod "http://localhost:4000/api/meal-logs?from=2026-07-01&to=2026-07-31"` | Mảng bản ghi, không rỗng |
| 7 | Frontend tải được | Mở Edge trên server: `http://localhost:4000` | Giao diện React hiện đầy đủ, không lỗi console |
| 8 | Truy cập từ máy khác | Máy trạm bất kỳ: `http://10.70.21.97:4000` | Vào được (nếu không: kiểm tra firewall mục 7) |
| 9 | SPA routing | Bấm chuyển qua lại các tab, rồi **F5 làm mới trang** | Không ra lỗi 404 |
| 10 | Tiếng Việt hiển thị đúng | Xem tên bộ phận, tên ca ăn trên giao diện | Đủ dấu, không bị `?` hay ký tự lạ |
| 11 | Nghiệp vụ ngày công | Đối chiếu một ngày bất kỳ với số liệu đã biết | Khớp — đặc biệt ca CA1 đêm (22:50–01:50 vắt qua nửa đêm) |
| 12 | Ghi dữ liệu | Thêm/sửa 1 bản ghi sữa hoặc ánh xạ bộ phận rồi F5 | Dữ liệu được lưu, còn nguyên sau khi tải lại |
| 13 | **Tự phục hồi sau reboot** | `Restart-Computer`, đợi ~3 phút, mở lại web | Hệ thống tự lên, không cần can thiệp tay |

Mục **13 là quan trọng nhất** — đừng bàn giao khi chưa test reboot thật.

---

## 9. Vận hành

### Cập nhật phiên bản mới

> Quy trình đầy đủ, có cả bước cập nhật procedure SQL và checklist nghiệm thu:
> [REDEPLOY.md](REDEPLOY.md). Phần dưới đây là bản tóm tắt.

```powershell
# 1. Trên máy dev: npm run build, rồi tạo lại gói staging (mục 4)
# 2. Trên server:
Stop-Service QLSA-API
Copy-Item C:\QLSA -Destination "C:\QLSA-backup-$(Get-Date -f yyyyMMdd-HHmm)" -Recurse   # sao lưu
Remove-Item C:\QLSA\dist -Recurse -Force
Expand-Archive -Path "C:\...\QLSA-deploy.zip" -DestinationPath C:\QLSA -Force
Start-Service QLSA-API
Get-Content C:\QLSA\logs\out.log -Tail 20
```

Chỉ cần cài lại `node_modules` khi `package.json` có thay đổi dependency.

### Rollback

```powershell
Stop-Service QLSA-API
Rename-Item C:\QLSA C:\QLSA-failed
Rename-Item "C:\QLSA-backup-<timestamp>" C:\QLSA
Start-Service QLSA-API
```

### Sao lưu

Dữ liệu **nằm hoàn toàn trong SQL Server 10.70.22.240**, không có gì lưu trên server app.
Vì vậy chỉ cần: backup database `QLSA` theo lịch sẵn có của đội DBA. Thư mục `C:\QLSA` chỉ
là mã nguồn đã build — tái tạo lại được từ máy dev bất cứ lúc nào.

### Theo dõi

```powershell
Get-Content C:\QLSA\logs\err.log -Tail 50 -Wait      # theo dõi lỗi thời gian thực
Get-Process node | Select-Object Id, CPU, WS, StartTime
```

Bộ nhớ kỳ vọng ổn định ở mức 150–400 MB. Nếu tăng liên tục không dừng → nghi vấn rò rỉ
connection pool, cần xem lại.

---

## 10. Bảo mật — các điểm cần khắc phục

Các điểm này **không chặn việc deploy**, nhưng nên xử lý ngay sau khi hệ thống chạy ổn:

1. **Đang dùng tài khoản `sa`.** File `.env` chứa mật khẩu `sa` dạng plain-text trên đĩa.
   Nếu server bị xâm nhập, kẻ tấn công có toàn quyền trên cả instance SQL, bao gồm cả
   database `BioStar`. Nên tạo login riêng:

   ```sql
   USE master;
   CREATE LOGIN qlsa_app WITH PASSWORD = '<mật khẩu mạnh>', CHECK_POLICY = ON;
   USE QLSA;
   CREATE USER qlsa_app FOR LOGIN qlsa_app;
   GRANT EXECUTE ON SCHEMA::dbo TO qlsa_app;   -- chỉ quyền chạy stored procedure
   -- Quyền đọc cross-database sang BioStar:
   USE BioStar;
   CREATE USER qlsa_app FOR LOGIN qlsa_app;
   GRANT SELECT ON dbo.TB_EVENT_LOG  TO qlsa_app;
   GRANT SELECT ON dbo.TB_READER     TO qlsa_app;
   GRANT SELECT ON dbo.TB_USER       TO qlsa_app;
   GRANT SELECT ON dbo.TB_USER_DEPT  TO qlsa_app;
   ```
   Sau đó đổi `DB_USER` / `DB_PASSWORD` trong `.env` và restart service.
   *(Cần kiểm chứng bằng test thực tế — nếu ownership chaining được bật, có thể không cần
   cấp `SELECT` trực tiếp trên các bảng BioStar.)*

2. **Giới hạn quyền đọc file `.env`:**
   ```powershell
   icacls C:\QLSA\.env /inheritance:r /grant "SYSTEM:(R)" /grant "Administrators:(F)"
   ```

3. **Không có xác thực người dùng.** Ứng dụng hiện không có đăng nhập — bất kỳ ai trong
   mạng nội bộ truy cập được `http://10.70.21.97:4000` đều xem và **sửa** được dữ liệu
   (các endpoint `POST` / `DELETE` không được bảo vệ). Đây là hạn chế thiết kế, không phải
   lỗi deploy. Biện pháp giảm thiểu tạm thời: giới hạn firewall theo dải IP được phép thay
   vì mở cho toàn mạng:
   ```powershell
   New-NetFirewallRule -DisplayName "QLSA API (TCP 4000)" -Direction Inbound `
     -Protocol TCP -LocalPort 4000 -RemoteAddress 10.70.0.0/16 -Action Allow
   ```

4. **`cors()` đang mở cho mọi origin** (`server/index.js` dòng 29). Trong kiến trúc này
   frontend và API cùng origin nên có thể siết lại hoặc bỏ hẳn middleware `cors`.

5. **Chưa có HTTPS.** Chấp nhận được với mạng LAN nội bộ nhà máy; nếu cần thì làm qua IIS
   reverse proxy (mục 7-B).

---

## 11. Ước lượng thời gian

| Giai đoạn | Thời gian | Ghi chú |
|---|---|---|
| Xác minh điều kiện tiên quyết (mục 3) | 15–30 phút | Có thể phát sinh chờ đội Network mở firewall |
| Chuẩn bị gói trên máy dev (mục 4) | 15 phút | |
| Cài Node.js + giải nén (mục 5.1–5.3) | 15 phút | |
| Chạy thử + xử lý sự cố (mục 5.4) | 15–45 phút | Phụ thuộc EDR có chặn hay không |
| Cài Windows Service (mục 6) | 15 phút | |
| Firewall + nghiệm thu (mục 7–8) | 30 phút | Bao gồm 1 lần reboot thật |
| **Tổng** | **~2–3 giờ** | Nếu firewall 1433 đã thông sẵn |

---

## 12. Tổng hợp những gì cần chuẩn bị trước

- [ ] File cài `node-v22.x.x-x64.msi` (tải sẵn trên máy dev)
- [ ] File `nssm.exe` bản win64 (nếu chọn Phương án 1 ở mục 6)
- [ ] Quyền Administrator trên 10.70.21.97
- [ ] Xác nhận thông mạng 10.70.21.97 → 10.70.22.240:1433
- [ ] Whitelist `C:\QLSA\` và `node.exe` trên AhnLab EPP + SentinelOne
- [ ] Chốt cổng truy cập: 4000 hay 80
- [ ] Chốt tài khoản SQL: giữ `sa` hay tạo `qlsa_app`
- [ ] Cửa sổ thời gian cho 1 lần reboot server để test tự khởi động
