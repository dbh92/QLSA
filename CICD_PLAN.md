# Kế hoạch CI/CD — Hệ thống Quản lý Suất ăn

> Trạng thái: **BẢN THIẾT KẾ — CHƯA THỰC HIỆN**. Không có lệnh nào được chạy, không file
> nào của dự án bị sửa. Chờ phê duyệt.
>
> Tài liệu liên quan: [DEPLOY_WINSERVER2019.md](DEPLOY_WINSERVER2019.md) (triển khai thủ công
> lần đầu — đã hoàn thành, service `QLSA-API` đang chạy).

---

## 0. Điểm chặn số 1: dự án chưa được quản lý phiên bản

Tôi vừa kiểm tra — **thư mục dự án không có `.git`**, chưa có repository nào, chưa có file
cấu hình CI nào.

Không có Git thì **không thể có CI/CD**, vì mọi công cụ CI đều lấy mã nguồn từ một
repository và dùng commit làm đơn vị để build/deploy/rollback. Đây là việc bắt buộc phải
làm trước, không có đường vòng.

Tin tốt: [.gitignore](.gitignore) đã được viết sẵn và **đúng chuẩn** — đã loại trừ
`node_modules/`, `dist/`, và quan trọng nhất là `.env*` (giữ lại `.env.example`). Nghĩa là
mật khẩu SQL sẽ không bị đưa lên repo. Chỉ cần `git init` là dùng được ngay.

---

## 1. Ràng buộc thực tế của môi trường này

Thiết kế CI/CD phải xuất phát từ các ràng buộc sau, không thể bê nguyên mô hình
GitHub Actions + cloud thông thường:

| Ràng buộc | Hệ quả lên thiết kế |
|---|---|
| Server **`WORKGROUP`**, không join domain (xem ảnh System) | Không có Kerberos/AD. Xác thực từ xa qua WinRM rất phiền (phải cấu hình `TrustedHosts`, lưu credential local admin). ➡️ **Chọn mô hình PULL** (runner nằm trên server, tự kéo về) thay vì PUSH từ ngoài vào |
| Server nhiều khả năng **không ra được Internet** | `npm ci` **không chạy được trên server**. ➡️ Phải build ở nơi khác, chỉ chuyển **artifact đã đóng gói** sang |
| **AhnLab EPP + SentinelOne** đang chạy | Binary mới (runner, git.exe) phải được whitelist trước, nếu không sẽ bị chặn im lặng |
| App chạy bằng **NSSM service `QLSA-API`** | Deploy = dừng service → tráo thư mục → khởi động lại. Downtime ~10 giây/lần |
| Layout hiện tại là **thư mục phẳng `C:\QLSA`** | Không rollback được. ➡️ Phải chuyển sang layout `releases\` + junction (mục 4) |
| DB dùng chung với **BioStar** (hệ thống chấm công đang chạy production) | **Tuyệt đối không** để CI tự động chạy script schema lên DB mà không có phê duyệt (mục 8) |
| Chỉ 1 server, không có môi trường staging | Rủi ro cao hơn ➡️ bù lại bằng **health-check gate + auto-rollback** (mục 5) |

---

## 2. So sánh các phương án

| | Hạ tầng cần thêm | Công sức | Ưu | Nhược |
|---|---|---|---|---|
| **A. Script deploy 1 nút bấm** | Không có | ~4 giờ | Làm được ngay, không xin phê duyệt hạ tầng | Phụ thuộc máy dev; không có lịch sử; ai cũng deploy được |
| **B. Gitea + Gitea Actions** ✅ | 1 binary Gitea (~100 MB) + 2 runner | ~2 ngày | Nhẹ, chạy offline hoàn toàn, mô hình pull hợp workgroup, có lịch sử + phân quyền | Phải dựng 1 dịch vụ mới |
| **C. GitLab CE** | VM riêng, ~4 GB RAM | ~3 ngày | Đầy đủ nhất (môi trường, approval, registry) | Nặng, quá mức cần thiết cho 1 app |
| **D. Azure DevOps Server / Jenkins** | Đã có sẵn? | Tùy | Dùng lại hạ tầng công ty | Chỉ hợp lý nếu công ty **đã** vận hành sẵn |

### Khuyến nghị: lộ trình 2 giai đoạn, A → B

Không nhảy thẳng vào B. Giai đoạn A tạo ra **script deploy chuẩn hóa + layout release +
rollback** — đây chính là phần lõi mà giai đoạn B sẽ gọi lại. Làm A trước nghĩa là:

- có ngay giá trị sử dụng sau ~4 giờ,
- khi lên B chỉ còn việc "ai bấm nút" thay đổi, còn logic deploy đã được kiểm chứng thực tế,
- nếu B bị từ chối vì lý do hạ tầng/bảo mật, A vẫn dùng tốt lâu dài.

> **Nếu công ty đã có sẵn GitLab/Azure DevOps nội bộ**, hãy bỏ qua phần dựng Gitea và dùng
> luôn hệ thống đó — phần script deploy ở mục 4–5 giữ nguyên không đổi, chỉ khác file
> định nghĩa pipeline.

---

## 3. Kiến trúc đích

```
   ┌───────────────────────┐        ┌──────────────────────────────────────┐
   │  Máy dev (Windows)    │  git   │  Gitea  (LAN, ví dụ 10.70.21.x:3000) │
   │  D:\11.QLSA\...       │ push   │   repo: qlsa/he-thong-suat-an        │
   └───────────────────────┘ ─────► │   Actions + lưu artifact             │
                                    └───────┬──────────────────┬───────────┘
                                            │ (1) job build    │ (2) job deploy
                                            │ runner "build"   │ runner "prod"
                                            ▼                  ▼
                         ┌──────────────────────┐   ┌────────────────────────────┐
                         │ Máy build (có mạng   │   │  10.70.21.97  (production) │
                         │ npm registry)        │   │  runner chạy LOCAL          │
                         │ npm ci → lint →      │   │  ├ tải artifact             │
                         │ build → đóng gói zip │──►│  ├ giải nén vào releases\   │
                         └──────────────────────┘   │  ├ Stop-Service QLSA-API    │
                              artifact ~15 MB       │  ├ tráo junction "current"  │
                                                    │  ├ Start-Service            │
                                                    │  ├ health-check /api/health │
                                                    │  └ FAIL → tự rollback       │
                                                    └────────────┬───────────────┘
                                                                 │ TCP 1433
                                                                 ▼
                                                    SQL Server 10.70.22.240
                                                    (QLSA + BioStar — KHÔNG đụng tới)
