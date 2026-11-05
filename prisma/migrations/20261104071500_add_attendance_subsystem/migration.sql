-- AlterTable
ALTER TABLE `audit_logs` MODIFY `action` ENUM('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'PERMISSION_CHANGE', 'ROLE_ASSIGNMENT', 'STATUS_CHANGE', 'VERIFY_EVIDENCE', 'OTHER') NOT NULL;

-- CreateTable
CREATE TABLE `shift_definitions` (
    `id` VARCHAR(30) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `start_time` VARCHAR(5) NOT NULL,
    `end_time` VARCHAR(5) NOT NULL,
    `is_overnight` BOOLEAN NOT NULL DEFAULT false,
    `grace_period_minutes` INTEGER NOT NULL DEFAULT 15,
    `half_day_threshold_minutes` INTEGER NOT NULL DEFAULT 240,
    `full_day_threshold_minutes` INTEGER NOT NULL DEFAULT 480,
    `overtime_threshold_minutes` INTEGER NOT NULL DEFAULT 540,
    `allow_multiple_sessions` BOOLEAN NOT NULL DEFAULT false,
    `auto_close_grace_minutes` INTEGER NOT NULL DEFAULT 30,
    `break_policy_snapshot` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `shift_definitions_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_shift_assignments` (
    `id` VARCHAR(30) NOT NULL,
    `employee_profile_id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `shift_definition_id` VARCHAR(30) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `employee_shift_assignments_employee_profile_id_user_id_idx`(`employee_profile_id`, `user_id`),
    INDEX `employee_shift_assignments_user_id_start_date_end_date_idx`(`user_id`, `start_date`, `end_date`),
    INDEX `employee_shift_assignments_shift_definition_id_idx`(`shift_definition_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_records` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `shift_assignment_id` VARCHAR(30) NULL,
    `shift_definition_id` VARCHAR(30) NOT NULL,
    `attendance_date` DATE NOT NULL,
    `status` ENUM('PRESENT', 'HALF_DAY', 'ABSENT', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY', 'PENDING_RECONCILIATION') NOT NULL DEFAULT 'PENDING_RECONCILIATION',
    `shift_start_time_snapshot` DATETIME(3) NOT NULL,
    `shift_end_time_snapshot` DATETIME(3) NOT NULL,
    `is_overnight_snapshot` BOOLEAN NOT NULL DEFAULT false,
    `half_day_threshold_seconds_snapshot` INTEGER NOT NULL,
    `full_day_threshold_seconds_snapshot` INTEGER NOT NULL,
    `overtime_threshold_seconds_snapshot` INTEGER NOT NULL,
    `allow_multiple_sessions_snapshot` BOOLEAN NOT NULL DEFAULT false,
    `break_policy_snapshot` TEXT NOT NULL,
    `gross_working_duration_seconds` INTEGER NOT NULL DEFAULT 0,
    `paid_break_duration_seconds` INTEGER NOT NULL DEFAULT 0,
    `unpaid_break_duration_seconds` INTEGER NOT NULL DEFAULT 0,
    `net_working_duration_seconds` INTEGER NOT NULL DEFAULT 0,
    `verified_overtime_seconds` INTEGER NOT NULL DEFAULT 0,
    `has_integrity_anomaly` BOOLEAN NOT NULL DEFAULT false,
    `anomaly_type` VARCHAR(50) NULL,
    `anomaly_details` TEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `last_correction_request_id` VARCHAR(30) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_records_user_id_attendance_date_idx`(`user_id`, `attendance_date`),
    INDEX `attendance_records_shift_assignment_id_idx`(`shift_assignment_id`),
    INDEX `attendance_records_shift_definition_id_idx`(`shift_definition_id`),
    INDEX `attendance_records_has_integrity_anomaly_idx`(`has_integrity_anomaly`),
    UNIQUE INDEX `attendance_records_id_user_id_key`(`id`, `user_id`),
    UNIQUE INDEX `attendance_records_user_id_attendance_date_key`(`user_id`, `attendance_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_sessions` (
    `id` VARCHAR(30) NOT NULL,
    `attendance_record_id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `raw_check_in_at` DATETIME(3) NOT NULL,
    `raw_check_out_at` DATETIME(3) NULL,
    `check_in_at` DATETIME(3) NULL,
    `check_out_at` DATETIME(3) NULL,
    `duration_seconds` INTEGER NULL,
    `status` ENUM('ACTIVE', 'COMPLETED', 'AUTO_CLOSED', 'QUARANTINED', 'REJECTED') NOT NULL DEFAULT 'ACTIVE',
    `active_session_user_id` VARCHAR(30) GENERATED ALWAYS AS (CASE WHEN `status` = 'ACTIVE' THEN `user_id` ELSE NULL END) VIRTUAL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_sessions_attendance_record_id_idx`(`attendance_record_id`),
    INDEX `attendance_sessions_user_id_status_idx`(`user_id`, `status`),
    UNIQUE INDEX `attendance_sessions_id_attendance_record_id_user_id_key`(`id`, `attendance_record_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_breaks` (
    `id` VARCHAR(30) NOT NULL,
    `attendance_record_id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `break_type_id` VARCHAR(50) NOT NULL,
    `started_at` DATETIME(3) NOT NULL,
    `ended_at` DATETIME(3) NULL,
    `paid_duration_seconds` INTEGER NOT NULL DEFAULT 0,
    `unpaid_duration_seconds` INTEGER NOT NULL DEFAULT 0,
    `active_break_user_id` VARCHAR(30) GENERATED ALWAYS AS (CASE WHEN `ended_at` IS NULL THEN `user_id` ELSE NULL END) VIRTUAL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_breaks_attendance_record_id_idx`(`attendance_record_id`),
    INDEX `attendance_breaks_user_id_started_at_idx`(`user_id`, `started_at`),
    UNIQUE INDEX `attendance_breaks_id_attendance_record_id_user_id_key`(`id`, `attendance_record_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_correction_requests` (
    `id` VARCHAR(30) NOT NULL,
    `attendance_record_id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `attendance_session_id` VARCHAR(30) NULL,
    `requested_check_in_at` DATETIME(3) NULL,
    `requested_check_out_at` DATETIME(3) NULL,
    `reason` VARCHAR(500) NOT NULL,
    `evidence_metadata` JSON NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `reviewed_by_user_id` VARCHAR(30) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `manager_notes` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_correction_requests_attendance_record_id_user_id_idx`(`attendance_record_id`, `user_id`),
    INDEX `attendance_correction_requests_attendance_session_id_attenda_idx`(`attendance_session_id`, `attendance_record_id`, `user_id`),
    INDEX `attendance_correction_requests_user_id_status_idx`(`user_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_evidence_verifications` (
    `id` VARCHAR(30) NOT NULL,
    `correction_request_id` VARCHAR(30) NOT NULL,
    `reviewer_user_id` VARCHAR(30) NOT NULL,
    `evidence_reference` VARCHAR(500) NOT NULL,
    `outcome` ENUM('VERIFIED', 'REJECTED', 'INCONCLUSIVE') NOT NULL,
    `verification_notes` VARCHAR(1000) NOT NULL,
    `verified_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `audit_log_id` VARCHAR(30) NULL,

    UNIQUE INDEX `attendance_evidence_verifications_correction_request_id_key`(`correction_request_id`),
    INDEX `attendance_evidence_verifications_reviewer_user_id_idx`(`reviewer_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_overtime_requests` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `attendance_date` DATE NOT NULL,
    `start_time` DATETIME(3) NOT NULL,
    `end_time` DATETIME(3) NOT NULL,
    `approved_duration_minutes` INTEGER NOT NULL DEFAULT 0,
    `reason` VARCHAR(500) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `reviewed_by_user_id` VARCHAR(30) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_overtime_requests_user_id_attendance_date_idx`(`user_id`, `attendance_date`),
    INDEX `attendance_overtime_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_wfh_requests` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `reviewed_by_user_id` VARCHAR(30) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_wfh_requests_user_id_start_date_end_date_idx`(`user_id`, `start_date`, `end_date`),
    INDEX `attendance_wfh_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `employee_profiles_id_user_id_key` ON `employee_profiles`(`id`, `user_id`);

-- AddForeignKey
ALTER TABLE `employee_shift_assignments` ADD CONSTRAINT `employee_shift_assignments_employee_profile_id_user_id_fkey` FOREIGN KEY (`employee_profile_id`, `user_id`) REFERENCES `employee_profiles`(`id`, `user_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_shift_assignments` ADD CONSTRAINT `employee_shift_assignments_shift_definition_id_fkey` FOREIGN KEY (`shift_definition_id`) REFERENCES `shift_definitions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_shift_assignment_id_fkey` FOREIGN KEY (`shift_assignment_id`) REFERENCES `employee_shift_assignments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_shift_definition_id_fkey` FOREIGN KEY (`shift_definition_id`) REFERENCES `shift_definitions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_sessions` ADD CONSTRAINT `attendance_sessions_attendance_record_id_user_id_fkey` FOREIGN KEY (`attendance_record_id`, `user_id`) REFERENCES `attendance_records`(`id`, `user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_sessions` ADD CONSTRAINT `attendance_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_breaks` ADD CONSTRAINT `attendance_breaks_attendance_record_id_user_id_fkey` FOREIGN KEY (`attendance_record_id`, `user_id`) REFERENCES `attendance_records`(`id`, `user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_breaks` ADD CONSTRAINT `attendance_breaks_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_requests` ADD CONSTRAINT `attendance_correction_requests_attendance_record_id_user_id_fkey` FOREIGN KEY (`attendance_record_id`, `user_id`) REFERENCES `attendance_records`(`id`, `user_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_requests` ADD CONSTRAINT `attendance_correction_requests_attendance_session_id_attend_fkey` FOREIGN KEY (`attendance_session_id`, `attendance_record_id`, `user_id`) REFERENCES `attendance_sessions`(`id`, `attendance_record_id`, `user_id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_requests` ADD CONSTRAINT `attendance_correction_requests_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_requests` ADD CONSTRAINT `attendance_correction_requests_reviewed_by_user_id_fkey` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_evidence_verifications` ADD CONSTRAINT `attendance_evidence_verifications_correction_request_id_fkey` FOREIGN KEY (`correction_request_id`) REFERENCES `attendance_correction_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_evidence_verifications` ADD CONSTRAINT `attendance_evidence_verifications_reviewer_user_id_fkey` FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_overtime_requests` ADD CONSTRAINT `attendance_overtime_requests_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_overtime_requests` ADD CONSTRAINT `attendance_overtime_requests_reviewed_by_user_id_fkey` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_wfh_requests` ADD CONSTRAINT `attendance_wfh_requests_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_wfh_requests` ADD CONSTRAINT `attendance_wfh_requests_reviewed_by_user_id_fkey` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Create Unique Indexes for Concurrency generated columns
CREATE UNIQUE INDEX `unique_active_session_per_user` ON `attendance_sessions` (`active_session_user_id`);
CREATE UNIQUE INDEX `unique_active_break_per_user` ON `attendance_breaks` (`active_break_user_id`);
