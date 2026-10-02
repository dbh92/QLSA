import React, { useState, useMemo, useEffect } from "react";
import {
  MealLog,
  DepartmentMapping,
  ReaderInfo,
  ShiftCode,
  ShiftInfo,
} from "../types";
import {
  buildPivotEmployeeLogs,
  exportToCSV,
  getCostReportDate,
} from "../services/mealEngine";
import {
  Search,
  Download,
  Filter,
  Table,
  List,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

interface MealHistoryViewProps {
  logs: MealLog[];
  mappings: DepartmentMapping[];
  readers: ReaderInfo[];
  /** SA_Shift — mốc 22:50 của ngày làm việc lấy từ ca vắt qua nửa đêm. */
  shifts: ShiftInfo[];
  /** Biên lọc chính xác tới giây, "YYYY-MM-DD HH:mm:ss". */
  startDateTime: string;
  endDateTime: string;
  startDate: string;
  endDate: string;
}

/**
 * Số dòng mỗi trang. Một tháng dữ liệu thật là ~45.000 lượt quẹt; vẽ hết một
 * lượt thì trình duyệt dựng chừng ấy hàng <tr> và màn hình đứng vài giây mỗi
 * lần gõ ô tìm kiếm. Phân trang ở phía client — dữ liệu đã nằm sẵn trong bộ
 * nhớ, chỉ giới hạn phần được VẼ RA.
 */
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500];
const DEFAULT_PAGE_SIZE = 100;

