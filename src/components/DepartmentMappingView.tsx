import React, { useMemo, useState } from 'react';
import { DepartmentMapping, GuestDeptOverride, GuestDeptPeriod } from '../types';
import {
  GitFork,
  Plus,
  Search,
  Save,
  Trash2,
  Edit2,
  ArrowRight,
  UserCog,
  CalendarPlus,
  CalendarRange,
  AlertTriangle,
} from 'lucide-react';

interface DepartmentMappingViewProps {
  mappings: DepartmentMapping[];
  /** Danh mục bộ phận lớn lấy từ SA_LargeDepartment. */
  largeDeptOptions: string[];
  onSave: (mapping: DepartmentMapping) => Promise<void>;
  onDelete: (smallDepartment: string) => Promise<void>;
  /**
   * Khách công tác thuộc diện gán lại bộ phận (SA_GuestDeptOverride). Máy chủ
   * quyết định ai có mặt ở đây — xem `SA_GuestDeptOverride_Get`.
   */
  guestOverrides: GuestDeptOverride[];
  /**
   * Từng ĐỢT ánh xạ đã áp dụng. Một khách có thể có nhiều đợt nối tiếp nhau;
   * các đợt của cùng một khách không được giao nhau.
   */
  guestPeriods: GuestDeptPeriod[];
  /**
   * THÊM một đợt: khách + bộ phận + khoảng ngày (null = không giới hạn đầu
   * đó). Máy chủ từ chối nếu khoảng này giao với một đợt đã có của cùng khách.
   */
  onSaveGuestOverride: (
    userId: string,
    largeDepartment: string,
    effectiveFrom: string | null,
    effectiveTo: string | null
  ) => Promise<void>;
  /** Xoá MỘT đợt theo mã đợt — các đợt khác của khách đó giữ nguyên. */
  onDeleteGuestOverride: (overrideId: number) => Promise<void>;
  /** Khoảng lọc đang xem — chỉ để chú thích cột "Số lượt quẹt". */
  startDate: string;
  endDate: string;
}

