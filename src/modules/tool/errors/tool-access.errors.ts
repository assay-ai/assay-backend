import { createErrorFactory } from '@shared/errors/app-errors';

/**
 * The refusals an agent meets on a scoped MCP URL (design spec §7.4, "Errors").
 *
 * **Not domain-prefixed, on purpose.** Every other catalogue here carries its
 * domain's prefix (`error-catalog.ts`). These codes are a published contract
 * the spec fixes word for word — `NO_PROVIDER_MATCHES_RULES` is what a model
 * reads in chat and what the web app's refused-call view branches on — so
 * they are spelled exactly as written there, and kept together in this one
 * file so the exception stays visible.
 *
 * `message` is plain English because people read it in chat. It never names
 * a provider or a tool another organization owns; the structured detail is
 * `context.details`, which the MCP server puts on `_meta["x402/error"]`.
 * None of them is charged.
 */
export enum ToolAccessErrorCode {
  /** The tool is not served at this URL or by its view filter. Also an unknown name. */
  TOOL_NOT_IN_TOOLSET = 'TOOL_NOT_IN_TOOLSET',
  /** The agent's access policy (or its key's narrowing) refuses it. */
  TOOL_NOT_ALLOWED = 'TOOL_NOT_ALLOWED',
  /** The tool is no longer served by its maker. */
  TOOL_REMOVED = 'TOOL_REMOVED',
  /** The agent's and the toolset's provider rules leave no provider. */
  NO_PROVIDER_MATCHES_RULES = 'NO_PROVIDER_MATCHES_RULES',
  /** Beyond a limit of §7.13; `retryAfterMs` says when to come back. */
  RATE_LIMITED = 'RATE_LIMITED',
  /** `POST /mcp-urls/preview` was given something that is not an MCP URL of this host. */
  URL_NOT_RECOGNISED = 'URL_NOT_RECOGNISED',
}

export const TOOL_NOT_IN_TOOLSET_MESSAGE = 'Not part of this server.';
export const TOOL_NOT_ALLOWED_MESSAGE = "This agent isn't allowed to use it.";
export const TOOL_REMOVED_MESSAGE = 'This tool was removed by its maker.';
export const NO_PROVIDER_MATCHES_RULES_MESSAGE = 'No provider fits your limits.';
export const RATE_LIMITED_MESSAGE = 'Too many requests. Try again shortly.';

export const ToolAccessErrors = createErrorFactory({
  notInToolset: {
    code: ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET,
    statusCode: 404,
    message: (_context?: Record<string, any>) => TOOL_NOT_IN_TOOLSET_MESSAGE,
  },
  notAllowed: {
    code: ToolAccessErrorCode.TOOL_NOT_ALLOWED,
    statusCode: 403,
    message: (_context?: Record<string, any>) => TOOL_NOT_ALLOWED_MESSAGE,
  },
  removed: {
    code: ToolAccessErrorCode.TOOL_REMOVED,
    statusCode: 410,
    message: (_context?: Record<string, any>) => TOOL_REMOVED_MESSAGE,
  },
  noProviderMatchesRules: {
    code: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES,
    statusCode: 409,
    message: (_context?: Record<string, any>) => NO_PROVIDER_MATCHES_RULES_MESSAGE,
  },
  rateLimited: {
    code: ToolAccessErrorCode.RATE_LIMITED,
    statusCode: 429,
    message: (_context?: Record<string, any>) => RATE_LIMITED_MESSAGE,
  },
  urlNotRecognised: {
    code: ToolAccessErrorCode.URL_NOT_RECOGNISED,
    statusCode: 400,
    message: (_context?: Record<string, any>) => 'This is not an MCP server URL of this host.',
    publicContext: ['reason'],
  },
});
