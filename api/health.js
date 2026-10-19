// api/health.js -- ตรวจว่าล็อบบี้ทำงาน + ใช้ที่เก็บแบบไหน
import { storageKind } from "../lib/store.js";
export default function handler(req, res) {
  res.status(200).json({ ok: true, game: "Siege of Fate", storage: storageKind(), time: Date.now() });
}
