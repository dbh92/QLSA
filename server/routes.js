/**
 * REST API của hệ thống quản lý suất ăn.
 * Mỗi endpoint là một lớp mỏng bọc quanh một stored procedure SA_*.
 */
import { Router } from "express";
import { sql, queryProc, queryProcSets, getPool } from "./db.js";
import { registerAuthRoutes, requireAuth } from "./auth.js";

const router = Router();

/* --------------------------------------------------------------------------
   Tiện ích
   -------------------------------------------------------------------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Kiểm tra chuỗi ngày 'YYYY-MM-DD'.
 * Ngày được truyền xuống SQL dưới dạng chuỗi: với kiểu `date`, SQL Server luôn
 * hiểu 'YYYY-MM-DD' theo chuẩn ISO nên không bị lệch múi giờ như khi bind Date.
 */
/**
 * Ngày phải ĐÚNG ĐỊNH DẠNG và CÓ THẬT.
 *
 * "2026-15-09" hay "2026-02-31" khớp DATE_RE nhưng không phải ngày nào cả;
 * trước đây chúng đi thẳng xuống SQL Server và chết ở đó với "Error converting
 * data type varchar to date" — lỗi 500 kèm một câu tiếng Anh không nói được
 * tham số nào sai. Bind vào tham số kiểu date là chuyện của SQL Server, còn
 * kiểm dữ liệu là việc của validator này.
 */
function parseDate(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required)
      throw new HttpError(400, `Thiếu tham số ngày "${fieldName}".`);
    return null;
  }
  const s = String(value).trim();
  if (!DATE_RE.test(s)) {
    throw new HttpError(
      400,
      `Tham số "${fieldName}" phải có định dạng YYYY-MM-DD.`,
    );
  }
  /* Dựng lại rồi đối chiếu: JS cuộn tháng 13 sang năm sau và 31/02 sang tháng
     3, nên thành phần nào lệch là ngày đó không tồn tại. */
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new HttpError(
      400,
      `Tham số "${fieldName}" không phải ngày có thật: "${s}".`,
    );
  }
  return s;
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;

/**
 * Kiểm tra chuỗi thời điểm 'YYYY-MM-DD HH:mm:ss' (chấp nhận cả dấu 'T' của
 * input datetime-local) và chuẩn hoá về dạng có dấu cách.
 * Cũng như parseDate: truyền xuống SQL dưới dạng chuỗi vì SQL Server hiểu
 * định dạng ODBC canonical này không mơ hồ, còn bind Date thì lệch múi giờ.
 */
function parseDateTime(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required)
      throw new HttpError(400, `Thiếu tham số thời gian "${fieldName}".`);
    return null;
  }
  const s = String(value).trim();
  if (!DATETIME_RE.test(s)) {
    throw new HttpError(
      400,
      `Tham số "${fieldName}" phải có định dạng YYYY-MM-DD HH:mm:ss.`,
    );
  }
  return s.replace("T", " ");
}

function parseInteger(value, fieldName, { required = true, min = null } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `Thiếu tham số "${fieldName}".`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new HttpError(400, `Tham số "${fieldName}" phải là số nguyên.`);
  }
  if (min !== null && n < min) {
    throw new HttpError(400, `Tham số "${fieldName}" phải >= ${min}.`);
  }
  return n;
}

function parseNumber(value, fieldName, { required = true, min = null } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `Thiếu tham số "${fieldName}".`);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, `Tham số "${fieldName}" phải là số.`);
  }
  if (min !== null && n < min) {
    throw new HttpError(400, `Tham số "${fieldName}" phải >= ${min}.`);
  }
  return n;
}

function parseText(
  value,
  fieldName,
  { required = true, maxLength = 255 } = {},
) {
  const s = value === undefined || value === null ? "" : String(value).trim();
  if (!s) {
    if (required) throw new HttpError(400, `Thiếu tham số "${fieldName}".`);
    return null;
  }
  if (s.length > maxLength) {
    throw new HttpError(
      400,
      `Tham số "${fieldName}" vượt quá ${maxLength} ký tự.`,
    );
  }
  return s;
}

/**
 * Ca cấp phát — chỉ hai giá trị, dòng cũ không mang ca thì về ca ngày.
 * Dùng chung cho sữa (`milkShift`) và chi phí phát sinh (`costShift`).
 */
function parseSupplyShift(value, fieldName) {
  const s = value === undefined || value === null ? "" : String(value).trim().toUpperCase();
  if (!s) return "NGAY";
  if (s !== "NGAY" && s !== "DEM") {
    throw new HttpError(
      400,
      `Tham số "${fieldName}" chỉ nhận "NGAY" (Ca ngày) hoặc "DEM" (Ca đêm).`,
    );
  }
  return s;
}

