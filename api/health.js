// api/health.js -- ตรวจว่าล็อบบี้ทำงาน + ใช้ที่เก็บแบบไหน + สถิติด่านกัน DDoS
import { storageKind } from "../lib/store.js";
import { stats } from "../lib/guard.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "health", limit: 60, burst: 20, maxBody: 1024 },
  () => [200, { ok: true, game: "Siege of Fate", storage: storageKind(), time: Date.now(), guard: stats() }]);
