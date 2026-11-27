// FlClash 扩展脚本（脚本模式）
// FlClash -> 扩展 -> 扩展模式选「脚本」-> 新建脚本，粘贴本文件内容，保存并启用
// 作用：为自建节点订阅补全 proxy-groups（策略组）与 rules（分流规则）
// 内核要求：Mihomo / Clash.Meta（支持 GEOSITE、GEOIP、AND 逻辑规则）
//
// ==== 使用注意（踩过的坑，别改回去）====
// 1. DNS 的 listen 绝对不能写 :53。Android 非 root 应用无法绑 1024 以下端口，
//    mihomo 会 bind: permission denied，TUN 又把系统 DNS 全劫到那个死端口，
//    结果「规则/全局/直连」三种模式全部解析失败 = 彻底断网。这里统一改到 1053。
// 2. 不要在脚本里写死 config.mode，否则 App 里切的「全局/直连」会被覆盖回 rule。
// 3. nameserver-policy 里用代理组做 DNS 出口时，必须同时给 proxy-server-nameserver，
//    否则节点域名解析环回，查询挂起超时。
// 4. Mihomo 对节点超时/心跳等参数要求纯整数（而不是 sing-box 风格的 "30s" / "1m"），
//    例如 anytls 的 idle-session-check-interval / idle-session-timeout（秒）、
//    tuic 的 heartbeat-interval / request-timeout（毫秒）。main(config) 必须先清洗 config.proxies。

