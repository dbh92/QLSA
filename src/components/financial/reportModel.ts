/**
 * Mô hình dùng chung cho các bảng kê trong tab "Báo Cáo Chi Phí".
 *
 * Mọi bảng kê ở đây đều dựng trên MỘT lượt phân loại log duy nhất
 * (`classifyLogs`) để bảng kê tháng, bảng phân bổ tiền ăn và 6 bảng chi tiết
 * theo ca không bao giờ ra hai con số khác nhau cho cùng một lượt quẹt.
 *
 * Cột ngày của các bảng kê đánh theo `reportDate` chứ không phải
 * `actualDate`: ca đêm 22:50 -> 01:50 là MỘT ca liền mạch và nhà ăn chốt nó
 * cho NGÀY KẾT THÚC ca, nên cả ca nằm ở cột của ngày hôm sau. Xem khối chú
 * thích "NGÀY CỦA BẢNG KÊ CHI PHÍ" trong src/services/mealEngine.ts.
 */
import {
  MealLog,
  ShiftCode,
  ShiftInfo,
  StaffType,
  DepartmentMapping,
  DailyMilkEntry,
  ExtraCostEntry,
  SupplyShiftCode,
  MonthlyCostRow,
  LaborWorkDayRule,
  CostMonthPeriod,
} from "../../types";
import {
  CountedManualMeal,
  evaluatePunchDays,
  LossCharge,
  MealCategory,
  MealPricing,
  ShiftCategoryLookup,
  MEAL_CATEGORY_META,
  SUPPLY_SHIFT_LABEL,
  SUPPLY_SHIFT_ORDER,
  addDays,
  classifyMeal,
  costWorkDayRange,
  getCostReportDate,
  getLogLargeDepartment,
  getMealShiftDate,
  isBirthdayMealLog,
  reportShiftLabel,
  supplyInRange,
  workDayStartTime,
} from "../../services/mealEngine";

/** Thứ tự ca cố định của mọi bảng kê: CA1 (ca đêm) trước, rồi xuôi trong ngày. */
export const SHIFT_ORDER: ShiftCode[] = [
  "CA1",
  "CA2",
  "CA3",
  "CA4",
  "CA5",
  "CA6",
];

/** Tên ca & khung giờ dùng chung với Dashboard — định nghĩa ở mealEngine. */
export { reportShiftLabel };
export { shiftAlias, shiftWindow } from "../../services/mealEngine";

/** Hai ca cấp phát — mỗi ca là một DÒNG CON của khối Sữa / Chi phí phát sinh. */
export { SUPPLY_SHIFT_LABEL, SUPPLY_SHIFT_ORDER };

/* -------------------------------------------------------------------------
   Cột ngày
   ------------------------------------------------------------------------- */

/** Nhãn cột ngày = ngày trong tháng, giống bảng kê Excel gửi nhà ăn. */
export const dayLabel = (date: string) => String(Number(date.slice(8, 10)));

