import { Module, forwardRef } from '@nestjs/common';
import { AdminFinanceController } from './admin-finance.controller.js';
import { ApiModule } from '../api/api.module.js';

@Module({
  imports: [forwardRef(() => ApiModule)],
  controllers: [AdminFinanceController],
  providers: [],
  exports: []
})
export class FinanceModule {}
export default FinanceModule;
