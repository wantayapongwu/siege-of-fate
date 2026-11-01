// api/gstash.js -- คลังกิลล์ร่วมกัน (v38): POST {action:"get"|"put"|"take", token, gid, ...}
//
// v80.7: รับงานของ /api/trade ด้วย (เซิร์ฟเวอร์เป็นตัวกลางการเทรด)
//   ที่มา: แผน Hobby ของ Vercel จำกัด Serverless Function ไว้ 12 ตัวต่อหนึ่งดีพลอย
//   การเพิ่มไฟล์ใหม่ใน api/ ทำให้ดีพลอยไม่ผ่าน จึงใช้ rewrite ใน vercel.json
//   ส่ง /api/trade มาที่นี่ แล้วแยกงานด้วยช่อง api ในตัวข้อความ
import { handleGStash } from "../lib/gstash.js";
import { handleTrade } from "../lib/trade.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "gstash", limit: 80, burst: 20, maxBody: 512 * 1024 },
  (method, body, headers) => (body && body.api === "trade"
    ? handleTrade(method, body, headers)
    : handleGStash(method, body)));
