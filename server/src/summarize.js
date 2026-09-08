'use strict';
// 会议纪要：用 LLM 从带说话人标记的转写中抽取 参会人观点/关键结论/待办
// OpenAI 兼容接口，LLM_BASE_URL/LLM_API_KEY/LLM_MODEL 可配（默认火山方舟）

const MAX_TRANSCRIPT_CHARS = 8000;

async function summarizeMeeting(transcript) {
  // transcript: [{speaker: number|null, text: string}]
  if (!transcript.length) throw new Error('还没有转写内容');
  if (!process.env.LLM_API_KEY) {
    throw new Error('未配置 LLM_API_KEY（会议纪要用的 LLM Key，默认 DeepSeek）');
  }

  let lines = transcript.map((u) => {
    const who = u.speaker == null ? '说话人' : `说话人${u.speaker + 1}`;
    return `${who}：${u.text}`;
  });
  let text = lines.join('\n');
  // 超长截尾：保留最近的讨论（结论和待办通常在后面）
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = '……（前文略）\n' + text.slice(-MAX_TRANSCRIPT_CHARS);
  }

  const baseUrl = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content:
            '你是会议纪要助手。根据带说话人标记的会议转写，输出简短纪要，严格按这三节：\n' +
            '【参会人】列出识别到的说话人，每人一两句概括其立场/主要观点\n' +
            '【关键结论】不超过5条\n' +
            '【待办事项】谁+做什么+时间节点，转写中没明确负责人就标「待定」；没有待办就写「无」\n' +
            '要求：中文、简洁、不编造转写中没有的信息。',
        },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

module.exports = { summarizeMeeting };
