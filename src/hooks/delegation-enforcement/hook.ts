import type { DelegationRouterConfig } from '../../config';

const ROUTE_TOOL = 'route_agent';
const TASK_TOOLS = new Set(['task', 'subagent', 'task_revive']);
const OPERATIONAL_TOOLS = new Set([
  'bash',
  'edit',
  'write',
  'apply_patch',
  'ast_grep_replace',
  'acp_run',
  'webfetch',
  'task',
  'subagent',
  'task_revive',
  'marketplace_manage',
]);
const SAFE_TOOLS = new Set([
  ROUTE_TOOL,
  'read',
  'list',
  'glob',
  'grep',
  'lsp_diagnostics',
  'ast_grep_search',
  'task_status',
  'task_result',
  'task_message',
  'task_cancel',
  'wait_for_user',
  'question',
  'permission',
]);

type Decision = {
  routeType: 'direct' | 'agent' | 'manual';
  route: string;
  dispatchUsed: boolean;
};

interface ToolBeforeInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface ToolBeforeOutput {
  args?: unknown;
}

interface ToolAfterOutput {
  output?: unknown;
}

interface HookOptions {
  config: DelegationRouterConfig;
  getAgent: (sessionID: string) => string | undefined;
  resolveAgentName: (agent: string) => string;
  getTaskAgent?: (sessionID: string, taskID: string) => string | undefined;
}

const COUNCIL_CONTEXT_COMMANDS = new Set([
  'cat',
  'cut',
  'find',
  'git',
  'gh',
  'grep',
  'head',
  'jq',
  'ls',
  'pwd',
  'rg',
  'sed',
  'sort',
  'tail',
  'tr',
  'uniq',
  'curl',
  'wget',
]);

const COUNCIL_GIT_READ_COMMANDS = new Set([
  'branch',
  'diff',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'status',
]);

function isCouncilReadOnlyCommand(part: string): boolean {
  const tokens = part.trim().split(/\s+/);
  const executable = tokens.shift();
  if (!executable || !COUNCIL_CONTEXT_COMMANDS.has(executable)) return false;

  if (executable === 'git') {
    const subcommand = tokens.find((token) => !token.startsWith('-'));
    return Boolean(subcommand && COUNCIL_GIT_READ_COMMANDS.has(subcommand));
  }
  if (executable === 'gh') {
    const subcommand = tokens.find((token) => !token.startsWith('-'));
    if (subcommand === 'api') {
      return !tokens.some((token) =>
        ['-X', '--method', '-f', '--raw-field', '-F', '--field'].includes(
          token,
        ),
      );
    }
    return subcommand === 'pr' || subcommand === 'issue';
  }
  if (executable === 'curl') {
    return !tokens.some(
      (token, index) =>
        [
          '-d',
          '--data',
          '--data-raw',
          '--data-binary',
          '--upload-file',
        ].includes(token) ||
        (['-X', '--request'].includes(token) &&
          tokens[index + 1]?.toUpperCase() !== 'GET'),
    );
  }
  if (executable === 'sed') return !tokens.includes('-i');
  if (executable === 'find') {
    return !tokens.some((token) =>
      ['-delete', '-exec', '-execdir'].includes(token),
    );
  }
  return true;
}

