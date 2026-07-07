import { Module, forwardRef } from '@nestjs/common';
import { AdminSuppliersController } from './admin-suppliers.controller.js';
import { ApiModule } from '../api/api.module.js';

@Module({
  imports: [forwardRef(() => ApiModule)],
  controllers: [AdminSuppliersController],
  providers: [],
  exports: []
})
export class SuppliersModule {}
export default SuppliersModule;
