/* ============================================================================
   HỆ THỐNG QUẢN LÝ VÀ THEO DÕI SUẤT ĂN
   01_schema.sql — Tạo các bảng cấu hình của hệ thống suất ăn.

   Chạy trên:  Data Source = 10.70.22.240, Initial Catalog = QLSA

   Ghi chú kiến trúc:
     - Dữ liệu chấm ăn GỐC nằm ở database [BioStar] trên cùng instance:
         BioStar.dbo.TB_EVENT_LOG   (log quẹt thẻ, nDateTime = epoch giây, giờ LOCAL)
         BioStar.dbo.TB_READER      (danh sách máy đọc thẻ)
         BioStar.dbo.TB_USER        (nhân viên)
         BioStar.dbo.TB_USER_DEPT   (bộ phận nhỏ)
       Các bảng đó KHÔNG bị sửa đổi. Hệ thống chỉ đọc (read-only).
     - Toàn bộ bảng mới của hệ thống suất ăn nằm trong [QLSA] với tiền tố SA_
       để không đụng tới hệ thống ESYS... / PKG_... có sẵn trong QLSA.
   ============================================================================ */

USE [QLSA];
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* ---------------------------------------------------------------------------
   1. SA_LargeDepartment — Danh mục BỘ PHẬN LỚN
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_LargeDepartment', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_LargeDepartment
    (
        LargeDeptCode   nvarchar(32)   NOT NULL,
        LargeDeptName   nvarchar(128)  NOT NULL,
        SortOrder       int            NOT NULL CONSTRAINT DF_SA_LargeDept_Sort   DEFAULT (99),
        IsActive        bit            NOT NULL CONSTRAINT DF_SA_LargeDept_Active DEFAULT (1),
        CONSTRAINT PK_SA_LargeDepartment PRIMARY KEY CLUSTERED (LargeDeptCode)
    );
END
GO

/* ---------------------------------------------------------------------------
   2. SA_DepartmentMapping — Ánh xạ BỘ PHẬN NHỎ -> BỘ PHẬN LỚN
      SmallDepartment khớp với BioStar.dbo.TB_USER_DEPT.sName
      (so khớp không phân biệt hoa/thường nhờ collation CI của database).
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_DepartmentMapping', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_DepartmentMapping
    (
        MappingId       int            IDENTITY(1,1) NOT NULL,
        SmallDepartment nvarchar(64)   NOT NULL,
        LargeDeptCode   nvarchar(32)   NOT NULL,
        Notes           nvarchar(255)  NULL,
        UpdatedAt       datetime2(0)   NOT NULL CONSTRAINT DF_SA_DeptMap_Updated DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_SA_DepartmentMapping  PRIMARY KEY CLUSTERED (MappingId),
        CONSTRAINT UQ_SA_DepartmentMapping  UNIQUE (SmallDepartment),
        CONSTRAINT FK_SA_DeptMap_LargeDept  FOREIGN KEY (LargeDeptCode)
            REFERENCES dbo.SA_LargeDepartment (LargeDeptCode)
    );
END
GO

/* ---------------------------------------------------------------------------
   3. SA_DepartmentMappingRule — Ánh xạ CÓ ĐIỀU KIỆN theo tên nhân viên.
      Dùng cho quy tắc trong bảng ánh xạ:
        "Chỉ những tên 'Khach cong tac' có sUserName chứa 'Business' mới được
         cho vào mục KR; nếu KHÔNG chứa 'Business' thì thuộc bộ phận chung SP."
      Rule được ưu tiên hơn SA_DepartmentMapping. Nếu không rule nào khớp thì
      rơi về SA_DepartmentMapping, cuối cùng rơi về 'Khác'.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_DepartmentMappingRule', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_DepartmentMappingRule
    (
        RuleId          int            IDENTITY(1,1) NOT NULL,
        SmallDepartment nvarchar(64)   NULL,          -- NULL = áp dụng cho mọi bộ phận nhỏ
        MatchField      varchar(32)    NOT NULL CONSTRAINT DF_SA_Rule_Field DEFAULT ('sUserName'),
        MatchOperator   varchar(16)    NOT NULL,      -- CONTAINS | NOT_CONTAINS | EQUALS
        MatchValue      nvarchar(128)  NOT NULL,
        LargeDeptCode   nvarchar(32)   NOT NULL,
        Priority        int            NOT NULL CONSTRAINT DF_SA_Rule_Priority DEFAULT (100),
        IsActive        bit            NOT NULL CONSTRAINT DF_SA_Rule_Active   DEFAULT (1),
        Notes           nvarchar(500)  NULL,
        CONSTRAINT PK_SA_DepartmentMappingRule PRIMARY KEY CLUSTERED (RuleId),
        CONSTRAINT CK_SA_Rule_Operator CHECK (MatchOperator IN ('CONTAINS', 'NOT_CONTAINS', 'EQUALS')),
        CONSTRAINT CK_SA_Rule_Field    CHECK (MatchField = 'sUserName'),
        CONSTRAINT FK_SA_Rule_LargeDept FOREIGN KEY (LargeDeptCode)
            REFERENCES dbo.SA_LargeDepartment (LargeDeptCode)
    );
END
GO

/* ---------------------------------------------------------------------------
   4. SA_Shift — Khung giờ 6 ca ăn.
      CA1 vắt qua nửa đêm nên
      WrapsMidnight = 1  => điều kiện là (t >= Start OR t <= End).

      ShiftReName là tên ca dùng trong các bảng kê gửi nhà ăn ("23H", "5H",
      "7H", "12H", "17H", "19H"). Chỉ để hiển thị — mọi tính toán vẫn dùng
      ShiftCode.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_Shift', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_Shift
    (
        ShiftCode      nvarchar(10)  NOT NULL,
        ShiftName      nvarchar(64)  NOT NULL,
        ShiftReName    nvarchar(16)  NULL,
        StartTime      time(0)       NOT NULL,
        EndTime        time(0)       NOT NULL,
        WrapsMidnight  bit           NOT NULL CONSTRAINT DF_SA_Shift_Wrap   DEFAULT (0),
        Description    nvarchar(255) NULL,
        SortOrder      int           NOT NULL CONSTRAINT DF_SA_Shift_Sort   DEFAULT (99),
        IsActive       bit           NOT NULL CONSTRAINT DF_SA_Shift_Active DEFAULT (1),
        CONSTRAINT PK_SA_Shift PRIMARY KEY CLUSTERED (ShiftCode)
    );
END
GO

/* Bảng đã tồn tại từ trước bản có ShiftReName thì bổ sung cột. */
IF COL_LENGTH('dbo.SA_Shift', 'ShiftReName') IS NULL
    ALTER TABLE dbo.SA_Shift ADD ShiftReName nvarchar(16) NULL;
