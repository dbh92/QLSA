import {
  ShiftCode,
  StaffType,
  MealCategory,
  ShiftMealCategory,
  ShiftInfo,
  MealLog,
  PivotEmployeeDayLog,
  DepartmentMapping,
  AbnormalPunch,
  DailyMilkEntry,
  SupplyShiftCode,
  BirthdayConfig,
  MealPriceItem,
  ManualMealEntry,
} from "../types";

export type { MealCategory };

/**
 * Determines shift code from time string (HH:mm:ss)
 */
export function determineShift(timeOnly: string): ShiftCode {
  if (timeOnly >= "22:50:00" || timeOnly <= "01:50:00") {
    return "CA1";
  }
  if (timeOnly >= "04:30:00" && timeOnly <= "06:44:00") {
    return "CA2";
  }
  if (timeOnly >= "06:45:00" && timeOnly <= "08:10:00") {
    return "CA3";
  }
  if (timeOnly >= "10:40:00" && timeOnly <= "13:30:00") {
    return "CA4";
  }
  if (timeOnly >= "16:30:00" && timeOnly <= "18:44:00") {
    return "CA5";
  }
  if (timeOnly >= "18:45:00" && timeOnly <= "20:10:00") {
    return "CA6";
  }
  return "Khác";
}

/** Cộng/trừ số ngày cho chuỗi "YYYY-MM-DD", trả lại đúng dạng chuỗi đó. */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Ngày của một lượt quẹt = ĐÚNG ngày lịch của thời điểm quẹt.
 *
 * Không có chuyện lùi ngày: quẹt lúc '2026-08-11 00:48:37' thuộc ngày
 * 2026-08-11. Ca ăn vẫn phân theo khung giờ (CA1 vắt qua nửa đêm), nhưng việc
 * đó chỉ quyết định TÊN CA, không ảnh hưởng tới ngày.
 *
 * Đây là bản đặc tả song song với `SA_MealLog_GetByRange` — sửa một nơi thì
 * phải sửa cả nơi kia.
 */
export function getActualWorkDate(fullDateTimeStr: string): string {
  return fullDateTimeStr.slice(0, 10);
}

/**
 * Tên ca dùng trên các bảng kê gửi nhà ăn.
 *
 * Đây là tên CỐ ĐỊNH của bảng kê, không lấy từ SA_Shift.ShiftReName — bảng kê
 * phải gọi ca đêm là "23H" ở mọi khối (Hàn lẫn Việt) thì mới đối chiếu được
 * giữa các sheet. Tên do người dùng đặt trong SA_Shift.ShiftReName vẫn hiện ở
 * Dashboard qua `shiftAlias`.
 */
export const REPORT_SHIFT_LABEL: Record<string, string> = {
  CA1: "23H",
  CA2: "5H",
  CA3: "7H",
  CA4: "12H",
  CA5: "17H",
  CA6: "19H",
};

export const reportShiftLabel = (code: ShiftCode): string =>
  REPORT_SHIFT_LABEL[code] ?? code;

/* -------------------------------------------------------------------------
   Ca cấp phát
   -------------------------------------------------------------------------
   Hàng cấp phát (sữa, và các hạng mục phát sinh như kem hay quà ngày lễ)
   không đi theo 6 ca chấm thẻ: nhà ăn phát đúng hai lượt một ngày (ca ngày
   và ca đêm) và bảng kê gửi nhà ăn tách riêng hai lượt đó ngay trong cột của
   ngày cấp. Vì vậy đây là một danh mục riêng, KHÔNG phải tập con của
   ShiftCode. */

/** Thứ tự cột của hai ca cấp phát trên mọi bảng kê. */
export const SUPPLY_SHIFT_ORDER: SupplyShiftCode[] = ["NGAY", "DEM"];

export const SUPPLY_SHIFT_LABEL: Record<SupplyShiftCode, string> = {
  NGAY: "Ca ngày",
  DEM: "Ca đêm",
};

/**
 * Ép một giá trị bất kỳ (ô Excel, dữ liệu cũ chưa có cột ca) về mã ca cấp
 * phát. Dòng nhập trước khi có cột này không mang ca nào — mặc định về ca
 * ngày để số liệu cũ không biến mất khỏi bảng kê.
 */
export function parseSupplyShift(value: unknown): SupplyShiftCode {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!s) return "NGAY";
  if (s === "dem" || s.includes("đêm") || s.includes("dem") || s === "night") {
    return "DEM";
  }
  return "NGAY";
}

/** Tên ca do người dùng đặt trong SA_Shift.ShiftReName. */
export function shiftAlias(shifts: ShiftInfo[], code: ShiftCode): string {
  const found = shifts.find((s) => s.code === code);
  return found?.ShiftReName || reportShiftLabel(code);
}

/** "22:50 - 01:50" — khung giờ của một ca, để chú thích tiêu đề bảng. */
export function shiftWindow(shifts: ShiftInfo[], code: ShiftCode): string {
  const found = shifts.find((s) => s.code === code);
  return found
    ? `${found.startTime.slice(0, 5)} - ${found.endTime.slice(0, 5)}`
    : "";
}

/**
 * Giờ bắt đầu mặc định của từng ca khi chưa nạp được SA_Shift — khớp với
 * 02_seed.sql. 'Khác' không có khung giờ nên lấy đầu ngày.
 */
const SHIFT_START_FALLBACK: Record<ShiftCode, string> = {
  CA1: "22:50:00",
  CA2: "04:30:00",
  CA3: "06:45:00",
  CA4: "10:40:00",
  CA5: "16:30:00",
  CA6: "18:45:00",
  "Khác": "00:00:00",
};

/**
 * Giờ bắt đầu của một ca, "HH:mm:ss".
 *
 * Dùng để gắn một MỐC THỜI GIAN cho dòng nhập thủ công: nguồn chỉ có ngày và
 * mã ca, nhưng khoảng lọc của ứng dụng chính xác tới giây, nên phải quy về
 * cùng một trục thời gian với lượt quẹt thì mới lọc được. Xem
 * `classifyManualEntries`.
 */
export function shiftStartTime(
  shifts: ShiftInfo[] | undefined,
  code: ShiftCode,
): string {
  return (
    shifts?.find((s) => s.code === code)?.startTime ??
    SHIFT_START_FALLBACK[code] ??
    "00:00:00"
  );
}

