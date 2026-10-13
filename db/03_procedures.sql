/* ============================================================================
   03_procedures.sql — Stored procedures của hệ thống suất ăn.

   Quy ước đặt tên:  SA_<Đối tượng>_<Hành động>
   Script DROP rồi CREATE lại toàn bộ procedure nên chạy lại được nhiều lần.
   (Server là SQL Server 2012 nên không dùng được cú pháp CREATE OR ALTER.)

   Quy tắc nghiệp vụ được cài trong SA_MealLog_GetByRange:
     - actualDate = ĐÚNG ngày lịch của lượt quẹt, không lùi ngày. Quẹt lúc
       '2026-08-11 00:48:37' thuộc ngày 2026-08-11.
     - Chỉ lấy 3 máy chấm ăn trong SA_Reader (IsActive = 1).
     - Chỉ lấy mã sự kiện hợp lệ trong SA_MealEventCode.
     - Bộ phận lớn = ngoại lệ theo người (SA_GuestDeptOverride, chỉ cho người
       được rule quét vào) > rule có điều kiện (SA_DepartmentMappingRule) >
       ánh xạ mặc định (SA_DepartmentMapping) > 'Khác'. Quy tắc này nằm TRỌN
       trong view dbo.SA_UserDeptResolved — không nơi nào khác được chép lại.
     - isKorean = máy chấm là máy Hàn Quốc (TA-102). CHỈ để hiển thị: giá suất
       Hàn áp theo BỘ PHẬN LỚN KR, không theo máy chấm (xem SA_MealCost_GetMonthly).
     - Lượt quẹt đã bị xoá (có tên trong dbo.TB_EVENT_LOG_DEL) bị loại khỏi
       MỌI con số. BioStar là read-only nên không xoá được ở nguồn; bảng _DEL
       là sổ loại, và cũng là bản lưu để khôi phục. Hai chỗ đọc
       BioStar.dbo.TB_EVENT_LOG là SA_MealLog_GetByRange và
       SA_MealCost_GetMonthly — cả hai đều phải lọc, sửa một thì sửa cả hai.
       Riêng lượt xoá vì là SUẤT MẤT MÁT (DeleteKind = 'MAT_MAT') vẫn được
       SA_MealLog_GetByRange trả về kèm cờ lossDeleted = 1 — chỉ để tab Suất
       Ăn Mất Mát hiển thị y nguyên; phía client bỏ chúng khỏi mọi màn hình
       khác. SA_MealCost_GetMonthly không trả lượt quẹt nên loại hẳn.
   ============================================================================ */

USE [QLSA];
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* --- Xoá toàn bộ procedure + view + function cũ của hệ thống suất ăn trước
       khi tạo lại (view SA_UserDeptResolved và hàm SA_CostMonthPeriodOf cũng
       do script này sở hữu) ------------------------------------------------- */
DECLARE @drop nvarchar(max) = N'';
SELECT @drop = @drop + N'DROP PROCEDURE dbo.' + QUOTENAME(name) + N';' + CHAR(10)
FROM sys.procedures
WHERE name LIKE 'SA[_]%';
SELECT @drop = @drop + N'DROP VIEW dbo.' + QUOTENAME(name) + N';' + CHAR(10)
FROM sys.views
WHERE name LIKE 'SA[_]%';
SELECT @drop = @drop + N'DROP FUNCTION dbo.' + QUOTENAME(name) + N';' + CHAR(10)
FROM sys.objects
WHERE type IN ('IF', 'FN', 'TF') AND name LIKE 'SA[_]%';
IF @drop <> N'' EXEC sp_executesql @drop;
GO

/* ===========================================================================
   SA_UserDeptResolved — NHÂN VIÊN + BỘ PHẬN LỚN ĐÃ GIẢI XONG

   NGUỒN DUY NHẤT của câu hỏi "người này thuộc bộ phận lớn nào". Trước đây
   đoạn giải này được chép nguyên trong SA_MealLog_GetByRange và
   SA_MealCost_GetMonthly; giờ có thêm màn hình gán lại bộ phận cho khách công
   tác nữa nên phải gom về một chỗ, nếu không bốn bản sao sẽ lệch nhau.

   Thứ tự ưu tiên:
     1. SA_GuestDeptOverride — ngoại lệ cho TỪNG người, và CHỈ có hiệu lực với
        người đã được một rule có điều kiện quét vào (IsRuleMatched = 1). Hôm
        nay đó đúng là nhóm khách công tác tên chứa 'Business'. Ràng buộc này
        cố ý bám vào rule chứ không viết cứng chuỗi 'Business': rule là dữ
        liệu người dùng sửa được, chép lại nó là tự tạo ra chỗ lệch.
     2. SA_DepartmentMappingRule — rule có điều kiện theo tên.
     3. SA_DepartmentMapping — ánh xạ mặc định theo bộ phận nhỏ.
     4. N'Khác'.

   NGOẠI LỆ LÀ NHIỀU ĐỢT, NÊN VIEW KHÔNG TỰ TRẢ LỜI ĐƯỢC CHO MỘT LƯỢT QUẸT.
   Một khách công tác có thể có nhiều đợt (SA_GuestDeptOverride, mỗi dòng một
   khoảng ngày), nên "người này thuộc bộ phận nào" chỉ có nghĩa khi đi kèm MỘT
   NGÀY. Vì vậy view trả về hai cột bộ phận, với hai mục đích khác hẳn nhau:
     • BaseLargeDept = bước 2-3-4, tức bộ phận khi KHÔNG xét ngoại lệ. Đây là
       thứ mọi lượt quẹt không rơi vào đợt nào phải dùng.
     • LargeDept = bộ phận có hiệu lực TÍNH ĐẾN HÔM NAY — chỉ để hiển thị
       (màn hình "Khách công tác"). KHÔNG dùng cho lượt quẹt: một lượt quẹt
       tháng trước phải so với NGÀY QUẸT của nó, không phải hôm nay.

   Việc chọn đợt theo ngày quẹt nằm ở SA_MealLog_GetByRange và
   SA_MealCost_GetMonthly (bảng tạm #Ov + OUTER APPLY `ov`, tìm "HIỆU LỰC THEO
   NGÀY") — hai chỗ đó phải giống hệt nhau, sửa một bên là phải sửa bên kia,
   nếu không bảng kê tháng và biểu đồ 12 tháng sẽ đá nhau.

   IsRuleMatched cũng là ĐIỀU KIỆN ĐỌC chứ không chỉ điều kiện ghi: rule là dữ
   liệu người dùng sửa được, nên một đợt cũ của người mà rule không còn quét
   vào phải hết tác dụng ngay, không cần ai đi dọn bảng.

   Một nhân viên có thể có nhiều dòng trong TB_USER cùng một mã số; ROW_NUMBER
   giữ dòng mới nhất (nUserIdn lớn nhất), y như trước.

   View KHÔNG lọc gì và KHÔNG nhận tham số: các procedure đổ nó vào #Users rồi
   join với 3,3 triệu dòng log, nên phần nặng vẫn chạy đúng một lần.
   =========================================================================== */
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

/* ===========================================================================
   SA_MealLog_GetByRange — Dữ liệu chấm ăn thật theo khoảng THỜI ĐIỂM.

   Khoảng lọc tính đến GIÂY: @FromDateTime và @ToDateTime đều là biên ĐÓNG.

   actualDate = ĐÚNG ngày lịch của lượt quẹt. Không có chuyện lùi ngày:
   quẹt lúc '2026-08-11 00:48:37' thuộc ngày 2026-08-11, không phải 08-10.
   Ca ăn vẫn phân theo khung giờ như cũ — CA1 vắt qua nửa đêm chỉ ảnh hưởng
   tên ca, không ảnh hưởng ngày.
   =========================================================================== */
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
        rd.IsKoreanMachine                                                 AS isKorean,
        /* Suất mất mát đã bị xoá ở popup Điều Chỉnh Số Liệu. Vẫn trả về để
           tab Suất Ăn Mất Mát hiển thị y nguyên; mọi màn hình khác bỏ nó. */
        CAST(CASE WHEN dl.nEventLogIdn IS NULL THEN 0 ELSE 1 END AS bit)   AS lossDeleted
    FROM BioStar.dbo.TB_EVENT_LOG e
    INNER JOIN dbo.SA_Reader        rd ON rd.ReaderIdn = e.nReaderIdn AND rd.IsActive = 1
    INNER JOIN dbo.SA_MealEventCode ec ON ec.EventIdn  = e.nEventIdn
    INNER JOIN #Users               u  ON u.nUserID    = e.nUserID
    /* Khoá chính của _DEL là nEventLogIdn nên mỗi lượt quẹt khớp tối đa một
       dòng — LEFT JOIN không nhân bản kết quả. */
    LEFT JOIN dbo.TB_EVENT_LOG_DEL  dl ON dl.nEventLogIdn = e.nEventLogIdn
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
         TB_EVENT_LOG_DEL, xem SA_MealLogDeleted_Restore. Lượt xoá 'MAT_MAT'
         được giữ lại với lossDeleted = 1 (xem cột ở trên). */
      AND (dl.nEventLogIdn IS NULL OR dl.DeleteKind = 'MAT_MAT')
    ORDER BY t.LogTime, u.sUserID;

    DROP TABLE #Users;
    DROP TABLE #Ov;