GO

/* ---------------------------------------------------------------------------
   5. SA_Reader — 3 máy chấm ăn được dùng cho hệ thống này.
      ReaderIdn khớp BioStar.dbo.TB_READER.nReaderIdn
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_Reader', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_Reader
    (
        ReaderIdn       int           NOT NULL,
        ReaderCode      nvarchar(16)  NOT NULL,
        ReaderName      nvarchar(64)  NOT NULL,   -- = TB_READER.sName
        IP              varchar(32)   NULL,
        Location        nvarchar(128) NULL,
        IsKoreanMachine bit           NOT NULL CONSTRAINT DF_SA_Reader_KR     DEFAULT (0),
        IsActive        bit           NOT NULL CONSTRAINT DF_SA_Reader_Active DEFAULT (1),
        CONSTRAINT PK_SA_Reader PRIMARY KEY CLUSTERED (ReaderIdn)
    );
END
GO

/* ---------------------------------------------------------------------------
   6. SA_MealEventCode — Các mã sự kiện của BioStar được tính là 1 lượt chấm ăn
      hợp lệ (lấy theo hệ thống QLSA cũ: PKG_TKSA001@GET_LIST).
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_MealEventCode', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_MealEventCode
    (
        EventIdn    int           NOT NULL,
        Description nvarchar(128) NULL,
        CONSTRAINT PK_SA_MealEventCode PRIMARY KEY CLUSTERED (EventIdn)
    );
END
GO

/* ---------------------------------------------------------------------------
   7. SA_MealPrice — Đơn giá các loại suất ăn / đồ uống
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_MealPrice', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_MealPrice
    (
        PriceId    int            IDENTITY(1,1) NOT NULL,
        Code       varchar(32)    NOT NULL,
        Name       nvarchar(128)  NOT NULL,
        UnitPrice  decimal(18,2)  NOT NULL,
        Unit       nvarchar(32)   NOT NULL,
        Notes      nvarchar(255)  NULL,
        IsActive   bit            NOT NULL CONSTRAINT DF_SA_Price_Active DEFAULT (1),
        CONSTRAINT PK_SA_MealPrice PRIMARY KEY CLUSTERED (PriceId),
        CONSTRAINT UQ_SA_MealPrice UNIQUE (Code)
    );
END
GO

/* ---------------------------------------------------------------------------
   8. SA_MilkEntry — Nhập lượng sữa hằng ngày
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_MilkEntry', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_MilkEntry
    (
        MilkId      int            IDENTITY(1,1) NOT NULL,
        EntryDate   date           NOT NULL,
        MilkShift   varchar(4)     NOT NULL CONSTRAINT DF_SA_Milk_Shift DEFAULT ('NGAY'),
        MilkType    nvarchar(128)  NOT NULL,
        Quantity    int            NOT NULL,
        UnitPrice   decimal(18,2)  NOT NULL,
        TotalAmount AS (CONVERT(decimal(18,2), Quantity) * UnitPrice) PERSISTED,
        Supplier    nvarchar(128)  NULL,
        Notes       nvarchar(500)  NULL,
        CreatedAt   datetime2(0)   NOT NULL CONSTRAINT DF_SA_Milk_Created DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_SA_MilkEntry PRIMARY KEY CLUSTERED (MilkId),
        CONSTRAINT CK_SA_Milk_Qty CHECK (Quantity > 0),
        CONSTRAINT CK_SA_Milk_Shift CHECK (MilkShift IN ('NGAY', 'DEM'))
    );
    CREATE INDEX IX_SA_MilkEntry_Date ON dbo.SA_MilkEntry (EntryDate);
END
GO

/* Bảng đã tồn tại từ trước khi có ca cấp sữa: bổ sung cột. Dòng cũ không mang
   ca nào nên mặc định về ca ngày, đúng như `parseMilkShift` phía client. */
