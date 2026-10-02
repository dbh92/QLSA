/**
 * "Báo cáo tổng hợp" — gộp toàn bộ bảng kê của tab Báo Cáo Chi Phí vào MỘT
 * file Excel, mỗi bảng một sheet:
 *
 *   Thống kê suất ăn tháng · Phân bổ theo BP · Total suất ăn · Phân bổ tiền ăn
 *   · 23H_CA1 · 5H_CA2 · 7H_CA3 · 12H_CA4 · 17H_CA5 · 19H_CA6
 *
 * Số liệu KHÔNG được tính lại ở đây: mọi sheet gọi đúng các hàm dựng bảng
 * trong [reportModel.ts](./reportModel.ts) mà bảng trên web đang dùng, nên
 * file Excel và màn hình không thể ra hai con số khác nhau.
 *
 * Định dạng bám theo giao diện: nền, màu chữ, ô gộp, dòng tổng và ô ghim đều
 * dịch từ class Tailwind của từng bảng — xem [workbookTheme.ts](./workbookTheme.ts).
 *
 * `exceljs` nặng ~950KB nên chỉ nạp khi người dùng thật sự bấm nút xuất báo
 * cáo, giống cách [DailyMilkView](../DailyMilkView.tsx) nạp `xlsx`.
 */
import type ExcelJS from 'exceljs';
import {
  DailyMilkEntry,
  ExtraCostEntry,
  LaborWorkDayRule,
  MonthlyCostRow,
  ShiftCode,
  ShiftInfo,
} from '../../types';
import {
  CountedManualMeal,
  MealCategory,
  MealPricing,
  ShiftCategoryLookup,
  MEAL_CATEGORY_META,
} from '../../services/mealEngine';
import {
  AllocationTone,
  CATEGORY_COLUMNS,
  ClassifiedLog,
  LaborSegment,
  MANUAL_PIVOT_LABEL,
  SHIFT_ORDER,
  StatGroupTone,
  StatRowTone,
  YEARLY_SERIES,
  allocationHeaderGroups,
  buildAllocationColumns,
  buildCategoryUnitPrices,
  buildDeptAllocation,
  buildMonthlyStatRows,
  buildShiftPivot,
  dayLabel,
  reconcileCost,
  reportShiftLabel,
  shiftAlias,
  shiftWindow,
  statRowsGrandTotal,
  yearlyValue,
} from './reportModel';
import { C, CellStyle, NUM_FMT } from './workbookTheme';

/* -------------------------------------------------------------------------
   Vẽ ô
   ------------------------------------------------------------------------- */

const FONT = 'Calibri';
/* Cỡ mặc định của Excel là 11; bản trước để 10 nên bảng kê in ra chữ nhỏ và
   mảnh, đọc rất mệt. Ô nào cần nhỏ hơn thì tự truyền `size`. */
const BASE_SIZE = 11;

function paint(cell: ExcelJS.Cell, s: CellStyle = {}) {
  if (s.fill) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.fill } };
  }
  cell.font = {
    name: FONT,
    size: s.size ?? BASE_SIZE,
    bold: s.bold ?? false,
    italic: s.italic ?? false,
    color: { argb: s.font ?? C.slate900 },
  };
  cell.alignment = {
    horizontal: s.align ?? 'center',
    vertical: 'middle',
    wrapText: s.wrap ?? false,
  };
  if (!s.noBorder) {
    const line = { style: 'thin' as const, color: { argb: s.border ?? C.slate400 } };
    cell.border = { top: line, left: line, bottom: line, right: line };
  }
  if (s.numFmt) cell.numFmt = s.numFmt;
}

type CellInput = string | number | null;

function put(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: CellInput,
  style?: CellStyle
) {
  const cell = ws.getCell(row, col);
  cell.value = value === null ? '' : value;
  paint(cell, style);
  return cell;
}

/* -------------------------------------------------------------------------
   Công thức Excel
   -------------------------------------------------------------------------
   Ô nào là SỐ NGUỒN thì ghi giá trị, ô nào là SỐ DẪN XUẤT thì ghi CÔNG THỨC.
   Nhờ vậy người dùng mở file lên sửa một ô số suất hay một ô đơn giá là mọi
   dòng tổng, thành tiền và tổng thanh toán tự tính lại — thay vì phải bấm máy
   tính rồi sửa tay từng ô.

   Luôn kèm `result` (giá trị đã tính sẵn): trình xem không tự tính công thức
   — xem trước trong Windows, Google Sheets nhập thô, thư viện đọc file — vẫn
   thấy đúng số thay vì ô trống. */

/** Số cột -> chữ cột Excel: 1 -> A, 27 -> AA. */
function colLetter(col: number): string {
  let n = col;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Địa chỉ một ô, vd (5, 3) -> "C5". `abs` để khoá khi kéo công thức. */
const addr = (row: number, col: number, abs = false) =>
  `${abs ? '$' : ''}${colLetter(col)}${abs ? '$' : ''}${row}`;

/** Vùng ô trên cùng một dòng, vd "C5:H5". */
const rowRange = (row: number, c1: number, c2: number, abs = false) =>
  `${addr(row, c1, abs)}:${addr(row, c2, abs)}`;

/** Vùng ô trên cùng một cột, vd "C5:C40". */
const colRange = (col: number, r1: number, r2: number, abs = false) =>
  `${addr(r1, col, abs)}:${addr(r2, col, abs)}`;

/** Ghi một ô công thức, kèm giá trị đã tính sẵn. */
function formula(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  f: string,
  result: number,
  style?: CellStyle
) {
  const cell = ws.getCell(row, col);
  cell.value = { formula: f, result: Number.isFinite(result) ? result : 0 };
  paint(cell, style);
  return cell;
}

/**
 * `=SUM(...)` từ một danh sách ô/vùng rời rạc. Bỏ qua danh sách rỗng (Excel
 * báo lỗi cú pháp với `SUM()`), khi đó ghi số 0 thường.
 */
function sumOf(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  parts: string[],
  result: number,
  style?: CellStyle
) {
  if (parts.length === 0) return put(ws, row, col, result || '', style);
  return formula(ws, row, col, `SUM(${parts.join(',')})`, result, style);
}

/**
 * Ô gộp. Excel chỉ giữ viền của những ô con nên phải tô cả vùng, nếu không
 * ô gộp sẽ hở viền ở các cạnh trong.
 */
function block(
  ws: ExcelJS.Worksheet,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  value: CellInput,
  style?: CellStyle
) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) paint(ws.getCell(r, c), style);
  }
  if (r1 !== r2 || c1 !== c2) ws.mergeCells(r1, c1, r2, c2);
  ws.getCell(r1, c1).value = value === null ? '' : value;
}

