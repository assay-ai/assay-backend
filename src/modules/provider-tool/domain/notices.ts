import {
  NotificationEvent,
  NotificationRequest,
} from '@modules/notification/ports/notification.port';

/**
 * What a provider is told about its own provider tools (design spec §7.6,
 * §7.5): the review's decision, a takedown and its lifting, and a promotion
 * invitation. Pure: the services that change the state send these after
 * their transaction commits.
 *
 * Every notice goes to the tool's own organization and names only that
 * organization's tool (and, for an invitation, the standard tool it is
 * invited to). Nothing in a payload names another organization, an
 * operator, or an operator's internal note: a takedown's note is the
 * operator's, while a rejection's note is written for the provider and is
 * already shown on the tool (`review.note`).
 */
export type ProviderToolNotice =
  | {
      readonly kind: 'APPROVED';
      readonly organizationId: string;
      readonly toolId: string;
      readonly toolName: string;
      /** FIRST: the tool is listed. CHANGE: a listed tool's new version is live. */
      readonly reviewKind: 'FIRST' | 'CHANGE';
      readonly semver: string | null;
    }
  | {
      readonly kind: 'REJECTED';
      readonly organizationId: string;
      readonly toolId: string;
      readonly toolName: string;
      readonly reviewKind: 'FIRST' | 'CHANGE';
      readonly reasonCode: string | null;
      readonly note: string | null;
    }
  | {
      readonly kind: 'TAKEN_DOWN';
      readonly organizationId: string;
      readonly toolId: string;
      readonly toolName: string;
      /** The provider-facing reason (`TakedownReasonCode`) and note, never the operator's. */
      readonly reasonCode?: string | null;
      readonly publicNote?: string | null;
    }
  | {
      readonly kind: 'TAKEDOWN_LIFTED';
      readonly organizationId: string;
      readonly toolId: string;
      readonly toolName: string;
      /** False while another takedown (its handle's) still keeps it removed. */
      readonly serving: boolean;
    }
  | {
      readonly kind: 'PROMOTION_INVITED';
      readonly organizationId: string;
      readonly toolId: string;
      readonly toolName: string;
      readonly standardToolId: string;
      readonly standardToolName: string;
    };

/** The subject every provider tool notice deep-links to. */
export const PROVIDER_TOOL_SUBJECT = 'provider_tool';

export function providerToolNotification(notice: ProviderToolNotice): NotificationRequest {
  const base = {
    organizationId: notice.organizationId,
    subjectType: PROVIDER_TOOL_SUBJECT,
    subjectId: notice.toolId,
  };
  switch (notice.kind) {
    case 'APPROVED':
      return {
        ...base,
        event: NotificationEvent.PROVIDER_TOOL_APPROVED,
        title:
          notice.reviewKind === 'FIRST'
            ? `${notice.toolName} is listed`
            : `Your change to ${notice.toolName} is live`,
        body:
          notice.reviewKind === 'FIRST'
            ? `${notice.toolName} passed review and is now listed in the catalogue.`
            : `The reviewed version${notice.semver ? ` v${notice.semver}` : ''} of ` +
              `${notice.toolName} is approved and now serves.`,
        payload: {
          toolId: notice.toolId,
          toolName: notice.toolName,
          reviewKind: notice.reviewKind,
          semver: notice.semver,
        },
      };
    case 'REJECTED':
      return {
        ...base,
        event: NotificationEvent.PROVIDER_TOOL_REJECTED,
        title:
          notice.reviewKind === 'FIRST'
            ? `${notice.toolName} was not approved`
            : `Your change to ${notice.toolName} was not approved`,
        body:
          `${notice.note ?? 'The review found something to fix.'} Fix it and resubmit.` +
          (notice.reviewKind === 'CHANGE' ? ' The approved version keeps serving.' : ''),
        payload: {
          toolId: notice.toolId,
          toolName: notice.toolName,
          reviewKind: notice.reviewKind,
          reasonCode: notice.reasonCode,
          note: notice.note,
        },
      };
    case 'TAKEN_DOWN':
      return {
        ...base,
        event: NotificationEvent.PROVIDER_TOOL_TAKEN_DOWN,
        title: `${notice.toolName} was taken down`,
        body:
          `An operator took ${notice.toolName} down. It is removed from every view and its ` +
          'calls are refused.' +
          (notice.publicNote ? ` ${notice.publicNote}` : '') +
          ' Contact support if you think this is a mistake.',
        payload: {
          toolId: notice.toolId,
          toolName: notice.toolName,
          reasonCode: notice.reasonCode ?? null,
          publicNote: notice.publicNote ?? null,
        },
      };
    case 'TAKEDOWN_LIFTED':
      return {
        ...base,
        event: NotificationEvent.PROVIDER_TOOL_TAKEDOWN_LIFTED,
        title: `The takedown of ${notice.toolName} was lifted`,
        body: notice.serving
          ? `${notice.toolName} serves again.`
          : `${notice.toolName} stays removed while your public name is taken down.`,
        payload: { toolId: notice.toolId, toolName: notice.toolName, serving: notice.serving },
      };
    case 'PROMOTION_INVITED':
      return {
        ...base,
        event: NotificationEvent.PROVIDER_TOOL_PROMOTION_INVITED,
        title: `Serve the standard tool ${notice.standardToolName}`,
        body:
          `${notice.standardToolName} is a standard tool that does the same job as ` +
          `${notice.toolName}. Serve it with the same endpoint: your listing starts prefilled.`,
        dedupeKey: `${notice.standardToolId}:${notice.toolId}`,
        payload: {
          toolId: notice.toolId,
          toolName: notice.toolName,
          standardToolId: notice.standardToolId,
          standardToolName: notice.standardToolName,
        },
      };
  }
}