IF COL_LENGTH('dbo.SA_MilkEntry', 'MilkShift') IS NULL
BEGIN
    ALTER TABLE dbo.SA_MilkEntry
        ADD MilkShift varchar(4) NOT NULL CONSTRAINT DF_SA_Milk_Shift DEFAULT ('NGAY');
END
GO

IF OBJECT_ID('dbo.CK_SA_Milk_Shift', 'C') IS NULL
BEGIN
    ALTER TABLE dbo.SA_MilkEntry
        ADD CONSTRAINT CK_SA_Milk_Shift CHECK (MilkShift IN ('NGAY', 'DEM'));
END
GO

/* ---------------------------------------------------------------------------
   8b. SA_ExtraCost — Chi phí phát sinh ngoài suất ăn và sữa
       (kem, quà ngày lễ tuỳ biến, ... — hạng mục do người dùng tự đặt tên)

   Cấu trúc cố tình song song với SA_MilkEntry: cùng cách nhập, cùng cách lên
   bảng kê, nên hai bảng phải giữ nguyên hình dạng giống nhau. Đổi một bảng
   thì cân nhắc đổi cả bảng kia.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_ExtraCost', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_ExtraCost
    (
        ExtraId     int            IDENTITY(1,1) NOT NULL,
        EntryDate   date           NOT NULL,
        CostShift   varchar(4)     NOT NULL CONSTRAINT DF_SA_Extra_Shift DEFAULT ('NGAY'),
        CostType    nvarchar(128)  NOT NULL,
        Quantity    int            NOT NULL,
        UnitPrice   decimal(18,2)  NOT NULL,
        TotalAmount AS (CONVERT(decimal(18,2), Quantity) * UnitPrice) PERSISTED,
        Supplier    nvarchar(128)  NULL,
        Notes       nvarchar(500)  NULL,
        CreatedAt   datetime2(0)   NOT NULL CONSTRAINT DF_SA_Extra_Created DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_SA_ExtraCost PRIMARY KEY CLUSTERED (ExtraId),
        CONSTRAINT CK_SA_Extra_Qty CHECK (Quantity > 0),
        CONSTRAINT CK_SA_Extra_Shift CHECK (CostShift IN ('NGAY', 'DEM'))
    );
    CREATE INDEX IX_SA_ExtraCost_Date ON dbo.SA_ExtraCost (EntryDate);
END
GO

/* ---------------------------------------------------------------------------
   8b. SA_ExtraCost — Chi phí phát sinh ngoài suất ăn và sữa
       (kem, quà ngày lễ tuỳ biến, ... — hạng mục do người dùng tự đặt tên)

   Cấu trúc cố tình song song với SA_MilkEntry: cùng cách nhập, cùng cách lên
   bảng kê, nên hai bảng phải giữ nguyên hình dạng giống nhau. Đổi một bảng
   thì cân nhắc đổi cả bảng kia.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_ExtraCost', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_ExtraCost
    (
        ExtraId     int            IDENTITY(1,1) NOT NULL,
        EntryDate   date           NOT NULL,
        CostShift   varchar(4)     NOT NULL CONSTRAINT DF_SA_Extra_Shift DEFAULT ('NGAY'),
        CostType    nvarchar(128)  NOT NULL,
        Quantity    int            NOT NULL,
        UnitPrice   decimal(18,2)  NOT NULL,
        TotalAmount AS (CONVERT(decimal(18,2), Quantity) * UnitPrice) PERSISTED,
        Supplier    nvarchar(128)  NULL,
        Notes       nvarchar(500)  NULL,
        CreatedAt   datetime2(0)   NOT NULL CONSTRAINT DF_SA_Extra_Created DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_SA_ExtraCost PRIMARY KEY CLUSTERED (ExtraId),
        CONSTRAINT CK_SA_Extra_Qty CHECK (Quantity > 0),
        CONSTRAINT CK_SA_Extra_Shift CHECK (CostShift IN ('NGAY', 'DEM'))
    );
    CREATE INDEX IX_SA_ExtraCost_Date ON dbo.SA_ExtraCost (EntryDate);
END
GO

/* ---------------------------------------------------------------------------
   8c. SA_User — Tài khoản đăng nhập

   Cột Password lưu MẬT KHẨU DẠNG THƯỜNG, không băm: hệ thống chỉ chạy trong
   mạng nội bộ nhà máy và chủ hệ thống chọn như vậy cho dễ quản lý. Hệ quả cần
   biết: ai đọc được bảng này là đọc được mật khẩu của tất cả mọi người.

   Dạng lưu do `preparePassword` trong server/auth.js quyết định; hàm
   `verifyPassword` vẫn đọc được cả bản ghi băm `scrypt$...` cũ, nên bật lại
   mã hoá sau này không khoá ai ra ngoài.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_User', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_User
    (
        UserId       int            IDENTITY(1,1) NOT NULL,
        Username     varchar(64)    NOT NULL,
        DisplayName  nvarchar(128)  NOT NULL,
        /* Mật khẩu dạng thường. Bản ghi cũ có thể còn ở dạng
           "scrypt$<muối hex>$<băm hex>" và vẫn đăng nhập được. */
        Password     varchar(256)   NOT NULL,
        IsActive     bit            NOT NULL CONSTRAINT DF_SA_User_Active DEFAULT (1),
        CreatedAt    datetime2(0)   NOT NULL CONSTRAINT DF_SA_User_Created DEFAULT (SYSDATETIME()),
        LastLoginAt  datetime2(0)   NULL,
        CONSTRAINT PK_SA_User PRIMARY KEY CLUSTERED (UserId),
        CONSTRAINT UQ_SA_User_Name UNIQUE (Username)
    );