/** "26/06" — dùng cho tooltip và cho ô ghi chú. */
export const dayMonthLabel = (date: string) =>
  `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/**
 * Danh sách cột ngày của bảng kê: liền mạch từ ngày CÓ SỐ LIỆU sớm nhất tới
 * ngày có số liệu muộn nhất.
 *
 * Cắt theo số liệu chứ không theo `startDate`/`endDate` vì khoảng lọc chính
 * xác tới giây: lọc từ 22:50 ngày 18 thì ngày 18 không còn lượt quẹt nào của
 * riêng nó (ca đêm 22:50 trở đi đã tính sang ngày 19), một cột 18 rỗng chỉ làm
 * người đọc tưởng hôm đó cả nhà máy nhịn ăn. Cùng lý do ở đầu kia: ca đêm quẹt
 * từ 22:50 ngày cuối khoảng lọc được tính cho ngày hôm sau, nằm ngoài
 * `endDate`, nên vẫn phải có cột riêng.
 *
 * Chỉ cắt hai ĐẦU: ngày rỗng nằm giữa (chủ nhật nghỉ, ngày lễ) vẫn giữ cột
 * rỗng, đúng khuôn bảng kê gửi nhà ăn.
 *
 * `startDate`/`endDate` chỉ còn là khung dự phòng cho trường hợp cả kỳ không
 * có số liệu nào — khi đó bảng vẫn phải hiện ra có cột ngày chứ không cụt.
 */
export function buildDayColumns(
  startDate: string,
  endDate: string,
  reportDates: Iterable<string>,
): string[] {
  let first: string | null = null;
  let last: string | null = null;
  for (const d of reportDates) {
    if (first === null || d < first) first = d;
    if (last === null || d > last) last = d;
  }

  if (first === null || last === null) {
    first = startDate;
    last = endDate;
  }

  const days: string[] = [];
  // Chặn trên 400 ngày để một khoảng lọc gõ nhầm không dựng bảng vô hạn cột.
  for (let d = first; d <= last && days.length < 400; d = addDays(d, 1)) {
    days.push(d);
  }
  return days;
}

/**
 * Gom mọi ngày CÓ SỐ LIỆU trong kỳ để đưa vào `buildDayColumns`.
 *
 * Không chỉ có lượt quẹt: dòng "Ký số", dòng sữa nhập tay theo ngày và ngày
 * công của chi phí nhân công đều không nằm trong `classified`. Bỏ sót chúng
 * thì một ngày chỉ có ký số, chỉ có sữa hoặc chỉ có nhân công sẽ bị cắt mất
 * cột, và số của nó biến khỏi bảng kê.
 */
export function collectReportDates(
  classified: ClassifiedLog[],
  manualMeals: CountedManualMeal[],
  /* Đã lọc theo khoảng lọc (`filterSupplyByRange`), không lọc lại ở đây. */
  milkEntries: DailyMilkEntry[],
  extraCosts: ExtraCostEntry[],
  /* Đã cắt sẵn theo khoảng lọc lúc dựng, nên không lọc lại ở đây. */
  laborSegments: LaborSegment[] = [],
): string[] {
  const dates = classified.map((r) => r.reportDate);

  /* Suất nhập tay đã được lọc theo khoảng lọc lúc phân loại. Lấy `reportDate`
     chứ không phải ngày nhập: suất CA1 được chốt cho ngày hôm sau, đúng như
     lượt quẹt của ca đêm. */
  manualMeals.forEach((r) => dates.push(r.reportDate));

  /* Hàng cấp phát: cột của nó là chính ngày nhập (ca đêm ngày D chạy từ
     22:50 ngày D-1, đúng như `reportDate` của lượt quẹt CA1). Bỏ sót thì một
     ngày chỉ có sữa hoặc chỉ có chi phí phát sinh sẽ bị cắt mất cột. */
  [...milkEntries.map(milkAsSupply), ...extraCosts.map(extraAsSupply)].forEach(
    (e) => dates.push(e.date.slice(0, 10)),
  );

  /* Ngày công nhân công: hai đầu của phần giao là đủ để dải cột không bị cắt
     — `buildDayColumns` chỉ đọc ngày sớm nhất và muộn nhất. */
  laborSegments.forEach((s) => {
    dates.push(s.from);
    dates.push(s.toInclusive);
  });

  return dates;
}

/* -------------------------------------------------------------------------
   Phân loại log
   ------------------------------------------------------------------------- */

/** Một lượt quẹt đã giải xong bộ phận lớn, nhóm nhân sự, ngày kê và loại suất. */
export interface ClassifiedLog {
  log: MealLog;
  largeDept: string;
  staffType: StaffType;
  /**
   * Khoá cột ngày của mọi bảng kê ở đây: ca đêm 22:50 -> 01:50 được tính trọn
   * cho ngày KẾT THÚC ca (xem `getCostReportDate`). KHÔNG dùng cho sinh nhật —
   * suất sinh nhật vẫn đối chiếu theo `getMealShiftDate` (ngày bắt đầu ca).
   */
  reportDate: string;
  category: MealCategory;
  /**
   * ĐƠN GIÁ THẬT của lượt quẹt này.
   *
   * Không suy ra được từ `category` với suất sinh nhật: mỗi ngày sinh nhật
   * mang đơn giá riêng trong tab "Cấu Hình Sinh Nhật", nên hai lượt cùng
   * category `VN_SINHNHAT` của hai ngày khác nhau có hai giá khác nhau. Mọi
   * bảng trong tab đọc ô này chứ không tra lại `pricing[category]`.
   */
  unitPrice: number;
  /**
   * Ngày sinh nhật mà lượt quẹt này khớp (khoá của SA_BirthdayConfig) — chính
   * là NGÀY CỦA CA (`getMealShiftDate`), không phải `reportDate`. Chỉ có ở
   * suất sinh nhật.
   */
  birthdayDate?: string;
}

export function classifyLogs(
  logs: MealLog[],
  mappings: DepartmentMapping[],
  shifts: ShiftInfo[],
  shiftCategories: ShiftCategoryLookup,
  /**
   * Ngày sinh nhật -> đơn giá suất sinh nhật của ngày đó
   * (`buildBirthdayPriceMap`). Vừa là danh sách ngày để nhận diện suất sinh
   * nhật, vừa là nguồn đơn giá — một bảng tra duy nhất nên không thể có
   * chuyện "ngày là sinh nhật nhưng lấy nhầm giá của ngày khác".
   */
  birthdayPrices: Map<string, number>,
  birthdayShifts: Set<ShiftCode>,
  /** Bảng giá SA_MealPrice — dùng cho mọi loại suất KHÔNG phải sinh nhật. */
  pricing: MealPricing,
): ClassifiedLog[] {
  return logs.map((log) => {
    const largeDept = getLogLargeDepartment(log, mappings);
    /* CHỈ bộ phận lớn KR mới ăn giá suất Hàn, và ăn ở mọi máy chấm — máy
       TA-102 không quyết định gì về giá. */
    const staffType: StaffType = largeDept === "KR" ? "KR" : "VN";
    /* Cột ngày chốt theo giờ KẾT THÚC ca; suất sinh nhật ngay dưới đây vẫn
       chốt theo giờ BẮT ĐẦU ca — hai câu hỏi khác nhau, đừng gộp làm một. */
    const reportDate = getCostReportDate(log, shifts);
    const isBirthday = isBirthdayMealLog(
      log,
      birthdayPrices,
      shifts,
      birthdayShifts,
    );
    const category = classifyMeal(
      log.shiftCode,
      staffType === "KR",
      isBirthday,
      shiftCategories,
    );

    /* Đơn giá suất sinh nhật lấy của ĐÚNG ngày ăn. Ngày nào cấu hình bỏ trống
       giá thì rơi về SA_MealPrice thay vì tính thành 0 đồng. */
    const birthdayDate = isBirthday ? getMealShiftDate(log, shifts) : undefined;
    const birthdayPrice = birthdayDate
      ? (birthdayPrices.get(birthdayDate) ?? 0)
      : 0;

    return {
      log,
      largeDept,
      staffType,
      reportDate,
      category,
      unitPrice: isBirthday
        ? birthdayPrice > 0
          ? birthdayPrice
          : pricing.VN_SINHNHAT
        : pricing[category],
      birthdayDate,
    };
  });
}

/* -------------------------------------------------------------------------
   Điều chỉnh số liệu — CHỌN ra những lượt quẹt sẽ bị XOÁ KHỎI HỆ THỐNG
   -------------------------------------------------------------------------
   Người dùng cần chốt số với nhà ăn sau khi bỏ đi những suất không phải trả:
   suất mất mát do chấm thẻ sai, và những khoản trừ thoả thuận riêng.

   Các hàm ở đây chỉ TÍNH RA tập lượt quẹt bị bỏ (`AdjustmentResult.removed`)
   và số tiền tương ứng, để popup xem trước rồi gửi danh sách id xuống
   `SA_MealLogDeleted_Save`. Việc xoá là THẬT: từ lúc đó Dashboard, Lịch Sử
   Chấm Ăn, mọi bảng kê và cả biểu đồ 12 tháng đều không tính chúng nữa —
   không màn hình nào phải nhớ tự trừ.

   HAI LOẠI XOÁ, HAI SỐ PHẬN:
     - Suất mất mát do chấm thẻ sai (`lossIds`, DeleteKind 'MAT_MAT'): bị trừ
       khỏi mọi con số, NHƯNG tab Suất Ăn Mất Mát vẫn hiển thị y nguyên —
       SA_MealLog_GetByRange vẫn trả chúng về với `MealLog.lossDeleted`.
     - Xoá suất ăn bất kỳ (`adHocIds`, DeleteKind 'BAT_KY'): biến mất khỏi
       tất cả, kể cả tab Suất Ăn Mất Mát.

   Bản sao đầy đủ của dòng bị xoá nằm ở QLSA.dbo.TB_EVENT_LOG_DEL (cấu trúc y
   hệt BioStar.dbo.TB_EVENT_LOG) nên xoá nhầm gỡ lại được nguyên vẹn theo từng
   lượt xoá — xem `SA_MealLogDeleted_Restore`.

   `classified` truyền vào là tập của khoảng đang lọc KỂ CẢ những lượt mất mát
   đã xoá (`log.lossDeleted`): suất mất mát được đánh giá trên đúng tập mà tab
   Suất Ăn Mất Mát nhìn thấy, nên phân loại Bị trừ / Không trừ của một lượt
   không đổi chỉ vì lượt bên cạnh nó đã bị xoá trước đó. Lượt đã xoá thì không
   bị xoá lần nữa và không bao giờ được khoản trừ tự nhập chọn. Kết quả
   `classified` trả ra chỉ dùng để popup ước lượng, không còn màn hình nào
   dựng bảng từ nó. */

/**
 * Phạm vi suất mất mát được trừ, theo `LossCharge` của `evaluatePunchDays`:
 * ALL = mọi suất mất mát, CHARGEABLE = chỉ `BI_TRU`, FREE = chỉ `KHONG_TRU`
 * (quẹt lại trong vòng `FREE_DUP_WINDOW_MINUTES`, không ai ăn thêm suất nào).
 */
export type LossDeductScope = "ALL" | "CHARGEABLE" | "FREE";

/** Suất mất mát có thuộc phạm vi được chọn hay không. */
const inLossScope = (scope: LossDeductScope, charge: LossCharge) =>
  scope === "ALL" ||
  (scope === "CHARGEABLE" && charge === "BI_TRU") ||
  (scope === "FREE" && charge === "KHONG_TRU");

/** Một khoản trừ tự nhập: trừ bao nhiêu suất của (nhóm nhân sự, ngày, ca). */
export interface AdHocDeduction {
  /** Khoá tạm phía client, không có trong cơ sở dữ liệu. */
  id: string;
  staffType: StaffType;
  /** Ngày của BẢNG KÊ (`reportDate`), đúng cột ngày người dùng đang nhìn. */
  date: string;
  shiftCode: ShiftCode;
  quantity: number;
}

export interface CostAdjustment {
  /** Trừ các suất mất mát do chấm thẻ sai. */
  deductLosses: boolean;
  lossScope: LossDeductScope;
  adHoc: AdHocDeduction[];
}

export const EMPTY_ADJUSTMENT: CostAdjustment = {
  deductLosses: false,
  lossScope: "ALL",
  adHoc: [],
};

export const isAdjustmentActive = (a: CostAdjustment) =>
  a.deductLosses || a.adHoc.some((d) => d.quantity > 0);

/** Kết quả một khoản trừ tự nhập — trừ được bao nhiêu so với yêu cầu. */
export interface AdHocOutcome {
  deduction: AdHocDeduction;
  requested: number;
  applied: number;
  amount: number;
}

export interface AdjustmentResult {
  /** Tập lượt quẹt SAU khi trừ — mọi bảng trong tab dựng từ đây. */
  classified: ClassifiedLog[];
  /**
   * Các lượt quẹt SẼ BỊ XOÁ. `removed.map(r => r.log.id)` chính là danh sách
   * id gửi xuống `SA_MealLogDeleted_Save` — id ở đây là
   * TB_EVENT_LOG.nEventLogIdn, khoá của bảng lưu trữ TB_EVENT_LOG_DEL.
   */
  removed: ClassifiedLog[];
  /** Phần của `removed` là suất mất mát — gửi đi làm `lossIds`. */
  lossIds: string[];
  /** Phần của `removed` là khoản trừ tự nhập — gửi đi làm `ids`. */
  adHocIds: string[];
  lossCount: number;
  lossAmount: number;
  adHocOutcomes: AdHocOutcome[];
  adHocCount: number;
  adHocAmount: number;
  totalCount: number;
  totalAmount: number;
  /** Số suất yêu cầu trừ nhưng không đủ lượt quẹt để trừ. */
  shortfall: number;
}

const EMPTY_RESULT = (classified: ClassifiedLog[]): AdjustmentResult => ({
  classified: classified.filter((r) => !r.log.lossDeleted),
  removed: [],
  lossIds: [],
  adHocIds: [],
  lossCount: 0,
  lossAmount: 0,
  adHocOutcomes: [],
  adHocCount: 0,
  adHocAmount: 0,
  totalCount: 0,
  totalAmount: 0,
  shortfall: 0,
});

/**
 * Bỏ khỏi `classified` những lượt quẹt bị trừ, và cho biết đã trừ bao nhiêu
 * suất / bao nhiêu tiền.
 *
 * Thứ tự bỏ của khoản trừ tự nhập là LƯỢT QUẸT MUỘN NHẤT TRƯỚC: khi số suất
 * yêu cầu ít hơn số lượt có thật thì phải chọn bỏ lượt nào, và lượt muộn nhất
 * là lượt dễ là lượt dư nhất. Quy tắc cố định để hai lần chạy cùng dữ liệu ra
 * cùng một kết quả.
 *
 * KHOẢN TRỪ TỰ NHẬP KHÔNG BAO GIỜ ĐỤNG TỚI SUẤT MẤT MÁT — dù có chọn trừ mất
 * mát hay không. Nó tránh CẢ (ngày làm việc × người) có suất mất mát, không
 * chỉ riêng lượt mất mát: lượt hợp lệ của ngày đó cũng nằm trong chi tiết của
 * tab Suất Ăn Mất Mát, và xoá nó đi thì lượt trùng ca còn lại thôi là trùng
 * ca (hoặc đổi Bị trừ / Không trừ). Xoá 'BAT_KY' biến mất khỏi cả tab đó, nên
 * chỉ cần đụng một lượt trong những ngày ấy là tab đó không còn y nguyên. Né
 * cả ngày thì đủ: mất mát được đánh giá riêng từng (ngày làm việc × người),
 * và bớt lượt quẹt ở một ngày sạch không thể sinh ra mất mát mới.
 */
export function applyCostAdjustment(
  classified: ClassifiedLog[],
  shifts: ShiftInfo[],
  pricing: MealPricing,
  adjustment: CostAdjustment,
): AdjustmentResult {
  if (!isAdjustmentActive(adjustment)) return EMPTY_RESULT(classified);

  /* Đơn giá đã giải sẵn lúc phân loại — suất sinh nhật mỗi ngày một giá nên
     không tra ngược `pricing[category]` được nữa. */
  const priceOf = (r: ClassifiedLog) => r.unitPrice;
  /* Bỏ theo id lượt quẹt: một lượt đã bị trừ vì mất mát thì khoản trừ tự nhập
     không được trừ nó lần nữa. */
  const removed = new Set<string>();
  const lossIds: string[] = [];
  const adHocIds: string[] = [];

  let lossCount = 0;
  let lossAmount = 0;

  /* Đánh giá MỘT lần, trên đúng tập mà tab Suất Ăn Mất Mát nhìn thấy (kể cả
     lượt mất mát đã xoá), cho cả hai việc: chọn suất mất mát để trừ, và rào
     những ngày có mất mát khỏi khoản trừ tự nhập. */
  const cases = evaluatePunchDays(
    classified.map((r) => r.log),
    shifts,
  );

  /* Mọi lượt quẹt thuộc một (ngày làm việc × người) có suất mất mát. */
  const inLossCase = new Set<string>();
  cases.forEach((c) => {
    if (c.lossCount === 0) return;
    c.punches.forEach((p) => inLossCase.add(p.log.id));
  });

  if (adjustment.deductLosses) {
    const byId = new Map(classified.map((r) => [r.log.id, r]));
    cases.forEach((c) =>
      c.punches.forEach((p) => {
        if (!p.isLoss || !inLossScope(adjustment.lossScope, p.charge)) return;

        const row = byId.get(p.log.id);
        /* Đã xoá ở lượt trước: số liệu đã trừ rồi, không gửi lại. */
        if (!row || row.log.lossDeleted || removed.has(row.log.id)) return;

        removed.add(row.log.id);
        lossIds.push(row.log.id);
        lossCount += 1;
        lossAmount += priceOf(row);
      }),
    );
  }

  /* Gom sẵn theo (nhóm, ngày kê, ca) để mỗi khoản trừ không phải quét lại cả
     tập — một tháng là ~45.000 lượt quẹt. */
  const buckets = new Map<string, ClassifiedLog[]>();
  const bucketKey = (
    staffType: StaffType,
    date: string,
    shiftCode: ShiftCode,
  ) => `${staffType}|${date}|${shiftCode}`;

  classified.forEach((r) => {
    /* Khoản trừ tự nhập không được chọn lượt nào của một ngày có suất mất
       mát — kể cả suất mất mát đã xoá — xem chú thích của hàm. */
    if (r.log.lossDeleted || inLossCase.has(r.log.id)) return;
    const key = bucketKey(r.staffType, r.reportDate, r.log.shiftCode);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  });
  buckets.forEach((rows) =>
    rows.sort((a, b) => b.log.logDateTime.localeCompare(a.log.logDateTime)),
  );

  const adHocOutcomes: AdHocOutcome[] = [];
  let adHocCount = 0;
  let adHocAmount = 0;
  let shortfall = 0;

  adjustment.adHoc.forEach((d) => {
    const requested = Math.max(0, Math.trunc(d.quantity));
    if (requested === 0) return;

    const rows = buckets.get(bucketKey(d.staffType, d.date, d.shiftCode)) ?? [];
    let applied = 0;
    let amount = 0;

    for (const r of rows) {
      if (applied >= requested) break;
      if (removed.has(r.log.id)) continue;
      removed.add(r.log.id);
      adHocIds.push(r.log.id);
      applied += 1;
      amount += priceOf(r);
    }

    adHocOutcomes.push({ deduction: d, requested, applied, amount });
    adHocCount += applied;
    adHocAmount += amount;
    shortfall += requested - applied;
  });

  return {
    classified: classified.filter(
      (r) => !r.log.lossDeleted && !removed.has(r.log.id),
    ),
    removed: classified.filter((r) => removed.has(r.log.id)),
    lossIds,
    adHocIds,
    lossCount,
    lossAmount,
    adHocOutcomes,
    adHocCount,
    adHocAmount,
    totalCount: lossCount + adHocCount,
    totalAmount: lossAmount + adHocAmount,
    shortfall,
  };
}

/**
 * Số suất mất mát CÒN có thể trừ, tách theo phân loại — để popup hiện sẵn con
 * số trước khi người dùng bấm áp dụng. Đánh giá trên cùng tập với
 * `applyCostAdjustment` (kể cả lượt đã xoá) rồi bỏ những lượt đã xoá.
 */
export function previewLossDeduction(
  classified: ClassifiedLog[],
  shifts: ShiftInfo[],
  pricing: MealPricing,
): Record<LossDeductScope, { count: number; amount: number }> {
  const byId = new Map(classified.map((r) => [r.log.id, r]));
  const acc: Record<LossDeductScope, { count: number; amount: number }> = {
    ALL: { count: 0, amount: 0 },
    CHARGEABLE: { count: 0, amount: 0 },
    FREE: { count: 0, amount: 0 },
  };

  evaluatePunchDays(
    classified.map((r) => r.log),
    shifts,
  ).forEach((c) =>
    c.punches.forEach((p) => {
      if (!p.isLoss) return;
      const row = byId.get(p.log.id);
      if (!row || row.log.lossDeleted) return;
      const price = row.unitPrice;

      (Object.keys(acc) as LossDeductScope[]).forEach((scope) => {
        if (!inLossScope(scope, p.charge)) return;
        acc[scope].count += 1;
        acc[scope].amount += price;
      });
    }),
  );

  return acc;
}

/* -------------------------------------------------------------------------
   Cộng dồn theo ngày
   ------------------------------------------------------------------------- */

/** Số lượng theo từng ngày + tổng, khung xương của mọi dòng bảng kê. */
export interface DaySeries {
  byDay: Record<string, number>;
  total: number;
}

export const emptySeries = (): DaySeries => ({ byDay: {}, total: 0 });

export function addToSeries(series: DaySeries, date: string, qty = 1) {
  series.byDay[date] = (series.byDay[date] ?? 0) + qty;
  series.total += qty;
}

/** Gom một tập lượt quẹt đã phân loại thành chuỗi theo ngày. */
export function seriesOf(
  rows: ClassifiedLog[],
  keep: (r: ClassifiedLog) => boolean,
): DaySeries {
  const s = emptySeries();
  rows.forEach((r) => {
    if (keep(r)) addToSeries(s, r.reportDate);
  });
  return s;
}

/**
 * Chuỗi theo ngày của các dòng nhập thủ công thuộc một ca VÀ một nhóm nhân sự.
 *
 * Nhóm nhân sự là bắt buộc vì hai khối của bảng kê xử lý suất nhập tay khác
 * nhau: suất người Việt hiện thành dòng "Ký số" riêng dưới dòng ca (nhà ăn
 * đối chiếu chữ ký trên sổ), còn suất người Hàn cộng thẳng vào dòng ca của
 * khối 한국 — cùng ca, cùng ngày, cùng giá suất Hàn. Dòng nhập trước khi có
 * cột nhóm mang 'VN', đúng cách bảng kê tính chúng từ trước tới nay.
 */
export function manualSeries(
  manualMeals: CountedManualMeal[],
  shiftCode: ShiftCode,
  staffType: StaffType,
  /** Lọc thêm — dùng để tách suất ký sổ ngày sinh nhật ra khỏi dòng ca. */
  keep?: (r: CountedManualMeal) => boolean,
): DaySeries {
  const s = emptySeries();
  manualMeals.forEach((r) => {
    if (r.shiftCode !== shiftCode || r.staffType !== staffType) return;
    if (keep && !keep(r)) return;
    /* Cột ngày là `reportDate`: chỉ CA1 nhảy sang ngày hôm sau, các ca còn
       lại giữ nguyên ngày nhập. */
    addToSeries(s, r.reportDate, r.quantity);
  });
  return s;
}

/**
 * Suất ký sổ KHÔNG phải suất sinh nhật.
 *
 * Suất ký sổ của người Việt rơi vào ngày sinh nhật đã được tách sang khối
 * "Suất ăn đặc biệt SN" với đơn giá của ngày đó, nên dòng ca không được đếm
 * lại — nếu không cùng một suất vào bảng kê hai lần.
 */
export const notBirthdayManual = (r: CountedManualMeal) =>
  r.category !== "VN_SINHNHAT";

/** Số liệu của MỘT ca cấp phát: theo ngày, tiền và đơn giá bình quân của ca. */
export interface SupplyShiftSeries {
  series: DaySeries;
  amount: number;
  /** Đơn giá bình quân của riêng ca này — mỗi lượt nhập có giá riêng. */
  unitPrice: number;
}

/** Sữa cấp trong khoảng, tách theo loại sữa (SA_MilkEntry.MilkType là tự do). */
export interface SupplySeries {
  /** Tên hạng mục: loại sữa, hoặc tên chi phí phát sinh do người dùng đặt. */
  itemName: string;
  series: DaySeries;
  /**
   * Cùng số liệu như `series` nhưng tách theo ca cấp phát. Bảng kê tháng in
   * MỖI CA MỘT DÒNG CON ("Ca ngày" / "Ca đêm" nằm ở cột DATE), nên dòng cấp
   * phát phải giữ được cả tổng ngày lẫn tiền của từng ca.
   */
  byShift: Record<SupplyShiftCode, SupplyShiftSeries>;
  /** Đơn giá bình quân — mỗi dòng nhập có thể có đơn giá riêng. */
  unitPrice: number;
  amount: number;
}

const emptyShiftSeries = (): Record<SupplyShiftCode, SupplyShiftSeries> => ({
  NGAY: { series: emptySeries(), amount: 0, unitPrice: 0 },
  DEM: { series: emptySeries(), amount: 0, unitPrice: 0 },
});

/** Hình dạng chung của một dòng cấp phát — sữa và chi phí phát sinh quy về đây. */
export interface SupplyEntryLike {
  date: string;
  shift: SupplyShiftCode;
  itemName: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
}

export const milkAsSupply = (e: DailyMilkEntry): SupplyEntryLike => ({
  date: e.date,
  /* Dòng nhập từ trước khi có cột ca không mang ca nào — gom về ca ngày,
     đúng như `parseSupplyShift` và mặc định của SA_MilkEntry.MilkShift. */
  shift: e.milkShift === "DEM" ? "DEM" : "NGAY",
  itemName: e.milkType,
  quantity: e.quantity,
  unitPrice: e.unitPrice,
  totalAmount: e.totalAmount,
});

export const extraAsSupply = (e: ExtraCostEntry): SupplyEntryLike => ({
  date: e.date,
  shift: e.costShift === "DEM" ? "DEM" : "NGAY",
  itemName: e.costType,
  quantity: e.quantity,
  unitPrice: e.unitPrice,
  totalAmount: e.totalAmount,
});

/**
 * Giữ lại những dòng cấp phát rơi vào khoảng lọc CHÍNH XÁC TỚI GIÂY.
 *
 * Ca đêm của ngày D chạy (D-1) 22:50 -> D 08:00, ca ngày D 08:00 -> D 22:50
 * (`supplyShiftWindow`), nên lọc từ 25 lúc 23:00 không còn kéo sữa của ngày 25
 * vào tổng chi phí. Tab Báo Cáo Chi Phí lọc MỘT LẦN ở đây rồi truyền mảng đã
 * lọc xuống mọi bảng và mọi sheet Excel — `buildSupplySeries`,
 * `collectReportDates` và `reconcileCost` đều tin đầu vào, không lọc lại.
 */
export function filterSupplyByRange<T>(
  entries: T[],
  toSupply: (e: T) => SupplyEntryLike,
  startDateTime: string,
  endDateTime: string,
  shifts?: ShiftInfo[],
): T[] {
  return entries.filter((e) => {
    const s = toSupply(e);
    return supplyInRange(s.date, s.shift, startDateTime, endDateTime, shifts);
  });
}

/**
 * Gom các dòng cấp phát (đã lọc theo `filterSupplyByRange`), tách theo tên
 * hạng mục. Cột ngày là chính ngày nhập.
 *
 * Dùng chung cho sữa và chi phí phát sinh: hai khối phải lên bảng kê theo
 * đúng một cách, nếu mỗi bên tự gom thì lần sửa quy tắc đầu tiên sẽ làm chúng
 * lệch nhau.
 */
export function buildSupplySeries(entries: SupplyEntryLike[]): SupplySeries[] {
  const map = new Map<string, SupplySeries>();

  entries.forEach((e) => {
    const d = e.date.slice(0, 10);

    if (!map.has(e.itemName)) {
      map.set(e.itemName, {
        itemName: e.itemName,
        series: emptySeries(),
        byShift: emptyShiftSeries(),
        unitPrice: e.unitPrice,
        amount: 0,
      });
    }
    const row = map.get(e.itemName)!;
    addToSeries(row.series, d, e.quantity);
    addToSeries(row.byShift[e.shift].series, d, e.quantity);
    row.byShift[e.shift].amount += e.totalAmount;
    row.amount += e.totalAmount;
  });

  /* Đơn giá bình quân suy NGƯỢC từ tiền / số lượng, cho cả dòng và cho từng
     ca. Nhờ vậy "thành tiền = số lượng × đơn giá" vẫn đúng ở từng dòng con
     của bảng kê — công thức Excel dựng trên đúng đẳng thức đó. Ca không có
     lượt cấp nào thì mượn giá của cả dòng để ô đơn giá không trống hoác. */
  const avg = (amount: number, count: number, fallback: number) =>
    count > 0 ? amount / count : fallback;

  return Array.from(map.values())
    .map((row) => {
      const unitPrice = avg(row.amount, row.series.total, row.unitPrice);
      const byShift = { ...row.byShift };
      SUPPLY_SHIFT_ORDER.forEach((code) => {
        byShift[code] = {
          ...byShift[code],
          unitPrice: avg(
            byShift[code].amount,
            byShift[code].series.total,
            unitPrice,
          ),
        };
      });
      return { ...row, byShift, unitPrice };
    })
    .sort((a, b) => a.itemName.localeCompare(b.itemName, "vi"));
}

/* -------------------------------------------------------------------------
   Chi phí thuê nhân công
   -------------------------------------------------------------------------
   Nhà ăn thuê nhân công theo ĐỢT: một người, một khoảng ngày, một số tiền cho
   TRỌN khoảng đó. Bảng kê thì lọc một quãng bất kỳ, thường cắt ngang giữa
   đợt, nên tiền phải chia ra rồi ghép lại:

       tiền của phần giao = tiền cả đợt / số ngày làm việc CẢ ĐỢT
                          × số ngày làm việc của PHẦN GIAO

   Đợt nằm trọn trong khoảng lọc thì phần giao = cả đợt, hai vế triệt tiêu và
   ra đúng số tiền đã nhập — không có sai số làm tròn nào chen vào.

   KHOẢNG NGÀY LÀ NỬA MỞ [from, to) TRÊN TRỤC NGÀY LÀM VIỆC: ngày làm việc D
   chạy (D-1) 22:50 -> D 22:50, nên đợt lưu 26/07 -> 26/08 là đúng khoảng
   thời gian 25/07 22:50 -> 25/08 22:50 và gồm các ngày làm việc 26/07..25/08.
   Màn hình nhân công nhập và hiển thị hai mốc 22:50 đó
   (`laborBoundaryDateTime`), cơ sở dữ liệu giữ ngày làm việc. Nửa mở là điều
   kiện để hai đợt viết liền nhau — 25/07 22:50→25/08 22:50 rồi 25/08 22:50→
   25/09 22:50 — mà không ngày làm việc nào bị tính hai lần hay rơi mất. Mọi
   biên trong khối này đều theo quy ước đó, kể cả biên của khoảng lọc:
   `endDate` của bộ lọc là ngày CÓ tính, nên nó được cộng thêm một ngày để
   thành biên nửa mở.

   ĐÂY LÀ BẢN CÀI ĐẶT DUY NHẤT của phép chia đó. Bảng kê tháng, bảng phân bổ
   tiền ăn, bảng phân bổ theo bộ phận, bảng 12 tháng và mọi sheet Excel đều
   gọi vào đây — không nơi nào tự tính lại, nên không nơi nào lệch được.

   Ở bảng "Phân bổ theo BP", chi phí nhân công được CHIA ĐỀU cho các bộ phận
   người Việt, cùng cách với tiền sữa (`buildDeptAllocation`). Và nó chỉ có
   mặt trong tab Báo Cáo Chi Phí — không màn hình nào khác đọc khối này.
   ------------------------------------------------------------------------- */

/** Nhãn tiếng Việt của từng quy tắc đếm ngày làm việc. */
export const LABOR_WORKDAY_RULE_LABEL: Record<LaborWorkDayRule, string> = {
  ALL: "Tất cả các ngày theo lịch",
  MON_SAT: "Thứ 2 – Thứ 7 (trừ Chủ nhật)",
  MON_FRI: "Thứ 2 – Thứ 6",
};

export const LABOR_WORKDAY_RULES: LaborWorkDayRule[] = [
  "ALL",
  "MON_SAT",
  "MON_FRI",
];

/**
 * Quy tắc mặc định khi chưa từng bấm "Áp dụng" lần nào.
 *
 * Mọi ngày theo lịch: nhân công được thuê trọn khoảng thời gian chứ không
 * chấm công theo ngày, nên mẫu số dễ đối chiếu bằng tay nhất và không phụ
 * thuộc vào một lịch nghỉ mà hệ thống không có.
 */
export const DEFAULT_LABOR_WORKDAY_RULE: LaborWorkDayRule = "ALL";

/** Thứ trong tuần được tính là ngày làm việc (0 = Chủ nhật). */
const WORKDAY_WEEKDAYS: Record<LaborWorkDayRule, number[]> = {
  ALL: [0, 1, 2, 3, 4, 5, 6],
  MON_SAT: [1, 2, 3, 4, 5, 6],
  MON_FRI: [1, 2, 3, 4, 5],
};

/**
 * 'YYYY-MM-DD' -> số ngày kể từ 1970-01-01.
 *
 * Dựng qua `Date.UTC` chứ không `new Date(chuỗi)`: chuỗi ngày trần được đọc
 * theo giờ địa phương ở một số môi trường và lệch đúng một ngày quanh mốc
 * đổi giờ — cùng lý do với `gapMinutes` trong mealEngine.
 */
function dayNumber(date: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** 0 = Chủ nhật. 1970-01-01 (số ngày 0) là thứ Năm, nên lệch 4. */
const weekdayOfDayNumber = (n: number) => (((n + 4) % 7) + 7) % 7;

export const isLaborWorkDay = (date: string, rule: LaborWorkDayRule) =>
  WORKDAY_WEEKDAYS[rule].includes(weekdayOfDayNumber(dayNumber(date)));

/**
 * Số ngày làm việc trong [fromInclusive, toExclusive).
 *
 * Đếm bằng số học tuần chứ không duyệt từng ngày: bảng 12 tháng gọi hàm này
 * hàng trăm lần và một đợt thuê có thể dài cả năm.
 */
export function countLaborWorkDays(
  fromInclusive: string,
  toExclusive: string,
  rule: LaborWorkDayRule,
): number {
  const a = dayNumber(fromInclusive);
  const b = dayNumber(toExclusive);
  if (b <= a) return 0;

  const allowed = WORKDAY_WEEKDAYS[rule];
  const span = b - a;
  let count = Math.floor(span / 7) * allowed.length;

  const rest = span % 7;
  for (let i = 0; i < rest; i++) {
    if (allowed.includes(weekdayOfDayNumber(a + i))) count += 1;
  }
  return count;
}

/**
 * Biên NGÀY LÀM VIỆC của đợt -> mốc THỜI ĐIỂM mà người dùng nhìn thấy.
 *
 * Ngày làm việc D bắt đầu lúc (D-1) 22:50, nên biên "D" của một đợt chính là
 * thời điểm (D-1) 22:50: đợt lưu 26/07 -> 26/08 hiển thị 25/07 22:50 ->
 * 25/08 22:50. 22:50 là giờ bắt đầu ca vắt nửa đêm (`workDayStartTime`).
 */
export function laborBoundaryDateTime(
  workDay: string,
  shifts?: ShiftInfo[],
): string {
  return `${addDays(workDay, -1)} ${workDayStartTime(shifts).slice(0, 5)}`;
}

/**
 * Ngược của `laborBoundaryDateTime`: người dùng chọn NGÀY của mốc 22:50,
 * cơ sở dữ liệu lưu ngày làm việc bắt đầu từ mốc đó, tức ngày hôm sau.
 */
export const laborWorkDayFromBoundary = (boundaryDate: string) =>
  addDays(boundaryDate, 1);

/** Ngược lại nữa: biên ngày làm việc -> NGÀY của mốc 22:50 cho ô nhập. */
export const laborBoundaryDate = (workDay: string) => addDays(workDay, -1);

/**
 * Đợt thuê (nửa mở, theo ngày làm việc) phủ TRỌN kỳ của một tháng.
 *
 * Ô "Tháng" của màn hình nhân công gọi hàm này để tự điền hai mốc: tháng
 * 01/2026 = kỳ 25/12/2025 22:50 -> 25/01/2026 22:50 chạm các ngày làm việc
 * 26/12/2025..25/01/2026, nên đợt là [26/12/2025, 26/01/2026). Đợt đó cắt theo cùng kỳ ở bảng 12 tháng (`withLaborCost`)
 * thì trùng khít và ra đúng số tiền đã nhập.
 */
export function laborRangeForPeriod(
  period: Pick<CostMonthPeriod, "fromDateTime" | "toDateTime">,
  shifts?: ShiftInfo[],
): { effectiveFrom: string; effectiveTo: string } | null {
  const r = costWorkDayRange(period.fromDateTime, period.toDateTime, shifts);
  if (r.to < r.from) return null;
  return { effectiveFrom: r.from, effectiveTo: addDays(r.to, 1) };
}

/** Một đợt thuê nhân công đã áp dụng, rút gọn về đúng cái phép chia cần. */
export interface LaborPeriodInput {
  workerName: string;
  /** 'YYYY-MM-DD', ngày này ĐƯỢC tính. */
  effectiveFrom: string;
  /** 'YYYY-MM-DD', ngày này KHÔNG được tính. */
  effectiveTo: string;
  amount: number;
}

/**
 * PHẦN GIAO giữa một đợt thuê và khoảng lọc, kèm toàn bộ số liệu để người
 * đọc dựng lại được phép tính bằng tay.
 */
export interface LaborSegment {
  key: string;
  workerName: string;
  /* --- Khoảng của cả ĐỢT: mẫu số của phép chia --- */
  periodFrom: string;
  /** Nửa mở — ngày này không thuộc đợt. */
  periodTo: string;
  periodAmount: number;
  periodWorkDays: number;
  /* --- Phần giao với khoảng lọc: tử số --- */
  from: string;
  /** Nửa mở — ngày này không thuộc phần giao. */
  toExclusive: string;
  /** Ngày CUỐI CÙNG thật sự được tính, để hiển thị cho người đọc. */
  toInclusive: string;
  workDays: number;
  /** = periodAmount / periodWorkDays. KHÔNG làm tròn — xem chú thích dưới. */
  dailyRate: number;
  amount: number;
  /** Đợt nằm trọn trong khoảng lọc: tiền đúng bằng tiền đã nhập cho đợt. */
  isFullPeriod: boolean;
}

/**
 * Cắt các đợt thuê theo khoảng lọc và chia tiền cho từng phần giao.
 *
 * `startDate` / `endDate` là biên NGÀY của bộ lọc và cả hai đều được tính
 * (đúng quy ước của cả ứng dụng), nên `endDate` được cộng một ngày để thành
 * biên nửa mở.
 *
 * Xử lý được mọi thế nằm của hai khoảng vì chỉ làm đúng một việc: lấy giao
 * `[max(đầu), min(cuối))`, rỗng thì bỏ. Lọc nằm trọn trong đợt, lọc trùm cả
 * đợt, lọc chờm một đầu, lọc phủ nhiều đợt liên tiếp, nhiều người cùng một
 * khoảng — tất cả đều là cùng một phép giao đó, không có nhánh riêng nào.
 *
 * `dailyRate` KHÔNG được làm tròn: nó là số bị nhân trong công thức Excel
 * ("thành tiền = số ngày × đơn giá/ngày"), làm tròn ở đây là bảng kê lệch vài
 * trăm đồng và hai bảng thôi khớp nhau — cùng quy tắc với đơn giá bình quân
 * của sữa. Chỗ hiển thị mới là chỗ làm tròn.
 */
export function buildLaborSegments(
  periods: LaborPeriodInput[],
  startDate: string,
  endDate: string,
  rule: LaborWorkDayRule,
): LaborSegment[] {
  const filterFrom = startDate;
  const filterTo = addDays(endDate, 1); // nửa mở

  const out: LaborSegment[] = [];

  periods.forEach((p, index) => {
    const periodFrom = p.effectiveFrom.slice(0, 10);
    const periodTo = p.effectiveTo.slice(0, 10);
    if (periodTo <= periodFrom) return;

    const from = periodFrom > filterFrom ? periodFrom : filterFrom;
    const toExclusive = periodTo < filterTo ? periodTo : filterTo;
    if (toExclusive <= from) return;

    const periodWorkDays = countLaborWorkDays(periodFrom, periodTo, rule);
    const workDays = countLaborWorkDays(from, toExclusive, rule);

    /* Đợt không có ngày làm việc nào (vd đợt chỉ gồm một Chủ nhật với quy tắc
       trừ Chủ nhật) thì không có gì để chia — trả 0 thay vì chia cho 0 rồi
       đẩy một ô NaN ra bảng kê. */
    const dailyRate = periodWorkDays > 0 ? p.amount / periodWorkDays : 0;
    const isFullPeriod = from === periodFrom && toExclusive === periodTo;

    out.push({
      key: `LABOR_${index}_${p.workerName}_${periodFrom}`,
      workerName: p.workerName,
      periodFrom,
      periodTo,
      periodAmount: p.amount,
      periodWorkDays,
      from,
      toExclusive,
      toInclusive: addDays(toExclusive, -1),
      workDays,
      dailyRate,
      /* Trọn đợt thì lấy thẳng số tiền đã nhập: chia rồi nhân lại đúng bằng
         nó về mặt toán học, nhưng số thực dấu phẩy động có thể lệch vài đồng
         và người dùng sẽ thấy 7.999.999 ở chỗ họ gõ 8.000.000. */
      amount: isFullPeriod ? p.amount : dailyRate * workDays,
      isFullPeriod,
    });
  });

  return out.sort(
    (a, b) =>
      a.workerName.localeCompare(b.workerName, "vi") ||
      a.from.localeCompare(b.from),
  );
}

/** Số tiền gọn trong một ô chú thích: "7.000.000". Chỉ để đọc. */
const formatLaborMoney = (n: number) =>
  Math.round(n).toLocaleString("vi-VN");

/** Tổng tiền nhân công của các phần giao. */
export const laborTotalAmount = (segments: LaborSegment[]) =>
  segments.reduce((acc, s) => acc + s.amount, 0);

/** Tổng số ngày làm việc được tính tiền. */
export const laborTotalWorkDays = (segments: LaborSegment[]) =>
  segments.reduce((acc, s) => acc + s.workDays, 0);

/**
 * Các NGÀY LÀM VIỆC của một phần giao, để bảng kê tháng có ô ở đúng cột ngày.
 *
 * Mỗi ngày làm việc mang giá trị 1, nên TOTAL của dòng = số ngày được tính
 * tiền và "AMOUNT = TOTAL × ĐƠN GIÁ" vẫn đúng — công thức Excel dựng trên
 * đúng đẳng thức đó.
 */
export function laborSegmentSeries(
  segment: LaborSegment,
  rule: LaborWorkDayRule,
): DaySeries {
  const s = emptySeries();
  for (let d = segment.from; d < segment.toExclusive; d = addDays(d, 1)) {
    if (isLaborWorkDay(d, rule)) addToSeries(s, d, 1);
  }
  return s;
}

/* -------------------------------------------------------------------------
   Bảng chi tiết một ca: nhân viên x ngày
   ------------------------------------------------------------------------- */

export interface ShiftPivotRow {
  userId: string;
  userName: string;
  department: string;
  largeDept: string;
  byDay: Record<string, number>;
  total: number;
}

export interface ShiftPivot {
  rows: ShiftPivotRow[];
  /** Chân bảng tách theo bộ phận lớn: mỗi bộ phận một dòng. */
  deptRows: {
    largeDept: string;
    byDay: Record<string, number>;
    total: number;
  }[];
  dayTotals: Record<string, number>;
  grandTotal: number;
  /**
   * Suất nhập tay của ca này, theo ngày. Không có nhân sự cụ thể nên không
   * nằm trong `rows`, nhưng CÓ trong `dayTotals` / `grandTotal` và có một
   * dòng riêng ở chân bảng — nếu bỏ ra thì tổng của bảng chi tiết ca sẽ nhỏ
   * hơn tổng của bảng kê tháng đúng bằng số suất nhập tay.
   */
  manualByDay: Record<string, number>;
  manualTotal: number;
}

/** Nhãn dòng nhập tay ở chân bảng chi tiết ca. */
export const MANUAL_PIVOT_LABEL = "Nhập thủ công (không quẹt thẻ)";

/** Dựng bảng nhân viên x ngày cho đúng một ca. */
export function buildShiftPivot(
  rows: ClassifiedLog[],
  manualMeals: CountedManualMeal[],
  shiftCode: ShiftCode,
): ShiftPivot {
  const byUser = new Map<string, ShiftPivotRow>();
  const byDept = new Map<
    string,
    { largeDept: string; byDay: Record<string, number>; total: number }
  >();
  const dayTotals: Record<string, number> = {};
  let grandTotal = 0;

  rows.forEach((r) => {
    if (r.log.shiftCode !== shiftCode) return;

    const { userId, userName, department } = r.log;
    if (!byUser.has(userId)) {
      byUser.set(userId, {
        userId,
        userName,
        department,
        largeDept: r.largeDept,
        byDay: {},
        total: 0,
      });
    }
    const row = byUser.get(userId)!;
    row.byDay[r.reportDate] = (row.byDay[r.reportDate] ?? 0) + 1;
    row.total += 1;

    if (!byDept.has(r.largeDept)) {
      byDept.set(r.largeDept, { largeDept: r.largeDept, byDay: {}, total: 0 });
    }
    const dept = byDept.get(r.largeDept)!;
    dept.byDay[r.reportDate] = (dept.byDay[r.reportDate] ?? 0) + 1;
    dept.total += 1;

    dayTotals[r.reportDate] = (dayTotals[r.reportDate] ?? 0) + 1;
    grandTotal += 1;
  });

  /* Suất nhập tay của ca này: vào tổng theo ngày và vào dòng bộ phận lớn
     tương ứng, nhưng không vào danh sách nhân viên vì không gắn với ai. */
  const manualByDay: Record<string, number> = {};
  let manualTotal = 0;

  manualMeals.forEach((r) => {
    if (r.shiftCode !== shiftCode) return;

    /* Cùng khoá cột ngày với lượt quẹt ở trên: `reportDate`, tức chỉ ca đêm
       CA1 mới nhảy sang ngày hôm sau. */
    manualByDay[r.reportDate] = (manualByDay[r.reportDate] ?? 0) + r.quantity;
    manualTotal += r.quantity;

    if (!byDept.has(r.largeDept)) {
      byDept.set(r.largeDept, { largeDept: r.largeDept, byDay: {}, total: 0 });
    }
    const dept = byDept.get(r.largeDept)!;
    dept.byDay[r.reportDate] = (dept.byDay[r.reportDate] ?? 0) + r.quantity;
    dept.total += r.quantity;

    dayTotals[r.reportDate] = (dayTotals[r.reportDate] ?? 0) + r.quantity;
    grandTotal += r.quantity;
  });

  const collator = new Intl.Collator("vi");

  return {
    rows: Array.from(byUser.values()).sort(
      (a, b) =>
        collator.compare(a.largeDept, b.largeDept) ||
        collator.compare(a.userName, b.userName) ||
        a.userId.localeCompare(b.userId),
    ),
    deptRows: Array.from(byDept.values()).sort((a, b) =>
      collator.compare(a.largeDept, b.largeDept),
    ),
    dayTotals,
    grandTotal,
    manualByDay,
    manualTotal,
  };
}

/* -------------------------------------------------------------------------
   Bảng kê "Thống kê suất ăn tháng"
   -------------------------------------------------------------------------
   Dựng ở đây chứ không nằm trong component, vì cả bảng trên web lẫn sheet
   trong file Excel tổng hợp đều phải đọc CHUNG một bộ dòng — nếu mỗi nơi tự
   dựng lại thì hai bản sẽ lệch nhau ngay lần sửa quy tắc đầu tiên.
   `tone` / `groupTone` là TÊN SẮC THÁI, không phải class Tailwind: bảng web
   ánh xạ sang class, bộ xuất Excel ánh xạ sang mã màu ARGB. */

export type StatRowTone =
  | "korea"
  | "viet"
  | "sub"
  | "total"
  | "birthday"
  | "milk"
  | "extra"
  | "labor";

export type StatGroupTone =
  | "korea"
  | "viet"
  | "milk"
  | "extra"
  | "labor"
  | "birthday";

export interface StatRow {
  key: string;
  /** Ô "HẠNG MỤC" gộp dòng — chỉ đặt ở dòng đầu của nhóm. */
  groupLabel?: string;
  groupSpan?: number;
  groupTone?: StatGroupTone;
  label: string;
  /** Chú thích nhỏ dưới nhãn: loại suất quyết định đơn giá của dòng. */
  subLabel?: string;
  /** Bỏ trống thì các ô ngày để trống (dòng không có số liệu theo ngày). */
  series?: DaySeries;
  quantity: number;
  unitPrice: number | null;
  amount: number;
  note?: string;
  tone: StatRowTone;
}

const mergeSeries = (a: DaySeries, b: DaySeries): DaySeries => {
  const merged = emptySeries();
  [a, b].forEach((s) =>
    Object.entries(s.byDay).forEach(([d, v]) => {
      merged.byDay[d] = (merged.byDay[d] ?? 0) + v;
    }),
  );
  merged.total = a.total + b.total;
  return merged;
};

export function buildMonthlyStatRows(
  classified: ClassifiedLog[],
  pricing: MealPricing,
  shiftCategories: ShiftCategoryLookup,
  manualMeals: CountedManualMeal[],
  /* Sữa / chi phí phát sinh ĐÃ LỌC theo khoảng lọc — `filterSupplyByRange`. */
  milkEntries: DailyMilkEntry[],
  extraCosts: ExtraCostEntry[],
  /* Phần giao giữa các đợt thuê nhân công đã ÁP DỤNG và khoảng lọc. Rỗng khi
     chưa từng bấm "Áp dụng" — khi đó khối này không xuất hiện. */
  laborSegments: LaborSegment[] = [],
  laborWorkDayRule: LaborWorkDayRule = DEFAULT_LABOR_WORKDAY_RULE,
): StatRow[] {
  const out: StatRow[] = [];

  /* Ca ăn có thể nằm ngoài 6 khung giờ ('Khác'); vẫn phải có dòng, nếu
     không thì tiền của những lượt đó biến mất khỏi bảng kê. */
  const blockShifts: ShiftCode[] = [...SHIFT_ORDER, "Khác"];

  /* ---- Nhóm 한국 Korea: mọi ca của nhân sự KR ------------------------
     Đơn giá lấy theo loại suất đã gán cho (ca, 'KR') — CA3/CA4 thường là
     cơm Hàn 65.000, các ca còn lại mỳ Hàn 30.000. */
  const koreaRows: StatRow[] = blockShifts
    .map((code) => {
      const category = classifyMeal(code, true, false, shiftCategories);
      const unitPrice = pricing[category];
      const punches = seriesOf(
        classified,
        (r) => r.log.shiftCode === code && r.staffType === "KR",
      );
      /* Suất Hàn nhập tay CỘNG THẲNG vào dòng ca, không tách dòng "Ký số"
         như khối người Việt: nhà ăn đối chiếu chữ ký trên sổ cho phần người
         Việt, còn phần người Hàn chỉ cần đúng số suất theo ca và theo ngày. */
      const manual = manualSeries(manualMeals, code, "KR");
      const series = manual.total > 0 ? mergeSeries(punches, manual) : punches;

      return {
        key: `KR_${code}`,
        label: reportShiftLabel(code),
        subLabel: MEAL_CATEGORY_META[category].label,
        series,
        quantity: series.total,
        unitPrice,
        amount: series.total * unitPrice,
        tone: "korea" as StatRowTone,
      };
    })
    /* Dòng 'Khác' chỉ hiện khi thật sự có lượt quẹt ngoài khung giờ. */
    .filter((r) => r.key !== "KR_Khác" || r.quantity > 0);

  koreaRows.push({
    key: "KR_TOTAL",
    label: "TOTAL",
    series: koreaRows.reduce(
      (acc, r) => mergeSeries(acc, r.series ?? emptySeries()),
      emptySeries(),
    ),
    quantity: koreaRows.reduce((acc, r) => acc + r.quantity, 0),
    /* Khối này trộn cơm Hàn với mỳ Hàn nên không có một đơn giá chung. */
    unitPrice: null,
    amount: koreaRows.reduce((acc, r) => acc + r.amount, 0),
    tone: "total",
  });

  koreaRows[0].groupLabel = "한국 / Người Hàn";
  koreaRows[0].groupSpan = koreaRows.length;
  koreaRows[0].groupTone = "korea";
  out.push(...koreaRows);

  /* ---- Nhóm 베트남 Việt Nam: mỗi ca một dòng + một dòng "Ký số" ------ */
  const vietRows: StatRow[] = [];

  blockShifts.forEach((code) => {
    /* Đơn giá của ca = giá loại suất đã gán cho (ca, 'VN') trong tab Cấu
       Hình Giá Suất Ăn. Đọc thẳng từ bảng gán chứ không suy ngược từ log:
       ca không có lượt nào, hoặc ca mà cả ngày đều là suất sinh nhật, vẫn
       phải ra đúng đơn giá. */
    const category = classifyMeal(code, false, false, shiftCategories);
    const unitPrice = pricing[category];

    /* Suất sinh nhật đã tách khỏi đây: category của nó là VN_SINHNHAT. */
    const series = seriesOf(
      classified,
      (r) =>
        r.log.shiftCode === code &&
        r.staffType === "VN" &&
        r.category !== "VN_SINHNHAT",
    );
    /* Suất ký sổ rơi vào ngày sinh nhật đã sang khối "Suất ăn đặc biệt SN"
       với đơn giá của ngày đó — đếm lại ở đây là tính tiền hai lần. */
    const manual = manualSeries(manualMeals, code, "VN", notBirthdayManual);

    if (code === "Khác" && series.total === 0 && manual.total === 0) return;

    vietRows.push({
      key: `VN_${code}`,
      label: reportShiftLabel(code),
      subLabel: MEAL_CATEGORY_META[category].label,
      series,
      quantity: series.total,
      unitPrice,
      amount: series.total * unitPrice,
      tone: "viet",
    });

    vietRows.push({
      key: `VN_${code}_KYSO`,
      label: "Ký số",
      series: manual,
      quantity: manual.total,
      unitPrice,
      amount: manual.total * unitPrice,
      tone: "sub",
    });
  });

  vietRows.push({
    key: "VN_TOTAL",
    label: "TOTAL",
    series: vietRows.reduce(
      (acc, r) => mergeSeries(acc, r.series ?? emptySeries()),
      emptySeries(),
    ),
    quantity: vietRows.reduce((acc, r) => acc + r.quantity, 0),
    unitPrice: null,
    amount: vietRows.reduce((acc, r) => acc + r.amount, 0),
    tone: "total",
  });

  vietRows[0].groupLabel = "베트남 / Người Việt";
  vietRows[0].groupSpan = vietRows.length;
  vietRows[0].groupTone = "viet";
  out.push(...vietRows);

  /* ---- Sữa, rồi Chi phí phát sinh ngay dưới --------------------------
     Hai khối cùng là hàng cấp phát nên dựng bằng một hàm chung; thứ tự cố
     định Sữa trước, Chi phí phát sinh sau, đúng như bảng kê gửi nhà ăn.

     MỖI CA MỘT DÒNG CON: "Ca ngày" và "Ca đêm" là hai giá trị của cột DATE,
     y như tên ca ở hai khối suất ăn phía trên — cột ngày KHÔNG tách đôi nữa.
     Nhờ vậy dải cột ngày của cả bảng là một tầng phẳng: web, CSV và Excel
     cùng đọc `days`, không nơi nào phải tự dựng cột con. Hai dòng con luôn
     hiện đủ kể cả khi một ca không cấp gì, để bố cục của mọi hạng mục giống
     nhau và người đọc thấy ngay "ca đó không cấp" thay vì phải đoán. */
  const pushSupplyBlock = (
    keyPrefix: string,
    groupLabel: string,
    tone: Extract<StatRowTone, "milk" | "extra">,
    rows: SupplySeries[],
  ) => {
    if (rows.length === 0) {
      out.push({
        key: `${keyPrefix}_NONE`,
        groupLabel,
        groupSpan: 1,
        groupTone: tone,
        label: "—",
        series: emptySeries(),
        quantity: 0,
        unitPrice: null,
        amount: 0,
        tone,
      });
      return;
    }

    const span = rows.length * SUPPLY_SHIFT_ORDER.length;
    let first = true;

    rows.forEach((m) => {
      SUPPLY_SHIFT_ORDER.forEach((code) => {
        const shift = m.byShift[code];
        out.push({
          key: `${keyPrefix}_${m.itemName}_${code}`,
          groupLabel: first ? groupLabel : undefined,
          groupSpan: first ? span : undefined,
          groupTone: first ? tone : undefined,
          label: SUPPLY_SHIFT_LABEL[code],
          /* Tên hạng mục xuống dòng nhỏ dưới tên ca — đúng chỗ mà khối suất
             ăn để tên loại suất, nên một hạng mục thứ hai (kem, quà lễ...)
             vẫn phân biệt được với sữa mà không cần thêm cột. */
          subLabel: "", //m.itemName,
          series: shift.series,
          quantity: shift.series.total,
          unitPrice: shift.unitPrice,
          amount: shift.amount,
          tone,
        });
        first = false;
      });
    });
  };

  pushSupplyBlock(
    "MILK",
    "Sữa",
    "milk",
    buildSupplySeries(milkEntries.map(milkAsSupply)),
  );

  pushSupplyBlock(
    "EXTRA",
    "Chi phí phát sinh",
    "extra",
    buildSupplySeries(extraCosts.map(extraAsSupply)),
  );

  /* ---- Chi phí thuê nhân công, ngay dưới khối Chi phí phát sinh ------
     MỘT DÒNG CHO MỖI (người × đợt) rơi vào khoảng lọc: một người thuê nhiều
     đợt liên tiếp với giá khác nhau thì mỗi đợt là một đơn giá/ngày khác
     nhau, gộp lại thì cột ĐƠN GIÁ không còn nghĩa gì.

     Ô ngày mang 1 cho mỗi NGÀY LÀM VIỆC được tính tiền, nên TOTAL của dòng =
     số ngày công và "AMOUNT = TOTAL × ĐƠN GIÁ" vẫn đúng — đúng đẳng thức mà
     công thức trong file Excel dựng lên. Cột NOTE ghi trọn phép tính để người
     đọc dựng lại được bằng tay mà không cần mở màn hình nào khác. */
  if (laborSegments.length > 0) {
    laborSegments.forEach((seg, i) => {
      out.push({
        key: seg.key,
        groupLabel: i === 0 ? "Chi phí nhân công" : undefined,
        groupSpan: i === 0 ? laborSegments.length : undefined,
        groupTone: i === 0 ? "labor" : undefined,
        label: seg.workerName,
        subLabel: `${dayMonthLabel(seg.from)} → ${dayMonthLabel(seg.toInclusive)}`,
        series: laborSegmentSeries(seg, laborWorkDayRule),
        quantity: seg.workDays,
        unitPrice: seg.dailyRate,
        amount: seg.amount,
        note: seg.isFullPeriod
          ? `Trọn đợt ${dayMonthLabel(seg.periodFrom)} → ${dayMonthLabel(addDays(seg.periodTo, -1))}`
          : `${formatLaborMoney(seg.periodAmount)} / ${seg.periodWorkDays} ngày × ${seg.workDays} ngày`,
        tone: "labor",
      });
    });
  }

  /* ---- Suất ăn đặc biệt (sinh nhật) ---------------------------------
     MỘT DÒNG CHO MỖI ĐƠN GIÁ. Đơn giá suất sinh nhật là của TỪNG NGÀY trong
     tab "Cấu Hình Sinh Nhật", không phải một con số chung trong Cấu Hình Giá
     Suất Ăn, nên một khoảng lọc trải qua hai lần đổi giá phải ra hai dòng —
     gộp lại thì cột ĐƠN GIÁ không biết ghi số nào và AMOUNT sai theo. Các
     ngày cùng giá vẫn nằm chung một dòng, cột NOTE liệt kê ra.

     Suất ký sổ của người Việt trong ngày sinh nhật gộp thẳng vào đây (xem
     `classifyManualEntries`), nên dòng "Ký số" của ca ở khối trên đã loại
     chúng ra. */
  const birthdayBuckets = buildBirthdayBuckets(classified, manualMeals);

  if (birthdayBuckets.length === 0) {
    /* Kỳ không có suất sinh nhật nào vẫn giữ một dòng rỗng: bảng kê gửi nhà
       ăn luôn có đủ hạng mục, thiếu dòng người đọc lại tưởng bị cắt mất. */
    out.push({
      key: "SINH_NHAT",
      groupLabel: "Suất ăn đặc biệt SN",
      groupSpan: 1,
      groupTone: "birthday",
      label: "",
      series: emptySeries(),
      quantity: 0,
      unitPrice: pricing.VN_SINHNHAT,
      amount: 0,
      tone: "birthday",
    });
    return out;
  }

  birthdayBuckets.forEach((b, i) => {
    out.push({
      key: `SINH_NHAT_${b.unitPrice}`,
      ...(i === 0
        ? {
            groupLabel: "Suất ăn đặc biệt SN",
            groupSpan: birthdayBuckets.length,
            groupTone: "birthday" as StatGroupTone,
          }
        : {}),
      label: "",
      series: b.series,
      quantity: b.series.total,
      unitPrice: b.unitPrice,
      amount: b.series.total * b.unitPrice,
      note: b.dates.map(dayMonthLabel).join(", "),
      tone: "birthday",
    });
  });

  return out;
}

/** Suất sinh nhật của MỘT mức đơn giá: số theo ngày kê + các ngày sinh nhật. */
export interface BirthdayBucket {
  unitPrice: number;
  series: DaySeries;
  /** Ngày trong SA_BirthdayConfig sinh ra số này — cột NOTE của bảng kê. */
  dates: string[];
}

/**
 * Gom suất sinh nhật (lượt quẹt + suất ký sổ) theo ĐƠN GIÁ.
 *
 * Nguồn duy nhất của khối "Suất ăn đặc biệt SN" trên web, trong CSV và trong
 * sheet Excel — và của cột suất sinh nhật ở bảng phân bổ tiền ăn, để hai bảng
 * không thể ra hai con số.
 */
export function buildBirthdayBuckets(
  classified: ClassifiedLog[],
  manualMeals: CountedManualMeal[],
): BirthdayBucket[] {
  const byPrice = new Map<number, { series: DaySeries; dates: Set<string> }>();

  const bump = (
    unitPrice: number,
    reportDate: string,
    birthdayDate: string | undefined,
    qty: number,
  ) => {
    if (!byPrice.has(unitPrice)) {
      byPrice.set(unitPrice, { series: emptySeries(), dates: new Set() });
    }
    const bucket = byPrice.get(unitPrice)!;
    addToSeries(bucket.series, reportDate, qty);
    if (birthdayDate) bucket.dates.add(birthdayDate);
  };

  classified.forEach((r) => {
    if (r.category !== "VN_SINHNHAT") return;
    bump(r.unitPrice, r.reportDate, r.birthdayDate, 1);
  });

  manualMeals.forEach((r) => {
    if (r.category !== "VN_SINHNHAT") return;
    bump(r.unitPrice, r.reportDate, r.birthdayDate, r.quantity);
  });

  return Array.from(byPrice.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([unitPrice, v]) => ({
      unitPrice,
      series: v.series,
      dates: Array.from(v.dates).sort(),
    }));
}

/** Tổng số suất sinh nhật của cả kỳ. */
export const birthdayTotalCount = (buckets: BirthdayBucket[]) =>
  buckets.reduce((acc, b) => acc + b.series.total, 0);

/** Tổng tiền suất sinh nhật của cả kỳ. */
export const birthdayTotalAmount = (buckets: BirthdayBucket[]) =>
  buckets.reduce((acc, b) => acc + b.series.total * b.unitPrice, 0);

/** Tổng thanh toán: bỏ dòng TOTAL của từng nhóm để không cộng đôi. */
export const statRowsGrandTotal = (rows: StatRow[]) =>
  rows.filter((r) => r.tone !== "total").reduce((acc, r) => acc + r.amount, 0);

/* -------------------------------------------------------------------------
   Bảng "Phân bổ tiền ăn"
   ------------------------------------------------------------------------- */

export type AllocationTone =
  | "korea"
  | "koreaSub"
  | "viet"
  | "milk"
  | "extra"
  | "labor"
  | "birthday";

export interface AllocationColumn {
  key: string;
  /** Nhóm cột ở hàng tiêu đề trên cùng. */
  group: string;
  label: string;
  quantity: number;
  unitPrice: number;
  tone: AllocationTone;
}

export function buildAllocationColumns(
  classified: ClassifiedLog[],
  pricing: MealPricing,
  shiftCategories: ShiftCategoryLookup,
  manualMeals: CountedManualMeal[],
  /* Sữa / chi phí phát sinh ĐÃ LỌC theo khoảng lọc — `filterSupplyByRange`. */
  milkEntries: DailyMilkEntry[],
  extraCosts: ExtraCostEntry[],
  laborSegments: LaborSegment[] = [],
): AllocationColumn[] {
  const cols: AllocationColumn[] = [];

  /* Suất Hàn nhập tay đã cộng vào dòng ca của bảng kê tháng, nên ở đây cũng
     phải cộng vào đúng cột loại suất — nếu không, tổng của hai bảng lệch
     nhau đúng bằng số suất Hàn nhập tay. Gom theo loại suất mà cặp (ca, KR)
     đang được gán, giống hệt cách bảng kê tháng chọn đơn giá cho dòng ca. */
  const manualKorean = new Map<MealCategory, number>();
  [...SHIFT_ORDER, "Khác" as ShiftCode].forEach((code) => {
    const total = manualSeries(manualMeals, code, "KR").total;
    if (total === 0) return;
    const category = classifyMeal(code, true, false, shiftCategories);
    manualKorean.set(category, (manualKorean.get(category) ?? 0) + total);
  });

  const comHan = seriesOf(classified, (r) => r.category === "KO_COM");
  cols.push({
    key: "KO_COM",
    group: "Người Hàn",
    label: "Cơm Hàn",
    quantity: comHan.total + (manualKorean.get("KO_COM") ?? 0),
    unitPrice: pricing.KO_COM,
    tone: "korea",
  });

  const myHan = seriesOf(classified, (r) => r.category === "KO_MY");
  cols.push({
    key: "KO_MY",
    group: "Người Hàn",
    label: "Mì Hàn",
    quantity: myHan.total + (manualKorean.get("KO_MY") ?? 0),
    unitPrice: pricing.KO_MY,
    tone: "koreaSub",
  });

  const vnShifts: ShiftCode[] = [...SHIFT_ORDER, "Khác"];
  vnShifts.forEach((code) => {
    const series = seriesOf(
      classified,
      (r) =>
        r.log.shiftCode === code &&
        r.staffType === "VN" &&
        r.category !== "VN_SINHNHAT",
    );
    /* Ký số của cùng ca tính chung cột với ca đó, giống bảng kê Excel —
       trừ suất ký sổ ngày sinh nhật, đã có cột "Suất SN" riêng. */
    const manual = manualSeries(manualMeals, code, "VN", notBirthdayManual);

    // Ca ngoài khung giờ chỉ hiện khi thật sự có lượt quẹt.
    if (code === "Khác" && series.total === 0 && manual.total === 0) return;

    cols.push({
      key: `VN_${code}`,
      group: "Người Việt",
      label: reportShiftLabel(code),
      quantity: series.total + manual.total,
      unitPrice: pricing[classifyMeal(code, false, false, shiftCategories)],
      tone: "viet",
    });
  });

  const milk = buildSupplySeries(milkEntries.map(milkAsSupply));
  const milkQty = milk.reduce((acc, m) => acc + m.series.total, 0);
  const milkAmount = milk.reduce((acc, m) => acc + m.amount, 0);
  cols.push({
    key: "MILK",
    group: "Sữa",
    label: "Sữa Vinamilk",
    quantity: milkQty,
    unitPrice: milkQty > 0 ? milkAmount / milkQty : 0,
    tone: "milk",
  });

  /* Chi phí phát sinh gộp thành MỘT cột: tên hạng mục là chữ tự do nên tách
     ra thì bảng này phình theo số hạng mục người dùng đặt. Chi tiết từng
     hạng mục đã có ở bảng "Thống kê suất ăn tháng". */
  const extra = buildSupplySeries(extraCosts.map(extraAsSupply));
  const extraQty = extra.reduce((acc, m) => acc + m.series.total, 0);
  const extraAmount = extra.reduce((acc, m) => acc + m.amount, 0);
  if (extraQty > 0) {
    cols.push({
      key: "EXTRA",
      group: "Phát sinh",
      label: "Chi phí phát sinh",
      quantity: extraQty,
      unitPrice: extraAmount / extraQty,
      tone: "extra",
    });
  }

  /* Chi phí nhân công gộp thành MỘT cột, ngay sau chi phí phát sinh: số
     lượng là NGÀY CÔNG được tính tiền, đơn giá là tiền bình quân một ngày
     công của cả khoảng lọc. Suy ngược đơn giá từ tiền / ngày công (không làm
     tròn) nên "thành tiền = số lượng × đơn giá" vẫn đúng dù mỗi người mỗi
     đợt một giá — cùng cách làm với cột Sữa. Chi tiết từng người từng đợt đã
     có ở bảng "Thống kê suất ăn tháng". */
  const laborDays = laborTotalWorkDays(laborSegments);
  const laborAmount = laborTotalAmount(laborSegments);
  if (laborDays > 0 || laborAmount > 0) {
    cols.push({
      key: "LABOR",
      group: "Nhân công",
      label: "Chi phí nhân công",
      quantity: laborDays,
      unitPrice: laborDays > 0 ? laborAmount / laborDays : 0,
      tone: "labor",
    });
  }

  /* Suất sinh nhật gộp thành MỘT cột dù mỗi ngày một giá: bảng này chỉ có ba
     dòng Số lượng / Đơn giá / Thành tiền nên không tách được. Đơn giá là giá
     BÌNH QUÂN suy ngược từ tiền / số suất và KHÔNG làm tròn, nên
     "số lượng × đơn giá" vẫn ra đúng tổng tiền của khối sinh nhật trong bảng
     kê tháng — cùng cách làm với cột Sữa và cột Nhân công. */
  const birthdayBuckets = buildBirthdayBuckets(classified, manualMeals);
  const birthdayQty = birthdayTotalCount(birthdayBuckets);
  const birthdayAmount = birthdayTotalAmount(birthdayBuckets);
  cols.push({
    key: "SINH_NHAT",
    group: "Suất đặc biệt",
    label: "Suất SN",
    quantity: birthdayQty,
    unitPrice:
      birthdayQty > 0 ? birthdayAmount / birthdayQty : pricing.VN_SINHNHAT,
    tone: "birthday",
  });

  return cols;
}

/** Gộp các cột liền nhau cùng nhóm thành một ô ở hàng tiêu đề trên. */
export const allocationHeaderGroups = (columns: AllocationColumn[]) =>
  columns.reduce<{ group: string; span: number }[]>((acc, c) => {
    const last = acc[acc.length - 1];
    if (last && last.group === c.group) last.span += 1;
    else acc.push({ group: c.group, span: 1 });
    return acc;
  }, []);

/* -------------------------------------------------------------------------
   Bảng "Phân bổ theo bộ phận"
   ------------------------------------------------------------------------- */

/** Thứ tự cột loại suất, dùng chung cho bảng phân bổ theo bộ phận. */
export const CATEGORY_COLUMNS: MealCategory[] = [
  "KO_COM",
  "KO_MY",
  "VN_CHINH",
  "VN_PHU",
  "VN_SINHNHAT",
];

/**
 * Bộ phận lớn KHÔNG gánh tiền sữa và chi phí nhân công.
 *
 * Sữa và nhân công phục vụ người Việt ở nhà ăn, nên hai khoản đó được CHIA
 * ĐỀU cho các bộ phận người Việt — mọi bộ phận lớn trừ KR (người Hàn) và
 * 'Khác' (người chưa ánh xạ, không có ai để gửi hoá đơn).
 */
export const SHARED_COST_EXCLUDED_DEPTS = ["KR", "Khác"];

/** Bộ phận này có nhận một phần tiền sữa / nhân công không. */
export const sharesSupportCost = (deptName: string) =>
  !SHARED_COST_EXCLUDED_DEPTS.includes(deptName);

export interface DeptAllocationRow {
  deptName: string;
  counts: Record<MealCategory, number>;
  totalMeals: number;
  /** Tiền suất ăn của bộ phận = Σ số suất × đơn giá cột. */
  mealAmount: number;
  /**
   * Phần tiền sữa chia đều cho bộ phận — 0 với KR và 'Khác'. KHÔNG làm tròn:
   * cộng các phần lại phải ra đúng tổng tiền sữa.
   */
  milkShare: number;
  /** Phần chi phí nhân công chia đều — cùng quy tắc với `milkShare`. */
  laborShare: number;
  /** = mealAmount + milkShare + laborShare. */
  totalAmount: number;
}

const emptyCategoryCounts = (): Record<MealCategory, number> => ({
  KO_COM: 0,
  KO_MY: 0,
  VN_CHINH: 0,
  VN_PHU: 0,
  VN_SINHNHAT: 0,
});

/**
 * ĐƠN GIÁ MỘT SUẤT của từng loại, dùng cho bảng phân bổ theo bộ phận.
 *
 * Bốn loại đầu đọc thẳng SA_MealPrice. Suất sinh nhật thì KHÔNG: mỗi ngày
 * sinh nhật mang giá riêng trong tab "Cấu Hình Sinh Nhật", nên ở một bảng chỉ
 * có một ô đơn giá cho cả kỳ thì phải là giá BÌNH QUÂN suy ngược từ
 * tiền / số suất, không làm tròn. Nhờ vậy tổng của bảng phân bổ vẫn khớp
 * đúng tổng của khối sinh nhật trong bảng kê tháng — giống hệt cách cột Sữa
 * và cột Nhân công làm.
 *
 * Nguồn duy nhất của con số đó: bảng trên web, file CSV và sheet Excel đều
 * gọi hàm này chứ không tự tính lại, nếu không dòng đơn giá của sheet Excel
 * sẽ nhân ra một tổng khác với dòng TỔNG CỘNG ngay dưới nó.
 */
export function buildCategoryUnitPrices(
  classified: ClassifiedLog[],
  manualMeals: CountedManualMeal[],
  pricing: MealPricing,
): Record<MealCategory, number> {
  const buckets = buildBirthdayBuckets(classified, manualMeals);
  const qty = birthdayTotalCount(buckets);
  return {
    ...pricing,
    VN_SINHNHAT:
      qty > 0 ? birthdayTotalAmount(buckets) / qty : pricing.VN_SINHNHAT,
  };
}

export function buildDeptAllocation(
  classified: ClassifiedLog[],
  manualMeals: CountedManualMeal[],
  largeDeptOptions: string[],
  pricing: MealPricing,
  /* ĐÃ LỌC theo khoảng lọc — `filterSupplyByRange`. */
  milkEntries: DailyMilkEntry[] = [],
  /* Đã cắt sẵn theo khoảng lọc — `buildLaborSegments`. */
  laborSegments: LaborSegment[] = [],
): DeptAllocationRow[] {
  const byDept = new Map<string, Record<MealCategory, number>>();
  const bump = (largeDept: string, category: MealCategory, qty: number) => {
    if (!byDept.has(largeDept)) byDept.set(largeDept, emptyCategoryCounts());
    byDept.get(largeDept)![category] += qty;
  };

  classified.forEach((r) => bump(r.largeDept, r.category, 1));
  /* Suất nhập tay là suất ăn thật, chỉ thiếu lượt quẹt — bộ phận thụ hưởng
     vẫn phải gánh tiền của nó. */
  manualMeals.forEach((r) => bump(r.largeDept, r.category, r.quantity));

  /* Duyệt theo danh mục SA_LargeDepartment để bộ phận không có lượt quẹt
     nào vẫn có dòng, rồi thêm những bộ phận lạ mà log đang mang. */
  const deptNames = [
    ...largeDeptOptions,
    ...Array.from(byDept.keys()).filter((d) => !largeDeptOptions.includes(d)),
  ];

  /* Đúng bộ đơn giá mà bảng in ra ở hàng tiêu đề, nên "số suất × đơn giá của
     cột" cộng lại đúng bằng ô tiền suất ăn của dòng. */
  const unitPrices = buildCategoryUnitPrices(classified, manualMeals, pricing);

  /* Sữa và nhân công chia ĐỀU cho các bộ phận người Việt, kể cả bộ phận kỳ
     này không có suất nào: hai khoản này không đi theo số suất. Tổng lấy từ
     đúng các hàm mà `reconcileCost` và bảng kê tháng dùng, nên tổng các phần
     luôn bằng con số ở hai chỗ đó. */
  const recipients = deptNames.filter(sharesSupportCost);
  const milkAmount = supplyTotals(
    buildSupplySeries(milkEntries.map(milkAsSupply)),
  ).amount;
  const laborAmount = laborTotalAmount(laborSegments);
  const milkShare = recipients.length > 0 ? milkAmount / recipients.length : 0;
  const laborShare =
    recipients.length > 0 ? laborAmount / recipients.length : 0;

  return deptNames.map((deptName) => {
    const counts = byDept.get(deptName) ?? emptyCategoryCounts();
    const totalMeals = CATEGORY_COLUMNS.reduce((sum, c) => sum + counts[c], 0);
    const mealAmount = CATEGORY_COLUMNS.reduce(
      (sum, c) => sum + counts[c] * unitPrices[c],
      0,
    );
    const shares = sharesSupportCost(deptName);
    const milk = shares ? milkShare : 0;
    const labor = shares ? laborShare : 0;
    return {
      deptName,
      counts,
      totalMeals,
      mealAmount,
      milkShare: milk,
      laborShare: labor,
      totalAmount: mealAmount + milk + labor,
    };
  });
}

/** Số bộ phận nhận một phần tiền sữa / nhân công — mẫu số của phép chia. */
export const supportCostRecipientCount = (rows: DeptAllocationRow[]) =>
  rows.filter((d) => sharesSupportCost(d.deptName)).length;

/* -------------------------------------------------------------------------
   Đối chiếu tổng tiền giữa các bảng
   -------------------------------------------------------------------------
   Hai bảng trả lời hai câu hỏi khác nhau và VÌ THẾ có hai con số khác nhau:

   - "Thống kê suất ăn tháng" là bảng kê gửi nhà ăn, TOTAL của nó là số tiền
     phải trả — gồm suất ăn, sữa, chi phí phát sinh và nhân công.
   - "Phân bổ theo BP" chia tiền cho các bộ phận: tiền suất ăn theo số suất
     của từng bộ phận, tiền sữa và nhân công CHIA ĐỀU cho các bộ phận người
     Việt (`buildDeptAllocation`). Chỉ chi phí phát sinh là không chia — tên
     hạng mục là chữ tự do, không có quy tắc nào nói bộ phận nào gánh.

   Chênh lệch giữa TỔNG CỘNG PHÂN BỔ và TOTAL luôn đúng bằng tiền phát sinh.
   Hàm này là nguồn duy nhất của các con số, và bảng phân bổ in hết ra để đối
   chiếu thấy ngay. */

/** Tổng tiền và tổng số lượng của các dòng cấp phát. */
function supplyTotals(rows: SupplySeries[]) {
  return {
    amount: rows.reduce((acc, m) => acc + m.amount, 0),
    count: rows.reduce((acc, m) => acc + m.series.total, 0),
  };
}

export interface CostReconciliation {
  /** Tiền SUẤT ĂN của mọi bộ phận (chưa gồm phần sữa / nhân công). */
  mealAmount: number;
  mealCount: number;
  /** Tiền sữa — chia đều cho các bộ phận người Việt. */
  milkAmount: number;
  milkCount: number;
  /** Tiền các hạng mục phát sinh — KHÔNG phân bổ cho bộ phận nào. */
  extraAmount: number;
  extraCount: number;
  /**
   * Tiền thuê nhân công của lượt "Áp dụng" đang có hiệu lực, đã cắt theo
   * khoảng lọc — chia đều cho các bộ phận người Việt như tiền sữa.
   */
  laborAmount: number;
  /** Số NGÀY CÔNG được tính tiền — không phải số người. */
  laborDays: number;
  /**
   * Tổng cột Thành Tiền của bảng phân bổ = suất ăn + phần sữa + phần nhân
   * công đã chia được. Bằng mealAmount + milkAmount + laborAmount, trừ khi
   * danh mục không còn bộ phận người Việt nào để chia.
   */
  allocatedAmount: number;
  /**
   * = mealAmount + milkAmount + extraAmount + laborAmount, đúng bằng TOTAL
   * của bảng kê suất ăn tháng.
   */
  grandTotal: number;
}

export function reconcileCost(
  deptRows: DeptAllocationRow[],
  /* ĐÃ LỌC theo khoảng lọc — `filterSupplyByRange`. */
  milkEntries: DailyMilkEntry[],
  extraCosts: ExtraCostEntry[],
  /* Đã cắt sẵn theo khoảng lọc lúc dựng — xem `buildLaborSegments`. */
  laborSegments: LaborSegment[] = [],
): CostReconciliation {
  const mealAmount = deptRows.reduce((acc, d) => acc + d.mealAmount, 0);
  const mealCount = deptRows.reduce((acc, d) => acc + d.totalMeals, 0);

  /* Gom bằng đúng `buildSupplySeries` để tiền ở đây và ở các dòng cấp phát
     của bảng kê tháng không thể ra hai con số. */
  const milk = supplyTotals(buildSupplySeries(milkEntries.map(milkAsSupply)));
  const extra = supplyTotals(
    buildSupplySeries(extraCosts.map(extraAsSupply)),
  );

  const laborAmount = laborTotalAmount(laborSegments);

  return {
    mealAmount,
    mealCount,
    milkAmount: milk.amount,
    milkCount: milk.count,
    extraAmount: extra.amount,
    extraCount: extra.count,
    laborAmount,
    laborDays: laborTotalWorkDays(laborSegments),
    allocatedAmount: deptRows.reduce((acc, d) => acc + d.totalAmount, 0),
    grandTotal: mealAmount + milk.amount + extra.amount + laborAmount,
  };
}

/* -------------------------------------------------------------------------
   Bảng "Total suất ăn" — 12 tháng
   ------------------------------------------------------------------------- */

export interface YearlySeries {
  key: keyof MonthlyCostRow;
  countKey?: keyof MonthlyCostRow;
  name: string;
  color: string;
}

/** Các cột của bảng 12 tháng; màu trùng với bảng màu biểu đồ xu hướng. */
export const YEARLY_SERIES: YearlySeries[] = [
  { key: "ComHan", countKey: "ComHanCount", name: "Cơm Hàn", color: "#2a78d6" },
  { key: "MyHan", countKey: "MyHanCount", name: "Mỳ Hàn", color: "#eb6834" },
  {
    key: "ComViet",
    countKey: "ComVietCount",
    name: "Bữa Chính VN",
    color: "#1baf7a",
  },
  {
    key: "ComVietPhu",
    countKey: "ComVietPhuCount",
    name: "Bữa Phụ VN",
    color: "#eda100",
  },
  {
    key: "SuatDacBiet",
    countKey: "SuatDacBietCount",
    name: "Suất Sinh Nhật",
    color: "#e87ba4",
  },
  { key: "Sua", name: "Sữa", color: "#008300" },
  { key: "ChiPhiPhatSinh", name: "Chi Phí Phát Sinh", color: "#8b5cf6" },
  { key: "ChiPhiNhanCong", name: "Chi Phí Nhân Công", color: "#0d9488" },
];

/**
 * Đọc một ô tiền của bảng 12 tháng.
 *
 * `ChiPhiNhanCong` KHÔNG do SA_MealCost_GetMonthly trả về mà được cộng vào ở
 * client (xem `withLaborCost`), nên một dòng chưa qua đó sẽ thiếu ô — đọc
 * thẳng bằng `Number()` là ra NaN và cả cột tổng hỏng theo.
 */
export const yearlyValue = (row: MonthlyCostRow, key: keyof MonthlyCostRow) =>
  Number(row[key] ?? 0) || 0;

/**
 * Cộng chi phí nhân công vào bảng 12 tháng, TỪNG KỲ MỘT.
 *
 * SA_MealCost_GetMonthly không biết gì về nhân công và cố ý giữ nguyên như
 * vậy: phép chia tiền theo ngày làm việc đã có một bản cài đặt duy nhất ở
 * `buildLaborSegments`, chép nó sang T-SQL là tạo ra bản sao thứ hai để hai
 * bên lệch nhau — đúng thứ mà chú thích đầu file này cảnh báo. Ở đây chỉ gọi
 * lại chính hàm đó với khoảng lọc là KỲ của từng tháng.
 *
 * Kỳ lấy từ chính dòng SQL trả về (`fromDateTime` / `toDateTime`, cài ở tab
 * Xu hướng năm), quy về ngày làm việc bằng `costWorkDayRange` — đúng như bộ
 * lọc chính quy về ngày làm việc trước khi cắt đợt. Nên mọi cột của một dòng
 * đều thuộc cùng một kỳ. Dòng không mang kỳ (procedure cũ) thì coi là tháng
 * lịch.
 *
 * `Sum` được cộng lại chứ không lấy từ SQL, nếu không dòng tổng tháng sẽ nhỏ
 * hơn tổng các cột đúng bằng tiền nhân công.
 */
export function withLaborCost(
  rows: MonthlyCostRow[],
  laborPeriods: LaborPeriodInput[],
  rule: LaborWorkDayRule,
  shifts?: ShiftInfo[],
): MonthlyCostRow[] {
  return rows.map((row) => {
    let range: { from: string; to: string };
    if (row.fromDateTime && row.toDateTime) {
      range = costWorkDayRange(row.fromDateTime, row.toDateTime, shifts);
    } else {
      /* costMonth là "YYYY-MM". Ngày cuối tháng = mùng 1 tháng sau lùi một
         ngày — đúng cả tháng 2 năm nhuận mà không phải nhớ bảng số ngày. */
      const y = Number(row.costMonth.slice(0, 4));
      const m = Number(row.costMonth.slice(5, 7));
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      range = {
        from: `${row.costMonth}-01`,
        to: addDays(`${nextY}-${String(nextM).padStart(2, "0")}-01`, -1),
      };
    }

    const labor =
      range.to < range.from
        ? 0
        : laborTotalAmount(
            buildLaborSegments(laborPeriods, range.from, range.to, rule),
          );

    return {
      ...row,
      ChiPhiNhanCong: labor,
      Sum: yearlyValue(row, "Sum") + labor,
    };
  });
}
