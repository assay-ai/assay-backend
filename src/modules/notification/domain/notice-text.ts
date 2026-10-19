import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';

/**
 * The words a notification body uses for the things it is about: the agent's
 * label, the tool's name, a time as "Oct 14, 00:00 UTC". Never an id, an enum
 * or an ISO timestamp — the person reading the bell knows their agent by its
 * name, not its UUID.
 *
 * Display only. Every lookup here is best-effort and never throws: a body that
 * says "Your agent" is still a notice, while a lookup that threw would drop
 * the notice itself. The payload keeps the ids for anything that needs them.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Oct 14, 00:00 UTC`. */
export function formatNoticeTime(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${hh}:${mm} UTC`;
}

/** How a body opens when it names an agent: `"My first agent"`, or `Your agent` when it has no label. */
export function agentPhrase(label: string | null | undefined): string {
  const name = label?.trim();
  return name ? `"${name}"` : 'Your agent';
}

/** The agent's label, scoped to its organization; `null` when unknown or unreadable. */
export async function agentLabelOf(
  agents: Pick<AgentRepository, 'findOne'>,
  organizationId: string,
  agentId: string,
): Promise<string | null> {
  try {
    const agent = await agents.findOne({ where: { id: agentId, organizationId } });
    return agent?.label?.trim() || null;
  } catch {
    return null;
  }
}

/** The tool's name; `null` when unknown or unreadable. */
export async function toolNameOf(
  tools: Pick<ToolRepository, 'findOne'>,
  toolId: string,
): Promise<string | null> {
  try {
    const tool = await tools.findOne({ where: { id: toolId } });
    return tool?.name?.trim() || null;
  } catch {
    return null;
  }
}
