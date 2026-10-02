import React, { useState } from "react";
import { LogIn, Loader2, AlertTriangle, UtensilsCrossed } from "lucide-react";

/**
 * Màn hình đăng nhập.
 *
 * Form dùng đúng `name` và `autoComplete` chuẩn để TRÌNH DUYỆT tự nhớ mật
 * khẩu — đó là chỗ duy nhất nên giữ mật khẩu. Ứng dụng không tự lưu mật khẩu
 * ở localStorage hay bất kỳ đâu; ô "Ghi nhớ đăng nhập" chỉ kéo dài tuổi thọ
 * của cookie phiên (httpOnly, JS không đọc được).
 */

interface LoginViewProps {
  onLogin: (
    username: string,
    password: string,
    remember: boolean,
  ) => Promise<void>;
  /** Số ngày phiên sống khi tick "Ghi nhớ đăng nhập". */
  rememberDays: number;
}

export const LoginView: React.FC<LoginViewProps> = ({
  onLogin,
  rememberDays,
}) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    setError(null);
    setBusy(true);
    try {
      await onLogin(username.trim(), password, remember);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Đăng nhập thất bại.");
      setBusy(false);
    }
    /* Đăng nhập thành công thì component này bị gỡ khỏi màn hình, không cần
       tắt cờ busy — tắt ở đây sẽ là setState trên component đã unmount. */
  };

  const field =
    "w-full px-3.5 py-2.5 bg-slate-800/60 border border-slate-700 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-500 transition";

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-amber-500 text-slate-950 flex items-center justify-center mx-auto shadow-lg">
            <UtensilsCrossed className="w-7 h-7" />
          </div>
          <h1 className="text-xl font-bold text-slate-100 mt-4">
            Hệ Thống Quản Lý Suất Ăn
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Đăng nhập để xem dữ liệu chấm ăn và báo cáo chi phí
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4"
        >
          <div>
            <label
              htmlFor="username"
              className="block text-xs font-semibold text-slate-400 mb-1.5"
            >
              Tên đăng nhập
            </label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={field}
              placeholder="vd: admin"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-xs font-semibold text-slate-400 mb-1.5"
            >
              Mật khẩu
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
              placeholder="••••••••"
            />
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-amber-500"
            />
            <span className="text-xs text-slate-300">
              Ghi nhớ đăng nhập{" "}
              {/* <span className="text-slate-500">
                — giữ phiên {rememberDays} ngày trên máy này
              </span> */}
            </span>
          </label>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/40 text-xs text-red-300">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed text-slate-950 font-bold rounded-xl transition flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Đang đăng nhập…
              </>
            ) : (
              <>
                <LogIn className="w-4 h-4" /> Đăng Nhập
              </>
            )}
          </button>
        </form>

        {/* <p className="text-[11px] text-slate-600 text-center mt-4 leading-relaxed">
          Quên mật khẩu? Người quản trị đặt lại bằng lệnh
          <br />
          <code className="text-slate-500">npm run user -- passwd &lt;tên đăng nhập&gt;</code>
        </p> */}
      </div>
    </div>
  );
};
