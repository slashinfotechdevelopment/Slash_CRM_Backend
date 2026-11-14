import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client';
import {
  LeaveCategory,
  RecordStatus,
} from '../generated/prisma/enums';

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'slash_infotech_crm',
  connectionLimit: 5,
});

const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('--- Initializing Leave Management Subsystem (Phase 9) ---');

  const currentYear = new Date().getFullYear();

  // 1. Seed Leave Permissions
  const leavePermissions = [
    { code: 'leave.view_types', name: 'View Leave Types', description: 'Can view leave types and policies' },
    { code: 'leave.manage_types', name: 'Manage Leave Types', description: 'Can create and edit leave types' },
    { code: 'leave.manage_policies', name: 'Manage Leave Policies', description: 'Can configure policy versions' },
    { code: 'leave.apply', name: 'Apply For Leave', description: 'Can apply for leave' },
    { code: 'leave.view_requests', name: 'View Leave Requests', description: 'Can view team/organization leave requests' },
    { code: 'leave.approve', name: 'Approve Leave Requests', description: 'Can approve or reject leave requests' },
    { code: 'leave.cancel', name: 'Cancel Leave', description: 'Can cancel leave requests' },
    { code: 'leave.view_balances', name: 'View Leave Balances', description: 'Can view employee leave balances' },
    { code: 'leave.adjust_balances', name: 'Adjust Leave Balances', description: 'Can manually adjust leave balances' },
    { code: 'leave.view_reports', name: 'View Leave Reports', description: 'Can view leave analytics and reports' },
    { code: 'leave.manage_holidays', name: 'Manage Holidays', description: 'Can configure holidays and calendar scopes' },
    { code: 'leave.manage_weekly_offs', name: 'Manage Weekly Offs', description: 'Can configure weekly-off policies' },
  ];

  for (const p of leavePermissions) {
    const action = p.code.split('.')[1] || 'view';
    await prisma.permission.upsert({
      where: { code: p.code },
      update: { name: p.name, description: p.description, action },
      create: {
        code: p.code,
        name: p.name,
        description: p.description,
        module: 'leave',
        action,
        status: RecordStatus.ACTIVE,
      },
    });
  }
  console.log(`Seeded ${leavePermissions.length} leave permissions.`);

  // 2. Map Permissions to Roles
  const roles = await prisma.role.findMany();
  for (const role of roles) {
    let allowedCodes: string[] = [];
    if (role.code === 'SUPER_ADMIN' || role.code === 'ADMIN' || role.code === 'HR') {
      allowedCodes = leavePermissions.map((p) => p.code);
    } else if (role.code === 'PROJECT_MANAGER' || role.code === 'MANAGER') {
      allowedCodes = [
        'leave.apply',
        'leave.view_requests',
        'leave.approve',
        'leave.cancel',
        'leave.view_balances',
        'leave.view_reports',
      ];
    } else {
      // Standard employee roles (DEVELOPER, SALES, ACCOUNTS, SUPPORT, etc.)
      allowedCodes = ['leave.apply', 'leave.view_requests', 'leave.cancel', 'leave.view_balances'];
    }

    for (const code of allowedCodes) {
      const perm = await prisma.permission.findUnique({ where: { code } });
      if (perm) {
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: perm.id,
            },
          },
          update: {},
          create: {
            roleId: role.id,
            permissionId: perm.id,
            dataScope: 'ALL',
          },
        });
      }
    }
  }
  console.log('Mapped leave permissions to standard roles.');

  // 3. Seed Default Leave Types & Policy Versions
  const defaultTypes = [
    {
      code: 'CASUAL',
      name: 'Casual Leave',
      description: 'Short-term casual absence for personal or family needs.',
      category: LeaveCategory.PAID,
      isPaid: true,
      annualAllocation: 12.0,
      maxConsecutiveDays: 3,
      allowHalfDay: true,
      requiresDocument: false,
      minNoticeDays: 1,
      carryForwardLimit: 0.0,
    },
    {
      code: 'SICK',
      name: 'Sick Leave',
      description: 'Leave for medical recovery and health appointments.',
      category: LeaveCategory.PAID,
      isPaid: true,
      annualAllocation: 12.0,
      maxConsecutiveDays: 5,
      allowHalfDay: true,
      requiresDocument: true,
      minNoticeDays: 0,
      carryForwardLimit: 0.0,
    },
    {
      code: 'EARNED',
      name: 'Earned / Privilege Leave',
      description: 'Annual accrued leave for vacation and extended personal time.',
      category: LeaveCategory.PAID,
      isPaid: true,
      annualAllocation: 15.0,
      maxConsecutiveDays: 14,
      allowHalfDay: false,
      requiresDocument: false,
      minNoticeDays: 7,
      carryForwardLimit: 10.0,
    },
    {
      code: 'LOP',
      name: 'Loss of Pay (Unpaid Leave)',
      description: 'Absence taken beyond accrued paid quotas, deducted from payroll.',
      category: LeaveCategory.UNPAID,
      isPaid: false,
      annualAllocation: 0.0,
      maxConsecutiveDays: 30,
      allowHalfDay: true,
      requiresDocument: false,
      minNoticeDays: 0,
      carryForwardLimit: 0.0,
    },
    {
      code: 'COMP_OFF',
      name: 'Compensatory Off',
      description: 'Compensatory time off earned for working on weekends or holidays.',
      category: LeaveCategory.COMPENSATORY,
      isPaid: true,
      annualAllocation: 0.0,
      maxConsecutiveDays: 2,
      allowHalfDay: true,
      requiresDocument: false,
      minNoticeDays: 0,
      carryForwardLimit: 0.0,
    },
  ];

  const now = new Date();
  const effectiveFrom = new Date(Date.UTC(currentYear, 0, 1));

  const createdLeaveTypes: any[] = [];

  for (const t of defaultTypes) {
    let leaveType = await prisma.leaveType.findUnique({
      where: { code: t.code },
    });

    if (!leaveType) {
      leaveType = await prisma.leaveType.create({
        data: {
          code: t.code,
          name: t.name,
          description: t.description,
          category: t.category,
          isPaid: t.isPaid,
          status: RecordStatus.ACTIVE,
        },
      });

      await prisma.leavePolicyVersion.create({
        data: {
          leaveTypeId: leaveType.id,
          version: 1,
          effectiveFrom,
          effectiveTo: null,
          annualAllocation: t.annualAllocation,
          maxConsecutiveDays: t.maxConsecutiveDays,
          allowHalfDay: t.allowHalfDay,
          requiresDocument: t.requiresDocument,
          minNoticeDays: t.minNoticeDays,
          carryForwardLimit: t.carryForwardLimit,
          excludeWeeklyOffs: true,
          excludeHolidays: true,
          status: RecordStatus.ACTIVE,
        },
      });
      console.log(`Created leave type: ${t.name} (${t.code}) with Policy Version 1`);
    }

    createdLeaveTypes.push(leaveType);
  }

  // 4. Provision Leave Balances for Active Employees
  // STRICT RULE: Skip CLIENT accounts, inactive users, and the protected SUPER_ADMIN!
  const employees = await prisma.user.findMany({
    where: {
      status: RecordStatus.ACTIVE,
      userType: { code: 'EMPLOYEE' },
      // Protected super admin check:
      NOT: {
        OR: [
          { email: 'srihari8489@gmail.com' },
          { userCode: 'SA001' },
        ],
      },
    },
    include: { employeeProfile: true },
  });

  console.log(`Found ${employees.length} eligible active employees to provision balances for ${currentYear}.`);

  for (const emp of employees) {
    for (const lt of createdLeaveTypes) {
      // Find active policy for allocation amount
      const policy = await prisma.leavePolicyVersion.findFirst({
        where: { leaveTypeId: lt.id, status: RecordStatus.ACTIVE },
        orderBy: { version: 'desc' },
      });

      const allocatedDays = lt.isPaid && policy ? policy.annualAllocation : 0;

      const existingBalance = await prisma.leaveBalance.findUnique({
        where: {
          unique_user_leave_year: {
            userId: emp.id,
            leaveTypeId: lt.id,
            year: currentYear,
          },
        },
      });

      if (!existingBalance) {
        await prisma.leaveBalance.create({
          data: {
            userId: emp.id,
            leaveTypeId: lt.id,
            year: currentYear,
            allocatedDays,
            carriedForward: 0,
            adjustedDays: 0,
            usedDays: 0,
            pendingDays: 0,
          },
        });
      }
    }
  }

  console.log(`Successfully initialized leave balances for year ${currentYear}.`);
  console.log('--- Initialization Complete ---');
}

main()
  .catch((e) => {
    console.error('Initialization error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
