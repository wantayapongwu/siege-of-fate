// api/rooms.js -- Vercel Serverless Function: รายชื่อห้องของ Siege of Fate
//   GET  /api/rooms?proto=sof-v28            -> { ok, rooms: [...], storage, your_ip }
//   POST /api/rooms {action:"register", name, host, port, players, max, proto[, public_host, dedicated]} -> { ok, id, token, ip }
//   POST /api/rooms {action:"heartbeat", id, token, players} | {action:"remove", id, token}
// v57: ผ่านด่านกัน DDoS ก่อนเสมอ (เกมส่ง heartbeat ทุก 15 วิ + ดูรายชื่อห้องเป็นครั้งคราว -> โควตานี้เหลือเฟือ)
import { handle } from "../lib/lobby.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "rooms", limit: 90, burst: 20, maxBody: 8 * 1024 },
  (method, body, headers, query) => handle(method, body, headers, query));
