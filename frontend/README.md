# Agent Control

## Quick Brief

Agent Control is a local admin app for reviewing Microsoft 365 Copilot agents in a tenant and blocking or unblocking them with Microsoft Graph. It includes a Vite React frontend and an Express backend. The frontend provides the admin interface, while the backend handles Microsoft Entra ID sign-in, session cookies, and Microsoft Graph Package Management calls.

This app requires an Agents 365 license in the tenant. Without the required tenant licensing and Microsoft Graph permission, the app cannot list or manage Copilot agent packages.

## What This App Does

Agent Control helps Microsoft 365 administrators manage Copilot agent availability from a local browser experience. After sign-in, the app lists Copilot-supported packages from Microsoft Graph and shows useful package details such as name, publisher, description, supported hosts, version, and blocked status.

Admins can use the app to:

- Sign in with a work or school account through Microsoft Entra ID.
- View Copilot agents available in the tenant.
- Search and filter agents by name, description, publisher, host, ID, or blocked state.
- Block or unblock a single Copilot agent.
- Select multiple agents and run bulk block or unblock actions.
- Review bulk action results, including succeeded, skipped, and failed packages.

The browser does not call Microsoft Graph directly. It calls the local Express backend, and the backend calls Microsoft Graph on behalf of the signed-in user.

## Requirements

- Node.js 24 or newer.
- An Agents 365 license in the Microsoft 365 tenant.
- A Microsoft Entra ID app registration.
- Microsoft Graph delegated permission `CopilotPackages.ReadWrite.All` with admin consent.
- A work or school account that has permission to manage Copilot packages in the tenant.
- Correct local environment values in `.env` before starting the backend.

## Microsoft Entra ID App Registration

Register an application in Microsoft Entra ID before running the app.

Use these settings:

- Platform type: Web.
- Redirect URI: `http://localhost:3001/api/auth/callback`.
- Client secret: create a client secret and keep it private.
- API permission: Microsoft Graph delegated `CopilotPackages.ReadWrite.All`.
- Admin consent: grant tenant-wide admin consent for the delegated permission.

The backend also requests standard sign-in scopes such as `openid`, `profile`, `offline_access`, and `User.Read` so it can authenticate the user and keep the session active.

## Environment Setup

Create a `.env` file before starting the backend. You can copy the sample file from the repo root:

```bash
cp .env.example .env
```

Enter the correct values for your tenant and app registration:

```env
TENANT_ID=your-tenant-id
CLIENT_ID=your-entra-app-client-id
CLIENT_SECRET=your-entra-app-client-secret
SESSION_SECRET=use-a-long-random-value
REDIRECT_URI=http://localhost:3001/api/auth/callback
FRONTEND_ORIGIN=http://localhost:5173
PORT=3001
```

The backend reads `.env` from either the repo root or the `backend` folder. Make sure the values are correct before starting the backend, especially `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `REDIRECT_URI`, and `FRONTEND_ORIGIN`.

## Install Dependencies

From the repo root, install all workspace dependencies:

```bash
npm install
```

## Start the Backend

Open a terminal and start the backend:

```bash
cd backend
npm run dev
```

By default, the backend runs on `http://localhost:3001`.

## Start the Frontend

Open a second terminal and start the frontend:

```bash
cd frontend
npm run dev
```

By default, the frontend runs on `http://localhost:5173`.

For local testing, use `npm run dev` in both folders and keep both terminals running. The frontend depends on the backend for sign-in, session state, and all Copilot package actions.

## How To Use The App

1. Start the backend from the `backend` folder with `npm run dev`.
2. Start the frontend from the `frontend` folder with `npm run dev`.
3. Open `http://localhost:5173` in a browser.
4. Sign in with a work or school account from the tenant that has the Agents 365 license.
5. Review the Copilot agent list after the app loads package data from Microsoft Graph.
6. Use search, publisher filtering, and blocked status filtering to find agents.
7. Use the action button on a row to block or unblock one agent.
8. Select multiple rows to run a bulk block or unblock action.
9. Review the result summary after bulk actions. Packages that already matched the target state are skipped.
10. Sign out when finished.

## Notes

- The app is intended for local admin use during development or tenant administration workflows.
- Microsoft Graph package block and unblock operations depend on Graph API availability and tenant licensing.
- If sign-in fails, confirm the redirect URI in Entra ID matches `REDIRECT_URI` in `.env`.
- If package listing or block/unblock fails, confirm the app registration has delegated `CopilotPackages.ReadWrite.All` and admin consent has been granted.

## Disclaimer

This project is provided as-is, without warranty of any kind. Use it at your own discretion and validate it in your own environment before relying on it for administrative workflows.

For more information, visit https://candede.com.
