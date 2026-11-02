# Optional development proxy

Agent Control defaults to `http://localhost:3001`; a proxy is optional, for remote
access only. Complete [local setup](deployment-setup.md) and verify local sign-in
first. Run commands from the repository root with PowerShell 7 and Docker/Compose
running. Add the same `-Project <name>` to each deployment command for a named project.

## Configure a proxy

1. Forward HTTPS to `http://127.0.0.1:3001`, substituting the saved **Local port**.
   Use one controlled proxy hop, preserve browser `Host` and `Origin`, and send
   `X-Forwarded-Proto: https`. For an existing Dev Tunnel with that port and its CLI:

   ```powershell
   devtunnel port update YOUR_TUNNEL_ID -p 3001 --host-header unchanged --origin-header unchanged
   devtunnel host YOUR_TUNNEL_ID --host-header unchanged --origin-header unchanged
   ```

2. Run:

   ```powershell
   pwsh ./deploy-local.ps1 edit-config
   ```

   Keep other values; set **Public URL** to the canonical HTTPS origin only
   (no trailing slash, path, query or fragment).
3. In each configured tenant's Agent Control Web app registration, add
   `https://<proxy-host>/api/auth/callback` as a **Web** redirect URI.
4. Apply the saved configuration:

   ```powershell
   pwsh ./deploy-local.ps1 start
   ```

The wizard generates `FRONTEND_ORIGIN`, `REDIRECT_URI` and `TRUST_PROXY=1`.
Open `https://<proxy-host>/api/auth/status`: expect `authConfigured: true` and
the exact registered `callback`. Then verify sign-in, sign-out and sign-in again
at the proxy origin. Startup checks local readiness, not tunnel reachability.

## Return to localhost

Run `pwsh ./deploy-local.ps1 edit-config`; enter `local` at **Public URL**
(Enter keeps the proxy). Keep `http://localhost:3001/api/auth/callback`
registered, substituting the saved port, then run:

```powershell
pwsh ./deploy-local.ps1 start
```

Verify local sign-in again; the wizard restores `TRUST_PROXY=0`.
