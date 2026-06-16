const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

async function callFlyra(prompt, apiKey) {
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
      max_tokens: 2000,
      system: `You are a Flyra assistant for Blue Arrow Cleaning. 
Complete the requested Flyra actions exactly as described.
Return ONLY raw JSON with no markdown, no explanation.`,
      messages: [{ role: 'user', content: prompt }],
      mcp_servers: [{ type: 'url', url: 'https://mcp.flyra.io/mcp', name: 'flyra' }],
    }),
  });
  return res.json();
}

function extractToolResult(data) {
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
  try { return JSON.parse(clean); } catch (e) { return null; }
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
    // Step 1: Create or find customer
    const customerData = await callFlyra(
      `Search for an existing customer in Flyra with phone "${phone}".
If found, return their id. If not found, create a new customer with:
first_name: "${firstName}"
last_name: "${lastName}"  
mobile_phone: "${phone}"
address: "${address}"
Return ONLY: {"customer_id": "<id>"}`,
      apiKey
    );
    const parsed = extractToolResult(customerData);
    const customerId = parsed?.customer_id || parsed?.id;
    if (!customerId) throw new Error('Could not create customer');

    // Step 2: Create estimate with line items
    const lineItemsStr = JSON.stringify(lineItems);
    const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const estimateData = await callFlyra(
      `Create a Flyra estimate for customer_id "${customerId}" with:
subject: "Window Cleaning Quote – ${services}"
line_items: ${lineItemsStr}
notes: "Frequency: ${freq}. Address: ${address}. Quote submitted via website form."
valid_until: "${validUntil}"
Return ONLY: {"estimate_id": "<id>"}`,
      apiKey
    );
    const estParsed = extractToolResult(estimateData);
    const estimateId = estParsed?.estimate_id || estParsed?.id;
    if (!estimateId) throw new Error('Could not create estimate');

    // Step 3: Get estimate link
    const linkData = await callFlyra(
      `Call flyra_get_estimate_link for estimate_id "${estimateId}".
Return ONLY: {"url": "<link>"}`,
      apiKey
    );
    const linkParsed = extractToolResult(linkData);
    const estimateUrl = linkParsed?.url || linkParsed?.link || linkParsed?.estimate_url || linkParsed?.public_link;

    // Step 4: Send SMS to customer
    const phoneE164 = '+1' + phone.replace(/\D/g, '');
    const smsBody = `Hi ${firstName}! Thanks for reaching out to Blue Arrow Cleaning 🪟\n\nYour quote for ${services} is ready:\n💰 Total: $${total}/visit (${freq})\n\nTap below to review your quote and book your appointment:\n${estimateUrl || 'We\'ll follow up shortly with your estimate link.'}\n\nQuestions? Call us: (312) 835-6436`;

    await callFlyra(
      `Send an SMS using flyra_send_sms with:
to_phone: "${phoneE164}"
body: ${JSON.stringify(smsBody)}
Return ONLY: {"success": true}`,
      apiKey
    );

    // Step 5: Mark estimate as sent
    await callFlyra(
      `Call flyra_send_estimate with estimate_id "${estimateId}". Return ONLY: {"success": true}`,
      apiKey
    );

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
