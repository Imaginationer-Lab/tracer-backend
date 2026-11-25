const SHIPPING_BASE = process.env.SHIPPING_API_URL;

export async function getQuote(zip: string) {
  const res = await fetch(`${SHIPPING_BASE}/quotes?zip=${zip}`);
  if (!res.ok) throw new Error(`quote failed: ${res.status}`);
  return res.json();
}
