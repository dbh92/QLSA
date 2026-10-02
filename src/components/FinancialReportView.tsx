import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  MealLog,
  ShiftCode,
  DepartmentMapping,
  DailyMilkEntry,
  ExtraCostEntry,
  BirthdayConfig,
  MealPriceItem,
  ShiftMealCategory,
  ShiftInfo,
  ManualMealEntry,
  MonthlyCostRow,
  LaborCostState,
  LaborWorkDayRule,
} from "../types";
import {
  formatVND,
  exportToCSV,
  buildBirthdayPriceMap,
  buildMealPricing,
  buildShiftCategoryLookup,
  classifyManualEntries,
  costWorkDayRange,
  MealCategory,
  MEAL_CATEGORY_META,
} from "../services/mealEngine";
import {
  CATEGORY_COLUMNS,
  SHIFT_ORDER,
  buildCategoryUnitPrices,
  buildDayColumns,
  buildDeptAllocation,
  reconcileCost,
  CostAdjustment,
  applyCostAdjustment,
  previewLossDeduction,
  classifyLogs,
  collectReportDates,
  extraAsSupply,
  filterSupplyByRange,
  milkAsSupply,
  reportShiftLabel,
  shiftWindow,
  buildLaborSegments,
  withLaborCost,
  yearlyValue,
} from "./financial/reportModel";
import * as api from "../services/api";
import { exportFinancialWorkbook } from "./financial/workbookExport";
import { CostAdjustmentDialog } from "./financial/CostAdjustmentDialog";
import { MonthlyMealStatsReport } from "./financial/MonthlyMealStatsReport";
import { MealCostAllocationReport } from "./financial/MealCostAllocationReport";
import { YearlyTotalReport } from "./financial/YearlyTotalReport";
import { ShiftDailyPivotReport } from "./financial/ShiftDailyPivotReport";
import { LaborCostReport } from "./financial/LaborCostReport";
import {
  FileSpreadsheet,
  Download,
  TrendingUp,
  BarChart3,
  Building2,
  CalendarDays,
  Clock,
  Sigma,
  Wallet,
  AlertTriangle,
  FileDown,
  Loader2,
  SlidersHorizontal,
  Trash2,
  ClipboardList,
} from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

/**
 * Bảng màu biểu đồ xu hướng năm — 6 slot đầu của bảng màu categorical đã được
 * kiểm định (lightness band, chroma floor, tách màu cho người mù màu, tương
 * phản nền). Gán theo THỨ TỰ CỐ ĐỊNH, không xoay vòng: đổi thứ tự series là
 * phải kiểm định lại.
 */
const TREND_SERIES: {
  key: keyof MonthlyCostRow;
  name: string;
  color: string;
}[] = [
  { key: "ComHan", name: "Cơm Hàn", color: "#2a78d6" },
  { key: "MyHan", name: "Mỳ Hàn", color: "#eb6834" },
  { key: "ComViet", name: "Bữa Chính VN", color: "#1baf7a" },
  { key: "ComVietPhu", name: "Bữa Phụ VN", color: "#eda100" },
  { key: "SuatDacBiet", name: "Suất Sinh Nhật", color: "#e87ba4" },
  { key: "Sua", name: "Sữa", color: "#008300" },
  /* Chi phí phát sinh vốn bị bỏ quên ở biểu đồ này (bảng "Total suất ăn" thì
     có), nên các cột xếp chồng không cộng lại thành đường Tổng Chi Phí Tháng.
     Thêm vào cùng lúc với nhân công để hai khoản đứng liền nhau đúng thứ tự
     của mọi bảng khác, và để đường tổng khớp với chồng cột. */
  { key: "ChiPhiPhatSinh", name: "Chi Phí Phát Sinh", color: "#8b5cf6" },
  /* Chi phí nhân công KHÔNG do SA_MealCost_GetMonthly trả về — `withLaborCost`
     cộng vào từng tháng ở client, xem chú thích ở reportModel. */
  { key: "ChiPhiNhanCong", name: "Chi Phí Nhân Công", color: "#0d9488" },
];

/** Rút gọn trục tiền: 1.200.000.000 -> "1,2 tỷ". */
const compactVND = (value: number) => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} tỷ`;
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)} tr`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
};

/** Màu tiêu đề cột theo loại suất (viết đủ chuỗi để Tailwind quét được). */
const CATEGORY_HEAD_TONE: Record<MealCategory, string> = {
  KO_COM: "bg-red-900/60 text-red-200",
  KO_MY: "bg-orange-900/60 text-orange-200",
  VN_CHINH: "bg-blue-900/60 text-blue-200",
  VN_PHU: "bg-sky-900/60 text-sky-200",
  VN_SINHNHAT: "bg-pink-900/60 text-pink-200",
};

const CATEGORY_CELL_TONE: Record<MealCategory, string> = {
  KO_COM: "text-red-700",
  KO_MY: "text-orange-700",
  VN_CHINH: "text-indigo-700",
  VN_PHU: "text-sky-700",
  VN_SINHNHAT: "text-pink-700",
};

/**
 * Các bảng kê trong tab "Báo Cáo Chi Phí". Ngoài 5 bảng tổng hợp còn có 6
 * bảng chi tiết theo ca, chọn bằng chính mã ca.
 */
type ReportKey =
  | "monthly-stats"
  | "dept-allocation"
  | "yearly-total"
  | "cost-allocation"
  | "labor-cost"
  | "yearly"
  | ShiftCode;

const SUMMARY_MENU: {
  id: ReportKey;
  label: string;
  icon: React.ReactNode;
  hint: string;
}[] = [
  {
    id: "monthly-stats",
    label: "Thống kê suất ăn tháng",
    icon: <CalendarDays className="w-4 h-4" />,
    hint: "Bảng kê từng ngày theo hạng mục",
  },
  {
    id: "dept-allocation",
    label: "Phân bổ theo BP",
    icon: <Building2 className="w-4 h-4" />,
    hint: "Tiền ăn từng bộ phận lớn",
  },
  {
    id: "yearly-total",
    label: "Total suất ăn",
    icon: <Sigma className="w-4 h-4" />,
    hint: "Số suất & thành tiền 12 tháng",
  },
  {
    id: "cost-allocation",
    label: "Phân bổ tiền ăn",
    icon: <Wallet className="w-4 h-4" />,
    hint: "Số lượng / đơn giá / thành tiền",
  },
  {
    id: "labor-cost",
    label: "Chi phí nhân công",
    icon: <ClipboardList className="w-4 h-4" />,
    hint: 'Nhập đợt thuê, bấm "Áp dụng" mới vào báo cáo',
  },
  {
    id: "yearly",
    label: "Xu hướng năm & biểu đồ",
    icon: <BarChart3 className="w-4 h-4" />,
    hint: "Biểu đồ chi phí các tháng",
  },
];