/** "YYYY-MM-DD" của hôm nay theo giờ máy. */
function todayString(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Một ĐỢT đang ở trạng thái nào TÍNH ĐẾN HÔM NAY.
 *
 * Chỉ để hiển thị. Con số của báo cáo do SQL Server quyết định và nó so với
 * NGÀY QUẸT của từng lượt, không phải hôm nay — một đợt "đã hết hiệu lực" vẫn
 * đang đổi bộ phận cho những lượt quẹt nằm trong khoảng của nó.
 */
type PeriodStatus = 'active' | 'pending' | 'expired';

function periodStatus(p: GuestDeptPeriod, today: string): PeriodStatus {
  if (p.effectiveFrom && today < p.effectiveFrom) return 'pending';
  if (p.effectiveTo && today > p.effectiveTo) return 'expired';
  return 'active';
}

const STATUS_BADGE: Record<
  PeriodStatus,
  { label: string; className: string; title: string }
> = {
  active: {
    label: 'Đang hiệu lực',
    className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    title: 'Hôm nay nằm trong khoảng của đợt này — lượt quẹt hôm nay tính vào bộ phận đã gán.',
  },
  pending: {
    label: 'Chưa tới hạn',
    className: 'bg-sky-50 text-sky-800 border-sky-200',
    title: 'Đợt bắt đầu ở tương lai — hôm nay khách này vẫn tính vào bộ phận mặc định.',
  },
  expired: {
    label: 'Hết hiệu lực',
    className: 'bg-amber-50 text-amber-800 border-amber-200',
    title: 'Đợt đã qua. Lượt quẹt TRONG khoảng đó vẫn tính vào bộ phận đã gán; ngoài khoảng thì quay về bộ phận mặc định.',
  },
};

/**
 * Hai khoảng ngày có giao nhau không. Null là VÔ CỰC ở đầu đó, nên vế nào
 * null thì vế đó luôn thoả. Hai đợt liền kề (10/08 và 11/08) KHÔNG phải giao.
 *
 * Bản sao rút gọn của phép kiểm trong SA_GuestDeptOverride_Save — ở đây chỉ để
 * báo sớm cho người dùng; procedure mới là chỗ quyết định, vì đó là nơi duy
 * nhất mọi lối ghi đi qua.
 */
function rangesOverlap(
  aFrom: string | null,
  aTo: string | null,
  bFrom: string | null,
  bTo: string | null
): boolean {
  return (
    (!aFrom || !bTo || bTo >= aFrom) && (!aTo || !bFrom || bFrom <= aTo)
  );
}

/** 'YYYY-MM-DD' -> 'dd/MM/yyyy'; null -> dấu "không giới hạn". */
function fmtDate(d: string | null): string {
  if (!d) return '∞';
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
}

export const DepartmentMappingView: React.FC<DepartmentMappingViewProps> = ({
  mappings,
  largeDeptOptions,
  onSave,
  onDelete,
  guestOverrides,
  guestPeriods,
  onSaveGuestOverride,
  onDeleteGuestOverride,
  startDate,
  endDate,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingDept, setEditingDept] = useState<string | null>(null);
  const [editLargeDept, setEditLargeDept] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // New mapping form state
  const [newSmall, setNewSmall] = useState('');
  const [newLarge, setNewLarge] = useState(largeDeptOptions[0] || 'CSP');
  const [newNotes, setNewNotes] = useState('');

  // Bọc mọi thao tác ghi: khoá form trong lúc gọi API và hiện lỗi từ server.
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Lưu ánh xạ thất bại.');
    } finally {
      setBusy(false);
    }
  };

  // Filtered mappings
  const filteredMappings = mappings.filter((m) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      m.smallDepartment.toLowerCase().includes(q) ||
      m.largeDepartment.toLowerCase().includes(q) ||
      (m.notes && m.notes.toLowerCase().includes(q))
    );
  });

  // Handle Save Edit
  const handleSaveEdit = (smallDept: string) =>
    run(async () => {
      await onSave({ smallDepartment: smallDept, largeDepartment: editLargeDept, notes: editNotes });
      setEditingDept(null);
    });

  // Handle Add New
  const handleAddNew = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSmall.trim()) return;

    if (mappings.some((m) => m.smallDepartment.toLowerCase() === newSmall.trim().toLowerCase())) {
      alert('Bộ phận nhỏ này đã tồn tại trong bảng ánh xạ!');
      return;
    }

    return run(async () => {
      await onSave({
        smallDepartment: newSmall.trim(),
        largeDepartment: newLarge,
        notes: newNotes.trim(),
      });
      setNewSmall('');
      setNewNotes('');
    });
  };

  /* ---- Khách công tác ------------------------------------------------- */
  const today = todayString();

  /* Biểu mẫu "Áp dụng": mọi thứ chỉ nằm trong state cho tới khi bấm nút —
     chọn khách hay đổi ngày KHÔNG ghi gì xuống cơ sở dữ liệu. */
  const [formUserId, setFormUserId] = useState('');
  const [formDept, setFormDept] = useState(largeDeptOptions[0] || 'SP');
  const [formFrom, setFormFrom] = useState('');
  const [formTo, setFormTo] = useState('');

  const [guestQuery, setGuestQuery] = useState('');

  const filteredPeriods = useMemo(() => {
    const q = guestQuery.trim().toLowerCase();
    if (!q) return guestPeriods;
    return guestPeriods.filter(
      (p) =>
        p.userName.toLowerCase().includes(q) ||
        p.userId.toLowerCase().includes(q) ||
        p.largeDepartment.toLowerCase().includes(q)
    );
  }, [guestPeriods, guestQuery]);

  const filteredGuests = useMemo(() => {
    const q = guestQuery.trim().toLowerCase();
    if (!q) return guestOverrides;
    return guestOverrides.filter(
      (g) =>
        g.userName.toLowerCase().includes(q) ||
        g.userId.toLowerCase().includes(q) ||
        g.largeDepartment.toLowerCase().includes(q)
    );
  }, [guestOverrides, guestQuery]);

  /* Số khách có ít nhất một đợt, và số đợt đang phủ ngày hôm nay. Hai con số
     khác nhau: một đợt đã hết hạn vẫn là một đợt của khách đó. */
  const guestsWithPeriods = guestOverrides.filter((g) => g.periodCount > 0).length;
  const activePeriods = guestPeriods.filter(
    (p) => p.isActiveScope && periodStatus(p, today) === 'active'
  ).length;

  /**
   * Nút "Áp dụng" — lối vào DUY NHẤT để tạo một đợt.
   *
   * Kiểm tại chỗ để người dùng biết ngay vì sao không lưu được; máy chủ kiểm
   * lại y hệt (SA_GuestDeptOverride_Save) vì API không được tin client.
   */
  const handleApplyPeriod = (e: React.FormEvent) => {
    e.preventDefault();

    if (!formUserId) {
      alert('Hãy chọn khách công tác cần gán bộ phận.');
      return;
    }
    if (!formDept) {
      alert('Hãy chọn bộ phận cần gán.');
      return;
    }

    const from = formFrom || null;
    const to = formTo || null;

    if (from && to && to < from) {
      alert('Khoảng thời gian không hợp lệ: ngày kết thúc sớm hơn ngày bắt đầu.');
      return;
    }

    const clash = guestPeriods.find(
      (p) =>
        p.userId === formUserId &&
        rangesOverlap(from, to, p.effectiveFrom, p.effectiveTo)
    );
    if (clash) {
      alert(
        `Khoảng thời gian bị trùng với đợt đã có: ${fmtDate(clash.effectiveFrom)} → ` +
          `${fmtDate(clash.effectiveTo)} (${clash.largeDepartment}).\n\n` +
          'Hãy chọn khoảng khác hoặc xoá đợt cũ trước.'
      );
      return;
    }

    return run(async () => {
      await onSaveGuestOverride(formUserId, formDept, from, to);
      /* Giữ nguyên khách đang chọn để nhập tiếp đợt kế; chỉ xoá hai ô ngày. */
      setFormFrom('');
      setFormTo('');
    });
  };

  const handleDeletePeriod = (p: GuestDeptPeriod) => {
    const range = `${fmtDate(p.effectiveFrom)} → ${fmtDate(p.effectiveTo)}`;
    if (
      confirm(
        `Xoá đợt ${range} (${p.largeDepartment}) của ${p.userName}?\n\n` +
          'Những ngày trong đợt này sẽ tính lại vào bộ phận mặc định.'
      )
    ) {
      return run(() => onDeleteGuestOverride(p.overrideId));
    }
  };

  // Handle Delete Mapping
  const handleDelete = (smallDept: string) => {
    if (confirm(`Bạn có chắc muốn xóa ánh xạ cho bộ phận "${smallDept}"?`)) {
      return run(() => onDelete(smallDept));
    }
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <GitFork className="w-5 h-5 text-amber-600" />
            <h2 className="text-xl font-bold text-slate-800">
              Quản Lý Ánh Xạ Bộ Phận Nhỏ &rarr; Bộ Phận Lớn
            </h2>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Hệ thống chấm ăn có nhiều bộ phận nhỏ (OQC_LFEM, CSP Operator...). Ánh xạ các bộ phận
            này về các Bộ phận lớn ({largeDeptOptions.join(', ')}) để thống kê chính xác. Bộ phận
            nhỏ chưa được ánh xạ sẽ rơi vào nhóm "Khác". Thay đổi được lưu ngay vào SQL Server.
          </p>
        </div>

        <div className="text-right">
          <span className="text-xs font-bold text-slate-700 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
            Đã ánh xạ: {mappings.length} bộ phận nhỏ
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Add New Mapping Form */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm h-fit">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 mb-4">
            <Plus className="w-4 h-4 text-emerald-600" /> Thêm Ánh Xạ Bộ Phận Mới
          </h3>

          <form onSubmit={handleAddNew} className="space-y-4 text-xs">
            <div>
              <label className="block text-slate-700 font-semibold mb-1">
                Tên Bộ Phận Nhỏ (Từ máy BioStar) <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="VD: OQC_WLP_Moi, Maintenance..."
                value={newSmall}
                onChange={(e) => setNewSmall(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">
                Ánh Xạ Vào Bộ Phận Lớn <span className="text-red-500">*</span>
              </label>
              <select
                value={newLarge}
                onChange={(e) => setNewLarge(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500 font-bold text-slate-800"
              >
                {largeDeptOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">Ghi chú / Mô tả</label>
              <input
                type="text"
                placeholder="Mô tả công việc / mô hình..."
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-slate-950 font-bold rounded-xl transition shadow-sm flex items-center justify-center space-x-2"
            >
              <Plus className="w-4 h-4" />
              <span>{busy ? 'Đang lưu…' : 'Thêm Ánh Xạ Ngay'}</span>
            </button>
          </form>
        </div>

        {/* Right: Existing Mapping Table */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-3">
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Tìm bộ phận nhỏ hoặc lớn..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-amber-500"
              />
            </div>

            <span className="text-xs text-slate-500">
              Hiển thị {filteredMappings.length} kết quả
            </span>
          </div>

          <div className="overflow-x-auto max-h-[500px]">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-900 text-white font-bold sticky top-0 z-10 uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-3 px-4">Bộ Phận Nhỏ (BioStar)</th>
                  <th className="py-3 px-3 text-center">Ánh Xạ</th>
                  <th className="py-3 px-4">Bộ Phận Lớn</th>
                  <th className="py-3 px-4">Ghi Chú</th>
                  <th className="py-3 px-4 text-center">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800">
                {filteredMappings.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-400">
                      Không tìm thấy bộ phận phù hợp.
                    </td>
                  </tr>
                ) : (
                  filteredMappings.map((m) => {
                    const isEditing = editingDept === m.smallDepartment;

                    return (
                      <tr key={m.smallDepartment} className="hover:bg-slate-50 transition">
                        <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                          {m.smallDepartment}
                        </td>

                        <td className="py-3 px-3 text-center text-slate-400">
                          <ArrowRight className="w-4 h-4 mx-auto text-amber-500" />
                        </td>

                        <td className="py-3 px-4">
                          {isEditing ? (
                            <select
                              value={editLargeDept}
                              onChange={(e) => setEditLargeDept(e.target.value)}
                              className="px-2 py-1 border border-amber-500 rounded font-bold text-xs bg-white text-slate-900"
                            >
                              {largeDeptOptions.map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="px-2.5 py-1 rounded bg-amber-100 text-amber-900 font-extrabold border border-amber-300">
                              {m.largeDepartment}
                            </span>
                          )}
                        </td>

                        <td className="py-3 px-4 text-slate-600">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editNotes}
                              onChange={(e) => setEditNotes(e.target.value)}
                              className="w-full px-2 py-1 border border-amber-500 rounded text-xs bg-white"
                            />
                          ) : (
                            m.notes || '-'
                          )}
                        </td>

                        <td className="py-3 px-4 text-center">
                          {isEditing ? (
                            <div className="flex items-center justify-center space-x-1">
                              <button
                                onClick={() => handleSaveEdit(m.smallDepartment)}
                                disabled={busy}
                                className="p-1 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded transition"
                                title="Lưu"
                              >
                                <Save className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setEditingDept(null)}
                                className="p-1 bg-slate-300 hover:bg-slate-400 text-slate-800 rounded transition text-[10px]"
                              >
                                Hủy
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-center space-x-2">
                              <button
                                onClick={() => {
                                  setEditingDept(m.smallDepartment);
                                  setEditLargeDept(m.largeDepartment);
                                  setEditNotes(m.notes || '');
                                }}
                                className="p-1.5 text-slate-600 hover:text-amber-600 hover:bg-amber-50 rounded transition"
                                title="Sửa"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleDelete(m.smallDepartment)}
                                disabled={busy}
                                className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 rounded transition"
                                title="Xóa"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------
          Khách công tác: gán từng người vào một bộ phận lớn THEO TỪNG ĐỢT.

          Đây là NGOẠI LỆ của quy tắc chung ngay phía trên, không thay thế nó:
          thẻ khách công tác dùng chung, mỗi người khách làm việc với một bộ
          phận khác nhau và chỉ ở nhà máy một đợt, nên suất ăn của họ phải
          được tính vào đúng bộ phận đó, trong đúng những ngày đó. Chỉ những
          người quy tắc quét vào mới xuất hiện ở đây — danh sách do máy chủ
          quyết định, giao diện không tự lọc theo tên.
          ------------------------------------------------------------------ */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2">
              <UserCog className="w-5 h-5 text-indigo-600" />
              <h3 className="text-base font-bold text-slate-800">
                Khách Công Tác &mdash; Gán Bộ Phận Riêng Theo Từng Đợt
              </h3>
            </div>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">
              Quy tắc chung đang cho cả nhóm này vào{' '}
              <strong className="text-slate-700">
                {guestOverrides[0]?.defaultLargeDepartment ?? 'KR'}
              </strong>
              . Ở đây bạn chuyển riêng từng khách sang bộ phận họ thật sự đến
              làm việc, <strong>trong một khoảng ngày</strong>: lượt quẹt có
              ngày nằm trong đợt sẽ tính vào bộ phận đó —{' '}
              <strong>cả số suất, cả tiền, cả giá</strong> (chọn một bộ phận
              Việt Nam là khách đó ăn giá người Việt). Ngày nằm ngoài mọi đợt
              thì quay về bộ phận mặc định.
            </p>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
              Một khách có thể có <strong>nhiều đợt nối tiếp nhau</strong>{' '}
              (01&ndash;10/08 vào SP, 11&ndash;20/08 vào LFEM, 01&ndash;15/09
              vào QC). Các đợt của cùng một khách{' '}
              <strong>không được trùng ngày với nhau</strong>. Tạo đợt của quá
              khứ thoải mái &mdash; số liệu của tháng đó tính lại ngay. Để trống
              một ô ngày là <strong>không giới hạn</strong> đầu đó.
            </p>
          </div>

          <div className="text-right shrink-0 space-y-1.5">
            <div>
              <span className="text-xs font-bold text-indigo-800 bg-indigo-50 px-3 py-1.5 rounded-lg border border-indigo-200">
                {guestPeriods.length} đợt / {guestsWithPeriods} khách
              </span>
            </div>
            <div>
              <span className="text-[11px] font-semibold text-emerald-800 bg-emerald-50 px-3 py-1 rounded-lg border border-emerald-200">
                {activePeriods} đợt đang hiệu lực hôm nay
              </span>
            </div>
          </div>
        </div>

        {/* --------------------------------------------------------------
            Biểu mẫu tạo đợt. Chọn xong CHƯA có gì xảy ra — chỉ khi bấm
            "Áp dụng" mới kiểm dữ liệu, kiểm trùng khoảng rồi mới ghi.
            -------------------------------------------------------------- */}
        <form
          onSubmit={handleApplyPeriod}
          className="p-4 bg-indigo-50/40 border-b border-slate-200 grid grid-cols-1 md:grid-cols-12 gap-3 items-end"
        >
          <div className="md:col-span-4">
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wide mb-1">
              Khách công tác
            </label>
            <select
              value={formUserId}
              disabled={busy}
              onChange={(e) => setFormUserId(e.target.value)}
              className="w-full px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white text-slate-900 focus:outline-none focus:border-indigo-500 disabled:opacity-40"
            >
              <option value="">-- Chọn khách --</option>
              {guestOverrides.map((g) => (
                <option key={g.userId} value={g.userId}>
                  {g.userName} ({g.userId})
                  {g.periodCount > 0 ? ` · ${g.periodCount} đợt` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wide mb-1">
              Bộ phận
            </label>
            <select
              value={formDept}
              disabled={busy}
              onChange={(e) => setFormDept(e.target.value)}
              className="w-full px-2.5 py-2 border border-slate-300 rounded-lg text-xs font-bold bg-white text-slate-900 focus:outline-none focus:border-indigo-500 disabled:opacity-40"
            >
              {largeDeptOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wide mb-1">
              Từ ngày
            </label>
            <input
              type="date"
              value={formFrom}
              disabled={busy}
              onChange={(e) => setFormFrom(e.target.value)}
              title="Để trống = không giới hạn đầu này"
              className="w-full px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white text-slate-900 focus:outline-none focus:border-indigo-500 disabled:opacity-40"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wide mb-1">
              Đến ngày
            </label>
            <input
              type="date"
              value={formTo}
              disabled={busy}
              min={formFrom || undefined}
              onChange={(e) => setFormTo(e.target.value)}
              title="Để trống = không giới hạn đầu này"
              className="w-full px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white text-slate-900 focus:outline-none focus:border-indigo-500 disabled:opacity-40"
            />
          </div>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={busy || !formUserId}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white text-xs font-bold rounded-lg transition"
            >
              <CalendarPlus className="w-4 h-4" />
              Áp dụng
            </button>
          </div>
        </form>

        <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Tìm theo tên, mã thẻ hoặc bộ phận..."
              value={guestQuery}
              onChange={(e) => setGuestQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500"
            />
          </div>
          <span className="text-xs text-slate-500 flex items-center gap-1.5">
            <CalendarRange className="w-3.5 h-3.5" />
            Hiển thị {filteredPeriods.length} đợt
          </span>
        </div>

        {/* Bảng các ĐỢT đã áp dụng */}
        <div className="overflow-x-auto max-h-[360px]">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-900 text-white font-bold sticky top-0 z-10 uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-3 px-4">Khách Công Tác</th>
                <th className="py-3 px-4">Mã Thẻ</th>
                <th className="py-3 px-4">Bộ Phận</th>
                <th className="py-3 px-3">Từ Ngày</th>
                <th className="py-3 px-3">Đến Ngày</th>
                <th className="py-3 px-3">Trạng Thái</th>
                <th className="py-3 px-3 text-center">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-800">
              {filteredPeriods.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    {guestPeriods.length === 0
                      ? 'Chưa có đợt ánh xạ nào. Chọn khách, bộ phận, khoảng ngày rồi bấm "Áp dụng".'
                      : 'Không tìm thấy đợt phù hợp.'}
                  </td>
                </tr>
              ) : (
                filteredPeriods.map((p) => {
                  const status = periodStatus(p, today);
                  const badge = STATUS_BADGE[status];
                  return (
                    <tr
                      key={p.overrideId}
                      className={`transition ${
                        status === 'active' && p.isActiveScope
                          ? 'bg-indigo-50/60'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-3 px-4 font-semibold text-slate-900">
                        {p.userName}
                        {!p.isActiveScope && (
                          <span
                            title="Quy tắc không còn quét khách này vào diện được gán riêng, nên đợt này đang bị bỏ qua khi tính. Xoá đi cho gọn."
                            className="ml-1.5 inline-flex items-center gap-1 text-[10px] font-bold text-amber-700"
                          >
                            <AlertTriangle className="w-3 h-3" />
                            ngoài diện
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-600">
                        {p.userId}
                      </td>
                      <td className="py-3 px-4">
                        <span className="px-2.5 py-1 rounded font-extrabold border bg-indigo-100 text-indigo-900 border-indigo-300">
                          {p.largeDepartment}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-700">
                        {fmtDate(p.effectiveFrom)}
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-700">
                        {fmtDate(p.effectiveTo)}
                      </td>
                      <td className="py-3 px-3">
                        <span
                          title={badge.title}
                          className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <button
                          onClick={() => handleDeletePeriod(p)}
                          disabled={busy}
                          title="Xoá đợt này — những ngày trong đợt quay về bộ phận mặc định"
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-25 disabled:hover:bg-transparent rounded transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ------------------------------------------------------------------
          Ai đang thuộc diện được gán riêng, và hôm nay họ đang tính vào bộ
          phận nào. Cột "Số lượt quẹt" để biết ai thật sự có ăn trong khoảng
          đang lọc trước khi quyết định gán.
          ------------------------------------------------------------------ */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-200">
          <h3 className="text-sm font-bold text-slate-800">
            Danh Sách Khách Công Tác Thuộc Diện Quy Tắc
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Cột <strong>Bộ phận hôm nay</strong> là bộ phận đang có hiệu lực
            tính đến ngày hôm nay. Lượt quẹt của những ngày khác vẫn tính theo
            đợt phủ đúng ngày đó, nên đây là cột để nhìn, không phải con số của
            báo cáo.
          </p>
        </div>

        <div className="overflow-x-auto max-h-[320px]">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-800 text-white font-bold sticky top-0 z-10 uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-3 px-4">Tên Khách (BioStar)</th>
                <th className="py-3 px-4">Mã Thẻ</th>
                <th
                  className="py-3 px-3 text-center"
                  title={`Số lượt quẹt trong khoảng ${startDate} → ${endDate}`}
                >
                  Số Lượt Quẹt
                </th>
                <th className="py-3 px-4">Bộ Phận Hôm Nay</th>
                <th className="py-3 px-3 text-center">Số Đợt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-800">
              {filteredGuests.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    {guestOverrides.length === 0
                      ? 'Không có khách công tác nào thuộc diện quy tắc (tên chứa "Business").'
                      : 'Không tìm thấy khách phù hợp.'}
                  </td>
                </tr>
              ) : (
                filteredGuests.map((g) => {
                  const custom = g.largeDepartment !== g.defaultLargeDepartment;
                  return (
                    <tr
                      key={g.userId}
                      className={`transition ${
                        custom ? 'bg-indigo-50/60' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-3 px-4 font-semibold text-slate-900">
                        {g.userName}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-600">
                        {g.userId}
                      </td>
                      <td className="py-3 px-3 text-center font-mono font-bold text-slate-700">
                        {g.punchCount > 0 ? (
                          g.punchCount.toLocaleString('vi-VN')
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2.5 py-1 rounded font-extrabold border ${
                            custom
                              ? 'bg-indigo-100 text-indigo-900 border-indigo-300'
                              : 'bg-slate-100 text-slate-700 border-slate-300'
                          }`}
                        >
                          {g.largeDepartment}
                        </span>
                        {!custom && (
                          <span className="ml-1.5 text-[10px] text-slate-400">
                            mặc định
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-center font-mono font-bold text-slate-700">
                        {g.periodCount > 0 ? (
                          g.periodCount
                        ) : (
                          <span className="text-slate-300">0</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
