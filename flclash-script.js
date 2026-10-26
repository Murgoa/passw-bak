// FlClash 扩展脚本（脚本模式）
// FlClash -> 扩展 -> 扩展模式选「脚本」-> 新建脚本，粘贴本文件内容，保存并启用
// 作用：为自建节点订阅补全 proxy-groups（策略组）与 rules（分流规则）
// 内核要求：Mihomo / Clash.Meta（支持 GEOSITE、GEOIP）

function main(config) {
  config = config || {};
  const proxies = (config.proxies || []).map((p) => p.name);
  if (!proxies.length) return config;

  // ---------- 节点自动归类 ----------
  const pick = (kws) =>
    proxies.filter((n) =>
      kws.some((k) => n.toLowerCase().includes(k.toLowerCase()))
    );

  const hk = pick(["香港", "hk", "hongkong"]);
  const mo = pick(["澳门", "macau", "macao", "🇲🇴"]);
  const jp = pick(["日本", "jp", "japan", "东京", "tokyo"]);
  const sg = pick(["新加坡", "sg", "singapore"]);
  const us = pick(["美国", "us", "洛杉矶", "los angeles"]);

  const used = [].concat(hk, mo, jp, sg, us);
  const others = proxies.filter((n) => used.indexOf(n) === -1);

  const urlTest = (name, list) => ({
    name: name,
    type: "url-test",
    proxies: list,
    url: "http://www.gstatic.com/generate_204",
    interval: 300,
    tolerance: 50,
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
      url: "http://www.gstatic.com/generate_204",
      interval: 300,
      tolerance: 50,
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

    // YouTube
    "GEOSITE,youtube,▶️ YouTube",

    // 苹果服务（国内直连）
    "GEOSITE,apple-cn,DIRECT",

    // 国内直连
    "GEOSITE,cn,DIRECT",
    "GEOIP,CN,DIRECT,no-resolve",
    "GEOSITE,geolocation-cn,DIRECT",
    "DOMAIN-SUFFIX,163.com,DIRECT",
    "DOMAIN-SUFFIX,qq.com,DIRECT",
    "DOMAIN-SUFFIX,weixin.qq.com,DIRECT",

    // 兜底
    "MATCH,🐟 漏网之鱼",
  ];

  config.rules = rules;

  // ---------- 基础设置 ----------
  config["mixed-port"] = config["mixed-port"] || 7890;
  config["allow-lan"] = config["allow-lan"] !== undefined ? config["allow-lan"] : true;
  config["mode"] = config.mode || "rule";
  config["log-level"] = config["log-level"] || "info";
  config["ipv6"] = config.ipv6 !== undefined ? config.ipv6 : true;
  config["unified-delay"] = true;
  config["tcp-concurrent"] = true;
  config["find-process-mode"] = "strict";
  config["global-client-fingerprint"] = "chrome";
  config["profile"] = Object.assign(
    { "store-selected": true, "store-fake-ip": true },
    config.profile || {}
  );

  // DNS：交给 FlClash 内置 DNS，避免污染
  if (!config.dns) {
    config.dns = {
      enable: true,
      listen: "0.0.0.0:53",
      "enhanced-mode": "fake-ip",
      "fake-ip-range": "198.18.0.1/16",
      "default-nameserver": ["223.5.5.5", "119.29.29.29"],
      nameserver: [
        "https://223.5.5.5/dns-query",
        "https://doh.pub/dns-query",
      ],
      fallback: [
        "https://1.1.1.1/dns-query",
        "https://dns.google/dns-query",
      ],
      "fallback-filter": {
        geoip: true,
        "geoip-code": "CN",
        geosite: ["gfw"],
      },
    };
  }

  return config;
}
