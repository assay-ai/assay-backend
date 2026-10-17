import { Injectable, Logger } from '@nestjs/common';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { BindingPauseReason, BindingStatus } from '@modules/tool/ports/tool.types';

import { PauseToolBindingBodyDto, PausedToolBindingDto } from '../dto/pause-tool-binding.dto';
import { ProviderErrors } from '../errors/provider.errors';
import { BindingEditorService, toSavedDto } from './binding-editor.service';

/**
 * The provider's own hand on their own traffic.
 *
 * A per-binding pause must stop traffic
 * **within 5 seconds**, with no penalty, no effect on accrued earnings and no
 * mark in the quality profile. Two of those three are properties of what this
 * class does *not* do, so they are worth stating as design rather than leaving
 * as absence.
 *
 * ## There is no invalidation here, and that is not an omission
 *
 * `DatabaseToolCatalogue` holds no cache: `findBindings` reads `tool_bindings`
 * on every routing decision, and `filterEligible` refuses anything whose status
 * is not `ACTIVE`. So the pause binds on the next call — not within five
 * seconds, but immediately — and the only machinery that makes it true is the
 * `UPDATE` below.
 *
 * The verification policy pub/sub kill switch exists because *verification policies* are held
 * in process, where a database write is invisible until something tells the
 * process to re-read. A binding is never held in process. Adding a second
 * invalidation channel here would be infrastructure built for a problem this
 * codebase does not have, and it would then need its own failure handling,
 * its own ordering guarantees and its own test — all of them for a value
 * nothing caches.
 *
 * ## A pause leaves no mark
 *
 * Declining to serve is not failing to serve. Nothing here writes a verdict, a
 * verification record, a strike or a ledger entry, and nothing here touches
 * `sla_failure_rate`, `mapping_version` or `published_version`. The strongest
 * form of that guarantee is structural: this class imports the binding row and
 * nothing else, so there is no quality or earnings surface it *could* reach.
 *
 * The SLA health breaker will write the same `PAUSED` status for the opposite
 * reason, which is why {@link BindingPauseReason} exists and why this route
 * hard-codes `PROVIDER_REQUESTED` rather than accepting a reason from the body.
 */
@Injectable()
export class BindingPauseService {
  private readonly logger = new Logger(BindingPauseService.name);

  constructor(
    private readonly editor: BindingEditorService,
    private readonly bindings: ToolBindingRepository,
  ) {}

  /**
   * Stop this binding's traffic.
   *
   * Only from `ACTIVE`. A `DRAFT` takes no traffic to stop and has no published
   * revision, so pausing one would trip `chk_tool_bindings_active_is_published`
   * — the same constraint the resume path guards against, from the other side.
   * A second pause of an already-paused binding is refused rather than
   * absorbed: it means the screen is stale, and silently succeeding would
   * overwrite `paused_at` and lose when the stoppage actually began.
   */
  async pause(
    organizationId: string,
    bindingId: string,
    body?: PauseToolBindingBodyDto,
  ): Promise<PausedToolBindingDto> {
    const row = await this.editor.loadEditable(organizationId, bindingId);

    if (row.status !== BindingStatus.ACTIVE) {
      throw ProviderErrors.bindingNotPausable({ bindingId, status: row.status });
    }

    row.status = BindingStatus.PAUSED;
    row.pauseReason = BindingPauseReason.PROVIDER_REQUESTED;
    row.pausedAt = new Date();

    const saved = await this.bindings.save(row);

    // The note has no column. It is context for whoever reads the log during an
    // incident, and saying so here is cheaper than a reader discovering it by
    // looking for a column that does not exist.
    this.logger.log(
      `Binding ${bindingId} paused by its provider` +
        `${body?.reason ? `: ${body.reason.slice(0, 280)}` : ''}`,
    );

    return toPausedDto(saved, await this.editor.publishedEndpoint(saved));
  }

  /**
   * Put this binding back on the wire, at the revision that was already live.
   *
   * Resuming is not republishing — `published_version` and `published_at` are
   * untouched, so the terms a call is served under are the ones the provider
   * published, not new ones smuggled in through a status change.
   *
   * The never-published check comes **first**, and deliberately so. It cannot
   * fire on a binding that was paused through this class (a `PAUSED` row is a
   * published row, by the same CHECK), so the case it catches is a `DRAFT`
   * whose provider pressed the wrong button — and *"publish it rather than
   * resuming it"* is an answer, where *"it is not paused"* would be a riddle.
   */
  async resume(organizationId: string, bindingId: string): Promise<PausedToolBindingDto> {
    const row = await this.editor.loadEditable(organizationId, bindingId);

    if (row.publishedVersion === null || row.publishedAt === null) {
      throw ProviderErrors.bindingNeverPublished({ bindingId });
    }

    if (row.status !== BindingStatus.PAUSED) {
      throw ProviderErrors.bindingNotPaused({ bindingId, status: row.status });
    }

    row.status = BindingStatus.ACTIVE;
    // Both, in the one write. `chk_tool_bindings_pause_attributed` refuses a
    // reason on a serving binding, so a resume that forgot the reason would be
    // rejected by the row — and `paused_at` is cleared with it because a stale
    // timestamp under a live binding is a console showing a stoppage that ended.
    row.pauseReason = null;
    row.pausedAt = null;

    const saved = await this.bindings.save(row);

    this.logger.log(`Binding ${bindingId} resumed at revision ${saved.publishedVersion}`);

    return toPausedDto(saved, await this.editor.publishedEndpoint(saved));
  }
}

function toPausedDto(
  row: ToolBindingEntity,
  publishedEndpoint: string | null,
): PausedToolBindingDto {
  return {
    ...toSavedDto(row, publishedEndpoint),
    pauseReason: row.pauseReason as BindingPauseReason | null,
    pausedAt: row.pausedAt,
  };
}