/** Hai dòng tiêu đề đầu sheet, dịch từ khối header trắng của mỗi bảng web. */
function sheetHeading(
  ws: ExcelJS.Worksheet,
  lastCol: number,
  title: string,
  subtitle: string
) {
  const base: CellStyle = { fill: C.slate50, align: 'left', noBorder: true };
  block(ws, 1, 1, 1, lastCol, title, {
    ...base,
    bold: true,
    size: 14,
    font: C.slate900,
  });
  block(ws, 2, 1, 2, lastCol, subtitle, { ...base, size: 10, font: C.slate600 });
  ws.getRow(1).height = 26;
  ws.getRow(2).height = 17;
}

/** Dòng ghi chú chân bảng — bản dịch của dải xám dưới mỗi bảng web. */
function sheetFootnote(
  ws: ExcelJS.Worksheet,
  row: number,
  lastCol: number,
  text: string
) {
  block(ws, row, 1, row, lastCol, text, {
    fill: C.slate50,
    font: C.slate600,
    size: 10,
    align: 'left',
    noBorder: true,
    wrap: true,
  });
  ws.getRow(row).height = 32;
}

const setWidths = (ws: ExcelJS.Worksheet, widths: number[]) =>
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

/** Hàng tiêu đề bảng bắt đầu ngay dưới hai dòng tiêu đề sheet + một dòng trống. */
const TABLE_TOP = 4;

/* -------------------------------------------------------------------------
   Sheet 1 — Thống kê suất ăn tháng
   ------------------------------------------------------------------------- */

const STAT_ROW_FILL: Record<StatRowTone, CellStyle> = {
  korea: { fill: C.orange50 },
  viet: { fill: C.emerald50 },
  sub: { fill: C.white, font: C.slate600 },
  total: { fill: C.amber100, bold: true },
  birthday: { fill: C.sky100, bold: true },
  milk: { fill: C.indigo50 },
  extra: { fill: C.violet50 },
  labor: { fill: C.teal50 },
};

const STAT_GROUP_FILL: Record<StatGroupTone, CellStyle> = {
  korea: { fill: C.orange200, font: C.orange950 },
  viet: { fill: C.emerald200, font: C.emerald950 },
  milk: { fill: C.indigo100, font: C.indigo900 },
  extra: { fill: C.violet100, font: C.violet900 },
  labor: { fill: C.teal100, font: C.teal900 },
  birthday: { fill: C.sky200, font: C.sky950 },
};

