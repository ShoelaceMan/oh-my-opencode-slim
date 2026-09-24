import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { DelegationRouterConfig } from '../config';
import type { DelegationRouteCandidate } from '../delegation-router';

const z = tool.schema;
const DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DIRECT_CRITERIA =
  'Handle directly only when this is one isolated, clear, low-risk action and delegation overhead exceeds execution. Do not choose direct for multi-step implementation, broad discovery, external research, design work, or complex debugging.';
const DELEGATE_CRITERIA =
  'Delegate when the task benefits from specialist capabilities or isolated context, including multi-step implementation, broad discovery, external research, design work, complex debugging, or independent parallel work.';

type FetchLike = typeof globalThis.fetch;

interface RouteAgentToolOptions {
  config: DelegationRouterConfig;
  candidates: readonly DelegationRouteCandidate[];
  resolveAgentName?: (agent: string) => string;
  getOpenRouterCredential?: () => string | undefined;
  fetchImpl?: FetchLike;
  env?: Readonly<Record<string, string | undefined>>;
}

interface DecisionAnswer {
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface NoulAnswer {
  noul: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDecisionAnswer(value: unknown): DecisionAnswer | undefined {
  if (!isRecord(value) || typeof value.choice !== 'string') return undefined;

  const confidence =
    typeof value.confidence === 'number' && Number.isFinite(value.confidence)
      ? value.confidence
      : undefined;
  const probabilities = isRecord(value.probabilities)
    ? Object.fromEntries(
        Object.entries(value.probabilities).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' && Number.isFinite(entry[1]),
        ),
      )
    : undefined;

  return { choice: value.choice, confidence, probabilities };
}

function parseNoulAnswer(value: unknown): NoulAnswer | undefined {
  if (
    !isRecord(value) ||
    value.type !== 'noul' ||
    typeof value.noul !== 'number' ||
    !Number.isFinite(value.noul)
  ) {
    return undefined;
  }

  return { noul: value.noul };
}

function normalizeConfidence(value: number | undefined): number {
  if (value === undefined) return 0;
  return Math.max(0, Math.min(1, value));
}

function rankedAlternatives(
  answer: DecisionAnswer,
  choiceToRoute: ReadonlyMap<string, string>,
): Array<{
  route: string;
  probability: number;
}> {
  return Object.entries(answer.probabilities ?? {})
    .filter(([choice]) => choice !== answer.choice && choiceToRoute.has(choice))
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([choice, probability]) => ({
      route: choiceToRoute.get(choice) as string,
      probability: normalizeConfidence(probability),
    }));
}

function manualCandidates(candidates: readonly DelegationRouteCandidate[]) {
  return [
    { route_type: 'direct', route: 'direct', criteria: DIRECT_CRITERIA },
    ...candidates.map((candidate) => ({
      route_type: 'agent',
      route: candidate.name,
      criteria: candidate.criteria,
    })),
  ];
}

function unavailableResult(
  reason: string,
  candidates: readonly DelegationRouteCandidate[],
): string {
  return JSON.stringify({
    protocol: 'oh-my-opencode-slim.delegation-router.v1',
    status: 'unavailable',
    reason,
    dispatch: 'manual',
    candidates: manualCandidates(candidates),
  });
}

type DecisionRequestResult =
  | { ok: true; payload: unknown }
  | { ok: false; reason: string };

