/**
 * Đăng nhập / đăng xuất và bảo vệ API.
 *
 * MẬT KHẨU LƯU DẠNG THƯỜNG (không băm) — đây là lựa chọn có ý thức của chủ hệ
 * thống vì máy chủ chỉ chạy trong mạng nội bộ nhà máy. Hệ quả: ai đọc được
 * bảng SA_User là đọc được mật khẩu của tất cả mọi người. Nếu sau này hệ thống
 * ra khỏi mạng nội bộ, hãy bật lại băm: `preparePassword` là chỗ duy nhất
 * quyết định dạng lưu, và `verifyPassword` vẫn đọc được bản ghi băm cũ.
 *
 * NHỮNG QUYẾT ĐỊNH CÒN LẠI VẪN GIỮ, ĐỪNG ĐỔI MÀ KHÔNG CÂN NHẮC:
 *
 *  - Token phiên nằm trong cookie `httpOnly`, JavaScript của trang KHÔNG đọc
 *    được. Nếu để token trong localStorage thì một lỗ XSS bất kỳ là mất phiên
 *    của mọi người dùng.
 *
 *  - Cơ sở dữ liệu chỉ giữ BĂM của token phiên. Mật khẩu để thường là quyết
 *    định riêng cho mật khẩu; token thì không có lý do gì để lộ.
 *
 *  - Đăng nhập sai không nói rõ sai tên hay sai mật khẩu, để không giúp người
 *    lạ dò ra tài khoản nào có thật.
 */
import crypto from "node:crypto";
import { promisify } from "node:util";
import { sql, queryProc } from "./db.js";

const scrypt = promisify(crypto.scrypt);

/** Phiên sống 7 ngày, đúng như yêu cầu "ghi nhớ đăng nhập 7 ngày". */
export const SESSION_DAYS = Number(process.env.AUTH_SESSION_DAYS || 7);

/** Không tick "ghi nhớ" thì phiên chỉ sống trong ngày làm việc. */
const SHORT_SESSION_HOURS = Number(process.env.AUTH_SHORT_SESSION_HOURS || 12);

export const SESSION_COOKIE = "qlsa_session";

/* --------------------------------------------------------------------------
   Mật khẩu
   -------------------------------------------------------------------------- */

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Dạng đem cất vào SA_User.Password.
 *
 * Hiện tại là chính mật khẩu, không băm — xem chú thích đầu file. Đây là chỗ
 * DUY NHẤT quyết định dạng lưu: muốn bật lại băm thì chỉ sửa hàm này (trả về
 * `scrypt$<muối>$<băm>`), `verifyPassword` đã đọc được cả hai dạng.
 */
export function preparePassword(password) {
  return String(password);
}

/** Băm scrypt — giữ lại cho đường quay về nếu sau này bật mã hoá trở lại. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Đối chiếu mật khẩu với giá trị đã lưu.
 *
 * Đọc được CẢ HAI dạng: mật khẩu thường (dạng hiện tại) và `scrypt$...` của
 * những tài khoản tạo trước khi bỏ mã hoá — nhờ vậy đổi cách lưu không khoá
 * ai ra ngoài.
 */
export async function verifyPassword(password, stored) {
  const value = String(stored ?? "");
  if (value === "") return false;

  if (value.startsWith("scrypt$")) {
    const parts = value.split("$");
    if (parts.length !== 3) return false;

    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;

    const actual = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    return crypto.timingSafeEqual(actual, expected);
  }

  /* So sánh theo thời gian hằng số: độ dài khác nhau thì timingSafeEqual ném
     lỗi nên phải kiểm tra trước. */
  const a = Buffer.from(String(password), "utf8");
  const b = Buffer.from(value, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* --------------------------------------------------------------------------
   Token phiên
   -------------------------------------------------------------------------- */

/** Token thật, chỉ tồn tại trong cookie của người dùng. */
const newToken = () => crypto.randomBytes(32).toString("hex");

/** Băm token để cất vào cơ sở dữ liệu. */
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

/** Đọc một cookie từ header, không cần thêm thư viện cookie-parser. */
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * `Secure` chỉ bật khi thực sự chạy HTTPS: hệ thống này chạy HTTP trong mạng
 * nội bộ nhà máy, bật Secure thì trình duyệt bỏ luôn cookie và không ai đăng
 * nhập được. Đặt AUTH_SECURE_COOKIE=true khi nào có HTTPS.
 */
const secureCookie = String(process.env.AUTH_SECURE_COOKIE || "false") === "true";

function setSessionCookie(res, token, maxAgeMs) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie,
    maxAge: maxAgeMs,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie,
    path: "/",
  });
}

