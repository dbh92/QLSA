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
  ClassifiedLog,
  LaborSegment,
  StatGroupTone,
  StatRowTone,
  buildMonthlyStatRows,
  dayLabel,
  dayMonthLabel,
  statRowsGrandTotal,
} from './reportModel';
import { LaborWorkDayRule } from '../../types';

/**
 * "Bảng kê suất ăn tháng" — bản dựng lại sheet tổng của bảng kê Excel gửi nhà
 * ăn: mỗi cột một ngày, mỗi dòng một hạng mục (ca ăn Hàn, ca ăn Việt, ký số,
 * sữa, suất sinh nhật), cột phải là TOTAL / ĐƠN GIÁ / AMOUNT.
 *
 * Các dòng do `buildMonthlyStatRows` trong reportModel dựng — dùng chung với
 * sheet "Thống kê suất ăn tháng" của file Excel tổng hợp. Ở đây chỉ còn việc
 * ánh xạ sắc thái sang class Tailwind và vẽ bảng.
 */

const ROW_TONE: Record<StatRowTone, string> = {
  korea: 'bg-orange-50',
  viet: 'bg-emerald-50',
  sub: 'bg-white text-slate-600',
  total: 'bg-amber-100 font-bold',
  birthday: 'bg-sky-100 font-semibold',
  milk: 'bg-indigo-50',
  extra: 'bg-violet-50',
  labor: 'bg-teal-50',
};

const GROUP_TONE: Record<StatGroupTone, string> = {
  korea: 'bg-orange-200 text-orange-950',
  viet: 'bg-emerald-200 text-emerald-950',
  milk: 'bg-indigo-100 text-indigo-900',
  extra: 'bg-violet-100 text-violet-900',
  labor: 'bg-teal-100 text-teal-900',
  birthday: 'bg-sky-200 text-sky-950',
};

interface MonthlyMealStatsReportProps {
  classified: ClassifiedLog[];
  days: string[];
  pricing: MealPricing;
  /** Bảng gán (ca × nhóm nhân sự) -> loại suất, quyết định đơn giá từng dòng. */
  shiftCategories: ShiftCategoryLookup;
  /** Suất nhập tay đã phân loại — cùng một lượt với mọi bảng khác trong tab. */
  manualMeals: CountedManualMeal[];
  milkEntries: DailyMilkEntry[];
  extraCosts: ExtraCostEntry[];
  /**
   * Phần giao giữa các đợt thuê nhân công ĐÃ ÁP DỤNG và khoảng lọc — rỗng khi
   * chưa từng bấm "Áp dụng", và khi đó khối "Chi phí nhân công" không hiện.
   */
  laborSegments: LaborSegment[];
  /** Quy tắc đếm ngày làm việc của lượt áp dụng đang có hiệu lực. */
  laborWorkDayRule: LaborWorkDayRule;
  startDate: string;
  endDate: string;
}

