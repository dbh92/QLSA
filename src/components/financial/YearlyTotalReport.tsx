import React from 'react';
import { MonthlyCostRow } from '../../types';
import { formatVND, exportToCSV } from '../../services/mealEngine';
import { Download } from 'lucide-react';
import { YEARLY_SERIES as SERIES, yearlyValue } from './reportModel';

/**
 * "Total suất ăn" — 12 tháng của một năm, mỗi tháng HAI dòng: số suất ở trên,
 * thành tiền ở dưới. Số liệu do SA_MealCost_GetMonthly tổng hợp trên SQL
 * Server theo đúng bộ đơn giá đang áp dụng.
 *
 * Danh sách cột nằm ở reportModel (`YEARLY_SERIES`) để sheet "Total suất ăn"
 * của file Excel tổng hợp dùng chung.
 */

interface YearlyTotalReportProps {
  monthlyCosts: MonthlyCostRow[];
  year: string;
}

export const YearlyTotalReport: React.FC<YearlyTotalReportProps> = ({
  monthlyCosts,
  year,
}) => {

  const yearSum = (pick: (r: MonthlyCostRow) => number) =>
    monthlyCosts.reduce((acc, r) => acc + pick(r), 0);

  const handleExport = () => {
    const headers = [
      'Tháng',
      'Chỉ tiêu',
      ...SERIES.map((s) => s.name),
      'Tổng tháng',
    ];

    const rows: (string | number)[][] = [];
    monthlyCosts.forEach((r) => {
      rows.push([
        r.costMonth,
        'Số suất',
        ...SERIES.map((s) => (s.countKey ? yearlyValue(r, s.countKey) : '')),
        '',
      ]);
      rows.push([
        r.costMonth,
        'Thành tiền',
        ...SERIES.map((s) => yearlyValue(r, s.key)),
        r.Sum,
      ]);
    });

    rows.push([
      'CẢ NĂM',
      'Thành tiền',
      ...SERIES.map((s) => yearSum((r) => yearlyValue(r, s.key))),
      yearSum((r) => r.Sum),
    ]);

    exportToCSV(`Total_Suat_An_${year}`, headers, rows);
  };

  const cell = 'border border-slate-300 px-3 py-2 whitespace-nowrap';

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-slate-900 uppercase tracking-wide">
            Total suất ăn — số liệu chi tiết 12 tháng năm {year}
          </div>
          <div className="text-xs text-slate-600 mt-1">
            Mỗi tháng gồm hai dòng: số suất ở trên, thành tiền ở dưới.
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
        <table className="w-full text-[13px] border-collapse">
          <thead className="bg-slate-900 text-white font-bold uppercase text-xs">
            <tr>
              <th className={`${cell} text-left border-slate-700`}>Tháng</th>
              <th className={`${cell} text-left border-slate-700`}>Chỉ tiêu</th>
              {SERIES.map((s) => (
                <th key={s.key} className={`${cell} text-right border-slate-700`}>
                  <span className="flex items-center justify-end gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ backgroundColor: s.color }}
                    />
                    {s.name}
                  </span>
                </th>
              ))}
              <th
                className={`${cell} text-right border-slate-700 bg-emerald-600 text-slate-950`}
              >
                Tổng tháng
              </th>
            </tr>
          </thead>

          <tbody>
            {monthlyCosts.map((r) => (
                <React.Fragment key={r.costMonth}>
                  {/* Dòng số suất */}
                  <tr className="bg-slate-50">
                    <td
                      rowSpan={2}
                      className={`${cell} font-bold text-slate-900 align-middle`}
                    >
                      {r.costMonth}
                    </td>
                    <td className={`${cell} text-[11px] font-semibold uppercase text-slate-600`}>
                      Số suất
                    </td>
                    {SERIES.map((s) => {
                      const count = s.countKey ? yearlyValue(r, s.countKey) : null;
                      return (
                        <td
                          key={s.key}
                          className={`${cell} text-right font-mono ${
                            count ? 'text-slate-800' : 'text-slate-400'
                          }`}
                        >
                          {count === null ? '—' : count ? count.toLocaleString('vi-VN') : '-'}
                        </td>
                      );
                    })}
                    <td className={`${cell} bg-emerald-50`} />
                  </tr>

                  {/* Dòng thành tiền */}
                  <tr className="hover:bg-amber-50 transition">
                    <td className={`${cell} text-[11px] font-semibold uppercase text-slate-600`}>
                      Thành tiền
                    </td>
                    {SERIES.map((s) => {
                      const value = yearlyValue(r, s.key);
                      return (
                        <td
                          key={s.key}
                          className={`${cell} text-right font-mono ${
                            value ? 'text-slate-900' : 'text-slate-400'
                          }`}
                        >
                          {value ? formatVND(value) : '-'}
                        </td>
                      );
                    })}
                    <td
                      className={`${cell} text-right font-mono font-extrabold text-slate-900 bg-emerald-50`}
                    >
                      {formatVND(r.Sum)}
                    </td>
                  </tr>
                </React.Fragment>
              ))}
          </tbody>

          <tfoot className="bg-slate-900 text-white font-extrabold uppercase text-xs">
            <tr>
              <td className={`${cell} border-slate-700`} colSpan={2}>
                Cả năm
              </td>
              {SERIES.map((s) => (
                <td
                  key={s.key}
                  className={`${cell} border-slate-700 text-right font-mono text-white`}
                >
                  {formatVND(yearSum((r) => yearlyValue(r, s.key)))}
                </td>
              ))}
              <td className={`${cell} border-slate-700 text-right font-mono text-emerald-400`}>
                {formatVND(yearSum((r) => r.Sum))}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="px-4 py-3 bg-slate-50 border-t border-slate-300 text-xs text-slate-600">
        Cột Sữa và Chi Phí Phát Sinh lấy theo tiền đã nhập ở tab Quản Lý Sữa
        nên không có số suất tương ứng. Cột Chi Phí Nhân Công là tiền của lượt
        &ldquo;Áp dụng&rdquo; đang có hiệu lực, chia theo ngày làm việc rồi
        cắt vào từng tháng.
      </div>
    </div>
  );
};