END
GO

/* ===========================================================================
   DANH MỤC — đọc
   =========================================================================== */

CREATE PROCEDURE dbo.SA_LargeDepartment_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT LargeDeptCode AS code, LargeDeptName AS name, SortOrder AS sortOrder
    FROM dbo.SA_LargeDepartment
    WHERE IsActive = 1
    ORDER BY SortOrder, LargeDeptCode;
END
GO

CREATE PROCEDURE dbo.SA_DepartmentMapping_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  m.MappingId       AS id,
            m.SmallDepartment AS smallDepartment,
            m.LargeDeptCode   AS largeDepartment,
            m.Notes           AS notes
    FROM dbo.SA_DepartmentMapping m
    ORDER BY m.LargeDeptCode, m.SmallDepartment;
END
GO

CREATE PROCEDURE dbo.SA_DepartmentMappingRule_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  RuleId          AS id,
            SmallDepartment AS smallDepartment,
            MatchField      AS matchField,
            MatchOperator   AS matchOperator,
            MatchValue      AS matchValue,
            LargeDeptCode   AS largeDepartment,
            Priority        AS priority,
            IsActive        AS isActive,
            Notes           AS notes
    FROM dbo.SA_DepartmentMappingRule
    ORDER BY Priority, RuleId;
END
GO

/* Danh sách bộ phận nhỏ THẬT trong BioStar kèm trạng thái đã/chưa ánh xạ.
   Dùng cho màn hình "Ánh Xạ Bộ Phận" để thấy bộ phận nào còn rơi vào 'Khác'. */
CREATE PROCEDURE dbo.SA_SmallDepartment_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  d.sName                                   AS smallDepartment,
            ISNULL(m.LargeDeptCode, N'Khác')          AS largeDepartment,
            CAST(CASE WHEN m.MappingId IS NULL THEN 0 ELSE 1 END AS bit) AS isMapped,
            COUNT(u.nUserIdn)                         AS userCount
    FROM BioStar.dbo.TB_USER_DEPT d
    LEFT JOIN BioStar.dbo.TB_USER u
           ON u.nDepartmentIdn = d.nDepartmentIdn
    LEFT JOIN dbo.SA_DepartmentMapping m
           ON m.SmallDepartment = d.sName COLLATE DATABASE_DEFAULT
    GROUP BY d.sName, m.LargeDeptCode, m.MappingId
    ORDER BY d.sName;
END
GO

CREATE PROCEDURE dbo.SA_Shift_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  ShiftCode                        AS code,
            ShiftName                        AS name,
            /* Tên ca trên bảng kê nhà ăn ("23H", "12H"…); chưa đặt thì hiện
               luôn mã ca để giao diện không ra chuỗi rỗng. */
            ISNULL(ShiftReName, ShiftCode)   AS ShiftReName,
            CONVERT(char(8), StartTime, 108) AS startTime,
            CONVERT(char(8), EndTime,   108) AS endTime,
            WrapsMidnight                    AS wrapsMidnight,
            Description                      AS description
    FROM dbo.SA_Shift
    WHERE IsActive = 1
    ORDER BY SortOrder;
END
GO

CREATE PROCEDURE dbo.SA_Reader_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  ReaderIdn       AS id,
            ReaderCode      AS code,
            ReaderName      AS name,
            IP              AS ip,
            Location        AS location,
            IsKoreanMachine AS isKoreanMachine
    FROM dbo.SA_Reader
    WHERE IsActive = 1
    /* TA-104 / TA-103 / TA-102 — nhà ăn K trước, nhà ăn Hàn sau, giống thứ tự
       đang chạy trên server. */
    ORDER BY ReaderCode DESC;
END
GO

CREATE PROCEDURE dbo.SA_MealPrice_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  CAST(PriceId AS varchar(20))  AS id,
            Code                          AS code,
            Name                          AS name,
            CAST(UnitPrice AS float)      AS unitPrice,
            Unit                          AS unit,
            Notes                         AS notes
    FROM dbo.SA_MealPrice
    WHERE IsActive = 1
    ORDER BY PriceId;
END
GO

/* Loại suất áp cho từng (ca, nhóm nhân sự). Thiếu dòng nào thì client rơi về
   quy tắc mặc định trong classifyMeal. */
CREATE PROCEDURE dbo.SA_ShiftMealCategory_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  ShiftCode    AS shiftCode,
            StaffType    AS staffType,
            MealCategory AS mealCategory
    FROM dbo.SA_ShiftMealCategory
    ORDER BY ShiftCode, StaffType;
END
GO

CREATE PROCEDURE dbo.SA_SystemSetting_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT SettingKey AS [key], SettingValue AS value, DataType AS dataType, Description AS description
    FROM dbo.SA_SystemSetting
    ORDER BY SettingKey;
END
GO

CREATE PROCEDURE dbo.SA_MonthlyCost_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  CostMonth                  AS costMonth,
            Label                      AS month,
            CAST(ComHan      AS float) AS ComHan,
            CAST(ComViet     AS float) AS ComViet,
            CAST(DoUong      AS float) AS DoUong,
            CAST(SuatNhe1    AS float) AS SuatNhe1,
            CAST(SuatNhe2    AS float) AS SuatNhe2,
            CAST(MyHan       AS float) AS MyHan,
            CAST(SuatDacBiet AS float) AS SuatDacBiet,
            CAST(TotalSum    AS float) AS [Sum]
    FROM dbo.SA_MonthlyCost
    ORDER BY CostMonth;
END
GO

/* Gom toàn bộ danh mục khởi động ứng dụng vào 1 lượt gọi (nhiều result set). */
CREATE PROCEDURE dbo.SA_Bootstrap_GetConfig
AS
BEGIN
    SET NOCOUNT ON;
    EXEC dbo.SA_Shift_Get;              -- 0
    EXEC dbo.SA_Reader_Get;             -- 1
    EXEC dbo.SA_LargeDepartment_Get;    -- 2
    EXEC dbo.SA_DepartmentMapping_Get;  -- 3
    EXEC dbo.SA_MealPrice_Get;          -- 4
    EXEC dbo.SA_SystemSetting_Get;      -- 5
    EXEC dbo.SA_MonthlyCost_Get;        -- 6
    EXEC dbo.SA_ShiftMealCategory_Get;  -- 7
END
GO

/* ===========================================================================
   ÁNH XẠ BỘ PHẬN — thêm / sửa / xoá
   =========================================================================== */

CREATE PROCEDURE dbo.SA_DepartmentMapping_Save
    @SmallDepartment nvarchar(64),
    @LargeDeptCode   nvarchar(32),
    @Notes           nvarchar(255) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    SET @SmallDepartment = LTRIM(RTRIM(@SmallDepartment));

    IF @SmallDepartment IS NULL OR @SmallDepartment = N''
    BEGIN
        RAISERROR (N'Tên bộ phận nhỏ không được để trống.', 16, 1);
        RETURN;
    END

    IF NOT EXISTS (SELECT 1 FROM dbo.SA_LargeDepartment WHERE LargeDeptCode = @LargeDeptCode)
    BEGIN
        RAISERROR (N'Bộ phận lớn "%s" không tồn tại.', 16, 1, @LargeDeptCode);
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.SA_DepartmentMapping WHERE SmallDepartment = @SmallDepartment)
        UPDATE dbo.SA_DepartmentMapping
           SET LargeDeptCode = @LargeDeptCode,
               Notes         = @Notes,
               UpdatedAt     = SYSDATETIME()
         WHERE SmallDepartment = @SmallDepartment;
    ELSE
        INSERT INTO dbo.SA_DepartmentMapping (SmallDepartment, LargeDeptCode, Notes)
        VALUES (@SmallDepartment, @LargeDeptCode, @Notes);

    EXEC dbo.SA_DepartmentMapping_Get;
END
GO

CREATE PROCEDURE dbo.SA_DepartmentMapping_Delete
    @SmallDepartment nvarchar(64)
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM dbo.SA_DepartmentMapping WHERE SmallDepartment = @SmallDepartment;
    EXEC dbo.SA_DepartmentMapping_Get;
END
GO

/* ===========================================================================
   SỮA — đọc / thêm sửa / xoá
   =========================================================================== */

