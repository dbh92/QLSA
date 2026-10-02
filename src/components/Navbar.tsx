import React from "react";
import {
  UtensilsCrossed,
  LayoutDashboard,
  History,
  Building2,
  Globe2,
  AlertTriangle,
  Cake,
  Coins,
  Edit3,
  Milk,
  FileSpreadsheet,
  Clock,
  ShieldAlert,
  Loader2,
  LogOut,
  UserCircle2,
} from "lucide-react";
import { ShiftInfo } from "../types";
import {
  addDays,
  nowLocalDateTime,
  workDayFilterRange,
  workDayOf,
  workDayStartTime,
} from "../services/mealEngine";

export type TabType =
  | "dashboard"
  | "history"
  | "dept-report"
  | "korean-viet"
  | "abnormal"
  | "birthday"
  | "meal-price"
  | "manual-entry"
  | "milk"
  | "financial";

interface NavbarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  /** SA_Shift — mốc 22:50 của ngày làm việc lấy từ ca vắt qua nửa đêm. */
  shifts: ShiftInfo[];
  /** Thời điểm bắt đầu, "YYYY-MM-DD HH:mm:ss". */
  startDateTime: string;
  setStartDateTime: (v: string) => void;
  /** Thời điểm kết thúc, "YYYY-MM-DD HH:mm:ss". */
  endDateTime: string;
  setEndDateTime: (v: string) => void;
  abnormalCount: number;
  /** true khi đang tải lại log chấm ăn từ SQL Server. */
  isLoading?: boolean;
  /** Người đang đăng nhập — hiện tên và nút đăng xuất. */
  user: { username: string; displayName: string };
  onLogout: () => Promise<void> | void;
}

/**
 * Bộ chọn thời điểm được tách làm hai ô: ngày và giờ.
 *
 * `datetime-local` gộp cả hai vào một ô nhưng luôn hiển thị theo locale của
 * trình duyệt — máy cài tiếng Anh thì ra "08/21/2026 02:30:00 PM". Tách ra
 * `type="date"` + `type="time"` và đặt lang="vi-VN" thì phần giờ luôn là 24
 * giờ "HH:mm:ss", không phụ thuộc máy đang cài ngôn ngữ nào.
 */
const LOCALE_24H = "vi-VN";

/** Phần ngày "YYYY-MM-DD" của một thời điểm 19 ký tự. */
const datePart = (v: string) => v.slice(0, 10);
/** Phần giờ "HH:mm:ss" của một thời điểm 19 ký tự. */
const timePart = (v: string) => v.slice(11, 19) || "00:00:00";

/** Ghép lại thành "YYYY-MM-DD HH:mm:ss"; ô giờ bỏ giây thì bù ":00". */
const joinDateTime = (date: string, time: string) => {
  const t = time.length === 5 ? `${time}:00` : time.slice(0, 8);
  return `${date} ${t || "00:00:00"}`;
};

