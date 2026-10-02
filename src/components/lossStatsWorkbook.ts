/**
 * Xuất Excel cho bảng "Thống kê số lượt mất mát theo ngày & ca" của tab
 * Suất Ăn Mất Mát.
 *
 * Đây là bộ xuất RIÊNG của màn hình này, không dùng chung với
 * [financial/workbookExport.ts](./financial/workbookExport.ts): quy ước của
 * repo là mỗi màn hình tự sở hữu phần xuất Excel của nó, vì cái quyết định
 * bố cục sheet là bảng trên web chứ không phải một khuôn chung. Thứ DUY NHẤT
 * dùng chung là bảng màu [workbookTheme.ts](./financial/workbookTheme.ts) —
 * đổi màu bảng trên web thì đổi ở đó, và cả hai file Excel cùng đổi theo.
 *
 * Số liệu KHÔNG được tính lại ở đây: view truyền xuống đúng cái nó đang vẽ,
 * nên file Excel và màn hình không thể ra hai con số khác nhau.
 *
 * Ô nào là số nguồn thì ghi giá trị, ô nào là số dẫn xuất (tổng dòng, tổng
 * cột) thì ghi CÔNG THỨC kèm `result` — mở file lên sửa một ô là các dòng
 * tổng tự tính lại, còn trình xem không biết tính công thức vẫn thấy đúng số.
 *
 * `exceljs` nặng ~950KB nên chỉ nạp khi người dùng thật sự bấm nút xuất.
 */
import type ExcelJS from "exceljs";
import { C, CellStyle, NUM_FMT } from "./financial/workbookTheme";

/* -------------------------------------------------------------------------
   Vẽ ô — bản rút gọn, chỉ đủ cho một sheet phẳng
   ------------------------------------------------------------------------- */

const FONT = "Calibri";
const BASE_SIZE = 11;

function paint(cell: ExcelJS.Cell, s: CellStyle = {}) {
  if (s.fill) {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: s.fill } };
  }
  cell.font = {
    name: FONT,
    size: s.size ?? BASE_SIZE,
    bold: s.bold ?? false,
    color: { argb: s.font ?? C.slate900 },
  };
  cell.alignment = {
    horizontal: s.align ?? "center",
    vertical: "middle",
    wrapText: s.wrap ?? false,
  };
  if (!s.noBorder) {
    const line = {
      style: "thin" as const,
      color: { argb: s.border ?? C.slate400 },
    };
    cell.border = { top: line, left: line, bottom: line, right: line };
  }
  if (s.numFmt) cell.numFmt = s.numFmt;
}

function put(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: string | number | null,
  style?: CellStyle,
) {
  const cell = ws.getCell(row, col);
  cell.value = value === null ? "" : value;
  paint(cell, style);
  return cell;
}

/** Số cột -> chữ cột Excel: 1 -> A, 27 -> AA. */
function colLetter(col: number): string {
  let n = col;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const addr = (row: number, col: number) => `${colLetter(col)}${row}`;

/** Ghi một ô công thức, kèm giá trị đã tính sẵn. */
function formula(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  f: string,
  result: number,
  style?: CellStyle,
) {
  const cell = ws.getCell(row, col);
  cell.value = { formula: f, result: Number.isFinite(result) ? result : 0 };
  paint(cell, style);
}

/** Ô gộp — phải tô cả vùng, nếu không ô gộp hở viền ở các cạnh trong. */
function block(
  ws: ExcelJS.Worksheet,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  value: string,
  style?: CellStyle,
) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) paint(ws.getCell(r, c), style);
  }
  if (r1 !== r2 || c1 !== c2) ws.mergeCells(r1, c1, r2, c2);
  ws.getCell(r1, c1).value = value;
}

/* -------------------------------------------------------------------------
   Số liệu đầu vào — đúng cái bảng trên web đang vẽ
   ------------------------------------------------------------------------- */

/** Một dòng: một ngày làm việc, số lượt mất mát của từng ca. */
export interface LossStatSheetRow {
  /** "YYYY-MM-DD" — ngày làm việc, không phải ngày lịch của lượt quẹt. */
  workDate: string;
  byShift: Record<string, number>;
  total: number;
}

export interface LossStatsSheetData {
  /** Mã ca làm cột, đúng thứ tự bảng web đang hiện. */
  columns: string[];
  rows: LossStatSheetRow[];
  byShiftTotal: Record<string, number>;
  grandTotal: number;
  /** "Tất cả" / "Bị trừ tiền" / "Không bị trừ tiền" — phạm vi đang chọn. */
  scopeLabel: string;
  /** Hậu tố tên file, không dấu. */
  scopeSlug: string;
  startDate: string;
  endDate: string;
}

