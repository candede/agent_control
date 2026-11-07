# Prompt library

## How to use these prompts

The prompt expresses the company, department, objective, and desired deliverable.
The recommended [skill](./05-ai-agent-skill-design.md) supplies retrieval
procedures and evidence rules; MCP tools perform authorized reads and
server-owned calculations.

Prompt starters for all sixteen scenarios are in
[Adoption use cases](./02-adoption-use-cases.md).

Replace placeholders with the intended company, department, and business task.
Do not turn absent evidence into a personal conclusion or a confirmed business
outcome.

## Reusable department-analysis prompt

```text
Act as an enterprise Copilot agent-adoption analyst.

Analyze company [company] and department [department] using the latest
complete saved agent-report set, selected by reporting dates.

Identify:
1. Adoption opportunities among the saved eligible population.
2. Relevant Microsoft and user-created agents.
3. Suggested local peers and their exact used/created agent relationships.
4. Workflows that could transfer to colleagues or comparable departments.

Retrieve complete permitted About descriptions before describing capabilities.
Keep report identities, canonical agent IDs, source memberships, and report
periods distinct. Do not join agents by display name.

Return:
- A concise department activation brief.
- A prioritized action list with owner, target cohort, evidence, next step,
  and proposed success measure.
- Three beginner use-case cards with draft prompts and expected outputs.
- Questions needed to turn candidate workflows into validated case studies.

Label observed usage, declared capabilities, inferred opportunities, and
newly generated prompts separately.

Treat missing, stale, ambiguous, and privacy-withheld evidence explicitly.
Do not claim employees never tried agents, that high usage proves expertise,
or that response counts prove productivity or ROI.

Draft recommendations only. Do not send outreach or change access/settings.
```

For the inspected example:

- Company: `Abu Dhabi Health Services Company - SEHA`.
- Department: `SEHA-Finance - Corporate`.

Use the latest available reporting period for a new analysis rather than copying
an expired read selection from this point-in-time investigation.

## Champion-learning extension

```text
Prepare questions about the actual business problem, anonymized input,
successful prompt, output-review process, common failures, prerequisites,
and measured benefit.

Prefill only what the selected usage and complete permitted descriptions
actually establish. Do not invent these answers from usage counts.

Separate:
- What the reports show.
- What the agent description declares.
- What we propose to try.
- What the contributor needs to confirm.

Use only permitted returned corporate contacts. Draft an interview brief;
do not contact anyone automatically.
```

Useful questions include:

1. What task did the agent help you complete?
2. What input did you provide, and can an appropriate anonymized example be
   shared?
3. What prompt worked, and what did you change when it did not?
4. What does a good output look like?
5. What review or verification is necessary?
6. What failures or limitations should a beginner know?
7. What real data access or prerequisites apply?
8. What benefit was observed, and how was it measured?
9. Which colleagues or functions could use the same workflow?

This contribution improves learning and outcome claims. It is not an approval
prerequisite for normal agent use.

## Example first exercise

This is a newly drafted exercise, not an observed employee prompt or a verified
capability test. It is based on the SEHA Budget Assistant's declared About text.

```text
Using only your configured, authorized FY27 knowledge, compare actual results
with budget for [facility] and [period].

Show:
- The source values and references.
- Explicit units.
- Absolute variance and, where valid, percentage variance.
- The direction and interpretation of each variance.
- Concise draft management commentary.

Make assumptions and missing evidence explicit. Do not invent figures or
interpret a result beyond the available source. Identify calculations and
conclusions that need human review.
```

The declared agent knowledge is a specific FY27 workbook. Do not assume this
agent can accept a different knowledge source or that another entity has access
to the same data. A general Microsoft agent may be a better candidate for a
different authorized dataset, depending on its verified capabilities and access.

## Recommended response structure

1. Evidence context and coverage.
2. Department activation summary.
3. Prioritized action list.
4. Beginner use-case cards.
5. Peer-learning questions.
6. Proposed measurement.
7. Unknowns, access/context caveats, and source provenance.

Source errors should retain their code, request ID when returned, retry timing,
and partial evidence. A prompt must not instruct the agent to conceal failures,
silently switch periods, invent missing values, or bypass authorization.
