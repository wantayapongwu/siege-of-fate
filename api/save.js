// api/save.js -- เซฟตัวละครบนเซิร์ฟเวอร์ (v30): POST {action:"get"|"put", token, save}
// v57: เซฟก้อนใหญ่ได้ถึง 1.5 MB แต่จำกัดจำนวนครั้งต่อนาที
import { handleSave } from "../lib/save.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "save", limit: 20, burst: 8, maxBody: 512 * 1024 },
  (method, body) => handleSave(method, body));
