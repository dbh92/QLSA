import React, { useMemo, useState } from "react";
import {
  MealLog,
  ShiftCode,
  ShiftInfo,
  MealPriceItem,
  ShiftMealCategory,
  BirthdayConfig,
  DepartmentMapping,
  ManualMealEntry,
} from "../types";
import { Globe2, Users, Download, ChevronRight, Cake } from "lucide-react";
import {
  formatVND,
  exportToCSV,
  isKoreanStaffLog,
  buildMealPricing,
  buildShiftCategoryLookup,
  classifyMeal,
  buildBirthdayPriceMap,
  classifyManualEntries,
  getMealShiftDate,
  getCostReportDate,
  isBirthdayMealLog,
  manualMealCount,
  MealCategory,
  MEAL_CATEGORY_META,
} from "../services/mealEngine";

interface KoreanVsVietnameseViewProps {
  logs: MealLog[];
  shifts: ShiftInfo[];
  mappings: DepartmentMapping[];
  priceItems: MealPriceItem[];
  /** Bảng gán loại suất theo ca (tab Cấu Hình Giá Suất Ăn). */
  shiftMealCategories: ShiftMealCategory[];
  birthdayConfigs: BirthdayConfig[];
  /** Suất nhập tay — suất ăn thật, phải nằm trong bảng này như lượt quẹt. */
  manualEntries: ManualMealEntry[];
  /** Các ca được ăn suất sinh nhật (SA_SystemSetting: BIRTHDAY_SHIFTS). */
  birthdayShifts: Set<ShiftCode>;
  /** Biên lọc chính xác tới giây, "YYYY-MM-DD HH:mm:ss". */
  startDateTime: string;
  endDateTime: string;
  startDate: string;
  endDate: string;
}

/** Số suất của từng loại + thành tiền, dùng cho một ngày hoặc một ca. */
interface CategoryBucket {
  KO_COM: number;
  KO_MY: number;
  VN_CHINH: number;
  VN_PHU: number;
  VN_SINHNHAT: number;
  total: number;
  koreanAmount: number;
  vietnameseAmount: number;
}

const emptyBucket = (): CategoryBucket => ({
  KO_COM: 0,
  KO_MY: 0,
  VN_CHINH: 0,
  VN_PHU: 0,
  VN_SINHNHAT: 0,
  total: 0,
  koreanAmount: 0,
  vietnameseAmount: 0,
});

const isKoreanCategory = (c: MealCategory) => c === "KO_COM" || c === "KO_MY";

/** Thứ tự ca hiển thị trong phần chi tiết của một ngày. */
const SHIFT_ORDER: ShiftCode[] = [
  "CA1",
  "CA2",
  "CA3",
  "CA4",
  "CA5",
  "CA6",
  "Khác",
];

interface DayRow {
  date: string;
  isBirthday: boolean;
  bucket: CategoryBucket;
  byShift: Map<ShiftCode, CategoryBucket>;
}

/** Một ô số lượng: 0 thì làm mờ cho dễ đọc bảng. */
const CountCell: React.FC<{ value: number; className?: string }> = ({
  value,
  className = "",
}) => (
  <td
    className={`py-2.5 px-3 text-center font-mono ${
      value > 0 ? `font-semibold ${className}` : "text-slate-300"
    }`}
  >
    {value > 0 ? value.toLocaleString("vi-VN") : "-"}
  </td>
);

