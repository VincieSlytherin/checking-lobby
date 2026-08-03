const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

const MAX_BODY_BYTES = 32 * 1024;

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
    // Do not forward Google's response body: it may contain implementation details.
    throw new Error(`Upstream request failed with status ${response.status}`);
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

  const result = await googleRequest('gemini-2.5-flash', 'generateContent', payload, env);
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty model response');
  return { text };
}

async function handleImage(input, env) {
  if (typeof input.prompt !== 'string' || input.prompt.length > 8000) {
    throw new TypeError('Invalid image prompt');
  }
  const payload = {
    instances: [{ prompt: `Vintage dark hand-drawn sepia woodcut illustration, gothic surreal lakeside lodge: ${input.prompt}` }],
    parameters: { sampleCount: 1 }
  };
  const result = await googleRequest('imagen-4.0-generate-001', 'predict', payload, env);
  const data = result?.predictions?.[0]?.bytesBase64Encoded;
  if (!data) throw new Error('Empty image response');
  return { data, mimeType: 'image/png' };
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
  const result = await googleRequest('gemini-2.5-flash-preview-tts', 'generateContent', payload, env);
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
      return jsonResponse({ error: status === 400 ? error.message : 'AI service unavailable', requestId }, status, origin, env);
    }
  }
};
