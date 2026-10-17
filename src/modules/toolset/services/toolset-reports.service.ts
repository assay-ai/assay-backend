import { Inject, Injectable, Optional } from '@nestjs/common';

import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ToolsetReportRepository } from '@database/postgres/repositories/toolset-sharing.repository';
import { ToolsetRepository } from '@database/postgres/repositories/toolset.repository';

import { normalizeHandle } from '../domain/handle';
import { CreateReportBodyDto, ReportDto } from '../dto/toolset-report.dto';
import { ToolsetErrors } from '../errors/toolset.errors';
import { HandlesService } from './handles.service';
import { sharingStateOf } from './sharing-row';
import { TOOLSET_CLOCK, ToolsetClock, systemClock } from './toolset-clock';
import { startOfUtcDay, visibleToOthers } from './toolset-publishing.service';

/** §7.13: reports per organization per UTC day. */
export const REPORTS_PER_ORG_PER_DAY = 20;

/**
 * `POST /reports` (design spec FR-15): anyone signed in reports a toolset, a
 * tool or a handle; operators work the queue.
 *
 * The target must be one the reporter can see — a listed toolset (or one in
 * its public grace), a link-only one with its current token, a listed tool, an
 * active handle. Anything else is the same 404 as a missing target, so the
 * route is no oracle for private toolsets. One open report per item per
 * organization; 20 a day.
 */
@Injectable()
export class ToolsetReportsService {
  constructor(
    private readonly reports: ToolsetReportRepository,
    private readonly toolsets: ToolsetRepository,
    private readonly tools: ToolRepository,
    private readonly handles: HandlesService,
    @Optional() @Inject(TOOLSET_CLOCK) private readonly now: ToolsetClock = systemClock,
  ) {}

  async create(organizationId: string, body: CreateReportBodyDto): Promise<ReportDto> {
    const targets = [body.toolsetId, body.toolId, body.handle].filter((t) => t !== undefined);
    if (targets.length !== 1) {
      throw ToolsetErrors.invalid({ reason: 'name exactly one of toolsetId, toolId, handle' });
    }
    const now = this.now();

    let target: { toolsetId?: string; toolId?: string; handle?: string };
    if (body.toolsetId) {
      const toolset = await this.toolsets.findAnyById(body.toolsetId);
      const own = toolset?.ownerOrgId === organizationId;
      if (!toolset || own || !visibleToOthers(sharingStateOf(toolset), body.unlistedToken, now)) {
        throw ToolsetErrors.reportTargetNotFound();
      }
      // A frozen handle stops reports by id as much as its URLs: no oracle.
      if (!(await this.handles.ownerHandleActive(toolset.ownerOrgId))) {
        throw ToolsetErrors.reportTargetNotFound();
      }
      target = { toolsetId: toolset.id };
    } else if (body.toolId) {
      const [tool] = await this.tools.findByIds([body.toolId]);
      if (!tool || tool.visibility !== 'LISTED') throw ToolsetErrors.reportTargetNotFound();
      target = { toolId: tool.id };
    } else {
      const handle = normalizeHandle(body.handle as string);
      const resolved = await this.handles.resolve(handle);
      if (!resolved || resolved.kind !== 'ORG' || resolved.organizationId === organizationId) {
        throw ToolsetErrors.reportTargetNotFound();
      }
      target = { handle: resolved.renamedTo ?? handle };
    }

    const today = await this.reports
      .createQueryBuilder('r')
      .where('r.reporter_org_id = :organizationId', { organizationId })
      .andWhere('r.created_at >= :since', { since: startOfUtcDay(now) })
      .getCount();
    if (today >= REPORTS_PER_ORG_PER_DAY) {
      throw ToolsetErrors.limitExceeded({
        limit: 'reportsPerOrgPerDay',
        max: REPORTS_PER_ORG_PER_DAY,
      });
    }

    try {
      const row = await this.reports.save(
        this.reports.create({
          toolsetId: target.toolsetId ?? null,
          toolId: target.toolId ?? null,
          handle: target.handle ?? null,
          reporterOrgId: organizationId,
          reason: body.reason.trim(),
        }),
      );
      return { id: row.id, createdAt: new Date(row.createdAt).toISOString() };
    } catch (error) {
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        throw ToolsetErrors.reportDuplicate();
      }
      throw error;
    }
  }
}