/** Nhóm nhân sự của suất nhập tay — dòng cũ không mang nhóm thì về người Việt. */
function parseStaffType(value) {
  const s = value === undefined || value === null ? "" : String(value).trim().toUpperCase();
  if (!s) return "VN";
  if (s !== "KR" && s !== "VN") {
    throw new HttpError(
      400,
      'Tham số "staffType" chỉ nhận "KR" (Người Hàn) hoặc "VN" (Người Việt).',
    );
  }
  return s;
}

/**
 * Danh sách id lượt quẹt cần xoá (`MealLog.id` = TB_EVENT_LOG.nEventLogIdn).
 *
 * Chặn trên 50.000: một tháng chỉ ~50.000 lượt quẹt, nên số lớn hơn thế chắc
 * chắn là lỗi phía client chứ không phải yêu cầu thật — và một request khổng
 * lồ sẽ khoá pool kết nối. Bỏ trùng ngay tại đây vì kiểu bảng SA_EventIdList
 * có khoá chính: gửi trùng là cả lượt xoá bị SQL Server từ chối.
 */
const MAX_DELETE_IDS = 50000;

function parseEventIds(value, name = "ids", { required = true } = {}) {
  if (!required && (value === undefined || value === null)) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new HttpError(400, `Thiếu danh sách lượt quẹt cần xóa ("${name}").`);
  }
  if (value.length > MAX_DELETE_IDS) {
    throw new HttpError(
      400,
      `Chỉ xóa được tối đa ${MAX_DELETE_IDS.toLocaleString("vi-VN")} lượt quẹt trong một lần.`,
    );
  }

  const ids = new Set();
  for (const raw of value) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new HttpError(400, `Id lượt quẹt không hợp lệ: "${raw}".`);
    }
    ids.add(n);
  }
  return Array.from(ids);
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseBatchId(value) {
  const v = String(value ?? "").trim();
  if (!UUID_RE.test(v)) {
    throw new HttpError(400, "Mã lượt xóa không hợp lệ.");
  }
  return v;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Bọc handler async để lỗi rơi về error middleware thay vì treo request. */
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* --------------------------------------------------------------------------
   Xác thực
   --------------------------------------------------------------------------
   Đăng ký TRƯỚC `requireAuth` để ba endpoint /auth/* tự chúng đi qua được,
   rồi mọi endpoint khai báo phía dưới đều nằm sau cửa chặn. Thêm endpoint mới
   ở cuối file là mặc định đã được bảo vệ, không phải nhớ gì thêm.
   -------------------------------------------------------------------------- */
registerAuthRoutes(router, wrap, HttpError);
router.use(requireAuth(HttpError));

/* --------------------------------------------------------------------------
   Health
   -------------------------------------------------------------------------- */

router.get(
  "/health",
  wrap(async (_req, res) => {
    const pool = await getPool();
    const r = await pool
      .request()
      .query("SELECT DB_NAME() AS db, SYSDATETIME() AS now");
    res.json({
      status: "ok",
      database: r.recordset[0].db,
      serverTime: r.recordset[0].now,
    });
  }),
);

/* --------------------------------------------------------------------------
   Bootstrap — toàn bộ danh mục khởi động trong 1 lượt gọi
   -------------------------------------------------------------------------- */

router.get(
  "/bootstrap",
  wrap(async (_req, res) => {
    const sets = await queryProcSets("SA_Bootstrap_GetConfig");
    const [
      shifts = [],
      readers = [],
      largeDepartments = [],
      mappings = [],
      priceItems = [],
      settings = [],
      monthlyCosts = [],
      shiftMealCategories = [],
    ] = sets;

    // Đổi danh sách tham số thành object cho tiện dùng ở frontend.
    const settingMap = {};
    for (const s of settings) {
      settingMap[s.key] = s.dataType === "number" ? Number(s.value) : s.value;
    }

    res.json({
      shifts,
      readers,
      largeDepartments,
      mappings,
      priceItems,
      settings: settingMap,
      monthlyCosts,
      shiftMealCategories,
    });
  }),
);

/* --------------------------------------------------------------------------
   Log chấm ăn
   -------------------------------------------------------------------------- */

router.get(
  "/meal-logs",
  wrap(async (req, res) => {
    const from = parseDateTime(req.query.from, "from");
    const to = parseDateTime(req.query.to, "to");
    if (to < from)
      throw new HttpError(400, "Thời điểm kết thúc phải >= thời điểm bắt đầu.");

    const rows = await queryProc("SA_MealLog_GetByRange", [
      ["FromDateTime", sql.VarChar(19), from],
      ["ToDateTime", sql.VarChar(19), to],
    ]);
    res.json(rows);
  }),
);

/* --------------------------------------------------------------------------
   Lượt quẹt đã xóa — popup "Điều Chỉnh Số Liệu" của tab Báo Cáo Chi Phí
   --------------------------------------------------------------------------
   Xóa ở đây là xóa THẬT, áp cho toàn hệ thống: SA_MealLog_GetByRange và
   SA_MealCost_GetMonthly đều bỏ qua lượt quẹt có tên trong TB_EVENT_LOG_DEL.
   Bản sao đầy đủ của dòng bị xóa nằm lại trong bảng đó nên khôi phục được
   nguyên vẹn theo từng lượt xóa (batchId). Ngoại lệ: suất mất mát bị xóa
   (DeleteKind = 'MAT_MAT') vẫn được /meal-logs trả về với `lossDeleted` để
   tab Suất Ăn Mất Mát hiển thị y nguyên.
   -------------------------------------------------------------------------- */

router.get(
  "/meal-log-deletions",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_MealLogDeleted_Get", [
      [
        "FromDate",
        sql.VarChar(10),
        parseDate(req.query.from, "from", { required: false }),
      ],
      [
        "ToDate",
        sql.VarChar(10),
        parseDate(req.query.to, "to", { required: false }),
      ],
    ]);
    res.json(rows);
  }),
);

