import { officeApps, type OfficeMetrics } from "../../../backend/src/types/officeAppAdoption";
import { usageCount } from "../usageInsights";

export function OfficeAppBreakdown({ metrics, href }: { metrics?: OfficeMetrics | null; href: (app: typeof officeApps[number]["id"]) => string }) {
  const apps = [...officeApps].sort((a,b)=>(metrics?.perApp[b.id] ?? 0)-(metrics?.perApp[a.id] ?? 0));
  return <ul className="dashboard-departments office-app-breakdown" aria-label="Seven Office app active-user counts">
    {apps.map((app,index) => {
      const percent = metrics?.savedLicensedPeople ? metrics.perApp[app.id]/metrics.savedLicensedPeople*100 : null;
      return <li key={app.id} className={`dashboard-department dashboard-bar-${index%8}`}>
        <a href={href(app.id)}>{app.label}</a>
        <span className="dashboard-department-bar" aria-hidden="true"><span style={{ width: `${percent ?? 0}%` }} /></span>
        <span className="dashboard-department-value"><strong>{metrics ? usageCount(metrics.perApp[app.id]) : "Unknown"}</strong>
          <small>{percent===null ? "Share unavailable" : `${percent.toFixed(1)}%`}</small></span>
      </li>;
    })}
  </ul>;
}
