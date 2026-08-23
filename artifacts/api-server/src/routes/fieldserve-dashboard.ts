import { Router, type IRouter, type Request, type Response } from "express";
import { requireSignedUp } from "../middlewares/auth";
import { getFieldServeDb, FieldServeDataStore } from "../lib/fieldserve-db";

const router: IRouter = Router();
router.use(requireSignedUp);

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FieldServe Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e4e4e7; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #71717a; font-size: 13px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 16px; }
  .stat-card .label { font-size: 11px; color: #71717a; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .stat-card .value.green { color: #22c55e; }
  .stat-card .value.amber { color: #f59e0b; }
  .stat-card .value.red { color: #ef4444; }
  .stat-card .value.blue { color: #3b82f6; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #27272a; }
  th { color: #71717a; font-weight: 500; font-size: 11px; text-transform: uppercase; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .badge-created { background: #3b82f620; color: #60a5fa; }
  .badge-scheduled { background: #8b5cf620; color: #a78bfa; }
  .badge-assigned { background: #f59e0b20; color: #fbbf24; }
  .badge-engineer-dispatched, .badge-en-route { background: #f9731620; color: #fb923c; }
  .badge-on-site, .badge-checking-in { background: #06b6d420; color: #22d3ee; }
  .badge-waiting-for-access, .badge-waiting-for-equipment { background: #eab30820; color: #facc15; }
  .badge-in-progress { background: #22c55e20; color: #4ade80; }
  .badge-on-hold { background: #f59e0b20; color: #fbbf24; }
  .badge-completed { background: #22c55e30; color: #22c55e; }
  .badge-failed { background: #ef444420; color: #f87171; }
  .badge-cancelled { background: #6b728020; color: #9ca3af; }
  .badge-deferred { background: #6366f120; color: #818cf8; }
  .badge-facility-not-accessible, .badge-parts-required, .badge-requires-rescheduling { background: #ef444415; color: #fb7185; }
  .priority-critical { color: #ef4444; } .priority-high { color: #f97316; }
  .priority-medium { color: #eab308; } .priority-low { color: #6b7280; }
  .section { margin-bottom: 24px; }
  .section-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: #a1a1aa; }
  .status-bar { display: flex; gap: 2px; height: 8px; border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .status-bar > div { height: 100%; }
  #refresh-indicator { position: fixed; top: 12px; right: 12px; font-size: 11px; color: #52525b; }
</style>
</head>
<body>
<h1>FieldServe Debug Dashboard</h1>
<p class="subtitle">Live view of jobs, engineers, and system state. Auto-refreshes every 5s.</p>
<div id="refresh-indicator">Loading...</div>
<div class="grid" id="stats"></div>
<div class="section">
  <div class="section-title">Job Status Distribution</div>
  <div class="status-bar" id="status-bar"></div>
  <div id="status-legend" style="margin-top:8px;font-size:11px;color:#71717a;display:flex;flex-wrap:wrap;gap:12px"></div>
</div>
<div class="section">
  <div class="section-title">All Jobs</div>
  <table id="jobs-table">
    <thead><tr><th>ID</th><th>Title</th><th>Site</th><th>Skill</th><th>Priority</th><th>Status</th><th>Engineer</th><th>SLA</th></tr></thead>
    <tbody id="jobs-body"></tbody>
  </table>
</div>
<div class="section">
  <div class="section-title">Engineers</div>
  <table id="eng-table">
    <thead><tr><th>ID</th><th>Name</th><th>Skills</th><th>Status</th><th>Active Job</th></tr></thead>
    <tbody id="eng-body"></tbody>
  </table>
</div>
<script>
const COLORS = {
  'created':'#3b82f6','scheduled':'#8b5cf6','assigned':'#f59e0b','engineer-dispatched':'#f97316',
  'en-route':'#fb923c','on-site':'#06b6d4','checking-in':'#22d3ee','waiting-for-access':'#eab308',
  'waiting-for-equipment':'#facc15','in-progress':'#22c55e','on-hold':'#fbbf24',
  'completed':'#16a34a','failed':'#ef4444','cancelled':'#6b7280','deferred':'#6366f1',
  'facility-not-accessible':'#f43f5e','parts-required':'#e11d48','requires-rescheduling':'#be123c'
};
async function refresh() {
  try {
    const [statsRes, jobsRes, engRes] = await Promise.all([
      fetch('/api/fieldserve/dashboard/stats'),
      fetch('/api/fieldserve/jobs?limit=200'),
      fetch('/api/fieldserve/engineers')
    ]);
    const { stats } = await statsRes.json();
    const { jobs } = await jobsRes.json();
    const { engineers } = await engRes.json();
    const siteMap = {};
    (await (await fetch('/api/fieldserve/sites')).json()).sites.forEach(s => siteMap[s.id] = s.name);
    const engMap = {};
    engineers.forEach(e => engMap[e.id] = e.firstName + ' ' + e.lastName);
    document.getElementById('stats').innerHTML =
      '<div class="stat-card"><div class="label">Total Jobs</div><div class="value blue">' + stats.totalJobs + '</div></div>' +
      '<div class="stat-card"><div class="label">Active</div><div class="value amber">' + (stats.totalJobs - (stats.byStatus.completed||0) - (stats.byStatus.cancelled||0)) + '</div></div>' +
      '<div class="stat-card"><div class="label">Completed</div><div class="value green">' + (stats.byStatus.completed||0) + '</div></div>' +
      '<div class="stat-card"><div class="label">Failed</div><div class="value red">' + (stats.byStatus.failed||0) + '</div></div>' +
      '<div class="stat-card"><div class="label">SLA Breaches</div><div class="value red">' + stats.slaBreaches + '</div></div>' +
      '<div class="stat-card"><div class="label">Engineers</div><div class="value">' + stats.engineerUtilisation.total + '</div></div>';
    let barHtml = '', legendHtml = '';
    const total = stats.totalJobs || 1;
    for (const [s, count] of Object.entries(stats.byStatus)) {
      barHtml += '<div style="width:' + (count/total*100) + '%;background:' + (COLORS[s]||'#555') + '"></div>';
      legendHtml += '<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + (COLORS[s]||'#555') + ';margin-right:4px"></span>' + s + ' (' + count + ')</span>';
    }
    document.getElementById('status-bar').innerHTML = barHtml;
    document.getElementById('status-legend').innerHTML = legendHtml;
    let jobsHtml = '';
    for (const j of jobs) {
      const sla = j.slaDeadline ? new Date(j.slaDeadline) < new Date() ? '<span style="color:#ef4444">BREACH</span>' : 'OK' : '-';
      jobsHtml += '<tr><td>' + j.id + '</td><td>' + j.title.substring(0,40) + '</td><td>' + (siteMap[j.siteId]||j.siteId) + '</td><td>' + j.skillRequired + '</td><td class="priority-' + j.priority + '">' + j.priority + '</td><td><span class="badge badge-' + j.status + '">' + j.status + '</span></td><td>' + (engMap[j.assignedEngineerId]||'-') + '</td><td>' + sla + '</td></tr>';
    }
    document.getElementById('jobs-body').innerHTML = jobsHtml || '<tr><td colspan="8" style="color:#52525b">No jobs. POST /api/fieldserve/seed to populate.</td></tr>';
    let engHtml = '';
    for (const e of engineers) {
      const active = e.activeJob ? e.activeJob.title.substring(0,30) + ' (' + e.activeJob.status + ')' : '-';
      engHtml += '<tr><td>' + e.employeeId + '</td><td>' + e.firstName + ' ' + e.lastName + '</td><td>' + e.skills.join(', ') + '</td><td>' + e.status + '</td><td>' + active + '</td></tr>';
    }
    document.getElementById('eng-body').innerHTML = engHtml || '<tr><td colspan="5" style="color:#52525b">No engineers.</td></tr>';
    document.getElementById('refresh-indicator').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch(e) { document.getElementById('refresh-indicator').textContent = 'Error: ' + e.message; }
}
refresh(); setInterval(refresh, 5000);
</script>
</body>
</html>`;

router.get("/dashboard", async (_req: Request, res: Response) => {
  res.type("html").send(DASHBOARD_HTML);
});

router.get("/dashboard/html", async (_req: Request, res: Response) => {
  try {
    const store = new FieldServeDataStore(getFieldServeDb());
    const stats = store.getDashboardStats();
    const { jobs } = store.listJobs({ limit: 200 });
    const engineers = store.listEngineers();
    const sites = store.listSites();
    const overdue = store.getOverdueJobs();
    res.json({ stats, jobs, engineers, sites, overdue });
  } catch (err) {
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