/**
 * Cả "Total suất ăn" lẫn biểu đồ xu hướng đều đọc SA_MealCost_GetMonthly, nên
 * lỗi của procedure đó hiển thị chung một chỗ kèm luôn cách khắc phục.
 */
const MonthlyCostsProblem: React.FC<{
  error: string;
  onReload: () => void;
}> = ({ error, onReload }) => (
  <div className="p-5 rounded-2xl bg-red-50 border border-red-200 flex items-start gap-3">
    <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
    <div className="flex-1 text-xs">
      <div className="font-bold text-red-800">
        Không lấy được số liệu chi phí theo tháng
      </div>
      <div className="text-red-700 mt-1">{error}</div>
      <div className="text-red-600/80 mt-2 leading-relaxed">
        Báo cáo này cần stored procedure{" "}
        <code className="font-mono font-bold">SA_MealCost_GetMonthly</code>. Nếu
        chưa deploy, chạy lại script trên SQL Server:
        <div className="mt-1 font-mono bg-white/70 border border-red-200 rounded px-2 py-1 inline-block">
          sqlcmd -f 65001 -I -S 10.70.22.240 -d QLSA -i db_procedures.sql
        </div>
        <div className="mt-1">
          Sau đó khởi động lại API (
          <code className="font-mono">npm run server</code>).
        </div>
      </div>
    </div>
    <button
      onClick={onReload}
      className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg shrink-0"
    >
      Thử lại
    </button>
  </div>
);

interface FinancialReportViewProps {
  /**
   * Log của khoảng đang tải, KỂ CẢ suất mất mát đã xóa (`lossDeleted`) — tab
   * này tự bỏ chúng khỏi mọi bảng, nhưng cần chúng để đánh giá suất mất mát
   * trong popup Điều Chỉnh Số Liệu đúng như tab Suất Ăn Mất Mát.
   */
  logs: MealLog[];
  mappings: DepartmentMapping[];
  /** Danh mục ca (SA_Shift): khung giờ, tên ca trên bảng kê, ca vắt nửa đêm. */
  shifts: ShiftInfo[];
  /** Danh mục bộ phận lớn lấy từ SA_LargeDepartment. */
  largeDeptOptions: string[];
  milkEntries: DailyMilkEntry[];
  extraCosts: ExtraCostEntry[];
  birthdayConfigs: BirthdayConfig[];
  /** Các ca được ăn suất sinh nhật (SA_SystemSetting: BIRTHDAY_SHIFTS). */
  birthdayShifts: Set<ShiftCode>;
  priceItems: MealPriceItem[];
  /** Bảng gán loại suất theo ca (tab Cấu Hình Giá Suất Ăn). */
  shiftMealCategories: ShiftMealCategory[];
  manualEntries: ManualMealEntry[];
  /** Chi phí từng tháng cho biểu đồ xu hướng (SA_MealCost_GetMonthly). */
  monthlyCosts: MonthlyCostRow[];
  monthlyCostsLoading: boolean;
  /** Thông điệp lỗi khi không lấy được số liệu xu hướng, null nếu bình thường. */
  monthlyCostsError: string | null;
  onReloadMonthlyCosts: () => void;
  /**
   * Bảo đảm số liệu 12 tháng đã về và TRẢ THẲNG mảng đó ra. Nút "Báo cáo tổng
   * hợp" bấm ngay khi vừa mở tab sẽ chạy trước lúc `monthlyCosts` kịp về, mà
   * state mới thì handler đang chạy dở không đọc được — nên phải lấy qua đây.
   */
  onEnsureMonthlyCosts: () => Promise<MonthlyCostRow[]>;
  /**
   * Đã xóa (hoặc khôi phục) lượt quẹt trong popup "Điều Chỉnh Số Liệu" — nạp
   * lại log chấm ăn và số liệu 12 tháng. Xóa là xóa ở cơ sở dữ liệu nên mọi
   * tab đều phải đọc lại, không riêng tab này.
   */
  onPunchesChanged: () => Promise<void>;
  /* ---- Chi phí thuê nhân công -------------------------------------------
     Bản nháp, lượt áp dụng đang có hiệu lực và lịch sử — xem
     `LaborCostReport`. Chỉ lượt ĐANG CÓ HIỆU LỰC mới đi vào tiền của các bảng
     kê; bản nháp không ảnh hưởng con số nào. */
  laborCosts: LaborCostState;
  laborCostsLoading: boolean;
  onSaveLaborCost: (row: {
    id?: number | null;
    workerName: string;
    effectiveFrom: string;
    effectiveTo: string;
    amount: number;
    notes?: string;
  }) => Promise<void>;
  onDeleteLaborCost: (id: number) => Promise<void>;
  onApplyLaborCosts: (
    rule: LaborWorkDayRule,
    notes?: string,
  ) => Promise<void>;
  onRestoreLaborBatch: (batchId: string) => Promise<void>;
  /** Biên lọc chính xác tới giây, "YYYY-MM-DD HH:mm:ss". */
  startDateTime: string;
  endDateTime: string;
  startDate: string;
  endDate: string;
}

