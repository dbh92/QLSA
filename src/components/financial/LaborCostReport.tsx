import React, { useMemo, useState } from "react";
import { formatVND } from "../../services/mealEngine";
import {
  CostMonthPeriod,
  LaborCostBatch,
  LaborCostDraftRow,
  LaborCostState,
  LaborWorkDayRule,
  ShiftInfo,
} from "../../types";
import {
  LABOR_WORKDAY_RULES,
  LABOR_WORKDAY_RULE_LABEL,
  LaborSegment,
  countLaborWorkDays,
  laborBoundaryDate,
  laborBoundaryDateTime,
  laborRangeForPeriod,
  laborTotalAmount,
  laborTotalWorkDays,
  laborWorkDayFromBoundary,
} from "./reportModel";
import { addDays, workDayStartTime } from "../../services/mealEngine";
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  ClipboardList,
  History,
  Info,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  UserPlus,
  Undo2,
  X,
} from "lucide-react";

/**
 * "Chi phí nhân công" — một bảng kê trong menu Báo Cáo Chi Phí, và cũng là
 * chỗ duy nhất nhập dữ liệu nhân công.
 *
 * HAI TẦNG, VÀ ĐÓ LÀ TOÀN BỘ Ý NGHĨA CỦA MÀN HÌNH NÀY:
 *
 *   • BẢN NHÁP (khối trên) — thêm, sửa, xoá thoải mái. Không một con số nào
 *     trên bất kỳ bảng kê nào nhúc nhích. Đóng trình duyệt rồi mở lại vẫn
 *     còn, vì nó nằm dưới cơ sở dữ liệu chứ không phải trong state.
 *   • LƯỢT ÁP DỤNG (nút "Áp dụng") — chụp bản nháp lại thành một bản ghi
 *     đóng băng. Từ giây phút đó, và chỉ từ giây phút đó, tiền nhân công mới
 *     đi vào thẻ tổng quan, bảng kê tháng, bảng phân bổ, bảng 12 tháng và
 *     file Excel tổng hợp.
 *
 * Mỗi lần bấm là MỘT lượt mới; lượt cũ không bị ghi đè mà nằm lại ở "Lịch sử
 * áp dụng" để truy vết. Báo cáo chỉ đọc lượt MỚI NHẤT — cộng hết mọi lượt thì
 * bấm hai lần là tiền nhân đôi.
 *
 * MỐC CỦA ĐỢT LÀ 22:50, KHÔNG PHẢI NỬA ĐÊM. Một ngày làm việc chạy từ 22:50
 * hôm trước tới 22:50 hôm sau (22:50 26/07 -> 22:50 27/07 là MỘT ngày làm
 * việc, ngày 27/07), nên người dùng nhập và đọc hai mốc 22:50 của đợt:
 * 25/07 22:50 -> 25/08 22:50 là 31 ngày làm việc 26/07..25/08. Cơ sở dữ liệu
 * vẫn lưu theo ngày làm việc, nửa mở (26/07 -> 26/08) — chuyển đổi nằm trong
 * `laborBoundaryDateTime` / `laborWorkDayFromBoundary`, không ở đâu khác. Hai
 * đợt nối tiếp dùng chung một mốc 22:50 mà không ngày nào bị tính hai lần.
 *
 * Ô "Tháng" và hai mốc Từ – Đến chỉnh ĐỘC LẬP. Chọn tháng thì hai mốc được
 * điền sẵn theo KỲ của tháng đó (cài ở tab Xu hướng năm), rồi người dùng sửa
 * tiếp mốc nào cũng được mà tháng vẫn giữ nguyên. Tháng được lưu cùng đợt
 * (`costMonth`) nhưng CHỈ LÀ NHÃN: tiền chia theo ngày làm việc của Từ – Đến,
 * và bảng 12 tháng vẫn cắt theo kỳ của từng tháng.
 */