/* ---------------------------------------------------------------------------
   NGÀY CỦA CA (mealDate) — khác với actualDate
   ---------------------------------------------------------------------------
   `actualDate` là ngày lịch của lượt quẹt và vẫn là khoá gom nhóm của mọi báo
   cáo theo ngày. Nhưng CA1 chạy 22:50 -> 01:50 nên nó nằm vắt trên HAI ngày
   lịch, trong khi về nghiệp vụ nó là MỘT ca của ngày bắt đầu.

   `mealDate` trả lời câu hỏi "lượt quẹt này thuộc ca của ngày nào": nửa sau
   của ca đêm (00:00 -> 01:50) thuộc về ngày hôm trước. Dùng nó để tra cấu
   hình sinh nhật và để xếp cột ngày trong các bảng kê chi phí.

   Ví dụ sinh nhật ngày 14:
     - 14 lúc 23:10 -> mealDate 14 -> suất sinh nhật.
     - 15 lúc 01:20 -> mealDate 14 -> suất sinh nhật (trước đây bị tính giá
       thường vì actualDate là 15).
     - 14 lúc 00:30 -> mealDate 13 -> KHÔNG phải suất sinh nhật.

   Đây là bản đặc tả song song với CROSS APPLY `md` trong
   SA_MealCost_GetMonthly — sửa một nơi thì phải sửa cả nơi kia.
   --------------------------------------------------------------------------- */

/** Ca vắt qua nửa đêm khi chưa nạp được SA_Shift — khớp với 02_seed.sql. */
const WRAP_SHIFT_FALLBACK = {
  code: "CA1" as ShiftCode,
  startTime: "22:50:00",
  endTime: "01:50:00",
};

type DatedLog = Pick<MealLog, "shiftCode" | "actualDate" | "logTimeOnly">;

/** Ca của một lượt quẹt bắt đầu vào ngày nào — xem chú thích khối ở trên. */
export function getMealShiftDate(log: DatedLog, shifts?: ShiftInfo[]): string {
  const wrap = shifts?.find((s) => s.wrapsMidnight) ?? WRAP_SHIFT_FALLBACK;
  if (log.shiftCode === wrap.code && log.logTimeOnly <= wrap.endTime) {
    return addDays(log.actualDate, -1);
  }
  return log.actualDate;
}

/* ---------------------------------------------------------------------------
   NGÀY CỦA BẢNG KÊ CHI PHÍ (reportDate) — CHỈ dùng trong tab Báo Cáo Chi Phí
   ---------------------------------------------------------------------------
   Nhà ăn chốt ca đêm theo giờ KẾT THÚC: ca 23H chạy 22:50 -> 01:50 và cả ca đó
   được tính cho NGÀY HÔM SAU (ngày của mốc 01:50). Vậy nửa TRƯỚC nửa đêm
   (22:50 -> 23:59) phải nhảy sang cột ngày kế tiếp, còn nửa SAU nửa đêm
   (00:00 -> 01:50) vốn đã mang đúng ngày rồi nên giữ nguyên.

   Ví dụ lọc từ 18 lúc 22:50 đến 19 lúc 12:00:
     - 18 lúc 23:10 (CA1) -> cột ngày 19.
     - 19 lúc 01:20 (CA1) -> cột ngày 19.
     - 19 lúc 11:00 (CA4) -> cột ngày 19.
     -> Không có số liệu nào rơi vào cột ngày 18.
   Nếu khoảng lọc kéo tới hết ngày 19 thì lượt quẹt CA1 từ 19 lúc 22:50 trở đi
   sinh thêm cột ngày 20.

   KHÁC HẲN `getMealShiftDate` ở trên: hàm kia quy ca đêm về ngày BẮT ĐẦU và
   vẫn là khoá đối chiếu Cấu Hình Sinh Nhật — đổi hàm này KHÔNG được làm đổi
   giá suất sinh nhật.

   Ngoài cột ngày của các bảng kê trong src/components/financial/, đây còn là
   NGÀY LÀM VIỆC mà `evaluatePunchDays` gom nhóm để bắt chấm thẻ sai. Cùng một
   câu hỏi "lượt quẹt này thuộc ngày làm việc nào" thì phải dùng chung một
   hàm: quẹt 00:05 và quẹt 23:45 trong cùng một ngày lịch là hai ca đêm của
   HAI ngày làm việc khác nhau, không phải quẹt trùng ca.
   --------------------------------------------------------------------------- */

/** Ngày mà một lượt quẹt được tính vào trên bảng kê chi phí — xem khối trên. */
export function getCostReportDate(log: DatedLog, shifts?: ShiftInfo[]): string {
  const wrap = shifts?.find((s) => s.wrapsMidnight) ?? WRAP_SHIFT_FALLBACK;
  if (log.shiftCode === wrap.code && log.logTimeOnly >= wrap.startTime) {
    return addDays(log.actualDate, 1);
  }
  return log.actualDate;
}

/* ---------------------------------------------------------------------------
   KHUNG GIỜ CỦA HÀNG CẤP PHÁT (sữa, chi phí phát sinh)
   ---------------------------------------------------------------------------
   Dòng cấp phát chỉ có NGÀY và CA CẤP PHÁT, nhưng khoảng lọc của tab Báo Cáo
   Chi Phí chính xác tới giây, nên mỗi dòng được quy về một khung giờ nửa mở
   [from, to) trên cùng trục thời gian với lượt quẹt. Với dòng của ngày D:

     - Ca đêm : (D-1) 22:50 -> D 08:00
     - Ca ngày:  D    08:00 -> D 22:50

   22:50 là giờ bắt đầu của ca vắt nửa đêm (CA1) — cũng là mốc mà
   `getCostReportDate` chuyển lượt quẹt sang ngày hôm sau — nên ngày D của
   hàng cấp phát trùng đúng với cột ngày D của bảng kê: lọc từ 25 lúc 23:00
   thì sữa ca ngày / ca đêm của ngày 25 KHÔNG còn được tính, còn sữa ca đêm
   của ngày 26 thì có.

   Một dòng được tính khi khung giờ của nó GIAO với khoảng lọc một đoạn có độ
   dài (from < endDateTime và to > startDateTime): chạm đúng biên — lọc từ
   25 lúc 22:50:00, hoặc tới 25 lúc 22:50:00 — không kéo thêm ca bên kia biên.
   Chỉ tab Báo Cáo Chi Phí dùng quy tắc này; các màn hình khác vẫn lọc sữa
   theo ngày.
   --------------------------------------------------------------------------- */

