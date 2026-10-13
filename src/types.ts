export type ShiftCode = "CA1" | "CA2" | "CA3" | "CA4" | "CA5" | "CA6" | "Khác";

/** Nhóm nhân sự quyết định cột giá: người Hàn / người Việt. */
export type StaffType = "KR" | "VN";

export type MealCategory =
  | "KO_COM"
  | "KO_MY"
  | "VN_CHINH"
  | "VN_PHU"
  | "VN_SINHNHAT";

/**
 * Một ô của bảng "giá áp dụng theo ca" (SA_ShiftMealCategory): ca này, nhóm
 * nhân sự này thì tính theo loại suất nào. Người dùng gán trong tab Cấu Hình
 * Giá Suất Ăn; thiếu dòng nào thì classifyMeal rơi về quy tắc mặc định.
 */
export interface ShiftMealCategory {
  shiftCode: ShiftCode;
  staffType: StaffType;
  mealCategory: MealCategory;
}

export interface ShiftInfo {
  code: ShiftCode;
  name: string;
  startTime: string; // e.g. "22:50:00"
  endTime: string; // e.g. "01:50:00"
  /** CA1 vắt qua nửa đêm: điều kiện là (t >= start OR t <= end). */
  wrapsMidnight?: boolean;
  description: string;
  ShiftReName: string; // e.g. "CA1" or "23H"
}

export interface ReaderInfo {
  id: number;
  code: string;
  name: string;
  ip: string;
  location: string;
  isKoreanMachine: boolean; // Machine 3 = CT Korea
}

export interface DepartmentMapping {
  id?: number;
  smallDepartment: string;
  largeDepartment: string;
  notes?: string;
}

/**
 * Một KHÁCH CÔNG TÁC thuộc diện được gán lại bộ phận lớn (SA_GuestDeptOverride).
 *
 * Thẻ khách công tác dùng chung, mỗi người khách lại làm việc với một bộ phận
 * khác nhau, nên quy tắc chung "tên chứa 'Business' -> KR" không đủ: suất ăn
 * của từng người phải tính vào đúng bộ phận họ đến làm việc, theo đúng giá của
 * bộ phận đó. Chỉ những người ĐƯỢC MỘT QUY TẮC QUÉT VÀO mới có mặt trong danh
 * sách này — máy chủ tự kiểm tra, xem SA_GuestDeptOverride_Save.
 */
export interface GuestDeptOverride {
  /** Mã thẻ BioStar (TB_USER.sUserID) — danh tính, không phải tên hiển thị. */
  userId: string;
  userName: string;
  department: string;
  /** Bộ phận mà quy tắc chung gán cho cả nhóm (hiện tại: KR). */
  defaultLargeDepartment: string;
  /**
   * Bộ phận đang dùng TÍNH ĐẾN HÔM NAY. Mỗi lượt quẹt vẫn được giải theo ngày
   * quẹt của chính nó, nên đây là cột để nhìn chứ không phải con số báo cáo.
   */
  largeDepartment: string;
  /** Số lượt quẹt trong khoảng lọc đang xem. */
  punchCount: number;
  /** Số đợt ánh xạ đã áp dụng cho khách này (xem `GuestDeptPeriod`). */
  periodCount: number;
}

/**
 * MỘT ĐỢT ánh xạ bộ phận của một khách công tác (một dòng
 * SA_GuestDeptOverride).
 *
 * Một khách có thể có nhiều đợt nối tiếp nhau — thẻ khách dùng chung, tháng
 * này là người làm với SP, tháng sau đã là người khác làm với LFEM. Các đợt
 * của cùng một khách KHÔNG được giao nhau; SA_GuestDeptOverride_Save chặn và
 * báo đúng đợt bị đụng.
 *
 * Lượt quẹt rơi vào đợt nào thì tính vào bộ phận của đợt đó, so bằng NGÀY
 * QUẸT; không rơi vào đợt nào thì tính vào `defaultLargeDepartment` của khách.
 * Toàn bộ phép so nằm trong SQL, client chỉ hiển thị.
 */
