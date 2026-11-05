-- AlterTable
ALTER TABLE `attendance_breaks` ADD COLUMN `is_system_closed` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `raw_ended_at` DATETIME(3) NULL,
    ADD COLUMN `system_closure_reason` VARCHAR(255) NULL;

-- AlterTable
ALTER TABLE `attendance_sessions` ADD COLUMN `is_system_closed` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `system_closure_reason` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `attendance_anomalies` (
    `id` VARCHAR(30) NOT NULL,
    `attendance_record_id` VARCHAR(30) NOT NULL,
    `reconciliation_run_id` VARCHAR(30) NULL,
    `anomaly_type` VARCHAR(50) NOT NULL,
    `details` TEXT NULL,
    `status` ENUM('ACTIVE', 'RESOLVED', 'DISMISSED') NOT NULL DEFAULT 'ACTIVE',
    `detected_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolved_at` DATETIME(3) NULL,
    `resolved_by_user_id` VARCHAR(30) NULL,
    `resolution_notes` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_anomalies_attendance_record_id_idx`(`attendance_record_id`),
    INDEX `attendance_anomalies_anomaly_type_idx`(`anomaly_type`),
    INDEX `attendance_anomalies_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `attendance_anomalies` ADD CONSTRAINT `attendance_anomalies_attendance_record_id_fkey` FOREIGN KEY (`attendance_record_id`) REFERENCES `attendance_records`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_anomalies` ADD CONSTRAINT `attendance_anomalies_reconciliation_run_id_fkey` FOREIGN KEY (`reconciliation_run_id`) REFERENCES `attendance_reconciliation_runs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_anomalies` ADD CONSTRAINT `attendance_anomalies_resolved_by_user_id_fkey` FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
