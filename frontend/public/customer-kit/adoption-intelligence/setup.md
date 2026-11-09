# Install and verify the customer kit

Checked official public documentation on **2026-11-08**. Documentation support
is not actual interoperability proof for your selected harness/build.

| Host | Documented installation | Verification boundary |
| --- | --- | --- |
| Studio standard harness | Existing MCP tools/resources via Streamable HTTP; OAuth 2.0 Dynamic discovery. Overview > Instructions > Edit: general plus staff or employee instructions and the relevant procedure/evidence/output text. | This MCP article concerns standard harness; native SKILL.md import not established there. Use instruction-only equivalent, not an invented protocol skill loader. |
| Studio GitHub Copilot harness | Build > Skills > Add skill > Upload a skill: Markdown or ZIP containing SKILL.md and optional supporting files. Upload this ZIP with its resolving files. | Documented native import; verify files loaded and skill invoked in your actual agent. Not a claim the GitHub Copilot service processes Studio customer data. |
| Studio Customer Conversation harness | Add skill > Generative skill authored Markdown, or Topic authored flow. Use the same relevant instruction/procedure text. | Different authoring model; this review does not verify ZIP/file import for this harness. |
| VS Code/Copilot CLI file skills | Extract adoption-intelligence folder into a supported project `.github/skills/` or `.agents/skills/` location. Keep SKILL.md and all sibling references. | Verify the skill appears and is invoked in the actual host. Protocol prompts/resources alone do not load skills. |
| Other MCP clients | Configure native remote MCP and place general plus audience instructions in that host's supported instruction field; provide relevant evidence/recipes/templates as supported files/context. | No blanket file import or OAuth compatibility claim. |

## Per-user connection

The web application's **MCP settings > MCP Server Setup** section provides verified,
copy-ready text from this package. The [MCP server description](./server-description.md)
belongs in the connector wizard's **Server description** field. The
[general agent system instructions](./general.md) belong in the consuming AI
agent's instruction field, not in the server description. Add the relevant
staff or employee guidance for a focused agent; skill installation is optional.
These setup templates are separate from the exact instructions advertised by
the running MCP server.

1. Obtain the current non-secret public MCP resource from authorized browser setup,
   not from this generic kit: `https://<your-mcp-host>/mcp`, including exact path.
   Use Streamable HTTP, not `/sse`, the web API URL or an invented proxy.
2. In Studio Tools > Add a tool > New tool > Model Context Protocol, configure
   OAuth 2.0 > Dynamic discovery. Authenticate as the actual individual. Do not
   use None/API key or paste the server Entra secret/token into chat.
3. Keep URL roles distinct: Entra-to-server Web callback is
   `https://<your-mcp-host>/auth/callback`; server-to-client callback is the exact
   connector-generated URI. Have the existing operator allowlist that exact
   emitted callback, retaining existing entries; no guessed/wildcard callback.
   Dynamic discovery may require the connector Security tab or sanitized rejected
   redirect diagnostics to obtain it.
4. Bind each employee experience to that employee's own connection, not a shared
   staff/Admin author connection. Actual connection identity, not instruction
   claims, determines tool scope. Consent, host orchestration configuration,
   licensing and publication are genuine host requirements, not app-owned gates.
5. In Studio standard harness, open **Overview > Instructions > Edit** and paste
   the general agent system instructions plus the relevant audience guidance.
   Other hosts use their supported agent/system instruction field.
   Install the focused skill where
   supported or its relevant instruction-only equivalent. Refresh tool discovery
   after guidance changes; do not copy tokens, delete OAuth caches or rotate keys.
6. Test a read-only task from prompts.json in author test chat. Inspect actual tool
   requests/results, exact source states, full paging and output checklist.
   An initialize handshake or keyword match is not semantic workflow proof.
7. Publish the updated agent through the selected host's supported Publish/channel
   flow. In Teams/Microsoft Copilot, install/share through real host controls.
   Verify a published employee's own connection and safe first task separately.
   Author test chat never proves published end-user privacy or refresh.
8. Record host/build/harness/model as actually observed, connection audience,
   kit SHA-256 version, task, calls/bytes/time and every failed attempt.
   If no authorized client session/model is available, report unavailable and
   resume with that existing signed-in host; do not provision paid models.

## Official sources

- [MCP integration](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp)
- [MCP OAuth onboarding](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent)
- [Harnesses](https://learn.microsoft.com/en-us/microsoft-copilot-studio/harnesses-overview)
- [Skills overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/skills-overview)
- [Native uploaded skill formats](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/skills-add-existing)
- [Instructions placement and native source presentation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-instructions)
- [VS Code skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
