
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

    IF @EntryId IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.SA_ManualEntry WHERE EntryId = @EntryId)
    BEGIN
        INSERT INTO dbo.SA_ManualEntry (EntryDate, ShiftCode, Department, Quantity, Reason, EnteredBy)
        VALUES (@EntryDate, @ShiftCode, @Department, @Quantity, @Reason, @EnteredBy);
        SET @EntryId = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        UPDATE dbo.SA_ManualEntry
           SET EntryDate  = @EntryDate,
               ShiftCode  = @ShiftCode,
               Department = @Department,
               Quantity   = @Quantity,
               Reason     = @Reason,
               EnteredBy  = @EnteredBy
         WHERE EntryId = @EntryId;
    END

    SELECT  CAST(EntryId AS varchar(20))      AS id,
            CONVERT(char(10), EntryDate, 23)  AS date,
            ShiftCode                         AS shiftCode,
            Department                        AS department,
            Quantity                          AS quantity,
            Reason                            AS reason,
            EnteredBy                         AS enteredBy,
            CONVERT(char(19), CreatedAt, 120) AS createdAt
    FROM dbo.SA_ManualEntry
    WHERE EntryId = @EntryId;
END

GO
