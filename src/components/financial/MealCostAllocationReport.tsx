import React, { useMemo } from 'react';
import { DailyMilkEntry, ExtraCostEntry } from '../../types';
import {
  CountedManualMeal,
  MealPricing,
  ShiftCategoryLookup,
  formatVND,
  exportToCSV,
} from '../../services/mealEngine';
import { Download } from 'lucide-react';
import {
  AllocationColumn,
  AllocationTone,
  ClassifiedLog,
  LaborSegment,
  allocationHeaderGroups,
  buildAllocationColumns,
} from './reportModel';

/**
 * "Bảng phân bổ tiền ăn" — bản tóm tắt một kỳ trên MỘT bảng: mỗi hạng mục một
 * cột, ba dòng Số lượng / Đơn giá / Thành tiền, chốt bằng tổng thanh toán.
 *
 * Các cột do `buildAllocationColumns` trong reportModel dựng — dùng chung với
 * sheet "Phân bổ tiền ăn" của file Excel tổng hợp.
 */

const COLUMN_TONE: Record<AllocationTone, string> = {
  korea: 'bg-orange-100 text-orange-900',
  koreaSub: 'bg-orange-50 text-orange-800',
  viet: 'bg-emerald-50 text-emerald-900',
  milk: 'bg-indigo-50 text-indigo-900',
  extra: 'bg-violet-50 text-violet-900',
  labor: 'bg-teal-50 text-teal-900',
  birthday: 'bg-green-100 text-green-900',
};

interface MealCostAllocationReportProps {
  classified: ClassifiedLog[];
  pricing: MealPricing;
  /** Bảng gán (ca × nhóm nhân sự) -> loại suất, quyết định đơn giá từng cột. */
  shiftCategories: ShiftCategoryLookup;
  /** Suất nhập tay đã phân loại — cùng một lượt với mọi bảng khác trong tab. */
  manualMeals: CountedManualMeal[];
  milkEntries: DailyMilkEntry[];
  extraCosts: ExtraCostEntry[];
  /**
   * Phần giao giữa các đợt thuê nhân công ĐÃ ÁP DỤNG và khoảng lọc. Rỗng khi
   * chưa từng bấm "Áp dụng", và khi đó cột nhân công không xuất hiện.
   */
  laborSegments: LaborSegment[];
  startDate: string;
  endDate: string;
}

export const MealCostAllocationReport: React.FC<
  MealCostAllocationReportProps
> = ({
  classified,
  pricing,
  shiftCategories,
  manualMeals,
  milkEntries,
  extraCosts,
  laborSegments,
  startDate,
  endDate,
}) => {
  const columns = useMemo(
    () =>
      buildAllocationColumns(
        classified,
        pricing,
        shiftCategories,
        manualMeals,
        milkEntries,
        extraCosts,
        laborSegments
      ),
    [
      classified,
      pricing,
      shiftCategories,
      manualMeals,
      milkEntries,
      extraCosts,
      laborSegments,
    ]
  );

  const amountOf = (c: AllocationColumn) => c.quantity * c.unitPrice;
  const grandTotal = columns.reduce((acc, c) => acc + amountOf(c), 0);

  /* Hàng tiêu đề trên: các cột liền nhau cùng nhóm gộp thành một ô, nên
     "Người Hàn" phủ cả Cơm Hàn lẫn Mì Hàn còn "Người Việt" phủ cả 6 ca. */
  const headerGroups = useMemo(() => allocationHeaderGroups(columns), [columns]);

  const handleExport = () => {
    const headers = ['Chỉ tiêu', ...columns.map((c) => `${c.group} — ${c.label}`), 'TỔNG'];
    const rows: (string | number)[][] = [
      ['Số lượng', ...columns.map((c) => Math.round(c.quantity)), ''],
      ['Đơn giá', ...columns.map((c) => Math.round(c.unitPrice)), ''],
      ['Thành tiền', ...columns.map((c) => Math.round(amountOf(c))), Math.round(grandTotal)],
    ];
    exportToCSV(`Phan_Bo_Tien_An_${startDate}_${endDate}`, headers, rows);
  };

  const cell = 'border border-slate-400 px-3 py-2.5 text-center whitespace-nowrap';

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-slate-900 uppercase tracking-wide">
            Bảng phân bổ tiền ăn — {startDate} &rarr; {endDate}
          </div>
          <div className="text-xs text-slate-600 mt-1">
            Suất sinh nhật đứng riêng một cột, không cộng vào số suất của từng
            ca.
          </div>
        </div>
        <button
          onClick={handleExport}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" /> CSV
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="text-[13px] border-collapse w-full">
          <thead>
            <tr className="bg-slate-700 text-white">
              <th className={`${cell} text-left`} rowSpan={2} colSpan={2}>
                No.
              </th>
              {headerGroups.map((g) => (
                <th key={g.group} colSpan={g.span} className={`${cell} font-bold`}>
                  {g.group}
                </th>
              ))}
              <th className={`${cell} bg-slate-800`} rowSpan={2}>
                지불 합계
                <div className="font-normal opacity-80">Tổng thanh toán</div>
              </th>
            </tr>
            <tr className="bg-slate-100 text-slate-700">
              {columns.map((c) => (
                <th key={c.key} className={`${cell} font-semibold ${COLUMN_TONE[c.tone]}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            <tr className="bg-white">
              <td
                rowSpan={3}
                className={`${cell} bg-slate-50 font-bold text-slate-700 align-middle`}
              >
                Ngày
                <br />
                thường
              </td>
              <td className={`${cell} text-left font-bold text-slate-800`}>
                수가 / Số lượng
              </td>
              {columns.map((c) => (
                <td key={c.key} className={`${cell} font-mono font-bold text-slate-900`}>
                  {Math.round(c.quantity).toLocaleString('vi-VN')}
                </td>
              ))}
              <td
                rowSpan={3}
                className={`${cell} align-middle bg-amber-100 font-mono font-extrabold text-slate-900 text-sm`}
              >
                {formatVND(grandTotal)}
              </td>
            </tr>

            <tr className="bg-slate-50">
              <td className={`${cell} text-left font-bold text-slate-800`}>
                가격 / Đơn giá
              </td>
              {columns.map((c) => (
                <td key={c.key} className={`${cell} font-mono text-slate-700`}>
                  {Math.round(c.unitPrice).toLocaleString('vi-VN')}
                </td>
              ))}
            </tr>

            <tr className="bg-white">
              <td className={`${cell} text-left font-bold text-slate-800`}>
                합계 / Thành tiền
              </td>
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`${cell} font-mono font-semibold text-right ${COLUMN_TONE[c.tone]}`}
                >
                  {formatVND(amountOf(c))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="px-4 py-3 bg-slate-50 border-t border-slate-300 text-xs text-slate-600">
        Cột từng ca của người Việt đã gộp cả suất ký số (Nhập Thủ Công Ca)
        của ca đó; suất Hàn nhập tay gộp vào cột Cơm Hàn / Mì Hàn theo loại
        suất của ca.
      </div>
    </div>
  );
};
