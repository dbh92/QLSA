/* ===========================================================================
   TRIỂN KHAI: NHÃN THÁNG CHO ĐỢT NHÂN CÔNG (2026-10-13)

   Chạy trên [QLSA]:
       sqlcmd -S <server> -U sa -P <pwd> -d QLSA -f 65001 -I ^
              -i _deploy_labor_cost_month_2026-10-13.sql

   1. Thêm cột CostMonth char(7) NULL vào SA_LaborCost và SA_LaborCostApplied.
      Chỉ là NHÃN người dùng chọn ở ô "Tháng": tiền vẫn chia theo ngày làm
      việc của khoảng ngày, bảng 12 tháng vẫn cắt theo kỳ của từng tháng.
   2. Tạo lại 5 procedure mang cột đó đi: SA_LaborCost_Get / _Save / _Apply,
      SA_LaborCostBatch_GetRows / _Restore. Bản đang chạy trước khi deploy
      trùng khít bản trong repo (HEAD) — đã đối chiếu.

   Chạy lại được nhiều lần. Nội dung chép từ db/01_schema.sql (mục 17) và
   db/03_procedures.sql — nguồn sự thật vẫn là hai file đó.
   =========================================================================== */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF COL_LENGTH('dbo.SA_LaborCost', 'CostMonth') IS NULL
    ALTER TABLE dbo.SA_LaborCost ADD CostMonth char(7) NULL;
GO
IF COL_LENGTH('dbo.SA_LaborCostApplied', 'CostMonth') IS NULL
    ALTER TABLE dbo.SA_LaborCostApplied ADD CostMonth char(7) NULL;
GO

IF OBJECT_ID('dbo.SA_LaborCost_Get', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_LaborCost_Get;
GO
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

IF OBJECT_ID('dbo.SA_LaborCost_Save', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_LaborCost_Save;
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

IF OBJECT_ID('dbo.SA_LaborCost_Apply', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_LaborCost_Apply;
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

IF OBJECT_ID('dbo.SA_LaborCostBatch_GetRows', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_LaborCostBatch_GetRows;
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

IF OBJECT_ID('dbo.SA_LaborCostBatch_Restore', 'P') IS NOT NULL DROP PROCEDURE dbo.SA_LaborCostBatch_Restore;
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

PRINT '_deploy_labor_cost_month_2026-10-13.sql: DONE';
GO
