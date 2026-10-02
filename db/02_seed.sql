/* ============================================================================
   02_seed.sql — Dữ liệu danh mục cho hệ thống suất ăn.
   Script chạy lại được nhiều lần (idempotent): chỉ INSERT khi chưa có.

   LƯU Ý: script này CHỈ seed dữ liệu DANH MỤC (bộ phận lớn, ánh xạ bộ phận,
   ca ăn, máy đọc thẻ, mã sự kiện, đơn giá, tham số hệ thống, số liệu biểu đồ
   xu hướng năm đã có sẵn). Các bảng nghiệp vụ SA_MilkEntry / SA_BirthdayConfig
   / SA_ManualEntry được để TRỐNG — dữ liệu thật do người dùng nhập qua giao diện.
   ============================================================================ */

USE [QLSA];
GO

/* Bắt buộc: các bảng có cột tính toán PERSISTED yêu cầu QUOTED_IDENTIFIER ON.
   sqlcmd mặc định để OFF nên phải bật tường minh. */
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET NOCOUNT ON;
GO

/* ---------------------------------------------------------------------------
   1. Bộ phận lớn
   --------------------------------------------------------------------------- */
MERGE dbo.SA_LargeDepartment AS T
USING (VALUES
    (N'CSP',  N'CSP',                      1),
    (N'LFEM', N'LFEM',                     2),
    (N'SMT',  N'SMT',                      3),
    (N'SP',   N'Support / Khối gián tiếp', 4),
    (N'QC',   N'Quality Control',          5),
    (N'WLP1', N'WLP 1',                    6),
    (N'WLP2', N'WLP 2',                    7),
    (N'R&D',  N'Research & Development',   8),
    (N'KR',   N'Korea / Chuyên gia Hàn',   9),
    (N'Khác', N'Khác (chưa ánh xạ)',      99)
) AS S (LargeDeptCode, LargeDeptName, SortOrder)
ON T.LargeDeptCode = S.LargeDeptCode
WHEN NOT MATCHED BY TARGET THEN
    INSERT (LargeDeptCode, LargeDeptName, SortOrder)
    VALUES (S.LargeDeptCode, S.LargeDeptName, S.SortOrder);
GO

/* ---------------------------------------------------------------------------
   2. Ánh xạ bộ phận nhỏ -> bộ phận lớn  (theo bảng ánh xạ nghiệp vụ)
      Tên bộ phận nhỏ khớp chính xác BioStar.dbo.TB_USER_DEPT.sName
   --------------------------------------------------------------------------- */
MERGE dbo.SA_DepartmentMapping AS T
USING (VALUES
    -- CSP
    (N'CSP',                N'CSP',  N'Phòng CSP chung'),
    (N'CSP Operator',       N'CSP',  N'Vận hành CSP'),
    (N'CSP Staff',          N'CSP',  N'Nghiệp vụ CSP'),
    (N'CSP Technology',     N'CSP',  N'Kỹ thuật CSP'),

    -- KR
    (N'Korean VN',          N'KR',   N'Chuyên gia Hàn Quốc'),

    -- LFEM
    (N'LFEM',               N'LFEM', N'LFEM'),

    -- QC
    (N'FQC - CSP',          N'QC',   N'FQC CSP'),
    (N'FQC - LFEM',         N'QC',   N'FQC LFEM'),
    (N'OQC_CSP',            N'QC',   N'OQC CSP'),
    (N'OQC_LFEM',           N'QC',   N'OQC LFEM'),
    (N'OQC_WLP',            N'QC',   N'OQC WLP'),
    (N'PQC',                N'QC',   N'PQC'),
    (N'QC_CS',              N'QC',   N'QC CS'),
    (N'QC_IQC',             N'QC',   N'IQC'),

    -- R&D
    (N'R&D',                N'R&D',  N'Nghiên cứu & Phát triển'),

    -- SMT
    (N'SMT Production',     N'SMT',  N'Sản xuất SMT'),
    (N'SMT Technology',     N'SMT',  N'Kỹ thuật SMT'),

    -- SP
    (N'Accounting',         N'SP',   N'Kế toán'),
    (N'Bao ve Binh An',     N'SP',   N'Bảo vệ Bình An'),
    (N'Board of Director',  N'SP',   N'Ban giám đốc'),
    (N'Card Visitor Wisol', N'SP',   N'Thẻ khách Wisol'),
    (N'Driver',             N'SP',   N'Tài xế'),
    (N'HR&AG',              N'SP',   N'Hành chính Nhân sự'),
    (N'Lai Xe',             N'SP',   N'Đội lái xe'),
    (N'Logistic',           N'SP',   N'Kho vận'),
    (N'PI',                 N'SP',   N'Process Improvement'),
    (N'Production Control', N'SP',   N'Quản lý sản xuất'),
    (N'Purchasing',         N'SP',   N'Mua hàng'),
    (N'Reability',          N'SP',   N'Reliability'),
    (N'Utility',            N'SP',   N'Tiện ích'),
    (N'Ve sinh Mai Linh',   N'SP',   N'Vệ sinh Mai Linh'),
    (N'Warehouse',          N'SP',   N'Kho'),
    -- Mặc định 'Khach cong tac' thuộc SP; xem SA_DepartmentMappingRule cho
    -- trường hợp tên nhân viên có chứa 'Business' -> KR.
    (N'Khach cong tac',     N'SP',   N'Khách công tác (mặc định SP; chứa ''Business'' -> KR)'),

    -- WLP1
    (N'WLP 1',              N'WLP1', N'WLP 1'),
    (N'WLP 1 Operator',     N'WLP1', N'Vận hành WLP 1'),
    (N'WLP 1 Staff',        N'WLP1', N'Nhân viên WLP 1'),
    (N'WLP 1 Technology',   N'WLP1', N'Kỹ thuật WLP 1'),

    -- WLP2
    (N'WLP 2',              N'WLP2', N'WLP 2'),
    (N'WLP 2 Operator',     N'WLP2', N'Vận hành WLP 2'),
    (N'WLP 2 Staff',        N'WLP2', N'Nhân viên WLP 2'),
    (N'WLP 2 technology',   N'WLP2', N'Kỹ thuật WLP 2')
) AS S (SmallDepartment, LargeDeptCode, Notes)
ON T.SmallDepartment = S.SmallDepartment
WHEN NOT MATCHED BY TARGET THEN
    INSERT (SmallDepartment, LargeDeptCode, Notes)
    VALUES (S.SmallDepartment, S.LargeDeptCode, S.Notes);