CREATE PROCEDURE dbo.SA_MilkEntry_Get
    @FromDate date = NULL,
    @ToDate   date = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  CAST(MilkId AS varchar(20))        AS id,
            CONVERT(char(10), EntryDate, 23)   AS date,
            MilkShift                          AS milkShift,
            MilkType                           AS milkType,
            Quantity                           AS quantity,
            CAST(UnitPrice   AS float)         AS unitPrice,
            CAST(TotalAmount AS float)         AS totalAmount,
            Supplier                           AS supplier,
            Notes                              AS notes
    FROM dbo.SA_MilkEntry
    WHERE (@FromDate IS NULL OR EntryDate >= @FromDate)
      AND (@ToDate   IS NULL OR EntryDate <= @ToDate)
    ORDER BY EntryDate DESC, MilkId DESC;
END
GO

CREATE PROCEDURE dbo.SA_MilkEntry_Save
    @MilkId    int = NULL,
    @EntryDate date,
    @MilkShift varchar(4) = 'NGAY',
    @MilkType  nvarchar(128),
    @Quantity  int,
    @UnitPrice decimal(18,2),
    @Supplier  nvarchar(128) = NULL,
    @Notes     nvarchar(500) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @Quantity IS NULL OR @Quantity <= 0
    BEGIN
        RAISERROR (N'Số lượng sữa phải lớn hơn 0.', 16, 1);
        RETURN;
    END

    SET @MilkShift = NULLIF(LTRIM(RTRIM(@MilkShift)), '');
    IF @MilkShift IS NULL SET @MilkShift = 'NGAY';

    IF @MilkShift NOT IN ('NGAY', 'DEM')
    BEGIN
        RAISERROR (N'Ca cấp sữa chỉ nhận "NGAY" (Ca ngày) hoặc "DEM" (Ca đêm).', 16, 1);
        RETURN;
    END

    IF @MilkId IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.SA_MilkEntry WHERE MilkId = @MilkId)
    BEGIN
        INSERT INTO dbo.SA_MilkEntry (EntryDate, MilkShift, MilkType, Quantity, UnitPrice, Supplier, Notes)
        VALUES (@EntryDate, @MilkShift, @MilkType, @Quantity, @UnitPrice, @Supplier, @Notes);
        SET @MilkId = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        UPDATE dbo.SA_MilkEntry
           SET EntryDate = @EntryDate,
               MilkShift = @MilkShift,
               MilkType  = @MilkType,
               Quantity  = @Quantity,
               UnitPrice = @UnitPrice,
               Supplier  = @Supplier,
               Notes     = @Notes
         WHERE MilkId = @MilkId;
    END

    SELECT  CAST(MilkId AS varchar(20))      AS id,
            CONVERT(char(10), EntryDate, 23) AS date,
            MilkShift                        AS milkShift,
            MilkType                         AS milkType,
            Quantity                         AS quantity,
            CAST(UnitPrice   AS float)       AS unitPrice,
            CAST(TotalAmount AS float)       AS totalAmount,
            Supplier                         AS supplier,
            Notes                            AS notes
    FROM dbo.SA_MilkEntry
    WHERE MilkId = @MilkId;
END
GO

CREATE PROCEDURE dbo.SA_MilkEntry_Delete
    @MilkId int
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM dbo.SA_MilkEntry WHERE MilkId = @MilkId;
    SELECT @@ROWCOUNT AS deleted;
END
GO

/* ===========================================================================
   CHI PHÍ PHÁT SINH — đọc / thêm sửa / xoá
   ---------------------------------------------------------------------------
   Song song với ba proc SỮA ở trên; giữ nguyên hình dạng để hai domain lên
   bảng kê theo cùng một cách.
   =========================================================================== */

CREATE PROCEDURE dbo.SA_ExtraCost_Get
    @FromDate date = NULL,
    @ToDate   date = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  CAST(ExtraId AS varchar(20))       AS id,
            CONVERT(char(10), EntryDate, 23)   AS date,
            CostShift                          AS costShift,
            CostType                           AS costType,
            Quantity                           AS quantity,
            CAST(UnitPrice   AS float)         AS unitPrice,
            CAST(TotalAmount AS float)         AS totalAmount,
            Supplier                           AS supplier,
            Notes                              AS notes
    FROM dbo.SA_ExtraCost
    WHERE (@FromDate IS NULL OR EntryDate >= @FromDate)
      AND (@ToDate   IS NULL OR EntryDate <= @ToDate)
    ORDER BY EntryDate DESC, ExtraId DESC;
END
GO

CREATE PROCEDURE dbo.SA_ExtraCost_Save
    @ExtraId   int = NULL,
    @EntryDate date,
    @CostShift varchar(4) = 'NGAY',
    @CostType  nvarchar(128),
    @Quantity  int,
    @UnitPrice decimal(18,2),
    @Supplier  nvarchar(128) = NULL,
    @Notes     nvarchar(500) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @Quantity IS NULL OR @Quantity <= 0
    BEGIN
        RAISERROR (N'Số lượng chi phí phát sinh phải lớn hơn 0.', 16, 1);
        RETURN;
    END

    SET @CostType = NULLIF(LTRIM(RTRIM(@CostType)), N'');
    IF @CostType IS NULL
    BEGIN
        RAISERROR (N'Thiếu tên hạng mục chi phí phát sinh.', 16, 1);
        RETURN;
    END

    SET @CostShift = NULLIF(LTRIM(RTRIM(@CostShift)), '');
    IF @CostShift IS NULL SET @CostShift = 'NGAY';

    IF @CostShift NOT IN ('NGAY', 'DEM')
    BEGIN
        RAISERROR (N'Ca cấp phát chỉ nhận "NGAY" (Ca ngày) hoặc "DEM" (Ca đêm).', 16, 1);
        RETURN;
    END

    IF @ExtraId IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.SA_ExtraCost WHERE ExtraId = @ExtraId)
    BEGIN
        INSERT INTO dbo.SA_ExtraCost (EntryDate, CostShift, CostType, Quantity, UnitPrice, Supplier, Notes)
        VALUES (@EntryDate, @CostShift, @CostType, @Quantity, @UnitPrice, @Supplier, @Notes);
        SET @ExtraId = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        UPDATE dbo.SA_ExtraCost
           SET EntryDate = @EntryDate,
               CostShift = @CostShift,
               CostType  = @CostType,
               Quantity  = @Quantity,
               UnitPrice = @UnitPrice,
               Supplier  = @Supplier,
               Notes     = @Notes
         WHERE ExtraId = @ExtraId;
    END

    SELECT  CAST(ExtraId AS varchar(20))     AS id,
            CONVERT(char(10), EntryDate, 23) AS date,
            CostShift                        AS costShift,
            CostType                         AS costType,
            Quantity                         AS quantity,
            CAST(UnitPrice   AS float)       AS unitPrice,
            CAST(TotalAmount AS float)       AS totalAmount,
            Supplier                         AS supplier,
            Notes                            AS notes
    FROM dbo.SA_ExtraCost
    WHERE ExtraId = @ExtraId;
END
GO

CREATE PROCEDURE dbo.SA_ExtraCost_Delete
    @ExtraId int
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM dbo.SA_ExtraCost WHERE ExtraId = @ExtraId;
    SELECT @@ROWCOUNT AS deleted;
END
GO

/* ===========================================================================
   CẤU HÌNH SINH NHẬT — đọc / thêm sửa / xoá
   =========================================================================== */

CREATE PROCEDURE dbo.SA_BirthdayConfig_Get
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  CAST(ConfigId AS varchar(20))         AS id,
            CONVERT(char(10), ConfigDate, 23)     AS date,
            Description                           AS description,
            CAST(SpecialMealPrice AS float)       AS specialMealPrice
    FROM dbo.SA_BirthdayConfig
    ORDER BY ConfigDate DESC;
END
GO

CREATE PROCEDURE dbo.SA_BirthdayConfig_Save
    @ConfigId         int = NULL,
    @ConfigDate       date,
    @Description      nvarchar(255) = NULL,
    @SpecialMealPrice decimal(18,2)
AS
BEGIN
    SET NOCOUNT ON;

    /* ConfigDate là UNIQUE — trùng ngày thì cập nhật thay vì báo lỗi. */
    IF @ConfigId IS NULL
        SELECT @ConfigId = ConfigId FROM dbo.SA_BirthdayConfig WHERE ConfigDate = @ConfigDate;

    IF @ConfigId IS NULL
    BEGIN
        INSERT INTO dbo.SA_BirthdayConfig (ConfigDate, Description, SpecialMealPrice)
        VALUES (@ConfigDate, @Description, @SpecialMealPrice);
        SET @ConfigId = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        UPDATE dbo.SA_BirthdayConfig
           SET ConfigDate       = @ConfigDate,
               Description      = @Description,
               SpecialMealPrice = @SpecialMealPrice
         WHERE ConfigId = @ConfigId;
    END

    SELECT  CAST(ConfigId AS varchar(20))     AS id,
            CONVERT(char(10), ConfigDate, 23) AS date,
            Description                       AS description,
            CAST(SpecialMealPrice AS float)   AS specialMealPrice
    FROM dbo.SA_BirthdayConfig
    WHERE ConfigId = @ConfigId;