```

**Điểm mấu chốt:** cả 2 runner đều kết nối **outbound** tới Gitea. Không cần mở cổng inbound
vào server production, không cần WinRM, không cần lưu mật khẩu admin ở đâu cả. Đây là lý do
mô hình pull hợp với môi trường workgroup + nhiều tầng firewall như nhà máy.

---

## 4. GIAI ĐOẠN A — Nền tảng deploy (làm trước, ~4 giờ)

### A.1. Đưa dự án vào Git

Trên máy dev:

```powershell
cd "d:\11.QLSA\hệ-thống-quản-lý-và-theo-dõi-suất-ăn"
git init -b main
git add .
git status                       # ⚠️ KIỂM TRA KỸ: .env KHÔNG được xuất hiện trong danh sách
git commit -m "Khởi tạo: hệ thống quản lý và theo dõi suất ăn"
```

**Bắt buộc dừng lại kiểm tra `git status`** trước khi commit. Nếu thấy `.env` trong đó thì
`.gitignore` chưa ăn — phải xử lý ngay, vì một khi mật khẩu `sa` đã vào lịch sử Git thì
xóa đi rất phiền (phải rewrite history + đổi mật khẩu).

Kiểm tra lại cho chắc:

```powershell
git check-ignore -v .env         # phải in ra dòng khớp với .gitignore
git ls-files | Select-String "\.env$"    # phải KHÔNG có kết quả
```

### A.2. Chuyển server sang layout release (một lần duy nhất)

Layout hiện tại là thư mục phẳng, đè lên là mất bản cũ. Layout đích:

```
C:\QLSA\
├── current\              ← junction, trỏ tới 1 thư mục trong releases\
├── releases\
│   ├── 20260807-101500\  ← mỗi lần deploy = 1 thư mục mới
│   ├── 20260807-163000\
│   └── ...               ← giữ 5 bản gần nhất để rollback
├── shared\
│   ├── .env              ← SECRET, chỉ tồn tại trên server, không bao giờ vào Git/artifact
│   ├── last-good.txt     ← tên release đang chạy ổn định
│   └── logs\             ← log dùng chung, không mất khi đổi release
├── deploy\
│   ├── deploy.ps1
│   └── rollback.ps1
└── nssm.exe
```

Các bước chuyển đổi (chạy trên server, PowerShell Administrator):

```powershell
Stop-Service QLSA-API

# 1. Tạo cấu trúc mới
New-Item -ItemType Directory -Force C:\QLSA\releases, C:\QLSA\shared\logs, C:\QLSA\deploy | Out-Null