GO

/* ---------------------------------------------------------------------------
   3. Quy tắc ánh xạ có điều kiện
      "Chỉ những tên 'Khach cong tac' có sUserName chứa 'Business' mới được cho
       vào mục KR. Nếu sUserName không chứa 'Business' thì thuộc bộ phận chung SP."
      Nhánh SP là mapping mặc định ở trên nên chỉ cần 1 rule cho nhánh KR.
   --------------------------------------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM dbo.SA_DepartmentMappingRule
               WHERE SmallDepartment = N'Khach cong tac' AND MatchValue = N'Business')
BEGIN
    INSERT INTO dbo.SA_DepartmentMappingRule
        (SmallDepartment, MatchField, MatchOperator, MatchValue, LargeDeptCode, Priority, Notes)
    VALUES
        (N'Khach cong tac', 'sUserName', 'CONTAINS', N'Business', N'KR', 10,
         N'Khách công tác có tên chứa ''Business'' được tính vào bộ phận lớn KR');
END
GO

/* ---------------------------------------------------------------------------
   4. Ca ăn — khung giờ khớp với engine phân ca của ứng dụng.
      CA1 vắt qua nửa đêm: điều kiện (t >= 22:50:00 OR t <= 01:50:00).
   --------------------------------------------------------------------------- */
MERGE dbo.SA_Shift AS T
USING (VALUES
    (N'CA1', N'Ca 1 (Ca Đêm)',           N'23H', '22:50:00', '01:50:00', 1, N'Ăn ca đêm (22:50 - 01:50)',        1),
    (N'CA2', N'Ca 2 (Sáng Sớm)',         N'5H',  '04:30:00', '06:44:00', 0, N'Ăn ca sáng sớm (04:30 - 06:44)',   2),
    (N'CA3', N'Ca 3 (Bữa Sáng)',         N'7H',  '06:45:00', '08:10:00', 0, N'Ăn ca sáng (06:45 - 08:10)',       3),
    (N'CA4', N'Ca 4 (Bữa Trưa)',         N'12H', '10:40:00', '13:30:00', 0, N'Ăn ca trưa (10:40 - 13:30)',       4),
    (N'CA5', N'Ca 5 (Bữa Chiều)',        N'17H', '16:30:00', '18:44:00', 0, N'Ăn ca chiều (16:30 - 18:44)',      5),
    (N'CA6', N'Ca 6 (Bữa Tối Tăng Ca)',  N'19H', '18:45:00', '20:10:00', 0, N'Ăn ca tăng ca tối (18:45 - 20:10)',6)
) AS S (ShiftCode, ShiftName, ShiftReName, StartTime, EndTime, WrapsMidnight, Description, SortOrder)
ON T.ShiftCode = S.ShiftCode
WHEN NOT MATCHED BY TARGET THEN
    INSERT (ShiftCode, ShiftName, ShiftReName, StartTime, EndTime, WrapsMidnight, Description, SortOrder)
    VALUES (S.ShiftCode, S.ShiftName, S.ShiftReName, S.StartTime, S.EndTime, S.WrapsMidnight, S.Description, S.SortOrder)
