import { describe, expect, test } from 'bun:test';
import { createAgents } from '../agents';
import type { PluginConfig } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { buildDelegationRouteCandidates } from './catalog';

const DIRECTORY = '/tmp/delegation-router-catalog-test';

function runtimeFor(config: PluginConfig) {
  RuntimeConfig.reset(DIRECTORY);
  return RuntimeConfig.init(DIRECTORY, config);
}

describe('delegation route catalog', () => {
  test('uses enabled agents, custom routing hints, and display names', () => {
    const runtime = runtimeFor({
      delegationRouter: {
        enabled: true,
        model: 'typesafe/jev-1.13',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        confidenceThreshold: 0.72,
        timeoutMs: 5_000,
        compactPrompt: true,
      },
      agents: {
        explorer: {
          displayName: 'scout',
          orchestratorPrompt:
            '@explorer\n- Lane: Project-specific code reconnaissance',
        },
        janitor: {
          model: 'test/janitor',
          description: 'Repository cleanup specialist',
        },
      },
    });
    const candidates = buildDelegationRouteCandidates(
      runtime,
      createAgents(runtime),
    );

    expect(candidates.find((candidate) => candidate.name === 'scout')).toEqual({
      name: 'scout',
      criteria: '@scout\n- Lane: Project-specific code reconnaissance',
    });
    expect(
      candidates.find((candidate) => candidate.name === 'janitor')?.criteria,
    ).toContain('Repository cleanup specialist');
    expect(
      candidates.some((candidate) => candidate.name === 'orchestrator'),
    ).toBe(false);
    expect(candidates.some((candidate) => candidate.name === 'council')).toBe(
      false,
    );
    expect(candidates.some((candidate) => candidate.name === 'observer')).toBe(
      false,
    );
  });
});
