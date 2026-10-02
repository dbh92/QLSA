/* Bản sao procedure trên 10.70.22.240/QLSA trước khi chạy _deploy_loss_deletion_kind_2026-10-02.sql */
USE [QLSA];
GO
IF OBJECT_ID('dbo.SA_MealLog_GetByRange', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_MealLog_GetByRange;
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
IF OBJECT_ID('dbo.SA_MealLogDeleted_Save', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_MealLogDeleted_Save;
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
   =========================================================================== */

CREATE PROCEDURE dbo.SA_MealLogDeleted_Save
    @Ids          dbo.SA_EventIdList READONLY,
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

    IF NOT EXISTS (SELECT 1 FROM @Ids)
    BEGIN
        RAISERROR (N'Không có lượt quẹt nào để xoá.', 16, 1);
        RETURN;
    END

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
         DeleteBatchId, DeletedBy, DeleteReason)
    SELECT  e.nEventLogIdn, e.nDateTime, e.nReaderIdn, e.nEventIdn, e.nUserID,
            e.nIsLog, e.nTNAEvent, e.nIsUseTA, e.nType,
            @BatchId, @UserName, @Reason
    FROM BioStar.dbo.TB_EVENT_LOG e
    INNER JOIN @Ids i ON i.EventLogIdn = e.nEventLogIdn
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
            (SELECT COUNT(*) FROM @Ids)   AS requested;
END

GO
IF OBJECT_ID('dbo.SA_MealLogDeleted_Get', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_MealLogDeleted_Get;
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
