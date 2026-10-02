
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

    IF @MilkId IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.SA_MilkEntry WHERE MilkId = @MilkId)
    BEGIN
        INSERT INTO dbo.SA_MilkEntry (EntryDate, MilkType, Quantity, UnitPrice, Supplier, Notes)
        VALUES (@EntryDate, @MilkType, @Quantity, @UnitPrice, @Supplier, @Notes);
        SET @MilkId = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        UPDATE dbo.SA_MilkEntry
           SET EntryDate = @EntryDate,
               MilkType  = @MilkType,
               Quantity  = @Quantity,
               UnitPrice = @UnitPrice,
               Supplier  = @Supplier,
               Notes     = @Notes
         WHERE MilkId = @MilkId;
    END

    SELECT  CAST(MilkId AS varchar(20))      AS id,
            CONVERT(char(10), EntryDate, 23) AS date,
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
