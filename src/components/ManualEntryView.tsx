import React, { useMemo, useRef, useState } from 'react';
import {
  DepartmentMapping,
  ManualMealEntry,
  ShiftCode,
  ShiftInfo,
  StaffType,
} from '../types';
import {
  Edit3,
  Plus,
  Trash2,
  Calendar,
  ShieldCheck,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileDown,
  Upload,
  X,
} from 'lucide-react';
import {
  loadXLSX,
  normalizeDate,
  normalizeNumber,
  readSheetRows,
  serialDateReader,
  todayString,
} from '../services/excelImport';

/** Một dòng nhập thủ công hợp lệ, đúng dạng mà API nhận. */
type ManualInput = Omit<ManualMealEntry, 'id' | 'createdAt'>;

interface ManualEntryViewProps {
  entries: ManualMealEntry[];
  /** Danh mục ca lấy từ SA_Shift. */
  shifts: ShiftInfo[];
  /**
   * Bảng Ánh Xạ Bộ Phận — nguồn của danh sách chọn "Bộ Phận Thụ Hưởng". Chọn
   * đúng một bộ phận nhỏ đã ánh xạ thì suất nhập tay chắc chắn rơi vào đúng
   * bộ phận lớn của nó, thay vì gõ tay rồi không khớp và rơi vào 'Khác'.
   */
  mappings: DepartmentMapping[];
  onSave: (entry: ManualInput) => Promise<void>;
  /**
   * Lưu nhiều dòng một lượt rồi nạp lại danh sách đúng một lần.
   *
   * Trả về lỗi của TỪNG DÒNG (`index` là vị trí trong mảng gửi đi) thay vì ném
   * ra ở dòng hỏng đầu tiên: những dòng lưu được vẫn phải được lưu, còn dòng
   * hỏng phải nói được nó hỏng vì sao, ngay tại dòng đó.
   */
  onImport: (rows: ManualInput[]) => Promise<{ index: number; message: string }[]>;
  onDelete: (id: string) => Promise<void>;
}

/** Tên cột chấp nhận trong file Excel, viết thường không dấu cách thừa. */
const COLUMN_ALIASES: Record<keyof ManualInput, string[]> = {
  date: ['ngày', 'ngay', 'ngày áp dụng', 'ngay ap dung', 'date'],
  shiftCode: ['ca', 'ca ăn', 'ca an', 'mã ca', 'shiftcode', 'shift'],
  staffType: ['nhóm', 'nhom', 'nhóm nhân sự', 'nhom nhan su', 'stafftype'],
  department: ['bộ phận', 'bo phan', 'bộ phận thụ hưởng', 'department'],
  quantity: ['số lượng', 'so luong', 'số lượng suất', 'quantity', 'sl'],
  reason: ['lý do', 'ly do', 'lý do / ghi chú', 'ghi chú', 'reason'],
  enteredBy: ['người nhập', 'nguoi nhap', 'người xác nhận', 'enteredby'],
};

/**
 * Nhóm nhân sự của suất nhập tay.
 *
 * Lượt quẹt thật suy ra nhóm từ bộ phận lớn (`KR` thì ăn giá suất Hàn), nhưng
 * suất nhập tay không gắn với nhân sự nào nên người nhập phải tự chọn — và
 * lựa chọn đó quyết định suất được cộng vào khối nào của bảng kê tháng.
 */
const STAFF_TYPE_ORDER: StaffType[] = ['VN', 'KR'];

const STAFF_TYPE_LABEL: Record<StaffType, string> = {
  VN: 'Người Việt',
  KR: 'Người Hàn',
};

/** Ô "Nhóm" trong Excel: chấp nhận mã, tên tiếng Việt, hoặc bỏ trống. */
function parseStaffType(value: unknown): StaffType {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return 'VN';
  if (s === 'kr' || s.includes('hàn') || s.includes('han') || s === 'korea') {
    return 'KR';
  }
  return 'VN';
}

/**
 * Một dòng sau khi đọc file: hoặc hợp lệ, hoặc kèm lý do bị loại.
 *
 * `error` mang hai loại lý do và cả hai đều hiện ở cột "Trạng thái": lỗi đọc
 * file (ngày sai, ca không có trong danh mục…) và lỗi máy chủ trả về lúc lưu.
 * `saved` đánh dấu dòng đã lưu xong, để bấm "Xác nhận" lần nữa sau khi một vài
 * dòng hỏng không lưu lại chúng thành hai lần.
 */
interface ParsedRow {
  rowNumber: number;
  data: ManualInput | null;
  error: string | null;
  saved?: boolean;
}

