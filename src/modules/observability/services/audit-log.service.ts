import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getCorrelationId } from '../../../common/middleware/trace-context.js';

@Injectable()
export class AuditLogService {
  constructor(private readonly dataSource: DataSource) {}

  async logEvent(event: {
    action: string;
    entity: string;
    entityId: string;
    category?: string;
    userId?: string;
    beforeState?: any;
    afterState?: any;
  }) {
    try {
      const correlationId = getCorrelationId();
      await this.dataSource.query(`
        INSERT INTO audit_logs (
          action, entity, entity_id, before_state, after_state, correlation_id, user_id, category
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        event.action,
        event.entity,
        event.entityId,
        event.beforeState ? JSON.stringify(event.beforeState) : null,
        event.afterState ? JSON.stringify(event.afterState) : null,
        correlationId,
        event.userId,
        event.category || 'Security'
      ]);
    } catch (e: any) {
      console.error('Failed to write audit log:', e.message);
    }
  }

  async getLogs(options: { page?: number; limit?: number; search?: string; category?: string }) {
    const page = Math.max(1, Number(options.page || 1));
    const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
    const offset = (page - 1) * limit;

    let queryStr = 'FROM audit_logs WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (options.category && options.category !== 'All') {
      queryStr += ` AND category = $${paramIndex}`;
      params.push(options.category);
      paramIndex++;
    }

    if (options.search) {
      queryStr += ` AND (
        LOWER(action) LIKE LOWER($${paramIndex}) OR
        LOWER(entity) LIKE LOWER($${paramIndex}) OR
        LOWER(entity_id) LIKE LOWER($${paramIndex}) OR
        LOWER(correlation_id) LIKE LOWER($${paramIndex})
      )`;
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    const countRes = await this.dataSource.query(`SELECT COUNT(*)::int as total ${queryStr}`, params);
    const total = countRes[0]?.total || 0;

    const selectQuery = `
      SELECT id, action, entity, entity_id as "entityId", before_state as "beforeState", 
             after_state as "afterState", timestamp, correlation_id as "correlationId", 
             user_id as "userId", category
      ${queryStr}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const rows = await this.dataSource.query(selectQuery, [...params, limit, offset]);

    return {
      logs: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }
}
export default AuditLogService;