END
GO

CREATE PROCEDURE dbo.SA_BirthdayConfig_Delete
    @ConfigId int
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM dbo.SA_BirthdayConfig WHERE ConfigId = @ConfigId;
    SELECT @@ROWCOUNT AS deleted;
END
GO

/* ===========================================================================
   NHẬP THỦ CÔNG — đọc / thêm sửa / xoá
   =========================================================================== */

CREATE PROCEDURE dbo.SA_ManualEntry_Get
    @FromDate date = NULL,
    @ToDate   date = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  CAST(EntryId AS varchar(20))            AS id,
            CONVERT(char(10), EntryDate, 23)        AS date,
            ShiftCode                               AS shiftCode,
            StaffType                               AS staffType,
            Department                              AS department,
            Quantity                                AS quantity,
            Reason                                  AS reason,
            EnteredBy                               AS enteredBy,
            CONVERT(char(19), CreatedAt, 120)       AS createdAt
    FROM dbo.SA_ManualEntry
    WHERE (@FromDate IS NULL OR EntryDate >= @FromDate)
      AND (@ToDate   IS NULL OR EntryDate <= @ToDate)
    ORDER BY EntryDate DESC, EntryId DESC;
END
GO

CREATE PROCEDURE dbo.SA_ManualEntry_Save
    @EntryId    int = NULL,
    @EntryDate  date,
    @ShiftCode  nvarchar(10),
    @StaffType  varchar(2) = 'VN',
    @Department nvarchar(64),
    @Quantity   int,
    @Reason     nvarchar(500) = NULL,
    @EnteredBy  nvarchar(128) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @Quantity IS NULL OR @Quantity <= 0
    BEGIN
        RAISERROR (N'Số lượng suất ăn phải lớn hơn 0.', 16, 1);
        RETURN;
    END

    SET @StaffType = NULLIF(LTRIM(RTRIM(@StaffType)), '');
    IF @StaffType IS NULL SET @StaffType = 'VN';

    IF @StaffType NOT IN ('KR', 'VN')
    BEGIN
        RAISERROR (N'Nhóm nhân sự chỉ nhận "KR" (Người Hàn) hoặc "VN" (Người Việt).', 16, 1);
        RETURN;
    END

    IF @EntryId IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.SA_ManualEntry WHERE EntryId = @EntryId)
    BEGIN
        INSERT INTO dbo.SA_ManualEntry (EntryDate, ShiftCode, StaffType, Department, Quantity, Reason, EnteredBy)
        VALUES (@EntryDate, @ShiftCode, @StaffType, @Department, @Quantity, @Reason, @EnteredBy);
        SET @EntryId = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        UPDATE dbo.SA_ManualEntry
           SET EntryDate  = @EntryDate,
               ShiftCode  = @ShiftCode,
               StaffType  = @StaffType,
               Department = @Department,
               Quantity   = @Quantity,
               Reason     = @Reason,
               EnteredBy  = @EnteredBy
         WHERE EntryId = @EntryId;
    END

    SELECT  CAST(EntryId AS varchar(20))      AS id,
            CONVERT(char(10), EntryDate, 23)  AS date,
            ShiftCode                         AS shiftCode,
            StaffType                         AS staffType,
            Department                        AS department,
            Quantity                          AS quantity,
            Reason                            AS reason,
            EnteredBy                         AS enteredBy,
            CONVERT(char(19), CreatedAt, 120) AS createdAt
    FROM dbo.SA_ManualEntry
    WHERE EntryId = @EntryId;
END
GO

CREATE PROCEDURE dbo.SA_ManualEntry_Delete
    @EntryId int
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM dbo.SA_ManualEntry WHERE EntryId = @EntryId;
    SELECT @@ROWCOUNT AS deleted;
END
GO

/* ===========================================================================
   TÀI KHOẢN & PHIÊN ĐĂNG NHẬP
   ---------------------------------------------------------------------------
   Server không tự sinh SQL, kể cả cho đăng nhập — mọi thao tác đi qua đây.
   Dạng lưu mật khẩu và việc sinh token nằm ở server/auth.js; các proc này chỉ
   đọc ghi chuỗi đã chuẩn bị sẵn.
   =========================================================================== */

CREATE PROCEDURE dbo.SA_User_GetByName
    @Username varchar(64)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  UserId       AS userId,
            Username     AS username,
            DisplayName  AS displayName,
            Password     AS password,
            IsActive     AS isActive
    FROM dbo.SA_User
    WHERE Username = @Username;
END
GO

CREATE PROCEDURE dbo.SA_User_List
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  UserId      AS userId,
            Username    AS username,
            DisplayName AS displayName,
            /* Mật khẩu để dạng thường nên xem được luôn ở đây — chỉ dùng qua
               dòng lệnh trên máy chủ, KHÔNG có endpoint nào trả về nó. */
            Password    AS password,
            IsActive    AS isActive,
            CONVERT(char(19), CreatedAt, 120)   AS createdAt,
            CONVERT(char(19), LastLoginAt, 120) AS lastLoginAt
    FROM dbo.SA_User
    ORDER BY Username;
END
GO

/* Thêm mới hoặc đặt lại mật khẩu / trạng thái của một tài khoản. */
CREATE PROCEDURE dbo.SA_User_Save
    @Username     varchar(64),
    @DisplayName  nvarchar(128),
    @Password     varchar(256),
    @IsActive     bit = 1
AS
BEGIN
    SET NOCOUNT ON;

    SET @Username = LOWER(LTRIM(RTRIM(@Username)));
    IF @Username IS NULL OR @Username = ''
    BEGIN
        RAISERROR (N'Thiếu tên đăng nhập.', 16, 1);
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.SA_User WHERE Username = @Username)
    BEGIN
        UPDATE dbo.SA_User
           SET DisplayName = @DisplayName,
               Password    = @Password,
               IsActive    = @IsActive
         WHERE Username = @Username;

        /* Đổi mật khẩu thì mọi phiên cũ phải chết — nếu không, người bị lộ
           mật khẩu vẫn còn phiên đang mở và việc đổi mật khẩu thành vô nghĩa. */
        DELETE s
        FROM dbo.SA_Session s
        INNER JOIN dbo.SA_User u ON u.UserId = s.UserId
        WHERE u.Username = @Username;
    END
    ELSE
    BEGIN
        INSERT INTO dbo.SA_User (Username, DisplayName, Password, IsActive)
        VALUES (@Username, @DisplayName, @Password, @IsActive);
    END

    SELECT  UserId      AS userId,
            Username    AS username,
            DisplayName AS displayName,
            IsActive    AS isActive
    FROM dbo.SA_User
    WHERE Username = @Username;
END
GO

CREATE PROCEDURE dbo.SA_Session_Create
    @TokenHash char(64),
    @UserId    int,
    @ExpiresAt datetime2(0),
    @UserAgent nvarchar(256) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    INSERT INTO dbo.SA_Session (TokenHash, UserId, ExpiresAt, UserAgent)
    VALUES (@TokenHash, @UserId, @ExpiresAt, @UserAgent);

    UPDATE dbo.SA_User SET LastLoginAt = SYSDATETIME() WHERE UserId = @UserId;

    /* Dọn phiên hết hạn ngay lúc đăng nhập: không cần job nền, và bảng không
       phình theo thời gian. */
    DELETE FROM dbo.SA_Session WHERE ExpiresAt < SYSDATETIME();
END
GO

/* Trả về chủ phiên nếu token còn hiệu lực và tài khoản còn hoạt động. */
CREATE PROCEDURE dbo.SA_Session_Get
    @TokenHash char(64)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT  u.UserId                              AS userId,
            u.Username                            AS username,
            u.DisplayName                         AS displayName,
            CONVERT(char(19), s.ExpiresAt, 120)   AS expiresAt
    FROM dbo.SA_Session s
    INNER JOIN dbo.SA_User u ON u.UserId = s.UserId
    WHERE s.TokenHash = @TokenHash
      AND s.ExpiresAt > SYSDATETIME()
      AND u.IsActive = 1;
END
GO

CREATE PROCEDURE dbo.SA_Session_Delete
    @TokenHash char(64)
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM dbo.SA_Session WHERE TokenHash = @TokenHash;
    SELECT @@ROWCOUNT AS deleted;
