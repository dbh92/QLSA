import React, { useMemo, useState } from "react";
import {
  MealLog,
  ReaderInfo,
  ShiftInfo,
  ShiftCode,
  DailyMilkEntry,
  ManualMealEntry,
  DepartmentMapping,
  MealPriceItem,
  ShiftMealCategory,
  BirthdayConfig,
} from "../types";
import {
  formatVND,
  getLogLargeDepartment,
  isKoreanStaffLog,
  exportToCSV,
  buildBirthdayPriceMap,
  buildMealPricing,
  buildShiftCategoryLookup,
  getMealShiftDate,
  getCostReportDate,
  supplyInRange,
  classifyMeal,
  isBirthdayMealLog,
  shiftAlias,
  classifyManualEntries,
  LossCharge,
  manualMealAmount,
  manualMealCount,
  SUPPLY_SHIFT_LABEL,
  PunchDayCase,
  CountedManualMeal,
} from "../services/mealEngine";
import { ManualMealsTable } from "./ManualMealsTable";
import {
  Utensils,
  Globe2,
  Users,
  Clock,
  AlertTriangle,
  Milk,
  Server,
  Activity,
  CheckCircle2,
  Building2,
  X,
  Download,
} from "lucide-react";

/**
 * Số dòng tối đa vẽ trong modal chi tiết. Một mục trên dashboard có thể ứng với
 * hàng chục nghìn lượt quẹt — vẽ hết sẽ treo trình duyệt. Phần vượt quá lấy
 * bằng nút xuất CSV.
 */
const MODAL_ROW_LIMIT = 500;

interface DashboardViewProps {
  logs: MealLog[];
  readers: ReaderInfo[];
  shifts: ShiftInfo[];
  abnormalList: PunchDayCase[];
  milkEntries: DailyMilkEntry[];
  manualEntries: ManualMealEntry[];
  mappings: DepartmentMapping[];
  priceItems: MealPriceItem[];
  /** Bảng gán loại suất theo ca (tab Cấu Hình Giá Suất Ăn). */
  shiftMealCategories: ShiftMealCategory[];
  birthdayConfigs: BirthdayConfig[];
  /** Các ca được ăn suất sinh nhật (SA_SystemSetting: BIRTHDAY_SHIFTS). */
  birthdayShifts: Set<ShiftCode>;
  /** Biên lọc chính xác tới giây, "YYYY-MM-DD HH:mm:ss". */
  startDateTime: string;
  endDateTime: string;
  /** Phần ngày của hai biên trên, cho dữ liệu chỉ có cột ngày. */
  startDate: string;
  endDate: string;
}

/** Một dòng của bảng ma trận Ca × Bộ phận lớn. */
interface DeptShiftRow {
  departmentName: string;
  ca1: number;
  ca2: number;
  ca3: number;
  ca4: number;
  ca5: number;
  ca6: number;
  khac: number;
  total: number;
  amount: number;
}

/**
 * Nội dung modal chi tiết. Mỗi mục trên dashboard mở ra một trong ba dạng bảng:
 * lượt quẹt thẻ, danh sách chấm bất thường, hoặc phiếu nhập sữa.
 */
type Drilldown =
  | {
      kind: "logs";
      title: string;
      subtitle: string;
      rows: MealLog[];
      /** Suất nhập tay của cùng ô — không có lượt quẹt nên đi bảng riêng. */
      manual?: CountedManualMeal[];
    }
  | { kind: "abnormal"; title: string; subtitle: string; rows: PunchDayCase[] }
  | { kind: "milk"; title: string; subtitle: string; rows: DailyMilkEntry[] };