/** "2026-09-08" -> "08/09/2026" — giống hệt cột Ngày trên web. */
const viDate = (d: string) =>
  `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Hàng tiêu đề bảng: dưới hai dòng tiêu đề sheet + một dòng trống. */
const TABLE_TOP = 4;

export async function exportLossStatsWorkbook(data: LossStatsSheetData) {
  const ExcelJSModule = await import("exceljs");
  /* Bản dist cho trình duyệt là UMD: tuỳ cách Vite gói mà `Workbook` nằm ở
     namespace hay ở `default`. */
  const Ctor =
    (ExcelJSModule as any).Workbook ?? (ExcelJSModule as any).default?.Workbook;

  const wb = new Ctor() as ExcelJS.Workbook;
  wb.creator = "QLSA";
  wb.created = new Date();
  /* Bắt Excel tính lại công thức ngay khi mở file — `result` ghi kèm chỉ để
     trình xem không biết tính vẫn hiện đúng số. */
  wb.calcProperties.fullCalcOnLoad = true;

  const ws = wb.addWorksheet("Mất mát theo ngày & ca", {
    properties: { defaultRowHeight: 18 },
  });

  const colTotal = 2 + data.columns.length;
  const lastCol = colTotal;

  ws.getColumn(1).width = 14;
  data.columns.forEach((_, i) => {
    ws.getColumn(2 + i).width = 9;
  });
  ws.getColumn(colTotal).width = 11;

  /* --- Hai dòng tiêu đề sheet, dịch từ khối header trắng của bảng web --- */
  const headingBase: CellStyle = {
    fill: C.slate50,
    align: "left",
    noBorder: true,
  };
  block(
    ws,
    1,
    1,
    1,
    lastCol,
    "Thống kê số lượt suất ăn mất mát theo ngày & ca",
    { ...headingBase, bold: true, size: 14, font: C.slate900 },
  );
  block(
    ws,
    2,
    1,
    2,
    lastCol,
    `Loại dữ liệu: ${data.scopeLabel} — khoảng lọc ${data.startDate} → ${data.endDate}`,
    { ...headingBase, size: 10, font: C.slate600 },
  );
  ws.getRow(1).height = 26;
  ws.getRow(2).height = 17;

  /* --- Hàng tiêu đề bảng --------------------------------------------- */
  const head: CellStyle = {
    fill: C.slate700,
    font: C.white,
    bold: true,
    border: C.slate500,
  };
  put(ws, TABLE_TOP, 1, "Ngày", { ...head, align: "left" });
  data.columns.forEach((code, i) => put(ws, TABLE_TOP, 2 + i, code, head));
  put(ws, TABLE_TOP, colTotal, "Tổng", {
    ...head,
    fill: C.amber500,
    font: C.slate900,
  });

  /* --- Các dòng ngày --------------------------------------------------- */
  let r = TABLE_TOP + 1;
  data.rows.forEach((row) => {
    put(ws, r, 1, viDate(row.workDate), {
      bold: true,
      align: "left",
      border: C.slate300,
    });

    data.columns.forEach((code, i) => {
      const v = row.byShift[code] ?? 0;
      /* Ô 0 để TRỐNG chứ không ghi số 0: bảng web hiện dấu "-", và bảng thưa
         thì nhìn ra ngay ca nào có vấn đề. SUM vẫn cộng đúng qua ô trống. */
      put(ws, r, 2 + i, v > 0 ? v : "", {
        border: C.slate300,
        numFmt: NUM_FMT.int,
      });
    });

    formula(
      ws,
      r,
      colTotal,
      `SUM(${addr(r, 2)}:${addr(r, colTotal - 1)})`,
      row.total,
      {
        fill: C.amber50,
        font: C.amber900,
        bold: true,
        border: C.slate300,
        numFmt: NUM_FMT.int,
      },
    );
    r += 1;
  });

  const firstDataRow = TABLE_TOP + 1;
  const lastDataRow = r - 1;
  const hasData = lastDataRow >= firstDataRow;

  /* --- Dòng TỔNG CỘNG -------------------------------------------------- */
  const footer: CellStyle = {
    fill: C.slate800,
    font: C.white,
    bold: true,
    border: C.slate600,
  };
  put(ws, r, 1, "TỔNG CỘNG", { ...footer, align: "left" });

  data.columns.forEach((code, i) => {
    const col = 2 + i;
    const value = data.byShiftTotal[code] ?? 0;
    const style: CellStyle = { ...footer, numFmt: NUM_FMT.int };
    if (hasData) {
      formula(
        ws,
        r,
        col,
        `SUM(${addr(firstDataRow, col)}:${addr(lastDataRow, col)})`,
        value,
        style,
      );
    } else {
      put(ws, r, col, value, style);
    }
  });

  const grandStyle: CellStyle = {
    ...footer,
    fill: C.amber500,
    font: C.slate900,
    numFmt: NUM_FMT.int,
  };
  if (hasData) {
    formula(
      ws,
      r,
      colTotal,
      `SUM(${addr(firstDataRow, colTotal)}:${addr(lastDataRow, colTotal)})`,
      data.grandTotal,
      grandStyle,
    );
  } else {
    put(ws, r, colTotal, data.grandTotal, grandStyle);
  }
  ws.getRow(r).height = 22;

  /* --- Ghi chú chân bảng, đúng câu đang hiện dưới bảng web ------------- */
  block(
    ws,
    r + 2,
    1,
    r + 2,
    lastCol,
    "Mỗi dòng là một NGÀY LÀM VIỆC, không phải ngày lịch: ca đêm 22:50 → 01:50 được tính trọn cho ngày kết thúc ca, nên lượt quẹt lúc 00:05 và lượt lúc 23:45 của cùng một ngày lịch nằm ở hai dòng khác nhau. Đơn vị đếm là LƯỢT MẤT MÁT, không phải số người.",
    {
      fill: C.slate50,
      font: C.slate600,
      size: 10,
      align: "left",
      noBorder: true,
      wrap: true,
    },
  );
  ws.getRow(r + 2).height = 32;

  /* Ghim cột Ngày và hàng tiêu đề — bảng một tháng dài quá màn hình. */
  ws.views = [
    { state: "frozen", xSplit: 1, ySplit: TABLE_TOP, activeCell: "B5" },
  ];

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `Thong_Ke_Mat_Mat_Ngay_Ca_${data.scopeSlug}_${data.startDate}_${data.endDate}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