END
GO

/* ---------------------------------------------------------------------------
   8d. SA_Session — Phiên đăng nhập còn hiệu lực

   Lưu BĂM của token chứ không lưu token: nếu ai đó đọc được bảng này thì cũng
   không mạo danh được phiên nào. Token thật chỉ tồn tại trong cookie httpOnly
   trên máy người dùng.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_Session', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_Session
    (
        TokenHash  char(64)      NOT NULL,   -- SHA-256 hex của token
        UserId     int           NOT NULL,
        CreatedAt  datetime2(0)  NOT NULL CONSTRAINT DF_SA_Session_Created DEFAULT (SYSDATETIME()),
        ExpiresAt  datetime2(0)  NOT NULL,
        UserAgent  nvarchar(256) NULL,
        CONSTRAINT PK_SA_Session PRIMARY KEY CLUSTERED (TokenHash),
        CONSTRAINT FK_SA_Session_User FOREIGN KEY (UserId)
            REFERENCES dbo.SA_User (UserId) ON DELETE CASCADE
    );
    CREATE INDEX IX_SA_Session_Expires ON dbo.SA_Session (ExpiresAt);
END
GO

/* ---------------------------------------------------------------------------
   9. SA_BirthdayConfig — Ngày tổ chức sinh nhật tập thể (suất đặc biệt)
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_BirthdayConfig', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_BirthdayConfig
    (
        ConfigId         int            IDENTITY(1,1) NOT NULL,
        ConfigDate       date           NOT NULL,
        Description      nvarchar(255)  NULL,
        SpecialMealPrice decimal(18,2)  NOT NULL,
        CreatedAt        datetime2(0)   NOT NULL CONSTRAINT DF_SA_Bday_Created DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_SA_BirthdayConfig PRIMARY KEY CLUSTERED (ConfigId),
        CONSTRAINT UQ_SA_BirthdayConfig UNIQUE (ConfigDate)
    );
END
GO

/* ---------------------------------------------------------------------------
   10. SA_ManualEntry — Nhập bổ sung suất ăn thủ công theo ca
       (máy hỏng / mất mạng / ăn đột xuất không quẹt thẻ)
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_ManualEntry', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_ManualEntry
    (
        EntryId    int            IDENTITY(1,1) NOT NULL,
        EntryDate  date           NOT NULL,
        ShiftCode  nvarchar(10)   NOT NULL,
        StaffType  varchar(2)     NOT NULL CONSTRAINT DF_SA_Manual_Staff DEFAULT ('VN'),
        Department nvarchar(64)   NOT NULL,
        Quantity   int            NOT NULL,
        Reason     nvarchar(500)  NULL,
        EnteredBy  nvarchar(128)  NULL,
        CreatedAt  datetime2(0)   NOT NULL CONSTRAINT DF_SA_Manual_Created DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_SA_ManualEntry PRIMARY KEY CLUSTERED (EntryId),
        CONSTRAINT CK_SA_Manual_Qty CHECK (Quantity > 0),
        CONSTRAINT CK_SA_Manual_Staff CHECK (StaffType IN ('KR', 'VN'))
    );
    CREATE INDEX IX_SA_ManualEntry_Date ON dbo.SA_ManualEntry (EntryDate);
END
GO

/* Bảng đã tồn tại từ trước khi suất nhập tay biết mình của người Hàn hay
   người Việt: bổ sung cột. Dòng cũ đều là suất người Việt — trước khi có cột
   này bảng kê tính toàn bộ ký số theo giá người Việt. */
IF COL_LENGTH('dbo.SA_ManualEntry', 'StaffType') IS NULL
BEGIN
    ALTER TABLE dbo.SA_ManualEntry
        ADD StaffType varchar(2) NOT NULL CONSTRAINT DF_SA_Manual_Staff DEFAULT ('VN');
END
GO

