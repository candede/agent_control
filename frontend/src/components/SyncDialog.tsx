import type { ComponentProps } from "react";
import { WorkbenchDialog } from "./WorkbenchDialog";

export function SyncDialog(props: ComponentProps<typeof WorkbenchDialog>) {
  return <WorkbenchDialog {...props} className={`sync-dialog ${props.className ?? ""}`} />;
}