function buildStatsSheet(
  ws: ExcelJS.Worksheet,
  ctx: WorkbookContext
) {
  const { days, startDate, endDate } = ctx;
  const rows = buildMonthlyStatRows(
    ctx.classified,
    ctx.pricing,
    ctx.shiftCategories,
    ctx.manualMeals,
    ctx.milkEntries,
    ctx.extraCosts,
    ctx.laborSegments,
    ctx.laborWorkDayRule
  );
  const grandTotal = statRowsGrandTotal(rows);

  /* Dải cột ngày là MỘT TẦNG PHẲNG: khối Sữa / Chi phí phát sinh tách theo
     ca bằng hai DÒNG con chứ không bằng cột con, giống hệt bảng trên web. */
  const headBottom = TABLE_TOP;

  const colTotal = 3 + days.length;
  const colPrice = colTotal + 1;
  const colAmount = colTotal + 2;
  const colNote = colTotal + 3;
  const lastCol = colNote;

  setWidths(ws, [24, 17, ...days.map(() => 5.4), 10, 12, 17, 20]);

  sheetHeading(
    ws,
    lastCol,
    `Bảng kê suất ăn — ${startDate} → ${endDate}`,
    'Mỗi cột là một ngày; ca đêm 22:50 → 01:50 được tính trọn cho ngày kết thúc ca, tức ngày hôm sau. Khối Sữa và Chi phí phát sinh có hai dòng con Ca ngày / Ca đêm ở cột DATE, mỗi dòng mang đơn giá và thành tiền riêng của ca đó. Suất sinh nhật được tách khỏi số suất của từng ca. Đơn giá mỗi dòng là giá của loại suất ghi ngay dưới tên ca.'
  );

  const head: CellStyle = { fill: C.slate700, font: C.white, bold: true, border: C.slate600 };
  block(ws, TABLE_TOP, 1, headBottom, 1, 'HẠNG MỤC', head);
  block(ws, TABLE_TOP, 2, headBottom, 2, 'DATE', head);

  days.forEach((d, i) => put(ws, TABLE_TOP, 3 + i, Number(dayLabel(d)), head));

  block(ws, TABLE_TOP, colTotal, headBottom, colTotal, 'TOTAL', { ...head, fill: C.slate800 });
  block(ws, TABLE_TOP, colPrice, headBottom, colPrice, 'ĐƠN GIÁ', { ...head, fill: C.slate800 });
  block(ws, TABLE_TOP, colAmount, headBottom, colAmount, 'AMOUNT', { ...head, fill: C.emerald700 });
  block(ws, TABLE_TOP, colNote, headBottom, colNote, 'NOTE', { ...head, fill: C.slate800 });
  ws.getRow(TABLE_TOP).height = 22;

  /* Sổ ghi: mỗi StatRow nằm ở dòng Excel nào, và dòng tổng của một nhóm gồm
     những dòng nào — để dựng công thức cộng dọc. */
  const rowAt = new Map<string, number>();
  const groupMembers = new Map<string, number[]>();
  {
    let probe = headBottom + 1;
    /* `pending`, không đặt tên `block` — trùng tên hàm vẽ ô gộp ở trên. */
    let pending: number[] = [];
    rows.forEach((row) => {
      if (row.tone === 'total') {
        groupMembers.set(row.key, pending);
        pending = [];
      } else if (
        row.groupLabel !== undefined &&
        row.groupTone !== 'milk' &&
        row.groupTone !== 'extra' &&
        row.groupTone !== 'labor'
      ) {
        pending = [probe];
      } else {
        pending.push(probe);
      }
      probe += 1;
    });
  }

  let r = headBottom + 1;
  rows.forEach((row) => {
    const tone = STAT_ROW_FILL[row.tone];
    const isGroupTotal = row.tone === 'total';
    const members = isGroupTotal ? (groupMembers.get(row.key) ?? []) : [];

    if (row.groupLabel !== undefined) {
      const span = row.groupSpan ?? 1;
      block(ws, r, 1, r + span - 1, 1, row.groupLabel, {
        ...(row.groupTone ? STAT_GROUP_FILL[row.groupTone] : { fill: C.slate100 }),
        bold: true,
        wrap: true,
      });
    }

    /* Tên ca và loại suất quyết định đơn giá đi chung một ô, xuống dòng như
       dòng chú thích nhỏ trên web. */
    put(
      ws,
      r,
      2,
      row.subLabel ? `${row.label}\n${row.subLabel}` : row.label,
      { ...tone, bold: true, font: tone.font ?? C.slate700, align: 'left', wrap: true }
    );
    if (row.subLabel) ws.getRow(r).height = 30;

    days.forEach((d, i) => {
      const dc = 3 + i;
      /* Dòng tổng nhóm: ô ngày cũng cộng dọc, để sửa một ô ngày của dòng ca
         là dòng tổng đổi theo. */
      if (isGroupTotal && members.length > 0) {
        sumOf(
          ws,
          r,
          dc,
          members.map((m) => addr(m, dc)),
          row.series?.byDay[d] ?? 0,
          { ...tone, numFmt: NUM_FMT.int }
        );
      } else {
        put(ws, r, dc, row.series?.byDay[d] ?? '', { ...tone, numFmt: NUM_FMT.int });
      }
    });

    /* TOTAL = cộng ngang các ô ngày. Dòng tổng của nhóm thì cộng dọc các
       dòng thành viên — xử lý ngay bên dưới. */
    const memberRows = row.tone === 'total' ? (groupMembers.get(row.key) ?? []) : [];

    if (memberRows.length > 0) {
      sumOf(
        ws,
        r,
        colTotal,
        memberRows.map((m) => addr(m, colTotal)),
        row.quantity,
        { ...tone, fill: C.slate50, bold: true, numFmt: NUM_FMT.int }
      );
    } else {
      formula(
        ws,
        r,
        colTotal,
        `SUM(${rowRange(r, 3, colTotal - 1)})`,
        row.quantity,
        { ...tone, fill: C.slate50, bold: true, numFmt: NUM_FMT.int }
      );
    }

    put(ws, r, colPrice, row.unitPrice ?? '', { ...tone, numFmt: NUM_FMT.int });

    const amountStyle: CellStyle = {
      ...tone,
      bold: true,
      align: 'right',
      numFmt: NUM_FMT.vnd,
    };
    if (memberRows.length > 0) {
      /* Dòng tổng nhóm trộn nhiều đơn giá nên không có một đơn giá chung —
         cộng dọc thành tiền của các dòng thành viên. */
      sumOf(
        ws,
        r,
        colAmount,
        memberRows.map((m) => addr(m, colAmount)),
        row.amount,
        amountStyle
      );
    } else if (row.unitPrice !== null) {
      /* AMOUNT = TOTAL × ĐƠN GIÁ: sửa số suất hay sửa đơn giá là tiền tự đổi. */
      formula(
        ws,
        r,
        colAmount,
        `${addr(r, colTotal)}*${addr(r, colPrice)}`,
        row.amount,
        amountStyle
      );
    } else {
      put(ws, r, colAmount, row.amount || '', amountStyle);
    }

    put(ws, r, colNote, row.note ?? '', { ...tone, align: 'left', wrap: true });

    rowAt.set(row.key, r);
    r += 1;
  });

  const footer: CellStyle = { fill: C.slate800, font: C.white, bold: true, border: C.slate600 };
  block(ws, r, 1, r, 2, 'TOTAL', { ...footer, align: 'left' });
  block(ws, r, 3, r, colPrice, '', footer);

  /* Tổng thanh toán = cộng các dòng KHÔNG phải dòng tổng nhóm, để không cộng
     đôi. Hai dòng tổng nhóm bản thân đã là tổng của khối nên dùng luôn chúng
     thay cho từng dòng ca — công thức ngắn và người đọc hiểu ngay. */
  const grandParts: string[] = [];
  const seenGroups = new Set<string>();
  rows.forEach((row) => {
    const at = rowAt.get(row.key);
    if (at === undefined) return;
    if (row.tone === 'total') {
      grandParts.push(addr(at, colAmount));
      (groupMembers.get(row.key) ?? []).forEach((m) => seenGroups.add(String(m)));
    }
  });
  rows.forEach((row) => {
    const at = rowAt.get(row.key);
    if (at === undefined || row.tone === 'total') return;
    if (seenGroups.has(String(at))) return;
    grandParts.push(addr(at, colAmount));
  });

  sumOf(ws, r, colAmount, grandParts, grandTotal, {
    ...footer,
    fill: C.amber500,
    font: C.slate900,
    align: 'right',
    numFmt: NUM_FMT.vnd,
  });
  put(ws, r, colNote, '', footer);
  ws.getRow(r).height = 22;

  sheetFootnote(
    ws,
    r + 2,
    lastCol,
    'Suất nhập tay lấy từ tab Nhập Thủ Công Ca, và vào bảng theo nhóm nhân sự đã chọn khi nhập: suất người Việt thành dòng "Ký số" riêng dưới dòng ca, suất người Hàn cộng thẳng vào dòng ca của khối 한국 đúng ca và đúng ngày, không có dòng Ký số. Đơn giá từng ca lấy theo loại suất đang gán cho cặp (ca × nhóm nhân sự) trong tab Cấu Hình Giá Suất Ăn — nên cùng một ca có thể là cơm Hàn ở khối người Hàn và bữa phụ ở khối người Việt. Mỳ Hàn nằm ngay trong dòng ca của nó, không tách thành dòng riêng.'
  );

  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: headBottom }];
}

/* -------------------------------------------------------------------------
   Sheet 2 — Phân bổ theo BP
   ------------------------------------------------------------------------- */

const CATEGORY_HEAD: Record<MealCategory, CellStyle> = {
  KO_COM: { fill: C.headKoCom, font: C.textRed200 },
  KO_MY: { fill: C.headKoMy, font: C.textOrange200 },
  VN_CHINH: { fill: C.headVnChinh, font: C.textBlue200 },
  VN_PHU: { fill: C.headVnPhu, font: C.textSky200 },
  VN_SINHNHAT: { fill: C.headVnSinhNhat, font: C.textPink200 },
};

const CATEGORY_CELL_FONT: Record<MealCategory, string> = {
  KO_COM: C.red700,
  KO_MY: C.orange700,
  VN_CHINH: C.indigo700,
  VN_PHU: C.sky700,
  VN_SINHNHAT: C.pink700,
};

