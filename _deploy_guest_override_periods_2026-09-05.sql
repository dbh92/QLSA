/* ===========================================================================
   TRIỂN KHAI: ánh xạ bộ phận khách công tác theo NHIỀU ĐỢT CÓ THỜI HẠN
   (2026-09-05)

   Chạy trên [QLSA]:
       sqlcmd -S <server> -U sa -P <pwd> -d QLSA -f 65001 -I ^
              -i _deploy_guest_override_periods_2026-09-05.sql

   Vì sao là script riêng chứ không chạy lại db/03_procedures.sql: file đó drop
   TOÀN BỘ procedure/view SA_* rồi tạo lại, nên bất kỳ bản sửa tay nào trên máy
   chủ cũng mất. Script này chỉ đụng đúng những gì tính năng cần:

     1. SA_GuestDeptOverride: thêm EffectiveFrom / EffectiveTo (date, NULL) và
        đổi khoá chính từ UserId sang OverrideId (IDENTITY) để MỘT KHÁCH CÓ
        NHIỀU ĐỢT. Dòng sẵn có được đánh số tự động, giữ nguyên nội dung, cả
        hai cột ngày NULL = hiệu lực vĩnh viễn — đúng hành vi cũ, nên chạy xong
        mà chưa nhập đợt nào thì KHÔNG con số nào đổi.
     2. Tạo lại view SA_UserDeptResolved (trả BaseLargeDept + IsRuleMatched;
        LargeDept giờ chỉ là "hiệu lực hôm nay", dùng để hiển thị).
     3. Tạo lại SA_MealLog_GetByRange và SA_MealCost_GetMonthly — hai chỗ chọn
        đợt theo ngày quẹt (#Ov + OUTER APPLY); PHẢI đi cùng nhau.
     4. Tạo lại SA_GuestDeptOverride_Get / _Save / _Delete (đọc danh sách đợt,
        thêm đợt kèm kiểm trùng khoảng, xoá một đợt theo OverrideId).

   Toàn bộ script chạy lại được nhiều lần. Nội dung các object dưới đây được
   chép nguyên từ db/03_procedures.sql — nguồn sự thật vẫn là file đó.
   =========================================================================== */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

PRINT '--- 1. Bảng SA_GuestDeptOverride: khoảng hiệu lực + nhiều đợt ---';
GO

IF COL_LENGTH('dbo.SA_GuestDeptOverride', 'EffectiveFrom') IS NULL
    ALTER TABLE dbo.SA_GuestDeptOverride ADD EffectiveFrom date NULL;
GO

IF COL_LENGTH('dbo.SA_GuestDeptOverride', 'EffectiveTo') IS NULL
    ALTER TABLE dbo.SA_GuestDeptOverride ADD EffectiveTo date NULL;
GO

/* Bỏ khoá chính cũ trên UserId (mỗi khách chỉ được một ngoại lệ) và thêm
   OverrideId để một khách có nhiều đợt. */
IF COL_LENGTH('dbo.SA_GuestDeptOverride', 'OverrideId') IS NULL
BEGIN
    IF OBJECT_ID('dbo.PK_SA_GuestDeptOverride', 'PK') IS NOT NULL
        ALTER TABLE dbo.SA_GuestDeptOverride DROP CONSTRAINT PK_SA_GuestDeptOverride;

    ALTER TABLE dbo.SA_GuestDeptOverride ADD OverrideId int NOT NULL IDENTITY(1,1);
END
GO

IF OBJECT_ID('dbo.PK_SA_GuestOverride_Id', 'PK') IS NULL
    ALTER TABLE dbo.SA_GuestDeptOverride
        ADD CONSTRAINT PK_SA_GuestOverride_Id PRIMARY KEY CLUSTERED (OverrideId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_SA_GuestOv_User'
                 AND object_id = OBJECT_ID('dbo.SA_GuestDeptOverride'))
    CREATE INDEX IX_SA_GuestOv_User ON dbo.SA_GuestDeptOverride (UserId, EffectiveFrom);
GO

IF OBJECT_ID('dbo.CK_SA_GuestOv_Range', 'C') IS NULL
    ALTER TABLE dbo.SA_GuestDeptOverride
        ADD CONSTRAINT CK_SA_GuestOv_Range CHECK (EffectiveFrom IS NULL
                                               OR EffectiveTo   IS NULL
                                               OR EffectiveTo  >= EffectiveFrom);
GO

PRINT '--- 2-4. View + procedure ---';
GO

