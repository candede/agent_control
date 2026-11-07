# Copilot agent adoption intelligence

## Recommendation

Use Agent Control to build a **Department Adoption Advisor**: identify who could
benefit, recommend a specific first task and agent, connect colleagues with a
relevant local peer, and measure whether adoption broadens.

The valuable output is not another leaderboard. It is:

> These colleagues are good candidates for this workflow, using these agents,
> supported by this local peer, for these evidence-backed reasons.

## Contents

| Document | Contents |
| --- | --- |
| [Findings and data opportunities](./01-findings-and-data-opportunities.md) | Observed tenant data, coverage, metadata, and interpretation limits |
| [Adoption use cases](./02-adoption-use-cases.md) | Sixteen use cases, their outputs, adoption benefits, and prompt starters |
| [Finance activation example](./03-finance-activation-example.md) | Actual Finance cohorts, relevant agents, peer-learning opportunities, and proposed actions |
| [Prompt library](./04-prompt-library.md) | Reusable department-analysis prompt, champion-learning extension, and example first exercise |
| [AI agent skill design](./05-ai-agent-skill-design.md) | Recommended skill, tool navigation, evidence rules, and prompt/skill/tool boundaries |
| [MCP improvements and evidence gaps](./06-mcp-improvements-and-evidence-gaps.md) | High-value follow-up improvements and observed reliability/data-quality limitations |

## Investigation scope and date

This collection records the read-only investigation performed on
**November 7, 2026 (+04:00), November 6, 2026 UTC**. It covered:

- The live SEHA Agent Control MCP and its typed tool contracts.
- The locally running Docker PostgreSQL database and current saved evidence.
- Application data and API contracts.
- The existing signed-in Dashboard, Users/adoption, and Agents/About web views.

The figures are **point-in-time observations**, not a live dashboard. Saving these
documents did not refresh the tenant data. No application code, agent controls,
permissions, or tenant settings were changed by the investigation.

These documents are research and recommendations, not an executable
implementation-plan folder or an installed agent skill. Proposed exercises,
targets, and capabilities must not be mistaken for completed business outcomes
or guarantees of personal access.

The collection contains internal tenant-level findings and should be shared only
with an appropriate audience. Person-level names and corporate contacts are not
reproduced here.

## Suggested starting point

Produce three recurring deliverables:

1. **Department activation briefs** with prioritized audiences and next actions.
2. **Peer-derived use-case playbooks** that turn successful work into transferable
   examples.
3. **Office-to-agent starter pathways** that build on existing Copilot familiarity.

The current data already supports substantial value. The biggest missing
ingredient is validated knowledge about successful work, not more usage
counters.