export const KoreanVsVietnameseView: React.FC<KoreanVsVietnameseViewProps> = ({
  logs,
  shifts,
  mappings,
  priceItems,
  shiftMealCategories,
  birthdayConfigs,
  manualEntries,
  birthdayShifts,
  startDateTime,
  endDateTime,
  startDate,
  endDate,
}) => {
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  const pricing = useMemo(() => buildMealPricing(priceItems), [priceItems]);

  const shiftCategories = useMemo(
    () => buildShiftCategoryLookup(shiftMealCategories),
    [shiftMealCategories],
  );

  /* Ngày sinh nhật -> đơn giá của chính ngày đó (tab Cấu Hình Sinh Nhật).
     Vừa là danh sách ngày, vừa là nguồn đơn giá — không còn một giá suất sinh
     nhật chung nào trong SA_MealPrice để tra. */
  const birthdayPrices = useMemo(
    () => buildBirthdayPriceMap(birthdayConfigs),
    [birthdayConfigs],
  );
  const birthdayDateSet = birthdayPrices;

  const filteredLogs = useMemo(
    () =>
      logs.filter(
        (l) => l.logDateTime >= startDateTime && l.logDateTime <= endDateTime,
      ),
    [logs, startDateTime, endDateTime],
  );

  /* Suất nhập tay (tab Nhập Thủ Công Ca) là suất ăn thật, chỉ thiếu lượt
     quẹt — cả số suất lẫn thành tiền của bảng này phải cộng chúng vào. */
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

  const manualTotal = manualMealCount(manualMeals);

  /** Nhãn khung giờ của từng ca, lấy từ SA_Shift. */
  const shiftLabel = useMemo(() => {
    const map = new Map<string, string>();
    shifts.forEach((s) =>
      map.set(s.code, `${s.startTime.slice(0, 5)} - ${s.endTime.slice(0, 5)}`),
    );
    return (code: ShiftCode) => map.get(code) || "Ngoài khung giờ";
  }, [shifts]);

  /* ---------------------------------------------------------------------
     Gom theo NGÀY CÔNG, trong mỗi ngày gom tiếp theo CA — một lượt duyệt.
     --------------------------------------------------------------------- */
  const dayRows = useMemo(() => {
    const map = new Map<string, DayRow>();

    filteredLogs.forEach((log) => {
      const isKoreanStaff = isKoreanStaffLog(log, mappings);
      const isBirthday = isBirthdayMealLog(log, birthdayDateSet, shifts, birthdayShifts);
      const category = classifyMeal(
        log.shiftCode,
        isKoreanStaff,
        isBirthday,
        shiftCategories,
      );
      /* Suất sinh nhật ăn giá CỦA NGÀY ĐÓ; ngày bỏ trống giá mới rơi về
         SA_MealPrice. */
      const birthdayPrice = isBirthday
        ? (birthdayPrices.get(getMealShiftDate(log, shifts)) ?? 0)
        : 0;
      const amount =
        birthdayPrice > 0 ? birthdayPrice : pricing[category];

      /* Gom theo NGÀY LÀM VIỆC (22:50 hôm trước -> 22:50): lượt CA1 lúc 25
         23:10 thuộc ngày 26, cùng dòng với các ca ban ngày của ngày 26. */
      const workDate = getCostReportDate(log, shifts);
      if (!map.has(workDate)) {
        map.set(workDate, {
          date: workDate,
          isBirthday,
          bucket: emptyBucket(),
          byShift: new Map(),
        });
      }
      const day = map.get(workDate)!;

      if (!day.byShift.has(log.shiftCode)) {
        day.byShift.set(log.shiftCode, emptyBucket());
      }

      for (const bucket of [day.bucket, day.byShift.get(log.shiftCode)!]) {
        bucket[category] += 1;
        bucket.total += 1;
        if (isKoreanCategory(category)) bucket.koreanAmount += amount;
        else bucket.vietnameseAmount += amount;
      }
    });

    /* Suất nhập tay: đúng ngày, đúng ca, đúng loại suất đã giải sẵn. Không
       xét sinh nhật nên `isBirthday` của ngày giữ nguyên theo lượt quẹt. */
    manualMeals.forEach((m) => {
      if (!map.has(m.reportDate)) {
        map.set(m.reportDate, {
          date: m.reportDate,
          isBirthday: false,
          bucket: emptyBucket(),
          byShift: new Map(),
        });
      }
      const day = map.get(m.reportDate)!;

      if (!day.byShift.has(m.shiftCode)) {
        day.byShift.set(m.shiftCode, emptyBucket());
      }

      for (const bucket of [day.bucket, day.byShift.get(m.shiftCode)!]) {
        bucket[m.category] += m.quantity;
        bucket.total += m.quantity;
        if (isKoreanCategory(m.category)) bucket.koreanAmount += m.amount;
        else bucket.vietnameseAmount += m.amount;
      }
    });

    return Array.from(map.values()).sort((a, b) =>
      b.date.localeCompare(a.date),
    );
  }, [filteredLogs, manualMeals, mappings, birthdayDateSet, pricing, shiftCategories, shifts, birthdayShifts]);

  /** Dòng TỔNG CỘNG của toàn khoảng thời gian. */
  const grandTotal = useMemo(
    () =>
      dayRows.reduce((acc, d) => {
        acc.KO_COM += d.bucket.KO_COM;
        acc.KO_MY += d.bucket.KO_MY;
        acc.VN_CHINH += d.bucket.VN_CHINH;
        acc.VN_PHU += d.bucket.VN_PHU;
        acc.VN_SINHNHAT += d.bucket.VN_SINHNHAT;
        acc.total += d.bucket.total;
        acc.koreanAmount += d.bucket.koreanAmount;
        acc.vietnameseAmount += d.bucket.vietnameseAmount;
        return acc;
      }, emptyBucket()),
    [dayRows],
  );

  const koreanTotalCount = grandTotal.KO_COM + grandTotal.KO_MY;
  const vietnameseTotalCount =
    grandTotal.VN_CHINH + grandTotal.VN_PHU + grandTotal.VN_SINHNHAT;

  const handleExportCSV = () => {
    const headers = [
      "Ngày công",
      "Ca",
      "Cơm Hàn (suất)",
      "Mỳ Hàn (suất)",
      "Bữa chính VN (suất)",
      "Bữa phụ VN (suất)",
      "Suất sinh nhật",
      "Tổng suất",
      "Tiền Hàn (VNĐ)",
      "Tiền Việt (VNĐ)",
      "Tổng tiền (VNĐ)",
    ];

    const rows: (string | number)[][] = [];
    dayRows.forEach((d) => {
      const line = (ca: string, b: CategoryBucket) => [
        d.date,
        ca,
        b.KO_COM,
        b.KO_MY,
        b.VN_CHINH,
        b.VN_PHU,
        b.VN_SINHNHAT,
        b.total,
        b.koreanAmount,
        b.vietnameseAmount,
        b.koreanAmount + b.vietnameseAmount,
      ];

      rows.push(line("TẤT CẢ CA", d.bucket));
      SHIFT_ORDER.forEach((code) => {
        const b = d.byShift.get(code);
        if (b) rows.push(line(code, b));
      });
    });

    rows.push([
      "TỔNG CỘNG",
      "",
      grandTotal.KO_COM,
      grandTotal.KO_MY,
      grandTotal.VN_CHINH,
      grandTotal.VN_PHU,
      grandTotal.VN_SINHNHAT,
      grandTotal.total,
      grandTotal.koreanAmount,
      grandTotal.vietnameseAmount,
      grandTotal.koreanAmount + grandTotal.vietnameseAmount,
    ]);

    exportToCSV(`Han_Quoc_vs_Viet_Nam_${startDate}_${endDate}`, headers, rows);
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <Globe2 className="w-5 h-5 text-red-600" />
            <h2 className="text-xl font-bold text-slate-800">
              Báo Cáo Thống Kê Suất Ăn Người Hàn &amp; Người Việt
            </h2>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Phân loại theo <strong>bộ phận lớn</strong>: nhân sự thuộc bộ phận
            KR tính giá suất Hàn, các bộ phận còn lại tính giá suất Việt — máy
            chấm nào không ảnh hưởng.
            {manualTotal > 0 && (
              <>
                {" "}Đã gồm{" "}
                <strong className="text-amber-700">
                  {manualTotal.toLocaleString("vi-VN")} suất nhập thủ công
                </strong>{" "}
                theo nhóm nhân sự đã chọn khi nhập.
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="px-3 py-1.5 bg-red-50 text-red-700 rounded-xl border border-red-200 text-xs font-bold">
            Hàn Quốc: {koreanTotalCount.toLocaleString("vi-VN")} suất
          </div>
          <div className="px-3 py-1.5 bg-blue-50 text-blue-700 rounded-xl border border-blue-200 text-xs font-bold">
            Việt Nam: {vietnameseTotalCount.toLocaleString("vi-VN")} suất
          </div>
        </div>
      </div>

      {/* Bảng đơn giá đang áp dụng */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-3">
          Đơn Giá Áp Dụng Theo Ca
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {(
            [
              ["KO_COM", "CA3 + CA4 của người Hàn", "bg-red-50 border-red-200"],
              [
                "KO_MY",
                "Các ca còn lại của người Hàn",
                "bg-orange-50 border-orange-200",
              ],
              [
                "VN_CHINH",
                "CA1 + CA4 của người Việt",
                "bg-indigo-50 border-indigo-200",
              ],
              [
                "VN_PHU",
                "Các ca còn lại của người Việt",
                "bg-sky-50 border-sky-200",
              ],
              [
                "VN_SINHNHAT",
                "Ngày sinh nhật tập thể",
                "bg-amber-50 border-amber-200",
              ],
            ] as [MealCategory, string, string][]
          ).map(([cat, note, tone]) => (
            <div key={cat} className={`p-3 rounded-xl border ${tone}`}>
              <div className="text-[11px] font-bold text-slate-700">
                {MEAL_CATEGORY_META[cat].label}
              </div>
              <div className="text-sm font-extrabold text-slate-900 mt-1">
                {formatVND(pricing[cat])}
              </div>
              <div className="text-[10px] text-slate-500 mt-1 leading-tight">
                {note}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bảng thống kê theo ngày */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2 text-xs font-semibold text-slate-600">
          <span>
            Thống kê {dayRows.length} ngày công — bấm vào một ngày để xem chi
            tiết 6 ca.
          </span>
          <div className="flex items-center gap-3">
            <span className="text-amber-700 font-bold bg-amber-50 px-2.5 py-1 rounded-md border border-amber-200">
              Tổng: {grandTotal.total.toLocaleString("vi-VN")} suất •{" "}
              {formatVND(grandTotal.koreanAmount + grandTotal.vietnameseAmount)}
            </span>
            <button
              onClick={handleExportCSV}
              className="flex items-center space-x-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Xuất CSV</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-900 text-white font-bold uppercase tracking-wider text-[11px]">
              <tr>
                <th
                  rowSpan={2}
                  className="py-2.5 px-4 border-b border-slate-800 align-bottom"
                >
                  Ngày Công
                </th>
                <th
                  colSpan={3}
                  className="py-2 px-3 text-center bg-red-900/70 border-b border-slate-800"
                >
                  Người Hàn Quốc
                </th>
                <th
                  colSpan={4}
                  className="py-2 px-3 text-center bg-indigo-900/70 border-b border-slate-800"
                >
                  Người Việt Nam
                </th>
                <th
                  colSpan={2}
                  className="py-2 px-3 text-center bg-amber-600 text-slate-950 border-b border-slate-800"
                >
                  Tổng Cộng
                </th>
              </tr>
              <tr>
                <th className="py-2.5 px-3 text-center bg-red-900/40 border-b border-slate-800">
                  Cơm Hàn
                </th>
                <th className="py-2.5 px-3 text-center bg-red-900/40 border-b border-slate-800">
                  Mỳ Hàn
                </th>
                <th className="py-2.5 px-3 text-right bg-red-900/40 border-b border-slate-800 whitespace-nowrap">
                  Thành Tiền
                </th>
                <th className="py-2.5 px-3 text-center bg-indigo-900/40 border-b border-slate-800">
                  Bữa Chính
                </th>
                <th className="py-2.5 px-3 text-center bg-indigo-900/40 border-b border-slate-800">
                  Bữa Phụ
                </th>
                <th className="py-2.5 px-3 text-center bg-indigo-900/40 border-b border-slate-800">
                  Sinh Nhật
                </th>
                <th className="py-2.5 px-3 text-right bg-indigo-900/40 border-b border-slate-800 whitespace-nowrap">
                  Thành Tiền
                </th>
                <th className="py-2.5 px-3 text-center bg-amber-600 text-slate-950 border-b border-slate-800">
                  Suất
                </th>
                <th className="py-2.5 px-4 text-right bg-amber-600 text-slate-950 border-b border-slate-800 whitespace-nowrap">
                  Thành Tiền
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100 text-slate-800">
              {dayRows.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    Không có dữ liệu chấm ăn trong khoảng thời gian đang chọn.
                  </td>
                </tr>
              )}

              {dayRows.map((day) => {
                const isOpen = expandedDate === day.date;
                return (
                  <React.Fragment key={day.date}>
                    <tr
                      onClick={() => setExpandedDate(isOpen ? null : day.date)}
                      className={`cursor-pointer transition ${
                        isOpen ? "bg-amber-50" : "hover:bg-amber-50/40"
                      }`}
                    >
                      <td className="py-2.5 px-4 font-bold text-slate-900 whitespace-nowrap">
                        <span className="flex items-center gap-1.5">
                          <ChevronRight
                            className={`w-3.5 h-3.5 text-slate-400 transition-transform ${
                              isOpen ? "rotate-90" : ""
                            }`}
                          />
                          {day.date}
                          {day.isBirthday && (
                            <span
                              title="Ngày sinh nhật tập thể"
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold"
                            >
                              <Cake className="w-3 h-3" /> SN
                            </span>
                          )}
                        </span>
                      </td>

                      <CountCell
                        value={day.bucket.KO_COM}
                        className="text-red-700"
                      />
                      <CountCell
                        value={day.bucket.KO_MY}
                        className="text-orange-700"
                      />
                      <td className="py-2.5 px-3 text-right font-mono font-semibold text-red-800 whitespace-nowrap">
                        {formatVND(day.bucket.koreanAmount)}
                      </td>

                      <CountCell
                        value={day.bucket.VN_CHINH}
                        className="text-indigo-700"
                      />
                      <CountCell
                        value={day.bucket.VN_PHU}
                        className="text-sky-700"
                      />
                      <CountCell
                        value={day.bucket.VN_SINHNHAT}
                        className="text-amber-700"
                      />
                      <td className="py-2.5 px-3 text-right font-mono font-semibold text-indigo-800 whitespace-nowrap">
                        {formatVND(day.bucket.vietnameseAmount)}
                      </td>

                      <td className="py-2.5 px-3 text-center font-extrabold text-slate-900 bg-amber-50">
                        {day.bucket.total.toLocaleString("vi-VN")}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono font-extrabold text-emerald-800 bg-amber-50 whitespace-nowrap">
                        {formatVND(
                          day.bucket.koreanAmount + day.bucket.vietnameseAmount,
                        )}
                      </td>
                    </tr>

                    {/* Chi tiết 6 ca của ngày đang mở */}
                    {isOpen &&
                      SHIFT_ORDER.map((code) => {
                        const b = day.byShift.get(code);
                        if (!b) return null;
                        return (
                          <tr
                            key={`${day.date}_${code}`}
                            className="bg-slate-50/80 text-[11px]"
                          >
                            <td className="py-2 pl-11 pr-4 text-slate-600 whitespace-nowrap">
                              <span className="font-bold text-slate-700">
                                {code}
                              </span>{" "}
                              <span className="text-slate-400">
                                {shiftLabel(code)}
                              </span>
                            </td>
                            <CountCell value={b.KO_COM} className="text-red-700" />
                            <CountCell
                              value={b.KO_MY}
                              className="text-orange-700"
                            />
                            <td className="py-2 px-3 text-right font-mono text-red-800 whitespace-nowrap">
                              {formatVND(b.koreanAmount)}
                            </td>
                            <CountCell
                              value={b.VN_CHINH}
                              className="text-indigo-700"
                            />
                            <CountCell value={b.VN_PHU} className="text-sky-700" />
                            <CountCell
                              value={b.VN_SINHNHAT}
                              className="text-amber-700"
                            />
                            <td className="py-2 px-3 text-right font-mono text-indigo-800 whitespace-nowrap">
                              {formatVND(b.vietnameseAmount)}
                            </td>
                            <td className="py-2 px-3 text-center font-bold text-slate-700">
                              {b.total.toLocaleString("vi-VN")}
                            </td>
                            <td className="py-2 px-4 text-right font-mono font-bold text-emerald-800 whitespace-nowrap">
                              {formatVND(b.koreanAmount + b.vietnameseAmount)}
                            </td>
                          </tr>
                        );
                      })}
                  </React.Fragment>
                );
              })}
            </tbody>

            <tfoot className="bg-slate-900 text-white font-extrabold uppercase text-xs">
              <tr>
                <td className="py-4 px-4">Tổng Cộng Toàn Bộ</td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.KO_COM.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.KO_MY.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-right font-mono text-red-300 whitespace-nowrap">
                  {formatVND(grandTotal.koreanAmount)}
                </td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.VN_CHINH.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.VN_PHU.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-center font-mono">
                  {grandTotal.VN_SINHNHAT.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-3 text-right font-mono text-indigo-300 whitespace-nowrap">
                  {formatVND(grandTotal.vietnameseAmount)}
                </td>
                <td className="py-4 px-3 text-center font-mono text-amber-400">
                  {grandTotal.total.toLocaleString("vi-VN")}
                </td>
                <td className="py-4 px-4 text-right font-mono text-emerald-400 whitespace-nowrap">
                  {formatVND(
                    grandTotal.koreanAmount + grandTotal.vietnameseAmount,
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Chú thích */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 text-[11px] text-slate-500 flex items-start gap-2">
        <Users className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
        <span>
          Người Hàn = thuộc <strong>bộ phận lớn KR</strong>, tính giá suất Hàn ở
          mọi máy chấm; khách hoặc bộ phận khác quẹt máy CT Korea (TA-102) vẫn
          tính giá người Việt. Suất ăn của người Việt vào ngày có trong Cấu Hình Sinh
          Nhật được tính theo giá suất đặc biệt thay cho giá theo ca — những
          ngày đó có nhãn <strong>SN</strong>.
        </span>
      </div>
    </div>
  );
};