# 2. Đưa bản đang chạy thành release đầu tiên
$first = "C:\QLSA\releases\20260807-000000-baseline"
New-Item -ItemType Directory -Force $first | Out-Null
Move-Item C:\QLSA\dist, C:\QLSA\server, C:\QLSA\node_modules, C:\QLSA\package.json $first

# 3. Tách .env ra vùng shared (đây là secret, không thuộc về release nào)
Move-Item C:\QLSA\.env C:\QLSA\shared\.env
Copy-Item C:\QLSA\shared\.env $first\.env

# 4. Tạo junction current -> release đầu tiên
cmd /c mklink /J "C:\QLSA\current" "$first"

# 5. Trỏ NSSM sang current + gom log về shared
C:\QLSA\nssm.exe set QLSA-API AppDirectory "C:\QLSA\current"
C:\QLSA\nssm.exe set QLSA-API AppStdout    "C:\QLSA\shared\logs\out.log"
C:\QLSA\nssm.exe set QLSA-API AppStderr    "C:\QLSA\shared\logs\err.log"

Set-Content C:\QLSA\shared\last-good.txt "20260807-000000-baseline" -Encoding ascii

Start-Service QLSA-API
Invoke-RestMethod http://localhost:4000/api/health
```

> ⚠️ **Cảnh báo quan trọng về junction.** Từ nay tuyệt đối **không** dùng
> `Remove-Item C:\QLSA\current -Recurse -Force` — trong PowerShell 5.1 lệnh này có thể đi
> xuyên qua junction và **xóa sạch nội dung thư mục đích**. Chỉ dùng
> `cmd /c rmdir "C:\QLSA\current"` — lệnh này chỉ gỡ liên kết, không đụng tới dữ liệu.
> Script ở mục A.4 đã tuân thủ điều này.

### A.3. Script đóng gói — `deploy/package.ps1` (chạy trên máy build)

File này **commit vào repo**, thư mục `deploy/`.

```powershell
<#
  Build frontend + đóng gói phần runtime thành 1 file zip mang sang server.
  Chạy trên máy dev / máy build (nơi có npm registry).
#>
param(
  [string]$OutFile = "qlsa-package.zip",
  [string]$Version = (Get-Date -Format 'yyyyMMdd-HHmmss')
)
$ErrorActionPreference = 'Stop'
$repo  = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $env:TEMP "qlsa-stage-$Version"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

Write-Host "==> Kiem tra kieu (tsc --noEmit)"
Push-Location $repo
npm run lint
if ($LASTEXITCODE -ne 0) { throw "Loi kieu du lieu - dung build" }

Write-Host "==> Build frontend"
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build that bai" }
Pop-Location

Write-Host "==> Chep artifact"
Copy-Item "$repo\dist"   $stage -Recurse -Force
Copy-Item "$repo\server" $stage -Recurse -Force
Copy-Item "$repo\deploy\package.prod.json" "$stage\package.json" -Force

Write-Host "==> Cai dependencies runtime"
Push-Location $stage
npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install that bai" }
Pop-Location

# Dau vet phien ban - de tra cuu khi co su co
@{
  version   = $Version
  builtAt   = (Get-Date -Format 'o')
  builtOn   = $env:COMPUTERNAME
  gitCommit = (git -C $repo rev-parse --short HEAD 2>$null)
  gitBranch = (git -C $repo rev-parse --abbrev-ref HEAD 2>$null)
} | ConvertTo-Json | Set-Content "$stage\RELEASE.json" -Encoding utf8

# ⚠️ .env KHONG BAO GIO duoc dong goi - no nam o C:\QLSA\shared\.env tren server
if (Test-Path "$stage\.env") { Remove-Item "$stage\.env" -Force }

Write-Host "==> Nen goi"
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $OutFile
Remove-Item $stage -Recurse -Force

Write-Host "==> Xong: $OutFile ($([math]::Round((Get-Item $OutFile).Length/1MB,1)) MB)"
```

Kèm theo, commit file `deploy/package.prod.json` — đây là manifest runtime tối giản
(⚠️ **bắt buộc giữ `"type": "module"`**):

```json
{
  "name": "qlsa-server",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "node server/index.js" },
  "dependencies": {
    "compression": "^1.8.1",
    "cors": "^2.8.6",
    "dotenv": "^17.2.3",
    "express": "^4.21.2",
    "mssql": "^12.7.0"
  }
}
```

### A.4. Script deploy — `deploy/deploy.ps1` (chạy trên server)

Đây là trái tim của toàn bộ hệ thống. Đặt tại `C:\QLSA\deploy\deploy.ps1`, đồng thời
commit vào repo để quản lý phiên bản.

```powershell
<#
  Trien khai 1 artifact zip len server, co health-check va tu dong rollback.
  Chay tren 10.70.21.97 voi quyen Administrator.
  Vi du: .\deploy.ps1 -ArtifactZip C:\temp\qlsa-20260807.zip
