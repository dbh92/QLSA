import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShiftCode, StaffType } from "../../types";
import { formatVND } from "../../services/mealEngine";
import * as api from "../../services/api";
import {
  AdHocDeduction,
  CostAdjustment,
  EMPTY_ADJUSTMENT,
  LossDeductScope,
  SHIFT_ORDER,
  isAdjustmentActive,
  reportShiftLabel,
} from "./reportModel";
import {
  loadXLSX,
  normalizeDate,
  normalizeNumber,
  readSheetRows,
  serialDateReader,
} from "../../services/excelImport";
import {
  X,
  Plus,
  Trash2,
  AlertTriangle,
  RotateCcw,
  History,
  Undo2,
  Loader2,
  ShieldAlert,
  Upload,
  FileDown,
  CheckCircle2,
} from "lucide-react";

/**
 * Popup "Điều chỉnh số liệu" của tab Báo Cáo Chi Phí.
 *
 * XOÁ THẬT, ÁP CHO TOÀN HỆ THỐNG. Bấm "Xoá Khỏi Dữ Liệu" là gửi danh sách
 * lượt quẹt xuống `SA_MealLogDeleted_Save`; từ đó Dashboard, Lịch Sử Chấm Ăn
 * và mọi bảng kê đều không tính chúng nữa — không màn hình nào phải nhớ tự
 * trừ.
 *
 * Ngoại lệ duy nhất: suất mất mát do chấm thẻ sai (`lossIds`) vẫn HIỂN THỊ y
 * nguyên ở tab Suất Ăn Mất Mát — tab đó là sổ ghi lỗi chấm thẻ, xoá khỏi bảng
 * kê không làm lỗi đó biến mất. Khoản "xoá suất ăn bất kỳ" (`ids`) thì biến
 * mất khỏi tất cả.
 *
 * Không mất gì cả: bản sao đầy đủ của mỗi dòng bị xoá nằm trong
 * QLSA.dbo.TB_EVENT_LOG_DEL, và mỗi lần bấm là MỘT LƯỢT XOÁ khôi phục lại
 * được nguyên vẹn ở khối "Lịch sử xoá" ngay dưới. Vì thế nút bấm nói thẳng là
 * "xoá" và có một bước xác nhận, thay vì nói giảm thành "điều chỉnh".
 *
 * Người dùng chỉnh trên một BẢN NHÁP trong popup, bấm nút mới ghi — bấm Hủy
 * thì mọi thứ đang gõ dở bị bỏ, đúng như người ta chờ đợi ở một hộp thoại.
 */

const STAFF_LABEL: Record<StaffType, string> = {
  VN: "Người Việt",
  KR: "Người Hàn",
};

const SHIFT_OPTIONS: ShiftCode[] = [...SHIFT_ORDER, "Khác"];

interface CostAdjustmentDialogProps {
  /** Số suất mất mát có thể xóa, tính trên dữ liệu hiện có. */
  lossPreview: Record<LossDeductScope, { count: number; amount: number }>;
  /**
   * Tính ra danh sách lượt quẹt bị xóa theo một bản nháp — chính là
   * `applyCostAdjustment` của tab, để popup không phải tự dựng lại quy tắc.
   */
  resolveRemoval: (draft: CostAdjustment) => {
    /** Khoản "xóa suất ăn bất kỳ" — biến mất khỏi mọi màn hình. */
    ids: string[];
    /** Suất mất mát — bị trừ khỏi mọi con số, vẫn hiện ở tab Suất Ăn Mất Mát. */
    lossIds: string[];
    count: number;
    amount: number;
    shortfall: number;
  };
  /** Đã ghi xong (xóa hoặc khôi phục) — tab nạp lại log và bảng 12 tháng. */
  onApplied: () => Promise<void>;
  onClose: () => void;
  /**
   * Biên lọc tới GIÂY của tab. Không dùng để lọc gì ở đây — chỉ truyền xuống
   * `SA_MealLogDeleted_Save` để nó tìm lượt quẹt bằng index thay vì quét cả
   * bảng BioStar; phải đúng khoảng mà danh sách id được lấy ra.
   */
  startDateTime: string;
  endDateTime: string;
  startDate: string;
  endDate: string;
}

let seq = 0;
const newId = () => `adhoc_${Date.now()}_${seq++}`;

