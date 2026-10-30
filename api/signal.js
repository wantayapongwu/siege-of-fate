// api/signal.js -- POST {action:"send", room, me, to, msg} | {action:"poll", room, me}
// v57: เส้นทางนี้ถูกเรียกถี่ที่สุด (ตอนจับคู่ WebRTC ถามทุก 0.4 วิ) โควตาจึงสูงกว่าเส้นอื่น
//      แต่ยังต่ำกว่าการยิงถล่มหลายเท่า และเผื่อผู้เล่นหลายคนอยู่หลัง IP เดียวกัน (บ้าน/ร้านเน็ต)
import { handleSignal } from "../lib/signal.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "signal", limit: 300, burst: 60, maxBody: 16 * 1024 },
  (method, body, headers) => handleSignal(method, body, headers));
