/* Bản sao SA_MealCost_GetMonthly đang chạy trên QLSA trước khi deploy kỳ tính chi phí theo tháng (2026-10-13). */
USE [QLSA];
GO
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO
IF OBJECT_ID('dbo.SA_MealCost_GetMonthly', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_MealCost_GetMonthly;
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
    /* Chỉ là giá DỰ PHÒNG cho ngày sinh nhật nào bỏ trống giá — không còn là
       đơn giá suất sinh nhật của cả kỳ. Xem chú thích đầu procedure. */
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

           Dòng ký sổ của NGƯỜI VIỆT rơi đúng ngày sinh nhật và thuộc ca ăn
           sinh nhật thì cũng ăn ĐƠN GIÁ SINH NHẬT CỦA NGÀY ĐÓ — người ký sổ
           hôm đó cũng ăn suất sinh nhật như người quẹt được thẻ. Ngày đối
           chiếu là EntryDate, tức ngày ca BẮT ĐẦU, cùng khoá với MealDate của
           lượt quẹt. Người Hàn không bao giờ bị đè. Phía client
           `classifyManualEntries` làm y hệt — đổi một bên thì phải đổi bên
           kia. */
        SELECT  MONTH(me.EntryDate) AS MonthNo,
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
        LEFT JOIN dbo.SA_BirthdayConfig mbd ON mbd.ConfigDate = me.EntryDate
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
        CAST(ISNULL(mc.SuatDacBietAmount, 0)          AS float)         AS SuatDacBiet,
        CAST(ISNULL(mk.Amount, 0)                     AS float)         AS Sua,
        CAST(ISNULL(ex.Amount, 0)                     AS float)         AS ChiPhiPhatSinh,
        CAST(ISNULL(mc.ComHan, 0)      * @pComHan
           + ISNULL(mc.MyHan, 0)       * @pMyHan
           + ISNULL(mc.ComViet, 0)     * @pComViet
           + ISNULL(mc.ComVietPhu, 0)  * @pComVietPhu
           + ISNULL(mc.SuatDacBietAmount, 0)
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
