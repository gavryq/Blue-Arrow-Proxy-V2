const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MCP_SERVER = { type: 'url', url: 'https://mcp.flyra.io/mcp', name: 'flyra' };

async function callClaude(system, userMsg, apiKey) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'mcp-client-2025-04-04',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userMsg }],
      mcp_servers: [MCP_SERVER],
    }),
  });
  const data = await res.json();

  for (const block of (data.content || [])) {
    if (block.type === 'mcp_tool_result') {
      try {
        const txt = block.content?.[0]?.text || (typeof block.content === 'string' ? block.content : '');
        return JSON.parse(txt);
      } catch (e) {}
    }
  }

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (e) { return { _raw: text }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const { firstName, lastName, phone, address, lineItems, total, services, freq } = req.body || {};

  try {
    const phoneE164 = '+1' + phone.replace(/\D/g, '');
    const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const customerResult = await callClaude(
      'You are a Flyra API assistant. Call the requested Flyra tool with EXACTLY the parameters given. Return ONLY the raw JSON tool result with no extra text.',
      `Call flyra_create_customer with these exact parameters:
first_name: "${firstName}"
last_name: "${lastName}"
mobile_phone: "${phoneE164}"
address: "${address}"
if_exists: "return"`,
      apiKey
    );

    const customerId = customerResult?.id || customerResult?.customer_id;
    if (!customerId) {
      console.error('Customer creation failed:', JSON.stringify(customerResult));
      throw new Error('Could not create customer');
    }

    const lineItemsJson = JSON.stringify(lineItems);
    const estimateResult = await callClaude(
      'You are a Flyra API assistant. Call the requested Flyra tool with EXACTLY the parameters given. Return ONLY the raw JSON tool result with no extra text.',
      `Call flyra_create_estimate with these exact parameters:
customer_id: "${customerId}"
subject: "Window Cleaning Quote"
line_items: ${lineItemsJson}
notes: "Frequency: ${freq}. Address: ${address}. Quote submitted via website form."
valid_until: "${validUntil}"`,
      apiKey
    );

    const estimateId = estimateResult?.id || estimateResult?.estimate_id;
    if (!estimateId) {
      console.error('Estimate creation failed:', JSON.stringify(estimateResult));
      throw new Error('Could not create estimate');
    }

    const linkResult = await callClaude(
      'You are a Flyra API assistant. Call the requested Flyra tool with EXACTLY the parameters given. Return ONLY the raw JSON tool result with no extra text.',
      `Call flyra_get_estimate_link with estimate_id: "${estimateId}"`,
      apiKey
    );

    const estimateUrl = linkResult?.public_link || linkResult?.url || linkResult?.link || '';

    const totalDisplay = typeof total === 'number' ? `$${total}/visit` : total;
    const smsBody = `Hi ${firstName}! Thanks for reaching out to Blue Arrow Cleaning 🪟\n\nYour quote for ${services} is ready:\n💰 ${totalDisplay} (${freq})\n\nTap the link below to review your quote and book your appointment:\n${estimateUrl || 'Check your email for your estimate link.'}\n\nQuestions? Call us: (312) 835-6436`;

    await callClaude(
      'You are a Flyra API assistant. Call the requested Flyra tool with EXACTLY the parameters given. Return ONLY the raw JSON tool result with no extra text.',
      `Call flyra_send_sms with:
to_phone: "${phoneE164}"
body: ${JSON.stringify(smsBody)}`,
      apiKey
    );

    await callClaude(
      'You are a Flyra API assistant. Call the requested Flyra tool with EXACTLY the parameters given. Return ONLY the raw JSON tool result with no extra text.',
      `Call flyra_send_estimate with estimate_id: "${estimateId}"`,
      apiKey
    );

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
