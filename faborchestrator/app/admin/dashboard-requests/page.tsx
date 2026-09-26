import { redirect } from "next/navigation";

/**
 * The request queue now lives on the Dashboards page (Requests tab). The
 * detail route /admin/dashboard-requests/[id] is unchanged and still linked
 * from Fab Orchestrator's admin emails.
 */
export default function DashboardRequestsPage() {
  redirect("/admin/dashboards?tab=requests");
}