function isCouncilContextBash(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) return false;
  const command = (args as Record<string, unknown>).command;
  if (typeof command !== 'string' || !command.trim()) return false;
  // Permit only pipelines/chains made entirely from known inspection and
  // retrieval commands. Shell redirection/substitution is deliberately not
  // accepted because it can turn a seemingly read-only command into a write.
  if (/[>;`;\n\r]|\$\(/.test(command)) return false;
  return command.split(/\s*(?:\|\||&&|\|)\s*/).every(isCouncilReadOnlyCommand);
}

function parseDecision(output: unknown): Decision | undefined {
  if (typeof output !== 'string') return undefined;
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    if (value.status === 'unavailable' || value.status === 'uncertain') {
      return value.dispatch === 'manual'
        ? { routeType: 'manual', route: 'manual', dispatchUsed: false }
        : undefined;
    }
    if (value.status !== 'selected') return undefined;
    if (value.route_type !== 'direct' && value.route_type !== 'agent') {
      return undefined;
    }
    return {
      routeType: value.route_type,
      route:
        typeof value.route === 'string' && value.route !== 'direct'
          ? value.route
          : 'direct',
      dispatchUsed: false,
    };
  } catch {
    return undefined;
  }
}

/**
 * Enforces the Jev routing decision at the tool boundary. Prompt guidance is
 * advisory; this hook makes an enabled `enforce` setting observable and
 * fail-closed for operational tools.
 */
export function createDelegationEnforcementHook(options: HookOptions) {
  const decisions = new Map<string, Decision>();

  const activeFor = (sessionID: string | undefined): boolean =>
    Boolean(
      options.config.enabled &&
        options.config.enforce &&
        sessionID &&
        options.getAgent(sessionID) === 'orchestrator',
    );

  return {
    reset(sessionID: string): void {
      decisions.delete(sessionID);
    },

    before(input: ToolBeforeInput, output: ToolBeforeOutput): void {
      if (!activeFor(input.sessionID)) return;
      const tool = input.tool.toLowerCase();
      if (SAFE_TOOLS.has(tool)) return;
      const decision = decisions.get(input.sessionID as string);
      if (!OPERATIONAL_TOOLS.has(tool)) {
        if (!decision) {
          throw new Error(
            '[delegation-router] routing required before using an unclassified tool while enforcement is enabled',
          );
        }
        // Host extensions and MCPs are not enumerable here. Once the
        // orchestrator has made a route decision, allow them to proceed; the
        // pre-decision path remains fail-closed for unknown tools.
        if (decision.routeType === 'agent' && !decision.dispatchUsed) {
          throw new Error(
            `[delegation-router] Jev selected ${decision.route}; dispatch that specialist before using unclassified tools`,
          );
        }
        return;
      }

      if (!decision) {
        throw new Error(
          '[delegation-router] routing required: call route_agent for this bounded task before using operational tools or dispatching a specialist',
        );
      }

      // Council needs to collect the PR/issue/document context before it can
      // dispatch councillors. Keep this escape hatch explicitly read-only:
      // webfetch is retrieval-only, while bash is limited to inspection and
      // retrieval commands above. Mutating tools still require dispatch.
      if (
        decision.routeType === 'agent' &&
        decision.route === 'council' &&
        !decision.dispatchUsed &&
        (tool === 'webfetch' ||
          (tool === 'bash' && isCouncilContextBash(output.args)))
      ) {
        return;
      }

      if (
        decision.routeType === 'agent' &&
        !decision.dispatchUsed &&
        !TASK_TOOLS.has(tool)
      ) {
        throw new Error(
          `[delegation-router] Jev selected ${decision.route}; dispatch that specialist with task before using operational tools directly`,
        );
      }

      if (decision.routeType === 'direct' && TASK_TOOLS.has(tool)) {
        throw new Error(
          '[delegation-router] Jev selected direct; handle the task directly instead of dispatching a specialist',
        );
      }

      // Reviving an existing child is a continuation of an already selected
      // specialist route. It still requires a decision, but must remain
      // usable after the initial dispatch has consumed that route.
      if (tool === 'task_revive') {
        if (decision.routeType === 'direct') {
          throw new Error(
            '[delegation-router] Jev selected direct; do not revive a specialist task',
          );
        }
        const args =
          output.args && typeof output.args === 'object'
            ? (output.args as Record<string, unknown>)
            : {};
        const taskID = typeof args.task_id === 'string' ? args.task_id : '';
        if (!taskID) {
          throw new Error(
            '[delegation-router] task_revive requires a task_id so ownership can be verified',
          );
        }
        const taskAgent = options.getTaskAgent?.(
          input.sessionID as string,
          taskID,
        );
        if (!taskAgent) {
          throw new Error(
            `[delegation-router] cannot revive ${taskID} without a recorded task owner`,
          );
        }
        const resolvedTaskAgent = options.resolveAgentName(taskAgent);
        const ownsRevivedTask =
          decision.route === 'council'
            ? resolvedTaskAgent === 'council' ||
              resolvedTaskAgent.startsWith('councillor-')
            : resolvedTaskAgent === options.resolveAgentName(decision.route);
        if (!ownsRevivedTask) {
          throw new Error(
            `[delegation-router] Jev selected ${decision.route}; task_revive targets ${taskAgent}`,
          );
        }
        return;
      }

      if (decision.routeType === 'agent' && TASK_TOOLS.has(tool)) {
        const args =
          output.args && typeof output.args === 'object'
            ? (output.args as Record<string, unknown>)
            : {};
        const target = args.subagent_type ?? args.agent;
        const resolvedTarget =
          typeof target === 'string'
            ? options.resolveAgentName(target)
            : undefined;
        if (decision.route === 'council') {
          if (
            resolvedTarget !== 'council' &&
            !resolvedTarget?.startsWith('councillor-')
          ) {
            throw new Error(
              `[delegation-router] Jev selected council; task target was ${typeof target === 'string' ? target : 'missing'}`,
            );
          }
          return;
        }
        if (decision.dispatchUsed) {
          throw new Error(
            '[delegation-router] this route was already dispatched; call route_agent again for the next specialist task',
          );
        }
        const resolvedRoute = options.resolveAgentName(decision.route);
        if (resolvedTarget !== resolvedRoute) {
          throw new Error(
            `[delegation-router] Jev selected ${decision.route}; task target was ${typeof target === 'string' ? target : 'missing'}`,
          );
        }
        decision.dispatchUsed = true;
      }
    },

    after(input: ToolBeforeInput, output: ToolAfterOutput): void {
      if (
        !activeFor(input.sessionID) ||
        input.tool.toLowerCase() !== ROUTE_TOOL
      ) {
        return;
      }
      const decision = parseDecision(output.output);
      if (decision && input.sessionID) decisions.set(input.sessionID, decision);
    },
  };
}