async function requestDecision(
  fetchImpl: FetchLike,
  apiKey: string,
  config: DelegationRouterConfig,
  state: string,
  questions: Record<string, unknown>,
): Promise<DecisionRequestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(DECISIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        state,
        questions,
      }),
      signal: controller.signal,
    });
  } catch {
    return {
      ok: false,
      reason: controller.signal.aborted ? 'request_timeout' : 'request_failed',
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return { ok: false, reason: `http_error:${response.status}` };
  }

  try {
    return { ok: true, payload: await response.json() };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

/**
 * Create the orchestrator-only advisory routing tool backed by OpenRouter's
 * typed Decisions API. It never dispatches a subagent itself.
 */
export function createRouteAgentTool(
  options: RouteAgentToolOptions,
): Record<'route_agent', ToolDefinition> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const environment = options.env ?? process.env;
  const candidateChoices = options.candidates.map((candidate) => ({
    choice: `__agent__${candidate.name}`,
    candidate,
  }));
  const choiceToRoute = new Map(
    candidateChoices.map(
      ({ choice, candidate }) => [choice, candidate.name] as const,
    ),
  );

  const route_agent = tool({
    description:
      'Decide whether one bounded task should be delegated and, when it should, choose the best specialist. This is advisory only: it does not dispatch the agent. Send only the bounded objective and concise routing constraints; never include credentials, tokens, private keys, or unrelated conversation content.',
    args: {
      objective: z
        .string()
        .min(1)
        .max(4_000)
        .describe('One bounded task objective to gate and route'),
      context: z
        .string()
        .max(8_000)
        .optional()
        .describe(
          'Optional concise constraints that affect specialist selection; omit unrelated context and secrets',
        ),
    },
    async execute(args, toolContext) {
      const rawAgent = toolContext?.agent;
      const agent =
        typeof rawAgent === 'string'
          ? (options.resolveAgentName?.(rawAgent) ?? rawAgent)
          : undefined;
      if (agent !== 'orchestrator') {
        throw new Error('route_agent can only be used by orchestrator');
      }

      const apiKey =
        options.getOpenRouterCredential?.()?.trim() ||
        environment[options.config.apiKeyEnv]?.trim();
      if (!apiKey) {
        return unavailableResult(
          `missing_openrouter_credentials:${options.config.apiKeyEnv}`,
          options.candidates,
        );
      }

      const state = [
        `Bounded task objective:\n${args.objective.trim()}`,
        args.context?.trim()
          ? `Routing-relevant constraints:\n${args.context.trim()}`
          : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n');

      const delegationResult = await requestDecision(
        fetchImpl,
        apiKey,
        options.config,
        state,
        {
          should_delegate: {
            type: 'noul',
            instructions:
              'Should the orchestrator delegate this bounded task to a specialist instead of handling the entire task itself?',
            criteria: {
              true: DELEGATE_CRITERIA,
              false: DIRECT_CRITERIA,
            },
          },
        },
      );
      if (!delegationResult.ok) {
        return unavailableResult(delegationResult.reason, options.candidates);
      }

      const delegationPayload = delegationResult.payload;
      const answers =
        isRecord(delegationPayload) && isRecord(delegationPayload.answers)
          ? delegationPayload.answers
          : undefined;
      const delegationAnswer = parseNoulAnswer(answers?.should_delegate);
      if (!delegationAnswer) {
        return unavailableResult(
          'invalid_delegation_decision',
          options.candidates,
        );
      }

      const delegationProbability = normalizeConfidence(delegationAnswer.noul);
      const shouldDelegate = delegationProbability >= 0.5;
      const delegationCertainty = Math.max(
        delegationProbability,
        1 - delegationProbability,
      );
      const model =
        isRecord(delegationPayload) &&
        typeof delegationPayload.model === 'string'
          ? delegationPayload.model
          : options.config.model;

      if (delegationCertainty < options.config.confidenceThreshold) {
        return JSON.stringify({
          protocol: 'oh-my-opencode-slim.delegation-router.v1',
          status: 'uncertain',
          decision_type: 'noul',
          should_delegate: null,
          delegation_probability: delegationProbability,
          threshold: options.config.confidenceThreshold,
          model,
          dispatch: 'manual',
          candidates: manualCandidates(options.candidates),
        });
      }

      if (!shouldDelegate) {
        return JSON.stringify({
          protocol: 'oh-my-opencode-slim.delegation-router.v1',
          status: 'selected',
          decision_type: 'noul',
          should_delegate: false,
          delegation_probability: delegationProbability,
          route_type: 'direct',
          route: 'direct',
          model,
          dispatch: 'handle_directly',
        });
      }

      if (candidateChoices.length === 0) {
        return unavailableResult('no_route_candidates', options.candidates);
      }

      const criteria = Object.fromEntries(
        candidateChoices.map(({ choice, candidate }) => [
          choice,
          candidate.criteria,
        ]),
      );
      const routeResult = await requestDecision(
        fetchImpl,
        apiKey,
        options.config,
        state,
        {
          route: {
            type: 'choice',
            instructions:
              'Choose exactly one specialist destination for this delegated task. Match capabilities and constraints; do not optimize for prose quality.',
            criteria,
          },
        },
      );
      if (!routeResult.ok) {
        return unavailableResult(routeResult.reason, options.candidates);
      }

      const routePayload = routeResult.payload;
      const routeAnswers =
        isRecord(routePayload) && isRecord(routePayload.answers)
          ? routePayload.answers
          : undefined;
      const answer = parseDecisionAnswer(routeAnswers?.route);
      if (!answer || !choiceToRoute.has(answer.choice)) {
        return unavailableResult('invalid_route_decision', options.candidates);
      }

      const confidence = normalizeConfidence(
        answer.confidence ?? answer.probabilities?.[answer.choice],
      );
      const alternatives = rankedAlternatives(answer, choiceToRoute);
      const route = choiceToRoute.get(answer.choice) as string;
      const routeModel =
        isRecord(routePayload) && typeof routePayload.model === 'string'
          ? routePayload.model
          : options.config.model;

      if (confidence < options.config.confidenceThreshold) {
        return JSON.stringify({
          protocol: 'oh-my-opencode-slim.delegation-router.v1',
          status: 'uncertain',
          decision_type: 'choice',
          should_delegate: true,
          delegation_probability: delegationProbability,
          route_type: 'agent',
          route,
          confidence,
          threshold: options.config.confidenceThreshold,
          model: routeModel,
          alternatives,
          dispatch: 'manual',
          candidates: manualCandidates(options.candidates),
        });
      }

      return JSON.stringify({
        protocol: 'oh-my-opencode-slim.delegation-router.v1',
        status: 'selected',
        decision_type: 'choice',
        should_delegate: true,
        delegation_probability: delegationProbability,
        route_type: 'agent',
        route,
        confidence,
        model: routeModel,
        alternatives,
        dispatch: 'delegate_with_native_subagent_tool',
      });
    },
  });

  return { route_agent };
}