interface LaborCostReportProps {
  state: LaborCostState;
  /** Đang tải lần đầu — chưa biết có bản nháp hay lượt áp dụng nào không. */
  loading: boolean;
  /** Các phần giao đã cắt theo khoảng lọc hiện tại (lượt đang hiệu lực). */
  segments: LaborSegment[];
  onSave: (row: {
    id?: number | null;
    workerName: string;
    effectiveFrom: string;
    effectiveTo: string;
    amount: number;
    notes?: string;
    costMonth?: string | null;
  }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onApply: (rule: LaborWorkDayRule, notes?: string) => Promise<void>;
  onRestoreBatch: (batchId: string) => Promise<void>;
  /** Danh mục ca — giờ bắt đầu ca vắt nửa đêm là mốc 22:50 của ngày làm việc. */
  shifts: ShiftInfo[];
  /** Kỳ 12 tháng của năm đang xem — để gọi tên tháng của từng đợt. */
  costPeriods: CostMonthPeriod[];
  /** Kỳ 12 tháng của một năm bất kỳ — ô "Tháng" tự điền theo đó. */
  onFetchCostPeriods: (year: number) => Promise<CostMonthPeriod[]>;
  startDate: string;
  endDate: string;
}

/** 'YYYY-MM-DD' -> 'dd/MM/yyyy'. */
const fmtDate = (d: string) =>
  d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—";

/** 'YYYY-MM-DD HH:mm' -> 'dd/MM/yyyy HH:mm'. */
const fmtDateTime = (dt: string) => `${fmtDate(dt.slice(0, 10))} ${dt.slice(11, 16)}`;

/**
 * Hai khoảng NỬA MỞ có giao nhau không: aFrom < bTo AND bFrom < aTo.
 *
 * Bản sao rút gọn của phép kiểm trong SA_LaborCost_Save — ở đây chỉ để báo
 * sớm cho người dùng; procedure mới là chỗ quyết định, vì đó là nơi duy nhất
 * mọi lối ghi đi qua.
 */
const rangesOverlap = (
  aFrom: string,
  aTo: string,
  bFrom: string,
  bTo: string,
) => aFrom < bTo && bFrom < aTo;

/* `effectiveFrom` / `effectiveTo` giữ NGÀY LÀM VIỆC đúng như lưu xuống cơ sở
   dữ liệu; ô nhập hiển thị ngày của mốc 22:50 (= ngày làm việc - 1). */
const EMPTY_FORM = {
  id: null as number | null,
  /** "YYYY-MM" của ô Tháng — lưu cùng đợt, nhưng chỉ là nhãn. */
  costMonth: "",
  workerName: "",
  effectiveFrom: "",
  effectiveTo: "",
  amount: "",
  notes: "",
};

export const LaborCostReport: React.FC<LaborCostReportProps> = ({
  state,
  loading,
  segments,
  onSave,
  onDelete,
  onApply,
  onRestoreBatch,
  shifts,
  costPeriods,
  onFetchCostPeriods,
  startDate,
  endDate,
}) => {
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [monthLoading, setMonthLoading] = useState(false);

  /** Giờ của mốc ngày làm việc, "22:50". */
  const boundaryTime = workDayStartTime(shifts).slice(0, 5);
  /** Biên ngày làm việc -> "dd/MM/yyyy 22:50". */
  const fmtBoundary = (workDay: string) =>
    fmtDateTime(laborBoundaryDateTime(workDay, shifts));

  /** "YYYY-MM" -> "MM/YYYY". */
  const fmtMonth = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;

  /** Tháng hiển thị của một đợt: tháng đã lưu; đợt cũ chưa có nhãn thì suy
      ra khi nó trùng khít kỳ của một tháng đang cài. */
  const monthOf = (r: LaborCostDraftRow) => {
    if (r.costMonth) return fmtMonth(r.costMonth);
    const p = costPeriods.find((cp) => {
      const range = laborRangeForPeriod(cp, shifts);
      return (
        range &&
        range.effectiveFrom === r.effectiveFrom &&
        range.effectiveTo === r.effectiveTo
      );
    });
    return p ? fmtMonth(p.costMonth) : null;
  };

  /* Chọn tháng -> hai mốc 22:50 lấy theo KỲ của tháng đó. Kỳ có thể đã được
     lệch tháng lịch (tháng 01/2026 = 25/12/2025 22:50 -> 25/01/2026 22:50),
     và kỳ tự đặt còn có thể khác nữa, nên phải hỏi đúng
     năm của tháng được chọn chứ không tự suy ra. */
  const handleMonthChange = async (costMonth: string) => {
    patch({ costMonth });
    if (!/^\d{4}-\d{2}$/.test(costMonth)) return;
    setMonthLoading(true);
    try {
      const periods = await onFetchCostPeriods(Number(costMonth.slice(0, 4)));
      const period = periods.find((p) => p.costMonth === costMonth);
      const range = period ? laborRangeForPeriod(period, shifts) : null;
      if (!range) {
        alert(`Chưa đọc được kỳ của tháng ${costMonth}.`);
        return;
      }
      setForm((f) => ({
        ...f,
        costMonth,
        effectiveFrom: range.effectiveFrom,
        effectiveTo: range.effectiveTo,
      }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không đọc được kỳ của tháng.");
    } finally {
      setMonthLoading(false);
    }
  };
  const [rule, setRule] = useState<LaborWorkDayRule | null>(null);

  /* Ô chọn quy tắc mặc định theo lượt ĐANG hiệu lực, để bấm "Áp dụng" lần nữa
     mà không đụng gì tới nó thì cách tính không tự đổi dưới chân người dùng.
     `null` = chưa chọn tay lần nào. */
  const effectiveRule: LaborWorkDayRule =
    rule ?? state.effective?.workDayRule ?? "ALL";

  const patch = (p: Partial<typeof EMPTY_FORM>) =>
    setForm((f) => ({ ...f, ...p }));

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Thao tác thất bại.");
    } finally {
      setBusy(false);
    }
  };

  /* ---- Bản nháp ------------------------------------------------------ */

  const draftTotal = state.draft.reduce((acc, r) => acc + r.amount, 0);

  /** Số ngày làm việc của một đợt theo quy tắc đang chọn — để người dùng
      thấy ngay mẫu số của phép chia trước khi áp dụng. */
  const draftWorkDays = (r: LaborCostDraftRow) =>
    countLaborWorkDays(r.effectiveFrom, r.effectiveTo, effectiveRule);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const workerName = form.workerName.trim();
    const { effectiveFrom, effectiveTo } = form;
    const amount = Number(form.amount);

    if (!workerName) {
      alert("Hãy nhập họ tên nhân công.");
      return;
    }
    if (!effectiveFrom || !effectiveTo) {
      alert(
        "Đợt thuê phải có cả mốc bắt đầu và mốc kết thúc — công thức chia " +
          "tiền cần biết đợt dài bao nhiêu ngày làm việc.",
      );
      return;
    }
    if (effectiveTo <= effectiveFrom) {
      alert(
        "Mốc kết thúc phải SAU mốc bắt đầu.\n\n" +
          `Một ngày làm việc chạy từ ${boundaryTime} hôm trước tới ` +
          `${boundaryTime} hôm sau, nên hai mốc cùng ngày là một đợt rỗng.`,
      );
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      alert("Chi phí của đợt phải là số tiền không âm.");
      return;
    }

    const clash = state.draft.find(
      (r) =>
        r.id !== form.id &&
        r.workerName === workerName &&
        rangesOverlap(
          effectiveFrom,
          effectiveTo,
          r.effectiveFrom,
          r.effectiveTo,
        ),
    );
    if (clash) {
      alert(
        `Khoảng thời gian bị trùng với đợt đã có của "${workerName}": ` +
          `${fmtBoundary(clash.effectiveFrom)} → ${fmtBoundary(clash.effectiveTo)}.\n\n` +
          `Hai đợt nối tiếp thì dùng chung một mốc ${boundaryTime} là được ` +
          `(25/07 ${boundaryTime}→25/08 ${boundaryTime} rồi 25/08 ` +
          `${boundaryTime}→25/09 ${boundaryTime}).`,
      );
      return;
    }

    return run(async () => {
      await onSave({
        id: form.id,
        workerName,
        effectiveFrom,
        effectiveTo,
        amount,
        notes: form.notes.trim(),
        costMonth: form.costMonth || null,
      });
      /* Giữ nguyên tên để nhập tiếp đợt kế của cùng người, và mồi sẵn mốc
         bắt đầu bằng mốc kết thúc vừa nhập — đúng cách các đợt nối nhau. */
      setForm({
        ...EMPTY_FORM,
        workerName,
        effectiveFrom: effectiveTo,
      });
    });
  };

