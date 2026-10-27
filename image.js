// Vercel Serverless Function — Cloudflare Workers AI দিয়ে ছবি বানায়।
// টোকেন এখানেই (সার্ভারে) থাকে, ব্রাউজারে কখনো যায় না।
// Vercel → Settings → Environment Variables: CF_ACCOUNT_ID, CF_API_TOKEN, (ঐচ্ছিক) APP_PASSWORD

const MODELS = {
  flux: "@cf/black-forest-labs/flux-1-schnell",
  sdxl: "@cf/stabilityai/stable-diffusion-xl-base-1.0"
};

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "শুধু POST চলবে।" });

  const acc = process.env.CF_ACCOUNT_ID;
  const tok = process.env.CF_API_TOKEN;
  if (!acc || !tok) {
    return res.status(500).json({ code: "NOENV", error: "Vercel-এ CF_ACCOUNT_ID ও CF_API_TOKEN সেট করা নেই (সেট করার পর Redeploy দিন)।" });
  }
  const pass = process.env.APP_PASSWORD;
  if (pass && req.headers["x-app-pass"] !== pass) {
    return res.status(401).json({ code: "BADPASS", error: "অ্যাক্সেস পাসওয়ার্ড ভুল বা দেওয়া হয়নি।" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  let prompt = String(body.prompt || "").trim();
  // "Avoid: ..." লাইনটা আলাদা করা হয় — ছবির মডেল "no people" লিখলেও মানুষ আঁকে ফেলতে পারে
  let negative = "";
  prompt = prompt.replace(/\n?Avoid:\s*([^\n]*)/i, (m, a) => { negative = a.trim(); return ""; }).trim().slice(0, 2000);
  if (prompt.length < 3) return res.status(400).json({ error: "প্রম্পট খালি।" });

  const key = body.model === "sdxl" ? "sdxl" : "flux";
  const portrait = body.ratio === "9:16";
  const width = portrait ? 576 : 1024;
  const height = portrait ? 1024 : 576;
  const payload = key === "flux"
    ? { prompt, steps: 6 }
    : Object.assign({ prompt, width, height, num_steps: 20 }, negative ? { negative_prompt: negative } : {});

  let r;
  try {
    r = await fetch("https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(acc) + "/ai/run/" + MODELS[key], {
      method: "POST",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return res.status(502).json({ code: "NET", error: "Cloudflare-এ পৌঁছানো যায়নি: " + e.message });
  }

  const ct = r.headers.get("content-type") || "";
  if (!r.ok) {
    let msg = "HTTP " + r.status;
    try {
      const j = await r.json();
      msg = (j.errors && j.errors[0] && j.errors[0].message) || JSON.stringify(j).slice(0, 300);
    } catch (e) {}
    const quota = r.status === 429 || /neuron|daily free allocation/i.test(msg);
    return res.status(quota ? 429 : r.status).json({ code: quota ? "QUOTA" : "CF", error: msg });
  }

  try {
    if (ct.includes("application/json")) {
      const j = await r.json();
      const img = j && j.result && j.result.image;
      if (!img) return res.status(502).json({ code: "NOIMG", error: "Cloudflare ছবি ফেরত দেয়নি।" });
      return res.status(200).json({ image: img, mime: "image/jpeg", model: key });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return res.status(502).json({ code: "NOIMG", error: "খালি ছবি এসেছে।" });
    return res.status(200).json({ image: buf.toString("base64"), mime: ct.split(";")[0] || "image/png", model: key });
  } catch (e) {
    return res.status(502).json({ code: "NOIMG", error: "ছবি পড়তে সমস্যা: " + e.message });
  }
};
