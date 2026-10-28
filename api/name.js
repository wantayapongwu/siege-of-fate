// api/name.js -- v58: ทะเบียนชื่อตัวละคร (ห้ามซ้ำทั้งเซิร์ฟเวอร์)
//   POST {action:"check", name[, token]}     -> { ok, free }
//   POST {action:"claim"|"free", token, name} -> { ok, msg }
import { handleName } from "../lib/names.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "cname", limit: 60, burst: 20, maxBody: 2 * 1024 },
  (method, body, headers) => handleName(method, body, headers));
