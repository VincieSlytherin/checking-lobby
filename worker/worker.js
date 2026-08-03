const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

const MAX_BODY_BYTES = 32 * 1024;

class UpstreamError extends Error {
  constructor(status) {
    super(`Gemini upstream status ${status}`);
    this.name = 'UpstreamError';
    this.upstreamStatus = status;
  }
}

function allowedOrigins(env) {
  return new Set((env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
}

function corsHeaders(origin, env) {
  if (!allowedOrigins(env).has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

function jsonResponse(body, status, origin, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin, env) }
  });
}

function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(a || '');
  const right = new TextEncoder().encode(b || '');
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i++) difference |= (left[i] || 0) ^ (right[i] || 0);
  return difference === 0;
}

async function googleRequest(model, operation, payload, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${operation}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    // Never forward Google's body to the browser: it may carry implementation
    // details. Logging it to the Worker's own console is safe, and a 400 says
    // exactly which field was rejected — visible via `wrangler tail`.
    const detail = await response.text().catch(() => '');
    console.error('Gemini upstream request failed', {
      model,
      operation,
      status: response.status,
      detail: detail.slice(0, 600)
    });
    throw new UpstreamError(response.status);
  }
  return response.json();
}

async function handleText(input, env) {
  if (typeof input.systemPrompt !== 'string' || typeof input.userPrompt !== 'string') {
    throw new TypeError('Invalid text request');
  }
  if (input.systemPrompt.length > 6000 || input.userPrompt.length > 12000) {
    throw new RangeError('Prompt is too large');
  }

  const payload = {
    contents: [{ parts: [{ text: input.userPrompt }] }],
    systemInstruction: { parts: [{ text: input.systemPrompt }] }
  };
  if (input.jsonSchema && typeof input.jsonSchema === 'object') {
    payload.generationConfig = {
      responseMimeType: 'application/json',
      responseSchema: input.jsonSchema
    };
  }

  const result = await googleRequest('gemini-3.5-flash-lite', 'generateContent', payload, env);
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty model response');
  return { text };
}

// Image generation is billed per image and has no free tier, so it stays off
// until ENABLE_IMAGE_GENERATION is explicitly set to "true".
const IMAGE_MODEL = 'gemini-3.1-flash-image';
const IMAGE_DAILY_CAP = 20;

async function assertImageQuota(env) {
  // Optional: bind a KV namespace named IMAGE_QUOTA to enforce a daily ceiling.
  // Without the binding the cap is simply not applied.
  if (!env.IMAGE_QUOTA) return;

  const cap = Number(env.IMAGE_DAILY_CAP) || IMAGE_DAILY_CAP;
  const key = `images-${new Date().toISOString().split('T')[0]}`;
  const used = Number(await env.IMAGE_QUOTA.get(key)) || 0;

  if (used >= cap) throw new RangeError('今日图片生成额度已用尽');

  // Expires two days out so yesterday's counter cleans itself up.
  await env.IMAGE_QUOTA.put(key, String(used + 1), { expirationTtl: 172800 });
}

async function handleImage(input, env) {
  if (env.ENABLE_IMAGE_GENERATION !== 'true') {
    throw new TypeError('图片生成未启用');
  }
  if (typeof input.prompt !== 'string') {
    throw new TypeError('Invalid image request');
  }

  const prompt = input.prompt.trim();
  if (!prompt) throw new TypeError('Invalid image request');
  if (prompt.length > 2000) throw new RangeError('Prompt is too large');

  await assertImageQuota(env);

  const payload = {
    contents: [{
      parts: [{
        text: `A dark, melancholic Rusty Lake style illustration. Muted brass, rust and deep lake-green palette, candlelit gloom, vintage engraved texture. No text or lettering in the image. Scene: ${prompt}`
      }]
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      // v1beta GenerationConfig takes imageConfig; responseFormat belongs to the
      // newer Interactions API and is rejected here as an unknown field.
      imageConfig: { aspectRatio: '16:9' }
    }
  };

  let result;
  try {
    result = await googleRequest(IMAGE_MODEL, 'generateContent', payload, env);
  } catch (error) {
    // 403/429 on an image model is almost always a billing problem rather than
    // a transient one: these models have no free tier. Say so instead of
    // letting it surface as a generic "service unavailable".
    if (error instanceof UpstreamError && (error.upstreamStatus === 403 || error.upstreamStatus === 429)) {
      throw new TypeError('图片生成被 Gemini 拒绝：图片模型没有免费层，请确认该项目已启用结算并检查配额');
    }
    throw error;
  }

  const parts = result?.candidates?.[0]?.content?.parts || [];
  const image = parts.find(part => part?.inlineData?.data);
  if (!image) throw new Error('Empty image response');

  return { data: image.inlineData.data, mimeType: image.inlineData.mimeType || 'image/png' };
}

async function handleTts(input, env) {
  const allowedVoices = new Set(['Zephyr', 'Charon', 'Kore', 'Puck', 'Fenrir']);
  if (typeof input.text !== 'string' || input.text.length > 3000) {
    throw new TypeError('Invalid speech text');
  }
  const voice = allowedVoices.has(input.voice) ? input.voice : 'Zephyr';
  const payload = {
    contents: [{ parts: [{ text: `Say in an enigmatic, slow whisper: ${input.text}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
  const result = await googleRequest('gemini-3.1-flash-tts-preview', 'generateContent', payload, env);
  const part = result?.candidates?.[0]?.content?.parts?.[0];
  const data = part?.inlineData?.data;
  if (!data) throw new Error('Empty speech response');
  return { data, mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000' };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const requestId = crypto.randomUUID();

    if (!allowedOrigins(env).has(origin)) {
      return jsonResponse({ error: 'Origin not allowed', requestId }, 403, origin, env);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed', requestId }, 405, origin, env);
    }

    const suppliedToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!env.LODGE_ACCESS_TOKEN || !constantTimeEqual(suppliedToken, env.LODGE_ACCESS_TOKEN)) {
      return jsonResponse({ error: 'Unauthorized', requestId }, 401, origin, env);
    }
    if (!env.GEMINI_API_KEY) {
      return jsonResponse({ error: 'Service is not configured', requestId }, 503, origin, env);
    }

    const declaredLength = Number(request.headers.get('Content-Length') || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: 'Request too large', requestId }, 413, origin, env);
    }

    try {
      const rawBody = await request.text();
      if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
        return jsonResponse({ error: 'Request too large', requestId }, 413, origin, env);
      }
      const input = JSON.parse(rawBody);
      let output;
      if (input.action === 'health') output = { ok: true };
      else if (input.action === 'text') output = await handleText(input, env);
      else if (input.action === 'image') output = await handleImage(input, env);
      else if (input.action === 'tts') output = await handleTts(input, env);
      else return jsonResponse({ error: 'Unsupported action', requestId }, 400, origin, env);

      return jsonResponse({ ...output, requestId }, 200, origin, env);
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 502;
      const body = { error: status === 400 ? error.message : 'AI service unavailable', requestId };
      if (error instanceof UpstreamError) body.upstreamStatus = error.upstreamStatus;
      return jsonResponse(body, status, origin, env);
    }
  }
};
