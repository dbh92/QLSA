import React, { useState } from 'react';
import { DailyMilkEntry, ExtraCostEntry } from '../types';
import { Milk, Receipt } from 'lucide-react';
import { formatVND } from '../services/mealEngine';
import {
  SupplyEntryManager,
  SupplyEntryConfig,
  SupplyRow,
  SupplyUpsert,
} from './SupplyEntryManager';

/**
 * Tab "Quản Lý Sữa" — thật ra quản lý hai loại HÀNG CẤP PHÁT:
 *
 *   1. Sữa (SA_MilkEntry)
 *   2. Chi phí phát sinh (SA_ExtraCost) — kem, quà một ngày lễ tuỳ biến, hay
 *      bất cứ hạng mục nào nhà ăn xuất hoá đơn ngoài suất ăn và sữa.
 *
 * Hai domain có cấu trúc y hệt nhau và lên bảng kê theo cùng một cách, nên
 * màn hình nhập liệu dùng chung [SupplyEntryManager](./SupplyEntryManager.tsx);
 * ở đây chỉ còn việc chuyển đổi giữa hai kiểu dữ liệu và bộ nhãn/màu của từng
 * khối. Trên bảng kê chi phí, khối Sữa nằm trên và Chi phí phát sinh ngay
 * dưới — xem `buildMonthlyStatRows`.
 *
 * Người dùng nhập MỖI NGÀY MỘT DÒNG với hai cột số lượng Ca ngày / Ca đêm;
 * dưới cơ sở dữ liệu vẫn là một bản ghi cho mỗi ca. Việc gộp/tách nằm trọn
 * trong SupplyEntryManager, ở đây chỉ đổi tên trường giữa hai kiểu.
 */

type MilkInput = Omit<DailyMilkEntry, 'id' | 'totalAmount'> & { id?: string };
type ExtraInput = Omit<ExtraCostEntry, 'id' | 'totalAmount'> & { id?: string };

interface DailyMilkViewProps {
  entries: DailyMilkEntry[];
  /**
   * Ghi một lượt: thêm/ghi đè `upserts` rồi xoá `deleteIds`, và nạp lại danh
   * sách đúng một lần — một ngày sinh ra tới hai bản ghi (hai ca) và một file
   * Excel sinh ra hàng chục, không thể nạp lại sau từng bản ghi.
   */
  onCommit: (upserts: MilkInput[], deleteIds: string[]) => Promise<void>;

  extraCosts: ExtraCostEntry[];
  onCommitExtra: (upserts: ExtraInput[], deleteIds: string[]) => Promise<void>;

  startDate: string;
  endDate: string;
}

/* ---- Sữa <-> dòng cấp phát trung tính ---------------------------------- */

const milkToRow = (e: DailyMilkEntry): SupplyRow => ({
  id: e.id,
  date: e.date,
  shift: e.milkShift,
  itemName: e.milkType,
  quantity: e.quantity,
  unitPrice: e.unitPrice,
  totalAmount: e.totalAmount,
  supplier: e.supplier,
  notes: e.notes,
});

const rowToMilk = (r: SupplyUpsert): MilkInput => ({
  id: r.id,
  date: r.date,
  milkShift: r.shift,
  milkType: r.itemName,
  quantity: r.quantity,
  unitPrice: r.unitPrice,
  supplier: r.supplier,
  notes: r.notes,
});

/* ---- Chi phí phát sinh <-> dòng cấp phát trung tính --------------------- */

const extraToRow = (e: ExtraCostEntry): SupplyRow => ({
  id: e.id,
  date: e.date,
  shift: e.costShift,
  itemName: e.costType,
  quantity: e.quantity,
  unitPrice: e.unitPrice,
  totalAmount: e.totalAmount,
  supplier: e.supplier,
  notes: e.notes,
});

const rowToExtra = (r: SupplyUpsert): ExtraInput => ({
  id: r.id,
  date: r.date,
  costShift: r.shift,
  costType: r.itemName,
  quantity: r.quantity,
  unitPrice: r.unitPrice,
  supplier: r.supplier,
  notes: r.notes,
});