router.post(
  "/meal-log-deletions",
  wrap(async (req, res) => {
    /* Hai danh sách, hai số phận: `lossIds` là suất mất mát do chấm thẻ sai
       — bị trừ khỏi mọi con số nhưng tab Suất Ăn Mất Mát vẫn hiển thị; `ids`
       là khoản "xóa suất ăn bất kỳ" — biến mất khỏi tất cả. Được phép trống
       một bên, không được trống cả hai. */
    const ids = parseEventIds(req.body.ids, "ids", { required: false });
    const lossIds = parseEventIds(req.body.lossIds, "lossIds", {
      required: false,
    });
    if (ids.length === 0 && lossIds.length === 0) {
      throw new HttpError(400, "Không có lượt quẹt nào để xóa.");
    }
    if (ids.length + lossIds.length > MAX_DELETE_IDS) {
      throw new HttpError(
        400,
        `Chỉ xóa được tối đa ${MAX_DELETE_IDS.toLocaleString("vi-VN")} lượt quẹt trong một lần.`,
      );
    }
    const reason = parseText(req.body.reason, "reason", {
      required: false,
      maxLength: 255,
    });

    /* Table-valued parameter: tên kiểu phải trùng dbo.SA_EventIdList và cột
       phải đúng thứ tự đã khai báo trong 01_schema.sql. */
    const toIdList = (list) => {
      const t = new sql.Table("SA_EventIdList");
      t.columns.add("EventLogIdn", sql.Int, { nullable: false });
      for (const id of list) t.rows.add(id);
      return t;
    };

    const rows = await queryProc("SA_MealLogDeleted_Save", [
      ["Ids", null, toIdList(ids)],
      ["LossIds", null, toIdList(lossIds)],
      ["Reason", sql.NVarChar(255), reason],
      ["UserName", sql.NVarChar(128), req.user?.username ?? null],
      /* Khoảng thời điểm của các lượt quẹt — chỉ để procedure seek được
         clustered index của TB_EVENT_LOG thay vì quét cả bảng. */
      [
        "FromDateTime",
        sql.VarChar(19),
        parseDateTime(req.body.from, "from", { required: false }),
      ],
      [
        "ToDateTime",
        sql.VarChar(19),
        parseDateTime(req.body.to, "to", { required: false }),
      ],
    ]);
    res.json(rows[0] || null);
  }),
);

router.delete(
  "/meal-log-deletions/:batchId",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_MealLogDeleted_Restore", [
      ["BatchId", sql.UniqueIdentifier, parseBatchId(req.params.batchId)],
    ]);
    res.json(rows[0] || { restored: 0 });
  }),
);

/* --------------------------------------------------------------------------
   Bộ phận & ánh xạ
   -------------------------------------------------------------------------- */

router.get(
  "/departments/large",
  wrap(async (_req, res) =>
    res.json(await queryProc("SA_LargeDepartment_Get")),
  ),
);

router.get(
  "/departments/small",
  wrap(async (_req, res) =>
    res.json(await queryProc("SA_SmallDepartment_Get")),
  ),
);

router.get(
  "/mappings",
  wrap(async (_req, res) =>
    res.json(await queryProc("SA_DepartmentMapping_Get")),
  ),
);