export const DashboardView: React.FC<DashboardViewProps> = ({
  logs,
  readers,
  shifts,
  abnormalList,
  milkEntries,
  manualEntries,
  mappings,
  priceItems,
  shiftMealCategories,
  birthdayConfigs,
  birthdayShifts,
  startDateTime,
  endDateTime,
  startDate,
  endDate,
}) => {
  const [drilldown, setDrilldown] = useState<Drilldown | null>(null);

  // Filtered logs in selected range
  const filteredLogs = useMemo(
    () =>
      logs.filter(
        (l) => l.logDateTime >= startDateTime && l.logDateTime <= endDateTime,
      ),
    [logs, startDateTime, endDateTime],
  );

  /** Mở modal với danh sách lượt quẹt, sắp xếp mới nhất trước. */
  const openLogs = (
    title: string,
    subtitle: string,
    rows: MealLog[],
    manual: CountedManualMeal[] = [],
  ) =>
    setDrilldown({
      kind: "logs",
      title,
      subtitle,
      rows: [...rows].sort((a, b) =>
        b.logDateTime.localeCompare(a.logDateTime),
      ),
      manual,
    });

  /** Xuất TOÀN BỘ dòng của modal ra CSV (không giới hạn MODAL_ROW_LIMIT). */
  const exportDrilldown = (d: Drilldown) => {
    const fileName = `${d.title.replace(/[\\/:*?"<>|]/g, "-")}_${startDate}_${endDate}`;

    if (d.kind === "logs") {
      exportToCSV(
        fileName,
        [
          "Thời gian thô",
          "Ngày công",
          "Ca",
          "Mã NV",
          "Tên nhân viên",
          "Bộ phận",
          "Bộ phận lớn",
          "Máy chấm",
        ],
        d.rows.map((l) => [
          l.logDateTime,
          getCostReportDate(l, shifts),
          l.shiftCode,
          l.userId,
          l.userName,
          l.department,
          getLogLargeDepartment(l, mappings),
          l.readerName,
        ]),
      );
    } else if (d.kind === "abnormal") {
      exportToCSV(
        fileName,
        [
          "Ngày làm việc",
          "Mã NV",
          "Tên nhân viên",
          "Bộ phận",
          "Tổng lượt quẹt",
          "Lượt hợp lệ",
          "Lượt trùng ca",
          "Lượt vượt hạn mức",
          "Suất mất mát",
          "Suất bị trừ tiền",
          "Tiền bị trừ (VNĐ)",
          "Suất không bị trừ tiền",
          "Tiền không bị trừ (VNĐ)",
          "Các giờ quẹt",
        ],
        d.rows.map((c) => [
          c.workDate,
          c.userId,
          c.userName,
          c.department,
          c.totalPunches,
          c.validCount,
          c.dupShiftCount,
          c.overLimitCount,
          c.lossCount,
          c.chargeableCount,
          lossAmountOf(c, "BI_TRU"),
          c.freeCount,
          lossAmountOf(c, "KHONG_TRU"),
          c.punches
            .map(
              (p) =>
                `${p.log.logTimeOnly} (${p.log.shiftCode})${p.isLoss ? " DƯ" : ""}`,
            )
            .join(" | "),
        ]),
      );
    } else {
      exportToCSV(
        fileName,
        [
          "Ngày",
          "Ca",
          "Loại sữa",
          "Số lượng",
          "Đơn giá",
          "Thành tiền",
          "Nhà cung cấp",
        ],
        d.rows.map((m) => [
          m.date,
          SUPPLY_SHIFT_LABEL[m.milkShift] ?? m.milkShift,
          m.milkType,
          m.quantity,
          m.unitPrice,
          m.totalAmount,
          m.supplier,
        ]),
      );
    }
  };

  /** Mở modal cho một ô của bảng ma trận: bộ phận lớn × ca (hoặc toàn bộ ca). */
  const openCell = (deptName: string, shiftCode: ShiftCode | "ALL") =>
    openLogs(
      `Bộ phận ${deptName}${shiftCode === "ALL" ? "" : ` — ${shiftCode}`}`,
      shiftCode === "ALL"
        ? "Toàn bộ ca trong khoảng đang chọn."
        : `Chỉ các lượt quẹt thuộc ca ${shiftCode}.`,
      filteredLogs.filter(
        (l) =>
          getLogLargeDepartment(l, mappings) === deptName &&
          (shiftCode === "ALL" || l.shiftCode === shiftCode),
      ),
      /* Ma trận cộng cả suất nhập tay, nên popup cũng phải liệt kê chúng —
         nếu không, ô chỉ gồm suất nhập tay (hay gặp ở "Khác") mở ra rỗng. */
      manualMeals.filter(
        (m) =>
          m.largeDept === deptName &&
          (shiftCode === "ALL" || m.shiftCode === shiftCode),
      ),
    );

  // Machine breakdown
  const machine1Count = filteredLogs.filter(
    (l) => l.readerId === readers[0].id,
  ).length;
  const machine2Count = filteredLogs.filter(
    (l) => l.readerId === readers[1].id,
  ).length;
  const machine3Count = filteredLogs.filter(
    (l) => l.readerId === readers[2].id,
  ).length;

  /* ---------------------------------------------------------------------
     Phân loại & đơn giá — dùng chung classifyMeal/buildMealPricing với tab
     Hàn Quốc vs Việt Nam để hai màn hình không ra hai con số khác nhau.
     Loại suất của mỗi (ca, nhóm nhân sự) lấy theo bảng gán trong tab Cấu Hình
     Giá Suất Ăn; ngày sinh nhật tập thể đè lên loại suất của người Việt.
     --------------------------------------------------------------------- */
  const pricing = useMemo(() => buildMealPricing(priceItems), [priceItems]);

  const shiftCategories = useMemo(
    () => buildShiftCategoryLookup(shiftMealCategories),
    [shiftMealCategories],
  );

  /* Ngày sinh nhật -> đơn giá suất sinh nhật của chính ngày đó. Đơn giá này
     chỉ có ở tab "Cấu Hình Sinh Nhật" (mỗi ngày một giá), nên màn hình này
     đọc thẳng bảng tra chứ không tra `pricing.VN_SINHNHAT` — nếu không nó sẽ
     nói một con số khác với Báo Cáo Chi Phí. */
  const birthdayPrices = useMemo(
    () => buildBirthdayPriceMap(birthdayConfigs),
    [birthdayConfigs],
  );
  const birthdayDateSet = birthdayPrices;

  /* Suất nhập tay (tab Nhập Thủ Công Ca) là suất ăn thật, chỉ thiếu lượt
     quẹt — mọi ô số suất và mọi ô tiền ở màn hình này đều phải cộng chúng
     vào, đúng như bảng kê chi phí. Phân loại một lượt rồi dùng lại. */
  const manualMeals = useMemo(
    () =>
      classifyManualEntries(
        manualEntries,
        mappings,
        shiftCategories,
        pricing,
        startDateTime,
        endDateTime,
        shifts,
        birthdayPrices,
        birthdayShifts,
      ),
    [
      manualEntries,
      mappings,
      shiftCategories,
      pricing,
      startDateTime,
      endDateTime,
      shifts,
      birthdayPrices,
      birthdayShifts,
    ],
  );

  const isKoreanMeal = (l: MealLog) => isKoreanStaffLog(l, mappings);

  /** Đơn giá của một lượt quẹt theo quy tắc trên. */
  const priceOfLog = (l: MealLog) => {
    /* Suất sinh nhật ăn giá CỦA NGÀY ĐÓ trong tab Cấu Hình Sinh Nhật; ngày
       nào bỏ trống giá thì mới rơi về SA_MealPrice. */
    if (isBirthdayMealLog(l, birthdayPrices, shifts, birthdayShifts)) {
      const p = birthdayPrices.get(getMealShiftDate(l, shifts)) ?? 0;
      return p > 0 ? p : pricing.VN_SINHNHAT;
    }
    return pricing[
      classifyMeal(l.shiftCode, isKoreanMeal(l), false, shiftCategories)
    ];
  };

  const sumAmount = (rows: MealLog[]) =>
    rows.reduce((sum, l) => sum + priceOfLog(l), 0);

  // Korean vs Vietnamese
  const koreanLogs = useMemo(
    () => filteredLogs.filter(isKoreanMeal),
    [filteredLogs, mappings],
  );
  const vietnameseLogs = useMemo(
    () => filteredLogs.filter((l) => !isKoreanMeal(l)),
    [filteredLogs, mappings],
  );

  /* Suất nhập tay tách theo đúng nhóm đã chọn khi nhập. */
  const manualKorean = useMemo(
    () => manualMeals.filter((m) => m.staffType === "KR"),
    [manualMeals],
  );
  const manualVietnamese = useMemo(
    () => manualMeals.filter((m) => m.staffType === "VN"),
    [manualMeals],
  );

  /* Danh sách trong modal chỉ có lượt quẹt; suất nhập tay không có lượt quẹt
     nên phải nói rõ, nếu không người đọc tưởng con số ở thẻ bị sai. */
  const manualNote = (rows: typeof manualMeals) => {
    const n = manualMealCount(rows);
    return n > 0
      ? ` Đã gồm ${n.toLocaleString("vi-VN")} suất nhập thủ công, không nằm trong danh sách này.`
      : "";
  };

  const koreanCount = koreanLogs.length + manualMealCount(manualKorean);
  const vietnameseCount = vietnameseLogs.length + manualMealCount(manualVietnamese);
  // Giá suất Hàn phụ thuộc ca (cơm 65k / mỳ 30k) nên phải cộng theo từng lượt.
  const koreanAmount = useMemo(
    () => sumAmount(koreanLogs) + manualMealAmount(manualKorean),
    [koreanLogs, manualKorean, pricing, shiftCategories],
  );
  const vietnameseAmount = useMemo(
    () => sumAmount(vietnameseLogs) + manualMealAmount(manualVietnamese),
    [vietnameseLogs, manualVietnamese, birthdayDateSet, pricing, shiftCategories, shifts, birthdayShifts],
  );

  /* Suất mất mát — chỉ tính các lượt quẹt bị kết luận là mất mát, không phải
     toàn bộ lượt quẹt của người vi phạm.

     Thẻ này hiện số BỊ TRỪ TIỀN, đúng bằng ô "Bị trừ tiền" của tab Suất Ăn
     Mất Mát: quẹt trùng ca lại trong vòng 10 phút là thao tác lỗi, không ai
     ăn thêm suất nào nên không phải tiền thất thoát. Số không bị trừ vẫn hiện
     ở dòng phụ để không ai tưởng hệ thống bỏ sót. */
  const lossStats = useMemo(() => {
    const acc = {
      chargeableCount: 0,
      chargeableAmount: 0,
      freeCount: 0,
      freeAmount: 0,
    };
    abnormalList.forEach((c) =>
      c.punches.forEach((p) => {
        if (!p.isLoss) return;
        const price = priceOfLog(p.log);
        if (p.charge === "KHONG_TRU") {
          acc.freeCount += 1;
          acc.freeAmount += price;
        } else {
          acc.chargeableCount += 1;
          acc.chargeableAmount += price;
        }
      }),
    );
    return acc;
  }, [abnormalList, mappings, birthdayDateSet, pricing, shiftCategories, shifts, birthdayShifts]);

  const lossCount = lossStats.chargeableCount;
  const lossAmount = lossStats.chargeableAmount;

  /** Tiền của các lượt mất mát thuộc một phân loại, trong một ngày làm việc. */
  const lossAmountOf = (c: PunchDayCase, charge: LossCharge) =>
    c.punches
      .filter((p) => p.isLoss && (p.charge ?? "BI_TRU") === charge)
      .reduce((s, p) => s + priceOfLog(p.log), 0);

  // Số suất + thành tiền theo từng ca, gom trong một lượt duyệt.
  const shiftStats = useMemo(() => {
    const map = new Map<string, { count: number; amount: number }>();
    filteredLogs.forEach((l) => {
      const cur = map.get(l.shiftCode) || { count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += priceOfLog(l);
      map.set(l.shiftCode, cur);
    });
    // Suất nhập tay thuộc đúng ca đã ghi khi nhập.
    manualMeals.forEach((m) => {
      const cur = map.get(m.shiftCode) || { count: 0, amount: 0 };
      cur.count += m.quantity;
      cur.amount += m.amount;
      map.set(m.shiftCode, cur);
    });
    return map;
  }, [filteredLogs, manualMeals, mappings, birthdayDateSet, pricing, shiftCategories, shifts, birthdayShifts]);

  const shiftCounts = shifts.map((s) => ({
    ...s,
    count: shiftStats.get(s.code)?.count || 0,
    amount: shiftStats.get(s.code)?.amount || 0,
  }));
  const khacCount = shiftStats.get("Khác")?.count || 0;
  const khacAmount = shiftStats.get("Khác")?.amount || 0;

  // Manual total in range
  const manualTotal = manualMealCount(manualMeals);

  /* Sữa trong khoảng lọc — theo KHUNG GIỜ của từng ca cấp phát (ca đêm ngày D
     là (D-1) 22:50 -> D 08:00), cùng quy tắc với Báo Cáo Chi Phí: lọc từ 25
     lúc 22:50 thì sữa của ngày 25 không còn được tính. */
  const milkInRange = milkEntries.filter((m) =>
    supplyInRange(m.date, m.milkShift, startDateTime, endDateTime, shifts),
  );
  const milkTotalAmount = milkInRange.reduce(
    (sum, m) => sum + m.totalAmount,
    0,
  );
  const milkTotalQty = milkInRange.reduce((sum, m) => sum + m.quantity, 0);

  // Ma trận Ca × Bộ phận lớn — cùng cách gom nhóm với tab "Thống Kê Ca / Bộ Phận".
  const departmentRows = useMemo(() => {
    const map = new Map<string, DeptShiftRow>();

    /** Cộng một số suất vào đúng ô (bộ phận lớn × ca) của ma trận. */
    const add = (
      deptKey: string,
      shiftCode: ShiftCode,
      quantity: number,
      amount: number,
    ) => {
      if (!map.has(deptKey)) {
        map.set(deptKey, {
          departmentName: deptKey,
          ca1: 0,
          ca2: 0,
          ca3: 0,
          ca4: 0,
          ca5: 0,
          ca6: 0,
          khac: 0,
          total: 0,
          amount: 0,
        });
      }

      const row = map.get(deptKey)!;
      row.total += quantity;
      row.amount += amount;

      if (shiftCode === "CA1") row.ca1 += quantity;
      else if (shiftCode === "CA2") row.ca2 += quantity;
      else if (shiftCode === "CA3") row.ca3 += quantity;
      else if (shiftCode === "CA4") row.ca4 += quantity;
      else if (shiftCode === "CA5") row.ca5 += quantity;
      else if (shiftCode === "CA6") row.ca6 += quantity;
      else row.khac += quantity;
    };

    filteredLogs.forEach((log) =>
      add(getLogLargeDepartment(log, mappings), log.shiftCode, 1, priceOfLog(log)),
    );
    // Suất nhập tay tính cho bộ phận thụ hưởng đã ghi khi nhập.
    manualMeals.forEach((m) =>
      add(m.largeDept, m.shiftCode, m.quantity, m.amount),
    );

    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [filteredLogs, manualMeals, mappings, birthdayDateSet, pricing, shiftCategories, shifts, birthdayShifts]);

  const grandTotal = useMemo(
    () =>
      departmentRows.reduce(
        (acc, r) => {
          acc.ca1 += r.ca1;
          acc.ca2 += r.ca2;
          acc.ca3 += r.ca3;
          acc.ca4 += r.ca4;
          acc.ca5 += r.ca5;
          acc.ca6 += r.ca6;
          acc.khac += r.khac;
          acc.total += r.total;
          acc.amount += r.amount;
          return acc;
        },
        {
          ca1: 0,
          ca2: 0,
          ca3: 0,
          ca4: 0,
          ca5: 0,
          ca6: 0,
          khac: 0,
          total: 0,
          amount: 0,
        },
      ),
    [departmentRows],
  );

  /**
   * Xuất đúng bảng ma trận đang hiển thị: mỗi bộ phận lớn một dòng, kèm dòng
   * TỔNG CỘNG cuối cùng. Số suất và số tiền để ở dạng số thô (không định dạng)
   * để Excel còn cộng được.
   */
  const exportDeptShiftTable = () => {
    const headers = [
      "Bộ phận lớn",
      "CA1 (23H)",
      "CA2 (5H)",
      "CA3 (7H)",
      "CA4 (12H)",
      "CA5 (17H)",
      "CA6 (19H)",
      "Ngoài ca",
      "Tổng ca",
      "Tổng tiền (VNĐ)",
    ];

    const rows: (string | number)[][] = departmentRows.map((r) => [
      r.departmentName,
      r.ca1,
      r.ca2,
      r.ca3,
      r.ca4,
      r.ca5,
      r.ca6,
      r.khac,
      r.total,
      r.amount,
    ]);

    rows.push([
      "TỔNG CỘNG TOÀN BỘ",
      grandTotal.ca1,
      grandTotal.ca2,
      grandTotal.ca3,
      grandTotal.ca4,
      grandTotal.ca5,
      grandTotal.ca6,
      grandTotal.khac,
      grandTotal.total,
      grandTotal.amount,
    ]);

    exportToCSV(
      `Thong_Ke_Ca_Bo_Phan_${startDate}_${endDate}`,
      headers,
      rows,
    );
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Date Header Info */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 p-5 rounded-2xl text-white shadow-lg border border-slate-800 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <span className="text-amber-400 font-semibold text-xs tracking-wider uppercase flex items-center gap-1.5">
            <Activity className="w-4 h-4" /> Báo Cáo Tổng Quan Thời Gian Thực
          </span>
          <h2 className="text-2xl font-bold mt-1 text-slate-100">
            Tổng quan chấm công suất ăn
          </h2>
          <p className="text-slate-400 text-xs mt-1">
            Theo dõi dữ liệu quẹt thẻ từ 3 máy chấm BioStar &amp; bổ sung nhập
            ca thủ công từ{" "}
            <strong className="text-slate-200">{startDate}</strong> đến{" "}
            <strong className="text-slate-200">{endDate}</strong>.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() =>
              openLogs(
                "Toàn Bộ Lượt Quẹt Thẻ",
                `${manualTotal.toLocaleString("vi-VN")} suất nhập thủ công được cộng vào tổng nhưng không nằm trong danh sách này.`,
                filteredLogs,
              )
            }
            className="bg-slate-800/80 px-4 py-2.5 rounded-xl border border-slate-700/80 text-right hover:border-amber-500/60 hover:bg-slate-800 transition cursor-pointer"
          >
            <div className="text-[11px] text-slate-400 uppercase font-medium">
              Tổng Suất Ăn
            </div>
            <div className="text-2xl font-extrabold text-amber-400">
              {(filteredLogs.length + manualTotal).toLocaleString("vi-VN")}{" "}
              <span className="text-xs font-normal text-slate-400">suất</span>
            </div>
          </button>
        </div>
      </div>

      {/* 3 Attendance Readers Status & Counts */}
      <div>
        <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3 flex items-center gap-2">
          <Server className="w-4 h-4 text-indigo-600" /> Theo Dõi 3 Máy Chấm
          Canteen
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Machine 1 */}
          <button
            type="button"
            onClick={() =>
              openLogs(
                `Máy ${readers[0].code} — Canteen K`,
                `${readers[0].name} • ${readers[0].ip}`,
                filteredLogs.filter((l) => l.readerId === readers[0].id),
              )
            }
            className="w-full text-left bg-white p-4 rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex justify-between items-start">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
                  <Utensils className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-slate-800 text-sm">
                    {readers[0].code} - Canteen K
                  </h4>
                  <p className="text-xs text-slate-500">{readers[0].ip}</p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="w-3 h-3" /> Kết nối
              </span>
            </div>
            <div className="mt-4 flex items-baseline justify-between border-t pt-3 border-slate-100">
              <span className="text-xs text-slate-500 font-medium">
                Tổng lượt chấm:
              </span>
              <span className="text-xl font-bold text-slate-900">
                {machine1Count.toLocaleString("vi-VN")}{" "}
                <span className="text-xs font-normal text-slate-500">lượt</span>
              </span>
            </div>
          </button>

          {/* Machine 2 */}
          <button
            type="button"
            onClick={() =>
              openLogs(
                `Máy ${readers[1].code} — Canteen V`,
                `${readers[1].name} • ${readers[1].ip}`,
                filteredLogs.filter((l) => l.readerId === readers[1].id),
              )
            }
            className="w-full text-left bg-white p-4 rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-amber-400 transition cursor-pointer"
          >
            <div className="flex justify-between items-start">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-emerald-50 text-emerald-600 rounded-lg">
                  <Utensils className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-slate-800 text-sm">
                    {readers[1].code} - Canteen V
                  </h4>
                  <p className="text-xs text-slate-500">{readers[1].ip}</p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="w-3 h-3" /> Kết nối
              </span>
            </div>
            <div className="mt-4 flex items-baseline justify-between border-t pt-3 border-slate-100">
              <span className="text-xs text-slate-500 font-medium">
                Tổng lượt chấm:
              </span>
              <span className="text-xl font-bold text-slate-900">
                {machine2Count.toLocaleString("vi-VN")}{" "}
                <span className="text-xs font-normal text-slate-500">lượt</span>
              </span>
            </div>
          </button>

          {/* Machine 3 - Korean */}
          <button
            type="button"
            onClick={() =>
              openLogs(
                `Máy ${readers[2].code} — CT Korea`,
                `${readers[2].name} • ${readers[2].ip} • Suất ăn chuyên gia Hàn`,
                filteredLogs.filter((l) => l.readerId === readers[2].id),
              )
            }
            className="w-full text-left bg-white p-4 rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-amber-400 transition cursor-pointer border-l-4 border-l-red-500"
          >
            <div className="flex justify-between items-start">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-red-50 text-red-600 rounded-lg">
                  <Globe2 className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-1.5">
                    <h4 className="font-bold text-slate-800 text-sm">
                      {readers[2].code} - CT Korea
                    </h4>
                    <span className="px-1.5 py-0.2 text-[10px] bg-red-100 text-red-700 font-bold rounded">
                      Người Hàn
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">{readers[2].ip}</p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="w-3 h-3" /> Kết nối
              </span>
            </div>
            <div className="mt-4 flex items-baseline justify-between border-t pt-3 border-slate-100">
              <span className="text-xs text-slate-500 font-medium">
                Suất ăn chuyên gia Hàn:
              </span>
              <span className="text-xl font-bold text-red-600">
                {machine3Count.toLocaleString("vi-VN")}{" "}
                <span className="text-xs font-normal text-slate-500">lượt</span>
              </span>
            </div>
          </button>
        </div>
      </div>

      {/* Secondary Metrics Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() =>
            openLogs(
              "Suất Ăn Việt Nam",
              `${vietnameseCount.toLocaleString("vi-VN")} suất — ${formatVND(vietnameseAmount)} (suất ngày sinh nhật tính giá suất đặc biệt).${manualNote(manualVietnamese)}`,
              vietnameseLogs,
            )
          }
          className="w-full text-left bg-white p-4 rounded-xl border border-slate-200 flex items-center space-x-3 hover:border-amber-400 hover:shadow-md transition cursor-pointer"
        >
          <div className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold shrink-0">
            <Users className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs text-slate-500 font-medium">
              Suất Ăn Việt Nam
            </div>
            <div className="text-lg font-bold text-slate-900 leading-tight">
              {vietnameseCount.toLocaleString("vi-VN")}{" "}
              <span className="text-xs font-normal text-slate-500">suất</span>
            </div>
            <div className="text-xs font-semibold text-indigo-700 truncate">
              {formatVND(vietnameseAmount)}
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() =>
            openLogs(
              "Suất Ăn Người Hàn",
              `${koreanCount.toLocaleString("vi-VN")} suất — ${formatVND(koreanAmount)} (nhân sự thuộc bộ phận lớn KR, tính ở mọi máy chấm).${manualNote(manualKorean)}`,
              koreanLogs,
            )
          }
          className="w-full text-left bg-white p-4 rounded-xl border border-slate-200 flex items-center space-x-3 hover:border-amber-400 hover:shadow-md transition cursor-pointer"
        >
          <div className="w-10 h-10 rounded-lg bg-red-50 text-red-600 flex items-center justify-center font-bold shrink-0">
            <Globe2 className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs text-slate-500 font-medium">
              Suất Ăn Người Hàn
            </div>
            <div className="text-lg font-bold text-red-600 leading-tight">
              {koreanCount.toLocaleString("vi-VN")}{" "}
              <span className="text-xs font-normal text-slate-500">suất</span>
            </div>
            <div className="text-xs font-semibold text-red-700 truncate">
              {formatVND(koreanAmount)}
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() =>
            setDrilldown({
              kind: "abnormal",
              title: "Suất Ăn Mất Mát",
              subtitle: `${abnormalList.length.toLocaleString("vi-VN")} nhân sự • ${lossCount.toLocaleString("vi-VN")} suất bị trừ tiền — ${formatVND(lossAmount)}. Thêm ${lossStats.freeCount.toLocaleString("vi-VN")} suất quẹt lại dưới 10 phút không bị trừ tiền (${formatVND(lossStats.freeAmount)}). Mỗi dòng là một nhân sự trong một ngày làm việc.`,
              rows: abnormalList,
            })
          }
          className="w-full text-left bg-white p-4 rounded-xl border border-slate-200 flex items-center space-x-3 hover:border-amber-400 hover:shadow-md transition cursor-pointer"
        >
          <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center font-bold shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs text-slate-500 font-medium">
              Mất Mát Bị Trừ Tiền
            </div>
            <div className="text-lg font-bold text-amber-600 leading-tight">
              {lossCount.toLocaleString("vi-VN")}{" "}
              <span className="text-xs font-normal text-slate-500">
                suất / {abnormalList.length.toLocaleString("vi-VN")} nhân sự
              </span>
            </div>
            <div className="text-xs font-semibold text-amber-700 truncate">
              {formatVND(lossAmount)}
            </div>
            <div className="text-[10px] text-slate-400 leading-tight">
              +{lossStats.freeCount.toLocaleString("vi-VN")} suất quẹt lại
              &lt;10 phút không bị trừ
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() =>
            setDrilldown({
              kind: "milk",
              title: "Chi Tiết Sữa Đã Cấp",
              subtitle: `${milkTotalQty.toLocaleString("vi-VN")} suất — ${formatVND(milkTotalAmount)} trong khoảng đang chọn.`,
              rows: [...milkInRange].sort((a, b) =>
                b.date.localeCompare(a.date),
              ),
            })
          }
          className="w-full text-left bg-white p-4 rounded-xl border border-slate-200 flex items-center space-x-3 hover:border-amber-400 hover:shadow-md transition cursor-pointer"
        >
          <div className="w-10 h-10 rounded-lg bg-cyan-50 text-cyan-600 flex items-center justify-center font-bold shrink-0">
            <Milk className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs text-slate-500 font-medium">
              Tổng Sữa Đã Cấp
            </div>
            <div className="text-lg font-bold text-cyan-700 leading-tight">
              {milkTotalQty.toLocaleString("vi-VN")}{" "}
              <span className="text-xs font-normal text-slate-500">suất</span>
            </div>
            <div className="text-xs font-semibold text-cyan-700 truncate">
              {formatVND(milkTotalAmount)}
            </div>
          </div>
        </button>
      </div>

      {/* Shifts Grid Cards */}
      <div>
        <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3 flex items-center gap-2">
          <Clock className="w-4 h-4 text-amber-600" /> Số Lượng Chấm Ăn Theo
          Từng Ca
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
          {shiftCounts.map((shift) => (
            <button
              type="button"
              key={shift.code}
              onClick={() =>
                openLogs(
                  `${shift.code} — ${shift.name}`,
                  `Khung giờ ${shift.startTime.slice(0, 5)} - ${shift.endTime.slice(0, 5)}`,
                  filteredLogs.filter((l) => l.shiftCode === shift.code),
                )
              }
              className="w-full bg-white p-3.5 rounded-xl border border-slate-200 text-center hover:border-amber-400 hover:shadow-md transition cursor-pointer"
            >
              <div className="text-xs font-bold text-slate-800">
                {shift.code} - {shiftAlias(shifts, shift.code)}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {shift.startTime.slice(0, 5)} - {shift.endTime.slice(0, 5)}
              </div>
              <div className="text-2xl font-black text-amber-600 mt-2">
                {shift.count.toLocaleString("vi-VN")}
              </div>
              <div className="text-[10px] text-slate-400 mt-1 uppercase">
                Suất ăn
              </div>
              <div className="text-[11px] font-bold text-slate-700 mt-1.5 pt-1.5 border-t border-slate-100 truncate">
                {formatVND(shift.amount)}
              </div>
            </button>
          ))}

          {/* Outside shift */}
          <button
            type="button"
            onClick={() =>
              openLogs(
                "Ngoài Ca",
                "Lượt quẹt không rơi vào khung giờ của 6 ca ăn.",
                filteredLogs.filter((l) => l.shiftCode === "Khác"),
              )
            }
            className="w-full bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-center hover:border-amber-400 hover:shadow-md transition cursor-pointer"
          >
            <div className="text-xs font-bold text-slate-600">Ngoài Ca</div>
            <div className="text-[11px] text-slate-400 mt-0.5">Giờ khác</div>
            <div className="text-2xl font-black text-slate-700 mt-2">
              {khacCount.toLocaleString("vi-VN")}
            </div>
            <div className="text-[10px] text-slate-400 mt-1 uppercase">
              Suất ăn
            </div>
            <div className="text-[11px] font-bold text-slate-700 mt-1.5 pt-1.5 border-t border-slate-200 truncate">
              {formatVND(khacAmount)}
            </div>
          </button>
        </div>
      </div>

      {/* Thống Kê Ca / Bộ Phận */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2 text-xs font-semibold text-slate-600">
          <span className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-amber-600" />
            <span>
              Thống Kê Ca / Bộ Phận — {departmentRows.length} bộ phận lớn (đã
              gom nhóm)
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className="text-amber-700 font-bold bg-amber-50 px-2.5 py-1 rounded-md border border-amber-200">
              Tổng cộng: {grandTotal.total.toLocaleString("vi-VN")} suất
            </span>
            <button
              type="button"
              onClick={exportDeptShiftTable}
              disabled={departmentRows.length === 0}
              className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg text-[11px] font-semibold transition inline-flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" /> Xuất CSV
            </button>
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-900 text-white font-bold uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-3.5 px-4 border-b border-slate-800">
                  Bộ Phận Lớn
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA1 (23H)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA2 (5H)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA3 (7H)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA4 (12H)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA5 (17H)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA6 (19H)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800 text-slate-400">
                  Ngoài Ca
                </th>
                <th className="py-3.5 px-4 border-b border-slate-800 text-center bg-amber-600 text-slate-950 font-extrabold">
                  Tổng Ca
                </th>
                <th className="py-3.5 px-4 border-b border-slate-800 text-right bg-amber-600 text-slate-950 font-extrabold whitespace-nowrap">
                  Tổng Tiền
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-800">
              {departmentRows.map((row) => (
                <tr
                  key={row.departmentName}
                  className="hover:bg-amber-50/40 transition"
                >
                  <td className="py-3 px-4 font-bold text-slate-900 whitespace-nowrap flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                    <span>{row.departmentName}</span>
                  </td>
                  {(
                    [
                      ["CA1", row.ca1],
                      ["CA2", row.ca2],
                      ["CA3", row.ca3],
                      ["CA4", row.ca4],
                      ["CA5", row.ca5],
                      ["CA6", row.ca6],
                      ["Khác", row.khac],
                    ] as [ShiftCode, number][]
                  ).map(([code, count]) => (
                    <td
                      key={code}
                      onClick={() =>
                        count > 0 && openCell(row.departmentName, code)
                      }
                      className={`py-3 px-3 text-center font-mono ${
                        count > 0
                          ? "cursor-pointer font-semibold text-indigo-700 underline decoration-indigo-300 hover:bg-amber-100/80"
                          : "text-slate-300"
                      }`}
                    >
                      {count > 0 ? count.toLocaleString("vi-VN") : "-"}
                    </td>
                  ))}
                  <td
                    onClick={() => openCell(row.departmentName, "ALL")}
                    className="py-3 px-4 text-center font-extrabold text-slate-900 bg-amber-50 cursor-pointer hover:bg-amber-100"
                  >
                    {row.total.toLocaleString("vi-VN")}
                  </td>
                  <td
                    onClick={() => openCell(row.departmentName, "ALL")}
                    className="py-3 px-4 text-right font-mono font-bold text-emerald-800 bg-amber-50 whitespace-nowrap cursor-pointer hover:bg-amber-100"
                  >
                    {formatVND(row.amount)}
                  </td>
                </tr>
              ))}
            </tbody>

            <tfoot className="bg-slate-900 text-white font-extrabold uppercase text-xs">
              <tr>
                <td className="py-4 px-4">TỔNG CỘNG TOÀN BỘ</td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.ca1.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.ca2.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.ca3.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.ca4.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.ca5.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.ca6.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-center font-mono text-slate-400">
                  {grandTotal.khac.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-4 text-center font-mono text-amber-400 text-sm">
                  {grandTotal.total.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-4 text-right font-mono text-emerald-400 text-sm whitespace-nowrap">
                  {formatVND(grandTotal.amount)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-500">
          Bấm vào bất kỳ ô số lượng nào để xem danh sách chi tiết. Mở tab{" "}
          <strong className="text-slate-700">Thống Kê Ca / Bộ Phận</strong> nếu
          cần xem theo bộ phận chi tiết thô.
        </div>
      </div>

      {/* Modal chi tiết dùng chung cho mọi mục trên dashboard */}
      {drilldown && (
        <div
          onClick={() => setDrilldown(null)}
          className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full border border-slate-200 overflow-hidden flex flex-col max-h-[85vh]"
          >
            <div className="bg-slate-900 text-white px-6 py-4 flex justify-between items-start gap-4">
              <div>
                <span className="text-amber-400 font-semibold text-xs uppercase tracking-wider">
                  Chi Tiết Thống Kê
                </span>
                <h3 className="text-lg font-bold">{drilldown.title}</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {drilldown.subtitle}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDrilldown(null)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 bg-slate-50 border-b border-slate-200 text-xs text-slate-600 flex flex-wrap justify-between items-center gap-2">
              <span>
                Tìm thấy{" "}
                <strong className="text-slate-900">
                  {drilldown.rows.length.toLocaleString("vi-VN")}
                </strong>{" "}
                dòng
                {drilldown.kind === "logs" &&
                  drilldown.manual &&
                  drilldown.manual.length > 0 && (
                    <>
                      {" "}và{" "}
                      <strong className="text-amber-700">
                        {manualMealCount(drilldown.manual).toLocaleString(
                          "vi-VN",
                        )}{" "}
                        suất nhập thủ công
                      </strong>
                    </>
                  )}
                {drilldown.rows.length > MODAL_ROW_LIMIT && (
                  <span className="text-amber-700">
                    {" "}
                    — chỉ hiển thị {MODAL_ROW_LIMIT.toLocaleString(
                      "vi-VN",
                    )}{" "}
                    dòng đầu, xuất CSV để lấy đầy đủ
                  </span>
                )}
              </span>
              <span className="flex items-center gap-3">
                <span className="font-mono">
                  Từ {startDate} đến {endDate}
                </span>
                <button
                  type="button"
                  onClick={() => exportDrilldown(drilldown)}
                  className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-[11px] font-semibold transition inline-flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" /> Xuất CSV
                </button>
              </span>
            </div>

            <div className="p-6 overflow-y-auto space-y-3">
              {drilldown.kind === "logs" &&
                drilldown.manual &&
                drilldown.manual.length > 0 && (
                  <ManualMealsTable meals={drilldown.manual} />
                )}
              {drilldown.kind === "logs" && drilldown.rows.length > 0 && (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100 text-slate-700 font-bold uppercase border-b">
                    <tr>
                      <th className="py-2.5 px-3">STT</th>
                      <th className="py-2.5 px-3">Thời Gian Thô</th>
                      <th className="py-2.5 px-3">Ngày Làm Việc</th>
                      <th className="py-2.5 px-3">Ca</th>
                      <th className="py-2.5 px-3">Mã NV</th>
                      <th className="py-2.5 px-3">Tên Nhân Viên</th>
                      <th className="py-2.5 px-3">Bộ Phận</th>
                      <th className="py-2.5 px-3">Máy Chấm</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {drilldown.rows.slice(0, MODAL_ROW_LIMIT).map((log, i) => (
                      <tr key={log.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3 text-slate-400">{i + 1}</td>
                        <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                          {log.logDateTime}
                        </td>
                        <td className="py-2 px-3 text-slate-700">
                          {getCostReportDate(log, shifts)}
                        </td>
                        <td className="py-2 px-3 font-bold text-amber-700">
                          {log.shiftCode}
                        </td>
                        <td className="py-2 px-3 font-mono font-bold text-slate-900">
                          {log.userId}
                        </td>
                        <td className="py-2 px-3 font-medium text-slate-900">
                          {log.userName}
                        </td>
                        <td className="py-2 px-3 text-slate-600">
                          {log.department}
                        </td>
                        <td className="py-2 px-3 text-slate-600">
                          {log.readerName.split("[")[0]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {drilldown.kind === "abnormal" && (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100 text-slate-700 font-bold uppercase border-b">
                    <tr>
                      <th className="py-2.5 px-3">STT</th>
                      <th className="py-2.5 px-3">Ngày Công</th>
                      <th className="py-2.5 px-3">Mã NV</th>
                      <th className="py-2.5 px-3">Tên Nhân Viên</th>
                      <th className="py-2.5 px-3">Bộ Phận</th>
                      <th className="py-2.5 px-3 text-center">Tổng Lượt</th>
                      <th className="py-2.5 px-3 text-center">Bị Trừ</th>
                      <th className="py-2.5 px-3 text-right">Tiền Bị Trừ</th>
                      <th className="py-2.5 px-3 text-center">Không Trừ</th>
                      <th className="py-2.5 px-3">Các Giờ Quẹt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {drilldown.rows.slice(0, MODAL_ROW_LIMIT).map((c, i) => (
                      <tr
                        key={`${c.workDate}_${c.userId}`}
                        className="hover:bg-slate-50"
                      >
                        <td className="py-2 px-3 text-slate-400">{i + 1}</td>
                        <td className="py-2 px-3 font-semibold text-slate-900">
                          {c.workDate}
                        </td>
                        <td className="py-2 px-3 font-mono font-bold text-slate-900">
                          {c.userId}
                        </td>
                        <td className="py-2 px-3 font-medium text-slate-900">
                          {c.userName}
                        </td>
                        <td className="py-2 px-3 text-slate-600">
                          {c.department}
                        </td>
                        <td className="py-2 px-3 text-center font-mono text-slate-700">
                          {c.totalPunches}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <span
                            className={`px-2 py-0.5 rounded font-bold ${
                              c.chargeableCount > 0
                                ? "bg-red-100 text-red-800"
                                : "text-slate-300"
                            }`}
                          >
                            {c.chargeableCount}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-mono font-semibold text-red-700 whitespace-nowrap">
                          {c.chargeableCount > 0
                            ? formatVND(lossAmountOf(c, "BI_TRU"))
                            : "-"}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <span
                            className={`px-2 py-0.5 rounded font-bold ${
                              c.freeCount > 0
                                ? "bg-emerald-100 text-emerald-800"
                                : "text-slate-300"
                            }`}
                          >
                            {c.freeCount}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px] text-slate-600">
                          {c.punches
                            .map(
                              (p) =>
                                `${p.log.logTimeOnly} (${p.log.shiftCode})${p.isLoss ? " ⚠" : ""}`,
                            )
                            .join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {drilldown.kind === "milk" && (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100 text-slate-700 font-bold uppercase border-b">
                    <tr>
                      <th className="py-2.5 px-3">STT</th>
                      <th className="py-2.5 px-3">Ngày</th>
                      <th className="py-2.5 px-3">Ca</th>
                      <th className="py-2.5 px-3">Loại Sữa</th>
                      <th className="py-2.5 px-3 text-center">Số Lượng</th>
                      <th className="py-2.5 px-3 text-right">Đơn Giá</th>
                      <th className="py-2.5 px-3 text-right">Thành Tiền</th>
                      <th className="py-2.5 px-3">Nhà Cung Cấp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {drilldown.rows.slice(0, MODAL_ROW_LIMIT).map((m, i) => (
                      <tr key={m.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3 text-slate-400">{i + 1}</td>
                        <td className="py-2 px-3 font-semibold text-slate-900">
                          {m.date}
                        </td>
                        <td className="py-2 px-3 font-semibold text-cyan-800">
                          {SUPPLY_SHIFT_LABEL[m.milkShift] ?? m.milkShift}
                        </td>
                        <td className="py-2 px-3 text-slate-700">
                          {m.milkType}
                        </td>
                        <td className="py-2 px-3 text-center font-mono">
                          {m.quantity.toLocaleString("vi-VN")}
                        </td>
                        <td className="py-2 px-3 text-right font-mono">
                          {formatVND(m.unitPrice)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono font-bold text-cyan-700">
                          {formatVND(m.totalAmount)}
                        </td>
                        <td className="py-2 px-3 text-slate-600">
                          {m.supplier}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {drilldown.rows.length === 0 && (
                <div className="py-10 text-center text-sm text-slate-500">
                  Không có dữ liệu trong khoảng thời gian đang chọn.
                </div>
              )}
            </div>

            <div className="p-4 bg-slate-100 border-t border-slate-200 text-right">
              <button
                type="button"
                onClick={() => setDrilldown(null)}
                className="px-4 py-2 bg-slate-800 text-white rounded-lg text-xs font-semibold hover:bg-slate-700 transition"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
