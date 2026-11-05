-- AlterTable
ALTER TABLE `attendance_records` ADD COLUMN `anomaly_detected_at` DATETIME(3) NULL,
    ADD COLUMN `anomaly_resolution_notes` VARCHAR(500) NULL,
    ADD COLUMN `anomaly_resolved_at` DATETIME(3) NULL,
    ADD COLUMN `anomaly_resolved_by_user_id` VARCHAR(30) NULL,
    ADD COLUMN `reconciled_at` DATETIME(3) NULL,
    ADD COLUMN `reconciliation_run_id` VARCHAR(30) NULL;

-- CreateTable
CREATE TABLE `attendance_reconciliation_runs` (
    `id` VARCHAR(30) NOT NULL,
    `target_date` DATE NOT NULL,
    `department_id` VARCHAR(30) NULL,
    `status` ENUM('IN_PROGRESS', 'COMPLETED', 'FAILED', 'PARTIAL') NOT NULL DEFAULT 'IN_PROGRESS',
    `total_records_processed` INTEGER NOT NULL DEFAULT 0,
    `total_reconciled` INTEGER NOT NULL DEFAULT 0,
    `total_quarantined` INTEGER NOT NULL DEFAULT 0,
    `total_errors` INTEGER NOT NULL DEFAULT 0,
    `triggered_by_user_id` VARCHAR(30) NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,
    `notes` VARCHAR(500) NULL,
    `error_details` JSON NULL,

    INDEX `attendance_reconciliation_runs_target_date_idx`(`target_date`),
    INDEX `attendance_reconciliation_runs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `attendance_records_reconciliation_run_id_idx` ON `attendance_records`(`reconciliation_run_id`);

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_reconciliation_run_id_fkey` FOREIGN KEY (`reconciliation_run_id`) REFERENCES `attendance_reconciliation_runs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_anomaly_resolved_by_user_id_fkey` FOREIGN KEY (`anomaly_resolved_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_reconciliation_runs` ADD CONSTRAINT `attendance_reconciliation_runs_triggered_by_user_id_fkey` FOREIGN KEY (`triggered_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
