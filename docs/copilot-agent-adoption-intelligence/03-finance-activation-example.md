# Finance activation example

## Observation context

This example uses the saved evidence inspected on November 7, 2026 (+04:00):

- Agent-report observed range: **October 1-30, 2026**.
- Office D28 window: **October 8-November 4, 2026**.
- Directory and Office cohorts are saved evidence, not complete departmental
  headcounts.

The different windows support targeting hypotheses, not proof of never having
tried agents.

## Candidate groups

| Company / department | Paid cohort | Office-active paid users | Reported paid agent users |
| --- | ---: | ---: | ---: |
| Abu Dhabi Health Services Company - SEHA / SEHA-Finance - Corporate | 22 | 22 | 7 |
| SEHA Shared Services / SSS-Financial Accounting - Finance & Accounting | 28 | 23 | 0 |
| Sheikh Shakhbout Medical City / Financial Planning & Analysis | 12 | 12 | 1 |
| SEHA CLINICS / AHS-Finance | 17 | 15 | 3 |

For groups other than Corporate Finance, do not subtract the Office and agent
counts to claim an exact overlap without checking the underlying identities.

## Why Corporate Finance is a useful first pilot

The group has:

- **23 saved directory members**, including 22 paid users.
- **7 reported agent users**, using **10 distinct agents**.
- **15 paid, Office-active colleagues without agent activity in the selected
  report**.
- Three suggested champions with **11 created-agent relationships** collectively.
- A complete champion lookup containing **19 used/created relationships across
  15 distinct agents**.

The champion knowledge portfolio is richer than the department's used-agent list
alone. However, creation does not establish successful use, and a usage-based
champion suggestion is not proof of expertise or an assigned role.

The three suggestions have observed user-response totals of 66, 27, and 21 and
distinct positively used-agent counts of 2, 3, and 3. Their created-agent counts
are 2, 5, and 4. The lookup retained the exact top-three group selection rather
than substituting all department agents.

## Candidate workflows to introduce

These are **declared capabilities plus proposed exercises**, not verified
accounts of what employees accomplished.

| Agent | Evidence-backed positioning | Potential first exercise |
| --- | --- | --- |
| **SEHA Budget Assistant** | About describes FY27 budget, forecast, actuals, payer revenue, volume, manpower, and facility comparisons using `FY27_Budget_Agent_Knowledge.xlsx`. The selected report shows 12 responses from one user. | Produce a budget-versus-actual comparison with units, calculations, and management commentary. |
| **Budget Assistant Test** | About describes budgeting, FP&A, variance analysis, forecasting, and management insights. The selected report shows 54 responses from one user. | Explain an actual-versus-budget variance and identify questions for follow-up. |
| **Microsoft Analyst** | About describes multi-step analysis and code execution over datasets. The organization-wide selected report shows 48 users and 556 responses, not Finance-only counts. | Explore an authorized dataset and explain the analytical approach. |
| **Microsoft Excel agent** | About describes creating workbooks, structures, and working formulas. | Create a budget-tracking workbook from a written specification. |
| **Email Action Brief** | About describes extracting commitments, decisions, owners, deadlines, and follow-ups. | Turn an authorized email thread into a reviewable action list. |
| **Microsoft Word / PowerPoint agents** | About describes document and presentation creation. | Turn reviewed findings into a management brief or presentation. |
| **Microsoft Prompt Coach** | About describes creating and improving prompts. | Improve a beginner's analytical prompt before trying it. |

The department's ten used agents include five Microsoft agents, four user-created
agents, and one third-party agent. Microsoft and local agents with the same
display name must be distinguished through exact identities and origin evidence.

## Proposed adoption-team action list

| Owner | Proposed action | Benefit / follow-up |
| --- | --- | --- |
| Adoption lead | Introduce a three-agent Finance starter pack to the 15 warm candidates | Provide a specific starting task rather than a broad catalog dump |
| Suggested local peers | Demonstrate one budgeting workflow and one general Microsoft-agent workflow | Show locally relevant work and complementary approaches |
| Adoption team | Capture an anonymized worked example, actual prompt, review steps, limitations, and outcome from willing users | Turn candidate workflows into transferable learning cards |
| Function leads | Assess transfer to Financial Accounting and FP&A while preserving entity-specific data access and context | Spread the workflow without blindly copying a data-specific agent |
| Campaign owner | Set a target, for example five additional reported participants in a subsequent comparable report, and track the original cohort | Measure broader participation without claiming causality or guaranteed conversion |

The proposed target is an example, not a forecast, commitment, or acceptance gate.
Changing licenses or group membership must not silently change the interpretation
of the original campaign cohort.

No outreach, access changes, or campaign execution were performed.

## Starter-card structure

> Business problem -> agent -> inputs -> draft prompt -> expected output ->
> review steps -> permitted peer contact -> access/context caveats -> evidence ->
> follow-up measure

### Example card: FY27 variance commentary

- **Business problem:** prepare a clear, reviewable budget-versus-actual
  explanation for a selected facility and period.
- **Candidate agent:** SEHA Budget Assistant.
- **Declared input context:** its configured FY27 knowledge workbook; the
  investigation did not inspect that workbook's business contents or establish
  personal access.
- **Expected output:** a table of budget/actual values, explicit units and
  variance direction, source references, and concise draft commentary.
- **Review steps:** validate calculations, period, facility, units, interpretation,
  and source coverage.
- **Peer help:** use only contacts permitted by the caller's returned data and
  privacy policy.
- **Evidence:** complete Graph About text and the exact selected report
  relationship, not a guessed name match.
- **Success measure:** a completed, reviewed first exercise plus later observed
  participation or appropriate feedback.

See the [example prompt](./04-prompt-library.md#example-first-exercise).

## Data and access boundaries

- The saved agent was published, not blocked, and administratively available to
  all users. These facts do not prove effective personal access to the agent or
  its knowledge source.
- Do not require a new owner approval, interview, or use-case certification before
  normal supported discovery and use.
- If a real permission or provider limitation appears, explain that specific
  limitation. Do not invent restrictions from incomplete telemetry.
- Use anonymized or otherwise appropriate authorized examples. Clinical or
  personal information is not needed for this Finance adoption exercise.
