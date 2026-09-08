'use strict';
// LLM 翻译（OpenAI 兼容接口，默认火山方舟；指向内部网关时改 MT_BASE_URL 即可）

async function translateZhToEn(text) {
  const baseUrl = process.env.MT_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MT_API_KEY || process.env.ARK_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.MT_MODEL || process.env.ARK_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a professional interpreter in a business meeting. Translate the Chinese sentence into natural, fluent English. Output ONLY the English translation, no quotes, no explanation. Keep proper nouns as-is.',
        },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`MT ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

module.exports = { translateZhToEn };