router.get(
  "/mapping-rules",
  wrap(async (_req, res) =>
    res.json(await queryProc("SA_DepartmentMappingRule_Get")),
  ),
);

/** Thêm mới hoặc cập nhật một ánh xạ; trả về toàn bộ danh sách sau khi lưu. */
router.post(
  "/mappings",
  wrap(async (req, res) => {
    const smallDepartment = parseText(
      req.body.smallDepartment,
      "smallDepartment",
      { maxLength: 64 },
    );
    const largeDepartment = parseText(
      req.body.largeDepartment,
      "largeDepartment",
      { maxLength: 32 },
    );
    const notes = parseText(req.body.notes, "notes", {
      required: false,
      maxLength: 255,
    });

    const rows = await queryProc("SA_DepartmentMapping_Save", [
      ["SmallDepartment", sql.NVarChar(64), smallDepartment],
      ["LargeDeptCode", sql.NVarChar(32), largeDepartment],
      ["Notes", sql.NVarChar(255), notes],
    ]);
    res.json(rows);
  }),
);

router.delete(
  "/mappings/:smallDepartment",
  wrap(async (req, res) => {
    const smallDepartment = parseText(
      req.params.smallDepartment,
      "smallDepartment",
      { maxLength: 64 },
    );
    const rows = await queryProc("SA_DepartmentMapping_Delete", [
      ["SmallDepartment", sql.NVarChar(64), smallDepartment],
    ]);
    res.json(rows);
  }),
);

/* --------------------------------------------------------------------------
   Khách công tác — gán lại bộ phận lớn cho từng người
   --------------------------------------------------------------------------
   Chỉ áp dụng cho người được một quy tắc có điều kiện quét vào (hôm nay:
   "Khach cong tac" tên chứa 'Business'). SA_GuestDeptOverride_Save tự kiểm
   tra điều kiện đó và RAISERROR nếu không đạt, nên endpoint này không cần
   biết gì về chuỗi 'Business'.

   Một khách có NHIỀU ĐỢT ánh xạ, mỗi đợt một khoảng ngày, nên GET trả về hai
   danh sách trong một lượt gọi: `guests` (ai thuộc diện, kèm số lượt quẹt) và
   `periods` (từng đợt). POST luôn THÊM một đợt trừ khi truyền `overrideId`;
   DELETE xoá theo mã đợt chứ không theo mã thẻ.

   `effectiveFrom` / `effectiveTo` là khoảng NGÀY đợt có hiệu lực; bỏ trống một
   đầu là không giới hạn đầu đó. Thứ tự hai ngày và luật KHÔNG ĐƯỢC TRÙNG với
   đợt khác của cùng khách do procedure kiểm (RAISERROR tiếng Việt) — endpoint
   chỉ kiểm định dạng, vì procedure là chỗ duy nhất mọi lối ghi đi qua.
   -------------------------------------------------------------------------- */

router.get(
  "/guest-overrides",
  wrap(async (req, res) => {
    const [guests = [], periods = []] = await queryProcSets(
      "SA_GuestDeptOverride_Get",
      [
        [
          "FromDateTime",
          sql.VarChar(19),
          parseDateTime(req.query.from, "from", { required: false }),
        ],
        [
          "ToDateTime",
          sql.VarChar(19),
          parseDateTime(req.query.to, "to", { required: false }),
        ],
      ],
    );
    res.json({ guests, periods });
  }),
);

router.post(
  "/guest-overrides",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_GuestDeptOverride_Save", [
      [
        "UserId",
        sql.VarChar(64),
        parseText(req.body.userId, "userId", { maxLength: 64 }),
      ],
      [
        "LargeDeptCode",
        sql.NVarChar(32),
        parseText(req.body.largeDepartment, "largeDepartment", {
          maxLength: 32,
        }),
      ],
      [
        "EffectiveFrom",
        sql.VarChar(10),
        parseDate(req.body.effectiveFrom, "effectiveFrom", {
          required: false,
        }),
      ],
      [
        "EffectiveTo",
        sql.VarChar(10),
        parseDate(req.body.effectiveTo, "effectiveTo", { required: false }),
      ],
      [
        "Notes",
        sql.NVarChar(255),
        parseText(req.body.notes, "notes", {
          required: false,
          maxLength: 255,
        }),
      ],
      [
        "OverrideId",
        sql.Int,
        parseInteger(req.body.overrideId, "overrideId", { required: false }),
      ],
    ]);
    res.json(rows[0] || null);
  }),
);

