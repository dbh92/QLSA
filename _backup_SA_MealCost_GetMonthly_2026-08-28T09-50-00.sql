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
        nUserID   int          NOT NULL PRIMARY KEY,
        LargeDept nvarchar(32) NOT NULL
    );

    INSERT INTO #Users (nUserID, LargeDept)
    SELECT  x.nUserID,
            COALESCE(r.LargeDeptCode, m.LargeDeptCode, N'Khác')
    FROM (
        SELECT  TRY_CAST(u.sUserID AS int)  AS nUserID,
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
    WHERE x.rn = 1;

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
        CROSS APPLY (
            /* CHỈ bộ phận lớn KR mới ăn giá suất Hàn, và ăn ở mọi máy chấm.
               Máy TA-102 (CT Korea) không quyết định gì về giá: khách hoặc
               người bộ phận khác quẹt nhầm máy đó vẫn tính giá người Việt. */
            SELECT ISNULL(sh.ShiftCode, N'Khác')                        AS ShiftCode,
                   CASE WHEN u.LargeDept = N'KR' THEN 'KR' ELSE 'VN' END AS StaffType
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
        CAST(ISNULL(mc.ComHan, 0)      * @pComHan
           + ISNULL(mc.MyHan, 0)       * @pMyHan
           + ISNULL(mc.ComViet, 0)     * @pComViet
           + ISNULL(mc.ComVietPhu, 0)  * @pComVietPhu
           + ISNULL(mc.SuatDacBiet, 0) * @pDacBiet
           + ISNULL(mk.Amount, 0)                     AS float)         AS [Sum]
    FROM #Months mo
    LEFT JOIN #MealCount mc ON mc.MonthNo = mo.MonthNo
    LEFT JOIN #MilkCost  mk ON mk.MonthNo = mo.MonthNo
    ORDER BY mo.MonthNo;

    DROP TABLE #Months;
    DROP TABLE #Users;
    DROP TABLE #MealCount;
    DROP TABLE #MilkCost;
END
GO