/** Giờ chuyển từ ca đêm sang ca ngày của hàng cấp phát. */
export const SUPPLY_DAY_START = "08:00:00";

/** Khung giờ nửa mở [from, to) của một dòng cấp phát — xem khối trên. */
export function supplyShiftWindow(
  date: string,
  shift: SupplyShiftCode,
  shifts?: ShiftInfo[],
): { from: string; to: string } {
  const d = date.slice(0, 10);
  const nightStart = (
    shifts?.find((s) => s.wrapsMidnight) ?? WRAP_SHIFT_FALLBACK
  ).startTime;
  return shift === "DEM"
    ? { from: `${addDays(d, -1)} ${nightStart}`, to: `${d} ${SUPPLY_DAY_START}` }
    : { from: `${d} ${SUPPLY_DAY_START}`, to: `${d} ${nightStart}` };
}

/** Dòng cấp phát có rơi vào khoảng lọc (chính xác tới giây) hay không. */
export function supplyInRange(
  date: string,
  shift: SupplyShiftCode,
  startDateTime: string,
  endDateTime: string,
  shifts?: ShiftInfo[],
): boolean {
  const w = supplyShiftWindow(date, shift, shifts);
  return w.from < endDateTime && w.to > startDateTime;
}

/**
 * Các NGÀY LÀM VIỆC mà khoảng lọc (chính xác tới giây) chạm tới, hai đầu đều
 * tính — dùng cho chi phí nhân công, vốn chỉ đếm theo ngày.
 *
 * Ngày làm việc D chạy (D-1) 22:50 -> D 22:50, cùng mốc với `reportDate` của
 * lượt quẹt và với hàng cấp phát. Ngày D được tính khi nó giao với khoảng lọc
 * một đoạn có độ dài, nên lọc từ 25 lúc 22:50 tới 29 lúc 22:50 ra đúng các
 * ngày 26, 27, 28, 29. Khoảng lọc không chạm ngày nào thì `from > to`.
 */
export function costWorkDayRange(
  startDateTime: string,
  endDateTime: string,
  shifts?: ShiftInfo[],
): { from: string; to: string } {
  const boundary = (
    shifts?.find((s) => s.wrapsMidnight) ?? WRAP_SHIFT_FALLBACK
  ).startTime;
  const startDate = startDateTime.slice(0, 10);
  const endDate = endDateTime.slice(0, 10);
  return {
    from:
      startDateTime.slice(11, 19) >= boundary
        ? addDays(startDate, 1)
        : startDate,
    to: endDateTime.slice(11, 19) > boundary ? addDays(endDate, 1) : endDate,
  };
}

/* ---------------------------------------------------------------------------
   NGÀY LÀM VIỆC — quy ước lọc thời gian của MỌI menu
   ---------------------------------------------------------------------------
   Một ngày làm việc D chạy từ (D-1) 22:50 tới D 22:50 — 22:50 là giờ bắt đầu
   của ca vắt nửa đêm (CA1). Các nút "Hôm nay / Tháng này / Tháng trước" của
   bộ lọc và khoảng mặc định lúc mở ứng dụng đều phủ trọn ngày làm việc theo
   quy ước này, và `startDate`/`endDate` mà App truyền xuống các màn hình chỉ
   có ngày (sữa, nhân công, ...) là khoảng NGÀY LÀM VIỆC (`costWorkDayRange`),
   không phải phần ngày lịch của bộ lọc.
   --------------------------------------------------------------------------- */

/** Thời điểm hiện tại theo giờ máy, "YYYY-MM-DD HH:mm:ss" (không qua UTC). */
export function nowLocalDateTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Giờ bắt đầu ngày làm việc — giờ bắt đầu của ca vắt qua nửa đêm. */
export function workDayStartTime(shifts?: ShiftInfo[]): string {
  return (shifts?.find((s) => s.wrapsMidnight) ?? WRAP_SHIFT_FALLBACK)
    .startTime;
}

/** Ngày làm việc chứa thời điểm "YYYY-MM-DD HH:mm:ss". */
export function workDayOf(dateTime: string, shifts?: ShiftInfo[]): string {
  const d = dateTime.slice(0, 10);
  return dateTime.slice(11, 19) >= workDayStartTime(shifts)
    ? addDays(d, 1)
    : d;
}

/**
 * Khoảng lọc (chính xác tới giây, hai đầu đều tính) phủ trọn các ngày làm
 * việc `fromDay` .. `toDay`: (fromDay-1) 22:50:00 -> toDay 22:49:59. Biên
 * cuối lùi một giây để hai khoảng nối tiếp — "Tháng trước" rồi "Tháng này" —
 * không đếm một lượt quẹt đúng 22:50:00 hai lần.
 */
export function workDayFilterRange(
  fromDay: string,
  toDay: string,
  shifts?: ShiftInfo[],
): { startDateTime: string; endDateTime: string } {
  const start = workDayStartTime(shifts);
  const [h, m, s] = start.split(":").map(Number);
  const secs = h * 3600 + m * 60 + (s || 0) - 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const endTime = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
  return {
    startDateTime: `${addDays(fromDay, -1)} ${start}`,
    endDateTime: `${toDay} ${endTime}`,
  };
}

/**
 * Các ca được ăn suất sinh nhật. Đây là hai bữa chính trong ngày, không phải
 * mọi ca: ngày sinh nhật tập thể chỉ đổi bữa chính thành suất đặc biệt, bữa
 * phụ vẫn tính giá thường.
 *
 * Cấu hình trong SA_SystemSetting.BIRTHDAY_SHIFTS dạng "CA1,CA4"; thiếu tham
 * số thì rơi về mặc định dưới đây.
 */
export const DEFAULT_BIRTHDAY_SHIFTS: ShiftCode[] = ['CA1', 'CA4'];

/** Đọc BIRTHDAY_SHIFTS ("CA1,CA4") thành tập mã ca. */
export function parseBirthdayShifts(value?: string | number): Set<ShiftCode> {
  const raw = typeof value === 'string' ? value : '';
  const codes = raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean) as ShiftCode[];
  return new Set(codes.length > 0 ? codes : DEFAULT_BIRTHDAY_SHIFTS);
}