IF OBJECT_ID('dbo.CK_SA_Manual_Staff', 'C') IS NULL
BEGIN
    ALTER TABLE dbo.SA_ManualEntry
        ADD CONSTRAINT CK_SA_Manual_Staff CHECK (StaffType IN ('KR', 'VN'));
END
GO

/* ---------------------------------------------------------------------------
   11. SA_SystemSetting — Tham số hệ thống (ngưỡng quẹt bất thường, ca ăn
       sinh nhật, ...)
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_SystemSetting', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_SystemSetting
    (
        SettingKey   varchar(64)    NOT NULL,
        SettingValue nvarchar(500)  NOT NULL,
        DataType     varchar(16)    NOT NULL CONSTRAINT DF_SA_Setting_Type DEFAULT ('string'),
        Description  nvarchar(255)  NULL,
        UpdatedAt    datetime2(0)   NOT NULL CONSTRAINT DF_SA_Setting_Updated DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_SA_SystemSetting PRIMARY KEY CLUSTERED (SettingKey)
    );
END
GO

/* ---------------------------------------------------------------------------
   12. SA_MonthlyCost — Số liệu chi phí theo tháng dùng cho biểu đồ xu hướng năm
       (trước đây hard-code trong FinancialReportView.tsx)
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_MonthlyCost', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_MonthlyCost
    (
        CostMonth   char(7)        NOT NULL,   -- 'YYYY-MM'
        Label       nvarchar(16)   NOT NULL,   -- 'Jan-26'
        ComHan      decimal(18,2)  NOT NULL CONSTRAINT DF_SA_MC_ComHan  DEFAULT (0),
        ComViet     decimal(18,2)  NOT NULL CONSTRAINT DF_SA_MC_ComViet DEFAULT (0),
        DoUong      decimal(18,2)  NOT NULL CONSTRAINT DF_SA_MC_DoUong  DEFAULT (0),
        SuatNhe1    decimal(18,2)  NOT NULL CONSTRAINT DF_SA_MC_Nhe1    DEFAULT (0),
        SuatNhe2    decimal(18,2)  NOT NULL CONSTRAINT DF_SA_MC_Nhe2    DEFAULT (0),
        MyHan       decimal(18,2)  NOT NULL CONSTRAINT DF_SA_MC_MyHan   DEFAULT (0),
        SuatDacBiet decimal(18,2)  NOT NULL CONSTRAINT DF_SA_MC_DacBiet DEFAULT (0),
        TotalSum AS (ComHan + ComViet + DoUong + SuatNhe1 + SuatNhe2 + MyHan + SuatDacBiet) PERSISTED,
        CONSTRAINT PK_SA_MonthlyCost PRIMARY KEY CLUSTERED (CostMonth)
    );
END
GO

/* ---------------------------------------------------------------------------
   13. SA_ShiftMealCategory — Mỗi CA ăn của mỗi NHÓM NHÂN SỰ dùng LOẠI SUẤT nào.
       Trước đây quy tắc này nằm cứng trong code (người Hàn: CA3+CA4 -> cơm Hàn,
       còn lại -> mỳ Hàn; người Việt: CA1+CA4 -> bữa chính, còn lại -> bữa phụ).
       Nay người dùng gán được trong tab "Cấu Hình Giá Suất Ăn".

       ShiftCode nhận cả N'Khác' (lượt quẹt ngoài 6 khung giờ) nên KHÔNG đặt
       khoá ngoại tới SA_Shift.
       Thiếu dòng nào thì hệ thống rơi về đúng quy tắc mặc định ở trên.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_ShiftMealCategory', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_ShiftMealCategory
    (
        ShiftCode    nvarchar(10) NOT NULL,   -- 'CA1'..'CA6' hoặc 'Khác'
        StaffType    varchar(2)   NOT NULL,   -- 'KR' = người Hàn, 'VN' = người Việt
        MealCategory varchar(16)  NOT NULL,   -- KO_COM | KO_MY | VN_CHINH | VN_PHU | VN_SINHNHAT
        UpdatedAt    datetime2(0) NOT NULL CONSTRAINT DF_SA_ShiftMeal_Updated DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_SA_ShiftMealCategory PRIMARY KEY CLUSTERED (ShiftCode, StaffType),
        CONSTRAINT CK_SA_ShiftMeal_Staff CHECK (StaffType IN ('KR', 'VN')),
        CONSTRAINT CK_SA_ShiftMeal_Cat   CHECK (MealCategory IN
            ('KO_COM', 'KO_MY', 'VN_CHINH', 'VN_PHU', 'VN_SINHNHAT'))
    );
END
GO

/* ---------------------------------------------------------------------------
   14. TB_EVENT_LOG_DEL — LƯU TRỮ các lượt quẹt đã bị xoá khỏi hệ thống
       (popup "Điều Chỉnh Số Liệu" của tab Báo Cáo Chi Phí)

   HAI ĐIỀU PHẢI HIỂU TRƯỚC KHI SỬA BẢNG NÀY:

   1. BẢNG GỐC NẰM Ở [BioStar] VÀ LÀ READ-ONLY. Lượt quẹt thẻ do BioStar ghi
      vào BioStar.dbo.TB_EVENT_LOG; hệ thống suất ăn không được phép xoá dòng
      ở đó. Nên "xoá" ở đây là GHI TÊN VÀO SỔ LOẠI: dòng nào có mặt trong bảng
      này thì SA_MealLog_GetByRange và SA_MealCost_GetMonthly bỏ qua nó, và nó
      biến mất khỏi Dashboard, Lịch Sử Chấm Ăn, mọi bảng kê chi phí, biểu đồ
      12 tháng. Không có màn hình nào phải nhớ tự trừ.

      NGOẠI LỆ DUY NHẤT — cột DeleteKind: lượt xoá vì là SUẤT MẤT MÁT do chấm
      thẻ sai ('MAT_MAT') vẫn được SA_MealLog_GetByRange trả về, kèm cờ
      `lossDeleted = 1`, để tab Suất Ăn Mất Mát hiển thị y nguyên như chưa
      xoá; mọi màn hình khác bỏ những dòng có cờ đó. Lượt xoá "suất bất kỳ"
      ('BAT_KY', và mọi dòng có từ trước khi có cột này) thì biến mất khỏi
      tất cả, kể cả tab Suất Ăn Mất Mát.

   2. CẤU TRÚC PHẢI GIỮ Y HỆT BioStar.dbo.TB_EVENT_LOG — chín cột đầu, đúng
      tên, đúng kiểu, đúng thứ tự. Nhờ vậy khôi phục là một câu INSERT thẳng:

          INSERT INTO BioStar.dbo.TB_EVENT_LOG
                 (nDateTime, nReaderIdn, nEventIdn, nUserID,
                  nIsLog, nTNAEvent, nIsUseTA, nType)
          SELECT  nDateTime, nReaderIdn, nEventIdn, nUserID,
                  nIsLog, nTNAEvent, nIsUseTA, nType
          FROM dbo.TB_EVENT_LOG_DEL WHERE DeleteBatchId = '...';

      (Bốn cột nhật ký ở cuối là phần THÊM, không thuộc bảng gốc; nEventLogIdn
      là IDENTITY bên BioStar nên câu INSERT trên bỏ nó ra.) Thực tế dòng gốc
      vẫn còn nguyên bên BioStar nên khôi phục chỉ cần XOÁ khỏi bảng này —
      SA_MealLogDeleted_Restore làm đúng việc đó; câu INSERT trên là đường lui
      cho trường hợp một ngày nào đó BioStar mất dữ liệu thật.

   Khoá chính là nEventLogIdn (IDENTITY bên BioStar, duy nhất), cũng đúng là
   `MealLog.id` mà phía client cầm.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.TB_EVENT_LOG_DEL', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.TB_EVENT_LOG_DEL
    (
        /* --- Y NGUYÊN cấu trúc BioStar.dbo.TB_EVENT_LOG ------------------- */
        nEventLogIdn  int              NOT NULL,
        nDateTime     int              NOT NULL,
        nReaderIdn    int              NOT NULL,
        nEventIdn     int              NOT NULL,
        nUserID       int              NOT NULL,
        nIsLog        smallint         NOT NULL,
        nTNAEvent     smallint         NOT NULL,
        nIsUseTA      smallint         NOT NULL,
        nType         smallint         NOT NULL,
        /* --- Nhật ký xoá, thêm vào CUỐI để câu INSERT khôi phục ở trên
               chỉ cần liệt kê chín cột đầu ----------------------------------- */
        DeleteBatchId uniqueidentifier NOT NULL,
        DeletedAt     datetime2(0)     NOT NULL CONSTRAINT DF_TB_EventLogDel_At DEFAULT (SYSDATETIME()),
        DeletedBy     nvarchar(128)    NULL,
        DeleteReason  nvarchar(255)    NULL,
        DeleteKind    varchar(8)       NOT NULL CONSTRAINT DF_TB_EventLogDel_Kind DEFAULT ('BAT_KY'),
        CONSTRAINT PK_TB_EVENT_LOG_DEL PRIMARY KEY CLUSTERED (nEventLogIdn)
    );
    /* Lọc theo lượt xoá (để khôi phục) và theo thời điểm quẹt (để thống kê
       một khoảng ngày đã xoá bao nhiêu). */
    CREATE INDEX IX_TB_EVENT_LOG_DEL_Batch    ON dbo.TB_EVENT_LOG_DEL (DeleteBatchId);
    CREATE INDEX IX_TB_EVENT_LOG_DEL_DateTime ON dbo.TB_EVENT_LOG_DEL (nDateTime);