router.delete(
  "/guest-overrides/:overrideId",
  wrap(async (req, res) => {
    await queryProc("SA_GuestDeptOverride_Delete", [
      [
        "OverrideId",
        sql.Int,
        parseInteger(req.params.overrideId, "overrideId", { min: 1 }),
      ],
    ]);
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------------------------
   Sữa
   -------------------------------------------------------------------------- */

router.get(
  "/milk",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_MilkEntry_Get", [
      [
        "FromDate",
        sql.VarChar(10),
        parseDate(req.query.from, "from", { required: false }),
      ],
      [
        "ToDate",
        sql.VarChar(10),
        parseDate(req.query.to, "to", { required: false }),
      ],
    ]);
    res.json(rows);
  }),
);

router.post(
  "/milk",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_MilkEntry_Save", [
      ["MilkId", sql.Int, parseInteger(req.body.id, "id", { required: false })],
      ["EntryDate", sql.VarChar(10), parseDate(req.body.date, "date")],
      [
        "MilkShift",
        sql.VarChar(4),
        parseSupplyShift(req.body.milkShift, "milkShift"),
      ],
      [
        "MilkType",
        sql.NVarChar(128),
        parseText(req.body.milkType, "milkType", { maxLength: 128 }),
      ],
      [
        "Quantity",
        sql.Int,
        parseInteger(req.body.quantity, "quantity", { min: 1 }),
      ],
      [
        "UnitPrice",
        sql.Decimal(18, 2),
        parseNumber(req.body.unitPrice, "unitPrice", { min: 0 }),
      ],
      [
        "Supplier",
        sql.NVarChar(128),
        parseText(req.body.supplier, "supplier", {
          required: false,
          maxLength: 128,
        }),
      ],
      [
        "Notes",
        sql.NVarChar(500),
        parseText(req.body.notes, "notes", { required: false, maxLength: 500 }),
      ],
    ]);
    res.json(rows[0] || null);
  }),
);

router.delete(
  "/milk/:id",
  wrap(async (req, res) => {
    await queryProc("SA_MilkEntry_Delete", [
      ["MilkId", sql.Int, parseInteger(req.params.id, "id")],
    ]);
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------------------------
   Chi phí phát sinh (kem, quà ngày lễ, ...) — song song với khối Sữa ở trên
   -------------------------------------------------------------------------- */

router.get(
  "/extra-costs",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_ExtraCost_Get", [
      [
        "FromDate",
        sql.VarChar(10),
        parseDate(req.query.from, "from", { required: false }),
      ],
      [
        "ToDate",
        sql.VarChar(10),
        parseDate(req.query.to, "to", { required: false }),
      ],
    ]);
    res.json(rows);
  }),
);

router.post(
  "/extra-costs",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_ExtraCost_Save", [
      [
        "ExtraId",
        sql.Int,
        parseInteger(req.body.id, "id", { required: false }),
      ],
      ["EntryDate", sql.VarChar(10), parseDate(req.body.date, "date")],
      [
        "CostShift",
        sql.VarChar(4),
        parseSupplyShift(req.body.costShift, "costShift"),
      ],
      [
        "CostType",
        sql.NVarChar(128),
        parseText(req.body.costType, "costType", { maxLength: 128 }),
      ],
      [
        "Quantity",
        sql.Int,
        parseInteger(req.body.quantity, "quantity", { min: 1 }),
      ],
      [
        "UnitPrice",
        sql.Decimal(18, 2),
        parseNumber(req.body.unitPrice, "unitPrice", { min: 0 }),
      ],
      [
        "Supplier",
        sql.NVarChar(128),
        parseText(req.body.supplier, "supplier", {
          required: false,
          maxLength: 128,
        }),
      ],
      [
        "Notes",
        sql.NVarChar(500),
        parseText(req.body.notes, "notes", { required: false, maxLength: 500 }),
      ],
    ]);
    res.json(rows[0] || null);
  }),
);

router.delete(
  "/extra-costs/:id",
  wrap(async (req, res) => {
    await queryProc("SA_ExtraCost_Delete", [
      ["ExtraId", sql.Int, parseInteger(req.params.id, "id")],
    ]);
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------------------------
   Cấu hình sinh nhật
   -------------------------------------------------------------------------- */

router.get(
  "/birthday",
  wrap(async (_req, res) => res.json(await queryProc("SA_BirthdayConfig_Get"))),
);

router.post(
  "/birthday",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_BirthdayConfig_Save", [
      [
        "ConfigId",
        sql.Int,
        parseInteger(req.body.id, "id", { required: false }),
      ],
      ["ConfigDate", sql.VarChar(10), parseDate(req.body.date, "date")],
      [
        "Description",
        sql.NVarChar(255),
        parseText(req.body.description, "description", { required: false }),
      ],
      [
        "SpecialMealPrice",
        sql.Decimal(18, 2),
        parseNumber(req.body.specialMealPrice, "specialMealPrice", { min: 0 }),
      ],
    ]);
    res.json(rows[0] || null);
  }),
);