/* Tên ca trên bảng kê là cột mới — điền cho cả những cài đặt đã có sẵn dữ
   liệu. Các cột còn lại vẫn không bị ghi đè: người dùng có thể đã chỉnh
   khung giờ ngay trên SQL Server. */
WHEN MATCHED AND T.ShiftReName IS NULL THEN
    UPDATE SET T.ShiftReName = S.ShiftReName;
GO

/* ---------------------------------------------------------------------------
   5. Máy chấm ăn — nReaderIdn lấy đúng từ BioStar.dbo.TB_READER
   --------------------------------------------------------------------------- */
MERGE dbo.SA_Reader AS T
USING (VALUES
    (547244626, N'TA-104', N'TA-104(CanteenK)[10.70.22.104]', '10.70.22.104', N'Nhà ăn Canteen K',          0),
    (547246370, N'TA-103', N'TA-103(CanteenV)[10.70.22.103]', '10.70.22.103', N'Nhà ăn Canteen V',          0),
    (547244627, N'TA-102', N'TA-102(CT Korea)[10.70.22.102]', '10.70.22.102', N'Nhà ăn Canteen Hàn Quốc',   1)
) AS S (ReaderIdn, ReaderCode, ReaderName, IP, Location, IsKoreanMachine)
ON T.ReaderIdn = S.ReaderIdn
WHEN NOT MATCHED BY TARGET THEN
    INSERT (ReaderIdn, ReaderCode, ReaderName, IP, Location, IsKoreanMachine)
    VALUES (S.ReaderIdn, S.ReaderCode, S.ReaderName, S.IP, S.Location, S.IsKoreanMachine);
GO

/* ---------------------------------------------------------------------------
   6. Mã sự kiện BioStar được tính là 1 lượt chấm ăn hợp lệ.
   --------------------------------------------------------------------------- */
MERGE dbo.SA_MealEventCode AS T
USING (VALUES
    (39, N'Xác thực thành công'), (43, N'Xác thực thành công'), (44, N'Xác thực thành công'),
    (45, N'Xác thực thành công'), (46, N'Xác thực thành công'), (47, N'Xác thực thành công'),
    (48, N'Xác thực thành công'), (49, N'Xác thực thành công'), (50, N'Xác thực thành công'),
    (51, N'Xác thực thành công'), (52, N'Xác thực thành công'), (53, N'Xác thực thành công'),
    (55, N'Xác thực thành công'), (58, N'Xác thực thành công'), (59, N'Xác thực thành công'),
    (61, N'Xác thực thành công'), (62, N'Xác thực thành công')
) AS S (EventIdn, Description)
ON T.EventIdn = S.EventIdn
WHEN NOT MATCHED BY TARGET THEN
    INSERT (EventIdn, Description) VALUES (S.EventIdn, S.Description);
GO

/* ---------------------------------------------------------------------------
   7. Đơn giá suất ăn
   --------------------------------------------------------------------------- */
MERGE dbo.SA_MealPrice AS T
USING (VALUES
    ('COM_VIET',      N'Cơm Việt Nam',                    28000, N'Suất'),
    -- Bữa phụ: các ca người Việt được gán VN_PHU (mặc định CA3 7H, CA6 19H).
    ('COM_VIET_PHU',  N'Bữa phụ Việt Nam',                20000, N'Suất'),
    ('COM_HAN',       N'Cơm Hàn Quốc',                    65000, N'Suất'),
    ('MY_HAN',        N'Mỳ Hàn Quốc',                     30000, N'Tô'),
    ('SUAT_NHE_1',    N'Suất ăn nhẹ 1',                   10000, N'Phần'),
    ('SUAT_NHE_2',    N'Suất ăn nhẹ 2',                    7000, N'Phần'),
    ('SUAT_DAC_BIET', N'Suất đặc biệt (Sinh nhật / Lễ)',  50000, N'Suất'),
    ('SUA_KHANH_HOA', N'Sữa Vinamilk (1 Lit)',            31000, N'Hộp')
) AS S (Code, Name, UnitPrice, Unit)
ON T.Code = S.Code
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Code, Name, UnitPrice, Unit) VALUES (S.Code, S.Name, S.UnitPrice, S.Unit);
GO

/* ---------------------------------------------------------------------------
   8. Tham số hệ thống
   --------------------------------------------------------------------------- */
