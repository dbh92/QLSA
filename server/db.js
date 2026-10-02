/**
 * Kết nối SQL Server + các hàm tiện ích gọi stored procedure.
 *
 * Toàn bộ truy cập dữ liệu của hệ thống đi qua stored procedure trong [QLSA]
 * (tiền tố SA_). Server không sinh câu SQL động và không nối chuỗi tham số —
 * mọi tham số đều được bind qua mssql.
 */
import sql from 'mssql';
import 'dotenv/config';

const config = {
  server: process.env.DB_SERVER || '10.70.22.240',
  database: process.env.DB_DATABASE || 'QLSA',
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD || '',
  port: Number(process.env.DB_PORT || 1433),
  pool: {
    max: Number(process.env.DB_POOL_MAX || 10),
    min: 0,
    idleTimeoutMillis: 30000,
  },
  options: {
    // SQL Server 2012 Express — không bật TLS, tin cậy chứng chỉ nội bộ.
    encrypt: String(process.env.DB_ENCRYPT || 'false') === 'true',
    trustServerCertificate: true,
    enableArithAbort: true,
    // Bắt buộc cho các bảng có cột tính toán PERSISTED.
    // (mssql mặc định đã bật, khai báo tường minh cho rõ ràng.)
    useUTC: false,
  },
  requestTimeout: Number(process.env.DB_REQUEST_TIMEOUT || 120000),
  connectionTimeout: Number(process.env.DB_CONNECT_TIMEOUT || 30000),
};

let poolPromise = null;

/** Trả về connection pool dùng chung (tạo một lần, tái sử dụng). */
export function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        console.log(`[db] Đã kết nối ${config.server}/${config.database}`);
        return pool;
      })
      .catch((err) => {
        // Cho phép thử kết nối lại ở lần gọi sau thay vì kẹt promise lỗi.
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

/**
 * Gọi stored procedure.
 * @param {string} procName  tên procedure, ví dụ 'SA_MealLog_GetByRange'
 * @param {Array<[string, any, any]>} params  mảng [tên, kiểu sql, giá trị]
 * @returns {Promise<import('mssql').IProcedureResult<any>>}
 *
 * Tham số kiểu BẢNG (table-valued parameter) truyền với `type = null` và giá
 * trị là một `sql.Table` — mssql tự suy kiểu từ chính đối tượng đó, thêm kiểu
 * vào giữa sẽ làm nó bind hỏng. Dùng cho danh sách dài, ví dụ hàng nghìn lượt
 * quẹt cần xoá trong SA_MealLogDeleted_Save.
 */
export async function callProc(procName, params = []) {
  const pool = await getPool();
  const request = pool.request();
  for (const [name, type, value] of params) {
    if (type === null) request.input(name, value);
    else request.input(name, type, value === undefined ? null : value);
  }
  return request.execute(procName);
}

/** Gọi procedure và trả về result set đầu tiên. */
export async function queryProc(procName, params = []) {
  const result = await callProc(procName, params);
  return result.recordset || [];
}

/** Gọi procedure trả về nhiều result set. */
export async function queryProcSets(procName, params = []) {
  const result = await callProc(procName, params);
  return result.recordsets || [];
}

export async function closePool() {
  if (poolPromise) {
    const pool = await poolPromise;
    poolPromise = null;
    await pool.close();
  }
}

export { sql, config as dbConfig };
