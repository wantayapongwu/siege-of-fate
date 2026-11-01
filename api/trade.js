// api/trade.js -- v80.7: เซิร์ฟเวอร์เป็นตัวกลางการเทรด (ตรวจว่าทั้งสองฝ่ายมีของจริงก่อนสลับ)
import { handleTrade } from "../lib/trade.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "trade", limit: 60, burst: 15, maxBody: 64 * 1024 },
  (method, body, headers) => handleTrade(method, body, headers));