#>
param(
  [Parameter(Mandatory)][string]$ArtifactZip,
  [string]$Root         = 'C:\QLSA',
  [string]$ServiceName  = 'QLSA-API',
  [string]$HealthUrl    = 'http://localhost:4000/api/health',
  [int]   $HealthRetries = 20,
  [int]   $HealthDelaySec = 3,
  [int]   $KeepReleases = 5
)
$ErrorActionPreference = 'Stop'

$current  = Join-Path $Root 'current'
$releases = Join-Path $Root 'releases'
$shared   = Join-Path $Root 'shared'
$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$newRel   = Join-Path $releases $stamp

function Test-Health {
  for ($i = 1; $i -le $HealthRetries; $i++) {
    try {
      Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5 -UseBasicParsing | Out-Null
      Write-Host "    health-check OK (lan thu $i)"
      return $true
    } catch {
      Write-Host "    cho ung dung san sang... ($i/$HealthRetries)"
      Start-Sleep -Seconds $HealthDelaySec
    }
  }
  return $false
}

function Set-Current([string]$target) {
  if (Test-Path $current) { cmd /c rmdir "$current" | Out-Null }   # chi go junction
  cmd /c mklink /J "$current" "$target" | Out-Null
}

# --- 0. Kiem tra dau vao ---
if (-not (Test-Path $ArtifactZip)) { throw "Khong tim thay artifact: $ArtifactZip" }
if (-not (Test-Path "$shared\.env")) { throw "Thieu $shared\.env - khong the khoi dong" }

$prevRel = if (Test-Path $current) { (Get-Item $current).Target } else { $null }
Write-Host "==> Release hien tai : $prevRel"
Write-Host "==> Release moi      : $newRel"

# --- 1. Giai nen ra thu muc release moi (chua dong den ban dang chay) ---
Write-Host "==> Giai nen artifact"
New-Item -ItemType Directory -Force $newRel | Out-Null
Expand-Archive -Path $ArtifactZip -DestinationPath $newRel -Force

foreach ($p in @('dist','server','node_modules','package.json')) {
  if (-not (Test-Path (Join-Path $newRel $p))) { throw "Artifact thieu '$p' - huy deploy" }
}

# --- 2. Nap secret tu vung shared ---
Copy-Item "$shared\.env" "$newRel\.env" -Force

# --- 3. Tráo release (downtime bat dau tu day) ---
Write-Host "==> Dung service"
Stop-Service $ServiceName -Force
Start-Sleep -Seconds 2

Write-Host "==> Tro 'current' sang release moi"
Set-Current $newRel

Write-Host "==> Khoi dong service"
Start-Service $ServiceName