  const handleEdit = (r: LaborCostDraftRow) =>
    setForm({
      id: r.id,
      costMonth: r.costMonth ?? "",
      workerName: r.workerName,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      amount: String(r.amount),
      notes: r.notes ?? "",
    });

  const handleDelete = (r: LaborCostDraftRow) => {
    if (
      confirm(
        `Xoá đợt ${fmtBoundary(r.effectiveFrom)} → ${fmtBoundary(r.effectiveTo)} ` +
          `của ${r.workerName} khỏi bản nháp?\n\n` +
          "Báo cáo chưa đổi gì cho tới khi bấm “Áp dụng”.",
      )
    ) {
      return run(() => onDelete(r.id));
    }
  };

  /* ---- Áp dụng ------------------------------------------------------- */

  /** Bản nháp có khác lượt đang hiệu lực không — nút "Áp dụng" nói ra điều đó. */
  const draftDiffers = useMemo(() => {
    const key = (r: {
      workerName: string;
      effectiveFrom: string;
      effectiveTo: string;
      amount: number;
      costMonth: string | null;
    }) =>
      `${r.workerName}|${r.effectiveFrom}|${r.effectiveTo}|${r.amount}|${r.costMonth ?? ""}`;

    const a = state.draft.map(key).sort();
    const b = state.appliedRows.map(key).sort();
    return a.length !== b.length || a.some((k, i) => k !== b[i]);
  }, [state.draft, state.appliedRows]);

  const ruleChanged =
    state.effective !== null && effectiveRule !== state.effective.workDayRule;