function buildDeptSheet(ws: ExcelJS.Worksheet, ctx: WorkbookContext) {
  const data = buildDeptAllocation(
    ctx.classified,
    ctx.manualMeals,
    ctx.largeDeptOptions,
    ctx.pricing
  );
  /* Suất sinh nhật mỗi ngày một giá, nên dòng đơn giá của sheet phải là bộ
     giá mà `buildDeptAllocation` vừa dùng để tính tiền — lấy `ctx.pricing`
     thì SUMPRODUCT trong file Excel nhân ra một tổng khác dòng TỔNG CỘNG. */
  const unitPrices = buildCategoryUnitPrices(
    ctx.classified,
    ctx.manualMeals,
    ctx.pricing
  );
  const categoryTotals = CATEGORY_COLUMNS.reduce(
    (acc, cat) => {
      acc[cat] = data.reduce((sum, d) => sum + d.counts[cat], 0);
      return acc;
    },
    {} as Record<MealCategory, number>
  );
  const totalMeals = data.reduce((acc, d) => acc + d.totalMeals, 0);
  const totalAmount = data.reduce((acc, d) => acc + d.totalAmount, 0);

  const colTotalMeals = 2 + CATEGORY_COLUMNS.length;
  const colAmount = colTotalMeals + 1;
  const lastCol = colAmount;

  setWidths(ws, [22, ...CATEGORY_COLUMNS.map(() => 15), 14, 20]);

  sheetHeading(
    ws,
    lastCol,
    'Bảng báo cáo phân bổ tiền ăn cho các bộ phận',
    `Áp dụng từ ${ctx.startDate} → ${ctx.endDate}`
  );

  const head: CellStyle = { fill: C.slate900, font: C.white, bold: true, border: C.slate700 };
  block(ws, TABLE_TOP, 1, TABLE_TOP + 1, 1, 'Bộ Phận', { ...head, align: 'left' });
  CATEGORY_COLUMNS.forEach((c, i) => {
    const tone = CATEGORY_HEAD[c];
    put(ws, TABLE_TOP, 2 + i, MEAL_CATEGORY_META[c].label, {
      ...tone,
      bold: true,
      border: C.slate700,
    });
    /* Ghi ĐƠN GIÁ THẬT chứ không phải chuỗi "65K": định dạng số
       `#,##0,"K"` vẫn hiện đúng chữ 65K, nhưng ô là một con số nên cột Thành
       Tiền tham chiếu được — sửa đơn giá ở đây là cả cột tiền tự tính lại. */
    put(ws, TABLE_TOP + 1, 2 + i, unitPrices[c], {
      ...tone,
      size: 10,
      border: C.slate700,
      numFmt: NUM_FMT.thousandK,
    });
  });
  block(ws, TABLE_TOP, colTotalMeals, TABLE_TOP + 1, colTotalMeals, 'Tổng Suất Ăn', {
    ...head,
    fill: C.slate800,
    wrap: true,
  });
  block(ws, TABLE_TOP, colAmount, TABLE_TOP + 1, colAmount, 'Thành Tiền (VNĐ)', {
    ...head,
    fill: C.emerald600,
    font: C.slate900,
    wrap: true,
  });

  /** Dòng chứa đơn giá từng loại suất — công thức Thành Tiền trỏ về đây. */
  const priceRow = TABLE_TOP + 1;

  let r = TABLE_TOP + 2;
  data.forEach((d) => {
    put(ws, r, 1, d.deptName, { bold: true, align: 'left' });
    CATEGORY_COLUMNS.forEach((c, i) => {
      const v = d.counts[c];
      put(ws, r, 2 + i, v || '', {
        font: v > 0 ? CATEGORY_CELL_FONT[c] : C.slate500,
        bold: v > 0,
        numFmt: NUM_FMT.int,
      });
    });
    formula(
      ws,
      r,
      colTotalMeals,
      `SUM(${rowRange(r, 2, colTotalMeals - 1)})`,
      d.totalMeals,
      { fill: C.slate50, bold: true, numFmt: NUM_FMT.int }
    );
    /* Thành tiền = tích vô hướng số suất × dòng đơn giá (khoá bằng $ để kéo
       công thức xuống các dòng dưới vẫn trỏ đúng dòng đơn giá). */
    formula(
      ws,
      r,
      colAmount,
      `SUMPRODUCT(${rowRange(r, 2, colTotalMeals - 1)},${rowRange(
        priceRow,
        2,
        colTotalMeals - 1,
        true
      )})`,
      d.totalAmount,
      { bold: true, align: 'right', numFmt: NUM_FMT.vnd }
    );
    r += 1;
  });

  const firstDataRow = TABLE_TOP + 2;
  const lastDataRow = r - 1;
  const hasData = lastDataRow >= firstDataRow;

  const footer: CellStyle = { fill: C.slate900, font: C.white, bold: true, border: C.slate700 };
  put(ws, r, 1, 'TỔNG CỘNG PHÂN BỔ', { ...footer, align: 'left' });
  CATEGORY_COLUMNS.forEach((c, i) => {
    const col = 2 + i;
    const style: CellStyle = { ...footer, font: C.white, numFmt: NUM_FMT.int };
    if (hasData) {
      formula(
        ws,
        r,
        col,
        `SUM(${colRange(col, firstDataRow, lastDataRow)})`,
        categoryTotals[c],
        style
      );
    } else {
      put(ws, r, col, categoryTotals[c], style);
    }
  });

  const footTotal = (col: number, value: number, style: CellStyle) =>
    hasData
      ? formula(ws, r, col, `SUM(${colRange(col, firstDataRow, lastDataRow)})`, value, style)
      : put(ws, r, col, value, style);

  footTotal(colTotalMeals, totalMeals, {
    ...footer,
    font: C.amber500,
    numFmt: NUM_FMT.int,
  });
  footTotal(colAmount, totalAmount, {
    ...footer,
    font: C.emerald400,
    align: 'right',
    numFmt: NUM_FMT.vnd,
  });
  const mealAmountCell = addr(r, colAmount);
  ws.getRow(r).height = 22;

  /* Đối chiếu với sheet "Thống kê suất ăn tháng": bảng này chỉ có tiền suất
     ăn, chênh lệch giữa hai sheet đúng bằng tiền sữa. */
  const totals = reconcileCost(
    data,
    ctx.milkEntries,
    ctx.extraCosts,
    ctx.laborSegments
  );

  /** Ô thành tiền của các dòng không phân bổ (sữa, phát sinh). */
  const supplyAmountCells: string[] = [];

  r += 1;
  const milkTone: CellStyle = { fill: C.slate100, font: C.slate700, bold: true };
  block(ws, r, 1, r, colTotalMeals - 1, 'Tiền sữa — cấp theo ngày, không phân bổ cho bộ phận nào', {
    ...milkTone,
    align: 'left',
  });
  put(ws, r, colTotalMeals, totals.milkCount, { ...milkTone, numFmt: NUM_FMT.int });
  put(ws, r, colAmount, totals.milkAmount, {
    ...milkTone,
    font: C.indigo900,
    align: 'right',
    numFmt: NUM_FMT.vnd,
  });
  supplyAmountCells.push(addr(r, colAmount));

  if (totals.extraCount > 0 || totals.extraAmount > 0) {
    r += 1;
    const extraTone: CellStyle = { fill: C.violet50, font: C.violet900, bold: true };
    block(ws, r, 1, r, colTotalMeals - 1, 'Chi phí phát sinh — cấp theo ngày, không phân bổ cho bộ phận nào', {
      ...extraTone,
      align: 'left',
    });
    put(ws, r, colTotalMeals, totals.extraCount, { ...extraTone, numFmt: NUM_FMT.int });
    put(ws, r, colAmount, totals.extraAmount, {
      ...extraTone,
      align: 'right',
      numFmt: NUM_FMT.vnd,
    });
    supplyAmountCells.push(addr(r, colAmount));
  }

  /* Chi phí nhân công — cùng lý do với hai dòng trên: không có bộ phận thụ
     hưởng nào để gánh, nên nó là dòng đối chiếu chứ không phải một cột của
     bảng phân bổ. Ô "số lượng" là NGÀY CÔNG, không phải số suất ăn. */
  if (totals.laborDays > 0 || totals.laborAmount > 0) {
    r += 1;
    const laborTone: CellStyle = { fill: C.teal50, font: C.teal900, bold: true };
    block(ws, r, 1, r, colTotalMeals - 1, 'Chi phí nhân công — thuê theo đợt, không phân bổ cho bộ phận nào', {
      ...laborTone,
      align: 'left',
    });
    put(ws, r, colTotalMeals, totals.laborDays, { ...laborTone, numFmt: NUM_FMT.int });
    put(ws, r, colAmount, totals.laborAmount, {
      ...laborTone,
      align: 'right',
      numFmt: NUM_FMT.vnd,
    });
    supplyAmountCells.push(addr(r, colAmount));
  }

  r += 1;
  const payTone: CellStyle = { fill: C.amber100, bold: true };
  block(ws, r, 1, r, colTotalMeals, 'TỔNG THANH TOÁN (khớp với sheet "Thống kê suất ăn tháng")', {
    ...payTone,
    align: 'left',
  });
  /* = tiền suất ăn + tiền sữa + chi phí phát sinh, cộng thẳng ba ô ngay trên. */
  sumOf(ws, r, colAmount, [mealAmountCell, ...supplyAmountCells], totals.grandTotal, {
    ...payTone,
    align: 'right',
    size: 12,
    numFmt: NUM_FMT.vnd,
  });
  ws.getRow(r).height = 22;

  sheetFootnote(
    ws,
    r + 2,
    lastCol,
    'Người Hàn = thuộc bộ phận lớn KR, tính giá suất Hàn dù chấm ở máy nào. Các bộ phận còn lại luôn tính giá suất người Việt, kể cả khi chấm ở máy CT Korea. Loại suất của từng ca lấy theo tab Cấu Hình Giá Suất Ăn; suất của người Việt vào ngày sinh nhật tập thể tính giá suất đặc biệt. Bảng đã gồm cả suất nhập ở tab Nhập Thủ Công Ca, tính vào bộ phận thụ hưởng đã ghi khi nhập. Dòng TỔNG CỘNG PHÂN BỔ chỉ là tiền suất ăn — sữa và chi phí phát sinh cấp theo ngày nên không chia được cho bộ phận nào; dòng TỔNG THANH TOÁN mới là con số khớp với TOTAL của sheet "Thống kê suất ăn tháng".'
  );

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: TABLE_TOP + 1 }];
}

