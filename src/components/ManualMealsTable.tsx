import React from 'react';
import { CountedManualMeal } from '../services/mealEngine';

/**
 * Danh sách suất nhập thủ công trong popup chi tiết của một ô (bộ phận × ca).
 *
 * Suất nhập tay được cộng vào ma trận như lượt quẹt nhưng không có nhân sự
 * hay giờ quẹt, nên không nằm được trong bảng lượt quẹt bên dưới — thiếu bảng
 * này thì một ô chỉ gồm suất nhập tay mở ra popup rỗng. Dùng chung cho
 * Dashboard và tab Thống Kê Ca / Bộ Phận.
 */
export const ManualMealsTable: React.FC<{ meals: CountedManualMeal[] }> = ({ meals }) => (
  <div className="rounded-xl border border-amber-200 overflow-hidden">
    <div className="px-3 py-2 bg-amber-50 text-[11px] font-bold uppercase tracking-wide text-amber-800">
      Suất nhập thủ công — không có lượt quẹt thẻ
    </div>
    <table className="w-full text-left text-xs border-collapse">
      <thead className="bg-slate-100 text-slate-700 font-bold uppercase border-b">
        <tr>
          <th className="py-2.5 px-3">STT</th>
          <th className="py-2.5 px-3">Ngày Làm Việc</th>
          <th className="py-2.5 px-3">Ca</th>
          <th className="py-2.5 px-3">Nhóm</th>
          <th className="py-2.5 px-3">Bộ Phận (đã nhập)</th>
          <th className="py-2.5 px-3 text-center">Số Suất</th>
          <th className="py-2.5 px-3">Lý Do</th>
          <th className="py-2.5 px-3">Người Nhập</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {[...meals]
          .sort((a, b) => b.dateTime.localeCompare(a.dateTime))
          .map((m, i) => (
            <tr key={m.entry.id} className="hover:bg-slate-50">
              <td className="py-2 px-3 text-slate-400">{i + 1}</td>
              <td className="py-2 px-3 font-mono font-semibold text-slate-900">{m.date}</td>
              <td className="py-2 px-3 font-bold text-amber-700">{m.shiftCode}</td>
              <td className="py-2 px-3 text-slate-700">{m.staffType}</td>
              <td className="py-2 px-3 text-slate-600">{m.entry.department || '—'}</td>
              <td className="py-2 px-3 text-center font-mono font-bold text-slate-900">
                {m.quantity.toLocaleString('vi-VN')}
              </td>
              <td className="py-2 px-3 text-slate-600">{m.entry.reason}</td>
              <td className="py-2 px-3 text-slate-600">{m.entry.enteredBy}</td>
            </tr>
          ))}
      </tbody>
    </table>
  </div>
);