END
GO

/* DeleteKind — VÌ SAO lượt quẹt bị xoá, quyết định nó còn hiện ở đâu:
     'MAT_MAT' = suất mất mát do chấm thẻ sai (quẹt trùng ca / vượt hạn mức).
                 Bị trừ khỏi mọi con số, nhưng tab Suất Ăn Mất Mát vẫn thấy.
     'BAT_KY'  = khoản "xoá suất ăn bất kỳ" người dùng tự nhập. Biến mất khỏi
                 toàn hệ thống.
   Dòng có từ trước khi có cột này là 'BAT_KY' — đúng hành vi lúc chúng bị
   xoá. Cột nằm SAU bốn cột nhật ký nên câu INSERT khôi phục ở trên không đổi. */
IF COL_LENGTH('dbo.TB_EVENT_LOG_DEL', 'DeleteKind') IS NULL
BEGIN
    ALTER TABLE dbo.TB_EVENT_LOG_DEL
        ADD DeleteKind varchar(8) NOT NULL CONSTRAINT DF_TB_EventLogDel_Kind DEFAULT ('BAT_KY');
END
GO

IF OBJECT_ID('dbo.CK_TB_EventLogDel_Kind', 'C') IS NULL
BEGIN
    ALTER TABLE dbo.TB_EVENT_LOG_DEL
        ADD CONSTRAINT CK_TB_EventLogDel_Kind CHECK (DeleteKind IN ('MAT_MAT', 'BAT_KY'));
