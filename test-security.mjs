import fs from 'fs';
import path from 'path';

const baseDir = './src/modules';

const checks = [
  {
    file: 'products/admin-products.controller.ts',
    mustContain: ["@UseGuards(AuthGuard('jwt'))", 'AdminProductsController', "this.checkAdmin(req)"]
  },
  {
    file: 'orders/admin-orders.controller.ts',
    mustContain: ["@UseGuards(AuthGuard('jwt'))", 'AdminOrdersController', "this.checkAdmin(req)"]
  },
  {
    file: 'suppliers/admin-suppliers.controller.ts',
    mustContain: ["@UseGuards(AuthGuard('jwt'))", 'AdminSuppliersController', "this.checkAdmin(req)"]
  },
  {
    file: 'finance/admin-finance.controller.ts',
    mustContain: ["@UseGuards(AuthGuard('jwt'))", 'AdminFinanceController', "this.checkAdmin(req)"]
  },
  {
    file: 'analytics/admin-analytics.controller.ts',
    mustContain: ["@UseGuards(AuthGuard('jwt'))", 'AdminAnalyticsController', "this.checkAdmin(req)"]
  },
  {
    file: 'notifications/admin-notifications.controller.ts',
    mustContain: ["@UseGuards(AuthGuard('jwt'))", 'AdminNotificationsController', "this.checkAdmin(req)"]
  },
  {
    file: 'settings/admin-settings.controller.ts',
    mustContain: ["@UseGuards(AuthGuard('jwt'))", 'AdminSettingsController', "this.checkAdmin(req)"]
  },
  {
    file: 'orders/customer-orders.controller.ts',
    mustContain: ["@UseGuards(AuthGuard('jwt'))", 'CustomerOrdersController']
  },
  {
    file: 'products/dto/public-product-response.dto.ts',
    mustContain: ['availabilityState', 'IN_STOCK', 'LOW_STOCK', 'PREORDER', 'OUT_OF_STOCK']
  }
];

function runAudits() {
  console.log("==========================================");
  console.log("       STATIC API SECURITY AUDIT");
  console.log("==========================================");

  let passed = true;

  for (const check of checks) {
    const filePath = path.join(baseDir, check.file);
    if (!fs.existsSync(filePath)) {
      console.error(`[FAIL] File not found: ${filePath}`);
      passed = false;
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    let filePassed = true;

    for (const term of check.mustContain) {
      if (!content.includes(term)) {
        console.error(`[FAIL] File ${check.file} is missing required security check: "${term}"`);
        filePassed = false;
        passed = false;
      }
    }

    if (filePassed) {
      console.log(`[PASS] ${check.file} verified successfully.`);
    }
  }

  console.log("==========================================");
  if (passed) {
    console.log("ALL STATIC API SECURITY CHECKS PASSED!");
    process.exit(0);
  } else {
    console.error("SOME SECURITY CHECKS FAILED! Please review errors above.");
    process.exit(1);
  }
}

runAudits();
