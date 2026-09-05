import { redirect } from "next/navigation";

// The temporary `/canvas?room=<id>` dev entry is gone — boards now live at
// /room/[slug]. Redirect any stale links to the rooms list.
export default function CanvasPage() {
  redirect("/rooms");
}
