/**
 * Bảng màu & khuôn ô dùng cho file Excel "Báo cáo tổng hợp".
 *
 * Mọi mã màu ở đây là bản dịch 1-1 của class Tailwind đang dùng trên giao
 * diện web, để mở file Excel ra nhìn giống hệt bảng trên màn hình. Class nào
 * có độ trong suốt (`bg-red-900/60` trên nền `slate-900`) đã được trộn sẵn ra
 * màu đặc — Excel không có alpha cho nền ô.
 *
 * Các dải nền nhạt của bảng kê KHÔNG còn dùng alpha ở cả hai bên: pha loãng
 * `bg-orange-50/70` xuống gần trắng làm mất luôn ranh giới giữa các khối, nên
 * web và Excel cùng dùng đúng màu -50 đặc.
 *
 * Sửa màu ở giao diện thì sửa cả ở đây, nếu không hai bản sẽ lệch nhau.
 */

/** Tailwind → ARGB. Giữ đúng tên slot của Tailwind cho dễ đối chiếu. */
export const C = {
  white: 'FFFFFFFF',

  slate50: 'FFF8FAFC',
  slate100: 'FFF1F5F9',
  slate200: 'FFE2E8F0',
  slate300: 'FFCBD5E1',
  slate400: 'FF94A3B8',
  slate500: 'FF64748B',
  slate600: 'FF475569',
  slate700: 'FF334155',
  slate800: 'FF1E293B',
  slate900: 'FF0F172A',

  amber50: 'FFFFFBEB',
  amber100: 'FFFEF3C7',
  amber200: 'FFFDE68A',
  amber500: 'FFF59E0B',
  /* Dòng "nhập thủ công" ở chân các sheet chi tiết ca — bản dịch của
     `bg-amber-50` / `text-amber-900` trên web. */
  amber900: 'FF78350F',

  emerald50: 'FFECFDF5',
  emerald200: 'FFA7F3D0',
  emerald400: 'FF34D399',
  emerald600: 'FF059669',
  emerald700: 'FF047857',
  emerald950: 'FF022C22',

  orange50: 'FFFFF7ED',
  orange100: 'FFFFEDD5',
  orange200: 'FFFED7AA',
  orange700: 'FFC2410C',
  orange800: 'FF9A3412',
  orange900: 'FF7C2D12',
  orange950: 'FF431407',

  green100: 'FFDCFCE7',
  green900: 'FF14532D',

  indigo50: 'FFEEF2FF',
  indigo100: 'FFE0E7FF',
  /* Hai tầng tiêu đề của cột ngày có cấp sữa trong sheet "Thống kê suất ăn
     tháng" — bản dịch của `bg-indigo-800` / `bg-indigo-700` trên web. */
  indigo700: 'FF4338CA',
  indigo800: 'FF3730A3',
  indigo900: 'FF312E81',

  /* Khối "Chi phí phát sinh" — bản dịch của bg-violet-50/100 trên web. */
  violet50: 'FFF5F3FF',
  violet100: 'FFEDE9FE',
  violet900: 'FF4C1D95',

  /* Khối "Chi phí nhân công" — bản dịch của bg-teal-50/100 trên web. Đứng
     ngay dưới khối Chi phí phát sinh nên phải là một họ màu khác hẳn tím,
     nếu không hai khối dính vào nhau khi in. */
  teal50: 'FFF0FDFA',
  teal100: 'FFCCFBF1',
  teal700: 'FF0F766E',
  teal900: 'FF134E4A',

  sky100: 'FFE0F2FE',
  sky200: 'FFBAE6FD',
  sky700: 'FF0369A1',
  sky950: 'FF082F49',

  blue700: 'FF1D4ED8',
  red700: 'FFB91C1C',
  pink700: 'FFBE185D',

  /* Bốn ô tiêu đề loại suất của bảng "Phân bổ theo BP" dùng
     `bg-<màu>-900/60` chồng lên nền `slate-900`; đây là màu đã trộn. */
  headKoCom: 'FF521B22',
  headKoMy: 'FF50241C',
  headVnChinh: 'FF182C64',
  headVnPhu: 'FF0D3653',
  headVnSinhNhat: 'FF551839',

  textRed200: 'FFFECACA',
  textOrange200: 'FFFED7AA',
  textBlue200: 'FFBFDBFE',
  textSky200: 'FFBAE6FD',
  textPink200: 'FFFBCFE8',

} as const;

/** Định dạng số dùng lại nhiều nơi. */
export const NUM_FMT = {
  /* Hiện "65K" nhưng ô vẫn là số 65000, để công thức tham chiếu được. Dấu
     phẩy sau #,##0 là dấu chia nghìn của định dạng số Excel. */
  thousandK: '#,##0,"K"',
  /** 1.234 — dấu chấm nghìn kiểu Việt Nam. */
  int: '#,##0',
  /** 1.234.567 ₫ */
  vnd: '#,##0 "₫"',
};

/** Kiểu ô rút gọn — đủ dùng cho mọi sheet ở đây, không phụ thuộc exceljs. */
export interface CellStyle {
  fill?: string;
  font?: string;
  bold?: boolean;
  italic?: boolean;
  size?: number;
  align?: 'left' | 'center' | 'right';
  numFmt?: string;
  /** Viền mảnh màu này quanh ô; bỏ trống thì dùng slate-400. */
  border?: string;
  /** Bỏ viền hoàn toàn (ô đệm). */
  noBorder?: boolean;
  wrap?: boolean;
}
