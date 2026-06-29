import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class AlertService {
  constructor(private readonly dataSource: DataSource) {}

  async getObservabilitySettings() {
    const rows = await this.dataSource.query("SELECT value FROM global_settings WHERE key = 'observability_settings'");
    if (rows.length > 0) {
      return rows[0].value;
    }
    return {
      alertThresholds: {
        errorRatePerMin: 10,
        slowRequestRate: 5,
        authFailureCount: 5
      },
      retentionPeriodDays: 14
    };
  }

  async saveObservabilitySettings(settings: any) {
    await this.dataSource.query(`
      INSERT INTO global_settings (key, value)
      VALUES ('observability_settings', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    `, [JSON.stringify(settings)]);
    return { success: true };
  }

  async checkAlerts() {
    try {
      const settings = await this.getObservabilitySettings();
      const thresholds = settings.alertThresholds || { errorRatePerMin: 10, slowRequestRate: 5, authFailureCount: 5 };
      const errorRateThresh = thresholds.errorRatePerMin || 10;
      const slowRateThresh = thresholds.slowRequestRate || 5;
      const authFailThresh = thresholds.authFailureCount || 5;

      // 1. Check Error Rate in the last 1 minute
      const errorCountRes = await this.dataSource.query(`
        SELECT COALESCE(SUM(occurrence_count), 0)::int as total
        FROM telemetry_errors
        WHERE last_occurrence > NOW() - INTERVAL '1 MINUTE'
      `);
      const errorCount = errorCountRes[0]?.total || 0;

      if (errorCount >= errorRateThresh) {
        await this.triggerAlert(
          'High Error Rate Detected', 
          `The application has encountered ${errorCount} errors in the last minute.`, 
          'telemetry_alert'
        );
      }

      // 2. Check Slow Request Rate
      const slowReqRes = await this.dataSource.query(`
        SELECT COUNT(*)::int as total
        FROM performance_metrics
        WHERE metric_type = 'api_latency' AND duration_ms > 2000 AND timestamp > NOW() - INTERVAL '1 MINUTE'
      `);
      const slowCount = slowReqRes[0]?.total || 0;

      if (slowCount >= slowRateThresh) {
        await this.triggerAlert(
          'Slow API Responses Detected', 
          `${slowCount} api requests took longer than 2 seconds in the last minute.`, 
          'slow_performance'
        );
      }

      // 3. Check Auth Failure Rate
      const authFailRes = await this.dataSource.query(`
        SELECT COALESCE(SUM(occurrence_count), 0)::int as total
        FROM telemetry_errors
        WHERE category = 'AUTH_INVALID_CREDENTIALS' AND last_occurrence > NOW() - INTERVAL '5 MINUTES'
      `);
      const authCount = authFailRes[0]?.total || 0;

      if (authCount >= authFailThresh) {
        await this.triggerAlert(
          'Repeated Authentication Failures', 
          `There have been ${authCount} failed login attempts in the last 5 minutes.`, 
          'security_alert'
        );
      }

    } catch (e: any) {
      console.error('Failed to check alerts:', e.message);
    }
  }

  private async triggerAlert(title: string, message: string, type: string) {
    const dupCheck = await this.dataSource.query(`
      SELECT id FROM system_notifications
      WHERE title = $1 AND created_at > NOW() - INTERVAL '15 MINUTES'
      LIMIT 1;
    `, [title]);

    if (dupCheck.length === 0) {
      await this.dataSource.query(`
        INSERT INTO system_notifications (title, message, type)
        VALUES ($1, $2, $3)
      `, [title, message, type]);
    }
  }

  async runRetentionCleanup() {
    try {
      const settings = await this.getObservabilitySettings();
      const days = settings.retentionPeriodDays || 14;

      await this.dataSource.query(`
        DELETE FROM telemetry_errors
        WHERE last_occurrence < NOW() - INTERVAL '${days} DAYS';
      `);

      await this.dataSource.query(`
        DELETE FROM performance_metrics
        WHERE timestamp < NOW() - INTERVAL '${days} DAYS';
      `);

      console.log(`[RetentionCleanup] Cleaned telemetry and performance metrics older than ${days} days.`);
    } catch (e: any) {
      console.error('[RetentionCleanup] Cleanup failed:', e.message);
    }
  }
}
export default AlertService;