/* -------------------------------------------------------------------------
   Sheet 3 — Total suất ăn (12 tháng)
   ------------------------------------------------------------------------- */

/** '#2a78d6' -> 'FF2A78D6'. */
const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;

function buildYearlySheet(ws: ExcelJS.Worksheet, ctx: WorkbookContext) {
  const { monthlyCosts, trendYear } = ctx;
  const colSum = 2 + YEARLY_SERIES.length + 1;
  const lastCol = colSum;

  setWidths(ws, [11, 13, ...YEARLY_SERIES.map(() => 17), 18]);

  sheetHeading(
    ws,
    lastCol,
    `Total suất ăn — số liệu chi tiết 12 tháng năm ${trendYear}`,
    'Mỗi tháng gồm hai dòng: số suất ở trên, thành tiền ở dưới.'
  );

  if (monthlyCosts.length === 0) {
    block(ws, TABLE_TOP, 1, TABLE_TOP, lastCol, `Không có số liệu chi phí cho năm ${trendYear}.`, {
      fill: C.white,
      font: C.slate500,
      align: 'left',
      noBorder: true,
    });
    return;
  }

  const head: CellStyle = { fill: C.slate900, font: C.white, bold: true, border: C.slate700 };
  put(ws, TABLE_TOP, 1, 'Tháng', { ...head, align: 'left' });
  put(ws, TABLE_TOP, 2, 'Chỉ tiêu', { ...head, align: 'left' });
  YEARLY_SERIES.forEach((s, i) => {
    const cell = put(ws, TABLE_TOP, 3 + i, s.name, { ...head, align: 'right' });
    /* Ô vuông màu cạnh tên cột trên web không có tương đương trong Excel —
       thay bằng dải màu dày ở cạnh dưới ô tiêu đề, vẫn nhận ra series. */
    cell.border = {
      ...cell.border,
      bottom: { style: 'thick', color: { argb: argb(s.color) } },
    };
  });
  put(ws, TABLE_TOP, colSum, 'Tổng tháng', {
    ...head,
    fill: C.emerald600,
    font: C.slate900,
    align: 'right',
  });
  ws.getRow(TABLE_TOP).height = 22;

  /** Dòng "THÀNH TIỀN" của từng tháng — dòng CẢ NĂM cộng dọc theo danh sách này. */
  const amountRows: number[] = [];

  let r = TABLE_TOP + 1;
  monthlyCosts.forEach((row) => {
    block(ws, r, 1, r + 1, 1, row.costMonth, { bold: true, align: 'left' });

    // Dòng số suất
    put(ws, r, 2, 'SỐ SUẤT', { fill: C.slate50, font: C.slate600, size: 10, bold: true, align: 'left' });
    YEARLY_SERIES.forEach((s, i) => {
      const count = s.countKey ? yearlyValue(row, s.countKey) : null;
      put(ws, r, 3 + i, count === null ? '—' : count || '', {
        fill: C.slate50,
        font: count ? C.slate800 : C.slate500,
        align: 'right',
        numFmt: NUM_FMT.int,
      });
    });
    put(ws, r, colSum, '', { fill: C.emerald50 });

    // Dòng thành tiền
    put(ws, r + 1, 2, 'THÀNH TIỀN', { font: C.slate600, size: 10, bold: true, align: 'left' });
    YEARLY_SERIES.forEach((s, i) => {
      const value = yearlyValue(row, s.key);
      put(ws, r + 1, 3 + i, value || '', {
        font: value ? C.slate900 : C.slate500,
        align: 'right',
        numFmt: NUM_FMT.vnd,
      });
    });
    /* Tổng tháng = cộng ngang các cột thành tiền của chính tháng đó. */
    formula(
      ws,
      r + 1,
      colSum,
      `SUM(${rowRange(r + 1, 3, colSum - 1)})`,
      row.Sum,
      { fill: C.emerald50, bold: true, align: 'right', numFmt: NUM_FMT.vnd }
    );

    amountRows.push(r + 1);
    r += 2;
  });

  const yearSum = (pick: (row: MonthlyCostRow) => number) =>
    monthlyCosts.reduce((acc, row) => acc + pick(row), 0);

  const footer: CellStyle = { fill: C.slate900, font: C.white, bold: true, border: C.slate700 };
  block(ws, r, 1, r, 2, 'CẢ NĂM', { ...footer, align: 'left' });
  YEARLY_SERIES.forEach((s, i) =>
    sumOf(
      ws,
      r,
      3 + i,
      amountRows.map((m) => addr(m, 3 + i)),
      yearSum((row) => yearlyValue(row, s.key)),
      { ...footer, font: C.white, align: 'right', numFmt: NUM_FMT.vnd }
    )
  );
  sumOf(
    ws,
    r,
    colSum,
    amountRows.map((m) => addr(m, colSum)),
    yearSum((row) => row.Sum),
    { ...footer, font: C.emerald400, align: 'right', numFmt: NUM_FMT.vnd }
  );
  ws.getRow(r).height = 22;

  sheetFootnote(
    ws,
    r + 2,
    lastCol,
    'Cột Sữa và Chi Phí Phát Sinh lấy theo tiền đã nhập ở tab Quản Lý Sữa nên không có số suất tương ứng. Cột Chi Phí Nhân Công là tiền của lượt "Áp dụng" đang có hiệu lực, chia theo ngày làm việc rồi cắt vào từng tháng.'
  );

  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: TABLE_TOP }];
}