END
GO

/* ---------------------------------------------------------------------------
   15. SA_EventIdList — kiểu bảng để truyền DANH SÁCH lượt quẹt cần xoá

   Một lần chốt số với nhà ăn có thể bỏ hàng nghìn lượt quẹt trùng ca. Nối
   chuỗi id rồi tách trong procedure là vừa chậm vừa mở đường cho lỗi định
   dạng, nên truyền bằng table-valued parameter — mssql bind thẳng một mảng
   xuống đây.

   KHÔNG nằm trong 03_procedures.sql: script đó DROP rồi CREATE lại procedure
   mỗi lần chạy, mà một TYPE đang được procedure tham chiếu thì không drop
   được. Kiểu này tạo một lần rồi thôi.
   --------------------------------------------------------------------------- */
IF TYPE_ID('dbo.SA_EventIdList') IS NULL
BEGIN
    CREATE TYPE dbo.SA_EventIdList AS TABLE
    (
        EventLogIdn int NOT NULL PRIMARY KEY
    );
END
GO

/* ---------------------------------------------------------------------------
   16. SA_GuestDeptOverride — Gán lại bộ phận lớn cho TỪNG khách công tác

   Quy tắc chung (SA_DepartmentMappingRule) quét cả một nhóm: "Khach cong tac"
   có tên chứa 'Business' đều vào KR. Nhưng khách công tác là thẻ dùng chung,
   và trên thực tế mỗi người khách lại làm việc với một bộ phận khác nhau —
   suất ăn của họ phải tính vào bộ phận đó, theo đúng giá của bộ phận đó.
   Bảng này là chỗ ghi ngoại lệ cho từng người.

   CHỈ ÁP DỤNG CHO NGƯỜI ĐƯỢC MỘT QUY TẮC QUÉT VÀO (hôm nay: đúng nhóm khách
   công tác 'Business'). Điều kiện đó nằm trong view dbo.SA_UserDeptResolved
   (cột IsRuleMatched) chứ không viết cứng chuỗi 'Business' ở đây — quy tắc là
   dữ liệu, người dùng sửa được, nên chỉ được hỏi nó chứ không chép lại nó.
   SA_GuestDeptOverride_Save từ chối mọi nhân viên không thuộc diện này, nên
   không thể lách qua API để gán lại bộ phận cho một nhân viên chính thức.

   Thứ tự ưu tiên đầy đủ khi giải bộ phận lớn của một người:
       override (chỉ khi có rule khớp) > rule > SA_DepartmentMapping > 'Khác'

   Đổi bộ phận lớn là đổi luôn NHÓM GIÁ: `StaffType` = 'KR' khi và chỉ khi bộ
   phận lớn là KR, nên chuyển một khách Business sang SP là suất của họ tự
   động tính theo giá người Việt. Không có bảng giá riêng nào phải sửa.

   MỘT KHÁCH CÓ NHIỀU ĐỢT: mỗi dòng là MỘT ĐỢT (UserId, khoảng ngày) →
   LargeDeptCode. Thẻ khách công tác dùng chung và người khách chỉ ở nhà máy
   vài tuần rồi về, nên cùng một mã thẻ tháng 8 là người làm với SP, tháng 9
   đã là người khác làm với LFEM — hai đợt độc lập, không đợt nào ghi đè đợt
   nào. Khoá chính vì thế là OverrideId (IDENTITY) chứ không phải UserId;
   UserId vẫn là mã thẻ BioStar, tên hiển thị sửa được nên không dùng làm khoá.

   HAI ĐỢT CỦA CÙNG MỘT KHÁCH KHÔNG ĐƯỢC GIAO NHAU — nếu giao thì một lượt
   quẹt sẽ có hai bộ phận và không có câu trả lời đúng. Ràng buộc đó không
   diễn đạt được bằng CHECK (nó nhìn sang dòng khác), nên nó nằm trong
   SA_GuestDeptOverride_Save: procedure kiểm và RAISERROR kèm tên đợt bị đụng,
   chứ không phải giao diện tự kiểm — API không được tin client.

   EffectiveFrom / EffectiveTo là khoảng NGÀY đợt có hiệu lực; NULL nghĩa là
   KHÔNG GIỚI HẠN đầu đó (cả hai NULL = vĩnh viễn, đúng hành vi của những dòng
   có từ trước khi bảng biết đến thời hạn, nên nâng cấp không đổi số liệu cũ).
   Ngoài mọi đợt, lượt quẹt tính vào BaseLargeDept (rule > ánh xạ > 'Khác').

   Ngày đem ra so là NGÀY LỊCH CỦA LƯỢT QUẸT (actualDate) — bộ phận là thuộc
   tính của con người tại thời điểm quẹt, không phải của cột ngày trên báo cáo.
   Phép so đó nằm trong SA_MealLog_GetByRange và SA_MealCost_GetMonthly (xem
   chú thích "HIỆU LỰC THEO NGÀY" ở cả hai) — sửa một bên phải sửa bên kia.
   Không có giới hạn nào về quá khứ: đang tháng 9 vẫn tạo được đợt của tháng 8,
   và lượt quẹt tháng 8 lập tức tính lại theo đợt đó.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SA_GuestDeptOverride', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SA_GuestDeptOverride
    (
        OverrideId    int           NOT NULL IDENTITY(1,1),
        UserId        varchar(64)   NOT NULL,   -- BioStar TB_USER.sUserID
        LargeDeptCode nvarchar(32)  NOT NULL,
        EffectiveFrom date          NULL,       -- NULL = không giới hạn đầu trái
        EffectiveTo   date          NULL,       -- NULL = không giới hạn đầu phải
        Notes         nvarchar(255) NULL,
        UpdatedAt     datetime2(0)  NOT NULL CONSTRAINT DF_SA_GuestOv_Updated DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_SA_GuestOverride_Id PRIMARY KEY CLUSTERED (OverrideId),
        CONSTRAINT FK_SA_GuestOv_LargeDept FOREIGN KEY (LargeDeptCode)
            REFERENCES dbo.SA_LargeDepartment (LargeDeptCode),
        CONSTRAINT CK_SA_GuestOv_Range CHECK (EffectiveFrom IS NULL
                                           OR EffectiveTo   IS NULL
                                           OR EffectiveTo  >= EffectiveFrom)
    );
    CREATE INDEX IX_SA_GuestOv_User ON dbo.SA_GuestDeptOverride (UserId, EffectiveFrom);
END
GO

/* Bảng đã tồn tại từ trước khi ngoại lệ biết mình có thời hạn: bổ sung cột.
   Dòng cũ để NULL cả hai = hiệu lực vĩnh viễn, đúng hành vi trước đây. */
