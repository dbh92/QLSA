/* ===========================================================================
   TRIỂN KHAI: CHI PHÍ THUÊ NHÂN CÔNG (2026-09-08)

   Chạy trên [QLSA]:
       sqlcmd -S <server> -U sa -P <pwd> -d QLSA -f 65001 -I ^
              -i _deploy_labor_cost_2026-09-08.sql

   Vì sao là script riêng chứ không chạy lại db/03_procedures.sql: file đó drop
   TOÀN BỘ procedure/view SA_* rồi tạo lại, nên bất kỳ bản sửa tay nào trên máy
   chủ cũng mất. Script này chỉ tạo những gì tính năng cần và KHÔNG đụng tới
   một object nào đang có:

     1. Ba bảng mới: SA_LaborCost (bản nháp), SA_LaborCostBatch (mỗi lần bấm
        "Áp dụng" một dòng), SA_LaborCostApplied (bản chụp của lượt đó).
     2. Sáu procedure mới: SA_LaborCost_Get / _Save / _Delete / _Apply,
        SA_LaborCostBatch_GetRows / _Restore.

   KHÔNG procedure nào đang có bị sửa: chi phí nhân công được cộng vào báo cáo
   ở phía client (buildLaborSegments / withLaborCost trong reportModel.ts), nên
   SA_MealLog_GetByRange và SA_MealCost_GetMonthly giữ nguyên.

   CHẠY XONG MÀ CHƯA BẤM "ÁP DỤNG" THÌ KHÔNG CON SỐ NÀO ĐỔI: báo cáo chỉ đọc
   lượt áp dụng mới nhất, và lúc này chưa có lượt nào.

   Script chạy lại được nhiều lần: phần bảng có IF OBJECT_ID, phần procedure
   drop rồi tạo lại đúng sáu procedure của mình. Nội dung được chép nguyên từ
   db/01_schema.sql (mục 17) và db/03_procedures.sql — nguồn sự thật vẫn là
   hai file đó.
   =========================================================================== */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

PRINT '--- 1. Ba bảng chi phí nhân công ---';
GO

/* ---------------------------------------------------------------------------
   17. Chi phí thuê nhân công — SA_LaborCost / SA_LaborCostBatch /
       SA_LaborCostApplied

   Nhà ăn thuê nhân công theo ĐỢT: một người, một khoảng ngày, một số tiền
   trọn khoảng đó. Bảng kê chi phí chỉ lọc một quãng bất kỳ trong đó, nên tiền
   phải CHIA THEO NGÀY LÀM VIỆC rồi nhân lại với phần giao giữa khoảng lọc và
   khoảng của đợt. Phép chia đó nằm ở `buildLaborSegments`
   (src/components/financial/reportModel.ts) — SQL chỉ giữ dữ liệu.

   KHOẢNG NGÀY LÀ NỬA MỞ: [EffectiveFrom, EffectiveTo). Ngày bắt đầu ĐƯỢC
   tính, ngày kết thúc KHÔNG. Đây là điều kiện để hai đợt nối tiếp nhau viết
   được đúng như người dùng vẫn viết trên giấy — 25/07→25/08 rồi 25/08→25/09 —
   mà ngày 25/08 chỉ thuộc về đúng một đợt, không bị tính hai lần và cũng
   không rơi mất. Hệ quả: EffectiveTo phải LỚN HƠN EffectiveFrom (không bằng),
   và cả hai đầu đều bắt buộc — công thức cần biết đợt dài bao nhiêu ngày.

   BA BẢNG, VÌ "ÁP DỤNG" LÀ MỘT HÀNH ĐỘNG RIÊNG:
     • SA_LaborCost        — BẢN NHÁP người dùng đang sửa. KHÔNG báo cáo nào
                             đọc bảng này. Thêm/sửa/xoá thoải mái, số trên mọi
                             bảng kê không nhúc nhích.
     • SA_LaborCostBatch   — MỘT DÒNG cho mỗi lần bấm "Áp dụng": ai bấm, lúc
                             nào, quy tắc ngày làm việc lúc đó là gì.
     • SA_LaborCostApplied — BẢN CHỤP các dòng nháp tại thời điểm bấm. Đây mới
                             là thứ báo cáo đọc, và chỉ đọc lượt áp dụng MỚI
                             NHẤT: cộng hết mọi lượt thì bấm "Áp dụng" hai lần
                             là tiền nhân đôi. Các lượt cũ ở lại nguyên vẹn để
                             truy vết — không lượt nào ghi đè lượt nào.

   Quy tắc ngày làm việc được ĐÓNG BĂNG vào từng lượt áp dụng
   (SA_LaborCostBatch.WorkDayRule) chứ không đọc tham số hệ thống lúc tính:
   đổi quy tắc cho đợt thuê sắp tới không được phép làm số tiền của bảng kê
   tháng trước tự nhảy.

   HAI ĐỢT CỦA CÙNG MỘT NGƯỜI KHÔNG ĐƯỢC GIAO NHAU (theo nghĩa nửa mở: giao
   khi aFrom < bTo AND bFrom < aTo) — nếu giao thì cùng một ngày người đó được
   trả hai lần. CHECK không diễn đạt được điều đó (phải nhìn sang dòng khác),
   nên nó nằm trong SA_LaborCost_Save và được kiểm lại toàn bộ ở
   SA_LaborCost_Apply. Nhiều NGƯỜI KHÁC NHAU cùng khoảng thì hoàn toàn bình
   thường — mỗi người tính độc lập.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_LaborCost', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_LaborCost
    (
        LaborId       int            NOT NULL IDENTITY(1,1),
        WorkerName    nvarchar(128)  NOT NULL,
        EffectiveFrom date           NOT NULL,   -- TÍNH ngày này
        EffectiveTo   date           NOT NULL,   -- KHÔNG tính ngày này
        Amount        decimal(18,2)  NOT NULL,
        Notes         nvarchar(255)  NULL,
        UpdatedAt     datetime2(0)   NOT NULL CONSTRAINT DF_SA_Labor_Updated DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_SA_LaborCost PRIMARY KEY CLUSTERED (LaborId),
        CONSTRAINT CK_SA_Labor_Range  CHECK (EffectiveTo > EffectiveFrom),
        CONSTRAINT CK_SA_Labor_Amount CHECK (Amount >= 0)
    );
    CREATE INDEX IX_SA_LaborCost_Worker ON dbo.SA_LaborCost (WorkerName, EffectiveFrom);
END
GO

IF OBJECT_ID('dbo.SA_LaborCostBatch', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_LaborCostBatch
    (
        BatchId     uniqueidentifier NOT NULL CONSTRAINT DF_SA_LaborBatch_Id DEFAULT (NEWID()),
        AppliedAt   datetime2(0)     NOT NULL CONSTRAINT DF_SA_LaborBatch_At DEFAULT (SYSDATETIME()),
        AppliedBy   nvarchar(128)    NULL,
        /* Quy tắc ngày làm việc dùng để chia tiền của lượt này: 'ALL' (mọi
           ngày theo lịch), 'MON_SAT' (trừ Chủ nhật), 'MON_FRI'. Đóng băng ở
           đây nên số của một lượt áp dụng cũ không đổi khi quy tắc đổi. */
        WorkDayRule varchar(16)      NOT NULL CONSTRAINT DF_SA_LaborBatch_Rule DEFAULT ('ALL'),
        Notes       nvarchar(255)    NULL,
        RowCountNum int              NOT NULL CONSTRAINT DF_SA_LaborBatch_Rows DEFAULT (0),
        TotalAmount decimal(18,2)    NOT NULL CONSTRAINT DF_SA_LaborBatch_Amt DEFAULT (0),
        CONSTRAINT PK_SA_LaborCostBatch PRIMARY KEY CLUSTERED (BatchId),
        CONSTRAINT CK_SA_LaborBatch_Rule CHECK (WorkDayRule IN ('ALL', 'MON_SAT', 'MON_FRI'))
    );
    CREATE INDEX IX_SA_LaborBatch_At ON dbo.SA_LaborCostBatch (AppliedAt DESC);
