import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require('multer');

export function getTaskAttachmentMulterOptions(): any {
  const rawRoot = process.env.STORAGE_LOCAL_ROOT || path.join(process.cwd(), 'storage');
  const spoolDir = path.join(path.resolve(rawRoot), '.tmp_spool');

  if (!fs.existsSync(spoolDir)) {
    fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  }

  const diskStorage = multer.diskStorage({
    destination: (_req: any, _file: any, cb: any) => {
      cb(null, spoolDir);
    },
    filename: (_req: any, _file: any, cb: any) => {
      const spoolId = `spool_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.tmp`;
      cb(null, spoolId);
    },
  });

  return {
    storage: diskStorage,
    preservePath: true,
    limits: {
      fileSize: 26_214_400, // 25 MB
      files: 1,
    },
  };
}
