const state = {
  selectedStore: null,
  selectedProduct: null,
  location: null,
  locationError: "",
  locating: false,
  locationWatchId: null,
  speechRecognition: null,
  isListening: false,
  productConfirmed: false,
  orderResult: null
};

const els = {
  smartPrompt: document.querySelector("#smartPrompt"),
  smartCreateBtn: document.querySelector("#smartCreateBtn"),
  smartResult: document.querySelector("#smartResult"),
  voiceInputBtn: document.querySelector("#voiceInputBtn"),
  healthBadge: document.querySelector("#healthBadge"),
  locationSummary: document.querySelector("#locationSummary"),
  storeKeyword: document.querySelector("#storeKeyword"),
  storeList: document.querySelector("#storeList"),
  geoBtn: document.querySelector("#geoBtn"),
  storeSearchBtn: document.querySelector("#storeSearchBtn"),
  productQuery: document.querySelector("#productQuery"),
  productSearchBtn: document.querySelector("#productSearchBtn"),
  productList: document.querySelector("#productList"),
  selectionSummary: document.querySelector("#selectionSummary"),
  amount: document.querySelector("#amount"),
  amountMinusBtn: document.querySelector("#amountMinusBtn"),
  amountPlusBtn: document.querySelector("#amountPlusBtn"),
  confirmProductBtn: document.querySelector("#confirmProductBtn"),
  productConfirmResult: document.querySelector("#productConfirmResult"),
  orderList: document.querySelector("#orderList"),
  refreshOrdersBtn: document.querySelector("#refreshOrdersBtn"),
  orderTemplate: document.querySelector("#orderTemplate"),
  qrModal: document.querySelector("#qrModal"),
  qrModalImage: document.querySelector("#qrModalImage")
};

