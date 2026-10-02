import React, { useState, useMemo } from 'react';
import {
  MealLog,
  DepartmentMapping,
  ShiftCode,
  ManualMealEntry,
  MealPriceItem,
  ShiftMealCategory,
  GuestDeptOverride,
  GuestDeptPeriod,
} from '../types';
import {
  buildMealPricing,
  buildShiftCategoryLookup,
  classifyManualEntries,
  getCostReportDate,
  getLogLargeDepartment,
  manualMealCount,
} from '../services/mealEngine';
import { DepartmentMappingView } from './DepartmentMappingView';
import { ManualMealsTable } from './ManualMealsTable';
import { Building2, Users, Download, Eye, X, ChevronRight, GitFork } from 'lucide-react';

interface DepartmentReportViewProps {
  logs: MealLog[];
  mappings: DepartmentMapping[];
  /** Danh mục bộ phận lớn lấy từ SA_LargeDepartment. */
  largeDeptOptions: string[];
  /** Suất nhập tay — suất ăn thật, phải nằm trong ma trận này như lượt quẹt. */
  manualEntries: ManualMealEntry[];
  priceItems: MealPriceItem[];
  /** Bảng gán loại suất theo ca (tab Cấu Hình Giá Suất Ăn). */
  shiftMealCategories: ShiftMealCategory[];
  /* Ánh xạ bộ phận không còn tab riêng: nó là popup của màn hình này, nên
     hai callback ghi của nó đi kèm luôn. */
  onSaveMapping: (mapping: DepartmentMapping) => Promise<void>;
  onDeleteMapping: (smallDepartment: string) => Promise<void>;
  /* Gán bộ phận riêng cho từng khách công tác — cũng nằm trong popup ánh xạ,
     vì đó là ngoại lệ của chính bảng ánh xạ ấy. */
  guestOverrides: GuestDeptOverride[];
  guestPeriods: GuestDeptPeriod[];
  onSaveGuestOverride: (
    userId: string,
    largeDepartment: string,
    effectiveFrom: string | null,
    effectiveTo: string | null,
  ) => Promise<void>;
  onDeleteGuestOverride: (overrideId: number) => Promise<void>;
  /** Biên lọc chính xác tới giây, "YYYY-MM-DD HH:mm:ss". */
  startDateTime: string;
  endDateTime: string;
  startDate: string;
  endDate: string;
}

interface DepartmentRow {
  departmentName: string;
  ca1: number;
  ca2: number;
  ca3: number;
  ca4: number;
  ca5: number;
  ca6: number;
  khac: number;
  total: number;
}

