'use strict';
// 豆包大模型（火山方舟 Ark）中→英翻译

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

async function translateZhToEn(text) {
  const res = await fetch(ARK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ARK_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.ARK_MODEL,
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
  if (!res.ok) {
    throw new Error(`Ark ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

module.exports = { translateZhToEn };
