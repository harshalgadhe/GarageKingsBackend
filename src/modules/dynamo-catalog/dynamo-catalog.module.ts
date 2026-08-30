import { Module } from '@nestjs/common';
import { DynamoAdminCatalogController, DynamoPublicCatalogController } from './dynamo-catalog.controller.js';
import { DynamoCatalogService } from './dynamo-catalog.service.js';
import { DynamoAssetsService } from './dynamo-assets.service.js';
import { DynamoAuthController } from './dynamo-auth.controller.js';
import { DynamoCustomerController } from './dynamo-customer.controller.js';
import { DynamoAdminDataController, DynamoTelemetryController } from './dynamo-admin-data.controller.js';
import { DynamoAdminMasterDataController, DynamoPublicMasterDataController } from './dynamo-master-data.controller.js';

@Module({
  controllers: [DynamoPublicCatalogController, DynamoAdminCatalogController, DynamoAuthController, DynamoCustomerController, DynamoAdminDataController, DynamoTelemetryController, DynamoPublicMasterDataController, DynamoAdminMasterDataController],
  providers: [DynamoCatalogService, DynamoAssetsService],
  exports: [DynamoCatalogService]
})
export class DynamoCatalogModule {}
