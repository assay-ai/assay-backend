import {
  EvmSendRejectedError,
  classifySendMessage,
  isInsufficientFunds,
  isSendRejected,
  sendAnswerOf,
} from '@modules/chains/evm/evm-send-rejected.error';

/**
 * Which node answers to `eth_sendRawTransaction` mean "definitely not
 * broadcast". Every one of them shares JSON-RPC code -32000, so the message is
 * the only thing that tells "insufficient funds" (not broadcast) from "already
 * known" (broadcast).
 */
describe('classifySendMessage', () => {
  it.each([
    ['insufficient funds for gas * price + value: have 1 want 2', 'INSUFFICIENT_FUNDS'],
    ['nonce too low: next nonce 8, tx nonce 7', 'NONCE_TOO_LOW'],
    ['nonce too high', 'NONCE_TOO_HIGH'],
    ['intrinsic gas too low: gas 21000, minimum needed 95000', 'INTRINSIC_GAS_TOO_LOW'],
    ['max fee per gas less than block base fee: maxFeePerGas: 1 baseFee: 2', 'FEE_CAP_TOO_LOW'],
    ['fee cap less than block base fee', 'FEE_CAP_TOO_LOW'],
    ['replacement transaction underpriced', 'REPLACEMENT_UNDERPRICED'],
    ['already known', 'ALREADY_KNOWN'],
    ['known transaction: 0xabc', 'ALREADY_KNOWN'],
  ])('"%s" is %s', (message, answer) => {
    expect(classifySendMessage(message)).toBe(answer);
  });

  it.each([
    'execution reverted',
    'request timed out',
    'EVM RPC eth_sendRawTransaction failed: HTTP 504',
    'transaction underpriced',
    '',
  ])('"%s" says nothing about the broadcast', (message) => {
    expect(classifySendMessage(message)).toBeNull();
  });
});

describe('sendAnswerOf', () => {
  it('finds the refusal down a wrapped cause chain, as viem wraps a transport error', () => {
    const wrapped = Object.assign(new Error('An internal error was received.'), {
      details: 'boom',
      cause: Object.assign(new Error('EVM RPC eth_sendRawTransaction failed: code -32000'), {
        sendAnswer: 'NONCE_TOO_LOW',
      }),
    });

    expect(sendAnswerOf(wrapped)).toBe('NONCE_TOO_LOW');
  });

  it('reads viem `details` too', () => {
    expect(sendAnswerOf({ message: 'x', details: 'insufficient funds for transfer' })).toBe(
      'INSUFFICIENT_FUNDS',
    );
  });

  it('is null for a transport failure', () => {
    expect(sendAnswerOf(new Error('socket hang up'))).toBeNull();
    expect(sendAnswerOf(null)).toBeNull();
  });
});

describe('EvmSendRejectedError', () => {
  it('says it was not broadcast, and which refusal', () => {
    const error = new EvmSendRejectedError('INSUFFICIENT_FUNDS', `0x${'ab'.repeat(32)}`);

    expect(error.broadcast).toBe(false);
    expect(isSendRejected(error)).toBe(true);
    expect(isInsufficientFunds(error)).toBe(true);
    expect(isInsufficientFunds(new EvmSendRejectedError('NONCE_TOO_LOW', null))).toBe(false);
    expect(isSendRejected(new Error('insufficient funds'))).toBe(false);
  });
});