/* -------------------------------------------------------------------------
   Sheet 4 — Phân bổ tiền ăn
   ------------------------------------------------------------------------- */

const ALLOCATION_TONE: Record<AllocationTone, CellStyle> = {
  korea: { fill: C.orange100, font: C.orange900 },
  koreaSub: { fill: C.orange50, font: C.orange800 },
  viet: { fill: C.emerald50, font: C.emerald950 },
  milk: { fill: C.indigo50, font: C.indigo900 },
  extra: { fill: C.violet50, font: C.violet900 },
  labor: { fill: C.teal50, font: C.teal900 },
  birthday: { fill: C.green100, font: C.green900 },
};

function buildAllocationSheet(ws: ExcelJS.Worksheet, ctx: WorkbookContext) {
  const columns = buildAllocationColumns(
    ctx.classified,
    ctx.pricing,
    ctx.shiftCategories,
    ctx.manualMeals,
    ctx.milkEntries,
    ctx.extraCosts,
    ctx.laborSegments
  );
  const groups = allocationHeaderGroups(columns);
  const amountOf = (c: (typeof columns)[number]) => c.quantity * c.unitPrice;
  const grandTotal = columns.reduce((acc, c) => acc + amountOf(c), 0);

  const colSum = 2 + columns.length + 1;
  const lastCol = colSum;

  setWidths(ws, [13, 20, ...columns.map(() => 14), 22]);

  sheetHeading(
    ws,
    lastCol,
    `Bảng phân bổ tiền ăn — ${ctx.startDate} → ${ctx.endDate}`,
    'Suất sinh nhật đứng riêng một cột, không cộng vào số suất của từng ca.'
  );

  const head: CellStyle = { fill: C.slate700, font: C.white, bold: true, border: C.slate600 };
  block(ws, TABLE_TOP, 1, TABLE_TOP + 1, 2, 'No.', { ...head, align: 'left' });

  let c = 3;
  groups.forEach((g) => {
    block(ws, TABLE_TOP, c, TABLE_TOP, c + g.span - 1, g.group, head);
    c += g.span;
  });
  block(ws, TABLE_TOP, colSum, TABLE_TOP + 1, colSum, '지불 합계\nTổng thanh toán', {
    ...head,
    fill: C.slate800,
    wrap: true,
  });

  columns.forEach((col, i) =>
    put(ws, TABLE_TOP + 1, 3 + i, col.label, {
      ...ALLOCATION_TONE[col.tone],
      bold: true,
    })
  );
  ws.getRow(TABLE_TOP).height = 22;
  ws.getRow(TABLE_TOP + 1).height = 22;

  const rQty = TABLE_TOP + 2;
  const rPrice = rQty + 1;
  const rAmount = rQty + 2;

  block(ws, rQty, 1, rAmount, 1, 'Ngày\nthường', {
    fill: C.slate50,
    font: C.slate700,
    bold: true,
    wrap: true,
  });
  /* Ô gộp: tô cả vùng rồi đặt công thức vào ô góc trên trái. Tổng thanh toán
     = cộng ngang dòng Thành tiền. */
  block(ws, rQty, colSum, rAmount, colSum, null, {
    fill: C.amber100,
    bold: true,
    size: 13,
    align: 'right',
    numFmt: NUM_FMT.vnd,
  });
  if (columns.length > 0) {
    ws.getCell(rQty, colSum).value = {
      formula: `SUM(${rowRange(rAmount, 3, colSum - 1)})`,
      result: grandTotal,
    };
  } else {
    ws.getCell(rQty, colSum).value = grandTotal;
  }

  put(ws, rQty, 2, '수가 / Số lượng', { fill: C.white, font: C.slate700, bold: true, align: 'left' });
  put(ws, rPrice, 2, '가격 / Đơn giá', { fill: C.slate50, font: C.slate700, bold: true, align: 'left' });
  put(ws, rAmount, 2, '합계 / Thành tiền', { fill: C.white, font: C.slate700, bold: true, align: 'left' });

  columns.forEach((col, i) => {
    put(ws, rQty, 3 + i, col.quantity, {
      fill: C.white,
      bold: true,
      numFmt: NUM_FMT.int,
    });
    /* Ghi đơn giá NGUYÊN VẸN, không làm tròn — cột Sữa và Chi phí phát sinh
       là đơn giá bình quân nên có phần lẻ. Làm tròn ở đây thì công thức
       Thành tiền = SL × ĐG lệch khỏi số tiền thật vài trăm đồng, và tổng của
       sheet này không còn khớp TOTAL của sheet "Thống kê suất ăn tháng".
       Định dạng số vẫn hiện tròn nên nhìn không đổi. */
    put(ws, rPrice, 3 + i, col.unitPrice, {
      fill: C.slate50,
      font: C.slate700,
      numFmt: NUM_FMT.int,
    });
    /* Thành tiền = Số lượng × Đơn giá, hai ô ngay trên. */
    formula(
      ws,
      rAmount,
      3 + i,
      `${addr(rQty, 3 + i)}*${addr(rPrice, 3 + i)}`,
      amountOf(col),
      { ...ALLOCATION_TONE[col.tone], bold: true, align: 'right', numFmt: NUM_FMT.vnd }
    );
  });

  sheetFootnote(
    ws,
    rAmount + 2,
    lastCol,
    'Cột từng ca của người Việt đã gộp cả suất ký số (Nhập Thủ Công Ca) của ca đó; suất Hàn nhập tay gộp vào cột Cơm Hàn / Mì Hàn theo loại suất của ca.'
  );
}