router.delete(
  "/birthday/:id",
  wrap(async (req, res) => {
    await queryProc("SA_BirthdayConfig_Delete", [
      ["ConfigId", sql.Int, parseInteger(req.params.id, "id")],
    ]);
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------------------------
   Nhập thủ công
   -------------------------------------------------------------------------- */

router.get(
  "/manual-entries",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_ManualEntry_Get", [
      [
        "FromDate",
        sql.VarChar(10),
        parseDate(req.query.from, "from", { required: false }),
      ],
      [
        "ToDate",
        sql.VarChar(10),
        parseDate(req.query.to, "to", { required: false }),
      ],
    ]);
    res.json(rows);
  }),
);

router.post(
  "/manual-entries",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_ManualEntry_Save", [
      [
        "EntryId",
        sql.Int,
        parseInteger(req.body.id, "id", { required: false }),
      ],
      ["EntryDate", sql.VarChar(10), parseDate(req.body.date, "date")],
      [
        "ShiftCode",
        sql.NVarChar(10),
        parseText(req.body.shiftCode, "shiftCode", { maxLength: 10 }),
      ],
      ["StaffType", sql.VarChar(2), parseStaffType(req.body.staffType)],
      [
        "Department",
        sql.NVarChar(64),
        parseText(req.body.department, "department", { maxLength: 64 }),
      ],
      [
        "Quantity",
        sql.Int,
        parseInteger(req.body.quantity, "quantity", { min: 1 }),
      ],
      [
        "Reason",
        sql.NVarChar(500),
        parseText(req.body.reason, "reason", {
          required: false,
          maxLength: 500,
        }),
      ],
      [
        "EnteredBy",
        sql.NVarChar(128),
        parseText(req.body.enteredBy, "enteredBy", {
          required: false,
          maxLength: 128,
        }),
      ],
    ]);
    res.json(rows[0] || null);
  }),
);

router.delete(
  "/manual-entries/:id",
  wrap(async (req, res) => {
    await queryProc("SA_ManualEntry_Delete", [
      ["EntryId", sql.Int, parseInteger(req.params.id, "id")],
    ]);
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------------------------
   Danh mục khác
   -------------------------------------------------------------------------- */

router.get(
  "/shifts",
  wrap(async (_req, res) => res.json(await queryProc("SA_Shift_Get"))),
);
router.get(
  "/readers",
  wrap(async (_req, res) => res.json(await queryProc("SA_Reader_Get"))),
);
router.get(
  "/prices",
  wrap(async (_req, res) => res.json(await queryProc("SA_MealPrice_Get"))),
);
/** Sửa đơn giá của một mã suất ăn; trả về toàn bộ bảng giá sau khi lưu. */
router.put(
  "/prices/:code",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_MealPrice_Save", [
      [
        "Code",
        sql.VarChar(32),
        parseText(req.params.code, "code", { maxLength: 32 }),
      ],
      [
        "UnitPrice",
        sql.Decimal(18, 2),
        parseNumber(req.body.unitPrice, "unitPrice", { min: 0 }),
      ],
    ]);
    res.json(rows);
  }),
);

router.get(
  "/shift-meal-categories",
  wrap(async (_req, res) =>
    res.json(await queryProc("SA_ShiftMealCategory_Get")),
  ),
);

/**
 * Gán loại suất cho một (ca, nhóm nhân sự); trả về toàn bộ bảng gán sau khi
 * lưu. Mã ca đi trong body chứ không trong URL vì có mã tiếng Việt ('Khác').
 */
router.put(
  "/shift-meal-categories",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_ShiftMealCategory_Save", [
      [
        "ShiftCode",
        sql.NVarChar(10),
        parseText(req.body.shiftCode, "shiftCode", { maxLength: 10 }),
      ],
      [
        "StaffType",
        sql.VarChar(2),
        parseText(req.body.staffType, "staffType", { maxLength: 2 }),
      ],
      [
        "MealCategory",
        sql.VarChar(16),
        parseText(req.body.mealCategory, "mealCategory", { maxLength: 16 }),
      ],
    ]);
    res.json(rows);
  }),
);

router.get(
  "/monthly-costs",
  wrap(async (_req, res) => res.json(await queryProc("SA_MonthlyCost_Get"))),
);

