import React, { useMemo, useState } from 'react';
import { ShiftCode, ShiftInfo } from '../../types';
import { exportToCSV } from '../../services/mealEngine';
import { Download, Search, Users } from 'lucide-react';
import { CountedManualMeal } from '../../services/mealEngine';
import {
  ClassifiedLog,
  MANUAL_PIVOT_LABEL,
  buildShiftPivot,
  dayLabel,
  dayMonthLabel,
  reportShiftLabel,
  shiftAlias,
  shiftWindow,
} from './reportModel';

/**
 * Bảng chi tiết một ca ăn: mỗi dòng một nhân viên, mỗi cột một ngày, ô là số
 * lượt quẹt của người đó trong ca đó ngày đó. Chân bảng có dòng tổng theo
 * ngày và các dòng tách theo bộ phận lớn.
 *
 * Đây là bản dựng lại các sheet 23H / 5H / 7H / 12H / 17H / 19H của bảng kê
 * Excel gửi nhà ăn.
 */

/* Bốn cột đầu ghim trái khi cuộn ngang; cộng dồn để biết mỗi cột dính ở đâu. */
const FROZEN_WIDTHS = [48, 192, 116, 100];
const FROZEN_LEFT = FROZEN_WIDTHS.reduce<number[]>((acc, w, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + FROZEN_WIDTHS[i - 1]);
  return acc;
}, []);

const frozen = (index: number): React.CSSProperties => ({
  left: FROZEN_LEFT[index],
  minWidth: FROZEN_WIDTHS[index],
  width: FROZEN_WIDTHS[index],
});

interface ShiftDailyPivotReportProps {
  shiftCode: ShiftCode;
  shifts: ShiftInfo[];
  classified: ClassifiedLog[];
  /** Suất nhập tay đã phân loại — vào tổng của ca, không vào danh sách nhân viên. */
  manualMeals: CountedManualMeal[];
  days: string[];
  startDate: string;
  endDate: string;
}

