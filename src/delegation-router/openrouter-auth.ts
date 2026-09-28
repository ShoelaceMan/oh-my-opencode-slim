import type { AuthHook } from '@opencode-ai/plugin';

interface CredentialBridge {
  auth: AuthHook;
  getCredential: () => string | undefined;
}

let sharedCredential: string | undefined;

export function setOpenRouterCredential(value: string | undefined): void {
  sharedCredential = value?.trim() || undefined;
}

/** Clear only the credential owned by a particular setup generation. */
export function clearOpenRouterCredential(expected: string | undefined): void {
  if (expected === undefined || sharedCredential === expected) {
    sharedCredential = undefined;
  }
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
  // Keep v1 setup credentials scoped to this bridge. The module-level value is
  // retained only for the v2 header bridge, where setup generation cleanup
  // explicitly fences it; v1 instances must not inherit another setup's key.
  let credential: string | undefined;
  return {
    getCredential: () => credential,
    auth: {
      provider: 'openrouter',
      methods: [{ type: 'api', label: 'API key' }],
      loader: async (getAuth) => {
        try {
          credential = readBearerCredential(await getAuth());
        } catch {
          credential = undefined;
        }
        return {};
      },
    },
  };
}