/**
 * Chi phí suất ăn từng tháng của một năm, tính trực tiếp từ log chấm ăn.
 * Một năm là ~600.000 lượt quẹt nên phải tổng hợp tại SQL Server.
 */
router.get(
  "/monthly-cost-trend",
  wrap(async (req, res) => {
    const year = parseInteger(req.query.year, "year", { min: 2000 });
    if (year > 2999)
      throw new HttpError(400, 'Tham số "year" không hợp lệ.');

    const rows = await queryProc("SA_MealCost_GetMonthly", [
      ["Year", sql.Int, year],
    ]);
    res.json(rows);
  }),
);

/* --------------------------------------------------------------------------
   Kỳ tính chi phí của từng tháng (bảng 12 tháng)
   --------------------------------------------------------------------------
   Mỗi tháng là một khoảng nửa mở [from, to) — xem mục 18 của
   db/01_schema.sql. Lưu theo NGUYÊN NĂM: đủ 12 kỳ, hoặc mảng rỗng để cả năm
   quay về kỳ mặc định. Thứ tự hai mốc, độ dài kỳ và luật không chồng nhau do
   SA_CostMonthPeriod_Save kiểm — endpoint chỉ kiểm định dạng.
   -------------------------------------------------------------------------- */

function parseYear(value) {
  const year = parseInteger(value, "year", { min: 2000 });
  if (year > 2999) throw new HttpError(400, 'Tham số "year" không hợp lệ.');
  return year;
}

router.get(
  "/cost-month-periods",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_CostMonthPeriod_Get", [
      ["Year", sql.Int, parseYear(req.query.year)],
    ]);
    res.json(rows);
  }),
);

router.put(
  "/cost-month-periods/:year",
  wrap(async (req, res) => {
    const year = parseYear(req.params.year);
    const periods = req.body?.periods;
    if (!Array.isArray(periods) || periods.length > 12) {
      throw new HttpError(400, 'Tham số "periods" phải là danh sách tối đa 12 kỳ.');
    }

    /* Mốc thời điểm đi xuống dạng CHUỖI (cột varchar(19) của kiểu bảng),
       đúng quy ước cả hệ thống — procedure tự đổi sang datetime2. */
    const t = new sql.Table("SA_CostMonthPeriodList");
    t.columns.add("MonthNo", sql.Int, { nullable: false });
    t.columns.add("FromDateTime", sql.VarChar(19), { nullable: false });
    t.columns.add("ToDateTime", sql.VarChar(19), { nullable: false });
    for (const p of periods) {
      const monthNo = parseInteger(p?.monthNo, "monthNo", { min: 1 });
      if (monthNo > 12) throw new HttpError(400, "Tháng phải từ 1 đến 12.");
      t.rows.add(
        monthNo,
        parseDateTime(p?.fromDateTime, `fromDateTime (tháng ${monthNo})`),
        parseDateTime(p?.toDateTime, `toDateTime (tháng ${monthNo})`),
      );
    }

    const rows = await queryProc("SA_CostMonthPeriod_Save", [
      ["Year", sql.Int, year],
      ["Periods", null, t],
      ["UserName", sql.NVarChar(128), req.user?.username ?? null],
    ]);
    res.json(rows);
  }),
);
router.get(
  "/settings",
  wrap(async (_req, res) => res.json(await queryProc("SA_SystemSetting_Get"))),
);

router.put(
  "/settings/:key",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_SystemSetting_Save", [
      [
        "SettingKey",
        sql.VarChar(64),
        parseText(req.params.key, "key", { maxLength: 64 }),
      ],
      [
        "SettingValue",
        sql.NVarChar(500),
        parseText(req.body.value, "value", { maxLength: 500 }),
      ],
    ]);
    res.json(rows);
  }),
);

/* --------------------------------------------------------------------------
   Chi phí thuê nhân công
   --------------------------------------------------------------------------
   Ba bảng, ba vai trò — xem mục 17 của db/01_schema.sql. Điều quan trọng ở
   tầng này: GET/POST/DELETE dưới đây chỉ đụng tới BẢN NHÁP, không báo cáo nào
   đọc bản nháp. Chỉ POST /labor-costs/apply mới tạo ra một lượt áp dụng, và
   chỉ lượt áp dụng MỚI NHẤT mới đi vào tiền của bảng kê.

   Khoảng ngày là NỬA MỞ: `effectiveFrom` được tính, `effectiveTo` thì không.
   Thứ tự hai ngày và luật KHÔNG GIAO NHAU giữa hai đợt của cùng một người do
   procedure kiểm (RAISERROR tiếng Việt) — endpoint chỉ kiểm định dạng, vì
   procedure là chỗ duy nhất mọi lối ghi đi qua.
   -------------------------------------------------------------------------- */

