import { describe, expect, test } from 'bun:test';
import { DelegationRouterConfigSchema } from '../../config';
import { createDelegationEnforcementHook } from './hook';

const config = DelegationRouterConfigSchema.parse({
  enabled: true,
  enforce: true,
});

function hook(agent = 'orchestrator') {
  return createDelegationEnforcementHook({
    config,
    getAgent: () => agent,
    resolveAgentName: (value) => value.toLowerCase(),
  });
}

describe('delegation enforcement', () => {
  test('rejects operational tools before a Jev decision', () => {
    expect(() =>
      hook().before({ tool: 'bash', sessionID: 's1' }, { args: {} }),
    ).toThrow('routing required');
  });

  test('allows passive inspection before routing', () => {
    expect(() =>
      hook().before({ tool: 'read', sessionID: 's1' }, { args: {} }),
    ).not.toThrow();
  });

  test('blocks unclassified tools while enforcement is enabled', () => {
    expect(() =>
      hook().before({ tool: 'mcp_mutating_tool', sessionID: 's1' }, { args: {} }),
    ).toThrow('unknown tool is blocked');
  });

  test('requires the selected specialist for delegated work', () => {
    const routed = hook();
    routed.after(
      { tool: 'route_agent', sessionID: 's1' },
      {
        output: JSON.stringify({
          status: 'selected',
          route_type: 'agent',
          route: 'runner',
        }),
      },
    );
    expect(() =>
      routed.before({ tool: 'bash', sessionID: 's1' }, { args: {} }),
    ).toThrow('selected runner');
    expect(() =>
      routed.before(
        { tool: 'task', sessionID: 's1' },
        { args: { subagent_type: 'runner' } },
      ),
    ).not.toThrow();
    expect(() =>
      routed.before({ tool: 'task', sessionID: 's1' }, { args: {} }),
    ).toThrow('call route_agent again');
  });

  test('allows direct tools after a direct decision', () => {
    const routed = hook();
    routed.after(
      { tool: 'route_agent', sessionID: 's1' },
      {
        output: JSON.stringify({
          status: 'selected',
          route_type: 'direct',
          route: 'direct',
        }),
      },
    );
    expect(() =>
      routed.before({ tool: 'bash', sessionID: 's1' }, { args: {} }),
    ).not.toThrow();
  });

  test('accepts a display-name route when the task uses the canonical name', () => {
    const routed = hook();
    routed.after(
      { tool: 'route_agent', sessionID: 's1' },
      {
        output: JSON.stringify({
          status: 'selected',
          route_type: 'agent',
          route: 'Operator',
        }),
      },
    );
    expect(() =>
      routed.before(
        { tool: 'task', sessionID: 's1' },
        { args: { subagent_type: 'operator' } },
      ),
    ).not.toThrow();
  });

  test('allows verification after one specialist dispatch but requires a new route for another task', () => {
    const routed = hook();
    routed.after(
      { tool: 'route_agent', sessionID: 's1' },
      {
        output: JSON.stringify({
          status: 'selected',
          route_type: 'agent',
          route: 'runner',
        }),
      },
    );
    routed.before(
      { tool: 'task', sessionID: 's1' },
      { args: { subagent_type: 'runner' } },
    );
    expect(() =>
      routed.before({ tool: 'bash', sessionID: 's1' }, { args: {} }),
    ).not.toThrow();
    expect(() =>
      routed.before(
        { tool: 'task', sessionID: 's1' },
        { args: { subagent_type: 'runner' } },
      ),
    ).toThrow('call route_agent again');
  });

  test('allows explicit manual fallback', () => {
    const routed = hook();
    routed.after(
      { tool: 'route_agent', sessionID: 's1' },
      {
        output: JSON.stringify({ status: 'uncertain', dispatch: 'manual' }),
      },
    );
    expect(() =>
      routed.before({ tool: 'bash', sessionID: 's1' }, { args: {} }),
    ).not.toThrow();
    expect(() =>
      routed.before(
        { tool: 'task', sessionID: 's1' },
        { args: { subagent_type: 'runner' } },
      ),
    ).not.toThrow();
  });
});
