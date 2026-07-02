# Agent Control

Agent Control is a local Vite + Express app for Microsoft 365 admins who need to review Copilot agents in a tenant and block or unblock them through Microsoft Graph Package Management APIs.

The browser talks only to the Express backend. Express handles Microsoft Entra ID sign-in, keeps the session in an httpOnly cookie, and calls Microsoft Graph on behalf of the signed-in work or school user.

## Prerequisites

- Node.js 22 or newer.
- A Microsoft Entra app registration configured as a web app.
- Microsoft Agent 365 licensing in the tenant.
- Delegated Microsoft Graph permission `CopilotPackages.ReadWrite.All` with admin consent.
- A work or school account with tenant permissions to manage Copilot packages.

The supplied Microsoft Graph docs note that block and unblock use `/beta` endpoints and are available only in the global cloud.

## Entra App Registration

Create an app registration in Microsoft Entra ID with these settings:

- Platform: Web
- Redirect URI: `http://localhost:3001/auth/callback`
- Client secret: create one and store it only in your local `.env`
- API permissions: Microsoft Graph delegated `CopilotPackages.ReadWrite.All`
- Admin consent: granted for the tenant

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

Bulk actions are best effort. The backend skips packages already in the requested state and returns succeeded, skipped, and failed entries so partial failures are visible.
