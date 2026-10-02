import React, { useState, useMemo, useEffect } from "react";
import {
  MealLog,
  ShiftCode,
  DepartmentMapping,
  MealPriceItem,
  ShiftMealCategory,
  ShiftInfo,
  BirthdayConfig,
} from "../types";
import {
  evaluatePunchDays,
  EvaluatedPunch,
  LossCharge,
  FREE_DUP_WINDOW_MINUTES,
  PunchLossReason,
  getLogLargeDepartment,
  isKoreanStaffLog,
  buildBirthdayPriceMap,
  buildMealPricing,
  getMealShiftDate,
  buildShiftCategoryLookup,
  classifyMeal,
  isBirthdayMealLog,
  MEAL_CATEGORY_META,
  formatVND,
  exportToCSV,
} from "../services/mealEngine";
import { exportLossStatsWorkbook } from "./lossStatsWorkbook";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock,
  ShieldAlert,
  Users,
  Coins,
  Download,
  CopyX,
  BadgeCheck,
  CalendarDays,
  FileSpreadsheet,
} from "lucide-react";

/** Hạn mức chuẩn: mỗi người tối đa 3 ca hợp lệ trong một ngày làm việc. */
const PUNCH_LIMIT = 3;

const LOSS_LABEL: Record<PunchLossReason, string> = {
  TRUNG_CA: "TRÙNG CA",
  VUOT_HAN_MUC: `VƯỢT ${PUNCH_LIMIT} CA`,
};

const CHARGE_LABEL: Record<LossCharge, string> = {
  BI_TRU: "Bị trừ tiền",
  KHONG_TRU: "Không bị trừ tiền",
};

/** Ô thống kê đang được chọn — quyết định bảng dưới liệt kê nhóm nào. */
type ChargeFilter = "ALL" | LossCharge;

/** Nhãn của ba lựa chọn phạm vi ở bảng thống kê theo ngày × ca. */
const CHARGE_FILTER_LABEL: Record<ChargeFilter, string> = {
  BI_TRU: CHARGE_LABEL.BI_TRU,
  KHONG_TRU: CHARGE_LABEL.KHONG_TRU,
  ALL: "Tất cả",
};

/** Hậu tố tên file xuất ra — không dấu, dùng chung cho CSV lẫn Excel. */
const CHARGE_FILTER_SLUG: Record<ChargeFilter, string> = {
  BI_TRU: "Bi_Tru_Tien",
  KHONG_TRU: "Khong_Bi_Tru_Tien",
  ALL: "Tat_Ca",
};

/** "2026-09-08" -> "08/09/2026", đúng cách bảng kê gửi nhà ăn ghi ngày. */
const viDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Một dòng của bảng thống kê: một ngày làm việc, số lượt mất mát từng ca. */
interface LossStatRow {
  workDate: string;
  byShift: Record<string, number>;
  total: number;
}

interface AbnormalPunchesViewProps {
  logs: MealLog[];
  mappings: DepartmentMapping[];
  /** Danh mục ca (SA_Shift) — cần để biết ca nào vắt qua nửa đêm. */
  shifts: ShiftInfo[];
  priceItems: MealPriceItem[];
  /** Bảng gán loại suất theo ca (tab Cấu Hình Giá Suất Ăn). */
  shiftMealCategories: ShiftMealCategory[];
  birthdayConfigs: BirthdayConfig[];
  /** Các ca được ăn suất sinh nhật (SA_SystemSetting: BIRTHDAY_SHIFTS). */
  birthdayShifts: Set<ShiftCode>;
  /** Biên lọc chính xác tới giây, "YYYY-MM-DD HH:mm:ss". */
  startDateTime: string;
  endDateTime: string;
  startDate: string;
  endDate: string;
}

/**
 * Một dòng của bảng: các lượt mất mát CÙNG MỘT PHÂN LOẠI của một nhân sự
 * trong một ngày làm việc.
 *
 * Đơn vị là (ngày làm việc × nhân sự × phân loại) chứ không phải cả ngày công
 * như trước: một ngày có thể vừa có lượt bị trừ tiền vừa có lượt không bị
 * trừ, gộp chung thì cột "Phân loại" không biết ghi gì và bấm vào ô thống kê
 * sẽ ra một danh sách lẫn lộn.
 */
