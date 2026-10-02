import React, { useMemo, useState, useRef } from 'react';
import { SupplyShiftCode } from '../types';
import {
  Plus,
  Trash2,
  Upload,
  FileDown,
  X,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import {
  formatVND,
  SUPPLY_SHIFT_LABEL,
  SUPPLY_SHIFT_ORDER,
} from '../services/mealEngine';
import {
  loadXLSX,
  normalizeDate,
  normalizeNumber,
  readSheetRows,
  serialDateReader,
  todayString,
} from '../services/excelImport';

/**
 * Màn hình nhập một loại HÀNG CẤP PHÁT: mỗi NGÀY một dòng, mang số lượng của
 * cả hai ca cấp phát (Ca ngày / Ca đêm), cùng tên hạng mục, đơn giá, nhà cung
 * cấp và ghi chú — kèm tải file mẫu và nhập từ Excel.
 *
 * MỘT NGÀY MỘT DÒNG, KHÔNG CÓ CỘT "CA": nhà ăn phát hai lượt mỗi ngày và
 * người nhập luôn cầm số liệu của cả ngày, nên bắt họ nhập hai dòng rồi đọc
 * hai dòng rời nhau là bắt họ tự cộng lại bằng mắt. Dưới cơ sở dữ liệu vẫn là
 * hai bản ghi (SA_MilkEntry / SA_ExtraCost mỗi dòng một ca) — bảng kê chi phí
 * cần tách được từng ca — nên ở đây có đúng một chỗ gộp/tách: `groupByDay`
 * gộp bản ghi thành dòng ngày để hiển thị, `expandDay` tách dòng ngày thành
 * bản ghi để lưu.
 *
 * Lưu theo (ngày, hạng mục, ca) là GHI ĐÈ chứ không thêm dòng mới: nhập lại
 * một ngày đã có — hoặc nhập lại chính file Excel vừa nhập — phải ra đúng số
 * đó, không phải gấp đôi. Ca để trống (0) mà trong cơ sở dữ liệu đang có thì
 * bản ghi của ca đó bị xoá.
 *
 * Sữa và Chi phí phát sinh có cấu trúc y hệt nhau và phải lên bảng kê theo
 * cùng một cách, nên chúng dùng chung component này thay vì có hai bản sao
 * chép tay sẽ lệch nhau ngay lần sửa đầu tiên. Cái khác nhau giữa hai domain
 * chỉ là nhãn, màu và dữ liệu mẫu — tất cả nằm trong `SupplyEntryConfig`.
 */

/** Một BẢN GHI cấp phát ở dạng trung tính — đúng một dòng dưới cơ sở dữ liệu. */
export interface SupplyRow {
  id: string;
  date: string;
  shift: SupplyShiftCode;
  itemName: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  supplier: string;
  notes?: string;
}

export type SupplyInput = Omit<SupplyRow, 'id' | 'totalAmount'>;

/** Bản ghi kèm id khi ghi đè một dòng đã có; thiếu id là thêm mới. */
export type SupplyUpsert = SupplyInput & { id?: string };

/**
 * Một DÒNG NGÀY: cùng ngày, cùng hạng mục, hai ca đi chung. Đây là đơn vị mà
 * người dùng nhìn thấy và nhập vào — cả trên form lẫn trong file Excel.
 */
export interface SupplyDayInput {
  date: string;
  itemName: string;
  quantities: Record<SupplyShiftCode, number>;
  unitPrice: number;
  supplier: string;
  notes?: string;
}

/** Dòng ngày đã gộp từ các bản ghi có sẵn, kèm id của từng ca để ghi đè / xoá. */
interface SupplyDayRow extends SupplyDayInput {
  key: string;
  ids: Record<SupplyShiftCode, string | undefined>;
  allIds: string[];
  quantity: number;
  totalAmount: number;
  /** Hai ca nhập hai đơn giá khác nhau — bảng hiện giá bình quân và nói rõ. */
  mixedPrice: boolean;
}

/** Bảng màu của một khối — Tailwind cần class viết nguyên văn nên phải liệt kê. */
export interface SupplyAccent {
  headerGradient: string;
  headerIcon: string;
  headerText: string;
  focusBorder: string;
  primaryButton: string;
  estimateBox: string;
  estimateLabel: string;
  estimateValue: string;
  itemText: string;
  amountText: string;
  countBadge: string;
  confirmButton: string;
}

export interface SupplyEntryConfig {
  title: string;
  description: React.ReactNode;
  icon: React.ReactNode;
  /** "Tổng Chi Phí Sữa" / "Tổng Chi Phí Phát Sinh". */
  totalLabel: string;
  /** "Loại Sữa" / "Hạng Mục". */
  itemLabel: string;
  /** Tên cột hạng mục chấp nhận trong file Excel; phần tử đầu là tên chính thức. */
  itemAliases: string[];
  /** Thông báo khi ô hạng mục bỏ trống. */
  itemMissingError: string;
  templateFileName: string;
  templateSheetName: string;
  samples: SupplyDayInput[];
  defaults: Omit<SupplyDayInput, 'date'>;
  emptyText: string;
  accent: SupplyAccent;
}

interface SupplyEntryManagerProps {
  config: SupplyEntryConfig;
  rows: SupplyRow[];
  /**
   * Ghi một lượt: `upserts` là các bản ghi cần thêm/ghi đè, `deleteIds` là các
   * bản ghi của ca bị bỏ trống. Một lời gọi cho cả hai việc để danh sách chỉ
   * phải nạp lại đúng một lần dù người dùng nhập cả file Excel.
   */
  onCommit: (upserts: SupplyUpsert[], deleteIds: string[]) => Promise<void>;
  startDate: string;
  endDate: string;
}

/** Các trường đọc được từ file Excel. */
type SheetField =
  | 'date'
  | 'itemName'
  | 'quantityDay'
  | 'quantityNight'
  | 'unitPrice'
  | 'supplier'
  | 'notes';

/** Một dòng sau khi đọc file: hoặc hợp lệ, hoặc kèm lý do bị loại. */
interface ParsedRow {
  rowNumber: number;
  data: SupplyDayInput | null;
  error: string | null;
}

const emptyQuantities = (): Record<SupplyShiftCode, number> => ({
  NGAY: 0,
  DEM: 0,
});

/** Khoá của một dòng ngày: cùng ngày + cùng hạng mục là cùng một dòng. */
const dayKey = (date: string, itemName: string) => `${date}|${itemName}`;

/** Bản ghi -> dòng ngày. Hai ca của cùng ngày & hạng mục gộp làm một. */
function groupByDay(rows: SupplyRow[]): SupplyDayRow[] {
  const map = new Map<string, SupplyDayRow>();

  rows.forEach((r) => {
    /* Bản ghi cũ chưa có cột ca thì về ca ngày, đúng như `parseSupplyShift`
       và mặc định của SA_MilkEntry.MilkShift / SA_ExtraCost.CostShift. */
    const shift: SupplyShiftCode = r.shift === 'DEM' ? 'DEM' : 'NGAY';
    const key = dayKey(r.date, r.itemName);

    if (!map.has(key)) {
      map.set(key, {
        key,
        date: r.date,
        itemName: r.itemName,
        quantities: emptyQuantities(),
        ids: { NGAY: undefined, DEM: undefined },
        allIds: [],
        unitPrice: r.unitPrice,
        quantity: 0,
        totalAmount: 0,
        supplier: r.supplier,
        notes: r.notes,
        mixedPrice: false,
      });
    }

    const day = map.get(key)!;
    day.quantities[shift] += r.quantity;
    day.quantity += r.quantity;
    day.totalAmount += r.totalAmount;
    day.allIds.push(r.id);
    /* Cùng (ngày, hạng mục, ca) chỉ nên có một bản ghi; nếu dữ liệu cũ có
       nhiều thì giữ id đầu tiên để ghi đè và các id còn lại vẫn bị xoá cùng
       dòng — `allIds` mới là danh sách xoá. */
    if (day.ids[shift] === undefined) day.ids[shift] = r.id;
    if (r.unitPrice !== day.unitPrice) day.mixedPrice = true;
    if (!day.supplier) day.supplier = r.supplier;
    if (!day.notes) day.notes = r.notes;
  });

  return Array.from(map.values())
    .map((d) => ({
      ...d,
      /* Đơn giá bình quân — hai ca có thể nhập hai giá khác nhau. */
      unitPrice: d.quantity > 0 ? d.totalAmount / d.quantity : d.unitPrice,
    }))
    .sort(
      (a, b) => b.date.localeCompare(a.date) || a.itemName.localeCompare(b.itemName, 'vi')
    );
}

export const SupplyEntryManager: React.FC<SupplyEntryManagerProps> = ({
  config,
  rows,
  onCommit,
  startDate,
  endDate,
}) => {
  const a = config.accent;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<ParsedRow[] | null>(null);
  const [importFileName, setImportFileName] = useState('');
  const [date, setDate] = useState(todayString);
  const [itemName, setItemName] = useState(config.defaults.itemName);
  const [qtyDay, setQtyDay] = useState(config.defaults.quantities.NGAY);
  const [qtyNight, setQtyNight] = useState(config.defaults.quantities.DEM);
  const [unitPrice, setUnitPrice] = useState(config.defaults.unitPrice);
  const [supplier, setSupplier] = useState(config.defaults.supplier);
  const [notes, setNotes] = useState(config.defaults.notes ?? '');
  const [busy, setBusy] = useState(false);

  const columnAliases: Record<SheetField, string[]> = {
    date: ['ngày', 'ngay', 'ngày nhập', 'ngày cấp phát', 'date'],
    itemName: config.itemAliases,
    quantityDay: [
      'ca ngày',
      'ca ngay',
      'sl ca ngày',
      'số lượng ca ngày',
      'so luong ca ngay',
      'day',
    ],
    quantityNight: [
      'ca đêm',
      'ca dem',
      'sl ca đêm',
      'số lượng ca đêm',
      'so luong ca dem',
      'night',
    ],
    unitPrice: ['đơn giá', 'don gia', 'unitprice', 'giá'],
    supplier: ['nhà cung cấp', 'nha cung cap', 'supplier', 'ncc'],
    notes: ['ghi chú', 'ghi chu', 'notes', 'diễn giải'],
  };

  /* Bản ghi trong khoảng lọc, đã gộp thành dòng ngày. Việc ghi đè thì tra
     trên TOÀN BỘ `rows`, không chỉ phần đang lọc: nhập một ngày nằm ngoài
     khoảng lọc vẫn phải ghi đè bản ghi cũ của ngày đó chứ không tạo thêm. */
  const allDays = useMemo(() => groupByDay(rows), [rows]);
  const dayIndex = useMemo(
    () => new Map(allDays.map((d) => [d.key, d])),
    [allDays]
  );
  const filteredDays = allDays.filter((d) => d.date >= startDate && d.date <= endDate);

  const totalQuantity = filteredDays.reduce((sum, d) => sum + d.quantity, 0);
  const totalCost = filteredDays.reduce((sum, d) => sum + d.totalAmount, 0);
  const shiftTotals = SUPPLY_SHIFT_ORDER.reduce(
    (acc, code) => {
      acc[code] = filteredDays.reduce((s, d) => s + d.quantities[code], 0);
      return acc;
    },
    emptyQuantities()
  );

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Lưu thông tin thất bại.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Dòng ngày -> lệnh ghi: ca có số lượng thành bản ghi (kèm id cũ nếu có để
   * ghi đè), ca bỏ trống mà trước đó có bản ghi thì bản ghi đó bị xoá.
   */
  const planDay = (
    day: SupplyDayInput,
    plan: { upserts: SupplyUpsert[]; deleteIds: string[] }
  ) => {
    const existing = dayIndex.get(dayKey(day.date, day.itemName));

    SUPPLY_SHIFT_ORDER.forEach((shift) => {
      const quantity = Math.trunc(day.quantities[shift] ?? 0);
      const id = existing?.ids[shift];

      if (quantity > 0) {
        plan.upserts.push({
          id,
          date: day.date,
          shift,
          itemName: day.itemName,
          quantity,
          unitPrice: day.unitPrice,
          supplier: day.supplier,
          notes: day.notes,
        });
      } else if (id !== undefined) {
        plan.deleteIds.push(id);
      }
    });

    /* Dữ liệu cũ có thể có nhiều bản ghi cho cùng một ca — chỉ giữ lại bản
       ghi vừa ghi đè, phần dư phải đi, nếu không số của ngày sẽ cộng dồn. */
    existing?.allIds.forEach((id) => {
      const kept = SUPPLY_SHIFT_ORDER.some(
        (shift) => existing.ids[shift] === id && (day.quantities[shift] ?? 0) > 0
      );
      if (!kept && !plan.deleteIds.includes(id)) plan.deleteIds.push(id);
    });
  };

  const commitDays = (days: SupplyDayInput[]) => {
    const plan = { upserts: [] as SupplyUpsert[], deleteIds: [] as string[] };
    days.forEach((d) => planDay(d, plan));
    return onCommit(plan.upserts, plan.deleteIds);
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const quantities = { NGAY: qtyDay || 0, DEM: qtyNight || 0 };
    if (quantities.NGAY <= 0 && quantities.DEM <= 0) {
      alert('Phải nhập số lượng cho ít nhất một ca (Ca ngày hoặc Ca đêm).');
      return;
    }

    return run(() =>
      commitDays([
        {
          date,
          itemName: itemName.trim(),
          quantities,
          unitPrice,
          supplier: supplier.trim(),
          notes: notes.trim(),
        },
      ])
    );
  };

  const handleDelete = (day: SupplyDayRow) => {
    if (confirm(`Xóa toàn bộ số liệu ngày ${day.date} của "${day.itemName}"?`))
      return run(() => onCommit([], day.allIds));
  };

  /* ---------------------------------------------------------------------
     Nhập từ file Excel
     --------------------------------------------------------------------- */

  const parseWorkbook = (
    XLSX: typeof import('xlsx'),
    buffer: ArrayBuffer
  ): ParsedRow[] => {
    const fromSerial = serialDateReader(XLSX);
    const sheetRows = readSheetRows(XLSX, buffer, columnAliases, [
      'date',
      'itemName',
      'quantityDay',
      'quantityNight',
      'unitPrice',
    ]);

    const parsed = sheetRows.map(({ rowNumber, picked }): ParsedRow => {
      const parsedDate = normalizeDate(picked.date, fromSerial);
      const parsedItem = String(picked.itemName ?? '').trim();
      const parsedPrice = normalizeNumber(picked.unitPrice);

      /* Ô trống = không cấp ca đó, không phải lỗi: rất nhiều ngày chỉ phát
         một ca. Chỉ số âm hoặc chữ mới là lỗi. */
      const readQty = (value: unknown): number | null => {
        const s = String(value ?? '').trim();
        if (!s) return 0;
        const n = normalizeNumber(value);
        if (n === null || !Number.isInteger(n) || n < 0) return null;
        return n;
      };
      const day = readQty(picked.quantityDay);
      const night = readQty(picked.quantityNight);

      if (!parsedDate)
        return {
          rowNumber,
          data: null,
          error:
            `Ngày không đọc được: "${String(picked.date ?? '').trim() || '(trống)'}". ` +
            'Cần YYYY-MM-DD hoặc DD/MM/YYYY (ngày trước, tháng sau) và phải là ngày có thật.',
        };
      if (!parsedItem)
        return { rowNumber, data: null, error: config.itemMissingError };
      if (day === null || night === null)
        return {
          rowNumber,
          data: null,
          error: 'Số lượng phải là số nguyên không âm (để trống nếu không cấp ca đó).',
        };
      if (day === 0 && night === 0)
        return {
          rowNumber,
          data: null,
          error: 'Cả hai ca đều trống — dòng này không có số liệu để lưu.',
        };
      if (parsedPrice === null || parsedPrice < 0)
        return { rowNumber, data: null, error: 'Đơn giá không hợp lệ.' };

      return {
        rowNumber,
        error: null,
        data: {
          date: parsedDate,
          itemName: parsedItem,
          quantities: { NGAY: day, DEM: night },
          unitPrice: parsedPrice,
          supplier: String(picked.supplier ?? '').trim(),
          notes: String(picked.notes ?? '').trim(),
        },
      };
    });

    /* Hai dòng cùng (ngày, hạng mục) trong một file sẽ ghi đè lẫn nhau —
       báo ngay tại dòng thay vì im lặng lấy dòng cuối. */
    const lastAt = new Map<string, number>();
    parsed.forEach((r, i) => {
      if (r.data) lastAt.set(dayKey(r.data.date, r.data.itemName), i);
    });
    return parsed.map((r, i) => {
      if (!r.data) return r;
      const key = dayKey(r.data.date, r.data.itemName);
      if (lastAt.get(key) === i) return r;
      return {
        rowNumber: r.rowNumber,
        data: null,
        error: 'Trùng ngày + hạng mục với một dòng khác phía dưới trong file.',
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
      const parsed = parseWorkbook(XLSX, buffer);
      setImportFileName(file.name);
      setImportRows(parsed);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Không đọc được file Excel.');
    }
  };

  const validImportRows = importRows?.filter((r) => r.data) ?? [];
  const invalidImportCount = (importRows?.length ?? 0) - validImportRows.length;

  const handleConfirmImport = () =>
    run(async () => {
      await commitDays(validImportRows.map((r) => r.data!));
      setImportRows(null);
    });

  /** Xuất file mẫu để người dùng điền theo đúng tên cột. */
  const handleDownloadTemplate = async () => {
    const XLSX = await loadXLSX();
    const itemHeader = config.itemAliases[0];

    const sample = config.samples.map((r) => ({
      'Ngày': r.date || todayString(),
      [itemHeader]: r.itemName,
      [SUPPLY_SHIFT_LABEL.NGAY]: r.quantities.NGAY,
      [SUPPLY_SHIFT_LABEL.DEM]: r.quantities.DEM,
      'Đơn giá': r.unitPrice,
      'Nhà cung cấp': r.supplier,
      'Ghi chú': r.notes ?? '',
    }));

    const ws = XLSX.utils.json_to_sheet(sample);
    ws['!cols'] = [
      { wch: 12 },
      { wch: 26 },
      { wch: 10 },
      { wch: 10 },
      { wch: 12 },
      { wch: 32 },
      { wch: 36 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, config.templateSheetName);
    XLSX.writeFile(wb, config.templateFileName);
  };

  /** Ô số lượng của một ca: 0 hiện dấu gạch cho khỏi rối mắt. */
  const qtyCell = (value: number) =>
    value > 0 ? (
      value.toLocaleString('vi-VN')
    ) : (
      <span className="text-slate-300">-</span>
    );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div
        className={`bg-gradient-to-r ${a.headerGradient} p-5 rounded-2xl text-white shadow-lg flex flex-col md:flex-row md:items-center justify-between gap-4`}
      >
        <div className="flex items-start space-x-3">
          <div className="p-2.5 bg-white/20 rounded-xl backdrop-blur-md">
            <span className={a.headerIcon}>{config.icon}</span>
          </div>
          <div>
            <h2 className="text-xl font-bold">{config.title}</h2>
            <p className={`text-xs ${a.headerText} mt-1`}>{config.description}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleDownloadTemplate}
            className="flex items-center gap-1.5 px-3 py-2 bg-white/10 hover:bg-white/20 border border-white/25 text-white rounded-xl text-xs font-semibold transition backdrop-blur-sm"
          >
            <FileDown className="w-4 h-4" /> Tải File Mẫu
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-400 hover:bg-amber-300 disabled:bg-slate-400 disabled:cursor-not-allowed text-slate-950 rounded-xl text-xs font-bold transition shadow-md"
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

          <div className="bg-white/10 px-4 py-2.5 rounded-xl border border-white/20 text-right backdrop-blur-sm">
            <div className={`text-[10px] uppercase font-semibold ${a.headerText}`}>
              {config.totalLabel}
            </div>
            <div className="text-xl font-black text-amber-300">
              {formatVND(totalCost)}
            </div>
          </div>
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
                  {validImportRows.length} dòng hợp lệ
                  {invalidImportCount > 0 && (
                    <span className="text-red-400">
                      {' '}
                      • {invalidImportCount} dòng bị bỏ qua
                    </span>
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
                    <th className="py-2.5 px-3">{config.itemLabel}</th>
                    <th className="py-2.5 px-3 text-center">
                      {SUPPLY_SHIFT_LABEL.NGAY}
                    </th>
                    <th className="py-2.5 px-3 text-center">
                      {SUPPLY_SHIFT_LABEL.DEM}
                    </th>
                    <th className="py-2.5 px-3 text-center">Tổng</th>
                    <th className="py-2.5 px-3 text-right">Đơn Giá</th>
                    <th className="py-2.5 px-3 text-right">Thành Tiền</th>
                    <th className="py-2.5 px-3">Nhà Cung Cấp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {importRows.map((row) => {
                    const total = row.data
                      ? row.data.quantities.NGAY + row.data.quantities.DEM
                      : 0;
                    return (
                      <tr
                        key={row.rowNumber}
                        className={row.error ? 'bg-red-50' : 'hover:bg-slate-50'}
                      >
                        <td className="py-2 px-3 text-slate-400 font-mono">
                          {row.rowNumber}
                        </td>
                        <td className="py-2 px-3">
                          {row.error ? (
                            <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
                              <AlertTriangle className="w-3.5 h-3.5" /> {row.error}
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
                        <td className="py-2 px-3 text-slate-700">
                          {row.data?.itemName ?? '-'}
                        </td>
                        <td className="py-2 px-3 text-center font-mono">
                          {row.data ? qtyCell(row.data.quantities.NGAY) : '-'}
                        </td>
                        <td className="py-2 px-3 text-center font-mono">
                          {row.data ? qtyCell(row.data.quantities.DEM) : '-'}
                        </td>
                        <td
                          className={`py-2 px-3 text-center font-mono font-bold ${a.itemText}`}
                        >
                          {row.data ? total.toLocaleString('vi-VN') : '-'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono">
                          {row.data ? formatVND(row.data.unitPrice) : '-'}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono font-bold ${a.itemText}`}
                        >
                          {row.data ? formatVND(total * row.data.unitPrice) : '-'}
                        </td>
                        <td className="py-2 px-3 text-slate-600">
                          {row.data?.supplier || '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="p-4 bg-slate-100 border-t border-slate-200 flex flex-wrap justify-between items-center gap-3">
              <span className="text-xs text-slate-600">
                Chỉ những dòng hợp lệ được lưu. Dòng lỗi sẽ bị bỏ qua. Ngày đã
                có số liệu sẽ được GHI ĐÈ, không cộng dồn.
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setImportRows(null)}
                  className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50 transition"
                >
                  Hủy
                </button>
                <button
                  onClick={handleConfirmImport}
                  disabled={busy || validImportRows.length === 0}
                  className={`px-4 py-2 ${a.confirmButton} disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold transition`}
                >
                  {busy ? 'Đang lưu…' : `Xác Nhận Nhập ${validImportRows.length} Dòng`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form Add */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4 h-fit">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
            <Plus className={`w-4 h-4 ${a.itemText}`} /> Thêm / Sửa Một Ngày
          </h3>

          <form onSubmit={handleAdd} className="space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Ngày Nhập / Cấp Phát
              </label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={`w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none ${a.focusBorder} font-bold`}
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                {config.itemLabel}
              </label>
              <input
                type="text"
                required
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                className={`w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none ${a.focusBorder}`}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  SL {SUPPLY_SHIFT_LABEL.NGAY}
                </label>
                <input
                  type="number"
                  min={0}
                  value={qtyDay}
                  onChange={(e) => setQtyDay(Number(e.target.value))}
                  className={`w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none ${a.focusBorder} font-mono font-bold ${a.itemText}`}
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  SL {SUPPLY_SHIFT_LABEL.DEM}
                </label>
                <input
                  type="number"
                  min={0}
                  value={qtyNight}
                  onChange={(e) => setQtyNight(Number(e.target.value))}
                  className={`w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none ${a.focusBorder} font-mono font-bold ${a.itemText}`}
                />
              </div>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Đơn Giá (VNĐ) — áp cho cả hai ca
              </label>
              <input
                type="number"
                required
                step={500}
                value={unitPrice}
                onChange={(e) => setUnitPrice(Number(e.target.value))}
                className={`w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none ${a.focusBorder} font-mono font-bold`}
              />
            </div>

            <div
              className={`p-2.5 ${a.estimateBox} rounded-lg border space-y-1 text-xs`}
            >
              <div className="flex justify-between items-center">
                <span className={`${a.estimateLabel} font-semibold`}>
                  Tổng Số Lượng:
                </span>
                <span className={`font-bold ${a.estimateValue} font-mono`}>
                  {((qtyDay || 0) + (qtyNight || 0)).toLocaleString('vi-VN')}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className={`${a.estimateLabel} font-semibold`}>
                  Thành Tiền Dự Tính:
                </span>
                <span className={`font-extrabold ${a.estimateValue} font-mono`}>
                  {formatVND(((qtyDay || 0) + (qtyNight || 0)) * unitPrice)}
                </span>
              </div>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Nhà Cung Cấp
              </label>
              <input
                type="text"
                required
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                className={`w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none ${a.focusBorder}`}
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Ghi Chú</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className={`w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none ${a.focusBorder}`}
              />
            </div>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              Ngày &amp; {config.itemLabel.toLowerCase()} đã có số liệu sẽ được{' '}
              <strong>ghi đè</strong>. Để một ca bằng <strong>0</strong> là xoá
              số liệu ca đó của ngày.
            </p>

            <button
              type="submit"
              disabled={busy}
              className={`w-full py-2.5 ${a.primaryButton} disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold rounded-xl transition shadow-sm flex items-center justify-center space-x-2`}
            >
              <Plus className="w-4 h-4" />
              <span>{busy ? 'Đang lưu…' : 'Lưu Ngày Này'}</span>
            </button>
          </form>
        </div>

        {/* Right Table */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2 text-xs font-semibold text-slate-700">
            <span>
              Danh sách theo ngày ({startDate} &rarr; {endDate})
            </span>
            <span className={`font-bold px-2.5 py-0.5 rounded border ${a.countBadge}`}>
              {filteredDays.length} ngày • {SUPPLY_SHIFT_LABEL.NGAY}:{' '}
              {shiftTotals.NGAY.toLocaleString('vi-VN')} • {SUPPLY_SHIFT_LABEL.DEM}:{' '}
              {shiftTotals.DEM.toLocaleString('vi-VN')} • Total:{' '}
              {totalQuantity.toLocaleString('vi-VN')} đơn vị
            </span>
          </div>

          <div className="overflow-x-auto max-h-[500px]">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-900 text-white font-bold uppercase sticky top-0 z-10 text-[11px]">
                <tr>
                  <th className="py-3 px-4">Ngày Nhập</th>
                  <th className="py-3 px-4">{config.itemLabel}</th>
                  <th className="py-3 px-3 text-center bg-amber-900/60">
                    {SUPPLY_SHIFT_LABEL.NGAY}
                  </th>
                  <th className="py-3 px-3 text-center bg-indigo-900/60">
                    {SUPPLY_SHIFT_LABEL.DEM}
                  </th>
                  <th className="py-3 px-3 text-center">Tổng SL</th>
                  <th className="py-3 px-3 text-right">Đơn Giá</th>
                  <th className="py-3 px-4 text-right">Thành Tiền</th>
                  <th className="py-3 px-4">Nhà Cung Cấp / Ghi Chú</th>
                  <th className="py-3 px-3 text-center">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800">
                {filteredDays.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-slate-400">
                      {config.emptyText}
                    </td>
                  </tr>
                ) : (
                  filteredDays.map((item) => (
                    <tr key={item.key} className="hover:bg-slate-50 transition">
                      <td className="py-3 px-4 font-bold text-slate-900">
                        {item.date}
                      </td>
                      <td className={`py-3 px-4 font-semibold ${a.itemText}`}>
                        {item.itemName}
                      </td>
                      <td className="py-3 px-3 text-center font-mono font-bold text-amber-800 bg-amber-50/60">
                        {qtyCell(item.quantities.NGAY)}
                      </td>
                      <td className="py-3 px-3 text-center font-mono font-bold text-indigo-800 bg-indigo-50/60">
                        {qtyCell(item.quantities.DEM)}
                      </td>
                      <td className="py-3 px-3 text-center font-bold text-slate-800">
                        {item.quantity.toLocaleString('vi-VN')}
                      </td>
                      <td className="py-3 px-3 text-right font-mono">
                        {formatVND(item.unitPrice)}
                        {item.mixedPrice && (
                          <div
                            className="text-[10px] text-slate-400"
                            title="Hai ca đang có đơn giá khác nhau — đây là giá bình quân."
                          >
                            bình quân
                          </div>
                        )}
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-extrabold ${a.amountText} font-mono`}
                      >
                        {formatVND(item.totalAmount)}
                      </td>
                      <td className="py-3 px-4 text-slate-600">
                        <div>{item.supplier}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {item.notes}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <button
                          onClick={() => handleDelete(item)}
                          disabled={busy}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 rounded transition"
                          title="Xóa cả ngày (cả hai ca)"
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