export interface GuestDeptPeriod {
  overrideId: number;
  userId: string;
  userName: string;
  largeDepartment: string;
  /** 'YYYY-MM-DD'; null = không giới hạn đầu đó. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** false = quy tắc không còn quét khách này vào, đợt đang bị bỏ qua. */
  isActiveScope: boolean;
  notes: string | null;
  updatedAt: string;
}

/** Danh mục bộ phận lớn (SA_LargeDepartment). */
export interface LargeDepartmentInfo {
  code: string;
  name: string;
  sortOrder: number;
}

/** Bộ phận nhỏ thật trong BioStar kèm trạng thái đã/chưa ánh xạ. */
export interface SmallDepartmentInfo {
  smallDepartment: string;
  largeDepartment: string;
  isMapped: boolean;
  userCount: number;
}

/**
 * Một dòng chi phí tháng cho biểu đồ xu hướng năm.
 * Tính từ log chấm ăn thật bởi SA_MealCost_GetMonthly — các trường `*Count` là
 * số suất, các trường còn lại là thành tiền (VNĐ).
 */
export interface MonthlyCostRow {
  costMonth: string; // "YYYY-MM"
  month: string; // nhãn hiển thị, vd "August-26"
  ComHanCount: number;
  MyHanCount: number;
  ComVietCount: number;
  ComVietPhuCount: number;
  SuatDacBietCount: number;
  ComHan: number;
  MyHan: number;
  ComViet: number;
  ComVietPhu: number;
  SuatDacBiet: number;
  Sua: number;
  /** Tiền các hạng mục phát sinh (SA_ExtraCost) trong tháng. */
  ChiPhiPhatSinh: number;
  /**
   * Tiền thuê nhân công của tháng. KHÔNG do SA_MealCost_GetMonthly trả về —
   * `withLaborCost` (src/components/financial/reportModel.ts) cộng vào ở phía
   * client, vì phép chia tiền theo ngày làm việc chỉ được có một bản cài đặt.
   * Vì thế trường này vắng mặt trên dòng vừa lấy từ API; đọc qua
   * `yearlyValue` chứ đừng đọc thẳng.
   */
  ChiPhiNhanCong?: number;
  /** Tổng tháng. Đã gồm chi phí nhân công sau khi qua `withLaborCost`. */
  Sum: number;
  /**
   * KỲ của tháng, nửa mở [fromDateTime, toDateTime), "YYYY-MM-DD HH:mm:ss" —
   * xem `CostMonthPeriod`. Mọi cột của dòng được SQL xếp theo kỳ này, và
   * `withLaborCost` cắt chi phí nhân công theo đúng hai mốc này. Vắng khi máy
   * chủ còn chạy procedure cũ — khi đó coi như tháng lịch.
   */
  fromDateTime?: string;
  toDateTime?: string;
}

/**
 * KỲ TÍNH CHI PHÍ của một tháng trong bảng 12 tháng (SA_CostMonthPeriod).
 *
 * Nửa mở: `fromDateTime` thuộc kỳ, `toDateTime` thì không — hai tháng nối
 * tiếp dùng chung một mốc. Tháng chưa cài đặt mang kỳ mặc định (25 tháng
 * trước 22:50 -> 25 tháng này 22:50) và `isCustom = false`.
 */
export interface CostMonthPeriod {
  monthNo: number;
  /** "YYYY-MM". */
  costMonth: string;
  /** "YYYY-MM-DD HH:mm:ss", thuộc kỳ. */
  fromDateTime: string;
  /** "YYYY-MM-DD HH:mm:ss", KHÔNG thuộc kỳ. */
  toDateTime: string;
  isCustom: boolean;
}

/** Tham số hệ thống đã ép kiểu (SA_SystemSetting). */
export interface SystemSettings {
  ABNORMAL_MIN_PUNCH?: number;
  [key: string]: string | number | undefined;
}

