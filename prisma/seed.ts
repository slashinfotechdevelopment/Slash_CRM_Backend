
import "dotenv/config";

import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "slash_infotech_crm",
  connectionLimit: 5,
});

const prisma = new PrismaClient({ adapter });

// --------------------------------------------------
// 1. USER TYPES
// --------------------------------------------------

const userTypes = [
  {
    code: "SUPER_ADMIN",
    name: "Super Admin",
    description: "Highest-level system administrator",
  },
  {
    code: "ADMIN",
    name: "Admin",
    description: "CRM administrator",
  },
  {
    code: "EMPLOYEE",
    name: "Employee",
    description: "Internal company employee",
  },
  {
    code: "CLIENT",
    name: "Client",
    description: "External company client",
  },
];

// --------------------------------------------------
// 2. ROLES
// --------------------------------------------------

const roles = [
  {
    code: "SUPER_ADMIN",
    name: "Super Admin",
    description: "Protected system-level administrator",
    isSystem: true,
  },
  {
    code: "ADMIN",
    name: "Admin",
    description: "General CRM administrator",
    isSystem: true,
  },
  {
    code: "HR",
    name: "HR",
    description: "Human resources management",
    isSystem: false,
  },
  {
    code: "DEVELOPER",
    name: "Developer",
    description: "Software development team",
    isSystem: false,
  },
  {
    code: "SALES",
    name: "Sales Executive",
    description: "Sales and lead management",
    isSystem: false,
  },
  {
    code: "PROJECT_MANAGER",
    name: "Project Manager",
    description: "Project and task management",
    isSystem: false,
  },
  {
    code: "ACCOUNTS",
    name: "Accounts",
    description: "Financial and invoice management",
    isSystem: false,
  },
  {
    code: "SUPPORT",
    name: "Support",
    description: "Customer support management",
    isSystem: false,
  },
];

// --------------------------------------------------
// 3. PERMISSIONS
// --------------------------------------------------

const modules: Record<string, string[]> = {
  dashboard: ["view"],

  users: ["view", "create", "update", "delete", "assign"],
  roles: ["view", "create", "update", "delete", "assign"],
  permissions: ["view", "assign"],
  departments: ["view", "create", "update", "delete"],

  leads: ["view", "create", "update", "delete", "assign"],
  clients: ["view", "create", "update", "delete"],
  deals: ["view", "create", "update", "delete", "approve"],

  quotations: ["view", "create", "update", "delete", "approve"],
  projects: ["view", "create", "update", "delete", "assign"],
  milestones: ["view", "create", "update", "delete"],
  tasks: ["view", "create", "update", "delete", "assign"],
  bugs: ["view", "create", "update", "delete", "assign"],

  invoices: ["view", "create", "update", "delete"],
  payments: ["view", "create", "update", "approve"],

  support: ["view", "create", "update", "delete", "assign"],
  maintenance: ["view", "create", "update", "delete"],

  reports: ["view", "export"],
  documents: ["view", "upload", "delete"],
  notifications: ["view", "create", "delete"],

  activity_logs: ["view"],
  audit_logs: ["view"],

  settings: ["view", "update"],
};

const permissions = Object.entries(modules).flatMap(
  ([module, actions]) =>
    actions.map((action) => ({
      code: `${module}.${action}`,
      name: `${module.replace(/_/g, " ")} ${action}`,
      module,
      action,
    })),
);

// --------------------------------------------------
// 4. DEFAULT DEPARTMENTS
// --------------------------------------------------

const departments = [
  { code: "DEVELOPMENT", name: "Development" },
  { code: "HR", name: "Human Resources" },
  { code: "SALES", name: "Sales" },
  { code: "ACCOUNTS", name: "Accounts" },
  { code: "SUPPORT", name: "Support" },
  { code: "MANAGEMENT", name: "Management" },
];

// --------------------------------------------------
// 5. ROLE PERMISSION MAPPING
// --------------------------------------------------