END
GO

/* ===========================================================================
   THAM SỐ HỆ THỐNG — ghi
   =========================================================================== */

CREATE PROCEDURE dbo.SA_SystemSetting_Save
    @SettingKey   varchar(64),
    @SettingValue nvarchar(500)
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS (SELECT 1 FROM dbo.SA_SystemSetting WHERE SettingKey = @SettingKey)
        UPDATE dbo.SA_SystemSetting
           SET SettingValue = @SettingValue, UpdatedAt = SYSDATETIME()
         WHERE SettingKey = @SettingKey;
    ELSE
        INSERT INTO dbo.SA_SystemSetting (SettingKey, SettingValue)
        VALUES (@SettingKey, @SettingValue);

    EXEC dbo.SA_SystemSetting_Get;
END
GO

/* ===========================================================================
   ĐƠN GIÁ SUẤT ĂN — ghi

   Chỉ SỬA đơn giá của một mã đã có trong danh mục. Mã giá là hợp đồng giữa
   SA_MealPrice và cả hai nơi tính tiền (buildMealPricing ở client,
   SA_MealCost_GetMonthly ở đây) nên không cho thêm mã mới từ giao diện —
   thêm mã mà không có nơi nào đọc thì chỉ tạo dữ liệu chết.
   =========================================================================== */
CREATE PROCEDURE dbo.SA_MealPrice_Save
    @Code      varchar(32),
    @UnitPrice decimal(18,2)
AS
BEGIN
    SET NOCOUNT ON;

    SET @Code = LTRIM(RTRIM(@Code));

    IF @Code IS NULL OR @Code = ''
    BEGIN
        RAISERROR (N'Thiếu mã đơn giá.', 16, 1);
        RETURN;
    END

    IF @UnitPrice IS NULL OR @UnitPrice < 0
    BEGIN
        RAISERROR (N'Đơn giá phải là số không âm (VNĐ).', 16, 1);
        RETURN;
    END

    IF NOT EXISTS (SELECT 1 FROM dbo.SA_MealPrice WHERE Code = @Code AND IsActive = 1)
    BEGIN
        /* %s trong thông điệp nvarchar phải nhận đối số nvarchar, nếu không
           SQL Server in ra ký tự rác. @Code là varchar nên phải đổi kiểu. */
        DECLARE @CodeText nvarchar(32) = CAST(@Code AS nvarchar(32));
        RAISERROR (N'Không tìm thấy mã đơn giá "%s" trong danh mục.', 16, 1, @CodeText);
        RETURN;
    END

    UPDATE dbo.SA_MealPrice
       SET UnitPrice = @UnitPrice
     WHERE Code = @Code;

    EXEC dbo.SA_MealPrice_Get;
END
GO

/* ===========================================================================
   SA_ShiftMealCategory_Save — Gán loại suất cho một (ca, nhóm nhân sự).

   Người dùng được gán TỰ DO trong 5 loại suất, kể cả gán suất Hàn cho người
   Việt: đây là bảng cấu hình giá, không phải bảng quy tắc quốc tịch.
   =========================================================================== */
CREATE PROCEDURE dbo.SA_ShiftMealCategory_Save
    @ShiftCode    nvarchar(10),
    @StaffType    varchar(2),
    @MealCategory varchar(16)
AS
BEGIN
    SET NOCOUNT ON;

    SET @ShiftCode    = LTRIM(RTRIM(@ShiftCode));
    SET @StaffType    = LTRIM(RTRIM(@StaffType));
    SET @MealCategory = LTRIM(RTRIM(@MealCategory));

    IF @ShiftCode IS NULL OR @ShiftCode = ''
    BEGIN
        RAISERROR (N'Thiếu mã ca.', 16, 1);
        RETURN;
    END

    /* Chỉ nhận ca đang hoạt động, cộng thêm N'Khác' cho lượt quẹt ngoài ca. */
    IF @ShiftCode <> N'Khác'
       AND NOT EXISTS (SELECT 1 FROM dbo.SA_Shift WHERE ShiftCode = @ShiftCode AND IsActive = 1)
    BEGIN
        DECLARE @ShiftText nvarchar(10) = @ShiftCode;
        RAISERROR (N'Không tìm thấy ca "%s".', 16, 1, @ShiftText);
        RETURN;
    END

    IF @StaffType NOT IN ('KR', 'VN')
    BEGIN
        RAISERROR (N'Nhóm nhân sự phải là "KR" (người Hàn) hoặc "VN" (người Việt).', 16, 1);
        RETURN;
    END

    IF @MealCategory NOT IN ('KO_COM', 'KO_MY', 'VN_CHINH', 'VN_PHU', 'VN_SINHNHAT')
    BEGIN
        RAISERROR (N'Loại suất ăn không hợp lệ.', 16, 1);
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.SA_ShiftMealCategory
               WHERE ShiftCode = @ShiftCode AND StaffType = @StaffType)
        UPDATE dbo.SA_ShiftMealCategory
           SET MealCategory = @MealCategory, UpdatedAt = SYSDATETIME()
         WHERE ShiftCode = @ShiftCode AND StaffType = @StaffType;
    ELSE
        INSERT INTO dbo.SA_ShiftMealCategory (ShiftCode, StaffType, MealCategory)
        VALUES (@ShiftCode, @StaffType, @MealCategory);

    EXEC dbo.SA_ShiftMealCategory_Get;
END
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

/* ===========================================================================
   LƯỢT QUẸT ĐÃ XOÁ — xoá / xem lại / khôi phục
   ---------------------------------------------------------------------------
   Popup "Điều Chỉnh Số Liệu" của tab Báo Cáo Chi Phí chốt số với nhà ăn bằng
   cách BỎ HẲN một số lượt quẹt (quẹt trùng ca, quẹt vượt hạn mức, hoặc số
   suất người dùng tự nhập). Việc đó ghi xuống cơ sở dữ liệu và áp cho toàn hệ
   thống, không còn là chỉnh hiển thị của riêng một tab.

   Dòng gốc bên BioStar.dbo.TB_EVENT_LOG KHÔNG bị đụng tới (database đó là
   read-only). Bản sao đầy đủ của dòng bị xoá nằm ở dbo.TB_EVENT_LOG_DEL, và
   hai procedure đọc log đều loại trừ theo bảng đó.

   Mỗi lần bấm "Áp dụng" là MỘT LƯỢT XOÁ (@BatchId): xem lại và khôi phục đều
   theo lượt, nên một lần chốt nhầm gỡ lại được nguyên vẹn.

   Một lượt xoá có thể gồm hai loại dòng (cột DeleteKind):
     @LossIds -> 'MAT_MAT': suất mất mát do chấm thẻ sai. Bị trừ khỏi mọi con
                 số nhưng tab Suất Ăn Mất Mát vẫn hiển thị y nguyên.
     @Ids     -> 'BAT_KY' : khoản "xoá suất ăn bất kỳ". Biến mất khỏi tất cả.
   =========================================================================== */