/* ---- Cấu hình hai khối -------------------------------------------------- */

const MILK_CONFIG: SupplyEntryConfig = {
  title: 'Quản Lý Nhập Lượng Sữa Hằng Ngày',
  description: (
    <>
      Theo dõi việc nhập và cấp phát sữa định kỳ cho công nhân viên. Mỗi ngày
      là một dòng, số lượng <strong>Ca ngày</strong> và{' '}
      <strong>Ca đêm</strong> nằm ở hai cột riêng.
    </>
  ),
  icon: <Milk className="w-6 h-6" />,
  totalLabel: 'Tổng Chi Phí Sữa',
  itemLabel: 'Loại Sữa',
  itemAliases: ['Loại sữa', 'loại sữa', 'loai sua', 'tên loại sữa', 'milktype', 'loại'],
  itemMissingError: 'Thiếu tên loại sữa.',
  templateFileName: 'Mau_Nhap_Sua.xlsx',
  templateSheetName: 'NhapSua',
  samples: [
    {
      date: '',
      itemName: 'Sữa Vinamilk 1 Lit',
      quantities: { NGAY: 700, DEM: 500 },
      unitPrice: 31000,
      supplier: 'Vinamilk Chi Nhánh Bình Dương',
      notes: 'Cấp sữa định kỳ',
    },
  ],
  defaults: {
    itemName: 'Sữa Vinamilk 1 Lit',
    quantities: { NGAY: 700, DEM: 500 },
    unitPrice: 31000,
    supplier: 'Vinamilk Chi Nhánh Bình Dương',
    notes: 'Cấp sữa định kỳ',
  },
  emptyText: 'Không có thông tin cấp sữa trong thời gian này.',
  accent: {
    headerGradient: 'from-cyan-700 via-teal-700 to-emerald-800',
    headerIcon: 'text-cyan-200',
    headerText: 'text-cyan-100',
    focusBorder: 'focus:border-cyan-500',
    primaryButton: 'bg-cyan-600 hover:bg-cyan-700',
    estimateBox: 'bg-cyan-50 border-cyan-200',
    estimateLabel: 'text-cyan-800',
    estimateValue: 'text-cyan-900',
    itemText: 'text-cyan-800',
    amountText: 'text-cyan-900',
    countBadge: 'text-cyan-800 bg-cyan-50 border-cyan-200',
    confirmButton: 'bg-cyan-600 hover:bg-cyan-700',
  },
};

const EXTRA_CONFIG: SupplyEntryConfig = {
  title: 'Quản Lý Chi Phí Phát Sinh',
  description: (
    <>
      Các hạng mục ngoài suất ăn và sữa: kem, quà một ngày lễ tuỳ biến, đồ
      uống đột xuất… Tên hạng mục do bạn tự đặt; mỗi ngày cũng là một dòng với
      hai cột số lượng <strong>Ca ngày</strong> và <strong>Ca đêm</strong>.
    </>
  ),
  icon: <Receipt className="w-6 h-6" />,
  totalLabel: 'Tổng Chi Phí Phát Sinh',
  itemLabel: 'Hạng Mục',
  itemAliases: [
    'Hạng mục',
    'hạng mục',
    'hang muc',
    'tên hạng mục',
    'nội dung',
    'costtype',
    'loại',
  ],
  itemMissingError: 'Thiếu tên hạng mục chi phí.',
  templateFileName: 'Mau_Chi_Phi_Phat_Sinh.xlsx',
  templateSheetName: 'ChiPhiPhatSinh',
  samples: [
    {
      date: '',
      itemName: 'Kem Merino',
      quantities: { NGAY: 700, DEM: 500 },
      unitPrice: 12000,
      supplier: 'Kido Bình Dương',
      notes: 'Phát kem ngày lễ 30/4',
    },
  ],
  defaults: {
    itemName: 'Kem Merino',
    quantities: { NGAY: 700, DEM: 0 },
    unitPrice: 12000,
    supplier: 'Kido Bình Dương',
    notes: '',
  },
  emptyText: 'Không có chi phí phát sinh nào trong thời gian này.',
  accent: {
    headerGradient: 'from-violet-700 via-purple-700 to-fuchsia-800',
    headerIcon: 'text-violet-200',
    headerText: 'text-violet-100',
    focusBorder: 'focus:border-violet-500',
    primaryButton: 'bg-violet-600 hover:bg-violet-700',
    estimateBox: 'bg-violet-50 border-violet-200',
    estimateLabel: 'text-violet-800',
    estimateValue: 'text-violet-900',
    itemText: 'text-violet-800',
    amountText: 'text-violet-900',
    countBadge: 'text-violet-800 bg-violet-50 border-violet-200',
    confirmButton: 'bg-violet-600 hover:bg-violet-700',
  },
};