/* -------------------------------------------------------------------------
   Sheet 5..10 — chi tiết từng ca (23H_CA1 … 19H_CA6)
   ------------------------------------------------------------------------- */

function buildShiftSheet(
  ws: ExcelJS.Worksheet,
  ctx: WorkbookContext,
  shiftCode: ShiftCode
) {
  const { days } = ctx;
  const pivot = buildShiftPivot(ctx.classified, ctx.manualMeals, shiftCode);
  const alias = reportShiftLabel(shiftCode);
  const dbAlias = shiftAlias(ctx.shifts, shiftCode);
  const timeWindow = shiftWindow(ctx.shifts, shiftCode);

  const firstDayCol = 5;
  const colTotal = firstDayCol + days.length;
  const lastCol = colTotal;

  setWidths(ws, [6.5, 28, 17, 15, ...days.map(() => 5.4), 12]);

  sheetHeading(
    ws,
    lastCol,
    `Bảng kê suất ăn ca ${alias}${dbAlias !== alias ? ` / ${dbAlias}` : ''} — ${shiftCode}${
      timeWindow ? `  ${timeWindow}` : ''
    }`,
    `Từ ngày ${ctx.startDate} đến ${ctx.endDate} • Hiển thị tất cả các nhà ăn • Mỗi cột là một ngày, ô là số lần quẹt.`
  );

  const head: CellStyle = { fill: C.slate700, font: C.white, bold: true, border: C.slate600 };
  ['STT', 'Họ Tên', 'Mã Nhân Viên', 'Phòng ban'].forEach((h, i) =>
    put(ws, TABLE_TOP, i + 1, h, { ...head, align: 'left' })
  );
  /* Khoảng lọc gõ ngược (từ > đến) cho ra 0 cột ngày; khi đó không có gì để
     gộp, `mergeCells` với c2 < c1 sẽ ném lỗi. */
  if (days.length > 0) {
    block(ws, TABLE_TOP, firstDayCol, TABLE_TOP, colTotal - 1, 'Số lần ăn', head);
  }
  put(ws, TABLE_TOP, colTotal, 'Tổng Cộng', { ...head, fill: C.slate800, wrap: true });

  const subHead: CellStyle = { fill: C.slate100, font: C.slate700, bold: true };
  for (let i = 1; i <= 4; i++) put(ws, TABLE_TOP + 1, i, '', subHead);
  days.forEach((d, i) => put(ws, TABLE_TOP + 1, firstDayCol + i, Number(dayLabel(d)), subHead));
  /* Ô này lặp lại tổng cả ca; điền công thức sau khi biết dòng tổng nằm đâu. */
  const headerGrandCell = put(ws, TABLE_TOP + 1, colTotal, pivot.grandTotal, {
    ...subHead,
    fill: C.amber100,
    numFmt: NUM_FMT.int,
  });

  /** Vùng dòng nhân viên, để dòng TỔNG THEO NGÀY cộng dọc. */
  const firstEmployeeRow = TABLE_TOP + 2;

  let r = TABLE_TOP + 2;
  pivot.rows.forEach((row, i) => {
    // Dòng chẵn/lẻ so le như bảng web (`even:bg-slate-50`).
    const zebra = i % 2 === 1 ? C.slate50 : C.white;
    put(ws, r, 1, i + 1, { fill: zebra, font: C.slate500, border: C.slate300 });
    put(ws, r, 2, row.userName, {
      fill: zebra,
      font: C.slate800,
      bold: true,
      align: 'left',
      border: C.slate300,
    });
    put(ws, r, 3, row.userId, { fill: zebra, font: C.slate600, align: 'left', border: C.slate300 });
    put(ws, r, 4, row.largeDept, { fill: zebra, font: C.slate700, align: 'left', border: C.slate300 });
    days.forEach((d, j) => {
      const v = row.byDay[d];
      put(ws, r, firstDayCol + j, v ?? '', {
        fill: zebra,
        font: C.blue700,
        bold: true,
        border: C.slate300,
        numFmt: NUM_FMT.int,
      });
    });
    if (days.length > 0) {
      formula(
        ws,
        r,
        colTotal,
        `SUM(${rowRange(r, firstDayCol, colTotal - 1)})`,
        row.total,
        { fill: C.amber50, bold: true, border: C.slate300, numFmt: NUM_FMT.int }
      );
    } else {
      put(ws, r, colTotal, row.total, {
        fill: C.amber50,
        bold: true,
        border: C.slate300,
        numFmt: NUM_FMT.int,
      });
    }
    r += 1;
  });

  const lastEmployeeRow = r - 1;
  const hasEmployees = pivot.rows.length > 0;

  if (!hasEmployees) {
    block(ws, r, 1, r, lastCol, `Không có lượt quẹt nào của ca ${alias} trong khoảng đã chọn.`, {
      fill: C.white,
      font: C.slate500,
    });
    r += 1;
  }

  /* Suất nhập tay của ca: không gắn với nhân sự nên không có dòng trong
     danh sách trên, nhưng vẫn nằm trong tổng của ca. */
  let manualRow: number | null = null;
  if (pivot.manualTotal > 0) {
    const manualTone: CellStyle = { fill: C.amber50, font: C.amber900, bold: true };
    block(ws, r, 1, r, 4, MANUAL_PIVOT_LABEL, { ...manualTone, align: 'right' });
    days.forEach((d, i) =>
      put(ws, r, firstDayCol + i, pivot.manualByDay[d] ?? '', {
        ...manualTone,
        numFmt: NUM_FMT.int,
      })
    );
    if (days.length > 0) {
      formula(
        ws,
        r,
        colTotal,
        `SUM(${rowRange(r, firstDayCol, colTotal - 1)})`,
        pivot.manualTotal,
        { ...manualTone, fill: C.amber100, numFmt: NUM_FMT.int }
      );
    } else {
      put(ws, r, colTotal, pivot.manualTotal, {
        ...manualTone,
        fill: C.amber100,
        numFmt: NUM_FMT.int,
      });
    }
    manualRow = r;
    r += 1;
  }

  /* Tổng theo ngày của toàn bộ ca = cộng dọc cột nhân viên, CỘNG THÊM ô của
     dòng nhập tay (dòng đó nằm ngoài vùng nhân viên nên phải cộng riêng, nếu
     không tổng sẽ hụt đúng bằng số suất nhập tay). */
  const dayTotalTone: CellStyle = { fill: C.slate200, bold: true };
  block(ws, r, 1, r, 4, 'TỔNG THEO NGÀY', { ...dayTotalTone, align: 'right' });
  const dayTotalRow = r;
  days.forEach((d, i) => {
    const col = firstDayCol + i;
    const parts: string[] = [];
    if (hasEmployees) parts.push(colRange(col, firstEmployeeRow, lastEmployeeRow));
    if (manualRow !== null) parts.push(addr(manualRow, col));
    sumOf(ws, r, col, parts, pivot.dayTotals[d] ?? 0, {
      ...dayTotalTone,
      numFmt: NUM_FMT.int,
    });
  });
  sumOf(
    ws,
    r,
    colTotal,
    days.length > 0 ? [rowRange(r, firstDayCol, colTotal - 1)] : [],
    pivot.grandTotal,
    { ...dayTotalTone, fill: C.amber200, numFmt: NUM_FMT.int }
  );
  r += 1;

  // Tách tiếp theo bộ phận lớn
  pivot.deptRows.forEach((d) => {
    block(ws, r, 1, r, 4, d.largeDept, {
      fill: C.slate100,
      font: C.slate800,
      bold: true,
      align: 'right',
    });
    days.forEach((day, i) =>
      put(ws, r, firstDayCol + i, d.byDay[day] ?? 0, {
        font: d.byDay[day] ? C.slate900 : C.slate500,
        border: C.slate300,
        numFmt: NUM_FMT.int,
      })
    );
    sumOf(
      ws,
      r,
      colTotal,
      days.length > 0 ? [rowRange(r, firstDayCol, colTotal - 1)] : [],
      d.total,
      { fill: C.slate100, bold: true, numFmt: NUM_FMT.int }
    );
    r += 1;
  });

  /* Dòng cuối lặp lại đúng dòng TỔNG THEO NGÀY nên trỏ thẳng về ô đó thay vì
     cộng lại — sửa một ô ở trên là cả hai dòng tổng cùng đổi. */
  const footer: CellStyle = { fill: C.slate800, font: C.white, bold: true, border: C.slate700 };
  block(ws, r, 1, r, 4, 'TỔNG CỘNG', { ...footer, align: 'right' });
  days.forEach((d, i) =>
    formula(
      ws,
      r,
      firstDayCol + i,
      addr(dayTotalRow, firstDayCol + i),
      pivot.dayTotals[d] ?? 0,
      { ...footer, numFmt: NUM_FMT.int }
    )
  );
  formula(ws, r, colTotal, addr(dayTotalRow, colTotal), pivot.grandTotal, {
    ...footer,
    fill: C.amber500,
    font: C.slate900,
    numFmt: NUM_FMT.int,
  });
  ws.getRow(r).height = 22;

  headerGrandCell.value = {
    formula: addr(dayTotalRow, colTotal),
    result: pivot.grandTotal,
  };

  sheetFootnote(
    ws,
    r + 2,
    lastCol,
    `Cột ngày đánh theo NGÀY KẾT THÚC CA: ca đêm ${timeWindow || '22:50 - 01:50'} là một ca liền mạch và được tính trọn cho ngày hôm sau, nên lượt quẹt từ 22:50 nằm ở cột của ngày kế tiếp cùng với phần sau nửa đêm. Dòng "${MANUAL_PIVOT_LABEL}" là suất nhập ở tab Nhập Thủ Công Ca: không có lượt quẹt nên không có dòng nhân viên, nhưng vẫn nằm trong tổng của ca.`
  );

  ws.views = [{ state: 'frozen', xSplit: 4, ySplit: TABLE_TOP + 1 }];
}

