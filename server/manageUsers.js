/**
 * Quản lý tài khoản đăng nhập từ dòng lệnh.
 *
 *   npm run user -- list
 *   npm run user -- add <tên đăng nhập> "<Tên hiển thị>" [mật khẩu]
 *   npm run user -- passwd <tên đăng nhập> [mật khẩu mới]
 *   npm run user -- disable <tên đăng nhập>
 *   npm run user -- enable  <tên đăng nhập>
 *
 * Bỏ trống mật khẩu thì tự sinh một mật khẩu ngẫu nhiên.
 *
 * Mật khẩu lưu dạng thường (xem server/auth.js) nên `list` xem lại được — tiện
 * cho việc nhắc lại mật khẩu cho người dùng quên.
 *
 * Cố ý làm bằng dòng lệnh chứ không làm màn hình quản trị trong ứng dụng: xem
 * và đặt lại mật khẩu là việc của người có quyền vào máy chủ, không nên để lộ
 * ra một trang web mà bất kỳ ai đăng nhập được cũng bấm vào.
 */
import crypto from "node:crypto";
import "dotenv/config";
import { sql, queryProc, closePool } from "./db.js";
import { preparePassword } from "./auth.js";

/** Mật khẩu ngẫu nhiên dễ đọc lại cho nhau, tránh ký tự dễ nhìn nhầm. */
function generatePassword(length = 16) {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const usage = () => {
  console.log(`
Quản lý tài khoản đăng nhập QLSA

  npm run user -- list
  npm run user -- add <tên đăng nhập> "<Tên hiển thị>" [mật khẩu]
  npm run user -- passwd <tên đăng nhập> [mật khẩu mới]
  npm run user -- disable <tên đăng nhập>
  npm run user -- enable  <tên đăng nhập>

Bỏ trống mật khẩu thì hệ thống tự sinh. Xem lại mật khẩu bằng lệnh list.
`);
};

async function getUser(username) {
  const rows = await queryProc("SA_User_GetByName", [
    ["Username", sql.VarChar(64), username],
  ]);
  return rows[0] || null;
}

async function save(username, displayName, password, isActive) {
  await queryProc("SA_User_Save", [
    ["Username", sql.VarChar(64), username],
    ["DisplayName", sql.NVarChar(128), displayName],
    ["Password", sql.VarChar(256), password],
    ["IsActive", sql.Bit, isActive ? 1 : 0],
  ]);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  if (command === "list") {
    const rows = await queryProc("SA_User_List");
    if (rows.length === 0) {
      console.log("Chưa có tài khoản nào. Tạo bằng: npm run user -- add ...");
      return;
    }
    console.table(
      rows.map((r) => ({
        "Tên đăng nhập": r.username,
        "Tên hiển thị": r.displayName,
        "Mật khẩu": r.password,
        "Hoạt động": r.isActive ? "có" : "KHÔNG",
        "Đăng nhập lần cuối": r.lastLoginAt || "(chưa bao giờ)",
      })),
    );
    return;
  }

  const username = String(args[0] || "").trim().toLowerCase();
  if (!username) {
    console.error("Thiếu tên đăng nhập.");
    usage();
    process.exitCode = 1;
    return;
  }

  if (command === "add") {
    if (await getUser(username)) {
      console.error(
        `Tài khoản "${username}" đã tồn tại. Đổi mật khẩu bằng: npm run user -- passwd ${username}`,
      );
      process.exitCode = 1;
      return;
    }
    const displayName = String(args[1] || username).trim();
    const password = args[2] || generatePassword();
    await save(username, displayName, preparePassword(password), true);

    console.log(`\nĐã tạo tài khoản "${username}" (${displayName}).`);
    if (!args[2]) {
      console.log(`Mật khẩu: ${password}`);
      console.log("Ghi lại ngay — mật khẩu này KHÔNG hiện lại lần nào nữa.\n");
    }
    return;
  }

  const existing = await getUser(username);
  if (!existing) {
    console.error(`Không có tài khoản "${username}".`);
    process.exitCode = 1;
    return;
  }

  if (command === "passwd") {
    const password = args[1] || generatePassword();
    await save(
      username,
      existing.displayName,
      preparePassword(password),
      existing.isActive,
    );
    console.log(`\nĐã đổi mật khẩu của "${username}".`);
    if (!args[1]) {
      console.log(`Mật khẩu mới: ${password}`);
    }
    console.log("Mọi phiên đăng nhập cũ của tài khoản này đã bị huỷ.\n");
    return;
  }

  if (command === "disable" || command === "enable") {
    /* Giữ nguyên mật khẩu cũ: khoá tài khoản không phải là đổi mật khẩu. */
    await save(
      username,
      existing.displayName,
      existing.password,
      command === "enable",
    );
    console.log(
      command === "enable"
        ? `Đã mở lại tài khoản "${username}".`
        : `Đã khoá tài khoản "${username}" và huỷ mọi phiên đang mở.`,
    );
    return;
  }

  console.error(`Lệnh không hiểu: ${command}`);
  usage();
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Lỗi:", err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