END
GO

IF OBJECT_ID('dbo.SA_LaborCostApplied', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_LaborCostApplied
    (
        AppliedId     int              NOT NULL IDENTITY(1,1),
        BatchId       uniqueidentifier NOT NULL,
        WorkerName    nvarchar(128)    NOT NULL,
        EffectiveFrom date             NOT NULL,
        EffectiveTo   date             NOT NULL,
        Amount        decimal(18,2)    NOT NULL,
        Notes         nvarchar(255)    NULL,
        CONSTRAINT PK_SA_LaborCostApplied PRIMARY KEY CLUSTERED (AppliedId),
        CONSTRAINT FK_SA_LaborApplied_Batch FOREIGN KEY (BatchId)
            REFERENCES dbo.SA_LaborCostBatch (BatchId)
    );
    CREATE INDEX IX_SA_LaborApplied_Batch ON dbo.SA_LaborCostApplied (BatchId, WorkerName, EffectiveFrom);
END
GO

PRINT '--- 2. Xoá 6 procedure cũ (nếu có) rồi tạo lại ---';
GO

IF OBJECT_ID('dbo.SA_LaborCost_Get', 'P')         IS NOT NULL DROP PROCEDURE dbo.SA_LaborCost_Get;
IF OBJECT_ID('dbo.SA_LaborCost_Save', 'P')        IS NOT NULL DROP PROCEDURE dbo.SA_LaborCost_Save;
IF OBJECT_ID('dbo.SA_LaborCost_Delete', 'P')      IS NOT NULL DROP PROCEDURE dbo.SA_LaborCost_Delete;
IF OBJECT_ID('dbo.SA_LaborCost_Apply', 'P')       IS NOT NULL DROP PROCEDURE dbo.SA_LaborCost_Apply;
IF OBJECT_ID('dbo.SA_LaborCostBatch_GetRows', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_LaborCostBatch_GetRows;
IF OBJECT_ID('dbo.SA_LaborCostBatch_Restore', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_LaborCostBatch_Restore;
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
            a.Notes                              AS notes
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
    @LaborId       int           = NULL
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
        INSERT INTO dbo.SA_LaborCost (WorkerName, EffectiveFrom, EffectiveTo, Amount, Notes)
        VALUES (@WorkerName, @EffectiveFrom, @EffectiveTo, @Amount, @Notes);

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
            (BatchId, WorkerName, EffectiveFrom, EffectiveTo, Amount, Notes)
        SELECT @BatchId, d.WorkerName, d.EffectiveFrom, d.EffectiveTo, d.Amount, d.Notes
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
            a.Notes                              AS notes
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

        INSERT INTO dbo.SA_LaborCost (WorkerName, EffectiveFrom, EffectiveTo, Amount, Notes)
        SELECT a.WorkerName, a.EffectiveFrom, a.EffectiveTo, a.Amount, a.Notes
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

PRINT '=== _deploy_labor_cost_2026-09-08.sql: DONE ===';
PRINT 'Khoi dong lai API (npm run server) de endpoint /api/labor-costs hoat dong.';
GO
