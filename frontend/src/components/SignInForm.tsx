import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { startSignIn } from "../api/client";
import { isWorkbenchPath } from "../workbenchRouting";

const usernameStorageKey = "agent-control:signin-username:v1";

function validUsername(value: string) {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function readRememberedUsername(): { username: string; remember: boolean; error?: string } {
  try {
    const saved = window.localStorage.getItem(usernameStorageKey);
    if (saved === null || saved === "") return { username: "", remember: saved === null };
    if (saved === saved.trim() && validUsername(saved)) return { username: saved, remember: true };
    return { username: "", remember: true, error: "The saved email is not valid. Enter your work or school email again." };
  } catch {
    return {
      username: "", remember: false,
      error: "Browser storage is unavailable. You can still sign in, but your email cannot be remembered.",
    };
  }
}

function storeRememberedUsername(value: string | null) {
  try {
    // An empty value retains the opt-out; a missing value uses the default preference.
    if (value === null) window.localStorage.removeItem(usernameStorageKey);
    else window.localStorage.setItem(usernameStorageKey, value);
    return undefined;
  } catch {
    const message = "Your browser could not update the remembered email. You can still sign in. On a shared device, clear this site's browser data to remove any previously saved email.";
    console.warn(message);
    return message;
  }
}

export function SignInForm({ disabled }: { disabled: boolean }) {
  const [initialPreference] = useState(readRememberedUsername);
  const [username, setUsername] = useState(initialPreference.username);
  const [remember, setRemember] = useState(initialPreference.remember);
  const [storageError, setStorageError] = useState(initialPreference.error);
  const [validationError, setValidationError] = useState<string>();
  const [signInError, setSignInError] = useState<string>();
  const [pending, setPending] = useState(false);
  const usernameInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);

  async function handleSubmit() {
    if (disabled || request.current) return;
    const value = username.trim();
    setSignInError(undefined);
    if (!validUsername(value)) {
      setValidationError("Enter your work or school username, such as name@organization.com.");
      usernameInput.current?.focus();
      return;
    }
    setValidationError(undefined);
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    const search = new URLSearchParams(window.location.search);
    search.delete("authorization");
    search.delete("returnTo");
    const returnTo = isWorkbenchPath(window.location.pathname) && !window.location.pathname.startsWith("//")
      ? `${window.location.pathname}${search.size ? `?${search}` : ""}` : "/agents";
    try {
      const { authorizationUrl } = await startSignIn({ username: value, returnTo }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      // Keep the accepted routing hint, not an Entra account alias that may use a different domain.
      if (remember) setStorageError(storeRememberedUsername(value));
      window.location.assign(authorizationUrl);
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setSignInError(requestError instanceof Error ? requestError.message : "Unable to start sign-in. Please try again.");
      setPending(false);
      request.current = undefined;
    }
  }

  return (
    <form className="signin-form" aria-label="Sign in" aria-busy={pending} noValidate onSubmit={event => {
      event.preventDefault();
      void handleSubmit();
    }}>
      <div className="signin-field">
        <label htmlFor="signin-username">Work or school username</label>
        <input
          ref={usernameInput}
          id="signin-username"
          name="username"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={320}
          placeholder="name@organization.com"
          required
          disabled={disabled || pending}
          aria-invalid={Boolean(validationError)}
          aria-describedby={`signin-hint${validationError || signInError ? " signin-error" : ""}`}
          value={username}
          onChange={event => {
            setUsername(event.target.value);
            setValidationError(undefined);
            setSignInError(undefined);
          }}
        />
        <p id="signin-hint" className="signin-hint">
          You&apos;ll continue to Microsoft to sign in.
        </p>
      </div>
      <div className="signin-preference">
        <label className="signin-remember" htmlFor="signin-remember">
          <input
            id="signin-remember"
            type="checkbox"
            checked={remember}
            disabled={disabled || pending}
            aria-describedby="signin-remember-hint"
            onChange={event => {
              const checked = event.target.checked;
              setRemember(checked);
              setStorageError(storeRememberedUsername(checked ? null : ""));
            }}
          />
          Remember my email on this browser
        </label>
        <p id="signin-remember-hint" className="signin-hint">
          Not recommended on shared devices. This does not keep you signed in.
        </p>
      </div>
      {storageError ? <p className="signin-storage-notice" role="status">{storageError}</p> : null}
      {validationError || signInError ? <div id="signin-error" className="error-banner" role="alert">{validationError ?? signInError}</div> : null}
      <button className="signin-button" type="submit" disabled={disabled || pending}>
        {pending ? "Preparing sign-in..." : "Sign in with Entra ID"}
        <ArrowRight size={17} aria-hidden="true" />
      </button>
      {pending ? <p className="signin-hint" role="status">Preparing Microsoft sign-in...</p> : null}
    </form>
  );
}