export const DepartmentReportView: React.FC<DepartmentReportViewProps> = ({
  logs,
  mappings,
  largeDeptOptions,
  manualEntries,
  priceItems,
  shiftMealCategories,
  onSaveMapping,
  onDeleteMapping,
  guestOverrides,
  guestPeriods,
  onSaveGuestOverride,
  onDeleteGuestOverride,
  startDateTime,
  endDateTime,
  startDate,
  endDate,
}) => {
  const [groupByLarge, setGroupByLarge] = useState<boolean>(true);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [selectedCell, setSelectedCell] = useState<{
    deptName: string;
    shiftCode: ShiftCode | 'ALL';
  } | null>(null);

  // Filter logs in range
  const filteredLogs = useMemo(() => {
    return logs.filter(
      (l) => l.logDateTime >= startDateTime && l.logDateTime <= endDateTime
    );
  }, [logs, startDateTime, endDateTime]);

  /* Suất nhập tay (tab Nhập Thủ Công Ca) là suất ăn thật, chỉ thiếu lượt
     quẹt — ma trận ca × bộ phận phải đếm chúng như một lượt quẹt bình
     thường. Dùng chung `classifyManualEntries` với Dashboard và tab Báo Cáo
     Chi Phí để ba màn hình không xếp một dòng nhập tay vào ba bộ phận khác
     nhau. */
  const manualMeals = useMemo(
    () =>
      classifyManualEntries(
        manualEntries,
        mappings,
        buildShiftCategoryLookup(shiftMealCategories),
        buildMealPricing(priceItems),
        startDateTime,
        endDateTime
      ),
    [manualEntries, mappings, shiftMealCategories, priceItems, startDateTime, endDateTime]
  );

  const manualTotal = manualMealCount(manualMeals);

  // Aggregate matrix by Department
  const departmentRows = useMemo(() => {
    const map = new Map<string, DepartmentRow>();

    /** Cộng một số suất vào đúng ô (bộ phận × ca). */
    const add = (deptKey: string, shiftCode: ShiftCode, quantity: number) => {
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
        });
      }

      const row = map.get(deptKey)!;
      row.total += quantity;

      if (shiftCode === 'CA1') row.ca1 += quantity;
      else if (shiftCode === 'CA2') row.ca2 += quantity;
      else if (shiftCode === 'CA3') row.ca3 += quantity;
      else if (shiftCode === 'CA4') row.ca4 += quantity;
      else if (shiftCode === 'CA5') row.ca5 += quantity;
      else if (shiftCode === 'CA6') row.ca6 += quantity;
      else row.khac += quantity;
    };

    filteredLogs.forEach((log) =>
      add(
        groupByLarge ? getLogLargeDepartment(log, mappings) : log.department,
        log.shiftCode,
        1
      )
    );

    /* Gom theo bộ phận NHỎ thì lấy đúng tên người nhập đã gõ; gom theo bộ
       phận LỚN thì lấy bộ phận lớn đã giải sẵn lúc phân loại. */
    manualMeals.forEach((m) =>
      add(
        groupByLarge ? m.largeDept : m.entry.department || 'Khác',
        m.shiftCode,
        m.quantity
      )
    );

    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [filteredLogs, manualMeals, groupByLarge, mappings]);

  // Grand totals across all departments
  const grandTotal = useMemo(() => {
    return departmentRows.reduce(
      (acc, r) => {
        acc.ca1 += r.ca1;
        acc.ca2 += r.ca2;
        acc.ca3 += r.ca3;
        acc.ca4 += r.ca4;
        acc.ca5 += r.ca5;
        acc.ca6 += r.ca6;
        acc.khac += r.khac;
        acc.total += r.total;
        return acc;
      },
      { ca1: 0, ca2: 0, ca3: 0, ca4: 0, ca5: 0, ca6: 0, khac: 0, total: 0 }
    );
  }, [departmentRows]);

  // Logs for drilldown modal
  const modalLogs = useMemo(() => {
    if (!selectedCell) return [];

    return filteredLogs.filter((log) => {
      const deptKey = groupByLarge
        ? getLogLargeDepartment(log, mappings)
        : log.department;

      if (deptKey !== selectedCell.deptName) return false;
      if (selectedCell.shiftCode !== 'ALL' && log.shiftCode !== selectedCell.shiftCode) {
        return false;
      }
      return true;
    });
  }, [filteredLogs, selectedCell, groupByLarge, mappings]);

  /* Suất nhập tay của đúng ô đang mở — cùng khoá bộ phận với ma trận ở trên.
     Không có dòng này thì một ô chỉ gồm suất nhập tay (hay gặp ở "Khác": ô Bộ
     Phận gõ tự do không khớp ánh xạ nào) mở ra một popup rỗng. */
  const modalManual = useMemo(() => {
    if (!selectedCell) return [];

    return manualMeals.filter((m) => {
      const deptKey = groupByLarge ? m.largeDept : m.entry.department || 'Khác';
      if (deptKey !== selectedCell.deptName) return false;
      return selectedCell.shiftCode === 'ALL' || m.shiftCode === selectedCell.shiftCode;
    });
  }, [manualMeals, selectedCell, groupByLarge]);

  return (
    <div className="space-y-5 pb-8">
      {/* Header */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">
            Danh Sách Ăn Các Bộ Phận Theo Ca
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Thống kê số lượng suất ăn theo ca. Nhấp vào bất kỳ ô số lượng nào để xem danh sách chi
            tiết nhân viên.
            {manualTotal > 0 && (
              <>
                {' '}Đã gồm{' '}
                <strong className="text-amber-700">
                  {manualTotal.toLocaleString('vi-VN')} suất nhập thủ công
                </strong>{' '}
                — chúng không có lượt quẹt nên không hiện trong danh sách chi
                tiết nhân viên.
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setMappingOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition shadow-sm shrink-0"
          >
            <GitFork className="w-4 h-4" />
            <span>Ánh Xạ Bộ Phận</span>
          </button>

          {/* Toggle Small Dept vs Large Dept */}
          <div className="bg-slate-100 p-1 rounded-xl border border-slate-200 flex space-x-1">
            <button
              onClick={() => setGroupByLarge(true)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                groupByLarge
                  ? 'bg-amber-500 text-slate-950 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Bộ Phận Lớn (Ánh Xạ)
            </button>
            <button
              onClick={() => setGroupByLarge(false)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                !groupByLarge
                  ? 'bg-amber-500 text-slate-950 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Bộ Phận Chi Tiết Thô
            </button>
          </div>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs font-semibold text-slate-600">
          <span className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-amber-600" />
            <span>
              Thống kê {departmentRows.length} bộ phận ({groupByLarge ? 'Đã Gom Nhóm' : 'Chi Tiết'})
            </span>
          </span>
          <span className="text-amber-700 font-bold bg-amber-50 px-2.5 py-1 rounded-md border border-amber-200">
            Tổng cộng: {grandTotal.total.toLocaleString('vi-VN')} suất
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-900 text-white font-bold uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-3.5 px-4 border-b border-slate-800">
                  {groupByLarge ? 'Bộ Phận Lớn' : 'Bộ Phận Nhỏ'}
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA1 (Đêm)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA2 (04:30)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA3 (06:45)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA4 (10:40)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA5 (16:30)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800">
                  CA6 (18:45)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center bg-slate-800 text-slate-400">
                  Ngoài Ca
                </th>
                <th className="py-3.5 px-4 border-b border-slate-800 text-center bg-amber-600 text-slate-950 font-extrabold">
                  Tổng Ca
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-800">
              {departmentRows.map((row) => (
                <tr key={row.departmentName} className="hover:bg-amber-50/40 transition">
                  <td className="py-3 px-4 font-bold text-slate-900 whitespace-nowrap flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                    <span>{row.departmentName}</span>
                  </td>

                  {/* CA1 */}
                  <td
                    onClick={() =>
                      row.ca1 > 0 &&
                      setSelectedCell({ deptName: row.departmentName, shiftCode: 'CA1' })
                    }
                    className={`py-3 px-3 text-center font-mono font-semibold ${
                      row.ca1 > 0
                        ? 'cursor-pointer hover:bg-amber-100/80 text-indigo-700 underline decoration-indigo-300'
                        : 'text-slate-300'
                    }`}
                  >
                    {row.ca1 > 0 ? row.ca1 : '-'}
                  </td>

                  {/* CA2 */}
                  <td
                    onClick={() =>
                      row.ca2 > 0 &&
                      setSelectedCell({ deptName: row.departmentName, shiftCode: 'CA2' })
                    }
                    className={`py-3 px-3 text-center font-mono font-semibold ${
                      row.ca2 > 0
                        ? 'cursor-pointer hover:bg-amber-100/80 text-blue-700 underline decoration-blue-300'
                        : 'text-slate-300'
                    }`}
                  >
                    {row.ca2 > 0 ? row.ca2 : '-'}
                  </td>

                  {/* CA3 */}
                  <td
                    onClick={() =>
                      row.ca3 > 0 &&
                      setSelectedCell({ deptName: row.departmentName, shiftCode: 'CA3' })
                    }
                    className={`py-3 px-3 text-center font-mono font-semibold ${
                      row.ca3 > 0
                        ? 'cursor-pointer hover:bg-amber-100/80 text-sky-700 underline decoration-sky-300'
                        : 'text-slate-300'
                    }`}
                  >
                    {row.ca3 > 0 ? row.ca3 : '-'}
                  </td>

                  {/* CA4 */}
                  <td
                    onClick={() =>
                      row.ca4 > 0 &&
                      setSelectedCell({ deptName: row.departmentName, shiftCode: 'CA4' })
                    }
                    className={`py-3 px-3 text-center font-mono font-semibold ${
                      row.ca4 > 0
                        ? 'cursor-pointer hover:bg-amber-100/80 text-emerald-700 underline decoration-emerald-300 font-bold'
                        : 'text-slate-300'
                    }`}
                  >
                    {row.ca4 > 0 ? row.ca4 : '-'}
                  </td>

                  {/* CA5 */}
                  <td
                    onClick={() =>
                      row.ca5 > 0 &&
                      setSelectedCell({ deptName: row.departmentName, shiftCode: 'CA5' })
                    }
                    className={`py-3 px-3 text-center font-mono font-semibold ${
                      row.ca5 > 0
                        ? 'cursor-pointer hover:bg-amber-100/80 text-amber-800 underline decoration-amber-300'
                        : 'text-slate-300'
                    }`}
                  >
                    {row.ca5 > 0 ? row.ca5 : '-'}
                  </td>

                  {/* CA6 */}
                  <td
                    onClick={() =>
                      row.ca6 > 0 &&
                      setSelectedCell({ deptName: row.departmentName, shiftCode: 'CA6' })
                    }
                    className={`py-3 px-3 text-center font-mono font-semibold ${
                      row.ca6 > 0
                        ? 'cursor-pointer hover:bg-amber-100/80 text-orange-800 underline decoration-orange-300'
                        : 'text-slate-300'
                    }`}
                  >
                    {row.ca6 > 0 ? row.ca6 : '-'}
                  </td>

                  {/* Khác */}
                  <td
                    onClick={() =>
                      row.khac > 0 &&
                      setSelectedCell({ deptName: row.departmentName, shiftCode: 'Khác' })
                    }
                    className={`py-3 px-3 text-center font-mono ${
                      row.khac > 0
                        ? 'cursor-pointer hover:bg-slate-200 text-slate-700'
                        : 'text-slate-300'
                    }`}
                  >
                    {row.khac > 0 ? row.khac : '-'}
                  </td>

                  {/* Total */}
                  <td
                    onClick={() =>
                      setSelectedCell({ deptName: row.departmentName, shiftCode: 'ALL' })
                    }
                    className="py-3 px-4 text-center font-extrabold text-slate-900 bg-amber-50 cursor-pointer hover:bg-amber-100"
                  >
                    {row.total.toLocaleString('vi-VN')}
                  </td>

                  <td className="py-3 px-3 text-center">
                    <button
                      onClick={() =>
                        setSelectedCell({ deptName: row.departmentName, shiftCode: 'ALL' })
                      }
                      className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[11px] font-semibold transition inline-flex items-center gap-1"
                    >
                      <Eye className="w-3 h-3" /> Chi tiết
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>

            {/* Table Footer Grand Totals */}
            <tfoot className="bg-slate-900 text-white font-extrabold uppercase text-xs">
              <tr>
                <td className="py-4 px-4">TỔNG CỘNG TOÀN BỘ</td>
                <td className="py-4 px-3 text-center font-mono">{grandTotal.ca1}</td>
                <td className="py-4 px-3 text-center font-mono">{grandTotal.ca2}</td>
                <td className="py-4 px-3 text-center font-mono">{grandTotal.ca3}</td>
                <td className="py-4 px-3 text-center font-mono">{grandTotal.ca4}</td>
                <td className="py-4 px-3 text-center font-mono">{grandTotal.ca5}</td>
                <td className="py-4 px-3 text-center font-mono">{grandTotal.ca6}</td>
                <td className="py-4 px-3 text-center font-mono text-slate-400">
                  {grandTotal.khac}
                </td>
                <td className="py-4 px-4 text-center font-mono text-amber-400 text-sm">
                  {grandTotal.total.toLocaleString('vi-VN')}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Popup Ánh Xạ Bộ Phận — trước đây là một tab riêng trên thanh menu. */}
      {mappingOpen && (
        <div
          onClick={() => setMappingOpen(false)}
          className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex items-start justify-center p-4 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-100 rounded-2xl shadow-2xl max-w-6xl w-full border border-slate-200 overflow-hidden flex flex-col max-h-[90vh] my-auto"
          >
            <div className="bg-slate-900 text-white px-6 py-4 flex justify-between items-center shrink-0">
              <div>
                <span className="text-amber-400 font-semibold text-xs uppercase tracking-wider">
                  Cấu Hình
                </span>
                <h3 className="text-lg font-bold">Ánh Xạ Bộ Phận</h3>
              </div>
              <button
                onClick={() => setMappingOpen(false)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto">
              <DepartmentMappingView
                mappings={mappings}
                largeDeptOptions={largeDeptOptions}
                onSave={onSaveMapping}
                onDelete={onDeleteMapping}
                guestOverrides={guestOverrides}
                guestPeriods={guestPeriods}
                onSaveGuestOverride={onSaveGuestOverride}
                onDeleteGuestOverride={onDeleteGuestOverride}
                startDate={startDate}
                endDate={endDate}
              />
            </div>
          </div>
        </div>
      )}

      {/* Drill-down Modal */}
      {selectedCell && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full border border-slate-200 overflow-hidden flex flex-col max-h-[85vh]">
            <div className="bg-slate-900 text-white px-6 py-4 flex justify-between items-center">
              <div>
                <span className="text-amber-400 font-semibold text-xs uppercase tracking-wider">
                  Chi Tiết Danh Sách Nhân Viên
                </span>
                <h3 className="text-lg font-bold">
                  Bộ phận: {selectedCell.deptName} {' '}
                  {selectedCell.shiftCode !== 'ALL' && (
                    <span className="text-amber-300 font-normal text-sm">
                      ({selectedCell.shiftCode})
                    </span>
                  )}
                </h3>
              </div>
              <button
                onClick={() => setSelectedCell(null)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 bg-slate-50 border-b border-slate-200 text-xs text-slate-600 flex justify-between items-center">
              <span>
                Tìm thấy {modalLogs.length} lượt chấm ăn
                {modalManual.length > 0 && (
                  <>
                    {' '}và{' '}
                    <strong className="text-amber-700">
                      {manualMealCount(modalManual).toLocaleString('vi-VN')} suất nhập thủ công
                    </strong>
                  </>
                )}
              </span>
              <span className="font-mono">
                Từ {startDate} đến {endDate}
              </span>
            </div>

            <div className="p-6 overflow-y-auto space-y-3">
              {modalManual.length > 0 && (
                <ManualMealsTable meals={modalManual} />
              )}
              {modalLogs.length > 0 && (
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-100 text-slate-700 font-bold uppercase border-b">
                  <tr>
                    <th className="py-2.5 px-3">STT</th>
                    <th className="py-2.5 px-3">Thời Gian Thô</th>
                    <th className="py-2.5 px-3">Ngày Làm Việc</th>
                    <th className="py-2.5 px-3">Ca</th>
                    <th className="py-2.5 px-3">Mã NV</th>
                    <th className="py-2.5 px-3">Tên Nhân Viên</th>
                    <th className="py-2.5 px-3">Bộ Phận Chi Tiết</th>
                    <th className="py-2.5 px-3">Máy Chấm</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {modalLogs.map((log, index) => (
                    <tr key={log.id} className="hover:bg-slate-50">
                      <td className="py-2 px-3 text-slate-400">{index + 1}</td>
                      <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                        {log.logDateTime}
                      </td>
                      <td className="py-2 px-3 text-slate-700">{getCostReportDate(log)}</td>
                      <td className="py-2 px-3 font-bold text-amber-700">{log.shiftCode}</td>
                      <td className="py-2 px-3 font-mono font-bold text-slate-900">{log.userId}</td>
                      <td className="py-2 px-3 font-medium text-slate-900">{log.userName}</td>
                      <td className="py-2 px-3 text-slate-600">{log.department}</td>
                      <td className="py-2 px-3 text-slate-600">{log.readerName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              )}
            </div>

            <div className="p-4 bg-slate-100 border-t border-slate-200 text-right">
              <button
                onClick={() => setSelectedCell(null)}
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