/**
 * Tập ngày sinh nhật. Nhận cả `Set<string>` lẫn `Map<string, number>` (ngày ->
 * đơn giá suất sinh nhật) để nơi nào cần đơn giá thì truyền thẳng bảng tra
 * chứ không phải dựng thêm một `Set` song song rồi để hai cái lệch nhau.
 */
export type BirthdayDateLookup = { has(date: string): boolean };

/**
 * Đơn giá suất sinh nhật theo NGÀY, lấy từ tab "Cấu Hình Sinh Nhật"
 * (SA_BirthdayConfig.SpecialMealPrice).
 *
 * Đây là nguồn DUY NHẤT của đơn giá suất sinh nhật: mỗi ngày sinh nhật mang
 * giá riêng của nó, nên không có một con số chung nào trong SA_MealPrice đại
 * diện được cho cả kỳ. Ngày nào cấu hình để trống / bằng 0 thì bỏ qua để nơi
 * gọi rơi về giá dự phòng thay vì tính suất sinh nhật thành 0 đồng.
 */
export function buildBirthdayPriceMap(
  configs: BirthdayConfig[],
): Map<string, number> {
  const map = new Map<string, number>();
  configs.forEach((c) => {
    const price = Number(c.specialMealPrice) || 0;
    if (price > 0) map.set(c.date, price);
    else if (!map.has(c.date)) map.set(c.date, 0);
  });
  return map;
}

/**
 * Lượt quẹt này có phải suất sinh nhật không: NGÀY CỦA CA nằm trong cấu hình
 * sinh nhật VÀ ca của nó là một ca ăn sinh nhật.
 *
 * Không truyền `birthdayShifts` thì dùng mặc định CA1 + CA4.
 */
export function isBirthdayMealLog(
  log: DatedLog,
  birthdayDates: BirthdayDateLookup,
  shifts?: ShiftInfo[],
  birthdayShifts?: Set<ShiftCode>
): boolean {
  const eligible = birthdayShifts ?? new Set(DEFAULT_BIRTHDAY_SHIFTS);
  return (
    eligible.has(log.shiftCode) && birthdayDates.has(getMealShiftDate(log, shifts))
  );
}

/* ---------------------------------------------------------------------------
   Phân loại suất ăn & đơn giá
   ---------------------------------------------------------------------------
   Quy tắc nghiệp vụ:
     - Người Hàn : CA3 (06:45) + CA4 (10:40) -> cơm Hàn. Các ca còn lại -> mỳ Hàn.
     - Người Việt: CA1 (22:50) + CA4 (10:40) -> bữa chính. Các ca còn lại -> bữa phụ.
     - Ngày có trong Cấu Hình Sinh Nhật thì suất của người Việt tính giá suất
       đặc biệt, đè lên giá theo ca.
   Dùng chung cho Dashboard và tab Hàn Quốc vs Việt Nam nên hai màn hình luôn
   ra cùng một con số.
   --------------------------------------------------------------------------- */

/** Mã tra trong SA_MealPrice + giá dự phòng khi thiếu mã + nhãn hiển thị. */
export const MEAL_CATEGORY_META: Record<
  MealCategory,
  { code: string; fallback: number; label: string }
> = {
  KO_COM: { code: 'COM_HAN', fallback: 65000, label: 'Cơm Hàn' },
  KO_MY: { code: 'MY_HAN', fallback: 30000, label: 'Mỳ Hàn' },
  VN_CHINH: { code: 'COM_VIET', fallback: 28000, label: 'Bữa chính VN' },
  VN_PHU: { code: 'COM_VIET_PHU', fallback: 20000, label: 'Bữa phụ VN' },
  VN_SINHNHAT: { code: 'SUAT_DAC_BIET', fallback: 50000, label: 'Suất sinh nhật' },
};

export type MealPricing = Record<MealCategory, number>;

/**
 * Đơn giá của một mã trong SA_MealPrice. Thiếu mã thì trả `fallback` — mọi
 * đường tính tiền phải đi qua đây để một mã bị xoá làm sai số chứ không làm
 * ra NaN.
 */
export function getUnitPrice(
  priceItems: MealPriceItem[],
  code: string,
  fallback: number
): number {
  const found = priceItems.find((p) => p.code === code);
  return found ? found.unitPrice : fallback;
}

/** Dựng bảng đơn giá từ SA_MealPrice; thiếu mã nào thì rơi về giá dự phòng. */
export function buildMealPricing(priceItems: MealPriceItem[]): MealPricing {
  return Object.entries(MEAL_CATEGORY_META).reduce((acc, [key, meta]) => {
    acc[key as MealCategory] = getUnitPrice(priceItems, meta.code, meta.fallback);
    return acc;
  }, {} as MealPricing);
}

/**
 * Nhóm nhân sự của một lượt quẹt — quyết định cột giá Hàn hay Việt.
 *
 * CHỈ bộ phận lớn KR mới tính giá suất Hàn, và tính ở MỌI máy chấm. Máy
 * TA-102 (CT Korea) KHÔNG quyết định gì về giá: khách hoặc người bộ phận khác
 * (SP…) quẹt nhầm máy đó vẫn phải tính theo suất người Việt.
 *
 * `MealLog.isKorean` (máy chấm là máy Hàn) chỉ còn dùng để hiển thị, đừng đưa
 * vào đường tính tiền.
 */
export function isKoreanStaffLog(
  log: MealLog,
  mappings: DepartmentMapping[]
): boolean {
  return getLogLargeDepartment(log, mappings) === 'KR';
}

/**
 * Bảng tra "ca này + nhóm nhân sự này -> loại suất nào", dựng từ
 * SA_ShiftMealCategory. Khoá là `${shiftCode}|${staffType}`.
 */
export type ShiftCategoryLookup = Map<string, MealCategory>;

const shiftCategoryKey = (shiftCode: ShiftCode, staffType: StaffType) =>
  `${shiftCode}|${staffType}`;

export function buildShiftCategoryLookup(
  rows: ShiftMealCategory[]
): ShiftCategoryLookup {
  const lookup: ShiftCategoryLookup = new Map();
  rows.forEach((r) =>
    lookup.set(shiftCategoryKey(r.shiftCode, r.staffType), r.mealCategory)
  );
  return lookup;
}