MERGE dbo.SA_SystemSetting AS T
USING (VALUES
    ('ABNORMAL_MIN_PUNCH', N'3',        'number', N'Số lượt chấm trong 1 ngày công vượt quá mức này thì coi là bất thường'),
    ('BIRTHDAY_SHIFTS',    N'CA1,CA4',  'string', N'Các ca được ăn suất sinh nhật trong ngày sinh nhật tập thể')
) AS S (SettingKey, SettingValue, DataType, Description)
ON T.SettingKey = S.SettingKey
WHEN NOT MATCHED BY TARGET THEN
    INSERT (SettingKey, SettingValue, DataType, Description)
    VALUES (S.SettingKey, S.SettingValue, S.DataType, S.Description);
GO

/* ---------------------------------------------------------------------------
   9. Số liệu chi phí theo tháng cho biểu đồ xu hướng năm.
      Số liệu chép lại từ bảng tính nguồn (trước đây hard-code trong
      FinancialReportView.tsx). Sửa trực tiếp trong bảng này khi có số mới.
   --------------------------------------------------------------------------- */
MERGE dbo.SA_MonthlyCost AS T
USING (VALUES
    ('2026-01', N'Jan-26', 27040, 1036968, 53351,  9040, 7000,  990, 30650),
    ('2026-02', N'Feb-26', 26390,  891216, 46810,     0, 7000,  300, 29900),
    ('2026-03', N'Mar-26', 44590, 1040560, 54777,     0, 7000, 1650, 32800),
    ('2026-04', N'Apr-26', 50440, 1192500, 64170, 14780, 7000, 2280, 64800),
    ('2026-05', N'May-26', 30875, 1035548, 56017, 29960, 7000, 1320, 67250),
    ('2026-06', N'Jun-26', 47775, 1144796, 60698, 14420, 7000, 1470, 31800),
    ('2026-07', N'Jul-26', 47775, 1169876, 60760,     0, 7000, 1260, 33400)
) AS S (CostMonth, Label, ComHan, ComViet, DoUong, SuatNhe1, SuatNhe2, MyHan, SuatDacBiet)
ON T.CostMonth = S.CostMonth
WHEN NOT MATCHED BY TARGET THEN
    INSERT (CostMonth, Label, ComHan, ComViet, DoUong, SuatNhe1, SuatNhe2, MyHan, SuatDacBiet)
    VALUES (S.CostMonth, S.Label, S.ComHan, S.ComViet, S.DoUong, S.SuatNhe1, S.SuatNhe2, S.MyHan, S.SuatDacBiet);
GO

/* ---------------------------------------------------------------------------
   10. Loại suất áp cho từng ca — giá trị khởi tạo đúng bằng quy tắc cũ đã nằm
       cứng trong code:
         Người Hàn : CA3 + CA4 -> cơm Hàn,   các ca còn lại -> mỳ Hàn.
         Người Việt: CA1 + CA4 -> bữa chính, các ca còn lại -> bữa phụ.
       Người dùng đổi lại được trong tab "Cấu Hình Giá Suất Ăn"; MERGE chỉ chèn
       dòng còn thiếu nên chạy lại script KHÔNG ghi đè cấu hình đang dùng.
       Ngày sinh nhật vẫn đè lên loại suất của người Việt, không cấu hình ở đây.
   --------------------------------------------------------------------------- */
/* Đơn giá người Việt bám theo bảng kê nhà ăn: 23H/5H/12H/17H = 28.000
   (VN_CHINH), 7H/19H = 20.000 (VN_PHU). Ca nào ĐƯỢC ĂN SUẤT SINH NHẬT là
   tham số riêng (SA_SystemSetting.BIRTHDAY_SHIFTS), không suy ra từ bảng này. */
MERGE dbo.SA_ShiftMealCategory AS T
USING (VALUES
    (N'CA1',  'KR', 'KO_MY'),   (N'CA1',  'VN', 'VN_CHINH'),
    (N'CA2',  'KR', 'KO_MY'),   (N'CA2',  'VN', 'VN_CHINH'),
    (N'CA3',  'KR', 'KO_COM'),  (N'CA3',  'VN', 'VN_PHU'),
    (N'CA4',  'KR', 'KO_COM'),  (N'CA4',  'VN', 'VN_CHINH'),
    (N'CA5',  'KR', 'KO_MY'),   (N'CA5',  'VN', 'VN_CHINH'),
    (N'CA6',  'KR', 'KO_MY'),   (N'CA6',  'VN', 'VN_PHU'),
    (N'Khác', 'KR', 'KO_MY'),   (N'Khác', 'VN', 'VN_PHU')
) AS S (ShiftCode, StaffType, MealCategory)
ON T.ShiftCode = S.ShiftCode AND T.StaffType = S.StaffType
WHEN NOT MATCHED BY TARGET THEN
    INSERT (ShiftCode, StaffType, MealCategory)
    VALUES (S.ShiftCode, S.StaffType, S.MealCategory);
GO

PRINT '02_seed.sql: DONE';
GO
