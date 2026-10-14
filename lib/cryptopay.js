// Клиент Crypto Pay API (@CryptoBot) — https://help.crypt.bot/crypto-pay-api
import crypto from 'node:crypto';

const BASES = {
  mainnet: 'https://pay.crypt.bot/api/',
  testnet: 'https://testnet-pay.crypt.bot/api/',
};

export function createCryptoPay(token, network = 'mainnet') {
  const base = BASES[network] || BASES.mainnet;

  async function call(method, params = {}) {
    if (!token) throw new Error('CRYPTO_PAY_TOKEN не задан в .env');
    const res = await fetch(base + method, {
      method: 'POST',
      headers: { 'Crypto-Pay-API-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      const name = data?.error?.name || `HTTP ${res.status}`;
      throw Object.assign(new Error(`CryptoPay ${method}: ${name}`), { code: data?.error?.code });
    }
    return data.result;
  }

  return {
    network,
    getMe: () => call('getMe'),
    getBalance: () => call('getBalance'),
    createInvoice: (params) => call('createInvoice', params),
    getInvoices: (params) => call('getInvoices', params),
    deleteInvoice: (invoiceId) => call('deleteInvoice', { invoice_id: invoiceId }),

    // Подпись вебхука: HMAC-SHA256(тело, ключ = SHA256(токен))
    verifyWebhook(rawBody, signature) {
      if (!token || !signature || !Buffer.isBuffer(rawBody)) return false;
      const secret = crypto.createHash('sha256').update(token).digest();
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(String(signature));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}
