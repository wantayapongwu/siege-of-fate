// api/shop.js -- v41: ร้านคอสตูมเงินจริง | POST {action, token, ...}
import { handleShop } from "../lib/shop.js";
import { endpoint } from "../lib/endpoint.js";

export default endpoint({ name: "shop", limit: 60, burst: 15, maxBody: 32 * 1024 },
  (method, body, headers) => handleShop(method, body, headers));
