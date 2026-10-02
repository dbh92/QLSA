import React, { useMemo, useState } from "react";
import {
  MealPriceItem,
  ShiftInfo,
  ShiftCode,
  StaffType,
  MealCategory,
  ShiftMealCategory,
} from "../types";
import {
  formatVND,
  buildMealPricing,
  buildShiftCategoryLookup,
  classifyMeal,
  reportShiftLabel,
  MEAL_CATEGORY_META,
} from "../services/mealEngine";
import { Coins, Save, RotateCcw, Clock, Info, Cake } from "lucide-react";

interface MealPriceConfigViewProps {
  priceItems: MealPriceItem[];
  shifts: ShiftInfo[];
  shiftMealCategories: ShiftMealCategory[];
  /** Các ca được ăn suất sinh nhật (SA_SystemSetting: BIRTHDAY_SHIFTS). */
  birthdayShifts: Set<ShiftCode>;
  /** Lưu đơn giá mới của một mã (VNĐ) rồi nạp lại bảng giá. */
  onSave: (code: string, unitPrice: number) => Promise<void>;
  /** Gán loại suất cho một ô (ca × nhóm nhân sự). */
  onSaveShiftCategory: (entry: ShiftMealCategory) => Promise<void>;
}

/**
 * Thứ tự hiển thị các loại suất sửa được ở màn hình này — cũng là danh sách
 * chọn được ở bảng theo ca.
 *
 * KHÔNG có `VN_SINHNHAT`: đơn giá suất sinh nhật là của TỪNG NGÀY và chỉ được
 * cấu hình ở tab "Cấu Hình Sinh Nhật" (SA_BirthdayConfig.SpecialMealPrice).
 * Giữ thêm một ô đơn giá chung ở đây là tạo ra hai nguồn cho cùng một con số,
 * và người dùng sửa ô nào cũng thấy báo cáo không đổi theo ý mình.
 */
const CATEGORY_ORDER: MealCategory[] = [
  "KO_COM",
  "KO_MY",
  "VN_CHINH",
  "VN_PHU",
];

/** Mã giá -> loại suất dùng nó, để lọc bảng đơn giá còn đúng các dòng trên. */
const CATEGORY_OF_CODE = CATEGORY_ORDER.reduce(
  (acc, category) => {
    acc[MEAL_CATEGORY_META[category].code] = category;
    return acc;
  },
  {} as Record<string, MealCategory>,
);

