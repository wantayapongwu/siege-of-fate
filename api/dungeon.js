// api/dungeon.js -- v79.0: นับการรีเซ็ตดันเจี้ยน: POST {action:"reset", token, map, level}
import { handleDungeon } from "../lib/dungeon.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "dungeon", limit: 300, burst: 30, maxBody: 2 * 1024 },
  (method, body) => handleDungeon(method, body));