export const MonthlyMealStatsReport: React.FC<MonthlyMealStatsReportProps> = ({
  classified,
  days,
  pricing,
  shiftCategories,
  manualMeals,
  milkEntries,
  extraCosts,
  laborSegments,
  laborWorkDayRule,
  startDate,
  endDate,
}) => {
  const rows = useMemo(
    () =>
      buildMonthlyStatRows(
        classified,
        pricing,
        shiftCategories,
        manualMeals,
        milkEntries,
        extraCosts,
        laborSegments,
        laborWorkDayRule
      ),
    [
      classified,
      pricing,
      shiftCategories,
      manualMeals,
      milkEntries,
      extraCosts,
      laborSegments,
      laborWorkDayRule,
    ]
  );

  const grandTotal = statRowsGrandTotal(rows);

  const handleExport = () => {
    const headers = [
      'HẠNG MỤC',
      'DATE',
      ...days.map(dayMonthLabel),
      'TOTAL',
      'ĐƠN GIÁ',
      'AMOUNT',
      'NOTE',
    ];

    /* Cột DATE mang tên ca của dòng; dòng Sữa / Chi phí phát sinh còn có tên
       hạng mục ở `subLabel` nên ghép vào để file CSV không mất thông tin đó. */
    const dateCell = (label: string, subLabel?: string) =>
      subLabel ? `${label} — ${subLabel}` : label;

    const body: (string | number)[][] = rows.map((r) => [
      r.groupLabel ?? '',
      dateCell(r.label, r.subLabel),
      ...days.map((d) => r.series?.byDay[d] ?? ''),
      r.quantity,
      r.unitPrice ?? '',
      r.amount,
      r.note ?? '',
    ]);

    body.push([
      'TOTAL',
      '',
      ...days.map(() => ''),
      '',
      '',
      grandTotal,
      '',
    ]);

    exportToCSV(
      `Bang_Ke_Suat_An_Thang_${startDate}_${endDate}`,
      headers,
      body
    );
  };

  const cell = 'border border-slate-400 px-2 py-1.5 text-center';

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-slate-900 uppercase tracking-wide">
            Bảng kê suất ăn — {startDate} &rarr; {endDate}
          </div>
          <div className="text-xs text-slate-600 mt-1">
            Mỗi cột là một ngày; ca đêm 22:50 &rarr; 01:50 được tính trọn cho
            ngày kết thúc ca, tức ngày hôm sau. Suất sinh nhật được tách khỏi
            số suất của từng ca và tô{' '}
            <span className="px-1 rounded bg-sky-100 text-sky-800 font-semibold">
              xanh dương
            </span>
            . Đơn giá mỗi dòng là giá của loại suất ghi ngay dưới tên ca. Khối{' '}
            <span className="px-1 rounded bg-indigo-100 text-indigo-800 font-semibold">
              Sữa
            </span>{' '}
            và{' '}
            <span className="px-1 rounded bg-violet-100 text-violet-800 font-semibold">
              Chi phí phát sinh
            </span>{' '}
            có hai dòng con <strong>Ca ngày</strong> / <strong>Ca đêm</strong>{' '}
            ở cột DATE, mỗi dòng mang đơn giá và thành tiền của riêng ca đó.
            Khối{' '}
            <span className="px-1 rounded bg-teal-100 text-teal-900 font-semibold">
              Chi phí nhân công
            </span>{' '}
            nằm ngay dưới đó: mỗi dòng là một người trong một đợt thuê, ô ngày
            đánh dấu từng <strong>ngày công</strong> được tính tiền, nên TOTAL
            là số ngày công và AMOUNT = TOTAL &times; đơn giá một ngày. Cột
            NOTE ghi trọn phép chia.
          </div>
        </div>
        <button
          onClick={handleExport}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" /> CSV
        </button>
      </div>

      <div className="overflow-auto max-h-[72vh]">
        <table className="text-[13px] border-collapse whitespace-nowrap">
          <thead className="sticky top-0 z-20 bg-slate-700 text-white">
            <tr>
              <th
                className={`${cell} sticky left-0 z-10 bg-slate-700`}
                style={{ minWidth: 150, width: 150 }}
              >
                HẠNG MỤC
              </th>
              <th
                className={`${cell} sticky z-10 bg-slate-700`}
                style={{ left: 150, minWidth: 96, width: 96 }}
              >
                DATE
              </th>
              {days.map((d) => (
                <th key={d} title={d} className={`${cell} min-w-[36px]`}>
                  {dayLabel(d)}
                </th>
              ))}
              {(
                [
                  ['TOTAL', 'bg-slate-800 min-w-[64px]'],
                  ['ĐƠN GIÁ', 'bg-slate-800 min-w-[72px]'],
                  ['AMOUNT', 'bg-emerald-700 min-w-[110px]'],
                  ['NOTE', 'bg-slate-800 min-w-[90px]'],
                ] as const
              ).map(([label, tone]) => (
                <th key={label} className={`${cell} ${tone}`}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={ROW_TONE[r.tone]}>
                {r.groupLabel !== undefined && (
                  <td
                    rowSpan={r.groupSpan}
                    className={`${cell} sticky left-0 z-10 font-bold align-middle ${
                      r.groupTone ? GROUP_TONE[r.groupTone] : 'bg-slate-100'
                    }`}
                    style={{ minWidth: 150, width: 150 }}
                  >
                    {r.groupLabel}
                  </td>
                )}
                <td
                  className={`${cell} sticky z-10 bg-inherit font-bold text-slate-800`}
                  style={{ left: 150, minWidth: 96, width: 96 }}
                >
                  {r.label}
                  {r.subLabel && (
                    <div className="font-normal text-[11px] leading-tight text-slate-600">
                      {r.subLabel}
                    </div>
                  )}
                </td>

                {days.map((d) => {
                  const v = r.series?.byDay[d];
                  return (
                    <td key={d} className={`${cell} font-mono`}>
                      {v ? (
                        v.toLocaleString('vi-VN')
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                  );
                })}

                <td className={`${cell} font-mono font-bold text-slate-900 bg-slate-50`}>
                  {r.quantity
                    ? Math.round(r.quantity).toLocaleString('vi-VN')
                    : '-'}
                </td>
                {/* Đơn giá bình quân (sữa, phát sinh, nhân công) có phần lẻ.
                    Làm tròn ở CHỖ HIỂN THỊ thôi — giá trị dùng để tính tiền
                    vẫn nguyên vẹn, nếu không bảng sẽ thôi khớp nhau. */}
                <td className={`${cell} font-mono text-slate-700`}>
                  {r.unitPrice !== null
                    ? Math.round(r.unitPrice).toLocaleString('vi-VN')
                    : '-'}
                </td>
                <td className={`${cell} font-mono font-bold text-right text-slate-900`}>
                  {r.amount ? formatVND(r.amount) : '-'}
                </td>
                <td className={`${cell} text-slate-700`}>{r.note ?? ''}</td>
              </tr>
            ))}
          </tbody>

          <tfoot className="sticky bottom-0 z-20">
            <tr className="bg-slate-800 text-white font-extrabold">
              <td
                colSpan={2}
                className={`${cell} sticky left-0 z-10 bg-slate-800 text-left`}
              >
                TOTAL
              </td>
              <td colSpan={days.length + 2} className={cell} />
              <td className={`${cell} text-right bg-amber-500 text-slate-950`}>
                {formatVND(grandTotal)}
              </td>
              <td className={cell} />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="px-4 py-3 bg-slate-50 border-t border-slate-300 text-xs text-slate-600 leading-relaxed">
        Suất nhập tay lấy từ tab Nhập Thủ Công Ca, và vào bảng theo nhóm nhân
        sự đã chọn khi nhập: suất <strong>người Việt</strong> thành dòng{' '}
        <strong>Ký số</strong> riêng dưới dòng ca, suất{' '}
        <strong>người Hàn</strong> cộng thẳng vào dòng ca của khối 한국 đúng
        ca và đúng ngày, không có dòng Ký số. Đơn giá từng ca lấy theo loại
        suất đang gán cho cặp (ca × nhóm nhân sự) trong tab Cấu Hình Giá Suất
        Ăn — nên cùng một ca có thể là cơm Hàn ở khối người Hàn và bữa phụ ở
        khối người Việt. Mỳ Hàn nằm ngay trong dòng ca của nó, không tách
        thành dòng riêng.
      </div>
    </div>
  );
};
