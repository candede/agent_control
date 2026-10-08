import { afterEach, aroundEach, vi } from "vitest";

const browserEnvironment = typeof window !== "undefined";
let cleanup = () => {};
if (browserEnvironment) {
  await import("@testing-library/jest-dom/vitest");
  ({ cleanup } = await import("@testing-library/react"));
}

afterEach(cleanup);

function restoreTestGlobals() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  // Do not run abandoned callbacks: lifecycle tests must advance and assert their own timers.
  vi.useRealTimers();
}

aroundEach(async runTest => {
  if (!browserEnvironment) {
    try {
      await runTest();
    } finally {
      restoreTestGlobals();
    }
    return;
  }
  const href = window.location.href;
  const history = window.history.state;
  const head = document.head.innerHTML;
  const elements = [document.documentElement, document.head, document.body];
  const attributes = elements.map(element => [...element.attributes].map(({ name, value }) => [name, value] as const));
  try {
    await runTest();
  } finally {
    try {
      // Also unmount when a suite's teardown throws before reaching afterEach(cleanup).
      cleanup();
    } finally {
      restoreTestGlobals();
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.history.replaceState(history, "", href);
      document.head.innerHTML = head;
      document.body.replaceChildren();
      elements.forEach((element, index) => {
        for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
        for (const [name, value] of attributes[index]) element.setAttribute(name, value);
      });
    }
  }
});