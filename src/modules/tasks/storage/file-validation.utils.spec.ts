import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { FileValidationUtils } from './file-validation.utils';

describe('FileValidationUtils (Unit Tests)', () => {
  const tmpDir = path.join(process.cwd(), 'validation_unit_test');

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterAll(async () => {
    if (fs.existsSync(tmpDir)) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should reject prohibited extensions (.exe, .bat, .dll, .docm, .xlsm)', async () => {
    const filePath = path.join(tmpDir, 'test.exe');
    fs.writeFileSync(filePath, Buffer.from('MZ\x90\x00'));

    await expect(
      FileValidationUtils.validateFile(filePath, 'malicious.exe', 'application/octet-stream', 4),
    ).rejects.toThrow(BadRequestException);

    await expect(
      FileValidationUtils.validateFile(filePath, 'macro.docm', 'application/vnd.ms-word', 4),
    ).rejects.toThrow(BadRequestException);
  });

  it('should validate genuine PDF and PNG files by magic bytes', async () => {
    const pdfPath = path.join(tmpDir, 'valid.pdf');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.7\nSample content'));

    const pdfRes = await FileValidationUtils.validateFile(
      pdfPath,
      'valid.pdf',
      'application/pdf',
      24,
    );
    expect(pdfRes.valid).toBe(true);
    expect(pdfRes.detectedMime).toBe('application/pdf');

    const pngPath = path.join(tmpDir, 'valid.png');
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    fs.writeFileSync(pngPath, pngHeader);

    const pngRes = await FileValidationUtils.validateFile(
      pngPath,
      'valid.png',
      'image/png',
      10,
    );
    expect(pngRes.valid).toBe(true);
    expect(pngRes.detectedMime).toBe('image/png');
  });

  it('should reject spoofed extension (e.g. Windows executable disguised as PDF)', async () => {
    const spoofedPath = path.join(tmpDir, 'spoofed.pdf');
    fs.writeFileSync(spoofedPath, Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff'));

    await expect(
      FileValidationUtils.validateFile(spoofedPath, 'document.pdf', 'application/pdf', 14),
    ).rejects.toThrow(BadRequestException);
  });

  it('should validate clean SVG and reject SVG containing scripts or XSS vectors', async () => {
    const cleanSvgPath = path.join(tmpDir, 'clean.svg');
    fs.writeFileSync(cleanSvgPath, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');

    const cleanRes = await FileValidationUtils.validateFile(
      cleanSvgPath,
      'vector.svg',
      'image/svg+xml',
      78,
    );
    expect(cleanRes.valid).toBe(true);
    expect(cleanRes.detectedMime).toBe('image/svg+xml');

    // XSS with script tag
    const xssSvgPath = path.join(tmpDir, 'xss.svg');
    fs.writeFileSync(xssSvgPath, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    await expect(
      FileValidationUtils.validateFile(xssSvgPath, 'xss.svg', 'image/svg+xml', 70),
    ).rejects.toThrow(BadRequestException);

    // XSS with onload event handler
    const eventSvgPath = path.join(tmpDir, 'event.svg');
    fs.writeFileSync(eventSvgPath, '<svg onload="alert(document.cookie)"></svg>');

    await expect(
      FileValidationUtils.validateFile(eventSvgPath, 'event.svg', 'image/svg+xml', 45),
    ).rejects.toThrow(BadRequestException);
  });

  /**
   * Helper to construct a valid in-memory ZIP buffer with customizable CD entries.
   */
  function buildTestZip(
    entries: Array<{
      name: string;
      content: string;
      gpFlag?: number;
      externalAttr?: number;
      overrideCompressedSize?: number;
      overrideUncompressedSize?: number;
      corruptLfhSig?: boolean;
    }>,
  ): Buffer {
    const parts: Buffer[] = [];
    const cdEntries: Buffer[] = [];
    let offset = 0;

    for (const ent of entries) {
      const nameBuf = Buffer.from(ent.name, 'utf8');
      const dataBuf = Buffer.from(ent.content, 'utf8');
      const lfhOffset = offset;
      const gpFlag = ent.gpFlag || 0;
      const uncompSize = ent.overrideUncompressedSize !== undefined ? ent.overrideUncompressedSize : dataBuf.length;
      const compSize = ent.overrideCompressedSize !== undefined ? ent.overrideCompressedSize : dataBuf.length;

      // Local File Header (30 bytes)
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(ent.corruptLfhSig ? 0x00000000 : 0x04034b50, 0); // signature
      lfh.writeUInt16LE(20, 4); // version needed
      lfh.writeUInt16LE(gpFlag, 6);
      lfh.writeUInt16LE(0, 8); // compression: 0 (stored)
      lfh.writeUInt16LE(0, 10); // time
      lfh.writeUInt16LE(0, 12); // date
      lfh.writeUInt32LE(0, 14); // crc32
      lfh.writeUInt32LE(compSize, 18);
      lfh.writeUInt32LE(uncompSize, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      lfh.writeUInt16LE(0, 28); // extra field len

      parts.push(lfh, nameBuf, dataBuf);
      offset += 30 + nameBuf.length + dataBuf.length;

      // Central Directory Header (46 bytes)
      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0); // signature
      cdh.writeUInt16LE(20, 4); // version made by
      cdh.writeUInt16LE(20, 6); // version needed
      cdh.writeUInt16LE(gpFlag, 8);
      cdh.writeUInt16LE(0, 10); // compression: 0
      cdh.writeUInt16LE(0, 12); // time
      cdh.writeUInt16LE(0, 14); // date
      cdh.writeUInt32LE(0, 16); // crc32
      cdh.writeUInt32LE(compSize, 20);
      cdh.writeUInt32LE(uncompSize, 24);
      cdh.writeUInt16LE(nameBuf.length, 28);
      cdh.writeUInt16LE(0, 30); // extra len
      cdh.writeUInt16LE(0, 32); // comment len
      cdh.writeUInt16LE(0, 34); // disk start
      cdh.writeUInt16LE(0, 36); // internal attr
      // If unsigned external attribute is passed
    const unsignedAttr = ent.externalAttr !== undefined ? (ent.externalAttr >>> 0) : 0;
    cdh.writeUInt32LE(unsignedAttr, 38); // external attr
      cdh.writeUInt32LE(lfhOffset, 42); // local header offset

      cdEntries.push(cdh, nameBuf);
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const b of cdEntries) {
      parts.push(b);
      cdSize += b.length;
    }

    // End of Central Directory (22 bytes)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // start disk
    eocd.writeUInt16LE(entries.length, 8); // entries on disk
    eocd.writeUInt16LE(entries.length, 10); // total entries
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20); // comment len
    parts.push(eocd);

    return Buffer.concat(parts);
  }

  it('should accept valid clean ZIP archive', async () => {
    const zipBuf = buildTestZip([{ name: 'readme.txt', content: 'Hello World!' }]);
    const zipPath = path.join(tmpDir, 'valid.zip');
    fs.writeFileSync(zipPath, zipBuf);

    const res = await FileValidationUtils.validateFile(zipPath, 'valid.zip', 'application/zip', zipBuf.length);
    expect(res.valid).toBe(true);
    expect(res.isArchive).toBe(true);
  });

  it('should reject password-protected or encrypted archive (bit 0 set)', async () => {
    const encZipBuf = buildTestZip([{ name: 'secret.txt', content: 'Hidden', gpFlag: 0x0001 }]);
    const encZipPath = path.join(tmpDir, 'encrypted.zip');
    fs.writeFileSync(encZipPath, encZipBuf);

    await expect(
      FileValidationUtils.validateFile(encZipPath, 'encrypted.zip', 'application/zip', encZipBuf.length),
    ).rejects.toThrow(/encrypted archives are strictly prohibited/i);
  });

  it('should reject archive containing symbolic links', async () => {
    const symlinkAttr = 0o120777 << 16;
    const symZipBuf = buildTestZip([{ name: 'link_to_root', content: '/etc/passwd', externalAttr: symlinkAttr }]);
    const symZipPath = path.join(tmpDir, 'symlink.zip');
    fs.writeFileSync(symZipPath, symZipBuf);

    await expect(
      FileValidationUtils.validateFile(symZipPath, 'symlink.zip', 'application/zip', symZipBuf.length),
    ).rejects.toThrow(/symbolic links are strictly prohibited/i);
  });

  it('should reject archive containing duplicate entry paths', async () => {
    const dupZipBuf = buildTestZip([
      { name: 'config.json', content: '{"version": 1}' },
      { name: 'config.json', content: '{"version": 2}' },
    ]);
    const dupZipPath = path.join(tmpDir, 'duplicate.zip');
    fs.writeFileSync(dupZipPath, dupZipBuf);

    await expect(
      FileValidationUtils.validateFile(dupZipPath, 'dup.zip', 'application/zip', dupZipBuf.length),
    ).rejects.toThrow(/duplicate entry/i);
  });

  it('should reject archive containing path traversal entries', async () => {
    const travZipBuf = buildTestZip([{ name: '../../evil.sh', content: 'echo bad' }]);
    const travZipPath = path.join(tmpDir, 'traversal.zip');
    fs.writeFileSync(travZipPath, travZipBuf);

    await expect(
      FileValidationUtils.validateFile(travZipPath, 'trav.zip', 'application/zip', travZipBuf.length),
    ).rejects.toThrow(/traversal characters/i);
  });

  it('should reject archive containing prohibited executable payload', async () => {
    const exeZipBuf = buildTestZip([{ name: 'subfolder/payload.exe', content: 'binary' }]);
    const exeZipPath = path.join(tmpDir, 'payload.zip');
    fs.writeFileSync(exeZipPath, exeZipBuf);

    await expect(
      FileValidationUtils.validateFile(exeZipPath, 'payload.zip', 'application/zip', exeZipBuf.length),
    ).rejects.toThrow(/prohibited executable or macro/i);
  });

  it('should reject archive containing Office macros (vbaProject.bin)', async () => {
    const macroZipBuf = buildTestZip([{ name: 'word/vbaProject.bin', content: 'macro code' }]);
    const macroZipPath = path.join(tmpDir, 'macro.docx');
    fs.writeFileSync(macroZipPath, macroZipBuf);

    await expect(
      FileValidationUtils.validateFile(macroZipPath, 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', macroZipBuf.length),
    ).rejects.toThrow(/macro-enabled components/i);
  });

  it('should reject ZIP bomb exceeding compression ratio limit (> 20:1 on large entry)', async () => {
    const bombZipBuf = buildTestZip([
      {
        name: 'huge.txt',
        content: 'x',
        overrideCompressedSize: 1000,
        overrideUncompressedSize: 500_000, // 500:1 ratio
      },
    ]);
    const bombZipPath = path.join(tmpDir, 'bomb.zip');
    fs.writeFileSync(bombZipPath, bombZipBuf);

    await expect(
      FileValidationUtils.validateFile(bombZipPath, 'bomb.zip', 'application/zip', bombZipBuf.length),
    ).rejects.toThrow(/suspicious compression ratio/i);
  });

  it('should reject archive with Local File Header mismatch (evasion attempt)', async () => {
    const mismatchZipBuf = buildTestZip([
      {
        name: 'first_valid.txt',
        content: 'data',
      },
      {
        name: 'second_corrupted.txt',
        content: 'data',
        corruptLfhSig: true,
      },
    ]);
    const mismatchZipPath = path.join(tmpDir, 'mismatch.zip');
    fs.writeFileSync(mismatchZipPath, mismatchZipBuf);

    await expect(
      FileValidationUtils.validateFile(mismatchZipPath, 'mismatch.zip', 'application/zip', mismatchZipBuf.length),
    ).rejects.toThrow(/Local Header signature invalid/i);
  });

  it('should reject archive exceeding total uncompressed size limit of 50 MB', async () => {
    const hugeZipBuf = buildTestZip([
      {
        name: 'huge_data.bin',
        content: 'data',
        overrideCompressedSize: 6_000_000,
        overrideUncompressedSize: 53_000_000, // > 50 MB (52,428,800 bytes)
      },
    ]);
    const hugeZipPath = path.join(tmpDir, 'huge.zip');
    fs.writeFileSync(hugeZipPath, hugeZipBuf);

    await expect(
      FileValidationUtils.validateFile(hugeZipPath, 'huge.zip', 'application/zip', hugeZipBuf.length),
    ).rejects.toThrow(/exceeds maximum allowed limit of 50 MB/i);
  });

  it('should reject archive containing more than 500 entries', async () => {
    // Construct EOCD claiming 501 entries
    const entries: Array<{ name: string; content: string }> = [];
    for (let i = 0; i < 501; i++) {
      entries.push({ name: `file_${i}.txt`, content: 'ok' });
    }
    const maxEntriesZipBuf = buildTestZip(entries);
    const maxEntriesPath = path.join(tmpDir, 'max_entries.zip');
    fs.writeFileSync(maxEntriesPath, maxEntriesZipBuf);

    await expect(
      FileValidationUtils.validateFile(maxEntriesPath, 'max.zip', 'application/zip', maxEntriesZipBuf.length),
    ).rejects.toThrow(/Archive contains 501 entries, exceeding maximum allowed of 500/i);
  });

  it('should reject archive when Central Directory size exceeds 2 MB', async () => {
    // Construct valid base ZIP then tamper EOCD cdSize to 2.5 MB
    const baseZip = buildTestZip([{ name: 'test.txt', content: 'test' }]);
    const tampered = Buffer.from(baseZip);
    // EOCD is last 22 bytes. cdSize is at offset 12 from EOCD start
    const eocdOffset = tampered.length - 22;
    tampered.writeUInt32LE(2.5 * 1024 * 1024, eocdOffset + 12); // 2.5 MB

    const cdTamperPath = path.join(tmpDir, 'cd_tamper.zip');
    fs.writeFileSync(cdTamperPath, tampered);

    await expect(
      FileValidationUtils.validateFile(cdTamperPath, 'cd_tamper.zip', 'application/zip', tampered.length),
    ).rejects.toThrow(/Central Directory size .* exceeds maximum allowable 2 MB/i);
  });

  it('should reject archive when overall compression ratio exceeds 10:1', async () => {
    const ratioZipBuf = buildTestZip([
      {
        name: 'ratio.txt',
        content: 'data',
        overrideCompressedSize: 10,
        overrideUncompressedSize: 2000, // 2000 uncompressed vs ~120 total zip size -> ~16.6:1 overall (> 10:1)
      },
    ]);
    const ratioPath = path.join(tmpDir, 'ratio.zip');
    fs.writeFileSync(ratioPath, ratioZipBuf);

    await expect(
      FileValidationUtils.validateFile(ratioPath, 'ratio.zip', 'application/zip', ratioZipBuf.length),
    ).rejects.toThrow(/Overall archive compression ratio .* exceeds maximum 10:1 limit/i);
  });

  it('should reject ZIP64 archive format locator', async () => {
    // Construct valid base ZIP with ZIP64 locator header (0x07064b50) inserted before EOCD
    const baseZip = buildTestZip([{ name: 'test.txt', content: 'test' }]);
    const zip64Locator = Buffer.alloc(20);
    zip64Locator.writeUInt32LE(0x07064b50, 0); // ZIP64 locator signature

    // Insert locator right before the last 22 bytes (EOCD)
    const eocd = baseZip.subarray(baseZip.length - 22);
    const body = baseZip.subarray(0, baseZip.length - 22);
    const zip64Buf = Buffer.concat([body, zip64Locator, eocd]);

    const zip64Path = path.join(tmpDir, 'zip64.zip');
    fs.writeFileSync(zip64Path, zip64Buf);

    await expect(
      FileValidationUtils.validateFile(zip64Path, 'zip64.zip', 'application/zip', zip64Buf.length),
    ).rejects.toThrow(/ZIP64 archive format is prohibited for security/i);
  });
});