export const MealPriceConfigView: React.FC<MealPriceConfigViewProps> = ({
  priceItems,
  shifts,
  shiftMealCategories,
  birthdayShifts,
  onSave,
  onSaveShiftCategory,
}) => {
  /** "23H (CA1), 12H (CA4)" — đọc được ngay ca nào ăn suất sinh nhật. */
  const birthdayShiftLabel = Array.from(birthdayShifts)
    .map((code) => `${reportShiftLabel(code)} (${code})`)
    .join(", ");

  /* Giá đang gõ dở, theo mã. Mã nào chưa động tới thì không có trong map và
     lấy thẳng giá từ SA_MealPrice. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyCode, setBusyCode] = useState<string | null>(null);
  /** Ô (ca × nhóm) đang gọi API, dạng "CA1|KR". */
  const [busyCell, setBusyCell] = useState<string | null>(null);

  /** Bảng giá đang có hiệu lực — cùng hàm với Dashboard và Báo Cáo Chi Phí. */
  const pricing = useMemo(() => buildMealPricing(priceItems), [priceItems]);

  const shiftCategories = useMemo(
    () => buildShiftCategoryLookup(shiftMealCategories),
    [shiftMealCategories],
  );

  /* Chỉ 5 loại suất thực sự vào công thức tính tiền. Các mã khác trong
     SA_MealPrice (suất ăn nhẹ, sữa…) không màn hình nào đọc nên không hiện. */
  const editableItems = useMemo(
    () =>
      CATEGORY_ORDER.map((category) =>
        priceItems.find(
          (p) => p.code === MEAL_CATEGORY_META[category].code,
        ),
      ).filter((p): p is MealPriceItem => Boolean(p)),
    [priceItems],
  );

  const draftOf = (item: MealPriceItem) =>
    drafts[item.code] ?? String(item.unitPrice);

  const isDirty = (item: MealPriceItem) => {
    const draft = drafts[item.code];
    return draft !== undefined && Number(draft) !== item.unitPrice;
  };

  const clearDraft = (code: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[code];
      return next;
    });

  const handleSave = async (item: MealPriceItem) => {
    const value = Number(drafts[item.code]);
    if (!Number.isFinite(value) || value < 0) {
      alert("Đơn giá phải là số không âm (VNĐ).");
      return;
    }

    setBusyCode(item.code);
    try {
      await onSave(item.code, value);
      // Lưu xong thì bỏ bản nháp để ô nhập bám theo giá mới từ SQL Server.
      clearDraft(item.code);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Lưu đơn giá thất bại.");
    } finally {
      setBusyCode(null);
    }
  };

  const handleAssign = async (
    shiftCode: ShiftCode,
    staffType: StaffType,
    mealCategory: MealCategory,
  ) => {
    setBusyCell(`${shiftCode}|${staffType}`);
    try {
      await onSaveShiftCategory({ shiftCode, staffType, mealCategory });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gán loại suất thất bại.");
    } finally {
      setBusyCell(null);
    }
  };

  /* Danh sách ca của bảng gán: 6 ca trong SA_Shift + 'Khác' cho lượt quẹt
     ngoài khung giờ. Loại suất đang áp lấy qua chính classifyMeal nên ô nào
     chưa được gán vẫn hiện đúng giá trị mặc định hệ thống đang dùng. */
  const shiftRows = useMemo(() => {
    const rows: { code: ShiftCode; label: string; range: string }[] = shifts.map(
      (s) => ({
        code: s.code,
        label: s.name,
        range: `${s.startTime.slice(0, 5)} - ${s.endTime.slice(0, 5)}`,
      }),
    );

    rows.push({ code: "Khác", label: "Ngoài ca", range: "Giờ khác" });
    return rows;
  }, [shifts]);

  /** Ô chọn loại suất cho một (ca, nhóm nhân sự). */
  const CategoryCell: React.FC<{
    shiftCode: ShiftCode;
    staffType: StaffType;
  }> = ({ shiftCode, staffType }) => {
    const current = classifyMeal(
      shiftCode,
      staffType === "KR",
      false,
      shiftCategories,
    );
    const busy = busyCell === `${shiftCode}|${staffType}`;
    const tone = staffType === "KR" ? "text-red-700" : "text-indigo-700";

    /* Ô nào còn mang loại suất đã rút khỏi màn hình (dữ liệu gán từ trước)
       vẫn phải hiện đúng giá trị đang lưu, nếu không thẻ select sẽ tự nhảy
       sang dòng đầu và người dùng tưởng cấu hình đã đổi. Đổi sang loại khác
       thì nó biến mất khỏi danh sách. */
    const options = CATEGORY_ORDER.includes(current)
      ? CATEGORY_ORDER
      : [...CATEGORY_ORDER, current];

    return (
      <td className="py-2.5 px-4">
        <div className="flex items-center gap-2">
          <select
            value={current}
            disabled={busy}
            onChange={(e) =>
              handleAssign(
                shiftCode,
                staffType,
                e.target.value as MealCategory,
              )
            }
            className="px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
          >
            {options.map((cat) => (
              <option key={cat} value={cat}>
                {MEAL_CATEGORY_META[cat].label}
              </option>
            ))}
          </select>
          <span className={`font-mono font-bold whitespace-nowrap ${tone}`}>
            {busy ? "Đang lưu…" : formatVND(pricing[current])}
          </span>
        </div>
      </td>
    );
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-emerald-700 via-teal-700 to-slate-800 p-5 rounded-2xl text-white shadow-lg flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start space-x-3">
          <div className="p-2.5 bg-white/20 rounded-xl backdrop-blur-md">
            <Coins className="w-6 h-6 text-amber-200" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Cấu Hình Giá Suất Ăn (VNĐ)</h2>
            <p className="text-xs text-emerald-100 mt-1">
              Sửa đơn giá hoặc đổi loại suất của từng ca tại đây là toàn hệ
              thống tính lại ngay: Dashboard, Hàn Quốc vs Việt Nam, Suất Ăn Mất
              Mát, Báo Cáo Chi Phí và biểu đồ xu hướng năm.
            </p>
          </div>
        </div>
      </div>

      {/* Bảng đơn giá 5 loại suất */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2 text-xs font-semibold text-slate-600">
          <span className="flex items-center gap-2">
            <Coins className="w-4 h-4 text-emerald-600" />
            <span>Đơn giá {editableItems.length} loại suất ăn</span>
          </span>
          <span className="text-slate-500">
            Sửa ô đơn giá rồi bấm <strong className="text-slate-700">Lưu</strong>{" "}
            trên đúng dòng đó.
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-900 text-white font-bold uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-3.5 px-4 border-b border-slate-800">
                  Loại suất
                </th>
                <th className="py-3.5 px-4 border-b border-slate-800">Mã</th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center">
                  Đơn vị
                </th>
                <th className="py-3.5 px-4 border-b border-slate-800 text-right bg-amber-600 text-slate-950 font-extrabold whitespace-nowrap">
                  Đơn giá (VNĐ)
                </th>
                <th className="py-3.5 px-3 border-b border-slate-800 text-center">
                  Thao tác
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-800">
              {editableItems.map((item) => {
                const category = CATEGORY_OF_CODE[item.code];
                const dirty = isDirty(item);
                const busy = busyCode === item.code;

                return (
                  <tr
                    key={item.code}
                    className={`transition ${dirty ? "bg-amber-50/70" : "hover:bg-slate-50"}`}
                  >
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                        {MEAL_CATEGORY_META[category].label}
                      </span>
                      <div className="text-slate-500 mt-1">{item.name}</div>
                    </td>
                    <td className="py-3 px-4 font-mono font-bold text-slate-900 whitespace-nowrap">
                      {item.code}
                    </td>
                    <td className="py-3 px-3 text-center text-slate-500">
                      {item.unit}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <input
                        type="number"
                        min={0}
                        step={1000}
                        value={draftOf(item)}
                        disabled={busy}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [item.code]: e.target.value,
                          }))
                        }
                        className="w-32 px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-right font-mono font-bold text-slate-900 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                      />
                      <div className="text-[11px] text-slate-500 mt-1 font-mono">
                        {dirty
                          ? `Giá đang dùng ${formatVND(item.unitPrice)}`
                          : formatVND(item.unitPrice)}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-center whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleSave(item)}
                          disabled={!dirty || busy}
                          className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white rounded-lg text-[11px] font-semibold transition inline-flex items-center gap-1.5"
                        >
                          <Save className="w-3.5 h-3.5" />
                          {busy ? "Đang lưu…" : "Lưu"}
                        </button>
                        <button
                          type="button"
                          onClick={() => clearDraft(item.code)}
                          disabled={!dirty || busy}
                          className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition"
                          title="Bỏ thay đổi"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Gán loại suất cho từng ca */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2 text-xs font-semibold text-slate-600">
          <span className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-600" />
            <span>Giá áp dụng cho từng ca</span>
          </span>
          <span className="text-slate-500">
            Đổi loại suất trong ô là lưu ngay vào SQL Server.
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-900 text-white font-bold uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-3.5 px-4 border-b border-slate-800">Ca</th>
                <th className="py-3.5 px-4 border-b border-slate-800">
                  Khung giờ
                </th>
                <th className="py-3.5 px-4 border-b border-slate-800 bg-red-900/60 text-red-200">
                  Người Hàn
                </th>
                <th className="py-3.5 px-4 border-b border-slate-800 bg-blue-900/60 text-blue-200">
                  Người Việt
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-800">
              {shiftRows.map((row) => (
                <tr key={row.code} className="hover:bg-amber-50/40 transition">
                  <td className="py-2.5 px-4 font-bold text-slate-900 whitespace-nowrap">
                    {row.code}{" "}
                    <span className="font-normal text-slate-500">
                      {row.label}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 font-mono text-slate-600">
                    {row.range}
                  </td>
                  <CategoryCell shiftCode={row.code} staffType="KR" />
                  <CategoryCell shiftCode={row.code} staffType="VN" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-500 space-y-1">
          <div className="flex items-start gap-1.5">
            <Cake className="w-3.5 h-3.5 text-pink-600 shrink-0 mt-px" />
            <span>
              <strong>Suất sinh nhật không cấu hình ở đây.</strong> Ngày có
              trong <strong>Cấu Hình Sinh Nhật</strong> thì suất của người Việt
              trong các <strong>ca ăn sinh nhật</strong> ({birthdayShiftLabel})
              ăn <strong>đơn giá của chính ngày đó</strong>, khai báo ngay
              trong tab Cấu Hình Sinh Nhật — mỗi ngày một giá — và đè lên cấu
              hình theo ca ở bảng trên. Các ca khác trong cùng ngày và suất của
              người Hàn không bị đè. Ngày đối chiếu là{" "}
              <strong>ngày của ca</strong>: ca đêm chạy từ 22:50 tới 01:50 hôm
              sau nên cả đoạn sau nửa đêm vẫn thuộc ngày sinh nhật.
            </span>
          </div>
          <div className="flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-px" />
            <span>
              Một lượt quẹt tính theo cột <strong>Người Hàn</strong> khi nhân sự
              thuộc bộ phận lớn KR — ở mọi máy chấm. Bộ phận khác quẹt máy CT
              Korea vẫn tính theo cột Người Việt. Cột nào cũng gán được cả 5 loại
              suất — đây là bảng giá, không phải bảng quy tắc quốc tịch.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