/** Một cặp ô ngày + giờ, hiển thị giờ ở dạng 24h. */
const DateTimeField: React.FC<{
  value: string;
  onChange: (v: string) => void;
  label: string;
}> = ({ value, onChange, label }) => (
  <div className="flex items-center gap-1" lang={LOCALE_24H}>
    <input
      aria-label={`${label} — ngày`}
      type="date"
      lang={LOCALE_24H}
      value={datePart(value)}
      onChange={(e) =>
        e.target.value && onChange(joinDateTime(e.target.value, timePart(value)))
      }
      className="bg-slate-900 text-slate-200 px-2 py-1 rounded border border-slate-700 focus:outline-none focus:border-amber-500"
    />
    <input
      aria-label={`${label} — giờ (24h)`}
      type="time"
      step="1"
      lang={LOCALE_24H}
      value={timePart(value)}
      onChange={(e) =>
        e.target.value && onChange(joinDateTime(datePart(value), e.target.value))
      }
      className="bg-slate-900 text-slate-200 px-2 py-1 rounded border border-slate-700 focus:outline-none focus:border-amber-500 font-mono"
    />
  </div>
);

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  shifts,
  startDateTime,
  setStartDateTime,
  endDateTime,
  setEndDateTime,
  abnormalCount,
  isLoading = false,
  user,
  onLogout,
}) => {
  /* Mọi nút chọn nhanh đều phủ trọn NGÀY LÀM VIỆC: ngày D chạy từ 22:50
     hôm trước tới 22:50 ngày D (xem `workDayFilterRange`). "Hôm nay" là
     ngày làm việc đang diễn ra — sau 22:50 thì đã là ngày mai. */
  const setDayRange = (fromDay: string, toDay: string) => {
    const r = workDayFilterRange(fromDay, toDay, shifts);
    setStartDateTime(r.startDateTime);
    setEndDateTime(r.endDateTime);
  };
  const currentWorkDay = () => workDayOf(nowLocalDateTime(), shifts);
  const dayStart = workDayStartTime(shifts).slice(0, 5);
  const navItems: {
    id: TabType;
    label: string;
    icon: React.ReactNode;
    badge?: number;
  }[] = [
    {
      id: "dashboard",
      label: "Dashboard",
      icon: <LayoutDashboard className="w-4 h-4" />,
    },
    {
      id: "history",
      label: "Lịch Sử Chấm Ăn",
      icon: <History className="w-4 h-4" />,
    },
    /* Ánh Xạ Bộ Phận không còn là tab riêng — mở bằng nút trong tab này để
       thanh menu không bị tràn. */
    {
      id: "dept-report",
      label: "Thống Kê Ca / Bộ Phận",
      icon: <Building2 className="w-4 h-4" />,
    },
    {
      id: "korean-viet",
      label: "Hàn Quốc vs Việt Nam",
      icon: <Globe2 className="w-4 h-4" />,
    },
    {
      id: "abnormal",
      label: "Suất Ăn Mất Mát",
      icon: <AlertTriangle className="w-4 h-4" />,
      badge: abnormalCount,
    },
    {
      id: "birthday",
      label: "Cấu Hình Sinh Nhật",
      icon: <Cake className="w-4 h-4" />,
    },
    {
      id: "meal-price",
      label: "Cấu Hình Giá Suất Ăn",
      icon: <Coins className="w-4 h-4" />,
    },
    {
      id: "manual-entry",
      label: "Nhập Thủ Công Ca",
      icon: <Edit3 className="w-4 h-4" />,
    },
    { id: "milk", label: "Quản Lý Sữa", icon: <Milk className="w-4 h-4" /> },
    {
      id: "financial",
      label: "Báo Cáo Chi Phí",
      icon: <FileSpreadsheet className="w-4 h-4" />,
    },
  ];

  return (
    <header className="bg-slate-900 text-white shadow-md border-b border-slate-800 sticky top-0 z-30">
      {/* Top Banner */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between py-3 gap-3">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg shadow-amber-500/20">
              <UtensilsCrossed className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-lg font-bold tracking-tight text-slate-100">
                  HỆ THỐNG QUẢN LÝ VÀ THEO DÕI SUẤT ĂN
                </h1>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  BioStar Online
                </span>
              </div>
              {/* <p className="text-xs text-slate-400 flex items-center gap-2 mt-0.5">
                <span>
                  Ngày làm việc: 08:00 (Hôm trước) &rarr; 08:00 (Hôm sau)
                </span>
                <span>•</span>
                <span className="flex items-center gap-1 text-slate-300">
                  <Clock className="w-3 h-3 text-amber-400" /> Ca đêm CA1 tự
                  động lùi 1 ngày
                </span>
              </p> */}
            </div>
          </div>

          {/* Date Picker Controls */}
          <div className="flex items-center bg-slate-800/90 rounded-lg p-1.5 border border-slate-700 space-x-2 text-xs">
            <span className="text-slate-400 font-medium pl-1 flex items-center gap-1.5">
              {isLoading && (
                <Loader2 className="w-3 h-3 animate-spin text-amber-400" />
              )}
              Thời gian:
            </span>
            <DateTimeField
              label="Từ"
              value={startDateTime}
              onChange={setStartDateTime}
            />
            <span className="text-slate-500">&rarr;</span>
            <DateTimeField
              label="Đến"
              value={endDateTime}
              onChange={setEndDateTime}
            />
            <button
              title={`Ngày làm việc hiện tại: ${dayStart} hôm trước → ${dayStart} hôm nay`}
              onClick={() => {
                const day = currentWorkDay();
                setDayRange(day, day);
              }}
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition font-medium"
            >
              Hôm nay
            </button>
            <button
              onClick={() => {
                const day = currentWorkDay();
                setDayRange(`${day.slice(0, 7)}-01`, day);
              }}
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition font-medium"
            >
              Tháng này
            </button>
            <button
              onClick={() => {
                const firstOfThisMonth = `${currentWorkDay().slice(0, 7)}-01`;
                const lastOfPrevMonth = addDays(firstOfThisMonth, -1);
                setDayRange(`${lastOfPrevMonth.slice(0, 7)}-01`, lastOfPrevMonth);
              }}
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition font-medium"
            >
              Tháng trước
            </button>
          </div>

          {/* Người dùng & đăng xuất */}
          <div className="flex items-center gap-2 bg-slate-800/90 rounded-lg p-1.5 pl-2.5 border border-slate-700 text-xs">
            <span className="flex items-center gap-1.5 text-slate-300 max-w-[160px]">
              <UserCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="truncate font-semibold" title={user.displayName}>
                {user.displayName}
              </span>
            </span>
            <button
              onClick={() => {
                if (confirm('Đăng xuất khỏi hệ thống?')) void onLogout();
              }}
              title="Đăng xuất"
              className="flex items-center gap-1 px-2 py-1 bg-slate-700 hover:bg-red-600 text-slate-200 hover:text-white rounded transition font-medium"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Đăng xuất</span>
            </button>
          </div>
        </div>
      </div>

      {/* Navigation Sub-bar */}
      <div className="bg-slate-950/80 border-t border-slate-800/80 overflow-x-auto scrollbar-none">
        <div className="max-w-7xl mx-auto px-4 flex items-center space-x-1 py-1">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center space-x-2 px-3 py-2 rounded-md text-xs font-medium whitespace-nowrap transition-all duration-150 ${
                  isActive
                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/40 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent"
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span
                    className={`ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                      isActive
                        ? "bg-amber-500 text-slate-950"
                        : "bg-red-500/80 text-white"
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
};
