# src/delegation-router/

## Responsibility

Builds the deterministic specialist-choice catalog for the optional delegation
router. It includes only enabled, host-dispatchable agents; excludes the
orchestrator and internal Council agents; preserves custom and ACP routing
guidance; and rewrites configured display names before criteria leave the
process.

## Flow

1. `src/agents/index.ts` constructs and validates the effective agent tree.
2. `buildDelegationRouteCandidates()` receives that frozen construction-time
   tree plus `RuntimeConfig`.
3. Each candidate receives host-facing dispatch name and routing criteria.
4. `src/tools/route-agent.ts` sends the catalog with one bounded lane to the
   OpenRouter Decisions API.
5. Jev returns a typed choice; the tool reports it to the orchestrator without
   launching any agent.

## Cache and Security Boundaries

- Catalog construction is deterministic for a plugin generation, so compact
  prompt assembly stays cache-safe.
- API credentials are not part of the catalog and are read only by the tool
  from the configured environment variable at execution time.
- Council/councillor routing remains on the existing explicit Council Mode
  path rather than becoming an ordinary Jev choice.