CREATE PROCEDURE dbo.SA_MealLogDeleted_Save
    /* Khoản "xoá suất ăn bất kỳ" — DeleteKind = 'BAT_KY'. */
    @Ids          dbo.SA_EventIdList READONLY,
    /* Suất mất mát do chấm thẻ sai — DeleteKind = 'MAT_MAT'. Tham số bảng
       không truyền thì là bảng rỗng, nên client cũ gọi chỉ với @Ids vẫn chạy. */
    @LossIds      dbo.SA_EventIdList READONLY,
    @Reason       nvarchar(255) = NULL,
    @UserName     nvarchar(128) = NULL,
    /* Khoảng thời điểm chứa các lượt quẹt này — CHỈ để thu hẹp vùng quét.
       nEventLogIdn KHÔNG có index bên BioStar (clustered PK là
       (nDateTime, nEventIdn, nReaderIdn, nUserID)), nên nếu không có khoảng
       thì câu INSERT phải quét cả 3,3 triệu dòng. Người dùng luôn xoá trong
       khoảng lọc đang xem nên client truyền được hai biên này. Bỏ trống thì
       vẫn chạy đúng, chỉ chậm. */
    @FromDateTime datetime2(0) = NULL,
    @ToDateTime   datetime2(0) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (SELECT 1 FROM @Ids) AND NOT EXISTS (SELECT 1 FROM @LossIds)
    BEGIN
        RAISERROR (N'Không có lượt quẹt nào để xoá.', 16, 1);
        RETURN;
    END

    /* Gộp hai danh sách, mỗi id một loại. Id có mặt ở cả hai (client không
       gửi như vậy) tính là mất mát — loại hẹp hơn, vẫn hiện ở tab Mất Mát. */
    CREATE TABLE #Pick
    (
        EventLogIdn int        NOT NULL PRIMARY KEY,
        DeleteKind  varchar(8) NOT NULL
    );

    INSERT INTO #Pick (EventLogIdn, DeleteKind)
    SELECT EventLogIdn, 'MAT_MAT' FROM @LossIds;

    INSERT INTO #Pick (EventLogIdn, DeleteKind)
    SELECT i.EventLogIdn, 'BAT_KY'
    FROM @Ids i
    WHERE NOT EXISTS (SELECT 1 FROM #Pick p WHERE p.EventLogIdn = i.EventLogIdn);

    DECLARE @FromEpoch int =
        CASE WHEN @FromDateTime IS NULL THEN -2147483648
             ELSE DATEDIFF(SECOND, '1970-01-01', @FromDateTime) END;
    DECLARE @ToEpoch int =
        CASE WHEN @ToDateTime IS NULL THEN 2147483647
             ELSE DATEDIFF(SECOND, '1970-01-01', @ToDateTime) END;

    DECLARE @BatchId uniqueidentifier = NEWID();

    /* Chép nguyên dòng từ BioStar sang. Dòng đã bị xoá trước đó thì bỏ qua
       (NOT EXISTS) — bấm áp dụng hai lần không được đếm thành hai lượt xoá. */
    INSERT INTO dbo.TB_EVENT_LOG_DEL
        (nEventLogIdn, nDateTime, nReaderIdn, nEventIdn, nUserID,
         nIsLog, nTNAEvent, nIsUseTA, nType,
         DeleteBatchId, DeletedBy, DeleteReason, DeleteKind)
    SELECT  e.nEventLogIdn, e.nDateTime, e.nReaderIdn, e.nEventIdn, e.nUserID,
            e.nIsLog, e.nTNAEvent, e.nIsUseTA, e.nType,
            @BatchId, @UserName, @Reason, i.DeleteKind
    FROM BioStar.dbo.TB_EVENT_LOG e
    INNER JOIN #Pick i ON i.EventLogIdn = e.nEventLogIdn
    WHERE e.nDateTime BETWEEN @FromEpoch AND @ToEpoch
      AND NOT EXISTS (SELECT 1 FROM dbo.TB_EVENT_LOG_DEL dl
                      WHERE dl.nEventLogIdn = e.nEventLogIdn);

    DECLARE @Deleted int = @@ROWCOUNT;

    IF @Deleted = 0
    BEGIN
        RAISERROR (N'Các lượt quẹt được chọn đã bị xoá từ trước, hoặc không nằm trong khoảng thời gian đã truyền xuống.', 16, 1);
        RETURN;
    END

    SELECT  CAST(@BatchId AS varchar(36)) AS batchId,
            @Deleted                      AS deleted,
            (SELECT COUNT(*) FROM #Pick)  AS requested;

    DROP TABLE #Pick;
END
GO

CREATE PROCEDURE dbo.SA_MealLogDeleted_Get
    @FromDate date = NULL,
    @ToDate   date = NULL
AS
BEGIN
    SET NOCOUNT ON;

    /* Lọc theo NGÀY QUẸT chứ không theo ngày xoá: người dùng đang xem một
       khoảng lọc và muốn biết khoảng đó đã bỏ đi những gì. Đổi ngày sang
       epoch để dùng được IX_TB_EVENT_LOG_DEL_DateTime. */
    DECLARE @FromEpoch int =
        CASE WHEN @FromDate IS NULL THEN NULL
             ELSE DATEDIFF(SECOND, '1970-01-01', CAST(@FromDate AS datetime2(0))) END;
    DECLARE @ToEpoch int =
        CASE WHEN @ToDate IS NULL THEN NULL
             ELSE DATEDIFF(SECOND, '1970-01-01', CAST(DATEADD(DAY, 1, @ToDate) AS datetime2(0))) - 1 END;

    SELECT  CAST(dl.DeleteBatchId AS varchar(36))                        AS batchId,
            CONVERT(char(19), MIN(dl.DeletedAt), 120)                    AS deletedAt,
            MIN(dl.DeletedBy)                                            AS deletedBy,
            MIN(dl.DeleteReason)                                         AS reason,
            COUNT(*)                                                     AS punchCount,
            /* Bao nhiêu dòng là suất mất mát (vẫn hiện ở tab Suất Ăn Mất Mát). */
            SUM(CASE WHEN dl.DeleteKind = 'MAT_MAT' THEN 1 ELSE 0 END)   AS lossPunchCount,
            CONVERT(char(19), DATEADD(SECOND, MIN(dl.nDateTime),
                    CAST('1970-01-01' AS datetime2(0))), 120)            AS firstPunchAt,
            CONVERT(char(19), DATEADD(SECOND, MAX(dl.nDateTime),
                    CAST('1970-01-01' AS datetime2(0))), 120)            AS lastPunchAt,
            /* Số lượt của lượt xoá này nằm TRONG khoảng đang lọc — lượt xoá
               có thể trải rộng hơn khoảng người dùng đang xem. */
            SUM(CASE WHEN (@FromEpoch IS NULL OR dl.nDateTime >= @FromEpoch)
                      AND (@ToEpoch   IS NULL OR dl.nDateTime <= @ToEpoch)
                     THEN 1 ELSE 0 END)                                  AS punchCountInRange
    FROM dbo.TB_EVENT_LOG_DEL dl
    GROUP BY dl.DeleteBatchId
    HAVING @FromEpoch IS NULL
        OR @ToEpoch   IS NULL
        OR SUM(CASE WHEN dl.nDateTime BETWEEN @FromEpoch AND @ToEpoch THEN 1 ELSE 0 END) > 0
    ORDER BY MIN(dl.DeletedAt) DESC;
END
GO

CREATE PROCEDURE dbo.SA_MealLogDeleted_Restore
    @BatchId uniqueidentifier
AS
BEGIN
    SET NOCOUNT ON;

    IF @BatchId IS NULL
    BEGIN
        RAISERROR (N'Thiếu mã lượt xoá cần khôi phục.', 16, 1);
        RETURN;
    END

    /* Dòng gốc chưa bao giờ rời BioStar, nên khôi phục chỉ là gạch tên khỏi
       sổ loại. Nếu một ngày nào đó phải phục hồi cả dòng gốc thì dùng câu
       INSERT ghi trong chú thích của bảng ở 01_schema.sql — bảng này giữ đủ
       chín cột để làm việc đó. */
    DELETE FROM dbo.TB_EVENT_LOG_DEL WHERE DeleteBatchId = @BatchId;

    DECLARE @Restored int = @@ROWCOUNT;

    IF @Restored = 0
    BEGIN
        RAISERROR (N'Không tìm thấy lượt xoá này — có thể nó đã được khôi phục rồi.', 16, 1);
        RETURN;
    END

    SELECT @Restored AS restored;
END
GO

/* ===========================================================================
   KHÁCH CÔNG TÁC — gán lại bộ phận lớn cho từng người
   ---------------------------------------------------------------------------
   Rule "Khach cong tac + tên chứa 'Business' -> KR" quét cả nhóm. Nhưng khách
   công tác là thẻ dùng chung: mỗi người khách làm việc với một bộ phận khác
   nhau, và suất ăn của họ phải tính vào đúng bộ phận đó, theo đúng giá của bộ
   phận đó. Ba procedure dưới đây quản lý các ngoại lệ theo từng người.

   PHẠM VI: chỉ những người CÓ RULE QUÉT VÀO (SA_UserDeptResolved.IsRuleMatched
   = 1) — hôm nay đúng là nhóm khách công tác 'Business'. _Save từ chối mọi
   người khác, nên không lách qua API để đổi bộ phận của nhân viên chính thức
   được. Điều kiện lấy từ view chứ không viết cứng chuỗi 'Business': rule là
   dữ liệu người dùng sửa được.

   Đổi bộ phận lớn là đổi luôn nhóm giá — StaffType = 'KR' khi và chỉ khi bộ
   phận lớn là KR — nên chuyển một khách sang SP là suất của họ tính theo giá
   người Việt, ở cả bảng kê lẫn biểu đồ 12 tháng, không phải sửa gì thêm.

   MỖI KHÁCH NHIỀU ĐỢT: một dòng SA_GuestDeptOverride là MỘT ĐỢT
   (khoảng ngày → bộ phận). _Save luôn THÊM một đợt mới chứ không ghi đè đợt
   cũ, và _Delete xoá theo OverrideId chứ không theo mã thẻ. Nhờ vậy khách A
   có thể có 01-10/08 vào SP, 11-20/08 vào LFEM, 01-15/09 vào QC — ba dòng độc
   lập, và một khoảng lọc trải qua cả ba tự tách đúng từng đoạn khi tính tiền.

   HAI ĐỢT CỦA CÙNG MỘT KHÁCH KHÔNG ĐƯỢC GIAO NHAU. _Save kiểm điều đó và
   RAISERROR kèm tên đợt bị đụng — giao diện cũng kiểm cho người dùng biết
   sớm, nhưng procedure mới là chỗ quyết định: API không được tin client.

   @EffectiveFrom / @EffectiveTo để trống = không giới hạn đầu đó; để trống cả
   hai = vĩnh viễn (đúng hành vi của những dòng có từ trước khi bảng biết đến
   thời hạn). Không giới hạn gì về quá khứ: đang tháng 9 vẫn tạo được đợt của
   tháng 8, và số liệu tháng 8 tính lại ngay.
   =========================================================================== */

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

/* ===========================================================================
   Chi phí thuê nhân công

   Ba bảng, ba vai trò khác hẳn nhau — xem khối chú thích mục 17 của
   01_schema.sql:
     SA_LaborCost        = bản nháp, KHÔNG báo cáo nào đọc.
     SA_LaborCostBatch   = một dòng mỗi lần bấm "Áp dụng".
     SA_LaborCostApplied = bản chụp các dòng nháp của lượt đó — báo cáo chỉ
                           đọc bản chụp của lượt MỚI NHẤT.

   Khoảng ngày là NỬA MỞ [EffectiveFrom, EffectiveTo): ngày bắt đầu được tính,
   ngày kết thúc thì không. Nhờ vậy 25/07→25/08 và 25/08→25/09 viết liền nhau
   được mà ngày 25/08 chỉ thuộc đúng một đợt.

   Việc CHIA TIỀN THEO NGÀY LÀM VIỆC không nằm ở đây: nó là `buildLaborSegments`
   trong src/components/financial/reportModel.ts, dùng chung cho bảng trên web,
   file Excel tổng hợp và cả bảng 12 tháng — một bản duy nhất nên không có chỗ
   nào lệch được.
   =========================================================================== */

CREATE PROCEDURE dbo.SA_LaborCost_Get
AS
BEGIN
    SET NOCOUNT ON;

    /* --- Result set 1: BẢN NHÁP ------------------------------------------
       Ngày trả về dạng chuỗi 'YYYY-MM-DD' như mọi ngày khác trong hệ thống —
       bind kiểu date sẽ thành Date của JS và lệch múi giờ. */
    SELECT  d.LaborId                            AS id,
            d.WorkerName                         AS workerName,
            CONVERT(char(10), d.EffectiveFrom, 23) AS effectiveFrom,
            CONVERT(char(10), d.EffectiveTo,   23) AS effectiveTo,
            CONVERT(float, d.Amount)             AS amount,
            d.Notes                              AS notes,
            d.CostMonth                          AS costMonth,
            CONVERT(char(19), d.UpdatedAt, 120)  AS updatedAt
    FROM dbo.SA_LaborCost d
    ORDER BY d.WorkerName, d.EffectiveFrom, d.LaborId;

    /* --- Result set 2: LƯỢT ÁP DỤNG ĐANG CÓ HIỆU LỰC ---------------------
       Đúng MỘT dòng (hoặc không dòng nào, khi chưa từng áp dụng). Lượt mới
       nhất là lượt duy nhất báo cáo đọc: cộng hết mọi lượt thì bấm "Áp dụng"
       hai lần là tiền nhân đôi. */
    SELECT TOP (1)
            CONVERT(char(36), b.BatchId)         AS batchId,
            CONVERT(char(19), b.AppliedAt, 120)  AS appliedAt,
            b.AppliedBy                          AS appliedBy,
            b.WorkDayRule                        AS workDayRule,
            b.Notes                              AS notes,
            b.RowCountNum                        AS rowCountNum,
            CONVERT(float, b.TotalAmount)        AS totalAmount
    FROM dbo.SA_LaborCostBatch b
    ORDER BY b.AppliedAt DESC, b.BatchId DESC;

    /* --- Result set 3: các dòng của lượt đang có hiệu lực ----------------- */
    SELECT  a.AppliedId                          AS id,
            CONVERT(char(36), a.BatchId)         AS batchId,
            a.WorkerName                         AS workerName,
            CONVERT(char(10), a.EffectiveFrom, 23) AS effectiveFrom,
            CONVERT(char(10), a.EffectiveTo,   23) AS effectiveTo,
            CONVERT(float, a.Amount)             AS amount,
            a.Notes                              AS notes,
            a.CostMonth                          AS costMonth
    FROM dbo.SA_LaborCostApplied a
    WHERE a.BatchId = (SELECT TOP (1) b.BatchId
                       FROM dbo.SA_LaborCostBatch b
                       ORDER BY b.AppliedAt DESC, b.BatchId DESC)
    ORDER BY a.WorkerName, a.EffectiveFrom, a.AppliedId;

    /* --- Result set 4: LỊCH SỬ mọi lượt áp dụng --------------------------
       Trả về hết, mới nhất trước. Không lượt nào bị ghi đè: đây là sổ truy
       vết "lúc nào áp dụng cái gì". */
    SELECT  CONVERT(char(36), b.BatchId)         AS batchId,
            CONVERT(char(19), b.AppliedAt, 120)  AS appliedAt,
            b.AppliedBy                          AS appliedBy,
            b.WorkDayRule                        AS workDayRule,
            b.Notes                              AS notes,
            b.RowCountNum                        AS rowCountNum,
            CONVERT(float, b.TotalAmount)        AS totalAmount
    FROM dbo.SA_LaborCostBatch b
    ORDER BY b.AppliedAt DESC, b.BatchId DESC;
END
GO

CREATE PROCEDURE dbo.SA_LaborCost_Save
    @WorkerName    nvarchar(128),
    @EffectiveFrom date,
    @EffectiveTo   date,
    @Amount        decimal(18,2),
    @Notes         nvarchar(255) = NULL,
    /* Bỏ trống = THÊM một đợt mới; truyền vào = sửa đúng đợt đó, và chính nó
       không bị tính là trùng với chính nó. */
    @LaborId       int           = NULL,
    /* 'YYYY-MM' — tháng người dùng gán cho đợt. Chỉ là NHÃN: tiền vẫn chia
       theo ngày làm việc của khoảng ngày, không theo tháng này. */
    @CostMonth     char(7)       = NULL
AS
BEGIN
    SET NOCOUNT ON;

    SET @WorkerName = NULLIF(LTRIM(RTRIM(@WorkerName)), N'');
    IF @WorkerName IS NULL
    BEGIN
        RAISERROR (N'Thiếu họ tên nhân công.', 16, 1);
        RETURN;
    END

    IF @EffectiveFrom IS NULL OR @EffectiveTo IS NULL
    BEGIN
        RAISERROR (N'Đợt thuê nhân công phải có cả ngày bắt đầu và ngày kết thúc — công thức chia tiền cần biết đợt dài bao nhiêu ngày.', 16, 1);
        RETURN;
    END

    /* Nửa mở: ngày kết thúc KHÔNG được tính, nên bằng nhau là đợt rỗng. */
    IF @EffectiveTo <= @EffectiveFrom
    BEGIN
        RAISERROR (N'Khoảng hiệu lực không hợp lệ: ngày kết thúc phải sau ngày bắt đầu (ngày kết thúc không được tính vào đợt).', 16, 1);
        RETURN;
    END

    IF @Amount IS NULL OR @Amount < 0
    BEGIN
        RAISERROR (N'Chi phí của đợt phải là số tiền không âm.', 16, 1);
        RETURN;
    END

    /* --- KHÔNG ĐƯỢC GIAO VỚI ĐỢT KHÁC CỦA CHÍNH NGƯỜI NÀY ----------------
       Nửa mở nên hai đợt giao nhau khi aFrom < bTo AND bFrom < aTo. Đợt liền
       kề (25/07→25/08 và 25/08→25/09) KHÔNG phải giao — đó chính là cách viết
       thường gặp nhất. Nhiều NGƯỜI cùng khoảng thì bình thường, mỗi người
       tính độc lập.

       Kiểm ở đây vì đây là chỗ duy nhất mọi lối ghi bản nháp đi qua; giao
       diện có kiểm trước cũng chỉ để báo sớm. */
    DECLARE @ClashRange nvarchar(100);

    SELECT TOP (1)
           @ClashRange = CONVERT(char(10), x.EffectiveFrom, 103) + N' → '
                       + CONVERT(char(10), x.EffectiveTo,   103)
    FROM dbo.SA_LaborCost x
    WHERE x.WorkerName = @WorkerName
      AND (@LaborId IS NULL OR x.LaborId <> @LaborId)
      AND @EffectiveFrom < x.EffectiveTo
      AND x.EffectiveFrom < @EffectiveTo
    ORDER BY x.EffectiveFrom, x.LaborId;

    IF @ClashRange IS NOT NULL
    BEGIN
        RAISERROR (N'Khoảng thời gian bị trùng với đợt đã có của "%s": %s. Hãy chọn khoảng khác hoặc sửa đợt cũ trước.',
                   16, 1, @WorkerName, @ClashRange);
        RETURN;
    END

    IF @LaborId IS NULL
    BEGIN
        INSERT INTO dbo.SA_LaborCost (WorkerName, EffectiveFrom, EffectiveTo, Amount, Notes, CostMonth)
        VALUES (@WorkerName, @EffectiveFrom, @EffectiveTo, @Amount, @Notes, @CostMonth);

        SET @LaborId = CAST(SCOPE_IDENTITY() AS int);
    END
    ELSE
    BEGIN
        UPDATE dbo.SA_LaborCost
           SET WorkerName    = @WorkerName,
               EffectiveFrom = @EffectiveFrom,
               EffectiveTo   = @EffectiveTo,
               Amount        = @Amount,
               Notes         = @Notes,
               CostMonth     = @CostMonth,
               UpdatedAt     = SYSDATETIME()
         WHERE LaborId = @LaborId;

        IF @@ROWCOUNT = 0
        BEGIN
            RAISERROR (N'Đợt nhân công cần sửa không còn tồn tại (có thể đã bị xoá).', 16, 1);
            RETURN;
        END
    END

    SELECT  @LaborId                             AS id,
            @WorkerName                          AS workerName,
            CONVERT(char(10), @EffectiveFrom, 23) AS effectiveFrom,
            CONVERT(char(10), @EffectiveTo,   23) AS effectiveTo,
            CONVERT(float, @Amount)              AS amount;
END
GO

CREATE PROCEDURE dbo.SA_LaborCost_Delete
    /* Xoá một dòng của BẢN NHÁP. Các lượt đã áp dụng không đụng tới: bản chụp
       của chúng nằm ở SA_LaborCostApplied và là thứ báo cáo đang đọc. */
    @LaborId int
AS
BEGIN
    SET NOCOUNT ON;

    IF @LaborId IS NULL
    BEGIN
        RAISERROR (N'Thiếu mã đợt nhân công cần xoá.', 16, 1);
        RETURN;
    END

    DELETE FROM dbo.SA_LaborCost WHERE LaborId = @LaborId;
    SELECT @@ROWCOUNT AS deleted;
END
GO

CREATE PROCEDURE dbo.SA_LaborCost_Apply
    /* Chụp toàn bộ bản nháp thành MỘT lượt áp dụng mới. Từ lúc này báo cáo
       đọc bản chụp này; các lượt trước ở lại nguyên vẹn để truy vết.

       Bản nháp rỗng vẫn áp dụng được — đó là cách bỏ hết chi phí nhân công
       khỏi báo cáo mà không phải xoá lịch sử. */
    @WorkDayRule varchar(16)   = 'ALL',
    @AppliedBy   nvarchar(128) = NULL,
    @Notes       nvarchar(255) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @WorkDayRule IS NULL OR @WorkDayRule NOT IN ('ALL', 'MON_SAT', 'MON_FRI')
    BEGIN
        RAISERROR (N'Quy tắc ngày làm việc không hợp lệ (chỉ nhận ALL, MON_SAT, MON_FRI).', 16, 1);
        RETURN;
    END

    /* Kiểm lại TOÀN BỘ bản nháp trước khi đóng băng: SA_LaborCost_Save đã
       chặn từng dòng lúc ghi, nhưng lượt áp dụng là thứ báo cáo sống với nên
       không được tin vào lịch sử — một đợt giao nhau lọt vào đây là người đó
       được trả hai lần cho cùng một ngày. */
    DECLARE @BadWorker nvarchar(128), @BadRange nvarchar(200);

    SELECT TOP (1)
           @BadWorker = a.WorkerName,
           @BadRange  = CONVERT(char(10), a.EffectiveFrom, 103) + N' → '
                      + CONVERT(char(10), a.EffectiveTo,   103) + N' và '
                      + CONVERT(char(10), b.EffectiveFrom, 103) + N' → '
                      + CONVERT(char(10), b.EffectiveTo,   103)
    FROM dbo.SA_LaborCost a
    INNER JOIN dbo.SA_LaborCost b
            ON b.WorkerName = a.WorkerName
           AND b.LaborId    > a.LaborId
           AND a.EffectiveFrom < b.EffectiveTo
           AND b.EffectiveFrom < a.EffectiveTo
    ORDER BY a.WorkerName, a.EffectiveFrom;

    IF @BadWorker IS NOT NULL
    BEGIN
        RAISERROR (N'Không áp dụng được: "%s" có hai đợt giao nhau (%s). Sửa lại rồi bấm Áp dụng.',
                   16, 1, @BadWorker, @BadRange);
        RETURN;
    END

    DECLARE @BatchId uniqueidentifier = NEWID();

    BEGIN TRY
        BEGIN TRANSACTION;

        INSERT INTO dbo.SA_LaborCostBatch
            (BatchId, AppliedBy, WorkDayRule, Notes, RowCountNum, TotalAmount)
        SELECT @BatchId,
               @AppliedBy,
               @WorkDayRule,
               @Notes,
               COUNT(*),
               ISNULL(SUM(d.Amount), 0)
        FROM dbo.SA_LaborCost d;

        INSERT INTO dbo.SA_LaborCostApplied
            (BatchId, WorkerName, EffectiveFrom, EffectiveTo, Amount, Notes, CostMonth)
        SELECT @BatchId, d.WorkerName, d.EffectiveFrom, d.EffectiveTo, d.Amount, d.Notes, d.CostMonth
        FROM dbo.SA_LaborCost d;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;

        DECLARE @msg nvarchar(2048) = ERROR_MESSAGE();
        RAISERROR (@msg, 16, 1);
        RETURN;
    END CATCH

    SELECT  CONVERT(char(36), b.BatchId)        AS batchId,
            CONVERT(char(19), b.AppliedAt, 120) AS appliedAt,
            b.AppliedBy                         AS appliedBy,
            b.WorkDayRule                       AS workDayRule,
            b.RowCountNum                       AS rowCountNum,
            CONVERT(float, b.TotalAmount)       AS totalAmount
    FROM dbo.SA_LaborCostBatch b
    WHERE b.BatchId = @BatchId;
END
GO

CREATE PROCEDURE dbo.SA_LaborCostBatch_GetRows
    /* Các dòng của MỘT lượt áp dụng — để xem lại lượt cũ đã áp dụng những gì. */
    @BatchId uniqueidentifier
AS
BEGIN
    SET NOCOUNT ON;

    SELECT  a.AppliedId                          AS id,
            CONVERT(char(36), a.BatchId)         AS batchId,
            a.WorkerName                         AS workerName,
            CONVERT(char(10), a.EffectiveFrom, 23) AS effectiveFrom,
            CONVERT(char(10), a.EffectiveTo,   23) AS effectiveTo,
            CONVERT(float, a.Amount)             AS amount,
            a.Notes                              AS notes,
            a.CostMonth                          AS costMonth
    FROM dbo.SA_LaborCostApplied a
    WHERE a.BatchId = @BatchId
    ORDER BY a.WorkerName, a.EffectiveFrom, a.AppliedId;
END
GO

CREATE PROCEDURE dbo.SA_LaborCostBatch_Restore
    /* Nạp lại bản chụp của một lượt áp dụng vào BẢN NHÁP, để sửa tiếp từ đó
       rồi áp dụng lại. KHÔNG đụng tới lượt áp dụng nào: lượt đang có hiệu lực
       vẫn là lượt mới nhất cho tới khi người dùng bấm "Áp dụng" lần nữa. */
    @BatchId uniqueidentifier
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.SA_LaborCostBatch WHERE BatchId = @BatchId)
    BEGIN
        RAISERROR (N'Lượt áp dụng cần nạp lại không tồn tại.', 16, 1);
        RETURN;
    END

    DECLARE @restored int = 0;

    BEGIN TRY
        BEGIN TRANSACTION;

        DELETE FROM dbo.SA_LaborCost;

        INSERT INTO dbo.SA_LaborCost (WorkerName, EffectiveFrom, EffectiveTo, Amount, Notes, CostMonth)
        SELECT a.WorkerName, a.EffectiveFrom, a.EffectiveTo, a.Amount, a.Notes, a.CostMonth
        FROM dbo.SA_LaborCostApplied a
        WHERE a.BatchId = @BatchId;

        SET @restored = @@ROWCOUNT;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;

        DECLARE @msg nvarchar(2048) = ERROR_MESSAGE();
        RAISERROR (@msg, 16, 1);
        RETURN;
    END CATCH

    SELECT @restored AS restored;
END
GO

PRINT '03_procedures.sql: DONE';
GO
