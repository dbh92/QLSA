import React, {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { Navbar, TabType } from "./components/Navbar";
import { DashboardView } from "./components/DashboardView";
import { MealHistoryView } from "./components/MealHistoryView";
import { DepartmentReportView } from "./components/DepartmentReportView";
import { KoreanVsVietnameseView } from "./components/KoreanVsVietnameseView";
import { AbnormalPunchesView } from "./components/AbnormalPunchesView";
import { BirthdayConfigView } from "./components/BirthdayConfigView";
import { ManualEntryView } from "./components/ManualEntryView";
import { DailyMilkView } from "./components/DailyMilkView";
import { LoginView } from "./components/LoginView";
import { FinancialReportView } from "./components/FinancialReportView";
import { MealPriceConfigView } from "./components/MealPriceConfigView";

import {
  MealLog,
  DepartmentMapping,
  GuestDeptOverride,
  GuestDeptPeriod,
  DailyMilkEntry,
  ExtraCostEntry,
  BirthdayConfig,
  ManualMealEntry,
  ShiftInfo,
  ReaderInfo,
  MealPriceItem,
  LargeDepartmentInfo,
  MonthlyCostRow,
  SystemSettings,
  ShiftMealCategory,
  LaborCostState,
  LaborWorkDayRule,
} from "./types";

import * as api from "./services/api";
import {
  costWorkDayRange,
  evaluatePunchDays,
  nowLocalDateTime,
  parseBirthdayShifts,
  workDayFilterRange,
  workDayOf,
} from "./services/mealEngine";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

/** Ngày hôm nay ở dạng "YYYY-MM-DD" theo giờ máy (không dùng toISOString để tránh lệch UTC). */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function firstDayOfCurrentMonth(): string {
  return `${today().slice(0, 7)}-01`;
}

/**
 * Khoảng lọc mặc định: trọn NGÀY LÀM VIỆC đang diễn ra — 22:50 hôm trước tới
 * 22:49:59 hôm nay (sau 22:50 thì đã sang ngày làm việc kế tiếp). Lúc này
 * SA_Shift chưa nạp nên dùng mốc 22:50 dự phòng, trùng với 02_seed.sql.
 */
function currentWorkDayRange() {
  const day = workDayOf(nowLocalDateTime());
  return workDayFilterRange(day, day);
}

/**
 * Số ngày phiên sống khi người dùng tick "Ghi nhớ đăng nhập". Phải khớp với
 * AUTH_SESSION_DAYS ở server/auth.js — con số ở đây chỉ để hiển thị.
 */
const REMEMBER_DAYS = 7;

export default function App() {
  // Navigation tab state
  const [activeTab, setActiveTab] = useState<TabType>("dashboard");

  /* Bộ lọc thời gian toàn cục, chính xác tới GIÂY: "YYYY-MM-DD HH:mm:ss".
     Chuỗi dạng này so sánh lexicographic đúng thứ tự thời gian, giữ nguyên quy
     ước "không đưa Date vào đường so sánh" của cả hệ thống. */
  const [startDateTime, setStartDateTime] = useState(
    () => currentWorkDayRange().startDateTime,
  );
  const [endDateTime, setEndDateTime] = useState(
    () => currentWorkDayRange().endDateTime,
  );

  // Danh mục nạp từ SQL Server lúc khởi động
  const [shifts, setShifts] = useState<ShiftInfo[]>([]);

  /* Khoảng NGÀY LÀM VIỆC mà bộ lọc chạm tới (ngày D = (D-1) 22:50 -> D 22:50),
     dùng cho các bảng chỉ có cột ngày (sữa, nhân công, ...) và cho nhãn "Từ
     ... đến ...". Lọc từ 25 lúc 22:50 thì ngày đầu tiên là 26, không phải 25. */
  const { from: startDate, to: endDate } = costWorkDayRange(
    startDateTime,
    endDateTime,
    shifts,
  );
  const [readers, setReaders] = useState<ReaderInfo[]>([]);
  const [largeDepartments, setLargeDepartments] = useState<
    LargeDepartmentInfo[]
  >([]);
  const [mappings, setMappings] = useState<DepartmentMapping[]>([]);
  const [priceItems, setPriceItems] = useState<MealPriceItem[]>([]);
  const [shiftMealCategories, setShiftMealCategories] = useState<
    ShiftMealCategory[]
  >([]);
  const [settings, setSettings] = useState<SystemSettings>({});
  const [monthlyCosts, setMonthlyCosts] = useState<MonthlyCostRow[]>([]);
  const [monthlyCostsLoading, setMonthlyCostsLoading] = useState(false);
  const [monthlyCostsError, setMonthlyCostsError] = useState<string | null>(
    null,
  );

  // Dữ liệu nghiệp vụ
  const [logs, setLogs] = useState<MealLog[]>([]);
  /* Tăng lên để buộc nạp lại log chấm ăn dù khoảng thời gian không đổi. Cần
     khi sửa ánh xạ bộ phận: bộ phận lớn của từng lượt quẹt do
     SA_MealLog_GetByRange giải (rule > ánh xạ) nên phải hỏi lại SQL Server. */
  const [logsVersion, setLogsVersion] = useState(0);
  /* Khách công tác được gán bộ phận riêng. Danh sách kèm số lượt quẹt của
     khoảng lọc nên phải nạp lại khi đổi khoảng, giống log chấm ăn. */
  const [guestOverrides, setGuestOverrides] = useState<GuestDeptOverride[]>([]);
  /* Từng ĐỢT ánh xạ (một khách nhiều đợt) — xem GuestDeptPeriod. */
  const [guestPeriods, setGuestPeriods] = useState<GuestDeptPeriod[]>([]);
  const [milkEntries, setMilkEntries] = useState<DailyMilkEntry[]>([]);
  const [extraCosts, setExtraCosts] = useState<ExtraCostEntry[]>([]);
  const [birthdayConfigs, setBirthdayConfigs] = useState<BirthdayConfig[]>([]);
  const [manualEntries, setManualEntries] = useState<ManualMealEntry[]>([]);

  /* Chi phí thuê nhân công. BẢN NHÁP và LƯỢT ÁP DỤNG nằm chung một object vì
     chúng luôn được đọc cùng một lượt gọi và màn hình phải so hai bên với
     nhau; chỉ `appliedRows` mới đi vào tiền của báo cáo. */
  const [laborCosts, setLaborCosts] = useState<LaborCostState>({
    draft: [],
    effective: null,
    appliedRows: [],
    batches: [],
  });
  const [laborCostsLoading, setLaborCostsLoading] = useState(true);

  /* ---------------------------------------------------------------------
     Đăng nhập
     ---------------------------------------------------------------------
     `user === undefined` nghĩa là CHƯA BIẾT (đang hỏi máy chủ còn phiên hay
     không), `null` là chắc chắn chưa đăng nhập. Phân biệt hai trạng thái này
     để lần tải trang đầu không loé lên màn hình đăng nhập rồi mới nhảy vào
     ứng dụng khi thật ra phiên vẫn còn. */
  const [user, setUser] = useState<api.AuthUser | null | undefined>(undefined);

  // Trạng thái tải
  const [configLoading, setConfigLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ---------------------------------------------------------------------
     Nạp danh mục + các bảng nghiệp vụ nhỏ (một lần lúc khởi động)
     --------------------------------------------------------------------- */
  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setError(null);
    try {
      const [config, milk, extras, birthdays, manual, labor] =
        await Promise.all([
          api.fetchBootstrap(),
          api.fetchMilkEntries(),
          api.fetchExtraCosts(),
          api.fetchBirthdayConfigs(),
          api.fetchManualEntries(),
          api.fetchLaborCosts(),
        ]);

      setShifts(config.shifts);
      setReaders(config.readers);
      setLargeDepartments(config.largeDepartments);
      setMappings(config.mappings);
      setPriceItems(config.priceItems);
      // `?? []` để bản API cũ (chưa có bảng gán) vẫn chạy — thiếu bảng thì
      // classifyMeal rơi về quy tắc mặc định thay vì hỏng cả màn hình.
      setShiftMealCategories(config.shiftMealCategories ?? []);
      setSettings(config.settings);

      setMilkEntries(milk);
      setExtraCosts(extras);
      setBirthdayConfigs(birthdays);
      setManualEntries(manual);
      setLaborCosts(labor);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Lỗi không xác định khi nạp cấu hình.",
      );
    } finally {
      setConfigLoading(false);
      /* Đặt ở finally: nạp hỏng thì màn hình nhân công phải hiện "chưa có dữ
         liệu" chứ không kẹt mãi ở vòng xoay. */
      setLaborCostsLoading(false);
    }
  }, []);

  /* Hỏi máy chủ xem cookie phiên còn hiệu lực không. Chạy đúng một lần. */
  useEffect(() => {
    let cancelled = false;
    api
      .fetchCurrentUser()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch(() => {
        /* Không gọi được API (server chưa chạy) — coi như chưa đăng nhập, màn
           hình đăng nhập sẽ báo lỗi cụ thể khi người dùng bấm nút. */
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Mọi endpoint đều đòi phiên, nên chỉ nạp dữ liệu sau khi đã đăng nhập. */
  useEffect(() => {
    if (user) loadConfig();
  }, [user, loadConfig]);

  const handleLogin = useCallback(
    async (username: string, password: string, remember: boolean) => {
      setUser(await api.login(username, password, remember));
    },
    [],
  );

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      /* Dù gọi API hỏng cũng phải rời khỏi màn hình dữ liệu: người dùng bấm
         đăng xuất là muốn màn hình sạch ngay. */
      setUser(null);
      setLogs([]);
      setError(null);
      /* Đặt lại cờ để lần đăng nhập sau chạy lại toàn bộ vòng nạp cấu hình. */
      setConfigLoading(true);
    }
  }, []);

  /* ---------------------------------------------------------------------
     Biểu đồ xu hướng năm — tổng hợp sẵn trên SQL Server, nạp lại khi đổi năm.
     --------------------------------------------------------------------- */
  const trendYear = Number(endDate.slice(0, 4));

  /** Trả về null khi nạp hỏng, để phân biệt với "năm này không có dữ liệu". */
  const runTrendQuery = useCallback(
    async (year: number): Promise<MonthlyCostRow[] | null> => {
      setMonthlyCostsLoading(true);
      setMonthlyCostsError(null);
      try {
        const rows = await api.fetchMonthlyCostTrend(year);
        setMonthlyCosts(rows);
        return rows;
      } catch (err) {
        // Hỏng biểu đồ không chặn cả màn hình, nhưng PHẢI báo lỗi ra —
        // nuốt lỗi rồi vẽ biểu đồ trống là không phân biệt được "chưa deploy
        // procedure" với "năm này không có dữ liệu".
        setMonthlyCosts([]);
        setMonthlyCostsError(
          err instanceof Error ? err.message : "Lỗi không xác định.",
        );
        return null;
      } finally {
        setMonthlyCostsLoading(false);
      }
    },
    [],
  );

  /* Lượt nạp xu hướng đang chạy / đã xong của từng năm. Cần nhớ lại vì
     SA_MealCost_GetMonthly tổng hợp cả 12 tháng nên mất vài giây: nút "Báo
     cáo tổng hợp" bấm ngay khi vừa mở app phải CHỜ đúng lượt nạp này rồi mới
     dựng sheet "Total suất ăn", chứ không được bắn thêm một truy vấn nữa —
     và càng không được xuất ra một sheet rỗng. */
  const trendRequest = useRef<{
    year: number;
    promise: Promise<MonthlyCostRow[]>;
  } | null>(null);

  /**
   * Bảo đảm có số liệu xu hướng của `year` và trả thẳng về cho người gọi —
   * state của React cập nhật quá muộn cho một handler đang chạy dở.
   * `force` dùng khi số liệu trên server đã đổi (sửa giá, đổi loại suất) hoặc
   * khi người dùng bấm "Thử lại".
   */
  const loadTrend = useCallback(
    (year: number, force = false): Promise<MonthlyCostRow[]> => {
      if (!Number.isInteger(year) || year < 2000) return Promise.resolve([]);

      const cached = trendRequest.current;
      if (!force && cached && cached.year === year) return cached.promise;

      const entry = {
        year,
        promise: null as unknown as Promise<MonthlyCostRow[]>,
      };
      entry.promise = runTrendQuery(year).then((rows) => {
        /* Nạp hỏng thì quên đi, để lần bấm sau thật sự gọi lại SQL Server.
           Năm không có dữ liệu vẫn được nhớ — hỏi lại cũng chỉ ra rỗng. */
        if (rows === null && trendRequest.current === entry) {
          trendRequest.current = null;
          return [];
        }
        return rows ?? [];
      });
      trendRequest.current = entry;
      return entry.promise;
    },
    [runTrendQuery],
  );

  useEffect(() => {
    /* Cùng lý do với effect nạp log ở dưới: gọi trước khi đăng nhập thì 401. */
    if (!user) return;
    loadTrend(trendYear);
  }, [user, trendYear, loadTrend]);

  /* ---------------------------------------------------------------------
     Nạp log chấm ăn mỗi khi đổi khoảng thời gian.
     Một tháng ~50.000 lượt quẹt nên chỉ gọi lại khi khoảng ngày hợp lệ.
     --------------------------------------------------------------------- */
  useEffect(() => {
    /* Mọi endpoint đều đòi phiên. Trước đây effect này không phụ thuộc `user`
       nên nó chạy lúc trang vừa mở — khi chưa đăng nhập — bị 401, rồi KHÔNG
       bao giờ chạy lại vì khoảng thời gian không đổi: đăng nhập xong màn hình
       trống trơn. Thêm `user` vào phụ thuộc để vừa đăng nhập là nạp ngay dữ
       liệu theo bộ lọc thời gian đang chọn. */
    if (!user) return;
    if (!startDateTime || !endDateTime || endDateTime < startDateTime) return;

    let cancelled = false;
    setLogsLoading(true);

    api
      .fetchMealLogs(startDateTime, endDateTime)
      .then((rows) => {
        if (!cancelled) {
          setLogs(rows);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLogs([]);
          setError(
            err instanceof Error
              ? err.message
              : "Lỗi không xác định khi nạp dữ liệu chấm ăn.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLogsLoading(false);
      });

    // Bỏ qua kết quả của request cũ khi người dùng đổi thời gian liên tục.
    return () => {
      cancelled = true;
    };
  }, [user, startDateTime, endDateTime, logsVersion]);

  /* Danh sách khách công tác đi kèm số lượt quẹt của khoảng đang lọc, nên nạp
     theo đúng nhịp với log chấm ăn — kể cả `logsVersion`, vì gán lại bộ phận
     cho một khách vừa đổi log vừa đổi chính danh sách này.

     Hỏng thì để danh sách rỗng chứ không chặn màn hình: đây là một khối cấu
     hình nằm trong popup, không phải dữ liệu chính của trang. */
  useEffect(() => {
    if (!user) return;
    if (!startDateTime || !endDateTime || endDateTime < startDateTime) return;

    let cancelled = false;
    api
      .fetchGuestOverrides(startDateTime, endDateTime)
      .then(({ guests, periods }) => {
        if (cancelled) return;
        setGuestOverrides(guests);
        setGuestPeriods(periods);
      })
      .catch(() => {
        if (cancelled) return;
        setGuestOverrides([]);
        setGuestPeriods([]);
      });

    return () => {
      cancelled = true;
    };
  }, [user, startDateTime, endDateTime, logsVersion]);

  /* ---------------------------------------------------------------------
     Ghi dữ liệu — gọi stored procedure rồi nạp lại danh sách tương ứng
     --------------------------------------------------------------------- */
  const handleSaveMapping = useCallback(async (mapping: DepartmentMapping) => {
    setMappings(await api.saveMapping(mapping));
    setLogsVersion((v) => v + 1);
  }, []);

  const handleDeleteMapping = useCallback(async (smallDepartment: string) => {
    setMappings(await api.deleteMapping(smallDepartment));
    setLogsVersion((v) => v + 1);
  }, []);

  /**
   * Sửa đơn giá một loại suất. Bảng giá mới áp cho mọi màn hình tính tiền phía
   * client; biểu đồ xu hướng năm tính tiền ngay trong SQL Server nên phải nạp
   * lại, nếu không nó vẫn vẽ theo giá cũ.
   */
  const handleSaveMealPrice = useCallback(
    async (code: string, unitPrice: number) => {
      setPriceItems(await api.saveMealPrice(code, unitPrice));
      await loadTrend(trendYear, true);
    },
    [loadTrend, trendYear],
  );

  /**
   * Gán loại suất cho một (ca, nhóm nhân sự). Cũng như sửa giá: biểu đồ xu
   * hướng năm phân loại suất ngay trong SQL Server nên phải nạp lại.
   */
  const handleSaveShiftMealCategory = useCallback(
    async (entry: ShiftMealCategory) => {
      setShiftMealCategories(await api.saveShiftMealCategory(entry));
      await loadTrend(trendYear, true);
    },
    [loadTrend, trendYear],
  );

  /**
   * Ghi một lượt số liệu sữa: thêm/ghi đè `upserts`, xoá `deleteIds`, rồi nạp
   * lại danh sách ĐÚNG MỘT LẦN.
   *
   * Màn hình nhập theo NGÀY nên một thao tác sinh ra tới hai bản ghi (Ca ngày
   * + Ca đêm), còn một file Excel sinh ra hàng chục — nạp lại sau từng bản ghi
   * thì bảng nhấp nháy và mỗi lần nhập là mấy chục lượt gọi thừa.
   */
  /**
   * Gán một khách công tác vào bộ phận lớn khác (hoặc bỏ ngoại lệ).
   *
   * Bộ phận lớn của từng lượt quẹt do SA_MealLog_GetByRange giải, và biểu đồ
   * 12 tháng do SA_MealCost_GetMonthly tính ngay trong SQL Server — nên phải
   * hỏi lại cả hai, giống hệt khi sửa ánh xạ bộ phận. Nạp lại log cũng kéo
   * theo danh sách khách (hai effect cùng phụ thuộc `logsVersion`).
   */
  const refreshAfterGuestChange = useCallback(async () => {
    setLogsVersion((v) => v + 1);
    await loadTrend(trendYear, true);
  }, [loadTrend, trendYear]);

  const handleSaveGuestOverride = useCallback(
    async (
      userId: string,
      largeDepartment: string,
      effectiveFrom: string | null,
      effectiveTo: string | null,
    ) => {
      await api.saveGuestOverride(userId, largeDepartment, {
        effectiveFrom,
        effectiveTo,
      });
      await refreshAfterGuestChange();
    },
    [refreshAfterGuestChange],
  );

  const handleDeleteGuestOverride = useCallback(
    async (overrideId: number) => {
      await api.deleteGuestOverride(overrideId);
      await refreshAfterGuestChange();
    },
    [refreshAfterGuestChange],
  );

  /**
   * Popup "Điều Chỉnh Số Liệu" vừa xóa (hoặc khôi phục) lượt quẹt dưới cơ sở
   * dữ liệu. SA_MealLog_GetByRange và SA_MealCost_GetMonthly đều lọc theo bảng
   * TB_EVENT_LOG_DEL nên phải hỏi lại SQL Server cả hai — mọi tab đọc chung
   * `logs` nên chỉ cần một lượt nạp là cả ứng dụng thấy số mới.
   */
  const handlePunchesChanged = useCallback(async () => {
    setLogsVersion((v) => v + 1);
    await loadTrend(trendYear, true);
  }, [loadTrend, trendYear]);

  const handleCommitMilk = useCallback(
    async (
      upserts: (Omit<DailyMilkEntry, "id" | "totalAmount"> & { id?: string })[],
      deleteIds: string[],
    ) => {
      for (const row of upserts) {
        await api.saveMilkEntry(row);
      }
      for (const id of deleteIds) {
        await api.deleteMilkEntry(id);
      }
      setMilkEntries(await api.fetchMilkEntries());
    },
    [],
  );

  /* Chi phí phát sinh — cùng vòng đời với sữa, xem SA_ExtraCost. */
  const handleCommitExtraCosts = useCallback(
    async (
      upserts: (Omit<ExtraCostEntry, "id" | "totalAmount"> & { id?: string })[],
      deleteIds: string[],
    ) => {
      for (const row of upserts) {
        await api.saveExtraCost(row);
      }
      for (const id of deleteIds) {
        await api.deleteExtraCost(id);
      }
      setExtraCosts(await api.fetchExtraCosts());
    },
    [],
  );

  /* ---------------------------------------------------------------------
     Chi phí thuê nhân công

     Ba hàm đầu chỉ đụng BẢN NHÁP, nên chúng KHÔNG nạp lại log hay bảng 12
     tháng — không con số nào của báo cáo đổi. Chỉ `handleApplyLaborCosts` mới
     làm tiền thay đổi, nhưng ngay cả nó cũng không cần hỏi lại SQL Server:
     phép chia tiền theo ngày làm việc chạy ở client trên chính `appliedRows`
     vừa nhận về, kể cả cho bảng 12 tháng. */
  const reloadLaborCosts = useCallback(async () => {
    setLaborCosts(await api.fetchLaborCosts());
  }, []);

  const handleSaveLaborCost = useCallback(
    async (row: {
      id?: number | null;
      workerName: string;
      effectiveFrom: string;
      effectiveTo: string;
      amount: number;
      notes?: string;
    }) => {
      await api.saveLaborCost(row);
      await reloadLaborCosts();
    },
    [reloadLaborCosts],
  );

  const handleDeleteLaborCost = useCallback(
    async (id: number) => {
      await api.deleteLaborCost(id);
      await reloadLaborCosts();
    },
    [reloadLaborCosts],
  );

  const handleApplyLaborCosts = useCallback(
    async (rule: LaborWorkDayRule, notes?: string) => {
      await api.applyLaborCosts(rule, notes);
      await reloadLaborCosts();
    },
    [reloadLaborCosts],
  );

  const handleRestoreLaborBatch = useCallback(
    async (batchId: string) => {
      await api.restoreLaborCostBatch(batchId);
      await reloadLaborCosts();
    },
    [reloadLaborCosts],
  );

  const handleSaveBirthday = useCallback(
    async (config: Omit<BirthdayConfig, "id">) => {
      await api.saveBirthdayConfig(config);
      setBirthdayConfigs(await api.fetchBirthdayConfigs());
    },
    [],
  );

  const handleDeleteBirthday = useCallback(async (id: string) => {
    await api.deleteBirthdayConfig(id);
    setBirthdayConfigs(await api.fetchBirthdayConfigs());
  }, []);

  const handleSaveManual = useCallback(
    async (entry: Omit<ManualMealEntry, "id" | "createdAt">) => {
      await api.saveManualEntry(entry);
      setManualEntries(await api.fetchManualEntries());
    },
    [],
  );

  /**
   * Nhập nhiều dòng ký số từ Excel: lưu lần lượt rồi nạp lại danh sách một lần.
   *
   * KHÔNG dừng ở dòng lỗi đầu tiên, và KHÔNG ném lỗi ra ngoài: dừng giữa chừng
   * thì một phần file đã nằm trong cơ sở dữ liệu còn người dùng chỉ thấy một
   * câu báo lỗi không biết của dòng nào. Thay vào đó lưu hết những dòng lưu
   * được, rồi trả về lỗi kèm CHỈ SỐ DÒNG để màn hình ghi thẳng vào cột "Trạng
   * thái" của đúng dòng đó.
   */
  const handleImportManual = useCallback(
    async (rows: Omit<ManualMealEntry, "id" | "createdAt">[]) => {
      const failures: { index: number; message: string }[] = [];
      for (let i = 0; i < rows.length; i++) {
        try {
          await api.saveManualEntry(rows[i]);
        } catch (err) {
          failures.push({
            index: i,
            message: err instanceof Error ? err.message : "Lưu thất bại.",
          });
        }
      }
      setManualEntries(await api.fetchManualEntries());
      return failures;
    },
    [],
  );

  const handleDeleteManual = useCallback(async (id: string) => {
    await api.deleteManualEntry(id);
    setManualEntries(await api.fetchManualEntries());
  }, []);

  /* ---------------------------------------------------------------------
     Dẫn xuất
     --------------------------------------------------------------------- */
  /* Suất mất mát đã xóa ở popup Điều Chỉnh Số Liệu (`lossDeleted`) vẫn được
     SA_MealLog_GetByRange trả về, CHỈ để tab Suất Ăn Mất Mát hiển thị y
     nguyên như chưa xóa. Mọi tab khác đọc `activeLogs`, nên chúng không đếm
     và không tính tiền những lượt đó — đúng như trước khi có ngoại lệ này. */
  const activeLogs = useMemo(
    () => logs.filter((l) => !l.lossDeleted),
    [logs],
  );

  const rangeLogs = useMemo(
    () =>
      logs.filter(
        (l) => l.logDateTime >= startDateTime && l.logDateTime <= endDateTime,
      ),
    [logs, startDateTime, endDateTime],
  );

  /**
   * Các ngày công có lượt quẹt mất mát — cùng một hàm VÀ cùng tập log (kể cả
   * suất mất mát đã xóa) với tab "Suất Ăn Mất Mát", nên badge trên Navbar,
   * thẻ Dashboard và tab đó luôn ra cùng số liệu.
   */
  const abnormalList = useMemo(
    () => evaluatePunchDays(rangeLogs, shifts).filter((c) => c.lossCount > 0),
    [rangeLogs, shifts],
  );

  const largeDeptOptions = useMemo(
    () => largeDepartments.map((d) => d.code),
    [largeDepartments],
  );

  /* Ca nào được ăn suất sinh nhật — cấu hình ở SA_SystemSetting, mặc định là
     hai bữa chính CA1 + CA4. Tính một lần rồi truyền xuống mọi màn hình tính
     tiền để chúng không thể hiểu khác nhau. */
  const birthdayShifts = useMemo(
    () => parseBirthdayShifts(settings.BIRTHDAY_SHIFTS),
    [settings.BIRTHDAY_SHIFTS],
  );

  /* --------------------------------------------------------------------- */

  /* Chưa biết còn phiên hay không — chờ, đừng loé màn hình đăng nhập. */
  if (user === undefined) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
      </div>
    );
  }

  if (user === null) {
    return <LoginView onLogin={handleLogin} rememberDays={REMEMBER_DAYS} />;
  }

  if (configLoading) {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center gap-3 text-slate-600">
        <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
        <div className="text-sm font-semibold">
          Đang nạp cấu hình từ SQL Server…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 font-sans antialiased flex flex-col">
      {/* Top Navbar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        shifts={shifts}
        startDateTime={startDateTime}
        setStartDateTime={setStartDateTime}
        endDateTime={endDateTime}
        setEndDateTime={setEndDateTime}
        abnormalCount={abnormalList.length}
        isLoading={logsLoading}
        user={user}
        onLogout={handleLogout}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6">
        {error && (
          <div className="mb-5 p-4 rounded-2xl bg-red-50 border border-red-200 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="flex-1 text-xs">
              <div className="font-bold text-red-800">
                Không lấy được dữ liệu từ SQL Server
              </div>
              <div className="text-red-700 mt-0.5">{error}</div>
            </div>
            <button
              onClick={loadConfig}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Thử lại
            </button>
          </div>
        )}

        {activeTab === "dashboard" && (
          <DashboardView
            logs={activeLogs}
            readers={readers}
            shifts={shifts}
            abnormalList={abnormalList}
            milkEntries={milkEntries}
            manualEntries={manualEntries}
            mappings={mappings}
            priceItems={priceItems}
            shiftMealCategories={shiftMealCategories}
            birthdayConfigs={birthdayConfigs}
            birthdayShifts={birthdayShifts}
            startDateTime={startDateTime}
            endDateTime={endDateTime}
            startDate={startDate}
            endDate={endDate}
          />
        )}

        {activeTab === "history" && (
          <MealHistoryView
            logs={activeLogs}
            mappings={mappings}
            readers={readers}
            shifts={shifts}
            startDateTime={startDateTime}
            endDateTime={endDateTime}
            startDate={startDate}
            endDate={endDate}
          />
        )}

        {activeTab === "dept-report" && (
          <DepartmentReportView
            logs={activeLogs}
            mappings={mappings}
            largeDeptOptions={largeDeptOptions}
            manualEntries={manualEntries}
            priceItems={priceItems}
            shiftMealCategories={shiftMealCategories}
            onSaveMapping={handleSaveMapping}
            onDeleteMapping={handleDeleteMapping}
            guestOverrides={guestOverrides}
            guestPeriods={guestPeriods}
            onSaveGuestOverride={handleSaveGuestOverride}
            onDeleteGuestOverride={handleDeleteGuestOverride}
            startDateTime={startDateTime}
            endDateTime={endDateTime}
            startDate={startDate}
            endDate={endDate}
          />
        )}

        {activeTab === "korean-viet" && (
          <KoreanVsVietnameseView
            logs={activeLogs}
            shifts={shifts}
            mappings={mappings}
            priceItems={priceItems}
            shiftMealCategories={shiftMealCategories}
            birthdayConfigs={birthdayConfigs}
            manualEntries={manualEntries}
            birthdayShifts={birthdayShifts}
            startDateTime={startDateTime}
            endDateTime={endDateTime}
            startDate={startDate}
            endDate={endDate}
          />
        )}

        {activeTab === "abnormal" && (
          <AbnormalPunchesView
            logs={logs}
            mappings={mappings}
            shifts={shifts}
            priceItems={priceItems}
            shiftMealCategories={shiftMealCategories}
            birthdayConfigs={birthdayConfigs}
            birthdayShifts={birthdayShifts}
            startDateTime={startDateTime}
            endDateTime={endDateTime}
            startDate={startDate}
            endDate={endDate}
          />
        )}

        {activeTab === "birthday" && (
          <BirthdayConfigView
            configs={birthdayConfigs}
            onSave={handleSaveBirthday}
            onDelete={handleDeleteBirthday}
          />
        )}

        {activeTab === "meal-price" && (
          <MealPriceConfigView
            priceItems={priceItems}
            shifts={shifts}
            shiftMealCategories={shiftMealCategories}
            birthdayShifts={birthdayShifts}
            onSave={handleSaveMealPrice}
            onSaveShiftCategory={handleSaveShiftMealCategory}
          />
        )}

        {activeTab === "manual-entry" && (
          <ManualEntryView
            entries={manualEntries}
            shifts={shifts}
            mappings={mappings}
            onSave={handleSaveManual}
            onImport={handleImportManual}
            onDelete={handleDeleteManual}
          />
        )}

        {activeTab === "milk" && (
          <DailyMilkView
            entries={milkEntries}
            onCommit={handleCommitMilk}
            extraCosts={extraCosts}
            onCommitExtra={handleCommitExtraCosts}
            startDate={startDate}
            endDate={endDate}
          />
        )}

        {activeTab === "financial" && (
          <FinancialReportView
            logs={logs}
            mappings={mappings}
            shifts={shifts}
            largeDeptOptions={largeDeptOptions}
            milkEntries={milkEntries}
            extraCosts={extraCosts}
            birthdayConfigs={birthdayConfigs}
            birthdayShifts={birthdayShifts}
            priceItems={priceItems}
            shiftMealCategories={shiftMealCategories}
            manualEntries={manualEntries}
            monthlyCosts={monthlyCosts}
            monthlyCostsLoading={monthlyCostsLoading}
            monthlyCostsError={monthlyCostsError}
            onReloadMonthlyCosts={() => loadTrend(trendYear, true)}
            onEnsureMonthlyCosts={() => loadTrend(trendYear)}
            onPunchesChanged={handlePunchesChanged}
            laborCosts={laborCosts}
            laborCostsLoading={laborCostsLoading}
            onSaveLaborCost={handleSaveLaborCost}
            onDeleteLaborCost={handleDeleteLaborCost}
            onApplyLaborCosts={handleApplyLaborCosts}
            onRestoreLaborBatch={handleRestoreLaborBatch}
            startDateTime={startDateTime}
            endDateTime={endDateTime}
            startDate={startDate}
            endDate={endDate}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="bg-slate-900 border-t border-slate-800 text-slate-400 py-4 text-xs text-center mt-auto">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row justify-between items-center gap-2">
          <div>
            Hệ thống Quản lý và Theo dõi Suất ăn © 2026 BioStar Canteen
            Integration
          </div>
          <div className="font-mono text-[11px] text-slate-500">
            {readers.length} Readers • {activeLogs.length.toLocaleString("vi-VN")}{" "}
            lượt quẹt • Dữ liệu thật từ SQL Server
          </div>
        </div>
      </footer>
    </div>
  );
}
