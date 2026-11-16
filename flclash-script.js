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
      url: "http://www.gstatic.com/generate_204",
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

    // ★ Play 下载 CDN：国内有联通 GGC 节点，必须直连。
    //   送到海外代理会变成「美国服务器回连中国 CDN」，表现为下载卡 0%、转圈。
    //   这几条必须排在任何 google / google-play 代理规则之前（规则首个命中即止）。
    "DOMAIN-SUFFIX,dl.google.com,DIRECT",
    "DOMAIN-SUFFIX,xn--ngstr-lra8j.com,DIRECT",
    "DOMAIN-SUFFIX,gvt1.com,DIRECT",
    "DOMAIN-SUFFIX,gvt2.com,DIRECT",
    "DOMAIN-SUFFIX,gvt3.com,DIRECT",

    // ★ googlevideo 是「混合体」，不能整包走代理：
    //   rrN---sn-*.googlevideo.com → 真实 IP 是国内联通 GGC，只能直连
    //   redirector.googlevideo.com → 在境外，只能走代理
    //   若你的网络里 YouTube 反而变卡（说明拿到的是境外边缘节点），
    //   把下面这条 DIRECT 改成 ▶️ YouTube 即可，其余不用动。
    "DOMAIN,redirector.googlevideo.com,▶️ YouTube",
    "DOMAIN-SUFFIX,googlevideo.com,DIRECT",

    // YouTube 页面 / 封面 / 播放接口
    "GEOSITE,youtube,▶️ YouTube",
    "DOMAIN-SUFFIX,youtube.com,▶️ YouTube",
    "DOMAIN-SUFFIX,ytimg.com,▶️ YouTube",
    "DOMAIN-SUFFIX,youtubei.googleapis.com,▶️ YouTube",

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

    // 苹果服务（国内直连）
    "GEOSITE,apple-cn,DIRECT",

    // 国内直连
    "GEOSITE,cn,DIRECT",
    "GEOIP,CN,DIRECT,no-resolve",
    "GEOSITE,geolocation-cn,DIRECT",
    "DOMAIN-SUFFIX,163.com,DIRECT",
    "DOMAIN-SUFFIX,qq.com,DIRECT",
    "DOMAIN-SUFFIX,weixin.qq.com,DIRECT",
    // Google 中国区服务端点，实测国内解析 114.250.66.x、直连 0.5s
    "DOMAIN-SUFFIX,googleapis.cn,DIRECT",

    // 拒绝 QUIC(UDP 443)，让应用回退到 TCP。
    // 放在国内直连规则之后：国内应用的 QUIC 照常直连，只有要走代理的才被拒。
    "AND,((NETWORK,UDP),(DST-PORT,443)),REJECT",

    // 兜底
    "MATCH,🐟 漏网之鱼",
  ];

  config.rules = rules;

  // ---------- 基础设置 ----------
  config["mixed-port"] = config["mixed-port"] || 7890;
  config["allow-lan"] = config["allow-lan"] !== undefined ? config["allow-lan"] : true;
  config["mode"] = config.mode || "rule";
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

      // ★ 按域名指定解析器（关键）
      //   Play 下载域名 → 必须「国内视角」，才会返回国内联通 GGC，直连才快
      //   googlevideo  → 必须「干净解析」（经代理查询），国内 DNS 对它是投毒的
      //   注意：加密 DNS ≠ 干净 DNS。墙内的 DoH（如阿里）一样会返回假 IP，
      //         判断标准是「解析器在墙的哪一边」，不是「是否加密」。
      "nameserver-policy": {
        "dl.google.com": ["https://223.5.5.5/dns-query"],
        "+.dl.google.com": ["https://223.5.5.5/dns-query"],
        "+.gvt1.com": ["https://223.5.5.5/dns-query"],
        "+.gvt2.com": ["https://223.5.5.5/dns-query"],
        "+.gvt3.com": ["https://223.5.5.5/dns-query"],
        "+.xn--ngstr-lra8j.com": ["https://223.5.5.5/dns-query"],
        "+.googlevideo.com": ["https://1.1.1.1/dns-query#🚀 节点选择"],
      },
    };
  }

  return config;
}
