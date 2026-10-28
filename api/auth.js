// api/auth.js -- POST {action:"register"|"login", user, pass} | {action:"me", token}
// v57: โควตาแน่นเป็นพิเศษ (กันไล่เดารหัสผ่าน/สมัครรัว) — เกินแล้วโดนระงับชั่วคราวแบบทวีคูณ
import { handleAuth } from "../lib/accounts.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "auth", limit: 30, burst: 10, maxBody: 4 * 1024 },
  (method, body, headers) => handleAuth(method, body, headers));