interface LossRow {
  key: string;
  charge: LossCharge;
  workDate: string;
  userId: string;
  userName: string;
  department: string;
  largeDepartment: string;
  /** Toàn bộ lượt quẹt của ngày làm việc — giữ để xem bối cảnh khi mở chi tiết. */
  punches: EvaluatedPunch[];
  totalPunches: number;
  /** Các lượt mất mát THUỘC PHÂN LOẠI NÀY. */
  lossPunches: EvaluatedPunch[];
  dupShiftCount: number;
  overLimitCount: number;
  lossCount: number;
  lossAmount: number;
}

/** "8 phút 12 giây" — khoảng cách tới lượt quẹt liền trước. */
function formatGap(minutes: number | null): string {
  if (minutes === null) return "";
  const totalSeconds = Math.round(minutes * 60);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m === 0) return `${s} giây`;
  return s === 0 ? `${m} phút` : `${m} phút ${s} giây`;
}

export const AbnormalPunchesView: React.FC<AbnormalPunchesViewProps> = ({
  logs,
  mappings,
  shifts,
  priceItems,
  shiftMealCategories,
  birthdayConfigs,
  birthdayShifts,
  startDateTime,
  endDateTime,
  startDate,
  endDate,
}) => {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [chargeFilter, setChargeFilter] = useState<ChargeFilter>("ALL");
  /* Phạm vi của BẢNG THỐNG KÊ theo ngày × ca — độc lập với bộ lọc của danh
     sách chi tiết bên dưới, vì hai câu hỏi khác nhau: bảng thống kê để nhìn
     tổng thể một tháng, danh sách để đi soi từng trường hợp. */
  const [statCharge, setStatCharge] = useState<ChargeFilter>("ALL");
  /* `exceljs` nạp động ~950KB nên lần bấm đầu mất một nhịp — khoá nút lại để
     người dùng không bấm chồng và tải về hai file giống nhau. */
  const [exportingStats, setExportingStats] = useState(false);

  const pricing = useMemo(() => buildMealPricing(priceItems), [priceItems]);

  const shiftCategories = useMemo(
    () => buildShiftCategoryLookup(shiftMealCategories),
    [shiftMealCategories],
  );

  /* Ngày sinh nhật -> đơn giá của chính ngày đó (tab Cấu Hình Sinh Nhật) —
     tiền mất mát của một suất sinh nhật phải là giá của ngày hôm đó, không
     phải một con số chung. */
  const birthdayPrices = useMemo(
    () => buildBirthdayPriceMap(birthdayConfigs),
    [birthdayConfigs],
  );
  const birthdayDateSet = birthdayPrices;

  // Filter logs in date range
  const filteredLogs = useMemo(() => {
    return logs.filter(
      (l) => l.logDateTime >= startDateTime && l.logDateTime <= endDateTime,
    );
  }, [logs, startDateTime, endDateTime]);

  /** Loại suất của một lượt quẹt — quyết định đơn giá của lượt đó. */
  const categoryOfLog = (l: MealLog) =>
    classifyMeal(
      l.shiftCode,
      isKoreanStaffLog(l, mappings),
      isBirthdayMealLog(l, birthdayDateSet, shifts, birthdayShifts),
      shiftCategories,
    );

  const priceOfLog = (l: MealLog) => {
    if (isBirthdayMealLog(l, birthdayPrices, shifts, birthdayShifts)) {
      const p = birthdayPrices.get(getMealShiftDate(l, shifts)) ?? 0;
      if (p > 0) return p;
    }
    return pricing[categoryOfLog(l)];
  };

  /* ---------------------------------------------------------------------
     Chỉ giữ những ngày làm việc CÓ mất mát, rồi tách theo phân loại.
     --------------------------------------------------------------------- */
  const lossRows = useMemo<LossRow[]>(() => {
    const out: LossRow[] = [];

    evaluatePunchDays(filteredLogs, shifts, PUNCH_LIMIT)
      .filter((c) => c.lossCount > 0)
      .forEach((c) => {
        /* Mọi lượt quẹt trong cùng một ngày làm việc là của cùng một nhân sự
           nên lấy bộ phận lớn đã giải sẵn ở lượt đầu tiên. */
        const largeDepartment = getLogLargeDepartment(c.punches[0].log, mappings);

        (["BI_TRU", "KHONG_TRU"] as LossCharge[]).forEach((charge) => {
          const lossPunches = c.punches.filter(
            (p) => p.isLoss && p.charge === charge,
          );
          if (lossPunches.length === 0) return;

          out.push({
            key: `${c.workDate}_${c.userId}_${charge}`,
            charge,
            workDate: c.workDate,
            userId: c.userId,
            userName: c.userName,
            department: c.department,
            largeDepartment,
            punches: c.punches,
            totalPunches: c.totalPunches,
            lossPunches,
            dupShiftCount: lossPunches.filter((p) => p.reason === "TRUNG_CA")
              .length,
            overLimitCount: lossPunches.filter(
              (p) => p.reason === "VUOT_HAN_MUC",
            ).length,
            lossCount: lossPunches.length,
            lossAmount: lossPunches.reduce(
              (sum, p) => sum + priceOfLog(p.log),
              0,
            ),
          });
        });
      });

    return out;
  }, [
    filteredLogs,
    shifts,
    mappings,
    birthdayPrices,
    pricing,
    shiftCategories,
    birthdayShifts,
  ]);

  /** Số tổng của từng phân loại — hai ô thống kê bấm được. */
  const summary = useMemo(() => {
    const bucket = (charge: LossCharge) => {
      const rows = lossRows.filter((r) => r.charge === charge);
      return {
        rows: rows.length,
        count: rows.reduce((a, r) => a + r.lossCount, 0),
        amount: rows.reduce((a, r) => a + r.lossAmount, 0),
      };
    };

    return {
      people: new Set(lossRows.map((r) => r.userId)).size,
      lossCount: lossRows.reduce((a, r) => a + r.lossCount, 0),
      chargeable: bucket("BI_TRU"),
      free: bucket("KHONG_TRU"),
    };
  }, [lossRows]);

  /* ---------------------------------------------------------------------
     Bảng thống kê số lượt mất mát theo NGÀY LÀM VIỆC × CA.

     Cột ca lấy thẳng từ SA_Shift (đã sắp theo SortOrder) nên thêm/bớt ca
     trong danh mục là bảng đổi theo, không phải sửa code. Cột 'Khác' — lượt
     quẹt ngoài mọi khung giờ — chỉ hiện khi thật sự có số, để bảng không
     thừa một cột rỗng ở mọi kỳ.

     Đơn vị đếm là LƯỢT MẤT MÁT (`lossPunches`), không phải số dòng: một
     người có thể mất nhiều suất trong cùng một ngày làm việc.
     --------------------------------------------------------------------- */
  const statShiftCodes = useMemo<ShiftCode[]>(() => {
    const codes = shifts.map((s) => s.code);
    return codes.length > 0
      ? codes
      : (["CA1", "CA2", "CA3", "CA4", "CA5", "CA6"] as ShiftCode[]);
  }, [shifts]);

  const lossStats = useMemo(() => {
    const byDate = new Map<string, LossStatRow>();
    const byShiftTotal: Record<string, number> = {};
    let grandTotal = 0;

    lossRows
      .filter((r) => statCharge === "ALL" || r.charge === statCharge)
      .forEach((r) => {
        if (!byDate.has(r.workDate)) {
          byDate.set(r.workDate, {
            workDate: r.workDate,
            byShift: {},
            total: 0,
          });
        }
        const row = byDate.get(r.workDate)!;

        r.lossPunches.forEach((p) => {
          const code = p.log.shiftCode;
          row.byShift[code] = (row.byShift[code] ?? 0) + 1;
          row.total += 1;
          byShiftTotal[code] = (byShiftTotal[code] ?? 0) + 1;
          grandTotal += 1;
        });
      });

    /* Ca ngoài khung giờ chỉ thành cột khi có số liệu thật. */
    const columns: ShiftCode[] = [...statShiftCodes];
    if (byShiftTotal["Khác"] > 0) columns.push("Khác" as ShiftCode);

    return {
      columns,
      rows: Array.from(byDate.values()).sort((a, b) =>
        a.workDate.localeCompare(b.workDate),
      ),
      byShiftTotal,
      grandTotal,
    };
  }, [lossRows, statCharge, statShiftCodes]);

  /**
   * Bảng dưới: mặc định gồm cả hai phân loại nhưng xếp "Bị trừ tiền" lên
   * trước — đó là nhóm cần xử lý. Bấm một ô thống kê thì chỉ còn nhóm đó.
   */
  const visibleRows = useMemo(() => {
    const rows =
      chargeFilter === "ALL"
        ? [...lossRows]
        : lossRows.filter((r) => r.charge === chargeFilter);

    return rows.sort((a, b) => {
      if (a.charge !== b.charge) return a.charge === "BI_TRU" ? -1 : 1;
      if (a.workDate !== b.workDate) return b.workDate.localeCompare(a.workDate);
      return a.userName.localeCompare(b.userName, "vi") ||
        a.userId.localeCompare(b.userId);
    });
  }, [lossRows, chargeFilter]);

  /* Dòng đang mở có thể biến mất khi đổi bộ lọc — đóng lại để không giữ một
     khoá trỏ vào dòng không còn hiển thị. */
  useEffect(() => {
    setExpandedKey(null);
  }, [chargeFilter, startDateTime, endDateTime]);

  const toggleFilter = (charge: LossCharge) =>
    setChargeFilter((cur) => (cur === charge ? "ALL" : charge));

  /** Giờ + ca của mọi lượt quẹt trong ngày làm việc. */
  const punchTimes = (row: LossRow) =>
    row.punches
      .map((p) => `${p.log.logTimeOnly} (${p.log.shiftCode})`)
      .join(" | ");

  /** Chỉ thời gian, ca và lý do — đúng như yêu cầu của bảng kê. */
  const lossDetail = (row: LossRow) =>
    row.lossPunches
      .map(
        (p) => `${p.log.logTimeOnly} (${p.log.shiftCode}) ${LOSS_LABEL[p.reason!]}`,
      )
      .join(" | ");

  /**
   * Xuất bảng thống kê ngày × ca ra Excel.
   *
   * Xuất ĐÚNG những gì đang hiện: cùng cột ca, cùng dòng ngày và cùng phạm vi
   * (Bị trừ / Không trừ / Tất cả) mà người dùng đang chọn — giống cách nút CSV
   * của danh sách chi tiết bên dưới chỉ xuất phần đang lọc. Phạm vi được ghi
   * vào cả tên file lẫn dòng tiêu đề trong sheet, để mở file ra là biết ngay
   * nó là số của nhóm nào.
   */
  const handleExportStatsExcel = async () => {
    setExportingStats(true);
    try {
      await exportLossStatsWorkbook({
        columns: lossStats.columns,
        rows: lossStats.rows,
        byShiftTotal: lossStats.byShiftTotal,
        grandTotal: lossStats.grandTotal,
        scopeLabel: CHARGE_FILTER_LABEL[statCharge],
        scopeSlug: CHARGE_FILTER_SLUG[statCharge],
        startDate,
        endDate,
      });
    } catch (err) {
      alert(
        `Không xuất được file Excel: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      setExportingStats(false);
    }
  };

  const handleExportCSV = () => {
    const headers = [
      "Ngày làm việc",
      "Mã NV",
      "Tên nhân viên",
      "Bộ phận lớn",
      "Phân loại",
      "Lượt trùng ca",
      `Lượt vượt ${PUNCH_LIMIT} ca`,
      "Tổng lượt mất mát",
      "Tiền mất mát (VNĐ)",
      "Giờ các lượt quẹt thẻ",
      "Chi tiết lượt mất mát",
    ];

    /* Xuất đúng những dòng đang hiển thị: bấm ô "Bị trừ tiền" rồi xuất thì
       file chỉ có nhóm đó. */
    const rows: (string | number)[][] = visibleRows.map((r) => [
      r.workDate,
      r.userId,
      r.userName,
      r.largeDepartment,
      CHARGE_LABEL[r.charge],
      r.dupShiftCount,
      r.overLimitCount,
      r.lossCount,
      r.lossAmount,
      punchTimes(r),
      lossDetail(r),
    ]);

    const sum = (pick: (r: LossRow) => number) =>
      visibleRows.reduce((a, r) => a + pick(r), 0);

    rows.push([
      "TỔNG CỘNG",
      `${new Set(visibleRows.map((r) => r.userId)).size} nhân sự`,
      "",
      "",
      chargeFilter === "ALL" ? "Tất cả" : CHARGE_LABEL[chargeFilter],
      sum((r) => r.dupShiftCount),
      sum((r) => r.overLimitCount),
      sum((r) => r.lossCount),
      sum((r) => r.lossAmount),
      "",
      "",
    ]);

    exportToCSV(
      `Cham_An_Mat_Mat_${CHARGE_FILTER_SLUG[chargeFilter]}_${startDate}_${endDate}`,
      headers,
      rows,
    );
  };

  /** Một ô thống kê bấm được. */
  const ChargeCard: React.FC<{
    charge: LossCharge;
    icon: React.ReactNode;
    tone: string;
    activeTone: string;
    countText: string;
    amount: number;
    hint: string;
  }> = ({ charge, icon, tone, activeTone, countText, amount, hint }) => {
    const active = chargeFilter === charge;
    return (
      <button
        type="button"
        onClick={() => toggleFilter(charge)}
        className={`text-left bg-white p-3.5 rounded-xl border transition flex items-center gap-3 ${
          active ? activeTone : "border-slate-200 hover:border-slate-400"
        }`}
      >
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${tone}`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-[11px] text-slate-500 font-medium">
            {CHARGE_LABEL[charge]}
          </div>
          <div className="text-lg font-black leading-tight text-slate-900">
            {countText}
          </div>
          <div className="text-xs font-bold text-slate-700 truncate">
            {formatVND(amount)}
          </div>
          <div className="text-[10px] text-slate-400 leading-tight">
            {active ? "Đang lọc — bấm lại để xem tất cả" : hint}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-amber-500/10 p-5 rounded-2xl border border-amber-500/30 space-y-4">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="flex items-start space-x-3">
            <div className="p-2.5 bg-amber-500 text-slate-950 rounded-xl shadow-md mt-0.5">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                Thống Kê Suất Ăn Mất Mát Do Chấm Thẻ Sai
              </h2>
              <p className="text-xs text-slate-600 mt-1">
                Phát hiện tự động các lượt quẹt thẻ không hợp lệ trong một ngày
                làm việc để tránh thất thoát hoặc quẹt dùm thẻ.
              </p>
            </div>
          </div>

          <button
            onClick={handleExportCSV}
            disabled={visibleRows.length === 0}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-xl text-xs font-semibold transition shadow-sm shrink-0"
          >
            <Download className="w-4 h-4" />
            <span>Xuất Excel/CSV</span>
          </button>
        </div>

        {/* 4 chỉ số tổng hợp — hai ô phân loại bấm được để lọc bảng dưới */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white p-3.5 rounded-xl border border-slate-200 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-50 text-red-600 flex items-center justify-center shrink-0">
              <Users className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-slate-500 font-medium">
                Số Nhân Sự Vi Phạm
              </div>
              <div className="text-lg font-black text-red-700 leading-tight">
                {summary.people.toLocaleString("vi-VN")}{" "}
                <span className="text-xs font-normal text-slate-500">
                  nhân sự
                </span>
              </div>
            </div>
          </div>

          <div className="bg-white p-3.5 rounded-xl border border-slate-200 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
              <CopyX className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-slate-500 font-medium">
                Tổng Suất Mất Mát
              </div>
              <div className="text-lg font-black text-amber-700 leading-tight">
                {summary.lossCount.toLocaleString("vi-VN")}{" "}
                <span className="text-xs font-normal text-slate-500">suất</span>
              </div>
              <div className="text-[10px] text-slate-500 leading-tight">
                {summary.chargeable.count.toLocaleString("vi-VN")} bị trừ •{" "}
                {summary.free.count.toLocaleString("vi-VN")} không trừ
              </div>
            </div>
          </div>

          <ChargeCard
            charge="BI_TRU"
            icon={<Coins className="w-4 h-4" />}
            tone="bg-red-100 text-red-700"
            activeTone="border-red-500 ring-2 ring-red-200 bg-red-50/60"
            countText={`${summary.chargeable.count.toLocaleString("vi-VN")} suất`}
            amount={summary.chargeable.amount}
            hint="Bấm để chỉ xem nhóm này"
          />

          <ChargeCard
            charge="KHONG_TRU"
            icon={<BadgeCheck className="w-4 h-4" />}
            tone="bg-emerald-100 text-emerald-700"
            activeTone="border-emerald-500 ring-2 ring-emerald-200 bg-emerald-50/60"
            countText={`${summary.free.count.toLocaleString("vi-VN")} suất`}
            amount={summary.free.amount}
            hint={`Quẹt lại dưới ${FREE_DUP_WINDOW_MINUTES} phút`}
          />
        </div>

        <div className="text-[11px] text-slate-600 bg-white/70 rounded-xl border border-amber-200 p-3 space-y-1">
          <div className="font-bold text-slate-700 uppercase">
            Quy tắc tính mất mát
          </div>
          <div>
            <strong>1. Trùng ca:</strong> mỗi ca chỉ được quẹt một lần. Lượt
            quẹt vào ca đã quẹt rồi bị tính mất mát — kể cả khi cả ngày mới quẹt
            2 lần.
          </div>
          <div>
            <strong>2. Vượt hạn mức:</strong> mỗi ngày làm việc tối đa{" "}
            {PUNCH_LIMIT} ca hợp lệ. Ca hợp lệ thứ {PUNCH_LIMIT + 1} trở đi bị
            tính mất mát.
          </div>
          <div>
            <strong>3. Không bị trừ tiền:</strong> lượt trùng ca cách lượt quẹt
            liền trước <strong>dưới {FREE_DUP_WINDOW_MINUTES} phút</strong> là
            thao tác quẹt lại, không ai ăn thêm suất nào. Mọi trường hợp còn lại
            đều bị trừ tiền.
          </div>
          <div className="text-slate-500">
            <strong>Ngày làm việc</strong> không phải ngày lịch: ca đêm 22:50
            &rarr; 01:50 được tính trọn cho ngày kết thúc ca. Nên quẹt lúc
            00:05 và quẹt lúc 23:45 trong cùng một ngày lịch là hai ca đêm của
            hai ngày làm việc khác nhau, <strong>không phải trùng ca</strong>.
            Tiền mất mát tính theo đơn giá của ca ăn tại thời điểm quẹt, nên mỗi
            lượt có giá khác nhau.
          </div>
        </div>
      </div>

      {/* Thống kê số lượt mất mát theo ngày làm việc × ca */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div className="p-2 bg-slate-800 text-amber-300 rounded-lg shrink-0">
              <CalendarDays className="w-4 h-4" />
            </div>
            <div>
              <div className="text-sm font-bold text-slate-900 uppercase tracking-wide">
                Thống kê số lượt mất mát theo ngày &amp; ca
              </div>
              <div className="text-xs text-slate-600 mt-0.5">
                Mỗi dòng là một <strong>ngày làm việc</strong>, mỗi cột là một
                ca. Ca đêm 22:50 &rarr; 01:50 được tính trọn cho ngày kết thúc
                ca, nên lượt quẹt lúc 00:05 và lượt lúc 23:45 của cùng một ngày
                lịch nằm ở hai dòng khác nhau.
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleExportStatsExcel}
              disabled={lossStats.rows.length === 0 || exportingStats}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-xl text-xs font-semibold transition shadow-sm"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>{exportingStats ? "Đang xuất…" : "Xuất Excel"}</span>
            </button>

            {/* Loại dữ liệu muốn thống kê */}
            <div className="flex items-center gap-1 bg-white border border-slate-300 rounded-xl p-1">
              {(["BI_TRU", "KHONG_TRU", "ALL"] as ChargeFilter[]).map((opt) => {
                const active = statCharge === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setStatCharge(opt)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                      active
                        ? opt === "BI_TRU"
                          ? "bg-red-600 text-white"
                          : opt === "KHONG_TRU"
                            ? "bg-emerald-600 text-white"
                            : "bg-slate-800 text-white"
                        : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {CHARGE_FILTER_LABEL[opt]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {lossStats.rows.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-500">
            Không có lượt mất mát nào thuộc nhóm &ldquo;
            {CHARGE_FILTER_LABEL[statCharge]}&rdquo; trong khoảng {startDate}{" "}
            &rarr; {endDate}.
          </div>
        ) : (
          <div className="overflow-auto max-h-[60vh]">
            <table className="text-[13px] border-collapse w-full whitespace-nowrap">
              <thead className="sticky top-0 z-10 bg-slate-700 text-white uppercase text-[11px] tracking-wider">
                <tr>
                  <th className="border border-slate-500 px-3 py-2.5 text-left sticky left-0 bg-slate-700 z-10">
                    Ngày
                  </th>
                  {lossStats.columns.map((code) => (
                    <th
                      key={code}
                      className="border border-slate-500 px-3 py-2.5 text-center"
                    >
                      {code}
                    </th>
                  ))}
                  <th className="border border-slate-500 px-3 py-2.5 text-center bg-amber-600 text-slate-950 font-extrabold">
                    Tổng
                  </th>
                </tr>
              </thead>

              <tbody className="text-slate-800">
                {lossStats.rows.map((row) => (
                  <tr key={row.workDate} className="hover:bg-amber-50/50">
                    <td className="border border-slate-300 px-3 py-2 font-bold text-slate-900 sticky left-0 bg-white">
                      {viDate(row.workDate)}
                    </td>
                    {lossStats.columns.map((code) => {
                      const v = row.byShift[code] ?? 0;
                      return (
                        <td
                          key={code}
                          className="border border-slate-300 px-3 py-2 text-center font-mono"
                        >
                          {v > 0 ? (
                            v.toLocaleString("vi-VN")
                          ) : (
                            <span className="text-slate-300">-</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="border border-slate-300 px-3 py-2 text-center font-mono font-bold bg-amber-50 text-amber-800">
                      {row.total.toLocaleString("vi-VN")}
                    </td>
                  </tr>
                ))}
              </tbody>

              <tfoot className="sticky bottom-0 z-10">
                <tr className="bg-slate-800 text-white font-extrabold">
                  <td className="border border-slate-600 px-3 py-2.5 text-left sticky left-0 bg-slate-800">
                    TỔNG CỘNG
                  </td>
                  {lossStats.columns.map((code) => (
                    <td
                      key={code}
                      className="border border-slate-600 px-3 py-2.5 text-center font-mono"
                    >
                      {(lossStats.byShiftTotal[code] ?? 0).toLocaleString(
                        "vi-VN",
                      )}
                    </td>
                  ))}
                  <td className="border border-slate-600 px-3 py-2.5 text-center font-mono bg-amber-500 text-slate-950">
                    {lossStats.grandTotal.toLocaleString("vi-VN")}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Main List */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2 text-xs font-semibold text-slate-700">
          <span>
            {chargeFilter === "ALL"
              ? "Tất cả lượt quẹt mất mát"
              : `Chỉ nhóm "${CHARGE_LABEL[chargeFilter]}"`}{" "}
            ({startDate} &rarr; {endDate}) — {visibleRows.length} dòng
          </span>
          {chargeFilter !== "ALL" ? (
            <button
              type="button"
              onClick={() => setChargeFilter("ALL")}
              className="px-2.5 py-1 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold transition"
            >
              Xem tất cả
            </button>
          ) : (
            <span className="text-slate-500 font-mono">
              Hạn mức: 1 lượt/ca, tối đa {PUNCH_LIMIT} ca/ngày làm việc
            </span>
          )}
        </div>

        {visibleRows.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div className="text-sm font-bold text-slate-800">
              Không có lượt quẹt mất mát nào trong nhóm này!
            </div>
            <p className="text-xs text-slate-500">
              Tất cả cán bộ công nhân viên đều chấm ăn tuân thủ hạn mức quy
              định.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {visibleRows.map((item) => {
              const isExpanded = expandedKey === item.key;
              const chargeable = item.charge === "BI_TRU";

              return (
                <div key={item.key} className="p-4 hover:bg-slate-50 transition">
                  <div
                    onClick={() => setExpandedKey(isExpanded ? null : item.key)}
                    className="flex flex-col sm:flex-row sm:items-center justify-between cursor-pointer gap-2"
                  >
                    <div className="flex items-center space-x-3">
                      <span
                        className={`px-2.5 py-1 rounded-lg font-black text-xs border flex flex-col items-center leading-tight shrink-0 ${
                          chargeable
                            ? "bg-red-100 text-red-800 border-red-200"
                            : "bg-emerald-100 text-emerald-800 border-emerald-200"
                        }`}
                      >
                        <span>{item.totalPunches} LẦN</span>
                        <span className="text-[10px] font-bold">
                          {item.lossCount} dư
                        </span>
                      </span>

                      <div>
                        <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
                          <span className="font-bold text-slate-900 text-sm">
                            {item.userName}
                          </span>
                          <span className="font-mono text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                            Mã: {item.userId}
                          </span>
                          <span className="text-xs font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                            {item.largeDepartment}
                          </span>
                          <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded border ${
                              chargeable
                                ? "text-red-700 bg-red-50 border-red-200"
                                : "text-emerald-700 bg-emerald-50 border-emerald-200"
                            }`}
                          >
                            {CHARGE_LABEL[item.charge]}
                          </span>
                          {item.dupShiftCount > 0 && (
                            <span className="text-[11px] font-bold text-orange-700 bg-orange-50 px-2 py-0.5 rounded border border-orange-200">
                              {item.dupShiftCount} trùng ca
                            </span>
                          )}
                          {item.overLimitCount > 0 && (
                            <span className="text-[11px] font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
                              {item.overLimitCount} vượt hạn mức
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Bộ phận: <strong>{item.department}</strong> • Ngày làm
                          việc:{" "}
                          <strong className="text-slate-800">
                            {item.workDate}
                          </strong>
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right">
                        <div className="text-[10px] uppercase font-bold text-slate-400">
                          {chargeable ? "Trừ tiền" : "Không trừ"}
                        </div>
                        <div className="text-xs font-bold text-amber-700">
                          {item.lossCount} suất •{" "}
                          <span
                            className={
                              chargeable ? "text-red-700" : "text-emerald-700"
                            }
                          >
                            {formatVND(item.lossAmount)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center space-x-1 text-xs font-semibold text-indigo-600">
                        <span>{isExpanded ? "Thu gọn" : "Chi tiết"}</span>
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Punch Details */}
                  {isExpanded && (
                    <div className="mt-4 pt-3 border-t border-slate-200 bg-slate-50/80 rounded-xl p-3">
                      <h4 className="text-xs font-bold text-slate-700 uppercase mb-2 flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-amber-600" />
                        Nhật Ký Các Lần Quẹt Trong Ngày Làm Việc {item.workDate}{" "}
                        ({item.totalPunches} lần)
                      </h4>

                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2.5 text-xs">
                        {item.punches.map((p, idx) => {
                          /* Lượt mất mát của ĐÚNG phân loại đang xem thì tô
                             đậm; lượt mất mát của phân loại kia vẫn hiện để
                             thấy bối cảnh cả ngày, chỉ làm nhạt đi. */
                          const inThisRow = item.lossPunches.includes(p);
                          return (
                            <div
                              key={p.log.id}
                              className={`p-2.5 rounded-lg border shadow-sm ${
                                inThisRow
                                  ? chargeable
                                    ? "bg-red-50 border-red-300"
                                    : "bg-emerald-50 border-emerald-300"
                                  : p.isLoss
                                    ? "bg-slate-100 border-slate-300"
                                    : "bg-white border-slate-200"
                              }`}
                            >
                              <div className="flex justify-between items-center text-[11px] mb-1 gap-1">
                                <span
                                  className={
                                    inThisRow
                                      ? "font-bold text-slate-800"
                                      : "text-slate-500"
                                  }
                                >
                                  Lần #{idx + 1}
                                </span>
                                <span className="font-bold text-amber-700 bg-amber-100 px-1.5 py-0.2 rounded">
                                  {p.log.shiftCode}
                                </span>
                              </div>
                              <div className="font-mono font-extrabold text-slate-900 text-xs">
                                {p.log.logTimeOnly}
                              </div>
                              {p.gapMinutes !== null && (
                                <div className="text-[10px] text-slate-500 mt-0.5">
                                  Cách lượt trước {formatGap(p.gapMinutes)}
                                </div>
                              )}
                              <div className="text-[11px] text-slate-600 mt-1 truncate">
                                {p.log.readerName}
                              </div>
                              {p.isLoss && (
                                <div className="mt-1.5 pt-1.5 border-t border-slate-200 space-y-0.5">
                                  <div className="flex flex-wrap gap-1">
                                    <span className="text-[10px] font-black text-white bg-slate-700 rounded px-1.5 py-0.5 inline-block">
                                      {LOSS_LABEL[p.reason!]}
                                    </span>
                                    <span
                                      className={`text-[10px] font-black rounded px-1.5 py-0.5 inline-block text-white ${
                                        p.charge === "BI_TRU"
                                          ? "bg-red-600"
                                          : "bg-emerald-600"
                                      }`}
                                    >
                                      {CHARGE_LABEL[p.charge!]}
                                    </span>
                                  </div>
                                  <div className="text-[11px] font-bold text-slate-700">
                                    {MEAL_CATEGORY_META[categoryOfLog(p.log)].label}
                                    : {formatVND(priceOfLog(p.log))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
