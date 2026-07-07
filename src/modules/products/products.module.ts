import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsService } from './products.service.js';
import { PublicProductsController } from './public-products.controller.js';
import { AdminProductsController } from './admin-products.controller.js';
import { ApiModule } from '../api/api.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([]),
    forwardRef(() => ApiModule)
  ],
  controllers: [PublicProductsController, AdminProductsController],
  providers: [ProductsService],
  exports: [ProductsService]
})
export class ProductsModule {}
export default ProductsModule;