IF COL_LENGTH('dbo.SA_GuestDeptOverride', 'EffectiveFrom') IS NULL
BEGIN
    ALTER TABLE dbo.SA_GuestDeptOverride ADD EffectiveFrom date NULL;
END
GO

IF COL_LENGTH('dbo.SA_GuestDeptOverride', 'EffectiveTo') IS NULL
BEGIN
    ALTER TABLE dbo.SA_GuestDeptOverride ADD EffectiveTo date NULL;
END
GO

/* Bảng đã tồn tại từ khi MỖI KHÁCH CHỈ ĐƯỢC MỘT ngoại lệ (khoá chính là
   UserId): bỏ khoá đó đi và thêm OverrideId để một khách có nhiều đợt. Dòng
   sẵn có được đánh số tự động và giữ nguyên nội dung. */
IF COL_LENGTH('dbo.SA_GuestDeptOverride', 'OverrideId') IS NULL
BEGIN
    IF OBJECT_ID('dbo.PK_SA_GuestDeptOverride', 'PK') IS NOT NULL
        ALTER TABLE dbo.SA_GuestDeptOverride DROP CONSTRAINT PK_SA_GuestDeptOverride;

    ALTER TABLE dbo.SA_GuestDeptOverride ADD OverrideId int NOT NULL IDENTITY(1,1);
END
GO

IF OBJECT_ID('dbo.PK_SA_GuestOverride_Id', 'PK') IS NULL
BEGIN
    ALTER TABLE dbo.SA_GuestDeptOverride
        ADD CONSTRAINT PK_SA_GuestOverride_Id PRIMARY KEY CLUSTERED (OverrideId);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_SA_GuestOv_User'
                 AND object_id = OBJECT_ID('dbo.SA_GuestDeptOverride'))
BEGIN
    CREATE INDEX IX_SA_GuestOv_User ON dbo.SA_GuestDeptOverride (UserId, EffectiveFrom);
END
GO

IF OBJECT_ID('dbo.CK_SA_GuestOv_Range', 'C') IS NULL
BEGIN
    ALTER TABLE dbo.SA_GuestDeptOverride
        ADD CONSTRAINT CK_SA_GuestOv_Range CHECK (EffectiveFrom IS NULL
                                               OR EffectiveTo   IS NULL
                                               OR EffectiveTo  >= EffectiveFrom);
END
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

PRINT '01_schema.sql: DONE';
GO
