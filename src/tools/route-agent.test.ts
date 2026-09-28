import { describe, expect, mock, test } from 'bun:test';
import { DelegationRouterConfigSchema } from '../config';
import type { DelegationRouteCandidate } from '../delegation-router';
import { createRouteAgentTool } from './route-agent';

const config = DelegationRouterConfigSchema.parse({ enabled: true });
const candidates: DelegationRouteCandidate[] = [
  { name: 'explorer', criteria: 'Choose for codebase discovery.' },
  { name: 'fixer', criteria: 'Choose for bounded implementation.' },
];

function decisionResponse(
  answer: Record<string, unknown>,
  delegationProbability = 0.95,
) {
  return new Response(
    JSON.stringify({
      model: 'typesafe/jev-1.13-20260901',
      answers: {
        should_delegate: { type: 'noul', noul: delegationProbability },
        route: { type: 'choice', ...answer },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse(String(result)) as Record<string, unknown>;
}

describe('route_agent tool', () => {
  test('returns a high-confidence route without dispatching it', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    let authorization: string | null = null;
    const fetchImpl = mock(async (_input: unknown, init?: RequestInit) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      authorization = new Headers(init?.headers).get('authorization');
      return decisionResponse({
        choice: '__agent__fixer',
        confidence: 0.91,
        probabilities: {
          __agent__fixer: 0.91,
          __agent__explorer: 0.07,
        },
      });
    }) as unknown as typeof fetch;
    const routeAgent = createRouteAgentTool({
      config,
      candidates,
      fetchImpl,
      getOpenRouterCredential: () => 'stored-opencode-key',
      env: {},
      getActiveTasks: () => [
        {
          taskID: 'ses_operator',
          alias: 'ope-5',
          agent: 'operator',
          state: 'running',
          description: 'Pin and prove the backend route',
        },
      ],
    }).route_agent;

    const result = parseResult(
      await routeAgent.execute(
        { objective: 'Implement the parsed configuration.' },
        { agent: 'orchestrator', sessionID: 'ses_parent' } as never,
      ),
    );

    expect(result).toMatchObject({
      status: 'selected',
      route_type: 'agent',
      route: 'fixer',
      should_delegate: true,
      delegation_probability: 0.95,
      confidence: 0.91,
      dispatch: 'delegate_with_native_subagent_tool',
    });
    expect(requestBodies[0]?.model).toBe('typesafe/jev-1.13');
    expect(requestBodies[0]?.state).toContain(
      'Implement the parsed configuration.',
    );
    expect(requestBodies[0]?.state).toContain(
      'ope-5 (ses_operator), agent=operator, state=running',
    );
    expect(requestBodies[0]?.questions).toMatchObject({
      should_delegate: { type: 'noul' },
    });
    expect(requestBodies[0]?.questions).not.toHaveProperty('route');
    expect(requestBodies[1]?.questions).toMatchObject({
      route: { type: 'choice' },
    });
    expect(requestBodies[1]?.questions).not.toHaveProperty('should_delegate');
    expect(JSON.stringify(requestBodies[1]?.questions)).not.toContain(
      '__direct__',
    );
    expect(authorization).toBe('Bearer stored-opencode-key');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('maps a confident Noul no to handle-directly guidance', async () => {
    const fetchImpl = mock(async () =>
      decisionResponse({ choice: 'ignored-invalid-route' }, 0.04),
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
      decision_type: 'noul',
      should_delegate: false,
      delegation_probability: 0.04,
      route_type: 'direct',
      route: 'direct',
      dispatch: 'handle_directly',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('fails open when the Noul delegation gate is ambiguous', async () => {
    const fetchImpl = mock(async () =>
      decisionResponse({ choice: '__agent__fixer', confidence: 0.99 }, 0.51),
    ) as unknown as typeof fetch;
    const routeAgent = createRouteAgentTool({
      config,
      candidates,
      fetchImpl,
      env: { OPENROUTER_API_KEY: 'test-key' },
    }).route_agent;

    const result = parseResult(
      await routeAgent.execute({ objective: 'Handle a borderline task.' }, {
        agent: 'orchestrator',
      } as never),
    );
    expect(result).toMatchObject({
      status: 'uncertain',
      decision_type: 'noul',
      should_delegate: null,
      delegation_probability: 0.51,
      dispatch: 'manual',
    });
    expect(result.candidates).toBeArray();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
      should_delegate: true,
      delegation_probability: 0.95,
      route: 'explorer',
      dispatch: 'manual',
    });
    expect(result.candidates).toBeArray();
  });

  test('fails open without exposing or scraping missing credentials', async () => {
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
      reason: 'missing_openrouter_credentials:OPENROUTER_API_KEY',
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
    const malformedGateTool = createRouteAgentTool({
      config,
      candidates,
      fetchImpl: mock(
        async () =>
          new Response(
            JSON.stringify({
              answers: {
                should_delegate: { type: 'noul', noul: 'yes' },
                route: {
                  type: 'choice',
                  choice: '__agent__fixer',
                  confidence: 1,
                },
              },
            }),
            { status: 200 },
          ),
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
    ).toMatchObject({
      status: 'unavailable',
      reason: 'invalid_route_decision',
    });
    expect(
      parseResult(
        await malformedGateTool.execute({ objective: 'Route this.' }, {
          agent: 'orchestrator',
        } as never),
      ),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'invalid_delegation_decision',
    });
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