type Section = 'milk' | 'extra';

export const DailyMilkView: React.FC<DailyMilkViewProps> = ({
  entries,
  onCommit,
  extraCosts,
  onCommitExtra,
  startDate,
  endDate,
}) => {
  const [section, setSection] = useState<Section>('milk');

  const inRange = <T extends { date: string }>(rows: T[]) =>
    rows.filter((e) => e.date >= startDate && e.date <= endDate);

  /* Đếm NGÀY chứ không đếm bản ghi: một ngày cấp cả hai ca vẫn là một ngày,
     đúng như bảng bên dưới đang hiển thị. */
  const dayCount = (rows: { date: string }[]) =>
    new Set(inRange(rows).map((e) => e.date)).size;

  const milkTotal = inRange(entries).reduce((s, e) => s + e.totalAmount, 0);
  const extraTotal = inRange(extraCosts).reduce((s, e) => s + e.totalAmount, 0);

  const tabs: {
    id: Section;
    label: string;
    icon: React.ReactNode;
    amount: number;
    count: number;
    activeClass: string;
  }[] = [
    {
      id: 'milk',
      label: 'Sữa',
      icon: <Milk className="w-4 h-4" />,
      amount: milkTotal,
      count: dayCount(entries),
      activeClass: 'bg-cyan-600 border-cyan-600 text-white shadow-sm',
    },
    {
      id: 'extra',
      label: 'Chi Phí Phát Sinh',
      icon: <Receipt className="w-4 h-4" />,
      amount: extraTotal,
      count: dayCount(extraCosts),
      activeClass: 'bg-violet-600 border-violet-600 text-white shadow-sm',
    },
  ];

  return (
    <div className="space-y-6 pb-8">
      {/* Chọn khối: Sữa hay Chi phí phát sinh */}
      <div className="bg-white p-2 rounded-2xl border border-slate-200 shadow-sm grid grid-cols-1 sm:grid-cols-2 gap-2">
        {tabs.map((t) => {
          const active = section === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSection(t.id)}
              className={`px-4 py-3 rounded-xl border text-left transition ${
                active
                  ? t.activeClass
                  : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
            >
              <div className="flex items-center gap-2 font-bold text-sm">
                {t.icon}
                {t.label}
              </div>
              <div
                className={`text-xs mt-0.5 ${active ? 'text-white/80' : 'text-slate-500'}`}
              >
                {t.count.toLocaleString('vi-VN')} ngày • {formatVND(t.amount)}
              </div>
            </button>
          );
        })}
      </div>

      {section === 'milk' ? (
        <SupplyEntryManager
          config={MILK_CONFIG}
          rows={entries.map(milkToRow)}
          onCommit={(upserts, deleteIds) =>
            onCommit(upserts.map(rowToMilk), deleteIds)
          }
          startDate={startDate}
          endDate={endDate}
        />
      ) : (
        <SupplyEntryManager
          config={EXTRA_CONFIG}
          rows={extraCosts.map(extraToRow)}
          onCommit={(upserts, deleteIds) =>
            onCommitExtra(upserts.map(rowToExtra), deleteIds)
          }
          startDate={startDate}
          endDate={endDate}
        />
      )}
    </div>
  );
};
