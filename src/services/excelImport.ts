/**
 * Đọc file Excel do người dùng tải lên, dùng chung cho các tab có chức năng
 * "Nhập từ Excel" (Quản Lý Sữa, Nhập Thủ Công Ca).
 *
 * Chỉ lo phần cơ học của việc đọc file: nhận diện tên cột, chuẩn hoá ô ngày
 * và ô số. Việc một dòng hợp lệ hay không là quy tắc riêng của từng tab nên
 * vẫn nằm trong view — ở đây chỉ trả về các ô đã gắn đúng tên trường.
 *
 * `xlsx` nặng ~430KB nên chỉ tải khi người dùng thực sự bấm nhập / tải file
 * mẫu, thay vì nằm trong bundle khởi động của cả ứng dụng.
 */
export const loadXLSX = () => import('xlsx');

export type XLSXModule = typeof import('xlsx');

/** "YYYY-MM-DD" theo giờ địa phương — không dùng toISOString để tránh lệch UTC. */
export function toDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DD" của hôm nay theo giờ máy. */
export function todayString(): string {
  return toDateString(new Date());
}

/** Số serial ngày của Excel -> "YYYY-MM-DD". */
export const serialDateReader =
  (XLSX: XLSXModule) =>
  (n: number): string | null => {
    const parsed = XLSX.SSF.parse_date_code(n);
    if (!parsed) return null;
    return isoIfReal(parsed.y, parsed.m, parsed.d);
  };

/**
 * "YYYY-MM-DD" nếu ba số này là một NGÀY CÓ THẬT, ngược lại null.
 *
 * Ghép chuỗi đúng định dạng thì dễ, nhưng "2026-15-09" (file ghi kiểu Mỹ
 * MM/DD/YYYY) hay "2026-02-31" vẫn khớp mọi biểu thức chính quy mà không phải
 * ngày nào cả. Trước đây chúng lọt qua đây, qua luôn cả validator của server,
 * rồi chết ở SQL Server với "Error converting data type varchar to date" —
 * một thông báo không nói được dòng nào sai và sai chỗ nào. Ngày phải được
 * kiểm ở chỗ nó được dựng lên.
 *
 * Dựng bằng Date.UTC rồi đối chiếu lại từng thành phần: JS tự cuộn tháng 13
 * sang năm sau và ngày 31/02 sang tháng 3, nên thành phần nào lệch là ngày đó
 * không tồn tại. Chặn năm dưới 1900 vì Date.UTC coi năm hai chữ số là 19xx.
 */
function isoIfReal(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2999) return null;

  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Ô ngày trong Excel có thể là Date (khi đọc với cellDates), số serial, hoặc
 * chuỗi "dd/mm/yyyy" / "yyyy-mm-dd". Chuẩn hoá hết về "YYYY-MM-DD", và trả về
 * null nếu đó không phải một ngày có thật — xem `isoIfReal`.
 *
 * Chuỗi dd/mm/yyyy đọc theo lối Việt Nam: NGÀY trước, THÁNG sau. File ghi kiểu
 * Mỹ (09/15/2026) vì thế bị loại chứ không bị đọc nhầm thành ngày khác — đoán
 * bừa một ngày sai còn tệ hơn báo lỗi.
 */
export function normalizeDate(
  value: unknown,
  fromSerial?: (n: number) => string | null
): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) return toDateString(value);

  if (typeof value === 'number') return fromSerial ? fromSerial(value) : null;

  const s = String(value ?? '').trim();
  if (!s) return null;

  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return isoIfReal(+ymd[1], +ymd[2], +ymd[3]);

  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) return isoIfReal(+dmy[3], +dmy[2], +dmy[1]);

  return null;
}

/**
 * Ép ô số về number, chấp nhận cả cách viết Việt ("31.000", "31,5") lẫn Anh
 * ("1,200,000", "31.5"). Phải phân biệt dấu phân nhóm nghìn với dấu thập phân,
 * nếu không "31.5" sẽ thành 315 — sai đơn giá mà không báo lỗi.
 */
export function normalizeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let s = String(value ?? '').replace(/\s/g, '');
  if (!s) return null;

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    // Dấu xuất hiện SAU CÙNG là dấu thập phân, dấu còn lại là phân nhóm nghìn.
    const decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const groupSep = decimalSep === '.' ? ',' : '.';
    s = s.split(groupSep).join('').replace(decimalSep, '.');
  } else if (hasComma) {
    // "1,200" là phân nhóm nghìn; "31,5" là thập phân.
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.split(',').join('') : s.replace(',', '.');
  } else if (hasDot) {
    // "31.000" là phân nhóm nghìn; "31.5" giữ nguyên là thập phân.
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.split('.').join('');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Một dòng dữ liệu sau khi các ô đã được gắn đúng tên trường. */
export interface SheetRow<K extends string> {
  /** Excel đánh số dòng từ 1 và dòng 1 là tiêu đề. */
  rowNumber: number;
  picked: Partial<Record<K, unknown>>;
  raw: Record<string, unknown>;
}

/**
 * Đọc sheet đầu tiên và đổi tên cột của file sang tên trường chuẩn.
 *
 * `aliases` là bản đồ "trường" -> các tên cột chấp nhận được, viết thường.
 * Tên đầu tiên trong danh sách là tên dùng trong thông báo lỗi và trong file
 * mẫu, nên phải là tên "chính thức" của cột.
 *
 * Ném lỗi (tiếng Việt, hiển thị thẳng qua `alert`) khi file không có sheet,
 * sheet rỗng, hoặc thiếu cột bắt buộc.
 */
export function readSheetRows<K extends string>(
  XLSX: XLSXModule,
  buffer: ArrayBuffer,
  aliases: Record<K, string[]>,
  /* NoInfer: danh sách cột bắt buộc chỉ được chọn TRONG các trường của
     `aliases`, không được tự nó thu hẹp K — nếu không, những trường không
     bắt buộc sẽ biến mất khỏi kiểu của `picked`. */
  required: NoInfer<K>[]
): SheetRow<K>[] {
  const wb = XLSX.read(buffer, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('File không có sheet nào để đọc.');

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
  });
  if (raw.length === 0) throw new Error('Sheet đầu tiên không có dòng dữ liệu nào.');

  const columnMap = new Map<string, K>();
  Object.keys(raw[0]).forEach((header) => {
    const key = String(header).trim().toLowerCase();
    (Object.keys(aliases) as K[]).forEach((field) => {
      if (aliases[field].includes(key)) columnMap.set(header, field);
    });
  });

  const found = new Set(columnMap.values());
  const missing = required.filter((f) => !found.has(f));
  if (missing.length > 0) {
    const names = missing.map((f) => aliases[f][0]).join(', ');
    throw new Error(
      `File thiếu cột bắt buộc: ${names}. Bấm "Tải file mẫu" để lấy đúng định dạng.`
    );
  }

  return raw.map((row, index) => {
    const picked: Partial<Record<K, unknown>> = {};
    Object.entries(row).forEach(([header, value]) => {
      const field = columnMap.get(header);
      if (field) picked[field] = value;
    });
    return { rowNumber: index + 2, picked, raw: row };
  });
}