const rolePermissionMap: Record<string, string[]> = {
  // Super Admin receives every seeded permission.
  SUPER_ADMIN: permissions.map((permission) => permission.code),

  // Admin receives normal CRM permissions, but not
  // security-sensitive system administration permissions.
  ADMIN: permissions
    .filter(
      (permission) =>
        ![
          "roles",
          "permissions",
          "settings",
          "audit_logs",
        ].includes(permission.module),
    )
    .map((permission) => permission.code),

  HR: [
    "dashboard.view",
    "users.view",
    "users.create",
    "users.update",
    "departments.view",
    "reports.view",
  ],

  DEVELOPER: [
    "dashboard.view",
    "projects.view",
    "tasks.view",
    "tasks.update",
    "bugs.view",
    "bugs.create",
    "bugs.update",
    "documents.view",
    "documents.upload",
  ],

  SALES: [
    "dashboard.view",
    "leads.view",
    "leads.create",
    "leads.update",
    "leads.assign",
    "clients.view",
    "clients.create",
    "clients.update",
    "deals.view",
    "deals.create",
    "deals.update",
    "quotations.view",
    "quotations.create",
    "quotations.update",
  ],

  PROJECT_MANAGER: [
    "dashboard.view",
    "projects.view",
    "projects.create",
    "projects.update",
    "projects.assign",
    "milestones.view",
    "milestones.create",
    "milestones.update",
    "tasks.view",
    "tasks.create",
    "tasks.update",
    "tasks.assign",
    "bugs.view",
    "bugs.assign",
    "reports.view",
  ],

  ACCOUNTS: [
    "dashboard.view",
    "invoices.view",
    "invoices.create",
    "invoices.update",
    "payments.view",
    "payments.create",
    "payments.update",
    "payments.approve",
    "reports.view",
    "reports.export",
  ],

  SUPPORT: [
    "dashboard.view",
    "support.view",
    "support.create",
    "support.update",
    "support.assign",
    "maintenance.view",
    "maintenance.create",
    "maintenance.update",
    "documents.view",
  ],
};

// --------------------------------------------------
// 6. SEED EXECUTION
// --------------------------------------------------

async function main() {
  console.log("Starting CRM database seeding...");

  // User types
  for (const item of userTypes) {
    await prisma.userType.upsert({
      where: { code: item.code },
      update: {
        name: item.name,
        description: item.description,
      },
      create: item,
    });
  }

  console.log("User types seeded.");

  // Roles
  for (const item of roles) {
    await prisma.role.upsert({
      where: { code: item.code },
      update: {
        name: item.name,
        description: item.description,
        isSystem: item.isSystem,
      },
      create: item,
    });
  }

  console.log("Roles seeded.");

  // Permissions
  for (const item of permissions) {
    await prisma.permission.upsert({
      where: { code: item.code },
      update: {
        name: item.name,
        module: item.module,
        action: item.action,
      },
      create: item,
    });
  }

  console.log(`${permissions.length} permissions seeded.`);

  // Departments
  for (const item of departments) {
    await prisma.department.upsert({
      where: { code: item.code },
      update: {
        name: item.name,
      },
      create: item,
    });
  }

  console.log("Departments seeded.");

  // Role-permission assignments
  for (const [roleCode, permissionCodes] of Object.entries(
    rolePermissionMap,
  )) {
    const role = await prisma.role.findUnique({
      where: { code: roleCode },
    });

    if (!role) {
      throw new Error(`Role not found: ${roleCode}`);
    }

    for (const permissionCode of permissionCodes) {
      const permission = await prisma.permission.findUnique({
        where: { code: permissionCode },
      });

      if (!permission) {
        throw new Error(
          `Permission not found: ${permissionCode}`,
        );
      }

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {
          dataScope: "ALL",
        },
        create: {
          roleId: role.id,
          permissionId: permission.id,
          dataScope: "ALL",
        },
      });
    }
  }

  console.log("Role permissions assigned.");

  console.log("--------------------------------");
  console.log("CRM database seeding completed!");
  console.log(`User types: ${userTypes.length}`);
  console.log(`Roles: ${roles.length}`);
  console.log(`Permissions: ${permissions.length}`);
  console.log(`Departments: ${departments.length}`);
  console.log("--------------------------------");
}

main()
  .catch((error) => {
    console.error("CRM seeding failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
