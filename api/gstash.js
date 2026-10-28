// api/gstash.js -- คลังกิลล์ร่วมกัน (v38): POST {action:"get"|"put"|"take", token, gid, ...}
import { handleGStash } from "../lib/gstash.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "gstash", limit: 80, burst: 20, maxBody: 512 * 1024 },
  (method, body) => handleGStash(method, body));
