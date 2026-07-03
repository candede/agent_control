# Agent Control

Agent Control is a local Vite + Express app for Microsoft 365 admins who need to review Copilot agents in a tenant and block or unblock them through Microsoft Graph Package Management APIs.

The browser talks only to the Express backend. Express handles Microsoft Entra ID sign-in, keeps the session in an httpOnly cookie, and calls Microsoft Graph on behalf of the signed-in work or school user.

## Prerequisites

- Node.js 22 or newer.
- A Microsoft Entra app registration configured as a web app.
- Microsoft Agent 365 licensing in the tenant.
- Delegated Microsoft Graph permission `CopilotPackages.ReadWrite.All` with admin consent.
- A work or school account with tenant permissions to manage Copilot packages.
- Optional usage enrichment requires access to export Microsoft 365 admin center usage reports, but it does not require any additional Microsoft Graph permissions.

The supplied Microsoft Graph docs note that block and unblock use `/beta` endpoints and are available only in the global cloud.

## Entra App Registration

Create an app registration in Microsoft Entra ID with these settings:

- Platform: Web
- Redirect URI: `http://localhost:3001/auth/callback`
- Client secret: create one and store it only in your local `.env`
- API permissions: Microsoft Graph delegated `CopilotPackages.ReadWrite.All`
- Admin consent: granted for the tenant

No additional API permission is needed for usage report import. The usage data is loaded from CSV files that an admin manually exports from the Microsoft 365 admin center.

## Local Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` with your tenant ID, client ID, client secret, and a long random session secret.

Run both apps:

```bash
npm run dev
```

Then open `http://localhost:5173`.

## Usage Report Import

Agent Control works without report files. If no usage reports are imported, the app lists Copilot packages and supports block/unblock exactly as before.

To enrich the package list and user access view with last activity, active users, responses sent, creator type, and user drilldown data:

1. Go to `https://admin.microsoft.com`.
2. Open **Reports** > **Usage**.
3. Select **Microsoft 365 Copilot**.
4. Open the **Agents** report.
5. Export these three report tabs for the same period, typically 30 days:
   - **Agents**: agent-level metrics used for Agent view enrichment and inactive-agent filtering.
   - **Users & agents**: per-user, per-agent rows used by agent details and User view access history.
   - **Users**: user-level summary rows used by User view summary metrics.
6. In Agent Control, use **Import CSVs** and select one, two, or all three exported CSV files.

The app has two primary views. **Agent view** lists current Copilot packages from the Graph package API, enriched with imported report data when available. **User view** starts with users, then shows every agent access row found for the selected user in the **Users & agents** CSV. The User view combines the **Users** CSV with bridge-only usernames from the **Users & agents** CSV so a user is not hidden just because they are missing from one export.

The **Agents** CSV is the canonical source for agent-level metrics. The **Users & agents** CSV is used for drilldown, User view access history, and as a fallback if the Agents CSV has not been imported. The **Users** CSV is used for user summary context.

The app matches imported report rows to listed packages by `Agent ID`. Report-only rows that do not match a package are shown as unmatched diagnostics and are not blockable. Package rows without imported report data remain visible and manageable.

The inactive filter uses **Last activity date (UTC)** from the imported report. Active user and response counts belong to the selected report period, so an agent can have `0` responses in a 30-day export while still having a known older last activity date. User view includes `0`-response **Users & agents** rows as access history by default and separately shows response-producing agent counts.

## Useful Commands

```bash
npm run build
npm run test
npm run lint
npm run dev --workspace backend
npm run dev --workspace frontend
```

## API Behavior

- `GET /api/agents` lists packages filtered to `supportedHosts` containing `Copilot`.
- `GET /api/agents/:id` gets package details.
- `POST /api/agents/:id/block` blocks one package.
- `POST /api/agents/:id/unblock` unblocks one package.
- `POST /api/agents/block-all` blocks all currently listed unblocked agents.
- `POST /api/agents/unblock-all` unblocks all currently listed blocked agents.

Usage report import is handled in the browser from local CSV files. It does not add backend report endpoints and does not call Microsoft Graph for report data.

Bulk actions are best effort. The backend skips packages already in the requested state and returns succeeded, skipped, and failed entries so partial failures are visible.

## Disclaimer

This project is provided as-is, without warranty of any kind. Use it at your own discretion and validate it in your own environment before relying on it for administrative workflows.

For more information, visit https://candede.com.
