# NEVER INTRODUCE ARTIFICIAL GATES

- Keep the application usable after a normal deployment, database reset, and sign-in.
  Initial read-only synchronization must start automatically.
- Never add release acceptance, requalification, canary approval, manual-start,
  feature-enable, or other invented prerequisites to supported application flows.
  Deployment/test workflow bookkeeping must not become runtime authorization.
- Preserve real authentication, provider permissions, role checks, data-integrity
  constraints, and confirmation for destructive actions. Do not confuse those
  requirements with an additional application-owned approval process.
- A task is not complete because builds/tests pass or health endpoints are green.
  Verify the actual first-run and affected user journeys work without hidden
  switches, undocumented operator intervention, or additional approval steps.
- If a real provider limitation prevents an operation, report that specific
  limitation honestly. Do not add speculative restrictions to working features.

# CURRENT-ONLY CODE AND SCHEMA

- Keep only the current supported implementation. Do not retain compatibility
  routes, adapters, migration chains, duplicate data owners, obsolete schema
  objects, unused functions, or historical implementation artifacts.
- When a contract changes, remove its superseded producers, consumers, types,
  tests, and documentation together. Do not preserve code solely for old callers
  or old stored data unless the user explicitly requests compatibility.
- A clean schema reset is acceptable when explicitly authorized; do not add
  compatibility scaffolding instead. Preserve current supported behavior and
  verify automatic first-run synchronization after the reset.

# Package feeds

This repository is developed on a company-protected machine. Public/default npm
and Python package registries are not permitted and may trigger Microsoft Defender.

- Use only `https://packagefeedproxy.microsoft.io/npm/` for npm registry access.
  Keep the project registry setting and Docker `NPM_CONFIG_REGISTRY` aligned.
- For Python package installation, use
  `pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`.
  Do not use public/default indexes or public extra indexes as fallbacks.
- Apply the same restrictions to subprocesses, containers, CI, and delegated agents.
- Install dependencies only when required by a dependency change or a missing-tool
  failure. Do not probe blocked registries.

# Delegation and questions

- Use GPT-6.1 Sol (`gpt-6.1-sol`) with `xhigh` reasoning effort for every subagent.
- If a user question is necessary, stop and wait for the actual answer. Autopilot
  mode or an unavailable question tool is not permission to assume consent.
