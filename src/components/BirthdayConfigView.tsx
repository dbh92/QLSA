import React, { useState } from 'react';
import { BirthdayConfig } from '../types';
import { Cake, Plus, Trash2, Calendar, Sparkles, Check } from 'lucide-react';
import { formatVND } from '../services/mealEngine';

interface BirthdayConfigViewProps {
  configs: BirthdayConfig[];
  onSave: (config: Omit<BirthdayConfig, 'id'>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/** "YYYY-MM-DD" của hôm nay theo giờ máy. */
function todayString(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const BirthdayConfigView: React.FC<BirthdayConfigViewProps> = ({
  configs,
  onSave,
  onDelete,
}) => {
  const [newDate, setNewDate] = useState(todayString);
  const [newDesc, setNewDesc] = useState('Tiệc sinh nhật tập thể cán bộ công nhân viên');
  const [newPrice, setNewPrice] = useState(50000);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Lưu cấu hình sinh nhật thất bại.');
    } finally {
      setBusy(false);
    }
  };

  const handleAddConfig = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDate) return;

    if (configs.some((c) => c.date === newDate)) {
      alert('Ngày này đã được chọn làm ngày tổ chức sinh nhật!');
      return;
    }

    return run(() =>
      onSave({ date: newDate, description: newDesc.trim(), specialMealPrice: newPrice })
    );
  };

  const handleDelete = (id: string) => {
    if (confirm('Bạn có chắc muốn xóa ngày cấu hình sinh nhật này?')) {
      return run(() => onDelete(id));
    }
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-pink-600 via-rose-600 to-amber-600 p-5 rounded-2xl text-white shadow-lg flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start space-x-3">
          <div className="p-2.5 bg-white/20 rounded-xl backdrop-blur-md">
            <Cake className="w-6 h-6 text-amber-200" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Cấu Hình Ngày Sinh Nhật Tập Thể Trong Tháng</h2>
            <p className="text-xs text-rose-100 mt-1">
              Quy định ngày làm tiệc sinh nhật <strong>và đơn giá suất đặc biệt của chính ngày
              đó</strong>. Đây là nơi DUY NHẤT khai báo giá suất sinh nhật — Cấu Hình Giá Suất Ăn
              không còn giữ con số này. Mỗi ngày một giá, và Báo Cáo Chi Phí lấy đúng giá của ngày
              ăn: các ngày cùng giá nằm chung một dòng, ngày khác giá tách thành dòng riêng.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form Add */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm h-fit space-y-4">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
            <Plus className="w-4 h-4 text-pink-600" /> Cấu Hình Ngày Sinh Nhật Mới
          </h3>

          <form onSubmit={handleAddConfig} className="space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Chọn Ngày Trong Tháng</label>
              <input
                type="date"
                required
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-pink-500 font-bold text-slate-900"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Mô tả chương trình</label>
              <input
                type="text"
                required
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-pink-500"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Đơn giá Suất Ăn Đặc Biệt (VNĐ)
              </label>
              <input
                type="number"
                required
                step={1000}
                value={newPrice}
                onChange={(e) => setNewPrice(Number(e.target.value))}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-pink-500 font-mono font-bold text-slate-900"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full py-2.5 bg-pink-600 hover:bg-pink-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold rounded-xl transition shadow-sm flex items-center justify-center space-x-2"
            >
              <Sparkles className="w-4 h-4" />
              <span>{busy ? 'Đang lưu…' : 'Lưu Cấu Hình Sinh Nhật'}</span>
            </button>
          </form>
        </div>

        {/* List Configured Days */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs font-semibold text-slate-700">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-4 h-4 text-pink-600" />
              <span>Danh sách ngày tổ chức sinh nhật đã cài đặt</span>
            </span>
            <span className="text-pink-700 font-bold bg-pink-50 px-2.5 py-0.5 rounded border border-pink-200">
              {configs.length} ngày
            </span>
          </div>

          <div className="p-4 space-y-3">
            {configs.length === 0 ? (
              <p className="text-center py-8 text-xs text-slate-400">
                Chưa có ngày sinh nhật nào được cấu hình trong tháng.
              </p>
            ) : (
              configs.map((cfg) => (
                <div
                  key={cfg.id}
                  className="p-4 rounded-xl border border-pink-100 bg-pink-50/40 flex items-center justify-between hover:bg-pink-50 transition"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-pink-600 text-white flex items-center justify-center font-black">
                      <Cake className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-sm font-extrabold text-slate-900">{cfg.date}</div>
                      <div className="text-xs text-slate-600 mt-0.5">{cfg.description}</div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-4">
                    <div className="text-right">
                      <span className="text-[10px] text-slate-400 block uppercase font-medium">
                        Đơn giá suất đặc biệt
                      </span>
                      <span className="text-xs font-black text-pink-700 font-mono">
                        {formatVND(cfg.specialMealPrice)}
                      </span>
                    </div>

                    <button
                      onClick={() => handleDelete(cfg.id)}
                      disabled={busy}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 rounded-lg transition"
                      title="Xóa"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