export const ManualEntryView: React.FC<ManualEntryViewProps> = ({
  entries,
  shifts,
  mappings,
  onSave,
  onImport,
  onDelete,
}) => {
  /** Bộ phận nhỏ đã ánh xạ, gom theo bộ phận lớn, đều sắp theo tên. */
  const departmentGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    mappings.forEach((m) => {
      const small = m.smallDepartment.trim();
      if (!small) return;
      const large = m.largeDepartment.trim() || 'Khác';
      if (!groups.has(large)) groups.set(large, []);
      const list = groups.get(large)!;
      if (!list.includes(small)) list.push(small);
    });
    return Array.from(groups.entries())
      .sort((a, b) => a[0].localeCompare(b[0], 'vi'))
      .map(([large, smalls]) => ({
        large,
        smalls: smalls.sort((a, b) => a.localeCompare(b, 'vi')),
      }));
  }, [mappings]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<ParsedRow[] | null>(null);
  const [importFileName, setImportFileName] = useState('');
  const [date, setDate] = useState(todayString);
  const [shiftCode, setShiftCode] = useState<ShiftCode>('CA4');
  const [staffType, setStaffType] = useState<StaffType>('VN');
  const [department, setDepartment] = useState('CSP Operator');
  const [quantity, setQuantity] = useState(10);
  const [reason, setReason] = useState('Máy đọc thẻ TA-104 bị mất kết nối mạng giờ ăn trưa');
  const [enteredBy, setEnteredBy] = useState('Quản lý nhà ăn');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Lưu lượt nhập thủ công thất bại.');
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quantity || quantity <= 0) return;

    return run(() =>
      onSave({
        date,
        shiftCode,
        staffType,
        department: department.trim(),
        quantity,
        reason: reason.trim(),
        enteredBy: enteredBy.trim(),
      })
    );
  };

  const handleDelete = (id: string) => {
    if (confirm('Xóa lượt nhập thủ công này?')) {
      return run(() => onDelete(id));
    }
  };

  /* ---------------------------------------------------------------------
     Nhập từ file Excel
     --------------------------------------------------------------------- */

  /** Mã ca hợp lệ = danh mục SA_Shift, cộng thêm 'Khác' như ô chọn trên form. */
  const shiftCodeSet = new Set<string>([...shifts.map((s) => s.code), 'Khác']);

  /**
   * Ô "Ca" có thể là mã ca ("CA4"), tên ca do người dùng đặt trong SA_Shift
   * (ShiftReName, vd "12H"), hoặc "Khác". Trả về mã ca chuẩn, hoặc null nếu
   * không khớp danh mục nào.
   */
  const resolveShiftCode = (value: unknown): ShiftCode | null => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;

    const upper = raw.toUpperCase();
    if (shiftCodeSet.has(upper)) return upper as ShiftCode;
    if (upper === 'KHAC' || raw.toLowerCase() === 'khác') return 'Khác';

    const byAlias = shifts.find(
      (s) =>
        s.ShiftReName?.toUpperCase() === upper || s.name?.toUpperCase() === upper
    );
    return byAlias ? byAlias.code : null;
  };

  const parseWorkbook = (
    XLSX: typeof import('xlsx'),
    buffer: ArrayBuffer
  ): ParsedRow[] => {
    const fromSerial = serialDateReader(XLSX);
    const rows = readSheetRows(XLSX, buffer, COLUMN_ALIASES, [
      'date',
      'shiftCode',
      'quantity',
    ]);

    return rows.map(({ rowNumber, picked }) => {
      const date = normalizeDate(picked.date, fromSerial);
      const shiftCode = resolveShiftCode(picked.shiftCode);
      const quantity = normalizeNumber(picked.quantity);
      /* Cột Nhóm không bắt buộc: file mẫu cũ không có cột này và suất nhập
         tay trước đây đều tính giá người Việt. */
      const staffType = parseStaffType(picked.staffType);

      if (!date)
        return {
          rowNumber,
          data: null,
          error:
            `Ngày không đọc được: "${String(picked.date ?? '').trim() || '(trống)'}". ` +
            'Cần YYYY-MM-DD hoặc DD/MM/YYYY (ngày trước, tháng sau) và phải là ngày có thật.',
        };
      if (!shiftCode)
        return {
          rowNumber,
          data: null,
          error: `Ca không có trong danh mục (${[...shiftCodeSet].join(', ')}).`,
        };
      if (quantity === null || !Number.isInteger(quantity) || quantity <= 0)
        return {
          rowNumber,
          data: null,
          error: 'Số lượng suất phải là số nguyên lớn hơn 0.',
        };

      return {
        rowNumber,
        error: null,
        data: {
          date,
          shiftCode,
          staffType,
          department: String(picked.department ?? '').trim(),
          quantity,
          reason: String(picked.reason ?? '').trim(),
          enteredBy: String(picked.enteredBy ?? '').trim(),
        },
      };
    });
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cho phép chọn lại đúng file vừa chọn sau khi đóng modal.
    e.target.value = '';
    if (!file) return;

    try {
      const [XLSX, buffer] = await Promise.all([loadXLSX(), file.arrayBuffer()]);
      const rows = parseWorkbook(XLSX, buffer);
      setImportFileName(file.name);
      setImportRows(rows);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Không đọc được file Excel.');
    }
  };

  /* Dòng còn phải lưu = đọc được VÀ chưa lưu lần bấm trước. */
  const pendingImportRows = importRows?.filter((r) => r.data && !r.saved) ?? [];
  const savedImportCount = importRows?.filter((r) => r.saved).length ?? 0;
  const invalidImportCount =
    importRows?.filter((r) => !r.data || r.error).length ?? 0;

  /**
   * Gửi những dòng còn lại rồi ghi kết quả NGƯỢC VỀ ĐÚNG DÒNG: dòng nào máy
   * chủ từ chối thì cột "Trạng thái" của chính nó mang câu báo lỗi, dòng nào
   * lưu được thì chuyển sang "Đã nhập". Chỉ đóng cửa sổ khi không còn lỗi nào
   * — còn lỗi mà đóng đi thì người dùng mất luôn chỗ để đọc.
   */
  const handleConfirmImport = () =>
    run(async () => {
      const sent = pendingImportRows;
      if (sent.length === 0) return;

      const failures = await onImport(sent.map((r) => r.data!));
      const messageByRowNumber = new Map<number, string>();
      failures.forEach((f) => {
        const row = sent[f.index];
        if (row) messageByRowNumber.set(row.rowNumber, f.message);
      });

      if (messageByRowNumber.size === 0) {
        setImportRows(null);
        return;
      }

      const sentRowNumbers = new Set(sent.map((r) => r.rowNumber));
      setImportRows(
        (rows) =>
          rows?.map((r) => {
            if (!sentRowNumbers.has(r.rowNumber)) return r;
            const message = messageByRowNumber.get(r.rowNumber);
            return message
              ? { ...r, error: message }
              : { ...r, error: null, saved: true };
          }) ?? null
      );
    });

  /** Xuất file mẫu để người dùng điền theo đúng tên cột. */
  const handleDownloadTemplate = async () => {
    const XLSX = await loadXLSX();
    const sample = [
      {
        'Ngày': todayString(),
        'Ca': shifts[0]?.code ?? 'CA4',
        'Nhóm': STAFF_TYPE_LABEL.VN,
        'Bộ phận': 'CSP Operator',
        'Số lượng': 10,
        'Lý do': 'Máy đọc thẻ mất kết nối mạng giờ ăn',
        'Người nhập': 'Quản lý nhà ăn',
      },
      {
        'Ngày': todayString(),
        'Ca': shifts[0]?.code ?? 'CA4',
        'Nhóm': STAFF_TYPE_LABEL.KR,
        'Bộ phận': 'KR',
        'Số lượng': 2,
        'Lý do': 'Khách Hàn ăn đột xuất không quẹt thẻ',
        'Người nhập': 'Quản lý nhà ăn',
      },
    ];
    const ws = XLSX.utils.json_to_sheet(sample);
    ws['!cols'] = [
      { wch: 12 },
      { wch: 8 },
      { wch: 12 },
      { wch: 22 },
      { wch: 10 },
      { wch: 42 },
      { wch: 20 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'NhapThuCong');
    XLSX.writeFile(wb, 'Mau_Nhap_Thu_Cong_Ca.xlsx');
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <Edit3 className="w-5 h-5 text-amber-600" />
            <h2 className="text-xl font-bold text-slate-800">
              Quản Lý Nhập Bổ Sung Thủ Công Suất Ăn Theo Ca
            </h2>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Áp dụng cho trường hợp máy chấm công bị hỏng, mất điện, mất kết nối mạng hoặc ăn đột
            xuất không quẹt thẻ. Nhập từng dòng ở form bên dưới, hoặc tải lên cả danh sách
            bằng file Excel.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={handleDownloadTemplate}
            className="flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded-xl text-xs font-semibold transition"
          >
            <FileDown className="w-4 h-4" /> Tải File Mẫu
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-slate-950 rounded-xl text-xs font-bold transition shadow-sm"
          >
            <Upload className="w-4 h-4" /> Nhập Từ Excel
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileSelected}
            className="hidden"
          />
        </div>
      </div>

      {/* Modal xem trước dữ liệu nhập từ Excel */}
      {importRows && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full border border-slate-200 overflow-hidden flex flex-col max-h-[85vh]">
            <div className="bg-slate-900 text-white px-6 py-4 flex justify-between items-start gap-4">
              <div>
                <span className="text-amber-400 font-semibold text-xs uppercase tracking-wider">
                  Xem Trước Dữ Liệu Nhập
                </span>
                <h3 className="text-lg font-bold">{importFileName}</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {pendingImportRows.length} dòng hợp lệ
                  {savedImportCount > 0 && (
                    <span className="text-emerald-400">
                      {' '}
                      • {savedImportCount} dòng đã nhập
                    </span>
                  )}
                  {invalidImportCount > 0 && (
                    <span className="text-red-400"> • {invalidImportCount} dòng lỗi</span>
                  )}
                </p>
              </div>
              <button
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
                    <th className="py-2.5 px-3">Ngày</th>
                    <th className="py-2.5 px-3">Ca</th>
                    <th className="py-2.5 px-3">Nhóm</th>
                    <th className="py-2.5 px-3">Bộ Phận</th>
                    <th className="py-2.5 px-3 text-center">Số Lượng</th>
                    <th className="py-2.5 px-3">Lý Do / Người Nhập</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {importRows.map((row) => (
                    <tr
                      key={row.rowNumber}
                      className={
                        row.error
                          ? 'bg-red-50'
                          : row.saved
                            ? 'bg-emerald-50/60'
                            : 'hover:bg-slate-50'
                      }
                    >
                      <td className="py-2 px-3 text-slate-400 font-mono">{row.rowNumber}</td>
                      {/* Mọi lý do một dòng không vào được đều hiện ở đây —
                          cả lỗi đọc file lẫn câu máy chủ trả về lúc lưu — nên
                          người dùng biết phải sửa gì mà không cần đoán. */}
                      <td className="py-2 px-3 max-w-[22rem]">
                        {row.error ? (
                          <span className="inline-flex items-start gap-1 text-red-700 font-semibold">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span className="whitespace-normal break-words">
                              {row.error}
                            </span>
                          </span>
                        ) : row.saved ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                            <ShieldCheck className="w-3.5 h-3.5" /> Đã nhập
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Hợp lệ
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 font-semibold text-slate-900">
                        {row.data?.date ?? '-'}
                      </td>
                      <td className="py-2 px-3 font-bold text-amber-700">
                        {row.data?.shiftCode ?? '-'}
                      </td>
                      <td className="py-2 px-3 font-semibold">
                        {row.data ? STAFF_TYPE_LABEL[row.data.staffType] : '-'}
                      </td>
                      <td className="py-2 px-3 text-slate-700">{row.data?.department || '-'}</td>
                      <td className="py-2 px-3 text-center font-extrabold text-amber-600">
                        {row.data ? `+${row.data.quantity.toLocaleString('vi-VN')}` : '-'}
                      </td>
                      <td className="py-2 px-3 text-slate-600">
                        <div>{row.data?.reason || '-'}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {row.data?.enteredBy || ''}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="p-4 bg-slate-100 border-t border-slate-200 flex flex-wrap justify-between items-center gap-3">
              <span className="text-xs text-slate-600">
                Chỉ những dòng hợp lệ được lưu; dòng lỗi bị bỏ qua và nêu lý do
                ở cột Trạng thái. Sửa file rồi chọn lại — dòng đã nhập không
                lưu lần hai.
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setImportRows(null)}
                  className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50 transition"
                >
                  {savedImportCount > 0 ? 'Đóng' : 'Hủy'}
                </button>
                <button
                  onClick={handleConfirmImport}
                  disabled={busy || pendingImportRows.length === 0}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-slate-950 rounded-lg text-xs font-bold transition"
                >
                  {busy ? 'Đang lưu…' : `Xác Nhận Nhập ${pendingImportRows.length} Dòng`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Form */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4 h-fit">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
            <Plus className="w-4 h-4 text-amber-600" /> Thêm Lượt Nhập Thủ Công
          </h3>

          <form onSubmit={handleAdd} className="space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Ngày Áp Dụng <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500 font-bold"
              />
              <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">
                Là NGÀY LÀM VIỆC (22:50 hôm trước → 22:50 hôm nay): CA1 ngày 26
                là ca đêm 25 lúc 22:50 → 26 lúc 01:50.
              </p>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Nhóm Nhân Sự <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                {STAFF_TYPE_ORDER.map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => setStaffType(code)}
                    className={`px-3 py-2 rounded-lg border font-bold transition ${
                      staffType === code
                        ? code === 'KR'
                          ? 'bg-orange-500 border-orange-500 text-white shadow-sm'
                          : 'bg-emerald-600 border-emerald-600 text-white shadow-sm'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {STAFF_TYPE_LABEL[code]}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">
                {staffType === 'KR'
                  ? 'Suất Hàn được cộng thẳng vào dòng ca của khối 한국 trong bảng kê tháng, tính theo giá suất Hàn.'
                  : 'Suất Việt hiện thành dòng "Ký số" riêng dưới dòng ca của khối 베트남, tính theo giá suất Việt.'}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Ca Ăn</label>
                <select
                  value={shiftCode}
                  onChange={(e) => setShiftCode(e.target.value as ShiftCode)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500 font-bold text-amber-800"
                >
                  {shifts.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.code} ({s.startTime.slice(0, 5)})
                    </option>
                  ))}
                  <option value="Khác">Khác</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Số Lượng Suất <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  required
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500 font-extrabold text-amber-600 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Bộ Phận Thụ Hưởng
              </label>
              <select
                required
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500"
              >
                <option value="" disabled>
                  — Chọn bộ phận nhỏ —
                </option>
                {departmentGroups.map((g) => (
                  <optgroup key={g.large} label={g.large}>
                    {g.smalls.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {/* Giá trị cũ không còn trong bảng ánh xạ vẫn hiện ra để không
                    bị âm thầm đổi, nhưng suất đó sẽ tính vào 'Khác'. */}
                {department &&
                  !departmentGroups.some((g) => g.smalls.includes(department)) && (
                    <option value={department}>{department} (chưa ánh xạ)</option>
                  )}
              </select>
              <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">
                Danh sách lấy từ Ánh Xạ Bộ Phận (tab Thống Kê Ca / Bộ Phận). Không
                thấy bộ phận cần chọn thì thêm nó vào bảng ánh xạ trước.
              </p>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Lý Do / Ghi Chú</label>
              <textarea
                rows={2}
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Người Xác Nhận / Nhập</label>
              <input
                type="text"
                required
                value={enteredBy}
                onChange={(e) => setEnteredBy(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-slate-950 font-bold rounded-xl transition shadow-sm flex items-center justify-center space-x-2"
            >
              <Plus className="w-4 h-4" />
              <span>{busy ? 'Đang lưu…' : 'Xác Nhận Nhập Bổ Sung'}</span>
            </button>
          </form>
        </div>

        {/* Right Table */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs font-semibold text-slate-700">
            <span>Lịch sử các lần nhập thủ công suất ăn</span>
            <span className="text-amber-700 font-bold bg-amber-50 px-2.5 py-0.5 rounded border border-amber-200">
              {entries.length} lượt
            </span>
          </div>

          <div className="overflow-x-auto max-h-[500px]">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-900 text-white font-bold uppercase sticky top-0 z-10 text-[11px]">
                <tr>
                  <th className="py-3 px-4">Ngày Áp Dụng</th>
                  <th className="py-3 px-3">Ca</th>
                  <th className="py-3 px-3">Nhóm</th>
                  <th className="py-3 px-4">Bộ Phận</th>
                  <th className="py-3 px-3 text-center">Số Lượng</th>
                  <th className="py-3 px-4">Lý Do / Người Nhập</th>
                  <th className="py-3 px-3 text-center">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800">
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-400">
                      Chưa có lượt nhập thủ công nào.
                    </td>
                  </tr>
                ) : (
                  entries.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 transition">
                      <td className="py-3 px-4 font-bold text-slate-900">{item.date}</td>
                      <td className="py-3 px-3 font-bold text-amber-700">{item.shiftCode}</td>
                      <td className="py-3 px-3">
                        <span
                          className={`px-2 py-0.5 rounded border text-[11px] font-bold ${
                            item.staffType === 'KR'
                              ? 'bg-orange-50 text-orange-800 border-orange-200'
                              : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                          }`}
                        >
                          {STAFF_TYPE_LABEL[item.staffType] ?? item.staffType}
                        </span>
                      </td>
                      <td className="py-3 px-4">{item.department}</td>
                      <td className="py-3 px-3 text-center font-extrabold text-amber-600 text-sm">
                        +{item.quantity}
                      </td>
                      <td className="py-3 px-4 text-slate-600">
                        <div>{item.reason}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          Bởi: {item.enteredBy} • {item.createdAt}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <button
                          onClick={() => handleDelete(item.id)}
                          disabled={busy}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 rounded transition"
                          title="Xóa"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
