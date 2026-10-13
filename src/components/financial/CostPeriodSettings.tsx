import React, { useEffect, useMemo, useState } from "react";
import { CostMonthPeriod, ShiftInfo } from "../../types";
import {
  addDays,
  costWorkDayRange,
  workDayStartTime,
} from "../../services/mealEngine";
import { countLaborWorkDays } from "./reportModel";
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Loader2,
  RotateCcw,
  Save,
  Wand2,
} from "lucide-react";

/**
 * "Kỳ tính chi phí các tháng" — cài đặt của bảng 12 tháng ở tab Xu hướng năm.
 *
 * Mỗi tháng là một khoảng thời điểm NỬA MỞ [Từ, Đến): "Từ" thuộc kỳ, "Đến"
 * thì không, nên hai tháng nối tiếp dùng chung một mốc. SA_MealCost_GetMonthly
 * xếp MỌI cột theo kỳ này (lượt quẹt, suất nhập tay, sữa, phát sinh) và
 * `withLaborCost` cắt chi phí nhân công theo đúng hai mốc đó — nên đổi kỳ ở
 * đây là đổi cả dòng của tháng, không riêng một cột nào.
 *
 * Lưu theo NGUYÊN NĂM (đủ 12 kỳ, hoặc "Về mặc định" để xoá hết): lưu lẻ một
 * tháng thì kỳ của nó chồng lên kỳ mặc định của tháng bên cạnh. Procedure kiểm
 * lại mọi điều kiện ở đây; client chỉ kiểm trước để báo lỗi nhanh hơn.
 */

interface CostPeriodSettingsProps {
  year: number;
  periods: CostMonthPeriod[];
  /** Không đọc được kỳ (thường là chưa deploy procedure) — null nếu ổn. */
  error: string | null;
  shifts: ShiftInfo[];
  onSave: (
    year: number,
    periods: { monthNo: number; fromDateTime: string; toDateTime: string }[],
  ) => Promise<void>;
}

/** Một dòng đang sửa — giá trị của ô datetime-local "YYYY-MM-DDTHH:mm". */
interface DraftPeriod {
  monthNo: number;
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD HH:mm:ss" -> giá trị ô datetime-local. */
const toInput = (dt: string) => `${dt.slice(0, 10)}T${dt.slice(11, 16)}`;
/** Giá trị ô datetime-local -> "YYYY-MM-DD HH:mm:ss". */
const fromInput = (v: string) => `${v.slice(0, 10)} ${v.slice(11, 16)}:00`;

/** "YYYY-MM-DDTHH:mm" -> "dd/MM HH:mm". */
const fmtShort = (v: string) =>
  `${v.slice(8, 10)}/${v.slice(5, 7)} ${v.slice(11, 16)}`;

/** Số ngày làm việc mà một kỳ chạm tới (ngày làm việc kết thúc lúc 22:50). */
function workDaysOf(p: DraftPeriod, shifts: ShiftInfo[]): number {
  if (!p.from || !p.to || p.to <= p.from) return 0;
  const r = costWorkDayRange(fromInput(p.from), fromInput(p.to), shifts);
  return r.to < r.from ? 0 : countLaborWorkDays(r.from, addDays(r.to, 1), "ALL");
}

export const CostPeriodSettings: React.FC<CostPeriodSettingsProps> = ({
  year,
  periods,
  error,
  shifts,
  onSave,
}) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftPeriod[]>([]);
  const [cutoffDay, setCutoffDay] = useState(25);
  const [busy, setBusy] = useState(false);

  const boundary = workDayStartTime(shifts).slice(0, 5);

  /* Nạp lại bản đang sửa mỗi khi kỳ trên máy chủ đổi (đổi năm, vừa lưu). */
  useEffect(() => {
    setDraft(
      periods.map((p) => ({
        monthNo: p.monthNo,
        from: toInput(p.fromDateTime),
        to: toInput(p.toDateTime),
      })),
    );
  }, [periods]);

  const customCount = periods.filter((p) => p.isCustom).length;

  const dirty = useMemo(
    () =>
      draft.some((d) => {
        const p = periods.find((x) => x.monthNo === d.monthNo);
        return (
          !p || toInput(p.fromDateTime) !== d.from || toInput(p.toDateTime) !== d.to
        );
      }),
    [draft, periods],
  );

