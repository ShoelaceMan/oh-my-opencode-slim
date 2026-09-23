import { describe, expect, mock, test } from 'bun:test';
import { DelegationRouterConfigSchema } from '../config';
import type { DelegationRouteCandidate } from '../delegation-router';
import { createRouteAgentTool } from './route-agent';

const config = DelegationRouterConfigSchema.parse({ enabled: true });
const candidates: DelegationRouteCandidate[] = [
  { name: 'explorer', criteria: 'Choose for codebase discovery.' },
  { name: 'fixer', criteria: 'Choose for bounded implementation.' },
];

function decisionResponse(answer: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      model: 'typesafe/jev-1.13-20260901',
      answers: { route: { type: 'choice', ...answer } },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse(String(result)) as Record<string, unknown>;
}

describe('route_agent tool', () => {
  test('returns a high-confidence route without dispatching it', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = mock(async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return decisionResponse({
        choice: '__agent__fixer',
        confidence: 0.91,
        probabilities: {
          __agent__fixer: 0.91,
          __agent__explorer: 0.07,
          __direct__: 0.02,
        },
      });
    }) as unknown as typeof fetch;
    const routeAgent = createRouteAgentTool({
      config,
      candidates,
      fetchImpl,
      env: { OPENROUTER_API_KEY: 'test-key' },
    }).route_agent;

    const result = parseResult(
      await routeAgent.execute(
        { objective: 'Implement the parsed configuration.' },
        { agent: 'orchestrator' } as never,
      ),
    );

    expect(result).toMatchObject({
      status: 'selected',
      route_type: 'agent',
      route: 'fixer',
      confidence: 0.91,
      dispatch: 'delegate_with_native_subagent_tool',
    });
    expect(requestBody?.model).toBe('typesafe/jev-1.13');
    expect(requestBody?.state).toContain('Implement the parsed configuration.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('maps the reserved direct choice to handle-directly guidance', async () => {
    const fetchImpl = mock(async () =>
      decisionResponse({ choice: '__direct__', confidence: 0.96 }),
    ) as unknown as typeof fetch;
    const routeAgent = createRouteAgentTool({
      config,
      candidates,
      fetchImpl,
      env: { OPENROUTER_API_KEY: 'test-key' },
    }).route_agent;

    const result = parseResult(
      await routeAgent.execute({ objective: 'Change one typo.' }, {
        agent: 'orchestrator',
      } as never),
    );
    expect(result).toMatchObject({
      status: 'selected',
      route_type: 'direct',
      route: 'direct',
      dispatch: 'handle_directly',
    });
  });

  test('fails open to manual routing below the confidence threshold', async () => {
    const fetchImpl = mock(async () =>
      decisionResponse({
        choice: '__agent__explorer',
        confidence: 0.51,
        probabilities: { __agent__explorer: 0.51, __agent__fixer: 0.49 },
      }),
    ) as unknown as typeof fetch;
    const routeAgent = createRouteAgentTool({
      config,
      candidates,
      fetchImpl,
      env: { OPENROUTER_API_KEY: 'test-key' },
    }).route_agent;

    const result = parseResult(
      await routeAgent.execute(
        { objective: 'Investigate and repair an unclear bug.' },
        { agent: 'orchestrator' } as never,
      ),
    );
    expect(result).toMatchObject({
      status: 'uncertain',
      route: 'explorer',
      dispatch: 'manual',
    });
    expect(result.candidates).toBeArray();
  });

  test('fails open without exposing or scraping a missing API key', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('fetch should not run');
    }) as unknown as typeof fetch;
    const routeAgent = createRouteAgentTool({
      config,
      candidates,
      fetchImpl,
      env: {},
    }).route_agent;

    const result = parseResult(
      await routeAgent.execute({ objective: 'Find the relevant code.' }, {
        agent: 'orchestrator',
      } as never),
    );
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'missing_api_key:OPENROUTER_API_KEY',
      dispatch: 'manual',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('fails open on HTTP and malformed decision responses', async () => {
    const httpTool = createRouteAgentTool({
      config,
      candidates,
      fetchImpl: mock(
        async () => new Response('', { status: 503 }),
      ) as unknown as typeof fetch,
      env: { OPENROUTER_API_KEY: 'test-key' },
    }).route_agent;
    const malformedTool = createRouteAgentTool({
      config,
      candidates,
      fetchImpl: mock(async () =>
        decisionResponse({ choice: 'unknown-agent' }),
      ) as unknown as typeof fetch,
      env: { OPENROUTER_API_KEY: 'test-key' },
    }).route_agent;

    expect(
      parseResult(
        await httpTool.execute({ objective: 'Route this.' }, {
          agent: 'orchestrator',
        } as never),
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'http_error:503' });
    expect(
      parseResult(
        await malformedTool.execute({ objective: 'Route this.' }, {
          agent: 'orchestrator',
        } as never),
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'invalid_decision' });
  });

  test('rejects calls from subagents, including before network access', async () => {
    const fetchImpl = mock(async () =>
      decisionResponse({ choice: '__agent__fixer' }),
    ) as unknown as typeof fetch;
    const routeAgent = createRouteAgentTool({
      config,
      candidates,
      fetchImpl,
      env: { OPENROUTER_API_KEY: 'test-key' },
    }).route_agent;

    await expect(
      routeAgent.execute({ objective: 'Route this.' }, {
        agent: 'fixer',
      } as never),
    ).rejects.toThrow('only be used by orchestrator');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('rejects calls without an orchestrator identity', async () => {
    const routeAgent = createRouteAgentTool({
      config,
      candidates,
      fetchImpl: mock(async () =>
        decisionResponse({ choice: '__agent__fixer' }),
      ) as unknown as typeof fetch,
      env: { OPENROUTER_API_KEY: 'test-key' },
    }).route_agent;

    await expect(
      routeAgent.execute({ objective: 'Route this.' }, {} as never),
    ).rejects.toThrow('only be used by orchestrator');
  });
});