function setBadge(element, text, mode = "muted") {
  element.textContent = text;
  element.className = `badge badge-${mode}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function notify(message) {
  window.alert(message);
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

function getVoiceUnavailableMessage() {
  if (!getSpeechRecognitionCtor()) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      return "iPhone 浏览器暂不支持语音输入，请手动输入。";
    }
    return "当前浏览器不支持语音输入，请手动输入。";
  }
  if (!window.isSecureContext && location.hostname !== "localhost") {
    return "语音输入需要 HTTPS 环境，请手动输入。";
  }
  return "";
}

function setVoiceListening(isListening) {
  state.isListening = isListening;
  els.voiceInputBtn.classList.toggle("listening", isListening);
  els.voiceInputBtn.textContent = isListening ? "听写中" : "语音";
}

function getSpeechErrorMessage(errorCode) {
  const map = {
    "not-allowed": "麦克风权限被拒绝，请在浏览器设置中允许麦克风。",
    "service-not-allowed": "当前页面无法使用语音服务，请手动输入。",
    "no-speech": "没有听到语音，请再试一次。",
    "network": "网络异常，语音识别失败。",
    "aborted": "语音输入已取消。"
  };
  return map[errorCode] || `语音输入失败：${errorCode || "未知错误"}`;
}

function startVoiceInput() {
  const unavailable = getVoiceUnavailableMessage();
  if (unavailable) {
    notify(unavailable);
    return;
  }

  if (state.isListening && state.speechRecognition) {
    state.speechRecognition.stop();
    return;
  }

  // 正确实例化：先拿到构造函数再 new，避免安卓 Chrome "Illegal constructor"
  const SpeechRecognitionCtor = getSpeechRecognitionCtor();
  let recognition;
  try {
    recognition = new SpeechRecognitionCtor();
  } catch (error) {
    notify("语音功能初始化失败，请手动输入。");
    return;
  }

  recognition.lang = "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  state.speechRecognition = recognition;

  recognition.onstart = () => setVoiceListening(true);
  recognition.onend = () => setVoiceListening(false);
  recognition.onerror = (event) => {
    setVoiceListening(false);
    if (event.error !== "aborted" && event.error !== "no-speech") {
      notify(getSpeechErrorMessage(event.error));
    }
  };
  recognition.onresult = (event) => {
    let transcript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      transcript += event.results[index][0].transcript;
    }
    const trimmed = transcript.trim();
    if (trimmed) {
      els.smartPrompt.value = trimmed;
    }
  };

  try {
    recognition.start();
  } catch (error) {
    setVoiceListening(false);
    notify(error instanceof Error ? error.message : "无法启动语音输入。");
  }
}

function bindVoiceInput() {
  let handledByTouch = false;

  els.voiceInputBtn.addEventListener(
    "touchend",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      handledByTouch = true;
      startVoiceInput();
    },
    { passive: false }
  );

  els.voiceInputBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (handledByTouch) {
      handledByTouch = false;
      return;
    }
    startVoiceInput();
  });
}

function formatMoney(value) {
  if (value == null || value === "") return "-";
  return `¥${Number(value).toFixed(2)}`;
}

function haversineDistanceMeters(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const latDelta = toRad(b.latitude - a.latitude);
  const lonDelta = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const x =
    Math.sin(latDelta / 2) * Math.sin(latDelta / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta / 2) * Math.sin(lonDelta / 2);
  const y = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return earthRadius * y;
}

function pickNearestStore(stores) {
  if (!stores.length) return null;
  if (!state.location) return stores[0];

  return [...stores]
    .map((store) => ({
      ...store,
      computedDistanceMeters: haversineDistanceMeters(state.location, {
        latitude: store.latitude,
        longitude: store.longitude
      })
    }))
    .sort((left, right) => left.computedDistanceMeters - right.computedDistanceMeters)[0];
}

function renderLocationSummary() {
  if (state.locating) {
    els.locationSummary.classList.remove("empty");
    els.locationSummary.innerHTML = "正在高精度定位，请稍等几秒…";
    return;
  }

  if (!state.location) {
    els.locationSummary.classList.add("empty");
    els.locationSummary.innerHTML = state.locationError
      ? `
        <p><strong>浏览器定位暂不可用</strong></p>
        <p>${state.locationError}</p>
        <p>可以在右侧输入地点或门店名，例如 TCL国际E城，然后点击搜索附近门店。</p>
      `
      : "还没有定位，先点“获取当前位置”。";
    return;
  }

  els.locationSummary.classList.remove("empty");
  const label = state.location.label || "当前位置";
  const accuracy = state.location.accuracy ? `<p>定位精度约 ${Math.round(state.location.accuracy)} 米</p>` : "";
  els.locationSummary.innerHTML = `
    <p><strong>${label}已就绪</strong></p>
    <p>纬度 ${state.location.latitude.toFixed(6)} · 经度 ${state.location.longitude.toFixed(6)}</p>
    ${accuracy}
  `;
}

function stopLocationWatch() {
  if (state.locationWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.locationWatchId);
  }
  state.locationWatchId = null;
}

function applyLocationPosition(position) {
  const nextLocation = {
    latitude: Number(position.coords.latitude),
    longitude: Number(position.coords.longitude),
    accuracy: Number(position.coords.accuracy || 0),
    label: "当前位置",
    source: "browser"
  };

  if (!state.location || state.location.source !== "browser" || nextLocation.accuracy < state.location.accuracy) {
    state.location = nextLocation;
    state.locationError = "";
  }
  renderLocationSummary();
}

function getBrowserPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function getLocationErrorMessage(error) {
  if (error?.code === 1) {
    return "浏览器权限被拒绝，请在地址栏权限里允许定位后重试。";
  }
  if (error?.code === 2) {
    return "浏览器已允许定位，但系统暂时拿不到位置更新。";
  }
  if (error?.code === 3) {
    return "定位超时，可能是当前网络或系统定位服务响应较慢。";
  }
  return error?.message || "定位失败。";
}

async function locatePrecisely() {
  if (!navigator.geolocation) {
    state.locationError = "当前浏览器不支持定位。";
    renderLocationSummary();
    return;
  }

  stopLocationWatch();
  state.locating = true;
  state.locationError = "";
  els.geoBtn.disabled = true;
  els.geoBtn.textContent = "定位中…";
  renderLocationSummary();

  const preciseOptions = {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 0
  };
  const relaxedOptions = {
    enableHighAccuracy: false,
    timeout: 12000,
    maximumAge: 10 * 60 * 1000
  };

  try {
    let position;
    try {
      position = await getBrowserPosition(preciseOptions);
    } catch {
      position = await getBrowserPosition(relaxedOptions);
    }
    applyLocationPosition(position);
    await searchStoresWithCurrentLocation("");
  } catch (error) {
    state.location = null;
    state.locationError = getLocationErrorMessage(error);
    renderLocationSummary();
    if (els.storeKeyword.value.trim()) {
      await searchStoresWithCurrentLocation(els.storeKeyword.value).catch((searchError) => {
        notify(searchError.message);
      });
    }
  } finally {
    state.locating = false;
    stopLocationWatch();
    els.geoBtn.disabled = false;
    els.geoBtn.textContent = "获取当前位置";
    renderLocationSummary();
  }
}

function selectStore(store, stores) {
  state.selectedStore = store;
  state.productConfirmed = false;
  state.orderResult = null;
  els.storeKeyword.value = store.deptName;
  updateSelectionSummary();
  renderProductConfirmResult();
  renderStoreList(stores);
}

function renderStoreList(stores) {
  if (!stores.length) {
    els.storeList.innerHTML = '<div class="result-card empty">没找到门店，试试改一下位置或关键词。</div>';
    return;
  }

  els.storeList.innerHTML = stores
    .map((store) => {
      const active = state.selectedStore?.deptId === store.deptId ? "active" : "";
      const distanceLabel =
        typeof store.computedDistanceMeters === "number"
          ? ` · 约 ${Math.round(store.computedDistanceMeters)} 米`
          : typeof store.distance === "number" && store.distance > 0
            ? ` · 约 ${store.distance.toFixed(2)} km`
            : "";
      return `
        <article class="store-card ${active}" data-store-card-id="${store.deptId}" role="button" tabindex="0">
          <h3>${store.deptName}</h3>
          <p>${store.address}</p>
          <p>营业时间 ${store.workTimeStart} - ${store.workTimeEnd} · ${store.workStatus}${distanceLabel}</p>
          <div class="inline-actions">
            <button class="button button-ghost" data-store-id="${store.deptId}">选这个门店</button>
          </div>
        </article>
      `;
    })
    .join("");

  els.storeList.querySelectorAll("[data-store-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const store = stores.find((item) => item.deptId === Number(button.dataset.storeId));
      selectStore(store, stores);
    });
  });

  els.storeList.querySelectorAll("[data-store-card-id]").forEach((card) => {
    const choose = () => {
      const store = stores.find((item) => item.deptId === Number(card.dataset.storeCardId));
      selectStore(store, stores);
    };
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      choose();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      choose();
    });
  });
}

async function searchStoresWithCurrentLocation(keyword = "") {
  const normalizedKeyword = keyword.trim();
  if (!state.location && !normalizedKeyword) {
    throw new Error("浏览器定位不可用时，请先输入地点或门店名，例如：TCL国际E城。");
  }

  const payload = {
    latitude: state.location?.latitude,
    longitude: state.location?.longitude,
    deptName: normalizedKeyword
  };
  const data = await api("api/stores/search", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const queryLocation = data.location
    ? {
        latitude: Number(data.location.latitude),
        longitude: Number(data.location.longitude),
        accuracy: 0,
        label: data.location.source === "knownPlace" ? data.location.label : state.location?.label || "当前位置",
        source: data.location.source
      }
    : state.location;

  if (!state.location && queryLocation) {
    state.location = queryLocation;
    state.locationError = "";
    renderLocationSummary();
  }

  const stores = (data.stores || []).map((store) => ({
    ...store,
    computedDistanceMeters: queryLocation
      ? haversineDistanceMeters(queryLocation, { latitude: store.latitude, longitude: store.longitude })
      : undefined
  }));

  const nearestStore = pickNearestStore(stores);
  if (nearestStore) {
    state.selectedStore = nearestStore;
    els.storeKeyword.value = nearestStore.deptName;
  }

  updateSelectionSummary();
  renderStoreList(stores);
  return { stores, nearestStore };
}

function renderProductList(products) {
  if (!products.length) {
    els.productList.innerHTML = '<div class="result-card empty">没找到商品，换个关键词试试。</div>';
    return;
  }

  els.productList.innerHTML = products
    .map((product) => {
      const active = state.selectedProduct?.skuCode === product.skuCode ? "active" : "";
      const attrs = product.attrs
        .map((attr) => `${attr.attributeName}：${(attr.productSubAttrs || []).map((item) => item.attributeName).join(" / ")}`)
        .join("<br />");
      return `
        <article class="product-card ${active}">
          <h3>${product.productName}</h3>
          <p>预估价 ${formatMoney(product.estimatePrice)} · 原价 ${formatMoney(product.initialPrice)}</p>
          <p>${attrs || "暂无规格说明"}</p>
          <div class="inline-actions">
            <button class="button button-ghost" data-product-code="${product.skuCode}">选这个商品</button>
          </div>
        </article>
      `;
    })
    .join("");

  els.productList.querySelectorAll("[data-product-code]").forEach((button) => {
    button.addEventListener("click", () => {
      const product = products.find((item) => item.skuCode === button.dataset.productCode);
      state.selectedProduct = product;
      state.productConfirmed = false;
      state.orderResult = null;
      updateSelectionSummary();
      renderProductConfirmResult();
      renderProductList(products);
    });
  });
}

function renderProductConfirmResult() {
  if (!state.productConfirmed || !state.selectedStore || !state.selectedProduct) {
    els.productConfirmResult.classList.add("hidden");
    els.productConfirmResult.innerHTML = "";
    els.confirmProductBtn.textContent = "确定";
    els.confirmProductBtn.disabled = false;
    return;
  }

  const qrCode = state.orderResult?.qrCodeUrl
    ? `<img class="order-qr order-qr-shake" src="${state.orderResult.qrCodeUrl}" alt="订单二维码" role="button" tabindex="0" />`
    : "";
  els.productConfirmResult.classList.remove("hidden");
  els.productConfirmResult.innerHTML = `
    <p><strong>${state.orderResult ? "订单已创建" : "已确认"}</strong></p>
    <p>门店：${state.selectedStore.deptName}</p>
    <p>商品：${state.selectedProduct.productName} × ${getAmount()}</p>
    ${state.orderResult ? `<p>订单号：${state.orderResult.orderId}</p>` : ""}
    ${state.orderResult?.discountPrice != null ? `<p>金额：${formatMoney(state.orderResult.discountPrice)}</p>` : ""}
    ${qrCode}
  `;
  if (state.orderResult) {
    els.confirmProductBtn.textContent = "再下一单";
    els.confirmProductBtn.disabled = false;
  } else {
    els.confirmProductBtn.textContent = "已确定";
    els.confirmProductBtn.disabled = false;
    window.setTimeout(() => {
      if (state.productConfirmed && !state.orderResult) {
        els.confirmProductBtn.textContent = "确定";
      }
    }, 1200);
  }
  bindOrderQrInteractions();
}

function openQrModal(qrCodeUrl) {
  if (!qrCodeUrl) return;
  els.qrModalImage.src = qrCodeUrl;
  els.qrModal.classList.remove("hidden");
}

function closeQrModal() {
  els.qrModal.classList.add("hidden");
  els.qrModalImage.removeAttribute("src");
}

function bindOrderQrInteractions(root = els.productConfirmResult) {
  const qrImage = root.querySelector(".order-qr");
  if (!qrImage) return;

  const open = () => openQrModal(qrImage.src);
  qrImage.addEventListener("click", open);
  qrImage.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  });

  window.setTimeout(() => {
    qrImage.classList.remove("order-qr-shake");
  }, 3000);
}

function updateSelectionSummary() {
  if (!state.selectedStore) {
    setBadge(els.selectionSummary, "未选择门店", "muted");
    return;
  }
  if (!state.selectedProduct) {
    setBadge(els.selectionSummary, `已选门店：${state.selectedStore.deptName}`, "warm");
    return;
  }
  if (state.productConfirmed) {
    setBadge(els.selectionSummary, `已确认：${state.selectedProduct.productName} × ${getAmount()}`, "ok");
    return;
  }
  setBadge(els.selectionSummary, `${state.selectedStore.deptName} · ${state.selectedProduct.productName}`, "ok");
}

async function refreshHealth() {
  try {
    const data = await api("api/health", { method: "GET" });
    setBadge(els.healthBadge, data.tokenReady ? "MCP 已就绪" : "缺少 Token", data.tokenReady ? "ok" : "warn");
  } catch {
    setBadge(els.healthBadge, "服务不可用", "warn");
  }
}

async function searchStores() {
  try {
    await searchStoresWithCurrentLocation(els.storeKeyword.value);
  } catch (error) {
    notify(error.message);
  }
}

async function searchProducts() {
  if (!state.selectedStore) {
    notify("先选一个门店。");
    return;
  }
  try {
    const data = await api("api/products/search", {
      method: "POST",
      body: JSON.stringify({
        deptId: state.selectedStore.deptId,
        query: els.productQuery.value.trim()
      })
    });
    renderProductList(data.products || []);
  } catch (error) {
    notify(error.message);
  }
}

function getAmount() {
  const amount = Number.parseInt(els.amount.value, 10);
  return Number.isFinite(amount) && amount > 0 ? amount : 1;
}

function setAmount(nextAmount) {
  const amount = Math.max(1, Number.parseInt(nextAmount, 10) || 1);
  els.amount.value = String(amount);
  state.productConfirmed = false;
  state.orderResult = null;
  updateSelectionSummary();
  renderProductConfirmResult();
}

async function confirmProductSelection() {
  if (!state.selectedStore || !state.selectedProduct) {
    notify("先选好门店和商品。");
    return;
  }

  // 「再下一单」：重置上次订单，用相同门店+商品重新下单
  if (state.orderResult) {
    state.orderResult = null;
    state.productConfirmed = false;
    renderProductConfirmResult();
  }

  els.confirmProductBtn.disabled = true;
  els.confirmProductBtn.textContent = "下单中…";
  try {
    const data = await api("api/orders/create", {
      method: "POST",
      body: JSON.stringify({
        store: state.selectedStore,
        product: state.selectedProduct,
        amount: getAmount()
      })
    });
    state.orderResult = data.order;
    state.productConfirmed = true;
    updateSelectionSummary();
    renderProductConfirmResult();
    await refreshOrders();
  } catch (error) {
    notify(error.message);
    els.confirmProductBtn.textContent = "确定";
    els.confirmProductBtn.disabled = false;
  }
}

async function smartCreateOrder() {
  const prompt = els.smartPrompt.value.trim();
  if (!prompt) {
    notify("先输入一句话需求，例如：TCL国际E城 冰美式。");
    return;
  }

  els.smartCreateBtn.disabled = true;
  els.smartCreateBtn.textContent = "下单中…";
  els.smartResult.classList.remove("empty");
  els.smartResult.innerHTML = "正在解析需求、查门店、查商品并创建订单…";

  try {
    const data = await api("api/smart/order", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        location: state.location
      })
    });

    state.selectedStore = data.store;
    state.selectedProduct = data.product;
    state.productConfirmed = true;
    state.orderResult = data.order;
    els.storeKeyword.value = data.store.deptName;
    els.productQuery.value = data.intent.productQuery;
    els.amount.value = String(data.intent.amount);
    updateSelectionSummary();
    renderProductConfirmResult();
    renderStoreList([data.store]);
    renderProductList([data.product]);
    await refreshOrders();

    const qrCode = data.order.qrCodeUrl
      ? `<img class="order-qr order-qr-shake" src="${data.order.qrCodeUrl}" alt="订单二维码" role="button" tabindex="0" />`
      : "";
    els.smartResult.innerHTML = `
      <p><strong>订单已创建</strong></p>
      <p><strong>门店：</strong>${data.store.deptName}</p>
      <p><strong>商品：</strong>${data.product.productName} × ${data.intent.amount}</p>
      <p><strong>应付：</strong>${formatMoney(data.order.discountPrice ?? data.preview.discountPrice)}</p>
      <p><strong>订单号：</strong>${data.order.orderId}</p>
      ${qrCode}
    `;
    bindOrderQrInteractions(els.smartResult);
  } catch (error) {
    els.smartResult.classList.add("empty");
    els.smartResult.textContent = error.message;
  } finally {
    els.smartCreateBtn.disabled = false;
    els.smartCreateBtn.textContent = "一键下单";
  }
}

async function queryOrderStatus(orderId) {
  const data = await api("api/orders/status", {
    method: "POST",
    body: JSON.stringify({ orderId })
  });
  const order = data.order;
  const code = order.takeMealCodeInfo?.code ? `，取餐码 ${order.takeMealCodeInfo.code}` : "";
  notify(`订单状态：${order.orderStatusName}${code}`);
}

async function refreshOrders() {
  const btn = els.refreshOrdersBtn;
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "刷新中…";
  try {
    const data = await api("api/orders", { method: "GET" });
    if (!data.orders.length) {
      els.orderList.innerHTML = '<div class="result-card empty">还没有订单记录，下单后会显示在这里。</div>';
      return;
    }

    els.orderList.innerHTML = "";

    for (const order of data.orders) {
      const node = els.orderTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector(".order-title").textContent = `${order.product.productName} × ${order.amount}`;
      setBadge(node.querySelector(".order-time"), order.createdAtLabel, "muted");
      node.querySelector(".order-meta").textContent = `${order.store.deptName} · ${formatMoney(order.discountPrice)}`;
      node.querySelector(".order-id").textContent = `订单号 ${order.orderId}`;

      const actions = node.querySelector(".order-actions");

      const statusBtn = document.createElement("button");
      statusBtn.className = "button button-ghost";
      statusBtn.textContent = "查状态";
      statusBtn.addEventListener("click", async () => {
        try {
          await queryOrderStatus(order.orderId);
        } catch (error) {
          notify(error.message);
        }
      });
      actions.appendChild(statusBtn);

      if (order.qrCodeUrl) {
        const qrBtn = document.createElement("button");
        qrBtn.className = "button";
        qrBtn.textContent = "支付码";
        qrBtn.addEventListener("click", () => openQrModal(order.qrCodeUrl));
        actions.appendChild(qrBtn);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "button button-danger";
      deleteBtn.textContent = "删除";
      deleteBtn.addEventListener("click", async () => {
        if (!window.confirm("删除这条订单记录？")) return;
        try {
          await api(`api/orders/${order.id}`, { method: "DELETE" });
          await refreshOrders();
        } catch (error) {
          notify(error.message);
        }
      });
      actions.appendChild(deleteBtn);

      els.orderList.appendChild(node);
    }
  } catch (error) {
    els.orderList.innerHTML = `<div class="result-card">${error.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

bindVoiceInput();
els.geoBtn.addEventListener("click", locatePrecisely);
els.smartCreateBtn.addEventListener("click", smartCreateOrder);
els.smartPrompt.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  smartCreateOrder();
});
els.storeSearchBtn.addEventListener("click", searchStores);
els.storeKeyword.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  searchStores();
});
els.productSearchBtn.addEventListener("click", searchProducts);
els.amountMinusBtn.addEventListener("click", () => setAmount(getAmount() - 1));
els.amountPlusBtn.addEventListener("click", () => setAmount(getAmount() + 1));
els.amount.addEventListener("change", () => setAmount(els.amount.value));
els.confirmProductBtn.addEventListener("click", confirmProductSelection);
els.refreshOrdersBtn.addEventListener("click", refreshOrders);
els.qrModal.addEventListener("click", closeQrModal);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.qrModal.classList.contains("hidden")) {
    closeQrModal();
  }
});

updateSelectionSummary();
renderLocationSummary();
refreshHealth();
refreshOrders();