export const FinancialReportView: React.FC<FinancialReportViewProps> = ({
  logs,
  mappings,
  shifts,
  largeDeptOptions,
  milkEntries: allMilkEntries,
  extraCosts: allExtraCosts,
  birthdayConfigs,
  birthdayShifts,
  priceItems,
  shiftMealCategories,
  manualEntries,
  monthlyCosts,
  monthlyCostsLoading,
  monthlyCostsError,
  onReloadMonthlyCosts,
  onEnsureMonthlyCosts,
  onPunchesChanged,
  laborCosts,
  laborCostsLoading,
  onSaveLaborCost,
  onDeleteLaborCost,
  onApplyLaborCosts,
  onRestoreLaborBatch,
  startDateTime,
  endDateTime,
  startDate,
  endDate,
}) => {
  const [reportType, setReportType] = useState<ReportKey>("monthly-stats");
  /* Dựng file Excel tổng hợp mất vài giây trên dữ liệu một tháng, nên nút
     phải khoá lại trong lúc chạy để không xuất hai lần chồng nhau. */
  const [exportingWorkbook, setExportingWorkbook] = useState(false);

  // Filter logs in range
  const filteredLogs = useMemo(() => {
    return logs.filter(
      (l) => l.logDateTime >= startDateTime && l.logDateTime <= endDateTime,
    );
  }, [logs, startDateTime, endDateTime]);

  /* Sữa và chi phí phát sinh cũng chịu khoảng lọc CHÍNH XÁC TỚI GIÂY: ca đêm
     của ngày D là (D-1) 22:50 -> D 08:00, ca ngày là D 08:00 -> D 22:50 (xem
     `supplyShiftWindow`). Lọc từ "25/08 23:00" thì hàng cấp phát của ngày
     25/08 không còn được tính vào tổng chi phí. Lọc MỘT lần ở đây — mọi bảng,
     thẻ tổng và sheet Excel bên dưới đều đọc hai mảng đã lọc này. */
  const milkEntries = useMemo(
    () =>
      filterSupplyByRange(
        allMilkEntries,
        milkAsSupply,
        startDateTime,
        endDateTime,
        shifts,
      ),
    [allMilkEntries, startDateTime, endDateTime, shifts],
  );
  const extraCosts = useMemo(
    () =>
      filterSupplyByRange(
        allExtraCosts,
        extraAsSupply,
        startDateTime,
        endDateTime,
        shifts,
      ),
    [allExtraCosts, startDateTime, endDateTime, shifts],
  );

  /* Ngày sinh nhật -> ĐƠN GIÁ suất sinh nhật của chính ngày đó, lấy từ tab
     "Cấu Hình Sinh Nhật". Đây là nguồn duy nhất của đơn giá suất sinh nhật
     trong cả tab này: Cấu Hình Giá Suất Ăn không còn giữ con số đó nữa. */
  const birthdayPrices = useMemo(
    () => buildBirthdayPriceMap(birthdayConfigs),
    [birthdayConfigs],
  );

  /* Đơn giá 5 loại suất, lấy từ SA_MealPrice — cùng bảng giá với Dashboard và
     tab Hàn Quốc vs Việt Nam. */
  const pricing = useMemo(() => buildMealPricing(priceItems), [priceItems]);

  const shiftCategories = useMemo(
    () => buildShiftCategoryLookup(shiftMealCategories),
    [shiftMealCategories],
  );

  /* Một lượt phân loại duy nhất cho toàn bộ tab: bảng kê tháng, bảng phân bổ
     tiền ăn, bảng phân bổ theo bộ phận và 6 bảng chi tiết theo ca đều đọc từ
     đây nên không thể lệch nhau. */
  const rawClassified = useMemo(
    () =>
      classifyLogs(
        filteredLogs,
        mappings,
        shifts,
        shiftCategories,
        birthdayPrices,
        birthdayShifts,
        pricing,
      ),
    [
      filteredLogs,
      mappings,
      shifts,
      shiftCategories,
      birthdayPrices,
      birthdayShifts,
      pricing,
    ],
  );

  /* Một lượt phân loại duy nhất cho suất nhập tay, song song với
     `classified`. Mọi bảng trong tab — kể cả bảng phân bổ theo bộ phận và 6
     bảng chi tiết theo ca — đọc từ đây nên không thể bỏ sót suất nào. */
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
    /* Lọc theo GIỜ BẮT ĐẦU CA (`dateTime`) đã nằm trong classifyManualEntries:
       lọc từ "25/08 22:50:00" thì suất đầu tiên được tính là CA1 ngày 26. */
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

  /* -------------------------------------------------------------------
     Điều chỉnh số liệu (popup) — xem khối chú thích ở reportModel.

     Popup XOÁ THẬT: nó gửi danh sách lượt quẹt xuống SA_MealLogDeleted_Save.
     Khoản "xoá suất bất kỳ" thì SA_MealLog_GetByRange thôi trả về hẳn; suất
     mất mát đã xoá thì vẫn được trả về với `lossDeleted` — chỉ để tab Suất Ăn
     Mất Mát hiển thị y nguyên — và bị bỏ ngay dưới đây. Nên `classified` là
     tập ĐÃ TRỪ mà mọi bảng của tab dựng từ đó, còn `rawClassified` (kể cả
     lượt mất mát đã xoá) chỉ dùng để TÍNH TRƯỚC xem bản nháp trong popup sẽ
     bỏ đi những lượt nào, bằng đúng hàm mà lúc bấm sẽ chạy. */
  const [adjustOpen, setAdjustOpen] = useState(false);

  const classified = useMemo(
    () => rawClassified.filter((r) => !r.log.lossDeleted),
    [rawClassified],
  );

  const lossPreview = useMemo(
    () => previewLossDeduction(rawClassified, shifts, pricing),
    [rawClassified, shifts, pricing],
  );

  const resolveRemoval = useCallback(
    (draft: CostAdjustment) => {
      const result = applyCostAdjustment(rawClassified, shifts, pricing, draft);
      return {
        ids: result.adHocIds,
        lossIds: result.lossIds,
        count: result.totalCount,
        amount: result.totalAmount,
        shortfall: result.shortfall,
      };
    },
    [rawClassified, shifts, pricing],
  );

  /** Số lượt quẹt đã xóa có ngày rơi vào khoảng lọc — chỉ để hiện nhắc nhở. */
  const [deletedInRange, setDeletedInRange] = useState(0);

  const refreshDeletedCount = useCallback(async () => {
    try {
      /* Procedure lọc theo NGÀY LỊCH của lượt quẹt, nên truyền phần ngày của
         bộ lọc giờ — `startDate` là ngày làm việc và sẽ bỏ sót các lượt từ
         22:50 hôm trước. */
      const batches = await api.fetchMealLogDeletions(
        startDateTime.slice(0, 10),
        endDateTime.slice(0, 10),
      );
      setDeletedInRange(
        batches.reduce((sum, b) => sum + b.punchCountInRange, 0),
      );
    } catch {
      /* Không đọc được lịch sử xóa thì thôi, đây chỉ là dòng nhắc — số liệu
         trên bảng đã đúng vì SQL Server lọc sẵn rồi. */
      setDeletedInRange(0);
    }
  }, [startDateTime, endDateTime]);

  useEffect(() => {
    refreshDeletedCount();
  }, [refreshDeletedCount]);

  /* -------------------------------------------------------------------
     Chi phí thuê nhân công

     ĐỌC LƯỢT ÁP DỤNG, KHÔNG ĐỌC BẢN NHÁP. Đây là chỗ duy nhất trong tab
     quyết định điều đó, nên "chưa bấm Áp dụng thì báo cáo không đổi" là một
     tính chất của một dòng code chứ không phải một quy ước phải nhớ.

     Quy tắc ngày làm việc lấy theo chính lượt đó (đã đóng băng lúc bấm), nên
     đổi ô chọn quy tắc ở màn hình nhân công không làm số của kỳ đã chốt tự
     nhảy. */
  const laborWorkDayRule: LaborWorkDayRule =
    laborCosts.effective?.workDayRule ?? "ALL";

  /* Nhân công đếm theo NGÀY LÀM VIỆC (22:50 hôm trước -> 22:50 hôm nay), nên
     khoảng lọc được quy về ngày làm việc trước khi cắt đợt: lọc từ 25 lúc
     22:50 tới 29 lúc 22:50 chỉ tính công các ngày 26 -> 29. */
  const laborRange = useMemo(
    () => costWorkDayRange(startDateTime, endDateTime, shifts),
    [startDateTime, endDateTime, shifts],
  );

  const laborSegments = useMemo(
    () =>
      buildLaborSegments(
        laborCosts.appliedRows,
        laborRange.from,
        laborRange.to,
        laborWorkDayRule,
      ),
    [laborCosts.appliedRows, laborRange, laborWorkDayRule],
  );

  /** Cột ngày dùng chung cho mọi bảng kê có chia theo ngày. */
  const days = useMemo(
    () =>
      buildDayColumns(
        startDate,
        endDate,
        collectReportDates(
          classified,
          manualMeals,
          milkEntries,
          extraCosts,
          laborSegments,
        ),
      ),
    [
      startDate,
      endDate,
      classified,
      manualMeals,
      milkEntries,
      extraCosts,
      laborSegments,
    ],
  );

  /* Bảng phân bổ theo bộ phận — dựng bằng hàm dùng chung với sheet
     "Phân bổ theo BP" của file Excel tổng hợp. */
  const deptAllocationData = useMemo(
    () =>
      buildDeptAllocation(classified, manualMeals, largeDeptOptions, pricing),
    [classified, manualMeals, largeDeptOptions, pricing],
  );

  /* Đơn giá từng loại suất mà bảng phân bổ theo bộ phận đang dùng để tính
     tiền. Suất sinh nhật mỗi ngày một giá nên ô này là giá bình quân của kỳ,
     không phải một dòng trong SA_MealPrice — in ra đúng con số đã nhân thì
     người đọc cộng tay mới ra được ô Thành Tiền. */
  const deptUnitPrices = useMemo(
    () => buildCategoryUnitPrices(classified, manualMeals, pricing),
    [classified, manualMeals, pricing],
  );

  /** Cộng dồn số suất từng loại trên toàn bộ bộ phận. */
  const categoryTotals = useMemo(() => {
    return CATEGORY_COLUMNS.reduce(
      (acc, cat) => {
        acc[cat] = deptAllocationData.reduce(
          (sum, d) => sum + d.counts[cat],
          0,
        );
        return acc;
      },
      {} as Record<MealCategory, number>,
    );
  }, [deptAllocationData]);

  /* Ba con số của cả tab — tiền suất ăn, tiền sữa, tổng thanh toán — lấy từ
     MỘT nguồn duy nhất, để thẻ tổng quan ở đầu tab, chân bảng phân bổ theo
     bộ phận và TOTAL của bảng kê tháng không thể nói ba chuyện khác nhau. */
  const totals = useMemo(
    () =>
      reconcileCost(
        deptAllocationData,
        milkEntries,
        extraCosts,
        laborSegments,
      ),
    [deptAllocationData, milkEntries, extraCosts, laborSegments],
  );

  /* Số liệu xu hướng tháng do SA_MealCost_GetMonthly tổng hợp từ log chấm ăn
     thật, theo đúng bộ đơn giá của bảng phân bổ ở trên. Procedure đó cũng loại
     trừ các lượt quẹt đã xóa, nên bảng 12 tháng không còn phải tự trừ lại gì
     trên client. */
  /* Chi phí nhân công được cộng vào TỪNG THÁNG ở đây chứ không trong
     SA_MealCost_GetMonthly: phép chia tiền theo ngày làm việc chỉ được có một
     bản cài đặt, chép nó sang T-SQL là tạo ra chỗ để hai bên lệch nhau. Bảng
     "Total suất ăn", biểu đồ xu hướng và sheet Excel tương ứng đều đọc mảng
     đã cộng này. */
  const monthlyCostsWithLabor = useMemo(
    () =>
      withLaborCost(
        monthlyCosts,
        laborCosts.appliedRows,
        laborWorkDayRule,
      ),
    [monthlyCosts, laborCosts.appliedRows, laborWorkDayRule],
  );

  const monthlyChartData = monthlyCostsWithLabor;
  const trendYear =
    monthlyCosts[0]?.costMonth.slice(0, 4) ?? endDate.slice(0, 4);

  /* "Báo cáo tổng hợp": một file Excel, mỗi bảng kê trong menu là một sheet,
     giữ nguyên định dạng và màu của bảng trên web. Số liệu lấy từ chính
     `classified` / `days` mà các bảng đang hiển thị nên không thể lệch. */
  const handleExportWorkbook = async () => {
    if (exportingWorkbook) return;
    setExportingWorkbook(true);
    try {
      /* SA_MealCost_GetMonthly tổng hợp cả 12 tháng nên về chậm hơn hẳn phần
         còn lại. Bấm xuất trước lúc nó về thì phải CHỜ, nếu không sheet
         "Total suất ăn" ra rỗng mà không có gì báo cho người dùng biết. */
      const rawCosts =
        monthlyCosts.length > 0 ? monthlyCosts : await onEnsureMonthlyCosts();
      /* Cộng nhân công vào đúng như bảng trên web, nếu không sheet "Total
         suất ăn" sẽ thiếu một cột mà các sheet khác đã có. */
      const costs = withLaborCost(
        rawCosts,
        laborCosts.appliedRows,
        laborWorkDayRule,
      );

      await exportFinancialWorkbook({
        classified,
        days,
        pricing,
        shiftCategories,
        shifts,
        largeDeptOptions,
        manualMeals,
        milkEntries,
        extraCosts,
        laborSegments,
        laborWorkDayRule,
        monthlyCosts: costs,
        trendYear: costs[0]?.costMonth.slice(0, 4) ?? endDate.slice(0, 4),
        startDate,
        endDate,
      });
    } catch (err: any) {
      alert(`Không xuất được báo cáo tổng hợp: ${err?.message ?? err}`);
    } finally {
      setExportingWorkbook(false);
    }
  };

  // Export Allocation CSV
  const handleExportAllocationCSV = () => {
    const headers = [
      "Bộ Phận Lớn",
      ...CATEGORY_COLUMNS.map(
        (c) =>
          `${MEAL_CATEGORY_META[c].label} (${Math.round(deptUnitPrices[c])}đ)`,
      ),
      "Tổng Suất Ăn",
      "Tổng Thành Tiền (VNĐ)",
    ];

    const rows: (string | number)[][] = deptAllocationData.map((d) => [
      d.deptName,
      ...CATEGORY_COLUMNS.map((c) => d.counts[c]),
      d.totalMeals,
      d.totalAmount,
    ]);

    rows.push([
      "TỔNG CỘNG PHÂN BỔ",
      ...CATEGORY_COLUMNS.map((c) => categoryTotals[c]),
      totals.mealCount,
      totals.mealAmount,
    ]);

    /* Hai dòng đối chiếu với bảng "Thống kê suất ăn tháng" — xem chú thích
       ở `reconcileCost`. */
    const blanks = CATEGORY_COLUMNS.map(() => "");
    rows.push([
      "Tiền sữa (không phân bổ theo bộ phận)",
      ...blanks,
      totals.milkCount,
      totals.milkAmount,
    ]);
    rows.push([
      "Chi phí phát sinh (không phân bổ theo bộ phận)",
      ...blanks,
      totals.extraCount,
      totals.extraAmount,
    ]);
    /* Ô "số lượng" của dòng nhân công là NGÀY CÔNG, không phải số suất ăn. */
    rows.push([
      "Chi phí nhân công (không phân bổ theo bộ phận)",
      ...blanks,
      totals.laborDays,
      totals.laborAmount,
    ]);
    rows.push(["TỔNG THANH TOÁN", ...blanks, "", totals.grandTotal]);

    exportToCSV(
      `Bao_Cao_Phan_Bo_Tien_An_${startDate}_${endDate}`,
      headers,
      rows,
    );
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-emerald-800 via-teal-800 to-slate-900 p-5 rounded-2xl text-white shadow-lg flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <FileSpreadsheet className="w-5 h-5 text-emerald-400" />
            <h2 className="text-xl font-bold">
              Báo Cáo Chi Phí Suất Ăn &amp; Phân Bổ Tiền Ăn
            </h2>
          </div>
          <p className="text-[13px] text-emerald-50 mt-1">
            Bảng kê suất ăn theo ngày, phân bổ tiền ăn, tổng 12 tháng, chi tiết
            từng ca và biểu đồ xu hướng — chọn bảng ở menu bên dưới.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setAdjustOpen(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition shadow-sm shrink-0 bg-white/10 hover:bg-white/20 border border-white/25 text-white backdrop-blur-sm"
        >
          <SlidersHorizontal className="w-4 h-4" />
          Điều Chỉnh Số Liệu
        </button>
      </div>

      {/* Khoảng lọc này đã từng bị xóa lượt quẹt: số trên bảng KHÔNG phải số
          gốc của máy chấm, phải nói ra — người đọc mang bảng đi đối chiếu với
          BioStar sẽ thấy lệch và tưởng hệ thống sai. */}
      {deletedInRange > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-amber-400 text-slate-950 rounded-lg shrink-0">
              <Trash2 className="w-4 h-4" />
            </div>
            <div className="text-xs text-slate-700">
              <div className="font-bold text-slate-900 text-sm">
                Khoảng thời gian này đã xóa{" "}
                {deletedInRange.toLocaleString("vi-VN")} lượt quẹt
              </div>
              <div className="mt-0.5 text-slate-500">
                Số đã xóa không được tính ở bất kỳ màn hình nào; riêng suất mất
                mát đã xóa vẫn hiển thị ở tab Suất Ăn Mất Mát. Bản sao vẫn được
                giữ — mở &ldquo;Điều Chỉnh Số Liệu&rdquo; để xem lại hoặc khôi
                phục.
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setAdjustOpen(true)}
            className="px-3 py-1.5 bg-white border border-amber-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-amber-100 transition shrink-0"
          >
            Xem &amp; Khôi Phục
          </button>
        </div>
      )}

      {adjustOpen && (
        <CostAdjustmentDialog
          lossPreview={lossPreview}
          resolveRemoval={resolveRemoval}
          onApplied={async () => {
            await onPunchesChanged();
            await refreshDeletedCount();
          }}
          onClose={() => setAdjustOpen(false)}
          startDateTime={startDateTime}
          endDateTime={endDateTime}
          startDate={startDate}
          endDate={endDate}
        />
      )}

      {/* Summary Cost Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-medium uppercase">
            Tổng Tiền Suất Ăn
          </div>
          <div className="text-xl font-black text-slate-900 mt-1">
            {formatVND(totals.mealAmount)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {totals.mealCount.toLocaleString("vi-VN")} suất
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-medium uppercase">
            Tổng Tiền Sữa Cấp
          </div>
          <div className="text-xl font-black text-cyan-700 mt-1">
            {formatVND(totals.milkAmount)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {totals.milkCount.toLocaleString("vi-VN")} đơn vị
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-medium uppercase">
            Chi Phí Phát Sinh
          </div>
          <div className="text-xl font-black text-violet-700 mt-1">
            {formatVND(totals.extraAmount)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {totals.extraCount.toLocaleString("vi-VN")} đơn vị
          </div>
        </div>

        {/* Chi phí nhân công — của LƯỢT ÁP DỤNG đang có hiệu lực, đã cắt
            theo đúng khoảng lọc đang chọn, nên thẻ này đổi theo bộ lọc y như
            ba thẻ bên trái. Bản nháp chưa áp dụng không đụng tới nó. */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-medium uppercase">
            Chi Phí Nhân Công
          </div>
          <div className="text-xl font-black text-teal-700 mt-1">
            {formatVND(totals.laborAmount)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {laborCosts.effective === null
              ? "Chưa áp dụng lượt nào"
              : `${totals.laborDays.toLocaleString("vi-VN")} ngày công`}
          </div>
        </div>

        <div className="bg-gradient-to-br from-slate-900 to-indigo-950 p-4 rounded-2xl text-white shadow-md border border-slate-800">
          <div className="text-xs text-amber-400 font-bold uppercase">
            Tổng Chi Phí Toàn Bộ
          </div>
          <div className="text-2xl font-black text-amber-400 mt-1">
            {formatVND(totals.grandTotal)}
          </div>
          <div className="text-xs text-slate-300 mt-1">
            Áp dụng từ {startDate} &rarr; {endDate}
          </div>
        </div>
      </div>

      {/* Menu chọn bảng kê */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 space-y-3">
        <div>
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider px-1 mb-1.5">
            Bảng kê tổng hợp
          </div>
          <div className="flex flex-wrap gap-2">
            {SUMMARY_MENU.map((item) => {
              const isActive = reportType === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setReportType(item.id)}
                  title={item.hint}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold border transition ${
                    isActive
                      ? "bg-emerald-600 border-emerald-600 text-white shadow-sm"
                      : "bg-white border-slate-200 text-slate-600 hover:border-emerald-400 hover:text-emerald-700"
                  }`}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}

            {/* Không phải một bảng kê để xem — nút này xuất thẳng ra file
                Excel gộp toàn bộ bảng kê ở trên, nên để màu khác hẳn. */}
            <button
              onClick={handleExportWorkbook}
              disabled={exportingWorkbook}
              title="Xuất một file Excel gồm tất cả bảng kê ở trên, mỗi bảng một sheet"
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold border transition ${
                exportingWorkbook
                  ? "bg-slate-200 border-slate-200 text-slate-500 cursor-wait"
                  : "bg-amber-500 border-amber-500 text-slate-950 hover:bg-amber-400 hover:border-amber-400 shadow-sm"
              }`}
            >
              {exportingWorkbook ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FileDown className="w-4 h-4" />
              )}
              <span>
                {exportingWorkbook
                  ? "Đang dựng file Excel…"
                  : "Báo cáo tổng hợp"}
              </span>
            </button>
          </div>
        </div>

        <div className="pt-2 border-t border-slate-100">
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider px-1 mb-1.5 flex items-center gap-1.5">
            <Clock className="w-3 h-3" /> Chi tiết theo ca — nhân viên x ngày
          </div>
          <div className="flex flex-wrap gap-2">
            {SHIFT_ORDER.map((code) => {
              const isActive = reportType === code;
              return (
                <button
                  key={code}
                  onClick={() => setReportType(code)}
                  title={`${code} • ${shiftWindow(shifts, code)}`}
                  className={`flex items-baseline gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition ${
                    isActive
                      ? "bg-slate-900 border-slate-900 text-amber-400 shadow-sm"
                      : "bg-white border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-900"
                  }`}
                >
                  <span>{reportShiftLabel(code)}</span>
                  <span className="font-normal font-mono text-[11px] text-slate-500">
                    {code}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Thống kê suất ăn tháng */}
      {reportType === "monthly-stats" && (
        <MonthlyMealStatsReport
          classified={classified}
          days={days}
          pricing={pricing}
          shiftCategories={shiftCategories}
          manualMeals={manualMeals}
          milkEntries={milkEntries}
          extraCosts={extraCosts}
          laborSegments={laborSegments}
          laborWorkDayRule={laborWorkDayRule}
          startDate={startDate}
          endDate={endDate}
        />
      )}

      {/* Phân bổ tiền ăn */}
      {reportType === "cost-allocation" && (
        <MealCostAllocationReport
          classified={classified}
          pricing={pricing}
          shiftCategories={shiftCategories}
          manualMeals={manualMeals}
          milkEntries={milkEntries}
          extraCosts={extraCosts}
          laborSegments={laborSegments}
          startDate={startDate}
          endDate={endDate}
        />
      )}

      {/* Chi phí nhân công — nhập đợt thuê rồi bấm "Áp dụng" */}
      {reportType === "labor-cost" && (
        <LaborCostReport
          state={laborCosts}
          loading={laborCostsLoading}
          segments={laborSegments}
          onSave={onSaveLaborCost}
          onDelete={onDeleteLaborCost}
          onApply={onApplyLaborCosts}
          onRestoreBatch={onRestoreLaborBatch}
          startDate={laborRange.from}
          endDate={laborRange.to}
        />
      )}

      {/* Total suất ăn — 12 tháng */}
      {reportType === "yearly-total" &&
        (monthlyCostsError ? (
          <MonthlyCostsProblem
            error={monthlyCostsError}
            onReload={onReloadMonthlyCosts}
          />
        ) : monthlyCosts.length === 0 ? (
          <div className="p-10 bg-white rounded-2xl border border-slate-200 text-center text-xs text-slate-500">
            {monthlyCostsLoading
              ? "Đang tổng hợp chi phí 12 tháng trên SQL Server…"
              : `Không có số liệu chi phí cho năm ${endDate.slice(0, 4)}.`}
          </div>
        ) : (
          <YearlyTotalReport
            monthlyCosts={monthlyCostsWithLabor}
            year={trendYear}
          />
        ))}

      {/* Chi tiết từng ca */}
      {SHIFT_ORDER.includes(reportType as ShiftCode) && (
        <ShiftDailyPivotReport
          shiftCode={reportType as ShiftCode}
          shifts={shifts}
          classified={classified}
          manualMeals={manualMeals}
          days={days}
          startDate={startDate}
          endDate={endDate}
        />
      )}

      {/* Phân bổ theo bộ phận */}
      {reportType === "dept-allocation" && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2 text-xs font-semibold text-slate-700">
            <span>BẢNG BÁO CÁO PHÂN BỔ TIỀN ĂN CHO CÁC BỘ PHẬN</span>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-emerald-700 font-bold font-mono">
                {CATEGORY_COLUMNS.map(
                  (c) =>
                    `${MEAL_CATEGORY_META[c].label}: ${Math.round(deptUnitPrices[c] / 1000).toLocaleString("vi-VN")}K`,
                ).join(" • ")}
              </span>
              <button
                onClick={handleExportAllocationCSV}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" /> CSV
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px] border-collapse [&_td]:border [&_td]:border-slate-300 [&_th]:border [&_th]:border-slate-700">
              <thead className="bg-slate-900 text-white font-bold uppercase tracking-wider text-xs">
                <tr>
                  <th className="py-3.5 px-4">Bộ Phận</th>
                  {CATEGORY_COLUMNS.map((c) => (
                    <th
                      key={c}
                      className={`py-3.5 px-3 text-center ${CATEGORY_HEAD_TONE[c]}`}
                    >
                      {MEAL_CATEGORY_META[c].label}
                      <div className="font-normal normal-case opacity-80">
                        {Math.round(deptUnitPrices[c] / 1000).toLocaleString(
                          "vi-VN",
                        )}
                        K
                      </div>
                    </th>
                  ))}
                  <th className="py-3.5 px-4 text-center bg-slate-800">
                    Tổng Suất Ăn
                  </th>
                  <th className="py-3.5 px-4 text-right bg-emerald-600 text-slate-950 font-extrabold">
                    Thành Tiền (VNĐ)
                  </th>
                </tr>
              </thead>
              <tbody className="text-slate-800">
                {deptAllocationData.map((d) => (
                  <tr key={d.deptName} className="hover:bg-slate-50 transition">
                    <td className="py-3 px-4 font-bold text-slate-900">
                      {d.deptName}
                    </td>
                    {CATEGORY_COLUMNS.map((c) => (
                      <td
                        key={c}
                        className={`py-3 px-3 text-center font-mono ${
                          d.counts[c] > 0
                            ? `font-semibold ${CATEGORY_CELL_TONE[c]}`
                            : "text-slate-400"
                        }`}
                      >
                        {d.counts[c] > 0
                          ? d.counts[c].toLocaleString("vi-VN")
                          : "-"}
                      </td>
                    ))}
                    <td className="py-3 px-4 text-center font-bold text-slate-900 bg-slate-50">
                      {d.totalMeals.toLocaleString("vi-VN")}
                    </td>
                    <td className="py-3 px-4 text-right font-extrabold text-slate-900 font-mono whitespace-nowrap">
                      {formatVND(d.totalAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-900 text-white font-extrabold uppercase text-xs">
                <tr>
                  <td className="py-4 px-4">TỔNG CỘNG PHÂN BỔ</td>
                  {CATEGORY_COLUMNS.map((c) => (
                    <td
                      key={c}
                      className="py-4 px-3 text-center font-mono text-white"
                    >
                      {categoryTotals[c].toLocaleString("vi-VN")}
                    </td>
                  ))}
                  <td className="py-4 px-4 text-center font-mono text-amber-400">
                    {totals.mealCount.toLocaleString("vi-VN")}
                  </td>
                  <td className="py-4 px-4 text-right font-mono text-emerald-400 text-sm whitespace-nowrap">
                    {formatVND(totals.mealAmount)}
                  </td>
                </tr>

                {/* Đối chiếu với bảng "Thống kê suất ăn tháng": bảng này chỉ
                    có tiền suất ăn, chênh lệch giữa hai bảng đúng bằng tiền
                    sữa — sữa nhập theo ngày, không có bộ phận thụ hưởng. */}
                <tr className="bg-slate-100 text-slate-700 normal-case">
                  <td
                    className="py-2.5 px-4 font-semibold"
                    colSpan={CATEGORY_COLUMNS.length + 1}
                  >
                    Tiền sữa &mdash; cấp theo ngày, không phân bổ cho bộ phận
                    nào
                  </td>
                  <td className="py-2.5 px-4 text-center font-mono text-slate-600">
                    {totals.milkCount.toLocaleString("vi-VN")}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono text-cyan-700 text-sm whitespace-nowrap">
                    {formatVND(totals.milkAmount)}
                  </td>
                </tr>

                {(totals.extraCount > 0 || totals.extraAmount > 0) && (
                  <tr className="bg-violet-50 text-violet-900 normal-case">
                    <td
                      className="py-2.5 px-4 font-semibold"
                      colSpan={CATEGORY_COLUMNS.length + 1}
                    >
                      Chi phí phát sinh &mdash; cấp theo ngày, không phân bổ cho
                      bộ phận nào
                    </td>
                    <td className="py-2.5 px-4 text-center font-mono">
                      {totals.extraCount.toLocaleString("vi-VN")}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-sm whitespace-nowrap">
                      {formatVND(totals.extraAmount)}
                    </td>
                  </tr>
                )}

                {(totals.laborDays > 0 || totals.laborAmount > 0) && (
                  <tr className="bg-teal-50 text-teal-900 normal-case">
                    <td
                      className="py-2.5 px-4 font-semibold"
                      colSpan={CATEGORY_COLUMNS.length + 1}
                    >
                      Chi phí nhân công &mdash; thuê theo đợt, không phân bổ
                      cho bộ phận nào
                    </td>
                    <td
                      className="py-2.5 px-4 text-center font-mono"
                      title="Số ngày công được tính tiền, không phải số suất ăn"
                    >
                      {totals.laborDays.toLocaleString("vi-VN")}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-sm whitespace-nowrap">
                      {formatVND(totals.laborAmount)}
                    </td>
                  </tr>
                )}

                <tr className="bg-amber-100 text-slate-900">
                  <td
                    className="py-3 px-4"
                    colSpan={CATEGORY_COLUMNS.length + 2}
                  >
                    TỔNG THANH TOÁN
                    <span className="ml-2 font-normal normal-case text-[11px] text-slate-600">
                      (khớp với dòng TOTAL của bảng &ldquo;Thống kê suất ăn
                      tháng&rdquo;)
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-sm whitespace-nowrap">
                    {formatVND(totals.grandTotal)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="px-4 py-3 bg-slate-50 border-t border-slate-300 text-xs text-slate-600 leading-relaxed">
            Người Hàn = thuộc bộ phận lớn KR, tính giá suất Hàn dù chấm ở máy
            nào. Các bộ phận còn lại luôn tính giá suất người Việt, kể cả khi
            chấm ở máy CT Korea. Loại suất của từng ca lấy theo tab Cấu Hình Giá
            Suất Ăn; suất của người Việt vào ngày sinh nhật tập thể tính giá
            suất đặc biệt. Bảng đã gồm cả suất nhập ở tab Nhập Thủ Công Ca, tính
            vào bộ phận thụ hưởng đã ghi khi nhập.{" "}
            <strong>Dòng TỔNG CỘNG PHÂN BỔ chỉ là tiền suất ăn</strong> — sữa,
            chi phí phát sinh và chi phí nhân công đều không chia được cho bộ
            phận nào (sữa và phát sinh cấp theo ngày, nhân công phục vụ cả nhà
            ăn), nên chúng được cộng riêng ở các dòng dưới. Vì vậy tổng của
            bảng này luôn nhỏ hơn TOTAL của bảng &ldquo;Thống kê suất ăn
            tháng&rdquo; đúng bằng ba khoản đó; dòng TỔNG THANH TOÁN là con số
            khớp giữa hai bảng.
          </div>
        </div>
      )}

      {/* View 2: Yearly Trends & Chart */}
      {reportType === "yearly" && monthlyCostsError && (
        <MonthlyCostsProblem
          error={monthlyCostsError}
          onReload={onReloadMonthlyCosts}
        />
      )}

      {reportType === "yearly" && monthlyCostsLoading && (
        <div className="p-10 bg-white rounded-2xl border border-slate-200 text-center text-xs text-slate-500">
          Đang tổng hợp chi phí 12 tháng trên SQL Server…
        </div>
      )}

      {reportType === "yearly" &&
        !monthlyCostsLoading &&
        !monthlyCostsError &&
        monthlyCosts.length === 0 && (
          <div className="p-10 bg-white rounded-2xl border border-slate-200 text-center space-y-1">
            <div className="text-sm font-bold text-slate-800">
              Không có số liệu chi phí cho năm {endDate.slice(0, 4)}
            </div>
            <p className="text-xs text-slate-500">
              Chọn khoảng thời gian thuộc năm khác ở thanh trên để xem xu hướng
              năm đó.
            </p>
          </div>
        )}

      {reportType === "yearly" &&
        !monthlyCostsError &&
        monthlyCosts.length > 0 && (
          <div className="space-y-6">
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4">
              <div className="flex flex-wrap justify-between items-center gap-2">
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-emerald-600" /> Biểu Đồ
                  Chi Phí Ăn Các Tháng Năm {trendYear}
                </h3>
                <span className="text-xs text-slate-600">
                  Tính trực tiếp từ log chấm ăn theo đơn giá đang áp dụng
                </span>
              </div>

              <div className="h-80 w-full pt-4">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={monthlyChartData}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="#e2e8f0"
                    />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 12, fill: "#334155" }}
                    />
                    <YAxis
                      tick={{ fontSize: 12, fill: "#334155" }}
                      tickFormatter={compactVND}
                    />
                    <Tooltip
                      formatter={(value: any, name: any) => [
                        `${Number(value).toLocaleString("vi-VN")} ₫`,
                        name,
                      ]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />

                    {/* Cột xếp chồng — 2px viền nền tách các lớp cho dễ đọc. */}
                    {TREND_SERIES.map((s, i) => (
                      <Bar
                        key={s.key}
                        dataKey={s.key}
                        name={s.name}
                        stackId="a"
                        fill={s.color}
                        stroke="#ffffff"
                        strokeWidth={2}
                        radius={
                          i === TREND_SERIES.length - 1
                            ? ([4, 4, 0, 0] as [number, number, number, number])
                            : undefined
                        }
                      />
                    ))}

                    {/* Đường tổng chi phí tháng */}
                    <Line
                      type="monotone"
                      dataKey="Sum"
                      name="Tổng Chi Phí Tháng"
                      stroke="#0b0b0b"
                      strokeWidth={2}
                      dot={{ r: 4 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Bảng số liệu — vừa tra được con số chính xác, vừa là bản đọc thay
              cho biểu đồ khi in đen trắng hoặc với người khó phân biệt màu. */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="p-4 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
                SỐ LIỆU CHI TIẾT 12 THÁNG NĂM {trendYear}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px] border-collapse [&_td]:border [&_td]:border-slate-300 [&_th]:border [&_th]:border-slate-700">
                  <thead className="bg-slate-900 text-white font-bold uppercase text-xs">
                    <tr>
                      <th className="py-3 px-4">Tháng</th>
                      {TREND_SERIES.map((s) => (
                        <th
                          key={s.key}
                          className="py-3 px-3 text-right whitespace-nowrap"
                        >
                          <span className="flex items-center justify-end gap-1.5">
                            <span
                              className="w-2.5 h-2.5 rounded-sm shrink-0"
                              style={{ backgroundColor: s.color }}
                            />
                            {s.name}
                          </span>
                        </th>
                      ))}
                      <th className="py-3 px-4 text-right bg-emerald-600 text-slate-950 whitespace-nowrap">
                        Tổng Tháng
                      </th>
                    </tr>
                  </thead>
                  <tbody className="text-slate-800">
                    {monthlyChartData.map((row) => (
                      <tr
                        key={row.costMonth}
                        className="hover:bg-slate-50 transition"
                      >
                        <td className="py-2.5 px-4 font-bold text-slate-900 whitespace-nowrap">
                          {row.costMonth}
                        </td>
                        {TREND_SERIES.map((s) => (
                          <td
                            key={s.key}
                            className={`py-2.5 px-3 text-right font-mono whitespace-nowrap ${
                              yearlyValue(row, s.key) > 0
                                ? "text-slate-800"
                                : "text-slate-400"
                            }`}
                          >
                            {yearlyValue(row, s.key) > 0
                              ? formatVND(yearlyValue(row, s.key))
                              : "-"}
                          </td>
                        ))}
                        <td className="py-2.5 px-4 text-right font-mono font-extrabold text-slate-900 bg-emerald-50 whitespace-nowrap">
                          {formatVND(row.Sum)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-900 text-white font-extrabold uppercase text-xs">
                    <tr>
                      <td className="py-3.5 px-4">Cả Năm</td>
                      {TREND_SERIES.map((s) => (
                        <td
                          key={s.key}
                          className="py-3.5 px-3 text-right font-mono text-white whitespace-nowrap"
                        >
                          {formatVND(
                            monthlyChartData.reduce(
                              (sum, r) => sum + yearlyValue(r, s.key),
                              0,
                            ),
                          )}
                        </td>
                      ))}
                      <td className="py-3.5 px-4 text-right font-mono text-emerald-400 whitespace-nowrap">
                        {formatVND(
                          monthlyChartData.reduce((sum, r) => sum + r.Sum, 0),
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        )}
    </div>
  );
};
