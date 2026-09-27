import type { AgentDefinition } from '../agents';
import { ROLE_ROUTING_BLOCKS } from '../agents/role-routing';
import type { RuntimeConfig } from '../config/runtime';
import { escapeRegExp, normalizeAgentName } from '../utils/agent-variant';

export interface DelegationRouteCandidate {
  /** Host-facing agent name used for dispatch. */
  name: string;
  /** Full routing criteria sent to the decision model. */
  criteria: string;
}

const NON_ROUTABLE_AGENTS = new Set(['orchestrator', 'council', 'councillor']);

function shouldRouteTo(agent: AgentDefinition): boolean {
  return (
    !NON_ROUTABLE_AGENTS.has(agent.name) &&
    !agent.name.startsWith('councillor-')
  );
}

function fallbackCriteria(agent: AgentDefinition): string {
  return [
    `@${agent.name}`,
    `- Lane: ${agent.description ?? `Specialist agent ${agent.name}`}`,
    '- Delegate when: the bounded lane clearly matches this specialist description.',
    '- Do not delegate when: another candidate is a more specific match.',
  ].join('\n');
}

function acpFallbackCriteria(agent: AgentDefinition, command: string): string {
  return [
    `@${agent.name}`,
    `- Lane: External ACP-connected agent (${command})`,
    `- Role: ${agent.description ?? `External ACP agent ${agent.name}`}`,
    '- Delegate when: the user explicitly asks for this ACP-backed agent, or the lane matches its role and benefits from capabilities outside OpenCode.',
    '- Do not delegate when: a built-in specialist can handle the lane more directly or local file ownership would conflict with another writer.',
    '- Result handling: treat returned output as external-agent work and reconcile any reported file changes before continuing.',
  ].join('\n');
}

/**
 * Build the stable choice catalog used by the delegation decision tool.
 *
 * Only enabled, host-dispatchable agents are included. Routing hints retain
 * the same precedence as the legacy prompt catalog, and display-name aliases
 * are rewritten before the catalog leaves the process.
 */
export function buildDelegationRouteCandidates(
  runtime: RuntimeConfig,
  agentDefs: readonly AgentDefinition[],
): DelegationRouteCandidate[] {
  const routable = agentDefs.filter(shouldRouteTo);
  // Council is normally driven by its explicit multi-seat procedure, but it
  // must remain selectable when enforcement is enabled so that the procedure
  // is not deadlocked by the route gate.
  const council = agentDefs.find((agent) => agent.name === 'council');
  if (runtime.council && council) routable.push(council);
  const displayNames = new Map(
    routable
      .filter((agent) => Boolean(agent.displayName))
      .map((agent) => [
        agent.name,
        normalizeAgentName(agent.displayName as string),
      ]),
  );

  const rewriteDisplayNames = (text: string): string => {
    let rewritten = text;
    for (const [internalName, displayName] of displayNames) {
      rewritten = rewritten.replace(
        new RegExp(`@${escapeRegExp(internalName)}\\b`, 'g'),
        `@${displayName}`,
      );
    }
    return rewritten;
  };

  return routable.map((agent) => {
    const overridePrompt = runtime.agent(agent.name)?.orchestratorPrompt;
    const acp = runtime.acpAgents[agent.name];
    const criteria =
      overridePrompt ??
      acp?.orchestratorPrompt ??
      ROLE_ROUTING_BLOCKS[agent.name] ??
      (acp ? acpFallbackCriteria(agent, acp.command) : undefined) ??
      fallbackCriteria(agent);

    return {
      name: displayNames.get(agent.name) ?? agent.name,
      criteria: rewriteDisplayNames(criteria),
    };
  });
}