  const handleApply = () => {
    const overlapping = state.draft.find((r) =>
      state.draft.some(
        (o) =>
          o.id !== r.id &&
          o.workerName === r.workerName &&
          rangesOverlap(
            r.effectiveFrom,
            r.effectiveTo,
            o.effectiveFrom,
            o.effectiveTo,
          ),
      ),
    );
    if (overlapping) {
      alert(
        `Không áp dụng được: "${overlapping.workerName}" có hai đợt giao nhau. ` +
          "Sửa lại rồi bấm Áp dụng.",
      );
      return;
    }

    const ok = confirm(
      `Áp dụng ${state.draft.length.toLocaleString("vi-VN")} đợt nhân công ` +
        `(${formatVND(draftTotal)}) vào báo cáo chi phí?\n\n` +
        `Ngày làm việc tính theo: ${LABOR_WORKDAY_RULE_LABEL[effectiveRule]}.\n` +
        "Lượt áp dụng trước vẫn được giữ lại trong lịch sử.",
    );
    if (!ok) return;

    return run(() => onApply(effectiveRule));
  };

  const handleRestore = (b: LaborCostBatch) => {
    if (
      confirm(
        `Nạp lại ${b.rowCountNum.toLocaleString("vi-VN")} đợt của lượt áp dụng ` +
          `lúc ${b.appliedAt} vào bản nháp?\n\n` +
          "Bản nháp hiện tại bị thay hoàn toàn. Báo cáo KHÔNG đổi cho tới khi " +
          "bấm “Áp dụng” lần nữa.",
      )
    ) {
      return run(() => onRestoreBatch(b.batchId));
    }
  };

  /* ---- Số của khoảng lọc --------------------------------------------- */

  const rangeAmount = laborTotalAmount(segments);
  const rangeDays = laborTotalWorkDays(segments);

  const label = "block text-[11px] font-semibold text-slate-600 mb-1";
  const field =
    "w-full px-2.5 py-2 bg-white border border-slate-300 rounded-lg text-xs focus:outline-none focus:border-teal-500";
  const cell = "border border-slate-300 px-3 py-2";

