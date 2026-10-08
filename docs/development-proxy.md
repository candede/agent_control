# Optional development proxy

Agent Control works locally at `http://localhost:3001`. A development proxy or
HTTPS tunnel is not required for normal setup.

Use a proxy only when another device or a remote integration must reach the
local application.

## Configure a proxy

1. Start Agent Control locally.
2. Create an HTTPS proxy or tunnel to the configured local port.
3. Run:

   ```powershell
   pwsh ./deploy-local.ps1 edit-config
   ```

4. Set the proxy's HTTPS origin as the public URL.
5. In every Entra app registration used by this installation, add a **Web**
   redirect URI using the same origin:

   ```text
   https://<proxy-host>/api/auth/callback
   ```

6. Start Agent Control again:

   ```powershell
   pwsh ./deploy-local.ps1 start
   ```

Open the proxy URL and verify sign-in. The public URL and Entra redirect URI
must match exactly.

## Return to localhost

Run `edit-config`, clear the public URL, and start Agent Control again. Keep this
local redirect URI registered:

```text
http://localhost:3001/api/auth/callback
```

Use the selected local port instead of `3001` when the setup wizard is configured
with another port.