export interface MealLog {
  id: string;
  userId: string;
  userName: string;
  department: string; // original small department from timecard
  largeDepartment?: string; // mapped large department
  logDateTime: string; // "YYYY-MM-DD HH:mm:ss"
  logTimeOnly: string; // "HH:mm:ss"
  actualDate: string; // "YYYY-MM-DD" adjusted for night shift (00:00-01:50 is previous day)
  shiftCode: ShiftCode;
  readerId: number;
  readerName: string;
  isKorean: boolean; // true if from Machine 3
  /**
   * Suất mất mát đã bị xóa ở popup "Điều Chỉnh Số Liệu". Chỉ tab Suất Ăn Mất
   * Mát còn thấy lượt này (hiển thị y nguyên như chưa xóa); App.tsx bỏ nó
   * khỏi mọi màn hình khác và Báo Cáo Chi Phí không tính tiền nó.
   */
  lossDeleted?: boolean;
}

export interface PivotEmployeeDayLog {
  /** NGÀY LÀM VIỆC (22:50 hôm trước -> 22:50), không phải ngày lịch. */
  actualDate: string;
  department: string;
  largeDepartment: string;
  userId: string;
  userName: string;
  gioQuet_CA1?: string;
  gioQuet_CA2?: string;
  gioQuet_CA3?: string;
  gioQuet_CA4?: string;
  gioQuet_CA5?: string;
  gioQuet_CA6?: string;
  gioQuet_Khac?: string;
  totalPunches: number;
  punchesList: { shift: ShiftCode; time: string; reader: string }[];
}

export interface ManualMealEntry {
  id: string;
  date: string;
  shiftCode: ShiftCode;
  /**
   * Nhóm nhân sự của suất nhập tay — quyết định suất này ăn giá Hàn hay giá
   * Việt. Lượt quẹt thật suy ra nhóm từ bộ phận lớn, còn suất nhập tay không
   * gắn với ai nên người nhập phải tự chọn.
   */
  staffType: StaffType;
  department: string;
  quantity: number;
  reason: string;
  enteredBy: string;
  createdAt: string;
}

/**
 * Ca cấp phát. Nhà ăn phát sữa (và các hạng mục phát sinh khác như kem, quà
 * ngày lễ) hai lượt trong ngày, bảng kê gửi nhà ăn tách riêng hai lượt đó,
 * nên mỗi dòng cấp phát phải biết mình thuộc lượt nào.
 *
 * Đây KHÔNG phải `ShiftCode`: sáu ca chấm thẻ là khung giờ của máy đọc thẻ,
 * còn đây chỉ là hai lượt phát trong ngày.
 */
export type SupplyShiftCode = "NGAY" | "DEM";

export interface DailyMilkEntry {
  id: string;
  date: string;
  /** "NGAY" = Ca ngày, "DEM" = Ca đêm. */
  milkShift: SupplyShiftCode;
  milkType: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  supplier: string;
  notes?: string;
}

/**
 * Một dòng CHI PHÍ PHÁT SINH — kem, quà một ngày lễ tuỳ biến, hay bất cứ
 * hạng mục nào nhà ăn xuất hoá đơn ngoài suất ăn và sữa.
 *
 * Cấu trúc cố tình giống hệt `DailyMilkEntry`: cùng cách nhập, cùng cách hiện
 * trên bảng kê, chỉ khác tên hạng mục là chữ tự do thay vì tên loại sữa. Nhờ
 * vậy hai domain dùng chung một bộ giao diện và một bộ hàm dựng bảng.
 */
export interface ExtraCostEntry {
  id: string;
  date: string;
  /** "NGAY" = Ca ngày, "DEM" = Ca đêm. */
  costShift: SupplyShiftCode;
  /** Tên hạng mục, vd "Kem Merino", "Quà Tết Trung Thu". */
  costType: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  supplier: string;
  notes?: string;
}