  /* Kiểm trước đúng các luật mà SA_CostMonthPeriod_Save sẽ kiểm, để báo lỗi
     ngay trên dòng thay vì sau một vòng gọi máy chủ. Khoảng HỞ giữa hai kỳ
     không phải lỗi — chỉ là thời gian không thuộc tháng nào — nên chỉ cảnh
     báo. */
  const problems = useMemo(() => {
    const errors: string[] = [];
    const gaps: string[] = [];
    draft.forEach((d) => {
      if (!d.from || !d.to) errors.push(`Tháng ${d.monthNo}: thiếu thời điểm.`);
      else if (d.to <= d.from)
        errors.push(`Tháng ${d.monthNo}: "Đến" phải sau "Từ".`);
    });
    const sorted = [...draft]
      .filter((d) => d.from && d.to && d.to > d.from)
      .sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.from < prev.to) {
        errors.push(
          `Kỳ tháng ${prev.monthNo} và tháng ${cur.monthNo} chồng lên nhau — ` +
            "một lượt quẹt sẽ bị tính vào cả hai tháng.",
        );
      } else if (cur.from > prev.to) {
        gaps.push(
          `${fmtShort(prev.to)} → ${fmtShort(cur.from)} (giữa tháng ${prev.monthNo} và ${cur.monthNo})`,
        );
      }
    }
    return { errors, gaps };
  }, [draft]);

  const patch = (monthNo: number, p: Partial<DraftPeriod>) =>
    setDraft((rows) =>
      rows.map((r) => (r.monthNo === monthNo ? { ...r, ...p } : r)),
    );

  /* Kỳ chốt theo ngày: tháng M = (M-1, ngày chốt) 22:50 -> (M, ngày chốt)
     22:50 — tháng được gọi theo tháng KẾT THÚC kỳ, đúng cách nhà ăn gọi
     "tháng 01/2026" là 25/12/2025 22:50 -> 25/01/2026 22:50. Ngày chốt 25 cho
     ra đúng kỳ mặc định của SA_CostMonthPeriodOf. */
  const fillByCutoff = () => {
    const day = Math.min(Math.max(Math.round(cutoffDay) || 1, 1), 28);
    setDraft(
      Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const prevY = m === 1 ? year - 1 : year;
        const prevM = m === 1 ? 12 : m - 1;
        return {
          monthNo: m,
          from: `${prevY}-${pad(prevM)}-${pad(day)}T${boundary}`,
          to: `${year}-${pad(m)}-${pad(day)}T${boundary}`,
        };
      }),
    );
  };

  const handleSave = async () => {
    if (problems.errors.length > 0) {
      alert(problems.errors.join("\n"));
      return;
    }
    setBusy(true);
    try {
      await onSave(
        year,
        draft.map((d) => ({
          monthNo: d.monthNo,
          fromDateTime: fromInput(d.from),
          toDateTime: fromInput(d.to),
        })),
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không lưu được kỳ tính chi phí.");
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (
      !confirm(
        `Đưa cả 12 tháng năm ${year} về kỳ mặc định (25 tháng trước ` +
          `${boundary} → 25 tháng này ${boundary})?`,
      )
    )
      return;
    setBusy(true);
    try {
      await onSave(year, []);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không lưu được kỳ tính chi phí.");
    } finally {
      setBusy(false);
    }
  };

  const field =
    "px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono focus:outline-none focus:border-emerald-500";
  const cell = "border border-slate-300 px-3 py-2";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-left"
      >
        <div>
          <div className="text-sm font-bold text-slate-900 uppercase tracking-wide flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-emerald-600" /> Kỳ tính chi
            phí các tháng năm {year}
          </div>
          <div className="text-xs text-slate-600 mt-0.5">
            {error
              ? "Chưa đọc được kỳ tính chi phí từ máy chủ."
              : customCount > 0
                ? `Đang dùng kỳ tự đặt cho ${customCount} tháng. Mọi cột của bảng 12 tháng, kể cả chi phí nhân công, tính theo kỳ này.`
                : `Đang dùng kỳ mặc định: 25 tháng trước ${boundary} → 25 tháng này ${boundary} (tháng 01/${year} = 25/12/${year - 1} ${boundary} → 25/01/${year} ${boundary}).`}
          </div>
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 text-slate-500" />
        ) : (
          <ChevronDown className="w-4 h-4 text-slate-500" />
        )}
      </button>

      {open && error && (
        <div className="p-4 text-xs text-red-700 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            {error} — cần deploy bảng SA_CostMonthPeriod và procedure
            SA_CostMonthPeriod_Get / _Save.
          </span>
        </div>
      )}

      {open && !error && (
        <>
          <div className="p-4 flex flex-wrap items-end gap-3 border-b border-slate-200">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Ngày chốt kỳ
              </label>
              <input
                type="number"
                min={1}
                max={28}
                value={cutoffDay}
                onChange={(e) => setCutoffDay(Number(e.target.value))}
                className={`${field} w-20`}
              />
            </div>
            <button
              type="button"
              onClick={fillByCutoff}
              className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-bold transition"
              title={`Tháng M = ngày ${cutoffDay}/(M-1) ${boundary} → ngày ${cutoffDay}/M ${boundary}`}
            >
              <Wand2 className="w-3.5 h-3.5" /> Điền 12 tháng theo ngày chốt
            </button>
            <div className="text-[11px] text-slate-500 flex-1 min-w-[200px]">
              Ví dụ ngày chốt 25: tháng 01/{year} = 25/12/{year - 1}{" "}
              {boundary} → 25/01/{year} {boundary} (ngày làm việc 26/12 →
              25/01). Chỉ điền vào bảng dưới, chưa lưu.
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleReset}
                disabled={busy || customCount === 0}
                className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-700 rounded-lg text-xs font-bold transition"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Về mặc định
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || !dirty}
                className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded-lg text-xs font-bold transition shadow-sm"
              >
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Lưu Kỳ 12 Tháng
              </button>
            </div>
          </div>

          {(problems.errors.length > 0 || problems.gaps.length > 0) && (
            <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900 space-y-0.5">
              {problems.errors.map((e) => (
                <div key={e} className="font-semibold text-red-700">
                  {e}
                </div>
              ))}
              {problems.gaps.length > 0 && (
                <div>
                  Khoảng hở không thuộc tháng nào (không được tính):{" "}
                  {problems.gaps.join("; ")}.
                </div>
              )}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px] border-collapse">
              <thead className="bg-slate-100 text-slate-700 font-bold uppercase text-[11px]">
                <tr>
                  <th className={cell}>Tháng</th>
                  <th className={cell}>Từ (thuộc kỳ)</th>
                  <th className={cell}>Đến (không thuộc kỳ)</th>
                  <th className={`${cell} text-center`}>Ngày LV</th>
                  <th className={`${cell} text-center`}>Nguồn</th>
                </tr>
              </thead>
              <tbody>
                {draft.map((d) => {
                  const saved = periods.find((p) => p.monthNo === d.monthNo);
                  return (
                    <tr key={d.monthNo} className="hover:bg-slate-50">
                      <td className={`${cell} font-bold text-slate-900 whitespace-nowrap`}>
                        T{pad(d.monthNo)}/{year}
                      </td>
                      <td className={cell}>
                        <input
                          type="datetime-local"
                          value={d.from}
                          onChange={(e) => patch(d.monthNo, { from: e.target.value })}
                          className={field}
                        />
                      </td>
                      <td className={cell}>
                        <input
                          type="datetime-local"
                          value={d.to}
                          onChange={(e) => patch(d.monthNo, { to: e.target.value })}
                          className={field}
                        />
                      </td>
                      <td className={`${cell} text-center font-mono`}>
                        {workDaysOf(d, shifts) || "-"}
                      </td>
                      <td className={`${cell} text-center text-[11px]`}>
                        {saved?.isCustom ? (
                          <span className="px-2 py-0.5 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 font-bold">
                            Tự đặt
                          </span>
                        ) : (
                          <span className="text-slate-400">Mặc định</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 bg-slate-50 border-t border-slate-300 text-xs text-slate-600 leading-relaxed">
            Mỗi kỳ là <strong>nửa mở</strong>: thời điểm &ldquo;Từ&rdquo; thuộc
            kỳ, thời điểm &ldquo;Đến&rdquo; thì không — hai tháng nối tiếp dùng
            chung một mốc mà không lượt quẹt nào bị tính hai lần. Lượt quẹt xếp
            theo giờ quẹt, suất nhập tay theo giờ bắt đầu ca, sữa và chi phí
            phát sinh theo giờ bắt đầu khung cấp phát (ca đêm từ {boundary} hôm
            trước, ca ngày từ 08:00), chi phí nhân công cắt theo số ngày làm
            việc của kỳ. Lưu xong, bảng 12 tháng và biểu đồ tính lại ngay; ô
            &ldquo;Tháng&rdquo; ở tab Chi phí nhân công cũng điền theo kỳ này.
          </div>
        </>
      )}
    </div>
  );
};
