/* ===========================================================================
   TRIỂN KHAI: KỲ TÍNH CHI PHÍ THEO THÁNG (2026-10-13)

   Chạy trên [QLSA]:
       sqlcmd -S <server> -U sa -P <pwd> -d QLSA -f 65001 -I ^
              -i _deploy_cost_month_period_2026-10-13.sql

   Vì sao là script riêng chứ không chạy lại db/03_procedures.sql: file đó drop
   TOÀN BỘ procedure/view/function SA_* rồi tạo lại, nên bất kỳ bản sửa tay nào
   trên máy chủ cũng mất. Script này chỉ đụng tới:

     1. Bảng mới SA_CostMonthPeriod + kiểu bảng SA_CostMonthPeriodList.
     2. Hàm mới SA_CostMonthPeriodOf, hai procedure mới SA_CostMonthPeriod_Get
        / _Save.
     3. SA_MealCost_GetMonthly — tạo lại: xếp mọi cột vào tháng theo KỲ của
        SA_CostMonthPeriodOf thay vì theo tháng lịch, và trả thêm hai cột
        fromDateTime / toDateTime. Bản đang chạy trước khi deploy được lưu ở
        _backup_SA_MealCost_GetMonthly_2026-10-13.sql (chạy file đó để quay
        lại). Bản mới cũng mang theo sửa đổi `mmd` đã có trong repo nhưng chưa
        từng deploy: suất nhập tay CA1 đối chiếu sinh nhật theo ngày ca BẮT
        ĐẦU (EntryDate - 1), khớp `classifyManualEntries` ở client.

   CHƯA CÀI KỲ NÀO THÌ MỖI THÁNG LÀ KỲ CHỐT SỐ CỦA NHÀ ĂN: 25 tháng trước
   22:50 -> 25 tháng này 22:50, gọi theo tháng kết thúc kỳ — tháng 01/2026 =
   25/12/2025 22:50 -> 25/01/2026 22:50.

   Script chạy lại được nhiều lần. Nội dung chép nguyên từ db/01_schema.sql
   (mục 18) và db/03_procedures.sql — nguồn sự thật vẫn là hai file đó.
   =========================================================================== */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

PRINT '--- 1. Bảng + kiểu bảng kỳ tính chi phí ---';
GO

/* ---------------------------------------------------------------------------
   18. SA_CostMonthPeriod — KỲ TÍNH CHI PHÍ của từng tháng trong bảng 12 tháng

   Nhà ăn không chốt số theo tháng lịch: một "tháng" của bảng kê thường là
   25 lúc 22:50 -> 25 tháng sau lúc 22:50 (ngày làm việc 26 -> 25). Bảng này
   cho mỗi (năm, tháng) một khoảng thời điểm NỬA MỞ [FromDateTime, ToDateTime)
   và SA_MealCost_GetMonthly xếp mọi thứ vào tháng theo khoảng đó — lượt
   quẹt, suất nhập tay, sữa, chi phí phát sinh — còn chi phí nhân công thì
   client cắt theo đúng hai mốc này (`withLaborCost`).

   Tháng KHÔNG có dòng ở đây dùng kỳ mặc định — kỳ chốt số của nhà ăn: 25
   tháng trước 22:50 -> 25 tháng này 22:50, gọi theo tháng KẾT THÚC kỳ
   (tháng 01/2026 = 25/12/2025 22:50 -> 25/01/2026 22:50). Quy tắc mặc định
   đó nằm ở đúng một chỗ: hàm dbo.SA_CostMonthPeriodOf trong
   03_procedures.sql.

   Một năm được lưu NGUYÊN KHỐI (đủ 12 tháng, hoặc không tháng nào): trộn kỳ
   tự đặt của tháng này với kỳ mặc định của tháng bên cạnh là hai kỳ chồng
   lên nhau và một lượt quẹt bị tính hai lần. SA_CostMonthPeriod_Save kiểm
   điều đó và kiểm cả việc các kỳ trong năm không giao nhau.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_CostMonthPeriod', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_CostMonthPeriod
    (
        CostYear     int           NOT NULL,
        MonthNo      int           NOT NULL,
        FromDateTime datetime2(0)  NOT NULL,
        ToDateTime   datetime2(0)  NOT NULL,
        UpdatedAt    datetime2(0)  NOT NULL CONSTRAINT DF_SA_CostMonthPeriod_Updated DEFAULT (SYSDATETIME()),
        UpdatedBy    nvarchar(128) NULL,
        CONSTRAINT PK_SA_CostMonthPeriod PRIMARY KEY CLUSTERED (CostYear, MonthNo),
        CONSTRAINT CK_SA_CostMonthPeriod_Month CHECK (MonthNo BETWEEN 1 AND 12),
        CONSTRAINT CK_SA_CostMonthPeriod_Range CHECK (ToDateTime > FromDateTime)
    );
END
GO

/* Kiểu bảng để gửi cả 12 kỳ của một năm trong MỘT lần lưu — cùng lý do với
   SA_EventIdList: tạo ở đây vì 03_procedures.sql drop/tạo lại procedure, mà
   kiểu đang được procedure dùng thì không drop được.

   Hai mốc là CHUỖI 'YYYY-MM-DD HH:mm:ss' chứ không phải datetime2: thời điểm
   đi qua dây dưới dạng chuỗi ở cả hệ thống này (bind Date của JS là lệch múi
   giờ). SA_CostMonthPeriod_Save tự đổi sang datetime2 bằng style 120. */