export const ShiftDailyPivotReport: React.FC<ShiftDailyPivotReportProps> = ({
  shiftCode,
  shifts,
  classified,
  manualMeals,
  days,
  startDate,
  endDate,
}) => {
  const [keyword, setKeyword] = useState('');
  const [deptFilter, setDeptFilter] = useState<string>('ALL');

  const alias = reportShiftLabel(shiftCode);
  /* Tên ca do người dùng đặt trong SA_Shift — hiện kèm khi khác tên bảng kê,
     để không ai phải đoán hai tên đó có phải cùng một ca không. */
  const dbAlias = shiftAlias(shifts, shiftCode);
  const timeWindow = shiftWindow(shifts, shiftCode);

  const pivot = useMemo(
    () => buildShiftPivot(classified, manualMeals, shiftCode),
    [classified, manualMeals, shiftCode]
  );

  const deptOptions = useMemo(
    () => pivot.deptRows.map((d) => d.largeDept),
    [pivot]
  );

  /* Lọc chỉ ảnh hưởng danh sách nhân viên hiển thị. Dòng tổng theo ngày và
     các dòng theo bộ phận vẫn là số của TOÀN BỘ ca — đây là bảng kê để đối
     chiếu với nhà ăn, tổng của nó không được đổi theo ô tìm kiếm. */
  const visibleRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return pivot.rows.filter((r) => {
      if (deptFilter !== 'ALL' && r.largeDept !== deptFilter) return false;
      if (!kw) return true;
      return (
        r.userName.toLowerCase().includes(kw) ||
        r.userId.toLowerCase().includes(kw)
      );
    });
  }, [pivot, keyword, deptFilter]);

  const handleExport = () => {
    const headers = [
      'STT',
      'Họ Tên',
      'Mã Nhân Viên',
      'Phòng ban',
      ...days.map(dayMonthLabel),
      'Tổng Cộng',
    ];

    const rows: (string | number)[][] = visibleRows.map((r, i) => [
      i + 1,
      r.userName,
      r.userId,
      r.largeDept,
      ...days.map((d) => r.byDay[d] ?? ''),
      r.total,
    ]);

    if (pivot.manualTotal > 0) {
      rows.push([
        '',
        MANUAL_PIVOT_LABEL,
        '',
        '',
        ...days.map((d) => pivot.manualByDay[d] ?? ''),
        pivot.manualTotal,
      ]);
    }

    rows.push([
      '',
      'TỔNG THEO NGÀY',
      '',
      '',
      ...days.map((d) => pivot.dayTotals[d] ?? 0),
      pivot.grandTotal,
    ]);

    pivot.deptRows.forEach((d) => {
      rows.push([
        '',
        'TỔNG BỘ PHẬN',
        '',
        d.largeDept,
        ...days.map((day) => d.byDay[day] ?? 0),
        d.total,
      ]);
    });

    exportToCSV(`Bang_Ke_${alias}_${startDate}_${endDate}`, headers, rows);
  };

  const dayCell = (value: number | undefined) =>
    value ? (
      <span className="font-bold text-blue-800">{value}</span>
    ) : (
      <span className="text-slate-400">·</span>
    );

  return (
    <div className="bg-white rounded-2xl border border-slate-300 shadow-sm overflow-hidden">
      {/* Tiêu đề */}
      <div className="p-4 bg-slate-50 border-b border-slate-300 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-slate-900 uppercase tracking-wide">
            Bảng kê suất ăn ca {alias}
            {dbAlias !== alias && (
              <span className="text-slate-500 font-semibold"> / {dbAlias}</span>
            )}{' '}
            — {shiftCode}
            {timeWindow && (
              <span className="ml-2 font-mono font-normal text-slate-500">
                {timeWindow}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-600 mt-1">
            Từ ngày {startDate} đến {endDate} • Hiển thị tất cả các nhà ăn • Mỗi
            cột là một ngày, ô là số lần quẹt.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Tìm tên / mã NV…"
              className="pl-7 pr-2 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:border-emerald-500 w-44"
            />
          </div>

          <select
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
            className="px-2 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:border-emerald-500"
          >
            <option value="ALL">Tất cả bộ phận</option>
            {deptOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>

          <button
            onClick={handleExport}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
        </div>
      </div>

      {/* Thanh số liệu nhanh */}
      <div className="px-4 py-2 bg-white border-b border-slate-300 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-700">
        <span className="flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-slate-400" />
          {visibleRows.length.toLocaleString('vi-VN')} /{' '}
          {pivot.rows.length.toLocaleString('vi-VN')} nhân viên
        </span>
        <span>
          Tổng cộng cả ca:{' '}
          <strong className="text-slate-900 font-mono">
            {pivot.grandTotal.toLocaleString('vi-VN')}
          </strong>{' '}
          suất
        </span>
      </div>

      <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="text-[13px] border-collapse whitespace-nowrap">
          <thead className="sticky top-0 z-20">
            <tr className="bg-slate-700 text-white">
              {['STT', 'Họ Tên', 'Mã Nhân Viên', 'Phòng ban'].map((h, i) => (
                <th
                  key={h}
                  style={frozen(i)}
                  className="sticky bg-slate-700 py-2 px-2 text-left font-bold border border-slate-600 z-10"
                >
                  {h}
                </th>
              ))}
              <th
                colSpan={days.length}
                className="py-2 px-2 text-center font-bold border border-slate-600"
              >
                Số lần ăn
              </th>
              <th className="py-2 px-2 text-center font-bold border border-slate-600 bg-slate-800">
                Tổng Cộng
              </th>
            </tr>
            <tr className="bg-slate-100 text-slate-700">
              {FROZEN_WIDTHS.map((_, i) => (
                <th
                  key={i}
                  style={frozen(i)}
                  className="sticky bg-slate-100 border border-slate-300 py-1 z-10"
                />
              ))}
              {days.map((d) => (
                <th
                  key={d}
                  title={d}
                  className="py-1 px-1.5 text-center font-bold border border-slate-300 min-w-[36px]"
                >
                  {dayLabel(d)}
                </th>
              ))}
              <th className="py-1 px-2 text-center font-mono font-bold border border-slate-300 bg-amber-100">
                {pivot.grandTotal.toLocaleString('vi-VN')}
              </th>
            </tr>
          </thead>

          <tbody>
            {visibleRows.map((r, i) => (
              <tr key={r.userId} className="bg-white even:bg-slate-50 hover:bg-amber-50">
                <td
                  style={frozen(0)}
                  className="sticky bg-inherit py-1 px-2 text-center text-slate-500 border border-slate-300"
                >
                  {i + 1}
                </td>
                <td
                  style={frozen(1)}
                  className="sticky bg-inherit py-1 px-2 font-semibold text-slate-800 border border-slate-300 truncate"
                  title={`${r.userName} — ${r.department}`}
                >
                  {r.userName}
                </td>
                <td
                  style={frozen(2)}
                  className="sticky bg-inherit py-1 px-2 font-mono text-slate-600 border border-slate-300"
                >
                  {r.userId}
                </td>
                <td
                  style={frozen(3)}
                  className="sticky bg-inherit py-1 px-2 text-slate-700 border border-slate-300"
                >
                  {r.largeDept}
                </td>
                {days.map((d) => (
                  <td
                    key={d}
                    className="py-1 px-1.5 text-center border border-slate-300"
                  >
                    {dayCell(r.byDay[d])}
                  </td>
                ))}
                <td className="py-1 px-2 text-center font-mono font-bold text-slate-900 border border-slate-300 bg-amber-50">
                  {r.total}
                </td>
              </tr>
            ))}

            {visibleRows.length === 0 && (
              <tr>
                <td
                  colSpan={5 + days.length}
                  className="py-10 text-center text-slate-500"
                >
                  Không có lượt quẹt nào của ca {alias} khớp bộ lọc.
                </td>
              </tr>
            )}
          </tbody>

          <tfoot className="sticky bottom-0 z-20">
            {/* Suất nhập tay của ca: không có nhân sự nên không nằm trong
                danh sách trên, nhưng vẫn nằm trong tổng của ca. */}
            {pivot.manualTotal > 0 && (
              <tr className="bg-amber-50 font-semibold text-amber-900">
                <td
                  colSpan={4}
                  style={{ left: 0, minWidth: FROZEN_WIDTHS.reduce((a, b) => a + b, 0) }}
                  className="sticky bg-amber-50 py-1.5 px-2 text-right border border-slate-300 z-10"
                >
                  {MANUAL_PIVOT_LABEL}
                </td>
                {days.map((d) => (
                  <td
                    key={d}
                    className={`py-1.5 px-1.5 text-center font-mono border border-slate-300 ${
                      pivot.manualByDay[d] ? '' : 'text-amber-300'
                    }`}
                  >
                    {pivot.manualByDay[d] ?? 0}
                  </td>
                ))}
                <td className="py-1.5 px-2 text-center font-mono border border-slate-300 bg-amber-100">
                  {pivot.manualTotal.toLocaleString('vi-VN')}
                </td>
              </tr>
            )}

            {/* Tổng theo ngày của toàn bộ ca */}
            <tr className="bg-slate-200 font-bold text-slate-900">
              <td
                colSpan={4}
                style={{ left: 0, minWidth: FROZEN_WIDTHS.reduce((a, b) => a + b, 0) }}
                className="sticky bg-slate-200 py-1.5 px-2 text-right border border-slate-300 z-10"
              >
                TỔNG THEO NGÀY
              </td>
              {days.map((d) => (
                <td
                  key={d}
                  className="py-1.5 px-1.5 text-center font-mono border border-slate-300"
                >
                  {pivot.dayTotals[d] ?? 0}
                </td>
              ))}
              <td className="py-1.5 px-2 text-center font-mono border border-slate-300 bg-amber-200">
                {pivot.grandTotal.toLocaleString('vi-VN')}
              </td>
            </tr>

            {/* Tách tiếp theo bộ phận lớn — tên bộ phận nằm ngay trong dải cột
                ghim, không cần thêm ô nhãn nào nữa. */}
            {pivot.deptRows.map((d) => (
              <tr key={d.largeDept} className="bg-white">
                <td
                  colSpan={4}
                  style={{ left: 0 }}
                  className="sticky bg-slate-100 py-1 px-2 text-right font-bold text-slate-800 border border-slate-300 z-10"
                >
                  {d.largeDept}
                </td>
                {days.map((day) => (
                  <td
                    key={day}
                    className={`py-1 px-1.5 text-center font-mono border border-slate-300 ${
                      d.byDay[day] ? 'text-slate-900' : 'text-slate-400'
                    }`}
                  >
                    {d.byDay[day] ?? 0}
                  </td>
                ))}
                <td className="py-1 px-2 text-center font-mono font-bold text-slate-900 border border-slate-300 bg-slate-100">
                  {d.total.toLocaleString('vi-VN')}
                </td>
              </tr>
            ))}

            <tr className="bg-slate-800 text-white font-bold">
              <td
                colSpan={4}
                style={{ left: 0 }}
                className="sticky bg-slate-800 py-1.5 px-2 text-right border border-slate-700 z-10"
              >
                TỔNG CỘNG
              </td>
              {days.map((d) => (
                <td
                  key={d}
                  className="py-1.5 px-1.5 text-center font-mono border border-slate-700"
                >
                  {pivot.dayTotals[d] ?? 0}
                </td>
              ))}
              <td className="py-1.5 px-2 text-center font-mono border border-slate-700 bg-amber-500 text-slate-950">
                {pivot.grandTotal.toLocaleString('vi-VN')}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="px-4 py-3 bg-slate-50 border-t border-slate-300 text-xs text-slate-600 leading-relaxed">
        Cột ngày đánh theo NGÀY KẾT THÚC CA: ca đêm{' '}
        {timeWindow || '22:50 - 01:50'} là một ca liền mạch và được tính trọn
        cho ngày hôm sau, nên lượt quẹt từ 22:50 nằm ở cột của ngày kế tiếp
        cùng với phần sau nửa đêm. Dòng tổng theo ngày và các dòng tách theo bộ
        phận luôn là số của toàn bộ ca, không đổi theo ô tìm kiếm.
      </div>
    </div>
  );
};