  return (
    <div className="space-y-6">
      {/* ---- Đầu trang ------------------------------------------------- */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200">
          <div className="text-sm font-bold text-slate-900 uppercase tracking-wide flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-teal-600" /> Chi phí thuê
            nhân công
          </div>
          <div className="text-xs text-slate-600 mt-1 leading-relaxed">
            Mỗi dòng là <strong>một người trong một đợt</strong>: số tiền ghi ở
            đây là tiền cho trọn đợt đó. Bảng kê chỉ lọc một quãng nên tiền
            được chia theo ngày làm việc rồi nhân lại với phần giao — xem bảng
            &ldquo;Tính cho khoảng đang lọc&rdquo; bên dưới.{" "}
            <strong className="text-teal-800">
              Sửa ở đây chưa ảnh hưởng báo cáo nào
            </strong>{" "}
            cho tới khi bấm &ldquo;Áp dụng&rdquo;.
          </div>
        </div>

        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="text-[11px] uppercase font-semibold text-slate-500">
              Bản nháp
            </div>
            <div className="text-lg font-black text-slate-900 mt-0.5">
              {state.draft.length.toLocaleString("vi-VN")} đợt
            </div>
            <div className="text-xs text-slate-500 font-mono">
              {formatVND(draftTotal)}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <div className="text-[11px] uppercase font-semibold text-slate-500">
              Đang áp dụng
            </div>
            <div className="text-lg font-black text-slate-900 mt-0.5">
              {state.effective
                ? `${state.effective.rowCountNum.toLocaleString("vi-VN")} đợt`
                : "Chưa áp dụng"}
            </div>
            <div className="text-xs text-slate-500">
              {state.effective
                ? `${state.effective.appliedAt}${
                    state.effective.appliedBy
                      ? ` · ${state.effective.appliedBy}`
                      : ""
                  }`
                : "Báo cáo đang tính 0 đồng nhân công"}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <div className="text-[11px] uppercase font-semibold text-slate-500">
              Ngày làm việc
            </div>
            <div className="text-sm font-bold text-slate-900 mt-1">
              {LABOR_WORKDAY_RULE_LABEL[effectiveRule]}
            </div>
            <div className="text-xs text-slate-500">
              Mẫu số của phép chia tiền
            </div>
          </div>

          <div className="rounded-xl border border-teal-300 bg-teal-50 p-3">
            <div className="text-[11px] uppercase font-semibold text-teal-700">
              Vào báo cáo kỳ này
            </div>
            <div className="text-lg font-black text-teal-900 mt-0.5">
              {formatVND(rangeAmount)}
            </div>
            <div className="text-xs text-teal-700">
              {rangeDays.toLocaleString("vi-VN")} ngày công · {startDate} &rarr;{" "}
              {endDate}
            </div>
          </div>
        </div>
      </div>

      {/* ---- Biểu mẫu + bản nháp --------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm h-fit">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 mb-1">
            {form.id === null ? (
              <>
                <UserPlus className="w-4 h-4 text-teal-600" /> Thêm Đợt Nhân
                Công
              </>
            ) : (
              <>
                <Pencil className="w-4 h-4 text-amber-600" /> Sửa Đợt #{form.id}
              </>
            )}
          </h3>
          <p className="text-[11px] text-slate-500 mb-4">
            Ghi vào bản nháp. Nhiều người cùng một khoảng thời gian là bình
            thường — mỗi người tính độc lập.
          </p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className={label}>
                Họ tên <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                required
                value={form.workerName}
                onChange={(e) => patch({ workerName: e.target.value })}
                placeholder="Nguyễn Văn A"
                className={`${field} font-semibold`}
              />
            </div>

            <div>
              <label className={label}>
                Tháng{" "}
                <span className="font-normal text-slate-400">
                  — điền sẵn hai mốc theo kỳ, sửa lại được
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="month"
                  value={form.costMonth}
                  onChange={(e) => handleMonthChange(e.target.value)}
                  className={`${field} font-semibold`}
                />
                {monthLoading && (
                  <Loader2 className="w-4 h-4 animate-spin text-teal-600 shrink-0" />
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={label}>
                  Từ <span className="text-red-500">*</span>
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="date"
                    required
                    value={
                      form.effectiveFrom
                        ? laborBoundaryDate(form.effectiveFrom)
                        : ""
                    }
                    onChange={(e) =>
                      patch({
                        effectiveFrom: e.target.value
                          ? laborWorkDayFromBoundary(e.target.value)
                          : "",
                      })
                    }
                    className={`${field} font-semibold`}
                  />
                  <span className="text-xs font-mono font-bold text-slate-600 shrink-0">
                    {boundaryTime}
                  </span>
                </div>
              </div>
              <div>
                <label className={label}>
                  Đến <span className="text-red-500">*</span>
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="date"
                    required
                    value={
                      form.effectiveTo ? laborBoundaryDate(form.effectiveTo) : ""
                    }
                    onChange={(e) =>
                      patch({
                        effectiveTo: e.target.value
                          ? laborWorkDayFromBoundary(e.target.value)
                          : "",
                      })
                    }
                    className={`${field} font-semibold`}
                  />
                  <span className="text-xs font-mono font-bold text-slate-600 shrink-0">
                    {boundaryTime}
                  </span>
                </div>
              </div>
            </div>
            <div className="text-[10px] text-slate-500 -mt-1">
              Một ngày làm việc = {boundaryTime} hôm trước &rarr; {boundaryTime}{" "}
              hôm sau.
            </div>

            {form.effectiveFrom && form.effectiveTo && (
              <div className="flex items-start gap-1.5 text-[11px] rounded-lg p-2 bg-slate-50 border border-slate-200 text-slate-700">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
                {form.effectiveTo <= form.effectiveFrom ? (
                  <span className="text-red-700 font-semibold">
                    Mốc kết thúc phải sau mốc bắt đầu.
                  </span>
                ) : (
                  <span>
                    Đợt chạy từ{" "}
                    <strong>{fmtBoundary(form.effectiveFrom)}</strong> đến{" "}
                    <strong>{fmtBoundary(form.effectiveTo)}</strong> ={" "}
                    <strong className="font-mono">
                      {countLaborWorkDays(
                        form.effectiveFrom,
                        form.effectiveTo,
                        effectiveRule,
                      ).toLocaleString("vi-VN")}
                    </strong>{" "}
                    ngày làm việc ({fmtDate(form.effectiveFrom)} &rarr;{" "}
                    {fmtDate(addDays(form.effectiveTo, -1))}).
                  </span>
                )}
              </div>
            )}

            <div>
              <label className={label}>
                Chi phí trọn đợt (VNĐ) <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                required
                min={0}
                step={1000}
                value={form.amount}
                onChange={(e) => patch({ amount: e.target.value })}
                placeholder="7000000"
                className={`${field} font-mono font-bold text-teal-800`}
              />
            </div>

            <div>
              <label className={label}>Ghi chú</label>
              <input
                type="text"
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
                className={field}
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={busy}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-teal-600 hover:bg-teal-700 disabled:bg-slate-300 text-white rounded-lg text-xs font-bold transition"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                {form.id === null ? "Thêm Vào Bản Nháp" : "Lưu Thay Đổi"}
              </button>
              {form.id !== null && (
                <button
                  type="button"
                  onClick={() => setForm(EMPTY_FORM)}
                  className="px-3 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Bảng bản nháp + nút Áp dụng */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-slate-900">
                Bản nháp nhân công
              </div>
              <div className="text-xs text-slate-600 mt-0.5">
                Chưa vào báo cáo. Bấm &ldquo;Áp dụng&rdquo; mới ghi thành một
                lượt và tiền mới xuất hiện trên các bảng kê.
              </div>
            </div>

            <div className="flex items-end gap-2">
              <div>
                <label className={label}>Ngày làm việc</label>
                <select
                  value={effectiveRule}
                  onChange={(e) =>
                    setRule(e.target.value as LaborWorkDayRule)
                  }
                  className={`${field} font-semibold`}
                >
                  {LABOR_WORKDAY_RULES.map((r) => (
                    <option key={r} value={r}>
                      {LABOR_WORKDAY_RULE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={handleApply}
                disabled={busy || loading}
                title="Chụp bản nháp thành một lượt áp dụng mới"
                className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold transition shadow-sm shrink-0"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                Áp Dụng
              </button>
            </div>
          </div>

          {(draftDiffers || ruleChanged) && (
            <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex items-start gap-2 text-[11px] text-amber-900">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                {draftDiffers && (
                  <>
                    Bản nháp đang <strong>khác</strong> với lượt đang áp dụng.{" "}
                  </>
                )}
                {ruleChanged && (
                  <>
                    Quy tắc ngày làm việc đang chọn khác với quy tắc của lượt
                    đang áp dụng (
                    {LABOR_WORKDAY_RULE_LABEL[state.effective!.workDayRule]}).{" "}
                  </>
                )}
                Số liệu trên các bảng kê vẫn là của lượt đã áp dụng cho tới khi
                bấm &ldquo;Áp dụng&rdquo;.
              </span>
            </div>
          )}

          <div className="overflow-x-auto max-h-[380px]">
            {loading ? (
              <p className="text-xs text-slate-400 p-6 flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang đọc dữ
                liệu nhân công…
              </p>
            ) : state.draft.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-10">
                Bản nháp trống. Thêm đợt đầu tiên ở biểu mẫu bên trái.
              </p>
            ) : (
              <table className="w-full text-left text-[13px] border-collapse">
                <thead className="bg-slate-100 text-slate-700 font-bold uppercase text-[11px] sticky top-0">
                  <tr>
                    <th className={cell}>Họ Tên</th>
                    <th className={`${cell} text-center`}>Tháng</th>
                    <th className={cell}>Từ</th>
                    <th className={cell}>Đến</th>
                    <th className={`${cell} text-center`}>Ngày LV</th>
                    <th className={`${cell} text-right`}>Chi Phí</th>
                    <th className={`${cell} text-right`}>Đơn Giá/Ngày</th>
                    <th className={`${cell} text-center`}>Sửa</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {state.draft.map((r) => {
                    const days = draftWorkDays(r);
                    return (
                      <tr key={r.id} className="hover:bg-slate-50">
                        <td className={`${cell} font-bold text-slate-900`}>
                          {r.workerName}
                          {r.notes && (
                            <div className="text-[11px] font-normal text-slate-500">
                              {r.notes}
                            </div>
                          )}
                        </td>
                        <td
                          className={`${cell} text-center font-mono text-slate-600 whitespace-nowrap`}
                          title="Tháng gán cho đợt — chỉ là nhãn, tiền chia theo Từ – Đến"
                        >
                          {monthOf(r) ?? "—"}
                        </td>
                        {/* Hiện hai MỐC 22:50 chứ không hiện ngày thô: một
                            ngày làm việc bắt đầu từ tối hôm trước, và đó là
                            chỗ hiểu nhầm dễ xảy ra nhất. */}
                        <td
                          className={`${cell} font-mono whitespace-nowrap`}
                          title={`Ngày làm việc đầu tiên: ${fmtDate(r.effectiveFrom)}`}
                        >
                          {fmtBoundary(r.effectiveFrom)}
                        </td>
                        <td
                          className={`${cell} font-mono whitespace-nowrap text-teal-800`}
                          title={`Ngày làm việc cuối cùng: ${fmtDate(addDays(r.effectiveTo, -1))}`}
                        >
                          {fmtBoundary(r.effectiveTo)}
                        </td>
                        <td className={`${cell} text-center font-mono`}>
                          {days.toLocaleString("vi-VN")}
                        </td>
                        <td
                          className={`${cell} text-right font-mono font-bold text-slate-900 whitespace-nowrap`}
                        >
                          {formatVND(r.amount)}
                        </td>
                        <td
                          className={`${cell} text-right font-mono text-slate-600 whitespace-nowrap`}
                        >
                          {days > 0
                            ? formatVND(Math.round(r.amount / days))
                            : "-"}
                        </td>
                        <td className={`${cell} text-center whitespace-nowrap`}>
                          <button
                            type="button"
                            onClick={() => handleEdit(r)}
                            disabled={busy}
                            className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(r)}
                            disabled={busy}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-800 text-white font-bold text-xs">
                  <tr>
                    <td className={cell} colSpan={5}>
                      TỔNG BẢN NHÁP
                    </td>
                    <td
                      className={`${cell} text-right font-mono text-amber-400 whitespace-nowrap`}
                    >
                      {formatVND(draftTotal)}
                    </td>
                    <td className={cell} colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* ---- Tính cho khoảng đang lọc ---------------------------------- */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200">
          <div className="text-sm font-bold text-slate-900 uppercase tracking-wide flex items-center gap-2">
            <CalendarRange className="w-4 h-4 text-teal-600" /> Tính cho khoảng
            đang lọc — {startDate} &rarr; {endDate}
          </div>
          <div className="text-xs text-slate-600 mt-1 leading-relaxed">
            Khoảng lọc được cắt thành các đoạn giao với từng đợt thuê, và chỉ
            phần giao mới được tính tiền. Đây chính là những con số đi vào thẻ
            &ldquo;Chi Phí Nhân Công&rdquo;, bảng kê tháng và các bảng phân bổ
            — lấy từ <strong>lượt áp dụng đang có hiệu lực</strong>, không phải
            từ bản nháp.
          </div>
        </div>

        <div className="overflow-x-auto">
          {segments.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-10">
              {state.effective === null
                ? "Chưa có lượt áp dụng nào — chi phí nhân công trong mọi báo cáo đang là 0."
                : "Không có đợt nhân công nào giao với khoảng thời gian đang lọc."}
            </p>
          ) : (
            <table className="w-full text-left text-[13px] border-collapse">
              <thead className="bg-slate-900 text-white font-bold uppercase text-[11px]">
                <tr>
                  <th className={`${cell} border-slate-700`}>Họ Tên</th>
                  <th className={`${cell} border-slate-700`}>Đợt Thuê</th>
                  <th className={`${cell} border-slate-700 text-right`}>
                    Chi Phí Đợt
                  </th>
                  <th className={`${cell} border-slate-700 text-center`}>
                    Ngày LV Đợt
                  </th>
                  <th className={`${cell} border-slate-700 bg-teal-800`}>
                    Đoạn Giao Với Bộ Lọc
                  </th>
                  <th
                    className={`${cell} border-slate-700 bg-teal-800 text-center`}
                  >
                    Ngày LV Đoạn
                  </th>
                  <th className={`${cell} border-slate-700 text-right`}>
                    Đơn Giá/Ngày
                  </th>
                  <th
                    className={`${cell} border-slate-700 bg-emerald-600 text-slate-950 text-right`}
                  >
                    Thành Tiền
                  </th>
                </tr>
              </thead>
              <tbody>
                {segments.map((s) => (
                  <tr key={s.key} className="hover:bg-teal-50/50 transition">
                    <td className={`${cell} font-bold text-slate-900`}>
                      {s.workerName}
                    </td>
                    <td className={`${cell} font-mono whitespace-nowrap`}>
                      {fmtBoundary(s.periodFrom)} &rarr;{" "}
                      {fmtBoundary(s.periodTo)}
                    </td>
                    <td
                      className={`${cell} text-right font-mono whitespace-nowrap`}
                    >
                      {formatVND(s.periodAmount)}
                    </td>
                    <td className={`${cell} text-center font-mono`}>
                      {s.periodWorkDays.toLocaleString("vi-VN")}
                    </td>
                    <td
                      className={`${cell} font-mono whitespace-nowrap bg-teal-50 text-teal-900 font-semibold`}
                    >
                      {fmtBoundary(s.from)} &rarr; {fmtBoundary(s.toExclusive)}
                      {s.isFullPeriod && (
                        <span className="ml-1.5 text-[10px] font-bold uppercase text-emerald-700">
                          trọn đợt
                        </span>
                      )}
                    </td>
                    <td
                      className={`${cell} text-center font-mono bg-teal-50 text-teal-900 font-bold`}
                    >
                      {s.workDays.toLocaleString("vi-VN")}
                    </td>
                    <td
                      className={`${cell} text-right font-mono text-slate-600 whitespace-nowrap`}
                    >
                      {formatVND(Math.round(s.dailyRate))}
                    </td>
                    <td
                      className={`${cell} text-right font-mono font-extrabold text-slate-900 whitespace-nowrap`}
                    >
                      {formatVND(s.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-900 text-white font-extrabold uppercase text-xs">
                <tr>
                  <td className={`${cell} border-slate-700`} colSpan={5}>
                    Tổng chi phí nhân công của khoảng lọc
                  </td>
                  <td
                    className={`${cell} border-slate-700 text-center font-mono text-amber-400`}
                  >
                    {rangeDays.toLocaleString("vi-VN")}
                  </td>
                  <td className={`${cell} border-slate-700`} />
                  <td
                    className={`${cell} border-slate-700 text-right font-mono text-emerald-400 whitespace-nowrap`}
                  >
                    {formatVND(rangeAmount)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <div className="px-4 py-3 bg-slate-50 border-t border-slate-300 text-xs text-slate-600 leading-relaxed">
          Công thức của mỗi đoạn:{" "}
          <strong>
            chi phí đợt ÷ số ngày làm việc của cả đợt × số ngày làm việc của
            đoạn
          </strong>
          . Đoạn nào trùng khít cả đợt thì lấy thẳng số tiền đã nhập, không có
          sai số làm tròn. Ngày làm việc đang tính theo{" "}
          <strong>{LABOR_WORKDAY_RULE_LABEL[effectiveRule]}</strong>
          {state.effective && effectiveRule !== state.effective.workDayRule && (
            <>
              {" "}
              (bảng này đang xem thử theo quy tắc mới; báo cáo vẫn dùng{" "}
              <strong>
                {LABOR_WORKDAY_RULE_LABEL[state.effective.workDayRule]}
              </strong>{" "}
              cho tới khi bấm &ldquo;Áp dụng&rdquo;)
            </>
          )}
          . Một ngày làm việc chạy từ {boundaryTime} hôm trước tới{" "}
          {boundaryTime} hôm sau, nên mọi mốc ở đây đều là {boundaryTime}: đợt
          25/07 {boundaryTime} &rarr; 25/08 {boundaryTime} gồm 31 ngày làm việc
          26/07 &rarr; 25/08. Hai đợt nối tiếp dùng chung một mốc mà không ngày
          nào bị tính hai lần hay rơi mất.
        </div>
      </div>

      {/* ---- Lịch sử áp dụng ------------------------------------------- */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200">
          <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
            <History className="w-4 h-4 text-slate-500" /> Lịch sử áp dụng
          </div>
          <div className="text-xs text-slate-600 mt-0.5">
            Mỗi lần bấm &ldquo;Áp dụng&rdquo; là một dòng, không lượt nào ghi
            đè lượt nào. Báo cáo dùng lượt <strong>mới nhất</strong>;
            &ldquo;Nạp lại&rdquo; đưa nội dung một lượt cũ về bản nháp để sửa
            tiếp.
          </div>
        </div>

        <div className="overflow-x-auto max-h-72">
          {state.batches.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-8">
              Chưa từng áp dụng lượt nào.
            </p>
          ) : (
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-100 text-slate-700 font-bold uppercase sticky top-0">
                <tr>
                  <th className={cell}>Thời Điểm</th>
                  <th className={cell}>Người Áp Dụng</th>
                  <th className={cell}>Ngày Làm Việc</th>
                  <th className={`${cell} text-center`}>Số Đợt</th>
                  <th className={`${cell} text-right`}>Tổng Chi Phí</th>
                  <th className={`${cell} text-center`}>Trạng Thái</th>
                  <th className={`${cell} text-center`}>Nạp Lại</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.batches.map((b, i) => (
                  <tr
                    key={b.batchId}
                    className={i === 0 ? "bg-teal-50/60" : "hover:bg-slate-50"}
                  >
                    <td
                      className={`${cell} font-semibold text-slate-900 whitespace-nowrap`}
                    >
                      {b.appliedAt}
                    </td>
                    <td className={`${cell} text-slate-700`}>
                      {b.appliedBy || "-"}
                    </td>
                    <td className={`${cell} text-slate-700`}>
                      {LABOR_WORKDAY_RULE_LABEL[b.workDayRule]}
                    </td>
                    <td className={`${cell} text-center font-mono`}>
                      {b.rowCountNum.toLocaleString("vi-VN")}
                    </td>
                    <td
                      className={`${cell} text-right font-mono font-bold whitespace-nowrap`}
                    >
                      {formatVND(b.totalAmount)}
                    </td>
                    <td className={`${cell} text-center`}>
                      {i === 0 ? (
                        <span className="px-2 py-0.5 rounded border border-teal-300 bg-teal-100 text-teal-900 font-bold">
                          Đang áp dụng
                        </span>
                      ) : (
                        <span className="text-slate-400">Đã thay thế</span>
                      )}
                    </td>
                    <td className={`${cell} text-center`}>
                      <button
                        type="button"
                        onClick={() => handleRestore(b)}
                        disabled={busy}
                        title="Đưa nội dung lượt này về bản nháp"
                        className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-700 rounded text-[11px] font-bold transition"
                      >
                        {i === 0 ? (
                          <RotateCcw className="w-3 h-3" />
                        ) : (
                          <Undo2 className="w-3 h-3" />
                        )}
                        Nạp lại
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
