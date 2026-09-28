import { describe, expect, test } from 'bun:test';
import { createOpenRouterCredentialBridge } from './openrouter-auth';

describe('OpenRouter credential bridge', () => {
  test('captures an OpenCode-stored API key through the auth loader', async () => {
    const bridge = createOpenRouterCredentialBridge();

    expect(bridge.getCredential()).toBeUndefined();
    await bridge.auth.loader?.(
      async () => ({ type: 'api', key: '  stored-key  ' }),
      {} as never,
    );

    expect(bridge.getCredential()).toBe('stored-key');
    expect(bridge.auth.provider).toBe('openrouter');
    expect(bridge.auth.methods).toEqual([{ type: 'api', label: 'API key' }]);
  });

  test('accepts bearer credentials and clears unusable auth values', async () => {
    const bridge = createOpenRouterCredentialBridge();

    await bridge.auth.loader?.(
      async () => ({
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
      }),
      {} as never,
    );
    expect(bridge.getCredential()).toBe('access-token');

    await bridge.auth.loader?.(
      async () => ({ type: 'api', key: '   ' }),
      {} as never,
    );
    expect(bridge.getCredential()).toBeUndefined();
  });

  test('fails closed when OpenCode cannot read provider auth', async () => {
    const bridge = createOpenRouterCredentialBridge();

    await bridge.auth.loader?.(async () => {
      throw new Error('unavailable');
    }, {} as never);

    expect(bridge.getCredential()).toBeUndefined();
  });

  test('does not share credentials between setup bridges', async () => {
    const first = createOpenRouterCredentialBridge();
    const second = createOpenRouterCredentialBridge();

    await first.auth.loader?.(
      async () => ({ type: 'api', key: 'first-key' }),
      {} as never,
    );
    expect(first.getCredential()).toBe('first-key');
    expect(second.getCredential()).toBeUndefined();
  });
});