IF OBJECT_ID('dbo.SA_UserDeptResolved', 'V') IS NOT NULL DROP VIEW dbo.SA_UserDeptResolved;
GO

CREATE VIEW dbo.SA_UserDeptResolved
AS
SELECT  x.nUserID,
        x.sUserID,
        x.sUserName,
        x.Department,
        /* Bộ phận khi CHƯA xét đợt nào — dùng cho mọi lượt quẹt không rơi
           vào đợt ánh xạ nào của khách này. */
        base.LargeDept   AS BaseLargeDept,
        /* Bộ phận có hiệu lực TÍNH ĐẾN HÔM NAY — chỉ để hiển thị. */
        eff.LargeDept    AS LargeDept,
        /* 1 = người này bị một rule có điều kiện quét vào, tức là thuộc diện
           được phép gán lại bộ phận riêng. Màn hình "Khách công tác" lọc theo
           đúng cột này, và hai procedure đọc log cũng lọc đợt theo nó. */
        CAST(CASE WHEN r.LargeDeptCode IS NULL THEN 0 ELSE 1 END AS bit) AS IsRuleMatched,
        r.LargeDeptCode  AS RuleLargeDept
FROM (
    SELECT  TRY_CAST(u.sUserID AS int)  AS nUserID,
            u.sUserID,
            u.sUserName,
            ISNULL(d.sName, N'')        AS Department,
            ROW_NUMBER() OVER (PARTITION BY TRY_CAST(u.sUserID AS int)
                               ORDER BY u.nUserIdn DESC) AS rn
    FROM BioStar.dbo.TB_USER u
    LEFT JOIN BioStar.dbo.TB_USER_DEPT d ON d.nDepartmentIdn = u.nDepartmentIdn
    WHERE TRY_CAST(u.sUserID AS int) IS NOT NULL
) x
LEFT JOIN dbo.SA_DepartmentMapping m
       ON m.SmallDepartment = x.Department COLLATE DATABASE_DEFAULT
OUTER APPLY (
    SELECT TOP (1) rr.LargeDeptCode
    FROM dbo.SA_DepartmentMappingRule rr
    WHERE rr.IsActive = 1
      AND (rr.SmallDepartment IS NULL
           OR rr.SmallDepartment = x.Department COLLATE DATABASE_DEFAULT)
      AND (
             (rr.MatchOperator = 'CONTAINS'
              AND x.sUserName COLLATE DATABASE_DEFAULT LIKE N'%' + rr.MatchValue + N'%')
          OR (rr.MatchOperator = 'NOT_CONTAINS'
              AND x.sUserName COLLATE DATABASE_DEFAULT NOT LIKE N'%' + rr.MatchValue + N'%')
          OR (rr.MatchOperator = 'EQUALS'
              AND x.sUserName COLLATE DATABASE_DEFAULT = rr.MatchValue)
          )
    ORDER BY rr.Priority, rr.RuleId
) r
CROSS APPLY (
    /* Bộ phận khi bỏ qua mọi đợt: rule > ánh xạ > 'Khác'. */
    SELECT COALESCE(r.LargeDeptCode, m.LargeDeptCode, N'Khác') AS LargeDept
) base
OUTER APPLY (
    /* Đợt đang phủ NGÀY HÔM NAY — CHỈ để hiển thị. Lượt quẹt dùng ngày quẹt
       của chính nó, xem #Ov trong hai procedure đọc log.

       Các đợt của một khách không được giao nhau (SA_GuestDeptOverride_Save
       chặn), nên TOP (1) chỉ là để chắc chắn kết quả không phụ thuộc thứ tự
       vật lý; ORDER BY ưu tiên đợt có ngày bắt đầu muộn nhất, tức đợt hẹp
       nhất, trước dòng "không giới hạn" của thời trước. */
    SELECT TOP (1) o.LargeDeptCode
    FROM dbo.SA_GuestDeptOverride o
    WHERE o.UserId = LTRIM(RTRIM(x.sUserID)) COLLATE DATABASE_DEFAULT
      AND r.LargeDeptCode IS NOT NULL
      AND (o.EffectiveFrom IS NULL OR CAST(SYSDATETIME() AS date) >= o.EffectiveFrom)
      AND (o.EffectiveTo   IS NULL OR CAST(SYSDATETIME() AS date) <= o.EffectiveTo)
    ORDER BY o.EffectiveFrom DESC, o.OverrideId DESC
) ovToday
CROSS APPLY (
    SELECT ISNULL(ovToday.LargeDeptCode, base.LargeDept) AS LargeDept
) eff
WHERE x.rn = 1;
GO