function main(config) {
  config = config || {};

  // ---------- 节点参数清洗 ----------
  // 部分订阅（如 sing-box 转换）会输出带单位的时长字符串（如 "30s" / "1m"），
  // 但 Mihomo 内核的 structure.Decoder 按 int 解析，会报 strconv.ParseInt invalid syntax。
  const parseDuration = (val, targetUnit) => {
    if (val === null || val === undefined) return undefined;
    if (typeof val === "number") {
      return Number.isFinite(val) && val >= 0 ? Math.round(val) : undefined;
    }
    if (typeof val !== "string") return undefined;
    const s = val.trim();
    if (!s) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s));
    if (!/^(?:\d+(?:\.\d+)?\s*(?:ms|us|\u00b5s|\u03bcs|ns|s|m|h)\s*)+$/i.test(s)) {
      return undefined;
    }
    const unitToMs = {
      ns: 1e-6,
      us: 1e-3,
      "\u00b5s": 1e-3,
      "\u03bcs": 1e-3,
      ms: 1,
      s: 1000,
      m: 60000,
      h: 3600000,
    };
    const tokenRe = /(\d+(?:\.\d+)?)\s*(ms|us|\u00b5s|\u03bcs|ns|s|m|h)/gi;
    let totalMs = 0;
    let match;
    while ((match = tokenRe.exec(s)) !== null) {
      totalMs += Number(match[1]) * unitToMs[match[2].toLowerCase()];
    }
    if (!Number.isFinite(totalMs)) return undefined;
    if (totalMs === 0) return 0;
    if (targetUnit === "ms") return Math.max(1, Math.round(totalMs));
    return Math.max(1, Math.round(totalMs / 1000));
  };

  const parseIntField = (val) => {
    if (typeof val === "number") {
      return Number.isFinite(val) ? Math.round(val) : undefined;
    }
    if (typeof val !== "string") return undefined;
    const s = val.trim();
    return /^-?\d+(?:\.\d+)?$/.test(s) ? Math.round(Number(s)) : undefined;
  };

  const SECONDS_INT_FIELDS = [
    "idle-session-check-interval",
    "idle-session-timeout",
    "handshake-timeout",
    "persistent-keepalive",
    "refresh-server-ip-interval",
    "ping",
    "ping-restart",
  ];
  const MS_INT_FIELDS = [
    "heartbeat-interval",
    "request-timeout",
    "keep-alive-interval",
  ];
  const PLAIN_INT_FIELDS = ["min-idle-session"];

  const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const normalizeField = (obj, k, parser) => {
    if (!has(obj, k)) return;
    const v = parser(obj[k]);
    if (v === undefined) delete obj[k];
    else obj[k] = v;
  };
  const fieldParsers = [
    [SECONDS_INT_FIELDS, (v) => parseDuration(v, "s")],
    [MS_INT_FIELDS, (v) => parseDuration(v, "ms")],
    [PLAIN_INT_FIELDS, parseIntField],
  ];

  const sanitizeProxy = (p) => {
    if (!p || typeof p !== "object") return;
    fieldParsers.forEach(([fields, parser]) => {
      fields.forEach((k) => normalizeField(p, k, parser));
    });
    if (has(p, "hop-interval")) {
      if (p.type === "hysteria2") {
        const raw = p["hop-interval"];
        const rangeMatch =
          typeof raw === "string"
            ? /^\s*([^-]+?)\s*-\s*([^-]+?)\s*$/.exec(raw)
            : null;
        if (rangeMatch) {
          const a = parseDuration(rangeMatch[1], "s");
          const b = parseDuration(rangeMatch[2], "s");
          if (a !== undefined && b !== undefined) {
            p["hop-interval"] = `${a}-${b}`;
          } else {
            delete p["hop-interval"];
          }
        } else {
          const v = parseDuration(raw, "s");
          if (v === undefined) delete p["hop-interval"];
          else p["hop-interval"] = String(v);
        }
      } else {
        normalizeField(p, "hop-interval", (v) => parseDuration(v, "s"));
      }
    }
  };

  if (Array.isArray(config.proxies)) {
    config.proxies.forEach(sanitizeProxy);
  }

  const proxies = (config.proxies || []).map((p) => p.name);
  if (!proxies.length) return config;

  // 是否拒绝 UDP 443（QUIC）。
  // ★ 默认关闭：Google Play 的下载器走 QUIC 且回退很差，
  //   一拦 UDP 443，商店就表现为所有项目「等待中…」/「无法更新」。
  //   想省 YouTube 的 QUIC 带宽就改 true，但要知道 Play 可能会卡。
  const QUIC_REJECT = false;

  // Play 下载 CDN 开关（规则与 DNS 会一起跟着变，不要只改一半）。
  // true  = dl.google.com / gvt / xn--ngstr 直连 + 国内 DNS 解析（联通 GGC 更快）
  // false = 全部走代理 + 经代理解析（拿不到国内 GGC、下载一直「等待中」时用这个）
  // ★ 默认 false：Play 全部卡「等待中」时，直连 CDN 是最常见的元凶。
  const PLAY_CDN_DIRECT = false;
  const PLAY_CDN = PLAY_CDN_DIRECT ? "DIRECT" : "🚀 节点选择";
  // 下载域名的 DNS 解析出口必须跟代理出口一致：
  // 直连时用国内 DNS 拿 GGC，走代理时必须用「干净解析」，否则拿到的是国内视角的 IP。
  const PLAY_CDN_DNS = PLAY_CDN_DIRECT
    ? ["https://223.5.5.5/dns-query"]
    : ["https://1.1.1.1/dns-query#🚀 节点选择"];

  // ---------- 节点自动归类 ----------
  // 短英文标签（us / sg / jp / hk）必须按词边界匹配，
  // 否则 "us" 会命中 australia / plus / business，节点串组。
  const pick = (kws) =>
    proxies.filter((n) => {
      const s = n.toLowerCase();
      return kws.some((k) => {
        const kk = k.toLowerCase();
        if (/^[a-z]{2,3}$/.test(kk)) {
          return new RegExp("(^|[^a-z])" + kk + "([^a-z]|$)").test(s);
        }
        return s.indexOf(kk) !== -1;
      });
    });

  const hk = pick(["香港", "hk", "hongkong", "🇭🇰"]);
  const mo = pick(["澳门", "macau", "macao", "🇲🇴"]);
  const jp = pick(["日本", "jp", "japan", "东京", "tokyo", "大阪", "osaka", "🇯🇵"]);
  const sg = pick(["新加坡", "sg", "singapore", "狮城", "🇸🇬"]);
  const us = pick([
    "美国", "us", "united states", "洛杉矶", "los angeles",
    "圣何塞", "san jose", "西雅图", "seattle", "🇺🇸",
  ]);

  const used = [];
  [hk, mo, jp, sg, us].forEach((list) =>
    list.forEach((n) => used.indexOf(n) === -1 && used.push(n))
  );
  const others = proxies.filter((n) => used.indexOf(n) === -1);

  const urlTest = (name, list) => ({
    name: name,
    type: "url-test",
    proxies: list,
    url: "http://cp.cloudflare.com/generate_204",
    interval: 300,
    tolerance: 150,
    lazy: true,
  });

  // ---------- 策略组 ----------
  const groups = [];
  const regionNames = [];
  const addRegion = (name, list) => {
    if (!list.length) return;
    groups.push(urlTest(name, list));
    regionNames.push(name);
  };

  addRegion("🇭🇰 香港节点", hk);
  addRegion("🇲🇴 澳门节点", mo);
  addRegion("🇯🇵 日本节点", jp);
  addRegion("🇸🇬 新加坡节点", sg);
  addRegion("🇺🇸 美国节点", us);

  const service = (name) => ({
    name: name,
    type: "select",
    proxies: ["♻️ 自动选择", "🚀 节点选择", "DIRECT"],
  });

  groups.unshift(
    {
      name: "🚀 节点选择",
      type: "select",
      proxies: ["♻️ 自动选择", "DIRECT"].concat(regionNames),
    },
    {
      name: "♻️ 自动选择",
      type: "url-test",
      proxies: proxies,
      url: "http://cp.cloudflare.com/generate_204",
      interval: 300,
      tolerance: 150,
      lazy: true,
    },
    service("🤖 AI 服务"),
    service("▶️ YouTube")
  );
  if (others.length)
    groups.push({ name: "🌍 其他节点", type: "select", proxies: others });

  groups.push({
    name: "🚫 广告拦截",
    type: "select",
    proxies: ["REJECT", "DIRECT"],
    hidden: true,
  });
  groups.push({
    name: "🐟 漏网之鱼",
    type: "select",
    proxies: ["♻️ 自动选择", "🚀 节点选择", "DIRECT"],
  });

  config["proxy-groups"] = groups;

  // ---------- 分流规则 ----------
  const rules = [
    // 广告
    "GEOSITE,category-ads-all,🚫 广告拦截",

    // 局域网 / 私有地址直连
    "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
    "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
    "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
    "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
    "IP-CIDR,169.254.0.0/16,DIRECT,no-resolve",
    "IP-CIDR,100.64.0.0/10,DIRECT,no-resolve",
    "IP-CIDR6,::1/128,DIRECT,no-resolve",
    "IP-CIDR6,fc00::/7,DIRECT,no-resolve",
    "IP-CIDR6,fe80::/10,DIRECT,no-resolve",

    // AI 服务
    "GEOSITE,category-ai-!cn,🤖 AI 服务",
    "DOMAIN-SUFFIX,openai.com,🤖 AI 服务",
    "DOMAIN-SUFFIX,chatgpt.com,🤖 AI 服务",
    "DOMAIN-SUFFIX,oaistatic.com,🤖 AI 服务",
    "DOMAIN-SUFFIX,oaiusercontent.com,🤖 AI 服务",
    "DOMAIN-SUFFIX,sora.com,🤖 AI 服务",
    "DOMAIN-SUFFIX,anthropic.com,🤖 AI 服务",
    "DOMAIN-SUFFIX,claude.ai,🤖 AI 服务",
    "DOMAIN,gemini.google.com,🤖 AI 服务",
    "DOMAIN,aistudio.google.com,🤖 AI 服务",
    "DOMAIN-SUFFIX,generativelanguage.googleapis.com,🤖 AI 服务",
    "DOMAIN-SUFFIX,grok.com,🤖 AI 服务",
    "DOMAIN-SUFFIX,x.ai,🤖 AI 服务",
    "DOMAIN-SUFFIX,perplexity.ai,🤖 AI 服务",

    // ★ Play 下载 CDN：国内有联通 GGC 节点，直连通常更快。
    //   但若下载一直卡 0% / 等待中（网络拿不到国内 GGC），
    //   把上面 PLAY_CDN_DIRECT 改成 false 让它们全部走代理。
    //   这几条必须排在任何 google / google-play 代理规则之前（规则首个命中即止）。
    `DOMAIN-SUFFIX,dl.google.com,${PLAY_CDN}`,
    `DOMAIN-SUFFIX,xn--ngstr-lra8j.com,${PLAY_CDN}`,
    `DOMAIN-SUFFIX,gvt1.com,${PLAY_CDN}`,
    `DOMAIN-SUFFIX,gvt2.com,${PLAY_CDN}`,
    `DOMAIN-SUFFIX,gvt3.com,${PLAY_CDN}`,

    // googlevideo 走代理，与 nameserver-policy 里的干净解析保持一致
    "DOMAIN,redirector.googlevideo.com,▶️ YouTube",
    "DOMAIN-SUFFIX,googlevideo.com,▶️ YouTube",

    // YouTube 页面 / 封面 / 播放接口
    "GEOSITE,youtube,▶️ YouTube",
    "DOMAIN-SUFFIX,youtube.com,▶️ YouTube",
    "DOMAIN-SUFFIX,ytimg.com,▶️ YouTube",
    "DOMAIN-SUFFIX,youtubei.googleapis.com,▶️ YouTube",

    // 注意：不要在这里加 GEOSITE,google-cn,DIRECT。
    // google-cn 里含 dl-ssl.google.com 等仍在境外的下载域名，
    // 一旦整组直连，Play 商店会表现为全部「等待中…」。

    // Google Play 商店 API（下载 CDN 已在上面拦走）
    "GEOSITE,google-play,🚀 节点选择",
    "DOMAIN-SUFFIX,play.google.com,🚀 节点选择",
    "DOMAIN-SUFFIX,play.googleapis.com,🚀 节点选择",
    "DOMAIN-SUFFIX,android.clients.google.com,🚀 节点选择",
    "DOMAIN-SUFFIX,android.googleapis.com,🚀 节点选择",

    // dl-ssl 名字像下载域名，但解析到境外 IP，直连必挂 → 走代理
    "DOMAIN-SUFFIX,dl-ssl.google.com,🚀 节点选择",

    // 商店资源
    "DOMAIN-SUFFIX,ggpht.com,🚀 节点选择",
    "DOMAIN-SUFFIX,gstatic.com,🚀 节点选择",
    "DOMAIN-SUFFIX,googleusercontent.com,🚀 节点选择",

    // ★ Google 的 .cn 端点（services.googleapis.cn 等）实际解析到境外 IP、已被墙。
    //   直连只会 0 B/s 超时，Play 客户端在设备注册/账号校验这步挂住，
    //   表现就是商店「所有项目一直等待中」。必须走代理，且要排在 GEOSITE,cn 之前。
    "DOMAIN-SUFFIX,googleapis.cn,🚀 节点选择",
    "DOMAIN-SUFFIX,services.googleapis.cn,🚀 节点选择",

    // 苹果服务（国内直连）
    "GEOSITE,apple-cn,DIRECT",

    // 国内直连
    "GEOSITE,cn,DIRECT",
    "GEOSITE,geolocation-cn,DIRECT",
    "GEOIP,CN,DIRECT,no-resolve",
    "DOMAIN-SUFFIX,163.com,DIRECT",
    "DOMAIN-SUFFIX,qq.com,DIRECT",
  ];

  // 拒绝 QUIC(UDP 443)，让应用回退到 TCP。
  // 放在国内直连规则之后：国内应用的 QUIC 照常直连，只有要走代理的才被拒。
  // 排查「全断」时先把上面的 QUIC_REJECT 改成 false，排除这条的影响。
  if (QUIC_REJECT) rules.push("AND,((NETWORK,UDP),(DST-PORT,443)),REJECT");

  // 兜底
  rules.push("MATCH,🐟 漏网之鱼");

  config.rules = rules;

  // ---------- 基础设置 ----------
  config["mixed-port"] = config["mixed-port"] || 7890;
  config["allow-lan"] = config["allow-lan"] !== undefined ? config["allow-lan"] : true;
  // 不写 config.mode：脚本里钉死 mode 会覆盖 App 里的「规则 / 全局 / 直连」切换
  config["log-level"] = config["log-level"] || "info";
  config["ipv6"] = config.ipv6 !== undefined ? config.ipv6 : false;
  config["unified-delay"] = true;
  config["tcp-concurrent"] = true;
  config["find-process-mode"] = "strict";
  config["global-client-fingerprint"] = "chrome";
  config["profile"] = Object.assign(
    { "store-selected": true, "store-fake-ip": true },
    config.profile || {}
  );

  // ---------- DNS ----------
  // 与订阅 / FlClash 自带 dns 合并：自带的键优先，只补缺的，并强制修掉特权端口。
  const FAKE_IP_FILTER = [
    "*.lan",
    "*.local",
    "*.localdomain",
    "*.home.arpa",
    "localhost.*",
    "time.*",
    "time1.*",
    "ntp.*",
    "*.ntp.org",
    "stun.*",
    "*.stun.*",
    "+.stun.*",
    "+.msftconnecttest.com",
    "+.msftncsi.com",
    "*.push.apple.com",
    "+.push.apple.com",
  ];

  const NS_DOMESTIC = [
    "https://223.5.5.5/dns-query",
    "https://doh.pub/dns-query",
  ];

  const DNS_DEFAULTS = {
    enable: true,
    // ★ 关键：绝不能是 :53（Android 无法绑特权端口）
    listen: "127.0.0.1:1053",
    "enhanced-mode": "fake-ip",
    "fake-ip-range": "198.18.0.1/16",
    ipv6: false,
    "default-nameserver": ["223.5.5.5", "119.29.29.29"],
    // 解析「节点服务器域名」用的解析器。用代理组做 DNS 出口时必须有它，否则环回。
    "proxy-server-nameserver": NS_DOMESTIC,
    nameserver: NS_DOMESTIC,

    // ★ 按域名指定解析器（关键）
    //   Play 下载域名 → 解析出口跟着 PLAY_CDN 开关走（见文件头部开关）
    //   googlevideo  → 必须「干净解析」（经代理查询），国内 DNS 对它是投毒的
    //   注意：加密 DNS ≠ 干净 DNS。墙内的 DoH（如阿里）一样会返回假 IP，
    //         判断标准是「解析器在墙的哪一边」，不是「是否加密」。
    "nameserver-policy": {
      "dl.google.com": PLAY_CDN_DNS,
      "+.dl.google.com": PLAY_CDN_DNS,
      "+.gvt1.com": PLAY_CDN_DNS,
      "+.gvt2.com": PLAY_CDN_DNS,
      "+.gvt3.com": PLAY_CDN_DNS,
      "+.xn--ngstr-lra8j.com": PLAY_CDN_DNS,
      "+.googlevideo.com": ["https://1.1.1.1/dns-query#🚀 节点选择"],
    },
  };

  // 特权端口（<1024）在 Android 上绑不上，一律改到 1053
  const safeListen = (l) => {
    if (!l) return "127.0.0.1:1053";
    const m = /:(\d+)\s*$/.exec(String(l));
    return m && Number(m[1]) < 1024 ? "127.0.0.1:1053" : l;
  };

  const baseDns = config.dns || {};
  const dns = Object.assign({}, DNS_DEFAULTS, baseDns);

  dns.listen = safeListen(dns.listen);

  // fake-ip-filter 一定保留，否则投屏 / 本地服务 / NTP / 连通性检测全挂
  dns["fake-ip-filter"] = []
    .concat(baseDns["fake-ip-filter"] || [], FAKE_IP_FILTER)
    .filter((v, i, a) => a.indexOf(v) === i);

  dns["proxy-server-nameserver"] =
    dns["proxy-server-nameserver"] || DNS_DEFAULTS["proxy-server-nameserver"];

  dns["nameserver-policy"] = Object.assign(
    {},
    DNS_DEFAULTS["nameserver-policy"],
    baseDns["nameserver-policy"] || {}
  );

  config.dns = dns;

  return config;
}