/* --------------------------------------------------------------------------
   Tra phiên
   -------------------------------------------------------------------------- */

/** Người dùng của request, hoặc null nếu chưa đăng nhập / phiên hết hạn. */
export async function resolveSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const rows = await queryProc("SA_Session_Get", [
    ["TokenHash", sql.Char(64), hashToken(token)],
  ]);
  const row = rows[0];
  if (!row) return null;

  return {
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    expiresAt: row.expiresAt,
  };
}

/* --------------------------------------------------------------------------
   Route
   -------------------------------------------------------------------------- */

/**
 * Trả lời chậm lại khi sai mật khẩu. scrypt đã tốn ~100ms nên dò từ xa vốn đã
 * chậm; thêm một nhịp nữa cho chắc, và để thời gian trả lời của "sai tên" và
 * "sai mật khẩu" gần bằng nhau.
 */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function registerAuthRoutes(router, wrap, HttpError) {
  router.post(
    "/auth/login",
    wrap(async (req, res) => {
      const username = String(req.body?.username || "")
        .trim()
        .toLowerCase();
      const password = String(req.body?.password || "");
      const remember = req.body?.remember === true;

      if (!username || !password) {
        throw new HttpError(400, "Vui lòng nhập tên đăng nhập và mật khẩu.");
      }

      const rows = await queryProc("SA_User_GetByName", [
        ["Username", sql.VarChar(64), username],
      ]);
      const user = rows[0];

      /* Một thông điệp duy nhất cho mọi kiểu sai. Nói "tài khoản không tồn
         tại" là chỉ cho người lạ biết tên nào có thật. */
      const reject = async () => {
        await delay(300);
        throw new HttpError(401, "Tên đăng nhập hoặc mật khẩu không đúng.");
      };

      if (!user || !user.isActive) return reject();

      const ok = await verifyPassword(password, user.password);
      if (!ok) return reject();

      const token = newToken();
      const maxAgeMs = remember
        ? SESSION_DAYS * 24 * 60 * 60 * 1000
        : SHORT_SESSION_HOURS * 60 * 60 * 1000;
      const expiresAt = new Date(Date.now() + maxAgeMs);

      await queryProc("SA_Session_Create", [
        ["TokenHash", sql.Char(64), hashToken(token)],
        ["UserId", sql.Int, user.userId],
        ["ExpiresAt", sql.DateTime2(0), expiresAt],
        [
          "UserAgent",
          sql.NVarChar(256),
          String(req.headers["user-agent"] || "").slice(0, 256) || null,
        ],
      ]);

      setSessionCookie(res, token, maxAgeMs);
      res.json({
        username: user.username,
        displayName: user.displayName,
        remember,
        expiresAt: expiresAt.toISOString(),
      });
    }),
  );

  router.post(
    "/auth/logout",
    wrap(async (req, res) => {
      const token = readCookie(req, SESSION_COOKIE);
      if (token) {
        /* Xoá phiên ở máy chủ chứ không chỉ xoá cookie: cookie đã bị sao chép
           đi nơi khác vẫn phải mất hiệu lực. */
        await queryProc("SA_Session_Delete", [
          ["TokenHash", sql.Char(64), hashToken(token)],
        ]);
      }
      clearSessionCookie(res);
      res.json({ ok: true });
    }),
  );

  /** Client gọi lúc khởi động để biết còn phiên hay không. */
  router.get(
    "/auth/me",
    wrap(async (req, res) => {
      const session = await resolveSession(req);
      if (!session) {
        clearSessionCookie(res);
        return res.status(401).json({ error: "Chưa đăng nhập." });
      }
      res.json({
        username: session.username,
        displayName: session.displayName,
        expiresAt: session.expiresAt,
      });
    }),
  );
}

/**
 * Chặn mọi endpoint chưa đăng nhập.
 *
 * Danh sách mở là DANH SÁCH TRẮNG, không phải danh sách đen: thêm endpoint mới
 * thì mặc định nó được bảo vệ, quên khai báo cũng không hở.
 */
const PUBLIC_PATHS = new Set(["/auth/login", "/auth/logout", "/auth/me"]);

export function requireAuth(HttpError) {
  return async (req, _res, next) => {
    try {
      if (PUBLIC_PATHS.has(req.path)) return next();

      const session = await resolveSession(req);
      if (!session) {
        throw new HttpError(401, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
      }
      req.user = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}