IF OBJECT_ID('dbo.SA_MealLog_GetByRange', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_MealLog_GetByRange;
GO

CREATE PROCEDURE dbo.SA_MealLog_GetByRange
    @FromDateTime datetime2(0),
    @ToDateTime   datetime2(0)
AS
BEGIN
    SET NOCOUNT ON;

    IF @FromDateTime IS NULL OR @ToDateTime IS NULL OR @ToDateTime < @FromDateTime
    BEGIN
        RAISERROR (N'Khoảng thời gian không hợp lệ (@FromDateTime / @ToDateTime).', 16, 1);
        RETURN;
    END

    /* Đổi khoảng thời điểm sang khoảng epoch để dùng được clustered index
       PK_TB_EVENT_LOG (nDateTime, ...) — tránh quét toàn bảng 3.3 triệu dòng. */
    DECLARE @FromEpoch int = DATEDIFF(SECOND, '1970-01-01', @FromDateTime);
    DECLARE @ToEpoch   int = DATEDIFF(SECOND, '1970-01-01', @ToDateTime);

    /* --- Bảng tra nhân viên đã kèm bộ phận lớn đã giải quy tắc ------------ */
    CREATE TABLE #Users
    (
        nUserID       int           NOT NULL PRIMARY KEY,
        sUserID       varchar(64)   NOT NULL,
        sUserName     nvarchar(96)  NOT NULL,
        Department    nvarchar(64)  NOT NULL,
        /* Bộ phận khi CHƯA xét đợt ánh xạ nào của khách công tác. */
        LargeDept     nvarchar(32)  NOT NULL,
        IsRuleMatched bit           NOT NULL
    );

    /* Bộ phận lớn đã giải xong trong view — xem SA_UserDeptResolved. */
    INSERT INTO #Users (nUserID, sUserID, sUserName, Department, LargeDept, IsRuleMatched)
    SELECT nUserID, sUserID, sUserName, Department, BaseLargeDept, IsRuleMatched
    FROM dbo.SA_UserDeptResolved;

    /* --- Các ĐỢT ánh xạ bộ phận của khách công tác ------------------------
       Một khách có thể có nhiều đợt, mỗi đợt một khoảng ngày; đợt nào phủ
       ngày quẹt thì lượt quẹt đó tính vào bộ phận của đợt ấy. Lọc theo
       IsRuleMatched ngay tại đây: rule là dữ liệu người dùng sửa được, người
       không còn bị rule quét vào thì đợt cũ phải hết tác dụng ngay.

       BẢNG NÀY CÓ BẢN SAO trong SA_MealCost_GetMonthly — sửa một bên thì phải
       sửa bên kia, nếu không bảng kê tháng và biểu đồ 12 tháng sẽ nói hai bộ
       phận khác nhau cho cùng một lượt quẹt. */
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

    /* --- Log chấm ăn ------------------------------------------------------ */
    SELECT
        CAST(e.nEventLogIdn AS varchar(20))                                AS id,
        LTRIM(RTRIM(u.sUserID))                                            AS userId,
        LTRIM(RTRIM(u.sUserName))                                          AS userName,
        LTRIM(RTRIM(u.Department))                                         AS department,
        ISNULL(ov.LargeDept, u.LargeDept)                                  AS largeDepartment,
        CONVERT(char(19), t.LogTime, 120)                                  AS logDateTime,
        CONVERT(char(8),  t.LogTime, 108)                                  AS logTimeOnly,
        CONVERT(char(10), t.LogTime, 23)                                   AS actualDate,
        ISNULL(sh.ShiftCode, N'Khác')                                      AS shiftCode,
        e.nReaderIdn                                                       AS readerId,
        rd.ReaderName                                                      AS readerName,
        rd.IsKoreanMachine                                                 AS isKorean
    FROM BioStar.dbo.TB_EVENT_LOG e
    INNER JOIN dbo.SA_Reader        rd ON rd.ReaderIdn = e.nReaderIdn AND rd.IsActive = 1
    INNER JOIN dbo.SA_MealEventCode ec ON ec.EventIdn  = e.nEventIdn
    INNER JOIN #Users               u  ON u.nUserID    = e.nUserID
    CROSS APPLY (
        SELECT DATEADD(SECOND, e.nDateTime, CAST('1970-01-01' AS datetime2(0))) AS LogTime
    ) t
    OUTER APPLY (
        /* HIỆU LỰC THEO NGÀY — đợt ánh xạ nào phủ NGÀY QUẸT của lượt này.

           So bằng NGÀY LỊCH CỦA LƯỢT QUẸT (đúng `actualDate` trả về ở dưới),
           không phải hôm nay và không phải reportDate: bộ phận là thuộc tính
           của con người lúc quẹt, không phải của cột ngày trên báo cáo. Nhờ
           vậy một khoảng lọc trải dài nhiều đợt tự tách đúng từng đoạn —
           05/08→10/09 mà khách có đợt 01-10/08 vào SP rồi 11-20/08 vào LFEM
           thì mỗi lượt quẹt rơi vào đúng bộ phận của ngày mình, không màn hình
           nào phải cắt khoảng bằng tay.

           Không có đợt nào phủ thì ISNULL ở trên trả về bộ phận mặc định của
           quy tắc. Các đợt không giao nhau (procedure _Save chặn), nên TOP (1)
           chỉ để kết quả không phụ thuộc thứ tự vật lý.

           ĐOẠN NÀY CÓ BẢN SAO trong SA_MealCost_GetMonthly (cũng tên `ov`) —
           sửa một bên thì phải sửa bên kia. */
        SELECT TOP (1) o.LargeDept
        FROM #Ov o
        WHERE o.nUserID = u.nUserID
          AND (o.EffFrom IS NULL OR CAST(t.LogTime AS date) >= o.EffFrom)
          AND (o.EffTo   IS NULL OR CAST(t.LogTime AS date) <= o.EffTo)
        ORDER BY o.EffFrom DESC, o.OverrideId DESC
    ) ov
    OUTER APPLY (
        SELECT TOP (1) s.ShiftCode
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
    WHERE e.nDateTime BETWEEN @FromEpoch AND @ToEpoch
      /* Lượt quẹt đã xoá (popup Điều Chỉnh Số Liệu) — dòng gốc vẫn còn bên
         BioStar, chỉ bị loại khỏi hệ thống suất ăn. Khôi phục = xoá khỏi
         TB_EVENT_LOG_DEL, xem SA_MealLogDeleted_Restore. */
      AND NOT EXISTS (SELECT 1 FROM dbo.TB_EVENT_LOG_DEL dl
                      WHERE dl.nEventLogIdn = e.nEventLogIdn)
    ORDER BY t.LogTime, u.sUserID;

    DROP TABLE #Users;
    DROP TABLE #Ov;
END
GO

IF OBJECT_ID('dbo.SA_MealCost_GetMonthly', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_MealCost_GetMonthly;
GO

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

    /* Ngày của lượt quẹt là ngày lịch — xem chú thích ở SA_MealLog_GetByRange. */
    DECLARE @FromDate date = DATEFROMPARTS(@Year, 1, 1);
    DECLARE @ToDate   date = DATEFROMPARTS(@Year, 12, 31);

    DECLARE @FromEpoch int =
        DATEDIFF(SECOND, '1970-01-01', CAST(@FromDate AS datetime2(0)));
    DECLARE @ToEpoch   int =
        DATEDIFF(SECOND, '1970-01-01', CAST(DATEADD(DAY, 1, @ToDate) AS datetime2(0))) - 1;

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
    DECLARE @pDacBiet    decimal(18,2) = ISNULL((SELECT UnitPrice FROM dbo.SA_MealPrice WHERE Code = 'SUAT_DAC_BIET' AND IsActive = 1), 50000);

    /* --- 12 tháng của năm, để tháng rỗng vẫn có dòng --------------------- */
    CREATE TABLE #Months (MonthNo int NOT NULL PRIMARY KEY, CostMonth char(7) NOT NULL);
    INSERT INTO #Months (MonthNo, CostMonth)
    SELECT n, CONVERT(char(4), @Year) + '-' + RIGHT('0' + CONVERT(varchar(2), n), 2)
    FROM (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12)) AS m(n);

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
        MonthNo     int NOT NULL PRIMARY KEY,
        ComHan      int NOT NULL,
        MyHan       int NOT NULL,
        ComViet     int NOT NULL,
        ComVietPhu  int NOT NULL,
        SuatDacBiet int NOT NULL
    );

    INSERT INTO #MealCount (MonthNo, ComHan, MyHan, ComViet, ComVietPhu, SuatDacBiet)
    SELECT  c.MonthNo,
            SUM(CASE WHEN c.Category = 'KO_COM'      THEN c.Qty ELSE 0 END),
            SUM(CASE WHEN c.Category = 'KO_MY'       THEN c.Qty ELSE 0 END),
            SUM(CASE WHEN c.Category = 'VN_CHINH'    THEN c.Qty ELSE 0 END),
            SUM(CASE WHEN c.Category = 'VN_PHU'      THEN c.Qty ELSE 0 END),
            SUM(CASE WHEN c.Category = 'VN_SINHNHAT' THEN c.Qty ELSE 0 END)
    FROM (
        SELECT  MONTH(a.ActualDate) AS MonthNo,
                1                   AS Qty,
                CASE
                    WHEN st.StaffType = 'KR' THEN cat.BaseCategory
                    /* Sinh nhật chỉ đè lên các CA ĂN SINH NHẬT của người
                       Việt; ca khác trong cùng ngày vẫn tính giá thường. */
                    WHEN bd.ConfigDate IS NOT NULL
                     AND @BirthdayShifts LIKE N'%,' + st.ShiftCode + N',%'
                        THEN 'VN_SINHNHAT'
                    ELSE cat.BaseCategory
                END AS Category
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
          AND YEAR(a.ActualDate) = @Year
          /* Cùng bộ lọc với SA_MealLog_GetByRange — nếu chỉ một trong hai
             procedure lọc thì bảng 12 tháng và các bảng kê sẽ đá nhau. */
          AND NOT EXISTS (SELECT 1 FROM dbo.TB_EVENT_LOG_DEL dl
                          WHERE dl.nEventLogIdn = e.nEventLogIdn)

        UNION ALL

        /* --- Suất nhập tay (tab Nhập Thủ Công Ca) -----------------------
           Máy quẹt hỏng, mất điện, ăn đột xuất không quẹt thẻ — vẫn là suất
           ăn thật và vẫn phải trả tiền, nên vào đây như một lượt quẹt, chỉ
           khác là một dòng mang nhiều suất.

           KHÔNG xét sinh nhật: dòng nhập tay là số suất bù cho lượt quẹt bị
           mất, còn suất sinh nhật là suất phát tận tay người có mặt. Phía
           client `classifyManualEntries` bỏ qua sinh nhật y hệt — đổi một
           bên thì phải đổi bên kia. */
        SELECT  MONTH(me.EntryDate) AS MonthNo,
                me.Quantity         AS Qty,
                mcat.BaseCategory   AS Category
        FROM dbo.SA_ManualEntry me
        LEFT JOIN dbo.SA_ShiftMealCategory msmc
               ON msmc.ShiftCode = me.ShiftCode COLLATE DATABASE_DEFAULT
              AND msmc.StaffType = me.StaffType COLLATE DATABASE_DEFAULT
        CROSS APPLY (
            SELECT ISNULL(msmc.MealCategory,
                          CASE WHEN me.StaffType = 'KR'
                               THEN CASE WHEN me.ShiftCode IN (N'CA3', N'CA4')
                                         THEN 'KO_COM' ELSE 'KO_MY' END
                               ELSE CASE WHEN me.ShiftCode IN (N'CA1', N'CA4')
                                         THEN 'VN_CHINH' ELSE 'VN_PHU' END
                          END) AS BaseCategory
        ) mcat
        WHERE YEAR(me.EntryDate) = @Year
          AND me.Quantity > 0
    ) c
    GROUP BY c.MonthNo;

    /* --- Tiền sữa theo tháng --------------------------------------------- */
    CREATE TABLE #MilkCost (MonthNo int NOT NULL PRIMARY KEY, Amount decimal(18,2) NOT NULL);
    INSERT INTO #MilkCost (MonthNo, Amount)
    SELECT MONTH(EntryDate), SUM(TotalAmount)
    FROM dbo.SA_MilkEntry
    WHERE YEAR(EntryDate) = @Year
    GROUP BY MONTH(EntryDate);

    /* --- Chi phí phát sinh theo tháng ------------------------------------- */
    CREATE TABLE #ExtraCost (MonthNo int NOT NULL PRIMARY KEY, Amount decimal(18,2) NOT NULL);
    INSERT INTO #ExtraCost (MonthNo, Amount)
    SELECT MONTH(EntryDate), SUM(TotalAmount)
    FROM dbo.SA_ExtraCost
    WHERE YEAR(EntryDate) = @Year
    GROUP BY MONTH(EntryDate);

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
        CAST(ISNULL(mc.SuatDacBiet, 0) * @pDacBiet    AS float)         AS SuatDacBiet,
        CAST(ISNULL(mk.Amount, 0)                     AS float)         AS Sua,
        CAST(ISNULL(ex.Amount, 0)                     AS float)         AS ChiPhiPhatSinh,
        CAST(ISNULL(mc.ComHan, 0)      * @pComHan
           + ISNULL(mc.MyHan, 0)       * @pMyHan
           + ISNULL(mc.ComViet, 0)     * @pComViet
           + ISNULL(mc.ComVietPhu, 0)  * @pComVietPhu
           + ISNULL(mc.SuatDacBiet, 0) * @pDacBiet
           + ISNULL(mk.Amount, 0)
           + ISNULL(ex.Amount, 0)                     AS float)         AS [Sum]
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

IF OBJECT_ID('dbo.SA_GuestDeptOverride_Get', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_GuestDeptOverride_Get;
GO

CREATE PROCEDURE dbo.SA_GuestDeptOverride_Get
    /* Khoảng lọc đang xem, để đếm số lượt quẹt của từng khách — người dùng
       cần thấy ai thật sự có ăn trước khi quyết định gán vào bộ phận nào.
       Bỏ trống thì số lượt trả về 0 và procedure không đụng tới bảng log. */
    @FromDateTime datetime2(0) = NULL,
    @ToDateTime   datetime2(0) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    CREATE TABLE #Punch (nUserID int NOT NULL PRIMARY KEY, PunchCount int NOT NULL);

    IF @FromDateTime IS NOT NULL AND @ToDateTime IS NOT NULL
    BEGIN
        DECLARE @FromEpoch int = DATEDIFF(SECOND, '1970-01-01', @FromDateTime);
        DECLARE @ToEpoch   int = DATEDIFF(SECOND, '1970-01-01', @ToDateTime);

        /* Một lượt quét theo khoảng epoch rồi GROUP BY — KHÔNG đếm lồng theo
           từng khách: nUserID không có index bên BioStar nên 60 truy vấn con
           sẽ là 60 lần quét 3,3 triệu dòng. */
        INSERT INTO #Punch (nUserID, PunchCount)
        SELECT e.nUserID, COUNT(*)
        FROM BioStar.dbo.TB_EVENT_LOG e
        INNER JOIN dbo.SA_Reader        rd ON rd.ReaderIdn = e.nReaderIdn AND rd.IsActive = 1
        INNER JOIN dbo.SA_MealEventCode ec ON ec.EventIdn  = e.nEventIdn
        WHERE e.nDateTime BETWEEN @FromEpoch AND @ToEpoch
          /* Cùng bộ lọc với SA_MealLog_GetByRange: lượt đã xoá không được đếm,
             nếu không màn hình này lại nói một con số khác mọi màn hình khác. */
          AND NOT EXISTS (SELECT 1 FROM dbo.TB_EVENT_LOG_DEL dl
                          WHERE dl.nEventLogIdn = e.nEventLogIdn)
        GROUP BY e.nUserID;
    END

    /* --- Result set 1: danh sách khách công tác thuộc diện quy tắc -------- */
    SELECT  LTRIM(RTRIM(v.sUserID))    AS userId,
            LTRIM(RTRIM(v.sUserName))  AS userName,
            LTRIM(RTRIM(v.Department)) AS department,
            /* Bộ phận rule gán cho cả nhóm (KR): vừa là mặc định của màn hình,
               vừa là bộ phận mà lượt quẹt KHÔNG rơi vào đợt nào tính về. */
            v.RuleLargeDept            AS defaultLargeDepartment,
            /* Bộ phận đang được dùng TÍNH ĐẾN HÔM NAY. Một lượt quẹt cũ vẫn
               tính theo ngày quẹt của nó, nên cột này là để nhìn, không phải
               con số của báo cáo. */
            v.LargeDept                AS largeDepartment,
            ISNULL(pc.PunchCount, 0)   AS punchCount,
            /* Số đợt đã áp dụng cho khách này — giao diện hiện ngay trên dòng
               để biết ai đang có lịch ánh xạ mà không phải mở danh sách đợt. */
            (SELECT COUNT(*) FROM dbo.SA_GuestDeptOverride o
             WHERE o.UserId = LTRIM(RTRIM(v.sUserID)) COLLATE DATABASE_DEFAULT)
                                       AS periodCount
    FROM dbo.SA_UserDeptResolved v
    LEFT JOIN #Punch pc ON pc.nUserID = v.nUserID
    WHERE v.IsRuleMatched = 1
    ORDER BY v.sUserName, v.sUserID;

    /* --- Result set 2: TỪNG ĐỢT ánh xạ ------------------------------------
       Trả về HẾT, kể cả đợt của người mà rule không còn quét vào (đợt đó đã
       hết tác dụng khi tính tiền, nhưng vẫn phải nhìn thấy để xoá được).
       Ngày trả về dạng chuỗi 'YYYY-MM-DD' như mọi ngày khác trong hệ thống —
       bind kiểu date sẽ thành Date của JS và lệch múi giờ. */
    SELECT  o.OverrideId                        AS overrideId,
            LTRIM(RTRIM(o.UserId))              AS userId,
            ISNULL(LTRIM(RTRIM(v.sUserName)), LTRIM(RTRIM(o.UserId))) AS userName,
            o.LargeDeptCode                     AS largeDepartment,
            CONVERT(char(10), o.EffectiveFrom, 23) AS effectiveFrom,
            CONVERT(char(10), o.EffectiveTo,   23) AS effectiveTo,
            /* 0 = rule không còn quét người này vào, đợt đang bị bỏ qua. */
            CAST(ISNULL(v.IsRuleMatched, 0) AS bit) AS isActiveScope,
            o.Notes                             AS notes,
            CONVERT(char(19), o.UpdatedAt, 120) AS updatedAt
    FROM dbo.SA_GuestDeptOverride o
    LEFT JOIN dbo.SA_UserDeptResolved v
           ON LTRIM(RTRIM(v.sUserID)) = o.UserId COLLATE DATABASE_DEFAULT
    ORDER BY userName, o.EffectiveFrom, o.OverrideId;

    DROP TABLE #Punch;
END
GO

IF OBJECT_ID('dbo.SA_GuestDeptOverride_Save', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_GuestDeptOverride_Save;
GO

CREATE PROCEDURE dbo.SA_GuestDeptOverride_Save
    @UserId        varchar(64),
    @LargeDeptCode nvarchar(32),
    /* Khoảng ngày đợt có hiệu lực. NULL = không giới hạn đầu đó. */
    @EffectiveFrom date          = NULL,
    @EffectiveTo   date          = NULL,
    @Notes         nvarchar(255) = NULL,
    /* Bỏ trống = THÊM một đợt mới (lối vào thường của nút "Áp dụng"); truyền
       vào = sửa đúng đợt đó, và chính nó không bị tính là trùng với chính nó. */
    @OverrideId    int           = NULL
AS
BEGIN
    SET NOCOUNT ON;

    SET @UserId = NULLIF(LTRIM(RTRIM(@UserId)), '');
    IF @UserId IS NULL
    BEGIN
        RAISERROR (N'Thiếu mã nhân viên cần gán lại bộ phận.', 16, 1);
        RETURN;
    END

    IF @EffectiveFrom IS NOT NULL AND @EffectiveTo IS NOT NULL
       AND @EffectiveTo < @EffectiveFrom
    BEGIN
        RAISERROR (N'Khoảng hiệu lực không hợp lệ: ngày kết thúc sớm hơn ngày bắt đầu.', 16, 1);
        RETURN;
    END

    IF NOT EXISTS (SELECT 1 FROM dbo.SA_LargeDepartment
                   WHERE LargeDeptCode = @LargeDeptCode AND IsActive = 1)
    BEGIN
        RAISERROR (N'Bộ phận lớn "%s" không có trong danh mục.', 16, 1, @LargeDeptCode);
        RETURN;
    END

    /* CỬA CHẶN của tính năng: chỉ người được một rule có điều kiện quét vào
       mới được gán lại. Hôm nay đó là khách công tác tên chứa 'Business'. */
    IF NOT EXISTS (SELECT 1 FROM dbo.SA_UserDeptResolved
                   WHERE LTRIM(RTRIM(sUserID)) = @UserId COLLATE DATABASE_DEFAULT
                     AND IsRuleMatched = 1)
    BEGIN
        RAISERROR (N'Chỉ gán lại được bộ phận cho khách công tác thuộc diện quy tắc (tên chứa ''Business''). Mã "%s" không thuộc diện này.', 16, 1, @UserId);
        RETURN;
    END

    /* --- KHÔNG ĐƯỢC GIAO VỚI ĐỢT ĐÃ CÓ CỦA CHÍNH KHÁCH NÀY ----------------
       Hai khoảng giao nhau khi: đầu này bắt đầu trước khi đầu kia kết thúc VÀ
       kết thúc sau khi đầu kia bắt đầu. NULL là vô cực, nên vế nào NULL thì
       vế đó luôn thoả. Đợt liền kề KHÔNG phải giao: 01-10/08 và 11-20/08 hợp
       lệ, đúng như người dùng vẫn chèn một đợt vào khe giữa hai đợt cũ.

       Kiểm ở đây chứ không phải ở giao diện: đây là chỗ duy nhất mọi lối ghi
       đều đi qua. Báo lỗi kèm đúng đợt bị đụng để người dùng biết phải sửa gì
       — dd/MM/yyyy (style 103) cho khớp cách đọc ngày trên màn hình. */
    DECLARE @ClashDept  nvarchar(32);
    DECLARE @ClashRange nvarchar(100);

    SELECT TOP (1)
           @ClashDept  = o.LargeDeptCode,
           @ClashRange = ISNULL(CONVERT(char(10), o.EffectiveFrom, 103), N'không giới hạn')
                       + N' → '
                       + ISNULL(CONVERT(char(10), o.EffectiveTo, 103), N'không giới hạn')
    FROM dbo.SA_GuestDeptOverride o
    WHERE o.UserId = @UserId
      AND (@OverrideId IS NULL OR o.OverrideId <> @OverrideId)
      AND (@EffectiveFrom IS NULL OR o.EffectiveTo   IS NULL OR o.EffectiveTo   >= @EffectiveFrom)
      AND (@EffectiveTo   IS NULL OR o.EffectiveFrom IS NULL OR o.EffectiveFrom <= @EffectiveTo)
    ORDER BY o.EffectiveFrom, o.OverrideId;

    IF @ClashRange IS NOT NULL
    BEGIN
        RAISERROR (N'Khoảng thời gian bị trùng với đợt đã có: %s (%s). Hãy chọn khoảng khác hoặc xoá đợt cũ trước.',
                   16, 1, @ClashRange, @ClashDept);
        RETURN;
    END

    IF @OverrideId IS NULL
    BEGIN
        INSERT INTO dbo.SA_GuestDeptOverride
            (UserId, LargeDeptCode, EffectiveFrom, EffectiveTo, Notes)
        VALUES (@UserId, @LargeDeptCode, @EffectiveFrom, @EffectiveTo, @Notes);

        SET @OverrideId = CAST(SCOPE_IDENTITY() AS int);
    END
    ELSE
    BEGIN
        UPDATE dbo.SA_GuestDeptOverride
           SET LargeDeptCode = @LargeDeptCode,
               EffectiveFrom = @EffectiveFrom,
               EffectiveTo   = @EffectiveTo,
               Notes         = @Notes,
               UpdatedAt     = SYSDATETIME()
         WHERE OverrideId = @OverrideId;

        IF @@ROWCOUNT = 0
        BEGIN
            RAISERROR (N'Đợt ánh xạ cần sửa không còn tồn tại (có thể đã bị xoá).', 16, 1);
            RETURN;
        END
    END

    SELECT @OverrideId AS overrideId,
           @UserId AS userId,
           @LargeDeptCode AS largeDepartment,
           CONVERT(char(10), @EffectiveFrom, 23) AS effectiveFrom,
           CONVERT(char(10), @EffectiveTo,   23) AS effectiveTo;
END
GO

IF OBJECT_ID('dbo.SA_GuestDeptOverride_Delete', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_GuestDeptOverride_Delete;
GO

CREATE PROCEDURE dbo.SA_GuestDeptOverride_Delete
    /* Xoá MỘT đợt. Khoá là OverrideId chứ không phải mã thẻ: một khách có
       nhiều đợt, xoá theo mã thẻ sẽ cuốn sạch cả lịch sử ánh xạ của họ. */
    @OverrideId int
AS
BEGIN
    SET NOCOUNT ON;

    IF @OverrideId IS NULL
    BEGIN
        RAISERROR (N'Thiếu mã đợt ánh xạ cần xoá.', 16, 1);
        RETURN;
    END

    /* Bỏ một đợt = những ngày trong đợt đó quay về bộ phận mà rule gán cho cả
       nhóm, trừ khi có đợt khác phủ lên. */
    DELETE FROM dbo.SA_GuestDeptOverride WHERE OverrideId = @OverrideId;
    SELECT @@ROWCOUNT AS deleted;
END
GO

PRINT 'Trien khai xong: anh xa khach cong tac theo nhieu dot.';
GO
