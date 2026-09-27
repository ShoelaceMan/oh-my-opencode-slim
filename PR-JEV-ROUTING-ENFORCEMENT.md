# PR title

feat: add optional Jev delegation routing and enforcement

## Summary

This change adds an opt-in Jev-based delegation router for the orchestrator.
It can select the most appropriate specialist agent through OpenRouter's
Decisions API, while preserving deterministic/manual fallback when the router
is unavailable or uncertain.

When explicitly enabled, enforcement makes the routing decision authoritative:
operational tool use and specialist dispatch are rejected until a valid route
decision exists. This turns routing guidance into an actual control boundary
without changing the default behavior for existing users.

## What changed

- Add the `route_agent` tool and delegation-router catalog.
- Add OpenRouter credential reuse, including the existing OpenCode credential
  path and configurable environment-variable fallback.
- Add `delegationRouter` configuration and schema documentation:
  - `enabled` — opt into Jev routing.
  - `enforce` — require a route decision before operational work or dispatch.
  - `model`, `confidenceThreshold`, `timeoutMs`, and `compactPrompt`.
- Add the delegation-enforcement hook for operational tools and specialist
  dispatches.
- Gate router use through the existing Noul/delegation decision flow.
- Keep built-in, custom, and ACP routing criteria available to the on-demand
  decision request while allowing the orchestrator prompt to stay compact.
- Add unit and integration coverage for catalog selection, credentials,
  configuration validation, routing, enforcement, and fallback behavior.

## Compatibility and rollout

The feature is disabled by default. Existing configurations retain their
current behavior until `delegationRouter.enabled` is set to `true`. Users who
want hard enforcement can additionally set `delegationRouter.enforce` to
`true`; ambiguous or failed decisions remain fail-safe and require manual
routing rather than guessing.

Example:

```json
{
  "delegationRouter": {
    "enabled": true,
    "enforce": true,
    "model": "typesafe/jev-1.13",
    "confidenceThreshold": 0.72,
    "timeoutMs": 5000,
    "compactPrompt": true
  }
}
```

## Validation

- `bun run check:ci`
- `bun run typecheck`
- `bun test`
- Focused routing and enforcement tests

The branch also passed the repository's focused template/test validation and
the full test suite before publication.

## Review notes

- No provider secret is written to plugin configuration.
- Default behavior is unchanged unless the feature is enabled.
- Enforcement is intentionally fail-safe: uncertainty does not silently turn
  into an arbitrary specialist dispatch.
- Prompt-cache safety is preserved by keeping routing criteria in the
  on-demand decision path.

