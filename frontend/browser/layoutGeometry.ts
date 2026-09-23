export function collectLayoutFailures({ fields }: { fields: string[] }) {
  const failures: string[] = [];
  const tolerance = 1.5; // Fractional tracks and device-pixel rounding.
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.checkVisibility({ visibilityProperty: true });
  };
  const name = (element: Element) => element.getAttribute("aria-label")
    ?? element.closest("label")?.textContent?.trim().replace(/\s+/g, " ").slice(0, 70)
    ?? `${element.tagName.toLowerCase()}.${Array.from(element.classList).join(".")}`;
  const contained = (child: Element, parent: Element) => {
    const a = child.getBoundingClientRect(), b = parent.getBoundingClientRect();
    if (a.left < b.left - tolerance || a.right > b.right + tolerance
      || a.top < b.top - tolerance || a.bottom > b.bottom + tolerance) {
      failures.push(`${name(child)} is outside ${name(parent)}`);
    }
  };
  const doNotIntersect = (elements: Element[], group: string) => {
    for (let i = 0; i < elements.length; i++) {
      for (let j = i + 1; j < elements.length; j++) {
        const a = elements[i].getBoundingClientRect(), b = elements[j].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance) {
          failures.push(`${group}: ${name(elements[i])} intersects ${name(elements[j])}`);
        }
      }
    }
  };
  const equalWidth = (elements: Element[], group: string) => {
    // Wide search fields and full-row timestamps/lineage are deliberate spans.
    const widths = elements.filter(element => {
      const css = getComputedStyle(element);
      return !element.classList.contains("filter-search")
        && !element.matches(".usage-agent-filters > label:first-child")
        && ![css.gridColumnStart, css.gridColumnEnd].some(value => value.includes("span") || value === "-1");
    }).map(element => element.getBoundingClientRect().width);
    if (widths.length > 1 && Math.max(...widths) - Math.min(...widths) > tolerance) {
      failures.push(`${group} has unequal field/card widths: ${widths.map(value => value.toFixed(1)).join(", ")}`);
    }
  };
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth + tolerance) {
    failures.push(`Document overflows: ${root.scrollWidth}px > ${root.clientWidth}px`);
    const overflowing = Array.from(document.querySelectorAll(".report-section-header, .report-header-actions, .report-window-control"))
      .filter(element => element.getBoundingClientRect().right > root.clientWidth + tolerance);
    failures.push(...overflowing.map(element => `${name(element)} extends to ${element.getBoundingClientRect().right.toFixed(1)}px`));
  }
  const shell = document.querySelector(".app-shell")!;
  const bounds = shell.getBoundingClientRect(), style = getComputedStyle(shell);
  if (Math.abs(bounds.left) > tolerance || Math.abs(bounds.width - root.clientWidth) > tolerance) {
    failures.push(`Authenticated shell does not use the viewport: x=${bounds.left}, width=${bounds.width}, viewport=${root.clientWidth}`);
  }
  const left = parseFloat(style.paddingLeft), right = parseFloat(style.paddingRight);
  if (left <= 0 || right <= 0 || Math.abs(left - right) > tolerance) failures.push("App must retain balanced outer padding");
  const header = shell.querySelector(".top-bar")!.getBoundingClientRect();
  if (Math.abs(header.left - bounds.left - left) > tolerance || Math.abs(header.right - (bounds.right - right)) > tolerance) {
    failures.push("Header does not fill the padded app content width");
  }
  for (const child of Array.from(shell.children).filter(visible)) contained(child, shell);
  const surfaces = [
    ".catalog-controls", ".agent-summary-grid", ".inventory-view", ".copilot-users",
    ".data-sync-panel", ".audit-source-view", ".defender-hunting", ".permission-center", ".jobs-view",
  ];
  for (const surface of Array.from(shell.querySelectorAll(surfaces.join(", "))).filter(visible)) {
    const rect = surface.getBoundingClientRect();
    if (Math.abs(rect.left - header.left) > tolerance || Math.abs(rect.right - header.right) > tolerance) {
      failures.push(`${name(surface)} does not fill the padded app content width`);
    }
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const footerEmail = document.querySelector(".app-footer-email");
  if (footerEmail && footerEmail.getBoundingClientRect().height > parseFloat(getComputedStyle(footerEmail).lineHeight) + tolerance) {
    failures.push("Footer email breaks mid-address instead of wrapping the surrounding credit text");
  }
  for (const selector of fields) {
    const grids = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (!grids.length) {
      failures.push(`Missing visible field group: ${selector}`);
      continue;
    }
    for (const grid of grids) {
      const labels = Array.from(grid.querySelectorAll(":scope > label")).filter(visible);
      if (!labels.length) failures.push(`No fields checked in ${selector}`);
      labels.forEach(label => contained(label, grid));
      doNotIntersect(labels, selector);
      equalWidth(labels, selector);
      const controls = labels.flatMap(label => Array.from(label.querySelectorAll("input, select, textarea"))).filter(visible);
      doNotIntersect(controls, selector);
      for (const control of controls) {
        const label = control.closest("label")!;
        contained(control, label);
        const css = getComputedStyle(control);
        const rect = control.getBoundingClientRect();
        const inputType = control instanceof HTMLInputElement ? control.type : "";
        context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
        // Native selects may abbreviate a long saved-snapshot description. They
        // still need room for its widest rendered word, rather than a collapsed sliver.
        const text = control instanceof HTMLSelectElement
          ? (control.selectedOptions[0]?.textContent ?? "").split(/\s+/)
          : [inputType === "datetime-local" ? "09/12/2026, 10:00:00 AM"
            : inputType === "date" ? "09/12/2026" : ""];
        const textWidth = Math.max(...text.map(value => context.measureText(value).width));
        // Native date/select affordances need space in addition to the displayed value.
        const needed = textWidth + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight)
          + (textWidth ? parseFloat(css.fontSize) * 1.5 : 0);
        if (textWidth && rect.width + tolerance < needed) {
          failures.push(`${name(control)} is too narrow for its displayed value (${rect.width.toFixed(1)}px, needs ${needed.toFixed(1)}px)`);
        }
        if (control.parentElement === label && Math.abs(rect.width - label.getBoundingClientRect().width) > tolerance) {
          failures.push(`${name(control)} does not fill its field`);
        }
        if (control.clientWidth && control.scrollWidth > control.clientWidth + tolerance && inputType !== "search") {
          failures.push(`${name(control)} clips its contents`);
        }
      }
    }
  }
  const equalGrids = [
    ".summary-grid", ".official-usage-lineage",
    ".hunting-readiness", ".hunting-result-facts", ".purview-result-facts",
  ];
  for (const selector of equalGrids) {
    for (const grid of Array.from(document.querySelectorAll(selector)).filter(visible)) {
      const children = Array.from(grid.children).filter(visible);
      children.forEach(child => contained(child, grid));
      doNotIntersect(children, selector);
      equalWidth(children, selector);
      if (selector === ".summary-grid" && children.length) {
        const css = getComputedStyle(grid);
        const contentRight = grid.getBoundingClientRect().right - parseFloat(css.paddingRight) - parseFloat(css.borderRightWidth);
        if (contentRight - Math.max(...children.map(child => child.getBoundingClientRect().right)) > tolerance) {
          failures.push(`${name(grid)} leaves an unused metric column`);
        }
      }
    }
  }
  for (const gate of Array.from(document.querySelectorAll(".capability-gate")).filter(visible)) {
    const button = gate.querySelector(":scope > button");
    const explanation = gate.querySelector(":scope > .gate-explanation");
    if (!button || !explanation || !visible(explanation)) continue;
    contained(button, gate);
    contained(explanation, gate);
    if (button.classList.contains("control-icon-button")
      && Math.abs(button.getBoundingClientRect().left - gate.getBoundingClientRect().left) > tolerance) {
      failures.push(`${name(button)} is detached from the start of its capability explanation`);
    }
    if (explanation.getBoundingClientRect().top < button.getBoundingClientRect().bottom - tolerance) {
      failures.push(`${name(button)} overlaps its degraded-capability explanation`);
    }
  }
  for (const cell of Array.from(document.querySelectorAll(".inventory-table td")).filter(visible)) {
    const title = cell.querySelector(":scope > strong");
    const identity = cell.querySelector(":scope > small");
    if (title && identity && identity.getBoundingClientRect().top < title.getBoundingClientRect().bottom - tolerance) {
      failures.push("Inventory resource name and native ID run together instead of occupying separate lines");
    }
  }
  for (const selector of [".filter-action-buttons", ".inventory-actions", ".inline-actions", ".purview-search-actions", ".hunting-search-actions", ".report-section-header", ".report-header-actions", ".report-window-control"]) {
    for (const group of Array.from(document.querySelectorAll(selector)).filter(visible)) {
      const children = Array.from(group.children).filter(visible);
      children.forEach(child => contained(child, group));
      doNotIntersect(children, selector);
      for (const gate of children.filter(child => child.classList.contains("capability-gate"))) {
        const gateButton = gate.querySelector(":scope > button");
        if (!gateButton) continue;
        for (const peer of children.filter(child => child !== gate && child.matches("button, a, .capability-gate"))) {
          const peerButton = peer.matches("button, a") ? peer : peer.querySelector(":scope > button");
          if (!peerButton) continue;
          const a = gate.getBoundingClientRect(), b = peer.getBoundingClientRect();
          if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance
            && Math.abs(gateButton.getBoundingClientRect().top - peerButton.getBoundingClientRect().top) > tolerance) {
            failures.push(`${selector}: ${name(gateButton)} is vertically misaligned with ${name(peerButton)}`);
          }
        }
      }
    }
  }
  for (const progress of Array.from(document.querySelectorAll(".job-progress")).filter(visible)) {
    const labels = Array.from(progress.children).filter(visible);
    labels.forEach(label => contained(label, progress));
    doNotIntersect(labels, "Job progress metadata");
  }
  // Wide evidence tables may scroll locally; their containing surface must not escape the grid.
  const tableShells = ".table-shell, .copilot-users-table-shell, .permission-table-scroll, .jobs-table-scroll";
  for (const table of Array.from(document.querySelectorAll(tableShells)).filter(visible)) {
    contained(table, table.parentElement!);
    if (table.scrollWidth > table.clientWidth + tolerance && !["auto", "scroll"].includes(getComputedStyle(table).overflowX)) {
      failures.push(`${name(table)} has wide data without a local horizontal scroller`);
    }
  }
  return failures;
}