/**
 * Tháng gán cho một đợt nhân công, 'YYYY-MM' — CHỈ LÀ NHÃN, không phép tính
 * nào đọc nó. Bỏ trống thì lưu NULL.
 */
function parseCostMonth(value) {
  const s = value === undefined || value === null ? "" : String(value).trim();
  if (!s) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) {
    throw new HttpError(400, 'Tham số "costMonth" phải có định dạng YYYY-MM.');
  }
  return s;
}

/** Quy tắc đếm ngày làm việc — phải khớp CK_SA_LaborBatch_Rule. */
function parseWorkDayRule(value) {
  const s =
    value === undefined || value === null
      ? ""
      : String(value).trim().toUpperCase();
  if (!s) return "ALL";
  if (s !== "ALL" && s !== "MON_SAT" && s !== "MON_FRI") {
    throw new HttpError(
      400,
      'Tham số "workDayRule" chỉ nhận "ALL", "MON_SAT" hoặc "MON_FRI".',
    );
  }
  return s;
}

router.get(
  "/labor-costs",
  wrap(async (_req, res) => {
    const [draft = [], effectiveRows = [], appliedRows = [], batches = []] =
      await queryProcSets("SA_LaborCost_Get");
    res.json({
      draft,
      /* Chưa từng bấm "Áp dụng" thì không có lượt nào có hiệu lực, và chi phí
         nhân công trên mọi bảng kê bằng 0 — đúng như yêu cầu "chưa áp dụng
         thì không ảnh hưởng báo cáo nào". */
      effective: effectiveRows[0] || null,
      appliedRows,
      batches,
    });
  }),
);

router.post(
  "/labor-costs",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_LaborCost_Save", [
      [
        "WorkerName",
        sql.NVarChar(128),
        parseText(req.body.workerName, "workerName", { maxLength: 128 }),
      ],
      [
        "EffectiveFrom",
        sql.VarChar(10),
        parseDate(req.body.effectiveFrom, "effectiveFrom"),
      ],
      [
        "EffectiveTo",
        sql.VarChar(10),
        parseDate(req.body.effectiveTo, "effectiveTo"),
      ],
      [
        "Amount",
        sql.Decimal(18, 2),
        parseNumber(req.body.amount, "amount", { min: 0 }),
      ],
      [
        "Notes",
        sql.NVarChar(255),
        parseText(req.body.notes, "notes", { required: false, maxLength: 255 }),
      ],
      [
        "LaborId",
        sql.Int,
        parseInteger(req.body.id, "id", { required: false, min: 1 }),
      ],
      ["CostMonth", sql.Char(7), parseCostMonth(req.body.costMonth)],
    ]);
    res.json(rows[0] || null);
  }),
);

router.delete(
  "/labor-costs/:id",
  wrap(async (req, res) => {
    await queryProc("SA_LaborCost_Delete", [
      ["LaborId", sql.Int, parseInteger(req.params.id, "id", { min: 1 })],
    ]);
    res.json({ ok: true });
  }),
);

/**
 * "Áp dụng" — chụp bản nháp thành một lượt áp dụng mới.
 *
 * Đây là ranh giới duy nhất giữa "đang gõ" và "đã vào báo cáo". Quy tắc ngày
 * làm việc được đóng băng vào lượt này, nên đổi quy tắc về sau không làm số
 * tiền của các kỳ đã chốt tự nhảy.
 */
router.post(
  "/labor-costs/apply",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_LaborCost_Apply", [
      ["WorkDayRule", sql.VarChar(16), parseWorkDayRule(req.body.workDayRule)],
      ["AppliedBy", sql.NVarChar(128), req.user?.username ?? null],
      [
        "Notes",
        sql.NVarChar(255),
        parseText(req.body.notes, "notes", { required: false, maxLength: 255 }),
      ],
    ]);
    res.json(rows[0] || null);
  }),
);

router.get(
  "/labor-costs/batches/:batchId",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_LaborCostBatch_GetRows", [
      ["BatchId", sql.UniqueIdentifier, parseBatchId(req.params.batchId)],
    ]);
    res.json(rows);
  }),
);

/** Nạp lại một lượt áp dụng cũ vào bản nháp — không đổi lượt đang hiệu lực. */
router.post(
  "/labor-costs/batches/:batchId/restore",
  wrap(async (req, res) => {
    const rows = await queryProc("SA_LaborCostBatch_Restore", [
      ["BatchId", sql.UniqueIdentifier, parseBatchId(req.params.batchId)],
    ]);
    res.json(rows[0] || { restored: 0 });
  }),
);

export default router;