/**
 * Xếp một lượt quẹt vào đúng loại suất ăn.
 *
 * Loại suất của mỗi (ca, nhóm nhân sự) do người dùng gán trong tab "Cấu Hình
 * Giá Suất Ăn" (bảng SA_ShiftMealCategory). Thiếu bảng gán — hoặc thiếu đúng ô
 * đang cần — thì rơi về quy tắc gốc: người Hàn CA3+CA4 cơm Hàn / còn lại mỳ
 * Hàn, người Việt CA1+CA4 bữa chính / còn lại bữa phụ.
 *
 * Ngày sinh nhật đè lên loại suất của NGƯỜI VIỆT. `isBirthday` phải do
 * `isBirthdayMealLog` tính, vì nó đã xét cả hai điều kiện: NGÀY CỦA CA nằm
 * trong SA_BirthdayConfig, VÀ ca đó nằm trong danh sách ca ăn sinh nhật
 * (SA_SystemSetting: BIRTHDAY_SHIFTS, mặc định CA1 + CA4). Người Hàn không bị
 * đè.
 *
 * Đây là bản đặc tả song song với SA_MealCost_GetMonthly — sửa một nơi thì
 * phải sửa cả nơi kia.
 */
export function classifyMeal(
  shiftCode: ShiftCode,
  isKoreanStaff: boolean,
  isBirthday: boolean,
  lookup?: ShiftCategoryLookup
): MealCategory {
  if (isKoreanStaff) {
    return (
      lookup?.get(shiftCategoryKey(shiftCode, 'KR')) ??
      (shiftCode === 'CA3' || shiftCode === 'CA4' ? 'KO_COM' : 'KO_MY')
    );
  }
  if (isBirthday) return 'VN_SINHNHAT';
  return (
    lookup?.get(shiftCategoryKey(shiftCode, 'VN')) ??
    (shiftCode === 'CA1' || shiftCode === 'CA4' ? 'VN_CHINH' : 'VN_PHU')
  );
}

/**
 * Maps small department to large department using mappings table
 */
export function getLargeDepartment(
  smallDept: string,
  mappings: DepartmentMapping[],
): string {
  const found = mappings.find(
    (m) =>
      m.smallDepartment.trim().toLowerCase() === smallDept.trim().toLowerCase(),
  );
  return found ? found.largeDepartment : "Khác";
}

/**
 * Bộ phận lớn CỦA MỘT LƯỢT QUẸT — dùng cái này ở mọi màn hình, đừng gọi thẳng
 * getLargeDepartment(log.department, mappings).
 *
 * `SA_MealLog_GetByRange` đã giải sẵn thứ tự ưu tiên
 *   rule có điều kiện (SA_DepartmentMappingRule) > ánh xạ mặc định > 'Khác'
 * và trả về ở trường `largeDepartment`. Bảng ánh xạ phía client KHÔNG biết tới
 * rule, nên tra lại theo tên bộ phận sẽ xếp nhầm: 'Khach cong tac' có tên chứa
 * 'Business' (vd "BUSINESS 36") phải thuộc KR nhưng lại rơi vào SP.
 *
 * Chỉ tự tra bảng ánh xạ khi procedure chưa trả về trường này (dữ liệu cũ).
 */
export function getLogLargeDepartment(
  log: MealLog,
  mappings: DepartmentMapping[],
): string {
  const resolved = log.largeDepartment?.trim();
  return resolved ? resolved : getLargeDepartment(log.department, mappings);
}

/* -------------------------------------------------------------------------
   Suất ăn nhập tay
   -------------------------------------------------------------------------
   Suất nhập tay (tab Nhập Thủ Công Ca) là suất ăn THẬT: máy quẹt hỏng, mất
   điện, ăn đột xuất không quẹt thẻ. Nhà ăn vẫn nấu và vẫn xuất hoá đơn, nên
   mọi bảng đếm suất và mọi bảng tính tiền đều phải cộng chúng vào.

   Chúng khác lượt quẹt ở chỗ KHÔNG gắn với một nhân sự cụ thể và không có
   giờ quẹt. Vì vậy chúng vào được mọi tổng theo (ngày × ca × nhóm × bộ phận
   lớn × loại suất), nhưng KHÔNG vào được các bảng cấp nhân viên: bảng chi
   tiết nhân viên × ngày, lịch sử chấm ăn, và thống kê chấm thẻ sai.

   Đây là lượt phân loại dùng chung cho toàn bộ ứng dụng, song song với
   `classifyLogs` của các lượt quẹt — mỗi màn hình tự gom lại chứ không tự
   giải lại quy tắc. */

/**
 * Mốc thời gian quy ước của một dòng nhập tay: giờ bắt đầu ca trong NGÀY
 * LÀM VIỆC người dùng đã nhập. Ngày làm việc D chạy (D-1) 22:50 -> D 22:50,
 * nên ca vắt qua nửa đêm (CA1) bắt đầu từ tối HÔM TRƯỚC:
 *   - CA1 ngày 26 -> "25 22:50:00"
 *   - CA2 ngày 26 -> "26 04:30:00"
 * Đây là quy ước của cả ứng dụng: lọc từ 25 lúc 22:50 thì suất nhập tay đầu
 * tiên được tính là CA1 ngày 26, đúng như lượt quẹt đầu tiên được tính là
 * lượt quẹt CA1 lúc 25 22:5x.
 */
export function manualEntryDateTime(
  date: string,
  shiftCode: ShiftCode,
  shifts?: ShiftInfo[],
): string {
  const wrap = shifts?.find((s) => s.wrapsMidnight) ?? WRAP_SHIFT_FALLBACK;
  const startTime = shiftStartTime(shifts, shiftCode);
  const d = date.slice(0, 10);
  return shiftCode === wrap.code
    ? `${addDays(d, -1)} ${startTime}`
    : `${d} ${startTime}`;
}

/**
 * Dòng nhập tay có thuộc khoảng lọc không. Nửa mở [start, end): một suất
 * nhập tay đại diện cho CẢ ca, nên lọc tới đúng 25 lúc 22:50:00 không kéo
 * theo CA1 ngày 26 (ca bắt đầu đúng mốc đó), còn lọc TỪ 25 lúc 22:50:00 thì
 * có — hai khoảng lọc nối tiếp nhau không bao giờ đếm một dòng hai lần.
 */
export function manualInRange(
  dateTime: string,
  startDateTime: string,
  endDateTime: string,
): boolean {
  return dateTime >= startDateTime && dateTime < endDateTime;
}

