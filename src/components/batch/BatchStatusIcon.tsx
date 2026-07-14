import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import type { BatchProgress } from "@/pipeline";

/** Row icon by status, with an honest colour per state. */
export function BatchStatusIcon({
  status,
}: {
  status: BatchProgress["items"][number]["status"];
}) {
  switch (status) {
    case "queued":
      return <div className="size-2 rounded-full bg-muted-foreground/40" />;
    case "processing":
      return <Loader2 className="size-4 animate-spin text-primary" />;
    case "done":
      return <CheckCircle2 className="size-4 text-primary" />;
    case "failed":
      return <AlertCircle className="size-4 text-destructive" />;
  }
}
