/**
 * Lớp gọi API tới Express server (server/index.js).
 * Mọi endpoint đều là lớp bọc mỏng quanh một stored procedure SA_* trong QLSA.
 *
 * Đường dẫn là tương đối (/api/...) — khi chạy dev thì Vite proxy sang cổng
 * 4000, khi chạy production thì Express phục vụ cả frontend lẫn API.
 */
import {
  MealLog,
  DepartmentMapping,
  LargeDepartmentInfo,
  SmallDepartmentInfo,
  ShiftInfo,
  ReaderInfo,
  MealPriceItem,
  DailyMilkEntry,
  ExtraCostEntry,
  BirthdayConfig,
  ManualMealEntry,
  MonthlyCostRow,
  CostMonthPeriod,
  SystemSettings,
  ShiftMealCategory,
  GuestDeptOverride,
  GuestDeptPeriod,
  LaborCostState,
  LaborCostBatch,
  LaborCostAppliedRow,
  LaborWorkDayRule,
} from '../types';

const BASE = '/api';

/** Lỗi trả về từ API, giữ nguyên thông điệp tiếng Việt của server / stored procedure. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      /* Cookie phiên là httpOnly nên JS không đọc được nó; `same-origin` bảo
         trình duyệt tự đính kèm vào mỗi request. Thiếu dòng này thì mọi lời
         gọi đều bị trả 401. */
      credentials: 'same-origin',
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'Không kết nối được tới máy chủ API. Kiểm tra "npm run server".');
  }

  if (!response.ok) {
    let message = `Lỗi ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      /* phản hồi không phải JSON — giữ thông điệp mặc định */
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

/* -------------------------------------------------------------------------
   Đăng nhập
   -------------------------------------------------------------------------
   Mật khẩu chỉ đi trong thân request lúc đăng nhập rồi thôi; phía client
   KHÔNG lưu lại mật khẩu ở bất kỳ đâu. Việc nhớ đăng nhập do cookie phiên
   httpOnly đảm nhiệm, JavaScript của trang không đọc được nó. */

export interface AuthUser {
  username: string;
  displayName: string;
  /** "YYYY-MM-DD HH:mm:ss" — thời điểm phiên hết hạn. */
  expiresAt?: string;
}

export const login = (username: string, password: string, remember: boolean) =>
  post<AuthUser>('/auth/login', { username, password, remember });

export const logout = () => post<{ ok: boolean }>('/auth/logout', {});

/** Trả về null khi chưa đăng nhập hoặc phiên đã hết hạn. */
export const fetchCurrentUser = async (): Promise<AuthUser | null> => {
  try {
    return await request<AuthUser>('/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
};

const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/* -------------------------------------------------------------------------
   Khởi động — toàn bộ danh mục trong 1 lượt gọi
   ------------------------------------------------------------------------- */

export interface BootstrapConfig {
  shifts: ShiftInfo[];
  readers: ReaderInfo[];
  largeDepartments: LargeDepartmentInfo[];
  mappings: DepartmentMapping[];
  priceItems: MealPriceItem[];
  settings: SystemSettings;
  monthlyCosts: MonthlyCostRow[];
  shiftMealCategories: ShiftMealCategory[];
}

export const fetchBootstrap = () => request<BootstrapConfig>('/bootstrap');

/* -------------------------------------------------------------------------
   Log chấm ăn
   ------------------------------------------------------------------------- */

export const fetchMealLogs = (from: string, to: string) =>
  request<MealLog[]>(`/meal-logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

/** Chi phí 12 tháng của một năm, tổng hợp sẵn trên SQL Server. */
export const fetchMonthlyCostTrend = (year: number) =>
  request<MonthlyCostRow[]>(`/monthly-cost-trend?year=${year}`);

/** Kỳ tính chi phí của 12 tháng một năm — xem `CostMonthPeriod`. */
export const fetchCostMonthPeriods = (year: number) =>
  request<CostMonthPeriod[]>(`/cost-month-periods?year=${year}`);

/**
 * Lưu kỳ của CẢ NĂM: đủ 12 kỳ, hoặc mảng rỗng để cả năm quay về kỳ mặc định.
 * Procedure từ chối kỳ chồng nhau bằng một câu tiếng Việt nêu rõ hai tháng.
 */
export const saveCostMonthPeriods = (
  year: number,
  periods: { monthNo: number; fromDateTime: string; toDateTime: string }[],
) =>
  request<CostMonthPeriod[]>(`/cost-month-periods/${year}`, {
    method: 'PUT',
    body: JSON.stringify({ periods }),
  });

/* -------------------------------------------------------------------------
   Lượt quẹt đã xóa — popup "Điều Chỉnh Số Liệu"
   -------------------------------------------------------------------------
   Xóa ở đây ghi thẳng xuống cơ sở dữ liệu và áp cho toàn hệ thống. Bản sao
   đầy đủ của dòng bị xóa nằm trong QLSA.dbo.TB_EVENT_LOG_DEL nên khôi phục
   được nguyên vẹn theo từng lượt xóa. */

/** Một LƯỢT XÓA — mỗi lần bấm "Áp dụng" trong popup là một lượt. */
export interface MealLogDeletionBatch {
  batchId: string;
  /** "YYYY-MM-DD HH:mm:ss" — thời điểm bấm xóa. */
  deletedAt: string;
  deletedBy: string | null;
  reason: string | null;
  punchCount: number;
  /**
   * Bao nhiêu dòng của lượt xóa là SUẤT MẤT MÁT — vẫn hiện ở tab Suất Ăn Mất
   * Mát; phần còn lại là "xóa suất ăn bất kỳ", biến mất khỏi mọi màn hình.
   */
  lossPunchCount: number;
  /** Lượt quẹt sớm nhất / muộn nhất trong lượt xóa này. */
  firstPunchAt: string;
  lastPunchAt: string;
  /** Bao nhiêu lượt của lượt xóa này rơi vào khoảng ngày đang lọc. */
  punchCountInRange: number;
}

export const fetchMealLogDeletions = (from?: string, to?: string) => {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  const qs = q.toString();
  return request<MealLogDeletionBatch[]>(
    `/meal-log-deletions${qs ? `?${qs}` : ''}`
  );
};

export interface MealLogDeletionResult {
  batchId: string;
  /** Số lượt thực sự bị xóa; nhỏ hơn `requested` nếu có lượt đã xóa từ trước. */
  deleted: number;
  requested: number;
}

/**
 * Xóa hẳn các lượt quẹt khỏi hệ thống (vẫn lưu lại để khôi phục), trong MỘT
 * lượt xóa.
 *
 * `lossIds` là suất mất mát do chấm thẻ sai: bị trừ khỏi mọi con số nhưng tab
 * Suất Ăn Mất Mát vẫn hiển thị y nguyên. `ids` là khoản "xóa suất ăn bất kỳ":
 * biến mất khỏi tất cả. Một trong hai được phép rỗng.
 *
 * `from` / `to` ("YYYY-MM-DD HH:mm:ss") là khoảng chứa các lượt quẹt này —
 * không phải bộ lọc, chỉ để procedure tìm chúng bằng index thay vì quét cả
 * bảng 3,3 triệu dòng của BioStar. Truyền đúng biên của khoảng mà `ids` được
 * lấy ra, nếu không sẽ có lượt không xóa được.
 */
export const deleteMealLogs = (
  ids: string[],
  lossIds: string[],
  reason: string,
  from?: string,
  to?: string
) =>
  post<MealLogDeletionResult>('/meal-log-deletions', {
    ids,
    lossIds,
    reason,
    from,
    to,
  });

/** Khôi phục trọn một lượt xóa. */
export const restoreMealLogDeletion = (batchId: string) =>
  del<{ restored: number }>(
    `/meal-log-deletions/${encodeURIComponent(batchId)}`
  );

/* -------------------------------------------------------------------------
   Đơn giá suất ăn
   ------------------------------------------------------------------------- */

export const fetchMealPrices = () => request<MealPriceItem[]>('/prices');

/** Sửa đơn giá một mã suất ăn (VNĐ). Trả về bảng giá đầy đủ sau khi lưu. */
export const saveMealPrice = (code: string, unitPrice: number) =>
  request<MealPriceItem[]>(`/prices/${encodeURIComponent(code)}`, {
    method: 'PUT',
    body: JSON.stringify({ unitPrice }),
  });

export const fetchShiftMealCategories = () =>
  request<ShiftMealCategory[]>('/shift-meal-categories');

/** Gán loại suất cho một (ca, nhóm nhân sự). Trả về bảng gán đầy đủ. */
export const saveShiftMealCategory = (entry: ShiftMealCategory) =>
  request<ShiftMealCategory[]>('/shift-meal-categories', {
    method: 'PUT',
    body: JSON.stringify(entry),
  });

/* -------------------------------------------------------------------------
   Ánh xạ bộ phận
   ------------------------------------------------------------------------- */

export const fetchSmallDepartments = () => request<SmallDepartmentInfo[]>('/departments/small');

/** Thêm mới / cập nhật ánh xạ. Trả về danh sách ánh xạ đầy đủ sau khi lưu. */
export const saveMapping = (mapping: DepartmentMapping) =>
  post<DepartmentMapping[]>('/mappings', mapping);

export const deleteMapping = (smallDepartment: string) =>
  del<DepartmentMapping[]>(`/mappings/${encodeURIComponent(smallDepartment)}`);

/* -------------------------------------------------------------------------
   Khách công tác — gán lại bộ phận lớn cho từng người
   -------------------------------------------------------------------------
   `from` / `to` chỉ để đếm số lượt quẹt hiển thị kèm mỗi khách; danh sách
   khách thì luôn đầy đủ. */

export const fetchGuestOverrides = (from?: string, to?: string) => {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  const qs = q.toString();
  return request<{ guests: GuestDeptOverride[]; periods: GuestDeptPeriod[] }>(
    `/guest-overrides${qs ? `?${qs}` : ''}`
  );
};

/**
 * THÊM một đợt ánh xạ cho một khách công tác (hoặc sửa đợt `overrideId`).
 *
 * `effectiveFrom` / `effectiveTo` ('YYYY-MM-DD') là khoảng ngày đợt có hiệu
 * lực; bỏ trống một đầu là không giới hạn đầu đó, bỏ trống cả hai là vĩnh
 * viễn. Ngoài mọi đợt, lượt quẹt tính vào bộ phận mặc định của quy tắc.
 *
 * Đợt mới KHÔNG được giao với đợt đã có của cùng khách — server kiểm và trả
 * về thông báo tiếng Việt nêu rõ đợt bị đụng.
 */
export const saveGuestOverride = (
  userId: string,
  largeDepartment: string,
  opts: {
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
    notes?: string;
    overrideId?: number | null;
  } = {}
) => post<{
  overrideId: number;
  userId: string;
  largeDepartment: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}>('/guest-overrides', {
  userId,
  largeDepartment,
  effectiveFrom: opts.effectiveFrom || null,
  effectiveTo: opts.effectiveTo || null,
  notes: opts.notes,
  overrideId: opts.overrideId ?? null,
});

/**
 * Xoá MỘT đợt. Những ngày trong đợt đó quay về bộ phận mà quy tắc gán cho cả
 * nhóm (trừ khi có đợt khác phủ lên); các đợt còn lại của khách không đổi.
 */
export const deleteGuestOverride = (overrideId: number) =>
  del<{ ok: boolean }>(`/guest-overrides/${overrideId}`);

/* -------------------------------------------------------------------------
   Sữa
   ------------------------------------------------------------------------- */

export const fetchMilkEntries = () => request<DailyMilkEntry[]>('/milk');

export const saveMilkEntry = (entry: Omit<DailyMilkEntry, 'id' | 'totalAmount'> & { id?: string }) =>
  post<DailyMilkEntry>('/milk', entry);

export const deleteMilkEntry = (id: string) => del<{ ok: boolean }>(`/milk/${encodeURIComponent(id)}`);

/* Chi phí phát sinh — cùng hình dạng với sữa, xem ExtraCostEntry. */
export const fetchExtraCosts = () => request<ExtraCostEntry[]>('/extra-costs');

export const saveExtraCost = (entry: Omit<ExtraCostEntry, 'id' | 'totalAmount'> & { id?: string }) =>
  post<ExtraCostEntry>('/extra-costs', entry);

export const deleteExtraCost = (id: string) =>
  del<{ ok: boolean }>(`/extra-costs/${encodeURIComponent(id)}`);

/* -------------------------------------------------------------------------
   Chi phí thuê nhân công
   -------------------------------------------------------------------------
   BẢN NHÁP và LƯỢT ÁP DỤNG là hai thứ khác nhau, và đó là điểm chính của
   domain này: `saveLaborCost` / `deleteLaborCost` chỉ sửa bản nháp và KHÔNG
   làm đổi một con số nào trên báo cáo. Chỉ `applyLaborCosts` mới chụp bản
   nháp thành lượt áp dụng mới, và chỉ lượt mới nhất mới đi vào tiền. */

export const fetchLaborCosts = () => request<LaborCostState>('/labor-costs');

/** Thêm một đợt vào bản nháp, hoặc sửa đợt `id`. */
export const saveLaborCost = (entry: {
  id?: number | null;
  workerName: string;
  effectiveFrom: string;
  /** KHÔNG được tính vào đợt — xem `LaborCostDraftRow`. */
  effectiveTo: string;
  amount: number;
  notes?: string;
  /** 'YYYY-MM' — chỉ là nhãn, xem `LaborCostDraftRow.costMonth`. */
  costMonth?: string | null;
}) => post<{ id: number }>('/labor-costs', entry);

export const deleteLaborCost = (id: number) =>
  del<{ ok: boolean }>(`/labor-costs/${id}`);

/**
 * "Áp dụng" — chụp bản nháp thành một lượt mới; từ lúc này báo cáo mới dùng
 * số liệu đó. `workDayRule` được đóng băng vào lượt này.
 */
export const applyLaborCosts = (
  workDayRule: LaborWorkDayRule,
  notes?: string
) => post<LaborCostBatch>('/labor-costs/apply', { workDayRule, notes });

/** Các dòng của một lượt áp dụng cũ — để xem lại lượt đó đã áp dụng những gì. */
export const fetchLaborCostBatchRows = (batchId: string) =>
  request<LaborCostAppliedRow[]>(
    `/labor-costs/batches/${encodeURIComponent(batchId)}`
  );

/** Nạp lại một lượt cũ vào bản nháp; lượt đang hiệu lực KHÔNG đổi. */
export const restoreLaborCostBatch = (batchId: string) =>
  post<{ restored: number }>(
    `/labor-costs/batches/${encodeURIComponent(batchId)}/restore`,
    {}
  );

/* -------------------------------------------------------------------------
   Cấu hình sinh nhật
   ------------------------------------------------------------------------- */

export const fetchBirthdayConfigs = () => request<BirthdayConfig[]>('/birthday');

export const saveBirthdayConfig = (config: Omit<BirthdayConfig, 'id'> & { id?: string }) =>
  post<BirthdayConfig>('/birthday', config);

export const deleteBirthdayConfig = (id: string) =>
  del<{ ok: boolean }>(`/birthday/${encodeURIComponent(id)}`);

/* -------------------------------------------------------------------------
   Nhập thủ công
   ------------------------------------------------------------------------- */

export const fetchManualEntries = () => request<ManualMealEntry[]>('/manual-entries');

export const saveManualEntry = (entry: Omit<ManualMealEntry, 'id' | 'createdAt'> & { id?: string }) =>
  post<ManualMealEntry>('/manual-entries', entry);

export const deleteManualEntry = (id: string) =>
  del<{ ok: boolean }>(`/manual-entries/${encodeURIComponent(id)}`);