# --- 4. Cong kiem tra suc khoe ---
if (Test-Health) {
  Write-Host "==> DEPLOY THANH CONG: $stamp" -ForegroundColor Green
  Set-Content "$shared\last-good.txt" $stamp -Encoding ascii

  # Don dep, giu lai $KeepReleases ban gan nhat
  Get-ChildItem $releases -Directory |
    Sort-Object Name -Descending |
    Select-Object -Skip $KeepReleases |
    ForEach-Object {
      Write-Host "    xoa release cu: $($_.Name)"
      Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  exit 0
}

# --- 5. That bai -> tu dong quay ve ban cu ---
Write-Warning "HEALTH-CHECK THAT BAI - dang rollback ve $prevRel"
Get-Content "$shared\logs\err.log" -Tail 30 -ErrorAction SilentlyContinue

if ($prevRel -and (Test-Path $prevRel)) {
  Stop-Service $ServiceName -Force
  Start-Sleep -Seconds 2
  Set-Current $prevRel
  Start-Service $ServiceName
  if (Test-Health) {
    Write-Warning "Da rollback thanh cong ve ban cu. Deploy that bai."
  } else {
    Write-Error  "NGHIEM TRONG: rollback cung that bai. Can xu ly thu cong ngay."
  }
} else {
  Write-Error "Khong co release truoc do de rollback."
}
exit 1
```

### A.5. Script rollback thủ công — `deploy/rollback.ps1`

```powershell
<#
  Quay ve mot release cu bat ky.
  .\rollback.ps1                          -> ve ban truoc do
  .\rollback.ps1 -Release 20260807-101500 -> ve dung ban chi dinh
#>
param(
  [string]$Release,
  [string]$Root = 'C:\QLSA',
  [string]$ServiceName = 'QLSA-API',
  [string]$HealthUrl = 'http://localhost:4000/api/health'
)
$ErrorActionPreference = 'Stop'
$releases = Join-Path $Root 'releases'
$current  = Join-Path $Root 'current'

$all = Get-ChildItem $releases -Directory | Sort-Object Name -Descending
if (-not $Release) {
  $cur = if (Test-Path $current) { Split-Path (Get-Item $current).Target -Leaf } else { $null }
  $Release = ($all | Where-Object Name -ne $cur | Select-Object -First 1).Name
}
$target = Join-Path $releases $Release
if (-not (Test-Path $target)) {
  Write-Host "Cac release co san:"; $all | ForEach-Object { "  $($_.Name)" }
  throw "Khong tim thay release: $Release"
}

Write-Host "==> Rollback ve $Release"
Stop-Service $ServiceName -Force
Start-Sleep -Seconds 2
if (Test-Path $current) { cmd /c rmdir "$current" | Out-Null }
cmd /c mklink /J "$current" "$target" | Out-Null
Start-Service $ServiceName

for ($i=1; $i -le 20; $i++) {
  try { Invoke-RestMethod $HealthUrl -TimeoutSec 5 -UseBasicParsing | Out-Null
        Write-Host "==> Rollback OK: $Release" -ForegroundColor Green; exit 0 }
  catch { Start-Sleep 3 }
}
Write-Error "Rollback xong nhung health-check that bai - kiem tra log ngay."
exit 1
```

### A.6. Quy trình vận hành ở giai đoạn A

```powershell
# Trên máy dev
cd "d:\11.QLSA\hệ-thống-quản-lý-và-theo-dõi-suất-ăn"
git pull ; .\deploy\package.ps1 -OutFile "C:\temp\qlsa.zip"

# Chép C:\temp\qlsa.zip sang server (RDP copy-paste / share / USB), rồi trên server:
C:\QLSA\deploy\deploy.ps1 -ArtifactZip C:\temp\qlsa.zip
```

Từ thời điểm này, mục 9 "Cập nhật phiên bản mới" trong
[DEPLOY_WINSERVER2019.md](DEPLOY_WINSERVER2019.md) **không dùng nữa** — nó thay bằng
`deploy.ps1`, an toàn hơn hẳn vì có health-check và tự rollback.

---

## 5. GIAI ĐOẠN B — Tự động hóa bằng Gitea Actions (~2 ngày)

### B.1. Dựng Gitea

Gitea là **một file `.exe` duy nhất** kèm SQLite, không cần cài database riêng, chạy offline
hoàn toàn. Tải `gitea-<ver>-windows-4.0-amd64.exe` từ <https://dl.gitea.com/gitea/> trên máy
có Internet, mang vào LAN.

**Đặt Gitea ở đâu?** Ưu tiên một VM khác — không nên đặt CI server chung với app production
(chung số phận khi có sự cố, và mở rộng bề mặt tấn công của máy prod). Nếu không có VM nào
khác thì đặt tạm trên 10.70.21.97 cũng chấp nhận được (256 GB RAM còn rất dư), nhưng phải
ghi nhận đây là món nợ kỹ thuật cần trả sau.

```powershell
New-Item -ItemType Directory -Force C:\gitea\custom | Out-Null
# đặt gitea.exe vào C:\gitea\, rồi đăng ký service:
C:\QLSA\nssm.exe install Gitea "C:\gitea\gitea.exe" "web"
C:\QLSA\nssm.exe set Gitea AppDirectory "C:\gitea"
C:\QLSA\nssm.exe set Gitea AppEnvironmentExtra "GITEA_WORK_DIR=C:\gitea"
Start-Service Gitea
New-NetFirewallRule -DisplayName "Gitea (TCP 3000)" -Direction Inbound `
  -Protocol TCP -LocalPort 3000 -RemoteAddress 10.70.0.0/16 -Action Allow
```

Mở `http://<ip>:3000` để chạy trình cài đặt lần đầu (chọn SQLite), tạo tài khoản quản trị,
tạo tổ chức `qlsa` và repository `he-thong-suat-an`. **Bật Actions** trong
`C:\gitea\custom\conf\app.ini`:

```ini
[actions]
ENABLED = true
```

Đẩy mã nguồn lên:

```powershell
cd "d:\11.QLSA\hệ-thống-quản-lý-và-theo-dõi-suất-ăn"
git remote add origin http://<ip-gitea>:3000/qlsa/he-thong-suat-an.git
git push -u origin main
```

### B.2. Cài 2 runner

Tải `act_runner-<ver>-windows-amd64.exe` từ <https://dl.gitea.com/act_runner/>.

**Runner 1 — "build"**, đặt trên máy dev hoặc máy build (nơi truy cập được npm registry):

```powershell
.\act_runner.exe register --no-interactive `
  --instance http://<ip-gitea>:3000 `
  --token <token lấy từ Gitea: Site Admin → Actions → Runners → Create> `
  --name build-agent --labels build
```

**Runner 2 — "prod"**, đặt trên 10.70.21.97, đăng ký làm Windows service:

```powershell
New-Item -ItemType Directory -Force C:\actions-runner | Out-Null
cd C:\actions-runner
.\act_runner.exe register --no-interactive `
  --instance http://<ip-gitea>:3000 --token <token> `
  --name prod-agent --labels prod

C:\QLSA\nssm.exe install GiteaRunner "C:\actions-runner\act_runner.exe" "daemon"
C:\QLSA\nssm.exe set GiteaRunner AppDirectory "C:\actions-runner"
C:\QLSA\nssm.exe set GiteaRunner ObjectName ".\svc_deploy" "<mật khẩu>"
Start-Service GiteaRunner
```

Runner `prod` cần quyền `Stop-Service` / `Start-Service` trên `QLSA-API` và quyền ghi vào
`C:\QLSA`. Xem mục 7 để cấp quyền tối thiểu thay vì cho hẳn Administrator.

Cả 2 runner đều kết nối **outbound** tới Gitea — không cần mở cổng inbound nào trên server
production.

### B.3. Workflow — `.github/workflows/deploy.yml`

Gitea Actions dùng cú pháp tương thích GitHub Actions và đọc cả `.github/workflows/`.

```yaml
name: Build & Deploy Production

# Chỉ deploy khi gắn tag phiên bản -> tag chính là "cổng phê duyệt"
on:
  push:
    tags: ['v*']
  workflow_dispatch:        # cho phép bấm tay từ giao diện Gitea

jobs:
  build:
    runs-on: build
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Cài dependencies
        run: npm ci

      - name: Kiểm tra kiểu dữ liệu
        run: npm run lint

      - name: Build + đóng gói
        shell: powershell
        run: .\deploy\package.ps1 -OutFile "qlsa-${{ github.ref_name }}.zip" -Version "${{ github.ref_name }}"

      - uses: actions/upload-artifact@v4
        with:
          name: qlsa-package
          path: qlsa-*.zip
          retention-days: 30

  deploy:
    needs: build
    runs-on: prod
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: qlsa-package
          path: C:\temp\qlsa-deploy

      - name: Triển khai (có health-check + auto-rollback)
        shell: powershell
        run: |
          $zip = (Get-ChildItem C:\temp\qlsa-deploy\qlsa-*.zip | Select-Object -First 1).FullName
          C:\QLSA\deploy\deploy.ps1 -ArtifactZip $zip

      - name: Kiểm tra sau triển khai
        shell: powershell
        run: |
          $r = Invoke-RestMethod http://localhost:4000/api/bootstrap -TimeoutSec 20
          if (-not $r) { throw "Bootstrap tra ve rong" }
          Write-Host "Bootstrap OK"
```

### B.4. Quy trình phát hành hằng ngày

```powershell
# Sửa code → commit → đẩy lên
git add . ; git commit -m "Sửa cách tính ca CA1 vắt qua nửa đêm" ; git push

# Phát hành: gắn tag
git tag v1.2.0 ; git push origin v1.2.0
# → CI tự động: lint → build → đóng gói → deploy → health-check → (fail thì tự rollback)
```

Chỉ commit lên `main` mà không gắn tag thì **không deploy** — đây là cơ chế kiểm soát đơn
giản nhưng hiệu quả, tránh việc mọi commit đều đẩy thẳng ra production.

> **Lưu ý về "approval gate":** Gitea Actions **chưa hỗ trợ đầy đủ** cơ chế
> `environment` + phê duyệt thủ công như GitHub Actions bản thương mại. Vì vậy ở đây tôi
> dùng **tag** làm cổng kiểm soát, kết hợp với branch protection để giới hạn ai được đẩy
> tag. Nếu bắt buộc phải có phê duyệt 2 người, phải chuyển sang GitLab CE hoặc
> Azure DevOps Server (phương án C/D).

---

## 6. Thay đổi schema database — xử lý riêng, KHÔNG tự động

Đây là điểm cần thận trọng nhất của toàn bộ hệ thống.

Ba script trong [db/](db/) được viết idempotent (chạy lại nhiều lần được), nên **về mặt kỹ
thuật** hoàn toàn có thể để CI tự chạy qua `sqlcmd`. Nhưng tôi **khuyến nghị không làm vậy**,
vì:

- Database `QLSA` nằm cùng instance với `BioStar` — hệ thống chấm công **đang chạy
  production**. Một script lỗi có thể ảnh hưởng ngoài phạm vi ứng dụng suất ăn.
- Không có môi trường staging để thử trước.
- Rollback code chỉ mất 10 giây (tráo junction); rollback schema thì **không có đường lùi
  tự động** — phải restore backup.

➡️ **Quy trình đề xuất cho thay đổi schema:**

1. Script schema vẫn được commit vào repo (`db/`) để có lịch sử thay đổi — đây là giá trị
   lớn mà hiện tại đang thiếu.
2. CI **chỉ kiểm tra cú pháp**, không thực thi:
   ```powershell
   sqlcmd -S 10.70.22.240 -d QLSA -U ... -P ... -C -I -f 65001 -b -i db\03_procedures.sql -N
   ```
   Nếu muốn kiểm tra sâu hơn, dựng một DB `QLSA_ci` riêng để chạy thử.
3. DBA **chạy tay** trên production, có backup trước, trong khung giờ bảo trì.
4. Sau khi schema xong mới gắn tag để CI deploy code.

Khi nào nên tự động hóa cả schema: khi đã có môi trường staging riêng và đã dùng công cụ
migration có đánh version (ví dụ Flyway, DbUp).

---

## 7. Bảo mật — những điều bắt buộc phải cân nhắc

Đây là phần tôi muốn nói thẳng: **CI/CD làm tăng rủi ro bảo mật**, và điều đó cần được
quyết định có ý thức chứ không phải phát hiện ra sau khi có sự cố.

### 7.1. Runner trên production là một đường thực thi mã từ xa

Bất kỳ ai đẩy được file `.github/workflows/*.yml` lên repo đều **chạy được lệnh tùy ý trên
server production** dưới tài khoản của runner. Đây là bản chất của mọi hệ thống CI, không
phải lỗi thiết kế — nhưng phải được kiểm soát:

- Bật **branch protection** cho `main`: bắt buộc pull request, không cho push thẳng.
- Giới hạn quyền đẩy tag `v*` cho một nhóm nhỏ.
- Thay đổi trong thư mục `.github/workflows/` và `deploy/` phải được review.

### 7.2. Cấp quyền tối thiểu cho tài khoản runner

Đừng cho runner làm Administrator. Tạo tài khoản local `svc_deploy` và chỉ cấp:

- Toàn quyền trên `C:\QLSA\releases`, `C:\QLSA\current`, `C:\QLSA\shared\logs`
- **Chỉ đọc** `C:\QLSA\shared\.env`
- Quyền start/stop **riêng service `QLSA-API`** (không phải mọi service):
  ```powershell
  # Xem SDDL hiện tại
  sc.exe sdshow QLSA-API
  # Thêm quyền RPWPDT (start/stop/pause) cho svc_deploy vào chuỗi SDDL rồi:
  # sc.exe sdset QLSA-API "<chuỗi SDDL đã sửa>"
  ```
  ⚠️ Đặt SDDL sai có thể khiến chính Administrator mất quyền quản lý service. **Ghi lại
  chuỗi gốc từ `sdshow` trước khi sửa**, và thử trên máy test trước.

### 7.3. Secret không bao giờ rời khỏi server

`.env` chỉ tồn tại tại `C:\QLSA\shared\.env`. Không có trong Git (đã được `.gitignore`
chặn), không có trong artifact (`package.ps1` chủ động xóa), không có trong biến CI.
Deploy script nạp nó vào release khi triển khai. Đây là mô hình đúng.

Việc đổi từ `sa` sang login riêng `qlsa_app` (mục 10 tài liệu deploy) càng quan trọng hơn
khi có CI, vì số người/hệ thống chạm được vào server đã tăng lên.

### 7.4. EDR

`act_runner.exe`, `gitea.exe`, `git.exe` và `node.exe` đều cần được whitelist trên AhnLab
EPP và SentinelOne. Nếu bỏ qua, triệu chứng sẽ là job CI treo hoặc thất bại không rõ lý do —
rất mất thời gian chẩn đoán.

---

## 8. Những việc nên làm kèm (không bắt buộc)

| Việc | Lý do | Công sức |
|---|---|---|
| Gỡ `@google/genai` khỏi `package.json` | Không dòng code nào dùng (tôi đã grep toàn bộ `src/` + `server/`). Giảm thời gian `npm ci` và bề mặt phụ thuộc | 5 phút |
| Gỡ `vite` khỏi `dependencies` | Đang bị khai báo trùng ở cả `dependencies` lẫn `devDependencies` — thừa | 5 phút |
| Thêm phiên bản vào `/api/health` | Hiện `/api/health` không cho biết đang chạy bản nào. Trả kèm nội dung `RELEASE.json` sẽ giúp xác minh deploy đúng bản | 30 phút |
| Webhook thông báo sang Teams/email | Biết ngay khi deploy fail thay vì đợi người dùng báo | 1 giờ |
| Smoke test tự động sau deploy | Gọi thử vài endpoint chính, đối chiếu số bản ghi | 2 giờ |
| Zero-downtime thật sự | Hiện mỗi lần deploy mất ~10 giây. Muốn 0 giây phải chạy 2 instance + IIS ARR đổi upstream. **Với ứng dụng nội bộ, 10 giây là chấp nhận được** — chỉ làm nếu thực sự có yêu cầu | 1 ngày |

---

## 9. Ước lượng công sức

| Giai đoạn | Hạng mục | Thời gian |
|---|---|---|
| **A** | `git init` + đẩy lên repo | 30 phút |
| **A** | Chuyển server sang layout release | 1 giờ |
| **A** | Viết + kiểm thử `package.ps1`, `deploy.ps1`, `rollback.ps1` | 2 giờ |
| **A** | Diễn tập deploy + **diễn tập rollback thật** | 1 giờ |
| | **Cộng giai đoạn A** | **~4–5 giờ** |
| **B** | Dựng Gitea + cấu hình repo | 3 giờ |
| **B** | Cài + đăng ký 2 runner | 2 giờ |
| **B** | Viết workflow + chạy thử end-to-end | 3 giờ |
| **B** | Cấp quyền tối thiểu + whitelist EDR | 2 giờ |
| **B** | Tài liệu + bàn giao | 2 giờ |
| | **Cộng giai đoạn B** | **~1,5–2 ngày** |

---

## 10. Các điểm cần anh/chị quyết định

| # | Câu hỏi | Đề xuất của tôi |
|---|---|---|
| 1 | Công ty **đã có sẵn** GitLab / Azure DevOps / Jenkins nội bộ chưa? | Nếu có → dùng lại, bỏ qua phần dựng Gitea. Phần script deploy giữ nguyên |
| 2 | Làm giai đoạn A trước, hay nhảy thẳng vào B? | **Làm A trước.** A tạo ra phần lõi mà B sẽ gọi lại, và có giá trị dùng ngay |
| 3 | Đặt Gitea ở đâu? | Ưu tiên VM riêng. Nếu không có, tạm đặt trên 10.70.21.97 và ghi nhận là nợ kỹ thuật |
| 4 | Máy build đặt ở đâu? | Máy dev hiện tại là đủ, miễn là truy cập được npm registry |
| 5 | Có chấp nhận downtime ~10 giây mỗi lần deploy? | Với app nội bộ thì có. Nếu không, cần thêm ~1 ngày cho blue-green |
| 6 | Ai được phép phát hành (đẩy tag `v*`)? | Cần chốt danh sách trước khi bật branch protection |
| 7 | Có chấp nhận đặt runner có quyền admin hạn chế trên máy production? | Đây là đánh đổi bắt buộc của mọi CI/CD. Giảm thiểu bằng mục 7.2 |
| 8 | Schema database: tự động hay thủ công? | **Thủ công có phê duyệt** (mục 6), ít nhất cho tới khi có staging |

---

## 11. Checklist chuẩn bị

- [ ] Chốt phương án ở mục 10
- [ ] Cài Git for Windows trên máy dev (nếu chưa có)
- [ ] Tải sẵn (offline): `gitea.exe`, `act_runner.exe`
- [ ] Xin cấp VM cho Gitea (nếu chọn phương án tách riêng)
- [ ] Tạo tài khoản local `svc_deploy` trên 10.70.21.97
- [ ] Đăng ký whitelist EDR: `act_runner.exe`, `gitea.exe`, `git.exe`
- [ ] Chốt khung giờ bảo trì để chuyển layout release (có ~1 phút downtime)
- [ ] **Diễn tập rollback thật ít nhất 1 lần trước khi bàn giao** — chưa test rollback thì
      coi như chưa có rollback