/* -------------------------------------------------------------------------
   Điểm vào
   ------------------------------------------------------------------------- */

export interface WorkbookContext {
  classified: ClassifiedLog[];
  days: string[];
  pricing: MealPricing;
  shiftCategories: ShiftCategoryLookup;
  shifts: ShiftInfo[];
  largeDeptOptions: string[];
  manualMeals: CountedManualMeal[];
  /** Đã lọc theo khoảng lọc chính xác tới giây — `filterSupplyByRange`. */
  milkEntries: DailyMilkEntry[];
  extraCosts: ExtraCostEntry[];
  /**
   * Phần giao giữa các đợt thuê nhân công ĐÃ ÁP DỤNG và khoảng lọc, dựng bởi
   * `buildLaborSegments`. Rỗng khi chưa từng bấm "Áp dụng".
   */
  laborSegments: LaborSegment[];
  /** Quy tắc đếm ngày làm việc của lượt áp dụng đang có hiệu lực. */
  laborWorkDayRule: LaborWorkDayRule;
  /** Đã cộng chi phí nhân công vào từng tháng — xem `withLaborCost`. */
  monthlyCosts: MonthlyCostRow[];
  trendYear: string;
  startDate: string;
  endDate: string;
}

/** Tên sheet của 6 bảng chi tiết theo ca — đúng thứ tự trong bảng kê Excel. */
const SHIFT_SHEET_NAME = (code: ShiftCode) => `${reportShiftLabel(code)}_${code}`;

export async function exportFinancialWorkbook(ctx: WorkbookContext) {
  const ExcelJSModule = await import('exceljs');
  /* Bản dist cho trình duyệt là UMD: tuỳ cách Vite gói mà `Workbook` nằm ở
     namespace hay ở `default`. */
  const Ctor =
    (ExcelJSModule as any).Workbook ?? (ExcelJSModule as any).default?.Workbook;

  const wb = new Ctor() as ExcelJS.Workbook;
  wb.creator = 'QLSA';
  wb.created = new Date();
  /* Bắt Excel tính lại toàn bộ công thức ngay khi mở file: giá trị `result`
     ghi kèm chỉ để trình xem không biết tính vẫn hiện đúng số, còn Excel thì
     nên tự tính để người dùng sửa ô nào là thấy đổi ngay ô đó. */
  wb.calcProperties.fullCalcOnLoad = true;

  /* Chiều cao dòng mặc định của Excel (15) vừa khít cỡ chữ 10 cũ; ở cỡ 11 thì
     chữ chạm viền, nên nới ra cho mọi sheet. */
  const sheet = (name: string) =>
    wb.addWorksheet(name, { properties: { defaultRowHeight: 18 } });

  buildStatsSheet(sheet('Thống kê suất ăn tháng'), ctx);
  buildDeptSheet(sheet('Phân bổ theo BP'), ctx);
  buildYearlySheet(sheet('Total suất ăn'), ctx);
  buildAllocationSheet(sheet('Phân bổ tiền ăn'), ctx);
  SHIFT_ORDER.forEach((code) =>
    buildShiftSheet(sheet(SHIFT_SHEET_NAME(code)), ctx, code)
  );

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Bao_Cao_Tong_Hop_${ctx.startDate}_${ctx.endDate}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
