// api/admin.js -- v35: ข้อมูลหลังบ้านสำหรับผู้ดูแล (ต้องล็อกอินด้วยบัญชีผู้ดูแล) | POST {action, token, ...}
import { handleAdmin } from "../lib/admin.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "admin", limit: 90, burst: 25, maxBody: 64 * 1024 },
  async (method, body, headers) => {
    const [code, out] = await handleAdmin(method, body, headers);
    return [code, out, { "X-Robots-Tag": "noindex" }];
  });
