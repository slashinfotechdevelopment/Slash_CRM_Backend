import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../src/generated/prisma/client';

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'slash_infotech_crm',
});

const prisma = new PrismaClient({ adapter });

async function seedSuperAdmin(email: string, name: string) {
  const normalizedEmail = email.trim().toLowerCase();

  console.log(`Starting Super Admin seeding for: ${normalizedEmail}`);

  // 1. Fetch SUPER_ADMIN user type
  const superAdminType = await prisma.userType.findUnique({
    where: { code: 'SUPER_ADMIN' },
  });

  if (!superAdminType) {
    throw new Error('SUPER_ADMIN user type not found in database. Run initial seed first.');
  }

  // 2. Fetch SUPER_ADMIN role
  const superAdminRole = await prisma.role.findUnique({
    where: { code: 'SUPER_ADMIN' },
  });

  if (!superAdminRole) {
    throw new Error('SUPER_ADMIN role not found in database. Run initial seed first.');
  }

  // 3. Atomically generate user code sequence SA001
  const sequence = await prisma.userCodeSequence.upsert({
    where: { userTypeCode: 'SUPER_ADMIN' },
    update: {
      lastNumber: {
        increment: 1,
      },
    },
    create: {
      userTypeCode: 'SUPER_ADMIN',
      prefix: 'SA',
      lastNumber: 1,
    },
  });

  const userCode = `${sequence.prefix}${String(sequence.lastNumber).padStart(3, '0')}`;

  // 4. Create the Super Admin user
  const user = await prisma.user.create({
    data: {
      userCode,
      userTypeId: superAdminType.id,
      name,
      email: normalizedEmail,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(), // Verified for immediate login
    },
  });

  // 5. Assign protected SUPER_ADMIN role
  await prisma.userRole.create({
    data: {
      userId: user.id,
      roleId: superAdminRole.id,
    },
  });

  console.log('-------------------------------------------');
  console.log('✅ Super Admin created successfully!');
  console.log(`User ID:   ${user.id}`);
  console.log(`User Code: ${user.userCode}`);
  console.log(`Name:      ${user.name}`);
  console.log(`Email:     ${user.email}`);
  console.log(`Status:    ${user.status}`);
  console.log(`Role:      SUPER_ADMIN`);
  console.log(`Verified:  YES (${user.emailVerifiedAt?.toISOString()})`);
  console.log('-------------------------------------------');
}

seedSuperAdmin('srihari8489@gmail.com', 'Srihari')
  .catch((err) => {
    console.error('❌ Failed to seed Super Admin:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

