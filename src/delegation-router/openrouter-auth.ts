import type { AuthHook } from '@opencode-ai/plugin';

interface CredentialBridge {
  auth: AuthHook;
  getCredential: () => string | undefined;
}

let sharedCredential: string | undefined;

export function setOpenRouterCredential(value: string | undefined): void {
  sharedCredential = value?.trim() || undefined;
}

function readBearerCredential(auth: unknown): string | undefined {
  if (typeof auth !== 'object' || auth === null) return undefined;

  const value = auth as { type?: unknown; key?: unknown; access?: unknown };
  const credential =
    value.type === 'api'
      ? value.key
      : value.type === 'oauth'
        ? value.access
        : undefined;
  return typeof credential === 'string' && credential.trim()
    ? credential.trim()
    : undefined;
}

/**
 * Reuse OpenCode's stored OpenRouter credential without reading its auth file.
 *
 * OpenCode only releases a provider credential to a plugin through an auth
 * loader. The API-key method intentionally mirrors OpenCode's generic provider
 * login so enabling the bridge does not break `/connect openrouter`.
 */
export function createOpenRouterCredentialBridge(): CredentialBridge {
  return {
    getCredential: () => sharedCredential,
    auth: {
      provider: 'openrouter',
      methods: [{ type: 'api', label: 'API key' }],
      loader: async (getAuth) => {
        try {
          setOpenRouterCredential(readBearerCredential(await getAuth()));
        } catch {
          setOpenRouterCredential(undefined);
        }
        return {};
      },
    },
  };
}
