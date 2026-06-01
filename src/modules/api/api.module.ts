import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiController } from './api.controller.js';
import { ApiService } from './api.service.js';

@Module({
  imports: [
    // Imports standard TypeOrm modules mapping standard DataSource connections
    TypeOrmModule.forFeature([])
  ],
  controllers: [ApiController],
  providers: [ApiService],
  exports: [ApiService]
})
export class ApiModule {}
export default ApiModule;
