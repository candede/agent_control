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

- Use GPT-6 Astra with `xhigh` reasoning effort for every subagent.
- If a user question is necessary, stop and wait for the actual answer. Autopilot
  mode or an unavailable question tool is not permission to assume consent.
