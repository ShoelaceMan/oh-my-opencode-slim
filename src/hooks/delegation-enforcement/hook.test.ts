import { describe, expect, test } from 'bun:test';
import { DelegationRouterConfigSchema } from '../../config';
import { createDelegationEnforcementHook } from './hook';

const config = DelegationRouterConfigSchema.parse({
  enabled: true,
  enforce: true,
});

function hook(
  agent = 'orchestrator',
  getTaskAgent?: (sessionID: string, taskID: string) => string | undefined,
) {
  return createDelegationEnforcementHook({
    config,
    getAgent: () => agent,
    resolveAgentName: (value) => value.toLowerCase(),
    getTaskAgent,
  });
}

describe('delegation enforcement', () => {
  test('rejects operational tools before a Jev decision', () => {
    expect(() =>
      hook().before({ tool: 'bash', sessionID: 's1' }, { args: {} }),
    ).toThrow('no route exists');
  });

  test('allows passive inspection before routing', () => {
    expect(() =>
      hook().before({ tool: 'read', sessionID: 's1' }, { args: {} }),
    ).not.toThrow();
  });

  test('allows orchestration control tools before routing', () => {
    for (const tool of [
      'question',
      'permission',
      'plan_enter',
      'plan_exit',
      'todowrite',
    ]) {
      expect(() =>
        hook().before({ tool, sessionID: 's1' }, { args: {} }),
      ).not.toThrow();
    }
  });

  test('requires a decision before unclassified tools while enforcement is enabled', () => {
    expect(() =>
      hook().before(
        { tool: 'mcp_mutating_tool', sessionID: 's1' },
        { args: {} },
      ),
    ).toThrow('routing required');
  });

  test('requires the selected specialist for delegated work', () => {
    const routed = hook('orchestrator', () => 'runner');
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
    expect(() =>
      routed.before(
        { tool: 'task', sessionID: 's1' },
        { args: { subagent_type: 'runner' } },
      ),
    ).toThrow('selected direct');
  });

  test('requires a route for revive and allows it after an agent route', () => {
    const routed = hook('orchestrator', () => 'runner');
    expect(() =>
      routed.before(
        { tool: 'task_revive', sessionID: 's1' },
        { args: { task_id: 'child' } },
      ),
    ).toThrow('no route exists');
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
      routed.before(
        { tool: 'task_revive', sessionID: 's1' },
        { args: { task_id: 'child' } },
      ),
    ).not.toThrow();
  });

  test('rejects revival of a child owned by another specialist', () => {
    const routed = hook('orchestrator', () => 'operator');
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
      routed.before(
        { tool: 'task_revive', sessionID: 's1' },
        { args: { task_id: 'operator-task' } },
      ),
    ).toThrow('targets operator');
  });

  test('fails closed when a revived task has no recorded owner', () => {
    const routed = hook('orchestrator', () => undefined);
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
      routed.before(
        { tool: 'task_revive', sessionID: 's1' },
        { args: { task_id: 'unknown-task' } },
      ),
    ).toThrow('without a recorded task owner');
  });

  test('keeps council multi-seat dispatch compatible with enforcement', () => {
    const routed = hook();
    routed.after(
      { tool: 'route_agent', sessionID: 's1' },
      {
        output: JSON.stringify({
          status: 'selected',
          route_type: 'agent',
          route: 'council',
        }),
      },
    );
    expect(() =>
      routed.before(
        { tool: 'task', sessionID: 's1' },
        { args: { subagent_type: 'councillor-alpha' } },
      ),
    ).not.toThrow();
    expect(() =>
      routed.before(
        { tool: 'task', sessionID: 's1' },
        { args: { subagent_type: 'council' } },
      ),
    ).not.toThrow();
  });

  test('lets council gather context before dispatching councillors', () => {
    const routed = hook();
    routed.after(
      { tool: 'route_agent', sessionID: 's1' },
      {
        output: JSON.stringify({
          status: 'selected',
          route_type: 'agent',
          route: 'council',
        }),
      },
    );
    expect(() =>
      routed.before({ tool: 'bash', sessionID: 's1' }, { args: {} }),
    ).not.toThrow();
  });

  test('keeps council context tools available after dispatches', () => {
    const routed = hook();
    routed.after(
      { tool: 'route_agent', sessionID: 's1' },
      {
        output: JSON.stringify({
          status: 'selected',
          route_type: 'agent',
          route: 'council',
        }),
      },
    );
    expect(() =>
      routed.before({ tool: 'webfetch', sessionID: 's1' }, { args: {} }),
    ).not.toThrow();
    expect(() =>
      routed.before(
        { tool: 'bash', sessionID: 's1' },
        { args: { command: 'git diff -- README.md' } },
      ),
    ).not.toThrow();
    routed.before(
      { tool: 'task', sessionID: 's1' },
      { args: { subagent_type: 'councillor-alpha' } },
    );
    expect(() =>
      routed.before({ tool: 'bash', sessionID: 's1' }, { args: {} }),
    ).not.toThrow();
  });

  test('requires dispatch before mutating marketplace tools', () => {
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
      routed.before(
        { tool: 'marketplace_manage', sessionID: 's1' },
        { args: {} },
      ),
    ).toThrow('dispatch that specialist');
  });

  test('allows an unclassified extension only after routing', () => {
    const routed = hook();
    expect(() =>
      routed.before({ tool: 'mcp_readonly', sessionID: 's1' }, { args: {} }),
    ).toThrow('routing required');
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
      routed.before({ tool: 'mcp_readonly', sessionID: 's1' }, { args: {} }),
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
    ).toThrow('could not select a route');
  });

  test('treats uncertain routing as manual mode', () => {
    const routed = hook();
    routed.after(
      { tool: 'route_agent', sessionID: 's1' },
      {
        output: JSON.stringify({ status: 'uncertain', confidence: 0.56 }),
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
    ).toThrow('could not select a route');
  });
});
