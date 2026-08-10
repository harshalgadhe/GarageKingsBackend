import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthService } from './health.service.js';

@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly healthService: HealthService
  ) {}

  async getRecentErrors(options: { page?: number; limit?: number; search?: string; acknowledged?: boolean }) {
    const page = Math.max(1, Number(options.page || 1));
    const limit = Math.max(1, Math.min(100, Number(options.limit || 12)));
    const offset = (page - 1) * limit;

    let queryStr = 'FROM telemetry_errors WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (options.acknowledged !== undefined) {
      queryStr += ` AND acknowledged = $${paramIndex}`;
      params.push(options.acknowledged);
      paramIndex++;
    }

    if (options.search) {
      queryStr += ` AND (
        LOWER(message) LIKE LOWER($${paramIndex}) OR
        LOWER(category) LIKE LOWER($${paramIndex}) OR
        LOWER(exception_type) LIKE LOWER($${paramIndex}) OR
        LOWER(latest_correlation_id) LIKE LOWER($${paramIndex})
      )`;
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    const countRes = await this.dataSource.query(`SELECT COUNT(*)::int as total ${queryStr}`, params);
    const total = countRes[0]?.total || 0;

    const selectQuery = `
      SELECT id, fingerprint, error_type as "errorType", category, message, 
             stack_trace as "stackTrace", exception_type as "exceptionType", severity, 
             module, route, endpoint, first_occurrence as "firstOccurrence", 
             last_occurrence as "lastOccurrence", occurrence_count as "occurrenceCount", 
             latest_user_id as "latestUserId", latest_user_email as "latestUserEmail", 
             latest_session_id as "latestSessionId", latest_url as "latestUrl", 
             latest_browser as "latestBrowser", latest_device as "latestDevice", 
             latest_correlation_id as "latestCorrelationId", latest_payload as "latestPayload", 
             latest_duration as "latestDuration", build_version as "buildVersion", acknowledged
      ${queryStr}
      ORDER BY last_occurrence DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const rows = await this.dataSource.query(selectQuery, [...params, limit, offset]);

    return {
      errors: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  async acknowledgeError(fingerprint: string) {
    await this.dataSource.query('UPDATE telemetry_errors SET acknowledged = TRUE WHERE fingerprint = $1', [fingerprint]);
    return { success: true };
  }

  async getSummary() {
    const [errorSummary, slowSummary, recentErrors] = await Promise.all([
      this.dataSource.query(`
        SELECT
          COUNT(*) FILTER (WHERE acknowledged = FALSE)::int AS "unresolvedGroups",
          COALESCE(SUM(occurrence_count) FILTER (WHERE acknowledged = FALSE), 0)::int AS "unresolvedOccurrences",
          COALESCE(SUM(occurrence_count) FILTER (WHERE last_occurrence >= NOW() - INTERVAL '24 HOURS'), 0)::int AS "occurrences24h",
          COUNT(*) FILTER (WHERE severity = 'Fatal' AND acknowledged = FALSE)::int AS "unresolvedFatal",
          COUNT(DISTINCT COALESCE(endpoint, route)) FILTER (WHERE acknowledged = FALSE)::int AS "affectedEndpoints",
          MAX(last_occurrence) AS "lastOccurrence"
        FROM telemetry_errors;
      `),
      this.dataSource.query(`
        SELECT
          COUNT(*) FILTER (WHERE duration_ms > 2000)::int AS "slowRequests24h",
          COALESCE(ROUND(AVG(duration_ms)), 0)::int AS "averageLatency24h"
        FROM performance_metrics
        WHERE timestamp >= NOW() - INTERVAL '24 HOURS';
      `),
      this.dataSource.query(`
        SELECT fingerprint, error_type AS "errorType", category, message, severity,
               endpoint, route, occurrence_count AS "occurrenceCount",
               last_occurrence AS "lastOccurrence", latest_correlation_id AS "latestCorrelationId"
        FROM telemetry_errors
        WHERE acknowledged = FALSE
        ORDER BY last_occurrence DESC
        LIMIT 5;
      `)
    ]);

    return {
      ...(errorSummary[0] || {}),
      ...(slowSummary[0] || {}),
      recentErrors
    };
  }

  async clearAllErrors() {
    await this.dataSource.query('DELETE FROM telemetry_errors');
    return { success: true };
  }

  async getHealth() {
    return this.healthService.getHealth();
  }
}
export default DiagnosticsService;