/* -------------------------------------------------------------------------
   Chi phí thuê nhân công
   -------------------------------------------------------------------------
   Nhà ăn thuê nhân công theo ĐỢT: một người, một khoảng ngày, một số tiền cho
   trọn khoảng đó. Bảng kê chi phí lọc một quãng bất kỳ nên tiền phải chia
   theo ngày làm việc rồi nhân lại với phần giao — xem `buildLaborSegments`
   trong src/components/financial/reportModel.ts.

   KHOẢNG NGÀY LÀ NỬA MỞ: `effectiveFrom` được tính, `effectiveTo` KHÔNG. Nhờ
   vậy hai đợt nối tiếp viết đúng như trên giấy (25/07→25/08 rồi 25/08→25/09)
   mà ngày 25/08 chỉ thuộc đúng một đợt — không tính hai lần, không rơi mất.
   ------------------------------------------------------------------------- */

/** Cách đếm "ngày làm việc" — mẫu số của phép chia tiền theo đợt. */
export type LaborWorkDayRule = "ALL" | "MON_SAT" | "MON_FRI";

/** Một đợt thuê nhân công trong BẢN NHÁP (SA_LaborCost). */
export interface LaborCostDraftRow {
  id: number;
  workerName: string;
  /** 'YYYY-MM-DD', ngày này ĐƯỢC tính. */
  effectiveFrom: string;
  /** 'YYYY-MM-DD', ngày này KHÔNG được tính. */
  effectiveTo: string;
  /** Tiền cho trọn đợt, VNĐ. */
  amount: number;
  notes: string | null;
  /**
   * 'YYYY-MM' người dùng gán ở ô "Tháng" — CHỈ LÀ NHÃN. Tiền chia theo ngày
   * làm việc của khoảng ngày, bảng 12 tháng cắt theo kỳ của nó; không phép
   * tính nào đọc trường này.
   */
  costMonth: string | null;
  updatedAt: string;
}

/** Một dòng trong bản chụp của một lượt "Áp dụng" (SA_LaborCostApplied). */
export interface LaborCostAppliedRow {
  id: number;
  batchId: string;
  workerName: string;
  effectiveFrom: string;
  effectiveTo: string;
  amount: number;
  notes: string | null;
  /** Nhãn tháng của đợt — xem `LaborCostDraftRow.costMonth`. */
  costMonth: string | null;
}

/**
 * MỘT LƯỢT "Áp dụng" (SA_LaborCostBatch).
 *
 * Chỉ lượt MỚI NHẤT đi vào tiền của báo cáo; các lượt cũ ở lại nguyên vẹn để
 * truy vết. Quy tắc ngày làm việc được đóng băng ở đây nên đổi quy tắc cho
 * đợt sắp tới không làm số tiền của kỳ đã chốt tự nhảy.
 */
export interface LaborCostBatch {
  batchId: string;
  /** "YYYY-MM-DD HH:mm:ss". */
  appliedAt: string;
  appliedBy: string | null;
  workDayRule: LaborWorkDayRule;
  notes: string | null;
  rowCountNum: number;
  totalAmount: number;
}

/** Toàn bộ trạng thái chi phí nhân công đọc trong một lượt gọi API. */
export interface LaborCostState {
  /** Đang gõ dở — KHÔNG báo cáo nào đọc. */
  draft: LaborCostDraftRow[];
  /** Lượt áp dụng đang có hiệu lực; null = chưa từng bấm "Áp dụng". */
  effective: LaborCostBatch | null;
  /** Các dòng của lượt đang có hiệu lực — nguồn tiền nhân công của báo cáo. */
  appliedRows: LaborCostAppliedRow[];
  /** Lịch sử mọi lượt áp dụng, mới nhất trước. */
  batches: LaborCostBatch[];
}

export interface BirthdayConfig {
  id: string;
  date: string; // "YYYY-MM-DD"
  description: string;
  specialMealPrice: number;
}

export interface MealPriceItem {
  id: string;
  code: string;
  name: string;
  unitPrice: number;
  unit: string;
  notes?: string;
}

export interface AbnormalPunch {
  actualDate: string;
  userId: string;
  userName: string;
  department: string;
  totalPunches: number;
  logs: MealLog[];
}