export const MealHistoryView: React.FC<MealHistoryViewProps> = ({
  logs,
  mappings,
  readers,
  shifts,
  startDateTime,
  endDateTime,
  startDate,
  endDate,
}) => {
  const [viewMode, setViewMode] = useState<"pivot" | "raw">("pivot");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDept, setSelectedDept] = useState<string>("all");
  const [selectedShift, setSelectedShift] = useState<string>("all");
  const [selectedReader, setSelectedReader] = useState<string>("all");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);

  /**
   * Tra bộ phận lớn qua Map thay vì quét tuyến tính bảng ánh xạ cho từng lượt
   * quẹt. Ngữ nghĩa giống getLogLargeDepartment: ưu tiên giá trị procedure đã
   * giải sẵn (rule có điều kiện > ánh xạ mặc định), chỉ tra bảng ánh xạ khi
   * thiếu — bỏ khoảng trắng, không phân biệt hoa/thường, không khớp thì rơi về
   * 'Khác'.
   */
  const largeDeptOf = useMemo(() => {
    const table = new Map<string, string>();
    mappings.forEach((m) =>
      table.set(m.smallDepartment.trim().toLowerCase(), m.largeDepartment),
    );
    return (log: MealLog) =>
      log.largeDepartment?.trim() ||
      table.get(log.department.trim().toLowerCase()) ||
      "Khác";
  }, [mappings]);

  // Filter raw logs
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // Lọc theo thời điểm, chính xác tới giây
      if (log.logDateTime < startDateTime || log.logDateTime > endDateTime)
        return false;

      // Dept filter — lọc theo BỘ PHẬN LỚN
      if (selectedDept !== "all" && largeDeptOf(log) !== selectedDept)
        return false;

      // Shift filter
      if (selectedShift !== "all" && log.shiftCode !== selectedShift)
        return false;

      // Reader filter
      if (selectedReader !== "all" && String(log.readerId) !== selectedReader)
        return false;

      // Search query — khớp cả giờ quẹt nên gõ "00:48" hay "00:48:37" đều ra.
      if (searchQuery.trim() !== "") {
        const q = searchQuery.toLowerCase().trim();
        const matchName = log.userName.toLowerCase().includes(q);
        const matchId = log.userId.toLowerCase().includes(q);
        const matchDept = log.department.toLowerCase().includes(q);
        const matchLargeDept = largeDeptOf(log)
          .toLowerCase()
          .includes(q);
        const matchTime = log.logDateTime.includes(q);
        if (
          !matchName &&
          !matchId &&
          !matchDept &&
          !matchLargeDept &&
          !matchTime
        )
          return false;
      }

      return true;
    });
  }, [
    logs,
    startDateTime,
    endDateTime,
    selectedDept,
    selectedShift,
    selectedReader,
    searchQuery,
    largeDeptOf,
  ]);

  // Pivot logs
  const pivotLogs = useMemo(() => {
    return buildPivotEmployeeLogs(filteredLogs, mappings, shifts);
  }, [filteredLogs, mappings, shifts]);

  /* -------------------------------------------------------------------
     Phân trang
     -------------------------------------------------------------------
     Hai chế độ xem có hai tập dòng khác nhau nhưng dùng CHUNG một trang
     hiện tại: đổi chế độ mà giữ nguyên số trang thì người dùng đang ở
     trang 300 của bảng thô sẽ nhảy vào khoảng trắng của bảng tổng hợp,
     nên mọi thay đổi lọc/chế độ đều đưa về trang 1. */
  const totalRows = viewMode === "pivot" ? pivotLogs.length : filteredLogs.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));

  /* Kẹp lại phòng khi bộ lọc vừa thu hẹp làm số trang ít đi — nếu không,
     trang hiện tại vượt quá cuối và bảng hiện ra trống trơn. */
  const currentPage = Math.min(page, pageCount);
  const firstIndex = (currentPage - 1) * pageSize;
  const lastIndex = Math.min(firstIndex + pageSize, totalRows);

  useEffect(() => {
    setPage(1);
  }, [
    viewMode,
    pageSize,
    searchQuery,
    selectedDept,
    selectedShift,
    selectedReader,
    startDateTime,
    endDateTime,
  ]);

  const pagedPivotLogs = useMemo(
    () => pivotLogs.slice(firstIndex, lastIndex),
    [pivotLogs, firstIndex, lastIndex],
  );

  const pagedLogs = useMemo(
    () => filteredLogs.slice(firstIndex, lastIndex),
    [filteredLogs, firstIndex, lastIndex],
  );

  // Danh sách BỘ PHẬN LỚN có thật trong dữ liệu, dùng cho ô lọc.
  const departmentList = useMemo(() => {
    const set = new Set<string>();
    logs.forEach((l) => set.add(largeDeptOf(l)));
    return Array.from(set).sort();
  }, [logs, largeDeptOf]);

  // Export handlers
  const handleExportCSV = () => {
    if (viewMode === "pivot") {
      const headers = [
        "Ngày",
        "Bộ Phận",
        "Bộ Phận Lớn",
        "Mã Nhân Viên",
        "Tên Nhân Viên",
        "Giờ Quẹt CA1",
        "Giờ Quẹt CA2",
        "Giờ Quẹt CA3",
        "Giờ Quẹt CA4",
        "Giờ Quẹt CA5",
        "Giờ Quẹt CA6",
        "Tổng Lần Quẹt",
      ];
      const rows = pivotLogs.map((p) => [
        p.actualDate,
        p.department,
        p.largeDepartment,
        p.userId,
        p.userName,
        p.gioQuet_CA1 || "",
        p.gioQuet_CA2 || "",
        p.gioQuet_CA3 || "",
        p.gioQuet_CA4 || "",
        p.gioQuet_CA5 || "",
        p.gioQuet_CA6 || "",
        p.totalPunches,
      ]);
      exportToCSV(
        `Lich_Su_Cham_An_Pivot_${startDate}_${endDate}`,
        headers,
        rows,
      );
    } else {
      const headers = [
        "Mã Lượt",
        "Thời Gian Thực",
        "Ngày Tính Ca",
        "Ca Ăn",
        "Mã NV",
        "Tên Nhân Viên",
        "Bộ Phận",
        "Bộ Phận Lớn",
        "Máy Chấm",
      ];
      const rows = filteredLogs.map((l) => [
        l.id,
        l.logDateTime,
        getCostReportDate(l, shifts),
        l.shiftCode,
        l.userId,
        l.userName,
        l.department,
        largeDeptOf(l),
        l.readerName,
      ]);
      exportToCSV(
        `Lich_Su_Cham_An_ChiTiet_${startDate}_${endDate}`,
        headers,
        rows,
      );
    }
  };

  return (
    <div className="space-y-5 pb-8">
      {/* View Title & View Mode Toggle */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">
            Xem Chi Tiết Lịch Sử Ăn Theo Ca
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Tra cứu lịch sử quẹt thẻ ăn, tự động xoay giờ quẹt thẻ theo các cột
            ca ăn (CA1 - CA6).
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Pivot vs Raw toggle */}
          <div className="bg-slate-100 p-1 rounded-xl border border-slate-200 flex space-x-1">
            <button
              onClick={() => setViewMode("pivot")}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                viewMode === "pivot"
                  ? "bg-amber-500 text-slate-950 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Table className="w-3.5 h-3.5" />
              <span>Xoay Cột Theo Ca (Pivot)</span>
            </button>
            <button
              onClick={() => setViewMode("raw")}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                viewMode === "raw"
                  ? "bg-amber-500 text-slate-950 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <List className="w-3.5 h-3.5" />
              <span>Danh Sách Chi Tiết</span>
            </button>
          </div>

          <button
            onClick={handleExportCSV}
            className="flex items-center space-x-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold transition shadow-sm"
          >
            <Download className="w-4 h-4" />
            <span>Xuất Excel/CSV</span>
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {/* Search Bar */}
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <input
            type="text"
            placeholder="Tìm theo Tên, Mã NV, Bộ phận, Giờ quẹt (00:48:37)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500 text-slate-800"
          />
        </div>

        {/* Department Filter */}
        <div>
          <select
            value={selectedDept}
            onChange={(e) => setSelectedDept(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500 text-slate-800"
          >
            <option value="all">
              Tất cả bộ phận lớn ({departmentList.length})
            </option>
            {departmentList.map((dept) => (
              <option key={dept} value={dept}>
                {dept}
              </option>
            ))}
          </select>
        </div>

        {/* Shift Filter */}
        <div>
          <select
            value={selectedShift}
            onChange={(e) => setSelectedShift(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500 text-slate-800"
          >
            <option value="all">Tất cả ca ăn (CA1 - CA6)</option>
            <option value="CA1">CA1 (22:50 - 01:50)</option>
            <option value="CA2">CA2 (04:30 - 06:44)</option>
            <option value="CA3">CA3 (06:45 - 08:10)</option>
            <option value="CA4">CA4 (10:40 - 13:30)</option>
            <option value="CA5">CA5 (16:30 - 18:44)</option>
            <option value="CA6">CA6 (18:45 - 20:10)</option>
            <option value="Khác">Khác (Ngoài ca)</option>
          </select>
        </div>

        {/* Machine Reader Filter */}
        <div>
          <select
            value={selectedReader}
            onChange={(e) => setSelectedReader(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500 text-slate-800"
          >
            <option value="all">Tất cả 3 máy chấm</option>
            {readers.map((r) => (
              <option key={r.id} value={String(r.id)}>
                {r.code} - {r.location}
              </option>
            ))}
          </select>
        </div>

        {/* Reset Filter Button */}
        <div>
          <button
            onClick={() => {
              setSearchQuery("");
              setSelectedDept("all");
              setSelectedShift("all");
              setSelectedReader("all");
            }}
            className="w-full py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold transition flex items-center justify-center space-x-1.5 border border-slate-200"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
            <span>Xóa Bộ Lọc</span>
          </button>
        </div>
      </div>

      {/* Main Data Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-3 text-xs font-semibold text-slate-600">
          <span>
            {totalRows === 0
              ? viewMode === "pivot"
                ? "Không có dòng tổng hợp nào"
                : "Không có lượt quẹt nào"
              : `Hiển thị ${(firstIndex + 1).toLocaleString("vi-VN")}–${lastIndex.toLocaleString(
                  "vi-VN",
                )} trên ${totalRows.toLocaleString("vi-VN")} ${
                  viewMode === "pivot"
                    ? "dòng tổng hợp ngày/người"
                    : "lượt quẹt thẻ chi tiết"
                }`}
          </span>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 font-normal text-slate-500">
              Số dòng/trang
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="px-2 py-1 bg-white border border-slate-200 rounded-lg font-bold text-slate-700 focus:outline-none focus:border-amber-500"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-slate-400 font-mono">
              Khoảng ngày: {startDate} &rarr; {endDate}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto max-h-[600px]">
          {viewMode === "pivot" ? (
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-900 text-white font-bold sticky top-0 z-10 uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-3 px-3 border-b border-slate-800">Ngày</th>
                  <th className="py-3 px-3 border-b border-slate-800">
                    Bộ Phận
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800">
                    Bộ Phận Lớn
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800">Mã NV</th>
                  <th className="py-3 px-3 border-b border-slate-800">
                    Tên Nhân Viên
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800 text-center bg-slate-800">
                    CA1 (Night)
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800 text-center bg-slate-800">
                    CA2 (04:30)
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800 text-center bg-slate-800">
                    CA3 (06:45)
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800 text-center bg-slate-800">
                    CA4 (10:40)
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800 text-center bg-slate-800">
                    CA5 (16:30)
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800 text-center bg-slate-800">
                    CA6 (18:45)
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800 text-center bg-amber-600 text-slate-950">
                    Tổng Lần
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {pagedPivotLogs.length === 0 ? (
                  <tr>
                    <td
                      colSpan={12}
                      className="py-12 text-center text-slate-400"
                    >
                      Không tìm thấy dữ liệu chấm ăn phù hợp với bộ lọc.
                    </td>
                  </tr>
                ) : (
                  pagedPivotLogs.map((p, idx) => (
                    <tr
                      key={`${p.actualDate}_${p.userId}_${idx}`}
                      className={`hover:bg-amber-50/50 transition ${
                        p.totalPunches > 3 ? "bg-red-50/60 font-medium" : ""
                      }`}
                    >
                      <td className="py-2.5 px-3 font-semibold text-slate-800 whitespace-nowrap">
                        {p.actualDate}
                      </td>
                      <td className="py-2.5 px-3 font-medium text-slate-700 whitespace-nowrap">
                        {p.department}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded font-semibold bg-slate-100 text-slate-700 border border-slate-200 text-[11px]">
                          {p.largeDepartment}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-900 font-bold whitespace-nowrap">
                        {p.userId}
                      </td>
                      <td className="py-2.5 px-3 font-medium text-slate-900 whitespace-nowrap">
                        {p.userName}
                      </td>

                      {/* Shift Columns */}
                      <td className="py-2.5 px-2 text-center font-mono text-[11px]">
                        {p.gioQuet_CA1 ? (
                          <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                            {p.gioQuet_CA1.slice(11)}
                          </span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-center font-mono text-[11px]">
                        {p.gioQuet_CA2 ? (
                          <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                            {p.gioQuet_CA2.slice(11)}
                          </span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-center font-mono text-[11px]">
                        {p.gioQuet_CA3 ? (
                          <span className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200">
                            {p.gioQuet_CA3.slice(11)}
                          </span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-center font-mono text-[11px]">
                        {p.gioQuet_CA4 ? (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                            {p.gioQuet_CA4.slice(11)}
                          </span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-center font-mono text-[11px]">
                        {p.gioQuet_CA5 ? (
                          <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                            {p.gioQuet_CA5.slice(11)}
                          </span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-center font-mono text-[11px]">
                        {p.gioQuet_CA6 ? (
                          <span className="px-1.5 py-0.5 rounded bg-orange-50 text-orange-800 border border-orange-200">
                            {p.gioQuet_CA6.slice(11)}
                          </span>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>

                      {/* Total Punches */}
                      <td className="py-2.5 px-3 text-center">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                            p.totalPunches > 3
                              ? "bg-red-500 text-white"
                              : "bg-slate-100 text-slate-800"
                          }`}
                        >
                          {p.totalPunches}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-900 text-white font-bold sticky top-0 z-10 uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-3 px-3 border-b border-slate-800">
                    Thời Gian Thô
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800">
                    Ngày Tính Ca
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800">Ca Ăn</th>
                  <th className="py-3 px-3 border-b border-slate-800">Mã NV</th>
                  <th className="py-3 px-3 border-b border-slate-800">
                    Tên Nhân Viên
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800">
                    Bộ Phận
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800">
                    Bộ Phận Lớn
                  </th>
                  <th className="py-3 px-3 border-b border-slate-800">
                    Máy Chấm Thẻ
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {pagedLogs.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="py-12 text-center text-slate-400"
                    >
                      Không tìm thấy dữ liệu.
                    </td>
                  </tr>
                ) : (
                  pagedLogs.map((log) => (
                    <tr
                      key={log.id}
                      className="hover:bg-amber-50/50 transition"
                    >
                      <td className="py-2.5 px-3 font-mono font-medium text-slate-900">
                        {log.logDateTime}
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-slate-800">
                        {getCostReportDate(log, shifts)}
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="px-2 py-0.5 rounded font-bold bg-amber-100 text-amber-800 text-[11px]">
                          {log.shiftCode}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono font-bold text-slate-900">
                        {log.userId}
                      </td>
                      <td className="py-2.5 px-3 font-medium text-slate-900">
                        {log.userName}
                      </td>
                      <td className="py-2.5 px-3">{log.department}</td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded font-semibold bg-slate-100 text-slate-700 border border-slate-200 text-[11px]">
                          {largeDeptOf(log)}
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${
                            log.isKorean
                              ? "bg-red-50 text-red-700 border border-red-200"
                              : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {log.readerName}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Thanh chuyển trang */}
        {totalRows > 0 && (
          <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
            <span className="text-slate-500">
              Trang{" "}
              <strong className="text-slate-800">
                {currentPage.toLocaleString("vi-VN")}
              </strong>{" "}
              trên {pageCount.toLocaleString("vi-VN")}
              {/* Nút "Xuất Excel/CSV" luôn xuất TOÀN BỘ dòng đã lọc, không
                  phải mỗi trang đang xem — nói rõ để không ai phải bấm thử. */}
              <span className="text-slate-400">
                {" "}
                • Xuất Excel/CSV lấy toàn bộ{" "}
                {totalRows.toLocaleString("vi-VN")} dòng đã lọc
              </span>
            </span>

            <div className="flex items-center gap-1.5">
              {(
                [
                  ["Trang đầu", ChevronsLeft, 1, currentPage === 1],
                  ["Trang trước", ChevronLeft, currentPage - 1, currentPage === 1],
                ] as const
              ).map(([title, Icon, target, disabled]) => (
                <button
                  key={title}
                  type="button"
                  title={title}
                  disabled={disabled}
                  onClick={() => setPage(target)}
                  className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  <Icon className="w-4 h-4" />
                </button>
              ))}

              <input
                type="number"
                min={1}
                max={pageCount}
                value={currentPage}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) {
                    setPage(Math.min(Math.max(1, Math.trunc(n)), pageCount));
                  }
                }}
                className="w-16 px-2 py-1 text-center bg-white border border-slate-200 rounded-lg font-bold text-slate-800 focus:outline-none focus:border-amber-500"
              />

              {(
                [
                  [
                    "Trang sau",
                    ChevronRight,
                    currentPage + 1,
                    currentPage === pageCount,
                  ],
                  [
                    "Trang cuối",
                    ChevronsRight,
                    pageCount,
                    currentPage === pageCount,
                  ],
                ] as const
              ).map(([title, Icon, target, disabled]) => (
                <button
                  key={title}
                  type="button"
                  title={title}
                  disabled={disabled}
                  onClick={() => setPage(target)}
                  className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  <Icon className="w-4 h-4" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
