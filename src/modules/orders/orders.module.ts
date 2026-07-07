import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerOrdersController } from './customer-orders.controller.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import { ApiModule } from '../api/api.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([]),
    forwardRef(() => ApiModule)
  ],
  controllers: [CustomerOrdersController, AdminOrdersController],
  providers: [],
  exports: []
})
export class OrdersModule {}
export default OrdersModule;
