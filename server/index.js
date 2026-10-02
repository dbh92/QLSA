/**
 * API server của Hệ thống Quản lý và Theo dõi Suất ăn.
 *
 *   npm run server      chạy API (mặc định cổng 4000)
 *   npm run dev:all     chạy song song API + Vite dev server
 *
 * Vite proxy /api -> cổng này (xem vite.config.ts), nên frontend chỉ cần gọi
 * đường dẫn tương đối /api/... ở cả môi trường dev lẫn production.
 */
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import router, { HttpError } from './routes.js';
import { getPool, closePool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const app = express();
const PORT = Number(process.env.PORT || 4000);

// Một tháng dữ liệu chấm ăn là ~50.000 dòng JSON; gzip đưa nó về vài trăm KB.
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api', router);

// Phục vụ bản build production nếu đã có (npm run build).
const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

// 404 cho các đường dẫn /api không tồn tại.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Không tìm thấy endpoint.' }));

// Error handler tập trung.
app.use((err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({
    error: err.message || 'Lỗi máy chủ không xác định.',
    // Lỗi do RAISERROR trong stored procedure có mã riêng, trả về để dễ tra cứu.
    ...(err.number ? { sqlErrorNumber: err.number } : {}),
  });
});

async function start() {
  try {
    await getPool(); // fail fast nếu không kết nối được SQL Server
  } catch (err) {
    console.error('[db] Không kết nối được SQL Server:', err.message);
    process.exit(1);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[api] Đang lắng nghe trên http://0.0.0.0:${PORT}`);
  });

  const shutdown = async () => {
    server.close();
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