IF TYPE_ID('dbo.SA_CostMonthPeriodList') IS NULL
BEGIN
    CREATE TYPE dbo.SA_CostMonthPeriodList AS TABLE
    (
        MonthNo      int         NOT NULL PRIMARY KEY,
        FromDateTime varchar(19) NOT NULL,
        ToDateTime   varchar(19) NOT NULL
    );
END
GO

PRINT '--- 2. Hàm + procedure kỳ tính chi phí, SA_MealCost_GetMonthly ---';
GO

IF OBJECT_ID('dbo.SA_CostMonthPeriod_Save', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_CostMonthPeriod_Save;
IF OBJECT_ID('dbo.SA_CostMonthPeriod_Get', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_CostMonthPeriod_Get;
IF OBJECT_ID('dbo.SA_MealCost_GetMonthly', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_MealCost_GetMonthly;
IF OBJECT_ID('dbo.SA_CostMonthPeriodOf', 'IF') IS NOT NULL DROP FUNCTION dbo.SA_CostMonthPeriodOf;
GO

/* ===========================================================================
   SA_CostMonthPeriodOf — KỲ TÍNH CHI PHÍ của 12 tháng trong một năm.

   NGUỒN DUY NHẤT của câu hỏi "tháng M gồm những thời điểm nào": tháng có dòng
   trong SA_CostMonthPeriod lấy đúng dòng đó, tháng không có dòng lấy kỳ MẶC
   ĐỊNH = kỳ chốt số của nhà ăn, 25 tháng trước 22:50 -> 25 tháng này 22:50
   (ngày làm việc 26 -> 25). Tháng được gọi theo tháng KẾT THÚC kỳ: tháng
   01/2026 = 25/12/2025 22:50 -> 25/01/2026 22:50. 22:50 là giờ bắt đầu của
   ca vắt qua nửa đêm (SA_Shift.WrapsMidnight), cùng mốc ngày làm việc với
   mọi bộ lọc ở client.

   Khoảng là NỬA MỞ [FromDateTime, ToDateTime): hai tháng nối tiếp nhau chung
   một mốc mà không thời điểm nào thuộc về cả hai.

   SA_CostMonthPeriod_Get (màn hình cài đặt) và SA_MealCost_GetMonthly (bảng
   12 tháng) đều đọc hàm này, nên kỳ người dùng nhìn thấy và kỳ mà tiền được
   tính theo không thể là hai thứ khác nhau.
   =========================================================================== */
CREATE FUNCTION dbo.SA_CostMonthPeriodOf (@Year int)
RETURNS TABLE
AS
RETURN
    SELECT  m.n                                                         AS MonthNo,
            CONVERT(char(4), @Year) + '-' + RIGHT('0' + CONVERT(varchar(2), m.n), 2)
                                                                        AS CostMonth,
            ISNULL(p.FromDateTime,
                   DATEADD(SECOND, ws.StartSec,
                           CAST(DATEADD(MONTH, -1, DATEFROMPARTS(@Year, m.n, 25)) AS datetime2(0))))
                                                                        AS FromDateTime,
            ISNULL(p.ToDateTime,
                   DATEADD(SECOND, ws.StartSec,
                           CAST(DATEFROMPARTS(@Year, m.n, 25) AS datetime2(0))))
                                                                        AS ToDateTime,
            CAST(CASE WHEN p.MonthNo IS NULL THEN 0 ELSE 1 END AS bit)  AS IsCustom
    FROM (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12)) AS m(n)
    CROSS JOIN (
        SELECT DATEDIFF(SECOND, CAST('00:00:00' AS time(0)),
                        ISNULL((SELECT TOP (1) s.StartTime
                                FROM dbo.SA_Shift s
                                WHERE s.WrapsMidnight = 1 AND s.IsActive = 1
                                ORDER BY s.SortOrder),
                               CAST('22:50:00' AS time(0)))) AS StartSec
    ) ws
    LEFT JOIN dbo.SA_CostMonthPeriod p
           ON p.CostYear = @Year AND p.MonthNo = m.n;
GO

/* Kỳ tính chi phí của 12 tháng — cho màn hình cài đặt ở tab Xu hướng năm. */
CREATE PROCEDURE dbo.SA_CostMonthPeriod_Get
    @Year int
AS
BEGIN
    SET NOCOUNT ON;

    IF @Year IS NULL OR @Year < 2000 OR @Year > 2999
    BEGIN
        RAISERROR (N'Năm không hợp lệ.', 16, 1);
        RETURN;
    END

    SELECT  MonthNo                                     AS monthNo,
            CostMonth                                   AS costMonth,
            CONVERT(char(19), FromDateTime, 120)        AS fromDateTime,
            CONVERT(char(19), ToDateTime, 120)          AS toDateTime,
            IsCustom                                    AS isCustom
    FROM dbo.SA_CostMonthPeriodOf(@Year)
    ORDER BY MonthNo;
END
GO

/* ===========================================================================
   SA_CostMonthPeriod_Save — Lưu kỳ tính chi phí của CẢ MỘT NĂM.

   Nhận đúng 12 dòng (thay toàn bộ kỳ của năm) hoặc 0 dòng (xoá hết, cả năm
   quay về kỳ mặc định). Lưu lẻ một tháng là không được: kỳ tự đặt của tháng
   này sẽ chồng lên kỳ mặc định của tháng bên cạnh và lượt quẹt nằm ở phần
   chồng bị tính vào cả hai tháng.

   Kiểm thêm, vì một con số gõ nhầm ở đây đổi cả bảng 12 tháng:
     - Mỗi kỳ dài không quá 62 ngày, và bắt đầu trong vòng 45 ngày quanh mùng
       1 của chính tháng đó — gõ nhầm năm thì báo lỗi chứ không lặng lẽ tính.
     - Hai kỳ bất kỳ trong năm không giao nhau (nửa mở: a.From < b.To AND
       b.From < a.To). Liền nhau thì được, hở nhau cũng được — khoảng hở chỉ
       là thời gian không thuộc tháng nào và màn hình cài đặt nói ra điều đó.
   =========================================================================== */
CREATE PROCEDURE dbo.SA_CostMonthPeriod_Save
    @Year     int,
    @Periods  dbo.SA_CostMonthPeriodList READONLY,
    @UserName nvarchar(128) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @Year IS NULL OR @Year < 2000 OR @Year > 2999
    BEGIN
        RAISERROR (N'Năm không hợp lệ.', 16, 1);
        RETURN;
    END

    DECLARE @P TABLE
    (
        MonthNo      int          NOT NULL PRIMARY KEY,
        FromDateTime datetime2(0) NULL,
        ToDateTime   datetime2(0) NULL
    );
    INSERT INTO @P (MonthNo, FromDateTime, ToDateTime)
    SELECT MonthNo,
           TRY_CONVERT(datetime2(0), FromDateTime, 120),
           TRY_CONVERT(datetime2(0), ToDateTime, 120)
    FROM @Periods;

    DECLARE @n int = (SELECT COUNT(*) FROM @P);
    IF @n NOT IN (0, 12)
    BEGIN
        RAISERROR (N'Phải lưu đủ 12 tháng của năm (hoặc không tháng nào để quay về kỳ mặc định).', 16, 1);
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM @P WHERE MonthNo NOT BETWEEN 1 AND 12)
    BEGIN
        RAISERROR (N'Tháng phải từ 1 đến 12.', 16, 1);
        RETURN;
    END

    DECLARE @bad nvarchar(400);

    SELECT TOP (1) @bad = N'Tháng ' + CONVERT(nvarchar(2), MonthNo)
                        + N': thời điểm không hợp lệ.'
    FROM @P
    WHERE FromDateTime IS NULL OR ToDateTime IS NULL
    ORDER BY MonthNo;
    IF @bad IS NOT NULL BEGIN RAISERROR (@bad, 16, 1); RETURN; END

    SELECT TOP (1) @bad = N'Tháng ' + CONVERT(nvarchar(2), MonthNo)
                        + N': thời điểm kết thúc phải sau thời điểm bắt đầu.'
    FROM @P
    WHERE ToDateTime <= FromDateTime
    ORDER BY MonthNo;
    IF @bad IS NOT NULL BEGIN RAISERROR (@bad, 16, 1); RETURN; END

    SELECT TOP (1) @bad = N'Tháng ' + CONVERT(nvarchar(2), MonthNo)
                        + N': một kỳ không được dài quá 62 ngày.'
    FROM @P
    WHERE DATEDIFF(SECOND, FromDateTime, ToDateTime) > 62 * 86400
    ORDER BY MonthNo;
    IF @bad IS NOT NULL BEGIN RAISERROR (@bad, 16, 1); RETURN; END

    SELECT TOP (1) @bad = N'Tháng ' + CONVERT(nvarchar(2), MonthNo)
                        + N'/' + CONVERT(nvarchar(4), @Year)
                        + N': ngày bắt đầu lệch quá xa tháng đó — kiểm tra lại năm.'
    FROM @P
    WHERE ABS(DATEDIFF(DAY, DATEFROMPARTS(@Year, MonthNo, 1), FromDateTime)) > 45
    ORDER BY MonthNo;
    IF @bad IS NOT NULL BEGIN RAISERROR (@bad, 16, 1); RETURN; END

    SELECT TOP (1) @bad = N'Kỳ của tháng ' + CONVERT(nvarchar(2), a.MonthNo)
                        + N' và tháng ' + CONVERT(nvarchar(2), b.MonthNo)
                        + N' chồng lên nhau — một lượt quẹt sẽ bị tính vào cả hai tháng.'
    FROM @P a
    INNER JOIN @P b
            ON b.MonthNo > a.MonthNo
           AND a.FromDateTime < b.ToDateTime
           AND b.FromDateTime < a.ToDateTime
    ORDER BY a.MonthNo, b.MonthNo;
    IF @bad IS NOT NULL BEGIN RAISERROR (@bad, 16, 1); RETURN; END

    BEGIN TRANSACTION;

    DELETE FROM dbo.SA_CostMonthPeriod WHERE CostYear = @Year;

    INSERT INTO dbo.SA_CostMonthPeriod (CostYear, MonthNo, FromDateTime, ToDateTime, UpdatedBy)
    SELECT @Year, MonthNo, FromDateTime, ToDateTime, @UserName
    FROM @P;

    COMMIT TRANSACTION;

    EXEC dbo.SA_CostMonthPeriod_Get @Year = @Year;
END
GO

/* ===========================================================================
   SA_MealCost_GetMonthly — Chi phí suất ăn theo TỪNG THÁNG của một năm.

   Dùng cho biểu đồ "Xu Hướng Năm". Phải tổng hợp tại SQL Server vì một năm
   là ~600.000 lượt quẹt — không thể kéo hết về trình duyệt như màn hình khác.

   Quy tắc phân loại suất (giống hệt classifyMeal trong src/services/mealEngine.ts):
     - Loại suất của mỗi (ca, nhóm nhân sự) lấy từ SA_ShiftMealCategory, do
       người dùng gán trong tab "Cấu Hình Giá Suất Ăn".
     - Nhóm nhân sự: 'KR' nếu quẹt máy CT Korea HOẶC thuộc bộ phận lớn KR,
       ngược lại 'VN'.
     - Người Việt quẹt vào CA ĂN SINH NHẬT của ngày sinh nhật tập thể -> suất
       đặc biệt (SUAT_DAC_BIET). Danh sách ca lấy từ SA_SystemSetting
       BIRTHDAY_SHIFTS (mặc định 'CA1,CA4' — hai bữa chính); các ca khác và
       người Hàn KHÔNG bị đè.
     - Ngày so với cấu hình sinh nhật là NGÀY CỦA CA (MealDate), không phải
       ngày lịch của lượt quẹt: ca vắt qua nửa đêm (CA1 22:50 -> 01:50) thuộc
       về ngày bắt đầu ca. Sinh nhật ngày 14 thì CA1 chạy từ 14 lúc 22:50 tới
       15 lúc 01:50 — cả đoạn sau nửa đêm vẫn là suất sinh nhật của ngày 14,
       còn 00:00-01:50 của chính ngày 14 thì thuộc ca của ngày 13 nên KHÔNG
       phải suất sinh nhật.
     - Thiếu dòng cấu hình thì rơi về quy tắc gốc: người Hàn CA3+CA4 cơm Hàn /
       còn lại mỳ Hàn; người Việt CA1+CA4 bữa chính / còn lại bữa phụ.
   Đơn giá đọc từ SA_MealPrice; thiếu mã nào thì rơi về giá dự phòng. RIÊNG
   suất sinh nhật thì KHÔNG: đơn giá của nó là SA_BirthdayConfig.SpecialMealPrice
   của CHÍNH NGÀY ăn — mỗi ngày sinh nhật một giá — nên tiền của loại này phải
   CỘNG DỒN theo từng lượt chứ không nhân số suất với một đơn giá chung. Mã
   SUAT_DAC_BIET trong SA_MealPrice chỉ còn là giá dự phòng cho ngày sinh nhật
   nào bỏ trống giá. Bản song song ở client: classifyLogs /
   classifyManualEntries — sửa một nơi thì phải sửa cả nơi kia.
   Tháng không có dữ liệu vẫn trả về một dòng với giá trị 0.

   THÁNG LÀ MỘT KỲ, KHÔNG PHẢI THÁNG LỊCH. Mỗi tháng là khoảng nửa mở
   [FromDateTime, ToDateTime) của dbo.SA_CostMonthPeriodOf — người dùng đặt ở
   tab Xu hướng năm, mặc định là kỳ 25 tháng trước 22:50 -> 25 tháng này
   22:50 (tháng 01/2026 = 25/12/2025 22:50 -> 25/01/2026 22:50). Mọi khoản
   được xếp vào tháng theo MỘT MỐC THỜI ĐIỂM rơi vào kỳ nào:
     - lượt quẹt: chính thời điểm quẹt;
     - suất nhập tay: giờ bắt đầu ca trong ngày làm việc đã nhập (ca vắt nửa
       đêm bắt đầu từ tối hôm trước) — bản song song `manualEntryDateTime`;
     - sữa / chi phí phát sinh: giờ BẮT ĐẦU khung cấp phát — ca đêm của ngày
       D từ (D-1) 22:50, ca ngày từ D 08:00 — bản song song
       `supplyShiftWindow`.
   Hai kỳ trong một năm không giao nhau (SA_CostMonthPeriod_Save kiểm), và
   mỗi khoản lấy TOP (1) kỳ chứa nó, nên không khoản nào bị tính hai lần.
   Kỳ của từng tháng cũng được trả về (fromDateTime / toDateTime) để client
   cắt chi phí nhân công theo đúng hai mốc đó.
   =========================================================================== */
CREATE PROCEDURE dbo.SA_MealCost_GetMonthly
    @Year int = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @Year IS NULL SET @Year = YEAR(SYSDATETIME());

    IF @Year < 2000 OR @Year > 2999
    BEGIN
        RAISERROR (N'Tham số @Year không hợp lệ.', 16, 1);
        RETURN;
    END

    /* --- 12 kỳ của năm, để tháng rỗng vẫn có dòng ------------------------ */
    CREATE TABLE #Months
    (
        MonthNo   int          NOT NULL PRIMARY KEY,
        CostMonth char(7)      NOT NULL,
        FromTime  datetime2(0) NOT NULL,
        ToTime    datetime2(0) NOT NULL
    );
    INSERT INTO #Months (MonthNo, CostMonth, FromTime, ToTime)
    SELECT MonthNo, CostMonth, FromDateTime, ToDateTime
    FROM dbo.SA_CostMonthPeriodOf(@Year);

    /* Biên epoch phủ trọn 12 kỳ để vẫn seek được clustered PK của
       TB_EVENT_LOG — xem chú thích ở SA_MealLog_GetByRange. */
    DECLARE @FromEpoch int =
        DATEDIFF(SECOND, '1970-01-01', (SELECT MIN(FromTime) FROM #Months));
    DECLARE @ToEpoch   int =
        DATEDIFF(SECOND, '1970-01-01', (SELECT MAX(ToTime) FROM #Months)) - 1;

    /* Giờ bắt đầu ngày làm việc (ca vắt nửa đêm) — mốc của khung cấp phát
       ca đêm. Cùng nguồn với SA_CostMonthPeriodOf. */
    DECLARE @NightStart time(0) =
        ISNULL((SELECT TOP (1) StartTime FROM dbo.SA_Shift
                WHERE WrapsMidnight = 1 AND IsActive = 1 ORDER BY SortOrder),
               CAST('22:50:00' AS time(0)));
    DECLARE @NightStartSec int = DATEDIFF(SECOND, CAST('00:00:00' AS time(0)), @NightStart);
    /* = SUPPLY_DAY_START ở client. */
    DECLARE @SupplyDayStartSec int = 8 * 3600;

    /* --- Ca được ăn suất sinh nhật ---------------------------------------
       Chuỗi 'CA1,CA4'. Bọc dấu phẩy hai đầu để so khớp nguyên vẹn mã ca,
       tránh 'CA1' khớp nhầm vào 'CA10'. */
    DECLARE @BirthdayShifts nvarchar(202) =
        N',' + REPLACE(
                   ISNULL((SELECT SettingValue FROM dbo.SA_SystemSetting
                           WHERE SettingKey = 'BIRTHDAY_SHIFTS'), N'CA1,CA4'),
                   N' ', N'')
             + N',';

    /* --- Đơn giá --------------------------------------------------------- */
    DECLARE @pComHan     decimal(18,2) = ISNULL((SELECT UnitPrice FROM dbo.SA_MealPrice WHERE Code = 'COM_HAN'       AND IsActive = 1), 65000);
    DECLARE @pMyHan      decimal(18,2) = ISNULL((SELECT UnitPrice FROM dbo.SA_MealPrice WHERE Code = 'MY_HAN'        AND IsActive = 1), 30000);
    DECLARE @pComViet    decimal(18,2) = ISNULL((SELECT UnitPrice FROM dbo.SA_MealPrice WHERE Code = 'COM_VIET'      AND IsActive = 1), 28000);
    DECLARE @pComVietPhu decimal(18,2) = ISNULL((SELECT UnitPrice FROM dbo.SA_MealPrice WHERE Code = 'COM_VIET_PHU'  AND IsActive = 1), 20000);
    /* Chỉ là giá DỰ PHÒNG cho ngày sinh nhật nào bỏ trống giá — không còn là
       đơn giá suất sinh nhật của cả kỳ. Xem chú thích đầu procedure. */
    DECLARE @pDacBiet    decimal(18,2) = ISNULL((SELECT UnitPrice FROM dbo.SA_MealPrice WHERE Code = 'SUAT_DAC_BIET' AND IsActive = 1), 50000);

    /* --- Nhân viên + bộ phận lớn đã giải quy tắc ------------------------- */
    CREATE TABLE #Users
    (
        nUserID       int          NOT NULL PRIMARY KEY,
        /* Bộ phận khi CHƯA xét đợt ánh xạ nào của khách công tác. */
        LargeDept     nvarchar(32) NOT NULL,
        IsRuleMatched bit          NOT NULL
    );

    /* Cùng một nguồn với SA_MealLog_GetByRange — xem SA_UserDeptResolved. */
    INSERT INTO #Users (nUserID, LargeDept, IsRuleMatched)
    SELECT nUserID, BaseLargeDept, IsRuleMatched
    FROM dbo.SA_UserDeptResolved;

    /* Các ĐỢT ánh xạ bộ phận của khách công tác — BẢN SAO của #Ov trong
       SA_MealLog_GetByRange; sửa một bên phải sửa bên kia. */
    CREATE TABLE #Ov
    (
        nUserID    int          NOT NULL,
        OverrideId int          NOT NULL,
        LargeDept  nvarchar(32) NOT NULL,
        EffFrom    date         NULL,
        EffTo      date         NULL
    );

    INSERT INTO #Ov (nUserID, OverrideId, LargeDept, EffFrom, EffTo)
    SELECT u.nUserID, o.OverrideId, o.LargeDeptCode, o.EffectiveFrom, o.EffectiveTo
    FROM dbo.SA_GuestDeptOverride o
    INNER JOIN #Users u ON u.nUserID = TRY_CAST(LTRIM(RTRIM(o.UserId)) AS int)
    WHERE u.IsRuleMatched = 1;

    CREATE CLUSTERED INDEX IX_Ov ON #Ov (nUserID, EffFrom);

    /* --- Đếm suất từng loại theo tháng ----------------------------------- */
    CREATE TABLE #MealCount
    (
        MonthNo           int NOT NULL PRIMARY KEY,
        ComHan            int NOT NULL,
        MyHan             int NOT NULL,
        ComViet           int NOT NULL,
        ComVietPhu        int NOT NULL,
        SuatDacBiet       int NOT NULL,
        /* Tiền suất sinh nhật cộng dồn theo TỪNG LƯỢT: mỗi ngày sinh nhật một
           đơn giá riêng nên không nhân ngược từ số suất được. */
        SuatDacBietAmount decimal(18,2) NOT NULL
    );

    INSERT INTO #MealCount (MonthNo, ComHan, MyHan, ComViet, ComVietPhu, SuatDacBiet, SuatDacBietAmount)
    SELECT  c.MonthNo,
            SUM(CASE WHEN c.Category = 'KO_COM'      THEN c.Qty ELSE 0 END),
            SUM(CASE WHEN c.Category = 'KO_MY'       THEN c.Qty ELSE 0 END),
            SUM(CASE WHEN c.Category = 'VN_CHINH'    THEN c.Qty ELSE 0 END),
            SUM(CASE WHEN c.Category = 'VN_PHU'      THEN c.Qty ELSE 0 END),
            SUM(CASE WHEN c.Category = 'VN_SINHNHAT' THEN c.Qty ELSE 0 END),
            SUM(CASE WHEN c.Category = 'VN_SINHNHAT'
                     THEN c.Qty * c.BirthdayPrice ELSE 0 END)
    FROM (
        SELECT  pm.MonthNo          AS MonthNo,
                1                   AS Qty,
                CASE
                    WHEN st.StaffType = 'KR' THEN cat.BaseCategory
                    /* Sinh nhật chỉ đè lên các CA ĂN SINH NHẬT của người
                       Việt; ca khác trong cùng ngày vẫn tính giá thường. */
                    WHEN bd.ConfigDate IS NOT NULL
                     AND @BirthdayShifts LIKE N'%,' + st.ShiftCode + N',%'
                        THEN 'VN_SINHNHAT'
                    ELSE cat.BaseCategory
                END AS Category,
                /* Đơn giá của ĐÚNG ngày sinh nhật đó; ngày bỏ trống giá thì
                   rơi về giá dự phòng chứ không thành 0 đồng. */
                CASE WHEN ISNULL(bd.SpecialMealPrice, 0) > 0
                     THEN bd.SpecialMealPrice ELSE @pDacBiet END AS BirthdayPrice
        FROM BioStar.dbo.TB_EVENT_LOG e
        INNER JOIN dbo.SA_Reader        rd ON rd.ReaderIdn = e.nReaderIdn AND rd.IsActive = 1
        INNER JOIN dbo.SA_MealEventCode ec ON ec.EventIdn  = e.nEventIdn
        INNER JOIN #Users               u  ON u.nUserID    = e.nUserID
        CROSS APPLY (
            SELECT DATEADD(SECOND, e.nDateTime, CAST('1970-01-01' AS datetime2(0))) AS LogTime
        ) t
        CROSS APPLY (
            SELECT CAST(t.LogTime AS date) AS ActualDate
        ) a
        CROSS APPLY (
            /* KỲ chứa lượt quẹt — ngoài mọi kỳ của năm thì không tính. */
            SELECT TOP (1) km.MonthNo
            FROM #Months km
            WHERE t.LogTime >= km.FromTime AND t.LogTime < km.ToTime
            ORDER BY km.MonthNo
        ) pm
        OUTER APPLY (
            SELECT TOP (1) s.ShiftCode, s.WrapsMidnight, s.EndTime
            FROM dbo.SA_Shift s
            WHERE s.IsActive = 1
              AND (
                    (s.WrapsMidnight = 1
                     AND (CAST(t.LogTime AS time(0)) >= s.StartTime
                       OR CAST(t.LogTime AS time(0)) <= s.EndTime))
                 OR (s.WrapsMidnight = 0
                     AND CAST(t.LogTime AS time(0)) >= s.StartTime
                     AND CAST(t.LogTime AS time(0)) <= s.EndTime)
                  )
            ORDER BY s.SortOrder
        ) sh
        OUTER APPLY (
            /* HIỆU LỰC THEO NGÀY — đợt ánh xạ nào phủ ngày quẹt. BẢN SAO của
               OUTER APPLY `ov` trong SA_MealLog_GetByRange; sửa một bên phải
               sửa bên kia. Đổi bộ phận lớn là đổi luôn nhóm giá, nên hết đợt
               là khách tự quay về giá của bộ phận mặc định. */
            SELECT TOP (1) o.LargeDept
            FROM #Ov o
            WHERE o.nUserID = u.nUserID
              AND (o.EffFrom IS NULL OR a.ActualDate >= o.EffFrom)
              AND (o.EffTo   IS NULL OR a.ActualDate <= o.EffTo)
            ORDER BY o.EffFrom DESC, o.OverrideId DESC
        ) ov
        CROSS APPLY (
            /* CHỈ bộ phận lớn KR mới ăn giá suất Hàn, và ăn ở mọi máy chấm.
               Máy TA-102 (CT Korea) không quyết định gì về giá: khách hoặc
               người bộ phận khác quẹt nhầm máy đó vẫn tính giá người Việt. */
            SELECT ISNULL(sh.ShiftCode, N'Khác')                        AS ShiftCode,
                   CASE WHEN ISNULL(ov.LargeDept, u.LargeDept) = N'KR'
                        THEN 'KR' ELSE 'VN' END                         AS StaffType
        ) st
        CROSS APPLY (
            /* NGÀY CỦA CA — chỉ dùng để tra cấu hình sinh nhật, không thay
               ActualDate. Nửa sau của ca vắt qua nửa đêm (00:00 -> EndTime)
               thuộc về ngày hôm trước, là ngày ca đó bắt đầu. */
            SELECT CASE WHEN sh.WrapsMidnight = 1
                         AND CAST(t.LogTime AS time(0)) <= sh.EndTime
                        THEN DATEADD(DAY, -1, a.ActualDate)
                        ELSE a.ActualDate
                   END AS MealDate
        ) md
        LEFT JOIN dbo.SA_ShiftMealCategory smc
               ON smc.ShiftCode = st.ShiftCode
              AND smc.StaffType = st.StaffType
        CROSS APPLY (
            /* Loại suất theo cấu hình, trước khi xét sinh nhật. */
            SELECT ISNULL(smc.MealCategory,
                          CASE WHEN st.StaffType = 'KR'
                               THEN CASE WHEN st.ShiftCode IN (N'CA3', N'CA4')
                                         THEN 'KO_COM' ELSE 'KO_MY' END
                               ELSE CASE WHEN st.ShiftCode IN (N'CA1', N'CA4')
                                         THEN 'VN_CHINH' ELSE 'VN_PHU' END
                          END) AS BaseCategory
        ) cat
        LEFT JOIN dbo.SA_BirthdayConfig bd ON bd.ConfigDate = md.MealDate
        WHERE e.nDateTime BETWEEN @FromEpoch AND @ToEpoch
          /* Cùng bộ lọc với SA_MealLog_GetByRange — nếu chỉ một trong hai
             procedure lọc thì bảng 12 tháng và các bảng kê sẽ đá nhau. Loại
             CẢ lượt xoá 'MAT_MAT': procedure kia trả chúng về chỉ để tab Suất
             Ăn Mất Mát hiển thị, còn bảng kê phía client cũng bỏ chúng. */
          AND NOT EXISTS (SELECT 1 FROM dbo.TB_EVENT_LOG_DEL dl
                          WHERE dl.nEventLogIdn = e.nEventLogIdn)

        UNION ALL

        /* --- Suất nhập tay (tab Nhập Thủ Công Ca) -----------------------
           Máy quẹt hỏng, mất điện, ăn đột xuất không quẹt thẻ — vẫn là suất
           ăn thật và vẫn phải trả tiền, nên vào đây như một lượt quẹt, chỉ
           khác là một dòng mang nhiều suất.

           Dòng ký sổ của NGƯỜI VIỆT rơi đúng ngày sinh nhật và thuộc ca ăn
           sinh nhật thì cũng ăn ĐƠN GIÁ SINH NHẬT CỦA NGÀY ĐÓ — người ký sổ
           hôm đó cũng ăn suất sinh nhật như người quẹt được thẻ.

           EntryDate là NGÀY LÀM VIỆC ((D-1) 22:50 -> D 22:50): "CA1 ngày 26"
           là ca đêm 25 22:50 -> 26 01:50. Ngày đối chiếu sinh nhật là ngày ca
           BẮT ĐẦU, cùng khoá với MealDate của lượt quẹt — nên với ca vắt qua
           nửa đêm là EntryDate - 1 (`mmd`). Người Hàn không bao giờ bị đè.
           Phía client `classifyManualEntries` làm y hệt — đổi một bên thì
           phải đổi bên kia. */
        SELECT  mpm.MonthNo         AS MonthNo,
                me.Quantity         AS Qty,
                CASE WHEN me.StaffType <> 'KR'
                      AND mbd.ConfigDate IS NOT NULL
                      AND @BirthdayShifts LIKE
                          N'%,' + me.ShiftCode COLLATE DATABASE_DEFAULT + N',%'
                     THEN 'VN_SINHNHAT'
                     ELSE mcat.BaseCategory
                END                 AS Category,
                CASE WHEN ISNULL(mbd.SpecialMealPrice, 0) > 0
                     THEN mbd.SpecialMealPrice ELSE @pDacBiet END AS BirthdayPrice
        FROM dbo.SA_ManualEntry me
        LEFT JOIN dbo.SA_ShiftMealCategory msmc
               ON msmc.ShiftCode = me.ShiftCode COLLATE DATABASE_DEFAULT
              AND msmc.StaffType = me.StaffType COLLATE DATABASE_DEFAULT
        LEFT JOIN dbo.SA_Shift msh
               ON msh.ShiftCode = me.ShiftCode COLLATE DATABASE_DEFAULT
        CROSS APPLY (
            SELECT CASE WHEN msh.WrapsMidnight = 1
                        THEN DATEADD(DAY, -1, me.EntryDate)
                        ELSE me.EntryDate
                   END AS MealDate
        ) mmd
        CROSS APPLY (
            /* MỐC THỜI ĐIỂM của dòng nhập tay = giờ bắt đầu ca trong ngày làm
               việc đã nhập; ca vắt nửa đêm bắt đầu từ tối hôm trước. Ca 'Khác'
               không có trong SA_Shift nên lấy đầu ngày. Bản song song:
               `manualEntryDateTime` ở client. */
            SELECT DATEADD(SECOND,
                           DATEDIFF(SECOND, CAST('00:00:00' AS time(0)),
                                    ISNULL(msh.StartTime, CAST('00:00:00' AS time(0)))),
                           CAST(CASE WHEN msh.WrapsMidnight = 1
                                     THEN DATEADD(DAY, -1, me.EntryDate)
                                     ELSE me.EntryDate
                                END AS datetime2(0))) AS EntryTime
        ) mt
        CROSS APPLY (
            SELECT TOP (1) km.MonthNo
            FROM #Months km
            WHERE mt.EntryTime >= km.FromTime AND mt.EntryTime < km.ToTime
            ORDER BY km.MonthNo
        ) mpm
        LEFT JOIN dbo.SA_BirthdayConfig mbd ON mbd.ConfigDate = mmd.MealDate
        CROSS APPLY (
            SELECT ISNULL(msmc.MealCategory,
                          CASE WHEN me.StaffType = 'KR'
                               THEN CASE WHEN me.ShiftCode IN (N'CA3', N'CA4')
                                         THEN 'KO_COM' ELSE 'KO_MY' END
                               ELSE CASE WHEN me.ShiftCode IN (N'CA1', N'CA4')
                                         THEN 'VN_CHINH' ELSE 'VN_PHU' END
                          END) AS BaseCategory
        ) mcat
        WHERE me.Quantity > 0
          /* Chỉ để dùng index theo ngày; kỳ nào chứa dòng này do `mpm` quyết. */
          AND me.EntryDate >= DATEADD(DAY, -1, CAST((SELECT MIN(FromTime) FROM #Months) AS date))
          AND me.EntryDate <= DATEADD(DAY,  1, CAST((SELECT MAX(ToTime)   FROM #Months) AS date))
    ) c
    GROUP BY c.MonthNo;

    /* --- Sữa / chi phí phát sinh theo kỳ ---------------------------------
       Một dòng cấp phát thuộc kỳ chứa giờ BẮT ĐẦU khung của nó: ca đêm ngày
       D bắt đầu (D-1) 22:50, ca ngày D bắt đầu D 08:00 — xem
       `supplyShiftWindow`. Với kỳ chốt ở 22:50, khung nào cũng nằm trọn
       trong đúng một kỳ. */
    CREATE TABLE #MilkCost (MonthNo int NOT NULL PRIMARY KEY, Amount decimal(18,2) NOT NULL);
    INSERT INTO #MilkCost (MonthNo, Amount)
    SELECT km.MonthNo, SUM(x.TotalAmount)
    FROM dbo.SA_MilkEntry x
    CROSS APPLY (
        SELECT CASE WHEN x.MilkShift = 'DEM'
                    THEN DATEADD(SECOND, @NightStartSec,
                                 CAST(DATEADD(DAY, -1, x.EntryDate) AS datetime2(0)))
                    ELSE DATEADD(SECOND, @SupplyDayStartSec,
                                 CAST(x.EntryDate AS datetime2(0)))
               END AS WindowStart
    ) w
    CROSS APPLY (
        SELECT TOP (1) k.MonthNo
        FROM #Months k
        WHERE w.WindowStart >= k.FromTime AND w.WindowStart < k.ToTime
        ORDER BY k.MonthNo
    ) km
    GROUP BY km.MonthNo;

    CREATE TABLE #ExtraCost (MonthNo int NOT NULL PRIMARY KEY, Amount decimal(18,2) NOT NULL);
    INSERT INTO #ExtraCost (MonthNo, Amount)
    SELECT km.MonthNo, SUM(x.TotalAmount)
    FROM dbo.SA_ExtraCost x
    CROSS APPLY (
        SELECT CASE WHEN x.CostShift = 'DEM'
                    THEN DATEADD(SECOND, @NightStartSec,
                                 CAST(DATEADD(DAY, -1, x.EntryDate) AS datetime2(0)))
                    ELSE DATEADD(SECOND, @SupplyDayStartSec,
                                 CAST(x.EntryDate AS datetime2(0)))
               END AS WindowStart
    ) w
    CROSS APPLY (
        SELECT TOP (1) k.MonthNo
        FROM #Months k
        WHERE w.WindowStart >= k.FromTime AND w.WindowStart < k.ToTime
        ORDER BY k.MonthNo
    ) km
    GROUP BY km.MonthNo;

    /* --- Kết quả: số suất + thành tiền từng loại ------------------------- */
    SELECT
        mo.CostMonth                                                    AS costMonth,
        /* Nhãn cố định, KHÔNG dùng DATENAME vì tên tháng đổi theo ngôn ngữ
           của session SQL Server. */
        'T' + RIGHT('0' + CONVERT(varchar(2), mo.MonthNo), 2)
            + '-' + RIGHT(CONVERT(char(4), @Year), 2)                   AS [month],
        ISNULL(mc.ComHan, 0)                                            AS ComHanCount,
        ISNULL(mc.MyHan, 0)                                             AS MyHanCount,
        ISNULL(mc.ComViet, 0)                                           AS ComVietCount,
        ISNULL(mc.ComVietPhu, 0)                                        AS ComVietPhuCount,
        ISNULL(mc.SuatDacBiet, 0)                                       AS SuatDacBietCount,
        CAST(ISNULL(mc.ComHan, 0)      * @pComHan     AS float)         AS ComHan,
        CAST(ISNULL(mc.MyHan, 0)       * @pMyHan      AS float)         AS MyHan,
        CAST(ISNULL(mc.ComViet, 0)     * @pComViet    AS float)         AS ComViet,
        CAST(ISNULL(mc.ComVietPhu, 0)  * @pComVietPhu AS float)         AS ComVietPhu,
        CAST(ISNULL(mc.SuatDacBietAmount, 0)          AS float)         AS SuatDacBiet,
        CAST(ISNULL(mk.Amount, 0)                     AS float)         AS Sua,
        CAST(ISNULL(ex.Amount, 0)                     AS float)         AS ChiPhiPhatSinh,
        CAST(ISNULL(mc.ComHan, 0)      * @pComHan
           + ISNULL(mc.MyHan, 0)       * @pMyHan
           + ISNULL(mc.ComViet, 0)     * @pComViet
           + ISNULL(mc.ComVietPhu, 0)  * @pComVietPhu
           + ISNULL(mc.SuatDacBietAmount, 0)
           + ISNULL(mk.Amount, 0)
           + ISNULL(ex.Amount, 0)                     AS float)         AS [Sum],
        /* Kỳ của tháng — client cắt chi phí nhân công theo đúng hai mốc này. */
        CONVERT(char(19), mo.FromTime, 120)                             AS fromDateTime,
        CONVERT(char(19), mo.ToTime, 120)                               AS toDateTime
    FROM #Months mo
    LEFT JOIN #MealCount mc ON mc.MonthNo = mo.MonthNo
    LEFT JOIN #MilkCost  mk ON mk.MonthNo = mo.MonthNo
    LEFT JOIN #ExtraCost ex ON ex.MonthNo = mo.MonthNo
    ORDER BY mo.MonthNo;

    DROP TABLE #Months;
    DROP TABLE #Users;
    DROP TABLE #Ov;
    DROP TABLE #MealCount;
    DROP TABLE #MilkCost;
    DROP TABLE #ExtraCost;
END
GO

PRINT '_deploy_cost_month_period_2026-10-13.sql: DONE';
GO
