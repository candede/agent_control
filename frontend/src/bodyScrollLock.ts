const bodyScrollLocks = new WeakMap<HTMLElement, { count: number; previousOverflow: string }>();

export function lockBodyScroll(body: HTMLElement) {
  const lock = bodyScrollLocks.get(body) ?? { count: 0, previousOverflow: body.style.overflow };
  bodyScrollLocks.set(body, lock);
  lock.count += 1;
  body.style.overflow = "hidden";
  return () => {
    lock.count -= 1;
    if (lock.count === 0) {
      body.style.overflow = lock.previousOverflow;
      bodyScrollLocks.delete(body);
    }
  };
}
