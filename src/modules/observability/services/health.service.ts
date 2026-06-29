import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { execSync } from 'child_process';

let gitCommit = 'Unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {
  gitCommit = process.env.COMMIT_HASH || 'N/A';
}

@Injectable()
export class HealthService {
  constructor(private readonly dataSource: DataSource) {}

  async getHealth() {
    const timestamp = new Date().toISOString();
    let dbStatus = 'unhealthy';
    let dbLatency = -1;
    const dbStart = Date.now();

    try {
      await this.dataSource.query('SELECT 1');
      dbStatus = 'healthy';
      dbLatency = Date.now() - dbStart;
    } catch (e) {
      dbStatus = 'unhealthy';
    }

    const cognitoStatus = process.env.COGNITO_USER_POOL_ID ? 'healthy' : 'unconfigured';
    const overallStatus = dbStatus === 'healthy' ? 'healthy' : 'unhealthy';

    return {
      status: overallStatus,
      version: '1.0.0',
      commit: gitCommit,
      timestamp,
      checks: {
        database: {
          status: dbStatus,
          latencyMs: dbLatency
        },
        cognito: {
          status: cognitoStatus
        }
      }
    };
  }
}
export default HealthService;
