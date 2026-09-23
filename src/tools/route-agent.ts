import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { DelegationRouterConfig } from '../config';
import type { DelegationRouteCandidate } from '../delegation-router';

const z = tool.schema;
const DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DIRECT_CHOICE = '__direct__';
const DIRECT_CRITERIA =
  'Handle directly only when this is one isolated, clear, low-risk action and delegation overhead exceeds execution. Do not choose direct for multi-step implementation, broad discovery, external research, design work, or complex debugging.';

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
  const choiceToRoute = new Map([
    [DIRECT_CHOICE, 'direct'],
    ...candidateChoices.map(
      ({ choice, candidate }) => [choice, candidate.name] as const,
    ),
  ]);

  const route_agent = tool({
    description:
      'Choose the best destination for one already-decomposed work lane. This is advisory only: it does not dispatch the agent. Send only the bounded objective and concise routing constraints; never include credentials, tokens, private keys, or unrelated conversation content.',
    args: {
      objective: z
        .string()
        .min(1)
        .max(4_000)
        .describe('One bounded lane objective to route'),
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

      const criteria = Object.fromEntries([
        [DIRECT_CHOICE, DIRECT_CRITERIA],
        ...candidateChoices.map(({ choice, candidate }) => [
          choice,
          candidate.criteria,
        ]),
      ]);
      const state = [
        `Bounded lane objective:\n${args.objective.trim()}`,
        args.context?.trim()
          ? `Routing-relevant constraints:\n${args.context.trim()}`
          : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n');

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.config.timeoutMs,
      );

      let response: Response;
      try {
        response = await fetchImpl(DECISIONS_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: options.config.model,
            state,
            questions: {
              route: {
                type: 'choice',
                instructions:
                  'Choose exactly one destination for this bounded work lane. Match capabilities and constraints; do not optimize for prose quality.',
                criteria,
              },
            },
          }),
          signal: controller.signal,
        });
      } catch {
        return unavailableResult(
          controller.signal.aborted ? 'request_timeout' : 'request_failed',
          options.candidates,
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        return unavailableResult(
          `http_error:${response.status}`,
          options.candidates,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return unavailableResult('invalid_json', options.candidates);
      }

      const answer = isRecord(payload)
        ? parseDecisionAnswer(
            isRecord(payload.answers) ? payload.answers.route : undefined,
          )
        : undefined;
      if (!answer || !choiceToRoute.has(answer.choice)) {
        return unavailableResult('invalid_decision', options.candidates);
      }

      const confidence = normalizeConfidence(
        answer.confidence ?? answer.probabilities?.[answer.choice],
      );
      const model =
        isRecord(payload) && typeof payload.model === 'string'
          ? payload.model
          : options.config.model;
      const alternatives = rankedAlternatives(answer, choiceToRoute);
      const route = choiceToRoute.get(answer.choice) as string;

      if (confidence < options.config.confidenceThreshold) {
        return JSON.stringify({
          protocol: 'oh-my-opencode-slim.delegation-router.v1',
          status: 'uncertain',
          route_type: answer.choice === DIRECT_CHOICE ? 'direct' : 'agent',
          route,
          confidence,
          threshold: options.config.confidenceThreshold,
          model,
          alternatives,
          dispatch: 'manual',
          candidates: manualCandidates(options.candidates),
        });
      }

      return JSON.stringify({
        protocol: 'oh-my-opencode-slim.delegation-router.v1',
        status: 'selected',
        route_type: answer.choice === DIRECT_CHOICE ? 'direct' : 'agent',
        route,
        confidence,
        model,
        alternatives,
        dispatch:
          answer.choice === DIRECT_CHOICE
            ? 'handle_directly'
            : 'delegate_with_native_subagent_tool',
      });
    },
  });

  return { route_agent };
}
