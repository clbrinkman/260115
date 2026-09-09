'use strict';
// 会议纪要：用 LLM 从带说话人标记的转写中抽取 参会人观点/关键结论/待办
// OpenAI 兼容接口，LLM_BASE_URL/LLM_API_KEY/LLM_MODEL 可配（默认火山方舟）

const CHUNK_CHARS = 6000;

async function callLlm(messages, maxTokens = 1600) {
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'deepseek-chat',
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 未返回纪要内容');
  return content.trim();
}

function splitTranscript(lines) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > CHUNK_CHARS) {
      chunks.push(current);
      current = '';
    }
    current += `${current ? '\n' : ''}${line}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

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
  const chunks = splitTranscript(lines);
  let source;
  if (chunks.length === 1) {
    source = chunks[0];
  } else {
    // 长会议先逐段提炼，再综合，避免只保留会议末尾。
    const partials = [];
    // 每批最多3段，兼顾总耗时与模型服务限流。
    for (let start = 0; start < chunks.length; start += 3) {
      const batch = chunks.slice(start, start + 3);
      const results = await Promise.all(batch.map((chunk, offset) => {
        const i = start + offset;
        return callLlm([
          {
            role: 'system',
            content:
              '提炼这段会议转写，保留说话人观点、明确结论、待办负责人和时间节点。' +
              '不要补充原文没有的信息，控制在600字以内。',
          },
          { role: 'user', content: `第${i + 1}/${chunks.length}段：\n${chunk}` },
        ], 1000);
      }));
      partials.push(...results);
    }
    source = partials.map((text, i) => `【分段${i + 1}】\n${text}`).join('\n\n');
  }

  return callLlm([
        {
          role: 'system',
          content:
            '你是会议纪要助手。根据带说话人标记的会议转写，输出简短纪要，严格按这三节：\n' +
            '【参会人】列出识别到的说话人，每人一两句概括其立场/主要观点\n' +
            '【关键结论】不超过5条\n' +
            '【待办事项】谁+做什么+时间节点，转写中没明确负责人就标「待定」；没有待办就写「无」\n' +
            '要求：中文、简洁、不编造转写中没有的信息。',
        },
        { role: 'user', content: source },
      ], 1800);
}

module.exports = { summarizeMeeting };