/* -------------------------------------------------------------------------
   Nhập khoản trừ từ file Excel

   File Excel chỉ là một cách GÕ NHANH danh sách khoản trừ — nó không có
   đường đi riêng nào. Mỗi dòng hợp lệ trở thành đúng một `AdHocDeduction`
   như khi bấm "Thêm Dòng", rơi vào cùng bản nháp, được `resolveRemoval`
   tính bằng cùng một hàm và được ghi bằng cùng một nút "Xóa Khỏi Dữ Liệu".
   Vì thế không thể có chuyện nhập bằng file ra số khác nhập bằng tay.

   Người dùng vẫn phải bấm nút xóa sau khi nhập, y hệt như thêm dòng thủ công
   — nhập xong mà xóa luôn thì file Excel trở thành một đường tắt đi vòng qua
   bước xác nhận, thứ mà cả hộp thoại này được dựng lên để bắt buộc.
   ------------------------------------------------------------------------- */

/** Tên cột chấp nhận trong file, viết thường không dấu cách thừa. */
const COLUMN_ALIASES: Record<
  "staffType" | "date" | "shiftCode" | "quantity",
  string[]
> = {
  staffType: [
    "nhóm nhân sự",
    "nhom nhan su",
    "nhóm",
    "nhom",
    "stafftype",
  ],
  date: ["ngày", "ngay", "ngày của bảng kê", "ngay cua bang ke", "date"],
  shiftCode: ["ca", "ca ăn", "ca an", "mã ca", "ma ca", "shiftcode", "shift"],
  quantity: [
    "số suất xóa",
    "so suat xoa",
    "số suất",
    "so suat",
    "số lượng",
    "so luong",
    "quantity",
    "sl",
  ],
};

/**
 * Ô "Nhóm nhân sự": chấp nhận mã ('VN'/'KR'), tên tiếng Việt, hoặc bỏ trống.
 *
 * Trả về null khi ô có chữ nhưng không đọc được — im lặng coi một giá trị lạ
 * là người Việt thì cả dòng đó xóa nhầm nhóm mà không ai biết.
 */
function parseStaffTypeCell(value: unknown): StaffType | null {
  const raw = String(value ?? "").trim();
  if (!raw) return "VN";

  const t = raw.toLowerCase();
  if (t === "kr" || t === "korea" || t.includes("hàn") || t.includes("han")) {
    return "KR";
  }
  if (t === "vn" || t.includes("việt") || t.includes("viet")) return "VN";
  return null;
}

/** Ô "Ca": mã ca ('CA4'), tên trên bảng kê ('12H'), hoặc 'Khác'. */
function parseShiftCell(value: unknown): ShiftCode | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  const byCode = SHIFT_OPTIONS.find((c) => c.toUpperCase() === upper);
  if (byCode) return byCode;

  if (upper === "KHAC") return "Khác";

  const byLabel = SHIFT_OPTIONS.find(
    (c) => reportShiftLabel(c).toUpperCase() === upper,
  );
  return byLabel ?? null;
}

/**
 * Một dòng của file sau khi đọc.
 *
 * `error` là lý do dòng bị loại (nêu rõ CỘT nào sai và sai vì sao);
 * `warning` là dòng vẫn nhập được nhưng gần như chắc chắn không xóa được suất
 * nào — cùng cảnh báo mà dòng nhập tay hiện khi ngày nằm ngoài khoảng lọc.
 */
interface ParsedRow {
  rowNumber: number;
  data: AdHocDeduction | null;
  error: string | null;
  warning: string | null;
}

