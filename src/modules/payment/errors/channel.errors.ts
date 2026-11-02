import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `CHANNEL_*` — the channel door's admission refusals (spec P2 v3.1 §5.3,
 * SPEC-W2 §4–§5, API-W2 §2). None of them charges anything; each says what the
 * client does with its lane.
 */
export enum ChannelErrorCode {
  /** Retire this lane (not a failure) and open a new one. */
  CHANNEL_ROTATE = 'CHANNEL_ROTATE',
  /** The payer is at its open-channel cap: wait for a free lane, or use `voucher`. */
  CHANNEL_LIMIT = 'CHANNEL_LIMIT',
  /** A gap, a rewind or another session on this lane: it is dead. */
  CHANNEL_DESYNC = 'CHANNEL_DESYNC',
  /** The signing delegate's grant ends inside the settle margin. */
  CHANNEL_SIGNER_EXPIRING = 'CHANNEL_SIGNER_EXPIRING',
  /** A channel voucher where no channel is offered. */
  CHANNEL_NOT_OFFERED = 'CHANNEL_NOT_OFFERED',
}

export type _ChannelCodes = AssertDomainErrorCodes<'CHANNEL', `${ChannelErrorCode}`>;

export const ChannelErrors = createDomainErrorFactory('CHANNEL', {
  rotate: {
    code: ChannelErrorCode.CHANNEL_ROTATE,
    statusCode: 409,
    publicContext: ['channelId', 'reason'],
    message: (context?: Record<string, any>) =>
      `This payment channel takes no new vouchers (${context?.reason ?? 'rotated'}); open a new ` +
      `channel and sign again. Nothing was charged.`,
  },
  limit: {
    code: ChannelErrorCode.CHANNEL_LIMIT,
    statusCode: 429,
    publicContext: ['retryAfter', 'maxOpenChannels'],
    message: (context?: Record<string, any>) =>
      `The payer already has ${context?.maxOpenChannels ?? 'the most'} open payment channels; ` +
      `retry on an open one, wait for one to settle, or pay with a per-call voucher. Nothing was charged.`,
  },
  desync: {
    code: ChannelErrorCode.CHANNEL_DESYNC,
    statusCode: 409,
    publicContext: ['channelId'],
    message: (_context?: Record<string, any>) =>
      `This payment channel's vouchers are out of order (another session, or a lost record); ` +
      `the channel is closed to new vouchers. Open a new channel. Nothing was charged.`,
  },
  signerExpiring: {
    code: ChannelErrorCode.CHANNEL_SIGNER_EXPIRING,
    statusCode: 403,
    publicContext: ['validUntil'],
    message: (context?: Record<string, any>) =>
      `The payment key's grant ends ${context?.validUntil ?? 'soon'}, too soon to settle a channel ` +
      `payment before it; renew the grant. Nothing was charged.`,
  },
  notOffered: {
    code: ChannelErrorCode.CHANNEL_NOT_OFFERED,
    statusCode: 400,
    publicContext: ['reason'],
    message: (context?: Record<string, any>) =>
      `Channel payments are not offered here (${context?.reason ?? 'not enabled'}); pay with a ` +
      `per-call voucher. Nothing was charged.`,
  },
});