/** Một suất nhập tay đã giải xong bộ phận lớn, loại suất và thành tiền. */
export interface CountedManualMeal {
  entry: ManualMealEntry;
  /**
   * NGÀY LÀM VIỆC của suất, "YYYY-MM-DD" — đúng ngày người dùng nhập. Ngày
   * làm việc D chạy (D-1) 22:50 -> D 22:50, nên "CA1 ngày 26" là ca đêm
   * 25 22:50 -> 26 01:50.
   */
  date: string;
  /**
   * Mốc thời gian quy ước của suất = GIỜ BẮT ĐẦU của ca trong ngày làm việc
   * của nó, "YYYY-MM-DD HH:mm:ss" — xem `manualEntryDateTime`.
   *
   * Dòng nhập tay không có giờ quẹt, nhưng khoảng lọc của ứng dụng chính xác
   * tới giây. Không quy về cùng trục thời gian với lượt quẹt thì lọc từ
   * "25/08 22:50:00" vẫn kéo theo cả suất CA2/CA3 của ngày 25/08 — những ca
   * đã tan từ sáng — và bảng kê mọc thêm một cột ngày 25/08 mà nhà ăn không
   * hiểu ở đâu ra.
   */
  dateTime: string;
  /**
   * Ngày trên CỘT NGÀY của bảng kê chi phí — luôn bằng `date`, vì ngày nhập
   * đã là ngày làm việc (ca đêm chốt cho ngày KẾT THÚC ca, như lượt quẹt).
   */
  reportDate: string;
  shiftCode: ShiftCode;
  staffType: StaffType;
  largeDept: string;
  category: MealCategory;
  /**
   * Ngày sinh nhật mà suất này khớp (khoá của SA_BirthdayConfig), nếu có —
   * ngày CA BẮT ĐẦU, nên với CA1 là ngày trước `date`.
   */
  birthdayDate?: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

/**
 * Quy các dòng nhập tay trong khoảng ngày về cùng đơn vị với một lượt quẹt.
 *
 * Loại suất lấy theo cặp (ca × nhóm nhân sự) trong tab Cấu Hình Giá Suất Ăn.
 *
 * SUẤT SINH NHẬT: một dòng ký sổ của NGƯỜI VIỆT rơi đúng vào ngày có trong
 * "Cấu Hình Sinh Nhật" và thuộc một ca ăn sinh nhật thì ăn ĐƠN GIÁ SINH NHẬT
 * CỦA CHÍNH NGÀY ĐÓ — người ký sổ hôm đó cũng ăn suất sinh nhật như người
 * quẹt được thẻ. Ngày đối chiếu là ngày BẮT ĐẦU ca (cùng khoá với
 * `getMealShiftDate` của lượt quẹt) — với CA1 là ngày TRƯỚC ngày nhập.
 * Không truyền `birthdayPrices` thì không dòng nào được áp — các màn hình chỉ
 * ĐẾM suất không cần dựng bảng tra này.
 *
 * Người Hàn không bao giờ bị đè giá sinh nhật, y như lượt quẹt.
 */
export function classifyManualEntries(
  entries: ManualMealEntry[],
  mappings: DepartmentMapping[],
  shiftCategories: ShiftCategoryLookup,
  pricing: MealPricing,
  /** Biên lọc chính xác tới giây, "YYYY-MM-DD HH:mm:ss" — xem `manualInRange`. */
  startDateTime: string,
  endDateTime: string,
  /** SA_Shift — quyết định giờ bắt đầu ca và ca nào vắt qua nửa đêm. */
  shifts?: ShiftInfo[],
  /** Ngày sinh nhật -> đơn giá, dựng bằng `buildBirthdayPriceMap`. */
  birthdayPrices?: Map<string, number>,
  /** Các ca được ăn suất sinh nhật (SA_SystemSetting: BIRTHDAY_SHIFTS). */
  birthdayShifts?: Set<ShiftCode>,
): CountedManualMeal[] {
  const out: CountedManualMeal[] = [];
  const eligibleShifts = birthdayShifts ?? new Set(DEFAULT_BIRTHDAY_SHIFTS);

  entries.forEach((entry) => {
    /* Ngày người dùng nhập là NGÀY LÀM VIỆC của suất; mốc thời gian quy ước
       là giờ bắt đầu ca trong ngày làm việc đó (CA1 bắt đầu 22:50 hôm trước). */
    const date = entry.date.slice(0, 10);
    const dateTime = manualEntryDateTime(date, entry.shiftCode, shifts);
    if (!manualInRange(dateTime, startDateTime, endDateTime)) return;
    /* Ngày CA BẮT ĐẦU — khoá đối chiếu Cấu Hình Sinh Nhật, cùng khoá với
       `getMealShiftDate` của lượt quẹt: CA1 ngày 15 (14 22:50 -> 15 01:50)
       ăn suất sinh nhật của ngày 14, y như người quẹt thẻ lúc 14 23:10. */
    const mealDate = dateTime.slice(0, 10);

    const quantity = Number(entry.quantity) || 0;
    if (quantity <= 0) return;

    /* Dòng nhập trước khi có cột nhóm mang 'VN' — đúng cách bảng kê tính
       chúng từ trước tới nay. */
    const staffType: StaffType = entry.staffType === 'KR' ? 'KR' : 'VN';

    /* Bất biến của cả hệ thống: staffType === 'KR' KHI VÀ CHỈ KHI bộ phận
       lớn là KR. Người nhập gõ tự do ô Bộ Phận nên phải ép lại cho khớp, nếu
       không bảng phân bổ theo bộ phận sẽ có một dòng KR ăn giá Việt. */
    const mapped = getLargeDepartment(entry.department ?? '', mappings);
    const largeDept =
      staffType === 'KR' ? 'KR' : mapped === 'KR' ? 'Khác' : mapped;

    const isBirthday =
      staffType === 'VN' &&
      Boolean(birthdayPrices?.has(mealDate)) &&
      eligibleShifts.has(entry.shiftCode);

    const category = classifyMeal(
      entry.shiftCode,
      staffType === 'KR',
      isBirthday,
      shiftCategories,
    );

    /* Giá cấu hình của chính ngày đó. Ngày để trống giá thì rơi về giá dự
       phòng chứ không thành 0 đồng. */
    const birthdayPrice = isBirthday ? (birthdayPrices?.get(mealDate) ?? 0) : 0;
    const unitPrice = isBirthday
      ? birthdayPrice > 0
        ? birthdayPrice
        : pricing.VN_SINHNHAT
      : pricing[category];

    out.push({
      entry,
      date,
      dateTime,
      /* Ngày nhập đã là ngày làm việc, nên cũng chính là cột ngày của bảng
         kê — không ca nào phải nhảy sang ngày khác. */
      reportDate: date,
      shiftCode: entry.shiftCode,
      staffType,
      largeDept,
      category,
      birthdayDate: isBirthday ? mealDate : undefined,
      quantity,
      unitPrice,
      amount: quantity * unitPrice,
    });
  });

  return out;
}

/** Tổng số suất nhập tay. */
export const manualMealCount = (rows: CountedManualMeal[]) =>
  rows.reduce((sum, r) => sum + r.quantity, 0);

/** Tổng tiền suất nhập tay. */
export const manualMealAmount = (rows: CountedManualMeal[]) =>
  rows.reduce((sum, r) => sum + r.amount, 0);

/**
 * Gom lượt quẹt thành một dòng cho mỗi (NGÀY LÀM VIỆC × nhân viên). Ngày làm
 * việc D chạy (D-1) 22:50 -> D 22:50 (`getCostReportDate`), nên lượt CA1 lúc
 * 25 23:10 và lượt CA4 ngày 26 nằm chung một dòng ngày 26.
 */
export function buildPivotEmployeeLogs(
  logs: MealLog[],
  mappings: DepartmentMapping[],
  shifts?: ShiftInfo[],
): PivotEmployeeDayLog[] {
  const map: Map<string, PivotEmployeeDayLog> = new Map();

  logs.forEach((log) => {
    const largeDept = getLogLargeDepartment(log, mappings);
    const workDate = getCostReportDate(log, shifts);
    const key = `${workDate}_${log.userId}`;

    if (!map.has(key)) {
      map.set(key, {
        actualDate: workDate,
        department: log.department,
        largeDepartment: largeDept,
        userId: log.userId,
        userName: log.userName,
        totalPunches: 0,
        punchesList: [],
      });
    }

    const item = map.get(key)!;
    item.totalPunches += 1;
    item.punchesList.push({
      shift: log.shiftCode,
      time: log.logDateTime,
      reader: log.readerName,
    });

    // Save min time for each shift
    if (log.shiftCode === "CA1") {
      if (!item.gioQuet_CA1 || log.logDateTime < item.gioQuet_CA1)
        item.gioQuet_CA1 = log.logDateTime;
    } else if (log.shiftCode === "CA2") {
      if (!item.gioQuet_CA2 || log.logDateTime < item.gioQuet_CA2)
        item.gioQuet_CA2 = log.logDateTime;
    } else if (log.shiftCode === "CA3") {
      if (!item.gioQuet_CA3 || log.logDateTime < item.gioQuet_CA3)
        item.gioQuet_CA3 = log.logDateTime;
    } else if (log.shiftCode === "CA4") {
      if (!item.gioQuet_CA4 || log.logDateTime < item.gioQuet_CA4)
        item.gioQuet_CA4 = log.logDateTime;
    } else if (log.shiftCode === "CA5") {
      if (!item.gioQuet_CA5 || log.logDateTime < item.gioQuet_CA5)
        item.gioQuet_CA5 = log.logDateTime;
    } else if (log.shiftCode === "CA6") {
      if (!item.gioQuet_CA6 || log.logDateTime < item.gioQuet_CA6)
        item.gioQuet_CA6 = log.logDateTime;
    } else {
      if (!item.gioQuet_Khac || log.logDateTime < item.gioQuet_Khac)
        item.gioQuet_Khac = log.logDateTime;
    }
  });

  return Array.from(map.values()).sort((a, b) => {
    if (a.actualDate !== b.actualDate)
      return b.actualDate.localeCompare(a.actualDate);
    return a.department.localeCompare(b.department);
  });
}

/**
 * Calculates Abnormal Punches (>3 times in a single day)
 */
export function getAbnormalPunches(logs: MealLog[]): AbnormalPunch[] {
  const map: Map<string, MealLog[]> = new Map();

  logs.forEach((log) => {
    const key = `${log.actualDate}_${log.userId}`;
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(log);
  });

  const result: AbnormalPunch[] = [];
  map.forEach((userLogs) => {
    if (userLogs.length > 3) {
      const first = userLogs[0];
      result.push({
        actualDate: first.actualDate,
        userId: first.userId,
        userName: first.userName,
        department: first.department,
        totalPunches: userLogs.length,
        logs: userLogs.sort((a, b) =>
          a.logDateTime.localeCompare(b.logDateTime),
        ),
      });
    }
  });

  return result.sort((a, b) => b.actualDate.localeCompare(a.actualDate));
}

/* ---------------------------------------------------------------------------
   Đánh giá lượt quẹt dư của từng người trong từng ngày công
   ---------------------------------------------------------------------------
   Hai quy tắc, xét theo thứ tự thời gian quẹt trong ngày:
     1. Mỗi ca chỉ được quẹt MỘT lần. Lượt quẹt vào ca đã quẹt rồi là mất mát
        (TRUNG_CA) — kể cả khi cả ngày mới quẹt 2-3 lần.
     2. Mỗi ngày chỉ được tối đa `limit` ca hợp lệ. Ca hợp lệ thứ `limit + 1`
        trở đi là mất mát (VUOT_HAN_MUC).
   Ví dụ 4 lượt mà lượt 2 trùng ca lượt 1: các lượt 1, 3, 4 nằm ở 3 ca khác
   nhau nên đều hợp lệ; chỉ lượt 2 bị tính mất mát.
   --------------------------------------------------------------------------- */

export type PunchLossReason = "TRUNG_CA" | "VUOT_HAN_MUC";

/**
 * Một lượt mất mát có bị trừ tiền hay không.
 *
 * Quẹt lại ngay sau lượt trước gần như luôn là thao tác lỗi — thẻ không ăn,
 * người ta quẹt lại, máy ghi hai lần. Suất đó không có ai ăn thêm nên không
 * trừ tiền ai cả. Quá `FREE_DUP_WINDOW_MINUTES` mới coi là lấy thêm một suất
 * thật.
 *
 * Chỉ áp cho lỗi TRÙNG CA: vượt hạn mức ca/ngày luôn là suất thật.
 */
export type LossCharge = "BI_TRU" | "KHONG_TRU";

/** Quẹt trùng ca trong vòng ngần này phút thì không trừ tiền. */
export const FREE_DUP_WINDOW_MINUTES = 10;

export interface EvaluatedPunch {
  log: MealLog;
  isLoss: boolean;
  reason: PunchLossReason | null;
  /**
   * Số phút kể từ lượt quẹt LIỀN TRƯỚC trong cùng ngày làm việc; null nếu là
   * lượt đầu tiên của ngày. Có phần thập phân để so "dưới 10 phút" cho đúng.
   */
  gapMinutes: number | null;
  /** Chỉ có giá trị khi `isLoss`. */
  charge: LossCharge | null;
}

export interface PunchDayCase {
  /**
   * NGÀY LÀM VIỆC, không phải ngày lịch: ca đêm 22:50 -> 01:50 được tính trọn
   * cho ngày kết thúc ca (`getCostReportDate`). Nhờ vậy quẹt 00:05 và quẹt
   * 23:45 trong cùng một ngày lịch thuộc hai ngày làm việc khác nhau và không
   * bị kết luận nhầm là trùng ca.
   */
  workDate: string;
  userId: string;
  userName: string;
  department: string;
  totalPunches: number;
  /** Số lượt được chấp nhận = số ca khác nhau, tối đa `limit`. */
  validCount: number;
  lossCount: number;
  dupShiftCount: number;
  overLimitCount: number;
  /** Số lượt mất mát bị trừ tiền / không bị trừ tiền. */
  chargeableCount: number;
  freeCount: number;
  /** Toàn bộ lượt quẹt trong ngày theo thứ tự thời gian, kèm kết luận. */
  punches: EvaluatedPunch[];
}

/**
 * "YYYY-MM-DD HH:mm:ss" -> số giây, để trừ hai thời điểm.
 *
 * Tự tách chuỗi rồi dựng qua Date.UTC thay vì `new Date(chuỗi)`: chuỗi ngăn
 * cách bằng dấu cách chứ không phải chữ T nên trình duyệt hiểu theo giờ địa
 * phương và lệch một giờ vào ngày đổi giờ mùa. Ở đây chỉ cần HIỆU hai mốc nên
 * quy hết về UTC là chính xác tuyệt đối.
 */
function toEpochSeconds(dateTime: string): number {
  const y = Number(dateTime.slice(0, 4));
  const mo = Number(dateTime.slice(5, 7));
  const d = Number(dateTime.slice(8, 10));
  const h = Number(dateTime.slice(11, 13));
  const mi = Number(dateTime.slice(14, 16));
  const se = Number(dateTime.slice(17, 19));
  return Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
}

/** Gom log theo (ngày làm việc, nhân viên) rồi áp hai quy tắc ở trên. */
export function evaluatePunchDays(
  logs: MealLog[],
  shifts?: ShiftInfo[],
  limit: number = 3
): PunchDayCase[] {
  const byKey = new Map<string, { workDate: string; logs: MealLog[] }>();

  logs.forEach((log) => {
    /* Ngày LÀM VIỆC, không phải ngày lịch — xem chú thích của workDate. */
    const workDate = getCostReportDate(log, shifts);
    const key = `${workDate}_${log.userId}`;
    if (!byKey.has(key)) byKey.set(key, { workDate, logs: [] });
    byKey.get(key)!.logs.push(log);
  });

  const result: PunchDayCase[] = [];

  byKey.forEach(({ workDate, logs: dayLogs }) => {
    /* Sắp theo thời điểm đầy đủ chứ không theo giờ trong ngày: một ngày làm
       việc có thể vắt qua nửa đêm, 23:45 phải đứng TRƯỚC 00:30 hôm sau. */
    const ordered = [...dayLogs].sort((a, b) =>
      a.logDateTime.localeCompare(b.logDateTime)
    );

    const seenShifts = new Set<ShiftCode>();
    let distinctShifts = 0;
    let dupShiftCount = 0;
    let overLimitCount = 0;
    let chargeableCount = 0;
    let freeCount = 0;

    const punches: EvaluatedPunch[] = ordered.map((log, index) => {
      const gapMinutes =
        index === 0
          ? null
          : (toEpochSeconds(log.logDateTime) -
              toEpochSeconds(ordered[index - 1].logDateTime)) /
            60;

      if (seenShifts.has(log.shiftCode)) {
        dupShiftCount += 1;
        /* Quẹt lại trong vòng 10 phút = thao tác lỗi, không ai ăn thêm suất
           nào nên không trừ tiền. */
        const charge: LossCharge =
          gapMinutes !== null && gapMinutes < FREE_DUP_WINDOW_MINUTES
            ? "KHONG_TRU"
            : "BI_TRU";
        if (charge === "BI_TRU") chargeableCount += 1;
        else freeCount += 1;
        return { log, isLoss: true, reason: "TRUNG_CA", gapMinutes, charge };
      }

      seenShifts.add(log.shiftCode);
      distinctShifts += 1;

      if (distinctShifts > limit) {
        overLimitCount += 1;
        chargeableCount += 1;
        return {
          log,
          isLoss: true,
          reason: "VUOT_HAN_MUC",
          gapMinutes,
          charge: "BI_TRU",
        };
      }
      return { log, isLoss: false, reason: null, gapMinutes, charge: null };
    });

    const first = ordered[0];
    result.push({
      workDate,
      userId: first.userId,
      userName: first.userName,
      department: first.department,
      totalPunches: ordered.length,
      validCount: Math.min(distinctShifts, limit),
      lossCount: dupShiftCount + overLimitCount,
      dupShiftCount,
      overLimitCount,
      chargeableCount,
      freeCount,
      punches,
    });
  });

  return result.sort((a, b) => {
    if (a.workDate !== b.workDate) return b.workDate.localeCompare(a.workDate);
    return a.userId.localeCompare(b.userId);
  });
}

/**
 * Format currency VND
 */
export function formatVND(amount: number): string {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
  }).format(amount);
}

/**
 * Export array data to CSV file download
 */
export function exportToCSV(
  filename: string,
  headers: string[],
  rows: (string | number)[][],
) {
  const csvContent =
    "data:text/csv;charset=utf-8,\uFEFF" +
    [
      headers.join(","),
      ...rows.map((e) =>
        e.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(","),
      ),
    ].join("\n");

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `${filename}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
