import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface FileValidationResult {
  valid: boolean;
  detectedMime: string;
  isArchive: boolean;
  isOfficeDocument: boolean;
  warning?: string;
}

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-tar',
  'application/json',
  'text/markdown',
]);

const FORBIDDEN_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.sh',
  '.vbs',
  '.ps1',
  '.scr',
  '.jar',
  '.msi',
  '.com',
  '.pif',
  '.docm',
  '.xlsm',
  '.dotm',
  '.xltm',
  '.pptm',
]);

const MAX_ARCHIVE_ENTRIES = 500;
const MAX_UNCOMPRESSED_SIZE_BYTES = 52_428_800; // 50 MB
const MAX_OVERALL_RATIO = 10.0;
const MAX_ENTRY_RATIO = 20.0;
const MAX_CENTRAL_DIRECTORY_SIZE = 2 * 1024 * 1024; // 2 MB

export class FileValidationUtils {
  /**
   * Performs deep multi-layer validation of an uploaded file spooled on disk.
   */
  public static async validateFile(
    filePath: string,
    originalName: string,
    claimedMime: string,
    fileSizeBytes: number,
  ): Promise<FileValidationResult> {
    if (!fs.existsSync(filePath)) {
      throw new BadRequestException('Uploaded file does not exist on disk.');
    }

    const ext = path.extname(originalName).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`File extension '${ext}' is strictly prohibited for security.`);
    }

    // 1. Magic byte verification
    const detectedMime = this.validateMagicBytes(filePath, claimedMime, ext);

    const isZipBased =
      detectedMime === 'application/zip' ||
      detectedMime === 'application/x-zip-compressed' ||
      detectedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      detectedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    const isOffice =
      detectedMime === 'application/msword' ||
      detectedMime === 'application/vnd.ms-excel' ||
      detectedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      detectedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    // 2. Safe in-memory ZIP inspection for ZIP and OpenXML formats
    if (isZipBased) {
      this.validateZipArchiveHardened(filePath, fileSizeBytes, isOffice);
    }

    // 3. OLECF legacy Office macro check (.doc / .xls)
    if (detectedMime === 'application/msword' || detectedMime === 'application/vnd.ms-excel') {
      this.validateOleDocument(filePath);
    }

    // 4. SVG Deep Inspection
    if (detectedMime === 'image/svg+xml') {
      this.validateSvgContent(filePath);
    }

    return {
      valid: true,
      detectedMime,
      isArchive: isZipBased && !isOffice,
      isOfficeDocument: isOffice,
    };
  }

  /**
   * Inspects magic bytes at the beginning of the file.
   */
  public static validateMagicBytes(filePath: string, claimedMime: string, ext: string): string {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, header, 0, 4096, 0);
    fs.closeSync(fd);

    if (bytesRead < 4) {
      throw new BadRequestException('File is too small or empty.');
    }

    // PDF: %PDF-
    if (header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) {
      return 'application/pdf';
    }

    // PNG: \x89PNG\r\n\x1a\n
    if (
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47 &&
      header[4] === 0x0d &&
      header[5] === 0x0a &&
      header[6] === 0x1a &&
      header[7] === 0x0a
    ) {
      return 'image/png';
    }

    // JPEG: FF D8 FF
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return 'image/jpeg';
    }

    // GIF: GIF87a or GIF89a
    if (
      header[0] === 0x47 &&
      header[1] === 0x49 &&
      header[2] === 0x46 &&
      header[3] === 0x38 &&
      (header[4] === 0x37 || header[4] === 0x39) &&
      header[5] === 0x61
    ) {
      return 'image/gif';
    }

    // WebP: RIFF....WEBP
    if (
      header[0] === 0x52 &&
      header[1] === 0x49 &&
      header[2] === 0x46 &&
      header[3] === 0x46 &&
      header[8] === 0x57 &&
      header[9] === 0x45 &&
      header[10] === 0x42 &&
      header[11] === 0x50
    ) {
      return 'image/webp';
    }

    // ZIP / OpenXML: PK\x03\x04
    if (header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04) {
      if (ext === '.docx') {
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      }
      if (ext === '.xlsx') {
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      }
      return 'application/zip';
    }

    // GZIP: 1F 8B
    if (header[0] === 0x1f && header[1] === 0x8b) {
      return 'application/gzip';
    }

    // OLE Compound Document: D0 CF 11 E0 A1 B1 1A E1 (.doc, .xls)
    if (
      header[0] === 0xd0 &&
      header[1] === 0xcf &&
      header[2] === 0x11 &&
      header[3] === 0xe0 &&
      header[4] === 0xa1 &&
      header[5] === 0xb1 &&
      header[6] === 0x1a &&
      header[7] === 0xe1
    ) {
      if (ext === '.xls') return 'application/vnd.ms-excel';
      return 'application/msword';
    }

    // TAR: check offset 257 for 'ustar'
    if (bytesRead >= 262) {
      const ustar = header.subarray(257, 262).toString('ascii');
      if (ustar === 'ustar') {
        return 'application/x-tar';
      }
    }

    // Text-based: SVG, JSON, CSV, Markdown, Plain Text
    const slice = header.subarray(0, bytesRead);
    const textSample = slice.toString('utf8');

    // SVG: contains <svg
    if (
      (textSample.includes('<svg') || textSample.includes('<?xml')) &&
      (ext === '.svg' || claimedMime === 'image/svg+xml')
    ) {
      if (textSample.includes('<svg')) {
        return 'image/svg+xml';
      }
    }

    // JSON
    if (ext === '.json') {
      try {
        JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return 'application/json';
      } catch {
        throw new BadRequestException('Malformed JSON file content.');
      }
    }

    // Plain text / CSV / Markdown (no null bytes)
    let hasNull = false;
    for (let i = 0; i < bytesRead; i++) {
      if (header[i] === 0x00) {
        hasNull = true;
        break;
      }
    }

    if (!hasNull) {
      if (ext === '.csv') return 'text/csv';
      if (ext === '.md') return 'text/markdown';
      if (ext === '.txt') return 'text/plain';
    }

    // If file claims an allowed MIME but signature didn't match
    throw new BadRequestException(
      `File signature does not match allowed MIME types. Spoofed or unsupported file format rejected.`,
    );
  }

  /**
   * Hardened in-memory Central Directory parser for ZIP and OpenXML archives.
   * Never extracts file contents to disk.
   */
  public static validateZipArchiveHardened(
    filePath: string,
    fileSizeBytes: number,
    isOffice: boolean,
  ): void {
    const fd = fs.openSync(filePath, 'r');
    try {
      if (fileSizeBytes < 22) {
        throw new BadRequestException('Malformed or incomplete ZIP archive (size < 22 bytes).');
      }

      // 1. Locate End of Central Directory (EOCD) from the last 65,557 bytes
      const searchLen = Math.min(fileSizeBytes, 65557);
      const searchBuf = Buffer.alloc(searchLen);
      fs.readSync(fd, searchBuf, 0, searchLen, fileSizeBytes - searchLen);

      let eocdOffset = -1;
      for (let i = searchLen - 22; i >= 0; i--) {
        if (
          searchBuf[i] === 0x50 &&
          searchBuf[i + 1] === 0x4b &&
          searchBuf[i + 2] === 0x05 &&
          searchBuf[i + 3] === 0x06
        ) {
          eocdOffset = fileSizeBytes - searchLen + i;
          break;
        }
      }

      if (eocdOffset === -1) {
        throw new BadRequestException('Archive End of Central Directory (EOCD) not found.');
      }

      // Check for ZIP64 locator (0x07064b50) in tail buffer
      for (let i = 0; i < searchLen - 4; i++) {
        if (
          searchBuf[i] === 0x50 &&
          searchBuf[i + 1] === 0x4b &&
          searchBuf[i + 2] === 0x06 &&
          searchBuf[i + 3] === 0x07
        ) {
          throw new BadRequestException('ZIP64 archive format is prohibited for security.');
        }
      }

      // Read EOCD record (22 bytes)
      const eocdRecord = Buffer.alloc(22);
      fs.readSync(fd, eocdRecord, 0, 22, eocdOffset);

      const diskNumber = eocdRecord.readUInt16LE(4);
      const startDisk = eocdRecord.readUInt16LE(6);
      const entriesOnDisk = eocdRecord.readUInt16LE(8);
      const totalEntries = eocdRecord.readUInt16LE(10);
      const cdSize = eocdRecord.readUInt32LE(12);
      const cdOffset = eocdRecord.readUInt32LE(16);

      // Multi-disk check
      if (diskNumber !== 0 || startDisk !== 0 || entriesOnDisk !== totalEntries) {
        throw new BadRequestException('Multi-disk spanned ZIP archives are prohibited.');
      }

      // ZIP64 overflow indicator checks
      if (
        totalEntries === 0xffff ||
        cdSize === 0xffffffff ||
        cdOffset === 0xffffffff
      ) {
        throw new BadRequestException('ZIP64 archive format is prohibited for security.');
      }

      // Entry count ceiling
      if (totalEntries > MAX_ARCHIVE_ENTRIES) {
        throw new BadRequestException(
          `Archive contains ${totalEntries} entries, exceeding maximum allowed of ${MAX_ARCHIVE_ENTRIES}.`,
        );
      }

      // Central Directory size ceiling
      if (cdSize > MAX_CENTRAL_DIRECTORY_SIZE) {
        throw new BadRequestException(
          `Central Directory size (${cdSize} bytes) exceeds maximum allowable 2 MB.`,
        );
      }

      // Boundary verification
      if (cdOffset + cdSize > eocdOffset || cdOffset < 0) {
        throw new BadRequestException('Malformed archive: Central Directory overlaps or points outside bounds.');
      }

      // Read Central Directory into memory
      const cdBuffer = Buffer.alloc(cdSize);
      fs.readSync(fd, cdBuffer, 0, cdSize, cdOffset);

      let offset = 0;
      let totalUncompressedSize = 0;
      const seenEntryNames = new Set<string>();

      for (let i = 0; i < totalEntries; i++) {
        if (offset + 46 > cdSize) {
          throw new BadRequestException('Malformed Central Directory header: unexpected EOF.');
        }

        const sig = cdBuffer.readUInt32LE(offset);
        if (sig !== 0x02014b50) {
          throw new BadRequestException(`Malformed Central Directory: invalid signature 0x${sig.toString(16)}.`);
        }

        const gpFlag = cdBuffer.readUInt16LE(offset + 8);
        const compressionMethod = cdBuffer.readUInt16LE(offset + 10);
        const compressedSize = cdBuffer.readUInt32LE(offset + 20);
        const uncompressedSize = cdBuffer.readUInt32LE(offset + 24);
        const fileNameLength = cdBuffer.readUInt16LE(offset + 28);
        const extraFieldLength = cdBuffer.readUInt16LE(offset + 30);
        const fileCommentLength = cdBuffer.readUInt16LE(offset + 32);
        const externalFileAttributes = cdBuffer.readUInt32LE(offset + 38);
        const localHeaderOffset = cdBuffer.readUInt32LE(offset + 42);

        // Bit 0 = Encrypted / Password-protected
        if ((gpFlag & 0x0001) !== 0) {
          throw new BadRequestException('Password-protected or encrypted archives are strictly prohibited.');
        }

        // Check symlinks in external attributes (Unix mode: upper 16 bits, S_IFLNK = 0o120000)
        const unixMode = (externalFileAttributes >>> 16) & 0o170000;
        if (unixMode === 0o120000) {
          throw new BadRequestException('Archives containing symbolic links are strictly prohibited.');
        }

        // Read and sanitize entry filename
        const nameStart = offset + 46;
        if (nameStart + fileNameLength > cdSize) {
          throw new BadRequestException('Malformed entry filename in Central Directory.');
        }

        const rawName = cdBuffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
        const normalizedName = rawName.replace(/\\/g, '/');

        // Path traversal / control characters
        if (
          normalizedName.includes('../') ||
          normalizedName.includes('..\\') ||
          normalizedName.startsWith('/') ||
          normalizedName.includes('\0') ||
          normalizedName.includes(':')
        ) {
          throw new BadRequestException(`Archive entry '${rawName}' contains illegal traversal characters.`);
        }

        // Duplicate entry check
        if (seenEntryNames.has(normalizedName)) {
          throw new BadRequestException(`Archive contains duplicate entry '${rawName}', which is prohibited.`);
        }
        seenEntryNames.add(normalizedName);

        // Dangerous executable extensions inside archives
        const entryExt = path.extname(normalizedName).toLowerCase();
        if (FORBIDDEN_EXTENSIONS.has(entryExt)) {
          throw new BadRequestException(
            `Archive contains prohibited executable or macro file '${rawName}'.`,
          );
        }

        // Office OpenXML Macro & Script detection
        const lowerName = normalizedName.toLowerCase();
        if (
          lowerName.includes('vbaproject.bin') ||
          lowerName.includes('vbaprojectsignature.bin') ||
          lowerName.includes('word/vbadata.xml') ||
          lowerName.includes('xl/vbadata.xml') ||
          lowerName.includes('macroenabled')
        ) {
          throw new BadRequestException('Macro-enabled components detected inside document. Prohibited.');
        }

        // Single entry compression ratio check (anti-zip bomb)
        if (compressedSize > 0 && uncompressedSize > 100 * 1024) {
          const entryRatio = uncompressedSize / compressedSize;
          if (entryRatio > MAX_ENTRY_RATIO) {
            throw new BadRequestException(
              `Archive entry '${rawName}' has suspicious compression ratio (${entryRatio.toFixed(1)}:1).`,
            );
          }
        }

        // Cumulative uncompressed size ceiling
        totalUncompressedSize += uncompressedSize;
        if (totalUncompressedSize > MAX_UNCOMPRESSED_SIZE_BYTES) {
          throw new BadRequestException(
            `Total archive uncompressed size exceeds maximum allowed limit of 50 MB.`,
          );
        }

        // Validate Local File Header consistency (anti-evasion)
        const lfhBuf = Buffer.alloc(30);
        fs.readSync(fd, lfhBuf, 0, 30, localHeaderOffset);
        const lfhSig = lfhBuf.readUInt32LE(0);
        if (lfhSig !== 0x04034b50) {
          throw new BadRequestException(`Archive structure mismatch: Local Header signature invalid for '${rawName}'.`);
        }
        const lfhCompression = lfhBuf.readUInt16LE(8);
        const lfhNameLen = lfhBuf.readUInt16LE(26);

        if (lfhCompression !== compressionMethod || lfhNameLen !== fileNameLength) {
          throw new BadRequestException(
            `Archive anomaly: Local Header mismatch with Central Directory for entry '${rawName}'.`,
          );
        }

        // Advance to next Central Directory entry
        offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
      }

      // Check overall archive compression ratio
      if (fileSizeBytes > 0) {
        const overallRatio = totalUncompressedSize / fileSizeBytes;
        if (overallRatio > MAX_OVERALL_RATIO) {
          throw new BadRequestException(
            `Overall archive compression ratio (${overallRatio.toFixed(1)}:1) exceeds maximum 10:1 limit.`,
          );
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Scans legacy OLE Compound Document (.doc / .xls) for macros.
   */
  public static validateOleDocument(filePath: string): void {
    const content = fs.readFileSync(filePath);
    const asString = content.toString('binary');

    // Signatures for VBA project streams in OLE
    if (
      asString.includes('VBA') ||
      asString.includes('_VBA_PROJECT') ||
      asString.includes('Macros') ||
      asString.includes('ThisDocument')
    ) {
      // Check if it's an actual VBA storage stream
      if (content.includes(Buffer.from('VBA', 'ascii')) && content.includes(Buffer.from('dir', 'ascii'))) {
        throw new BadRequestException('Legacy Word/Excel document contains embedded VBA macros. Prohibited.');
      }
    }
  }

  /**
   * Sanitizes and validates SVG file content to prevent Cross-Site Scripting (XSS).
   */
  public static validateSvgContent(filePath: string): void {
    const content = fs.readFileSync(filePath, 'utf8');
    const lower = content.toLowerCase();

    // Dangerous SVG elements and attributes
    const forbiddenPatterns = [
      /<script\b/i,
      /javascript:/i,
      /data:text\/html/i,
      /onload\s*=/i,
      /onerror\s*=/i,
      /onclick\s*=/i,
      /onmouseover\s*=/i,
      /<iframe\b/i,
      /<object\b/i,
      /<embed\b/i,
      /<!entity/i,
      /system\s+["']/i,
    ];

    for (const pattern of forbiddenPatterns) {
      if (pattern.test(lower)) {
        throw new BadRequestException('SVG file contains prohibited active scripts or external entity references.');
      }
    }
  }
}