export const CostAdjustmentDialog: React.FC<CostAdjustmentDialogProps> = ({
  lossPreview,
  resolveRemoval,
  onApplied,
  onClose,
  startDateTime,
  endDateTime,
  startDate,
  endDate,
}) => {
  /* Component chỉ được mount khi popup mở (xem FinancialReportView), nên bản
     nháp bắt đầu rỗng ở mỗi lần mở — lần bấm trước đã ghi xuống cơ sở dữ liệu
     rồi, giữ lại chỉ tổ khiến người dùng xóa hai lần cùng một thứ. Quan trọng
     hơn: KHÔNG có nhánh `return null` nào cắt ngang danh sách hook. Trước đây
     `useMemo` nằm sau một `if (!open) return null` nên số hook đổi từ 2 lên 3
     đúng lúc bấm mở, React ném lỗi và cả trang trắng xoá. */
  const [draft, setDraft] = useState<CostAdjustment>(EMPTY_ADJUSTMENT);
  const [busy, setBusy] = useState(false);
  const [batches, setBatches] = useState<api.MealLogDeletionBatch[] | null>(
    null,
  );
  const [historyError, setHistoryError] = useState<string | null>(null);

  /* Cửa sổ xem trước dữ liệu đọc từ file Excel. `null` = không có file nào
     đang chờ xác nhận. */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<ParsedRow[] | null>(null);
  const [importFileName, setImportFileName] = useState("");

  const patch = (p: Partial<CostAdjustment>) =>
    setDraft((d) => ({ ...d, ...p }));

  const patchRow = (id: string, p: Partial<AdHocDeduction>) =>
    setDraft((d) => ({
      ...d,
      adHoc: d.adHoc.map((r) => (r.id === id ? { ...r, ...p } : r)),
    }));

  const addRow = () =>
    setDraft((d) => ({
      ...d,
      adHoc: [
        ...d.adHoc,
        {
          id: newId(),
          staffType: "VN",
          /* Mặc định ngày cuối kỳ: người dùng thường chốt số vào cuối kỳ. */
          date: endDate,
          shiftCode: "CA4",
          quantity: 1,
        },
      ],
    }));

  const removeRow = (id: string) =>
    setDraft((d) => ({ ...d, adHoc: d.adHoc.filter((r) => r.id !== id) }));

  /* -------------------------------------------------------------------
     Nhập khoản trừ từ file Excel
     ------------------------------------------------------------------- */

  const parseWorkbook = (
    XLSX: typeof import("xlsx"),
    buffer: ArrayBuffer,
  ): ParsedRow[] => {
    const fromSerial = serialDateReader(XLSX);
    const rows = readSheetRows(XLSX, buffer, COLUMN_ALIASES, [
      "date",
      "shiftCode",
      "quantity",
    ]);

    return rows.map(({ rowNumber, picked }): ParsedRow => {
      const bad = (error: string): ParsedRow => ({
        rowNumber,
        data: null,
        error,
        warning: null,
      });

      const shown = (v: unknown) => String(v ?? "").trim() || "(trống)";

      /* Cột "Nhóm nhân sự" không bắt buộc — bỏ trống là người Việt, đúng mặc
         định của dòng thêm tay. Nhưng có chữ mà không đọc được thì phải báo,
         không được đoán. */
      const staffType = parseStaffTypeCell(picked.staffType);
      if (staffType === null) {
        return bad(
          `Cột "Nhóm nhân sự": không đọc được "${shown(picked.staffType)}". ` +
            'Nhận "Người Việt"/"VN" hoặc "Người Hàn"/"KR", hoặc để trống.',
        );
      }

      const date = normalizeDate(picked.date, fromSerial);
      if (!date) {
        return bad(
          `Cột "Ngày": không đọc được "${shown(picked.date)}". Cần ` +
            "YYYY-MM-DD hoặc DD/MM/YYYY (ngày trước, tháng sau) và phải là " +
            "ngày có thật.",
        );
      }

      const shiftCode = parseShiftCell(picked.shiftCode);
      if (!shiftCode) {
        return bad(
          `Cột "Ca": "${shown(picked.shiftCode)}" không có trong danh mục. ` +
            `Nhận mã ca (${SHIFT_OPTIONS.join(", ")}) hoặc tên trên bảng kê ` +
            `(${SHIFT_OPTIONS.map(reportShiftLabel).join(", ")}).`,
        );
      }

      const quantity = normalizeNumber(picked.quantity);
      if (quantity === null || !Number.isInteger(quantity) || quantity <= 0) {
        return bad(
          `Cột "Số suất xóa": "${shown(picked.quantity)}" phải là số nguyên ` +
            "lớn hơn 0.",
        );
      }

      return {
        rowNumber,
        error: null,
        /* Ngày ngoài khoảng lọc KHÔNG phải lỗi — dòng thêm tay cũng cho nhập
           và chỉ cảnh báo. Nhập bằng file phải xử sự y hệt, nếu không hai
           lối vào lại có hai bộ quy tắc. */
        warning:
          date < startDate || date > endDate
            ? `Ngày nằm ngoài khoảng lọc ${startDate} → ${endDate}, sẽ không ` +
              "xóa được suất nào."
            : null,
        data: { id: newId(), staffType, date, shiftCode, quantity },
      };
    });
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cho phép chọn lại đúng file vừa chọn sau khi đóng cửa sổ xem trước.
    e.target.value = "";
    if (!file) return;

    try {
      const [XLSX, buffer] = await Promise.all([loadXLSX(), file.arrayBuffer()]);
      const parsed = parseWorkbook(XLSX, buffer);
      setImportFileName(file.name);
      setImportRows(parsed);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không đọc được file Excel.");
    }
  };

  const importValidRows = importRows?.filter((r) => r.data) ?? [];
  const importErrorCount = importRows?.filter((r) => r.error).length ?? 0;
  const importWarningCount = importRows?.filter((r) => r.warning).length ?? 0;

  /**
   * Xác nhận: đưa các dòng đọc được VÀO BẢN NHÁP, không ghi gì xuống cơ sở dữ
   * liệu. Từ đây chúng là những dòng bình thường — sửa được, xoá được, và chỉ
   * biến thành lượt xóa khi bấm "Xóa Khỏi Dữ Liệu" như mọi dòng khác.
   */
  const handleConfirmImport = () => {
    if (importValidRows.length === 0) return;
    setDraft((d) => ({
      ...d,
      adHoc: [...d.adHoc, ...importValidRows.map((r) => r.data!)],
    }));
    setImportRows(null);
  };

  /** File mẫu — cột phải đúng ALIAS ĐẦU TIÊN của mỗi trường. */
  const handleDownloadTemplate = async () => {
    const XLSX = await loadXLSX();
    const sample = [
      {
        "Nhóm nhân sự": STAFF_LABEL.VN,
        Ngày: endDate,
        Ca: "CA4",
        "Số suất xóa": 5,
      },
      {
        "Nhóm nhân sự": STAFF_LABEL.KR,
        Ngày: endDate,
        Ca: "CA1",
        "Số suất xóa": 2,
      },
    ];
    const ws = XLSX.utils.json_to_sheet(sample);
    ws["!cols"] = [{ wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "XoaSuatAn");
    XLSX.writeFile(wb, "Mau_Xoa_Suat_An_Bat_Ky.xlsx");
  };

  const lossPick = lossPreview[draft.lossScope];

  /* Xem trước bằng CHÍNH hàm mà lúc bấm sẽ chạy, nên con số hiện ở chân popup
     đúng bằng số sẽ bị xóa — kể cả khi ngày/ca không đủ lượt quẹt. */
  const preview = useMemo(
    () => (isAdjustmentActive(draft) ? resolveRemoval(draft) : null),
    [draft, resolveRemoval],
  );

  /* Ngày ngoài khoảng lọc thì khoản trừ không tìm thấy lượt quẹt nào — cảnh
     báo ngay tại dòng thay vì để người dùng bấm áp dụng rồi ngơ ngác. */
  const outOfRange = (d: AdHocDeduction) =>
    d.date < startDate || d.date > endDate;

  const loadHistory = useCallback(async () => {
    try {
      setHistoryError(null);
      /* Procedure lọc theo NGÀY LỊCH của lượt quẹt — truyền phần ngày của bộ
         lọc giờ, không phải khoảng ngày làm việc `startDate`/`endDate`. */
      setBatches(
        await api.fetchMealLogDeletions(
          startDateTime.slice(0, 10),
          endDateTime.slice(0, 10),
        ),
      );
    } catch (err) {
      setBatches([]);
      setHistoryError(
        err instanceof Error ? err.message : "Không đọc được lịch sử xóa.",
      );
    }
  }, [startDateTime, endDateTime]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Thao tác thất bại.");
    } finally {
      setBusy(false);
    }
  };

  const handleApply = () => {
    const total = preview ? preview.ids.length + preview.lossIds.length : 0;
    if (!preview || total === 0) {
      alert("Không có lượt quẹt nào để xóa.");
      return;
    }

    const lines: string[] = [];
    if (preview.lossIds.length > 0) {
      lines.push(
        `• ${preview.lossIds.length.toLocaleString("vi-VN")} suất mất mát: ` +
          "không còn được tính tiền ở bất kỳ đâu, nhưng VẪN HIỂN THỊ y nguyên " +
          "ở tab Suất Ăn Mất Mát.",
      );
    }
    if (preview.ids.length > 0) {
      lines.push(
        `• ${preview.ids.length.toLocaleString("vi-VN")} suất xóa bất kỳ: ` +
          "biến mất khỏi TẤT CẢ các màn hình.",
      );
    }

    const ok = confirm(
      `Xóa ${total.toLocaleString("vi-VN")} lượt quẹt ` +
        `(${formatVND(preview.amount)}) khỏi hệ thống?\n\n` +
        lines.join("\n") +
        '\n\nBản sao được giữ lại nên khôi phục được ở mục "Lịch sử xóa".',
    );
    if (!ok) return;

    return run(async () => {
      const reason = `Chốt số với nhà ăn ${startDate} → ${endDate}`;
      const result = await api.deleteMealLogs(
        preview.ids,
        preview.lossIds,
        reason,
        startDateTime,
        endDateTime,
      );
      setDraft(EMPTY_ADJUSTMENT);
      await onApplied();
      await loadHistory();
      alert(
        `Đã xóa ${result.deleted.toLocaleString("vi-VN")} lượt quẹt.` +
          (result.deleted < result.requested
            ? ` ${(result.requested - result.deleted).toLocaleString("vi-VN")} lượt đã bị xóa từ trước.`
            : ""),
      );
    });
  };

  const handleRestore = (batch: api.MealLogDeletionBatch) => {
    const ok = confirm(
      `Khôi phục ${batch.punchCount.toLocaleString("vi-VN")} lượt quẹt đã xóa lúc ${batch.deletedAt}?`,
    );
    if (!ok) return;

    return run(async () => {
      await api.restoreMealLogDeletion(batch.batchId);
      await onApplied();
      await loadHistory();
    });
  };

  const label = "block text-[11px] font-semibold text-slate-600 mb-1";
  const field =
    "w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs focus:outline-none focus:border-amber-500";

  return (
    <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      {/* Xem trước dữ liệu đọc từ file Excel — z-index cao hơn hộp thoại chính
          để nằm hẳn lên trên nó. Dòng lỗi KHÔNG được nhập, và cột "Trạng thái"
          nói rõ cột nào sai, sai vì sao. */}
      {importRows && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full border border-slate-200 overflow-hidden flex flex-col max-h-[85vh]">
            <div className="bg-slate-900 text-white px-6 py-4 flex justify-between items-start gap-4">
              <div>
                <span className="text-amber-400 font-semibold text-xs uppercase tracking-wider">
                  Xem trước dữ liệu xóa suất ăn
                </span>
                <h3 className="text-lg font-bold">{importFileName}</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {importValidRows.length} dòng hợp lệ
                  {importWarningCount > 0 && (
                    <span className="text-amber-400">
                      {" "}
                      &middot; {importWarningCount} dòng cảnh báo
                    </span>
                  )}
                  {importErrorCount > 0 && (
                    <span className="text-red-400">
                      {" "}
                      &middot; {importErrorCount} dòng lỗi (không nhập)
                    </span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setImportRows(null)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-100 text-slate-700 font-bold uppercase border-b">
                  <tr>
                    <th className="py-2.5 px-3">Dòng</th>
                    <th className="py-2.5 px-3">Trạng Thái</th>
                    <th className="py-2.5 px-3">Nhóm Nhân Sự</th>
                    <th className="py-2.5 px-3">Ngày</th>
                    <th className="py-2.5 px-3">Ca</th>
                    <th className="py-2.5 px-3 text-center">Số Suất Xóa</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {importRows.map((row) => (
                    <tr
                      key={row.rowNumber}
                      className={
                        row.error
                          ? "bg-red-50"
                          : row.warning
                            ? "bg-amber-50"
                            : "hover:bg-slate-50"
                      }
                    >
                      <td className="py-2 px-3 text-slate-400 font-mono">
                        {row.rowNumber}
                      </td>
                      <td className="py-2 px-3 max-w-[24rem]">
                        {row.error ? (
                          <span className="inline-flex items-start gap-1 text-red-700 font-semibold">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span className="whitespace-normal break-words">
                              {row.error}
                            </span>
                          </span>
                        ) : row.warning ? (
                          <span className="inline-flex items-start gap-1 text-amber-800 font-semibold">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span className="whitespace-normal break-words">
                              {row.warning}
                            </span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Hợp lệ
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 font-semibold text-slate-800">
                        {row.data ? STAFF_LABEL[row.data.staffType] : "-"}
                      </td>
                      <td className="py-2 px-3 font-semibold text-slate-900 font-mono">
                        {row.data?.date ?? "-"}
                      </td>
                      <td className="py-2 px-3 font-bold text-amber-700">
                        {row.data
                          ? `${reportShiftLabel(row.data.shiftCode)} (${row.data.shiftCode})`
                          : "-"}
                      </td>
                      <td className="py-2 px-3 text-center font-mono font-extrabold text-red-700">
                        {row.data
                          ? row.data.quantity.toLocaleString("vi-VN")
                          : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="p-4 bg-slate-100 border-t border-slate-200 flex flex-wrap justify-between items-center gap-3">
              <span className="text-xs text-slate-600 max-w-lg">
                Dòng lỗi bị bỏ qua và nêu lý do ngay tại dòng đó. Các dòng hợp
                lệ được đưa vào <strong>bản nháp</strong> bên dưới, giống hệt
                như thêm tay &mdash;{" "}
                <strong>chưa có gì bị xóa</strong> cho tới khi bấm &ldquo;Xóa
                Khỏi Dữ Liệu&rdquo;.
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setImportRows(null)}
                  className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50 transition"
                >
                  Hủy
                </button>
                <button
                  type="button"
                  onClick={handleConfirmImport}
                  disabled={importValidRows.length === 0}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-slate-950 rounded-lg text-xs font-bold transition"
                >
                  Thêm {importValidRows.length} Dòng Vào Bản Nháp
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full border border-slate-200 overflow-hidden flex flex-col max-h-[88vh]">
        <div className="bg-slate-900 text-white px-6 py-4 flex justify-between items-start gap-4">
          <div>
            <span className="text-red-400 font-semibold text-xs uppercase tracking-wider">
              Xóa thật — áp dụng cho toàn bộ dữ liệu
            </span>
            <h3 className="text-lg font-bold">
              Điều Chỉnh Số Liệu Chốt Với Nhà Ăn
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Bỏ hẳn những lượt quẹt không phải trả tiền. Mọi màn hình đều tính
              số mới; bản sao vẫn được giữ để khôi phục.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          <div className="flex items-start gap-2 text-[11px] text-slate-700 bg-red-50 border border-red-200 rounded-xl p-3">
            <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span>
              Lượt quẹt bị xóa sẽ <strong>không còn được tính</strong> ở
              Dashboard, Lịch Sử Chấm Ăn, mọi bảng kê chi phí và cả bảng
              &ldquo;Total suất ăn&rdquo; 12 tháng. Riêng{" "}
              <strong>suất ăn mất mát</strong> đã xóa vẫn hiển thị y nguyên ở
              tab Suất Ăn Mất Mát; suất xóa bất kỳ thì biến mất khỏi tất cả.
            </span>
          </div>

          {/* --- 1. Xóa suất ăn mất mát --------------------------------- */}
          <section className="rounded-xl border border-slate-200 overflow-hidden">
            <label className="flex items-start gap-3 p-4 bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.deductLosses}
                onChange={(e) => patch({ deductLosses: e.target.checked })}
                className="mt-0.5 w-4 h-4 accent-amber-500"
              />
              <div>
                <div className="text-sm font-bold text-slate-900">
                  Xóa suất ăn mất mát do chấm thẻ sai
                </div>
                <div className="text-xs text-slate-600 mt-0.5">
                  Lấy đúng kết quả của tab Suất Ăn Mất Mát: quẹt trùng ca và
                  quẹt vượt hạn mức 3 ca/ngày làm việc. Chỉ trừ trong tính toán
                  &mdash; tab Suất Ăn Mất Mát vẫn hiển thị y nguyên. Số dưới
                  đây là phần chưa xóa.
                </div>
              </div>
            </label>

            {draft.deductLosses && (
              <div className="p-4 space-y-2 border-t border-slate-200">
                {(
                  [
                    ["ALL", "Tất cả suất mất mát"],
                    ["CHARGEABLE", "Chỉ suất bị trừ tiền"],
                    ["FREE", "Chỉ trừ suất ăn không bị trừ tiền"],
                  ] as [LossDeductScope, string][]
                ).map(([scope, text]) => {
                  const p = lossPreview[scope];
                  const active = draft.lossScope === scope;
                  return (
                    <label
                      key={scope}
                      className={`flex items-center justify-between gap-3 p-3 rounded-lg border cursor-pointer transition ${
                        active
                          ? "border-amber-500 bg-amber-50"
                          : "border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <span className="flex items-center gap-2.5">
                        <input
                          type="radio"
                          checked={active}
                          onChange={() => patch({ lossScope: scope })}
                          className="w-4 h-4 accent-amber-500"
                        />
                        <span className="text-xs font-semibold text-slate-800">
                          {text}
                        </span>
                      </span>
                      <span className="text-xs font-mono text-slate-700 whitespace-nowrap">
                        {p.count.toLocaleString("vi-VN")} suất &middot;{" "}
                        <strong className="text-red-700">
                          {formatVND(p.amount)}
                        </strong>
                      </span>
                    </label>
                  );
                })}
                <p className="text-[11px] text-slate-500">
                  Suất &ldquo;không bị trừ tiền&rdquo; là lượt quẹt lại trong
                  vòng 10 phút — không ai ăn thêm suất nào.
                  &ldquo;Chỉ suất bị trừ tiền&rdquo; bỏ qua các lượt đó;
                  &ldquo;Chỉ trừ suất ăn không bị trừ tiền&rdquo; thì ngược
                  lại, chỉ xóa đúng các lượt đó.
                </p>
              </div>
            )}
          </section>

          {/* --- 2. Xóa suất bất kỳ ------------------------------------- */}
          <section className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-slate-900">
                  Xóa suất ăn bất kỳ
                </div>
                <div className="text-xs text-slate-600 mt-0.5">
                  Chọn nhóm nhân sự, ngày, ca và số suất cần bỏ. Thêm bao nhiêu
                  dòng cũng được, gõ tay từng dòng hoặc tải lên cả danh sách
                  bằng file Excel. Bỏ lượt quẹt muộn nhất trước; ngày là ngày
                  của bảng kê (ca đêm tính cho ngày hôm sau). Không bao giờ
                  chọn lượt quẹt của người có suất mất mát trong ngày đó, để
                  tab Suất Ăn Mất Mát giữ y nguyên.
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleDownloadTemplate}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold transition"
                >
                  <FileDown className="w-3.5 h-3.5" /> Tải File Mẫu
                </button>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  title="Đọc danh sách khoản trừ từ file Excel vào bản nháp"
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-300 text-slate-950 rounded-lg text-xs font-bold transition"
                >
                  <Upload className="w-3.5 h-3.5" /> Upload Excel
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handleFileSelected}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={addRow}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold transition"
                >
                  <Plus className="w-3.5 h-3.5" /> Thêm Dòng
                </button>
              </div>
            </div>

            <div className="p-4 space-y-3">
              {draft.adHoc.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-3">
                  Chưa có khoản nào. Bấm &ldquo;Thêm Dòng&rdquo; để bắt đầu.
                </p>
              ) : (
                draft.adHoc.map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-2 md:grid-cols-[1.2fr_1.2fr_1fr_0.8fr_auto] gap-2 items-end p-3 rounded-lg border border-slate-200 bg-slate-50/60"
                  >
                    <div>
                      <label className={label}>Nhóm nhân sự</label>
                      <select
                        value={row.staffType}
                        onChange={(e) =>
                          patchRow(row.id, {
                            staffType: e.target.value as StaffType,
                          })
                        }
                        className={`${field} font-bold`}
                      >
                        {(["VN", "KR"] as StaffType[]).map((t) => (
                          <option key={t} value={t}>
                            {STAFF_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className={label}>Ngày</label>
                      <input
                        type="date"
                        value={row.date}
                        min={startDate}
                        max={endDate}
                        onChange={(e) =>
                          patchRow(row.id, { date: e.target.value })
                        }
                        className={`${field} font-semibold ${
                          outOfRange(row) ? "border-red-400 bg-red-50" : ""
                        }`}
                      />
                    </div>

                    <div>
                      <label className={label}>Ca</label>
                      <select
                        value={row.shiftCode}
                        onChange={(e) =>
                          patchRow(row.id, {
                            shiftCode: e.target.value as ShiftCode,
                          })
                        }
                        className={`${field} font-bold text-amber-800`}
                      >
                        {SHIFT_OPTIONS.map((c) => (
                          <option key={c} value={c}>
                            {reportShiftLabel(c)} ({c})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className={label}>Số suất xóa</label>
                      <input
                        type="number"
                        min={1}
                        value={row.quantity}
                        onChange={(e) =>
                          patchRow(row.id, { quantity: Number(e.target.value) })
                        }
                        className={`${field} font-mono font-bold text-red-700`}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      title="Bỏ dòng này khỏi bản nháp"
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>

                    {outOfRange(row) && (
                      <div className="col-span-2 md:col-span-5 flex items-center gap-1.5 text-[11px] font-semibold text-red-700">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Ngày này nằm ngoài khoảng lọc {startDate} → {endDate},
                        sẽ không xóa được suất nào.
                      </div>
                    )}
                  </div>
                ))
              )}

              {preview && preview.shortfall > 0 && (
                <div className="flex items-start gap-1.5 text-[11px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  {preview.shortfall.toLocaleString("vi-VN")} suất không xóa
                  được vì ngày/ca đó không đủ lượt quẹt (không tính lượt quẹt
                  của những người có suất mất mát trong ngày).
                </div>
              )}
            </div>
          </section>

          {/* --- 3. Lịch sử xóa & khôi phục ----------------------------- */}
          <section className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                  <History className="w-4 h-4 text-slate-500" /> Lịch sử xóa
                </div>
                <div className="text-xs text-slate-600 mt-0.5">
                  Các lượt xóa có lượt quẹt rơi vào khoảng {startDate} →{" "}
                  {endDate}. Khôi phục là trả lại nguyên vẹn cả lượt.
                </div>
              </div>
              <button
                type="button"
                onClick={loadHistory}
                disabled={busy}
                className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50 disabled:opacity-40 transition"
              >
                Tải Lại
              </button>
            </div>

            <div className="max-h-56 overflow-y-auto">
              {historyError ? (
                <p className="text-xs text-red-700 p-4">{historyError}</p>
              ) : batches === null ? (
                <p className="text-xs text-slate-400 p-4 flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang đọc lịch
                  sử…
                </p>
              ) : batches.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-6">
                  Chưa xóa lượt quẹt nào trong khoảng này.
                </p>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100 text-slate-700 font-bold uppercase border-b sticky top-0">
                    <tr>
                      <th className="py-2 px-3">Thời Điểm Xóa</th>
                      <th className="py-2 px-3">Người Xóa</th>
                      <th className="py-2 px-3">Lý Do</th>
                      <th className="py-2 px-3 text-center">Số Lượt</th>
                      <th className="py-2 px-3 text-center">Mất Mát</th>
                      <th className="py-2 px-3 text-center">Trong Kỳ</th>
                      <th className="py-2 px-3 text-center">Khôi Phục</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {batches.map((b) => (
                      <tr key={b.batchId} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-semibold text-slate-900 whitespace-nowrap">
                          {b.deletedAt}
                        </td>
                        <td className="py-2 px-3 text-slate-700">
                          {b.deletedBy || "-"}
                        </td>
                        <td className="py-2 px-3 text-slate-600">
                          {b.reason || "-"}
                        </td>
                        <td className="py-2 px-3 text-center font-mono font-bold text-red-700">
                          {b.punchCount.toLocaleString("vi-VN")}
                        </td>
                        <td
                          className="py-2 px-3 text-center font-mono text-slate-700"
                          title="Số lượt là suất mất mát — vẫn hiển thị ở tab Suất Ăn Mất Mát"
                        >
                          {(b.lossPunchCount ?? 0).toLocaleString("vi-VN")}
                        </td>
                        <td className="py-2 px-3 text-center font-mono text-slate-700">
                          {b.punchCountInRange.toLocaleString("vi-VN")}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleRestore(b)}
                            disabled={busy}
                            title="Trả lại toàn bộ lượt quẹt của lần xóa này"
                            className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded text-[11px] font-bold transition"
                          >
                            <Undo2 className="w-3 h-3" /> Khôi phục
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>

        <div className="p-4 bg-slate-100 border-t border-slate-200 flex flex-wrap justify-between items-center gap-3">
          <div className="text-xs text-slate-600">
            Sẽ xóa:{" "}
            <strong className="text-slate-900">
              {(preview?.count ?? 0).toLocaleString("vi-VN")} suất
            </strong>
            {preview && preview.count > 0 && (
              <span className="text-slate-500">
                {" "}
                &middot; {formatVND(preview.amount)}
                {draft.deductLosses &&
                  ` (${lossPick.count.toLocaleString("vi-VN")} mất mát tối đa)`}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDraft(EMPTY_ADJUSTMENT)}
              disabled={busy || !isAdjustmentActive(draft)}
              className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Bỏ Hết
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50 disabled:opacity-40 transition"
            >
              Đóng
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={busy || !preview || preview.count === 0}
              className="flex items-center gap-1.5 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold transition shadow-sm"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              {busy ? "Đang ghi…" : "Xóa Khỏi Dữ Liệu"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
