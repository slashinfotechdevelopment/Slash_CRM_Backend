-- AlterTable
ALTER TABLE `media` ADD COLUMN `checksum_sha256` VARCHAR(64) NULL,
    ADD COLUMN `scan_details` VARCHAR(255) NULL,
    ADD COLUMN `scan_status` ENUM('PENDING', 'SCANNING', 'CLEAN', 'INFECTED', 'QUARANTINED', 'FAILED') NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX `media_scan_status_idx` ON `media`(`scan_status`);

