// api/cron.js -- v57: งานประจำวันตี 3 (เวลาไทย) ของฝั่งล็อบบี้ = กวาดข้อมูลค้างใน Redis ทิ้ง
//   Vercel ยิงเองตาม vercel.json ("0 20 * * *" UTC = 03:00 ตามเวลาไทย)
//   เรียกเองก็ได้: GET /api/cron?key=<CRON_SECRET>
import { cleanup, cronAuthorized } from "../lib/maintenance.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "cron", limit: 10, burst: 5, maxBody: 1024 }, async (method, body, headers, query) => {
  if (!cronAuthorized(headers, query)) return [403, { ok: false, msg: "forbidden" }];
  return [200, { ok: true, cleaned: await cleanup() }];
});
