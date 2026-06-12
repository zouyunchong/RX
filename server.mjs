import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const ordersFile = path.join(dataDir, "orders.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const mcpUrl = process.env.LUCKIN_MCP_URL || "https://gwmcp.lkcoffee.com/order/user/mcp";
const tokenFile = path.join(os.homedir(), ".my-coffee", "LUCKIN_MCP_TOKEN");

const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

async function ensureOrdersFile() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(ordersFile);
  } catch {
    await fs.writeFile(ordersFile, JSON.stringify({ orders: [] }, null, 2));
  }
}

async function readOrdersDb() {
  await ensureOrdersFile();
  const raw = await fs.readFile(ordersFile, "utf8");
  const parsed = JSON.parse(raw || "{}");
  if (!Array.isArray(parsed.orders)) {
    parsed.orders = [];
  }
  return parsed;
}

async function writeOrdersDb(db) {
  await fs.writeFile(ordersFile, JSON.stringify(db, null, 2));
}

async function appendOrderRecord({ store, product, amount, execution, source = "manual" }) {
  const db = await readOrdersDb();
  const record = {
    id: randomUUID(),
    orderId: execution.orderId,
    store: {
      deptId: store.deptId,
      deptName: store.deptName,
      address: store.address
    },
    product: {
      productId: product.productId,
      productName: product.productName,
      skuCode: product.skuCode
    },
    amount,
    discountPrice: execution.discountPrice,
    qrCodeUrl: execution.qrCodeUrl || "",
    source,
    createdAt: execution.createdAt || new Date().toISOString()
  };
  db.orders.unshift(record);
  await writeOrdersDb(db);
  return enrichOrder(record);
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function text(res, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function getLuckinToken() {
  const envToken = String(process.env.LUCKIN_MCP_TOKEN || "").trim();
  if (envToken) {
    return envToken;
  }
  try {
    return (await fs.readFile(tokenFile, "utf8")).trim();
  } catch {
    return "";
  }
}

function parsePossiblyNestedJson(rawText) {
  if (!rawText) return null;
  try {
    // Replace bare integers with 16+ digits with quoted strings before JSON.parse,
    // because float64 cannot represent them precisely (> Number.MAX_SAFE_INTEGER).
    const safe = rawText.replace(/:(\s*)(\d{16,})\b/g, ':$1"$2"');
    return JSON.parse(safe);
  } catch {
    return null;
  }
}

function parseSsePayload(rawText) {
  const dataLines = rawText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .filter((line) => line !== "[DONE]");

  for (let index = dataLines.length - 1; index >= 0; index -= 1) {
    const parsed = parsePossiblyNestedJson(dataLines[index]);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function extractToolData(payload) {
  const result = payload?.result || payload;
  if (result?.structuredContent) {
    return result.structuredContent;
  }

  const content = Array.isArray(result?.content) ? result.content : [];
  for (const item of content) {
    if (typeof item?.text === "string") {
      const parsed = parsePossiblyNestedJson(item.text);
      if (parsed && typeof parsed === "object" && ("code" in parsed || "success" in parsed)) {
        if (parsed.success === false || (typeof parsed.code === "number" && parsed.code !== 0)) {
          throw new Error(parsed.msg || "瑞幸 MCP 调用失败。");
        }
        return parsed.data;
      }
      if (parsed && typeof parsed === "object" && "data" in parsed) {
        return parsed.data;
      }
      if (parsed) {
        return parsed;
      }
      return item.text;
    }
  }

  if (result?.data) {
    return result.data;
  }

  return result;
}

function assertObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

async function callMcpTool(name, args, options = {}) {
  const token = await getLuckinToken();
  if (!token) {
    throw new Error("未找到 LUCKIN_MCP_TOKEN。请先在本机配置瑞幸 MCP token。");
  }

  // Allow passing a pre-serialized argsJson to preserve large integer precision
  // when JSON.stringify would otherwise truncate digits beyond float64 limits.
  const argsJson = options.rawArgsJson ?? JSON.stringify(args);
  const rawBody = `{"jsonrpc":"2.0","id":${Date.now()},"method":"tools/call","params":{"name":${JSON.stringify(name)},"arguments":${argsJson}}}`;

  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: rawBody
  });

  const rawText = await response.text();
  const parsed = parsePossiblyNestedJson(rawText) || parseSsePayload(rawText);
  if (!response.ok) {
    throw new Error(`MCP 请求失败：HTTP ${response.status}`);
  }
  if (!parsed) {
    throw new Error("MCP 返回无法解析。");
  }
  if (parsed.error) {
    throw new Error(parsed.error.message || "MCP 调用失败。");
  }
  return extractToolData(parsed);
}

function normalizeStore(store) {
  return {
    deptId: store.deptId,
    deptName: store.deptName,
    address: store.address,
    latitude: Number(store.latitude),
    longitude: Number(store.longitude),
    distance: Number(store.distance || 0),
    workTimeStart: store.workTimeStart,
    workTimeEnd: store.workTimeEnd,
    workStatus: store.workStatus
  };
}

function normalizeProduct(product) {
  return {
    productId: product.productId,
    productName: product.productName,
    skuCode: product.skuCode,
    estimatePrice: product.estimatePrice,
    initialPrice: product.initialPrice,
    tags: product.tags || [],
    pictureUrl: product.pictureUrl,
    attrs: product.productAttrs || []
  };
}

const knownPlaces = [
  {
    patterns: ["TCL国际E城", "TCL国际园区", "TCL科学园", "TCL"],
    latitude: 22.572845,
    longitude: 113.927785,
    deptName: "TCL国际E城",
    preferStoreText: "F3"
  }
];

function findKnownPlace(text) {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;
  return knownPlaces.find((item) => item.patterns.some((pattern) => normalized.includes(pattern.toLowerCase()))) || null;
}

function toSearchLocation(place) {
  return {
    latitude: place.latitude,
    longitude: place.longitude,
    deptName: place.deptName,
    label: place.deptName,
    source: "knownPlace"
  };
}

const productAliases = [
  ["冰美式", "冰美式"],
  ["热美式", "热美式"],
  ["美式", "冰美式"],
  ["生椰拿铁", "生椰拿铁"],
  ["拿铁", "拿铁"],
  ["澳瑞白", "澳瑞白"],
  ["丝绒拿铁", "丝绒拿铁"],
  ["厚乳拿铁", "厚乳拿铁"]
];

function parseChineseAmount(text) {
  const match = text.match(/([0-9]+|一|二|两|三|四|五|六|七|八|九|十)\s*(杯|份|单)/);
  if (!match) return 1;
  const value = match[1];
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return Number(value) || map[value] || 1;
}

function parseSmartOrder(prompt, fallbackLocation = null) {
  const text = String(prompt || "").trim();
  if (!text) {
    throw new Error("请输入一句话需求，例如：TCL国际E城 冰美式。");
  }

  const place = findKnownPlace(text);
  const productQuery = productAliases.find(([alias]) => text.includes(alias))?.[1] || "冰美式";
  const location = place
    ? {
        latitude: place.latitude,
        longitude: place.longitude,
        deptName: place.deptName,
        preferStoreText: place.preferStoreText
      }
    : fallbackLocation && Number.isFinite(Number(fallbackLocation.latitude)) && Number.isFinite(Number(fallbackLocation.longitude))
      ? {
          latitude: Number(fallbackLocation.latitude),
          longitude: Number(fallbackLocation.longitude),
          deptName: String(fallbackLocation.deptName || "").trim(),
          preferStoreText: ""
        }
      : null;

  if (!location) {
    throw new Error("没有识别到地点。可以这样说：TCL国际E城 冰美式。");
  }

  return {
    prompt: text,
    amount: parseChineseAmount(text),
    productQuery,
    location
  };
}

function selectBestStore(stores, intent) {
  if (!stores.length) {
    throw new Error("没有找到匹配门店。");
  }
  const preferred = String(intent.location.preferStoreText || "").toLowerCase();
  if (preferred) {
    const match = stores.find((store) => String(store.deptName || "").toLowerCase().includes(preferred));
    if (match) return match;
  }
  return stores[0];
}

function toLocalDateTime(dateLike) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function enrichOrder(order) {
  return {
    ...order,
    createdAtLabel: toLocalDateTime(order.createdAt)
  };
}

async function createLuckinOrder({ store, product, amount }) {
  const preview = assertObject(await callMcpTool("previewOrder", {
    deptId: store.deptId,
    productList: [
      {
        amount,
        productId: product.productId,
        skuCode: product.skuCode
      }
    ]
  }), "订单预览失败：瑞幸未返回预览信息。");

  const order = assertObject(await callMcpTool("createOrder", {
    deptId: store.deptId,
    latitude: store.latitude,
    longitude: store.longitude,
    couponCodeList: Array.isArray(preview.couponCodeList) ? preview.couponCodeList : [],
    productList: [
      {
        amount,
        productId: product.productId,
        skuCode: product.skuCode
      }
    ]
  }), "创建订单失败：瑞幸未返回订单信息。");

  const orderId = String(order.orderId || order.orderIdStr || "");
  if (!orderId) {
    throw new Error("创建订单失败：瑞幸未返回订单号。");
  }

  return {
    order,
    preview,
    execution: {
      orderId,
      qrCodeUrl: order.payOrderQrCodeUrl || "",
      orderUrl: order.payOrderUrl || "",
      discountPrice: order.discountPrice ?? preview.discountPrice ?? null,
      previewPrice: preview.discountPrice ?? null,
      createdAt: new Date().toISOString()
    }
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    const token = await getLuckinToken();
    return json(res, 200, { ok: true, tokenReady: Boolean(token) });
  }

  if (req.method === "GET" && pathname === "/api/orders") {
    const db = await readOrdersDb();
    return json(res, 200, { orders: db.orders.map(enrichOrder) });
  }

  if (req.method === "POST" && pathname === "/api/stores/search") {
    const body = await readBody(req);
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const deptName = String(body.deptName || "").trim();
    const knownPlace = findKnownPlace(deptName);
    const location = knownPlace
      ? toSearchLocation(knownPlace)
      : Number.isFinite(latitude) && Number.isFinite(longitude)
        ? {
            latitude,
            longitude,
            deptName,
            label: "浏览器定位",
            source: "browser"
          }
        : null;

    if (!location) {
      throw new Error("浏览器没有返回坐标。请输入地点或门店关键词，例如：TCL国际E城。");
    }

    const data = await callMcpTool("queryShopList", {
      latitude: location.latitude,
      longitude: location.longitude,
      deptName: deptName || location.deptName || undefined
    });
    return json(res, 200, { stores: (data || []).map(normalizeStore), location });
  }

  if (req.method === "POST" && pathname === "/api/products/search") {
    const body = await readBody(req);
    const data = await callMcpTool("searchProductForMcp", {
      deptId: Number(body.deptId),
      query: String(body.query || "").trim()
    });
    return json(res, 200, { products: (data || []).map(normalizeProduct) });
  }

  if (req.method === "POST" && pathname === "/api/orders/preview") {
    const body = await readBody(req);
    const data = await callMcpTool("previewOrder", body);
    return json(res, 200, { preview: data });
  }

  if (req.method === "POST" && pathname === "/api/orders/create") {
    const body = await readBody(req);
    const store = assertObject(body.store, "请选择门店。");
    const product = assertObject(body.product, "请选择商品。");
    const amount = Math.max(1, Number(body.amount || 1));
    const { execution } = await createLuckinOrder({ store, product, amount });
    const record = await appendOrderRecord({ store, product, amount, execution, source: "manual" });
    return json(res, 201, { order: execution, record });
  }

  const orderDeleteMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (req.method === "DELETE" && orderDeleteMatch) {
    const db = await readOrdersDb();
    db.orders = db.orders.filter((o) => o.id !== orderDeleteMatch[1]);
    await writeOrdersDb(db);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/orders/status") {
    const body = await readBody(req);
    const orderId = String(body.orderId || "").replace(/\D/g, "");
    if (!orderId) {
      return json(res, 400, { error: "orderId 不能为空" });
    }
    // Inject orderId as a bare integer in the JSON body to preserve all digits.
    // Using JSON.stringify({ orderId: Number(orderId) }) would round large values.
    const data = await callMcpTool("queryOrderDetailInfo", {}, {
      rawArgsJson: `{"orderId":${orderId}}`
    });
    return json(res, 200, { order: data });
  }

  if (req.method === "POST" && pathname === "/api/smart/order") {
    const body = await readBody(req);
    const intent = parseSmartOrder(body.prompt, body.location);
    const storeData = await callMcpTool("queryShopList", {
      latitude: intent.location.latitude,
      longitude: intent.location.longitude,
      deptName: intent.location.deptName || undefined
    });
    const stores = (Array.isArray(storeData) ? storeData : []).map(normalizeStore);
    const store = selectBestStore(stores, intent);
    const productData = await callMcpTool("searchProductForMcp", {
      deptId: store.deptId,
      query: intent.productQuery
    });
    const products = (Array.isArray(productData) ? productData : []).map(normalizeProduct);
    if (!products.length) {
      throw new Error(`没有找到商品：${intent.productQuery}`);
    }
    const product = products[0];
    const { execution, preview } = await createLuckinOrder({
      store,
      product,
      amount: intent.amount
    });
    const record = await appendOrderRecord({ store, product, amount: intent.amount, execution, source: "smart" });
    return json(res, 201, {
      intent,
      store,
      product,
      preview,
      order: execution,
      record
    });
  }

  return false;
}

async function serveStatic(res, pathname) {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, relativePath));
  if (!filePath.startsWith(publicDir)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    text(res, 200, content, staticTypes[ext] || "application/octet-stream");
  } catch {
    json(res, 404, { error: "Not Found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);

  try {
    const apiHandled = await handleApi(req, res, url.pathname);
    if (apiHandled !== false) {
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务器异常";
    json(res, 500, { error: message });
  }
});

await ensureOrdersFile();

server.listen(port, host, () => {
  console.log(`Luckin order app running at http://${host}:${port}`);
});
