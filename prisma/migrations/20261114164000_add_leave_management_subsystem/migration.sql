-- CreateTable
CREATE TABLE `leave_types` (
    `id` VARCHAR(30) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `description` VARCHAR(255) NULL,
    `category` ENUM('PAID', 'UNPAID', 'COMPENSATORY', 'STATUTORY') NOT NULL DEFAULT 'PAID',
    `is_paid` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `leave_types_code_key`(`code`),
    INDEX `leave_types_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_policy_versions` (
    `id` VARCHAR(30) NOT NULL,
    `leave_type_id` VARCHAR(30) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `annual_allocation` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `max_consecutive_days` INTEGER NULL,
    `allow_half_day` BOOLEAN NOT NULL DEFAULT true,
    `requires_document` BOOLEAN NOT NULL DEFAULT false,
    `min_notice_days` INTEGER NOT NULL DEFAULT 0,
    `carry_forward_limit` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `exclude_weekly_offs` BOOLEAN NOT NULL DEFAULT true,
    `exclude_holidays` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `applicable_employment_type` VARCHAR(50) NULL,
    `department_id` VARCHAR(30) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `unique_policy_version_per_type`(`leave_type_id`, `version`),
    INDEX `leave_policy_versions_effective_from_effective_to_idx`(`effective_from`, `effective_to`),
    INDEX `leave_policy_versions_department_id_idx`(`department_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_balances` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `leave_type_id` VARCHAR(30) NOT NULL,
    `year` YEAR NOT NULL,
    `allocated_days` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `carried_forward` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `adjusted_days` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `used_days` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `pending_days` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `unique_user_leave_year`(`user_id`, `leave_type_id`, `year`),
    INDEX `leave_balances_user_id_year_idx`(`user_id`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_requests` (
    `id` VARCHAR(30) NOT NULL,
    `request_number` VARCHAR(40) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `leave_type_id` VARCHAR(30) NOT NULL,
    `leave_policy_version_id` VARCHAR(30) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `is_half_day` BOOLEAN NOT NULL DEFAULT false,
    `half_day_period` ENUM('FIRST_HALF', 'SECOND_HALF') NULL,
    `total_days` DECIMAL(4, 2) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `attachment_media_id` VARCHAR(30) NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLATION_REQUESTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `policy_snapshot` JSON NOT NULL,
    `reviewed_by_user_id` VARCHAR(30) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `manager_notes` VARCHAR(500) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by_user_id` VARCHAR(30) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `leave_requests_request_number_key`(`request_number`),
    INDEX `leave_requests_user_id_start_date_end_date_idx`(`user_id`, `start_date`, `end_date`),
    INDEX `leave_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_approvals` (
    `id` VARCHAR(30) NOT NULL,
    `leave_request_id` VARCHAR(30) NOT NULL,
    `approver_user_id` VARCHAR(30) NOT NULL,
    `level` INTEGER NOT NULL DEFAULT 1,
    `decision` ENUM('PENDING', 'APPROVED', 'REJECTED', 'REASSIGNED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `comments` VARCHAR(500) NULL,
    `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decided_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `leave_approvals_leave_request_id_level_idx`(`leave_request_id`, `level`),
    INDEX `leave_approvals_approver_user_id_decision_idx`(`approver_user_id`, `decision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_cancellation_requests` (
    `id` VARCHAR(30) NOT NULL,
    `leave_request_id` VARCHAR(30) NOT NULL,
    `requested_by_user_id` VARCHAR(30) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `reviewed_by_user_id` VARCHAR(30) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `reviewer_notes` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `leave_cancellation_requests_leave_request_id_status_idx`(`leave_request_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_transactions` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `leave_type_id` VARCHAR(30) NOT NULL,
    `leave_request_id` VARCHAR(30) NULL,
    `transaction_type` ENUM('INITIAL_ALLOCATION', 'PERIODIC_ACCRUAL', 'CARRY_FORWARD', 'PENDING_HOLD', 'HOLD_RELEASE_REJECTED', 'HOLD_RELEASE_CANCELLED', 'UTILIZATION', 'UNPAID_UTILIZATION', 'REVERSAL_CANCELLATION', 'MANUAL_ADJUSTMENT_CREDIT', 'MANUAL_ADJUSTMENT_DEBIT', 'ENCASHMENT', 'LAPSED') NOT NULL,
    `balance_field_affected` ENUM('ALLOCATED', 'CARRIED_FORWARD', 'ADJUSTED', 'USED', 'PENDING_HOLD', 'NONE') NOT NULL,
    `amount` DECIMAL(5, 2) NOT NULL,
    `previous_allocated` DECIMAL(5, 2) NOT NULL,
    `new_allocated` DECIMAL(5, 2) NOT NULL,
    `previous_carried_forward` DECIMAL(5, 2) NOT NULL,
    `new_carried_forward` DECIMAL(5, 2) NOT NULL,
    `previous_adjusted` DECIMAL(5, 2) NOT NULL,
    `new_adjusted` DECIMAL(5, 2) NOT NULL,
    `previous_used` DECIMAL(5, 2) NOT NULL,
    `new_used` DECIMAL(5, 2) NOT NULL,
    `previous_pending` DECIMAL(5, 2) NOT NULL,
    `new_pending` DECIMAL(5, 2) NOT NULL,
    `previous_available` DECIMAL(5, 2) NOT NULL,
    `new_available` DECIMAL(5, 2) NOT NULL,
    `reason` VARCHAR(255) NOT NULL,
    `created_by_id` VARCHAR(30) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `leave_transactions_user_id_leave_type_id_idx`(`user_id`, `leave_type_id`),
    INDEX `leave_transactions_leave_request_id_idx`(`leave_request_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holidays` (
    `id` VARCHAR(30) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `date` DATE NOT NULL,
    `year` YEAR NOT NULL,
    `description` VARCHAR(255) NULL,
    `is_optional` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `scope_type` ENUM('GLOBAL', 'LOCATION', 'DEPARTMENT', 'USER_OVERRIDE') NOT NULL DEFAULT 'GLOBAL',
    `scope_value` VARCHAR(50) NOT NULL DEFAULT 'GLOBAL',
    `scope_key` VARCHAR(60) NOT NULL,
    `department_id` VARCHAR(30) NULL,
    `location` VARCHAR(100) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `unique_holiday_date_scope`(`date`, `scope_key`),
    INDEX `holidays_year_date_idx`(`year`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `weekly_off_policies` (
    `id` VARCHAR(30) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `description` VARCHAR(255) NULL,
    `days_of_week` JSON NOT NULL,
    `pattern` VARCHAR(50) NOT NULL DEFAULT 'ALL',
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `scope_type` ENUM('GLOBAL', 'LOCATION', 'DEPARTMENT', 'USER_OVERRIDE') NOT NULL DEFAULT 'GLOBAL',
    `scope_value` VARCHAR(50) NOT NULL DEFAULT 'GLOBAL',
    `scope_key` VARCHAR(60) NOT NULL,
    `department_id` VARCHAR(30) NULL,
    `location` VARCHAR(100) NULL,
    `user_id` VARCHAR(30) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `unique_weekly_off_scope_effective`(`scope_key`, `effective_from`),
    INDEX `weekly_off_policies_status_scope_type_idx`(`status`, `scope_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `leave_policy_versions` ADD CONSTRAINT `leave_policy_versions_leave_type_id_fkey` FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_policy_versions` ADD CONSTRAINT `leave_policy_versions_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_balances` ADD CONSTRAINT `leave_balances_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_balances` ADD CONSTRAINT `leave_balances_leave_type_id_fkey` FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_reviewed_by_user_id_fkey` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_cancelled_by_user_id_fkey` FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_leave_type_id_fkey` FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_leave_policy_version_id_fkey` FOREIGN KEY (`leave_policy_version_id`) REFERENCES `leave_policy_versions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_attachment_media_id_fkey` FOREIGN KEY (`attachment_media_id`) REFERENCES `media`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_approvals` ADD CONSTRAINT `leave_approvals_leave_request_id_fkey` FOREIGN KEY (`leave_request_id`) REFERENCES `leave_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_approvals` ADD CONSTRAINT `leave_approvals_approver_user_id_fkey` FOREIGN KEY (`approver_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_cancellation_requests` ADD CONSTRAINT `leave_cancellation_requests_leave_request_id_fkey` FOREIGN KEY (`leave_request_id`) REFERENCES `leave_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_cancellation_requests` ADD CONSTRAINT `leave_cancellation_requests_requested_by_user_id_fkey` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_cancellation_requests` ADD CONSTRAINT `leave_cancellation_requests_reviewed_by_user_id_fkey` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_transactions` ADD CONSTRAINT `leave_transactions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_transactions` ADD CONSTRAINT `leave_transactions_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_transactions` ADD CONSTRAINT `leave_transactions_leave_type_id_fkey` FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_transactions` ADD CONSTRAINT `leave_transactions_leave_request_id_fkey` FOREIGN KEY (`leave_request_id`) REFERENCES `leave_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `holidays` ADD CONSTRAINT `holidays_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `weekly_off_policies` ADD CONSTRAINT `weekly_off_policies_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `weekly_off_policies` ADD CONSTRAINT `weekly_off_policies_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

